/* 单独验证：设置页那颗「＋ 用鼠标点选程序」按钮，点它到底会不会拉起拾取覆盖层。
 * 之前 verify-settings-features.js 里这一步失败，但分不清是"测试没点中"还是
 * "产品真没反应"，所以单拎出来、给足时间、并且盯着日志看 picker: built。 */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));
const moveTo = (x, y) => mouse_event(MOVE | ABS, ax(x), ay(y), 0, 0);
const click = (x, y) => { moveTo(x, y); sleep(160); mouse_event(LDOWN, 0, 0, 0, 0); sleep(100); mouse_event(LUP, 0, 0, 0, 0); };

function windows() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400); const n = GetWindowTextW(h, b, 400);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        const r = {}; GetWindowRect(h, r);
        const cr = {}; GetClientRect(h, cr);
        const p = { x: 0, y: 0 }; ClientToScreen(h, p);
        out.push({ t: s, vis: !!IsWindowVisible(h), h, l: r.left, tp: r.top, cl: p.x, ct: p.y, cw: cr.right - cr.left, ch: cr.bottom - cr.top });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return out;
}
const readLogSince = (m) => fs.readFileSync(LOG).slice(m).toString('utf8');

(async function () {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(2000);
    const ENSURE = path.join(ROOT, '_ensure.txt');
    fs.writeFileSync(ENSURE, '', 'utf8');
    const env = Object.assign({}, process.env, { QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_NO_ELEVATE: '1' });
    spawn(EXE, ['--no-elevate', '--settings', '--ensure-file', ENSURE], { env, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    console.log('启动…');
    sleep(9000);

    const win = windows().find((w) => w.t === 'Quick Search 设置' && w.vis);
    if (!win) { console.log('设置窗口没开起来'); process.exit(1); }
    SetForegroundWindow(win.h); sleep(900);

    const mark = fs.statSync(LOG).size;
    fs.appendFileSync(ENSURE, 'btn-pick-app\n', 'utf8');
    // 等页面重报坐标
    let rects = null;
    for (let i = 0; i < 25; i++) {
        sleep(150);
        const m = readLogSince(mark).match(/RECTS (\{.*\})/g);
        if (m) { try { rects = JSON.parse(m[m.length - 1].slice(6)); } catch (e) { } if (rects) break; }
    }
    if (!rects || !rects['btn-pick-app']) { console.log('拿不到 btn-pick-app 坐标'); process.exit(1); }

    const g = windows().find((w) => w.t === 'Quick Search 设置' && w.vis);
    const sx = g.cw / 780, sy = g.ch / 660;
    const r = rects['btn-pick-app'];
    const px = Math.round(g.cl + (r.x + r.w / 2) * sx);
    const py = Math.round(g.ct + (r.y + r.h / 2) * sy);
    console.log(`btn-pick-app rect=${JSON.stringify(r)} -> 屏幕 (${px},${py})  scale=(${sx.toFixed(2)},${sy.toFixed(2)})`);

    const mark2 = fs.statSync(LOG).size;
    SetForegroundWindow(g.h); sleep(400);
    click(px, py);
    console.log('已点击，等 picker: built…');
    let built = false;
    for (let i = 0; i < 40; i++) {          // 最多等 8 秒
        sleep(200);
        if (/picker: built/.test(readLogSince(mark2))) { built = true; break; }
    }
    const pw = windows().find((w) => w.t === 'QS-Picker' && w.vis);
    console.log(built ? 'PASS  日志里出现 picker: built' : 'FAIL  没有 picker: built');
    console.log(pw ? 'PASS  QS-Picker 窗口可见' : 'FAIL  QS-Picker 窗口不可见');
    console.log('--- 点击后日志 ---');
    console.log(readLogSince(mark2).split('\n').filter(l => /picker|pick_app|ERR|error/.test(l)).join('\n') || '(无 picker 相关日志)');
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    process.exit(built && pw ? 0 : 1);
})();
