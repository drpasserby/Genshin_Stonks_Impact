import { Op } from 'sequelize';
import { Stock, PriceHistory, Order, Watchlist, News, NewsStock, Vote, User, FundConstituent } from '../models/index.js';
import { ok } from '../utils/response.js';
import { notFound } from '../utils/errors.js';
import { toNum, roundPrice } from '../utils/money.js';
import { newsScore } from '../services/engine.js';
import { klinePeriod } from '../services/settingService.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** 计算前端展示的涨跌字段。传入 null（关联股票已被删除）时返回 null，由调用方自行降级处理 */
export function decorateStock(s) {
  if (!s) return null;
  const price = toNum(s.price);
  const prevClose = toNum(s.prevClose);
  const change = prevClose ? price - prevClose : 0;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    type: s.type || 'STOCK',
    status: Number(s.status ?? 1),
    tradable: Number(s.status ?? 1) === 1,
    avatarUrl: s.avatarUrl,
    price,
    prevClose,
    open: toNum(s.open),
    high: toNum(s.high),
    low: toNum(s.low),
    volume: Number(s.volume) || 0,
    totalShares: Number(s.totalShares) || 0,
    marketCap: price * (Number(s.totalShares) || 0),
    change: round2(change),
    changePct: round2(changePct),
    watched: !!s.__watched,
    updatedAt: s.updatedAt,
  };
}

/** 列表：搜索/排序/只看自选/按类型过滤（STOCK 角色 / FUND 基金） */
export async function list(req, res, next) {
  try {
    const { q = '', sort = 'changePct', order = 'desc', watch = '0', type = '' } = req.query;
    const where = {};
    if (['STOCK', 'FUND'].includes(type)) where.type = type;
    // 已退市（status=2）不在公开行情列表展示；停牌(0)仍展示但带停牌标记
    where.status = { [Op.ne]: 2 };
    if (q) {
      where[Op.or] = [
        { name: { [Op.like]: `%${q}%` } },
        { code: { [Op.like]: `%${q}%` } },
      ];
    }
    // 已登录用户的自选股票 id 集合（用于过滤/标记）；匿名用户为空
    const userId = req.user?.id ?? null;
    const watchSet = new Set();
    if (userId) {
      const watchRows = await Watchlist.findAll({ where: { userId }, attributes: ['stockId'], raw: true });
      watchRows.forEach((w) => watchSet.add(w.stockId));
    }
    if (watch === '1') {
      where.id = { [Op.in]: watchSet.size ? [...watchSet] : [-1] };
    }

    const stocks = await Stock.findAll({ where });
    stocks.forEach((s) => { s.__watched = watchSet.has(s.id); });
    // 在内存排序，便于按 changePct 等派生字段排序（数据量小）
    const rows = stocks.map((s) => decorateStock(s));
    // id = 发行序号（越大越新）；order=desc 即「最新发行的排在最前」
    const allowSort = ['id', 'price', 'changePct', 'change', 'volume', 'name', 'code'];
    if (allowSort.includes(sort)) {
      const dir = order === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const av = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], 'zh') : (a[sort] - b[sort]);
        return av * dir;
      });
    }
    ok(res, rows);
  } catch (err) { next(err); }
}

/** 详情：基金额外返回净值/溢价/成分股与权重 */
export async function detail(req, res, next) {
  try {
    const id = Number(req.params.id);
    const stock = await Stock.findByPk(id);
    if (!stock) throw notFound('标的不存在');
    const userId = req.user?.id ?? null;
    let watched = false;
    if (userId) watched = !!(await Watchlist.findOne({ where: { userId, stockId: id } }));
    stock.__watched = watched;

    const base = decorateStock(stock);

    // 指数基金：附带成分股、权重、净值与溢价
    if (stock.type === 'FUND') {
      const rows = await FundConstituent.findAll({
        where: { fundId: id },
        include: [{ model: Stock, as: 'constituent', attributes: ['id', 'code', 'name', 'type', 'price', 'prevClose', 'avatarUrl'] }],
        order: [['weight', 'DESC']],
      });
      const totalW = rows.reduce((s, r) => s + Number(r.weight), 0) || 1;
      const list = rows.map((r) => {
        const c = r.constituent;
        const cp = c ? toNum(c.price) : 0;
        const cprev = c ? toNum(c.prevClose) : 0;
        return {
          id: r.constituentId,
          code: c?.code ?? null,
          name: c?.name ?? '(已下架)',
          avatarUrl: c?.avatarUrl ?? null,
          type: c?.type ?? null,
          price: cp,
          changePct: cprev ? round2(((cp - cprev) / cprev) * 100) : 0,
          weight: Number(r.weight),
          weightPct: round2((Number(r.weight) / totalW) * 100),
          delisted: !c,
        };
      });
      // 实时净值（用成分股当前价现算，和周期任务里的口径一致）
      const nav = list.length
        ? list.reduce((s, x) => s + (x.weight / totalW) * x.price, 0)
        : toNum(stock.nav) || toNum(stock.price);
      base.nav = roundPrice(nav);
      base.premiumPct = nav > 0 ? round2(((toNum(stock.price) - nav) / nav) * 100) : 0;
      base.constituents = list;
      base.constituentCount = list.length;
    }

    ok(res, base);
  } catch (err) { next(err); }
}

/** K线：period=<分钟>m（跟随撮合周期，如 10m / 2m） 或 1d，limit 数量 */
export async function kline(req, res, next) {
  try {
    const id = Number(req.params.id);
    const raw = String(req.query.period || '');
    // 允许 NNm（1~1440 分钟）与 1d；非法值回落到当前撮合周期档位
    const period = /^\d{1,4}m$/.test(raw) || raw === '1d' ? raw : klinePeriod();
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const stock = await Stock.findByPk(id);
    if (!stock) throw notFound('股票不存在');

    const rows = await PriceHistory.findAll({
      where: { stockId: id, period },
      order: [['ts', 'DESC']],
      limit,
      raw: true,
    });
    rows.reverse();
    ok(res, rows.map((r) => ({
      ts: r.ts,
      open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close),
      volume: Number(r.volume) || 0,
    })));
  } catch (err) { next(err); }
}

/** 盘口：聚合未成交限价挂单（近似买卖五档），数据来自撮合队列 */
export async function orderBook(req, res, next) {
  try {
    const id = Number(req.params.id);
    const stock = await Stock.findByPk(id);
    if (!stock) throw notFound('股票不存在');
    const pending = await Order.findAll({
      where: { stockId: id, status: 'PENDING', type: 'LIMIT', price: { [Op.not]: null } },
      attributes: ['side', 'price', 'quantity'],
      raw: true,
    });
    const agg = (side) => {
      const m = new Map();
      for (const o of pending.filter((x) => x.side === side)) {
        m.set(Number(o.price), (m.get(Number(o.price)) || 0) + o.quantity);
      }
      return [...m.entries()].map(([price, qty]) => ({ price, qty }))
        .sort((a, b) => (side === 'BUY' ? b.price - a.price : a.price - b.price));
    };
    ok(res, { price: toNum(stock.price), bids: agg('BUY').slice(0, 10), asks: agg('SELL').slice(0, 10) });
  } catch (err) { next(err); }
}

/** 个股相关新闻（含投票聚合） */
export async function stockNews(req, res, next) {
  try {
    const id = Number(req.params.id);
    const stock = await Stock.findByPk(id);
    if (!stock) throw notFound('股票不存在');
    const links = await NewsStock.findAll({ where: { stockId: id } });
    const newsIds = links.map((l) => l.newsId);
    if (!newsIds.length) return ok(res, []);

    const newsRows = await News.findAll({
      where: { id: { [Op.in]: newsIds } },
      include: [{ model: User, as: 'publisher', attributes: ['id', 'nickname'] }],
      order: [['createdAt', 'DESC']],
      raw: true,
      nest: true,
    });
    const votes = await Vote.findAll({ where: { targetType: 'NEWS', targetId: { [Op.in]: newsIds } }, raw: true });
    const items = newsRows.map((n) => {
      const v = votes.filter((x) => x.targetId === n.id);
      return decorateNews(n, v);
    });
    ok(res, items);
  } catch (err) { next(err); }
}

export function decorateNews(n, votes = []) {
  const upCount = votes.filter((v) => v.direction === 'UP').length;
  const downCount = votes.filter((v) => v.direction === 'DOWN').length;
  const mults = votes.map((v) => toNum(v.multiplier));
  const avgMult = mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : 1;
  const score = votes.length ? newsScore(n, votes) : null;
  return {
    id: n.id,
    title: n.title,
    content: n.content,            // 兼容旧数据摘要；新发布为空
    sourceUrl: n.sourceUrl || null, // 新闻来源链接
    direction: n.direction,
    strength: n.strength,
    publisher: n.publisher?.nickname || n.publisherNickname || null,
    publisherId: n.publisherId,
    expiresAt: n.expiresAt,
    createdAt: n.createdAt,
    votes: { up: upCount, down: downCount, total: votes.length, avgMult: round2(avgMult), score: score == null ? null : round2(score) },
  };
}

/** 自选操作：GET 列表 / PUT 添加 / DELETE 移除 */
export async function watchlist(req, res, next) {
  try {
    const rows = await Watchlist.findAll({
      where: { userId: req.user.id },
      include: [{ model: Stock, as: 'stock' }],
    });
    const stocks = rows.filter((r) => r.stock).map((r) => r.stock);
    stocks.forEach((s) => { s.__watched = true; });
    ok(res, stocks.map((s) => decorateStock(s)));
  } catch (err) { next(err); }
}

export async function addWatch(req, res, next) {
  try {
    const stockId = Number(req.params.stockId);
    const stock = await Stock.findByPk(stockId);
    if (!stock) throw notFound('股票不存在');
    await Watchlist.findOrCreate({ where: { userId: req.user.id, stockId } });
    ok(res, { stockId }, '已加入自选');
  } catch (err) { next(err); }
}

export async function removeWatch(req, res, next) {
  try {
    const stockId = Number(req.params.stockId);
    await Watchlist.destroy({ where: { userId: req.user.id, stockId } });
    ok(res, { stockId }, '已移出自选');
  } catch (err) { next(err); }
}

export function assertPeriod(p) {
  if (p && !['10m', '1d'].includes(p)) throw badRequest('period 仅支持 10m / 1d');
}
