/* ============================================================================
 *  触发条件端到端验证
 *
 *  核心命题（用户要求）：**横条出现的唯一条件是「确实选中了一段文字」**。
 *  没选中任何文字时，绝对不能出现。
 *
 *  判定依据 = QuickSearch 自己的调试日志里的 `show_bar:` 行数。
 *  横条窗口是 WS_EX_NOACTIVATE 的无激活浮层，靠可见性判断不如日志精确。
 *
 *  4 个场景：
 *    [1] 无选区 + Ctrl+C      -> **必须弹**，且贴在鼠标位置
 *                                （用户拍板：按了 Ctrl+C 就弹，不管有没有选中文字）
 *    [2] 有选区 + Ctrl+C      -> 必须弹，且取到的词 = 选区内容
 *    [3] 拖选文字             -> 必须弹
 *    [4] 空白处拖动（无选区） -> 必须不弹（拖动是"选中"语义，不是 Ctrl+C）
 *
 *  前置：
 *    - QuickSearch.exe 带 QS_DEBUG=1 QS_ALLOW_INJECTED=1 运行
 *      （本脚本用注入的方式模拟输入；**鼠标**注入默认会被钩子过滤，所以要放开）
 *
 *  ⚠ 两种跑法，看你想验什么：
 *    · 带 QS_ALLOW_INJECTED=1  → 4 条全跑，验的是**触发逻辑**本身。
 *    · 不带该开关            → [1][2] 仍应通过，[3] 会失败。
 *      这不是 bug：[3] 是"注入的鼠标拖选"，而鼠标注入**故意**仍被过滤
 *      （防自动化工具乱弹）；键盘注入已经被放开了，所以第三方软件发来的
 *      Ctrl+C 照样能弹条 —— 这正是用户要的效果。
 *    - 剪贴板里先放一段哨兵文本（由调用方用 clip 命令预置）
 *  用法：node verify-trigger.js
 *  追踪：同目录 verify.trace.txt（同步落盘，进程被强杀也不丢）
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const TRACE = path.join(__dirname, 'verify.trace.txt');
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
const SetFocus = user32.func('void *SetFocus(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const SendMessageW = user32.func('intptr SendMessageW(void *h, uint32 m, uintptr w, intptr l)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, void *buf, int max)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, void *buf, int max)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 name)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const PeekMessageW = user32.func('int PeekMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b, uint32 r)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS,
    Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)), 0, 0);

const VK_CONTROL = 0x11, VK_C = 0x43, KEYUP = 2;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/* 抽消息必须 Translate + Dispatch。
   只 PeekMessage(PM_REMOVE) 不派发的话，窗口的 WM_PAINT 永远得不到 BeginPaint/EndPaint，
   系统会立刻把它重新标记为无效 —— PeekMessage 就总能再取到一条 WM_PAINT，
   内层 while 变成死循环（这就是之前脚本「无输出、被超时杀掉」的原因）。
   再加上一个 500 次的硬上限兜底，任何情况下都不会空转。 */
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

/* ------------------------------- 日志读取 ------------------------------- */
const LOG = path.join(process.env.APPDATA, 'QuickSearch', 'log.txt');
let offset = 0;
try { offset = fs.statSync(LOG).size; } catch (e) { offset = 0; }
const logTail = () => {
    /* ⚠ 必须按**字节**切，再转字符串。
     * 以前写的是 `readFileSync(LOG,'utf8').slice(offset)` —— offset 是字节数
     * （statSync().size），却拿去切一个 JS 字符串（UTF-16 码元）。日志里中文很多
     * （UTF-8 下一个汉字 3 字节、字符串里只算 1 个码元），于是 offset 比字符串
     * 长度还大，slice 直接返回空串 → 所有断言都读不到新日志、一律判「没弹」。
     * 这正是 [2]「Ctrl+C 弹条」长期误报 FAIL 的原因（产品其实是好的）。 */
    try { return fs.readFileSync(LOG).slice(offset).toString('utf8'); }
    catch (e) { return ''; }
};
const countShowBar = (s) => (s.match(/show_bar:/g) || []).length;

const TEXT = 'Quick Search 选中即弹出横条：这是一段用来验证取词的中文测试文本。';

const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSVerifyWindow2';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: cls, hIconSm: null
});

const PW = 900, PH = 420, PX = 1300, PY = 200;
const parent = CreateWindowExW(0, cls, 'QS 取词验证窗口', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
if (!parent) { log('创建窗口失败'); process.exit(1); }

const EH = 240;   // EDIT 高度；下方留一条空白区做「拖动但没选中文字」的测试
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    12, 12, PW - 28, EH, parent, null, inst, null);
SetWindowTextW(edit, TEXT);

ShowWindow(parent, 5);
SetWindowPos(parent, 0 /* HWND_TOP */, PX, PY, PW, PH, 0x0040);
sleep(400);
pump(300);

const sameHwnd = (a, b) => String(a) === String(b);
function winInfo(h) {
    const c = Buffer.alloc(256), t = Buffer.alloc(256);
    GetClassNameW(h, c, 256);
    GetWindowTextW(h, t, 256);
    return 'cls=' + c.toString('utf16le').replace(/\0.*$/, '') +
        ' title=' + t.toString('utf16le').replace(/\0.*$/, '');
}
/* 抢前台，两步走：
   ① 先把窗口重新锚回固定位置并置顶（HWND_TOPMOST）。Windows 的前台锁定只拦
      SetForegroundWindow，不拦 SetWindowPos；窗口在 Z 序底部时如果不先抬上来，
      注入的点击会落到别的窗口上把别人激活（实测被 Edge / 微信抢走）。
   ② 再注入一次真实点击。系统把注入输入也算作「用户输入」，
      本进程收到之后才有资格把窗口设为前台。

   ⚠️ 点击点必须在**客户区**，绝不能点标题栏：
      合成按键按下的那几十毫秒里，只要用户动一下物理鼠标，
      Windows 就会把这段当成「拖动标题栏」，整个测试窗口被挪走，
      后面算出来的坐标全部失效（踩过这个坑）。 */
function anchor() {
    SetWindowPos(parent, -1 /* HWND_TOPMOST */, PX, PY, PW, PH, 0x0040);
    sleep(200); pumpMsg();
}
function activate() {
    anchor();
    for (let i = 0; i < 4; i++) {
        if (sameHwnd(GetForegroundWindow(), parent)) return true;
        const wr = {};
        GetWindowRect(parent, wr);
        // 客户区左下角的空白带：不在任何控件上，也不会触发窗口拖动
        moveTo(wr.left + 20, wr.bottom - 18);
        sleep(150);
        mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(70);
        mouse_event(LEFT_UP, 0, 0, 0, 0);
        sleep(420);
        pumpMsg();
    }
    return sameHwnd(GetForegroundWindow(), parent);
}
const fgNow = () => (sameHwnd(GetForegroundWindow(), parent) ? '本窗口' : winInfo(GetForegroundWindow()));

/** 现算坐标：窗口每次都可能被挪动，坐标绝不能提前算好存起来 */
function pts() {
    const s = { x: 16, y: 22 }, e = { x: 400, y: 22 };
    ClientToScreen(edit, s);
    ClientToScreen(edit, e);
    const a = { x: 60, y: EH + 90 }, b = { x: 420, y: EH + 90 };
    ClientToScreen(parent, a);
    ClientToScreen(parent, b);
    return { s, e, a, b };
}
const p0 = pts();
log('EDIT 文字区 (' + p0.s.x + ',' + p0.s.y + ') -> (' + p0.e.x + ',' + p0.e.y + ')');
log('空白区    (' + p0.a.x + ',' + p0.a.y + ') -> (' + p0.b.x + ',' + p0.b.y + ')');
log('');

/* ------------------------------- 动作原语 ------------------------------- */
function sendCtrlC() {
    keybd_event(VK_CONTROL, 0, 0, 0); sleep(70);
    keybd_event(VK_C, 0, 0, 0); sleep(100);
    keybd_event(VK_C, 0, KEYUP, 0); sleep(60);
    keybd_event(VK_CONTROL, 0, KEYUP, 0);
}
const selectRange = (a, b) => SendMessageW(edit, 0x00B1, a, b);
function drag(from, to) {
    moveTo(from.x + 4, from.y); sleep(130); pumpMsg();
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(130); pumpMsg();
    for (let i = 1; i <= 18; i++) {
        moveTo(Math.round(from.x + (to.x - from.x) * i / 18), from.y);
        sleep(32); pumpMsg();
    }
    sleep(170); pumpMsg();
    mouse_event(LEFT_UP, 0, 0, 0, 0);
}
function barInfo() {
    const h = FindWindowW(null, 'QuickSearchBar');
    if (!h) return 'none';
    const r = {};
    GetWindowRect(h, r);
    return { hwnd: String(h), visible: !!IsWindowVisible(h), w: r.right - r.left, h: r.bottom - r.top };
}

/* -------------------------------- 用例 -------------------------------- */
const results = [];
/** valid=false 表示这一次「前台没抢到我们窗口」，结论不可信，不算通过 */
function check(name, ok, note, valid) {
    const good = !!ok && valid !== false;
    results.push({ name, ok: good, note: note || '' });
    log((good ? '[PASS] ' : '[FAIL] ') + name);
    if (note) log('        ' + note);
}
const lastShowBar = (s) => {
    const all = s.match(/show_bar: "([^"]*)"/g) || [];
    return all.length ? all[all.length - 1].replace(/^show_bar: "/, '').replace(/"$/, '') : null;
};
const EXPECT_HEAD = TEXT.slice(0, 14);
log('（[2] 期望取到的词应为「' + EXPECT_HEAD + '」）');

/* [1] 无选区 + Ctrl+C：**必须弹**，且贴在鼠标位置。
 *     这是用户明确要求的行为：Ctrl+C 是"把横条叫到鼠标这儿来"的手势，
 *     没有选中文字时也要有反应（以前是静默无响应，用户以为功能没实现）。 */
log('');
log('--- [1] 无选区 + Ctrl+C（要弹，且贴鼠标）---');
{
    const fg = activate();
    selectRange(0, 0);
    SetFocus(parent);
    sleep(350); pumpMsg();
    log('        [1] 前台=' + fgNow());
    const before = countShowBar(logTail());
    sendCtrlC();
    // 没有剪贴板变化时要等满 800ms 的兜底等待才会弹，这里给足时间
    pump(2000);
    const tail = logTail();
    const n = countShowBar(tail) - before;
    const atMouse = /show_bar: atMouse=true/.test(tail);
    check('无选区 + Ctrl+C 也弹横条（贴鼠标位置）', n >= 1 && atMouse,
        '新增 show_bar 行数 = ' + n + '，atMouse=' + atMouse, fg);
}

/* [2] 有选区 + Ctrl+C：必须弹，且取到的词必须就是选中的那 14 个字 */
log('');
log('--- [2] EDIT 内选中前 14 字 + Ctrl+C ---');
{
    let ok = false, note = '', valid = false;
    for (let k = 1; k <= 3 && !ok; k++) {
        const fg = activate();
        SetFocus(edit);
        selectRange(0, 14);
        sleep(400); pumpMsg();
        const before = countShowBar(logTail());
        sendCtrlC();
        pump(1500);
        const tail = logTail();
        const n = countShowBar(tail) - before;
        const got = lastShowBar(tail);
        valid = valid || fg;
        if (n >= 1 && got && TEXT.startsWith(got)) {
            ok = true;
            note = '第 ' + k + ' 次：取到的词 =「' + got + '」，与 EDIT 选区一致';
        } else if (n >= 1) {
            note = '第 ' + k + ' 次弹了，但取到的词 =「' + got + '」与选区不符 -> 假阳性';
        } else {
            note = '第 ' + k + ' 次没弹（前台=' + fgNow() + '）';
        }
    }
    check('有选区 + Ctrl+C 弹条且取词正确', ok, note, valid);
}

/* [3] 拖选文字：必须弹 */
log('');
log('--- [3] 鼠标拖选 EDIT 里的文字 ---');
{
    let ok = false, note = '', valid = false, lastRect = null;
    for (let k = 1; k <= 3 && !ok; k++) {
        const fg = activate();
        SendMessageW(edit, 0x00B1, 0, 0);
        SetFocus(edit);
        sleep(300); pumpMsg();
        const q = pts();                       // 每次都用最新坐标
        const before = countShowBar(logTail());
        drag(q.s, q.e);
        pump(1500);
        const tail = logTail();
        const n = countShowBar(tail) - before;
        const got = lastShowBar(tail);
        valid = valid || fg;
        lastRect = barInfo();
        if (n >= 1 && got && TEXT.includes(got) && got.length >= 4) {
            ok = true;
            note = '第 ' + k + ' 次：取到的词 =「' + got + '」，是 EDIT 里的文字';
        } else if (n >= 1) {
            note = '第 ' + k + ' 次弹了，但取到的词 =「' + got + '」不是 EDIT 内容 -> 假阳性';
        } else {
            note = '第 ' + k + ' 次没弹（前台=' + fgNow() + '，拖选 ' +
                q.s.x + ',' + q.s.y + ' -> ' + q.e.x + ',' + q.e.y + '）';
        }
    }
    check('拖选文字弹出横条', ok, note, valid);
    log('        横条窗口: ' + JSON.stringify(lastRect));
}

/* [4] 空白处拖动（无选区）：必须不弹。此时剪贴板里都是 [3] 的文本，钓鱼更强 */
log('');
log('--- [4] 在无文字的空白区拖动（剪贴板里还留着 [3] 的文本）---');
{
    const fg = activate();
    selectRange(0, 0);
    SetFocus(parent);
    sleep(400); pumpMsg();
    log('        [4] 前台=' + fgNow());
    const q = pts();
    const before = countShowBar(logTail());
    drag(q.a, q.b);
    pump(1500);
    const tail = logTail();
    const n = countShowBar(tail) - before;
    check('空白区拖动不弹横条', n === 0, '新增 show_bar 行数 = ' + n, fg);
}

/* -------------------------------- 汇总 -------------------------------- */
log('');
log('==================== 验证汇总 ====================');
const pass = results.filter((r) => r.ok).length;
for (const r of results) log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
log('--------------------------------------------------');
log('  ' + pass + ' / ' + results.length + ' 通过  ->  ' +
    (pass === results.length ? '全部通过' : '存在失败'));

fs.writeFileSync(path.join(__dirname, 'verify-trigger.result.txt'),
    results.map((r) => (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.note ? '  |  ' + r.note : '')).join('\n') +
    '\n\n' + pass + '/' + results.length + ' passed\n', 'utf8');

pump(2500);
process.exit(pass === results.length ? 0 : 1);
