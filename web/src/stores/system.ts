import { defineStore } from 'pinia';
import { get } from '@/api/http';

export interface SystemMeta {
  cycleMinutes: number;
  dailyCloseHour: number;
  startMora: number;
  maxChange: number;
  newsTtlCycles: number;
  allowRegistration: boolean; // 是否允许自助注册
  tradingEnabled: boolean;    // 是否允许交易
  rankEnabled: boolean;       // 是否开放排行榜（控制面板可关）
  announcement: string;       // 全站公告（空字符串 = 不显示）
  stampTaxRate: number;       // 卖方印花税税率，如 0.005 = 0.5%
  minHoldCycles: number;      // 最少持有周期数（0 = 不限制）
}

/** 全局系统状态（读 /api/meta，含管理员开关反馈） */
export const useSystemStore = defineStore('system', {
  state: () => ({
    meta: null as SystemMeta | null,
    ready: false,
  }),
  getters: {
    allowRegistration: (s) => s.meta?.allowRegistration ?? true,
    tradingEnabled: (s) => s.meta?.tradingEnabled ?? true,
    rankEnabled: (s) => s.meta?.rankEnabled ?? false,
    cycleMinutes: (s) => s.meta?.cycleMinutes ?? 10,
    announcement: (s) => (s.meta?.announcement ?? '').trim(),
    /** 卖方印花税税率（0.005） */
    stampTaxRate: (s) => s.meta?.stampTaxRate ?? 0.005,
    /** 印花税百分比文本，如 "0.5%" */
    stampTaxLabel: (s) => `${+(((s.meta?.stampTaxRate ?? 0.005) * 100).toFixed(4))}%`,
    /** 最少持有周期数（0 = 不限制） */
    minHoldCycles: (s) => Math.max(0, Number(s.meta?.minHoldCycles ?? 3)),
    /** 锁仓时长的可读文本，如 "30 分钟" */
    holdLockLabel: (s) => {
      const cycles = Math.max(0, Number(s.meta?.minHoldCycles ?? 3));
      if (!cycles) return '未限制';
      const mins = cycles * Math.max(1, Number(s.meta?.cycleMinutes ?? 10));
      if (mins < 60) return `${mins} 分钟`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
    },
    /** 当前 K 线档位标识，跟随撮合周期（如周期 2 分钟 → '2m'） */
    klinePeriod: (s) => `${s.meta?.cycleMinutes ?? 10}m`,
  },
  actions: {
    async fetchMeta() {
      try {
        this.meta = await get<SystemMeta>('/meta');
      } catch {
        /* 后端不可达：保持默认 */
      } finally {
        this.ready = true;
      }
      return this.meta;
    },
  },
});
