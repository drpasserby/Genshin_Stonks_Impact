-- =====================================================================
-- 迁移：trades 增加 fee（卖方印花税）
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景与语义：
--   本系统此前「买卖零手续费」，全服摩拉只增不减 → 结构性通胀。
--   现按「卖方成交额 × STAMP_TAX_RATE（默认 0.5%，见 server/.env）」征税，
--   从卖方到账金额里直接扣除，买方不收取。
--
--   · amount 保持「市场口径」的成交额不变（成交量/成交额统计不受影响）
--   · fee    记录该笔实际回收的摩拉（买入恒为 0）
--   · 卖方实际到账 = amount − fee
--
-- 历史数据：本次迁移之前的成交发生在「无税」时期，fee 补 0 即为真实情况，
--           不做任何回填（回填会让历史盈亏失真）。
-- =====================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND COLUMN_NAME = 'fee');
SET @s := IF(@c = 0,
  'ALTER TABLE trades ADD COLUMN fee DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT ''卖方印花税(摩拉)'' AFTER amount',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND COLUMN_NAME = 'fee';

SELECT
  COUNT(*)                                   AS trades_total,
  SUM(side = 'SELL')                         AS sell_trades,
  ROUND(COALESCE(SUM(fee), 0), 2)            AS tax_collected_so_far
FROM trades;
