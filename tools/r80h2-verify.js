/* r80h2：验证 ort 路径缓存 bug 已修
 *
 * 修前的行为（probe 4e 抓到的）：
 *   1. dll 不在 → 查状态 → ort 缓存了**错误的路径**（相对名）
 *   2. 放入 dll → 再查 → 仍然 false（缓存被冻住，只能重启程序）
 *
 * 修后的期望：
 *   · 第 1 步之后放入 dll → 第 2 步**立刻**变成 true（同一个进程内，不用重启）
 *
 * 这个探针必须在**同一个进程**里走完两步才有效 —— 重启进程就测不到缓存问题了。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const DLL_SRC = path.join(ROOT, 'vendor', 'ort', 'lib', 'onnxruntime.dll');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); } else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

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
    rec('r80h2：ort 路径缓存修复验证');
    if (!fs.existsSync(DLL_SRC)) {
        rec('  找不到源 dll：' + DLL_SRC);
        rec('（跳过：需要 vendor/ort/lib/onnxruntime.dll）');
        process.exit(0);
    }
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80h2-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    const models = path.join(tmp, '抠图模型');
    fs.mkdirSync(qs, { recursive: true });
    fs.mkdirSync(models, { recursive: true });
    // 关键：**一开始不放 dll**（要复现"先查后放"的顺序）
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, ai_matting_enable: true }, null, 1), 'utf8');
    rec('  起始状态：目录里没有 dll');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80h2' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('  连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);

        rec('');
        rec('── 步骤 1：先查状态（这一步在修前会"冻住"错误路径）──');
        const a = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
        rec(`  runtimeFile=${a.runtimeFile}  runtime=${a.runtime}`);
        check('1a 没 dll 时 runtimeFile=false', a.runtimeFile === false, String(a.runtimeFile));
        check('1b 没 dll 时 runtime=false', a.runtime === false, String(a.runtime));

        rec('');
        rec('── 步骤 2：把 dll 放进「抠图模型」目录（模拟刚下载完）──');
        fs.copyFileSync(DLL_SRC, path.join(models, 'onnxruntime.dll'));
        rec('  已放入: ' + (fs.statSync(path.join(models, 'onnxruntime.dll')).size / 1024 / 1024).toFixed(2) + 'MB');

        rec('');
        rec('── 步骤 3：**同一个进程内**再查一次（修前这里是 false）──');
        let b = null;
        for (let i = 0; i < 20; i++) {
            b = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
            if (b.runtime === true) break;
            await sleep(500);
        }
        rec(`  runtimeFile=${b.runtimeFile}  runtime=${b.runtime}`);
        check('3a 文件已被识别（runtimeFile=true）', b.runtimeFile === true, String(b.runtimeFile));
        check('3b ★ 同一进程内运行库变得可加载（runtime=true）—— 缓存 bug 已修',
            b.runtime === true, '仍是 false 说明缓存还在冻');

        rec('');
        rec('── 步骤 4：真能推理吗（端到端，不只是"能加载"）──');
        // 放一个模型进去，真跑一次抠图
        const u2 = 'D:\\Local AI\\git\\_matting-ref\\rmbg\\u2netp.onnx';
        if (fs.existsSync(u2)) {
            fs.copyFileSync(u2, path.join(models, 'u2netp.onnx'));
            const iconDir = path.join(ROOT, 'ui', 'data', 'icons');
            const gog = path.join(iconDir, 'GOG.png');
            let r = null;
            for (let i = 0; i < 30; i++) {
                r = JSON.parse(await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                    src: 'data:image/png;base64,' + '${fs.readFileSync(gog).toString('base64')}',
                    keep: null, params: null, modelId: null
                }).then(r=>JSON.stringify({ok:true, n:r.removed, len:(r.src||'').length, model:r.usedModel}))
                  .catch(e=>JSON.stringify({ok:false, err:String(e)}))`));
                if (r.ok) break;
                await sleep(1000);
            }
            rec('  抠图结果: ' + JSON.stringify(r));
            check('4a 下完运行库后**真的能推理出图**（不需要重启程序）',
                r && r.ok && r.n > 0 && r.len > 1000, JSON.stringify(r).slice(0, 110));
        } else {
            rec('  （跳过 4：本地没有 u2netp.onnx）');
        }
    } catch (e) {
        rec('出错：' + (e && e.message));
        fail++;
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        rec('');
        rec(`========== r80h2：${pass} PASS / ${fail} FAIL ==========`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
