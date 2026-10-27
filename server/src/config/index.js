import 'dotenv/config';

/** 解析布尔值 */
function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

/** 解析数字，非法回退默认 */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: num(process.env.PORT, 3000),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    pass: process.env.DB_PASS || '',
    name: process.env.DB_NAME || 'teyvat_stock',
    pool: { max: num(process.env.DB_POOL_MAX, 5), min: num(process.env.DB_POOL_MIN, 0) },
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'teyvat-dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES || '7d',
  },

  business: {
    cycleMinutes: num(process.env.CYCLE_MINUTES, 10),
    dailyCloseHour: num(process.env.DAILY_CLOSE_HOUR, 15),
    startMora: Number(process.env.START_MORA || 1000000),
    weightPressure: num(process.env.WEIGHT_PRESSURE, 0.5),
    weightNews: num(process.env.WEIGHT_NEWS, 0.3),
    weightVote: num(process.env.WEIGHT_VOTE, 0.2),
    /**
     * 市场情绪（社交平台舆情快照）权重：与新闻因子并列的一档独立因子。
     * 0.2 ≈ 新闻权重（0.3）的 2/3：情绪是自动抓取的快照、噪声比人工新闻大，
     * 所以给得略低，但仍能在单周期推动约 ±0.4% 的价格（0.2 × 1.0 × 0.02）。
     */
    weightSentiment: num(process.env.WEIGHT_SENTIMENT, 0.2),
    baseVolatility: num(process.env.BASE_VOLATILITY, 0.02),
    maxChange: num(process.env.MAX_CHANGE, 0.10),
    pressureGain: num(process.env.PRESSURE_GAIN, 200),
    newsTtlCycles: num(process.env.NEWS_TTL_CYCLES, 6),
    voteMultMin: num(process.env.VOTE_MULT_MIN, 0.5),
    voteMultMax: num(process.env.VOTE_MULT_MAX, 2.0),
    orderMinQty: num(process.env.ORDER_MIN_QTY, 1),
    orderMaxQty: num(process.env.ORDER_MAX_QTY, 1000000),
    /**
     * 卖方印花税税率：按「卖方成交额」计征，从卖方到账金额中直接扣除。
     * 这是本系统唯一的摩拉回收阀门（不加税则全服资金只增不减 → 通胀）。
     * 0.005 = 0.5%；设为 0 可关闭（不推荐）。
     */
    stampTaxRate: num(process.env.STAMP_TAX_RATE, 0.005),
  },

  seed: {
    rootUser: process.env.SEED_ROOT_USER || 'root',
    rootPass: process.env.SEED_ROOT_PASS || 'Root123!',
    adminUser: process.env.SEED_ADMIN_USER || 'admin',
    adminPass: process.env.SEED_ADMIN_PASS || 'Admin123!',
    operatorUser: process.env.SEED_OPERATOR_USER || 'operator',
    operatorPass: process.env.SEED_OPERATOR_PASS || 'Op123456',
    userUser: process.env.SEED_USER_USER || 'demo',
    userPass: process.env.SEED_USER_PASS || 'Demo123456',
  },

  /**
   * 注册限制（一设备一账号）
   * - requireDeviceId：必须带设备号（前端自动带 X-Device-Id 头）
   * - autoFallback：没带设备号时，用 IP+UA 哈希兜底，避免脚本无限注册
   * - maxPerIpPerDay：同一 IP 每 24h 最多注册几个账号（0 = 不限制）
   */
  register: {
    requireDeviceId: bool(process.env.REGISTER_REQUIRE_DEVICE_ID, true),
    autoFallback: bool(process.env.REGISTER_DEVICE_AUTO_FALLBACK, true),
    maxPerIpPerDay: num(process.env.REGISTER_MAX_PER_IP_PER_DAY, 3),
  },

  /**
   * 高频操作限流（令牌桶，内存实现，单实例适用）
   * 每个值 = 该窗口内允许的次数；0 表示关闭该项。
   * 身份判定：已登录按 userId，未登录按 IP。
   */
  rateLimit: {
    enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
    api: num(process.env.RATE_API_PER_MIN, 600),            // 全站每 IP 每分钟
    write: num(process.env.RATE_WRITE_PER_MIN, 120),        // 写操作（非 GET）每人每分钟
    login: num(process.env.RATE_LOGIN_PER_5MIN, 10),        // 登录：每 IP+用户名 / 5 分钟
    register: num(process.env.RATE_REGISTER_PER_HOUR, 5),   // 注册：每 IP / 小时
    // 下单：双窗口限流（突发 + 持续），实际值以控制面板设置为准，这里是 .env 兜底
    order: num(process.env.RATE_ORDER_PER_MIN, 12),         // 下单：每人每分钟
    orderPerHour: num(process.env.RATE_ORDER_PER_HOUR, 180), // 下单：每人每小时
    cancel: num(process.env.RATE_CANCEL_PER_MIN, 60),       // 撤单
    vote: num(process.env.RATE_VOTE_PER_MIN, 60),           // 投票
    news: num(process.env.RATE_NEWS_PER_HOUR, 20),          // 发布/编辑/删除新闻
    admin: num(process.env.RATE_ADMIN_PER_MIN, 60),         // 管理端写操作
  },

  moraPrecision: 2,   // 摩拉保留两位小数
  pricePrecision: 4,  // 股价保留四位小数
};

export default config;
