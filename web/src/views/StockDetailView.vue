<template>
  <div class="page-container">
    <el-skeleton :loading="loading" animated style="margin-top:10px">
      <template #default>
        <template v-if="stock">
          <!-- 停牌 / 退市 提示 -->
          <el-alert
            v-if="stock.status === 0"
            type="warning"
            :closable="false"
            show-icon
            title="该标的已暂停交易（停牌）"
            description="不能下新单，也不参与周期撮合；已有的挂单可以自行撤销。价格仍会随新闻与投票波动。"
            style="margin: 10px 0"
          />
          <el-alert
            v-else-if="stock.status === 2"
            type="error"
            :closable="false"
            show-icon
            title="该标的已退市"
            description="已从行情列表隐藏，无法交易；持仓按退市前最后价格保留。"
            style="margin: 10px 0"
          />

          <!-- 顶部：角色信息 -->
          <div class="ts-card head-card">
            <div class="head-main">
              <StockAvatar :name="stock.name" :avatar-url="stock.avatarUrl" :size="64" />
              <div>
                <div class="row1">
                  <h2 class="sname">{{ stock.name }}</h2>
                  <el-tag effect="plain" size="small">{{ stock.code }}</el-tag>
                  <el-tag v-if="stock.type === 'FUND'" type="warning" effect="plain" size="small">基金</el-tag>
                  <el-tag v-if="stock.status === 0" type="info" effect="plain" size="small">停牌</el-tag>
                  <el-tag v-if="stock.status === 2" type="danger" effect="plain" size="small">已退市</el-tag>
                  <el-icon :class="['watch-btn', { watched: stock.watched }]" @click="toggleWatch">
                    <StarFilled v-if="stock.watched" />
                    <Star v-else />
                  </el-icon>
                  <span class="watch-text">{{ stock.watched ? '已自选' : '加自选' }}</span>
                </div>
                <div class="row2">
                  <span class="price num" :class="changeClass(stock.changePct)">{{ fmtPrice(stock.price) }}</span>
                  <ChangeBadge :value="stock.changePct" suffix="%" />
                  <span class="num" :class="changeClass(stock.change)">{{ fmtSigned(stock.change) }}</span>
                </div>
              </div>
              <div class="head-stats num">
                <div><label>今开</label><b>{{ fmtPrice(stock.open) }}</b></div>
                <div><label>昨收</label><b>{{ fmtPrice(stock.prevClose) }}</b></div>
                <div><label>最高</label><b class="up">{{ fmtPrice(stock.high) }}</b></div>
                <div><label>最低</label><b class="down">{{ fmtPrice(stock.low) }}</b></div>
                <div><label>成交量</label><b>{{ fmtBig(stock.volume) }}</b></div>
                <div><label>流通市值</label><b>{{ fmtBig(stock.marketCap) }}</b></div>
                <div><label>流通股</label><b>{{ fmtBig(stock.totalShares) }}</b></div>
              </div>
            </div>
          </div>

          <div class="detail-grid">
            <!-- 左：K线 + 盘口 -->
            <div class="left-col">
              <div class="ts-card">
                <div class="chart-head">
                  <h3 class="ts-title">K线走势</h3>
                  <el-radio-group v-model="period" size="small" @change="loadKline">
                    <el-radio-button :value="cyclePeriod">{{ sysStore.cycleMinutes }}分钟</el-radio-button>
                    <el-radio-button value="1d">日K</el-radio-button>
                  </el-radio-group>
                </div>
                <KLineChart :data="klineData" :loading="klineLoading" :period-label="period" />
              </div>

              <!-- 基金成分股（仅指数基金） -->
              <div v-if="stock?.type === 'FUND'" class="ts-card">
                <div class="chart-head">
                  <h3 class="ts-title">🧺 基金成分股</h3>
                  <span class="fund-nav num">
                    净值 {{ fmtPrice(stock.nav ?? 0) }}
                    <span class="sep">·</span>
                    溢价
                    <b :class="changeClass(stock.premiumPct ?? 0)">{{ fmtSigned(stock.premiumPct ?? 0, '%') }}</b>
                  </span>
                </div>
                <el-table :data="stock.constituents ?? []" size="small" style="width:100%">
                  <el-table-column label="角色" min-width="170">
                    <template #default="{ row }">
                      <div class="cell-stock">
                        <StockAvatar :name="row.name" :avatar-url="row.avatarUrl" :size="30" />
                        <div>
                          <div class="c-name">
                            <router-link v-if="!row.delisted" :to="`/stock/${row.id}`" class="c-link">{{ row.name }}</router-link>
                            <span v-else class="c-delisted">{{ row.name }}</span>
                          </div>
                          <div class="c-code">{{ row.code || '-' }}</div>
                        </div>
                      </div>
                    </template>
                  </el-table-column>
                  <el-table-column label="现价" align="right" width="110">
                    <template #default="{ row }"><span class="num">{{ row.delisted ? '—' : fmtPrice(row.price) }}</span></template>
                  </el-table-column>
                  <el-table-column label="涨跌" align="right" width="110">
                    <template #default="{ row }">
                      <span class="num" :class="changeClass(row.changePct)">{{ row.delisted ? '—' : fmtSigned(row.changePct, '%') }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column label="权重" align="right" width="100">
                    <template #default="{ row }"><span class="num">{{ row.weightPct }}%</span></template>
                  </el-table-column>
                </el-table>
                <p class="fund-tip">
                  买入本基金会把买盘压力<b>按权重传导</b>给上述角色（拉动成分股上涨）；反过来，成分股涨跌也会通过净值影响本基金价格。
                </p>
              </div>

              <!-- 盘口（买卖挂单聚合） -->
              <div class="ts-card depth-card">
                <h3 class="ts-title">委托盘口（未成交挂单）</h3>
                <div class="depth">
                  <div class="depth-col sell">
                    <div class="depth-row head-row"><span>卖价</span><span>数量(股)</span></div>
                    <div v-for="(l, i) in orderBook.asks" :key="'a' + i" class="depth-row">
                      <span class="num up">{{ fmtPrice(l.price) }}</span><span class="num">{{ fmtBig(l.qty) }}</span>
                    </div>
                    <div v-if="!orderBook.asks.length" class="empty">暂无卖单</div>
                  </div>
                  <div class="depth-mid num">现价 {{ fmtPrice(orderBook.price) }}</div>
                  <div class="depth-col buy">
                    <div class="depth-row head-row"><span>买价</span><span>数量(股)</span></div>
                    <div v-for="(l, i) in orderBook.bids" :key="'b' + i" class="depth-row">
                      <span class="num down">{{ fmtPrice(l.price) }}</span><span class="num">{{ fmtBig(l.qty) }}</span>
                    </div>
                    <div v-if="!orderBook.bids.length" class="empty">暂无买单</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右：交易面板 + 新闻 -->
            <div class="right-col">
              <div class="ts-card trade-card">
                <h3 class="ts-title">交易委托</h3>
                <template v-if="store.isLoggedIn">
                  <TradePanel
                    :stock-id="stock.id"
                    :current-price="stock.price"
                    :mora="mora"
                    :available-shares="availableShares"
                    :sellable-shares="sellableShares"
                    :locked-shares="lockedShares"
                    :unlock-at="unlockAt"
                    :stock-status="stock.status"
                    @done="refreshAfterTrade"
                  />
                </template>
                <div v-else class="login-hint">
                  <el-icon :size="26"><Lock /></el-icon>
                  <p>登录后即可挂单买卖角色股票</p>
                  <el-button type="primary" plain @click="router.push({ name: 'login', query: { redirect: route.fullPath } })">
                    去登录 / 注册
                  </el-button>
                </div>
              </div>

              <div class="ts-card">
                <h3 class="ts-title">相关新闻 · 引用</h3>
                <div v-if="!newsList.length" class="empty">暂无相关新闻（等待操作员发布）</div>
                <div v-for="n in newsList" :key="n.id" class="news-item">
                  <div class="news-top">
                    <span class="dir-tag" :class="n.direction.toLowerCase()">
                      {{ n.direction === 'UP' ? '看涨' : '看跌' }} {{ n.strength }}
                    </span>
                    <a
                      v-if="n.sourceUrl"
                      class="news-title-link"
                      :href="n.sourceUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <b>{{ n.title }}</b>
                      <el-icon class="news-ext"><TopRight /></el-icon>
                    </a>
                    <b v-else>{{ n.title }}</b>
                  </div>
                  <p v-if="n.content" class="news-content">{{ n.content }}</p>
                  <div v-if="n.sourceUrl" class="news-source">
                    <span class="news-muted">来源：</span>
                    <a :href="n.sourceUrl" target="_blank" rel="noopener noreferrer">{{ n.sourceUrl }}</a>
                  </div>
                  <div class="news-meta">
                    <span>{{ n.publisher || '操作员' }}</span>
                    <span>{{ fmtTime(n.createdAt) }}</span>
                    <span v-if="n.votes">投票 {{ n.votes.total }} · 均倍率 {{ n.votes.avgMult }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
        <el-empty v-else description="未找到该角色股票" />
      </template>
    </el-skeleton>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Lock, Star, StarFilled, TopRight } from '@element-plus/icons-vue';
import type { Stock, KlinePoint, OrderBook, NewsItem, KlinePeriod, HoldingItem } from '@/types';
import { apiStockDetail, apiKline, apiOrderBook, apiStockNews, apiAddWatch, apiRemoveWatch } from '@/api/stocks';
import { apiAccount, apiHoldings } from '@/api/trade';
import { useUserStore } from '@/stores/user';
import { useSystemStore } from '@/stores/system';
import StockAvatar from '@/components/StockAvatar.vue';
import ChangeBadge from '@/components/ChangeBadge.vue';
import KLineChart from '@/components/KLineChart.vue';
import TradePanel from '@/components/TradePanel.vue';
import { fmtBig, fmtPrice, fmtSigned, fmtTime, changeClass } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const store = useUserStore();
const sysStore = useSystemStore();
const stockId = computed(() => Number(route.params.id));

const stock = ref<Stock | null>(null);
const loading = ref(false);
/** 周期 K 线档位跟随后台「撮合周期」设置（如 10m / 2m） */
const cyclePeriod = computed(() => sysStore.klinePeriod);
const period = ref<KlinePeriod>(cyclePeriod.value);

// 管理员改了撮合周期后，若当前正看周期线则自动切到新档位
watch(cyclePeriod, (p) => {
  if (period.value !== '1d') {
    period.value = p;
    loadKline();
  }
});
const klineData = ref<KlinePoint[]>([]);
const klineLoading = ref(false);
const orderBook = ref<OrderBook>({ price: 0, bids: [], asks: [] });
const newsList = ref<NewsItem[]>([]);
const availableShares = ref(0);
/** 当前可卖股数 / 锁仓股数 / 下一批解锁时间（「最少持有周期」限制） */
const sellableShares = ref(0);
const lockedShares = ref(0);
const unlockAt = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const mora = computed(() => store.mora);

async function loadStock() {
  loading.value = true;
  try {
    stock.value = await apiStockDetail(stockId.value);
    if (stock.value) {
      await Promise.all([loadKline(), loadOrderBook(), loadNews(), loadShares()]);
    }
  } catch { /* 全局提示 */ } finally { loading.value = false; }
}

async function loadKline() {
  if (!stockId.value) return;
  klineLoading.value = true;
  try {
    klineData.value = await apiKline(stockId.value, period.value, 200);
  } finally { klineLoading.value = false; }
}

async function loadOrderBook() {
  orderBook.value = await apiOrderBook(stockId.value);
}
async function loadNews() {
  newsList.value = await apiStockNews(stockId.value);
}
async function loadShares() {
  // 未登录不拉取持仓
  if (!store.isLoggedIn) {
    availableShares.value = 0; sellableShares.value = 0; lockedShares.value = 0; unlockAt.value = null;
    return;
  }
  try {
    const holdings = await apiHoldings();
    const h = holdings.find((x: HoldingItem) => x.stockId === stockId.value);
    availableShares.value = h ? h.quantity - h.frozenQuantity : 0;
    // 可卖/锁仓由后端算好（只锁「买入未满最少持有周期」的份额）
    sellableShares.value = h?.sellableQuantity ?? availableShares.value;
    lockedShares.value = h?.lockedQuantity ?? 0;
    unlockAt.value = h?.unlockAt ?? null;
  } catch { /* 全局提示 */ }
}

async function toggleWatch() {
  if (!store.isLoggedIn) {
    ElMessage.info('登录后即可自选');
    router.push({ name: 'login', query: { redirect: route.fullPath } });
    return;
  }
  if (!stock.value) return;
  try {
    if (stock.value.watched) {
      await apiRemoveWatch(stock.value.id);
      stock.value.watched = false;
      ElMessage.success('已移出自选');
    } else {
      await apiAddWatch(stock.value.id);
      stock.value.watched = true;
      ElMessage.success('已加入自选');
    }
  } catch { /* 全局提示 */ }
}

async function refreshAfterTrade() {
  await loadStock();
  await store.fetchMe();
}

// 每 30 秒轻量刷新行情
function startPoll() {
  stopPoll();
  timer = setInterval(() => {
    loadStock();
  }, 30000);
}
function stopPoll() {
  if (timer) { clearInterval(timer); timer = null; }
}

onMounted(() => { loadStock(); startPoll(); });
onBeforeUnmount(stopPoll);
watch(stockId, () => { loadStock(); });
</script>

<style scoped>
.head-card { margin-top: 12px; }
.head-main { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
.row1 { display: flex; align-items: center; gap: 8px; }
.sname { margin: 0; font-size: 24px; color: var(--ts-gold-dark); }
.row2 { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.price { font-size: 30px; font-weight: 800; }
.watch-btn { cursor: pointer; color: #c8b98f; font-size: 20px; margin-left: 6px; }
.watch-btn.watched { color: #c9a24b; }
.watch-text { font-size: 12px; color: var(--ts-ink-soft); }
.head-stats { display: grid; grid-template-columns: repeat(4, auto); gap: 8px 26px; margin-left: auto; }
.head-stats div { display: flex; flex-direction: column; }
.head-stats label { font-size: 11px; color: #a08a60; }
.head-stats b { font-size: 15px; }

.detail-grid {
  margin-top: 12px;
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 12px;
  align-items: start;
}
@media (max-width: 1080px) {
  .detail-grid { grid-template-columns: 1fr; }
  .head-stats { margin-left: 0; grid-template-columns: repeat(4, 1fr); }
}
.left-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.right-col { display: flex; flex-direction: column; gap: 12px; }

.chart-head { display: flex; justify-content: space-between; align-items: center; }

/* ---- 基金成分股 ---- */
.fund-nav { font-size: 13px; color: var(--ts-gold-dark); }
.fund-nav .sep { margin: 0 4px; color: #c8b58a; }
.cell-stock { display: flex; align-items: center; gap: 8px; }
.c-name { font-size: 13px; font-weight: 600; }
.c-code { font-size: 11px; color: #a08a60; }
.c-link { color: var(--ts-gold-dark); text-decoration: none; }
.c-link:hover { text-decoration: underline; }
.c-delisted { color: #b3a17d; }
.fund-tip { margin: 8px 0 0; font-size: 11px; color: #a08a60; line-height: 1.8; }
.kind-tag { margin-left: 6px; vertical-align: middle; }

.depth-card { padding-top: 10px; }
.depth { display: grid; grid-template-columns: 1fr 74px 1fr; gap: 8px; }
.depth-row { display: flex; justify-content: space-between; padding: 3px 6px; font-size: 13px; border-radius: 4px; }
.depth-row:nth-child(odd) { background: rgba(0, 0, 0, 0.02); }
.head-row { background: rgba(0, 0, 0, 0.04) !important; font-size: 11px; color: #8a7450; }
.depth-mid { align-self: center; text-align: center; font-size: 12px; font-weight: 700; color: var(--ts-gold-dark); }
.empty { color: #bfae8c; font-size: 12px; text-align: center; padding: 6px; }

.trade-card { position: sticky; top: 68px; }
.login-hint { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 8px; color: var(--ts-ink-soft); }
.login-hint p { margin: 0; font-size: 13px; }

.news-item { border-bottom: 1px dashed #e2d4ae; padding: 10px 0; }
.news-item:last-child { border-bottom: none; }
.news-top { display: flex; align-items: center; gap: 8px; }
.dir-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; white-space: nowrap; }
.dir-tag.up { background: rgba(176, 65, 62, 0.14); color: var(--ts-up); }
.dir-tag.down { background: rgba(46, 125, 91, 0.14); color: var(--ts-down); }
.news-content { margin: 6px 0; font-size: 13px; color: var(--ts-ink-soft); line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.news-title-link { display: inline-flex; align-items: flex-start; gap: 3px; color: var(--ts-ink); text-decoration: none; min-width: 0; }
.news-title-link:hover { color: var(--ts-gold-dark); text-decoration: underline; text-underline-offset: 3px; }
.news-title-link b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.news-ext { margin-top: 3px; font-size: 13px; flex: none; }
.news-source { margin: 2px 0 4px; font-size: 11px; color: #a08a60; word-break: break-all; }
.news-source a { color: var(--ts-gold-dark); }
.news-muted { color: #b3a17d; }
.news-meta { display: flex; gap: 12px; font-size: 11px; color: #a08a60; flex-wrap: wrap; }
</style>
