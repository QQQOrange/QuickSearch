/* 把设置窗口拉到前台并滚回顶部，方便截图。
   用法: node focus-settings.js */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const ENUMPROC = koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)');
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 f)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS,
    Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)), 0, 0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const str = (h) => {
    const b = new Uint16Array(400);
    const n = GetWindowTextW(h, b, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    return s;
};

let target = null;
const cb = koffi.register((h) => {
    if (IsWindowVisible(h) && str(h).indexOf('Quick Search 设置') >= 0) target = h;
    return 1;
}, koffi.pointer(ENUMPROC));
EnumWindows(cb, 0);
if (!target) { console.log('没找到设置窗口'); process.exit(1); }

const r = {};
GetWindowRect(target, r);
console.log('设置窗口', String(target), JSON.stringify(r));

// 先置顶，再注入一次点击（Windows 只认「用户输入」之后才允许抢前台）
SetWindowPos(target, -1, r.left, r.top, r.right - r.left, r.bottom - r.top, 0x0040);
sleep(250);
moveTo(r.left + 700, r.bottom - 40);
sleep(160);
mouse_event(LEFT_DOWN, 0, 0, 0, 0); sleep(70);
mouse_event(LEFT_UP, 0, 0, 0, 0);
sleep(500);

const VK_CONTROL = 0x11, VK_HOME = 0x24, KEYUP = 2;
keybd_event(VK_CONTROL, 0, 0, 0); sleep(60);
keybd_event(VK_HOME, 0, 0, 0); sleep(90);
keybd_event(VK_HOME, 0, KEYUP, 0); sleep(60);
keybd_event(VK_CONTROL, 0, KEYUP, 0);
sleep(300);
// 再滚一格轮子上去，防止 Ctrl+Home 被页面脚本吞掉
const MOUSEEVENTF_WHEEL = 0x0800;
for (let i = 0; i < 6; i++) {
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, 480, 0);
    sleep(60);
}
sleep(400);
console.log('已滚到顶部，前台=',
    String(GetForegroundWindow()) === String(target) ? '本窗口' : '其他');
process.exit(0);
