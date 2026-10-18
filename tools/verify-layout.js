/* ============================================================================
 *  横条摆位（位置自适应）端到端验证
 *
 *  用户要求：
 *    · 选中文字 → 横条出现在**文字**的上面或下面；
 *    · 文字已经贴到屏幕最上方、上面没地方了 → 改放到下面；
 *    · 文字贴到屏幕最下方、下面没地方了 → 改放到上面；
 *    · 没选中文字、走 Ctrl+C 触发的 → 跟随**鼠标**。
 *
 *  判定依据 = QuickSearch 日志里的 `place:` 行（由 main.rs 的 layout_bar 落盘），
 *  它同时给出：最终选了哪一侧、文字那行的矩形、胶囊落点。
 *  再用 GetWindowRect 把真实窗口位置和日志里的 win=(x,y) 对一遍，
 *  确认「算出来的」和「实际摆的」是同一个地方。
 *
 *  4 个用例：
 *    [A] 文字在屏幕中部      -> 默认优先放**上面**
 *    [B] 文字贴屏幕最下方    -> 下面没地方，必须翻到**上面**
 *    [C] 文字贴屏幕最上方    -> 上面没地方，改放**下面**
 *    [D] Ctrl+C（未选中）    -> 必须**贴鼠标**（side=mouse）
 *
 *  前置：QuickSearch.exe 带 QS_DEBUG=1 QS_ALLOW_INJECTED=1 --no-elevate 运行
 *  用法：node verify-layout.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const TRACE = path.join(__dirname, 'verify-layout.trace.txt');
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
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const SendMessageW = user32.func('intptr SendMessageW(void *h, uint32 m, uintptr w, intptr l)');
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
// SPI_GETWORKAREA = 0x0030 —— 拿到去掉任务栏之后的工作区，判断「放不下」才有意义
const SystemParametersInfoW = user32.func('int SystemParametersInfoW(uint32 a, uint32 b, _Out_ RECT *p, uint32 f)');

const work = {};
SystemParametersInfoW(0x0030, 0, work, 0);
const SW = work.right - work.left, SH = work.bottom - work.top;
log('工作区 (物理像素): left=' + work.left + ' top=' + work.top +
    ' right=' + work.right + ' bottom=' + work.bottom);
log('           -> ' + SW + ' x ' + SH);
log('');

const moveTo = (x, y) => mouse_event(0x0001 | 0x8000,
    Math.round(Math.max(0, Math.min(work.right - 1, x)) * 65535 / (work.right - 1)),
    Math.round(Math.max(0, Math.min(work.bottom - 1, y)) * 65535 / (work.bottom - 1)), 0, 0);

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
const pumpMsg = () => {
    let n = 0;
    while (n++ < 500 && PeekMessageW(msg, null, 0, 0, 1)) {
        TranslateMessage(msg); DispatchMessageW(msg);
    }
};

/* ------------------------------- 日志 ------------------------------- */
const LOG = path.join(process.env.APPDATA, 'QuickSearch', 'log.txt');
let offset = 0;
try { offset = fs.statSync(LOG).size; } catch (e) { offset = 0; }
const logTail = () => {
    try { return fs.readFileSync(LOG, 'utf8').slice(offset); } catch (e) { return ''; }
};
/** 解析一条 place: 行 */
function parsePlace(line) {
    const g = (re) => { const m = line.match(re); return m ? m[1] : null; };
    const side = g(/side=([\w-]+)/);
    // caret 可能是 None，也可能是 Some((l, t, r, b)) —— 两种都要认
    const part = line.split('caret=')[1] || '';
    const cm = part.match(/(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
    const caret = cm ? { l: +cm[1], t: +cm[2], r: +cm[3], b: +cm[4] } : null;
    const im = line.match(/inner=\((-?\d+),(-?\d+)\)/);
    const wm = line.match(/win=\((-?\d+),(-?\d+)\)/);
    return {
        raw: line, side, caret,
        gap: +g(/gap=(-?\d+)/), barPh: +g(/barPh=(-?\d+)/), limit: +g(/limit=(-?\d+)/),
        inner: im ? { x: +im[1], y: +im[2] } : null,
        win: wm ? { x: +wm[1], y: +wm[2] } : null
    };
}

/**
 * 把每条 place: 和它前面那条 show_bar 配对，标出这次是「贴文字」还是「贴鼠标」。
 *
 * 为什么必须配对：测试环境开了 QS_ALLOW_INJECTED=1，于是取词用的那次合成
 * Ctrl+C 也会被键盘钩子当成一次真实复制，多弹一条**贴鼠标**的横条，把刚才
 * 那条贴文字的覆盖掉。生产环境钩子会挡掉注入按键（LLKHF_INJECTED），
 * 不会有这个现象 —— 但测试里必须挑对，否则读到的是被覆盖后的结果。
 */
function placeRecords(s) {
    const out = [];
    let mode = null;
    for (const raw of s.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const idx = line.indexOf('show_bar:');
        if (idx >= 0) {
            if (line.includes('atMouse=')) {
                mode = /atMouse=true/.test(line) ? 'mouse' : 'text';
            }
            continue;
        }
        if (line.includes('place:')) {
            const rec = parsePlace(line);
            rec.mode = mode;
            out.push(rec);
        }
    }
    return out;
}

/** 取最后一条指定模式的摆位记录 */
function lastPlace(s, wantMode) {
    const recs = placeRecords(s).filter((r) => !wantMode || r.mode === wantMode);
    return recs.length ? recs[recs.length - 1] : null;
}

const TEXT = 'Quick Search 选中即弹出横条：这是一段用来验证取词的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const cls = 'QSVerifyLayoutWindow';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: cls, hIconSm: null
});

const PW = 900, PH = 420, PX = 1300, PY = 200;
const EH = 240;
const parent = CreateWindowExW(0, cls, 'QS 摆位验证窗口', 0x00CF0000 | 0x10000000,
    PX, PY, PW, PH, null, null, inst, null);
if (!parent) { log('创建窗口失败'); process.exit(1); }

const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    12, 12, PW - 28, EH, parent, null, inst, null);
SetWindowTextW(edit, TEXT);

ShowWindow(parent, 5);
SetWindowPos(parent, 0, PX, PY, PW, PH, 0x0040);
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
/** 文字那一行在屏幕上的 y（物理像素）—— 就是 Ctrl+C / 拖选时鼠标所在的高度 */
function textLineY() {
    const p = { x: 16, y: 22 };
    ClientToScreen(edit, p);
    return p.y;
}
/** 把窗口竖着挪一挪，让文字那行落到屏幕上某个 y */
function putTextLineAt(targetY) {
    const r = {};
    GetWindowRect(parent, r);
    const delta = targetY - textLineY();
    const ny = r.top + delta;
    SetWindowPos(parent, -1 /* TOPMOST */, r.left, ny, PW, PH, 0x0040);
    sleep(260); pumpMsg();
    SetWindowPos(parent, -2 /* NOTOPMOST */, r.left, ny, PW, PH, 0x0040);
    sleep(160); pumpMsg();
}
function activate() {
    SetWindowPos(parent, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // NOSIZE|NOMOVE|SHOWWINDOW
    sleep(150); pumpMsg();
    for (let i = 0; i < 5; i++) {
        if (sameHwnd(GetForegroundWindow(), parent)) return true;
        const wr = {};
        GetWindowRect(parent, wr);
        moveTo(wr.left + 20, wr.bottom - 18);
        sleep(140);
        mouse_event(0x0002, 0, 0, 0, 0); sleep(70);
        mouse_event(0x0004, 0, 0, 0, 0);
        sleep(400); pumpMsg();
    }
    return sameHwnd(GetForegroundWindow(), parent);
}
const fgNow = () => (sameHwnd(GetForegroundWindow(), parent) ? '本窗口' : winInfo(GetForegroundWindow()));

/** EM_SETSEL(0x00B1)：给 EDIT 设选区。(0,0) 就是「没有选中任何文字」 */
const selectRange = (a, b) => SendMessageW(edit, 0x00B1, a, b);

function dragSelect() {
    const a = { x: 16, y: 22 }, b = { x: 430, y: 22 };
    ClientToScreen(edit, a);
    ClientToScreen(edit, b);
    moveTo(a.x + 4, a.y); sleep(130); pumpMsg();
    mouse_event(0x0002, 0, 0, 0, 0); sleep(130); pumpMsg();
    for (let i = 1; i <= 18; i++) {
        moveTo(Math.round(a.x + (b.x - a.x) * i / 18), a.y);
        sleep(32); pumpMsg();
    }
    sleep(170); pumpMsg();
    mouse_event(0x0004, 0, 0, 0, 0);
    pump(1400);
}
function sendCtrlC() {
    keybd_event(0x11, 0, 0, 0); sleep(70);
    keybd_event(0x43, 0, 0, 0); sleep(100);
    keybd_event(0x43, 0, 2, 0); sleep(60);
    keybd_event(0x11, 0, 2, 0);
    pump(1400);
}
function barRect() {
    const h = FindWindowW(null, 'QuickSearchBar');
    if (!h) return null;
    const r = {};
    GetWindowRect(h, r);
    return { h, left: r.left, top: r.top, w: r.right - r.left, h: r.bottom - r.top, vis: !!IsWindowVisible(h) };
}

/* -------------------------------- 用例 -------------------------------- */
const results = [];
function check(name, ok, note, valid) {
    const good = !!ok && valid !== false;
    results.push({ name, ok: good, note: note || '' });
    log((good ? '[PASS] ' : '[FAIL] ') + name);
    if (note) log('        ' + note);
}

function runCase(tag, targetY, expectSide) {
    log('');
    log('--- [' + tag + '] 把文字那行放到屏幕 y=' + targetY + '（期望 side=' + expectSide + '）---');
    putTextLineAt(targetY);

    const before = logTail();
    const fg = activate();
    if (!fg) log('        ⚠ 前台没抢到，结论不可信（当前前台=' + fgNow() + '）');
    selectRange(0, 0);

    if (expectSide === 'mouse') {
        // Ctrl+C 路径：焦点必须落在 **EDIT** 上。
        // 设到父窗口的话 Ctrl+C 复制不到选区，剪贴板序号不变，自然不会弹。
        // （和 verify-trigger 里已跑通的那个场景保持一致。）
        SetFocus(edit);
        SendMessageW(edit, 0x00B1, 0, 14);
        sleep(400); pumpMsg();
        sendCtrlC();
    } else {
        SetFocus(edit);
        sleep(300); pumpMsg();
        dragSelect();
    }

    const tail = logTail().slice(before.length);
    // 拖选路径认 'text'（贴文字），Ctrl+C 路径认 'mouse'（贴鼠标）。
    // 见 placeRecords 的注释：测试环境会多一条贴鼠标的记录，必须挑对。
    const wantMode = expectSide === 'mouse' ? 'mouse' : 'text';
    const p = lastPlace(tail, wantMode);
    if (!p) {
        check('[' + tag + '] 拿到摆位记录', false,
            '日志里没有 mode=' + wantMode + ' 的 place: 行', fg);
        return null;
    }
    const caret = p.caret ? ('caret=(' + p.caret.l + ',' + p.caret.t + ',' + p.caret.r + ',' + p.caret.b + ')') : 'caret=null';
    log('        ' + p.raw);
    log('        文字行 y=' + (p.caret ? p.caret.t + '~' + p.caret.b : 'n/a'));

    const gotSide = p.side;
    let geoOk = true, geoNote = '';
    if (expectSide === 'above') {
        // 胶囊底边应贴在文字上沿之上：inner.y + barPh <= caret.t
        geoOk = p.caret && (p.inner.y + p.barPh) <= p.caret.t;
        geoNote = '胶囊底 ' + (p.inner.y + p.barPh) + ' <= 文字顶 ' + (p.caret ? p.caret.t : '?');
    } else if (expectSide === 'below') {
        // 胶囊顶边应贴在文字下沿之下：inner.y >= caret.b
        geoOk = p.caret && p.inner.y >= p.caret.b;
        geoNote = '胶囊顶 ' + p.inner.y + ' >= 文字底 ' + (p.caret ? p.caret.b : '?');
    }
    const sideOk = gotSide === expectSide;
    check('[' + tag + '] side=' + expectSide, sideOk, '实际 side=' + gotSide + '  ' + caret, fg);
    if (expectSide !== 'mouse') {
        check('[' + tag + '] 几何关系正确', geoOk, geoNote, fg);
    }

    // 实际窗口位置 vs 日志里的 win=(x,y)
    const br = barRect();
    if (br && p.win) {
        const dx = Math.abs(br.left - p.win.x), dy = Math.abs(br.top - p.win.y);
        check('[' + tag + '] 真实窗口落在算出的位置', dx <= 2 && dy <= 2,
            'GetWindowRect=(' + br.left + ',' + br.top + ') 日志 win=(' + p.win.x + ',' + p.win.y + ') 误差 dx=' + dx + ' dy=' + dy,
            fg);
    }
    return p;
}

const midY = Math.round(work.top + SH * 0.5);
const topY = work.top + 70;
const bottomY = work.bottom - 22;

/*
 * 为什么要分两轮跑（`--text` / `--mouse`）：
 *
 * 测试环境必须开 QS_ALLOW_INJECTED，否则注入的鼠标事件会被钩子挡掉、压根不触发。
 * 但开了之后，取词用的那次合成 Ctrl+C 也会被键盘钩子当成一次真实复制 ——
 * 于是「拖选」和「Ctrl+C」两条路径**并发**跑在各自的线程上：
 *   · 两条都会写同一个 Geo 状态，后到的把先到的锚点覆盖掉；
 *   · 日志里 show_bar / place 交错，无法按前后顺序配对。
 * 结果是拖选那条贴文字的记录可能被写成 side=mouse，测出假阳性。
 *
 * 生产环境不存在这个问题（钩子按 LLKHF_INJECTED 挡掉注入按键），
 * 但测试里必须把两条路径分开跑才可信：
 *   --text  ：配置里把「复制后弹条」关掉，只跑拖选（A/B/C）
 *   --mouse ：配置里把「复制后弹条」打开，只跑 Ctrl+C（D）
 */
const ONLY = process.argv.includes('--mouse') ? 'mouse'
    : process.argv.includes('--text') ? 'text'
        : 'all';

log('======== 摆位验证开始（模式 = ' + ONLY + '）========');
if (ONLY !== 'mouse') {
    runCase('A 中部', midY, 'above');
    runCase('B 贴底', bottomY, 'above');
    runCase('C 贴顶', topY, 'below');
}
if (ONLY !== 'text') {
    runCase('D Ctrl+C', midY, 'mouse');
}

log('');
log('==================== 验证汇总 ====================');
const pass = results.filter((r) => r.ok).length;
for (const r of results) log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
log('--------------------------------------------------');
log('  ' + pass + ' / ' + results.length + ' 通过  ->  ' +
    (pass === results.length ? '全部通过' : '存在失败'));

fs.writeFileSync(path.join(__dirname, 'verify-layout.result.txt'),
    results.map((r) => (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.note ? '  |  ' + r.note : '')).join('\n') +
    '\n\n' + pass + '/' + results.length + ' passed\n', 'utf8');

pump(2000);
process.exit(pass === results.length ? 0 : 1);
