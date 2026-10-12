import { Router } from 'express';
import { authRequired, requireRole } from '../middlewares/auth.js';
import { rateLimit } from '../middlewares/rateLimit.js';
import config from '../config/index.js';
import { publishNews, listNews, listMyNews } from '../controllers/publisherController.js';
import { voteNews, voteStock, myVotes } from '../controllers/newsController.js';

const router = Router();
// 操作员 / 高级操作员 / 管理员（root 自动放行）。
// 高级操作员的差别不在能否进来，而在「发布的新闻免审核」（见 publisherController.publishNews）。
router.use(authRequired, requireRole('operator', 'senior_operator', 'admin'));

/** 发新闻限流：每人每小时 N 次（新闻会直接影响股价，属高价值写操作） */
const newsLimiter = rateLimit({
  scope: 'publish:news',
  capacity: config.rateLimit.news,
  windowMs: 60 * 60 * 1000,
  keyBy: 'user',
  message: '发布新闻过于频繁，请稍后再试',
});

/** 投票限流：每人每分钟 N 次（典型的高频写操作） */
const voteLimiter = rateLimit({
  scope: 'vote',
  capacity: config.rateLimit.vote,
  windowMs: 60 * 1000,
  keyBy: 'user',
  message: '投票过于频繁，请稍后再试',
});

// 新闻发布与查询
router.post('/news', newsLimiter, publishNews);
router.get('/news', listNews);
// ★ 我提交的新闻：必须放在 '/news/:id' 类路由之前，且服务端按 publisherId 过滤
//   —— 前端原来在 /news 结果里自己筛，接口不回 publisherId 时列表恒为空（已修 bug）
router.get('/news/mine', listMyNews);

// 投票：新闻 / 股票
router.post('/news/:id/vote', voteLimiter, voteNews);
router.post('/stock-vote', voteLimiter, voteStock);
router.get('/my-votes', myVotes);

export default router;
