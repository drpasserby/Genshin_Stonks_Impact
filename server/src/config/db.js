import { Sequelize } from 'sequelize';
import config from './index.js';
import logger from '../utils/logger.js';

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.pass, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  logging: config.isProd ? false : (msg) => logger.debug(msg),
  timezone: '+08:00', // 与服务器业务时区保持一致，建议服务器使用 Asia/Shanghai
  define: {
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
    underscored: true, // snake_case 列名
  },
  pool: { max: config.db.pool.max, min: config.db.pool.min, acquire: 30000, idle: 10000 },
  dialectOptions: {
    charset: 'utf8mb4',
    // 让 DECIMAL 以字符串返回，避免精度丢失
    decimalNumbers: false,
    connectTimeout: 10000,
  },
});

export async function testConnection() {
  try {
    await sequelize.authenticate();
    logger.info('数据库连接成功: ' + config.db.host + ':' + config.db.port + '/' + config.db.name);
  } catch (err) {
    logger.error('数据库连接失败: ' + err.message);
    throw err;
  }
}

export default sequelize;
