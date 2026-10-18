/* 按标题关键词找顶层窗口: node find-win.js <关键词> */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const ENUMPROC = koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)');
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');

const key = (process.argv[2] || '').toLowerCase();
const str = (fn, h) => {
    const b = new Uint16Array(400);
    const n = fn(h, b, 400);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    return s;
};
const cb = koffi.register((h) => {
    const t = str(GetWindowTextW, h);
    if (!t) return 1;
    if (key && !t.toLowerCase().includes(key)) return 1;
    const r = {};
    GetWindowRect(h, r);
    const pid = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pid);
    console.log(`${String(h)}  vis=${IsWindowVisible(h) ? 1 : 0}  pid=${pid.readUInt32LE(0)}  ${r.right - r.left}x${r.bottom - r.top}@${r.left},${r.top}  cls=${str(GetClassNameW, h)}  title="${t}"`);
    return 1;
}, koffi.pointer(ENUMPROC));
EnumWindows(cb, 0);
