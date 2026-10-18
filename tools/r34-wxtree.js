/* r34 诊断二：微信窗口树 + GetGUIThreadInfo 可用性（只读） */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const psapi = koffi.load('psapi.dll');

const SetProcessDpiAwarenessContext = user32.func('int SetProcessDpiAwarenessContext(intptr ctx)');
try { SetProcessDpiAwarenessContext(-4); } catch (e) {}

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint32', flags: 'uint32', hwndActive: 'void *', hwndFocus: 'void *',
    hwndCapture: 'void *', hwndMenuOwner: 'void *', hwndMoveSize: 'void *',
    hwndCaret: 'void *', rcCaret: RECT,
});

const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *buf, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *buf, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const IsIconic = user32.func('int IsIconic(void *h)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const GetWindow = user32.func('void *GetWindow(void *h, uint32 cmd)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetGUIThreadInfo = user32.func('int GetGUIThreadInfo(uint32 id, _Inout_ GUITHREADINFO *gti)');
const GetLastError = kernel32.func('uint32 GetLastError()');

const GetProcessImageFileNameW = psapi.func('int GetProcessImageFileNameW(void *h, _Out_ uint16 *buf, int n)');
const OpenProcess = kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)');
const CloseHandle = kernel32.func('int CloseHandle(void *h)');

function clsOf(h) { const b = new Uint16Array(256); const n = GetClassNameW(h, b, 256); return n ? String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, n)) : ''; }
function txtOf(h) { const b = new Uint16Array(512); const n = GetWindowTextW(h, b, 512); return n ? String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, n)) : ''; }
function rectOf(h) { const r = { left: 0, top: 0, right: 0, bottom: 0 }; return GetWindowRect(h, r) ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null; }
function pidOf(h) { const p = Buffer.alloc(4); GetWindowThreadProcessId(h, p); return { pid: p.readUInt32LE(0), tid: 0 }; }
function tidOf(h) { const p = Buffer.alloc(4); return GetWindowThreadProcessId(h, p); }
function procName(pid) {
    const h = OpenProcess(0x1000, 0, pid); if (!h) return '?';
    const b = new Uint16Array(260); const n = GetProcessImageFileNameW(h, b, 260); CloseHandle(h);
    return n ? String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, n)).split('\\').pop() : '?';
}

// ---------- 1. GetGUIThreadInfo 可用性 ----------
console.log('=== GetGUIThreadInfo 测试 ===');
const fg = GetForegroundWindow();
console.log('当前前台窗口:', '0x' + fg.toString(16), clsOf(fg), '「' + txtOf(fg).slice(0, 40) + '」', 'pid=' + pidOf(fg).pid, procName(pidOf(fg).pid));
for (const [label, hwnd] of [['前台', fg]]) {
    const tid = tidOf(hwnd);
    const gti = { cbSize: 72, flags: 0, hwndActive: null, hwndFocus: null, hwndCapture: null, hwndMenuOwner: null, hwndMoveSize: null, hwndCaret: null, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
    const ok = GetGUIThreadInfo(tid, gti);
    const err = GetLastError();
    console.log(`${label} tid=${tid} GetGUIThreadInfo → ${ok ? 'ok' : 'FAIL err=' + err}`, ok ? JSON.stringify({
        hwndActive: gti.hwndActive && '0x' + gti.hwndActive.toString(16),
        hwndFocus: gti.hwndFocus && '0x' + gti.hwndFocus.toString(16),
        hwndCaret: gti.hwndCaret && '0x' + gti.hwndCaret.toString(16),
        flags: gti.flags,
    }) : '');
}

// ---------- 2. 微信窗口树 ----------
console.log('\n=== 微信窗口枚举（z 序全部顶层）===');
const GetDesktopWindow = user32.func('void *GetDesktopWindow()');
let cur = GetWindow(GetDesktopWindow(), 0);
let wxMain = null, wxThreadPid = null;
const all = [];
while (cur) {
    const pid = pidOf(cur);
    const pn = procName(pid.pid);
    all.push({ h: cur, cls: clsOf(cur), title: txtOf(cur), pid: pid.pid, proc: pn, tid: tidOf(cur), vis: !!IsWindowVisible(cur), min: !!IsIconic(cur), rect: rectOf(cur) });
    if (pn === 'Weixin.exe' && cur && !wxMain) wxMain = cur;
    cur = GetWindow(cur, 2);
    if (all.length > 500) break;
}
const wxWins = all.filter(w => w.proc === 'Weixin.exe' || w.proc === 'WeChatAppEx.exe');
console.log('微信系窗口数:', wxWins.length);
for (const w of wxWins) {
    console.log(`  0x${w.h.toString(16)} ${w.cls} vis=${w.vis ? 1 : 0} min=${w.min ? 1 : 0} (${w.rect ? w.rect.x + ',' + w.rect.y + ',' + w.rect.w + ',' + w.rect.h : '-'}) 「${w.title.slice(0, 30)}」`);
}
if (!wxWins.length) { console.log('（微信窗口一个都没有）'); process.exit(0); }

// ---------- 3. 主窗递归树 ----------
function dumpTree(hwnd, depth, maxDepth) {
    if (depth > maxDepth) return;
    let c = GetWindow(hwnd, 5); // GW_CHILD
    while (c) {
        const r = rectOf(c), pid = pidOf(c), tid = tidOf(c);
        console.log(`${'  '.repeat(depth + 1)}└ 0x${c.toString(16)} ${clsOf(c)} vis=${IsWindowVisible(c) ? 1 : 0} (${r ? r.x + ',' + r.y + ',' + r.w + ',' + r.h : '-'}) pid=${pid.pid} tid=${tid} 「${txtOf(c).slice(0, 24)}」`);
        dumpTree(c, depth + 1, maxDepth);
        c = GetWindow(c, 2);
    }
}
const main = wxWins.find(w => w.cls.startsWith('Qt51514QWindowIcon')) || wxWins[0];
console.log(`\n=== 主窗 0x${main.h.toString(16)} (${main.cls}) 子窗树（两层）===`);
dumpTree(main.h, 0, 2);

// ---------- 4. 对微信主线程试 GetGUIThreadInfo ----------
console.log('\n=== 对微信主窗线程试 GetGUIThreadInfo ===');
const tid = tidOf(main.h);
const gti = { cbSize: 64, flags: 0, hwndActive: null, hwndFocus: null, hwndCapture: null, hwndMenuOwner: null, hwndMoveSize: null, hwndCaret: null, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
const ok = GetGUIThreadInfo(tid, gti);
console.log(`微信 tid=${tid} → ${ok ? 'ok' : 'FAIL err=' + GetLastError()}`, ok ? JSON.stringify({
    hwndActive: gti.hwndActive && '0x' + gti.hwndActive.toString(16),
    hwndFocus: gti.hwndFocus && '0x' + gti.hwndFocus.toString(16),
    hwndCaret: gti.hwndCaret && '0x' + gti.hwndCaret.toString(16),
}) : '');
