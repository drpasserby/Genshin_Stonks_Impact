<template>
  <!-- 新闻 / 市场情绪 两条独立管理线 -->
  <el-radio-group v-model="newsSubTab" size="small" style="margin-bottom:10px">
    <el-radio-button label="news">
      新闻引用
      <el-tag v-if="pendingCount > 0" type="warning" effect="dark" size="small" style="margin-left:4px">
        {{ pendingCount }}
      </el-tag>
    </el-radio-button>
    <el-radio-button label="sentiment">
      市场情绪
      <el-tag v-if="sentiPending > 0" type="warning" effect="dark" size="small" style="margin-left:4px">
        {{ sentiPending }}
      </el-tag>
    </el-radio-button>
  </el-radio-group>

  <div v-show="newsSubTab === 'news'">
    <div class="bar">
      <el-button type="primary" :icon="Plus" @click="openNewsDialog()">发布新闻</el-button>
      <el-select v-model="newsFilter" style="width:170px" @change="onNewsFilterChange">
        <el-option label="全部新闻" value="" />
        <el-option label="待审核" value="PENDING" />
        <el-option label="已通过" value="APPROVED" />
        <el-option label="已驳回" value="REJECTED" />
      </el-select>
      <el-tag v-if="pendingCount > 0" type="warning" effect="dark" size="small">
        {{ pendingCount }} 条待审核
      </el-tag>
      <el-button :icon="Refresh" circle title="刷新" @click="loadNews" />
    </div>
    <el-table :data="newsList" v-loading="newsLoading">
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column label="标题 / 来源链接" min-width="260">
        <template #default="{ row }">
          <a
            v-if="row.sourceUrl"
            class="news-title-link"
            :href="row.sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <b>{{ row.title }}</b> <el-icon><TopRight /></el-icon>
          </a>
          <b v-else>{{ row.title }}</b>
          <div class="cell-sub link-sub">{{ row.sourceUrl || '(无来源链接)' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="方向/强度" width="120">
        <template #default="{ row }">
          <el-tag :type="row.direction === 'UP' ? 'danger' : 'success'" size="small" effect="plain">
            {{ row.direction === 'UP' ? '看涨' : '看跌' }}
          </el-tag>
          <el-progress :percentage="row.strength" :stroke-width="8" :show-text="false" style="margin-top:6px" />
        </template>
      </el-table-column>
      <el-table-column label="关联角色" min-width="150">
        <template #default="{ row }">
          <el-tag v-for="s in row.stocks" :key="s.id" size="small" style="margin:2px 4px 2px 0">{{ s.name }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="投票" width="110">
        <template #default="{ row }">
          <span class="num up">▲ {{ row.votes?.up ?? 0 }}</span>
          <span class="num down">▼ {{ row.votes?.down ?? 0 }}</span>
          <div v-if="row.votes?.score != null" class="cell-sub num">影响分 {{ row.votes.score }}</div>
          <div v-else class="cell-sub">待审不能投票</div>
        </template>
      </el-table-column>
      <el-table-column label="发布者" width="130">
        <template #default="{ row }">
          {{ row.publisher || '-' }}
          <div v-if="row.publisherRole" class="cell-sub">
            <el-tag :type="roleTagType(row.publisherRole)" size="small" effect="plain">
              {{ roleLabel(row.publisherRole) }}
            </el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="审核" width="130">
        <template #default="{ row }">
          <el-tag :type="newsReviewTagType(row.reviewStatus)" size="small">
            {{ newsReviewLabel(row.reviewStatus) }}
          </el-tag>
          <div v-if="row.reviewNote" class="cell-sub">{{ row.reviewNote }}</div>
          <div v-else-if="row.reviewedAt" class="cell-sub num">{{ fmtTime(row.reviewedAt) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="生效状态" width="140">
        <template #default="{ row }">
          <template v-if="row.reviewStatus === 'APPROVED'">
            <el-tag v-if="isExpired(row)" type="info" size="small">已过期</el-tag>
            <el-tag v-else type="success" size="small">生效中</el-tag>
            <div class="cell-sub num">{{ fmtTime(row.expiresAt) }} 失效</div>
          </template>
          <span v-else class="cell-sub">未生效</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="290" fixed="right">
        <template #default="{ row }">
          <template v-if="row.reviewStatus === 'PENDING'">
            <el-button size="small" type="success" @click="reviewNews(row, 'approve')">通过</el-button>
            <el-button size="small" type="warning" plain @click="reviewNews(row, 'reject')">驳回</el-button>
          </template>
          <template v-else-if="row.reviewStatus === 'APPROVED'">
            <el-button size="small" @click="openNewsDialog(row)">编辑</el-button>
            <el-button
              v-if="!isExpired(row)"
              size="small"
              type="warning"
              plain
              @click="expireNews(row)"
            >立刻失效</el-button>
          </template>
          <span v-else class="cell-sub">已驳回，不会生效（如需重发请新建一条）</span>
          <!-- 物理删除仅超级管理员；管理员用「立刻失效」代替 -->
          <el-button
            v-if="store.canDelete"
            size="small"
            type="danger"
            plain
            @click="removeNews(row)"
          >删除</el-button>
          <el-tooltip v-else-if="row.reviewStatus !== 'REJECTED'" content="管理员无权删除新闻，请使用「立刻失效」（记录全部保留）" placement="top">
            <span class="disabled-btn-wrap"><el-button size="small" disabled>删除</el-button></span>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
    <div class="bar pager" v-if="newsTotal > newsPageSize">
      <el-pagination
        background
        layout="prev, pager, next, jumper"
        :total="newsTotal"
        :page-size="newsPageSize"
        :current-page="newsPage"
        @current-change="goNewsPage"
      />
    </div>
  </div><!-- /新闻引用 -->

  <!-- 市场情绪：社交平台情绪快照的审核队列（子组件自持数据，待审数通过事件回传） -->
  <AdminSentimentTab v-show="newsSubTab === 'sentiment'" @pending-change="sentiPending = $event" />

  <!-- 新闻对话框（发布/编辑） -->
  <AdminNewsDialog v-model:visible="newsDlgVisible" :news="newsDlgRow" :stocks="adminStocks" @saved="loadNews" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, TopRight } from '@element-plus/icons-vue';
import type { NewsItem, NewsReviewStatus } from '@/types';
import {
  apiAdminNewsList, apiAdminReviewNews, apiAdminExpireNews, apiAdminDeleteNews,
  apiAdminStocks, type AdminStock,
} from '@/api/admin';
import { useUserStore } from '@/stores/user';
import { fmtTime, newsReviewLabel, newsReviewTagType, roleLabel, roleTagType } from '@/utils/format';
import AdminNewsDialog from './dialogs/AdminNewsDialog.vue';
import AdminSentimentTab from './AdminSentimentTab.vue';

const store = useUserStore();

const newsSubTab = ref<'news' | 'sentiment'>('news');
/** 市场情绪待审数（由 AdminSentimentTab 加载后回传，用于顶部分组角标） */
const sentiPending = ref(0);

/* ---- 新闻管理 ----
 * 用 /admin/news（含待审与已驳回），不用公开的 /news（只有已通过的，看不到审核队列）。
 * 该接口一次返回全量（后端上限 200 条），所以筛选与分页都在前端做。
 */
const newsAll = ref<NewsItem[]>([]);
/** 审核状态筛选：'' = 全部，'PENDING' = 只看待审队列 */
const newsFilter = ref<'' | NewsReviewStatus>('');
const newsPage = ref(1);
const newsPageSize = 25;
const newsLoading = ref(false);

const newsDlgVisible = ref(false);
const newsDlgRow = ref<NewsItem | null>(null);

/** 新闻对话框的「关联角色」下拉选项：与原实现保持一致，取管理端标的分页第一页 */
const adminStocks = ref<AdminStock[]>([]);

const newsFiltered = computed(() =>
  newsFilter.value ? newsAll.value.filter((n) => n.reviewStatus === newsFilter.value) : newsAll.value
);
const newsTotal = computed(() => newsFiltered.value.length);
const newsList = computed(() =>
  newsFiltered.value.slice((newsPage.value - 1) * newsPageSize, newsPage.value * newsPageSize)
);
/** 待审条数（不管当前筛选是什么，都显示真实积压量） */
const pendingCount = computed(() => newsAll.value.filter((n) => n.reviewStatus === 'PENDING').length);

async function loadNews() {
  newsLoading.value = true;
  try {
    newsAll.value = await apiAdminNewsList();
    if ((newsPage.value - 1) * newsPageSize >= newsTotal.value) newsPage.value = 1;
  } finally { newsLoading.value = false; }
}

function onNewsFilterChange() {
  newsPage.value = 1;
}

function goNewsPage(p: number) {
  newsPage.value = p;
}

function openNewsDialog(row?: NewsItem) {
  newsDlgRow.value = row ?? null;
  newsDlgVisible.value = true;
}

/** 审核：通过（立即生效，有效期重新起算）/ 驳回（可附理由，永不生效） */
async function reviewNews(row: NewsItem, action: 'approve' | 'reject') {
  let note = '';
  if (action === 'reject') {
    const r = await ElMessageBox.prompt(
      `驳回新闻「${row.title}」？可填写理由，发布者能在操作员面板看到。`,
      '驳回新闻',
      {
        type: 'warning',
        inputPlaceholder: '例如：来源不可靠 / 与本游戏无关（可留空）',
        confirmButtonText: '确认驳回',
        cancelButtonText: '取消',
      }
    ).catch(() => Promise.reject(new Error('cancel')));
    note = String(r?.value ?? '').trim();
  } else {
    await ElMessageBox.confirm(
      `通过新闻「${row.title}」？\n\n通过后立即生效：进入价格引擎与公开新闻板块，有效期从此刻重新起算。`,
      '通过审核',
      { type: 'info', confirmButtonText: '确认通过', cancelButtonText: '取消' }
    ).catch(() => Promise.reject(new Error('cancel')));
  }
  try {
    await apiAdminReviewNews(row.id, action, note || undefined);
    ElMessage.success(action === 'approve' ? '已通过，新闻立即生效' : '已驳回，该新闻不会生效');
    loadNews();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

/** 立刻失效：管理员的「准删除」动作（记录与投票全部保留） */
async function expireNews(row: NewsItem) {
  await ElMessageBox.confirm(
    `让新闻「${row.title}」立刻失效？\n\n失效后不再影响股价、新闻板块也不再显示为有效；记录与投票全部保留，随时可追溯。`,
    '新闻立刻失效',
    { type: 'warning', confirmButtonText: '确认失效', cancelButtonText: '取消' }
  ).catch(() => Promise.reject(new Error('cancel')));
  try {
    await apiAdminExpireNews(row.id);
    ElMessage.success('已立刻失效（记录保留）');
    loadNews();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

/** 物理删除新闻：仅超级管理员（按钮对管理员隐藏，后端也会拦） */
async function removeNews(row: NewsItem) {
  await ElMessageBox.confirm(`确定删除新闻「${row.title}」？其关联角色与投票将一并删除。`, '删除新闻', { type: 'warning' })
    .catch(() => Promise.reject(new Error('cancel')));
  try {
    await apiAdminDeleteNews(row.id);
    ElMessage.success('已删除');
    loadNews();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

function isExpired(row: NewsItem): boolean {
  return !row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now();
}

/** 新闻对话框的关联角色选项：管理端标的分页第一页（与原实现同源） */
async function loadNewsStockOptions() {
  try {
    const page = await apiAdminStocks({ page: 1, pageSize: 20 });
    adminStocks.value = page.list;
  } catch { /* 全局提示 */ }
}

onMounted(() => {
  loadNews();
  loadNewsStockOptions();
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.bar-sub { font-size: 12px; color: #a08a60; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.link-sub { margin-top: 2px; }
.news-title-link { display: inline-flex; align-items: center; gap: 2px; color: var(--ts-ink); text-decoration: none; }
.news-title-link:hover { color: var(--ts-gold-dark); text-decoration: underline; text-underline-offset: 2px; }
.pager { justify-content: center; }
/* 被禁用按钮外面包一层 span，tooltip 才能在 disabled 按钮上正常显示 */
.disabled-btn-wrap { display: inline-block; }
</style>