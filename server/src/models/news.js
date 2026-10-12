import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 新闻引用（操作员/高级操作员发布）。关联角色见 news_stocks 多对多表。
 * expiresAt 之后自动失效，不再进入股价引擎。
 * 本平台新闻为“来源引用”：发布时提供标题 + 外部原文链接（sourceUrl），不填自撰正文。
 *
 * ============ 审核状态（2026-09-12 新增） ============
 * reviewStatus：
 *   PENDING  待审核 —— 普通操作员发布的新闻默认进入此状态：
 *            **不进价格引擎、不在公开列表显示、不能被投票**，等同于一纸草稿。
 *   APPROVED 已通过 —— 真正生效（唯一会进引擎、会公开的状态）。
 *            高级操作员/管理员/超管发布的新闻直接落在此状态（无需审核）。
 *            历史数据默认 APPROVED（本机制上线前发布的新闻都是直接生效的）。
 *   REJECTED 已驳回 —— 保留记录供操作员查看理由，永不生效。
 *
 * expiresAt 的计时起点：APPROVED 的那一刻（而不是发布时刻），
 * 否则一条新闻在待审期间就可能把有效期耗光。
 */
const News = sequelize.define('News', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  title: { type: DataTypes.STRING(120), allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false, comment: '兼容旧数据保留；新发布新闻一律为空，链接见 sourceUrl' },
  sourceUrl: {
    type: DataTypes.STRING(500),
    allowNull: true,
    field: 'source_url',
    comment: '新闻来源外部链接（发布必填且必须是 http/https URL）',
  },
  direction: { type: DataTypes.ENUM('UP', 'DOWN'), allowNull: false, comment: '初始影响方向' },
  strength: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 50, comment: '影响强度 0~100' },
  publisherId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'publisher_id' },
  reviewStatus: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
    allowNull: false,
    defaultValue: 'APPROVED',
    field: 'review_status',
    comment: 'PENDING待审 APPROVED已通过（唯一会生效的状态） REJECTED已驳回',
  },
  reviewedBy: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
    field: 'reviewed_by',
    comment: '审核人（管理员/超级管理员）',
  },
  reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
  reviewNote: {
    type: DataTypes.STRING(255),
    allowNull: true,
    field: 'review_note',
    comment: '审核意见（驳回理由）',
  },
  expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
}, {
  tableName: 'news',
  indexes: [{ fields: ['expires_at'] }, { fields: ['publisher_id'] }, { fields: ['review_status'] }],
});

export default News;
