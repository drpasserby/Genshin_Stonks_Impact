-- =====================================================================
-- 迁移：NGA 舆情监控搬到控制面板（全部配置项落 system_settings）
-- 日期：2026-09-13
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景（用户需求）：
--   抓取开关、频率、Gemini API Key、NGA Cookie、监测版面都必须能在
--   系统控制面板里配置，不再依赖服务器上的 .env / cookies.json 文件。
--
-- 本迁移做三件事：
--   1) 新增 7 个可配置项（面板「NGA 舆情监控」分组）
--   2) 新增 6 个运行状态项（面板「NGA 舆情监控 · 运行状态」分组，脚本回写、只读）
--   3) 把 .env / cookies.json 里的明文密钥与 Cookie 迁进数据库（有则迁，无则跳过）
--
-- ⚠️ 迁移完成后服务器上的 /etc/nga-analysis/.env 只剩数据库连接信息，
--    cookies.json 不再被脚本读取（可保留做备份，也可删）。
-- =====================================================================

/* ---------------- 1. 先扩容 s_value：Cookie 长度远超 500 ----------------
 * init.sql 里 s_value 是 VARCHAR(500)，而一条 NGA 登录 Cookie 实测 300~1500 字符，
 * 不扩容会直接报 "Data too long for column 's_value'"（我们第一次部署就踩到了）。
 * 幂等：已经是 VARCHAR(8192) 就不动；兼容 5.7/8.0（不依赖 8.0 的 TEXT DEFAULT）。
 * ------------------------------------------------------------- */
SET @c := (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'system_settings'
             AND COLUMN_NAME = 's_value');
SET @s := IF(@c IS NOT NULL AND @c < 8192,
  'ALTER TABLE system_settings MODIFY COLUMN s_value VARCHAR(8192) NOT NULL DEFAULT '''' COMMENT ''值（文本；Cookie/密钥可能较长，故给到 8192）''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ---------------- 2. 面板可配置项 ---------------- */

INSERT IGNORE INTO system_settings (s_key, s_value, description) VALUES
  ('nga_analysis_enabled', '0',
   'NGA 舆情分析总开关。关闭后定时任务仍每 5 分钟被唤起，但脚本只写一条「已跳过」日志就退出，不抓 NGA、不调 Gemini'),
  ('nga_interval_minutes', '180',
   '分析间隔（分钟）。调度器每 5 分钟唤起脚本，脚本发现距上次成功分析不足这个间隔就直接退出；默认 180 = 3 小时'),
  ('nga_forum_fid', '650',
   '监测版面 fid。原神主板 = 650，剑斗绮谭（战斗讨论子版）= 835；多个版面用英文逗号分隔，如 650,835'),
  ('nga_max_posts', '30',
   '单轮最多分析帖数（过滤后送 AI 的条数上限）'),
  ('gemini_api_key', '',
   'Google Gemini API Key（https://aistudio.google.com/apikey）。保存后不回显，只在面板显示“已配置（长度 N）”'),
  ('nga_cookie', '',
   'NGA 登录 Cookie（须含 ngaPassportUid= 与 ngaPassportCid=）。保存后不回显；Cookie 过期时在面板重新粘贴即可'),
  ('gemini_model', 'gemini-3.5-flash-lite',
   'Gemini 模型名。实测可用：gemini-3.5-flash-lite（最省 token）、gemini-3.6-flash');

/* ---------------- 2. 运行状态项（脚本回写，面板只读） ---------------- */

INSERT IGNORE INTO system_settings (s_key, s_value, description) VALUES
  ('nga_health_status', '尚未运行',
   '最近一轮结果（脚本回写）。出现「失败」时会附带阶段与原因，便于区分是 Cookie、版面权限还是 API 问题'),
  ('nga_health_last_run', '',
   '最近一轮结束时间（脚本回写，服务器时区）'),
  ('nga_health_last_success', '',
   '最近一轮整轮成功的时间（脚本回写）。长时间不更新说明一直在失败'),
  ('nga_health_cookie_ok_at', '',
   'Cookie 最近验证通过时间（NGA 抓取成功即更新）'),
  ('nga_health_api_ok_at', '',
   'Gemini API Key 最近验证通过时间（AI 调用成功即更新）'),
  ('nga_health_last_detail', '',
   '最近一轮统计摘要，如「版面=原神 fid=650 抓到=36 过滤=7 AI=10 写入=10」');

/* ---------------- 3. 把 .env / cookies.json 的值迁进数据库 ----------------
 * 敏感值不写进仓库文件。部署时由 server/scripts/nga_panel_migrate.py 完成：
 *   1) 用 pymysql 读 src 表并解密不了——直接读明文环境：
 *      · .env 里的 GEMINI_API_KEY
 *      · cookies.json 里的 cookie 字段
 *   2) UPDATE system_settings SET s_value=? WHERE s_key='gemini_api_key' / 'nga_cookie'
 *   3) 删除旧的大写键 NGA_* / GEMINI_*（值已在大写新键里就位）
 * 迁移后 /etc/nga-analysis/.env 只剩数据库连接，cookies.json 不再被脚本读取。
 * ------------------------------------------------------------- */

-- 旧键搬迁由上面的 Python 脚本负责（它同时负责删旧键），这里只须确认结果：
SELECT '见部署脚本输出' AS migrate_note;
/* ---------------- 4. 校验 ---------------- */

SELECT s_key, IF(s_key IN ('gemini_api_key', 'nga_cookie'),
                 IF(s_value = '', '（空）', CONCAT('已配置(', LENGTH(s_value), ' 字符)')),
                 s_value) AS value_view,
       description
  FROM system_settings
 WHERE s_key LIKE 'nga\_%' OR s_key LIKE 'gemini\_%'
 ORDER BY s_key;
