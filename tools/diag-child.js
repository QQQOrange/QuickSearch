/* 全面体检 QuickSearchBar：
   - 自身 / 子窗口（WebView2 宿主）的尺寸、可见性、透明度
   - GetWindowDisplayAffinity（是否被排除在截屏之外）
   - PrintWindow 逐个抓，看谁画了东西
*/
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16',
    biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32',
    biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'uint32', biClrImportant: 'uint32'
});
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32', 1) });
const ENUMPROC = koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)');

const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 name)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const GetWindowLongPtrW = user32.func('intptr GetWindowLongPtrW(void *h, int idx)');
const EnumChildWindows = user32.func('int EnumChildWindows(void *p, void *cb, intptr lp)');
const GetWindowDisplayAffinity = user32.func('int GetWindowDisplayAffinity(void *h, _Out_ uint32 *aff)');
const PrintWindow = user32.func('int PrintWindow(void *h, void *dc, uint32 flags)');
const GetDC = user32.func('void *GetDC(void *h)');
const ReleaseDC = user32.func('int ReleaseDC(void *h, void *dc)');
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *dc, int w, int h)');
const SelectObject = gdi32.func('void *SelectObject(void *dc, void *o)');
const GetDIBits = gdi32.func('int GetDIBits(void *dc, void *bmp, uint32 s, uint32 l, _Out_ void *bits, _Inout_ BITMAPINFO *bi, uint32 u)');
const DeleteObject = gdi32.func('int DeleteObject(void *o)');
const DeleteDC = gdi32.func('int DeleteDC(void *dc)');

function stats(h, tag, saveAs) {
    const r = {}, c = { aff: 0 };
    GetWindowRect(h, r); GetClientRect(h, c);
    const w = r.right - r.left, hh = r.bottom - r.top;
    const b = new Uint16Array(300);
    const n = GetClassNameW(h, b, 300);
    let cls = '';
    for (let i = 0; i < n; i++) cls += String.fromCharCode(b[i]);
    const st = GetWindowLongPtrW(h, -16), ex = GetWindowLongPtrW(h, -20);
    const aff = Buffer.alloc(4);
    const affinityOk = GetWindowDisplayAffinity(h, aff);
    const out = {
        tag, hwnd: String(h), cls,
        vis: !!IsWindowVisible(h),
        rect: `${w}x${hh} @${r.left},${r.top}`,
        client: `${c.right - c.left}x${c.bottom - c.top}`,
        style: '0x' + (st >>> 0).toString(16),
        exstyle: '0x' + (ex >>> 0).toString(16),
        WS_VISIBLE: !!(st & 0x10000000),
        WS_EX_LAYERED: !!(ex & 0x80000),
        WS_EX_NOREDIRECTIONBITMAP: !!(ex & 0x200000),
        affinityOk: !!affinityOk,
        displayAffinity: affinityOk ? '0x' + aff.readUInt32LE(0).toString(16) : 'call-failed'
    };
    if (w > 0 && hh > 0 && w < 4000 && hh < 4000) {
        const screen = GetDC(null);
        const mem = CreateCompatibleDC(screen);
        const bmp = CreateCompatibleBitmap(screen, w, hh);
        const old = SelectObject(mem, bmp);
        const ok = PrintWindow(h, mem, 2);
        SelectObject(mem, old);
        const buf = Buffer.alloc(w * hh * 4);
        const bi = {
            bmiHeader: { biSize: 40, biWidth: w, biHeight: hh, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 },
            bmiColors: [0]
        };
        const lines = GetDIBits(mem, bmp, 0, hh, buf, bi, 0);
        if (lines > 0) {
            let nb = 0, sum = 0, as = 0, minA = 255;
            for (let i = 0; i < buf.length; i += 4) {
                const v = buf[i] + buf[i + 1] + buf[i + 2];
                sum += v; as += buf[i + 3];
                if (buf[i + 3] < minA) minA = buf[i + 3];
                if (v > 30) nb++;
            }
            out.pw = !!ok; out.pwNonBlack = +(nb / (w * hh)).toFixed(4);
            out.pwAvgBright = +(sum / (w * hh) / 3).toFixed(1);
            out.pwAvgAlpha = +(as / (w * hh)).toFixed(1);
            out.pwMinAlpha = minA;
            if (saveAs) {
                const pix = w * 4 * hh;
                const hd = Buffer.alloc(54);
                hd.write('BM'); hd.writeUInt32LE(54 + pix, 2); hd.writeUInt32LE(54, 10);
                hd.writeUInt32LE(40, 14); hd.writeInt32LE(w, 18); hd.writeInt32LE(hh, 22);
                hd.writeUInt16LE(1, 26); hd.writeUInt16LE(32, 28); hd.writeUInt32LE(pix, 34);
                fs.writeFileSync(saveAs, Buffer.concat([hd, buf]));
            }
        }
        DeleteObject(bmp); DeleteDC(mem); ReleaseDC(null, screen);
    }
    return out;
}

const BAR = FindWindowW(null, 'QuickSearchBar');
if (!BAR) { console.log(JSON.stringify({ found: false })); process.exit(2); }

console.log(JSON.stringify(stats(BAR, 'bar', path.resolve('../_pw-bar.bmp')), null, 2));

const kids = [];
const cb = koffi.register((h) => { kids.push(h); return 1; }, koffi.pointer(ENUMPROC));
EnumChildWindows(BAR, cb, 0);
console.log('children =', kids.length);
kids.forEach((k, i) => console.log(JSON.stringify(stats(k, 'child' + i, path.resolve('../_pw-child' + i + '.bmp')), null, 2)));
