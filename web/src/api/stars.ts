import { get } from './http';
import type { StarHoldingsResult } from '@/types';

/**
 * 明星持仓公开列表（公开接口，未登录也能看）。
 * 「明星」是自愿接受公开标签的身份组：公开范围仅限 标的 / 股数 / 市值 / 占总资产比例，
 * 不含成本价与盈亏，也不含现金余额 —— 这些由后端控制，前端只负责展示。
 * 后端有 60 秒内存缓存，前端刷新不会给数据库带来压力。
 */
export const apiStars = () => get<StarHoldingsResult>('/stars');
