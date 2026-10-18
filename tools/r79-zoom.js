/* ============================================================================
 *  r79-e：放大看指定图标（用于"指标说有问题"时的人工核实）
 *
 *  为什么要它：`r79-metrics.js` 的"中心保留率"指标对**文字型/线框型** logo
 *  会误判 —— 比如 "gog.com" 这种纯文字 logo，图中心本来就夹着背景，
 *  中心不透明率天然很低，指标会报"主体被删"，其实抠得没问题。
 *
 *  所以指标只能用来**发现问题候选**，最终判断必须用眼睛。
 *  这个脚本把候选图标放大并排画出来（每格 420px，足够看清边缘质量）。
 *
 *  用法：node tools/r79-zoom.js [图标名1] [图标名2] ...
 *        不带参数则用内置的"疑似有问题"清单
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

const WANT = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['Iconify.png', 'GOG.png', 'CNBC（首页）.png', 'Lobsters.png',
       'Apple_Music（首页）.png', '115_网盘.png'];

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

/* 大格并排：左原图 / 中抠后(棋盘格) / 右抠后(纯黑底 —— 专看白边/锯齿) */
const COMPOSE = (items, cell) => `(function(){
    var items = ${JSON.stringify(items)};
    var cell = ${cell};
    var pad = 18, capH = 26;
    var W = 3*cell + pad*4;
    var H = items.length*(cell+capH) + pad*(items.length+1);
    var cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    var cx = cv.getContext('2d');
    cx.fillStyle='#101216'; cx.fillRect(0,0,W,H);
    function checker(x,y,s){
        for(var j=0;j<s;j+=12) for(var i=0;i<s;i+=12){
            cx.fillStyle = (((i/12)+(j/12))%2===0) ? '#3c4049' : '#2b2f37';
            cx.fillRect(x+i,y+j,12,12);
        }
    }
    return new Promise(function(res){
        var pending = items.length*3;
        function done(){ if(--pending<=0) res(cv.toDataURL('image/png')); }
        items.forEach(function(it, idx){
            var y = pad + idx*(cell+capH+pad);
            [['原图','#8b93a3',null], ['抠后(棋盘)','#4ade80','checker'], ['抠后(黑底)','#60a5fa','black']].forEach(function(cfg, ci){
                var x = pad + ci*(cell+pad);
                if (cfg[2]==='checker') checker(x,y,cell);
                if (cfg[2]==='black'){ cx.fillStyle='#000'; cx.fillRect(x,y,cell,cell); }
                var im = new Image();
                im.onload = function(){
                    var sc = Math.min(cell/im.naturalWidth, cell/im.naturalHeight) * 0.92;
                    var dw = im.naturalWidth*sc, dh = im.naturalHeight*sc;
                    cx.drawImage(im, x+(cell-dw)/2, y+(cell-dh)/2, dw, dh);
                    cx.strokeStyle='#4a4f5c'; cx.strokeRect(x+0.5,y+0.5,cell-1,cell-1);
                    cx.fillStyle = cfg[1]; cx.font='bold 12px sans-serif'; cx.textAlign='left';
                    cx.fillText(cfg[0], x+8, y+17);
                    done();
                };
                im.onerror = done;
                im.src = (ci===0 ? it.before : it.after);
            });
            cx.fillStyle='#e2e4ea'; cx.font='bold 13px sans-serif'; cx.textAlign='left';
            cx.fillText(it.name, pad, y + cell + 19);
        });
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r79e-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'dark' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r79e' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    console.log('r79-e 放大核实：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 30000);
        const items = [];
        for (const name of WANT) {
            const p = path.join(ICONDIR, name);
            if (!fs.existsSync(p)) { console.log('  ' + name + ' 不存在，跳过'); continue; }
            const b64 = fs.readFileSync(p).toString('base64');
            const ext = name.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
            const dataUrl = `data:image/${ext};base64,${b64}`;
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl)}, tolerance: 48, keep: null
            }).then(function(r){ return r.src; }).catch(function(e){ return 'ERR ' + e; })`);
            if (typeof r !== 'string' || r.startsWith('ERR')) { console.log('  ' + name + ' 失败'); continue; }
            items.push({ name, before: dataUrl, after: r });
            console.log('  ' + name + ' OK');
        }
        if (!items.length) return;
        const composed = await ev(sw, COMPOSE(items, 300));
        if (typeof composed !== 'string' || !composed.startsWith('data:image/png')) {
            console.log('合成失败'); return;
        }
        fs.mkdirSync(OUTDIR, { recursive: true });
        const outFile = path.join(OUTDIR, 'r79-zoom.png');
        fs.writeFileSync(outFile, Buffer.from(composed.split(',')[1], 'base64'));
        console.log('放大对比已保存: ' + outFile);
        console.log('大小: ' + Math.round(fs.statSync(outFile).size / 1024) + ' KB');
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(500);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
