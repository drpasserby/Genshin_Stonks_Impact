import { Router } from 'express';
import { register, login, me, registerRules, loginRules } from '../controllers/authController.js';
import { authRequired } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import { rateLimit } from '../middlewares/rateLimit.js';
import config from '../config/index.js';

const router = Router();

/** 注册限流：每 IP 每小时 N 次（防批量注册） */
const registerLimiter = rateLimit({
  scope: 'auth:register',
  capacity: config.rateLimit.register,
  windowMs: 60 * 60 * 1000,
  keyBy: 'ip',
  message: '注册过于频繁，请稍后再试',
});

/** 登录限流：每 IP+用户名 5 分钟 N 次（防口令爆破；换用户名仍受全站 IP 限流约束） */
const loginLimiter = rateLimit({
  scope: 'auth:login',
  capacity: config.rateLimit.login,
  windowMs: 5 * 60 * 1000,
  keyBy: 'ip+username',
  message: '登录尝试过于频繁，请稍后再试',
});

router.post('/register', registerLimiter, validate(registerRules), register);
router.post('/login', loginLimiter, validate(loginRules), login);
router.get('/me', authRequired, me);

export default router;
