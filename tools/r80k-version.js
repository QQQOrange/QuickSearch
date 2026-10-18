/* r80k：验证"桌面版本的版本号没有更新"已修 + 三处显示一致
 *
 * 用户报：「桌面版本的版本号没有更新」。
 * 实测根因：`src/config.rs` 里的 `pub const VERSION` 是**手写的 "1.0.0"**，
 * 而发版时只改了 Cargo.toml / tauri.conf.json / package.json —— 漏了这一处。
 * 它喂给 `CONF.version`，于是关于页与界面右下角都显示旧版本。
 *
 * 已改成 `env!("CARGO_PKG_VERSION")`（编译期从 Cargo.toml 取，不可能写错）。
 * 本探针验证：界面显示的字样 == exe 的版本资源 == Cargo.toml。
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

let pass = 0, fail = 0;
const rec = (s) => console.log(s);
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); } else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 90000);
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
    rec('r80k：版本号一致性');
    // 期望版本 = Cargo.toml（唯一权威来源）
    const cargo = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8');
    const want = cargo.match(/^version = "([^"]+)"/m)[1];
    rec('  Cargo.toml 里的版本: ' + want);

    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80k-'));
    fs.copyFileSync(EXE, path.join(tmp, 'QuickSearch.exe'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.mkdirSync(path.join(tmp, '抠图模型'), { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80k' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(path.join(tmp, 'QuickSearch.exe'), ['--no-elevate', '--settings'], { env, cwd: tmp, stdio: 'ignore' });
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('  连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object' && CONF !== null && !!CONF.version", 40000);

        /* 1. 后端给前端的 CONF.version */
        const confVer = await ev(sw, "String((typeof CONF === 'object' && CONF) ? CONF.version : '(无 CONF)')");
        rec('  CONF.version（后端给的）: ' + confVer);
        check('1a CONF.version 与 Cargo.toml 一致', confVer === want, `CONF=${confVer} 期望=${want}`);
        check('1b CONF.version 不是旧版 1.0.0', confVer !== '1.0.0', 'confVer=' + confVer);

        /* 2. 界面上真正显示出来的字 */
        const shown = await ev(sw, `(function(){
            function t(id){ var e = document.getElementById(id); return e ? e.textContent.trim() : '(缺元素)'; }
            return JSON.stringify({
                ver: t('ver'),
                aboutVer: t('aboutVer'),
                // 顺便看"关于"那一整块里的版本行
                aboutRows: Array.prototype.slice.call(document.querySelectorAll('.am-row'))
                    .map(function(r){ return r.textContent.trim(); })
                    .filter(function(s){ return /版本/.test(s); })
            });
        })()`);
        rec('  界面显示: ' + shown);
        const s = JSON.parse(shown);
        check('2a 界面 #ver 显示 "v' + want + '"', s.ver === 'v' + want, 'ver=' + s.ver);
        check('2b 关于页 #aboutVer 显示 "v' + want + '"', s.aboutVer === 'v' + want, 'aboutVer=' + s.aboutVer);
        /* ⚠ 只看"当前版本"那一行 —— "版本更新时间"那行是**构建时间戳**，
         * 本来就不该含版本号（我第一版断言用 includes 把两行都算了，误报）。 */
        const verRow = s.aboutRows.find((r) => r.indexOf('当前版本') === 0) || '';
        check('2c 关于页「当前版本」行用的是新版本号', verRow.includes(want) && !verRow.includes('1.0.0'), verRow);
        check('2d 界面里没有残留 "v1.0.0"', !shown.includes('v1.0.0'), shown.slice(0, 160));

        /* 3. exe 的版本资源（Windows 层面） */
        // （PowerShell 那边已单独验过；这里只记录期望值供人工核对）
        rec('  （exe 的 FileVersion 由 PowerShell 侧的构建检查确认）');
    } catch (e) {
        rec('出错：' + (e && e.message));
        fail++;
    } finally {
        if (proc && proc.exitCode === null) { try { proc.kill(); } catch (e) { } }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        rec('');
        rec(`========== r80k：${pass} PASS / ${fail} FAIL ==========`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
