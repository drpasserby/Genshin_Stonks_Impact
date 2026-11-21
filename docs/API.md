# 提瓦特证券交易所 · API 文档

- Base URL（开发）：`http://127.0.0.1:3000/api`
- Base URL（生产）：`https://你的域名/api`（Nginx 反代）
- 认证：除 `/auth/login`、`/auth/register`、`/health` 外全部需要请求头 `Authorization: Bearer <token>`
- 统一响应：

```json
{ "code": 0, "message": "ok", "data": { } }
```

- 错误响应：`code` 非 0（如 `UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/`VALIDATION_ERROR`），`message` 为可直接展示的中文提示。
- 角色标记：🟢 所有登录用户 · 🟡 操作员/高级操作员/管理员 · 🔴 管理员（root 自动放行）· 🔒 仅超级管理员
- **身份组**（7 种）：`user` 普通用户 · `vip` 高级用户(免印花税) · `star` 明星(强制公开持仓) ·
  `operator` 操作员 · `senior_operator` 高级操作员(发新闻免审核) · `admin` 管理员 · `root` 超级管理员。
  完整权限矩阵见 **`docs/ROLES.md`**；`GET /auth/me` 会返回派生能力字段
  `roleLabel` / `stampTaxExempt` / `holdsPublic`。
- **★ 删除类接口一律是 `🔒`（仅超级管理员）**：管理员只能用非破坏性替代动作
  （用户 → 禁用/启用；新闻 → 立刻失效；标的 → 停牌/退市；成交记录 → 无任何操作）。

---

## 1. 认证 auth

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/register` | 公开 | 注册。body: `{username, password, nickname?}`。注册成功即返回 `{token, user}`，自动登录 |
| POST | `/auth/login` | 公开 | 登录。body: `{username, password}` → `{token, user}` |
| GET | `/auth/me` | 🟢 | 当前用户信息（含 mora/frozenMora/role） |

## 2. 行情 stocks

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/stocks` | 🟢 | 列表。query: `q=搜索词&sort=price\|changePct\|volume\|name&order=asc\|desc&watch=1只看自选` |
| GET | `/stocks/:id` | 🟢 | 个股详情（含价量/涨跌幅/是否自选） |
| GET | `/stocks/:id/kline?period=10m\|1d&limit=200` | 🟢 | K线数据，按 ts 升序返回 |
| GET | `/stocks/:id/orderbook` | 🟢 | 盘口：聚合未成交限价挂单 → `{price, bids:[{price,qty}], asks:[...]}` |
| GET | `/stocks/:id/news` | 🟢 | 该角色相关新闻（含投票聚合） |
| GET | `/stocks/watchlist` | 🟢 | 自选列表 |
| PUT/DELETE | `/stocks/watchlist/:stockId` | 🟢 | 加入/移出自选 |

字段示例（decorateStock 输出）：

```json
{
  "id": 1, "code": "TY0001", "name": "钟离", "avatarUrl": "https://...",
  "price": 680.5, "prevClose": 670.2, "open": 672, "high": 685, "low": 669,
  "volume": 123456, "totalShares": 10000000, "marketCap": 6805000000,
  "change": 10.3, "changePct": 1.54, "watched": false
}
```

## 3. 交易 / 持仓 / 资金（user）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/user/orders` | 🟢 | 下单。body: `{stockId, side: BUY\|SELL, type: MARKET\|LIMIT, price?, quantity}`。市价单立即成交；限价单冻结后入队（若限价已与现价交叉则立即成交）。返回 `{order, trade|null, message}` |
| GET | `/user/orders?status=PENDING\|FILLED\|CANCELLED` | 🟢 | 我的委托单 |
| POST | `/user/orders/:id/cancel` | 🟢 | 撤单（仅 PENDING），解冻资金/股份 |
| GET | `/user/account` | 🟢 | 资金+持仓汇总 `{mora, frozenMora, totalAssets, marketValue, holdings[], holdingProfit, realizedProfit, tradingProfit}`（后三者：未实现 / 已实现 / 交易总盈亏）|
| GET | `/user/holdings` | 🟢 | 持仓明细（成本/市值/浮动盈亏）。另含最少持有周期字段：`lockedQuantity`（锁仓股数）、`sellableQuantity`（当前可卖）、`unlockAt`（下一批解锁时间）、`holdCycles` |
| GET | `/user/trades?stockId=&page=&pageSize=` | 🟢 | 我的成交记录（分页）。每条含 `amount`（成交额）、`fee`（卖方印花税，买入为 0）、`netAmount`（实际到账 = amount − fee）、`costAmount`（卖出份额成本）、`realizedProfit`（**平仓盈亏（税后）= 到账 − 成本**；买入为 0，前端显示 —） |
| PUT | `/user/rank-opt-in` | 🟢 | 设置「是否参与排行榜」。body `{optIn: boolean}`；关闭后该账号不出现在任何榜单 |

**撮合规则**：市价单按当前股价立即整单成交；限价单冻结资金/股份进入队列，每 10 分钟结算一次——买价≥当前价或卖价≤当前价即以当前价整单成交。成交价恒为撮合时刻当前价。

**卖方印花税**：每笔**卖出**按 `成交额 × STAMP_TAX_RATE`（默认 0.5%，见 `server/.env`）扣税，从卖方到账金额里直接扣除；买入不收。税额单独记在 `trades.fee`，成交额 `amount` 保持市场口径不变。
参见 `docs/PRICING.md` §11。

**平仓盈亏（已实现盈亏）**：每笔卖出额外记录两个字段 —— `cost_amount`（成交时的移动加权均价 × 数量）与 `realized_profit = amount − fee − cost_amount`（**税后**净盈亏）。
口径与持仓页的成本价/浮动盈亏一致，且恒有 **Σ已实现 + 未实现 = 交易总盈亏**（`/user/account` 三个字段直接给出）。
历史成交由 `deploy/backfill-realized-pnl.mjs 一次性回填，算法与接口说明见 `docs/PRICING.md` §13。

**最少持有周期（T+N 锁仓）**：买入的份额需持有满 `min_hold_cycles` 个周期（默认 3）才能卖出；卖出不足期的份额时，下单与挂单都会被拒绝：

| HTTP | message |
|---|---|
| 403 | `该份额持有周期过短，不得卖出。请在买入X个周期后卖出`（X = 当前设置值） |

只锁定**新买入**的份额（按买入批次 FIFO 解锁），本功能上线前的存量持仓不受限。`min_hold_cycles=0` 即关闭。
算法、数据表与排查见 `docs/PRICING.md` §12。

**下单限流（两道闸门，控制面板可热改）**：每人每分钟 `order_rate_per_min`（默认 12 笔）+ 每人每小时 `order_rate_per_hour`（默认 180 笔），超限返回 `429` 并带 `Retry-After`。任一设为 0 表示该闸门关闭。

## 4. 新闻 news（公开阅读）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/news?stockId=` | 🟢 | 新闻列表（可按股票过滤）。**只返回已通过审核（`reviewStatus=APPROVED`）的新闻**；★ **只给最近 20 条**（`page`/`pageSize` 被忽略，`total` 也钳到 20，前端不再翻页） |
| GET | `/news/:id` | 🟢 | 新闻详情（含投票明细）。未通过审核的新闻对外一律 404（不泄露「有待审新闻」这个信息） |

## 5. 操作员 operator

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/operator/news` | 🟡 | 发布新闻。body: `{title, sourceUrl, direction: UP\|DOWN, strength: 0-100, stockIds: number[]}`。<br>**审核规则**：普通操作员 → 落 `PENDING` 待审（返回 `pending: true`，不进价格引擎、不公开、不可投票）；<br>高级操作员/管理员/超管 → 直接 `APPROVED` 生效（`pending: false`）。有效期从**审核通过时刻**起算 |
| GET | `/operator/news` | 🟡 | 新闻列表（含审核状态 `reviewStatus`/`reviewNote`）。可见范围：管理员看全部；普通操作员只能看到**自己提交的**待审新闻 + 全部的已通过/已驳回新闻（防止内幕抢跑）。`?reviewStatus=PENDING` 可只看待审 |
| POST | `/operator/news/:id/vote` | 🟡 | 对新闻投票。body: `{direction, multiplier: 0.5-2.0}`（发布者不能投自己的新闻；**待审新闻不能投票**） |
| POST | `/operator/stock-vote` | 🟡 | 对角色股票投票。body: `{stockId, direction, multiplier}` |
| GET | `/operator/my-votes` | 🟡 | 我投过的票 |

## 6. 管理 admin

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET/POST | `/admin/users` | 🔴 | 用户列表(分页) / 创建用户 `{username,password,nickname,role}`。搜索 `q` 同时匹配**用户名与昵称**。管理员只能创建/赋予**等级低于自己**的身份组（即不能创建 admin/root） |
| PUT/DELETE | `/admin/users/:id` | 🔴 / 🔒 | 编辑（role/status/mora）/ **注销用户（逻辑删除，仅超级管理员）**。`status` 只接受 `0`(禁用) / `1`(启用)，**管理员不能设 `2`(注销)** |
| GET | `/admin/role-options` | 🔴 | **身份组下拉选项**：`{list:[{value,label,level,assignable}], myRole}`。`assignable` = 当前登录者能否赋予该身份（由后端下发，避免前端硬编码角色列表） |
| GET | `/admin/stocks` | 🔴 | 标的列表（含 `type` / `status` / `totalShares` / `nav`）。分页 `?page=&pageSize=&q=&type=&status=`，排序 `?sort=id\|code\|name\|price\|volume\|totalShares\|status\|updatedAt` + `?order=asc\|desc`；**默认按序号倒序（最新发行的在最前）**，非法值自动回退默认 |
| POST | `/admin/stocks` | 🔴 | 新增**角色股票** `{code,name,avatarUrl,price,totalShares}`（price 作为昨收/今开/现价基准） |
| POST | `/admin/stocks` | 🔴 | 新增**指数基金** `{code,name,avatarUrl,totalShares,type:'FUND',constituents:[{constituentId,weight}]}`。**必须带成分股**，服务端按当时加权净值自动定价（返回 `nav`），不接受手填价格 |
| PUT/DELETE | `/admin/stocks/:id` | 🔴 / 🔒 | 编辑（改价重置日基准、改流通份额）/ **删除标的（仅超级管理员）**。删除会连带清掉该标的的历史成交，故不收归管理员 |
| PUT | `/admin/stocks/:id` | 🟠 | **单标的状态**：`{status}` = 0 停牌 / 1 正常 / 2 退市。退市会自动撤销该标的全部未成交挂单并解冻资金（返回 `cancelledOrders`） |
| PUT | `/admin/stocks/:id` | 🔴🔒 | **修改代码**：`{code}`，仅超级管理员；服务端转大写并**查重**，重复返回 409 且不写库 |
| GET | `/admin/fund-rules` | 🟠 | 基金成分股数量限制 `{min,max,fundEnabled}`（新建基金时还没有基金 id，用它渲染提示） |
| GET/PUT | `/admin/funds/:id/constituents` | 🔴 | 查看 / 整体覆盖某基金成分股。PUT 保存后会**把基金价格立即对齐到新净值**并在 message 中给出 `价格前 → 后` |
| GET/POST | `/admin/news` | 🔴 | 新闻列表（**含待审与已驳回**，带 `reviewStatus`/`reviewNote`/`publisher`/`publisherRole`/`votes`）/ 管理员发布新闻（同 operator/news，直接生效） |
| PUT | `/admin/news/:id` | 🔴 | 编辑新闻（`{title,sourceUrl,direction,strength,stockIds,renew?}`）。**编辑不改变审核状态**：待审的新闻编辑后仍需审核；`renew` 仅对已通过的有效新闻可用 |
| PUT | `/admin/news/:id/review` | 🔴 | **审核新闻**：`{action:'approve'\|'reject', note?}`。通过 → 立即生效且有效期从此刻重新起算；驳回 → 永不生效（附理由）。非待审状态返回 400；发布开关关闭时不能通过（但可以驳回） |
| PUT | `/admin/news/:id/expire` | 🔴 | **立刻失效**（管理员的「准删除」）：把 `expires_at` 置为当前时间，记录与投票全部保留。不受发布开关影响 |
| DELETE | `/admin/news/:id` | 🔒 | **物理删除新闻（仅超级管理员）**，级联清理关联角色与投票 |
| GET/DELETE | `/admin/trades` / `/admin/trades/:id` | 🔴 / 🔒 | 查看全量成交 / **删除记录（仅超级管理员）**。成交记录是审计凭证，管理员只读、无替代动作 |
| GET | `/admin/logs` | 🔴 | 操作日志（分页），含 `ip` / `userAgent`（真实客户端 IP，经 `trust proxy` 解析 X-Forwarded-For） |
| GET | `/admin/pnl?days=3\|7\|14` | 🔴 | **用户盈亏报表**（仅超级管理员）。返回排行榜：`{rank,userId,nickname,mvBefore,cashBefore,mvAfter,cashAfter,profit,profitPct}` |
| GET | `/admin/perf?since=&points=` | 🔴🔒 | **系统性能快照**（仅超级管理员）。返回 `{config, stats, current, series}`；带 `since=<ts>` 只取增量样本（面板自动刷新用），否则返回降采样到 `points` 点的历史序列。**纯内存读取，不查数据库** |
| POST | `/admin/perf/refresh` | 🔴🔒 | **现场采样一次**再返回（"只看一眼"模式）。关闭持续监控后，只有这个接口会产生采样 |

### 盈亏报表：算法与性能

**不要历史快照**，用「当前状态 − 窗口内变动」反推期初：

```
期末资产 = Σ(当前持仓数量 × 当前价) + 可用摩拉 + 冻结摩拉
期初持仓 = 当前持仓数量 − 窗口内成交净买入量        ← 成交是持仓的唯一变动来源
期初现金 = 期末现金 − 窗口内成交净现金流 − 窗口内管理员手动调整额
盈亏     = 期末资产 − 期初资产
```

- 期初价格取「窗口起点之前最后一根 K 线的收盘价」；若历史不足则用该标的最早一根 K 线兜底
- 窗口内**新注册用户被排除**（没有期初资产，参与排名会失真），数量在 `excludedNewUsers` 返回
- 管理员手动发的摩拉从盈亏中扣除，不算作用户「赚到的」

**性能**（实测数据：100 用户 / 16 条成交 / 4.7 万行 K 线）：

| 项目 | 结果 |
|---|---|
| 固定查询数 | **6 条**，全部走索引（`trades.matched_at` 已建索引） |
| 单次耗时 | **8~15ms** |
| 聚合位置 | 数据库侧 `GROUP BY`，JS 只处理「用户数 × 涉及标的数」量级 |
| 后台开销 | **0** —— 只有管理员点击时才计算，无定时任务、无缓存表 |

**扩展性**：即使增长到 1 万用户 + 100 万条成交，主要成本也只是 `trades` 窗口聚合（走 `matched_at` 索引），
预计仍在百毫秒级。若未来数据量再大一个数量级，建议改为「每日收盘时给每个用户写一行资产快照」
（1 万用户 = 1 万行/天，很轻），届时导出变成纯读快照、更快也更精确。
| GET | `/admin/settings` | 🔴 | 全部系统配置，含 `type`(bool/number/text)、`group`、`label`、`min/max/step/maxLength`，root 控制面板据此渲染 |
| PUT | `/admin/settings` | 🔴 | 写入配置 `{key, value}`；按 type 校验（开关 0/1、数值 min~max、文本长度），修改后即时生效 |
| POST | `/admin/settings/nga-run` | 🔴 | 立刻抓取舆情。`{force:true}` 跳过最小间隔；**手动触发固定带 `--dump`**，跑完生成抓取快照。返回 `{pid, dump:true}`，成功 200 / 已有实例在跑 409 |
| GET | `/admin/settings/nga-dump` | 🔴 | 下载最新抓取快照。`?name=nga-dump-YYYYMMDD-HHMMSS.txt` 可指定，省略取 latest。返回 `text/plain` + `Content-Disposition: attachment`，无快照时 404（JSON 中文提示） |

### 系统配置项一览（root 控制面板）

| 分组 | key | 类型 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| 注册与账号 | `allow_registration` | bool | 0 | 是否允许自助注册 |
| 注册与账号 | `device_limit_enabled` | bool | 1 | 一设备一账号限制（关掉可放宽） |
| 注册与账号 | `allow_login` | bool | 1 | 维护模式：关闭后仅 root 可登录 |
| 交易控制 | `trading_enabled` | bool | 1 | 是否允许交易（下单/撤单/撮合） |
| 交易控制 | `cycle_minutes` | number | 10 | 撮合周期（分钟），K 线档位随之变化 |
| 交易控制 | `base_volatility` | number | 0.02 | 基础波动率 |
| 交易控制 | `max_change` | number | 0.1 | 单周期涨跌幅上限 |
| 新闻与投票 | `allow_news_publish` | bool | 1 | 是否允许发布/编辑/删除新闻 |
| 新闻与投票 | `allow_vote` | bool | 1 | 是否允许投票 |
| 新闻与投票 | `news_ttl_cycles` | number | 6 | 新闻有效周期数 |
| 市场情绪 | `nga_analysis_enabled` | bool | 0 | 市场情绪抓取总开关（当前平台 = NGA） |
| 市场情绪 | `nga_interval_minutes` | number | 180 | 真正分析一轮的最小间隔（分钟） |
| 市场情绪 | `nga_forum_fid` | text | 650 | 监测版面 fid，可逗号分隔多版面 |
| 市场情绪 | `nga_max_posts` | number | 30 | 单轮最多分析帖数 |
| 市场情绪 | `nga_fetch_content` / `nga_content_max_threads` / `nga_content_max_floors` | bool/number | 1 / 12 / 8 | 是否抓正文、最多抓几帖、每帖取几层（取回复不增加请求） |
| 市场情绪 | `nga_request_timeout` | number | 15 | NGA 请求超时（秒） |
| 市场情绪 | `gemini_api_key` / `nga_cookie` | text(secret) | — | 密钥类，下发时掩码 |
| 市场情绪 | `gemini_model` / `gemini_max_retries` / `gemini_timeout_seconds` | text/number | gemini-3.5-flash-lite / 2 / 30 | AI 模型与容错 |
| 市场情绪 | `nga_news_auto_publish` / `nga_news_max_stocks` | bool/number | 1 / 5 | 结论是否自动写入市场情绪、每条情绪关联几个角色 |
| 市场情绪 | `sentiment_before_review` | bool | 1 | 审核通过前是否即影响股价（关 = 与新闻同口径；已驳回永不生效） |
| 市场情绪 | `sentiment_weight` | number | 0.2 | 情绪定价因子权重 wS（0 = 只展示不影响股价） |
| 市场情绪 | `sentiment_decay_hours` | number | 72 | 一条情绪影响股价的时长（小时） |
| 交易控制 | `impact_linear_decay` | bool | 1 | **新闻/情绪影响的线性衰减**（推荐开）：窗口内从满强度线性降到 0，K 线是斜坡而不是固定斜率的直线台阶。关掉恢复老行为 |
| 市场情绪 · 运行状态 | `nga_health_*`（6 项） | text(只读) | — | 脚本每轮回写的运行状态，面板只读展示 |

> **线上当前值（2026-09-15 由站主手工调整，与上表默认值不同）**：
> `sentiment_before_review=1`、`sentiment_weight=0.08`、`sentiment_decay_hours=3`、`nga_news_max_stocks=5`、`nga_max_posts=50`、`impact_linear_decay=1`。
> 起因：情绪接入定价后实测「每轮固定 +0.32%、124 轮零成交」，K 线观感极差（详见 `docs/DATABASE.md` §3.4）。
> 权重降到 0.08 + 线性衰减后，单轮情绪脉冲实测降到 ±0.068% / ±0.064%。

### 抓取快照（手动立刻抓取专属）

点击后台「立刻抓取」时，脚本除照常写库外，还会把本轮全过程导出成**一个合并文件**（`nga-dump-latest.txt`），
格式对齐本地调试用的 `nga-dump-local/` 目录，只取其中的 1、3、6 号内容并跨节去重：

| 快照小节 | 对应 `nga-dump-local/` | 内容 |
| --- | --- | --- |
| 【一、NGA 抓取原文】 | `01-nga-原文.txt` | 抓到的标题 + 主楼 + 前几层回复 |
| 【二、总结论提示词】 | `03-prompt-总结论.txt` | 提交给 Gemini 的第 2 个提示词全文 |
| 【三、本轮汇总】 | `06-汇总结论.txt` | 本轮抓取数/过滤数/正文量/news_impact 条数/情绪编号/耗时 |

- 落盘位置：脚本同级的 `dumps/` 目录，同时写时间戳版 `nga-dump-<ts>.txt` 和覆盖版 `nga-dump-latest.txt`；
- 保留策略：只留最新 **10** 份，单文件上限 512KB，超限截断并标注；
- 去重规则：按块去重，再按行去重，仅对 ≥24 字符的长行生效，保留首次出现；
- **定时任务（cron `*/5`）不带 `--dump`**，避免每 5 分钟写一次文件；只有手动「立刻抓取」生成快照。
| 经济参数 | `start_mora` | number | 1000000 | 新用户初始摩拉 |
| 交易控制 | `order_rate_per_min` | number | 12 | 每人每分钟下单上限（0=不限），改完立即生效 |
| 交易控制 | `order_rate_per_hour` | number | 180 | 每人每小时下单上限（0=不限），与上一项同时生效 |
| 交易控制 | `min_hold_cycles` | number | 3 | **最少持有周期数**：买入后需持有满 N 个周期才能卖出（0=关闭）。只锁新买入的部分，详见 `PRICING.md` §12 |
| 排行榜 | `rank_enabled` | bool | 1 | 是否开放排行榜（关闭后前端显示"暂未开放"且不再计算） |
| 排行榜 | `rank_interval_minutes` | number | 10 | 排行榜更新频率（分钟） |
| 系统性能 | `perf_monitor_enabled` | bool | 1 | 是否持续采集性能数据（关闭后只在点「刷新」时采一次） |
| 系统性能 | `perf_sample_seconds` | number | 60 | 性能采样间隔（秒） |
| 系统性能 | `perf_keep_samples` | number | 1440 | 性能数据在内存里保留多少条（环形缓冲，旧的自动丢弃） |
| 数据维护 | `kline_retention_days` | number | 21 | 周期 K 线保留天数（0=不清理；日线永久保留） |
| 站点公告 | `announcement` | text | (空) | 全站公告横幅文本 |

## 7. 排行榜 rank（公开）
| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/rank?type=cash\|marketcap` | 🟢 | 资金榜 / 市值榜。返回 `{type, enabled, topN:50, intervalMinutes, updatedAt, participants, list:[{rank,nickname,value}]}`。**只返回昵称与金额，不返回用户 ID / 用户名** |
| PUT | `/user/rank-opt-in` | 🟢 | 是否参与排行榜 `{optIn}`（见 §3） |

**口径**：资金榜 = `mora + frozen_mora`；市值榜 = `Σ(持仓股数 × 现价)`（含已退市标的，按冻结价计）。只统计 `status=1` 且 `rank_opt_in=1` 的账号，各取前 50 名。
**明星例外**：`role='star'` 的账号**强制上榜**（条件为 `rank_opt_in = 1 OR role = 'star'`），因为明星本来就是公开身份。

**性能设计**：**绝不在请求里现算**。快照由周期任务（`cycleJob` 的 P3.5）按 `rank_interval_minutes` 顺带计算并缓存在内存，接口直接返回内存数据（实测单次计算 3ms / 100 用户量级；每个玩家再多次刷新也不碰数据库）。看门狗每 30 秒检查一次，所以管理员改完开关/频率最多 30 秒生效。用户切换参与开关时会异步重算一次，让他立刻看到自己上榜/下榜。

## 7.1 明星持仓 stars（公开）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/stars` | 公开 | 明星持仓公开列表（未登录可看）。返回 `{count, list:[{nickname, holdingCount, totalMarketValue, holdings:[...]}], updatedAt, cacheSeconds}`；每条持仓含 `stockId/code/name/avatarUrl/type/delisted/quantity/price/marketValue/weightPct` |

**公开边界（刻意为之，别顺手加回来）**：只公开 **标的 + 股数 + 市值 + 占总资产比例**。
**不公开**成本价/浮动盈亏/平仓盈亏（那等于公开每个人的买卖点与盈亏）、不公开现金余额与总资产金额、
不公开用户 ID 与用户名（与排行榜同一套隐私口径，只用昵称标识）。

**性能**：明星是极少数账号，一次查询即可算完；结果有 **60 秒内存缓存**，接口另叠一层按 IP 的限流。
`?refresh=1` 可强制重算（管理员排查用）。身份变更/注销明星时缓存会立即失效。

## 8. 系统性能监控 perf（仅超级管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/perf?since=&points=` | 系统性能快照（见 §6 表格） |
| POST | `/admin/perf/refresh` | 现场采样一次再返回 |

**采集内容**：CPU 使用率 / 核心数、负载均值 1/5/15m、内存（总量/已用/可用/%）、Swap、磁盘（总量/已用/剩余/%）、Node 进程 RSS/堆/运行时长、事件循环延迟 p50/p99、MySQL 连接数/运行中/QPS、HTTP 在飞请求与每分钟请求数、系统运行时长。

**开销（生产实测）**：

| 项目 | 实测值 |
|---|---|
| 单次采样耗时（纯采集，不含观测窗口） | **1.6 ~ 4.4 ms** |
| 手动刷新接口（现场采样一次） | **2.6 ~ 3.3 ms** |
| 增量读取（面板自动刷新用，约 3~12KB） | **1.6 ~ 2.1 ms** |
| 每小时 CPU 占用（60 秒采一次） | **约 0.02 秒**（可忽略） |
| 内存占用 | 每点约 0.3~0.5KB；默认 1440 点（24h@60s）≈ **0.5~0.8 MB** |
| 子进程 / 额外依赖 | **0**（不调 `df`/`free`/`top`） |
| 磁盘写入 | **0**（只存内存环形缓冲，天然"定期清除"） |

**实现要点**：
- 数据源全部是"读一下"级别：`os.cpus()`/`os.loadavg()`、`/proc/meminfo`、`fs.statfsSync('/')`、`process.memoryUsage()`、`perf_hooks.monitorEventLoopDelay`（**只在采样瞬间开 150ms 高精度窗口**：常驻 10ms 分辨率等于每秒 100 次唤醒，而常驻 1s 分辨率会让读数失真）、每点 1 条 `SHOW GLOBAL STATUS`。
- HTTP 并发由 `app.js` 的一个中间件计数（每请求自增+自减各一次）。
- **短窗口保护**：CPU% / HTTP 速率 / QPS 都是"两次采样之差"，窗口太短（<2 秒）会算出假的 0%/100% 或天文数字；此时沿用上次读数且不推进基准点，等窗口累积到有效为止。
- 看门狗每 30 秒检查一次设置，改完开关/间隔最多 30 秒生效。

## 9. 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 `{uptime, ts}` |

---

## 错误码速查

| code | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 参数校验失败 |
| `BAD_REQUEST` | 400 | 业务参数错误 |
| `UNAUTHORIZED` | 401 | 未登录 / token 过期 |
| `FORBIDDEN` | 403 | 角色无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 唯一约束冲突（用户名/代码重复等） |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 |
