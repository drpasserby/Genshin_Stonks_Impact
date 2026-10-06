<template>
  <!-- 股票 / 基金对话框 -->
  <el-dialog
    v-model="dialogVisible"
    :title="isEdit ? '编辑标的' : (form.type === 'FUND' ? '新增指数基金' : '新增角色股票')"
    width="460px">
    <el-form :model="form" label-width="90px">
      <el-form-item v-if="!isEdit" label="类型">
        <el-radio-group v-model="form.type">
          <el-radio-button value="STOCK">角色股票</el-radio-button>
          <el-radio-button value="FUND">指数基金</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="代码">
        <el-input
          v-model="form.code"
          :placeholder="form.type === 'FUND' ? 'FUND01' : 'TY0007'"
          :disabled="isEdit && !store.isRoot"
        />
        <div class="tip" v-if="isEdit && store.isRoot">超级管理员可直接修改代码，提交时会校验是否重复</div>
        <div class="tip" v-else-if="isEdit">代码创建后不可修改（仅超级管理员可改）</div>
      </el-form-item>
      <el-form-item :label="form.type === 'FUND' ? '基金名' : '角色名'">
        <el-input v-model="form.name" />
      </el-form-item>
      <el-form-item label="初始价格">
        <el-input-number
          v-if="showPriceField"
          v-model="form.price" :min="0.0001" :precision="4" :step="10" style="width:100%" />
        <div v-else class="nav-auto num">
          由成分股加权净值自动决定<template v-if="stockNavPreview > 0">：<b>{{ fmtPrice(stockNavPreview) }}</b> 摩拉</template>
        </div>
        <div class="tip" v-if="showPriceField && !isEdit">将作为昨收/今开/现价基准</div>
        <div class="tip" v-else-if="!showPriceField">创建价 = 该净值，不会再出现「低价上市后每周周期补涨」的确定性套利</div>
        <div class="tip warn" v-if="isEdit && form.type === 'FUND'">
          指数基金的价格由成分股净值决定（当前净值 {{ nav == null ? '—' : fmtPrice(nav) }}）。
          手工改价后引擎会按「每周期最多 ±10%」把价格拉回净值附近，偏离越大这段确定性行情越长，请谨慎修改。
        </div>
      </el-form-item>

      <!-- 新建指数基金：先定成分股（价格由它们的加权净值决定） -->
      <template v-if="isNewFund">
        <el-form-item label="成分股">
          <div class="fund-add">
            <el-select v-model="pick" filterable placeholder="搜索并选择角色" style="width:200px">
              <el-option v-for="s in stockPickOptions" :key="s.id" :label="`${s.name}（${s.code}）`" :value="s.id" />
            </el-select>
            <el-input-number v-model="pickWeight" :min="0.1" :max="100" :step="0.5" :precision="2" size="small" style="width:120px" />
            <el-button size="small" type="primary" plain @click="addStockConstituent">添加</el-button>
          </div>
          <div class="tip">需 {{ rules.min }}~{{ rules.max }} 个角色；权重是相对值，会自动归一化（一期不支持基金持有基金）</div>
        </el-form-item>
        <el-form-item label="已选成分">
          <el-table :data="constituents" size="small" style="width:100%">
            <el-table-column label="角色" min-width="130">
              <template #default="{ row }">{{ row.name }} <small class="c">{{ row.code }}</small></template>
            </el-table-column>
            <el-table-column label="现价" align="right" width="110">
              <template #default="{ row }"><span class="num">{{ fmtPrice(row.price) }}</span></template>
            </el-table-column>
            <el-table-column label="权重" width="130">
              <template #default="{ row }">
                <el-input-number v-model="row.weight" :min="0.1" :max="100" :step="0.5" :precision="2" size="small" controls-position="right" style="width:100%" />
              </template>
            </el-table-column>
            <el-table-column label="" width="76" align="center">
              <template #default="{ $index }">
                <el-button size="small" type="danger" plain @click="constituents.splice($index, 1)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-form-item>
      </template>

      <el-form-item :label="form.type === 'FUND' ? '固定份额' : '流通股数'">
        <el-input-number v-model="form.totalShares" :min="1" :step="10000" style="width:100%" />
        <div class="tip" v-if="form.type === 'FUND'">基金为封闭式：份额固定，买卖只影响价格</div>
        <div class="tip" v-else>流通股数越小，同样一笔交易对价格的推动越大（建议 4 万~20 万量级）</div>
      </el-form-item>
      <el-form-item label="图标URL">
        <el-input v-model="form.avatarUrl" placeholder="https://... 外部图片链接" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveStock">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiAdminCreateStock, apiAdminUpdateStock,
  apiAdminFundRules, apiAdminStockOptions,
  type AdminStockOption,
} from '@/api/admin';
import { useUserStore } from '@/stores/user';
import { fmtPrice } from '@/utils/format';

/** 与父组件传入的标的行对应的最小字段集 */
export interface StockDlgRow {
  id: number;
  code: string;
  name: string;
  avatarUrl: string | null;
  price: number;
  totalShares: number;
  type?: 'STOCK' | 'FUND';
  nav?: number | null;
}

const props = defineProps<{
  visible: boolean;
  /** null = 新增；否则编辑该标的 */
  stock: StockDlgRow | null;
  /** 新增时的默认类型（编辑时以 row.type 为准） */
  createType?: 'STOCK' | 'FUND';
}>();

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  (e: 'saved'): void;
}>();

const store = useUserStore();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
});

const isEdit = computed(() => !!props.stock);
const saving = ref(false);
const nav = ref<number | null>(null);
const pick = ref(0);
const pickWeight = ref(1);
const rules = reactive({ min: 3, max: 15 });
const constituents = ref<Array<{ constituentId: number; code: string | null; name: string; price: number; weight: number }>>([]);
const stockOptions = ref<AdminStockOption[]>([]);

const form = reactive({
  id: 0, code: '', name: '', price: 100, totalShares: 80000, avatarUrl: '', type: 'STOCK' as 'STOCK' | 'FUND',
});

/** 新建基金（价格自动）时是否隐藏手填价格 */
const isNewFund = computed(() => !isEdit.value && form.type === 'FUND');
const showPriceField = computed(() => !isNewFund.value);
/** 可选的成分股：排除基金自身与已选项（数据来自轻量接口 stockOptions） */
const stockPickOptions = computed(() =>
  stockOptions.value.filter(
    (s) => s.type !== 'FUND' && !constituents.value.some((x) => x.constituentId === s.id)
  )
);
/** 按已选成分股实时预估净值（与后端算法一致，仅用于展示） */
const stockNavPreview = computed(() => {
  const list = constituents.value;
  if (!list.length) return 0;
  const total = list.reduce((s, x) => s + (Number(x.weight) || 0), 0) || 1;
  return list.reduce((s, x) => s + (Number(x.weight) || 0) * (Number(x.price) || 0), 0) / total;
});

async function loadFundRules() {
  try {
    const r = await apiAdminFundRules();
    rules.min = r.min;
    rules.max = r.max;
    if (!r.fundEnabled) ElMessage.warning('当前已关闭指数基金机制，新建的基金不会参与净值收敛');
  } catch { /* 拿不到就用默认 3~15，最终以后端校验为准 */ }
}

/** 拉取下拉选择器数据（字段少、体积小；每次都取最新的，避免缓存过期） */
async function loadStockOptions() {
  try { stockOptions.value = await apiAdminStockOptions(); } catch { /* 全局提示 */ }
}

function addStockConstituent() {
  const id = Number(pick.value);
  if (!id) return ElMessage.warning('请先选择角色');
  const s = stockOptions.value.find((x) => x.id === id);
  if (!s) return;
  if (constituents.value.length >= rules.max) {
    return ElMessage.warning(`最多 ${rules.max} 个成分股`);
  }
  constituents.value.push({
    constituentId: id, code: s.code, name: s.name, price: s.price, weight: pickWeight.value || 1,
  });
  pick.value = 0;
  pickWeight.value = 1;
}

/** 打开时按「编辑 / 新增」初始化表单 */
watch(() => props.visible, (v) => {
  if (!v) return;
  const row = props.stock;
  form.id = row?.id ?? 0;
  form.code = row?.code ?? '';
  form.name = row?.name ?? '';
  form.price = row?.price ?? 100;
  form.totalShares = row?.totalShares ?? 80000;
  form.avatarUrl = row?.avatarUrl || '';
  form.type = row?.type ?? props.createType ?? 'STOCK';
  nav.value = row?.nav ?? null;
  constituents.value = [];
  pick.value = 0;
  pickWeight.value = 1;
  if (!row && form.type === 'FUND') {
    loadFundRules();     // 新建基金：先拿到成分股数量限制
    loadStockOptions();  // 以及可选的成分股列表
  }
});

async function saveStock() {
  const f = form;
  if (!f.code || !f.name) return ElMessage.warning('代码与名称必填');
  if (isNewFund.value) {
    if (constituents.value.length < rules.min) {
      return ElMessage.warning(`指数基金至少需要 ${rules.min} 个成分股（当前 ${constituents.value.length} 个）`);
    }
    if (constituents.value.length > rules.max) {
      return ElMessage.warning(`指数基金最多 ${rules.max} 个成分股（当前 ${constituents.value.length} 个）`);
    }
  }
  saving.value = true;
  try {
    if (isEdit.value) {
      const res = await apiAdminUpdateStock(f.id, f);
      ElMessage.success('保存成功' + (res.code ? `（代码 ${res.code}）` : ''));
    } else if (isNewFund.value) {
      // 基金不传 price：由后端按所选成分股的加权净值自动定价
      const res = await apiAdminCreateStock({
        code: f.code, name: f.name, avatarUrl: f.avatarUrl, type: 'FUND', totalShares: f.totalShares,
        constituents: constituents.value.map((x) => ({ constituentId: x.constituentId, weight: Number(x.weight) })),
      });
      ElMessage.success(`基金已创建，初始价按加权净值自动定为 ${fmtPrice(res.nav ?? 0)} 摩拉`);
    } else {
      await apiAdminCreateStock(f);
      ElMessage.success('保存成功');
    }
    emit('update:visible', false);
    emit('saved');
  } catch { /* 全局提示：代码重复等错误由后端返回 */ } finally { saving.value = false; }
}
</script>

<style scoped>
.tip { font-size: 11px; color: #a08a60; line-height: 1.6; }
.tip.warn { color: #c0392b; }
.nav-auto { font-size: 13px; color: var(--ts-gold-dark); line-height: 1.7; }
.nav-auto b { font-size: 15px; }
.fund-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>