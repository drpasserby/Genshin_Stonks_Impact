import sequelize from '../config/db.js';
import logger from '../utils/logger.js';
import { getRuntime } from './settingService.js';

/**
 * ============ 排行榜（单一总资产榜） ============
 *
 * 设计要点（性能优先）：
 *   1) 绝不在「请求」里现算 —— 玩家每次打开排行榜都是读内存快照，数据库压力为 0。
 *   2) 快照由周期任务（cycleJob）顺带计算：每隔 rank_interval_minutes 分钟算一次，
 *      即 1 天最多 144 次聚合查询，而不是"每个玩家每次刷新各算一次"。
 *   3) 只取前 50 名（TOP_N），SQL 里 LIMIT 掉，不把全量用户拉回 Node 内存做排序。
 *   4) 单一进程内存缓存，PM2 fork 模式下与 rpm 限流同源，无需 Redis。
 *
 * 隐私：
 *   - 只有用户主动开启「参与排行榜」（users.rank_opt_in = 1）才会出现；
 *   - ★ 例外：明星（role='star'）是**强制公开**的账号，无论 rank_opt_in 如何都会上榜
 *     （用户中心里明星也无法关闭这个开关）；
 *   - 对外只返回 昵称 + 金额，**不返回用户 ID / 用户名**（按需求）。
 *
 * 口径（2026-09-18 合并）：
 *   原先分「资金榜」「市值榜」两个榜，现合并为**总资产榜**：
 *     总资产 = 可用摩拉(mora) + 挂单冻结摩拉(frozen_mora) + Σ(持仓股数 × 现价)
 *   三项都是玩家自己的钱，分开摆只会让人来回切 tab 对比，合并成一个数更直观。
 *   只统计 status=1（正常）的账号，已禁用与已注销不参与。
 */

export const RANK_TOP_N = 50;

/** 内存快照：at = 上次计算完成的时间戳(ms) */
let snapshot = {
  at: 0,
  list: [],
  participants: 0,
};

/** 同步读取快照（供控制器直接返回，零数据库开销） */
export function getRankSnapshot() {
  return {
    at: snapshot.at,
    list: snapshot.list,
    participants: snapshot.participants,
  };
}

/** 是否到了该重新计算的时间（关闭排行榜时永远返回 false） */
export function rankDue(now = Date.now()) {
  const rt = getRuntime();
  if (!rt.rankEnabled) return false;
  if (!snapshot.at) return true; // 进程刚启动，先算一次
  const intervalMs = Math.max(1, Number(rt.rankIntervalMinutes) || 10) * 60 * 1000;
  return now - snapshot.at >= intervalMs;
}

/**
 * 「是否上榜」的统一条件：
 *   正常账号 且（自愿参与排行榜 或 明星强制公开）。
 * 明星（role='star'）是公开身份，因此无论 rank_opt_in 如何都强制上榜。
 * ★ 下面两条查询必须使用同一份口径，否则名次与"共 N 人参与"会对不上。
 */

/**
 * 总资产榜。
 *
 * 为什么用 LEFT JOIN 子查询而不是直接 JOIN holdings：
 *   没有任何持仓的玩家（只持币）也必须出现在榜上，直接 JOIN 会把他们整行丢掉。
 *   子查询先按 user_id 聚合出市值，再左连回用户，既保证不漏人，又避免
 *   「用户 × 持仓」笛卡尔积后再聚合。
 *
 * 性能：holdings 走 user_id 索引、stocks 走主键，用户量级 100+ 时实测 < 20ms。
 */
async function queryAssetsTop() {
  const [rows] = await sequelize.query(
    `SELECT u.nickname AS nickname,
            ROUND(u.mora + u.frozen_mora + COALESCE(mv.amount, 0), 2) AS value
       FROM users u
       LEFT JOIN (
            SELECT h.user_id AS user_id, SUM(h.quantity * s.price) AS amount
              FROM holdings h
              JOIN stocks s ON s.id = h.stock_id
             WHERE h.quantity > 0
             GROUP BY h.user_id
            ) mv ON mv.user_id = u.id
      WHERE u.status = 1 AND (u.rank_opt_in = 1 OR u.role = 'star')
      ORDER BY value DESC, u.id ASC
      LIMIT ${RANK_TOP_N}`
  );
  return rows;
}

/** 参与人数（用于前端展示"共 N 人参与"） */
async function queryParticipantCount() {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
       FROM users
      WHERE status = 1 AND (rank_opt_in = 1 OR role = 'star')`
  );
  const r = rows[0] || {};
  return Number(r.cnt) || 0;
}

/** 给数组补上名次（并列也按下标顺序编号，保证名次唯一、便于前端展示） */
function withRank(rows) {
  return rows.map((r, i) => ({
    rank: i + 1,
    nickname: String(r.nickname ?? ''),
    value: Number(r.value) || 0,
  }));
}

/**
 * 重新计算排行榜快照。
 * 单次开销：1 条聚合 + 1 条计数，全部带 LIMIT / 走索引；实测 100 用户量级 < 20ms。
 * 任何异常都只记日志、保留旧快照，绝不影响周期结算主流程。
 */
export async function refreshRankSnapshot() {
  const started = Date.now();
  try {
    const [assetRows, participants] = await Promise.all([
      queryAssetsTop(),
      queryParticipantCount(),
    ]);
    snapshot = {
      at: Date.now(),
      list: withRank(assetRows),
      participants,
    };
    logger.info(
      `[排行榜] 已更新：总资产榜${snapshot.list.length}人 ` +
      `(参与 ${participants} 人，耗时 ${Date.now() - started}ms)`
    );
    return snapshot;
  } catch (err) {
    logger.warn('[排行榜] 计算失败，保留上一次快照: ' + err.message);
    return snapshot;
  }
}

/** 供测试使用：清空快照 */
export function resetRankSnapshot() {
  snapshot = { at: 0, list: [], participants: 0 };
}
