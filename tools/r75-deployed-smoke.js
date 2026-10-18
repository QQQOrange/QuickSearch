/* ============================================================================
 *  r75：交付前冒烟 —— 用**桌面上那个 exe** 真启动一次，验它能起来、页面能跑
 *
 *  与 tools/smoke-exe.py 的区别：那个脚本会 taskkill 掉所有 QuickSearch.exe，
 *  在「用户自己的实例正开着（管理员权限、脚本关不掉）」时必然失败。这里用
 *  QS_INSTANCE_TAG 另起一份隔离实例，再用 CDP 连进去看设置页是否真的跑起来了
 *  （JS 无异常、关键控件在），所以任何时刻都能跑。
 *
 *  用法：node tools/r75-deployed-smoke.js [exe路径]
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EXE = process.argv[2] || 'C:\\Users\\64381\\Desktop\\QuickSearch.exe';
const ROOT = path.join(__dirname, '..');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0, id = 0, errors = [];
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 15000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (x && x.method === 'Runtime.exceptionThrown') {
                const d = x.params && x.params.exceptionDetails;
                errors.push((d && (d.text || '')) + ' ' + (d && d.exception ? d.exception.description : ''));
                return;
            }
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
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-smoke-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'smoke' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });

    console.log('exe = ' + EXE + '  (' + fs.statSync(EXE).size + ' B)');
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    let pass = 0, fail = 0;
    const check = (n, ok, extra) => { if (ok) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); } };
    try {
        // 连上设置页
        let ws = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 40000 && !ws) {
            try {
                const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
                const ts = await r.json();
                const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf('settings.html') >= 0);
                if (hit) {
                    ws = new WebSocket(hit.webSocketDebuggerUrl);
                    await new Promise((res, rej) => {
                        ws.addEventListener('open', res, { once: true });
                        ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
                    });
                    await cdp(ws, 'Runtime.enable');
                }
            } catch (e) { }
            if (!ws) await sleep(300);
        }
        check('进程没秒退，设置页 WebView 起来了', !!ws);
        if (!ws) return;
        let booted = false;
        const t1 = Date.now();
        while (Date.now() - t1 < 30000 && !booted) {
            booted = (await ev(ws, "typeof CATALOG === 'object' && !!CATALOG.categories")) === true;
            if (!booted) await sleep(250);
        }
        check('设置页数据加载完成（engines.json 读到了）', booted);
        const ui = await ev(ws, `JSON.stringify({
            tabs: document.querySelectorAll('#tabs button').length,
            toTop: !!document.getElementById('toTopFab'),
            focusRing: !!Array.from(document.styleSheets).length,
            rows: document.querySelectorAll('#allList .item').length
        })`);
        console.log('  页面探针：' + ui);
        const o = JSON.parse(ui);
        check('十个分页都在', o.tabs === 10, 'tabs=' + o.tabs);
        check('r75 新增的「回到顶部」按钮已注入 DOM', o.toTop === true);
        check('页面没有未捕获的 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));
    } catch (e) {
        console.log('探针出错：' + (e && e.message));
        fail++;
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(800);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        console.log('');
        console.log(`========== 部署版冒烟：${pass} PASS / ${fail} FAIL ==========`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();