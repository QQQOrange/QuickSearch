/* 用 koffi 把 QuickSearchBar 窗口自身渲出来存 BMP。
   Tauri 的透明窗口是 DirectComposition 后备的，桌面 BitBlt 抓不到，
   必须用 PrintWindow + PW_RENDERFULLCONTENT。
   只截这一个窗口，不会把用户整个桌面抓走。 */

const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

// 先在进程级打开 DPI 感知，否则坐标和位图都会被虚拟化到一半
const SetProcessDpiAwarenessContext = user32.func('int SetProcessDpiAwarenessContext(intptr ctx)');
try { SetProcessDpiAwarenessContext(-4); } catch (e) { /* PER_MONITOR_AWARE_V2 */ }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16',
    biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32',
    biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'uint32', biClrImportant: 'uint32'
});
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32', 1) });

const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 name)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *buf, int n)');
const PrintWindow = user32.func('int PrintWindow(void *h, void *dc, uint32 flags)');
const GetDC = user32.func('void *GetDC(void *h)');
const ReleaseDC = user32.func('int ReleaseDC(void *h, void *dc)');
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *dc, int w, int h)');
const SelectObject = gdi32.func('void *SelectObject(void *dc, void *obj)');
const GetDIBits = gdi32.func('int GetDIBits(void *dc, void *bmp, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ BITMAPINFO *bi, uint32 usage)');
const DeleteObject = gdi32.func('int DeleteObject(void *obj)');
const DeleteDC = gdi32.func('int DeleteDC(void *dc)');

function writeBmp(file, w, h, bgra) {
    const pixSize = w * 4 * h;
    const header = Buffer.alloc(14 + 40);
    header.write('BM', 0, 'ascii');
    header.writeUInt32LE(14 + 40 + pixSize, 2);
    header.writeUInt32LE(14 + 40, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(w, 18);
    header.writeInt32LE(h, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(32, 28);
    header.writeUInt32LE(pixSize, 34);
    fs.writeFileSync(file, Buffer.concat([header, bgra]));
}

const hwnd = FindWindowW(null, 'QuickSearchBar');
if (!hwnd) { console.log(JSON.stringify({ found: false })); process.exit(2); }

const titleBuf = new Uint16Array(260);
GetWindowTextW(hwnd, titleBuf, 260);
const z = Array.prototype.indexOf.call(titleBuf, 0);
const r = {};
GetWindowRect(hwnd, r);
const vis = IsWindowVisible(hwnd);
const w = r.right - r.left;
const h = r.bottom - r.top;

const out = {
    found: true, hwnd: String(hwnd), visible: !!vis,
    rect: r, size: [w, h],
    title: String.fromCharCode(...titleBuf.slice(0, z < 0 ? 16 : z))
};

if (process.argv[2] && w > 0 && h > 0) {
    const screen = GetDC(null);
    const mem = CreateCompatibleDC(screen);
    const bmp = CreateCompatibleBitmap(screen, w, h);
    const old = SelectObject(mem, bmp);
    // PW_RENDERFULLCONTENT = 0x2
    const ok = PrintWindow(hwnd, mem, 2);
    SelectObject(mem, old);
    const buf = Buffer.alloc(w * h * 4);
    const bi = {
        bmiHeader: {
            biSize: 40, biWidth: w, biHeight: h, biPlanes: 1, biBitCount: 32,
            biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
            biClrUsed: 0, biClrImportant: 0
        }, bmiColors: [0]
    };
    const lines = GetDIBits(mem, bmp, 0, h, buf, bi, 0);
    DeleteObject(bmp); DeleteDC(mem); ReleaseDC(null, screen);
    out.printWindow = !!ok;
    out.lines = lines;
    if (lines > 0) {
        let nonBlack = 0, sum = 0, alphaSum = 0;
        for (let i = 0; i < buf.length; i += 4) {
            const v = buf[i] + buf[i + 1] + buf[i + 2];
            sum += v; alphaSum += buf[i + 3];
            if (v > 30) nonBlack++;
        }
        out.nonBlackRatio = +(nonBlack / (w * h)).toFixed(4);
        out.avgBrightness = +(sum / (w * h) / 3).toFixed(1);
        out.avgAlpha = +(alphaSum / (w * h)).toFixed(1);
        writeBmp(path.resolve(process.argv[2]), w, h, buf);
    }
}
console.log(JSON.stringify(out, null, 2));
