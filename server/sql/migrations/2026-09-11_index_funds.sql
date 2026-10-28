-- =====================================================================
-- 迁移：指数型基金（一期）
-- 日期：2026-09-11
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 设计要点：
--   · 基金不建独立业务表，而是复用 stocks（type='FUND'），
--     这样 orders / trades / holdings / watchlists / price_history /
--     news_stocks / votes 全部零改动即可支持基金。
--   · 新增 fund_constituents 记录「基金 → 成分股 + 权重」。
--   · nav 仅基金使用，存最近一次结算算出的单位净值（便于前端展示与排查）。
-- =====================================================================

-- 1) stocks.type
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks' AND COLUMN_NAME = 'type');
SET @s := IF(@c = 0,
  'ALTER TABLE stocks ADD COLUMN type ENUM(''STOCK'',''FUND'') NOT NULL DEFAULT ''STOCK'' COMMENT ''STOCK=角色股 FUND=指数基金'' AFTER name',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2) stocks.nav（基金单位净值）
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks' AND COLUMN_NAME = 'nav');
SET @s := IF(@c = 0,
  'ALTER TABLE stocks ADD COLUMN nav DECIMAL(14,4) NULL COMMENT ''基金单位净值（仅 FUND）'' AFTER total_shares',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3) stocks 的 type 索引（行情页按类型筛选）
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks' AND INDEX_NAME = 'idx_stocks_type');
SET @s := IF(@c = 0, 'ALTER TABLE stocks ADD INDEX idx_stocks_type (type)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 4) 基金成分股关联表
CREATE TABLE IF NOT EXISTS fund_constituents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fund_id        INT UNSIGNED    NOT NULL COMMENT '基金（stocks.id, type=FUND）',
  constituent_id INT UNSIGNED    NOT NULL COMMENT '成分股（stocks.id, 一期只允许 type=STOCK）',
  weight         DECIMAL(8,4)    NOT NULL DEFAULT 1.0000 COMMENT '权重（相对值，内部会归一化）',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_fund_constituent (fund_id, constituent_id),
  KEY idx_fc_constituent (constituent_id),
  CONSTRAINT fk_fc_fund FOREIGN KEY (fund_id) REFERENCES stocks (id) ON DELETE CASCADE,
  CONSTRAINT fk_fc_constituent FOREIGN KEY (constituent_id) REFERENCES stocks (id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='指数基金成分股与权重';

-- 5) 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocks'
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS fund_constituents_rows FROM fund_constituents;
