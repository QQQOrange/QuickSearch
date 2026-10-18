# -*- coding: utf-8 -*-
"""「出现延迟」滑块实测（4 轮）。

每轮：改 config.json 的 delay_ms -> 重启程序 -> 拖两次 -> 量 松手~开始取词 的间隔。

判据：实测间隔 ≈ 设定的 delay_ms（容许 ±280ms，留给线程唤醒和钩子派发的抖动）。
      并且延迟过后横条必须真的弹出来（只延迟不弹等于功能坏了）。

用法：
    python run-delay-verify.py
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

TOL = 280  # ms


def read_cfg():
    if os.path.exists(CFG):
        try:
            return json.load(io.open(CFG, encoding='utf-8'))
        except Exception:
            pass
    return {}


def write_cfg(d):
    io.open(CFG, 'w', encoding='utf-8', newline='').write(
        json.dumps(d, ensure_ascii=False, indent=2))


def restart():
    subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
    time.sleep(1.5)
    env = dict(os.environ)
    env['QS_DEBUG'] = '1'
    env['QS_ALLOW_INJECTED'] = '1'
    subprocess.Popen([EXE, '--no-elevate'], env=env, cwd=ROOT,
                     creationflags=0x00000008)
    time.sleep(9)


TRACE = os.path.join(TOOLS, 'verify-delay.trace.txt')


def run_round():
    """跑一轮。

    ⚠ 实测踩到过：node 把结果写完以后**自己不退出**（单线程阻塞、CPU 几乎为 0），
    于是 python 在 subprocess.run 上干等 —— 白等了 7 分钟。所以这里加超时，
    超时就杀掉，结果改从 trace 文件里读（脚本是 appendFileSync 写的，
    写完就在盘上了，不依赖进程正常退出）。
    """
    io.open(LOG, 'w', encoding='utf-8').close()
    if os.path.exists(TRACE):
        os.remove(TRACE)
    out = ''
    try:
        r = subprocess.run([NODE, os.path.join(TOOLS, 'verify-delay.js')],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', cwd=TOOLS, timeout=120)
        out = (r.stdout or '') + (r.stderr or '')
    except subprocess.TimeoutExpired:
        print('  ! node 没有自己退出，已超时终止，改从 trace 文件读结果')
        subprocess.run(['taskkill', '/IM', 'node.exe', '/F'], capture_output=True)
        time.sleep(1)

    res = {}
    src = out
    if os.path.exists(TRACE):
        src = out + '\n' + io.open(TRACE, encoding='utf-8', errors='replace').read()
    for line in src.splitlines():
        if line.startswith('RESULT|'):
            k, _, v = line[len('RESULT|'):].partition('=')
            res[k.strip()] = v.strip()
    return res


ROUNDS = [0, 400, 1200, 3000]

orig = read_cfg()
orig_delay = orig.get('delay_ms')
orig_copy = dict(orig)

results = []
try:
    for want in ROUNDS:
        print('=' * 62)
        print('设定 delay_ms = %d' % want)
        d = read_cfg()
        d['delay_ms'] = want
        d['trigger_copy'] = False
        d['filter_mode'] = 'off'
        d['filter_list'] = []
        write_cfg(d)
        restart()
        res = run_round()
        print('  原始: %s' % res)

        try:
            deltas = json.loads(res.get('deltas', '[]'))
        except Exception:
            deltas = []
        shown = int(res.get('showBar', '-1'))
        okfg = res.get('foregroundOk', '')

        good = [x for x in deltas if isinstance(x, int)]
        problems = []
        if okfg != 'true':
            problems.append('窗口没抢到前台，本轮结论不可信')
        if len(good) != len(deltas) or not good:
            problems.append('有样本没量出来（deltas=%s）' % deltas)
        if shown < 1:
            problems.append('延迟过后横条没弹出来（show_bar=%d）' % shown)
        for x in good:
            if abs(x - want) > TOL:
                problems.append('实测 %dms 与设定 %dms 差了 %dms（容许 ±%d）'
                                % (x, want, abs(x - want), TOL))

        ok = not problems
        note = '实测间隔 = %s ms（设定 %d ms），横条弹了 %d 次' % (good, want, shown)
        results.append((ok, 'delay_ms = %d' % want, note, problems))
        print('  -> %s  %s' % ('[PASS]' if ok else '[FAIL]', note))
        for p in problems:
            print('       ! ' + p)
        print('')
finally:
    d = read_cfg()
    d['delay_ms'] = orig_delay
    d['trigger_copy'] = orig_copy.get('trigger_copy', False)
    write_cfg(d)
    subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
    print('（已还原 delay_ms = %s）' % orig_delay)

passed = sum(1 for r in results if r[0])
lines = ['「出现延迟」滑块实测', '']
for ok, title, note, problems in results:
    lines.append('%s  %s  |  %s' % ('PASS' if ok else 'FAIL', title, note))
    for p in problems:
        lines.append('        ! ' + p)
lines.append('')
lines.append('%d/%d passed' % (passed, len(results)))
text = '\n'.join(lines) + '\n'
io.open(os.path.join(TOOLS, 'verify-delay.result.txt'), 'w',
        encoding='utf-8', newline='').write(text)
print(text)
sys.exit(0 if passed == len(results) else 1)
