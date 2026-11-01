-- =====================================================================
-- 迁移：trades 增加成本与平仓盈亏（已实现盈亏）
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景：
--   成交记录原本只存成交价/数量/金额/印花税，没有存「这一笔卖出所消耗的持仓成本」，
--   而 holdings.avg_cost 是**当前**的移动加权成本 —— 历史某一笔卖出时的成本点
--   早被后续买卖覆盖，玩家只能自己手算盈亏。
--
-- 口径（与持仓页显示的成本价/浮动盈亏完全一致，避免两处数字打架）：
--   cost_amount     = round2(该笔成交时的移动加权均价 × 数量)    仅 SELL，BUY = 0
--   realized_profit = round2(成交额 − 印花税 − cost_amount)      仅 SELL，BUY = 0
--                     （即"税后净平仓盈亏"）
--
--   恒等式：Σ 已实现盈亏（全部卖出） + 持仓浮动盈亏（未实现） = 交易总盈亏
--
-- 历史数据：由一次性回填脚本 deploy/backfill-realized-pnl.mjs 按 (user, stock)
--           时间序重放同样的移动加权法补齐（已实测与真实持仓 100% 对账）。
-- =====================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND COLUMN_NAME = 'cost_amount');
SET @s := IF(@c = 0,
  'ALTER TABLE trades ADD COLUMN cost_amount DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT ''卖出份额成本(移动加权均价×数量)，买入为0'' AFTER fee',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND COLUMN_NAME = 'realized_profit');
SET @s := IF(@c = 0,
  'ALTER TABLE trades ADD COLUMN realized_profit DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT ''平仓盈亏(税后)=到账−成本，买入为0'' AFTER cost_amount',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades'
  AND COLUMN_NAME IN ('fee', 'cost_amount', 'realized_profit')
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS trades_total,
       SUM(side = 'SELL') AS sell_trades,
       SUM(CASE WHEN side = 'SELL' AND realized_profit <> 0 THEN 1 ELSE 0 END) AS sells_with_pnl
FROM trades;
