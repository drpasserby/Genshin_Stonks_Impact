import os from 'node:os';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import sequelize from '../config/db.js';
import logger from '../utils/logger.js';
import { getRuntime } from './settingService.js';

/**
 * ============ 系统性能采样（控制面板「系统性能」页） ============
 *
 * 设计目标：**开销小到可以忽略，且不引入任何新依赖/子进程**。
 *
 * 数据来源全部是「内存里读一下」级别的操作：
 *   · CPU 使用率 / 负载      : os.cpus() 的累计时间差 + os.loadavg()（纯系统调用）
 *   · 内存 / Swap           : 读 /proc/meminfo（约 1KB，Linux；其它平台回退 os.totalmem/freemem）
 *   · 磁盘                  : fs.statfsSync('/')（statfs 系统调用，**不用 spawn df**）
 *   · Node 进程自身          : process.memoryUsage() / process.cpuUsage()
 *   · 事件循环延迟           : perf_hooks.monitorEventLoopDelay（1 秒分辨率）
 *   · 数据库并发             : 每个采样点 1 条 SHOW GLOBAL STATUS（默认 60 秒才 1 条）
 *   · HTTP 并发              : app.js 里两个自增/自减计数器（每请求 2 次整数运算）
 *
 * 「日志」= 内存环形缓冲：只保留最近 N 条（默认 1440 条 ≈ 24 小时 @60s），
 * 新的进来就把最旧的挤掉 —— 天然"定期清除"，**不写数据库、不占磁盘、不需要清理定时任务**。
 * 代价是进程重启后历史清零（面板本来就是用来看"现在/最近"的，这个取舍是刻意的）。
 */

const isLinux = process.platform === 'linux';

/* ---------------- HTTP 并发计数（由 app.js 的中间件驱动） ---------------- */
const httpStat = { inFlight: 0, total: 0 };
export function noteRequestStart() {
  httpStat.inFlight++;
  httpStat.total++;
}
export function noteRequestEnd() {
  if (httpStat.inFlight > 0) httpStat.inFlight--;
}

/* ---------------- 事件循环延迟直方图 ----------------
 * 注意：直方图的分辨率决定读数精度 —— 若常驻开启 10ms 分辨率，等于每秒 100 次定时器唤醒；
 * 而分辨率设成 1000ms 时，所有正常延迟都会被归进 1 秒桶（读数直接失真）。
 * 折中做法：**只在采样的那一瞬间**打开一个 150ms 的高精度窗口，采完立刻关闭并重置。
 * 代价：每采样一次约 15 次定时器唤醒（默认 60 秒一次 → 0.25 次/秒），且读数真实。 */
const LOOP_WINDOW_MS = 150;
let loopHist = null;
try {
  loopHist = monitorEventLoopDelay({ resolution: 10 });
} catch {
  loopHist = null; // 老版本 Node 不支持就跳过，不影响其它指标
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 事件循环延迟（毫秒）：p50 / p99，反映"Node 有没有被卡住" */
async function readLoopLag() {
  if (!loopHist) return { loopLagP50: null, loopLagP99: null };
  try {
    loopHist.reset();
    loopHist.enable();
    await sleep(LOOP_WINDOW_MS);
    const p50 = loopHist.percentile(50) / 1e6;
    const p99 = loopHist.percentile(99) / 1e6;
    loopHist.disable();
    loopHist.reset();
    const r = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    return { loopLagP50: r(p50), loopLagP99: r(p99) };
  } catch {
    try { loopHist.disable(); } catch { /* ignore */ }
    return { loopLagP50: null, loopLagP99: null };
  }
}

/* ---------------- 采样状态 ---------------- */
const samples = [];        // 环形缓冲：{ ts, ...指标 }
const MAX_CAPACITY = 20160; // 硬上限（7 天 @60s），防止有人把设置调到离谱的值
let prevCpu = null;        // 上次的 { idle, total }（算 CPU% 必须要有上一次）
let prevQueries = null;    // 上次的 MySQL Queries 累计值（算 QPS）
let prevAt = 0;
let prevTotalReq = 0;
let lastSampleMs = 0;      // 单次采样耗时（用于自证开销）
let lastCpuPct = null;     // 上次有效的 CPU 读数（短窗口时沿用）
let lastHttpPerMin = null;
let lastDbQps = null;
let lastLag = { loopLagP50: null, loopLagP99: null };
let lastLagAt = 0;
let timer = null;
let timerSeconds = null;
let lastDriftMs = 0;       // 采样相对计划时间的偏差（间接反映事件循环被阻塞的程度）

/** 环形容量：来自控制面板设置（保留条数） */
function capacity() {
  const rt = getRuntime();
  const n = Math.floor(Number(rt.perfKeepSamples) || 1440);
  return Math.max(60, Math.min(MAX_CAPACITY, n));
}

function pushSample(s) {
  samples.push(s);
  const cap = capacity();
  if (samples.length > cap) samples.splice(0, samples.length - cap);
}

/* ---------------- 单项采集 ---------------- */

/** CPU 总体使用率（%）：两次采样之间 non-idle 的比例
 *
 * ⚠️ 关键细节：CPU% 是「两次读数之差」，窗口太短时差值只有几十毫秒，
 * 噪声会把结果拉到 0% 或 100%（实测踩过：紧接着手动刷新再定时采样，就出现假的 100% 尖峰）。
 * 因此设一个**最小有效窗口**（累计 CPU 时间 ≥ 1000ms，2 核约等于 0.5 秒墙钟）：
 * 窗口不够时沿用上次读数，并且**不推进基准点**，让窗口继续累积到有效为止。
 */
const MIN_CPU_WINDOW_MS = 1000;

function readCpuPct() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += (t.idle || 0);
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  if (!prevCpu) {
    prevCpu = { idle, total };
    return null;
  }
  const dIdle = idle - prevCpu.idle;
  const dTotal = total - prevCpu.total;
  if (dTotal < MIN_CPU_WINDOW_MS) return lastCpuPct; // 窗口太短：沿用上次，基准不动
  prevCpu = { idle, total };
  const pct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  lastCpuPct = Math.round(pct * 10) / 10;
  return pct;
}

/** 短窗口保护：间隔不足 2 秒时不计算"每分钟/每秒"速率（否则除出天文数字） */
const MIN_RATE_WINDOW_MS = 2000;

/** 内存 / Swap：优先读 /proc/meminfo（口径与 free 一致），其它平台回退 */
function readMemory() {
  const out = {
    memTotalMb: 0, memUsedMb: 0, memUsedPct: 0, memAvailMb: 0,
    swapTotalMb: 0, swapUsedMb: 0, swapUsedPct: 0,
  };
  const kb = (kbVal) => Math.round((kbVal / 1024) * 10) / 10;
  if (isLinux) {
    try {
      const txt = fs.readFileSync('/proc/meminfo', 'utf8');
      const get = (k) => {
        const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
        return m ? Number(m[1]) : 0;
      };
      const total = get('MemTotal');
      const avail = get('MemAvailable') || get('MemFree');
      const st = get('SwapTotal');
      const sf = get('SwapFree');
      out.memTotalMb = kb(total);
      out.memAvailMb = kb(avail);
      out.memUsedMb = Math.round((kb(total) - kb(avail)) * 10) / 10;
      out.memUsedPct = total ? Math.round(((total - avail) / total) * 1000) / 10 : 0;
      out.swapTotalMb = kb(st);
      out.swapUsedMb = kb(st - sf);
      out.swapUsedPct = st ? Math.round(((st - sf) / st) * 1000) / 10 : 0;
      return out;
    } catch { /* 落到下面的兜底 */ }
  }
  const total = os.totalmem();
  const free = os.freemem();
  out.memTotalMb = kb(total / 1024);
  out.memAvailMb = kb(free / 1024);
  out.memUsedMb = Math.round((kb(total / 1024) - kb(free / 1024)) * 10) / 10;
  out.memUsedPct = total ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  return out;
}

/** 磁盘：statfs 系统调用，不 spawn df */
function readDisk() {
  const out = { diskTotalGb: 0, diskUsedGb: 0, diskFreeGb: 0, diskUsedPct: 0, diskPath: isLinux ? '/' : 'C:\\' };
  try {
    const st = fs.statfsSync(out.diskPath);
    const bsize = Number(st.bsize) || 4096;
    const total = Number(st.blocks) * bsize;
    const free = Number(st.bavail) * bsize;   // bavail = 非特权用户可用（与 df 口径接近）
    const gb = (b) => Math.round((b / 1024 / 1024 / 1024) * 10) / 10;
    out.diskTotalGb = gb(total);
    out.diskFreeGb = gb(free);
    out.diskUsedGb = Math.round((gb(total) - gb(free)) * 10) / 10;
    out.diskUsedPct = total ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  } catch { /* 不支持就留 0 */ }
  return out;
}

/** Node 进程自身占用 */
function readProcess() {
  const mu = process.memoryUsage();
  return {
    nodeRssMb: Math.round((mu.rss / 1024 / 1024) * 10) / 10,
    nodeHeapMb: Math.round((mu.heapUsed / 1024 / 1024) * 10) / 10,
    procUptimeSec: Math.round(process.uptime()),
  };
}

/** MySQL 并发与 QPS：每个采样点 1 条极小查询 */
async function readDb(gapMs) {
  const out = { dbThreadsConnected: null, dbThreadsRunning: null, dbQps: null, dbAlive: false };
  try {
    const [rows] = await sequelize.query(
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Queries')"
    );
    const map = {};
    for (const r of rows) map[r.Variable_name] = Number(r.Value);
    out.dbThreadsConnected = map.Threads_connected ?? null;
    out.dbThreadsRunning = map.Threads_running ?? null;
    out.dbAlive = true;
    if (prevQueries != null && gapMs >= MIN_RATE_WINDOW_MS && map.Queries != null) {
      out.dbQps = Math.round(((map.Queries - prevQueries) / (gapMs / 1000)) * 10) / 10;
      lastDbQps = out.dbQps;
    } else {
      out.dbQps = lastDbQps; // 窗口太短：沿用上次，避免除出天文数字
    }
    // 基准点只在有效窗口（或首次）时推进，否则让窗口继续累积
    if (map.Queries != null && (gapMs >= MIN_RATE_WINDOW_MS || prevQueries == null)) {
      prevQueries = map.Queries;
    }
  } catch { /* 数据库不通时不让采样整体失败 */ }
  return out;
}

/* ---------------- 采样主函数 ---------------- */

/**
 * 采一次样并压入环形缓冲。
 * @param {string} reason 'timer' | 'manual'（手动刷新时就算"只刷新模式"也采）
 */
export async function sampleOnce(reason = 'timer') {
  const t0 = process.hrtime.bigint();
  const now = Date.now();
  const gapMs = prevAt ? now - prevAt : 0;

  const cpuPct = readCpuPct();
  const mem = readMemory();
  const disk = readDisk();
  const proc = readProcess();
  // 事件循环延迟需要一段观测窗口（150ms）。为了不拖慢「手动刷新」的响应，
  // 只有定时采样、或上次测量已超过 5 分钟时才重新测量；否则沿用上次读数。
  let lag = { loopLagP50: lastLag.loopLagP50, loopLagP99: lastLag.loopLagP99 };
  let lagWaitMs = 0;
  if (reason === 'timer' || Date.now() - lastLagAt > 5 * 60 * 1000) {
    const l0 = Date.now();
    lag = await readLoopLag();
    lagWaitMs = Date.now() - l0;
    lastLag = lag;
    lastLagAt = Date.now();
  }
  const db = await readDb(gapMs);

  const load = os.loadavg();
  // HTTP 速率同样要防短窗口：窗口太短时沿用上次读数，且不推进基准
  let httpPerMin = lastHttpPerMin;
  if (gapMs >= MIN_RATE_WINDOW_MS) {
    const totalReq = httpStat.total;
    httpPerMin = Math.round(((totalReq - prevTotalReq) / (gapMs / 60000)) * 10) / 10;
    prevTotalReq = totalReq;
    lastHttpPerMin = httpPerMin;
  } else if (!prevAt) {
    prevTotalReq = httpStat.total;
  }

  const s = {
    ts: now,
    reason,
    cpuPct: cpuPct == null ? null : Math.round(cpuPct * 10) / 10,
    cpuCount: (os.cpus() || []).length,
    load1: Math.round(load[0] * 100) / 100,
    load5: Math.round(load[1] * 100) / 100,
    load15: Math.round(load[2] * 100) / 100,
    ...mem, ...disk, ...proc, ...lag, ...db,
    httpInFlight: httpStat.inFlight,
    httpPerMin,
    uptimeSec: Math.round(os.uptime()),
  };

  pushSample(s);
  prevAt = now;
  // 纯采集耗时（剔除事件循环延迟的观测窗口 —— 那是"等待"，不是 CPU 开销）
  lastSampleMs = Math.max(0, Number(process.hrtime.bigint() - t0) / 1e6 - lagWaitMs);
  return s;
}

/** 采样器：按 perf_sample_seconds 定时采样；间隔变了自动重建 */
function schedule() {
  const rt = getRuntime();
  const sec = Math.max(5, Math.round(Number(rt.perfSampleSeconds) || 60));
  if (timer && timerSeconds === sec) return;
  if (timer) clearInterval(timer);
  timerSeconds = sec;
  const planned = sec * 1000;
  timer = setInterval(() => {
    const expect = timer.lastAt ? timer.lastAt + planned : 0;
    timer.lastAt = Date.now();
    if (expect) lastDriftMs = Math.max(0, timer.lastAt - expect);
    if (!getRuntime().perfMonitorEnabled) return; // 关掉采样时只留一个空转定时器（几乎零开销）
    sampleOnce('timer').catch((e) => logger.warn('[性能] 采样失败: ' + e.message));
  }, planned);
  timer.lastAt = Date.now();
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`[性能] 采样间隔 = ${sec} 秒，内存保留 ${capacity()} 条`);
}

/** 启动性能监控：先立刻采一次（让面板一打开就有数），再按间隔持续采样 */
export async function startPerfMonitor() {
  if (timer) return;
  // 首次采样前先做一次极短的"预热差"：让 CPU% 第一次就有值
  await sampleOnce('boot').catch(() => {});
  setTimeout(() => { sampleOnce('boot').catch(() => {}); }, 1000).unref?.();
  schedule();
  // 看门狗：管理员在控制面板改了开关/间隔后自动生效（30 秒内）
  const wd = setInterval(() => schedule(), 30 * 1000);
  if (typeof wd.unref === 'function') wd.unref();
}

export function stopPerfMonitor() {
  if (timer) { clearInterval(timer); timer = null; timerSeconds = null; }
}

/* ---------------- 查询接口（供控制器用） ---------------- */

/** 均匀降采样到最多 points 个点（用于一次性拉较长窗口） */
function downsample(list, points) {
  if (points <= 0 || list.length <= points) return list.slice();
  const step = list.length / points;
  const out = [];
  for (let i = 0; i < points; i++) out.push(list[Math.min(list.length - 1, Math.floor(i * step))]);
  return out;
}

/**
 * 取性能数据。
 * @param {object} opt { since?:number 只取该时间戳之后的样本, points?:number 降采样点数 }
 */
export function getPerfData({ since = 0, points = 240 } = {}) {
  const rt = getRuntime();
  const recent = since > 0 ? samples.filter((s) => s.ts > since) : downsample(samples, points);
  return {
    config: {
      enabled: !!rt.perfMonitorEnabled,
      intervalSeconds: Math.max(5, Math.round(Number(rt.perfSampleSeconds) || 60)),
      keepSamples: capacity(),
    },
    stats: {
      samples: samples.length,
      oldestAt: samples.length ? samples[0].ts : null,
      newestAt: samples.length ? samples[samples.length - 1].ts : null,
      lastSampleMs: Math.round(lastSampleMs * 1000) / 1000,
      lastDriftMs,
      loopLagSupported: !!loopHist,
      httpTotal: httpStat.total,
    },
    current: samples.length ? samples[samples.length - 1] : null,
    series: recent,
  };
}

/** 供测试/排查 */
export function resetPerfSamples() {
  samples.length = 0;
  prevCpu = null;
  prevQueries = null;
  prevAt = 0;
  prevTotalReq = 0;
}
