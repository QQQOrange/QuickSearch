/* r80q：验证**并行下载**（用户要求：运行库与每个模型都能同时下、各自独立）
 *
 * 用户原话：「要允许同时下载，运行库跟每一个模型都可以同时下载，也都要单独下」。
 *
 * 所以这个探针要证明四件事：
 *   1. 同时点两个模型 → **两个都真的在跑**（不再被"已有下载在进行"挡住）
 *   2. 两个都成功下完，各自落盘成 `.onnx`
 *   3. 运行库只下一次（不会因为两个模型并发就重复下 11.84MB）
 *   4. 全程没有 `.part` 残留
 *
 * 前置：运行库预置好（跳过下载），这样测的才是"模型并行"本身。
 * 另有一轮专门测"没有运行库时两个模型同时下" → 运行库只下一次。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const DLL_SRC = path.join(ROOT, 'vendor', 'ort', 'lib', 'onnxruntime.dll');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const rec = (s) => console.log(s);
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); } else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

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

async function runCase(label, presetDll) {
    rec('');
    rec(`══ ${label} ══`);
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80q-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    const models = path.join(tmp, '抠图模型');
    fs.mkdirSync(qs, { recursive: true });
    fs.mkdirSync(models, { recursive: true });
    if (presetDll) {
        try { fs.copyFileSync(DLL_SRC, path.join(models, 'onnxruntime.dll')); } catch (e) { }
    }
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, ai_matting_enable: true }, null, 1), 'utf8');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80q' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('  连不上设置页'); fail++; return; }
        await until(sw, "typeof CONF === 'object' && CONF !== null", 40000);

        await ev(sw, `(function(){
            window.__ev = [];
            window.__TAURI__.event.listen('model-download', function(e){ window.__ev.push(e.payload); });
            return true;
        })()`);

        /* 同时发起两个模型下载 —— **两个都应该被接受** */
        rec('  同时发起 u2netp + rmbg-quantized');
        const res = await ev(sw, `Promise.all([
            window.__TAURI__.core.invoke('ai_matting_download', { id: 'u2netp' }).then(()=>'u2netp:OK').catch(e=>'u2netp:ERR '+e),
            window.__TAURI__.core.invoke('ai_matting_download', { id: 'rmbg-quantized' }).then(()=>'rmbg:OK').catch(e=>'rmbg:ERR '+e)
        ]).then(function(r){ return JSON.stringify(r); })`);
        rec('  返回: ' + res);
        const arr = JSON.parse(res);
        check('1 两个下载都被接受（不再被"已有下载在进行"挡住）',
            arr.every((s) => s.indexOf(':OK') >= 0), res);

        /* 等两个都收尾 */
        let doneIds = new Set();
        for (let i = 0; i < 600; i++) {
            await sleep(1000);
            const st = await ev(sw, `JSON.stringify((function(){
                var m = {};
                window.__ev.forEach(function(p){
                    if (p.phase === 'done' || p.phase === 'error') m[p.id] = p.phase;
                });
                return m;
            })())`);
            const o = JSON.parse(st);
            doneIds = new Set(Object.keys(o));
            if (o['u2netp'] && o['rmbg-quantized']) {
                rec('  两个都收尾: ' + JSON.stringify(o));
                check('2 两个下载都成功完成', o['u2netp'] === 'done' && o['rmbg-quantized'] === 'done', JSON.stringify(o));
                break;
            }
        }

        /* 落盘检查 */
        const files = fs.readdirSync(models).sort();
        rec('  落盘: ' + files.join(', '));
        check('3 u2netp.onnx 已就绪', files.includes('u2netp.onnx'), files.join(','));
        check('4 rmbg-quantized.onnx 已就绪', files.includes('rmbg-quantized.onnx'), files.join(','));
        check('5 没有 .part 残留', !files.some((f) => f.includes('.part')), files.join(','));

        if (!presetDll) {
            check('6 运行库也下好了', files.includes('onnxruntime.dll'), files.join(','));
            /* 运行库只该下一次：统计 runtime 阶段事件出现在几个不同 id 上，
             * 且 total 恒为 11.84MB（说明是直下 dll，不是 69MB zip） */
            const rtInfo = await ev(sw, `JSON.stringify((function(){
                var ids = {}; var totals = {};
                window.__ev.forEach(function(p){
                    if (p.phase === 'runtime') { ids[p.id] = 1; totals[p.total] = 1; }
                });
                return { ids: Object.keys(ids), totals: Object.keys(totals).map(Number) };
            })())`);
            rec('  运行库阶段: ' + rtInfo);
            const r = JSON.parse(rtInfo);
            const dllBytes = 12418080;
            check('7 运行库只有一个线程真的在下（其它人等它）', r.ids.length === 1, JSON.stringify(r.ids));
            check('8 运行库下的是 11.84MB 的 dll（不是 69MB zip）',
                r.totals.length === 1 && r.totals[0] === dllBytes,
                'totals=' + JSON.stringify(r.totals));
        }
    } catch (e) {
        rec('出错：' + (e && e.message));
        fail++;
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
}

(async () => {
    rec('r80q：并行下载验证');
    /* 场景 A：已有运行库 → 只测模型并行 */
    await runCase('场景 A：运行库已就绪，两个模型同时下', true);
    /* 场景 B：没有运行库 → 两个模型同时下，运行库只该下一次 */
    await runCase('场景 B：没有运行库，两个模型同时下（测运行库门闩）', false);

    rec('');
    rec(`========== r80q：${pass} PASS / ${fail} FAIL ==========`);
    process.exit(fail === 0 ? 0 : 1);
})();
