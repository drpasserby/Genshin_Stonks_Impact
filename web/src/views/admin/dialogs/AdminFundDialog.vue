<template>
  <!-- 基金成分股对话框 -->
  <el-dialog v-model="dialogVisible" :title="`配置成分股 · ${fundName}`" width="640px">
    <el-alert type="info" :closable="false" show-icon style="margin-bottom:10px"
      :title="`配队基金需关联 ${rules.min}~${rules.max} 个角色（一期不支持基金持有基金）。权重是相对值，会自动归一化。`" />
    <div class="fund-add">
      <el-select v-model="pick" filterable placeholder="搜索并选择角色" style="width:260px">
        <el-option v-for="s in selectableStocks" :key="s.id" :label="`${s.name} (${s.code})`" :value="s.id" />
      </el-select>
      <el-input-number v-model="pickWeight" :min="0.1" :max="100" :step="0.5" :precision="2" size="small" style="width:130px" />
      <el-button type="primary" plain size="small" @click="addConstituent">添加</el-button>
    </div>
    <el-table :data="list" v-loading="loading" size="small" style="width:100%; margin-top:10px">
      <el-table-column label="角色" min-width="160">
        <template #default="{ row }">{{ row.name }} <span class="cell-sub">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column label="现价" align="right" width="100">
        <template #default="{ row }"><span class="num">{{ fmtPrice(row.price) }}</span></template>
      </el-table-column>
      <el-table-column label="权重" align="right" width="150">
        <template #default="{ row }">
          <el-input-number v-model="row.weight" :min="0.1" :max="100" :step="0.5" :precision="2" size="small" controls-position="right" style="width:110px" />
        </template>
      </el-table-column>
      <el-table-column label="占比" align="right" width="80">
        <template #default="{ row }"><span class="num">{{ pctOf(row) }}%</span></template>
      </el-table-column>
      <el-table-column width="70" align="center">
        <template #default="{ $index }">
          <el-button size="small" type="danger" plain @click="list.splice($index, 1)">移除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveFundConstituents">
        保存（{{ list.length }} 个成分股）
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiAdminFundConstituents, apiAdminUpdateFundConstituents, apiAdminStockOptions, type AdminStockOption } from '@/api/admin';
import { fmtPrice } from '@/utils/format';

const props = defineProps<{
  visible: boolean;
  /** 目标基金（只需 id + 名称用于标题） */
  fund: { id: number; name: string } | null;
}>();

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  (e: 'saved'): void;
}>();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
});

interface ConstituentRow {
  constituentId: number;
  code: string | null;
  name: string;
  price: number;
  weight: number;
}

const fundId = ref(0);
const fundName = ref('');
const loading = ref(false);
const saving = ref(false);
const pick = ref(0);
const pickWeight = ref(1);
const list = ref<ConstituentRow[]>([]);
const rules = reactive({ min: 3, max: 15 });
const stockOptions = ref<AdminStockOption[]>([]);

/** 可选成分：全部非基金标的，且排除已在列表里的（数据来自轻量接口 stockOptions） */
const selectableStocks = computed(() =>
  stockOptions.value.filter((s) => s.type !== 'FUND' && !list.value.some((x) => x.constituentId === s.id))
);

const fundTotalWeight = computed(() => list.value.reduce((s, x) => s + (Number(x.weight) || 0), 0) || 1);
function pctOf(row: ConstituentRow) {
  return Math.round(((Number(row.weight) || 0) / fundTotalWeight.value) * 10000) / 100;
}

/** 拉取下拉选择器数据（字段少、体积小；每次都取最新的，避免缓存过期） */
async function loadStockOptions() {
  try { stockOptions.value = await apiAdminStockOptions(); } catch { /* 全局提示 */ }
}

/** 打开对话框时拉取成分股列表 */
watch(() => props.visible, (v) => {
  if (!v) return;
  fundId.value = props.fund?.id ?? 0;
  fundName.value = props.fund?.name ?? '';
  loading.value = true;
  pick.value = 0;
  pickWeight.value = 1;
  loadStockOptions(); // 可选成分股列表（轻量接口）
  void (async () => {
    try {
      const res = await apiAdminFundConstituents(fundId.value);
      list.value = res.list.map((x) => ({
        constituentId: x.constituentId, code: x.code, name: x.name, price: x.price, weight: x.weight,
      }));
      if (res.rules) {
        rules.min = res.rules.min;
        rules.max = res.rules.max;
      }
    } catch { list.value = []; } finally { loading.value = false; }
  })();
});

function addConstituent() {
  const id = Number(pick.value);
  if (!id) return ElMessage.warning('请先选择要加入的角色');
  const s = stockOptions.value.find((x) => x.id === id);
  if (!s) return;
  if (list.value.length >= rules.max) return ElMessage.warning(`最多 ${rules.max} 个成分股`);
  list.value.push({ constituentId: id, code: s.code, name: s.name, price: s.price, weight: pickWeight.value || 1 });
  pick.value = 0;
  pickWeight.value = 1;
}

async function saveFundConstituents() {
  if (list.value.length < rules.min) {
    return ElMessage.warning(`至少需要 ${rules.min} 个成分股（当前 ${list.value.length} 个）`);
  }
  if (list.value.length > rules.max) {
    return ElMessage.warning(`最多 ${rules.max} 个成分股`);
  }
  saving.value = true;
  try {
    await apiAdminUpdateFundConstituents(
      fundId.value,
      list.value.map((x) => ({ constituentId: x.constituentId, weight: Number(x.weight) }))
    );
    ElMessage.success('成分股已保存，下一轮结算即生效');
    emit('update:visible', false);
    emit('saved');
  } catch { /* 全局提示 */ } finally { saving.value = false; }
}
</script>

<style scoped>
.fund-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
</style>