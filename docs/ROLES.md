# 身份组与权限（ROLES）

> 本文说明**系统里有哪些身份组、每个身份组能做什么、哪些事谁都做不了**，
> 以及**新增身份组时必须同步改哪些文件**。适用版本：2026-09-28（身份组扩展 + 新闻审核 + 删除权限收紧
> + 管理员后台拆分为子组件 + 排行榜合并为总资产榜）。
>
> 一句话总纲：**权限只增不减地按身份组划分；删除类操作只有超级管理员能做。**

---

## 1. 身份组一览

| 值（数据库） | 中文名 | 获取方式 | 一句话 |
|---|---|---|---|
| `user` | 普通用户 | 注册即得 | 基础交易权限（与最初版本一致） |
| `vip` | 高级用户 | 管理员赋予 | 权限同普通用户，但**免卖方印花税** |
| `star` | 明星 | 管理员赋予 | 权限同普通用户，但**强制公开持仓 + 强制参与排行榜** |
| `operator` | 操作员 | 管理员赋予 | 可发布新闻（**需审核**）与投票（与最初版本一致） |
| `senior_operator` | 高级操作员 | 管理员赋予 | 操作员全部权限 + 发布新闻**免审核、提交即生效** |
| `admin` | 管理员 | 仅超级管理员 | 管理账号/标的/新闻、审核新闻，但**不能删除任何数据** |
| `root` | 超级管理员 | 仅超级管理员 | 全部权限，**与最初版本完全一致**（不受删除限制） |

**单角色模型**：一个账号只有一个身份组，不能叠加（例如明星不同时是高级用户）。
`vip` / `star` / `operator` 在等级表里平级（都是「普通用户增强版」），只是增强方向不同。

---

## 2. 权限矩阵

| 能力 | user | vip | star | operator | senior_operator | admin | root |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 交易（买卖/挂单/撤单/持仓） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 免卖方印花税 | — | **✅** | — | — | — | — | — |
| 持仓公开（`/stars`） | — | — | **✅ 强制** | — | — | — | — |
| 参与排行榜 | 可选 | 可选 | **强制** | 可选 | 可选 | 可选 | 可选 |
| 进操作员面板（投票） | — | — | — | ✅ | ✅ | ✅ | ✅ |
| 发布新闻 | — | — | — | ✅ 待审 | ✅ 直接生效 | ✅ 直接生效 | ✅ 直接生效 |
| 审核新闻 | — | — | — | — | — | ✅ | ✅ |
| 审核市场情绪 | — | — | — | — | — | ✅ | ✅ |
| 进管理后台（用户/标的/新闻/成交） | — | — | — | — | — | ✅ | ✅ |
| 停牌 / 退市标的 | — | — | — | — | — | ✅ | ✅ |
| 禁用 / 启用账号 | — | — | — | — | — | ✅ | ✅ |
| 赋予身份组 | — | — | — | — | — | ✅ 仅低于自己的 | ✅ 任意 |
| 新闻「立刻失效」 | — | — | — | — | — | ✅ | ✅ |
| 重置他人密码 | — | — | — | — | — | — | ✅ |
| 进系统控制面板（全部系统配置） | — | — | — | — | — | — | ✅ |
| 操作日志 / 盈亏报表 | — | — | — | — | — | — | ✅ |
| 系统性能监控 | — | — | — | — | — | — | ✅ |
| NGA「立即抓取」/ 下载抓取快照 | — | — | — | — | — | — | ✅ |
| **物理删除**（注销账号 / 删新闻 / 删标的 / 删成交 / 删市场情绪） | — | — | — | — | — | **—** | ✅ |

### 等级表（`LEVEL`，`server/src/constants/roles.js`）

```
user(0) < vip(1) = star(1) = operator(1) < senior_operator(2) < admin(3) < root(4)
```

等级**只用于一条规则**：**不能操作等级 ≥ 自己的账号，也不能赋予等级 ≥ 自己的身份**。
于是管理员（3）能管理所有人（0/1/1/1/2）却动不了管理员与超管，也造不出管理员账号。
接口级权限与等级无关，一律由 `routes/*.js` 的 `requireRole(...)` 决定。

---

## 3. 删除类操作：管理员只能用「非破坏性替代动作」

需求原文：*「管理员无法执行删除操作，用户只能禁用，新闻只能立刻失效，股票只能停牌退市，成交记录无法物理删除，超级管理员的权限不变。」*

| 对象 | 管理员（admin）能做 | 管理员**不能**做 | 超级管理员（root） |
|---|---|---|---|
| 用户 | **禁用 / 启用**（`status` 0/1）、改昵称、补发摩拉 | 注销（`status=2`，逻辑删除）；改管理员/超管账号 | 注销（数据保留、可恢复）、重置密码 |
| 新闻 | 「**立刻失效**」（`expires_at = now`，记录与投票全保留） | 物理删除 | `DELETE /admin/news/:id` |
| 标的 | **停牌**（`status=0`）/ **退市**（`status=2`，自动撤挂单解冻） | 物理删除（会连带删掉该标的全部历史成交） | `DELETE /admin/stocks/:id` |
| 成交记录 | 只读 | 任何操作（连「失效」都没有） | `DELETE /admin/trades/:id` |

**双保险**：路由层 `requireRole('root')` + 控制器内 `assertCanDelete()`。
只改前端按钮是没用的（可以用 curl 绕过），所以两处都必须收紧。

> 成交记录为什么最严：它是**审计凭证**，同时还是定价引擎的压力因子数据源
> （`cycleJob` 的 P2 统计直接读 `trades`）。删掉它既破坏追溯，又会让当轮定价失真。

---

## 4. 新闻审核流程

原本操作员发布新闻是**立即生效**（提交即影响股价），没有任何复核环节。现在：

```
                    ┌──────────────── 高级操作员 / 管理员 / 超管 ──────────────┐
                    │                        直接发布                          │
                    └───────────────────────────┬───────────────────────────┘
                                                ▼
                                         APPROVED（已通过、生效）
普通操作员 ──发布──▶ PENDING（待审核）──审核通过──▶ 同上（有效期从通过时刻起算）
                              │
                              └──审核驳回──▶ REJECTED（永不生效，附理由，可追溯）
```

| 状态 | 进价格引擎 | 公开列表 / 详情 | 能被投票 | 说明 |
|---|:--:|:--:|:--:|---|
| `PENDING` 待审 | ❌ | ❌（详情返回 404） | ❌ | 等同草稿；有效期未开始计时 |
| `APPROVED` 已通过 | ✅ | ✅ | ✅ | **唯一生效状态** |
| `REJECTED` 已驳回 | ❌ | ❌ | ❌ | 保留记录供发布者查看驳回理由 |

三条容易踩的约定：

1. **`expires_at` 的计时起点是「审核通过时刻」**，不是发布时刻 —— 否则一条新闻在待审期间就把有效期耗光了；
   待审新闻的 `expires_at` 为 `NULL`，所以引擎查询必须显式按 `reviewStatus='APPROVED'` 过滤
   （只看时间会把待审新闻当成永久有效）。
2. **普通操作员看不到别人的待审新闻**：操作员本身也能交易，若能看到同事的待审新闻，
   等于把一份还没生效的利好/利空提前泄露，可以先建仓再等它生效。发布者本人可见自己的待审新闻。
3. **待审新闻不能被投票**：否则票会先攒在待审新闻上，审核一通过就带着满票生效。

### 与其它开关的关系

| 开关 | 影响 |
|---|---|
| `allow_news_publish`（控制面板） | 关闭后**发布/编辑/审核通过**都被拒；但**驳回、立刻失效、root 删除不受限制**（关掉开关更应该能清理违规新闻） |
| `allow_vote` | 关闭后所有投票暂停（含新闻与角色投票） |

---

## 5. 印花税例外（高级用户）

```
卖方到账 = 成交额 − 成交额 × STAMP_TAX_RATE(0.5%)     常规
卖方到账 = 成交额                                     高级用户（vip）：fee 记 0
```

- 判断点在 `services/tradingService.js` 的 `executeSell()`，用 `isStampTaxExempt(user.role)`；
  **市价卖单与限价卖单走同一入口**，所以两种委托都免。
- `trades.fee` 记为 `0`，`amount` 仍保持市场口径的成交额不变；
  平仓盈亏 = `amount − fee − cost`，因此高级用户的已实现盈亏天然按免税口径计算。
- 前端在委托面板与确认弹窗里显示「高级用户免卖方印花税」，判断依据是 `/auth/me` 返回的
  `stampTaxExempt`（**不在前端重复维护「哪个身份免税」的映射**）。

---

## 6. 明星的持仓公开

- 接口：`GET /api/stars`（公开，未登录可看），页面：`/stars`（从排行榜页可跳转）。
- **公开范围**：标的、股数、市值、占总资产比例。
- **不公开**：成本价 / 浮动盈亏 / 平仓盈亏、现金余额与总资产金额、用户 ID 与用户名。
- 明星同时**强制参与排行榜**（`rank_opt_in` 强制为 1，用户中心里开关被禁用，后端也会拒绝关闭请求）。
- 60 秒内存缓存 + 按 IP 限流；身份变更或注销明星时缓存立即失效。

---

## 7. 新增身份组时必须同步的地方（★ 漏一处就会静默失效）

| # | 文件 | 改什么 | 漏掉的后果 |
|---|---|---|---|
| 1 | `server/src/constants/roles.js` | `ROLES` / `VALID_ROLES` / `ROLE_LABELS` / `LEVEL` + 能力函数 | **最严重**：`LEVEL` 缺键 → `levelOf()` 返回 -1 → 越权判断静默失效 |
| 2 | `server/src/models/user.js` | `role` 的 `DataTypes.ENUM(...)` | 写入新角色报错 |
| 3 | `server/sql/init.sql` | `role ENUM(...)`（新建库） | 新库缺角色 |
| 4 | `server/sql/migrations/` | 新增一个幂等迁移 `ALTER TABLE users MODIFY role ENUM(...)` | **已有库无法写入新角色** |
| 5 | `web/src/types/index.ts` | `Role` 联合类型 | 编译期即报错（TS 会拦住你，这点最安全） |
| 6 | `web/src/utils/format.ts` | `roleLabel` / `roleTagType` / `roleHint` | 界面上直接显示英文原值（**静默降级，不会报错**） |
| 7 | `web/src/stores/user.ts` | `isOperator` / `isAdmin` / `canDelete` 等 getter | 菜单/按钮显隐错误 |
| 8 | `web/src/router/index.ts` | 相关路由的 `meta.roles` | 能进界面但接口 403（或反过来：接口通、入口没有） |
| 9 | `web/src/views/admin/dialogs/AdminUserDialog.vue` + `web/src/composables/useAdminPermissions.ts` | 角色下拉已改为**后端 `role-options` 驱动**，通常无需改；若新角色有特殊 UI 才动（这两个文件是 2026-09-20 从 `AdminPanelView.vue` 拆出来的） | — |
| 10 | `web/src/views/AboutView.vue` | 「身份组与权限」表格 | 玩家看不到新身份组的说明 |
| 11 | 本文与 `docs/API.md` | 矩阵与接口表 | 文档过期 |

**自检**：改完跑 `node src/scripts/test-roles.mjs`（58 项断言，覆盖上述大部分风险点），
再做一遍 `cd web && npx vue-tsc --noEmit`。

---

## 8. 代码位置索引

| 关注点 | 位置 |
|---|---|
| 身份组定义 / 等级 / 能力函数（唯一真源） | `server/src/constants/roles.js` |
| 路由级权限 | `server/src/routes/{admin,operator,user,news}.js`、`server/src/middlewares/auth.js`（`requireRole`，**root 自动放行**） |
| 权限矩阵注释 | `server/src/controllers/adminController.js` 顶部 |
| 角色赋予限制 / 注销保护 | `adminController.js` 的 `createUser` / `updateUser` / `deleteUser` |
| 删除守卫 | 同文件 `assertCanDelete()`；`publisherController.deleteNews()` |
| 新闻审核 | `server/src/controllers/publisherController.js`（`publishNews`/`listNews`/`reviewNews`/`expireNews`） |
| 新闻过滤（引擎/公开列表/投票） | `engine.js` 的 `loadFactorsBatch`、`newsController.js` 的 `listNews`/`newsDetail`/`voteNews` |
| 免印花税 | `services/tradingService.js` 的 `executeSell()` |
| 明星公开持仓 | `server/src/controllers/starController.js`、`routes/stars.js` |
| 明星强制上榜 | `services/rankService.js`（两处 SQL 的 `rank_opt_in = 1 OR role = 'star'`：总资产榜 + 参与人数） |
| 排行榜口径（总资产 = 可用 + 冻结 + 持仓市值） | `services/rankService.js` 的 `queryAssetsTop()` |
| 前端身份组展示 | `web/src/utils/format.ts`、`web/src/stores/user.ts` |
| 前端删除按钮收紧 | `web/src/views/admin/AdminUsersTab.vue` / `AdminNewsTab.vue` / `AdminSentimentTab.vue` / `AdminStocksTab.vue`（判断依据 `store.canDelete`） |
| 前端身份组赋权限制 | `web/src/composables/useAdminPermissions.ts`（`canManageUser` / `isAssignable`），后端同名规则在 `adminController.updateUser` |

---

## 9. 排查手册

**玩家说自己是高级用户但还在被收印花税？**
1. 查 `users.role` 是否真的是 `vip`（可能被管理员改回去了）；
2. 看 `trades.fee`：**本功能上线前的历史成交** `fee` 是真实收过的，不会回溯为 0；
3. 确认后端已重启（`executeSell` 的改动需要重启进程，PM2 不会热加载）。

**管理员看不到删除按钮，是 bug 吗？**
不是，是设计。管理员的替代动作见第 3 章；只有超级管理员能删。

**新闻发了但股价没动？**
1. `GET /api/operator/news` 看 `reviewStatus`：`PENDING` 说明还在待审（不影响股价是预期行为）；
2. 若是 `APPROVED`，看 `expiresAt` 是否已过期、`allow_news_publish` 是否被关；
3. 新闻强度与权重决定幅度：`涨跌幅 = (0.5×压力 + 0.3×新闻 + 0.2×投票 + wS×市场情绪 + 0.25×基金传导) × 0.02`，
   一条满强度新闻在上限里也只贡献约 0.6%/轮。（`wS` = 控制面板的 `sentiment_weight`，线上 0.08。）

**明星持仓页看不到某个明星？**
1. 该账号 `status` 是否被禁用/注销（只统计 `status=1`）；
2. 是否有持仓（无持仓的明星仍会出现，但持仓列表为空）；
3. 有 60 秒缓存，改完身份等一会儿或加 `?refresh=1`。

**调了市场情绪的参数（权重 / 衰减 / 自动通过审核）却毫无反应？**
先看控制面板「市场情绪 → 启用市场情绪抓取（NGA）」是不是开着的。**关掉它时，
`sentiment_weight`、`sentiment_decay_hours`、`sentiment_before_review`、`sentiment_auto_approve`
这四项全都是死配置**——没有新情绪写进来，调什么都不会进定价公式。
判定方法：`SELECT COUNT(*) FROM market_sentiment WHERE fetched_at > NOW() - INTERVAL 3 HOUR;`
返回 0 就说明当前没有任何情绪在影响股价（线上 2026-09-25 之后就一直是这样）。

**普通管理员为什么看不到「系统控制面板」这个 Tab？**
设计如此。控制面板（系统配置 / 操作日志 / 盈亏报表 / 性能监控 / NGA 抓取）全部 `requireRole('root')`，
admin 连 tab 都渲染不出来（`v-if="store.isRoot"`）。这与「删除只有 root 能做」是同一条总纲的延伸：
**能改系统行为或看到全站数据的能力，一律收在 root。**

---

## 10. 本地验证

```powershell
# 1) 建测试超管（只动这个专用账号，不影响你已有的账号）
cd server
node src/scripts/make-test-root.mjs      # roletest_root / Test123456

# 2) 跑权限矩阵回归（默认连 127.0.0.1:3000，可用 TEST_BASE 覆盖）
node src/scripts/test-roles.mjs
```

测试会幂等创建这些界面可用账号（密码统一 `Demo123456`）：
`userdemo` / `vipdemo` / `stardemo` / `opdemo` / `opdemo2` / `seniordemo` / `admindemo`。
测试期间会临时把 `min_hold_cycles` 关掉（结束后自动还原）。
