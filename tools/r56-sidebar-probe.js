/* r56 布局验针：左侧目录 + 点击跳转
 * 用户原话：「设置当中的设置目录放左边，点击了哪一项，跳转到哪一项」。
 * 这里验四件事：
 *   ① 目录**真的在左边**（用坐标说话：nav 的右边缘 <= main 的左边缘）；
 *   ② 目录是**竖着排**的（十颗按钮的 x 基本相同、y 单调递增）；
 *   ③ 点哪一项就跳到哪一项（十颗逐个点，各自的内容页真的显示出来）；
 *   ④ 目录在、内容也在，**没有互相遮挡**（main 的宽度还够用，没被挤没）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r56-sidebar-probe.txt');
const PORT = 9395;
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
    return r.exceptionDetails ? 'ERR ' + r.exceptionDetails.text : r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r56sb-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r56sb' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r56 左侧目录探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页连不上'); flush(); process.exit(1); }

    /* ---- ① 目录在左、内容在右 ---- */
    const geo = await ev(ws, `JSON.stringify((function(){
        var nav = document.getElementById('tabs');
        var main = document.getElementById('main');
        var shell = document.querySelector('.shell');
        if (!nav || !main) return null;
        var n = nav.getBoundingClientRect(), m = main.getBoundingClientRect();
        var s = shell ? shell.getBoundingClientRect() : null;
        return { navRight: n.right, navLeft: n.left, navW: n.width, navTop: n.top, navBottom: n.bottom,
                 mainLeft: m.left, mainW: m.width, mainH: m.height,
                 shellDir: shell ? getComputedStyle(shell).flexDirection : '' };
    })())`);
    const g = JSON.parse(geo || '{}');
    rec('几何：' + JSON.stringify(g));
    check('目录（#tabs）在左边：它的右边缘不越过内容区左边缘', g.navRight <= g.mainLeft + 1,
        'navRight=' + g.navRight + ' mainLeft=' + g.mainLeft);
    check('目录有实际宽度（没被挤成 0）', g.navW >= 120, g.navW);
    check('内容区也还有宽度（没被目录挤没）', g.mainW >= 300, g.mainW);
    check('.shell 是横着排的（flex-direction: row）', g.shellDir === 'row', g.shellDir);

    /* ---- ② 竖着排 ---- */
    const rows = await ev(ws, `JSON.stringify((function(){
        var out = [];
        for (var b of document.querySelectorAll('#tabs button[data-tab]')) {
            var r = b.getBoundingClientRect();
            out.push({ tab: b.dataset.tab, x: Math.round(r.left), y: Math.round(r.top),
                       w: Math.round(r.width), h: Math.round(r.height) });
        }
        return out;
    })())`);
    const arr = JSON.parse(rows || '[]');
    check('十颗目录项都量到了', arr.length === 10, arr.length);
    const xs = arr.map((r) => r.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    check('十颗的 x 基本相同（= 竖着一列，不是横着一排）', spread <= 2, 'x 跨度=' + spread);
    let mono = true;
    for (let i = 1; i < arr.length; i++) if (arr[i].y <= arr[i - 1].y) mono = false;
    check('十颗的 y 严格递增（顺序 = 从上到下）', mono);
    check('每颗的高度足够当点击目标（>= 28px）', arr.every((r) => r.h >= 28),
        '最矮 ' + Math.min(...arr.map((r) => r.h)));
    rec('目录几何（前 3 颗）：' + JSON.stringify(arr.slice(0, 3)));

    /* ---- ③ 点哪一项跳到哪一项 ---- */
    const want = ['general', 'engines', 'ai', 'ocr', 'imgsearch', 'fav', 'data', 'backup', 'help', 'about'];
    let bad = [];
    for (const t of want) {
        await ev(ws, `document.querySelector('#tabs button[data-tab="${t}"]').click()`);
        await sleep(320);
        const st = await ev(ws, `(function(){
            var p = document.querySelector('.pane[data-pane="${t}"]');
            var on = document.querySelector('#tabs button[data-tab="${t}"]');
            return JSON.stringify({ shown: p ? !p.hidden : false, lit: on ? on.classList.contains('on') : false });
        })()`);
        const s = JSON.parse(st || '{}');
        if (!s.shown) bad.push(t + '(页没显示)');
        if (!s.lit) bad.push(t + '(目录没点亮)');
    }
    check('十颗逐个点：每一项的内容页都显示、目录都点亮（点哪项跳哪项）',
        bad.length === 0, bad.join(' '));

    /* ---- ④ 选中项有可见指示（左边那根竖条）---- */
    const mark = await ev(ws, `(function(){
        var b = document.querySelector('#tabs button[data-tab="about"]');
        var cs = getComputedStyle(b, '::after');
        return cs.content + '|' + cs.width + '|' + cs.backgroundColor;
    })()`);
    check('选中项有 ::after 指示条（左边竖条，非 none）',
        String(mark).indexOf('none') < 0 && String(mark).indexOf('|') > 0, String(mark));

    /* ---- ⑤ 图标还在（r55 的成果没被这次布局改掉）---- */
    const icons = await ev(ws, `document.querySelectorAll('#tabs .tb-i').length`);
    check('目录项前的装饰图标还在（十颗都有）', Number(icons) === 10, icons);

    rec('');
    rec('========== r56 左侧目录：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(500);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
