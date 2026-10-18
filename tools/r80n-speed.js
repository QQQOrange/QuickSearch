/* r80n：实测程序真实的下载速度与失败点
 *
 * 用户反馈：
 *   · 「下载速度特别慢」
 *   · 「这个模型下过来后缀还是 part」
 *   · 「有个运行库一直没下下来」
 *
 * 本探针不猜，直接跑真实下载，把**每个源的耗时、字节数、失败原因**全记下来。
 * 同时验证：下载成功后到底有没有把 .part 改名成 .onnx。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 900000);
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
    while (Date.now() - t0 < (ms || 60000)) {
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
    while (Date.now() - t0 < (ms || 30000)) { if (await ev(ws, expr) === true) return true; await sleep(250); }
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80n-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    const models = path.join(tmp, '抠图模型');
    fs.mkdirSync(qs, { recursive: true });
    fs.mkdirSync(models, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, ai_matting_enable: true }, null, 1), 'utf8');
    console.log('r80n 真实下载实测（不用代理）');
    console.log('');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80n' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上'); return; }
        await until(sw, "typeof CONF === 'object' && CONF !== null", 40000);

        /* 全程记录事件，带时间戳，好算速度 */
        await ev(sw, `(function(){
            window.__t0 = Date.now();
            window.__ev = [];
            window.__TAURI__.event.listen('model-download', function(e){
                window.__ev.push(Object.assign({ t: Date.now() - window.__t0 }, e.payload));
            });
            return true;
        })()`);

        /* 下 u2netp（默认模型，会先带运行库） */
        console.log('=== 下载 u2netp（含运行库）===');
        const t0 = Date.now();
        await ev(sw, "window.__TAURI__.core.invoke('ai_matting_download',{id:'u2netp'}).catch(e=>'ERR '+e)");

        let last = '';
        for (let i = 0; i < 600; i++) {
            await sleep(1000);
            last = await ev(sw, "(window.__ev.length) ? window.__ev[window.__ev.length-1].phase : ''");
            if (last === 'done' || last === 'error' || last === 'canceled') break;
        }
        const elapsed = (Date.now() - t0) / 1000;
        console.log(`  收尾 phase=${last}  总耗时 ${elapsed.toFixed(1)}s`);

        /* 分析事件流：按阶段统计 */
        const dump = await ev(sw, 'JSON.stringify(window.__ev)');
        const evs = JSON.parse(dump);
        const byPhase = {};
        for (const e of evs) {
            const ph = e.phase || '?';
            if (!byPhase[ph]) byPhase[ph] = { count: 0, first: e.t, last: e.t, maxDone: 0, maxTotal: 0 };
            byPhase[ph].count++;
            byPhase[ph].last = e.t;
            byPhase[ph].maxDone = Math.max(byPhase[ph].maxDone, e.done || 0);
            byPhase[ph].maxTotal = Math.max(byPhase[ph].maxTotal, e.total || 0);
        }
        console.log('');
        console.log('  阶段统计：');
        for (const [ph, s] of Object.entries(byPhase)) {
            const dur = (s.last - s.first) / 1000;
            const mb = s.maxDone / 1024 / 1024;
            const spd = dur > 0.5 ? (mb / dur) : 0;
            console.log(`    ${ph.padEnd(12)} 事件 ${String(s.count).padStart(3)} 个  `
                + `${dur.toFixed(1)}s  ${mb.toFixed(2)}MB  ${spd.toFixed(2)} MB/s`);
        }

        /* 落盘检查：.part 有没有被改名 */
        console.log('');
        console.log('  落盘：');
        const files = fs.readdirSync(models);
        for (const f of files) {
            console.log(`    ${f}  ${(fs.statSync(path.join(models, f)).size / 1024 / 1024).toFixed(2)}MB`);
        }
        const parts = files.filter((f) => f.includes('.part'));
        const onnx = files.filter((f) => f.endsWith('.onnx'));
        const dll = files.filter((f) => f === 'onnxruntime.dll');
        console.log('');
        if (parts.length) console.log('  ⚠ 残留 .part: ' + parts.join(', '));
        if (onnx.length) console.log('  ✓ 模型已就绪: ' + onnx.join(', '));
        if (dll.length) console.log('  ✓ 运行库已就绪');

        /* 如果失败，把错误信息打出来 */
        if (last === 'error') {
            const errEv = evs.filter((e) => e.phase === 'error').pop();
            console.log('  失败原因: ' + (errEv && errEv.msg ? errEv.msg.slice(0, 400) : '(无)'));
        }
    } catch (e) {
        console.log('出错：' + (e && e.message));
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
