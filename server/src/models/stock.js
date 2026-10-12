import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 标的：角色股票 与 指数基金 共用一张表，用 type 区分。
 *
 * 为什么基金不单独建表：
 *   orders / trades / holdings / watchlists / price_history / news_stocks / votes
 *   全部通过 stock_id 关联。把基金做成 stocks 的一行后，上述所有能力（下单、
 *   撮合、冻结清算、持仓盈亏、K 线、盘口、新闻、投票、自选）零改动即可复用。
 *
 * 定价差异（见 docs/PRICING.md）：
 *   STOCK：涨跌幅 = (压力×wP + 新闻×wN + 投票×wV + 基金传导×wI) × 基础波动率
 *   FUND ：价格 = 向 [净值 NAV × (1+溢价)] 逐步收敛（fund_tracking_rate 决定收敛速度）
 */
const Stock = sequelize.define('Stock', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  code: { type: DataTypes.STRING(16), allowNull: false, unique: true, comment: '代码，如 TY0001 / FUND01' },
  name: { type: DataTypes.STRING(32), allowNull: false, unique: true, comment: '名称' },
  type: {
    type: DataTypes.ENUM('STOCK', 'FUND'),
    allowNull: false,
    defaultValue: 'STOCK',
    comment: 'STOCK=角色股 FUND=指数基金',
  },
  /**
   * 单标的状态：1=正常交易  0=暂停交易（停牌）  2=已退市
   * 与全局开关 trading_enabled 的区别：此处只影响这一个标的。
   */
  status: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 1,
    comment: '1正常 0暂停交易 2已退市',
  },
  avatarUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'avatar_url' },
  price: { type: DataTypes.DECIMAL(14, 4), allowNull: false, comment: '当前价格' },
  prevClose: { type: DataTypes.DECIMAL(14, 4), allowNull: false, field: 'prev_close', comment: '昨日收盘价' },
  open: { type: DataTypes.DECIMAL(14, 4), allowNull: false, comment: '今日开盘价' },
  high: { type: DataTypes.DECIMAL(14, 4), allowNull: false, comment: '今日最高价' },
  low: { type: DataTypes.DECIMAL(14, 4), allowNull: false, comment: '今日最低价' },
  volume: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0, comment: '今日成交量(份)' },
  totalShares: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    field: 'total_shares',
    comment: '总流通份额（基金为固定份额，封闭式）',
  },
  nav: {
    type: DataTypes.DECIMAL(14, 4),
    allowNull: true,
    comment: '基金单位净值（仅 FUND，每次结算由成分股加权算出，便于展示与排查）',
  },
}, {
  tableName: 'stocks',
  indexes: [{ fields: ['name'] }, { fields: ['type'] }],
});

export default Stock;
