import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 设备注册记录：一台设备只能注册一个账号。
 *
 * 为什么单独建表而不是在 users 上加字段：
 *  1) 设备号需要在「所有历史注册」中唯一 —— 账号被删除后，该设备仍应被拦截，
 *     否则「删号 → 重新注册」就能绕过限制；
 *  2) 不污染 users 表结构，便于按 IP 统计注册量；
 *  3) 记录注册时的 IP/UA，便于事后核查批量注册。
 */
const DeviceRegistration = sequelize.define('DeviceRegistration', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  deviceId: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'device_id' },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'user_id' },
  ip: { type: DataTypes.STRING(45), allowNull: true },
  userAgent: { type: DataTypes.STRING(255), allowNull: true, field: 'user_agent' },
  /** dev = 浏览器上报的真实设备号；auto = 由 IP+UA 推导的兜底设备号 */
  source: { type: DataTypes.ENUM('dev', 'auto'), allowNull: false, defaultValue: 'dev' },
}, {
  tableName: 'device_registrations',
  updatedAt: false,
  indexes: [{ fields: ['ip', 'created_at'] }],
});

export default DeviceRegistration;
