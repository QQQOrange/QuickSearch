/* ============================================================================
 *  OCR 交互部分（不含启动/收尾，由 run-ocr-e2e.py 驱动）
 *
 *  为什么拆开：实测发现 QuickSearch.exe 一旦由某个进程拉起，父进程退出后它
 *  也会跟着没（DETACHED_PROCESS 也挡不住）。所以「启动」和「交互」必须在
 *  同一个还活着的进程里完成 —— 这里只做交互，启动交给 Python 那边。
 *
 *  输出写进 ocr-actions.trace.txt，一行一条：OK/NO + 说明。
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(
    koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const SendInput = user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

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
const VK_CONTROL = 0x11, VK_MENU = 0x12, VK_O = 0x4F, VK_ESCAPE = 0x1B;

function combo(vk) {
    kb(VK_CONTROL, false); sleep(90);
    kb(VK_MENU, false); sleep(90);
    kb(vk, false); sleep(140);
    kb(vk, true); sleep(70);
    kb(VK_MENU, true); sleep(50);
    kb(VK_CONTROL, true);
}
const esc = () => { kb(VK_ESCAPE, false); sleep(80); kb(VK_ESCAPE, true); };

/* ------------------------------ 窗口 ------------------------------ */
function titles() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400);
        const n = GetWindowTextW(h, b, 400);
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (n > 0 && IsWindowVisible(h)) out.push(s);
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const has = (t) => titles().some((x) => x === t);
const hasAny = (sub) => titles().some((x) => x.includes(sub));
function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; sleep(120); }
    return false;
}

/* ------------------------------ 主流程 ------------------------------ */
const lines = [];
const rec = (ok, name, extra) => {
    lines.push((ok ? 'OK  ' : 'NO  ') + name + (ok ? '' : ' | ' + (extra || '')));
};

/** 拖一个框 */
function drag(x1, y1, x2, y2) {
    moveTo(x1, y1); sleep(150);
    ldown(x1, y1); sleep(150);
    moveTo((x1 + x2) / 2, (y1 + y2) / 2); sleep(150);
    moveTo(x2, y2); sleep(150);
    lup(x2, y2);
}

(async function main() {
    /* 顺序有讲究：Esc 取消、误点这两项放在「完整跑一次识别」之前。
     * 理由：第一次识别会打开结果窗口并抢走焦点，之后再注入热键
     * 实測有时送不到位；把不需要走完整流程的两项排前面，结论更干净。 */
    // B Esc 取消
    combo(VK_O);
    const b1 = waitFor(() => has('QS-Region'), 8000);
    rec(b1, 'B1 进入框选', '窗口=' + JSON.stringify(titles()));
    if (b1) {
        sleep(500);
        esc();
        const b2 = waitFor(() => !has('QS-Region'), 8000);
        rec(b2, 'B2 按 Esc 能退出框选（不会把人困住）', '遮罩还在');
    }

    // C 误点
    combo(VK_O);
    const c0 = waitFor(() => has('QS-Region'), 8000);
    rec(c0, 'C0 再次进入框选', '窗口=' + JSON.stringify(titles()));
    if (c0) {
        sleep(500);
        moveTo(700, 500); sleep(150);
        ldown(700, 500); sleep(100);
        lup(702, 501);
        sleep(2000);
        rec(has('QS-Region'), 'C1 只点一下不会误触发识别（遮罩留着等你重框）');
        esc();
        sleep(1000);
        rec(!has('QS-Region'), 'C2 误点之后按 Esc 仍能退出');
    }

    // A 正常框选（放最后：这一步会真的跑一次识别）
    combo(VK_O);
    const a1 = waitFor(() => has('QS-Region'), 8000);
    rec(a1, 'A1 Ctrl+Alt+O 打开了框选遮罩', '窗口列表=' + JSON.stringify(titles()));
    if (a1) {
        sleep(700);
        drag(500, 400, 1400, 800);
        const a2 = waitFor(() => !has('QS-Region'), 15000);
        rec(a2, 'A2 框完之后遮罩自己关掉了（bug2 核心）', '遮罩还在，用户会满屏点不动');
        const a4 = waitFor(() => hasAny('识别结果'), 25000);
        rec(a4, 'A4 识别失败时把原因显示出来了（不静默）',
            '既没弹窗也没提示 | 窗口=' + JSON.stringify(titles()));
    }

    fs.writeFileSync(path.join(__dirname, 'ocr-actions.trace.txt'), lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    process.exit(0);
})();
