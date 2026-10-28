-- =====================================================================
-- 迁移：stocks 增加 status（单标的交易状态）
-- 日期：2026-09-11
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 语义：
--   1 = 正常交易
--   0 = 暂停交易（停牌）：行情仍显示、价格仍随新闻/投票波动，但不能新下单、
--       不参与周期撮合；已挂单可撤（避免资金被锁死）
--   2 = 已退市：从公开行情列表隐藏、不能下单/撤单、价格冻结（不再参与结算）；
--       退市时自动撤销全部未成交挂单并解冻资金/股份；持仓按最后价格计价保留
-- =====================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks' AND COLUMN_NAME = 'status');
SET @s := IF(@c = 0,
  'ALTER TABLE stocks ADD COLUMN status TINYINT NOT NULL DEFAULT 1 COMMENT ''1正常 0暂停交易 2已退市'' AFTER type',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks' AND INDEX_NAME = 'idx_stocks_status');
SET @s := IF(@c = 0, 'ALTER TABLE stocks ADD INDEX idx_stocks_status (status)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks' AND COLUMN_NAME = 'status';

SELECT status, COUNT(*) AS cnt FROM stocks GROUP BY status ORDER BY status;
