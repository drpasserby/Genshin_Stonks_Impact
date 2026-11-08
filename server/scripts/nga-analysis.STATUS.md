# NGA 舆情分析 · 已部署状态与运维（2026-09-14 更新：配置已全部搬到控制面板）

## 一、当前状态：✅ 已上线，cron 每 5 分钟唤起，`/etc/nga-analysis/.env` 只剩数据库连接

| 项 | 值 |
|---|---|
| 服务器 | `__DOMAIN__`（Debian 12，MySQL 8.0.45，Python 3.11.2，Node 22） |
| 脚本 | `/opt/teyvat-nga/nga_analysis.py`（md5 `353b8d4ba060c19fab0476286aa5c9f1`，2026-09-14 22:5x 部署） |
| 接口文档 | **`docs/NGA_API.md`**（列表/正文两个 NGA 接口的请求、响应字段表、踩坑记录） |
| 虚拟环境 | `/opt/teyvat-nga/venv`（pymysql 2.2.8 + python-dotenv） |
| 配置来源 | **MySQL `system_settings`**（控制面板 →「市场情绪」），`.env` 只有 DB 连接 |
| crontab | `*/5 * * * * cd /opt/teyvat-nga && /opt/teyvat-nga/venv/bin/python /opt/teyvat-nga/nga_analysis.py >/dev/null 2>&1` |
| 实际频率 | 由面板「分析间隔」决定（默认 180 分钟）；cron 只是「每 5 分钟问一次」 |
| 面板入口 | https://__DOMAIN__ → 控制面板（root 账号）→「系统开关与参数」页 → 分组「市场情绪」 |
| 自测 | `_selftest_nga_analysis.py` **129 项断言全通过**（含键名一致性、楼层解析、gzip 解压回归） |
| 内存实测 | 真实负载峰值 34.8MB（上限 64MB） |

## 二、控制面板里能改的东西（不再需要碰服务器文件）

> 2026-09-14 更新：设置面板**按分组拆成左侧 TAB**（共 10 组，市场情绪组 24 项最重），
> 市场情绪组右上角新增 **「立即抓取」按钮**；「结论直接写入市场情绪」相关配置也在该组内。

**分组 TAB 一览**（左侧点选，数字是该组项数；顺序 = 后端 schema 顺序）

| 分组 | 项数 | 说明 |
|---|---|---|
| 👤 注册与账号 | 3 | 自助注册、设备限制、登录开关 |
| 📈 交易控制 | 7 | 撮合周期、波动率、限幅、持有周期、下单限流 |
| 📰 新闻与投票 | 3 | 新闻发布/投票开关、新闻有效期 |
| 📡 市场情绪 | 24 | 抓取开关/频率/版面/楼层、Gemini 密钥与模型、情绪写入、**定价开关与权重**、运行状态 |
| 💰 经济参数 | 1 | 新用户初始摩拉 |
| 🧺 指数基金 | 6 | 净值收敛、溢价、压力传导、成分股限制 |
| 📊 系统性能 | 3 | 采样开关/间隔/保留条数 |
| 🧹 数据维护 | 1 | 周期 K 线保留天数 |
| 🏆 排行榜 | 2 | 排行榜开关与刷新频率 |
| 📣 站点公告 | 1 | 全站横幅 |

> 「市场情绪 · 运行状态」的 6 个只读项**不单独占一个 TAB**，由前端并入「市场情绪」组，
> 所以 24 = 抓取/Gemini/写入 15 项 + 定价 3 项 + 运行状态 6 项。

### 2.1 「立即抓取」按钮

位置：设置面板 →「🛰️ 市场情绪」→ 标题右侧。

- 点一下 = 立刻在服务器上拉起一次分析脚本（**绕过「分析间隔」门控**），
  正常 3~20 秒跑完；按钮下方会实时显示本轮结果（成功/失败 + 统计）。
- 实现：`POST /api/admin/settings/nga-run`（仅 root）→
  `server/src/utils/ngaRun.js` 里 `spawn` 一个 Python 子进程。
  不做「写标记位等 cron」是因为那样最多要等 5 分钟，按钮体验等于没有。
- 约束：
  - **总开关关着时直接拒绝**（避免"我以为关了就不会抓"的预期被按钮打破）；
  - 同一时刻只允许一个进程（重复点返回 409「已有一次抓取正在运行」）；
  - 子进程带 180 秒超时兜底，超时强杀；
  - 结果由脚本照常回写 `nga_health_*`，面板轮询这几个字段。
- 排障：`GET /api/admin/settings/nga-run` 可看当前是否在跑、上次退出码与最后 8 行输出。

### 2.2 （旧方案，已废弃）结论自动发新闻

> 2026-09-14 起，总结论改为写入**市场情绪**（见下一节），不再往 `news` 表里塞。
> 这里只留档说明为什么当初用操作员账号，以及为什么后来不需要「展示账号」这个配置了。

旧实现：每轮生成一条覆盖所有角色的结论，以「新闻」形式发布（PENDING 待审），
作者是面板配置的账号（当时 = id 8 `bot_summary` / 昵称「NGA自动总结」/ 操作员）。
选操作员是因为系统对操作员的定义就是「发布内容 → 待管理员审核」，不会绕过审核。

废弃原因：总结论混进「提瓦特新闻」后与真实新闻难区分，且前台作者会显示成某个账号；
现在作者是纯文本「NGA 自动总结」，于是 `nga_news_publisher_id` 这个「展示账号」配置
**读了也没用**，已随 2026-09-14 的清理删除。

### 2.3 结论 →「市场情绪」（当前方案，不再混进新闻）

> 2026-09-14 改版：原来把总结论发成一条**新闻**，会和真实新闻混在一起，观感不对。
> 现在拆成独立模块「市场情绪」：**独立的表、独立的接口、独立的页面**。

每轮分析结束，脚本把结论归纳成**看涨 / 看跌两组**，各写一行到 `market_sentiment` 表：

| 字段 | 取值 |
|---|---|
| 平台 | `NGA`（`platform_name` = 「NGA 玩家社区」）；字段是 VARCHAR，以后接微博/B站不用改表 |
| 抓取时间 | 本轮分析时刻 |
| 标题 | AI 生成，约 20 字，统一带 `NGA情绪·` 前缀，如「NGA情绪·多位热门角色配队与泛用性获认可，市场关注度持续上升」 |
| 概况 | AI 生成的一句话总结（≤60 字） |
| 影响走向 | `UP` 看涨 / `DOWN` 看跌 —— **同一次监控有多空分歧时拆成两行** |
| 影响强度 | AI 按「论据强度」给 0~100（看涨看跌各自独立打分） |
| 关联角色 | 按影响值绝对值取前 N 个（默认 5，上限 10），各方向只挂自己那一侧的角色 |
| **作者** | **固定文本「NGA 自动总结」** —— 不是上传人，因此没有 user 关联、也不会出现在「我提交的新闻」 |
| 审核情况 | `PENDING` 待审 → 管理员通过后变 `APPROVED` 才对外显示；驳回则永不显示 |
| 来源链接 | `https://bbs.nga.cn/thread.php?fid=<版面>` |

**同一次监控不刷屏**：唯一键 `(platform, batch_date, batch_key, direction)`，
待审期间反复跑只更新那一行；一旦审核通过就定稿，不再被后续抓取覆盖。

**AI 提示词（已按本地分析格式重写）**：要求返回固定层级的 JSON——
`{tone, bull:{title,summary,strength}, bear:{...}}`，并且**某一方向没有依据时写 `null`**，
不许硬凑。实测某轮 66 条讨论全偏多时，就只产出 1 行看涨（没有生成假的看跌条目）。
AI 失败时用兜底文案（按多空条数拼标题），保证仍有东西可审。

对外文案**不含「舆情监控」字样**：接口路径是 `/api/sentiment`，
返回字段里也没有任何内部字段（批次/审核信息只在管理端接口里）。

**展示位置（2026-09-14 调整）**：合并进**新闻页**，页内顶部有一条板块切换栏
（📰 新闻 / 🌡️ 市场情绪），**不占版头导航入口**。
切换状态写进 `?tab=sentiment`，刷新与分享链接都能落到同一板块；
旧地址 `/sentiment` 会重定向到 `/news?tab=sentiment`。
市场情绪面板首屏不加载，切过去时才请求（`MarketSentimentPanel.vue`，被 news 包内联）。

### 2.4 全部配置项

**分组「市场情绪」**

| 配置项 | 键 | 默认 | 说明 |
|---|---|---|---|
| 启用市场情绪抓取（NGA） | `nga_analysis_enabled` | 0（已开启为 1） | 总开关。关闭时脚本只写「已跳过」，不抓 NGA、不调 Gemini |
| 分析间隔（分钟） | `nga_interval_minutes` | 180 | 真正跑一轮的最小间隔；改完下一轮生效 |
| 监测版面 fid | `nga_forum_fid` | 650 | 650=原神主板，835=剑斗绮谭；支持 `650,835` 多版面 |
| 单轮最多分析帖数 | `nga_max_posts` | 30 | 过滤后送 AI 的条数上限 |
| NGA 请求超时（秒） | `nga_request_timeout` | 15 | 到 NGA 网络慢时可上调 |
| 抓取帖子正文 | `nga_fetch_content` | 开 | 列表接口只给标题，正文（主楼+回复）要按 tid 逐帖另抓 |
| 最多抓几帖正文 | `nga_content_max_threads` | 12 | 每轮为前 N 条候选帖补正文；每帖一次请求约 0.3s |
| **每帖最多取几层** | `nga_content_max_floors` | 8 | 同一页 HTML 里本来就有主楼 + 约 19 层回复，**取回复不增加请求**，只增加送 AI 的字数（1 层≈1248 tokens / 8 层≈4259 / 20 层≈9383）；填 1 = 只分析主楼 |
| Gemini API Key | `gemini_api_key` | — | **密码框，保存后不回显**，只显示「已配置（长度 N）」 |
| Gemini 模型 | `gemini_model` | gemini-3.5-flash-lite | 2.5-flash-lite 已对新用户 404 |
| Gemini 重试次数 | `gemini_max_retries` | 2 | 每次间隔 5 秒 |
| Gemini 超时（秒） | `gemini_timeout_seconds` | 30 | |
| NGA Cookie | `nga_cookie` | 795 字符 | **密码框，保存后不回显**；过期时直接粘贴覆盖即可 |
| **结论自动写入市场情绪** | `nga_news_auto_publish` | 开 | 每轮把结论拆成看涨/看跌写入市场情绪（见 2.2） |
| **每条情绪关联角色数** | `nga_news_max_stocks` | 5 | 各方向按影响值绝对值取前 N 个 |

**同一分组内的「情绪 → 撮合定价」3 项**（2026-09-14 新增；原先误放在「新闻与投票」组，已归位）

| 配置项 | 键 | 默认 | 说明 |
|---|---|---|---|
| 审核通过前即影响股价 | `sentiment_before_review` | 开 | 开 = 待审情绪也参与定价（审核只拦「公开显示」）；关 = 必须审核通过才影响股价（与新闻同口径）。**已驳回的任何情况下都不生效** |
| 情绪权重（定价因子 wS） | `sentiment_weight` | 0.2 | 定价公式里的 wS。单周期影响 ≈ wS×情绪因子(-1~1)×基础波动率（0.2 满情绪≈±0.4%）；设 0 = 只展示不影响股价 |
| 情绪影响股价的时长 | `sentiment_decay_hours` | 72 | 从抓取时刻起算；超过就不再计入定价 |

> 已删除项（2026-09-14 清理）：
> `nga_news_publisher_id`（「市场情绪的展示账号」）—— 结论以前是按新闻发布的才需要指定账号，
> 现在作者是纯文本「NGA 自动总结」，脚本里读了之后从未使用，属于死配置；
> `NEWS_IMPACT_WEIGHT` / `NEWS_DECAY_FACTOR` / `NEWS_MIN_THRESHOLD` —— 早期「news_impact 直接接撮合」
> 方案的遗留键，方案未落地、面板上也看不见，已随迁移 `2026-09-14_prune_dead_settings.sql` 一并删除。

> 机器人账号：两个环境都是 **id 8 / `bot_summary` / 昵称「NGA自动总结」/ 身份组操作员 / 启用**。
> 它当初是为「结论以新闻形式发布」准备的；现在结论走「市场情绪」（作者是文本字段），
> **该账号已无业务用途**，保留只是避免动历史数据的发布者外键，可按需停用。

**分组「市场情绪 · 运行状态」**（只读，脚本每轮回写；出现「失败」会标红）

`nga_health_status`（最近一轮结果，带 `[NGA-SUCCESS]`/`[NGA-FAILED]`/`[NGA-DRYRUN]`/`[NGA-PARTIAL]` 前缀）、
`nga_health_last_run`、`nga_health_last_success`、`nga_health_cookie_ok_at`、
`nga_health_api_ok_at`、`nga_health_last_detail`。

## 三、每次运行会写什么日志

| 前缀 | 级别 | 含义 |
|---|---|---|
| `[NGA-SUCCESS]` | INFO | 整轮跑通：`版面=原神 fid=650 抓到=74 过滤=18 AI=10 校验=10 写入=10（耗时 2.6s）` |
| `[NGA-DRYRUN]` | INFO | `--dry-run` 跑通，未写库 |
| `[NGA-PARTIAL]` | WARN | 部分条目写库失败（详见同轮 ERROR） |
| `[NGA-FAILED]` | ERROR | 失败，消息里带阶段与原因（Cookie / 版面 / API / 解析） |
| `[COOKIE_EXPIRED]` | ERROR | 单独一条，便于按关键字告警；会指明去面板哪一栏更新 |
| 已跳过（未启用） | INFO | 总开关关着 |
| 未到分析间隔 | INFO | 距上轮不足「分析间隔」，本轮不跑 |

## 四、日常运维

```bash
# 看最近日志
mysql -uteyvat -p__DB_PASSWORD__ -h127.0.0.1 teyvat_stock -e \
  "SELECT id,level,message,created_at FROM nga_analysis_log ORDER BY id DESC LIMIT 20;"

# 只看成功/失败
mysql -uteyvat -p__DB_PASSWORD__ -h127.0.0.1 teyvat_stock -e \
  "SELECT created_at,message FROM nga_analysis_log WHERE message LIKE '[NGA-%' ORDER BY id DESC LIMIT 10;"

# 手动跑一轮（--force 无视间隔；--dry-run 不写库）
/opt/teyvat-nga/venv/bin/python /opt/teyvat-nga/nga_analysis.py --force
/opt/teyvat-nga/venv/bin/python /opt/teyvat-nga/nga_analysis.py --dry-run

# 看当前影响值
mysql -uteyvat -p__DB_PASSWORD__ -h127.0.0.1 teyvat_stock -e \
  "SELECT entity_type,entity_name,raw_impact,confidence,summary,analyzed_at FROM news_impact ORDER BY raw_impact DESC;"
```

**换 Cookie / 换 Key / 换版面 / 调频率：全部在控制面板改，改完不用重启任何东西。**

## 五、安全设计（为什么密钥放数据库也还行）

1. 后端 `listAllWithMeta()` 对 `secret: true` 的项**只下发掩码** `•••••••已配置（长度 N）`，
   明文只存在于 MySQL，不出后端接口。
2. 前端用密码框，草稿留空；若原样回传掩码，后端识别为「未修改」，不会把掩码写进库。
3. 审计日志 `ADMIN_UPDATE_SETTING` 对敏感项只记「已更新 长度 N」，不记明文。
4. 面板接口本身要求 `root` 身份（`requireRole('root')`）。
5. `system_settings` 现在包含凭据，**数据库备份文件按机密处理**；`.env`（600 root）只剩 DB 账号。

> 如果哪天想改回「密钥只放文件」，把 `_memprobe_nga.py` 同目录的迁移脚本反向跑一遍即可；
> 脚本读的是 `system_settings` 的键，改 `DEFAULTS` 的来源即可，业务逻辑不用动。

## 六、踩过的坑（都已修，留档避免重犯）

1. **键名大小写不一致**：脚本原来读 `NGA_ANALYSIS_ENABLED`（大写），面板/后端写 `nga_analysis_enabled`
   （小写）→ 表现是「面板改了但脚本读不到，全走默认值」。
   已统一为小写 snake_case，并加了回归断言：脚本 `DEFAULTS` 的每个键必须在后端 `SETTING_SCHEMA` 里。
2. **`system_settings.s_value` 只有 VARCHAR(500)**，而 NGA Cookie 795 字符 → 写入报
   `Data too long for column 's_value'`。迁移里已扩到 **VARCHAR(8192)**。
3. **接口形态**：帖子列表必须用 `GET thread.php?fid=..&__output=11`（不是 `POST forum.php`）。
4. **游客判定**：NGA 对游客返回 `{"denied":true,...}`（中文被 `\u` 转义），纯文本匹配抓不到。
5. `SafeLog` 包装层缺少 `removeHandler`，收尾时抛 AttributeError（已改走底层 logger）。
6. 前端构建产物要发到 `/www/wwwroot/teyvat-web`（nginx 的 root），不是仓库里的 `web/dist`。
7. **「抓回帖」从来没生效过（2026-09-14 实测发现）**：主楼是
   `<p id='postcontent0' class='postcontent ubbcode'>…</p>`，而**回复是 `<span …>…</span>`**；
   旧正则把结束标签写死成 `</p>`，于是一页明明有 20 层、只摘得出 1 层（主楼）。
   日志里的「正文=11/13帖」只说明「11 个帖子抓到了主楼」，与回帖无关。
   已改成「同标签名开闭配对」`<(p|span|div|td)…>(.*?)</\1>`，并加了 7 条回归断言
   （`_selftest_nga_analysis.py` 的「4b. 楼层解析」段）。
8. **市场情绪一整天只出一条**：批次键原来只按天（`batch_date + fid`），当天第一行被审核通过后，
   后续轮次既更新不到（UPDATE 限 `PENDING`）又插不进去（撞唯一键）→ 全天空跑。
   已改成「版面|HH:MM」的周期粒度 + 30 分钟更新窗口 + 定期清理过期待审。

## 六·补、「抓回帖」到底要花多少资源（2026-09-14 实测）

| 指标 | 只看标题 | 1 层 | 8 层（当前） | 20 层（整页） |
|---|---|---|---|---|
| HTTP 请求数 | 12 | 12 | **12** | 12 |
| 下载量（明文） | 0 | 419KB | **419KB** | 419KB |
| 下载量（gzip 后・当前） | 0 | ≈116KB | **≈116KB** | ≈116KB |
| 抓取耗时 | 0 | 3.55s | **3.55s** | 3.55s |
| 提示词 tokens | 607 | 1248 | 4259 | 9383 |
| Gemini 时延 | — | 2.48s | 2.83s | 约 +1s |
| 内存增量 | 0 | 0.8KB | 4.7KB | 12KB |

要点：**回帖与主楼在同一份 HTML 里**（第 1 页 = 主楼 + 约 19 层，明文约 35KB），
所以楼层数只影响「送进 AI 的字数」，不影响请求数/停留时间；
第 2 页（第 21 楼起）才需要额外一次请求（约 44KB / 0.27s / 16 层）。
进程峰值内存 34.8MB（上限 64MB），一轮总耗时约 9s（抓正文 3.5s + 两次 Gemini 各 2.5s），
而实际 180 分钟才跑一轮 → 平均开销可忽略。

**下载量在 2026-09-14 又降了 69%**：给两个接口加了 `Accept-Encoding: gzip, deflate`
（正文页 41.3KB → 12.8KB、列表 21.8KB → 约 6KB，`_open()` 自动解压）。
同一轮实测还确认了**不该改用 `read.php?...&__output=11` 的 JSON 版**去省字节：
它只省 65%，且 12 帖里有 2 帖被 CDN 截断。完整对比见 `docs/NGA_API.md` §3.1。
另注意：**抓取必须串行**，40 秒内打约 30 个请求会被 NGA 短暂限流（302 / 十几字节）。

详见 `docs/PRICING.md` 第 14 章与 `docs/NGA_API.md`。

## 七、仓库内文件

| 文件 | 用途 |
|---|---|
| `server/scripts/nga_analysis.py` | 主脚本（与服务器 md5 一致） |
| **`docs/NGA_API.md`** | **NGA 接口文档**：列表/正文两个接口的完整请求、响应字段表、试过但不能用的端点、抓取节奏与体积实测 |
| `server/scripts/_selftest_nga_analysis.py` | 离线自测 129 项（改代码后必跑） |
| `server/scripts/_memprobe_nga.py` | 内存上限探针 |
| `server/scripts/nga_panel_migrate.py` | 把 .env/cookies.json 的敏感值迁进 system_settings（一次性） |
| `server/sql/migrations/2026-09-12_nga_news_impact.sql` | 建 news_impact / nga_analysis_log |
| `server/sql/migrations/2026-09-13_nga_panel_settings.sql` | s_value 扩容 + 面板配置项 |
| `server/sql/migrations/2026-09-14_market_sentiment.sql` | 建 market_sentiment + 关联表 |
| `server/sql/migrations/2026-09-14_nga_conclusion_news.sql` | 结论自动发布相关配置 |
| `server/sql/migrations/2026-09-14_sentiment_pricing.sql` | 市场情绪接入定价的 3 个配置项 |
| `server/sql/migrations/2026-09-14_nga_floors.sql` | 「每帖最多取几层」配置项 |
| `server/sql/migrations/2026-09-14_prune_dead_settings.sql` | 清理 4 个已无用的配置项 |
| `server/scripts/nga-analysis.DEPLOY.txt` | 完整部署手册 |
| `server/scripts/nga-analysis.QUICKSTART.md` | 快速上手（交付给运维） |

> **接口细节另见 `docs/NGA_API.md`**（列表接口 `thread.php?fid=..&__output=11` 的 JSON 字段表、
> 正文接口 `read.php?tid=..` 的楼层 HTML 结构与正则、以及为什么不用 JSON 版）。

后端改动（已部署）：`server/src/services/settingService.js`（新增 16 个设置项 + 掩码/只读机制）、
`server/src/controllers/adminController.js`（掩码回传视为不修改、审计脱敏）、
`web/src/views/AdminPanelView.vue` + `web/src/api/admin.ts`（密码框、只读状态展示）。

## 八、后端撮合的接入情况（2026-09-14 更新）

- **市场情绪：已接入**（`engine.js` 的 `sentimentFactor`，权重 `sentiment_weight` 默认 0.2，
  审核前是否生效由 `sentiment_before_review` 决定）——见 `docs/PRICING.md` 第 14 章。
  端到端实测：伊涅芙 `622.5785 → 624.8198`（+0.36%，与 `wS×0.9×0.02` 吻合）。
- **`news_impact`（逐实体影响值）：仍未接入，且有计划地不接入**。
  它按「实体名」记录 AI 判断，与 `news` 表没有外键关系、也没有有效期与审核状态，
  直接当定价因子会让「没经审核的 AI 判断」绕过审核影响价格。
  一期用「市场情绪」承担这个职责（有审核状态、有失效时长、有失败降级），
  所以 `news_impact` 目前的定位是**留档与排查用的原始材料**，不参与定价。
  若将来要接入，需要先补齐：实体→标的外键、有效期字段、审核状态三件事。
