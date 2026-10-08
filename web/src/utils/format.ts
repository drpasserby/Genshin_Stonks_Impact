/** 展示层格式化工具 */

/** 千分位 + 保留位数 */
export function fmtNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 股价 */
export const fmtPrice = (n: number | null | undefined) => fmtNumber(n, 2);

/** 带符号的涨跌额/幅：+1.23 / -0.45% */
export function fmtSigned(n: number | null | undefined, suffix = '', digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}${suffix}`;
}

/** 大数缩写：1.2万 / 3.4亿 */
export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  const v = Number(n);
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return v.toLocaleString('zh-CN');
}

/** 日期时间 YYYY-MM-DD HH:mm */
export function fmtTime(input: string | Date | number | null | undefined): string {
  if (!input) return '-';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 只显示日期 */
export function fmtDate(input: string | Date | number | null | undefined): string {
  if (!input) return '-';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 身份组中文名。与后端 constants/roles.js 的 ROLE_LABELS 保持一致；
 * 未知角色回退显示原始值（不会崩，但会暴露漏配 —— 新增身份组时记得同步这里）。
 */
export function roleLabel(role: string): string {
  const map: Record<string, string> = {
    user: '普通用户',
    vip: '高级用户',
    star: '明星',
    operator: '操作员',
    senior_operator: '高级操作员',
    admin: '管理员',
    root: '超级管理员',
  };
  return map[role] || role;
}

/** 角色标签颜色（Element tag type）。只有 5 种颜色，同色系靠文字区分 */
export function roleTagType(role: string): string {
  const map: Record<string, string> = {
    user: 'info',
    vip: 'success',
    star: 'warning',
    operator: 'primary',
    senior_operator: 'primary',
    admin: 'danger',
    root: 'danger',
  };
  return map[role] || 'info';
}

/** 身份组一句话说明（管理端下拉/关于页用） */
export function roleHint(role: string): string {
  const map: Record<string, string> = {
    user: '注册即得，基础交易权限',
    vip: '与普通用户相同，但免卖方印花税',
    star: '与普通用户相同，但强制公开持仓与参与排行榜',
    operator: '可发布新闻（需管理员审核）与投票',
    senior_operator: '操作员权限，且发布新闻无需审核、直接生效',
    admin: '管理用户/标的/新闻，但不能删除任何数据',
    root: '全部权限（含删除数据、系统控制面板）',
  };
  return map[role] || '';
}

/** 新闻审核状态 → 中文名 */
export function newsReviewLabel(status?: string | null): string {
  const map: Record<string, string> = { PENDING: '待审核', APPROVED: '已通过', REJECTED: '已驳回' };
  return status ? (map[status] || status) : '-';
}

/** 新闻审核状态 → Element tag type */
export function newsReviewTagType(status?: string | null): string {
  const map: Record<string, string> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'info' };
  return status ? (map[status] || 'info') : 'info';
}

/** 涨跌幅着色 class */
export function changeClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'flat';
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}
