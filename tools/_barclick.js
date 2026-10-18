/* 一次性调试：点击横条右侧第 N 个图标（从 1 数），然后截屏。
   用法: node _barclick.js <offsetFromRightPx> */
const koffi = require('koffi');
const { execSync } = require('child_process');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));

function findBar() {
    let out = null;
    const cb = koffi.register((h) => {
        const b = new Uint16Array(64); const n = GetWindowTextW(h, b, 64);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (s === 'QuickSearchBar' && IsWindowVisible(h)) { const r = {}; GetWindowRect(h, r); out = r; }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return out;
}
const bar = findBar();
if (!bar) { console.log('FAIL 横条不可见'); process.exit(1); }
const off = Number(process.argv[2] || 60);
const cx = bar.right - off, cy = Math.round((bar.top + bar.bottom) / 2);
console.log('bar', JSON.stringify(bar), '-> click', cx, cy);
mouse_event(MOVE | ABS, ax(cx), ay(cy), 0, 0); sleep(200);
mouse_event(LDOWN, 0, 0, 0, 0); sleep(90);
mouse_event(LUP, 0, 0, 0, 0); sleep(1800);
execSync('python tools/shot.py', { cwd: require('path').join(__dirname, '..'), stdio: 'inherit' });
