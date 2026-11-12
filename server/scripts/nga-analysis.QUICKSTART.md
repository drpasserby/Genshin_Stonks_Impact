# NGA 舆情分析 · 快速上手（TL;DR）

只有 4 个文件参与部署，其余两个是本地测试用的：

```
server/scripts/nga_analysis.py                       主脚本
server/sql/migrations/2026-09-12_nga_news_impact.sql 建表 + 写配置项默认值
server/scripts/nga-analysis.env.example              .env 模板
server/scripts/nga-analysis.DEPLOY.txt               完整部署文档（本文件是精简版）
server/scripts/_selftest_nga_analysis.py             离线自测（51 项断言）
server/scripts/_memprobe_nga.py                      内存上限实测探针
```

---

## 一、先准备 3 样东西

1. **NGA 原神版面的 fid**
   浏览器登录 NGA → 打开原神版面 → 地址栏 `thread.php?fid=xxx` 里的 `xxx` 就是 fid。
   没登录能打开说明是公开版面；本脚本要求带 Cookie（登录态），否则会被判定 `[COOKIE_EXPIRED]`。
2. **NGA Cookie**
   登录后按 F12 → Network → 随便点一个请求 → 复制 Request Headers 里的整条 `Cookie:` 值。
3. **Gemini API Key**：https://aistudio.google.com/apikey 免费申请。

---

## 二、5 条命令部署（root 身份）

```bash
# 1. 建表 + 写入配置项默认值（幂等，可重复执行）
mysql -uteyvat -p__DB_PASSWORD__ -h127.0.0.1 teyvat_stock < /www/wwwroot/teyvat/server/sql/migrations/2026-09-12_nga_news_impact.sql

# 2. 建配置目录（权限 700/600，只有 root 能读）
install -d -m 700 /etc/nga-analysis

# 3. 写 .env（照抄 nga-analysis.env.example，替换 GEMINI_API_KEY 和 DB_PASS）
vi /etc/nga-analysis/.env

# 4. 写 Cookie（注意：是 JSON，不是裸 Cookie 字符串）
echo '{"cookie": "把刚才复制的整条 Cookie 粘这里"}' > /etc/nga-analysis/cookies.json
chmod 600 /etc/nga-analysis/.env /etc/nga-analysis/cookies.json

# 5. 建虚拟环境 + 装依赖（只有两个包）
apt-get install -y python3-venv
python3 -m venv /opt/teyvat-nga/venv
/opt/teyvat-nga/venv/bin/pip install --no-cache-dir pymysql python-dotenv
cp /www/wwwroot/teyvat/server/scripts/nga_analysis.py /opt/teyvat-nga/
```

## 三、填 fid（必须做，否则脚本会直接报错退出）

```bash
mysql -uteyvat -p__DB_PASSWORD__ -h127.0.0.1 teyvat_stock \
  -e "UPDATE system_settings SET s_value='你查到的fid' WHERE s_key='NGA_FORUM_FID';"
```

## 四、试跑一次

```bash
/opt/teyvat-nga/venv/bin/python /opt/teyvat-nga/nga_analysis.py; echo "exit=$?"

# 看结果（日志全在数据库里，不看控制台）
mysql -uteyvat -p__DB_PASSWORD__ -h127.0.0.1 teyvat_stock -e "
SELECT level,message,created_at FROM nga_analysis_log ORDER BY id DESC LIMIT 20;
SELECT entity_type,entity_name,raw_impact,confidence,summary,analyzed_at
  FROM news_impact ORDER BY analyzed_at DESC LIMIT 20;"
```

**期望在日志里看到这 6 条**：脚本启动 → 白名单载入完成 → 抓取成功 → AI 返回 N 条 → news_impact 写入完成 → 脚本结束。
`exit=0` 是正常的（Cookie 失效、抓取失败也是 0，详情看 `nga_analysis_log` 的 ERROR 行）。

## 五、挂 crontab（每 3 小时第 3 分钟）

```bash
crontab -e
```
```cron
3 */3 * * * cd /opt/teyvat-nga && /opt/teyvat-nga/venv/bin/python /opt/teyvat-nga/nga_analysis.py >/dev/null 2>&1
```
`>/dev/null` 是故意的：日志写库，控制台输出没用；只有「数据库连不上」才返回 2，那时才需要 cron 给你发邮件。

---

## 六、日常运维（3 件事）

| 情况 | 现象 | 处理 |
|---|---|---|
| Cookie 过期 | `nga_analysis_log` 出现 `[COOKIE_EXPIRED]` 的 ERROR | 重新复制 Cookie 覆盖 `/etc/nga-analysis/cookies.json` 即可，脚本不用重启 |
| 内存/CPU 不够 | 日志出现 `MemoryError` | 在 `/etc/nga-analysis/.env` 加 `NGA_RLIMIT_AS_MB=96`（默认 64） |
| 调参 | 改分析帖数/超时/模型 | 直接改 `system_settings` 表，改完下一轮自动生效（脚本每轮重读） |

```bash
# 部署前建议先实测内存上限（逐级设限跑真实数据规模，告诉你哪个值会崩）
/opt/teyvat-nga/venv/bin/python /www/wwwroot/teyvat/server/scripts/_memprobe_nga.py

# 改过脚本后跑离线自测（不联网、不连库）
python3 /www/wwwroot/teyvat/server/scripts/_selftest_nga_analysis.py
```

---

## 七、记住 4 条设计要点

1. **原始帖子不落库**：`news_impact` 只存 AI 输出的结构化影响值，帖子内容全在内存里处理完就丢。
2. **每实体只有一行**：唯一键 `(entity_type, entity_name)`，每轮是 upsert **覆盖**，不会无限增长。
3. **`entity_type` 的含义**：`role` = `stocks.type='STOCK'`（角色股），`fund` = `stocks.type='FUND'`（指数基金）——本地项目角色和基金共用 `stocks` 一张表。
4. **后端怎么用**：市场情绪已接入撮合（`engine.js` 的 `sentimentFactor`，权重 `system_settings.sentiment_weight`，
   默认 0.2）—— 见 `docs/PRICING.md` 第 14 章。而 `news_impact`（逐实体影响值）目前**只留档、不参与定价**：
   它没有审核状态与有效期，直接当定价因子会让未审核的 AI 判断绕过审核。

---

## 八、接口细节看这里

抓取用的两个 NGA 接口（列表取标题、`read.php` 取主楼+回复）、请求头、响应字段表、
分页与楼层上限、以及「试过但不能用的端点」，全部整理在 **`docs/NGA_API.md`**。
改抓取逻辑前先看它，能省掉一轮踩坑。
