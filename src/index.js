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
import { getRegisterConfig, getRegisterConfigFull, updateRegisterConfig, startRegisterTask, cancelRegisterTask, getRegisterTasks, getRegisterTaskDetail, clearCompletedTasks } from './register.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '50mb' }));

// 管理面板 — 静态前端（不需要认证即可加载页面，API 需要认证）
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
    version: '1.1.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// ========== 管理面板 API（使用独立 ADMIN_PASSWORD 认证）==========

// 检查管理面板是否需要密码
app.get('/admin/api/auth-required', (req, res) => {
  res.json({ required: isAdminAuthRequired() });
});

// 验证管理密码
app.post('/admin/api/auth/verify', (req, res) => {
  if (!isAdminAuthRequired()) {
    return res.json({ success: true });
  }
  const { password } = req.body;
  if (validateAdminPassword(password)) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: { message: 'Invalid admin password' } });
});


// 以下管理 API 都需要管理密码
app.use('/admin/api', adminAuthMiddleware);

app.get('/admin/api/stats', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.1.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    apiKeyCount: getApiKeys().length,
  });
});

// 令牌管理
app.post('/admin/api/token/add', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  try {
    const added = addTokenToPool(token);
    res.json({ success: true, email: added.email });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email and password required' } });
  }
  try {
    const entry = await loginAndAddToken(email, password);
    res.json({ success: true, email: entry.email });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/remove', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: { message: 'email required' } });
  try {
    const result = removeTokenFromPool(email);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/check', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: { message: 'email required' } });
  try {
    const result = await checkTokenHealth(email);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/check-all', async (req, res) => {
  try {
    const results = await checkAllTokensHealth();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// API Key 管理
app.get('/admin/api/keys', (req, res) => {
  res.json({ success: true, keys: getApiKeys() });
});

app.post('/admin/api/keys/add', (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: { message: 'key required' } });
  }
  try {
    const result = addApiKey(key);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/keys/remove', (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: { message: 'key required' } });
  }
  try {
    const result = removeApiKey(key);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// 注册机管理
app.get('/admin/api/register/config', (req, res) => {
  res.json({ success: true, config: getRegisterConfig() });
});

app.post('/admin/api/register/config', (req, res) => {
  const { mailApi, mailKey } = req.body;
  try {
    const config = updateRegisterConfig({ mailApi, mailKey });
    res.json({ success: true, config });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/register/start', (req, res) => {
  const { email, password, count, autoAddToken } = req.body;
  try {
    const result = startRegisterTask({ email, password, count: count || 1, autoAddToken: autoAddToken !== false });
    res.json({ success: true, tasks: result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/register/cancel', (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: { message: 'taskId required' } });
  try {
    const result = cancelRegisterTask(taskId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.get('/admin/api/register/tasks', (req, res) => {
  res.json({ success: true, tasks: getRegisterTasks() });
});

app.get('/admin/api/register/task/:id', (req, res) => {
  const detail = getRegisterTaskDetail(parseInt(req.params.id));
  if (!detail) return res.status(404).json({ error: { message: 'Task not found' } });
  res.json({ success: true, task: detail });
});

app.post('/admin/api/register/clear', (req, res) => {
  const result = clearCompletedTasks();
  res.json({ success: true, ...result });
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
