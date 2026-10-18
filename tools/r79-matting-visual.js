/* ============================================================================
 *  r79：抠图效果**视觉对比**（生成一张对照图给人看）
 *
 *  探针 `r79-matting-probe.js` 证明的是"算法行为对不对"；
 *  这个脚本证明的是"看起来好不好" —— 用户抱怨的正是"效果不好"。
 *
 *  做法：造 6 种典型图标场景，各自跑一次抠图，把「原图 / 抠图结果」
 *  并排画到一张大图上，输出 PNG。人一眼就能看出：
 *    · 浅色主体有没有被吃
 *    · 边缘是不是平滑（不是锯齿）
 *    · 有没有白边（去色是否生效）
 *
 *  用法：node tools/r79-matting-visual.js
 *  产出：docs/evidence/r79-matting-compare.png（以及每格的单独文件）
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUTDIR = path.join(ROOT, 'docs', 'evidence');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* 6 个场景：都取自"真实会遇到、且旧算法容易翻车"的类型 */
const CASES = [
    { key: 'dark', title: '白底 + 深色圆（基本盘）' },
    { key: 'lowContrast', title: '浅底 + 浅色主体（旧算法会吃掉主体）' },
    { key: 'gradient', title: '渐变底 + 彩色主体' },
    { key: 'donut', title: '环形主体（内部镂空要保留）' },
    { key: 'whiteOnWhite', title: '白底 + 白色主体（最难）' },
    { key: 'photoish', title: '照片感底 + 图标' },
];

const MAKE = (kind, S) => `(function(){
    var S = ${S};
    var cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    var cx = cv.getContext('2d');
    function circle(x,y,r){ cx.beginPath(); cx.arc(x,y,r,0,Math.PI*2); cx.fill(); }
    if ('${kind}' === 'dark') {
        cx.fillStyle='#ffffff'; cx.fillRect(0,0,S,S);
        cx.fillStyle='#2840c8'; circle(S/2,S/2,S*0.30);
    } else if ('${kind}' === 'lowContrast') {
        cx.fillStyle='#f8f8f8'; cx.fillRect(0,0,S,S);
        cx.fillStyle='#e8e8e8'; cx.fillRect(S*0.25,S*0.25,S*0.5,S*0.5);
    } else if ('${kind}' === 'gradient') {
        var g=cx.createLinearGradient(0,0,S,S);
        g.addColorStop(0,'#d8e4f0'); g.addColorStop(1,'#8898b0');
        cx.fillStyle=g; cx.fillRect(0,0,S,S);
        cx.fillStyle='#ff5028'; circle(S/2,S/2,S*0.28);
    } else if ('${kind}' === 'donut') {
        cx.fillStyle='#ffffff'; cx.fillRect(0,0,S,S);
        cx.fillStyle='#e01818'; circle(S/2,S/2,S*0.34);
        cx.fillStyle='#ffffff'; circle(S/2,S/2,S*0.16);
    } else if ('${kind}' === 'whiteOnWhite') {
        cx.fillStyle='#ffffff'; cx.fillRect(0,0,S,S);
        // 白色主体 + 极淡阴影，模拟真实白色 logo
        cx.fillStyle='#f0f0f0'; circle(S/2,S/2,S*0.32);
        cx.fillStyle='#ffffff'; circle(S/2,S/2,S*0.28);
    } else if ('${kind}' === 'photoish') {
        // 用噪声+色块模拟照片底
        for (var i=0;i<900;i++){
            var x=Math.random()*S, y=Math.random()*S, r=2+Math.random()*10;
            cx.fillStyle='rgba('+(120+Math.random()*80|0)+','+(130+Math.random()*70|0)+','+(150+Math.random()*60|0)+',0.7)';
            cx.beginPath(); cx.arc(x,y,r,0,Math.PI*2); cx.fill();
        }
        cx.fillStyle='#101820'; circle(S/2,S/2,S*0.27);
        cx.fillStyle='#ffffff'; cx.font='bold '+(S*0.3)+'px sans-serif';
        cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText('Q', S/2, S/2+S*0.02);
    }
    return cv.toDataURL('image/png');
})()`;

/* 把「原图」和「抠图结果」并排画进一张对照图。
 * 底色用交替灰格 —— 透明区域才看得出来。 */
const COMPOSE = (items, cell) => `(function(){
    var items = ${JSON.stringify(items)};
    var cell = ${cell};
    var cols = 2, rows = items.length;
    var pad = 16, capH = 26;
    var W = cols*cell + pad*3;
    var H = rows*(cell+capH) + pad*(rows+1);
    var cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    var cx = cv.getContext('2d');
    cx.fillStyle = '#1b1d23'; cx.fillRect(0,0,W,H);
    function checker(x,y,s){
        var g=12;
        for(var j=0;j<s;j+=g) for(var i=0;i<s;i+=g){
            cx.fillStyle = (((i/g)+(j/g))%2===0) ? '#3a3d45' : '#2c2f36';
            cx.fillRect(x+i,y+j,g,g);
        }
    }
    return new Promise(function(res){
        var pending = items.length*2;
        var drawn = {};
        function done(){ if(--pending===0){
            // 标题
            cx.fillStyle='#e8e9ee'; cx.font='bold 13px sans-serif';
            cx.textAlign='left';
            cv.toDataURL('image/png');
            res(cv.toDataURL('image/png'));
        } }
        items.forEach(function(it, idx){
            var y = pad + idx*(cell+capH+pad);
            // 两格
            [['before', it.before], ['after', it.after]].forEach(function(pair, ci){
                var x = pad + ci*(cell+pad);
                checker(x, y, cell);
                var im = new Image();
                im.onload = function(){
                    var sc = Math.min(cell/im.naturalWidth, cell/im.naturalHeight);
                    var dw = im.naturalWidth*sc, dh = im.naturalHeight*sc;
                    cx.drawImage(im, x+(cell-dw)/2, y+(cell-dh)/2, dw, dh);
                    cx.strokeStyle='#555a66'; cx.strokeRect(x+0.5,y+0.5,cell-1,cell-1);
                    // 角标
                    cx.fillStyle = pair[0]==='before' ? '#8b93a3' : '#4ade80';
                    cx.font='bold 11px sans-serif'; cx.textAlign='left';
                    cx.fillText(pair[0]==='before'?'原图':'抠图后', x+6, y+14);
                    done();
                };
                im.onerror = done;
                im.src = pair[1];
            });
            // 场景名
            cx.fillStyle='#c9ccd4'; cx.font='12px sans-serif'; cx.textAlign='left';
            cx.fillText(it.title, pad, y + cell + 17);
        });
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r79v-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'dark' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r79v' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    console.log('r79 视觉对比：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 30000);

        fs.mkdirSync(OUTDIR, { recursive: true });
        const items = [];
        for (const c of CASES) {
            const before = await ev(sw, MAKE(c.key, 256));
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(before)}, tolerance: 48, keep: null
            }).then(function(r){ return r.src; }).catch(function(e){ return 'ERR ' + e; })`);
            if (typeof r !== 'string' || r.startsWith('ERR')) {
                console.log('  ' + c.key + ' 失败: ' + r);
                continue;
            }
            items.push({ key: c.key, title: c.title, before, after: r });
            console.log('  ' + c.key + ' OK');
        }
        if (!items.length) { console.log('没有成功的场景'); return; }

        const composed = await ev(sw, COMPOSE(items, 256));
        if (typeof composed !== 'string' || !composed.startsWith('data:image/png')) {
            console.log('合成失败: ' + String(composed).slice(0, 120));
            return;
        }
        const b64 = composed.split(',')[1];
        const outFile = path.join(OUTDIR, 'r79-matting-compare.png');
        fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
        console.log('对照图已保存: ' + outFile);
        console.log('大小: ' + Math.round(fs.statSync(outFile).size / 1024) + ' KB');
        // 每格的单独文件也存一份，方便放大看
        for (const it of items) {
            fs.writeFileSync(path.join(OUTDIR, 'r79-' + it.key + '-before.png'),
                Buffer.from(it.before.split(',')[1], 'base64'));
            fs.writeFileSync(path.join(OUTDIR, 'r79-' + it.key + '-after.png'),
                Buffer.from(it.after.split(',')[1], 'base64'));
        }
        console.log('每格单独文件也已保存（r79-<场景>-before/after.png）');
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
