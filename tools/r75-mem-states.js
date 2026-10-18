/* ============================================================================
 *  r75：设置页内存分段测量
 *
 *  目的：弄清「设置页到底把内存花在哪」——
 *    ① 刚打开设置页（默认空列表，只有四个大类）
 *    ② 铺满「全部引擎」777 行 + 654 张图标
 *    ③ 把列表 DOM 清空（模拟"隐藏时把重东西放掉"能省多少）
 *    ④ 再让它重画回来（确认可恢复）
 *
 *  量法：整棵进程树的 WS / 私有页（tools/_ws-tree.ps1）。
 *  用法：node tools/r75-mem-states.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r75-mem-states.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP 超时：' + m)); }, 10000);
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
const heap = async (ws) => await ev(ws, "(performance.memory && performance.memory.usedJSHeapSize) ? Math.round(performance.memory.usedJSHeapSize/1048576*10)/10 : null");

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-memst-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'memst' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });

    // 先只起横条（不带 --settings），量「没有设置页」的底
    const p1 = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    await sleep(9000);
    const s0 = treeMem(p1.pid);
    rec(`① 只有横条（没开设置页）：WS=${s0.ws} MB，私有=${s0.priv} MB，进程=${s0.n}`);
    try { execSync(`taskkill /PID ${p1.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
    await sleep(1500);

    // 再起带设置页的
    PORT = await freePort();
    env.QS_T_WV_ARGS = WV_BASE + PORT;
    env.QS_INSTANCE_TAG = 'memst2' + Date.now().toString(36);
    const p2 = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    const sw = await connect('settings.html');
    if (!sw) { rec('连不上设置页'); return; }
    await until(sw, "typeof CATALOG === 'object' && !!CATALOG.categories", 30000);
    await sleep(2500);
    const s1 = treeMem(p2.pid);
    rec(`② 设置页刚打开（默认空列表）：WS=${s1.ws} MB，私有=${s1.priv} MB，进程=${s1.n}，JS 堆=${await heap(sw)} MB`);

    try { await cdp(sw, 'Page.bringToFront'); } catch (e) { }
    await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
    await sleep(600);
    await ev(sw, `(function(){var c=[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item')).find(function(b){return b.textContent==='全部引擎';});if(c)c.click();return !!c;})()`);
    await until(sw, "document.querySelectorAll('#allList .item').length > 100", 25000);
    await sleep(3000);
    const s2 = treeMem(p2.pid);
    const rows = await ev(sw, "document.querySelectorAll('#allList .item').length");
    rec(`③ 铺满全部引擎（${rows} 行 + ${await ev(sw, "document.querySelectorAll('#allList img').length")} 张图）：WS=${s2.ws} MB，私有=${s2.priv} MB，进程=${s2.n}，JS 堆=${await heap(sw)} MB`);

    // 清空列表 DOM（模拟"隐藏时把重东西放掉"）
    await ev(sw, "(function(){var b=document.getElementById('allList');if(b)b.textContent='';return document.querySelectorAll('#allList .item').length;})()");
    await sleep(2500);
    const s3 = treeMem(p2.pid);
    rec(`④ 清空列表 DOM 之后：WS=${s3.ws} MB，私有=${s3.priv} MB，进程=${s3.n}，JS 堆=${await heap(sw)} MB`);

    // 再画回来（确认可恢复，不是只能单向清）
    await ev(sw, "renderAllList()");
    await until(sw, "document.querySelectorAll('#allList .item').length > 100", 25000);
    await sleep(2500);
    const s4 = treeMem(p2.pid);
    rec(`⑤ 重画回来（${await ev(sw, "document.querySelectorAll('#allList .item').length")} 行）：WS=${s4.ws} MB，私有=${s4.priv} MB，JS 堆=${await heap(sw)} MB`);

    rec('');
    rec('---------- 结论 ----------');
    rec(`设置页本身（①→②）：WS +${(s1.ws - s0.ws).toFixed(1)} MB，私有 +${(s1.priv - s0.priv).toFixed(1)} MB`);
    rec(`引擎列表（②→③）：WS +${(s2.ws - s1.ws).toFixed(1)} MB，私有 +${(s2.priv - s1.priv).toFixed(1)} MB`);
    rec(`清空列表能放掉（③→④）：WS ${(s3.ws - s2.ws).toFixed(1)} MB，私有 ${(s3.priv - s2.priv).toFixed(1)} MB`);
    rec(`重画回来是否成功（④→⑤）：${s4.ws > 0 ? '是' : '否'}`);

    try { execSync(`taskkill /PID ${p2.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
})();