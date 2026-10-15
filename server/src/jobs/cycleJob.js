import { Op } from 'sequelize';
import sequelize from '../config/db.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Stock, Trade, PriceHistory, FundConstituent } from '../models/index.js';
import { settleStock, isTradingOpen } from '../services/tradingService.js';
import {
  computePrice, computeFundPrice, computeFactors, computePressureFactor,
  buildInfluenceMap, loadFactorsBatch,
} from '../services/engine.js';
import { getRuntime, refreshRuntime, klinePeriod } from '../services/settingService.js';
import { rankDue, refreshRankSnapshot } from '../services/rankService.js';
import { roundPrice, toNum } from '../utils/money.js';

/**
 * ============ 周期调度器（每 cycle_minutes 分钟一轮） ============
 * 一轮任务分三个阶段（同一进程内串行，避免统计窗口错乱）：
 *   P1 撮合：对每只股票撮合可成交的限价挂单（成交价 = 撮合时当前股价）
 *   P2 统计：统计 (prevRunAt, now] 窗口内成交的买卖量（含本轮的撮合成交）
 *   P3 估价：按 压力因子/新闻因子/投票因子 计算新股价并落周期 K 线
 * 每日 DAILY_CLOSE_HOUR:00（默认 15:00，本地时区）收盘：
 *   以当天最后一根周期 K 的收盘价为当日收盘价生成 1d K 线，
 *   随后重置股票行情字段：昨收=收盘价、今开=收盘价、最高/最低/量归零。
 *
 * 周期长度可在 root 控制面板在线调整（cycle_minutes）：
 *   · tick 每轮都会 refreshRuntime()，价格引擎立即用新参数
 *   · 看门狗每 30 秒检查一次，周期变了就重建 setInterval（无需重启进程）
 *   · K 线档位标签跟随周期变化（period = `${cycleMinutes}m`），历史档位保留
 *
 * 约定与限制：
 * - 交易日定义为「上次收盘时刻 → 本次收盘时刻」（近似 24h），连续运行；
 * - 成交量口径：每笔成交的股数（买卖双边各自计一次）累加；
 * - 必须保证单实例运行（PM2 不启用 cluster），否则重复撮合/重复计K。
 */

let jobTimer = null;
let jobIntervalMinutes = null;
let watchdog = null;
let running = false;
let prevRunAt = null; // 上一轮任务结束时刻（统计窗口下界）
let lastCloseDate = ''; // 已完成收盘的日期 YYYY-MM-DD

/** 当前周期起点：本地 0 点起按周期对齐网格 */
export function cycleStartMs(now = Date.now()) {
  const minutes = getRuntime().cycleMinutes;
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return dayStart + Math.floor((now - dayStart) / (minutes * 60000)) * minutes * 60000;
}

const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** P2：统计 (prev, now] 窗口内各股票买卖量 */
async function collectCycleStats(prev, now) {
  const rows = await Trade.findAll({
    attributes: [
      'stockId',
      [sequelize.literal("SUM(CASE WHEN side='BUY' THEN quantity ELSE 0 END)"), 'buyVol'],
      [sequelize.literal("SUM(CASE WHEN side='SELL' THEN quantity ELSE 0 END)"), 'sellVol'],
    ],
    where: { matchedAt: { [Op.gt]: new Date(prev), [Op.lte]: new Date(now) } },
    group: ['stockId'],
    raw: true,
  });
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.stockId), { buyVol: Number(r.buyVol) || 0, sellVol: Number(r.sellVol) || 0 });
  }
  return map;
}

/** upsert K 线：同一 (stock, period, ts) 只保留一条 */
export async function writeKline(stockId, period, ts, { open, high, low, close }, volume) {
  const values = {
    open: roundPrice(open), high: roundPrice(high), low: roundPrice(low),
    close: roundPrice(close), volume: Number(volume) || 0,
  };
  const [row] = await PriceHistory.findOrCreate({
    where: { stockId, period, ts: new Date(ts) },
    defaults: { stockId, period, ts: new Date(ts), ...values },
  });
  const changed =
    toNum(row.open) !== values.open || toNum(row.high) !== values.high ||
    toNum(row.low) !== values.low || toNum(row.close) !== values.close ||
    Number(row.volume) !== values.volume;
  if (changed) {
    row.open = values.open; row.high = values.high; row.low = values.low;
    row.close = values.close; row.volume = values.volume;
    await row.save();
  }
  return row;
}

/** P1：逐股票撮合挂单 */
async function settleAll(stockIds) {
  for (const id of stockIds) {
    await sequelize.transaction(
      { retry: { max: 3 } },
      async (t) => {
        await settleStock(t, id);
      }
    );
  }
}

/* ---------------- 基金成分图（内存缓存，改动时失效） ---------------- */

let graphCache = { at: 0, map: null };
const GRAPH_TTL = 60 * 1000;

/** 管理端增删改基金成分后调用，立即失效缓存 */
export function invalidateFundGraph() {
  graphCache = { at: 0, map: null };
}

/**
 * 读取全部「基金 → 成分股+权重」关系。
 * 关联关系变更极少，所以整张图缓存在内存里，每轮结算最多一条 SQL（多数轮次 0 条）。
 * @returns {Promise<Map<number, Array<{constituentId:number, weight:number}>>>}
 */
async function loadFundGraph() {
  if (graphCache.map && Date.now() - graphCache.at < GRAPH_TTL) return graphCache.map;
  const rows = await FundConstituent.findAll({ raw: true });
  const map = new Map();
  for (const r of rows) {
    const fid = Number(r.fundId);
    if (!map.has(fid)) map.set(fid, []);
    map.get(fid).push({ constituentId: Number(r.constituentId), weight: Number(r.weight) || 0 });
  }
  graphCache = { at: Date.now(), map };
  return map;
}

/**
 * P3：计算所有标的新价 → 批量落库（单事务）。
 *
 * 一期内严格两段，天然无环：
 *   ① 先算全部角色股（用「本周期基金压力」作为传导因子，压力只依赖成交量，不依赖价格）
 *   ② 再用「角色股新价」算基金净值 NAV，最后算基金新价
 *
 * 性能对比（157 个标的）：
 *   旧：157 个事务 × (4 条因子 SQL + 1 次 save + 1 次 K 线 upsert) ≈ 940 条 SQL / 157 次提交
 *   新：4 条因子 SQL + 1 次批量 K 线 + 157 条 UPDATE / 1 次提交
 */
async function recomputeAll(stats) {
  const rt = getRuntime();
  // 已退市（status=2）不参与定价：价格冻结、不落 K 线、不计入基金净值
  const entities = (await Stock.findAll({ order: [['id', 'ASC']] }))
    .filter((e) => Number(e.status ?? 1) !== 2);
  if (!entities.length) return;

  const stockEntities = entities.filter((e) => e.type !== 'FUND');
  const fundEntities = entities.filter((e) => e.type === 'FUND');
  const windowStart = cycleStartMs(Date.now());
  const period = klinePeriod();

  // ① 批量因子（4 条 SQL，替代原来的 N+1）
  const factorsMap = await loadFactorsBatch(entities.map((e) => Number(e.id)));

  // ② 各标的压力 + 基金传导图
  const pressures = new Map();
  const fundPressures = [];
  for (const e of entities) {
    const c = stats.get(Number(e.id)) || { buyVol: 0, sellVol: 0 };
    const p = computePressureFactor(c.buyVol, c.sellVol, e.totalShares);
    pressures.set(Number(e.id), p);
    if (e.type === 'FUND') fundPressures.push({ fundId: Number(e.id), pressure: rt.fundEnabled ? p : 0 });
  }
  const fundGraph = (rt.fundEnabled && fundEntities.length) ? await loadFundGraph() : new Map();
  const influenceMap = rt.fundEnabled ? buildInfluenceMap(fundPressures, fundGraph) : new Map();

  // ③ 定价：角色股 → 基金（价格表边算边更新，基金 NAV 用的就是本轮新价）
  const priceById = new Map(entities.map((e) => [Number(e.id), toNum(e.price)]));
  const results = new Map();

  for (const s of stockEntities) {
    const id = Number(s.id);
    const c = stats.get(id) || { buyVol: 0, sellVol: 0 };
    const raw = factorsMap.get(id) || { news: [], newsVotes: [], stockVotes: [], sentiments: [] };
    raw.influence = influenceMap.get(id) || 0;   // 基金传导因子
    const r = await computePrice(id, s.price, { ...c, totalShares: s.totalShares }, raw);
    results.set(id, r);
    priceById.set(id, r.nextPrice);
  }

  for (const f of fundEntities) {
    const id = Number(f.id);
    const list = fundGraph.get(id) || [];
    let nav;
    if (!list.length) {
      // 还没配成分股：净值退化为自身价格（价格只受自身情绪与溢价影响）
      nav = toNum(f.nav) || toNum(f.price);
    } else {
      const total = list.reduce((s, x) => s + (Number(x.weight) || 0), 0) || 1;
      nav = list.reduce(
        (s, x) => s + (Number(x.weight) || 0) * (priceById.get(Number(x.constituentId)) ?? toNum(f.price)),
        0
      ) / total;
    }
    const raw = factorsMap.get(id) || { news: [], newsVotes: [], stockVotes: [], sentiments: [] };
    const { newsFactor, voteFactor, sentimentFactor } = computeFactors(raw);
    const r = computeFundPrice(f.price, nav, {
      pressureFactor: pressures.get(id) || 0,
      newsFactor,
      voteFactor,
      sentimentFactor,
    });
    results.set(id, r);
    priceById.set(id, r.nextPrice);
  }

  // ④ 组织批量写入
  const klineRows = [];
  const updates = [];
  const sizes = new Map(entities.map((e) => [Number(e.id), e]));

  for (const e of entities) {
    const id = Number(e.id);
    const r = results.get(id);
    if (!r) continue;
    const prevPrice = toNum(e.price);
    const c = stats.get(id) || { buyVol: 0, sellVol: 0 };
    const nextPrice = r.nextPrice;

    updates.push({
      id,
      fields: {
        price: nextPrice,
        high: Math.max(toNum(e.high), nextPrice),
        low: Math.min(toNum(e.low), nextPrice),
        ...(e.type === 'FUND' ? { nav: r.nav ?? toNum(e.price) } : {}),
      },
    });
    klineRows.push({
      stockId: id,
      period,
      ts: new Date(windowStart),
      open: prevPrice,
      high: Math.max(prevPrice, nextPrice),
      low: Math.min(prevPrice, nextPrice),
      close: nextPrice,
      volume: (c.buyVol || 0) + (c.sellVol || 0),
    });

    if (e.type === 'FUND') {
      logger.info(
        `[周期] ${e.code} ${e.name}(基金): ${prevPrice} → ${nextPrice} ` +
        `(净值${r.factors.nav} 溢价${r.factors.premium} 压力${r.factors.pressure} 新闻${r.factors.news} ` +
        `投票${r.factors.vote} 情绪${r.factors.sentimentFactor})`
      );
    } else {
      logger.info(
        `[周期] ${e.code} ${e.name}: ${prevPrice} → ${nextPrice} ` +
        `(买${c.buyVol}/卖${c.sellVol} 压力${r.factors.pressure} 新闻${r.factors.news} ` +
        `投票${r.factors.vote} 情绪${r.factors.sentiment} 基金传导${r.factors.influence})`
      );
    }
  }

  // ⑤ 单事务提交：一次批量 K 线 + N 条 UPDATE
  await sequelize.transaction({ retry: { max: 3 } }, async (t) => {
    if (klineRows.length) {
      await PriceHistory.bulkCreate(klineRows, {
        updateOnDuplicate: ['open', 'high', 'low', 'close', 'volume'],
        transaction: t,
      });
    }
    for (const u of updates) {
      await Stock.update(u.fields, { where: { id: u.id }, transaction: t });
    }
  });

  void sizes;
}

/** 每日收盘（P4）：生成 1d K 线并重置日行情字段 */
async function dailyClose() {
  const stocks = await Stock.findAll({ order: [['id', 'ASC']] });
  const now = new Date();
  const closeTs = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(),
    config.business.dailyCloseHour, 0, 0
  );
  for (const s of stocks) {
    await sequelize.transaction(
      { retry: { max: 3 } },
      async (t) => {
        const stock = await Stock.findByPk(s.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!stock) return;
        const close = toNum(stock.price);
        await writeKline(stock.id, '1d', closeTs.getTime(), {
          open: toNum(stock.open),
          high: Math.max(toNum(stock.high), close),
          low: Math.min(toNum(stock.low), close),
          close,
        }, toNum(stock.volume));
        stock.prevClose = close; // 昨收 = 当日收盘
        stock.open = close;      // 今开 = 该收盘价（次日从该价起）
        stock.high = close;
        stock.low = close;
        stock.volume = 0;
        await stock.save({ transaction: t });
      }
    );
  }
  lastCloseDate = todayStr(now);
  logger.info(`[收盘] ${lastCloseDate} ${config.business.dailyCloseHour}:00 日K已生成 (${stocks.length} 只)`);
}

/**
 * 是否应执行每日收盘（幂等）：
 * - 本地时间已到/超过当日 DAILY_CLOSE_HOUR；
 * - 且当日(ts>=今日0点)尚未生成过任何 1d K 线（以 DB 为准，重启后也不会重复收盘）。
 */
async function shouldDailyClose(now = new Date()) {
  const cur = todayStr(now);
  if (lastCloseDate === cur) return false;
  const h = now.getHours();
  const m = now.getMinutes();
  const passed = h > config.business.dailyCloseHour || (h === config.business.dailyCloseHour && m >= 0);
  if (!passed) return false;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cnt = await PriceHistory.count({ where: { period: '1d', ts: { [Op.gte]: dayStart } } });
  return cnt === 0;
}

/* ---------------- K 线保留策略（防止 price_history 无限膨胀） ---------------- */

/**
 * 为什么需要：131 个标的 × 144 轮/天 = 约 1.9 万行/天（约 57 万行/月、680 万行/年），
 * 而生产 InnoDB 缓冲池只有 48MB —— 一年后光索引就 1GB 以上，任何「扫历史」的查询
 * （例如盈亏报表的期初价）都会退化成磁盘随机读。
 *
 * 策略：
 *   · 只保留最近 kline_retention_days 天（默认 21）的**周期线**（period <> '1d'）；
 *   · **日线永久保留**（131 行/天，一年 4.8 万行，可忽略）—— 长周期行情图不受影响；
 *   · 保留期必须 ≥ 盈亏报表的最大窗口（14 天），否则期初价会失准；
 *   · 每天 04:00 之后第一次 tick 执行，分批删除并在批间让出 I/O，避免长事务压住 2 核小机器。
 */
const RETENTION_HOUR = 4;          // 每天 04:00 之后执行
const RETENTION_BATCH = 5000;      // 每批删除行数
const RETENTION_MAX_BATCHES = 400; // 单次上限 200 万行，兜住异常情况
let lastRetentionDate = '';

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 今天该不该跑清理（0 天 = 关闭；每天只跑一次） */
function shouldRunKlineRetention(now = new Date()) {
  const days = Math.floor(getRuntime().klineRetentionDays || 0);
  if (!(days > 0)) return false;
  if (lastRetentionDate === todayStr(now)) return false;
  return now.getHours() >= RETENTION_HOUR;
}

/** 分批清理过期周期 K 线；返回删除行数（供日志/手工调用） */
export async function runKlineRetention() {
  const days = Math.floor(getRuntime().klineRetentionDays || 0);
  if (!(days > 0)) return { deleted: 0, days, skipped: true };
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  let deleted = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const [, meta] = await sequelize.query(
      'DELETE FROM price_history WHERE period <> ? AND ts < ? LIMIT ?',
      { replacements: ['1d', cutoff, RETENTION_BATCH] }
    );
    const n = Number(meta?.affectedRows ?? 0);
    deleted += n;
    if (n < RETENTION_BATCH) break; // 已删完
    await sleepMs(120);             // 让出磁盘 I/O，避免影响正在看盘的玩家
  }
  lastRetentionDate = todayStr();
  logger.info(`[K线保留] 已清理 ${deleted} 行过期周期线（保留最近 ${days} 天，日线永久保留）`);
  return { deleted, days, cutoff };
}

/** 单轮主任务 */
async function tick() {
  if (running) return; // 防重入
  running = true;
  try {
    // 每轮刷新运行时配置：控制面板改过的参数（波动率/限幅/新闻时长/交易开关）立即生效
    await refreshRuntime();

    const stocks = await Stock.findAll({ attributes: ['id', 'status'] });
    if (!stocks.length) return;
    // 只有 status=1（正常）的标的参与撮合；停牌(0)与退市(2)不撮合
    const tradableIds = stocks
      .filter((s) => Number(s.status ?? 1) === 1)
      .map((s) => Number(s.id));

    // 停市状态：不撮合任何挂单（保持冻结不动），价格仅按新闻/投票因子走、成交量恒为 0
    const tradingOpen = await isTradingOpen();
    if (tradingOpen && tradableIds.length) {
      // P1 撮合（成交时间落在本轮窗口内）
      await settleAll(tradableIds);
    } else if (!tradingOpen) {
      logger.info('[停市] 系统暂停交易，跳过本周期撮合');
    }

    // P2 统计窗口 (prevRunAt, now]，上界取撮合完成后的时刻，避免漏算本轮成交
    const nowBound = Date.now();
    const lower = prevRunAt ?? cycleStartMs(nowBound);
    const stats = await collectCycleStats(lower, nowBound);

    // P3 估价 + K线
    await recomputeAll(stats);

    // P3.5 排行榜快照：顺带在周期里算好并缓存到内存（前端每次查看都是读缓存，零额外开销）
    //      按 rank_interval_minutes 节流；控制面板关闭排行榜时 rankDue() 恒为 false
    if (rankDue()) await refreshRankSnapshot();

    // P4 每日收盘（幂等：以 DB 中当日 1d K 是否存在为准）
    if (await shouldDailyClose()) await dailyClose();

    // P5 每日维护：清理过期周期 K 线（日线永久保留；0 天表示关闭）
    if (shouldRunKlineRetention()) await runKlineRetention();
  } catch (err) {
    logger.error('周期任务异常: ' + (err.stack || err.message));
  } finally {
    prevRunAt = Date.now();
    running = false;
  }
}

/** 手动触发一轮结算（运维/测试用；调度器内部也用同一个入口） */
export async function runCycleOnce() {
  return tick();
}

/** 按当前周期长度重建定时器（周期没变则不动） */
function scheduleInterval() {
  const minutes = getRuntime().cycleMinutes;
  if (jobTimer && jobIntervalMinutes === minutes) return;
  if (jobTimer) clearInterval(jobTimer);
  jobIntervalMinutes = minutes;
  jobTimer = setInterval(() => tick(), minutes * 60 * 1000);
  logger.info(`[调度] 周期任务间隔 = ${minutes} 分钟`);
}

/** 启动：立即跑一轮热身，随后按周期网格 setInterval */
export function startCycleJob() {
  if (watchdog) return;
  logger.info(
    `[调度] 启动周期任务：每 ${getRuntime().cycleMinutes} 分钟一轮；每日 ${config.business.dailyCloseHour}:00 收盘`
  );
  tick();
  scheduleInterval();

  // 看门狗：管理员在控制面板改了「撮合周期」后自动重建定时器，无需重启进程
  watchdog = setInterval(async () => {
    try {
      await refreshRuntime();
      scheduleInterval();
      // 排行榜：管理员刚打开开关 / 调完频率后不必干等到下一个撮合周期（最多 30 秒内生效）
      if (rankDue()) await refreshRankSnapshot();
    } catch (err) {
      logger.warn('[调度] 检查周期配置失败: ' + err.message);
    }
  }, 30 * 1000);
  if (typeof watchdog.unref === 'function') watchdog.unref();
}

export function stopCycleJob() {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
    jobIntervalMinutes = null;
  }
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}
