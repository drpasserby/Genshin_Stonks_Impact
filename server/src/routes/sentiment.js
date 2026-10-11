import { Router } from 'express';
import { authOptional } from '../middlewares/auth.js';
import { listSentiment, sentimentDetail } from '../controllers/sentimentController.js';

/**
 * 市场情绪（对外公开）
 *
 * 只暴露已通过审核的数据；接口里不含任何内部字段（批次/审核信息只在 /admin 下）。
 * 命名刻意用 sentiment（情绪）而不是「舆情监控」——对外文案不该出现「舆情监控」字样。
 *
 * ★ 与 /api/news 同口径：`authOptional`（游客可读），不是 `authRequired`。
 *   市场情绪就挂在「新闻」页的第二个标签页里，如果这里强制登录，
 *   未登录访客点开那个标签会直接 401 报错，与新闻页本身公开可读自相矛盾。
 */
const router = Router();

router.get('/', authOptional, listSentiment);
router.get('/:id', authOptional, sentimentDetail);

export default router;
