<template>
  <div class="page-container market-page">
    <!-- 工具条 -->
    <div class="toolbar ts-card">
      <el-input v-model="keyword" placeholder="搜索名称 / 代码" clearable class="search" :prefix-icon="Search" @input="debouncedLoad" />
      <el-radio-group v-model="kind" size="default" @change="reload">
        <el-radio-button value="">全部</el-radio-button>
        <el-radio-button value="STOCK">角色</el-radio-button>
        <el-radio-button value="FUND">基金</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="mode" size="default" @change="reload">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="watch" :disabled="!store.isLoggedIn">自选</el-radio-button>
      </el-radio-group>
      <el-select v-model="sortKey" style="width: 150px" @change="reload">
        <el-option label="按发行序号" value="id" />
        <el-option label="按涨跌幅" value="changePct" />
        <el-option label="按股价" value="price" />
        <el-option label="按成交量" value="volume" />
      </el-select>
      <el-tooltip content="不显示涨跌幅为 0.00% 的角色与基金" placement="top">
        <label class="flat-switch">
          <el-switch v-model="hideFlat" />
          <span>隐藏平盘</span>
        </label>
      </el-tooltip>
      <el-button :icon="Refresh" circle title="刷新" @click="reload" />
    </div>

    <el-skeleton :loading="loading" animated :rows="6">
      <template #default>
        <!-- 桌面端表格 -->
        <div class="desktop-only ts-card table-wrap">
          <el-table :data="visibleStocks" size="large" style="width: 100%" :row-class-name="rowCls" :empty-text="emptyText" @row-click="goDetail">
            <el-table-column width="52" align="center">
              <template #default="{ row }">
                <el-icon v-if="row.watched" class="star" color="#c9a24b" @click.stop="toggleWatch(row)"><StarFilled /></el-icon>
                <el-icon v-else class="star-off" @click.stop="toggleWatch(row)"><Star /></el-icon>
              </template>
            </el-table-column>
            <el-table-column label="名称" min-width="200">
              <template #default="{ row }">
                <div class="stock-cell">
                  <StockAvatar :name="row.name" :avatar-url="row.avatarUrl" />
                  <div>
                    <div class="stock-name">
                      {{ row.name }}
                      <el-tag v-if="row.type === 'FUND'" size="small" type="warning" effect="plain" class="kind-tag">基金</el-tag>
                      <el-tag v-if="row.status === 0" size="small" type="info" effect="plain" class="kind-tag">停牌</el-tag>
                    </div>
                    <div class="stock-code">{{ row.code }}</div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="现价" align="right" min-width="90">
              <template #default="{ row }"><span class="num bold">{{ fmtPrice(row.price) }}</span></template>
            </el-table-column>
            <el-table-column label="涨跌幅" align="center" min-width="120">
              <template #default="{ row }"><ChangeBadge :value="row.changePct" suffix="%" /></template>
            </el-table-column>
            <el-table-column label="涨跌额" align="right" min-width="90">
              <template #default="{ row }"><span :class="changeClass(row.change)" class="num">{{ fmtSigned(row.change) }}</span></template>
            </el-table-column>
            <el-table-column label="今日" align="right" min-width="120">
              <template #default="{ row }">
                <div class="num">高 <b class="up">{{ fmtPrice(row.high) }}</b></div>
                <div class="num">低 <b class="down">{{ fmtPrice(row.low) }}</b></div>
              </template>
            </el-table-column>
            <el-table-column label="成交量" align="right" min-width="90">
              <template #default="{ row }"><span class="num">{{ fmtBig(row.volume) }}</span></template>
            </el-table-column>
            <el-table-column label="流通市值" align="right" min-width="110">
              <template #default="{ row }"><span class="num">{{ fmtBig(row.marketCap) }}</span></template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 移动端卡片 -->
        <div class="mobile-only stock-cards">
          <div v-for="row in visibleStocks" :key="row.id" class="ts-card stock-card" @click="goDetail(row)">
            <div class="sc-left">
              <div class="star-wrap" @click.stop="toggleWatch(row)">
                <el-icon v-if="row.watched" color="#c9a24b"><StarFilled /></el-icon>
                <el-icon v-else class="star-off"><Star /></el-icon>
              </div>
              <StockAvatar :name="row.name" :avatar-url="row.avatarUrl" />
              <div>
                <div class="stock-name">{{ row.name }}</div>
                <div class="stock-code">{{ row.code }} · 量{{ fmtBig(row.volume) }}</div>
              </div>
            </div>
            <div class="sc-right">
              <div class="num price">{{ fmtPrice(row.price) }}</div>
              <ChangeBadge :value="row.changePct" suffix="%" />
            </div>
          </div>
          <el-empty v-if="!visibleStocks.length" :description="emptyText" />
        </div>
      </template>
    </el-skeleton>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Search, Refresh, Star, StarFilled } from '@element-plus/icons-vue';
import type { Stock } from '@/types';
import { apiStockList, apiAddWatch, apiRemoveWatch } from '@/api/stocks';
import { useUserStore } from '@/stores/user';
import StockAvatar from '@/components/StockAvatar.vue';
import ChangeBadge from '@/components/ChangeBadge.vue';
import { fmtBig, fmtPrice, fmtSigned, changeClass } from '@/utils/format';

const router = useRouter();
const route = useRoute();
const store = useUserStore();
const stocks = ref<Stock[]>([]);
const loading = ref(false);
const keyword = ref('');
const mode = ref<'all' | 'watch'>('all');
/** 标的类型筛选：''=全部 / STOCK=角色 / FUND=指数基金 */
const kind = ref<'' | 'STOCK' | 'FUND'>('');
const sortKey = ref('changePct');
/** 是否隐藏平盘（涨跌幅显示为 0.00% 的标的） */
const hideFlat = ref(readPref('market_hide_flat') === '1');
let timer: ReturnType<typeof setTimeout> | null = null;

/** 涨跌幅显示两位小数，「显示为 0.00%」即视为平盘 */
function isFlat(pct: number | null | undefined) {
  return Math.abs(Number(pct) || 0) < 0.005;
}

/** 按开关过滤后的可见列表（纯前端过滤，不重新请求） */
const visibleStocks = computed(() => (hideFlat.value ? stocks.value.filter((s) => !isFlat(s.changePct)) : stocks.value));
const emptyText = computed(() => (hideFlat.value && stocks.value.length ? '当前列表全部为平盘（已隐藏）' : '没有匹配的角色股票'));

function readPref(key: string) {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式忽略 */ }
}
watch(hideFlat, (v) => writePref('market_hide_flat', v ? '1' : '0'));

async function load() {
  loading.value = true;
  try {
    stocks.value = await apiStockList({
      q: keyword.value.trim(),
      sort: sortKey.value,
      order: sortKey.value === 'name' || sortKey.value === 'code' ? 'asc' : 'desc',
      watch: mode.value === 'watch' ? '1' : '0',
      type: kind.value || undefined,
    });
  } catch { /* 全局提示 */ } finally { loading.value = false; }
}

function reload() { load(); }
function debouncedLoad() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 350);
}

/** 未登录操作需引导登录 */
function needLogin() {
  if (store.isLoggedIn) return false;
  ElMessage.info('登录后即可自选与交易');
  router.push({ name: 'login', query: { redirect: route.fullPath } });
  return true;
}

async function toggleWatch(row: Stock) {
  if (needLogin()) return;
  try {
    if (row.watched) {
      await apiRemoveWatch(row.id);
      row.watched = false;
      if (mode.value === 'watch') load();
    } else {
      await apiAddWatch(row.id);
      row.watched = true;
    }
  } catch { /* 全局提示 */ }
}

function goDetail(row: Stock) { router.push(`/stock/${row.id}`); }
function rowCls() { return 'clickable-row'; }

onMounted(load);
watch(mode, reload);
</script>

<style scoped>
.market-page { display: flex; flex-direction: column; gap: 16px; padding-top: 16px; }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 12px 16px; row-gap: 12px; }
.search { width: 220px; }
.flat-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #7a6a4a; cursor: pointer; user-select: none; }
.table-wrap { padding: 4px 10px; }
.stock-cell { display: flex; align-items: center; gap: 12px; }
.stock-name { font-weight: 700; font-size: 15px; }
.stock-code { color: #9a8a6a; font-size: 12px; }
.bold { font-weight: 700; font-size: 15px; }
.star, .star-off { cursor: pointer; font-size: 18px; }
.star-off { color: #c8b98f; }
:deep(.clickable-row) { cursor: pointer; }

.stock-cards { display: flex; flex-direction: column; gap: 10px; }
.stock-card { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; }
.sc-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.star-wrap { cursor: pointer; }
.sc-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.price { font-size: 18px; font-weight: 700; }
</style>
