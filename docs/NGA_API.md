# NGA 接口文档（本项目实际使用的抓取口径）

> 本文记录「市场情绪」抓取模块**实际在用**的 NGA 接口：请求怎么写、返回长什么样、
> 哪些写法试过但不可用、以及踩过的坑。所有数据均为 2026-09-14 在**生产服务器**
> （`__DOMAIN__`，Debian 12，直连 `bbs.nga.cn`）实测所得。
>
> 对应代码：`server/scripts/nga_analysis.py`（`fetch_forum` / `fetch_thread_text` / `extract_thread_text`）。
> 相关文档：`server/scripts/nga-analysis.STATUS.md`（部署与运维）、`docs/PRICING.md` 第 14 章（情绪如何影响股价）。

---

## 0. 速查：两个接口就够

| 用途 | 方法与 URL | 认证 | 返回 | 实测体积/耗时 |
|---|---|---|---|---|
| **① 帖子列表（标题）** | `GET https://bbs.nga.cn/thread.php?fid=<fid>&__output=11` | Cookie | JSON | 明文约 22 KB / gzip 后约 6 KB / 0.5 s |
| **② 帖子正文（主楼 + 回复）** | `GET https://bbs.nga.cn/read.php?tid=<tid>`（**不加** `__output`） | Cookie | HTML(GBK) | 明文约 22~55 KB / gzip 后约 7~15 KB / 0.3 s・帖 |

> **务必带 `Accept-Encoding: gzip, deflate`**：NGA（nginx）支持压缩，实测正文页 **41.3 KB → 12.8 KB（省 69%）**、
> 列表页 21.8 KB → 约 6 KB；不带这个头 NGA 就发明文。脚本 `_open()` 会自动按 `Content-Encoding` 解压
> （gzip 与两种 deflate 都兜住），所以这是纯粹的「少下点字节」，不影响解析。

两个接口都必须带**已登录 Cookie**（含 `ngaPassportUid`、`ngaPassportCid`），否则 NGA 按游客处理，
返回的不是数据而是「访客不能直接访问」的错误对象（见 §1.4）。

```http
GET /thread.php?fid=650&__output=11 HTTP/1.1
Host: bbs.nga.cn
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
Accept: */*
Accept-Encoding: gzip, deflate
Referer: https://bbs.nga.cn/thread.php?fid=650
Cookie: ngaPassportUid=...; ngaPassportCid=...; （面板里粘贴的整条 Cookie）
```

```http
GET /read.php?tid=47555736 HTTP/1.1
Host: bbs.nga.cn
User-Agent: （同上）
Accept: text/html,*/*
Accept-Encoding: gzip, deflate
Referer: https://bbs.nga.cn/thread.php?fid=650
Cookie: （同列表接口）
```

> **为什么 Referer 要带版面**：不带时实测更容易被判定为异常访问；
> 带上 `thread.php?fid=<第一个监测版面>` 与人工浏览行为一致。
> 响应头实测：列表接口 `Content-Type: text/json;charset=UTF-8`、正文接口 `Content-Type: text/html; charset=GBK`，
> 都由 `Server: nginx` 返回。

---

## 1. 接口一：帖子列表（只有标题，没有正文）

### 1.1 请求

| 项 | 值 |
|---|---|
| 方法 | `GET` |
| URL | `https://bbs.nga.cn/thread.php?fid=<fid>&__output=11` |
| `fid` | 版面号。原神主板 = `650`，剑斗绮谭（战斗讨论子版）= `835`；多个版面 = 多次请求，逗号在脚本层拆分 |
| `__output=11` | **关键参数**：让 NGA 返回 JSON 而不是 HTML 页面 |
| 必需头 | `Cookie`（登录态）、`User-Agent`、`Referer`、`Accept: */*` |

```python
url = 'https://bbs.nga.cn/thread.php?' + urllib.parse.urlencode({'fid': fid, '__output': '11'}, safe=',-')
```

### 1.2 响应结构

实测 `HTTP 200`，约 **21.8 KB**，响应头 `Content-Type: text/json;charset=UTF-8`（注意：NGA 用的是
非标准的 `text/json`，**不是** `application/json`；`json.loads` 可直接解析），顶层两个键：

```json
{
  "data": {
    "__CU":  { "uid": 123456, "group_bit": "...", "admincheck": "...", "rvrc": "..." },
    "__F":   { "fid": 650, "name": "原神", "topped_topic": 33684916, "sub_forums": { ... } },
    "__T":   [ { 帖子1 }, { 帖子2 }, ... ],          // ★ 帖子列表（第 1 页 47 条）
    "__T__ROWS": 47, "__T__ROWS_PAGE": 70, "__R__ROWS_PAGE": 20,
    "__GLOBAL": { ... }, "__ROWS": 47
  },
  "time": 1790175326
}
```

| 键 | 含义 |
|---|---|
| `data.__T` | **帖子数组**，本页每条一元素（本实测 47 条） |
| `data.__F` | 版面信息：`fid`、`name`（用于日志里的「版面=原神」）、`sub_forums`（子版列表） |
| `data.__CU` | 当前登录账号（`uid` 等）。**这是判断 Cookie 是否真的登录的直接证据** |
| `data.__T__ROWS` / `__T__ROWS_PAGE` | 本页返回条数 / 每页上限 |
| `time` | 服务器时间戳（秒） |

### 1.3 `data.__T` 单条帖子的字段（实测 17 个）

```json
{
  "tid": 47356329, "fid": 650, "quote_from": 0, "icon": 0, "topic_misc": "AQAAACE",
  "author": "PolygonPanda", "authorid": 63146818,
  "subject": "[版务公告] 关于严打各类涉及“开盒”等违法行为的公告",
  "type": 134225920, "postdate": 1786520330, "lastpost": 1790161527,
  "lastposter": "卡兹丶", "replies": 11, "lastmodify": 1790161527,
  "recommend": 10, "jdata": null, "tpcurl": "/read.php?tid=47356329"
}
```

| 字段 | 说明 | 我们用不用 |
|---|---|---|
| `tid` | 帖子 ID（正文接口的入参） | ★ 必用 |
| `subject` | **标题**（含 `[版务公告]` 这类方括号前缀） | ★ 必用 |
| `author` / `authorid` | 楼主昵称 / uid | 只做日志与去噪参考 |
| `replies` | 回复数 | 只做日志（辅助判断热度） |
| `postdate` / `lastpost` / `lastmodify` | 发帖 / 最后回复 / 最后编辑时间（**秒级时间戳**） | 不用 |
| `recommend` | 推荐数 | 不用 |
| `type` / `topic_misc` / `icon` / `quote_from` / `jdata` | 帖子类型位、版务标记、图标、引用、扩展数据 | `type` 用于识别版务/公告帖除外，其余不用 |
| `tpcurl` | 该帖的路径（`/read.php?tid=...`） | 不用（我们按 `tid` 自己拼） |

> **注意**：列表接口**只有标题，没有正文**。所以只看标题做判断会被提问帖/标题党带偏 ——
> 正文必须用接口二另外抓一次（这也是「抓正文」开关存在的意义）。

### 1.4 未登录 / Cookie 失效时返回什么

Cookie 不对时 NGA **不返回 4xx**，而是 `HTTP 200` 返回一个「拒客对象」，
且中文被 `\uXXXX` 转义过，所以**不能用中文关键字匹配**：

```json
{"data": [{"fid": 650, "denied": true, "error": "\u8bbf\u5ba2\u4e0d\u80fd\u76f4\u63a5\u8bbf\u95ee"}]}
```

判定顺序（脚本 `fetch_forum` 实际实现）：

1. `re.search(r'"denied"\s*:\s*true', text)` → `CookieExpired`（最可靠，先判它）；
2. HTML 数字实体兜底：出现连续 `&#NNNN;` 时，展开前 2 KB 再找「访客不能直接访问」；
3. 解析后若 `rows[0].denied` 为真 → 同样按 Cookie 失效处理；
4. 顶层或被包在 `data` 里的 `error` 字段非空 → 按 Cookie 失效处理并记进日志。

HTTP 状态码口径：`301/302/401/403/404/503` 统一视为「Cookie 失效 **或** 该版面本账号无权访问」
（两者都需要人工去面板改配置），记 `[COOKIE_EXPIRED]` 后**正常退出（退出码 0）**，
避免 cron 反复告警；其它 4xx/5xx 记普通抓取失败。

---

## 2. 接口二：帖子正文（主楼 + 回复都在同一份 HTML 里）

### 2.1 请求

| 项 | 值 |
|---|---|
| 方法 | `GET` |
| URL | `https://bbs.nga.cn/read.php?tid=<tid>` |
| **不要**加 `__output=11` | 加了会走 CDN 缓存，可能拿到**被截断的残缺 JSON**（见 §3） |
| 分页 | 第 1 页 = 主楼 + 约 19 层回复；`&page=2` = 第 21 层起 |
| 必需头 | `Cookie`、`User-Agent`、`Accept: text/html,*/*`、`Referer` |
| 响应头 | `HTTP 200`、`Content-Type: text/html; charset=GBK`、`Server: nginx` |
| 编码 | 页面**响应头与 `<meta>` 都声明 GBK**（脚本按 `utf-8 → gbk → gb18030` 顺序尝试解码，UTF-8 失败即回落 GBK） |

### 2.2 楼层在 HTML 里的位置（★ 主楼与回复的标签名不同）

实测一份 40 KB 的帖子页里：`postrow=12`、`id='postcontentN'=12`、`id='postsubjectN'=12`。

```html
<!-- 主楼：<p> -->
<tr id='post1strow0' class='postrow row1'>
  <td class='c2' id='postcontainer0'><a id='pid878428466Anchor'></a><a name='l0'></a>
    <div class='postInfo' id='postInfo0'><span id='postdate0'>2026-08-12 15:38</span></div>
    <span id='postcontentandsubject0'>
      <h3 id='postsubject0'>[版务公告] 关于严打各类涉及“开盒”等违法行为的公告</h3><br/>
      <p id='postcontent0' class='postcontent ubbcode'>[size=130%]近期我们在版务巡查中发现…</p>
    </span>
  </td>
</tr>

<!-- 回复楼：<span>（★ 这里是历史上最大的坑） -->
<tr id='post1strow1' class='postrow row1'>
  <td class='c2' id='postcontainer1'><a id='pid878205359Anchor'></a><a name='l1'></a>
    <div class='postInfo' id='postInfo1'><span id='postdate1' title='reply time'>2026-08-12 16:39</span></div>
    <span id='postcontentandsubject1'>
      <h3 id='postsubject1'></h3><br/>
      <span id='postcontent1' class='postcontent ubbcode'>[s:ac:哭笑]好像是陕西哥的小号</span>
    </span>
    <div id='postsign1' class='x'></div>
  </td>
</tr>
```

| 元素 | 含义 |
|---|---|
| `<p id='postcontent0' class='postcontent ubbcode'>` | **主楼正文**（`<p>`） |
| `<span id='postcontentN' class='postcontent ubbcode'>`（N≥1） | **第 N 楼回复正文**（`<span>`，不是 `<p>`） |
| `<h3 id='postsubjectN'>` | 该层的小标题（回复层通常为空） |
| `<tr id='post1strowN' class='postrow row1'>` | 楼层容器（可用 `postrow` 计数核对楼层数） |
| `<td id='postcontainerN'>` | 正文所在单元格 |
| `<a name='lN'>` / `<a id='pidNNNAnchor'>` | 楼层号锚点 / 帖子 pid 锚点 |
| `<span id='postdateN'>` | 该层发表时间（服务器视角，形如 `2026-08-12 16:39`） |
| `<div id='postsignN'>` | 签名区（**不要抓**，是签名不是内容） |

抓取用的正则（同标签名开闭配对 + 前置断言，属性顺序无关）：

```python
RE_POST_CONTENT = re.compile(
    r"<(p|span|div|td)\b(?=[^>]*id='postcontent\d*')(?=[^>]*class='[^']*ubbcode)"
    r"[^>]*>(.*?)</\1>", re.S | re.I)
RE_POST_SUBJECT = re.compile(r"id='postsubject\d*'[^>]*>(.*?)</h[36]>", re.S | re.I)
```

> **坑（已修，2026-09-14）**：早期正则把结束标签写死成 `</p>`，
> 而回复楼用的是 `<span>`，导致一页明明 20 层、只摘得出 1 层（主楼），
> 「抓回帖」实际上从未生效。改成「同标签名配对」后同一页可摘出全部 20 层。
> 详见 `docs/PRICING.md` §14.6。

### 2.3 正文里的 BBCode 需要清洗

`content` 是**原始 BBCode**，直接丢给 AI 会掺进大量噪声：

| 形态 | 样例 | 处理 |
|---|---|---|
| 尺寸/颜色标签 | `[size=130%]…[/size]`、`[color=red]` | 非贪婪剥离 `\[/?[^\]]{1,24}?\]` |
| 带参数标签 | `[collapse=xxx]`、`[quote]` | `\[[^\]\[]{0,24}=[^\]\[]{0,60}\]` |
| 表情 | `[s:ac:哭笑]` | 同上（按标签剥掉） |
| 图片/附件 | `[img]./mon_202608/12/i2Q61-…webp[/img]` | 剥标签 + 去 `./mon_…` 附件名残渣 |
| 换行 | `<br/>` | 先替换成空格再剥 HTML 标签 |

清洗后每层截断到 **240 字**（`per_floor_chars`），每帖最多取 **8 层**（面板项 `nga_content_max_floors`）。

### 2.4 分页与楼层上限

- 第 1 页实测就是「主楼 + 约 19 层回复」（与 JSON 版里的 `__R__ROWS_PAGE = 20` 一致）；
- `&page=2` 实测返回第 21 层起（约 44 KB / 0.27 s / 16 层），**这才需要额外一次请求**；
- 因此「要不要分析回帖」在第 1 页范围内**不产生任何额外请求**，只影响送进 AI 的字数：
  1 层≈1248 tokens、8 层≈4259、20 层≈9383（详见 `docs/PRICING.md` §14.5）。

---

## 3. 同一份数据的 JSON 版（`read.php?tid=X&__output=11`）——能用，但不稳

> 直接看结论：**字节确实少 65%，但既不更快、也不更省 AI 成本，而且有 17% 概率拿到被截断的残缺数据。**
> 完整对比见 §3.1，取舍建议见 §3.2。

`read.php` 也可以要 JSON，结构比 HTML 干净得多，**但目前不作为数据源**：

```json
{
  "data": {
    "__CU": {...},  "__F": {"name": "原神", "custom_level": "..."},
    "__T": { "fid":650, "tid":47356329, "subject":"…", "replies":11, "postdate":1786520330,
             "locked":0, "recommend":10, "digest":0, "author":"PolygonPanda", "authorid":63146818,
             "post_misc_var": {"content_length":538, "attachs":[...]}, "…共 22 个字段" },
    "__R": [ 楼层对象, … ],                        // ★ 本页楼层（≤20 条）
    "__U": { "63146818": {作者对象}, … },           // 作者字典（按 uid）
    "__R__ROWS_PAGE": 20, "__ROWS": 12, "__PAGE": 1
  },
  "time": 1790175326
}
```

> **别把 `__R` 长度和 `__ROWS` 搞混**：`__R` 是**本页**返回的楼层（实测恒 ≤ `__R__ROWS_PAGE` = 20），
> `__ROWS` 是**整帖的总楼层数**。实测出现过 `__R`=20 / `__ROWS`=24 与 `__R`=20 / `__ROWS`=46
> 两种组合 —— 即「本页 20 层，这帖总共 24/46 层」，剩下的要用 `&page=2` 再取。

**楼层对象 `data.__R[i]` 字段（实测 20 个）**：

```json
{
  "pid": 878205359, "tid": 47356329, "fid": 650, "lou": 1,
  "authorid": 65242130, "subject": "", "postdate": "2026-08-12 16:39",
  "postdatetimestamp": 1786523993, "content": "[s:ac:哭笑]好像是陕西哥的小号",
  "content_length": 16, "type": 0, "score": 14, "score_2": 0, "recommend": 0,
  "follow": 0, "alterinfo": "", "from_client": "8 Android",
  "attachs": [], "hotreply_id": 0, "hotreply": null
}
```

**作者对象 `data.__U[uid]` 字段（实测 22 个）**：
`uid, username, nickname, avatar, credit, money, reputation, medal, groupid, memberid, honor,
yz, site, regdate, mute_time, postnum, rvrc, thisvisit, signature, bit_data, group_bit_buf, buffs`

### 3.1 到底哪个更省、更快？——12 帖逐项实测对比（2026-09-14）

同一批 12 个帖子，两路都按「最多 8 层、每层 240 字」摘出正文，逐项对比：

| 指标 | HTML 版（现用） | JSON 版 | 结论 |
|---|---|---|---|
| **线上字节/帖**（不加 gzip） | 34,957 B | 12,190 B | JSON 少 **65.1%** |
| **gzip 后字节/帖** | **9,678 B** | 3,502 B | JSON 少 63.8%；但 HTML 挂上 gzip 后已从现在省 72% |
| 12 帖/轮 下载量 | 419 KB → **116 KB**（gzip） | 146 KB → 42 KB | 一轮省下 300 KB 左右（两者都是零头） |
| 解析耗时（process_time） | 平均 **1.65 ms** | 平均 4.01 ms（剔除 2 次解析失败后 ≈2.3 ms） | 两者都在 2 ms 量级，而单帖请求本身要 **0.3 s** → 占比 <1%，可忽略 |
| 楼层数（8 层上限内） | 5.9 层/帖 | 5.0 层/帖 | JSON 因 2 帖解析失败而偏少 |
| 摘出的正文 | 247 字/帖 | 218 字/帖 | 同上 |
| **两路文本是否一致** | — | 解析成功的 10 帖 **逐字一致** | 数据质量无差异 |
| 提示词 tokens（12 帖合计） | 2,843 | 2,569（−9.6%） | ★ 见下方说明，**这不是省，是丢** |
| **稳定性（本批）** | **12/12 可用** | **10/12**（2 帖被 CDN 截断） | HTML 完胜 |
| 失败后能否靠参数绕过 | — | ❌ `rand=` 重试 5 次全部失败（含一次 138 字节错误响应） | 无解，只能回落 HTML |

**关于那 −9.6% 的 token「省下来」**：不是压缩带来的，而是**两帖 JSON 截断、回帖内容整段缺失**
（那两帖对提示词的贡献变成 0）。也就是说 JSON 的 token 优势 = **静默丢数据**。解析成功的 10 帖里，
两路喂给 AI 的文本完全一致 → **换数据源对 Gemini 成本毫无影响**。

**关于字节**：真正有效的省字节手段不是换 JSON，而是给现有 HTML 请求加
`Accept-Encoding: gzip, deflate` —— 实测 41.3 KB → **12.8 KB（省 69%）**、列表 21.8 KB → 约 6 KB，
比 JSON 的 65% 略好，而且**零稳定性风险**（脚本已具备解压能力，2026-09-14 已启用）。
换句话说：**JSON 唯一能省的字节，gzip 顺手就省掉了，还不用承担 17% 的截断率。**

### 3.2 那 JSON 版还有价值吗？有，但不是省成本

| JSON 的优势 | 说明 |
|---|---|
| 结构化字段 | `lou`（楼层号）、`postdate`、`authorid`、`content_length`、`attachs`。不用再写正则，也就不会再有「主楼 `<p>` / 回复 `<span>`」那类踩了半年的坑 |
| 每层 `score` / `recommend` | 楼层赞数、推荐数 —— 可作为「哪些回复更值得送进 AI」的质量信号（HTML 版拿不到） |
| `__U` 作者字典 | 可区分「同一个人刷楼」与「多人共识」，对判断情绪可信度有帮助 |

**要不要切？建议：暂时不切。** 如果将来要切，必须做齐两件事，否则会静默丢数据：

1. `json.loads` 失败 → 立刻回落 HTML 版重抓该帖（代价：那帖多一次请求）；
2. 校验 `len(__R)` 与 `__R__ROWS_PAGE`/`__ROWS` 是否自洽，并在日志里记下「JSON 截断，已回落」，
   让这种事在日志里看得见（截断的响应 HTTP 依然是 200，光看状态码发现不了）。

---

## 4. 试过但不能用的端点（避免后人再踩）

| 写法 | 实测结果 | 为什么不能用 |
|---|---|---|
| `POST https://bbs.nga.cn/forum.php`（带 fid） | 返回全站版面目录，每条都带 `error` | 那是「版面操作」接口，不是读帖接口；会被误判成 Cookie 失效 |
| `GET https://bbs.nga.cn/thread.php?tid=<tid>` | `HTTP 200`、约 43 KB，`postcontent` 出现 **0 次** | 这是跳转/落地页，不是楼层页 |
| `GET https://bbs.nga.cn/read.php?tid=<tid>&__output=11` | 见 §3：6 帖中 1 帖被 CDN 截断 | 静默丢数据，不可作为唯一数据源 |
| `GET https://bbs.nga.cn/read.php?tid=<tid>&_ff=-1` | `HTTP 404` | 参数不被接受 |
| `GET https://bbs.nga.cn/nuke.php?__lib=view_thread&__act=view&tid=<tid>&__output=11` | `HTTP 200` 但只有 **75 字节** | 空响应（该 lib 需要其它参数组合，未采用） |
| 不带 Cookie / 只带访客 Cookie | `HTTP 200` + `denied:true` 对象 | 拿不到任何数据，且中文被 `\u` 转义 |

---

## 5. 抓取节奏、体积与资源占用（实测）

| 项 | 数值 |
|---|---|
| 列表请求 | 每个版面 1 次；多版面 = 多次（当前 `fid=650,835` → 2 次） |
| 正文请求 | 每帖 1 次（`nga_content_max_threads` 默认 12 → 12 次） |
| 单帖正文耗时 | 约 **0.30 s**（列表约 0.5 s/版面） |
| 单帖下载量 | 明文约 35 KB → **gzip 后约 10 KB**（12 帖一轮约 116 KB） |
| 一轮合计 | 约 3.5 s 抓取（12 帖）+ 两次 Gemini 约 5 s ≈ 7 s |
| 磁盘 | **不落任何临时文件**；抓完立即只留摘出的纯文本（每帖约 1~2 KB） |
| 内存 | 脚本峰值 34.8 MB（`RLIMIT_AS` 上限 64 MB）；12 帖正文合计约 4.7 KB |
| 实际频率 | cron 每 5 分钟唤起，但 `nga_interval_minutes`（默认 180 分钟）才真跑一轮 |
| 超时 | `nga_request_timeout`（默认 15 s），超时即记失败、不重试 |
| **请求节奏** | **必须串行、别并行**：实测 40 秒内打约 30 个请求后，NGA 会短暂返回 `302`（跟随时成重定向环）或 138 字节错误页；等一会儿即恢复。脚本顺序抓 + 每帖约 0.3 s 的天然间隔正好在安全线内 |

---

## 6. 代码位置索引

| 关注点 | 位置 |
|---|---|
| 列表接口（含游客判定、错误码口径） | `server/scripts/nga_analysis.py` → `fetch_forum()` / `fetch_all_forums()` |
| Cookie 前置校验 | 同上 → `check_cookie()` |
| 正文接口（HTML + 楼层解析） | 同上 → `fetch_thread_text()` / `extract_thread_text()` |
| 逐帖补正文（受面板项控制） | 同上 → `enrich_posts_with_content()` |
| BBCode / 标签清洗 | 同上 → `clean_text()` |
| 楼层正则（p/span 配对） | 同上 → `RE_POST_CONTENT` / `RE_POST_SUBJECT` |
| 标题过滤（提问/公告帖） | 同上 → `select_posts()` / `looks_like_question()` |
| 面板里可调的相关项 | 控制面板 →「📡 市场情绪」组的 `nga_*` / `gemini_*` 项 |
| HTTP 客户端（gzip/deflate、4xx 不抛） | 同上 → `http_get()` / `_open()` / `decode()` |

---

## 7. 排查手册

| 症状 | 先看这里 |
|---|---|
| 日志 `[COOKIE_EXPIRED] 访客不能直接访问` | Cookie 过期或没登录：面板「市场情绪 → NGA Cookie」重新粘贴（须含 `ngaPassportUid` 与 `ngaPassportCid`） |
| 日志 `[COOKIE_EXPIRED] HTTP 403/404` | 账号对该版面无权限，或 `nga_forum_fid` 填错（650=原神主板、835=剑斗绮谭） |
| `正文=0/N帖` | 该批帖子正文都没抓到：先确认 `nga_fetch_content=1`、`nga_content_max_threads>0`，再看是否有超时 WARN |
| 摘要里楼层数比预期少 | `nga_content_max_floors` 设小了（1 = 只主楼）；或该帖确实只有 1 层 |
| 想确认「回复到底抓到没」 | 看日志「帖子正文补充完成：成功 N 帖，合计 X KB」：8 层约 4.7 KB，只抓主楼约 0.8 KB |
| 突然收到 `HTTP 302` / 十几字节的响应 | 大概率是**短时间请求太多**被限流（见 §5 请求节奏）：等 1~2 分钟再跑，别改成并行抓取 |
| 想知道「换 JSON 会不会更快」 | 见 §3.1：字节少 65%，但解析耗时同量级（2 ms）、token 完全相同，且有 17% 截断率 —— **别换** |
