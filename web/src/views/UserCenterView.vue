<template>
  <div class="page-container">
    <div class="assets ts-card">
      <div class="asset-item">
        <label>总资产（摩拉）</label>
        <b class="num big">{{ fmtNumber(account?.totalAssets) }}</b>
      </div>
      <div class="asset-item">
        <label>可用资金</label>
        <b class="num">{{ fmtNumber(account?.mora) }}</b>
      </div>
      <div class="asset-item">
        <label>冻结资金（挂单）</label>
        <b class="num">{{ fmtNumber(account?.frozenMora) }}</b>
      </div>
      <div class="asset-item">
        <label>持仓市值</label>
        <b class="num">{{ fmtNumber(account?.marketValue) }}</b>
      </div>
      <div class="asset-item">
        <label>持仓盈亏（未实现）</label>
        <b class="num" :class="changeClass(account?.holdingProfit)">{{ fmtSigned(account?.holdingProfit) }}</b>
      </div>
      <div class="asset-item">
        <label>累计平仓盈亏（已实现）</label>
        <b class="num" :class="changeClass(account?.realizedProfit)">{{ fmtSigned(account?.realizedProfit) }}</b>
      </div>
      <div class="asset-item">
        <label>交易总盈亏</label>
        <b class="num" :class="changeClass(account?.tradingProfit)">{{ fmtSigned(account?.tradingProfit) }}</b>
        <small class="asset-note">= 已实现 + 未实现</small>
      </div>
    </div>

    <!-- 明星提示：强制公开持仓（身份组自带，无法关闭） -->
    <el-alert
      v-if="store.holdsPublic"
      class="star-alert"
      type="warning"
      :closable="false"
      show-icon
      title="你是「明星」身份组：持仓强制公开"
      description="他人可以在「明星持仓」页看到你的标的、股数、市值与占总资产比例（不含成本价与盈亏，也不含现金余额）。该公开由身份组决定，无法自行关闭。"
    />

    <!-- 排行榜参与开关：只决定「显示 / 不显示」，不影响交易与资产 -->
    <div class="ts-card rank-opt" style="margin-top:12px">
      <div class="rank-opt-text">
        <b>排行榜参与</b>
        <small v-if="store.holdsPublic">
          明星身份组<b>强制参与</b>排行榜（既然是公开身份，就不该在榜上隐身），该开关无法关闭。
        </small>
        <small v-else>
          开启后，你的<b>昵称</b>与<b>总资产</b>会出现在
          <router-link to="/rank">排行榜</router-link>
          里（总资产 = 可用摩拉 + 挂单冻结摩拉 + 持仓市值；只显示昵称与金额，<b>不显示用户 ID</b>）；关闭后完全不上榜。
        </small>
      </div>
      <el-switch
        v-model="rankOptIn"
        :loading="rankSaving"
        :disabled="store.holdsPublic"
        active-text="参与"
        inactive-text="不参与"
        inline-prompt
        @change="onRankOptInChange"
      />
    </div>

    <div class="ts-card" style="margin-top:12px">
      <el-tabs v-model="tab">
        <el-tab-pane label="持仓" name="holdings">
          <el-table :data="holdings" style="width:100%" size="large">
            <el-table-column label="角色" min-width="180">
              <template #default="{ row }">
                <div class="cell-stock" :class="{ delisted: row.delisted }" @click="row.delisted ? undefined : goStock(row.stockId)">
                  <StockAvatar :name="row.name" :avatar-url="row.avatarUrl" />
                  <div>
                    <div class="n bold">{{ row.name }}</div>
                    <div class="c">{{ row.delisted ? '角色已下架' : row.code }}</div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="持仓 / 冻结 / 锁仓" align="right" min-width="150">
              <template #default="{ row }">
                <span class="num">{{ row.quantity }}<small v-if="row.frozenQuantity"> / {{ row.frozenQuantity }}冻</small><small v-if="row.lockedQuantity" class="lock"> / {{ row.lockedQuantity }}锁</small></span>
                <div v-if="row.lockedQuantity" class="cell-sub">
                  可卖 {{ row.sellableQuantity ?? 0 }}<template v-if="row.unlockAt">，{{ fmtTime(row.unlockAt) }} 起解锁</template>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="成本价" align="right">
              <template #default="{ row }"><span class="num">{{ fmtPrice(row.avgCost) }}</span></template>
            </el-table-column>
            <el-table-column label="现价" align="right">
              <template #default="{ row }"><span class="num">{{ row.delisted ? '—' : fmtPrice(row.price) }}</span></template>
            </el-table-column>
            <el-table-column label="市值" align="right">
              <template #default="{ row }"><span class="num">{{ fmtNumber(row.marketValue) }}</span></template>
            </el-table-column>
            <el-table-column label="浮动盈亏" align="right" width="150">
              <template #default="{ row }">
                <span :class="changeClass(row.profit)"><b class="num">{{ fmtSigned(row.profit) }}</b></span>
                <div :class="changeClass(row.profitPct)" class="num small-pct">{{ fmtSigned(row.profitPct, '%') }}</div>
              </template>
            </el-table-column>
            <el-table-column label="" width="80" align="center">
              <template #default="{ row }">
                <template v-if="row.delisted">
                  <el-tooltip content="该角色已被管理员下架，无法交易" placement="top">
                    <el-tag size="small" type="info" effect="plain">不可交易</el-tag>
                  </el-tooltip>
                </template>
                <template v-else>
                  <el-button size="small" type="primary" plain @click="quickTrade(row, 'BUY')">买</el-button>
                  <el-button size="small" type="danger" plain @click="quickTrade(row, 'SELL')">卖</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!holdings.length" description="暂无持仓，去行情页挑一只喜欢的角色吧" />
        </el-tab-pane>

        <el-tab-pane label="委托单" name="orders">
          <el-table :data="orders" style="width:100%">
            <el-table-column label="角色" min-width="140">
              <template #default="{ row }"><span>{{ row.stockName }} <small class="c">{{ row.stockCode }}</small></span></template>
            </el-table-column>
            <el-table-column label="方向" width="70">
              <template #default="{ row }">
                <el-tag :type="row.side === 'BUY' ? 'danger' : 'success'" size="small" effect="plain">
                  {{ row.side === 'BUY' ? '买入' : '卖出' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="90">
              <template #default="{ row }">{{ row.type === 'MARKET' ? '市价' : '限价' }}</template>
            </el-table-column>
            <el-table-column label="价格" align="right">
              <template #default="{ row }"><span class="num">{{ row.price == null ? '市价' : fmtPrice(row.price) }}</span></template>
            </el-table-column>
            <el-table-column label="数量" align="right">
              <template #default="{ row }"><span class="num">{{ row.quantity }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="时间" min-width="140">
              <template #default="{ row }"><span class="num">{{ fmtTime(row.createdAt) }}</span></template>
            </el-table-column>
            <el-table-column width="80" align="center">
              <template #default="{ row }">
                <el-button v-if="row.status === 'PENDING'" size="small" @click="cancelOrder(row)">撤单</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!orders.length" description="暂无委托记录" />
        </el-tab-pane>

        <el-tab-pane label="成交记录" name="trades">
          <el-table :data="trades" style="width:100%">
            <el-table-column label="角色" min-width="140">
              <template #default="{ row }"><span>{{ row.stockName }} <small class="c">{{ row.stockCode }}</small></span></template>
            </el-table-column>
            <el-table-column label="方向" width="70">
              <template #default="{ row }">
                <el-tag :type="row.side === 'BUY' ? 'danger' : 'success'" size="small" effect="plain">
                  {{ row.side === 'BUY' ? '买入' : '卖出' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="成交价" align="right">
              <template #default="{ row }"><span class="num">{{ fmtPrice(row.price) }}</span></template>
            </el-table-column>
            <el-table-column label="数量" align="right">
              <template #default="{ row }"><span class="num">{{ row.quantity }}</span></template>
            </el-table-column>
            <el-table-column label="金额(摩拉)" align="right">
              <template #default="{ row }"><span class="num">{{ fmtNumber(row.amount) }}</span></template>
            </el-table-column>
            <el-table-column label="印花税" align="right" min-width="110">
              <template #default="{ row }">
                <span v-if="row.fee > 0" class="num fee">-{{ fmtNumber(row.fee) }}</span>
                <span v-else class="num flat-txt">—</span>
              </template>
            </el-table-column>
            <el-table-column label="实际到账" align="right" min-width="120">
              <template #default="{ row }">
                <span class="num">{{ row.side === 'SELL' ? fmtNumber(row.netAmount) : '—' }}</span>
              </template>
            </el-table-column>
            <!-- 平仓盈亏：只有卖出才有；口径 = 到账 − 该笔份额的成本（税后，与持仓页成本价同口径） -->
            <el-table-column label="平仓盈亏" align="right" min-width="140">
              <template #default="{ row }">
                <template v-if="row.side === 'SELL'">
                  <b class="num" :class="changeClass(row.realizedProfit)">
                    {{ row.realizedProfit > 0 ? '+' : '' }}{{ fmtNumber(row.realizedProfit) }}
                  </b>
                  <div class="cell-sub num">
                    成本 {{ fmtNumber(row.costAmount) }}
                    · {{ row.costAmount > 0 ? fmtSigned(((row.realizedProfit / row.costAmount) * 100), '%') : '—' }}
                  </div>
                </template>
                <span v-else class="num flat-txt">—</span>
              </template>
            </el-table-column>
            <el-table-column label="成交时间" min-width="150">
              <template #default="{ row }"><span class="num">{{ fmtTime(row.matchedAt) }}</span></template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!trades.length" description="暂无成交记录" />
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 快速下单抽屉 -->
    <el-drawer v-model="drawer.show" :title="drawer.title" size="360px">
      <TradePanel
        v-if="drawer.stockId"
        :stock-id="drawer.stockId"
        :current-price="drawer.price"
        :mora="account?.mora ?? 0"
        :available-shares="drawer.available"
        :sellable-shares="drawer.sellable"
        :locked-shares="drawer.locked"
        :unlock-at="drawer.unlockAt"
        @done="reloadAll"
      />
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { AccountSummary, HoldingItem, OrderItem, TradeItem } from '@/types';
import { apiAccount, apiHoldings, apiMyOrders, apiTrades, apiCancelOrder } from '@/api/trade';
import { apiSetRankOptIn } from '@/api/rank';
import { useUserStore } from '@/stores/user';
import StockAvatar from '@/components/StockAvatar.vue';
import TradePanel from '@/components/TradePanel.vue';
import { fmtBig, fmtNumber, fmtPrice, fmtSigned, fmtTime, changeClass } from '@/utils/format';

const router = useRouter();
const store = useUserStore();
const tab = ref('holdings');
const account = ref<AccountSummary | null>(null);
const holdings = ref<HoldingItem[]>([]);
const orders = ref<OrderItem[]>([]);
const trades = ref<TradeItem[]>([]);
/** 是否参与排行榜（用户中心开关，默认参与；与 store.user.rankOptIn 同步） */
const rankOptIn = ref(store.user?.rankOptIn !== false);
const rankSaving = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const drawer = reactive<{
  show: boolean; stockId: number | null; price: number; available: number; title: string;
  /** 最少持有周期：可卖 / 锁仓 / 下一批解锁时间 */
  sellable: number; locked: number; unlockAt: string | null;
}>({
  show: false, stockId: null, price: 0, available: 0, title: '',
  sellable: 0, locked: 0, unlockAt: null,
});

async function load() {
  account.value = await apiAccount();
  holdings.value = await apiHoldings();
  orders.value = await apiMyOrders();
  const t = await apiTrades({ page: 1, pageSize: 100 });
  trades.value = t.list;
}

async function reloadAll() {
  await load();
  await store.fetchMe();
  drawer.show = false;
}

function goStock(id: number) { router.push(`/stock/${id}`); }
function quickTrade(row: HoldingItem, side: 'BUY' | 'SELL') {
  drawer.stockId = row.stockId;
  drawer.price = row.price;
  drawer.available = side === 'SELL' ? row.quantity - row.frozenQuantity : 0;
  // 可卖/锁仓由后端给出（最少持有周期）
  drawer.sellable = side === 'SELL' ? (row.sellableQuantity ?? drawer.available) : 0;
  drawer.locked = side === 'SELL' ? (row.lockedQuantity ?? 0) : 0;
  drawer.unlockAt = side === 'SELL' ? (row.unlockAt ?? null) : null;
  drawer.title = `${row.name} · ${side === 'BUY' ? '买入' : '卖出'}`;
  drawer.show = true;
}

async function cancelOrder(row: OrderItem) {
  try {
    await apiCancelOrder(row.id);
    ElMessage.success('撤单成功');
    reloadAll();
  } catch { /* 全局提示 */ }
}

/** 切换「是否参与排行榜」；失败时把开关回滚，避免界面与后端不一致。明星会被后端拒绝（强制参与） */
async function onRankOptInChange(val: string | number | boolean) {
  const next = !!val;
  if (store.holdsPublic && !next) {
    // 明星强制参与：连请求都不发，直接说明原因并回滚
    ElMessage.warning('明星身份组强制公开参与排行榜，无法关闭');
    rankOptIn.value = true;
    return;
  }
  rankSaving.value = true;
  try {
    const res = await apiSetRankOptIn(next);
    rankOptIn.value = !!res.rankOptIn;
    if (store.user) store.user.rankOptIn = res.rankOptIn;
    ElMessage.success(res.forced ? '明星身份已自动参与排行榜' : (res.rankOptIn ? '已参与排行榜' : '已退出排行榜'));
  } catch {
    rankOptIn.value = !next;
  } finally {
    rankSaving.value = false;
  }
}

function statusText(s: string) {
  return { PENDING: '挂单中', FILLED: '已成交', CANCELLED: '已撤单' }[s] || s;
}

function statusType(s: string) {
  return { PENDING: 'warning', FILLED: 'success', CANCELLED: 'info' }[s] as 'warning' | 'success' | 'info';
}

onMounted(() => {
  rankOptIn.value = store.user?.rankOptIn !== false;
  load();
  timer = setInterval(load, 45000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.assets {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.asset-item { display: flex; flex-direction: column; gap: 2px; }
.star-alert { margin-top: 12px; }
.asset-item label { font-size: 12px; color: #a08a60; }
.asset-item b { font-size: 17px; }
.asset-item .big { font-size: 22px; color: var(--ts-gold-dark); }
.cell-stock { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.cell-stock.delisted { cursor: default; opacity: 0.6; }
.n { font-weight: 600; }
.c { color: #a08a60; font-size: 11px; }
.bold { font-weight: 700; }
.rank-opt {
  display: flex; align-items: center; gap: 16px;
  justify-content: space-between; flex-wrap: wrap;
}
.rank-opt-text { display: flex; flex-direction: column; gap: 4px; min-width: 240px; flex: 1; }
.rank-opt-text b { font-size: 14px; color: var(--ts-gold-dark); }
.rank-opt-text small { font-size: 12px; color: #a08a60; line-height: 1.8; }
.rank-opt-text a { color: var(--ts-gold-dark); }
.fee { color: #c0392b; }
.flat-txt { color: #bba98a; }
.lock { color: #b8860b; }
.asset-note { font-size: 10px; color: #bba98a; }
.small-pct { font-size: 11px; }
</style>
