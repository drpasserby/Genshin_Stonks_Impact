<template>
  <!-- 操作日志：仅超级管理员可见 -->
  <div class="bar">
    <el-button :icon="Refresh" circle title="刷新" @click="loadLogs" />
    <span class="bar-sub">共 {{ logTotal }} 条日志</span>
  </div>
  <el-table :data="logs" v-loading="logsLoading">
    <el-table-column prop="id" label="ID" width="80" />
    <el-table-column prop="username" label="操作人" width="130">
      <template #default="{ row }">{{ row.username || '系统' }}</template>
    </el-table-column>
    <el-table-column prop="action" label="动作" width="180">
      <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.action }}</el-tag></template>
    </el-table-column>
    <el-table-column prop="detail" label="详情" min-width="240" show-overflow-tooltip>
      <template #default="{ row }">{{ JSON.stringify(row.detail ?? {}) }}</template>
    </el-table-column>
    <el-table-column prop="ip" label="IP" width="140">
      <template #default="{ row }"><span class="num">{{ row.ip || '-' }}</span></template>
    </el-table-column>
    <el-table-column label="User-Agent" min-width="220" show-overflow-tooltip>
      <template #default="{ row }">
        <span class="cell-sub">{{ uaLabel(row.userAgent) }}</span>
      </template>
    </el-table-column>
    <el-table-column label="时间" min-width="160">
      <template #default="{ row }"><span class="num">{{ fmtTime(row.createdAt) }}</span></template>
    </el-table-column>
  </el-table>
  <div class="bar pager" v-if="logTotal > logPageSize">
    <el-pagination
      background
      layout="total, prev, pager, next, jumper"
      :total="logTotal"
      :page-size="logPageSize"
      :current-page="logPage"
      @current-change="goLogPage"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { apiAdminLogs } from '@/api/admin';
import { fmtTime } from '@/utils/format';

const props = defineProps<{
  /** 是否处于「操作日志」子页（切到该子页时自动刷新一次） */
  active: boolean;
}>();

const logs = ref<Array<{ id: number; username: string | null; action: string; detail: unknown; ip: string | null; userAgent: string | null; createdAt: string }>>([]);
const logsLoading = ref(false);
/** 操作日志分页（服务端分页，默认每页 20 条） */
const logPage = ref(1);
const logPageSize = 20;
const logTotal = ref(0);

async function loadLogs() {
  logsLoading.value = true;
  try {
    const page = await apiAdminLogs({ page: logPage.value, pageSize: logPageSize });
    logs.value = page.list;
    logTotal.value = page.total ?? page.list.length;
  } finally { logsLoading.value = false; }
}
function goLogPage(p: number) {
  logPage.value = p;
  loadLogs();
}

/** 把冗长的 UA 压成一眼能认出的「浏览器 / 系统」摘要，鼠标悬停看完整值 */
function uaLabel(ua?: string | null): string {
  if (!ua) return '-';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl\//.test(ua) ? 'curl'
    : /PostmanRuntime/.test(ua) ? 'Postman'
    : '其他';
  const os =
    /Windows NT 10/.test(ua) ? 'Windows 10/11'
    : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} · ${os}` : browser;
}

onMounted(() => {
  loadLogs();
});

// 切到「操作日志」子页时自动刷新一次
watch(() => props.active, (v) => {
  if (v && !logsLoading.value) loadLogs();
});
</script>

<style scoped>
.bar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.bar-sub { font-size: 12px; color: #a08a60; }
.pager { justify-content: center; }
.cell-sub { font-size: 11px; color: #a08a60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
</style>