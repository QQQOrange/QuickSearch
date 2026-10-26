/* 补漏审计：把某个页面**切到英文后还剩的中文**连位置一起导出来。
 *
 * 和 `tools/test-i18n.js` 的分工：那个是**断言**（CI 式的红绿，只看设置页
 * 默认视图）；这个是人看的**清单**（哪一页、哪个节点、原文是什么），补字典
 * 的时候按它一条条填。
 *
 * 用法：
 *   node tools/i18n-audit.js                # 设置页，英文
 *   node tools/i18n-audit.js ocr.html       # 只看 OCR 页
 *   node tools/i18n-audit.js index.html en
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

const page = process.argv[2] || 'settings.html';
const want = process.argv[3] || 'en';

function inlineScripts(html) {
    return html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (m, src) => {
        const code = read('ui/' + src).replace(/<\/script/gi, '<\\/script');
        return '<script>\n' + code + '\n</script>';
    });
}

const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', (e) => errs.push(String((e && (e.detail || e.message)) || e)));
const dom = new JSDOM(inlineScripts(read('ui/' + page)), {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
        w.fetch = (url) => {
            const rel = String(url).replace(/^\.?\//, '');
            const abs = path.join(ROOT, 'ui', rel);
            try {
                const text = fs.readFileSync(abs, 'utf8');
                return Promise.resolve({
                    ok: true, status: 200,
                    text: () => Promise.resolve(text),
                    json: () => Promise.resolve(JSON.parse(text)),
                });
            } catch (e) { return Promise.reject(e); }
        };
        w.matchMedia = () => ({
            matches: false, media: '',
            addListener() { }, removeListener() { },
            addEventListener() { }, removeEventListener() { },
        });
        w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
        w.cancelAnimationFrame = (id) => clearTimeout(id);
        const stub = (cmd) => {
            if (cmd === 'get_config') return Promise.resolve({ uiLang: want, version: '1.5.13' });
            if (cmd === 'backup_info') return Promise.resolve({ dir: 'C:\\t', isCustom: false, configPath: 'C:\\t\\config.json', files: [] });
            if (cmd === 'backup_security_state') return Promise.resolve({ hasPassword: false, envelope: 'dpapi', portable: false, hasToken: false, secretCount: 0 });
            if (cmd === 'github_rate_state') return Promise.resolve({ ok: true, authed: false, limit: 60, remaining: 60, used: 0, reset: 0 });
            if (cmd === 'export_groups_list' || cmd === 'ocr_engines_list' || cmd === 'img_engines' || cmd === 'img_engine_list') return Promise.resolve([]);
            if (cmd === 'update_pending') return Promise.resolve({ has: false });
            return Promise.resolve(null);
        };
        w.__TAURI__ = {
            core: { invoke: (c) => stub(c) },
            event: { listen: () => Promise.resolve(() => { }) },
            window: { getCurrentWindow: () => ({ startDragging() { }, minimize() { }, close() { }, show() { }, hide() { }, setFocus() { } }) },
        };
    },
});

const w = dom.window;
setTimeout(() => {
    const out = [];
    const walk = (n, trail) => {
        if (n.nodeType === 3) {
            const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
            if (t && CJK.test(t) && t !== '简体中文') out.push({ kind: 'text', at: trail, v: t });
            return;
        }
        if (n.nodeType !== 1) return;
        if (['SCRIPT', 'STYLE', 'TEXTAREA', 'PRE', 'CODE', 'CANVAS', 'SVG'].includes(n.tagName)) return;
        if (n.hasAttribute('data-i18n-skip')) return;
        const isName = /(^|\s)(nm|letter|eng-letter-h)(\s|$)/.test(n.className || '');
        const id = n.id ? '#' + n.id : '';
        const cls = n.className && typeof n.className === 'string' ? '.' + n.className.split(/\s+/).slice(0, 2).join('.') : '';
        const here = trail + '/' + n.tagName.toLowerCase() + id + cls;
        if (!isName) {
            for (const a of ['title', 'placeholder', 'aria-label', 'data-tip']) {
                const v = n.getAttribute && n.getAttribute(a);
                if (v && CJK.test(v)) out.push({ kind: 'attr:' + a, at: here, v });
            }
        }
        for (const c of n.childNodes) {
            /* 引擎名本身是数据、不翻；但里面夹的界面文案还要看 */
            if (isName && c.nodeType === 3) continue;
            walk(c, here);
        }
    };
    walk(w.document.body, '');

    // 去重 + 计数
    const seen = new Map();
    for (const o of out) {
        const k = o.kind + '|' + o.v;
        if (seen.has(k)) { seen.get(k).n++; continue; }
        seen.set(k, Object.assign({ n: 1 }, o));
    }
    const list = [...seen.values()];
    list.sort((a, b) => b.v.length - a.v.length);
    console.log('LEFT=' + list.length + '   (nodes=' + out.length + ')  page=' + page + ' lang=' + want);
    for (const o of list) console.log('[' + o.kind + ']×' + o.n + '  ' + o.v + '\n      at ' + o.at);
    if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 5).join('\n'));
    process.exit(0);
}, 400);
