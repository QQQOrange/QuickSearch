# -*- coding: utf-8 -*-
"""交付前的冒烟：用**桌面那个 exe** 真启动一次，看能不能起来、有没有崩。

不是跑功能，只回答三个问题：文件能不能直接双击运行、会不会一启动就 panic、
托盘/后台线程有没有正常起来。

用法：
    python smoke-exe.py
"""
import io
import os
import subprocess
import sys
import time

EXE = os.path.join(os.environ.get('USERPROFILE', 'C:/Users/64381'), 'Desktop', 'QuickSearch.exe')
LOG = os.path.join(os.environ['APPDATA'], 'QuickSearch', 'log.txt')

if not os.path.exists(EXE):
    print('桌面上没有 %s' % EXE)
    sys.exit(1)

subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
time.sleep(1.5)
io.open(LOG, 'w', encoding='utf-8').close()

env = dict(os.environ)
env['QS_DEBUG'] = '1'
# 加 --no-elevate 是为了不弹 UAC 打扰用户；平时双击走的是默认（按设置提权）
subprocess.Popen([EXE, '--no-elevate'], env=env, creationflags=0x00000008)
time.sleep(9)

t = io.open(LOG, encoding='utf-8', errors='replace').read()
lines = t.splitlines()

started = any('=== start' in x for x in lines)
panicked = any('PANIC' in x for x in lines)
# ⚠ tasklist 的输出是 GBK，按 utf-8 解码会炸（踩过：UnicodeDecodeError byte 0xcf）；
#   而且 /FI 过滤器在这个环境里也取不到东西，所以直接全量列再找。
raw = subprocess.run(['tasklist'], capture_output=True).stdout
alive = raw.decode('utf-8', 'replace') if raw else ''
running = 'QuickSearch.exe' in alive

print('exe = %s' % EXE)
print('日志行数         = %d' % len(lines))
print('有启动标记       = %s' % started)
print('进程还在跑       = %s' % running)
print('有 PANIC         = %s' % panicked)
print('')
print('日志前 15 行：')
for x in lines[:15]:
    print('  ' + x)

ok = started and running and not panicked
print('')
print('[PASS] 桌面上的 exe 能正常启动且没崩' if ok else '[FAIL] 冒烟没过')

subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
sys.exit(0 if ok else 1)
