<template>
  <div class="ms-panel">
    <!-- 平台筛选（目前只有 NGA，以后接多平台时这里会自动出现更多） -->
    <div class="ms-filter" v-if="platforms.length > 1">
      <el-radio-group v-model="platform" size="small" @change="onFilterChange">
        <el-radio-button label="">全部平台</el-radio-button>
        <el-radio-button v-for="p in platforms" :key="p.platform" :label="p.platform">
          {{ p.name }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <el-skeleton :loading="loading" animated :rows="6" style="margin-top:12px">
      <template #default>
        <div v-if="!list.length && !loading" class="ts-card">
          <el-empty description="暂无已发布的市场情绪，等管理员审核通过后就会出现在这里" />
        </div>

        <div class="ms-cards">
          <article v-for="s in list" :key="s.id" class="ts-card ms-card" :class="s.direction.toLowerCase()">
            <div class="mc-top">
              <span class="mc-platform">
                <span class="mc-plat-dot" />{{ s.platformName || s.platform }}
              </span>
              <span class="dir-tag" :class="s.direction.toLowerCase()">
                {{ s.direction === 'UP' ? '看涨' : '看跌' }}
              </span>
              <b class="mc-title">{{ s.title }}</b>
              <a
                v-if="s.sourceUrl"
                class="mc-link"
                :href="safeUrl(s.sourceUrl)"
                target="_blank"
                rel="noopener noreferrer"
                title="查看来源版面"
              ><el-icon><TopRight /></el-icon></a>
            </div>

            <p v-if="s.summary" class="mc-summary">{{ s.summary }}</p>

            <div class="mc-strength">
              <span class="mc-strength-label">影响强度</span>
              <div class="mc-bar">
                <div class="mc-bar-fill" :style="{ width: Math.min(100, s.strength) + '%' }" />
              </div>
              <span class="num mc-strength-val">{{ s.strength }}</span>
            </div>

            <div class="mc-foot">
              <div class="mc-stocks">
                <router-link
                  v-for="k in s.stocks"
                  :key="k.id"
                  class="mc-stock"
                  :to="`/stock/${k.id}`"
                >{{ k.name }}</router-link>
                <span v-if="!s.stocks?.length" class="mc-muted">未关联角色</span>
              </div>
              <div class="mc-info num">
                <span>{{ s.author }}</span>
                <span>{{ fmtTime(s.fetchedAt) }}</span>
              </div>
            </div>
          </article>
        </div>
      </template>
    </el-skeleton>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { TopRight } from '@element-plus/icons-vue';
import type { MarketSentimentItem } from '@/types';
import { apiSentimentList } from '@/api/sentiment';
import { fmtTime } from '@/utils/format';

/**
 * 市场情绪列表（可嵌入组件）
 *
 * 放在新闻页的「市场情绪」标签页里用 —— 不需要单独的页面入口。
 * 只展示**最近 20 条**（后端已封顶，前端不再翻页）；保留平台筛选。
 */
const list = ref<MarketSentimentItem[]>([]);
const platforms = ref<Array<{ platform: string; name: string }>>([]);
const total = ref<number | null>(null);
const loading = ref(false);
const platform = ref('');
/** 对外只展示最近 20 条（与新闻列表同一口径） */
const LIST_LIMIT = 20;

/** 只放行 http/https，防止 javascript: 等伪协议 */
function safeUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? u : '#';
  } catch {
    return '#';
  }
}

async function load() {
  loading.value = true;
  try {
    // 只取最近 20 条（后端同样封顶；不再支持翻页）
    const res = await apiSentimentList({
      pageSize: LIST_LIMIT,
      platform: platform.value || undefined,
    });
    list.value = res.list;
    total.value = res.total;
    platforms.value = res.platforms ?? [];
  } catch {
    /* 全局提示 */
  } finally {
    loading.value = false;
  }
}

function onFilterChange() {
  load();
}

onMounted(load);
</script>

<style scoped>
.ms-filter { display: flex; justify-content: flex-end; }
.ms-cards { display: flex; flex-direction: column; gap: 10px; }
.ms-card {
  padding: 14px 16px; border-left: 3px solid var(--ts-gold-light);
  transition: border-color .15s, box-shadow .15s;
}
.ms-card.up { border-left-color: var(--ts-up); }
.ms-card.down { border-left-color: var(--ts-down); }
.ms-card:hover { box-shadow: 0 4px 14px rgba(160,130,70,0.12); }

.mc-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mc-platform {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-size: 11px; font-weight: 700; color: #6b5a38;
  background: rgba(201,162,75,0.14); border-radius: 999px; padding: 2px 9px;
}
.mc-plat-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ts-gold); }
.dir-tag { flex: none; font-size: 11px; padding: 2px 9px; border-radius: 999px; font-weight: 700; }
.dir-tag.up { background: rgba(176,65,62,0.13); color: var(--ts-up); }
.dir-tag.down { background: rgba(46,125,91,0.13); color: var(--ts-down); }
.mc-title { font-size: 15px; color: var(--ts-ink); line-height: 1.5; flex: 1; min-width: 200px; }
.mc-link { color: var(--ts-gold-dark); display: inline-flex; align-items: center; }

.mc-summary { margin: 9px 0 0; font-size: 12.5px; color: #8b7752; line-height: 1.8; }
.mc-strength { display: flex; align-items: center; gap: 8px; margin-top: 10px; max-width: 420px; }
.mc-strength-label { font-size: 11px; color: #b3a17d; flex: none; }
.mc-bar { flex: 1; height: 6px; border-radius: 999px; background: rgba(0,0,0,0.06); overflow: hidden; }
.mc-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--ts-gold-light), var(--ts-gold)); }
.ms-card.up .mc-bar-fill { background: linear-gradient(90deg, #e8a3a1, var(--ts-up)); }
.ms-card.down .mc-bar-fill { background: linear-gradient(90deg, #9ecdb8, var(--ts-down)); }
.mc-strength-val { font-size: 11px; color: #8b7752; flex: none; min-width: 20px; text-align: right; }

.mc-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 11px; flex-wrap: wrap; }
.mc-stocks { display: flex; gap: 6px; flex-wrap: wrap; }
.mc-stock {
  font-size: 12px; color: var(--ts-gold-dark); text-decoration: none;
  background: rgba(201,162,75,0.12); border: 1px solid var(--ts-gold-light);
  padding: 1px 8px; border-radius: 999px; transition: all .15s;
}
.mc-stock:hover { background: var(--ts-gold); color: #fff; }
.mc-info { display: flex; gap: 10px; font-size: 11px; color: #a08a60; }
.mc-muted { color: #b3a17d; font-size: 12px; }
.pager { display: flex; justify-content: center; margin-top: 16px; }
</style>
