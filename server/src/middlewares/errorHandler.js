import { AppError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/** 404 兜底 */
export function notFoundHandler(req, _res, next) {
  const err = new AppError(`接口不存在: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND');
  next(err);
}

/** 全局异常处理 */
export function errorHandler(err, req, res, _next) {
  // express-validator 抛出的参数校验错误
  if (Array.isArray(err) && err.length > 0 && err[0]?.msg) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: err[0].msg, data: null });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({ code: err.code, message: err.message, data: null });
  }

  // 已知 Sequelize 错误
  if (err?.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ code: 'CONFLICT', message: '数据已存在（唯一约束冲突）', data: null });
  }
  if (err?.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(400).json({ code: 'BAD_REQUEST', message: '关联数据不存在', data: null });
  }
  if (err?.name === 'SequelizeValidationError') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: err.errors?.[0]?.message || '数据校验失败', data: null });
  }

  logger.error(`未捕获异常 ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试', data: null });
}
