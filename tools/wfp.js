/* 给定屏幕物理坐标，报告 WindowFromPoint 命中的窗口链。
   用法: node wfp.js <x> <y>
*/
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

const WindowFromPoint = user32.func('void* WindowFromPoint(POINT p)');
const GetClassNameW = user32.func('int GetClassNameW(void* h, _Out_ uint16* buf, int nMax)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* h, _Out_ uint32* pid)');
const GetAncestor = user32.func('void* GetAncestor(void* h, uint32 flags)');
const GetWindowRect = user32.func('int GetWindowRect(void* h, _Out_ RECT* r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void* h)');
const GetWindowTextW = user32.func('int GetWindowTextW(void* h, _Out_ uint16* buf, int nMax)');
const GetWindowLongPtrW = user32.func('int64 GetWindowLongPtrW(void* h, int i)');

const cls = (h) => {
    if (!h) return '(null)';
    const b = Buffer.alloc(512);
    GetClassNameW(h, b, 256);
    return b.toString('utf16le').replace(/\0.*$/, '');
};
const title = (h) => {
    if (!h) return '';
    const b = Buffer.alloc(512);
    GetWindowTextW(h, b, 256);
    return b.toString('utf16le').replace(/\0.*$/, '');
};
const info = (h) => {
    const pid = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pid);
    const r = { left: 0, top: 0, right: 0, bottom: 0 };
    GetWindowRect(h, r);
    return `${cls(h)} "${title(h)}" pid=${pid.readUInt32LE(0)} vis=${IsWindowVisible(h)} ` +
        `style=0x${(GetWindowLongPtrW(h, -16) >>> 0).toString(16)} ` +
        `exstyle=0x${(GetWindowLongPtrW(h, -20) >>> 0).toString(16)} ` +
        `rect=(${r.left},${r.top},${r.right},${r.bottom})`;
};

const x = +process.argv[2], y = +process.argv[3];
const h = WindowFromPoint({ x, y });
console.log(`WindowFromPoint(${x},${y}) =`);
console.log('  hit  :', info(h));
const root = GetAncestor(h, 2); // GA_ROOT
console.log('  root :', info(root));

// 也枚举一下桌面顶点，确认我们的窗口在 z-order 的什么位置
const GetDesktopWindow = user32.func('void* GetDesktopWindow()');
const GetWindow = user32.func('void* GetWindow(void* h, uint32 cmd)');
const GW_HWNDNEXT = 2;
let w = GetWindow(GetDesktopWindow(), 5 /*GW_CHILD*/);
let i = 0;
console.log('\n--- 顶层窗口 z-order（从最上开始，只看前 25 个可见的）---');
while (w && i < 25) {
    if (IsWindowVisible(w)) {
        const c = cls(w);
        if (!/^(Progman|WorkerW|Shell_TrayWnd|Windows.UI.Core|ApplicationFrameWindow)/.test(c)) {
            console.log(`  ${i}: ${info(w)}`);
        }
        i++;
    }
    w = GetWindow(w, GW_HWNDNEXT);
}
