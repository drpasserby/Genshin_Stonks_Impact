-- =====================================================================
-- 迁移：JWT 可吊销（users.token_version）
-- 日期：2026-09-10
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景：JWT 是无状态的，签发后服务端无法收回。改密码后旧 token 仍能用满 7 天。
-- 方案：JWT payload 里带 ver，与 users.token_version 比对；
--       改密码时 token_version + 1 → 该用户所有旧 token 立即失效。
-- 兼容：老 token 没有 ver 字段时按 0 处理，升级后不会把已登录用户踢下线。
-- =====================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version');
SET @s := IF(@c = 0,
  'ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''令牌版本，改密码+1'' AFTER status',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version';
