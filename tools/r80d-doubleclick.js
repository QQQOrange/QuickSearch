/* r80d：复现「自动抠图要点两次才出效果」
 *
 * 用户原话：「我在换图标那里点击一次自动抠图，它不会出效果，要点击两次它才会出
 * 最后的成品图」。
 *
 * 探针要回答的是：第一次点到底发生了什么 —— 是没跑？跑错参数？还是结果没显示？
 * 所以每一步都采样：按钮文字 / OUT 是否有值 / imgAfter 是否可见 / 提示文字。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const ICONDIR = path.join(ROOT, 'ui', 'data', 'icons');
const MODELS_SRC = 'D:\\Local AI\\git\\_matting-ref\\rmbg';
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

/** 采样编辑器页面的关键状态。 */
const SNAP = `(function(){
    var b = document.getElementById('btnRemove');
    var im = document.getElementById('imgAfter');
    var ph = document.getElementById('phAfter');
    var hint = document.getElementById('hint');
    return JSON.stringify({
        btnText: b ? b.textContent.trim() : null,
        btnBusy: b ? b.classList.contains('busy') : null,
        outLen: (typeof OUT !== 'undefined' && OUT) ? OUT.length : 0,
        imgHidden: im ? im.hidden : null,
        imgComplete: im ? (im.complete && im.naturalWidth > 0) : null,
        imgW: im ? im.naturalWidth : 0,
        phHidden: ph ? ph.hidden : null,
        hint: hint ? hint.textContent.slice(0, 60) : ''
    });
})()`;

/* 换图标 → 进编辑器：用真实的入口命令。
 * 直接调 open_icon_editor 比模拟点击「换图标」可靠（后者要弹系统文件框）。 */
const OPEN_EDITOR = (dataUrl) => `window.__TAURI__.core.invoke('open_icon_editor', {
    key: '__probe_icon__', srcHint: ${JSON.stringify(dataUrl)}
}).then(()=>'OK').catch(e=>'ERR '+e)`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80d-'));
    const qs = path.join(tmp, 'QuickSearch');
    const modelsDir = path.join(qs, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    // 预置已下载模型（让 AI 可用，这样测的才是抠图流程本身）
    let preloaded = false;
    try {
        fs.copyFileSync(path.join(MODELS_SRC, 'u2netp.onnx'), path.join(modelsDir, 'u2netp.onnx'));
        preloaded = true;
    } catch (e) { }
    // 开关打开（否则抠图会因"功能没开"而失败，测不到这个 bug）
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, theme: 'dark', ai_matting_enable: true }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80d' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    console.log('r80d 复现"点两次"：pid=' + proc.pid + '  模型=' + (preloaded ? 'u2netp' : '无'));
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);
        console.log('  CONF.aiMattingEnable = ' + await ev(sw, "String(CONF.aiMattingEnable)"));

        /* 打开编辑器（在设置页里调命令，编辑器是新窗口） */
        const p = path.join(ICONDIR, 'GOG.png');
        const dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
        console.log('  打开编辑器: ' + await ev(sw, OPEN_EDITOR(dataUrl)));
        const ed = await connect('iconedit.html', 30000);
        if (!ed) { console.log('编辑器没起来'); return; }
        await until(ed, "typeof SRC !== 'undefined' && !!SRC", 20000);
        console.log('  编辑器就绪，SRC 长度=' + await ev(ed, "SRC.length"));

        console.log('');
        console.log('--- 第一次点「自动抠图」 ---');
        console.log('  点击前: ' + await ev(ed, SNAP));
        await ev(ed, "document.getElementById('btnRemove').click()");
        // 等按钮结束 busy
        await until(ed, "!document.getElementById('btnRemove').classList.contains('busy')", 60000);
        await sleep(2000);
        console.log('  点击后: ' + await ev(ed, SNAP));

        console.log('');
        console.log('--- 第二次点「自动抠图」 ---');
        await ev(ed, "document.getElementById('btnRemove').click()");
        await until(ed, "!document.getElementById('btnRemove').classList.contains('busy')", 60000);
        await sleep(2000);
        console.log('  点击后: ' + await ev(ed, SNAP));

        console.log('');
        console.log('--- 关键：imgAfter 的 onload 是否被覆盖 ---');
        console.log('  imgAfter.src 前缀: ' + await ev(ed,
            "(function(){var i=document.getElementById('imgAfter');return i.getAttribute('src')?i.getAttribute('src').slice(0,30):'(空)';})()"));
        console.log('  OUT 前 30 字符: ' + await ev(ed,
            "(typeof OUT!=='undefined'&&OUT)?OUT.slice(0,30):'(空)'"));
    } catch (e) {
        console.log('出错：' + (e && e.message));
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
