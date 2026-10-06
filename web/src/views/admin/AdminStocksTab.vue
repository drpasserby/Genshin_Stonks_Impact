<template>
  <!-- 角色股票 / 指数基金管理 -->
  <div class="bar">
    <el-button type="primary" :icon="Plus" @click="openStockDialog()">新增角色股票</el-button>
    <el-button type="warning" :icon="Plus" plain @click="openStockDialog(undefined, 'FUND')">新增指数基金</el-button>
  </div>
  <div class="bar">
    <el-input v-model="stockQ" placeholder="按代码/名称搜索" clearable style="width:200px" @input="onStockFilterChange" />
    <el-select v-model="stockType" placeholder="全部类型" clearable style="width:130px" @change="onStockFilterChange">
      <el-option label="角色股票" value="STOCK" />
      <el-option label="指数基金" value="FUND" />
    </el-select>
    <el-select v-model="stockStatus" placeholder="全部状态" clearable style="width:130px" @change="onStockFilterChange">
      <el-option label="正常" :value="1" />
      <el-option label="停牌" :value="0" />
      <el-option label="已退市" :value="2" />
    </el-select>
    <span class="bar-sub">排序</span>
    <el-select v-model="stockSort" style="width:158px" @change="onStockFilterChange">
      <el-option label="序号 · 新→旧" value="id:desc" />
      <el-option label="序号 · 旧→新" value="id:asc" />
      <el-option label="代码 A→Z" value="code:asc" />
      <el-option label="名称 A→Z" value="name:asc" />
      <el-option label="价格 高→低" value="price:desc" />
      <el-option label="成交量 高→低" value="volume:desc" />
    </el-select>
    <span class="bar-sub">共 {{ stockTotal }} 个标的</span>
  </div>
  <el-table :data="adminStocks" v-loading="stocksLoading">
    <el-table-column prop="id" label="序号" width="76" align="center" />
    <el-table-column prop="code" label="代码" width="90" />
    <el-table-column label="类型" width="80">
      <template #default="{ row }">
        <el-tag v-if="row.type === 'FUND'" size="small" type="warning" effect="plain">基金</el-tag>
        <el-tag v-else size="small" effect="plain">角色</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="86">
      <template #default="{ row }">
        <el-tag v-if="row.status === 2" size="small" type="danger" effect="plain">已退市</el-tag>
        <el-tag v-else-if="row.status === 0" size="small" type="warning" effect="plain">停牌</el-tag>
        <el-tag v-else size="small" type="success" effect="plain">正常</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="名称" min-width="170">
      <template #default="{ row }">
        <div class="srow">
          <StockAvatar :name="row.name" :avatar-url="row.avatarUrl" :size="34" />
          <div>
            <b>{{ row.name }}</b>
            <div v-if="row.type === 'FUND'" class="cell-sub num">净值 {{ fmtPrice(row.nav ?? row.price) }}</div>
          </div>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="现价" align="right">
      <template #default="{ row }"><span class="num">{{ fmtPrice(row.price) }}</span></template>
    </el-table-column>
    <el-table-column label="流通份额" align="right">
      <template #default="{ row }"><span class="num">{{ fmtBig(row.totalShares) }}</span></template>
    </el-table-column>
    <el-table-column label="今日量" align="right">
      <template #default="{ row }"><span class="num">{{ fmtBig(row.volume) }}</span></template>
    </el-table-column>
    <el-table-column label="操作" width="360" fixed="right">
      <template #default="{ row }">
        <el-button v-if="row.type === 'FUND'" size="small" type="warning" plain @click="openFundDialog(row)">成分股</el-button>
        <el-button size="small" @click="openStockDialog(row)">编辑</el-button>

        <!-- 暂停交易 / 恢复交易 -->
        <el-button
          v-if="row.status !== 2"
          size="small"
          :type="row.status === 0 ? 'success' : 'warning'"
          plain
          @click="setStockStatus(row, row.status === 0 ? 1 : 0)"
        >{{ row.status === 0 ? '恢复交易' : '停牌' }}</el-button>

        <!-- 退市 / 恢复上市 -->
        <el-button
          size="small"
          :type="row.status === 2 ? 'success' : 'danger'"
          plain
          @click="setStockStatus(row, row.status === 2 ? 1 : 2)"
        >{{ row.status === 2 ? '恢复上市' : '退市' }}</el-button>

        <!-- 物理删除仅超级管理员；管理员只能用「停牌 / 退市」保留数据 -->
        <el-button
          v-if="store.canDelete"
          size="small"
          type="danger"
          text
          @click="removeStock(row)"
        >删除</el-button>
        <el-tooltip v-else content="管理员无权删除标的，请使用「停牌」或「退市」（历史数据全部保留）" placement="top">
          <span class="disabled-btn-wrap"><el-button size="small" disabled>删除</el-button></span>
        </el-tooltip>
      </template>
    </el-table-column>
  </el-table>
  <div class="bar pager" v-if="stockTotal > stockPageSize">
    <el-pagination
      background
      layout="total, prev, pager, next, jumper"
      :total="stockTotal"
      :page-size="stockPageSize"
      :current-page="stockPage"
      @current-change="goStockPage"
    />
  </div>

  <!-- 股票 / 基金对话框 -->
  <AdminStockDialog
    v-model:visible="stockDlgVisible"
    :stock="stockDlgRow"
    :create-type="stockDlgCreateType"
    @saved="loadStocks"
  />
  <!-- 基金成分股对话框 -->
  <AdminFundDialog v-model:visible="fundDlgVisible" :fund="fundDlgRow" @saved="loadStocks" />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { apiAdminStocks, apiAdminUpdateStock, apiAdminDeleteStock, type AdminStock } from '@/api/admin';
import { useUserStore } from '@/stores/user';
import { fmtBig, fmtPrice } from '@/utils/format';
import StockAvatar from '@/components/StockAvatar.vue';
import AdminStockDialog, { type StockDlgRow } from './dialogs/AdminStockDialog.vue';
import AdminFundDialog from './dialogs/AdminFundDialog.vue';

const store = useUserStore();

const adminStocks = ref<AdminStock[]>([]);
const stocksLoading = ref(false);
/** 标的分页与筛选（服务端分页：标的会随活动增长，不一次拉全量） */
const stockQ = ref('');
const stockType = ref<'' | 'STOCK' | 'FUND'>('');
const stockStatus = ref<number | ''>('');
/** 排序：'字段:方向'。默认「序号 新→旧」= 最新发行（代码最大）的排在最前面 */
const stockSort = ref('id:desc');
const stockPage = ref(1);
const stockPageSize = 20;
const stockTotal = ref(0);

const stockDlgVisible = ref(false);
const stockDlgRow = ref<StockDlgRow | null>(null);
const stockDlgCreateType = ref<'STOCK' | 'FUND'>('STOCK');

const fundDlgVisible = ref(false);
const fundDlgRow = ref<{ id: number; name: string } | null>(null);

async function loadStocks() {
  stocksLoading.value = true;
  try {
    const [sortField, sortDir] = stockSort.value.split(':');
    const page = await apiAdminStocks({
      q: stockQ.value,
      type: stockType.value,
      status: stockStatus.value === '' ? '' : stockStatus.value,
      sort: sortField,
      order: sortDir,
      page: stockPage.value,
      pageSize: stockPageSize,
    });
    adminStocks.value = page.list;
    stockTotal.value = page.total ?? page.list.length;
    // 删掉当前页最后一条后自动回退一页，避免停在空表格上
    if (!page.list.length && stockPage.value > 1) {
      stockPage.value = Math.max(1, Math.ceil((page.total ?? 0) / stockPageSize));
      return await loadStocks();
    }
  } finally { stocksLoading.value = false; }
}

/** 标的筛选变化：回到第 1 页 */
function onStockFilterChange() {
  stockPage.value = 1;
  loadStocks();
}
function goStockPage(p: number) {
  stockPage.value = p;
  loadStocks();
}

function openStockDialog(row?: StockDlgRow, type: 'STOCK' | 'FUND' = 'STOCK') {
  stockDlgRow.value = row ?? null;
  stockDlgCreateType.value = type;
  stockDlgVisible.value = true;
}

function openFundDialog(row: { id: number; name: string }) {
  fundDlgRow.value = row;
  fundDlgVisible.value = true;
}

/** 单标的：停牌 / 恢复交易 / 退市 / 恢复上市 */
async function setStockStatus(
  row: { id: number; name: string; status?: number; type?: 'STOCK' | 'FUND' },
  status: number
) {
  const kind = row.type === 'FUND' ? '基金' : '角色';
  const titles: Record<number, string> = { 0: '暂停交易', 1: '恢复交易', 2: '退市' };
  let warn = `确定把${kind}「${row.name}」${titles[status]}？`;
  if (status === 0) {
    warn = `确定暂停「${row.name}」的交易？\n\n· 无法再下新单，也不再参与周期撮合\n· 行情与价格仍会显示（新闻/投票仍影响价格）\n· 用户已挂的单可以自行撤销\n\n之后可随时「恢复交易」。`;
  } else if (status === 2) {
    warn = `确定让「${row.name}」退市？\n\n· 从行情列表隐藏\n· 无法再下单或撤单\n· 自动撤销全部未成交挂单，并解冻对应资金/股份\n· 价格冻结，用户持仓按最后价格保留\n\n之后可随时「恢复上市」。`;
  }
  await ElMessageBox.confirm(warn, titles[status], {
    type: status === 0 ? 'info' : 'warning',
    confirmButtonText: '确定',
    cancelButtonText: '取消',
  }).catch(() => Promise.reject(new Error('cancel')));
  try {
    const res = await apiAdminUpdateStock(row.id, { status });
    ElMessage.success(
      status === 2
        ? `已退市，撤销了 ${res.cancelledOrders ?? 0} 笔未成交挂单`
        : status === 0
          ? '已暂停交易'
          : '已恢复交易'
    );
    loadStocks();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

async function removeStock(row: { id: number; name: string }) {
  await ElMessageBox.confirm(`删除「${row.name}」将同时清理其挂单/持仓/成交与K线。继续？`, '删除标的', { type: 'warning' })
    .catch(() => Promise.reject(new Error('cancel')));
  try {
    await apiAdminDeleteStock(row.id);
    ElMessage.success('已删除');
    loadStocks();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

onMounted(() => {
  loadStocks();
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.bar-sub { font-size: 12px; color: #a08a60; }
.srow { display: flex; align-items: center; gap: 8px; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.pager { justify-content: center; }
/* 被禁用按钮外面包一层 span，tooltip 才能在 disabled 按钮上正常显示 */
.disabled-btn-wrap { display: inline-block; }
</style>