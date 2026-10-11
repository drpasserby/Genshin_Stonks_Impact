import { Router } from 'express';
import { rateLimit } from '../middlewares/rateLimit.js';
import { starHoldings } from '../controllers/starController.js';

const router = Router();

/**
 * 明星持仓公开列表（无需登录）。
 * 明星是自愿接受公开标签的身份组，因此这是公开信息；
 * 数据由控制器内做 60 秒内存缓存，这里再叠一层轻量限流，防止被反复刷。
 */
const starLimiter = rateLimit({
  scope: 'stars',
  capacity: 60,
  windowMs: 60 * 1000,
  keyBy: 'ip',
  message: '请求过于频繁，请稍后再试',
});

router.get('/', starLimiter, starHoldings);

export default router;
