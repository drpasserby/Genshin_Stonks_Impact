import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 委托单。
 * 撮合规则：买方限价 ≥ 当前股价 或 卖方限价 ≤ 当前股价 时，以当前股价成交；
 * 市价单下单即按当前股价立即成交；限价单进入队列，等待每周期撮合。
 */
const Order = sequelize.define('Order', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
  side: { type: DataTypes.ENUM('BUY', 'SELL'), allowNull: false },
  type: { type: DataTypes.ENUM('MARKET', 'LIMIT'), allowNull: false },
  price: { type: DataTypes.DECIMAL(14, 4), allowNull: true, comment: '限价；市价单为 NULL' },
  reservedAmount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
    field: 'reserved_amount',
    comment: '挂买单冻结的摩拉（限价×数量），撤单/成交时清算',
  },
  quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, comment: '委托股数' },
  filledQuantity: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
    field: 'filled_quantity',
    comment: '已成交数量（本系统整单成交，=0 或 =quantity）',
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'FILLED', 'CANCELLED'),
    allowNull: false,
    defaultValue: 'PENDING',
  },
}, {
  tableName: 'orders',
  indexes: [
    { fields: ['user_id', 'status'] },
    { fields: ['stock_id', 'status'] },
    { fields: ['status', 'type'] },
  ],
});

export default Order;
