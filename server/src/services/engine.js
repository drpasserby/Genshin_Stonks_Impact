import { Op } from 'sequelize';
import sequelize from '../config/db.js';
import { News, NewsStock, Vote, MarketSentiment } from '../models/index.js';
import config from '../config/index.js';
import { getRuntime } from './settingService.js';
import { roundPrice, toNum } from '../utils/money.js';
import logger from '../utils/logger.js';

/**
 * ==================== 价格引擎 ====================
 *
 * 完整公式与设计原理见 docs/PRICING.md，这里只列关键点：
 *
 * 【角色股 STOCK】
 *   涨跌幅 = clamp( (wP×压力 + wN×新闻 + wV×投票 + wS×市场情绪 + wI×基金传导)
 *                   × 基础波动率, ±单周期限幅 )
 *     压力     = clamp(净买入 / 总股本 × 压力灵敏度)
 *     新闻     = clamp( avg(方向 × 强度/100 × 投票倍率) )              ← 人工引用 + 投票
 *     市场情绪 = clamp( avg(方向 × 强度/100) )                        ← 社交平台自动抓取快照
 *     基金传导 = clamp( Σ 关联基金的压力 × 该角色在基金中的权重占比 )   ← 一期新增
 *
 * 【指数基金 FUND】
 *   情绪   = clamp( 压力 + (新闻×wN + 投票×wV + 市场情绪×wS) / wP )
 *   溢价   = clamp( 情绪 × 基金溢价系数, ±0.3 )
 *   目标价 = 净值NAV × (1 + 溢价)
 *   涨跌幅 = clamp( (目标价 / 当前价 − 1) × 跟踪速度, ±单周期限幅 )
 *   —— 这是「一阶滞后滤波」，数学上必然收敛，不会震荡或发散。
 *
 * 【性能】loadFactorsBatch 用 4~6 条 SQL 取回全部标的的新闻/投票/情绪因子，
 *   替代原先「每个标的 4 条查询」的 N+1 写法（127 只股票 = 508 条 → 5 条）。
 */

/** 限幅 [-1,1]（可传自定义上下限） */
export const clamp = (v, min = -1, max = 1) => Math.min(max, Math.max(min, v));
const signOf = (d) => (d === 'UP' ? 1 : -1);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * 因子快照：一次性取回单个标的相关的有效新闻与近期投票。
 * @param {number} stockId
 * @param {Date} windowStart 股票级投票的有效起点（默认：最近 NEWS_TTL 时长内）
 */
export async function loadFactors(stockId, windowStart = null) {
  const map = await loadFactorsBatch([stockId], windowStart);
  return map.get(Number(stockId)) || { news: [], newsVotes: [], stockVotes: [] };
}

/**
 * 批量因子快照：一次取回多个标的的新闻/投票/市场情绪因子。
 *
 * 只用 5~6 条 SQL：
 *   ① 标的↔新闻关联（news_stocks）
 *   ② 未过期新闻
 *   ③ 这些新闻的投票
 *   ④ 这些标的的股票级投票（窗口内）
 *   ⑤ 标的↔市场情绪关联（market_sentiment_stocks）
 *   ⑥ 未过期的市场情绪（按「审核前是否生效」开关决定要不要过滤 review_status）
 * 之后全部在内存里按标的分组。
 *
 * @param {number[]} stockIds
 * @returns {Promise<Map<number, {news:object[], newsVotes:object[], stockVotes:object[], sentiments:object[]}>>}
 */
export async function loadFactorsBatch(stockIds, windowStart = null) {
  const ids = [...new Set((stockIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const map = new Map();
  for (const id of ids) map.set(id, { news: [], newsVotes: [], stockVotes: [], sentiments: [] });
  if (!ids.length) return map;

  const now = new Date();
  if (!windowStart) {
    const rt = getRuntime();
    windowStart = new Date(now.getTime() - rt.newsTtlCycles * rt.cycleMinutes * 60 * 1000);
  }

  // ① 标的 ↔ 新闻
  const links = await NewsStock.findAll({ where: { stockId: { [Op.in]: ids } }, raw: true });
  const newsIds = [...new Set(links.map((l) => Number(l.newsId)))];

  // ② 未过期新闻
  //    ★ 只取「已通过审核」的新闻（reviewStatus='APPROVED'）：
  //      普通操作员发布的新闻在审核通过前是待审状态，绝不能影响股价。
  //      待审新闻的 expiresAt 为 NULL（有效期从审核通过时刻起算），
  //      所以必须显式按 reviewStatus 过滤 —— 只看 expiresAt 会把待审新闻当成永久有效。
  const newsRows = newsIds.length
    ? await News.findAll({
        where: {
          id: { [Op.in]: newsIds },
          reviewStatus: 'APPROVED',
          expiresAt: { [Op.or]: [{ [Op.is]: null }, { [Op.gt]: now }] },
        },
        raw: true,
      })
    : [];
  // ★ 影响衰减：把「一通过就满强度、到期瞬间归零」的阶跃改成斜坡。
  //   窗口 = [发布时间, expires_at]；开关见控制面板 impact_linear_decay（默认开）。
  const decayOn = getRuntime().impactLinearDecay !== false;
  for (const n of newsRows) {
    n._decay = decayOn ? linearDecay(n.createdAt, n.expiresAt, now.getTime()) : 1;
  }

  const liveNewsIds = newsRows.map((n) => Number(n.id));
  const newsById = new Map(newsRows.map((n) => [Number(n.id), n]));

  // ③ 新闻投票
  const newsVotes = liveNewsIds.length
    ? await Vote.findAll({ where: { targetType: 'NEWS', targetId: { [Op.in]: liveNewsIds } }, raw: true })
    : [];
  const votesByNews = new Map();
  for (const v of newsVotes) {
    const k = Number(v.targetId);
    if (!votesByNews.has(k)) votesByNews.set(k, []);
    votesByNews.get(k).push(v);
  }

  // ④ 标的自身的股票级投票（窗口内）
  const stockVotes = await Vote.findAll({
    where: { targetType: 'STOCK', targetId: { [Op.in]: ids }, createdAt: { [Op.gte]: windowStart } },
    raw: true,
  });

  // ⑤⑥ 市场情绪（社交平台情绪快照）
  //   ★ 审核前的取舍由面板开关 sentiment_before_review 决定：
  //     开（默认）→ 待审情绪也参与定价（审核只拦「是否对外发布」，不拦价格影响）；
  //     关        → 与新闻同口径，必须 APPROVED 才生效。
  const sentimentRows = await loadSentimentRows(ids, now);
  const sentiById = new Map(sentimentRows.map((s) => [Number(s.id), s]));
  const sentiLinks = sentiById.size
    ? await sequelize.query(
        'SELECT sentiment_id, stock_id FROM market_sentiment_stocks WHERE sentiment_id IN (?)',
        { replacements: [[...sentiById.keys()]], type: sequelize.QueryTypes.SELECT },
      ).catch(() => [])
    : [];
  for (const l of sentiLinks) {
    const entry = map.get(Number(l.stock_id));
    const s = sentiById.get(Number(l.sentiment_id));
    if (entry && s) entry.sentiments.push(s);
  }

  // 内存分组
  for (const l of links) {
    const sid = Number(l.stockId);
    const entry = map.get(sid);
    const n = newsById.get(Number(l.newsId));
    if (entry && n) entry.news.push(n);
  }
  for (const [sid, entry] of map) {
    for (const n of entry.news) {
      const vs = votesByNews.get(Number(n.id));
      if (vs) entry.newsVotes.push(...vs);
    }
  }
  for (const v of stockVotes) {
    const entry = map.get(Number(v.targetId));
    if (entry) entry.stockVotes.push(v);
  }
  return map;
}

/**
 * 取「仍在时效内」的市场情绪行。
 * 时效口径：`market_sentiment_decay_hours`（默认 72 小时，可在控制面板调）。
 * 之所以不套用新闻的 news_ttl_cycles：情绪是快照、更新更频繁，
 * 用固定小时数更好理解，也不会被「撮合周期」改动连带影响。
 */
async function loadSentimentRows(stockIds, now) {
  const rt = getRuntime();
  const beforeReview = rt.sentimentBeforeReview !== false;
  const hours = Number(rt.sentimentDecayHours) > 0 ? Number(rt.sentimentDecayHours) : 72;
  const since = new Date(now.getTime() - hours * 3600 * 1000);

  // 先取「与这些标的有关系的情绪 id」，避免把全表情绪都读进来。
  // 用原生 SQL 查关联表：belongsToMany 的 through 是字符串形式，隐式模型没有显式属性，
  // 直接查 statement 更确定，也省掉一次 JOIN。
  const links = await sequelize.query(
    'SELECT DISTINCT sentiment_id FROM market_sentiment_stocks WHERE stock_id IN (?)',
    { replacements: [stockIds], type: sequelize.QueryTypes.SELECT },
  ).catch((err) => {
    // 关联表缺失时（迁移没跑）不应让整个撮合周期崩掉：记账并按「无情绪」处理
    logger.warn('读取市场情绪关联失败，本周期按无情绪处理', { detail: err.message });
    return [];
  });
  const ids = links.map((r) => Number(r.sentiment_id)).filter(Boolean);
  if (!ids.length) return [];

  const where = { id: { [Op.in]: ids }, fetchedAt: { [Op.gte]: since } };
  if (!beforeReview) where.reviewStatus = 'APPROVED';
  else where.reviewStatus = { [Op.in]: ['PENDING', 'APPROVED'] };   // 待审也生效；已驳回的永不生效
  const rows = await MarketSentiment.findAll({ where, raw: true });

  // ★ 影响衰减：情绪是「抓取时刻起算 N 小时」，窗口内从满强度线性降到 0（详见 linearDecay 注释）
  const decayOn = rt.impactLinearDecay !== false;
  const windowMs = hours * 3600 * 1000;
  return rows.map((r) => ({
    ...r,
    _decay: decayOn
      ? linearDecay(r.fetchedAt, new Date(new Date(r.fetchedAt).getTime() + windowMs), now.getTime())
      : 1,
  }));
}

/** 由因子快照算出 新闻因子 / 投票因子 / 市场情绪因子（两个标的类型共用） */
export function computeFactors(raw) {
  let newsFactor = 0;
  if (raw.news?.length) {
    const scores = raw.news.map((n) => {
      const votes = (raw.newsVotes || []).filter((v) => Number(v.targetId) === Number(n.id));
      return newsScore(n, votes);
    });
    newsFactor = clamp(avg(scores));
  }

  let voteFactor = 0;
  if (raw.stockVotes?.length) {
    const dir = avg(raw.stockVotes.map((v) => signOf(v.direction)));
    const mult = avg(raw.stockVotes.map((v) => toNum(v.multiplier)));
    voteFactor = clamp(dir * mult);
  }

  // 市场情绪因子：把该标的关联到的每条情绪的「方向 × 强度/100」取平均再 clamp。
  // 口径与新闻因子**完全一致**（都是「方向 ±1 × 强度/100，多条取平均」），
  // 所以两者可以直接相加、也可以互相比较权重，不需要任何换算。
  // 之所以不读 news_impact 那种「逐实体 impact_value」：情绪是按方向成行的快照
  // （同一行关联多个角色），逐实体精度留给新闻侧，这里保持与新闻同量纲更重要。
  let sentimentFactor = 0;
  if (raw.sentiments?.length) {
    sentimentFactor = clamp(avg(raw.sentiments.map(sentimentScore)));
  }

  return { newsFactor, voteFactor, sentimentFactor };
}

/** 由本周期成交量算出「用户压力因子」（基金与股票同一套口径） */
export function computePressureFactor(buyVol, sellVol, totalShares) {
  const { pressureGain } = config.business;
  const netBuy = Number(buyVol || 0) - Number(sellVol || 0);
  const shares = Number(totalShares) || 1;
  return clamp((netBuy / shares) * pressureGain);
}

/**
 * 计算角色股下一周期价格。
 * @param {number} price 当前价
 * @param {object} cycle 本周期交易统计 { buyVol, sellVol, totalShares }
 * @param {object} raw   loadFactorsBatch 的结果，额外可带 influence（基金传导因子）
 */
export async function computePrice(stockId, price, cycle, raw) {
  const { weightPressure, weightNews, weightVote } = config.business;
  const { baseVolatility, maxChange, fundInfluenceWeight, weightSentiment } = getRuntime();

  const pressureFactor = computePressureFactor(cycle.buyVol, cycle.sellVol, cycle.totalShares);
  const { newsFactor, voteFactor, sentimentFactor } = computeFactors(raw);
  // 基金传导：由周期任务预先算好（Σ 关联基金压力 × 权重占比），已 clamp 到 ±1
  const influenceFactor = clamp(Number(raw.influence) || 0);

  // 市场情绪（社交平台快照）独立成一档 wS，与新闻因子并列而不是合并进去：
  // 两者数据来源与更新频率都不同（新闻=人工引用+投票；情绪=自动抓取+审核），
  // 分开算以后要单独调权/单独排查都方便。
  const weighted =
    weightPressure * pressureFactor +
    weightNews * newsFactor +
    weightVote * voteFactor +
    weightSentiment * sentimentFactor +
    fundInfluenceWeight * influenceFactor;

  const changePct = clamp(weighted * baseVolatility, -maxChange, maxChange);
  let nextPrice = roundPrice(toNum(price) * (1 + changePct));
  if (nextPrice < 0.0001) nextPrice = 0.0001;

  return {
    nextPrice,
    changePct,
    factors: {
      pressure: round4(pressureFactor),
      news: round4(newsFactor),
      vote: round4(voteFactor),
      sentiment: round4(sentimentFactor),
      influence: round4(influenceFactor),
      netBuy: Number(cycle.buyVol || 0) - Number(cycle.sellVol || 0),
      buyVol: Number(cycle.buyVol || 0),
      sellVol: Number(cycle.sellVol || 0),
    },
  };
}

/**
 * 计算指数基金下一周期价格：向「净值 × (1+溢价)」做一阶滞后收敛。
 *
 * 稳定性：nextPrice = price + (target − price) × k，其中 0 < k ≤ 1，
 * 等价于误差每轮乘以 (1−k)，|1−k| < 1 ⇒ 无论 target 怎么跳，价格必然收敛不发散。
 * 溢价本身由当期情绪重算（不落库），新闻过期/压力消失后溢价自动归零，
 * 价格随即回到净值 —— 这是「指数跟踪」的固有行为，也让基金难以被长期拉离净值。
 *
 * @param {number} price 基金当前价
 * @param {number} nav   成分股加权净值（由周期任务用成分股新价算出）
 * @param {object} f     { pressureFactor, newsFactor, voteFactor }
 */
export function computeFundPrice(price, nav, f) {
  const { maxChange, fundTrackingRate, fundPremiumGain, weightSentiment } = getRuntime();
  const { weightPressure, weightNews, weightVote } = config.business;

  // 把四因子折算到「压力等价」量纲：情绪 = 压力 + (新闻×wN + 投票×wV + 舆情×wS)/wP
  const wP = weightPressure || 0.5;
  const sentiment = clamp(
    Number(f.pressureFactor || 0)
    + (Number(f.newsFactor || 0) * weightNews
       + Number(f.voteFactor || 0) * weightVote
       + Number(f.sentimentFactor || 0) * weightSentiment) / wP
  );
  const premium = clamp(sentiment * fundPremiumGain, -0.3, 0.3);

  const navVal = toNum(nav);
  const priceVal = toNum(price);
  const target = roundPrice(navVal * (1 + premium));
  const rawChange = priceVal > 0 ? (target - priceVal) / priceVal : 0;
  const changePct = clamp(rawChange * fundTrackingRate, -maxChange, maxChange);
  let nextPrice = roundPrice(priceVal * (1 + changePct));
  if (nextPrice < 0.0001) nextPrice = 0.0001;

  return {
    nextPrice,
    nav: navVal,
    changePct,
    factors: {
      pressure: round4(Number(f.pressureFactor || 0)),
      news: round4(Number(f.newsFactor || 0)),
      vote: round4(Number(f.voteFactor || 0)),
      sentimentFactor: round4(Number(f.sentimentFactor || 0)),
      sentiment: round4(sentiment),
      premium: round4(premium),
      nav: navVal,
      target,
    },
  };
}

/**
 * 基金传导图：算出「每个成分股受到的基金压力」。
 *   influence[stock] = clamp( Σ_funds( 基金压力 × 该股在基金中的权重占比 ) )
 *
 * 只考虑「本周期真的有净买卖」的基金（无活动直接跳过整段计算）。
 *
 * @param {Array<{fundId:number, pressure:number}>} fundPressures
 * @param {Map<number, Array<{constituentId:number, weight:number}>>} graph 基金 → 成分
 * @returns {Map<number, number>}
 */
export function buildInfluenceMap(fundPressures, graph) {
  const influence = new Map();
  for (const { fundId, pressure } of fundPressures) {
    if (!pressure) continue;
    const list = graph.get(Number(fundId));
    if (!list || !list.length) continue;
    const total = list.reduce((s, x) => s + (Number(x.weight) || 0), 0);
    if (total <= 0) continue;
    for (const c of list) {
      const share = (Number(c.weight) || 0) / total;
      const cid = Number(c.constituentId);
      influence.set(cid, (influence.get(cid) || 0) + pressure * share);
    }
  }
  for (const [k, v] of influence) influence.set(k, clamp(v));
  return influence;
}

/**
 * ============ 影响衰减（2026-09-15 新增） ============
 *
 * 为什么需要：新闻/市场情绪的因子是**阶跃**的 —— 一通过就是满强度，
 * 一直恒定到有效期结束、然后瞬间归零。表现到 K 线上就是
 * 「突然出现一条固定斜率的直线斜坡，3 小时后又突然断掉」，
 * 而且全程**没有成交量**，玩家看着像凭空被抬走（实测钟离 3 小时 +5.56%、124 轮全部零成交）。
 *
 * 改成**线性衰减**后：刚生效时最强，之后每轮按比例变弱，到期自然归零 ——
 * 台阶变成斜坡，曲线是弧线而不是直线。
 * 开关：控制面板 `impact_linear_decay`（默认开）；关掉即回到原来的恒定强度。
 *
 * 参数含义：窗口 [start, end]，返回 1 → 0 的线性系数（窗口外为 0）。
 *   · 新闻：start = 发布时间，end = expires_at（= 审核通过时刻 + TTL）
 *   · 情绪：start = fetched_at，end = fetched_at + sentiment_decay_hours
 */
function linearDecay(startAt, endAt, nowMs) {
  const s = new Date(startAt).getTime();
  const e = new Date(endAt).getTime();
  // 时间字段缺失/非法时不衰减（宁可保持原行为，也不要把它算成 0）
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 1;
  const total = e - s;
  const elapsed = Math.min(Math.max(nowMs - s, 0), total);
  return 1 - elapsed / total;
}

/** 取预先算好的衰减系数（没有就按 1，保证未接衰减的调用方行为不变） */
const decayOf = (o) => (o && o._decay != null ? Number(o._decay) : 1);

/** 单条新闻影响分：方向(±1) × 强度(0~100)/100 × 投票平均倍率(无票则 1) × 衰减，限幅 */
export function newsScore(news, votes = []) {
  const dirs = votes.map((v) => signOf(v.direction));
  const mults = votes.map((v) => toNum(v.multiplier));
  const dir = dirs.length ? avg(dirs) : signOf(news.direction);
  const mult = mults.length ? avg(mults) : 1;
  return clamp(dir * mult * (Number(news.strength) / 100) * decayOf(news));
}

/**
 * 单条市场情绪影响分：方向(±1) × 强度(0~100)/100 × 衰减。
 * 与 newsScore 的差别只有一个：情绪没有投票，所以没有倍率项。
 */
export function sentimentScore(s) {
  return clamp(signOf(s.direction) * (toNum(s.strength) / 100) * decayOf(s));
}

export { avg, signOf, round4 };
