/* r70：打开设置页并切到引擎分页，停住不退出（供外部截图）。
 * 用法: node tools/r70-open-engines.js  （跑完会留着进程，外部截图后自行 taskkill） */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9415;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r70s-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度', 'Google'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r70s' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    console.log('已启动设置页 pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { console.log('连不上'); process.exit(1); }
    const r = await ev(ws, `(function(){
        var b = document.querySelector('.nav [data-tab="engines"]');
        if (!b) { var ns = document.querySelectorAll('.nav button, .nav a'); for (var n of ns) if ((n.textContent||'').indexOf('引擎') >= 0) { b = n; break; } }
        if (b) b.click();
        return b ? 'clicked' : 'NOT FOUND';
    })()`);
    console.log('切到引擎分页: ' + r);
    // 滚到引擎库那一节
    await ev(ws, `(function(){ var s = document.getElementById('sec-lib'); if (s) s.scrollIntoView({block:'start'}); return 'ok'; })()`);
    await sleep(1500);
    console.log('READY_FOR_SCREENSHOT');
    // 不退出：把进程留着，父脚本负责截图和清理
    setInterval(() => { }, 60000);
})().catch((e) => { console.log('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
