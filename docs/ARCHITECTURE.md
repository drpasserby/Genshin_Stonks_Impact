# 架构说明与技术决策

## 1. 为什么选 Node.js + Express + Sequelize（而非 FastAPI）

- **语言统一**：与 Vue3+TS 前端共用 JS/TS 心智模型，前端工程师可直接维护后端。
- **内存占用低**：Node 单进程基线 ~60-90MB，Express 无额外框架开销，契合 1G 内存服务器；PM2 单实例守护即可。
- **生态匹配**：Sequelize 对 MySQL 支持成熟；`winston`、`jsonwebtoken`、`bcryptjs` 均为久经验证的库。
- 代价说明：无静态类型（已用 JSDoc 注释补足）、CPU 密集计算不占优——本系统瓶颈在数据库 I/O 与定时撮合，Node 完全够用。

## 2. 撮合模型：交易所作对手方（简化但自洽）

真实交易所撮合需要买卖双方的订单簿深度匹配。为在单服务器、低并发下保持**规则简单、资金安全**，本系统采用：

- 存在一个“系统当前价”`stocks.price`，由估价引擎每周期更新。
- 用户买卖都面向“交易所”成交，**成交价恒等于撮合时刻的当前价**。
- 买价 ≥ 当前价 或 卖价 ≤ 当前价 → 整单成交；否则挂单等待下一个周期（每 10 分钟）。
- 盘口展示的是“挂单聚合视图”（真实存在的 PENDING 限价单），供决策参考，但不承担撮合职责。

这与你描述的撮合规则完全一致，且天然避免浮点/死锁/幽灵单等复杂问题。

## 3. 资金与持仓一致性（防超卖/超买）

- 下单（限价）即**冻结**：买单冻结 `限价×数量` 到 `users.frozen_mora`，卖单冻结股数到 `holdings.frozen_quantity`。
- 成交时以冻结额度清算，差额退回可用；撤单整额解冻。
- 所有资金/持仓变更在**数据库事务**内完成，锁行顺序固定（stock → user → holding），并开启 Sequelize 事务重试（防死锁）。
- 金额一律用 DECIMAL 存储，JS 侧以“分”为整数运算后写回，避免浮点误差累积。

## 4. 周期调度器（系统的心脏）

`src/jobs/cycleJob.js` 每 `CYCLE_MINUTES`（默认 10）分钟一轮：

```
P1 撮合  settleStock  可成交限价单以当前价成交（成交时间落在本轮窗口内）
P2 统计  (prevRunAt, now] 窗口内买卖量（含 P1 成交，防漏算/重算）
P3 估价  压力因子 + 新闻因子 + 投票因子 → 新股价（±maxChange 限幅），更新日行情并落 10m K 线
P4 收盘  本地时间 ≥ dailyCloseHour(默认15:00) 且当日未收盘 → 生成 1d K 线、重置日字段
```

- **窗口下界 = 上一轮任务结束时刻**：用时间戳边界而非计数累加，重启后自动衔接、不重不漏。
- **K 线 upsert**：同一 `(stock, period, ts)` 只保留一条，重复触发安全。
- **防重入**：`running` 标志；且文档要求 **PM2 单实例**（cluster 模式会重复撮合）。

### 估价公式

```
压力因子 = clamp( (净买入量 ÷ 流通股数) × PRESSURE_GAIN , -1, 1 )
新闻因子 = 该标的未过期新闻影响分(方向×强度/100×投票均倍率) 的平均，clamp
投票因子 = 标的级操作员投票 平均方向(±1) × 平均倍率(0.5~2.0)，clamp
基金传导 = clamp( Σ 关联基金压力 × 本标的在基金中的权重占比 )        ← 指数基金一期新增
涨跌幅   = clamp( (A×压力 + B×新闻 + C×投票 + I×基金传导) × 基础波动率 , ±MAX_CHANGE )
```

指数基金的定价**不同**：它向「成分股加权净值 NAV × (1+溢价)」按跟踪速度收敛，
详见 **`docs/PRICING.md`**（含完整公式推导、稳定性论证、参数表、代码索引与排查手册）。

无新闻/无投票时对应因子为 0（相应权重不生效），价格只随用户压力与配置波动——这在纯游戏环境是预期行为。


## 5. 目录结构

```
├── server/                 Node.js + Express + Sequelize
│   ├── src/
│   │   ├── config/         env 配置 + Sequelize 连接
│   │   ├── models/         11 张表模型 + 关联（index.js）
│   │   ├── middlewares/    auth(JWT+角色) / validate / errorHandler
│   │   ├── services/       tradingService(下单/撤单/撮合) engine(估价公式)
│   │   ├── jobs/           cycleJob(周期调度+日收盘)
│   │   ├── controllers/    7 个控制器（含序列化）
│   │   ├── routes/         auth/stocks/user/news/operator/admin
│   │   ├── utils/          logger(winston) jwt response errors money
│   │   ├── seed/           种子账号与角色股票
│   │   └── scripts/        initDb
│   ├── sql/init.sql        MySQL 8 全量表结构（含索引）
│   ├── .env.example
│   └── ecosystem.config.cjs  PM2 配置
├── web/                    Vue3 + Vite + TS + Element Plus + ECharts
│   └── src/
│       ├── api/            axios 封装 + 领域 API
│       ├── components/     KLineChart / TradePanel / StockAvatar / ChangeBadge
│       ├── stores/user.ts  Pinia
│       ├── router/         路由 + 登录/角色守卫
│       ├── styles/theme.css 羊皮纸主题
│       ├── utils/format.ts
│       └── views/          Login / Layout / Market / StockDetail / UserCenter / Operator / Admin
├── deploy/                 nginx.conf / deploy.sh / mysql 低内存调优
└── docs/                   API.md / 本文件
```

## 6. 可调参数（server/.env）

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `CYCLE_MINUTES` | 10 | 撮合/估价周期 |
| `DAILY_CLOSE_HOUR` | 15 | 每日收盘生成日K的时刻（本地时区） |
| `START_MORA` | 1000000 | 注册赠金 |
| `WEIGHT_PRESSURE/NEWS/VOTE` | 0.5/0.3/0.2 | 因子权重 A/B/C |
| `BASE_VOLATILITY` | 0.02 | 基础波动率 |
| `MAX_CHANGE` | 0.10 | 单周期涨跌幅限幅（±10%） |
| `PRESSURE_GAIN` | 200 | 压力因子灵敏度 |
| `NEWS_TTL_CYCLES` | 6 | 新闻生效周期数 |
| `VOTE_MULT_MIN/MAX` | 0.5/2.0 | 投票倍率范围 |

## 7. 已知边界与后续优化（Roadmap）

1. 真实订单簿撮合（买卖盘深度成交 + 盘口价差）→ 替换交易所对手方模型。
2. 第二阶段 UI 打磨：操作员/管理员页面已提供可用版本，可继续加图表/导出。
3. 前端实时推送：当前轮询 30s；可升级 WebSocket（行情订阅 + 成交推送）。
4. K 线历史清理策略：`price_history` 按 `ts` 定期归档（如保留 1 年 10m + 全部 1d）。
5. 单元测试：撮合/估价为纯逻辑，适合 vitest/ava 覆盖。
