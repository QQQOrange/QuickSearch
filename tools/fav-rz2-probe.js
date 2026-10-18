/* ============================================================================
 *  收藏面板缩放专项探针（fav-rz2-probe.js）
 *
 *  验两件事（都是用户报过的）：
 *    ① 拖**左下角**时：左缘跟鼠标走、右缘不动、**横条和窗口都不该动**（方向不能反）；
 *    ② 拖完松手后尺寸要落盘、重渲染不能把面板弹回去。
 *
 *  做法：真实鼠标（SendInput）拖 .fav-rz.sw 把手，逐帧同时记录
 *    · 窗口矩形（**按本进程 pid 过滤** —— 用户自己的实例可能也在跑，同名窗口不止一个）
 *    · 面板 DOM 矩形、横条 DOM 矩形（换算成屏幕坐标）
 *    · stage.paddingLeft / panel.left / panel.width
 *
 *  启动方式用测试开关，避免碰全局输入（免得和用户正在跑的实例互相干扰）：
 *    QS_INSTANCE_TAG=<tag>（另起一个单实例名额）+ --bar（启动即摆出横条）
 *
 *  用法：node fav-rz2-probe.js
 *  输出：fav-rz2-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'fav-rz2-probe.txt');
const PORT = 9334;
const TAG = '-probe-rz';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
function mouse(flags, x, y) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeInt32LE(Math.round(x * 65535 / (SW - 1)), 8);
    b.writeInt32LE(Math.round(y * 65535 / (SH - 1)), 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(flags, 20);
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return SendInput(1, b, 40);
}
const moveTo = (x, y) => mouse(MOVE | ABS, x, y);
const ldown = (x, y) => mouse(MOVE | ABS | LDOWN, x, y);
const lup = (x, y) => mouse(MOVE | ABS | LUP, x, y);

/** 本进程的 QuickSearchBar 窗口矩形（用户自己的实例同名，必须按 pid 过滤） */
function barRect(pid) {
    let out = null;
    const cb = koffi.register((h) => {
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        if (p[0] !== pid) return 1;
        const t = new Uint16Array(200); const n = GetWindowTextW(h, t, 200);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
        if (s === 'QuickSearchBar') {
            const r = {}; GetWindowRect(h, r);
            out = [r.left, r.top, r.right - r.left, r.bottom - r.top];
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const fmt = (r) => r ? `x=${r[0]} y=${r[1]} w=${r[2]} h=${r[3]}` : 'NONE';

let msgId = 0;
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            ws.removeEventListener('message', onMsg);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function connect(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
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

const SNAP = `(function(){
  const q=(s)=>document.querySelector(s);
  const box=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect();
    return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; };
  const p=q('#panel'), st=q('#stage');
  // ⚠ 面板是绝对定位，包含块是 stage 的 **padding box** —— 它的 DOM left 是相对
  //    padding box 的，换算到视口必须把 padding-left 加回去（第一版探针漏了这一步，
  //    于是「面板屏幕坐标」整整偏了一个 padding，看着像面板飞走了）。
  const padL = st ? (parseFloat(st.style.paddingLeft) || 0) : 0;
  const pb = p ? p.getBoundingClientRect() : null;
  return {
    panel: box(p), bar: box(q('#bar')), handle: box(q('.fav-rz.sw')), stage: box(st),
    padL: st?st.style.paddingLeft:'', padLnum: padL, minW: st?st.style.minWidth:'',
    pw: p?p.style.width:'', pl: p?p.style.left:'', ph: p?p.style.height:'',
    // 面板在**视口**里的矩形（已把 padding 加回）
    panelView: pb ? [Math.round(pb.left + padL), Math.round(pb.top),
                     Math.round(pb.width), Math.round(pb.height)] : null,
    dpr: window.devicePixelRatio || 1,
  };
})()`;

/** 读一次「窗口矩形 + DOM」，两者之间窗口若还在动就重读，保证是同一时刻的快照 */
async function snapConsistent(ws, pid) {
    for (let i = 0; i < 4; i++) {
        const w1 = barRect(pid);
        const s = await evalJs(ws, SNAP);
        const w2 = barRect(pid);
        if (w1 && w2 && w1[0] === w2[0] && w1[1] === w2[1]
            && w1[2] === w2[2] && w1[3] === w2[3]) {
            return { s, W: w1 };
        }
        await sleep(60);
    }
    return { s: await evalJs(ws, SNAP), W: barRect(pid) };
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-favrz-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    // 光标先摆到屏幕中间：--bar 会按当前光标位置摆横条
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(300);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid + '（QS_INSTANCE_TAG=' + TAG + ' + --bar，不碰全局输入）');
    sleep(9000);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上（端口 ' + PORT + '）'); try { proc.kill(); } catch (e) { } flush(); process.exit(0); }
    rec('横条已摆出：窗口 ' + fmt(barRect(proc.pid)));

    // 打开 ⋯ 面板 → 点收藏夹目录
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(1000);
    const favN = await evalJs(ws,
        "(function(){const b=document.querySelector('.fav-entry'); if(!b) return 0; b.click(); return 1;})()");
    sleep(1500);
    const _c0 = await snapConsistent(ws, proc.pid);
    const s0 = _c0.s, W0 = _c0.W;
    const dpr = s0.dpr || 2;
    rec('收藏面板已开：favEntry=' + favN);
    rec('初始 ' + JSON.stringify(s0) + '  窗口 ' + fmt(W0));
    if (!s0.handle) { rec('没找到 .fav-rz.sw 把手'); try { proc.kill(); } catch (e) { } flush(); process.exit(0); }

    const hx = W0[0] + Math.round((s0.handle[0] + s0.handle[2] / 2) * dpr);
    const hy = W0[1] + Math.round((s0.handle[1] + s0.handle[3] / 2) * dpr);
    const barScreen0 = [W0[0] + Math.round(s0.bar[0] * dpr), W0[1] + Math.round(s0.bar[1] * dpr)];
    rec('把手屏幕坐标 (' + hx + ',' + hy + ')  横条屏幕左上 ' + JSON.stringify(barScreen0));

    // ---- 拖：往左 + 往下（左下角语义：左缘该跟着往左走）----
    const frames = [];
    moveTo(hx, hy); sleep(200);
    ldown(hx, hy); sleep(150);
    for (let i = 1; i <= 8; i++) {
        const x = hx - i * 30, y = hy + i * 12;
        moveTo(x, y);
        sleep(110);
        const c = await snapConsistent(ws, proc.pid);
        const s = c.s, W = c.W;
        frames.push({ i, mx: x, my: y, s, W,
                      barScreen: W ? [W[0] + Math.round(s.bar[0] * dpr),
                                      W[1] + Math.round(s.bar[1] * dpr)] : null,
                      panelScreen: W ? [W[0] + Math.round(s.panelView[0] * dpr),
                                        W[1] + Math.round(s.panelView[1] * dpr)] : null });
    }
    lup(hx - 240, hy + 96);
    sleep(400);
    const afterDrag = await evalJs(ws, SNAP);
    const Wa = barRect(proc.pid);
    rec('拖完（松手 0.4s）' + JSON.stringify(afterDrag) + '  窗口 ' + fmt(Wa));

    sleep(1600);   // 等 600ms 的尺寸落盘 + 配置广播回来
    const afterSave = await evalJs(ws, SNAP);
    const Ws = barRect(proc.pid);
    let confSize = 'n/a';
    try {
        const c = JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8'));
        confSize = JSON.stringify(c.fav_panel_sizes || null);
    } catch (e) { confSize = '读配置失败'; }
    rec('保存后（2.0s）' + JSON.stringify(afterSave) + '  窗口 ' + fmt(Ws));
    rec('落盘 fav_panel_sizes = ' + confSize);

    rec('--- 逐帧（横条屏幕左上 / 面板屏幕左上+宽 / padding / panel.left,width）---');
    for (const f of frames) {
        rec('  #' + f.i + ' 鼠标(' + f.mx + ',' + f.my + ')'
            + ' 横条屏 ' + JSON.stringify(f.barScreen)
            + ' 面板屏 ' + JSON.stringify(f.panelScreen)
            + ' 面板视口 ' + JSON.stringify(f.s.panelView)
            + ' padL=' + f.s.padL + ' left=' + f.s.pl + ' w=' + f.s.pw
            + ' 横条DOM.left=' + f.s.bar[0] + ' 窗口.left=' + (f.W ? f.W[0] : '?')
            + ' pin估算=' + (f.W ? (f.W[0] + f.s.bar[0] * dpr) : '?'));
    }

    // ---- 判定 ----
    const barDrift = frames.map((f) => Math.abs(f.barScreen[0] - barScreen0[0])
        + Math.abs(f.barScreen[1] - barScreen0[1]));
    const maxBarDrift = Math.max(...barDrift);
    const p0 = frames[0].panelScreen, pN = frames[frames.length - 1].panelScreen;
    const leftMoved = pN[0] - p0[0];                 // 应为负（左缘往左走）
    const right0 = p0[0] + frames[0].s.panelView[2] * dpr;
    const rightN = pN[0] + frames[frames.length - 1].s.panelView[2] * dpr;
    const rightDrift = Math.abs(rightN - right0);
    const kept = afterSave.panel && afterDrag.panel
        && Math.abs(afterSave.panel[2] - afterDrag.panel[2]) <= 4
        && Math.abs(afterSave.panel[3] - afterDrag.panel[3]) <= 4;
    rec('判定：横条最大漂移 ' + maxBarDrift + 'px（该≈0）'
        + '  左缘位移 ' + leftMoved + 'px（该为负）'
        + '  右缘漂移 ' + rightDrift + 'px（该≈0）'
        + '  保存后尺寸没回弹=' + kept);
    rec('→ ' + ((maxBarDrift <= 4 && leftMoved < -60 && rightDrift <= 8 && kept)
        ? 'PASS 左缘跟鼠标、右缘与横条都不动' : 'FAIL 见上面数据'));
    try {
        rec('--- log.txt 尾部 14 行 ---');
        rec(fs.readFileSync(logp, 'utf8').split('\n').slice(-60).join('\n'));
    } catch (e) { }
    flush();
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
