-- =====================================================================
-- 迁移：price_history.period 由 ENUM('10m','1d') 改为 VARCHAR(8)
-- 日期：2026-09-11
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景：撮合周期已支持在控制面板在线调整（cycle_minutes），K 线档位随之变为
--       1m / 2m / 5m / 10m …，固定 ENUM 会直接写入失败（Data truncated），
--       并导致整轮结算事务回滚。因此必须改成变长字符串。
-- 影响：唯一索引 (stock_id, period, ts) 不受影响；历史 '10m' / '1d' 数据原样保留。
-- =====================================================================

SET @t := (SELECT DATA_TYPE FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history' AND COLUMN_NAME = 'period');

SELECT CONCAT('当前 period 类型：', COALESCE(@t, '(不存在)')) AS before_type;

SET @s := IF(@t = 'enum',
  'ALTER TABLE price_history MODIFY COLUMN period VARCHAR(8) NOT NULL COMMENT ''档位：<分钟>m（如 10m/2m）或 1d''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history' AND COLUMN_NAME = 'period';

SELECT period, COUNT(*) AS rows_cnt, MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM price_history GROUP BY period ORDER BY period;
