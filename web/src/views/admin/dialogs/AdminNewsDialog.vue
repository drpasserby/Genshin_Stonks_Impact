<template>
  <!-- 新闻对话框（发布/编辑） -->
  <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑新闻' : '发布新闻'" width="520px">
    <el-form :model="form" label-width="90px">
      <el-form-item label="标题" required>
        <el-input v-model="form.title" maxlength="120" show-word-limit placeholder="新闻标题，如：新版本前瞻直播引热议" />
      </el-form-item>
      <el-form-item label="来源链接" required>
        <el-input v-model="form.sourceUrl" placeholder="https://...（粘贴外部新闻/帖子原文链接）" clearable>
          <template #prefix><el-icon><Link /></el-icon></template>
        </el-input>
        <div class="tip">必须为合法的 http/https 链接；系统只做「引用」，不保存自撰正文。</div>
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
      <el-form-item label="关联角色" required>
        <el-select v-model="form.stockIds" multiple filterable placeholder="选择受影响角色（可多选）" style="width:100%">
          <el-option v-for="s in stocks" :key="s.id" :label="`${s.name} (${s.code})`" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="isEdit" label="重置时效">
        <el-switch v-model="form.renew" active-text="重置有效期（重新计时 N 个周期）" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveNews">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Link } from '@element-plus/icons-vue';
import { apiAdminCreateNews, apiAdminUpdateNews } from '@/api/admin';
import type { Direction, NewsItem } from '@/types';

const props = defineProps<{
  visible: boolean;
  /** null = 发布新新闻；否则编辑该新闻 */
  news: NewsItem | null;
  /** 关联角色下拉选项（与父组件管理列表同源） */
  stocks: Array<{ id: number; code: string; name: string }>;
}>();

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  (e: 'saved'): void;
}>();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
});

const isEdit = computed(() => !!props.news);
const id = computed(() => props.news?.id ?? 0);
const saving = ref(false);

const form = reactive({
  title: '', sourceUrl: '',
  direction: 'UP' as Direction,
  strength: 50,
  stockIds: [] as number[],
  renew: false,
});

/** 打开时按「编辑 / 发布」初始化表单 */
watch(() => props.visible, (v) => {
  if (!v) return;
  const row = props.news;
  form.title = row?.title ?? '';
  form.sourceUrl = row?.sourceUrl ?? '';
  form.direction = row?.direction ?? 'UP';
  form.strength = row?.strength ?? 50;
  form.stockIds = (row?.stocks || []).map((s) => s.id);
  form.renew = false;
});

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function saveNews() {
  const f = form;
  if (!f.title.trim()) return ElMessage.warning('请填写新闻标题');
  if (!isHttpUrl(f.sourceUrl)) return ElMessage.warning('请填写合法的来源链接（http/https）');
  if (!f.stockIds.length) return ElMessage.warning('请至少选择一个关联角色');
  saving.value = true;
  try {
    if (isEdit.value) {
      const res = await apiAdminUpdateNews(id.value, f);
      ElMessage.success(
        res.reviewStatus === 'PENDING'
          ? '已保存（该新闻仍在待审核状态，通过后才会生效）'
          : '保存成功'
      );
    } else {
      const res = await apiAdminCreateNews(f);
      // 管理员/高级操作员发布即生效；普通操作员会落到待审（这里只提示，不改变流程）
      ElMessage.success(res.pending ? '已提交，等待审核通过后生效' : '发布成功，已立即生效');
    }
    emit('update:visible', false);
    emit('saved');
  } catch { /* 全局提示 */ } finally { saving.value = false; }
}
</script>

<style scoped>
.tip { font-size: 11px; color: #a08a60; line-height: 1.6; }
</style>