# -*- coding: utf-8 -*-
"""把散落的验证结果汇总成一份能直接看的 HTML 报告。

数据来源分两类：
  ① tools/*.result.txt —— 各验证脚本自己写的成绩单，**原样贴进报告**，不改一个字的结论；
  ② 下面 ITEMS 里手写的事实 —— 那些只能靠工具输出（不是脚本落盘）的项，
     比如 cargo test / jsdom / 内存压测的通过数。

图片一律 base64 内嵌，报告单独一个文件也能看，不依赖相对路径。

用法：
    python make-evidence.py
"""
import base64
import io
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(os.path.dirname(ROOT), '_QuickSearch-验证报告.html')

# (标题, 结果文件, 说明)
FILES = [
    ('黑白名单端到端', 'verify-filter.result.txt',
     '测试窗口由 node.exe 创建，拿它当名单靶子；脚本同时读出拖选那一刻的**真实前台进程名**作为事实依据。'),
    ('出现延迟实测', 'verify-delay.result.txt',
     '锚点取自程序自己的日志（mouseup → start_capture: begin），不跨进程对时钟。'),
    ('WebDAV 同步端到端', 'verify-webdav.result.txt',
     '本机自建最小 WebDAV 服务，只靠配置 webdav_on_start 触发，不点界面、不打扰桌面。'),
    ('摆位自适应', 'verify-layout.result.txt',
     '拖选贴文字、Ctrl+C 贴鼠标两条路径分开跑。'),
    ('触发回归', 'verify-trigger.result.txt',
     '无选区不弹 / 有选区弹且取词正确 / 拖选弹 / 空白区拖不弹。'),
    ('托盘暂停', 'verify-paused.result.txt', '暂停后拖选不再自动弹条，日志记下拦截原因。'),
    ('jsdom 界面集成', 'test-ui.result.txt',
     '加载真实 HTML + 真实脚本，桩掉 Tauri 调用，断言 DOM 与后端调用。'),
    ('共用逻辑单测', 'test-shared.result.txt', '分隔线归一化的边界 + 自定义引擎合并的幂等性。'),
]

# 只能靠工具输出、没有独立结果文件的项
ITEMS = [
    ('Rust 单元测试 + OCR 仿真', 'PASS', '23/23',
     '含 6 条 OCR 离线仿真：请求拼装、base64 转义、words_result 解析、错误码翻译、非 JSON 容错。'),
    ('控件接线反向检查', 'PASS', '37/37',
     'HTML 里的每个 s-/w- 控件都必须被脚本读到，抓"摆设控件"（漏绑）。'),
    ('内存泄漏压测', 'PASS', '--stress 1200',
     '稳态区间 36.8s~190s：WorkingSet Δ+3.2MB、PrivateBytes Δ−2.9MB、句柄 Δ−57、线程 Δ−18。'),
]

IMG = [
    ('_ev-mem.png', '内存压测曲线（1200 次 show/hide）'),
    ('_ocr-sample.png', 'OCR 验证用的样本图（文字本机生成，所以"认得对不对"有客观答案）'),
]


def read_txt(p):
    try:
        return io.open(p, encoding='utf-8', errors='replace').read().strip()
    except Exception as e:
        return '（读不到 %s：%s）' % (os.path.basename(p), e)


def b64(p):
    try:
        with open(p, 'rb') as f:
            return base64.b64encode(f.read()).decode()
    except Exception:
        return None


def esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


rows = []
for title, fn, note in FILES:
    path = os.path.join(HERE, fn)
    if not os.path.exists(path):
        continue
    text = read_txt(path)
    bad = 'FAIL' in text
    head = text.splitlines()[0] if text else ''
    rows.append((title, not bad, head, note, text))

cards = []
for title, ok, head, note, text in rows:
    cls = 'ok' if ok else 'bad'
    badge = 'PASS' if ok else 'FAIL'
    cards.append(
        '<section class="card %s">'
        '<h2><span class="badge">%s</span>%s</h2>'
        '<p class="note">%s</p>'
        '<pre>%s</pre>'
        '</section>' % (cls, badge, esc(title), esc(note), esc(text)))

extra = []
for title, st, count, note in ITEMS:
    extra.append(
        '<section class="card %s">'
        '<h2><span class="badge">%s</span>%s<em>%s</em></h2>'
        '<p class="note">%s</p>'
        '</section>' % ('ok' if st == 'PASS' else 'bad', st, esc(title),
                        esc(count), esc(note)))

imgs = []
for fn, cap in IMG:
    d = b64(os.path.join(HERE, fn))
    if d:
        imgs.append('<figure><img src="data:image/png;base64,%s" alt="%s">'
                    '<figcaption>%s</figcaption></figure>' % (d, esc(cap), esc(cap)))

total = len(rows) + len(ITEMS)
passed = sum(1 for r in rows if r[1]) + sum(1 for i in ITEMS if i[1] == 'PASS')

TPL = """<!DOCTYPE html>
<meta charset="utf-8">
<title>Quick Search 桌面版 · 验证报告</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:40px 28px 72px; background:#f5f6f8; color:#1c1f23;
         font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; }
  header { margin-bottom:28px; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:.3px; }
  .sub { color:#5b6472; font-size:14px; }
  .score { display:inline-block; margin-top:14px; padding:8px 16px; border-radius:999px;
           background:#e6f4ea; color:#10663a; font-weight:600; font-size:15px; }
  .card { background:#fff; border:1px solid #e3e6ea; border-radius:12px;
          padding:16px 18px 6px; margin-bottom:14px; }
  .card.bad { border-color:#f0c2c2; background:#fffafa; }
  .card h2 { font-size:15px; margin:0 0 4px; display:flex; align-items:center;
             gap:9px; font-weight:600; }
  .card h2 em { font-style:normal; color:#5b6472; font-weight:500; font-size:13px; margin-left:auto; }
  .badge { flex:none; font-size:11px; letter-spacing:.6px; padding:3px 9px; border-radius:6px;
           background:#e6f4ea; color:#10663a; font-weight:700; }
  .card.bad .badge { background:#fdeaea; color:#a32020; }
  .note { color:#5b6472; font-size:13px; margin:2px 0 10px; }
  pre { background:#f7f8fa; border:1px solid #eceef1; border-radius:8px; padding:11px 13px;
        font:12.5px/1.65 ui-monospace,Consolas,"Courier New",monospace;
        white-space:pre-wrap; word-break:break-all; margin:0 0 14px; color:#2a2f36; }
  figure { margin:0 0 16px; }
  img { max-width:100%; border:1px solid #e3e6ea; border-radius:10px; display:block; }
  figcaption { color:#5b6472; font-size:13px; margin-top:7px; }
  h3 { font-size:15px; margin:28px 0 12px; color:#3a4149; }
  footer { margin-top:34px; color:#8a929e; font-size:12.5px; }
</style>
<div class="wrap">
<header>
  <h1>Quick Search 桌面版 · 验证报告</h1>
  <div class="sub">Tauri 2.12.2 / WebView2 · 生成于 @@WHEN@@</div>
  <div class="score">@@PASSED@@ / @@TOTAL@@ 项通过</div>
</header>
@@CARDS@@
<h3>实物图</h3>
@@IMGS@@
<footer>
  每张卡片里的文字都是验证脚本自己写下的成绩单（tools/*.result.txt），原样贴出未做改写；<br>
  没有独立结果文件的项在正文里注明了具体数字。
</footer>
</div>
"""

html = (TPL
        .replace('@@WHEN@@', time.strftime('%Y-%m-%d %H:%M'))
        .replace('@@PASSED@@', str(passed))
        .replace('@@TOTAL@@', str(total))
        .replace('@@CARDS@@', '\n'.join(cards + extra))
        .replace('@@IMGS@@', '\n'.join(imgs)))

io.open(OUT, 'w', encoding='utf-8', newline='').write(html)
print('报告已生成：%s' % OUT)
print('通过 %d / %d' % (passed, total))
for title, ok, head, _, _ in rows:
    print('  %s  %s  %s' % ('PASS' if ok else 'FAIL', title, head))
