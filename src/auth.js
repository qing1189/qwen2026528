import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requestHeaders } from './headers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const ENV_PATH = resolve(__dirname, '..', '.env');

// ========== .env 持久化工具 ==========

function updateEnvLine(key, value) {
  try {
    let content = '';
    if (existsSync(ENV_PATH)) {
      content = readFileSync(ENV_PATH, 'utf-8');
    }
    const line = `${key}=${value}`;
    const lines = content.split(/\r?\n/);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`${key}=`)) {
        lines[i] = line;
        found = true;
        break;
      }
    }
    if (!found) lines.push(line);
    writeFileSync(ENV_PATH, lines.join('\n'));
  } catch (err) {
    console.warn(`Failed to persist ${key} to .env:`, err.message);
  }
}

function persistTokensToEnv() {
  const aliveTokens = accountPool.filter(t => t.token).map(t => t.token);
  if (aliveTokens.length === 0) return;
  updateEnvLine('QWEN_TOKENS', aliveTokens.join(','));
}

function persistApiKeysToEnv() {
  updateEnvLine('API_KEYS', apiKeys.join(','));
}

// ========== 多 API Key 管理 ==========

let apiKeys = [];

export function loadApiKeys() {
  // 兼容旧的单 API_KEY 和新的多 API_KEYS
  const singleKey = process.env.API_KEY?.trim();
  const multiKeys = process.env.API_KEYS?.trim();

  const keySet = new Set();
  if (multiKeys) {
    for (const k of multiKeys.split(',').map(s => s.trim()).filter(Boolean)) {
      keySet.add(k);
    }
  }
  if (singleKey) {
    keySet.add(singleKey);
  }
  apiKeys = [...keySet];
  console.log(`API Keys loaded: ${apiKeys.length} key(s)`);
  return apiKeys;
}

export function validateApiKey(key) {
  // 如果没有配置任何 key，则不需要验证
  if (apiKeys.length === 0) return true;
  return apiKeys.includes(key);
}

export function getApiKeys() {
  // 返回脱敏的 key 列表（只显示前8位和后4位）
  return apiKeys.map((k, i) => ({
    id: i,
    key: k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '***',
    full: k,
  }));
}

export function addApiKey(key) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API Key cannot be empty');
  if (apiKeys.includes(trimmed)) throw new Error('API Key already exists');
  apiKeys.push(trimmed);
  persistApiKeysToEnv();
  return { success: true, total: apiKeys.length };
}

export function removeApiKey(key) {
  const idx = apiKeys.indexOf(key.trim());
  if (idx === -1) throw new Error('API Key not found');
  apiKeys.splice(idx, 1);
  persistApiKeysToEnv();
  return { success: true, total: apiKeys.length };
}

export function isApiKeyRequired() {
  return apiKeys.length > 0;
}

const BASE_URL = 'https://chat.qwen.ai';
const MAX_CONCURRENT_PER_TOKEN = 10;

// ========== 智能权重轮询配置 ==========
const WEIGHT_MAX = 100;           // 最大权重
const WEIGHT_INITIAL = 100;       // 初始权重
const WEIGHT_SUCCESS_BONUS = 5;   // 成功加分
const WEIGHT_FAIL_MINOR = -15;    // 轻微错误（超时/限流）扣分
const WEIGHT_FAIL_MAJOR = -30;    // 严重错误（认证失败）扣分
const WEIGHT_COOLDOWN_THRESHOLD = 20;  // 权重低于此值进入冷却
const COOLDOWN_DURATION_MS = 60000;    // 冷却时间 60 秒
const WEIGHT_AFTER_COOLDOWN = 50;      // 冷却恢复后权重
const MIN_REQUEST_INTERVAL_MS = 500;   // 同令牌最小请求间隔

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return null; }
}

function isTokenExpired(token) {
  const decoded = decodeJWT(token);
  if (!decoded?.exp) return true;
  return decoded.exp * 1000 < Date.now() + 5 * 60 * 1000; // 5 min buffer
}

// Account entry: { email, password, token, expiresAt, errorCount, activeRequests }
const accountPool = [];

export function loadAccounts() {
  const accountsStr = process.env.QWEN_ACCOUNTS?.trim();
  const tokensStr = process.env.QWEN_TOKENS?.trim();

  if (accountsStr) {
    for (const entry of accountsStr.split(',')) {
      const [email, ...passParts] = entry.trim().split(':');
      const password = passParts.join(':');
      if (email && password) {
        accountPool.push({ email, password, token: null, expiresAt: 0, errorCount: 0, activeRequests: 0, weight: WEIGHT_INITIAL, cooldownUntil: 0, lastRequestAt: 0 });
      }
    }
  }

  if (tokensStr) {
    for (const token of tokensStr.split(',').map(t => t.trim()).filter(Boolean)) {
      const decoded = decodeJWT(token);
      accountPool.push({
        email: decoded?.id || 'token-user',
        password: null,
        token,
        expiresAt: (decoded?.exp || 0) * 1000,
        errorCount: 0,
        activeRequests: 0,
        weight: WEIGHT_INITIAL,
        cooldownUntil: 0,
        lastRequestAt: 0,
      });
    }
  }

  if (accountPool.length === 0) {
    console.log('  No QWEN_ACCOUNTS or QWEN_TOKENS configured. Add tokens via admin panel.');
  }

  return accountPool;
}

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/api/v1/auths/signin`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({ email, password: sha256(password) }),
  });
  const json = await res.json();
  if (!json.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(json)}`);
  return json.token;
}

async function ensureToken(entry) {
  if (entry.token && !isTokenExpired(entry.token)) return entry.token;

  if (!entry.password) {
    entry.errorCount++;
    throw new Error(`Token expired for ${entry.email}, no password to refresh`);
  }

  try {
    entry.token = await login(entry.email, entry.password);
    const decoded = decodeJWT(entry.token);
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    console.log(`  Logged in: ${entry.email}, token expires ${new Date(entry.expiresAt).toISOString()}`);
    return entry.token;
  } catch (err) {
    entry.errorCount++;
    throw err;
  }
}

export async function initAccountPool() {
  console.log(`Account pool: ${accountPool.length} account(s), max ${MAX_CONCURRENT_PER_TOKEN} concurrent each`);
  for (const entry of accountPool) {
    try {
      await ensureToken(entry);
    } catch (err) {
      console.warn(`  Failed to init ${entry.email}: ${err.message}`);
    }
  }
}

export function acquireToken() {
  const now = Date.now();

  // 过滤可用候选：有令牌、未满并发、不在冷却中
  let candidates = accountPool.filter(t =>
    t.token &&
    t.activeRequests < MAX_CONCURRENT_PER_TOKEN &&
    now >= t.cooldownUntil &&
    (now - t.lastRequestAt) >= MIN_REQUEST_INTERVAL_MS
  );

  // 如果没有满足间隔要求的，放宽间隔限制
  if (candidates.length === 0) {
    candidates = accountPool.filter(t =>
      t.token &&
      t.activeRequests < MAX_CONCURRENT_PER_TOKEN &&
      now >= t.cooldownUntil
    );
  }

  // 仍然没有，尝试包含刚从冷却中恢复的
  if (candidates.length === 0) {
    // 检查是否有令牌冷却已到期，恢复权重
    for (const t of accountPool) {
      if (t.token && t.cooldownUntil > 0 && now >= t.cooldownUntil) {
        t.weight = WEIGHT_AFTER_COOLDOWN;
        t.cooldownUntil = 0;
        t.errorCount = 0;
        console.log(`  [POOL] ${t.email} 冷却结束，权重恢复到 ${WEIGHT_AFTER_COOLDOWN}`);
      }
    }
    candidates = accountPool.filter(t =>
      t.token && t.activeRequests < MAX_CONCURRENT_PER_TOKEN && now >= t.cooldownUntil
    );
  }

  if (candidates.length === 0) return null;

  // 加权随机选择
  const chosen = weightedRandomSelect(candidates);
  chosen.activeRequests++;
  chosen.lastRequestAt = now;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

/**
 * 加权随机选择 — 权重越高被选中概率越大
 */
function weightedRandomSelect(candidates) {
  const totalWeight = candidates.reduce((sum, t) => sum + Math.max(t.weight, 1), 0);
  let rand = Math.random() * totalWeight;
  for (const t of candidates) {
    rand -= Math.max(t.weight, 1);
    if (rand <= 0) return t;
  }
  return candidates[candidates.length - 1];
}

/**
 * 报告令牌错误 — 区分错误严重程度
 * @param {string} token
 * @param {'minor'|'major'} severity - minor: 超时/限流, major: 认证失败/封禁
 */
export function reportTokenError(token, severity = 'minor') {
  const entry = accountPool.find(t => t.token === token);
  if (!entry) return;

  entry.errorCount++;
  const penalty = severity === 'major' ? WEIGHT_FAIL_MAJOR : WEIGHT_FAIL_MINOR;
  entry.weight = Math.max(0, entry.weight + penalty);

  // 检查是否需要进入冷却
  if (entry.weight <= WEIGHT_COOLDOWN_THRESHOLD) {
    entry.cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
    console.log(`  [POOL] ${entry.email} 权重过低 (${entry.weight})，进入冷却 ${COOLDOWN_DURATION_MS / 1000}s`);
  }
}

export function reportTokenSuccess(token) {
  const entry = accountPool.find(t => t.token === token);
  if (!entry) return;

  entry.errorCount = 0;
  entry.weight = Math.min(WEIGHT_MAX, entry.weight + WEIGHT_SUCCESS_BONUS);
}

export async function refreshToken(entry) {
  return ensureToken(entry);
}

export function addTokenToPool(tokenStr) {
  const token = tokenStr.trim();
  const existing = accountPool.find(t => t.token === token);
  if (existing) return existing;
  const decoded = decodeJWT(token);
  const entry = {
    email: decoded?.id || 'token-user',
    password: null,
    token,
    expiresAt: (decoded?.exp || 0) * 1000,
    errorCount: 0,
    activeRequests: 0,
    weight: WEIGHT_INITIAL,
    cooldownUntil: 0,
    lastRequestAt: 0,
  };
  accountPool.push(entry);
  persistTokensToEnv();
  return entry;
}

export async function loginAndAddToken(email, password) {
  const token = await login(email, password);
  const existing = accountPool.find(t => t.email === email);
  if (existing) {
    existing.token = token;
    const decoded = decodeJWT(token);
    existing.expiresAt = (decoded?.exp || 0) * 1000;
    existing.errorCount = 0;
    existing.weight = WEIGHT_INITIAL;
    existing.cooldownUntil = 0;
    persistTokensToEnv();
    return existing;
  }
  const decoded = decodeJWT(token);
  const entry = {
    email,
    password,
    token,
    expiresAt: (decoded?.exp || 0) * 1000,
    errorCount: 0,
    activeRequests: 0,
    weight: WEIGHT_INITIAL,
    cooldownUntil: 0,
    lastRequestAt: 0,
  };
  accountPool.push(entry);
  persistTokensToEnv();
  return entry;
}

export function removeTokenFromPool(email) {
  const idx = accountPool.findIndex(t => t.email === email);
  if (idx === -1) throw new Error('令牌不存在');
  if (accountPool[idx].activeRequests > 0) throw new Error('令牌正在使用中，请稍后再删除');
  accountPool.splice(idx, 1);
  persistTokensToEnv();
  return { success: true, remaining: accountPool.length };
}

export async function checkTokenHealth(email) {
  const entry = accountPool.find(t => t.email === email);
  if (!entry) throw new Error('令牌不存在');

  const result = { email: entry.email, expired: false, valid: false, error: null };

  // 检查是否过期
  if (!entry.token) {
    result.error = '无令牌';
    return result;
  }

  if (isTokenExpired(entry.token)) {
    result.expired = true;
    // 尝试刷新
    if (entry.password) {
      try {
        await ensureToken(entry);
        result.valid = true;
        result.expired = false;
        result.error = '令牌已刷新';
      } catch (err) {
        result.error = `刷新失败: ${err.message}`;
      }
    } else {
      result.error = '令牌已过期，无密码可刷新';
    }
    return result;
  }

  // 用令牌请求模型列表验证有效性
  try {
    const res = await fetch(`${BASE_URL}/api/models`, {
      headers: {
        'authorization': `Bearer ${entry.token}`,
        ...requestHeaders(),
      },
    });
    if (res.ok) {
      result.valid = true;
      entry.errorCount = 0;
    } else {
      const text = await res.text();
      if (text.includes('aliyun_waf') || text.includes('<!doctype')) {
        result.error = 'WAF 拦截（但令牌可能有效）';
        result.valid = true; // WAF 拦截不代表令牌无效
      } else {
        result.error = `API 返回 ${res.status}`;
        entry.errorCount++;
      }
    }
  } catch (err) {
    result.error = `请求失败: ${err.message}`;
  }

  return result;
}

export async function checkAllTokensHealth() {
  const results = [];
  for (const entry of accountPool) {
    try {
      const r = await checkTokenHealth(entry.email);
      results.push(r);
    } catch (err) {
      results.push({ email: entry.email, valid: false, error: err.message });
    }
  }
  return results;
}

export function getPoolInfo() {
  const now = Date.now();
  return accountPool.map((t, idx) => ({
    id: idx,
    email: t.email,
    hasToken: !!t.token,
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    maxConcurrent: MAX_CONCURRENT_PER_TOKEN,
    weight: t.weight,
    cooling: t.cooldownUntil > now,
    cooldownRemaining: t.cooldownUntil > now ? Math.ceil((t.cooldownUntil - now) / 1000) : 0,
  }));
}

export function getTotalCapacity() {
  return accountPool.filter(t => t.errorCount < 3 && t.token).length * MAX_CONCURRENT_PER_TOKEN;
}