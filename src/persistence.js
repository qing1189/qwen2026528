/**
 * 数据持久化模块
 * 使用 JSON 文件存储所有动态数据（tokens、accounts、API keys）
 * 文件路径: data/store.json（Docker 中通过 bind mount 映射到宿主机）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const STORE_PATH = resolve(DATA_DIR, 'store.json');

// 确保 data 目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 读取持久化数据
 */
export function loadStore() {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[PERSIST] Failed to load store.json:', err.message);
  }
  return { tokens: [], accounts: [], apiKeys: [] };
}

/**
 * 写入持久化数据
 */
export function saveStore(data) {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[PERSIST] Failed to save store.json:', err.message);
  }
}

/**
 * 保存令牌列表
 */
export function persistPool(pool) {
  const store = loadStore();
  store.tokens = pool.filter(t => t.token && !t.password).map(t => t.token);
  store.accounts = pool.filter(t => t.password).map(t => ({
    email: t.email,
    password: t.password,
  }));
  saveStore(store);
}

/**
 * 保存 API Keys
 */
export function persistApiKeys(keys) {
  const store = loadStore();
  store.apiKeys = [...keys];
  saveStore(store);
}

/**
 * 加载已持久化的令牌
 */
export function loadPersistedTokens() {
  const store = loadStore();
  return store.tokens || [];
}

/**
 * 加载已持久化的账号
 */
export function loadPersistedAccounts() {
  const store = loadStore();
  return store.accounts || [];
}

/**
 * 加载已持久化的 API Keys
 */
export function loadPersistedApiKeys() {
  const store = loadStore();
  return store.apiKeys || [];
}
