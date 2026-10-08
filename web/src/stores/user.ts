import { defineStore } from 'pinia';
import type { User } from '@/types';
import { apiLogin, apiRegister, apiMe } from '@/api/auth';
import { markDeviceRegistered } from '@/utils/device';

const TOKEN_KEY = 'ts_token';

function readToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export const useUserStore = defineStore('user', {
  state: () => ({
    token: readToken(),
    user: null as User | null,
    ready: false,
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    /** 能进操作员面板（操作员 / 高级操作员 / 管理员 / 超管） */
    isOperator: (s) =>
      s.user?.role === 'operator' ||
      s.user?.role === 'senior_operator' ||
      s.user?.role === 'admin' ||
      s.user?.role === 'root',
    isAdmin: (s) => s.user?.role === 'admin' || s.user?.role === 'root',
    isRoot: (s) => s.user?.role === 'root',
    /** 高级操作员（发新闻免审核） */
    isSeniorOperator: (s) => s.user?.role === 'senior_operator',
    /** 发布新闻是否免审核（高级操作员及以上；普通操作员发的新闻要等管理员审核） */
    publishWithoutReview: (s) =>
      s.user?.role === 'senior_operator' || s.user?.role === 'admin' || s.user?.role === 'root',
    /** 能否审核新闻（管理员 / 超管） */
    canReviewNews: (s) => s.user?.role === 'admin' || s.user?.role === 'root',
    /**
     * 能否执行删除类操作。
     * ★ 只有超级管理员可以：管理员对用户只能禁用、对新闻只能失效、对标的只能停牌/退市，
     *   成交记录则完全没有操作。前端的按钮显隐必须跟这条对齐（后端也有同样的守卫）。
     */
    canDelete: (s) => s.user?.role === 'root',
    /** 是否免卖方印花税（后端下发，不在前端重复判断身份组） */
    stampTaxExempt: (s) => s.user?.stampTaxExempt === true,
    /** 是否强制公开持仓（明星） */
    holdsPublic: (s) => s.user?.holdsPublic === true,
    mora: (s) => s.user?.mora ?? 0,
  },
  actions: {
    async login(username: string, password: string) {
      const res = await apiLogin({ username, password });
      this.token = res.token;
      this.user = res.user;
      localStorage.setItem(TOKEN_KEY, res.token);
    },
    async register(username: string, password: string, nickname?: string) {
      const res = await apiRegister({ username, password, nickname });
      this.token = res.token;
      this.user = res.user;
      localStorage.setItem(TOKEN_KEY, res.token);
      // 本设备已用掉唯一一次注册机会（前端打标，服务端另有权威记录）
      markDeviceRegistered();
    },
    async fetchMe() {
      if (!this.token) {
        this.ready = true;
        return null;
      }
      try {
        this.user = await apiMe();
      } catch {
        this.clear();
      } finally {
        this.ready = true;
      }
      return this.user;
    },
    setUser(user: User | null) {
      this.user = user;
    },
    clear() {
      this.token = '';
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
    },
  },
});
