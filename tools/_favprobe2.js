/* 一次性调试：唤出横条后，从右往左依次点击图标行位置，各截一张图。
   产出 shot-1.png ~ shot-4.png */
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
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));

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
function findBar() { return windows().find((w) => w.vis && w.t === 'QuickSearchBar'); }

// ① 唤出：记事本全选复制
const np = windows().find((w) => w.vis && /记事本|Notepad|favtest/i.test(w.t));
if (!np) { console.log('FAIL 没有记事本'); process.exit(1); }
SetForegroundWindow(np.h); sleep(700);
const tap = (vk) => { keybd_event(0x11, 0, 0, 0); keybd_event(vk, 0, 0, 0); sleep(40); keybd_event(vk, 0, 2, 0); keybd_event(0x11, 0, 2, 0); };
tap(0x41); sleep(250); tap(0x43); sleep(2200);

// ② 横条可见后，从右往左 4 个位置逐个点（图标行中心 = top+88 物理 px）
for (let i = 0; i < 4; i++) {
    const bar = findBar();
    if (!bar) { console.log(`第 ${i} 次点击前横条已消失`); break; }
    const cx = bar.r.right - 60 - i * 34;
    const cy = bar.r.top + 88;
    console.log(`click#${i + 1} bar=${JSON.stringify(bar.r)} at (${cx},${cy})`);
    mouse_event(MOVE | ABS, ax(cx), ay(cy), 0, 0); sleep(180);
    mouse_event(LDOWN, 0, 0, 0, 0); sleep(90);
    mouse_event(LUP, 0, 0, 0, 0); sleep(1500);
    execSync(`python tools/shot.py && python -c "from PIL import Image; Image.open('shot.png').save('shot-${i + 1}.png')"`, { cwd: require('path').join(__dirname, '..'), stdio: 'inherit' });
}
console.log('done');
