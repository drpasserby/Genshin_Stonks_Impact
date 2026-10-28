-- =====================================================================
-- 迁移：price_history 删除重复索引（幂等，可重复执行）
-- 日期：2026-09-12
--
-- 背景：
--   price_history 上有两对完全重复的索引，分别来自「Sequelize 模型声明」与「历史 SQL 迁移」：
--
--     A. price_history_stock_id_period_ts (stock_id, period, ts) UNIQUE   ← 模型声明（保留）
--        uk_kline_stock_period_ts       (stock_id, period, ts) UNIQUE   ← 迁移另建（删除）
--     B. price_history_ts                (ts)                            ← 模型声明（保留）
--        idx_kline_ts                   (ts)                            ← 迁移另建（删除）
--
--   实测：33k 行时索引占 6.1MB，而数据只有 2.5MB；每轮结算都要 upsert 131 行 K 线，
--   重复索引让写入白白多维护两棵树。
--
-- ⚠️ 为什么删「迁移建的」而不是「模型声明的」：
--   本项目启动时会执行 `sequelize.sync()`。模型里声明了 indexes（见 models/priceHistory.js），
--   删掉模型声明的那两个之后会被 sync() 重新加回来（实测：删完重启又变回 5 个索引）。
--   保留模型声明的、删掉迁移另建的，才能让数据库与模型保持一致、长期稳定在 3 个索引。
--
-- 安全性：
--   · 唯一约束能力：price_history_stock_id_period_ts（UNIQUE）仍在 →
--     bulkCreate(updateOnDuplicate) 的去重仍然生效，不会产生重复 K 线；
--   · 查询能力：price_history_ts (ts) 与 idx_kline_ts 完全等价，盈亏报表的期初价查询不受影响。
-- =====================================================================

-- A) 先确保模型声明的两个索引一定存在（保证唯一约束不会缺失）
SET @hasUnique := (SELECT COUNT(*) FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
                     AND INDEX_NAME = 'price_history_stock_id_period_ts');
SET @s := IF(@hasUnique = 0,
  'ALTER TABLE price_history ADD UNIQUE KEY price_history_stock_id_period_ts (stock_id, period, ts)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @hasTs := (SELECT COUNT(*) FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
                 AND INDEX_NAME = 'price_history_ts');
SET @s := IF(@hasTs = 0, 'ALTER TABLE price_history ADD KEY price_history_ts (ts)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- B) 再删掉迁移另建的两个重复索引（只在模型声明的那个确实存在时才删）
SET @keep := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
                AND INDEX_NAME = 'price_history_stock_id_period_ts');
SET @dup := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
               AND INDEX_NAME = 'uk_kline_stock_period_ts');
SET @s := IF(@keep > 0 AND @dup > 0, 'ALTER TABLE price_history DROP INDEX uk_kline_stock_period_ts', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @keep := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
                AND INDEX_NAME = 'price_history_ts');
SET @dup := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
               AND INDEX_NAME = 'idx_kline_ts');
SET @s := IF(@keep > 0 AND @dup > 0, 'ALTER TABLE price_history DROP INDEX idx_kline_ts', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 校验：应为 PRIMARY / price_history_stock_id_period_ts(UNIQUE) / price_history_ts
SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history'
GROUP BY INDEX_NAME, NON_UNIQUE;

SELECT ROUND(data_length / 1024 / 1024, 2) AS data_mb,
       ROUND(index_length / 1024 / 1024, 2) AS index_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_history';
