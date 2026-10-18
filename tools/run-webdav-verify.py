# -*- coding: utf-8 -*-
"""WebDAV 同步的端到端验证（5 轮对照）。

思路：不需要真实网盘账号 —— 在本机起一个最小 WebDAV 服务，然后让程序自己
去同步。走的是同一条真实代码路径（ureq 发 HTTP、Basic 认证、PUT/GET/HEAD、
Last-Modified 比新旧），不是把逻辑抄一遍来测。

触发方式是 config 里的 `webdav_on_start = true`：程序一启动就自己去同步，
所以整轮验证**不需要点界面、不需要模拟鼠标**，也就不会打扰用户。

5 轮：
  1 云端没有备份            -> 应当把本机配置推上去
  2 云端更新（时间去未来）  -> 应当下载并恢复到本机，且先留本地副本
  3 本机更新（云端时间去过去）-> 应当把本机配置推上去
  4 密码错                  -> 401，提示要能看懂，程序不许崩
  5 地址不可达              -> 「连不上」，程序不许崩

服务与驱动放在**同一个进程**里：以前吃过亏 —— 常驻的子进程会被上一条 shell
命令收尾时带走，日志/采样都断在半路。

用法：
    python run-webdav-verify.py
"""
import base64
import email.utils
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
TOOLS = os.path.join(ROOT, 'tools')
APPDATA = os.environ['APPDATA']
CFG = os.path.join(APPDATA, 'QuickSearch', 'config.json')
LOG = os.path.join(APPDATA, 'QuickSearch', 'log.txt')
SRVROOT = os.path.join(APPDATA, 'QuickSearch', '_wdsrv')

USER, PASS = 'qsuser', 'qspass'
PORT = 18080
BASE = 'http://127.0.0.1:%d/dav/' % PORT
FILE = 'quicksearch-backup.json'

# ---------------------------------------------------------------- 服务


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'QSWebDAV/1.0'

    def log_message(self, *a):
        pass

    # --- 工具 ---
    def _fs(self):
        p = self.path.split('?', 1)[0]
        p = p[len('/dav'):] if p.startswith('/dav') else p
        import urllib.parse
        p = urllib.parse.unquote(p)
        return os.path.join(SRVROOT, p.lstrip('/').replace('/', os.sep))

    def _send(self, code, body=b'', extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        for k, v in (extra or []):
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def _authed(self):
        want = 'Basic ' + base64.b64encode(('%s:%s' % (USER, PASS)).encode()).decode()
        if self.headers.get('Authorization', '') == want:
            return True
        self._send(401, b'auth required',
                   [('WWW-Authenticate', 'Basic realm="QS"')])
        return False

    def _lm(self, path):
        return email.utils.formatdate(os.path.getmtime(path), usegmt=True)

    # --- 方法 ---
    def do_MKCOL(self):
        if not self._authed():
            return
        d = self._fs()
        if os.path.isdir(d):
            return self._send(405)      # 已存在 —— 客户端本来就当成功处理
        try:
            os.makedirs(d, exist_ok=True)
            self._send(201)
        except Exception as e:
            self._send(500, str(e))

    def do_PUT(self):
        if not self._authed():
            return
        n = int(self.headers.get('Content-Length') or 0)
        data = self.rfile.read(n) if n else b''
        p = self._fs()
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.write(data)
            self.server.puts.append((p, len(data)))
            self._send(201)
        except Exception as e:
            self._send(500, str(e))

    def do_GET(self):
        if not self._authed():
            return
        p = self._fs()
        if not os.path.isfile(p):
            return self._send(404, b'not found')
        with open(p, 'rb') as f:
            data = f.read()
        self._send(200, data, [('Content-Type', 'application/json; charset=utf-8'),
                               ('Last-Modified', self._lm(p))])

    def do_HEAD(self):
        if not self._authed():
            return
        p = self._fs()
        if not os.path.isfile(p):
            return self._send(404)
        self._send(200, b'', [('Last-Modified', self._lm(p)),
                              ('Content-Length', str(os.path.getsize(p)))])

    def do_DELETE(self):
        if not self._authed():
            return
        p = self._fs()
        if os.path.isfile(p):
            os.remove(p)
            return self._send(204)
        self._send(404)

    def do_PROPFIND(self):
        if not self._authed():
            return
        self._send(501, b'PROPFIND not implemented')


class Srv(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.puts = []


# ---------------------------------------------------------------- 驱动


def read_cfg():
    try:
        return json.load(io.open(CFG, encoding='utf-8'))
    except Exception:
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
    time.sleep(11)


def fresh_log():
    io.open(LOG, 'w', encoding='utf-8').close()


def logtext():
    try:
        return io.open(LOG, encoding='utf-8', errors='replace').read()
    except Exception:
        return ''


def srv_file():
    return os.path.join(SRVROOT, FILE)


def read_remote():
    try:
        return mid_utf8(srv_file())
    except Exception:
        return None


def mid_utf8(p):
    return io.open(p, encoding='utf-8').read()


results = []
orig = read_cfg()
orig_wd = {k: orig.get(k) for k in
           ('webdav_url', 'webdav_user', 'webdav_pass', 'webdav_file',
            'webdav_on_start', 'webdav_on_exit')}
orig_delay = orig.get('delay_ms')

# ⚠ 备份的**不止** WebDAV 那几个字段。
#
#   第 2 步是「云端配置下载 → 恢复到本机」，云端那份 barList 只有
#   ['百度','Google']。恢复是真恢复，会把本机 bar_list 整个覆盖掉。
#   而这里原本只还原了 webdav_* 和 delay_ms —— 结果跑完一轮测试，
#   **用户自己的横条成员被永久改成了 2 个**，而且完全没提示。
#   （真机上就是这么发现的：拖拽测试找不到第 3 行，一查配置只剩 2 个引擎。）
#
#   配置包里能覆盖的字段全都要留底，不能靠"这个字段测试没动"来判断 ——
#   恢复动作是整体替换，指望它只碰某几个字段是不成立的。
#   底下 finally 里按这份名单逐个还原。
SYNCED_FIELDS = ('bar_list', 'custom_engines', 'overrides', 'url_overrides',
                 'filter_list', 'filter_mode', 'alpha', 'icon_size',
                 'icon_style', 'item_radius', 'bar_padding',
                 'sep_style', 'shadow', 'theme', 'trigger_select',
                 'trigger_copy', 'delay_ms', 'anchor_at_mouse',
                 'auto_elevate', 'auto_color', 'animations')
orig_sync = {k: orig.get(k) for k in SYNCED_FIELDS if k in orig}

srv = Srv(('127.0.0.1', PORT), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print('本地 WebDAV 服务已起：%s  账号 %s / %s' % (BASE, USER, PASS))
print('')


def judge(title, checks):
    probs = [m for ok, m in checks if not ok]
    note = '；'.join(m for ok, m in checks if ok) or '（无阳性证据）'
    ok = not probs
    results.append((ok, title, note, probs))
    print('  -> %s  %s' % ('[PASS]' if ok else '[FAIL]', note))
    for p in probs:
        print('       ! ' + p)
    print('')


def base_cfg(on_start=True):
    d = read_cfg()
    d.update({
        'webdav_url': BASE, 'webdav_user': USER, 'webdav_pass': PASS,
        'webdav_file': FILE, 'webdav_on_start': on_start,
        'webdav_on_exit': False,
    })
    return d


try:
    # ---------- 1 云端没有备份 -> 上传 ----------
    print('=' * 62)
    print('1 云端没有备份 → 应当把本机配置推上去')
    shutil.rmtree(SRVROOT, ignore_errors=True)
    os.makedirs(SRVROOT, exist_ok=True)
    d = base_cfg()
    d['delay_ms'] = 222            # 本机一个可辨认的标记
    write_cfg(d)
    # ⚠ 顺序不能反：必须先清日志**再**启动程序。
    # 同步是在启动时做的，先启动后清空会把刚好要作证的那几行抹掉
    # （踩过一次：功能其实都成了，却因为日志是空的被判 FAIL）。
    fresh_log(); restart()
    t = logtext()
    up = '启动同步：已上传本机配置' in t
    got = read_remote()
    judge('1 云端无备份 → 上传本机配置', [
        (up, '日志记下了「启动同步：已上传本机配置」' if up else '日志里没有上传记录'),
        (got is not None, '服务端收到了文件' if got is not None else '服务端没收到任何 PUT'),
        (bool(got) and 'barList' in json.loads(got or '{}'),
         '上传内容是合法配置包（含 barList）' if got and 'barList' in json.loads(got) else
         '上传内容不像配置包'),
        (not 'PANIC' in t, '程序没崩' if 'PANIC' not in t else '日志里有 PANIC'),
    ])

    # ---------- 2 云端更新 -> 下载恢复 ----------
    print('=' * 62)
    print('2 云端更新（时间设到未来）→ 应当下载并恢复到本机')
    remote = {'version': 1, 'barList': ['百度', 'Google'], 'delayMs': 1777}
    io.open(srv_file(), 'w', encoding='utf-8', newline='').write(
        json.dumps(remote, ensure_ascii=False))
    future = time.time() + 3600
    os.utime(srv_file(), (future, future))
    stash = os.path.join(APPDATA, 'QuickSearch', 'config.before-webdav.json')
    if os.path.exists(stash):
        os.remove(stash)
    write_cfg(base_cfg())
    # ⚠ 顺序不能反：必须先清日志**再**启动程序。
    # 同步是在启动时做的，先启动后清空会把刚好要作证的那几行抹掉
    # （踩过一次：功能其实都成了，却因为日志是空的被判 FAIL）。
    fresh_log(); restart()
    t = logtext()
    local = read_cfg()
    down = '云端配置更新，已恢复到本机' in t
    judge('2 云端更新 → 下载并恢复', [
        (down, '日志记下了「云端配置更新，已恢复到本机」' if down else '日志里没有恢复记录'),
        (local.get('delay_ms') == 1777,
         '本机 delay_ms 已变成云端的 1777' if local.get('delay_ms') == 1777 else
         '本机 delay_ms 还是 %s，没被恢复' % local.get('delay_ms')),
        (os.path.exists(stash), '恢复前留了本地副本 config.before-webdav.json'
         if os.path.exists(stash) else '没有留本地副本，云端那份有问题就捞不回来了'),
        (not 'PANIC' in t, '程序没崩' if 'PANIC' not in t else '日志里有 PANIC'),
    ])

    # ---------- 3 本机更新 -> 上传 ----------
    print('=' * 62)
    print('3 本机更新（云端时间设到过去）→ 应当把本机配置推上去')
    past = time.time() - 3600
    os.utime(srv_file(), (past, past))
    d = base_cfg()
    d['delay_ms'] = 888
    write_cfg(d)
    # ⚠ 顺序不能反：必须先清日志**再**启动程序。
    # 同步是在启动时做的，先启动后清空会把刚好要作证的那几行抹掉
    # （踩过一次：功能其实都成了，却因为日志是空的被判 FAIL）。
    fresh_log(); restart()
    t = logtext()
    got = read_remote()
    up = '本机配置已同步到云端' in t
    rj = json.loads(got or '{}')
    judge('3 本机更新 → 上传覆盖云端', [
        (up, '日志记下了「本机配置已同步到云端」' if up else '日志里没有上传记录'),
        (rj.get('delayMs') == 888,
         '云端被更新成本机的 888' if rj.get('delayMs') == 888 else
         '云端还是 %s，没被覆盖' % rj.get('delayMs')),
        (not 'PANIC' in t, '程序没崩' if 'PANIC' not in t else '日志里有 PANIC'),
    ])

    # ---------- 4 密码错 -> 401 ----------
    print('=' * 62)
    print('4 密码错 → 应当明确提示账号密码不对')
    d = base_cfg()
    d['webdav_pass'] = 'wrong-password'
    write_cfg(d)
    # ⚠ 顺序不能反：必须先清日志**再**启动程序。
    # 同步是在启动时做的，先启动后清空会把刚好要作证的那几行抹掉
    # （踩过一次：功能其实都成了，却因为日志是空的被判 FAIL）。
    fresh_log(); restart()
    t = logtext()
    judge('4 密码错 → 401 提示可读', [
        ('启动同步失败' in t, '日志里有「启动同步失败」' if '启动同步失败' in t else '没有失败提示'),
        ('401' in t and ('账号或应用密码不对' in t or '密码' in t),
         '报错点明了是账号/密码问题' if '401' in t else '报错里没有 401'),
        ('=== start' in t, '程序正常启动完成' if '=== start' in t else '程序没起来'),
        (not 'PANIC' in t, '程序没崩' if 'PANIC' not in t else '日志里有 PANIC'),
    ])

    # ---------- 5 地址不可达 ----------
    print('=' * 62)
    print('5 地址不可达 → 应当提示连不上，且不影响启动')
    d = base_cfg()
    d['webdav_url'] = 'http://127.0.0.1:1/dav/'
    write_cfg(d)
    # ⚠ 顺序不能反：必须先清日志**再**启动程序。
    # 同步是在启动时做的，先启动后清空会把刚好要作证的那几行抹掉
    # （踩过一次：功能其实都成了，却因为日志是空的被判 FAIL）。
    fresh_log(); restart()
    t = logtext()
    judge('5 地址不可达 → 连不上', [
        ('连不上' in t, '提示了「连不上」' if '连不上' in t else '没有连不上提示'),
        ('=== start' in t, '程序正常启动完成' if '=== start' in t else '程序没起来'),
        (not 'PANIC' in t, '程序没崩' if 'PANIC' not in t else '日志里有 PANIC'),
    ])

finally:
    d = read_cfg()
    for k, v in orig_wd.items():
        if v is not None:
            d[k] = v
    # 还原**全部**会被云端配置包覆盖的字段（见上面 SYNCED_FIELDS 的说明）。
    # 原值是 None 的不还原：那说明用户本来就没这一项，写回 null 反而是往配置里
    # 塞垃圾，下次 serde 反序列化时可能当成"有值但是空"。
    for k, v in orig_sync.items():
        if v is not None:
            d[k] = v
    if orig_delay is not None:
        d['delay_ms'] = orig_delay
    write_cfg(d)
    subprocess.run(['taskkill', '/IM', 'QuickSearch.exe', '/F'], capture_output=True)
    srv.shutdown()
    shutil.rmtree(SRVROOT, ignore_errors=True)
    # 收尾自查：横条要是没还原回去，就大声报出来，不能悄悄把用户配置改了就跑。
    now = read_cfg()
    if orig.get('bar_list') and now.get('bar_list') != orig.get('bar_list'):
        print('❌ 横条没能还原！期望 %s，实际 %s'
              % (orig.get('bar_list'), now.get('bar_list')))
    else:
        print('（已还原 WebDAV 配置与横条并停掉本地服务）')

passed = sum(1 for r in results if r[0])
lines = ['WebDAV 同步端到端验证（本机模拟服务）', '']
for ok, title, note, probs in results:
    lines.append('%s  %s  |  %s' % ('PASS' if ok else 'FAIL', title, note))
    for p in probs:
        lines.append('        ! ' + p)
lines.append('')
lines.append('%d/%d passed' % (passed, len(results)))
text = '\n'.join(lines) + '\n'
io.open(os.path.join(TOOLS, 'verify-webdav.result.txt'), 'w',
        encoding='utf-8', newline='').write(text)
print(text)
sys.exit(0 if passed == len(results) else 1)
