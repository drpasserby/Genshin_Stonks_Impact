<template>
  <div class="layout">
    <!-- 顶部栏 -->
    <header class="topbar">
      <div class="topbar-inner">
        <router-link to="/" class="brand">
          <span class="brand-mark">⚜️</span>
          <span class="brand-text">
            <b>提瓦特证券交易所</b>
            <small>角色模拟炒股</small>
          </span>
        </router-link>

        <nav class="desktop-only nav">
          <router-link to="/" class="nav-link" :class="{ active: route.path === '/' }">行情</router-link>
          <router-link to="/news" class="nav-link" :class="{ active: route.path === '/news' }">新闻</router-link>
          <router-link v-if="rankVisible" to="/rank" class="nav-link" :class="{ active: route.path === '/rank' }">排行榜</router-link>
          <router-link to="/about" class="nav-link" :class="{ active: route.path === '/about' }">关于</router-link>
          <template v-if="store.isLoggedIn">
            <router-link to="/me" class="nav-link" :class="{ active: route.path === '/me' }">我的</router-link>
            <router-link v-if="store.isOperator" to="/operator" class="nav-link">操作员</router-link>
            <router-link v-if="store.isAdmin" to="/admin" class="nav-link">管理</router-link>
          </template>
        </nav>

        <div class="user-box">
          <template v-if="store.isLoggedIn">
            <span class="mora-pill num"><b>{{ fmtBig(store.mora) }}</b> 摩拉</span>
            <el-dropdown trigger="click" @command="onCommand">
              <span class="user-chip">
                {{ store.user?.nickname || store.user?.username }}
                <el-tag
                  v-if="store.user?.role !== 'user'"
                  size="small"
                  effect="dark"
                  :type="roleTagType(store.user!.role)"
                  style="margin-left:4px"
                >
                  {{ roleLabel(store.user!.role) }}
                </el-tag>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="me">用户中心</el-dropdown-item>
                  <el-dropdown-item v-if="store.isOperator" command="operator">操作员面板</el-dropdown-item>
                  <el-dropdown-item v-if="store.isAdmin" command="admin">管理后台</el-dropdown-item>
                  <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
          <template v-else>
            <el-button type="primary" plain size="small" @click="router.push('/login')">登录 / 注册</el-button>
          </template>
        </div>
      </div>
    </header>

    <!-- 停市横幅 -->
    <div v-if="sysReady && !sysStore.tradingEnabled" class="halt-banner">
      ⛔ 系统暂停交易中（买卖/挂单/撤单均不可用），由超级管理员在控制面板设置
    </div>

    <!-- 全站公告（root 控制面板填写，留空则不显示） -->
    <div v-if="sysReady && sysStore.announcement" class="notice-banner">
      <el-icon class="nb-icon"><BellFilled /></el-icon>
      <span class="nb-text">{{ sysStore.announcement }}</span>
    </div>

    <!-- 内容区 -->
    <main class="layout-main">
      <router-view />
    </main>

    <!-- 手机底部导航：未登录仅显示行情/新闻/关于与登录入口 -->
    <nav class="mobile-only bottom-nav">
      <router-link to="/" class="bn-item" :class="{ active: route.path === '/' }">
        <el-icon><TrendCharts /></el-icon><span>行情</span>
      </router-link>
      <router-link to="/news" class="bn-item" :class="{ active: route.path === '/news' }">
        <el-icon><Tickets /></el-icon><span>新闻</span>
      </router-link>
      <router-link v-if="rankVisible" to="/rank" class="bn-item" :class="{ active: route.path === '/rank' }">
        <el-icon><Trophy /></el-icon><span>排行</span>
      </router-link>
      <router-link to="/about" class="bn-item" :class="{ active: route.path === '/about' }">
        <el-icon><QuestionFilled /></el-icon><span>关于</span>
      </router-link>
      <template v-if="store.isLoggedIn">
        <router-link to="/me" class="bn-item" :class="{ active: route.path === '/me' }">
          <el-icon><Wallet /></el-icon><span>我的</span>
        </router-link>
        <router-link v-if="store.isOperator" to="/operator" class="bn-item" :class="{ active: route.path === '/operator' }">
          <el-icon><EditPen /></el-icon><span>操作</span>
        </router-link>
        <router-link v-if="store.isAdmin" to="/admin" class="bn-item" :class="{ active: route.path === '/admin' }">
          <el-icon><Setting /></el-icon><span>管理</span>
        </router-link>
      </template>
      <router-link v-else to="/login" class="bn-item">
        <el-icon><User /></el-icon><span>登录</span>
      </router-link>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useSystemStore } from '@/stores/system';
import { BellFilled, Trophy } from '@element-plus/icons-vue';
// 说明：模板里用到的 TrendCharts / Tickets 等图标由 main.ts 全局注册，不需要逐个 import。
import { fmtBig, roleLabel, roleTagType } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const store = useUserStore();
const sysStore = useSystemStore();
const sysReady = computed(() => sysStore.ready);
/** 排行榜入口：meta 还没加载完时先显示（避免闪烁），加载后按控制面板开关决定 */
const rankVisible = computed(() => !sysStore.ready || sysStore.rankEnabled);

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    store.clear();
    router.push('/login');
  } else {
    router.push(`/${cmd}`);
  }
}

onMounted(() => {
  sysStore.fetchMeta();
});
</script>

<style scoped>
.layout { min-height: 100vh; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 100;
  background: linear-gradient(180deg, #f9efd8, #f2e3c2);
  border-bottom: 1px solid var(--ts-card-border);
  box-shadow: 0 2px 8px rgba(122, 92, 40, 0.10);
}
.topbar-inner {
  max-width: 1200px; margin: 0 auto; padding: 0 12px;
  height: 56px; display: flex; align-items: center; gap: 18px;
}
.brand { display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--ts-ink); }
.brand-mark { font-size: 24px; }
.brand-text b { display: block; font-size: 16px; color: var(--ts-gold-dark); letter-spacing: 1px; }
.brand-text small { display: block; font-size: 10px; color: var(--ts-ink-soft); letter-spacing: 2px; }

.nav { display: flex; gap: 4px; flex: 1; margin-left: 12px; }
.nav-link {
  padding: 6px 14px; border-radius: 8px; text-decoration: none;
  color: var(--ts-ink-soft); font-size: 14px; transition: all .15s;
}
.nav-link:hover { background: rgba(201, 162, 75, 0.15); }
.nav-link.active { background: var(--ts-gold); color: #fff; font-weight: 600; }

.user-box { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.mora-pill {
  background: rgba(201, 162, 75, 0.16); border: 1px solid var(--ts-gold-light);
  padding: 4px 10px; border-radius: 999px; font-size: 12px; color: var(--ts-gold-dark);
}
.user-chip { cursor: pointer; font-size: 14px; display: inline-flex; align-items: center; }

.layout-main { flex: 1; }

.halt-banner {
  background: linear-gradient(90deg, #7d2f2c, #a0413e);
  color: #ffe9d6;
  text-align: center;
  font-size: 13px;
  padding: 7px 12px;
  letter-spacing: 0.5px;
}

.notice-banner {
  display: flex; align-items: flex-start; justify-content: center; gap: 8px;
  background: linear-gradient(90deg, #fdf3d8, #f8e6b8);
  border-bottom: 1px solid var(--ts-card-border);
  color: #7a5c28; font-size: 13px; line-height: 1.7;
  padding: 8px 16px; text-align: center;
}
.nb-icon { color: var(--ts-gold-dark); margin-top: 3px; flex: none; }
.nb-text { white-space: pre-wrap; word-break: break-word; max-width: 1000px; }

.bottom-nav {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
  display: flex; background: #f9efd8; border-top: 1px solid var(--ts-card-border);
  padding-bottom: env(safe-area-inset-bottom);
}
.bn-item {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 0 6px; text-decoration: none; color: var(--ts-ink-soft); font-size: 11px;
}
.bn-item .el-icon { font-size: 20px; }
.bn-item.active { color: var(--ts-gold-dark); font-weight: 700; }
</style>
