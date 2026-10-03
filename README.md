# ⚜️ 提瓦特证券交易所（Teyvat Stock Exchange）

> 一个娱乐向的《原神》角色**模拟炒股**全栈应用：每位角色都是一只股票，用虚拟货币「摩拉」买卖交易、挂单撤单、看 K 线、读新闻，还能通过指数基金做「一篮子」配置。

适合：原神玩家 / 想体验「炒股」又不想亏真钱的人；以及想学习 **Vue3 + Node.js + MySQL** 全栈、周期批量撮合与 K 线图表实现的中文开发者。

## 预览图

![预览图](/public/1.jpg)
更多预览图请看 [docs/PREVIEW.md](docs/PREVIEW.MD)。

---

## ✨ 项目亮点

- **角色即股票**：钟离、雷电将军、胡桃…每位角色拥有独立行情（现价 / 昨收 / 今开 / 最高 / 最低 / 成交量 / 流通股本）。
- **10 分钟周期结算**：每 `cycle_minutes`（默认 10 分钟）批量撮合一次限价挂单并重算全市场股价，每日 15:00 生成日 K 并重置行情字段。
- **五因子定价引擎**：用户压力 + 新闻引用 + 倍率投票 + 市场情绪 + 基金传导，加权后乘基础波动率，单周期限幅 ±10%（详见 [docs/PRICING.md](docs/PRICING.md)）。
- **指数基金**：`stocks.type='FUND'`，按成分股加权净值 NAV 与溢价做**一阶滞后收敛**（数学上必然收敛、不发散），基金自身买卖压力再按权重**反向传导**给成分股；成分股数量限制 3~15 只。
- **完整交易闭环**：周期 K + 日 K 蜡烛图、自选股、委托盘口、市价 / 限价买卖、挂单冻结与撤单、持仓与浮动盈亏、成交记录、平仓盈亏。
- **新闻 + 投票 + AI 舆情**：操作员发布新闻引用（普通操作员需审核、高级操作员免审），看涨 / 看跌倍率投票；市场情绪由 `server/scripts/nga_analysis.py` 抓取 NGA 社区讨论、经 Gemini 总结后写入待审队列，作为**独立一档定价因子**。
- **排行榜与明星持仓**：已合并为单一**总资产榜**（前 50 名，只露昵称与金额）；明星（`star`）强制公开持仓并强制上榜，公开页任何人可访问。
- **7 个身份组**：`user` / `vip` / `star` / `operator` / `senior_operator` / `admin` / `root`，权限只增不减，**删除类操作仅超级管理员可做**。
- **原创羊皮纸主题 UI**：暖色调 + 仿羊皮纸 + 提瓦特元素，PC / 手机双端响应式（手机底部 Tab 导航）。
- **为 1G 内存小机器优化**：批量因子查询（4~6 条 SQL 覆盖全市场，替代 N+1）、单事务批量写价、周期 K 线自动清理、性能监控只读 `/proc`，PM2 单实例守护。

---

## 📦 技术栈

| 端 | 技术 |
| --- | --- |
| 前端 | Vue 3 + Vite + TypeScript · Element Plus · ECharts（蜡烛图）· Pinia · vue-router · axios |
| 后端 | Node.js ≥ 18 + Express · Sequelize ORM · MySQL 8（兼容 5.7 / MariaDB 10.x）· JWT · winston（每日轮转日志）· bcryptjs · express-validator |
| 部署 | Nginx（静态 + `/api` 反代）· PM2（fork 单实例）· Debian 12 |

> 为什么选 Node/Express 而非 FastAPI：与前端语言统一、单进程内存占用低（契合 1G 服务器）、PM2 生态成熟。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 🚀 快速开始（本地开发）

### 0. 准备

- Node.js ≥ 18、MySQL 8.0（或 5.7 / MariaDB 10.x，建表脚本保持兼容）
- 没有本地 MySQL？可用 Docker 一键起（端口 3306，库名 `teyvat_stock`，账号密码见 `docker-compose.dev.yml`，仅用于本地开发）：

```bash
docker compose -f docker-compose.dev.yml up -d
```

### 1. 初始化数据库

```bash
mysql -u root -p < server/sql/init.sql   # ⚠️ 含 DROP TABLE，仅全新库使用
```

### 2. 启动后端（端口 3000）

```bash
cd server
cp .env.example .env        # 修改数据库账号密码、JWT_SECRET、seed 口令
npm install
npm run db:init -- --force  # 可选：用模型再同步一次表结构
npm run seed                # 创建演示账号 + 6 只初始角色股票（幂等）
npm run dev                 # 开发模式（--watch 自动重启）
```

演示账号（**以下全部是代码里写死的默认口令，生产部署前必须改掉**，见 `server/.env` 的 `SEED_*_PASS`）：

| 账号 | 默认密码 | 身份组 | 说明 |
| --- | --- | --- | --- |
| `root` | `Root123!` | 超级管理员 | 唯一能删除数据、能进系统控制面板 |
| `admin` | `Admin123!` | 管理员 | 受限：管用户 / 标的 / 新闻审核，不能删除 |
| `operator` | `Op123456` | 操作员 | 发新闻（需审核）、倍率投票 |
| `demo` | `Demo123456` | 普通用户 | 注册即得 100 万摩拉 |

> 系统默认**关闭自助注册**（注册页保留，仅管理员可创建账号）、交易默认开放；
> `root` 登录后可在「管理后台 → 🛠️ 系统控制面板」切换注册、交易、投票等开关（配置存于数据库 `system_settings` 表）。

### 3. 启动前端（端口 5173）

```bash
cd web
npm install
npm run dev
```

> 💡 **Windows 一键脚本**：`start.bat` 同时拉起前后端并打开浏览器；`stop.bat` 按端口结束进程（不影响其它 node 程序）；`pack.bat` 生成含预构建前端的 `teyvat.tar.gz` 部署包。

打开 <http://127.0.0.1:5173>，用 `demo` 登录即可开始交易；想快速见效可把「撮合周期」在控制面板临时调成 1 分钟（或改 `server/.env` 的 `CYCLE_MINUTES=1`），再用 `operator` 发布一条「看涨」新闻观察引擎生效。

---

## 🖥️ 页面导览

| 页面 | 路由 | 说明 |
| --- | --- | --- |
| 登录 | `/login` | 登录；自助注册受开关控制（默认关闭） |
| 行情（首页） | `/` | 角色 / 基金列表：搜索、排序、隐藏平盘、自选星标；桌面表格 & 手机卡片 |
| 个股详情 | `/stock/:id` | 周期 K / 日 K、委托盘口、交易面板、相关新闻；基金额外显示净值 / 溢价与成分股卡片 |
| 新闻 | `/news` | 两个标签页：**新闻** / **市场情绪**；展示引用来源链接、投票与审核状态 |
| 排行榜 | `/rank` | 总资产榜（前 50 名，昵称 + 金额）；可自行开关是否参与 |
| 明星持仓 | `/stars` | 明星（`star`）持仓公开页，未登录也可浏览 |
| 我的 | `/me` | 总资产、持仓、委托单（可撤单）、成交记录 |
| 操作员面板 | `/operator` | 发布新闻、新闻倍率投票、股票看涨看跌投票、我的投票 |
| 管理后台 / 系统控制面板 | `/admin` | 用户管理 / 角色股票与基金 / 成交记录 / 新闻管理（含市场情绪审核）；二级 Tab 仅 root：📊 系统性能、开关与参数、操作日志、盈亏导出 |
| 关于 | `/about` | 快速上手、交易规则、常见问题、当前系统参数 |

---

## 📁 项目结构

```
├── server/                     # Node.js + Express + Sequelize
│   ├── src/
│   │   ├── config/             # env 配置 + MySQL 连接池
│   │   ├── constants/roles.js  # ★ 7 个身份组、等级与能力函数（权限唯一真源）
│   │   ├── models/             # 16 个 Sequelize 模型（对应 19 张表）
│   │   ├── middlewares/        # JWT 认证 + 身份守卫 + 限流 + 校验 + 错误处理
│   │   ├── services/           # engine(五因子定价) · tradingService(下单/冻结/撮合) · settingService · rankService · perfService
│   │   ├── jobs/cycleJob.js    # ★ 周期调度器：P1 撮合 → P5 维护
│   │   ├── controllers/        # admin/auth/news/publisher/rank/sentiment/star/stock/trade
│   │   ├── routes/             # REST API 路由（9 个文件）
│   │   ├── utils/              # winston 日志、JWT、金额精度、统一响应
│   │   ├── seed/seed.js        # 演示账号 + 初始角色股票（幂等）
│   │   └── scripts/initDb.js   # 建表 / 同步
│   ├── scripts/                # nga_analysis.py（NGA 抓取 + Gemini 总结）等
│   ├── sql/init.sql            # 19 张表建表 SQL（含索引与外键）
│   ├── sql/migrations/         # 增量迁移脚本（21 个，按日期命名）
│   ├── .env.example            # 环境变量模板
│   └── ecosystem.config.cjs    # PM2 配置（fork 单实例）
├── web/                        # Vue3 + Vite + TS
│   └── src/
│       ├── api/                # axios 封装 + 领域 API（admin/auth/news/...）
│       ├── components/         # KLineChart / TradePanel / StockAvatar / ChangeBadge / MarketSentimentPanel
│       ├── composables/        # useAdminPermissions（按身份组推导前端权限）
│       ├── stores/             # Pinia：user / system
│       ├── router/             # 路由 + 登录与身份守卫（root 自动放行）
│       ├── styles/theme.css    # 羊皮纸主题
│       └── views/              # 11 个页面 + admin/ 下 13 个子组件
│           └── admin/          # 9 个功能 Tab + dialogs/ 4 个弹窗
├── deploy/                     # nginx.conf.example / deploy.sh / mysql-lowmem.cnf.example 等
├── docs/                       # 架构、定价、权限、部署、接口、数据库、NGA、做空草案
├── start.bat / stop.bat / pack.bat   # Windows 一键启动 / 停止 / 打包
└── docker-compose.dev.yml      # 本地开发用 MySQL 8
```

---

## 🗄️ 数据库（19 张表）

| 分组 | 表 |
| --- | --- |
| 账号与设备 | `users`（7 种身份组 ENUM）· `device_registrations`（一设备一账号） |
| 系统配置 | `system_settings`（控制面板开关与参数） |
| 标的 | `stocks`（角色股 + 指数基金，`type` 区分）· `fund_constituents`（基金 ↔ 成分股 + 权重） |
| 交易 | `watchlists` · `orders`（委托单）· `trades`（成交，含印花税与平仓盈亏）· `holdings` · `holding_lots`（最少持有周期批次） |
| 内容与舆情 | `news` · `news_stocks` · `votes` · `market_sentiment` · `market_sentiment_stocks` · `news_impact` |
| 行情与运维 | `price_history`（周期 K + 日 K）· `operation_logs` · `nga_analysis_log` |

- 金额一律用 `DECIMAL`，避免浮点误差；`price_history` 以 `(stock_id, period, ts)` 唯一索引支撑 K 线查询，周期线按保留天数自动分批清理（日线永久保留）。
- 完整字段语义见 [docs/DATABASE.md](docs/DATABASE.md)，建表语句见 [`server/sql/init.sql`](server/sql/init.sql)。

---

## ⚙️ 核心机制

### 1️⃣ 周期结算（`server/src/jobs/cycleJob.js`）

每 `cycle_minutes` 分钟一轮，同一进程内串行执行：

| 阶段 | 做什么 |
| --- | --- |
| **P1 撮合** | 对每只正常（`status=1`）标的撮合可成交的限价挂单，成交价 = 撮合时当前价 |
| **P2 统计** | 统计 `(上一轮, 现在]` 窗口内所有成交的买入量与卖出量 |
| **P3 定价** | 先用因子模型算出全部角色股新价，再用新价算基金 NAV、最后算基金新价；批量写价 + 落周期 K 线 |
| **P3.5 排行榜** | 按 `rank_interval_minutes` 节流刷新总资产榜内存快照（玩家查看零数据库开销） |
| **P4 每日收盘** | 默认 15:00 生成日 K，并重置昨收 / 今开 / 最高 / 最低 / 成交量（幂等，重启不重复） |
| **P5 每日维护** | 04:00 后分批清理过期周期 K 线（日线永久保留） |

> ⚠️ 调度器**必须单实例运行**（PM2 不启用 cluster），否则会重复撮合、重复生成 K 线。

### 2️⃣ 五因子定价（`server/src/services/engine.js`）

角色股：

```
涨跌幅 = clamp( (wP×压力 + wN×新闻 + wV×投票 + wS×市场情绪 + wI×基金传导) × 基础波动率, ±单周期限幅 )
  压力     = clamp( 净买入 / 总股本 × 压力灵敏度 )
  新闻     = clamp( avg(方向 × 强度/100 × 投票倍率 × 衰减) )
  市场情绪 = clamp( avg(方向 × 强度/100 × 衰减) )
  基金传导 = clamp( Σ 关联基金压力 × 该角色在基金中的权重占比 )
```

默认权重 `wP=0.5 / wN=0.3 / wV=0.2 / wS=0.2 / wI=0.25`，基础波动率 `0.02`，限幅 `±10%`，均在控制面板可调。

指数基金**不套用**上式，而是向「净值 × (1+溢价)」收敛：

```
溢价   = clamp( 情绪 × 基金溢价系数, ±0.3 )
目标价 = 净值NAV × (1 + 溢价)
涨跌幅 = clamp( (目标价 / 当前价 − 1) × 跟踪速度, ±单周期限幅 )
```

误差每轮按 `(1 − 跟踪速度)` 衰减，数学上必然收敛。完整推导与参数表见 [docs/PRICING.md](docs/PRICING.md)。

### 3️⃣ 身份组与权限（`server/src/constants/roles.js`）

7 个身份组、等级 `0~4`（`vip` / `star` / `operator` 同级，只是增强方向不同），一句话概括：**权限只增不减地按身份组划分；删除类操作只有超级管理员能做**。

| 身份组 | 等级 | 专属能力 |
| --- | --- | --- |
| `user` 普通用户 | 0 | 基础交易 |
| `vip` 高级用户 | 1 | **免卖方印花税**（税率 0.5%） |
| `star` 明星 | 1 | **强制公开持仓 + 强制参与排行榜** |
| `operator` 操作员 | 1 | 发布新闻，但**需管理员审核**后才生效 |
| `senior_operator` 高级操作员 | 2 | 发布新闻**免审核、直接生效** |
| `admin` 管理员 | 3 | 审核新闻；**不能执行任何删除类操作**（用禁用 / 停牌 / 失效等非破坏性动作替代） |
| `root` 超级管理员 | 4 | 唯一可物理删除数据、可进系统控制面板 |

完整权限矩阵见 [docs/ROLES.md](docs/ROLES.md)。

### 4️⃣ 控制面板可调参数

`system_settings` 表按分组管理，root 可在面板在线调整（改完即时生效，多数无需重启）：**注册与账号**、**交易控制**（周期 / 基础波动率 / 限幅 / 最少持有周期 / 下单限流）、**新闻与投票**、**市场情绪**（NGA + Gemini 抓取参数与定价权重）、**市场情绪 · 运行状态**（只读）、**经济参数**、**指数基金**、**系统性能**、**数据维护**、**排行榜**、**站点公告**。

API Key 与 NGA Cookie 等敏感项在后端一律**掩码下发**，不会出现在接口响应或前端网络面板里。

---

## ☁️ 部署

生产环境为 **Debian 12** + Nginx + PM2（CentOS 已 EOL，不建议）。完整流程（系统选择、宝塔面板 / 纯命令行两条路线、低内存调优、上线检查清单与常见坑）见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

纯命令行快速路线：`pack.bat` 打包 → 上传解压 → `sudo bash deploy/deploy.sh 你的域名`（自动识别 Debian/Ubuntu 与 CentOS/RHEL）→ 导入 `server/sql/init.sql`（⚠️ 含 DROP，仅新库）→ `pm2 start ecosystem.config.cjs` → 参考 [`deploy/nginx.conf.example`](deploy/nginx.conf.example) 配置 Nginx。

> 服务器时区需设为 `Asia/Shanghai`（每日收盘生成日 K 依赖本地时区）；2G 以下内存建议本地构建前端后只上传 `dist`。

---

## 📚 文档索引

| 文档 | 讲什么 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构决策：为什么选 Node/Express、撮合模型、资金一致性、调度器设计 |
| [docs/PRICING.md](docs/PRICING.md) | 定价推导：一次结算的完整流程、五因子公式、基金与角色双向联动、全部可调参数与代码位置 |
| [docs/ROLES.md](docs/ROLES.md) | 权限矩阵：7 个身份组各自能做什么、哪些事谁都做不了、新增身份组要同步改哪些文件 |
| [docs/DATABASE.md](docs/DATABASE.md) | 数据库权威说明：19 张表各自职责、字段语义、索引与性能现状、迁移与备份恢复 |
| [docs/API.md](docs/API.md) | 接口文档：统一响应格式、各接口权限标记（🟢 登录 / 🟠 操作员 / 🔴 管理员 / 🔒 仅超管） |
| [docs/NGA_API.md](docs/NGA_API.md) | NGA 抓取口径：实际在用的接口、返回结构、踩过的坑（市场情绪模块的数据来源） |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署指南：Debian 12 选型、宝塔 / 命令行两条路线、低内存优化、上线检查清单 |
| [docs/SHORT_LEVERAGE.md](docs/SHORT_LEVERAGE.md) | **做空与杠杆的可行性评估与设计草案 —— 未实现的设计方案，代码一行未改**，不是现有功能 |
| [docs/backups/](docs/backups/) | 归档记录（非现行文档）：`DB_SYNC.md` 本地↔云端结构同步、`BUGFIX_LOG.md` 历史缺陷记录 |

---

## 🤝 贡献

欢迎提 Issue / PR。Roadmap（真实订单簿撮合、WebSocket 行情推送、测试覆盖等）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，待办清单见 `TODO.md`。

## 📝 License

[GPL-3.0](LICENSE) —— 本项目为学习 / 娱乐用途，**与原神、米哈游官方无任何关联**；角色图片版权归其所有者，请自行替换为合规头像资源。
