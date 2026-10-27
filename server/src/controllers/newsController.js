import { Op } from 'sequelize';
import { News, NewsStock, Vote, User, Stock, OperationLog } from '../models/index.js';
import { ok } from '../utils/response.js';
import { badRequest, notFound, forbidden } from '../utils/errors.js';
import { toNum } from '../utils/money.js';
import config from '../config/index.js';
import { getRuntime, isVoteAllowed } from '../services/settingService.js';
import { decorateNews } from './stockController.js';

/**
 * 新闻列表（公开板块）：可按股票过滤，**只返回最近 20 条**，按最新时间倒序。
 * ★ 只返回「已通过审核」的新闻：普通操作员的待审新闻（reviewStatus='PENDING'）
 *   对外完全不可见（后台列表仍能看到，见 publisherController.listNews）。
 *
 * ★ 2026-09-15：对外列表封顶 20 条（用户要求「只保留最近 20 条」）。
 *   page/pageSize 参数仍接受但被忽略——永远只给「最近 20 条」这一页，
 *   并把 total 也钳到 20，这样前端的分页器会自动消失，不会出现空页。
 *   后台管理端/操作员端的列表不受影响（它们要看到待审与历史）。
 */
export const PUBLIC_LIST_LIMIT = 20;

export async function listNews(req, res, next) {
  try {
    const { stockId } = req.query;
    const pageSize = PUBLIC_LIST_LIMIT;

    let where = { reviewStatus: 'APPROVED' };
    if (stockId) {
      const links = await NewsStock.findAll({ where: { stockId: Number(stockId) }, attributes: ['newsId'] });
      const newsIds = links.map((l) => l.newsId);
      where.id = { [Op.in]: newsIds.length ? newsIds : [-1] };
    }

    // include 多对多(关联角色)会使 JOIN 放大，count 需 DISTINCT 主键去重
    const { rows, count } = await News.findAndCountAll({
      where,
      distinct: true,
      include: [
        { model: User, as: 'publisher', attributes: ['id', 'nickname'] },
        { model: Stock, as: 'stocks', attributes: ['id', 'code', 'name'], through: { attributes: [] } },
      ],
      order: [['createdAt', 'DESC']],
      offset: 0,
      limit: pageSize,
    });
    const ids = rows.map((n) => n.id);
    const votes = ids.length
      ? await Vote.findAll({ where: { targetType: 'NEWS', targetId: { [Op.in]: ids } }, raw: true })
      : [];
    ok(res, {
      // total 钳到 20：前端据此显示「共 N 条」并自动隐藏分页器
      total: Math.min(count, PUBLIC_LIST_LIMIT),
      page: 1,
      pageSize,
      list: rows.map((n) => {
        const v = votes.filter((x) => x.targetId === n.id);
        const d = decorateNews(n.toJSON(), v);
        d.stocks = n.stocks?.map((s) => ({ id: s.id, code: s.code, name: s.name })) || [];
        return d;
      }),
    });
  } catch (err) { next(err); }
}

/** 新闻详情（含投票明细）。★ 待审/已驳回的新闻对普通用户不可见（只有后台列表能看到）。 */
export async function newsDetail(req, res, next) {
  try {
    const n = await News.findByPk(Number(req.params.id), {
      include: [{ model: Stock, as: 'stocks', attributes: ['id', 'code', 'name'], through: { attributes: [] } }],
    });
    if (!n) throw notFound('新闻不存在');
    // 未通过审核的新闻等同于不存在（不泄露「有一条待审新闻」这个信息，也防止被提前围观）
    if (n.reviewStatus !== 'APPROVED') throw notFound('新闻不存在');
    const votes = await Vote.findAll({ where: { targetType: 'NEWS', targetId: n.id }, raw: true });
    ok(res, { ...decorateNews(n.toJSON(), votes), stocks: n.stocks || [] });
  } catch (err) { next(err); }
}

/** 投票总开关（root 控制面板可一键暂停，防刷票操控股价） */
async function assertVoteOpen() {
  if (!(await isVoteAllowed())) throw forbidden('管理员已暂停投票');
}

/** 新闻公开投票（操作员；同票覆盖） */
export async function voteNews(req, res, next) {
  try {
    await assertVoteOpen();
    const { direction, multiplier } = req.body;
    const news = await News.findByPk(Number(req.params.id));
    if (!news) throw notFound('新闻不存在');
    // ★ 待审新闻不能被投票：否则投票会先攒在待审新闻上，审核一通过就带着满票生效
    if (news.reviewStatus !== 'APPROVED') throw forbidden('该新闻尚未通过审核，暂不能投票');
    validateVote(direction, multiplier);
    if (news.publisherId === req.user.id) {
      // 允许作者改票，但记录提示（规则上“其他操作员投票”，这里限制作者不能投自己）
      throw forbidden('新闻发布者不能给自己的新闻投票');
    }
    const m = Number(multiplier);
    const [row] = await Vote.findOrCreate({
      where: { userId: req.user.id, targetType: 'NEWS', targetId: news.id },
      defaults: { userId: req.user.id, targetType: 'NEWS', targetId: news.id, direction, multiplier: m },
    });
    row.direction = direction;
    row.multiplier = m;
    await row.save();
    ok(res, { id: row.id, direction, multiplier: m }, '投票成功');
  } catch (err) { next(err); }
}

/** 对股票的看涨/看跌倍率投票（操作员） */
export async function voteStock(req, res, next) {
  try {
    await assertVoteOpen();
    const { stockId, direction, multiplier } = req.body;
    const stock = await Stock.findByPk(Number(stockId));
    if (!stock) throw notFound('股票不存在');
    validateVote(direction, multiplier);
    const m = Number(multiplier);
    const [row] = await Vote.findOrCreate({
      where: { userId: req.user.id, targetType: 'STOCK', targetId: stock.id },
      defaults: { userId: req.user.id, targetType: 'STOCK', targetId: stock.id, direction, multiplier: m },
    });
    row.direction = direction;
    row.multiplier = m;
    await row.save();
    ok(res, { id: row.id, direction, multiplier: m }, '投票成功');
  } catch (err) { next(err); }
}

function validateVote(direction, multiplier) {
  if (!['UP', 'DOWN'].includes(direction)) throw badRequest('direction 必须为 UP 或 DOWN');
  const m = Number(multiplier);
  const { voteMultMin, voteMultMax } = config.business;
  if (!Number.isFinite(m) || m < voteMultMin || m > voteMultMax) {
    throw badRequest(`倍率必须在 ${voteMultMin}~${voteMultMax} 之间`);
  }
}

/** 我的投票情况 */
export async function myVotes(req, res, next) {
  try {
    const rows = await Vote.findAll({ where: { userId: req.user.id }, order: [['updatedAt', 'DESC']], limit: 100 });
    ok(res, rows.map((v) => ({
      id: v.id, targetType: v.targetType, targetId: v.targetId,
      direction: v.direction, multiplier: toNum(v.multiplier), updatedAt: v.updatedAt,
    })));
  } catch (err) { next(err); }
}
