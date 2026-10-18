/* r80h：定位「下完运行库后仍加载不了」的真因
 *
 * 探针 r80g 的 4e 失败：dll 文件在（11.84MB）、但 runtime 仍是 false。
 *
 * 怀疑：ort 的 `G_ORT_DYLIB_PATH` 是 OnceLock，且它的闭包**只读环境变量、
 * 不会 panic** —— 所以第一次（下载前，指向不存在的路径）就把值**永久缓存**了，
 * 之后再设 ORT_DYLIB_PATH 也不会重读。
 *
 * 这个探针直接问进程内的状态，不靠猜：
 *   · 我们在 Rust 侧加一个诊断命令，报告"当前 ort 认为的 dll 路径" 与
 *     "环境变量现在是什么"，两者不一致就说明缓存被冻住了。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 120000);
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80h-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    const models = path.join(tmp, '抠图模型');
    fs.mkdirSync(qs, { recursive: true });
    fs.mkdirSync(models, { recursive: true });
    // 把 dll **预置**好（模拟"已经下完"），这样测的是"能否加载"而不是"能否下载"
    const dllSrc = path.join(ROOT, 'vendor', 'ort', 'lib', 'onnxruntime.dll');
    let haveDll = false;
    if (fs.existsSync(dllSrc)) {
        fs.copyFileSync(dllSrc, path.join(models, 'onnxruntime.dll'));
        haveDll = true;
    }
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, ai_matting_enable: true }, null, 1), 'utf8');
    console.log('r80h 诊断：dll 已预置=' + haveDll + '  目录=' + models);

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80h' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);

        console.log('');
        console.log('=== 情形 A：dll 一开始就在（进程启动时就有）===');
        const st1 = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
        console.log('  runtimeFile=' + st1.runtimeFile + '  runtime=' + st1.runtime);
        console.log('  → 若 runtime=true，说明"启动时就有 dll"这条能走通（与缓存无关）');

        console.log('');
        console.log('=== 情形 B：先查状态（无 dll），再放入 dll，再查 ===');
        // 删掉 dll，查一次（让 ort 把"错误的路径"缓存进去）
        fs.rmSync(path.join(models, 'onnxruntime.dll'), { force: true });
        const st2 = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
        console.log('  删 dll 后: runtimeFile=' + st2.runtimeFile + '  runtime=' + st2.runtime);
        // 放回 dll
        fs.copyFileSync(dllSrc, path.join(models, 'onnxruntime.dll'));
        const st3 = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
        console.log('  放回 dll 后（同进程内）: runtimeFile=' + st3.runtimeFile + '  runtime=' + st3.runtime);
        if (st3.runtimeFile === true && st3.runtime === false) {
            console.log('  ★ 复现：文件在、但加载不了 —— 说明 ort 的路径缓存被冻住了');
        } else if (st3.runtime === true) {
            console.log('  ✓ 同进程内也能恢复加载（缓存没被冻住）');
        }

        console.log('');
        console.log('=== 情形 C：重启进程（dll 已在）===' );
        try { proc.kill(); } catch (e) { }
        await sleep(1500);
        PORT = await freePort();
        const env2 = Object.assign({}, env, {
            QS_INSTANCE_TAG: 'r80h2' + Date.now().toString(36),
            QS_T_WV_ARGS: WV_BASE + PORT,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2b'),
        });
        const proc2 = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env: env2, cwd: tmp, stdio: 'ignore' });
        try {
            const sw2 = await connect('settings.html');
            if (sw2) {
                await until(sw2, "typeof CONF === 'object'", 40000);
                const st4 = JSON.parse(await ev(sw2, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
                console.log('  重启后: runtimeFile=' + st4.runtimeFile + '  runtime=' + st4.runtime);
                if (st4.runtime === true) {
                    console.log('  → 重启能加载：说明只需"新进程"即可，问题是同进程内缓存');
                }
            }
        } finally {
            if (proc2 && proc2.exitCode === null) { try { proc2.kill(); } catch (e) { } }
        }
    } catch (e) {
        console.log('出错：' + (e && e.message));
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
