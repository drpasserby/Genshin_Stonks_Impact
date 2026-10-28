-- =====================================================================
-- 迁移：新增 holding_lots（持仓批次表）—— 支撑「最少持有周期」限制
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景：
--   holdings 是「用户 × 标的」一行、只有加权平均成本，没有任何时间信息，
--   无法回答"这一股是什么时候买的"。要实现「持有不足 X 个周期不得卖出」，
--   必须按买入批次记录解锁时间。
--
-- 语义：
--   每次买入写入一条批次：quantity = 本次买入股数，unlock_at = 买入时刻 + X个周期。
--   卖出按 FIFO（先买的先卖）消费批次，只有 unlock_at <= now 的批次可以被卖；
--   如果要卖的份额里有一部分还没解锁，整单拒绝并提示「该份额持有周期过短…」。
--
--   本功能上线前就存在的持仓没有批次记录 → 视为早已解锁（一次性宽限），
--   避免把所有人的存量仓位突然冻住。因此可卖数量 = (持仓总量 − 批次总量) + 已解锁批次量。
--
--   X 由控制面板「最少持有周期数」设置（默认 3），设为 0 即关闭本限制。
-- =====================================================================

CREATE TABLE IF NOT EXISTS holding_lots (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED    NOT NULL COMMENT '持有人',
  stock_id   INT UNSIGNED    NOT NULL COMMENT '标的（角色股或基金）',
  quantity   INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '该批次剩余股数',
  buy_price  DECIMAL(14,4)   NOT NULL DEFAULT 0 COMMENT '该批次成交价（仅记录）',
  unlock_at  DATETIME        NOT NULL COMMENT '可卖时间 = 买入时间 + 最少持有周期 × 周期长度',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY holding_lots_user_id_stock_id_unlock_at (user_id, stock_id, unlock_at),
  KEY holding_lots_stock_id (stock_id)
) ENGINE=InnoDB COMMENT='持仓批次（最少持有周期限制）';

-- 校验
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holding_lots'
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS lot_rows FROM holding_lots;
