-- =====================================================================
-- 提瓦特证券交易所 · 数据库建表脚本
-- 兼容版本：MySQL 5.7 / MySQL 8.0 / MariaDB 10.2+（未使用任何 8.0 专属语法）
-- 字符集：utf8mb4 + utf8mb4_unicode_ci（5.7 与 8.0 均支持）
-- 覆盖：19 张业务表（users / device_registrations / system_settings / stocks /
--       fund_constituents / watchlists / orders / trades / holdings /
--       holding_lots / news / news_stocks / votes / price_history /
--       operation_logs / market_sentiment / market_sentiment_stocks /
--       news_impact / nga_analysis_log）
-- 说明：模型侧 sequelize.sync() 也会自动建表（开发方便）；
--       生产环境建议先用本脚本建表，再用 sync({alter:false}) 校验。
-- 执行：mysql -u root -p < init.sql
-- ⚠️ 本脚本含 DROP TABLE，会清空同名表，仅用于全新部署！
-- 文件末尾附有「与生产库的差异说明」（排序规则归一化、重复索引合并清单）。
-- =====================================================================
CREATE DATABASE IF NOT EXISTS teyvat_stock
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE teyvat_stock;

-- 先关闭外键检查：DROP 顺序与表间外键无关，保证脚本可重复执行
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- 用户表（user 普通用户 / vip 高级用户 / star 明星 / operator 操作员 /
--         senior_operator 高级操作员 / admin 管理员 / root 超级管理员）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  username        VARCHAR(32)   NOT NULL COMMENT '鐧诲綍鍚',
  password_hash   VARCHAR(255)  NOT NULL COMMENT 'bcrypt 鍝堝笇',
  nickname        VARCHAR(32)   NOT NULL COMMENT '鏄电О',
  role            ENUM('user','vip','star','operator','senior_operator','admin','root') NOT NULL DEFAULT 'user' COMMENT '身份组；vip=高级用户(免印花税) star=明星(强制公开持仓) senior_operator=高级操作员(发新闻免审核) root=超级管理员',
  mora            DECIMAL(18,2) NOT NULL DEFAULT 1000000.00 COMMENT '鍙?敤鎽╂媺',
  frozen_mora     DECIMAL(18,2) NOT NULL DEFAULT 0.00 COMMENT '鎸備拱鍗曞喕缁撴懇鎷',
  status          TINYINT       NOT NULL DEFAULT 1 COMMENT '1鍚?敤 0绂佺敤',
  rank_opt_in     TINYINT(1)    NOT NULL DEFAULT 1 COMMENT '是否参与排行榜 1参与 0不参与',
  token_version   INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '令牌版本，改密码+1',
  register_device VARCHAR(64)   NULL COMMENT '注册设备号',
  last_login_at   DATETIME      NULL COMMENT '最后登录时间',
  last_login_ip   VARCHAR(45)   NULL COMMENT '最后登录IP',
  last_login_ua   VARCHAR(255)  NULL COMMENT '最后登录UA',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鐢ㄦ埛';

-- ---------------------------------------------------------------------
-- 设备注册记录（一设备一账号；账号删除后记录保留，防止同设备再注册）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS device_registrations;
CREATE TABLE device_registrations (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id  VARCHAR(64)  NOT NULL COMMENT '设备号；auto- 前缀表示由 IP+UA 推导的兜底值',
  user_id    INT UNSIGNED NULL COMMENT '注册出的账号（账号删除后置空但记录保留）',
  ip         VARCHAR(45)  NULL,
  user_agent VARCHAR(255) NULL,
  source     ENUM('dev','auto') NOT NULL DEFAULT 'dev' COMMENT 'dev=浏览器上报 auto=IP+UA兜底',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_id (device_id),
  KEY idx_device_ip_time (ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='设备注册记录（一设备一账号）';

-- ---------------------------------------------------------------------
-- 系统设置表（管理开关，存数据库不用文件；root 控制面板读写）
-- 注意：created_at/updated_at 无默认值，写入时需显式提供（后端 ORM 自动填充）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS system_settings;
CREATE TABLE system_settings (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  s_key       VARCHAR(64)  NOT NULL,
  s_value     VARCHAR(8192) NOT NULL DEFAULT '' COMMENT '值（文本；Cookie/密钥可能较长，故给到 8192）',
  description VARCHAR(255) NULL,
  updated_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY `key` (s_key),
  KEY updated_by (updated_by),
  CONSTRAINT system_settings_ibfk_1 FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 默认配置（需求：默认禁用自助注册；交易默认开放）
-- 注意：后端启动时会执行 ensureDefaults()，把 schema 里缺失的配置项补齐（幂等，不覆盖已改过的值），
--       所以这里没列全也没关系；下列为「新建库时的初始值」，与 settingService.SETTING_SCHEMA 保持一致。
INSERT INTO system_settings (s_key, s_value, description, created_at, updated_at) VALUES
  ('allow_registration',  '0',    '是否允许新用户自助注册（关闭后仅管理员可创建账号）', NOW(), NOW()),
  ('device_limit_enabled','1',    '一设备一账号限制（关闭后同设备可重复注册，办活动放宽用）', NOW(), NOW()),
  ('allow_login',         '1',    '是否允许普通用户登录（关闭 = 维护模式，仅超级管理员可登录）', NOW(), NOW()),
  ('trading_enabled',     '1',    '是否允许交易（下单/撤单/撮合；关闭 = 全站暂停交易）', NOW(), NOW()),
  ('cycle_minutes',       '10',   '撮合周期（分钟）：多久撮合一次并重算股价', NOW(), NOW()),
  ('base_volatility',     '0.02', '基础波动率：每周期涨跌幅的放大幅度', NOW(), NOW()),
  ('max_change',          '0.1',  '单周期涨跌幅上限（0.1 = ±10%）', NOW(), NOW()),
  ('allow_news_publish',  '1',    '是否允许发布/编辑/删除新闻', NOW(), NOW()),
  ('allow_vote',          '1',    '是否允许新闻投票与股票投票', NOW(), NOW()),
  ('news_ttl_cycles',     '6',    '新闻有效周期数：发布后影响股价的时长', NOW(), NOW()),
  ('start_mora',          '1000000', '新用户初始摩拉', NOW(), NOW()),
  ('announcement',        '',     '全站公告横幅文本（留空不显示）', NOW(), NOW());

-- ---------------------------------------------------------------------
-- 角色股票 / 指数基金（两者共用一张表，用 type 区分）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS stocks;
CREATE TABLE stocks (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  code         VARCHAR(16)   NOT NULL COMMENT '鑲＄エ浠ｇ爜 TY0001',
  name         VARCHAR(32)   NOT NULL COMMENT '瑙掕壊鍚嶇О',
  type         ENUM('STOCK','FUND') NOT NULL DEFAULT 'STOCK' COMMENT 'STOCK=角色股 FUND=指数基金',
  status       TINYINT       NOT NULL DEFAULT 1 COMMENT '1正常 0暂停交易 2已退市',
  avatar_url   VARCHAR(500)  NULL COMMENT '澶村儚澶栭摼',
  price        DECIMAL(14,4) NOT NULL COMMENT '褰撳墠鑲′环',
  prev_close   DECIMAL(14,4) NOT NULL COMMENT '鏄ㄦ棩鏀剁洏浠',
  open         DECIMAL(14,4) NOT NULL COMMENT '浠婃棩寮?洏浠',
  high         DECIMAL(14,4) NOT NULL COMMENT '浠婃棩鏈?珮浠',
  low          DECIMAL(14,4) NOT NULL COMMENT '浠婃棩鏈?綆浠',
  volume       BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '浠婃棩鎴愪氦閲?鑲?',
  total_shares BIGINT UNSIGNED NOT NULL COMMENT '鎬绘祦閫氳偂鏁',
  nav          DECIMAL(14,4) NULL COMMENT '基金单位净值（仅 FUND）',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_stocks_code (code),
  UNIQUE KEY uk_stocks_name (name),
  KEY idx_stocks_name (name),
  KEY idx_stocks_type (type),
  KEY idx_stocks_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='瑙掕壊鑲＄エ';

-- ---------------------------------------------------------------------
-- 指数基金成分股与权重
-- 说明：基金价格 = 成分股加权净值(NAV) × (1+溢价) 后逐步收敛，
--       基金自身的买卖压力再按权重反向传导给成分股（见 docs/PRICING.md）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS fund_constituents;
CREATE TABLE fund_constituents (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='指数基金成分股与权重';

-- ---------------------------------------------------------------------
-- 自选股
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS watchlists;
CREATE TABLE watchlists (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  stock_id   INT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_watch_user_stock (user_id, stock_id),
  KEY idx_watch_stock (stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鑷??鑲';

-- ---------------------------------------------------------------------
-- 委托单（市价/限价）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  stock_id        INT UNSIGNED NOT NULL,
  side            ENUM('BUY','SELL') NOT NULL,
  type            ENUM('MARKET','LIMIT') NOT NULL,
  price           DECIMAL(14,4) NULL COMMENT '闄愪环锛涘競浠峰崟NULL',
  reserved_amount DECIMAL(18,2) NULL COMMENT '鎸備拱鍗曞喕缁撻噾棰',
  quantity        INT UNSIGNED NOT NULL COMMENT '濮旀墭鏁伴噺',
  filled_quantity INT UNSIGNED NOT NULL DEFAULT 0,
  status          ENUM('PENDING','FILLED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_orders_user_status (user_id, status),
  KEY idx_orders_stock_status (stock_id, status),
  KEY idx_orders_status_type (status, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='濮旀墭鍗';

-- ---------------------------------------------------------------------
-- 成交记录
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS trades;
CREATE TABLE trades (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id        INT UNSIGNED NOT NULL COMMENT '鏉ユ簮濮旀墭鍗',
  user_id         INT UNSIGNED NOT NULL,
  stock_id        INT UNSIGNED NOT NULL,
  side            ENUM('BUY','SELL') NOT NULL,
  price           DECIMAL(14,4) NOT NULL COMMENT '鎴愪氦浠?=鎾?悎鏃跺綋鍓嶄环)',
  quantity        INT UNSIGNED NOT NULL,
  amount          DECIMAL(18,2) NOT NULL COMMENT '鎴愪氦閲戦?鎽╂媺',
  fee             DECIMAL(18,2) NOT NULL DEFAULT 0.00 COMMENT '卖方印花税(摩拉)',
  cost_amount     DECIMAL(18,2) NOT NULL DEFAULT 0.00 COMMENT '卖出份额成本(移动加权均价×数量)，买入为0',
  realized_profit DECIMAL(18,2) NOT NULL DEFAULT 0.00 COMMENT '平仓盈亏(税后)=到账−成本，买入为0',
  matched_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '鎴愪氦鏃跺埢(鍛ㄦ湡绐楀彛渚濇嵁)',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_trades_user_time (user_id, matched_at),
  KEY idx_trades_stock_time (stock_id, matched_at),
  KEY idx_trades_order (order_id),
  KEY idx_trades_matched (matched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鎴愪氦璁板綍';

-- ---------------------------------------------------------------------
-- 持仓
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS holdings;
CREATE TABLE holdings (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  stock_id        INT UNSIGNED NOT NULL,
  quantity        INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '鎸佷粨鑲℃暟',
  frozen_quantity INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '鎸傚崠鍗曞喕缁撹偂鏁',
  avg_cost        DECIMAL(14,4) NOT NULL DEFAULT 0.0000 COMMENT '鎽婅杽鎴愭湰浠',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_holding_user_stock (user_id, stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鎸佷粨';

-- ---------------------------------------------------------------------
-- 持仓批次（最少持有周期限制）：每次买入一条，卖出按 FIFO 消费
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS holding_lots;
CREATE TABLE holding_lots (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED    NOT NULL COMMENT '持有人',
  stock_id   INT UNSIGNED    NOT NULL COMMENT '标的（角色股或基金）',
  quantity   INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '该批次剩余股数',
  buy_price  DECIMAL(14,4)   NOT NULL DEFAULT 0.0000 COMMENT '该批次成交价（仅记录）',
  unlock_at  DATETIME        NOT NULL COMMENT '可卖时间 = 买入时间 + 最少持有周期 × 周期长度',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY holding_lots_user_id_stock_id_unlock_at (user_id, stock_id, unlock_at),
  KEY holding_lots_stock_id (stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='持仓批次（最少持有周期限制）';

-- ---------------------------------------------------------------------
-- 新闻引用（操作员发布）：标题 + 来源链接(source_url)，非自撰正文
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS news;
CREATE TABLE news (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title         VARCHAR(120) NOT NULL,
  content       TEXT         NOT NULL,
  source_url    VARCHAR(500) NULL,
  direction     ENUM('UP','DOWN') NOT NULL COMMENT '鍒濆?褰卞搷鏂瑰悜',
  strength      TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '寮哄害0~100',
  publisher_id  INT UNSIGNED NOT NULL,
  review_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED' COMMENT 'PENDING待审(不进引擎/不公开) APPROVED已通过(唯一生效状态) REJECTED已驳回',
  reviewed_by   INT UNSIGNED NULL COMMENT '审核人(管理员/超管)',
  reviewed_at   DATETIME     NULL COMMENT '审核时间',
  review_note   VARCHAR(255) NULL COMMENT '审核意见(驳回理由)',
  expires_at    DATETIME     NULL COMMENT '杩囨湡鏃堕棿锛屼箣鍚庝笉璁″叆寮曟搸',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_news_expires (expires_at),
  KEY idx_news_publisher (publisher_id),
  KEY idx_news_review_status (review_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鏂伴椈寮曠敤';

-- ---------------------------------------------------------------------
-- 新闻-角色 多对多
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS news_stocks;
CREATE TABLE news_stocks (
  news_id  INT UNSIGNED NOT NULL,
  stock_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (news_id, stock_id),
  KEY idx_ns_stock (stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鏂伴椈鍏宠仈瑙掕壊';

-- ---------------------------------------------------------------------
-- 操作员倍率投票（可投新闻或股票）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS votes;
CREATE TABLE votes (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  target_type ENUM('NEWS','STOCK') NOT NULL,
  target_id   INT UNSIGNED NOT NULL,
  direction   ENUM('UP','DOWN') NOT NULL,
  multiplier  DECIMAL(4,2) NOT NULL COMMENT '0.5~2.0',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_vote_user_target (user_id, target_type, target_id),
  KEY idx_votes_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鎿嶄綔鍛樻姇绁';

-- ---------------------------------------------------------------------
-- K线历史（周期线与日线共用表；ts 为周期起点）
-- period 用变长字符串而非 ENUM：撮合周期可在控制面板调整，
-- 档位会变成 1m/2m/5m/10m…，固定 ENUM 会导致写入失败并回滚整轮结算。
-- 注意：数据量会持续增长，唯一索引覆盖"单标的+周期+时间"查询，
--       如需清理可按 ts 定期删除（保留最近 N 天）。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS price_history;
CREATE TABLE price_history (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stock_id INT UNSIGNED    NOT NULL,
  period   VARCHAR(8)      NOT NULL COMMENT '档位：<分钟>m（如 10m/2m）或 1d',
  ts       DATETIME NOT NULL COMMENT 'K绾胯捣鐐规椂闂',
  open     DECIMAL(14,4) NOT NULL,
  high     DECIMAL(14,4) NOT NULL,
  low      DECIMAL(14,4) NOT NULL,
  close    DECIMAL(14,4) NOT NULL,
  volume   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY price_history_stock_id_period_ts (stock_id, period, ts),
  KEY price_history_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='K绾?10m/1d)';

-- ---------------------------------------------------------------------
-- 操作日志
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS operation_logs;
CREATE TABLE operation_logs (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NULL,
  action     VARCHAR(64) NOT NULL COMMENT '濡?LOGIN/PLACE_ORDER/ADMIN_*',
  detail     TEXT NULL COMMENT 'JSON',
  ip         VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL COMMENT 'User-Agent',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_logs_user_time (user_id, created_at),
  KEY idx_logs_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='鎿嶄綔鏃ュ織';

-- ---------------------------------------------------------------------
-- 市场情绪（社交平台舆情监控结果，独立于新闻展示与审核）
-- 说明：platform 用 VARCHAR 而非 ENUM，便于以后接入微博/B站/贴吧；
--       一次监控中同平台+同批次+同方向只保留一行（唯一键去重）。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS market_sentiment;
CREATE TABLE market_sentiment (
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
  review_status  ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING待审(不对外) APPROVED已通过(唯一对外可见) REJECTED已驳回',
  reviewed_by    INT UNSIGNED NULL COMMENT '审核人',
  reviewed_at    DATETIME     NULL COMMENT '审核时间',
  review_note    VARCHAR(255) NULL COMMENT '审核意见',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sentiment_batch (platform, batch_date, batch_key, direction),
  KEY idx_ms_review (review_status, fetched_at),
  KEY idx_ms_platform_time (platform, fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='市场情绪（社交平台舆情监控结果）';

-- ---------------------------------------------------------------------
-- 市场情绪-角色 多对多（与 news_stocks 同构）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS market_sentiment_stocks;
CREATE TABLE market_sentiment_stocks (
  sentiment_id BIGINT UNSIGNED NOT NULL,
  stock_id     INT UNSIGNED    NOT NULL COMMENT 'stocks.id',
  PRIMARY KEY (sentiment_id, stock_id),
  KEY idx_mss_stock (stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='市场情绪关联角色';

-- ---------------------------------------------------------------------
-- NGA 舆情 AI 影响值（每 3 小时覆盖一次；原始帖子内容不落库）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS news_impact;
CREATE TABLE news_impact (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type   ENUM('role','fund') NOT NULL COMMENT 'role=角色股(stocks.type=STOCK) fund=指数基金(stocks.type=FUND)',
  entity_name   VARCHAR(64)  NOT NULL COMMENT '实体名，等于 stocks.name',
  impact_value  DECIMAL(6,4) NOT NULL COMMENT '生效影响值（当前等于 raw_impact，后续可加衰减）',
  raw_impact    DECIMAL(6,4) NOT NULL COMMENT 'AI 原始影响值 -1.0000~1.0000',
  confidence    DECIMAL(4,3) NOT NULL DEFAULT 1.000 COMMENT 'AI 置信度 0~1',
  summary       VARCHAR(255) DEFAULT NULL COMMENT 'AI 一句话理由（≤30 字）',
  source_count  INT UNSIGNED DEFAULT 0 COMMENT '本次分析纳入的帖子数',
  analyzed_at   DATETIME     NOT NULL COMMENT '本次分析时刻',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_entity (entity_type, entity_name),
  KEY idx_analyzed (analyzed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='NGA 舆情 AI 影响值（每 3 小时覆盖一次）';

-- ---------------------------------------------------------------------
-- NGA 舆情分析脚本日志
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS nga_analysis_log;
CREATE TABLE nga_analysis_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  level      ENUM('INFO','WARN','ERROR') NOT NULL,
  message    VARCHAR(512) NOT NULL,
  detail     TEXT DEFAULT NULL COMMENT '异常堆栈或原始响应片段（≤2000 字符）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_level_time (level, created_at),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='NGA 舆情分析脚本日志';

-- 恢复外键检查
SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================================
-- 可选演示数据（生产可跳过；密码请用 npm run seed 生成，勿手写明文）
-- 角色股票示例（当前价=昨收=今开）
-- =====================================================================
-- INSERT INTO stocks (code, name, avatar_url, price, prev_close, open, high, low, volume, total_shares) VALUES
-- ('TY0001','钟离','https://...png', 680.5000, 680.5000, 680.5000, 680.5000, 680.5000, 0, 10000000),
-- ('TY0002','雷电将军','https://...png', 990.2500, 990.2500, 990.2500, 990.2500, 990.2500, 0, 8000000);

-- =====================================================================
-- 与生产库（MySQL 8.0.45）的差异说明
-- ---------------------------------------------------------------------
-- 1) 排序规则归一化：
--    生产库部分表使用 utf8mb4_0900_ai_ci（market_sentiment、
--    market_sentiment_stocks、news_impact、nga_analysis_log）或
--    utf8mb4_general_ci（fund_constituents、holding_lots），
--    本脚本统一改为 utf8mb4_unicode_ci；列级 CHARACTER SET/COLLATE
--    子句已移除，统一继承表级排序规则（兼容 MySQL 5.7 / MariaDB）。
-- 2) 已合并的重复索引（列名与顺序完全一致，只保留一个）：
--    · device_registrations: device_registrations_ip_created_at
--        ≡ idx_device_ip_time → 保留 idx_device_ip_time
--    · fund_constituents: fund_constituents_fund_id_constituent_id
--        ≡ uk_fund_constituent → 保留 uk_fund_constituent
--    · fund_constituents: fund_constituents_constituent_id
--        ≡ idx_fc_constituent → 保留 idx_fc_constituent
--    · holdings: holdings_user_id_stock_id
--        ≡ uk_holding_user_stock → 保留 uk_holding_user_stock
--    · market_sentiment: market_sentiment_review_status_fetched_at
--        ≡ idx_ms_review → 保留 idx_ms_review
--    · market_sentiment: market_sentiment_platform_fetched_at
--        ≡ idx_ms_platform_time → 保留 idx_ms_platform_time
--    · news: news_expires_at ≡ idx_news_expires → 保留 idx_news_expires
--    · news: news_publisher_id ≡ idx_news_publisher → 保留 idx_news_publisher
--    · news: news_review_status ≡ idx_news_review_status → 保留 idx_news_review_status
--    · news_stocks: news_stocks_news_id_stock_id(UNIQUE)
--        ≡ 主键(news_id,stock_id) → 保留主键
--    · news_stocks: news_stocks_stock_id ≡ idx_ns_stock → 保留 idx_ns_stock
--    · operation_logs: operation_logs_user_id_created_at
--        ≡ idx_logs_user_time → 保留 idx_logs_user_time
--    · operation_logs: operation_logs_action ≡ idx_logs_action → 保留 idx_logs_action
--    · orders: orders_user_id_status ≡ idx_orders_user_status → 保留 idx_orders_user_status
--    · orders: orders_stock_id_status ≡ idx_orders_stock_status → 保留 idx_orders_stock_status
--    · orders: orders_status_type ≡ idx_orders_status_type → 保留 idx_orders_status_type
--    · stocks: stocks_name ≡ idx_stocks_name → 保留 idx_stocks_name
--    · stocks: stocks_type ≡ idx_stocks_type → 保留 idx_stocks_type
--    · trades: trades_user_id_matched_at ≡ idx_trades_user_time → 保留 idx_trades_user_time
--    · trades: trades_stock_id_matched_at ≡ idx_trades_stock_time → 保留 idx_trades_stock_time
--    · trades: trades_order_id ≡ idx_trades_order → 保留 idx_trades_order
--    · trades: trades_matched_at ≡ idx_trades_matched → 保留 idx_trades_matched
--    · users: users_role ≡ idx_users_role → 保留 idx_users_role
--    · votes: votes_user_id_target_type_target_id
--        ≡ uk_vote_user_target → 保留 uk_vote_user_target
--    · votes: votes_target_type_target_id ≡ idx_votes_target → 保留 idx_votes_target
--    · watchlists: watchlists_user_id_stock_id
--        ≡ uk_watch_user_stock → 保留 uk_watch_user_stock
--    · watchlists: watchlists_stock_id ≡ idx_watch_stock → 保留 idx_watch_stock
-- 3) 生产库早期列注释存在历史乱码（UTF-8 字节被误按 GBK 解码存储，
--    例如 users.username 显示为「鐧诲綍鍚」），本脚本按生产库原样保留；
--    如需修正请另行编写迁移脚本。
-- 4) 移除了 mysqldump 产物：/*!40101 SET ... */、/*!50503 ... */、
--    AUTO_INCREMENT=N 等仅导出场景需要的语句。
-- 5) 兼容性：已将生产库的 utf8mb4_0900_ai_ci（仅 8.0 支持）全部替换为
--    utf8mb4_unicode_ci，无其它 5.7 / MariaDB 不兼容的语法遗留。
-- =====================================================================