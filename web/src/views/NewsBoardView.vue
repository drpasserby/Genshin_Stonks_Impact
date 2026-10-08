<template>
  <div class="page-container news-page">
    <!-- 页头 + 板块切换栏 -->
    <div class="ts-card news-head">
      <div class="nh-left">
        <h2 class="nh-title">{{ tabMeta.icon }} {{ tabMeta.title }}</h2>
        <p class="nh-sub">{{ tabMeta.sub }}</p>
      </div>
      <div class="nh-count num" v-if="tab === 'news' && total != null">共 {{ total }} 条（最多显示最近 20 条）</div>
    </div>

    <!-- 板块切换：新闻 / 市场情绪 -->
    <div class="news-tabs">
      <button class="nt-item" :class="{ active: tab === 'news' }" @click="switchTab('news')">
        📰 新闻
      </button>
      <button class="nt-item" :class="{ active: tab === 'sentiment' }" @click="switchTab('sentiment')">
        🌡️ 市场情绪
      </button>
    </div>

    <div v-show="tab === 'news'">
    <!-- 列表 -->
    <el-skeleton :loading="loading" animated :rows="6" style="margin-top:12px">
      <template #default>
        <div v-if="!list.length && !loading" class="ts-card">
          <el-empty description="暂无新闻，等待操作员发布第一条消息吧" />
        </div>

        <div class="news-cards">
          <article v-for="n in list" :key="n.id" class="ts-card news-card">
            <div class="nc-top">
              <span class="dir-tag" :class="n.direction.toLowerCase()">
                {{ n.direction === 'UP' ? '看涨' : '看跌' }} · {{ n.strength }}
              </span>
              <a
                v-if="n.sourceUrl"
                class="nc-title"
                :href="safeUrl(n.sourceUrl)"
                target="_blank"
                rel="noopener noreferrer"
              >{{ n.title }} <el-icon class="nc-ext"><TopRight /></el-icon></a>
              <span v-else class="nc-title">{{ n.title }}</span>
            </div>

            <p v-if="n.content" class="nc-abstract">{{ n.content }}</p>

            <div class="nc-meta">
              <div class="nc-tags">
                <router-link
                  v-for="s in n.stocks"
                  :key="s.id"
                  class="nc-stock"
                  :to="`/stock/${s.id}`"
                >{{ s.name }}</router-link>
                <span v-if="!n.stocks?.length" class="nc-muted">未关联角色</span>
              </div>
              <div class="nc-info num">
                <span v-if="n.publisher">{{ n.publisher }}</span>
                <span>{{ fmtTime(n.createdAt) }}</span>
              </div>
              <div class="nc-votes num" v-if="n.votes">
                <span class="up" title="看涨票">▲{{ n.votes.up }}</span>
                <span class="down" title="看跌票">▼{{ n.votes.down }}</span>
                <span v-if="n.votes.total" class="nc-muted">均倍率 ×{{ n.votes.avgMult }}</span>
                <span v-if="n.votes.score != null" class="nc-muted">影响分 {{ n.votes.score }}</span>
                <span v-else class="nc-muted">暂无投票</span>
              </div>
            </div>

            <div class="nc-source" v-if="n.sourceUrl">
              <span class="nc-muted">来源：</span>
              <a :href="safeUrl(n.sourceUrl)" target="_blank" rel="noopener noreferrer" class="nc-source-link">
                {{ hostOf(n.sourceUrl) }}
              </a>
            </div>
          </article>
        </div>
      </template>
    </el-skeleton>
    </div><!-- /新闻板块 -->

    <!-- ============ 市场情绪板块 ============
         内容来自各玩家社区被自动归纳出的情绪快照，与人工发布的新闻是两条独立数据线。
         首屏不加载，切到该标签页时才挂载（省一次请求）。 -->
    <div v-show="tab === 'sentiment'" class="sentiment-wrap">
      <MarketSentimentPanel v-if="sentimentMounted" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TopRight } from '@element-plus/icons-vue';
import type { NewsItem } from '@/types';
import { apiNewsList } from '@/api/news';
import { fmtTime } from '@/utils/format';
import MarketSentimentPanel from '@/components/MarketSentimentPanel.vue';

/* ---- 板块切换（新闻 / 市场情绪）----
 * 状态有两个载体，优先级从高到低：
 *   ① ?tab= 查询参数 —— 分享链接、从旧地址 /sentiment 跳过来，必须落到指定板块；
 *   ② localStorage     —— 没有参数时，回到上次关页面时停留的那个板块。
 */
type NewsTab = 'news' | 'sentiment';
const route = useRoute();
const router = useRouter();
const TAB_STORE_KEY = 'news_board_tab';

function readSavedTab(): NewsTab | null {
  try {
    const v = localStorage.getItem(TAB_STORE_KEY);
    return v === 'news' || v === 'sentiment' ? v : null;
  } catch {
    return null;
  }
}

const tab = ref<NewsTab>(
  route.query.tab === 'sentiment' || route.query.tab === 'news'
    ? (route.query.tab as NewsTab)
    : readSavedTab() ?? 'news',
);
/** 市场情绪面板要不要挂载（首次切过去才加载数据） */
const sentimentMounted = ref(tab.value === 'sentiment');

const TAB_META: Record<NewsTab, { icon: string; title: string; sub: string }> = {
  news: {
    icon: '📰',
    title: '提瓦特新闻',
    sub: '此处展示的是用户提交的第三方平台引用消息，根据对新闻的投票可影响市场走向，点击标题可跳转查看新闻来源原文。',
  },
  sentiment: {
    icon: '🌡️',
    title: '市场情绪',
    sub: '由在线AI收集来自各社区的讨论情绪并智能总结，社区内的市场情绪会影响市场走向。',
  },
};
const tabMeta = computed(() => TAB_META[tab.value]);

function saveTab(next: NewsTab) {
  try { localStorage.setItem(TAB_STORE_KEY, next); } catch { /* 隐私模式忽略 */ }
}

function switchTab(next: NewsTab) {
  tab.value = next;
  if (next === 'sentiment') sentimentMounted.value = true;
  saveTab(next);
  router.replace({ query: next === 'news' ? {} : { tab: next } });
}

// 浏览器前进/后退时同步板块
watch(() => route.query.tab, (v) => {
  const next: NewsTab = v === 'sentiment' ? 'sentiment' : 'news';
  tab.value = next;
  if (next === 'sentiment') sentimentMounted.value = true;
  saveTab(next);
});

const list = ref<NewsItem[]>([]);
const total = ref<number | null>(null);
/** 对外只展示最近 20 条（后端已封顶，这里保持一致） */
const LIST_LIMIT = 20;
const loading = ref(false);

/** 只放行 http/https，防止 javascript: 等伪协议 */
function safeUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? u : '#';
  } catch {
    return '#';
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
}

async function load() {
  loading.value = true;
  try {
    // 只取最近 20 条（后端同样封顶；不再支持翻页）
    const res = await apiNewsList({ pageSize: LIST_LIMIT });
    list.value = res.list;
    total.value = res.total;
  } catch {
    /* 全局提示 */
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.news-page { padding-top: 12px; }
.news-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.nh-title { margin: 0; color: var(--ts-gold-dark); font-size: 20px; }
.nh-sub { margin: 4px 0 0; font-size: 13px; color: var(--ts-ink-soft); }
.nh-count { font-size: 13px; color: var(--ts-ink-soft); background: rgba(201,162,75,0.12); padding: 4px 10px; border-radius: 999px; }

/* 板块切换栏：胶囊式分段控件，和站点金色主题一致 */
.news-tabs {
  display: inline-flex; gap: 4px; margin-top: 12px; padding: 4px;
  background: rgba(201,162,75,0.10); border: 1px solid var(--ts-card-border);
  border-radius: 999px;
}
.nt-item {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  font-size: 13.5px; font-weight: 600; color: #8b7752;
  padding: 6px 16px; border-radius: 999px; line-height: 1.2;
  transition: background .15s, color .15s, box-shadow .15s;
}
.nt-item:hover { color: var(--ts-gold-dark); background: rgba(201,162,75,0.14); }
.nt-item.active {
  background: var(--ts-gold); color: #fff;
  box-shadow: 0 2px 8px rgba(160,130,70,0.28);
}
.sentiment-wrap { margin-top: 12px; }

.news-cards { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.news-card { padding: 12px 16px; }
.nc-top { display: flex; align-items: flex-start; gap: 10px; }
.nc-title {
  font-size: 15px; font-weight: 700; color: var(--ts-ink);
  text-decoration: none; line-height: 1.5;
  display: inline-flex; align-items: flex-start; gap: 4px;
  transition: color .15s;
}
.nc-title:hover { color: var(--ts-gold-dark); text-decoration: underline; text-underline-offset: 3px; }
.nc-ext { margin-top: 2px; font-size: 13px; }
.dir-tag {
  flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px;
  font-weight: 700; margin-top: 1px;
}
.dir-tag.up { background: rgba(176,65,62,0.13); color: var(--ts-up); }
.dir-tag.down { background: rgba(46,125,91,0.13); color: var(--ts-down); }
.nc-abstract {
  margin: 8px 0 0; font-size: 12px; color: #a08a60; line-height: 1.7;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.nc-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.nc-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.nc-stock {
  font-size: 12px; color: var(--ts-gold-dark); text-decoration: none;
  background: rgba(201,162,75,0.12); border: 1px solid var(--ts-gold-light);
  padding: 1px 8px; border-radius: 999px; transition: all .15s;
}
.nc-stock:hover { background: var(--ts-gold); color: #fff; }
.nc-info { display: flex; gap: 10px; font-size: 11px; color: #a08a60; }
.nc-votes { display: flex; gap: 8px; align-items: center; font-size: 11px; }
.nc-votes .up { color: var(--ts-up); font-weight: 700; }
.nc-votes .down { color: var(--ts-down); font-weight: 700; }
.nc-source { margin-top: 8px; font-size: 12px; border-top: 1px dashed #e2d4ae; padding-top: 8px; }
.nc-source-link { color: var(--ts-gold-dark); text-decoration: none; word-break: break-all; }
.nc-source-link:hover { text-decoration: underline; }
.nc-muted { color: #b3a17d; font-size: 12px; }
.pager { display: flex; justify-content: center; margin-top: 16px; }
</style>
