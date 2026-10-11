import { Router } from 'express';
import { authRequired, authOptional } from '../middlewares/auth.js';
import {
  list, detail, kline, orderBook, stockNews,
  watchlist, addWatch, removeWatch,
} from '../controllers/stockController.js';

const router = Router();

// 自选操作：需要登录（放在 /:id 之前，避免被数字路由吞掉）
router.get('/watchlist', authRequired, watchlist);
router.put('/watchlist/:stockId', authRequired, addWatch);
router.delete('/watchlist/:stockId', authRequired, removeWatch);

// 行情数据：匿名可读（可选的登录标记，用于返回是否自选）
router.get('/', authOptional, list);
router.get('/:id(\\d+)', authOptional, detail);
router.get('/:id(\\d+)/kline', authOptional, kline);
router.get('/:id(\\d+)/orderbook', authOptional, orderBook);
router.get('/:id(\\d+)/news', authOptional, stockNews);

export default router;
