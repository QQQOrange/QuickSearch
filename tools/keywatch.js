/* 观察 VK_RBUTTON 的按键状态，用来判断 GetAsyncKeyState 能不能感知注入的右键。
   用法: node keywatch.js [总时长ms]
*/
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const GetAsyncKeyState = user32.func('int GetAsyncKeyState(int v)');
const totalMs = +(process.argv[2] || 4000);
const step = 15;
let n = 0, hits = 0;

const iv = setInterval(() => {
    const s = GetAsyncKeyState(0x02); // VK_RBUTTON
    if (s & 0x8000) {
        hits++;
        if (hits <= 5) console.log(`RBUTTON DOWN raw=${s} (${n * step}ms)`);
    }
    if (++n * step >= totalMs) {
        clearInterval(iv);
        console.log(`watch done hits=${hits} (${totalMs}ms)`);
        process.exit(0);
    }
}, step);

console.log('keywatch start');
