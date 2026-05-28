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
      return { token: res.data.token, waf: false };
    }

    // 检测 WAF 拦截
    const dataStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (dataStr.includes('aliyun_waf') || dataStr.includes('waf_aa') || dataStr.includes('<!doctype')) {
      task.logs.push('[API] 被阿里云 WAF 拦截，直接 API 注册不可用');
      return { token: null, waf: true };
    }

    task.logs.push(`[API] 注册响应: ${res.status} ${dataStr.slice(0, 200)}`);
    return { token: null, waf: false };
  } catch (err) {
    task.logs.push(`[API] 注册请求失败: ${err.message}`);
    return { token: null, waf: false };
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

// ========== Playwright 浏览器注册 ==========

async function runBrowserSignup(email, password, task) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch (err) {
    task.logs.push(`[BROWSER] Playwright 未安装或导入失败: ${err.message}`);
    task.logs.push('[BROWSER] 请确保已安装 playwright 依赖');
    return 'error';
  }

  task.logs.push('[BROWSER] 启动 Chromium 无头浏览器...');

  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  } catch (err) {
    task.logs.push(`[BROWSER] 浏览器启动失败: ${err.message}`);
    task.logs.push('[TIP] Docker 环境需确保安装了 Chromium 及其依赖');
    return 'error';
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  let result = 'unknown';

  try {
    // 导航到 Qwen
    task.logs.push('[BROWSER] 导航到 chat.qwen.ai...');
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'networkidle', timeout: 30000 });

    // 查找并点击注册按钮
    task.logs.push('[BROWSER] 查找注册按钮...');
    const signupBtn = page.locator('button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("注册"), a:has-text("注册")').first();
    if (await signupBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      task.logs.push('[BROWSER] 点击注册按钮...');
      await signupBtn.click();
      await page.waitForTimeout(3000);
    } else {
      task.logs.push('[BROWSER] 未找到注册按钮，尝试直接 URL...');
      await page.goto('https://chat.qwen.ai/auth/signup', { waitUntil: 'networkidle', timeout: 30000 });
    }

    // 检测滑块验证码
    task.logs.push('[BROWSER] 检测 WAF 滑块验证码...');
    const captchaFrame = page.frameLocator('iframe[id*="aliyun"], iframe[src*="aliyun"], iframe[title*="验证"]');
    const captchaVisible = await captchaFrame.locator('#nc_1_n1z, .nc_iconfont, .btn_slide').isVisible().catch(() => false);

    if (captchaVisible) {
      task.logs.push('[BROWSER] 检测到阿里云滑块验证码，尝试滑动...');
      const slider = captchaFrame.locator('#nc_1_n1z, .btn_slide, .nc_iconfont.btn_slide').first();
      const sliderBox = await slider.boundingBox().catch(() => null);
      if (sliderBox) {
        const startX = sliderBox.x + sliderBox.width / 2;
        const startY = sliderBox.y + sliderBox.height / 2;
        const endX = startX + 280;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
          const progress = i / steps;
          const x = startX + (endX - startX) * progress;
          const y = startY + Math.sin(progress * Math.PI) * 3;
          await page.mouse.move(x, y, { steps: 1 });
          await page.waitForTimeout(30 + Math.random() * 40);
        }
        await page.mouse.up();
        await page.waitForTimeout(2000);
        task.logs.push('[BROWSER] 滑块拖动完成');
      } else {
        task.logs.push('[BROWSER] 未能定位滑块位置');
      }
    } else {
      task.logs.push('[BROWSER] 无 WAF 滑块验证码');
    }

    // 填写注册表单
    task.logs.push('[BROWSER] 查找注册表单字段...');
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail"], input[placeholder*="邮箱"]').first();
    const pwInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="assword"], input[placeholder*="密码"]').first();

    const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    const pwVisible = await pwInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (emailVisible && pwVisible) {
      task.logs.push('[BROWSER] 填写表单（4字段: 名称+邮箱+密码+确认密码）...');

      // Qwen 注册需要 4 个字段：名称、邮箱、密码、确认密码
      const username = email.split('@')[0] + Math.floor(Math.random() * 100);

      // 使用 React nativeInputValueSetter 方式注入所有字段值
      const fillResult = await page.evaluate(({ username, email, password }) => {
        function setReactInputValue(input, value) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const allInputs = Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null);

        // 找名称字段（type=text 且非 hidden）
        const nameEl = allInputs.find(el =>
          el.type === 'text' &&
          (el.placeholder?.match(/name|名称|昵称|用户名/i) || el.name?.match(/name|nickname/i))
        ) || allInputs.find(el => el.type === 'text');

        // 找邮箱字段
        const emailEl = allInputs.find(el =>
          el.type === 'email' || el.placeholder?.match(/mail|邮箱/i) || el.name?.match(/email/i)
        );

        // 找密码字段（第一个是密码，第二个是确认密码）
        const pwInputs = allInputs.filter(el => el.type === 'password');
        const pwEl = pwInputs[0];
        const pw2El = pwInputs[1];

        if (nameEl) { nameEl.focus(); setReactInputValue(nameEl, username); }
        if (emailEl) { emailEl.focus(); setReactInputValue(emailEl, email); }
        if (pwEl) { pwEl.focus(); setReactInputValue(pwEl, password); }
        if (pw2El) { pw2El.focus(); setReactInputValue(pw2El, password); }

        return {
          name: !!nameEl, email: !!emailEl, pw: !!pwEl, pw2: !!pw2El,
          totalInputs: allInputs.length
        };
      }, { username, email, password });
      await page.waitForTimeout(800);

      task.logs.push(`[BROWSER] 字段检测: name=${fillResult.name}, email=${fillResult.email}, pw=${fillResult.pw}, pw2=${fillResult.pw2}, 总input数=${fillResult.totalInputs}`);

      // 补充键盘输入触发额外事件（逐个可见 input 确认）
      const allVisibleInputs = await page.locator('input:visible').all();
      for (const input of allVisibleInputs) {
        await input.click().catch(() => {});
        await page.keyboard.press('End');
        await page.keyboard.type(' ', { delay: 30 });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(500);

      task.logs.push(`[BROWSER] 表单已填写: 名称=${username}, 邮箱=${email}, 密码+确认密码`);

      // 勾选条款复选框（JS 方式）
      task.logs.push('[BROWSER] 查找并勾选条款复选框...');
      const checkboxClicked = await page.evaluate(() => {
        const selectors = ['input[type="checkbox"]', '.qwen-chat-checkbox', '[class*="checkbox"]', '[class*="agree"]', '[class*="Checkbox"]'];
        let clicked = 0;
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            if (el.offsetParent !== null) {
              el.click();
              clicked++;
              if (el.tagName === 'INPUT' && el.type === 'checkbox') {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          });
        }
        return clicked;
      });
      task.logs.push(`[BROWSER] 勾选了 ${checkboxClicked} 个复选框`);
      await page.waitForTimeout(1000);

      // 点击提交按钮
      const submitBtn = page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("注册"), button:has-text("Create"), button:has-text("确认")').first();
      const btnVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (btnVisible) {
        const isDisabled = await submitBtn.isDisabled().catch(() => true);
        task.logs.push(`[BROWSER] 提交按钮可见, disabled=${isDisabled}`);

        if (isDisabled) {
          task.logs.push('[BROWSER] 按钮仍禁用，强制触发 React 状态更新...');
          await page.evaluate(({ username, email, password }) => {
            function forceReactUpdate(input, value) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              const ev = new Event('input', { bubbles: true });
              Object.defineProperty(ev, 'target', { value: input, writable: false });
              input.dispatchEvent(ev);
            }
            const allInputs = Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null);
            const nameEl = allInputs.find(el => el.type === 'text');
            const emailEl = allInputs.find(el => el.type === 'email' || el.placeholder?.match(/mail|邮箱/i));
            const pwInputs = allInputs.filter(el => el.type === 'password');
            if (nameEl) forceReactUpdate(nameEl, username);
            if (emailEl) forceReactUpdate(emailEl, email);
            if (pwInputs[0]) forceReactUpdate(pwInputs[0], password);
            if (pwInputs[1]) forceReactUpdate(pwInputs[1], password);
            // 强制启用提交按钮
            document.querySelectorAll('button[type="submit"], button[class*="submit"]').forEach(btn => {
              btn.removeAttribute('disabled');
              btn.classList.remove('disabled');
              btn.style.pointerEvents = 'auto';
            });
            // 确保 checkbox 勾选
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
              if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
            });
          }, { username, email, password });
          await page.waitForTimeout(1500);
          const stillDisabled = await submitBtn.isDisabled().catch(() => true);
          task.logs.push(`[BROWSER] 强制处理后 disabled=${stillDisabled}`);
        }

        task.logs.push('[BROWSER] 点击提交...');
        try {
          await submitBtn.click({ timeout: 10000 });
        } catch {
          await submitBtn.click({ force: true, timeout: 10000 }).catch(() => {});
        }
        await page.waitForTimeout(5000);

        const currentUrl = page.url();
        task.logs.push(`[BROWSER] 提交后 URL: ${currentUrl}`);

        // 判断结果
        const pageText = await page.textContent('body').catch(() => '');
        if (pageText.includes('verify') || pageText.includes('验证') || pageText.includes('check your email') || pageText.includes('sent')) {
          task.logs.push('[BROWSER] 注册表单已提交，等待邮件验证');
          result = 'verification_needed';
        } else if (pageText.includes('welcome') || pageText.includes('Welcome') || pageText.includes('成功')) {
          task.logs.push('[BROWSER] 注册成功！');
          result = 'success';
        } else {
          task.logs.push(`[BROWSER] 提交后页面状态未知: ${pageText.slice(0, 300)}`);
          // 乐观处理：即使状态未知也尝试等验证邮件
          result = 'verification_needed';
        }
      } else {
        task.logs.push('[BROWSER] 未找到提交按钮');
        result = 'form_not_found';
      }
    } else {
      task.logs.push(`[BROWSER] 未找到表单字段 (email可见=${emailVisible}, password可见=${pwVisible})`);
      // 尝试列出所有 input
      const inputs = await page.locator('input').all();
      for (let i = 0; i < Math.min(inputs.length, 5); i++) {
        const type = await inputs[i].getAttribute('type').catch(() => '?');
        const placeholder = await inputs[i].getAttribute('placeholder').catch(() => '?');
        const visible = await inputs[i].isVisible().catch(() => false);
        task.logs.push(`  input[${i}]: type=${type} placeholder=${placeholder} visible=${visible}`);
      }
      result = 'form_not_found';
    }
  } catch (err) {
    task.logs.push(`[BROWSER] 异常: ${err.message}`);
    result = 'error';
  } finally {
    await browser.close().catch(() => {});
    task.logs.push(`[BROWSER] 浏览器已关闭, 结果: ${result}`);
  }

  return result;
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
    const signupResult = await tryApiSignup(email, password, task);
    if (signupResult.token) {
      task.token = signupResult.token;
      task.method = 'api_direct';
      task.status = 'success';
      task.logs.push('[DONE] 注册成功（API 直接注册）');
      if (task.autoAddToken) {
        addTokenToPool(signupResult.token);
        task.logs.push('[POOL] 令牌已自动添加到令牌池');
      }
      return;
    }

    // 如果被 WAF 拦截，降级到 Playwright 浏览器注册
    if (signupResult.waf) {
      task.logs.push('[WAF] API 被拦截，降级到 Playwright 浏览器注册...');

      if (task.status === 'cancelled') return;

      const browserResult = await runBrowserSignup(email, password, task);

      if (browserResult === 'success') {
        // 浏览器注册成功，尝试登录获取 token
        task.logs.push('[BROWSER] 注册成功，尝试 API 登录获取令牌...');
        await new Promise(r => setTimeout(r, 3000));
        const loginToken = await tryApiLogin(email, password, task);
        if (loginToken) {
          task.token = loginToken;
          task.method = 'browser_signup+api_login';
          task.status = 'success';
          task.logs.push('[DONE] 注册成功（浏览器注册 + API 登录）');
          if (task.autoAddToken) {
            addTokenToPool(loginToken);
            task.logs.push('[POOL] 令牌已自动添加到令牌池');
          }
          return;
        }
      } else if (browserResult === 'verification_needed') {
        // 需要邮件验证
        task.logs.push('[BROWSER] 注册已提交，需要邮件验证...');
        try {
          const verifyResult = await waitForVerificationEmail(email, task, 120000);
          if (verifyResult.type === 'link') {
            await verifyEmailLink(verifyResult.value, task);
          }
          await new Promise(r => setTimeout(r, 5000));
          const loginToken = await tryApiLogin(email, password, task);
          if (loginToken) {
            task.token = loginToken;
            task.method = 'browser_signup+verify+login';
            task.status = 'success';
            task.logs.push('[DONE] 注册成功（浏览器注册 + 邮件验证 + 登录）');
            if (task.autoAddToken) {
              addTokenToPool(loginToken);
              task.logs.push('[POOL] 令牌已自动添加到令牌池');
            }
            return;
          }
        } catch (err) {
          task.logs.push(`[VERIFY] 验证流程失败: ${err.message}`);
        }
      }

      // 浏览器注册也失败了
      if (task.status !== 'success') {
        task.status = 'failed';
        task.error = 'WAF 拦截 + 浏览器注册失败';
        task.logs.push(`[DONE] 注册失败 — 浏览器注册结果: ${browserResult}`);
      }
      return;
    }

    if (task.status === 'cancelled') return;

    // Step 3: 等待验证邮件（API 注册未被 WAF 拦截但没返回 token，可能需要验证）
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
