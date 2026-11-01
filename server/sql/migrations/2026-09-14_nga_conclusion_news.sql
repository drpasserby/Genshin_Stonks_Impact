-- =====================================================================
-- 迁移：NGA 舆情结论自动发新闻（新增 3 个面板配置项）
-- 日期：2026-09-14
-- 兼容：MySQL 8.0 / 5.7 / MariaDB（幂等，可重复执行）
--
-- 背景（用户需求）：每轮舆情分析结束后，除了各实体的影响值，
--   还要输出一条「所有角色的总结论」并发成新闻，链接指向对应版面，
--   标题 20 字左右，**进入待审核**（管理员通过后才生效、才影响股价）。
--
-- 说明：这三项也可以不跑本 SQL——后端启动时的 ensureDefaults() 会按
--   SETTING_SCHEMA 自动补齐。写在这里是为了让「改动可追溯」，
--   并且给生产环境一个显式执行的入口（与其它迁移一起跑）。
-- =====================================================================

INSERT IGNORE INTO system_settings (s_key, s_value, description) VALUES
  ('nga_news_auto_publish', '1',
   '每轮分析完，把「所有角色」的总结论自动发成一条新闻（进入待审核，管理员通过后才生效、才影响股价）。同版面同一天的舆情新闻只保留一条待审条目，不会刷屏'),
  ('nga_news_publisher_id', '',
   '自动发布的舆情新闻挂在哪个账号名下（必须是管理员/超级管理员）。留空 = 自动取第一个超级管理员'),
  ('nga_news_max_stocks', '5',
   '结论新闻按影响值绝对值取前 N 个角色关联（后端限制单条新闻最多 10 个）');

/* ---------------- 校验 ---------------- */

SELECT s_key, s_value, description
  FROM system_settings
 WHERE s_key IN ('nga_news_auto_publish', 'nga_news_publisher_id', 'nga_news_max_stocks')
 ORDER BY s_key;

-- 顺带看一下：可选的发布者账号（脚本要求 root/admin）
SELECT id, username, nickname, role FROM users
 WHERE status = 1 AND role IN ('root', 'admin') ORDER BY id;
