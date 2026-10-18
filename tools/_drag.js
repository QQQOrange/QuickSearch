/* 一次性调试用：在遮罩上模拟一次拖选（down → 移动 → up）。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const SendInput = user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
console.log('screen', SW, SH);

const MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000;
function mkMouse(flags, dx, dy) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeInt32LE(dx, 8);
    b.writeInt32LE(dy, 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(flags, 20);
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return b;
}
const send = (flags, dx, dy) => SendInput(1, mkMouse(flags, dx, dy), 40);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));

const [x1, y1, x2, y2] = process.argv.slice(2, 6).map(Number);
send(MOVE | ABSOLUTE, ax(x1), ay(y1)); sleep(250);
send(LEFTDOWN, 0, 0); sleep(120);
const steps = 24;
for (let i = 1; i <= steps; i++) {
    send(MOVE | ABSOLUTE, ax(Math.round(x1 + (x2 - x1) * i / steps)),
                          ay(Math.round(y1 + (y2 - y1) * i / steps)));
    sleep(25);
}
sleep(150);
send(LEFTUP, 0, 0);
console.log('drag', x1, y1, '->', x2, y2, 'done');
