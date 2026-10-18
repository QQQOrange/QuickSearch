/* 决定性验证：跑**桌面上那个 exe**（不是 target/release 那个），看 UI 到底是新是旧。
 * 之前所有探针都跑 target/release/QuickSearch.exe —— 如果那份和桌面那份不是同一份
 * （或嵌入的 UI 资源没跟着刷新），我验的就不是你看到的东西。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\64381', 'Desktop', 'QuickSearch.exe');
const EXE = fs.existsSync(DESKTOP) ? DESKTOP : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r69-desktop-check.txt');
const PORT = 9415;
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
    rec('跑的是：' + EXE);
    rec('桌面文件 MD5：' + (fs.existsSync(DESKTOP) ? require('crypto').createHash('md5').update(fs.readFileSync(DESKTOP)).digest('hex').toUpperCase() : '(不在)'));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-dt-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度'],
        apps: [{ id: 'a1', name: '测试软件', url: 'https://example.com/?q=%s', kind: 'search' }],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'dt' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: path.dirname(EXE), stdio: 'ignore' });
    rec('pid=' + proc.pid + '  cwd=' + path.dirname(EXE));
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('连不上'); process.exit(1); }

    await ev(ws, `window.__TAURI__.event.emit('qs://show', { text: 'x', hwnd: 0, via_copy: false, urls: [], isUrl: false })`);
    await sleep(500);
    await ev(ws, `document.getElementById('btnMore').click()`);
    await sleep(1500);

    const r = JSON.parse(await ev(ws, `(function(){
        var panel = document.getElementById('panel');
        return JSON.stringify({
            maxHeight: panel ? (panel.style.maxHeight || '(未设)') : 'no-panel',
            hasBtnSettings: !!document.getElementById('btnSettings')
        });
    })()`));
    rec('桌面 exe 跑起来：' + JSON.stringify(r));
    check('桌面 exe 里也有 maxHeight（r69 的改动）', r.maxHeight !== '(未设)' && r.maxHeight !== 'no-panel', r.maxHeight);

    try { proc.kill(); } catch (e) { }
    await sleep(400);
    rec('========== ' + pass + ' PASS / ' + fail + ' FAIL ==========');
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
