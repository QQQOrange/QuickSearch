/* ============================================================================
 *  r75：设置窗口「关掉一段时间后真正销毁」验证
 *
 *  验的是三件事（用户口径的"内存更小"，但不能拿体验换）：
 *    ① 点 X 关掉设置页 → 窗口只是隐藏（页面还活着，短时间再开是秒开）
 *    ② 超过 QS_SETTINGS_IDLE_SECS → 窗口被真正销毁，那 200~300MB 还给系统
 *    ③ 销毁之后还能正常打开（重建一份），功能不受影响
 *
 *  量法：整棵进程树的 WS/私有页（tools/_ws-tree.ps1）；关闭动作走
 *  tools/_close-win.ps1 的 WM_CLOSE —— 和用户点 X 是同一条路。
 *
 *  用法：node tools/r75-settings-reap.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r75-settings-reap.txt');
const IDLE = 8;                     // 故意调小：真机验证不能等三分钟
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 10000);
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
async function targets() {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); } catch (e) { return []; }
}
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
        const ts = await targets();
        /* 横条页不能用 url.indexOf('bar') 找：tauri.localhost/ 是
         * tauri.localhost/settings.html 的前缀，按子串找会连到设置页上。
         * 这里照 r72-bar-img-probe 的口径按"整页路径"匹配。 */
        const hit = ts.find((t) => {
            const u = t.url || '';
            if (t.type !== 'page') return false;
            if (sub === 'bar') return /tauri\.localhost\/?(index\.html)?(\?|$)/.test(u);
            return u.indexOf(sub) >= 0;
        });
        if (hit) {
            const ws = new WebSocket(hit.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            return ws;
        }
        await sleep(300);
    }
    return null;
}
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) { if (await ev(ws, expr) === true) return true; await sleep(250); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}
function treeMem(pid) {
    try {
        const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, '_ws-tree.ps1')}" ${pid}`,
            { encoding: 'utf8', timeout: 30000 }).trim();
        const [ws, priv, n] = out.split(/\s+/);
        return { ws: parseFloat(ws), priv: parseFloat(priv), n: parseInt(n, 10) };
    } catch (e) { return { ws: NaN, priv: NaN, n: 0 }; }
}
const hasSettings = async () => (await targets()).some((t) => (t.url || '').indexOf('settings.html') >= 0);

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-reap-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'reap' + Date.now().toString(36),
        QS_SETTINGS_IDLE_SECS: String(IDLE),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec(`r75 she zhi chuang hui shou tan zhen: pid=${proc.pid}, idle=${IDLE}s`);
    try {
        const sw = await connect('settings.html');
        check('S1 settings page up', !!sw);
        if (!sw) return;
        await until(sw, "typeof CATALOG === 'object' && !!CATALOG.categories", 30000);
        // 把最占内存的那个视图也铺出来，量的才是真实占用
        try { await cdp(sw, 'Page.bringToFront'); } catch (e) { }
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(600);
        await ev(sw, `(function(){var c=[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item')).find(function(b){return b.textContent==='\u5168\u90e8\u5f15\u64ce';});if(c)c.click();return !!c;})()`);
        await until(sw, "document.querySelectorAll('#allList .item').length > 100", 25000);
        await sleep(2500);
        const open = treeMem(proc.pid);
        rec(`(1) settings open (engine list rendered): WS=${open.ws} MB, priv=${open.priv} MB, procs=${open.n}`);

        // —— 真·关闭（WM_CLOSE）：只该隐藏 ——
        let closed = '';
        try {
            closed = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, '_close-win.ps1')}" -RootPid ${proc.pid} -Match settings`,
                { encoding: 'utf8', timeout: 20000 }).trim();
        } catch (e) {
            closed = 'ERR ' + (e && e.message);
            if (e && e.stdout) closed += ' | out=' + String(e.stdout).trim();
        }
        rec('close action: ' + closed);
        await sleep(2500);
        const stillAlive = await hasSettings();
        check('S2 after X: window only hidden (page alive, instant reopen kept)', stillAlive === true && closed === 'closed', 'closed=' + closed + ' alive=' + stillAlive);
        const hid = treeMem(proc.pid);
        rec(`(2) just closed (hidden): WS=${hid.ws} MB, priv=${hid.priv} MB`);

        // —— 等回收线程动手 ——
        const t0 = Date.now();
        let gone = false;
        while (Date.now() - t0 < (IDLE + 25) * 1000) {
            if (!(await hasSettings())) { gone = true; break; }
            await sleep(1500);
        }
        const waited = ((Date.now() - t0) / 1000).toFixed(1);
        check(`S3 destroyed after ${IDLE}s idle (waited ${waited}s)`, gone);
        if (!gone) { rec('(not destroyed; skip remaining)'); return; }
        await sleep(2000);
        const dead = treeMem(proc.pid);
        rec(`(3) after destroy: WS=${dead.ws} MB, priv=${dead.priv} MB, procs=${dead.n}`);
        rec(`    reclaimed: WS ${(hid.ws - dead.ws).toFixed(1)} MB, priv ${(hid.priv - dead.priv).toFixed(1)} MB`);
        check('S4 memory really returned (WS drop > 80MB)', (hid.ws - dead.ws) > 80, `dropped ${(hid.ws - dead.ws).toFixed(1)} MB`);

        // —— 还能再打开（重建） ——
        const bw = await connect('bar', 20000);
        check('S5 bar page still attached (can drive reopen)', !!bw);
        if (bw) {
            /* 参数名有坑：Tauri 2 默认把 Rust 的 snake_case 参数在 JS 侧写成
             * camelCase，但 Option 参数也可以整个不给。三种写法挨个试一遍，
             * 记下哪种成功 —— 探针要验的是"能不能重开"，不是参数命名规则。 */
            const forms = [
                "window.__TAURI__.core.invoke('open_settings', {})",
                "window.__TAURI__.core.invoke('open_settings', { focusEngine: null, tab: null })",
                "window.__TAURI__.core.invoke('open_settings', { focus_engine: null, tab: null })",
            ];
            let r = '';
            for (const f of forms) {
                r = await ev(bw, `${f}.then(function(){return 'ok';}).catch(function(e){return 'ERR '+e;})`);
                rec('reopen call -> ' + r);
                if (r === 'ok') break;
                await sleep(300);
            }
            let back = false;
            const t1 = Date.now();
            while (Date.now() - t1 < 30000) { if (await hasSettings()) { back = true; break; } await sleep(500); }
            check('S6 after destroy settings can still be opened (rebuilt)', back);
            if (back) {
                const sw2 = await connect('settings.html', 15000);
                const ok = sw2 ? await until(sw2, "typeof CATALOG === 'object' && !!CATALOG.categories", 25000) : false;
                check('S7 rebuilt settings page loads data too (not an empty shell)', ok === true);
                await sleep(1500);
                const again = treeMem(proc.pid);
                rec(`(4) after reopen: WS=${again.ws} MB, priv=${again.priv} MB`);
            }
        }
    } catch (e) {
        rec('probe error: ' + (e && e.message));
    } finally {
        rec('');
        rec(`========== r75 settings reap: ${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(800);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        process.exit(fail === 0 ? 0 : 1);
    }
})();