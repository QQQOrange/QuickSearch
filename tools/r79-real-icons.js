/* ============================================================================
 *  r79-c：用**真实图标**做抠图对比（这才是有意义的检验）
 *
 *  为什么重写这个脚本：上一版 `r79-matting-visual.js` 用的是我自己用 canvas 画的
 *  合成图（纯色底 + 圆/方块）。那些图**太简单了** —— 连旧算法都能应付，
 *  所以"看起来效果一样"什么都证明不了。用户说的"效果非常差"是针对**真实图标**的：
 *  它们有抗锯齿边缘、半透明像素、内部渐变、复杂轮廓。
 *
 *  这个脚本直接拿 `ui/data/icons/` 里的真实图标（PNG，带透明/不带透明的都有），
 *  跑抠图，把「原图 / 抠图后」并排画出来。人一眼就能判断好坏。
 *
 *  用法：node tools/r79-real-icons.js
 *  产出：docs/evidence/r79-real-icons.png + 每格单独文件
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const ICONDIR = path.join(ROOT, 'ui', 'data', 'icons');
const OUTDIR = path.join(ROOT, 'docs', 'evidence');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* 挑真实图标：优先选**不透明底**的（那些才需要抠背景），
 * 并且尺寸适中的（太大/太小都看不出细节）。 */
function pickIcons(n) {
    const all = fs.readdirSync(ICONDIR)
        .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
        .map((f) => ({ f, p: path.join(ICONDIR, f) }))
        .filter((x) => {
            try {
                const st = fs.statSync(x.p);
                return st.size > 900 && st.size < 200_000;   // 别太小(单色点)也别太大(照片)
            } catch (e) { return false; }
        });
    // 取前 n 个（按名字排，稳定可复现），跳过明显是"透明底"的：用 PNG 的 alpha 判断
    const out = [];
    for (const x of all) {
        if (out.length >= n) break;
        const buf = fs.readFileSync(x.p);
        // PNG: 简单看有没有 tRNS 块或颜色类型 6（RGBA）
        const isPng = buf.slice(1, 4).toString() === 'PNG';
        let likelyOpaqueBg = false;
        if (isPng) {
            // IHDR 的颜色类型在偏移 25
            const colorType = buf[25];
            likelyOpaqueBg = (colorType === 2 || colorType === 0 || colorType === 6);
            // 颜色类型 6 = RGBA，可能已经是透明的 —— 但很多"白底 RGBA"也在里面，
            // 所以还是留着（正好检验"已透明的不该被改坏"）
        } else {
            likelyOpaqueBg = true;   // jpg/ico 一般没有 alpha
        }
        if (likelyOpaqueBg) out.push(x);
    }
    return out;
}

const COMPOSE = (items, cell) => `(function(){
    var items = ${JSON.stringify(items)};
    var cell = ${cell};
    var pad = 14, capH = 22;
    var rows = Math.ceil(items.length / 2);
    var cols = 4;   // 原图 / 抠后 / 原图 / 抠后 —— 两列一组
    var W = cols*cell + pad*(cols+1);
    var H = rows*(cell+capH) + pad*(rows+1);
    var cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    var cx = cv.getContext('2d');
    cx.fillStyle='#15171c'; cx.fillRect(0,0,W,H);
    function checker(x,y,s){
        for(var j=0;j<s;j+=10) for(var i=0;i<s;i+=10){
            cx.fillStyle = (((i/10)+(j/10))%2===0) ? '#3a3d45' : '#2b2e35';
            cx.fillRect(x+i,y+j,10,10);
        }
    }
    return new Promise(function(res){
        var pending = items.length*2;
        function done(){ if(--pending<=0) res(cv.toDataURL('image/png')); }
        items.forEach(function(it, idx){
            var row = Math.floor(idx/2), col = (idx%2)*2;
            var x0 = pad + col*(cell+pad);
            var y0 = pad + row*(cell+capH+pad);
            [['before', it.before], ['after', it.after]].forEach(function(pair, ci){
                var x = x0 + ci*(cell+pad);
                checker(x, y0, cell);
                var im = new Image();
                im.onload = function(){
                    var sc = Math.min(cell/im.naturalWidth, cell/im.naturalHeight);
                    var dw = im.naturalWidth*sc, dh = im.naturalHeight*sc;
                    cx.drawImage(im, x+(cell-dw)/2, y0+(cell-dh)/2, dw, dh);
                    cx.strokeStyle='#4a4f5c'; cx.strokeRect(x+0.5, y0+0.5, cell-1, cell-1);
                    cx.fillStyle = pair[0]==='before' ? '#8b93a3' : '#4ade80';
                    cx.font='bold 10px sans-serif'; cx.textAlign='left';
                    cx.fillText(pair[0]==='before'?'原图':'抠后', x+5, y0+13);
                    done();
                };
                im.onerror = done;
                im.src = pair[1];
            });
            cx.fillStyle='#c9ccd4'; cx.font='10px sans-serif'; cx.textAlign='left';
            cx.fillText(it.name.slice(0, 22), x0, y0 + cell + 14);
        });
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r79c-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'dark' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r79c' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    console.log('r79-c 真实图标对比：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 30000);

        const icons = pickIcons(12);
        console.log('选中 ' + icons.length + ' 个真实图标');
        fs.mkdirSync(OUTDIR, { recursive: true });
        const items = [];
        for (const ic of icons) {
            const b64 = fs.readFileSync(ic.p).toString('base64');
            const ext = ic.f.endsWith('.png') ? 'png' : 'jpeg';
            const dataUrl = `data:image/${ext};base64,${b64}`;
            const t0 = Date.now();
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl)}, tolerance: 48, keep: null
            }).then(function(r){ return JSON.stringify({s:r.src,n:r.removed,b:r.noBackground}); })
              .catch(function(e){ return 'ERR ' + e; })`);
            if (typeof r !== 'string' || r.startsWith('ERR')) {
                console.log('  ' + ic.f + ' 失败: ' + String(r).slice(0, 80));
                continue;
            }
            const o = JSON.parse(r);
            const ms = Date.now() - t0;
            console.log(`  ${ic.f}  抠掉=${o.n}  无背景=${o.b}  ${ms}ms`);
            items.push({ name: ic.f, before: dataUrl, after: o.s });
        }
        if (!items.length) { console.log('没有成功的图标'); return; }

        const composed = await ev(sw, COMPOSE(items, 150));
        if (typeof composed !== 'string' || !composed.startsWith('data:image/png')) {
            console.log('合成失败: ' + String(composed).slice(0, 120));
            return;
        }
        const outFile = path.join(OUTDIR, 'r79-real-icons.png');
        fs.writeFileSync(outFile, Buffer.from(composed.split(',')[1], 'base64'));
        console.log('对比图已保存: ' + outFile);
        console.log('大小: ' + Math.round(fs.statSync(outFile).size / 1024) + ' KB');
        for (const it of items) {
            const base = 'r79-real-' + it.name.replace(/[^\w.-]/g, '_');
            fs.writeFileSync(path.join(OUTDIR, base + '-after.png'), Buffer.from(it.after.split(',')[1], 'base64'));
        }
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
