# -*- coding: utf-8 -*-
"""摆位验证的一键驱动脚本（两轮）。

轮次说明见 tools/verify-layout.js 的注释：拖选与 Ctrl+C 两条路径在测试环境下
会互相干扰，必须分开跑 —— 靠配置里的「复制后弹条」开关把其中一条关掉。

用法：
    python run-layout-verify.py

会依次：
  ① 关掉 triggerCopy -> 重启程序 -> 跑 A/B/C（贴文字）
  ② 打开 triggerCopy -> 重启程序 -> 跑 D（贴鼠标）
"""
import io
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
TOOLS = os.path.join(ROOT, 'tools')
NODE = r'C:/Users/64381/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
CFG = os.path.join(os.environ['APPDATA'], 'QuickSearch', 'config.json')
LOG = os.path.join(os.environ['APPDATA'], 'QuickSearch', 'log.txt')


def set_cfg(key, value):
    """改配置里的某一项（其余原样保留）。

    ⚠ 存盘的键是**下划线风格**（`trigger_copy`），和前端看到的驼峰
    （`triggerCopy`）不是一回事 —— `config_view()` 负责把下划线转成驼峰给前端，
    而 `config::save()` 落盘时又转回去。这里直接写文件，必须用下划线版本，
    写成驼峰会被当成未知字段静默忽略（踩过一次：改了没效果还以为是功能坏了）。
    """
    d = {}
    if os.path.exists(CFG):
        try:
            d = json.load(io.open(CFG, encoding='utf-8'))
        except Exception:
            d = {}
    d[key] = value
    io.open(CFG, 'w', encoding='utf-8', newline='').write(
        json.dumps(d, ensure_ascii=False, indent=2))
    print('  配置: %s = %s' % (key, value))


def restart():
    subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'],
                   capture_output=True)
    time.sleep(1.5)
    env = dict(os.environ)
    env['QS_DEBUG'] = '1'
    env['QS_ALLOW_INJECTED'] = '1'
    subprocess.Popen([EXE, '--no-elevate'], env=env,
                     cwd=ROOT, creationflags=0x00000008)  # DETACHED_PROCESS
    time.sleep(8)


def clear_log():
    io.open(LOG, 'w', encoding='utf-8').close()


def run(mode):
    r = subprocess.run([NODE, os.path.join(TOOLS, 'verify-layout.js'), '--' + mode],
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', cwd=TOOLS)
    return r.stdout + r.stderr


print('=== 第 1 轮：拖选（贴文字）===')
set_cfg('trigger_copy', False)
restart()
clear_log()
print(run('text'))

print('')
print('=== 第 2 轮：Ctrl+C（贴鼠标）===')
set_cfg('trigger_copy', True)
restart()
clear_log()
print(run('mouse'))

print('')
print('结果文件：tools/verify-layout.result.txt（第 2 轮覆盖第 1 轮，')
print('          逐轮输出见上面的打印）')
