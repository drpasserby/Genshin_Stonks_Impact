#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性迁移：把 .env / cookies.json 里的敏感配置搬进 system_settings，供控制面板管理。

做三件事（幂等，可重复执行）：
  1) .env 的 GEMINI_API_KEY  → system_settings.gemini_api_key
  2) cookies.json 的 cookie  → system_settings.nga_cookie
  3) 删除旧的大写键 NGA_* / GEMINI_*（值已在对应小写新键就位）

用法（服务器上，root）：
  /opt/teyvat-nga/venv/bin/python /opt/teyvat-nga/nga_panel_migrate.py

安全性：只打印长度与前缀，不打印密钥明文。
"""
import json
import os
import re
import sys

from dotenv import load_dotenv
import pymysql

ENV_FILE = '/etc/nga-analysis/.env'
COOKIE_FILE = '/etc/nga-analysis/cookies.json'
OLD_KEYS = ('NGA_FORUM_FID', 'NGA_MAX_POSTS', 'NGA_REQUEST_TIMEOUT',
            'GEMINI_MODEL', 'GEMINI_MAX_RETRIES', 'GEMINI_TIMEOUT_SECONDS')
# 旧键 → 新键（值需要搬迁的）
RENAME = {'NGA_FORUM_FID': 'nga_forum_fid', 'NGA_MAX_POSTS': 'nga_max_posts',
          'GEMINI_MODEL': 'gemini_model'}


def read_env_var(path, key):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(key + '='):
                    return line.split('=', 1)[1].strip()
    except OSError as exc:
        print('  ! 读取 %s 失败：%r' % (path, exc))
    return ''


def main():
    load_dotenv(ENV_FILE)
    conn = pymysql.connect(
        host=os.environ.get('DB_HOST', '127.0.0.1'),
        port=int(os.environ.get('DB_PORT', '3306')),
        user=os.environ.get('DB_USER', 'teyvat'),
        password=os.environ.get('DB_PASS', ''),
        database=os.environ.get('DB_NAME', 'teyvat_stock'),
        charset='utf8mb4', autocommit=True, init_command="SET time_zone = '+08:00'")

    with conn.cursor() as cur:
        cur.execute('SELECT s_key, s_value FROM system_settings')
        cur_values = dict(cur.fetchall())

        # ---- 1) 旧键值搬到新键 ----
        for old, new in RENAME.items():
            if old in cur_values and cur_values.get(old):
                cur.execute('UPDATE system_settings SET s_value=%s WHERE s_key=%s',
                            (cur_values[old], new))
                print('  · %s → %s（值 %s）' % (old, new, str(cur_values[old])[:40]))

        # ---- 2) .env 的 API Key ----
        api_key = (read_env_var(ENV_FILE, 'GEMINI_API_KEY')
                   or os.environ.get('GEMINI_API_KEY', '')).strip()
        if api_key and not cur_values.get('gemini_api_key'):
            cur.execute('UPDATE system_settings SET s_value=%s WHERE s_key=%s',
                        (api_key, 'gemini_api_key'))
            print('  · GEMINI_API_KEY → gemini_api_key（长度 %d，前缀 %s…）'
                  % (len(api_key), api_key[:6]))
        elif api_key:
            print('  · gemini_api_key 已有值，保留数据库里的（.env 里那份未覆盖）')
        else:
            print('  ! .env 里没有 GEMINI_API_KEY，需在控制面板手工填写')

        # ---- 3) cookies.json 的 Cookie ----
        cookie = ''
        try:
            with open(COOKIE_FILE, 'r', encoding='utf-8') as fh:
                cookie = str(json.load(fh).get('cookie') or '').strip()
        except Exception as exc:  # noqa: BLE001
            print('  ! 读取 %s 失败：%r' % (COOKIE_FILE, exc))
        if cookie and not cur_values.get('nga_cookie'):
            cur.execute('UPDATE system_settings SET s_value=%s WHERE s_key=%s',
                        (cookie, 'nga_cookie'))
            print('  · cookies.json → nga_cookie（长度 %d，含 passport=%s）'
                  % (len(cookie), 'yes' if re.search('ngaPassport(Uid|Cid)', cookie) else 'NO'))
        elif cookie:
            print('  · nga_cookie 已有值，保留数据库里的')
        else:
            print('  ! cookies.json 不可用，需在控制面板手工粘贴 Cookie')

        # ---- 4) 删旧键 ----
        cur.execute('DELETE FROM system_settings WHERE s_key IN (%s)'
                    % ','.join(['%s'] * len(OLD_KEYS)), OLD_KEYS)
        print('  · 已删除旧键 %d 个（删掉 %d 行）' % (len(OLD_KEYS), cur.rowcount))

        cur.execute("""SELECT s_key, IF(s_key IN ('gemini_api_key','nga_cookie'),
                                        IF(s_value='', '（空）', CONCAT('已配置(', LENGTH(s_value), ')')),
                                        s_value)
                         FROM system_settings
                        WHERE s_key LIKE 'nga\\_%' OR s_key LIKE 'gemini\\_%'
                        ORDER BY s_key""")
        print('\n  最终配置：')
        for k, v in cur.fetchall():
            print('    %-26s = %s' % (k, v))

    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
