/**
 * 本地端到端测试：身份组与权限矩阵（回归测试，改动权限相关代码后请重跑）
 *
 * 用法（在 server/ 目录下、后端已运行）：
 *   node src/scripts/test-roles.mjs
 * 前置：先跑一次 node src/scripts/make-test-root.mjs 建测试超管。
 * 默认连 http://127.0.0.1:3000/api；后端跑在别的端口时用环境变量覆盖：
 *   $env:TEST_BASE='http://127.0.0.1:3100/api'; node src/scripts/test-roles.mjs
 *
 * 覆盖：7 个身份组定义、vip 免印花税、新闻审核全链路（待审/通过/驳回/不可投票/对外不可见）、
 *       管理端新闻列表字段、删除权限收紧（admin 403 + 替代动作 / root 放行）、
 *       明星强制公开持仓与强制参加排行榜、管理员越权尝试、普通与高级操作员的面板边界。
 *
 * 测试账号会幂等创建（*demo 系列），密码统一 Demo123456，方便你在界面里点着玩。
 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000/api';
const PWD = 'Demo123456';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail++; failures.push(name); console.log(`* FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
}
function section(t) { console.log(`\n===== ${t} =====`); }

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无 body */ }
  return { status: res.status, data };
}
const okCall = (r) => r.status === 200 && r.data?.code === 0;
const login = async (username, password = PWD) => {
  const r = await call('POST', '/auth/login', { body: { username, password } });
  return okCall(r) ? r.data.data.token : null;
};
const msgOf = (r) => r.data?.message || `HTTP ${r.status}`;

/** 幂等创建测试账号：已存在就直接用 */
async function ensureUser(rootToken, username, nickname, role) {
  const found = await call('GET', `/admin/users?q=${encodeURIComponent(username)}&pageSize=50`, { token: rootToken });
  const hit = (found.data?.data?.list || []).find((u) => u.username === username);
  if (hit) {
    if (hit.role !== role) {
      await call('PUT', `/admin/users/${hit.id}`, { token: rootToken, body: { role } });
    }
    return hit.id;
  }
  const created = await call('POST', '/admin/users', {
    token: rootToken,
    body: { username, password: PWD, nickname, role },
  });
  if (!okCall(created)) throw new Error(`创建 ${username} 失败: ${msgOf(created)}`);
  return created.data.data.id;
}

const rootToken = await login('roletest_root', 'Test123456');
if (!rootToken) {
  console.error('测试超管 roletest_root 登录失败：先在本目录执行 node src/scripts/make-test-root.mjs');
  process.exit(1);
}

/* 先备份会被测试改动的设置，结束时恢复 */
const settingsBefore = (await call('GET', '/admin/settings', { token: rootToken })).data.data;
const getSetting = (k) => settingsBefore.find((s) => s.key === k)?.value;
const origMinHold = getSetting('min_hold_cycles');
const origRankInterval = getSetting('rank_interval_minutes');
console.log(`原始设置：min_hold_cycles=${origMinHold} rank_interval_minutes=${origRankInterval}`);

async function restore() {
  await call('PUT', '/admin/settings', { token: rootToken, body: { key: 'min_hold_cycles', value: origMinHold } });
  await call('PUT', '/admin/settings', { token: rootToken, body: { key: 'rank_interval_minutes', value: origRankInterval } });
  console.log(`\n已恢复设置：min_hold_cycles=${origMinHold} rank_interval_minutes=${origRankInterval}`);
}
// 关掉 T+N 锁仓，否则测试里买完不能立刻卖
await call('PUT', '/admin/settings', { token: rootToken, body: { key: 'min_hold_cycles', value: '0' } });

/* ---------------- 准备账号 ---------------- */
section('准备测试账号（首次运行会创建，已存在则复用）');
const ids = {
  vip: await ensureUser(rootToken, 'vipdemo', '高级用户·演示', 'vip'),
  star: await ensureUser(rootToken, 'stardemo', '明星·演示', 'star'),
  senior: await ensureUser(rootToken, 'seniordemo', '高级操作员·演示', 'senior_operator'),
  oper: await ensureUser(rootToken, 'opdemo', '操作员·演示', 'operator'),
  oper2: await ensureUser(rootToken, 'opdemo2', '操作员·演示2', 'operator'),
  admin: await ensureUser(rootToken, 'admindemo', '管理员·演示', 'admin'),
  user: await ensureUser(rootToken, 'userdemo', '普通用户·演示', 'user'),
};
console.log('账号 id：', JSON.stringify(ids));

const tok = {
  vip: await login('vipdemo'),
  star: await login('stardemo'),
  senior: await login('seniordemo'),
  oper: await login('opdemo'),
  oper2: await login('opdemo2'),
  admin: await login('admindemo'),
  user: await login('userdemo'),
};
check('7 个测试账号都能登录', Object.values(tok).every(Boolean));

/* ---------------- 1. 身份组与中文名 ---------------- */
section('1. 身份组定义与下拉选项');
const roleOpts = await call('GET', '/admin/role-options', { token: rootToken });
const optList = roleOpts.data?.data?.list || [];
check('role-options 返回 7 个身份组', optList.length === 7, optList.map((o) => o.value).join(','));
check('中文名映射正确', ['普通用户', '高级用户', '明星', '操作员', '高级操作员', '管理员', '超级管理员']
  .every((l) => optList.some((o) => o.label === l)));

const adminRoleOpts = (await call('GET', '/admin/role-options', { token: tok.admin })).data?.data?.list || [];
const byVal = Object.fromEntries(adminRoleOpts.map((o) => [o.value, o]));
check('管理员可赋予 高级用户/明星/高级操作员', ['vip', 'star', 'senior_operator'].every((v) => byVal[v]?.assignable));
check('管理员不可赋予 管理员/超级管理员', !byVal.admin?.assignable && !byVal.root?.assignable);

const meVip = (await call('GET', '/auth/me', { token: tok.vip })).data?.data;
const meStar = (await call('GET', '/auth/me', { token: tok.star })).data?.data;
check('vip 的 roleLabel=高级用户 且 stampTaxExempt=true', meVip?.roleLabel === '高级用户' && meVip?.stampTaxExempt === true);
check('star 的 holdsPublic=true 且强制参与排行榜', meStar?.holdsPublic === true && meStar?.rankOptIn === true);

/* ---------------- 2. 高级用户免印花税 ---------------- */
section('2. 高级用户免印花税（vip）');
const stockRows = (await call('GET', '/stocks?type=STOCK')).data?.data || [];
const stock = stockRows.find((s) => Number(s.status) !== 2 && Number(s.price) > 0);
if (!stock) { console.error('本地没有可交易的标的，先跑一次结算或导入股票'); await restore(); process.exit(1); }
const stockId = Number(stock.id);
console.log(`  测试标的：${stock.code} ${stock.name} 现价 ${stock.price}`);

async function buyThenSell(token) {
  const buy = await call('POST', '/user/orders', { token, body: { stockId, side: 'BUY', type: 'MARKET', quantity: 1 } });
  if (!okCall(buy)) return { error: msgOf(buy) };
  const sell = await call('POST', '/user/orders', { token, body: { stockId, side: 'SELL', type: 'MARKET', quantity: 1 } });
  if (!okCall(sell)) return { error: msgOf(sell) };
  return { buy: buy.data.data.trade, sell: sell.data.data.trade };
}

const vipTrade = await buyThenSell(tok.vip);
const userTrade = await buyThenSell(tok.user);
check('vip 能正常买卖', !vipTrade.error, vipTrade.error || '');
check('普通用户能正常买卖', !userTrade.error, userTrade.error || '');
if (!vipTrade.error) check('vip 卖出印花税 = 0（免印花税）',
  Number(vipTrade.sell.fee) === 0 && Number(vipTrade.sell.netAmount) === Number(vipTrade.sell.amount),
  `fee=${vipTrade.sell.fee} 到账=${vipTrade.sell.netAmount}`);
if (!userTrade.error) check('普通用户卖出仍收印花税（0.5%）',
  Number(userTrade.sell.fee) > 0 && Number(userTrade.sell.netAmount) < Number(userTrade.sell.amount),
  `fee=${userTrade.sell.fee} 到账=${userTrade.sell.netAmount}`);

/* ---------------- 3. 新闻审核 ---------------- */
section('3. 新闻审核流程（普通操作员待审 / 高级操作员直接生效）');
const newsBody = (title) => ({
  title,
  sourceUrl: 'https://example.com/test',
  direction: 'UP',
  strength: 60,
  stockIds: [stockId],
});
const t0 = Date.now();
const newsOper = await call('POST', '/operator/news', { token: tok.oper, body: newsBody(`[测试] 普通操作员新闻 ${t0}`) });
check('普通操作员发布成功但状态为待审', okCall(newsOper) && newsOper.data.data.pending === true,
  okCall(newsOper) ? `reviewStatus=${newsOper.data.data.reviewStatus}` : msgOf(newsOper));
const pendingId = newsOper.data?.data?.id;

const newsSenior = await call('POST', '/operator/news', { token: tok.senior, body: newsBody(`[测试] 高级操作员新闻 ${t0}`) });
check('高级操作员发布即生效（免审核）', okCall(newsSenior) && newsSenior.data.data.pending === false,
  okCall(newsSenior) ? `reviewStatus=${newsSenior.data.data.reviewStatus}` : msgOf(newsSenior));
const approvedId = newsSenior.data?.data?.id;

const publicList = (await call('GET', '/news?pageSize=100')).data?.data?.list || [];
check('待审新闻不在公开列表里', !publicList.some((n) => n.id === pendingId));
check('高级操作员的新闻在公开列表里', publicList.some((n) => n.id === approvedId));
const detailPending = await call('GET', `/news/${pendingId}`);
check('待审新闻详情对外返回 404（不泄露）', detailPending.status === 404, msgOf(detailPending));

const votePending = await call('POST', `/operator/news/${pendingId}/vote`, {
  token: tok.senior, body: { direction: 'UP', multiplier: 1 },
});
check('待审新闻不能被投票', votePending.status === 403, msgOf(votePending));

const listAsOper2 = (await call('GET', '/operator/news', { token: tok.oper2 })).data?.data || [];
check('其他普通操作员看不到别人的待审新闻', !listAsOper2.some((n) => n.id === pendingId));
const listAsOper = (await call('GET', '/operator/news', { token: tok.oper })).data?.data || [];
check('发布者自己能看自己的待审新闻', listAsOper.some((n) => n.id === pendingId));

const reviewByAdmin = await call('PUT', `/admin/news/${pendingId}/review`, { token: tok.admin, body: { action: 'approve' } });
check('管理员审核通过', okCall(reviewByAdmin), msgOf(reviewByAdmin));
const publicList2 = (await call('GET', '/news?pageSize=100')).data?.data?.list || [];
check('通过后新闻进入公开列表（有效期从通过时刻起算）', publicList2.some((n) => n.id === pendingId));
const reviewAgain = await call('PUT', `/admin/news/${pendingId}/review`, { token: tok.admin, body: { action: 'approve' } });
check('重复审核被拒绝（不在待审状态）', reviewAgain.status === 400, msgOf(reviewAgain));

const newsOper2 = await call('POST', '/operator/news', { token: tok.oper, body: newsBody(`[测试] 待驳回新闻 ${t0}`) });
const rejectId = newsOper2.data?.data?.id;
const reject = await call('PUT', `/admin/news/${rejectId}/review`, {
  token: tok.admin, body: { action: 'reject', note: '来源不可靠' },
});
check('管理员驳回待审新闻', okCall(reject) && reject.data.data.reviewStatus === 'REJECTED', msgOf(reject));
const publicList3 = (await call('GET', '/news?pageSize=100')).data?.data?.list || [];
check('被驳回的新闻不公开', !publicList3.some((n) => n.id === rejectId));
const optOnlyAdmin = await call('GET', '/admin/news', { token: tok.oper });
check('普通操作员不能访问管理端新闻列表', optOnlyAdmin.status === 403, msgOf(optOnlyAdmin));

/* ---------------- 4. 管理端新闻列表字段（前端表格依赖） ---------------- */
section('4. 管理端新闻列表的字段完整性');
const adminNewsRows = (await call('GET', '/admin/news', { token: rootToken })).data?.data || [];
check('管理端能看到已驳回的新闻（公开接口看不到）',
  adminNewsRows.some((n) => n.id === rejectId && n.reviewStatus === 'REJECTED'));
const sampleRow = adminNewsRows.find((n) => n.id === pendingId) || adminNewsRows[0] || {};
check('每条新闻带 reviewStatus', sampleRow.reviewStatus !== undefined, String(sampleRow.reviewStatus));
check('每条新闻带投票聚合（up/down）',
  !!sampleRow.votes && typeof sampleRow.votes.up === 'number' && typeof sampleRow.votes.down === 'number',
  sampleRow.votes ? `up=${sampleRow.votes.up} down=${sampleRow.votes.down}` : '缺失');
check('每条新闻带发布者昵称与身份组',
  'publisher' in sampleRow && 'publisherRole' in sampleRow,
  `${sampleRow.publisher} / ${sampleRow.publisherRole}`);
check('每条新闻带 expired 与 expiresAt（前端据此显示生效状态）',
  'expired' in sampleRow && 'expiresAt' in sampleRow);
const operNewsRows = (await call('GET', '/operator/news', { token: tok.oper })).data?.data || [];
check('操作员端列表同样带审核字段', operNewsRows.every((n) => n.reviewStatus !== undefined));

/* ---------------- 5. 删除权限收紧 ---------------- */
section('5. 删除权限收紧（管理员不能删，超管可以）');
const tradeId = userTrade.sell?.id || vipTrade.sell?.id;
const delTradeAsAdmin = await call('DELETE', `/admin/trades/${tradeId}`, { token: tok.admin });
check('管理员删除成交记录被拒（403）', delTradeAsAdmin.status === 403, msgOf(delTradeAsAdmin));
const delNewsAsAdmin = await call('DELETE', `/admin/news/${approvedId}`, { token: tok.admin });
check('管理员删除新闻被拒（403）', delNewsAsAdmin.status === 403, msgOf(delNewsAsAdmin));

const tmpCode = `TDEL${String(Date.now()).slice(-6)}`;
const tmpStock = await call('POST', '/admin/stocks', {
  token: rootToken,
  body: { code: tmpCode, name: `删除测试-${tmpCode}`, type: 'STOCK', price: 100, totalShares: 80000 },
});
check('超管新建测试标的成功', okCall(tmpStock), msgOf(tmpStock));
const tmpStockId = tmpStock.data?.data?.id;
const delStockAsAdmin = await call('DELETE', `/admin/stocks/${tmpStockId}`, { token: tok.admin });
check('管理员删除标的被拒（403）', delStockAsAdmin.status === 403, msgOf(delStockAsAdmin));
const suspend = await call('PUT', `/admin/stocks/${tmpStockId}`, { token: tok.admin, body: { status: 0 } });
check('管理员可以停牌（替代删除的动作）', okCall(suspend), msgOf(suspend));
const delist = await call('PUT', `/admin/stocks/${tmpStockId}`, { token: tok.admin, body: { status: 2 } });
check('管理员可以退市', okCall(delist), msgOf(delist));
const delStockAsRoot = await call('DELETE', `/admin/stocks/${tmpStockId}`, { token: rootToken });
check('超管仍可删除标的（权限不变）', okCall(delStockAsRoot), msgOf(delStockAsRoot));

const expireByAdmin = await call('PUT', `/admin/news/${approvedId}/expire`, { token: tok.admin });
check('管理员可以「立刻失效」新闻', okCall(expireByAdmin), msgOf(expireByAdmin));
const adminNewsAfterExpire = (await call('GET', '/admin/news', { token: rootToken })).data?.data || [];
const expiredRow = adminNewsAfterExpire.find((n) => n.id === approvedId);
check('立刻失效已生效（管理端标记 expired=true）', expiredRow?.expired === true, `expiresAt=${expiredRow?.expiresAt}`);
const publicAfterExpire = (await call('GET', '/news?pageSize=100')).data?.data?.list || [];
const pubRow = publicAfterExpire.find((n) => n.id === approvedId);
check('公开列表里该新闻的过期时间 <= 现在（不再是有效新闻）',
  !pubRow || new Date(pubRow.expiresAt).getTime() <= Date.now(),
  pubRow ? `expiresAt=${pubRow.expiresAt}` : '已不在公开列表');

const newsForDelete = await call('POST', '/admin/news', { token: rootToken, body: newsBody(`[测试] 超管删除用 ${Date.now()}`) });
const delNewsReal = await call('DELETE', `/admin/news/${newsForDelete.data?.data?.id}`, { token: rootToken });
check('超管仍可物理删除新闻', okCall(delNewsReal), msgOf(delNewsReal));
const delTradeReal = await call('DELETE', `/admin/trades/${tradeId}`, { token: rootToken });
check('超管仍可物理删除成交记录', okCall(delTradeReal), msgOf(delTradeReal));

/* ---------------- 6. 管理员其他越权尝试 ---------------- */
section('6. 管理员其他越权尝试');
const createAdminByAdmin = await call('POST', '/admin/users', {
  token: tok.admin, body: { username: `badadmin${Date.now()}`, password: PWD, role: 'admin' },
});
check('管理员不能创建管理员账号', createAdminByAdmin.status === 403, msgOf(createAdminByAdmin));
const createVipByAdmin = await call('POST', '/admin/users', {
  token: tok.admin, body: { username: `vipbyadmin${String(Date.now()).slice(-6)}`, password: PWD, role: 'vip' },
});
check('管理员可以创建高级用户', okCall(createVipByAdmin), msgOf(createVipByAdmin));

const adminUserRows = (await call('GET', '/admin/users?pageSize=100', { token: tok.admin })).data?.data?.list || [];
check('管理员在用户列表里看不到超级管理员', !adminUserRows.some((u) => u.role === 'root'), `共 ${adminUserRows.length} 行`);
const rootUserRows = (await call('GET', '/admin/users?pageSize=100', { token: rootToken })).data?.data?.list || [];
check('超级管理员能看到全部账号（含 root 与 admin）',
  rootUserRows.some((u) => u.role === 'root') && rootUserRows.some((u) => u.role === 'admin'));

const updAdminByAdmin = await call('PUT', `/admin/users/${ids.admin}`, { token: tok.admin, body: { nickname: 'x' } });
check('管理员不能修改其他管理员账号', updAdminByAdmin.status === 403, msgOf(updAdminByAdmin));
const setDeleted = await call('PUT', `/admin/users/${ids.user}`, { token: tok.admin, body: { status: 2 } });
check('管理员不能把用户设为注销（只能禁用/启用）', setDeleted.status === 400, msgOf(setDeleted));
const disable = await call('PUT', `/admin/users/${ids.user}`, { token: tok.admin, body: { status: 0 } });
check('管理员可以禁用用户', okCall(disable), msgOf(disable));
await call('PUT', `/admin/users/${ids.user}`, { token: tok.admin, body: { status: 1 } });

const operToAdmin = await call('GET', '/admin/users', { token: tok.oper });
check('普通操作员无法访问管理端接口', operToAdmin.status === 403, msgOf(operToAdmin));
const seniorToAdmin = await call('GET', '/admin/users', { token: tok.senior });
check('高级操作员无法访问管理端接口', seniorToAdmin.status === 403, msgOf(seniorToAdmin));
const seniorCanOperatorPanel = await call('GET', '/operator/news', { token: tok.senior });
check('高级操作员可以访问操作员接口', okCall(seniorCanOperatorPanel), msgOf(seniorCanOperatorPanel));

/* ---------------- 7. 明星公开持仓 ---------------- */
section('7. 明星公开持仓（公开接口）');
await call('POST', '/user/orders', { token: tok.star, body: { stockId, side: 'BUY', type: 'MARKET', quantity: 3 } });
const stars = await call('GET', '/stars');
check('明星持仓接口无需登录即可访问', okCall(stars), msgOf(stars));
const starEntry = (stars.data?.data?.list || []).find((s) => s.nickname === '明星·演示');
check('明星出现在公开名单里', !!starEntry, starEntry ? `持仓 ${starEntry.holdingCount} 只` : '未找到');
if (starEntry) {
  const h = starEntry.holdings[0] || {};
  check('公开字段含 标的/股数/市值/占比',
    h.code !== undefined && h.quantity > 0 && h.marketValue > 0 && h.weightPct > 0,
    `${h.code} ${h.quantity}股 市值${h.marketValue} 占比${h.weightPct}%`);
  check('公开字段不含成本与盈亏', h.avgCost === undefined && h.profit === undefined && h.profitPct === undefined);
  check('公开字段不含现金余额/总资产', starEntry.cash === undefined && starEntry.totalAssets === undefined);
}
const starOptOut = await call('PUT', '/user/rank-opt-in', { token: tok.star, body: { optIn: false } });
check('明星无法关闭排行榜参与', starOptOut.status === 403, msgOf(starOptOut));
const userRankToggle = await call('PUT', '/user/rank-opt-in', { token: tok.user, body: { optIn: true } });
check('普通用户仍可自由开关排行榜', okCall(userRankToggle), msgOf(userRankToggle));

/* ---------------- 汇总 ---------------- */
await restore();
section('结果');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
