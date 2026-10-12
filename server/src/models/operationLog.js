import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/** 操作日志（登录、下单、管理操作等） */
const OperationLog = sequelize.define('OperationLog', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'user_id' },
  action: { type: DataTypes.STRING(64), allowNull: false },
  detail: { type: DataTypes.TEXT, allowNull: true, comment: 'JSON 细节' },
  ip: { type: DataTypes.STRING(45), allowNull: true },
  userAgent: { type: DataTypes.STRING(255), allowNull: true, field: 'user_agent', comment: 'User-Agent' },
}, {
  tableName: 'operation_logs',
  indexes: [{ fields: ['user_id', 'created_at'] }, { fields: ['action'] }],
});

export default OperationLog;
