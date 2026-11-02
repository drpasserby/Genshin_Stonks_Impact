#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地一次性维护：把自测脚本里的配置键名也统一成小写（与面板一致）。

    python server/scripts/_rename_cfg_keys.py --selftest
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = ['NGA_ANALYSIS_ENABLED', 'NGA_INTERVAL_MINUTES', 'NGA_FORUM_FID', 'NGA_MAX_POSTS',
        'NGA_REQUEST_TIMEOUT', 'GEMINI_MODEL', 'GEMINI_MAX_RETRIES',
        'GEMINI_TIMEOUT_SECONDS', 'GEMINI_API_KEY', 'NGA_COOKIE']
MAP = {k: k.lower() for k in KEYS}


def rename_text(src):
    total = 0
    for up, low in MAP.items():
        # 1) cfg['X'] / cfgf['X'] / gcfg['X'] / BASE 等下标访问
        for pat in (r"(\w+\[)'(%s)'(\])" % up, r"(\[)'(%s)'(\])" % up):
            src, n = re.subn(pat, lambda mm, low=low: mm.group(1) + "'" + low + "'" + mm.group(3), src)
            total += n
        # 2) dict(BASE, X='...') / update(X='...')
        src, n = re.subn(r"(%s)(=)" % up, low + r'\2', src)
        total += n
        # 3) 独立的字符串键（含 SQL 结果元组、日志断言）
        src, n = re.subn(r"'(%s)'(?=[,)\]])" % up, "'" + low + "'", src)
        total += n
    return src, total


def main():
    files = [os.path.join(HERE, 'nga_analysis.py')]
    if '--selftest' in sys.argv or len(sys.argv) == 1:
        files.append(os.path.join(HERE, '_selftest_nga_analysis.py'))
    for path in files:
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        src, total = rename_text(src)
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(src)
        left = sorted(set(re.findall(r'(?:NGA|GEMINI)_[A-Z_]{2,}', src)))
        print('%-34s 替换 %2d 处；残留大写键: %s'
              % (os.path.basename(path), total, left or '无'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
