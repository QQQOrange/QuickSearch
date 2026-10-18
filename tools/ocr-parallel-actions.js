/* ============================================================================
 *  OCR 并行双引擎 e2e 的交互部分（启动 / 收尾由 run-ocr-parallel-e2e.py 驱动）
 *
 *  为什么拆开：实测 QuickSearch.exe 一旦由某个进程拉起，父进程退出后它也会
 *  跟着没（DETACHED_PROCESS 也挡不住）。所以「启动」和「交互」必须在同一个
 *  还活着的进程里完成 —— 这里只做交互，启动交给 Python 那边。
 *
 *  本脚本做三件事：
 *    ① 用**记事本**打开一份写着已知文字的 txt，置顶挪到屏幕固定位置 ——
 *       文字内容完全确定，不靠「屏幕上刚好有文字」的运气（早先那次 e2e 拖的是
 *       桌面，框里有没有字全看当时屏幕上开着什么）。
 *       ⚠ 原本想用 mspaint 打开样例 PNG，实测这台机器 System32 里根本没有
 *       mspaint.exe（Win11 上它是商店应用）—— 记事本一定在，且文本可写死。
 *    ② Ctrl+Alt+O 唤出框选遮罩，拖一块盖住记事本里的文字。
 *       拖选矩形**按记事本编辑框实测位置算**，不猜功能区高度：Win11 记事本是
 *       WinUI 混合窗口，200% 缩放下标签栏/菜单栏/状态栏各占多少随版本变，
 *       所以这里枚举它的子窗口（Microsoft.UI.Content.DesktopChildSiteBridge）
 *       量出菜单栏下沿，再从那儿往下取一段 —— 无论缩放多少都对得上。
 *    ③ 等识别结果窗口出现，把过程写进 trace。
 *
 *  结果窗的文本框内容 / 「重新识别」按钮点击由 ocr-cdp-check.js 用 CDP 做
 *  （WebView2 远程调试协议直连页面，比按坐标点按钮确定得多，还能直接把展示
 *  文字读出来断言【本地识别】/【百度云】标注）。
 *
 *  输出：ocr-parallel.trace.txt，一行一条 OK/NO。
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const EnumChildWindows = user32.func('int EnumChildWindows(void *h, void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(
    koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetDpiForWindow = user32.func('uint32 GetDpiForWindow(void *h)');
const SendInput = user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)');
const ShowWindow = user32.func('int ShowWindow(void *h, int cmd)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ------------------------------ 输入 ------------------------------ */
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
function mouse(flags, x, y) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeInt32LE(Math.round(x * 65535 / (SW - 1)), 8);
    b.writeInt32LE(Math.round(y * 65535 / (SH - 1)), 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(flags, 20);
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return SendInput(1, b, 40);
}
const moveTo = (x, y) => mouse(MOVE | ABS, x, y);
const ldown = (x, y) => mouse(MOVE | ABS | LDOWN, x, y);
const lup = (x, y) => mouse(MOVE | ABS | LUP, x, y);

function kb(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);
    b.writeUInt16LE(vk, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt32LE(up ? 0x0002 : 0, 12);
    b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    return SendInput(1, b, 40);
}
const VK_CONTROL = 0x11, VK_MENU = 0x12, VK_O = 0x4F;

function combo(vk) {
    kb(VK_CONTROL, false); sleep(90);
    kb(VK_MENU, false); sleep(90);
    kb(vk, false); sleep(140);
    kb(vk, true); sleep(70);
    kb(VK_MENU, true); sleep(50);
    kb(VK_CONTROL, true);
}

/* ------------------------------ 窗口 ------------------------------ */
const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
const wclass = (h) => {
    const c = new Uint16Array(400); const cn = GetClassNameW(h, c, 400);
    let s = ''; for (let i = 0; i < cn; i++) s += String.fromCharCode(c[i]);
    return s;
};
const rectOf = (h) => { const r = {}; GetWindowRect(h, r); return r; };

function enumWindows() {
    const out = [];
    const cb = koffi.register((h) => {
        const t = wtext(h);
        if (t && IsWindowVisible(h)) out.push({ hwnd: h, title: t, cls: wclass(h) });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
function enumKids(parent) {
    const out = [];
    const cb = koffi.register((h) => {
        const r = rectOf(h);
        out.push({ hwnd: h, cls: wclass(h),
                   rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] });
        return 1;
    }, ENUMPROC_PTR);
    EnumChildWindows(parent, cb, 0);
    koffi.unregister(cb);
    return out;
}
const titles = () => enumWindows().map((w) => w.title);
const has = (t) => titles().some((x) => x === t);
const hasAny = (sub) => titles().some((x) => x.includes(sub));
function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; sleep(120); }
    return false;
}

/** 拖一个框 */
function drag(x1, y1, x2, y2) {
    moveTo(x1, y1); sleep(150);
    ldown(x1, y1); sleep(150);
    moveTo((x1 + x2) / 2, (y1 + y2) / 2); sleep(150);
    moveTo(x2, y2); sleep(150);
    lup(x2, y2);
}

/**
 * 算出记事本里「文字所在的那块」在屏幕上的矩形。
 *
 * Win11 记事本的顶层窗口是 `Notepad`，文字区是它的子窗口 `RichEditD2DPT`
 * （旧版叫 `NotepadTextBox`）—— 直接量这个子窗口的矩形就是文字区，最准。
 *
 * ⚠ 别去猜「标签栏/菜单栏占多高」：那些栏是 WinUI 的
 *   Microsoft.UI.Content.DesktopChildSiteBridge 子窗口，**竖向滚动条也是同一种类**，
 *   按「顶栏里最靠下的那条」去认菜单栏会把滚动条认成菜单栏（实测踩过：
 *   量出来的文字区跑到窗口最底下，拖选直接拖出屏幕）。
 *
 * 量不到就退回按 DPI 折算（标签栏+菜单栏 ≈ 148 物理像素 @200%）。
 */
function textArea(topHwnd) {
    const r = rectOf(topHwnd);
    const dpi = GetDpiForWindow(topHwnd) || 96;
    const k = dpi / 96;                       // 200% 缩放 → 2
    const kids = enumKids(topHwnd).filter((c) => c.rect[2] > 0 && c.rect[3] > 0);
    const edit = kids.find((c) => c.cls === 'RichEditD2DPT')
              || kids.find((c) => c.cls === 'NotepadTextBox');
    let box, how;
    if (edit) {
        box = edit.rect;
        how = '量出来的编辑框 ' + edit.cls;
    } else {
        const ex = r.left + Math.round(12 * k);
        const ey = r.top + Math.round(74 * k);
        box = [ex, ey, r.right - ex, r.bottom - ey - Math.round(32 * k)];
        how = '按 DPI 折算的编辑框';
    }
    return { rect: r, dpi: dpi, box: box, how: how };
}

/* ------------------------------ 主流程 ------------------------------ */
const lines = [];
const rec = (ok, name, extra) => {
    lines.push((ok ? 'OK  ' : 'NO  ') + name + (ok ? '' : ' | ' + (extra || '')));
};
const flush = () => {
    fs.writeFileSync(path.join(__dirname, 'ocr-parallel.trace.txt'), lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
};

(async function main() {
    // ① 记事本 + 已知文字的 txt
    try { execSync('taskkill /IM notepad.exe /F', { stdio: 'ignore' }); } catch (e) { }
    const txt = path.join(__dirname, '_ocr-sample.txt');
    if (!fs.existsSync(txt)) {
        rec(false, '样例文本不存在', txt);
        flush(); process.exit(0);
    }
    spawn('notepad', [txt], { detached: false, stdio: 'ignore' });

    let nb = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
        const w = enumWindows().find((x) => x.cls === 'Notepad');
        if (w) { nb = w.hwnd; break; }
        sleep(200);
    }
    rec(!!nb, 'P1 记事本打开了样例文本', '没找到 Notepad 类窗口');
    if (!nb) { flush(); process.exit(0); }

    // 置顶 + 挪到固定位置（物理像素）。置顶是必须的 —— 屏幕上可能压着别的
    // 窗口（聊天界面等），截图那一刻谁在上面就拍谁，不能靠运气。
    const HWND_TOPMOST = -1;
    SetWindowPos(nb, HWND_TOPMOST, 120, 260, 1700, 1200, 0x0040 /* SWP_SHOWWINDOW */);
    ShowWindow(nb, 5 /* SW_SHOW */);
    sleep(1100);                              // 等窗口尺寸/内容落定

    const ta = textArea(nb);
    const k = ta.dpi / 96;
    rec(ta.box[2] > 0 && ta.box[3] > 0 && ta.box[1] > ta.rect.top,
        'P2 记事本已置顶就位、量到文字区',
        'rect=' + JSON.stringify(ta.rect) + ' 编辑框=' + JSON.stringify(ta.box));
    lines.push('     （' + ta.how + '，dpi=' + ta.dpi + '）');

    // ② Ctrl+Alt+O 框选：从编辑框左上角往下取一块，稳稳盖住文本前几行
    combo(VK_O);
    const a1 = waitFor(() => has('QS-Region'), 8000);
    rec(a1, 'A1 Ctrl+Alt+O 打开了框选遮罩', '窗口列表=' + JSON.stringify(titles()));
    if (!a1) { flush(); process.exit(0); }
    sleep(800);

    const [ex, ey, ew, eh] = ta.box;
    // 左边/上边留一点点边（文字贴着编辑框左上角开始），右边避开竖向滚动条
    // （它贴在编辑框最右侧，宽约 28 物理像素），下边只取前几行的高度
    const x1 = ex + Math.round(10 * k);
    const y1 = ey + Math.round(4 * k);
    const x2 = Math.min(ex + ew - Math.round(60 * k), ex + Math.round(1200 * k));
    const y2 = Math.min(ey + eh - Math.round(30 * k), y1 + Math.round(200 * k));
    lines.push('     （拖选 ' + x1 + ',' + y1 + ' → ' + x2 + ',' + y2 + '）');
    drag(x1, y1, x2, y2);

    const a2 = waitFor(() => !has('QS-Region'), 20000);
    rec(a2, 'A2 框完之后遮罩自己关掉了', '遮罩还在，用户会满屏点不动');

    // ③ 等识别结果窗口（并行模式下百度那份要走网络，多等一会）
    const a3 = waitFor(() => hasAny('识别结果'), 90000);
    rec(a3, 'A3 识别结果窗口出现了', '窗口列表=' + JSON.stringify(titles()));

    flush();
    process.exit(0);
})().catch((e) => {
    lines.push('ERR ' + ((e && e.message) || e));
    flush();
    process.exit(0);
});
