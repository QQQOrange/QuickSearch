/* 决定性实验：完全不经过 Tauri/WebView2，自己创建一个 Win32 窗口，
   背景刷成洋红。如果连它都上不了屏，说明问题在「进程 → 可见桌面」这条链路上，
   跟 Tauri / WebView2 无关。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');

const WNDPROC = koffi.proto('intptr __stdcall WNDPROC(void *hw, uint32 msg, uintptr wp, intptr lp)');
const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: koffi.pointer(WNDPROC),
    cbClsExtra: 'int',
    cbWndExtra: 'int',
    hInstance: 'void *',
    hIcon: 'void *',
    hCursor: 'void *',
    hbrBackground: 'void *',
    lpszMenuName: 'str16',
    lpszClassName: 'str16',
    hIconSm: 'void *'
});

const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
const UpdateWindow = user32.func('int UpdateWindow(void *h)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 name)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 color)');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32 flags)');
const GetMessageW = user32.func('int GetMessageW(_Out_ void *m, void *h, uint32 min, uint32 max)');
const TranslateMessage = user32.func('int TranslateMessage(void *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(void *m)');

const proc = koffi.register((hw, msg, wp, lp) => {
    // WM_PAINT=0x0F, WM_ERASEBKGND=0x14
    return DefWindowProcW(hw, msg, wp, lp);
}, koffi.pointer(WNDPROC));

const inst = GetModuleHandleW(null);
const cls = 'QSRAWDIAG';
const wc = {
    cbSize: koffi.sizeof(WNDCLASSEXW),
    style: 0x0003,
    lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0,
    hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00FF00FF), // COLORREF 0x00BBGGRR -> 洋红
    lpszMenuName: null, lpszClassName: cls, hIconSm: null
};
console.log('sizeof(WNDCLASSEXW) =', koffi.sizeof(WNDCLASSEXW), '(应 80)');
const atom = RegisterClassExW(wc);
console.log('RegisterClassExW atom =', atom, 'lastError irrelevant');

// WS_POPUP|WS_VISIBLE|WS_CLIPSIBLINGS ; WS_EX_TOPMOST|WS_EX_TOOLWINDOW
const hwnd = CreateWindowExW(0x00000008 | 0x00000080, cls, 'QSRAWDIAG',
    0x80000000 | 0x10000000 | 0x04000000,
    1500, 200, 500, 260, null, null, inst, null);
console.log('CreateWindowExW hwnd =', hwnd);
if (!hwnd) { process.exit(1); }
ShowWindow(hwnd, 4 /*SW_SHOWNOACTIVATE*/);
UpdateWindow(hwnd);
SetWindowPos(hwnd, -1 /*HWND_TOPMOST*/, 1500, 200, 500, 260, 0x0010 | 0x0040);
const r = {};
GetWindowRect(hwnd, r);
console.log('rect =', JSON.stringify(r));
console.log('hold 22s ...');
setTimeout(() => process.exit(0), 22000);
