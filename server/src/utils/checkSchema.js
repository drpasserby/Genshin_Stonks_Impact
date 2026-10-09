import sequelize from '../config/db.js';
import logger from '../utils/logger.js';

/**
 * 数据库结构自检（启动时跑一次，只读、不自动改库）。
 *
 * 为什么需要它：
 *   sequelize.sync() 只会处理「在 models/ 里定义了 model 的表」。
 *   迁移脚本建的表/列如果没有对应 model（例如 news_impact、nga_analysis_log
 *   由 Python 脚本 server/scripts/nga_analysis.py 自己读写），**永远不会被自动创建、
 *   也不会被自动检查**。2026-09-13 就踩过一次：迁移只打在生产，本地库缺这两张表，
 *   表现是「本地面板看不到 NGA 配置」。
 *
 * 这里把「迁移产出但无 model 的对象」登记下来，启动时对不上就打 WARN（不阻断启动），
 * 让人在第一时间看到「你忘了跑迁移」。
 */
const MIGRATION_OWNED = {
  news_impact: 'NGA 舆情 AI 影响值（server/sql/migrations/2026-09-12_nga_news_impact.sql）',
  nga_analysis_log: 'NGA 分析脚本日志（server/sql/migrations/2026-09-12_nga_news_impact.sql）',
};

/** 迁移产出、但 sequelize.sync() 管不到的关键列：表名 → [列名, 说明] */
const MIGRATION_OWNED_COLUMNS = [
  ['system_settings', 's_value', '512,4', 'Cookie/密钥需要长文本（2026-09-13_nga_panel_settings.sql）'],
];

export async function checkSchema() {
  const problems = [];

  let tables = [];
  try {
    const [rows] = await sequelize.query(
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    tables = rows.map((r) => r.t || r.TABLE_NAME);
  } catch (err) {
    logger.warn('[自检] 读取表清单失败，跳过结构自检: ' + err.message);
    return problems;
  }

  for (const [table, desc] of Object.entries(MIGRATION_OWNED)) {
    if (!tables.includes(table)) {
      problems.push(`缺表 ${table}（${desc}）`);
    }
  }

  try {
    const [cols] = await sequelize.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, CHARACTER_MAXIMUM_LENGTH AS len
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
    for (const [table, column, minLen, desc] of MIGRATION_OWNED_COLUMNS) {
      const hit = cols.find((r) => r.t === table && r.c === column);
      if (hit && Number(hit.len) < Number(minLen)) {
        problems.push(`${table}.${column} 长度 ${hit.len} 偏小，应为 ${minLen} 以上（${desc}）`);
      }
    }
  } catch (err) {
    logger.warn('[自检] 读取列信息失败: ' + err.message);
  }

  if (problems.length) {
    logger.warn(`[自检] 数据库结构缺少 ${problems.length} 项，很可能是迁移没跑：`);
    problems.forEach((p) => logger.warn('  · ' + p));
    logger.warn('[自检] 修复：本地跑 数据库迁移.bat，或 node deploy/apply-sql.mjs <file.sql>；' +
                '线上按同一个文件执行；对比两地可用 node deploy/check-db-sync.mjs');
  } else {
    logger.info('[自检] 数据库结构完整（迁移产出的表与列都在）');
  }
  return problems;
}

export default checkSchema;
