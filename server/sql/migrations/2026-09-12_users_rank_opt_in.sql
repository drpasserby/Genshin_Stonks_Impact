-- =====================================================================
-- 迁移：users 增加 rank_opt_in（是否参与资金/市值排行榜）
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 语义：
--   1 = 参与（默认）。排行榜只展示「昵称 + 金额」，不展示用户 ID / 用户名。
--   0 = 不参与：该账号完全不会出现在资金榜与市值榜中。
--   用户可在「我的」页面随时自行开关（用户中心里的一个 switch）。
-- =====================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'rank_opt_in');
SET @s := IF(@c = 0,
  'ALTER TABLE users ADD COLUMN rank_opt_in TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''是否参与排行榜 1参与 0不参与'' AFTER status',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'rank_opt_in';

SELECT rank_opt_in, COUNT(*) AS cnt FROM users GROUP BY rank_opt_in ORDER BY rank_opt_in DESC;
