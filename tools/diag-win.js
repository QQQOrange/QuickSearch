/* 诊断：QuickSearchBar 窗口到底处于什么状态。
   重点看 DWM cloaking —— ctx 被隐藏时 GetWindowRect / IsWindowVisible 依然"正常"。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 name)');
const GetWindowLongPtrW = user32.func('intptr GetWindowLongPtrW(void *h, int idx)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const IsIconic = user32.func('int IsIconic(void *h)');
const GetAncestor = user32.func('void *GetAncestor(void *h, uint32 flags)');
const GetParent = user32.func('void *GetParent(void *h)');
const GetDesktopWindow = user32.func('void *GetDesktopWindow()');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *buf, int n)');
const IsWindowVisible2 = IsWindowVisible;
const ProcessIdToSessionId = koffi.load('kernel32.dll').func('int ProcessIdToSessionId(uint32 pid, _Out_ uint32 *sid)');
const GetCurrentProcessId = koffi.load('kernel32.dll').func('uint32 GetCurrentProcessId()');
const DwmGetWindowAttribute = dwmapi.func('long DwmGetWindowAttribute(void *h, uint32 attr, _Out_ void *val, uint32 size)');

const GWL_STYLE = -16, GWL_EXSTYLE = -20;
const DWMWA_CLOAKED = 14;

const h = FindWindowW(null, 'QuickSearchBar');
if (!h) { console.log('not found'); process.exit(2); }

const style = GetWindowLongPtrW(h, GWL_STYLE);
const ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
const cloaked = Buffer.alloc(4);
const hr = DwmGetWindowAttribute(h, DWMWA_CLOAKED, cloaked, 4);
const pid = Buffer.alloc(4);
GetWindowThreadProcessId(h, pid);
const sid = Buffer.alloc(4);
const mypid = GetCurrentProcessId();
const mysid = Buffer.alloc(4);
ProcessIdToSessionId(mypid, mysid);
ProcessIdToSessionId(pid.readUInt32LE(0), sid);

console.log(JSON.stringify({
    hwnd: String(h),
    sameAsDesktop: h === GetDesktopWindow(),
    parent: String(GetParent(h)),
    root: String(GetAncestor(h, 2)),
    foreground: String(GetForegroundWindow()),
    visible: !!IsWindowVisible(h),
    iconic: !!IsIconic(h),
    style: '0x' + (style >>> 0).toString(16),
    WS_VISIBLE: !!(style & 0x10000000),
    WS_POPUP: !!(style & 0x80000000),
    WS_CHILD: !!(style & 0x40000000),
    WS_DISABLED: !!(style & 0x08000000),
    WS_MINIMIZE: !!(style & 0x20000000),
    exstyle: '0x' + (ex >>> 0).toString(16),
    WS_EX_TOPMOST: !!(ex & 0x8),
    WS_EX_TOOLWINDOW: !!(ex & 0x80),
    WS_EX_LAYERED: !!(ex & 0x80000),
    WS_EX_TRANSPARENT: !!(ex & 0x20),
    WS_EX_NOREDIRECTIONBITMAP: !!(ex & 0x200000),
    WS_EX_NOACTIVATE: !!(ex & 0x8000000),
    WS_EX_APPWINDOW: !!(ex & 0x40000),
    boolCloakedHr: '0x' + (hr >>> 0).toString(16),
    cloaked: cloaked.readUInt32LE(0),
    winPid: pid.readUInt32LE(0),
    winSession: sid.readUInt32LE(0),
    myPid: mypid,
    mySession: mysid.readUInt32LE(0)
}, null, 2));

// 枚举所有可见顶层窗口，确认"我们自己起的窗口能不能出现在同一桌面"
const found = [];
const cb = koffi.register((hw, lp) => {
    if (!IsWindowVisible2(hw)) return 1;
    const b = new Uint16Array(300);
    const n = GetWindowTextW(hw, b, 300);
    if (n <= 0) return 1;
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    found.push(s);
    return 1;
}, 'int __stdcall(void*, intptr)');
EnumWindows(cb, 0);
console.log('--- visible titled windows (' + found.length + ') ---');
console.log(found.join('\n'));
