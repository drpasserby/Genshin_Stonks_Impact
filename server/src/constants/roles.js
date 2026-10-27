/**
 * ============ 身份组（角色）定义 —— 唯一真源 ============
 *
 * 数据库里的真实取值见 users.role 的 ENUM 与 server/sql/init.sql。
 * 任何地方需要判断身份，都从这里取，不要再写角色字符串字面量。
 *
 * | 键                | 值                | 中文名     | 获取方式        | 说明 |
 * |-------------------|-------------------|-----------|----------------|------|
 * | USER              | user              | 普通用户   | 注册即得        | 与最初版本一致 |
 * | VIP               | vip               | 高级用户   | 管理员赋予      | 交易权限同普通用户，但**免卖方印花税** |
 * | STAR              | star              | 明星       | 管理员赋予      | 交易权限同普通用户，但**强制公开持仓 + 强制参与排行榜** |
 * | OPERATOR          | operator          | 操作员     | 管理员赋予      | 与最初版本一致；发布的新闻**需要审核**后才生效 |
 * | SENIOR_OPERATOR   | senior_operator   | 高级操作员 | 管理员赋予      | 操作员全部权限 + 发布新闻**无需审核、直接生效** |
 * | ADMIN             | admin             | 管理员     | 仅超级管理员    | 受限管理员：**不能执行任何删除类操作**（见下） |
 * | ROOT              | root              | 超级管理员 | 仅超级管理员    | 权限与最初版本完全一致（不受删除限制） |
 *
 * 【删除类操作的总规则】
 *   只有 root 能物理删除数据。admin 只能用「非破坏性替代动作」：
 *     · 用户   → 禁用/启用（status 0/1），不能注销（status=2）
 *     · 新闻   → 立刻失效（把 expires_at 置为当前时间），不能删除
 *     · 标的   → 停牌（status=0）/ 退市（status=2），不能删除
 *     · 成交记录 → 完全不提供任何操作（审计凭证，不可变）
 *
 * 【等级 LEVEL 的唯一用途】
 *   判断「普通管理员能不能动这个账号 / 能不能赋予这个身份」：
 *   规则是「不能操作等级 ≥ 自己的账号，也不能赋予等级 ≥ 自己的身份」。
 *   它不是权限列表，真正的接口权限由 routes/*.js 的 requireRole 决定。
 */

export const ROLES = {
  USER: 'user',
  VIP: 'vip',
  STAR: 'star',
  OPERATOR: 'operator',
  SENIOR_OPERATOR: 'senior_operator',
  ADMIN: 'admin',
  ROOT: 'root',
};

/** 全部合法角色（顺序 = 面板下拉顺序，从低到高） */
export const VALID_ROLES = [
  ROLES.USER,
  ROLES.VIP,
  ROLES.STAR,
  ROLES.OPERATOR,
  ROLES.SENIOR_OPERATOR,
  ROLES.ADMIN,
  ROLES.ROOT,
];

/** 角色 → 中文名（前端也有一份用于展示，见 web/src/utils/format.ts） */
export const ROLE_LABELS = {
  [ROLES.USER]: '普通用户',
  [ROLES.VIP]: '高级用户',
  [ROLES.STAR]: '明星',
  [ROLES.OPERATOR]: '操作员',
  [ROLES.SENIOR_OPERATOR]: '高级操作员',
  [ROLES.ADMIN]: '管理员',
  [ROLES.ROOT]: '超级管理员',
};

/**
 * 角色等级（只增不减，仅用于「同级/更高等级不可操作」这一条不变量）。
 * 注意 vip / star / operator 同为 1：三者是平级的「普通用户增强版」，
 * 只是增强方向不同（免税 / 公开持仓 / 运营权限），没有高低之分。
 */
export const LEVEL = {
  [ROLES.USER]: 0,
  [ROLES.VIP]: 1,
  [ROLES.STAR]: 1,
  [ROLES.OPERATOR]: 1,
  [ROLES.SENIOR_OPERATOR]: 2,
  [ROLES.ADMIN]: 3,
  [ROLES.ROOT]: 4,
};

/** 取角色等级；未知角色返回 -1（比 user 还低，保证不会被误判为高权限） */
export function levelOf(role) {
  const n = LEVEL[role];
  return Number.isFinite(n) ? n : -1;
}

/** 是否合法角色 */
export function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

/* ---------------- 交易相关 ---------------- */

/**
 * 是否免卖方印花税。
 * 目前只有「高级用户」享受；这是本身份组唯一的特殊待遇。
 */
export function isStampTaxExempt(role) {
  return role === ROLES.VIP;
}

/**
 * 是否强制公开持仓（明星）。
 * 强制公开的账号同时强制参与排行榜 —— 既然是公开身份，就不该在榜上隐身。
 */
export function mustPublicizeHoldings(role) {
  return role === ROLES.STAR;
}

/* ---------------- 新闻相关 ---------------- */

/** 能否发布新闻（操作员及以上） */
export function canPublishNews(role) {
  return [ROLES.OPERATOR, ROLES.SENIOR_OPERATOR, ROLES.ADMIN, ROLES.ROOT].includes(role);
}

/** 发布新闻是否无需审核（高级操作员及以上；普通操作员发的新闻进入待审） */
export function canPublishNewsWithoutReview(role) {
  return [ROLES.SENIOR_OPERATOR, ROLES.ADMIN, ROLES.ROOT].includes(role);
}

/** 能否审核新闻（管理员及以上） */
export function canReviewNews(role) {
  return [ROLES.ADMIN, ROLES.ROOT].includes(role);
}

/* ---------------- 删除相关 ---------------- */

/** 能否执行物理删除（仅超级管理员，与最初版本一致） */
export function canDeleteData(role) {
  return role === ROLES.ROOT;
}

export default {
  ROLES,
  VALID_ROLES,
  ROLE_LABELS,
  LEVEL,
  levelOf,
  isValidRole,
  isStampTaxExempt,
  mustPublicizeHoldings,
  canPublishNews,
  canPublishNewsWithoutReview,
  canReviewNews,
  canDeleteData,
};
