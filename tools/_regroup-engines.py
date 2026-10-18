# -*- coding: utf-8 -*-
"""把 engines.json 重组为「三大类 × 二级细分」结构（一次性转换脚本）。

结构（向后兼容）：
  · categories 原样保留（bar.js / settings.js / main.rs 的既有读者不动，
    只给每个分类打上 group / sub 标签）；
  · 新增 groups：三大类（网页 / 软件 / 快捷键）的展示元数据（标题、副标题）；
  · 新增「软件搜索」分类（app 组 / appsearch 子类）：本地协议搜索；
  · 「常用软件」分类（app 组 / appopen 子类）补一批 System32 本地软件直达。
"""
import io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, 'ui', 'data', 'engines.json')

with io.open(PATH, 'r', encoding='utf-8') as f:
    d = json.load(f)

cats = d['categories']
by_title = {c['title']: c for c in cats}

WEB_SUBS = [
    {'key': 'search', 'title': '搜索引擎', 'kinds': ['search'],
     'desc': '拿选中的词跳过去搜（地址带 %s，没有选中文字时点了没反应）'},
    {'key': 'open', 'title': '直达网页', 'kinds': ['open'],
     'desc': '不依赖选中的文字，点了直接打开这个页面'},
]
APP_SUBS = [
    {'key': 'appsearch', 'title': '软件搜索', 'kinds': ['search'],
     'desc': '调用本机软件执行搜索：填软件自己的协议地址，用 %s 标出搜索词'},
    {'key': 'appopen', 'title': '软件直达', 'kinds': ['open'],
     'desc': '点一下直接打开这个软件（或软件内指定的页面）'},
]
HK_SUBS = [
    {'key': 'hotkey', 'title': '快捷键', 'kinds': ['hotkey'],
     'desc': '点了把一串组合键模拟发给当时的前台软件（不碰浏览器）'},
]

d['groups'] = [
    {'key': 'web', 'title': '网页引擎', 'subs': WEB_SUBS,
     'desc': '浏览器里的搜索引擎与网页直达'},
    {'key': 'app', 'title': '软件引擎', 'subs': APP_SUBS,
     'desc': '本机软件与系统工具：搜索、直达'},
    {'key': 'hotkey', 'title': '快捷键引擎', 'subs': HK_SUBS,
     'desc': '把组合键发给前台软件'},
]

WEB_BOTH = ['网页', 'AI 工具', '知识', '开发', '翻译', '地图', '图片', '音乐',
            '视频', '购物', '应用', '游戏', '网盘', '学术', '社交', '新闻',
            '词典', '财经', '学习', '阅读', '汽车', '生活', '工具', '邮箱']

for t in WEB_BOTH:
    assert t in by_title, '缺少分类: ' + t
    by_title[t]['group'] = 'web'
    by_title[t]['sub'] = 'both'      # 同一分类里搜/开两类都有，按 kind 现场拆

by_title['常用软件']['group'] = 'app'
by_title['常用软件']['sub'] = 'appopen'
by_title['快捷键']['group'] = 'hotkey'
by_title['快捷键']['sub'] = 'hotkey'

# ---- 新增「软件搜索」分类（本地协议搜索）----
if '软件搜索' in by_title:
    raise SystemExit('软件搜索 分类已存在，别重复加')
by_title['软件搜索'] = {
    'title': '软件搜索', 'group': 'app', 'sub': 'appsearch',
    'engines': [
        {'name': 'Windows 搜索', 'kind': 'search',
         'url': 'search-ms:query=%s',
         'alias': ['win搜索', '文件搜索', '本地搜索'],
         'inset': 1},
        {'name': '系统设置搜索', 'kind': 'search',
         'url': 'ms-settings:search?query=%s',
         'alias': ['设置搜索'], 'inset': 1},
        {'name': '微软商店搜索', 'kind': 'search',
         'url': 'ms-windows-store://search/?query=%s',
         'alias': ['商店搜索'], 'inset': 1},
    ],
}
cats.append(by_title['软件搜索'])

# ---- 「常用软件」补 System32 本地软件直达（都是系统自带、路径稳定）----
SYS = 'file:///C:/Windows/System32/'
LOCAL_APPS = [
    ('计算器', 'calc.exe'), ('记事本', 'notepad.exe'), ('画图', 'mspaint.exe'),
    ('写字板', 'write.exe'), ('任务管理器', 'taskmgr.exe'),
    ('资源监视器', 'resmon.exe'), ('系统信息', 'msinfo32.exe'),
    ('设备管理器', 'devmgmt.msc'), ('注册表编辑器', 'regedit.exe'),
    ('服务', 'services.msc'), ('控制面板', 'control.exe'),
    ('系统设置', 'ms-settings:'), ('远程桌面', 'mstsc.exe'),
    ('屏幕键盘', 'osk.exe'), ('字符映射表', 'charmap.exe'),
    ('磁盘清理', 'cleanmgr.exe'), ('截图工具', 'SnippingTool.exe'),
]
have = set(e['name'] for e in by_title['常用软件']['engines'])
for name, target in LOCAL_APPS:
    if name in have:
        continue
    url = target if ':' in target.split('/')[0] and target.startswith('ms-settings:') else SYS + target
    by_title['常用软件']['engines'].append(
        {'name': name, 'kind': 'open', 'url': url, 'inset': 1})

# 分类顺序：web 各分类（原顺序）→ 软件搜索 → 常用软件 → 快捷键
order = {t: i for i, t in enumerate(WEB_BOTH)}
def sort_key(c):
    if c['title'] == '软件搜索':
        return (1, 0)
    if c['title'] == '常用软件':
        return (1, 1)
    if c['title'] == '快捷键':
        return (2, 0)
    return (0, order[c['title']])
cats.sort(key=sort_key)

d['schema'] = 2

with io.open(PATH, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=1)

# 统计
n = sum(len(c['engines']) for c in cats)
print('OK: categories=%d engines=%d' % (len(cats), n))
for g in d['groups']:
    print(' ', g['title'], [s['title'] for s in g['subs']])
