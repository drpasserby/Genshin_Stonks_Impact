import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 市场情绪（社交平台舆情监控结果）—— 2026-09-14 新增
 *
 * 与 News 的关系：**完全独立**。
 *   提瓦特新闻 = 人工发布的、带外部来源链接的「新闻引用」；
 *   市场情绪   = 脚本从社交平台抓取并自动总结出的「情绪快照」。
 *   两者表分开、接口分开、前台也分开展示（新闻页里的「市场情绪」标签页）。
 *
 * 为什么 platform 用 STRING 而不是 ENUM：以后接微博/B站/贴吧时不用改表结构。
 * 为什么作者是文本而不是 user_id：作者口径是「平台 + 自动总结」，不是某个上传人；
 *   做成文本既不需要给机器人建账号，也不会混进「我提交的新闻」。
 *
 * 方向拆分：同一次监控里有的股票看涨、有的看跌 → 按方向拆成两行
 *   （唯一键含 direction，见 uk_sentiment_batch）。
 */
const MarketSentiment = sequelize.define('MarketSentiment', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  platform: { type: DataTypes.STRING(32), allowNull: false, comment: '抓取平台：NGA / 微博 / 贴吧…' },
  platformName: { type: DataTypes.STRING(64), allowNull: true, field: 'platform_name' },
  fetchedAt: { type: DataTypes.DATE, allowNull: false, field: 'fetched_at' },
  batchDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'batch_date' },
  batchKey: { type: DataTypes.STRING(64), allowNull: false, field: 'batch_key' },
  title: { type: DataTypes.STRING(120), allowNull: false },
  summary: { type: DataTypes.STRING(500), allowNull: true, comment: '概况：一句话总结论' },
  direction: { type: DataTypes.ENUM('UP', 'DOWN'), allowNull: false, comment: 'UP 看涨 / DOWN 看跌' },
  strength: {
    type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 50,
    comment: '影响强度 0~100',
  },
  stockCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'stock_count' },
  sourceUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'source_url' },
  authorLabel: {
    type: DataTypes.STRING(64), allowNull: false, field: 'author_label',
    comment: '展示用作者：平台 + 自动总结，如「NGA 自动总结」',
  },
  reviewStatus: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'), allowNull: false, defaultValue: 'PENDING',
    field: 'review_status',
    comment: 'PENDING待审(不对外) APPROVED已通过(唯一对外可见) REJECTED已驳回',
  },
  reviewedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'reviewed_by' },
  reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
  reviewNote: { type: DataTypes.STRING(255), allowNull: true, field: 'review_note' },
}, {
  tableName: 'market_sentiment',
  indexes: [
    { unique: true, fields: ['platform', 'batch_date', 'batch_key', 'direction'], name: 'uk_sentiment_batch' },
    { fields: ['review_status', 'fetched_at'] },
    { fields: ['platform', 'fetched_at'] },
  ],
});

export default MarketSentiment;
