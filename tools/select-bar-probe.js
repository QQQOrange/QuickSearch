/* ============================================================================
 *  划词弹条 · 「识别结果窗开着时，别处选中文字不弹条」专项探针
 *
 *  复现的真实场景（用户日志实录）：
 *    用户开着「识别结果」窗口 → 切回浏览器/别的软件 → 在屏幕中间划选文字
 *    → up-check 打的是 trySelect=false → 什么都不发生（横条不出现）。
 *
 *  根因（src/main.rs should_try_select）：
 *    point_in_any_window(x, y, ["ocr","region","picker"]) 用的是**窗口矩形**，
 *    不看那个窗口此刻是不是真的在鼠标底下。识别结果窗是 .center() 开的、
 *    尺寸按用户上次拖的结果（200% 缩放下约 1222×1158 物理像素），
 *    于是屏幕中间一大片区域被它「隔着」判成"在 OCR 窗里划选"，
 *    哪怕它已经被别的窗口盖住 / 已经最小化 —— 横条一律不弹。
 *
 *  判据：QuickSearch 自己的日志
 *    · trySelect=true  + start_capture: 编辑控件 通道拿到 N chars
 *    · after-show: visible=true
 *
 *  用法：node tools/select-bar-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'select-bar-probe.txt');

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
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const SetWindowTextW = user32.func('int SetWindowTextW(void *h, str16 s)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, void *buf, int max)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, void *buf, int max)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const AttachThreadInput = user32.func('int AttachThreadInput(int a, int b, int f)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const BringWindowToTop = user32.func('int BringWindowToTop(void *h)');
const PeekMessageW = user32.func('int PeekMessageW(_Out_ MSG *m, void *h, uint32 a, uint32 b, uint32 r)');
const TranslateMessage = user32.func('int TranslateMessage(MSG *m)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(MSG *m)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetTopWindow = user32.func('void *GetTopWindow(void *h)');
const GetDesktopWindow = user32.func('void *GetDesktopWindow()');
const GetWindow = user32.func('void *GetWindow(void *h, uint32 cmd)');
const IsIconic = user32.func('int IsIconic(void *h)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS,
    Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)), 0, 0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const msg = {};
const pumpMsg = () => { let n = 0; while (n++ < 500 && PeekMessageW(msg, null, 0, 0, 1)) { TranslateMessage(msg); DispatchMessageW(msg); } };
const pump = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { pumpMsg(); sleep(15); } };

const clsOf = (h) => { const b = new Uint16Array(256); const n = GetClassNameW(h, b, 256); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]); return s; };
const titleOf = (h) => { const b = new Uint16Array(512); const n = GetWindowTextW(h, b, 512); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]); return s; };
const rectOf = (h) => { const r = {}; GetWindowRect(h, r); return r; };

function findTopLevel(pred) {
    let h = GetTopWindow(GetDesktopWindow());
    let guard = 0;
    while (h && guard++ < 4000) {
        try { if (pred(h)) return h; } catch (e) { }
        h = GetWindow(h, 2 /* GW_HWNDNEXT */);
    }
    return null;
}

function forceForeground(h) {
    if (String(GetForegroundWindow()) === String(h)) return true;
    const fg = GetForegroundWindow();
    const b1 = Buffer.alloc(4), b2 = Buffer.alloc(4);
    const tFg = GetWindowThreadProcessId(fg, b1);
    const tH = GetWindowThreadProcessId(h, b2);
    const attached = tFg && tH && tFg !== tH ? AttachThreadInput(tFg, tH, 1) : 0;
    BringWindowToTop(h);
    const ok = !!SetForegroundWindow(h);
    if (attached) AttachThreadInput(tFg, tH, 0);
    return ok;
}

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
const info = (n, d) => rec('  INFO  ' + n + (d ? '   [' + d + ']' : ''));

/* ------------------------------ 目标软件窗口 ------------------------------ */
const EDIT_TEXT = 'Quick Search 选中即弹出横条：这是一段用来验证取词稳定性的中文测试文本。';
const proc = koffi.register((h, m, w, l) => DefWindowProcW(h, m, w, l), koffi.pointer(WNDPROC));
const inst = GetModuleHandleW(null);
const CLS = 'QSSelectBarTarget';
RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0x0003, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00F0F0F0), lpszMenuName: null,
    lpszClassName: CLS, hIconSm: null
});
const PW = 700, PH = 260;
const parent = CreateWindowExW(0, CLS, '划词弹条验证窗', 0x00CF0000 | 0x10000000,
    100, 200, PW, PH, null, null, inst, null);
const EH = 110;
const edit = CreateWindowExW(0, 'EDIT', '',
    0x40000000 | 0x10000000 | 0x00200000 | 0x0040,
    10, 10, PW - 20, EH, parent, null, inst, null);
SetWindowTextW(edit, EDIT_TEXT);

/* 自绘/静态文字：没有 EDIT 那种"选区"接口，UIA 也没有文本模式 ——
 * 用来验证「编辑控件通道 + UIA 都拿不到 → OCR 兜底」那条路（第 3 段用）。 */
const STATIC_TEXT = '选中文字就弹横条 这段字是画在窗口上的 取词兜底测试';
const SY = EH + 24;
const stat = CreateWindowExW(0, 'Static', STATIC_TEXT,
    0x40000000 | 0x10000000 | 0x00000000,   // WS_CHILD | WS_VISIBLE | SS_LEFT
    10, SY, PW - 20, 40, parent, null, inst, null);

/** 把目标窗摆到 (x,y)，置顶并抢前台 */
function placeAt(x, y) {
    SetWindowPos(parent, -1 /* HWND_TOPMOST */, x, y, PW, PH, 0x0040);
    sleep(200); pumpMsg();
    for (let i = 0; i < 6; i++) {
        if (String(GetForegroundWindow()) === String(parent)) break;
        // 点客户区底部空白带（不碰 EDIT、不碰标题栏）
        moveTo(x + 24, y + PH - 14);
        sleep(140);
        mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(60);
        mouse_event(LEFT_UP, 0, 0, 0, 0);
        sleep(420); pumpMsg();
    }
    return String(GetForegroundWindow()) === String(parent);
}

/** 在某个子控件的局部坐标里划选一段（y 取控件内的高度） */
function dragSelect(hwnd, y, ax, bx) {
    const a = { x: ax, y: y }, b = { x: bx, y: y };
    ClientToScreen(hwnd, a); ClientToScreen(hwnd, b);
    moveTo(a.x + 3, a.y); sleep(150); pumpMsg();
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(6);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
        moveTo(Math.round(a.x + (b.x - a.x) * i / steps), a.y);
        sleep(14); pumpMsg();
    }
    sleep(30); pumpMsg();
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    pumpMsg();
}

/* ------------------------------ 隔离实例 ------------------------------ */
const SANDBOX = path.join(os.tmpdir(), 'qs-selectbar-' + process.pid);
const QS = path.join(SANDBOX, 'QuickSearch');
const LOG = path.join(QS, 'log.txt');

let child = null;
const children = [];
function killInstance() { for (const c of children) { try { c.kill(); } catch (e) { } } child = null; }
const logSince = (off) => { try { return fs.readFileSync(LOG).slice(off).toString('utf8'); } catch (e) { return ''; } };
const logSize = () => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } };

/** 日志行里的时间戳（`intervals` 是 100ns 计数）。只取到毫秒，避开双精度精度损失。 */
function ticksOf(s, re) {
    for (const line of s.split(/\r?\n/)) {
        if (re.test(line)) {
            const m = line.match(/intervals: (\d+)/);
            if (m) return Number(m[1].slice(0, -4));
        }
    }
    return null;
}

/** 起一个隔离实例。extra 覆盖 config.json 字段。 */
function boot(extra, args) {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(QS, { recursive: true });
    fs.writeFileSync(path.join(QS, 'config.json'), JSON.stringify(Object.assign({
        trigger_select: true, trigger_copy: false, ocr_enable: true,
        auto_color: false, auto_start: false, delay_ms: 0,
        filter_mode: 'off', filter_list: [],
        webdav_url: '', webdav_user: '', webdav_pass: '',
        webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
        backup_dir: '', overrides: {}, fav_hotkey: '', custom_engines: [],
        bar_glass: false, bar_dim_alpha: 100, theme: 'light',
        ocr_win_w: 611, ocr_win_h: 579,
    }, extra || {}), null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: SANDBOX, LOCALAPPDATA: SANDBOX,
        WEBVIEW2_USER_DATA_FOLDER: path.join(SANDBOX, 'wv2'),
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_INSTANCE_TAG: 'selectbar',
        QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-sandbox',
    });
    child = spawn(EXE, ['--no-elevate'].concat(args || []), { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    children.push(child);
    rec('启动实例 pid=' + child.pid + (args && args.length ? '（' + args.join(' ') + '）' : ''));
    return child;
}

/* ------------------------------ 主流程 ------------------------------ */
(async function main() {
    rec('隔离实例：' + SANDBOX);
    // --ocr-demo：启动后直接把「识别结果」窗口开出来（居中，尺寸按配置）
    boot({}, ['--ocr-demo']);

    // 等 OCR 窗口出现
    let ocr = null;
    for (let i = 0; i < 60; i++) {
        pump(200);
        ocr = findTopLevel((h) => titleOf(h).includes('识别结果') && IsWindowVisible(h));
        if (ocr) break;
    }
    chk('识别结果窗已打开', !!ocr, ocr ? ('hwnd=' + ocr + ' 标题「' + titleOf(ocr) + '」') : '没找到');
    if (!ocr) { finish(); return; }
    const orc = rectOf(ocr);
    info('识别结果窗矩形', `(${orc.left},${orc.top})-(${orc.right},${orc.bottom})  ${orc.right - orc.left}×${orc.bottom - orc.top}`);
    chk('识别结果窗确实可见且未最小化', IsWindowVisible(ocr) !== 0 && IsIconic(ocr) === 0);

    // 等钩子装好
    for (let i = 0; i < 40; i++) { if (logSize() > 0 && /hook:/.test(logSince(0))) break; pump(200); }

    /* ============ 第 1 段：目标窗摆在「识别结果窗矩形之内」 ============ */
    rec('');
    rec('========== 第 1 段：目标软件窗口压在识别结果窗矩形之内 ==========');
    const inX = Math.round((orc.left + orc.right) / 2 - PW / 2);
    const inY = Math.round((orc.top + orc.bottom) / 2 - PH / 2);
    info('目标窗位置', `(${inX},${inY})  在识别结果窗矩形内=${inX > orc.left && inX + PW < orc.right && inY > orc.top && inY + PH < orc.bottom}`);
    const okFg1 = placeAt(inX, inY);
    chk('目标软件抢到前台', okFg1, '前台=' + GetForegroundWindow());

    let off = logSize();
    dragSelect(edit, 16, 12, 330);
    pump(2500);
    let s = logSince(off);
    const up1 = (s.match(/up-check:[^\r\n]*/g) || []).slice(-1)[0] || '(无)';
    info('up-check', up1.replace(/^up-check: /, ''));
    chk('第 1 段：识别结果窗只是被盖住，划选照旧判定为「可划选」',
        /trySelect=true/.test(up1), up1.match(/trySelect=\w+/)?.[0] || '');
    chk('第 1 段：选中文字后横条出现',
        /start_capture: 编辑控件 通道拿到 \d+ chars/.test(s) && /after-show: visible=true/.test(s),
        (s.match(/start_capture: [^\r\n]*/) || ['(没拿到文字)'])[0]);

    /* ============ 第 2 段：目标窗搬到「识别结果窗矩形之外」（对照组） ============ */
    rec('');
    rec('========== 第 2 段：目标软件窗口搬到识别结果窗矩形之外（对照） ==========');
    const outX = 120, outY = SH - PH - 120;
    info('目标窗位置', `(${outX},${outY})  在识别结果窗矩形内=${outX > orc.left && outX + PW < orc.right && outY > orc.top && outY + PH < orc.bottom}`);
    const okFg2 = placeAt(outX, outY);
    chk('目标软件抢到前台（对照）', okFg2, '前台=' + GetForegroundWindow());

    off = logSize();
    dragSelect(edit, 16, 12, 330);
    pump(2500);
    s = logSince(off);
    const up2 = (s.match(/up-check:[^\r\n]*/g) || []).slice(-1)[0] || '(无)';
    info('up-check', up2.replace(/^up-check: /, ''));
    chk('第 2 段：矩形之外划选判定为可划选（对照）', /trySelect=true/.test(up2), up2.match(/trySelect=\w+/)?.[0] || '');
    chk('第 2 段：选中文字后横条出现（对照）',
        /start_capture: 编辑控件 通道拿到 \d+ chars/.test(s) && /after-show: visible=true/.test(s),
        (s.match(/start_capture: [^\r\n]*/) || ['(没拿到文字)'])[0]);

    /* ============ 第 3 段：OCR 兜底的引擎顺序与「第二机会」 ============
     * 配置故意把「识别引擎」设成百度 + 假密钥，用来观察两件事：
     *   3a 屏幕上画着的字 → **本机引擎先上**、立刻认出来，且压根不碰百度
     *      （百度 0.5~3.4s，一旦排在前面就等于每次划选白等三秒）；
     *   3b 空白区（本机认不出）→ **换百度再兜一次**（第二机会确实在跑）。 */
    rec('');
    rec('========== 第 3 段：OCR 兜底的引擎顺序与第二机会 ==========');
    killInstance();
    pump(600);
    boot({ ocr_engine: 'baidu', ocr_key: 'bogus-key', ocr_secret: 'bogus-secret' }, []);
    for (let i = 0; i < 40; i++) { if (logSize() > 0 && /hook:/.test(logSince(0))) break; pump(200); }
    const okFg3 = placeAt(120, SH - PH - 120);
    chk('目标软件抢到前台（第 3 段）', okFg3, '前台=' + GetForegroundWindow());

    /* 3a：Static 上的字（编辑控件通道 / UIA 都拿不到 → 必然落到 OCR 兜底） */
    off = logSize();
    dragSelect(stat, 20, 12, 330);
    for (let i = 0; i < 60; i++) {
        pump(100);
        if (/after-show: visible=true/.test(logSince(off))) break;
    }
    pump(800);
    s = logSince(off);
    info('取词链', (s.match(/capture: [^\r\n]*/g) || []).slice(0, 4).join(' | ') || '(无)');
    chk('3a：走的确实是 OCR 兜底（不是编辑控件通道）',
        !/编辑控件 通道拿到/.test(s) && /转 OCR 兜底|OCR 兜底/.test(s));
    /* ⚠ r46 起划词兜底的日志用的是**引擎显示名**（注册表里的名字）：
     *   「用本地识别引擎认到…」「换百度云引擎再兜一次…」—— 因为第二棒不再是写死的
     *   百度，而是设置里配的那家（用户报的"加了但没用上"）。所以正则两种写法都收。 */
    const LOCAL_GOT = /capture\(ocr\): 用(本地识别|本地)引擎认到 \d+ 字/;
    const LOCAL_FAIL = /capture\(ocr\): (本地识别|本地)引擎(识别失败|没认出字)/;
    const SWITCH_2ND = /capture\(ocr\): 上一个引擎没认出来，换(百度云|百度)引擎再兜一次/;
    const BAIDU_FAIL = /capture\(ocr\): 百度云引擎识别失败/;
    chk('3a：本机引擎认出来了', LOCAL_GOT.test(s),
        (s.match(/capture\(ocr\): 用[^\r\n]*引擎认到 [^\r\n]*/) || ['(没有这条)'])[0]);
    chk('3a：没有去等百度（本机认出来就不该再花一次网络）',
        !/百度/.test(s));
    /* 只量 OCR 那一段（"转 OCR 兜底" → "认到字"）：UIA 重试、选区落地稳定期
     * 都在它前面，混进来会把"本机引擎有多快"这件事测糊。百度同口径实测
     * 0.5~3.4s（用户日志），本机引擎是几十毫秒。 */
    const tOcr = ticksOf(s, /转 OCR 兜底/);
    const tGot = ticksOf(s, /capture\(ocr\): 用(本地识别|本地)引擎认到/);
    const ocrMs = (tOcr && tGot) ? (tGot - tOcr) : -1;
    chk('3a：OCR 那一段 < 800ms（百度同口径是 0.5~3.4s）', ocrMs >= 0 && ocrMs < 800,
        ocrMs >= 0 ? (ocrMs + 'ms') : '没量到时间戳');
    chk('3a：选中文字后横条出现',
        /start_capture: OCR 通道拿到 \d+ chars/.test(s) && /after-show: visible=true/.test(s),
        (s.match(/start_capture: OCR 通道拿到 [^\r\n]*/) || ['(没拿到文字)'])[0]);

    /* 3b：空白区拖动（本机认不出 → 第二机会应该轮到百度）
     * ⚠ 两个几何坑（都踩过）：
     *   ① 窗口 260 高是**含标题栏和边框**的，客户区只有 ~194 高；拖到客户区
     *      之外会落到桌面（日志原样：`cls=SysListView32 trySelect=false`）。
     *      空白带 = Static 下方 client y 174~194，取 185。
     *   ② 3a 的横条锚在原位置下方，不把窗口搬走的话这次 mousedown 会落在横条上
     *      （barOuterStart=true）→ 整段静默失效。搬到 (120,500) 时那次点击
     *      本身就会把横条收掉（日志里的 dismiss_bar）。 */
    rec('  [说明] 3b 前把目标窗搬到 (120,500)（顺带收掉 3a 的横条），再划空白带 y=185');
    placeAt(120, 500);
    pump(400);
    off = logSize();
    dragSelect(parent, 185, 12, 330);
    pump(9000);
    s = logSince(off);
    const tail = s.split(/\r?\n/).filter(x => x.trim()).slice(-8)
        .map(x => x.replace(/^\[SystemTime \{[^}]*\}\] /, ''));
    info('3b 日志尾部', '\n      ' + tail.join('\n      '));
    info('取词链', (s.match(/capture\(ocr\): [^\r\n]*/g) || []).slice(0, 4).join(' | ') || '(无)');
    chk('3b：本机引擎先上且没认出字', LOCAL_FAIL.test(s));
    chk('3b：本机没认出来 → 换设置里配的那家再兜一次（第二机会在跑）',
        SWITCH_2ND.test(s));
    chk('3b：百度（假密钥）失败被如实记录',
        BAIDU_FAIL.test(s),
        (s.match(/capture\(ocr\): 百度云引擎识别失败[^\r\n]*/) || ['(没有这条)'])[0].slice(0, 80));
    chk('3b：两边都没认出字 → 不弹空条（空白拖动不该弹）',
        /start_capture: 没拿到文字，不弹/.test(s) && !/after-show: visible=true/.test(s));

    finish();
})();

function finish() {
    rec('');
    rec(`========== 汇总：PASS ${passN} / FAIL ${failN} ==========`);
    flush();
    killInstance();
    setTimeout(() => process.exit(failN ? 1 : 0), 300);
}
