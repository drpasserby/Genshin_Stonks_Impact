import axios, { type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';
import type { ApiResponse } from '@/types';
import router from '@/router';
import { useUserStore } from '@/stores/user';
import { getDeviceId } from '@/utils/device';

/** axios 实例：统一 baseURL、token、设备号、错误处理 */
const http = axios.create({
  baseURL: '/api',
  timeout: 20000,
});

http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('ts_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  // 设备号：服务端据此做「一设备一账号」校验与限流身份判定
  cfg.headers['X-Device-Id'] = getDeviceId();
  return cfg;
});

http.interceptors.response.use(
  (resp) => {
    // 后端统一 { code, message, data }
    const body = resp.data as ApiResponse;
    if (body && typeof body === 'object' && 'code' in body && body.code !== 0) {
      ElMessage.error(body.message || '请求失败');
      return Promise.reject(new Error(body.message));
    }
    return resp;
  },
  (err) => {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message || '网络错误';
    if (status === 401) {
      ElMessage.error('登录已失效，请重新登录');
      const store = useUserStore();
      store.clear();
      if (router.currentRoute.value.path !== '/login') router.push('/login');
    } else {
      ElMessage.error(msg);
    }
    return Promise.reject(err);
  }
);

/** 泛型请求：直接取 data 字段 */
export async function request<T>(cfg: AxiosRequestConfig): Promise<T> {
  const resp = await http.request<ApiResponse<T>>(cfg);
  return resp.data.data;
}

export const get = <T>(url: string, params?: Record<string, unknown>) =>
  request<T>({ method: 'GET', url, params });
export const post = <T>(url: string, data?: unknown) =>
  request<T>({ method: 'POST', url, data });
export const put = <T>(url: string, data?: unknown) =>
  request<T>({ method: 'PUT', url, data });
export const del = <T>(url: string) => request<T>({ method: 'DELETE', url });

/**
 * 下载类请求：后端**直接返回文件流**（不套 { code, message, data } 信封），
 * 所以这里不能用 request<T>()，要自己拿 blob 并从 Content-Disposition 里取文件名。
 *
 * 出错时后端返回的仍是 JSON（会被 axios 包成 Blob），所以额外把它解出来提示给用户，
 * 否则前端只会看到一句含糊的「网络错误」。
 */
export async function download(url: string, params?: Record<string, unknown>) {
  try {
    const resp = await http.request<Blob>({ method: 'GET', url, params, responseType: 'blob' });
    const dispo = String((resp.headers as Record<string, string>)?.['content-disposition'] || '');
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(dispo);
    const plain = /filename="?([^";]+)"?/i.exec(dispo);
    const filename = utf8 ? decodeURIComponent(utf8[1]) : (plain ? plain[1] : 'download.txt');
    return { blob: resp.data as Blob, filename };
  } catch (err) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    if (data instanceof Blob) {
      let msg = '';
      try {
        const parsed = JSON.parse(await data.text()) as { message?: string };
        msg = String(parsed?.message || '');
      } catch { /* 不是 JSON：交给下面的全局处理 */ }
      if (msg) ElMessage.error(msg);
    }
    throw err;
  }
}

export default http;
