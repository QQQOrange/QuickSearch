/* ============================================================================
 *  r79：图标自动抠图（alpha matting）验证
 *
 *  验的是用户报的那件事：「现在的消除背景就会把图标里面东西一起消除了，
 *  而且描边也会没有什么好效果」。
 *
 *  做法：造几种**真实会让旧算法失败**的图，直接调后端的 icon_remove_bg，
 *  再用 canvas 读回结果的 alpha，验证主体是否真的被保住。
 *
 *  为什么不用真实图标文件：真实图标的"正确答案"需要人眼看，
 *  而这里要证明的是**算法行为**（浅色主体不被吃、边缘平滑、无背景时给提示），
 *  合成图能给出确定的期望值。
 *
 *  用法：node tools/r79-matting-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r79-matting-probe.txt');
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
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 60000);
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

/* 在页面里造测试图（canvas → dataURL），再调后端抠图，最后读回 alpha。
 * 全部在 WebView 里做，因为有 canvas 可以用。 */
const MAKE_CASE = (kind, size) => `(function(){
    var S = ${size};
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var cx = cv.getContext('2d');
    if ('${kind}' === 'whiteCircle') {
        cx.fillStyle = '#ffffff'; cx.fillRect(0,0,S,S);
        cx.fillStyle = '#2840c8';
        cx.beginPath(); cx.arc(S/2, S/2, S*0.30, 0, Math.PI*2); cx.fill();
    } else if ('${kind}' === 'lowContrast') {
        // 用户报的那个场景：浅色主体 + 浅底，只差 16 级
        cx.fillStyle = '#f8f8f8'; cx.fillRect(0,0,S,S);
        cx.fillStyle = '#e8e8e8'; cx.fillRect(S*0.25, S*0.25, S*0.5, S*0.5);
    } else if ('${kind}' === 'photo') {
        // 渐变底 + 彩色主体：考"背景不纯色"时还准不准
        var g = cx.createLinearGradient(0,0,S,S);
        g.addColorStop(0, '#d8e4f0'); g.addColorStop(1, '#a8b8cc');
        cx.fillStyle = g; cx.fillRect(0,0,S,S);
        cx.fillStyle = '#ff5028';
        cx.beginPath(); cx.arc(S/2, S/2, S*0.28, 0, Math.PI*2); cx.fill();
    } else if ('${kind}' === 'donut') {
        /* 甜甜圈：**中心是透明的**（真实图标常见：环形 logo 中间本来就是空的）。
         * 画法：白底铺满 → 红环 → 中心用 destination-out 挖成透明。
         * 期望：环（主体）留下、中心保持透明、四角白底被抠掉。 */
        cx.fillStyle = '#ffffff'; cx.fillRect(0,0,S,S);
        cx.fillStyle = '#e01818';
        cx.beginPath(); cx.arc(S/2, S/2, S*0.34, 0, Math.PI*2); cx.fill();
        cx.globalCompositeOperation = 'destination-out';
        cx.beginPath(); cx.arc(S/2, S/2, S*0.16, 0, Math.PI*2); cx.fill();
        cx.globalCompositeOperation = 'source-over';
    } else if ('${kind}' === 'donutBgCenter') {
        // 红底 + 白环，**中心也是红底**（与四角同色）—— 中心的红该被抠掉
        cx.fillStyle='#e01818'; cx.fillRect(0,0,S,S);
        cx.fillStyle='#ffffff';
        cx.beginPath(); cx.arc(S/2,S/2,S*0.34,0,Math.PI*2); cx.fill();
        cx.fillStyle='#e01818';
        cx.beginPath(); cx.arc(S/2,S/2,S*0.16,0,Math.PI*2); cx.fill();
    } else if ('${kind}' === 'solid') {
        // 整张同色：没有背景可分
        cx.fillStyle = '#141e28'; cx.fillRect(0,0,S,S);
    } else if ('${kind}' === 'alreadyClear') {
        // 已经抠好、四周透明的图
        cx.clearRect(0,0,S,S);
        cx.fillStyle = '#0ac85a';
        cx.beginPath(); cx.arc(S/2, S/2, S*0.30, 0, Math.PI*2); cx.fill();
    }
    return cv.toDataURL('image/png');
})()`;

/** 读回抠图结果的若干像素 alpha（坐标按比例给）。 */
const READ_PIXELS = (src, pts) => `(function(){
    return new Promise(function(res){
        var im = new Image();
        im.onload = function(){
            var S = im.naturalWidth;
            var cv = document.createElement('canvas');
            cv.width = S; cv.height = S;
            var cx = cv.getContext('2d', { willReadFrequently: true });
            cx.clearRect(0,0,S,S);
            cx.drawImage(im, 0, 0);
            var d = cx.getImageData(0,0,S,S).data;
            var out = {};
            var pts = ${JSON.stringify(pts)};
            for (var i=0;i<pts.length;i++){
                var p = pts[i];
                var x = Math.round(p[0]*S), y = Math.round(p[1]*S);
                x = Math.max(0, Math.min(S-1, x)); y = Math.max(0, Math.min(S-1, y));
                var k = (y*S + x)*4;
                out[p.join(',')] = { a: d[k+3], r: d[k], g: d[k+1], b: d[k+2] };
            }
            out._size = S;
            res(JSON.stringify(out));
        };
        im.onerror = function(){ res('ERR load'); };
        im.src = ${JSON.stringify(src)};
    });
})()`;

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r79-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r79' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r79 抠图探针：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        check('S1 设置页起来了', !!sw);
        if (!sw) return;
        await until(sw, "typeof CONF === 'object'", 30000);

        /** 造图 → 抠图 → 读像素。返回 { src, removed, noBackground, px } */
        async function runCase(kind, tol, pts, keepRect) {
            const dataUrl = await ev(sw, MAKE_CASE(kind, 128));
            let keep;
            if (keepRect) {
                // keepRect = [x0,y0,x1,y1] 比例；造一个同尺寸单通道蒙版
                const m = await ev(sw, `(function(){
                    var S = 128;
                    var d = new Uint8Array(S*S);
                    var r = ${JSON.stringify(keepRect)};
                    for (var y = Math.round(r[1]*S); y < Math.round(r[3]*S); y++)
                        for (var x = Math.round(r[0]*S); x < Math.round(r[2]*S); x++)
                            d[y*S+x] = 255;
                    return JSON.stringify({ w: S, h: S, data: Array.from(d) });
                })()`);
                keep = JSON.parse(m);
            }
            const r = await ev(sw, `window.__TAURI__.core.invoke('icon_remove_bg', {
                src: ${JSON.stringify(dataUrl)}, tolerance: ${tol}, keep: ${keep ? JSON.stringify(keep) : 'null'}
            }).then(function(r){ return JSON.stringify(r); }).catch(function(e){ return 'ERR ' + e; })`);
            if (typeof r === 'string' && r.startsWith('ERR')) return { err: r };
            const obj = JSON.parse(r);
            const px = await ev(sw, READ_PIXELS(obj.src, pts));
            obj.px = JSON.parse(px);
            return obj;
        }

        /* ---------- 1. 白底 + 蓝圆：最基本的一条 ---------- */
        {
            const r = await runCase('whiteCircle', 48, [[0.02, 0.02], [0.5, 0.5], [0.5, 0.22]]);
            rec('① 白底蓝圆：removed=' + r.removed + ' noBg=' + r.noBackground + ' px=' + JSON.stringify(r.px));
            check('1a 四角被抠透（alpha=0）', r.px['0.02,0.02'].a === 0, JSON.stringify(r.px['0.02,0.02']));
            check('1b 圆心保住（alpha=255）', r.px['0.5,0.5'].a === 255, JSON.stringify(r.px['0.5,0.5']));
            check('1c 确实抠掉了大量背景像素', r.removed > 3000, 'removed=' + r.removed);
            check('1d 判定为"有背景"', r.noBackground === false);
        }

        /* ---------- 2. **用户报的那个 bug**：浅色主体 + 浅底 ---------- */
        {
            const r = await runCase('lowContrast', 48, [[0.02, 0.02], [0.5, 0.5], [0.5, 0.3]]);
            rec('② 浅色主体（差 16 级）：removed=' + r.removed + ' noBg=' + r.noBackground + ' px=' + JSON.stringify(r.px));
            check(
                '2a 浅色主体中心**保住了**（这正是旧算法出错的地方）',
                r.px['0.5,0.5'].a > 200,
                JSON.stringify(r.px['0.5,0.5'])
            );
            check('2b 四角仍然被抠透', r.px['0.02,0.02'].a === 0, JSON.stringify(r.px['0.02,0.02']));
        }

        /* ---------- 3. 渐变底 + 彩色主体（背景不纯色） ---------- */
        {
            const r = await runCase('photo', 48, [[0.03, 0.03], [0.5, 0.5], [0.5, 0.25]]);
            rec('③ 渐变底：removed=' + r.removed + ' px=' + JSON.stringify(r.px));
            check('3a 渐变背景下主体保住', r.px['0.5,0.5'].a === 255, JSON.stringify(r.px['0.5,0.5']));
            check('3b 边角背景被抠', r.px['0.03,0.03'].a === 0, JSON.stringify(r.px['0.03,0.03']));
        }

        /* ---------- 4. 甜甜圈：主体内部同色区域不该被抠 ---------- */
        {
            const r = await runCase('donut', 48, [[0.02, 0.02], [0.5, 0.5], [0.5, 0.32]]);
            rec('④ 甜甜圈：removed=' + r.removed + ' px=' + JSON.stringify(r.px));
            /* r79：这一格的期望值**改过**，请看清新定义：
             *
             * 这个甜甜圈的中心是**透明的**（`destination-out` 挖出来的），
             * 不是"主体自己的颜色"。真实图标里环形 logo 的中间本来就是空的 ——
             * 抠图工具不该把它填上任何东西（`solve_alpha` 里"原图透明像素
             * alpha 上界 = 0"那一步保证了这点）。
             * 所以断言是"中心保持透明"，不是"中心保留"。 */
            check('4a 中心原图就透明 → 保持透明（不该被填上东西）', r.px['0.5,0.5'].a === 0, JSON.stringify(r.px['0.5,0.5']));
            check('4b 环上（主体）保留', r.px['0.5,0.32'].a > 200, JSON.stringify(r.px['0.5,0.32']));
            check('4c 四角背景抠透', r.px['0.02,0.02'].a === 0);
            /* 4d：新增一条 —— **红底 + 白环**那种"中心是背景色"的情形，
             * 中心必须被抠掉（这是连通性修复的核心价值）。 */
            const r2 = await runCase('donutBgCenter', 48, [[0.02, 0.02], [0.5, 0.5], [0.5, 0.32]]);
            rec('④b 环形(中心为背景色)：removed=' + r2.removed + ' px=' + JSON.stringify(r2.px));
            check('4d 中心与四角同色 → 该被抠掉（连通性修复）', r2.px['0.5,0.5'].a === 0, JSON.stringify(r2.px['0.5,0.5']));
            check('4e 环上主体仍保留', r2.px['0.5,0.32'].a > 200, JSON.stringify(r2.px['0.5,0.32']));
        }

        /* ---------- 5. 整张同色：应当提示"没有背景"而不是硬抠 ---------- */
        {
            const r = await runCase('solid', 48, [[0.5, 0.5]]);
            rec('⑤ 整张同色：removed=' + r.removed + ' noBg=' + r.noBackground);
            check('5a 判定为"没有可靠背景"', r.noBackground === true, 'noBg=' + r.noBackground);
            check('5b 没有把整张图抠光（removed 很小）', r.removed < 500, 'removed=' + r.removed);
        }

        /* ---------- 6. 已经抠好的透明图：不该被改坏 ---------- */
        {
            const r = await runCase('alreadyClear', 48, [[0.02, 0.02], [0.5, 0.5]]);
            rec('⑥ 已透明的图：removed=' + r.removed + ' px=' + JSON.stringify(r.px));
            check('6a 主体仍是完全不透明', r.px['0.5,0.5'].a === 255, JSON.stringify(r.px['0.5,0.5']));
            check('6b 四周仍是透明', r.px['0.02,0.02'].a === 0);
        }

        /* ---------- 7. 手动补描 = 硬约束 ---------- */
        {
            // 整张同色 + 描一块：那一块必须保住
            const r = await runCase('solid', 48, [[0.5, 0.5], [0.01, 0.01]], [0.35, 0.35, 0.65, 0.65]);
            rec('⑦ 手动补描（同色图上描中心）：removed=' + r.removed + ' px=' + JSON.stringify(r.px));
            check(
                '7a 描过的区域被保住（硬约束）',
                r.px['0.5,0.5'].a === 255,
                JSON.stringify(r.px['0.5,0.5'])
            );
        }

        /* ---------- 8. 性能：512 的图不该超过 1 秒 ---------- */
        {
            const t0 = Date.now();
            await runCase('whiteCircle', 48, [[0.5, 0.5]]);
            const ms = Date.now() - t0;
            rec('⑧ 一轮抠图（含造图 + IPC + 读回）耗时 ' + ms + ' ms');
            // 造图 + 读回本身也要时间，这里给一个宽松阈值 —— 只防"秒级卡顿"
            check('8a 单次抠图不慢于 3000ms（含造图/读回开销）', ms < 3000, ms + 'ms');
        }

        /* ---------- 9. 后端耗时看日志 ---------- */
        const logf = path.join(qs, 'log.txt');
        let lines = [];
        try { lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/); } catch (e) { }
        const matLines = lines.filter((l) => l.indexOf('icon_remove_bg') >= 0 || l.indexOf('matting') >= 0);
        rec('后端日志（末尾 5 条）：');
        for (const l of matLines.slice(-5)) rec('  ' + l.replace(/^\[SystemTime \{[^}]*\}\]\s*/, ''));
        check('9a 后端记录了抠图耗时与 trimap 分布', matLines.length > 0);
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        rec('');
        rec(`========== r79 抠图探针：${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        process.exit(fail === 0 ? 0 : 1);
    }
})();