/* ============================================================================
 *  托盘右键菜单探针（tray-probe.js）
 *
 *  验用户报过的老 bug：「右键托盘图标不出任何菜单」到底修好没有。
 *  做法全是 Win32 实测，不靠猜：
 *    ① 枚举本进程的窗口，用 Shell_NotifyIconGetRect 反查出托盘图标的屏幕矩形
 *       —— 能查出来 = 图标确实注册在系统托盘里；
 *    ② 在该位置真按一次右键；
 *    ③ 看有没有弹出标准菜单窗口（类名 #32768）且属于本进程 —— 有 = 菜单弹出来了；
 *    ④ Esc 收掉。
 *
 *  用法：node tray-probe.js
 *  输出：tray-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'tray-probe.txt');

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const NOTIFYICONIDENTIFIER = koffi.struct('NOTIFYICONIDENTIFIER', {
    cbSize: 'uint32', hWnd: 'void*', uID: 'uint32', guidItem: 'uint8[16]',
});
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const Shell_NotifyIconGetRect = shell32.func('int Shell_NotifyIconGetRect(NOTIFYICONIDENTIFIER *id, _Out_ RECT *r)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, ABS = 0x8000;
function mouse(flags, x, y) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeInt32LE(Math.round(x * 65535 / (SW - 1)), 8);
    b.writeInt32LE(Math.round(y * 65535 / (SH - 1)), 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(flags, 20);
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return SendInput(1, b, 40);
}
function kb(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);
    b.writeUInt16LE(vk, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt32LE(up ? 0x0002 : 0, 12);
    b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    return SendInput(1, b, 40);
}
const esc = () => { kb(0x1B, false); sleep(60); kb(0x1B, true); };

const cls = (h) => {
    const t = new Uint16Array(256); const n = GetClassNameW(h, t, 256);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function windowsOf(pid) {
    const out = [];
    const cb = koffi.register((h) => {
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        if (p[0] === pid) {
            const r = {}; GetWindowRect(h, r);
            out.push({ hwnd: h, cls: cls(h), vis: !!IsWindowVisible(h),
                       rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] });
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
/** 找托盘图标：对本进程每个窗口试 Shell_NotifyIconGetRect（uID 试 1/0） */
function trayIconRect(pid) {
    for (const w of windowsOf(pid)) {
        for (const uid of [1, 0]) {
            const id = { cbSize: 40, hWnd: w.hwnd, uID: uid, guidItem: new Uint8Array(16) };
            const r = {};
            const hr = Shell_NotifyIconGetRect(id, r);
            if (hr === 0 && (r.right - r.left) > 0) {
                return { rect: [r.left, r.top, r.right - r.left, r.bottom - r.top],
                         win: w, uid };
            }
        }
    }
    return null;
}
/** 当前有没有弹出菜单窗口（类名 #32768），并说明归属进程 */
function popupMenu(pid) {
    let out = null;
    const cb = koffi.register((h) => {
        if (cls(h) === '#32768' && IsWindowVisible(h)) {
            const p = new Uint32Array(1);
            GetWindowThreadProcessId(h, p);
            const r = {}; GetWindowRect(h, r);
            out = { ours: p[0] === pid, pid: p[0],
                    rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] };
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-tray-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    try { execSync('taskkill /IM QuickSearch.exe /T /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1000);
    const env = Object.assign({}, process.env, { APPDATA: tmp, QS_DEBUG: '1' });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid);
    sleep(9000);

    const wins = windowsOf(proc.pid);
    rec('本进程窗口 ' + wins.length + ' 个：');
    for (const w of wins) rec('  cls=' + w.cls + ' vis=' + w.vis + ' rect=' + JSON.stringify(w.rect));

    const t = trayIconRect(proc.pid);
    if (!t) {
        rec('FAIL 查不到托盘图标（Shell_NotifyIconGetRect 全部失败）→ 图标可能没注册上');
    } else {
        rec('托盘图标 rect=' + JSON.stringify(t.rect) + '  uID=' + t.uid
            + '  宿主窗口 cls=' + t.win.cls);
        const cx = t.rect[0] + Math.round(t.rect[2] / 2);
        const cy = t.rect[1] + Math.round(t.rect[3] / 2);
        mouse(MOVE | ABS, cx, cy); sleep(250);
        mouse(MOVE | ABS | RDOWN, cx, cy); sleep(120);
        mouse(MOVE | ABS | RUP, cx, cy); sleep(700);
        const m = popupMenu(proc.pid);
        rec('右键后菜单窗口：' + (m ? JSON.stringify(m) : 'NONE'));
        if (m && m.ours) rec('PASS 托盘右键弹出了菜单（属于本进程，尺寸 ' + m.rect[2] + 'x' + m.rect[3] + '）');
        else if (m) rec('FAIL 弹出了菜单但不是本进程的（pid=' + m.pid + '）');
        else rec('FAIL 右键后没有任何菜单窗口');
        esc(); sleep(400);
        rec('Esc 后菜单窗口：' + (popupMenu(proc.pid) ? '还在' : '已收起'));
    }
    flush();
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
