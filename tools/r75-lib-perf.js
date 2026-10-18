/* ============================================================================
 *  r75：引擎库长列表的渲染性能 A/B
 *
 *  量的是用户真正能感觉到的那一段：把「全部引擎」铺出来，然后一路往下滚。
 *  每个滚动步之后**强制读一次布局**（offsetHeight），浏览器必须把这批行的
 *  布局算完才能回答 —— 于是"屏幕外那些行要不要参与布局"这件事直接体现在
 *  总耗时里（r75 给行加了 content-visibility: auto）。
 *
 *  同一台机器、同一套脚本、同一份引擎数据，只换 exe。
 *
 *  用法：
 *      node tools/r75-lib-perf.js                 # 桌面 r74 版 vs target/release
 *      node tools/r75-lib-perf.js <exeA> <exeB>
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = process.argv[2] || 'C:\\Users\\64381\\Desktop\\QuickSearch.exe';
const B = process.argv[3] || path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r75-lib-perf.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 30000);
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
    while (Date.now() - t0 < (ms || 25000)) { if (await ev(ws, expr) === true) return true; await sleep(200); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

/* 在页面里跑一段固定脚本，返回结构化的耗时数据。 */
const BENCH = `(async function(){
    var t0 = performance.now();
    var chip = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
        .find(function(b){ return b.textContent === '\\u5168\\u90e8\\u5f15\\u64ce'; });
    if (chip) chip.click();
    // 等行铺出来
    var waited = 0;
    while (document.querySelectorAll('#allList .item').length < 100 && waited < 20000) {
        await new Promise(function(r){ setTimeout(r, 50); });
        waited += 50;
    }
    var tRender = performance.now() - t0;
    var rows = document.querySelectorAll('#allList .item').length;
    var m = document.getElementById('main');
    m.scrollTop = 0;
    // 一路往下滚，每步之后强制布局（读一次 offsetHeight）
    var t1 = performance.now();
    var step = Math.max(120, Math.floor(m.clientHeight * 0.6));
    var forced = 0;
    for (var i = 0; i < 40; i++) {
        m.scrollTop = i * step;
        forced += document.getElementById('allList').offsetHeight > 0 ? 1 : 0;
    }
    var tScroll = performance.now() - t1;
    m.scrollTop = 0;
    return JSON.stringify({ rows: rows, tRenderMs: Math.round(tRender), tScrollMs: Math.round(tScroll), forced: forced, page: m.clientHeight });
})()`;

async function measure(label, exe) {
    rec('');
    rec('========== ' + label + ' ==========');
    rec('exe: ' + exe);
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-perf-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'perf' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(exe, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    let out = null;
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页'); return null; }
        await until(sw, "typeof CATALOG === 'object' && !!CATALOG.categories", 30000);
        try { await cdp(sw, 'Page.bringToFront'); } catch (e) { }
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(800);
        // 跑三遍取中位数：单次测量在 WebView 里抖得厉害
        const runs = [];
        for (let i = 0; i < 3; i++) {
            const r = await ev(sw, BENCH);
            if (typeof r === 'string' && r[0] === '{') runs.push(JSON.parse(r));
            await sleep(600);
        }
        rec('三遍原始数据：' + JSON.stringify(runs));
        if (runs.length) {
            const med = (k) => runs.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
            out = { rows: runs[0].rows, tRenderMs: med('tRenderMs'), tScrollMs: med('tScrollMs'), page: runs[0].page };
            rec(`行数=${out.rows}（每屏 ${out.page}px）`);
            rec(`铺列表耗时(中位)=${out.tRenderMs} ms   滚动 40 步强制布局(中位)=${out.tScrollMs} ms`);
        }
    } catch (e) {
        rec('测量出错：' + (e && e.message));
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(1000);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
    return out;
}

(async () => {
    rec('r75 引擎库渲染性能 A/B');
    const a = await measure('A：桌面 r74 版', A);
    const b = await measure('B：新构建（r75，content-visibility）', B);
    rec('');
    rec('---------- 结论 ----------');
    if (a && b) {
        const d = (x, y) => `${x} ms → ${y} ms（${y - x >= 0 ? '+' : ''}${y - x} ms，${x ? (((y - x) / x) * 100).toFixed(1) : '?'}%）`;
        rec('铺列表：' + d(a.tRenderMs, b.tRenderMs));
        rec('滚动+布局：' + d(a.tScrollMs, b.tScrollMs));
    } else {
        rec('有一侧没量到，看上面的日志');
    }
})();