/* ============================================================================
 *  外观与取色证据
 *
 *  造一个带文字的窗口，拖选文字让横条弹出来，然后整屏截图。
 *  传不同的背景色跑两次，就能对比「自动取色」在浅底 / 深底下的效果。
 *
 *  用法：node evidence.js <light|dark> <输出png>
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const BringWindowToTop = user32.func('int BringWindowToTop(void *h)');
const SetFocus = user32.func('void *SetFocus(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const SendMessageW = user32.func('intptr SendMessageW(void *h, uint32 m, uintptr w, intptr l)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const PeekMessageW = user32.func('int PeekMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b, uint32 r)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');

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
            TranslateMessage(msg); DispatchMessageW(msg);
        }
        sleep(15);
    }
};

const MODE = process.argv[2] || 'light';
const OUT = process.argv[3] || ('_ev-bar-' + MODE + '.png');
const KEEP_MS = Number(process.argv[4] || 16000);
// COLORREF 是 0x00BBGGRR
const BG = MODE === 'dark' ? 0x00201E1C : 0x00FAFAF8;

const TEXT = 'Quick Search 选中即弹出搜索横条：这是一段用于验证取词与自动取色的中文测试文本。';

const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSEvidenceWindow' + (MODE === 'dark' ? 'D' : 'L');
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(BG), lpszMenuName: null, lpszClassName: cls, hIconSm: null
});

/* 窗口做得比 EDIT 高很多，EDIT 只占最上面一条单行。
   这样拖选完的插入符正好贴在 EDIT 下沿，横条就落在窗口的纯色底上 ——
   采样区不会掉进 EDIT 那块自带的白色底，浅底/深底才对比得出来。 */
const PW = 1500, PH = 560, PX = 1000, PY = 240;
const parent = CreateWindowExW(0, cls, '取色验证窗口（模拟任意软件）', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x0001 /* CHILD|VISIBLE|ES_AUTOHSCROLL * 单行 */,
    16, 16, PW - 36, 42, parent, null, inst, null);
SetWindowTextW(edit, TEXT);
ShowWindow(parent, 5);
SetWindowPos(parent, -1, PX, PY, PW, PH, 0x0040);
sleep(500); pump(300);

const sameHwnd = (a, b) => String(a) === String(b);
const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 name)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
/** 横条窗口的实际矩形 + 是否可见 —— 直接量出来，截图就不用猜坐标了 */
function barRect() {
    const h = FindWindowW(null, 'QuickSearchBar');
    if (!h) return null;
    const r = {};
    GetWindowRect(h, r);
    return {
        hwnd: String(h), vis: !!IsWindowVisible(h),
        rect: [r.left, r.top, r.right - r.left, r.bottom - r.top]
    };
}
function activate() {
    for (let i = 0; i < 5; i++) {
        if (sameHwnd(GetForegroundWindow(), parent)) break;
        const wr = {};
        GetWindowRect(parent, wr);
        moveTo(wr.left + 24, wr.bottom - 20);
        sleep(150);
        mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(70);
        mouse_event(LEFT_UP, 0, 0, 0, 0);
        sleep(420); pump(60);
    }
    // 抢到前台之后必须取消置顶！
    // 否则我们的窗口会一直待在 topmost 层，把同样 topmost 的横条压在下面
    // （日志里 after-show 的 topmost_window 会显示成我们自己的窗口）。
    SetWindowPos(parent, -2 /* HWND_NOTOPMOST */, PX, PY, PW, PH, 0x0040);
    sleep(250); pump(80);
    return sameHwnd(GetForegroundWindow(), parent);
}
const fgOk = activate();

// 拖选 EDIT 第一行靠左的一段文字
SendMessageW(edit, 0x00B1, 0, 0);
SetFocus(edit);
sleep(250); pump(60);
const s = { x: 20, y: 20 }, e = { x: 640, y: 20 };
ClientToScreen(edit, s);
ClientToScreen(edit, e);

moveTo(s.x, s.y); sleep(140); pump(40);
mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(140); pump(40);
for (let i = 1; i <= 20; i++) {
    moveTo(Math.round(s.x + (e.x - s.x) * i / 20), s.y);
    sleep(34); pump(20);
}
sleep(200); pump(40);
mouse_event(LEFT_UP, 0, 0, 0, 0);

// 等横条弹出 + 取色完成
pump(1600);

const wr = {};
GetWindowRect(parent, wr);
console.log(JSON.stringify({
    mode: MODE, out: OUT, fgOk, keepMs: KEEP_MS,
    editFrom: [s.x, s.y], editTo: [e.x, e.y],
    winRect: [wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top],
    crop: [wr.left - 40, wr.top - 20, wr.right + 40, wr.bottom + 60]
}));

// 从外部截图（Windows 上 node 里 spawn 常报 EBUSY，所以截图交给调用方）。
// 落一个 READY 标记文件，调用方看到它再截，时机最准。
const br = barRect();
const info = {
    mode: MODE, out: OUT, fgOk,
    winRect: [wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top],
    crop: [wr.left - 40, wr.top - 20, wr.right + 40, wr.bottom + 60],
    bar: br
};
fs.writeFileSync(path.resolve(__dirname, '_ev-ready.txt'), JSON.stringify(info), 'utf8');
console.log(JSON.stringify(info));
console.log('READY_FOR_SHOT');
pump(KEEP_MS);
try { fs.unlinkSync(path.resolve(__dirname, '_ev-ready.txt')); } catch (e) { }
process.exit(0);
