import { get, post } from './http';
import type { OrderItem, TradeItem, HoldingItem, AccountSummary, Side, OrderType } from '@/types';

export interface PlaceOrderParams {
  stockId: number;
  side: Side;
  type: OrderType;
  price?: number | null;
  quantity: number;
}

export interface PlaceOrderResult {
  order: OrderItem;
  trade: {
    id: number;
    price: number;
    quantity: number;
    /** 成交金额（未扣税） */
    amount: number;
    /** 卖方印花税（买入为 0） */
    fee: number;
    /** 实际到账 = amount − fee */
    netAmount: number;
    side: Side;
  } | null;
  message: string;
}

export const apiPlaceOrder = (data: PlaceOrderParams) => post<PlaceOrderResult>('/user/orders', data);
export const apiMyOrders = (status?: string) => get<OrderItem[]>('/user/orders', status ? { status } : undefined);
export const apiCancelOrder = (id: number) => post<OrderItem>(`/user/orders/${id}/cancel`);
export const apiAccount = () => get<AccountSummary>('/user/account');
export const apiHoldings = () => get<HoldingItem[]>('/user/holdings');
export const apiTrades = (params?: { stockId?: number; page?: number; pageSize?: number }) =>
  get<{ total: number; list: TradeItem[] }>('/user/trades', params);
