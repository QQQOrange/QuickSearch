/* r59 探针：识图真提交 / 引擎清理 / 默认引擎自动勾选 / 勾选框不重叠 /
 * 识图图标 / 添加胶囊变小 / 文件路径图标 / 十字准星点选
 *
 * 用户这一轮的原话（摘）：
 *  「识图搜索它并不会把节选的部分发给相应的网址，只是说会打开网址，这是一个很
 *    严重的问题」
 *  「有的引擎现在已经没有了呀……所以你可能要把这相关的给去掉」
 *  「我设置默认引擎之后，那一个引擎就不会被默认打勾」
 *  「这个可以勾选的框跟每个引擎的图标是重叠在了一起」
 *  「识图搜索的图标要换一下，现在就是一个放大镜图标」
 *  「我希望改小的是添加引擎页面的这 3 个添加胶囊的大小」
 *  「我在这个软件的设置页面按 control 加 c 不能够换出横条」
 *  「我选择了文件夹的地址，但横条里面不能够弹出来这样的图标」
 *  「有一个按钮……它会把鼠标变成一个十字，我把这个十字点到相关软件上」
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r59-probe.txt');
const PORT = 9405;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
/* 每写一行就落盘 —— 探针万一挂住，能从文件里看出它停在哪一步。
 * （第一版只在最后 flush，结果挂住时文件是空的，完全不知道卡在哪。） */
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
const USER_PATH = 'C:\\Users\\64381\\OneDrive\\桌面\\377程子人才补贴材料';

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r59-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        img_enable: true, img_add_to_bar: true,
        img_engines: ['saucenao', 'bing'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r59' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r59 探针：pid=' + proc.pid);
    sleep(9000);
    const barWs = await connect('tauri.localhost/');
    if (!barWs) { rec('横条连不上'); flush(); process.exit(1); }

    /* ================= A. 识图引擎表 ================= */
    rec('');
    rec('--- A. 识图引擎表 ---');
    const list = await ev(barWs, `(async function(){
        var v = await window.__TAURI__.core.invoke('img_engines_list');
        return JSON.stringify(v.map(function(e){ return {id:e.id,name:e.name,mode:e.mode}; }));
    })()`);
    let engs = [];
    try { engs = JSON.parse(list); } catch (e) { }
    rec('引擎 = ' + list);
    /* r60：9 → 13（新增 4 家 AI 看图）。仍然不写死：只要求「至少 9 家」
     * 且「含 AI 引擎」，同时下面 A4 会逐条确认死引擎不在表里。 */
    check('A1 引擎家数 ≥ 9（删掉失效的之后又加了 AI 看图）', engs.length >= 9, '实际 ' + engs.length);
    check('A1b 表里有 AI 看图引擎（豆包/通义/Kimi/智谱）',
        ['doubao', 'tongyi', 'kimi', 'chatglm'].every(function (id) {
            return engs.some(function (e) { return e.id === id; });
        }), JSON.stringify(engs.map(function (e) { return e.id; })));
    /* r61：`form`（浏览器表单提交）已被真上传取代 —— 用户要求撤掉按键那套，
     * 改成软件自己 POST 上去拿结果页 URL。 */
    check('A2 至少有两家 `upload`（真的把图交出去）',
        engs.filter((e) => e.mode === 'upload').length >= 2,
        JSON.stringify(engs.map((e) => e.mode)));
    check('A3 百度走 upload', (engs.find((e) => e.id === 'baidu') || {}).mode === 'upload');
    for (const dead of ['ascii2d', 'iqdb', '3diqdb', 'karma', 'lens', 'tineye', 'trace']) {
        check('A4 已删掉的引擎不在表里：' + dead, !engs.some((e) => e.id === dead));
    }
    check('A5 必应指向 cn.bing.com/images（不再是被 302 回首页的 /visualsearch）',
        (engs.find((e) => e.id === 'bing') || {}).name === '必应图片');

    /* ================= B. 识图真的提交 ================= */
    rec('');
    rec('--- B. 识图真的提交 ---');
    const imgSrc = fs.readFileSync(path.join(ROOT, 'src', 'imgsearch.rs'), 'utf8');
    const mainSrc0 = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
    /* r61 新口径：软件自己上传。三条不变量：
     *   ① 有 img_upload（真上传函数）；
     *   ② 百度带 Acs-Token（少了它对方回 Reject）；
     *   ③ Yandex 走 yandex.ru（.com 只回空壳页）。 */
    check('B1 源码里有真上传函数 img_upload', mainSrc0.indexOf('fn img_upload') >= 0);
    check('B2 百度那条带 Acs-Token 头', /"Acs-Token"/.test(mainSrc0));
    check('B3 Yandex 走 yandex.ru', /yandex\.ru\/images\/search/.test(mainSrc0));
    check('B4 引擎表里有两家 upload',
        (imgSrc.match(/mode: Mode::Upload/g) || []).length >= 2);
    /* r61：按键模拟必须全撤（用户要求） */
    check('B5 已经没有 paste_into_browser（Ctrl+V 那套撤了）',
        mainSrc0.indexOf('fn paste_into_browser') < 0);
    /* r66 起用户明确要求 AI 引擎「粘贴 + 按 enter 来实现询问图片内容」，
     * 所以 Enter 回来了，但只对 AI 那四家（见 img_paste_into_browser）。 */
    check('B6 Enter 只出现在 AI 粘贴函数里（别的引擎仍不按 Enter）',
        (() => {
            const fnStart = mainSrc0.indexOf('fn img_paste_into_browser');
            const tail = mainSrc0.slice(fnStart, fnStart + 4000);
            const all = (mainSrc0.match(/send_hotkey\("enter"\)/g) || []).length;
            return fnStart >= 0 && tail.indexOf('send_hotkey("enter")') >= 0 && all === 1;
        })(),
        '全文出现 ' + (mainSrc0.match(/send_hotkey\("enter"\)/g) || []).length + ' 次');
    check('B7 也没有自动提交页那套', mainSrc0.indexOf('fn img_write_form_page') < 0);
    /* ================= C. 设置页：默认引擎自动勾选 + 勾选框不重叠 + 胶囊变小 ================= */
    rec('');
    rec('--- C. 设置页 ---');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    const env2 = Object.assign({}, env, { QS_INSTANCE_TAG: 'r59s' + Date.now().toString(36) });
    const p2 = spawn(EXE, ['--no-elevate', '--settings'], { env: env2, cwd: ROOT, stdio: 'ignore' });
    sleep(9000);
    const setWs = await connect('settings.html');
    if (!setWs) { rec('设置页连不上'); flush(); process.exit(1); }
    await ev(setWs, `document.querySelector('#tabs button[data-tab="imgsearch"]').click()`);
    await sleep(1500);

    // C1 勾选框和图标不重叠：两者的矩形不能相交
    const geo = await ev(setWs, `(function(){
        var row = document.querySelector('#w-imgEngList .img-row');
        if (!row) return 'no-row';
        var cb = row.querySelector('.eng-check input');
        var ico = row.querySelector('.eng-ico');
        var nm = row.querySelector('.n');
        if (!cb || !ico || !nm) return 'missing';
        var a = cb.getBoundingClientRect(), b = ico.getBoundingClientRect(), c = nm.getBoundingClientRect();
        var overlap = !(a.right <= b.left || b.right <= a.left);
        return JSON.stringify({
            cb:[Math.round(a.left),Math.round(a.right)], ico:[Math.round(b.left),Math.round(b.right)],
            nm:[Math.round(c.left),Math.round(c.right)], overlap: overlap,
            nmWidth: Math.round(c.width)
        });
    })()`);
    let g = {};
    try { g = JSON.parse(geo); } catch (e) { }
    rec('行内几何 = ' + geo);
    check('C1 勾选框与图标**不重叠**（矩形不相交）', g.overlap === false, geo);
    check('C2 名字那一格有实际宽度（没被挤成 0）', Number(g.nmWidth) > 60, String(g.nmWidth));

    // C3 点「设为默认」→ 该行复选框自动勾上
    const autoCheck = await ev(setWs, `(async function(){
        // 先把所有勾去掉
        var rows = Array.from(document.querySelectorAll('#w-imgEngList .img-row'));
        var target = rows.find(function(r){ return r.dataset.id === 'bing'; });
        if (!target) return 'no-bing';
        var cb = target.querySelector('.eng-check input');
        if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', {bubbles:true})); }
        await new Promise(function(r){ setTimeout(r, 300); });
        var before = cb.checked;
        var btn = target.querySelector('.eng-btn.def');
        if (!btn) return 'no-btn';
        btn.click();
        await new Promise(function(r){ setTimeout(r, 700); });
        return JSON.stringify({ before: before, after: cb.checked });
    })()`);
    let ac = {};
    try { ac = JSON.parse(autoCheck); } catch (e) { }
    rec('设为默认前后的勾选 = ' + autoCheck);
    check('C3 设成默认的那一家**自动被勾上**', ac.before === false && ac.after === true, autoCheck);

    // C4 添加胶囊变小：量高度（先点「＋ 添加引擎」把那一排放出来，
    //    否则 .addways 还是 hidden，量到的全是 0 —— 第一版就栽在这）
    await ev(setWs, `document.querySelector('#tabs button[data-tab="engines"]').click()`);
    await sleep(1000);
    await ev(setWs, `(function(){ var b = document.getElementById('btnAddEngine'); if (b) b.click(); return 'ok'; })()`);
    await sleep(800);
    const addway = await ev(setWs, `(function(){
        var a = document.querySelectorAll('.addway');
        if (!a.length) return 'none';
        var hs = Array.from(a).map(function(x){ return Math.round(x.getBoundingClientRect().height); });
        return JSON.stringify({ n: a.length, heights: hs, rowVisible: !document.getElementById('addWays').hidden });
    })()`);
    let aw = {};
    try { aw = JSON.parse(addway); } catch (e) { }
    rec('添加胶囊 = ' + addway);
    check('C4 三个添加胶囊都在', aw.n === 3, addway);
    check('C5 添加胶囊高度 ≤ 60px（改小之前约 88px）',
        Array.isArray(aw.heights) && aw.heights.every((h) => h > 0 && h <= 60), addway);

    /* ================= D. 识图图标 ================= */
    rec('');
    rec('--- D. 识图图标 ---');
    // ⚠ 不再去问那个已经随进程关掉的 barWs（对已关闭的 WS 发 CDP 会**永远等不到
    //   回应**，探针就卡死在那儿 —— 第一版正是这样挂了 400 秒）。
    //   图标是 index.html 里的字面量，直接读文件最可靠。
    const idx = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
    const btnM = /<button[^>]*id="btnImg"[\s\S]*?<\/button>/.exec(idx);
    const btn = btnM ? btnM[0] : '';
    rec('btnImg 片段长度 = ' + btn.length);
    check('D1 识图图标不再是文字放大镜 🔍', btn.indexOf('🔍') < 0 && btn.indexOf('🖼') < 0);
    check('D2 识图按钮里是内联 SVG（用户给的那张：四角取景框 + 放大镜）',
        /<svg[\s>]/.test(btn) && /<path[\s>]/.test(btn));
    check('D3 SVG 没有写死 fill（否则主题色/悬停失效）', btn.indexOf('fill="#') < 0, btn.slice(0, 200));
    const barCss = fs.readFileSync(path.join(ROOT, 'ui', 'bar.css'), 'utf8');
    /* r67 起尺寸从 15px 改成 1.02em —— 为了跟设置里「图标一致性」走同一个
     * --qs-btn（iconSize）。这里两种都接受，但优先按 em 验。 */
    check('D4 CSS 给 SVG 定了尺寸并让颜色跟着 currentColor 走',
        /\.ico\.qs-img svg\s*\{[^}]*width:\s*1\.02em/.test(barCss)
        && /fill:\s*currentColor/.test(barCss)
        && !/\.ico\.qs-img\s*\{\s*font-size:\s*\d/.test(barCss),
        'svg 尺寸没走 em，或 font-size 又被写死了');

    /* ================= E. 文件路径图标 ================= */
    rec('');
    rec('--- E. 文件路径图标 ---');
    // 横条那个 ws 已随第一个进程关掉，重新起一个实例来验路径。
    const r3 = spawn(EXE, ['--no-elevate'], { env: Object.assign({}, env, { QS_INSTANCE_TAG: 'r59b' + Date.now().toString(36) }), cwd: ROOT, stdio: 'ignore' });
    sleep(8000);
    const barWs2 = await connect('tauri.localhost/');
    if (barWs2) {
        const show = (text) => ev(barWs2, `(async function(){
            await window.__TAURI__.event.emit('qs://show', { text: ${JSON.stringify(text)}, hwnd: 0, via_copy: false, urls: [], isUrl: false });
            await new Promise(function(r){ setTimeout(r, 600); });
            return 'ok';
        })()`);
        const pathState = () => ev(barWs2, `(function(){
            var b = document.getElementById('btnPath');
            return b ? (b.hidden ? 'hidden' : 'visible') : 'missing';
        })()`);
        await show(USER_PATH);
        const st1 = await pathState();
        check('E1 选中你给的那条 OneDrive 中文目录 → 文件管理器图标**出现**', st1 === 'visible', st1);
        const titleOk = await ev(barWs2, `(function(){
            var b = document.getElementById('btnPath');
            return b ? b.title : '';
        })()`);
        check('E2 图标 title 里带着那条路径', String(titleOk).indexOf('377程子人才补贴材料') >= 0, String(titleOk));
        /* E3/E4：**不点那颗图标**（点了会真的拉起资源管理器窗口，挡住后续 CDP），
         * 改成直接问后端「这条路径能不能打开」—— 那是同一个 `open_path` 命令、
         * 同一条代码路径，只是绕开了鼠标事件。 */
        const opened = await ev(barWs2, `(async function(){
            try { return await window.__TAURI__.core.invoke('open_path', { path: ${JSON.stringify(USER_PATH)} }); }
            catch (e) { return 'ERR ' + e; }
        })()`);
        rec('open_path 返回 = ' + opened);
        check('E3 open_path 对这条 OneDrive 中文目录能正常打开（不是「找不到」）',
            String(opened).indexOf('找不到') < 0, String(opened));
        check('E4 后端回的是「已在文件管理器中打开/定位」',
            /已在文件管理器中(打开|定位)/.test(String(opened)), String(opened));
        try { barWs2.close(); } catch (e) { }
    } else {
        rec('E 组横条连不上，跳过');
        fail += 4;
    }
    try { r3.kill(); } catch (e) { }

    /* ================= F. 十字准星点选 ================= */
    rec('');
    rec('--- F. 十字准星点选 ---');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
    const gh = mainSrc.slice(mainSrc.indexOf('generate_handler!'), mainSrc.indexOf('];', mainSrc.indexOf('generate_handler!')));
    check('F1 pick_app_path_at 已注册', gh.indexOf('pick_app_path_at') >= 0);
    check('F2 open_app_picker 接受 want 参数', /fn open_app_picker\(want: Option<String>\)/.test(mainSrc));
    const pickerHtml = fs.readFileSync(path.join(ROOT, 'ui', 'picker.html'), 'utf8');
    check('F3 点选器认 want=path 并调 pick_app_path_at',
        /want=path/.test(pickerHtml) && pickerHtml.indexOf('pick_app_path_at') >= 0);
    const setHtml = fs.readFileSync(path.join(ROOT, 'ui', 'settings.html'), 'utf8');
    check('F4 设置页有「十字准星点选」按钮', setHtml.indexOf('btnCePickAppByClick') >= 0);
    check('F5 点选器是十字光标', /cursor:\s*crosshair/.test(fs.readFileSync(path.join(ROOT, 'ui', 'picker.html'), 'utf8'))
        || /cursor:\s*crosshair/.test(fs.readFileSync(path.join(ROOT, 'ui', 'region.html'), 'utf8')));

    /* ================= G. 设置页 Ctrl+C ================= */
    rec('');
    rec('--- G. 设置页 Ctrl+C 能唤出横条 ---');
    const fo = mainSrc.slice(mainSrc.indexOf('fn foreground_is_ours'), mainSrc.indexOf('fn window_is_labeled'));
    check('G1 foreground_is_ours 放行 settings 窗口', /window_is_labeled\(h, "settings"\)/.test(fo), fo.slice(0, 400));

    rec('');
    rec('========== r59：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    try { p2.kill(); } catch (e) { }
    await sleep(500);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
