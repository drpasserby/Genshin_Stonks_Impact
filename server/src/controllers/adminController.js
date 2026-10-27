import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { User, Stock, Trade, Order, Holding, HoldingLot, OperationLog, Watchlist, NewsStock, PriceHistory, FundConstituent } from '../models/index.js';
import sequelize from '../config/db.js';
import { invalidateFundGraph } from '../jobs/cycleJob.js';
import { cancelAllPendingOrders } from '../services/tradingService.js';
import { ok } from '../utils/response.js';
import { badRequest, notFound, conflict, forbidden } from '../utils/errors.js';
import { roundPrice, round2, toNum } from '../utils/money.js';
import { serializeUser } from './authController.js';
import config from '../config/index.js';
import * as settingService from '../services/settingService.js';
import * as perfService from '../services/perfService.js';
import { logContext } from '../utils/requestInfo.js';
import * as ngaRun from '../utils/ngaRun.js';
import { LEVEL, VALID_ROLES, ROLE_LABELS, levelOf, isValidRole, canDeleteData, mustPublicizeHoldings } from '../constants/roles.js';
import { invalidateStarCache } from './starController.js';

/**
 * ============ 管理端权限矩阵 ============
 *
 * 身份组的定义、中文名与等级表在 constants/roles.js（唯一真源），这里只写接口层约定：
 *
 * root（超级管理员）：全部权限，与最初版本完全一致，不受下面任何限制。
 *
 * admin（管理员）：
 *   - 可创建/编辑 user / vip / star / operator / senior_operator 六种身份中的任意一种
 *     （即「高级用户 / 明星 / 高级操作员」由管理员赋予），可禁用账号、补发摩拉、改昵称
 *   - 不可创建或赋予 admin / root；不可操作等级 ≥ 自己的账号
 *   - 不可重置他人密码、不可查看操作日志 / 盈亏报表 / 系统设置（均仅 root）
 *   - ★ 不可执行任何删除类操作，只能用非破坏性替代动作：
 *       用户     → 只能禁用/启用（status 0/1），不能注销（status=2）
 *       新闻     → 只能「立刻失效」（expires_at=now），不能删除
 *       标的     → 只能停牌（status=0）/ 退市（status=2），不能删除
 *       成交记录 → 没有任何操作（审计凭证，不可变）
 *     删除接口已统一收敛到 root：routes/admin.js 上 requireRole('root')，
 *     控制器内再用 assertCanDelete() 兜一层（防止将来路由调整把口子放开）。
 */

/** 删除类操作的统一守卫：只有超级管理员能物理删除任何数据 */
function assertCanDelete(req) {
  if (!canDeleteData(req.user.role)) {
    throw forbidden('无权执行删除操作（仅超级管理员可删除数据）');
  }
}

/** 管理操作审计：自动带上操作人、IP、User-Agent */
function log(req, action, detail) {
  OperationLog.create({
    userId: req.user?.id ?? null,
    action,
    detail: JSON.stringify(detail || {}),
    ...logContext(req),
  }).catch(() => {});
}

/** 用户状态：1=正常  0=已禁用（可恢复）  2=已注销（逻辑删除，数据保留，可恢复） */
const STATUS = { NORMAL: 1, DISABLED: 0, DELETED: 2 };

/* ================= 用户管理 ================= */

/** 用户列表（分页/搜索/角色过滤）。支持按「用户名」或「昵称」搜索。普通 admin 看不到 root 用户；逻辑删除的默认不显示。 */
export async function listUsers(req, res, next) {
  try {
    const { q = '', role = '', page = 1, pageSize = 20, includeDeleted = '' } = req.query;
    const where = {};
    if (req.user.role !== 'root') where.role = { [Op.ne]: 'root' }; // admin 不可见 root
    if (role) where.role = role;
    // 搜索：用户名 或 昵称 命中即可
    if (q) {
      where[Op.or] = [
        { username: { [Op.like]: `%${q}%` } },
        { nickname: { [Op.like]: `%${q}%` } },
      ];
    }
    // 已注销（逻辑删除）的账号默认隐藏，只有 root 主动勾选才显示
    const showDeleted = req.user.role === 'root' && ['1', 'true'].includes(String(includeDeleted));
    if (!showDeleted) where.status = { [Op.ne]: STATUS.DELETED };
    const { rows, count } = await User.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      offset: (Number(page) - 1) * Number(pageSize),
      limit: Math.min(Number(pageSize), 100),
    });
    const deletedCount = req.user.role === 'root'
      ? await User.count({ where: { status: STATUS.DELETED } })
      : 0;
    ok(res, { total: count, list: rows.map(serializeUser), deletedCount });
  } catch (err) { next(err); }
}

/**
 * 身份组下拉选项（管理面板用）。
 * 由后端下发而不是前端硬编码：这样「后端允许赋予的身份」与「前端下拉里能选的项」
 * 永远不会出现两套硬编码不一致（以前角色下拉与保存前校验就是两处独立硬编码）。
 * assignable = 当前登录者能否把别人设成该身份（等级低于自己即可；自己的身份恒为 true，仅用于回显）。
 */
export async function roleOptions(req, res, next) {
  try {
    const myLevel = levelOf(req.user.role);
    const isRoot = req.user.role === 'root';
    const list = VALID_ROLES.map((value) => ({
      value,
      label: ROLE_LABELS[value] ?? value,
      level: LEVEL[value],
      // root 可以把任何人设成任何身份；其余人只能设「等级低于自己」的身份
      assignable: isRoot ? true : levelOf(value) < myLevel,
    }));
    ok(res, { list, myRole: req.user.role });
  } catch (err) { next(err); }
}

/** 创建用户。admin 可创建 user/vip/star/operator/senior_operator；root 可创建任意（含 admin/root）。 */
export async function createUser(req, res, next) {
  try {
    const { username, password, nickname, role = 'user' } = req.body;
    if (!username || !password) throw badRequest('用户名与密码必填');
    if (!isValidRole(role)) throw badRequest('角色不合法');
    // 不能创建等级 ≥ 自己的身份（admin 因此无法创建 admin/root；root 无上限）
    if (!canDeleteData(req.user.role) && levelOf(role) >= levelOf(req.user.role)) {
      throw forbidden('无权创建该身份的用户（仅超级管理员可创建管理员/超级管理员）');
    }
    if (await User.findOne({ where: { username } })) throw conflict('用户名已存在');
    const user = await User.create({
      username,
      passwordHash: await bcrypt.hash(password, 10),
      nickname: nickname || username,
      role,
      mora: await settingService.getStartMora(),   // 初始摩拉由控制面板配置
    });
    log(req, 'ADMIN_CREATE_USER', { username, role });
    ok(res, serializeUser(user), '用户创建成功');
  } catch (err) { next(err); }
}

/**
 * 编辑用户。
 * admin：目标等级必须低于自己（即不可操作 admin/root）；只能改昵称/状态(禁启用)/摩拉；
 *        可赋予的身份等级必须低于自己 → 能把普通用户提升为 高级用户/明星/操作员/高级操作员，
 *        但不可设为 admin/root。
 * root：可编辑任意用户；不能把自己降级，且至少保留一名 root。
 */
export async function updateUser(req, res, next) {
  try {
    const user = await User.findByPk(Number(req.params.id));
    if (!user) throw notFound('用户不存在');
    const { role, nickname, status, mora, password } = req.body;

    const isRoot = req.user.role === 'root';
    const myLevel = levelOf(req.user.role);

    // 普通 admin：禁止操作等级 ≥ 自己的账号（admin / root）
    if (!isRoot && levelOf(user.role) >= myLevel) {
      throw forbidden('无权修改管理员/超级管理员账号');
    }

    // 重置密码：仅超级管理员可执行（普通 admin 无权）
    let passwordReset = false;
    if (password != null && password !== '') {
      if (!isRoot) throw forbidden('仅超级管理员可重置用户密码');
      if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
        throw badRequest('新密码长度须为 6~64 位');
      }
      user.passwordHash = await bcrypt.hash(password, 10);
      // 令牌版本 +1：该用户所有已签发的 JWT 立即失效，强制重新登录
      user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
      passwordReset = true;
    }

    if (role && isValidRole(role) && role !== user.role) {
      // 普通 admin：只能赋予等级低于自己的身份（即不能设为 admin/root）
      if (!isRoot && levelOf(role) >= myLevel) throw forbidden('无权将用户身份设为管理员/超级管理员');
      // root 保护：root 不能把自己降级 / 至少保留一名 root
      if (user.role === 'root' || role === 'root') {
        if (user.id === req.user.id && role !== 'root') throw badRequest('不能降低自己的超级管理员身份');
        const roots = await User.count({ where: { role: 'root' } });
        if (user.role === 'root' && role !== 'root' && roots <= 1) throw badRequest('至少需要保留一名超级管理员');
      }
      user.role = role;
      // 明星是公开身份：强制参与排行榜，与「我的」页面的开关保持一致
      if (mustPublicizeHoldings(role)) user.rankOptIn = true;
      // 身份变更可能影响「明星持仓」公开页，让缓存立即失效
      invalidateStarCache();
    }
    if (nickname != null) user.nickname = String(nickname);
    if (status != null) {
      const s = Number(status);
      if (![STATUS.DISABLED, STATUS.NORMAL].includes(s)) throw badRequest('status 只能为 0（禁用）或 1（启用）');
      // 把已注销账号改回 1 即为「恢复账号」
      user.status = s;
      if (s === STATUS.NORMAL) log(req, 'ADMIN_RESTORE_USER', { id: user.id, username: user.username });
    }
    if (mora != null) user.mora = round2(Number(mora));
    await user.save();
    log(req, 'ADMIN_UPDATE_USER', {
      id: user.id,
      role: role ?? undefined,
      status,
      mora,
      resetPassword: passwordReset,
      forceLogout: passwordReset,   // 重置密码同时使其全部旧 token 失效
    });
    ok(res, serializeUser(user), '更新成功');
  } catch (err) { next(err); }
}

/**
 * 删除用户（仅超级管理员）—— 逻辑删除，不做物理删除。
 *
 * status 取值：1=正常  0=已禁用  2=已注销（逻辑删除）
 * 为什么不再物理删除：
 *   · 物理删除会连带清掉该用户的委托/成交/持仓，数据不可恢复；
 *   · 成交记录是审计凭证，删掉后无法追溯；
 *   · 设备注册记录仍会保留该设备号，账号被删也无法同设备重新注册，
 *     "删号重建"既没好处又会丢数据。
 * 逻辑删除后：无法登录、默认不在用户列表显示、所有历史数据保留，
 * 由超级管理员在列表里「恢复」即可复原。
 */
export async function deleteUser(req, res, next) {
  try {
    if (req.user.role !== 'root') throw forbidden('无权删除用户（仅超级管理员可删除）');
    const id = Number(req.params.id);
    if (id === req.user.id) throw badRequest('不能删除当前登录账号');
    const user = await User.findByPk(id);
    if (!user) throw notFound('用户不存在');
    if (Number(user.status) === STATUS.DELETED) throw badRequest('该用户已经是注销状态');

    if (user.role === 'root') {
      const roots = await User.count({ where: { role: 'root', status: { [Op.ne]: STATUS.DELETED } } });
      if (roots <= 1) throw badRequest('至少需要保留一名超级管理员');
    }

    // 逻辑删除：只改状态 + 立刻踢下线（tokenVersion+1）
    user.status = STATUS.DELETED;
    user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
    await user.save();
    // 注销的账号不该再出现在「明星持仓」公开页
    if (mustPublicizeHoldings(user.role)) invalidateStarCache();

    log(req, 'ADMIN_DELETE_USER', { id, username: user.username, softDelete: true });
    ok(res, { id, username: user.username, status: STATUS.DELETED }, '用户已注销（数据已保留，可恢复）');
  } catch (err) { next(err); }
}

/* ================= 角色股票管理 ================= */

/** 标的行情字段的统一序列化（列表/分页共用） */
function serializeAdminStock(s) {
  return {
    id: s.id, code: s.code, name: s.name, type: s.type, status: Number(s.status ?? 1), avatarUrl: s.avatarUrl,
    price: toNum(s.price), prevClose: toNum(s.prevClose), open: toNum(s.open),
    high: toNum(s.high), low: toNum(s.low), volume: Number(s.volume),
    totalShares: Number(s.totalShares), nav: s.nav == null ? null : toNum(s.nav),
    updatedAt: s.updatedAt,
  };
}

/**
 * 股票 / 基金列表（分页 + 搜索 + 类型/状态过滤）。
 * 默认每页 20 条、最多 100 条 —— 标的数量会随活动增长，一次拉全量对 2 核小机器是浪费，
 * 也会让管理界面变卡。
 *
 * 兼容：不带 page 参数时仍返回「全部匹配项的数组」（旧版前端/脚本的调用方式），
 *       带 page 时返回 { total, list }。新前端一律带 page。
 */
export async function listStocks(req, res, next) {
  try {
    const { q = '', type = '', status = '', page, pageSize = 20 } = req.query;
    const where = {};
    if (type) where.type = type;
    if (status !== '' && status != null) where.status = Number(status);
    if (q) {
      where[Op.or] = [{ code: { [Op.like]: `%${q}%` } }, { name: { [Op.like]: `%${q}%` } }];
    }

    /* ---- 排序：默认按「序号」倒序 —— 最新发行（id / 代码最大）的排在最前面 ---- */
    const SORTABLE = new Set(['id', 'code', 'name', 'price', 'volume', 'totalShares', 'status', 'updatedAt']);
    const sortField = SORTABLE.has(String(req.query.sort || '')) ? String(req.query.sort) : 'id';
    const descByDefault = ['id', 'price', 'volume', 'updatedAt'].includes(sortField);
    const orderRaw = String(req.query.order || '').toLowerCase();
    const dir = orderRaw === 'asc' ? 'ASC'
      : orderRaw === 'desc' ? 'DESC'
        : (descByDefault ? 'DESC' : 'ASC');
    const orderClause = [[sortField, dir]];

    // 兼容旧调用：不传 page → 返回数组
    if (page === undefined) {
      const all = await Stock.findAll({ where, order: orderClause });
      ok(res, all.map(serializeAdminStock));
      return;
    }

    const { rows, count } = await Stock.findAndCountAll({
      where,
      order: orderClause,
      offset: (Number(page) - 1) * Number(pageSize),
      limit: Math.min(Number(pageSize), 100),
    });
    ok(res, { total: count, list: rows.map(serializeAdminStock) });
  } catch (err) { next(err); }
}

/**
 * 标的下拉选项（供「成分股选择」等场景）。
 * 只返回选择器需要的字段，全部标的也就十几 KB，比拉全量行情行轻得多。
 */
export async function listStockOptions(req, res, next) {
  try {
    const { type = '' } = req.query;
    const where = {};
    if (type === 'STOCK' || type === 'FUND') where.type = type;
    const rows = await Stock.findAll({
      where,
      attributes: ['id', 'code', 'name', 'type', 'status', 'price', 'avatarUrl'],
      order: [['id', 'ASC']],
    });
    ok(res, rows.map((s) => ({
      id: s.id, code: s.code, name: s.name, type: s.type,
      status: Number(s.status ?? 1), price: toNum(s.price), avatarUrl: s.avatarUrl,
    })));
  } catch (err) { next(err); }
}

/**
 * 校验并归一化成分股列表（「新建基金」与「修改成分股」共用同一套规则）。
 * 规则：数量在 fund_min_constituents ~ fund_max_constituents 之间、权重 > 0、
 *      不能把自己列为成分股、一期不允许「基金持有基金」。
 */
function normalizeConstituents(fundId, rawList, rt) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const items = [];
  for (const it of list) {
    const cid = Number(it?.constituentId);
    if (!Number.isInteger(cid) || cid <= 0) throw badRequest('成分股 id 不合法');
    if (fundId && cid === fundId) throw badRequest('基金不能把自己列为成分股');
    if (seen.has(cid)) throw badRequest('成分股重复，请去掉重复项');
    seen.add(cid);
    const w = Number(it?.weight);
    if (!Number.isFinite(w) || w <= 0) throw badRequest('权重必须是大于 0 的数字');
    items.push({ constituentId: cid, weight: roundPrice(w) });
  }
  if (items.length < rt.fundMinConstituents) {
    throw badRequest(`基金至少需要 ${rt.fundMinConstituents} 个成分股（当前 ${items.length} 个）`);
  }
  if (items.length > rt.fundMaxConstituents) {
    throw badRequest(`基金最多 ${rt.fundMaxConstituents} 个成分股（当前 ${items.length} 个）`);
  }
  return items;
}

/** 校验成分股存在且不是基金；返回 id → 当前价 的映射 */
async function loadConstituentPrices(items) {
  const targets = await Stock.findAll({ where: { id: { [Op.in]: items.map((i) => i.constituentId) } } });
  if (targets.length !== items.length) throw badRequest('存在无效的成分股 id');
  const fundOnes = targets.filter((t) => t.type === 'FUND');
  if (fundOnes.length) {
    throw badRequest(`一期暂不支持「基金持有基金」：${fundOnes.map((f) => f.name).join('、')}`);
  }
  return new Map(targets.map((t) => [Number(t.id), toNum(t.price)]));
}

/** 按权重计算加权净值 NAV = Σ(权重 × 成分股现价) / Σ权重 */
function computeNavByPrices(items, priceById) {
  const total = items.reduce((s, x) => s + Number(x.weight || 0), 0) || 1;
  const sum = items.reduce(
    (s, x) => s + Number(x.weight || 0) * (priceById.get(Number(x.constituentId)) ?? 0),
    0
  );
  return roundPrice(sum / total);
}

/** 新增标的：角色股票（STOCK）或指数基金（FUND） */
export async function createStock(req, res, next) {
  try {
    const { code, name, avatarUrl = '', price, totalShares, type = 'STOCK' } = req.body;
    if (!code || !name) throw badRequest('code 与 name 必填');
    if (!['STOCK', 'FUND'].includes(type)) throw badRequest('type 只能是 STOCK 或 FUND');
    if (!(Number(totalShares) > 0)) throw badRequest('流通份额必须大于 0');
    if (await Stock.findOne({ where: { [Op.or]: [{ code }, { name }] } })) {
      throw conflict('代码或名称已存在');
    }

    /* ---------- 指数基金：必须先定成分股，初始价 = 当时的加权净值 ----------
     * 不允许手填价格：基金的价格由成分股决定，手填必然与净值脱节，
     * 而引擎会让价格朝净值收敛 → 出现一段「每周期固定 +10%」的确定性补涨，
     * 相当于给先发现的人送无风险套利（历史事故：初始价 140 而净值 887，20 轮补涨 533%）。 */
    if (type === 'FUND') {
      const rt = settingService.getRuntime();
      if (!rt.fundEnabled) throw badRequest('当前已关闭指数基金机制，无法创建基金');
      const items = normalizeConstituents(null, req.body?.constituents, rt);
      const priceById = await loadConstituentPrices(items);
      const nav = computeNavByPrices(items, priceById);

      const fund = await sequelize.transaction(async (t) => {
        const created = await Stock.create({
          code, name, type, avatarUrl,
          price: nav, prevClose: nav, open: nav, high: nav, low: nav,
          volume: 0, totalShares: Number(totalShares), nav,
        }, { transaction: t });
        await FundConstituent.bulkCreate(
          items.map((i) => ({ fundId: created.id, constituentId: i.constituentId, weight: i.weight })),
          { transaction: t }
        );
        return created;
      });
      invalidateFundGraph(); // 让价格引擎下一轮立即采用新成分

      log(req, 'ADMIN_CREATE_FUND', { code, name, nav, count: items.length });
      ok(res, { id: fund.id, type, nav, count: items.length },
        `指数基金创建成功：已按当前成分股加权净值自动定价 ${nav} 摩拉`);
      return;
    }

    if (!(toNum(price) > 0)) throw badRequest('初始价格必须大于 0');
    const p = roundPrice(Number(price));
    const stock = await Stock.create({
      code, name, type, avatarUrl,
      price: p, prevClose: p, open: p, high: p, low: p,
      volume: 0, totalShares: Number(totalShares),
      nav: null,
    });
    log(req, 'ADMIN_CREATE_STOCK', { code, name });
    ok(res, { id: stock.id, type }, '角色股票创建成功');
  } catch (err) { next(err); }
}

/** 编辑角色股票（改价格会重置当日开盘基准；改流通股数） */
export async function updateStock(req, res, next) {
  try {
    const id = Number(req.params.id);
    const stock = await Stock.findByPk(id);
    if (!stock) throw notFound('标的不存在');
    const isRoot = req.user.role === 'root';
    const { code, name, avatarUrl, price, totalShares, prevClose, status } = req.body;
    const actions = [];
    let cancelledOrders = 0;

    /* ① 代码：仅超级管理员可改；提交时查重，重复直接报错不落库 */
    if (code != null && String(code).trim() !== '') {
      const nextCode = String(code).trim().toUpperCase();
      if (nextCode !== stock.code) {
        if (!isRoot) throw forbidden('仅超级管理员可修改标的代码');
        if (!/^[A-Z0-9_-]{2,16}$/.test(nextCode)) {
          throw badRequest('代码只能由 2~16 位字母 / 数字 / 下划线 / 连字符组成');
        }
        const dup = await Stock.findOne({ where: { code: nextCode, id: { [Op.ne]: id } } });
        if (dup) throw conflict(`代码「${nextCode}」已被「${dup.name}」占用，请换一个`);
        actions.push(`代码 ${stock.code} → ${nextCode}`);
        stock.code = nextCode;
      }
    }

    if (name != null && String(name).trim() !== stock.name) {
      const nextName = String(name).trim();
      const dupName = await Stock.findOne({ where: { name: nextName, id: { [Op.ne]: id } } });
      if (dupName) throw conflict(`名称「${nextName}」已被「${dupName.code}」占用，请换一个`);
      actions.push(`名称 ${stock.name} → ${nextName}`);
      stock.name = nextName;
    }

    if (avatarUrl != null) stock.avatarUrl = avatarUrl;

    if (price != null) {
      const p = roundPrice(Number(price));
      if (!(p > 0)) throw badRequest('价格必须大于 0');
      // 管理员改价视为人工干预：同步昨收/今开基准
      stock.price = p;
      if (prevClose != null) stock.prevClose = roundPrice(Number(prevClose));
      stock.open = p; stock.high = Math.max(toNum(stock.high), p); stock.low = Math.min(toNum(stock.low), p);
      actions.push(`价格 → ${p}`);
    }

    if (totalShares != null) {
      if (!(Number(totalShares) > 0)) throw badRequest('流通份额必须大于 0');
      stock.totalShares = Number(totalShares);
      actions.push(`流通份额 → ${Number(totalShares)}`);
    }

    /* ② 单标的状态：1 正常 / 0 停牌 / 2 退市 */
    let goingDelist = false;
    if (status != null) {
      const s = Number(status);
      if (![0, 1, 2].includes(s)) throw badRequest('状态只能是 0（停牌）/ 1（正常）/ 2（退市）');
      if (s !== Number(stock.status)) {
        if (s === 2) {
          goingDelist = true;
          actions.push('退市');
        } else if (s === 0) {
          stock.status = 0;
          actions.push('暂停交易（停牌）');
        } else {
          stock.status = 1;
          actions.push('恢复正常交易');
        }
      }
    }

    /* ③ 一次性落库；退市时同事务内撤销全部未成交挂单并解冻资金/股份 */
    await sequelize.transaction(async (t) => {
      if (goingDelist) {
        cancelledOrders = await cancelAllPendingOrders(id, t);
        stock.status = 2;
      }
      await stock.save({ transaction: t });
    });

    log(req, goingDelist ? 'ADMIN_DELIST_STOCK' : 'ADMIN_UPDATE_STOCK', {
      id: stock.id, code: stock.code, status: stock.status,
      changes: actions.length ? actions : undefined,
      cancelledOrders: goingDelist ? cancelledOrders : undefined,
    });

    const msg = goingDelist
      ? `已退市：撤销了 ${cancelledOrders} 笔未成交挂单并已解冻`
      : (actions.length ? '更新成功：' + actions.join('，') : '更新成功');
    ok(res, { id: stock.id, code: stock.code, status: stock.status, cancelledOrders }, msg);
  } catch (err) { next(err); }
}

/**
 * 删除角色股票（★ 仅超级管理员）。
 *
 * 注意（本次修复）：旧实现只清理 orders/holdings/trades/watchlists，
 * 漏掉了 news_stocks 与 price_history，而且没有事务；一旦有残留引用，
 * 「我的」页面读取持仓时会因关联不到股票而 500。
 * 现在：①有持仓或未成交挂单时拒绝删除（避免静默清掉用户资产）；
 *       ②所有关联表在同一事务内清理干净，不再产生孤儿数据。
 *
 * ★ 权限收紧（2026-09-12）：这是最危险的一个接口 —— 它会连带物理删除该标的的
 * 全部成交记录（下面那句 Trade.destroy），而成交记录是审计凭证。
 * 管理员（admin）已无权调用，只能用「停牌 / 退市」这两个保留数据的动作；
 * 路由层 requireRole('root') + 这里 assertCanDelete() 双保险。
 */
export async function deleteStock(req, res, next) {
  try {
    assertCanDelete(req);
    const id = Number(req.params.id);
    const stock = await Stock.findByPk(id);
    if (!stock) throw notFound('股票不存在');

    // 保护：还有用户持仓或未成交挂单时不允许删除
    const [holdingsCnt, pendingCnt] = await Promise.all([
      Holding.count({ where: { stockId: id, quantity: { [Op.gt]: 0 } } }),
      Order.count({ where: { stockId: id, status: 'PENDING' } }),
    ]);
    if (holdingsCnt > 0 || pendingCnt > 0) {
      throw conflict(
        `该角色仍有 ${holdingsCnt} 个持仓、${pendingCnt} 笔未成交挂单，无法删除。` +
        '请先让相关用户平仓/撤单，或先删除对应成交记录。'
      );
    }

    await sequelize.transaction(async (t) => {
      await Order.destroy({ where: { stockId: id }, transaction: t });
      await Holding.destroy({ where: { stockId: id }, transaction: t });
      // 持仓批次（最少持有周期）也要一起清掉，避免留下孤儿行
      await HoldingLot.destroy({ where: { stockId: id }, transaction: t });
      await Trade.destroy({ where: { stockId: id }, transaction: t });
      await Watchlist.destroy({ where: { stockId: id }, transaction: t });
      await NewsStock.destroy({ where: { stockId: id }, transaction: t });
      await PriceHistory.destroy({ where: { stockId: id }, transaction: t });
      await stock.destroy({ transaction: t });
    });

    log(req, 'ADMIN_DELETE_STOCK', { id, name: stock.name });
    invalidateFundGraph(); // 成分股/基金被删除后，价格引擎立刻重建传导图
    ok(res, { id }, '已删除');
  } catch (err) { next(err); }
}

/* ================= 指数基金成分股 ================= */

/** 成分股规则（供「新建基金」对话框在还没有基金 id 时拿到 min/max 限制） */
export async function fundRules(req, res, next) {
  try {
    const rt = settingService.getRuntime();
    ok(res, {
      min: rt.fundMinConstituents,
      max: rt.fundMaxConstituents,
      fundEnabled: rt.fundEnabled,
    });
  } catch (err) { next(err); }
}

/** 查看某基金的全部成分股与权重 */
export async function listFundConstituents(req, res, next) {
  try {
    const fundId = Number(req.params.id);
    const fund = await Stock.findByPk(fundId);
    if (!fund) throw notFound('基金不存在');
    if (fund.type !== 'FUND') throw badRequest('该标的不是指数基金');

    const rows = await FundConstituent.findAll({
      where: { fundId },
      include: [{ model: Stock, as: 'constituent', attributes: ['id', 'code', 'name', 'type', 'price', 'avatarUrl'] }],
      order: [['weight', 'DESC']],
    });
    const total = rows.reduce((s, r) => s + Number(r.weight), 0) || 1;
    const rt = settingService.getRuntime();

    ok(res, {
      fund: {
        id: fund.id, code: fund.code, name: fund.name, type: fund.type,
        price: toNum(fund.price), nav: fund.nav == null ? null : toNum(fund.nav),
      },
      list: rows.map((r) => ({
        constituentId: r.constituentId,
        code: r.constituent?.code ?? null,
        name: r.constituent?.name ?? '(已下架)',
        type: r.constituent?.type ?? null,
        price: r.constituent ? toNum(r.constituent.price) : 0,
        weight: Number(r.weight),
        weightPct: Math.round((Number(r.weight) / total) * 10000) / 100,
      })),
      totalWeight: total,
      rules: { min: rt.fundMinConstituents, max: rt.fundMaxConstituents, fundEnabled: rt.fundEnabled },
    });
  } catch (err) { next(err); }
}

/**
 * 整体覆盖某基金的成分股与权重（先清后建，同事务）。
 * 校验：数量 fund_min~fund_max、权重 > 0、不能含自己、一期不允许「基金持有基金」。
 * 保存后立即把基金价格对齐到新的加权净值（避免重复出现确定性补涨/补跌）。
 */
export async function updateFundConstituents(req, res, next) {
  try {
    const fundId = Number(req.params.id);
    const fund = await Stock.findByPk(fundId);
    if (!fund) throw notFound('基金不存在');
    if (fund.type !== 'FUND') throw badRequest('只有指数基金才能配置成分股');

    const rt = settingService.getRuntime();
    const items = normalizeConstituents(fundId, req.body?.constituents, rt);
    const priceById = await loadConstituentPrices(items);

    await sequelize.transaction(async (t) => {
      await FundConstituent.destroy({ where: { fundId }, transaction: t });
      await FundConstituent.bulkCreate(
        items.map((i) => ({ fundId, constituentId: i.constituentId, weight: i.weight })),
        { transaction: t }
      );
    });
    invalidateFundGraph(); // 让价格引擎下一轮立即采用新成分，不必等缓存过期

    // 成分股变了 → 净值也变了 → 立刻把价格对齐到新净值。
    // 若不这样做，引擎会从旧价格朝新净值「收敛」，同样会形成一段确定性的补涨/补跌（可被无风险套利）。
    const nav = computeNavByPrices(items, priceById);
    const beforePrice = toNum(fund.price);
    fund.price = nav;
    fund.nav = nav;
    fund.high = Math.max(toNum(fund.high) || nav, nav);
    fund.low = Math.min(toNum(fund.low) || nav, nav);
    await fund.save();

    log(req, 'ADMIN_UPDATE_FUND', { fundId, name: fund.name, count: items.length, nav, beforePrice });
    ok(res, { fundId, count: items.length, nav, priceBefore: beforePrice },
      `基金成分股已更新，价格已按新净值对齐：${beforePrice} → ${nav}`);
  } catch (err) { next(err); }
}

/* ================= 盈亏报表导出（仅超级管理员） ================= */

/**
 * 计算并返回最近 N 天内所有用户的盈亏（JSON，前端直接生成 CSV）。
 *
 * 计算口径（不依赖历史快照，用「当前状态 − 窗口内变动」反推期初）：
 *   期末资产 = Σ(当前持仓数量 × 当前价) + 可用摩拉 + 冻结摩拉
 *   期初持仓 = 当前持仓数量 − 窗口内成交净买入量        （成交是持仓的唯一变动来源）
 *   期初现金 = 期末现金 − 窗口内成交净现金流 − 窗口内管理员调整额
 *              （卖出净现金流按「到账金额」计，即已扣掉卖方印花税）
 *   盈亏     = 期末资产 − 期初资产
 *
 * 性能：固定 6 条查询，全部走索引；聚合在数据库侧完成（GROUP BY），
 *       JS 只处理「用户数 × 涉及标的数」量级的行，实测 100 用户 < 100ms。
 *       仅在管理员点击时执行，无任何后台开销。
 */
export async function pnlReport(req, res, next) {
  try {
    const days = [3, 7, 14].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
    const period = settingService.klinePeriod();

    /* ① 用户 */
    const users = await User.findAll({
      attributes: ['id', 'username', 'nickname', 'mora', 'frozenMora', 'createdAt'],
      raw: true,
    });

    /* ② 当前持仓 + 当前价 */
    const holdingRows = await Holding.findAll({
      attributes: ['userId', 'stockId', 'quantity'],
      raw: true,
    });
    const stockRows = await Stock.findAll({
      attributes: ['id', 'price', 'status'],
      raw: true,
    });
    const priceNow = new Map(stockRows.map((s) => [Number(s.id), toNum(s.price)]));

    /* ③ 期初价格：每只标的在 from 之前最后一根 K 线的收盘价 */
    const [beforeRows] = await sequelize.query(
      `SELECT ph.stock_id AS stockId, ph.close AS close
         FROM price_history ph
         JOIN (SELECT stock_id, MAX(ts) AS mts FROM price_history
                WHERE period = ? AND ts <= ? GROUP BY stock_id) t
           ON t.stock_id = ph.stock_id AND t.mts = ph.ts AND ph.period = ?`,
      { replacements: [period, from, period] }
    );
    const priceBefore = new Map(beforeRows.map((r) => [Number(r.stockId), Number(r.close)]));

    // 历史不足（3 天前还没有 K 线）时，用该标的最早一根 K 线兜底，比直接用现价更接近期初
    if (priceBefore.size < stockRows.length) {
      const [earlyRows] = await sequelize.query(
        `SELECT ph.stock_id AS stockId, ph.close AS close
           FROM price_history ph
           JOIN (SELECT stock_id, MIN(ts) AS mts FROM price_history
                  WHERE period = ? GROUP BY stock_id) t
             ON t.stock_id = ph.stock_id AND t.mts = ph.ts AND ph.period = ?`,
        { replacements: [period, period] }
      );
      for (const r of earlyRows) {
        const sid = Number(r.stockId);
        if (!priceBefore.has(sid)) priceBefore.set(sid, Number(r.close));
      }
    }

    /* ④ 窗口内成交聚合（数据库侧 GROUP BY，最多 用户数 × 标的数 行） */
    const [tradeRows] = await sequelize.query(
      `SELECT user_id AS userId, stock_id AS stockId, side,
              SUM(quantity) AS qty, SUM(amount) AS amt, SUM(fee) AS fee
         FROM trades
        WHERE matched_at > ?
        GROUP BY user_id, stock_id, side`,
      { replacements: [from] }
    );

    /* ⑤ 窗口内管理员手动调整的摩拉（视为外部注资/抽资，不计入盈亏） */
    const [moraLogRows] = await sequelize.query(
      `SELECT user_id AS userId, detail AS detail
         FROM operation_logs
        WHERE action = 'ADMIN_UPDATE_USER' AND created_at > ? AND user_id IS NOT NULL`,
      { replacements: [from] }
    );
    const injected = new Map();
    for (const r of moraLogRows) {
      try {
        const d = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
        if (d && d.mora != null) {
          const uid = Number(r.userId);
          injected.set(uid, (injected.get(uid) || 0) + Number(d.mora));
        }
      } catch { /* 忽略解析失败 */ }
    }

    /* ⑥ 内存汇总 */
    const byUser = new Map();
    for (const u of users) {
      byUser.set(Number(u.id), {
        userId: Number(u.id),
        nickname: u.nickname || u.username,
        createdAt: u.createdAt,
        cashNow: round2(toNum(u.mora) + toNum(u.frozenMora)),
        curQty: new Map(),
        qtyDelta: new Map(),
        cashDelta: 0,
        mvNow: 0,
      });
    }
    // 当前持仓市值
    for (const h of holdingRows) {
      const e = byUser.get(Number(h.userId));
      if (!e) continue;
      const qty = Number(h.quantity) || 0;
      e.curQty.set(Number(h.stockId), (e.curQty.get(Number(h.stockId)) || 0) + qty);
    }
    // 窗口内成交 → 数量/现金变动
    for (const t of tradeRows) {
      const e = byUser.get(Number(t.userId));
      if (!e) continue;
      const sid = Number(t.stockId);
      const qty = Number(t.qty) || 0;
      const amt = Number(t.amt) || 0;
      const fee = Number(t.fee) || 0;
      if (t.side === 'BUY') {
        e.qtyDelta.set(sid, (e.qtyDelta.get(sid) || 0) + qty);
        e.cashDelta -= amt;   // 买入扣现金（买方不缴印花税）
      } else {
        e.qtyDelta.set(sid, (e.qtyDelta.get(sid) || 0) - qty);
        e.cashDelta += amt - fee;   // 卖出入现金 = 成交额 − 卖方印花税
      }
    }

    const rows = [];
    let excludedNewUsers = 0;
    for (const e of byUser.values()) {
      // 窗口内新注册用户没有期初资产，参与排名会失真，故排除（数量单独返回）
      if (e.createdAt && new Date(e.createdAt) > from) { excludedNewUsers++; continue; }

      let mvNow = 0;
      for (const [sid, qty] of e.curQty) mvNow += qty * (priceNow.get(sid) ?? 0);
      mvNow = round2(mvNow);

      let mvBefore = 0;
      const stockIds = new Set([...e.curQty.keys(), ...e.qtyDelta.keys()]);
      for (const sid of stockIds) {
        const qtyBefore = Math.max(0, (e.curQty.get(sid) || 0) - (e.qtyDelta.get(sid) || 0));
        mvBefore += qtyBefore * (priceBefore.get(sid) ?? priceNow.get(sid) ?? 0);
      }
      mvBefore = round2(mvBefore);

      const cashBefore = round2(e.cashNow - e.cashDelta - (injected.get(e.userId) || 0));
      const totalNow = round2(mvNow + e.cashNow);
      const totalBefore = round2(mvBefore + cashBefore);
      rows.push({
        userId: e.userId,
        nickname: e.nickname,
        mvBefore,
        cashBefore,
        mvAfter: mvNow,
        cashAfter: e.cashNow,
        profit: round2(totalNow - totalBefore),
        profitPct: totalBefore > 0 ? Math.round(((totalNow - totalBefore) / totalBefore) * 10000) / 100 : 0,
      });
    }

    rows.sort((a, b) => b.profit - a.profit);
    rows.forEach((r, i) => { r.rank = i + 1; });

    const totalProfit = round2(rows.reduce((s, r) => s + r.profit, 0));
    ok(res, {
      days,
      from,
      to,
      period,
      users: rows.length,
      excludedNewUsers,
      totalProfit,
      list: rows,
    });
  } catch (err) { next(err); }
}

/* ================= 交易与日志 ================= */

/** 全量成交记录（管理员审计） */
export async function listTrades(req, res, next) {
  try {
    const { q = '', page = 1, pageSize = 20 } = req.query;
    const where = {};
    if (q) {
      const users = await User.findAll({ where: { username: { [Op.like]: `%${q}%` } }, attributes: ['id'] });
      where.userId = { [Op.in]: users.length ? users.map((u) => u.id) : [-1] };
    }
    const { rows, count } = await Trade.findAndCountAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['username', 'nickname'] },
        { model: Stock, as: 'stock', attributes: ['code', 'name'] },
      ],
      order: [['matchedAt', 'DESC']],
      offset: (Number(page) - 1) * Number(pageSize),
      limit: Math.min(Number(pageSize), 100),
    });
    ok(res, {
      total: count,
      list: rows.map((t) => ({
        id: t.id, username: t.user?.username, nickname: t.user?.nickname,
        stockCode: t.stock?.code, stockName: t.stock?.name,
        side: t.side, price: toNum(t.price), quantity: t.quantity,
        amount: toNum(t.amount), matchedAt: t.matchedAt, userId: t.userId,
        // 审计用：印花税 / 卖出成本 / 税后平仓盈亏
        fee: toNum(t.fee),
        costAmount: toNum(t.costAmount),
        realizedProfit: toNum(t.realizedProfit),
      })),
    });
  } catch (err) { next(err); }
}

/**
 * 删除一条成交记录（★ 仅超级管理员）。
 *
 * ★ 权限收紧（2026-09-12）：成交记录是审计凭证（且是定价引擎的压力因子数据源），
 * 管理员一律不可删除、也没有任何「失效」替代动作 —— 管理端界面对 admin 不再出现删除按钮。
 * 只有超级管理员在极端情况（脏数据修复）下可以删，且必定留下 ADMIN_DELETE_TRADE 审计。
 */
export async function deleteTrade(req, res, next) {
  try {
    assertCanDelete(req);
    const trade = await Trade.findByPk(Number(req.params.id));
    if (!trade) throw notFound('记录不存在');
    await trade.destroy();
    log(req, 'ADMIN_DELETE_TRADE', { id: trade.id });
    ok(res, { id: trade.id }, '已删除');
  } catch (err) { next(err); }
}

/** 操作日志 */
export async function listLogs(req, res, next) {
  try {
    const { page = 1, pageSize = 20 } = req.query;
    const { rows, count } = await OperationLog.findAndCountAll({
      include: [{ model: User, as: 'operator', attributes: ['username'] }],
      order: [['createdAt', 'DESC']],
      offset: (Number(page) - 1) * Number(pageSize),
      limit: Math.min(Number(pageSize), 100),
    });
    ok(res, {
      total: count,
      list: rows.map((l) => ({
        id: l.id, username: l.operator?.username ?? null, userId: l.userId,
        action: l.action, detail: safeJson(l.detail), ip: l.ip,
        userAgent: l.userAgent ?? null, createdAt: l.createdAt,
      })),
    });
  } catch (err) { next(err); }
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return s; }
}

/* ================= 系统性能监控（root 控制面板） ================= */

/**
 * 读取性能数据。
 * 默认返回「降采样后的历史序列」；带 ?since=<时间戳> 时只返回增量样本 ——
 * 面板自动刷新走增量（通常 0~1 个点、响应约 1KB），点「刷新」走全量。
 * 数据全部来自内存环形缓冲，**这个接口本身不查数据库**。
 */
export async function getPerf(req, res, next) {
  try {
    const since = Number(req.query.since) || 0;
    const points = Math.max(10, Math.min(1440, Number(req.query.points) || 240));
    ok(res, perfService.getPerfData({ since, points }));
  } catch (err) { next(err); }
}

/**
 * 手动刷新：立刻采一次样再返回。
 * 关闭「持续监控」时这就是「只看一眼」模式 —— 只有你点的时候才产生一次采样。
 */
export async function refreshPerf(req, res, next) {
  try {
    await perfService.sampleOnce('manual');
    const points = Math.max(10, Math.min(1440, Number(req.query.points) || 240));
    ok(res, perfService.getPerfData({ since: 0, points }));
  } catch (err) { next(err); }
}

/* ================= 系统设置（root 控制面板） ================= */

/** 读取全部系统开关（供 root 控制面板展示） */
export async function listSettings(req, res, next) {
  try {
    const items = await settingService.listAllWithMeta();
    ok(res, items);
  } catch (err) { next(err); }
}

/** 写入系统开关：body { key, value }，value 限 '0'/'1' */
/**
 * 写入系统设置：body { key, value }
 * 支持三类：bool（0/1）、number（带 min/max 校验）、text（公告 / NGA 密钥等）。
 * 具体校验与归一化交给 settingService.normalizeSettingValue，避免两处规则不一致。
 *
 * 敏感项（secret: true，如 Gemini API Key / NGA Cookie）：
 *   · 列表接口只返回掩码，前端原样回传时视为「未修改」，不会把掩码写成真值；
 *   · 审计日志只记「已更新（长度 N）」，绝不落密钥明文。
 */
export async function updateSetting(req, res, next) {
  try {
    const { key, value } = req.body;
    if (!key) throw badRequest('缺少设置项 key');
    const all = await settingService.listAllWithMeta();
    const target = all.find((s) => s.key === key);
    if (!target) throw badRequest('未知的设置项');
    if (target.readonly) throw badRequest(`「${target.label}」由脚本自动维护，不能手动修改`);

    const masked = settingService.isMaskedValue(value);
    const strValue = String(value ?? '');

    // 掩码回传 = 用户没改这一栏，直接返回当前值，不写库也不报错
    if (masked) {
      return ok(res, { key, value: target.value, unchanged: true }, '未修改（密钥保持原值）');
    }

    let row;
    try {
      row = await settingService.setSetting(key, value, req.user.id);
    } catch (e) {
      // settingService 抛的是带 status 的普通对象错误，这里转成业务错误
      throw badRequest(e.message || '设置值不合法');
    }

    // bool 写 '1'/'0'，number 写数字字符串，文本只记长度，敏感项额外脱敏
    let auditValue;
    if (target.secret) auditValue = `(敏感 已更新 长度 ${strValue.length})`;
    else if (target.type === 'text') auditValue = `(文本 ${String(row.value).length} 字)`;
    else auditValue = row.value;

    log(req, 'ADMIN_UPDATE_SETTING', { key, value: auditValue });
    ok(res, { key, value: target.secret ? target.value : row.value }, '设置已更新');
  } catch (err) { next(err); }
}

/* ================= NGA 舆情：立即抓取 ================= */

/**
 * 手动触发一次 NGA 舆情分析（root 面板的「立即抓取」按钮）。
 *
 * 立即返回，不等脚本跑完：脚本是独立 Python 进程（约 3~30 秒），
 * 结果由它自己回写 system_settings 的 nga_health_*，前端轮询那几个字段即可。
 * 会绕过面板的「分析间隔」门控（--force），但**不绕过总开关**：
 * 开关关着时直接拒绝，避免"我以为关了就绝对不抓"的预期被按钮打破。
 *
 * ★ 2026-09-15：手动抓取固定带 `--dump`，脚本会顺手把「01 原文 + 03 总结论提示词 +
 *   06 本轮汇总」去重合并成一个快照文件，供「下载抓取快照」按钮取走（见 downloadNgaDump）。
 *   定时运行不带这个参数，避免每 5 分钟写一堆没人看的文件。
 */
export async function runNgaAnalysis(req, res, next) {
  try {
    const status = ngaRun.getRunStatus();
    if (status.running) {
      throw conflict('已有一次抓取正在运行（pid ' + status.pid + '），请等它结束');
    }
    const enabled = await settingService.getSetting('nga_analysis_enabled');
    if (!['1', 'true'].includes(String(enabled))) {
      throw badRequest('NGA 舆情分析当前处于「关闭」状态：请先打开「启用 NGA 舆情分析」，或直接用它定时跑');
    }
    let started;
    try {
      started = ngaRun.startRun({ force: true, dump: true });
    } catch (e) {
      if (e.status === 409) throw conflict(e.message);
      throw badRequest(e.message);
    }
    log(req, 'ADMIN_NGA_RUN_NOW', { pid: started.pid, script: started.script, dump: true });
    ok(res, {
      startedAt: started.startedAt,
      pid: started.pid,
      script: started.script,
      python: started.python,
      dump: true,
    }, '已触发抓取，正在后台运行（约 3~30 秒）；完成后可点「下载抓取快照」查看本轮抓了什么');
  } catch (err) { next(err); }
}

/** 手动抓取的运行状态（排障用；前端正常走 nga_health_* 字段） */
export async function ngaRunStatus(req, res, next) {
  try {
    ok(res, ngaRun.getRunStatus());
  } catch (err) { next(err); }
}

/**
 * 下载最近一次手动抓取生成的「抓取快照」（root 面板的「下载抓取快照」按钮）。
 *
 * 文件由 Python 脚本在 --dump 时写到「脚本同级的 dumps/」下：
 *   nga-dump-<时间戳>.txt（历史留档，最多 10 份）
 *   nga-dump-latest.txt （稳定名字，本接口固定读它）
 *
 * 直接以附件流返回，**不套 { code, message, data } 信封**（浏览器要拿到原始文件）。
 * ?name=nga-dump-20260915-210730.txt 可以指定取某一份历史快照（只允许文件名，防目录穿越）。
 */
export async function downloadNgaDump(req, res, next) {
  try {
    const info = ngaRun.findDumpFile(req.query.name ? String(req.query.name) : '');
    if (!info) {
      throw notFound('还没有抓取快照。请先点「立即抓取」（手动抓取会自动生成一份快照）');
    }
    log(req, 'ADMIN_NGA_DUMP_DOWNLOAD', { file: info.filename, bytes: info.size });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${info.filename}"; filename*=UTF-8''${encodeURIComponent(info.filename)}`);
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(info.path);
  } catch (err) { next(err); }
}
