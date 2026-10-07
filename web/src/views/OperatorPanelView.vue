<template>
  <div class="page-container op-page">
    <div class="ts-card">
      <h3 class="ts-title">操作员面板 · 新闻引用与倍率投票</h3>
      <el-alert type="info" :closable="false" show-icon
        title="发布新闻将影响相关角色股价（权重 B），投票结果决定涨跌方向与倍率；普通用户仅能看到新闻与行情。" />
      <el-alert
        class="review-alert"
        :type="store.publishWithoutReview ? 'success' : 'warning'"
        :closable="false"
        show-icon
        :title="store.publishWithoutReview
          ? '你的身份组发布新闻无需审核，提交后立即生效'
          : '你的身份组发布新闻需要审核：提交后进入「待审核」，管理员通过后才会生效（期间不影响股价、也不能被投票）'"
      />

      <el-tabs v-model="tab" style="margin-top:10px">
        <!-- 发布新闻 -->
        <el-tab-pane label="发布新闻" name="pub">
          <el-form :model="form" label-width="90px" style="max-width:760px">
            <el-form-item label="标题" required>
              <el-input v-model="form.title" maxlength="120" show-word-limit placeholder="如：新版本前瞻直播引热议" />
            </el-form-item>
            <el-form-item label="来源链接" required>
              <el-input v-model="form.sourceUrl" placeholder="https://...（粘贴外部新闻/帖子原文链接）" clearable>
                <template #prefix><el-icon><Link /></el-icon></template>
              </el-input>
              <div class="form-tip">必须填写合法的 http/https 链接，系统只做「引用」，不会存自撰正文。</div>
            </el-form-item>
            <el-form-item label="关联角色" required>
              <el-select v-model="form.stockIds" multiple filterable placeholder="选择受影响的角色（可多选）" style="width:100%">
                <el-option v-for="s in stocks" :key="s.id" :label="`${s.name} (${s.code})`" :value="s.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="影响方向" required>
              <el-radio-group v-model="form.direction">
                <el-radio-button value="UP">看涨 📈</el-radio-button>
                <el-radio-button value="DOWN">看跌 📉</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="影响强度">
              <el-slider v-model="form.strength" :min="1" :max="100" show-input />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="publishing" @click="publish">
                {{ store.publishWithoutReview ? '发布新闻（免审核，立即生效）' : '提交新闻（待管理员审核）' }}
              </el-button>
              <span class="form-tip" style="margin-left:10px">
                生效 {{ newsTtlCycles }} 个周期
                <template v-if="!store.publishWithoutReview"> · 审核通过后才开始计时</template>
              </span>
            </el-form-item>
          </el-form>

          <!-- 我提交的新闻（含待审与已驳回；别人的待审新闻对普通操作员不可见） -->
          <div class="my-news">
            <div class="my-news-head">
              <b>我提交的新闻</b>
              <span class="form-tip">待审期间不影响股价、不公开、也不能被投票</span>
              <el-button size="small" text :icon="Refresh" @click="loadMyNews">刷新</el-button>
            </div>
            <el-empty v-if="!myNews.length" description="还没有提交过新闻" :image-size="60" />
            <el-table v-else :data="myNews" size="small" style="width:100%">
              <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
              <el-table-column label="审核状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="newsReviewTagType(row.reviewStatus)" size="small">
                    {{ newsReviewLabel(row.reviewStatus) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="审核意见" min-width="160">
                <template #default="{ row }">
                  <span v-if="row.reviewNote" class="form-tip">{{ row.reviewNote }}</span>
                  <span v-else class="vn-muted">-</span>
                </template>
              </el-table-column>
              <el-table-column label="提交时间" width="150">
                <template #default="{ row }"><span class="num">{{ fmtTime(row.createdAt) }}</span></template>
              </el-table-column>
              <el-table-column label="生效时间" width="150">
                <template #default="{ row }">
                  <span class="num">{{ row.reviewStatus === 'APPROVED' ? fmtTime(row.expiresAt) + ' 失效' : '未生效' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <!-- 新闻投票 -->
        <el-tab-pane label="新闻投票" name="vnews">
          <el-alert type="warning" :closable="false" show-icon style="margin-bottom:10px"
            title="投票方向与倍率会参与「新闻因子」计算（权重 B），直接影响关联角色股价；发布者不能给自己的新闻投票，可换其他操作员/管理员账号。" />

          <div v-if="!activeNews.length" class="ts-card">
            <el-empty description="暂无生效中的新闻，先去「发布新闻」发一条吧" />
          </div>

          <div class="vote-news-list">
            <div v-for="n in activeNews" :key="n.id" class="ts-card vote-news-card">
              <div class="vn-head">
                <span class="dir-tag" :class="n.direction.toLowerCase()">
                  {{ n.direction === 'UP' ? '看涨' : '看跌' }} · {{ n.strength }}
                </span>
                <b class="vn-title">{{ n.title }}</b>
                <span class="vn-expire num">剩余 {{ remainText(n.expiresAt) }}</span>
              </div>

              <div class="vn-stocks">
                <span v-for="s in n.stocks" :key="s.id" class="vn-stock">{{ s.name }}</span>
                <span v-if="!n.stocks?.length" class="vn-muted">未关联角色</span>
              </div>

              <div class="vn-stat num">
                <span>当前票数</span>
                <span class="up">▲{{ n.votes?.up ?? 0 }}</span>
                <span class="down">▼{{ n.votes?.down ?? 0 }}</span>
                <span class="vn-muted">均倍率 ×{{ n.votes?.avgMult ?? 1 }}</span>
                <span v-if="n.votes?.score != null" class="vn-muted">影响分 {{ n.votes.score }}</span>
                <span v-if="myNewsVote(n.id)" class="vn-mine">
                  我已投：{{ myNewsVote(n.id)?.direction === 'UP' ? '看涨' : '看跌' }} ×{{ myNewsVote(n.id)?.multiplier }}
                </span>
              </div>

              <div class="vn-actions">
                <el-radio-group v-model="newsVoteForm[n.id].direction" size="small">
                  <el-radio-button value="UP">看涨</el-radio-button>
                  <el-radio-button value="DOWN">看跌</el-radio-button>
                </el-radio-group>
                <el-slider v-model="newsVoteForm[n.id].multiplier" :min="0.5" :max="2" :step="0.1"
                  show-input size="small" style="width:230px" />
                <el-tooltip v-if="isOwnNews(n)" content="发布者不能给自己的新闻投票" placement="top">
                  <span><el-button size="small" type="primary" plain disabled>提交投票</el-button></span>
                </el-tooltip>
                <el-button v-else size="small" type="primary" plain @click="submitNewsVote(n)">提交投票</el-button>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 股票投票 -->
        <el-tab-pane label="股票看涨看跌投票" name="vstock">
          <div class="vote-stock-grid">
            <div v-for="s in stocks" :key="s.id" class="ts-card vote-card">
              <div class="vs-head">
                <StockAvatar :name="s.name" :avatar-url="s.avatarUrl" :size="40" />
                <div class="vs-name">
                  <b>{{ s.name }}</b>
                  <span class="num">现价 {{ fmtPrice(s.price) }}</span>
                </div>
              </div>
              <el-radio-group v-model="voteForm[s.id].direction" size="small">
                <el-radio-button value="UP">看涨</el-radio-button>
                <el-radio-button value="DOWN">看跌</el-radio-button>
              </el-radio-group>
              <el-slider v-model="voteForm[s.id].multiplier" :min="0.5" :max="2" :step="0.1" show-input size="small" style="margin-top:8px" />
              <el-button size="small" type="primary" plain @click="submitStockVote(s)">提交投票</el-button>
            </div>
          </div>
        </el-tab-pane>

        <!-- 我的投票 -->
        <el-tab-pane label="我的投票" name="mine">
          <el-table :data="myVotes" style="width:100%">
            <el-table-column label="目标" min-width="220">
              <template #default="{ row }">{{ voteTargetLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="方向" width="100">
              <template #default="{ row }">
                <el-tag :type="row.direction === 'UP' ? 'danger' : 'success'" size="small">
                  {{ row.direction === 'UP' ? '看涨' : '看跌' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="倍率" width="100">
              <template #default="{ row }"><span class="num">×{{ row.multiplier }}</span></template>
            </el-table-column>
            <el-table-column label="时间" min-width="150">
              <template #default="{ row }"><span class="num">{{ fmtTime(row.updatedAt) }}</span></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Link, Refresh } from '@element-plus/icons-vue';
import type { Stock, NewsItem } from '@/types';
import { apiStockList } from '@/api/stocks';
import {
  apiPublishNews, apiVoteNews, apiVoteStock, apiMyVotes, apiNewsList, apiMyNews,
  type MyVoteItem,
} from '@/api/news';
import { useUserStore } from '@/stores/user';
import StockAvatar from '@/components/StockAvatar.vue';
import { fmtPrice, fmtTime, newsReviewLabel, newsReviewTagType } from '@/utils/format';

const store = useUserStore();
const tab = ref('pub');
const stocks = ref<Stock[]>([]);
const newsTtlCycles = ref(6);
const publishing = ref(false);

const form = reactive({ title: '', sourceUrl: '', stockIds: [] as number[], direction: 'UP' as 'UP' | 'DOWN', strength: 50 });

const voteForm = reactive<Record<number, { direction: 'UP' | 'DOWN'; multiplier: number }>>({});
const myVotes = ref<MyVoteItem[]>([]);

/** 新闻投票 */
const newsList = ref<NewsItem[]>([]);
const newsVoteForm = reactive<Record<number, { direction: 'UP' | 'DOWN'; multiplier: number }>>({});

/** 我提交的新闻（含待审/已驳回；普通操作员看不到别人的待审新闻） */
const myNews = ref<NewsItem[]>([]);

/** 仅展示生效中的新闻（未过期） */
const activeNews = computed(() =>
  newsList.value.filter((n) => !n.expiresAt || new Date(n.expiresAt).getTime() > Date.now())
);

const stockMap = computed(() => new Map(stocks.value.map((s) => [s.id, s])));
const newsMap = computed(() => new Map(newsList.value.map((n) => [n.id, n])));

/** 该新闻是否由当前登录者发布（后端禁止作者自投） */
function isOwnNews(n: NewsItem): boolean {
  const uid = store.user?.id;
  return !!uid && n.publisherId === uid;
}

/**
 * 加载我提交的新闻。
 * ★ 改用服务端过滤的 /operator/news/mine：原来拉全站 /operator/news 再在前端
 *   filter(n => n.publisherId === 我的id)，一旦接口没回 publisherId（就是因为这个字段缺失，
 *   2026-09-14 修复）或自己发的新闻被挤出「最近 200 条」，列表就永远是空的。
 */
async function loadMyNews() {
  try {
    myNews.value = await apiMyNews();
  } catch { /* 全局提示 */ }
}

/** 我对该新闻的既有投票 */
function myNewsVote(newsId: number): MyVoteItem | undefined {
  return myVotes.value.find((v) => v.targetType === 'NEWS' && v.targetId === newsId);
}

/** 剩余有效期文案 */
function remainText(expiresAt?: string | null): string {
  if (!expiresAt) return '长期';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return '已失效';
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function loadStocks() {
  stocks.value = await apiStockList({});
  stocks.value.forEach((s) => {
    if (!voteForm[s.id]) voteForm[s.id] = { direction: 'UP', multiplier: 1.0 };
  });
}
async function loadMyVotes() {
  myVotes.value = await apiMyVotes();
  // 用我已有的投票回填新闻投票表单，方便改票
  for (const v of myVotes.value) {
    if (v.targetType !== 'NEWS') continue;
    newsVoteForm[v.targetId] = { direction: v.direction, multiplier: v.multiplier };
  }
}

/** 拉取新闻列表（公开接口，自带投票聚合），并为每条新闻初始化投票表单 */
async function loadNews() {
  const res = await apiNewsList({ page: 1, pageSize: 100 });
  newsList.value = res.list;
  for (const n of res.list) {
    if (!newsVoteForm[n.id]) newsVoteForm[n.id] = { direction: 'UP', multiplier: 1.0 };
  }
}

function targetName(id: number) {
  return stockMap.value.get(id)?.name || `股票#${id}`;
}

/** 「我的投票」里的目标显示名 */
function voteTargetLabel(row: MyVoteItem): string {
  if (row.targetType === 'NEWS') {
    const n = newsMap.value.get(row.targetId);
    return n ? `新闻：${n.title}` : `新闻#${row.targetId}`;
  }
  return targetName(row.targetId);
}

async function publish() {
  if (!form.title.trim()) return ElMessage.warning('请填写新闻标题');
  if (!isHttpUrl(form.sourceUrl)) return ElMessage.warning('请填写合法的来源链接（http/https）');
  if (!form.stockIds.length) return ElMessage.warning('请至少选择一个关联角色');
  publishing.value = true;
  try {
    const res = await apiPublishNews({ title: form.title.trim(), sourceUrl: form.sourceUrl.trim(), direction: form.direction, strength: form.strength, stockIds: form.stockIds });
    // pending=true 说明是普通操作员提交，需要管理员审核后才生效
    if (res.pending) {
      ElMessage.success('已提交，等待管理员审核通过后生效');
      tab.value = 'pub';
    } else {
      ElMessage.success('新闻发布成功，已立即生效！');
    }
    form.title = ''; form.sourceUrl = ''; form.stockIds = [];
    loadMyNews();
  } catch { /* 全局提示 */ } finally { publishing.value = false; }
}

async function submitStockVote(s: Stock) {
  const v = voteForm[s.id];
  try {
    await apiVoteStock(s.id, v.direction, v.multiplier);
    ElMessage.success(`已投票：${s.name} ${v.direction === 'UP' ? '看涨' : '看跌'} ×${v.multiplier}`);
    loadMyVotes();
  } catch { /* 全局提示 */ }
}

async function submitNewsVote(n: NewsItem) {
  const v = newsVoteForm[n.id];
  try {
    await apiVoteNews(n.id, v.direction, v.multiplier);
    ElMessage.success(`已投票：${n.title} ${v.direction === 'UP' ? '看涨' : '看跌'} ×${v.multiplier}`);
    await Promise.all([loadNews(), loadMyVotes()]);
  } catch { /* 全局提示 */ }
}

onMounted(() => { loadStocks(); loadMyVotes(); loadNews(); loadMyNews(); });
</script>

<style scoped>
.op-page { padding-top: 12px; }
.review-alert { margin-top: 8px; }
.form-tip { font-size: 12px; color: #a08a60; line-height: 1.6; margin-top: 2px; }
.my-news { margin-top: 18px; padding-top: 12px; border-top: 1px dashed var(--ts-card-border); }
.my-news-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.vote-stock-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.vote-card { display: flex; flex-direction: column; gap: 8px; }
.vs-head { display: flex; gap: 10px; align-items: center; }
.vs-name { display: flex; flex-direction: column; }
.vs-name span { font-size: 12px; color: #8a7450; }

/* ---- 新闻投票 ---- */
.vote-news-list { display: flex; flex-direction: column; gap: 10px; }
.vote-news-card { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.vn-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vn-title { font-size: 14px; color: var(--ts-ink); flex: 1 1 260px; }
.vn-expire { font-size: 11px; color: #a08a60; }
.dir-tag { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
.dir-tag.up { background: rgba(176,65,62,0.13); color: var(--ts-up); }
.dir-tag.down { background: rgba(46,125,91,0.13); color: var(--ts-down); }
.vn-stocks { display: flex; gap: 6px; flex-wrap: wrap; }
.vn-stock {
  font-size: 12px; color: var(--ts-gold-dark);
  background: rgba(201,162,75,0.12); border: 1px solid var(--ts-gold-light);
  padding: 1px 8px; border-radius: 999px;
}
.vn-stat { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; color: #8a7450; }
.vn-stat .up { color: var(--ts-up); font-weight: 700; }
.vn-stat .down { color: var(--ts-down); font-weight: 700; }
.vn-muted { color: #b3a17d; }
.vn-mine { color: var(--ts-gold-dark); background: rgba(201,162,75,0.14); padding: 1px 8px; border-radius: 999px; }
.vn-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
</style>
