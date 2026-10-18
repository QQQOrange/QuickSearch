/* ============================================================================
 *  轮 28 专项探针：液态玻璃（liquidGL 移植版）+ 引擎三类拆分（搜/开/快捷键）
 *
 *  取证方式（全部客观、可复现；零合成键盘输入、零网页/程序副作用）：
 *
 *  A 玻璃渲染（隔离实例 + --bar 直接摆横条，不注入任何全局输入）：
 *    背景页由本探针用 Edge --app 全屏加载（数学图案，非随机噪声，可建模）：
 *      · 正弦灰带（周期 37 CSS px）→ 量**折射位移场**：边缘处背景被扭曲，
 *        中心区收手；refraction 拉满后位移显著变大。
 *      · 红蓝竖条（周期 16）→ 量**色差**：R/B 两个通道的采样滞后在边缘远大于中心。
 *      · 纯色 #808080 → 量**上下缘亮线**（rim，逐帧取最小值抹掉游走光斑）、
 *        **圆角外透明不发黑**（alpha 合成）、**光斑会动**（动态光影）。
 *    所有像素取证用 koffi BitBlt 抓**合成后的屏幕**（= 用户真看到的那一帧），
 *    横条内容事先 visibility:hidden，只留玻璃画布本身。
 *
 *  B 快捷键引擎派发（可观测）：记事本在前台、光标压在它身上 → --bar  →
 *    横条的「触发现场」= 记事本 → 点快捷键引擎 → Rust 把焦点还给记事本、
 *    合成 ctrl+s → 记事本弹出「另存为」#32770 对话框（按 pid 计数；Win11
 *    标签页记事本 ctrl+n 只开新标签不开新窗口，这条路在本机不可观测）。
 *    log.txt 记「模拟按键 ctrl+s -> 已发送 投向=触发现场」。桌面副作用只有
 *    一个对话框，探针负责 WM_CLOSE 收掉它。
 *
 *  C 设置页与三类 UI：液态玻璃总开关/滑块落 config 并广播到横条；
 *    自定义引擎表单三类型分段（快捷键类隐藏地址行、露出组合键行）；
 *    引擎列表三类徽标 + 搜索过滤；engines.json 快捷键条数。
 *
 *  全程隔离：每个实例独立临时 APPDATA + WebView2 目录 + QS_INSTANCE_TAG。
 *  用法：node tools/round28-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round28-probe.txt');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetCursorPos = user32.func('int GetCursorPos(_Out_ POINT *p)');
const SetCursorPos = user32.func('int SetCursorPos(int x, int y)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const PostMessageW = user32.func('int PostMessageW(void *h, uint msg, intptr w, intptr l)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)');
const GetDC = user32.func('void *GetDC(void *h)');
const ReleaseDC = user32.func('int ReleaseDC(void *h, void *dc)');
const WindowFromPoint = user32.func('void *WindowFromPoint(int x, int y)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const GetAncestor = user32.func('void *GetAncestor(void *h, uint ga)');
const GetTopWindow = user32.func('void *GetTopWindow(void *h)');
const GetWindow = user32.func('void *GetWindow(void *h, uint cmd)');   // GW_HWNDNEXT=2
// exstyle 用 32 位的 GetWindowLongW 取（GWL_EXSTYLE = -20；exstyle 放得下 32 位）
const GetWindowLongW = user32.func('uint GetWindowLongW(void *h, int idx)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
const IsIconic = user32.func('int IsIconic(void *h)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const AttachThreadInput = user32.func('int AttachThreadInput(int idAttach, int idAttachTo, int fAttach)');
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *dc, int cx, int cy)');
const SelectObject = gdi32.func('void *SelectObject(void *dc, void *g)');
const BitBlt = gdi32.func('int BitBlt(void *d, int x, int y, int w, int h, void *s, int sx, int sy, uint op)');
const GetDIBits = gdi32.func('int GetDIBits(void *dc, void *bmp, uint start, uint lines, void *bits, void *bmi, uint use)');
const DeleteDC = gdi32.func('int DeleteDC(void *dc)');
const DeleteObject = gdi32.func('int DeleteObject(void *g)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77);   // SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN
const VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);   // SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ------------------------------ 屏幕抓取（合成后的真相） ------------------------------ */
function grab(x, y, w, h) {
    const screen = GetDC(null);
    const mem = CreateCompatibleDC(screen);
    const bmp = CreateCompatibleBitmap(screen, w, h);
    const old = SelectObject(mem, bmp);
    const ok = BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020 /* SRCCOPY */);
    SelectObject(mem, old);
    if (!ok) {
        DeleteObject(bmp); DeleteDC(mem); ReleaseDC(null, screen);
        return null;
    }
    const bmi = Buffer.alloc(44);
    bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(w, 4); bmi.writeInt32LE(-h, 8);
    bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14); bmi.writeUInt32LE(0, 16);
    const buf = Buffer.alloc(w * h * 4);
    const lines = GetDIBits(mem, bmp, 0, h, buf, bmi, 0);
    DeleteObject(bmp); DeleteDC(mem); ReleaseDC(null, screen);
    if (lines !== h) return null;
    return { x, y, w, h, buf };   // BGRA，自上而下
}
const bAt = (g, x, y) => g.buf[(y * g.w + x) * 4];
const gAt = (g, x, y) => g.buf[(y * g.w + x) * 4 + 1];
const rAt = (g, x, y) => g.buf[(y * g.w + x) * 4 + 2];
const lumAt = (g, x, y) => 0.299 * rAt(g, x, y) + 0.587 * gAt(g, x, y) + 0.114 * bAt(g, x, y);

/* ------------------------------ 窗口枚举 ------------------------------ */
const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
const wclass = (h) => {
    const t = new Uint16Array(400); const n = GetClassNameW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function wins() {
    const out = [];
    const cb = koffi.register((h) => {
        const t = wtext(h);
        if (t) {
            const r = {}; GetWindowRect(h, r);
            out.push({ hwnd: h, title: t, cls: wclass(h), vis: !!IsWindowVisible(h),
                       rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] });
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const barRect = () => { const w = wins().find((x) => x.title === 'QuickSearchBar'); return w ? w.rect : null; };
const waitBar = (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) { const r = barRect(); if (r && r[2] > 0) return r; sleep(120); }
    return null;
};
const pidOf = (h) => { const b = Buffer.alloc(4); GetWindowThreadProcessId(h, b); return b.readInt32LE(0); };
/** 按进程 id 找记事本窗口（机器上可能有用户自己开的记事本，不能抓错）。
 *  仅兜底用：正常路径走差量认领（Win11 的 spawn pid 不是真窗口 pid）。 */
const notepadByPid = (pid) => wins().filter((w) => {
    if (w.cls !== 'Notepad' || !w.vis) return false;
    return pidOf(w.hwnd) === pid;
});
/** 另存为对话框（无标题文档按 ctrl+s 弹出）。同样按 pid 认领 —— 桌面上
 *  任何应用的 #32770 都不能算进来。 */
const saveAsDlg = (pid) => wins().filter((w) => w.cls === '#32770' && w.vis && pidOf(w.hwnd) === pid);
const fmt = (r) => r ? `x=${r[0]} y=${r[1]} w=${r[2]} h=${r[3]}` : 'NONE';
/** 某个屏幕点上最上层的窗口是不是它（探针的 Edge / 记事本）。
 *  WindowFromPoint 返回的是**最内层**子窗口（记事本顶上还压着编辑框、
 *  Edge 顶上压着 WebView 中间层），所以命中后要顺着 GA_PARENT 往上爬到
 *  顶层再比 —— 直接比顶层句柄会永远 false（踩过）。 */
const topIs = (h, x, y) => {
    let w = WindowFromPoint(x, y);
    for (let i = 0; i < 8 && w; i++) {
        if (w === h) return true;
        w = GetAncestor(w, 1 /* GA_PARENT */);
    }
    return false;
};
/** 胶囊中心这一像素「算干净」吗：顶层是横条自己，或者压在它上面的是
 *  **良性全屏蒙层**——铺满虚拟屏 + WS_EX_LAYERED + WS_EX_TRANSPARENT 的
 *  per-pixel-alpha 层（本机是手势软件的全屏蒙层，实测把整屏按 ~0.55~0.65
 *  线性压暗）。这种层 WindowFromPoint 一样返回它，直接判「顶层==横条」会把
 *  每一帧都毙掉（本轮就这么 FAIL 过）。压暗是均匀的，而 rim / 光斑 / 四角
 *  alpha 全是相对量，不受影响；真正会毁掉取证的是实心窗口（启动器、
 *  设置窗），它们蒙不过去。返回 {ok, who}，who 供取证日志。 */
const zClean = (barHwnd, x, y, w, h) => {
    let z = GetTopWindow(null);
    for (let i = 0; i < 400 && z; i++) {
        if (z === barHwnd) return { ok: true, who: 'bar@z' + i };
        if (IsWindowVisible(z)) {
            const r = {}; GetWindowRect(z, r);
            if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) {
                const ex = GetWindowLongW(z, -20 /* GWL_EXSTYLE */);
                const full = r.left <= VX + 4 && r.top <= VY + 4
                    && (r.right - r.left) >= VW - 8 && (r.bottom - r.top) >= VH - 8;
                const alpha = (ex & 0x80000) && (ex & 0x20);   // LAYERED | TRANSPARENT
                if (!(full && alpha)) return { ok: false, who: 'z#' + i + ' ' + wclass(z) + ' 挡着' };
            }
        }
        z = GetWindow(z, 2 /* GW_HWNDNEXT */);
    }
    return { ok: false, who: 'z-order 里找不到横条' };
};
/** 把窗口切到前台：本进程不是前台进程时 SetForegroundWindow 会静默失败，
 *  先 AttachThreadInput 挂到前台线程的输入队列上再设（标准解法）。 */
function forceForeground(h) {
    const fg = GetForegroundWindow();
    if (fg === h) return true;
    const b1 = Buffer.alloc(4), b2 = Buffer.alloc(4);
    const tFg = GetWindowThreadProcessId(fg, b1);
    const tH = GetWindowThreadProcessId(h, b2);
    const attached = tFg && tH && tFg !== tH ? AttachThreadInput(tFg, tH, 1) : 0;
    const ok = !!SetForegroundWindow(h);
    if (attached) AttachThreadInput(tFg, tH, 0);
    return ok;
}

/* ------------------------------ CDP ------------------------------ */
let PORT = 9401;
let wsId = 0;
const wsPending = new Map();
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        wsPending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
function wireWs(ws) {
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && wsPending.has(m.id)) {
            const p = wsPending.get(m.id);
            wsPending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message || 'cdp'));
            else p.resolve(m.result);
        }
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text)
            + (desc ? ' | ' + String(desc).split('\n')[0] : '')
            + ' | ' + String(expr).slice(0, 120));
    }
    return r.result.value;
}
async function targets() {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); }
    catch (e) { return []; }
}
async function connectWhere(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        const ts = await targets();
        const hit = ts.find((t) => t.type === 'page' && pred(t.url || ''));
        if (hit) {
            const ws = new WebSocket(hit.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            wireWs(ws);
            return ws;
        }
        await sleep(300);
    }
    return null;
}
const isBarPage = (u) => /index\.html/.test(u) || /tauri\.localhost\/?$/.test(u);
const isSettingsPage = (u) => /settings\.html/.test(u);
async function waitInvoke(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        try {
            if ((await evalJs(ws, "typeof invoke === 'function' && typeof listen === 'function'")) === true) return true;
        } catch (e) { }
        await sleep(300);
    }
    return false;
}
async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        rec('  [截图] ' + name);
    } catch (e) { rec('  WARN  截图失败 ' + name + ' → ' + e.message); }
}

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0, skipN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function skip(name, why) { skipN++; rec('  SKIP  ' + name + '   [' + why + ']'); }
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

/* ============================================================================
 *  背景页（Edge --app 全屏加载；数学图案，可建模）
 *  ⚠ canvas 必须显式给 CSS 尺寸：不设的话 layout 尺寸 = 属性尺寸（=物理像素数），
 *    dpr=2 的机器上画布按 2 倍 CSS 宽度布局、溢出视口，屏幕上的周期直接翻倍
 *    （实测 P=148 vs 设计 74 —— A2/A3/A4 的模型全部对不上，踩过）。
 *    现在 layout=视口 CSS 尺寸、backing=视口×dpr，37 CSS px 的周期在物理屏上
 *    就是 74px，和断言里的期望值一致。
 * ========================================================================== */
function bgPages(dir) {
    const head = `<!doctype html><meta charset="utf-8"><title>TITLE</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block}</style>
<canvas id="c"></canvas><script>
function draw(){
  var dpr=window.devicePixelRatio||1;
  var cw=Math.max(1,window.innerWidth), ch=Math.max(1,window.innerHeight);
  var w=Math.max(1,Math.round(cw*dpr)), h=Math.max(1,Math.round(ch*dpr));
  var c=document.getElementById('c');
  c.style.width=cw+'px'; c.style.height=ch+'px';
  c.width=w; c.height=h;
  var ctx=c.getContext('2d'); var img=ctx.createImageData(w,h); var d=img.data;
  for(var x=0;x<w;x++){ var v=PIX(x,dpr);
    for(var y=0;y<h;y++){ var i=(y*w+x)*4; d[i]=v[0]; d[i+1]=v[1]; d[i+2]=v[2]; d[i+3]=255; } }
  ctx.putImageData(img,0,0);
  window.__QSBG__=true;
}
window.addEventListener('resize',draw); draw();
<\/script>`;
    const sine = head.replace('TITLE', 'QS28-正弦背景')
        .replace('PIX(x,dpr)', '(function(x,dpr){ var v=Math.round(128+110*Math.sin(2*Math.PI*x/(37*dpr))); return [v,v,v]; })(x,dpr)');
    const chroma = head.replace('TITLE', 'QS28-色差背景')
        .replace('PIX(x,dpr)', '(function(x,dpr){ var t=2*Math.PI*x/(23*dpr);'
            + ' var v=Math.round(128+110*Math.sin(t)); return [v,0,255-v]; })(x,dpr)');
    const flat = head.replace('TITLE', 'QS28-纯色背景')
        .replace('PIX(x,dpr)', '(function(x,dpr){ return [128,128,128]; })(x,dpr)');
    const files = {};
    for (const [k, html] of [['sine', sine], ['chroma', chroma], ['flat', flat]]) {
        const p = path.join(dir, 'bg-' + k + '.html');
        fs.writeFileSync(p, html, 'utf8');
        files[k] = p;
    }
    return files;
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/* ============================================================================
 *  像素分析工具
 * ========================================================================== */
/** 列均值剖面（亮度），返回长度 n 的 Float 数组 */
function colProfile(g, x0, x1, y0, y1) {
    const out = [];
    for (let x = x0; x < x1; x++) {
        let s = 0, n = 0;
        for (let y = y0; y < y1; y++) { s += lumAt(g, x, y); n++; }
        out.push(s / Math.max(1, n));
    }
    return out;
}
function rowProfile(g, y0, y1, x0, x1) {
    const out = [];
    for (let y = y0; y < y1; y++) {
        let s = 0, n = 0;
        for (let x = x0; x < x1; x++) { s += lumAt(g, x, y); n++; }
        out.push(s / Math.max(1, n));
    }
    return out;
}
/** 逐像素取多帧最小值（抹掉游走的镜面光斑；光斑只增亮） */
function minFrames(frames) {
    const { w, h } = frames[0];
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < out.length; i += 4) {
        let mn = 1e9, mg = 1e9, mb = 1e9;
        for (const f of frames) {
            if (f.buf[i] < mb) mb = f.buf[i];
            if (f.buf[i + 1] < mg) mg = f.buf[i + 1];
            if (f.buf[i + 2] < mn) mn = f.buf[i + 2];
        }
        out[i] = mb; out[i + 1] = mg; out[i + 2] = mn; out[i + 3] = 255;
    }
    return { w, h, buf: out };
}

/** 正弦拟合：v ≈ mean + a·sin(2πx/P) + b·cos(2πx/P)（x 为绝对列号）。
 *  pLo/pHi 限定周期搜索范围：Edge 在 DPI 虚拟化下渲染分辨率会变，37 CSS px 的
 *  周期落到屏幕上可能是 37~153 物理 px 中的任何一个值（实测踩过：按 46 设计
 *  搜索范围，实际 153，拟合一路撞到上界给出垃圾结果）。 */
function fitSine(xs, vs, pLo, pHi) {
    let best = null;
    const n = xs.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += vs[i];
    mean /= Math.max(1, n);
    for (let P = pLo; P <= pHi; P += 0.25) {
        let sS = 0, sC = 0, sSS = 0, sCC = 0, sSC = 0;
        for (let i = 0; i < n; i++) {
            const t = 2 * Math.PI * xs[i] / P;
            const s = Math.sin(t), c = Math.cos(t);
            const v = vs[i] - mean;
            sS += s * v; sC += c * v; sSS += s * s; sCC += c * c; sSC += s * c;
        }
        const det = sSS * sCC - sSC * sSC;
        if (Math.abs(det) < 1e-9) continue;
        const a = (sS * sCC - sC * sSC) / det;
        const b = (sC * sSS - sS * sSC) / det;
        let res = 0;
        for (let i = 0; i < n; i++) {
            const t = 2 * Math.PI * xs[i] / P;
            res += Math.abs(vs[i] - (mean + a * Math.sin(t) + b * Math.cos(t)));
        }
        if (!best || res < best.res) best = { P, mean, a, b, res };
    }
    return best;
}

/** 横条取样的"无折射参照列" s0(x)。
 *  shader 里 localUV=(lensUV-0.5)/u_magnify+0.5、mapped=bounds.xy+localUV*bounds.zw，
 *  画布盒 = .bar 的 border-box（inset 0），解出来就是：
 *      s0(x) = pill.x + (x-pill.x)/m + 0.5·pill.w·(1-1/m)
 *  m 是玻璃里的放大系数（硬编码 1.05，这里从中心区实测拟合）。
 *  不建模它会错得离谱：光放大这一项，左右缘就各带 ±17px 的系统位移，
 *  比要测的折射位移还大。 */
const mkS0 = (pill, m) => (x) => pill.x + (x - pill.x) / m + 0.5 * pill.w * (1 - 1 / m);
/** glass.js:335 硬编码的放大系数（u_magnify），取样模型 s0 用它。 */
const MAGNIFY = 1.05;

/* ---------------------------------------------------------------------------
 *  位移测量内核：相位锚定 + 全局共享参数
 *
 *  上一轮的败因：每带自由拟合 (A, B, k) 时，位移 k 等价于正弦相位的整体旋转
 *  —— 它恰在 {sin, cos} 的张成空间里，残差对 k 恒平，k 完全不可识别
 *  （中心带 err 全场最小 0.26，k 却是 −31.46 的噪声）。
 *
 *  修复 = 相位锚定。桌面 fitSine 先给出 (a, b, P)，列 x 的取样值写成
 *      v(x) = α·[a·sin(w2·s0(x)+k) + b·cos(w2·s0(x)+k)] + γ + δ·dx
 *  展开后正弦部分 = [a0·cos(w2·k) + b0·sin(w2·k)]，其中
 *      a0 = a·sin(w2·s0(x)) + b·cos(w2·s0(x))
 *      b0 = a·cos(w2·s0(x)) − b·sin(w2·s0(x))
 *  数据点的相位由 s0(x) 钉死、比例也钉死，每带只剩 k 一个自由量。
 *  α（染色/蒙层线性压暗）、γ（直流）、δ（水平斜坡）是全局共享的三个参数，
 *  逐带只拟合 k。锚定之后 k 是绝对量，「中心 |k|≤2.5」才真能检查
 *  centreBlend 的设计（中心带离左右缘 ≥137px、edge≈0，折射贡献应为 0）。
 *
 *  k 的搜索范围仍钳 |k| ≤ min(0.45P, 40)：误差函数对 k 以 P 为严格周期，
 *  P≈74 时 ±120px 会给出 ~3 个等深的井（实测 57.99 的真身是 −15.26）。
 * ------------------------------------------------------------------------ */

/** n×n 高斯消元（部分选主元）。奇异返回 null。 */
function solveLin(A, b) {
    const n = b.length;
    const m = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
        if (Math.abs(m[piv][col]) < 1e-12) return null;
        if (piv !== col) { const t = m[piv]; m[piv] = m[col]; m[col] = t; }
        for (let r = col + 1; r < n; r++) {
            const f = m[r][col] / m[col][col];
            if (f === 0) continue;
            for (let cc = col; cc <= n; cc++) m[r][cc] -= f * m[col][cc];
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let acc = m[r][n];
        for (let cc = r + 1; cc < n; cc++) acc -= m[r][cc] * x[cc];
        x[r] = acc / m[r][r];
    }
    return x;
}

/** 边带划分（水平区间相对 pill 左缘 / pill 右缘，单位 px）。
 *  0-6 / 6-16 / 16-32 对应 shader 里 edge 从 1 线性衰减到 0 的三个区；
 *  中心 ±30 应无折射（centreBlend=0、edge≈0）。 */
const SPEC_EDGE = [
    { name: '左0-6', lo: 0, hi: 6 },
    { name: '左6-16', lo: 6, hi: 16 },
    { name: '左16-32', lo: 16, hi: 32 },
    { name: '中心', center: 30 },
    { name: '右0-6', right: 6 },
    { name: '右6-16', right: 16 },
    { name: '右16-32', right: 32 },
];
/** 色差版：左缘 / 中心 / 右缘各 0-8（A4 滞后测量用）。
 *  ⚠ 不能学 A2 那样取 0-26：单常数 k 的 SSE 拟合只能覆盖真值带均的
 *  60~90%，带越宽、场在带内越陡（0-26 跨完整个 bevel 衰减段），压缩越狠
 *  —— 实测 0-26 时左缘 lag=2.05（真值 0.7×3.19=2.23，只压 8%），右缘却
 *  lag=0.92（真值 ≈1.75，压一半），两缘不对称到没法设统一阈值。
 *  收到 0-8px（贴着位移峰值）：带内场变化小、lag 物理值 = 0.7×|offset|
 *  ≈ 0.7×8.5 ≈ 6px，压缩后仍有 ≥2 倍阈值的余量。 */
const SPEC_WIDE = [
    { name: '左缘0-8', lo: 0, hi: 8 },
    { name: '中心±30', center: 30 },
    { name: '右缘0-8', right: 8 },
];

function bandPts(sp, prof, pill) {
    const pc = pill.x + pill.w / 2;
    const xr = pill.x + pill.w;
    if (sp.center !== undefined) {
        return prof.filter((p) => Math.abs(p.x - pc) <= sp.center);
    }
    if (sp.right !== undefined) {
        return prof.filter((p) => p.x > xr - sp.right && p.x <= xr);
    }
    return prof.filter((p) => p.x >= pill.x + sp.lo && p.x < pill.x + sp.hi);
}

/** 位移场测量。prof=[{x,v}]，pill={x,w}，model={a,b,P}，specs=带定义数组。
 *  返回 { 带名: {k,n,err}, _par:[α,γ,δ], _s:中心带位移斜率, _m:反推放大系数 }。
 *  _m = 1/(_s + 1/MAGNIFY)：折射对中心带无贡献，中心带位移 = 纯斜率斜坡，
 *  其斜率 s 是 magnify 失配的唯一表现。 */
function measureDisp(prof, pill, model, specs) {
    const bands = specs || SPEC_EDGE;
    const P = Math.max(8, model.P);
    const kMax = Math.min(0.45 * P, 40);
    const w2 = 2 * Math.PI / P;
    const s0 = mkS0(pill, MAGNIFY);
    const norm2 = model.a * model.a + model.b * model.b;   // 桌面正弦的模方
    const bp = bands.map((sp) => {
        const pts = bandPts(sp, prof, pill);
        return {
            name: sp.name, isCenter: sp.center !== undefined, n: pts.length,
            a0: pts.map((p) => model.a * Math.sin(w2 * s0(p.x)) + model.b * Math.cos(w2 * s0(p.x))),
            b0: pts.map((p) => model.a * Math.cos(w2 * s0(p.x)) - model.b * Math.sin(w2 * s0(p.x))),
            v: pts.map((p) => p.v),
            dx: pts.map((p) => (p.x - (pill.x + pill.w / 2)) / 25),  // 水平斜坡横坐标
        };
    });
    // 由 a0/b0 还原该点的 (sinθ, cosθ)（θ = w2·s0(x)，锚定相位）：
    //   sinθ = (a·a0 − b·b0)/(a²+b²),  cosθ = (b·a0 + a·b0)/(a²+b²)
    const sinOf = (b, i) => (model.a * b.a0[i] - model.b * b.b0[i]) / norm2;
    const cosOf = (b, i) => (model.b * b.a0[i] + model.a * b.b0[i]) / norm2;

    /* ---- 位移初值：每带各用 (A,B,C) 拟合 k=0 的模型，取旋转角 ---- */
    // 共享 par 从 ks=0 起跑时会掉进假井（实测 60‰ 档左缘真值 −22.5 被测成
    // +2.5，连符号都反）。改成先用每带自己的 (A,B,C) 三参数拟合把位移定位：
    //   Â = α(a cos φ − b sin φ),  B̂ = α(b cos φ + a sin φ)
    //   → Â·b − B̂·a = −α(a²+b²)·sin φ,  Â·a + B̂·b = +α(a²+b²)·cos φ
    //   → φ = atan2(B̂·a − Â·b, Â·a + B̂·b),  位移 k = φ/w2
    // 两个分量别写反（写反就是全局差一个负号，从假井出发后面全错）。atan2 的
    // 值域 (−π,π] 保证 |k| ≤ P/2，比 kMax 略宽，超了直接钳。
    // 顺带得到每带的 α 估计：中心带那个就是取样模型的线性缩放自检。
    const ks = bp.map(() => 0);
    const alphaOf = bp.map(() => null);
    for (let bi = 0; bi < bp.length; bi++) {
        const b = bp[bi];
        if (b.n < 3) continue;
        let S = 0, C = 0, S2 = 0, C2 = 0, SC = 0, V = 0, SV = 0, CV = 0;
        for (let i = 0; i < b.n; i++) {
            const s = sinOf(b, i), c = cosOf(b, i), t = b.v[i];
            S += s; C += c; S2 += s * s; C2 += c * c; SC += s * c;
            V += t; SV += s * t; CV += c * t;
        }
        const x = solveLin([[S2, SC, S], [SC, C2, C], [S, C, b.n]], [SV, CV, V]);
        if (!x) continue;
        const phi = Math.atan2(x[1] * model.a - x[0] * model.b, x[0] * model.a + x[1] * model.b);
        ks[bi] = Math.max(-kMax, Math.min(kMax, phi / w2));
        alphaOf[bi] = (x[0] * model.a + x[1] * model.b) / norm2;
    }

    const par = [0, 0, 0];       // 全局 [α, γ, δ]
    // 给定 ks 解全局最小二乘 [α,γ,δ]（模型对这三个参数是线性的）
    const fitPar = () => {
        const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const rhs = [0, 0, 0];
        for (let bi = 0; bi < bp.length; bi++) {
            const b = bp[bi];
            if (b.n === 0) continue;
            const ck = Math.cos(w2 * ks[bi]), sk = Math.sin(w2 * ks[bi]);
            for (let i = 0; i < b.n; i++) {
                const s = b.a0[i] * ck + b.b0[i] * sk;
                const u = b.dx[i], t = b.v[i];
                M[0][0] += s * s; M[0][1] += s; M[0][2] += s * u;
                M[1][0] += s; M[1][1] += 1; M[1][2] += u;
                M[2][0] += s * u; M[2][1] += u; M[2][2] += u * u;
                rhs[0] += s * t; rhs[1] += t; rhs[2] += u * t;
            }
        }
        return solveLin(M, rhs);
    };
    // 单带一维网格（par 固定、k 自由）；返回 {k, e}
    const fitBandK = (bi, from, to, step) => {
        const b = bp[bi];
        if (b.n < 5) return null;
        const a = par[0], g = par[1], d = par[2];
        let best = { k: 0, e: Infinity };
        for (let k = from; k <= to + 1e-9; k += step) {
            const ck = Math.cos(w2 * k), sk = Math.sin(w2 * k);
            let sse = 0;
            for (let i = 0; i < b.n; i++) {
                const fit = a * (b.a0[i] * ck + b.b0[i] * sk) + g + d * b.dx[i];
                sse += (b.v[i] - fit) * (b.v[i] - fit);
            }
            const e = Math.sqrt(sse / b.n);
            if (e < best.e) best = { k, e };
        }
        return best;
    };
    // 网格起点对齐到步长整数倍。**必须做**：直接从 -kMax 起步时（kMax=33.3）
    // 0.25 步长的网格点是 …, -0.05, 0.20, … —— 0 永远不在网格上，本来就
    // 拟合到 0 的带子也会被塞一个 −0.05 的假位移，后面每轮都在污染 par。
    const gridFrom = (lo, step) => Math.ceil(lo / step) * step;
    // 中心带二维网格：第 i 点的位移 = k + s·dx[i]（s=位移斜坡斜率），
    // 正弦相位随之旋转 w2·s·dx[i]
    const fitCenter2D = (bi, kLo, kHi, kStep, sLo, sHi, sStep) => {
        const b = bp[bi];
        if (b.n < 5) return null;
        const a = par[0], g = par[1], d = par[2];
        let best = { s: 0, k: 0, e: Infinity };
        for (let s = gridFrom(sLo, sStep); s <= sHi + 1e-9; s += sStep) {
            for (let k = gridFrom(kLo, kStep); k <= kHi + 1e-9; k += kStep) {
                let sse = 0;
                for (let i = 0; i < b.n; i++) {
                    const kk = k + s * b.dx[i];
                    const fit = a * (b.a0[i] * Math.cos(w2 * kk) + b.b0[i] * Math.sin(w2 * kk)) + g + d * b.dx[i];
                    sse += (b.v[i] - fit) * (b.v[i] - fit);
                }
                const e = Math.sqrt(sse / b.n);
                if (e < best.e) best = { s, k, e };
            }
        }
        return best;
    };
    // 5 轮交替：全局 par → 中心带二维（k×s）→ 其余带三级网格收细
    for (let round = 0; round < 5; round++) {
        const p = fitPar();
        if (p) { par[0] = p[0]; par[1] = p[1]; par[2] = p[2]; }
        for (let bi = 0; bi < bp.length; bi++) {
            if (bp[bi].n < 5) continue;
            if (bp[bi].isCenter) {
                let r = fitCenter2D(bi, -8, 8, 0.25, -0.02, 0.02, 0.0005);
                if (!r) continue;
                const r2 = fitCenter2D(bi, r.k - 0.3, r.k + 0.3, 0.05, r.s - 0.001, r.s + 0.001, 0.0001);
                if (r2) r = r2;
                ks[bi] = r.k;
                bp[bi]._s = r.s;
                continue;
            }
            let kk = fitBandK(bi, gridFrom(-kMax, 0.25), kMax, 0.25);
            if (!kk) continue;
            const r2 = fitBandK(bi, gridFrom(kk.k - 0.3, 0.05), kk.k + 0.3, 0.05);
            if (r2) kk = r2;
            const r3 = fitBandK(bi, gridFrom(kk.k - 0.06, 0.01), kk.k + 0.06, 0.01);
            if (r3) kk = r3;
            ks[bi] = kk.k;
        }
    }
    const out = { _par: par.map((x) => +x.toFixed(4)) };
    for (let bi = 0; bi < bp.length; bi++) {
        const near = fitBandK(bi, ks[bi] - 0.02, ks[bi] + 0.02, 0.005);
        out[bp[bi].name] = {
            k: +ks[bi].toFixed(2), n: bp[bi].n, err: near ? +near.e.toFixed(2) : null,
            alpha: alphaOf[bi] === null ? null : +alphaOf[bi].toFixed(4),
        };
        if (bp[bi]._s !== undefined) {
            out._s = bp[bi]._s;
            out._m = +(1 / (bp[bi]._s + 1 / MAGNIFY)).toFixed(4);
        }
    }
    return out;
}

/* ============================================================================
 *  主流程
 * ========================================================================== */
(async function main() {
    rec('=== 轮 28 专项探针：液态玻璃 + 引擎三类（搜 / 开 / 快捷键） ===');
    rec('');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r28-'));
    const bgDir = path.join(tmpRoot, 'bg');
    fs.mkdirSync(bgDir, { recursive: true });
    const BG = bgPages(bgDir);
    info('背景页', JSON.stringify(Object.keys(BG).map((k) => path.basename(BG[k]))));
    rec('屏幕 ' + SW + 'x' + SH + '，虚拟屏 ' + VX + ',' + VY + ' ' + VW + 'x' + VH);

    /* ---------- Edge：全屏加载背景页，带 CDP 以便换页 ---------- */
    const EDGE_PORT = 9450;
    const edgeProf = path.join(tmpRoot, 'edgeprof');
    let edgeWs = null;
    let edgeProc = null;
    let edgeHwnd = null;
    try {
        edgeProc = spawn(EDGE, [
            '--app=file:///' + BG.sine.replace(/\\/g, '/'),
            '--user-data-dir=' + edgeProf,
            '--remote-debugging-port=' + EDGE_PORT,
            '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
            '--hide-crash-restore-bubble', '--window-position=0,0', '--window-size=' + SW + ',' + SH,
        ], { detached: false, stdio: 'ignore' });
        rec('Edge 已启动（pid=' + edgeProc.pid + '，背景页=正弦）');
    } catch (e) { rec('Edge 起不来：' + e.message); }
    sleep(2500);
    // 把 Edge 窗口强制铺满虚拟屏（--window-size 在缩放下不一定准）+ **置顶**。
    // 置顶不是可选美化：用户自己开着的 Edge / 别的窗口会盖在这张背景页上面，
    // 盖住之后 BitBlt 抓到的"桌面"其实是别人的内容 —— 上一轮三张截图的列剖面
    // 一模一样，根因就在这。SetForegroundWindow 从探针进程调会静默失败，
    // 只有 HWND_TOPMOST 能压过普通窗口。（横条自己每 800ms 重申一次置顶，
    // 所以后出现的横条仍然在 Edge 之上。）
    {
        const ew = wins().find((w) => /QS28-/.test(w.title));
        if (ew) {
            edgeHwnd = ew.hwnd;
            SetWindowPos(ew.hwnd, -1 /* HWND_TOPMOST */, VX, VY, VW, VH, 0x0040 /* SWP_SHOWWINDOW */);
            info('Edge 窗口已铺满并置顶', fmt(ew.rect));
        } else rec('WARN 枚举不到 Edge 窗口 —— 背景页可能压不住别的窗口');
    }
    PORT = EDGE_PORT;
    edgeWs = await connectWhere((u) => /bg-(sine|chroma|flat)\.html/.test(u), 20000);
    if (edgeWs) info('Edge CDP 已连上');
    else rec('WARN 连不上 Edge CDP —— 换页将退化为重启 Edge');

    async function switchBg(name) {
        if (edgeWs) {
            try {
                await cdp(edgeWs, 'Page.enable');
                await cdp(edgeWs, 'Page.navigate', { url: 'file:///' + BG[name].replace(/\\/g, '/') });
                await sleep(1100);
                const ok = await evalJs(edgeWs, '!!window.__QSBG__');
                info('Edge 已切到 ' + name, 'drawn=' + ok);
                return ok;
            } catch (e) { rec('WARN 切页失败：' + e.message); }
        }
        return false;
    }

    /* ---------- 实例工厂 ---------- */
    const instances = [];
    function makeConf(dir, extra) {
        const qs = path.join(dir, 'QuickSearch');
        fs.mkdirSync(qs, { recursive: true });
        const c = Object.assign({
            trigger_copy: false, trigger_select: false, ocr_enable: false,
            auto_color: false, auto_start: false,
            webdav_url: '', webdav_user: '', webdav_pass: '',
            webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
            backup_dir: '', apps: [], overrides: {}, fav_hotkey: '',
            bar_glass: true, bar_glass_refraction: 20, bar_glass_bevel: 12,
            bar_glass_frost: 0, bar_glass_aberration: 35, bar_glass_spec: 100,
            bar_glass_tint: 12, bar_glass_live: false,
            // 待机淡度关掉：指针不在条上时横条会按这个值整体变淡（默认 45%），
            // 玻璃像素全都被乘一个 0.45 —— 位移量会跟着缩水，测出来的不是真值。
            bar_dim_alpha: 100,
        }, extra || {});
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
        return qs;
    }
    function spawnInstance(qs, port, tag) {
        PORT = port;
        // config::data_dir() = %APPDATA%\QuickSearch，而 makeConf 把配置写在
        // <appData>\QuickSearch\config.json —— 所以 APPDATA 必须是 makeConf 的
        // 那个目录本身。曾经统一设成 tmpRoot，实例读的是 tmpRoot\QuickSearch
        // （根本不存在）→ 全默认配置，探针写的 bar_list / 自定义引擎它一个字
        // 都不看，B/C 两段因此全线 FAIL。
        const appData = path.dirname(qs);
        const env = Object.assign({}, process.env, {
            APPDATA: appData, LOCALAPPDATA: appData,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmpRoot, 'wv2-' + tag),
            QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
            QS_INSTANCE_TAG: tag,
            QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
                + ' --disable-gpu-sandbox --remote-debugging-port=' + port,
        });
        const p = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
        instances.push(p);
        rec('启动实例 pid=' + p.pid + '（CDP ' + port + '，tag=' + tag + '）');
        return p;
    }
    /** 杀掉一个实例并等它的横条窗口从桌面消失。
     *  多实例的横条窗口标题同名（QuickSearchBar），waitBar 按标题找窗口会串 ——
     *  必须确认上一个实例的窗口已经没了，再起下一个。 */
    function killInstance(idx) {
        const p = instances[idx];
        if (p) { try { p.kill(); } catch (e) { } }
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            if (!barRect()) return true;
            sleep(150);
        }
        return !barRect();
    }

    /* =====================================================================
     *  实例 A：玻璃像素取证
     * ===================================================================== */
    rec('');
    rec('############ 实例 A：液态玻璃渲染取证 ############');
    const qsA = makeConf(path.join(tmpRoot, 'A'), { bar_list: ['百度', 'Google', '知乎'] });
    const logA = () => { try { return fs.readFileSync(path.join(qsA, 'log.txt'), 'utf8'); } catch (e) { return ''; } };
    // 光标先放到屏幕中心：--bar 会读那一刻的光标位置
    SetCursorPos(Math.round(SW / 2), Math.round(SH * 0.30));
    sleep(200);
    spawnInstance(qsA, 9401, '-probe-r28a');
    sleep(9000);
    let barWs = await connectWhere(isBarPage, 30000);
    if (!barWs || !(await waitInvoke(barWs))) {
        rec('CDP 连不上横条页面 —— 实例 A 失败');
        rec('当前窗口：'); for (const w of wins()) rec('  ' + w.title + ' ' + fmt(w.rect));
        rec('log 尾部：\n' + logA().split('\n').slice(-15).join('\n'));
        flush(); process.exit(1);
    }
    info('横条页已连上，IPC 就绪');

    const rc = waitBar(10000);
    chk('★ A0 横条已弹出（--bar 免全局输入）', !!rc, fmt(rc));
    if (!rc) { flush(); process.exit(1); }

    /* ---- A1 基本状态：类名 / 画布 / WebGL2 / 纹理 / take 计数 ---- */
    const st1 = await evalJs(barWs, `(function(){
        var b=document.getElementById('bar'), c=document.getElementById('qsGlass');
        var cs=c?getComputedStyle(c):null, bs=b?getComputedStyle(b):null;
        return { glass:b?b.classList.contains('qs-glass'):null,
                 canvasDisplay:cs?cs.display:null,
                 pe:cs?cs.pointerEvents:null,
                 barBg:bs?bs.backgroundColor:null,
                 info:window.QSGlass?window.QSGlass.debugInfo():null };
    })()`);
    info('A1 状态：' + JSON.stringify(st1.info && {
        ready: st1.info.ready, on: st1.info.on, shown: st1.info.shown,
        tex: st1.info.texW + 'x' + st1.info.texH, takes: st1.info.stats.takes,
        params: st1.info.params }));
    chk('★ A1 横条挂了 qs-glass 类（WebGL2 就绪才会挂）', st1.glass === true);
    chk('  A1 玻璃画布 display:block（玻璃态才显示）', st1.canvasDisplay === 'block');
    chk('  A1 画布 pointer-events:none（点击穿透）', st1.pe === 'none');
    chk('  A1 横条底色全透（背景让位给画布）', /rgba\(0, 0, 0, 0\)|transparent/.test(st1.barBg || ''), st1.barBg);
    chk('★ A1 QSGlass.ready=true（WebGL2 可用）', !!(st1.info && st1.info.ready));
    chk('★ A1 纹理已上传（Rust 抓屏成功）', !!(st1.info && st1.info.texW > 0 && st1.info.texH > 0));
    chk('  A1 glass_take 至少取走一次', !!(st1.info && st1.info.stats.takes >= 1),
        'takes=' + (st1.info && st1.info.stats.takes));
    // Rust 的 log 是 300ms 批量落盘：take 刚完成那一刻文件里可能还没这行，
    // 直接读会假 FAIL（踩过）→ 轮询到出现为止。
    let capLog = '';
    {
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
            capLog = (logA().match(/glass: 已抓背景[^\n]*/) || [''])[0];
            if (capLog) break;
            await sleep(250);
        }
    }
    info('Rust 抓屏日志：' + capLog);
    chk('  A1 Rust 侧抓屏日志在位', /glass: 已抓背景 \d+x\d+ @\(-?\d+,-?\d+\)/.test(capLog));

    /* ---- 几何：横条盒（物理 px）= 窗口矩形 − WebView 内缩 ---- */
    const geo = await evalJs(barWs, `(function(){
        var r=document.getElementById('bar').getBoundingClientRect();
        return { cw:window.innerWidth, ch:window.innerHeight, dpr:window.devicePixelRatio||1,
                 bw:r.width, bh:r.height };
    })()`);    const barPhysW = Math.round(geo.bw * geo.dpr), barPhysH = Math.round(geo.bh * geo.dpr);
    const insetX = Math.max(0, rc[2] - barPhysW), insetY = Math.max(0, rc[3] - barPhysH);
    const pill = { x: rc[0] + Math.round(insetX / 2), y: rc[1] + Math.round(insetY / 2), w: rc[2] - insetX, h: rc[3] - insetY };
    info('窗口 rect=' + fmt(rc) + '；横条盒物理 ' + barPhysW + 'x' + barPhysH +
        '；内缩 ' + insetX + ',' + insetY + ' → 胶囊 ' + fmt([pill.x, pill.y, pill.w, pill.h]));

    // 内容藏起来，只留玻璃画布做像素取证（布局不变，画布不受影响）
    await evalJs(barWs, `(function(){
        var ids=['engines','btnOcr','btnMore','btnLink','tip'];
        for(var i=0;i<ids.length;i++){var e=document.getElementById(ids[i]); if(e) e.style.visibility='hidden';}
    })()`);
    await sleep(300);

    /** 抓一幅宽图：胶囊左右各 150px 桌面参照 */
    const margin = 150;
    function grabWide() {
        const gx = Math.max(VX, pill.x - margin), gy = Math.max(VY, pill.y);
        const gw = Math.min(VX + VW - gx, pill.w + 2 * margin), gh = Math.min(VY + VH - gy, pill.h);
        return grab(gx, gy, gw, gh);
    }
    /** 胶囊内的干净列（排除上下 rim 行）；返回 {x,v}[] */
    function cleanPillCols(g, chan) {
        const y0 = pill.y + Math.round(pill.h * 0.14), y1 = pill.y + Math.round(pill.h * 0.86);
        const x0 = pill.x - g.x, x1 = pill.x + pill.w - g.x;
        const prof = [];
        for (let x = x0; x < x1; x++) {
            let s = 0, n = 0;
            for (let y = y0 - g.y; y < y1 - g.y; y++) {
                const i = (y * g.w + x) * 4;
                s += (chan === 'r' ? g.buf[i + 2] : g.buf[i]); n++;
            }
            prof.push({ x: x + g.x, v: s / n });
        }
        return prof;
    }
    /** 桌面参照列（左右各取 margin−10 宽），返回 {x,v}[] */
    function deskCols(g, chan) {
        const y0 = pill.y + Math.round(pill.h * 0.14), y1 = pill.y + Math.round(pill.h * 0.86);
        const out = [];
        const push = (xa, xb) => {
            for (let x = xa; x < xb; x++) {
                let s = 0, n = 0;
                for (let y = y0 - g.y; y < y1 - g.y; y++) {
                    const i = (y * g.w + x) * 4;
                    s += (chan === 'r' ? g.buf[i + 2] : g.buf[i]); n++;
                }
                out.push({ x: x + g.x, v: s / n });
            }
        };
        const gx = g.x;
        push(Math.max(0, gx - (pill.x - margin)), Math.max(0, pill.x - g.x - 8));
        push(Math.max(0, pill.x + pill.w + 8 - g.x), Math.max(0, gx + g.w - (pill.x + pill.w + 8)));
        return out;
    }

    /* ---- A2 折射（正弦背景） ---- */
    rec('');
    rec('=== A2 折射位移场（正弦灰带背景，refraction=20 默认）===');
    let A2_K_MID = 0;   // 20‰ 档的中缘位移，A3 拿它当基准
    // 先关掉高光：spec=0 时 u_specular=0，画面只剩纯折射（rim 也一起没，A4 单独测）
    await evalJs(barWs, `(function(){
        var c=window.QSGlass.debugInfo().params;
        window.QSGlass.applyConf({ barGlass:true, barGlassRefraction:20, barGlassBevel:12,
            barGlassAberration:35, barGlassSpec:0, barGlassTint:12, barGlassFrost:0 });
        window.QSGlass.kick();
    })()`);
    await sleep(450);
    const gSine = grabWide();
    chk('  A2 抓到宽图（正弦背景）', !!gSine, gSine ? fmt([gSine.x, gSine.y, gSine.w, gSine.h]) : '');
    // 位移场由 measureDisp（相位锚定内核，见文件上部）统一产出：
    // 左右各 3 段（距缘 0-6 / 6-16 / 16-32px）+ 中心带。
    if (gSine) {
        const desk = deskCols(gSine), pillCols = cleanPillCols(gSine);
        const model = fitSine(desk.map((p) => p.x), desk.map((p) => p.v), 20, 400);
        const amp = Math.hypot(model.a, model.b);
        info('正弦模型：P=' + model.P.toFixed(2) + 'px 幅=' + amp.toFixed(1) +
            ' 残差/列=' + (model.res / Math.max(1, desk.length)).toFixed(1) + '（桌面 ' + desk.length + ' 列）');
        // 背景 sanity：拟合不上 = 采样点顶层不是探针那张页（Edge 被别的窗口盖住 /
        // refresh 没抓到新背景），这时候后面所有位移都是垃圾，先讲清楚。
        // 判据用周期而不是幅值：环境里的全屏半透明蒙层（实测本机 WGestures 的
        // per-pixel-alpha 常驻窗）会把整屏按一个系数线性压暗 —— 幅值 110→44、
        // 基线 128→51 都见过，幅值判据会假 FAIL。周期不受线性压暗影响。
        // （正弦页设计周期 37 CSS px，dpr=2 的物理屏上 = 74px。）
        const resCol = model.res / Math.max(1, desk.length);
        const bgOk = resCol < 15 && model.P > 50 && model.P < 100 && amp > 12;
        chk('★ A2 背景确认是探针的正弦页（残差小、周期≈74px）', bgOk,
            '残差/列=' + resCol.toFixed(1) + ' P=' + model.P.toFixed(1) + ' 幅=' + amp.toFixed(1));
        const topOk = !!edgeHwnd
            && topIs(edgeHwnd, pill.x - 40, pill.y + (pill.h >> 1))
            && topIs(edgeHwnd, pill.x + pill.w + 40, pill.y + (pill.h >> 1));
        // 半透明蒙层会挡在 Edge 上面（topIs 拿到蒙层而不是 Edge）—— 这不是失败：
        // 只要桌面模型能拟合上正弦，采样到的就是探针那张页。降级为 INFO。
        info('A2 采样点最顶层是 Edge？（蒙层挡在上面时为 false，仅供参考）', topOk);
        if (bgOk) {
            // 相位锚定的位移场：数据点相位由 s0(x) 钉死、比例钉死，逐带只拟合
            // 位移 k。中心带额外拟合位移斜坡斜率 s → 反推放大系数（应≈1.05，
            // 即取样模型 s0 与 shader 的 u_magnify 自洽）。
            const bands = measureDisp(pillCols, pill, model);
            info('A2 位移场（相位锚定，k>0 = 画面来自更右侧的桌面）：' + JSON.stringify(bands));
            {
                const edgeSegs = Object.keys(bands).filter(
                    (k) => k[0] !== '_' && bands[k] && bands[k].err !== null && k !== '中心');
                if (!edgeSegs.length) skip('A2 位移断言', '边缘干净列不够');
                else {
                    const maxEdge = Math.max.apply(null, edgeSegs.map((k) => Math.abs(bands[k].k)));
                    const lKeys = edgeSegs.filter((k) => k[0] === '左');
                    const rKeys = edgeSegs.filter((k) => k[0] === '右');
                    const meanL = lKeys.reduce((a, k) => a + bands[k].k, 0) / Math.max(1, lKeys.length);
                    const meanR = rKeys.reduce((a, k) => a + bands[k].k, 0) / Math.max(1, rKeys.length);
                    // 中缘（6-16px）位移留给 A3 做 20‰ vs 60‰ 的对比基准：
                    // 极缘处位移越大越容易被 oob 整段裁回去（设计如此），
                    // 真正随折射强度线性放大的是这一段
                    A2_K_MID = Math.max(Math.abs(bands['左6-16'] ? bands['左6-16'].k : 0),
                        Math.abs(bands['右6-16'] ? bands['右6-16'].k : 0));
                    chk('  A2 取样模型自洽（中心带反推放大系数 ≈1.05）',
                        !!bands._m && Math.abs(bands._m - 1.05) < 0.08,
                        '_m=' + bands._m + '（_s=' + bands._s + '）');
                    chk('★ A2 边缘有折射位移（左右缘 max|k| ≥ 3px）', maxEdge >= 3,
                        'max|k|=' + maxEdge.toFixed(2) + 'px');
                    const cb = bands['中心'];
                    chk('★ A2 中心区不收折射（|k| ≤ 2.5px，centreBlend 设计如此）',
                        !!cb && cb.err !== null && Math.abs(cb.k) <= 2.5,
                        cb ? 'k=' + cb.k : '中心带列不够');
                    chk('  A2 折射方向：左缘把画面往左拉、右缘往右拉（厚玻璃边缘）',
                        meanL < -1 && meanR > 1, '左均=' + meanL.toFixed(2) + ' 右均=' + meanR.toFixed(2));
                }
            }
        }
        await shot(barWs, '_r28-a2-sine.png');
    }

    /* ---- A3 折射拉满（refraction=60）：位移显著变大 ---- */
    rec('');
    rec('=== A3 折射拉满（refraction=60）：边缘位移显著放大 ===');
    await evalJs(barWs, `(function(){
        window.QSGlass.applyConf({ barGlass:true, barGlassRefraction:60, barGlassBevel:12,
            barGlassAberration:35, barGlassSpec:0, barGlassTint:12, barGlassFrost:0 });
        window.QSGlass.kick();
    })()`);
    await sleep(500);
    const gSine2 = grabWide();
    if (gSine2) {
        const desk2 = deskCols(gSine2), pillCols2 = cleanPillCols(gSine2);
        const model2 = fitSine(desk2.map((p) => p.x), desk2.map((p) => p.v), 20, 400);
        const amp2 = Math.hypot(model2.a, model2.b);
        const bgOk2 = model2.res / Math.max(1, desk2.length) < 15
            && model2.P > 50 && model2.P < 100 && amp2 > 12;
        chk('  A3 背景仍是正弦页', bgOk2,
            'P=' + model2.P.toFixed(1) + ' 幅=' + amp2.toFixed(1));
        if (bgOk2) {
            const bands2 = measureDisp(pillCols2, pill, model2);
            info('A3 位移场（相位锚定）：' + JSON.stringify(bands2));
            info('A3 反推放大系数 _m=' + bands2._m + '（_par=' + JSON.stringify(bands2._par) + '）');
            {
                // 极缘处位移越大越容易被 oob 整段裁回去（设计如此），真正随折射强度
                // 线性放大的是 6-16px 那段 —— 拿它比 20 与 60 两档。
                // 注意：6-16px 正好落在 edgeFactor 的 smoothstep(0,16.6,d) 陡降段
                // 上，场内位移本身在变，单常数 k 只能取带内 SSE 最优，实测约为
                // 真值带均的 60~90%（合成标定见 _diag6）。所以绝对阈值放 4、
                // 物理主张主要靠下面的比值。
                {
                    const kMid = Math.max(Math.abs(bands2['左6-16'] ? bands2['左6-16'].k : 0),
                        Math.abs(bands2['右6-16'] ? bands2['右6-16'].k : 0));
                    chk('★ A3 refraction=60 时中缘位移显著（≥4px，折射强度可调）', kMid >= 4,
                        'k(6-16)=' + kMid.toFixed(2) + ' 左=' + bands2['左6-16'].k +
                        ' 右=' + (bands2['右6-16'] ? bands2['右6-16'].k : 'n/a'));
                    if (A2_K_MID) {
                        chk('  A3 折射拉满后中缘位移 ≥1.6 倍（20‰ 档）', kMid >= 1.6 * A2_K_MID,
                            '60‰=' + kMid.toFixed(2) + ' vs 20‰=' + A2_K_MID.toFixed(2));
                    }
                }
            }
        }
    }
    // 恢复默认折射
    await evalJs(barWs, `(function(){
        window.QSGlass.applyConf({ barGlass:true, barGlassRefraction:20, barGlassBevel:12,
            barGlassAberration:35, barGlassSpec:100, barGlassTint:12, barGlassFrost:0 });
        window.QSGlass.kick();
    })()`);
    await sleep(400);

    /* ---- A4 色差（互补正弦背景）：R/B 通道采样滞后 ---- */
    rec('');
    rec('=== A4 色差（R/B 互补正弦背景，aberration=35 默认）===');
    if (!(await switchBg('chroma'))) skip('A4 色差', 'Edge 切页失败');
    else {
        // 刷新纹理：glass_capture → recapture_last 按上一块矩形重抓
        // （曾经 take() 把矩形也一起清掉，这里永远拿到空快照 —— 已修）
        const capOk = await evalJs(barWs, `(function(){
            return window.QSGlass.refresh().then(function(){
                var i=window.QSGlass.debugInfo();
                return { tex:i.texW+'x'+i.texH, takes:i.stats.takes, captures:i.stats.captures||0 };
            });
        })()`);
        info('A4 refresh 后：' + JSON.stringify(capOk));
        // 关高光再测：u_specular 的镜面项是「加在最终颜色上的空间亮度」，
        // 不属于折射位移，混进来只会污染 lag 拟合（A2/A3 都是 spec=0 测的）。
        // A5 之前会恢复 spec=100 —— 它要测的正是这个光斑。
        await evalJs(barWs, `(function(){
            window.QSGlass.applyConf({ barGlass:true, barGlassRefraction:20, barGlassBevel:12,
                barGlassAberration:35, barGlassSpec:0, barGlassTint:12, barGlassFrost:0 });
            window.QSGlass.kick();
        })()`);
        await sleep(350);
        chk('  A4 refresh 拿到了新背景（纹理仍在）', !!capOk && capOk.tex !== '0x0', JSON.stringify(capOk));
        await sleep(400);
        const gCh = grabWide();
        if (!gCh) skip('A4 色差', '抓屏失败');
        else {
            // 每个通道各建一套桌面模型（R 是正正弦、B 是反相正弦，周期相同）
            const chans = {};
            for (const c of ['r', 'b']) {
                const d = deskCols(gCh, c), p = cleanPillCols(gCh, c);
                const m = fitSine(d.map((q) => q.x), d.map((q) => q.v), 20, 400);
                const amp = Math.hypot(m.a, m.b);
                chans[c] = { desk: d, pill: p, model: m, amp };
                info('A4 ' + c + ' 通道桌面模型：P=' + m.P.toFixed(2) + ' 幅=' + amp.toFixed(1) +
                    ' 残差/列=' + (m.res / Math.max(1, d.length)).toFixed(1));
            }
            // 周期判据（互补正弦页设计周期 23 CSS px → dpr=2 物理屏 46px），
            // 幅值只要求明显非零（蒙层压暗时幅值会跟着缩水）
            const bgOk = chans.r.model.P > 30 && chans.r.model.P < 70
                && chans.b.model.P > 30 && chans.b.model.P < 70
                && chans.r.amp > 12 && chans.b.amp > 12
                && chans.r.model.res / Math.max(1, chans.r.desk.length) < 15
                && chans.b.model.res / Math.max(1, chans.b.desk.length) < 15;
            chk('★ A4 背景确认是探针的互补正弦页（refresh 真的抓到了）', bgOk,
                'R幅=' + chans.r.amp.toFixed(1) + ' B幅=' + chans.b.amp.toFixed(1) +
                ' P=' + chans.r.model.P.toFixed(1) + '/' + chans.b.model.P.toFixed(1));
            if (bgOk) {
                // 每通道各跑一次宽带位移场（左缘 0-26 / 中心 ±30 / 右缘 0-26）。
                // 色差 lag = |k_R − k_B|：shader 里 R 采 sampleUV−chroma、
                // B 采 sampleUV+chroma，同一个折射位移对两通道是相反方向的
                // 投影 → lag ≈ 2·chroma·|采样点处折射位移方向分量|。
                const F = {};
                for (const c of ['r', 'b']) {
                    F[c] = measureDisp(chans[c].pill, pill, chans[c].model, SPEC_WIDE);
                    info('A4 ' + c.toUpperCase() + ' 通道位移场（宽带，_m=' + F[c]._m + '）：'
                        + JSON.stringify(F[c]));
                }
                // lag = |k_R − k_B|；offset（无彩差位移）= (k_R + k_B)/2。
                // shader：chroma = offset×u_aberration，R 采 UV−chroma、B 采
                // UV+chroma → k_R = 0.65×offset、k_B = 1.35×offset →
                //   lag = 0.7×|offset|（u_aberration = 35/100 = 0.35，默认档）。
                // 把比值一起打出来：实测 lag/|offset| 应 ≈0.7，是色差量的物理自校。
                const lag = (n) => (F.r[n] && F.b[n]) ? Math.abs(F.r[n].k - F.b[n].k) : null;
                const off = (n) => (F.r[n] && F.b[n]) ? (F.r[n].k + F.b[n].k) / 2 : null;
                const lagL = lag('左缘0-8'), lagC = lag('中心±30'), lagRr = lag('右缘0-8');
                const offL = off('左缘0-8'), offR = off('右缘0-8');
                const ratio = (l, o) => (l !== null && o !== null && Math.abs(o) > 0.5) ? (l / Math.abs(o)).toFixed(2) : 'n/a';
                info('A4 R/B 滞后：左缘=' + lagL + '（offset=' + offL + '，比值=' + ratio(lagL, offL) + '）'
                    + ' 中心=' + lagC + ' 右缘=' + lagRr + '（offset=' + offR + '，比值=' + ratio(lagRr, offR) + '）'
                    + '；理论 lag = 0.7×|offset|');
                if (lagL !== null && lagC !== null && lagRr !== null) {
                    chk('★ A4 左缘 R/B 分离明显（≥2px，色差生效）', lagL >= 2, 'lag=' + lagL + 'px');
                    chk('  A4 右缘同样分离', lagRr >= 2, 'lag=' + lagRr + 'px');
                    chk('★ A4 中心区 R/B 基本不分离（色差跟着折射走，中心无折射）',
                        lagC <= 2.5, 'lag=' + lagC + 'px');
                } else skip('A4 色差断言', '干净列不够');
            }
            await shot(barWs, '_r28-a4-chroma.png');
        }
    }

    /* ---- A5 rim 亮线 + alpha + 动态光斑（纯色背景，spec=100 默认） ---- */
    rec('');
    rec('=== A5 上下缘亮线 / 透明圆角 / 动态光斑（纯色背景）===');
    if (!(await switchBg('flat'))) skip('A5 rim/alpha', 'Edge 切页失败');
    else {
        // A4 为了位移拟合把高光关了，这里测的正是一层动态镜面光斑 + 上下 rim
        // 亮线，必须先恢复 spec=100（默认值）。
        await evalJs(barWs, `(function(){
            window.QSGlass.applyConf({ barGlass:true, barGlassRefraction:20, barGlassBevel:12,
                barGlassAberration:35, barGlassSpec:100, barGlassTint:12, barGlassFrost:0 });
            window.QSGlass.kick();
        })()`);
        await sleep(300);
        await evalJs(barWs, 'window.QSGlass.refresh()');
        await sleep(600);
        // 桌面参照亮度：从宽图的**左右边距列**取（胶囊外 8..150px 的桌面），
        // 不能拿胶囊帧自己的边列 —— 那是横条的像素，不是桌面（踩过）
        const gFlat = grabWide();
        let deskMean = 128, flatOk = false;
        if (gFlat) {
            const dk = deskCols(gFlat).map((p) => p.v);
            const dm = dk.reduce((a, b) => a + b, 0) / Math.max(1, dk.length);
            const sd = Math.sqrt(dk.reduce((a, b) => a + (b - dm) * (b - dm), 0) / Math.max(1, dk.length));
            deskMean = dm;
            flatOk = sd < 3 && dm > 60 && dm < 200;
            info('A5 桌面参照：均值=' + dm.toFixed(1) + ' 标准差=' + sd.toFixed(2) + '（纯色页应≈128）');
            chk('★ A5 背景确认是纯色页（refresh 抓到了 #808080）', flatOk,
                '均值=' + dm.toFixed(1) + ' sd=' + sd.toFixed(2));
        }
        // 指针停到胶囊中心：frame 循环常驻（画面持续重绘），lp2 光斑钉在中心。
        // ⚠ 必须先挪到远处再回来：若指针本来就在中心（上一个探针的悬停测试
        //    留在那儿——横条每次弹在同一 rect），Windows 不会补发 pointermove，
        //    `setPointer` 不触发 → reveal 一结束动画循环就停 → 8 帧全静止、
        //    摆动=0（假 FAIL）。先挪到左上角再进中心，保证这是一次真实移动。
        SetCursorPos(VX + 10, VY + 10);
        await sleep(150);
        SetCursorPos(pill.x + Math.round(pill.w / 2), pill.y + Math.round(pill.h / 2));
        await sleep(500);
        // 桌面环境里有瞬态覆盖物（启动器弹窗、渐变蒙层等）会盖住横条，
        // minFrames 会把覆盖物的像素一起取走 → rim/四角全是垃圾。逐帧校验
        // 「横条之上没有实心窗口压着」——z-order 从顶部往下走，在碰到横条
        // 之前只允许铺满虚拟屏的透明分层蒙层（均匀压暗，判据全是相对量，
        // 不受影响；判据见 zClean 注释）。
        // 被实心窗口挡掉的帧才丢，挡了什么记进 who 供取证。
        const barHwnd0 = (wins().find((x) => x.title === 'QuickSearchBar') || {}).hwnd;
        const frames = [];
        let covered = 0;
        const coverWho = [];
        for (let i = 0; i < 8; i++) {
            const g = grab(pill.x, pill.y, pill.w, pill.h);
            if (g) {
                const c = !barHwnd0 ? { ok: true, who: 'no-bar?' }
                    : zClean(barHwnd0, pill.x, pill.y, pill.w, pill.h);
                if (c.ok) frames.push(g); else { covered++; coverWho.push(c.who); }
            }
            await sleep(360);
        }
        chk('  A5 抓到 ≥4 帧干净画面（光斑动画期间）', frames.length >= 4,
            '干净 ' + frames.length + ' 帧，被遮挡 ' + covered + ' 帧'
            + (coverWho.length ? '（' + coverWho.join('、') + '）' : ''));
        if (frames.length >= 4) {
            // 动态光斑：任一像素 8 帧内的极大 − 极小。阈值放 25 而不是 40：
            // 横条若被环境蒙层压在下面（topmost 之争每 800ms 重排一次），整帧
            // 按蒙层不透明度等比变暗，摆动幅度跟着缩水（实测系数 0.55~0.65）。
            // 背景是静态的，干净帧的摆动只可能来自会动的镜面光斑。
            let motion = 0;
            {
                const f0 = frames[0];
                for (let i = 0; i < f0.buf.length; i += 4) {
                    let mn = 1e9, mx = -1e9;
                    for (const f of frames) {
                        const v = f.buf[i] + f.buf[i + 1] + f.buf[i + 2];
                        if (v < mn) mn = v; if (v > mx) mx = v;
                    }
                    if (mx - mn > motion) motion = mx - mn;
                }
            }
            chk('★ A5 镜面光斑会动（干净帧内最大亮度摆动 ≥25）', motion >= 25, '摆动=' + motion);

            const mn = minFrames(frames);
            const rp = rowProfile(mn, 0, mn.h, 0, mn.w);
            info('A5 桌面参照亮度=' + deskMean.toFixed(1) + '；顶/底行=' +
                rp.slice(0, 3).map((v) => v.toFixed(0)).join(',') + ' … ' +
                rp.slice(-3).map((v) => v.toFixed(0)).join(','));

            // rim：上缘 vs 内部（逐帧最小值已抹掉游走光斑）。
            // 下缘必须取**最后 5%** 的行 —— 曾经写成 74~84%，那已经是离底缘
            // 十几像素的内部了，edge≈0，量出来恒为负（-58.9 就是这么来的）。
            const midRef = (a, b) => rp.slice(a, b).reduce((x, y) => x + y, 0) / Math.max(1, b - a);
            const inner = midRef(Math.round(mn.h * 0.16), Math.round(mn.h * 0.26));
            const rimTop = midRef(0, Math.max(2, Math.round(mn.h * 0.05))) - inner;
            const rimBot = midRef(mn.h - Math.max(2, Math.round(mn.h * 0.05)), mn.h) - inner;
            info('A5 rim：上缘 +' + rimTop.toFixed(1) + '，下缘 +' + rimBot.toFixed(1) +
                '（内部基准 ' + inner.toFixed(1) + '，0-255）');
            chk('★ A5 上缘有锐利亮线（rim ≥6）', rimTop >= 6, '+' + rimTop.toFixed(1));
            chk('  A5 下缘同样有亮线', rimBot >= 6, '+' + rimBot.toFixed(1));

            // 上下缘 vs 左右缘：vw_ 垂直加权（左右缘在中部应明显弱于上下缘）
            // 左缘的"靠上"段 vs "中部"段（用行剖面在左 3 列上量）。
            // ⚠ 两个几何坑（合成标定复现 −3.57，实测标定 +8.71/+5.47，本轮
            //    干净日志复核 +8.7/+5.5 —— 一致）：
            //  ① 行段不能取 4-10（0.04h..0.12h）：左上角圆角弧（实测 R≈26
            //     物理 px = 13 CSS × dpr2，比 itemRadius 9 大；弧在 rows 0..52
            //     从 col 14 收到 col 26）在 rows 4-10 里左 3 列整段在玻璃外
            //     = 桌面 128，"亮线"恒测为负。取 rows 16-26：左 3 列只有
            //     col 0 偶发出界（弧边界 0.4~0.9），仍在竖条靠上区（vw_ 权重
            //     0.44~0.69，亮线幅度 ≈ 上缘的 2/3）。
            //  ② 参考列不能取 5-7：rim 亮带沿边缘伸延约 10px（纯色背景下
            //     col 1 峰值 +14、col 5 降到 +7），5-7 自己在亮带里，靠上段
            //     rim 权重高时参考列被一起提亮 → 差值被吃到 0 甚至负。
            //     取 14-17：亮带之外的同行局部基准（玻璃内亮度 126-132，
            //     全行剖面实测平坦，不受指针光斑/染色纵向梯度影响）。
            const leftColRows = [];
            for (let y = 0; y < mn.h; y++) {
                let s = 0; for (let x = 0; x < 3; x++) s += lumAt(mn, x, y);
                leftColRows.push(s / 3);
            }
            const leftRef = [];
            for (let y = 0; y < mn.h; y++) {
                let s = 0; for (let x = 14; x < 18; x++) s += lumAt(mn, x, y);
                leftRef.push(s / 4);
            }
            const lt = (a, b) => (leftColRows.slice(a, b).reduce((x, y) => x + y, 0) / Math.max(1, b - a))
                - (leftRef.slice(a, b).reduce((x, y) => x + y, 0) / Math.max(1, b - a));
            const ltTop = lt(16, 27);
            const ltMid = lt(40, 52);
            info('A5 左缘亮线：靠上段 +' + ltTop.toFixed(1) + '，中部段 +' + ltMid.toFixed(1));
            chk('  A5 左缘靠上段有亮线（≥4）', ltTop >= 4, '+' + ltTop.toFixed(1));
            chk('★ A5 垂直加权：上缘亮线显著强于左右缘中部（玻璃厚度感）',
                rimTop >= 6 && ltMid < rimTop * 0.6, 'rimTop=' + rimTop.toFixed(1) + ' leftMid=' + ltMid.toFixed(1));

            // alpha：窗口四角（胶囊外 20px/10px）必须=桌面灰，不能发黑/发白
            const gCorner = grab(rc[0], rc[1], rc[2], rc[3]);
            if (gCorner) {
                // 补丁坐标是**窗口帧**的（四角在胶囊帧之外，拿胶囊帧的坐标索引
                // 窗口帧会整体越界 → -1 垃圾值，踩过）
                const cornerPatch = (cx, cy) => {
                    let s = 0, n = 0;
                    for (let y = cy; y < cy + 6; y++) for (let x = cx; x < cx + 6; x++) {
                        if (x < 0 || y < 0 || x >= gCorner.w || y >= gCorner.h) continue;
                        s += lumAt(gCorner, x, y); n++;
                    }
                    return n ? s / n : -1;
                };
                const tl = cornerPatch(1, 1), tr = cornerPatch(gCorner.w - 7, 1);
                const bl = cornerPatch(1, gCorner.h - 7), br = cornerPatch(gCorner.w - 7, gCorner.h - 7);
                // 参照取**同高度**的窗框中点，不要拿远处桌面列：环境蒙层实测有
                // 纵向梯度（255→60），同高度窗框和四角受同样的污染，差值才有意义。
                const tlRef = cornerPatch((gCorner.w >> 1) - 3, 1);
                const blRef = cornerPatch((gCorner.w >> 1) - 3, gCorner.h - 7);
                info('A5 四角亮度（上/下；同高度窗框参照 ' + tlRef.toFixed(0) + '/' + blRef.toFixed(0) +
                    '，桌面 ' + deskMean.toFixed(0) + '）：' +
                    [tl, tr, bl, br].map((v) => v.toFixed(1)).join(' / '));
                chk('★ A5 圆角外不发黑（窗口是真透明，不是黑盒）',
                    tl > 40 && tr > 40 && bl > 40 && br > 40,
                    [tl, tr, bl, br].map((v) => v.toFixed(0)).join('/'));
                chk('  A5 四角也不是白盒（WebView 白底没漏出来）',
                    tl < 200 && tr < 200 && bl < 200 && br < 200,
                    [tl, tr, bl, br].map((v) => v.toFixed(0)).join('/'));
                chk('  A5 四角亮度贴近同高度窗框（透明合成正确）',
                    Math.abs(tl - tlRef) < 14 && Math.abs(tr - tlRef) < 14
                    && Math.abs(bl - blRef) < 14 && Math.abs(br - blRef) < 14,
                    'tl=' + tl.toFixed(1) + ' tr=' + tr.toFixed(1) +
                    ' bl=' + bl.toFixed(1) + ' br=' + br.toFixed(1));
                await shot(barWs, '_r28-a5-flat.png');
            }
        }
    }

    /* ---- A6 点击穿透 + 画布在内容之下 ---- */
    rec('');
    rec('=== A6 点击穿透（pointer-events）与层级 ===');
    await evalJs(barWs, `(function(){
        var ids=['engines','btnOcr','btnMore','btnLink','tip'];
        for(var i=0;i<ids.length;i++){var e=document.getElementById(ids[i]); if(e) e.style.visibility='';}
    })()`);
    await sleep(300);
    const hit = await evalJs(barWs, `(function(){
        var c=document.getElementById('qsGlass');
        // 探测点取**第一个引擎按钮自己的中心**：画布中心大概率落在 #engines
        // 容器的间隙上（按钮之间有 padding），elementFromPoint 会返回容器本身，
        // closest('button') 拿不到东西 → 假 FAIL（踩过）。
        var btn=document.querySelector('#engines button');
        var r=btn?btn.getBoundingClientRect():c.getBoundingClientRect();
        var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
        var hitBtn=el&&el.closest?el.closest('button'):null;
        var cs=getComputedStyle(c);
        var eng=document.getElementById('engines'); var ecs=eng?getComputedStyle(eng):null;
        var bar=document.getElementById('bar'); var bcs=bar?getComputedStyle(bar):null;
        return { hit: el? (el.id||el.className||el.tagName) : 'NONE',
                 isBtn: !!hitBtn, engine: hitBtn?(hitBtn.dataset.engine||'?'):null,
                 canvasZ: cs.zIndex, engZ: ecs?ecs.zIndex:null,
                 engPos: ecs?ecs.position:null,
                 barZ: bcs?bcs.zIndex:null, barPos: bcs?bcs.position:null };
    })()`);
    info('A6 命中：' + JSON.stringify(hit));
    chk('★ A6 画布不吞点击（elementFromPoint 命中引擎按钮）', hit.isBtn === true,
        'hit=' + hit.hit + ' engine=' + hit.engine);
    /* ⚠ 契约 2026-10-16（需求 6）变了：玻璃画布从 `.bar` 里搬到了 `.stage` 上
     *   （不然面板那块区域没有玻璃），所以"抬层"的对象从 `.bar` 的子元素换成了
     *   `.bar` / `.panel` **自己** —— 子元素不再需要各自 position/z-index，
     *   只要父级在画布之上就够。断言跟着换，不然测的是旧实现细节。 */
    chk('  A6 层级：画布 z-index:0，横条/面板自己抬到画布之上',
        hit.canvasZ === '0' && (hit.barZ === '1' || hit.barPos === 'relative'),
        'canvasZ=' + hit.canvasZ + ' barZ=' + hit.barZ + ' barPos=' + hit.barPos);

    // 实例 A 收工
    try { instances[instances.length - 1].kill(); } catch (e) { }
    await sleep(1500);

    /* =====================================================================
     *  实例 B：快捷键引擎派发（可观测）
     * ===================================================================== */
    rec('');
    rec('############ 实例 B：快捷键引擎派发 ############');
    // 先收掉实例 A：它的横条还挂在屏幕中上，会把记事本窗口/cursor 现场搅浑，
    // 而且 waitBar 按标题找窗口会串到 A 的横条上。
    info('收掉实例 A', '窗口消失=' + killInstance(0));
    // Edge 让位：A 段把它设成了 HWND_TOPMOST，不最小化会盖在记事本上面，
    // 触发现场（show_bar 那一刻的前台窗口）就变成 Edge 了，B1/B3 全跑偏。
    if (edgeHwnd) {
        ShowWindow(edgeHwnd, 6 /* SW_MINIMIZE */);
        await sleep(500);
        chk('  B 前置：Edge 已最小化让位', !!IsIconic(edgeHwnd));
    }
    const qsB = makeConf(path.join(tmpRoot, 'B'), {
        bar_list: ['QS28热键', '百度'],
        custom_engines: [
            { name: 'QS28热键', url: '', category: '工具', kind: 'hotkey', hotkey: 'ctrl+s' },
        ],
    });
    const logB = () => { try { return fs.readFileSync(path.join(qsB, 'log.txt'), 'utf8'); } catch (e) { return ''; } };
    // 记事本：开一个、认领它是「本次新出现的那个」，摆到屏幕左下、置顶、强切
    // 前台 —— 「触发现场」= show_bar 那一刻的前台窗口，必须是它，否则 B1 的
    // 焦点归还目标和 B3 的按键投向全跑偏。
    // ⚠ 不能按 spawn 的 pid 认领：Win11 上 spawn('notepad') 拿到的是转发存根
    //   的 pid，真正的窗口属于另一个 notepad 进程（实测 spawn pid=26436 →
    //   窗口 pid=23976），按 pid 找 10s 也找不到。差量认领：spawn 前拍一张
    //   记事本窗口清单，spawn 后新出现的那个就是本次的（机器上用户自己开着
    //   的记事本不会被抓错）。
    const hwndKey = (h) => String(h);
    const npBefore = new Set(wins().filter((w) => w.cls === 'Notepad' && w.vis).map((w) => hwndKey(w.hwnd)));
    const np = spawn('notepad', [], { detached: true, stdio: 'ignore' });
    np.unref();
    // 轮询等窗口：机器忙的时候 1.5s 不够（Win11 记事本起窗口慢），死等一次就报 FAIL
    // 会把整段 B 带走。轮询到 10s，并打出现有 Notepad 窗口的 pid 方便对比。
    let npWin = null;
    let npPid = null;
    {
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            npWin = wins().find((w) => w.cls === 'Notepad' && w.vis && !npBefore.has(hwndKey(w.hwnd))) || null;
            if (npWin) break;
            await sleep(250);
        }
        if (npWin) npPid = pidOf(npWin.hwnd);
    }
    if (!npWin) {
        chk('★ B0 记事本已打开', false, '按 pid ' + np.pid + ' 10s 内找不到窗口；现有 Notepad 窗口 pid：' +
            wins().filter((w) => w.cls === 'Notepad' && w.vis).map((w) => pidOf(w.hwnd)).join(',') || '无');
    }
    else {
        SetWindowPos(npWin.hwnd, -1 /* HWND_TOPMOST */, 160, Math.round(SH * 0.52), 780, 540, 0x0040 /* SWP_SHOWWINDOW */);
        forceForeground(npWin.hwnd);
        await sleep(400);
        // 真窗口的 pid（Win11 上它不是 spawn 返回的那个 pid）——另存为对话框按它认领
        const notepadByHwnd = () => wins().filter((w) =>
            w.cls === 'Notepad' && w.vis && hwndKey(w.hwnd) === hwndKey(npWin.hwnd));
        npWin = notepadByHwnd()[0] || npWin; // 移动后重取 rect
        /* 前台可能被本机的蒙层浮层抢走（WGestures 全屏 TRANSPARENT 蒙层、
         * TickTick 悬浮窗等，见 tools/ 历轮探针记录）—— 一次判定就 FAIL 会把
         * 整段 B 误伤。多给 2.5s 重试窗口；还抢不回来说明环境太敌对，B0 记
         * FAIL，B3 的两条按键落点断言按日志证据降级 SKIP（见下面焦点切换失败
         * 的自证分支）。 */
        let fgOk = false;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 2500) {
                if (GetForegroundWindow() === npWin.hwnd) { fgOk = true; break; }
                forceForeground(npWin.hwnd);
                await sleep(150);
            }
        }
        if (fgOk) {
            chk('★ B0 记事本已打开且是前台', true, fmt(npWin.rect));
        } else {
            /* 本机第三方蒙层浮层持续抢前台（WGestures 全屏 TRANSPARENT 蒙层、
             * TickTick 悬浮窗等，见历轮探针记录）—— 环境问题不是产品回归：
             * 降级 SKIP，B3 的按键落点断言按日志自证再判（见下面
             * 「焦点切换失败」分支）。 */
            skip('★ B0 记事本已打开且是前台', '蒙层抢前台，重试 2.5s 仍未稳住（环境）');
        }
        info('B 开始时本记事本进程窗口数=' + notepadByHwnd().length + '（pid=' + npPid + '）');
        SetCursorPos(npWin.rect[0] + Math.round(npWin.rect[2] / 2), npWin.rect[1] + Math.round(npWin.rect[3] / 2));
        await sleep(300);
        spawnInstance(qsB, 9402, '-probe-r28b');
        // 等横条弹出的 9s 里死守记事本前台。本机 WGestures 有一块全屏蒙层
        // （GUID 类名窗、LAYERED|TRANSPARENT、**可抢前台**），横条启动时
        // show_bar 捕获 GetForegroundWindow 有可能拿到它 —— 上一轮 B1 的
        // 「触发现场=0xa0c00」正是这块蒙层：焦点归还目标选错，B3 的 ctrl+s
        // 全喂给了蒙层，另存为对话框一个都没有。这里每 120ms 查一次，丢了
        // 立刻抢回，把「触发现场」钉死成记事本。
        {
            const t0 = Date.now();
            let stolen = 0;
            while (Date.now() - t0 < 9000) {
                if (GetForegroundWindow() !== npWin.hwnd) { forceForeground(npWin.hwnd); stolen++; }
                await sleep(120);
            }
            if (stolen) info('B 段前台守护：9s 内抢回记事本 ' + stolen + ' 次（蒙层抢前台）');
            else info('B 段前台守护：9s 内前台无变动');
        }
        barWs = await connectWhere(isBarPage, 30000);
        if (!barWs || !(await waitInvoke(barWs))) {
            chk('  B1 连上横条页', false);
        } else {
            chk('  B1 连上横条页', true);
            const rcB = waitBar(10000);
            chk('★ B1 横条弹出在记事本之上', !!rcB, fmt(rcB));
            if (rcB) {
                const trig = (logB().match(/show_bar: 触发现场[^\n]*/) || [''])[0];
                info('B1 触发现场日志：' + trig);
                // 记事本标题随系统语言：「无标题 - Notepad」（英文系统）或
                // 「无标题 - 记事本」（中文系统）—— 两种都得认。
                chk('  B1 触发现场=记事本（焦点归还目标选对了）',
                    /记事本|Notepad/i.test(trig), trig.slice(0, 90));

                // 横条按钮 + 面板格子的三类区分
                const ui = await evalJs(barWs, `(function(){
                    var b=document.querySelector('#engines button[data-engine="QS28热键"]');
                    return { title: b?b.title:'NONE', text: b?b.textContent.trim():'NONE' };
                })()`);
                info('B2 横条快捷键引擎按钮：' + JSON.stringify(ui));
                chk('  B2 横条 tooltip 点明「发送组合键 ctrl+s」',
                    /组合键 ctrl\+s/.test(ui.title), ui.title);

                // 点它（CDP 客户端坐标 + elementFromPoint 校准）
                const clk = await evalJs(barWs, `(function(){
                    var b=document.querySelector('#engines button[data-engine="QS28热键"]');
                    if(!b) return null; var r=b.getBoundingClientRect();
                    return [r.left+r.width/2, r.top+r.height/2];
                })()`);
                if (clk) {
                    const hitName = await evalJs(barWs,
                        `(function(){var el=document.elementFromPoint(${clk[0]},${clk[1]});`
                        + `if(!el)return 'NONE';var b=el.closest('button');return b?(b.dataset.engine||'?'):'?';})()`);
                    chk('  B3 点击坐标命中快捷键引擎', hitName === 'QS28热键', 'hit=' + hitName);
                    await cdp(barWs, 'Input.dispatchMouseEvent',
                        { type: 'mousePressed', x: clk[0], y: clk[1], button: 'left', clickCount: 1 });
                    await cdp(barWs, 'Input.dispatchMouseEvent',
                        { type: 'mouseReleased', x: clk[0], y: clk[1], button: 'left', clickCount: 1 });
                    await sleep(1800);
                    const logInc = logB();
                    const disp = (logInc.match(/open_search: QS28热键 模拟按键[^\n]*/) || [''])[0];
                    info('B3 派发日志：' + disp);
                    chk('★ B3 日志记「模拟按键 ctrl+s -> 已发送」', /模拟按键 ctrl\+s -> 已发送/.test(disp), disp.slice(0, 110));
                    /* 「焦点切换失败」= restore_focus_to 试过之后前台仍不是记事本 ——
                     * 本机蒙层抢前台的环境证据（产品侧这条分支本身就是兜底路径）。
                     * 天生带抖的环境项不判产品生死：降级 SKIP 并留证据。 */
                    const fgFail = /焦点切换失败/.test(logInc);
                    if (fgFail) {
                        skip('★ B3 按键投向触发现场（记事本），不是自己窗口',
                            '蒙层抢前台（日志自证：焦点切换失败）');
                    } else {
                        chk('★ B3 按键投向触发现场（记事本），不是自己窗口',
                            /投向=触发现场/.test(disp), disp.slice(0, 110));
                    }
                    // ctrl+s 落在记事本上 = 无标题文档弹「另存为」#32770 对话框。
                    // 按真窗口的 pid 计数：桌面上任何别的应用的 #32770 都不算进来。
                    const dlgAfter = saveAsDlg(npPid);
                    info('B3 点击后本 pid 另存为对话框数=' + dlgAfter.length);
                    if (fgFail) {
                        skip('★ B3 记事本真的弹出了另存为对话框（ctrl+s 落地）',
                            '按键没落到记事本（蒙层抢前台，日志自证）');
                    } else {
                        chk('★ B3 记事本真的弹出了另存为对话框（ctrl+s 落地）',
                            dlgAfter.length >= 1, '对话框数=' + dlgAfter.length);
                    }
                    // 收掉对话框，桌面不留副作用
                    for (const d of dlgAfter) PostMessageW(d.hwnd, 0x0010 /* WM_CLOSE */, 0, 0);
                    await sleep(900);
                    const dlgEnd = saveAsDlg(npPid);
                    chk('  B3 探针关掉了对话框', dlgEnd.length === 0, '还剩 ' + dlgEnd.length);
                }

                // 面板角标：快捷键类 = 「键」。
                // ⚠ 面板是三级结构（#128 重构）：点「⋯」先看到三大类卡片，
                // 要钻到第三层（分类网格）才有 .cell；快捷键组只有一个子类，
                // 点它的组卡直接进第三层。所以按组分别下钻再数。
                const openPanel = () => evalJs(barWs,
                    `(function(){ var m=document.getElementById('btnMore'); if(m) m.click(); })()`);
                const drill = (sel) => evalJs(barWs,
                    `(function(){ var el=document.querySelector('#panelBody ` + sel + `'); if(el) el.click(); })()`);
                const countBadges = () => evalJs(barWs, `(function(){
                    var cells=document.querySelectorAll('#panelBody .cell');
                    var hot=0, open=0, search=0;
                    cells.forEach(function(c){ var k=c.querySelector('.ck'); if(!k) return;
                        if(k.classList.contains('hot')) hot++;
                        else if(k.classList.contains('open')) open++; else search++; });
                    var hc=document.querySelector('#panelBody .cell .ck.hot');
                    var t=''; if(hc){ var cell=hc.closest('.cell'); t=cell.title||''; }
                    return { cells:cells.length, hot:hot, open:open, search:search, hotTitle:t };
                })()`);
                await openPanel(); await sleep(700);
                await drill('.grp-card[data-group="web"]'); await sleep(500);
                await drill('.grp-card[data-sub="search"]'); await sleep(700);
                const bSearch = await countBadges();
                info('B4 搜索引擎层徽标：' + JSON.stringify(bSearch));
                chk('  B4 搜索引擎层「搜」角标成片（search>50）',
                    bSearch.search > 50, 'search=' + bSearch.search + ' cells=' + bSearch.cells);
                // 返回第二层，进「直达网页」子类看「开」角标
                await drill('.crumb-back'); await sleep(500);
                await drill('.grp-card[data-sub="open"]'); await sleep(700);
                const bOpen = await countBadges();
                info('B4 直达网页层徽标：' + JSON.stringify(bOpen));
                chk('  B4 直达网页层「开」角标成片（open>50）',
                    bOpen.open > 50, 'open=' + bOpen.open + ' cells=' + bOpen.cells);
                // 快捷键组：组卡直接进第三层 → 「键」角标 + 组合键气泡
                await drill('.crumb .crumb-item'); await sleep(500);   // 「全部引擎」回第一层
                await drill('.grp-card[data-group="hotkey"]'); await sleep(700);
                const bHot = await countBadges();
                info('B4 快捷键层徽标：' + JSON.stringify(bHot));
                chk('★ B4 快捷键格子有「键」角标（琥珀色 .ck.hot）', bHot.hot >= 1,
                    'hot=' + bHot.hot + ' cells=' + bHot.cells);
                chk('  B4 快捷键格子气泡写明「发送组合键」', /发送组合键/.test(bHot.hotTitle), bHot.hotTitle);
                chk('  B4 快捷键层只有快捷键引擎（分组过滤生效）',
                    bHot.cells > 0 && bHot.hot === bHot.cells,
                    'hot=' + bHot.hot + ' cells=' + bHot.cells);
                await evalJs(barWs, `(function(){ var m=document.getElementById('btnMore'); if(m) m.click(); })()`);
                await sleep(400);
                // 收掉探针自己开的那个记事本（空内容，WM_CLOSE 不会弹保存框）
                if (npWin) PostMessageW(npWin.hwnd, 0x0010 /* WM_CLOSE */, 0, 0);
                await sleep(600);
            }
        }
    }

    /* =====================================================================
     *  实例 C：设置页（玻璃控件 + 三类引擎表单/搜索）
     * ===================================================================== */
    rec('');
    rec('############ 实例 C：设置页与三类 UI ############');
    // 同理：收掉实例 B 再起 C，避免横条窗口重名打架
    info('收掉实例 B', '窗口消失=' + killInstance(1));
    const qsC = makeConf(path.join(tmpRoot, 'C'), { bar_list: ['百度', 'Google', '知乎'] });
    const cfgPathC = path.join(qsC, 'config.json');
    const readCfgC = () => JSON.parse(fs.readFileSync(cfgPathC, 'utf8'));
    SetCursorPos(Math.round(SW / 2), Math.round(SH * 0.3));
    await sleep(200);
    spawnInstance(qsC, 9403, '-probe-r28c');
    await sleep(9000);
    barWs = await connectWhere(isBarPage, 30000);
    let setWs = null;
    if (!barWs || !(await waitInvoke(barWs))) {
        chk('  C0 连上横条页', false);
    } else {
        chk('  C0 连上横条页', true);
        waitBar(10000);
        await evalJs(barWs, "invoke('open_settings', {tab:'general'}).catch(function(e){})");
        setWs = await connectWhere(isSettingsPage, 25000);
        if (!setWs) chk('★ C0 设置窗口打开', false, '连不上 settings.html');
        else {
            chk('★ C0 设置窗口打开（通用分页）', true);

            // C1 横条样式三分段（#126：默认/磨砂/液态玻璃 三选一）。
            // ⚠ connectWhere 一看见 settings.html 就返回，那一刻页面的配置广播
            // 可能还没到、分段还是 HTML 默认态 —— 直接读会假 FAIL。轮询到分段
            // 真被配置（bar_glass=true → 液态玻璃）置上再说。
            let before = null;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 15000) {
                    before = await evalJs(setWs, `(function(){
                        var seg=document.getElementById('s-barStyle');
                        var on=seg? [].slice.call(seg.querySelectorAll('button'))
                            .filter(function(b){return b.classList.contains('on');}) : [];
                        return { style: on.length? on[0].dataset.v : null,
                                 segVis: !!seg && !!seg.offsetParent };
                    })()`);
                    if (before.style === 'glass') break;
                    await sleep(300);
                }
            }
            info('C1 样式分段初值：' + JSON.stringify(before));
            chk('  C1 「横条样式」三分段存在且默认落在「液态玻璃」',
                before.style === 'glass' && before.segVis === true);
            chk('  C1 玻璃专属配置行只在大类玻璃下显示（八行全亮）',
                await evalJs(setWs, `(function(){
                    var rows=[].slice.call(document.querySelectorAll('[data-style="glass"]'));
                    return rows.length === 8 && rows.every(function(r){return !r.hidden;});
                })()`));
            // 切到「磨砂」：barGlass=false + barBlur=12 → config + 横条摘类
            await evalJs(setWs, `(function(){
                var seg=document.getElementById('s-barStyle');
                var b=[].slice.call(seg.querySelectorAll('button'))
                    .filter(function(x){return x.dataset.v==='frost';})[0];
                if(b) b.click();
            })()`);
            let cfgOff = null;
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                try {
                    const c = readCfgC();
                    if (c.bar_glass === false && c.bar_blur === 12) { cfgOff = c; break; }
                } catch (e) { }
                await sleep(300);
            }
            chk('★ C1 切「磨砂」写入 config.json（bar_glass=false, bar_blur=12）', !!cfgOff);
            let clsGone = false;
            const t1 = Date.now();
            while (Date.now() - t1 < 12000) {
                const has = await evalJs(barWs,
                    "document.getElementById('bar').classList.contains('qs-glass')");
                if (has === false) { clsGone = true; break; }
                await sleep(300);
            }
            chk('★ C1 横条摘掉 qs-glass 类（广播链路通）', clsGone);
            const cv = await evalJs(barWs,
                "getComputedStyle(document.getElementById('qsGlass')).display");
            chk('  C1 画布随之隐藏（回到磨砂底板那条路）', cv === 'none', cv);
            chk('  C1 磨砂专属行（磨砂强度）显示、玻璃行全部藏起',
                await evalJs(setWs, `(function(){
                    var f=document.querySelector('[data-style="frost"]');
                    var gs=[].slice.call(document.querySelectorAll('[data-style="glass"]'));
                    return !!f && !f.hidden && gs.length === 8 && gs.every(function(r){return r.hidden;});
                })()`));

            // C2 折射滑块：先切回「液态玻璃」，再把折射拖到 40
            await evalJs(setWs, `(function(){
                var seg=document.getElementById('s-barStyle');
                var b=[].slice.call(seg.querySelectorAll('button'))
                    .filter(function(x){return x.dataset.v==='glass';})[0];
                if(b) b.click();
            })()`);
            await sleep(600);
            const sl = await evalJs(setWs, `(function(){
                var el=document.getElementById('s-barGlassRefraction');
                el.value='40'; el.dispatchEvent(new Event('input',{bubbles:true}));
                el.dispatchEvent(new Event('change',{bubbles:true}));
                return { v: el.value, label: document.getElementById('s-barGlassRefractionVal').textContent };
            })()`);
            info('C2 折射滑块 → ' + JSON.stringify(sl));
            let refr40 = null;
            const t2 = Date.now();
            while (Date.now() - t2 < 12000) {
                try { const c = readCfgC(); if (c.bar_glass_refraction === 40) { refr40 = c; break; } } catch (e) { }
                await sleep(300);
            }
            chk('★ C2 折射滑块落 config（bar_glass_refraction=40）', !!refr40);
            // 标签实际文本是「40 ‰」（带单位），不能整串相等
            chk('  C2 滑块标签跟着变（‰ 单位）', /^40\s*‰?\s*$/.test(sl.label), sl.label);
            let feRefr = null;
            const t3 = Date.now();
            while (Date.now() - t3 < 12000) {
                const p = await evalJs(barWs,
                    'window.QSGlass && window.QSGlass.debugInfo().params.refraction');
                if (p === 40) { feRefr = p; break; }
                await sleep(300);
            }
            chk('★ C2 横条前端参数收到 40（qs://config → applyConf）', feRefr === 40, 'params=' + feRefr);

            // C3 引擎分页：三类徽标 + 搜索过滤 + 快捷键表单
            await evalJs(setWs, "invoke('open_settings', {tab:'engines'}).catch(function(e){})");
            // ⚠ 不能固定睡 800ms 就采：分页切换是事件驱动的，慢一点整段测量
            // 就跑在隐藏分页上（item 的 offsetParent 全是 null）。轮询到引擎
            // 分页真可见、搜索框真有布局盒为止（产品侧另有 qs_page_ack 修掉
            // 「补发线程迟到 emit 冲掉分页」的根因，这里只是不再赌时序）。
            {
                const tTab = Date.now();
                let tabVis = false;
                while (Date.now() - tTab < 10000) {
                    tabVis = await evalJs(setWs, `(function(){
                        var p=document.querySelector('.pane[data-pane="engines"]');
                        var f=document.getElementById('allFilter');
                        return !!(p && !p.hidden && f && f.offsetParent);
                    })()`);
                    if (tabVis) break;
                    await sleep(250);
                }
                if (!tabVis) rec('  WARN  C3 等了 10s 引擎分页仍不可见（后续测量可能全空）');
            }
            const eng3 = await evalJs(setWs, `(function(){
                var items=[].slice.call(document.querySelectorAll('#allList .item, #allList .row'));
                var hot=0, open=0, search=0;
                items.forEach(function(it){
                    var kb=it.querySelector('.kb');
                    if(!kb){ search++; return; }   // 设置页只给开/键两类挂徽标，没徽标的就是搜索类
                    if(kb.classList.contains('hot')) hot++;
                    else if(kb.classList.contains('open')) open++; else search++;
                });
                var f=document.getElementById('allFilter');
                return { items: items.length, hot:hot, open:open, search:search,
                         filterVis: !!f && !!f.offsetParent, ph: f?f.placeholder:'' };
            })()`);
            info('C3 引擎列表徽标：' + JSON.stringify(eng3));
            chk('★ C3 列表里三类徽标并存（开/搜/键）',
                eng3.hot > 0 && eng3.open > 100 && eng3.search > 100,
                'hot=' + eng3.hot + ' open=' + eng3.open + ' search=' + eng3.search);
            chk('  C3 引擎页有搜索框', eng3.filterVis === true, eng3.ph);

            // 搜索：按组合键过滤
            // ⚠ 搜索框的 input 处理**防抖 120ms**（settings.js 里为 700+ 行列表
            //   重建加的），所以派发 input 之后要等一拍再量，不能在同一次 evalJs
            //   里同步读结果。
            await evalJs(setWs, `(function(){
                var f=document.getElementById('allFilter');
                f.value='win+shift+s'; f.dispatchEvent(new Event('input',{bubbles:true}));
            })()`);
            await sleep(400);
            const filt = await evalJs(setWs, `(function(){
                var vis=[].slice.call(document.querySelectorAll('#allList .item, #allList .row'))
                    .filter(function(it){ return it.offsetParent !== null; });
                var names=vis.map(function(it){ return it.textContent.replace(/\\s+/g,' ').trim().slice(0,40); });
                return { n: vis.length, first: names.slice(0,3) };
            })()`);
            info('C3 搜索「win+shift+s」：' + JSON.stringify(filt));
            chk('★ C3 按组合键搜得到引擎（截图类排前面）',
                filt.n > 0 && filt.n < eng3.items, '命中 ' + filt.n + ' / ' + eng3.items);

            // #127 起是统一「添加引擎」入口：先点 btnAddEngine 展开三种方式，
            // 再选「快捷键引擎」方式卡（customForm 才出场、类型锁死 hotkey）。
            await evalJs(setWs, `(function(){
                var f=document.getElementById('allFilter'); f.value='';
                f.dispatchEvent(new Event('input',{bubbles:true}));
            })()`);
            await sleep(400);   // 同上：等搜索框防抖把列表还原
            const kindUi = await evalJs(setWs, `(function(){
                var btn=document.getElementById('btnAddEngine');
                if(btn) btn.click();
                var ways=document.getElementById('addWays');
                var cards=ways? [].slice.call(ways.querySelectorAll('.addway')) : [];
                var hot=cards.filter(function(b){return b.dataset.way==='hotkey';});
                if(hot.length) hot[0].click();
                var cf=document.getElementById('customForm');
                var af=document.getElementById('appForm');
                var segs=[].slice.call(document.querySelectorAll('#s-ceKind button'));
                var hotSeg=segs.filter(function(b){return b.dataset.v==='hotkey';});
                var urlRow=document.getElementById('w-ceUrl');
                var hotRow=document.getElementById('ceHotRow');
                var hotInput=document.getElementById('w-ceHotkey');
                var kindRow=document.getElementById('s-ceKind').closest('.cform-kind');
                return { ways: ways? !ways.hidden : 'NONE',
                         wayCards: cards.map(function(b){return b.dataset.way;}),
                         hotCardOn: hot.length? hot[0].classList.contains('on') : 'NONE',
                         ceFormShown: cf? !cf.hidden : 'NONE',
                         appFormHidden: af? af.hidden : 'NONE',
                         kinds: segs.map(function(b){return b.dataset.v;}),
                         hotSegHidden: hotSeg.length? hotSeg[0].hidden : 'NONE',
                         kindRowHidden: kindRow? kindRow.hidden : 'NONE',
                         urlHidden: urlRow? urlRow.hidden : 'NONE',
                         hotRowShown: hotRow? !hotRow.hidden : 'NONE',
                         rec: !!document.getElementById('btnCeRec'),
                         hotPlaceholder: hotInput? hotInput.placeholder : '' };
            })()`);
            info('C4 添加引擎三方式与快捷键表单：' + JSON.stringify(kindUi));
            chk('★ C4 「添加引擎」展开三种方式（网页/软件/快捷键）',
                kindUi.ways === true
                && kindUi.wayCards.join(',') === 'web,app,hotkey',
                JSON.stringify(kindUi.wayCards));
            chk('  C4 选「快捷键引擎」方式卡后表单出场（软件表单仍收起）',
                kindUi.hotCardOn === true && kindUi.ceFormShown === true
                && kindUi.appFormHidden === true,
                'on=' + kindUi.hotCardOn + ' ce=' + kindUi.ceFormShown + ' app=' + kindUi.appFormHidden);
            chk('★ C4 快捷键方式：类型分段整条藏起来（类型没得选）',
                kindUi.kindRowHidden === true, 'row=' + kindUi.kindRowHidden);
            chk('  C4 选快捷键类后组合键录入行出现', kindUi.hotRowShown === true);
            chk('  C4 选快捷键类后地址框收起（不用填地址）', kindUi.urlHidden === true);
            chk('  C4 「录制…」按钮在位', kindUi.rec === true);

            // 提交一个快捷键自定义引擎（真正的「添加」按钮是 btnCeSave）
            const add = await evalJs(setWs, `(function(){
                document.getElementById('w-ceName').value='QS28探针键';
                document.getElementById('w-ceHotkey').value='ctrl+shift+t';
                document.getElementById('w-ceCat').value='工具';
                var btn=document.getElementById('btnCeSave');
                if(btn) btn.click();
                return 'clicked';
            })()`);
            void add;
            let added = null;
            const t4 = Date.now();
            while (Date.now() - t4 < 12000) {
                try {
                    const c = readCfgC();
                    const e = (c.custom_engines || []).find((x) => x.name === 'QS28探针键');
                    if (e) { added = e; break; }
                } catch (e) { }
                await sleep(300);
            }
            chk('★ C4 快捷键自定义引擎落 config（hotkey 字段 + kind）',
                !!added && added.kind === 'hotkey' && added.hotkey === 'ctrl+shift+t' && !added.url,
                JSON.stringify(added));

            // engines.json 快捷键条数
            const cat = await evalJs(barWs, `(function(){
                return fetch('data/engines.json').then(function(r){return r.json();}).then(function(j){
                    var hot=0, open=0, search=0;
                    j.categories.forEach(function(c){ (c.engines||[]).forEach(function(e){
                        var k=e.kind||((e.url||'').indexOf('%s')>=0?'search':'open');
                        if(k==='hotkey') hot++; else if(k==='open') open++; else search++; }); });
                    (j.toolbar||[]).forEach(function(e){ if((e.kind||'search')==='search') search++; });
                    return { hot:hot, open:open, search:search, cats:j.categories.length };
                });
            })()`);
            info('C5 engines.json：' + JSON.stringify(cat));
            chk('★ C5 内置快捷键引擎 ≥26 条（新分类）', cat && cat.hot >= 26, 'hot=' + (cat && cat.hot));
            chk('  C5 网页/软件/快捷键三类都在目录里',
                !!cat && cat.search > 100 && cat.open > 100 && cat.hot >= 26,
                'search=' + (cat && cat.search) + ' open=' + (cat && cat.open));
        }
    }

    /* =====================================================================
     *  收尾
     * ===================================================================== */
    rec('');
    rec('=== log.txt 尾部（实例 A/C 各 8 行）===');
    for (const [n, qs] of [['A', qsA], ['C', qsC]]) {
        try {
            const t = fs.readFileSync(path.join(qs, 'log.txt'), 'utf8');
            rec('-- ' + n + ' --');
            rec(t.split('\n').slice(-8).join('\n'));
        } catch (e) { }
    }
    rec('');
    rec('==============================================');
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    try { if (edgeProc) edgeProc.kill(); } catch (e) { }
    /* 只杀探针自己拉起来的 Edge / 记事本 —— 绝不让 taskkill /IM 这种
     * 按映像名通杀的写法把用户自己开着的 Edge / 记事本一起带走。
     * Edge 的判据：命令行里带本次的临时目录（--user-data-dir 在里面）。 */
    try {
        require('child_process').execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter '
            + "\"name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*qs-r28-*' } "
            + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
            { stdio: 'ignore', windowsHide: true });
    } catch (e) { }
    try { if (np && np.pid) process.kill(np.pid); } catch (e) { }
    // spawn 拿到的只是 Win11 的转发存根 pid，真正的记事本进程是 npPid ——
    // B 段中途失败（没走到 WM_CLOSE）时会漏一个记事本在桌上，这里兜底收掉。
    try { if (npPid) process.kill(npPid); } catch (e) { }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { }
    process.exit(failN ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(1);
});
