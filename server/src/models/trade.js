import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/** 成交记录（撮合成功后写入） */
const Trade = sequelize.define('Trade', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  orderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'order_id' },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
  side: { type: DataTypes.ENUM('BUY', 'SELL'), allowNull: false },
  price: { type: DataTypes.DECIMAL(14, 4), allowNull: false, comment: '成交价(=撮合时当前股价)' },
  quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, comment: '成交金额(摩拉，未扣税)' },
  /**
   * 卖方印花税（摩拉）。买入恒为 0。
   * 成交额与税额分开存：amount 保持「市场口径」的成交额不变（用于统计/成交量口径），
   * fee 记录实际回收的摩拉，卖方实际到账 = amount − fee。
   */
  fee: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, comment: '卖方印花税(摩拉)' },
  /**
   * 卖出份额的成本 = 成交时的移动加权均价 × 数量（买入恒为 0）。
   * 与 holdings.avg_cost 同一口径，保证成交记录的「平仓盈亏」和持仓页的「浮动盈亏」对得上。
   */
  costAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'cost_amount', comment: '卖出份额成本，买入为0' },
  /** 平仓盈亏（税后）= 成交额 − 印花税 − cost_amount；买入恒为 0 */
  realizedProfit: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'realized_profit', comment: '平仓盈亏(税后)，买入为0' },
  matchedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'matched_at' },
}, {
  tableName: 'trades',
  indexes: [
    { fields: ['user_id', 'matched_at'] },
    { fields: ['stock_id', 'matched_at'] },
    { fields: ['order_id'] },
    // 盈亏导出按成交时间窗口聚合，需要以 matched_at 为前导的索引
    { fields: ['matched_at'] },
  ],
});

export default Trade;
