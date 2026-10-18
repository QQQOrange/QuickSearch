/* ============================================================================
 *  r79-d：抠图效果的**量化指标**（不再只靠眼睛）
 *
 *  目的：给"效果好不好"一个可比的数字。
 *
 *  两个指标（对"有可辨识背景"的图标才有意义）：
 *    · 边界残留率 = 抠图后四边外圈仍不透明的像素占比
 *        —— 背景没抠干净时这个值高（理想接近 0）
 *    · 中心保留率 = 图中心区域仍不透明的像素占比
 *        —— 主体被误删时这个值低（理想接近 1）
 *
 *  为什么不能只看"抠了多少像素"：抠多了看起来数值漂亮，实际是把主体也抠了。
 *  两个指标一起看才有意义。
 *
 *  用法：node tools/r79-metrics.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const ICONDIR = path.join(ROOT, 'ui', 'data', 'icons');
const OUT = path.join(__dirname, 'r79-metrics.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

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

/* 计算两个指标。ring = 外圈厚度比例。 */
const METRIC = (src, ringPct) => `(function(){
    return new Promise(function(res){
        var im = new Image();
        im.onload = function(){
            var W = im.naturalWidth, H = im.naturalHeight;
            var cv = document.createElement('canvas'); cv.width=W; cv.height=H;
            var cx = cv.getContext('2d', { willReadFrequently: true });
            cx.clearRect(0,0,W,H);
            cx.drawImage(im,0,0);
            var d = cx.getImageData(0,0,W,H).data;
            var rx = Math.max(1, Math.round(W * ${ringPct}));
            var ry = Math.max(1, Math.round(H * ${ringPct}));
            var ringTot=0, ringOpaque=0, cenTot=0, cenOpaque=0;
            var x0=Math.round(W*0.35), x1=Math.round(W*0.65);
            var y0=Math.round(H*0.35), y1=Math.round(H*0.65);
            for (var y=0;y<H;y++){
                for (var x=0;x<W;x++){
                    var a = d[(y*W+x)*4+3];
                    var inRing = (x<rx || y<ry || x>=W-rx || y>=H-ry);
                    if (inRing){ ringTot++; if (a>40) ringOpaque++; }
                    else if (x>=x0 && x<x1 && y>=y0 && y<y1){ cenTot++; if (a>40) cenOpaque++; }
                }
            }
            res(JSON.stringify({
                w:W, h:H,
                ringPct: ringTot? ringOpaque/ringTot : 0,
                centerPct: cenTot? cenOpaque/cenTot : 0
            }));
        };
        im.onerror = function(){ res('ERR'); };
        im.src = ${JSON.stringify(src)};
    });
})()`;

function pickIcons(n) {
    const all = fs.readdirSync(ICONDIR).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
    const out = [];
    for (const f of all) {
        if (out.length >= n) break;
        const p = path.join(ICONDIR, f);
        try {
            const st = fs.statSync(p);
            if (st.size > 900 && st.size < 200_000) out.push({ f, p });
        } catch (e) { }
    }
    return out;
}

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r79d-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r79d' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r79-d 抠图量化指标');
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 30000);
        const icons = pickIcons(16);
        rec('');
        rec('图标                                  尺寸    抠掉   边界残留  中心保留  判定');
        rec('-------------------------------------+-------+-------+---------+---------+------');
        let bad = 0, good = 0;
        const details = [];
        for (const ic of icons) {
            const b64 = fs.readFileSync(ic.p).toString('base64');
            const ext = ic.f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
            const dataUrl = `data:image/${ext};base64,${b64}`;
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl)}, tolerance: 48, keep: null
            }).then(function(r){ return JSON.stringify({s:r.src,n:r.removed,b:r.noBackground}); })
              .catch(function(e){ return 'ERR ' + e; })`);
            if (typeof r !== 'string' || r.startsWith('ERR')) { rec('  ' + ic.f + ' 失败'); continue; }
            const o = JSON.parse(r);
            const m = JSON.parse(await ev(sw, METRIC(o.s, 0.04)));
            /* 判定：**与原图对比**，不用绝对阈值。
             *
             * 为什么改：绝对阈值会误报 —— 文字型/线框型 logo（gog.com、Lobsters
             * 的细线 L、CNBC 文字）的图中心本来就夹着背景，中心不透明率天然很低，
             * 会被错判成"主体被删"。我人工放大了那 6 个，抠得都是对的。
             *
             * 正确口径：抠图**不该让中心区域的不透明率大幅下降** ——
             * 原图 30% 抠完还是 30%，就是对的；掉到 5% 才是把主体删了。 */
            const mo = JSON.parse(await ev(sw, METRIC(dataUrl, 0.04)));
            const drop = mo.centerPct > 0.02 ? (mo.centerPct - m.centerPct) / mo.centerPct : 0;
            let verdict;
            if (o.b) { verdict = '跳过'; }
            else if (drop > 0.6 && m.centerPct < 0.35) { verdict = '主体被删'; bad++; }
            else if (m.ringPct > 0.35) { verdict = '没抠干净'; bad++; }
            else { verdict = 'OK'; good++; }
            const line = ic.f.padEnd(36).slice(0, 36) + ' '
                + String(m.w + 'x' + m.h).padStart(7) + ' '
                + String(o.n).padStart(6) + ' '
                + (m.ringPct * 100).toFixed(1).padStart(7) + '% '
                + (m.centerPct * 100).toFixed(1).padStart(7) + '% '
                + ' ' + verdict;
            rec(line);
            details.push({ f: ic.f, verdict, ring: m.ringPct, center: m.centerPct, n: o.n });
        }
        rec('');
        rec('OK ' + good + ' 个 / 有问题 ' + bad + ' 个');
        const problems = details.filter((d) => d.verdict === '没抠干净' || d.verdict === '主体被删');
        if (problems.length) {
            rec('');
            rec('有问题的图标：');
            for (const p of problems) {
                rec('  ' + p.f + '  ' + p.verdict
                    + '  (边界残留 ' + (p.ring * 100).toFixed(1) + '%, 中心保留 ' + (p.center * 100).toFixed(1) + '%)');
            }
        }
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(500);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
