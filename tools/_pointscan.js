/* 扫描若干点，报告每点命中的窗口 class/title（找 WorkBuddy 暴露区）。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const WindowFromPoint = user32.func('intptr WindowFromPoint(int64 pt)');
const GetClassNameW = user32.func('int GetClassNameW(void*h,_Out_ uint16*b,int n)');
const GetWindowTextW = user32.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const RealChildWindowFromPoint = user32.func('intptr RealChildWindowFromPoint(intptr h, int64 pt)');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function pt(x, y) { return (BigInt(y) << 32n) | BigInt(x & 0xffffffff); }
function clsOf(h) {
    const b = new Uint16Array(128); GetClassNameW(h, b, 128);
    let c = ''; for (let i = 0; i < 128; i++) if (b[i]) c += String.fromCharCode(b[i]); else break;
    const t = new Uint16Array(300); GetWindowTextW(h, t, 300);
    let s = ''; for (let i = 0; i < 300; i++) if (t[i]) s += String.fromCharCode(t[i]); else break;
    return `${c} 「${s.slice(0, 20)}」`;
}
// WorkBuddy 窗口 rect (667,206,2715,1976)，扫描内部若干点
const pts = [
    [900, 400], [1700, 400], [2400, 400],
    [900, 800], [1700, 800], [2400, 800],
    [900, 1200], [1700, 1200], [2400, 1200],
    [900, 1600], [1700, 1600], [2400, 1600],
];
for (const [x, y] of pts) {
    const h = WindowFromPoint(pt(x, y));
    console.log(`(${x},${y}) -> ${clsOf(h)}`);
}
