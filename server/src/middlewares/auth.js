import { unauthorized, forbidden } from '../utils/errors.js';
import { User } from '../models/index.js';
import { signToken, verifyToken } from '../utils/jwt.js';

/** 从 Authorization: Bearer xxx 解析 JWT，挂载 req.user */
export async function authRequired(req, _res, next) {
  try {
    const user = await resolveUserFromHeader(req.headers.authorization, true);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** 可选认证：携带有效 token 则挂载 req.user，未携带/无效也不拦截（公开接口用） */
export async function authOptional(req, _res, next) {
  try {
    const user = await resolveUserFromHeader(req.headers.authorization, false);
    if (user) req.user = user;
    next();
  } catch {
    // 可选认证下 token 无效视为匿名
    next();
  }
}

async function resolveUserFromHeader(headerValue, required) {
  const header = headerValue || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    if (required) throw unauthorized('未提供登录凭证');
    return null;
  }
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    if (required) throw unauthorized('登录已过期，请重新登录');
    return null;
  }
  const user = await User.findByPk(payload.sub);
  if (!user) {
    if (required) throw unauthorized('用户不存在');
    return null;
  }
  // 令牌版本比对：改密码时 tokenVersion+1，该用户所有旧 token 立即失效。
  // 老 token 没有 ver 字段时按 0 处理，避免升级瞬间把所有人踢下线。
  const tokenVer = Number(payload.ver ?? 0);
  if (tokenVer !== Number(user.tokenVersion ?? 0)) {
    if (required) throw unauthorized('登录已失效，请重新登录');
    return null;
  }
  if (user.status !== 1) {
    // 2 = 已注销（逻辑删除），0 = 被禁用；两者都拒绝访问
    if (required) throw forbidden(Number(user.status) === 2 ? '账号已注销' : '账号已被禁用');
    return null;
  }
  // 挂载脱敏后的用户对象
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    mora: user.mora,
  };
}

/**
 * 校验角色：roles 为允许列表，如 ['operator','admin']。
 * root（超级管理员）拥有全部权限，自动放行任何角色校验。
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'root') return next();
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** 给操作员/管理员刷新 token 用（登录时已处理） */
export { signToken };
