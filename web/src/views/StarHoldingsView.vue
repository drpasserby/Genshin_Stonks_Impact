<template>
  <div class="stars-page">
    <el-card shadow="never" class="stars-card">
      <div class="head">
        <div class="head-left">
          <h2>⭐ 明星持仓</h2>
          <p class="sub">
            「明星」是自愿接受公开标签的身份组：<b>持仓强制公开</b>，同时强制参与排行榜。
            这里只公开 <b>标的 / 股数 / 市值 / 占总资产比例</b> —— 不含成本价与盈亏，也不含现金余额。
          </p>
        </div>
        <div class="head-right">
          <el-button @click="router.push('/rank')">返回排行榜</el-button>
          <el-button :loading="loading" @click="load()">刷新</el-button>
        </div>
      </div>

      <el-alert
        v-if="data"
        type="info"
        :closable="false"
        show-icon
        :title="`当前共 ${data.count} 位明星`"
        :description="`数据每 ${data.cacheSeconds} 秒缓存一次，上次更新：${fmtTime(data.updatedAt)}`"
        style="margin-bottom: 12px"
      />

      <el-empty
        v-if="!loading && !list.length"
        description="目前还没有明星账号"
      >
        <div class="empty-tip">
          明星身份由管理员赋予。成为明星后，你的持仓结构（标的、股数、市值与占比）会对所有人公开，
          但成本价与盈亏不会公开。
        </div>
      </el-empty>

      <div v-for="item in list" :key="item.nickname" class="star-block">
        <div class="star-head">
          <span class="star-name">
            <el-icon class="star-icon"><StarFilled /></el-icon>
            {{ item.nickname }}
          </span>
          <span class="star-meta">
            持仓 {{ item.holdingCount }} 只 · 合计市值
            <b class="num">{{ fmtNumber(item.totalMarketValue) }}</b> 摩拉
            <span class="money-big">（{{ fmtBig(item.totalMarketValue) }}）</span>
          </span>
        </div>

        <el-table :data="item.holdings" size="small" stripe class="hold-table">
          <el-table-column label="角色" min-width="180">
            <template #default="{ row }">
              <router-link v-if="!row.delisted" class="stock-link" :to="`/stock/${row.stockId}`">
                <StockAvatar :src="row.avatarUrl" :name="row.name" :size="24" />
                <span class="s-name">{{ row.name }}</span>
                <span class="s-code">{{ row.code }}</span>
              </router-link>
              <span v-else class="s-name">
                {{ row.name }} <el-tag size="small" type="info">已下架</el-tag>
              </span>
            </template>
          </el-table-column>
          <el-table-column label="持仓股数" align="right" width="110">
            <template #default="{ row }"><span class="num">{{ row.quantity }}</span></template>
          </el-table-column>
          <el-table-column label="现价" align="right" width="110">
            <template #default="{ row }"><span class="num">{{ fmtPrice(row.price) }}</span></template>
          </el-table-column>
          <el-table-column label="市值" align="right" width="140">
            <template #default="{ row }"><span class="num">{{ fmtNumber(row.marketValue) }}</span></template>
          </el-table-column>
          <el-table-column label="占总资产" min-width="170">
            <template #default="{ row }">
              <div class="weight-cell">
                <el-progress
                  :percentage="Math.min(100, Number(row.weightPct) || 0)"
                  :stroke-width="10"
                  :show-text="false"
                  class="weight-bar"
                />
                <span class="num weight-txt">{{ fmtNumber(row.weightPct) }}%</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { StarFilled } from '@element-plus/icons-vue';
import { apiStars } from '@/api/stars';
import StockAvatar from '@/components/StockAvatar.vue';
import { fmtBig, fmtNumber, fmtPrice, fmtTime } from '@/utils/format';
import type { StarHoldingsResult } from '@/types';

const router = useRouter();
const data = ref<StarHoldingsResult | null>(null);
const loading = ref(false);
const list = computed(() => data.value?.list ?? []);

async function load() {
  loading.value = true;
  try {
    data.value = await apiStars();
  } catch { /* 错误已由全局提示 */ } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.stars-page { max-width: 1000px; margin: 0 auto; padding: 16px 12px 40px; }
.stars-card { border-radius: 14px; }
.head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
.head-left { flex: 1; }
.head-left h2 { margin: 0 0 4px; font-size: 20px; color: var(--ts-gold-dark); }
.head-right { display: flex; gap: 8px; flex: none; }
.sub { margin: 0; font-size: 12px; color: var(--ts-ink-soft); line-height: 1.7; }

.empty-tip { font-size: 12px; color: var(--ts-ink-soft); line-height: 1.8; max-width: 460px; margin: 0 auto; }

.star-block { margin-top: 16px; }
.star-head {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 10px 10px 0 0;
  background: linear-gradient(90deg, rgba(201, 162, 75, 0.18), rgba(201, 162, 75, 0.04));
  border: 1px solid var(--ts-card-border); border-bottom: none;
}
.star-name { font-size: 15px; font-weight: 700; color: var(--ts-gold-dark); display: inline-flex; align-items: center; gap: 4px; }
.star-icon { color: #d9a441; }
.star-meta { font-size: 12px; color: var(--ts-ink-soft); }
.hold-table { border: 1px solid var(--ts-card-border); border-radius: 0 0 10px 10px; }

.stock-link { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; color: var(--ts-ink); }
.stock-link:hover .s-name { color: var(--ts-gold-dark); }
.s-name { font-weight: 600; }
.s-code { font-size: 11px; color: var(--ts-ink-soft); }

.weight-cell { display: flex; align-items: center; gap: 8px; }
.weight-bar { flex: 1; min-width: 60px; }
.weight-txt { font-size: 12px; color: var(--ts-ink-soft); width: 52px; text-align: right; }
.money-big { font-size: 11px; color: var(--ts-ink-soft); }
</style>
