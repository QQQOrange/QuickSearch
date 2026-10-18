/* 造一个纯色窗口并停在屏幕上，用来验证横条的「背景取色」是否跟着变。
   用法: node bgwin.js <BBGGRR十六进制> [holdMs]
   例:   node bgwin.js FFFFFF   -> 白底
         node bgwin.js 000000   -> 黑底
         node bgwin.js 00A5FF   -> 橙色底（COLORREF 0x00BBGGRR） */
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
const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *p, void *m, void *i, void *pa)');
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
const ShowWindow = user32.func('int ShowWindow(void *h, int c)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32 f)');
const UpdateWindow = user32.func('int UpdateWindow(void *h)');

const color = parseInt(process.argv[2] || 'FFFFFF', 16);
const holdMs = +(process.argv[3] || 24000);

const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSBgProbe' + color.toString(16);
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(color), lpszMenuName: null, lpszClassName: cls, hIconSm: null
});
const h = CreateWindowExW(0, cls, 'QSBgProbe', 0x80000000 | 0x10000000, 0, 0, 1400, 900, null, null, inst, null);
ShowWindow(h, 4);
SetWindowPos(h, null, 0, 0, 1400, 900, 0x0040);
UpdateWindow(h);
console.log('bg window up, color=0x' + color.toString(16).padStart(6, '0'));
setTimeout(() => process.exit(0), holdMs);
