import { SystemSetting, User } from '../models/index.js';
import { Op } from 'sequelize';
import { ROLE_LABELS } from '../constants/roles.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';

/**
 * ============ 系统设置服务 ============
 * 管理开关与参数统一存在 MySQL（system_settings 表），不用文件存储。
 *
 * 三类配置：
 *   bool   —— 开关，值 '0'/'1'
 *   number —— 数值参数（带 min/max/step 校验）
 *   text   —— 文本（如全站公告）
 *
 * 两层读取：
 *   1) getAllSettings()  原始字符串（带 3 秒内存缓存）
 *   2) getRuntime()      类型化快照（同步），供价格引擎/周期任务等高频路径使用；
 *                        由 refreshRuntime() 在启动、管理员改动、每轮 tick 时刷新
 *
 * 这样设计的原因：cycleStartMs() 等函数是同步的，不能 await 数据库，
 * 所以维护一份「最近一次读到的类型化快照」，既保持同步可用，又能近实时生效。
 */

const CACHE_TTL = 3000; // 毫秒
let cache = null;
let cacheAt = 0;

/** 配置项元信息：面板据此渲染，后端据此校验 */
export const SETTING_SCHEMA = [
  /* ---------------- 注册与账号 ---------------- */
  {
    key: 'allow_registration', type: 'bool', group: '注册与账号',
    label: '允许自助注册', default: 0,
    description: '关闭后只有管理员能创建账号',
  },
  {
    key: 'device_limit_enabled', type: 'bool', group: '注册与账号',
    label: '一设备一账号限制', default: 1,
    description: '开启后同一设备只能注册一个账号（含 IP+UA 兜底与同 IP 每日上限）；办活动想放宽时临时关闭',
  },
  {
    key: 'allow_login', type: 'bool', group: '注册与账号',
    label: '允许普通用户登录', default: 1,
    description: '关闭后普通用户/操作员/管理员都无法登录（超级管理员不受影响），用于维护期的"软锁门"',
  },

  /* ---------------- 交易控制 ---------------- */
  {
    key: 'trading_enabled', type: 'bool', group: '交易控制',
    label: '允许交易', default: 1,
    description: '关闭后全站停止下单/撤单/撮合，价格仍按新闻与投票小幅波动',
  },
  {
    key: 'cycle_minutes', type: 'number', group: '交易控制',
    label: '撮合周期（分钟）', default: config.business.cycleMinutes,
    min: 1, max: 1440, step: 1, unit: '分钟',
    description: '每隔多少分钟撮合一次并重算股价。改动后 K 线档位标签会同步变化（历史 K 线保留）',
  },
  {
    key: 'base_volatility', type: 'number', group: '交易控制',
    label: '基础波动率', default: config.business.baseVolatility,
    min: 0, max: 0.5, step: 0.001,
    description: '每周期涨跌幅 = 加权因子 × 该值。调大更刺激，调小更平缓（默认 0.02）',
  },
  {
    key: 'max_change', type: 'number', group: '交易控制',
    label: '单周期涨跌幅上限', default: config.business.maxChange,
    min: 0.001, max: 1, step: 0.01,
    description: '单周期最多涨跌多少（0.1 = ±10%）。想开"牛市/熊市"活动时调大',
  },
  {
    key: 'impact_linear_decay', type: 'bool', group: '交易控制', default: 1,
    label: '新闻/情绪影响线性衰减',
    description: '开启（推荐）：新闻与市场情绪的影响**从生效那一刻最强，之后每轮线性减弱，到期归零** —— K 线是斜坡而不是一根固定斜率的直线台阶。关闭：恢复成有效期内恒定满强度（老行为，会出现"一出来就猛涨、到期突然停"的观感）',
  },
  {
    key: 'min_hold_cycles', type: 'number', group: '交易控制',
    label: '最少持有周期数', default: 3,
    min: 0, max: 10000, step: 1, unit: '个周期',
    description: '买入后必须持有满 N 个周期才能卖出（0 = 关闭该限制）。默认 3 个周期：按当前撮合周期换算（10 分钟/周期 → 30 分钟）。只锁新买入的部分，不影响早已持有的存量；改小/关掉会立即放宽，改大只影响之后的买入',
  },
  {
    key: 'order_rate_per_min', type: 'number', group: '交易控制',
    label: '下单频率（每分钟）', default: config.rateLimit.order,
    min: 0, max: 600, step: 1, unit: '笔',
    description: '每个账号每分钟最多能下多少笔委托（0 = 不限制）。防脚本高频刷单与挤爆服务器，改完立即生效',
  },
  {
    key: 'order_rate_per_hour', type: 'number', group: '交易控制',
    label: '下单频率（每小时）', default: config.rateLimit.orderPerHour,
    min: 0, max: 20000, step: 10, unit: '笔',
    description: '每个账号每小时最多能下多少笔委托（0 = 不限制）。与「每分钟」两道闸门同时生效，用于压制长时间挂机脚本',
  },

  /* ---------------- 新闻与投票 ---------------- */
  {
    key: 'allow_news_publish', type: 'bool', group: '新闻与投票',
    label: '允许发布新闻', default: 1,
    description: '关闭后操作员无法发布/编辑/删除新闻（已发的仍按有效期继续影响股价）',
  },  {
    key: 'allow_vote', type: 'bool', group: '新闻与投票',
    label: '允许投票', default: 1,
    description: '关闭后新闻投票与股票投票全部暂停（防刷票操控股价）',
  },
  {
    key: 'news_ttl_cycles', type: 'number', group: '新闻与投票',
    label: '新闻有效周期数', default: config.business.newsTtlCycles,
    min: 1, max: 720, step: 1, unit: '个周期',
    description: '新闻发布后影响股价的时长（按周期数计）。新发布的新闻按此设置计算过期时间',
  },

  /* ---------------- 市场情绪（社交平台舆情快照） ----------------
   * 「市场情绪」这一档数据由 server/scripts/nga_analysis.py 抓取（当前接入的平台是 NGA），
   * 与「新闻因子」并列作为一档独立的定价因子：
   *   新闻     = 人工发布的引用 + 投票；
   *   市场情绪 = 脚本自动抓取并总结的社区讨论情绪。
   * 本组包含四件事：抓取参数、Gemini 参数、结论如何写入市场情绪、情绪如何影响股价。
   * 脚本每 5 分钟被 cron 唤起，是否真跑由「启用」+「分析间隔」决定，改完即时生效、不必重启。
   *
   * ⚠️ secret: true 的项（API Key / Cookie）在后端一律掩码下发（见 listAllWithMeta），
   *    不会出现在接口响应、操作日志或前端网络面板里。
   * ------------------------------------------------------------- */
  {
    key: 'nga_analysis_enabled', type: 'bool', group: '市场情绪',
    label: '启用市场情绪抓取（NGA）', default: 0,
    description: '总开关。关闭后定时任务仍会每 5 分钟被唤起，但脚本只写一条「已跳过」日志就退出，不抓 NGA、不调 Gemini、不产生任何外部请求',
  },
  {
    key: 'sentiment_auto_approve', type: 'bool', group: '市场情绪',
    label: '自动通过审核', default: 0,
    description: '开启后脚本每轮写出的市场情绪直接标记为「已通过」，不再进人工审核队列。发布时间 = 通过审核时间（同一时刻），审核人登记为系统自动审核（用户 8：bot_summary）。关闭时仍然先进待审，由管理员在「新闻管理 → 市场情绪」里审核',
  },
  {
    key: 'nga_interval_minutes', type: 'number', group: '市场情绪',
    label: '分析间隔（分钟）', default: 180,
    min: 10, max: 1440, step: 10, unit: '分钟',
    description: '多久真正分析一次。调度器每 5 分钟唤起脚本，脚本发现距上次成功分析不足这个间隔就直接退出（默认 180 分钟 = 3 小时）。改小更实时，但 NGA 请求与 Gemini 调用都会变多',
  },
  {
    key: 'nga_forum_fid', type: 'text', group: '市场情绪',
    label: '监测版面 fid', default: '650', maxLength: 200, multiline: false,
    placeholder: '650，或用英文逗号填多个：650,835',
    description: 'NGA 版面 ID。原神主板 = 650，剑斗绮谭（战斗讨论子版）= 835；多个版面用英文逗号分隔（如 650,835）。填错或该账号无权限访问时，日志会记 [COOKIE_EXPIRED] 且不写库',
  },
  {
    key: 'nga_max_posts', type: 'number', group: '市场情绪',
    label: '单轮最多分析帖数', default: 30,
    min: 1, max: 200, step: 5, unit: '条',
    description: '过滤后最多送多少条帖子给 AI。调大会增加 Gemini token 消耗与耗时',
  },
  {
    key: 'nga_fetch_content', type: 'bool', group: '市场情绪',
    label: '抓取帖子正文', default: 1,
    description: 'NGA 的帖子**列表只给标题**，正文（主楼+回复）要按帖子 ID 逐帖另抓一次。开启后 AI 依据真实讨论内容判断，比只看标题准确得多；关闭则退回「只看标题」',
  },
  {
    key: 'nga_content_max_threads', type: 'number', group: '市场情绪',
    label: '最多抓几帖正文', default: 12,
    min: 0, max: 30, step: 1, unit: '帖',
    description: '每轮为前 N 条候选帖子补抓正文（0 = 不抓）。每帖多一次请求，12 帖约多 3.5 秒（实测 0.3 秒/帖）；帖子正文只摘取摘要、不驻留内存，不会增加内存压力',
  },
  {
    key: 'nga_content_max_floors', type: 'number', group: '市场情绪',
    label: '每帖最多取几层（主楼+回复）', default: 8,
    min: 1, max: 20, step: 1, unit: '层',
    description: '同一页 HTML 里就有主楼 + 约 19 层回复（实测 20 层 / 约 50KB），所以取回复**不增加任何请求**，只增加送进 AI 的字数：1 层≈1248 tokens、8 层≈4259、20 层≈9383（单轮）。实测 1 层→8 层 Gemini 时延只多 0.35 秒。填 1 = 只分析主楼',
  },
  {
    key: 'nga_request_timeout', type: 'number', group: '市场情绪',
    label: 'NGA 请求超时（秒）', default: 15,
    min: 3, max: 60, step: 1, unit: '秒',
    description: '抓 NGA 帖子列表的单次请求超时。服务器网络到 NGA 较慢时可上调（如 25）；太小会频繁记「抓取失败」',
  },
  {
    key: 'gemini_api_key', type: 'text', group: '市场情绪',
    label: 'Gemini API Key', default: '', maxLength: 200, secret: true, multiline: false,
    placeholder: 'AIza... 或 AQ....（留空则脚本记 ERROR 跳过）',
    description: 'Google Gemini 密钥（https://aistudio.google.com/apikey）。保存后不回显，只显示“已配置（长度 N）”；留空则每轮都会记一条 ERROR 且不调用 AI',
  },
  {
    key: 'nga_cookie', type: 'text', group: '市场情绪',
    label: 'NGA Cookie', default: '', maxLength: 4000, secret: true,
    placeholder: '浏览器登录 NGA 后复制整条 Cookie（须含 ngaPassportUid= 与 ngaPassportCid=）',
    description: 'NGA 登录态。必须包含 ngaPassportUid 与 ngaPassportCid 两段，否则 NGA 会当游客，日志记 [COOKIE_EXPIRED]。保存后不回显；Cookie 过期时直接在这里重新粘贴覆盖即可，无需登录服务器',
  },
  {
    key: 'gemini_model', type: 'text', group: '市场情绪',
    label: 'Gemini 模型', default: 'gemini-3.5-flash-lite', maxLength: 64, multiline: false,
    description: '实测可用：gemini-3.5-flash-lite（最省 token）、gemini-3.6-flash。注意 gemini-2.5-flash-lite 已对新用户下线（返回 404）',
  },
  {
    key: 'gemini_max_retries', type: 'number', group: '市场情绪',
    label: 'Gemini 重试次数', default: 2,
    min: 0, max: 5, step: 1, unit: '次',
    description: 'AI 调用失败后最多重试几次（每次间隔 5 秒）。注意重试会累加 CPU 时间，脚本总 CPU 上限是 60 秒',
  },
  {
    key: 'gemini_timeout_seconds', type: 'number', group: '市场情绪',
    label: 'Gemini 超时（秒）', default: 30,
    min: 5, max: 120, step: 5, unit: '秒',
    description: '单次 Gemini 请求超时。长文提示词下 30 秒通常够用',
  },
  {
    key: 'nga_news_auto_publish', type: 'bool', group: '市场情绪',
    label: '结论自动写入市场情绪', default: 1,
    description: '每轮分析完，把结论按「看涨 / 看跌」拆成市场情绪条目（进入待审核，管理员通过后才对外显示）。同一监测周期内重复抓取只更新那一条待审记录，不会刷屏',
  },
  {
    key: 'nga_news_max_stocks', type: 'number', group: '市场情绪',
    label: '每条情绪关联角色数', default: 5,
    min: 1, max: 10, step: 1, unit: '个',
    description: '看涨/看跌各自按影响值绝对值取前 N 个角色关联（最多 10 个）',
  },

  /* ---------------- 市场情绪 → 撮合定价（3 项） ----------------
   * 情绪因子在定价公式里的位置与权重：见 docs/PRICING.md 第 3 / 14 章。
   * ------------------------------------------------------------- */
  {
    key: 'sentiment_before_review', type: 'bool', group: '市场情绪',
    label: '审核通过前即影响股价', default: 1,
    description: '开启（默认）：抓到的情绪直接参与撮合定价，**审核只用于阻止未审文字公开到网站**，不阻止它影响价格。关闭：必须管理员审核通过后才影响股价（与新闻完全同口径）。已驳回的情绪在任何设置下都不会影响股价',
  },
  {
    key: 'sentiment_weight', type: 'number', group: '市场情绪',
    label: '情绪权重（定价因子 wS）', default: 0.2,
    min: 0, max: 2, step: 0.01,
    description: '情绪因子在定价公式里的权重，与新闻权重（0.3）**并列相加**。单周期价格影响 ≈ 该权重 × 情绪因子(-1~1) × 基础波动率：0.2 满情绪约为 ±0.4%。设 0 = 情绪只展示、不影响股价',
  },
  {
    key: 'sentiment_decay_hours', type: 'number', group: '市场情绪',
    label: '情绪影响股价的时长', default: 72,
    min: 1, max: 720, step: 1, unit: '小时',
    description: '一条市场情绪影响股价的时长（按小时计，从抓取时刻起算）。超过就不再计入定价。情绪更新频繁、衰减比新闻快，因此用固定小时数而不是周期数',
  },

  /* ---------------- 市场情绪 · 运行状态（脚本回写，面板只读） ---------------- */
  {
    key: 'nga_health_status', type: 'text', group: '市场情绪 · 运行状态',
    label: '最近一轮结果', default: '尚未运行', maxLength: 255, readonly: true,
    description: '由脚本每轮结束时回写。出现「失败」时会附带阶段与原因，方便直接判断是 Cookie、版面权限还是 API 问题',
  },
  {
    key: 'nga_health_last_run', type: 'text', group: '市场情绪 · 运行状态',
    label: '最近一轮时间', default: '', maxLength: 32, readonly: true,
    description: '脚本每轮结束时写入（服务器时区）。超过「分析间隔」的 3 倍没更新，说明 cron 或脚本出问题了',
  },
  {
    key: 'nga_health_last_success', type: 'text', group: '市场情绪 · 运行状态',
    label: '最近成功时间', default: '', maxLength: 32, readonly: true,
    description: '只有整轮跑通（抓到帖子并成功写库）才会更新，用来区分「一直在跑但一直失败」',
  },
  {
    key: 'nga_health_cookie_ok_at', type: 'text', group: '市场情绪 · 运行状态',
    label: 'Cookie 最近验证通过', default: '', maxLength: 32, readonly: true,
    description: 'NGA 抓取成功即更新。若长时间不更新、而「最近一轮结果」显示 Cookie 类失败，就该换 Cookie 了',
  },
  {
    key: 'nga_health_api_ok_at', type: 'text', group: '市场情绪 · 运行状态',
    label: 'API Key 最近验证通过', default: '', maxLength: 32, readonly: true,
    description: 'Gemini 调用成功即更新。长时间不更新说明密钥失效、额度用尽或被墙',
  },
  {
    key: 'nga_health_last_detail', type: 'text', group: '市场情绪 · 运行状态',
    label: '最近一轮摘要', default: '', maxLength: 500, readonly: true,
    description: '形如「版面=原神 fid=650 抓到=36 过滤=7 AI返回=10 写入=10 耗时=3.2s」，一眼看出每轮实际处理了多少数据',
  },

  /* ---------------- 经济参数 ---------------- */
  {
    key: 'start_mora', type: 'number', group: '经济参数',
    label: '新用户初始摩拉', default: config.business.startMora,
    min: 0, max: 1000000000, step: 10000, unit: '摩拉',
    description: '新注册用户（以及管理员新建用户）的初始资金',
  },

  /* ---------------- 指数基金 ---------------- */
  {
    key: 'fund_enabled', type: 'bool', group: '指数基金',
    label: '启用指数基金机制', default: 1,
    description: '关闭后基金不再参与「净值收敛」与「反向传导」，基金价格如同普通股票一样只受自身买卖影响',
  },
  {
    key: 'fund_influence_weight', type: 'number', group: '指数基金',
    label: '基金→角色 传导权重', default: 0.25,
    min: 0, max: 1, step: 0.05,
    description: '玩家买入基金时，按该权重把基金压力传导给成分股（0.25 = 与新闻因子同量级）。调大则买基金对成分股的拉动更明显',
  },
  {
    key: 'fund_tracking_rate', type: 'number', group: '指数基金',
    label: '净值跟踪速度', default: 0.5,
    min: 0.05, max: 1, step: 0.05,
    description: '每周期基金价格向「净值×(1+溢价)」收敛的比例。1 = 一步到位紧跟成分股；越小则跟随越慢',
  },
  {
    key: 'fund_premium_gain', type: 'number', group: '指数基金',
    label: '基金压力→溢价系数', default: 0.05,
    min: 0, max: 1, step: 0.01,
    description: '基金自身净买卖压力形成多少溢价：0.05 = 满压力时溢价 5%（配合 0.5 跟踪速度 → 单周期约 +2.5%）。调大则买基金更能拉高基金自己的价格',
  },
  {
    key: 'fund_min_constituents', type: 'number', group: '指数基金',
    label: '基金最少成分股', default: 3,
    min: 1, max: 50, step: 1, unit: '个',
    description: '配队基金至少关联多少个角色（防止 2 只成分股被当成杠杆工具）',
  },
  {
    key: 'fund_max_constituents', type: 'number', group: '指数基金',
    label: '基金最多成分股', default: 15,
    min: 1, max: 50, step: 1, unit: '个',
    description: '配队基金最多关联多少个角色（太多会退化成大盘指数）',
  },

  /* ---------------- 系统性能监控 ---------------- */
  {
    key: 'perf_monitor_enabled', type: 'bool', group: '系统性能', default: 1,
    label: '开启性能持续监控',
    description: '开启后后台按「采样间隔」持续采集 CPU/内存/磁盘/并发，供「系统性能」页画曲线。开销极低（每次采样约 1~2ms，只读 /proc 与一次极小 SQL，不启动任何子进程）。关闭后不采集，只在你点「刷新」时现场算一次',
  },
  {
    key: 'perf_sample_seconds', type: 'number', group: '系统性能',
    label: '采样间隔', default: 60,
    min: 5, max: 3600, step: 5, unit: '秒',
    description: '多久采集一次。默认 60 秒（一天 1440 次，合计约 1.5 秒 CPU/天）。想看得更细可以调到 10 秒',
  },
  {
    key: 'perf_keep_samples', type: 'number', group: '系统性能',
    label: '内存中保留条数', default: 1440,
    min: 60, max: 20160, step: 60, unit: '条',
    description: '性能数据只存在内存里（环形缓冲：新数据挤掉最旧的，天然"定期清除"，不写数据库、不占磁盘）。1440 条 @60 秒 ≈ 最近 24 小时；进程重启后历史清零',
  },

  /* ---------------- 数据维护 ---------------- */
  {
    key: 'kline_retention_days', type: 'number', group: '数据维护',
    label: '周期 K 线保留天数', default: 21,
    min: 0, max: 3650, step: 1, unit: '天',
    description: '只保留最近 N 天的周期 K 线（日线永久保留），每天 04:00 后自动分批清理。0 = 不清理（不建议：1.9 万行/天会把 48MB 缓冲池挤爆，历史查询会退化成磁盘随机读）。建议不小于 14，否则盈亏报表（最长 14 天）的期初价会失准',
  },

  /* ---------------- 排行榜 ---------------- */
  {
    key: 'rank_enabled', type: 'bool', group: '排行榜',
    label: '启用排行榜', default: 1,
    description: '总资产榜（取前 50 名，只显示昵称与金额，不显示用户 ID）。总资产 = 可用摩拉 + 挂单冻结摩拉 + Σ(持仓股数 × 现价)。关闭后前端显示"暂未开放"，并且不再计算新数据',
  },
  {
    key: 'rank_interval_minutes', type: 'number', group: '排行榜',
    label: '排行榜更新频率', default: 10,
    min: 1, max: 1440, step: 1, unit: '分钟',
    description: '每隔多少分钟重算一次排行榜。默认 10 分钟（跟随撮合周期）。数据在周期任务里顺带算好并缓存在内存，玩家每次查看都是读缓存，不额外增加数据库压力',
  },

  /* ---------------- 站点公告 ---------------- */
  {
    key: 'announcement', type: 'text', group: '站点公告',
    label: '全站公告横幅', default: '', maxLength: 500,
    description: '填写后会在所有页面顶部显示一条横幅（留空 = 不显示）。适合发维护通知、活动公告',
  },

];

const SCHEMA_BY_KEY = new Map(SETTING_SCHEMA.map((s) => [s.key, s]));

/** 兼容旧代码的键名常量（含新增项） */
export const SETTING_KEYS = {
  allowRegistration: 'allow_registration',
  deviceLimitEnabled: 'device_limit_enabled',
  allowLogin: 'allow_login',
  tradingEnabled: 'trading_enabled',
  cycleMinutes: 'cycle_minutes',
  baseVolatility: 'base_volatility',
  maxChange: 'max_change',
  impactLinearDecay: 'impact_linear_decay',
  allowNewsPublish: 'allow_news_publish',
  allowVote: 'allow_vote',
  newsTtlCycles: 'news_ttl_cycles',
  startMora: 'start_mora',
  announcement: 'announcement',
  fundEnabled: 'fund_enabled',
  fundInfluenceWeight: 'fund_influence_weight',
  fundTrackingRate: 'fund_tracking_rate',
  fundPremiumGain: 'fund_premium_gain',
  fundMinConstituents: 'fund_min_constituents',
  fundMaxConstituents: 'fund_max_constituents',
  rankEnabled: 'rank_enabled',
  rankIntervalMinutes: 'rank_interval_minutes',
  klineRetentionDays: 'kline_retention_days',
  minHoldCycles: 'min_hold_cycles',
  perfMonitorEnabled: 'perf_monitor_enabled',
  perfSampleSeconds: 'perf_sample_seconds',
  perfKeepSamples: 'perf_keep_samples',
  orderRatePerMin: 'order_rate_per_min',
  orderRatePerHour: 'order_rate_per_hour',
  // 市场情绪（面板配置，脚本读取；当前接入平台 = NGA）
  ngaAnalysisEnabled: 'nga_analysis_enabled',
  sentimentAutoApprove: 'sentiment_auto_approve',
  ngaIntervalMinutes: 'nga_interval_minutes',
  ngaForumFid: 'nga_forum_fid',
  ngaMaxPosts: 'nga_max_posts',
  geminiApiKey: 'gemini_api_key',
  ngaCookie: 'nga_cookie',
  geminiModel: 'gemini_model',
  // 市场情绪运行状态（脚本回写，面板只读）
  ngaHealthStatus: 'nga_health_status',
  ngaHealthLastRun: 'nga_health_last_run',
  ngaHealthLastSuccess: 'nga_health_last_success',
  ngaHealthCookieOkAt: 'nga_health_cookie_ok_at',
  ngaHealthApiOkAt: 'nga_health_api_ok_at',
  ngaHealthLastDetail: 'nga_health_last_detail',
};

/**
 * 掩码：敏感项（API Key / Cookie）对外一律不返回明文。
 * 前端拿到的就是这个字符串；提交时如果原样回传，后端视为「不修改」。
 */
export const SECRET_MASK = '•••••••';
const SECRET_KEYS = new Set(SETTING_SCHEMA.filter((s) => s.secret).map((s) => s.key));

export function isSecretKey(key) {
  return SECRET_KEYS.has(key);
}

/** 敏感项的「已配置」提示，例如“已配置（长度 53）”；未配置返回空串 */
function secretPlaceholder(raw) {
  const len = raw ? String(raw).length : 0;
  return len ? `已配置（长度 ${len}）` : '';
}

/** 掩码下发：只用于 listAllWithMeta（root 面板），其它读取路径按 key 精确取值不受影响 */
function maskForPanel(key, raw) {
  if (!SECRET_KEYS.has(key)) return String(raw ?? '');
  const placeholder = secretPlaceholder(raw);
  return placeholder ? `${SECRET_MASK}${placeholder}` : '';
}

/* ==================== 原始读取（带缓存） ==================== */

/** 全部设置（值统一为字符串） */
export async function getAllSettings() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) return cache;
  const rows = await SystemSetting.findAll({ raw: true }).catch((err) => {
    logger.warn('读取 system_settings 失败: ' + err.message);
    return [];
  });
  const map = {};
  for (const r of rows) map[r.key] = String(r.value);
  cache = map;
  cacheAt = now;
  return map;
}

function schemaDefault(key) {
  const s = SCHEMA_BY_KEY.get(key);
  return s ? s.default : undefined;
}

function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return v === '1' || v === 'true';
}

function toNumber(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 读取单个开关（布尔）。不存在时返回 schema 默认值 */
export async function getSettingBool(key, def) {
  const all = await getAllSettings();
  const fallback = def !== undefined ? def : toBool(schemaDefault(key), false);
  return toBool(all[key], fallback);
}

/** 读取单个数值。不存在时返回 schema 默认值 */
export async function getSettingNumber(key, def) {
  const all = await getAllSettings();
  const fallback = def !== undefined ? def : toNumber(schemaDefault(key), 0);
  return toNumber(all[key], fallback);
}

/** 读取单个设置原始字符串值 */
export async function getSetting(key, def = '') {
  const all = await getAllSettings();
  const v = all[key];
  if (v !== undefined) return v;
  if (def !== '') return def;
  const d = schemaDefault(key);
  return d === undefined ? '' : String(d);
}

/* ==================== 类型化运行时快照（同步可用） ==================== */

/** 最近一次刷新的类型化配置（启动时先用 .env 兜底，避免首轮 tick 拿到 undefined） */
let runtime = {
  startMora: config.business.startMora,
  cycleMinutes: config.business.cycleMinutes,
  baseVolatility: config.business.baseVolatility,
  maxChange: config.business.maxChange,
  /** 新闻/情绪影响是否线性衰减（默认开；见 engine.js 的 linearDecay） */
  impactLinearDecay: true,
  newsTtlCycles: config.business.newsTtlCycles,
  // 市场情绪：审核前是否生效 / 有效时长（小时）/ 定价权重。
  // ★ weightSentiment 必须在这里也给一份 .env 兜底：撮合任务理论上可能在
  //   refreshRuntime() 之前就跑第一轮，缺了它会把整个公式算成 NaN。
  sentimentBeforeReview: true,
  sentimentDecayHours: 72,
  weightSentiment: config.business.weightSentiment,
  // 自动通过审核（脚本读取；Node 侧不消费，这里给默认值只为控制面板能正常下发/保存）
  sentimentAutoApprove: false,
  allowRegistration: true,
  deviceLimitEnabled: true,
  allowLogin: true,
  tradingEnabled: true,
  allowNewsPublish: true,
  allowVote: true,
  announcement: '',
  fundEnabled: true,
  fundInfluenceWeight: 0.25,
  fundTrackingRate: 0.5,
  fundPremiumGain: 0.2,
  fundMinConstituents: 3,
  fundMaxConstituents: 15,
  rankEnabled: true,
  rankIntervalMinutes: 10,
  klineRetentionDays: 21,
  minHoldCycles: 3,
  perfMonitorEnabled: true,
  perfSampleSeconds: 60,
  perfKeepSamples: 1440,
  orderRatePerMin: config.rateLimit.order,
  orderRatePerHour: config.rateLimit.orderPerHour,
};

/** 同步读取当前运行时配置 */
export function getRuntime() {
  return runtime;
}

/**
 * 当前 K 线档位标识，跟随撮合周期（周期 10 分钟 → '10m'，改成 2 分钟 → '2m'）。
 * 放在这里而不是 job 里，是为了让 controller 也能安全引用（避免 controller → job 的反向依赖）。
 */
export function klinePeriod() {
  return `${runtime.cycleMinutes}m`;
}

/** 从数据库刷新运行时快照（命中 3 秒缓存时开销极小） */
export async function refreshRuntime() {
  const all = await getAllSettings();
  runtime = {
    startMora: toNumber(all.start_mora, config.business.startMora),
    cycleMinutes: Math.max(1, Math.round(toNumber(all.cycle_minutes, config.business.cycleMinutes))),
    baseVolatility: toNumber(all.base_volatility, config.business.baseVolatility),
    maxChange: toNumber(all.max_change, config.business.maxChange),
    impactLinearDecay: toBool(all.impact_linear_decay, true),
    newsTtlCycles: toNumber(all.news_ttl_cycles, config.business.newsTtlCycles),
    sentimentBeforeReview: toBool(all.sentiment_before_review, true),
    sentimentDecayHours: Math.max(1, Math.round(toNumber(all.sentiment_decay_hours, 72))),
    weightSentiment: Math.max(0, toNumber(all.sentiment_weight, config.business.weightSentiment)),
    sentimentAutoApprove: toBool(all.sentiment_auto_approve, false),
    allowRegistration: toBool(all.allow_registration, false),
    deviceLimitEnabled: toBool(all.device_limit_enabled, true),
    allowLogin: toBool(all.allow_login, true),
    tradingEnabled: toBool(all.trading_enabled, true),
    allowNewsPublish: toBool(all.allow_news_publish, true),
    allowVote: toBool(all.allow_vote, true),
    announcement: String(all.announcement ?? ''),
    fundEnabled: toBool(all.fund_enabled, true),
    fundInfluenceWeight: toNumber(all.fund_influence_weight, 0.25),
    fundTrackingRate: toNumber(all.fund_tracking_rate, 0.5),
    fundPremiumGain: toNumber(all.fund_premium_gain, 0.2),
    fundMinConstituents: Math.max(1, Math.round(toNumber(all.fund_min_constituents, 3))),
    fundMaxConstituents: Math.max(1, Math.round(toNumber(all.fund_max_constituents, 15))),
    rankEnabled: toBool(all.rank_enabled, true),
    rankIntervalMinutes: Math.max(1, Math.round(toNumber(all.rank_interval_minutes, 10))),
    klineRetentionDays: Math.max(0, Math.round(toNumber(all.kline_retention_days, 21))),
    minHoldCycles: Math.max(0, Math.round(toNumber(all.min_hold_cycles, 3))),
    perfMonitorEnabled: toBool(all.perf_monitor_enabled, true),
    perfSampleSeconds: Math.max(5, Math.round(toNumber(all.perf_sample_seconds, 60))),
    perfKeepSamples: Math.max(60, Math.round(toNumber(all.perf_keep_samples, 1440))),
    orderRatePerMin: Math.max(0, Math.round(toNumber(all.order_rate_per_min, config.rateLimit.order))),
    orderRatePerHour: Math.max(0, Math.round(toNumber(all.order_rate_per_hour, config.rateLimit.orderPerHour))),
  };
  return runtime;
}

/* ==================== 写入 ==================== */

/** 按 schema 校验并归一化值；返回字符串形式的入库值 */
export function normalizeSettingValue(key, value) {
  const s = SCHEMA_BY_KEY.get(key);
  if (!s) throw Object.assign(new Error(`未知的设置项: ${key}`), { status: 400, code: 'BAD_REQUEST' });

  if (s.type === 'bool') {
    const v = String(value);
    if (!['0', '1', 'true', 'false'].includes(v)) {
      throw Object.assign(new Error('该开关只能是 0 或 1'), { status: 400, code: 'BAD_REQUEST' });
    }
    return v === '1' || v === 'true' ? '1' : '0';
  }

  if (s.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw Object.assign(new Error(`${s.label} 必须是数字`), { status: 400, code: 'BAD_REQUEST' });
    }
    if (s.min !== undefined && n < s.min) {
      throw Object.assign(new Error(`${s.label} 不能小于 ${s.min}`), { status: 400, code: 'BAD_REQUEST' });
    }
    if (s.max !== undefined && n > s.max) {
      throw Object.assign(new Error(`${s.label} 不能大于 ${s.max}`), { status: 400, code: 'BAD_REQUEST' });
    }
    return String(n);
  }

  // user：账号 ID（下拉选择）。允许留空（表示自动取超级管理员），非空必须是纯数字
  if (s.type === 'user') {
    const t = String(value ?? '').trim();
    if (!t) return '';
    if (!/^\d{1,10}$/.test(t)) {
      throw Object.assign(new Error(`${s.label} 必须是账号 ID（下拉选择）`), { status: 400, code: 'BAD_REQUEST' });
    }
    return t;
  }

  // text
  const t = String(value ?? '');
  if (s.maxLength && t.length > s.maxLength) {
    throw Object.assign(new Error(`${s.label} 最长 ${s.maxLength} 个字符`), { status: 400, code: 'BAD_REQUEST' });
  }
  return t;
}

/** 供调用方判断「这个候选值是不是掩码占位」——是的话跳过写入 */
export function isMaskedValue(value) {
  return typeof value === 'string' && value.startsWith(SECRET_MASK);
}

/**
 * 写入设置；upsert 并清空缓存 + 刷新运行时快照。
 * 敏感项若提交掩码串，直接返回当前行（视为未修改），不产生写入。
 */
export async function setSetting(key, value, userId = null) {
  const meta = SCHEMA_BY_KEY.get(key);
  // 只读项（NGA 运行状态）由脚本直接写库，面板不允许改
  if (meta && meta.readonly) {
    throw Object.assign(new Error(`${meta.label} 由脚本自动维护，不能手动修改`), { status: 400, code: 'BAD_REQUEST' });
  }
  if (isMaskedValue(value)) {
    const [row] = await SystemSetting.findOrCreate({
      where: { key },
      defaults: { key, value: '', description: meta?.description ?? null },
    });
    return row;
  }
  const normalized = normalizeSettingValue(key, value);
  const [row] = await SystemSetting.findOrCreate({
    where: { key },
    defaults: { key, value: normalized, description: meta?.description ?? null },
  });
  row.value = normalized;
  if (meta?.description) row.description = meta.description;
  if (userId) row.updatedBy = userId;
  await row.save();
  cache = null; // 使下次读取回源
  await refreshRuntime();
  return row;
}

/** 仅当设置项不存在时写入默认值（幂等）：避免重启/重新部署把管理员改过的值重置 */
export async function ensureSetting(key, defaultValue, description = null) {
  const meta = SCHEMA_BY_KEY.get(key);
  const [row, created] = await SystemSetting.findOrCreate({
    where: { key },
    defaults: { key, value: String(defaultValue), description: description ?? meta?.description ?? null },
  });
  if (created) cache = null;
  return { row, created };
}

/** 把所有 schema 里的设置项补齐到数据库（幂等），启动时调用一次 */
export async function ensureDefaults() {
  let created = 0;
  for (const s of SETTING_SCHEMA) {
    const r = await ensureSetting(s.key, s.default, s.description);
    if (r.created) created++;
  }
  if (created) {
    logger.info(`[设置] 已补齐 ${created} 个默认配置项`);
  }
  await refreshRuntime();
  return created;
}

/** 供管理面板展示：分组 + 类型 + 当前值 + 说明 */
export async function listAllWithMeta() {
  const all = await getAllSettings();
  // 「发布者」这类 user 项要下拉选择账号，前端需要候选列表（只在有 user 项时才查一次）
  let userOptions = null;
  if (SETTING_SCHEMA.some((s) => s.type === 'user')) {
    try {
      // 候选范围与脚本的校验保持一致：root / admin / 高级操作员 / 操作员
      // （操作员发布的新闻同样走待审核，正好是舆情总结论想要的效果）
      const rows = await User.findAll({
        where: { status: 1, role: { [Op.in]: ['root', 'admin', 'senior_operator', 'operator'] } },
        attributes: ['id', 'username', 'nickname', 'role'],
        order: [['id', 'ASC']],
        raw: true,
      }).catch(() => []);
      userOptions = rows.map((u) => ({
        value: String(u.id),
        label: `${u.nickname || u.username}（${u.username} · ${ROLE_LABELS[u.role] || u.role}）`,
      }));
    } catch { userOptions = null; }
  }
  return SETTING_SCHEMA.map((s) => ({
    key: s.key,
    type: s.type,
    group: s.group,
    label: s.label,
    description: s.description,
    unit: s.unit ?? null,
    min: s.min ?? null,
    max: s.max ?? null,
    step: s.step ?? null,
    maxLength: s.maxLength ?? null,
    // 面板渲染提示：secret=密码框且不回显；multiline=多行文本框；readonly=只读（脚本回写）
    secret: s.secret === true,
    multiline: s.multiline !== false,
    placeholder: s.placeholder ?? null,
    readonly: s.readonly === true,
    // type='user' 的候选项（账号下拉）
    options: s.type === 'user' ? userOptions : null,
    // ★ 敏感项一律掩码：明文只留在数据库里，不出后端
    value: maskForPanel(s.key, all[s.key] !== undefined ? String(all[s.key]) : String(s.default)),
  }));
}

/** 供 /api/meta 公开的字段（不含定价公式相关参数） */
export async function getPublicMeta() {
  // 这里刻意读「原始设置」（3 秒缓存）而不是运行时快照：
  // 快照最快也要等看门狗 30 秒刷新，而公告/开关类信息希望改完立刻对外可见。
  const all = await getAllSettings();
  const cycleMinutes = Math.max(1, Math.round(toNumber(all.cycle_minutes, config.business.cycleMinutes)));
  return {
    cycleMinutes,
    newsTtlCycles: toNumber(all.news_ttl_cycles, config.business.newsTtlCycles),
    maxChange: toNumber(all.max_change, config.business.maxChange),
    startMora: toNumber(all.start_mora, config.business.startMora),
    allowRegistration: toBool(all.allow_registration, false),
    tradingEnabled: toBool(all.trading_enabled, true),
    rankEnabled: toBool(all.rank_enabled, true),
    // 最少持有周期数：前端要在委托面板/关于页显示，所以对外公开
    minHoldCycles: Math.max(0, Math.round(toNumber(all.min_hold_cycles, 3))),
    announcement: String(all.announcement ?? ''),
    // 卖方印花税税率：前端要在委托确认框与成交记录里显示真实税率，所以对外公开
    stampTaxRate: config.business.stampTaxRate,
  };
}

/* ==================== 面向「每请求」的即时判断 ====================
 * 说明：运行时快照（getRuntime）给价格引擎/周期任务这类高频同步路径用；
 * 而这些「每次请求都要判断」的开关直接读原始设置（3 秒缓存），
 * 保证管理员点完开关后立刻生效，不用等看门狗。
 */

export const isRegistrationAllowed = () => getSettingBool('allow_registration', false);
export const isDeviceLimitEnabled = () => getSettingBool('device_limit_enabled', true);
export const isLoginAllowed = () => getSettingBool('allow_login', true);
export const isNewsPublishAllowed = () => getSettingBool('allow_news_publish', true);
export const isVoteAllowed = () => getSettingBool('allow_vote', true);
export const getStartMora = () => getSettingNumber('start_mora', config.business.startMora);

/** 排行榜开关：接口每次请求都要判断，读原始设置（3 秒缓存）保证管理员改完立刻生效 */
export const isRankEnabled = () => getSettingBool('rank_enabled', true);

/**
 * 下单限流的两道闸门（每分钟 / 每小时）。
 * 直接读运行时快照：setSetting() 里会同步 refreshRuntime()，因此改完立即生效；
 * 而且限流中间件是同步函数，只能同步取值。
 */
export function getOrderRatePerMin() {
  return getRuntime().orderRatePerMin;
}
export function getOrderRatePerHour() {
  return getRuntime().orderRatePerHour;
}

/** 卖方印花税税率（0.005 = 0.5%） */
export function getStampTaxRate() {
  return config.business.stampTaxRate;
}

/** 新闻有效期（毫秒）：周期数 × 撮合周期 */
export async function getNewsTtlMs() {
  const cycles = await getSettingNumber('news_ttl_cycles', config.business.newsTtlCycles);
  const minutes = await getSettingNumber('cycle_minutes', config.business.cycleMinutes);
  return cycles * Math.max(1, minutes) * 60 * 1000;
}
