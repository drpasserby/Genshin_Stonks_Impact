/**
 * PM2 配置：提瓦特证券交易所后端
 * 使用 __dirname 定位，保证从任意目录执行 `pm2 start` 都能正确工作。
 */
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'teyvat-stock-server',
      cwd: __dirname,
      script: 'src/server.js',
      interpreter: 'node',
      instances: 1,          // 必须单实例：周期调度器依赖单进程唯一性
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
        // 1G 内存服务器限制 V8 堆上限，避免 Node 吃光内存（本系统实际用量远低于此）
        NODE_OPTIONS: '--max-old-space-size=256',
      },
      // 超过阈值自动重启，防止内存泄漏拖垮 1G 小机
      max_memory_restart: '300M',
      autorestart: true,
      watch: false,
      merge_logs: true,
      out_file: path.join(__dirname, 'logs/pm2-out.log'),
      error_file: path.join(__dirname, 'logs/pm2-error.log'),
      time: true,
    },
  ],
};
