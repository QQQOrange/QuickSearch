/* 端到端测试：不碰用户的程序，自己开一个带 EDIT 控件的窗口，
   在里面拖选文字，看 QuickSearch 会不会自动弹横条。
   用法: node e2e.js   （跑完自动退出，窗口只存在约 12 秒） */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

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

const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const SetFocus = user32.func('void *SetFocus(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32 f)');
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const GetMessageW = user32.func('int GetMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');
const SetCursorPos = user32.func('int SetCursorPos(int x, int y)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS, Math.round(x * 65535 / (SW - 1)), Math.round(y * 65535 / (SH - 1)), 0, 0);
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const TEXT = 'Quick Search 选中即弹出横条 —— 这是一段用来验证取词的中文测试文本。';

const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSE2ETestWindow';
const wc = {
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null, lpszClassName: cls, hIconSm: null
};
RegisterClassExW(wc);

const PW = 900, PH = 380, PX = 1240, PY = 160;
// WS_OVERLAPPEDWINDOW | WS_VISIBLE
const parent = CreateWindowExW(0, cls, 'QS 取词测试窗口', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
if (!parent) { console.log('create parent failed'); process.exit(1); }

// EDIT: WS_CHILD|WS_VISIBLE|WS_VSCROLL|ES_MULTILINE|ES_AUTOVSCROLL
const edit = CreateWindowExW(0, 'EDIT', '', 0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    12, 12, PW - 28, PH - 60, parent, null, inst, null);
SetWindowTextW(edit, TEXT);
ShowWindow(parent, 5);
// HWND_TOP（不是 TOPMOST），免得压住被测的横条
SetWindowPos(parent, null, PX, PY, PW, PH, 0x0040);
SetForegroundWindow(parent);
SetFocus(edit);
sleep(700);

const cr = {};
GetClientRect(edit, cr);
const origin = { x: 22, y: 40 };
ClientToScreen(edit, origin);
const end = { x: 430, y: 40 };
ClientToScreen(edit, end);
console.log('edit screen start=', origin.x, origin.y, ' end=', end.x, end.y);

// 先在正文里点一下拿焦点，再从左到右拖选
moveTo(origin.x + 5, origin.y);
sleep(90); mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(70); mouse_event(LEFT_UP, 0, 0, 0, 0);
sleep(300);

moveTo(origin.x, origin.y); sleep(140);
mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(140);
for (let i = 1; i <= 18; i++) {
    moveTo(Math.round(origin.x + (end.x - origin.x) * i / 18), origin.y);
    sleep(34);
}
sleep(180);
mouse_event(LEFT_UP, 0, 0, 0, 0);
console.log('drag done');

// 保持窗口 8 秒，同时非阻塞抽消息
const PM = koffi.struct('PM', {
    hwnd: 'void *', message: 'uint32', _pad: 'uint32', wParam: 'uintptr', lParam: 'intptr',
    time: 'uint32', _pad2: 'uint32', pt_x: 'long', pt_y: 'long'
});
const PeekMessageW = user32.func('int PeekMessageW(_Out_ PM *m, void *h, uint32 a, uint32 b, uint32 r)');
const pm = {};
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
    while (PeekMessageW(pm, null, 0, 0, 1 /*PM_REMOVE*/)) {
        TranslateMessage(pm);
        DispatchMessageW(pm);
    }
    sleep(50);
}
process.exit(0);
