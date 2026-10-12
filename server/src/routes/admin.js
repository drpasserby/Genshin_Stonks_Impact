import { Router } from 'express';
import { authRequired, requireRole } from '../middlewares/auth.js';
import {
  listUsers, createUser, updateUser, deleteUser, roleOptions,
  listStocks, listStockOptions, createStock, updateStock, deleteStock,
  listFundConstituents, updateFundConstituents, fundRules,
  listTrades, deleteTrade, listLogs,
  listSettings, updateSetting, pnlReport, getPerf, refreshPerf,
  runNgaAnalysis, ngaRunStatus, downloadNgaDump,
} from '../controllers/adminController.js';
import {
  publishNews, listNews, updateNews, deleteNews, reviewNews, expireNews,
} from '../controllers/publisherController.js';
import {
  listSentimentAdmin, reviewSentiment, deleteSentiment, sentimentPendingCount,
} from '../controllers/sentimentController.js';

const router = Router();
router.use(authRequired, requireRole('admin')); // root 自动放行

/**
 * ============ 删除类接口一律仅限超级管理员 ============
 * 管理员（admin）不能执行任何物理删除，只能用非破坏性替代动作：
 *   用户 → PUT /users/:id 改 status=0/1（禁用/启用）；不能注销
 *   新闻 → PUT /news/:id/expire（立刻失效）；不能删除
 *   标的 → PUT /stocks/:id 改 status=0/2（停牌/退市）；不能删除
 *   成交记录 → 无替代动作（不可变审计凭证）
 * 控制器内还有 assertCanDelete() 兜底，两处都在才算真正收紧。
 */

// 用户管理
router.get('/users', listUsers);
router.post('/users', createUser);
router.put('/users/:id', updateUser);
// 身份组下拉选项（由后端下发，避免前端硬编码角色列表）
router.get('/role-options', roleOptions);
router.delete('/users/:id', requireRole('root'), deleteUser); // 仅超级管理员可注销用户

// 角色股票 / 指数基金管理（列表分页：?page=&pageSize=&q=&type=&status=）
router.get('/stocks', listStocks);
// 下拉选项（成分股选择用；只返回 id/code/name/type/status/price）
router.get('/stocks-options', listStockOptions);
router.post('/stocks', createStock);
router.put('/stocks/:id', updateStock);
router.delete('/stocks/:id', requireRole('root'), deleteStock); // 仅超级管理员可删除标的

// 指数基金成分股（一期：仅角色可作为成分，不允许基金持有基金）
router.get('/funds/:id/constituents', listFundConstituents);
router.put('/funds/:id/constituents', updateFundConstituents);
// 新建基金时还没有基金 id，用这个拿成分股数量限制（min/max）
router.get('/fund-rules', fundRules);

// 新闻管理（管理员：发布/查看/编辑/审核/立刻失效；删除仅超级管理员）
router.get('/news', listNews);
router.post('/news', publishNews);
router.put('/news/:id', updateNews);
router.put('/news/:id/review', reviewNews);   // 审核：通过 / 驳回（管理员+超管）
router.put('/news/:id/expire', expireNews);   // 立刻失效（管理员的「准删除」，数据保留）
router.delete('/news/:id', requireRole('root'), deleteNews); // 仅超级管理员可删除新闻

// 市场情绪（社交平台情绪快照）：与新闻分开管理 —— 看队列 / 审核 / 删除
router.get('/sentiments', listSentimentAdmin);
router.get('/sentiments/pending-count', sentimentPendingCount);
router.put('/sentiments/:id/review', reviewSentiment);
router.delete('/sentiments/:id', requireRole('root'), deleteSentiment);

// 交易记录管理（删除仅超级管理员；管理员只读）
router.get('/trades', listTrades);
router.delete('/trades/:id', requireRole('root'), deleteTrade); // 仅超级管理员可删除成交记录

// 操作日志：仅超级管理员可见
router.get('/logs', requireRole('root'), listLogs);

// 盈亏报表（仅超级管理员）：GET /admin/pnl?days=3|7|14
router.get('/pnl', requireRole('root'), pnlReport);

// 系统开关（root 控制面板）：仅超级管理员可读写
router.get('/settings', requireRole('root'), listSettings);
router.put('/settings', requireRole('root'), updateSetting);
// NGA 舆情「立即抓取」：仅在服务器上拉起一次脚本（root 专属，避免误触发起外部请求）
router.post('/settings/nga-run', requireRole('root'), runNgaAnalysis);
router.get('/settings/nga-run', requireRole('root'), ngaRunStatus);
// 抓取快照下载（手动抓取时由脚本 --dump 生成）：GET /admin/settings/nga-dump[?name=...]
router.get('/settings/nga-dump', requireRole('root'), downloadNgaDump);

// 系统性能监控（root 控制面板）：GET 读内存快照；POST 现场采样一次（"只看一眼"模式）
router.get('/perf', requireRole('root'), getPerf);
router.post('/perf/refresh', requireRole('root'), refreshPerf);

export default router;
