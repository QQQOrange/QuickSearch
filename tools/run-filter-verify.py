# -*- coding: utf-8 -*-
"""黑白名单端到端验证的一键驱动（5 轮对照）。

每一轮：改 config.json -> 杀掉并重启程序 -> 清空日志 -> 建窗口拖选一次 -> 收结论。

⚠ 两个必须注意的点：
  1. 存盘的键是**下划线风格**（filter_mode / filter_list / trigger_copy）。
     写成驼峰会被当未知字段静默忽略（踩过一次）。
  2. 程序启动时才读配置，没有热重载 —— 所以每轮都必须重启，不能只改文件。

5 轮场景：
  A 名单关闭             -> 必须弹      （证明拖选手法本身有效）
  B 黑名单命中 node.exe  -> 必须不弹    + 日志记「黑名单」
  C 黑名单里是别的程序   -> 必须弹      （负对照：名单非空但不命中不该拦）
  D 白名单命中 node.exe  -> 必须弹
  E 白名单里是别的程序   -> 必须不弹    + 日志记「白名单」

用法：
    python run-filter-verify.py
"""
import io
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
TOOLS = os.path.join(ROOT, 'tools')
NODE = r'C:/Users/64381/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
CFG = os.path.join(os.environ['APPDATA'], 'QuickSearch', 'config.json')
LOG = os.path.join(os.environ['APPDATA'], 'QuickSearch', 'log.txt')


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
                     creationflags=0x00000008)  # DETACHED_PROCESS
    time.sleep(9)


def run_round():
    io.open(LOG, 'w', encoding='utf-8').close()
    r = subprocess.run([NODE, os.path.join(TOOLS, 'verify-filter.js')],
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', cwd=TOOLS)
    out = (r.stdout or '') + (r.stderr or '')
    res = {}
    for line in out.splitlines():
        if line.startswith('RESULT|'):
            k, _, v = line[len('RESULT|'):].partition('=')
            res[k.strip()] = v.strip()
    return res


# 轮次定义：(标题, mode, list, 期望弹?, 期望日志关键词)
ROUNDS = [
    ('A 名单关闭（对照：拖选必须弹）', 'off', [], True, None),
    ('B 黑名单命中 node.exe', 'blacklist', ['node.exe'], False, '黑名单'),
    ('C 黑名单里是别的程序（负对照：必须弹）', 'blacklist', ['fake-not-real.exe'], True, None),
    ('D 白名单命中 node.exe', 'whitelist', ['node.exe'], True, None),
    ('E 白名单里是别的程序', 'whitelist', ['notepad.exe'], False, '白名单'),
]

orig = read_cfg()
saved = {'filter_mode': orig.get('filter_mode'), 'filter_list': orig.get('filter_list')}
orig_copy = dict(orig)

results = []
try:
    for title, mode, lst, want_show, want_kw in ROUNDS:
        print('=' * 62)
        print(title)
        d = read_cfg()
        d['filter_mode'] = mode
        d['filter_list'] = lst
        d['trigger_copy'] = False          # 只走拖选路径，避免与复制路径互相干扰
        write_cfg(d)
        print('  配置: filter_mode=%s  filter_list=%s' % (mode, lst))
        restart()
        res = run_round()
        print('  原始: %s' % res)

        show = int(res.get('showBar', '-1'))
        allfl = [x for x in res.get('filterLines', '').split(' ;; ') if x]
        fg = res.get('fgExe', '')
        okfg = res.get('foregroundOk', '')
        # 只认「针对本轮前台进程 node.exe」的那条拦截记录。
        # 验证期间可能另有程序（实测 msedge.exe）短暂占前台并被正确拦掉，
        # 那属于正确行为，不能拿来判本轮失败 —— 判据必须锚定 fg。
        mine = [x for x in allfl if fg and fg in x]

        problems = []
        if okfg != 'true':
            problems.append('窗口没抢到前台，本轮结论不可信')
        if fg != 'node.exe':
            problems.append('拖选那一刻前台是 %s 而不是 node.exe，名单比对对象不对' % fg)
        if want_show and show < 1:
            problems.append('应该弹但一次都没弹（show_bar=%d）' % show)
        if (not want_show) and show != 0:
            problems.append('应该被拦但还是弹了 %d 次' % show)
        if want_show and mine:
            problems.append('前台 %s 在名单内不该被拦，却被拦了：%s' % (fg, mine[0]))
        if want_kw:
            hit = [x for x in mine if want_kw in x]
            if not hit:
                problems.append('日志里没有针对 %s 的「%s」拦截记录（有：%s）'
                                % (fg, want_kw, allfl or '无'))

        ok = not problems
        extra = ('；另外顺便拦下了 %s' % '、'.join(
            sorted(set(x.split()[1] for x in allfl if fg not in x)))) \
            if (ok and len(allfl) > len(mine)) else ''
        note = (('弹了 %d 次' % show) if want_show
                else ('没弹，拦截记录：%s' % (mine[0] if mine else '无'))) + extra
        results.append((ok, title, note, problems))
        print('  -> %s  %s' % ('[PASS]' if ok else '[FAIL]', note))
        for p in problems:
            print('       ! ' + p)
        print('')
finally:
    # 无论如何把用户的名单原样还回去
    d = read_cfg()
    d['filter_mode'] = saved['filter_mode']
    d['filter_list'] = saved['filter_list']
    d['trigger_copy'] = orig_copy.get('trigger_copy', False)
    write_cfg(d)
    subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
    print('（已还原名单配置：filter_mode=%s filter_list=%s）' %
          (saved['filter_mode'], saved['filter_list']))

passed = sum(1 for r in results if r[0])
lines = []
lines.append('黑白名单端到端验证')
lines.append('')
for ok, title, note, problems in results:
    lines.append('%s  %s  |  %s' % ('PASS' if ok else 'FAIL', title, note))
    for p in problems:
        lines.append('        ! ' + p)
lines.append('')
lines.append('%d/%d passed' % (passed, len(results)))
text = '\n'.join(lines) + '\n'
io.open(os.path.join(TOOLS, 'verify-filter.result.txt'), 'w',
        encoding='utf-8', newline='').write(text)
print(text)
sys.exit(0 if passed == len(results) else 1)
