import { Op } from 'sequelize';
import sequelize from '../config/db.js';
import { News, NewsStock, Stock, Vote, User, OperationLog } from '../models/index.js';
import { ok } from '../utils/response.js';
import { badRequest, notFound, forbidden } from '../utils/errors.js';
import config from '../config/index.js';
import { isNewsPublishAllowed, getNewsTtlMs } from '../services/settingService.js';
import { logContext } from '../utils/requestInfo.js';
import { canPublishNewsWithoutReview, canReviewNews, canDeleteData } from '../constants/roles.js';
import { newsScore } from '../services/engine.js';

/**
 * ============ 新闻发布与审核 ============
 *
 * 审核规则（2026-09-12 新增）：
 *   高级操作员 / 管理员 / 超级管理员 发布 → 直接 APPROVED，立刻生效
 *   普通操作员                        发布 → PENDING 待审，**不进价格引擎、不公开、不可投票**
 *   管理员 / 超级管理员                 审核 → approve 通过（重置有效期起点）/ reject 驳回（可附理由）
 *
 * 两条容易踩的约定：
 *   ① expires_at 的计时起点是「审核通过时刻」：待审期间不该消耗新闻有效期；
 *   ② 删除新闻（物理删除）只有超级管理员能做；管理员用「立刻失效」（PUT /news/:id/expire），
 *      数据全部保留、只是不再影响股价，也仍可在后台列表里看到。
 */

/** 校验 URL 是否为合法 http/https 链接 */
export function isHttpUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 校验新闻字段的公共逻辑（复用 publish/update）。content 已废弃，改用 sourceUrl */
function validateNewsInput({ title, sourceUrl, direction, strength, stockIds }) {
  if (!title || !title.trim()) throw badRequest('请输入新闻标题');
  if (!isHttpUrl(sourceUrl)) throw badRequest('请输入合法的新闻来源链接（http/https）');
  if (!['UP', 'DOWN'].includes(direction)) throw badRequest('direction 必须为 UP 或 DOWN');
  const s = Number(strength);
  if (!Number.isInteger(s) || s < 0 || s > 100) throw badRequest('影响强度须为 0~100 的整数');
  if (!Array.isArray(stockIds) || stockIds.length === 0) throw badRequest('请至少关联一个角色');
  if (stockIds.length > 10) throw badRequest('单条新闻最多关联 10 个角色');
}

/** 新闻发布开关（root 控制面板可一键暂停，用于止血恶意发新闻） */
export async function assertNewsPublishOpen() {
  if (!(await isNewsPublishAllowed())) {
    throw forbidden('管理员已暂停新闻发布');
  }
}

/**
 * 发布新闻引用（操作员/高级操作员/管理员）。
 *
 * 普通操作员：落 PENDING（待审）——不复用 assertNewsPublishOpen 之外的任何捷径，
 * 提交后只返回「已提交待审核」，前端也据此提示。
 */
export async function publishNews(req, res, next) {
  try {
    await assertNewsPublishOpen();
    const { title, sourceUrl, direction, strength, stockIds } = req.body;
    validateNewsInput({ title, sourceUrl, direction, strength, stockIds });

    const stocks = await Stock.findAll({ where: { id: stockIds } });
    if (stocks.length !== stockIds.length) throw notFound('存在无效的角色');

    // 高级操作员及以上免审核；普通操作员的新闻要等审核通过
    const autoApprove = canPublishNewsWithoutReview(req.user.role);
    const now = new Date();
    const expiresAt = autoApprove ? new Date(now.getTime() + (await getNewsTtlMs())) : null;

    const news = await sequelize.transaction(async (t) => {
      const row = await News.create({
        title: title.trim(),
        content: '',
        sourceUrl: sourceUrl.trim(),
        direction,
        strength: Number(strength),
        publisherId: req.user.id,
        reviewStatus: autoApprove ? 'APPROVED' : 'PENDING',
        reviewedBy: autoApprove ? req.user.id : null,
        reviewedAt: autoApprove ? now : null,
        reviewNote: autoApprove ? '高级操作员/管理员发布，免审核' : null,
        expiresAt,
      }, { transaction: t });
      await NewsStock.bulkCreate(stockIds.map((stockId) => ({ newsId: row.id, stockId })), { transaction: t });
      return row;
    });

    OperationLog.create({
      userId: req.user.id, action: 'PUBLISH_NEWS',
      detail: JSON.stringify({
        newsId: news.id, stockIds, direction, strength, reviewStatus: news.reviewStatus,
      }),
      ...logContext(req),
    }).catch(() => {});

    ok(res, {
      id: news.id,
      expiresAt: news.expiresAt,
      reviewStatus: news.reviewStatus,
      pending: news.reviewStatus === 'PENDING',
    }, autoApprove ? '发布成功，已立即生效' : '已提交，等待管理员审核通过后才会生效');
  } catch (err) { next(err); }
}

/** 把 News 行序列化成前端要的形状（管理端列表与「我提交的新闻」共用） */
function serializeNewsRow(n, voteRows) {
  const vs = voteRows.filter((v) => Number(v.targetId) === Number(n.id));
  const up = vs.filter((v) => v.direction === 'UP').length;
  const down = vs.filter((v) => v.direction === 'DOWN').length;
  const mults = vs.map((v) => Number(v.multiplier));
  const avgMult = mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : 1;
  const score = vs.length ? newsScore(n, vs) : null;
  return {
    id: n.id, title: n.title, sourceUrl: n.sourceUrl,
    direction: n.direction, strength: n.strength,
    stocks: n.stocks?.map((s) => ({ id: s.id, code: s.code, name: s.name })) || [],
    expiresAt: n.expiresAt, createdAt: n.createdAt,
    expired: n.expiresAt ? new Date(n.expiresAt).getTime() < Date.now() : false,
    reviewStatus: n.reviewStatus,
    reviewedAt: n.reviewedAt,
    reviewNote: n.reviewNote,
    // ★ publisherId 必须给：前端要用它判断「这条是不是我提交的」。
    //   2026-09-14 修 bug：「我提交的新闻」一直空白，就是因为这里只给了昵称字符串
    //   （publisher）而没给 id，前端 rows.filter(n => n.publisherId === store.user.id)
    //   永远为 false。字段名用 publisherId（camelCase，与 Sequelize/前端类型一致），
    //   另外补上驼峰的 reviewedBy，方便管理端显示「谁审的」。
    publisherId: n.publisherId,
    reviewedBy: n.reviewedBy,
    // publisher 保持「昵称字符串」口径（与公开接口一致，前端表格直接渲染）；
    // 审核人需要知道发布者的身份组，所以额外给一个 publisherRole
    publisher: n.publisher?.nickname || null,
    publisherRole: n.publisher?.role || null,
    votes: {
      up, down, total: vs.length,
      avgMult: Math.round(avgMult * 100) / 100,
      score: score == null ? null : Math.round(score * 10000) / 10000,
    },
  };
}

/**
 * 我提交的新闻（操作员/高级操作员/管理员/超管都可调）。
 *
 * 与 listNews 的区别：**服务端按 publisherId 过滤**，只返回自己发的。
 * 为什么单独开这个接口，而不是让前端在 /operator/news 的结果里筛：
 *   1) 前端筛选依赖接口字段（本次 bug 的根因就是字段缺失）；
 *   2) listNews 有 limit 200 且是「全站最近 200 条」，系统一忙，自己的新闻会被挤出窗口
 *      —— 表现同样是「我提交的新闻是空的」；
 *   3) 顺便省一次全量传输。
 * 自己的待审/已驳回新闻当然对自己可见（与 listNews 的可见范围规则一致）。
 */
export async function listMyNews(req, res, next) {
  try {
    const rows = await News.findAll({
      where: { publisherId: req.user.id },
      include: [{ model: Stock, as: 'stocks', attributes: ['id', 'code', 'name'], through: { attributes: [] } }],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    const ids = rows.map((n) => n.id);
    const voteRows = ids.length
      ? await Vote.findAll({ where: { targetType: 'NEWS', targetId: { [Op.in]: ids } }, raw: true })
      : [];
    ok(res, rows.map((n) => serializeNewsRow(n, voteRows)));
  } catch (err) { next(err); }
}

/**
 * 新闻列表（操作员/管理端视角，含股票关联与审核状态）。
 * 与公开接口 newsController.listNews 的区别：这里能看到待审/已驳回的新闻。
 *
 * ★ 可见范围（防止内幕抢跑）：
 *   - 管理员/超管：看得到全部（他们要审核）。
 *   - 普通操作员：看得到「已生效 / 已驳回」的全部新闻 + **只有自己提交的**待审新闻。
 *     别人的待审新闻对他们不可见 —— 否则操作员也能交易，等于把一份还没生效的
 *     利好/利空提前泄露给同事，可以先建仓再等新闻生效。
 * ?reviewStatus=PENDING 可只看待审队列。
 */
export async function listNews(req, res, next) {
  try {
    const { reviewStatus = '' } = req.query;
    const conds = [];
    if (reviewStatus) conds.push({ reviewStatus });
    if (!canReviewNews(req.user.role)) {
      conds.push({
        [Op.or]: [
          { reviewStatus: { [Op.ne]: 'PENDING' } },
          { publisherId: req.user.id },
        ],
      });
    }
    const where = conds.length ? { [Op.and]: conds } : {};
    const rows = await News.findAll({
      where,
      include: [
        { model: Stock, as: 'stocks', attributes: ['id', 'code', 'name'], through: { attributes: [] } },
        { model: User, as: 'publisher', attributes: ['id', 'username', 'nickname', 'role'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });

    // 投票聚合：管理端表格要显示票数与影响分（原来靠公开接口带出来的，
    // 换成这个接口后必须自己查一次，否则投票列会全是 0）
    const ids = rows.map((n) => n.id);
    const voteRows = ids.length
      ? await Vote.findAll({ where: { targetType: 'NEWS', targetId: { [Op.in]: ids } }, raw: true })
      : [];

    ok(res, rows.map((n) => serializeNewsRow(n, voteRows)));
  } catch (err) { next(err); }
}

/**
 * 编辑新闻（管理员/超管）：标题/来源链接/方向/强度/关联角色；renew=true 时重置有效期。
 * 注意：编辑**不会**改变审核状态 —— 待审新闻编辑后仍然是待审，必须显式审核通过才生效。
 */
export async function updateNews(req, res, next) {
  try {
    await assertNewsPublishOpen();
    const news = await News.findByPk(Number(req.params.id));
    if (!news) throw notFound('新闻不存在');
    const { title, sourceUrl, direction, strength, stockIds, renew = false } = req.body;

    validateNewsInput({ title, sourceUrl, direction, strength, stockIds });
    const stocks = await Stock.findAll({ where: { id: stockIds } });
    if (stocks.length !== stockIds.length) throw notFound('存在无效的角色');
    if (renew && news.reviewStatus !== 'APPROVED') {
      throw badRequest('该新闻尚未通过审核，无法续期（请先审核通过）');
    }

    news.title = title.trim();
    news.sourceUrl = sourceUrl.trim();
    news.direction = direction;
    news.strength = Number(strength);
    if (renew) {
      news.expiresAt = new Date(Date.now() + (await getNewsTtlMs()));
    }
    // 重建关联角色 + 保存新闻：同一事务，避免中途失败留下「新闻改了但关联清空」的半成品
    await sequelize.transaction(async (t) => {
      await news.save({ transaction: t });
      await NewsStock.destroy({ where: { newsId: news.id }, transaction: t });
      await NewsStock.bulkCreate(stockIds.map((stockId) => ({ newsId: news.id, stockId })), { transaction: t });
    });
    OperationLog.create({
      userId: req.user.id, action: 'UPDATE_NEWS',
      detail: JSON.stringify({ newsId: news.id, renew }),
      ...logContext(req),
    }).catch(() => {});
    ok(res, { id: news.id, reviewStatus: news.reviewStatus }, '新闻已更新');
  } catch (err) { next(err); }
}

/**
 * 审核新闻（管理员/超管）：approve 通过 / reject 驳回。
 * 通过时有效期从「此刻」重新起算 —— 这才是新闻真正的生效时刻。
 */
export async function reviewNews(req, res, next) {
  try {
    if (!canReviewNews(req.user.role)) throw forbidden('无权审核新闻（仅管理员及超级管理员可审核）');
    const { action, note = '' } = req.body || {};
    if (!['approve', 'reject'].includes(action)) throw badRequest('action 必须为 approve 或 reject');

    const news = await News.findByPk(Number(req.params.id));
    if (!news) throw notFound('新闻不存在');
    if (news.reviewStatus !== 'PENDING') {
      throw badRequest(`该新闻当前状态为「${news.reviewStatus}」，不在待审状态，无需审核`);
    }

    if (action === 'approve') {
      // 发布开关关闭时，不允许把待审新闻放进市场（驳回则不受开关限制）
      await assertNewsPublishOpen();
      news.reviewStatus = 'APPROVED';
      news.expiresAt = new Date(Date.now() + (await getNewsTtlMs()));
    } else {
      news.reviewStatus = 'REJECTED';
      news.expiresAt = null;
    }
    news.reviewedBy = req.user.id;
    news.reviewedAt = new Date();
    news.reviewNote = String(note || '').slice(0, 255) || null;
    await news.save();

    OperationLog.create({
      userId: req.user.id, action: action === 'approve' ? 'APPROVE_NEWS' : 'REJECT_NEWS',
      detail: JSON.stringify({ newsId: news.id, note: news.reviewNote }),
      ...logContext(req),
    }).catch(() => {});

    ok(res, {
      id: news.id, reviewStatus: news.reviewStatus, expiresAt: news.expiresAt,
    }, action === 'approve' ? '已通过审核，新闻立即生效' : '已驳回，该新闻不会生效');
  } catch (err) { next(err); }
}

/**
 * 新闻立刻失效（管理员/超管的「准删除」动作）。
 * 把 expires_at 置为当前时间 → 引擎不再计入、前台不再是「有效新闻」；记录与投票全部保留。
 * 不受 allow_news_publish 开关限制（这是止血动作，开关关掉时更应该能用）。
 */
export async function expireNews(req, res, next) {
  try {
    const news = await News.findByPk(Number(req.params.id));
    if (!news) throw notFound('新闻不存在');
    if (news.reviewStatus !== 'APPROVED') throw badRequest('该新闻尚未生效，无需失效');
    if (news.expiresAt && new Date(news.expiresAt).getTime() <= Date.now()) {
      throw badRequest('该新闻已经失效');
    }
    news.expiresAt = new Date();
    await news.save();
    OperationLog.create({
      userId: req.user.id, action: 'EXPIRE_NEWS',
      detail: JSON.stringify({ newsId: news.id }),
      ...logContext(req),
    }).catch(() => {});
    ok(res, { id: news.id, expiresAt: news.expiresAt }, '新闻已立刻失效（记录保留，可追溯）');
  } catch (err) { next(err); }
}

/**
 * 删除新闻（★ 仅超级管理员）：级联清理关联角色与投票。
 * ★ 权限收紧（2026-09-12）：管理员只能用上面的「立刻失效」，不能物理删除。
 * 顺带修掉两个老问题：① 补上事务（原来是三段独立语句）；② 不再受 allow_news_publish 开关限制
 * （关掉开关后原来连删违规新闻都做不到）。
 */
export async function deleteNews(req, res, next) {
  try {
    if (!canDeleteData(req.user.role)) {
      throw forbidden('无权删除新闻（仅超级管理员可删除；管理员请使用「立刻失效」）');
    }
    const news = await News.findByPk(Number(req.params.id));
    if (!news) throw notFound('新闻不存在');
    await sequelize.transaction(async (t) => {
      await NewsStock.destroy({ where: { newsId: news.id }, transaction: t });
      await Vote.destroy({ where: { targetType: 'NEWS', targetId: news.id }, transaction: t });
      await news.destroy({ transaction: t });
    });
    OperationLog.create({
      userId: req.user.id, action: 'DELETE_NEWS',
      detail: JSON.stringify({ newsId: news.id }),
      ...logContext(req),
    }).catch(() => {});
    ok(res, { id: news.id }, '新闻已删除');
  } catch (err) { next(err); }
}
