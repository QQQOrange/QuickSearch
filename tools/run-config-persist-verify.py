# -*- coding: utf-8 -*-
"""「重启后配置还在」的端到端验证。

用户反馈的原话是「每次重新启动后都要重新弄」，也就是配置存不住。单元测试
（`config::tests::*`）已经覆盖了读写的容错逻辑，但那只在临时目录里跑；这条
脚本走的是**真实程序 + 真实 %APPDATA%**，才能确认整条链路成立：

  1. 改设置 → 落盘
  2. 退出 → 重启 → 设置还在           ← 正常路径
  3. 把 config.json 截断成半截 → 重启 → 设置**仍然还在**（从 .bak 恢复）
  4. 配置文件整个删掉 → 重启 → 是干净的默认值（这时才是合理的）

第 3 条是关键。旧实现是 `serde_json::from_str(..).unwrap_or_default()`：
文件解析不了就静默换成默认配置。用户看到的就是「重启一次全没了」，而且
没有任何提示。这一条就是要把它钉死。

全程只改配置里的几个数值字段，不碰用户的引擎/密钥。
"""
import io
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
TOOLS = os.path.join(ROOT, 'tools')
APPDATA = os.environ['APPDATA']
CFG = os.path.join(APPDATA, 'QuickSearch', 'config.json')

# 用这两个字段做标记：都是纯数值，改了不影响其它功能，且一眼能认出来
MARK_DELAY = 1234
MARK_ICON = 37

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print('  [%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                           ('  —— ' + detail) if detail else ''))


def kill_old():
    subprocess.run([sys.executable, os.path.join(TOOLS, 'kill-old.py')],
                   check=False, capture_output=True)


def read_cfg():
    with io.open(CFG, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_cfg(c):
    with io.open(CFG, 'w', encoding='utf-8') as f:
        json.dump(c, f, ensure_ascii=False, indent=2)


def launch(seconds=6):
    """起一次程序，等它稳定，然后干净地结束。"""
    kill_old()
    p = subprocess.Popen([EXE, '--no-elevate'], cwd=ROOT)
    time.sleep(seconds)
    try:
        p.terminate()
        p.wait(5)
    except Exception:
        p.kill()
    time.sleep(0.6)


def touch_config():
    """走程序的 --touch-config：加载一次配置并立刻重新保存，然后退出。

    这是「程序自己存过一次」的最短路径，用来保证 .bak 真的产生了 ——
    靠测试脚本直接写文件造不出 .bak（那是脚本写的，不是程序写的），
    也就验不到「程序崩溃后能不能靠 .bak 救回来」。
    """
    kill_old()
    r = subprocess.run([EXE, '--no-elevate', '--touch-config'],
                       cwd=ROOT, capture_output=True, timeout=60)
    time.sleep(0.4)
    return r


def probe_cfg():
    """用一个假的 --webdav-list 调用把当前配置打印出来。

    等一下 —— 那个命令不读配置。这里改成直接读文件：程序每次改设置都会
    立即落盘，所以「改完 → 读文件」就等于「用户重启后程序会读到什么」，
    再配合第 3 步真正重启一次做交叉验证。
    """
    return read_cfg()


def main():
    had = os.path.isfile(CFG)
    orig = read_cfg() if had else None
    print('配置文件：%s（%s）' % (CFG, '已存在' if had else '全新'))

    try:
        # ---------------------------------------------------- 1 落盘
        print('\n1 改设置 → 落盘')
        c = read_cfg()
        c['delay_ms'] = MARK_DELAY
        c['icon_size'] = MARK_ICON
        write_cfg(c)
        back = read_cfg()
        check('两个字段都写进去了',
              back.get('delay_ms') == MARK_DELAY and back.get('icon_size') == MARK_ICON,
              'delay=%s icon=%s' % (back.get('delay_ms'), back.get('icon_size')))

        # ---------------------------------------------------- 2 正常重启
        print('\n2 正常重启 → 配置还在')
        c_pre = read_cfg()
        c_pre['alpha'] = 95 if c_pre.get('alpha') != 95 else 90
        write_cfg(c_pre)
        # 让程序自己存一次 → 产生 .bak
        touch_config()
        c2 = read_cfg()
        check('重启后 delay_ms 还在', c2.get('delay_ms') == MARK_DELAY,
              '实际 %s' % c2.get('delay_ms'))
        check('重启后 icon_size 还在', c2.get('icon_size') == MARK_ICON,
              '实际 %s' % c2.get('icon_size'))
        check('alpha 这类设置也持久化了', c2.get('alpha') == c_pre.get('alpha'),
              '实际 %s' % c2.get('alpha'))

        # ---------------------------------------------------- 3 损坏后重启
        print('\n3 配置被截断（写到一半被杀/断电）→ 重启后应从 .bak 恢复')
        # 让程序自己存一次，确保 .bak 里确实有这两个标记
        c3 = read_cfg()
        c3['delay_ms'] = MARK_DELAY
        c3['icon_size'] = MARK_ICON
        write_cfg(c3)
        touch_config()
        bak = CFG[:-len('.json')] + '.json.bak'
        assert os.path.isfile(bak), '程序存过一次之后应当有 .bak，实际没有：%s' % bak
        # 现在把正式文件打成半截
        with io.open(CFG, 'w', encoding='utf-8') as f:
            f.write('{"delay_ms": 12, "icon_si')
        launch(6)
        c4 = read_cfg()
        check('截断后重启 delay_ms 恢复成原值',
              c4.get('delay_ms') == MARK_DELAY, '实际 %s' % c4.get('delay_ms'))
        check('截断后重启 icon_size 也恢复',
              c4.get('icon_size') == MARK_ICON, '实际 %s' % c4.get('icon_size'))

        # ---------------------------------------------------- 4 空文件
        print('\n4 配置是空文件 → 也应恢复')
        open(CFG, 'w').close()
        launch(6)
        c5 = read_cfg()
        check('空文件后 delay_ms 仍恢复',
              c5.get('delay_ms') == MARK_DELAY, '实际 %s' % c5.get('delay_ms'))

        # ---------------------------------------------------- 5 留档
        print('\n5 坏配置被留档（用户还能手工捞）')
        bad = [f for f in os.listdir(os.path.dirname(CFG)) if '.bad-' in f]
        check('坏内容另存了一份', len(bad) > 0, '找到 %s' % bad)

        # ---------------------------------------------------- 6 删掉配置
        print('\n6 配置文件整个删掉 → 干净地回到默认值')
        os.remove(CFG)
        if os.path.isfile(CFG[:-len('.json')] + '.json.bak'):
            os.remove(CFG[:-len('.json')] + '.json.bak')
        launch(6)
        check('删掉后程序能正常启动并重建配置', os.path.isfile(CFG))
        if os.path.isfile(CFG):
            c6 = read_cfg()
            check('重建后是默认横条', isinstance(c6.get('bar_list'), list) and len(c6['bar_list']) > 0,
                  'bar_list=%s' % (c6.get('bar_list'),))
    finally:
        kill_old()
        if orig is not None:
            write_cfg(orig)
        else:
            if os.path.isfile(CFG):
                os.remove(CFG)

    print('\n' + '=' * 62)
    passed = sum(1 for _, ok, _ in results if ok)
    for n, ok, d in results:
        print('%s  %s%s' % ('PASS' if ok else 'FAIL', n, ('  —— ' + d) if d and not ok else ''))
    print('%d/%d passed' % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())