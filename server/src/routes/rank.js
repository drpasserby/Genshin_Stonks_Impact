import { Router } from 'express';
import { authOptional } from '../middlewares/auth.js';
import { rateLimit } from '../middlewares/rateLimit.js';
import { rank } from '../controllers/rankController.js';

const router = Router();

/**
 * 排行榜是公开读接口（靠内存快照响应，不碰数据库），
 * 但仍加一道轻限流，避免被脚本当成高频探针刷。
 */
const rankLimiter = rateLimit({
  scope: 'rank:view',
  capacity: 60,
  windowMs: 60 * 1000,
  keyBy: 'auto',
  message: '刷新过于频繁，请稍后再试',
});

router.get('/', authOptional, rankLimiter, rank);

export default router;
