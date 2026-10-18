# -*- coding: utf-8 -*-
"""内存泄漏压测的一键驱动。

为什么要整个塞进**一个**脚本里跑：常驻进程如果由某一条 shell 命令启动，
那条命令结束时整棵进程树会被收走，采样器就采不到东西了（踩过一次，
日志里只跑到第 18 个样本就没了）。所以「启动压测 + 采样 + 出图」必须在
同一个进程里一口气做完。

用法：
    python run-memtest.py [迭代次数] [采样秒数]
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = r'D:/Local AI/image/python_embeded/python.exe'   # 这个环境有 psutil / matplotlib
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')

iters = sys.argv[1] if len(sys.argv) > 1 else '1200'
secs = sys.argv[2] if len(sys.argv) > 2 else '190'

print('=== 1/3 启动压测（--stress %s）===' % iters)
subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
time.sleep(1.5)
env = dict(os.environ)
env['QS_DEBUG'] = '1'
proc = subprocess.Popen([EXE, '--no-elevate', '--stress', iters],
                        env=env, cwd=ROOT)
time.sleep(6)
if proc.poll() is not None:
    print('压测进程提前退出了，返回码', proc.returncode)
    sys.exit(1)
print('  运行中，pid =', proc.pid)

print('')
print('=== 2/3 采样（%s 秒，排除前 35 秒冷启动）===' % secs)
r = subprocess.run([PY, os.path.join(ROOT, 'tools', 'memtest.py'),
                    secs, '2', os.path.join(ROOT, 'tools', 'memtest.csv'),
                    '%s 次弹出/关闭（分隔线 + 自定义引擎 + 托盘暂停）' % iters, '35'],
                   capture_output=True, text=True, encoding='utf-8', errors='replace',
                   cwd=ROOT)
print(r.stdout)
if r.stderr.strip():
    print('[stderr]', r.stderr.strip()[-800:])

print('')
print('=== 3/3 出图 ===')
r2 = subprocess.run([PY, os.path.join(ROOT, 'tools', 'plot-mem.py'),
                     os.path.join(ROOT, 'tools', 'memtest.csv'),
                     os.path.join(ROOT, 'tools', '_ev-mem.png'),
                     'QuickSearch 内存泄漏压测（%s 次弹出/关闭）' % iters,
                     '35'],
                    capture_output=True, text=True, encoding='utf-8', errors='replace',
                    cwd=ROOT)
print(r2.stdout)
if r2.stderr.strip():
    print('[stderr]', r2.stderr.strip()[-800:])

# 采样结束就把压测进程收掉，别让它继续占着内存
proc.terminate()
try:
    proc.wait(timeout=8)
except Exception:
    proc.kill()
subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
print('')
print('压测进程已结束')
