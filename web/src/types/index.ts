// ========== 与后端对齐的领域类型 ==========

/**
 * 身份组（角色）。定义与中文名见 web/src/utils/format.ts 与后端 constants/roles.js。
 * user 普通用户 / vip 高级用户(免印花税) / star 明星(强制公开持仓) /
 * operator 操作员(发新闻需审核) / senior_operator 高级操作员(发新闻免审核) /
 * admin 管理员(不能删除任何数据) / root 超级管理员(全部权限)
 */
export type Role = 'user' | 'vip' | 'star' | 'operator' | 'senior_operator' | 'admin' | 'root';

/** 身份组下拉选项（由后端 /admin/role-options 下发，避免前后端两套硬编码） */
export interface RoleOption {
  value: Role;
  label: string;
  level: number;
  assignable: boolean;
}

export type Side = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'PENDING' | 'FILLED' | 'CANCELLED';
export type Direction = 'UP' | 'DOWN';

/** 新闻审核状态：PENDING 待审（不生效/不公开） APPROVED 已通过（唯一生效状态） REJECTED 已驳回 */
export type NewsReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * K 线档位：日线固定为 '1d'；周期线档位跟随后台「撮合周期」设置，
 * 形如 '10m' / '2m'（由 /api/meta 的 cycleMinutes 推导）。
 */
export type KlinePeriod = string;

export interface User {
  id: number;
  username: string;
  nickname: string;
  role: Role;
  /** 身份组中文名（后端下发） */
  roleLabel?: string;
  /** 是否免卖方印花税（高级用户 vip） */
  stampTaxExempt?: boolean;
  /** 是否强制公开持仓（明星 star） */
  holdsPublic?: boolean;
  mora: number;
  frozenMora: number;
  status: number;
  /** 是否参与资金/市值排行榜（用户中心可自行开关；明星强制参与） */
  rankOptIn?: boolean;
  createdAt?: string;
  /** 最后登录来源（users 表冗余存储，管理端/个人中心直接展示） */
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  lastLoginUa?: string | null;
}

/** 标的类型：STOCK=角色股，FUND=指数基金（两者共用 /stocks 接口） */
export type StockType = 'STOCK' | 'FUND';

/** 基金成分股（仅 type=FUND 的详情返回） */
export interface FundConstituentItem {
  id: number;
  code: string | null;
  name: string;
  avatarUrl: string | null;
  type: StockType | null;
  price: number;
  changePct: number;
  weight: number;
  weightPct: number;
  delisted?: boolean;
}

export interface Stock {
  id: number;
  code: string;
  name: string;
  type: StockType;
  /** 单标的状态：1=正常 0=停牌 2=已退市 */
  status: number;
  /** status === 1 */
  tradable: boolean;
  avatarUrl: string | null;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  totalShares: number;
  marketCap: number;
  change: number;
  changePct: number;
  watched: boolean;
  updatedAt?: string;
  /** 以下仅指数基金（type=FUND）返回 */
  nav?: number;
  premiumPct?: number;
  constituents?: FundConstituentItem[];
  constituentCount?: number;
}

export interface KlinePoint {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface OrderBook {
  price: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface OrderItem {
  id: number;
  stockId: number;
  stockCode: string | null;
  stockName: string | null;
  side: Side;
  type: OrderType;
  price: number | null;
  quantity: number;
  filledQuantity: number;
  reservedAmount: number | null;
  status: OrderStatus;
  createdAt: string;
  updatedAt?: string;
}

export interface TradeItem {
  id: number;
  orderId: number;
  stockId: number;
  stockCode: string | null;
  stockName: string | null;
  side: Side;
  price: number;
  quantity: number;
  /** 成交金额（未扣税） */
  amount: number;
  /** 卖方印花税（买入恒为 0） */
  fee: number;
  /** 实际到账 = amount − fee */
  netAmount: number;
  /** 卖出份额的成本（移动加权均价 × 数量；买入为 0） */
  costAmount: number;
  /** 平仓盈亏（税后）= 到账 − 成本；买入为 0 */
  realizedProfit: number;
  matchedAt: string;
}

/** 排行榜条目：只含名次 + 昵称 + 金额（后端不返回用户 ID） */
export interface RankItem {
  rank: number;
  nickname: string;
  value: number;
}

export interface RankResult {
  /** 榜单口径固定为「总资产」= 可用摩拉 + 冻结摩拉 + Σ(持仓股数 × 现价) */
  type: 'assets';
  enabled: boolean;
  topN: number;
  intervalMinutes: number;
  updatedAt: string | null;
  /** 参与人数 */
  participants: number;
  list: RankItem[];
}

export interface HoldingItem {
  stockId: number;
  code: string | null;
  name: string;
  avatarUrl: string | null;
  quantity: number;
  frozenQuantity: number;
  avgCost: number;
  price: number;
  changePct: number;
  marketValue: number;
  profit: number;
  profitPct: number;
  /** 锁仓中的股数（买入未满「最少持有周期」） */
  lockedQuantity?: number;
  /** 当前可卖股数（已扣除挂单冻结与锁仓） */
  sellableQuantity?: number;
  /** 下一批解锁时间 */
  unlockAt?: string | null;
  /** 当前生效的最少持有周期数（0 = 未限制） */
  holdCycles?: number;
  /** 该角色股票已被管理员删除，持仓仅作历史保留、市值为 0 */
  delisted?: boolean;
}

export interface AccountSummary {
  mora: number;
  frozenMora: number;
  totalAssets: number;
  marketValue: number;
  holdings: Array<{ stockId: number; code: string; name: string; quantity: number; frozenQuantity: number; avgCost: number; marketValue: number; profit: number }>;
  /** 未实现盈亏：持仓浮动盈亏 */
  holdingProfit: number;
  /** 已实现盈亏：累计平仓盈亏（税后） */
  realizedProfit: number;
  /** 交易总盈亏 = 已实现 + 未实现 */
  tradingProfit: number;
}

export interface NewsItem {
  id: number;
  title: string;
  content: string;
  sourceUrl?: string | null;
  direction: Direction;
  strength: number;
  publisher?: string | null;
  publisherId?: number;
  /** 发布人身份组（管理端列表返回，用于审核时判断来源） */
  publisherRole?: Role | null;
  stocks?: Array<{ id: number; code: string; name: string }>;
  expiresAt?: string | null;
  createdAt: string;
  /** 审核状态（管理端/操作员端列表返回） */
  reviewStatus?: NewsReviewStatus;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  votes?: {
    up: number;
    down: number;
    total: number;
    avgMult: number;
    score: number | null;
  };
  expired?: boolean;
}

/* ---- 明星持仓公开页（GET /api/stars） ---- */
export interface StarHoldingItem {
  stockId: number;
  code: string | null;
  name: string;
  avatarUrl: string | null;
  type: StockType;
  delisted: boolean;
  quantity: number;
  price: number;
  marketValue: number;
  /** 占总资产比例（%），总资产 = 现金 + 持仓市值（后端只给比例，不给金额） */
  weightPct: number;
}

export interface StarEntry {
  nickname: string;
  holdingCount: number;
  totalMarketValue: number;
  holdings: StarHoldingItem[];
}

export interface StarHoldingsResult {
  count: number;
  list: StarEntry[];
  updatedAt: string;
  cacheSeconds: number;
}

/** 市场情绪（社交平台情绪快照）：与新闻完全独立的一条展示线 */
export interface MarketSentimentItem {
  id: number;
  /** 抓取平台代号，如 NGA（以后会有微博/贴吧等） */
  platform: string;
  /** 平台展示名，如「NGA 玩家社区」 */
  platformName: string;
  /** 抓取时间 */
  fetchedAt: string;
  title: string;
  /** 概况：一句话总结 */
  summary: string | null;
  /** 影响走向 */
  direction: Direction;
  /** 影响强度 0~100 */
  strength: number;
  /** 本行涉及的角色数 */
  stockCount?: number;
  sourceUrl: string | null;
  /** 展示用作者（平台 + 自动总结），**不是上传人** */
  author: string;
  stocks: Array<{ id: number; code?: string; name: string }>;
  /* ---- 仅管理端返回 ---- */
  reviewStatus?: NewsReviewStatus;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  reviewer?: string | null;
  batchDate?: string;
  batchKey?: string;
  createdAt?: string;
}

export interface PagedSentiment {
  total: number;
  page: number;
  pageSize: number;
  list: MarketSentimentItem[];
  platforms: Array<{ platform: string; name: string }>;
}

export interface PagedNews {
  total: number;
  page: number;
  pageSize: number;
  list: NewsItem[];
}

export interface ApiResponse<T = unknown> {
  code: number | string;
  message: string;
  data: T;
}

export interface Paged<T> {
  total: number;
  list: T[];
}
