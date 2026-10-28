-- =====================================================================
-- 迁移：trades 增加 matched_at 时间索引
-- 日期：2026-09-11
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景：盈亏导出需要按「成交时间窗口」聚合（WHERE matched_at > ? GROUP BY user_id, stock_id），
--       现有索引是 (user_id, matched_at) 与 (stock_id, matched_at)，前导列不是时间，
--       纯时间范围扫描用不上。补一个以 matched_at 为前导的索引。
-- =====================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND INDEX_NAME = 'idx_trades_matched');
SET @s := IF(@c = 0,
  'ALTER TABLE trades ADD INDEX idx_trades_matched (matched_at)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades'
GROUP BY INDEX_NAME;
