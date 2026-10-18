/* 一次性调试：唤出横条（记事本全选复制）→ 打印横条窗口矩形 → 截屏。 */
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
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 sc, uint32 fl, uintptr ex)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function windows() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400); const n = GetWindowTextW(h, b, 400);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        const r = {}; GetWindowRect(h, r);
        out.push({ t: s, vis: !!IsWindowVisible(h), h, r });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return out;
}

const np = windows().find((w) => w.vis && /记事本|Notepad|favtest/i.test(w.t));
if (!np) { console.log('FAIL 没找到记事本'); process.exit(1); }
console.log('notepad:', np.t, JSON.stringify(np.r));
SetForegroundWindow(np.h); sleep(800);
const tap = (vk) => { keybd_event(0x11, 0, 0, 0); keybd_event(vk, 0, 0, 0); sleep(40); keybd_event(vk, 0, 2, 0); keybd_event(0x11, 0, 2, 0); };
tap(0x41);  // Ctrl+A 全选
sleep(250);
tap(0x43);  // Ctrl+C 复制 → 唤出横条
sleep(2200);
const bar = windows().find((w) => w.vis && w.t === 'QuickSearchBar');
if (!bar) { console.log('FAIL 横条没出来'); process.exit(1); }
console.log('bar rect:', JSON.stringify(bar.r));
const r = bar.r;
console.log('shot cmd next');
execSync('python tools/shot.py', { cwd: require('path').join(__dirname, '..'), stdio: 'inherit' });
