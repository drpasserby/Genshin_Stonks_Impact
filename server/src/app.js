import express from 'express';
import cors from 'cors';
import logger from './utils/logger.js';
import config from './config/index.js';
import { notFoundHandler, errorHandler } from './middlewares/errorHandler.js';
import { rateLimit, writeOnly } from './middlewares/rateLimit.js';

import authRoutes from './routes/auth.js';
import stockRoutes from './routes/stocks.js';
import userRoutes from './routes/user.js';
import newsRoutes from './routes/news.js';
import operatorRoutes from './routes/operator.js';
import adminRoutes from './routes/admin.js';
import sentimentRoutes from './routes/sentiment.js';
import rankRoutes from './routes/rank.js';
import starRoutes from './routes/stars.js';
import { getPublicMeta } from './services/settingService.js';
import { noteRequestStart, noteRequestEnd } from './services/perfService.js';

const app = express();

// 生产由 Nginx 反代，只信任本机回环的 X-Forwarded-For，才能拿到真实客户端 IP
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

/* ==================== 全站限流（在业务路由之前） ====================
 * ① 每 IP 每分钟总量：挡住单机压测/爬虫
 * ② 写操作每人每分钟：已登录按 userId（避免同一 NAT 互相拖累），未登录按 IP
 * 精细策略（登录/注册/下单/发新闻/投票）在各自路由上叠加，见 routes/*.js
 */
app.use('/api', rateLimit({
  scope: 'api',
  capacity: config.rateLimit.api,
  windowMs: 60 * 1000,
  keyBy: 'ip',
  message: '请求过于频繁，请稍后再试',
}));
app.use('/api', writeOnly(rateLimit({
  scope: 'write',
  capacity: config.rateLimit.write,
  windowMs: 60 * 1000,
  keyBy: 'auto',
  message: '操作过于频繁，请稍后再试',
})));

/* 「系统性能」面板要看的「并发」：每请求只做一次自增 + 一次自减，可忽略不计。
   用 res 的 'close' 事件（响应完成或连接断开都会触发），避免 finish/close 双触发导致计数错乱。 */
app.use('/api', (_req, res, next) => {
  noteRequestStart();
  res.on('close', noteRequestEnd);
  next();
});

// 请求日志（仅开发输出，生产走 winston 文件）
if (!config.isProd) {
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.originalUrl}`);
    next();
  });
}

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { uptime: process.uptime(), ts: Date.now() } });
});

// 公开系统参数（供"说明"页与前端展示真实配置/系统状态，不含敏感信息）
app.get('/api/meta', async (_req, res, next) => {
  try {
    const meta = await getPublicMeta();
    res.json({
      code: 0,
      message: 'ok',
      data: {
        ...meta,
        dailyCloseHour: config.business.dailyCloseHour,
        // 注意：故意不返回定价公式相关参数（baseVolatility / weightPressure /
        // weightNews / weightVote），避免玩家反推股价算法。前端也无需展示。
      },
    });
  } catch (err) { next(err); }
});

app.use('/api/auth', authRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/user', userRoutes);
app.use('/api/news', newsRoutes);
// 市场情绪（社交平台情绪快照）：与新闻完全独立的一条展示线
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/operator', operatorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rank', rankRoutes);
app.use('/api/stars', starRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
