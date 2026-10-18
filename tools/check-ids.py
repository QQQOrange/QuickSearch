# -*- coding: utf-8 -*-
"""静态校验：扫描前端 JS 里引用的 DOM id，逐个确认在对应 HTML 里存在。

Tauri 的 WebView 里 `$(id)` 返回 null 后 `.checked` 会抛异常，直接把整段
初始化脚本打断 —— 现象是"设置面板一片空白/点了没反应"，但控制台在
WebView2 里默认看不见，排查很费劲。所以用构建前的静态检查把它挡掉。

覆盖：
  ui/settings.js  -> ui/settings.html
  ui/bar.js       -> ui/index.html
  ui/ocr.html     -> 自身（内联脚本）
  ui/region.html  -> 自身
  ui/iconedit.html -> 自身（内联脚本，#143 图标编辑器）
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def read(p):
    with io.open(p, 'r', encoding='utf-8') as f:
        return f.read()

def ids_in_html(text):
    return set(re.findall(r'\bid\s*=\s*"([^"]+)"', text))

def refs_in_js(text):
    """JS 里两种写法都要抓：$('x') / getElementById('x')"""
    s = set(re.findall(r"""\$\(\s*['"]([\w-]+)['"]\s*\)""", text))
    s |= set(re.findall(r"""getElementById\(\s*['"]([\w-]+)['"]\s*\)""", text))
    return s

# 白名单：这些 id 是 JS 动态造出来的，HTML 里本来就没有
DYNAMIC = {
    'tips', 'menu', 'allFilter', 'aiList', 'sec-bar', 'sec-all',
    # OCR 结果窗口的版式切换按钮：由 renderEngines() 在「确实有截图」时才
    # createElement 出来（没图就不该有这颗按钮），所以静态 HTML 里查不到。
    'btnLayout',
    # 「对照」开关：同样由 renderEngines() 动态造 —— 有截图才出现，
    # 而且它自己管着「截图显不显示」，所以也不能写死在 HTML 里。
    'btnCompare',
}

PAIRS = [
    ('ui/settings.js',  'ui/settings.html'),
    ('ui/bar.js',       'ui/index.html'),
    ('ui/glass.js',     'ui/index.html'),
]

fail = 0
for js_rel, html_rel in PAIRS:
    js_p = os.path.join(ROOT, js_rel)
    ht_p = os.path.join(ROOT, html_rel)
    if not os.path.exists(js_p) or not os.path.exists(ht_p):
        print('SKIP  ' + js_rel + ' （文件不存在）')
        continue
    js, ht = read(js_p), read(ht_p)
    have = ids_in_html(ht)
    want = refs_in_js(js)
    missing = sorted(x for x in want if x not in have and x not in DYNAMIC)
    print('== ' + js_rel + ' -> ' + html_rel + ' ==')
    print('   引用 id %d 个，HTML 里 %d 个' % (len(want), len(have)))
    if missing:
        fail += 1
        for m in missing:
            print('   FAIL  缺少 #' + m)
    else:
        print('   PASS  全部命中')

# 内联脚本页：region.html / ocr.html / iconedit.html 自己校验自己
for rel in ('ui/region.html', 'ui/ocr.html', 'ui/index.html', 'ui/iconedit.html'):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        continue
    t = read(p)
    have = ids_in_html(t)
    want = refs_in_js(t)
    missing = sorted(x for x in want if x not in have and x not in DYNAMIC)
    print('== ' + rel + '（内联自检）==')
    if missing:
        fail += 1
        for m in missing:
            print('   FAIL  缺少 #' + m)
    else:
        print('   PASS  %d 个引用全部命中' % len(want))

# 额外：SWITCHES/SEGS/SLIDERS/TEXTS 里出现的 id 必须都在 HTML 里
sp = os.path.join(ROOT, 'ui', 'settings.js')
if os.path.exists(sp):
    js = read(sp)
    ht = read(os.path.join(ROOT, 'ui', 'settings.html'))
    have = ids_in_html(ht)
    named = set()
    for block in ('SWITCHES', 'SEGS', 'SLIDERS', 'TEXTS'):
        m = re.search(r'const ' + block + r'\s*=\s*\[(.*?)\n\];', js, re.S)
        if not m:
            continue
        found = re.findall(r"""['"](s-[\w-]+|w-[\w-]+)['"]""", m.group(1))
        named |= set(found)
    miss = sorted(x for x in named if x not in have)
    print('== settings.js 控件清单 ==')
    print('   声明 %d 个控件 id' % len(named))
    if miss:
        fail += 1
        for x in miss:
            print('   FAIL  缺少 #' + x)
    else:
        print('   PASS  全部命中')

    # ---------- 反向检查：HTML 里的控件 id 有没有漏掉声明 ----------
    #
    # 这一条才是真正值钱的：`s-ocrEnable` 曾经只写在 HTML 里、没进 SWITCHES，
    # 于是那个开关在界面上能拨、拨了却什么都不发生 —— 正向检查（声明→HTML）
    # 抓不到这种漏，因为方向反了。
    MANUAL = {
        # 这两个不走通用清单，各自在别处手工绑事件
        's-filterList',   # 程序列表：多行文本域，单独处理
        's-filterMode',   # 在 SEGS 里
        # 自定义引擎表单：三个输入框由 submitCeForm / fillCeForm 直接读写，
        # 提交时机是「点添加按钮」或「按回车」，不是通用的 change 事件。
        'w-ceName', 'w-ceUrl', 'w-ceCat',
        # 快捷键引擎的组合键输入框同理：submitCeForm 直接读、fillCeForm 直接写，
        # 「录制…」按钮（btnCeRec）另外单独绑 pointerdown。
        'w-ceHotkey',
        # 自定义引擎的「搜索 / 打开」类型分段控件同理：bindCeKind 直接绑
        # click，选中值只跟着表单走、不进 config，所以不进 SEGS 清单。
        's-ceKind',
        # 外部软件的「打开 / 搜索」类型分段（#135）：同理 —— bindApKind
        # 直接绑 click，选中值随 submitAppForm 一起写库，不走通用清单。
        's-apKind',
        # 外部软件表单：两个输入框同理（submitAppForm / fillAppForm 直接读写）
        'w-apName', 'w-apUrl',
        # 预览舞台的「深色背景」开关：通用清单里的开关是「改一个配置项」的
        # 语义，而这两个纯粹是本地视图状态（不进 config、不落盘），所以在
        # applyPreviewStage / renderPreview 里单独绑。两个页面各一个（A/B）。
        's-previewDark', 's-previewDarkB',
        # 横条样式三分段 + 玻璃预设分段：走的不是「一个键一个值」的通用路线 ——
        # 前者点一次要写两个既有配置字段（barGlass / barBlur），后者一次写六个。
        # 各自在 bindBarStyle / bindGlassPreset 里手工绑 click。
        's-barStyle', 's-glassPreset',
        # 本地 OCR 环境检测卡片：renderOcrDep() 异步拉 ocr_env_check 后整块
        # 动态重绘的容器，内部按钮（一键安装/教程/重新检测）走 box 上的事件
        # 委托（data-act 分发），不进通用清单。
        'w-ocrDep',
    }
    declared = set()
    for block in ('SWITCHES', 'SEGS', 'SLIDERS', 'TEXTS'):
        m = re.search(r'const ' + block + r'\s*=\s*\[(.*?)\n\];', js, re.S)
        if m:
            declared |= set(re.findall(r"""['"](s-[\w-]+|w-[\w-]+)['"]""", m.group(1)))
    declared |= MANUAL
    html_ctrls = set(re.findall(r'\bid\s*=\s*"((?:s|w)-[\w-]+)"', ht))
    orphans = sorted(x for x in html_ctrls if x not in declared)
    print('== 反向检查：HTML 控件是否都接了线 ==')
    print('   HTML 里有 %d 个 s-/w- 控件，已声明 %d 个' % (len(html_ctrls), len(declared)))
    if orphans:
        fail += 1
        for x in orphans:
            print('   FAIL  #' + x + ' 在 HTML 里，但没有任何脚本读它 —— 界面上能改、改了不生效')
    else:
        print('   PASS  没有「摆设」控件')

    # 白名单不能用来「消音」：手工处理的 id 本身也必须真的在脚本里被引用过，
    # 否则白名单就退化成「把报错藏起来」的开关了。
    ghost = sorted(x for x in MANUAL if x not in js)
    print('== 反向检查：白名单自校验 ==')
    if ghost:
        fail += 1
        for x in ghost:
            print('   FAIL  #' + x + ' 被列进白名单，但脚本里根本没用到它')
    else:
        print('   PASS  白名单里的 %d 个 id 都在脚本里出现过' % len(MANUAL))

print('\n结论: ' + ('全部通过' if fail == 0 else ('%d 处失败' % fail)))
sys.exit(0 if fail == 0 else 1)
