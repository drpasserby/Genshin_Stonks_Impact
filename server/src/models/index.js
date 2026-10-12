import sequelize from '../config/db.js';
import User from './user.js';
import Stock from './stock.js';
import Watchlist from './watchlist.js';
import Order from './order.js';
import Trade from './trade.js';
import Holding from './holding.js';
import HoldingLot from './holdingLot.js';
import News from './news.js';
import NewsStock from './newsStock.js';
import Vote from './vote.js';
import PriceHistory from './priceHistory.js';
import OperationLog from './operationLog.js';
import SystemSetting from './systemSetting.js';
import DeviceRegistration from './deviceRegistration.js';
import FundConstituent from './fundConstituent.js';
import MarketSentiment from './marketSentiment.js';

/* ---------- 关联定义 ---------- */
User.hasMany(Order, { foreignKey: 'userId', as: 'orders' });
Order.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Order.belongsTo(Stock, { foreignKey: 'stockId', as: 'stock' });
Stock.hasMany(Order, { foreignKey: 'stockId', as: 'orders' });

User.hasMany(Trade, { foreignKey: 'userId', as: 'trades' });
Trade.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Trade.belongsTo(Stock, { foreignKey: 'stockId', as: 'stock' });
Stock.hasMany(Trade, { foreignKey: 'stockId', as: 'trades' });

User.hasMany(Holding, { foreignKey: 'userId', as: 'holdings' });
Holding.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Holding.belongsTo(Stock, { foreignKey: 'stockId', as: 'stock' });
Stock.hasMany(Holding, { foreignKey: 'stockId', as: 'holdings' });

// 持仓批次（最少持有周期限制用）：一个持仓行对应多条买入批次
HoldingLot.belongsTo(User, { foreignKey: 'userId', as: 'user' });
HoldingLot.belongsTo(Stock, { foreignKey: 'stockId', as: 'stock' });
User.hasMany(HoldingLot, { foreignKey: 'userId', as: 'holdingLots' });
Stock.hasMany(HoldingLot, { foreignKey: 'stockId', as: 'holdingLots' });

User.hasMany(Watchlist, { foreignKey: 'userId', as: 'watchlists' });
Watchlist.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Watchlist.belongsTo(Stock, { foreignKey: 'stockId', as: 'stock' });
Stock.hasMany(Watchlist, { foreignKey: 'stockId', as: 'watchlists' });

User.hasMany(News, { foreignKey: 'publisherId', as: 'publishedNews' });
News.belongsTo(User, { foreignKey: 'publisherId', as: 'publisher' });

News.belongsToMany(Stock, { through: NewsStock, foreignKey: 'newsId', otherKey: 'stockId', as: 'stocks' });
Stock.belongsToMany(News, { through: NewsStock, foreignKey: 'stockId', otherKey: 'newsId', as: 'news' });

PriceHistory.belongsTo(Stock, { foreignKey: 'stockId', as: 'stock' });
Stock.hasMany(PriceHistory, { foreignKey: 'stockId', as: 'priceHistory' });

// Vote / OperationLog 的目标可能为空(系统操作)，userId 可空
OperationLog.belongsTo(User, { foreignKey: 'userId', as: 'operator' });
SystemSetting.belongsTo(User, { foreignKey: 'updatedBy', as: 'updater' });

// 设备注册记录 ↔ 用户（账号删除后记录保留，防止同设备再次注册）
DeviceRegistration.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// 指数基金 ↔ 成分股（多对多，带权重；基金与成分股都在 stocks 表里）
Stock.belongsToMany(Stock, {
  through: FundConstituent,
  foreignKey: 'fundId',
  otherKey: 'constituentId',
  as: 'constituents',
});
Stock.belongsToMany(Stock, {
  through: FundConstituent,
  foreignKey: 'constituentId',
  otherKey: 'fundId',
  as: 'inFunds',
});
FundConstituent.belongsTo(Stock, { foreignKey: 'fundId', as: 'fund' });
FundConstituent.belongsTo(Stock, { foreignKey: 'constituentId', as: 'constituent' });

// 市场情绪 ↔ 关联角色（多对多；与 news_stocks 同构，便于以后接价格引擎）
MarketSentiment.belongsToMany(Stock, {
  through: 'market_sentiment_stocks',
  foreignKey: 'sentimentId',
  otherKey: 'stockId',
  as: 'stocks',
  timestamps: false,
});
Stock.belongsToMany(MarketSentiment, {
  through: 'market_sentiment_stocks',
  foreignKey: 'stockId',
  otherKey: 'sentimentId',
  as: 'sentiments',
  timestamps: false,
});
MarketSentiment.belongsTo(User, { foreignKey: 'reviewedBy', as: 'reviewer' });

export {
  sequelize,
  User,
  Stock,
  Watchlist,
  Order,
  Trade,
  Holding,
  HoldingLot,
  News,
  NewsStock,
  Vote,
  PriceHistory,
  OperationLog,
  SystemSetting,
  DeviceRegistration,
  FundConstituent,
  MarketSentiment,
};
