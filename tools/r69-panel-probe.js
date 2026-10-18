/* r69：更多引擎面板里，点了大类胶囊之后「设置…」按钮还在不在。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r69-panel-probe.txt');
const PORT = 9413;
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
const FOOT = `(function(){
    var b = document.getElementById('btnSettings');
    var panel = document.getElementById('panel');
    if (!b || !panel) return JSON.stringify({exists:false});
    var r = b.getBoundingClientRect();
    var pr = panel.getBoundingClientRect();
    var cs = getComputedStyle(b);
    var foot = document.querySelector('.panel-foot');
    return JSON.stringify({
        exists:true,
        display: cs.display, visibility: cs.visibility,
        maxHeight: panel.style.maxHeight || '(未设)',
        panelH: Math.round(pr.height),
        // 底栏在面板框内 = 不会被面板自身撑出去（窗口另说）
        footInsidePanel: Math.round(r.bottom) <= Math.round(pr.bottom) + 1,
        footTop: Math.round(r.top), panelTop: Math.round(pr.top),
        panelBottom: Math.round(pr.bottom),
        vh: window.innerHeight,
        availH: (window.screen && screen.availHeight) || 0
    });
})()`;
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r69-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        bar_list: ['百度', 'Google'],
        apps: [{ id: 'a1', name: '测试软件', url: 'https://example.com/?q=%s', kind: 'search' }],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r69' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r69 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('连不上'); process.exit(1); }

    await ev(ws, `window.__TAURI__.event.emit('qs://show', { text: 'x', hwnd: 0, via_copy: false, urls: [], isUrl: false })`);
    await sleep(500);
    await ev(ws, `document.getElementById('btnMore').click()`);
    await sleep(1500);

    const f0 = JSON.parse(await ev(ws, FOOT));
    rec('打开面板：' + JSON.stringify(f0));
    check('P0 「设置…」存在且可见', f0.exists && f0.display !== 'none' && f0.visibility === 'visible', JSON.stringify(f0));
    check('P0b 面板已按屏幕设了 maxHeight（收藏面板 r52 修过，引擎面板 r69 补上）',
        f0.maxHeight !== '(未设)' && parseInt(f0.maxHeight, 10) > 0, f0.maxHeight);
    check('P0c 底栏在面板框内（不会被面板自身撑出去）', f0.footInsidePanel === true, JSON.stringify(f0));

    for (const [grp, label] of [['web', '网页引擎'], ['app', '软件引擎'], ['hotkey', '快捷键引擎'], [null, '全部引擎']]) {
        await ev(ws, `(function(){
            var bs = Array.from(document.querySelectorAll('.panel-sticky .grp-item'));
            var b = bs.find(function(x){ return x.textContent.indexOf(${JSON.stringify(label)}) >= 0; });
            if (b) b.click();
            return 'ok';
        })()`);
        await sleep(1200);
        const f = JSON.parse(await ev(ws, FOOT));
        rec('点「' + label + '」后：' + JSON.stringify(f));
        check('P1 点「' + label + '」后「设置…」仍存在且可见',
            f.exists && f.display !== 'none' && f.visibility === 'visible', JSON.stringify(f));
        check('P2 点「' + label + '」后底栏仍在面板框内', f.footInsidePanel === true, JSON.stringify(f));
        check('P3 点「' + label + '」后 maxHeight 还在（不会被重画清掉）',
            f.maxHeight !== '(未设)', f.maxHeight);
    }

    rec('========== r69 面板设置按钮：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(400);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
