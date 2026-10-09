import config from '../config/index.js';

/**
 * 金额/价格工具。
 * MySQL DECIMAL 默认以字符串返回，所有数值计算在 JS 侧统一转 Number 并在写库前四舍五入到配置精度。
 */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

export const roundMora = (n) => round2(n);
export const roundPrice = (n) => round4(n);

/** DECIMAL 列读取值（可能为字符串/空）→ Number */
export const toNum = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

/** 保留两位小数的金额展示 */
export const fmtMora = (n) => toNum(n).toFixed(2);
