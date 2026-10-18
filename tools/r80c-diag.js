/* r80c：诊断开关为什么点不动（探针直接问运行时的状态，不靠猜） */
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
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 60000);
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80c-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80c' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);
        await sleep(1500);

        console.log('--- 1. 环境检查 ---');
        console.log('  SWITCHES 里有 s-aiMatting: ' +
            await ev(sw, "typeof SWITCHES !== 'undefined' ? SWITCHES.some(s=>s[0]==='s-aiMatting') : 'SWITCHES 未定义'"));
        console.log('  开关元素存在: ' + await ev(sw, "!!document.getElementById('s-aiMatting')"));
        console.log('  开关当前 checked: ' + await ev(sw, "document.getElementById('s-aiMatting').checked"));
        console.log('  CONF.aiMattingEnable: ' + await ev(sw, "String(CONF.aiMattingEnable)"));
        console.log('  iconEditorEnabled(): ' + await ev(sw, "typeof iconEditorEnabled==='function'?iconEditorEnabled():'NO_FN'"));

        console.log('--- 2. 模拟点击（dispatch 真实事件）---');
        await ev(sw, "(function(){var e=document.getElementById('s-aiMatting');e.click();return e.checked;})()");
        await sleep(2500);
        console.log('  点击后 checked: ' + await ev(sw, "document.getElementById('s-aiMatting').checked"));
        console.log('  点击后 CONF: ' + await ev(sw, "String(CONF.aiMattingEnable)"));
        console.log('  点击后 iconEditorEnabled(): ' + await ev(sw, "iconEditorEnabled()"));

        console.log('--- 3. 后端是否真的存了 ---');
        console.log('  后端 status.enable: ' + await ev(sw,
            "window.__TAURI__.core.invoke('ai_matting_status').then(r=>String(r.enable))"));
        console.log('  配置文件内容: ' + fs.readFileSync(path.join(qs, 'config.json'), 'utf8').slice(0, 200));

        console.log('--- 4. 手动调 set_setting 看能不能存 ---');
        const r = await ev(sw,
            "window.__TAURI__.core.invoke('set_setting',{key:'aiMattingEnable',value:true}).then(()=>'OK').catch(e=>'ERR '+e)");
        console.log('  set_setting: ' + r);
        await sleep(2000);
        console.log('  调完后 CONF: ' + await ev(sw, "String(CONF.aiMattingEnable)"));
        console.log('  调完后后端: ' + await ev(sw,
            "window.__TAURI__.core.invoke('ai_matting_status').then(r=>String(r.enable))"));

        console.log('--- 5. 检查是否有 JS 报错 ---');
        const errs = await ev(sw, "JSON.stringify(window.__errs || [])");
        console.log('  页面错误: ' + errs);
    } catch (e) {
        console.log('出错：' + (e && e.message));
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(500);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
