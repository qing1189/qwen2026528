/**
 * 管理面板独立认证模块
 * 使用 ADMIN_PASSWORD 环境变量，与 API Key 完全独立
 */

export function getAdminPassword() {
  return process.env.ADMIN_PASSWORD?.trim() || '';
}

export function isAdminAuthRequired() {
  return !!getAdminPassword();
}

export function validateAdminPassword(password) {
  const adminPw = getAdminPassword();
  if (!adminPw) return true; // 未设置密码则不需要验证
  return password === adminPw;
}

/**
 * Express 中间件：管理面板 API 认证
 * 从 Authorization header 或 query 参数 admin_key 中读取密码
 */
export function adminAuthMiddleware(req, res, next) {
  if (!isAdminAuthRequired()) return next();

  // 支持 Bearer token 和 query 参数两种方式
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const queryKey = req.query?.admin_key || '';
  const bodyKey = req.body?.admin_password || '';

  const password = bearerToken || queryKey || bodyKey;

  if (validateAdminPassword(password)) {
    return next();
  }

  res.status(401).json({ error: { message: 'Invalid admin password' } });
}
