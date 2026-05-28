/**
 * 注册机服务模块
 * 将 qwen-register.js 的功能封装为可从 Web 端控制的服务
 */

import { createHash } from 'crypto';
import { addTokenToPool } from './auth.js';

// ========== 配置 ==========
let mailApi = 'https://mail.chatgpt.org.uk';
let mailKey = process.env.MAIL_KEY || 'sk-j9g9LI2F7WJ5';

// 注册任务状态
const tasks = [];
let taskIdCounter = 0;

// ========== 配置管理 ==========

export function getRegisterConfig() {
  return { mailApi, mailKey: mailKey ? mailKey.slice(0, 6) + '...' + mailKey.slice(-4) : '' };
}

export function getRegisterConfigFull() {
  return { mailApi, mailKey };
}

export function updateRegisterConfig({ mailApi: newApi, mailKey: newKey }) {
  if (newApi) mailApi = newApi.trim();
  if (newKey) mailKey = newKey.trim();
  return { mailApi, mailKey: mailKey.slice(0, 6) + '...' + mailKey.slice(-4) };
}

// ========== HTTP 工具 ==========

async function httpReq(url, options = {}) {
  const headers = { 'X-API-Key': mailKey, ...(options.headers || {}) };
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body || undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

// ========== 邮箱操作 ==========

async function generateTempEmail() {
  const res = await httpReq(`${mailApi}/api/generate-email`);
  return res.data;
}

async function getEmails(email) {
  const enc = encodeURIComponent(email);
  const res = await httpReq(`${mailApi}/api/emails?email=${enc}`);
  return res.data;
}

async function getEmailById(id) {
  const res = await httpReq(`${mailApi}/api/email/${id}`);
  return res.data;
}

async function waitForVerificationEmail(email, task, maxWait = 120000) {
  const start = Date.now();
  const seenIds = new Set();

  try {
    const existing = await getEmails(email);
    if (Array.isArray(existing)) existing.forEach(e => seenIds.add(e.id));
  } catch {}

  task.logs.push('[MAIL] 等待验证邮件...');

  while (Date.now() - start < maxWait) {
    if (task.status === 'cancelled') throw new Error('任务已取消');

    try {
      const emails = await getEmails(email);
      if (Array.isArray(emails)) {
        for (const e of emails) {
          if (seenIds.has(e.id)) continue;
          seenIds.add(e.id);

          const subject = e.subject || e.Subject || '';
          if (
            subject.toLowerCase().includes('verify') ||
            subject.toLowerCase().includes('验证') ||
            subject.toLowerCase().includes('confirm') ||
            subject.toLowerCase().includes('activation') ||
            subject.toLowerCase().includes('注册')
          ) {
            task.logs.push(`[MAIL] 收到验证邮件: ${subject}`);
            const full = await getEmailById(e.id);
            const body = full?.body || full?.Body || full?.text || full?.Text || full?.html || full?.Html || '';
            const htmlBody = full?.html || full?.Html || body;

            const linkMatch = htmlBody.match(/href=["'](https?:\/\/[^"']*(?:verify|confirm|activate|token)[^"']*)/i);
            if (linkMatch) {
              task.logs.push(`[MAIL] 验证链接: ${linkMatch[1]}`);
              return { type: 'link', value: linkMatch[1] };
            }

            const codeMatch = body.match(/\b(\d{4,8})\b/);
            if (codeMatch) {
              task.logs.push(`[MAIL] 验证码: ${codeMatch[1]}`);
              return { type: 'code', value: codeMatch[1] };
            }

            return { type: 'raw', value: body };
          }
        }
      }
    } catch (err) {
      task.logs.push(`[MAIL] 轮询错误: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('等待验证邮件超时');
}

// ========== 注册逻辑 ==========

function sha256(str) {
  return createHash('sha256').update(str, 'utf-8').digest('hex');
}

function generatePassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#';
  let pw = '';
  for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

async function tryApiSignup(email, password, task) {
  const sha256pw = sha256(password);
  task.logs.push(`[API] 尝试直接 API 注册: ${email}`);

  try {
    const res = await httpReq('https://chat.qwen.ai/api/v1/auths/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: sha256pw }),
    });

    if (typeof res.data === 'object' && res.data.token) {
      task.logs.push('[API] 直接注册成功！获取到令牌');
      return res.data.token;
    }

    task.logs.push(`[API] 注册响应: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    return null;
  } catch (err) {
    task.logs.push(`[API] 注册请求失败: ${err.message}`);
    return null;
  }
}

async function tryApiLogin(email, password, task) {
  const sha256pw = sha256(password);
  task.logs.push(`[API] 尝试 API 登录: ${email}`);

  try {
    const res = await httpReq('https://chat.qwen.ai/api/v1/auths/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: sha256pw }),
    });

    if (typeof res.data === 'object' && res.data.token) {
      task.logs.push('[API] 登录成功！获取到 JWT 令牌');
      return res.data.token;
    }

    task.logs.push(`[API] 登录响应: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    return null;
  } catch (err) {
    task.logs.push(`[API] 登录请求失败: ${err.message}`);
    return null;
  }
}

async function verifyEmailLink(link, task) {
  task.logs.push('[VERIFY] 访问验证链接...');
  try {
    const res = await fetch(link, { redirect: 'follow' });
    task.logs.push(`[VERIFY] 响应状态: ${res.status}`);
    return true;
  } catch (err) {
    task.logs.push(`[VERIFY] 错误: ${err.message}`);
    return false;
  }
}

// ========== 注册任务执行 ==========

async function executeRegisterTask(task) {
  try {
    task.status = 'running';
    task.logs.push(`[START] 开始注册任务 #${task.id}`);
    task.logs.push(`[CONFIG] Mail API: ${mailApi}`);

    // Step 1: 生成或使用提供的邮箱
    let email, password;
    if (task.email && task.password) {
      email = task.email;
      password = task.password;
      task.logs.push(`[INIT] 使用提供的凭据: ${email}`);
    } else {
      task.logs.push('[INIT] 通过 GPTMail 生成临时邮箱...');
      const mailResult = await generateTempEmail();
      if (mailResult && mailResult.email) {
        email = mailResult.email;
      } else if (mailResult && mailResult.data && mailResult.data.email) {
        email = mailResult.data.email;
      } else {
        const emailStr = typeof mailResult === 'string' ? mailResult : JSON.stringify(mailResult);
        const emailMatch = emailStr.match(/[\w.-]+@[\w.-]+\.\w+/);
        if (emailMatch) {
          email = emailMatch[0];
        } else {
          throw new Error(`生成临时邮箱失败: ${emailStr}`);
        }
      }
      password = generatePassword();
      task.logs.push(`[INIT] 邮箱: ${email}`);
      task.logs.push(`[INIT] 密码: ${password}`);
    }

    task.email = email;
    task.password = password;

    if (task.status === 'cancelled') return;

    // Step 2: 尝试直接 API 注册
    const apiToken = await tryApiSignup(email, password, task);
    if (apiToken) {
      task.token = apiToken;
      task.method = 'api_direct';
      task.status = 'success';
      task.logs.push('[DONE] 注册成功（API 直接注册）');
      // 自动添加到令牌池
      if (task.autoAddToken) {
        addTokenToPool(apiToken);
        task.logs.push('[POOL] 令牌已自动添加到令牌池');
      }
      return;
    }

    if (task.status === 'cancelled') return;

    // Step 3: 等待验证邮件（API 注册可能发了验证邮件）
    task.logs.push('[VERIFY] 等待验证邮件...');
    try {
      const verifyResult = await waitForVerificationEmail(email, task, 90000);

      if (verifyResult.type === 'link') {
        await verifyEmailLink(verifyResult.value, task);
      } else if (verifyResult.type === 'code') {
        task.logs.push(`[VERIFY] 获取到验证码: ${verifyResult.value}（需手动验证）`);
      }

      if (task.status === 'cancelled') return;

      // Step 4: 验证后尝试登录
      await new Promise(r => setTimeout(r, 3000));
      const loginToken = await tryApiLogin(email, password, task);
      if (loginToken) {
        task.token = loginToken;
        task.method = 'signup+verify+login';
        task.status = 'success';
        task.logs.push('[DONE] 注册成功（注册+验证+登录）');
        if (task.autoAddToken) {
          addTokenToPool(loginToken);
          task.logs.push('[POOL] 令牌已自动添加到令牌池');
        }
        return;
      }
    } catch (err) {
      task.logs.push(`[VERIFY] 验证流程失败: ${err.message}`);
    }

    if (task.status === 'cancelled') return;

    // Step 5: 最后尝试直接登录
    task.logs.push('[FINAL] 尝试直接登录...');
    const finalToken = await tryApiLogin(email, password, task);
    if (finalToken) {
      task.token = finalToken;
      task.method = 'fallback_login';
      task.status = 'success';
      task.logs.push('[DONE] 注册成功（回退登录）');
      if (task.autoAddToken) {
        addTokenToPool(finalToken);
        task.logs.push('[POOL] 令牌已自动添加到令牌池');
      }
      return;
    }

    task.status = 'failed';
    task.logs.push('[DONE] 注册失败');
  } catch (err) {
    if (task.status !== 'cancelled') {
      task.status = 'failed';
      task.error = err.message;
      task.logs.push(`[ERROR] ${err.message}`);
    }
  }
}

// ========== 公开 API ==========

export function startRegisterTask({ email, password, count = 1, autoAddToken = true } = {}) {
  const newTasks = [];

  for (let i = 0; i < count; i++) {
    const task = {
      id: ++taskIdCounter,
      email: email || null,
      password: password || null,
      token: null,
      method: null,
      status: 'pending',
      error: null,
      autoAddToken,
      logs: [],
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    newTasks.push(task);

    // 立即启动（异步）
    task.status = 'running';
    executeRegisterTask(task);
  }

  return newTasks.map(t => ({ id: t.id, status: t.status }));
}

export function cancelRegisterTask(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running' || task.status === 'pending') {
    task.status = 'cancelled';
    task.logs.push('[CANCEL] 任务已取消');
    return { success: true };
  }
  throw new Error(`任务状态为 ${task.status}，无法取消`);
}

export function getRegisterTasks() {
  return tasks.map(t => ({
    id: t.id,
    email: t.email,
    status: t.status,
    method: t.method,
    error: t.error,
    createdAt: t.createdAt,
    logCount: t.logs.length,
  }));
}

export function getRegisterTaskDetail(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return null;
  return {
    id: task.id,
    email: task.email,
    password: task.password,
    token: task.token,
    method: task.method,
    status: task.status,
    error: task.error,
    autoAddToken: task.autoAddToken,
    createdAt: task.createdAt,
    logs: task.logs,
  };
}

export function clearCompletedTasks() {
  const before = tasks.length;
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (['success', 'failed', 'cancelled'].includes(tasks[i].status)) {
      tasks.splice(i, 1);
    }
  }
  return { removed: before - tasks.length, remaining: tasks.length };
}
