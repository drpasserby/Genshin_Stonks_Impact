<template>
  <!-- 用户对话框 -->
  <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑用户' : '新建用户'" width="440px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="用户名"><el-input v-model="form.username" :disabled="isEdit" /></el-form-item>

      <!-- 新建：必填初始密码 -->
      <el-form-item v-if="!isEdit" label="初始密码" required>
        <el-input v-model="form.password" type="password" show-password placeholder="6~64位" />
      </el-form-item>

      <!-- 编辑 + root：可重置密码（明文加密存储，无法“查看”原密码） -->
      <el-form-item v-if="isEdit && store.isRoot" label="重置密码">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          clearable
          placeholder="留空则不修改；输入新密码将立即生效"
        >
          <template #append>
            <el-button :icon="MagicStick" @click="genPassword">随机生成</el-button>
          </template>
        </el-input>
      </el-form-item>
      <el-form-item v-else-if="isEdit" label="密码">
        <el-input value="••••••" disabled />
        <div class="tip">仅超级管理员可重置密码</div>
      </el-form-item>

      <el-form-item label="昵称"><el-input v-model="form.nickname" /></el-form-item>
      <el-form-item label="身份组">
        <el-select v-model="form.role">
          <el-option
            v-for="opt in roleOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
            :disabled="!isAssignable(opt.value)"
          />
        </el-select>
        <div class="tip">{{ roleAssignHint }}</div>
      </el-form-item>
      <el-form-item label="状态">
        <el-switch v-model="form.enabled" active-text="启用" inactive-text="禁用" />
      </el-form-item>
      <el-form-item label="摩拉"><el-input-number v-model="form.mora" :min="0" :step="10000" style="width:100%" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveUser">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { MagicStick } from '@element-plus/icons-vue';
import { apiAdminCreateUser, apiAdminUpdateUser } from '@/api/admin';
import { useUserStore } from '@/stores/user';
import type { Role, User } from '@/types';
import { useAdminPermissions } from '@/composables/useAdminPermissions';

const props = defineProps<{
  visible: boolean;
  /** null = 新建用户；否则编辑该用户 */
  user: User | null;
}>();

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  (e: 'saved'): void;
}>();

const store = useUserStore();
const { roleOptions, isAssignable, roleAssignHint } = useAdminPermissions();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
});

const isEdit = computed(() => !!props.user);
const id = computed(() => props.user?.id ?? 0);
const saving = ref(false);

const form = reactive({
  username: '', password: '', nickname: '', role: 'user' as Role, enabled: true, mora: 1000000,
});

/** 打开时按「编辑 / 新建」初始化表单 */
watch(() => props.visible, (v) => {
  if (!v) return;
  const row = props.user;
  form.username = row?.username ?? '';
  form.password = '';
  form.nickname = row?.nickname ?? '';
  form.role = row?.role ?? 'user';
  form.enabled = row ? row.status === 1 : true;
  form.mora = row?.mora ?? 1000000;
});

async function saveUser() {
  const f = form;
  if (!f.username || (!isEdit.value && !f.password)) return ElMessage.warning('用户名与密码必填');
  // 编辑 + root：如填了密码则长度校验
  if (isEdit.value && f.password && (f.password.length < 6 || f.password.length > 64)) {
    return ElMessage.warning('新密码长度须为 6~64 位');
  }
  // 普通 admin：新建默认 user；可赋予的身份组受「等级低于自己」限制（后端同样校验）
  if (!store.isRoot) {
    if (!isEdit.value) f.role = 'user';
    if (!isAssignable(f.role)) {
      ElMessage.warning('管理员无权把身份设为管理员或超级管理员');
      return;
    }
  }
  saving.value = true;
  try {
    const data: Record<string, unknown> = {
      nickname: f.nickname, role: f.role, status: f.enabled ? 1 : 0, mora: f.mora,
      ...(isEdit.value ? {} : { username: f.username, password: f.password }),
    };
    // 编辑时：root 填了新密码才提交 password
    if (isEdit.value && store.isRoot && f.password) data.password = f.password;
    if (isEdit.value) await apiAdminUpdateUser(id.value, data);
    else await apiAdminCreateUser(data as never);
    ElMessage.success(isEdit.value && f.password ? '已保存（新密码已生效）' : '保存成功');
    emit('update:visible', false);
    emit('saved');
  } finally { saving.value = false; }
}

/** root 生成随机密码 */
function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%';
  const arr = new Uint32Array(10);
  crypto.getRandomValues(arr);
  let pwd = '';
  for (const n of arr) pwd += chars[n % chars.length];
  form.password = pwd;
  ElMessage.success('已生成随机密码，请复制并告知用户');
}
</script>

<style scoped>
.tip { font-size: 11px; color: #a08a60; line-height: 1.6; }
</style>