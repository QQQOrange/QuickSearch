/*
 * 探针 v2 —— 端到端验证「模拟 Ctrl+C 取选区」这条核心链路。
 *
 * 流程：写一个临时文本文件 → 启动记事本 → 置前 → SendInput 发 Ctrl+A、Ctrl+C
 *      → 读剪贴板 → 看是不是拿到了全文。
 * 这一条通了，整个「选中就弹横条」才有地基。
 */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint32', flags: 'uint32',
    hwndActive: 'void *', hwndFocus: 'void *', hwndCapture: 'void *',
    hwndMenuOwner: 'void *', hwndMoveSize: 'void *', hwndCaret: 'void *',
    rcCaret: RECT,
});

// INPUT 联合体：Win64 上 sizeof(INPUT) 必须是 40。
// 关键点：联合体里最大的是 MOUSEINPUT（32 字节，含 8 字节对齐的 dwExtraInfo），
// 所以整个联合必须占 32 字节；少算这 8 字节 SendInput 会直接返回 0（静默失败）。
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16',
});
const INPUTUNION = koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION });

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)');
const GetGUIThreadInfo = user32.func('bool __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ GUITHREADINFO *pgui)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ void *buf, int max)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hWnd, _Out_ void *buf, int max)');
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, _In_ INPUT *pInputs, int cbSize)');
const IsWindow = user32.func('bool __stdcall IsWindow(void *hWnd)');

const OpenClipboard = user32.func('bool __stdcall OpenClipboard(void *hWndNewOwner)');
const CloseClipboard = user32.func('bool __stdcall CloseClipboard()');
const GetClipboardData = user32.func('void * __stdcall GetClipboardData(uint32 uFormat)');
const EmptyClipboard = user32.func('bool __stdcall EmptyClipboard()');

const GlobalAlloc = kernel32.func('void * __stdcall GlobalAlloc(uint32 uFlags, uintptr dwBytes)');
const GlobalLock = kernel32.func('void * __stdcall GlobalLock(void *hMem)');
const GlobalUnlock = kernel32.func('bool __stdcall GlobalUnlock(void *hMem)');
const GlobalSize = kernel32.func('uintptr __stdcall GlobalSize(void *hMem)');
const lstrcpyW = kernel32.func('void * __stdcall lstrcpyW(_Out_ void *dst, _In_ void *src)');

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11, VK_A = 0x41, VK_C = 0x43;

const MAXBUF = 1024;
const readW = (fn, hwnd) => {
    const buf = Buffer.alloc(MAXBUF * 2);
    fn(hwnd, buf, MAXBUF);
    return buf.toString('utf16le').split('\u0000')[0];
};

function setClipboardText(text) {
    if (!OpenClipboard(null)) return false;
    EmptyClipboard();
    const bytes = (text.length + 1) * 2;
    const h = GlobalAlloc(GMEM_MOVEABLE, bytes);
    const p = GlobalLock(h);
    const src = Buffer.from(text + '\u0000', 'utf16le');
    koffi.encode(p, 'void', src, src.length); // 直接写入
    GlobalUnlock(h);
    const ok = !!user32.func('void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)')(CF_UNICODETEXT, h);
    CloseClipboard();
    return ok;
}

function getClipboardText() {
    if (!OpenClipboard(null)) return null;
    const h = GetClipboardData(CF_UNICODETEXT);
    let out = null;
    if (h) {
        const p = GlobalLock(h);
        if (p) {
            const size = GlobalSize(h);
            const buf = Buffer.alloc(Number(size));
            koffi.decode(p, buf, buf.length);
            out = buf.toString('utf16le').split('\u0000')[0];
            GlobalUnlock(h);
        }
    }
    CloseClipboard();
    return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次按键（按下或抬起）
function key(vk, up) {
    const obj = { type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } } };
    return SendInput(1, obj, koffi.sizeof(INPUT));
}

console.log('=== 结构体大小体检 ===');
console.log('sizeof(INPUT)         =', koffi.sizeof(INPUT), '（Win64 必须为 40）');
console.log('sizeof(INPUTUNION)    =', koffi.sizeof(INPUTUNION), '（必须为 32）');
console.log('sizeof(KEYBDINPUT)    =', koffi.sizeof(KEYBDINPUT), '（必须为 24）');
console.log('sizeof(GUITHREADINFO) =', koffi.sizeof(GUITHREADINFO), '（必须为 72）');

(async () => {
    console.log('\n=== 剪贴板读写自检 ===');
    const mark = 'QS-CLIP-TEST-' + Date.now();
    console.log('写入 :', setClipboardText(mark) ? 'OK' : '失败');
    await sleep(120);
    const back = getClipboardText();
    console.log('读回 :', back === mark ? 'OK  (' + back + ')' : '不一致 → ' + JSON.stringify(back));

    console.log('\n=== SendInput 端到端（记事本） ===');
    const tmp = path.join(os.tmpdir(), 'qs-probe-notepad.txt');
    const content = '这是探针写入的一行中文文本 ABC 123';
    fs.writeFileSync(tmp, content, 'utf8');

    const child = spawn('notepad.exe', [tmp], { detached: true, stdio: 'ignore' });
    console.log('已启动记事本 pid=' + child.pid + '，等待窗口就绪…');
    await sleep(2500);

    // 找记事本的窗口
    let hwnd = null;
    for (let i = 0; i < 40 && !hwnd; i++) {
        hwnd = GetForegroundWindow();
        const pidBuf = [0];
        GetWindowThreadProcessId(hwnd, pidBuf);
        if (pidBuf[0] !== child.pid) { hwnd = null; await sleep(150); }
    }
    if (!hwnd) {
        console.log('无法确认记事本成为前台窗口（可能被其它窗口抢了焦点），改用记事本标题搜索…');
        // 退一步：拿前台窗口就行，只要类名是 Notepad
        hwnd = GetForegroundWindow();
    }
    console.log('目标窗口 hwnd=' + hwnd, '标题=' + JSON.stringify(readW(GetWindowTextW, hwnd)),
        '类名=' + JSON.stringify(readW(GetClassNameW, hwnd)));

    SetForegroundWindow(hwnd);
    await sleep(500);
    console.log('置前后 classeName =', JSON.stringify(readW(GetClassNameW, GetForegroundWindow())));

    // 先清空剪贴板，避免误判
    setClipboardText('__EMPTY__' + Date.now());
    await sleep(80);

    console.log('\n发送 Ctrl+A …');
    key(VK_CONTROL, false); key(VK_A, false); key(VK_A, true); key(VK_CONTROL, true);
    await sleep(250);
    console.log('发送 Ctrl+C …');
    key(VK_CONTROL, false); key(VK_C, false); key(VK_C, true); key(VK_CONTROL, true);
    await sleep(400);

    const got = getClipboardText();
    console.log('\n剪贴板内容 :', JSON.stringify(got));
    console.log('期望内容   :', JSON.stringify(content));
    const pass = got !== null && got.indexOf('探针写入') >= 0;
    console.log(pass ? '\n✅ 端到端通过：模拟 Ctrl+C 成功拿到选中的文本' : '\n❌ 端到端失败：SendInput 没生效');

    // 打字光标探测
    console.log('\n=== 记事本里的打字光标位置 ===');
    const gi = { cbSize: koffi.sizeof(GUITHREADINFO) };
    const okGi = GetGUIThreadInfo(0, gi);
    console.log('GetGUIThreadInfo(0, …) =', okGi, ' flags=0x' + (gi.flags >>> 0).toString(16),
        ' hwndCaret=' + gi.hwndCaret, ' rcCaret=' + JSON.stringify(gi.rcCaret));

    try { process.kill(child.pid); } catch (e) { /* 忽略 */ }
    console.log('\n（已关闭记事本）');
})();
