/* r80g：验证「运行库随模型一起下载」这条链路
 *
 * 用户要求：
 *   · 「ONNX Runtime 的运行时库 这个运行库默认不下载，在点击打开 ai 抠图之后，
 *      会随着模型一起下载，并且跟模型储存在一起，这能做到吗？」
 *   · 「模型默认存储的位置应该在软件的位置，就相当于软件的位置，新开一个文件夹，
 *      文件夹的名字叫做抠图模型，然后模型以及运行库就放在那里」
 *
 * 本探针验证四件事：
 *   1. exe 产物目录里**没有** onnxruntime.dll（不入包的前提）
 *   2. 缺 dll 时程序**能正常启动**（load-dynamic 生效）—— 看 WebView2 子进程数
 *   3. 模型目录默认落在「<exe目录>/抠图模型」
 *   4. 点下载时：先下运行库（phase=runtime），解出 dll 落到模型目录，再下模型
 *
 * 用法：node tools/r80g-runtime.js [--full]
 *       不带 --full 时只验 1~3（快）；带则连 4 一起验（要下 69MB，约几分钟）
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
const FULL = process.argv.includes('--full');

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(path.join(__dirname, 'r80g-runtime.txt'), L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
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

(async () => {
    rec('r80g 运行库探针');
    rec('');

    /* ══ 1. 产物目录不该有 dll ══ */
    rec('══ 1. 程序产物里没有运行库（不入包的前提）══');
    const relDir = path.join(ROOT, 'target', 'release');
    const dllInRel = fs.existsSync(path.join(relDir, 'onnxruntime.dll'));
    check('1a 产物目录里没有 onnxruntime.dll', !dllInRel, '存在则说明还在随包分发');
    check('1b exe 存在', fs.existsSync(EXE));
    rec('');

    /* ══ 2. 缺 dll 能启动（load-dynamic）══ */
    rec('══ 2. 没有 dll 也能正常启动（load-dynamic 生效）══');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80g-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    check('2a 拷贝到干净目录后没有 dll', !fs.existsSync(path.join(tmp, 'onnxruntime.dll')));

    const beforeWv = execSync('tasklist /FI "IMAGENAME eq msedgewebview2.exe" /NH', { encoding: 'utf8' })
        .split('\n').filter((l) => l.trim()).length;
    let proc = null;
    try {
        // 唯一实例标签：避免被"另一实例在跑 → exit 0"误导（这个坑踩过）
        const env = Object.assign({}, process.env, {
            APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
            QS_INSTANCE_TAG: 'r80g' + Date.now().toString(36),
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
            QS_T_WV_ARGS: WV_BASE + (await freePort()),
        });
        proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
        await sleep(12000);
        const alive = proc.exitCode === null;
        check('2b 没有 dll 时进程仍然存活', alive, 'exitCode=' + proc.exitCode);
        if (alive) {
            // 用 WebView2 子进程数确证"真的建了界面"，不是错误弹窗
            const afterWv = execSync('tasklist /FI "IMAGENAME eq msedgewebview2.exe" /NH', { encoding: 'utf8' })
                .split('\n').filter((l) => l.trim()).length;
            check('2c 真的建起了界面（WebView2 子进程增加）', afterWv > beforeWv,
                `${beforeWv} -> ${afterWv}`);
        }
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
    }
    rec('');

    /* ══ 3. 默认模型目录 = <exe目录>/抠图模型 ══ */
    rec('══ 3. 模型默认位置在软件目录下的「抠图模型」══');
    PORT = await freePort();
    const env2 = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80g2' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2b'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    let proc2 = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env: env2, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        check('3a 设置页起来了', !!sw);
        if (sw) {
            await until(sw, "typeof CONF === 'object'", 40000);
            const info = await ev(sw, "window.__TAURI__.core.invoke('ai_model_dir_info').then(r=>JSON.stringify(r))");
            if (typeof info === 'string' && !info.startsWith('ERR')) {
                const o = JSON.parse(info);
                rec('  模型目录: ' + o.dir);
                rec('  默认目录: ' + o.defaultDir + '   是否自定义: ' + o.custom);
                // exe 在 tmp 下 → 目录应当是 tmp\抠图模型
                check('3b 默认目录是 <exe目录>/抠图模型',
                    o.dir.endsWith('抠图模型') && o.dir.indexOf(tmp.replace(/\\/g, '\\')) >= 0,
                    o.dir);
                check('3c 默认时 custom=false', o.custom === false, String(o.custom));
                check('3d 目录会被自动创建（exists=true）', o.exists === true, String(o.exists));
            } else {
                check('3b 模型目录信息可读', false, String(info).slice(0, 80));
            }
            // 运行库状态应当区分"文件在不在"与"能不能加载"
            const st = await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))");
            if (typeof st === 'string' && !st.startsWith('ERR')) {
                const s = JSON.parse(st);
                rec(`  状态: runtimeFile=${s.runtimeFile} runtime=${s.runtime} usable=${s.usable}`);
                check('3e 状态里有 runtimeFile（文件在不在）', typeof s.runtimeFile === 'boolean');
                check('3f 没有 dll 时 runtimeFile=false', s.runtimeFile === false, String(s.runtimeFile));
                check('3g 没有 dll 时 runtime（能否加载）=false', s.runtime === false, String(s.runtime));
                check('3h 状态里带 runtimeDir（与模型同目录）', typeof s.runtimeDir === 'string' && s.runtimeDir.length > 0);
            }
        }
    } finally {
        if (proc2 && proc2.exitCode === null) { try { proc2.kill(); } catch (e) { } }
        await sleep(500);
    }
    rec('');

    /* ══ 4.（可选）真的下运行库 ══ */
    if (FULL) {
        rec('══ 4. 真实下载运行库（69MB zip → 解出 dll 落到模型目录）══');
        PORT = await freePort();
        const env3 = Object.assign({}, process.env, {
            APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
            QS_INSTANCE_TAG: 'r80g3' + Date.now().toString(36),
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2c'),
            QS_T_WV_ARGS: WV_BASE + PORT,
        });
        const proc3 = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env: env3, cwd: tmp, stdio: 'ignore' });
        try {
            const sw = await connect('settings.html');
            if (sw) {
                await until(sw, "typeof CONF === 'object'", 40000);
                await ev(sw, `(function(){
                    window.__dl = [];
                    window.__TAURI__.event.listen('model-download', function(e){ window.__dl.push(e.payload); });
                    return true;
                })()`);
                await ev(sw, "window.__TAURI__.core.invoke('ai_matting_download',{id:'u2netp'}).catch(e=>'ERR '+e)");
                let phase = '', sawRuntime = false;
                for (let i = 0; i < 600; i++) {
                    await sleep(1000);
                    const info = await ev(sw, `JSON.stringify({
                        last: (window.__dl && window.__dl.length) ? window.__dl[window.__dl.length-1].phase : '',
                        sawRuntime: (window.__dl||[]).some(function(p){ return p.phase === 'runtime'; })
                    })`);
                    try { const o = JSON.parse(info); phase = o.last; sawRuntime = sawRuntime || o.sawRuntime; } catch (e) { }
                    if (phase === 'done' || phase === 'error' || phase === 'canceled') break;
                }
                rec('  下载收尾 phase=' + phase + '，中途出现过 runtime 阶段=' + sawRuntime);
                check('4a 下载流程里出现过「运行库」阶段', sawRuntime, 'sawRuntime=' + sawRuntime);
                check('4b 模型+运行库都下完了', phase === 'done', 'phase=' + phase);
                const dllPath = path.join(tmp, '抠图模型', 'onnxruntime.dll');
                const mdlPath = path.join(tmp, '抠图模型', 'u2netp.onnx');
                const dllOk = fs.existsSync(dllPath);
                const mdlOk = fs.existsSync(mdlPath);
                const dllMB = dllOk ? fs.statSync(dllPath).size / 1024 / 1024 : 0;
                rec(`  dll: ${dllOk ? dllMB.toFixed(2) + 'MB' : '缺失'}   模型: ${mdlOk ? '在' : '缺失'}`);
                check('4c 运行库 dll 落在「抠图模型」目录里', dllOk && dllMB > 8, `exists=${dllOk} ${dllMB.toFixed(2)}MB`);
                check('4d 模型也落在同一目录', mdlOk);
                // 下完之后 runtime 应当变成 true
                const s2 = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
                rec(`  下完后: runtimeFile=${s2.runtimeFile} runtime=${s2.runtime} usable=${s2.usable}`);
                check('4e 下完后运行库可加载（runtime=true）', s2.runtime === true, JSON.stringify({ f: s2.runtimeFile, r: s2.runtime }));
            }
        } catch (e) {
            rec('  下载测试出错：' + (e && e.message));
            fail++;
        } finally {
            if (proc3 && proc3.exitCode === null) { try { proc3.kill(); } catch (e) { } }
        }
    } else {
        rec('（未加 --full，跳过真实下载运行库的测试）');
    }

    /* 清理 */
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    rec('');
    rec(`========== r80g 运行库探针：${pass} PASS / ${fail} FAIL ==========`);
    process.exit(fail === 0 ? 0 : 1);
})();
