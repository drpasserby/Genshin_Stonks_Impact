import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 操作员倍率投票。可投给「某条新闻」(targetType=NEWS) 或「某只股票」(targetType=STOCK)。
 * multiplier 为 0.5~2.0 的倍率，direction 为看涨/看跌。
 */
const Vote = sequelize.define('Vote', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
  targetType: { type: DataTypes.ENUM('NEWS', 'STOCK'), allowNull: false, field: 'target_type' },
  targetId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'target_id' },
  direction: { type: DataTypes.ENUM('UP', 'DOWN'), allowNull: false },
  multiplier: { type: DataTypes.DECIMAL(4, 2), allowNull: false, comment: '倍率 0.5~2.0' },
}, {
  tableName: 'votes',
  indexes: [
    { unique: true, fields: ['user_id', 'target_type', 'target_id'] },
    { fields: ['target_type', 'target_id'] },
  ],
});

export default Vote;
