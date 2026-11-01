-- =====================================================================
-- 迁移：清理已经无用的配置项（4 个）
-- 日期：2026-09-14
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 清理依据（逐个查过代码，确认「没有任何代码读它」或「读了但不产生任何效果」）：
--
--   1) nga_news_publisher_id —— 原文案「市场情绪的展示账号」
--      为什么无用：结论最早是按「新闻」发布的，需要指定发布账号；改成市场情绪后
--      作者是纯文本 author_label（「NGA 自动总结」），脚本里那句
--      `publisher_id = cfg.get('nga_news_publisher_id')` 读出来之后再没被用过（死变量）。
--      它还会让面板设置接口多查一次用户表，纯属负担 —— 删。
--
--   2~4) NEWS_IMPACT_WEIGHT / NEWS_DECAY_FACTOR / NEWS_MIN_THRESHOLD
--      原文案「舆情影响值在撮合中的权重 / 时间衰减系数 / 忽略阈值（供后端使用）」
--      为什么无用：这是「把 news_impact 逐实体影响值直接接进撮合」的早期方案留下的三件套，
--      该方案从未实现（news_impact 没有审核状态与有效期，直接定价会绕过审核），
--      现在由「市场情绪」承担这件事（有审核状态、有失效时长）。脚本里也只是读了放着，
--      三个键都不在 SETTING_SCHEMA 里，面板上根本看不见，属于纯粹的库内垃圾 —— 删。
--
-- 安全性：脚本与后端都已不再引用这 4 个键（回归断言会挡住重新引入）。
-- =====================================================================

DELETE FROM system_settings
 WHERE s_key IN ('nga_news_publisher_id',
                 'NEWS_IMPACT_WEIGHT', 'NEWS_DECAY_FACTOR', 'NEWS_MIN_THRESHOLD');

/* ---------------- 校验：应为 0 行 ---------------- */

SELECT COUNT(*) AS remaining_dead_keys
  FROM system_settings
 WHERE s_key IN ('nga_news_publisher_id',
                 'NEWS_IMPACT_WEIGHT', 'NEWS_DECAY_FACTOR', 'NEWS_MIN_THRESHOLD');
