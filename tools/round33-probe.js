/* ============================================================================
 *  轮 33 专项探针：本轮四项修复（#152-#155）
 *    #152 选中文字弹横条稳定性：dt 门限 40→12ms / 选区落地稳定期 40ms /
 *         三重重试（backoff 220/380）/ BUSY 有界等待 1.2s（不再直接丢弃）
 *    #153 「更多引擎」→ 收藏夹 → 收起：回程走 togglePanel(true)，
 *         fav-mode 盒模型（absolute/内联宽高/engFilter 隐身/stage 撑高）全清
 *    #154 软件直达本地唤起链：协议(先查注册表预检 → weixin://…) →
 *         开始菜单 .lnk → 网页兜底
 *    #155 收藏面板行高压制：目录 margin 10/4→6/2、标题 5/6→3/4、条目 7→4
 *
 *  取证方式：隔离实例（独立 APPDATA + WebView2 + QS_INSTANCE_TAG）+ CDP
 *  驱动 UI；A 段另建一个 Win32 EDIT 窗口当"目标软件"，注入真实鼠标拖选
 *  （QS_ALLOW_INJECTED=1），以 QuickSearch 自己的日志为判据。
 *
 *  用法：node tools/round33-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round33-probe.txt');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

/* ------------------------------ Win32 声明 ------------------------------ */
const WNDPROC = koffi.proto('intptr __stdcall WNDPROC(void *hw, uint32 msg, uintptr wp, intptr lp)');
const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
    cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WNDPROC),
    cbClsExtra: 'int', cbWndExtra: 'int', hInstance: 'void *',
    hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
    lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'void *'
});
const MSG = koffi.struct('MSG', {
    hwnd: 'void *', message: 'uint32', _pad: 'uint32', wParam: 'uintptr', lParam: 'intptr',
    time: 'uint32', _pad2: 'uint32', pt_x: 'long', pt_y: 'long'
});
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const BringWindowToTop = user32.func('int BringWindowToTop(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, void *buf, int max)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, void *buf, int max)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const AttachThreadInput = user32.func('int AttachThreadInput(int idAttach, int idAttachTo, int f)');
const PeekMessageW = user32.func('int PeekMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b, uint32 r)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');
const SendMessageW = user32.func('intptr SendMessageW(void *h, uint32 m, uintptr w, intptr l)');
const SendMessageW_p = user32.func('intptr SendMessageW(void *h, uint32 m, void *w, void *l)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetClipboardSequenceNumber = user32.func('uint32 GetClipboardSequenceNumber()');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
const GetFocus = user32.func('void *GetFocus()');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS,
    Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)), 0, 0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const msg = {};
const pump = (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        let n = 0;
        while (n++ < 500 && PeekMessageW(msg, null, 0, 0, 1)) {
            TranslateMessage(msg);
            DispatchMessageW(msg);
        }
        sleep(15);
    }
};
const pumpMsg = () => {
    let n = 0;
    while (n++ < 500 && PeekMessageW(msg, null, 0, 0, 1)) {
        TranslateMessage(msg);
        DispatchMessageW(msg);
    }
};

const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function forceForeground(h) {
    const fg = GetForegroundWindow();
    if (String(fg) === String(h)) return true;
    const b1 = Buffer.alloc(4), b2 = Buffer.alloc(4);
    const tFg = GetWindowThreadProcessId(fg, b1);
    const tH = GetWindowThreadProcessId(h, b2);
    const attached = tFg && tH && tFg !== tH ? AttachThreadInput(tFg, tH, 1) : 0;
    const ok = !!SetForegroundWindow(h);
    if (attached) AttachThreadInput(tFg, tH, 0);
    return ok;
}

/* ------------------------------ 目标软件窗口 ------------------------------ */
/* 仿 verify-trigger.js：自建一个带 EDIT 的窗口当"前台软件"。
 * 文字分两行：第一行是被选目标，最后留一段空白区做"拖动但无选区"。
 *
 * ⚠ 窗口必须摆在 y≥480：隔离实例一启动就会在默认位置弹出横条
 *   （实测 (138,324)-(824,456)）， EDIT 放在它下面会被遮住 —— A 段划选的
 *   mousedown 落在横条上，被 is_bar_inner 吃掉，整段测试会静默失效
 *   （轮 33 首跑踩过：4 次划选全部 from=None）。 */
const EDIT_TEXT = 'Quick Search 选中即弹出横条：这是一段用来验证取词稳定性的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const clsName = 'QSR33Target';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: clsName, hIconSm: null
});
const PW = 760, PH = 300, PX = 120, PY = 480;
const parent = CreateWindowExW(0, clsName, 'R33 目标软件', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
const EH = 120;
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    10, 10, PW - 20, EH, parent, null, inst, null);
SetWindowTextW(edit, EDIT_TEXT);
ShowWindow(parent, 5);
SetWindowPos(parent, -1 /* HWND_TOPMOST */, PX, PY, PW, PH, 0x0040);
sleep(300); pump(300);
const c2s = (h, p) => { ClientToScreen(h, p); return p; };
const editPts = () => ({
    // 文字第一段起点与中点（行内 y 取 EDIT 上半部）
    a: c2s(edit, { x: 12, y: 16 }),
    b: c2s(edit, { x: 330, y: 16 }),
    // 第二段（靠后一点，第二次划选用）
    c: c2s(edit, { x: 360, y: 16 }),
    d: c2s(edit, { x: 640, y: 16 }),
});
const EP = editPts();
const blankPts = () => ({
    // EDIT 下方空白带：父窗口客户区里没有任何控件
    a: c2s(parent, { x: 60, y: EH + 60 }),
    b: c2s(parent, { x: 420, y: EH + 60 }),
});
const BP = blankPts();

/* ------------------------------ 输入原语 ------------------------------ */
/** 抢前台：置顶 + 在客户区空白带注入一次真实点击（系统认它是用户输入）。
 *  点必须落在父窗口客户区空白处 —— 点 EDIT 会改选区/光标，点标题栏会拖窗。 */
function activate() {
    SetWindowPos(parent, -1, PX, PY, PW, PH, 0x0040);
    sleep(150); pumpMsg();
    for (let i = 0; i < 5; i++) {
        if (String(GetForegroundWindow()) === String(parent)) return true;
        const r = {}; GetWindowRect(parent, r);
        moveTo(r.left + 24, r.bottom - 14);
        sleep(140);
        mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(60);
        mouse_event(LEFT_UP, 0, 0, 0, 0);
        sleep(420); pumpMsg();
    }
    return String(GetForegroundWindow()) === String(parent);
}
/** 一次划选。steps/moveMs/gapMs 控制"手感"：
 *  fast  = 全程 <40ms（复现旧 dt>=40 门限漏掉的快速划选）
 *  normal= 常规速度
 *  返回值 = 从 mousedown 到 mouseup 的实际耗时（ms）。 */
function drag(from, to, steps, moveMs, gapMs) {
    moveTo(from.x + 3, from.y); sleep(120); pumpMsg();
    const t0 = Date.now();   // 从 mousedown 起算，和钩子的 Ev::Down→Ev::Up 同口径
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(4);
    for (let i = 1; i <= steps; i++) {
        moveTo(Math.round(from.x + (to.x - from.x) * i / steps), from.y);
        sleep(moveMs); pumpMsg();
    }
    sleep(gapMs || 0); pumpMsg();
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    const dt = Date.now() - t0;
    pumpMsg();
    return dt;
}

/** 一次「快速划选」（flick）：一步跳到终点 + 自旋等到 ~24ms 再松手。
 *  两个坑：
 *   ① Atomics.wait 本机粒度 ~15.6ms 且不稳，逐步 sleep 的 drag() 最快要
 *      ~60ms，压不进「旧 40ms 门限漏掉、新 12ms 门限收录」的 [12,40) 窗口；
 *   ② 不能带 --bar 启动：那个参数会让实例在启动 1.5s 后按**当时光标位置**
 *      自动弹条（轮 33 首跑踩过：横条压在目标窗口上、还打乱前台，
 *      之后的 Ctrl+C 全发去别的窗口，整段 A 段静默失效）。 */
function dragFlick(from, to) {
    moveTo(from.x, from.y); sleep(140); pumpMsg();
    const t0 = Date.now();
    mouse_event(LEFT_DOWN, 0, 0, 0, 0);
    moveTo(to.x, to.y);
    while (Date.now() - t0 < 24) { }   // 自旋到 ~24ms，落进 [12,40)
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    const dt = Date.now() - t0;
    pumpMsg();
    return dt;
}

/* ---- A 段取证加强：EDIT 选区 / 剪贴板序号时间线 / 焦点窗口 ----
 * changed=false 的根因排查用：一次划选后立刻量 EM_GETSEL（有没有真选中）、
 * 量焦点窗口（Ctrl+C 到底送给谁），再每 4ms 采一次剪贴板序号，
 * 事后和实例日志按同一时钟（SystemTime intervals）叠着看。 */
const editSel = () => {
    const a = Buffer.alloc(4), b = Buffer.alloc(4);
    SendMessageW_p(edit, 0x00B0 /* EM_GETSEL */, a, b);
    return { start: a.readUInt32LE(0), end: b.readUInt32LE(0) };
};
const focusHwnd = () => {
    const pid = Buffer.alloc(4);
    const fgTid = GetWindowThreadProcessId(GetForegroundWindow(), pid);
    const me = GetCurrentThreadId();
    const att = fgTid && fgTid !== me ? AttachThreadInput(me, fgTid, 1) : 0;
    const h = GetFocus();
    if (att) AttachThreadInput(me, fgTid, 0);
    return { fg: GetForegroundWindow(), focus: h };
};
const seqNow = () => GetClipboardSequenceNumber();
function seqTrace(ms) {
    const out = [];
    const t0 = Date.now();
    let last = seqNow();
    out.push({ t: t0, seq: last });
    while (Date.now() - t0 < ms) {
        pumpMsg();
        const s = seqNow();
        const now = Date.now();
        if (s !== last) { out.push({ t: now, seq: s, prev: last }); last = s; }
    }
    return out;
}
/** 一次带取证的划选：跑完 drag 后采样 2600ms（覆盖取词三段重试全程）。
 *  返回 { dt, sel, focus, trace, tDrag }。 */
function dragWithTrace(from, to, ms) {
    const tDrag = Date.now() + 0;
    const dt = dragFlick(from, to);
    const sel = editSel();
    const focus = focusHwnd();
    const trace = seqTrace(ms || 2600);
    return { dt, sel, focus, trace, tDrag };
}
const fmtTrace = (r) => {
    const lines = [];
    for (const p of r.trace) {
        lines.push(`      t+${String(p.t - r.tDrag).padStart(5)}ms  seq ${p.prev !== undefined ? p.prev + '→' : ''}${p.seq}`);
    }
    return lines;
};
/** 焦点时间线：A3b（BUSY 重叠）专用。每 ~30ms 采一次焦点/前台/序号，
 *  只记变化点。用 AttachThreadInput+GetFocus 读别的线程的焦点窗口。 */
function focusTrace(ms) {
    const out = [];
    const t0 = Date.now();
    let last = null, lastSeq = seqNow();
    out.push({ t: t0, f: 'init', seq: lastSeq });
    while (Date.now() - t0 < ms) {
        pumpMsg();
        const fc = focusHwnd();
        const key = String(fc.focus) + '/' + String(fc.fg);
        const s = seqNow();
        const now = Date.now();
        if (key !== last || s !== lastSeq) {
            out.push({ t: now, f: key, seq: s, prevSeq: s !== lastSeq ? lastSeq : undefined, prevF: key !== last ? last : undefined });
            last = key; lastSeq = s;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    return out;
}

/* ------------------------------ CDP ------------------------------ */
let PORT = 9411;
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
async function shot(ws, name, box) {
    try {
        const params = { format: 'png', captureBeyondViewport: true };
        if (box) params.clip = Object.assign({ scale: 1 }, box);
        const r = await cdp(ws, 'Page.captureScreenshot', params);
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

const instances = [];

/* ------------------------------ 实例工厂 ------------------------------ */
function makeConf(dir, extra) {
    const qs = path.join(dir, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const c = Object.assign({
        trigger_copy: false, trigger_select: true, ocr_enable: false,
        auto_color: false, auto_start: false, delay_ms: 0,
        filter_mode: 'off', filter_list: [],
        webdav_url: '', webdav_user: '', webdav_pass: '',
        webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
        backup_dir: '', overrides: {}, fav_hotkey: '',
        custom_engines: [],
        bar_glass: false,
        bar_dim_alpha: 100,
        theme: 'light',
        fav_panel_sizes: {},
    }, extra || {});
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    return qs;
}
function spawnInstance(qs, port, tag) {
    PORT = port;
    const appData = path.dirname(qs);
    const env = Object.assign({}, process.env, {
        APPDATA: appData, LOCALAPPDATA: appData,
        WEBVIEW2_USER_DATA_FOLDER: path.join(path.dirname(appData), 'wv2-' + tag),
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: tag,
        QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
            + ' --disable-gpu-sandbox --remote-debugging-port=' + port,
    });
    // 不能带 --bar：那个参数会让实例启动 1.5s 后按当时光标位置自动弹条，
    // 横条压在目标窗口上还会打乱前台，之后注入的 Ctrl+C 全发去别的窗口
    // （轮 33 首跑实证：A 段 3 次划选 changed=false 全线静默失效）。
    const p = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    instances.push(p);
    rec('启动实例 pid=' + p.pid + '（CDP ' + port + '，tag=' + tag + '）');
    return p;
}
function killInstance() {
    for (const p of instances) { try { p.kill(); } catch (e) { } }
}
/* 实例日志：QS_DEBUG=1 时写在 <APPDATA>\QuickSearch\log.txt */
const logOf = (qs) => path.join(qs, 'log.txt');
let logOffset = 0;
function logMark(qs) {
    try { logOffset = fs.statSync(logOf(qs)).size; } catch (e) { logOffset = 0; }
}
function logSince() {
    try { return fs.readFileSync(logOf(qsLive)).slice(logOffset).toString('utf8'); }
    catch (e) { return ''; }
}
function lastShowBarTexts(s) {
    const all = s.match(/show_bar: "([^"]*)"/g) || [];
    return all.map((x) => x.replace(/^show_bar: "/, '').replace(/"$/, ''));
}

/* ------------------------------ PNG 生成（图片收藏条目用） ------------------------------ */
const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(b) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
/** 一张 w×h 的纯色 PNG（真彩色、filter 0、zlib），返回 dataURL */
function tinyPng(w, h, rgb) {
    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let y = 0; y < h; y++) {
        const o = y * (1 + w * 3);
        for (let x = 0; x < w; x++) {
            raw[o + 1 + x * 3] = rgb[0];
            raw[o + 2 + x * 3] = rgb[1];
            raw[o + 3 + x * 3] = rgb[2];
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
        return Buffer.concat([len, td, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;   // 8bit 真彩色
    return 'data:image/png;base64,' + Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
}

/* ------------------------------ 日志轮询 ------------------------------ */
async function waitLog(pred, ms) {
    /* ⚠ 必须持续 pumpMsg。目标 EDIT 的消息循环就是**本线程**（窗口在这建），
     * QuickSearch 注入的 WM_KEYDOWN 排在队列里等派发 —— 纯睡（Atomics.wait）
     * 不 pump 的话 EDIT 永远收不到 Ctrl+C，产品侧表现为三轮 changed=false
     * （轮 33 连续四跑 A1/A2/B0 全挂的根因，一度被误判为产品 bug）。
     * 判据：app 日志里 kbd 与序号变化的间隔远超正常 ~12ms。 */
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 4000)) {
        pumpMsg();
        const s = logSince();
        if (pred(s)) return s;
        await sleep(150);
        pumpMsg();
    }
    return logSince();
}
/** 带 pump 的等待：给"A 段取词沉降后再进下一段"这类空档用。 */
async function sleepPump(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { pumpMsg(); await sleep(60); }
}
const countOf = (s, re) => (s.match(re) || []).length;

/* ------------------------------ 主流程 ------------------------------ */
let qsLive = null;   // 当前隔离实例的配置目录（logSince 读它）

async function main() {
    /* ============ 准备：一个隔离实例贯穿 A-E ============ */
    const dir = path.join(os.tmpdir(), 'qs-r33');
    fs.rmSync(dir, { recursive: true, force: true });
    const qs = makeConf(dir, {
        anchor_at_mouse: false,
        favorites: [
            { id: 'r33a', name: '轮33目录甲', items: [
                { id: 'r33i1', kind: 'text', text: '第一条收藏：选中即弹回归文本' },
                { id: 'r33i2', kind: 'image', image: tinyPng(120, 60, [198, 44, 44]), text: '' },
            ] },
            { id: 'r33b', name: '轮33目录乙', children: [
                { id: 'r33b1', name: '二级目录', items: [
                    { id: 'r33i3', kind: 'text', text: '二级目录里的收藏文本' },
                ] },
            ] },
        ],
    });
    qsLive = qs;
    spawnInstance(qs, 9411, 'r33');
    const ws = await connectWhere(isBarPage, 40000);
    chk('0 隔离实例启动并连上横条页', !!ws);
    if (!ws) { flush(); killInstance(); return; }
    chk('0 横条页 invoke/listen 就绪', await waitInvoke(ws, 30000));
    await sleep(800);

    /* ================= A 段：#152 选中弹横条稳定性 ================= */
    rec('');
    rec('========== A 段：#152 选中文字弹横条稳定性 ==========');
    /* ⚠ 计数只认 `show_bar: "`（带引号的那一行）。一次弹条会打 5 种日志
     * （"" / atMouse= / 触发现场 / 耗时 / 前置合计），拿 /show_bar:/ 计数
     * 会把一次弹条算成 5 次，判定全程失真（轮 33 第二跑踩过）。 */
    const SHOW = /show_bar: "/g;
    const hasShow = (t) => /show_bar: "/.test(t);
    chk('A0 目标软件抢到前台', activate());
    await sleep(200);

    // A1 快速划选：dt 落在 [12,40)ms（旧 dt>=40 门限必漏的那一类）
    logMark(qs);
    const r1 = dragWithTrace(EP.a, EP.b, 2600);
    const dt1 = r1.dt;
    let s = await waitLog((t) => hasShow(t), 5000);
    const hookDt1 = (s.match(/up-check: dt=(\d+)/) || [])[1];
    info('A1 快速划选 dt=' + dt1 + 'ms（钩子侧 ' + (hookDt1 || '?') + 'ms）',
        '旧门限 40ms 会漏、新门限 12ms 收录');
    rec('    [取证] A1 选区[' + r1.sel.start + ',' + r1.sel.end + '] 焦点=' + String(r1.focus.focus) + ' 前台=' + String(r1.focus.fg));
    for (const ln of fmtTrace(r1)) rec(ln);
    chk('A1 快速划选也弹横条', hasShow(s), 'dt=' + dt1 + 'ms');
    /* r34 起取词主链换成「不碰剪贴板」的无剪贴板链（edit/UIA/OCR 三通道），
     * 没有 round 重试概念了 —— 成功日志是 start_capture: <通道> 通道拿到 N chars。 */
    chk('A1 取词成功（三通道之一拿到字）', /start_capture: (编辑控件|UIA|OCR) 通道拿到/.test(s),
        'start_capture 行=' + (s.match(/start_capture: [^\n]*/) || ['?'])[0]);

    // A2 常规速度回归
    chk('A2 前重新抢前台', activate());
    logMark(qs);
    const tA2 = Date.now();
    const dt2 = drag(EP.c, EP.d, 8, 18, 6);
    const r2 = { sel: editSel(), focus: focusHwnd(), trace: seqTrace(2600), tDrag: tA2 };
    s = await waitLog((t) => hasShow(t), 5000);
    info('A2 常规速度划选 dt=' + dt2 + 'ms');
    rec('    [取证] A2 选区[' + r2.sel.start + ',' + r2.sel.end + '] 焦点=' + String(r2.focus.focus) + ' 前台=' + String(r2.focus.fg));
    for (const ln of fmtTrace(r2)) rec(ln);
    chk('A2 常规速度划选回归', hasShow(s), 'dt=' + dt2 + 'ms');

    // A3 BUSY 重叠：两次快速划选背靠背（mouseup 间隔仅一个划选的耗时）
    chk('A3 前重新抢前台', activate());
    logMark(qs);
    const tA3 = Date.now();
    const dta = dragFlick(EP.a, EP.b);
    dragFlick(EP.c, EP.d);
    const selA3 = editSel();
    const focA3 = focusHwnd();
    /* 两次划选完立刻起焦点/序号时间线，覆盖 A3b 的 BUSY 等待 + 三段取词全程 */
    const ft = focusTrace(2600);
    s = await waitLog((t) => countOf(t, SHOW) >= 2, 8000);
    const n3 = countOf(s, SHOW);
    rec('    [取证] A3a 后选区[' + selA3.start + ',' + selA3.end + '] 焦点=' + String(focA3.focus) + ' 前台=' + String(focA3.fg));
    rec('    [取证] A3 焦点/序号时间线（焦点/前台 + seq，相对 A3a mousedown）：');
    for (const p of ft) {
        rec(`      t+${String(p.t - tA3).padStart(5)}ms  焦点/前台=${p.f}${p.prevF !== undefined ? '（原 ' + p.prevF + '）' : ''}  seq ${p.prevSeq !== undefined ? p.prevSeq + '→' : ''}${p.seq}`);
    }
    chk('A3 连续两次快速划选都弹条（BUSY 有界等待不丢弃）', n3 >= 2,
        'show_bar=' + n3 + ' 首dt=' + dta + 'ms');
    /* 新口径：两次划选各自都有一条「通道拿到」的完成日志 */
    chk('A3 两次取词都完成', countOf(s, /start_capture: (编辑控件|UIA|OCR) 通道拿到/g) >= 2,
        '完成次数=' + countOf(s, /start_capture: (编辑控件|UIA|OCR) 通道拿到/g));
    /* 等第二次取词/弹条彻底落盘再进 A4 —— A3 的 waitLog 可能在第 2 次
     * show 出现前就返回，那之前 logMark(A4) 会把第二次弹条算进 A4 账上。 */
    await sleepPump(1200);

    // A4 空白区拖动（无选区）：不弹条，且完整走完三通道都取不到（r34 新口径）
    chk('A4 前重新抢前台', activate());
    logMark(qs);
    const dt4 = drag(BP.a, BP.b, 4, 12, 4);
    /* ⚠ 等足 4500ms，不是 2800ms。
     *
     * 这个窗口不是随便定的：本探针的目标窗（QSR33Target）**没有 UIA 文本模式
     * 而且 UIA 查询会挂到超时**，所以这一次取词最坏要跑：
     *   稳定期 ~90ms + UIA 第 1 次**超时 2500ms** + UIA 第 2 次 464ms + OCR ~120ms
     *   ≈ 3.2s。
     *
     * r36 之前这里写 2800ms 也能过，但那是**靠一个 bug 蒙对的**：当时
     * `uia_selection_text` 只要 `out.is_none()` 就把该进程拉进「没有文本模式」
     * 负缓存（超时也算），于是第 2 次 UIA 被直接跳过，总耗时被压到 ~2.7s。
     * r36 把负缓存修成「只有真的没找到 TextPattern 才拉黑」之后，第 2 次 UIA
     * 会真的跑（并因此正确地把该进程判定为 NoPattern、后续不再白等）——
     * 这是**变对了**，但总耗时回到真实的 ~3.2s。
     * 所以这里放宽到 4500ms：断言的是"三通道都取不到"，不该被探针自己的
     * 等待窗口卡住。 */
    await sleep(4500);   // 三通道最坏 ~3.2s（稳定期 + UIA 超时 + UIA 重试 + OCR），等足再看日志
    s = logSince();
    const n4 = countOf(s, SHOW);
    const miss = countOf(s, /start_capture: 没拿到文字/g);
    chk('A4 空白区拖动不弹条', n4 === 0, 'dt=' + dt4 + 'ms show_bar=' + n4);
    chk('A4 无选区时三通道都取不到（没拿到文字）', miss >= 1, '没拿到次数=' + miss);

    /* ================= B 段：#153 收藏目录收起布局 ================= */
    rec('');
    rec('========== B 段：#153 更多引擎→收藏夹→收起 布局回归 ==========');
    /* B0：先来一次真实划选把横条唤出。show_bar 不是对前端开放的 command
     * （只在 invoke_handler 之外给 Rust 内部用），走自然路径最稳，
     * 顺带再验一次 A 段链路。 */
    chk('B0 目标软件抢回前台', activate());
    logMark(qs);
    const rB0 = dragWithTrace(EP.a, EP.b, 2600);
    let sb = await waitLog((t) => hasShow(t), 6000);
    rec('    [取证] B0 选区[' + rB0.sel.start + ',' + rB0.sel.end + '] 焦点=' + String(rB0.focus.focus) + ' 前台=' + String(rB0.focus.fg));
    for (const ln of fmtTrace(rB0)) rec(ln);
    chk('B0 真实划选唤出横条', hasShow(sb));
    await sleep(400);
    await evalJs(ws, "document.querySelector('#btnMore').click()");
    await sleep(600);
    chk('B1 引擎面板打开', await evalJs(ws, "!document.querySelector('#panel').hidden"));
    chk('B2 面板里有收藏夹入口', await evalJs(ws, "!!document.querySelector('.fav-entry')"));
    await evalJs(ws, "document.querySelector('.fav-entry').click()");
    await sleep(700);
    chk('B3 点入口进入收藏面板（fav-mode 挂上）',
        await evalJs(ws, "document.querySelector('#panel').classList.contains('fav-mode')"));
    await evalJs(ws, "document.querySelector('#btnPanelClose').click()");
    await sleep(700);
    const after = await evalJs(ws, `(() => {
        const p = document.querySelector('#panel');
        const st = document.querySelector('#stage');
        const f = document.querySelector('#engFilter');
        const cs = getComputedStyle(f);
        const cells = [...document.querySelectorAll('#panel .cell')];
        return {
            hidden: p.hidden,
            favMode: p.classList.contains('fav-mode'),
            pos: getComputedStyle(p).position,
            ovf: getComputedStyle(p).overflowY,
            w: p.style.getPropertyValue('width'), h: p.style.getPropertyValue('height'),
            l: p.style.getPropertyValue('left'), t: p.style.getPropertyValue('top'),
            mw: st.style.getPropertyValue('min-width'), mh: st.style.getPropertyValue('min-height'),
            pl: st.style.getPropertyValue('padding-left'), pt: st.style.getPropertyValue('padding-top'),
            filterDisplay: cs.display, filterVisible: !!f.offsetParent,
            cellN: cells.length,
            sticky: !!document.querySelector('#panel .panel-sticky'),
        };
    })()`);
    chk('B4 收起后仍停在引擎面板（不关窗）', !after.hidden, 'hidden=' + after.hidden);
    chk('B5 fav-mode 类已摘除', !after.favMode);
    chk('B6 面板定位回退（非 absolute）', after.pos !== 'absolute', 'position=' + after.pos);
    chk('B7 纵向溢出可滚（非 hidden，内容不再被裁死）', after.ovf !== 'hidden', 'overflowY=' + after.ovf);
    chk('B8 面板无残留内联宽高/偏移',
        !after.w && !after.h && !after.l && !after.t,
        'w=' + (after.w || '-') + ' h=' + (after.h || '-') + ' l=' + (after.l || '-') + ' t=' + (after.t || '-'));
    chk('B9 stage 无残留 min-width/min-height/padding',
        !after.mw && !after.mh && !after.pl && !after.pt,
        'mw=' + (after.mw || '-') + ' mh=' + (after.mh || '-') + ' pl=' + (after.pl || '-') + ' pt=' + (after.pt || '-'));
    chk('B10 搜索框恢复可见', after.filterDisplay !== 'none' && after.filterVisible,
        'display=' + after.filterDisplay + ' offsetParent=' + after.filterVisible);
    chk('B11 引擎格子完整渲染', after.cellN > 20 && after.sticky,
        'cells=' + after.cellN + ' sticky=' + after.sticky);
    await shot(ws, 'r33-b-engines-panel.png');

    /* ================= D 段：#155 收藏行高压制 ================= */
    rec('');
    rec('========== D 段：#155 收藏面板行高压制 ==========');
    await evalJs(ws, "document.querySelector('.fav-entry').click()");
    await sleep(700);
    const m = await evalJs(ws, `(() => {
        const q = (s) => document.querySelector(s);
        const rows = [...document.querySelectorAll('.fav-item')].map((e) => +e.getBoundingClientRect().height.toFixed(1));
        const item = q('.fav-item'), grp = q('.fav-grp'), head = q('.fav-head');
        const img = q('.fav-item .fav-main img');
        const ics = item ? getComputedStyle(item) : null;
        return {
            rowN: rows.length, rows,
            maxRow: rows.length ? Math.max.apply(null, rows) : -1,
            minRow: rows.length ? Math.min.apply(null, rows) : -1,
            padT: ics ? ics.paddingTop : '', padB: ics ? ics.paddingBottom : '',
            grpMT: grp ? getComputedStyle(grp).marginTop : '',
            grpMB: grp ? getComputedStyle(grp).marginBottom : '',
            headPT: head ? getComputedStyle(head).paddingTop : '',
            imgH: img ? +img.getBoundingClientRect().height.toFixed(1) : -1,
        };
    })()`);
    info('D 量到的行高集合', JSON.stringify(m.rows) + '（文字行/图片行）');
    chk('D1 文字条目行高 ≤27px（旧 ~31.5）', m.minRow > 0 && m.minRow <= 27, 'minRow=' + m.minRow);
    chk('D2 图片条目行高 ≤35px（旧能顶 44+）', m.maxRow > 0 && m.maxRow <= 35, 'maxRow=' + m.maxRow + ' imgH=' + m.imgH);
    chk('D3 条目上下 padding 4px', m.padT === '4px' && m.padB === '4px', 'pad=' + m.padT + '/' + m.padB);
    chk('D4 目录块 margin 6px/2px', m.grpMT === '6px' && m.grpMB === '2px', 'margin=' + m.grpMT + '/' + m.grpMB);
    chk('D5 面板标题行 padding-top 2px', m.headPT === '2px', 'padTop=' + m.headPT);
    await shot(ws, 'r33-d-fav-panel.png');
    /* 单目录视图（从一个收藏夹入口点进来）按设计**没有**目录标题头 ——
     * 名字在面板标题上（见 renderFavPanel 的 groupCard(named=false)）。
     * 目录标题行/二级目录的压缩要看有标题头的视图：收起回引擎面板，
     * 再进含二级目录的「轮33目录乙」。 */
    await evalJs(ws, "document.querySelector('#btnPanelClose').click()");
    await sleep(700);
    await evalJs(ws, "[...document.querySelectorAll('.fav-entry')][1].click()");
    await sleep(700);
    const m2 = await evalJs(ws, `(() => {
        const h = document.querySelector('.fav-grp-head');
        const lv2 = document.querySelector('.fav-grp.lv2');
        return {
            hasHead: !!h, hasLv2: !!lv2,
            headPT: h ? getComputedStyle(h).paddingTop : '',
            headPB: h ? getComputedStyle(h).paddingBottom : '',
            lv2MT: lv2 ? getComputedStyle(lv2).marginTop : '',
        };
    })()`);
    chk('D6 二级目录卡带标题头（有标题头的目录才可折叠）', m2.hasHead && m2.hasLv2);
    chk('D7 目录标题行 padding 2px/3px（旧 5px/6px）',
        m2.headPT === '2px' && m2.headPB === '3px', 'pad=' + m2.headPT + '/' + m2.headPB);
    chk('D8 二级目录 margin-top 4px（旧 6px）', m2.lv2MT === '4px', 'marginTop=' + m2.lv2MT);
    await shot(ws, 'r33-d-fav-lv2.png');

    /* ================= E 段：#156 帮助/关于文案 ================= */
    rec('');
    rec('========== E 段：#156 关于与帮助文案 ==========');
    try {
        await evalJs(ws, "invoke('open_settings', { focusEngine: null, tab: 'help' }).then(() => 'ok')");
    } catch (e) { rec('  WARN  open_settings 异常 → ' + e.message); }
    const wsS = await connectWhere(isSettingsPage, 25000);
    chk('E1 设置窗打开并连上', !!wsS);
    if (wsS) {
        chk('E2 设置页 invoke 就绪', await waitInvoke(wsS, 20000));
        await sleep(600);
        const txt = await evalJs(wsS, 'document.body.textContent');
        chk('E3 触发开关说明含稳定期/重试文案',
            txt.includes('内部会等选区落地、失败自动重试，快速划选也稳'));
        chk('E4 帮助①含「等选区落地 + 自动重试两次」',
            txt.includes('复制没成功再自动重试两次'));
        chk('E5 帮助③含「软件直达 = 先开本机软件」条目',
            txt.includes('软件直达 = 先开本机软件'));
        chk('E6 帮助③含协议→开始菜单→网页兜底说明',
            txt.includes('都没装才退回网页打开'));
    }

    /* ================= C 段：#154 软件直达本地唤起链 ================= */
    rec('');
    rec('========== C 段：#154 软件直达本地唤起链 ==========');
    rec('（注意：本段会真实唤起本机软件 / 打开一次浏览器，属预期取证行为）');
    const cases = [
        { engine: '微信（首页）', ok: /appchain: 协议唤起成功/, what: '协议 weixin:// 命中' },
        { engine: 'QQ（首页）', ok: /appchain: 开始菜单唤起成功/, what: '开始菜单 QQ.lnk 命中' },
        { engine: '钉钉（首页）', ok: /本地唤起链全部失败，回落网页/, what: '未安装 → 回落网页（零回归）' },
    ];
    for (const c of cases) {
        logMark(qs);
        await evalJs(ws, "invoke('open_search', " + JSON.stringify({ engine: c.engine, text: null }) + ").then(() => 'ok')");
        const s2 = await waitLog((t) => c.ok.test(t), 9000);
        const tail = s2.trim().split('\n').filter((l) => /appchain|open_search/.test(l)).slice(-3).join(' | ');
        chk('C ' + c.engine + ' → ' + c.what, c.ok.test(s2), tail || '(无匹配日志)');
        await sleep(1500);
    }

    /* ============ 收尾 ============ */
    rec('');
    rec('========== 汇总：PASS ' + passN + ' / FAIL ' + failN + ' / SKIP ' + skipN + ' ==========');
    flush();
    killInstance();
}

main().catch((e) => {
    rec('PROBE ERROR ' + ((e && e.stack) || e));
    flush();
    killInstance();
});
