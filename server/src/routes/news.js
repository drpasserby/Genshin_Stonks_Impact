import { Router } from 'express';
import { authOptional } from '../middlewares/auth.js';
import { listNews, newsDetail } from '../controllers/newsController.js';

const router = Router();

// 新闻板块公开可读（无需登录）
router.get('/', authOptional, listNews);
router.get('/:id', authOptional, newsDetail);

export default router;
