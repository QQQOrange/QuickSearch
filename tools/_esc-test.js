/* ============================================================================
 *  OCR 框选遮罩的 Esc 退出验证（确定性版）
 *
 *  用户明确要求：进入「暂停全屏、拖框识别」这个状态之后，按 Esc 能退出。
 *
 *  ⚠ 为什么用 `--region` 启动参数而不是 Ctrl+Alt+O：
 *  本机上还有别的全局输入工具（输入法/自动化/手势软件），它们会往系统里
 *  注入鼠标和键盘事件。用热键进框选时，经常是遮罩刚开就被一次「幽灵点击」
 *  当成框选、或者 O 键被别的低级钩子吃掉 —— 测出来的是**测试环境**的噪声，
 *  不是程序的问题。`--region` 让程序启动后自己开框选，把热键这一段摘出去，
 *  只测「遮罩本身能不能被 Esc 关掉」这一件事。
 *
 *  另外进程要跑在 QS_ALLOW_INJECTED=1 下：本程序自己装了低级键盘钩子，
 *  默认会挡掉注入输入，测试里注入的 Esc 必须显式放行。
 * ========================================================================== */
const koffi = require('koffi');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');

const u = koffi.load('user32.dll');
try { u.func('int SetProcessDpiAwarenessContext(intptr c)')(-4); } catch (e) { }

const EnumWindows = u.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void*h,intptr l)'));
const GetWindowTextW = u.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const IsWindowVisible = u.func('int IsWindowVisible(void*h)');
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
const waitFor = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; sleep(100); } return false; };

function sendKey(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);
    b.writeUInt16LE(vk, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt32LE(up ? 2 : 0, 12);
    b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    return SendInput(1, b, 40);
}
const esc = () => { sendKey(0x1B, false); sleep(50); sendKey(0x1B, true); };

function startApp(extraArgs) {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1600);
    spawn(EXE, ['--no-elevate'].concat(extraArgs || []), {
        env: Object.assign({}, process.env, { QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_NO_ELEVATE: '1' }),
        cwd: ROOT, detached: true, stdio: 'ignore',
    }).unref();
}

let pass = 0, total = 0;
const ok = (n, c, extra) => {
    total++;
    if (c) pass++;
    console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '\n        ' + (extra || '')));
};

/* --- 第 1 轮：--region 启动，遮罩应自动出现 --- */
startApp(['--region']);
sleep(9000);
ok('ESC1 --region 启动后框选遮罩自动出现', waitFor(() => has('QS-Region'), 6000));

/* 什么都不按，遮罩要稳住（不能被幽灵事件关掉） */
sleep(1500);
ok('ESC2 不按键时遮罩保持不动（不会误关）', has('QS-Region'));

/* 按 Esc，遮罩必须关掉 —— 这就是用户要的那个逻辑 */
esc();
ok('ESC3 按一次 Esc 遮罩关掉', waitFor(() => !has('QS-Region'), 4000),
    '遮罩还开着 —— 用户会被困在满屏点不动的状态里');

/* 关掉之后要能再次进入，并且 Esc 仍然有效（可重复） */
try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
sleep(1200);
startApp(['--region']);
sleep(9000);
ok('ESC4 再次 --region 启动，遮罩出现', waitFor(() => has('QS-Region'), 6000));
sleep(800);
esc();
ok('ESC5 第二次按 Esc 也能退出', waitFor(() => !has('QS-Region'), 4000));
sleep(500);

/* 第三次：连按两次 Esc（真实用户可能紧张多按一下，必须还是安全退出） */
try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
sleep(1200);
startApp(['--region']);
sleep(9000);
ok('ESC6 第三次进入框选', waitFor(() => has('QS-Region'), 6000));
sleep(500);
esc(); esc();
ok('ESC7 连按两次 Esc 也不会出问题（遮罩关掉、程序还在）', waitFor(() => !has('QS-Region'), 4000) && has('QuickSearchBar'),
    '要么遮罩没关，要么连程序一起挂了');
sleep(800);
ok('ESC8 收尾：程序仍在运行（连按 Esc 不会把程序搞崩）', has('QuickSearchBar'));

try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
