import { validationResult } from 'express-validator';
import { badRequest } from '../utils/errors.js';

/** express-validator 规则执行器：校验失败抛 400 */
export function validate(rules) {
  return async (req, _res, next) => {
    await Promise.all(rules.map((r) => r.run(req)));
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    const first = errors.array()[0];
    return next(badRequest(first.msg, 'VALIDATION_ERROR'));
  };
}
