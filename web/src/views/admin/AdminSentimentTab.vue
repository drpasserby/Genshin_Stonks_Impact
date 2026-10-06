<template>
  <!-- 市场情绪：社交平台情绪快照的审核队列 -->
  <div>
    <div class="bar">
      <el-select v-model="sentiFilter" style="width:170px" @change="onSentiFilterChange">
        <el-option label="全部情绪" value="" />
        <el-option label="待审核" value="PENDING" />
        <el-option label="已通过" value="APPROVED" />
        <el-option label="已驳回" value="REJECTED" />
      </el-select>
      <el-tag v-if="sentiPending > 0" type="warning" effect="dark" size="small">
        {{ sentiPending }} 条待审核
      </el-tag>
      <span class="cell-sub">
        由脚本从社交平台抓取并自动归纳，看涨/看跌分开成条；通过后才会出现在「市场情绪」页
      </span>
      <el-button :icon="Refresh" circle title="刷新" @click="loadSentiments" />
    </div>
    <el-table :data="sentimentList" v-loading="sentiLoading">
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column label="平台" width="120">
        <template #default="{ row }">{{ row.platformName || row.platform }}</template>
      </el-table-column>
      <el-table-column label="标题 / 概况" min-width="300">
        <template #default="{ row }">
          <a
            v-if="row.sourceUrl"
            class="news-title-link"
            :href="row.sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
          ><b>{{ row.title }}</b> <el-icon><TopRight /></el-icon></a>
          <b v-else>{{ row.title }}</b>
          <div v-if="row.summary" class="cell-sub">{{ row.summary }}</div>
          <div class="cell-sub link-sub">{{ row.author }} · 抓取于 {{ fmtTime(row.fetchedAt) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="影响走向/强度" width="130">
        <template #default="{ row }">
          <el-tag :type="row.direction === 'UP' ? 'danger' : 'success'" size="small" effect="plain">
            {{ row.direction === 'UP' ? '看涨' : '看跌' }}
          </el-tag>
          <el-progress :percentage="row.strength" :stroke-width="8" :show-text="false" style="margin-top:6px" />
          <div class="cell-sub num">强度 {{ row.strength }}</div>
        </template>
      </el-table-column>
      <el-table-column label="关联角色" min-width="150">
        <template #default="{ row }">
          <el-tag v-for="k in row.stocks" :key="k.id" size="small" style="margin:2px 4px 2px 0">{{ k.name }}</el-tag>
          <span v-if="!row.stocks?.length" class="cell-sub">无</span>
        </template>
      </el-table-column>
      <el-table-column label="审核" width="150">
        <template #default="{ row }">
          <el-tag :type="newsReviewTagType(row.reviewStatus)" size="small">
            {{ newsReviewLabel(row.reviewStatus) }}
          </el-tag>
          <div v-if="row.reviewNote" class="cell-sub">{{ row.reviewNote }}</div>
          <div v-else-if="row.reviewer" class="cell-sub">
            {{ row.reviewer }} · {{ fmtTime(row.reviewedAt) }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }">
          <template v-if="row.reviewStatus === 'PENDING'">
            <el-button size="small" type="success" @click="reviewSenti(row, 'approve')">通过</el-button>
            <el-button size="small" type="warning" plain @click="reviewSenti(row, 'reject')">驳回</el-button>
          </template>
          <span v-else class="cell-sub">{{ row.reviewStatus === 'APPROVED' ? '已公开' : '已驳回' }}</span>
          <el-button
            v-if="store.canDelete"
            size="small" type="danger" plain
            @click="removeSenti(row)"
          >删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="bar pager" v-if="sentiTotal > sentiPageSize">
      <el-pagination
        background
        layout="prev, pager, next, jumper"
        :total="sentiTotal"
        :page-size="sentiPageSize"
        :current-page="sentiPage"
        @current-change="goSentiPage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, TopRight } from '@element-plus/icons-vue';
import type { MarketSentimentItem, NewsReviewStatus } from '@/types';
import { apiAdminSentiments, apiAdminReviewSentiment, apiAdminDeleteSentiment } from '@/api/sentiment';
import { useUserStore } from '@/stores/user';
import { fmtTime, newsReviewLabel, newsReviewTagType } from '@/utils/format';

const emit = defineEmits<{
  /** 待审核条数变化时通知父组件（顶部分组角标用） */
  (e: 'pending-change', count: number): void;
}>();

const store = useUserStore();

/* ==================== 市场情绪（社交平台情绪快照）====================
 * 与「新闻引用」完全独立的一条管理线：表、接口、审核状态都分开。
 * 数据由脚本抓取后自动归纳，作者固定是「平台 + 自动总结」，这里只做审核与删除。
 */
const sentimentAll = ref<MarketSentimentItem[]>([]);
const sentiFilter = ref<'' | NewsReviewStatus>('');
const sentiPage = ref(1);
const sentiPageSize = 25;
const sentiLoading = ref(false);

const sentiFiltered = computed(() =>
  sentiFilter.value ? sentimentAll.value.filter((s) => s.reviewStatus === sentiFilter.value) : sentimentAll.value
);
const sentiTotal = computed(() => sentiFiltered.value.length);
const sentiPending = computed(() => sentimentAll.value.filter((s) => s.reviewStatus === 'PENDING').length);
const sentimentList = computed(() =>
  sentiFiltered.value.slice((sentiPage.value - 1) * sentiPageSize, sentiPage.value * sentiPageSize)
);

/** 待审数变化同步给父组件（角标） */
watch(sentiPending, (v) => emit('pending-change', v), { immediate: true });

async function loadSentiments() {
  sentiLoading.value = true;
  try {
    const res = await apiAdminSentiments({ page: 1, pageSize: 100 });
    sentimentAll.value = res.list;
    if ((sentiPage.value - 1) * sentiPageSize >= sentiTotal.value) sentiPage.value = 1;
  } finally { sentiLoading.value = false; }
}

function onSentiFilterChange() {
  sentiPage.value = 1;
}

function goSentiPage(p: number) {
  sentiPage.value = p;
}

async function reviewSenti(row: MarketSentimentItem, action: 'approve' | 'reject') {
  let note = '';
  if (action === 'reject') {
    try {
      const r = await ElMessageBox.prompt('驳回理由（可留空）', '驳回该条市场情绪', {
        confirmButtonText: '确定驳回', cancelButtonText: '取消', inputValue: '',
      });
      note = r.value ?? '';
    } catch { return; }
  }
  try {
    await apiAdminReviewSentiment(row.id, action, note);
    ElMessage.success(action === 'approve' ? '已通过，市场情绪页立即可见' : '已驳回');
    await loadSentiments();
  } catch { /* 全局提示 */ }
}

async function removeSenti(row: MarketSentimentItem) {
  try {
    await ElMessageBox.confirm(
      `确认删除市场情绪 #${row.id}《${row.title}》？该条记录不会保留。`, '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch { return; }
  try {
    await apiAdminDeleteSentiment(row.id);
    ElMessage.success('已删除');
    await loadSentiments();
  } catch { /* 全局提示 */ }
}

onMounted(() => {
  loadSentiments();
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.link-sub { margin-top: 2px; }
.news-title-link { display: inline-flex; align-items: center; gap: 2px; color: var(--ts-ink); text-decoration: none; }
.news-title-link:hover { color: var(--ts-gold-dark); text-decoration: underline; text-underline-offset: 2px; }
.pager { justify-content: center; }
</style>