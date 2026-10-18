/* 一次性调试用：注入一组按键（如 Ctrl+Alt+F），用于触发收藏夹热键。
   用法: node _keys.js Ctrl+Alt+F */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const VK = { CTRL: 0x11, ALT: 0x12, SHIFT: 0x10, ESC: 0x1B };
'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').forEach((ch) => { VK[ch] = ch.charCodeAt(0); });
const KEYUP = 0x0002;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const combo = process.argv[2] || '';
const parts = combo.split('+').map((s) => s.trim());
const vks = parts.map((p) => {
    if (/^ctrl$/i.test(p)) return VK.CTRL;
    if (/^alt$/i.test(p)) return VK.ALT;
    if (/^shift$/i.test(p)) return VK.SHIFT;
    return VK[p.toUpperCase()];
});
if (vks.some((v) => v === undefined)) { console.log('bad combo', combo); process.exit(1); }
for (const v of vks) keybd_event(v, 0, 0, 0);
sleep(80);
for (const v of [...vks].reverse()) keybd_event(v, 0, KEYUP, 0);
console.log('sent', combo);
