import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

function fileExists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** 裸命令（python3/python）是否可用：Windows 用 where，其它用 which */
function cmdExists(cmd) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd],
      { encoding: 'utf8', timeout: 3000, windowsHide: true });
    return r.status === 0 && String(r.stdout || '').trim().length > 0;
  } catch { return false; }
}

/**
 * 脚本与解释器路径：**先按存在性过滤**，再按优先级选。
 * 注意 Windows 上 `python3` 常常是个指向微软商店的假别名（进程能起来但立刻报 9009），
 * 所以裸命令也要先用 where/which 校验一次，别只看路径里有没有斜杠。
 */
export function resolvePaths() {
  const env = process.env;
  const scriptCandidates = [
    env.NGA_ANALYSIS_SCRIPT,
    '/opt/teyvat-nga/nga_analysis.py',                                  // 生产（PM2 部署）
    path.resolve(process.cwd(), 'scripts/nga_analysis.py'),             // 本地：cwd=server
    path.resolve(process.cwd(), '../server/scripts/nga_analysis.py'),   // 本地：cwd=项目根
    path.resolve(process.cwd(), 'server/scripts/nga_analysis.py'),
  ].filter(Boolean);
  const pythonCandidates = [
    env.NGA_ANALYSIS_PYTHON,
    '/opt/teyvat-nga/venv/bin/python',   // 生产虚拟环境
    process.platform === 'win32' ? 'python' : 'python3',
    process.platform === 'win32' ? 'py' : 'python',
  ].filter(Boolean);

  const script = scriptCandidates.find(fileExists) || scriptCandidates[0];
  const python = pythonCandidates.find((p) => (p.includes('/') || p.includes('\\') ? fileExists(p) : cmdExists(p)))
    || pythonCandidates[0];
  return { script, python, candidates: { scripts: scriptCandidates, pythons: pythonCandidates } };
}

/**
 * 模块级状态：当前子进程 / 开始时间 / 最近一次结束信息。
 * 只在内存里（PM2 单实例），供「同一时刻只跑一个」与排障用。
 */
let child = null;
let startedAt = 0;
let lastExit = null;

/** 进程是否还活着（防 PM2 重启/异常退出后标记不干净） */
export function isRunning() {
  if (!child) return false;
  if (child.exitCode !== null || child.signalCode) { child = null; return false; }
  try { process.kill(child.pid, 0); return true; } catch { child = null; return false; }
}

/** 终止当前进程（管理端「停止」用得上；kill 后脚本自己的 finally 会关连接） */
export function killRun() {
  if (!isRunning()) return false;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  return true;
}

/**
 * 启动一次分析。force=true（默认）会绕过面板的「分析间隔」门控，立即执行。
 * dump=true 会让脚本顺手生成一份「抓取快照」单文件（01 原文 + 03 总结论提示词 + 06 本轮汇总，
 * 去重合并），供管理面板下载；定时运行不传，避免每 5 分钟写一堆没人看的文件。
 * 立即返回，不等脚本跑完；结果由脚本回写 system_settings 的 nga_health_* 供面板轮询。
 */
export function startRun({ force = true, dump = false, timeoutMs = 180000 } = {}) {
  if (isRunning()) {
    const err = new Error('已有一次抓取正在运行，请等它结束');
    err.status = 409;
    err.code = 'NGA_RUN_BUSY';
    throw err;
  }
  const { script, python } = resolvePaths();
  if (!script || !fs.existsSync(script)) {
    const err = new Error(
      `找不到分析脚本（尝试过 ${script}）。可在 server/.env 里用 NGA_ANALYSIS_SCRIPT 指定绝对路径`);
    err.status = 500;
    err.code = 'NGA_SCRIPT_NOT_FOUND';
    throw err;
  }

  const args = [script];
  if (force) args.push('--force');
  if (dump) args.push('--dump');
  // 环境变量继承后端进程（DB_* 已由 server/.env 注入，脚本据此连库）
  const c = spawn(python, args, {
    cwd: path.dirname(script),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let out = '';
  const keep = (buf) => { out = (out + buf.toString()).slice(-4000); };
  c.stdout?.on('data', keep);
  c.stderr?.on('data', keep);

  child = c;
  startedAt = Date.now();
  logger.info(`[NGA] 手动抓取已启动 pid=${c.pid} (${python} ${args.join(' ')})`);

  const timer = setTimeout(() => {
    if (isRunning()) {
      logger.warn('[NGA] 手动抓取超过 %dms，强制结束', timeoutMs);
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  c.on('error', (err) => {
    lastExit = { pid: c.pid, code: null, error: err.message, out, at: new Date() };
    logger.error('[NGA] 手动抓取启动失败: ' + err.message);
    child = null;
  });
  c.on('close', (code, signal) => {
    lastExit = { pid: c.pid, code, signal, out, at: new Date() };
    logger.info(`[NGA] 手动抓取结束 code=${code} signal=${signal || '-'}（耗时 ${Date.now() - startedAt}ms）`);
    child = null;
  });

  return { pid: c.pid, script, python, force, startedAt: new Date(startedAt).toISOString() };
}

/** 供面板/排障查看最近一次手动运行的状态 */
export function getRunStatus() {
  return {
    running: isRunning(),
    pid: child?.pid ?? null,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    lastExit: lastExit
      ? { pid: lastExit.pid, code: lastExit.code, signal: lastExit.signal ?? null,
          error: lastExit.error ?? null, at: lastExit.at.toISOString(),
          tail: String(lastExit.out || '').split('\n').slice(-8).join('\n').slice(-1200) }
      : null,
    dump: latestDumpMeta(),
  };
}

/* ---------------- 抓取快照（--dump）的读取 ---------------- */

/** 快照目录：与分析脚本同级（生产 /opt/teyvat-nga/dumps，本地 server/scripts/dumps） */
export function dumpDir() {
  const { script } = resolvePaths();
  return path.join(path.dirname(script || '.'), 'dumps');
}

/**
 * 找一个可下载的快照文件。
 * · 不传 name → 固定读稳定名 nga-dump-latest.txt（手动抓取每次都会覆盖它）
 * · 传 name   → 只接受 `nga-dump-<数字/横线>.txt` 这种纯文件名，**杜绝目录穿越**
 */
export function findDumpFile(name = '') {
  const want = /^nga-dump-\d{8}-\d{6}\.txt$/.test(name) ? name
    : (/^nga-dump-latest\.txt$/.test(name) ? name : 'nga-dump-latest.txt');
  const p = path.join(dumpDir(), want);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return { path: p, filename: want, size: st.size, mtime: st.mtime.toISOString(), dir: dumpDir() };
  } catch {
    return null;
  }
}

/** 面板用：最近一份快照的名称/时间/大小（没有则 null） */
export function latestDumpMeta() {
  const hit = findDumpFile();
  return hit ? { filename: hit.filename, size: hit.size, mtime: hit.mtime } : null;
}

/** 列出目录里的快照（按时间倒序；给面板展示历史留档） */
export function listDumps(limit = 10) {
  try {
    return fs.readdirSync(dumpDir())
      .filter((f) => /^nga-dump-\d{8}-\d{6}\.txt$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dumpDir(), f));
        return { filename: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export default { startRun, isRunning, killRun, getRunStatus, resolvePaths, findDumpFile, listDumps, dumpDir };
