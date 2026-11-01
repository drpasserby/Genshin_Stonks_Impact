-- =====================================================================
-- 迁移：一设备一账号 + 用户最后登录来源
-- 日期：2026-09-10
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
-- 执行：双击项目根目录「数据库迁移.bat」，或
--   mysql -uteyvat -p"$DB_PASSWORD" -h127.0.0.1 teyvat_stock < 本文件
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) users 表：注册设备号 + 最后登录 IP/UA
--    为什么放 users 而不是只靠 operation_logs：
--      · 管理端/个人中心要「一眼看到最后一次登录来源」，单行主键查询最省
--      · operation_logs 会持续增长，从日志里推最后一次登录要额外扫描
--      · 两者都保留：users 存最新一次（快），日志存完整历史（审计）
-- ---------------------------------------------------------------------

-- register_device
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'register_device');
SET @s := IF(@c = 0,
  'ALTER TABLE users ADD COLUMN register_device VARCHAR(64) NULL COMMENT ''注册设备号'' AFTER status',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- last_login_at
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_login_at');
SET @s := IF(@c = 0,
  'ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL COMMENT ''最后登录时间'' AFTER register_device',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- last_login_ip
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_login_ip');
SET @s := IF(@c = 0,
  'ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(45) NULL COMMENT ''最后登录IP'' AFTER last_login_at',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- last_login_ua
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_login_ua');
SET @s := IF(@c = 0,
  'ALTER TABLE users ADD COLUMN last_login_ua VARCHAR(255) NULL COMMENT ''最后登录UA'' AFTER last_login_ip',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------
-- 2) 设备注册记录表
--    独立建表而不是 users 加字段：账号被删后设备仍应被拦截，
--    否则「删号 → 重新注册」即可绕过限制。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_registrations (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id  VARCHAR(64)  NOT NULL COMMENT '设备号；auto- 前缀表示由 IP+UA 推导的兜底值',
  user_id    INT UNSIGNED NULL COMMENT '注册出的账号（账号删除后置空但记录保留）',
  ip         VARCHAR(45)  NULL,
  user_agent VARCHAR(255) NULL,
  source     ENUM('dev','auto') NOT NULL DEFAULT 'dev' COMMENT 'dev=浏览器上报 auto=IP+UA兜底',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_id (device_id),
  KEY idx_device_ip_time (ip, created_at)
) ENGINE=InnoDB COMMENT='设备注册记录（一设备一账号）';

-- ---------------------------------------------------------------------
-- 3) 校验
-- ---------------------------------------------------------------------
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS device_records FROM device_registrations;
