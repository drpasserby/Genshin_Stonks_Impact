import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * K线数据。period = '<分钟>m' 周期K线（随撮合周期变化，如 10m / 2m）或 '1d' 日K线。
 * ts 为K线起点时间（周期线取整到周期网格、1d 为当日 00:00）。
 * 数据量随运行增长，(stock_id, period, ts) 唯一索引覆盖按股票+周期取K线的查询。
 *
 * 注意：period 必须是字符串而不是 ENUM —— 撮合周期可在控制面板调整，
 * 档位会变成 1m/2m/5m…，固定 ENUM 会导致写入失败并回滚整轮结算。
 */
const PriceHistory = sequelize.define('PriceHistory', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
  period: { type: DataTypes.STRING(8), allowNull: false, comment: '档位：<分钟>m 或 1d' },
  ts: { type: DataTypes.DATE, allowNull: false, comment: 'K线起点时间' },
  open: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
  high: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
  low: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
  close: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
  volume: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'price_history',
  indexes: [
    { unique: true, fields: ['stock_id', 'period', 'ts'] },
    { fields: ['ts'] },
  ],
});

export default PriceHistory;
