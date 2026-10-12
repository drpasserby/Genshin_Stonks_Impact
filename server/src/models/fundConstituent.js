import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

/**
 * 指数基金成分股与权重。
 *
 * 一期限制：成分股只能是 type='STOCK' 的角色（不允许基金持有基金），
 * 这样一轮结算内「先算角色、再算基金」即可完成，无需拓扑排序与环检测。
 *
 * weight 是相对权重（不必凑成 100），计算时会先归一化。
 */
const FundConstituent = sequelize.define('FundConstituent', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  fundId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'fund_id' },
  constituentId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'constituent_id' },
  weight: { type: DataTypes.DECIMAL(8, 4), allowNull: false, defaultValue: 1, comment: '相对权重' },
}, {
  tableName: 'fund_constituents',
  indexes: [{ unique: true, fields: ['fund_id', 'constituent_id'] }, { fields: ['constituent_id'] }],
});

export default FundConstituent;
