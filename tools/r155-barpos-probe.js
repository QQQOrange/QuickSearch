/* r155 探针：验证「弹出位置（文字上方/文字下方）」真的生效。
 *
 * 为什么要有这个探针（v1.5.5）：
 *   v1.5.4 只做了 `pick_bar_side` + 单测，看着全绿，用户实测却是
 *   「不管调上方还是下方，出来的都在文字下方」。根因不在 pick_bar_side，
 *   而在**它前面那道门**：`caret_box()` 靠 GetGUIThreadInfo，浏览器 /
 *   Electron 里永远拿不到光标 → caret=None → 整条路退化成贴鼠标。
 *
 *   所以这个探针不走单测，走真流程：给一条确定的拖选矩形，调真 show_bar，
 *   再读真日志里的 `place: side=` 和 `inner=`（横条胶囊的屏幕坐标）。
 *
 * 用法: node tools/r155-barpos-probe.js
 * 前提: cargo build --release
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const DATA = path.join(ROOT, 'target', 'release', 'Quick search data');
const OUT = path.join(__dirname, 'r155-barpos.txt');
const PORT = 9427;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra === undefined ? '' : '   [' + extra + ']')); }
}

let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (x.id !== i) return;
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails
        ? 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)
        : r.result.value;
};

async function connect(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && /(index\.html|\/)$/.test(t.url || ''));
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

const LOG = path.join(DATA, 'log.txt');
/* ⚠ off 是**字节**偏移（statSync().size），所以必须按 Buffer 切。
 *   以前写成 readFileSync(LOG,'utf8').slice(off) —— utf8 里一个汉字 3 字节、
 *   一个字符，字节偏移当字符下标用会**切过头**，把刚写进去的行整段吃掉，
 *   表现成"命令成功了但日志里没有"（这一版探针自己踩的坑）。 */
const readLogFrom = (off) => {
    try {
        const b = fs.readFileSync(LOG);
        return b.subarray(Math.min(off, b.length)).toString('utf8');
    } catch (e) { return ''; }
};
const logSize = () => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } };

/** 从一段日志里取**第一条** place: 的 side / caret / inner
 *
 *  ⚠ 为什么是"第一条"不是"最后一条"：探针实例也装着全局钩子，运行期间
 *  用户真划一次词就会多一条 show_bar/place（上一版探针就被这种"别人的条"
 *  顶掉了自己那条，读成 side=mouse）。本次调用的记录一定排在这段切片的最前。 */
function firstPlace(txt) {
    const lines = txt.split(/\r?\n/).filter((s) => s.indexOf('place: side=') >= 0);
    if (!lines.length) return null;
    const s = lines[0];
    const m = s.match(/side=([a-z-]+)\s+caret=(Some\(\((-?\d+), (-?\d+), (-?\d+), (-?\d+)\)\)|None).*?inner=\((-?\d+),(-?\d+)\)/);
    if (!m) return { raw: s };
    return {
        side: m[1],
        caret: m[2] === 'None' ? null : [+m[3], +m[4], +m[5], +m[6]],
        inner: [+m[7], +m[8]],
        raw: s,
    };
}
/** 本次调用之后的第一条 after-show（窗口真的可见了） */
function firstVisible(txt) {
    const lines = txt.split(/\r?\n/).filter((s) => s.indexOf('after-show: visible=true') >= 0);
    if (!lines.length) return null;
    const s = lines[0];
    const m = s.match(/rect=Some\(RECT \{ left: (-?\d+), top: (-?\d+), right: (-?\d+), bottom: (-?\d+) \}\)/);
    return m ? { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4], raw: s } : { raw: s };
}
function firstShowSrc(txt) {
    const lines = txt.split(/\r?\n/).filter((s) => s.indexOf('show_bar: atMouse=') >= 0);
    if (!lines.length) return null;
    const s = lines[0];
    // caret 的 Debug 输出带空格：Some((1, 2, 3, 4)) —— 必须精确匹配四个数字，
    // 用 `.*?` 会在第一个 `)` 提前截断（上一版探针就在这儿误报过 src=null）。
    const m = s.match(
        /atMouse=(\w+) cfgMouse=(\w+) caret=(Some\(\((-?\d+), (-?\d+), (-?\d+), (-?\d+)\)\)|None) src=(\w+) anchor=\((-?\d+),(-?\d+)\)/
    );
    if (!m) return { raw: s };
    return {
        atMouse: m[1], cfgMouse: m[2],
        caret: m[3] === 'None' ? null : [+m[4], +m[5], +m[6], +m[7]],
        src: m[8],
        anchor: [+m[9], +m[10]],
    };
}

(async () => {
    if (!fs.existsSync(EXE)) { rec('没找到 ' + EXE + '，先 cargo build --release'); process.exit(1); }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r155-'));
    const env = Object.assign({}, process.env, {
        QS_DEBUG: '1',
        QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r155' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r155 探针：pid=' + proc.pid + '（不影响已部署的那个实例）');
    await sleep(8000);

    const ws = await connect();
    if (!ws) { rec('连不上横条页面'); try { proc.kill(); } catch (e) { } process.exit(1); }

    // 等 IPC 就绪：第二实例启动时页面先到、命令通道可能晚一点才通
    for (let i = 0; i < 40; i++) {
        const ok = await ev(ws, `!!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)`);
        if (ok) break;
        await sleep(250);
    }
    const pre = await ev(ws, `window.__TAURI__.core.invoke('get_config')
        .then(function(c){ return JSON.stringify({ barPos: c.barPos, ver: c.version }); })
        .catch(function(e){ return 'ERR ' + e; })`);
    rec('预检 config_view -> ' + pre);

    // 屏幕尺寸（物理 px）：选一个屏幕中部偏上的点，上下都放得下
    const geo = JSON.parse(await ev(ws, `(function(){
        var d = window.devicePixelRatio || 1;
        return JSON.stringify({ w: Math.round(screen.availWidth * d), h: Math.round(screen.availHeight * d), d: d });
    })()`));
    rec('屏幕(物理) = ' + geo.w + 'x' + geo.h + ' dpr=' + geo.d);

    const sx = Math.round(geo.w * 0.30);
    const sy = Math.round(geo.h * 0.45);
    const ex = sx + Math.round(200 * geo.d);
    const drag = [sx, sy, ex, sy];
    rec('拖选矩形（按下→抬起）= ' + JSON.stringify(drag));

    const results = {};
    for (const pos of ['above', 'below']) {
        const off = logSize();
        await ev(ws, `window.__TAURI__.core.invoke('set_setting', { key: 'barPos', value: '${pos}' })
            .then(function(){ return 'ok'; }).catch(function(e){ return 'ERR ' + e; })`).then((r) => {
            if (String(r).indexOf('ERR') === 0) rec(`set_setting(barPos=${pos}) -> ${r}`);
        });
        await sleep(250);
        // ⚠ 不能 .catch 掉就完：invoke 失败时日志里什么都不会有，
        //    上一次就是这样把「命令报错」误判成「日志没写」。
        const ret = await ev(ws, `window.__TAURI__.core.invoke('show_bar', { text: '定位探针', atMouse: false, viaCopy: false, sel: ${JSON.stringify(drag)} })
            .then(function(v){ return 'ok gen=' + v; }).catch(function(e){ return 'ERR ' + e; })`);
        rec(`[${pos}] invoke show_bar -> ${ret}`);
        await sleep(1200);
        const txt = readLogFrom(off);
        results[pos] = {
            place: firstPlace(txt),
            vis: firstVisible(txt),
            show: firstShowSrc(txt),
            txt,
        };
        const p = results[pos].place;
        rec(`[${pos}] src=${results[pos].show && results[pos].show.src} caret=${p ? JSON.stringify(p.caret) : '?'} `
            + `side=${p && p.side} inner=${p ? JSON.stringify(p.inner) : '?'} `
            + `win=${results[pos].vis ? results[pos].vis.top : '?'}`);
        if (!p) rec(`[${pos}] 日志片段尾 3 行：\n` + txt.split(/\r?\n/).slice(-3).join('\n'));
    }

    /* ---------- 断言 ---------- */
    const A = results.above, B = results.below;
    check('两次都真的弹出了（after-show visible=true）', !!A.vis && !!B.vis,
        'above=' + (A.vis ? 'yes' : 'no') + ' below=' + (B.vis ? 'yes' : 'no'));

    const srcA = A.show && A.show.src, srcB = B.show && B.show.src;
    const usedDrag = srcA === 'drag' && srcB === 'drag';
    check('传了拖选矩形就一定按 drag 算（真光标不再顶掉它）', usedDrag, 'src=' + srcA + '/' + srcB);
    if (!usedDrag) {
        rec('SKIP  位置断言（src 不是 drag，说明 show_bar 没收到 sel 或前台判定异常）');
    } else {
        check('上方：真的摆在文字（拖选）上方', A.place && A.place.side === 'above' && A.place.inner[1] < sy - 6,
            A.place && (A.place.side + ' inner_y=' + A.place.inner[1] + ' vs dragY=' + sy));
        check('下方：真的摆在文字（拖选）下方', B.place && B.place.side === 'below' && B.place.inner[1] > sy,
            B.place && (B.place.side + ' inner_y=' + B.place.inner[1] + ' vs dragY=' + sy));
        check('两个选项算出的 y 不同（用户报的就是这条不成立）',
            A.place && B.place && A.place.inner[1] !== B.place.inner[1],
            A.place && B.place && (A.place.inner[1] + ' vs ' + B.place.inner[1]));
        check('拖选矩形被当成文字行框（caret 上下边把拖选点包住）',
            A.place && A.place.caret && A.place.caret[1] < sy && A.place.caret[3] > sy,
            A.place && JSON.stringify(A.place.caret));
    }

    // 顶部边界：拖选贴着屏幕最上面时，选「上方」应该翻到下方（不被压到屏幕外）
    const off2 = logSize();
    await ev(ws, `window.__TAURI__.core.invoke('set_setting', { key: 'barPos', value: 'above' }).catch(function(e){})`);
    await sleep(250);
    const topDrag = [sx, 4, ex, 4];
    await ev(ws, `window.__TAURI__.core.invoke('show_bar', { text: '贴顶探针', atMouse: false, viaCopy: false, sel: ${JSON.stringify(topDrag)} }).catch(function(e){})`);
    await sleep(1200);
    const topPlace = firstPlace(readLogFrom(off2));
    if (topPlace && topPlace.side && topPlace.side !== 'mouse') {
        check('贴屏幕顶部 + 选「上方」→ 自动翻到下方（side=below）', topPlace.side === 'below', topPlace.side);
        check('贴顶时胶囊没被压出工作区（inner_y >= 0）', topPlace.inner[1] >= 0, 'inner_y=' + topPlace.inner[1]);
    } else {
        rec('SKIP  贴顶断言（src 不是 drag：' + JSON.stringify(topPlace) + '）');
    }

    rec('');
    rec(`结果：${pass} PASS / ${fail} FAIL`);
    try { proc.kill(); } catch (e) { }
    process.exit(fail ? 1 : 0);
})().catch((e) => { rec('探针异常：' + (e && e.stack || e)); process.exit(2); });
