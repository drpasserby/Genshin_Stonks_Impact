-- =====================================================================
-- 迁移：operation_logs 增加 user_agent 列
-- 用途：记录登录/下单/管理操作的浏览器 User-Agent（IP 列原本已有）
-- 日期：2026-09-09
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
-- 执行：
--   mysql -uteyvat -p"$DB_PASSWORD" -h127.0.0.1 teyvat_stock < 本文件
-- =====================================================================

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operation_logs'
    AND COLUMN_NAME = 'user_agent'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE operation_logs ADD COLUMN user_agent VARCHAR(255) NULL COMMENT ''User-Agent'' AFTER ip',
  'SELECT ''operation_logs.user_agent 已存在，跳过'' AS result'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'operation_logs'
ORDER BY ORDINAL_POSITION;
