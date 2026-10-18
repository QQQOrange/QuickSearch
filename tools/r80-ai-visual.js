/* ============================================================================
 *  r80：AI 抠图 vs 本地算法 —— **视觉对比**（最终判据）
 *
 *  为什么要这个脚本：前面的探针（`r80-ai-probe.js`）证明的是"流程通不通"，
 *  但"效果好不好"只能靠眼睛。这个脚本把同一张真实图标跑两遍：
 *     · 关着开关（本地颜色解混）
 *     · 开着开关（AI 神经网络）
 *  三列并排：原图 / 本地算法 / AI —— 一眼看出 AI 到底帮上忙没有。
 *
 *  底色用棋盘格（看透明）+ 黑底（看白边），两张图都出。
 *
 *  前置：目标机器的数据目录里要有已下载的模型（脚本会从
 *        `_matting-ref/rmbg/` 拷一份 u2netp 进去当"用户已下载"）。
 *
 *  用法：node tools/r80-ai-visual.js
 *  产出：docs/evidence/r80-ai-vs-local.png（棋盘底）
 *        docs/evidence/r80-ai-vs-local-dark.png（黑底，专看白边）
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const ICONDIR = path.join(ROOT, 'ui', 'data', 'icons');
const OUTDIR = path.join(ROOT, 'docs', 'evidence');
const MODELS_SRC = 'D:\\Local AI\\git\\_matting-ref\\rmbg';
/* 要测哪个模型（命令行第一个参数，默认 u2netp）。
 * 为什么要能换：不同模型在图标上表现差异很大（实测 u2netp 与 RMBG 各有胜负），
 * 必须逐个跑对比图，不能只测一个就下结论。 */
const WHICH = process.argv[2] || 'u2netp';
const SRC_FILE = {
    'u2netp': 'u2netp.onnx',
    'rmbg-quantized': 'model_quantized.onnx',
    'rmbg-fp16': 'model_fp16.onnx',
    'rmbg-full': 'model.onnx',
}[WHICH];
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 挑真实图标：优先挑"本地算法会翻车"的那些（浅色主体、复杂内部、渐变底） */
const NAMES = [
    'Excalidraw（首页）.png',
    '139_邮箱（首页）.png',
    'IGN.png',
    'Iconify.png',
    'GOG.png',
    '126_邮箱（首页）.png',
    'Apple_Music（首页）.png',
    'Codeberg.png',
    'Lobsters.png',
    'CNBC（首页）.png',
];

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 180000);
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
    while (Date.now() - t0 < (ms || 60000)) {
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
    while (Date.now() - t0 < (ms || 30000)) { if (await ev(ws, expr) === true) return true; await sleep(250); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

/* 三列并排：原图 / 本地 / AI。bg = 'checker' | 'black' */
const COMPOSE = (items, bg) => `(function(){
    var items = ${JSON.stringify(items)};
    var bgmode = ${JSON.stringify(bg)};
    var cell = 220, pad = 12, cap = 20;
    var cols = 3;
    var W = cols*cell + pad*(cols+1);
    var H = items.length*(cell+cap) + pad*(items.length+1);
    var cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    var cx = cv.getContext('2d');
    cx.fillStyle='#101216'; cx.fillRect(0,0,W,H);
    function fill(x,y,s){
        if (bgmode === 'black'){ cx.fillStyle='#000'; cx.fillRect(x,y,s,s); return; }
        for(var j=0;j<s;j+=11) for(var i=0;i<s;i+=11){
            cx.fillStyle = (((i/11)+(j/11))%2===0) ? '#3c4049' : '#2b2f37';
            cx.fillRect(x+i,y+j,11,11);
        }
    }
    return new Promise(function(res){
        var pending = items.length*3;
        function done(){ if(--pending<=0) res(cv.toDataURL('image/png')); }
        items.forEach(function(it, idx){
            var y0 = pad + idx*(cell+cap+pad);
            [['原图','#8b93a3',it.before],['本地算法','#fbbf24',it.local],['AI','#4ade80',it.ai]].forEach(function(cfg, ci){
                var x0 = pad + ci*(cell+pad);
                fill(x0,y0,cell);
                var im = new Image();
                im.onload = function(){
                    var sc = Math.min(cell/im.naturalWidth, cell/im.naturalHeight)*0.92;
                    var dw = im.naturalWidth*sc, dh = im.naturalHeight*sc;
                    cx.drawImage(im, x0+(cell-dw)/2, y0+(cell-dh)/2, dw, dh);
                    cx.strokeStyle='#4a4f5c'; cx.strokeRect(x0+0.5,y0+0.5,cell-1,cell-1);
                    cx.fillStyle=cfg[1]; cx.font='bold 11px sans-serif'; cx.textAlign='left';
                    cx.fillText(cfg[0], x0+6, y0+15);
                    done();
                };
                im.onerror=done;
                im.src = cfg[2];
            });
            cx.fillStyle='#e2e4ea'; cx.font='12px sans-serif'; cx.textAlign='left';
            cx.fillText(it.name.slice(0,40), pad, y0+cell+15);
        });
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80v-'));
    const qs = path.join(tmp, 'QuickSearch');
    const modelsDir = path.join(qs, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    // 预置已下载的模型（模拟用户下好了 u2netp）
    let preloaded = false;
    try {
        fs.copyFileSync(path.join(MODELS_SRC, SRC_FILE), path.join(modelsDir, WHICH + '.onnx'));
        preloaded = true;
    } catch (e) { }
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, theme: 'dark' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80v' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    console.log('r80 视觉对比：pid=' + proc.pid + '  模型=' + (preloaded ? WHICH : '无'));
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上设置页'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);
        /* ⚠ 必须先**选中**要测的模型：默认选中的是 u2netp，
         * 测 RMBG 系列时不切过去的话，AI 会去执行 u2netp（或者因为
         * 选中的模型没下载而静默回退本地，表现为"AI 与本地不同: false"、耗时极短）。
         * 这个坑实测踩过：跑了 5~13ms 就返回，一看就是根本没走 AI。 */
        const selRes = await ev(sw, `window.__TAURI__.core.invoke('ai_matting_select',{id:'` + WHICH + `'}).then(r=>JSON.stringify(r)).catch(e=>'ERR '+e)`);
        const sel = typeof selRes === 'string' && !selRes.startsWith('ERR') ? JSON.parse(selRes) : {};
        console.log('  选定 ' + WHICH + ' → current=' + sel.current + ' currentReady=' + sel.currentReady + ' usable=' + sel.usable);
        if (!sel.currentReady) {
            console.log('  ✗ 模型没就绪，AI 会回退本地 —— 下面的 AI 列等于本地列，没有参考价值');
        }

        const items = [];
        for (const nm of NAMES) {
            const p = path.join(ICONDIR, nm);
            if (!fs.existsSync(p)) { console.log('  跳过（无此图标）: ' + nm); continue; }
            const dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
            const run = (extra) => ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl)}, tolerance: 48, keep: null
            }).then(r=>r.src).catch(e=>'ERR '+e)`);

            // 先关开关跑本地
            await ev(sw, "window.__TAURI__.core.invoke('ai_matting_enable',{on:false})");
            await sleep(120);
            const local = await run();
            // 再开开关跑 AI
            await ev(sw, "window.__TAURI__.core.invoke('ai_matting_enable',{on:true})");
            await sleep(120);
            const t0 = Date.now();
            const ai = await run();
            const ms = Date.now() - t0;
            if (typeof local !== 'string' || local.startsWith('ERR')) { console.log('  ' + nm + ' 本地失败'); continue; }
            if (typeof ai !== 'string' || ai.startsWith('ERR')) { console.log('  ' + nm + ' AI 失败: ' + String(ai).slice(0, 60)); continue; }
            // 判断 AI 是否真的生效（与本地不同）——不同才说明走了 AI
            const changed = ai !== local;
            console.log(`  ${nm}  AI ${ms}ms  与本地不同: ${changed}`);
            items.push({ name: nm, before: dataUrl, local, ai });
        }
        if (!items.length) { console.log('没有成功的对比项'); return; }
        fs.mkdirSync(OUTDIR, { recursive: true });
        for (const [bg, file] of [['checker', 'r80-ai-' + WHICH + '.png'], ['black', 'r80-ai-' + WHICH + '-dark.png']]) {
            const composed = await ev(sw, COMPOSE(items, bg));
            if (typeof composed === 'string' && composed.startsWith('data:image/png')) {
                const f = path.join(OUTDIR, file);
                fs.writeFileSync(f, Buffer.from(composed.split(',')[1], 'base64'));
                console.log('对比图: ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
            }
        }
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
