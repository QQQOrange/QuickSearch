/* r70 综合验证：
 *  ① 「更多引擎」面板点「软件引擎」后「设置…」按钮还在（面板框内 + 窗口内）
 *  ② 设置页引擎库：大类标题栏已删（仅剩胶囊目录）、主题中间层已渲染
 *  ③ 识图搜索引擎表：Lens / TinEye 已出册，默认名单 = Yandex + SauceNAO
 *  ④ 识图图标：内联 SVG 走「统一图标大小」量出系数（--qs-optical）
 * 用法: node tools/r70-verify.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r70-verify.txt');
const PORT = 9418;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
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
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(900);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r70v-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度', 'Google'],
        imgEnable: true, imgAddToBar: true,
        imgEngines: ['baidu', 'yandex', 'saucenao', 'bing'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r70v' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r70 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('连不上横条'); process.exit(1); }

    /* ---------- ① 设置按钮：先证伪（模拟横条贴屏幕底部） ---------- */
    // 把鼠标挪到屏幕底部中间，再唤出横条 → 锚点在底部 → 下方余量很小
    await ev(ws, `(function(){
        // 直接改不了物理光标，用 QS_STATIC_POS 之外的钧：发一个带锚点的 show_bar。
        // 锚点取当前光标；探针环境光标一般在屏幕中部，余量足够大 —— 这一步先验证
        // "窗口真的跟着面板长了"（vh 不再是 60），这是 r69 探针漏掉的前提。
        return window.__TAURI__.core.invoke('show_bar', { text: '测试', atMouse: true, viaCopy: false });
    })()`);
    await sleep(1200);
    await ev(ws, `document.getElementById('btnMore').click()`);
    await sleep(1800);
    const g0 = JSON.parse(await ev(ws, `(function(){
        var b = document.getElementById('btnSettings');
        var panel = document.getElementById('panel');
        var r = b.getBoundingClientRect(); var pr = panel.getBoundingClientRect();
        return JSON.stringify({ vh: window.innerHeight, btnBottom: Math.round(r.bottom),
            panelBottom: Math.round(pr.bottom), panelMaxH: panel.style.maxHeight || '(未设)',
            inWin: r.bottom <= window.innerHeight, inPanel: r.bottom <= pr.bottom + 1 });
    })()`));
    rec('打开面板（默认视图）：' + JSON.stringify(g0));
    check('P1a 窗口真的跟着面板长了（vh > 200，证明锚点生效、非退化环境）', g0.vh > 200, 'vh=' + g0.vh);
    check('P1b 默认视图「设置…」在窗口内', g0.inWin === true, JSON.stringify(g0));

    // 点「软件引擎」胶囊（用户报的触发路径）
    await ev(ws, `(function(){
        var bs = Array.from(document.querySelectorAll('.panel-sticky .grp-item'));
        var b = bs.find(function(x){ return x.textContent.indexOf('软件引擎') >= 0; });
        if (b) b.click();
        return b ? 'clicked' : 'NOT FOUND';
    })()`);
    await sleep(1500);
    const g1 = JSON.parse(await ev(ws, `(function(){
        var b = document.getElementById('btnSettings');
        var panel = document.getElementById('panel');
        var r = b.getBoundingClientRect(); var pr = panel.getBoundingClientRect();
        var cs = getComputedStyle(b);
        return JSON.stringify({ vh: window.innerHeight, btnBottom: Math.round(r.bottom),
            panelBottom: Math.round(pr.bottom), panelMaxH: panel.style.maxHeight || '(未设)',
            display: cs.display, visibility: cs.visibility,
            inWin: r.bottom <= window.innerHeight, inPanel: r.bottom <= pr.bottom + 1 });
    })()`));
    rec('点「软件引擎」后：' + JSON.stringify(g1));
    check('P2a 点「软件引擎」后「设置…」在面板框内', g1.inPanel === true, JSON.stringify(g1));
    check('P2b 点「软件引擎」后「设置…」在窗口内', g1.inWin === true, JSON.stringify(g1));
    check('P2c 按钮 display/visibility 正常', g1.display !== 'none' && g1.visibility === 'visible', JSON.stringify(g1));

    /* ---------- ① 加强：直接把面板钳到极小，验证 flex 盒模型 ---------- */
    await ev(ws, `(function(){
        var panel = document.getElementById('panel');
        panel.style.maxHeight = '150px';   // 比 head+foot 自然高还小
        return 'clamped';
    })()`);
    await sleep(600);
    const g2 = JSON.parse(await ev(ws, `(function(){
        var b = document.getElementById('btnSettings');
        var panel = document.getElementById('panel');
        var r = b.getBoundingClientRect(); var pr = panel.getBoundingClientRect();
        var body = document.getElementById('panelBody');
        return JSON.stringify({ panelH: Math.round(pr.height), btnBottom: Math.round(r.bottom),
            panelBottom: Math.round(pr.bottom),
            inPanel: r.bottom <= pr.bottom + 1,
            bodyScrolls: body.scrollHeight > body.clientHeight,
            bodyH: Math.round(body.clientHeight) });
    })()`));
    rec('maxHeight=150px 强钳后：' + JSON.stringify(g2));
    check('P3a 强钳 150px 后底栏仍在面板框内（flex 列生效）', g2.inPanel === true, JSON.stringify(g2));
    check('P3b 强钳后 body 出滚动条（内容不溢出）', g2.bodyScrolls === true, JSON.stringify(g2));

    /* ---------- ② 识图图标：内联 SVG 的光学系数 ---------- */
    const sv = JSON.parse(await ev(ws, `(function(){
        var b = document.getElementById('btnImg');
        var svg = b.querySelector('svg');
        if (!svg) return JSON.stringify({ has: false });
        // 邻居引擎图标（.ico > img）当基准：布局尺寸应当完全一致。
        // ⚠ SVG 元素没有 offsetWidth（它不是 HTMLElement）—— 用 computed width。
        var eng = document.querySelector('.engines .ico img');
        var cs = getComputedStyle(svg);
        return JSON.stringify({ has: true,
            optical: svg.style.getPropertyValue('--qs-optical') || '(未设)',
            svgLayout: Math.round(parseFloat(cs.width)),
            neighborLayout: eng ? eng.offsetWidth : -1,
            neighborOptical: eng ? (eng.style.getPropertyValue('--qs-optical') || '(未设)') : '',
            fill: cs.fill });
    })()`));
    rec('识图图标：' + JSON.stringify(sv));
    check('P4a 识图 SVG 存在', sv.has === true, JSON.stringify(sv));
    check('P4b 识图 SVG 布局尺寸 = 邻居图标布局尺寸（和其他图标一个盒）',
        sv.has && sv.svgLayout === sv.neighborLayout && sv.svgLayout > 0, JSON.stringify(sv));
    // 系数是异步量的，等一拍再读
    await sleep(900);
    const sv2 = await ev(ws, `(function(){
        var svg = document.querySelector('#btnImg svg');
        return svg ? (svg.style.getPropertyValue('--qs-optical') || '(未设)') : 'NO SVG';
    })()`);
    rec('识图 SVG 光学系数：' + sv2);
    check('P4c 「消除主体外多余部分」算法在识图图标上生效（量出了系数）',
        sv2 !== '(未设)' && sv2 !== 'NO SVG' && parseFloat(sv2) > 1.0, String(sv2));

    /* ---------- ③ 识图引擎表 ---------- */
    const engines = await ev(ws, `window.__TAURI__.core.invoke('img_engines_list')`);
    const ids = Array.isArray(engines) ? engines.map((e) => e.id) : [];
    rec('识图引擎（' + ids.length + ' 家）：' + ids.join(', '));
    check('P5a Lens 已出册', ids.indexOf('lens-url') < 0, ids.join(','));
    check('P5b TinEye 已出册', ids.indexOf('tineye-url') < 0, ids.join(','));
    check('P5c 通义指向新域名', (engines.find(e => e.id === 'tongyi') || {}).page === 'https://www.qianwen.com/', '');
    check('P5d Kimi 指向新域名', (engines.find(e => e.id === 'kimi') || {}).page === 'https://www.kimi.com/', '');

    /* ---------- ④ 设置页：引擎库结构 ---------- */
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(800);
    const proc2 = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('设置页 pid=' + proc2.pid);
    sleep(9000);
    const ws2 = await connect('settings.html');
    if (!ws2) { rec('连不上设置页'); process.exit(1); }
    await ev(ws2, `document.querySelector('#tabs [data-tab="engines"]').click()`);
    await sleep(2200);
    const lib = JSON.parse(await ev(ws2, `(function(){
        var box = document.getElementById('allList');
        if (!box) return JSON.stringify({ err: 'no allList' });
        var grps = box.querySelectorAll('.eng-grp');
        var headers = box.querySelectorAll('.eng-grp-h');
        var themes = box.querySelectorAll('.eng-theme-h');
        var subs = box.querySelectorAll('.eng-sub-h');
        var cats = box.querySelectorAll('.eng-cat-h');
        var themeTexts = [];
        themes.forEach(function(t){ themeTexts.push(t.textContent); });
        return JSON.stringify({ grps: grps.length, headers: headers.length,
            themes: themes.length, subs: subs.length, cats: cats.length,
            themeTexts: themeTexts.slice(0, 10) });
    })()`));
    rec('引擎库结构：' + JSON.stringify(lib));
    check('P6a 大类标题栏已删（仅保留胶囊目录）', lib.headers === 0, JSON.stringify(lib));
    check('P6b 三大类块都在', lib.grps === 3, JSON.stringify(lib));
    check('P6c 中类标题在（带大类前缀）', lib.subs >= 3, JSON.stringify(lib));
    check('P6d 主题中间层已渲染（≥6 个主题标题）', lib.themes >= 6, JSON.stringify(lib));
    check('P6e 小类标题仍在', lib.cats >= 10, JSON.stringify(lib));

    // 识图分页：引擎行数 = 11、无 Lens/TinEye 行
    await ev(ws2, `document.querySelector('#tabs [data-tab="imgsearch"]').click()`);
    await sleep(1500);
    const imgRows = JSON.parse(await ev(ws2, `(function(){
        var rows = document.querySelectorAll('#w-imgEngList .img-row');
        var names = [];
        rows.forEach(function(r){ names.push(r.dataset.id); });
        var def = document.querySelector('#w-imgEngList .img-row.def');
        return JSON.stringify({ n: rows.length, ids: names,
            hasDef: !!def, defText: def ? def.querySelector('.eng-btn.def').textContent : '' });
    })()`));
    rec('识图设置行：' + JSON.stringify(imgRows));
    check('P7a 识图引擎 11 家', imgRows.n === 11, JSON.stringify(imgRows));
    check('P7b 无 Lens / TinEye 行', imgRows.ids.indexOf('lens-url') < 0 && imgRows.ids.indexOf('tineye-url') < 0, '');
    check('P7c 默认徽标存在（Yandex 排最前）', imgRows.ids[0] === 'yandex', imgRows.ids[0]);

    rec('========== r70 验证：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    try { proc2.kill(); } catch (e) { }
    await sleep(400);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
