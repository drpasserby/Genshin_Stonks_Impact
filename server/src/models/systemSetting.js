import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 系统设置（管理开关）。
 * 以 key-value 形式存放系统运行开关（如是否禁用注册、是否暂停交易），
 * 供管理员通过“控制面板”修改；由 settingService 统一读写（含缓存）。
 *
 * 注意：数据库列名使用 s_key / s_value（避免与 MySQL 保留字 KEY 冲突），
 * 这里必须显式声明 field 映射，保证与 sql/init.sql 完全一致。
 */
const SystemSetting = sequelize.define('SystemSetting', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  key: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 's_key' },
  value: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '0', field: 's_value' },
  description: { type: DataTypes.STRING(255), allowNull: true },
  updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'updated_by' },
}, {
  tableName: 'system_settings',
});

export default SystemSetting;
