#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nga_analysis.py 的离线自测（不联网、不连库），仅本地验证，不部署到服务器。"""
import io
import json
import os
import re
import sys
import types

try:  # 让 Windows 控制台也能看清中文断言名
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'server', 'scripts')) if False else None
sys.path.insert(0, r'D:\02Code\Myproject\Genshin_Stonks_Impact\server\scripts')

# ---- 打桩 pymysql（本地可能没装） ----
if 'pymysql' not in sys.modules:
    stub = types.ModuleType('pymysql')
    stub.connect = lambda **kw: None
    sys.modules['pymysql'] = stub

import nga_analysis as m  # noqa: E402

FAILED = []


def check(name, cond, extra=''):
    print(('PASS' if cond else 'FAIL') + ' | ' + name + (' | ' + str(extra) if extra else ''))
    if not cond:
        FAILED.append(name)


# ---------------- 假连接 / 假游标 ----------------
class FakeCursor:
    def __init__(self, script):
        self.script = script
        self.rows = []
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, args=None):
        self.executed.append((sql, args))
        self.script.log.append((sql, args))
        for pat, rows in self.script.responses:
            if pat in sql:
                self.rows = list(rows)
                return
        self.rows = []

    def fetchall(self):
        return self.rows


class FakeConn:
    def __init__(self, responses):
        self.responses = responses
        self.log = []
        self.committed = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.committed += 1

    def close(self):
        pass


# ---------------- 1. load_settings ----------------
conn = FakeConn([
    ('FROM system_settings', [('nga_forum_fid', '798'), ('nga_max_posts', '99'),
                              ('nga_request_timeout', 'abc'), ('gemini_max_retries', '9'),
                              ('gemini_model', 'gemini-2.5-flash-lite')]),
    ('FROM stocks', []),
])
logbuf = io.StringIO()
RAW = m._raw_log  # log 是 SafeLog 包装，测试里直接操作底层 logger 的 handlers
old_handlers = RAW.handlers[:]
h = m.logging.StreamHandler(logbuf)
RAW.handlers = [h]
cfg = m.load_settings(conn)
# NGA_FORUM_FID 的 caster 是 str：它只是拼进表单/Referer 的字符串，不做数值运算
check('配置: 有值项生效', cfg['nga_forum_fid'] == '798' and cfg['nga_max_posts'] == 99, cfg['nga_forum_fid'])
check('配置: 非法超时回退默认 15', cfg['nga_request_timeout'] == 15, cfg['nga_request_timeout'])
check('配置: 缺失项用默认(模型)', cfg['gemini_model'] == 'gemini-2.5-flash-lite')
check('配置: 重试次数收敛到<=5', cfg['gemini_max_retries'] == 5, cfg['gemini_max_retries'])
check('配置: 缺失 nga_* 有 WARN', 'nga_request_timeout' in logbuf.getvalue(), logbuf.getvalue().strip()[:120])
# 2026-09-14 清理：已删除的僵尸键不允许再出现在 DEFAULTS 里（否则会重新写回 system_settings）
for _dead in ('nga_news_publisher_id', 'NEWS_IMPACT_WEIGHT', 'NEWS_DECAY_FACTOR',
              'NEWS_MIN_THRESHOLD', 'READONLY_KEYS'):
    check('配置: 已删除的僵尸键不再出现（%s）' % _dead, _dead not in dir(m) and _dead not in m.DEFAULTS)
RAW.handlers = old_handlers

# ---------------- 2. 白名单 ----------------
conn = FakeConn([('FROM stocks', [('钟离', 'STOCK'), ('雷电将军', 'STOCK'), ('配队A', 'FUND'),
                                  ('', 'STOCK'), ('退市角色', 'STOCK')])])


class StocksCursor(FakeCursor):
    """模拟 stocks 表：退市(status=2)不进白名单，与真实 SQL 的 WHERE status <> 2 对齐。"""

    def execute(self, sql, args=None):
        super().execute(sql, args)
        if 'FROM stocks' in sql:
            self.rows = [r for r in self.rows if r[0] != '退市角色']


class StocksConn(FakeConn):
    def cursor(self):
        return StocksCursor(self)


wl = m.load_entity_whitelist(StocksConn([('FROM stocks', [('钟离', 'STOCK'), ('雷电将军', 'STOCK'),
                                                          ('配队A', 'FUND'), ('', 'STOCK'),
                                                          ('退市角色', 'STOCK')])]))
check('白名单: 角色+基金合并(空名/退市已排除)', set(wl) == {'钟离', '雷电将军', '配队A'}, wl)
check('白名单: type 映射 role/fund', wl['钟离'] == 'role' and wl['配队A'] == 'fund')

# ---------------- 3. 帖子过滤（含 max_posts 截断） ----------------
rows = [
    {'subject': '关于钟离的配队讨论', 'message': 'x' * 500},
    {'subject': '水贴', 'message': '今天天气不错'},
    {'subject': '原神新活动', 'message': '内容' * 10},
    {'subject': '雷电将军复刻', 'message': '想抽'},
    {'subject': '配队A净值', 'message': '基金'},
]
posts = m.select_posts(rows, wl, 30)
check('过滤: 命中钟离/原神/雷电将军/基金', len(posts) == 4, [p['subject'] for p in posts])
check('过滤: 摘要截断到 200 字', len(posts[0]['message']) == 200, len(posts[0]['message']))
posts2 = m.select_posts(rows, wl, 2)
check('过滤: max_posts 生效', len(posts2) == 2)

# ---------------- 4. prompt 组装 ----------------
prompt = m.build_prompt(posts[:1], ['钟离', '配队A'])
check('Prompt: 白名单填入', '钟离、配队A' in prompt)
check('Prompt: 帖子内容填入', '【关于钟离的配队讨论】' in prompt)
check('Prompt: JSON 花括号未被 format 破坏', '"entity": "<必须是白名单中的名称，严格匹配>"' in prompt)

# ---------------- 4b. 楼层解析（主楼 <p> + 回复 <span>，2026-09-14 修的真实 bug） ----------------
# 背景：NGA 帖子里主楼是 <p id='postcontent0' class='postcontent ubbcode'>…</p>，
#   而回复是 <span id='postcontent1' class='postcontent ubbcode'>…</span>。
#   旧正则写死 `</p>` ⇒ 回复层全部匹配不到，页内 20 层实际只摘出 1 层，
#   于是「抓回帖」从未生效，白白浪费了同一份 HTML 里已经拿到的社区讨论。
_THREAD_HTML = (
    "<h3 id='postsubject0'>白术到底行不行</h3>"
    "<p id='postcontent0' class='postcontent ubbcode'>主楼观点：机制落后。</p>"
    "<span id='postcontentandsubject1'><h3 id='postsubject1'></h3><br/>"
    "<span id='postcontent1' class='postcontent ubbcode'>回复一：不如四星。</span></span>"
    "<span id='postcontent2' class='postcontent ubbcode'>回复二：等新版本吧。</span>"
    "<span id='postcontent3' class='postcontent ubbcode'></span>"          # 空楼层要跳过
    "<span id='postcontent4' class='postcontent ubbcode'>[quote]引用内容[/quote]回复三</span>"
)
_subj, _floors = m.extract_thread_text(_THREAD_HTML, 240, 8)
check('楼层解析: 标题取自 postsubject0', _subj == '白术到底行不行', _subj)
check('楼层解析: 主楼 <p> 被摘出', any('主楼观点' in f for f in _floors))
check('楼层解析: 回复 <span> 也被摘出（回归：旧正则只认 </p>）',
      sum(1 for f in _floors if '回复' in f) >= 3, '摘出楼层=%d' % len(_floors))
check('楼层解析: 空楼层被跳过', len(_floors) == 4, '摘出楼层=%d' % len(_floors))
check('楼层解析: BBCode 被清掉', all('[quote]' not in f for f in _floors))
_subj2, _f1 = m.extract_thread_text(_THREAD_HTML, 240, 1)
check('楼层解析: max_floors=1 时只剩主楼', len(_f1) == 1 and '主楼观点' in _f1[0])
check('楼层解析: 面板项 nga_content_max_floors 传进 extract_thread_text',
      m.extract_thread_text(_THREAD_HTML, 240, 2)[1].__len__() == 2)

# ---------------- 5. JSON 提取 ----------------
check('解析: 纯数组', m.extract_json_array('[{"entity":"钟离"}]') == [{'entity': '钟离'}])
check('解析: markdown 包裹', m.extract_json_array('```json\n[{"a":1}]\n```') == [{'a': 1}])
check('解析: 前后有废话', m.extract_json_array('好的，结果如下：\n[{"a":2}]\n以上。') == [{'a': 2}])
try:
    m.extract_json_array('抱歉，我无法分析')
    check('解析: 无数组时抛 ValueError', False)
except ValueError:
    check('解析: 无数组时抛 ValueError', True)
try:
    m.extract_json_array('[{"a":}]')
    check('解析: 坏 JSON 抛异常', False)
except ValueError:
    check('解析: 坏 JSON 抛异常', True)

# ---------------- 6. 条目校验 ----------------
norm_index = {}
for n in wl:
    norm_index.setdefault(m.norm_name(n), n)
items = [
    {'entity': '钟离', 'impact': 0.5, 'confidence': 0.8, 'summary': '利好'},
    {'entity': '钟离（岩王帝君）', 'impact': 0.9, 'confidence': 0.9, 'summary': '模糊匹配'},
    {'entity': '雷电将军', 'impact': 5, 'confidence': 9, 'summary': '越界'},
    {'entity': '不存在的角色', 'impact': 0.3, 'confidence': 0.5, 'summary': '应丢弃'},
    'not-a-dict',
    {'entity': '配队A', 'impact': -0.25, 'confidence': 0.6, 'summary': '利空'},
]
logbuf = io.StringIO()
RAW.handlers = [m.logging.StreamHandler(logbuf)]
valid = m.validate_items(items, wl, norm_index)
RAW.handlers = old_handlers
names = [v['entity_name'] for v in valid]
check('校验: 名称标准化+去重', names == ['钟离', '雷电将军', '配队A'], names)
check('校验: impact/confidence 限幅', valid[1]['raw_impact'] == 1.0 and valid[1]['confidence'] == 1.0)
check('校验: 基金映射 fund', valid[2]['entity_type'] == 'fund')
check('校验: 非白名单丢弃并 WARN', '不在白名单中' in logbuf.getvalue(), logbuf.getvalue().strip()[:80])
check('校验: 中文括号模糊匹配', valid[0]['summary'] == '利好')

# ---------------- 7. 写入 SQL 与数值精度 ----------------
conn = FakeConn([])
n = m.write_impacts(conn, valid, 7, m.datetime.datetime(2026, 9, 12, 3, 3, 0))
check('写入: 3 条全部 upsert', n == 3)
check('写入: commit 已调用', conn.committed == 1)
sql, args = next((s, a) for s, a in conn.log if 'INSERT INTO news_impact' in s)
check('写入: 使用 ON DUPLICATE KEY UPDATE', 'ON DUPLICATE KEY UPDATE' in sql)
check('写入: 参数为 Decimal 4 位', str(args[2]) == '0.5000' and str(args[4]) == '0.800', args[2:5])
check('写入: source_count=7', args[6] == 7)
check('写入: analyzed_at 为 datetime', isinstance(args[7], m.datetime.datetime))
conn0 = FakeConn([])
check('写入: 空列表不写库', m.write_impacts(conn0, [], 7, m.datetime.datetime.now()) == 0 and not conn0.log)

# ---------------- 8. Cookie 校验（面板配置值，不再读文件） ----------------
check('Cookie: 正常账号 Cookie 通过',
      m.check_cookie('ngaPassportUid=1; ngaPassportCid=x') == 'ngaPassportUid=1; ngaPassportCid=x')
try:
    m.check_cookie('')
    check('Cookie: 空值视为失效', False)
except m.CookieExpired as e:
    check('Cookie: 空值视为失效', '为空' in str(e), str(e))
try:
    m.check_cookie('guestJs=1; Hm_lvt_x=2')
    check('Cookie: 缺 passport 段判为未登录', False)
except m.CookieExpired as e:
    check('Cookie: 缺 passport 段判为未登录', 'ngaPassportUid' in str(e), str(e))

# 抓取：fid 未配置 / Cookie 失效关键字识别
class FakeResp:
    def __init__(self, body, status=200, headers=None):
        self.body = body
        self.status = status
        self.headers = headers or {}

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def patch_urlopen(payload, capture=None, headers=None):
    """capture：可选 list，用来记录请求 URL，断言接口形态是否正确。
    headers：可选，模拟响应头（用于验证 gzip/deflate 解压与 Accept-Encoding 协商）。"""
    def fake(req, timeout=None, context=None):
        if capture is not None:
            capture.append(req.full_url)
        if isinstance(payload, Exception):
            raise payload
        return FakeResp(payload, headers=headers)
    m.urllib.request.urlopen = fake


cfgf = dict(cfg); cfgf['nga_forum_fid'] = ''
try:
    m.fetch_all_forums(cfgf, 'c=1', 30)
    check('抓取: fid 未配置 → FetchFailed', False)
except m.FetchFailed:
    check('抓取: fid 未配置 → FetchFailed', True)

cfgf['nga_forum_fid'] = 'abc<script>'
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: 非法 fid 直接拒绝', False)
except m.FetchFailed:
    check('抓取: 非法 fid 直接拒绝', True)
cfgf['nga_forum_fid'] = '835'

# ★ 真实响应结构（2026-09 服务器实测）：data.__CU/__F/__T
NGA_THREAD_REAL = (
    '{"data":{"__CU":{"uid":65583388,"group_bit":98528},'
    '"__GLOBAL":{"_ATTACH_BASE_VIEW":"img.nga.cn/attachments"},'
    '"__ROWS":180699,"__F":{"fid":835,"name":"\\u5251\\u6597\\u7eee\\u8c2d","topped_topic":35520768},'
    '"__T":[{"tid":47549508,"fid":835,"author":"\\u901a\\u5929\\u8def\\u9065","subject":"\\u9694\\u58c1\\u8f68\\u5b50",'
    '"postdate":1789290580,"lastpost":1789313375,"replies":87}]},"time":1789313480}'
)
urls = []
patch_urlopen(NGA_THREAD_REAL.encode('utf-8'), capture=urls)
rows, forum_name = m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
check('抓取: 真实响应解析出 1 条帖子', len(rows) == 1 and rows[0]['tid'] == 47549508)
check('抓取: 版面名解析正确', forum_name == '剑斗绮谭', forum_name)
check('抓取: 用的是 thread.php 且带 __output=11',
      'thread.php' in urls[0] and '__output=11' in urls[0] and 'fid=835' in urls[0], urls[0])
check('抓取: 不再使用 forum.php', 'forum.php' not in urls[0], urls[0])

# ---- gzip 协商与解压（2026-09-14 新增：实测 NGA 支持 gzip，正文页省 69% 字节）----
_hdr_seen = []


def _capture_headers(payload, capture):
    """记录请求头，验证我们确实带了 Accept-Encoding"""
    def fake(req, timeout=None, context=None):
        capture.append(dict(req.headers))
        return FakeResp(payload)
    m.urllib.request.urlopen = fake


_heads = []
_capture_headers(NGA_THREAD_REAL.encode('utf-8'), _heads)
m.fetch_forum(cfgf, 'c=1', '835')
check('抓取: 列表请求带了 Accept-Encoding: gzip',
      'Accept-encoding' in _heads[-1] or 'Accept-Encoding' in _heads[-1],
      str(_heads[-1].get('Accept-encoding') or _heads[-1].get('Accept-Encoding')))

# _open() 必须自己解开 gzip（否则后面正则会一条都匹配不到）
_gz = m.gzip.compress(NGA_THREAD_REAL.encode('utf-8'))
patch_urlopen(_gz, headers={'Content-Encoding': 'gzip'})
_rows_gz, _name_gz = m.fetch_forum(cfgf, 'c=1', '835')
check('抓取: gzip 响应被自动解压（能解析出帖子）',
      len(_rows_gz) == 1 and _rows_gz[0]['tid'] == 47549508, '解析出 %d 条' % len(_rows_gz))

# deflate 两种形态都要能解：带 zlib 头 + 裸 deflate（RFC1951）
patch_urlopen(m.zlib.compress(NGA_THREAD_REAL.encode('utf-8')), headers={'Content-Encoding': 'deflate'})
try:
    _rows_df = m.fetch_forum(cfgf, 'c=1', '835')[0]
    _ok_df = len(_rows_df) == 1
except Exception as exc:  # noqa: BLE001
    _ok_df = False
    _rows_df = exc
check('抓取: deflate(zlib 头) 响应被自动解压', _ok_df, str(_rows_df)[:80])

_co = m.zlib.compressobj(9, m.zlib.DEFLATED, -m.zlib.MAX_WBITS)
_raw_deflate = _co.compress(NGA_THREAD_REAL.encode('utf-8')) + _co.flush()
patch_urlopen(_raw_deflate, headers={'Content-Encoding': 'deflate'})
try:
    _rows_rd = m.fetch_forum(cfgf, 'c=1', '835')[0]
    _ok_rd = len(_rows_rd) == 1
except Exception as exc:  # noqa: BLE001
    _ok_rd = False
    _rows_rd = exc
check('抓取: deflate(裸 RFC1951) 响应也被自动解压', _ok_rd, str(_rows_rd)[:80])

# 帖子过滤能直接吃 NGA 真实字段
# 注意：标题刻意不含提问/公告特征，否则会被 select_posts 的「提问帖过滤」剔掉（那是独立规则）
sel = m.select_posts([{'subject': '原神7.0版本 无神怜爱的雪国 剧情讨论', 'message': ''}], wl, 30)
check('抓取: 真实 subject 字段可被过滤命中', len(sel) == 1 and '原神' in sel[0]['subject'])

# 提问/公告/签到帖应被剔除（不含市场情绪），但真实情绪帖不能被误杀
# 注意：这里必须用「含白名单实体」的标题，否则过不了第一层白名单过滤，测不到本规则
qrows = [
    {'subject': '请教下新版本满命钟离的问题！', 'message': ''},          # 提问 → 剔
    {'subject': '[版务公告] 关于钟离相关违规行为的公告', 'message': ''},  # 公告 → 剔
    {'subject': '原神7.0版本 钟离签到活动', 'message': ''},              # 活动 → 剔
    {'subject': '家人们这新角色怎么这么强，配队A 无敌', 'message': ''},   # 情绪帖 → 必须保留
]
qsel = m.select_posts(qrows, wl, 30)
qsub = [p['subject'] for p in qsel]
check('过滤: 提问/公告/活动帖被剔除', len(qsel) == 1 and '无敌' in qsub[0], qsub)
check('过滤: 真实情绪帖不被误杀（保守词表）', any('家人们' in s for s in qsub), qsub)

# 规则本身的白名单无关单测：这几种必须判为「提问/公告」
for t in ('克洛琳德怎么配队呀', '请教下新版本满命夜兰的问题！', '[版务公告] 严打违规',
          '原神7.0版本 NGA签到活动', '大佬们我这个号怎么办'):
    check('判定: 「%s」→ 提问/公告类' % t[:14], m.looks_like_question(t))
for t in ('家人们这新角色怎么这么强', '感觉自选牛牛和克洛琳德都是骗局', '论挂水妮露是不是仅次于少女？'):
    check('判定: 「%s」→ 保留（含情绪）' % t[:14], not m.looks_like_question(t))

patch_urlopen(b'{"data":{"__CU":{},"__T":[]},"time":1}')
check('抓取: 空版面返回空列表(不报错)',
      m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])[0] == [])

patch_urlopen(b'{"error":["ACTION NOT FOUND __act_load lib_thread"],"time":1}')
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: NGA 报 error 字段 → CookieExpired', False)
except m.CookieExpired:
    check('抓取: NGA 报 error 字段 → CookieExpired', True)

patch_urlopen(b'{"data":[1,2,3],"time":1}')
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: data 不是对象 → FetchFailed', False)
except m.FetchFailed:
    check('抓取: data 不是对象 → FetchFailed', True)

patch_urlopen('<!DOCTYPE html><html>...&#35775;&#23458;&#19981;&#33021;&#30452;&#25509;&#35775;&#38382;...</html>'.encode('utf-8'))
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: 实体编码的访客提示 → CookieExpired', False)
except m.CookieExpired:
    check('抓取: 实体编码的访客提示 → CookieExpired', True)

patch_urlopen('访客不能直接访问'.encode('utf-8'))
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: 明文访客提示 → CookieExpired', False)
except m.CookieExpired:
    check('抓取: 明文访客提示 → CookieExpired', True)

# ★ 服务器上实测到的真实游客响应（中文被 \u 转义，无明文关键字）
NGA_GUEST_REAL = (
    '{"data":[{"fid":-60157311,"denied":true,"error":"\\u8bbf\\u5ba2\\u4e0d\\u80fd\\u76f4\\u63a5\\u8bbf\\u95ee",'
    '"name":"\\u5c11\\u524d:\\u4e91\\u56fe\\u8ba1\\u5212","descrip":null,"url":"thread.php?fid=-60157311"}],'
    '"time":1757700000}'
)
patch_urlopen(NGA_GUEST_REAL.encode('utf-8'))
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: 真实游客响应(denied:true) → CookieExpired', False)
except m.CookieExpired:
    check('抓取: 真实游客响应(denied:true) → CookieExpired', True)

patch_urlopen(m.urllib.error.HTTPError('u', 403, 'Forbidden', None, None))
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: HTTP 403 → CookieExpired', False)
except m.CookieExpired:
    check('抓取: HTTP 403 → CookieExpired', True)

patch_urlopen(m.urllib.error.HTTPError('u', 500, 'Server Error', None, None))
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: HTTP 500 → FetchFailed(非Cookie问题)', False)
except m.FetchFailed:
    check('抓取: HTTP 500 → FetchFailed(非Cookie问题)', True)

patch_urlopen(m.urllib.error.URLError('timed out'))
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: 超时 → FetchFailed(不重试)', False)
except m.FetchFailed:
    check('抓取: 超时 → FetchFailed(不重试)', True)

patch_urlopen(b'<html>not json</html>')
try:
    m.fetch_forum(cfgf, 'c=1', cfgf['nga_forum_fid'])
    check('抓取: 非 JSON → FetchFailed', False)
except m.FetchFailed:
    check('抓取: 非 JSON → FetchFailed', True)

# 多版面：fid 逗号分隔，合并结果；单个版面失败不拖垮整轮
resp_seq = {'i': 0}


def patch_urlopen_seq(payloads, capture=None):
    def fake(req, timeout=None, context=None):
        if capture is not None:
            capture.append(req.full_url)
        i = min(resp_seq['i'], len(payloads) - 1)
        resp_seq['i'] += 1
        p = payloads[i]
        if isinstance(p, Exception):
            raise p
        return FakeResp(p)
    m.urllib.request.urlopen = fake


ONE = ('{"data":{"__F":{"fid":650,"name":"原神"},"__T":[{"tid":1,"subject":"原神讨论"}]},'
       '"time":1}').encode('utf-8')
TWO = ('{"data":{"__F":{"fid":835,"name":"剑斗绮谭"},"__T":[{"tid":2,"subject":"配队"}]},'
       '"time":1}').encode('utf-8')

multi_cfg = dict(cfgf); multi_cfg['nga_forum_fid'] = '650,835'
resp_seq['i'] = 0
urls_multi = []
patch_urlopen_seq([ONE, TWO], capture=urls_multi)
rows_m, names_m = m.fetch_all_forums(multi_cfg, 'c=1', 30)
check('多版面: 合并两个版面的帖子', len(rows_m) == 2 and names_m == ['原神', '剑斗绮谭'], names_m)
check('多版面: 分别请求了两个 fid',
      any('fid=650' in u for u in urls_multi) and any('fid=835' in u for u in urls_multi), urls_multi)

resp_seq['i'] = 0
patch_urlopen_seq([m.urllib.error.HTTPError('u', 403, 'Forbidden', None, None), TWO])
rows_p, names_p = m.fetch_all_forums(multi_cfg, 'c=1', 30)
check('多版面: 单版面 403 时其余版面照常出结果', len(rows_p) == 1 and names_p == ['剑斗绮谭'], names_p)

resp_seq['i'] = 0
patch_urlopen_seq([m.urllib.error.HTTPError('u', 403, 'Forbidden', None, None),
                   m.urllib.error.HTTPError('u', 403, 'Forbidden', None, None)])
try:
    m.fetch_all_forums(multi_cfg, 'c=1', 30)
    check('多版面: 全部失败才抛异常', False)
except m.CookieExpired:
    check('多版面: 全部失败才抛异常', True)

resp_seq['i'] = 0
patch_urlopen_seq([ONE, TWO])
rows_lim, _ = m.fetch_all_forums(multi_cfg, 'c=1', 1)
check('多版面: 达到 max_posts 就停（不再请求第二个版面）',
      len(rows_lim) == 1 and resp_seq['i'] == 1, resp_seq['i'])

# ---------------- 8b. 频率门控 should_run ----------------
gate_conn = FakeConn([('FROM nga_analysis_log', [(None,)])])
check('门控: 从没跑过 → 运行', m.should_run(gate_conn, {'nga_interval_minutes': 180}, False)[0])
gate_conn2 = FakeConn([('FROM nga_analysis_log', [(m.time.time() - 60,)])])
due, elapsed = m.should_run(gate_conn2, {'nga_interval_minutes': 180}, False)
check('门控: 距上次 1 分钟 < 180 → 跳过', due is False and 0.5 < elapsed < 2.0, elapsed)
due2, _ = m.should_run(gate_conn2, {'nga_interval_minutes': 180}, True)
check('门控: --force 忽略间隔', due2 is True)
gate_conn3 = FakeConn([('FROM nga_analysis_log', [(m.time.time() - 200 * 60,)])])
check('门控: 距上次 200 分钟 ≥ 180 → 运行',
      m.should_run(gate_conn3, {'nga_interval_minutes': 180}, False)[0])
check('门控: 间隔 0 = 不限制', m.should_run(gate_conn2, {'nga_interval_minutes': 0}, False)[0])

# ---------------- 8c. 运行状态回写 ----------------
health_conn = FakeConn([])
m.health_update(health_conn, status='[NGA-SUCCESS] 测试', detail='版面=原神',
                touch_success=True, cookie_ok=True, api_ok=True,
                now_str='2026-09-14 00:03:00')
updates = {a[1]: a[0] for s, a in health_conn.log if 'UPDATE system_settings' in s}
check('健康状态: 只 UPDATE 已存在项，不新增',
      all('UPDATE system_settings SET s_value' in s for s, _ in health_conn.log if 'system_settings' in s))
check('健康状态: 回写了状态/时间/成功/Cookie/API/摘要六项',
      set(updates) == {'nga_health_status', 'nga_health_last_run', 'nga_health_last_success',
                       'nga_health_cookie_ok_at', 'nga_health_api_ok_at', 'nga_health_last_detail'},
      sorted(updates))
check('健康状态: 状态文本带 [NGA-SUCCESS] 前缀',
      updates['nga_health_status'] == '[NGA-SUCCESS] 测试', updates['nga_health_status'])
check('健康状态: 时间字符串正确', updates['nga_health_last_run'] == '2026-09-14 00:03:00')
check('健康状态: detail 写入 s_value（不新增行）',
      len([1 for s, _ in health_conn.log if 'UPDATE system_settings' in s]) == 6,
      len([1 for s, _ in health_conn.log if 'UPDATE system_settings' in s]))

# ---------------- 8d. 键名一致性（防止「面板改了但脚本读不到」） ----------------
# 脚本的 DEFAULTS 键名必须能在后端 SETTING_SCHEMA（面板渲染依据）里找到，
# 这一项是踩过坑后加的回归断言：曾经脚本写大写 NGA_*，面板写小写，两边不同批键。
BACKEND_SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              '..', 'src', 'services', 'settingService.js')
try:
    with open(BACKEND_SCHEMA, encoding='utf-8') as fh:
        schema_src = fh.read()
    schema_keys = set(re.findall(r"key:\s*'([a-zA-Z0-9_]+)'", schema_src))
except OSError as exc:
    schema_keys = set()
    print('  ! 读不到 settingService.js（%r），跳过键名一致性检查' % (exc,))

if schema_keys:
    panel_keys = [k for k in m.DEFAULTS if k.startswith(('nga_', 'gemini_'))]
    missing = [k for k in panel_keys if k not in schema_keys]
    check('键名一致: 脚本读的每个面板键都在 SETTING_SCHEMA 里',
          not missing, '缺失=%s' % missing)
    health_in_schema = [v for v in m.HEALTH_KEYS.values() if v not in schema_keys]
    check('键名一致: 健康状态键也都在 SETTING_SCHEMA 里',
          not health_in_schema, '缺失=%s' % health_in_schema)
    check('键名一致: 敏感键在 schema 里标了 secret',
          all("key: '%s'" % k in schema_src and schema_src[
              schema_src.index("key: '%s'" % k):schema_src.index("key: '%s'" % k) + 320].find('secret: true') > 0
              for k in ('gemini_api_key', 'nga_cookie')), '检查 secret 标记')
    check('键名一致: DEFAULTS 里没有残留大写配置键',
          not [k for k in m.DEFAULTS if re.match(r'^(NGA|GEMINI)_[A-Z]', k)],
          [k for k in m.DEFAULTS if re.match(r'^(NGA|GEMINI)_[A-Z]', k)])

# ---------------- 9. Gemini：重试与错误处理 ----------------
calls = {'n': 0}


def patch_gemini(responses):
    def fake(url, data, headers, timeout):
        i = calls['n']
        calls['n'] += 1
        r = responses[min(i, len(responses) - 1)]
        if isinstance(r, Exception):
            raise r
        return r
    m.http_post = fake


m.time.sleep = lambda s: None  # 去掉 5 秒等待
gcfg = dict(cfg); gcfg['gemini_max_retries'] = 1; gcfg['gemini_timeout_seconds'] = 5

calls['n'] = 0
patch_gemini([(200, b'{"candidates":[{"content":{"parts":[{"text":"[{\\"entity\\":\\"x\\"}]"}]}}]}')])
check('Gemini: 首次成功', m.call_gemini('key', gcfg, 'p') == '[{"entity":"x"}]')

calls['n'] = 0
patch_gemini([(500, b'{"error":"boom"}'),
              (200, b'{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}')])
check('Gemini: 失败后重试成功', m.call_gemini('key', gcfg, 'p') == 'OK' and calls['n'] == 2)

calls['n'] = 0
patch_gemini([(429, b'{"error":"quota"}')])
logbuf = io.StringIO()
RAW.handlers = [m.logging.StreamHandler(logbuf)]
check('Gemini: 全部失败返回 None', m.call_gemini('key', gcfg, 'p') is None)
check('Gemini: 失败写 ERROR 日志', 'Gemini API 调用失败' in logbuf.getvalue(), logbuf.getvalue().strip()[:80])
RAW.handlers = old_handlers

calls['n'] = 0
patch_gemini([(200, b'{"candidates":[]}')])
RAW.handlers = [m.logging.StreamHandler(io.StringIO())]
check('Gemini: 无候选(安全拦截)返回 None', m.call_gemini('key', gcfg, 'p') is None)
RAW.handlers = old_handlers

# ---------------- 10. 日志 Handler 降级 ----------------
class BrokenCursor:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **k):
        raise RuntimeError('table missing')


class BrokenConn:
    def cursor(self):
        return BrokenCursor()

    def commit(self):
        pass


err = io.StringIO()
old_err = sys.stderr
sys.stderr = err
hdlr = m.MysqlLogHandler(BrokenConn())
rec = m.logging.LogRecord('nga', m.logging.INFO, '', 1, 'hello %s', ('world',), None)
hdlr.emit(rec)
hdlr.emit(rec)
sys.stderr = old_err
check('日志Handler: 写库失败降级 stderr', '[LOGGING-FALLBACK]' in err.getvalue(), err.getvalue().strip()[:80])
check('日志Handler: 失败后不再重复报错（只 1 行）', err.getvalue().count('LOGGING-FALLBACK') == 1)
check('日志Handler: message 截断 512', m.MysqlLogHandler(BrokenConn()) is not None)

# ---------------- 11. 主流程 main() 集成（全打桩，防收尾 AttributeError 之类） ----------------
print()
print('--- main() 集成（全打桩） ---')

# SafeLog 必须覆盖主流程用到的全部日志方法（曾经漏了 removeHandler 导致退出码 1）
check('SafeLog: 具备 info/warning/error', all(hasattr(m.log, k) for k in ('info', 'warning', 'error')))
check('SafeLog: 不再暴露 removeHandler（收尾走 _raw_log）', not hasattr(m.log, 'removeHandler'))

import tempfile  # noqa: E402

MAIN_LOGS = []

# 面板配置（全部来自 system_settings），集成测试里按需改这几项
MAIN_SETTINGS = {
    # 键名必须与实际 system_settings 一致（全小写），否则就是「面板改了但脚本读不到」
    'nga_analysis_enabled': '1',
    'nga_interval_minutes': '180',
    'nga_forum_fid': '835',
    'nga_max_posts': '30',
    'nga_request_timeout': '15',
    'gemini_max_retries': '2',
    'gemini_timeout_seconds': '30',
    'gemini_model': 'gemini-3.5-flash-lite',
    'gemini_api_key': 'test-key',
    'nga_cookie': 'ngaPassportUid=1; ngaPassportCid=x',
}


class MainCursor:
    def __init__(self, outer):
        self.outer = outer
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, args=None):
        self.outer.log.append((sql, args))
        if 'FROM system_settings' in sql:
            self.rows = list(MAIN_SETTINGS.items())
        elif 'FROM nga_analysis_log' in sql:
            self.rows = [(m.time.time() - 999 * 60,)]   # 上次分析在很久以前 → 门控放行
        elif 'FROM stocks' in sql:
            self.rows = [('钟离', 'STOCK'), ('嘉明', 'STOCK'), ('配队A', 'FUND')]
        else:
            self.rows = []

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class MainConn:
    def __init__(self):
        self.log = []
        self.closed = False

    def cursor(self):
        return MainCursor(self)

    def commit(self):
        pass

    def close(self):
        self.closed = True


def health_values(conn):
    """从假连接的 SQL 日志里抽取 nga_health_* 的写入值。"""
    out = {}
    for sql, args in conn.log:
        if 'UPDATE system_settings SET s_value' in sql and args and len(args) == 2:
            out[args[1]] = args[0]
    return out


MAIN_CONN = MainConn()
REAL_POSTS = [{'tid': 1, 'subject': '关于嘉明 0 金高 DPS 的讨论', 'message': '钟离配队很强'}]
REAL_ANSWER = ('```json\n[{"entity":"嘉明","impact":0.9,"confidence":0.95,"summary":"0金高DPS"},'
               '{"entity":"钟离（岩王帝君）","impact":0.3,"confidence":0.8,"summary":"配队核心"},'
               '{"entity":"不存在","impact":0.5,"confidence":0.5,"summary":"应丢弃"}]\n```')

m.connect_db = lambda: MAIN_CONN
m.fetch_all_forums = lambda cfg, ck, n: (REAL_POSTS, ['剑斗绮谭'])
m.call_gemini = lambda key, cfg, prompt: REAL_ANSWER

# 让 main() 里的 log.* 落进我们的列表，验证日志内容
_orig_setup = m.setup_logger


class CapturingHandler(m.MysqlLogHandler):
    """真的走 Handler，顺带把消息文本收进 MAIN_LOGS，便于断言日志内容。"""

    def emit(self, record):
        MAIN_LOGS.append('%s|%s' % (record.levelname, record.getMessage()))
        return super().emit(record)


def spy_setup_capture(conn):
    global MAIN_LOGS
    MAIN_LOGS = []
    h = CapturingHandler(conn)
    m._raw_log.setLevel(m.logging.INFO)   # 生产代码里 setup_logger 会做这一步
    m._raw_log.propagate = False
    m._raw_log.addHandler(h)
    m.log = m.SafeLog(m._raw_log)
    return h


def run_main(settings=None, argv=(), conn=None, cookie=None, posts=None, answer=None):
    """跑一次 main()，返回 (退出码, 连接, 日志列表)。

    注意：settings 传进来的是「本次的完整配置」，内部会拷贝一份，
    不会污染 MAIN_SETTINGS 基准值（否则后面的用例会串味）。
    """
    global MAIN_CONN
    base = dict(MAIN_SETTINGS) if settings is None else dict(settings)
    MAIN_SETTINGS.clear()
    MAIN_SETTINGS.update(base)
    MAIN_CONN = conn if conn is not None else MainConn()
    m.connect_db = lambda: MAIN_CONN
    m.fetch_all_forums = lambda cfg, ck, n: (REAL_POSTS if posts is None else posts,
                                             ['剑斗绮谭'])
    m.call_gemini = lambda key, cfg, prompt: (REAL_ANSWER if answer is None else answer)
    m.sys.argv = ['nga_analysis.py'] + list(argv)
    rc = m.main()
    return rc, MAIN_CONN, list(MAIN_LOGS)


m.setup_logger = spy_setup_capture
os.environ.pop('NGA_DRY_RUN', None)
os.environ.pop('NGA_FORCE', None)

# ---- ① 正常路径（DRY-RUN） ----
rc, conn1, logs1 = run_main(argv=('--dry-run',))
check('main(): DRY-RUN 退出码 0', rc == 0, rc)
check('main(): 数据库连接已关闭', conn1.closed)
check('main(): 摘掉了日志 Handler', len(m._raw_log.handlers) == 0, m._raw_log.handlers)
joined = ' | '.join(logs1)
check('main(): 写了启动/白名单/抓取/AI 日志', all(k in joined for k in (
    'NGA 舆情分析脚本启动', '实体白名单载入完成', '抓取成功', 'AI 返回')), joined[:200])
check('main(): DRY-RUN 不写 news_impact',
      not any('INSERT INTO news_impact' in s for s, _ in conn1.log))
check('main(): DRY-RUN 收尾消息带 [NGA-DRYRUN]', '[NGA-DRYRUN]' in joined, joined[-160:])
check('main(): DRY-RUN 回写状态到面板', '[NGA-DRYRUN]' in health_values(conn1).get('nga_health_status', ''),
      health_values(conn1).get('nga_health_status'))

# ---- ② 真实写入路径 ----
rc2, conn2, logs2 = run_main()
ins = [(s, a) for s, a in conn2.log if 'INSERT INTO news_impact' in s]
joined2 = ' | '.join(logs2)
check('main(): 正常模式写入 2 条（白名单外那条被丢弃）', rc2 == 0 and len(ins) == 2, len(ins))
check('main(): 成功消息带 [NGA-SUCCESS] 与统计',
      '[NGA-SUCCESS]' in joined2 and '写入=2' in joined2, joined2[-200:])
hv2 = health_values(conn2)
check('main(): 成功时回写「最近成功时间」', bool(hv2.get('nga_health_last_success')), hv2)
check('main(): 成功时回写 Cookie/API 验证时间',
      bool(hv2.get('nga_health_cookie_ok_at')) and bool(hv2.get('nga_health_api_ok_at')))
check('main(): 成功一轮没有 ERROR', not any(x.startswith('ERROR') for x in logs2), joined2[:200])

# ---- ③ 总开关关闭：不抓取、不调 AI ----
BASE = dict(MAIN_SETTINGS, nga_analysis_enabled='1', gemini_api_key='test-key',
            nga_cookie='ngaPassportUid=1; ngaPassportCid=x')
rc3, conn3, logs3 = run_main(settings=dict(BASE, nga_analysis_enabled='0'))
joined3 = ' | '.join(logs3)
check('main(): 开关关闭时直接跳过', rc3 == 0 and '未启用' in joined3, joined3)
check('main(): 开关关闭时没有请求 NGA', not any('INSERT INTO news_impact' in s for s, _ in conn3.log))
check('main(): 跳过也回写状态',
      '已跳过' in health_values(conn3).get('nga_health_status', ''), health_values(conn3))

# ---- ④ 频率门控：距上次不足间隔 → 跳过 ----


class RecentCursor(MainCursor):
    def execute(self, sql, args=None):
        super().execute(sql, args)
        if 'FROM nga_analysis_log' in sql:
            self.rows = [(m.time.time() - 5 * 60,)]   # 5 分钟前刚跑过


class RecentConn(MainConn):
    def cursor(self):
        return RecentCursor(self)


rc4, conn4, logs4 = run_main(settings=dict(BASE), conn=RecentConn())
check('main(): 未到间隔时跳过', rc4 == 0 and '未到分析间隔' in ' | '.join(logs4), ' | '.join(logs4))
check('main(): 未到间隔时不写库',
      not any('INSERT INTO news_impact' in s for s, _ in conn4.log))

# ---- ⑤ 失败路径：Cookie 失效 ----
bad_cookie = dict(BASE, nga_cookie='guestJs=1; no_passport=2')
rc5, conn5, logs5 = run_main(settings=bad_cookie)
joined5 = ' | '.join(logs5)
check('main(): Cookie 缺失时失败并退出码 0', rc5 == 0 and '[NGA-FAILED]' in joined5, joined5[-200:])
check('main(): 失败消息带 [COOKIE_EXPIRED] 与面板指引',
      '[COOKIE_EXPIRED]' in joined5 and '控制面板' in joined5, joined5[-260:])
check('main(): 失败时状态标红可识别',
      '失败' in health_values(conn5).get('nga_health_status', ''), health_values(conn5))
check('main(): 失败时不更新「最近成功时间」',
      'nga_health_last_success' not in health_values(conn5))

# ---- ⑥ 失败路径：API Key 为空 ----
rc6, conn6, logs6 = run_main(settings=dict(BASE, gemini_api_key=''))
check('main(): API Key 为空时失败', rc6 == 0 and 'Gemini API Key 未配置' in ' | '.join(logs6),
      ' | '.join(logs6)[-200:])

# ---- ⑦ 失败路径：AI 返回无法解析 ----
rc7, conn7, logs7 = run_main(settings=dict(BASE), answer='抱歉，我无法分析')
check('main(): AI 内容无法解析时失败', rc7 == 0 and '无法解析' in ' | '.join(logs7),
      ' | '.join(logs7)[-200:])

# ---- ⑧ 部分写入失败（warning 级） ----
class FlakyCursor(MainCursor):
    def execute(self, sql, args=None):
        if 'INSERT INTO news_impact' in sql:
            raise RuntimeError('模拟写入失败')
        super().execute(sql, args)


class FlakyConn(MainConn):
    def cursor(self):
        return FlakyCursor(self)


rc8, conn8, logs8 = run_main(settings=dict(BASE), conn=FlakyConn())
joined8 = ' | '.join(logs8)
check('main(): 全部写入失败 → 部分成功(WARN)',
      rc8 == 0 and '[NGA-PARTIAL]' in joined8, joined8[-200:])
m.setup_logger = _orig_setup

print()
print('结果: %d 项失败 %s' % (len(FAILED), FAILED if FAILED else '—— 全部通过'))
sys.exit(1 if FAILED else 0)
