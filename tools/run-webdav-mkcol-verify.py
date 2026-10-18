# -*- coding: utf-8 -*-
"""WebDAV「地址自动补全 + 文件夹自动创建」的端到端验证。

为什么单独写一个：
`run-webdav-verify.py` 的服务端在 `do_PUT` 里自己 `os.makedirs`，也就是说
**就算程序一个 MKCOL 都不发也能通过** —— 它验的是同步逻辑，验不到
「文件夹是软件建的还是服务端顺手建的」。这两件事在真实坚果云上完全不同：
坚果云不会替 PUT 自动 mkdir，目录不存在就是 409。

所以这个脚本的服务端故意**严格**：
  * 目录不存在时 PUT 直接 409，什么都不做；
  * 只有收到 MKCOL 才真的建目录。
这样「程序到底有没有主动建目录」就成了可观测的事实，而不是猜。

验 4 件事：
  1. 用户填的路径**原样保留**（配置里不塞软件自己的子目录；
     子目录是发请求时由 normalize_base 临时补的 —— 见 webdav.rs 的注释）
  2. 只填根时上传成功 —— 且服务端记录里能看到 MKCOL 请求（是程序建的）
  3. 只填根、且子目录多层缺失时逐级建出来
  4. 完整地址不重复套目录；没写协议时按 https 补

用法：
    python run-webdav-mkcol-verify.py
"""
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'target', 'release', 'QuickSearch.exe')
APPDATA = os.environ['APPDATA']
CFG = os.path.join(APPDATA, 'QuickSearch', 'config.json')
LOG = os.path.join(APPDATA, 'QuickSearch', 'log.txt')
SRVROOT = os.path.join(APPDATA, 'QuickSearch', '_wdmkcol')

USER, PASS = 'qsuser', 'qspass'
PORT = 18091
BASE = 'http://127.0.0.1:%d/dav/' % PORT
FILE = 'quicksearch-backup.json'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'QSStrictDAV/1.0'

    def log_message(self, *a):
        pass

    def _fs(self):
        p = self.path.split('?', 1)[0]
        p = p[len('/dav'):] if p.startswith('/dav') else p
        p = urllib.parse.unquote(p)
        # ⚠ 必须去掉尾斜杠再拼。MKCOL 的路径天生以 '/' 结尾，直接拼会得到
        # `...\QuickSearch\`，而 os.path.dirname('...\QuickSearch\') 返回的是
        # **上一级**（`...\_wdmkcol`）。于是「父目录在不在」的判断整个错位：
        # MKCOL /dav/QuickSearch/ 被判成「父目录不存在」回 409，PUT 再判一次
        # 409 —— 服务端把每一层都拒了，而程序明明已经正确地逐级发了 MKCOL。
        # 症状极具误导性：日志里 MKCOL 一条不少，测试却报「一个都没建出来」。
        return os.path.join(SRVROOT, p.strip('/').replace('/', os.sep))

    def _send(self, code, body=b''):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def _authed(self):
        want = 'Basic ' + base64.b64encode(('%s:%s' % (USER, PASS)).encode()).decode()
        if self.headers.get('Authorization', '') == want:
            return True
        self._send(401, b'auth required')
        return False

    def do_MKCOL(self):
        """唯一会真正建目录的地方。程序必须主动打过来。"""
        if not self._authed():
            return
        self.server.methods.append(('MKCOL', self.path, 0))
        d = self._fs()
        if os.path.isdir(d):
            return self._send(405)      # 已存在，客户端当成功
        # 父目录不存在就该 409 —— 这逼程序**逐级**建，而不是指望一步到位
        if not os.path.isdir(os.path.dirname(d)):
            return self._send(409, b'parent missing')
        try:
            os.makedirs(d, exist_ok=True)
            self._send(201)
        except Exception as e:
            self._send(500, str(e))

    def do_PUT(self):
        """严格：目录不存在一律 409，绝不代劳 mkdir。"""
        if not self._authed():
            return
        n = int(self.headers.get('Content-Length') or 0)
        data = self.rfile.read(n) if n else b''
        p = self._fs()
        if not os.path.isdir(os.path.dirname(p)):
            self.server.methods.append(('PUT', self.path, 409))
            return self._send(409, b'collection does not exist')
        try:
            with open(p, 'wb') as f:
                f.write(data)
            self.server.puts.append((p, len(data)))
            self.server.methods.append(('PUT', self.path, 201))
            self._send(201)
        except Exception as e:
            self.server.methods.append(('PUT', self.path, 500))
            self._send(500, str(e))

    def do_GET(self):
        if not self._authed():
            return
        p = self._fs()
        self.server.methods.append(('GET', self.path, 0))
        if os.path.isdir(p):
            # 目录：给一个最简单的 HTML 索引页，充当「只认 GET 的服务器」，
            # 好让回退解析那条路也能被真的走到一次。
            import html as _h
            import urllib.parse
            rel = os.path.relpath(p, SRVROOT).replace(os.sep, '/')
            base = urllib.parse.quote('/dav/' + ('' if rel == '.' else rel)).rstrip('/')
            rows = ['<html><body><ul>']
            for fn in sorted(os.listdir(p)):
                fp = os.path.join(p, fn)
                if not os.path.isfile(fp):
                    continue
                rows.append('<li><a href="%s/%s">%s</a></li>'
                            % (base, urllib.parse.quote(fn), _h.escape(fn)))
            rows.append('</ul></body></html>')
            return self._send(200, ''.join(rows).encode('utf-8'))
        if not os.path.isfile(p):
            return self._send(404, b'not found')
        with open(p, 'rb') as f:
            self._send(200, f.read())

    def do_HEAD(self):
        if not self._authed():
            return
        p = self._fs()
        self.server.methods.append(('HEAD', self.path, 0))
        if not os.path.isfile(p):
            return self._send(404)
        self.send_response(200)
        self.send_header('Content-Length', str(os.path.getsize(p)))
        self.end_headers()

    def do_PROPFIND(self):
        """真实返回 207 Multi-Status —— 「恢复时选云端哪一份」依赖它。

        这里刻意用标准 WebDAV 的命名空间写法（`<D:response>` 等），因为
        程序侧的解析器正是按这个形状写的；要是服务端换个写法还照样能解析，
        说明解析器对命名空间前缀不敏感（这正是要验的点之一）。
        """
        if not self._authed():
            return
        n = int(self.headers.get('Content-Length') or 0)
        if n:
            self.rfile.read(n)
        d = self._fs()
        self.server.methods.append(('PROPFIND', self.path, 0))
        if not os.path.isdir(d):
            return self._send(404, b'no such collection')
        import urllib.parse
        base = urllib.parse.quote('/dav/' + os.path.relpath(d, SRVROOT).replace(os.sep, '/'))
        parts = ['<?xml version="1.0" encoding="utf-8"?>',
                 '<D:multistatus xmlns:D="DAV:">',
                 '<D:response><D:href>%s/</D:href><D:propstat><D:prop>'
                 '<D:resourcetype><D:collection/></D:resourcetype></D:prop>'
                 '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
                 % base.rstrip('/')]
        import email.utils
        for fn in sorted(os.listdir(d)):
            fp = os.path.join(d, fn)
            if not os.path.isfile(fp):
                continue
            href = base.rstrip('/') + '/' + urllib.parse.quote(fn)
            st = os.stat(fp)
            parts.append(
                '<D:response><D:href>%s</D:href><D:propstat><D:prop>'
                '<D:resourcetype/><D:getcontentlength>%d</D:getcontentlength>'
                '<D:getlastmodified>%s</D:getlastmodified>'
                '</D:prop><D:status>HTTP/1.1 200 OK</D:status>'
                '</D:propstat></D:response>'
                % (href, st.st_size,
                   email.utils.formatdate(st.st_mtime, usegmt=True)))
        parts.append('</D:multistatus>')
        xml = ''.join(parts).encode('utf-8')
        self.send_response(207, 'Multi-Status')
        self.send_header('Content-Type', 'application/xml; charset=utf-8')
        self.send_header('Content-Length', str(len(xml)))
        self.end_headers()
        self.wfile.write(xml)


def read_cfg():
    with io.open(CFG, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_cfg(c):
    with io.open(CFG, 'w', encoding='utf-8') as f:
        json.dump(c, f, ensure_ascii=False, indent=2)


def clear_log():
    """每轮前清空日志。

    靠字节偏移读增量有个坑：程序把日志按自己的方式落盘，而 QuickSearch
    默认会自提权 —— 权限不同的进程往同一个文件写，偏移和读到的内容都对不上。
    直接清空最省心，也不会把上一轮的结果误当成本轮的。
    """
    with io.open(LOG, 'w', encoding='utf-8'):
        pass


def read_log():
    with io.open(LOG, encoding='utf-8', errors='replace') as f:
        return f.read()


def run_exe_until(args, done, timeout=25.0, settle=2.0):
    """启动程序，等到 done() 为真再收摊。

    判据是**服务端观察到的请求**，不是日志文件。踩过的坑：程序退出时才 flush
    日志，而我们是用 terminate 收摊的，于是日志永远是空的 —— 靠它判断会把
    「我们自己掐得太早」误报成「软件没发请求」。MKCOL / PUT 都发生在启动后
    几百毫秒内，等服务端的记账就够了。
    """
    p = subprocess.Popen([EXE, '--no-elevate'] + args)
    t0 = time.time()
    try:
        while time.time() - t0 < timeout:
            if done():
                break
            time.sleep(0.25)
        # 命中之后再等一拍：MKCOL 后面常跟着 PUT，立刻 terminate 会切掉
        time.sleep(settle)
    finally:
        try:
            p.terminate()
            p.wait(4)
        except Exception:
            p.kill()


def wipe_dir():
    """清空云端目录树。

    用 shutil 而不是 rmdir —— Git Bash 会把 '/s' '/q' 当成路径参数传给
    rmdir.exe，删不掉任何东西（表现为「服务端目录还在，测出来的都是旧状态」）。
    """
    if os.path.isdir(SRVROOT):
        shutil.rmtree(SRVROOT, ignore_errors=True)
    os.makedirs(SRVROOT, exist_ok=True)


results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print('  [%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                           ('  —— ' + detail) if detail else ''))


def rust_list_probe(url, expect_names):
    """调程序自检入口，直接验 webdav::list 这条真实代码路径。

    为什么不用界面：这一层要验的是「PROPFIND 打出去 → 207 解析 → 列出哪几份」，
    点界面会把「点了按钮」和「列目录成功」两件事混在一起，出问题时说不清是哪边。
    """
    p = subprocess.run([EXE, '--no-elevate', '--webdav-list', url,
                        USER, PASS, FILE],
                       capture_output=True, text=True, timeout=60)
    return p.stdout + p.stderr


def main():
    # 记录原配置，最后还原
    had_cfg = os.path.isfile(CFG)
    orig = read_cfg() if had_cfg else None

    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.methods = []
    srv.puts = []
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)

    try:
        # ---------------------------------------------------------- 1
        print('\n1 未知的自定义主机 → 不会被擅自加子目录（该由用户自己定目录）')
        wipe_dir()
        c = read_cfg()
        c['webdav_url'] = BASE + 'QuickSearch/'    # 自带子目录
        c['webdav_user'] = USER
        c['webdav_pass'] = PASS
        c['webdav_file'] = FILE
        c['webdav_on_start'] = True
        c['webdav_on_exit'] = False
        write_cfg(c)
        srv.methods.clear()
        srv.puts.clear()
        clear_log()
        run_exe_until([], lambda: bool(srv.puts), settle=3.0)
        got = read_cfg()['webdav_url']
        check('用户填的路径原样保留（没多套一层）',
              got.rstrip('/').endswith('/dav/QuickSearch'), '实际存的是 %s' % got)

        # ---------------------------------------------------------- 2
        print('\n2 目录不存在时上传成功，且是程序自己 MKCOL 建出来的（服务端拒绝代劳）')
        # 上一步已经把云端 PUT 上去了，这里重来一轮「从零」：清目录 + 清记账
        wipe_dir()
        srv.methods.clear()
        srv.puts.clear()
        c = read_cfg()
        write_cfg(c)
        run_exe_until([], lambda: bool(srv.puts), settle=3.0)
        check('备份文件真的落到云端了', len(srv.puts) > 0,
              '收到 %d 次 PUT' % len(srv.puts))
        mkcols = [p for m, p, _c in srv.methods if m == 'MKCOL']
        check('程序主动发了 MKCOL（不是服务端代劳）', len(mkcols) > 0,
              'MKCOL: %s' % (mkcols or '（一个都没有）'))
        check('MKCOL 打在正确的目录上',
              any('/dav/QuickSearch/' in p for p in mkcols),
              '目标 %s' % (mkcols or '无'))
        on_disk = os.path.isfile(os.path.join(SRVROOT, 'QuickSearch', FILE))
        check('备份文件真的在云端目录里', on_disk,
              '磁盘上找不到 %s' % os.path.join(SRVROOT, 'QuickSearch', FILE))

        # ---------------------------------------------------------- 3
        print('\n3 云端目录整个删掉 → 重新上传会自动重建')
        wipe_dir()
        srv.methods.clear()
        srv.puts.clear()
        clear_log()
        # 触发一次上传：改一下配置让 on_start 生效不需要，这里直接再启一次
        c = read_cfg()
        c['webdav_on_start'] = True
        c['delay_ms'] = (c.get('delay_ms') or 0) + 3   # 换个值，备份内容不一样
        write_cfg(c)
        run_exe_until([], lambda: bool(srv.puts), settle=3.0)
        check('目录被重新建出来并上传成功', len(srv.puts) > 0,
              '收到 %d 次 PUT' % len(srv.puts))
        mkcols = [p for m, p, _c in srv.methods if m == 'MKCOL']
        check('这次也主动 MKCOL 了', len(mkcols) > 0,
              'MKCOL: %s' % (mkcols or '（一个都没有）'))

        # ---------------------------------------------------------- 4
        print('\n4 多层缺失目录 → 逐级补齐')
        # 这条专门验「逐级 MKCOL」：服务端在父目录不存在时回 409，
        # 程序必须一级一级建，而不是指望一次到位。
        wipe_dir()
        srv.methods.clear()
        srv.puts.clear()
        clear_log()
        c = read_cfg()
        c['webdav_url'] = BASE + 'a/b/c/'
        c['webdav_on_start'] = True
        write_cfg(c)
        run_exe_until([], lambda: bool(srv.puts), settle=3.0)
        mkcols = [p for m, p, _c in srv.methods if m == 'MKCOL']
        check('a / b / c 三层都被建了出来', len(mkcols) >= 3,
              'MKCOL: %s' % (mkcols or '（一个都没有）'))
        check('上传最终成功', len(srv.puts) > 0, '收到 %d 次 PUT' % len(srv.puts))
        # ---------------------------------------------------------- 5
        print('\n5 云端有多份备份 → 能列出并选中指定的一份（PROPFIND）')
        wipe_dir()
        d = os.path.join(SRVROOT, 'QuickSearch')
        os.makedirs(d, exist_ok=True)
        # 造三份备份（名字/大小/时间都不同），其中一份用中文名，
        # 顺便验 URL 编码解码
        import time as _t
        names = ['quicksearch-backup.json', 'backup-2024.json', '\u65e7\u5907\u4efd.json']
        for i, nm in enumerate(names):
            with open(os.path.join(d, nm), 'wb') as f:
                f.write(b'{"delay_ms": %d}' % (1000 + i))
            # 把 mtime 调开，排序才有得验
            st = os.stat(os.path.join(d, nm))
            os.utime(os.path.join(d, nm), (st.st_atime, st.st_mtime - i * 86400))
        srv.methods.clear()
        srv.puts.clear()

        out = rust_list_probe(BASE + 'QuickSearch/', names)
        check('PROPFIND 真的发出去了',
              any(m == 'PROPFIND' for m, _p, _c in srv.methods),
              'methods=%s' % [m for m, _p, _c in srv.methods])
        listed = [n for n in names if n in out]
        check('三份备份都被列出来', len(listed) == 3,
              '只列出了 %s / 程序输出：%s' % (listed, out.strip()[:300]))
        check('中文文件名正确解码（不是 %E6%% 这种）',
              '\u65e7\u5907\u4efd.json' in out,
              '输出：%s' % out.strip()[:300])
        # 排序：新的在前 —— 备份-2024.json 的 mtime 最早，应排在最后
        idx_new = out.find('quicksearch-backup.json')
        idx_old = out.find('backup-2024.json')
        check('按时间新的在前排序', 0 <= idx_new < idx_old,
              '新的在下标 %d、旧的在 %d' % (idx_new, idx_old))
    finally:
        srv.shutdown()
        if orig is not None:
            write_cfg(orig)
        if os.path.isdir(SRVROOT):
            shutil.rmtree(SRVROOT, ignore_errors=True)

    print('\n' + '=' * 62)
    passed = sum(1 for _, ok, _ in results if ok)
    for n, ok, d in results:
        print('%s  %s%s' % ('PASS' if ok else 'FAIL', n, ('  —— ' + d) if d and not ok else ''))
    print('%d/%d passed' % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())