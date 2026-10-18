# -*- coding: utf-8 -*-
"""OCR 并行双引擎 真机端到端（run-ocr-parallel-e2e.py）

三个场景，全部用**临时 APPDATA**（不碰用户真实配置，也不靠真实目录里的状态）：

  A 有密钥 + 并行开（用户的真实配置就是这个形状）：
      两个引擎都该跑；结果窗里两段都该有；CDP 直接读 WebView2 里的
      文本框和 DOM 状态，【本地识别】/【百度云】标注、本地在上百度在下、
      段控该藏起来，都有客观答案；
      再点一次「重新识别」（CDP 按元素 id 点，不按坐标），该重跑一轮。
  B 无密钥 + 并行开：
      只跑本地，结果页挂一条「还没配…」提示；文本框只有本地一段；
      段控照样藏起来（并行模式两个结果常显，段控没有意义）。
  C 并行关（默认形状，回归用）：
      老路子单引擎出结果 —— 验证这次把 run_ocr 改成 4 元组、
      抽 store_engine_result 之后，非并行路径没被改坏；
      段控该正常显示（非并行模式切换引擎还要用）。

为什么走 CDP 而不是 UIA：QuickSearch 的窗口是 WebView2（Chromium），
启动时带 QS_T_WV_ARGS="… --remote-debugging-port=9333"（e2e 专用），
于是可以用 DevTools 协议直读页面 DOM / 点按钮 ——
比按坐标点按钮确定得多，比 UIA 可靠（WebView2 无障碍树个别环境不开）。

用法：
    python run-ocr-parallel-e2e.py
产物：
    ocr-parallel-e2e.result.txt   结论
    ocr-parallel.trace.txt        交互过程（node 写的）
    cdp-*.txt                     CDP 读到的页面状态
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
NODE = r'C:/Users/64381/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
CDP = os.path.join(HERE, 'ocr-cdp-check.js')
ACTIONS = os.path.join(HERE, 'ocr-parallel-actions.js')
TRACE = os.path.join(HERE, 'ocr-parallel.trace.txt')
RESULT = os.path.join(HERE, 'ocr-parallel-e2e.result.txt')
REAL_CONFIG = os.path.join(os.environ.get('APPDATA', ''), 'QuickSearch', 'config.json')
# e2e 专用的 WebView2 参数：必须是 DEFAULT_WV_ARGS 原样 + 远程调试端口
# （wry 的 additional_browser_args 会整体替换默认值，少一个特性窗口就可能起不来）
WV_ARGS = ('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
           ' --disable-gpu-sandbox --remote-debugging-port=9333')


def free_debug_port(port=9333):
    """把占着调试端口的进程精准杀掉（netstat 找 LISTENING 的 PID）。

    ⚠ 不能顺手 taskkill 所有 msedgewebview2.exe —— 用户机器上别的 WebView2
    应用（Outlook、WPS 之类）会被误杀。只杀监听这个端口的，端口是我们自己
    注入的，听它的只可能是本程序的 WebView2。
    """
    try:
        out = subprocess.run(['netstat', '-ano'], capture_output=True, timeout=30)
        txt = out.stdout.decode('utf-8', 'replace')
    except Exception:
        return
    pids = set()
    for line in txt.split('\n'):
        if (':' + str(port)) in line and 'LISTENING' in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                pid = int(parts[-1])
                if pid > 4:              # 0/4 是 System Idle / System 本体
                    pids.add(pid)
    for pid in pids:
        subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True)


def kill_all():
    # /T 连 WebView2 子进程一起收（QuickSearch 的窗口都跑在 msedgewebview2 里，
    # 只杀主进程的话调试端口会被子进程继续占着）
    subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/T', '/F'], capture_output=True)
    subprocess.run(['taskkill', '/IM', 'mspaint.exe', '/F'], capture_output=True)
    time.sleep(1)
    free_debug_port(9333)
    time.sleep(1)


def run_node():
    env = dict(os.environ)
    env['NODE_PATH'] = os.path.join(ROOT, 'node_modules')
    try:
        out = subprocess.run([NODE, ACTIONS], env=env, cwd=ROOT,
                             capture_output=True, timeout=240)
        return out.stdout.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired:
        return '!! 交互脚本超时'


def run_cdp(out_path, click='', after_ms=0):
    """跑 ocr-cdp-check.js，读页面状态；返回 (文件内容, 错误)。"""
    cmd = [NODE, CDP, out_path]
    if click:
        cmd += ['--click', click]
    if after_ms:
        cmd += ['--after-ms', str(after_ms)]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=150)
    except subprocess.TimeoutExpired:
        return None, 'CDP 脚本超时'
    try:
        return io.open(out_path, encoding='utf-8').read(), None
    except Exception as e:
        return None, str(e)


def parse_out(text):
    """把 CDP 脚本的输出拆成 dict；TEXT/NOTE_TEXT <<< 到 >>> 之间是多行文字。

    ⚠ 一律按「第一个空格」切键值，别用固定下标切（`l[16:]` 这种）——
       `TEXT_HAS_BAIDU` 前缀正好 15 字符，写成 `l[16:]` 会把值切没，
       于是「百度段明明在、断言却说没有」。踩过一次。
    """
    d = {'text': '', 'text_after': '', 'window': 'NONE', 'text_len': 0,
         'has_local': 0, 'has_baidu': 0, 'local_first': 0,
         'after_has_local': 0, 'after_has_baidu': 0, 'after_local_first': 0,
         'seg_hidden': 0, 'note_hidden': 0, 'note_text': '',
         'note_after_hidden': 0, 'note_after_text': '',
         'payload_note': '', 'payload_count': 0,
         'showseg_visible': 0, 'showmode_on': '',
         'both_has_local': 0, 'both_has_baidu': 0, 'both_len': 0,
         'baiduonly_has_local': 0, 'baiduonly_has_baidu': 0, 'baiduonly_len': 0,
         'baiduonly_toast': '',
         'localonly_has_local': 0, 'localonly_has_baidu': 0, 'localonly_len': 0,
         'clicked': 0, 'button': 'MISSING'}
    if not text:
        return d
    blocks = {'TEXT <<<': 'text', 'TEXT_AFTER <<<': 'text_after',
              'NOTE_TEXT <<<': 'note_text', 'NOTE_AFTER_TEXT <<<': 'note_after_text',
              'BAIDUONLY_TOAST <<<': 'baiduonly_toast'}
    lines = text.split('\n')
    i = 0
    while i < len(lines):
        l = lines[i].rstrip('\r')
        key = None
        for pre, k in blocks.items():
            if l.startswith(pre):
                key = k
                break
        if key:
            i += 1
            buf = []
            while i < len(lines) and not lines[i].startswith('>>>'):
                buf.append(lines[i].rstrip('\r'))
                i += 1
            d[key] = '\n'.join(buf)
        else:
            head, _, val = l.partition(' ')
            val = val.strip()
            if head == 'WINDOW':
                d['window'] = val
            elif head == 'TEXT_LEN':
                d['text_len'] = int(val or 0)
            elif head == 'TEXT_HAS_LOCAL':
                d['has_local'] = int(val or 0)
            elif head == 'TEXT_HAS_BAIDU':
                d['has_baidu'] = int(val or 0)
            elif head == 'TEXT_LOCAL_BEFORE_BAIDU':
                d['local_first'] = int(val or 0)
            elif head == 'TEXT_AFTER_HAS_LOCAL':
                d['after_has_local'] = int(val or 0)
            elif head == 'TEXT_AFTER_HAS_BAIDU':
                d['after_has_baidu'] = int(val or 0)
            elif head == 'TEXT_AFTER_LOCAL_FIRST':
                d['after_local_first'] = int(val or 0)
            elif head == 'SEG_HIDDEN':
                d['seg_hidden'] = int(val or 0)
            elif head == 'NOTE_HIDDEN':
                d['note_hidden'] = int(val or 0)
            elif head == 'NOTE_AFTER_HIDDEN':
                d['note_after_hidden'] = int(val or 0)
            elif head == 'PAYLOAD_NOTE':
                d['payload_note'] = val
            elif head == 'PAYLOAD_COUNT':
                d['payload_count'] = int(val or 0)
            elif head == 'SHOWSEG_VISIBLE':
                d['showseg_visible'] = int(val or 0)
            elif head == 'SHOWMODE_ON':
                d['showmode_on'] = val
            elif head == 'BOTH_HAS_LOCAL':
                d['both_has_local'] = int(val or 0)
            elif head == 'BOTH_HAS_BAIDU':
                d['both_has_baidu'] = int(val or 0)
            elif head == 'BOTH_LEN':
                d['both_len'] = int(val or 0)
            elif head == 'BAIDUONLY_HAS_LOCAL':
                d['baiduonly_has_local'] = int(val or 0)
            elif head == 'BAIDUONLY_HAS_BAIDU':
                d['baiduonly_has_baidu'] = int(val or 0)
            elif head == 'BAIDUONLY_LEN':
                d['baiduonly_len'] = int(val or 0)
            elif head == 'LOCALONLY_HAS_LOCAL':
                d['localonly_has_local'] = int(val or 0)
            elif head == 'LOCALONLY_HAS_BAIDU':
                d['localonly_has_baidu'] = int(val or 0)
            elif head == 'LOCALONLY_LEN':
                d['localonly_len'] = int(val or 0)
            elif head == 'BUTTON_CLICKED':
                d['clicked'] = int(val or 0)
            elif head == 'BUTTON':
                d['button'] = val
        i += 1
    return d


def seed_config(tmp, patch):
    """复制真实配置到临时 APPDATA，再按场景打补丁。"""
    qs = os.path.join(tmp, 'QuickSearch')
    os.makedirs(qs, exist_ok=True)
    with io.open(REAL_CONFIG, encoding='utf-8') as f:
        c = json.load(f)
    c.update(patch)
    with io.open(os.path.join(qs, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump(c, f, ensure_ascii=False, indent=1)
    return os.path.join(qs, 'log.txt')


def launch(tmp):
    env = dict(os.environ)
    env['APPDATA'] = tmp
    env['LOCALAPPDATA'] = env['APPDATA']
    # ⚠ Tauri 用 SHGetKnownFolderPath 取本地目录，**不看 LOCALAPPDATA 环境变量** ——
    #   两份实例会共用 WebView2 用户数据目录，新实例建不出 webview（0x8007139F）。
    #   必须用 WebView2 官方的这个环境变量才能真正隔离。
    env['WEBVIEW2_USER_DATA_FOLDER'] = os.path.join(env['APPDATA'], 'wv2')
    env['QS_DEBUG'] = '1'
    env['QS_ALLOW_INJECTED'] = '1'
    # e2e 专用：给 WebView2 开远程调试端口，CDP 才能直连页面
    env['QS_T_WV_ARGS'] = WV_ARGS
    return subprocess.Popen([EXE, '--no-elevate'], env=env, cwd=ROOT)


def one_scenario(idx, name, patch, checks):
    """跑一个场景，返回 (ok, 明细 list)。checks 是 (描述, fn(log, cdp, cdp2)) 列表。"""
    detail = []
    tmp = tempfile.mkdtemp(prefix='qs-ocrpar-')
    proc = None
    try:
        logp = seed_config(tmp, patch)
        kill_all()
        proc = launch(tmp)
        detail.append('已启动（pid=%s，APPDATA=%s）' % (proc.pid, tmp))
        time.sleep(9)                       # 等程序起来
        out = run_node()
        detail.append('--- 交互过程 ---')
        detail += [l for l in out.split('\n') if l.strip()]
        time.sleep(4)                       # 等推送落定 + 自检跑完

        cdp_txt, err = run_cdp(os.path.join(HERE, 'cdp-%d-1.txt' % idx))
        if err:
            detail.append('CDP 读取失败（不影响主体断言）：' + err)
        cdp = parse_out(cdp_txt)
        detail.append('CDP: window=%s text_len=%s has_local=%d has_baidu=%d'
                      ' local_first=%d seg_hidden=%d note_hidden=%d note=%r'
                      % (cdp['window'], cdp.get('text_len', len(cdp['text'])),
                         cdp['has_local'], cdp['has_baidu'], cdp['local_first'],
                         cdp['seg_hidden'], cdp['note_hidden'], cdp['note_text']))

        cdp2 = parse_out(None)
        if patch.get('ocr_parallel'):
            # 点「重新识别」：并行模式下该两个引擎重跑一轮（按元素 id 点，不按坐标）
            t2, err2 = run_cdp(os.path.join(HERE, 'cdp-%d-2.txt' % idx),
                               click='btnRerun', after_ms=12000)
            if err2:
                detail.append('CDP 点击失败（不影响主体断言）：' + err2)
            cdp2 = parse_out(t2)
            detail.append('CDP: button=%s clicked=%d text_after_len=%d'
                          ' after_local=%d after_baidu=%d after_local_first=%d'
                          ' note_after_hidden=%d note_after=%r'
                          ' payload_note=%s payload_count=%d'
                          % (cdp2['button'], cdp2['clicked'],
                             len(cdp2['text_after']), cdp2['after_has_local'],
                             cdp2['after_has_baidu'], cdp2['after_local_first'],
                             cdp2['note_after_hidden'],
                             cdp2['note_after_text'], cdp2['payload_note'],
                             cdp2['payload_count']))
            if cdp2['showseg_visible']:
                detail.append('CDP 三档切换：默认=%s  两者都看(%d 字: 本地=%d 百度=%d)'
                              '  仅百度(%d 字: 本地=%d 百度=%d 提示=%r)'
                              '  仅本地(%d 字: 本地=%d 百度=%d)'
                              % (cdp2['showmode_on'], cdp2['both_len'],
                                 cdp2['both_has_local'], cdp2['both_has_baidu'],
                                 cdp2['baiduonly_len'], cdp2['baiduonly_has_local'],
                                 cdp2['baiduonly_has_baidu'], cdp2['baiduonly_toast'],
                                 cdp2['localonly_len'], cdp2['localonly_has_local'],
                                 cdp2['localonly_has_baidu']))
            time.sleep(4)                   # 等第二轮识别的日志落盘

        log = ''
        try:
            log = io.open(logp, encoding='utf-8', errors='replace').read()
        except Exception as e:
            detail.append('日志读不到：%s' % e)

        # 整份日志落盘留证（断言挂了的时候，光看「没有 XX 行」没法知道后端
        # 到底走了哪条路）
        try:
            io.open(os.path.join(HERE, 'e2e-log-%d.txt' % idx), 'w',
                    encoding='utf-8').write(log)
        except Exception:
            pass

        # 把和 OCR 有关的日志行回显出来 —— 断言挂了的时候，光看「没有 XX 行」
        # 没法知道后端到底走了哪条路，这几行就是证据
        rel = [l.rstrip() for l in log.split('\n')
               if re.search(r'ocr|baidu|并行|截图', l, re.I)]
        if rel:
            detail.append('--- OCR 相关日志（%d 行，取最后 24 行）---' % len(rel))
            detail += rel[-24:]

        ok_all = True
        for desc, fn in checks:
            try:
                ok, why = fn(log, cdp, cdp2)
            except Exception as e:
                ok, why = False, '断言自己抛了异常：%s' % e
            ok_all = ok_all and ok
            detail.append(('PASS  ' if ok else 'FAIL  ') + desc +
                          ('' if ok else '  <-- ' + why))
        return ok_all, detail
    finally:
        if proc:
            proc.kill()
        time.sleep(1)
        kill_all()
        if os.environ.get('QS_E2E_KEEP'):
            detail.append('（QS_E2E_KEEP=1，临时目录保留在 %s）' % tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


def rx(pat):
    return re.compile(pat)


def ts_of(log, pat):
    """取日志里第一条匹配 `pat` 的行的 SystemTime（100ns 计数）。找不到返回 None。"""
    m = re.search(r'\[SystemTime \{ intervals: (\d+) \}\] [^\n]*' + pat, log)
    return int(m.group(1)) if m else None


def last_par_count(log, pat):
    """取日志里最后一条匹配的组 1（int）。"""
    ms = rx(pat).findall(log)
    return int(ms[-1]) if ms else None


def main():
    lines = []
    # 可选：只跑某个场景（按名字前缀过滤），调单个场景时省时间
    only = sys.argv[1].strip() if len(sys.argv) > 1 else ''
    kill_all()
    if not os.path.exists(REAL_CONFIG):
        lines.append('找不到真实配置 %s，没法造场景种子' % REAL_CONFIG)
        io.open(RESULT, 'w', encoding='utf-8').write('\n'.join(lines))
        print('\n'.join(lines))
        return 1

    real = json.load(io.open(REAL_CONFIG, encoding='utf-8'))
    lines.append('真实配置：ocr_engine=%s ocr_parallel=%s 密钥=%s'
                 % (real.get('ocr_engine'), real.get('ocr_parallel', '<缺失→false>'),
                    '有' if real.get('ocr_key') else '无'))

    def find_par(pat):
        def f(log, cdp, cdp2):
            m = rx(pat).search(log)
            if not m:
                return False, '日志里没有 ' + pat
            n = int(m.group(1))
            return (n > 0, '认出 %d 字' % n)
        return f

    def has_log(pat):
        def f(log, cdp, cdp2):
            return (bool(rx(pat).search(log)), '日志里没有 ' + pat)
        return f

    def not_log(pat):
        def f(log, cdp, cdp2):
            return (not rx(pat).search(log), '日志里居然有 ' + pat)
        return f

    def no_selftest_fail(log, cdp, cdp2):
        bad = [l for l in log.split('\n') if '[ocrselftest] FAIL' in l]
        return (not bad, '自检有 %d 条 FAIL：%s' % (len(bad), bad[:2]))

    def seg_hidden_is(want):
        """结果页的引擎段控：并行模式该藏（两个结果常显，段控没意义），
        非并行该在（用户还要靠它切引擎）。"""
        def f(log, cdp, cdp2):
            if cdp['window'] == 'NONE':
                return False, 'CDP 没连到结果页，读不到段控状态'
            return (cdp['seg_hidden'] == want,
                    'seg_hidden=%d，期望 %d' % (cdp['seg_hidden'], want))
        return f

    scenarios = []

    # ---- A：有密钥 + 并行开 ----
    def check_a(log, cdp, cdp2):
        # 组合断言：两个引擎都跑 + 总数对得上 + CDP 读到两段标注 + 段控藏着
        mw = rx(r'ocr: 并行 windows 认出 (\d+) 字').search(log)
        mb = rx(r'ocr: 并行 baidu 认出 (\d+) 字').search(log)
        if not (mw and mb):
            return False, '并行日志不全：windows=%s baidu=%s' % (bool(mw), bool(mb))
        nw, nb = int(mw.group(1)), int(mb.group(1))
        if nw <= 0 or nb <= 0:
            return False, '有引擎没认出字：windows=%d baidu=%d' % (nw, nb)
        # 渐进式：必须出现「先出」这一推（第一个引擎回来就开窗），
        # 最终字数取最后一次推送（补齐后的两段合计）
        if not rx(r'ocr: 并行先出 \d+ 字').search(log):
            return False, '没有「先出」推送 —— 又变成等两个引擎都完成才开窗了'
        nc = last_par_count(log, r'ocr: 并行(?:先出|补齐) (\d+) 字')
        if nc is None:
            return False, '日志里没有并行推送的字数'
        # 标注本身 15 字（【本地识别】\n + \n\n + 【百度云】\n），边界清理可能
        # 再差几个空格 —— 给个宽松但严格的窗口：必须明显大于两段之和，
        # 又不能大到可疑（防重复拼接）
        if not (nc >= nw + nb + 10 and nc <= nw + nb + 200):
            return False, '总字数 %d 和两段之和 %d+%d 对不上（标注没拼进去？）' % (nc, nw, nb)
        if cdp['window'] == 'NONE' or not cdp['text']:
            return False, 'CDP 没读到结果窗文字（window=%s）' % cdp['window']
        # ★ 渐进式：**第一次读**该只有本地那一段。注意单段视图是**不带标注**的
        #   （标注只在「两者都看」里出现），所以这里比字数而不是比标注：
        #   首屏字数应该≈日志里本地引擎认出的字数。
        if abs(cdp['text_len'] - nw) > 10:
            return False, ('开窗首屏该是本地那一段（本地 %d 字，实际 %d 字）'
                           % (nw, cdp['text_len']))
        if cdp['seg_hidden'] != 1:
            return False, '并行模式下引擎段控该藏起来（seg_hidden=%d）' % cdp['seg_hidden']
        if cdp['note_hidden'] != 1:
            return False, '有密钥不该弹提示条（note_hidden=%d, note=%r）' % (cdp['note_hidden'], cdp['note_text'])
        # ★ 三档显示切换（纯前端、不重新识别）
        if cdp2['showseg_visible'] != 1:
            return False, '并行模式下没看到「仅本地/仅百度/两者都看」三档切换'
        if cdp2['showmode_on'] != 'local':
            return False, ('默认该是「仅本地」（本地有字时），实际选中=%s' % cdp2['showmode_on'])
        # 两者都看：两段齐全、各带标注、本地在上
        if not (cdp2['both_has_local'] and cdp2['both_has_baidu']):
            return False, ('切到「两者都看」两段没齐：local=%d baidu=%d'
                           % (cdp2['both_has_local'], cdp2['both_has_baidu']))
        if abs(cdp2['both_len'] - (nw + nb + 15)) > 40:
            return False, ('两者都看字数不对：%d（期望约 %d+%d+15）'
                           % (cdp2['both_len'], nw, nb))
        # 仅百度：**不带标注**、字数≈百度那段、提示必须是「正在使用百度 OCR」
        if cdp2['baiduonly_has_local'] or cdp2['baiduonly_has_baidu']:
            return False, '「仅百度」不该带任何分段标注（单段视图就是纯文本）'
        if abs(cdp2['baiduonly_len'] - nb) > 10:
            return False, ('「仅百度」字数不对：%d（百度 %d 字）'
                           % (cdp2['baiduonly_len'], nb))
        if '正在使用百度' not in cdp2['baiduonly_toast']:
            return False, ('切到百度时的提示不对（该说「正在使用百度 OCR」而不是「重新…」）：%r'
                           % cdp2['baiduonly_toast'])
        # 仅本地：同样不带标注、字数≈本地那段
        if cdp2['localonly_has_local'] or cdp2['localonly_has_baidu']:
            return False, '「仅本地」不该带任何分段标注'
        if abs(cdp2['localonly_len'] - nw) > 10:
            return False, ('「仅本地」字数不对：%d（本地 %d 字）'
                           % (cdp2['localonly_len'], nw))
        # ★ 核心：窗口必须在**第二个引擎回来之前**就开出来（用户要的「立刻打开」）
        t_first = ts_of(log, r'ocr: 并行先出 \d+ 字')
        t_win = ts_of(log, r'ocr win: built')
        t_last = ts_of(log, r'ocr: 并行补齐 \d+ 字')
        if not (t_first and t_win and t_last):
            return False, ('时间戳取不全：先出=%s 开窗=%s 补齐=%s'
                           % (t_first, t_win, t_last))
        if not (t_first <= t_win < t_last):
            return False, ('开窗没有夹在两次推送之间（先出=%d 开窗=%d 补齐=%d）——'
                           '说明还是等最慢那个引擎完成才开窗' % (t_first, t_win, t_last))
        gap_ms = (t_last - t_win) / 10000.0
        if cdp2['clicked'] != 1:
            return False, '「重新识别」按钮没点成（button=%s）' % cdp2['button']
        # 点完之后该再跑一轮（两引擎各多一条日志）
        n2w = len(rx(r'ocr: 并行 windows 认出 \d+ 字').findall(log))
        n2b = len(rx(r'ocr: 并行 baidu 认出 \d+ 字').findall(log))
        if n2w < 2 or n2b < 2:
            return False, '点完「重新识别」没有重跑（windows×%d baidu×%d）' % (n2w, n2b)
        if 'rescan_ocr(parallel' not in log:
            return False, '没有走并行重新识别分支'
        # ★ 关掉结果窗要清空本轮识别数据（用户要求：OCR 缓存是临时的）
        if '结果窗已关闭' not in log or '已全部清空' not in log:
            return False, '关窗后没有看到「本轮识别数据已全部清空」的日志 —— 缓存没清'
        return True, ('windows=%d baidu=%d 最终=%d 字；开窗比最慢那个引擎早 %.0f ms；'
                      'CDP 两段标注齐全、本地在上、段控已藏' % (nw, nb, nc, gap_ms))
    scenarios.append(('A 有密钥 + 并行开（真实配置形状）',
                      {'ocr_parallel': True},
                      [('两引擎都跑、渐进推送（先出+补齐）、开窗早于最慢引擎、标注齐全、重识别生效', check_a),
                       ('并行模式段控该藏', seg_hidden_is(1)),
                       ('结果页自检没有 FAIL', no_selftest_fail)]))

    # ---- B：无密钥 + 并行开 ----
    def check_b(log, cdp, cdp2):
        mw = rx(r'ocr: 并行 windows 认出 (\d+) 字').search(log)
        if not mw:
            return False, '本地引擎没跑'
        if rx(r'ocr: 并行 baidu').search(log):
            return False, '没密钥居然还跑了百度'
        nc = last_par_count(log, r'ocr: 并行(?:先出|补齐) (\d+) 字')
        if nc is None:
            return False, '没有推送结果'
        nw = int(mw.group(1))
        if not (nc >= nw + 5 and nc <= nw + 60):
            return False, '只有本地一段时总数对不上：%d vs %d' % (nc, nw)
        # 默认「仅本地」视图：不带标注，字数≈本地那段
        if abs(cdp['text_len'] - nw) > 10:
            return False, ('首屏该是本地那一段（本地 %d 字，实际 %d 字）'
                           % (nw, cdp['text_len']))
        if cdp['window'] != 'NONE' and cdp['text']:
            # 首屏是「仅本地」单段视图 —— 单段视图按设计**不带标注**，
            # 这里只要求别混进百度段（标注有没有由「两者都看」那一档验）
            if cdp['has_baidu']:
                return False, '没密钥却有百度段'
        if cdp['window'] != 'NONE':
            if cdp['seg_hidden'] != 1:
                return False, '并行模式段控该藏（seg_hidden=%d）' % cdp['seg_hidden']
            if cdp['note_hidden'] != 0:
                return False, '没密钥该挂「还没配」提示条（note_hidden=%d）' % cdp['note_hidden']
            if '还没配' not in cdp['note_text']:
                return False, '提示条文字不对：%r' % cdp['note_text']
        return True, '只跑本地（%d 字），拼出来 %d 字，提示条=%r' % (nw, nc, cdp['note_text'])
    scenarios.append(('B 无密钥 + 并行开',
                      {'ocr_parallel': True, 'ocr_key': '', 'ocr_secret': ''},
                      [('只跑本地、不跑百度、只有本地一段', check_b),
                       ('并行模式段控该藏', seg_hidden_is(1)),
                       ('结果页自检没有 FAIL', no_selftest_fail)]))

    # ---- C：并行关（默认，回归） ----
    def check_c(log, cdp, cdp2):
        m = rx(r'ocr: got (\d+) chars via 本地识别').search(log)
        if not m:
            return False, '非并行路径没出结果（没有 "ocr: got N chars via 本地识别"）'
        if int(m.group(1)) <= 0:
            return False, '认出 0 字'
        if rx(r'ocr: 并行').search(log):
            return False, '并行关着却有并行日志'
        if cdp['window'] != 'NONE' and cdp['text']:
            if cdp['has_local'] or cdp['has_baidu']:
                return False, '非并行结果里不该有并行标注'
        if cdp['window'] != 'NONE' and cdp['seg_hidden'] != 0:
            return False, '非并行模式段控该显示（seg_hidden=%d）' % cdp['seg_hidden']
        if cdp['showseg_visible'] != 0:
            return False, '非并行模式不该出现「仅本地/仅百度/两者都看」三档（并行专用）'
        return True, '单引擎老路子照旧（%s 字）' % m.group(1)
    scenarios.append(('C 并行关（默认形状，回归）',
                      # ⚠ 必须**显式关掉**：真实配置现在可能被用户开了并行，
                      #   不写这一条的话「并行关」这个场景名不副实（踩过）
                      {'ocr_parallel': False},
                      [('单引擎路径没被重构改坏', check_c),
                       ('非并行模式段控该在', seg_hidden_is(0)),
                       ('结果页自检没有 FAIL', no_selftest_fail)]))

    all_ok = True
    idx = 0
    for name, patch, checks in scenarios:
        # 可选过滤：python run-ocr-parallel-e2e.py A 只跑场景 A（调试用）
        if only and not name.startswith(only):
            continue
        idx += 1
        lines.append('')
        lines.append('=' * 68)
        lines.append('场景 %s' % name)
        lines.append('=' * 68)
        ok, detail = one_scenario(idx, name, patch, checks)
        all_ok = all_ok and ok
        lines += detail
        lines.append('---- 场景结论：%s ----' % ('PASS' if ok else 'FAIL'))

    lines.append('')
    lines.append('#' * 68)
    lines.append('总结论：%s' % ('全部通过' if all_ok else '有失败，看上面明细'))
    lines.append('#' * 68)
    io.open(RESULT, 'w', encoding='utf-8').write('\n'.join(lines))
    print('\n'.join(lines))
    return 0 if all_ok else 2


if __name__ == '__main__':
    sys.exit(main())
