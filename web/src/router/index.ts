import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '@/stores/user';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('@/views/LayoutView.vue'),
      children: [
        // 公开页面：未登录可浏览（行情 / 新闻 / 关于 / 个股详情）
        { path: '', name: 'market', component: () => import('@/views/MarketView.vue'), meta: { title: '行情', public: true } },
        { path: 'news', name: 'news', component: () => import('@/views/NewsBoardView.vue'), meta: { title: '新闻', public: true } },
        // 新闻页内含「新闻 / 市场情绪」两个标签页；旧链接重定向过去，避免书签失效
        { path: 'sentiment', redirect: { path: '/news', query: { tab: 'sentiment' } } },
        { path: 'rank', name: 'rank', component: () => import('@/views/RankView.vue'), meta: { title: '排行榜', public: true } },
        // 明星持仓公开页：公开信息，任何人（含未登录）都能看
        { path: 'stars', name: 'stars', component: () => import('@/views/StarHoldingsView.vue'), meta: { title: '明星持仓', public: true } },
        { path: 'about', name: 'about', component: () => import('@/views/AboutView.vue'), meta: { title: '关于', public: true } },
        { path: 'help', redirect: '/about' },
        { path: 'stock/:id', name: 'stock-detail', component: () => import('@/views/StockDetailView.vue'), meta: { title: '个股详情', public: true } },
        // 以下需要登录
        { path: 'me', name: 'me', component: () => import('@/views/UserCenterView.vue'), meta: { title: '我的' } },
        {
          path: 'operator',
          name: 'operator',
          component: () => import('@/views/OperatorPanelView.vue'),
          // 高级操作员也能进操作员面板（差别在发新闻是否免审核，不在能否进来）
          meta: { title: '操作员面板', roles: ['operator', 'senior_operator', 'admin'] },
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('@/views/AdminPanelView.vue'),
          meta: { title: '管理后台', roles: ['admin'] },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/** 登录守卫 + 角色守卫 */
router.beforeEach(async (to) => {
  const store = useUserStore();
  if (!store.ready) await store.fetchMe();

  if (to.meta.public) {
    if (store.isLoggedIn && to.name === 'login') return { name: 'market' };
    return true;
  }
  if (!store.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  // root（超级管理员）拥有全部权限，放行所有受限页面
  if (store.user?.role === 'root') return true;
  const roles = to.meta.roles as string[] | undefined;
  if (roles && store.user && !roles.includes(store.user.role)) {
    return { name: 'market' };
  }
  return true;
});

router.afterEach((to) => {
  const title = to.meta.title as string | undefined;
  document.title = title ? `${title} · 提瓦特证券交易所` : '提瓦特证券交易所';
});

export default router;
