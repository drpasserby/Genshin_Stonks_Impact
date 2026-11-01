-- =====================================================================
-- 迁移：市场情绪表（社交平台舆情监控结果的独立展示与审核）
-- 日期：2026-09-14
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景（用户需求）：
--   原来 NGA 的总结论是以「新闻」的形式混在提瓦特新闻里展示，观感不合适。
--   现在拆成独立模块「市场情绪」：展示不同社交平台对市场的反馈情绪，
--   与真实新闻彻底分开（表分开、接口分开、前台分开）。
--
-- 设计要点：
--   · platform 用 VARCHAR 而不是 ENUM —— 以后接微博/B站/贴吧时不用改表结构；
--   · 一次监控里如果有的股票看涨、有的看跌，就按方向**拆成两行**
--     （所以唯一键里含 direction）；
--   · 作者不是「上传人」，而是「平台 + 自动总结」，存成 author_label 文本即可，
--     这样不需要为机器人建账号，也不会出现在「我提交的新闻」里；
--   · batch_date = 抓取日期，用于「同一次监控」的去重：同平台+同批次+同方向
--     只保留一行（待审期间反复跑只更新那一行，审核通过后就定稿不再被覆盖）。
-- =====================================================================

CREATE TABLE IF NOT EXISTS market_sentiment (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  platform       VARCHAR(32)  NOT NULL COMMENT '抓取平台：NGA / 微博 / 贴吧…',
  platform_name  VARCHAR(64)  DEFAULT NULL COMMENT '平台展示名，如「NGA 玩家社区」',
  fetched_at     DATETIME     NOT NULL COMMENT '抓取时间（本轮分析时刻）',
  batch_date     DATE         NOT NULL COMMENT '抓取批次日期，用于同一次监控去重',
  batch_key      VARCHAR(64)  NOT NULL COMMENT '批次标识：fid 或版面组合，如 650 或 650,835',
  title          VARCHAR(120) NOT NULL COMMENT '标题（约 20 字）',
  summary        VARCHAR(500) DEFAULT NULL COMMENT '概况：一句话总结论',
  direction      ENUM('UP','DOWN') NOT NULL COMMENT '影响走向：UP 看涨 / DOWN 看跌',
  strength       TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '影响强度 0~100',
  stock_count    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本行涉及的角色数',
  source_url     VARCHAR(500) DEFAULT NULL COMMENT '来源：对应版面链接',
  author_label   VARCHAR(64)  NOT NULL COMMENT '展示用作者：平台 + 自动总结，如「NGA 自动总结」',
  review_status  ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING'
                 COMMENT 'PENDING待审(不对外) APPROVED已通过(唯一对外可见) REJECTED已驳回',
  reviewed_by    INT UNSIGNED NULL COMMENT '审核人',
  reviewed_at    DATETIME     NULL COMMENT '审核时间',
  review_note    VARCHAR(255) NULL COMMENT '审核意见',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sentiment_batch (platform, batch_date, batch_key, direction),
  KEY idx_ms_review (review_status, fetched_at),
  KEY idx_ms_platform_time (platform, fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='市场情绪（社交平台舆情监控结果）';

-- 关联角色：与 news_stocks 同构，便于以后影响股价/展示标签
CREATE TABLE IF NOT EXISTS market_sentiment_stocks (
  sentiment_id BIGINT UNSIGNED NOT NULL,
  stock_id     INT UNSIGNED    NOT NULL COMMENT 'stocks.id',
  PRIMARY KEY (sentiment_id, stock_id),
  KEY idx_mss_stock (stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='市场情绪关联角色';

/* ---------------- 校验 ---------------- */

SHOW TABLES LIKE 'market_sentiment';
SHOW TABLES LIKE 'market_sentiment_stocks';
SELECT COUNT(*) AS rows_now FROM market_sentiment;
