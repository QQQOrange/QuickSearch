/* r70 识图图标尺寸精查：布局尺寸 vs 变换后尺寸 vs 邻居 <img> 图标。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9419;
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
    return r.exceptionDetails ? 'ERR' : r.result.value;
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r70i-'));
    fs.mkdirSync(path.join(tmp, 'QuickSearch'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'QuickSearch', 'config.json'),
        JSON.stringify({ debug: true, bar_list: ['百度', 'Google'], imgEnable: true, imgAddToBar: true }), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r70i' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { console.log('连不上'); process.exit(1); }
    await ev(ws, `window.__TAURI__.core.invoke('show_bar', { text: 'x', atMouse: true, viaCopy: false })`);
    await sleep(1500);
    const out = await ev(ws, `(function(){
        var b = document.getElementById('btnImg');
        var svg = b.querySelector('svg');
        var br = b.getBoundingClientRect();
        var cs = getComputedStyle(svg);
        // 邻居：引擎格子里的 <img>（走 .ico > img）
        var eng = document.querySelector('.engines .ico');
        var engImg = eng ? eng.querySelector('img') : null;
        var ei = engImg ? { w: Math.round(engImg.getBoundingClientRect().width),
                             offsetW: engImg.offsetWidth,
                             optical: engImg.style.getPropertyValue('--qs-optical') || '(未设)' } : null;
        return JSON.stringify({
            btn: { w: Math.round(br.width), h: Math.round(br.height) },
            qsBtn: getComputedStyle(document.getElementById('stage')).getPropertyValue('--qs-btn').trim(),
            svg: {
                rectW: Math.round(svg.getBoundingClientRect().width),
                offsetW: svg.offsetWidth, offsetH: svg.offsetHeight,
                cssW: cs.width, cssH: cs.height,
                transform: cs.transform,
                optical: svg.style.getPropertyValue('--qs-optical') || '(未设)',
            },
            neighborImg: ei,
        }, null, 1);
    })()`);
    console.log(out);
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    process.exit(0);
})().catch((e) => { console.log('崩了：' + e); process.exit(2); });
