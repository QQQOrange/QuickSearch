/* ============================================================================
 *  r75：内存 A/B 探针（同一台机器、同一套口径，对比两个 exe）
 *
 *  为什么要 A/B：QuickSearch 是 Tauri（Rust 主进程 + 一窝 WebView2 子进程），
 *  「设置页把 407 张引擎图标全解码」这件事吃的是**渲染进程**的内存，只有把
 *  整棵进程树加起来才看得见。
 *
 *  量的是同一件事：起窗 → 打开设置页 → 切到引擎页 → 点「全部引擎」把 700+ 行
 *  铺出来 → 等图标解码完 → 读进程树 WS/私有页合计。
 *
 *  用法：
 *      node tools/r75-mem-ab.js                     # 对比桌面 r74 版与 target/release
 *      node tools/r75-mem-ab.js <exeA> <exeB>       # 自定义对比
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = process.argv[2] || 'C:\\Users\\64381\\Desktop\\QuickSearch.exe';
const B = process.argv[3] || path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r75-mem-ab.txt');

const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0;
let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP 超时：' + m)); }, 10000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (!x || x.id !== i) return;
            clearTimeout(timer);
            ws.removeEventListener('message', on);
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
    while (Date.now() - t0 < (ms || 20000)) {
        if (await ev(ws, expr) === true) return true;
        await sleep(250);
    }
    return false;
}

async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

/** 进程树 WS/私有页/进程数（MB），走 tools/_ws-tree.ps1 */
function treeMem(pid) {
    try {
        const out = execSync(
            `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, '_ws-tree.ps1')}" ${pid}`,
            { encoding: 'utf8', timeout: 30000 }
        ).trim();
        const [ws, priv, n] = out.split(/\s+/);
        return { ws: parseFloat(ws), priv: parseFloat(priv), n: parseInt(n, 10) };
    } catch (e) {
        return { ws: NaN, priv: NaN, n: 0 };
    }
}

/** 量一个 exe：返回 { ws, priv, n, rows, icons, heapMB } */
async function measure(label, exe) {
    rec('');
    rec('========== ' + label + ' ==========');
    rec('exe: ' + exe + '  (' + (fs.statSync(exe).size / 1048576).toFixed(2) + ' MB)');
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-mem-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'mem' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(exe, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    const pid = proc.pid;
    let res = { ws: NaN, priv: NaN, n: 0, rows: 0, icons: 0, heapMB: NaN };
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页，跳过'); return res; }
        await until(sw, "typeof CATALOG === 'object' && !!CATALOG.categories", 30000);
        try { await cdp(sw, 'Page.bringToFront'); } catch (e) { }
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(700);
        // 铺出「全部引擎」700+ 行（脚本 click 不受可见性影响）
        await ev(sw, `(function(){var c=[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item')).find(function(b){return b.textContent==='全部引擎';});if(c)c.click();return !!c;})()`);
        await until(sw, "document.querySelectorAll('#allList .item').length > 100", 25000);
        // 等图标解码/懒加载稳定下来：滚到中间再回顶，模拟真实浏览一遍
        await sleep(2500);
        res.rows = await ev(sw, "document.querySelectorAll('#allList .item').length");
        res.icons = await ev(sw, "document.querySelectorAll('#allList img').length");
        const heap = await ev(sw, "(performance.memory && performance.memory.usedJSHeapSize) ? Math.round(performance.memory.usedJSHeapSize/1048576*10)/10 : null");
        res.heapMB = heap;
        await sleep(1500);
        const m = treeMem(pid);
        res.ws = m.ws; res.priv = m.priv; res.n = m.n;
        rec(`行数=${res.rows} img 数=${res.icons} JS 堆=${res.heapMB} MB`);
        rec(`进程树：${res.n} 个进程，WS=${res.ws} MB，私有页=${res.priv} MB`);
    } catch (e) {
        rec('测量出错：' + (e && e.message));
    } finally {
        try { proc.kill(); } catch (e) { }
        await sleep(1200);
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
    return res;
}

(async () => {
    rec('r75 内存 A/B：同一套量法，只换 exe');
    const a = await measure('A：桌面 r74 版（懒加载改动之前）', A);
    const b = await measure('B：新构建（r75，图标懒加载）', B);
    rec('');
    rec('---------- 结论 ----------');
    if (isFinite(a.ws) && isFinite(b.ws)) {
        rec(`WS  ：A=${a.ws} MB → B=${b.ws} MB  （${(b.ws - a.ws >= 0 ? '+' : '')}${(b.ws - a.ws).toFixed(1)} MB，`
            + `${a.ws > 0 ? (((b.ws - a.ws) / a.ws) * 100).toFixed(1) : '?'}%）`);
        rec(`私有：A=${a.priv} MB → B=${b.priv} MB  （${(b.priv - a.priv >= 0 ? '+' : '')}${(b.priv - a.priv).toFixed(1)} MB）`);
        rec(`进程：A=${a.n} → B=${b.n}`);
    } else {
        rec('有一侧没量到，看上面的日志');
    }
})();