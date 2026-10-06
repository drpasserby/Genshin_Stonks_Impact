<template>
  <!-- 成交记录管理 -->
  <div class="bar">
    <el-input v-model="tradeQ" placeholder="按用户名搜索" clearable style="width:200px" @input="onTradeFilterChange" />
    <span class="bar-sub">共 {{ tradeTotal }} 笔成交</span>
  </div>
  <el-table :data="adminTrades" v-loading="tradesLoading">
    <el-table-column prop="id" label="ID" width="70" />
    <el-table-column label="用户" min-width="110">
      <template #default="{ row }">{{ row.nickname || row.username }}</template>
    </el-table-column>
    <el-table-column label="角色" min-width="110">
      <template #default="{ row }">{{ row.stockName }}</template>
    </el-table-column>
    <el-table-column label="方向" width="70">
      <template #default="{ row }">
        <el-tag :type="row.side === 'BUY' ? 'danger' : 'success'" size="small" effect="plain">
          {{ row.side === 'BUY' ? '买入' : '卖出' }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="价格" align="right">
      <template #default="{ row }"><span class="num">{{ fmtPrice(row.price) }}</span></template>
    </el-table-column>
    <el-table-column label="数量" align="right">
      <template #default="{ row }"><span class="num">{{ row.quantity }}</span></template>
    </el-table-column>
    <el-table-column label="金额" align="right">
      <template #default="{ row }"><span class="num">{{ fmtNumber(row.amount) }}</span></template>
    </el-table-column>
    <el-table-column label="时间" min-width="150">
      <template #default="{ row }"><span class="num">{{ fmtTime(row.matchedAt) }}</span></template>
    </el-table-column>
    <el-table-column label="操作" width="110">
      <template #default="{ row }">
        <!-- 成交记录是审计凭证：管理员完全没有操作，只有超级管理员能删 -->
        <el-button
          v-if="store.canDelete"
          size="small"
          type="danger"
          plain
          @click="removeTrade(row)"
        >删除</el-button>
        <el-tooltip v-else content="成交记录是审计凭证，管理员不可删除、也没有替代操作" placement="top">
          <span class="disabled-btn-wrap"><el-button size="small" disabled>不可删除</el-button></span>
        </el-tooltip>
      </template>
    </el-table-column>
  </el-table>
  <div class="bar pager" v-if="tradeTotal > tradePageSize">
    <el-pagination
      background
      layout="total, prev, pager, next, jumper"
      :total="tradeTotal"
      :page-size="tradePageSize"
      :current-page="tradePage"
      @current-change="goTradePage"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiAdminTrades, apiAdminDeleteTrade } from '@/api/admin';
import { useUserStore } from '@/stores/user';
import { fmtNumber, fmtPrice, fmtTime } from '@/utils/format';

interface AdminTradeRow {
  id: number;
  username?: string;
  nickname?: string;
  stockCode?: string | null;
  stockName?: string | null;
  side: string;
  price: number;
  quantity: number;
  amount: number;
  matchedAt: string;
}

const store = useUserStore();
const adminTrades = ref<AdminTradeRow[]>([]);
const tradesLoading = ref(false);
const tradeQ = ref('');
/** 成交记录分页（服务端分页，默认每页 20 条） */
const tradePage = ref(1);
const tradePageSize = 20;
const tradeTotal = ref(0);

async function loadTrades() {
  tradesLoading.value = true;
  try {
    const page = await apiAdminTrades({
      q: tradeQ.value, page: tradePage.value, pageSize: tradePageSize,
    });
    adminTrades.value = page.list as unknown as AdminTradeRow[];
    tradeTotal.value = page.total ?? page.list.length;
  } finally { tradesLoading.value = false; }
}
/** 搜索变化：回到第 1 页 */
function onTradeFilterChange() {
  tradePage.value = 1;
  loadTrades();
}
function goTradePage(p: number) {
  tradePage.value = p;
  loadTrades();
}
async function removeTrade(row: { id: number }) {
  await ElMessageBox.confirm(`确定删除成交记录 #${row.id}？此操作不可恢复。`, '删除记录', { type: 'warning' })
    .catch(() => Promise.reject(new Error('cancel')));
  try {
    await apiAdminDeleteTrade(row.id);
    ElMessage.success('已删除');
    loadTrades();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

onMounted(() => {
  loadTrades();
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.bar-sub { font-size: 12px; color: #a08a60; }
.pager { justify-content: center; }
/* 被禁用按钮外面包一层 span，tooltip 才能在 disabled 按钮上正常显示 */
.disabled-btn-wrap { display: inline-block; }
</style>