/* ============================================================================
 *  轮 33 诊断：A 段 changed=false 根因隔离（不启动 QuickSearch）
 *
 *  现象：round33-probe A 段里，同一坐标同一手法的 flick 划选，A3a 成功
 *        （changed=true / 24 chars），A1/A2/A3b/B0 三次 round 全部
 *        changed=false —— Ctrl+C 发了 1.85s，剪贴板序号一次都没变。
 *        而 wait_until / send_ctrl_c / capture_selection 的计时经逐行核对
 *        全部符合设计（40ms 稳定期 + 460ms 等待 + 220/380 退避）。
 *
 *  本脚本把链路切成两半单独跑：目标窗 + 划选 + 焦点/选区/剪贴板量化。
 *  每轮记录：
 *    ① 前台窗口 / 前台线程的 hwndFocus / hwndActive / hwndCaret
 *    ② EDIT 的 EM_GETSEL（选区起止，start==end 即没选中）
 *    ③ Ctrl+C 前后的 GetClipboardSequenceNumber
 *    ④ 额外对照：不重新划选、原地再复制一次相同选区 —— 序号是否仍变
 *       （验证「内容相同序号不变」这个假设）
 *
 *  判读：
 *    - 选区稳定有值 + 焦点在 EDIT + 序号随复制变化  → QuickSearch 侧问题
 *    - 选区时有时无                          → 探针划选本身不稳（环境/注入）
 *    - 选区稳定但序号不变                    → EDIT 没焦点或复制目标错窗口
 *
 *  用法：node tools/round33-diag.js   （确认 QuickSearch 已退出）
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OUT = path.join(__dirname, 'round33-diag.txt');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');
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
const GTI = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint32', flags: 'uint32',
    hwndActive: 'void*', hwndFocus: 'void*', hwndCapture: 'void*',
    hwndMenuOwner: 'void*', hwndMoveSize: 'void*', hwndCaret: 'void*',
    rcCaret: RECT,
});
const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const GetGUIThreadInfo = user32.func('int GetGUIThreadInfo(uint32 tid, _Out_ GUITHREADINFO *g)');
const PeekMessageW = user32.func('int PeekMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b, uint32 r)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');
const SendMessageW = user32.func('intptr SendMessageW(void *h, uint32 m, uintptr w, intptr l)');
const SendMessageW_p = user32.func('intptr SendMessageW(void *h, uint32 m, void *w, void *l)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const OpenClipboard = user32.func('int OpenClipboard(void *h)');
const CloseClipboard = user32.func('int CloseClipboard()');
const GetClipboardSequenceNumber = user32.func('uint32 GetClipboardSequenceNumber()');
const GetClassNameW = user32.func('int GetClassNameW(void *h, void *buf, int max)');
const GetLastError = kernel32.func('uint32 GetLastError()');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS,
    Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)), 0, 0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const msg = {};
const pumpMsg = () => {
    let n = 0;
    while (n++ < 500 && PeekMessageW(msg, null, 0, 0, 1)) {
        TranslateMessage(msg); DispatchMessageW(msg);
    }
};
const pump = (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { pumpMsg(); sleep(15); }
};

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

const clsOf = (h) => {
    const b = new Uint16Array(64); const n = GetClassNameW(h, b, 64);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    return s || '(null)';
};

/* ---- 键盘注入（复刻 QuickSearch send_ctrl_c 的节奏） ---- */
const KEYUP = 0x0002;
function kbRaw(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);            // INPUT_KEYBOARD
    b.writeUInt16LE(vk, 8);           // wVk
    b.writeUInt16LE(0, 10);           // wScan
    b.writeUInt32LE(up ? KEYUP : 0, 12);
    b.writeUInt32LE(0, 16);
    return b;
}
function sendCtrlC() {
    SendInput(2, Buffer.concat([kbRaw(0x11, false), kbRaw(0x43, false)]), 40);
    sleep(12);
    SendInput(2, Buffer.concat([kbRaw(0x43, true), kbRaw(0x11, true)]), 40);
}

/* ---- 焦点 / 选区 / 剪贴板序号 ---- */
function fgFocus() {
    const fg = GetForegroundWindow();
    const pid = Buffer.alloc(4);
    const tid = GetWindowThreadProcessId(fg, pid);
    const g = { cbSize: koffi.sizeof(GTI) };
    if (!GetGUIThreadInfo(tid, g)) {
        rec('  [diag] GetGUIThreadInfo 失败 tid=' + tid + ' err=' + GetLastError() + ' sizeof(GTI)=' + koffi.sizeof(GTI));
        return { fg, ok: false };
    }
    return { fg, ok: true, active: g.hwndActive, focus: g.hwndFocus, caret: g.hwndCaret };
}
function getSel(edit) {
    const a = Buffer.alloc(4), b = Buffer.alloc(4);
    const r = SendMessageW_p(edit, 0x00B0 /* EM_GETSEL */, a, b);
    return { start: a.readUInt32LE(0), end: b.readUInt32LE(0), ret: Number(r) };
}
const seq = () => GetClipboardSequenceNumber();

/* ------------------------------ 目标软件窗口 ------------------------------ */
const EDIT_TEXT = 'Quick Search 选中即弹出横条：这是一段用来验证取词稳定性的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const clsName = 'QSR33Diag';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: clsName, hIconSm: null
});
const PW = 760, PH = 300, PX = 120, PY = 480;
const parent = CreateWindowExW(0, clsName, 'R33 诊断目标', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
const EH = 120;
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    10, 10, PW - 20, EH, parent, null, inst, null);
SetWindowTextW(edit, EDIT_TEXT);
ShowWindow(parent, 5);
SetWindowPos(parent, -1, PX, PY, PW, PH, 0x0040);
sleep(300); pump(300);
const c2s = (h, p) => { ClientToScreen(h, p); return p; };
const EP = {
    a: c2s(edit, { x: 12, y: 16 }),
    b: c2s(edit, { x: 330, y: 16 }),
    c: c2s(edit, { x: 360, y: 16 }),
    d: c2s(edit, { x: 640, y: 16 }),
};

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

/** 和 round33-probe.js 的 dragFlick 完全一致 */
function dragFlick(from, to) {
    moveTo(from.x, from.y); sleep(140); pumpMsg();
    const t0 = Date.now();
    mouse_event(LEFT_DOWN, 0, 0, 0, 0);
    moveTo(to.x, to.y);
    while (Date.now() - t0 < 24) { }
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    const dt = Date.now() - t0;
    pumpMsg();
    return dt;
}

/* ================================ 主流程 ================================ */
const WITH_QS = process.argv.includes('--with-qs');
const SELPROBE = process.argv.includes('--selprobe');
const ISTAG = '-diag-r33';
const exeDir = path.join(__dirname, '..');
const EXE = path.join(exeDir, 'target', 'release', 'QuickSearch.exe');
const tempBase = path.join(os.tmpdir(), 'qs-diag');
fs.rmSync(tempBase, { recursive: true, force: true });
const qs = path.join(tempBase, 'QuickSearch');
fs.mkdirSync(qs, { recursive: true });
fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
    trigger_copy: false, trigger_select: true, ocr_enable: false,
    auto_color: false, auto_start: false, delay_ms: 0,
    filter_mode: 'off', filter_list: [], bar_glass: false,
    bar_dim_alpha: 100, theme: 'light', fav_panel_sizes: {},
}, null, 1), 'utf8');
const LOG = path.join(qs, 'log.txt');

rec('=== 轮33 A段 changed=false 根因诊断' + (WITH_QS ? '（带 QuickSearch）' : (SELPROBE ? '（选区派发时序）' : '（无 QuickSearch）')) + ' ===');
rec('虚拟屏 ' + SW + 'x' + SH + '（SM_CXSCREEN/SM_CYSCREEN，主屏=全虚拟屏则 ABS 归一化无缩放）');
rec('目标窗 ' + clsOf(parent) + ' rect(' + PX + ',' + PY + ')  EDIT 屏幕点 a=(' + EP.a.x + ',' + EP.a.y + ') b=(' + EP.b.x + ',' + EP.b.y + ')');
rec('');

/* ---- 选区派发时序：验证「mouse_event 之后立刻 pump 是否派发得到」 ---- */
if (SELPROBE && WITH_QS) {
    const env2 = Object.assign({}, process.env, {
        APPDATA: tempBase, LOCALAPPDATA: tempBase,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tempBase, 'wv2-' + ISTAG),
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_INSTANCE_TAG: ISTAG,
        QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
            + ' --disable-gpu-sandbox --remote-debugging-port=9413',
    });
    const p2 = spawn(EXE, ['--no-elevate'], { env: env2, cwd: exeDir, detached: false, stdio: 'ignore' });
    rec('启动实例 pid=' + p2.pid + '，等 hooks ready');
    const tw = Date.now();
    while (Date.now() - tw < 20000) {
        try { if (fs.readFileSync(LOG).toString('utf8').includes('bar ready')) break; } catch (e) { }
        sleep(200);
    }
    sleep(600); pump(600);
    rec('实例已就绪，开始选区派发时序（带钩子）');
    rec('');
}
if (SELPROBE) {
    for (let i = 1; i <= 5; i++) {
        activate();
        /* 完全复刻 dragFlick 的尾部：mouseup 后立刻 pumpMsg */
        moveTo(EP.a.x, EP.a.y); sleep(140); pumpMsg();
        const t0 = Date.now();
        mouse_event(LEFT_DOWN, 0, 0, 0, 0);
        moveTo(EP.b.x, EP.b.y);
        while (Date.now() - t0 < 24) { }
        const tUp = Date.now();
        mouse_event(LEFT_UP, 0, 0, 0, 0);
        pumpMsg();
        const selImmediate = getSel(edit);
        const tImmediate = Date.now();
        sleep(50); pumpMsg();
        const selLate = getSel(edit);
        rec(`第${i}轮 mouseup 后立刻 pump：选区[${selImmediate.start},${selImmediate.end}]（pump 耗时 ${tImmediate - tUp}ms）；再等 50ms+pump：选区[${selLate.start},${selLate.end}]`);
        flush();
    }
    rec('=== 诊断结束 ===');
    flush();
    process.exit(0);
}

let logOff = 0;
const logMark = () => { try { logOff = fs.statSync(LOG).size; } catch (e) { logOff = 0; } };
const logSince = () => {
    try { return fs.readFileSync(LOG).slice(logOff).toString('utf8'); } catch (e) { return ''; }
};

if (WITH_QS) {
    const env = Object.assign({}, process.env, {
        APPDATA: tempBase, LOCALAPPDATA: tempBase,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tempBase, 'wv2-' + ISTAG),
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_INSTANCE_TAG: ISTAG,
        QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
            + ' --disable-gpu-sandbox --remote-debugging-port=9413',
    });
    const p = spawn(EXE, ['--no-elevate'], { env, cwd: exeDir, detached: false, stdio: 'ignore' });
    rec('启动实例 pid=' + p.pid + '（QS_ALLOW_INJECTED=1，等 hooks ready）');
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
        try {
            const s = fs.readFileSync(LOG).toString('utf8');
            if (s.includes('hooks') && s.includes('bar ready')) break;
        } catch (e) { }
        sleep(200);
    }
    sleep(600); pump(600);
    rec('实例已就绪，开始对照轮次');
    rec('');
}

const N = 8;
/* 采样时间线：每 ~4ms 记一次序号，事后按实例日志同一时钟（100ns since 1601）对齐 */
const WIN2FS = (ms) => (ms + 11644473600000) * 10000;   // Date.now() → SystemTime intervals
function seqTrace(ms) {
    const out = [];
    const t0 = Date.now();
    let last = seq();
    out.push({ t: t0, seq: last });
    while (Date.now() - t0 < ms) {
        pumpMsg();
        const s = seq();
        const now = Date.now();
        if (s !== last) { out.push({ t: now, seq: s, prev: last }); last = s; }
    }
    return out;
}
for (let i = 1; i <= N; i++) {
    const okAct = activate();
    logMark();
    const tDrag = Date.now();
    const dt = dragFlick(EP.a, EP.b);
    pumpMsg();
    /* 拖完立刻量：此刻 QuickSearch 还没到 40ms 稳定期终点 */
    const sNow = getSel(edit);
    const seqNow = seq();
    if (WITH_QS) {
        /* 采样序号时间线直到取词全部跑完 */
        const trace = seqTrace(2600);
        sleep(50); pump(50);
        const sAfter = getSel(edit);
        const seqAfter = seq();
        const dl = logSince();
        const capLines = dl.split('\n').filter(x => /capture:|start_capture|kbd:|clipguard|show_bar: "/.test(x))
            .map(x => {
                const m = x.match(/intervals: (\d+)/);
                const ms = m ? Math.round(Number(m[1]) / 10000) - 11644473600000 : null;
                return ms === null ? x.trim() : `t+${String(ms - tDrag).padStart(5)}ms  ` + x.replace(/^\[SystemTime \{ intervals: \d+ \}\]\s*/, '').trim();
            })
            .filter(Boolean);
        rec(`第${i}轮 activate=${okAct} dt=${dt}ms | 拖完即量 选区[${sNow.start},${sNow.end}] seq=${seqNow} | 事后 选区[${sAfter.start},${sAfter.end}] seq=${seqAfter}`);
        rec('  序号变化时间线（相对 mouseup）：');
        for (const p of trace) {
            rec(`    t+${String(p.t - tDrag).padStart(5)}ms  seq ${p.prev !== undefined ? p.prev + '→' : ''}${p.seq}`);
        }
        rec('  实例日志（相对 mouseup）：');
        for (const c of capLines) rec('    | ' + c);
        rec('');
        flush();
    } else {
        sleep(60); pump(20);
        const opened = OpenClipboard(null) ? 1 : 0;
        if (opened) CloseClipboard();
    }
    if (!WITH_QS) {
        const before = seq();
        sendCtrlC();
        sleep(200); pump(20);
        const after = seq();
        const s2 = getSel(edit);
        rec(`第${i}轮 activate=${okAct} dt=${dt}ms open=${opened} | 选区 start=${sNow.start} end=${sNow.end}（复制后 start=${s2.start} end=${s2.end}）| seq ${before}→${after} changed=${after !== before}`);
        const b2 = seq();
        sendCtrlC();
        sleep(200); pump(20);
        const a2 = seq();
        rec(`第${i}轮 对照：相同选区再复制一次 seq ${b2}→${a2} changed=${a2 !== b2}`);
        rec('');
        flush();
    }
}

/* 收尾 */
if (WITH_QS) { rec('=== 诊断结束（实例留着，杀掉） ==='); }
else { rec('=== 诊断结束 ==='); }
flush();
process.exit(0);
