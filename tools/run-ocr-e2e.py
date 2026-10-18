# -*- coding: utf-8 -*-
"""OCR 真机端到端：启动 -> 交互 -> 收日志 -> 判结论，全在一个进程里做完。

⚠ 关键教训：QuickSearch.exe 由谁拉起，就得由谁陪着。
   实测父进程一退它就跟着没了（DETACHED_PROCESS 也挡不住），
   所以不能用「先 python 起一下、再 node 去戳」的两段式 ——
   那样 node 动的时候程序早没了，日志里什么都看不到，白忙一场。

用法：
    python run-ocr-e2e.py
"""
import io
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, 'tools')
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
NODE = r'C:/Users/64381/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
LOG = os.path.join(os.environ.get('APPDATA', ''), 'QuickSearch', 'log.txt')
TRACE = os.path.join(TOOLS, 'ocr-actions.trace.txt')


def kill_all():
    try:
        import psutil
        for p in psutil.process_iter(['name']):
            if p.info['name'] == 'QuickSearch.exe':
                try:
                    p.terminate()
                except Exception:
                    pass
    except ImportError:
        subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
    time.sleep(2)


def log_tail(n=400):
    try:
        s = io.open(LOG, encoding='utf-8', errors='replace').read()
        return s.split('\n')[-n:]
    except Exception:
        return []


def main():
    kill_all()
    # 记一下起点，后面只看新增的日志
    mark = len(io.open(LOG, encoding='utf-8', errors='replace').read()) \
        if os.path.exists(LOG) else 0

    env = dict(os.environ)
    env['QS_DEBUG'] = '1'
    # ⚠ 必须开这个：钩子默认会挡掉所有「被程序注入」的输入（防别的自动化工具
    #   一动鼠标就误弹横条）。自动化测试不走这个开关就什么都收不到 ——
    #   现象是"日志里干干净净、窗口纹丝不动"，很容易误判成钩子坏了。
    env['QS_ALLOW_INJECTED'] = '1'
    proc = subprocess.Popen([EXE, '--no-elevate'], env=env, cwd=ROOT)
    print('=== 已启动 %s（pid=%s）===' % (EXE, proc.pid))
    time.sleep(9)

    if os.path.exists(TRACE):
        os.remove(TRACE)

    print('=== 开始交互 ===')
    node_env = dict(os.environ)
    node_env['NODE_PATH'] = os.path.join(ROOT, 'node_modules')
    try:
        out = subprocess.run([NODE, os.path.join(TOOLS, 'ocr-actions.js')],
                             env=node_env, cwd=ROOT, capture_output=True, timeout=180)
        print(out.stdout.decode('utf-8', 'replace'))
        if out.stderr:
            print('[stderr]', out.stderr.decode('utf-8', 'replace')[:800])
    except subprocess.TimeoutExpired:
        print('!! 交互脚本超时')

    time.sleep(1)
    print('=== 交互结束时进程还活着吗：', proc.poll() is None, '===')
    fresh = []
    if os.path.exists(LOG):
        s = io.open(LOG, encoding='utf-8', errors='replace').read()
        fresh = s[mark:].split('\n')

    print('\n=== 新增日志（最后 60 行）===')
    print('\n'.join([l for l in fresh if l.strip()][-60:]) or '(没有)')

    # 收尾
    try:
        proc.terminate()
    except Exception:
        pass
    kill_all()

    # 判结论
    try:
        trace = io.open(TRACE, encoding='utf-8').read().split('\n')
    except Exception:
        trace = []
    ok = [l for l in trace if l.startswith('OK')]
    bad = [l for l in trace if l.startswith('NO')]
    print('\n=== 结论 ===')
    for l in bad:
        print('FAIL  ' + l[4:])
    print('%d/%d passed' % (len(ok), len(ok) + len(bad)))

    io.open(os.path.join(TOOLS, 'verify-ocr-e2e.result.txt'), 'w', encoding='utf-8').write(
        '\n'.join(trace) + '\n\n%d/%d passed\n' % (len(ok), len(ok) + len(bad)))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
