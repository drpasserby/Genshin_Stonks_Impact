import { Op } from 'sequelize';
import sequelize from '../config/db.js';
import { Order, Trade, Holding, Stock, User, OperationLog } from '../models/index.js';
import { ok } from '../utils/response.js';
import { notFound } from '../utils/errors.js';
import { toNum } from '../utils/money.js';
import { createOrder, cancelOrder, getHoldLockInfo } from '../services/tradingService.js';
import { decorateStock } from './stockController.js';
import { logContext } from '../utils/requestInfo.js';

const round2 = (n) => Math.round(n * 100) / 100;

function serializeOrder(o) {
  return {
    id: o.id,
    stockId: o.stockId,
    stockCode: o.stock?.code || null,
    stockName: o.stock?.name || null,
    side: o.side,
    type: o.type,
    price: o.price == null ? null : toNum(o.price),
    quantity: o.quantity,
    filledQuantity: o.filledQuantity,
    reservedAmount: o.reservedAmount == null ? null : toNum(o.reservedAmount),
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** 下单（市价立即成交 / 限价冻结入队） */
export async function placeOrder(req, res, next) {
  try {
    const { stockId, side, type, price = null, quantity } = req.body;
    const result = await createOrder({
      userId: req.user.id, stockId: Number(stockId),
      side, type, price: price == null ? null : Number(price),
      quantity: Number(quantity),
    });
    OperationLog.create({
      userId: req.user.id, action: 'PLACE_ORDER',
      detail: JSON.stringify({ stockId, side, type, price, quantity }),
      ...logContext(req),
    }).catch(() => {});
    ok(res, {
      order: serializeOrder(result.order),
      trade: result.trade
        ? {
            id: result.trade.id, price: toNum(result.trade.price), quantity: result.trade.quantity,
            amount: toNum(result.trade.amount), fee: toNum(result.trade.fee),
            netAmount: round2(toNum(result.trade.amount) - toNum(result.trade.fee)),
            side: result.trade.side,
          }
        : null,
      message: result.trade ? '已成交' : '已挂单，等待周期撮合',
    });
  } catch (err) { next(err); }
}

/** 我的委托单列表 */
export async function myOrders(req, res, next) {
  try {
    const { status } = req.query;
    const where = { userId: req.user.id };
    if (status && ['PENDING', 'FILLED', 'CANCELLED'].includes(status)) where.status = status;
    const rows = await Order.findAll({
      where,
      include: [{ model: Stock, as: 'stock', attributes: ['id', 'code', 'name'] }],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    ok(res, rows.map(serializeOrder));
  } catch (err) { next(err); }
}

/** 撤单 */
export async function cancelMyOrder(req, res, next) {
  try {
    const order = await cancelOrder(req.user.id, Number(req.params.id));
    OperationLog.create({ userId: req.user.id, action: 'CANCEL_ORDER', detail: JSON.stringify({ id: order.id }), ...logContext(req) }).catch(() => {});
    ok(res, serializeOrder(order), '撤单成功');
  } catch (err) { next(err); }
}

/** 持仓（含现价/市值/盈亏） */
export async function myHoldings(req, res, next) {
  try {
    const holdings = await Holding.findAll({
      where: { userId: req.user.id, quantity: { [Op.gt]: 0 } },
      include: [{ model: Stock, as: 'stock' }],
      order: [['updatedAt', 'DESC']],
    });
    const items = await Promise.all(holdings.map(async (h) => {
      const st = decorateStock(h.stock);
      const qty = toNum(h.quantity);
      const cost = toNum(h.avgCost);
      const frozen = toNum(h.frozenQuantity);
      // 最少持有周期带来的"锁仓"信息（可卖 = 已解锁部分；不含挂单冻结）
      const lock = await getHoldLockInfo(req.user.id, h.stockId, qty);
      const sellable = Math.max(0, Math.min(qty - frozen, lock.sellable));
      // 股票已被管理员删除 → 关联查不到。不能抛异常（会让整个"我的"页面 500），
      // 而是标记为已下架、市值为 0，让用户能正常打开页面看到这条记录。
      if (!st) {
        return {
          stockId: h.stockId,
          code: null,
          name: '（已下架）',
          avatarUrl: null,
          quantity: qty,
          frozenQuantity: frozen,
          avgCost: cost,
          price: 0,
          changePct: 0,
          marketValue: 0,
          profit: 0,
          profitPct: 0,
          delisted: true,
          lockedQuantity: lock.locked,
          sellableQuantity: sellable,
          unlockAt: lock.nextUnlockAt,
          holdCycles: lock.cycles,
          updatedAt: h.updatedAt,
        };
      }
      const marketValue = round2(st.price * qty);
      const profit = round2((st.price - cost) * qty);
      return {
        stockId: h.stockId,
        code: st.code,
        name: st.name,
        avatarUrl: st.avatarUrl,
        quantity: qty,
        frozenQuantity: frozen,
        avgCost: cost,
        price: st.price,
        changePct: st.changePct,
        marketValue,
        profit,
        profitPct: cost ? round2(((st.price - cost) / cost) * 100) : 0,
        delisted: false,
        lockedQuantity: lock.locked,
        sellableQuantity: sellable,
        unlockAt: lock.nextUnlockAt,
        holdCycles: lock.cycles,
        updatedAt: h.updatedAt,
      };
    }));
    ok(res, items);
  } catch (err) { next(err); }
}

/** 成交记录 */
export async function myTrades(req, res, next) {
  try {
    const { stockId, page = 1, pageSize = 50 } = req.query;
    const where = { userId: req.user.id };
    if (stockId) where.stockId = Number(stockId);
    const { rows, count } = await Trade.findAndCountAll({
      where,
      include: [{ model: Stock, as: 'stock', attributes: ['id', 'code', 'name'] }],
      order: [['matchedAt', 'DESC']],
      offset: (Number(page) - 1) * Number(pageSize),
      limit: Math.min(Number(pageSize), 200),
    });
    ok(res, {
      total: count,
      list: rows.map((t) => ({
        id: t.id, orderId: t.orderId, stockId: t.stockId,
        stockCode: t.stock?.code, stockName: t.stock?.name,
        side: t.side, price: toNum(t.price), quantity: t.quantity,
        amount: toNum(t.amount),
        /** 卖方印花税（买入恒为 0）；实际到账 = amount − fee */
        fee: toNum(t.fee),
        netAmount: round2(toNum(t.amount) - toNum(t.fee)),
        /** 卖出份额的成本（移动加权均价×数量，买入为 0） */
        costAmount: toNum(t.costAmount),
        /** 平仓盈亏（税后）= 到账 − 成本（买入为 0，前端显示为 —） */
        realizedProfit: toNum(t.realizedProfit),
        matchedAt: t.matchedAt,
      })),
    });
  } catch (err) { next(err); }
}

/** 账户总览：资金 + 持仓汇总 */
export async function account(req, res, next) {
  try {
    const user = await User.findByPk(req.user.id);
    const holdings = await Holding.findAll({
      where: { userId: req.user.id, quantity: { [Op.gt]: 0 } },
      include: [{ model: Stock, as: 'stock' }],
    });
    let marketValue = 0;
    let totalCost = 0;
    const holdingItems = await Promise.all(holdings.map(async (h) => {
      const qty = toNum(h.quantity);
      const cost = toNum(h.avgCost);
      const frozen = toNum(h.frozenQuantity);
      const lock = await getHoldLockInfo(req.user.id, h.stockId, qty);
      const sellable = Math.max(0, Math.min(qty - frozen, lock.sellable));
      // 关联股票已删除：不计入市值/成本，仅以「已下架」形式保留记录，避免整个接口报错
      if (!h.stock) {
        return {
          stockId: h.stockId, code: null, name: '（已下架）',
          quantity: qty, frozenQuantity: frozen, avgCost: cost,
          marketValue: 0, profit: 0, delisted: true,
          lockedQuantity: lock.locked, sellableQuantity: sellable,
          unlockAt: lock.nextUnlockAt, holdCycles: lock.cycles,
        };
      }
      const mv = round2(toNum(h.stock.price) * qty);
      marketValue += mv;
      totalCost += round2(cost * qty);
      return {
        stockId: h.stockId, code: h.stock.code, name: h.stock.name,
        quantity: qty, frozenQuantity: frozen, avgCost: cost,
        marketValue: mv, profit: round2(mv - cost * qty), delisted: false,
        lockedQuantity: lock.locked, sellableQuantity: sellable,
        unlockAt: lock.nextUnlockAt, holdCycles: lock.cycles,
      };
    }));
    marketValue = round2(marketValue);
    const mora = toNum(user.mora);
    const frozenMora = toNum(user.frozenMora);
    /* 累计已实现盈亏 = 全部卖出的平仓盈亏之和（走 trades(user_id, matched_at) 索引，单次聚合） */
    const realizedProfit = await realizedProfitOf(req.user.id);
    const holdingProfit = round2(marketValue - totalCost);
    ok(res, {
      mora,
      frozenMora,
      totalAssets: round2(mora + marketValue),
      marketValue,
      holdings: holdingItems,
      /** 未实现盈亏（持仓浮动盈亏） */
      holdingProfit,
      /** 已实现盈亏（累计平仓盈亏，税后） */
      realizedProfit,
      /** 两者之和 = 交易总盈亏（口径自洽：已实现 + 未实现） */
      tradingProfit: round2(realizedProfit + holdingProfit),
    });
  } catch (err) { next(err); }
}

/** 某用户累计已实现盈亏（平仓盈亏合计） */
async function realizedProfitOf(userId) {
  const [[row]] = await sequelize.query(
    "SELECT COALESCE(SUM(realized_profit), 0) AS sumRealized FROM trades WHERE user_id = ? AND side = 'SELL'",
    { replacements: [userId] }
  );
  return round2(Number(row?.sumRealized) || 0);
}

export { serializeOrder };
