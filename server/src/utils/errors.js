/** 业务异常：message 直接面向用户返回 */
export class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.isAppError = true;
  }
}

/** 便捷构造器 */
export const badRequest = (msg, code = 'BAD_REQUEST') => new AppError(msg, 400, code);
export const unauthorized = (msg = '请先登录', code = 'UNAUTHORIZED') => new AppError(msg, 401, code);
export const forbidden = (msg = '没有权限执行该操作', code = 'FORBIDDEN') => new AppError(msg, 403, code);
export const notFound = (msg = '资源不存在', code = 'NOT_FOUND') => new AppError(msg, 404, code);
export const conflict = (msg = '资源冲突', code = 'CONFLICT') => new AppError(msg, 409, code);
