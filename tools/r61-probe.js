/* r61 探针：识图真上传 / 按键全撤 / 引擎库合并 / 识图进横条列表 + 可换图标
 *
 * 用户这一轮的原话（摘）：
 *  「识图功能可以说是完全用不了，请结合这个项目来优化 PicImageSearch」
 *  「点击识图按钮之后就开始框选屏幕，框选完了之后就直接开始进行识图搜索，
 *    原来通过按键的一些形式就全部撤销」
 *  「识图搜索加入了横条，但是我在引擎页面横条上的引擎这里没有看到识图搜索的按钮，
 *    而且我希望识图搜索的那个图标也能够自己换」
 *  「有了引擎库，结果这里面就又有一个全部引擎，这两个是重复的……想办法结合在一起」
 *  「引擎库……4 个按钮之后的总的背景和引擎库这个背景颜色不一致……视觉上很难看很粗糙」
 *
 * ⚠ 不真跑 img_region（会拉起浏览器）；上传用后端命令间接验证不了，
 *   所以"能不能真上传"由 Rust 侧的去重/字段测试 + 这一轮的联网实测记录保证，
 *   这里验的是**代码形状**（端点、请求头、无按键模拟）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r61-probe.txt');
const PORT = 9409;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}
let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const on = (ev) => {
            let x; try { x = JSON.parse(ev.data); } catch (e) { return; }
            if (x.id !== i) return;
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) : r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
            if (hit) {
                const ws = new WebSocket(hit.webSocketDebuggerUrl);
                await new Promise((res, rej) => {
                    ws.addEventListener('open', res, { once: true });
                    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
                });
                return ws;
            }
        } catch (e) { }
        await sleep(300);
    }
    return null;
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r61-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        bar_list: ['百度', 'Google'],
        img_enable: true, img_add_to_bar: true,
        img_engines: ['baidu', 'yandex'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r61' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r61 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页连不上'); flush(); process.exit(1); }

    /* ============ A. 识图引擎：两家真上传 + 按键全撤 ============ */
    rec('');
    rec('--- A. 识图引擎 ---');
    const engs = await ev(ws, `(async function(){
        var v = await window.__TAURI__.core.invoke('img_engines_list');
        return JSON.stringify(v.map(function(e){ return {id:e.id, mode:e.mode}; }));
    })()`);
    let E = [];
    try { E = JSON.parse(engs); } catch (e) { }
    rec('引擎 = ' + engs);
    check('A1 有两家 `upload`（真上传）', E.filter((e) => e.mode === 'upload').length >= 2,
        JSON.stringify(E.filter((e) => e.mode === 'upload').map((e) => e.id)));
    check('A2 百度是 upload', (E.find((e) => e.id === 'baidu') || {}).mode === 'upload');
    check('A3 Yandex 是 upload', (E.find((e) => e.id === 'yandex') || {}).mode === 'upload');
    check('A4 已经没有 `form` 这种过渡模式', !E.some((e) => e.mode === 'form'));

    const src = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
    check('A5 源码里有真上传函数 img_upload', src.indexOf('fn img_upload') >= 0);
    check('A6 百度那条带 Acs-Token 头（少了它对方回 Reject）', /"Acs-Token"/.test(src));
    check('A7 Yandex 走 yandex.ru（.com 只回空壳页）', /yandex\.ru\/images\/search/.test(src));
    check('A8 连 yandex.com 都没用在 Upload 路径上', !/page: "https:\/\/yandex\.com\/images\/search"/.test(
        fs.readFileSync(path.join(ROOT, 'src', 'imgsearch.rs'), 'utf8')));

    // 按键模拟必须全撤
    check('A9 已经没有 paste_into_browser（Ctrl+V 那套）', src.indexOf('fn paste_into_browser') < 0);
    /* r66 起用户明确要求 AI 引擎「粘贴 + 按 enter 来实现询问图片内容」，
     * 所以 Enter 回来了 —— 但**只对 AI 那四家**。断言改成钉这个范围：
     * 全文只出现一次、且就在 img_paste_into_browser 里。 */
    check('A10 Enter 只出现在 AI 粘贴函数里（别的引擎仍不按 Enter）',
        (() => {
            const fnStart = src.indexOf('fn img_paste_into_browser');
            const tail = src.slice(fnStart, fnStart + 4000);
            const all = (src.match(/send_hotkey\("enter"\)/g) || []).length;
            return fnStart >= 0 && tail.indexOf('send_hotkey("enter")') >= 0 && all === 1;
        })(),
        '全文出现 ' + (src.match(/send_hotkey\("enter"\)/g) || []).length + ' 次');
    check('A11 也没有"自动提交页"那套（img_write_form_page）', src.indexOf('fn img_write_form_page') < 0);

    /* ============ B. 引擎库合并 ============ */
    rec('');
    rec('--- B. 引擎库合并 ---');
    const lib = await ev(ws, `(function(){
        return JSON.stringify({
            secLib: !!document.getElementById('sec-lib'),
            secAll: !!document.getElementById('sec-all'),
            libToc: !!document.getElementById('libToc'),
            libBody: !!document.getElementById('libBody'),
            allList: !!document.getElementById('allList'),
            allFilter: !!document.getElementById('allFilter'),
            allGrpNav: !!document.getElementById('allGrpNav'),
            h2s: Array.from(document.querySelectorAll('#sec-lib h2, #sec-all h2')).map(function(h){return h.textContent.trim().slice(0,12);})
        });
    })()`);
    let LB = {};
    try { LB = JSON.parse(lib); } catch (e) { }
    rec('引擎区结构 = ' + lib);
    check('B1 只剩一张引擎卡（sec-all 已删）', LB.secLib === true && LB.secAll === false, lib);
    check('B2 旧的两套列表容器已删（libToc / libBody 都不在）',
        LB.libToc === false && LB.libBody === false, lib);
    check('B3 合并后仍有搜索框 / 大类胶囊 / 列表', LB.allFilter && LB.allGrpNav && LB.allList, lib);
    check('B4 只剩**一个**「引擎库」标题（不再有第二个引擎目录标题）',
        Array.isArray(LB.h2s) && LB.h2s.length === 1, JSON.stringify(LB.h2s));

    await ev(ws, `document.querySelector('#tabs button[data-tab="engines"]').click()`);
    await sleep(1500);
    const filled = await ev(ws, `(function(){
        var nav = document.getElementById('allGrpNav');
        return JSON.stringify({
            navChips: nav ? nav.querySelectorAll('.eng-nav-item').length : 0,
            rows: document.querySelectorAll('#allList .eng-row, #allList .lib-item, #allList .lib-chip').length,
            listHtmlLen: (document.getElementById('allList') || {}).innerHTML ? document.getElementById('allList').innerHTML.length : 0
        });
    })()`);
    let F = {};
    try { F = JSON.parse(filled); } catch (e) { }
    rec('列表填充 = ' + filled);
    check('B5 四个大类胶囊在（全部/网页/软件/快捷键）', F.navChips === 4, String(F.navChips));
    check('B6 合并后的列表**真的有内容**（不是空壳）', Number(F.listHtmlLen) > 2000, String(F.listHtmlLen));

    /* ============ C. 背景一致（sticky 不能自带别的底色） ============ */
    rec('');
    rec('--- C. 背景一致 ---');
    const css = fs.readFileSync(path.join(ROOT, 'ui', 'settings.css'), 'utf8');
    // ⚠ 判据必须先**剥掉注释**：这一轮我在 .lib-sec-h 上方写了一段注释解释
    //   "原来这里是 position: sticky / background: var(--bg)"，不剥注释就会把
    //   解释文字当成真代码，把"已经修好"误判成"还没修"。这是探针的错，不是产品的。
    const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
    const tocBlock = /\.lib-toc \{[\s\S]*?\}/.exec(stripCss(css));
    check('C1 .lib-toc 用的是卡片底色 var(--card)（不是页面底色 --bg）',
        !!tocBlock && /background:\s*var\(--card\)/.test(tocBlock[0]),
        tocBlock ? tocBlock[0].replace(/\s+/g, ' ').slice(0, 160) : 'missing');
    const secH = /\.lib-sec-h \{[\s\S]*?\}/.exec(stripCss(css));
    check('C2 .lib-sec-h 不再 sticky（写死 top:39px 那套会错位）',
        !!secH && !/position:\s*sticky/.test(secH[0]),
        secH ? secH[0].replace(/\s+/g, ' ').slice(0, 160) : 'missing');
    check('C3 .lib-sec-h 不再自带 --bg 底色', !!secH && !/background:\s*var\(--bg\)/.test(secH[0]));

    /* ============ D. 识图进「横条上的引擎」+ 可换图标 ============ */
    rec('');
    rec('--- D. 识图那一行 ---');
    const imgRow = await ev(ws, `(function(){
        var box = document.getElementById('barList');
        if (!box) return 'no-box';
        var rows = Array.from(box.querySelectorAll('.item'));
        var hit = rows.find(function(r){ return /识图搜索/.test(r.textContent); });
        if (!hit) return JSON.stringify({ found:false, names: rows.map(function(r){return r.textContent.trim().slice(0,10);}) });
        return JSON.stringify({
            found: true,
            text: hit.textContent.replace(/\s+/g,' ').trim().slice(0,60),
            btns: Array.from(hit.querySelectorAll('button')).map(function(b){return b.textContent.trim();}),
            hasIcon: !!hit.querySelector('.ic img, .ic .letter')
        });
    })()`);
    let IR = {};
    try { IR = JSON.parse(imgRow); } catch (e) { }
    rec('识图行 = ' + imgRow);
    check('D1 「横条上的引擎」里能看到「识图搜索」那一行', IR.found === true, imgRow);
    check('D2 那一行有「换图标」按钮', Array.isArray(IR.btns) && IR.btns.indexOf('换图标') >= 0, JSON.stringify(IR.btns));
    check('D3 那一行有图标位（换过图显示图、没换显示徽标）', IR.hasIcon === true, imgRow);

    const barSrc = fs.readFileSync(path.join(ROOT, 'ui', 'bar.js'), 'utf8');
    check('D4 横条按钮会读 QS_IMG 的自定义图标', /QS_IMG/.test(barSrc) && /overrideIcons/.test(barSrc));
    check('D5 换回内置图标有兜底（builtinImgSvg 懒取，不会变空白）',
        /function builtinImgSvg\(\)/.test(barSrc) && /builtinImgSvg\(\)/.test(barSrc));
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
    check('D6 后端 icon_edit_name 认识 @img', /key == config::BAR_IMG/.test(mainSrc));
    const shared = fs.readFileSync(path.join(ROOT, 'ui', 'shared.js'), 'utf8');
    check('D7 前端有 window.QS_IMG', /window\.QS_IMG = '@img'/.test(shared));

    rec('');
    rec('========== r61：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(500);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
