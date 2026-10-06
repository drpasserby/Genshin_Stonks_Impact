<template>
  <!-- 用户管理 -->
  <div class="bar">
    <el-input v-model="userQ" placeholder="按用户名 / 昵称搜索" clearable style="width:220px" @input="onUserFilterChange" />
    <el-checkbox v-if="store.isRoot" v-model="showDeleted" style="margin-left:12px" @change="onUserFilterChange">
      显示已注销账号<template v-if="deletedCount">（{{ deletedCount }}）</template>
    </el-checkbox>
    <el-button type="primary" :icon="Plus" @click="openUserDialog()">新建用户</el-button>
  </div>
  <el-alert v-if="store.isRoot" type="info" :closable="false" show-icon style="margin-bottom:10px"
    title="删除 = 注销（逻辑删除）：账号无法登录、默认不显示，但委托/成交/持仓等数据全部保留，可随时恢复。" />
  <el-table :data="users" v-loading="usersLoading">
    <el-table-column prop="id" label="ID" width="60" />
    <el-table-column prop="username" label="用户名" min-width="110" />
    <el-table-column prop="nickname" label="昵称" min-width="110" />
    <el-table-column label="角色" width="100">
      <template #default="{ row }">
        <el-tag :type="roleTag(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="摩拉" align="right">
      <template #default="{ row }"><span class="num">{{ fmtNumber(row.mora) }}</span></template>
    </el-table-column>
    <el-table-column label="状态" width="90">
      <template #default="{ row }">
        <el-tag v-if="row.status === 2" type="danger" size="small" effect="plain">已注销</el-tag>
        <el-tag v-else :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '正常' : '禁用' }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="最后登录" min-width="180">
      <template #default="{ row }">
        <template v-if="row.lastLoginAt">
          <div class="num">{{ fmtTime(row.lastLoginAt) }}</div>
          <div class="cell-sub num">{{ row.lastLoginIp || '-' }}</div>
        </template>
        <span v-else class="cell-sub">从未登录</span>
      </template>
    </el-table-column>
    <el-table-column label="注册时间" min-width="150">
      <template #default="{ row }"><span class="num">{{ fmtTime(row.createdAt) }}</span></template>
    </el-table-column>
    <el-table-column label="操作" width="230" fixed="right">
      <template #default="{ row }">
        <template v-if="store.isRoot || canManageUser(row)">
          <el-button size="small" @click="openUserDialog(row)">编辑</el-button>
          <el-button v-if="store.isRoot && row.status === 2" size="small" type="success" plain @click="restoreUser(row)">恢复</el-button>
          <el-button v-else-if="store.isRoot" size="small" type="danger" plain @click="removeUser(row)">注销</el-button>
          <el-tooltip v-else content="管理员无权删除用户" placement="top">
            <el-button size="small" type="info" plain disabled>注销</el-button>
          </el-tooltip>
        </template>
        <el-tag v-else type="info" size="small" effect="plain">仅 root 可操作</el-tag>
      </template>
    </el-table-column>
  </el-table>
  <div class="bar pager" v-if="userTotal > userPageSize">
    <el-pagination
      background
      layout="total, prev, pager, next, jumper"
      :total="userTotal"
      :page-size="userPageSize"
      :current-page="userPage"
      @current-change="goUserPage"
    />
  </div>

  <!-- 用户对话框 -->
  <AdminUserDialog v-model:visible="userDlgVisible" :user="userDlgRow" @saved="loadUsers" />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import type { User } from '@/types';
import { apiAdminUsers, apiAdminDeleteUser, apiAdminUpdateUser } from '@/api/admin';
import { useUserStore } from '@/stores/user';
import { fmtNumber, fmtTime, roleLabel, roleTagType } from '@/utils/format';
import { useAdminPermissions } from '@/composables/useAdminPermissions';
import AdminUserDialog from './dialogs/AdminUserDialog.vue';

const store = useUserStore();
const { canManageUser, loadRoleOptions } = useAdminPermissions();

const users = ref<User[]>([]);
const usersLoading = ref(false);
const userQ = ref('');
/** 用户列表分页（服务端分页，一次只拉一页） */
const userPage = ref(1);
const userPageSize = 20;
const userTotal = ref(0);
/** root 专属：是否显示已注销（逻辑删除）的账号 */
const showDeleted = ref(false);
const deletedCount = ref(0);

const userDlgVisible = ref(false);
const userDlgRow = ref<User | null>(null);

async function loadUsers() {
  usersLoading.value = true;
  try {
    const page = await apiAdminUsers({
      q: userQ.value,
      page: userPage.value,
      pageSize: userPageSize,
      includeDeleted: showDeleted.value ? 1 : 0,
    });
    users.value = page.list;
    userTotal.value = page.total ?? page.list.length;
    deletedCount.value = page.deletedCount ?? 0;
    // 注销掉当前页最后一条后自动回退一页
    if (!page.list.length && userPage.value > 1) {
      userPage.value = Math.max(1, Math.ceil((page.total ?? 0) / userPageSize));
      return await loadUsers();
    }
  } finally { usersLoading.value = false; }
}

/** 搜索 / 勾选框变化：回到第 1 页再拉数据 */
function onUserFilterChange() {
  userPage.value = 1;
  loadUsers();
}
function goUserPage(p: number) {
  userPage.value = p;
  loadUsers();
}

function openUserDialog(row?: User) {
  if (row && !canManageUser(row)) {
    ElMessage.warning('管理员无权操作管理员/超级管理员账号');
    return;
  }
  userDlgRow.value = row ?? null;
  userDlgVisible.value = true;
}

async function removeUser(row: User) {
  await ElMessageBox.confirm(
    `确定注销用户「${row.username}」？\n\n这是逻辑删除：账号将无法登录并在列表中隐藏，但委托/持仓/成交等数据全部保留，之后可以随时恢复。`,
    '注销用户（逻辑删除）',
    { type: 'warning', confirmButtonText: '确认注销', cancelButtonText: '取消' }
  ).catch(() => Promise.reject(new Error('cancel')));
  try {
    await apiAdminDeleteUser(row.id);
    ElMessage.success('已注销（数据已保留）');
    loadUsers();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

/** root：把已注销账号恢复为正常状态 */
async function restoreUser(row: User) {
  await ElMessageBox.confirm(`确定恢复用户「${row.username}」？恢复后该账号可正常登录。`, '恢复账号', { type: 'info' })
    .catch(() => Promise.reject(new Error('cancel')));
  try {
    await apiAdminUpdateUser(row.id, { status: 1 });
    ElMessage.success('账号已恢复');
    loadUsers();
  } catch (e) { if ((e as Error)?.message === 'cancel') return; }
}

function roleTag(r: string) {
  return roleTagType(r);
}

onMounted(() => {
  loadRoleOptions();   // 身份组下拉与「可赋予/可管理」判定都依赖它
  loadUsers();
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.pager { justify-content: center; }
</style>