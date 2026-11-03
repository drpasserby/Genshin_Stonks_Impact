-- =====================================================================
-- 迁移：身份组（角色）扩展 + 新闻审核字段
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- ============ 第一部分：users.role 扩到 7 个身份组 ============
--   原有：user 普通用户 / operator 操作员 / admin 管理员 / root 超级管理员
--   新增：
--     vip              高级用户     —— 权限同普通用户，但免卖方印花税
--     star             明星         —— 权限同普通用户，但强制公开持仓 + 强制参与排行榜
--     senior_operator  高级操作员   —— 操作员全部权限 + 发布新闻无需审核
--   说明：vip / star / operator 三者平级（都是「普通用户增强版」），
--         等级表 LEVEL 见 server/src/constants/roles.js。
--
--   ⚠️ ENUM 成员顺序在库内会影响隐式索引，改顺序时 MySQL 会重建表并按**字符串**转换
--      既有取值（本表仅百行级，开销可忽略）。迁移末尾有校验查询，
--      执行后请核对各角色的账号数是否与迁移前一致。
--
-- ============ 第二部分：news 新增审核字段 ============
--   背景：普通操作员发布的新闻原本「提交即生效、即刻影响股价」，没有任何复核环节。
--   现改为：
--     · 普通操作员发布 → review_status='PENDING'（待审）
--     · 高级操作员/管理员/超管发布 → 'APPROVED'（直接生效）
--     · 管理员/超管审核 → approve（通过，并重置有效期起点）/ reject（驳回，附理由）
--   语义约定（务必与应用层一致）：
--     · 只有 APPROVED 的新闻会进价格引擎、会在公开列表显示、允许被投票；
--     · expires_at 的计时起点是「审核通过时刻」，不是发布时刻
--       —— 否则待审期间就把有效期耗光了；
--     · 历史数据一律视为 APPROVED（本机制上线前它们就是直接生效的），
--       所以 DROP DEFAULT 后显式 UPDATE 一次是必须的，不能让老数据变成待审。
-- =====================================================================

/* ---------------- 1. users.role ENUM 扩展 ---------------- */

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
               AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%senior_operator%');
SET @s := IF(@has = 0,
  'ALTER TABLE users MODIFY COLUMN role ENUM(''user'',''vip'',''star'',''operator'',''senior_operator'',''admin'',''root'') NOT NULL DEFAULT ''user'' COMMENT ''身份组；vip=高级用户(免印花税) star=明星(强制公开持仓) senior_operator=高级操作员(发新闻免审核) root=超级管理员''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ---------------- 2. news 审核字段 ---------------- */

-- review_status：默认 APPROVED，保证「生产库里的老新闻」不会因为加列而变成待审
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'news' AND COLUMN_NAME = 'review_status');
SET @s := IF(@c = 0,
  'ALTER TABLE news ADD COLUMN review_status ENUM(''PENDING'',''APPROVED'',''REJECTED'') NOT NULL DEFAULT ''APPROVED'' COMMENT ''PENDING待审(不进引擎/不公开) APPROVED已通过(唯一生效状态) REJECTED已驳回'' AFTER publisher_id',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'news' AND COLUMN_NAME = 'reviewed_by');
SET @s := IF(@c = 0,
  'ALTER TABLE news ADD COLUMN reviewed_by INT UNSIGNED NULL COMMENT ''审核人(管理员/超管)'' AFTER review_status',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'news' AND COLUMN_NAME = 'reviewed_at');
SET @s := IF(@c = 0,
  'ALTER TABLE news ADD COLUMN reviewed_at DATETIME NULL COMMENT ''审核时间'' AFTER reviewed_by',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'news' AND COLUMN_NAME = 'review_note');
SET @s := IF(@c = 0,
  'ALTER TABLE news ADD COLUMN review_note VARCHAR(255) NULL COMMENT ''审核意见(驳回理由)'' AFTER reviewed_at',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 审核状态索引用得上（待审队列查询）：不存在才建
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'news' AND INDEX_NAME = 'idx_news_review_status');
SET @s := IF(@c = 0,
  'ALTER TABLE news ADD KEY idx_news_review_status (review_status)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 兜底：把可能存在的 NULL / 空值归一到 APPROVED（幂等；正常情况 0 行）
UPDATE news SET review_status = 'APPROVED'
WHERE review_status IS NULL OR review_status = '';

/* ---------------- 3. 校验 ---------------- */

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role';

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'news'
  AND COLUMN_NAME IN ('review_status','reviewed_by','reviewed_at','review_note');

-- 各身份组账号数（迁移前后应完全一致；新增的三个角色正常都是 0 行）
SELECT role, COUNT(*) AS users, SUM(status = 2) AS deleted
FROM users GROUP BY role ORDER BY role;

-- 新闻审核状态分布（迁移后历史新闻应全部是 APPROVED）
SELECT review_status, COUNT(*) AS news FROM news GROUP BY review_status;
