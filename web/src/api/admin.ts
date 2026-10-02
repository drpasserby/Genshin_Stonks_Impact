import { get, post, put, del, download } from './http';
import type { User, Paged, TradeItem, Role, RoleOption, Direction, NewsItem, NewsReviewStatus } from '@/types';

export interface AdminNewsPayload {
  title: string;
  sourceUrl: string;
  direction: Direction;
  strength: number;
  stockIds: number[];
  renew?: boolean;
}

export const apiAdminCreateNews = (data: Omit<AdminNewsPayload, 'renew'>) =>
  post<{ id: number; expiresAt: string | null; reviewStatus: NewsReviewStatus; pending: boolean }>(
    '/admin/news', data
  );

export const apiAdminUpdateNews = (id: number, data: AdminNewsPayload) =>
  put<{ id: number; reviewStatus: NewsReviewStatus }>(`/admin/news/${id}`, data);

/** 物理删除新闻（★ 仅超级管理员；管理员请用 apiAdminExpireNews） */
export const apiAdminDeleteNews = (id: number) => del<{ id: number }>(`/admin/news/${id}`);

/**
 * 管理端新闻列表：含待审 / 已驳回（公开接口 /news 只返回已通过的）。
 * ?reviewStatus=PENDING 可只看待审队列。
 */
export const apiAdminNewsList = (params?: { reviewStatus?: NewsReviewStatus }) =>
  get<NewsItem[]>('/admin/news', params);

/** 审核新闻：approve 通过（有效期从通过时刻起算）/ reject 驳回（可附理由） */
export const apiAdminReviewNews = (id: number, action: 'approve' | 'reject', note?: string) =>
  put<{ id: number; reviewStatus: NewsReviewStatus; expiresAt: string | null }>(
    `/admin/news/${id}/review`, { action, note }
  );

/** 新闻立刻失效：管理员的「准删除」（记录全部保留，只是不再影响股价） */
export const apiAdminExpireNews = (id: number) =>
  put<{ id: number; expiresAt: string }>(`/admin/news/${id}/expire`);

/** 身份组下拉选项（由后端下发；assignable=当前登录者能否赋予该身份） */
export const apiAdminRoleOptions = () =>
  get<{ list: RoleOption[]; myRole: Role }>('/admin/role-options');

export interface AdminUserParams {
  username?: string;
  password?: string;
  nickname?: string;
  role?: Role;
  status?: number;
  mora?: number;
}

/** 用户列表返回：deletedCount 为已注销（逻辑删除）账号总数，仅 root 有值 */
export interface AdminUserPage extends Paged<User> {
  deletedCount?: number;
}

export const apiAdminUsers = (params?: Record<string, unknown>) =>
  get<AdminUserPage>('/admin/users', params);
export const apiAdminCreateUser = (data: AdminUserParams) => post<User>('/admin/users', data);
export const apiAdminUpdateUser = (id: number, data: AdminUserParams) => put<User>(`/admin/users/${id}`, data);
/** 逻辑删除（注销）：只改 status=2，保留全部数据 */
export const apiAdminDeleteUser = (id: number) =>
  del<{ id: number; username: string; status: number }>(`/admin/users/${id}`);

export interface AdminStock {
  id: number;
  code: string;
  name: string;
  /** STOCK=角色股 FUND=指数基金 */
  type?: 'STOCK' | 'FUND';
  /** 1=正常 0=停牌 2=已退市 */
  status?: number;
  avatarUrl: string | null;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  totalShares: number;
  nav?: number | null;
}

/** 标的列表改为服务端分页（?page=&pageSize=&q=&type=&status=） */
export const apiAdminStocks = (params?: Record<string, unknown>) =>
  get<Paged<AdminStock>>('/admin/stocks', params);

/** 下拉选项：只含 id/code/name/type/status/price，供成分股选择器等场景使用 */
export interface AdminStockOption {
  id: number;
  code: string;
  name: string;
  type: 'STOCK' | 'FUND';
  status: number;
  price: number;
  avatarUrl: string | null;
}
export const apiAdminStockOptions = (type?: 'STOCK' | 'FUND') =>
  get<AdminStockOption[]>('/admin/stocks-options', type ? { type } : undefined);

/**
 * 新增标的。
 * · 角色股票（STOCK）：必须给初始价格 price。
 * · 指数基金（FUND）：**必须给 constituents**，初始价格由后端按当前成分股加权净值自动决定
 *   （不允许手填，否则会与净值脱节并引发确定性补涨）。
 */
export const apiAdminCreateStock = (data: Partial<AdminStock> & {
  constituents?: Array<{ constituentId: number; weight: number }>;
}) => post<{ id: number; type: 'STOCK' | 'FUND'; nav?: number; count?: number }>('/admin/stocks', data);
/** 编辑标的：可改代码（仅 root）、名称、价格、份额、状态（0停牌/1正常/2退市） */
export const apiAdminUpdateStock = (id: number, data: Partial<AdminStock> & { status?: number; code?: string }) =>
  put<{ id: number; code: string; status: number; cancelledOrders?: number }>(`/admin/stocks/${id}`, data);
export const apiAdminDeleteStock = (id: number) => del<{ id: number }>(`/admin/stocks/${id}`);

/* ---- 指数基金成分股 ---- */
/** 成分股数量限制（新建基金时还没有基金 id，用它拿 min/max） */
export const apiAdminFundRules = () =>
  get<{ min: number; max: number; fundEnabled: boolean }>('/admin/fund-rules');

export interface FundConstituentRow {
  constituentId: number;
  code: string | null;
  name: string;
  type: 'STOCK' | 'FUND' | null;
  price: number;
  weight: number;
  weightPct: number;
}
export interface FundConstituentsResult {
  fund: { id: number; code: string; name: string; price: number; nav: number | null };
  list: FundConstituentRow[];
  totalWeight: number;
  rules: { min: number; max: number; fundEnabled: boolean };
}

export const apiAdminFundConstituents = (fundId: number) =>
  get<FundConstituentsResult>(`/admin/funds/${fundId}/constituents`);
export const apiAdminUpdateFundConstituents = (
  fundId: number,
  constituents: Array<{ constituentId: number; weight: number }>
) => put<{ fundId: number; count: number }>(`/admin/funds/${fundId}/constituents`, { constituents });

export const apiAdminTrades = (params?: Record<string, unknown>) =>
  get<Paged<TradeItem & { username?: string }>>('/admin/trades', params);
export const apiAdminDeleteTrade = (id: number) => del<{ id: number }>(`/admin/trades/${id}`);

export interface LogItem {
  id: number;
  username: string | null;
  action: string;
  detail: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export const apiAdminLogs = (params?: Record<string, unknown>) =>
  get<Paged<LogItem>>('/admin/logs', params);

/* ---- 盈亏报表（仅超级管理员） ---- */
export interface PnlRow {
  rank: number;
  userId: number;
  nickname: string;
  mvBefore: number;
  cashBefore: number;
  mvAfter: number;
  cashAfter: number;
  profit: number;
  profitPct: number;
}
export interface PnlResult {
  days: number;
  from: string;
  to: string;
  period: string;
  users: number;
  excludedNewUsers: number;
  totalProfit: number;
  list: PnlRow[];
}
/** 生成最近 N 天（3/7/14）的用户盈亏排行 */
export const apiAdminPnl = (days: number) => get<PnlResult>('/admin/pnl', { days });

/** 系统设置项：type 决定面板用什么控件渲染 */
export interface SystemSettingItem {
  key: string;
  type: 'bool' | 'number' | 'text' | 'user';
  group: string;
  label: string;
  description: string;
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  maxLength: number | null;
  /** 敏感项（API Key / Cookie）：后端只下发掩码，前端用密码框且不回显 */
  secret?: boolean;
  /** false = 单行输入框（如 fid、模型名）；默认多行文本域 */
  multiline?: boolean;
  placeholder?: string | null;
  /** 脚本自动回写的只读项（NGA 运行状态），面板不给编辑 */
  readonly?: boolean;
  /** type='user' 时的账号候选项 */
  options?: Array<{ value: string; label: string }> | null;
  value: string;
  /** 仅前端使用：文本项的编辑草稿 */
  draft?: string;
}

/** 系统开关与参数（root 控制面板） */
export const apiAdminSettings = () => get<SystemSettingItem[]>('/admin/settings');
export const apiAdminUpdateSetting = (key: string, value: string) =>
  put<{ key: string; value: string; unchanged?: boolean }>('/admin/settings', { key, value });

/**
 * 市场情绪「立即抓取」：在服务器上拉起一次分析脚本（不等它跑完，立即返回）。
 * 结果要去读取「市场情绪 → 最近一轮结果」等状态字段（脚本每轮回写）。
 * ★ 手动抓取固定带 --dump，脚本会顺手生成一份「抓取快照」，见 apiAdminNgaDump。
 */
export const apiAdminNgaRun = () =>
  post<{ startedAt: string; pid: number | null; script: string; dump?: boolean }>(
    '/admin/settings/nga-run', {});

/**
 * 下载最近一次手动抓取生成的「抓取快照」（01 原文 + 03 总结论提示词 + 06 本轮汇总，去重合并）。
 * 后端直接返回文件流，所以走 download() 而不是 request()。
 * 传 name 可取历史留档（目录里最多保留 10 份）。
 */
export const apiAdminNgaDump = (name?: string) =>
  download('/admin/settings/nga-dump', name ? { name } : undefined);

/* ---- 系统性能监控（root 控制面板） ---- */
export interface PerfSample {
  ts: number;
  reason?: string;
  cpuPct: number | null;
  cpuCount: number;
  load1: number; load5: number; load15: number;
  memTotalMb: number; memUsedMb: number; memUsedPct: number; memAvailMb: number;
  swapTotalMb: number; swapUsedMb: number; swapUsedPct: number;
  diskTotalGb: number; diskUsedGb: number; diskFreeGb: number; diskUsedPct: number; diskPath: string;
  nodeRssMb: number; nodeHeapMb: number; procUptimeSec: number;
  loopLagP50: number | null; loopLagP99: number | null;
  dbThreadsConnected: number | null; dbThreadsRunning: number | null;
  dbQps: number | null; dbAlive: boolean;
  httpInFlight: number; httpPerMin: number | null;
  uptimeSec: number;
}
export interface AdminPerf {
  config: { enabled: boolean; intervalSeconds: number; keepSamples: number };
  stats: {
    samples: number; oldestAt: number | null; newestAt: number | null;
    lastSampleMs: number; lastDriftMs: number; loopLagSupported: boolean; httpTotal: number;
  };
  current: PerfSample | null;
  series: PerfSample[];
}

/** 读性能数据：?since= 只取增量（面板自动刷新用），不传则返回降采样后的历史序列 */
export const apiAdminPerf = (params?: { since?: number; points?: number }) =>
  get<AdminPerf>('/admin/perf', params);
/** 手动刷新：立刻现场采样一次（关闭持续监控时的「只看一眼」模式） */
export const apiAdminPerfRefresh = () => post<AdminPerf>('/admin/perf/refresh');
