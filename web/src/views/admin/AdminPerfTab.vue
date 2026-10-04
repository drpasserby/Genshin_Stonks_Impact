<template>
  <!-- 系统性能（持续监控 / 只看一眼） -->
  <div class="bar">
    <el-switch
      v-model="perfCfg.enabled"
      :loading="perfSaving"
      active-text="持续监控"
      inactive-text="仅手动刷新"
      inline-prompt
      @change="onPerfToggle"
    />
    <span class="bar-sub">采样间隔</span>
    <el-input-number
      v-model="perfCfg.intervalSeconds" :min="5" :max="3600" :step="5" size="small"
      style="width:118px" @change="(v: number | undefined) => savePerfNum('perf_sample_seconds', v)" />
    <span class="bar-sub">秒 · 内存保留</span>
    <el-input-number
      v-model="perfCfg.keepSamples" :min="60" :max="20160" :step="60" size="small"
      style="width:128px" @change="(v: number | undefined) => savePerfNum('perf_keep_samples', v)" />
    <span class="bar-sub">条</span>
    <el-button type="primary" :icon="Refresh" :loading="perfLoading" @click="refreshPerf">刷新</el-button>
    <el-checkbox v-model="perfAuto">自动刷新（5 秒）</el-checkbox>
    <span class="bar-sub">上次刷新 {{ perfUpdatedText }}</span>
  </div>

  <el-alert type="info" :closable="false" show-icon style="margin-bottom:12px" :title="perfInfoTitle" />

  <div class="perf-cards">
    <div v-for="c in perfCards" :key="c.label" class="perf-card">
      <label>{{ c.label }}</label>
      <b class="num" :class="c.cls">{{ c.value }}</b>
      <small>{{ c.sub }}</small>
    </div>
  </div>

  <div class="perf-charts" v-if="perfSeries.length > 1">
    <div v-for="s in perfSparklines" :key="s.label" class="perf-chart">
      <div class="spark-head"><span>{{ s.label }}</span><b class="num">{{ s.now }}</b></div>
      <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
        <polyline :points="s.points" />
      </svg>
      <div class="spark-foot"><span>低 {{ s.min }}</span><span>高 {{ s.max }}</span></div>
    </div>
  </div>
  <el-empty v-else :description="perf?.config.enabled ? '正在采集，稍等片刻或点「刷新」' : '已关闭持续监控：点「刷新」现场采集一次'" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { apiAdminPerf, apiAdminPerfRefresh, apiAdminUpdateSetting, type AdminPerf, type PerfSample } from '@/api/admin';

const props = defineProps<{
  /** 是否处于「系统性能」子页（由父组件 panelTab 决定；切走就停轮询） */
  active: boolean;
}>();

const perf = ref<AdminPerf | null>(null);
const perfSeries = ref<PerfSample[]>([]);
const perfLoading = ref(false);
const perfSaving = ref(false);
const perfAuto = ref(true);
const perfUpdatedAt = ref(0);
const perfCfg = reactive({ enabled: true, intervalSeconds: 60, keepSamples: 1440 });
let perfTimer: ReturnType<typeof setInterval> | null = null;

/** 前端最多保留/绘制多少个点（后端默认保留 1440 条 = 24 小时；这里按需降采样展示 240 点） */
const PERF_POINTS = 240;

const perfUpdatedText = computed(() =>
  perfUpdatedAt.value ? new Date(perfUpdatedAt.value).toLocaleTimeString('zh-CN') : '尚未刷新'
);

const perfInfoTitle = computed(() => {
  const st = perf.value?.stats;
  const cfg = perf.value?.config;
  if (!st || !cfg) return '正在读取性能数据…';
  return `数据只存在内存里：已采样 ${st.samples} 条${cfg.keepSamples ? ` / 最多 ${cfg.keepSamples} 条` : ''}` +
    `（环形缓冲，新的挤掉最旧的，不写数据库、不占磁盘）；单次采样耗时 ${st.lastSampleMs} ms；` +
    `采样间隔 ${cfg.intervalSeconds} 秒；${cfg.enabled ? '持续监控中' : '已关闭持续监控（只在点刷新时采集一次）'}`;
});

function fmtDur(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

function applyPerf(res: AdminPerf, mode: 'full' | 'inc') {
  perf.value = res;
  perfCfg.enabled = res.config.enabled;
  perfCfg.intervalSeconds = res.config.intervalSeconds;
  perfCfg.keepSamples = res.config.keepSamples;
  if (mode === 'inc' && perfSeries.value.length) {
    const lastTs = perfSeries.value[perfSeries.value.length - 1].ts;
    const add = res.series.filter((s) => s.ts > lastTs);
    if (add.length) perfSeries.value = perfSeries.value.concat(add).slice(-PERF_POINTS);
  } else {
    perfSeries.value = res.series.slice(-PERF_POINTS);
  }
  perfUpdatedAt.value = Date.now();
}

async function loadPerf(mode: 'full' | 'inc' = 'full') {
  try {
    const since = mode === 'inc' && perfSeries.value.length
      ? perfSeries.value[perfSeries.value.length - 1].ts
      : 0;
    const res = since ? await apiAdminPerf({ since }) : await apiAdminPerf({ points: PERF_POINTS });
    applyPerf(res, since ? 'inc' : 'full');
  } catch { /* 全局提示 */ }
}

/** 刷新按钮：让后端现场采一次样，保证 CPU% 等"两次差值"指标立刻有值 */
async function refreshPerf() {
  perfLoading.value = true;
  try {
    applyPerf(await apiAdminPerfRefresh(), 'full');
  } catch { /* 全局提示 */ } finally { perfLoading.value = false; }
}

async function savePerfSetting(key: string, value: string) {
  perfSaving.value = true;
  try {
    await apiAdminUpdateSetting(key, value);
    ElMessage.success('已保存，30 秒内生效');
    loadPerf('full');
  } catch { /* 全局提示 */ } finally { perfSaving.value = false; }
}
function onPerfToggle(v: string | number | boolean) {
  savePerfSetting('perf_monitor_enabled', v ? '1' : '0');
}
function savePerfNum(key: string, v: number | undefined) {
  if (v == null) return;
  savePerfSetting(key, String(v));
}

/** 卡片：数值 + 健康度配色（>=bad 红，>=warn 黄） */
const perfCards = computed(() => {
  const c = perf.value?.current;
  if (!c) return [] as Array<{ label: string; value: string; sub: string; cls: string }>;
  const cls = (v: number | null | undefined, warn = 70, bad = 90) =>
    v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok';
  return [
    { label: 'CPU 使用率', value: c.cpuPct == null ? '-' : `${c.cpuPct}%`, sub: `${c.cpuCount} 核 · 两次采样间的平均`, cls: cls(c.cpuPct, 70, 90) },
    { label: '负载均值 1m', value: `${c.load1}`, sub: `5m ${c.load5} · 15m ${c.load15}（>${c.cpuCount} 表示排队）`, cls: c.load1 > c.cpuCount * 2 ? 'bad' : c.load1 > c.cpuCount ? 'warn' : 'ok' },
    { label: '内存', value: `${c.memUsedPct}%`, sub: `${c.memUsedMb} / ${c.memTotalMb} MB · 可用 ${c.memAvailMb} MB`, cls: cls(c.memUsedPct, 85, 95) },
    { label: '交换分区', value: `${c.swapUsedPct}%`, sub: c.swapTotalMb ? `${c.swapUsedMb} / ${c.swapTotalMb} MB` : '未启用', cls: cls(c.swapUsedPct, 30, 70) },
    { label: `磁盘 ${c.diskPath}`, value: `${c.diskUsedPct}%`, sub: `${c.diskUsedGb} / ${c.diskTotalGb} GB · 剩余 ${c.diskFreeGb} GB`, cls: cls(c.diskUsedPct, 75, 90) },
    { label: '交易所进程', value: `${c.nodeRssMb} MB`, sub: `堆 ${c.nodeHeapMb} MB · 已运行 ${fmtDur(c.procUptimeSec)}`, cls: '' },
    { label: 'HTTP 并发', value: `${c.httpInFlight}`, sub: c.httpPerMin == null ? '在飞请求数' : `在飞 ${c.httpInFlight} · 约 ${c.httpPerMin} 请求/分钟（含本面板轮询）`, cls: '' },
    { label: '数据库', value: c.dbAlive ? `${c.dbThreadsConnected ?? '-'}` : '不可用', sub: `连接数 / 运行中 ${c.dbThreadsRunning ?? '-'} · ${c.dbQps ?? '-'} QPS`, cls: c.dbAlive ? '' : 'bad' },
    { label: '事件循环延迟', value: c.loopLagP50 == null ? '-' : `${c.loopLagP50} ms`, sub: `p99 ${c.loopLagP99 ?? '-'} ms（越接近 0 越顺；采样瞬间测 150ms 窗口）`, cls: (c.loopLagP99 ?? 0) > 200 ? 'warn' : 'ok' },
    { label: '系统运行', value: fmtDur(c.uptimeSec), sub: `采样 ${perf.value?.stats.samples ?? 0} 条 · 单次耗时 ${perf.value?.stats.lastSampleMs ?? '-'} ms`, cls: '' },
  ];
});

type PerfNumField = 'cpuPct' | 'memUsedPct' | 'load1' | 'httpInFlight' | 'nodeRssMb' | 'dbThreadsConnected';

/** 迷你曲线：fixedMax 用于百分比类指标（固定 0~100，便于横向比较） */
function spark(field: PerfNumField, fixedMax?: number) {
  const vals = perfSeries.value
    .map((s) => Number(s[field]))
    .filter((v) => Number.isFinite(v)) as number[];
  if (vals.length < 2) return { points: '', min: '-', max: '-', now: '-' };
  const lo = fixedMax != null ? 0 : Math.min(...vals);
  const hi = fixedMax != null ? fixedMax : Math.max(...vals);
  const span = hi - lo || 1;
  const n = vals.length;
  const digits = fixedMax != null ? 1 : 2;
  const points = vals
    .map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 29 - Math.max(0, Math.min(1, (v - lo) / span)) * 27;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return {
    points,
    min: lo.toFixed(digits),
    max: hi.toFixed(digits),
    now: vals[vals.length - 1].toFixed(digits),
  };
}

const perfSparklines = computed(() => [
  { label: 'CPU %', ...spark('cpuPct', 100) },
  { label: '内存 %', ...spark('memUsedPct', 100) },
  { label: '负载 1m', ...spark('load1') },
  { label: '在飞请求', ...spark('httpInFlight') },
  { label: 'DB 连接', ...spark('dbThreadsConnected') },
  { label: '进程内存 MB', ...spark('nodeRssMb') },
]);

/** 自动刷新：只在「系统性能」页打开、且浏览器标签页可见时才请求（切走就停） */
function tickPerf() {
  if (!perfAuto.value) return;
  if (!props.active) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  loadPerf('inc');
}

onMounted(() => {
  perfTimer = setInterval(tickPerf, 5000);
  loadPerf('full'); // 性能页一打开就有数据（读的是后端内存快照，零数据库压力）
});

// 切到「系统性能」子页时自动刷新一次
watch(() => props.active, (v) => {
  if (v) loadPerf('full');
});

onBeforeUnmount(() => {
  if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.bar-sub { font-size: 12px; color: #a08a60; }
/* 系统性能面板 */
.perf-cards {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: 10px; margin-bottom: 14px;
}
.perf-card {
  border: 1px solid var(--ts-card-border); border-radius: 10px;
  padding: 10px 12px; background: rgba(201, 162, 75, 0.05);
  display: flex; flex-direction: column; gap: 2px;
}
.perf-card label { font-size: 12px; color: #a08a60; }
.perf-card b { font-size: 19px; line-height: 1.3; }
.perf-card small { font-size: 11px; color: var(--ts-ink-soft); line-height: 1.5; }
.perf-card b.ok { color: #2e7d32; }
.perf-card b.warn { color: #b8860b; }
.perf-card b.bad { color: #c0392b; }
.perf-charts {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px;
}
.perf-chart { border: 1px solid var(--ts-card-border); border-radius: 10px; padding: 8px 10px; }
.spark-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: #a08a60; }
.spark-head b { font-size: 13px; color: var(--ts-gold-dark); }
.spark { width: 100%; height: 46px; display: block; margin: 4px 0 2px; }
.spark polyline { fill: none; stroke: var(--ts-gold); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
.spark-foot { display: flex; justify-content: space-between; font-size: 10px; color: #bba98a; }
</style>