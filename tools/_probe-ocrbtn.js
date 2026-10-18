/* 复现「点 OCR 按钮 → 卡死 + 鼠标被锁」这个 bug。
 *
 * 背景：picker 之前踩过同一个坑 —— 在 Tauri 命令自己的调用栈里直接
 * `run_on_main_thread` 去 `build()` 新窗口会死锁（主线程建 WebView2 时要回头
 * 等一把命令还没释放的锁）。`ocr_start` 是同样的结构，本脚本验证它是不是也卡。
 *
 * 判据：点完按钮后，日志里要么出现 `region: built`，要么停在
 * `region: 主线程闭包开始 build` 之后再无进展（= 死锁）。
 */
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
        out.push({ t: s, vis: !!IsWindowVisible(h), h, cl: p.x, ct: p.y, cw: cr.right - cr.left, ch: cr.bottom - cr.top });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return out;
}
const has = (t) => windows().some((w) => w.t === t && w.vis);
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
    if (!win) { console.log('FAIL 设置窗口没开起来'); process.exit(1); }
    SetForegroundWindow(win.h); sleep(900);

    /* 先切到 OCR 分页，再把「开始框选识别」滚进视口。
     * 注意 tab / btn 都要**先确保、再点、再等新坐标**，最后点完再等一次坐标 ——
     * 因为 btn-ocr 只在 OCR 页可见，而滚进视口本身不改变它是否可见。
     * 所以顺序是：ensure(tab-ocr) → 点 tab-ocr → 等新 rects → ensure(btn-ocr) → 点 btn-ocr。
     */
    let rects = {};
    const pull = (mark) => {
        const m = readLogSince(mark).match(/RECTS (\{.*\})/g);
        if (!m) return false;
        try { Object.assign(rects, JSON.parse(m[m.length - 1].slice(6))); return true; } catch (e) { return false; }
    };
    const ensure = async (name) => {
        const mk = fs.statSync(LOG).size;
        fs.appendFileSync(ENSURE, name + '\n', 'utf8');
        for (let i = 0; i < 25; i++) { sleep(140); if (pull(mk)) return true; }
        return false;
    };
    const geoOf = () => {
        const g = windows().find((w) => w.t === 'Quick Search 设置' && w.vis);
        return g ? { g, sx: g.cw / 780, sy: g.ch / 660 } : null;
    };
    const clickRect = async (name) => {
        await ensure(name);
        const gg = geoOf();
        const r = rects[name];
        if (!gg || !r || !r.h) return false;
        const px = Math.round(gg.g.cl + (r.x + r.w / 2) * gg.sx);
        const py = Math.round(gg.g.ct + (r.y + r.h / 2) * gg.sy);
        console.log(`  ${name} -> (${px},${py})`);
        SetForegroundWindow(gg.g.h); sleep(300);
        click(px, py);
        return true;
    };

    // ① 切到 OCR 页
    if (!await clickRect('tab-ocr')) { console.log('FAIL 点不到 tab-ocr'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 900));
    // ② 滚到「开始框选识别」再点它
    const gotBtn = await clickRect('btn-ocr');
    if (!gotBtn || !rects['btn-ocr'] || !rects['btn-ocr'].h) {
        console.log('FAIL 拿不到 btn-ocr 坐标', JSON.stringify(rects['btn-ocr']));
        process.exit(1);
    }

    const mark = fs.statSync(LOG).size;
    console.log('点「开始框选识别」…');

    // 给 10 秒，看 region 窗口有没有出来
    let appeared = false;
    for (let i = 0; i < 50; i++) {
        sleep(200);
        if (has('QS-Region')) { appeared = true; break; }
    }
    const seg = readLogSince(mark);
    const rel = seg.split('\n').filter((l) => /region|ocr|ESC|bail|build/i.test(l));
    console.log('--- 点击后本轮日志 ---');
    console.log(rel.slice(0, 20).join('\n') || '(空)');
    console.log(appeared
        ? 'PASS  框选遮罩正常出现（没卡死）'
        : 'FAIL  框选遮罩没出现 —— 卡死了（鼠标会被全屏遮罩锁死）');

    // 收尾：不管成没成，都把 region 关掉，别把用户桌面留在这个状态
    if (has('QS-Region')) {
        const ESC = 0x1B;
        const b = Buffer.alloc(40);
        b.writeUInt32LE(1, 0); b.writeUInt16LE(ESC, 8); b.writeUInt32LE(0, 12);
        const SendInput = user32.func('uint32 SendInput(uint32 n, void* p, int cb)');
        SendInput(1, b, 40);
        b.writeUInt32LE(2, 12);
        sleep(60);
        SendInput(1, b, 40);
        sleep(1200);
        console.log('收尾：按 Esc 后遮罩还在吗？' + (has('QS-Region') ? '在（连 Esc 也救不回来）' : '不在'));
    }
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    process.exit(appeared ? 0 : 1);
})();