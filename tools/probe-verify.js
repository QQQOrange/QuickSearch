/* 最小探针：逐步落盘，定位 verify-trigger.js 卡在哪一步 */
const fs = require('fs');
const path = require('path');
const TRACE = path.join(__dirname, 'probe.trace.txt');
fs.writeFileSync(TRACE, '');
const T = (s) => fs.appendFileSync(TRACE, s + '\n');

try {
    T('1 require koffi');
    const koffi = require('koffi');
    T('2 load user32');
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { T('  dpi fail'); }

    T('3 structs');
    const WNDPROC = koffi.proto('intptr __stdcall WNDPROC(void *hw, uint32 msg, uintptr wp, intptr lp)');
    const MSG = koffi.struct('MSG', {
        hwnd: 'void *', message: 'uint32', _pad: 'uint32', wParam: 'uintptr', lParam: 'intptr',
        time: 'uint32', _pad2: 'uint32', pt_x: 'long', pt_y: 'long'
    });
    const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
        cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WNDPROC),
        cbClsExtra: 'int', cbWndExtra: 'int', hInstance: 'void *',
        hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
        lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'void *'
    });

    T('4 funcs');
    const RegisterClassExW = user32.func('uint16 RegisterClassExW(_Inout_ WNDCLASSEXW *c)');
    const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)');
    const DefWindowProcW = user32.func('intptr DefWindowProcW(void *h, uint32 m, uintptr w, intptr l)');
    const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(str16 n)');
    const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 c)');
    const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');
    const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
    const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
    const BringWindowToTop = user32.func('int BringWindowToTop(void *h)');
    const SetFocus = user32.func('void *SetFocus(void *h)');
    const SetWindowPos = user32.func('int SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32 f)');
    const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
    const SendMessageW = user32.func('intptr SendMessageW(void *h, uint32 m, uintptr w, intptr l)');
    const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ void *r)');
    const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ void *p)');
    const PeekMessageW = user32.func('int PeekMessageW(_Out_ void *m, void *h, uint32 a, uint32 b, uint32 r)');
    const TranslateMessage = user32.func('int TranslateMessage(void *m)');
    const DispatchMessageW = user32.func('intptr DispatchMessageW(void *m)');
    const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ void *r)');
    T('5 funcs bound');

    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

    T('6 register wndproc');
    const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
    const inst = GetModuleHandleW(null);
    T('7 inst=' + String(inst));
    const cls = 'QSProbeWindow';
    const okc = RegisterClassExW({
        cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
        cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
        hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
        lpszClassName: cls, hIconSm: null
    });
    T('8 RegisterClassExW ok=' + okc);

    const parent = CreateWindowExW(0, cls, 'QS Probe', 0x00CF0000 | 0x10000000,
        1300, 200, 900, 420, null, null, inst, null);
    T('9 parent=' + String(parent));
    if (!parent) { T('   create failed'); process.exit(1); }

    const edit = CreateWindowExW(0, 'EDIT', '',
        0x40000000 | 0x10000000 | 0x00200000 | 0x0040, 12, 12, 870, 240, parent, null, inst, null);
    T('10 edit=' + String(edit));
    SetWindowTextW(edit, 'probe text 探测文本');
    ShowWindow(parent, 5);
    SetWindowPos(parent, null, 1300, 200, 900, 420, 0x0040);
    BringWindowToTop(parent);
    SetForegroundWindow(parent);
    sleep(400);
    SetFocus(edit);
    T('11 shown, fg=' + String(GetForegroundWindow()) + ' parent=' + String(parent));

    T('12 pump with struct object');
    const pm = {};
    let n = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 600) {
        while (PeekMessageW(pm, null, 0, 0, 1)) { TranslateMessage(pm); DispatchMessageW(pm); n++; }
        sleep(25);
    }
    T('13 pumped ' + n + ' messages');

    T('14 EM_SETSEL');
    SendMessageW(edit, 0x00B1, 0, 6);
    T('15 getclientrect');
    const cr = {};
    GetClientRect(edit, cr);
    T('16 cr=' + JSON.stringify(cr));
    const pt = { x: 16, y: 22 };
    ClientToScreen(edit, pt);
    T('17 pt=' + JSON.stringify(pt));

    T('18 clip.exe test');
    const { execSync } = require('child_process');
    try {
        const r = execSync('clip', { input: Buffer.from('PROBE-CLIP', 'utf8'), windowsHide: true, timeout: 5000 });
        T('19 clip ok, out=' + String(r));
    } catch (e) {
        T('19 clip FAILED: ' + e.message);
    }

    T('20 window rect');
    const wr = {};
    GetWindowRect(parent, wr);
    T('21 wr=' + JSON.stringify(wr));

    T('DONE');
} catch (e) {
    T('EXCEPTION: ' + (e && e.stack ? e.stack : e));
}
process.exit(0);
