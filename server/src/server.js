import app from './app.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { sequelize } from './models/index.js';
import { testConnection } from './config/db.js';
import { startCycleJob } from './jobs/cycleJob.js';
import { ensureDefaults } from './services/settingService.js';
import { startPerfMonitor } from './services/perfService.js';
import { checkSchema } from './utils/checkSchema.js';

async function bootstrap() {
  try {
    await testConnection();
    await sequelize.sync(); // 开发模式自动建表；生产建议使用 sql/init.sql + sequelize.sync({alter:false})
    // 补齐系统设置项默认值并刷新运行时快照（幂等，不会覆盖管理员改过的值）
    await ensureDefaults();
    // 结构自检：迁移产出但无 model 的表/列对不上就打 WARN（不阻断启动）
    await checkSchema();
    const server = app.listen(config.port, () => {
      logger.info(`提瓦特证券交易所后端已启动: http://0.0.0.0:${config.port} (env=${config.env})`);
    });
    startCycleJob();
    // 系统性能采样（内存环形缓冲；管理员可在控制面板里开关与调间隔）
    await startPerfMonitor();

    const shutdown = async (signal) => {
      logger.info(`收到 ${signal}，正在优雅退出...`);
      server.close();
      await sequelize.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.error('启动失败: ' + (err.stack || err.message));
    process.exit(1);
  }
}

bootstrap();
