"""本地假 GitHub：验证 QuickSearch 的更新链路（发现新版 → 下载 → 校验 → 替换）。

为什么要这么测：真实 GitHub 上目前最新是 v1.1.1，而我们要验证的是
"远端比当前新"这条分支 —— 只能靠一个可控的假服务。它同时验证：
  · update::check 的两段式（302 拿 tag / API 拿详情）
  · 下载 + SHA256 校验
  · MoveFileExW 替换正在运行的 exe（先改名、再搬新的、旧版留 .old）

假服务要返回的最小形状：
  GET /releases/latest            → 302 Location: .../releases/tag/v9.9.9
  GET /api/releases/latest        → JSON: tag_name / body(含 SHA256) / assets
  GET /dl/QuickSearch.exe         → 一个"新版本"exe 的字节
"""
import http.server, json, os, socketserver, sys, threading

PORT = 8731
NEW_EXE = r'C:\Users\64381\Documents\deepseek-harness\default-workspace\qs_build\target\release\QuickSearch.exe'
SHA = open(r'C:\Users\64381\Documents\deepseek-harness\default-workspace\qs_build\new_exe.sha').read().strip()
SIZE = os.path.getsize(NEW_EXE)


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path.split('?')[0]
        # ⚠ 判断顺序要小心：`/api/repos/x/releases/latest` 也以 `/latest` 结尾，
        #   所以 API 那条必须**先**判（否则会被 302 分支吃掉，程序永远只拿到 tag）。
        if p.startswith('/api/') and p.endswith('/latest'):
            body = json.dumps({
                'tag_name': 'v9.9.9',
                'html_url': 'https://github.com/QQQOrange/QuickSearch/releases/tag/v9.9.9',
                'body': '## 这是一个测试版本\n\n- 第一行说明\n- 第二行说明\n\n'
                        f'SHA256: {SHA}\n',
                'assets': [{
                    'name': 'QuickSearch.exe',
                    'size': SIZE,
                    'browser_download_url': f'http://127.0.0.1:{PORT}/dl/QuickSearch.exe',
                }],
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p.endswith('/releases/latest'):
            # 302 → 带 tag 的 Location（程序从这里抠版本号）
            self.send_response(302)
            self.send_header('Location', 'https://github.com/QQQOrange/QuickSearch/releases/tag/v9.9.9')
            self.end_headers()
            return
        if p == '/dl/QuickSearch.exe':
            data = open(NEW_EXE, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    srv = Server(('127.0.0.1', PORT), H)
    print(f'fake github on {PORT}, serving exe {SIZE} bytes, sha {SHA[:16]}...', flush=True)
    srv.serve_forever()
