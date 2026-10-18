/* 找 WebView2 真正的渲染窗口（Chrome_RenderWidgetHostHWND / Chrome_WidgetWin_*），
   看它挂在哪、多大、可不可见、在不在屏幕上。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const ENUMPROC = koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)');

const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 name)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const IsWindow = user32.func('int IsWindow(void *h)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const GetParent = user32.func('void *GetParent(void *h)');
const GetAncestor = user32.func('void *GetAncestor(void *h, uint32 f)');
const WindowFromPoint = user32.func('void *WindowFromPoint(POINT p)');
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const GetWindowLongPtrW = user32.func('intptr GetWindowLongPtrW(void *h, int idx)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const GetWindow = user32.func('void *GetWindow(void *h, uint32 cmd)');

function cls(h) {
    const b = new Uint16Array(300);
    const n = GetClassNameW(h, b, 300);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    return s;
}
function d(h) {
    if (!h || !IsWindow(h)) return '(null)';
    const r = {};
    GetWindowRect(h, r);
    const st = GetWindowLongPtrW(h, -16), ex = GetWindowLongPtrW(h, -20);
    const pid = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pid);
    return `${String(h)} ${cls(h)} ${r.right - r.left}x${r.bottom - r.top}@${r.left},${r.top} vis=${IsWindowVisible(h) ? 1 : 0} pid=${pid.readUInt32LE(0)} st=0x${(st >>> 0).toString(16)} ex=0x${(ex >>> 0).toString(16)}`;
}

const BAR = FindWindowW(null, 'QuickSearchBar');
console.log('BAR ->', d(BAR));

const center = { x: 520, y: 360 };
const target = WindowFromPoint(center);
console.log('at(520,360) ->', d(target));
if (target) {
    console.log('  parent  ->', d(GetParent(target)));
    console.log('  root    ->', d(GetAncestor(target, 2)));
    let p = GetParent(target), i = 0;
    while (p && IsWindow(p) && i < 6) { console.log('  up' + (i + 1) + '     ->', d(p)); p = GetParent(p); i++; }
}

console.log('--- all top-level "Chrome*" windows ---');
const found = [];
const cb = koffi.register((h) => {
    const c = cls(h);
    if (c.startsWith('Chrome')) found.push(d(h));
    return 1;
}, koffi.pointer(ENUMPROC));
EnumWindows(cb, 0);
found.forEach((s) => console.log('  ' + s));

console.log('--- WRY_WEBVIEW children (GW_CHILD chain) ---');
const wry = [];
const cb2 = koffi.register((h) => {
    if (cls(h) === 'WRY_WEBVIEW') wry.push(h);
    return 1;
}, koffi.pointer(ENUMPROC));
EnumWindows(cb2, 0);
for (const w of wry) {
    console.log('  WRY ' + d(w));
    let c = GetWindow(w, 5 /*GW_CHILD*/);
    let n = 0;
    while (c && IsWindow(c) && n < 6) { console.log('    child -> ' + d(c)); c = GetWindow(c, 2 /*GW_HWNDNEXT*/); n++; }
}
