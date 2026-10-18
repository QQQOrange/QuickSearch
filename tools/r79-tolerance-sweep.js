/* ============================================================================
 *  r79-bis：白底白主体 —— 试不同容差，看是否真的能分开
 *
 *  视觉对比（`r79-matting-visual.js`）里那个「白底 + 白色主体」场景在
 *  容差 48 时**保持原样不动**（判定"没有可靠背景"，保守出口）。
 *  我在界面提示里写了"可以试着把容差调小" —— 这个脚本负责**验证那句话是真的**。
 *
 *  如果任何容差都分不开，那就该把提示改掉（不许给用户一个做不到的建议）。
 *
 *  用法：node tools/r79-tolerance-sweep.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r79-tolerance-sweep.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 40000);
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

/* 白底 + 白色主体（带极淡灰环，模拟真实白色 logo 的轮廓） */
const MAKE = (S) => `(function(){
    var S = ${S};
    var cv = document.createElement('canvas'); cv.width=S; cv.height=S;
    var cx = cv.getContext('2d');
    cx.fillStyle='#ffffff'; cx.fillRect(0,0,S,S);
    cx.fillStyle='#f0f0f0';
    cx.beginPath(); cx.arc(S/2,S/2,S*0.32,0,Math.PI*2); cx.fill();
    cx.fillStyle='#ffffff';
    cx.beginPath(); cx.arc(S/2,S/2,S*0.28,0,Math.PI*2); cx.fill();
    return cv.toDataURL('image/png');
})()`;

const READ = (src) => `(function(){
    return new Promise(function(res){
        var im = new Image();
        im.onload = function(){
            var S = im.naturalWidth;
            var cv = document.createElement('canvas'); cv.width=S; cv.height=S;
            var cx = cv.getContext('2d', { willReadFrequently: true });
            cx.drawImage(im,0,0);
            var d = cx.getImageData(0,0,S,S).data;
            function a(fx,fy){ var x=Math.round(fx*S), y=Math.round(fy*S);
                x=Math.max(0,Math.min(S-1,x)); y=Math.max(0,Math.min(S-1,y));
                return d[(y*S+x)*4+3]; }
            res(JSON.stringify({ corner: a(0.02,0.02), center: a(0.5,0.5), ring: a(0.5,0.18) }));
        };
        im.onerror=function(){ res('ERR'); };
        im.src = ${JSON.stringify(src)};
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r79t-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r79t' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r79-bis 容差扫描：白底 + 白色主体');
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 30000);
        const img = await ev(sw, MAKE(192));
        rec('');
        rec('容差 | removed | 判定     | 角落alpha | 中心alpha | 环alpha');
        rec('-----+---------+----------+-----------+-----------+--------');
        let anyOk = false;
        for (const tol of [60, 48, 36, 24, 16, 10, 5, 0]) {
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(img)}, tolerance: ${tol}, keep: null
            }).then(function(r){ return JSON.stringify({n:r.removed,b:r.noBackground,s:r.src}); }).catch(function(e){ return 'ERR '+e; })`);
            if (typeof r !== 'string' || r.startsWith('ERR')) { rec(tol + ' | 失败 ' + r); continue; }
            const o = JSON.parse(r);
            const px = JSON.parse(await ev(sw, READ(o.s)));
            // 成功的判据：角落被抠透(0)、中心保住(>200)
            const ok = px.corner === 0 && px.center > 200;
            if (ok) anyOk = true;
            rec(
                String(tol).padStart(4) + ' | ' + String(o.n).padStart(7) + ' | '
                + (o.b ? '无背景  ' : '有背景  ') + ' | '
                + String(px.corner).padStart(9) + ' | ' + String(px.center).padStart(9) + ' | ' + String(px.ring).padStart(6)
                + (ok ? '   ← 成功分开' : '')
            );
        }
        rec('');
        rec(anyOk
            ? '结论：**存在能分开的容差** —— 界面提示"把容差调小试试"是成立的。'
            : '结论：**任何容差都分不开** —— 界面不该建议用户调容差（提示需要改）。');

        /* —— 验证界面承诺的另一条路：手动补描 ——
         * 提示里告诉用户"用「手动补描」涂出主体再点一次"。这条路必须真的有效，
         * 否则那句提示又是一句做不到的建议。 */
        rec('');
        rec('=== 手动补描能否救回这张图 ===');
        const keep = JSON.parse(await ev(sw, `(function(){
            var S = 192;
            var d = new Uint8Array(S*S);
            var c = S/2, r = S*0.30;
            for (var y=0;y<S;y++) for (var x=0;x<S;x++){
                if ((x-c)*(x-c)+(y-c)*(y-c) <= r*r) d[y*S+x] = 255;
            }
            return JSON.stringify({ w: S, h: S, data: Array.from(d) });
        })()`));
        const r2 = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
            src: ${JSON.stringify(img)}, tolerance: 48, keep: ${JSON.stringify(keep)}
        }).then(function(r){ return JSON.stringify({n:r.removed,b:r.noBackground,s:r.src}); }).catch(function(e){ return 'ERR '+e; })`);
        if (typeof r2 === 'string' && !r2.startsWith('ERR')) {
            const o2 = JSON.parse(r2);
            const px2 = JSON.parse(await ev(sw, READ(o2.s)));
            rec('补描后：removed=' + o2.n + ' 角落alpha=' + px2.corner + ' 中心alpha=' + px2.center);
            rec((px2.corner === 0 && px2.center > 200)
                ? '结论：**手动补描能救回** —— 提示里那条建议是成立的。'
                : '结论：补描也没救回来 —— 提示需要改。');
        } else {
            rec('补描调用失败：' + r2);
        }
    } catch (e) {
        rec('出错：' + (e && e.message));
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(500);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
