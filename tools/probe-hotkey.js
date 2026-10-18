/* 探一下 Ctrl+Alt+O 到底有没有进钩子。
   用 SendInput（比 keybd_event 更接近真实硬件输入）。
   用法: node probe-hotkey.js */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const SendInput = user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)');
const GetAsyncKeyState = user32.func('int GetAsyncKeyState(int v)');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const KEYEVENTF_KEYUP = 0x0002;
function kb(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);            // INPUT_KEYBOARD
    b.writeUInt16LE(vk, 8);           // wVk
    b.writeUInt16LE(0, 10);           // wScan
    b.writeUInt32LE(up ? KEYEVENTF_KEYUP : 0, 12);
    b.writeUInt32LE(0, 16);           // time
    b.writeBigUInt64LE(0n, 24);       // dwExtraInfo
    return SendInput(1, b, 40);
}

const VK_CONTROL = 0x11, VK_MENU = 0x12, VK_O = 0x4F;

const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');
const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';

kb(VK_CONTROL, false); sleep(60);
kb(VK_MENU, false); sleep(60);
console.log('ctrl down?', !!(GetAsyncKeyState(VK_CONTROL) & 0x8000),
    'alt down?', !!(GetAsyncKeyState(VK_MENU) & 0x8000));
kb(VK_O, false); sleep(80);
kb(VK_O, true); sleep(60);
kb(VK_MENU, true); sleep(40);
kb(VK_CONTROL, true);
console.log('SendInput 已发送 Ctrl+Alt+O');
sleep(2500);

const after = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
const fresh = after.slice(before.length);
const hit = fresh.split('\n').filter((l) => /hotkey|region|ocr/i.test(l));
console.log('--- 新增相关日志 ---');
console.log(hit.length ? hit.join('\n') : '(没有)');
