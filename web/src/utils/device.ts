/**
 * 设备标识（一设备一账号的「前端打标」部分）
 *
 * 说明：
 *  - deviceId 首次访问时生成并双写 localStorage + cookie，
 *    用户只清 localStorage 时还能从 cookie 复用，避免"清缓存"就变成新设备
 *  - 服务端才是最终防线（device_registrations 表 + 同 IP 每日上限），
 *    前端标记只是让用户早点看到提示、少一次无效请求
 */

const DEVICE_KEY = 'ts_device_id';
const REGISTERED_KEY = 'ts_device_registered';
const COOKIE_DEVICE = 'ts_did';
const COOKIE_REGISTERED = 'ts_registered';
const YEAR = 60 * 60 * 24 * 365;

function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 退路：老浏览器
  return (
    'd' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 12) +
    '-' +
    Math.random().toString(36).slice(2, 12)
  );
}

function readCookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string): void {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${YEAR}; SameSite=Lax`;
  } catch {
    /* 忽略：禁用 cookie 时仅靠 localStorage */
  }
}

/** 取设备号（没有就生成一个），自动双写两处 */
export function getDeviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能抛错 */
  }
  if (!id) id = readCookie(COOKIE_DEVICE);
  if (!id) id = uuid();

  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* 忽略 */
  }
  writeCookie(COOKIE_DEVICE, id);
  return id;
}

/** 本设备是否已经注册过账号（前端软提示用） */
export function isDeviceRegistered(): boolean {
  try {
    if (localStorage.getItem(REGISTERED_KEY) === '1') return true;
  } catch {
    /* 忽略 */
  }
  return readCookie(COOKIE_REGISTERED) === '1';
}

/** 注册成功后打标 */
export function markDeviceRegistered(): void {
  try {
    localStorage.setItem(REGISTERED_KEY, '1');
  } catch {
    /* 忽略 */
  }
  writeCookie(COOKIE_REGISTERED, '1');
}

/** 服务端明确告知该设备已注册时，也补上标记，避免反复尝试 */
export function markDeviceBlocked(): void {
  markDeviceRegistered();
}
