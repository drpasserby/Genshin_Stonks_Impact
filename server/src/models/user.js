import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';
import config from '../config/index.js';

/**
 * 用户：普通用户 user / 高级用户 vip / 明星 star / 操作员 operator /
 *       高级操作员 senior_operator / 管理员 admin / 超级管理员 root
 * root 拥有全部权限；admin 权限受约束（详见 adminController 权限矩阵与 constants/roles.js）。
 * ★ 新增身份组时必须同步：本文件 ENUM + sql/init.sql + constants/roles.js
 */
const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING(32), allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
  nickname: { type: DataTypes.STRING(32), allowNull: false },
  role: {
    type: DataTypes.ENUM('user', 'vip', 'star', 'operator', 'senior_operator', 'admin', 'root'),
    allowNull: false,
    defaultValue: 'user',
  },
  mora: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: config.business.startMora,
    comment: '可用摩拉（不包含冻结）',
  },
  frozenMora: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'frozen_mora',
    comment: '挂买单冻结的摩拉',
  },
  status: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1, comment: '1启用 0禁用 2已注销（逻辑删除）' },
  /**
   * 令牌版本号：JWT 里带 ver，校验时与库中比对。
   * 改密码时 +1 → 该用户所有已签发的 token 立即失效（强制重新登录）。
   * 这是无状态 JWT 实现「吊销」的标准做法，成本只有一列 + 一次比对。
   */
  tokenVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'token_version', comment: '令牌版本，改密码+1' },
  /**
   * 是否参与「资金/市值排行榜」：用户可在「我的」页面自行开关。
   * 关闭后该账号不会出现在排行榜中（排行榜只展示昵称与金额，不展示 ID）。
   */
  rankOptIn: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'rank_opt_in', comment: '是否参与排行榜' },
  /** 注册该账号的设备号（与 device_registrations 对应） */
  registerDevice: { type: DataTypes.STRING(64), allowNull: true, field: 'register_device', comment: '注册设备号' },
  lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at', comment: '最后登录时间' },
  lastLoginIp: { type: DataTypes.STRING(45), allowNull: true, field: 'last_login_ip', comment: '最后登录 IP' },
  lastLoginUa: { type: DataTypes.STRING(255), allowNull: true, field: 'last_login_ua', comment: '最后登录 User-Agent' },
}, {
  tableName: 'users',
  indexes: [{ fields: ['role'] }],
});

export default User;
