import { get, post } from './http';
import type { User } from '@/types';

export interface LoginResult {
  token: string;
  user: User;
}

export const apiRegister = (data: { username: string; password: string; nickname?: string }) =>
  post<LoginResult>('/auth/register', data);

export const apiLogin = (data: { username: string; password: string }) =>
  post<LoginResult>('/auth/login', data);

export const apiMe = () => get<User>('/auth/me');
