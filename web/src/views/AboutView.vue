<template>
  <div class="page-container help-page">
    <!-- 页头 -->
    <div class="ts-card hero">
      <div class="hero-mark">⚜️</div>
      <h1>关于「提瓦特证券交易所」</h1>
      <p>这里是提瓦特大陆的虚拟角色交易所 —— 每位角色都是一只股票，
        用虚拟货币「摩拉」参与买卖，体验真实的撮合、估价与 K 线乐趣（纯娱乐，不涉及真实资金）。</p>
    </div>

    <!-- 快速开始 -->
    <div class="ts-card">
      <h3 class="ts-title">🚀 三步快速上手</h3>
      <el-steps :active="3" align-center finish-status="success" class="steps">
        <el-step title="注册账号" description="注册即赠送 100 万摩拉启动资金" />
        <el-step title="买卖角色股票" description="行情页选角色 → 市价/限价下单" />
        <el-step title="关注新闻与投票" description="操作员发布新闻可影响股价走向" />
      </el-steps>
    </div>

      <!-- 交易规则 -->
      <div class="ts-card">
        <h3 class="ts-title">📖 交易规则</h3>
        <ul class="rule-list">
          <li><b>市价单</b>：下单后立刻按<b class="gold">当前股价</b>整单成交。</li>
          <li><b>限价单</b>：设定价格与数量；系统每隔
            <el-tag size="small" effect="plain">{{ cycleMin }} 分钟</el-tag>尝试撮合一次——
            买价 ≥ 当前价，或卖价 ≤ 当前价，即以当前价成交（成交价不等于你的挂单价）。</li>
          <li><b>挂单冻结</b>：限价单会冻结对应摩拉/股份，成交按实际成本清算、差额退回；撤单则全额解冻。</li>
          <li><b>最少持有周期</b>：买入的份额必须持有满
            <el-tag size="small" effect="plain">{{ holdCycles }} 个周期</el-tag>
            （按当前周期换算约 <b class="gold">{{ holdMinutes }}</b>）才能卖出。
            <span v-if="holdCycles > 0">卖出不足期的份额会直接失败并提示「该份额持有周期过短，不得卖出。请在买入{{ holdCycles }}个周期后卖出」。</span>
            <span v-else>当前<b>未开启</b>该限制，买入后可立即卖出。</span>
            <br />
            <small class="rule-note">
              只锁定<b>新买入</b>的份额：早就持有的存量不受影响；分批买入会分别计算各自的解锁时间（按买入先后卖出）。
              举例：已有 100 股可自由卖出，今天又买 50 股，那么现在最多卖 100 股，那 50 股需等满 {{ holdCycles }} 个周期。
            </small>
          </li>
          <li><b>卖方印花税</b>：每笔卖出按成交额的 <b class="gold">{{ stampTax }}</b> 扣除（买入不收），实际到账 = 成交额 − 印花税。</li>
          <li><b>平仓盈亏怎么算</b>：成交记录里每笔<b>卖出</b>都会显示「平仓盈亏」＝ <b class="gold">实际到账 − 该笔份额的成本</b>，
            成本按你的<b>移动加权平均成本价</b>（与「我的 → 持仓」里显示的成本价同一口径）计算，所以两处数字对得上。
            <br />
            <small class="rule-note">
              「平仓盈亏」是<b>已实现</b>的（卖出那一刻落袋），「持仓盈亏」是<b>未实现</b>的（还没卖），两者相加就是你的
              <b>交易总盈亏</b>，在「我的」页顶部可以直接看到。买入记录的平仓盈亏显示为「—」（买入不产生盈亏）。
            </small>
          </li>
          <li><b>成交价恒等于撮合时刻的当前股价</b>，交易所作为对手方提供流动性。</li>
        </ul>
      </div>

    <!-- 身份组与权限：刻意不对外展示（2026-09-14 移除）——
         身份组、获得方式、删除类操作的限制属于内部治理信息，普通用户查了也没用，
         反而容易引发「凭什么他能我不能」的争论；需要了解时由管理员单独说明。 -->

    <!-- FAQ -->
    <div class="ts-card">
      <h3 class="ts-title">❓ 常见问题</h3>
      <div class="faq-list">
        <div v-for="(f, i) in faqs" :key="i" class="faq-item" :class="{ open: faqIdx === i }" @click="faqIdx = faqIdx === i ? -1 : i">
          <div class="faq-q">
            <span class="faq-q-mark">{{ faqIdx === i ? '−' : '+' }}</span>
            {{ f.q }}
          </div>
          <transition name="faq-fade">
            <div v-if="faqIdx === i" class="faq-a">{{ f.a }}</div>
          </transition>
        </div>
      </div>
    </div>

    <!-- 周期与参数 -->
    <div class="ts-card param-card">
      <h3 class="ts-title">⚙️ 系统参数</h3>
      <div class="param-line">
        <span>撮合/估价周期</span><el-tag size="small" effect="plain">{{ cycleMin }} 分钟一轮</el-tag>
        <span>每日收盘（日K）</span><el-tag size="small" effect="plain">{{ closeHour }}:00（服务器本地时区）</el-tag>
        <span>注册赠金</span><el-tag size="small" effect="plain">{{ startMoraDisplay }}</el-tag>
        <span>单周期限幅</span><el-tag size="small" effect="plain">±{{ maxCh }}%</el-tag>
        <span>最少持有周期</span>
        <el-tag size="small" effect="plain">{{ holdCycles > 0 ? `${holdCycles} 个周期（约 ${holdMinutes}）` : '未限制' }}</el-tag>
        <span>卖方印花税</span><el-tag size="small" effect="plain">{{ stampTax }}</el-tag>
      </div>
      <p class="tip-text">以上参数来自后端实时配置，可在服务器端 <code>server/.env</code> 中调整（如 CYCLE_MINUTES）。</p>
    </div>

    <!-- 免责声明 -->
    <div class="ts-card disclaimer">
      ⚠️ 本平台为<b>娱乐性质的原神同人模拟炒股游戏</b>，不涉及任何真实资金交易，股价波动与角色强度无关。
      与原神 / 米哈游官方无关联；角色图片版权归原作者所有。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { get } from '@/api/http';

interface SysMeta {
  cycleMinutes: number;
  dailyCloseHour: number;
  startMora: number;
  maxChange: number;
  newsTtlCycles: number;
  /** 最少持有周期数（0 = 不限制） */
  minHoldCycles: number;
  /** 卖方印花税税率，0.005 = 0.5% */
  stampTaxRate: number;
}

const meta = ref<SysMeta>({
  cycleMinutes: 10,
  dailyCloseHour: 15,
  startMora: 1000000,
  maxChange: 0.1,
  newsTtlCycles: 6,
  minHoldCycles: 3,
  stampTaxRate: 0.005,
});

const cycleMin = ref('10');
const closeHour = ref('15');
const newsTtl = ref('6');
const maxCh = ref('10');
const startMoraDisplay = ref('1,000,000');
const holdCycles = ref(3);
const stampTax = ref('0.5%');

/** 锁仓时长的人类可读文本（按当前周期长度换算） */
const holdMinutes = computed(() => {
  const cycles = Math.max(0, Number(holdCycles.value) || 0);
  if (!cycles) return '未限制';
  const mins = cycles * Math.max(1, Number(cycleMin.value) || 10);
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
});

function applyMeta(m: SysMeta) {
  cycleMin.value = String(m.cycleMinutes);
  closeHour.value = String(m.dailyCloseHour);
  newsTtl.value = String(m.newsTtlCycles);
  maxCh.value = String((m.maxChange * 100).toFixed(0));
  startMoraDisplay.value = m.startMora.toLocaleString('zh-CN');
  holdCycles.value = Number(m.minHoldCycles ?? 3);
  stampTax.value = `${+((Number(m.stampTaxRate ?? 0.005) * 100).toFixed(4))}%`;
}

onMounted(async () => {
  try {
    applyMeta(await get<SysMeta>('/meta'));
  } catch {
    /* 后端不可达时使用默认值兜底 */
  }
});

const faqIdx = ref(-1);

const faqs = computed(() => [
  { q: '注册后有多少资金？', a: '每位新用户注册即赠送 1,000,000 摩拉（虚拟货币），仅在本平台内使用。' },
  { q: '市价单和限价单有什么区别？', a: `市价单立即按当前价成交；限价单需要设定一个价格，每 ${cycleMin.value} 分钟撮合一次，达到你的价格条件（买价≥现价 或 卖价≤现价）才以现价成交，成交前资金/股份会被冻结。` },
  { q: '股票价格多久更新一次？', a: `系统每 ${cycleMin.value} 分钟结算一轮：先撮合挂单，再根据这一轮的买卖、新闻与投票情况更新股价，并生成一根 K 线。` },
  { q: '新闻多久会失效？', a: `新闻发布后默认在 ${newsTtl.value} 个周期内有效（约 ${Math.max(1, Math.round(Number(newsTtl.value) * Number(cycleMin.value) / 60 * 10) / 10)} 小时），过期后不再参与股价计算。` },
  { q: '为什么股票没有分时图/实时跳动？', a: `本平台模拟的是「周期撮合」模式：每 ${cycleMin.value} 分钟产生一根 K 线并更新一次股价，期间价格不变。这是简化撮合模型的设计（详见项目 docs/ARCHITECTURE.md）。` },
  { q: '买卖有限制吗？', a: '单笔委托数量需为 1~1,000,000 股之间的整数；卖出不能超过你可用持仓（挂单部分会被冻结）。' },
  {
    q: '为什么我卖了刚买的股票，提示「该份额持有周期过短」？',
    a: `为了防止秒买秒卖的刷单，买入的份额需要持有满 ${holdCycles.value} 个周期（当前约 ${holdMinutes.value}）才能卖出。` +
      `只限制新买入的份额：早已持有的存量不受影响；分批买入各自计算解锁时间，卖出时按买入先后（先买的先卖）。` +
      `在「个股详情 → 委托」里能看到「可卖 X 股 / 锁仓 Y 股」和下一批的解锁时间。${holdCycles.value === 0 ? '（当前该限制已关闭）' : ''}`,
  },
  { q: '手续费怎么收？', a: `每笔卖出按成交额的 ${stampTax.value} 收印花税，从到账金额里直接扣除（买入不收；平台不收其他费用）。委托确认框和成交记录里都会显示税额与实际到账。` },
  {
    q: '成交记录里的「平仓盈亏」是怎么算的？',
    a: '卖出那笔的「平仓盈亏」＝ 实际到账（已扣印花税）− 该笔份额的成本；成本按你的移动加权平均成本价计算，' +
      '与「我的 → 持仓」里显示的成本价是同一个口径，所以两处数字对得上。买入记录不产生盈亏，显示为「—」。' +
      '「我的」页顶部还会给出「累计平仓盈亏（已实现）」和「交易总盈亏（= 已实现 + 未实现）」，不用自己加。',
  },
  { q: '可以撤销委托吗？', a: '可以。挂单中（PENDING）的委托可在「我的 → 委托单」中撤销，撤销后冻结的资金/股份会立即解冻。' },
]);
</script>

<style scoped>
.help-page { padding-top: 12px; display: flex; flex-direction: column; gap: 12px; }
.rule-note { display: inline-block; margin-top: 4px; color: var(--ts-ink-soft); line-height: 1.8; }
.hero { text-align: center; }
.hero-mark { font-size: 46px; filter: drop-shadow(0 2px 6px rgba(160, 120, 50, 0.4)); }
.hero h1 { margin: 8px 0 6px; font-size: 26px; color: var(--ts-gold-dark); letter-spacing: 2px; }
.hero p { margin: 0 auto; max-width: 640px; line-height: 1.9; color: var(--ts-ink-soft); font-size: 14px; }

.steps { margin: 8px 0 2px; }

.grid { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
@media (max-width: 899px) { .grid { grid-template-columns: 1fr; } }

.rule-list { margin: 0; padding-left: 18px; line-height: 2; font-size: 14px; color: var(--ts-ink); }
.rule-list.small { font-size: 13px; color: var(--ts-ink-soft); line-height: 1.9; }
.gold { color: var(--ts-gold-dark); }

.formula { text-align: center; line-height: 2.1; font-size: 13px; color: var(--ts-ink-soft); margin: 4px 0 10px; }
.f { font-weight: 700; color: var(--ts-gold-dark); font-size: 14px; }

.tip-text { margin: 10px 0 0; font-size: 12px; color: #a08a60; line-height: 1.8; }

/* FAQ 折叠列表 */
.faq-list { display: flex; flex-direction: column; gap: 6px; }
.faq-item {
  border: 1px solid #e4d6ae;
  border-radius: 10px;
  background: rgba(255, 252, 242, 0.6);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.faq-item:hover { border-color: var(--ts-gold-light); }
.faq-item.open { border-color: var(--ts-gold); box-shadow: 0 2px 8px rgba(201, 162, 75, 0.18); }
.faq-q {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  font-size: 14px; font-weight: 600; color: var(--ts-ink);
}
.faq-q-mark {
  flex: none; width: 18px; height: 18px; line-height: 16px; text-align: center;
  border-radius: 50%;
  background: linear-gradient(150deg, var(--ts-gold), var(--ts-gold-dark));
  color: #fff; font-size: 13px;
}
.faq-a {
  padding: 2px 14px 12px 42px;
  color: var(--ts-ink-soft); line-height: 1.9; font-size: 13px;
}
.faq-fade-enter-active, .faq-fade-leave-active { transition: opacity 0.2s; }
.faq-fade-enter-from, .faq-fade-leave-to { opacity: 0; }

.param-line { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; font-size: 13px; color: var(--ts-ink-soft); }
.param-line span { min-width: 90px; }
code { background: rgba(201, 162, 75, 0.15); padding: 1px 6px; border-radius: 4px; color: var(--ts-gold-dark); }

.disclaimer { font-size: 12px; color: #9a8a6a; line-height: 1.9; text-align: center; }
</style>
