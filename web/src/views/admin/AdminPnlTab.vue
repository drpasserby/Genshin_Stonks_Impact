<template>
  <!-- 盈亏报表导出：仅超级管理员 -->
  <p class="panel-desc">
    导出最近一段时间内<b>所有用户的盈亏排行</b>为 CSV。计算方式：用「当前持仓与余额 − 该时间段内的成交变动」
    反推期初资产，因此<b>不需要历史快照</b>。仅在点击「生成」时才计算，平时不占任何服务器资源。
  </p>

  <div class="bar">
    <el-radio-group v-model="pnlDays">
      <el-radio-button :value="3">最近 3 天</el-radio-button>
      <el-radio-button :value="7">最近 7 天</el-radio-button>
      <el-radio-button :value="14">最近 14 天</el-radio-button>
    </el-radio-group>
    <el-button type="primary" :icon="Download" :loading="pnlLoading" @click="loadPnl">生成报表</el-button>
    <el-button v-if="pnl" :icon="Download" @click="downloadPnlCsv">下载 CSV</el-button>
  </div>

  <el-alert v-if="pnl" type="success" :closable="false" show-icon style="margin:10px 0"
    :title="`统计区间：${fmtTime(pnl.from)} ~ ${fmtTime(pnl.to)}（${pnl.days} 天）｜共 ${pnl.users} 位用户，区间总盈亏 ${fmtSigned(pnl.totalProfit)}`"
    :description="pnl.excludedNewUsers ? `已排除 ${pnl.excludedNewUsers} 位在统计区间内新注册的用户（没有期初资产，参与排名会失真）` : ''" />

  <el-table v-if="pnl" :data="pnlPaged" v-loading="pnlLoading" size="small" max-height="520" style="width:100%">
    <el-table-column prop="rank" label="排名" width="70" align="center" />
    <el-table-column prop="userId" label="用户ID" width="80" />
    <el-table-column prop="nickname" label="昵称" min-width="140" />
    <el-table-column label="区间前市值" align="right" min-width="110">
      <template #default="{ row }"><span class="num">{{ fmtNumber(row.mvBefore) }}</span></template>
    </el-table-column>
    <el-table-column label="区间前余额" align="right" min-width="110">
      <template #default="{ row }"><span class="num">{{ fmtNumber(row.cashBefore) }}</span></template>
    </el-table-column>
    <el-table-column label="区间后市值" align="right" min-width="110">
      <template #default="{ row }"><span class="num">{{ fmtNumber(row.mvAfter) }}</span></template>
    </el-table-column>
    <el-table-column label="区间后余额" align="right" min-width="110">
      <template #default="{ row }"><span class="num">{{ fmtNumber(row.cashAfter) }}</span></template>
    </el-table-column>
    <el-table-column label="盈亏" align="right" min-width="120">
      <template #default="{ row }">
        <b class="num" :class="changeClass(row.profit)">{{ fmtSigned(row.profit) }}</b>
        <div class="cell-sub num" :class="changeClass(row.profitPct)">{{ fmtSigned(row.profitPct, '%') }}</div>
      </template>
    </el-table-column>
  </el-table>
  <div class="bar pager" v-if="pnl && pnl.list.length > pnlPageSize">
    <el-pagination
      background
      layout="total, prev, pager, next, jumper"
      :total="pnl.list.length"
      :page-size="pnlPageSize"
      :current-page="pnlPage"
      @current-change="goPnlPage"
    />
    <span class="bar-sub">（导出 CSV 始终包含全部 {{ pnl.list.length }} 位用户）</span>
  </div>
  <el-empty v-if="!pnl" description="选择时间范围后点「生成报表」" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Download } from '@element-plus/icons-vue';
import { apiAdminPnl, type PnlResult } from '@/api/admin';
import { fmtNumber, fmtSigned, fmtTime, changeClass } from '@/utils/format';

const pnlDays = ref<number>(7);
const pnl = ref<PnlResult | null>(null);
const pnlLoading = ref(false);
/** 盈亏报表是「全员排名」，数据一次取回（导出 CSV 需要完整名单），这里只在前端分页展示 */
const pnlPage = ref(1);
const pnlPageSize = 20;
const pnlPaged = computed(() => {
  const all = pnl.value?.list ?? [];
  const start = (pnlPage.value - 1) * pnlPageSize;
  return all.slice(start, start + pnlPageSize);
});

/** 生成报表（只有点击时才计算，无定时任务） */
async function loadPnl() {
  pnlLoading.value = true;
  try {
    pnl.value = await apiAdminPnl(pnlDays.value);
    pnlPage.value = 1;
    if (!pnl.value.list.length) ElMessage.info('该时间段内没有可统计的用户');
  } catch { /* 全局提示 */ } finally { pnlLoading.value = false; }
}

/** 盈亏报表在前端分页展示（数据一次性取回，导出 CSV 需要完整名单） */
function goPnlPage(p: number) {
  pnlPage.value = p;
}

/** 按需求生成 7 列 CSV：排名/用户ID/昵称/区间前市值/区间前余额/区间后市值/区间后余额 */
function downloadPnlCsv() {
  if (!pnl.value) return;
  const header = ['排名', '用户ID', '用户昵称', '周期前持有市值', '周期前持有余额', '周期后持有市值', '周期后持有余额'];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of pnl.value.list) {
    lines.push([
      r.rank, r.userId, esc(r.nickname),
      r.mvBefore.toFixed(2), r.cashBefore.toFixed(2),
      r.mvAfter.toFixed(2), r.cashAfter.toFixed(2),
    ].join(','));
  }
  // 加 BOM，保证 Excel 打开中文不乱码
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = pnl.value.to.slice(0, 10).replace(/-/g, '');
  a.download = `用户盈亏_最近${pnl.value.days}天_${d}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ElMessage.success(`已导出 ${pnl.value.list.length} 行`);
}
</script>

<style scoped>
.panel-desc { margin: 0 0 10px; font-size: 12px; color: #a08a60; line-height: 1.8; }
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.bar-sub { font-size: 12px; color: #a08a60; }
.pager { justify-content: center; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
</style>