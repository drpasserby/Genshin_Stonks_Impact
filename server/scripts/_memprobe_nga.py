#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内存占用探针（本地一次性验证，不部署）：估算 nga_analysis.py 一整轮的真实内存峰值。

做法：在子进程里设置 RLIMIT_AS（只影响该子进程），走一遍真实数据规模
      （150 个实体名 + 30 帖 × 200 字 + 模型回包），逐级收紧上限，
      看哪个上限下会 MemoryError —— 用反证法回答「64MB 够不够」。

用法（建议在目标服务器上跑一次，最有说服力）：
    python3 server/scripts/_memprobe_nga.py
Windows 上 RLIMIT_AS / /proc/self/status 不可用，只能拿到 Python 层堆峰值，仅供参考。
"""
import os
import subprocess
import sys
import tempfile

CHILD = r'''
import sys, json, os

LIMIT_MB = int(sys.argv[1])
HAVE_DEPS = sys.argv[2] == "yes"
try:
    import resource
    if LIMIT_MB < 100000:
        resource.setrlimit(resource.RLIMIT_AS, (LIMIT_MB * 1024 * 1024,) * 2)
except Exception as exc:
    print("  [rlimit 不可用: %r]" % (exc,))


def rss_mb():
    """Linux: /proc/self/status 的 VmHWM（历史峰值 RSS）。"""
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmHWM"):
                    return int(line.split()[1]) / 1024.0
    except OSError:
        pass
    try:
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:
        return -1.0


steps = []


def step(name):
    steps.append((name, rss_mb()))


try:
    import json, ssl, urllib.request, gzip, zlib, decimal, logging, time, re, datetime
    step("stdlib(urllib/ssl/json/logging)")

    if HAVE_DEPS:
        from dotenv import load_dotenv
        step("dotenv")
        import pymysql
        from pymysql.connections import Connection
        step("pymysql+pymysql.connections")
    else:
        step("dotenv/pymysql(本机未装，跳过)")

    # 真实数据规模：30 帖 × 200 字摘要 + 约 150 个实体名的白名单 + 模型回包
    names = ["角色%03d" % i for i in range(150)]
    posts = [("标题%d" % i, "内容" * 100) for i in range(30)]
    prompt = "".join(n + "、" for n in names) + "".join(a + b for a, b in posts)
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}, ensure_ascii=False).encode()
    step("payload(提示词 %.0fKB)" % (len(body) / 1024.0))

    resp = json.dumps({"candidates": [{"content": {"parts": [
        {"text": "[" + ",".join(
            '{"entity":"角色%03d","impact":0.5,"confidence":0.8,"summary":"理由"}' % i
            for i in range(10)) + "]"}]}}]}, ensure_ascii=False).encode()
    parsed = json.loads(resp)
    step("解析模型回包 %d 条" % len(parsed["candidates"][0]["content"]["parts"][0]["text"] and
                                   json.loads(parsed["candidates"][0]["content"]["parts"][0]["text"])))

    ctx = ssl.create_default_context()
    step("ssl.create_default_context()")

    for name, mb in steps:
        print("  %-34s VmHWM=%8.2fMB" % (name, mb))
    print("PEAK %.2f MB / LIMIT %s -> OK" % (rss_mb(), LIMIT_MB if LIMIT_MB < 100000 else "无限制"))
except MemoryError:
    print("PEAK-OVER: 在 %d MB 上限处 MemoryError" % LIMIT_MB)
    for name, mb in steps:
        print("  %-34s VmHWM=%8.2fMB" % (name, mb))
except Exception as exc:
    print("PEAK-OVER: %r at %d MB" % (exc, LIMIT_MB))
    for name, mb in steps:
        print("  %-34s VmHWM=%8.2fMB" % (name, mb))
'''

path = os.path.join(tempfile.gettempdir(), '_nga_memprobe_child.py')
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(CHILD)

try:
    import pymysql  # noqa: F401
    import dotenv   # noqa: F401
    have_deps = 'yes'
except ImportError:
    have_deps = 'no'
    print('提示：本机未装 pymysql/python-dotenv，本次只能测到标准库+数据负载部分\n')

for limit in (0, 32, 48, 64, 96):
    label = '无限制' if limit == 0 else '%d MB' % limit
    print('--- RLIMIT_AS = %s ---' % label)
    out = subprocess.run([sys.executable, path, str(limit or 100000), have_deps],
                         capture_output=True, text=True, encoding='utf-8', errors='replace')
    print((out.stdout or (out.stderr or '')[:400]).rstrip())
