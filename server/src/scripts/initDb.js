import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import sequelize from '../config/db.js';
import { sequelize as modelSequelize, User, Stock, News, NewsStock, Vote, Order, Trade, Holding, Watchlist, PriceHistory, OperationLog } from '../models/index.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';

/** 用模型同步建表（若表已存在且结构一致则跳过；如需严格按 SQL 文件建库请用 deploy/init.sql） */
export async function initDb({ force = false } = {}) {
  await sequelize.authenticate();
  // 仅首次全量创建/重置时 force；模型定义了索引与唯一约束
  await modelSequelize.sync({ force, alter: false });
  logger.info(force ? '数据库已重置并重建' : '数据库结构已同步（未强制重置）');
}

// 直接运行本文件时执行初始化（兼容 Windows/Unix 的路径判断）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initDb({ force: process.argv.includes('--force') })
    .then(() => process.exit(0))
    .catch((err) => { logger.error(err); process.exit(1); });
}
