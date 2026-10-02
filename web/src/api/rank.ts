import { get, put } from './http';
import type { RankResult } from '@/types';

/**
 * 排行榜（公开接口，未登录也能看）。
 * 数据来自后端「每个更新周期算一次 + 内存缓存」的快照，前端刷新不会给数据库带来压力。
 *
 * 榜单口径固定为总资产（可用摩拉 + 冻结摩拉 + 持仓市值），已合并原来的资金榜与市值榜，
 * 因此不再需要 type 参数。
 */
export const apiRank = () => get<RankResult>('/rank');

/** 设置「是否参与排行榜」（用户中心开关）。明星（star）强制参与，后端会返回 forced=true */
export const apiSetRankOptIn = (optIn: boolean) =>
  put<{ rankOptIn: boolean; forced?: boolean }>('/user/rank-opt-in', { optIn });
