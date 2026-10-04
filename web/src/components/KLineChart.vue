<template>
  <div ref="chartEl" class="kline-chart" :style="{ height: height + 'px' }" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import type { KlinePoint } from '@/types';
import { fmtPrice, fmtBig, fmtTime, fmtDate } from '@/utils/format';

const props = defineProps<{ data: KlinePoint[]; loading?: boolean; periodLabel?: string }>();
const emit = defineEmits<{ (e: 'range', count: number): void }>();
const height = ref(360);
const chartEl = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;

const upColor = '#b0413e';
const downColor = '#2e7d5b';

function buildOption(list: KlinePoint[]): EChartsOption {
  const dayMode = props.periodLabel === '1d';
  const dates = list.map((p) => (dayMode ? fmtDate(p.ts) : fmtTime(p.ts)));
  const values = list.map((p) => [p.open, p.close, p.low, p.high]);
  const volumes = list.map((p) => p.volume);

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number; seriesName: string; value: number | number[] }>;
        const idx = arr[0]?.dataIndex ?? 0;
        const k = list[idx];
        const v = arr.find((a) => a.seriesName === '成交量')?.value ?? 0;
        if (!k) return '';
        const cls = k.close >= k.open ? upColor : downColor;
        const head = dayMode ? fmtDate(k.ts) : fmtTime(k.ts);
        return [
          `<div style="font-weight:600">${head}</div>`,
          `开 <b>${fmtPrice(k.open)}</b>　收 <b style="color:${cls}">${fmtPrice(k.close)}</b>`,
          `高 <b>${fmtPrice(k.high)}</b>　低 <b>${fmtPrice(k.low)}</b>`,
          `量 <b>${fmtBig(v as number)}</b>`,
        ].join('<br/>');
      },
    },
    legend: { show: false },
    grid: [
      { left: 10, right: 56, top: 10, height: '62%' },
      { left: 10, right: 56, top: '78%', height: '12%' },
    ],
    xAxis: [
      {
        type: 'category', data: dates, boundaryGap: true,
        axisLine: { lineStyle: { color: '#b8a272' } },
        axisLabel: { color: '#8a7450', fontSize: 10, formatter: (v: string) => v },
      },
      {
        type: 'category', gridIndex: 1, data: dates, boundaryGap: true,
        axisLabel: { show: false }, axisTick: { show: false }, axisLine: { show: false },
      },
    ],
    yAxis: [
      { scale: true, splitLine: { lineStyle: { color: '#e3d5ae', type: 'dashed' } }, axisLabel: { color: '#8a7450', fontSize: 10 } },
      { scale: true, gridIndex: 1, splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: Math.max(0, 100 - (100 * 80) / Math.max(list.length, 1)), end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 2, borderColor: '#d9c392' },
    ],
    series: [
      {
        name: 'K线', type: 'candlestick',
        data: values,
        itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor },
      },
      {
        name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
        data: volumes,
        itemStyle: {
          color: (p: { dataIndex: number }) => {
            const k = list[p.dataIndex];
            return k && k.close >= k.open ? 'rgba(176,65,62,0.5)' : 'rgba(46,125,91,0.5)';
          },
        },
      },
    ],
  };
}

function render() {
  if (!chart) return;
  if (props.loading || !props.data.length) {
    chart.clear();
    chart.setOption({ title: { text: props.loading ? '加载中...' : '暂无K线数据', left: 'center', top: 'middle', textStyle: { color: '#9a8a6a', fontSize: 14, fontWeight: 'normal' } } });
    return;
  }
  chart.setOption(buildOption(props.data), true);
  emit('range', props.data.length);
}

function resize() {
  const el = chartEl.value?.parentElement;
  if (el && chart) {
    height.value = Math.min(Math.max(el.clientWidth * 0.62, 260), 460);
    chart.resize();
  }
}

onMounted(() => {
  if (!chartEl.value) return;
  chart = echarts.init(chartEl.value);
  window.addEventListener('resize', resize);
  render();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  chart?.dispose();
  chart = null;
});
watch(() => props.data, render, { deep: false });
</script>

<style scoped>
.kline-chart { width: 100%; }
</style>
