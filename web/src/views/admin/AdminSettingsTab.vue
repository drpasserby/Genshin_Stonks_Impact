<template>
  <!-- 系统开关与参数：按分组拆成侧边 TAB，避免一屏几十项挤在一起 -->
  <p class="panel-desc">
    全部设置存储在数据库，修改后<b>即时生效</b>，并反馈到注册 / 登录 / 交易 / 新闻 / 股价引擎等全部相关功能。
    标 <code class="k">开关</code> 的立即生效；<code class="k">数值</code> 项修改后下一步周期计算即采用新值。
    左侧分类可点，灰色数字是该类下的项数。
  </p>

  <div v-loading="settingsLoading" class="settings-layout">
    <!-- 左侧分组导航 -->
    <div class="settings-nav">
      <div
        v-for="t in settingsTabs"
        :key="t.name"
        class="sn-item"
        :class="{ active: settingsTab === t.name }"
        @click="settingsTab = t.name"
      >
        <span class="sn-dot" aria-hidden="true" />
        <span class="sn-label">{{ t.label }}</span>
        <span class="sn-count">{{ t.count }}</span>
      </div>
    </div>

    <!-- 右侧当前分组 -->
    <div class="settings-body">
      <div class="sb-head">
        <h4>{{ settingsTabMeta.label }}</h4>
        <p>{{ settingsTabMeta.desc }}</p>
        <!-- ★ 立即抓取：市场情绪每 3 小时才自动跑一次，测试/应急时需要手动触发 -->
        <el-button
          v-if="settingsTab === '市场情绪'"
          type="primary"
          size="small"
          :icon="Promotion"
          :loading="ngaRunning"
          @click="runNgaNow"
        >{{ ngaRunning ? '抓取中…' : '立即抓取' }}</el-button>
        <!-- ★ 抓取快照下载：手动抓取会顺手生成（01 原文 + 03 总结论提示词 + 06 本轮汇总，去重合并） -->
        <el-tooltip
          v-if="settingsTab === '市场情绪'"
          content="下载最近一次「立即抓取」生成的快照：NGA 原文 + 总结论提示词 + 本轮汇总（去重合并，单文件）"
          placement="top"
        >
          <el-button
            size="small"
            :icon="Download"
            :loading="ngaDumping"
            @click="downloadNgaDumpNow"
          >下载抓取快照</el-button>
        </el-tooltip>
      </div>

      <el-alert
        v-if="settingsTab === '市场情绪' && ngaRunMsg"
        class="nga-run-alert"
        :type="ngaRunMsgType" :closable="false" show-icon
        :title="ngaRunMsg"
      />

      <div class="setting-list">
        <div v-for="s in settingsTabMeta.items" :key="s.key" class="setting-item">
          <div class="si-main">
            <div class="si-label">
              {{ s.label }}
              <code class="k">{{ s.key }}</code>
            </div>
            <div class="si-desc">{{ s.description }}</div>
          </div>
          <div class="si-ctrl">
            <!-- 开关 -->
            <el-switch
              v-if="s.type === 'bool'"
              :model-value="s.value === '1'"
              :loading="savingSetting === s.key"
              active-text="开"
              inactive-text="关"
              inline-prompt
              @change="(v: string | number | boolean) => saveSetting(s, v ? '1' : '0')"
            />
            <!-- 数值 -->
            <template v-else-if="s.type === 'number'">
              <el-input-number
                :model-value="Number(s.value)"
                :min="s.min ?? undefined"
                :max="s.max ?? undefined"
                :step="s.step ?? 1"
                size="small"
                controls-position="right"
                style="width:150px"
                :disabled="savingSetting === s.key"
                @change="(v: number | undefined) => saveSetting(s, String(v ?? 0))"
              />
              <span class="si-unit">{{ s.unit }}</span>
            </template>
            <!-- 只读（脚本自动回写的运行状态） -->
            <template v-else-if="s.readonly">
              <div class="si-readonly" :class="{ bad: isHealthBad(s) }">{{ s.value || '（尚无数据）' }}</div>
            </template>
            <!-- 敏感项：密钥 / Cookie（不回显，留空表示不改） -->
            <template v-else-if="s.secret">
              <el-input
                v-model="s.draft"
                type="password"
                show-password
                clearable
                :placeholder="s.value ? '已配置（留空＝不修改）' : (s.placeholder ?? '')"
                style="width:420px"
              />
              <el-button
                size="small"
                type="primary"
                plain
                :loading="savingSetting === s.key"
                @click="saveSetting(s, s.draft ?? '')"
              >保存</el-button>
            </template>
            <!-- 账号选择（如「结论新闻的发布者」） -->
            <template v-else-if="s.type === 'user'">
              <el-select
                :model-value="s.value"
                filterable
                clearable
                placeholder="留空 = 自动取第一个超级管理员"
                style="width:300px"
                :disabled="savingSetting === s.key"
                @change="(v: string) => saveSetting(s, v ?? '')"
              >
                <el-option v-for="o in (s.options ?? [])" :key="o.value" :label="o.label" :value="o.value" />
                <el-option v-if="s.value && !(s.options ?? []).some(o => o.value === s.value)"
                  :label="`账号已不存在（ID ${s.value}）`" :value="s.value" />
              </el-select>
            </template>
            <!-- 普通文本：单行 / 多行 -->
            <template v-else>
              <el-input
                v-model="s.draft"
                :type="s.multiline === false ? 'text' : 'textarea'"
                :rows="s.multiline === false ? undefined : 2"
                :maxlength="s.maxLength ?? 500"
                :show-word-limit="s.multiline !== false"
                :placeholder="s.placeholder ?? ''"
                style="width:420px"
              />
              <el-button
                size="small"
                type="primary"
                plain
                :loading="savingSetting === s.key"
                @click="saveSetting(s, s.draft ?? '')"
              >保存</el-button>
            </template>
          </div>
        </div>
      </div>

      <el-alert
        v-if="settingsTab === '交易控制'"
        type="info" :closable="false" show-icon style="margin-top:12px"
        title="提示：撮合周期改动后 K 线档位标签会同步变化（例如 10 分钟改为 2 分钟，新 K 线记为 2m），历史档位数据保留不会丢失。" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, Download } from '@element-plus/icons-vue';
import { apiAdminSettings, apiAdminUpdateSetting, apiAdminNgaRun, apiAdminNgaDump, type SystemSettingItem } from '@/api/admin';
import { useUserStore } from '@/stores/user';
import { useSystemStore } from '@/stores/system';

const store = useUserStore();
const sysStore = useSystemStore();

const settings = ref<SystemSettingItem[]>([]);
const settingsLoading = ref(false);
const savingSetting = ref('');

/**
 * 分组的补充说明与图标（分组名与后端 SETTING_SCHEMA 的 group 一一对应）。
 * 「运行状态」不单独占一个 TAB，直接并到「市场情绪」里，免得两个 TAB 抢注意力。
 */
const GROUP_META: Record<string, { icon: string; desc: string }> = {
  '注册与账号': { icon: '👤', desc: '自助注册、设备限制、登录开关。关掉「允许登录」等于进入维护模式（超管不受影响）。' },
  '交易控制': { icon: '📈', desc: '撮合周期、波动率、涨跌幅上限、持有周期与下单限流。改动会影响全站价格走势，调之前先想清楚。' },
  '新闻与投票': { icon: '📰', desc: '人工新闻的发布/投票开关与新闻有效期（按周期数计）。' },
  '市场情绪': { icon: '📡', desc: '从社区（当前是 NGA）自动抓取讨论、用 AI 总结成情绪，并决定它如何影响股价。含抓取参数、Gemini 密钥与模型、情绪如何写入，以及定价开关/权重/有效时长，最后是每轮运行状态。改完即时生效，不必重启。' },
  '经济参数': { icon: '💰', desc: '新用户初始摩拉等经济参数，改完只影响之后新建的账号。' },
  '指数基金': { icon: '🧺', desc: '基金净值收敛、溢价与「基金→角色」压力传导、成分股数量限制。' },
  '系统性能': { icon: '📊', desc: 'CPU/内存/磁盘的持续采样设置，数据只存在内存里，不落库。' },
  '数据维护': { icon: '🧹', desc: '周期 K 线的保留天数，每天 04:00 后分批清理。' },
  '排行榜': { icon: '🏆', desc: '总资产榜（可用摩拉 + 挂单冻结摩拉 + Σ(持仓股数 × 现价)）的开关与刷新频率。' },
  '站点公告': { icon: '📣', desc: '全站顶部横幅文案，留空不显示。' },
};

/** 把「xx · 运行状态」并进主分组，返回展示用的分组名 */
function groupOf(s: SystemSettingItem): string {
  const m = /^(.*?)\s*·\s*运行状态$/.exec(s.group);
  return m ? m[1] : s.group;
}

/**
 * 面板上不展示的运行状态项（2026-09-18 按站主要求隐藏）。
 *   · nga_health_status   「最近一轮结果」—— 超长文本，占地方且与下面的失败红字重复；
 *   · nga_health_last_run 「最近一轮时间」—— 与「最近成功时间」看着像重复信息。
 * ★ 注意：这两项**仍然由后端下发、也仍然保留在 settings 里**，
 *   因为「立即抓取」要靠它们轮询判断本轮跑完没有（见 runNgaNow）。
 *   这里只是不渲染成表格行。
 */
const HIDDEN_HEALTH_KEYS = new Set(['nga_health_status', 'nga_health_last_run']);

/** 分组 TAB（顺序 = 后端 schema 定义顺序；运行状态自动并入「市场情绪」组） */
const settingsTabs = computed(() => {
  const map = new Map<string, SystemSettingItem[]>();
  for (const s of settings.value) {
    if (HIDDEN_HEALTH_KEYS.has(s.key)) continue;
    const g = groupOf(s);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(s);
  }
  return [...map.entries()].map(([name, items]) => ({
    name,
    label: `${GROUP_META[name]?.icon ?? '⚙️'} ${name}`,
    desc: GROUP_META[name]?.desc ?? '',
    count: items.length,
    items,
  }));
});

const settingsTab = ref('交易控制');
const settingsTabMeta = computed(() =>
  settingsTabs.value.find((t) => t.name === settingsTab.value) || settingsTabs.value[0]
    || { name: '', label: '', desc: '', count: 0, items: [] as SystemSettingItem[] });

/** 分组被删空或首次加载后，把当前 TAB 落到第一个有效分组 */
watch(settingsTabs, (tabs) => {
  if (tabs.length && !tabs.some((t) => t.name === settingsTab.value)) settingsTab.value = tabs[0].name;
});

/* ---- NGA「立即抓取」：调用后端 POST /admin/settings/nga-run ---- */
const ngaRunning = ref(false);
const ngaDumping = ref(false);
const ngaRunMsg = ref('');
const ngaRunMsgType = ref<'success' | 'warning' | 'error' | 'info'>('info');

/**
 * 下载「抓取快照」：后端 GET /admin/settings/nga-dump 返回裸文件流。
 * 快照是手动抓取（--dump）顺手生成的单文件：01 原文 + 03 总结论提示词 + 06 本轮汇总（去重合并）。
 * 用 blob + 临时 <a download> 触发浏览器下载（接口需要 JWT，不能用普通 <a href>）。
 */
async function downloadNgaDumpNow() {
  if (ngaDumping.value) return;
  ngaDumping.value = true;
  try {
    const { blob, filename } = await apiAdminNgaDump();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'nga-dump.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ngaRunMsgType.value = 'success';
    ngaRunMsg.value = `已下载抓取快照：${filename}`;
  } catch {
    // 后端没生成过快照时返回 404 + 中文说明，download() 已经把消息弹出来了
  } finally { ngaDumping.value = false; }
}

async function runNgaNow() {
  if (ngaRunning.value) return;
  ngaRunning.value = true;
  ngaRunMsg.value = '已触发，正在抓取 NGA 并调用 Gemini（约 3~30 秒）…';
  ngaRunMsgType.value = 'info';
  try {
    const res = await apiAdminNgaRun();
    // 轮询运行状态：脚本每轮会回写 nga_health_last_run / nga_health_status
    let last = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = await apiAdminSettings();
      const status = list.find((s) => s.key === 'nga_health_status')?.value ?? '';
      const runAt = list.find((s) => s.key === 'nga_health_last_run')?.value ?? '';
      if (runAt === last) continue;
      last = runAt;
      // 只认「本次触发之后」产生的状态
      if (status.includes('[NGA-SUCCESS]')) { ngaRunMsgType.value = 'success'; ngaRunMsg.value = status; break; }
      if (status.includes('[NGA-FAILED]')) { ngaRunMsgType.value = 'error'; ngaRunMsg.value = status; break; }
      if (status.includes('[NGA-PARTIAL]')) { ngaRunMsgType.value = 'warning'; ngaRunMsg.value = status; break; }
      if (status.includes('[NGA-DRYRUN]')) { ngaRunMsgType.value = 'info'; ngaRunMsg.value = status; break; }
    }
    if (!last) {
      ngaRunMsgType.value = 'warning';
      ngaRunMsg.value = '已触发，但 80 秒内没等到结果。请查看「市场情绪 → 最近成功时间」，或查 nga_analysis_log 表。';
    }
    await loadSettings();   // 让状态字段显示最新值
  } catch {
    ngaRunMsgType.value = 'error';
    ngaRunMsg.value = '触发失败（见控制台/接口返回）。若提示已在运行，等它结束后再点。';
  } finally { ngaRunning.value = false; }
}

async function loadSettings() {
  if (!store.isRoot) return;
  settingsLoading.value = true;
  try {
    const list = await apiAdminSettings();
    // 文本类配置额外准备一份编辑草稿，避免边输边生效；
    // 敏感项（密钥/Cookie）草稿一律留空：后端只给掩码，保存空值即「不修改」
    settings.value = list.map((s) => (s.type === 'text'
      ? { ...s, draft: s.secret || s.readonly ? '' : s.value }
      : s));
  } finally { settingsLoading.value = false; }
}

/** 统一的保存入口：开关 / 数值 / 文本 / 敏感项都走这里 */
async function saveSetting(row: SystemSettingItem, value: string) {
  // 敏感项留空 = 不改（后端本来也不会回显真值，留空提交会覆盖成空串，必须拦在前端）
  if (row.secret && !value) {
    ElMessage.info(`「${row.label}」未修改（留空即保持原值）`);
    return;
  }
  const prev = row.value;
  savingSetting.value = row.key;
  try {
    const res = await apiAdminUpdateSetting(row.key, value);
    row.value = res.value;
    if (res.unchanged) {
      ElMessage.info(`「${row.label}」未修改`);
    } else {
      ElMessage.success(`「${row.label}」已更新并即时生效`);
    }
    if (row.type === 'text') row.draft = row.secret ? '' : res.value;
    if (row.key === 'announcement') sysStore.fetchMeta(); // 同步全站公告横幅
  } catch {
    row.value = prev;       // 失败回滚显示值
    if (row.type === 'text') row.draft = row.secret ? '' : prev;
  } finally { savingSetting.value = ''; }
}

/** NGA 运行状态里，把「失败」类结果标红，方便扫一眼就看出来 */
function isHealthBad(s: SystemSettingItem) {
  const v = String(s.value ?? '');
  return s.readonly && (v.includes('失败') || v.includes('COOKIE_EXPIRED'));
}

onMounted(() => {
  loadSettings();
});
</script>

<style scoped>
.panel-desc { margin: 0 0 10px; font-size: 12px; color: #a08a60; line-height: 1.8; }
.k { font-family: 'Consolas', monospace; font-size: 12px; color: var(--ts-gold-dark); background: rgba(201,162,75,0.12); padding: 2px 6px; border-radius: 4px; }

/* ---- 系统控制面板：分组设置项（左侧分组导航 + 右侧列表） ---- */
.settings-layout { display: flex; gap: 14px; align-items: flex-start; }
.settings-nav {
  flex: none; width: 172px; display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--ts-card-border); border-radius: 10px; padding: 6px;
  background: rgba(255,255,255,0.35); position: sticky; top: 8px;
}
.sn-item {
  display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-radius: 7px;
  font-size: 12.5px; color: #8b7752; cursor: pointer; line-height: 1.2;
  transition: background .15s, color .15s;
}
.sn-item:hover { background: rgba(201,162,75,0.12); color: var(--ts-gold-dark); }
.sn-item.active { background: rgba(201,162,75,0.20); color: var(--ts-gold-dark); font-weight: 700; }
.sn-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .5; flex: none; }
.sn-item.active .sn-dot { opacity: 1; }
.sn-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sn-count {
  flex: none; font-size: 10.5px; color: #bba98a; background: rgba(0,0,0,0.05);
  border-radius: 999px; padding: 1px 6px; font-family: 'Consolas', monospace;
}
.settings-body { flex: 1; min-width: 0; }
.sb-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.sb-head h4 { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--ts-gold-dark); }
.sb-head p { margin: 0; flex: 1; min-width: 220px; font-size: 11.5px; color: #a08a60; line-height: 1.7; }
.nga-run-alert { margin-bottom: 8px; }
@media (max-width: 900px) {
  .settings-layout { flex-direction: column; }
  .settings-nav { width: 100%; flex-direction: row; flex-wrap: wrap; position: static; }
  .sn-item { padding: 6px 8px; }
  .sn-count { display: none; }
}
.setting-list { display: flex; flex-direction: column; gap: 6px; }
.setting-item {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 10px 12px; border: 1px solid #efe6d2; border-radius: 8px;
  background: rgba(255, 255, 255, 0.55); flex-wrap: wrap;
}
.si-main { flex: 1 1 300px; min-width: 240px; }
.si-label { font-size: 13px; font-weight: 600; color: var(--ts-ink); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.si-desc { font-size: 11px; color: #a08a60; line-height: 1.7; margin-top: 3px; }
.si-ctrl { display: flex; align-items: center; gap: 8px; flex: none; }
.si-unit { font-size: 11px; color: #a08a60; }
/* NGA 运行状态等只读项：等宽字体便于对齐数字 */
.si-readonly {
  font-size: 12px; color: #d8c9a8; font-family: ui-monospace, Consolas, monospace;
  background: rgba(255,255,255,.04); border: 1px solid rgba(200,170,110,.25);
  border-radius: 4px; padding: 4px 10px; max-width: 420px; word-break: break-all;
}
.si-readonly.bad { color: #ff9a8b; border-color: rgba(255,120,100,.5); background: rgba(255,80,60,.08); }
</style>