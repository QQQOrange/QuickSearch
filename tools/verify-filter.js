/* ============================================================================
 *  「黑白名单」端到端验证（每一轮只做一次拖选，判定交给驱动脚本）
 *
 *  做法的来由：
 *    名单比对的依据是「前台窗口所属进程的文件名」（win::foreground_exe 只取
 *    最后一段，比如 notepad.exe）。本脚本自己用 node 建一个真窗口并抢前台，
 *    那这个窗口的进程就是 node.exe —— 于是「名单里写 node.exe」就等于
 *    「命中当前前台」，天然适合做对照，不需要去猜用户在用什么程序。
 *
 *  但这样有个坑：万一窗口没抢到前台，前台其实是别的进程，那黑名单写
 *  node.exe 就不会命中，测试会假 FAIL。所以脚本在拖选的同一时刻把**真实的
 *  前台进程名**读出来一并打印 —— 每条结论都能和事实对上，不许猜。
 *
 *  判定依据 = 日志里新增的 `show_bar:` 行数 与 `filter: ... 挡掉了` 那一行。
 *
 *  用法：
 *    node verify-filter.js          （跑一轮，结果打到 stdout）
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const TRACE = path.join(__dirname, 'verify-filter.trace.txt');
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

/* 读进程名：PID -> 完整路径 -> 只留文件名，和 Rust 侧 process_exe 的算法一致 */
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, void *pid)');
const OpenProcess = kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)');
const QueryFullProcessImageNameW = kernel32.func('int QueryFullProcessImageNameW(void *h, uint32 f, void *buf, void *sz)');
const CloseHandle = kernel32.func('int CloseHandle(void *h)');

function exeOf(hwnd) {
    if (!hwnd) return null;
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    if (!pid) return null;
    const h = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (!h) return null;
    const buf = Buffer.alloc(2 * 1024);
    const sz = Buffer.alloc(4);
    sz.writeUInt32LE(1024, 0);
    const ok = QueryFullProcessImageNameW(h, 0, buf, sz);
    CloseHandle(h);
    if (!ok) return null;
    const n = sz.readUInt32LE(0);
    const full = buf.toString('utf16le', 0, n * 2);
    return full.split(/[\\/]/).pop();
}

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

const TEXT = 'Quick Search 黑白名单验证：这是一段用来验证取词的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSVerifyFilterWindow';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: cls, hIconSm: null
});

const PW = 900, PH = 420, PX = 1300, PY = 200, EH = 240;
const parent = CreateWindowExW(0, cls, 'QS 黑白名单验证窗口', 0x00CF0000 | 0x10000000,
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

/* ------------------------------ 执行 ------------------------------ */
const fg = activate();
SetFocus(edit);
sleep(300); pump(200);

const fgExe = exeOf(GetForegroundWindow());   // 拖选那一刻的真实前台进程
const before = (logTail().match(/show_bar:/g) || []).length;
dragSelect();
const tail = logTail();
const n = (tail.match(/show_bar:/g) || []).length - before;
/* 全部拦截记录都要留下来：验证期间可能有别的程序短暂抢占前台并被正确拦掉
 * （实测出现过 msedge.exe），那不是本轮的判定对象，不能只看最后一条。 */
const filterLines = (tail.match(/filter:.*/g) || []);

log('RESULT|fgExe=' + fgExe);
log('RESULT|showBar=' + n);
log('RESULT|filterLines=' + filterLines.join(' ;; '));
log('RESULT|foregroundOk=' + fg);
pump(800);
process.exit(0);
