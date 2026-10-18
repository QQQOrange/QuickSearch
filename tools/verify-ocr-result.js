/* ============================================================================
 *  OCR 结果窗口：「上面图片、下面文字」的验证
 *
 *  用户在会话里明确要求：框选一部分页面之后，结果窗口里要能看到
 *    ① 上面是搜索引擎按钮
 *    ② 中间是自己框的那块截图
 *    ③ 下面是识别出来的文字（图和字能对照）
 *    ④ 最下面是搜索/复制/关闭按钮
 *  而且抱怨过「识别出来的文字不会填进文本框」。
 *
 *  这个测试直接从**页面内部**（真 WebView，不是 jsdom）检查 DOM：
 *    - #shotImg 有没有拿到 data:image/png 的 src（截图到位没）
 *    - #text 的 value 有没有等于识别结果（文字填进去没）
 *    - 版式顺序是不是 engines -> shot -> textarea -> foot
 *
 *  为了不依赖百度额度，用 QS_T_OCR_TEXT / QS_T_OCR_IMG 两个测试钩子
 *  喂一份假结果进去（真机跑的时候走的是同一条 open_ocr_window 通道）。
 * ========================================================================== */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');

const u = koffi.load('user32.dll');
try { u.func('int SetProcessDpiAwarenessContext(intptr c)')(-4); } catch (e) { }

const EnumWindows = u.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void*h,intptr l)'));
const GetWindowTextW = u.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const IsWindowVisible = u.func('int IsWindowVisible(void*h)');
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
const hasAny = (sub) => titles().some((x) => x.includes(sub));
const waitFor = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; sleep(150); } return false; };

const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');
function logSince(off) {
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
const logSize = () => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } };

let pass = 0, total = 0;
const ok = (n, c, extra) => {
    total++;
    if (c) pass++;
    console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '\n        ' + (extra || '')));
};

try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
sleep(1600);
const off = logSize();
// QS_T_OCR_TEXT / QS_T_OCR_IMG：测试钩子（见 src/main.rs 里 ocr_selftest 那段），
// 直接喂一份假结果走 open_ocr_window，绕开百度额度。
spawn(EXE, ['--no-elevate', '--ocr-demo'], {
    env: Object.assign({}, process.env, {
        QS_DEBUG: '1', QS_NO_ELEVATE: '1',
        QS_T_OCR_TEXT: '这是识别出来的示例文字 QuickSearch OCR 12345',
        QS_T_OCR_IMG: '1',
    }),
    cwd: ROOT, detached: true, stdio: 'ignore',
}).unref();
sleep(11000);

/* 结果窗口打开没有 */
ok('R1 --ocr-demo 后识别结果窗口出现了', waitFor(() => hasAny('识别结果'), 8000),
    '当前窗口：' + JSON.stringify(titles()));

/* 页面自检：Rust 会在窗口里跑一遍 DOM 断言并把结果打进日志。
   这里等日志里出现 [ocrselftest] 那几行。 */
const got = waitFor(() => /\[ocrselftest\]/.test(logSince(off)), 9000);
const seg = logSince(off);
ok('R2 页面自检跑起来了（真 WebView 里检查 DOM）', got,
    '日志里没出现 ocrselftest —— 说明页面脚本没执行到自检那步');

for (const line of seg.split('\n')) {
    if (!/\[ocrselftest\]/.test(line)) continue;
    const m = line.split('[ocrselftest]')[1].trim();
    const isFail = /^FAIL/.test(m);
    ok('R3 ' + m, !isFail);
}

const fails = seg.split('\n').filter((l) => /\[ocrselftest\] FAIL/.test(l));
ok('R4 自检没有任何 FAIL', fails.length === 0, fails.join('\n        '));

try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
