/* r80j：验证并发下载不再互相破坏 + 残留清理
 *
 * 用户报的真 bug（日志已证实）：
 *   「点击下载引擎，它会下完之后再进一步的重复下载」
 * 现场（%APPDATA%\QuickSearch\log.txt）：
 *     开始 rmbg-full / rmbg-fp16 / rmbg-quantized / u2netp  ← 4 个在 16ms 内同时开始
 *     运行库失败：gh-proxy.com: 解压失败 不是有效的 zip（找不到 EOCD）
 *                 ghfast.top:   解压失败 不是有效的 zip（找不到 EOCD）
 *                 github.com:   解压失败 不是有效的 zip（找不到 EOCD）
 *     又开始 rmbg-full / rmbg-fp16 / rmbg-quantized / u2netp  ← 第二轮
 *
 * 根因：多个下载并发跑，共享同一个 `onnxruntime.zip` 路径 → 互相删、
 * 互相读到半个文件 → 每个源都"解压失败"，界面看着像重复下载且永远下不完。
 *
 * 本探针验证修复后的行为：
 *   1. 同时发起两个下载 → **只有一个真的跑**，另一个拿到明确的"已有下载在进行"错误
 *   2. 下完后模型目录里**没有** .zip / .part 残留
 *   3. ai_cleanup_stale 能清掉人为制造的残留（含旧位置的模型）
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
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); } else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 600000);
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
    rec('r80j：并发下载与残留清理');
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80j-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    const models = path.join(tmp, '抠图模型');
    fs.mkdirSync(qs, { recursive: true });
    fs.mkdirSync(models, { recursive: true });
    // 预置运行库 → 跳过 69MB，直接测模型下载的并发行为
    let haveDll = false;
    try { fs.copyFileSync(DLL_SRC, path.join(models, 'onnxruntime.dll')); haveDll = true; } catch (e) { }
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, ai_matting_enable: true }, null, 1), 'utf8');
    rec('  运行库预置=' + haveDll);

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80j' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('  连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);

        /* ══ 1. 并发发起两个下载，看后端怎么处理 ══ */
        rec('');
        rec('══ 1. 同时发起两个下载（修前：两个都跑 → 互相破坏）══');
        await ev(sw, `(function(){
            window.__pdl = [];
            window.__TAURI__.event.listen('model-download', function(e){ window.__pdl.push(e.payload); });
            return true;
        })()`);
        // 同时发：一个 u2netp（4.4MB），一个 rmbg-quantized（42MB）
        const both = await ev(sw, `Promise.all([
            window.__TAURI__.core.invoke('ai_matting_download', { id: 'u2netp' }).then(()=>'u2netp:OK').catch(e=>'u2netp:ERR '+e),
            window.__TAURI__.core.invoke('ai_matting_download', { id: 'rmbg-quantized' }).then(()=>'rmbg-quantized:OK').catch(e=>'rmbg-quantized:ERR '+e)
        ]).then(function(r){ return JSON.stringify(r); })`);
        rec('  两个并发调用的返回: ' + both);
        const arr = JSON.parse(both);
        const refused = arr.filter((s) => s.indexOf('ERR') >= 0 && s.indexOf('已经有一个下载') >= 0);
        check('1a 第二个下载被**明确拒绝**（提示已有下载在进行）', refused.length === 1,
            '拒绝数=' + refused.length + '  返回=' + both.slice(0, 120));

        // 等第一个下载跑完
        let ph = '';
        for (let i = 0; i < 300; i++) {
            await sleep(1000);
            ph = await ev(sw, "(window.__pdl.length) ? window.__pdl[window.__pdl.length-1].phase : ''");
            if (ph === 'done' || ph === 'error' || ph === 'canceled') break;
        }
        rec('  下载收尾 phase=' + ph);
        check('1b 被接受的那个下载**成功下完**（没有因为并发而失败）', ph === 'done', 'phase=' + ph);

        /* ══ 2. 落盘：不该有 .zip / .part 残留 ══ */
        rec('');
        rec('══ 2. 落盘检查（残留是"重复下载"观感的另一半原因）══');
        const files = fs.readdirSync(models);
        files.forEach((f) => rec('    ' + f + '  ' + (fs.statSync(path.join(models, f)).size / 1024 / 1024).toFixed(2) + 'MB'));
        check('2a 没有 .zip 残留（下运行库的中间文件）',
            !files.some((f) => f.endsWith('.zip')), files.join(','));
        check('2b 没有 .part 残留（半截的下载）',
            !files.some((f) => f.includes('.part')), files.join(','));
        check('2c 模型确实下好了', files.some((f) => f.endsWith('.onnx')), files.join(','));
        // 数据目录不该有空 models 目录
        check('2d 数据目录没冒出多余的 models/ 目录', !fs.existsSync(path.join(qs, 'models')));

        /* ══ 3. 清理残留（人为制造）══ */
        rec('');
        rec('══ 3. ai_cleanup_stale：清掉人为制造的残留 ══');
        // 造：当前目录里一个假 zip、一个假 part
        fs.writeFileSync(path.join(models, 'onnxruntime-999-1.zip.part'), Buffer.alloc(1024));
        fs.writeFileSync(path.join(models, 'leftover.zip'), Buffer.alloc(2048));
        // 造：旧位置（数据目录/models）里一个假模型 + 一个 part
        const legacy = path.join(qs, 'models');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, 'old-model.onnx'), Buffer.alloc(4096));
        fs.writeFileSync(path.join(legacy, 'half.onnx.part'), Buffer.alloc(512));
        const before = fs.readdirSync(models).length;
        rec('  造完残留后，模型目录有 ' + before + ' 个文件；旧目录有 ' + fs.readdirSync(legacy).length + ' 个');
        const cleaned = await ev(sw, "window.__TAURI__.core.invoke('ai_cleanup_stale').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e)");
        rec('  清理结果: ' + cleaned);
        if (typeof cleaned === 'string' && !cleaned.startsWith('ERR')) {
            const c = JSON.parse(cleaned);
            rec('  删了 ' + c.count + ' 项，释放 ' + c.sizeText);
            c.items.forEach((p) => rec('    - ' + p.replace(tmp, '<tmp>')));
            const afterModels = fs.readdirSync(models);
            check('3a 假 zip / part 已被清掉',
                !afterModels.some((f) => f.endsWith('.zip') || f.includes('.part')), afterModels.join(','));
            check('3b 旧位置的模型已被清掉', !fs.existsSync(path.join(legacy, 'old-model.onnx')));
            check('3c 旧目录空了就连目录一起删', !fs.existsSync(legacy));
            check('3d **当前模型目录里的 .onnx 没有被误删**（那是用户资产）',
                afterModels.some((f) => f.endsWith('.onnx')), afterModels.join(','));
        } else {
            check('3 清理命令可用', false, String(cleaned).slice(0, 100));
        }
    } catch (e) {
        rec('出错：' + (e && e.message));
        fail++;
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
        await sleep(800);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        rec('');
        rec(`========== r80j：${pass} PASS / ${fail} FAIL ==========`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
