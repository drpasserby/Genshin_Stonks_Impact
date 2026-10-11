import { Router } from 'express';
import { authRequired } from '../middlewares/auth.js';
import { rateLimit } from '../middlewares/rateLimit.js';
import config from '../config/index.js';
import {
  placeOrder, myOrders, cancelMyOrder, myHoldings, myTrades, account,
} from '../controllers/tradeController.js';
import { updateMyRankOptIn } from '../controllers/rankController.js';
import { getOrderRatePerMin, getOrderRatePerHour } from '../services/settingService.js';

const router = Router();
router.use(authRequired);

/**
 * 下单限流：两道闸门（每人每分钟 / 每人每小时）。
 * 目的有两个：① 保护 2 核小机器不被高频下单挤爆；
 *            ② 压制脚本挂机刷单（配合 0.5% 卖方印花税，高频来回交易本身即亏手续费）。
 * 容量用「函数」延迟求值 → 管理员在控制面板改完频率立即生效，无需重启。
 */
const orderLimiterMin = rateLimit({
  scope: 'trade:order:min',
  capacity: getOrderRatePerMin,
  windowMs: 60 * 1000,
  keyBy: 'user',
  message: '下单过于频繁，请稍后再试（每分钟上限可在控制面板调整）',
});
const orderLimiterHour = rateLimit({
  scope: 'trade:order:hour',
  capacity: getOrderRatePerHour,
  windowMs: 60 * 60 * 1000,
  keyBy: 'user',
  message: '下单过于频繁，已达到每小时上限，请稍后再试（可在控制面板调整）',
});

/** 撤单限流：比下单宽松一些 */
const cancelLimiter = rateLimit({
  scope: 'trade:cancel',
  capacity: config.rateLimit.cancel,
  windowMs: 60 * 1000,
  keyBy: 'user',
  message: '撤单过于频繁，请稍后再试',
});

router.post('/orders', orderLimiterMin, orderLimiterHour, placeOrder);
router.get('/orders', myOrders);
router.post('/orders/:id/cancel', cancelLimiter, cancelMyOrder);

router.get('/account', account);          // 资金 + 持仓汇总
router.get('/holdings', myHoldings);
router.get('/trades', myTrades);

/** 是否参与排行榜（用户中心开关）；排行榜本身是公开接口，见 /api/rank */
router.put('/rank-opt-in', updateMyRankOptIn);

export default router;
