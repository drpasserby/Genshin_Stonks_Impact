<template>
  <div class="trade-panel">
    <el-alert
      v-if="!tradingEnabled"
      type="error"
      :closable="false"
      show-icon
      :title="Number(stockStatus ?? 1) === 1 ? '系统暂停交易中' : '该标的暂不可交易'"
      :description="disabledReason"
      style="margin-bottom: 10px"
    />
    <el-segmented v-model="side" :options="[{ label: '买入', value: 'BUY' }, { label: '卖出', value: 'SELL' }]" block size="large" :disabled="!tradingEnabled" />
    <div class="tax-tip num">
      <template v-if="taxExempt">
        🎖️ <b>高级用户</b>免卖方印花税：卖出按成交额全额到账（普通用户按 <b>{{ sysStore.stampTaxLabel }}</b> 收取）；买入不收。
      </template>
      <template v-else>
        卖出按成交额收 <b>{{ sysStore.stampTaxLabel }}</b> 印花税（直接从到账金额里扣除）；买入不收。
      </template>
    </div>

    <el-form label-position="top" class="tp-form">
      <el-form-item label="委托方式">
        <el-radio-group v-model="orderType" :disabled="!tradingEnabled">
          <el-radio-button value="MARKET">市价单</el-radio-button>
          <el-radio-button value="LIMIT">限价单</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item v-if="orderType === 'LIMIT'" label="委托价格（摩拉）">
        <el-input-number v-model="price" :min="0.0001" :max="1e9" :precision="4" :step="1" style="width:100%" :disabled="!tradingEnabled" />
        <div class="hint num">当前价 {{ fmtPrice(currentPrice) }} · 限价规则：买价≥现价或卖价≤现价即成交</div>
      </el-form-item>

      <el-form-item label="委托数量（股）">
        <el-input-number v-model="quantity" :min="1" :max="maxQty" :step="100" style="width:100%" :disabled="!tradingEnabled" />
        <div class="hint">
          可用：{{ side === 'BUY' ? `${fmtBig(mora)} 摩拉` : `${sellableNow} 股` }}
          <el-button link type="primary" size="small" :disabled="!tradingEnabled" @click="maxFill">最大</el-button>
        </div>
        <div v-if="side === 'SELL' && holdLimited" class="hint lock-hint">
          🔒 另有 <b>{{ lockedNow }}</b> 股在锁仓中（买入未满 {{ sysStore.minHoldCycles }} 个周期 ≈ {{ sysStore.holdLockLabel }}）<template v-if="unlockText">，最早 <b>{{ unlockText }}</b> 解锁</template>
        </div>
      </el-form-item>

      <el-button type="primary" size="large" class="w-full" :disabled="!tradingEnabled" :loading="submitting" @click="submit">
        {{ side === 'BUY' ? '确认买入' : '确认卖出' }}
      </el-button>
      <div v-if="estAmount > 0" class="est num">
        <template v-if="side === 'SELL'">
          预计成交额：<b>{{ fmtPrice(estAmount) }}</b> 摩拉<br />
          <template v-if="taxExempt">
            卖方印花税：<b>免（高级用户）</b> －<b>0.00</b> 摩拉<br />
          </template>
          <template v-else>
            卖方印花税 {{ sysStore.stampTaxLabel }}：－<b>{{ fmtPrice(estFee) }}</b> 摩拉<br />
          </template>
          实际到账：<b class="net">{{ fmtPrice(estNet) }}</b> 摩拉
        </template>
        <template v-else>
          预计金额：<b>{{ fmtPrice(estAmount) }}</b> 摩拉
        </template>
        <div class="est-note">{{ orderType === 'LIMIT' ? '限价按现价成交，实际可能更低' : '市价单按当前价立即成交' }}</div>
      </div>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Side, OrderType } from '@/types';
import { apiPlaceOrder } from '@/api/trade';
import { fmtBig, fmtPrice } from '@/utils/format';
import { useSystemStore } from '@/stores/system';
import { useUserStore } from '@/stores/user';

const sysStore = useSystemStore();
const store = useUserStore();

const props = defineProps<{
  stockId: number;
  currentPrice: number;
  mora: number;
  availableShares: number;
  /** 当前可卖股数（已扣除「最少持有周期」锁仓部分；不传则退回 availableShares） */
  sellableShares?: number;
  /** 锁仓中的股数（未满最少持有周期） */
  lockedShares?: number;
  /** 下一批解锁时间（ISO 字符串） */
  unlockAt?: string | null;
  /** 单标的状态：1正常 0停牌 2退市；非 1 时禁止下单 */
  stockStatus?: number;
}>();

/** 全局开关 + 单标的状态，任一不允许就不能交易 */
const tradingEnabled = computed(() =>
  sysStore.tradingEnabled && Number(props.stockStatus ?? 1) === 1
);
const disabledReason = computed(() => {
  const st = Number(props.stockStatus ?? 1);
  if (st === 0) return '该标的已暂停交易（停牌中），暂时无法下单';
  if (st === 2) return '该标的已退市，无法交易';
  if (!sysStore.tradingEnabled) return '系统暂停交易中，买卖/挂单/撤单均不可用';
  return '';
});
const emit = defineEmits<{ (e: 'done'): void }>();

const side = ref<Side>('BUY');
const orderType = ref<OrderType>('MARKET');
const price = ref<number | undefined>(undefined);
const quantity = ref(100);
const submitting = ref(false);

const maxQty = computed(() => {
  if (side.value === 'SELL') return Math.max(1, sellableNow.value);
  if (orderType.value === 'MARKET') {
    return Math.max(1, Math.floor(props.mora / (props.currentPrice || 1)));
  }
  return Math.max(1, Math.floor(props.mora / ((price.value ?? props.currentPrice) || 1)));
});

/* ---- 最少持有周期（锁仓）信息 ---- */
/** 当前真正能卖的股数 */
const sellableNow = computed(() =>
  props.sellableShares == null ? Math.max(0, props.availableShares || 0) : Math.max(0, props.sellableShares)
);
const lockedNow = computed(() => Math.max(0, Number(props.lockedShares) || 0));
/** 下一批解锁时间（HH:mm） */
const unlockText = computed(() => {
  if (!props.unlockAt) return '';
  const d = new Date(props.unlockAt);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
});
/** 是否处于"有份额被锁"的状态（用于提示与拦截文案） */
const holdLimited = computed(() => sysStore.minHoldCycles > 0 && lockedNow.value > 0);

const estAmount = computed(() => {
  const p = orderType.value === 'MARKET' ? props.currentPrice : (price.value ?? props.currentPrice);
  return p * (quantity.value || 0);
});

/* ---- 卖方印花税：仅卖出收取，预估按当前税率算（实际以成交时后端计算为准） ----
 * ★ 高级用户（vip）免印花税：税率按 0 算，与后端 executeSell 的口径保持一致。 */
const taxExempt = computed(() => store.stampTaxExempt);
const estFee = computed(() => (side.value === 'SELL' && !taxExempt.value ? estAmount.value * sysStore.stampTaxRate : 0));
const estNet = computed(() => estAmount.value - estFee.value);

function maxFill() {
  quantity.value = Math.min(Math.max(maxQty.value, 1), 1000000);
}
function clampQty() {
  quantity.value = Math.max(1, Math.min(quantity.value || 1, Math.max(maxQty.value, 1)));
}

// 切换模式时同步限价初值；不监听 currentPrice，避免覆盖用户输入
watch([side, orderType], () => {
  price.value = orderType.value === 'LIMIT' ? (price.value ?? props.currentPrice) : undefined;
  clampQty();
});

watch(() => props.mora, clampQty);

async function submit() {
  if (!tradingEnabled.value) {
    ElMessage.warning('系统暂停交易中，暂不可下单');
    return;
  }
  if (!props.stockId) return;
  if (orderType.value === 'LIMIT' && !(price.value! > 0)) {
    ElMessage.warning('请设置限价');
    return;
  }
  const qty = quantity.value || 1;
  if (side.value === 'SELL' && qty > sellableNow.value) {
    // 持仓够、但被「最少持有周期」锁住 → 按需求原文提示
    if (qty <= (props.availableShares || 0) && holdLimited.value) {
      ElMessage.error(`该份额持有周期过短，不得卖出。请在买入${sysStore.minHoldCycles}个周期后卖出`);
    } else {
      ElMessage.warning('可卖股数不足');
    }
    return;
  }
  const kind = side.value === 'BUY' ? '买入' : '卖出';
  const modeText = orderType.value === 'MARKET' ? '市价' : `限价 ${fmtPrice(price.value!)}`;
  // 确认弹窗文案：卖出时把印花税与实际到账都写清楚（避免玩家以为被多扣了钱）
  const taxText = side.value === 'SELL'
    ? (taxExempt.value
        ? `；高级用户免卖方印花税，实际到账 ${fmtPrice(estNet.value)} 摩拉`
        : `；卖方印花税 ${sysStore.stampTaxLabel} 共 ${fmtPrice(estFee.value)} 摩拉，实际到账 ${fmtPrice(estNet.value)} 摩拉`)
    : '；买入不收印花税';
  // 确认弹窗：取消时终止
  let confirmed = false;
  try {
    await ElMessageBox.confirm(
      `${kind} ${qty} 股，${modeText}，预计成交额 ${fmtPrice(estAmount.value)} 摩拉${taxText}`,
      '确认委托',
      { confirmButtonText: '确认', cancelButtonText: '再想想', type: 'warning' }
    );
    confirmed = true;
  } catch { return; }
  if (!confirmed) return;

  submitting.value = true;
  try {
    const res = await apiPlaceOrder({
      stockId: props.stockId,
      side: side.value,
      type: orderType.value,
      price: orderType.value === 'LIMIT' ? price.value : null,
      quantity: qty,
    });
    // 成交回执里把印花税/到账金额显示出来
    if (res.trade && res.trade.fee > 0) {
      ElMessage.success(`已成交，到账 ${fmtPrice(res.trade.netAmount)} 摩拉（含印花税 ${fmtPrice(res.trade.fee)}）`);
    } else {
      ElMessage.success(res.message);
    }
    emit('done');
  } catch { /* 其余错误由全局提示 */ } finally {
    submitting.value = false;
  }
}

onMounted(() => { sysStore.fetchMeta(); });
</script>

<style scoped>
.trade-panel { display: flex; flex-direction: column; gap: 6px; }
.tp-form { margin-top: 10px; }
.tp-form :deep(.el-form-item) { margin-bottom: 12px; }
.tp-form :deep(.el-form-item__label) { padding-bottom: 2px; }
.w-full { width: 100%; }
.hint { font-size: 12px; color: #9a8a6a; margin-top: 4px; line-height: 1.7; }
.lock-hint { color: #b8860b; }
.lock-hint b { color: var(--ts-gold-dark); }
.tax-tip { font-size: 12px; color: #9a8a6a; margin-top: 8px; line-height: 1.7; }
.tax-tip b { color: var(--ts-gold-dark); }
.est { margin-top: 8px; font-size: 13px; color: var(--ts-ink-soft); text-align: right; line-height: 1.9; }
.est .net { color: var(--ts-gold-dark); }
.est-note { font-size: 11px; color: var(--ts-ink-soft); opacity: .85; margin-top: 2px; }
</style>
