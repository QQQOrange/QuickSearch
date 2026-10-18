/* 把指定标题的窗口前台化并打印 rect（供拖选/探针用）。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void*h,intptr l)'));
const IsWindowVisible = user32.func('int IsWindowVisible(void*h)');
const GetWindowTextW = user32.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const GetWindowRect = user32.func('int GetWindowRect(void*h,void*r)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void*h)');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const want = process.argv[2] || 'Notepad';
let found = null;
const cb = koffi.register((h) => {
    if (found || !IsWindowVisible(h)) return 1;
    const b = new Uint16Array(300);
    const n = GetWindowTextW(h, b, 300);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    if (s.includes(want)) found = h;
    return 1;
}, P);
EnumWindows(cb, 0); koffi.unregister(cb);
if (!found) { console.log('NOT FOUND:', want); process.exit(1); }
SetForegroundWindow(found);
sleep(300);
const rect = Buffer.alloc(16);
GetWindowRect(found, rect);
console.log(`hwnd=${found} rect=(${rect.readInt32LE(0)},${rect.readInt32LE(4)},${rect.readInt32LE(8)},${rect.readInt32LE(12)})`);
