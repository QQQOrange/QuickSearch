/* 在屏幕坐标点击/拖拽（物理像素，per-monitor v2 感知）。
   注意：移动必须用 mouse_event(MOVE|ABSOLUTE)，SetCursorPos 不会产生
   低级鼠标钩子的 Move 事件，主程序就判定不出"拖动"。

   用法:
     node click.js click <x> <y>
     node click.js drag <x1> <y1> <x2> <y2>
*/
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

const mouse_event = user32.func('void mouse_event(uint32 flags, uint32 dx, uint32 dy, uint32 data, uintptr extra)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

const MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000;
const RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
console.log('screen', SW, SH);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE, ax(x), ay(y), 0, 0);

const mode = process.argv[2];
if (mode === 'click') {
    const x = +process.argv[3], y = +process.argv[4];
    moveTo(x, y); sleep(120);
    mouse_event(LEFTDOWN, 0, 0, 0, 0); sleep(80);
    mouse_event(LEFTUP, 0, 0, 0, 0);
    console.log('clicked', x, y);
} else if (mode === 'rclick') {
    const x = +process.argv[3], y = +process.argv[4];
    moveTo(x, y); sleep(120);
    mouse_event(RIGHTDOWN, 0, 0, 0, 0); sleep(80);
    mouse_event(RIGHTUP, 0, 0, 0, 0);
    console.log('right-clicked', x, y);
} else if (mode === 'drag') {
    const x1 = +process.argv[3], y1 = +process.argv[4], x2 = +process.argv[5], y2 = +process.argv[6];
    moveTo(x1, y1); sleep(150);
    mouse_event(LEFTDOWN, 0, 0, 0, 0); sleep(150);
    const steps = 18;
    for (let i = 1; i <= steps; i++) {
        moveTo(Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps));
        sleep(32);
    }
    sleep(180);
    mouse_event(LEFTUP, 0, 0, 0, 0);
    console.log('dragged', x1, y1, '->', x2, y2);
}
