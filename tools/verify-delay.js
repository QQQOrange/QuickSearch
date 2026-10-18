/* ============================================================================
 *  「出现延迟」滑块实测
 *
 *  测量的是：从**松手那一刻**到**真正开始取词**之间隔了多久。
 *
 *  时间锚点全部取自程序自己的日志，不去和 node 的时钟对表 ——
 *  日志每行开头是 `[SystemTime { intervals: N }]`，N 是 100ns 为单位、
 *  以 1601-01-01 为起点的 Windows FILETIME。我们只做差，起点是谁无所谓。
 *
 *    tUp    = 最后一条 `mouseup: drag=true` 的时间
 *    tStart = 它之后第一条 `start_capture: begin` 的时间
 *    Δ      = tStart - tUp   —— 这个数就该等于设置里的 delay_ms
 *
 *  每轮拖两次取两个样本，顺便确认延迟过后横条确实弹出来了。
 *
 *  用法：
 *    node verify-delay.js          （跑一轮，结果打到 stdout）
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const TRACE = path.join(__dirname, 'verify-delay.trace.txt');
fs.writeFileSync(TRACE, '');
const log = (...a) => {
    const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    fs.appendFileSync(TRACE, s + '\n');
    process.stdout.write(s + '\n');
};

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

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
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

const RegisterClassExW = user32.func('uint16 RegisterClassExW(_In_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 e, str16 cls, str16 name, uint32 st, int x, int y, int w, int h, void *p, void *m, void *i, void *pa)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const ShowWindow = user32.func('int ShowWindow(void *h, int c)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const SetFocus = user32.func('void *SetFocus(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const PeekMessageW = user32.func('int PeekMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b, uint32 r)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const moveTo = (x, y) => mouse_event(0x0001 | 0x8000,
    Math.round(x * 65535 / (SW - 1)), Math.round(y * 65535 / (SH - 1)), 0, 0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const msg = {};
const pump = (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        let n = 0;
        while (n++ < 500 && PeekMessageW(msg, null, 0, 0, 1)) {
            TranslateMessage(msg); DispatchMessageW(msg);
        }
        sleep(15);
    }
};

const LOG = path.join(process.env.APPDATA, 'QuickSearch', 'log.txt');
let offset = 0;
try { offset = fs.statSync(LOG).size; } catch (e) { offset = 0; }
const logTail = () => {
    try { return fs.readFileSync(LOG, 'utf8').slice(offset); } catch (e) { return ''; }
};

/* 日志行 -> { t: 毫秒（仅用于做差）, m: 正文 } */
const TS = /^\[SystemTime \{ intervals: (\d+) \}\] (.*)$/;
function parseLines(s) {
    const out = [];
    for (const line of s.split('\n')) {
        const m = TS.exec(line);
        if (m) out.push({ t: parseInt(m[1], 10) / 10000, m: m[2] });
    }
    return out;
}

const TEXT = 'Quick Search 出现延迟验证：这是一段用来验证取词的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSVerifyDelayWindow';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: cls, hIconSm: null
});

const PW = 900, PH = 420, PX = 1300, PY = 200, EH = 240;
const parent = CreateWindowExW(0, cls, 'QS 出现延迟验证窗口', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    12, 12, PW - 28, EH, parent, null, inst, null);
user32.func('int SetWindowTextW(void *h, str16 s)')(edit, TEXT);
ShowWindow(parent, 5);
SetWindowPos(parent, 0, PX, PY, PW, PH, 0x0040);
sleep(400); pump(300);

const sameHwnd = (a, b) => String(a) === String(b);
function activate() {
    SetWindowPos(parent, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    sleep(200); pump(100);
    for (let i = 0; i < 5; i++) {
        if (sameHwnd(GetForegroundWindow(), parent)) return true;
        const wr = {};
        GetWindowRect(parent, wr);
        moveTo(wr.left + 20, wr.bottom - 18);
        sleep(140);
        mouse_event(0x0002, 0, 0, 0, 0); sleep(70);
        mouse_event(0x0004, 0, 0, 0, 0);
        sleep(400); pump(100);
    }
    return sameHwnd(GetForegroundWindow(), parent);
}

const WAIT = 4000;   // 比待测的最大延迟还长，保证延迟过后横条已经弹完
function dragSelect() {
    const a = { x: 16, y: 22 }, b = { x: 430, y: 22 };
    ClientToScreen(edit, a);
    ClientToScreen(edit, b);
    moveTo(a.x + 4, a.y); sleep(130); pump(60);
    mouse_event(0x0002, 0, 0, 0, 0); sleep(130); pump(60);
    for (let i = 1; i <= 18; i++) {
        moveTo(Math.round(a.x + (b.x - a.x) * i / 18), a.y);
        sleep(32); pump(20);
    }
    sleep(170); pump(60);
    mouse_event(0x0004, 0, 0, 0, 0);   // 松手
    pump(WAIT);
}

/* ------------------------------ 执行 ------------------------------ */
const fg = activate();
SetFocus(edit);
sleep(300); pump(200);

const samples = [];
let shownTotal = 0;
for (let k = 0; k < 2; k++) {
    dragSelect();
    const lines = parseLines(logTail());
    // 从后往前找最近一次「拖选松手」
    let up = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].m.startsWith('mouseup: drag=true')) { up = i; break; }
    }
    if (up < 0) { samples.push(null); continue; }
    let st = -1;
    for (let i = up + 1; i < lines.length; i++) {
        if (lines[i].m.startsWith('start_capture: begin')) { st = i; break; }
    }
    let shown = 0;
    for (let i = up + 1; i < lines.length; i++) {
        if (lines[i].m.startsWith('show_bar:')) shown++;
    }
    shownTotal += shown;
    samples.push(st < 0 ? null : Math.round(lines[st].t - lines[up].t));
}

log('RESULT|foregroundOk=' + fg);
log('RESULT|deltas=' + JSON.stringify(samples));
log('RESULT|showBar=' + shownTotal);
pump(800);
process.exit(0);
