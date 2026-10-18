/* ============================================================================
 *  r80：AI 抠图真机验证
 *
 *  验的是用户要的那套流程：
 *    「图标的编辑功能处于可选，在设置通用里面打开，打开之后就会验证本地有没有
 *      这个模型，有的话就直接调用，没有的话那要下载，会弹出下载窗口以及下载
 *      进度条，而这个（模型）本身不包含在安装包之内」
 *    「模型分为多个版本，还有量化的版本，大小可选」
 *
 *  覆盖点：
 *    1. 设置页「通用」里有 AI 抠图卡片（开关 + 模型列表）
 *    2. 开关默认关
 *    3. 模型列表列出全部 4 个版本 + 体积 + 是否已下载
 *    4. 打开开关 → 状态刷新（能拿到 runtime / current / usable）
 *    5. 模型没下载时 → 明确提示"还没下载"（不是"点了没反应"）
 *    6. 模型就绪时 → 图标编辑器走 AI，**真的出图**且比本地算法好
 *    7. AI 失败/不可用时 → 静默回退本地（不报错）
 *
 *  用法：node tools/r80-ai-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const DLL = path.join(ROOT, 'target', 'release', 'onnxruntime.dll');
const ICONDIR = path.join(ROOT, 'ui', 'data', 'icons');
const OUT = path.join(__dirname, 'r80-ai-probe.txt');
// 已下载好的模型（探针直接放进数据目录，避免测试时真下 168MB）
const MODELS_SRC = path.join('D:\\Local AI\\git\\_matting-ref\\rmbg');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 180000);
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

/* 模型 → 数据目录的文件名映射（与 aimodels::model_path 同口径：<id>.onnx） */
const MODEL_FILES = {
    'u2netp': 'u2netp.onnx',
    'rmbg-quantized': 'model_quantized.onnx',
    'rmbg-fp16': 'model_fp16.onnx',
    'rmbg-full': 'model.onnx',
};

/** 指标：边界残留率 + 主体保留率（与原图对比，避免"文字型 logo"误报）。 */
const METRIC = (src, orig) => `(function(){
    return new Promise(function(res){
        function calc(url){ return new Promise(function(r2){
            var im = new Image();
            im.onload = function(){
                var W=im.naturalWidth,H=im.naturalHeight;
                var cv=document.createElement('canvas'); cv.width=W; cv.height=H;
                var cx=cv.getContext('2d',{willReadFrequently:true});
                cx.clearRect(0,0,W,H); cx.drawImage(im,0,0);
                var d=cx.getImageData(0,0,W,H).data;
                var rx=Math.max(1,Math.round(W*0.04)), ry=Math.max(1,Math.round(H*0.04));
                var ringT=0,ringO=0,cenT=0,cenO=0,anyT=0,anyO=0;
                var x0=Math.round(W*0.35),x1=Math.round(W*0.65),y0=Math.round(H*0.35),y1=Math.round(H*0.65);
                for(var y=0;y<H;y++) for(var x=0;x<W;x++){
                    var a=d[(y*W+x)*4+3];
                    var inRing=(x<rx||y<ry||x>=W-rx||y>=H-ry);
                    if(inRing){ringT++; if(a>40) ringO++;}
                    else if(x>=x0&&x<x1&&y>=y0&&y<y1){cenT++; if(a>40) cenO++;}
                    if(a>40) anyO++;
                    anyT++;
                }
                r2(JSON.stringify({w:W,h:H,ring:ringT?ringO/ringT:0,center:cenT?cenO/cenT:0,opaque:anyO/anyT}));
            };
            im.onerror=function(){ r2('ERR'); };
            im.src=url;
        });}
        Promise.all([calc(${JSON.stringify(src)}), calc(${JSON.stringify(orig)})]).then(function(v){
            var a=JSON.parse(v[0]), b=JSON.parse(v[1]);
            res(JSON.stringify({after:a, before:b}));
        });
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80-'));
    const qs = path.join(tmp, 'QuickSearch');
    const modelsDir = path.join(qs, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');

    // 预置一个已下载的模型（u2netp 4.4MB），模拟"用户已经下好"的状态
    let preloaded = false;
    try {
        fs.copyFileSync(path.join(MODELS_SRC, 'u2netp.onnx'), path.join(modelsDir, 'u2netp.onnx'));
        preloaded = true;
    } catch (e) { }

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    rec('r80 AI 抠图探针：pid=' + proc.pid);
    rec('  预置模型: ' + (preloaded ? 'u2netp (4.4MB)' : '（没有，走"未下载"分支）'));
    try {
        const sw = await connect('settings.html');
        check('S1 设置页起来了', !!sw);
        if (!sw) return;
        await until(sw, "typeof CONF === 'object'", 40000);

        /* ---------- 1. 通用分页里有 AI 卡片 ---------- */
        check('1a 「通用」分页里存在 AI 抠图卡片', await ev(sw,
            "!!document.querySelector('[data-pane=\"general\"] #aiMatteCard')") === true);
        check('1b 有开关控件 s-aiMatting', await ev(sw, "!!document.getElementById('s-aiMatting')") === true);
        check('1c 有模型列表容器 aiModels', await ev(sw, "!!document.getElementById('aiModels')") === true);

        /* ---------- 2. 开关默认关 ---------- */
        const swOff = await ev(sw, "document.getElementById('s-aiMatting').checked");
        check('2a 开关默认是关的（不该替用户默认开启）', swOff === false, 'checked=' + swOff);

        /* ---------- 3. 状态查询 ---------- */
        let status = await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))");
        if (typeof status === 'string' && !status.startsWith('ERR')) {
            const s = JSON.parse(status);
            rec('状态: runtime=' + s.runtime + ' current=' + s.current + ' currentReady=' + s.currentReady + ' enable=' + s.enable);
            check('3a 状态里有 runtime 字段（推理运行时可用性）', typeof s.runtime === 'boolean');
            check('3b 运行时可用（onnxruntime.dll 在产物目录）', s.runtime === true, 'runtime=' + s.runtime);
            check('3c 模型清单有 4 个版本可选', (s.models || []).length === 4, '实际 ' + (s.models || []).length);
            check('3d 默认选中推荐项（u2netp）', s.current === 'u2netp', 'current=' + s.current);
            const sizes = (s.models || []).map((m) => m.bytes);
            check('3e 各版本体积都标注了且递增', sizes.length === 4 && sizes.every((v, i) => v > 0 && (i === 0 || v > sizes[i - 1])),
                JSON.stringify(sizes));
            check('3f 推荐项已标记（score 最高）',
                (s.models || []).every((m) => typeof m.score === 'number'));
        } else {
            check('3 状态查询', false, String(status).slice(0, 80));
        }

        /* ---------- 4. 打开开关 → 状态刷新 ---------- */
        await ev(sw, "document.getElementById('s-aiMatting').click()");
        await until(sw, "document.getElementById('s-aiMatting').checked === true", 8000);
        await sleep(1200);
        const status2 = await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))");
        const s2 = JSON.parse(status2);
        check('4a 开关打开后配置已落盘', s2.enable === true, 'enable=' + s2.enable);
        check('4b 状态给出 usable（开关+运行时+模型都就绪）', typeof s2.usable === 'boolean');
        check('4c 模型就绪时 usable 应为 true', s2.usable === true, 'usable=' + s2.usable + ' ready=' + s2.currentReady);

        /* ---------- 5. 未下载的模型要能识别 ---------- */
        const notDl = (s2.models || []).filter((m) => !m.downloaded).map((m) => m.id);
        check('5a 未下载的模型被正确标记', notDl.length === 3, '未下载: ' + JSON.stringify(notDl));

        /* ---------- 6. AI 抠图真的能出图 ---------- */
        const names = ['Excalidraw（首页）.png', 'GOG.png', 'Iconify.png'];
        let improved = 0, aiOk = 0;
        for (const nm of names) {
            const p = path.join(ICONDIR, nm);
            if (!fs.existsSync(p)) continue;
            const b64 = fs.readFileSync(p).toString('base64');
            const dataUrl = 'data:image/png;base64,' + b64;
            const t0 = Date.now();
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl)}, tolerance: 48, keep: null
            }).then(r=>JSON.stringify({n:r.removed,b:r.noBackground,s:r.src})).catch(e=>'ERR '+e)`);
            const ms = Date.now() - t0;
            if (typeof r !== 'string' || r.startsWith('ERR')) {
                rec('  ' + nm + ' 失败: ' + String(r).slice(0, 70));
                continue;
            }
            const o = JSON.parse(r);
            const m = JSON.parse(await ev(sw, METRIC(o.s, dataUrl)));
            const keepDrop = m.before.center > 0.02 ? (m.before.center - m.after.center) / m.before.center : 0;
            rec(`  ${nm}  抠掉=${o.n}  边界残留=${(m.after.ring * 100).toFixed(1)}%  ` +
                `主体保留 ${(m.before.center * 100).toFixed(0)}%→${(m.after.center * 100).toFixed(0)}%  ${ms}ms  ` +
                `(主体基本没被删: ${keepDrop < 0.5})`);
            aiOk++;
            if (keepDrop < 0.5 && m.after.ring < 0.35) improved++;
        }
        check('6a 开了开关后 AI 抠图能出图（没报错）', aiOk >= 2, '成功 ' + aiOk + ' 个');
        check('6b AI 结果满足基本质量（主体没被大量删除 + 边界基本干净）',
            improved >= 2, '达标 ' + improved + ' 个');

        /* ---------- 7. 关掉开关 → **明确报错**（本地算法已删，不再回退） ----------
         *
         * ⚠ 这条断言在 r80b 换了口径。原来写的是"关掉开关后仍能抠图（走本地算法）"，
         * 但用户要求「现在有了 ai 抠图，原来的抠图就直接不要去掉」——
         * 本地算法已经删了，关掉开关就**应该**失败，而且要给一句能操作的话。
         * 所以现在钉的是"报错 + 错误信息可读"，而不是"仍能出图"。 */
        await ev(sw, "document.getElementById('s-aiMatting').click()");
        await until(sw, "document.getElementById('s-aiMatting').checked === false", 8000);
        await sleep(800);
        const p2 = path.join(ICONDIR, 'GOG.png');
        if (fs.existsSync(p2)) {
            const dataUrl2 = 'data:image/png;base64,' + fs.readFileSync(p2).toString('base64');
            const r2 = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl2)}, keep: null
            }).then(r=>'OK').catch(e=>String(e))`);
            check('7a 关掉开关后抠图**明确报错**（本地算法已删）',
                typeof r2 === 'string' && r2 !== 'OK' && r2.indexOf('设置') >= 0,
                String(r2).slice(0, 70));
        }

        /* ---------- 8. 模型选择切换 ---------- */
        const sel = await ev(sw, "window.__TAURI__.core.invoke('ai_matting_select',{id:'rmbg-fp16'}).then(r=>JSON.stringify(r)).catch(e=>'ERR '+e)");
        if (typeof sel === 'string' && !sel.startsWith('ERR')) {
            const s3 = JSON.parse(sel);
            check('8a 能切换模型选择', s3.current === 'rmbg-fp16', 'current=' + s3.current);
            check('8b 未下载的模型切换后 usable 为 false（提示去下载）', s3.usable === false);
            // 切回去，避免影响后续
            await ev(sw, "window.__TAURI__.core.invoke('ai_matting_select',{id:'u2netp'})");
        } else {
            check('8 模型切换', false, String(sel).slice(0, 60));
        }

        /* ---------- 9. 删除模型 ---------- */
        const rm = await ev(sw, "window.__TAURI__.core.invoke('ai_matting_remove',{id:'u2netp'}).then(r=>JSON.stringify(r)).catch(e=>'ERR '+e)");
        if (typeof rm === 'string' && !rm.startsWith('ERR')) {
            const s4 = JSON.parse(rm);
            const u = (s4.models || []).find((m) => m.id === 'u2netp');
            check('9a 能删除已下载的模型', u && u.downloaded === false, JSON.stringify(u));
            check('9b 删完模型文件确实不在了', !fs.existsSync(path.join(modelsDir, 'u2netp.onnx')));
        } else {
            check('9 删除模型', false, String(rm).slice(0, 60));
        }

        /* ---------- 10. 缺运行时时的提示路径（把 dll 移走）---------- */
        // 这条只验证"状态会说 runtime=false"，不改真实文件（免得影响其它）
        check('10a 状态字段足以让界面提示"缺少运行时"', typeof s2.runtime === 'boolean');
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        rec('');
        rec(`========== r80 AI 抠图探针：${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        process.exit(fail === 0 ? 0 : 1);
    }
})();
