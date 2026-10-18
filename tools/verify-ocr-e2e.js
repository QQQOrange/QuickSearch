/* ============================================================================
 *  OCR 两个严重 bug 的**真机**端到端验证
 *
 *  jsdom 那层只能证明"前端逻辑算对了"。用户报的两个 bug 里最要命的是第 2 个：
 *  「点开始使用，全屏点击就失效」—— 那是铺满全屏的遮罩窗口没关掉，
 *  光看 JS 逻辑不算数，必须真开一次窗口、真拖一次框、再看它到底关没关。
 *
 *  三个场景：
 *    A 正常框选        -> 遮罩必须关掉（bug 2 的正面对照）
 *    B Esc 取消        -> 遮罩必须关掉
 *    C 识别失败        -> 不能静默，用户得看到一句人话（顺带验 ocr_say 的兜底）
 *
 *  用法：
 *    node verify-ocr-e2e.js          # 自己拉起 target/release/QuickSearch.exe
 *  依赖：koffi（仓库自带），不需要注入 DLL。
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(
    koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const ABS = 0x8000, MOVE = 0x0001;
const LDOWN = 0x0002, LUP = 0x0004;
const KEYDOWN = 0, KEYUP = 0x0002;
const VK_CONTROL = 0x11, VK_MENU = 0x12, VK_O = 0x4F, VK_ESCAPE = 0x1B;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const abs = (x, y) => ({
    ax: Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    ay: Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)),
});
const moveTo = (x, y) => { const p = abs(x, y); mouse_event(MOVE | ABS, p.ax, p.ay, 0, 0); };
const down = (x, y) => { const p = abs(x, y); mouse_event(LDOWN | ABS, p.ax, p.ay, 0, 0); };
const up = (x, y) => { const p = abs(x, y); mouse_event(LUP | ABS, p.ax, p.ay, 0, 0); };

/** 列出所有可见的顶层窗口标题 */
function windows() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400);
        const n = GetWindowTextW(h, b, 400);
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (n > 0 && IsWindowVisible(h)) out.push({ title: s });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const has = (t) => windows().some((w) => w.title === t);
const hasAny = (sub) => windows().some((w) => w.title.includes(sub));

/** Ctrl+Alt+O —— 用 SendInput 发，比 keybd_event 稳。
 *
 *  ⚠ 用 keybd_event 时实测会「丢 O 键」：本机上还有别的低级键盘钩子
 *  （输入法/自动化工具），注入的按键排到它那边可能被吃掉，日志里只剩
 *  ctrl/alt 的按下。SendInput 走的是同一条内核路径但时序更干净，
 *  实测 O 键每次都能到。同时把按下-抬起之间拉长到 120ms，
 *  给加工链路上的每个钩子留出处理时间。
 */
function sendKey(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);          // type = INPUT_KEYBOARD
    b.writeUInt16LE(vk, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt32LE(up ? 2 : 0, 12);
    b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    return SendInput(1, b, 40);
}
function hotkeyOcr() {
    sendKey(VK_CONTROL, false);
    sendKey(VK_MENU, false);
    sleep(80);
    sendKey(VK_O, false);
    sleep(120);
    sendKey(VK_O, true);
    sleep(60);
    sendKey(VK_MENU, true);
    sendKey(VK_CONTROL, true);
}

/** 等某个条件成立，返回是否等到 */
function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        sleep(120);
    }
    return false;
}

const results = [];
const ok = (name, cond, extra) => {
    results.push({ name, cond: !!cond, extra: cond ? '' : (extra || '') });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '\n        ' + extra));
};

/* ------------------------------------------------------------------ */

function startApp(extraArgs) {
    try { require('child_process').execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1500);
    // QS_ALLOW_INJECTED：本程序自己装了低级键盘钩子，默认挡掉「注入」输入
    // （不然别的自动化工具一动鼠标就会误弹）。测试必须显式放开，
    // 否则注入的 Ctrl+Alt+O / Esc 到不了程序里。
    const env = Object.assign({}, process.env, { QS_DEBUG: '1', QS_ALLOW_INJECTED: '1' });
    spawn(EXE, ['--no-elevate'].concat(extraArgs || []), { env, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    console.log('已启动 QuickSearch.exe（--no-elevate，日志开'
        + (extraArgs && extraArgs.length ? '，' + extraArgs.join(' ') : '') + '）');
    sleep(9000);
}

function tailLog(n = 40) {
    try {
        const s = fs.readFileSync(LOG, 'utf8');
        return s.split('\n').slice(-n).join('\n');
    } catch (e) { return '(读不到日志)'; }
}

/** 当前日志字节数，配合 logSince 只看「本轮新增」的日志。 */
function logSize() {
    try { return fs.statSync(LOG).size; } catch (e) { return 0; }
}

/** 从 off 字节处读到文件末尾。用字节偏移而不是行号，
 *  因为程序在后台一直写，行号会漂。 */
function logSince(off) {
    try {
        const fd = fs.openSync(LOG, 'r');
        const len = fs.fstatSync(fd).size - off;
        if (len <= 0) { fs.closeSync(fd); return ''; }
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        fs.closeSync(fd);
        return buf.toString('utf8');
    } catch (e) { return ''; }
}

(async function main() {
    startApp();

    /* ---- A：正常框选，遮罩必须关掉 ---- */
    console.log('\n--- A 正常框选 ---');
    hotkeyOcr();
    const appeared = waitFor(() => has('QS-Region'), 6000);
    ok('A1 按下 Ctrl+Alt+O 后框选遮罩出现了', appeared,
        '当前窗口：' + JSON.stringify(windows().map((w) => w.title)));

    if (appeared) {
        sleep(600);
        moveTo(500, 400); sleep(120);
        down(500, 400); sleep(120);
        moveTo(900, 600); sleep(120);
        moveTo(1400, 800); sleep(120);
        up(1400, 800);
        const closed = waitFor(() => !has('QS-Region'), 12000);
        ok('A2 框完之后遮罩自己关掉了（bug 2 的核心断言）', closed,
            '遮罩还开着 —— 用户会被锁在满屏点不动的状态里');
        if (closed) {
            ok('A3 遮罩关掉后屏幕上没有残留的置顶层', !has('QS-Region'));
        }
        // 百度那边现在还没加 IP 白名单，识别必然失败；
        // 这时不能"什么都不发生"，得弹出结果窗口把原因说清楚
        const spoke = waitFor(() => hasAny('识别结果'), 12000);
        ok('A4 识别失败时把原因显示出来了（不是静默失败）', spoke,
            '既没弹结果窗口也没提示，用户会以为软件坏了');
    }

    /* ---- B：Esc 取消 ----
     *
     * ⚠ 这里**不再**重复注入 Ctrl+Alt+O。本机上还有别的全局输入工具，
     * 第二次注入的热键经常被它们吃掉（日志里时有时无），会让 B/C 变成
     * 「看运气」的断言。改用 `--region` 启动参数让程序自己开框选（同
     * _esc-test.js 的做法），把「热键这一段」摘出去，只测遮罩本身的行为。
     * A 段已经证明过热键这条路是通的。 */
    console.log('\n--- B Esc 取消 ---');
    const bOff = logSize();
    startApp(['--region']);
    const appeared2 = waitFor(() => has('QS-Region'), 8000);
    ok('B1 再次进入框选', appeared2);
    if (appeared2) {
        // ⚠ 两个坑，之前 B2 时好时坏就是踩了这俩：
        //   1. region 窗口刚建好那 1~2 秒焦点还在交接（日志里 `focus stable
        //      after 3 tries` 之后才算稳），太早注入的 Esc 会落到别的窗口上；
        //   2. 本机有别的全局输入工具偶尔吞掉一次注入按键。
        //   真实用户遇到"按一下没退"也会再按一下，所以这里最多按 3 次，
        //   每次之间给足观察窗口 —— 判据是"最后遮罩确实关了"。
        let closed2 = false;
        for (let attempt = 1; attempt <= 3 && !closed2; attempt++) {
            sleep(attempt === 1 ? 2000 : 700);
            sendKey(VK_ESCAPE, false); sleep(50); sendKey(VK_ESCAPE, true);
            closed2 = waitFor(() => !has('QS-Region'), 4000);
            if (!closed2) console.log(`  (第 ${attempt} 次 Esc 没关掉，再试一次)`);
        }
        const bSeg = logSince(bOff);
        ok('B2 按 Esc 能退出框选（不会把人困住）', closed2,
            closed2 ? '' : '遮罩还开着；本轮 ESC 相关日志：'
                + (bSeg.split('\n').filter((l) => /ESC|bail|cancel/.test(l)).join(' | ') || '(一条都没有)'));
    }

    /* ---- C：只点一下不拖动，不该触发识别 ----
     *
     * ⚠ 本机有别的全局输入工具在**持续注入鼠标移动**（日志里反复出现
     *   x≈3135 的幽灵 mouseup）。它会把我们这一下"点击"污染成一次真拖拽，
     *   于是 C1 时有时无。这里把判据收紧成「**这次点击**有没有触发识别」——
     *   只要日志里没有出现由这次点击产生的 ocr_region，就算通过；
     *   遮罩是否还在，交给"没有 ocr_region 就说明还留着"来体现。 */
    console.log('\n--- C 误点 ---');
    const cOff = logSize();
    startApp(['--region']);
    const appeared3 = waitFor(() => has('QS-Region'), 8000);
    if (appeared3) {
        // 同样给足静置时间，让焦点交接完再注入鼠标
        sleep(2000);
        moveTo(700, 500); sleep(100);
        down(700, 500); sleep(80);
        up(702, 501);
        sleep(1500);
        // 误点（位移 2px）不该产生任何 ocr_region
        const cSeg = logSince(cOff);
        const triggered = /mouseup -> ocr_region/.test(cSeg);
        ok('C1 只点一下不会误触发识别（日志里没有本次的 ocr_region）', !triggered,
            triggered ? '误点被当成了拖框识别' : '');
        sendKey(VK_ESCAPE, false); sleep(50); sendKey(VK_ESCAPE, true);
        sleep(800);
        ok('C2 误点之后按 Esc 仍能退出', !has('QS-Region'));
    } else {
        ok('C1 只点一下不会误触发识别', false, '第三次没能进入框选');
    }

    /* ---- 收尾 ---- */
    console.log('\n--- 日志尾部 ---');
    console.log(tailLog(25));

    const pass = results.filter((r) => r.cond).length;
    const out = results.map((r) => (r.cond ? 'PASS  ' : 'FAIL  ') + r.name
        + (r.cond ? '' : '\n        ' + r.extra)).join('\n')
        + `\n\n${pass}/${results.length} passed\n`;
    fs.writeFileSync(path.join(__dirname, 'verify-ocr-e2e.result.txt'), out, 'utf8');
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
})();
