/* r34 诊断：微信选中取词不弹条 —— 现场勘查（只读，不注入任何输入）
 *
 * 模式：
 *   默认            枚举可见窗口树（class/标题/rect/pid）+ 拖拽点命中测试
 *   --shot x,y,w,h  把指定屏幕区域存成 PNG（BitBlt + 手写 PNG 编码）
 *
 * 背景：真实日志显示在微信（pid 2280）里划词后，我们三种复制通道都拿到
 * 「序号变了 + owner=微信 + 剪贴板空的」——微信执行了复制但什么都没写。
 * 需要先弄清用户到底在哪个子窗口里划动、那是不是文本区。
 */
const koffi = require('koffi');
const fs = require('fs');
const zlib = require('zlib');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const psapi = koffi.load('psapi.dll');

const SetProcessDpiAwarenessContext = user32.func('int SetProcessDpiAwarenessContext(intptr ctx)');
try { SetProcessDpiAwarenessContext(-4); } catch (e) { console.log('DPI 感知设置失败', e.message || e); }

// ---------- 结构体 ----------
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

// ---------- 函数 ----------
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *buf, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *buf, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const GetParent = user32.func('void *GetParent(void *h)');
const GetWindow = user32.func('void *GetWindow(void *h, uint32 cmd)');
const WindowFromPoint = user32.func('void *WindowFromPoint(POINT p)');
const ChildWindowFromPointEx = user32.func('void *ChildWindowFromPointEx(void *h, POINT p, uint32 flags)');
const RealGetWindowClassW = user32.func('int RealGetWindowClassW(void *h, _Out_ uint16 *buf, int n)');

const GW_HWNDFIRST = 0, GW_HWNDLAST = 1, GW_HWNDNEXT = 2, GW_HWNDPREV = 3, GW_OWNER = 4, GW_CHILD = 5;
const CWP_ALL = 0x0000, CWP_SKIPINVISIBLE = 0x0001, CWP_SKIPTRANSPARENT = 0x0004;

const GetProcessImageFileNameW = psapi.func('int GetProcessImageFileNameW(void *h, _Out_ uint16 *buf, int n)');
const kernel32 = koffi.load('kernel32.dll');
const OpenProcess = kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)');
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const CloseHandle = kernel32.func('int CloseHandle(void *h)');

function clsOf(h) {
    const b = new Uint16Array(256);
    const n = GetClassNameW(h, b, 256);
    if (!n) return '';
    return String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, n));
}
function txtOf(h) {
    const b = new Uint16Array(512);
    const n = GetWindowTextW(h, b, 512);
    if (!n) return '';
    return String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, n));
}
function rectOf(h) {
    const r = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetWindowRect(h, r)) return null;
    return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}
function pidOf(h) {
    const p = Buffer.alloc(4);
    const tid = GetWindowThreadProcessId(h, p);
    return { pid: p.readUInt32LE(0), tid };
}
function procName(pid) {
    const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!h) return '?';
    const b = new Uint16Array(260);
    const n = GetProcessImageFileNameW(h, b, 260);
    CloseHandle(h);
    if (!n) return '?';
    const p = String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, n));
    return p.split('\\').pop();
}

// ---------- 枚举 ----------
function enumTop() {
    const out = [];
    let h = null;
    // 走 z 序（GetTopWindow 需要 Desktop 根）
    const GetDesktopWindow = user32.func('void *GetDesktopWindow()');
    const GetTopWindow = user32.func('void *GetWindow(void *h, uint32 cmd)');
    let cur = GetTopWindow(GetDesktopWindow(), 0); // GW_HWNDFIRST
    while (cur) {
        out.push(cur);
        cur = GetWindow(cur, GW_HWNDNEXT);
        if (out.length > 400) break;
    }
    return out;
}

function enumChildren(hwnd) {
    const out = [];
    let c = GetWindow(hwnd, GW_CHILD);
    while (c) {
        out.push(c);
        c = GetWindow(c, GW_HWNDNEXT);
        if (out.length > 200) break;
    }
    return out;
}

function hitChain(x, y) {
    const p = { x, y };
    const w = WindowFromPoint(p);
    const chain = [];
    let cur = w;
    for (let i = 0; i < 8 && cur; i++) {
        const r = rectOf(cur);
        const pid = pidOf(cur);
        chain.push({ hwnd: '0x' + cur.toString(16), cls: clsOf(cur), title: txtOf(cur).slice(0, 40), rect: r, pid: pid.pid, proc: procName(pid.pid) });
        cur = GetParent(cur);
    }
    return { wfp: w ? '0x' + w.toString(16) : null, chain };
}

// ---------- PNG 编码（RGBA → PNG，复用 round33 手法） ----------
const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const body = Buffer.concat([tb, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const idat = zlib.deflateSync(raw);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
    ]);
}
const GetDC = user32.func('void *GetDC(void *h)');
const ReleaseDC = user32.func('int ReleaseDC(void *h, void *dc)');
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *dc, int w, int h)');
const SelectObject = gdi32.func('void *SelectObject(void *dc, void *obj)');
const GetDIBits = gdi32.func('int GetDIBits(void *dc, void *bmp, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ void *bi, uint32 usage)');
const DeleteObject = gdi32.func('int DeleteObject(void *obj)');
const DeleteDC = gdi32.func('int DeleteDC(void *dc)');
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16',
    biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32',
    biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'uint32', biClrImportant: 'uint32',
});
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32', 1) });

function shotRegion(x, y, w, h, out) {
    const dc = GetDC(null);
    const mdc = CreateCompatibleDC(dc);
    const bmp = CreateCompatibleBitmap(dc, w, h);
    SelectObject(mdc, bmp);
    const BitBlt = gdi32.func('int BitBlt(void *dc, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)');
    BitBlt(mdc, 0, 0, w, h, dc, x, y, 0x00cc0020); // SRCCOPY
    const bits = Buffer.alloc(w * h * 4);
    const bi = { bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: new Uint32Array(1) };
    GetDIBits(mdc, bmp, 0, h, bits, bi, 0);
    // BGRA → RGBA
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = bits[i * 4 + 2]; rgba[i * 4 + 1] = bits[i * 4 + 1]; rgba[i * 4 + 2] = bits[i * 4]; rgba[i * 4 + 3] = 255;
    }
    fs.writeFileSync(out, encodePng(rgba, w, h));
    DeleteObject(bmp); DeleteDC(mdc); ReleaseDC(null, dc);
    console.log('已保存截图', out, w + 'x' + h, '@(' + x + ',' + y + ')');
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
if (args[0] === '--shot') {
    const [x, y, w, h] = args[1].split(',').map(Number);
    shotRegion(x, y, w, h, args[2] || 'shot.png');
    process.exit(0);
}

const tops = enumTop();
const vis = tops.filter(h => IsWindowVisible(h));
console.log('可见顶层窗口数:', vis.length);
const lines = [];
for (const h of vis) {
    const r = rectOf(h), pid = pidOf(h);
    if (!r) continue;
    if (r.w < 40 || r.h < 40) continue;
    lines.push({ hwnd: '0x' + h.toString(16), cls: clsOf(h), title: txtOf(h).slice(0, 60), rect: r, pid: pid.pid, proc: procName(pid.pid) });
}
lines.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
for (const l of lines) {
    if (['explorer.exe', 'Weixin.exe', 'QQ.exe', 'WorkBuddy.exe', 'msedge.exe'].includes(l.proc)) {
        console.log(`${l.proc.padEnd(14)} pid=${String(l.pid).padStart(6)} (${l.rect.x},${l.rect.y},${l.rect.w},${l.rect.h}) ${l.cls} 「${l.title}」`);
    }
}

console.log('\n=== 日志拖拽点命中测试 ===');
for (const [x, y] of [[2914, 1307], [3034, 1310], [3034, 1310], [2992, 1298], [2926, 1300], [2964, 1751], [2953, 1830], [1474, 1694]]) {
    console.log(`(${x},${y}):`, JSON.stringify(hitChain(x, y)));
}

console.log('\n=== 微信主窗口子窗口（若在） ===');
const wx = tops.find(h => clsOf(h).startsWith('Qt51514QWindowIcon') && IsWindowVisible(h));
if (wx) {
    const r = rectOf(wx), pid = pidOf(wx);
    console.log('主窗', '0x' + wx.toString(16), 'pid', pid.pid, JSON.stringify(r));
    const kids = enumChildren(wx);
    console.log('直接子窗数:', kids.length);
    for (const c of kids) {
        const cr = rectOf(c), cpid = pidOf(c);
        console.log(`  child 0x${c.toString(16)} ${clsOf(c)} (${cr ? cr.x + ',' + cr.y + ',' + cr.w + ',' + cr.h : 'no-rect'}) pid=${cpid.pid} 「${txtOf(c).slice(0, 30)}」`);
    }
    console.log('\n=== 递归两层 ===');
    for (const c of kids) {
        const gk = enumChildren(c);
        if (!gk.length) continue;
        console.log(`  └ 0x${c.toString(16)} ${clsOf(c)} 的子窗:`);
        for (const g of gk.slice(0, 30)) {
            const gr = rectOf(g), gpid = pidOf(g);
            console.log(`     0x${g.toString(16)} ${clsOf(g)} (${gr ? gr.x + ',' + gr.y + ',' + gr.w + ',' + gr.h : 'no-rect'}) pid=${gpid.pid}`);
        }
    }
} else {
    console.log('没找到可见的 Qt51514QWindowIcon 主窗');
}
