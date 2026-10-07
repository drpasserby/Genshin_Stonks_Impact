<template>
  <div class="rank-page">
    <el-card shadow="never" class="rank-card">
      <div class="head">
        <div class="head-left">
          <h2>排行榜</h2>
          <p class="sub">
            只展示参与者的<b>昵称</b>与金额，不展示用户 ID。
            数据每 {{ data?.intervalMinutes ?? 10 }} 分钟更新一次，上次更新：{{ fmtTime(data?.updatedAt) }}
          </p>
        </div>
        <div class="head-right">
          <el-button @click="router.push('/stars')">⭐ 明星持仓</el-button>
          <el-button :loading="loading" @click="load()">刷新</el-button>
        </div>
      </div>

      <el-alert
        v-if="data && !data.enabled"
        type="info"
        :closable="false"
        show-icon
        title="排行榜暂未开放"
        description="管理员已暂停排行榜更新，过段时间再来看看吧。"
      />

      <template v-else>
        <el-alert
          v-if="loggedIn && !participating"
          type="warning"
          :closable="false"
          show-icon
          title="你已退出排行榜"
          description="当前状态下你的昵称与金额不会出现在榜单里。可在「我的 → 排行榜参与」里重新开启。"
          style="margin-bottom: 12px"
        />

        <div class="meta">
          <span>共 <b>{{ data?.participants ?? 0 }}</b> 人参与，本榜展示前 {{ data?.topN ?? 50 }} 名</span>
          <span class="unit">口径：可用摩拉 + 挂单冻结摩拉 + Σ(持仓股数 × 现价)</span>
        </div>

        <el-empty v-if="!loading && !list.length" description="还没有人上榜（或本榜暂无数据）" />

        <el-table v-else v-loading="loading" :data="list" stripe class="rank-table">
          <el-table-column label="排名" width="90" align="center">
            <template #default="{ row }">
              <span class="rank-no" :class="`r${row.rank <= 3 ? row.rank : 0}`">{{ row.rank }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="nickname" label="昵称" min-width="160" show-overflow-tooltip />
          <el-table-column label="总资产（摩拉）" align="right" min-width="180">
            <template #default="{ row }">
              <span class="num money">{{ fmtNumber(row.value) }}</span>
              <span class="money-big">（{{ fmtBig(row.value) }}）</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiRank } from '@/api/rank';
import { useUserStore } from '@/stores/user';
import { useSystemStore } from '@/stores/system';
import { fmtBig, fmtNumber, fmtTime } from '@/utils/format';
import type { RankResult } from '@/types';

const router = useRouter();
const store = useUserStore();
const sysStore = useSystemStore();

const data = ref<RankResult | null>(null);
const loading = ref(false);

const list = computed(() => data.value?.list ?? []);
const loggedIn = computed(() => store.isLoggedIn);
/** 当前登录用户是否参与排行榜（true 表示在榜） */
const participating = computed(() => store.user?.rankOptIn !== false);

async function load() {
  loading.value = true;
  try {
    data.value = await apiRank();
  } catch { /* 错误已由全局提示 */ } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  sysStore.fetchMeta();
});
</script>

<style scoped>
.rank-page { max-width: 1000px; margin: 0 auto; padding: 16px 12px 40px; }
.rank-card { border-radius: 14px; }
.head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
.head-left { flex: 1; }
.head h2 { margin: 0 0 4px; font-size: 18px; color: var(--ts-gold-dark); letter-spacing: 1px; }
.sub { margin: 0; font-size: 12px; color: var(--ts-ink-soft); line-height: 1.8; }
.meta {
  display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between;
  font-size: 12px; color: var(--ts-ink-soft); margin: 4px 0 10px;
}
.unit { opacity: .85; }
.rank-table { width: 100%; }
.rank-no {
  display: inline-block; min-width: 28px; padding: 1px 6px; border-radius: 6px;
  background: rgba(201, 162, 75, .14); color: var(--ts-gold-dark); font-weight: 600;
}
.rank-no.r1 { background: linear-gradient(135deg, #e8c25a, #c9a24b); color: #fff; }
.rank-no.r2 { background: linear-gradient(135deg, #cfd4da, #a9b2bb); color: #fff; }
.rank-no.r3 { background: linear-gradient(135deg, #dfa878, #c08a52); color: #fff; }
.money { font-weight: 600; color: var(--ts-ink); }
.money-big { font-size: 12px; color: var(--ts-ink-soft); margin-left: 4px; }
</style>
