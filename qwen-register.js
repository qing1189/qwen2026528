const { chromium } = require("playwright");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

// GPTMail API config
const MAIL_API = "https://mail.chatgpt.org.uk";
const MAIL_KEY = "sk-j9g9LI2F7WJ5";

// Helper: HTTP request wrapper
function httpReq(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: { "X-API-Key": MAIL_KEY, ...options.headers },
    };
    const req = mod.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function generateTempEmail() {
  const res = await httpReq(`${MAIL_API}/api/generate-email`);
  console.log("[MAIL] Generated temp email:", JSON.stringify(res.data));
  return res.data;
}

async function getEmails(email) {
  const enc = encodeURIComponent(email);
  const res = await httpReq(`${MAIL_API}/api/emails?email=${enc}`);
  return res.data;
}

async function getEmailById(id) {
  const res = await httpReq(`${MAIL_API}/api/email/${id}`);
  return res.data;
}

async function waitForVerificationEmail(email, maxWait = 120000) {
  const start = Date.now();
  const seenIds = new Set();

  // Pre-collect existing emails to skip
  try {
    const existing = await getEmails(email);
    if (Array.isArray(existing)) existing.forEach((e) => seenIds.add(e.id));
  } catch {}

  console.log("[MAIL] Waiting for verification email...");
  while (Date.now() - start < maxWait) {
    try {
      const emails = await getEmails(email);
      if (Array.isArray(emails)) {
        for (const e of emails) {
          if (seenIds.has(e.id)) continue;
          seenIds.add(e.id);

          // Check subject for verification keywords
          const subject = e.subject || e.Subject || "";
          if (
            subject.toLowerCase().includes("verify") ||
            subject.toLowerCase().includes("验证") ||
            subject.toLowerCase().includes("confirm") ||
            subject.toLowerCase().includes("activation") ||
            subject.toLowerCase().includes("注册")
          ) {
            console.log("[MAIL] Found verification email:", subject);

            // Get full email body
            const full = await getEmailById(e.id);
            const body =
              full?.body || full?.Body || full?.text || full?.Text || full?.html || full?.Html || "";
            const htmlBody = full?.html || full?.Html || body;

            // Extract verification link
            const linkMatch = htmlBody.match(/href=["'](https?:\/\/[^"']*(?:verify|confirm|activate|token)[^"']*)/i);
            if (linkMatch) {
              console.log("[MAIL] Verification link:", linkMatch[1]);
              return { type: "link", value: linkMatch[1], email: full };
            }

            // Extract verification code
            const codeMatch = body.match(/\b(\d{4,8})\b/);
            if (codeMatch) {
              console.log("[MAIL] Verification code:", codeMatch[1]);
              return { type: "code", value: codeMatch[1], email: full };
            }

            return { type: "raw", value: body, email: full };
          }
        }
      }
    } catch (err) {
      console.log("[MAIL] Poll error:", err.message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for verification email");
}

function generatePassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#";
  let pw = "";
  for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf-8").digest("hex");
}

async function tryApiSignup(email, password) {
  const sha256pw = sha256(password);
  console.log("[API] Attempting direct API signup for", email);

  try {
    const res = await httpReq("https://chat.qwen.ai/api/v1/auths/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: sha256pw }),
    });

    if (typeof res.data === "object" && res.data.token) {
      console.log("[API] Direct signup succeeded! Got token");
      return res.data.token;
    }

    console.log("[API] Signup response:", res.status, JSON.stringify(res.data).slice(0, 200));
    return null;
  } catch (err) {
    console.log("[API] Signup request failed:", err.message);
    return null;
  }
}

async function tryApiLogin(email, password) {
  const sha256pw = sha256(password);
  console.log("[API] Attempting API login for", email);

  try {
    const res = await httpReq("https://chat.qwen.ai/api/v1/auths/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: sha256pw }),
    });

    if (typeof res.data === "object" && res.data.token) {
      console.log("[API] Login succeeded! Got JWT token");
      return res.data.token;
    }

    console.log("[API] Login response:", res.status, JSON.stringify(res.data).slice(0, 200));
    return null;
  } catch (err) {
    console.log("[API] Login request failed:", err.message);
    return null;
  }
}

async function verifyEmailLink(link) {
  console.log("[VERIFY] Opening verification link...");
  try {
    const res = await httpReq(link);
    console.log("[VERIFY] Response status:", res.status);
    return true;
  } catch (err) {
    console.log("[VERIFY] Error:", err.message);
    return false;
  }
}

async function runBrowserSignup(email, password) {
  console.log("[BROWSER] Launching Playwright for qwen.ai signup...");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  let result = null;

  try {
    // Navigate to qwen.ai
    console.log("[BROWSER] Navigating to chat.qwen.ai...");
    await page.goto("https://chat.qwen.ai/", { waitUntil: "networkidle", timeout: 30000 });
    await page.screenshot({ path: "/tmp/qwen-reg-1-home.png" });

    // Look for and click Sign Up button
    console.log("[BROWSER] Looking for Sign Up button...");
    const signupBtn = await page.locator('button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("注册"), a:has-text("注册")').first();
    if (await signupBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log("[BROWSER] Clicking Sign Up button...");
      await signupBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: "/tmp/qwen-reg-2-signup-page.png" });
    } else {
      console.log("[BROWSER] No Sign Up button found, trying direct URL...");
      await page.goto("https://chat.qwen.ai/auth/signup", { waitUntil: "networkidle", timeout: 30000 });
      await page.screenshot({ path: "/tmp/qwen-reg-2-signup-page.png" });
    }

    // Check if Aliyun WAF captcha appeared
    console.log("[BROWSER] Checking for WAF captcha...");
    const captchaFrame = page.frameLocator('iframe[id*="aliyun"], iframe[src*="aliyun"], iframe[title*="验证"]');
    const captchaVisible = await captchaFrame.locator("#nc_1_n1z, .nc_iconfont, .btn_slide").isVisible().catch(() => false);

    if (captchaVisible) {
      console.log("[BROWSER] Aliyun slider captcha detected! Attempting to solve...");

      // Get the slider knob position
      const sliderFrame = captchaFrame;
      const slider = sliderFrame.locator("#nc_1_n1z, .btn_slide, .nc_iconfont.btn_slide").first();

      // Drag slider from left to right
      const sliderBox = await slider.boundingBox().catch(() => null);
      if (sliderBox) {
        const startX = sliderBox.x + sliderBox.width / 2;
        const startY = sliderBox.y + sliderBox.height / 2;
        const endX = startX + 280; // Typical slider track width

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        // Simulate human-like dragging with slight curve
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
          const progress = i / steps;
          const x = startX + (endX - startX) * progress;
          const y = startY + Math.sin(progress * Math.PI) * 3; // slight wave
          await page.mouse.move(x, y, { steps: 1 });
          await page.waitForTimeout(30 + Math.random() * 40);
        }
        await page.mouse.up();
        await page.waitForTimeout(2000);
        console.log("[BROWSER] Slider drag completed");
        await page.screenshot({ path: "/tmp/qwen-reg-3-after-captcha.png" });
      } else {
        console.log("[BROWSER] Could not find slider bounding box");
      }
    } else {
      console.log("[BROWSER] No WAF captcha visible (or already passed)");
    }

    // Fill in signup form
    console.log("[BROWSER] Looking for signup form fields...");

    // Try various selectors for email input
    const emailInput = await page.locator('input[type="email"], input[name="email"], input[placeholder*="mail"], input[placeholder*="邮箱"]').first();
    const pwInput = await page.locator('input[type="password"], input[name="password"], input[placeholder*="assword"], input[placeholder*="密码"]').first();

    const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    const pwVisible = await pwInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (emailVisible && pwVisible) {
      console.log("[BROWSER] Filling signup form with .type() for React compatibility...");
      // Use .type() instead of .fill() — React/Vue override native value setters
      // so .fill() doesn't trigger onChange events, leaving the button disabled
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      await pwInput.click();
      await pwInput.type(password, { delay: 30 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: "/tmp/qwen-reg-4-filled-form.png" });

      // Check for and click any terms/privacy checkboxes
      console.log("[BROWSER] Looking for terms checkboxes...");
      const checkboxSelectors = [
        'input[type="checkbox"]',
        'span.qwen-chat-checkbox',
        'div[class*="checkbox"]',
        'label[class*="checkbox"]',
        'span[class*="check"]',
        'div[class*="agree"]',
        'label[class*="agree"]',
      ];
      for (const sel of checkboxSelectors) {
        const checkboxes = await page.locator(sel).all();
        for (const cb of checkboxes) {
          const visible = await cb.isVisible().catch(() => false);
          if (visible) {
            console.log(`[BROWSER] Found visible checkbox: ${sel}, clicking...`);
            await cb.click().catch(() => {});
            await page.waitForTimeout(300);
          }
        }
      }

      // Check if submit button is still disabled and try to enable it
      const submitBtn = await page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("注册"), button:has-text("Create"), button:has-text("确认"), button[class*="submit"]').first();
      const btnVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (btnVisible) {
        const isDisabled = await submitBtn.isDisabled().catch(() => true);
        const btnClass = await submitBtn.getAttribute("class").catch(() => "");
        console.log(`[BROWSER] Submit button visible, disabled=${isDisabled}, class="${btnClass}"`);

        if (isDisabled || btnClass.includes("disabled")) {
          console.log("[BROWSER] Button is disabled, trying to force-enable via JS...");
          // Force-remove the disabled attribute and disabled class
          await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"], button.qwenchat-auth-pc-submit-button');
            if (btn) {
              btn.removeAttribute('disabled');
              btn.classList.remove('disabled');
              // Also dispatch input/change events on all inputs to trigger React state
              document.querySelectorAll('input').forEach(input => {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              });
            }
          }).catch(() => {});
          await page.waitForTimeout(1000);

          // Re-check
          const stillDisabled = await submitBtn.isDisabled().catch(() => true);
          console.log(`[BROWSER] After JS enable, disabled=${stillDisabled}`);
        }

        console.log("[BROWSER] Clicking submit...");
        try {
          await submitBtn.click({ timeout: 10000 });
        } catch (clickErr) {
          console.log("[BROWSER] Normal click failed, trying force click...");
          await submitBtn.click({ force: true, timeout: 10000 }).catch(() => {});
        }
        await page.waitForTimeout(5000);
        await page.screenshot({ path: "/tmp/qwen-reg-5-after-submit.png" });

        // Check result
        const pageText = await page.textContent("body").catch(() => "");
        if (pageText.includes("verify") || pageText.includes("验证") || pageText.includes("check your email")) {
          console.log("[BROWSER] Signup form submitted, verification email expected");
          result = "verification_needed";
        } else if (pageText.includes("welcome") || pageText.includes("Welcome") || pageText.includes("成功")) {
          console.log("[BROWSER] Signup appears successful!");
          result = "success";
        } else {
          console.log("[BROWSER] Unknown state after submit, page text:", pageText.slice(0, 300));
          result = "unknown";
        }
      }
    } else {
      console.log("[BROWSER] Could not find signup form fields");
      console.log("[BROWSER] Email field visible:", emailVisible, "Password field visible:", pwVisible);

      // Dump all visible inputs
      const inputs = await page.locator("input").all();
      for (let i = 0; i < inputs.length; i++) {
        const type = await inputs[i].getAttribute("type").catch(() => "?");
        const name = await inputs[i].getAttribute("name").catch(() => "?");
        const placeholder = await inputs[i].getAttribute("placeholder").catch(() => "?");
        const visible = await inputs[i].isVisible().catch(() => false);
        console.log(`  Input[${i}]: type=${type} name=${name} placeholder=${placeholder} visible=${visible}`);
      }

      result = "form_not_found";
    }

    await page.screenshot({ path: "/tmp/qwen-reg-final.png" });
  } catch (err) {
    console.error("[BROWSER] Error:", err.message);
    await page.screenshot({ path: "/tmp/qwen-reg-error.png" }).catch(() => {});
    result = "error";
  } finally {
    await browser.close();
  }

  return result;
}

async function main() {
  const argEmail = process.argv[2];
  const argPassword = process.argv[3];

  console.log("=== Qwen.ai Auto Registration ===");
  console.log("Time:", new Date().toISOString());

  // Step 1: Generate or use provided email
  let email, password;
  if (argEmail && argPassword) {
    email = argEmail;
    password = argPassword;
    console.log("[INIT] Using provided credentials:", email);
  } else {
    console.log("[INIT] Generating temp email via GPTMail...");
    const mailResult = await generateTempEmail();
    if (mailResult && mailResult.email) {
      email = mailResult.email;
    } else if (mailResult && mailResult.data && mailResult.data.email) {
      email = mailResult.data.email;
    } else {
      // Try alternate response format
      const emailStr = typeof mailResult === "string" ? mailResult : JSON.stringify(mailResult);
      const emailMatch = emailStr.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (emailMatch) {
        email = emailMatch[0];
      } else {
        console.error("[INIT] Failed to generate temp email. Raw response:", emailStr);
        process.exit(1);
      }
    }
    password = generatePassword();
    console.log("[INIT] Email:", email);
    console.log("[INIT] Password:", password);
  }

  // Step 2: Try direct API signup first (likely blocked by WAF, but worth trying)
  const apiToken = await tryApiSignup(email, password);
  if (apiToken) {
    console.log("\n=== RESULT ===");
    console.log("email:", email);
    console.log("password:", password);
    console.log("token:", apiToken);
    console.log("method: api_direct");
    return;
  }

  // Step 3: Browser-based signup
  console.log("\n[BROWSER] Direct API blocked, using Playwright...");
  const browserResult = await runBrowserSignup(email, password);
  console.log("[BROWSER] Result:", browserResult);

  if (browserResult === "verification_needed" || browserResult === "unknown") {
    // Step 4: Wait for and process verification email
    console.log("\n[VERIFY] Waiting for verification email...");
    try {
      const verifyResult = await waitForVerificationEmail(email);

      if (verifyResult.type === "link") {
        // Open the verification link
        console.log("[VERIFY] Found verification link, opening...");
        await verifyEmailLink(verifyResult.value);
      } else if (verifyResult.type === "code") {
        console.log("[VERIFY] Found verification code:", verifyResult.value);
        // Would need browser again to enter code - for now try API login
      }

      // Step 5: Try to login
      await new Promise((r) => setTimeout(r, 5000));
      const loginToken = await tryApiLogin(email, password);
      if (loginToken) {
        console.log("\n=== RESULT ===");
        console.log("email:", email);
        console.log("password:", password);
        console.log("token:", loginToken);
        console.log("method: browser_signup+api_login");
        return;
      }
    } catch (err) {
      console.log("[VERIFY] Email verification failed:", err.message);
    }
  }

  // Final fallback: try login anyway (maybe signup worked without verification)
  console.log("\n[FINAL] Trying login as fallback...");
  const finalToken = await tryApiLogin(email, password);
  if (finalToken) {
    console.log("\n=== RESULT ===");
    console.log("email:", email);
    console.log("password:", password);
    console.log("token:", finalToken);
    console.log("method: fallback_login");
    return;
  }

  console.log("\n=== RESULT ===");
  console.log("status: failed");
  console.log("email:", email);
  console.log("password:", password);
  console.log("browser_result:", browserResult);
  console.log("Check screenshots at /tmp/qwen-reg-*.png for details");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
