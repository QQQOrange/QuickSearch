/*
 * 从 2.9.0 用户脚本里把「引擎池」原样抽出来，输出成桌面版能直接吃的 JSON。
 * 这样引擎名 / 搜索 URL / 分类 / 颜色 / 图标映射全部与浏览器版保持一致，
 * 不靠手抄，改脚本后重跑一次即可同步。
 *
 * 用法: node tools/extract-engines.js
 */
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/64381/WorkBuddy/2026-10-10-16-56-30/Quick-Search-2.9.0.user.js';
const OUT = path.join(__dirname, '..', 'ui', 'data', 'engines.json');
const SCRIPT = fs.readFileSync(SRC, 'utf8');

// ---- 用 jsdom 真跑一遍脚本，直接从它内部把配置读出来 ----
const { JSDOM, VirtualConsole } = require(path.join(
    'C:/Users/64381/.workbuddy/binaries/node/workspace/node_modules', 'jsdom'));

const store = {};
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.com/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
        window.GM_getValue = (k, f) => (k in store ? store[k] : f);
        window.GM_setValue = (k, v) => { store[k] = v; };
        window.GM_openInTab = () => {};
        window.GM_setClipboard = () => {};
        window.GM_xmlHttpRequest = () => {};
    },
});
const el = dom.window.document.createElement('script');
el.textContent = SCRIPT;
dom.window.document.body.appendChild(el);

const root = dom.window.document.getElementById('qs-host').shadowRoot;
// 打开主窗口，让所有分类都渲染出来，顺便拿到每个引擎的最终图标地址
dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyF', altKey: true, bubbles: true }));

const engines = [];
const seen = new Set();
const pushEngine = (name, url, extra) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    engines.push(Object.assign({ name: name, url: url }, extra));
};

// 横条引擎（按顺序）
const toolbar = [];
for (const img of root.querySelectorAll('.qs-toolbar .qs-toolbar-icon')) {
    const alt = img.getAttribute('alt') || '';
    if (!alt || img.classList.contains('qs-icon-mono')) continue;
    toolbar.push({
        name: alt,
        icon: String(img.src),
        inset: Number(img.style.getPropertyValue('--qs-icon-inset') || 1) || 1,
    });
}

// 分类引擎
const categories = [];
for (const fam of root.querySelectorAll('.qs-classified-box .qs-family-box')) {
    const title = fam.querySelector('.qs-family-title').textContent;
    const items = [];
    for (const it of fam.querySelectorAll('.qs-engine-item')) {
        const img = it.querySelector('img');
        items.push({
            name: it.querySelector('.qs-engine-name').textContent,
            icon: String(img.src),
            inset: Number(img.style.getPropertyValue('--qs-icon-inset') || 1) || 1,
        });
    }
    if (items.length) categories.push({ title: title, engines: items });
}

// 从脚本源码里补上每个引擎的「搜索 URL」——DOM 里拿不到，得解析配置
// DEFAULT_CONF 里的写法很规整：{ name: 'X', url: '...', enable: ... }
const urlByName = new Map();
const reUrl = /\{\s*name:\s*'((?:[^'\\]|\\.)*)'\s*,\s*url:\s*'((?:[^'\\]|\\.)*)'/g;
let m;
while ((m = reUrl.exec(SCRIPT)) !== null) {
    const name = m[1].replace(/\\'/g, "'");
    const url = m[2].replace(/\\'/g, "'");
    if (!urlByName.has(name)) urlByName.set(name, url);
}

const unwrap = (raw) => (urlByName.has(raw) ? urlByName.get(raw) : null);

const dump = (list) => list.map((e) => ({
    name: e.name, url: unwrap(e.name), icon: e.icon, inset: e.inset,
})).filter((e) => e.url);

const out = {
    generatedFrom: path.basename(SRC),
    generatedAt: new Date().toISOString().slice(0, 10),
    toolbar: dump(toolbar),
    categories: categories.map((c) => ({ title: c.title, engines: dump(c.engines) })),
};

// 统计
const all = out.categories.reduce((a, c) => a + c.engines.length, 0);
const withIcon = out.categories.reduce((a, c) => a + c.engines.filter((e) => e.icon).length, 0);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

console.log('来源        : ' + SRC);
console.log('输出        : ' + OUT);
console.log('横条引擎    : ' + out.toolbar.length + ' 个 → ' + out.toolbar.map((e) => e.name).join(' '));
console.log('分类        : ' + out.categories.length + ' 组');
console.log('分类引擎    : ' + all + ' 个（有图标 ' + withIcon + ' 个）');
const noUrl = [];
for (const c of out.categories) for (const e of c.engines) if (!e.url) noUrl.push(e.name);
if (noUrl.length) console.log('⚠ 未解析到 URL: ' + noUrl.join(', '));
console.log('');
for (const c of out.categories) {
    console.log('  ' + c.title.padEnd(6) + ' ' + c.engines.length + ' 个  例: '
        + c.engines.slice(0, 3).map((e) => e.name).join(' / '));
}
