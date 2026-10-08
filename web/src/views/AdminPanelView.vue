<template>
  <div class="page-container admin-page">
    <!-- 顶级切换：管理员后台 / 系统控制面板（后者仅超级管理员可见）
         拆成一级 Tab 是为了避免两个大面板纵向堆叠、需要一直往下拉 -->
    <el-tabs v-model="topTab" class="top-tabs">
      <el-tab-pane name="admin" lazy>
        <template #label>
          <span class="top-tab-label">🗂️ 管理员后台</span>
        </template>
        <div class="ts-card">
          <h3 class="ts-title">管理员后台
            <el-tag v-if="store.isRoot" type="danger" effect="dark" size="small" style="margin-left:8px; vertical-align:middle">超级管理员 · 全部权限</el-tag>
            <el-tag v-else type="danger" effect="plain" size="small" style="margin-left:8px; vertical-align:middle">管理员 · 受限权限</el-tag>
          </h3>
          <el-tabs v-model="tab">
            <el-tab-pane label="用户管理" name="users" lazy>
              <AdminUsersTab />
            </el-tab-pane>
            <el-tab-pane label="角色股票 / 基金" name="stocks" lazy>
              <AdminStocksTab />
            </el-tab-pane>
            <el-tab-pane label="成交记录" name="trades" lazy>
              <AdminTradesTab />
            </el-tab-pane>
            <el-tab-pane label="新闻管理" name="news" lazy>
              <AdminNewsTab />
            </el-tab-pane>
          </el-tabs>
        </div>
      </el-tab-pane>

      <!-- 系统控制面板：仅超级管理员可见（普通管理员连这个 Tab 都看不到） -->
      <el-tab-pane v-if="store.isRoot" name="root" lazy>
        <template #label>
          <span class="top-tab-label">🛠️ 系统控制面板</span>
        </template>
        <div class="ts-card panel-card">
          <h3 class="ts-title">🛠️ 系统控制面板（仅超级管理员）</h3>
          <el-tabs v-model="panelTab">
            <el-tab-pane label="📊 系统性能" name="perf" lazy>
              <AdminPerfTab :active="panelTab === 'perf'" />
            </el-tab-pane>
            <el-tab-pane label="系统开关与参数" name="settings" lazy>
              <AdminSettingsTab />
            </el-tab-pane>
            <el-tab-pane label="操作日志" name="logs" lazy>
              <AdminLogsTab :active="panelTab === 'logs'" />
            </el-tab-pane>
            <el-tab-pane label="盈亏导出" name="pnl" lazy>
              <AdminPnlTab />
            </el-tab-pane>
          </el-tabs>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue';
import { useUserStore } from '@/stores/user';

const store = useUserStore();

/**
 * 记住上次停留的栏位（浏览器本地）。
 *
 * 三级 Tab 都记：顶级（管理员后台 / 系统控制面板）、后台内的分栏、控制面板内的分栏。
 * 用户重新打开后台时，直接回到上次关页面时看的那一栏，不用每次从头点。
 *
 * ⚠️ 存的是「栏位名」，读回来必须校验：
 *   · 'root' 只有超级管理员有对应的 tab-pane，普通管理员存了它会导致 el-tabs
 *     找不到匹配面板而显示空白 —— 所以读取时先比对权限，权限变化时再兜一次。
 *   · 其余名字同样只放行白名单内的值，避免旧版本残留的脏值把页面卡住。
 */
const TAB_KEYS = {
  top: 'admin_top_tab',
  main: 'admin_main_tab',
  panel: 'admin_panel_tab',
} as const;

function readPref(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式忽略 */ }
}

const MAIN_TABS = ['users', 'stocks', 'trades', 'news'];
const PANEL_TABS = ['perf', 'settings', 'logs', 'pnl'];

/** 读回一个值，不在白名单内就回退到默认值 */
function restore(key: string, allowed: readonly string[], fallback: string): string {
  const v = readPref(key);
  return allowed.includes(v) ? v : fallback;
}

/** 顶级 tab：admin=管理员后台 / root=系统控制面板（仅超级管理员可见） */
const topTab = ref<'admin' | 'root'>(
  readPref(TAB_KEYS.top) === 'root' && store.isRoot ? 'root' : 'admin',
);
const tab = ref(restore(TAB_KEYS.main, MAIN_TABS, 'users'));
const panelTab = ref(restore(TAB_KEYS.panel, PANEL_TABS, 'settings')); // 系统控制面板内部 tab

watch(topTab, (v) => writePref(TAB_KEYS.top, v));
watch(tab, (v) => writePref(TAB_KEYS.main, v));
watch(panelTab, (v) => writePref(TAB_KEYS.panel, v));

// 权限变化（登出/切换账号）时，不允许继续停在只有 root 能看的面板上
watch(() => store.isRoot, (r) => { if (!r) topTab.value = 'admin'; });

// 按 tab 懒加载：首屏只加载当前 tab 的数据
const AdminUsersTab = defineAsyncComponent(() => import('./admin/AdminUsersTab.vue'));
const AdminStocksTab = defineAsyncComponent(() => import('./admin/AdminStocksTab.vue'));
const AdminTradesTab = defineAsyncComponent(() => import('./admin/AdminTradesTab.vue'));
const AdminNewsTab = defineAsyncComponent(() => import('./admin/AdminNewsTab.vue'));
const AdminPerfTab = defineAsyncComponent(() => import('./admin/AdminPerfTab.vue'));
const AdminSettingsTab = defineAsyncComponent(() => import('./admin/AdminSettingsTab.vue'));
const AdminLogsTab = defineAsyncComponent(() => import('./admin/AdminLogsTab.vue'));
const AdminPnlTab = defineAsyncComponent(() => import('./admin/AdminPnlTab.vue'));
</script>

<style scoped>
.admin-page { padding-top: 12px; }
/* 系统控制面板 */
.panel-card { margin-top: 0; }

/* 顶级 Tab（管理员后台 / 系统控制面板） */
.top-tabs :deep(> .el-tabs__header) {
  margin-bottom: 12px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.2));
  border: 1px solid var(--ts-card-border);
  border-radius: 10px;
  padding: 2px 8px;
}
.top-tabs :deep(> .el-tabs__header .el-tabs__item) { font-size: 15px; font-weight: 600; height: 46px; }
.top-tab-label { display: inline-flex; align-items: center; gap: 4px; }
</style>