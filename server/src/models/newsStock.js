import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/** 新闻-角色 关联表（一条新闻可关联多个角色）。纯桥表，无时间戳列 */
const NewsStock = sequelize.define('NewsStock', {
  newsId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'news_id' },
  stockId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'stock_id' },
}, {
  tableName: 'news_stocks',
  timestamps: false,
  indexes: [{ unique: true, fields: ['news_id', 'stock_id'] }, { fields: ['stock_id'] }],
});

export default NewsStock;
