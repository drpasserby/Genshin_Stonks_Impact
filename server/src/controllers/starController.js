import sequelize from '../config/db.js';
import { ok } from '../utils/response.js';
import { toNum, round2 } from '../utils/money.js';

/**
 * ============ 明星持仓公开页（公开接口，任何人可看） ============
 *
 * 为什么单独做：
 *   「明星」身份组的定义就是「权限同普通用户，但强制公开持仓」。
 *   明星是一张自愿接受的公开标签（由管理员赋予），因此这里公开的内容是明确的、
 *   有边界的：**标的 + 股数 + 市值 + 占总资产比例**。
 *
 * ⚠️ 故意不公开的内容（别顺手加回来）：
 *   · 成本价 / 浮动盈亏 / 平仓盈亏 —— 那等于公开每个人的买卖点与盈亏；
 *   · 现金余额 / 冻结摩拉 —— 资金规模看排行榜就够了，这里只给「占比」；
 *   · 用户 ID / 用户名 —— 与排行榜同一套隐私口径，对外只用昵称标识。
 *
 * 性能：明星是极少数账号，一次查询就能算完；再加 60 秒内存缓存（与排行榜同一思路），
 *      避免被反复刷。缓存不落库、进程重启即失效，无需任何清理。
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = { at: 0, data: null };

/** 清空缓存（管理员改完身份后由控制器调用；也可用于测试） */
export function invalidateStarCache() {
  cache = { at: 0, data: null };
}

/** 现算一次（不加缓存） */
async function computeStarHoldings() {
  const [stars] = await sequelize.query(
    `SELECT id, nickname, ROUND(mora + frozen_mora, 2) AS cash
       FROM users
      WHERE role = 'star' AND status = 1
      ORDER BY id ASC`
  );
  if (!stars.length) return { count: 0, list: [] };

  const ids = stars.map((s) => Number(s.id));
  const [positionRows] = await sequelize.query(
    `SELECT h.user_id AS userId, h.quantity AS quantity,
            s.id AS stockId, s.code AS code, s.name AS name, s.avatar_url AS avatarUrl,
            s.type AS type, s.status AS stockStatus, s.price AS price
       FROM holdings h
       JOIN stocks s ON s.id = h.stock_id
      WHERE h.user_id IN (:ids) AND h.quantity > 0`,
    { replacements: { ids } }
  );

  const byUser = new Map();
  for (const r of positionRows) {
    const uid = Number(r.userId);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push({
      stockId: Number(r.stockId),
      code: r.code,
      name: r.name,
      avatarUrl: r.avatarUrl ?? null,
      type: r.type,
      // 已退市的标的按最后价格保留展示（与「我的」持仓口径一致）
      delisted: Number(r.stockStatus ?? 1) === 2,
      quantity: Number(r.quantity) || 0,
      price: round2(toNum(r.price)),
      marketValue: round2((Number(r.quantity) || 0) * toNum(r.price)),
    });
  }

  const list = stars.map((s) => {
    const uid = Number(s.id);
    const holdings = (byUser.get(uid) || []).sort((a, b) => b.marketValue - a.marketValue);
    const totalMarketValue = round2(holdings.reduce((sum, h) => sum + h.marketValue, 0));
    // 总资产 = 可用+冻结摩拉 + 持仓市值（只用于算占比，不对外暴露金额）
    const totalAssets = round2(toNum(s.cash) + totalMarketValue);
    return {
      nickname: String(s.nickname ?? ''),
      holdingCount: holdings.length,
      totalMarketValue,
      holdings: holdings.map((h) => ({
        ...h,
        // 占总资产比例（%），保留两位小数；总资产为 0 时记 0
        weightPct: totalAssets > 0 ? Math.round((h.marketValue / totalAssets) * 10000) / 100 : 0,
      })),
    };
  });

  // 持仓市值高的明星排在前面（同为 0 则按原顺序，保持稳定）
  list.sort((a, b) => b.totalMarketValue - a.totalMarketValue);
  return { count: list.length, list };
}

/** 读取明星持仓（带 60 秒内存缓存） */
export async function getStarHoldings({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, cached: true };
  }
  const data = await computeStarHoldings();
  cache = { at: Date.now(), data };
  return { ...data, cached: false };
}

/** GET /api/stars —— 明星持仓公开列表 */
export async function starHoldings(req, res, next) {
  try {
    const data = await getStarHoldings({ force: req.query.refresh === '1' });
    ok(res, {
      count: data.count,
      list: data.list,
      updatedAt: new Date(cache.at || Date.now()),
      cacheSeconds: Math.round(CACHE_TTL_MS / 1000),
    });
  } catch (err) { next(err); }
}
