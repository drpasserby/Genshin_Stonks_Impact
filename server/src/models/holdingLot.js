import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 持仓批次（用于「最少持有周期」限制）
 *
 * 为什么需要单独一张表：holdings 是「用户 × 标的」一行、只有加权平均成本，
 * 没有任何时间信息，无法判断"哪一股是什么时候买的"。
 * 这里按每次买入记一条批次，卖出按 FIFO 消费，于是可以做到：
 *   · 只锁「新买的那部分」，不连坐早就买了几天的老持仓；
 *   · 卖出的份额里只要有一部分未解锁，就整体拒绝并给出剩余解锁时间。
 *
 * 与本功能上线前就存在的持仓：没有批次记录 → 视为早已解锁（一次性宽限），
 * 这样不会把所有人的存量仓位突然冻住。
 */
const HoldingLot = sequelize.define('HoldingLot', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
  quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, comment: '该批次剩余股数' },
  buyPrice: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0, field: 'buy_price', comment: '该批次的成交价（仅作记录）' },
  unlockAt: { type: DataTypes.DATE, allowNull: false, field: 'unlock_at', comment: '可卖时间 = 买入时间 + 最少持有周期 × 周期长度' },
}, {
  tableName: 'holding_lots',
  indexes: [
    { fields: ['user_id', 'stock_id', 'unlock_at'] }, // 校验"可卖多少"走这条
    { fields: ['stock_id'] },                         // 删标的时级联清理
  ],
});

export default HoldingLot;
