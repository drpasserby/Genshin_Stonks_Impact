#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
提瓦特证券交易所 —— NGA 舆情分析（cron 每 5 分钟唤起，跑完即退出）

流程：
  1. 读 /etc/nga-analysis/.env（**只含数据库连接**，面板要读库，这步无法避免）
  2. 连库，从 system_settings 读全部运行配置（面板「市场情绪」分组可直接改）
  3. 【开关】未启用 → 写一条 INFO 后退出，不产生任何外部请求
  4. 【频率】距上次分析不足「分析间隔」→ 写一条 INFO 后退出（所以 crontab 固定每 5 分钟）
  5. GET NGA thread.php?fid=<fid>&__output=11 取帖子列表（多版面用逗号分隔）
  6. 内存中过滤（标题/摘要含「原神」或白名单实体名），最多 nga_max_posts 条
  7. 白名单 = stocks 表 type='STOCK'（角色股）+ type='FUND'（指数基金）
  8. 逐帖 GET read.php?tid=<tid> 补正文（主楼 + 前几层回复），见 extract_thread_text()
  9. 调 Gemini REST 拿结构化影响值数组
 10. upsert 进 news_impact；日志写 nga_analysis_log（复用同一个连接）
 11. 收尾写一条 [NGA-SUCCESS]/[NGA-FAILED]/[NGA-DRYRUN]/[NGA-PARTIAL] 消息，
     并把结果回写 system_settings 的 nga_health_* 项（控制面板「运行状态」只读展示）
 12. 关连接、退出（业务性失败也返回 0，避免 cron 发告警邮件；只有连不上库才返回 2）

命令行：
  --dry-run  跑完整流程但不写 news_impact，并把 AI 原始回复打到 stdout
  --force    忽略「分析间隔」门控，立刻跑一轮

★ 接口细节的完整文档（请求头、响应字段表、试过不能用的端点、体积/耗时实测）：
  docs/NGA_API.md  ← 改抓取逻辑前先看它

★ 与「通用假设」不同的本地实际情况（以本仓库为准）：
  * 配置表不是 system_config(config_key,config_value)，而是 system_settings(s_key,s_value)
    —— 见 server/sql/init.sql、server/src/models/systemSetting.js
  * 角色与基金不是 roles / funds 两张表，而是 stocks 一张表用 type 区分
    （type='STOCK' 角色股 / 'FUND' 指数基金）—— 见 server/src/models/stock.js
  * 因此 news_impact.entity_type 由 stocks.type 映射：STOCK→'role'，FUND→'fund'
  * 帖子列表接口是 GET thread.php?fid=..&__output=11（不是 POST forum.php），
    响应在 data.__T；详见 fetch_forum() 的注释与 docs/NGA_API.md（2026-09 服务器实测）
  * 正文接口是 GET read.php?tid=..（HTML 版）；其 __output=11 的 JSON 版会被 CDN
    缓存成截断片段，不可作为唯一数据源 —— 见 docs/NGA_API.md §3

依赖：pymysql、python-dotenv（仅此两个）
"""

import os
import re
import sys
import json
import time
import ssl
import gzip
import zlib
import logging
import datetime
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, ROUND_HALF_UP

# ============================================================================
# 0. 资源硬限制 / 环境
# ============================================================================
# 说明：RLIMIT_AS(地址空间) 会把 Python 解释器自身 + 依赖 + 请求缓冲全部计入，
#       64MB 是极限值，若线上出现 MemoryError，用环境变量放宽即可（不改代码）：
#         NGA_RLIMIT_AS_MB / NGA_RLIMIT_CPU_S
#       RLIMIT_CPU 是 CPU 时间（不含网络等待），60s 对应「Gemini 重试 2 次」的档位。
def apply_rlimits():
    try:
        import resource  # 仅 Linux 有
    except ImportError:  # pragma: no cover - Windows 本地调试
        sys.stderr.write('[WARN] 非 Linux 环境，跳过 resource 资源限制\n')
        return
    try:
        as_mb = int(os.environ.get('NGA_RLIMIT_AS_MB', '64'))
        cpu_s = int(os.environ.get('NGA_RLIMIT_CPU_S', '60'))
        resource.setrlimit(resource.RLIMIT_AS, (as_mb * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s))
    except Exception as exc:  # 限制失败不能挡住主流程（例如容器已设过更低值）
        sys.stderr.write('[WARN] 设置资源限制失败: %r\n' % (exc,))


ENV_FILE = os.environ.get('NGA_ENV_FILE', '/etc/nga-analysis/.env')

# 运行配置全部来自 system_settings（控制面板可改），这里的默认值只在配置项缺失时兜底。
# ★ 键名必须与控制面板 SETTING_SCHEMA 完全一致（全小写 snake_case）——两边读同一批键，
#   曾经这里写成大写 NGA_*，导致「面板改了但脚本读不到」，踩过一次。
DEFAULTS = {
    'nga_analysis_enabled': ('0', str),        # 总开关，面板默认关闭，避免一上线就外呼
    'nga_interval_minutes': ('180', int),      # 真正分析的间隔（分钟）；调度每 5 分钟唤起一次
    'nga_forum_fid': ('650', str),             # 版面 fid，可逗号分隔多个；650=原神主板 835=剑斗绮谭
    'nga_max_posts': ('30', int),
    'nga_request_timeout': ('15', int),
    # 帖子正文：列表接口只给标题，正文要按 tid 逐帖另抓（HTML 版）
    'nga_fetch_content': ('1', str),
    'nga_content_max_threads': ('12', int),
    # 每帖取几层（1 = 只主楼）。同一页 HTML 里本来就有主楼 + 约 19 层回复，
    # 取回复不增加请求 —— 只影响送进 AI 的字数（实测 1 层≈1248 tokens / 8 层≈4259 / 20 层≈9383）。
    'nga_content_max_floors': ('8', int),
    'gemini_model': ('gemini-3.5-flash-lite', str),
    'gemini_max_retries': ('2', int),
    'gemini_timeout_seconds': ('30', int),
    'gemini_api_key': ('', str),
    'nga_cookie': ('', str),
    # 结论自动写入市场情绪（进入待审，管理员审核后才对外显示）
    'nga_news_auto_publish': ('1', str),
    'nga_news_max_stocks': ('5', int),    # 每条情绪最多关联几个角色
    # 自动通过审核：开启后本轮写出的情绪直接是「已通过」，不再进人工审核队列。
    # 发布时间 = 通过审核时间（同一时刻），审核人登记为系统自动审核（用户 8：bot_summary）。
    'sentiment_auto_approve': ('0', str),
}

# 自动审核的登记人：users.id = 8 的 bot_summary（昵称「NGA自动总结」）。
# 用一个真实用户 ID 而不是 NULL，是为了让审核留痕能追到「谁批的」——
# 前台不会显示它，只有管理端列表的「审核人」一列会显示。
AUTO_REVIEW_BOT_ID = 8

# 运行状态回写项（面板「市场情绪 · 运行状态」分组，只读展示）
HEALTH_KEYS = {
    'status': 'nga_health_status',
    'last_run': 'nga_health_last_run',
    'last_success': 'nga_health_last_success',
    'cookie_ok': 'nga_health_cookie_ok_at',
    'api_ok': 'nga_health_api_ok_at',
    'detail': 'nga_health_last_detail',
}

PROMPT_TEMPLATE = """你是一个专业的游戏社区舆情分析师，负责分析NGA论坛中与《原神》相关的讨论，并评估这些讨论对特定角色或基金的影响。

【可分析的实体白名单】
{entity_list}

【论坛帖子内容】
{posts_text}

【任务】
分析上述帖子，判断它们对白名单中每个实体的影响程度。只输出JSON数组，不要输出任何其他文字。

输出格式（严格遵守）：
[
  {{
    "entity": "<必须是白名单中的名称，严格匹配>",
    "impact": <浮点数，-1到1，负数表示利空，正数表示利好>,
    "confidence": <浮点数，0到1，表示你对该判断的置信度>,
    "summary": "<不超过30字的中文总结，说明原因>"
  }}
]

规则：
- 只输出白名单中确实被讨论到的实体，未被讨论的不要输出
- 如果帖子内容与某个实体无关，不要强行关联
- impact的绝对值反映影响强度，confidence反映你的确定程度
- 最多输出10个实体
- **只依据帖子正文判断**：提问帖（「怎么配队」「该抽谁」）、签到活动帖、版务公告帖
  本身不含情绪，不要因为它们提到了某个角色就给出影响值
- 结论要以「发帖人表达的褒贬」为准，不要因为一个角色被频繁提及就判成利好"""

# 明显不含市场情绪的帖子特征：求助、提问、公告、签到/活动
# ★ 刻意保守：宁可漏过几条提问帖（AI 还有正文可判断），也不误杀真实情绪帖。
#   例如「家人们这新角色怎么这么强」是情绪，「家人们我这个号怎么救」才是提问——
#   所以这里不做「家人们…怎么」这种宽泛匹配，只匹配明确的求助/公告词。
SKIP_TITLE_RE = re.compile(
    r'\[[^\]]{0,6}(版务|公告|活动|醒目|提醒|更新|维护)[^\]]{0,6}\]|签到活动|'
    r'请问|求教|请教|求助|咨询|萌新.{0,6}(求|问)|'
    r'该怎么|该不该|值不值|要不要抽|该抽谁|怎么办|怎么配队|大佬们|有没有人|在线等|求个|求推荐')


def looks_like_question(subject):
    """
    标题像提问/求助/公告/活动帖 → 不含市场情绪，不参与舆情判断。
    注意：这里只看**标题**，且用词表刻意保守（见上面的说明）。
    """
    return bool(SKIP_TITLE_RE.search(subject or ''))

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

_raw_log = logging.getLogger('nga')  # 日志先挂 Redis 式 Handler 再赋值给 log


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


class SafeLog:
    """
    日志包装：把「写日志」这个动作和「主流程」解耦。
    正常情况直接转发给 logging（落库）；一旦 logging 抛异常（典型场景是
    数据库连接被中途掐断，此时 Handler 的降级写 stderr 也救不了异常本身），
    就退化为 stderr，并且绝不让异常冒泡打断主流程。
    """

    def __init__(self, logger):
        self._logger = logger

    def _emit(self, level, msg, **kw):
        try:
            getattr(self._logger, level)(msg, **kw)
        except Exception:  # noqa: BLE001
            try:
                sys.stderr.write('[LOG-FALLBACK] %s %s\n' % (level.upper(), msg))
            except Exception:
                pass

    def info(self, msg, **kw):
        self._emit('info', msg, **kw)

    def warning(self, msg, **kw):
        self._emit('warning', msg, **kw)

    def error(self, msg, **kw):
        self._emit('error', msg, **kw)


def to_float(v, default=0.0):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


# setup_logger() 之后会被替换成挂了数据库 Handler 的版本；
# 这里先给一个不需要数据库就能用的默认值，避免任何路径下 log 是 None。
log = SafeLog(_raw_log)


# ============================================================================
# 1. 数据库日志 Handler（复用主连接；自身绝不抛异常）
# ============================================================================
class MysqlLogHandler(logging.Handler):
    """把日志写进 nga_analysis_log。任何一个环节出错都退化为 stderr，不影响主流程。"""

    def __init__(self, conn):
        super().__init__(level=logging.INFO)
        self.conn = conn
        self._broken = False  # 连接/表彻底不可用后不再重试，避免每次日志都报错

    def emit(self, record):
        if self._broken:
            return
        try:
            level = record.levelname if record.levelname in ('INFO', 'WARN', 'ERROR') else 'INFO'
            msg = str(record.getMessage())[:512]
            detail = None
            if record.exc_info:
                detail = logging.Formatter().formatException(record.exc_info)
            elif getattr(record, 'detail', None):
                detail = str(record.detail)
            if detail:
                detail = detail[:2000]
            with self.conn.cursor() as cur:
                cur.execute(
                    'INSERT INTO nga_analysis_log (level, message, detail) VALUES (%s, %s, %s)',
                    (level, msg, detail),
                )
            self.conn.commit()
        except Exception as exc:  # noqa: BLE001 —— 日志失败绝不中断主流程
            self._broken = True
            try:
                sys.stderr.write('[LOGGING-FALLBACK] %s | %s (handler err: %r)\n'
                                 % (record.levelname, record.getMessage(), exc))
            except Exception:
                pass


def setup_logger(conn):
    """
    把数据库 Handler 挂到模块级 logger 上，并把 log 换成带保护的包装对象。
    返回 Handler 便于主流程收尾时摘除。
    """
    global log
    _raw_log.setLevel(logging.INFO)
    _raw_log.propagate = False
    handler = MysqlLogHandler(conn)
    _raw_log.addHandler(handler)
    log = SafeLog(_raw_log)
    return handler


# ============================================================================
# 2. 配置读取（system_settings.s_key / s_value）
# ============================================================================
def load_settings(conn):
    """返回 {key: typed_value}；缺失/非法一律回退代码默认值并 WARN。"""
    rows = {}
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT s_key, s_value FROM system_settings')
            for k, v in cur.fetchall():
                rows[str(k)] = v
    except Exception as exc:  # noqa: BLE001
        log.warning('读取 system_settings 失败，全部使用代码默认值', exc_info=True)
        sys.stderr.write('[WARN] 读取 system_settings 失败: %r\n' % (exc,))

    cfg = {}
    for key, (raw_default, caster) in DEFAULTS.items():
        raw = rows.get(key)
        if raw is None or str(raw).strip() == '':
            log.warning('配置项 %s 缺失，使用默认值 %s' % (key, raw_default))
            cfg[key] = caster(raw_default)
            continue
        try:
            cfg[key] = caster(str(raw).strip())
        except (TypeError, ValueError):
            log.warning('配置项 %s 值非法(%r)，使用默认值 %s' % (key, raw, raw_default))
            cfg[key] = caster(raw_default)

    # 收敛到安全范围，避免脏配置把脚本打死
    cfg['nga_interval_minutes'] = int(clamp(cfg['nga_interval_minutes'], 0, 1440))
    cfg['nga_max_posts'] = int(clamp(cfg['nga_max_posts'], 1, 200))
    cfg['nga_request_timeout'] = int(clamp(cfg['nga_request_timeout'], 3, 60))
    cfg['nga_content_max_threads'] = int(clamp(cfg['nga_content_max_threads'], 0, 30))
    cfg['nga_content_max_floors'] = int(clamp(cfg['nga_content_max_floors'], 1, 20))
    cfg['gemini_timeout_seconds'] = int(clamp(cfg['gemini_timeout_seconds'], 5, 120))
    cfg['gemini_max_retries'] = int(clamp(cfg['gemini_max_retries'], 0, 5))
    cfg['nga_cookie'] = cfg['nga_cookie'].strip()
    cfg['gemini_api_key'] = cfg['gemini_api_key'].strip()
    # 版面 fid 允许逗号分隔多版面，只保留合法数字，去掉空白
    fids = [x.strip() for x in cfg['nga_forum_fid'].split(',')]
    cfg['nga_forum_fid'] = ','.join(x for x in fids if re.fullmatch(r'-?\d{1,12}', x))
    return cfg


def load_last_run_ts(conn):
    """
    上一次「真正跑完一轮」的时间（取自日志表，脚本自维护，无需额外状态表）。

    ⚠️ 2026-09-15 修复（此前导致自动分析从不运行）：
      原来取的是全表 MAX(created_at)，但**本轮运行在门控之前就已经写了
      「NGA 舆情分析脚本启动」这条日志**，于是算出来的间隔恒为 0.0 分钟，
      永远小于配置的「分析间隔」→ 每轮都被判定「未到间隔」直接跳过，
      只有面板「立即抓取」（--force 绕开门控）才真正跑过。

      现在只统计**终结行**：脚本收尾必定写一条 `[NGA-SUCCESS]` /
      `[NGA-FAILED]` / `[NGA-PARTIAL]` / `[NGA-DRYRUN]`，
      而「脚本启动」「未到分析间隔…跳过」这两类噪音行不再参与计时。

      用 LEFT(...) 而不是 LIKE '...%'：本文件的 pymysql 调用多为手工 % 拼接，
      避免 SQL 里的 % 引起歧义。
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT UNIX_TIMESTAMP(MAX(created_at)) FROM nga_analysis_log "
                "WHERE LEFT(message, 5) = '[NGA-'"
            )
            row = cur.fetchone() if hasattr(cur, 'fetchone') else (cur.fetchall() or [None])[0]
        return float(row[0]) if row and row[0] is not None else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


def should_run(conn, cfg, force):
    """
    频率门控：cron 每 5 分钟唤起一次，这里按面板配置的间隔决定是否真跑。
    返回 (是否运行, 距上次多少分钟)。
    这样「抓取频率」是面板配置项，改完下一轮就生效，不用动 crontab。
    """
    if force:
        return True, -1.0
    interval = cfg['nga_interval_minutes']
    if interval <= 0:
        return True, -1.0          # 0 = 不限制，每次唤起都跑
    last = load_last_run_ts(conn)
    if not last:
        return True, -1.0
    elapsed_min = (time.time() - last) / 60.0
    return (elapsed_min >= interval), elapsed_min


def health_update(conn, status=None, detail=None, touch_success=False,
                  cookie_ok=False, api_ok=False, now_str=None):
    """
    把本轮结果回写到 system_settings 的 nga_health_* 项（面板「运行状态」只读展示）。
    只更新已存在的行，绝不新增（避免脚本擅自往配置表塞东西）。
    任何失败都只警告，不影响主流程。
    """
    now_str = now_str or datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    kv = {}
    if status is not None:
        kv[HEALTH_KEYS['status']] = str(status)[:255]
    kv[HEALTH_KEYS['last_run']] = now_str
    if detail is not None:
        kv[HEALTH_KEYS['detail']] = str(detail)[:500]
    if touch_success:
        kv[HEALTH_KEYS['last_success']] = now_str
    if cookie_ok:
        kv[HEALTH_KEYS['cookie_ok']] = now_str
    if api_ok:
        kv[HEALTH_KEYS['api_ok']] = now_str
    try:
        with conn.cursor() as cur:
            for k, v in kv.items():
                cur.execute('UPDATE system_settings SET s_value=%s WHERE s_key=%s', (v, k))
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning('回写运行状态失败：%r' % (exc,))


def load_entity_whitelist(conn):
    """白名单 = stocks 表：type='STOCK' 角色股 + type='FUND' 指数基金。"""
    roles, funds = {}, {}
    with conn.cursor() as cur:
        cur.execute("SELECT name, type FROM stocks WHERE status <> 2 ORDER BY id")
        for name, stype in cur.fetchall():
            name = (name or '').strip()
            if not name or len(name) > 64:
                continue
            if str(stype).upper() == 'FUND':
                funds[name] = 'fund'
            else:
                roles[name] = 'role'
    # 角色名优先（同名时角色优先，正常不会重名：uk_stocks_name 是唯一键）
    whitelist = dict(funds)
    whitelist.update(roles)
    return whitelist


# ============================================================================
# 3. 抓取 NGA
# ============================================================================
class CookieExpired(Exception):
    """Cookie 失效：正常退出（退出码 0）只留 ERROR 日志。"""


class FetchFailed(Exception):
    """网络/协议失败：记录 ERROR 后正常退出，不重试。"""


def check_cookie(cookie):
    """
    校验面板里配的 Cookie 是否像「已登录」。
    ★ 实测：只带访客 Cookie（缺 ngaPassportUid/ngaPassportCid）时 NGA 会按游客处理，
      响应里 denied:true —— 提前在这里判掉，日志能直接说明是人没登录还是 Cookie 过期。
    """
    if not cookie or not cookie.strip():
        raise CookieExpired('控制面板「市场情绪 → NGA Cookie」为空')
    ck = cookie.strip()
    if 'ngaPassportUid' not in ck and 'ngaPassportCid' not in ck:
        raise CookieExpired('Cookie 缺少 ngaPassportUid / ngaPassportCid（这是未登录状态的 Cookie）')
    return ck


def http_post(url, data_bytes, headers, timeout):
    """标准库 POST，返回 (status, body_bytes)。不吃 4xx/5xx 异常，交给调用方判断。"""
    req = urllib.request.Request(url, data=data_bytes, headers=headers, method='POST')
    return _open(req, timeout)


def http_get(url, headers, timeout):
    """标准库 GET，返回 (status, body_bytes)。"""
    req = urllib.request.Request(url, headers=headers, method='GET')
    return _open(req, timeout)


def _open(req, timeout):
    """
    发请求并返回 (status, body_bytes)。

    ★ 自动解压 gzip/deflate：我们两个 NGA 接口都带了 `Accept-Encoding: gzip, deflate`
      （实测正文页 41.3KB → 12.8KB、列表 21.8KB → 约 6KB），所以这里必须把压缩体还原，
      否则后面拿到的是乱码、正则一条都匹配不到。
      deflate 有两种形态：带 zlib 头（zlib.decompress 可解）与**裸 deflate**
      （RFC1951，必须用 wbits=-MAX_WBITS），两种都兜住。
    """
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read()
            enc = resp.headers.get('Content-Encoding', '').lower()
            if enc == 'gzip':
                try:
                    body = gzip.decompress(body)
                except Exception:  # noqa: BLE001
                    pass
            elif enc == 'deflate':
                try:
                    body = zlib.decompress(body)
                except Exception:  # noqa: BLE001
                    try:
                        body = zlib.decompressobj(-zlib.MAX_WBITS).decompress(body)
                    except Exception:  # noqa: BLE001
                        pass
            return resp.status, body
    except urllib.error.HTTPError as exc:
        body = b''
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001
            pass
        return exc.code, body


def decode(body):
    for enc in ('utf-8', 'gbk', 'gb18030'):
        try:
            return body.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode('utf-8', 'ignore')


def fetch_forum(cfg, cookie, fid):
    """
    抓单个版面第 1 页，返回 (rows, forum_name)。

    ★ 接口形态以 2026-09 服务器实测为准（官方 API 文档 AgMonk/nga-api-doc 亦同）：
      · 正确写法：GET https://bbs.nga.cn/thread.php?fid=<fid>&__output=11
      · 错误写法：forum.php（那是「版面操作」接口，POST fid 只会返回全站版面目录，
        里面每条都带 error，会被误判成 Cookie 失效）
      · 响应结构：{"data": {"__CU": {...当前登录用户...},
                            "__F": {"fid":835,"name":"剑斗绮谭",...},
                            "__T": [ {tid, subject, author, postdate, replies, ...} ]}}
    """
    if not re.fullmatch(r'-?\d{1,12}', fid):
        raise FetchFailed('版面 fid 不是合法数字：%r' % str(fid)[:32])

    url = 'https://bbs.nga.cn/thread.php?' + urllib.parse.urlencode(
        {'fid': fid, '__output': '11'}, safe=',-')
    headers = {
        'User-Agent': UA,
        'Accept': '*/*',
        # ★ 要 gzip：实测同一个列表接口 21.8KB → 压缩后约 6KB（省 70%+）。
        #   http_get()/_open() 已经会按 Content-Encoding 自动解压，所以这只是「少下点字节」。
        'Accept-Encoding': 'gzip, deflate',
        'Referer': 'https://bbs.nga.cn/thread.php?fid=' + fid,
        'Cookie': cookie,
    }
    try:
        status, body = http_get(url, headers, cfg['nga_request_timeout'])
    except urllib.error.URLError as exc:
        raise FetchFailed('请求 NGA 失败: %r' % (exc.reason,))
    except Exception as exc:  # noqa: BLE001
        raise FetchFailed('请求 NGA 异常: %r' % (exc,))

    text = decode(body)
    # 403/404 既可能是 Cookie 失效，也可能是「这个版面本账号无权访问」；
    # 两者都要求人去处理 Cookie/配置，所以统一按 CookieExpired 记 ERROR 并正常退出。
    if status in (301, 302, 401, 403, 404, 503):
        raise CookieExpired('HTTP %s（Cookie 失效 或 版面 %s 本账号无权访问）' % (status, fid))
    if status >= 400:
        raise FetchFailed('HTTP %s' % status)

    # ★ 实测：未登录/游客拿到的是 {"data":[{"fid":..,"denied":true,"error":"\u8bbf\u5ba2..."}]}
    #   —— 中文被 \u 转义，纯文本匹配「访客不能直接访问」是不够的，必须先认 "denied":true。
    #   注：这里不整体 unescape（避免多分配一份完整响应副本），只在真出现连续 HTML
    #   数字实体时做一次 2KB 短文本替换来复核。
    if '访客不能直接访问' in text:
        raise CookieExpired('访客不能直接访问')
    if re.search(r'&#\d{2,7};&#\d{2,7};', text[:2000]):
        probe = re.sub(r'&#(\d{2,7});', lambda m: chr(int(m.group(1))), text[:2000], count=64)
        if '访客不能直接访问' in probe or '未登录' in probe:
            raise CookieExpired('访客不能直接访问(实体编码)')
    if re.search(r'"denied"\s*:\s*true', text):
        raise CookieExpired('NGA 判定为未登录账号（响应中 denied:true）')

    try:
        payload_json = json.loads(text)
    except ValueError:
        raise FetchFailed('NGA 响应不是合法 JSON: ' + text[:200].replace('\n', ' '))

    data = payload_json.get('data') if isinstance(payload_json, dict) else None

    # 先认错误：NGA 报错时可能根本没有 data，或把 error 塞在 data 里
    err = (payload_json.get('error') if isinstance(payload_json, dict) else None) or \
          (data.get('error') if isinstance(data, dict) else None)
    if err:
        raise CookieExpired('NGA 报错：%s' % str(err)[:120])

    if not isinstance(data, dict):
        raise FetchFailed('NGA 响应结构异常（data 不是对象）：' + text[:200].replace('\n', ' '))

    rows = data.get('__T')
    if not isinstance(rows, list):
        rows = data.get('data') if isinstance(data.get('data'), list) else []
    rows = [r for r in rows if isinstance(r, dict)]

    forum = data.get('__F') if isinstance(data.get('__F'), dict) else {}
    forum_name = str(forum.get('name') or '').strip()

    # 兜底：解析完再认一次 denied（版面目录/拒客都可能走这条路）
    if rows and rows[0].get('denied'):
        raise CookieExpired('NGA 拒绝访问：%s'
                            % (rows[0].get('error') or rows[0].get('name') or 'denied'))
    return rows, forum_name


def fetch_all_forums(cfg, cookie, max_posts):
    """
    按面板配置的 fid（支持逗号分隔多版面）逐个抓，合并后截断到 max_posts。
    返回 (rows, forum_names)。
    单个版面失败不拖垮整轮：只记 WARN，只要还有版面成功就继续；全失败才抛最后那个异常。
    """
    fids = [x for x in str(cfg['nga_forum_fid']).split(',') if x]
    if not fids:
        raise FetchFailed('控制面板「监测版面 fid」为空或不是合法数字')

    all_rows, names, last_exc = [], [], None
    for fid in fids:
        try:
            rows, name = fetch_forum(cfg, cookie, fid)
        except (CookieExpired, FetchFailed) as exc:
            last_exc = exc
            if len(fids) == 1:
                raise
            log.warning('版面 fid=%s 抓取失败，跳过：%s' % (fid, exc))
            continue
        names.append(name or ('fid=%s' % fid))
        all_rows.extend(rows)
        if len(all_rows) >= max_posts:
            break
    if not all_rows and last_exc is not None:
        raise last_exc
    return all_rows, names


def clean_text(raw):
    r"""
    清洗标题/正文：去 BBCode 标签、去附件名、去链接、压缩空白。

    ★ 正则必须**非贪婪**（`*?`）：NGA 标题里方括号很常见（[版务公告]、[氵]、[前瞻]…），
      贪婪写法 `\[[^\]]{1,12}\]` 会从第一个 `[` 一路吃到**最后一个** `]`，
      把整条标题清成空串 —— 实测「[版务公告] 关于钟离相关违规行为的公告」会被整条吞掉。
      这类帖子在版面里占比不小，静默丢失会直接影响舆情覆盖度，所以这里格外注意。
    """
    if raw is None:
        return ''
    s = str(raw)
    s = re.sub(r'\[/?[^\]]{1,24}?\]', ' ', s)     # 非贪婪：只吃掉一对最内层的 [xxx]
    s = re.sub(r'\[[^\]\[]{0,24}=[^\]\[]{0,60}\]', ' ', s)  # 带参数的标签 [collapse=xxx]
    s = re.sub(r'\./(?:mon|attach|thumb|month)_[A-Za-z0-9_./-]*', ' ', s)  # 附件名残渣
    s = re.sub(r'https?://\S+', ' ', s)           # 去链接
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


# ============================================================================
# 3b. 帖子正文（主楼 + 回复）
# ============================================================================
# 为什么要单独抓一次：thread.php 的**列表接口只给标题**（不含正文），
# 所以原先 AI 是「只看标题」在判断影响值 —— 提问帖、标题党很容易被误判。
#
# 为什么用 HTML 版而不是 __output=11：实测 read.php 的 JSON 版会被 CDN 缓存成
# 一个**被截断的残缺片段**（13.7KB，尾部切在字符串中间，`__T` 楼层数组根本没出现），
# 加 page/pos/noBBCode/rand 都绕不过去；而不带 __output 的 HTML 版是完整的（约 49KB），
# 主楼与回复都在 <p id='postcontentN' class='postcontent ubbcode'>…</p> 里。
#
# 内存与磁盘取舍：单帖 HTML 约 30~60KB，只摘出纯文本后每帖约 1~2KB，
# 取 12 帖合计也就几十 KB —— 远低于 64MB 上限，因此**不落临时文件**（避免磁盘残留）。
# 每抓完一帖就只保留提取后的短文本，原始 HTML 立刻释放。
# ★ 标签名不能写死成 <p>（2026-09-14 实测修正）：
#   本页里「主楼」是 <p id='postcontent0' class='postcontent ubbcode'>…</p>，
#   而**回复楼是 <span id='postcontent1' class='postcontent ubbcode'>…</span>**。
#   旧正则写死 `(.*?)</p>` ⇒ 回复那 19 层永远匹配不到（页内明明有 20 层，
#   实际只摘出 1 层 = 主楼），于是「抓回帖」这件事其实从未生效过。
#   现在用「同标签名开闭配对」+ 前置断言（属性顺序无关）把 p/span/div/td 一网打尽。
RE_POST_CONTENT = re.compile(
    r"<(p|span|div|td)\b(?=[^>]*id='postcontent\d*')(?=[^>]*class='[^']*ubbcode)"
    r"[^>]*>(.*?)</\1>", re.S | re.I)
RE_POST_SUBJECT = re.compile(r"id='postsubject\d*'[^>]*>(.*?)</h[36]>", re.S | re.I)
RE_TID = re.compile(r'\d{6,12}')
RE_TAG = re.compile(r'<[^>]+>')


def extract_thread_text(html, per_floor_chars=240, max_floors=8):
    """
    从帖子 HTML 里摘出「主楼 + 前几楼回复」的纯文本。
    返回 (标题, [楼层文本…])；标题取不到时返回空串。
    """
    subject = ''
    m = RE_POST_SUBJECT.search(html)
    if m:
        subject = clean_text(RE_TAG.sub(' ', m.group(1)))

    floors = []
    for m in RE_POST_CONTENT.finditer(html):
        # 去 <br> 变空格，再剥标签、清 BBCode、压缩空白（group(2)=正文，group(1)=标签名）
        raw = re.sub(r'<br\s*/?>', ' ', m.group(2), flags=re.I)
        txt = clean_text(RE_TAG.sub(' ', raw))
        if not txt:
            continue
        floors.append(txt[:per_floor_chars])
        if len(floors) >= max_floors:
            break
    return subject, floors


def fetch_thread_text(cfg, cookie, tid):
    """
    抓单个帖子的正文（主楼 + 回复）。失败返回 (None, None)，由调用方降级为只用标题。

    ★ 端点必须是 read.php?tid= ：
      实测 `thread.php?tid=X` 返回的是**跳转/落地页**（约 35KB，里面 postcontent 出现 0 次），
      而 `read.php?tid=X`（不带 __output，HTML 版）才是真正的楼层页：
      第 1 页把**主楼 + 约 19 层回复**都放在同一个 HTML 里（实测 20 层 / 约 50KB），
      主楼是 `<p id='postcontent0' class='postcontent ubbcode'>`，
      回复是 `<span id='postcontentN' class='postcontent ubbcode'>`
      —— 所以「要不要分析回帖」**不产生额外请求**，同一份 HTML 里都已经拿到了。
      （带 __output=11 的 JSON 版会被 CDN 缓存成截断片段，不可用，详见上一节注释。）
    """
    if not RE_TID.fullmatch(str(tid)):
        return None, None
    url = 'https://bbs.nga.cn/read.php?tid=%s' % tid
    headers = {'User-Agent': UA, 'Accept': 'text/html,*/*',
               # ★ 要 gzip：正文页实测 41.3KB → 12.8KB（省 69%）。
               #   两个 NGA 接口都支持；不加这个头 NGA 就发明文（nginx 默认不主动压缩）。
               'Accept-Encoding': 'gzip, deflate',
               'Referer': 'https://bbs.nga.cn/thread.php?fid=' + str(cfg['nga_forum_fid']).split(',')[0],
               'Cookie': cookie}
    try:
        status, body = http_get(url, headers, cfg['nga_request_timeout'])
    except Exception as exc:  # noqa: BLE001
        log.warning('抓帖子正文失败 tid=%s：%r' % (tid, exc))
        return None, None
    if status != 200:
        log.warning('抓帖子正文失败 tid=%s：HTTP %s' % (tid, status))
        return None, None
    html = decode(body)
    if '访客不能直接访问' in html or '"denied":true' in html:
        log.warning('抓帖子正文遇到权限提示 tid=%s（跳过该帖正文）' % tid)
        return None, None
    subject, floors = extract_thread_text(
        html, max_floors=int(cfg.get('nga_content_max_floors') or 8))
    return subject, floors


def enrich_posts_with_content(cfg, cookie, rows, max_threads):
    """
    给候选帖子补正文：逐帖抓取 → 只摘正文短文本 → 合并成一段字符串。
    返回 (content_map, 统计)；content_map: tid -> {'text':…, 'floors':n}
    单帖失败不影响其它帖；整体受 max_threads 限制。
    """
    content_map = {}
    stats = {'ok': 0, 'fail': 0, 'chars': 0}
    for row in rows[:max_threads]:
        tid = str(row.get('tid') or '').strip()
        if not tid:
            continue
        subject, floors = fetch_thread_text(cfg, cookie, tid)
        if not floors:
            stats['fail'] += 1
            continue
        text = ' ｜ '.join(floors)
        content_map[tid] = {'text': text, 'floors': len(floors)}
        stats['ok'] += 1
        stats['chars'] += len(text)
    return content_map, stats



def pick_post_text(row):
    """
    返回 (清洗后的标题, 清洗后的摘要, 原始标题)。
    ★ 为什么要额外给「原始标题」：clean_text 会把 [版务公告] 这类方括号前缀剥掉，
      而「提问/公告/活动帖过滤」恰恰要靠这些前缀判断，拿剥干净的标题去匹配就永远匹配不到。
      原始标题只用于过滤判断，不会进提示词。
    兼容 NGA 的多种字段命名（subject/title、message/content/post_content）。
    """
    if not isinstance(row, dict):
        return '', '', ''
    raw_subject = str(row.get('subject') or row.get('title') or '')
    subject = clean_text(raw_subject)
    message = clean_text(row.get('message') or row.get('content') or row.get('post_content') or '')
    return subject, message[:200], raw_subject


# ============================================================================
# 4. Gemini 调用
# ============================================================================
def build_prompt(posts, entity_names):
    """
    组装提示词。post 里可选带 content（帖子正文），有就用正文、没有就退回标题。
    正文格式：主楼 ｜ 回复1 ｜ 回复2 …（已截断），让 AI 能看到真实讨论内容。
    """
    lines = []
    for idx, p in enumerate(posts, 1):
        subject = p['subject'] or '(无标题)'
        body = (p.get('content') or '').strip()
        if not body:
            body = p.get('message') or ''
        lines.append('%d. 【%s】%s' % (idx, subject, body))
    return PROMPT_TEMPLATE.format(
        entity_list='、'.join(entity_names),
        posts_text='\n'.join(lines),
    )


def extract_json_array(text):
    """先剥 markdown 代码块，再正则找 [...]，最后 json.loads；失败抛 ValueError。"""
    if not text:
        raise ValueError('空响应')
    cleaned = re.sub(r'```(?:json)?', '', text).strip()
    m = re.search(r'\[.*\]', cleaned, re.S)
    if not m:
        raise ValueError('未找到 JSON 数组')
    return json.loads(m.group(0))


# ============================================================================
# 4b. 结论 → 写入「市场情绪」表（与新闻彻底分开的独立展示线）
# ============================================================================
# 平台展示名与作者口径：作者不是「上传人」，而是「平台 + 自动总结」。
PLATFORM_CODE = 'NGA'
PLATFORM_NAME = 'NGA 玩家社区'
AUTHOR_LABEL = 'NGA 自动总结'

CONCLUSION_TEMPLATE = """你是《原神》社区舆情分析师。下面是本轮从 NGA 论坛抓取的讨论分析结果。

【本轮统计】
{stat}

【各实体影响值】（-1 到 1，负数利空、正数利好）
{impacts}

【任务】
把本轮讨论归纳成「看涨」与「看跌」两组市场情绪，供交易社区直接阅读。
只输出一个 JSON 对象，不要输出任何其他文字、不要用代码块。

输出格式（严格遵守，字段名与层级都不能改）：
{{
  "tone": "<整体基调，12 字以内，如：情绪偏多>",
  "bull": {{
    "title": "<看涨标题，20 个汉字左右>",
    "summary": "<看涨概况，60 字以内，说明是哪些角色、因为什么被看好>",
    "strength": <整数 0-100，看涨观点的强烈程度>
  }},
  "bear": {{
    "title": "<看跌标题，20 个汉字左右>",
    "summary": "<看跌概况，60 字以内，说明是哪些角色、因为什么被看衰>",
    "strength": <整数 0-100，看跌观点的强烈程度>
  }}
}}

规则：
- 某一方向在本轮讨论里<b>完全没有依据</b>时，该方向写 null（例如 {{"bull": null, "bear": {{...}}}}），
  不要为了凑格式硬编。
- 两个 title 都必须像新闻标题，不要出现「本轮」「分析」「影响值」「数据」这类词。
- 只依据上面给出的影响值归纳，不要引入上面没提到的角色。
- strength 反映的是「这个方向的论据有多强」，不是影响值的绝对值。"""


def build_conclusion_prompt(stat, valid):
    """把本轮结果喂给 AI，让它直接产出「看涨/看跌」两组结构化情绪"""
    lines = []
    for it in sorted(valid, key=lambda x: -abs(x['raw_impact']))[:15]:
        lines.append('- %s（%s）：%+.2f，置信度 %.2f%s'
                     % (it['entity_name'], '角色' if it['entity_type'] == 'role' else '基金',
                        it['raw_impact'], it['confidence'],
                        ('，' + it['summary']) if it['summary'] else ''))
    return CONCLUSION_TEMPLATE.format(stat=stat, impacts='\n'.join(lines) if lines else '（无）')


def _clean_text(v, limit):
    return re.sub(r'\s+', ' ', str(v or '')).strip().strip('“”"\'')[:limit]


def _norm_strength(v, default):
    try:
        return int(max(1, min(100, round(float(v)))))
    except (TypeError, ValueError):
        return default


def parse_conclusion(answer):
    """
    从模型回复抠出 {"tone","bull","bear"} 结构。
    返回 (tone, bull_or_None, bear_or_None)，每项是 {title, summary, strength}。
    ★ 单个方向可以为 null（本轮没有该方向依据）——这是刻意支持的情况，不是错误。
    """
    if not answer:
        raise ValueError('空响应')
    cleaned = re.sub(r'```(?:json)?', '', answer).strip()
    m = re.search(r'\{.*\}', cleaned, re.S)
    if not m:
        raise ValueError('未找到 JSON 对象')
    d = json.loads(m.group(0))

    def one(part):
        if not isinstance(part, dict):
            return None
        title = _clean_text(part.get('title'), 60)
        summary = _clean_text(part.get('summary'), 200)
        if not title and not summary:
            return None
        return {
            'title': title or summary[:20],
            'summary': summary or title,
            'strength': _norm_strength(part.get('strength'), 50),
        }

    tone = _clean_text(d.get('tone'), 24)
    bull, bear = one(d.get('bull')), one(d.get('bear'))
    if bull is None and bear is None:
        raise ValueError('bull/bear 都为空')
    return tone, bull, bear


def fallback_conclusion(valid, forum_names):
    """
    兜底：不调 AI 也能有可审的情绪数据（AI 失败时用）。
    标题刻意保持「不含平台名」，拼接平台前缀的工作统一放在 publish_sentiment 里。
    """
    ups = [x for x in valid if x['raw_impact'] > 0]
    downs = [x for x in valid if x['raw_impact'] < 0]
    avg = lambda xs: sum(abs(x['raw_impact']) for x in xs) / max(1, len(xs))
    fmt = lambda xs: '、'.join(x['entity_name'] for x in
                               sorted(xs, key=lambda x: -abs(x['raw_impact']))[:3]) or '暂无明显焦点'
    bull = None
    bear = None
    if ups:
        bull = {'title': '%s获社区看好' % fmt(ups),
                'summary': '%s 的讨论情绪偏正面，%s 受到较多关注。'
                           % ('、'.join(forum_names) or '社区', fmt(ups)),
                'strength': _norm_strength(avg(ups) * 100, 50)}
    if downs:
        bear = {'title': '%s被社区看衰' % fmt(downs),
                'summary': '%s 的讨论情绪偏负面，%s 存在争议。'
                           % ('、'.join(forum_names) or '社区', fmt(downs)),
                'strength': _norm_strength(avg(downs) * 100, 50)}
    if bull is None and bear is None:
        bull = {'title': '社区讨论以中性观望为主',
                'summary': '本轮社区讨论未形成明显的看涨或看跌共识。', 'strength': 30}
    return '多空分歧' if (bull and bear) else ('情绪偏多' if bull else '情绪偏空'), bull, bear


def resolve_stock_ids(conn, valid):
    """把实体名映射成 stocks.id（按影响值绝对值排序）"""
    names = [x['entity_name'] for x in sorted(valid, key=lambda x: -abs(x['raw_impact']))]
    id_of = {}
    if names:
        with conn.cursor() as cur:
            ph = ','.join(['%s'] * len(names))
            cur.execute('SELECT id, name FROM stocks WHERE name IN (%s) AND status<>2' % ph, names)
            for sid, sname in cur.fetchall():
                id_of[sname] = sid
    return names, id_of


def upsert_sentiment(conn, platform, batch_date, batch_key, direction, title, summary,
                     strength, source_url, stock_ids, platform_name, author_label,
                     auto_approve=False):
    """
    写入/更新一行市场情绪。

    ★ 去重口径（2026-09-14 修正 —— 原来写错了，导致一整天只出得了一条）：
      批次键 batch_key 从「版面」改成「版面|HH:MM」——**粒度是「一次监测周期」而不是「一整天」**。

    为什么必须这么改：原口径下，当天第一条写入后（无论待审还是已通过），
      后续分析全都打在同一行上：
        · 若那行还是 PENDING → 更新它，最新数据覆盖旧的（这没问题）；
        · 若那行已被审核 → 更新条件（review_status='PENDING'）不匹配，插入又撞唯一键
          → **当天后面所有轮次全部白跑**（实际就发生了：02:10 写了一条、02:23 被批准，
            之后 02:48 / 02:49 / 15:29 三轮全部「未写入」）。
    现在的行为：
      · 同一小时内重复跑 → 更新同一行（防止反复触发刷屏）；
      · 跨小时/跨周期再跑 → 新的一行（新的情绪可以再次送审、也可以再被批准）；
      · 已批准的历史行永远不会被改写（保留当时的判断，便于回溯）。

    ★ 自动通过审核（sentiment_auto_approve，2026-09-18 新增）：
      开启时新行直接写成 APPROVED，reviewed_at = fetched_at = NOW()
      （即「发布时间 = 通过审核时间」），审核人登记为 AUTO_REVIEW_BOT_ID。
      同时把「同一周期内可更新」的范围从「仅待审」放宽到「本机器人自己批的」——
      否则自动通过之后就再也匹配不到待审行，每跑一次都会新建一行。
      人工审核过的历史行（reviewed_by 不是机器人）依然永不改写。

    返回 (row_id, is_new)；真正被忽略（撞唯一键）时 row_id=0。
    """
    # 时间窗：精确到分钟，保证「同一周期内重复跑」落在同一行；跨周期自然换行
    slot = datetime.datetime.now().strftime('%H:%M')
    scoped_key = '%s|%s' % (batch_key, slot)
    family = '%s|%%' % batch_key          # 同版面（不限时间）用于「找本周期可更新的待审行」

    # 自动通过时，本周期内「可被刷新」的行 = 待审行 + 本机器人刚批的行
    # 同时把 reviewed_at 一起推进，维持「发布时间 = 通过审核时间」这个不变量
    if auto_approve:
        updatable = "(review_status='PENDING' OR (review_status='APPROVED' AND reviewed_by=%s))"
        updatable_params = (AUTO_REVIEW_BOT_ID,)
        review_set = ", reviewed_at=NOW()"
    else:
        updatable = "review_status='PENDING'"
        updatable_params = ()
        review_set = ""

    with conn.cursor() as cur:
        # ① 先把本批次「还是待审」的行按最新数据刷新（限时：只动 30 分钟内的待审行，
        #    避免把当天早先那些没审核的待审行一直改写）
        cur.execute(
            "UPDATE market_sentiment SET title=%s, summary=%s, strength=%s, source_url=%s, "
            "platform_name=%s, author_label=%s, fetched_at=NOW(), stock_count=%s, batch_key=%s"
            + review_set + " "
            "WHERE platform=%s AND batch_date=%s AND batch_key LIKE %s AND direction=%s "
            "AND " + updatable + " AND fetched_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)",
            (title[:120], summary[:500], int(strength), source_url[:500], platform_name,
             author_label, len(stock_ids), scoped_key, platform, batch_date, family, direction)
            + updatable_params)
        if cur.rowcount:
            cur.execute(
                'SELECT id FROM market_sentiment WHERE platform=%s AND batch_date=%s '
                'AND batch_key=%s AND direction=%s',
                (platform, batch_date, scoped_key, direction))
            row = cur.fetchone() if hasattr(cur, 'fetchone') else (cur.fetchall() or [None])[0]
            if row:
                sid = int(row[0])
                cur.execute('DELETE FROM market_sentiment_stocks WHERE sentiment_id=%s', (sid,))
                for stock_id in stock_ids:
                    cur.execute('INSERT INTO market_sentiment_stocks (sentiment_id, stock_id) VALUES (%s, %s)',
                                (sid, stock_id))
                conn.commit()
                return sid, False

        # ② 本周期还没有待审行 → 新建一行（新批次键，不会撞历史行的唯一键）
        if auto_approve:
            # 发布时间 = 通过审核时间：fetched_at 与 reviewed_at 都取 NOW()，同一时刻
            cur.execute(
                'INSERT IGNORE INTO market_sentiment '
                '(platform, platform_name, fetched_at, batch_date, batch_key, title, summary, '
                ' direction, strength, stock_count, source_url, author_label, '
                ' review_status, reviewed_by, reviewed_at) '
                "VALUES (%s, %s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, 'APPROVED', %s, NOW())",
                (platform, platform_name, batch_date, scoped_key, title[:120], summary[:500],
                 direction, int(strength), len(stock_ids), source_url[:500], author_label,
                 AUTO_REVIEW_BOT_ID))
        else:
            cur.execute(
                'INSERT IGNORE INTO market_sentiment '
                '(platform, platform_name, fetched_at, batch_date, batch_key, title, summary, '
                ' direction, strength, stock_count, source_url, author_label, review_status) '
                "VALUES (%s, %s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, 'PENDING')",
                (platform, platform_name, batch_date, scoped_key, title[:120], summary[:500],
                 direction, int(strength), len(stock_ids), source_url[:500], author_label))
        created = cur.rowcount > 0
        sid = int(cur.lastrowid) if created else 0
        if created:
            for stock_id in stock_ids:
                cur.execute('INSERT INTO market_sentiment_stocks (sentiment_id, stock_id) VALUES (%s, %s)',
                            (sid, stock_id))
        conn.commit()
        # ★ 被唯一键忽略时如实返回 (0, False)：调用方据此记「未新增」，
        #   不能报喜不报忧（早期版本这里固定返回 True，会把「什么都没写」说成「新建成功」）。
        return sid, False


def cleanup_stale_pending(conn, keep_hours=48):
    """
    清掉太久没人审的待审情绪，防止审核队列无限堆积。
    只删 PENDING；已通过/已驳回的历史一律保留（那是审核留痕）。
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM market_sentiment WHERE review_status='PENDING' "
                        "AND fetched_at < DATE_SUB(NOW(), INTERVAL %s HOUR)", (int(keep_hours),))
            ids = [int(r[0]) for r in cur.fetchall()]
            if ids:
                ph = ','.join(['%s'] * len(ids))
                cur.execute('DELETE FROM market_sentiment_stocks WHERE sentiment_id IN (%s)' % ph, ids)
                cur.execute('DELETE FROM market_sentiment WHERE id IN (%s)' % ph, ids)
            conn.commit()
        return len(ids)
    except Exception as exc:  # noqa: BLE001
        log.warning('清理过期待审情绪失败（不影响本轮）：%r' % (exc,))
        return 0


def publish_sentiment(conn, cfg, valid, stat, cookie, api_key, forum_names, fid):
    """
    把本轮结论写成「市场情绪」（看涨/看跌分开两行，进入待审核）。

    与新闻的区别（用户 2026-09-14 的要求）：
      · 不再往 news 表里塞总结论，避免混进提瓦特新闻；
      · 作者不是上传人，而是「平台 + 自动总结」（author_label）；
      · 同一次监控里既有看涨又有看跌 → **拆成两行**，各自有标题/概况/强度。
    返回 (ok, ids, message)；任何失败只记 WARN，不影响本轮影响值写入。
    """
    if str(cfg.get('nga_news_auto_publish', '1')) not in ('1', 'true', 'True'):
        return False, [], 'auto_publish 关闭'

    # 2) AI 归纳：看涨 / 看跌
    tone, bull, bear, how = '', None, None, 'AI'
    prompt_concl = build_conclusion_prompt(stat, valid)
    # 抓取快照：把送给 Gemini 的第 2 个提示词原文记下来（03-prompt-总结论）
    _DUMP.add('【二、总结论提示词】（对应 03-prompt-总结论.txt）', prompt_concl)
    try:
        ans = call_gemini(api_key, cfg, prompt_concl)
        if ans:
            tone, bull, bear = parse_conclusion(ans)
    except Exception as exc:  # noqa: BLE001
        log.warning('情绪总结生成失败，改用兜底文案：%r' % (exc,))
    if bull is None and bear is None:
        tone, bull, bear = fallback_conclusion(valid, forum_names)
        how = '兜底'
    # 快照：把解析出的结论（含兜底）记进【三、本轮汇总】
    _DUMP.set_meta(conclusion={'tone': tone, 'bull': bull, 'bear': bear, 'how': how})

    # 3) 关联角色：两个方向各取自己那一侧的前 N 个
    names, id_of = resolve_stock_ids(conn, valid)
    max_stocks = int(cfg.get('nga_news_max_stocks') or 5)

    def ids_for(sign):
        picked = [x for x in sorted(valid, key=lambda x: -abs(x['raw_impact']))
                  if (x['raw_impact'] > 0) == (sign > 0) and x['entity_name'] in id_of]
        return [id_of[x['entity_name']] for x in picked][:max_stocks]

    fid_first = str(fid).split(',')[0] or '650'
    source_url = 'https://bbs.nga.cn/thread.php?fid=%s' % fid_first
    batch_date = datetime.date.today().isoformat()
    batch_key = str(fid).replace(' ', '')

    # 自动通过审核（控制面板 sentiment_auto_approve）：开启后本轮情绪直接对外可见
    auto_approve = str(cfg.get('sentiment_auto_approve', '0')) in ('1', 'true', 'True')

    written, notes, skipped = [], [], []
    for direction, part, sign in (('UP', bull, 1), ('DOWN', bear, -1)):
        if not part:
            continue
        # 标题统一带平台前缀，前台不用再拼；「情绪」二字明确这是情绪而非新闻
        title = '%s情绪·%s' % (PLATFORM_CODE, part['title'])
        sid, is_new = upsert_sentiment(
            conn, PLATFORM_CODE, batch_date, batch_key, direction, title,
            part['summary'], part['strength'], source_url, ids_for(sign),
            PLATFORM_NAME, AUTHOR_LABEL, auto_approve=auto_approve)
        label = '看涨' if direction == 'UP' else '看跌'
        if sid:
            written.append(sid)
            tag = '（新建）' if is_new else ('（更新本周期）' if auto_approve else '（更新本周期待审）')
            notes.append('%s#%d%s' % (label, sid, tag))
        else:
            skipped.append(label)
    if not written:
        # 只有「本周期这一行已被审核定稿」才会走到这里（正常不会天天发生）
        return False, [], '本周期（%s）的%s方向已有定稿记录，本轮未新增' % (
            batch_key, '/'.join(skipped) or '两')
    if auto_approve:
        msg = '已写入市场情绪并自动通过审核：%s（基调「%s」，%s）' % ('、'.join(notes), tone or '未标注', how)
    else:
        msg = '已写入市场情绪待审：%s（基调「%s」，%s）' % ('、'.join(notes), tone or '未标注', how)
    if skipped:
        msg += '；%s方向本周期已有定稿记录，跳过' % '/'.join(skipped)
    return True, written, msg


def call_gemini(api_key, cfg, prompt):
    model = cfg['gemini_model']
    url = 'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent' % (
        urllib.parse.quote(model, safe=''))
    body = json.dumps({
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {'temperature': 0.2, 'topP': 0.9, 'maxOutputTokens': 2048},
    }, ensure_ascii=False).encode('utf-8')
    # ★ 用 x-goog-api-key 头而不是 ?key= 查询串：实测项目所用密钥（AQ. 前缀）走头可用。
    headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'x-goog-api-key': api_key,
        'User-Agent': 'teyvat-nga-analysis/1.0',
    }

    attempts = cfg['gemini_max_retries'] + 1
    last_err = None
    for i in range(attempts):
        if i:
            time.sleep(5)  # 规范：每次重试间隔 5 秒
        try:
            status, raw = http_post(url, body, headers, cfg['gemini_timeout_seconds'])
        except Exception as exc:  # noqa: BLE001
            last_err = '网络异常 %r' % (exc,)
            continue
        text = decode(raw)
        if status != 200:
            last_err = 'HTTP %s: %s' % (status, text[:300].replace('\n', ' '))
            continue
        try:
            payload = json.loads(text)
            parts = payload['candidates'][0]['content']['parts']
            out = ''.join(p.get('text', '') for p in parts)
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            last_err = '响应结构异常 %r: %s' % (exc, text[:300].replace('\n', ' '))
            continue
        if not out.strip():
            last_err = '模型返回空文本（可能被安全策略拦截）'
            continue
        return out

    # 注意：std logging 只认 extra=，要落进 nga_analysis_log.detail 必须这样传
    log.error('Gemini API 调用失败（已尝试 %d 次）' % attempts, extra={'detail': last_err})
    return None


def norm_name(name):
    """模糊匹配归一：去括号内容、去空白/标点、转小写。"""
    s = str(name or '')
    s = re.sub(r'[（(【\[].*?[）)】\]]', '', s)
    s = re.sub(r'[\s·・\-_/、,，.。:"\'“”]+', '', s)
    return s.lower()


def validate_items(items, whitelist, norm_index):
    """校验 AI 返回条目：名称必须在白名单内（支持简单模糊匹配）。"""
    valid, seen = [], set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        raw_name = str(it.get('entity', '')).strip()
        if not raw_name:
            continue
        name = raw_name if raw_name in whitelist else norm_index.get(norm_name(raw_name))
        if name is None:
            log.warning('AI 返回实体「%s」不在白名单中，已丢弃' % raw_name[:64])
            continue
        if name in seen:
            continue
        seen.add(name)
        impact = clamp(to_float(it.get('impact'), 0.0), -1.0, 1.0)
        confidence = clamp(to_float(it.get('confidence'), 0.0), 0.0, 1.0)
        summary = re.sub(r'\s+', ' ', str(it.get('summary', ''))).strip()[:60] or None
        valid.append({
            'entity_type': whitelist[name],
            'entity_name': name,
            'raw_impact': impact,
            'confidence': confidence,
            'summary': summary,
        })
    return valid[:10]


# ============================================================================
# 5. 写库
# ============================================================================
UPSERT_SQL = (
    'INSERT INTO news_impact '
    '(entity_type, entity_name, impact_value, raw_impact, confidence, summary, source_count, analyzed_at) '
    'VALUES (%s, %s, %s, %s, %s, %s, %s, %s) '
    'ON DUPLICATE KEY UPDATE '
    'impact_value = VALUES(impact_value), raw_impact = VALUES(raw_impact), '
    'confidence = VALUES(confidence), summary = VALUES(summary), '
    'source_count = VALUES(source_count), analyzed_at = VALUES(analyzed_at)'
)


def q4(v):
    return Decimal(str(v)).quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP)


def q3(v):
    return Decimal(str(v)).quantize(Decimal('0.001'), rounding=ROUND_HALF_UP)


def write_impacts(conn, items, source_count, now):
    if not items:
        log.info('AI 未返回有效影响条目，本次不写入 news_impact')
        return 0
    written = 0
    with conn.cursor() as cur:
        for it in items:
            try:
                cur.execute(UPSERT_SQL, (
                    it['entity_type'], it['entity_name'],
                    q4(it['raw_impact']), q4(it['raw_impact']), q3(it['confidence']),
                    it['summary'], int(source_count), now,
                ))
                written += 1
            except Exception:  # noqa: BLE001 —— 单条失败不影响其余条目
                log.error('写入 news_impact 失败：%s/%s'
                          % (it['entity_type'], it['entity_name']), exc_info=True)
    conn.commit()
    return written


# ============================================================================
# 6. 主流程
# ============================================================================
def connect_db():
    import pymysql
    host = os.environ.get('DB_HOST', '127.0.0.1')
    port = int(os.environ.get('DB_PORT', '3306'))
    user = os.environ.get('DB_USER', 'teyvat')
    password = os.environ.get('DB_PASS', '')
    name = os.environ.get('DB_NAME', 'teyvat_stock')
    return pymysql.connect(
        host=host, port=port, user=user, password=password, database=name,
        charset='utf8mb4', autocommit=True, connect_timeout=10,
        init_command="SET time_zone = '+08:00'",  # 与后端 Sequelize 的 +08:00 对齐
    )


def select_posts(rows, whitelist, max_posts, skip_questions=True):
    """
    过滤 + 截断：
      ① 标题或摘要含「原神」、或含白名单实体名；
      ② 默认再剔掉提问/公告/签到帖（它们不含市场情绪，留着只会带偏 AI 判断）。
    注意②用的是**原始标题**（方括号前缀还在），因为清洗后前缀就没了。
    被剔掉的会记一条 INFO，方便核对过滤是否过狠。
    """
    selected, skipped_q = [], 0
    for row in rows:
        subject, message, raw_subject = pick_post_text(row)
        if not subject and not message:
            continue
        haystack = subject + ' ' + message
        if '原神' not in haystack and not any(n in haystack for n in whitelist):
            continue
        if skip_questions and looks_like_question(raw_subject or subject):
            skipped_q += 1
            continue
        selected.append({'subject': subject, 'message': message, 'tid': str(row.get('tid') or '')})
        if len(selected) >= max_posts:
            break
    if skipped_q:
        log.info('过滤掉 %d 条提问/公告/签到类帖子（不含市场情绪）' % skipped_q)
    return selected


# ==================== 抓取快照（--dump） ====================
#
# 用途：管理面板点「立即抓取」时，除了正常跑一轮分析，还顺手把「这一轮到底抓到了什么、
#       送了什么提示词、AI 回了什么」落成**一个**文件，让运营在后台直接下载查看。
#
# 内容 = 调试脚本 .dsh-dump-once.py 的 01/03/06 三个文件，但**去重后合并**：
#   01-nga-原文           抓到的帖子原文（标题 + 主楼 + 前几楼）
#   03-prompt-总结论      送给 Gemini 的第 2 个提示词（含各实体影响值）
#   06-汇总结论           本轮统计、AI 结果与解析结论（人读用）
# 之所以要合并去重：帖子正文会**在提示词里再出现一次**，直接拼接会有一大段重复。
#
# 输出：<目录>/nga-dump-<时间戳>.txt  +  <目录>/nga-dump-latest.txt（后端按后者提供下载）
# 目录：默认与本脚本同级的 dumps/，可用环境变量 NGA_DUMP_DIR 覆盖。
DUMP_SEP = '=' * 78
DUMP_KEEP = 10                     # 目录里最多保留多少份历史快照
DUMP_MAX_BYTES = 512 * 1024        # 单份快照上限，防病态情况下写出超大文件
# 默认目录：与本脚本同级的 dumps/（生产 = /opt/teyvat-nga/dumps，本地 = server/scripts/dumps）
DUMP_DIR_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dumps')


def _dump_posts_text(posts, forum_label, cfg, rows_count):
    """把「本轮真正送去分析的帖子」排成人读文本（对应 01-nga-原文.txt 的正文部分）。"""
    lines = ['列表接口返回：%d 条；命中白名单/关键词后保留：%d 条' % (rows_count, len(posts)),
             '过滤规则：① 标题含「原神」或白名单实体名；② 剔除提问/公告/签到帖',
             '正文来源：逐帖 read.php 抓取（列表接口只给标题，不含正文）', '']
    for i, p in enumerate(posts, 1):
        lines += ['-' * 78,
                  '%d. 标题：%s' % (i, p.get('subject') or '(无标题)'),
                  '   帖子ID：%s' % (p.get('tid') or '-'),
                  '   正文：%s' % ((p.get('content') or '').strip() or '(未抓到正文，AI 只能看标题)'),
                  '']
    return '\n'.join(lines)


def _dedupe_text(text):
    """
    去重：先按空行切块丢掉整块重复，再逐行丢掉重复行（保留首次出现）。

    只对「长度 ≥ 24 字符」的内容去重，短的（分隔线、'---'、单个词）保持原样，
    否则会把正常的排版线条也删掉。
    """
    seen_blocks, blocks = set(), []
    for blk in re.split(r'\n\s*\n', text):
        key = re.sub(r'\s+', ' ', blk).strip()
        if len(key) >= 24:
            if key in seen_blocks:
                continue
            seen_blocks.add(key)
        blocks.append(blk.rstrip())

    seen_lines, out = set(), []
    for line in '\n\n'.join(blocks).split('\n'):
        key = re.sub(r'\s+', ' ', line).strip()
        if len(key) >= 24:
            if key in seen_lines:
                continue
            seen_lines.add(key)
        out.append(line)
    return '\n'.join(out)


class DumpSnapshot:
    """收集 01/03/06 三部分内容，最后去重合并写成一个文件（幂等：只写一次）。"""

    def __init__(self):
        self.enabled = False
        self.out_dir = ''
        self.meta = {}
        self.parts = []          # [(小节标题, 正文)]
        self.written = None

    def enable(self, out_dir):
        if not out_dir:
            return
        self.enabled = True
        self.out_dir = out_dir
        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as exc:  # 目录建不出来就当没开快照，绝不影响主流程
            log.warning('快照目录创建失败（%s），本轮不生成快照：%r' % (out_dir, exc))
            self.enabled = False

    def set_meta(self, **kw):
        if self.enabled:
            self.meta.update(kw)

    def add(self, title, text):
        if self.enabled and text:
            self.parts.append((title, str(text)))

    def _summary_section(self):
        """第 6 部分：本轮汇总（等价于 06-汇总结论.txt）"""
        m = self.meta
        lines = [DUMP_SEP, '【三、本轮汇总】（对应 06-汇总结论.txt）', DUMP_SEP,
                 '时间：%s' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                 '统计：%s' % m.get('stat', '-')]
        if m.get('content_stat'):
            lines.append('正文：%s' % str(m['content_stat']).lstrip(' |'))
        if m.get('written') is not None:
            lines.append('写库：news_impact %s 条 / AI 校验通过 %s 条'
                         % (m.get('written'), m.get('valid_count', '-')))
        lines.append('市场情绪：%s' % m.get('senti_note', '-'))

        valid = m.get('valid') or []
        lines += ['', '【各实体影响值（第 1 次 AI 结果，已过白名单校验）】']
        if valid:
            for v in sorted(valid, key=lambda x: -abs(x['raw_impact'])):
                lines.append('  %-6s %-12s %+.2f  置信度 %.2f  %s'
                             % (v['entity_type'], v['entity_name'], v['raw_impact'],
                                v['confidence'], v['summary'] or ''))
        else:
            lines.append('  （无：本轮 AI 没返回有效条目）')

        concl = m.get('conclusion') or {}
        lines += ['', '【总结论（第 2 次 AI 结果，已解析）】',
                  '  基调：%s' % (concl.get('tone') or '(空)')]
        for label, part in (('看涨', concl.get('bull')), ('看跌', concl.get('bear'))):
            if part:
                lines += ['  %s：%s' % (label, part['title']),
                          '        强度 %s ／ %s' % (part['strength'], part['summary'])]
            else:
                lines.append('  %s：（AI 判定本轮无依据，返回 null）' % label)
        return '\n'.join(lines)

    def flush(self):
        """写文件。幂等；任何异常都只警告，不影响主流程与退出码。"""
        if not self.enabled or self.written:
            return None
        try:
            body = []
            for title, text in self.parts:
                body += ['', DUMP_SEP, title, DUMP_SEP, text]
            if self.meta.get('valid') is not None or self.meta.get('stat'):
                body += ['', self._summary_section()]

            m = self.meta
            head = [DUMP_SEP,
                    'NGA 抓取快照（01 原文 + 03 总结论提示词 + 06 本轮汇总，已去重合并）',
                    DUMP_SEP,
                    '生成时间：%s' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    '版面：%s（fid=%s）' % (m.get('forum_label', '-'), m.get('forum_fid', '-')),
                    '统计：%s' % m.get('stat', '-'),
                    '说明：帖子正文会在提示词里再出现一次，本文件已对重复段落/行做去重；',
                    '      同一份内容只会出现一次（保留首次出现的位置）。']
            text = _dedupe_text('\n'.join(head + body))
            raw = text.encode('utf-8')
            if len(raw) > DUMP_MAX_BYTES:
                text = raw[:DUMP_MAX_BYTES].decode('utf-8', 'ignore') + '\n\n…（已截断）\n'
                raw = text.encode('utf-8')

            ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
            final = os.path.join(self.out_dir, 'nga-dump-%s.txt' % ts)
            latest = os.path.join(self.out_dir, 'nga-dump-latest.txt')
            for target in (final, latest):        # latest 是给后端下载用的稳定名字
                with open(target, 'w', encoding='utf-8') as fh:
                    fh.write(text)
            self.written = latest

            # 只保留最近 DUMP_KEEP 份，避免目录无限膨胀
            try:
                olds = sorted(f for f in os.listdir(self.out_dir)
                              if f.startswith('nga-dump-') and f.endswith('.txt')
                              and f != 'nga-dump-latest.txt')
                for f in olds[:-DUMP_KEEP]:
                    os.remove(os.path.join(self.out_dir, f))
            except OSError:
                pass

            log.info('抓取快照已生成：%s（%d 字节）' % (final, len(raw)))
            return final
        except Exception as exc:  # noqa: BLE001 —— 快照只是附加产物，失败不影响分析
            log.warning('生成抓取快照失败：%r' % (exc,))
            return None


# 全局单例：脚本单轮单线程运行，用它把散布在各函数里的内容收集起来
_DUMP = DumpSnapshot()


def main():
    _sys = sys
    # 运行参数：
    #   --dry-run 跑完整流程但不写 news_impact，并把 AI 原始回复打到 stdout（日志照写库）
    #   --force   忽略「分析间隔」门控，立刻跑一轮
    #   --dump    顺手生成一份「抓取快照」单文件（01 原文 + 03 总结论提示词 + 06 本轮汇总，
    #             去重合并），供管理面板下载查看；目录可用 NGA_DUMP_DIR 覆盖
    dry_run = '--dry-run' in sys.argv or os.environ.get('NGA_DRY_RUN') == '1'
    force = '--force' in sys.argv or os.environ.get('NGA_FORCE') == '1'
    want_dump = '--dump' in sys.argv or os.environ.get('NGA_DUMP') == '1'
    t0 = time.time()

    # 运行配置已全部搬到 system_settings（控制面板可改）；
    # .env 只保留数据库连接信息（面板本身要读库，这一步无法避免）。
    try:
        from dotenv import load_dotenv
        load_dotenv(ENV_FILE)
    except ImportError:
        _sys.stderr.write('[WARN] 未安装 python-dotenv，改用现有环境变量\n')
    except Exception as exc:  # noqa: BLE001
        _sys.stderr.write('[WARN] 加载 %s 失败: %r\n' % (ENV_FILE, exc))

    apply_rlimits()

    # ---- 数据库连接：唯一「不可恢复」的错误，非 0 退出便于人工介入 ----
    try:
        conn = connect_db()
    except Exception as exc:  # noqa: BLE001
        _sys.stderr.write('[ERROR] 数据库连接失败: %r\n' % (exc,))
        return 2

    handler = None

    def finish(detail, tag='FAILED', level='error', touch_success=False,
               cookie_ok=False, api_ok=False):
        """
        统一收尾：写一条「成功/失败」消息 + 回写运行状态 + 返回退出码 0。
        tag 决定消息前缀（NGA-SUCCESS / NGA-DRYRUN / NGA-FAILED），供日志检索。
        """
        cost = time.time() - t0
        msg = '[NGA-%s] %s（耗时 %.1fs）' % (tag, detail, cost)
        {'info': log.info, 'warning': log.warning, 'error': log.error}[level](msg)
        health_update(conn, status=msg, detail=detail, touch_success=touch_success,
                      cookie_ok=cookie_ok, api_ok=api_ok)
        return 0

    def failed(detail, **kw):
        return finish(detail, tag='FAILED', level='error', **kw)

    def succeeded(detail, **kw):
        return finish(detail, tag='SUCCESS', level='info', touch_success=True, **kw)

    try:
        handler = setup_logger(conn)
        log.info('NGA 舆情分析脚本启动' + ('（DRY-RUN）' if dry_run else ''))

        cfg = load_settings(conn)
        api_key = cfg['gemini_api_key']

        # ---- 抓取快照（--dump）：本轮结束时落一个文件，供管理面板下载 ----
        if want_dump:
            _DUMP.enable(os.environ.get('NGA_DUMP_DIR') or DUMP_DIR_DEFAULT)
            _DUMP.set_meta(forum_fid=cfg['nga_forum_fid'], model=cfg['gemini_model'])
        cookie = cfg['nga_cookie']

        # ---- ① 总开关（面板可关；关闭时不产生任何外部请求） ----
        if cfg['nga_analysis_enabled'] not in ('1', 'true', 'True'):
            log.info('NGA 舆情分析未启用（控制面板「市场情绪 → 启用 NGA 舆情分析」=关），本轮跳过')
            health_update(conn, status='已跳过（未启用）')
            return 0

        # ---- ② 频率门控：cron 每 5 分钟唤起，这里按面板「分析间隔」决定是否真跑 ----
        due, elapsed = should_run(conn, cfg, force)
        if not due:
            log.info('未到分析间隔（已过 %.1f 分钟 / 配置 %d 分钟），本轮跳过'
                     % (elapsed, cfg['nga_interval_minutes']))
            return 0

        # ---- ③ 配置完整性 ----
        if not api_key:
            return failed('失败：Gemini API Key 未配置'
                          '（控制面板「市场情绪 → Gemini API Key」），跳过本轮')
        if not cfg['nga_forum_fid']:
            return failed('失败：监测版面 fid 未配置或非法（控制面板「市场情绪 → 监测版面 fid」），跳过本轮')

        whitelist = load_entity_whitelist(conn)
        if not whitelist:
            return failed('失败：stocks 表为空（无角色股也无基金），无实体可分析，跳过本轮')
        log.info('实体白名单载入完成，共 %d 个（角色股+基金）' % len(whitelist))

        # ---- ④ 抓取 ----
        try:
            cookie = check_cookie(cookie)
            rows, forum_names = fetch_all_forums(cfg, cookie, cfg['nga_max_posts'])
        except CookieExpired as exc:
            log.error('[COOKIE_EXPIRED] %s（请到控制面板「市场情绪 → NGA Cookie」更新）' % exc)
            return failed('失败：NGA Cookie 失效或版面不可读 —— %s' % exc)
        except FetchFailed as exc:
            log.error('NGA 抓取失败（不重试）：%s' % exc)
            return failed('失败：NGA 抓取失败 —— %s' % exc)

        forum_label = '/'.join(forum_names) or cfg['nga_forum_fid']
        posts = select_posts(rows, whitelist, cfg['nga_max_posts'])
        log.info('抓取成功：版面 %s（fid=%s）返回 %d 条，过滤后保留 %d 条'
                 % (forum_label, cfg['nga_forum_fid'], len(rows), len(posts)))
        stat = '版面=%s fid=%s 抓到=%d 过滤=%d' % (forum_label, cfg['nga_forum_fid'],
                                                len(rows), len(posts))
        if not posts:
            return succeeded('%s AI=0 写入=0（未命中白名单/原神关键词）' % stat, cookie_ok=True)

        # ---- ④b 逐帖补正文（列表接口只给标题，正文要另外抓） ----
        # ★ 必须对**过滤后的 posts** 抓，不能对原始 rows 抓：
        #   过滤后的帖子在原始列表里可能排在第 12 名开外，对 rows[:N] 抓会一条都命中不了
        #   （实测踩过：抓了 10 帖正文，命中 0 条，提示词里还是只有标题）。
        # 逐帖抓 → 只保留摘出的短文本 → 原始 HTML 随即可回收，不落临时文件。
        content_stat = ''
        if str(cfg.get('nga_fetch_content', '1')) in ('1', 'true', 'True'):
            try:
                content_map, cstats = enrich_posts_with_content(
                    cfg, cookie, posts, int(cfg.get('nga_content_max_threads') or 12))
                filled = 0
                for p in posts:
                    hit_c = content_map.get(p['tid'])
                    if hit_c:
                        p['content'] = hit_c['text']
                        filled += 1
                content_stat = ' | 正文=%d/%d帖(%.1fKB)' % (
                    filled, len(posts), cstats['chars'] / 1024.0)
                log.info('帖子正文补充完成：成功 %d 帖 / 失败 %d 帖，合计 %.1fKB，命中送入分析的 %d 条'
                         % (cstats['ok'], cstats['fail'], cstats['chars'] / 1024.0, filled))
            except Exception as exc:  # noqa: BLE001 —— 补正文失败就退回只看标题
                log.warning('补充帖子正文异常，本轮退回「只看标题」：%r' % (exc,))
                content_stat = ' | 正文获取异常'
        else:
            content_stat = ' | 正文抓取已关闭（只看标题）'

        # ---- ④c 抓取快照：记下「本轮真正送去分析的内容」（01-nga-原文）----
        if _DUMP.enabled:
            _DUMP.set_meta(forum_label=forum_label, stat=stat, content_stat=content_stat)
            _DUMP.add('【一、NGA 抓取原文】（对应 01-nga-原文.txt）',
                      _dump_posts_text(posts, forum_label, cfg, len(rows)))

        # ---- ⑤ 调用 Gemini ----
        joined = ' '.join(p['subject'] + ' ' + p['message'] + ' ' + (p.get('content') or '')
                          for p in posts)
        # （「原神」是关键词不是实体，永远不进白名单；命中为空时退回全量白名单）
        hit = [n for n in whitelist if n in joined] or list(whitelist)

        prompt = build_prompt(posts, hit)
        answer = call_gemini(api_key, cfg, prompt)
        if answer is None:
            return failed('失败：Gemini API 调用失败（已重试 %d 次）—— %s%s'
                          % (cfg['gemini_max_retries'], stat, content_stat), cookie_ok=True)

        try:
            items = extract_json_array(answer)
        except (ValueError, json.JSONDecodeError) as exc:
            log.error('Gemini 返回内容解析失败：%s' % exc, extra={'detail': answer[:2000]})
            return failed('失败：AI 返回内容无法解析 —— %s' % stat, cookie_ok=True, api_ok=True)

        if not isinstance(items, list):
            log.error('Gemini 返回的不是 JSON 数组', extra={'detail': str(items)[:2000]})
            return failed('失败：AI 返回的不是 JSON 数组 —— %s' % stat, cookie_ok=True, api_ok=True)

        norm_index = {}
        for n in whitelist:
            norm_index.setdefault(norm_name(n), n)
        valid = validate_items(items, whitelist, norm_index)
        log.info('AI 返回 %d 条，校验通过 %d 条' % (len(items), len(valid)))
        # 快照：记下校验后的实体影响值（进【三、本轮汇总】）
        _DUMP.set_meta(valid=valid, valid_count=len(valid), ai_count=len(items))

        if dry_run:
            _sys.stdout.write('\n=== [DRY-RUN] 版面 %s | 帖子 %d 条 | 候选实体 %d 个 ===\n'
                              % (forum_label, len(posts), len(hit)))
            _sys.stdout.write('--- AI 原始回复（前 1500 字）---\n%s\n' % answer[:1500])
            _sys.stdout.write('--- 校验后的有效条目 ---\n')
            for it in valid:
                _sys.stdout.write('  %-6s %-12s impact=%-8s conf=%-6s %s\n'
                                  % (it['entity_type'], it['entity_name'],
                                     it['raw_impact'], it['confidence'], it['summary'] or ''))
            _sys.stdout.write('--- [DRY-RUN] 未写入数据库 ---\n\n')
            log.info('DRY-RUN 模式：跳过 news_impact 写入（有效 %d 条）' % len(valid))
            return finish('%s AI=%d 校验=%d 写入=0（DRY-RUN，未写库）'
                          % (stat, len(items), len(valid)),
                          tag='DRYRUN', level='info', cookie_ok=True, api_ok=True)

        # ---- ⑥ 写库 ----
        written = write_impacts(conn, valid, len(posts), datetime.datetime.now())
        _DUMP.set_meta(written=written)
        if valid and written < len(valid):
            return finish('%s AI=%d 校验=%d 写入=%d/%d（部分条目写入失败，详见 ERROR 日志）'
                          % (stat, len(items), len(valid), written, len(valid)),
                          tag='PARTIAL', level='warning', touch_success=True,
                          cookie_ok=True, api_ok=True)
        if not valid:
            log.info('本轮没有白名单内的实体，跳过结论新闻')
            return succeeded('%s AI=%d 校验=0 写入=0（无白名单内实体）' % (stat, len(items)),
                             cookie_ok=True, api_ok=True)
        log.info('news_impact 写入完成：%d 条（源帖 %d 条）' % (written, len(posts)))

        # ---- ⑦ 结论 → 市场情绪（看涨/看跌分开两行，进入待审核；失败不影响本轮成功判定） ----
        news_note = ''
        try:
            stale = cleanup_stale_pending(conn, 48)   # 顺手清掉 48 小时没人审的待审情绪
            if stale:
                log.info('已清理 %d 条过期待审情绪（超过 48 小时未审核）' % stale)
            ok_pub, senti_ids, msg = publish_sentiment(
                conn, cfg, valid, stat, cookie, api_key, forum_names, cfg['nga_forum_fid'])
            if ok_pub:
                news_note = ' | 市场情绪#%s' % '/'.join(str(x) for x in senti_ids)
                log.info('市场情绪已写入：%s' % msg)
            else:
                news_note = ' | 市场情绪未写（%s）' % msg
                log.warning('市场情绪未写入：%s' % msg)
        except Exception as exc:  # noqa: BLE001 —— 写情绪失败不该让整轮算失败
            news_note = ' | 市场情绪异常'
            log.warning('市场情绪写入异常（不影响本轮影响值）：%r' % (exc,), exc_info=True)
        _DUMP.set_meta(senti_note=(news_note or '（本轮未写市场情绪）').strip(' |'))

        return succeeded('%s%s AI=%d 校验=%d 写入=%d%s'
                         % (stat, content_stat, len(items), len(valid), written, news_note),
                         cookie_ok=True, api_ok=True)
    except Exception as exc:  # noqa: BLE001 —— 兜底：任何异常都不让 cron 发告警
        try:
            log.error('脚本未预期异常：%r' % (exc,), exc_info=True)
            finish('失败：脚本未预期异常 —— %r' % (exc,))
        except Exception:  # noqa: BLE001
            _sys.stderr.write('[ERROR] 未预期异常: %r\n' % (exc,))
        return 0
    finally:
        # 抓取快照：无论成功、失败还是异常，只要收集到了内容就落一份（幂等，失败只警告）
        try:
            _DUMP.flush()
        except Exception:  # noqa: BLE001
            pass
        # 注意：log 是 SafeLog 包装，摘 Handler 必须走底层的 _raw_log
        if handler is not None:
            try:
                _raw_log.removeHandler(handler)
                handler.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == '__main__':
    # 退出码：0 = 正常（含 Cookie 失效等业务性失败）；2 = 数据库连不上
    sys.exit(main())
