import { config } from 'dotenv';
config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadAccounts, initAccountPool, getPoolInfo, getTotalCapacity, acquireToken, addTokenToPool, loginAndAddToken, removeTokenFromPool, checkTokenHealth, checkAllTokensHealth, loadApiKeys, validateApiKey, getApiKeys, addApiKey, removeApiKey, isApiKeyRequired } from './auth.js';
import { adminAuthMiddleware, isAdminAuthRequired, validateAdminPassword } from './admin-auth.js';
import { handleOpenAICompletion } from './openai.js';
import { getModels, handleOpenAIModels } from './models.js';
import { getQueueInfo } from './queue.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '50mb' }));

// 管理面板 — 静态前端
app.use('/admin', express.static(join(__dirname, '..', 'frontend'), { extensions: ['html'] }));

// ========== API Key 认证中间件（用于 /v1/* 接口）==========
app.use('/v1', (req, res, next) => {
  if (!isApiKeyRequired()) return next();
  const auth = req.headers['authorization'] || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (validateApiKey(key)) return next();
  res.status(401).json({ error: { message: 'Invalid API key' } });
});

// ========== OpenAI 兼容接口 ==========
app.post('/v1/chat/completions', handleOpenAICompletion);

app.get('/v1/models', async (req, res) => {
  const slot = acquireToken();
  if (!slot) return res.status(503).json({ error: { message: 'No available token' } });
  try {
    const modelList = await getModels(slot.token);
    res.json(handleOpenAIModels(modelList));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  } finally {
    slot.release();
  }
});

// ========== 公开接口 ==========
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.2.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// ========== 管理面板 API ==========
app.get('/admin/api/auth-required', (req, res) => {
  res.json({ required: isAdminAuthRequired() });
});

app.post('/admin/api/auth/verify', (req, res) => {
  if (!isAdminAuthRequired()) return res.json({ success: true });
  const { password } = req.body;
  if (validateAdminPassword(password)) return res.json({ success: true });
  res.status(401).json({ error: { message: 'Invalid admin password' } });
});

app.use('/admin/api', adminAuthMiddleware);

app.get('/admin/api/stats', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.2.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    apiKeyCount: getApiKeys().length,
  });
});

// 令牌管理
app.post('/admin/api/token/add', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: { message: 'token required' } });
  try { res.json({ success: true, email: addTokenToPool(token).email }); }
  catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

app.post('/admin/api/token/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: { message: 'email and password required' } });
  try { res.json({ success: true, email: (await loginAndAddToken(email, password)).email }); }
  catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

app.post('/admin/api/token/remove', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: { message: 'email required' } });
  try { res.json(removeTokenFromPool(email)); }
  catch (err) { res.status(400).json({ error: { message: err.message } }); }
});

app.post('/admin/api/token/check', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: { message: 'email required' } });
  try { res.json({ success: true, result: await checkTokenHealth(email) }); }
  catch (err) { res.status(400).json({ error: { message: err.message } }); }
});

app.post('/admin/api/token/check-all', async (req, res) => {
  try { res.json({ success: true, results: await checkAllTokensHealth() }); }
  catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

// API Key 管理
app.get('/admin/api/keys', (req, res) => {
  res.json({ success: true, keys: getApiKeys() });
});

app.post('/admin/api/keys/add', (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: { message: 'key required' } });
  try { res.json(addApiKey(key)); }
  catch (err) { res.status(400).json({ error: { message: err.message } }); }
});

app.post('/admin/api/keys/remove', (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: { message: 'key required' } });
  try { res.json(removeApiKey(key)); }
  catch (err) { res.status(400).json({ error: { message: err.message } }); }
});

// ========== 启动 ==========
app.listen(PORT, async () => {
  console.log(`Qwen 2API running on http://localhost:${PORT}`);
  console.log(`管理面板:      http://localhost:${PORT}/admin`);
  console.log(`OpenAI format:  POST /v1/chat/completions`);
  console.log(`Models:         GET /v1/models`);
  loadApiKeys();
  loadAccounts();
  await initAccountPool();
});
