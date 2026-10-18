
const koffi = require('koffi');
const u = koffi.load('user32.dll');
try { u.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const me = u.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const si = u.func('uint32 SendInput(uint32 n, void* p, int cb)');
const SW = u.func('int GetSystemMetrics(int i)')(0);
const SH = u.func('int GetSystemMetrics(int i)')(1);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ax = x => Math.round(x * 65535 / (SW - 1));
const ay = y => Math.round(y * 65535 / (SH - 1));

function skey(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0); b.writeUInt16LE(vk, 8); b.writeUInt16LE(0, 10);
    b.writeUInt32LE(up ? 2 : 0, 12); b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    return si(1, b, 40);
}

console.log('--- 1) mouse_event 拖一次');
me(0x0001 | 0x8000, ax(600), ay(500), 0, 0); sleep(120);
me(0x0002 | 0x8000, ax(600), ay(500), 0, 0); sleep(150);
me(0x0001 | 0x8000, ax(900), ay(650), 0, 0); sleep(150);
me(0x0004 | 0x8000, ax(900), ay(650), 0, 0);
sleep(1200);

console.log('--- 2) SendInput 鼠标拖一次');
function sm(f, x, y) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0); b.writeInt32LE(ax(x), 8); b.writeInt32LE(ay(y), 12);
    b.writeUInt32LE(0, 16); b.writeUInt32LE(f, 20); b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return si(1, b, 40);
}
sm(0x0001 | 0x8000, 300, 300); sleep(120);
sm(0x0001 | 0x8000 | 0x0002, 300, 300); sleep(150);
sm(0x0001 | 0x8000, 700, 500); sleep(150);
sm(0x0001 | 0x8000 | 0x0004, 700, 500);
sleep(1200);

console.log('--- 3) SendInput Ctrl+Alt+O');
skey(0x11, false); sleep(90);
skey(0x12, false); sleep(90);
skey(0x4F, false); sleep(150);
skey(0x4F, true); sleep(70);
skey(0x12, true); sleep(50);
skey(0x11, true);
sleep(2500);

// 顺手看看框选窗口在不在
const ENUMPROC = koffi.pointer(koffi.proto('int __stdcall E(void* h, intptr l)'));
const EnumWindows = u.func('int EnumWindows(void* cb, intptr lp)');
const GetWindowTextW = u.func('int GetWindowTextW(void* h, _Out_ uint16* b, int n)');
const IsWindowVisible = u.func('int IsWindowVisible(void* h)');
const out = [];
const cb = koffi.register(h => {
    const b = new Uint16Array(400);
    const n = GetWindowTextW(h, b, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    if (n && IsWindowVisible(h)) out.push(s);
    return 1;
}, ENUMPROC);
EnumWindows(cb, 0); koffi.unregister(cb);
console.log('--- 窗口:', JSON.stringify(out.filter(t => /QS-|QuickSearch|识别/.test(t))));
