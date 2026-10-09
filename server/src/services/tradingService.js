import sequelize from '../config/db.js';
import { Op } from 'sequelize';
import { Order, Stock, Trade, User, Holding, HoldingLot } from '../models/index.js';
import { badRequest, notFound, forbidden } from '../utils/errors.js';
import { round2, roundPrice, toNum } from '../utils/money.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { getSettingBool, getRuntime, SETTING_KEYS } from './settingService.js';
import { isStampTaxExempt } from '../constants/roles.js';

/**
 * ============ 撮合模型（本系统采用“交易所作对手方”简化模型） ============
 * 1) 市价单：下单立即按当前股价整单成交。
 * 2) 限价单：下单时冻结资金/股份，进入挂单队列；每隔 CYCLE_MINUTES 分钟由
 *    调度任务撮合一次 —— 买价 ≥ 当前价 或 卖价 ≤ 当前价 时，以“当前股价”整单成交。
 * 3) 成交价一律是撮合时刻的当前股价（买方支付当前价而非挂单价），符合业务规则。
 * 4) 无买卖双方对手盘概念：交易所作为对手方提供流动性，撮合价恒为系统当前价。
 * 5) 卖方印花税：按「卖方成交额 × STAMP_TAX_RATE（默认 0.5%）」计征，从卖方到账金额里
 *    直接扣除（买方不收取）。这是本系统唯一的摩拉回收阀门，用于对抗通胀；
 *    税额单独记在 trades.fee 上，成交额 amount 保持市场口径不变。
 *    ★ 身份组例外：高级用户（vip）免印花税（fee=0，到账=成交额）。
 * 系统开关 trading_enabled=false（root 控制面板设置）时进入“停市”状态：
 *   下单、撤单、周期撮合全部暂停；行情/K线继续生成（价格按新闻/投票等静态因子不变，成交量恒 0）。
 * ================================================================
 */

/**
 * 停市守卫：若系统暂停交易则抛 403。
 * 用于 createOrder / cancelOrder / 周期撮合入口。
 */
export async function assertTradingOpen() {
  const tradingEnabled = await getSettingBool(SETTING_KEYS.tradingEnabled, true);
  if (!tradingEnabled) {
    throw forbidden('系统暂停交易中，请稍后再试');
  }
}

/** 交易是否处于开放状态（周期任务用，不抛错） */
export async function isTradingOpen() {
  return getSettingBool(SETTING_KEYS.tradingEnabled, true);
}

/**
 * 单标的可交易性校验（与全局 trading_enabled 互补）：
 *   0 = 暂停交易（停牌） → 不能新下单，但可撤单
 *   2 = 已退市           → 不能下单；退市时系统已自动撤掉全部未成交挂单
 */
export function assertStockTradable(stock) {
  const st = Number(stock?.status ?? 1);
  if (st === 0) throw forbidden('该标的已暂停交易（停牌中），无法下单');
  if (st === 2) throw forbidden('该标的已退市，无法交易');
}

/**
 * 退市/停牌维护用：撤销某标的全部未成交挂单并解冻资金/股份。
 * 不校验全局交易开关（管理员操作应当始终可用），返回撤销数量。
 */
export async function cancelAllPendingOrders(stockId, t) {
  const orders = await Order.findAll({
    where: { stockId, status: 'PENDING' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  let count = 0;
  for (const order of orders) {
    if (order.side === 'BUY' && order.reservedAmount != null) {
      const user = await lockUser(t, order.userId);
      refundBuyReserve(t, user, toNum(order.reservedAmount));
      await user.save({ transaction: t });
    } else if (order.side === 'SELL') {
      const holding = await lockHolding(t, order.userId, order.stockId);
      if (holding) {
        holding.frozenQuantity = Math.max(0, toNum(holding.frozenQuantity) - order.quantity);
        await holding.save({ transaction: t });
      }
    }
    order.status = 'CANCELLED';
    await order.save({ transaction: t });
    count++;
  }
  return count;
}

/** 以整数“分/厘”做金额运算，避免浮点误差；金额单位摩拉(2位)、股价(4位) */
const toCents = (n) => Math.round(toNum(n) * 100);
const fromCents = (c) => c / 100;

/**
 * 卖方印花税（分）。按成交额计征，四舍五入到分。
 * 税率来自 .env 的 STAMP_TAX_RATE（默认 0.005 = 0.5%），设为 0 即关闭。
 * ★ 身份组例外：高级用户（vip）免印花税 —— 免征判断在 executeSell 里做
 *   （本函数只负责"按税率算钱"，保持一件事）。
 */
function stampTaxCents(grossCents) {
  const rate = Number(config.business.stampTaxRate) || 0;
  if (rate <= 0) return 0;
  return Math.round(grossCents * rate);
}

/** 下单前校验（不涉及事务） */
function assertOrderParams({ stock, side, type, price, quantity }) {
  const { orderMinQty, orderMaxQty } = config.business;
  if (!Number.isInteger(quantity) || quantity < orderMinQty || quantity > orderMaxQty) {
    throw badRequest(`委托数量须为 ${orderMinQty}~${orderMaxQty} 的整数`);
  }
  if (side !== 'BUY' && side !== 'SELL') throw badRequest('side 必须为 BUY 或 SELL');
  if (type !== 'MARKET' && type !== 'LIMIT') throw badRequest('type 必须为 MARKET 或 LIMIT');
  if (type === 'LIMIT') {
    if (!(toNum(price) > 0)) throw badRequest('限价单必须提供价格');
    if (side === 'BUY' && toNum(price) > 0 && toNum(price) < 0.0001) throw badRequest('限价过低');
  }
  if (type === 'MARKET' && price != null) throw badRequest('市价单无需提供价格');
  void stock;
}

/** 锁定用户行，返回可用与冻结金额 */
async function lockUser(t, userId) {
  const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!user) throw notFound('用户不存在');
  return user;
}

/** 锁定持仓行（可能不存在，由调用方处理） */
async function lockHolding(t, userId, stockId) {
  return Holding.findOne({ where: { userId, stockId }, transaction: t, lock: t.LOCK.UPDATE });
}

/**
 * 冻结限价买单所需资金。从可用摩拉划入冻结。
 * reserve = 限价 × 数量（成交价 ≤ 限价，故该额度必然足够）。
 */
async function freezeBuyFunds(t, user, limitPrice, qty) {
  const reserveCents = Math.round(toNum(limitPrice) * qty * 100);
  const moraCents = toCents(user.mora);
  if (moraCents < reserveCents) {
    throw badRequest('可用摩拉不足（含本次冻结）');
  }
  user.mora = fromCents(moraCents - reserveCents);
  user.frozenMora = fromCents(toCents(user.frozenMora) + reserveCents);
  await user.save({ transaction: t });
  return reserveCents / 100;
}

/** 冻结限价卖单所需股份 */
async function freezeSellShares(t, holding, qty) {
  if (!holding) throw badRequest('没有可卖出的持仓');
  const available = toNum(holding.quantity) - toNum(holding.frozenQuantity);
  if (available < qty) throw badRequest('可卖股份不足（含本次冻结）');
  holding.frozenQuantity = toNum(holding.frozenQuantity) + qty;
  await holding.save({ transaction: t });
}

/** 释放冻结：撤单或成交后清算 */
function refundBuyReserve(t, user, reserve, realCostCents = null) {
  // reserve: 下单时冻结的摩拉(Number)；realCostCents: 成交实际成本(分)，成交时退回差额
  const frozenCents = toCents(user.frozenMora);
  const backCents = realCostCents == null ? Math.round(reserve * 100) : Math.round(reserve * 100) - realCostCents;
  user.frozenMora = fromCents(frozenCents - Math.round(reserve * 100));
  user.mora = fromCents(toCents(user.mora) + backCents);
}

/**
 * ============ 最少持有周期（T+N 锁仓） ============
 *
 * 规则：买入后必须持有满 X 个周期才能卖出（X = 控制面板「最少持有周期数」，默认 3）。
 * 实现：每次买入写一条 holding_lots 批次（记录 unlock_at = 买入时刻 + X×周期长度），
 *      卖出按 FIFO 消费批次；只要要卖的份额里有一部分未解锁，整单拒绝。
 *
 * 只有「新买入的部分」会被锁：本功能上线前的存量持仓没有批次记录，视为早已解锁。
 * X = 0 时直接关闭限制（连批次都不消费，存量批次也不再限制）。
 */

/** 当前配置的最少持有周期数（0 = 关闭） */
export function minHoldCycles() {
  const n = Math.floor(Number(getRuntime().minHoldCycles) || 0);
  return n > 0 ? n : 0;
}

/** 锁仓时长（毫秒）= X 个周期 × 周期长度 */
function holdLockMs() {
  const cycles = minHoldCycles();
  if (!cycles) return 0;
  const minutes = Math.max(1, Number(getRuntime().cycleMinutes) || 10);
  return cycles * minutes * 60 * 1000;
}

/** 按需求的原文提示（X 动态取当前设置） */
function lockedError() {
  return forbidden(`该份额持有周期过短，不得卖出。请在买入${minHoldCycles()}个周期后卖出`);
}

/**
 * 读取某个 (用户, 标的) 的锁定状态。
 * 可卖 = 无批次的历史持仓（宽限部分） + 已解锁批次；锁定 = 未解锁批次的股数。
 * @param {number} totalQty 该持仓的当前总股数
 */
async function loadLockState(t, userId, stockId, totalQty) {
  const now = Date.now();
  const lots = await HoldingLot.findAll({
    where: { userId, stockId, quantity: { [Op.gt]: 0 } },
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
    transaction: t,
    ...(t ? { lock: t.LOCK.UPDATE } : {}),
  });
  let lotTotal = 0;
  let unlocked = 0;
  let nextUnlockAt = null;
  for (const l of lots) {
    const q = Number(l.quantity) || 0;
    lotTotal += q;
    const at = new Date(l.unlockAt).getTime();
    if (at <= now) unlocked += q;
    else if (nextUnlockAt === null || at < nextUnlockAt) nextUnlockAt = at;
  }
  const grandfathered = Math.max(0, Number(totalQty || 0) - lotTotal);
  return {
    lots,
    lotTotal,
    unlocked,
    grandfathered,
    locked: lotTotal - unlocked,
    sellable: grandfathered + unlocked,
    nextUnlockAt: nextUnlockAt === null ? null : new Date(nextUnlockAt),
  };
}

/** 对外（只读接口用）：不加锁查询某个持仓的可卖/锁定情况 */
export async function getHoldLockInfo(userId, stockId, totalQty, t = null) {
  if (!minHoldCycles()) {
    return { locked: 0, sellable: Number(totalQty) || 0, nextUnlockAt: null, cycles: 0 };
  }
  const st = await loadLockState(t, userId, stockId, totalQty);
  return { locked: st.locked, sellable: st.sellable, nextUnlockAt: st.nextUnlockAt, cycles: minHoldCycles() };
}

/**
 * 卖出时的批次处理：**始终**按 FIFO 消费批次；限制开启时额外校验"只能卖已解锁的部分"。
 *
 * ⚠️ 为什么关闭限制时也要消费批次：若不消费，批次会不断残留，
 * 下次开启限制时这些"幽灵批次"会把可卖池撑大（实测踩过：关着限制买卖一轮后，
 * 再开限制买入的新股居然能立刻卖出）。始终消费才能维持「批次总量 == 持仓量」的不变式。
 *
 * 不满足最少持有周期时抛「该份额持有周期过短…」，由事务回滚保证无副作用。
 */
async function consumeLots(t, userId, stockId, qty, totalQtyBefore) {
  const cycles = minHoldCycles();
  const st = await loadLockState(t, userId, stockId, totalQtyBefore);
  if (cycles && st.sellable < qty) throw lockedError();

  // 先扣"无批次的历史持仓"（它们最老），再按买入先后扣批次
  let remain = Math.max(0, qty - Math.min(st.grandfathered, qty));
  for (const lot of st.lots) {
    if (remain <= 0) break;
    const q = Number(lot.quantity) || 0;
    if (q <= 0) continue;
    // 限制开启时：未解锁的批次不动；限制关闭时：所有批次都可动
    if (cycles && new Date(lot.unlockAt).getTime() > Date.now()) continue;
    const take = Math.min(q, remain);
    remain -= take;
    lot.quantity = q - take;
    if (lot.quantity <= 0) await lot.destroy({ transaction: t });
    else await lot.save({ transaction: t });
  }
  return st;
}

/**
 * 下单前置校验（限价卖单在冻结股份之前就要拦，否则会挂到结算时才失败）。
 * @param {number} totalQty 持仓总股数
 */
export async function assertSellable(t, userId, stockId, qty, totalQty) {
  if (!minHoldCycles()) return null;
  const st = await loadLockState(t, userId, stockId, totalQty);
  if (st.sellable < qty) throw lockedError();
  return st;
}

/** 执行一次买入成交（市价或限价撮合到同一入口）。
 * 前提：资金已冻结（限价）或当场校验（市价）。
 */
async function executeBuy(t, { user, stock, qty, fillPrice, frozenReserve = null }) {
  const price = roundPrice(toNum(fillPrice));
  const costCents = Math.round(price * qty * 100);
  const moraCents = toCents(user.mora);
  if (frozenReserve == null) {
    if (moraCents < costCents) throw badRequest('摩拉不足');
    user.mora = fromCents(moraCents - costCents);
  } else {
    // 限价成交：冻结中扣除成本，差额退回可用
    refundBuyReserve(t, user, frozenReserve, costCents);
  }
  await user.save({ transaction: t });

  // 更新持仓（加权平均成本）
  let holding = await lockHolding(t, user.id, stock.id);
  if (!holding) {
    holding = await Holding.create(
      { userId: user.id, stockId: stock.id, quantity: 0, frozenQuantity: 0, avgCost: 0 },
      { transaction: t }
    );
  }
  const oldQty = toNum(holding.quantity);
  const oldCost = toNum(holding.avgCost);
  const newQty = oldQty + qty;
  const newAvg = newQty > 0 ? roundPrice((oldQty * oldCost + price * qty) / newQty) : 0;
  holding.quantity = newQty;
  holding.avgCost = newAvg;
  await holding.save({ transaction: t });

  // 更新股票日成交量（原子 SQL，避免锁内多实例脏写 / 整行覆盖）
  await Stock.increment('volume', { by: qty, where: { id: stock.id }, transaction: t });

  // 记录买入批次：用于「最少持有周期」限制。
  // 即使当前限制是关闭的也记一条（unlock_at = 现在，即立刻可卖），
  // 这样"批次总量 == 持仓量"的不变式始终成立，不会退化成"历史宽限"。
  await HoldingLot.create(
    {
      userId: user.id,
      stockId: stock.id,
      quantity: qty,
      buyPrice: price,
      unlockAt: new Date(Date.now() + holdLockMs()),
    },
    { transaction: t }
  );

  return fromCents(costCents);
}

/**
 * 执行一次卖出成交。
 * 卖方实际到账 = 成交额 − 印花税（买方不收费）。
 * ★ 高级用户（vip）免印花税：fee 记 0，到账即全额，平仓盈亏随之按税后口径自然变大。
 * @returns {Promise<{gross:number, fee:number, net:number, cost:number, realized:number}>}
 *   gross=成交额 fee=印花税 net=到账 cost=卖出份额成本 realized=税后平仓盈亏
 */
async function executeSell(t, { user, stock, holding, qty, fillPrice, frozen = false }) {
  const heldQty = toNum(holding.quantity);
  const frozenQty = toNum(holding.frozenQuantity);
  if (heldQty < qty) throw badRequest('持仓不足');
  if (!frozen && heldQty - frozenQty < qty) throw badRequest('可卖股份不足（有挂单冻结）');
  // 最少持有周期校验（并消费批次）；未通过时抛错，事务回滚，不会产生任何副作用
  await consumeLots(t, user.id, stock.id, qty, heldQty);

  const price = roundPrice(toNum(fillPrice));
  const grossCents = Math.round(price * qty * 100);
  // 免印花税身份组（高级用户 vip）：税额恒为 0，到账 = 成交额
  const exempt = isStampTaxExempt(user.role);
  const taxCents = exempt ? 0 : stampTaxCents(grossCents);
  const netCents = grossCents - taxCents;
  /**
   * 平仓盈亏（税后）：成本按「成交时的移动加权均价 × 数量」算 —— 此刻 holding.avgCost
   * 还是卖出前的均价（卖出不改均价），因此不需要任何额外查询。
   * 口径与持仓页显示的「成本价 / 浮动盈亏」一致，两处数字不会打架。
   */
  const costCents = Math.round(toNum(holding.avgCost) * qty * 100);
  const realizedCents = netCents - costCents;
  user.mora = fromCents(toCents(user.mora) + netCents);
  await user.save({ transaction: t });

  holding.quantity = heldQty - qty;
  if (frozen) holding.frozenQuantity = frozenQty - qty;
  if (holding.quantity <= 0 && holding.frozenQuantity <= 0) {
    await holding.destroy({ transaction: t });
  } else {
    await holding.save({ transaction: t });
  }

  // 原子更新日成交量（避免锁内多实例脏写 / 整行覆盖）
  await Stock.increment('volume', { by: qty, where: { id: stock.id }, transaction: t });

  return {
    gross: fromCents(grossCents),
    fee: fromCents(taxCents),
    net: fromCents(netCents),
    cost: fromCents(costCents),
    realized: fromCents(realizedCents),
  };
}

/**
 * 撮合单个限价订单（由周期调度或下单时调用）。
 * 规则：买价≥当前价 或 卖价≤当前价 → 以当前价整单成交。
 * @returns {Promise<Trade|null>}
 */
export async function matchLimitOrder(t, order, force = false) {
  if (order.status !== 'PENDING') return null;
  const stock = await Stock.findByPk(order.stockId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!stock) return null;
  const current = toNum(stock.price);
  const limit = toNum(order.price);
  const qty = order.quantity;
  const crossed = order.side === 'BUY' ? limit >= current : limit <= current;
  if (!crossed && !force) return null;
  if (!crossed && force) throw badRequest('限价单当前不可成交');

  const user = await lockUser(t, order.userId);
  const fillPrice = current;
  let amount;
  let fee = 0;
  let costAmount = 0;
  let realizedProfit = 0;
  if (order.side === 'BUY') {
    amount = await executeBuy(t, { user, stock, qty, fillPrice, frozenReserve: toNum(order.reservedAmount ?? limit * qty) });
  } else {
    const holding = await lockHolding(t, user.id, stock.id);
    if (!holding) return null;
    const sell = await executeSell(t, { user, stock, holding, qty, fillPrice, frozen: true });
    amount = sell.gross;
    fee = sell.fee;
    costAmount = sell.cost;
    realizedProfit = sell.realized;
  }

  order.status = 'FILLED';
  await order.save({ transaction: t });

  const trade = await Trade.create(
    {
      orderId: order.id,
      userId: order.userId,
      stockId: order.stockId,
      side: order.side,
      price: roundPrice(fillPrice),
      quantity: qty,
      amount: round2(amount),
      fee: round2(fee),
      costAmount: round2(costAmount),
      realizedProfit: round2(realizedProfit),
      matchedAt: new Date(),
    },
    { transaction: t }
  );
  return trade;
}

/**
 * 创建委托单（市价单立即成交；限价单冻结后入队，若立即可成交则立即成交）。
 */
export async function createOrder({ userId, stockId, side, type, price = null, quantity }) {
  await assertTradingOpen(); // 全局停市期间禁止下单
  assertOrderParams({ side, type, price, quantity });
  if (side === 'BUY' && type === 'LIMIT' && toNum(price) >= 1e9) throw badRequest('限价过高');

  const result = await sequelize.transaction(
    { retry: { max: 3 } },
    async (t) => {
      const stock = await Stock.findByPk(stockId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!stock) throw notFound('标的不存在');
      assertStockTradable(stock); // 单标的停牌/退市校验
      const user = await lockUser(t, userId);
      const current = toNum(stock.price);
      const qty = Number(quantity);

    if (type === 'MARKET') {
      // 市价单：立即整单成交
      let amount;
      let fee = 0;
      let costAmount = 0;
      let realizedProfit = 0;
      if (side === 'BUY') {
        amount = await executeBuy(t, { user, stock, qty, fillPrice: current });
      } else {
        const holding = await lockHolding(t, user.id, stock.id);
        if (!holding) throw badRequest('没有可卖出的持仓');
        const sell = await executeSell(t, { user, stock, holding, qty, fillPrice: current });
        amount = sell.gross;
        fee = sell.fee;
        costAmount = sell.cost;
        realizedProfit = sell.realized;
      }
      const order = await Order.create(
        {
          userId, stockId, side, type: 'MARKET', price: null,
          quantity: qty, filledQuantity: qty, status: 'FILLED',
        },
        { transaction: t }
      );
      const trade = await Trade.create(
        {
          orderId: order.id, userId, stockId, side,
          price: roundPrice(current), quantity: qty, amount: round2(amount), fee: round2(fee),
          costAmount: round2(costAmount), realizedProfit: round2(realizedProfit),
          matchedAt: new Date(),
        },
        { transaction: t }
      );
      return { order, trade };
    }

    // 限价单：冻结 → 入队
    let reservedAmount = null;
    const limitPrice = roundPrice(toNum(price));
    if (side === 'BUY') {
      reservedAmount = await freezeBuyFunds(t, user, limitPrice, qty);
    } else {
      const holding = await lockHolding(t, userId, stockId);
      if (!holding) throw badRequest('没有可卖出的持仓');
      // 先校验「最少持有周期」，再冻结股份：否则挂单会一直等到结算时才失败
      await assertSellable(t, userId, stockId, qty, toNum(holding.quantity));
      await freezeSellShares(t, holding, qty);
    }
    const order = await Order.create(
      {
        userId, stockId, side, type: 'LIMIT', price: limitPrice,
        quantity: qty, filledQuantity: 0, status: 'PENDING',
        reservedAmount: reservedAmount != null ? round2(reservedAmount) : null,
      },
      { transaction: t }
    );
    // 若限价已与当前价交叉，立即撮合（体验更接近真实行情软件）
    const crossed = side === 'BUY' ? limitPrice >= current : limitPrice <= current;
    let trade = null;
    if (crossed) {
      trade = await matchLimitOrder(t, await Order.findByPk(order.id, { transaction: t }), true);
    }
    return { order: await Order.findByPk(order.id, { transaction: t }), trade };
    }
  );
  return result;
}

/** 撤单：仅 PENDING 单可撤；释放冻结资金/股份（停市期间同样禁止撤单） */
export async function cancelOrder(userId, orderId) {
  await assertTradingOpen(); // 停市期间禁止撤单
  const result = await sequelize.transaction(
    { retry: { max: 3 } },
    async (t) => {
    const order = await Order.findByPk(orderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!order || order.userId !== userId) throw notFound('委托单不存在');
    if (order.status !== 'PENDING') throw badRequest('该委托单已不可撤销（状态: ' + order.status + '）');

    if (order.side === 'BUY' && order.reservedAmount != null) {
      const user = await lockUser(t, userId);
      refundBuyReserve(t, user, toNum(order.reservedAmount));
      await user.save({ transaction: t });
    } else if (order.side === 'SELL') {
      const holding = await lockHolding(t, userId, order.stockId);
      if (holding) {
        holding.frozenQuantity = Math.max(0, toNum(holding.frozenQuantity) - order.quantity);
        await holding.save({ transaction: t });
      }
    }
    order.status = 'CANCELLED';
    await order.save({ transaction: t });
    return order;
    }
  );
  return result;
}

/** 供周期调度：撮合某股票全部可成交挂单，返回成交 Trade 列表 */
export async function settleStock(t, stockId) {
  const orders = await Order.findAll({
    where: { stockId, status: 'PENDING', type: 'LIMIT' },
    order: [['createdAt', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const trades = [];
  for (const order of orders) {
    try {
      const trade = await matchLimitOrder(t, order);
      if (trade) trades.push(trade);
    } catch (err) {
      logger.warn(`撮合失败 order#${order.id}: ${err.message}`);
    }
  }
  return trades;
}

export { toCents };
