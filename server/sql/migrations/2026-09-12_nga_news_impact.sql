-- =====================================================================
-- 迁移：NGA 舆情分析（每 3 小时一次，见 server/scripts/nga_analysis.py）
-- 日期：2026-09-12
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 本迁移只做三件事：
--   1) 建 news_impact      —— AI 输出的结构化影响值（原始帖子内容不落库）
--   2) 建 nga_analysis_log —— 分析脚本的数据库日志
--   3) 往 system_settings 补 NGA_* / GEMINI_* / NEWS_* 配置项默认值
--
-- ⚠️ 与「通用假设」不同的本地实际情况（以本仓库为准）：
--   * 配置表是 system_settings，列名是 s_key / s_value
--     （见 server/sql/init.sql 与 server/src/models/systemSetting.js：
--      Sequelize 的 key/value 映射到 s_key/s_value，避开保留字 KEY）
--   * 角色与基金不是 roles / funds 两张表，而是 stocks 一张表用 type 区分：
--       type='STOCK' → 角色股     type='FUND' → 指数基金
--     （见 server/src/models/stock.js）
--   * 因此 news_impact.entity_type 的 'role' / 'fund' 由 stocks.type 映射而来，
--     命名保持脚本与后端撮合程序的约定，不改 stocks 表结构。
--
-- 撮合侧落地提示（本迁移不含后端代码改动）：
--   NEWS_IMPACT_WEIGHT 与 .env 的 WEIGHT_NEWS（默认 0.3）同量级，
--   news_impact.raw_impact ∈ [-1,1] 可直接当成 PRICING.md 里的「新闻因子」，
--   后端按 entity_name JOIN stocks.name 取值即可，无需改定价公式。
-- =====================================================================

/* ---------------- 1. AI 影响值表 ---------------- */

CREATE TABLE IF NOT EXISTS news_impact (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    entity_type   ENUM('role', 'fund') NOT NULL COMMENT 'role=角色股(stocks.type=STOCK) fund=指数基金(stocks.type=FUND)',
    entity_name   VARCHAR(64)  NOT NULL COMMENT '实体名，等于 stocks.name',
    impact_value  DECIMAL(6,4) NOT NULL COMMENT '生效影响值（当前等于 raw_impact，后续可加衰减）',
    raw_impact    DECIMAL(6,4) NOT NULL COMMENT 'AI 原始影响值 -1.0000~1.0000',
    confidence    DECIMAL(4,3) NOT NULL DEFAULT 1.000 COMMENT 'AI 置信度 0~1',
    summary       VARCHAR(255) DEFAULT NULL COMMENT 'AI 一句话理由（≤30 字）',
    source_count  INT UNSIGNED DEFAULT 0 COMMENT '本次分析纳入的帖子数',
    analyzed_at   DATETIME     NOT NULL COMMENT '本次分析时刻',
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_entity (entity_type, entity_name),
    INDEX idx_analyzed (analyzed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NGA 舆情 AI 影响值（每 3 小时覆盖一次）';

/* ---------------- 2. 分析日志表 ---------------- */

CREATE TABLE IF NOT EXISTS nga_analysis_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    level      ENUM('INFO', 'WARN', 'ERROR') NOT NULL,
    message    VARCHAR(512) NOT NULL,
    detail     TEXT DEFAULT NULL COMMENT '异常堆栈或原始响应片段（≤2000 字符）',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_level_time (level, created_at),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NGA 舆情分析脚本日志';

/* ---------------- 3. system_settings 补默认配置 ----------------
 * INSERT IGNORE + uk_settings_key(s_key) 唯一键 → 幂等，
 * 且绝不覆盖管理员在控制面板里改过的值。
 * ------------------------------------------------------------- */

INSERT IGNORE INTO system_settings (s_key, s_value, description) VALUES
  ('NGA_FORUM_FID',        '-1',                   'NGA 目标版面ID（原神相关版面的 fid）；-1=未配置，脚本会直接记录 ERROR 退出。生产已设为 835=剑斗绮谭，主板 650'),
  ('NGA_MAX_POSTS',        '30',                   '单次分析最多纳入的帖子数'),
  ('NGA_REQUEST_TIMEOUT',  '15',                   'NGA thread.php 请求超时（秒）'),
  ('GEMINI_MODEL',         'gemini-3.5-flash-lite','Gemini 模型名（脚本调 generateContent）。注意 gemini-2.5-flash-lite 已对新用户下线(404)，实测可用且省 token 的是 3.5-flash-lite'),
  ('GEMINI_MAX_RETRIES',   '2',                    'Gemini 调用最大重试次数（每次间隔 5 秒）'),
  ('GEMINI_TIMEOUT_SECONDS','30',                   'Gemini API 超时（秒）'),
  ('NEWS_IMPACT_WEIGHT',   '0.3',                  '舆情影响值在撮合中的权重（供后端使用，本脚本只读）'),
  ('NEWS_DECAY_FACTOR',    '1.0',                  '舆情影响值的时间衰减系数（供后端使用，本脚本只读）'),
  ('NEWS_MIN_THRESHOLD',   '0.05',                 '低于该绝对值的舆情影响值被后端忽略（本脚本只读）');

/* ---------------- 4. 校验 ---------------- */

SHOW TABLES LIKE 'news_impact';
SHOW TABLES LIKE 'nga_analysis_log';

SELECT s_key, s_value, description FROM system_settings
WHERE s_key IN ('NGA_FORUM_FID','NGA_MAX_POSTS','NGA_REQUEST_TIMEOUT','GEMINI_MODEL',
                'GEMINI_MAX_RETRIES','GEMINI_TIMEOUT_SECONDS',
                'NEWS_IMPACT_WEIGHT','NEWS_DECAY_FACTOR','NEWS_MIN_THRESHOLD')
ORDER BY s_key;

-- 白名单规模自检（AI 提示词里会塞这些名字，两个数都应为正）
SELECT type, COUNT(*) AS cnt FROM stocks WHERE status <> 2 GROUP BY type;
