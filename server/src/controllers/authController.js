import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { body } from 'express-validator';
import { User, OperationLog, DeviceRegistration } from '../models/index.js';
import sequelize from '../config/db.js';
import config from '../config/index.js';
import { signToken } from '../utils/jwt.js';
import { ok } from '../utils/response.js';
import { badRequest, unauthorized, conflict, forbidden } from '../utils/errors.js';
import { toNum } from '../utils/money.js';
import {
  getSettingBool, SETTING_KEYS, getRuntime,
  isRegistrationAllowed, isDeviceLimitEnabled, isLoginAllowed, getStartMora,
} from '../services/settingService.js';
import { ROLE_LABELS, isStampTaxExempt, mustPublicizeHoldings } from '../constants/roles.js';
import { logContext, deviceKeyOf, clientIp, clientUa } from '../utils/requestInfo.js';

export const registerRules = [
  body('username').trim().isLength({ min: 3, max: 32 }).withMessage('用户名长度须为 3~32 位'),
  body('password').isLength({ min: 6, max: 64 }).withMessage('密码长度须为 6~64 位'),
  body('nickname').optional().trim().isLength({ min: 1, max: 32 }).withMessage('昵称最长 32 字符'),
];

export async function register(req, res, next) {
  try {
    // 系统开关：是否允许自助注册（存在 DB，root 可在控制面板切换）
    if (!(await isRegistrationAllowed())) throw forbidden('系统暂未开放注册，请联系管理员开通账号');

    const { username, password, nickname } = req.body;

    /* ---------- 一设备一账号（服务端校验，前端localStorage标记只是第一道） ----------
     * 可通过 root 控制面板的「一设备一账号限制」临时关闭（办活动放宽时用） */
    const deviceLimitOn = await isDeviceLimitEnabled();
    const device = deviceLimitOn ? deviceKeyOf(req, { autoFallback: config.register.autoFallback }) : null;
    if (deviceLimitOn && !device && config.register.requireDeviceId) {
      throw badRequest('无法识别设备信息，请使用浏览器正常访问后重试');
    }

    const exists = await User.findOne({ where: { username } });
    if (exists) throw conflict('用户名已被注册');

    const ip = clientIp(req);
    const ua = clientUa(req);

    if (deviceLimitOn && device) {
      const used = await DeviceRegistration.findOne({ where: { deviceId: device.deviceId } });
      if (used) throw forbidden('该设备已注册过账号，一台设备仅可注册一个账号');
    }

    // 同 IP 每天注册上限（防止「清缓存 / 换设备号」无限刷号）
    if (deviceLimitOn && config.register.maxPerIpPerDay > 0 && ip) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const cnt = await DeviceRegistration.count({ where: { ip, createdAt: { [Op.gt]: since } } });
      if (cnt >= config.register.maxPerIpPerDay) {
        throw forbidden(`当前网络今日注册已达上限（${config.register.maxPerIpPerDay} 个），请明天再试`);
      }
    }

    // 用户与设备记录同一事务：设备号唯一约束是最终防线，并发注册也只可能成功一个
    let user;
    try {
      user = await sequelize.transaction(async (t) => {
        const u = await User.create({
          username,
          passwordHash: await bcrypt.hash(password, 10),
          nickname: nickname || username,
          role: 'user',
          mora: await getStartMora(),   // 初始摩拉由控制面板配置
          registerDevice: device?.deviceId ?? null,
          lastLoginAt: new Date(),
          lastLoginIp: ip,
          lastLoginUa: ua,
        }, { transaction: t });

        if (device) {
          await DeviceRegistration.create({
            deviceId: device.deviceId,
            userId: u.id,
            ip,
            userAgent: ua,
            source: device.source,
          }, { transaction: t });
        }
        return u;
      });
    } catch (err) {
      if (err?.name === 'SequelizeUniqueConstraintError') {
        const fields = Object.keys(err.fields || {});
        if (fields.includes('device_id') || String(err.message).includes('device_id')) {
          throw forbidden('该设备已注册过账号，一台设备仅可注册一个账号');
        }
        throw conflict('用户名已被注册');
      }
      throw err;
    }

    const token = signToken({ sub: user.id, role: user.role, ver: user.tokenVersion ?? 0 });
    OperationLog.create({
      userId: user.id,
      action: 'REGISTER',
      detail: JSON.stringify({
        username: user.username,
        deviceId: device?.deviceId ?? null,
        deviceSource: device?.source ?? null,
      }),
      ...logContext(req),
    }).catch(() => {});
    ok(res, { token, user: serializeUser(user) }, '注册成功');
  } catch (err) { next(err); }
}

export const loginRules = [
  body('username').trim().notEmpty().withMessage('请输入用户名'),
  body('password').notEmpty().withMessage('请输入密码'),
];

export async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username } });

    // 登录失败也留痕（限流中间件在前，所以不会被爆破请求刷爆日志）
    const failLog = (reason, userId = null) => {
      OperationLog.create({
        userId,
        action: 'LOGIN_FAIL',
        detail: JSON.stringify({ username, reason }),
        ...logContext(req),
      }).catch(() => {});
    };

    if (!user) {
      // 用户不存在时也跑一次 bcrypt，避免通过响应耗时判断用户名是否存在
      await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      failLog('USER_NOT_FOUND');
      throw unauthorized('用户名或密码错误');
    }
    if (user.status !== 1) {
      const deleted = Number(user.status) === 2; // 2 = 已注销（逻辑删除）
      failLog(deleted ? 'ACCOUNT_DELETED' : 'ACCOUNT_DISABLED', user.id);
      throw unauthorized(deleted ? '账号已注销，如需恢复请联系管理员' : '账号已被禁用，请联系管理员');
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      failLog('BAD_PASSWORD', user.id);
      throw unauthorized('用户名或密码错误');
    }

    // 维护模式：控制面板关闭「允许普通用户登录」后，仅超级管理员可登录
    if (!(await isLoginAllowed()) && user.role !== 'root') {
      failLog('LOGIN_LOCKED', user.id);
      throw forbidden('系统维护中，暂不开放登录，请稍后再试');
    }

    const token = signToken({ sub: user.id, role: user.role, ver: user.tokenVersion ?? 0 });

    // 用户表只存「最后一次」登录来源，方便管理端一眼看到；
    // 完整历史仍然落在 operation_logs（两处成本都很低，各司其职）
    const ctx = logContext(req);
    user.lastLoginAt = new Date();
    user.lastLoginIp = ctx.ip;
    user.lastLoginUa = ctx.userAgent;
    await user.save({ fields: ['lastLoginAt', 'lastLoginIp', 'lastLoginUa'] }).catch(() => {});

    // 操作审计：记录登录时间、IP、User-Agent
    OperationLog.create({
      userId: user.id,
      action: 'LOGIN',
      detail: JSON.stringify({ username: user.username }),
      ...ctx,
    }).catch(() => {});
    ok(res, { token, user: serializeUser(user) }, '登录成功');
  } catch (err) { next(err); }
}

export async function me(req, res, next) {
  try {
    const user = await User.findByPk(req.user.id);
    ok(res, serializeUser(user));
  } catch (err) { next(err); }
}

/** 脱敏输出 */
export function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    role: u.role,
    /** 身份组的派生能力：由后端下发，前端不必自己维护「哪个身份有什么特权」的映射 */
    roleLabel: ROLE_LABELS[u.role] ?? u.role,
    stampTaxExempt: isStampTaxExempt(u.role),
    holdsPublic: mustPublicizeHoldings(u.role),
    mora: toNum(u.mora),
    frozenMora: toNum(u.frozenMora),
    status: u.status,
    /** 是否参与资金/市值排行榜（用户中心可自行开关；明星强制参与） */
    rankOptIn: u.rankOptIn !== false,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    lastLoginIp: u.lastLoginIp || null,
    lastLoginUa: u.lastLoginUa || null,
  };
}
