import { get, put, del } from './http';
import type { Stock, KlinePoint, OrderBook, NewsItem, KlinePeriod } from '@/types';

export interface StockListParams {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  watch?: '0' | '1';
  /** 标的类型筛选：STOCK 角色 / FUND 指数基金；不传为全部 */
  type?: 'STOCK' | 'FUND';
}

export const apiStockList = (params: StockListParams) =>
  get<Stock[]>('/stocks', { ...params });

export const apiStockDetail = (id: number) => get<Stock>(`/stocks/${id}`);

export const apiKline = (id: number, period: KlinePeriod, limit = 200) =>
  get<KlinePoint[]>(`/stocks/${id}/kline`, { period, limit });

export const apiOrderBook = (id: number) => get<OrderBook>(`/stocks/${id}/orderbook`);

export const apiStockNews = (id: number) => get<NewsItem[]>(`/stocks/${id}/news`);

export const apiWatchlist = () => get<Stock[]>('/stocks/watchlist');
export const apiAddWatch = (stockId: number) => put<{ stockId: number }>(`/stocks/watchlist/${stockId}`);
export const apiRemoveWatch = (stockId: number) => del<{ stockId: number }>(`/stocks/watchlist/${stockId}`);
