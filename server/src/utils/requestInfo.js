/**
 * 请求来源信息：真实客户端 IP 与 User-Agent
 *
 * 生产环境 Nginx 反代到 127.0.0.1:3000，直接读 req.ip 只会拿到 ::ffff:127.0.0.1。
 * app.js 里已设置 app.set('trust proxy', 'loopback')，因此当且仅当直连方是
 * 本机回环地址时，Express 才会采用 X-Forwarded-For / X-Real-IP。
 * 这样既能拿到真实 IP，又不会被外部伪造的 XFF 头骗到。
 */

/** 客户端 IP（去掉 IPv4-mapped IPv6 前缀，截断到 45 字符） */
export function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '').slice(0, 45) || null;
}

/** User-Agent（截断到 255 字符） */
export function clientUa(req) {
  const ua = req.headers['user-agent'];
  if (typeof ua !== 'string') return null;
  return ua.trim().slice(0, 255) || null;
}

/** 操作日志的公共来源字段：{ ip, userAgent } */
export function logContext(req) {
  return { ip: clientIp(req), userAgent: clientUa(req) };
}

/* ==================== 设备识别（一设备一账号） ==================== */

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 客户端上报的设备号（前端 localStorage 里生成的 UUID） */
export function clientDeviceId(req) {
  const raw = req.headers['x-device-id'] || req.body?.deviceId;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return DEVICE_ID_RE.test(v) ? v : null;
}

/** 稳定短哈希（FNV-1a 32bit）：只做去重键，不需要抗碰撞强度，避免引入 crypto 依赖 */
function fnv1a32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 解析「限制注册」用的设备键。
 * - 浏览器正常上报     → 真实设备号（source='dev'），同浏览器清缓存也拦得住（服务端有记录）
 * - 没上报设备号(脚本) → 用 IP+UA 哈希兜底（source='auto'），避免不带设备号就能无限注册
 *   代价：同一 IP + 同一浏览器只能注册一个账号
 * @returns {{ deviceId: string, source: 'dev'|'auto' } | null}
 */
export function deviceKeyOf(req, { autoFallback = true } = {}) {
  const provided = clientDeviceId(req);
  if (provided) return { deviceId: provided, source: 'dev' };
  if (!autoFallback) return null;
  const hash = fnv1a32(`${clientIp(req) || 'unknown'}|${clientUa(req) || 'unknown'}`)
    .toString(36)
    .padStart(7, '0');
  return { deviceId: `auto-${hash}`, source: 'auto' };
}
