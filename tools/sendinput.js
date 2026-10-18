/* 用 SendInput 发鼠标事件（比 mouse_event 更底层、更接近真实硬件输入）。
   用来排查「mouse_event 注入的右键收不到」这类问题。

   用法:
     node sendinput.js rclick <x> <y>
     node sendinput.js click  <x> <y>
     node sendinput.js move   <x> <y>
*/
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

const SendInput = user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
console.log('screen', SW, SH);

const MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004;
const RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, ABSOLUTE = 0x8000;

// INPUT 在 Win64 上固定 40 字节：type(4)+pad(4)+MOUSEINPUT(32)
function mkMouse(flags, dx, dy) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);        // type = INPUT_MOUSE
    b.writeInt32LE(dx, 8);
    b.writeInt32LE(dy, 12);
    b.writeUInt32LE(0, 16);       // mouseData
    b.writeUInt32LE(flags, 20);
    b.writeUInt32LE(0, 24);       // time
    b.writeBigUInt64LE(0n, 32);   // dwExtraInfo
    return b;
}
const send = (flags, dx, dy) => SendInput(1, mkMouse(flags, dx, dy), 40);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));

const mode = process.argv[2];
const x = +process.argv[3], y = +process.argv[4];

if (mode === 'move') {
    console.log('moved ->', send(MOVE | ABSOLUTE, ax(x), ay(y)));
} else if (mode === 'click') {
    send(MOVE | ABSOLUTE, ax(x), ay(y)); sleep(150);
    send(LEFTDOWN, 0, 0); sleep(90);
    send(LEFTUP, 0, 0);
    console.log('SendInput click', x, y);
} else if (mode === 'rclick') {
    send(MOVE | ABSOLUTE, ax(x), ay(y)); sleep(150);
    const r1 = send(RIGHTDOWN, 0, 0); sleep(90);
    const r2 = send(RIGHTUP, 0, 0);
    console.log('SendInput rclick', x, y, 'ret=', r1, r2);
} else {
    console.log('usage: node sendinput.js <move|click|rclick> x y');
}
