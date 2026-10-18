/* ============================================================================
 *  「暂停使用」端到端验证
 *
 *  托盘菜单里点一下「暂停使用」，横条就不该再自动弹出来。
 *
 *  判定依据 = 日志里的 `show_bar:` 行数 与 `trigger: 已暂停使用` 那一行。
 *
 *  两轮对照：
 *    [对照] 正常启动    -> 拖选必须弹（证明测试手法本身有效）
 *    [实验] --paused 启动 -> 拖选必须**不弹**，且日志记下「已暂停使用」
 *
 *  为什么用 --paused 而不是去点托盘菜单：托盘菜单只能靠模拟鼠标点击真实
 *  屏幕坐标来触发，会去抢前台、干扰用户，还极不稳定。--paused 走的是同一个
 *  `set_paused()` 入口，验证的是同一段闸门逻辑。
 *
 *  用法：
 *    node verify-paused.js normal
 *    node verify-paused.js paused
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2] || 'normal';
const TRACE = path.join(__dirname, 'verify-paused.trace.txt');
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
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
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
const countShowBar = (s) => (s.match(/show_bar:/g) || []).length;

const TEXT = 'Quick Search 选中即弹出横条：这是一段用来验证取词的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSVerifyPausedWindow';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: cls, hIconSm: null
});

const PW = 900, PH = 420, PX = 1300, PY = 200, EH = 240;
const parent = CreateWindowExW(0, cls, 'QS 暂停验证窗口', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    12, 12, PW - 28, EH, parent, null, inst, null);
SetWindowTextW(edit, TEXT);
ShowWindow(parent, 5);
SetWindowPos(parent, 0, PX, PY, PW, PH, 0x0040);
sleep(400); pump(300);

function SetWindowTextW(h, s) {
    user32.func('int SetWindowTextW(void *h, str16 s)')(h, s);
}

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
    mouse_event(0x0004, 0, 0, 0, 0);
    pump(1600);
}

/* ------------------------------ 判定 ------------------------------ */
log('模式 = ' + MODE + (MODE === 'paused' ? '（程序带 --paused 启动）' : '（正常启动）'));
const fg = activate();
SetFocus(edit);
sleep(300); pump(200);
const before = countShowBar(logTail());
dragSelect();
const tail = logTail().slice(logTail().length - 0);
const n = countShowBar(logTail()) - before;
const sawPausedMsg = /已暂停使用/.test(logTail());

log('');
log('  前台抢到 = ' + fg);
log('  新增 show_bar 行数 = ' + n);
log('  日志里有「已暂停使用」= ' + sawPausedMsg);

let ok = false, note = '';
if (MODE === 'paused') {
    ok = (n === 0) && sawPausedMsg;
    note = n === 0
        ? '暂停期间拖选没有弹出横条，且日志记录了拦截原因'
        : '暂停了但仍然弹了 ' + n + ' 次 —— 闸门没起作用';
} else {
    ok = n >= 1;
    note = n >= 1
        ? '对照组：正常状态拖选弹了 ' + n + ' 次（说明测试手法有效）'
        : '对照组都没弹，测试手法有问题，结论不可信';
}
log('');
log((ok ? '[PASS] ' : '[FAIL] ') + (MODE === 'paused' ? '暂停后不自动弹条' : '对照组：正常时会弹条'));
log('        ' + note);

fs.writeFileSync(path.join(__dirname, 'verify-paused.result.txt'),
    (ok ? 'PASS' : 'FAIL') + '  ' + MODE + '  |  ' + note + '\n', 'utf8');
pump(1500);
process.exit(ok ? 0 : 1);
