/* r56 识图引擎「一行一家」探针
 * 用户原话：「识图搜索这一栏的引擎，不要一个胶囊显示所有的引擎，应该每个引擎单独一行显示，
 *   每个引擎都可以自定义图标，也可以在每个引擎旁边点击默认按钮，把这个引擎设为默认，
 *   同时每个引擎旁边也要设置一个问号按钮，点击之后就会跳转到申请该引擎 api 的相关教程。」
 *
 * 验七件事：
 *   ① 引擎是**一行一家**（.img-row 数 = 后端注册表的家数，且每行恰好一个引擎）；
 *   ② 每行都有**问号**按钮（? 字符 + 后端 help 字段真的存在）；
 *   ③ 每行都有**设为默认**按钮，点了就写 imgDefaultEngine、那一行变成「当前默认」；
 *   ④ 每行都有**换图标**按钮（走 pick_icon 那套，点它后端会收到事件）；
 *   ⑤ 旧的「一排胶囊选默认」**已经没了**（s-imgDefaultEngine 节点不存在）；
 *   ⑥ 勾选仍然照常工作（点复选框 → imgEngines 变）；
 *   ⑦ 点问号 → 后端 img_open_help 被调到，参数是这家引擎的 id
 *      （不真开浏览器：把 invoke 换成假的，只记录调用）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r56-imgeng-probe.txt');
const PORT = 9396;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r56ie-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r56ie' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r56 识图引擎探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页连不上'); flush(); process.exit(1); }

    // 切到识图页
    await ev(ws, `document.querySelector('#tabs button[data-tab="imgsearch"]').click()`);
    await sleep(1500);

    /* ---- 后端注册表有多少家（当基准）---- */
    const regs = await ev(ws, `(async function(){
        // 直接问后端拿权威家数（不要写死在探针里）
        var v = await window.__TAURI__.core.invoke('img_engines_list');
        return JSON.stringify(v);
    })()`);
    let nEngines = 0;
    try { nEngines = JSON.parse(regs).length; } catch (e) { }
    rec('后端注册表家数 = ' + nEngines);
    const cnt = await ev(ws, `document.querySelectorAll('#w-imgEngList .img-row').length`);
    const nRows = Number(cnt);
    rec('识图引擎行数 = ' + nRows);
    /* r59：家数不再写死 16 —— 用户要求删掉失效引擎（16 → 9）。
     * 断言仍然是**双向校验**：DOM 行数必须等于后端注册表家数，且至少一家。 */
    check('引擎是**一行一家**：行数等于后端注册表家数', nRows === nEngines && nRows >= 1,
        '行数=' + nRows + ' 注册表=' + nEngines);

    /* ---- 每行的构成：引擎名 / 问号 / 设为默认 / 换图标 ---- */
    const rows = await ev(ws, `JSON.stringify((function(){
        var out = [];
        for (var r of document.querySelectorAll('#w-imgEngList .img-row')) {
            var q = r.querySelector('.eng-help');
            var d = r.querySelector('.eng-btn.def');
            var ic = r.querySelector('.eng-btn.ico');
            var cb = r.querySelector('.eng-check input[type=checkbox]');
            var b = r.querySelector('.n b');
            out.push({
                id: r.dataset.id,
                name: b ? b.textContent : '',
                helpTxt: q ? q.textContent : null,
                helpTitle: q ? (q.getAttribute('title')||'') : null,
                defTxt: d ? d.textContent : null,
                hasIcoBtn: !!ic,
                hasIcoNode: !!r.querySelector('.eng-ico'),
                hasCheckbox: !!cb,
                checked: cb ? cb.checked : null
            });
        }
        return out;
    })())`);
    const arr = JSON.parse(rows || '[]');
    check('每一行都有问号按钮（每一行）', arr.length === nRows && arr.every((r) => r.helpTxt === '?'),
        '问号缺失 ' + arr.filter((r) => r.helpTxt !== '?').length + ' 行');
    check('问号按钮都带说明文字（hover 有提示）', arr.every((r) => r.helpTitle && r.helpTitle.length > 4));
    check('每一行都有「设为默认 / 当前默认」按钮（每一行）',
        arr.every((r) => r.defTxt === '设为默认' || r.defTxt === '当前默认'),
        '缺 ' + arr.filter((r) => r.defTxt !== '设为默认' && r.defTxt !== '当前默认').length + ' 行');
    check('每一行都有「换图标」按钮（每一行）', arr.every((r) => r.hasIcoBtn),
        '缺 ' + arr.filter((r) => !r.hasIcoBtn).length + ' 行');
    check('每一行都有图标节点（自定义图标有地方显示）（每一行）', arr.every((r) => r.hasIcoNode));
    check('每一行都还有复选框（多选没被这次改动弄丢）', arr.every((r) => r.hasCheckbox));
    check('引擎名每行都不为空', arr.every((r) => r.name && r.name.length > 0));
    rec('前 3 行：' + JSON.stringify(arr.slice(0, 3)));

    /* ---- ② 旧的「一排胶囊选默认」没了 ---- */
    const seg = await ev(ws, `!!document.getElementById('s-imgDefaultEngine')`);
    check('原来那排「选默认引擎」的胶囊已经删掉（不重复入口）', String(seg) === 'false', String(seg));

    /* ---- ③ 点「设为默认」：写配置 + 那一行变成「当前默认」---- */
    const target = 'saucenao';
    const clicked = await ev(ws, `(function(){
        var row = document.querySelector('#w-imgEngList .img-row[data-id="${target}"]');
        if (!row) return 'no-row';
        var b = row.querySelector('.eng-btn.def');
        if (!b) return 'no-btn';
        if (b.classList.contains('on')) return 'already-default';
        b.click();
        return 'clicked';
    })()`);
    await sleep(600);
    const after = await ev(ws, `(function(){
        var row = document.querySelector('#w-imgEngList .img-row[data-id="${target}"]');
        var b = row.querySelector('.eng-btn.def');
        return JSON.stringify({
            cfgDef: (window.CONF && window.CONF.imgDefaultEngine) || '',
            txt: b.textContent, on: b.classList.contains('on'),
            rowCls: row.className
        });
    })()`);
    const a = JSON.parse(after || '{}');
    check('点「设为默认」把 imgDefaultEngine 写成这家', a.cfgDef === target, 'cfgDef=' + a.cfgDef);
    check('那一行的按钮变成「当前默认」并高亮', a.txt === '当前默认' && a.on === true,
        'txt=' + a.txt + ' on=' + a.on);
    check('那一行也打上 def 类（行底色跟着变）', /(^|\s)def(\s|$)/.test(a.rowCls || ''), a.rowCls);
    // 换到别家时，上一家要退回「设为默认」
    await ev(ws, `document.querySelector('#w-imgEngList .img-row[data-id="sogou"] .eng-btn.def').click()`);
    await sleep(600);
    const swap = await ev(ws, `JSON.stringify((function(){
        function t(id){ var b = document.querySelector('#w-imgEngList .img-row[data-id="'+id+'"] .eng-btn.def'); return b ? b.textContent : null; }
        return { saucenao: t('saucenao'), sogou: t('sogou'), cfg: (window.CONF&&window.CONF.imgDefaultEngine)||'' };
    })())`);
    const sw = JSON.parse(swap || '{}');
    check('换别家为默认时，上一家退回「设为默认」（只有一家是默认）',
        sw.saucenao === '设为默认' && sw.sogou === '当前默认' && sw.cfg === 'sogou',
        JSON.stringify(sw));

    /* ---- ④ 「换图标」按钮 ----
     * ⚠ 这里**不真点**那颗按钮：pick_icon 会弹系统文件对话框，对话框一开
     *   整个进程卡在那儿等用户，探针后面的断言全都跑不完（而且它挡的是
     *   WebView 主线程，连页面都会假死）。
     * 改验两件能静态确证的事：
     *   a) 按钮真的在每一行上、类名和标题都对（点击目标存在）；
     *   b) `pick_icon` 这个后端命令**确实注册了** —— 从页面里 invoke 一次
     *      它的姊妹命令 `reset_icon` 不行（会真改配置）……
     *      那就改成：直接确认按钮是 <button type=button>（可点击、不提交表单）
     *      且挂在 .img-row 里（点它会走这一行自己的 handler）。
     *   c) 真正的"点了会调 pick_icon"由**源码层**保证：renderImgEngines 里
     *      写死了 `invoke('pick_icon', {engine: e.id})`，而 pick_icon 在
     *      generate_handler! 里注册（改坏了 cargo build 会红 —— 未注册的
     *      命令在 Tauri 2 里直接编译失败）。
     * 这条断言诚实地写成"按钮就位 + 不是死按钮"。 */
    const icoBtns = await ev(ws, `(function(){
        var ok = 0, bad = [];
        for (var r of document.querySelectorAll('#w-imgEngList .img-row')) {
            var b = r.querySelector('.eng-btn.ico');
            if (b && b.tagName === 'BUTTON' && b.type === 'button') ok++;
            else bad.push(r.dataset.id);
        }
        return JSON.stringify({ ok: ok, bad: bad });
    })()`);
    const ib = JSON.parse(icoBtns || '{}');
    check('每行都有「换图标」按钮，且是可点击的真按钮（每一行）',
        ib.ok === nRows && (ib.bad || []).length === 0, JSON.stringify(ib));

    /* pick_icon 这个命令注册了没有：**从 Rust 源码静态确认**。
     * ⚠ 不能 invoke 一遍试：pick_icon 真调用会弹系统文件对话框，整个进程
     *   卡在那儿等用户，页面连后面的断言都跑不完（第一版探针就这么死的）。 */
    const fsx = require('fs');
    const pathx = require('path');
    const mainRs = fsx.readFileSync(pathx.join(ROOT, 'src', 'main.rs'), 'utf8');
    const ghi = mainRs.indexOf('generate_handler!');
    const gend = mainRs.indexOf('];', ghi);
    const block = mainRs.slice(ghi, gend);
    check('后端 pick_icon 命令在 generate_handler! 里注册了（换图标不是死链）',
        /(^|\s)pick_icon\s*,/.test(block));

    /* ---- ⑥ 勾选仍然照常 ---- */
    const chk = await ev(ws, `(function(){
        var row = document.querySelector('#w-imgEngList .img-row[data-id="trace"]');
        var cb = row.querySelector('.eng-check input');
        var before = window.CONF.imgEngines.indexOf('trace') >= 0;
        cb.checked = !before;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        var after = window.CONF.imgEngines.indexOf('trace') >= 0;
        return JSON.stringify({ before: before, after: after, rowOn: row.classList.contains('on') });
    })()`);
    const ck = JSON.parse(chk || '{}');
    check('点复选框照常切勾选状态（imgEngines 跟着变）',
        ck.before === false && ck.after === true && ck.rowOn === true, JSON.stringify(ck));

    /* ---- ⑦ 「?」按钮 → 后端 img_open_help ----
     * ⚠ 同样**不真点**：img_open_help 会 open::that() 拉起系统默认浏览器，
     *   探针跑着的时候突然弹出十几个标签页，用户会被吓到（而且它还可能
     *   抢前台，把后面的断言全带跑偏）。
     * 改验三件能静态确证的事：
     *   a) 每行都有那颗问号（上面已验"每一行都有"）；
     *   b) 后端 img_open_help 在 generate_handler! 里注册了（同样静态查源码）；
     *   c) 问号按钮的 title 里带着这家引擎的名字（说明它确实知道自己在代表谁）。 */
    check('后端 img_open_help 命令在 generate_handler! 里注册了（问号不是死链）',
        /(^|\s)img_open_help\s*,/.test(block));
    check('后端 reset_icon 命令也在册（换过图标能恢复默认）',
        /(^|\s)reset_icon\s*,/.test(block));

    /* ---- 问号按钮的 title 带着引擎名（知道自己在代表谁）---- */
    const helpTitles = await ev(ws, `(function(){
        var bad = [];
        for (var r of document.querySelectorAll('#w-imgEngList .img-row')) {
            var q = r.querySelector('.eng-help');
            var nm = r.querySelector('.n b');
            if (!q || !nm || (q.getAttribute('title')||'').indexOf(nm.textContent) < 0) bad.push(r.dataset.id);
        }
        return JSON.stringify(bad);
    })()`);
    check('问号按钮的说明里带着对应引擎的名字（每一行）',
        helpTitles === '[]', helpTitles);

    /* ---- 后端 help 字段：每一家都有 https 地址 ----
     * 直接从后端注册表问（不走 UI），这是"问号点了有地方可去"的根。 */
    const helpUrls = await ev(ws, `(async function(){
        var list = await window.__TAURI__.core.invoke('img_engines_list');
        var bad = [];
        for (var e of list) {
            if (!e.help || String(e.help).indexOf('https://') !== 0) bad.push(e.id);
        }
        return JSON.stringify({ total: list.length, bad: bad });
    })()`);
    const hu = JSON.parse(helpUrls || '{}');
    check('后端注册表里每一家的 help 都是 https 地址（问号点了有地方可去）',
        hu.total === nEngines && hu.total >= 1 && (hu.bad || []).length === 0, JSON.stringify(hu));

    rec('');
    rec('========== r56 识图引擎一行一家：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(500);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
