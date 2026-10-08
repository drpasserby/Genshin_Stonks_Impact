import { get, put, del } from './http';
import type { Direction, MarketSentimentItem, PagedSentiment } from '@/types';

/**
 * 市场情绪（社交平台情绪快照）
 *
 * 与 news 接口完全分开：这里是「脚本从社交平台抓取并自动总结」的情绪数据，
 * 只返回已通过审核的条目；待审数据只在 /admin/sentiments 下可见。
 */
export const apiSentimentList = (params?: { page?: number; pageSize?: number; platform?: string }) =>
  get<PagedSentiment>('/sentiment', params ?? {});

export const apiSentimentDetail = (id: number) => get<MarketSentimentItem>(`/sentiment/${id}`);

/* ---------------- 管理端（管理员/超管） ---------------- */

export interface AdminSentimentQuery extends Record<string, unknown> {
  reviewStatus?: '' | 'PENDING' | 'APPROVED' | 'REJECTED';
  platform?: string;
  page?: number;
  pageSize?: number;
}

export const apiAdminSentiments = (params?: AdminSentimentQuery) =>
  get<{ total: number; page: number; pageSize: number; pending: number; list: MarketSentimentItem[] }>(
    '/admin/sentiments', params ?? {});

export const apiAdminReviewSentiment = (id: number, action: 'approve' | 'reject', note = '') =>
  put<{ id: number; reviewStatus: string }>(`/admin/sentiments/${id}/review`, { action, note });

export const apiAdminDeleteSentiment = (id: number) => del<{ id: number }>(`/admin/sentiments/${id}`);
