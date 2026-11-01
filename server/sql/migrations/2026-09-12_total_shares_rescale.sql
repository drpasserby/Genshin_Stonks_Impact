-- =====================================================================
-- 迁移：total_shares 重新标定（一次性，压缩到 4 万 ~ 20 万量级）
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB
--
-- 为什么改：
--   压力因子 = clamp(净买入股数 / total_shares × PRESSURE_GAIN(200))
--   原来流通股是 500 万 / 800 万，而全服玩家资金只有约 1.1 亿摩拉（人均 ~89 万）。
--   实测后果：一个玩家把「全部身家」（约 985 股）砸进一只股票，价格只动 0.039%；
--   近 24 小时 128 只个股平均振幅 0.0373%（121 只 < 0.05%）—— 个股市场实际上是死的。
--
--   本次按「玩家单笔 20 万摩拉（约 220 股）推动约 0.4%~0.5%」标定：
--     涨跌幅 = 0.5(压力权重) × (股数×200 / 流通股) × 0.02(基础波动率)
--            = 股数 × 2 / 流通股
--     220 股 / 80000 ≈ 0.55% ；反向亦可推算：想让 20 万摩拉推动 0.5%，流通股 ≈ 8~9 万。
--   同时保留原有的「大盘股更稳、小盘股更妖」的相对次序（4 万 ~ 20 万，5 倍档差）。
--
--   ⚠️ 本脚本重算 total_shares 不影响任何人的持仓股数与市值（市值 = 股数 × 现价），
--      只影响「交易对价格的推动力」以及展示用的流通市值/流通股数。
--
--   ⚠️ 幂等保护：仅当库中仍存在「旧量级」(>= 100 万) 的流通股时才执行，
--      因此重复执行不会把已经缩过的值再除一次。
-- =====================================================================

SET @need := (SELECT COUNT(*) FROM stocks WHERE total_shares >= 1000000);

SET @s := IF(@need > 0,
  'UPDATE stocks SET total_shares = CASE total_shares
       WHEN 1000000  THEN 40000
       WHEN 3000000  THEN 60000
       WHEN 5000000  THEN 80000
       WHEN 8000000  THEN 120000
       WHEN 10000000 THEN 150000
       WHEN 50000000 THEN 200000
       ELSE total_shares
     END
   WHERE total_shares IN (1000000, 3000000, 5000000, 8000000, 10000000, 50000000)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验：新量级分布 + 最大/最小
SELECT total_shares, COUNT(*) AS cnt FROM stocks GROUP BY total_shares ORDER BY total_shares DESC;

SELECT type,
       COUNT(*)                  AS cnt,
       MIN(total_shares)         AS min_shares,
       MAX(total_shares)         AS max_shares,
       ROUND(AVG(total_shares))  AS avg_shares
FROM stocks GROUP BY type;
