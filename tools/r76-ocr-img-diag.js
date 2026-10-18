/* ============================================================================
 *  r76：OCR / 识图「点了没反应」诊断探针
 *
 *  用户报的现象：设置页点「开始框选识别」、横条点 OCR、横条点识图，**三条路都
 *  完全不工作**。这个探针不猜，直接把每条路走一遍并在每一站记证据：
 *    ① 前端命令是否注册到位（invoke 有没有被拒）
 *    ② 遮罩窗口 region 有没有真的被建出来（CDP 连上 + 心跳日志）
 *    ③ 框选一条命令发出去，遮罩是否关闭、Rust 是否收到坐标
 *    ④ 日志里 region 相关的全部记录
 *
 *  用法：node tools/r76-ocr-img-diag.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r76-ocr-img-diag.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 12000);
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
async function targets() { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); } catch (e) { return []; } }
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
        const ts = await targets();
        const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
        if (hit) {
            const ws = new WebSocket(hit.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            return ws;
        }
        await sleep(300);
    }
    return null;
}
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) { if (await ev(ws, expr) === true) return true; await sleep(200); }
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r76-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light', ocr_enable: true, img_enable: true }, null, 1), 'utf8');
    rec('r76 OCR/识图诊断：临时 APPDATA=' + tmp);

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r76' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    // 用 --bar 起（横条页 + 设置页都可能建），并直接开设置页
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('实例 pid=' + proc.pid);
    const logf = path.join(qs, 'log.txt');
    const logTail = (n) => { try { return fs.readFileSync(logf, 'utf8').split(/\r?\n/).slice(-n).join('\n'); } catch (e) { return '(读不到日志)'; } };

    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页（第一步就失败）'); return; }
        await until(sw, "typeof CATALOG === 'object' && !!CATALOG.categories", 30000);

        // ① 命令是否注册
        const cmdExists = await ev(sw, `(function(){
            var need = ['ocr_start','img_start','ocr_region','img_region','ocr_cancel','region_beat'];
            var out = {};
            for (var i=0;i<need.length;i++){
                var n = need[i];
                out[n] = (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core && window.__TAURI__.core.invoke) ? 'has-invoke' : 'NO-INVOKE';
            }
            return JSON.stringify(out);
        })()`);
        rec('① invoke 通道：' + cmdExists);

        // ② 走 OCR 那条路（ocr_start 内部 spawn → open_region_window_mode）
        rec('② 调用 ocr_start …');
        const r2 = await ev(sw, "window.__TAURI__.core.invoke('ocr_start').then(function(){return 'ok';}).catch(function(e){return 'ERR '+((e&&e.message)||e);})");
        rec('   ocr_start 返回：' + r2);
        let region = null;
        const t2 = Date.now();
        while (Date.now() - t2 < 12000 && !region) {
            const ts = await targets();
            const hit = ts.find((t) => (t.url || '').indexOf('region.html') >= 0);
            if (hit) region = hit;
            else await sleep(300);
        }
        rec('   遮罩窗口 region.html：' + (region ? '出来了（' + region.url + '）' : '没出来'));
        if (!region) {
            rec('   —— 没出遮罩，看日志 ——');
            rec('   ' + logTail(25).split('\n').filter((l) => /region|ocr|img/.test(l)).slice(-12).join('\n   '));
            // 识图那条路也试一下
            rec('③ 调用 img_start …');
            const r3 = await ev(sw, "window.__TAURI__.core.invoke('img_start').then(function(){return 'ok';}).catch(function(e){return 'ERR '+((e&&e.message)||e);})");
            rec('   img_start 返回：' + r3);
            const t3 = Date.now();
            let region2 = null;
            while (Date.now() - t3 < 12000 && !region2) {
                const ts = await targets();
                const hit = ts.find((t) => (t.url || '').indexOf('region.html') >= 0);
                if (hit) region2 = hit;
                else await sleep(300);
            }
            rec('   遮罩窗口 region.html：' + (region2 ? '出来了' : '也没出来'));
            rec('   —— 再次看日志 ——');
            rec('   ' + logTail(30).split('\n').filter((l) => /region|ocr|img/.test(l)).slice(-15).join('\n   '));
            return;
        }

        const ws = new WebSocket(region.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
        });
        await cdp(ws, 'Runtime.enable');
        rec('   遮罩页面日志行数：' + (await ev(ws, "document.querySelectorAll('*').length > 0")));
        // 从这里读页面里 jlog 出来的信息（走 log_msg，已经在 logTail 里）
        // 直接模拟一次框选（给页面发 mouseup 之前先 mousedown/move）
        rec('④ 模拟一次框选 → ocr_region');
        const r4 = await ev(ws, `(function(){
            var d = document;
            function ev2(t, x, y){ d.dispatchEvent(new MouseEvent(t, {clientX:x, clientY:y, button:0, bubbles:true, cancelable:true})); }
            ev2('mousedown', 100, 100);
            ev2('mousemove', 380, 260);
            var r = null;
            d.dispatchEvent(new MouseEvent('mouseup', {clientX:380, clientY:260, button:0, bubbles:true, cancelable:true}));
            return 'dispatched';
        })()`);
        rec('   事件派发：' + r4);
        await sleep(5000);
        const stillThere = (await targets()).some((t) => (t.url || '').indexOf('region.html') >= 0);
        rec('   5 秒后遮罩还在不在：' + (stillThere ? '**还在**（命令没到或没关窗）' : '已关闭（正常）'));
        rec('   —— 日志 region/ocr/img 相关 ——');
        rec('   ' + logTail(40).split('\n').filter((l) => /region|ocr:|img:|capture/.test(l)).slice(-18).join('\n   '));
    } catch (e) {
        rec('探针出错：' + (e && e.message));
    } finally {
        rec('');
        rec('—— 完整日志末尾 30 行 ——');
        rec(logTail(30));
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();