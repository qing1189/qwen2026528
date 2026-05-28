import { createHash, randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requestHeaders } from './headers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '..', '.env');

function persistTokensToEnv() {
  try {
    let content = readFileSync(ENV_PATH, 'utf-8');
    const aliveTokens = accountPool.filter(t => t.token).map(t => t.token);
    if (aliveTokens.length === 0) return;

    const line = `QWEN_TOKENS=${aliveTokens.join(',')}`;
    const lines = content.split(/\r?\n/);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('QWEN_TOKENS=')) {
        lines[i] = line;
        found = true;
        break;
      }
    }
    if (!found) lines.push(line);

    writeFileSync(ENV_PATH, lines.join('\n'));
  } catch (err) {
    console.warn('Failed to persist tokens to .env:', err.message);
  }
}

const BASE_URL = 'https://chat.qwen.ai';
const MAX_CONCURRENT_PER_TOKEN = 10;

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
        accountPool.push({ email, password, token: null, expiresAt: 0, errorCount: 0, activeRequests: 0 });
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
      });
    }
  }

  if (accountPool.length === 0) {
    throw new Error('No QWEN_ACCOUNTS or QWEN_TOKENS configured');
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
  let candidates = accountPool.filter(t => t.errorCount < 3 && t.activeRequests < MAX_CONCURRENT_PER_TOKEN && t.token);

  if (candidates.length === 0) {
    candidates = accountPool.filter(t => t.activeRequests < MAX_CONCURRENT_PER_TOKEN && t.token);
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.activeRequests - b.activeRequests);
  const chosen = candidates[0];
  chosen.activeRequests++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenError(token) {
  const entry = accountPool.find(t => t.token === token);
  if (entry) entry.errorCount++;
}

export function reportTokenSuccess(token) {
  const entry = accountPool.find(t => t.token === token);
  if (entry) entry.errorCount = 0;
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
  };
  accountPool.push(entry);
  persistTokensToEnv();
  return entry;
}

export function getPoolInfo() {
  return accountPool.map(t => ({
    email: t.email,
    hasToken: !!t.token,
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    maxConcurrent: MAX_CONCURRENT_PER_TOKEN,
  }));
}

export function getTotalCapacity() {
  return accountPool.filter(t => t.errorCount < 3 && t.token).length * MAX_CONCURRENT_PER_TOKEN;
}