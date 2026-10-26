/* ============================================================================
 *  多语言 / 启动密码 / 更新窗口 —— 无头测试
 *
 *  这一层测的是三件"只有真机上盲试才能发现"的事：
 *    1. 切到英文之后，页面上**还剩不剩中文**（这是用户的原话要求：
 *       「所有与中文相关的文案、标签、提示等均完整替换」）；
 *    2. 切回中文之后，是不是**逐字回到原文**（不是"再翻一遍"，更不能把
 *       用户数据、分隔线、空白吃坏）；
 *    3. 锁屏窗、更新窗这两个独立窗口里的按钮真的接上了后端命令。
 *
 *  全程 jsdom，不碰真实桌面。
 *  用法：node tools/test-i18n.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const lines = [];
function ok(name, cond, extra) {
    if (cond) { pass++; lines.push('PASS    ' + name); }
    else { fail++; lines.push('FAIL    ' + name + (extra ? '  <<< ' + extra : '')); }
}
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/* ------------------------------------------------------------------ 环境 */
/** 把 `<script src="x">` 就地摊平成内联脚本。
 *
 *  jsdom 默认不加载外部脚本（要配 ResourceLoader），而直接把脚本一个个 eval
 *  又会打乱"内联脚本 / 外部脚本"的真实执行顺序（update.html、lock.html 都是
 *  「先引 shared.js，再写一段内联逻辑」）。摊平之后浏览器怎么跑，jsdom 就怎么跑。 */
function inlineScripts(html) {
    return html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (m, src) => {
        const code = read('ui/' + src).replace(/<\/script/gi, '<\\/script');
        return '<script>\n' + code + '\n</script>';
    });
}

/** 起一个页面：装桩 → 载入脚本 → 等一轮微任务。 */
function loadPage(file, conf, extraStub) {
    const calls = [];
    const page = inlineScripts(read('ui/' + file));
    /* 页面自己抛的异常只记下来、不让 node 崩 —— 我们要断言的是"英文覆盖"，
     * 不是"后端桩够不够全"。真正的脚本错误由 test-ui.js 负责抓。 */
    const vc = new VirtualConsole();
    const pageErrors = [];
    vc.on('jsdomError', (e) => pageErrors.push(e && (e.detail || e.message || String(e))));

    const dom = new JSDOM(page, {
        runScripts: 'dangerously',
        url: 'http://localhost/',
        pretendToBeVisual: true,
        virtualConsole: vc,
        beforeParse(w) {
            /* engines.json 之类的小数据：直接从磁盘读，省掉一层 http 桩。 */
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
                } catch (e) {
                    return Promise.reject(e);
                }
            };
            w.matchMedia = () => ({
                matches: false, media: '',
                addListener() { }, removeListener() { },
                addEventListener() { }, removeEventListener() { },
            });
            w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
            w.cancelAnimationFrame = (id) => clearTimeout(id);
            w.__TAURI__ = {
                core: {
                    invoke: (cmd, args) => {
                        calls.push({ cmd, args: args || {} });
                        if (extraStub) {
                            const r = extraStub(cmd, args);
                            if (r !== undefined) return Promise.resolve(r);
                        }
                        if (cmd === 'get_config') return Promise.resolve(conf || { uiLang: 'zh', version: '1.5.13' });
                        if (cmd === 'backup_info') {
                            return Promise.resolve({ dir: 'C:\\t', isCustom: false, configPath: 'C:\\t\\config.json', files: [] });
                        }
                        if (cmd === 'backup_security_state') {
                            return Promise.resolve({ hasPassword: false, envelope: 'dpapi', portable: false, hasToken: false, secretCount: 0 });
                        }
                        if (cmd === 'github_rate_state') {
                            return Promise.resolve({ ok: true, authed: false, limit: 60, remaining: 60, used: 0, reset: 0 });
                        }
                        if (cmd === 'export_groups_list' || cmd === 'ocr_engines_list'
                            || cmd === 'img_engines' || cmd === 'img_engine_list') return Promise.resolve([]);
                        if (cmd === 'update_pending') return Promise.resolve({ has: false });
                        return Promise.resolve(null);
                    },
                },
                event: { listen: () => Promise.resolve(() => { }) },
                window: {
                    getCurrentWindow: () => ({
                        startDragging() { }, minimize() { }, close() { },
                        show() { }, hide() { }, setFocus() { },
                    }),
                },
            };
        },
    });
    return { dom, w: dom.window, calls, pageErrors };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

/* 页面上还剩哪些中文（排除明确不该翻的：语言选项里的「简体中文」）。 */
function chineseLeft(doc) {
    const out = new Set();
    const walk = (n) => {
        if (n.nodeType === 3) {
            const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
            // 「简体中文」是语言选项本身，按惯例保持原文
            if (t && CJK.test(t) && t !== '简体中文') out.add(t);
        } else if (n.nodeType === 1) {
            if (['SCRIPT', 'STYLE', 'TEXTAREA', 'PRE', 'CODE', 'CANVAS', 'SVG'].includes(n.tagName)) return;
            if (n.hasAttribute('data-i18n-skip')) return;
            /* `.nm` / `.letter` / `.eng-letter-h` 是**引擎名**（数据）：600 多条
             * 目录项，还可能是用户自己起的名字，按设计不翻。 */
            if (/(^|\s)(nm|letter|eng-letter-h)(\s|$)/.test(n.className || '')) return;
            for (const c of n.childNodes) walk(c);
        }
    };
    walk(doc.body);
    return [...out];
}

/* --------------------------------------------------- 1. 设置页：英文化彻底 */
async function testSettingsEnglish() {
    const { w } = loadPage('settings.html', { uiLang: 'zh', version: '1.5.13' });
    await tick(120);

    ok('i18n 引擎已装好', !!(w.QS_I18N && w.QS_I18N.lang === 'zh'), 'lang=' + (w.QS_I18N && w.QS_I18N.lang));

    const beforeText = w.document.body.textContent;
    const beforeHtml = w.document.body.innerHTML;

    w.QS_I18N.setLang('en');
    await tick(60);

    const left = chineseLeft(w.document);
    ok('切到英文后设置页不再有中文', left.length === 0,
        left.length + ' 条：' + left.slice(0, 6).join(' / '));

    const enText = w.document.body.textContent;
    ok('导航与标题确实变成了英文',
        /General/.test(enText) && /Text recognition/.test(enText) && /Favorites/.test(enText));

    ok('帮助页整块换成了英文版（不是逐句半翻）',
        /How to call it up/.test(enText) && /Where all my data lives/.test(enText));

    ok('帮助页的折叠状态没被整块替换冲掉',
        w.document.querySelectorAll('.help-item')[0].open === true);

    /* 滑块的实时数值长这样：`<small><span id="s-barBlurVal">30</span> · 说法…</small>`。
     * 整句替换会把那个 span 一起冲掉 —— `$('s-barBlurVal')` 变 null，数字就再也
     * 不跟着滑块动了（这是真踩过的坑，替换前后都得盯着）。 */
    ok('滑块旁边的实时数字还在（没被整句替换吞掉）',
        !!(w.document.getElementById('s-barBlurVal')
            && w.document.getElementById('s-barGlassBevelVal')
            && w.document.getElementById('s-delayVal')));

    /* 引擎名是数据（600 多条目录 + 用户自建），按设计不翻。 */
    const nmTexts = [...w.document.querySelectorAll('#aiList .nm')]
        .map((n) => n.textContent.trim()).filter(Boolean);
    ok('引擎名按数据保留原文（不翻译）',
        nmTexts.length > 0 && nmTexts.some((s) => CJK.test(s)), '共 ' + nmTexts.length + ' 个');

    /* 切回来必须逐字一致 —— 这是"还原"而不是"再翻一遍"的硬指标。 */
    w.QS_I18N.setLang('zh');
    await tick(60);
    ok('切回中文后正文逐字还原', w.document.body.textContent === beforeText,
        '长度 ' + beforeText.length + ' → ' + w.document.body.textContent.length);
    ok('切回中文后 innerHTML 完全一致（结构、空白都没被改）',
        w.document.body.innerHTML === beforeHtml);

    /* 再切一次英文，确认可来回切（记录表没被用坏） */
    w.QS_I18N.setLang('en');
    await tick(40);
    ok('来回切换多次仍然英文化', chineseLeft(w.document).length === 0);
    w.QS_I18N.setLang('zh');
    await tick(40);
    ok('来回切换多次仍能还原', w.document.body.textContent === beforeText);
}

/* --------------------------------------- 2. 配置持久化：重启后仍是英文 */
async function testLangFromConfig() {
    const { w } = loadPage('settings.html', { uiLang: 'en', version: '1.5.13' });
    await tick(120);
    ok('配置里是 en 时，页面一打开就是英文', w.QS_I18N.lang === 'en' && /General/.test(w.document.body.textContent));
    ok('配置里是 en 时也没有中文漏出来', chineseLeft(w.document).length === 0,
        chineseLeft(w.document).slice(0, 5).join(' / '));
    ok('<html lang> 跟着切换', w.document.documentElement.getAttribute('lang') === 'en');
}

/* ------------------------------------------- 3. 规则 / 碎片 / 标签拼接 */
async function testPieces() {
    const { w } = loadPage('lock.html', { uiLang: 'zh', version: '1.5.13' });
    await tick(80);
    const t = (s) => w.QS_I18N.t(s);

    w.QS_I18N.setLang('en');
    ok('带数字的规则：共 3 项', t('共 3 项') === '3 items', t('共 3 项'));
    ok('带数字的规则：已选 5 个', t('已选 5 个') === '5 selected', t('已选 5 个'));
    ok('带数字的规则：12 秒', t('12 秒') === '12 s', t('12 秒'));
    ok('标签 + 后端原话：前半截翻、后半截保留',
        t('操作失败：网络不通') === 'Operation failed: 网络不通', t('操作失败：网络不通'));
    ok('普通整句', t('分隔线') === 'Separator', t('分隔线'));
    ok('未收录的句子原样返回（不猜）', t('这是一句没有收录的话') === '这是一句没有收录的话');
    ok('用户数据不被碎片误伤', t('我的报告.docx') === '我的报告.docx', t('我的报告.docx'));
}

/* ------------------------------------------------- 4. 锁屏窗：能解锁 */
async function testLockWindow() {
    let answer = false;
    const { w, calls } = loadPage('lock.html', { uiLang: 'zh', version: '1.5.13' }, (cmd) => {
        if (cmd === 'verify_startup_password') return answer;
        return undefined;
    });
    await tick(120);

    const $ = (id) => w.document.getElementById(id);
    ok('锁屏窗有密码框和解锁按钮', !!$('pwd') && !!$('btnGo'));

    $('pwd').value = 'wrong-one';
    $('btnGo').dispatchEvent(new w.Event('click'));
    await tick(80);
    const bad = calls.filter((c) => c.cmd === 'verify_startup_password');
    ok('点解锁会把密码发给后端校验', bad.length === 1 && bad[0].args.password === 'wrong-one');
    ok('密码错时留在窗口里并给出提示',
        /密码不对/.test($('msg').textContent) && $('pwd').value === '');
    ok('密码错时按钮恢复可点（可以再试）', $('btnGo').disabled === false);

    answer = true;
    $('pwd').value = 'right-one';
    $('btnGo').dispatchEvent(new w.Event('click'));
    await tick(80);
    ok('密码对时提示已解锁', /已解锁/.test($('msg').textContent), $('msg').textContent);

    /* 英文模式下这一窗也要全英文 */
    w.QS_I18N.setLang('en');
    await tick(60);
    const left = chineseLeft(w.document);
    ok('锁屏窗英文模式无中文', left.length === 0, left.join(' / '));
}

/* --------------------------------------------- 5. 更新窗：取消能中断 */
async function testUpdateWindow() {
    const { w, calls } = loadPage('update.html', { uiLang: 'zh', version: '1.5.13' });
    await tick(120);

    const $ = (id) => w.document.getElementById(id);
    ok('更新窗有进度条和取消按钮', !!$('bar') || !!w.document.querySelector('#prog, .bar, #pct'),
        w.document.body.innerHTML.slice(0, 120));

    const cancel = w.document.querySelector('#btnCancel, [data-act="cancel"], #cancel');
    ok('取消按钮存在', !!cancel);
    if (cancel) {
        cancel.dispatchEvent(new w.Event('click'));
        await tick(60);
        ok('点取消会调 update_cancel', calls.some((c) => c.cmd === 'update_cancel'),
            calls.map((c) => c.cmd).join(','));
    }

    w.QS_I18N.setLang('en');
    await tick(60);
    const left = chineseLeft(w.document);
    ok('更新窗英文模式无中文', left.length === 0, left.join(' / '));
}

/* ---------------------------------------------------------------- 主流程 */
(async () => {
    try {
        await testSettingsEnglish();
        await testLangFromConfig();
        await testPieces();
        await testLockWindow();
        await testUpdateWindow();
    } catch (e) {
        ok('测试过程中不应抛异常', false, e && (e.stack || String(e)));
    }
    console.log('');
    for (const l of lines) console.log(l);
    console.log('');
    console.log(`${pass} / ${pass + fail} 通过  ->  ${fail === 0 ? '全部通过' : '存在失败'}`);
    process.exit(fail === 0 ? 0 : 1);
})();
