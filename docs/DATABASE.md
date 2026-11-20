# 数据库说明（DATABASE）

> **本文是数据库的唯一权威说明**：19 张表各自干什么、字段什么语义、谁在读写、
> 索引与性能现状、迁移怎么跑、备份怎么恢复、出问题怎么排查。
>
> 相关文档：`docs/ARCHITECTURE.md`（整体架构）、`docs/PRICING.md`（定价公式）、
> `docs/ROLES.md`（身份组与权限）、`docs/API.md`（接口）。
> 迁移纪律与「本地↔云端结构同步」的原始记录在 `docs/backups/DB_SYNC.md`（2026-09-14 被移到 backups）。
>
> **数据快照**：2026-09-14 02:18（生产库实时读取，非推测值）。

---

## 1. 一分钟概览

| 项 | 值 |
|---|---|
| 数据库 | MySQL **8.0.45**（InnoDB），库名 `teyvat_stock` |
| 连接（生产） | 只监听 `127.0.0.1:3306`，用 SSH 隧道才能远程连（见 §8） |
| 连接（本地开发） | `127.0.0.1:3306`，账号见 `server/.env` |
| 字符集 | 服务端 `utf8mb4` / `utf8mb4_0900_ai_ci`；Sequelize 连接显式 `utf8mb4` + `utf8mb4_unicode_ci` |
| 时区 | Sequelize `timezone: '+08:00'`，服务器 `Asia/Shanghai`，全库 `DATETIME` |
| 库体积 | **11.14 MB**（数据 6.11 + 索引 5.03），19 张表 |
| 缓冲池 | `innodb_buffer_pool_size` = **48 MB**（小机器，刻意调小） |
| 最大连接 | `max_connections` = 30；应用侧连接池 `DB_POOL_MAX=5` |
| 事务隔离 | 默认 REPEATABLE READ；**所有写资金/持仓的路径都显式开事务 + 行锁 + 重试** |
| 慢查询日志 | **未开启**（`slow_query_log=0`，`long_query_time=3`） |
| 外键约束 | **只有 3 个**（其余全靠应用层保证；见 §9）：`fund_constituents` → `stocks` 两个（**ON DELETE CASCADE**）、`system_settings.updated_by` → `users`（**ON DELETE SET NULL**） |
| 软删除 | 只有 `users.status`（0 禁用 / 1 正常 / 2 注销）；其余表删除即物理删除 |
| ORM | Sequelize（`server/src/models/*.js`），启动跑 `sequelize.sync()`（**只建缺失的表，不改已有表**） |

**命名约定**：表名、列名一律 `snake_case`（Sequelize `underscored: true`）；
金额 `DECIMAL(18,2)`、价格 `DECIMAL(14,4)`、数量 `INT/BIGINT UNSIGNED`；
时间列统一 `created_at` / `updated_at`（`DEFAULT CURRENT_TIMESTAMP`）。

**两个刻意的例外，务必记住**：

1. `system_settings` 的列名是 **`s_key` / `s_value`**，不是 `key` / `value` —— 为了避开 MySQL 保留字 `KEY`。
   （模型里用 `field: 's_key'` 映射，所以代码里写的是 `key` / `value`。
   ⚠️ 这不是洁癖：**2026-09-09 真的踩过一次** —— `sync()` 先按模型的 `key/value` 建了列，
   与 `init.sql` 的 `s_key/s_value` 不一致，模型查询直接失败，最后靠 `CHANGE COLUMN` 改名才修好。）
2. `news_impact` 与 `nga_analysis_log` **没有 Sequelize 模型**，由 Python 脚本
   `server/scripts/nga_analysis.py` 自己读写 —— `sequelize.sync()` 永远不会创建它们，
   只能靠迁移文件（这也是 `utils/checkSchema.js` 启动自检存在的原因）。

---

## 2. 19 张表地图（谁拥有 / 谁读写）

| # | 表 | 用途 | 有 model？ | 主要写入方 | 主要读取方 |
|---|---|---|---|---|---|
| 1 | `users` | 账号、身份组、资金、登录来源 | ✅ | authController（注册/登录）、adminController、tradingService | 几乎全部 |
| 2 | `device_registrations` | 一设备一账号记录 | ✅ | authController（注册） | authController |
| 3 | `operation_logs` | 操作审计（登录/下单/管理动作） | ✅ | 各 controller 的 `log()` / `OperationLog.create` | adminController（仅 root 可看） |
| 4 | `system_settings` | 控制面板全部开关与参数 | ✅ | settingService、NGA 面板迁移脚本 | 全站（3 秒内存缓存） |
| 5 | `stocks` | 角色股 **与** 指数基金（`type` 区分） | ✅ | adminController、seed、cycleJob（价格） | 全站 |
| 6 | `fund_constituents` | 基金 ↔ 成分股 + 权重 | ✅ | adminController | cycleJob（NAV/传导）、stockController |
| 7 | `price_history` | K 线（周期线 + 日线） | ✅ | cycleJob（P3/P4，批量 upsert） | stockController（图表）、adminController（盈亏报表期初价） |
| 8 | `orders` | 委托单（含冻结额） | ✅ | tradingService | tradeController、cycleJob、adminController |
| 9 | `trades` | 成交记录（审计凭证） | ✅ | tradingService | tradeController、adminController、cycleJob（P2 统计） |
| 10 | `holdings` | 持仓（用户×标的一行，移动加权成本） | ✅ | tradingService | tradeController、starController、adminController |
| 11 | `holding_lots` | 持仓批次（T+N 锁仓用） | ✅ | tradingService（每次买入一条） | tradingService、tradeController |
| 12 | `watchlists` | 自选 | ✅ | stockController | stockController |
| 13 | `votes` | 新闻投票 / 角色投票 | ✅ | newsController | engine（因子）、newsController |
| 14 | `news` | 新闻（含审核状态与有效期） | ✅ | publisherController | engine、newsController、sentiment/NGA 脚本（自动发新闻） |
| 15 | `news_stocks` | 新闻 ↔ 角色 | ✅ | publisherController | engine、newsController |
| 16 | `news_impact` | NGA 舆情 AI 影响值 | ❌ | **Python** `nga_analysis.py`（每 3 小时覆盖） | 暂无（后端尚未接入定价，见下） |
| 17 | `nga_analysis_log` | NGA 分析脚本日志（**兼作频率门控状态源**） | ❌ | **Python** `nga_analysis.py` | 脚本自身（门控）、运维/排查 |
| 18 | `market_sentiment` | 市场情绪（对外展示 + 审核 + **参与定价**） | ✅ | Python 写 + sentimentController 审核 | sentimentController（前台公开）、**engine（定价因子）**、adminController |
| 19 | `market_sentiment_stocks` | 市场情绪 ↔ 角色 | 通过 `belongsToMany` | 同上 | 同上 |

---

## 3. 逐表详解

### 3.1 账号与权限

#### `users` —— 账号与资金（行数 154）

| 列 | 类型 | 语义 / 必读 |
|---|---|---|
| `id` | INT UNSIGNED PK | |
| `username` | VARCHAR(32) UNIQUE | 登录名 |
| `password_hash` | VARCHAR(255) | bcrypt |
| `nickname` | VARCHAR(32) | 对外只显示昵称（排行榜/公开页不暴露 ID 与用户名） |
| `role` | ENUM(7) | **身份组**：`user`/`vip`/`star`/`operator`/`senior_operator`/`admin`/`root`；详见 `docs/ROLES.md` |
| `mora` | DECIMAL(18,2) | 可用摩拉 |
| `frozen_mora` | DECIMAL(18,2) | **挂买单冻结**的摩拉（不是保证金；本系统无杠杆） |
| `status` | TINYINT | `1` 正常 / `0` 禁用 / `2` 已注销（逻辑删除，可恢复） |
| `rank_opt_in` | TINYINT(1) | 是否参与排行榜；**明星强制为 1**（排行榜 SQL 里是 `rank_opt_in=1 OR role='star'`） |
| `token_version` | INT UNSIGNED | JWT 吊销版本：改密码/注销时 +1 → 该用户所有旧 token 立即失效 |
| `register_device` | VARCHAR(64) | 注册设备号（与 `device_registrations` 对应） |
| `last_login_at/ip/ua` | | 最后登录来源，管理端直接展示 |

- **不变式**：`mora >= 0`、`frozen_mora >= 0`；`frozen_mora` 恒等于该用户未成交买单的 `reserved_amount` 之和（§9）。
- **注意**：`DECIMAL` 在 JS 侧一律以「分」为整数运算后再写回（`utils/money.js`），避免浮点误差。

#### `device_registrations` —— 一设备一账号（行数 53）

`device_id` UNIQUE（`auto-` 前缀表示由 IP+UA 推导的兜底值）、`user_id`（账号删除后置空但**记录保留**，
防止同设备再次注册）、`ip` / `user_agent` / `source(dev|auto)`。

#### `operation_logs` —— 操作审计（行数 1429）

`action`（`LOGIN` / `PLACE_ORDER` / `ADMIN_*` …）、`detail`（JSON 文本）、`ip`、`user_agent`（2026-09-09 新增列）。
只有 `root` 能通过接口查看（`/api/admin/logs`）。**没有任何清理任务**（见 §5）。

#### `system_settings` —— 控制面板配置（行数 49）

Key-Value 表：`s_key` UNIQUE + `s_value` **VARCHAR(8192)** + `description` + `updated_by`。

- `s_value` 为什么是 8192：NGA Cookie 实测 **795 字符**，原来是 `VARCHAR(500)`，写不进去
  （2026-09-13 的迁移扩到 8192，`checkSchema.js` 会检查这一列的长度）。
- 读取路径：`settingService` 有 3 秒内存缓存 + 一份「类型化运行时快照」（`getRuntime()`），
  所以价格引擎这种高频同步路径不会每次查库。
- 当前 **51 个键**（2026-09-14 22:4x 实测；控制面板还在扩展，重启后端时 `ensureDefaults()` 会把 schema 里的新键补齐）
  ，分组：注册与账号 / 交易控制 / 新闻与投票 / **市场情绪**（`nga_*`、`gemini_*`、`sentiment_*`）/
  经济参数 / 指数基金 / 系统性能 / 数据维护 / 排行榜 / 站点公告。
  分组顺序 = schema 顺序，前端左侧 TAB 直接照此渲染（「市场情绪 · 运行状态」会并进「市场情绪」）。
- **里面还存着明文密钥**：`gemini_api_key`、`nga_cookie`。接口下发时会掩码
  （`SECRET_MASK`），但**库和备份里是明文** → 导库/备份文件要按密钥对待（见 §8）。
- **已清理的 4 个死配置**（2026-09-14，迁移 `2026-09-14_prune_dead_settings.sql`）：
  `nga_news_publisher_id`（结论改走市场情绪后，脚本读了从未使用的死变量）、
  `NEWS_IMPACT_WEIGHT` / `NEWS_DECAY_FACTOR` / `NEWS_MIN_THRESHOLD`（早期「news_impact 直接接撮合」
  方案未落地留下的残留，面板上也看不见）。清理后「库里有的键 = schema 定义的键」，
  可用下面的对账 SQL 一键自检：
  ```sql
  -- 期望：两张结果集都为空
  SELECT s_key FROM system_settings
   WHERE s_key NOT IN ('allow_registration', /* … schema 全量键 … */);
  ```
- **改值只走 `settingService.setSetting()`**（会做 schema 校验并刷新快照）；直接 SQL 改也能生效，
  但最多延迟 3 秒（缓存）或一个周期（快照由 tick 刷新）。

### 3.2 行情与标的

#### `stocks` —— 角色股 + 指数基金（行数 132）

**一张表两种类型**：`type='STOCK'` 角色股 / `type='FUND'` 指数基金。

| 列 | 语义 |
|---|---|
| `code` UNIQUE / `name` UNIQUE | 代码（`YS0129` / `FUND002`）与名称；**基金与角色共用同一命名空间** |
| `type` | `STOCK` / `FUND` |
| `status` | `1` 正常 / `0` 停牌（不撮合，价格仍随新闻投票走）/ `2` 已退市（价格冻结、不落 K 线） |
| `price` / `prev_close` / `open` / `high` / `low` / `volume` | 现价与当日行情；`volume` 是**当日累计成交量**，每日收盘重置 |
| `total_shares` | 总流通份额 —— **决定价格敏感度**（压力 = 净买入/流通股×200；8 万盘时 400 股即打满 → 1%/轮） |
| `nav` | 基金单位净值（仅 FUND，每轮结算由成分股加权算出） |

- 为什么基金不单独建表：`orders / trades / holdings / watchlists / price_history / news_stocks / votes`
  全部通过 `stock_id` 关联，做成一行后上述能力**零改动复用**（详见 `docs/PRICING.md` §2.1）。
- 退市（`status=2`）会在**同一事务**里撤销该标的全部未成交挂单并解冻资金/股份。

#### `fund_constituents` —— 基金成分股（行数 11）

`fund_id` + `constituent_id`（都指向 `stocks.id`）+ `weight DECIMAL(8,4)`（相对值，内部归一化）。
一期只允许「角色 → 基金」，不允许基金持有基金。改成分股会立即把基金价格对齐到新净值。

#### `price_history` —— K 线（行数 70,105；9776 KB，占全库 88%）

`UNIQUE(stock_id, period, ts)`；`period` 是 **VARCHAR(8)**（`10m` / `2m` / `1d`…）而不是 ENUM ——
撮合周期可在控制面板在线调整，固定 ENUM 会写不进去并回滚整轮结算（2026-09-11 修）。

- 写入：每个周期 **1 条批量 `INSERT ... ON DUPLICATE KEY UPDATE`**（不是 132 条独立语句）。
- 保留：**周期线滚动保留 21 天**（`kline_retention_days`，每天 04:00 后分批删 5000 行/批，批间 sleep 120ms），
  **日线永久保留**（131 行/天 ≈ 4.8 万行/年，可忽略）。
- 保留期必须 ≥ 14 天：盈亏报表最长窗口 14 天，靠期初价反推资产变化。

### 3.3 交易

#### `orders` —— 委托单（行数 647）

`side(BUY|SELL)`、`type(MARKET|LIMIT)`、`price`（市价为 NULL）、`quantity`、`filled_quantity`、
`status(PENDING|FILLED|CANCELLED)`、`reserved_amount`（**挂买单冻结的摩拉**，撤单/成交时清算）。

- 本系统**整单成交**：`filled_quantity` 只会是 0 或 `quantity`（无部分成交）。
- 限价买单冻结 `限价×数量`（成交价 ≤ 限价，故必然够）；限价卖单冻结 `holdings.frozen_quantity`。

#### `trades` —— 成交记录（行数 612）

| 列 | 语义 |
|---|---|
| `price` / `quantity` / `amount` | 成交价（= 撮合时刻现价）、股数、**未扣税**成交额 |
| `fee` | 卖方印花税（买入恒 0；**高级用户恒 0** —— 免印花税） |
| `cost_amount` | 卖出份额成本（成交时的移动加权均价 × 数量；买入 0） |
| `realized_profit` | 平仓盈亏（税后）= 到账 − 成本；买入 0 |
| `matched_at` | 成交时刻 —— **周期统计窗口 `(prevRunAt, now]` 的唯一依据** |

- **这是审计凭证**：管理员不可删除、也没有替代动作；只有超级管理员能删。
- P2 统计直接扫这张表算每轮净买卖量 → 删历史成交会让当轮定价失真。
- 该表**永不清理**（是全部盈亏与审计的来源）。

#### `holdings` / `holding_lots` —— 持仓与批次（行数 89 / 39）

- `holdings`：`UNIQUE(user_id, stock_id)`，只有 `quantity` / `frozen_quantity` / `avg_cost`（移动加权均价），
  **没有任何时间信息**。
- `holding_lots`：每次买入写一条（`quantity` + `unlock_at = 买入时刻 + min_hold_cycles × 周期长度`），
  卖出按 **FIFO 消费**，用于「最少持有周期（T+N）」。
- **为什么非要单开一张表**（当时的决策记录）：被否的方案是「在 `holdings` 上加一个 `opened_at`」——
  那样会留一个洞：「今天新买的 1000 股，只要那一行是早先开的仓，就能当天卖出」。
  FIFO 批次才等价于真实交易所的「每批各自 T+N」。
- **不变式**：对每个 `(user_id, stock_id)`，`Σ holding_lots.quantity == holdings.quantity`
  （本功能上线前的存量持仓没有批次，属于「宽限」；关闭限制时也必须消费批次，否则会出现幽灵批次）。
- 卖出时 `holdings.avg_cost` 不变（卖出不摊薄成本），所以 `cost_amount` 可以在同一个事务里零额外查询算出。

#### `watchlists` / `votes`

- `watchlists`：`UNIQUE(user_id, stock_id)`，纯自选。
- `votes`：`UNIQUE(user_id, target_type, target_id)`（`target_type = NEWS|STOCK`）+ `direction` + `multiplier(0.5~2.0)`；
  同票覆盖。引擎按「方向均值 × 倍率均值」参与定价，投票有窗口（默认最近 6 个周期）。

### 3.4 新闻与舆情

#### `news` —— 新闻（行数 7）

| 列 | 语义 |
|---|---|
| `title` / `source_url` | 标题 + 外部来源链接（本平台只做**引用**，`content` 列保留兼容、新数据一律为空） |
| `direction(UP\|DOWN)` / `strength(0~100)` | 初始影响方向与强度 |
| `publisher_id` | 发布人（可为「NGA 自动总结」这类自动发布账号） |
| `review_status` | **`PENDING` 待审（不进引擎、不公开、不可投票）/ `APPROVED` 唯一生效状态 / `REJECTED` 已驳回** |
| `reviewed_by` / `reviewed_at` / `review_note` | 审核人与意见（驳回理由） |
| `expires_at` | 过期时间；**起点是「审核通过时刻」而不是发布时刻**；`PENDING` 时为 NULL |

- 引擎查询必须同时满足 `review_status='APPROVED'` **且**（`expires_at IS NULL` 或 `> now`）：
  待审新闻的 `expires_at` 是 NULL，只按时间过滤会把它当成**永久有效**。
- 历史数据默认 `APPROVED`（该机制上线前都是直接生效的）。

#### `news_stocks` —— 新闻 ↔ 角色（行数 15）

`PRIMARY KEY(news_id, stock_id)`，纯关联表；删新闻/删标的时要一并清理（否则持仓页读到孤儿关联会 500）。

#### `news_impact` —— NGA 舆情 AI 影响值（行数 19）★无 model

`UNIQUE(entity_type, entity_name)` —— **每个实体一行，每轮覆盖式 upsert**（不保留历史）。
生产实测 19 行、但 `AUTO_INCREMENT` 已经到 41 —— 这多出来的 22 次就是被覆盖掉的轮次，
正好说明「覆盖式」不是纸面设计。

| 列 | 语义 |
|---|---|
| `entity_type` | `role` / `fund` —— 由 `stocks.type` 映射（`STOCK`→`role`，`FUND`→`fund`） |
| `entity_name` | **等于 `stocks.name`**（用名字而不是 id 关联，脚本不需要维护 id 映射） |
| `raw_impact` | AI 原始影响值 `-1.0000 ~ 1.0000` |
| `impact_value` | 生效影响值（当前 = `raw_impact`，预留了衰减位置） |
| `confidence` / `summary` / `source_count` | 置信度 / AI 一句话理由 / 纳入帖子数 |
| `analyzed_at` | 本轮分析时刻 |

> ⚠️ **现状：`news_impact` 仍然是「只写不读」**。写入方只有 Python 脚本，Node 后端
> （`services/engine.js`）**没有**从这张表取影响值 —— 进定价的是 `news` 表（人工/自动发布的新闻引用）。
> 配置键 `NEWS_IMPACT_WEIGHT` / `NEWS_DECAY_FACTOR` / `NEWS_MIN_THRESHOLD` 也**没有任何代码真正消费**
> （脚本只把它们读进配置字典、不参与计算，后端没读，面板里也看不到）→ 属于**死配置**。
>
> **但「舆情不影响价格」这个结论已经过期**：2026-09-15 起，**市场情绪表**（下面那张
> `market_sentiment`）被接进了定价引擎，走的是**独立权重 `wS`**（`sentiment_weight`，默认 0.2），
> 与新闻因子并列而不是合并。所以：
> **AI 影响值（这张表）不影响价格，市场情绪（market_sentiment）才影响价格。**
> 两条数据线容易混，记住这个分工。
>
> 另外记住它**不是时间序列**：每个实体恒一行，每轮覆盖，看不到历史（要历史只能靠 `nga_analysis_log`）。

#### `nga_analysis_log` —— 分析脚本日志（行数 131）★无 model、★兼作「频率状态源」

`level(INFO|WARN|ERROR)` + `message` + `detail`（堆栈/响应片段，≤2000 字符）+ `created_at`。
索引 `(level, created_at)`、`(created_at)`。排查抓取/AI 失败时第一手资料。

**★ 它不只是日志**：脚本的「距上次分析多久」是直接查这张表的
`SELECT UNIX_TIMESTAMP(MAX(created_at))`（`nga_analysis.py:289`）—— 也就是说
**这张表同时是频率门控的状态存储**。两个后果：

1. **清空/删除这张表的行 = 门控归零** → 下一跳 cron 会立刻真跑一次；
2. **门控自锁 bug（2026-09-15 已修复）**：门控取的是全表 `MAX(created_at)`，而同一次运行在门控
   之前**已经写了「脚本启动」这行日志** → 算出来的间隔恒为 **0.0 分钟** → 每轮直接跳过，
   **自动分析实际上从不运行**，只有面板「立即抓取」（`--force`）跑过。

   修复：只统计**终结行**（`WHERE LEFT(message,5) = '[NGA-'`，即
   `[NGA-SUCCESS]/[NGA-FAILED]/[NGA-PARTIAL]/[NGA-DRYRUN]` 四类收尾标签），
   「脚本启动」与「跳过」两类噪音不再参与计时。

   生产验证（同一台机器，修复前后各一次 cron）：

   | 时间 | 日志 | 说明 |
   |---|---|---|
   | 20:50:02 | `未到分析间隔（已过 **0.0** 分钟 / 配置 180 分钟）` | 修复前：永远 0.0 |
   | 20:55:01 | `未到分析间隔（已过 **56.9** 分钟 / 配置 180 分钟）` | 修复后：= 距最后一次真跑（19:58:06）的真实间隔 ✅ |

   由此自动运行时间可以算出来：`最后一次终结行时间 + nga_interval_minutes`
   （当时 = 22:58:06 起会真的跑）。

   > 历史规模（修复前）：557 条「脚本启动」、539 条「跳过（0.0 分钟）」、只有 **12 次真分析**。

**清理策略**：无（全仓无 DELETE）。注意即使一次都不真跑，每 5 分钟一跳仍会写 2 行
（启动 + 跳过）→ **约 576 行/天**，是所有「无清理表」里长得最快的。

#### `market_sentiment` / `market_sentiment_stocks` —— 市场情绪（行数 1 / 5）

**为什么独立于新闻**：原来 NGA 的总结论以「新闻」形式混在提瓦特新闻里，观感不合适；
现在拆成独立模块（表分开、接口分开、前台分开）。

- `platform` 用 **VARCHAR(32)** 而不是 ENUM：以后接微博/B站/贴吧不用改表结构。
- **去重键 `UNIQUE(platform, batch_date, batch_key, direction)`**：同平台 + 同批次（同一天同版面）
  + 同方向只保留一行；待审期间反复跑只更新那一行，**审核通过后就定稿不再被覆盖**。
- 一次监控里有的角色看涨、有的看跌 → 按方向**拆成两行**（所以唯一键里含 `direction`）。
- `author_label`：展示用作者（如「NGA 自动总结」），**不给机器人建账号**，也不出现在「我提交的新闻」里。
- 复用新闻那套审核字段：`review_status` 默认 `PENDING`，只有 `APPROVED` 对外可见
  （前台 `/api/sentiment` 需要登录，且只返回已通过的数据）。
- `strength` 是 **AI 自评的「论据强度」0~100**，不是影响值的绝对值；一次监控里看涨/看跌
  各取自己那一侧的前 N 个角色（`nga_news_max_stocks`，默认 5），所以两行关联的角色**互不重叠**。
- 写入方是 Python（`upsert_sentiment()` / `publish_sentiment()`）；**Node 侧只读**，
  但 **2026-09-15 起 `engine.js` 会读它定价**（见下面「★ 它会推价格」）。
- `batch_date` 用的是**脚本所在机器的本地日期**：改服务器时间可能造成同日重复或跳日。

**★ 它会推价格（2026-09-15 接入）**：`services/engine.js` 把「方向 × 强度/100」当作
**独立因子**参与定价，权重 `sentiment_weight`（`wS`），与新闻因子并列而不是合并：

```
单轮涨跌幅贡献 = 方向 × 强度/100 × wS × baseVolatility(0.02)
```

| 设置 | 出厂值 | 说明 |
|---|---|---|
| `sentiment_weight` | 0.2 → **线上已调 0.08** | 满强度 0.2 时 = 0.4%/轮 ≈ 一天 46%；0.08 时 ≈ 0.16%/轮 |
| `sentiment_decay_hours` | 72 → **线上已调 2** | 从 `fetched_at` 起算的有效小时数，超过就不再计入定价 |
| `sentiment_before_review` | 1 → **线上已调 0** | 1 = 待审也参与定价（审核只拦「是否对外发布」）；0 = 必须 APPROVED |
| `impact_linear_decay` | 1（开） | **线性衰减**：窗口内从满强度线性降到 0（见下） |

**为什么必须有衰减**：因子是**阶跃**的 —— 一通过就满强度、恒定到窗口结束再瞬间归零。
实测（钟离，2026-09-15）：08:30 起**每轮固定 +0.300%、124 轮全部零成交**，3 小时推了 **+5.56%**；
K 线看上去就是「凭空出现一条直线斜坡」，这就是「一出来就飙升」的观感来源。
开启 `impact_linear_decay` 后，同一条情绪的效果**从生效那一刻最强、之后每轮按比例变弱**，
窗口末尾自然归零 → 台阶变斜坡。窗口口径：情绪 = `[fetched_at, fetched_at + decay_hours]`，
新闻 = `[created_at, expires_at]`（两者共用同一个 `linearDecay()`，见 `engine.js`）。

生效实测（同一批情绪，权重 0.2→0.08 + 衰减同时生效）：

| 时刻 | 每轮涨跌幅 | 说明 |
|---|---|---|
| 20:30 / 20:40 | ±0.320% / ±0.300% | 调整前（恒定强度） |
| 20:50 | **±0.068% / ±0.064%** | 调整后：0.08 × 0.8 × decay(≈0.54) × 0.02 ✅ 与公式吻合 |

**删数据注意（无级联）**：
```sql
-- 直连 DB 删主行会留下孤儿关联（表上没有 ON DELETE CASCADE）
DELETE FROM market_sentiment_stocks WHERE sentiment_id = ?;
DELETE FROM market_sentiment        WHERE id = ?;
-- 走接口才会自动连带：DELETE /admin/sentiments/:id（仅超级管理员）
```

**Python 侧没有真事务**：连接是 `autocommit=True`，`conn.commit()` 是空操作；
`news_impact` 逐条 INSERT，**单条失败只记 ERROR 并继续**（整轮标 `[NGA-PARTIAL]`）；
`market_sentiment` 主表与关联表分两次提交，中途崩溃会留下「无关联的主行」。
排查时若看到 `[NGA-PARTIAL]`，按 §9 的思路手工核对缺失的实体即可。

---

## 4. 索引现状与「重复索引」清理

### 4.1 现状：27 组重复索引

`information_schema.STATISTICS` 统计显示：**27 组「首列相同」的索引**，
其中绝大多数是**完全重复**（列顺序、唯一性都一样）。原因是两套来源叠加：

| 来源 | 命名形态 | 例子 |
|---|---|---|
| Sequelize 模型声明（`sync()` 建） | `<表>_<列1>_<列2>` | `holdings_user_id_stock_id`、`news_expires_at` |
| 历史 SQL 迁移/init.sql（另建） | `idx_*` / `uk_*` | `uk_holding_user_stock`、`idx_news_expires` |

典型重复对（生产实测）：

| 表 | 保留（模型声明） | 冗余（迁移另建） |
|---|---|---|
| `holdings` | `holdings_user_id_stock_id` (UQ) | `uk_holding_user_stock` (UQ) |
| `news` | `news_expires_at` / `news_publisher_id` / `news_review_status` | `idx_news_expires` / `idx_news_publisher` / `idx_news_review_status` |
| `trades` | `trades_matched_at` / `trades_order_id` / `trades_stock_id_matched_at` / `trades_user_id_matched_at` | `idx_trades_matched` / `idx_trades_order` / `idx_trades_stock_time` / `idx_trades_user_time` |
| `orders` | `orders_status_type` / `orders_stock_id_status` / `orders_user_id_status` | `idx_orders_status_type` / `idx_orders_stock_status` / `idx_orders_user_status` |
| `watchlists` | `watchlists_user_id_stock_id` (UQ) / `watchlists_stock_id` | `uk_watch_user_stock` (UQ) / `idx_watch_stock` |
| `votes` | `votes_user_id_target_type_target_id` (UQ) / `votes_target_type_target_id` | `uk_vote_user_target` (UQ) / `idx_votes_target` |
| `fund_constituents` | `fund_constituents_fund_id_constituent_id` (UQ) / `fund_constituents_constituent_id` | `uk_fund_constituent` (UQ) / `idx_fc_constituent` |
| `operation_logs` | `operation_logs_action` / `operation_logs_user_id_created_at` | `idx_logs_action` / `idx_logs_user_time` |
| `device_registrations` | `device_registrations_ip_created_at` | `idx_device_ip_time` |
| `market_sentiment` | `market_sentiment_platform_fetched_at` / `market_sentiment_review_status_fetched_at` | `idx_ms_platform_time` / `idx_ms_review` |
| `stocks` | `stocks_name` / `stocks_type` | `idx_stocks_name` / `idx_stocks_type` |
| `users` | `users_role` | `idx_users_role` |
| `news_stocks` | `news_stocks_news_id_stock_id` (UQ) / `news_stocks_stock_id` | `idx_ns_stock`（`PRIMARY(news_id,stock_id)` 与前者语义也重复） |

**代价**：不是空间（全库索引才 5 MB），而是**每次写入要维护两套索引** ——
下单/撮合路径全是写操作，2 核机器上这是白白多出来的写放大。

⚠️ **27 组里并非全都能删**：有 3 组「首列相同」是必须保留的（它们不是重复索引，只是首列恰好相同）：

| 组 | 必须保留的那个 | 为什么 |
|---|---|---|
| `market_sentiment.platform`（3 个） | `uk_sentiment_batch(platform,batch_date,batch_key,direction)` | **业务去重键**，删了会重复写入 |
| `stocks.name`（3 个） | `uk_stocks_name`（UNIQUE） | **唯一约束**（角色名不能重名）；另外两个非唯一索引才是冗余的 |
| `news_stocks.news_id`（2 个） | `PRIMARY(news_id,stock_id)` | 主键，绝不能动（另一个 UNIQUE 是纯重复） |

其余 24 组都是「同一批列、同一顺序、同一唯一性」的纯重复，删掉迁移另建的那一份即可。

> `price_history` 的重复索引已在 2026-09-12 清掉（迁移 `..._price_history_drop_dup_indexes.sql`），
> 结论是「**保留模型声明的那份**，删迁移另建的」—— 因为一旦删掉模型声明的，
> 下次重启 `sequelize.sync()` 会把它加回来，形成死循环。其余表尚未清理。

### 4.2 查看与清理

```sql
-- 列出所有「首列相同」的索引组（重复嫌疑）
SELECT TABLE_NAME, COLUMN_NAME, COUNT(DISTINCT INDEX_NAME) AS idx_cnt,
       GROUP_CONCAT(DISTINCT INDEX_NAME ORDER BY INDEX_NAME) AS idx_names
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND SEQ_IN_INDEX = 1
GROUP BY TABLE_NAME, COLUMN_NAME HAVING idx_cnt > 1;

-- 生成 DROP 语句（只列「迁移另建」的那一份，逐条人工确认后再执行）
SELECT CONCAT('ALTER TABLE `', TABLE_NAME, '` DROP INDEX `', INDEX_NAME, '`;') AS stmt
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND SEQ_IN_INDEX = 1
  AND (INDEX_NAME LIKE 'idx\_%' OR INDEX_NAME LIKE 'uk\_%')
  AND INDEX_NAME <> 'PRIMARY'
GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME;
```

**执行纪律**：
1. 一次只删一张表、先备份（§8）、删完 `EXPLAIN` 抽查关键查询（盈亏报表、周期统计、后台列表）；
2. **先排除 §4.1 那 3 组「必须保留」的情况**（去重键、唯一约束、PRIMARY 一律不动）；
3. 删完重启一次后端，观察 `sequelize.sync()` 的日志里有没有把索引加回来。

---

## 5. 数据量、增长与保留策略

生产实测（2026-09-14）：

| 表 | 行数 | 体积 | 清理策略 |
|---|---:|---:|---|
| `price_history` | 70,105 | 9.5 MB | ✅ 周期线保留 21 天（每天 04:00 分批删）；日线永久 |
| `operation_logs` | 1,429 | 208 KB | ❌ **无清理** |
| `orders` | 647 | 160 KB | ❌ 无清理（保留委托历史） |
| `trades` | 612 | 192 KB | ❌ 无清理（审计凭证，永不删） |
| `users` | 154 | 112 KB | ❌（用 `status=2` 逻辑删除） |
| `stocks` | 132 | 176 KB | ❌（用停牌/退市代替删除） |
| `holdings` | 89 | 48 KB | ❌ |
| `watchlists` | 61 | 80 KB | ❌ |
| `nga_analysis_log` | 131 | 48 KB | ❌ **无清理**（且门控自锁后仍在长，≈576 行/天） |
| `device_registrations` | 53 | 64 KB | ❌（设计上永久保留，防同设备再注册） |
| `holding_lots` | 39 | 48 KB | ❌（随持仓变动自然增减） |
| `news_impact` | 19 | 48 KB | ✅ 覆盖式 upsert（每实体一行，不增长） |
| `news_stocks` | 15 | 64 KB | ❌ |
| `fund_constituents` | 11 | 80 KB | ❌ |
| `news` | 7 | 80 KB | ❌（用「立刻失效」代替删除） |
| `votes` | 5 | 80 KB | ❌ |
| `market_sentiment_stocks` | 5 | 32 KB | ❌ |
| `market_sentiment` | 1 | 64 KB | ❌（按批次去重，增长很慢） |
| `system_settings` | 49 | 48 KB | 固定规模 |

**增长预估与风险**：

- `price_history` 是唯一的大表：132 标的 × 144 轮/天 ≈ **1.9 万行/天**（2026-09-12 实测单日 18,394 行），
  21 天滚动 ≈ 40 万行、体积封顶约 **60 MB**。
  **索引约 90 字节/行** —— 若哪天关掉保留策略让它长到 600 万行，索引约 1.1 GB + 数据约 450 MB，
  而**缓冲池只有 48 MB**，任何「扫历史」的查询都会退化成磁盘随机读。这就是保留策略存在的唯一原因。
- 顺带记住：保留策略只降低增长速度，**并不解决「缓冲池小于工作集」这件事**（缓冲池至今仍是 48 MB）。
- `operation_logs` 约 **280 行/天**（~110 KB/天 → ~40 MB/年）。目前不需要处理，但如果哪天要控制体积，
  建议按 `created_at` 保留 180 天，分批删除（照抄 `runKlineRetention()` 的写法：5000 行/批 + 批间 sleep）。
- `nga_analysis_log` **≈576 行/天**（cron 每 5 分钟一跳，无论是否真分析都写「启动 + 跳过」两行
  = 24 行/小时；实测 2.7 小时新增 131 行）→ 约 15 MB/年，同样是「没有清理」的表。
- `news_impact` 行数上限 = 实体数（132），不会增长；`market_sentiment` 每天每批次 ≤ 2 行。

**相关读路径的实测耗时**（用于判断「是不是慢」）：

| 查询 | 实测 | 条件 |
|---|---|---|
| 盈亏报表（3 / 7 / 14 天） | **138 / 104 / 96 ms** | 100 用户 / 16 条成交 / 4.7 万行 K 线；固定 6 条查询全走索引 |
| 排行榜快照重算 | **3 ms（本地）/ 8 ms（生产）** | 100 用户量级；挂在周期任务里算一次，接口零 DB 压力 |
| 性能采样一次 | 1.6 ~ 4.4 ms | 只读 `/proc` + 一条极小 SQL |

### 5.1 哪些表能清、哪些绝对不能碰

| 表 | 能清吗 | 怎么清 / 为什么 |
|---|---|---|
| `price_history` | ⚠️ 只清周期线 | 有自动任务（保留 21 天）；**日线别动** —— 长周期行情图与盈亏报表都依赖它 |
| `operation_logs` | ✅ 可以 | 按 `created_at` 分批删（建议保留 180 天）；删了只丢审计追溯 |
| `nga_analysis_log` | ⚠️ 谨慎 | 删了会**把门控归零**（下一跳立刻真分析）；建议先把门控改成读 `nga_health_last_run` 再清 |
| `news_impact` | ✅ 可以 | 清空即可，下一轮分析会重建（但舆情也就「回到空白」） |
| `market_sentiment` / `market_sentiment_stocks` | ✅ 可以 | **必须先删关联表**再删主表（无级联），或走 `DELETE /admin/sentiments/:id` |
| `trades` / `orders` / `holdings` / `holding_lots` / `watchlists` / `votes` | ❌ 不要 | 是业务与审计的真相来源；删了会导致资产/盈亏对不上（`trades` 还是定价的统计数据源） |
| `device_registrations` | ❌ 不要 | 删了同一设备就能重新注册 → 被用来刷小号 |
| `system_settings` | ❌ 不要 | 删了配置回默认值（且**明文密钥一起丢**）；要重置用控制面板 |
| `users` / `stocks` | ❌ 不要 | 用 `status` 逻辑处理（禁用/注销、停牌/退市），不要物理删 |
- `trades` / `orders` / `holdings` / `holding_lots` 都随玩家行为线性增长，一年量级仍是几十 MB。

---

## 6. 字符集、编码与时区

### 6.1 结论

- 库/表/连接统一 `utf8mb4`；**业务数据（角色名、昵称、新闻标题、公告）实测全部正常**。
- **但部分表的「列注释」是乱码**（`users.username` 显示 `鐧诲綍鍚` 这类）。
  只影响 `SHOW CREATE TABLE` 的可读性，**不影响任何功能**。

### 6.2 乱码的范围与根因（已核实）

| 表 | 注释状态 | 它们的共同点 |
|---|---|---|
| `users`(部分列)、`stocks`、`orders`、`trades`、`holdings`、`news`(部分列)、`operation_logs`、`price_history` | ❌ 乱码 | 早期在 **Windows 上**用 GBK 控制台把 UTF-8 的 `.sql` 灌进 MySQL（UTF-8 字节被当成 GBK 解释后再存） |
| `holding_lots`、`news.review_status`、`market_sentiment`、`nga_*`、`news_impact`、`system_settings.s_value` | ✅ 正常 | 在 **Linux 服务器**上执行，或通过 `apply-sql.mjs`（Node 读 UTF-8）执行 |

**纪律**：跑 `.sql` 文件时**永远不要**用 Windows 控制台重定向。用下面任一方式：

```powershell
# 推荐：Node 版（按 server/.env 连库，UTF-8 无歧义，支持多语句）
node deploy/apply-sql.mjs server/sql/migrations/<file.sql>

# 或：双击项目根目录的 数据库迁移.bat（交互式，直接回车 = 全部跑）
# 或：在服务器（Linux，UTF-8 locale）上
mysql -uteyvat -p"$DB_PASSWORD" teyvat_stock < <file.sql>
# 若必须在 Windows 用命令行，务必加参数：
mysql --default-character-set=utf8mb4 -uroot -p"$DB_PASSWORD" teyvat_stock < <file.sql>
```

**想修掉历史乱码注释**（可选、纯美化）：用 `utf8mb4` 连接把正确的注释重新
`ALTER TABLE ... MODIFY COLUMN ... COMMENT '...'` 一遍即可；不建议为此改数据类型。

### 6.3 时间与时区

- 服务器时区 `Asia/Shanghai`，Sequelize 连接 `timezone: '+08:00'`，全库 `DATETIME`（不带时区）。
- **不要**用 `NOW()` 与 JS 的 `Date` 混算「周期窗口」：周期统计用的是
  `trades.matched_at ∈ (prevRunAt, now]`，两端都由 Node 生成，保持一致。
- 日线 `ts` 是「当天 15:00」（`DAILY_CLOSE_HOUR`）而不是 0 点，判断「今天是否已收盘」时按日期取整。

---

## 7. 迁移体系：18 个迁移与「两地一致」

### 7.1 目录与工具

| 位置 | 作用 |
|---|---|
| `server/sql/init.sql` | **新建库**的初始结构（MySQL 8 DDL + 默认设置项）。⚠️ 见下「落后于迁移」 |
| `server/sql/migrations/*.sql` | 增量迁移，**全部幂等**（`CREATE TABLE IF NOT EXISTS` / 先查 `information_schema` 再 `PREPARE`+`EXECUTE`） |
| `deploy/apply-sql.mjs` | 按 `server/.env` 执行一个 `.sql`（Node + mysql2，`multipleStatements`） |
| `数据库迁移.bat` | 交互式迁移入口（回车 = 全部按序跑） |
| `deploy/check-db-sync.mjs` | **只读**结构对比：本地 vs 云端（缺表/列差异/设置项差异） |
| `server/src/utils/checkSchema.js` | 后端**启动自检**：缺表/列长度不对就打 WARN（不阻断启动） |

### 7.2 迁移清单（按时间）

| 迁移文件 | 做了什么 |
|---|---|
| `2026-09-09_operation_logs_user_agent` | `operation_logs` 加 `user_agent` |
| `2026-09-10_add_users_token_version` | `users.token_version`（JWT 可吊销） |
| `2026-09-10_device_limit_and_last_login` | `device_registrations` 表 + `users.register_device` / `last_login_*` |
| `2026-09-11_index_funds` | 指数基金一期：`stocks.type/nav` + `fund_constituents` |
| `2026-09-11_kline_period_varchar` | `price_history.period`：ENUM(`10m`,`1d`) → **VARCHAR(8)** |
| `2026-09-11_stock_status` | `stocks.status`（正常/停牌/退市） |
| `2026-09-11_trades_matched_index` | `trades.matched_at` 索引（盈亏报表按时间窗口聚合） |
| `2026-09-12_holding_lots` | `holding_lots` 表（T+N 锁仓） |
| `2026-09-12_nga_news_impact` | **`news_impact` + `nga_analysis_log`** + NGA/GEMINI 配置项 |
| `2026-09-12_price_history_drop_dup_indexes` | 删 `price_history` 的重复索引（保留模型声明那份） |
| `2026-09-12_roles_and_news_review` | **身份组扩到 7 种** + `news.review_*` 审核字段 |
| `2026-09-12_total_shares_rescale` | `total_shares` 重标定到 4 万~20 万（此前个股市场是「死的」） |
| `2026-09-12_trades_realized_pnl` | `trades.cost_amount` / `realized_profit` |
| `2026-09-12_trades_stamp_tax` | `trades.fee`（卖方印花税，唯一摩拉回收阀门） |
| `2026-09-12_users_rank_opt_in` | `users.rank_opt_in` |
| `2026-09-13_nga_panel_settings` | NGA 配置全部搬进控制面板；**`s_value` 扩到 8192**；旧大写键迁移 |
| `2026-09-14_market_sentiment` | **`market_sentiment` + `market_sentiment_stocks`** |
| `2026-09-14_nga_conclusion_news` | 舆情结论自动发新闻（3 个版面配置项，进待审） |

### 7.3 四个已知缺口（会咬人）

**① `init.sql` 落后于迁移 —— 只覆盖 15/19 张表**

缺的 4 张：`news_impact`、`nga_analysis_log`、`market_sentiment`、`market_sentiment_stocks`；
另外它的 `system_settings.s_value` 仍是 `VARCHAR(500)`（应为 8192），注释还写着「布尔开关 0/1」。

⇒ **新建库的正确姿势**：`init.sql` + 依次跑完 `migrations/` 全部文件（`数据库迁移.bat` 一键）。
只跑 `init.sql` 会缺表、缺配置项，本地面板会看不到 NGA 分组。

**② 模型层的 `s_value` 也还是 500**：`server/src/models/systemSetting.js` 里声明的是
`STRING(500)`（只有数据库被迁移改成了 8192）。当前无影响（`sync()` 不改已有表），
但如果哪天表被 `sequelize.sync()` 从零建出来，长度会退回 500，**NGA Cookie 立刻写不进去**。
建议把模型声明与 `init.sql` 一起同步到 8192。

**③ 四张新表的「归属」是分裂的**

| 表 | 有 model？ | `sequelize.sync()` 会建吗 | 谁保证结构 |
|---|---|---|---|
| `market_sentiment` / `market_sentiment_stocks` | ✅ | **会**（含索引） | sync + 迁移（双份保证） |
| `news_impact` / `nga_analysis_log` | ❌ | **不会** | **只有迁移**（所以需要 §7.4 的自检） |

**④ `checkSchema.js` 的列长度检查实际不生效**（小 bug）

```js
const MIGRATION_OWNED_COLUMNS = [
  ['system_settings', 's_value', '512,4', 'Cookie/密钥需要长文本…'],
];
// 判定：Number(hit.len) < Number(minLen)  →  Number('512,4') = NaN → 永不成立
```
`minLen` 写成了 `'512,4'`（疑似想写 5124），`Number()` 得到 `NaN`，比较恒为 false，
所以即使某库的 `s_value` 还是 500 也不会告警。修法：把该项改成数字（如 `512` 或 `8192`）。

### 7.4 两地一致的三个闸门

1. 后端启动自检（`checkSchema`）→ 日志里 WARN；
2. `node deploy/check-db-sync.mjs`（本地缺迁移）/ 带 `--remote-*` 参数时逐列对比云端；
3. 写迁移的人负责**跑两遍**（本地 + 云端），详细清单见 `docs/backups/DB_SYNC.md` §4。

---

## 8. 备份、恢复与远程连接

### 8.1 生产备份

- 目录：`/root/backups/`（每次改数据前手工建一个子目录，例如 `pre-roles-20260913-074346/`）。
- 内容范式：`db.sql.gz`（`mysqldump --single-transaction --routines --events`）+ `server-code.tar.gz` + `web.tar.gz`。
- 现成脚本：`deploy/backup-prod.sh`
  本地拉取用项目根目录的 **`拉取服务器备份.ps1`**（支持 OpenSSH / PuTTY 双后端，可 `-KeepServer`）。

> ⚠️ **备份文件里有明文密钥**：`system_settings` 存着 `gemini_api_key` 与 `nga_cookie`，
> 所以 `db.sql.gz` 要按密钥文件对待（不外传、不放进公开仓库、分享前先脱敏）。

```bash
# 生产上手工备份（在服务器执行）
TS=$(date +%Y%m%d-%H%M%S); BK=/root/backups/manual-$TS
sudo mkdir -p "$BK"
sudo sh -c "mysqldump -uroot -p"$DB_PASSWORD" --single-transaction --routines --events teyvat_stock | gzip > $BK/db.sql.gz"
```

### 8.2 恢复与「恢复演练」

```bash
# 整库恢复（会覆盖现有数据！先停后端避免写冲突）
sudo pm2 stop teyvat-stock-server
sudo sh -c "zcat /root/backups/<目录>/db.sql.gz | mysql -uroot -p"$DB_PASSWORD" teyvat_stock"
sudo pm2 start teyvat-stock-server
```

> ⚠️ **从来没做过恢复演练**：历史会话全量检索「恢复/演练」**零命中**，最接近的动作只有
> 「覆盖前先备份」。也就是说**「备份能不能还原」这件事至今没有被验证过**。
>
> 建议做一次低成本演练（不影响生产）：
> 1. 本地建一个隔离库 `teyvat_restore_test`；
> 2. 把生产最新的 `db.sql.gz` 还原到它里面（`zcat ... | mysql -uroot -p"$DB_PASSWORD" teyvat_restore_test`）；
> 3. 在隔离库里跑 §9 的对账 SQL + 抽查 `users`/`trades`/`holdings` 行数是否与生产一致；
> 4. 确认无误后删掉隔离库。
>
> 顺带一提，早期用过一次「真库开事务跑完再 ROLLBACK」来验证大 INSERT 的语法（见 §13），
> 那是同一类「先验证再动真格」的思路。

### 8.3 远程连接（生产 MySQL 只监听 127.0.0.1）

```bash
# 在本地开隧道，然后连 127.0.0.1:13306
ssh -L 13306:127.0.0.1:3306 root@__DOMAIN__ -N
# DBeaver/Navicat：主机 127.0.0.1 端口 13306 用户 teyvat 库 teyvat_stock
```

账号速查见项目根目录 `db-account.txt`（**该文件已被 `.gitignore` 排除，别外传**）。

---

## 9. 一致性不变式与对账 SQL

本库**几乎没有外键**（全库只有 3 个：`fund_constituents` 的两个 `ON DELETE CASCADE`、
`system_settings.updated_by` 的 `ON DELETE SET NULL`），一致性基本靠应用层。
所以下面这些查询就是「体检表」，怀疑数据被改坏（或做过手工修数据）时按顺序跑一遍：

```sql
-- ① 批次总量 vs 持仓股数（⚠️ 两个方向含义完全不同，必须分开看）
--    持仓 > 批次 = 「老账号宽限」：T+N 功能上线（2026-09-12）前就持有的份额没有批次，正常
--    批次 > 持仓 = 「幽灵批次」：可卖池被撑大，**真 bug**（必须为 0）
SELECT '批次>持仓（真BUG）' AS kind, COUNT(*) AS bad_rows FROM (
  SELECT h.user_id FROM holdings h
  LEFT JOIN (SELECT user_id, stock_id, SUM(quantity) AS t FROM holding_lots GROUP BY user_id, stock_id) l
         ON l.user_id = h.user_id AND l.stock_id = h.stock_id
  WHERE h.quantity < IFNULL(l.t, 0)) a
UNION ALL
SELECT '持仓>批次（老账号宽限，正常）', COUNT(*) FROM (
  SELECT h.user_id FROM holdings h
  LEFT JOIN (SELECT user_id, stock_id, SUM(quantity) AS t FROM holding_lots GROUP BY user_id, stock_id) l
         ON l.user_id = h.user_id AND l.stock_id = h.stock_id
  WHERE h.quantity > IFNULL(l.t, 0)) b
UNION ALL
SELECT '有批次但无持仓行（真BUG）', COUNT(*) FROM (
  SELECT l.user_id FROM holding_lots l
  LEFT JOIN holdings h ON h.user_id = l.user_id AND h.stock_id = l.stock_id
  WHERE h.id IS NULL GROUP BY l.user_id, l.stock_id) c;

-- ② 冻结摩拉 == 未成交买单的冻结额合计
SELECT u.id, u.username, u.frozen_mora, IFNULL(o.reserve,0) AS pending_reserve
FROM users u
LEFT JOIN (SELECT user_id, SUM(reserved_amount) AS reserve
             FROM orders WHERE status='PENDING' AND side='BUY' GROUP BY user_id) o
       ON o.user_id = u.id
WHERE ABS(u.frozen_mora - IFNULL(o.reserve,0)) > 0.01;

-- ③ 冻结股数 == 未成交卖单数量合计
SELECT h.user_id, h.stock_id, h.frozen_quantity, IFNULL(o.qty,0) AS pending_sell
FROM holdings h
LEFT JOIN (SELECT user_id, stock_id, SUM(quantity) AS qty
             FROM orders WHERE status='PENDING' AND side='SELL' GROUP BY user_id, stock_id) o
       ON o.user_id = h.user_id AND o.stock_id = h.stock_id
WHERE h.frozen_quantity <> IFNULL(o.qty, 0);

-- ④ 恒等式：Σ已实现（卖出成交） + 持仓浮动 = 交易总盈亏（逐用户抽查）
SELECT t.user_id, ROUND(SUM(t.realized_profit),2) AS realized_so_far, COUNT(*) AS sells
FROM trades t WHERE t.side='SELL' GROUP BY t.user_id ORDER BY realized_so_far DESC LIMIT 20;

-- ⑤ 异常值扫描（任何一行都不该出现）
SELECT id, username, mora, frozen_mora FROM users WHERE mora < 0 OR frozen_mora < 0;
SELECT id, code, price, total_shares FROM stocks WHERE price <= 0 OR total_shares <= 0;
SELECT id, user_id, stock_id, quantity FROM holdings WHERE quantity > 0 AND avg_cost <= 0;

-- ⑥ 孤儿数据（删标的/删账号后的残留，都应为 0）
SELECT '孤儿投票'     AS kind, COUNT(*) AS bad_rows FROM votes          WHERE target_type='STOCK' AND target_id NOT IN (SELECT id FROM stocks)
UNION ALL SELECT '孤儿新闻关联', COUNT(*) FROM news_stocks             WHERE stock_id  NOT IN (SELECT id FROM stocks)
UNION ALL SELECT '孤儿持仓',     COUNT(*) FROM holdings                WHERE stock_id  NOT IN (SELECT id FROM stocks)
UNION ALL SELECT '孤儿批次',     COUNT(*) FROM holding_lots            WHERE stock_id  NOT IN (SELECT id FROM stocks)
UNION ALL SELECT '孤儿情绪关联', COUNT(*) FROM market_sentiment_stocks WHERE sentiment_id NOT IN (SELECT id FROM market_sentiment);

-- ⑦ 系统总摩拉（只应由「注册赠金 + 交易盈亏 − 印花税」改变；引入利息/杠杆后还要减利息）
SELECT ROUND(SUM(mora + frozen_mora), 2) AS total_mora FROM users;
```

### 9.1 体检基线（2026-09-14 02:18 实测，全部只读）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 批次 > 持仓（幽灵批次） | **0** ✅ | 健康 |
| 持仓 > 批次（老账号宽限） | 56 | **正常**：功能上线前的持仓没有批次 |
| 有批次但无持仓行 | **0** ✅ | 健康 |
| 冻结摩拉 vs 未成交买单 | **0** ✅ | 对得上 |
| 冻结股数 vs 未成交卖单 | **0** ✅ | 对得上 |
| 负余额 / 异常价格 / 无成本持仓 | **0 / 0 / 0** ✅ | 健康 |
| **孤儿投票**（标的已删） | **3** ⚠️ | 见下：`deleteStock` 不清 `votes`，属已知缺口 |
| 孤儿新闻关联 / 持仓 / 批次 | 0 / 0 / 0 ✅ | 健康 |
| 系统总摩拉 | **235,664,070.32**（154 个账号） | 用于对比通胀速度：2026-09-12 快照是 **109,993,856.45（124 人）** → 两天涨了约 1.14 倍 |

> 孤儿投票的 3 行可以用下面这条清掉（先备份）：
> ```sql
> DELETE FROM votes WHERE target_type='STOCK' AND target_id NOT IN (SELECT id FROM stocks);
> ```

**外键现状与「删除要自己清关联」**：

> 当初为什么（基本）不做外键：`votes` / `operation_logs` 这类表的「目标」是**多态**的
> （同一列可能指向新闻、也可能指向角色），没法建外键；用户删除则从「应用层级联删除」
> 演变成了**逻辑删除**（`users.status`）。四张 NGA 新表也一律不加外键，保持脚本写入简单。

| 关系 | 有外键？ | 删除时的行为 |
|---|---|---|
| `fund_constituents` → `stocks`（基金/成分股两侧） | ✅ | **CASCADE**：删标的会自动清掉它作为成分股/基金的行 |
| `system_settings.updated_by` → `users` | ✅ | **SET NULL**：删用户后设置项的「更新人」置空 |
| `orders` / `trades` / `holdings` / `holding_lots` / `watchlists` / `news_stocks` / `price_history` / `votes` → `stocks` 或 `users` | ❌ | **应用层负责**：删标的必须按 `orders → holdings → holding_lots → trades → watchlists → news_stocks → price_history` 顺序清理（`adminController.deleteStock`），漏一张就会在「我的持仓」接口里读到孤儿数据并 500 |
| `market_sentiment_stocks` → `market_sentiment` | ❌ | 走接口删会自动连带（`sentimentController` 先清关联再删主行）；**直连 SQL 删主行会留孤儿** |

> 已知缺口：`votes`（`target_type='STOCK'` 的行）**不在** `deleteStock` 的清理清单里，
> 删标的后会留下指向已不存在标的的投票行。目前无害（引擎只按现有标的相关联的 id 取票），
> 但严格说属于孤儿数据，清理时可顺手 `DELETE FROM votes WHERE target_type='STOCK' AND target_id NOT IN (SELECT id FROM stocks);`

---

## 10. 一次性数据修复脚本

| 脚本 | 目的 | 幂等 | 备注 |
|---|---|---|---|
| `deploy/backfill-realized-pnl.mjs | 回填 `trades.cost_amount` / `realized_profit`（按 (user,stock) 时间序重放） | ✅ 每次从零重放 | 支持 `--dry-run`；结束会用推演持仓与 `holdings` 对账 |
| `server/scripts/nga_panel_migrate.py` | 把 NGA 配置从 `.env`/`cookies.json` 迁进 `system_settings` 并删旧大写键 | ✅ 保留库中已有值 | 只在服务器上跑过 |
| `deploy/fix-orphans.mjs` | 清理孤儿关联数据 | 需人工确认 | 见脚本头部说明 |
| `server/sql/stocks_genshin_characters.sql` | 导入角色标的（30 KB） | — | 用 `apply-sql.mjs` 执行，勿用 Windows 控制台重定向 |
| `server/sql/placeholder_users_2_100.sql` | 本地造占位账号（只用于本地/测试库） | — | **不要在生产跑** |
| `server/src/scripts/test-roles.mjs` | 身份组权限矩阵回归（60 项断言） | ✅ 幂等 | 见 `docs/ROLES.md` §10 |
| `server/src/scripts/make-test-root.mjs` | 建本地测试超管 `roletest_root` | ✅ | 只用于本地 |

> 涉及资金的修复脚本**先 `--dry-run`、先备份、后执行**，并在执行后跑 §9 的对账 SQL。

---

## 11. 排查手册

**后端起不来 / 报「数据库连接失败」**
1. `server/.env` 的 `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME`；
2. 生产上 MySQL 只监听 127.0.0.1（必须从服务器本地连，或开隧道）；
3. `systemctl status mysql` / 宝塔面板看 MySQL 是否在跑；`max_connections=30` 被打满时也会报错。

**表/列不存在（Unknown column / Table doesn't exist）**
1. 先看后端启动日志里的 `[自检]`（`checkSchema`）；
2. `node deploy/check-db-sync.mjs` 看是不是漏跑迁移；
3. 新建库只跑了 `init.sql` → 补跑全部迁移（§7.3）。

**写入报 `Data truncated for column`**
- 典型的 ENUM 不够用（历史上 `price_history.period` 就是这个问题）。
  要加新枚举值时**必须写迁移**（`init.sql` 只管新库）。

**价格/统计不对**
1. `trades.matched_at` 是否落在当前周期窗口 `(prevRunAt, now]`；
2. 该标的 `stocks.status` 是不是 0/2（停牌/退市不参与撮合）；
3. `price_history` 里该周期的 `volume` 是否与该窗口成交股数一致。

**新闻没生效**
- `news.review_status` 是否为 `APPROVED`、`expires_at` 是否已过、`allow_news_publish` 是否被关。

**磁盘/内存告警**
1. `price_history` 行数与 `kline_retention_days` 设置；
2. 缓冲池只有 48 MB，别让后台任务做全表扫描（`information_schema` 查询无妨）；
3. `SHOW PROCESSLIST` 看有没有长事务（本系统都是短事务，出现 >10s 的查询要立刻查）。

**怀疑数据被改坏**
- 跑 §9 的六条对账 SQL；怀疑人工改过成交/持仓时，直接用 `backfill-realized-pnl.mjs --dry-run` 重放比对。

---

## 12. 代码索引

| 关注点 | 位置 |
|---|---|
| 连接与全局约定（charset/时区/连接池/`underscored`） | `server/src/config/db.js` |
| 模型定义（16 个 model）与关联 | `server/src/models/*.js`、`models/index.js` |
| 全量 DDL（新建库） | `server/sql/init.sql` |
| 增量迁移 | `server/sql/migrations/*.sql`（18 个） |
| 迁移执行器 | `deploy/apply-sql.mjs`、`数据库迁移.bat` |
| 结构自检 / 两地对比 | `server/src/utils/checkSchema.js`、`deploy/check-db-sync.mjs` |
| 下单/撮合/冻结清算（事务与行锁） | `server/src/services/tradingService.js` |
| 周期结算写 K 线与删旧 K 线 | `server/src/jobs/cycleJob.js`（P3 / P4 / P5） |
| 定价读新闻与投票 | `server/src/services/engine.js` |
| 设置读写与快照 | `server/src/services/settingService.js` |
| 排行榜聚合 SQL | `server/src/services/rankService.js` |
| 明星持仓聚合 SQL | `server/src/controllers/starController.js` |
| 舆情写库（Python，唯一写入方） | `server/scripts/nga_analysis.py`（影响值 upsert ~922-959、情绪 upsert ~728-833、日志 Handler ~189-236、频率门控 ~285-311） |
| 舆情配置迁移（旧大写键→面板键） | `server/scripts/nga_panel_migrate.py` |
| 手动「立即抓取」（Node 起 Python） | `server/src/utils/ngaRun.js`、`adminController.js`（`ngaRunNow`） |
| 市场情绪接口（前台/管理端） | `server/src/controllers/sentimentController.js`、`routes/sentiment.js`、`routes/admin.js`、模型 `models/marketSentiment.js` |
| 盈亏报表（读 `price_history` 期初价） | `server/src/controllers/adminController.js`（`pnlReport`） |

---

## 13. 历史决策与事故记录

| 时间 | 事项 | 结论 / 教训 |
|---|---|---|
| 2026-09-06 | 一次建 11 张表（`sync()` + `init.sql` 同源） | 决定「一期的表一次建全」，避免后期迁移成本；`init.sql` 带 `DROP TABLE IF EXISTS`（**只在全新库用**） |
| 2026-09-07 | 新建 `system_settings`（用户要求「用数据表存开关，不要用文件」） | 默认值定义在 service 的 `SETTING_SCHEMA` 里，**表里没记录也能安全取值**；布尔存 `'1'/'0'` 字符串 |
| 2026-09-09 | **事故：`system_settings` 列名两套** | `sync()` 按模型建了 `key/value`，与 `init.sql` 的 `s_key/s_value` 不一致 → 模型查询报错（当时的自评是「严重部署 bug」）→ `CHANGE COLUMN` 改名保留数据。**同一张表两个定义来源，就是这类事故的温床** |
| 2026-09-09 | **事故：2C1G 机器被 MySQL 8 挤爆、SSH 一度失联** | 现象 `mysqld` RSS 213 MB（30.3%）、宝塔再吃 ~95 MB，总内存只有 701 MB → 狂用 swap、sshd 可能 fork 不出来。处置：加 2G swap + `vm.swappiness=30`、关 `performance_schema`、**缓冲池收到 48 MB**、`max_connections=30`；MySQL RSS 213→136 MB。**至今缓冲池仍是 48 MB** |
| 2026-09-09 | **事故：`mysql-lowmem.cnf` 模板三个「起不来」的坑** | ① 用 `--` 注释（MySQL 只认 `#`/`;`）；② **参数行尾**写注释被当成值的一部分；③ 文件带 UTF-8 BOM。改完用 `mysqld --validate-config` 验证过 |
| 2026-09-09 | 迁移写法定型 | **MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`**（那是 MariaDB 的）→ 全部改用 `information_schema` 查询 + `PREPARE`/`EXECUTE` 的幂等范式 |
| 2026-09-10 | **事故：本地缺列 → 500，且审计日志一直静默失败** | 模型加了 `user_agent` 但本地没跑迁移 → `1054 Unknown column`；更隐蔽的是写日志的 `OperationLog.create(...).catch(() => {})` **把错误全吞了**，登录记录压根没写进去。处置：写出通用执行器 `deploy/apply-sql.mjs` 并补跑本地。教训：**`.catch(()=>{})` 会掩盖真实的数据库结构问题** |
| 2026-09-10 | **事故：孤儿数据打爆「我的」页面** | 导入 127 角色时旧 demo 股（id 1–6）被替换，引用没清：holdings 2 / orders 30 / trades 27 / news_stocks 7 / **price_history 2,046** 行孤儿 → `h.stock === null` 抛 TypeError，整个首屏 500。处置：接口容错 + 重写 `deleteStock`（同事务清理 + 有持仓/挂单时拒绝删除）+ `fix-orphans.mjs`。**这就是 §9 那张「外键现状」表的由来** |
| 2026-09-10 | UID 2–100 清空并塞入 99 个占位账号（用户主动要求，把号段留给活动） | 副作用：旧的 `operator`/`admin`/`root` 三个演示账号一并被清、`news` id=1 被删；执行前两库都做了整库备份，账号密码清单落在本地（带 BOM + 已 gitignore） |
| 2026-09-10 | 用本地 dump 整体覆盖生产库 | 覆盖前先备份。此后形成纪律：**改生产前先跑 `backup-prod.sh` |
| 2026-09-11 | **事故：`price_history.period` 是 ENUM → 整轮结算事务回滚** | 控制面板把周期改成 2 分钟 → `'2m'` 被 ENUM 拒绝（Data truncated）→ **异常导致整轮结算事务回滚，价格不更新**，只留一条含糊的日志。本地与生产**都在潜伏**。处置：改 `VARCHAR(8)`。教训：**运行期可配置的值一律 VARCHAR，固定集合才用 ENUM** |
| 2026-09-12 | **事故：K 线重复索引，第一版迁移还删错了方向** | 4 个索引是两对完全重复（33,075 行时索引 6.06 MB ≈ 数据的 2.4 倍）。第一版迁移删了**模型声明**的那份，而且守卫用的相关子查询在**生产静默不生效**（部署后索引一个没少），本地却真删了 → **两库不一致**。重写为「先补齐模型声明的、再删迁移另建的」，生产重跑 + 重启后稳定 3 个索引（重启不会被 `sync()` 加回）。**这条纪律后来推广到全部 27 组重复索引（见 §4）** |
| 2026-09-12 | 印花税 / `rank_opt_in` / `total_shares` 重标定 | 印花税：此前**零回收阀门**，全服摩拉只增不减。重标定：原 500 万流通盘下「一个玩家砸全部身家只让价格动 0.039%」，**个股市场实际上是死的** |
| 2026-09-12 | T+N 锁仓引入 `holding_lots` | 被否方案（`holdings.opened_at`）会留「今天买、只要行是早先开的就能卖」的洞；选 FIFO 批次。**踩坑**：关闭限制时若不消费批次，会留下「幽灵批次」把可卖池撑大 |
| 2026-09-12 | 平仓盈亏落库 | `holdings.avg_cost` 是**当前**成本，历史某笔卖出的成本点已被覆盖 → 成交时快照 `cost_amount` / `realized_profit`，并保持 `Σ已实现 + 未实现 = tradingProfit` |
| 2026-09-12 | 身份组扩到 7 种 + 新闻审核 | 见 `docs/ROLES.md`；删除类操作统一收归超级管理员 |
| 2026-09-13 | **事故：`s_value` 装不下 NGA Cookie** | 原 `VARCHAR(500)`，Cookie 795 字符 → `Data too long`。扩到 **8192**（模型声明至今仍是 500，见 §7.3②） |
| 2026-09-13 | **事故：本地库缺 2 张表** | 迁移只打在生产 → 本地面板看不到 NGA 分组。根因：`sync()` 只处理「有 model 的表」，无 model 的表永远不被创建/检查 → 新增 `checkSchema.js` 启动自检 + 补跑迁移 |
| 2026-09-14 | 市场情绪独立成表 | 与新闻彻底分开（表/接口/前台分开）；唯一键含 `direction` 支持一次监控拆两行 |
| 2026-09-14 | **发现：NGA 分析门控自锁** | 门控取 `nga_analysis_log.MAX(created_at)`，而同轮「脚本启动」日志先落库 → 间隔恒为 0.0 分钟 → **自动分析从不运行**，只有面板「立即抓取」能跑（实测 131 行日志里 4 次真分析）。修法见 §3.4 |
| 2026-09-14 | 舆情影响值尚未接入定价 | `news_impact` 只写不读；`NEWS_IMPACT_WEIGHT` 等 3 个键无任何消费方，属死配置 |
| 2026-09-14 | **事故：「我提交的新闻」永远空白** | 接口字段契约断裂：`/operator/news` 少了 `publisherId`，前端按该字段过滤 → 恒不命中（接口 200 但页面空）。根因是前端类型把它写成可选（`publisherId?: number`），**`vue-tsc` 静默放过**。修法：后端补字段并抽出 `serializeNewsRow()` 共用 + 新增**服务端过滤**接口 `GET /operator/news/mine`，前端不再自己筛（详见 `docs/backups/BUGFIX_LOG.md`） |
| 2026-09-15 | **市场情绪接入定价 → 发现「零成交推价」** | 情绪以独立权重 `wS` 进定价后，实测钟离 **每轮固定 +0.300%、124 轮全部零成交**，3 小时 +5.56%，K 线成了「凭空出现的直线斜坡」→ 处置：加 **`impact_linear_decay` 线性衰减**（窗口内从满强度降到 0，台阶变斜坡）+ 权重 0.2→0.08 + 时效 3h→2h + 待审不参与定价 + 少关联角色（5→3）。上线后同一批情绪的每轮影响 **0.32% → 0.068%** |
| 2026-09-15 | **修复：NGA 门控自锁** | 一行 SQL 谓词（只统计 `[NGA-…]` 终结行），生产实测间隔从 0.0 → 56.9 分钟，自动分析恢复 |
| 2026-09-15 | 对外列表封顶 20 条 | 新闻与市场情绪的**公开列表**只给最近 20 条（`total` 也钳到 20，分页器自动消失）；后台列表不受影响 |
| — | **从未发生**：死锁 / 锁等待 / 长事务事故 | 全量检索只命中设计说明与业务文案 —— 「事务行锁 + 死锁重试」自第一版就是**预防性设计**，不是事后补的 |

---

## 14. 待处理问题清单（按优先级）

| # | 问题 | 影响 | 建议动作 | 参考 |
|---|---|---|---|---|
| 1 | ~~NGA 频率门控自锁~~ | — | ✅ **2026-09-15 已修复并上线**（`WHERE LEFT(message,5)='[NGA-'`），生产实测间隔从 0.0 → 56.9 分钟 | §3.4 |
| 2 | **27 组重复索引**（Sequelize 与迁移各建一份） | 每次写入维护两套索引；2 核机器上的白白写放大 | 按 §4.2 生成 DROP 清单，逐表确认后清理（保留模型声明那份），清理后重启验证 | §4 |
| 3 | **`nga_analysis_log` 无清理**（≈576 行/天） | 一年约 15 MB / 21 万行 | 加每日保留策略（照抄 `runKlineRetention()` 的分批删除写法）；**注意清空前先确认门控已不再依赖它** | §5 |
| 4 | **`init.sql` 与模型落后**：缺 4 张表、`s_value` 仍是 500 | 新建库缺表缺配置；一旦表被 sync 从零建出，Cookie 立刻写不进去 | 把 4 张表补进 `init.sql`，`s_value` 在 `init.sql` + `models/systemSetting.js` 都改 8192 | §7.3 |
| 5 | **列注释乱码**（早期 Windows 控制台灌 SQL 导致） | 只影响 `SHOW CREATE TABLE` 可读性 | 可选：用 utf8mb4 连接重刷注释；日常跑迁移一律用 `apply-sql.mjs` | §6.2 |
| 6 | **`checkSchema.js` 的列长度检查失效**（`'512,4'` → `NaN`） | 漏迁移时不会告警 | 把该项改成数字（512/8192） | §7.3 |
| 7 | **`news_impact` 未接入定价**（`market_sentiment` 已于 2026-09-15 接入） | AI 逐实体影响值仍只写不读 | 属功能规划问题，不是数据库问题；接入前先读 `docs/PRICING.md` 的因子公式 | §3.4 |

---

## 15. 常用 SQL 速查（本文所有结论都是这么查出来的）

```sql
-- 表清单 + 行数估算 + 体积 + 表注释
SELECT TABLE_NAME, TABLE_ROWS, ROUND((DATA_LENGTH+INDEX_LENGTH)/1024) AS kb, TABLE_COMMENT
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME;

-- 全库列定义（含字段注释；带注释的 DDL 就是最好的文档）
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- 索引全量（找重复索引用 §4.2 的那条）
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- 精确行数（information_schema 的 TABLE_ROWS 是估算值，InnoDB 会偏）
SELECT COUNT(*) FROM price_history;   -- 逐表替换表名

-- 当前连接/锁/长事务
SHOW PROCESSLIST;
SELECT * FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 5;

-- 表体积 Top（找大表）
SELECT TABLE_NAME, ROUND(DATA_LENGTH/1024) AS data_kb, ROUND(INDEX_LENGTH/1024) AS idx_kb,
       ROUND(DATA_LENGTH/1024)+ROUND(INDEX_LENGTH/1024) AS total_kb
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY total_kb DESC LIMIT 10;
```

> 生产上执行任何 SQL 前请先确认：MySQL 只监听 `127.0.0.1`，需要 SSH 登录（或隧道）才能连；
> 并且**先备份**（§8）。

---

## 16. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-09-14 | 首次成文。基于生产库实时结构（`information_schema` 全量导出）、16 个 model、18 个迁移、49 个配置项与历史会话记录整理。 |
| 2026-09-14（同日补） | 补入 NGA/市场情绪四张表的写入方与数据流、Python 侧无事务、密钥明文入库、表归属分裂、模型层 `s_value` 仍是 500；并**实证**了「频率门控自锁」bug（日志里「已过 0.0 分钟」+ 131 行日志只有 4 次真分析）。 |
| 2026-09-14（三补） | ① 用生产实测校正了两处结论：**外键不是「一个都没有」而是 3 个**（含 `ON DELETE CASCADE` / `SET NULL` 的具体行为）、①号不变式必须区分「老账号宽限」与「幽灵批次」（实测 56 行宽限 / **0 行幽灵**）；② 新增 §5.1「哪些表能清、哪些绝对不能碰」、§9.1 体检基线、§15 常用 SQL 速查；③ 补入「孤儿投票 3 行」这条真实缺口与历史事故（NGA 门控自锁、"我提交的新闻"字段契约断裂）。 |
| 2026-09-14（四补） | 并入**历史会话考古**结果（8 个历史会话、6.4 万条记录全量检索）：第 13 章重写为 09-06 → 09-14 的完整时间线，补入此前未记录的事故（`system_settings` 列名两套、2C1G 被 MySQL 挤爆致 SSH 失联、审计日志被 `.catch(()=>{})` 静默吞错、孤儿数据打爆「我的」页、K 线重复索引**删错方向且生产守卫静默失效**、`mysql-lowmem.cnf` 三个语法坑、数据库三套凭据并存）；§3.3 补 `holding_lots` 的被否方案、§3.4 补「覆盖式 upsert」的 AUTO_INCREMENT 实证、§5 补索引字节数与读路径实测耗时、§8.2 新增**恢复演练**建议（历史上从未做过）、§9 补不做外键的原始理由、§9.1 补摩拉通胀基线。 |
| 2026-09-15 | ① **NGA 门控自锁修复并上线**（生产实测「已过 0.0 分钟」→「56.9 分钟」）；② **市场情绪接入定价**的机制与四个设置项写入 §3.4（含 `linearDecay` 线性衰减与「0.32%/轮 → 0.068%/轮」的实测对照）；③ 对外列表封顶 20 条（新闻 + 市场情绪）；④ 修正「舆情未接入定价」的过期结论。 |
| 2026-09-14 | **事故：前端发布清理把线上打白屏**（/、/about、/news 全白） | 现象：浏览器报模块加载失败、整页空白。**三个坑叠加**：① 我删旧 chunk 时的判据是「有没有被 grep 引用到」，而这个判据**不可靠**（每个 chunk 内部都含自己的文件名、旧入口包又各自引用着旧 chunk），我却没修判据就直接按它批量删；② 全局样式表 `index-*.css`（363KB）**只被 index.html 的 `<link>` 引用**，不在 js/css 引用图里 → 被判成孤儿删掉；③ nginx `try_files` 把「缺失的 JS」回退成 `index.html`，Content-Type=text/html → `MIME type text/html is not executable`，比 404 更糟（404 反而会自愈）。处置：从待发布目录恢复 CSS、删掉 6 个依赖已残缺的旧入口包、用户强刷。**教训：前端产物是「HTML + 入口包 + 递归依赖」一套整体；清理判据必须保守（HTML 引用的一律不删），且发布后要用浏览器视角递归验证，不能只看「文件传上去了/HTTP 200」。** 已落地 `deploy/deploy-web.sh`：发布前归档旧版本到 `_archive/`（留 3 份可回滚）、受保护清单（当前+归档 HTML 引用的资源）、清理后二次自检、发布前递归依赖自检（缺一即失败）、`index.html` 内写构建标记 `<!-- BUILD: v0.1.0 @ 时间 -->` 便于判断用户拿到的是哪一版。 |
| 2026-09-14 | **事故：市场情绪「一整天只出得了一条」** | 现象：用户反馈当天没有新的市场情绪。排查：脚本一直在跑（当天 cron 唤起 546 次、真正分析 7 次），问题在最后写入被自己的规则堵死——日志 `市场情绪未写（两条方向都已定稿（同批次同方向已存在非待审记录），本次未更新）`。**两个 bug 叠加**：① 去重粒度是「一整天」：`batch_key` 只存 fid，唯一键 `(platform,batch_date,batch_key,direction)` 意味着当天同方向只允许一行，02:10 写入后全天都在对着同一行去重；② 更新条件带 `review_status='PENDING'`：那条 02:23 被批准后，UPDATE 不再匹配、INSERT 又撞唯一键 → 当天彻底僵死（02:48/02:49/15:29 三轮白跑）；③ 附带：报错文案把「根本没存在过的方向」也说成「已定稿」，误导排查。修复：`batch_key` 改为 `版面|HH:MM`（**粒度=一次监测周期**，同周期内重复跑仍只更新一行、不刷屏；跨周期自然新出一行，可再次送审）；更新条件加 `fetched_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)`，避免无限改写陈旧草稿；新增 `cleanup_stale_pending(48h)` 清理长期没人审的待审情绪（只删 PENDING，已批准/已驳回保留）；报错文案改为点名具体方向。加了 10 项回归断言（`.dsh-test-sentiment-dedup.py`）：已批准行不挡新写入、同周期不刷屏、跨周期能再出、多空独立成行、清理不碰已批准。**教训：凡是「去重/幂等」逻辑，粒度必须显式对齐业务周期；`UPDATE ... WHERE status='PENDING'` 这类「草稿可改、定稿冻结」的写法，必须同时保证「冻结后还能新建」，否则会出现整天僵死。** |
| 2026-09-14 | **改进：帖子正文抓取（AI 不再只看标题）** | 起因：导出一轮「抓取原文 / 提示词 / AI 回复」三份内容供用户核对时发现，AI 判断**完全基于标题**（`thread.php` 的列表响应里根本没有正文字段，`message`/`content` 都不存在）。按用户给的线索（`read.php` 可返回主楼+回复）落地：① **端点必须用 `read.php?tid=`** —— 实测 `thread.php?tid=X` 返回的是跳转页（35KB、`postcontent` 出现 0 次），而 `read.php` HTML 版（约 49KB）才有 `<p id='postcontentN' class='postcontent ubbcode'>`；带 `__output=11` 的 JSON 版会被 CDN 缓存成**截断片段**（13.7KB、尾部切在字符串中间、`__T` 楼层数组不出现），加 page/pos/noBBCode/rand 都绕不过。② **必须对过滤后的帖子抓，不能对原始列表前 N 条抓** —— 否则命中率 0（实测抓了 10 帖正文、命中 0 条，因为送分析的帖子在原始列表里排第 12 名开外）。③ 逐帖抓 → 只保留摘出的短文本（每帖约 60~200 字）→ 原始 HTML 立即回收；**不落临时文件**（12 帖合计不到 1KB，六万倍余量，避免磁盘残留）。④ 新增两个面板配置：`nga_fetch_content`（开关）、`nga_content_max_threads`（默认 12）。⑤ 顺带发现并修复 `clean_text()` 的**贪婪正则 bug**：`\[/?[^\]]{1,12}\]` 会把「[版务公告] 关于…的公告」整条清成空串（任何含两个方括号的标题都会中招），改为非贪婪并补 `[collapse=…]` 与附件名残渣清理；同时把「提问/公告/活动帖过滤」改为**基于原始标题**判断（清洗后前缀已丢失，永远匹配不到）。⑥ 修 `upsert_sentiment` 的报喜不报忧：`INSERT IGNORE` 被唯一键忽略时如实返回 `(0, False)`。**效果对比**：同一批帖子，只看标题时 AI 把「请教下满命夜兰的问题」判成夜兰 +0.50，看正文后同一诉求变成 -0.30 / -0.20（克洛琳德、千织），结论方向完全不同。 |
