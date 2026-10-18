# -*- coding: utf-8 -*-
"""一次修好三处：
1. settings.html 的 OCR 页补上「启用文字识别」总开关行
2. settings.js 的 SWITCH_DEFAULT 补 ocrEnable
3. bindSwitches() 加空值保护 —— 以后任何一处 id 手误都不该炸掉整个面板
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def read(p):
    with io.open(p, 'r', encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

# ---------------- 1. settings.html ----------------
hp = os.path.join(ROOT, 'ui', 'settings.html')
h = read(hp)

if 's-ocrEnable' in h:
    print('html: 已存在 s-ocrEnable，跳过')
else:
    anchor = '''        <div class="row col">
            <div class="rt"><b>API Key</b><small>百度智能云 → 文字识别 → 应用列表</small></div>'''
    assert anchor in h, 'html 锚点没找到'
    add = '''        <div class="row">
            <div class="rt"><b>启用文字识别</b><small>关闭后横条上的 OCR 按钮、快捷键 Ctrl+Alt+O、托盘菜单项一并失效</small></div>
            <label class="sw"><input type="checkbox" id="s-ocrEnable"><i></i></label>
        </div>
'''
    h = h.replace(anchor, add + anchor, 1)
    write(hp, h)
    print('html: 已补 s-ocrEnable 开关行')

# ---------------- 2 & 3. settings.js ----------------
jp = os.path.join(ROOT, 'ui', 'settings.js')
j = read(jp)

# 2. SWITCH_DEFAULT
if 'ocrEnable:' in j:
    print('js: SWITCH_DEFAULT 已有 ocrEnable，跳过')
else:
    old = "    aiCopyPrompt: true,\n    webdavOnStart: false,"
    assert old in j, 'js SWITCH_DEFAULT 锚点没找到'
    j = j.replace(old, "    aiCopyPrompt: true,\n    ocrEnable: true,\n    webdavOnStart: false,", 1)
    print('js: SWITCH_DEFAULT 已补 ocrEnable')

# 3. bindSwitches 空值保护
old_sw = '''    for (const [id, key] of SWITCHES) {
        const el = $(id);
        el.checked = CONF[key] === undefined ? !!SWITCH_DEFAULT[key] : !!CONF[key];'''
new_sw = '''    for (const [id, key] of SWITCHES) {
        const el = $(id);
        // 少一个开关元素不该把整页绑定带崩：跳过去，控制台吱一声就够了。
        if (!el) {
            console.warn('[qs] 找不到开关元素 #' + id + '（键 ' + key + '），已跳过');
            continue;
        }
        el.checked = CONF[key] === undefined ? !!SWITCH_DEFAULT[key] : !!CONF[key];'''
if '找不到开关元素' in j:
    print('js: 开关空值保护已存在，跳过')
else:
    assert old_sw in j, 'js bindSwitches 开关段锚点没找到'
    j = j.replace(old_sw, new_sw, 1)
    print('js: 开关空值保护已加')

old_seg = '''    for (const [id, key, dflt] of SEGS) {
        const seg = $(id);'''
new_seg = '''    for (const [id, key, dflt] of SEGS) {
        const seg = $(id);
        if (!seg) {
            console.warn('[qs] 找不到分段控件 #' + id + '（键 ' + key + '），已跳过');
            continue;
        }'''
if '找不到分段控件' in j:
    print('js: 分段空值保护已存在，跳过')
else:
    assert old_seg in j, 'js bindSwitches 分段段锚点没找到'
    j = j.replace(old_seg, new_seg, 1)
    print('js: 分段空值保护已加')

write(jp, j)

# ---------------- 自检 ----------------
h2, j2 = read(hp), read(jp)
checks = [
    ('html 有 s-ocrEnable', 'id="s-ocrEnable"' in h2),
    ('html 开关行在 OCR 页内', h2.index('data-pane="ocr"') < h2.index('s-ocrEnable')),
    ('js SWITCH_DEFAULT.ocrEnable', 'ocrEnable: true,' in j2),
    ('js 开关保护', '找不到开关元素' in j2),
    ('js 分段保护', '找不到分段控件' in j2),
]
print('\n--- 自检 ---')
for name, ok in checks:
    print(('PASS  ' if ok else 'FAIL  ') + name)
sys.exit(0 if all(ok for _, ok in checks) else 1)
