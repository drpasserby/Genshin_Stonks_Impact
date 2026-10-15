import config from '../config/index.js';
import logger from '../utils/logger.js';
import { clientIp } from '../utils/requestInfo.js';

/**
 * ==================== 高频操作限流（令牌桶） ====================
 *
 * 为什么自研而不是装 express-rate-limit：
 *   - 本项目是单实例 PM2 fork 模式 + 1G 内存，进程内内存计数最省资源，不需要 Redis；
 *   - 需要「已登录按 userId、未登录按 IP」的混合身份，以及每个路由不同策略；
 *   - 只有 100 行，行为完全可控。
 *
 * 算法：令牌桶
 *   - 桶容量 = 窗口内允许次数（突发上限）
 *   - 以 capacity/windowMs 的速率持续补充，因此不存在固定窗口在边界处「双倍突发」的问题
 *   - 每 2 秒才可能返回一次「桶满」，比固定窗口更平滑
 *
 * 内存安全：
 *   - 每个 key 只占 { tokens, last } 两个数字
 *   - 每 60 秒清理一次超过 10 分钟没活动的桶
 *   - 桶总数硬上限 MAX_KEYS，超了就按最久未活动淘汰，防止 DDoS 撑爆内存
 */

const IDLE_MS = 10 * 60 * 1000;   // 10 分钟没活动就回收
const SWEEP_MS = 60 * 1000;       // 每 60 秒清理一次
const MAX_KEYS = 20000;           // 同时跟踪的身份数上限

/** @type {Map<string, {tokens:number,last:number,loggedAt:number}>} */
const buckets = new Map();
let sweepTimer = null;

function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (now - b.last > IDLE_MS) buckets.delete(key);
    }
  }, SWEEP_MS);
  // 不因为这个定时器而阻止进程退出
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** 超过上限时按「最久未活动」淘汰，保证内存有界 */
function evictIfNeeded() {
  if (buckets.size <= MAX_KEYS) return;
  const entries = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last);
  const removeCount = entries.length - MAX_KEYS + Math.ceil(MAX_KEYS * 0.1);
  for (let i = 0; i < removeCount; i++) buckets.delete(entries[i][0]);
  logger.warn(`[限流] 跟踪身份数超限，已淘汰 ${removeCount} 个最久未活动记录（当前 ${buckets.size}）`);
}

/** 尝试取走 1 个令牌 */
function take(key, capacity, windowMs) {
  const now = Date.now();
  const ratePerMs = capacity / windowMs;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, last: now, loggedAt: 0 };
    buckets.set(key, b);
    evictIfNeeded();
  } else {
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + elapsed * ratePerMs);
      b.last = now;
    }
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterMs: 0, bucket: b };
  }
  return { allowed: false, retryAfterMs: Math.ceil((1 - b.tokens) / ratePerMs), bucket: b };
}

/** 身份判定：已登录按 userId（避免 NAT 下互相拖累），未登录按 IP */
function resolveIdentity(req, keyBy) {
  if (keyBy === 'ip') return `ip:${clientIp(req) || 'unknown'}`;
  if (keyBy === 'user') return req.user?.id ? `u:${req.user.id}` : `ip:${clientIp(req) || 'unknown'}`;
  if (keyBy === 'ip+username') {
    const name = String(req.body?.username || '').trim().toLowerCase().slice(0, 32);
    return `ipu:${clientIp(req) || 'unknown'}|${name}`;
  }
  // auto
  return req.user?.id ? `u:${req.user.id}` : `ip:${clientIp(req) || 'unknown'}`;
}

/**
 * @param {object} opts
 * @param {string} opts.scope     策略名（用于日志与 key 前缀，必须唯一）
 * @param {number|function} opts.capacity 窗口内允许次数（0 或负数 = 关闭）。
 *        传函数时「每次请求」求值 —— 这样控制面板改完频率立刻生效，无需重启。
 * @param {number} opts.windowMs  窗口毫秒数
 * @param {'auto'|'ip'|'user'|'ip+username'} [opts.keyBy]
 * @param {string} [opts.message] 超限提示
 */
export function rateLimit({ scope, capacity, windowMs, keyBy = 'auto', message }) {
  startSweeper();
  const window = Number(windowMs) || 60000;
  const text = message || '操作过于频繁，请稍后再试';
  const resolveCapacity = typeof capacity === 'function'
    ? capacity
    : () => Number(capacity) || 0;

  return function rateLimitMiddleware(req, res, next) {
    if (!config.rateLimit.enabled) return next();

    // 动态取容量：支持管理员在控制面板热改（0 或负数 = 关闭该策略）
    const limit = Number(resolveCapacity()) || 0;
    if (limit <= 0) return next();

    const identity = resolveIdentity(req, keyBy);
    const key = `${scope}|${identity}`;
    const { allowed, retryAfterMs, bucket } = take(key, limit, window);

    if (allowed) return next();

    const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.set('Retry-After', String(retrySec));

    // 同一个 key 每分钟最多记一条日志，避免被攻击时反而把日志刷爆（磁盘/IO 放大）
    const now = Date.now();
    if (now - bucket.loggedAt > 60000) {
      bucket.loggedAt = now;
      logger.warn(
        `[限流] 拦截 ${scope} | 身份=${identity} | ${req.method} ${req.originalUrl} | 规则=${limit}/${Math.round(window / 1000)}s`
      );
    }

    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      message: `${text}（${retrySec} 秒后可重试）`,
      data: null,
    });
  };
}

/** 只对写操作（非 GET/HEAD/OPTIONS）生效的限流包装 */
export function writeOnly(middleware) {
  return function writeOnlyMiddleware(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return middleware(req, res, next);
  };
}

/** 供测试/运维使用：当前跟踪的桶数量 */
export function bucketStats() {
  return { keys: buckets.size, maxKeys: MAX_KEYS, enabled: config.rateLimit.enabled };
}

/** 供测试使用：清空所有计数 */
export function resetBuckets() {
  buckets.clear();
}
