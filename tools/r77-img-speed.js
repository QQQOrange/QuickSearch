/* ============================================================================
 *  r77：识图提速的量尺（A/B：桌面旧版 vs 新构建）
 *
 *  量的是用户感知的那一段：**松手 → 截图开始**（遮罩撤净的等待）。
 *  这一段以前是固定 700ms，现在改成"看屏幕像素稳定没"。
 *
 *  怎么量：触发识图 → 连上遮罩页 → 模拟框选 → 从日志里取两条时间戳：
 *    · `[region] mouseup -> img_region`（用户松手、命令发出的那一刻）
 *    · `img: 遮罩像素已撤净=` 或 `img: jpeg`（截图完成、开始编码）
 *  两者之差就是"等遮罩消失"这段。
 *
 *  用法：node tools/r77-img-speed.js [旧exe] [新exe]
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = process.argv[2] || 'C:\\Users\\64381\\Desktop\\QuickSearch.exe.old-r76-20261018-101556';
const B = process.argv[3] || path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r77-img-speed.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 15000);
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
async function targets() { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); } catch (e) { return []; } }
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
        const ts = await targets();
        const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
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
    while (Date.now() - t0 < (ms || 20000)) { if (await ev(ws, expr) === true) return true; await sleep(150); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

/** 跑一次，返回"松手 → 截图完成"的毫秒数（量 3 次取中位）。 */
async function measure(label, exe) {
    rec('');
    rec('========== ' + label + ' ==========');
    rec('exe: ' + path.basename(exe));
    if (!fs.existsSync(exe)) { rec('找不到这个 exe，跳过'); return null; }
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-spd-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, theme: 'light',
        // 只勾"打开页面"的那一家，避免上传耗时混进来 —— 量的就是遮罩等待
        img_default_engine: 'doubao', img_engines: ['doubao'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'spd' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(exe, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    const logf = path.join(qs, 'log.txt');
    const samples = [];
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页'); return null; }
        await until(sw, "typeof CONF === 'object'", 30000);
        for (let round = 0; round < 3; round++) {
            const mark = fs.existsSync(logf) ? fs.statSync(logf).size : 0;
            await ev(sw, "window.__TAURI__.core.invoke('img_start').catch(function(){})");
            const region = await connect('region.html', 15000);
            if (!region) { rec(`  第 ${round + 1} 轮：遮罩没开出来`); continue; }
            await sleep(400);
            await ev(region, `(function(){
                function e2(t,x,y){document.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));}
                e2('mousedown',300,300); e2('mousemove',700,600);
                document.dispatchEvent(new MouseEvent('mouseup',{clientX:700,clientY:600,button:0,bubbles:true,cancelable:true}));
                return 'ok';
            })()`);
            await sleep(3000);
            // 解析这几行
            const fresh = fs.readFileSync(logf, 'utf8').slice(mark);
            const lines = fresh.split(/\r?\n/);
            const tOf = (re) => {
                for (const l of lines) {
                    const m = /intervals:\s*(\d+)/.exec(l);
                    if (m && re.test(l)) return Number(m[1]);
                }
                return null;
            };
            const t0 = tOf(/mouseup -> img_region/);
            const t1 = tOf(/遮罩像素已撤净|img: jpeg/);
            if (t0 && t1) {
                const ms = Math.round((t1 - t0) / 10000);   // 100ns 单位 → ms
                samples.push(ms);
                rec(`  第 ${round + 1} 轮：松手 → 截图完成 = ${ms} ms`);
            } else {
                rec(`  第 ${round + 1} 轮：日志里没找到配对的时间戳`);
            }
            await ev(region, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))").catch(() => { });
            await sleep(600);
        }
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(800);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
    if (!samples.length) return null;
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)];
    rec(`中位数：${med} ms（样本 ${samples.join(' / ')}）`);
    return med;
}

(async () => {
    rec('r77 识图提速 A/B（松手 → 遮罩撤净/截图完成）');
    const a = await measure('A：桌面 r76 版（固定等 700ms）', A);
    const b = await measure('B：新构建（等像素撤净）', B);
    rec('');
    rec('---------- 结论 ----------');
    if (a && b) {
        rec(`松手→截图：${a} ms → ${b} ms（${b - a >= 0 ? '+' : ''}${b - a} ms，`
            + `${(((b - a) / a) * 100).toFixed(0)}%）`);
    } else {
        rec('有一侧没量到（旧版 exe 可能已被清理），看上面的逐轮数据');
    }
})();