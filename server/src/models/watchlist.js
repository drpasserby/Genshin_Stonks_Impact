import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/** 自选股 */
const Watchlist = sequelize.define('Watchlist', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'user_id' },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
}, {
  tableName: 'watchlists',
  indexes: [{ unique: true, fields: ['user_id', 'stock_id'] }, { fields: ['stock_id'] }],
});

export default Watchlist;
