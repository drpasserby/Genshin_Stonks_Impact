import { Op } from 'sequelize';
import { MarketSentiment, Stock, User } from '../models/index.js';
import { ok } from '../utils/response.js';
import { badRequest, notFound, forbidden } from '../utils/errors.js';
import { canReviewNews, canDeleteData } from '../constants/roles.js';

/**
 * ============ 市场情绪（社交平台舆情监控结果） ============
 *
 * 与 newsController 的关系：**两条完全独立的展示线**。
 *   提瓦特新闻 = 人工发布的新闻引用（带外部原文链接）；
 *   市场情绪   = 脚本从社交平台抓取后自动总结出的情绪快照。
 *
 * 对外口径（重要）：
 *   · 只暴露「已通过审核」的数据；待审/已驳回一律不可见（等同不存在）；
 *   · **不出现「上传人」这种说法**，作者一律是「平台 + 自动总结」的文本（authorLabel）；
 *   · 为了让前台文案干净，接口里也不返回任何内部字段（batch_* / review_* 只给管理端）。
 */

/** 统一的序列化：对外字段白名单 */
function serialize(s, { forAdmin = false } = {}) {
  const base = {
    id: s.id,
    platform: s.platform,
    platformName: s.platformName || s.platform,
    fetchedAt: s.fetchedAt,
    title: s.title,
    summary: s.summary,
    direction: s.direction,
    strength: Number(s.strength) || 0,
    stockCount: s.stockCount,
    sourceUrl: s.sourceUrl,
    author: s.authorLabel,
    stocks: (s.stocks || []).map((k) => ({ id: k.id, code: k.code, name: k.name })),
  };
  if (!forAdmin) return base;
  return {
    ...base,
    reviewStatus: s.reviewStatus,
    reviewedAt: s.reviewedAt,
    reviewNote: s.reviewNote,
    reviewer: s.reviewer?.nickname || s.reviewer?.username || null,
    batchDate: s.batchDate,
    batchKey: s.batchKey,
    createdAt: s.createdAt,
  };
}

const INCLUDE_STOCKS = { model: Stock, as: 'stocks', attributes: ['id', 'code', 'name'], through: { attributes: [] } };

/* ==================== 对外（公开） ==================== */

/**
 * 市场情绪列表（公开）：只返回已通过审核的，按抓取时间倒序，**只给最近 20 条**。
 * ?platform=NGA 可按平台过滤（以后接多平台时前台就有得筛了）。
 *
 * ★ 2026-09-15：对外列表封顶 20 条（与新闻列表同一口径），
 *   page/pageSize 参数被忽略且 total 钳到 20，前端分页器会自动消失。
 */
export const PUBLIC_LIST_LIMIT = 20;

export async function listSentiment(req, res, next) {
  try {
    const pageSize = PUBLIC_LIST_LIMIT;
    const where = { reviewStatus: 'APPROVED' };
    if (req.query.platform) where.platform = String(req.query.platform).slice(0, 32);

    const { rows, count } = await MarketSentiment.findAndCountAll({
      where,
      distinct: true,
      include: [INCLUDE_STOCKS],
      order: [['fetchedAt', 'DESC'], ['id', 'DESC']],
      offset: 0,
      limit: pageSize,
    });

    // 各平台条数（前台筛选用；也是「以后接多平台」的现成接口）
    const platformRows = await MarketSentiment.findAll({
      where: { reviewStatus: 'APPROVED' },
      attributes: ['platform', 'platformName'],
      group: ['platform', 'platformName'],
      raw: true,
    });
    ok(res, {
      total: Math.min(count, PUBLIC_LIST_LIMIT),
      page: 1,
      pageSize,
      list: rows.map((s) => serialize(s)),
      platforms: platformRows.map((p) => ({ platform: p.platform, name: p.platformName || p.platform })),
    });
  } catch (err) { next(err); }
}

/** 市场情绪详情（公开）：未通过审核的等同不存在 */
export async function sentimentDetail(req, res, next) {
  try {
    const s = await MarketSentiment.findByPk(Number(req.params.id), { include: [INCLUDE_STOCKS] });
    if (!s || s.reviewStatus !== 'APPROVED') throw notFound('该条市场情绪不存在');
    ok(res, serialize(s));
  } catch (err) { next(err); }
}

/* ==================== 管理端 ==================== */

/** 管理端列表：含待审/已驳回，可按状态与平台过滤 */
export async function listSentimentAdmin(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100);
    const where = {};
    if (req.query.reviewStatus) where.reviewStatus = String(req.query.reviewStatus);
    if (req.query.platform) where.platform = String(req.query.platform).slice(0, 32);

    const { rows, count } = await MarketSentiment.findAndCountAll({
      where,
      distinct: true,
      include: [INCLUDE_STOCKS, { model: User, as: 'reviewer', attributes: ['id', 'username', 'nickname'] }],
      order: [['fetchedAt', 'DESC'], ['id', 'DESC']],
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    const pending = await MarketSentiment.count({ where: { reviewStatus: 'PENDING' } });
    ok(res, { total: count, page, pageSize, pending, list: rows.map((s) => serialize(s, { forAdmin: true })) });
  } catch (err) { next(err); }
}

/**
 * 审核：body { action: 'approve' | 'reject', note }
 *
 * 通过后即对外可见。★ 与价格的关系（2026-09-14 起）：
 *   · 本模块负责的是「能不能公开显示」，不是「能不能影响股价」；
 *   · 定价侧由面板开关 `sentiment_before_review` 决定待审情绪是否已参与撮合（默认参与），
 *     已驳回(REJECTED)则在任何情况下都不参与定价（人工否决要留下痕迹就必须生效）；
 *   · 所以这里的 approve 对价格的影响是「跟随开关」的，别把审核当成价格闸门。
 */
export async function reviewSentiment(req, res, next) {
  try {
    if (!canReviewNews(req.user.role)) throw forbidden('无权审核（仅管理员及超级管理员）');
    const { action, note = '' } = req.body || {};
    if (!['approve', 'reject'].includes(action)) throw badRequest('action 必须为 approve 或 reject');

    const s = await MarketSentiment.findByPk(Number(req.params.id));
    if (!s) throw notFound('该条市场情绪不存在');
    if (s.reviewStatus !== 'PENDING') {
      throw badRequest(`当前状态为「${s.reviewStatus}」，不在待审状态，无需审核`);
    }
    s.reviewStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    s.reviewedBy = req.user.id;
    s.reviewedAt = new Date();
    s.reviewNote = String(note || '').slice(0, 255) || null;
    await s.save();
    ok(res, { id: s.id, reviewStatus: s.reviewStatus },
      action === 'approve' ? '已通过，市场情绪页立即可见' : '已驳回，不会对外展示');
  } catch (err) { next(err); }
}

/** 删除（仅超级管理员）：连带清理关联角色 */
export async function deleteSentiment(req, res, next) {
  try {
    if (!canDeleteData(req.user.role)) throw forbidden('无权删除（仅超级管理员）');
    const s = await MarketSentiment.findByPk(Number(req.params.id));
    if (!s) throw notFound('该条市场情绪不存在');
    await s.setStocks([]);
    await s.destroy();
    ok(res, { id: s.id }, '已删除');
  } catch (err) { next(err); }
}

/** 待审条数（管理端徽标用；不做鉴权判断，路由层已限权） */
export async function sentimentPendingCount(req, res, next) {
  try {
    ok(res, { pending: await MarketSentiment.count({ where: { reviewStatus: 'PENDING' } }) });
  } catch (err) { next(err); }
}

export { serialize as serializeSentiment, INCLUDE_STOCKS as SENTIMENT_STOCKS_INCLUDE };
