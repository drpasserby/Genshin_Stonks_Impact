import { User, OperationLog } from '../models/index.js';
import { ok } from '../utils/response.js';
import { badRequest, notFound, forbidden } from '../utils/errors.js';
import { logContext } from '../utils/requestInfo.js';
import { getRankSnapshot, refreshRankSnapshot, RANK_TOP_N } from '../services/rankService.js';
import { isRankEnabled, getRuntime } from '../services/settingService.js';
import { mustPublicizeHoldings } from '../constants/roles.js';

/**
 * 排行榜查询（公开，未登录也能看 —— 这是对外吸引新玩家的展示位）。
 * 只返回「名次 + 昵称 + 金额」，不返回用户 ID / 用户名。
 * 数据来自周期任务预先算好的内存快照：本接口零数据库开销。
 *
 * 2026-09-18：原来的「资金榜 / 市值榜」两个榜合并为单一**总资产榜**，
 * 因此这里不再接受 type 参数（保留了也无害，会被忽略）。
 */
export async function rank(req, res, next) {
  try {
    const enabled = await isRankEnabled();
    const snap = getRankSnapshot();
    ok(res, {
      type: 'assets',
      enabled,
      topN: RANK_TOP_N,
      intervalMinutes: getRuntime().rankIntervalMinutes,
      updatedAt: snap.at ? new Date(snap.at) : null,
      participants: enabled ? snap.participants : 0,
      list: enabled ? snap.list : [],
    });
  } catch (err) { next(err); }
}

/**
 * 设置「是否参与排行榜」（用户中心里的开关）。
 * 改完后异步重算一次快照，让用户立刻能看到自己上榜/下榜，不用等下一个更新周期。
 * ★ 明星（star）是公开身份：强制参与，不允许退出。
 */
export async function updateMyRankOptIn(req, res, next) {
  try {
    const { optIn } = req.body;
    if (typeof optIn !== 'boolean') throw badRequest('optIn 必须是布尔值（true/false）');
    const user = await User.findByPk(req.user.id);
    if (!user) throw notFound('用户不存在');

    if (mustPublicizeHoldings(user.role)) {
      // 明星本就强制公开持仓，若还能从排行榜隐身就自相矛盾了
      if (!optIn) throw forbidden('明星身份必须公开参与排行榜，无法关闭');
      user.rankOptIn = true;
    } else {
      user.rankOptIn = optIn;
    }
    await user.save();

    OperationLog.create({
      userId: user.id,
      action: 'SET_RANK_OPT_IN',
      detail: JSON.stringify({ optIn, forced: mustPublicizeHoldings(user.role) }),
      ...logContext(req),
    }).catch(() => {});

    // 立刻刷新快照（异常已在 service 内部吞掉，不影响本请求）
    if (await isRankEnabled()) refreshRankSnapshot().catch(() => {});

    ok(res, { rankOptIn: !!user.rankOptIn, forced: mustPublicizeHoldings(user.role) },
      mustPublicizeHoldings(user.role) ? '明星身份已自动参与排行榜' : (optIn ? '已参与排行榜' : '已退出排行榜'));
  } catch (err) { next(err); }
}
