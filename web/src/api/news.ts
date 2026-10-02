import { get, post } from './http';
import type { NewsItem, PagedNews, Direction, NewsReviewStatus } from '@/types';

/** 新闻板块列表（公开，分页，按最新排序。只含已通过审核且未过期的新闻） */
export const apiNewsList = (params?: { stockId?: number; page?: number; pageSize?: number }) =>
  get<PagedNews>('/news', params ?? {});

/**
 * 发布新闻（操作员/高级操作员/管理员）。
 * 返回 pending=true 表示「已提交待审核」（普通操作员），此时不会影响股价；
 * pending=false 表示已立即生效（高级操作员及以上免审核）。
 */
export const apiPublishNews = (data: {
  title: string;
  sourceUrl: string;
  direction: Direction;
  strength: number;
  stockIds: number[];
}) => post<{ id: number; expiresAt: string | null; reviewStatus: NewsReviewStatus; pending: boolean }>(
  '/operator/news', data
);

/** 操作员视角的新闻列表：含自己提交的待审新闻与全部已通过/已驳回的新闻 */
export const apiOperatorNews = () => get<NewsItem[]>('/operator/news');

/**
 * 我提交的新闻：**服务端按 publisherId 过滤**，只返回自己发的（含待审/已驳回）。
 * 不要再用 apiOperatorNews() 在前端自己筛：那个接口有 limit 200 且是全站最近 200 条，
 * 自己发的新闻会被挤出窗口，表现为「我提交的新闻是空的」。
 */
export const apiMyNews = () => get<NewsItem[]>('/operator/news/mine');

export const apiVoteNews = (newsId: number, direction: Direction, multiplier: number) =>
  post<unknown>(`/operator/news/${newsId}/vote`, { direction, multiplier });

export const apiVoteStock = (stockId: number, direction: Direction, multiplier: number) =>
  post<unknown>('/operator/stock-vote', { stockId, direction, multiplier });

export interface MyVoteItem {
  id: number;
  targetType: 'NEWS' | 'STOCK';
  targetId: number;
  direction: Direction;
  multiplier: number;
  updatedAt: string;
}

export const apiMyVotes = () => get<MyVoteItem[]>('/operator/my-votes');
