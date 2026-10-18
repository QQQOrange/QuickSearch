/* 探针：验证「注入的 Esc 到底有没有送到 QuickSearch 进程」。
 *
 * 背景：_esc-test 里 ESC2（第一次 Esc 关不掉遮罩）一直 FAIL，但日志显示
 * 遮罩最终是被页面自己的 [region] bail 关掉的 —— 说明钩子那层「安全网」
 * 一次都没触发。到底是
 *   (a) 注入的按键根本没被任何钩子/窗口收到（测试方法的假象），还是
 *   (b) 收到了、只是钩子把它当 injected 挡掉了
 * 需要在这里一次性分清。
 *
 * 做法：同时用两种方式发 Esc —— mouse/keybd 的 keybd_event（带 INJECTED 标志）
 * 和 不带注入标志的真实按键是没法造的，所以换个角度：
 *   1) 全程记录 QuickSearch 日志里 ESC 相关行
 *   2) 先发一次 hotkey 进框选，再发 Esc，看日志里出现的是
 *        [region] bail（页面收到）/ kbd: ESC -> ...（钩子收到）
 *      中的哪一种，还是两种都没有。
 * 用法：node tools/_probe-esc-recv.js
 */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');

const u = koffi.load('user32.dll');
try { u.func('int SetProcessDpiAwarenessContext(intptr c)')(-4); } catch (e) { }

const EnumWindows = u.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void*h,intptr l)'));
const GetWindowTextW = u.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const IsWindowVisible = u.func('int IsWindowVisible(void*h)');
const keybd = u.func('void keybd_event(uint8 vk,uint8 s,uint32 f,uintptr e)');
const SendInput = u.func('uint32 SendInput(uint32 n, void* p, int cb)');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function titles() {
    const o = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(300);
        const n = GetWindowTextW(h, b, 300);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (IsWindowVisible(h) && s) o.push(s);
        return 1;
    }, P);
    EnumWindows(cb, 0); koffi.unregister(cb); return o;
}
const has = (t) => titles().some((x) => x === t);
const waitFor = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; sleep(120); } return false; };

function hotkey() {
    keybd(0x11, 0, 0, 0); keybd(0x12, 0, 0, 0); keybd(0x4F, 0, 0, 0);
    sleep(60);
    keybd(0x4F, 0, 2, 0); keybd(0x12, 0, 2, 0); keybd(0x11, 0, 2, 0);
}
/** 用 SendInput 发一个 Esc（同样带 INJECTED 标志，但走的是不同 API 路径） */
function sendEscViaSendInput() {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);        // type = INPUT_KEYBOARD
    b.writeUInt16LE(0x1B, 8);     // vk
    b.writeUInt16LE(0, 10);       // scan
    b.writeUInt32LE(0, 12);       // flags down
    b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    SendInput(1, b, 40);
    sleep(60);
    const b2 = Buffer.alloc(40);
    b2.writeUInt32LE(1, 0); b2.writeUInt16LE(0x1B, 8); b2.writeUInt16LE(0, 10);
    b2.writeUInt32LE(2, 12);      // KEYEVENTF_KEYUP
    b2.writeUInt32LE(0, 16); b2.writeBigUInt64LE(0n, 24);
    SendInput(1, b2, 40);
}

function logSize() { try { return fs.statSync(LOG).size; } catch (e) { return 0; } }
function logFrom(off) {
    try {
        const fd = fs.openSync(LOG, 'r');
        const st = fs.fstatSync(fd);
        const len = st.size - off;
        if (len <= 0) { fs.closeSync(fd); return ''; }
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        fs.closeSync(fd);
        return buf.toString('utf8');
    } catch (e) { return ''; }
}

try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
sleep(1500);
const off0 = logSize();
console.log('log offset at launch =', off0);
spawn(EXE, ['--no-elevate'], {
    env: Object.assign({}, process.env, { QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_NO_ELEVATE: '1' }),
    cwd: ROOT, detached: true, stdio: 'ignore',
}).unref();
sleep(9000);

console.log('\n=== 场景 1：Ctrl+Alt+O 进框选 -> keybd_event 发 Esc ===');
let off = logSize();
hotkey();
const a = waitFor(() => has('QS-Region'), 6000);
console.log('遮罩出现:', a);
sleep(700);
off = logSize();
keybd(0x1B, 0, 0, 0); keybd(0x1B, 0, 2, 0);
const c1 = waitFor(() => !has('QS-Region'), 4000);
sleep(300);
const seg1 = logFrom(off);
console.log('遮罩关掉:', c1);
console.log('--- 这段期间日志里的关键行 ---');
for (const l of seg1.split('\n')) {
    if (/ESC|bail|cancelled|region|kbd/i.test(l)) console.log('  ' + l.replace(/^\[[^\]]+\]\s*/, ''));
}

console.log('\n=== 场景 2：进框选 -> SendInput 发 Esc ===');
hotkey();
const a2 = waitFor(() => has('QS-Region'), 6000);
console.log('遮罩出现:', a2);
sleep(700);
off = logSize();
sendEscViaSendInput();
const c2 = waitFor(() => !has('QS-Region'), 4000);
sleep(300);
const seg2 = logFrom(off);
console.log('遮罩关掉:', c2);
console.log('--- 这段期间日志里的关键行 ---');
for (const l of seg2.split('\n')) {
    if (/ESC|bail|cancelled|region|kbd/i.test(l)) console.log('  ' + l.replace(/^\[[^\]]+\]\s*/, ''));
}

try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
console.log('\ndone');
