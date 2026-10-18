/* r70：打开横条 + 更多引擎面板 + 识图设置页，逐段截图用的探针。
 * 用法: node tools/r70-shots.js  （跑完留着进程，外部截图后 taskkill） */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9417;
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r70p-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度', 'Google'],
        imgEnable: true, imgEngines: ['baidu', 'yandex', 'saucenao', 'bing'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r70p' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    console.log('pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { console.log('连不上横条'); process.exit(1); }

    // 1) 唤出横条（带锚点，窗口才会真缩放）
    await ev(ws, `window.__TAURI__.core.invoke('show_bar', { text: '测试', atMouse: true, viaCopy: false })`);
    await sleep(1200);
    // 2) 打开更多引擎面板
    await ev(ws, `document.getElementById('btnMore').click()`);
    await sleep(2000);
    // 3) 点「软件引擎」胶囊，复现设置按钮问题
    await ev(ws, `(function(){
        var bs = Array.from(document.querySelectorAll('.panel-sticky .grp-item'));
        var b = bs.find(function(x){ return x.textContent.indexOf('软件引擎') >= 0; });
        if (b) b.click();
        return b ? 'clicked 软件引擎' : 'NOT FOUND';
    })()`);
    await sleep(1500);
    // 4) 量一下关键几何：按钮在不在窗口里
    const geo = await ev(ws, `(function(){
        var b = document.getElementById('btnSettings');
        var panel = document.getElementById('panel');
        var r = b.getBoundingClientRect();
        var pr = panel.getBoundingClientRect();
        return JSON.stringify({
            vh: window.innerHeight,
            btnBottom: Math.round(r.bottom), btnTop: Math.round(r.top),
            panelBottom: Math.round(pr.bottom), panelTop: Math.round(pr.top),
            panelMaxH: panel.style.maxHeight || '(未设)',
            footInsideWindow: r.bottom <= window.innerHeight,
            footInsidePanel: r.bottom <= pr.bottom + 1,
            barRoomBelow: (typeof barRoomBelow !== 'undefined') ? barRoomBelow : 'N/A',
            bodyScrollH: document.getElementById('panelBody').scrollHeight,
            bodyClientH: document.getElementById('panelBody').clientHeight
        });
    })()`);
    console.log('GEO ' + geo);
    console.log('READY_PANEL');
    setInterval(() => { }, 120000);
})().catch((e) => { console.log('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
