/* ============================================================================
 *  r76-bis：OCR 遮罩打不开 —— 精确定位是哪一条 return 拦的
 *
 *  现象（tools/r76-ocr-img-diag.js 复现）：`ocr_start` invoke 返回 ok，但日志里
 *  **一条 region: 都没有** —— 说明 ocr_start_flow 在 open_region_window_mode
 *  之前就 return 了。识图（img_start）同一条路却能开，差别只在
 *  ocr_start_flow 开头那几道检查。
 *
 *  这个探针不猜：把 ocr_start_flow 里**每一道闸门**的输入都打出来
 *  （ocr_enable / ocr_engine / ocr_engine_plan / creds_ready…），
 *  并直接调用那些纯函数看返回什么。
 *
 *  用法：node tools/r76-ocr-gate.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r76-ocr-gate.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 15000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (!x || x.id !== i) return;
            clearTimeout(timer); ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
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
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) { if (await ev(ws, expr) === true) return true; await sleep(200); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r76b-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    // 故意写成**最小配置**（与 r76-ocr-img-diag 相同形状），复现用户那条路
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, theme: 'light', ocr_enable: true, img_enable: true }, null, 1), 'utf8');
    rec('r76-bis OCR 闸门定位：配置 = ' + fs.readFileSync(path.join(qs, 'config.json'), 'utf8').replace(/\s+/g, ' '));
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r76b' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 30000);

        // 把 ocr_start_flow 的每一道闸门的**输入**打出来
        const g = await ev(sw, "window.__TAURI__.core.invoke('get_config').then(function(c){return JSON.stringify({\
            ocr_enable: c.ocrEnable, ocr_engine: c.ocr_engine, ocr_multi: c.ocrMulti, \
            ocr_key: (c.ocr_key||'').length, ocr_secret: (c.ocr_secret||'').length, \
            img_enable: c.imgEnable, img_engines: (c.imgEngines||[]).length \
        });})");
        rec('配置里的 OCR 闸门输入：' + g);

        // 直接问后端：这一轮 OCR 会跑哪几家、凭据齐没齐
        // （这两个是纯函数，但没暴露成命令；用日志侧证 —— 先调 ocr_start 再看日志）
        rec('调用 ocr_start …');
        const r = await ev(sw, "window.__TAURI__.core.invoke('ocr_start').then(function(){return 'ok';}).catch(function(e){return 'ERR '+e;})");
        rec('  返回：' + r);
        await sleep(4000);
        const logf = path.join(qs, 'log.txt');
        let lines = [];
        try { lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/); } catch (e) { }
        const ocrLines = lines.filter((l) => /ocr|region|OCR/.test(l)).slice(-25);
        rec('日志里 ocr/region 相关（后 25 条）：');
        for (const l of ocrLines) rec('  ' + l.replace(/^\[SystemTime \{[^}]*\}\]\s*/, ''));
        rec('');
        rec('判断：');
        rec('  · 有 "region: 主线程闭包开始装配 builder" → 遮罩那条路走到了');
        rec('  · 只有 "还没配…的凭据" / "OCR 功能已在设置里关闭" → 被闸门拦了');
        rec('  · 一条都没有 → 在 open_region_window_mode 之前就静默 return（或线程没起来）');

        // 对照组：识图
        rec('');
        rec('对照组 img_start …');
        const r2 = await ev(sw, "window.__TAURI__.core.invoke('img_start').then(function(){return 'ok';}).catch(function(e){return 'ERR '+e;})");
        rec('  返回：' + r2);
        await sleep(4000);
        try { lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/); } catch (e) { }
        const imgLines = lines.filter((l) => /region/.test(l)).slice(-6);
        rec('img_start 之后的 region 日志：');
        for (const l of imgLines) rec('  ' + l.replace(/^\[SystemTime \{[^}]*\}\]\s*/, ''));
    } catch (e) {
        rec('出错：' + (e && e.message));
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();