import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/** 用户持仓（按用户+股票唯一，累计均摊成本） */
const Holding = sequelize.define('Holding', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
  quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, comment: '持仓股数' },
  frozenQuantity: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
    field: 'frozen_quantity',
    comment: '挂卖单冻结的股数',
  },
  avgCost: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0, field: 'avg_cost' },
}, {
  tableName: 'holdings',
  indexes: [{ unique: true, fields: ['user_id', 'stock_id'] }],
});

export default Holding;
