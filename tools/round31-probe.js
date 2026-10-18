/* ============================================================================
 *  轮 31 专项探针：#143 图标编辑器
 *    一键消除背景（自动识别并去除图标背景，仅保留主体）
 *    编辑前后对比预览 / 保存 / 取消 / 容差重算 / 窗口复用 / Esc 关闭
 *
 *  取证方式：隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）+ CDP
 *  驱动真实 UI。两段：
 *    A 段 —— 算法像素级：直接调 icon_remove_bg，把返回的 PNG 在 Node 里解码，
 *            逐像素断言「四角透明 / 主体原样 / 计数合理 / SVG 拒收 / 容差生效」；
 *    B 段 —— 编辑器窗口真实链路：从设置页点「编辑图标」→ iconedit 窗口 →
 *            一键消除 → （读页面上的结果图再解码验像素）→ 保存落库 →
 *            取消不改配置 → 容差滑块重算 → SVG 会话 → 哨兵键（@fav:/@app:）
 *            → Esc 关窗。
 *
 *  用法：node tools/round31-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round31-probe.txt');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetCursorPos = user32.func('int GetCursorPos(_Out_ POINT *p)');
const SetCursorPos = user32.func('int SetCursorPos(int x, int y)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const AttachThreadInput = user32.func('int AttachThreadInput(int idAttach, int idAttachTo, int f)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ------------------------------ 窗口枚举 ------------------------------ */
const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
const wclass = (h) => {
    const t = new Uint16Array(400); const n = GetClassNameW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function wins() {
    const out = [];
    const cb = koffi.register((h) => {
        const t = wtext(h);
        if (t) {
            const r = {}; GetWindowRect(h, r);
            out.push({ hwnd: h, title: t, cls: wclass(h), vis: !!IsWindowVisible(h),
                       rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] });
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const barRect = () => { const w = wins().find((x) => x.title === 'QuickSearchBar'); return w ? w.rect : null; };
const waitBar = (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) { const r = barRect(); if (r && r[2] > 0) return r; sleep(120); }
    return null;
};

/* ------------------------------ CDP ------------------------------ */
let PORT = 9411;
let wsId = 0;
const wsPending = new Map();
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        wsPending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
function wireWs(ws) {
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && wsPending.has(m.id)) {
            const p = wsPending.get(m.id);
            wsPending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message || 'cdp'));
            else p.resolve(m.result);
        }
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text)
            + (desc ? ' | ' + String(desc).split('\n')[0] : '')
            + ' | ' + String(expr).slice(0, 120));
    }
    return r.result.value;
}
async function targets() {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); }
    catch (e) { return []; }
}
async function connectWhere(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        const ts = await targets();
        const hit = ts.find((t) => t.type === 'page' && pred(t.url || ''));
        if (hit) {
            const ws = new WebSocket(hit.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            wireWs(ws);
            return ws;
        }
        await sleep(300);
    }
    return null;
}
const isBarPage = (u) => /index\.html/.test(u) || /tauri\.localhost\/?$/.test(u);
const isSettingsPage = (u) => /settings\.html/.test(u);
const isIconEditPage = (u) => /iconedit\.html/.test(u);
async function waitInvoke(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        try {
            if ((await evalJs(ws, "typeof invoke === 'function' && typeof listen === 'function'")) === true) return true;
        } catch (e) { }
        await sleep(300);
    }
    return false;
}
async function waitFor(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 12000)) {
        try { if (await evalJs(ws, expr)) return true; } catch (e) { }
        await sleep(250);
    }
    return false;
}

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0, skipN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function skip(name, why) { skipN++; rec('  SKIP  ' + name + '   [' + why + ']'); }
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

const instances = [];

/* ========================================================================== *
 *  PNG 编解码（探针自证：不依赖任何第三方库）
 * ========================================================================== */
const CRC_T = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        t[n] = c >>> 0;
    }
    return t;
})();
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const b of body) crc = (crc >>> 8) ^ CRC_T[(crc ^ b) & 0xff];
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, c]);
}
/** 造一张 8bit RGBA 不交错 PNG。px = Buffer(w*h*4)。 */
function encodePng(w, h, px) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const stride = w * 4;
    const raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;                       // filter: None
        px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    return Buffer.concat([sig, pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
/** 解一张 8bit RGB/RGBA PNG（image crate 的编码器产物就在这个范围里）。 */
function decodePng(buf) {
    let off = 8, w = 0, h = 0, ct = 6;
    const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off); off += 4;
        const type = buf.toString('ascii', off, off + 4); off += 4;
        const data = buf.slice(off, off + len); off += len + 4;
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
    }
    const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 1;
    const stride = w * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const base = y * (stride + 1);
        const f = raw[base];
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let v = raw[base + 1 + x];
            if (f === 1) v = (v + a) & 255;
            else if (f === 2) v = (v + b) & 255;
            else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (f === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
            }
            cur[x] = v;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return {
        w, h, bpp, px: out,
        at(x, y) {
            const i = (y * w + x) * bpp;
            return [out[i], out[i + 1], out[i + 2], bpp === 4 ? out[i + 3] : 255];
        },
        countAlpha(min, max) {
            let n = 0;
            for (let i = 3; i < out.length; i += 4) if (out[i] >= min && out[i] <= max) n++;
            return n;
        },
    };
}
const dataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');
const b64Of = (dataUrlStr) => String(dataUrlStr).split(',')[1] || '';
const bufOfDataUrl = (u) => Buffer.from(String(u).split(',')[1] || '', 'base64');

/* --------------------- 造几张「底色 + 主体」测试图 --------------------- */
const BG_RED = [200, 40, 40], SUBJ_BLUE = [30, 90, 220];
/** 64×64：纯色红底 + 居中蓝圆盘（主体） */
function subjImg() {
    const w = 64, h = 64, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inDisc = (x - 31.5) * (x - 31.5) + (y - 31.5) * (y - 31.5) <= 16 * 16;
        const c = inDisc ? SUBJ_BLUE : BG_RED;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
    return encodePng(w, h, px);
}
/** 64×64：水平渐变底 + 居中蓝色方块（主体）。用于验「容差越大抠得越多」。 */
function gradImg() {
    const w = 64, h = 64, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const t = x / (w - 1);
        const inSq = x >= 20 && x <= 43 && y >= 20 && y <= 43;
        const c = inSq ? SUBJ_BLUE : [Math.round(200 - 160 * t), Math.round(40 + 120 * t), Math.round(40 + 20 * t)];
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
    return encodePng(w, h, px);
}
/** 64×64：全透明（验「已经是透明底 → removed=0」） */
function transImg() {
    return encodePng(64, 64, Buffer.alloc(64 * 64 * 4));
}
/** 64×64：双色底（外圈 8px 亮红 + 内区暗红，两色欧氏距离 ≈ 85）+ 居中蓝方块。
 *  专为「容差单调性」造：48 < 85 ≤ 120/150，所以小容差只抠外圈、
 *  大容差连内区一起抠 —— 平滑渐变图是做不到这一点的（渐变每步色差 ~3，
 *  5bit 桶代表色与任意底色距离 ≤12，48 和 150 必然抠得一样多）。 */
function toneImg() {
    const w = 64, h = 64, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inRing = x < 8 || x >= 56 || y < 8 || y >= 56;
        const inSq = x >= 20 && x <= 43 && y >= 20 && y <= 43;
        const c = inSq ? SUBJ_BLUE : (inRing ? BG_RED : [120, 60, 60]);
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
    return encodePng(w, h, px);
}
/** 600×400：纯色底 + 蓝圆盘（验 >512px 长边先缩放到 512） */
function bigImg() {
    const w = 600, h = 400, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inDisc = (x - 299.5) * (x - 299.5) + (y - 199.5) * (y - 199.5) <= 120 * 120;
        const c = inDisc ? SUBJ_BLUE : [200, 40, 40];
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
    return encodePng(w, h, px);
}
const SVG_SRC = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
    + '<rect width="64" height="64" fill="#c82828"/>'
    + '<circle cx="32" cy="32" r="16" fill="#1e5adc"/></svg>';

/* ========================================================================== *\
\* ================================ main ==================================== */
/* ========================================================================== */
(async function main() {
    rec('=== 轮 31 专项探针：#143 图标编辑器（一键消除背景）===');
    rec('');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r31-'));

    /* ---------- 测试图落盘（icons 目录 = 隔离实例的配置目录里） ---------- */
    const IMG_SUBJ = subjImg();       // Google 的 override：红底蓝盘
    const IMG_GRAD = gradImg();       // 算法段专用：平滑渐变底（验渐变也能抠）
    const IMG_TONE = toneImg();       // 必应的 override：双色底（验容差滑块有区分度）
    const IMG_DIR = subjImg();        // 百度：icons 目录同名默认图
    const IMG_FAV = subjImg();        // @fav: 哨兵的 override
    const IMG_APP = subjImg();        // @app: 哨兵的 override
    // 让三张「同名图」颜色可区分（保存落库后要能认出是谁）
    const IMG_DIR2 = (() => {
        const w = 64, h = 64, px = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const inDisc = (x - 31.5) * (x - 31.5) + (y - 31.5) * (y - 31.5) <= 14 * 14;
            const c = inDisc ? [240, 200, 40] : [40, 160, 90];
            px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
        }
        return encodePng(w, h, px);
    })();

    function makeConf(dir, extra) {
        const qs = path.join(dir, 'QuickSearch');
        fs.mkdirSync(qs, { recursive: true });
        const c = Object.assign({
            trigger_copy: false, trigger_select: false, ocr_enable: false,
            auto_color: false, auto_start: false,
            webdav_url: '', webdav_user: '', webdav_pass: '',
            webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
            backup_dir: '', fav_hotkey: '',
            custom_engines: [],
            bar_dim_alpha: 100,
            theme: 'light',
            // #143：横条上摆六种成员 —— 普通引擎(override)/普通引擎(目录默认图)/
            // 双色底 override / SVG override / OCR / 外部软件 / 收藏目录
            bar_list: ['Google', '百度', '必应', '知乎', '@ocr', '@app:r31app', '@fav:r31fav'],
            overrides: {
                'Google': 'g-subj.png',
                '必应': 'g-tone.png',
                '知乎': 'z-svg.svg',
                '@app:r31app': 'app-subj.png',
                '@fav:r31fav': 'fav-subj.png',
            },
            apps: [{ id: 'r31app', name: '轮31软件', url: 'https://example.com/', kind: 'open' }],
            favorites: [{
                id: 'r31fav', name: '轮31收藏', icon: '',
                items: [{ id: 'fi1', kind: 'text', text: '示例收藏', html: '', image: '', remark: '' }],
                children: [],
            }],
        }, extra || {});
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
        fs.mkdirSync(path.join(qs, 'icons'), { recursive: true });
        fs.writeFileSync(path.join(qs, 'icons', 'g-subj.png'), IMG_SUBJ);
        fs.writeFileSync(path.join(qs, 'icons', 'g-tone.png'), IMG_TONE);
        fs.writeFileSync(path.join(qs, 'icons', '百度.png'), IMG_DIR2);
        fs.writeFileSync(path.join(qs, 'icons', 'z-svg.svg'), SVG_SRC);
        fs.writeFileSync(path.join(qs, 'icons', 'app-subj.png'), IMG_APP);
        fs.writeFileSync(path.join(qs, 'icons', 'fav-subj.png'), IMG_FAV);
        return qs;
    }
    function spawnInstance(qs, port, tag) {
        PORT = port;
        const appData = path.dirname(qs);
        const env = Object.assign({}, process.env, {
            APPDATA: appData, LOCALAPPDATA: appData,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmpRoot, 'wv2-' + tag),
            QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
            QS_INSTANCE_TAG: tag,
            QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
                + ' --disable-gpu-sandbox --remote-debugging-port=' + port,
        });
        const p = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
        instances.push(p);
        rec('启动实例 pid=' + p.pid + '（CDP ' + port + '，tag=' + tag + '）');
        return p;
    }
    function killInstance(idx) {
        const p = instances[idx];
        if (p) { try { p.kill(); } catch (e) { } }
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            if (!barRect()) return true;
            sleep(150);
        }
        return !barRect();
    }
    const readCfg = (qs) => {
        try { return JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8')); } catch (e) { return null; }
    };
    const waitCfg = async (qs, pred, ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < (ms || 12000)) {
            const c = readCfg(qs);
            if (c && pred(c)) return c;
            await sleep(300);
        }
        return null;
    };

    /* 设置页横条行里点某个成员的「编辑图标」 */
    const clickRowBtn = (ws, nameRe, btnText) => evalJs(ws, `(function(){
        var rows=[].slice.call(document.querySelectorAll('#barList .item:not(.add-row)'));
        var row=null;
        for (var i=0;i<rows.length;i++){
            var nm=rows[i].querySelector('.nm');
            if(nm && ${nameRe}.test(nm.textContent)){ row=rows[i]; break; }
        }
        if(!row) return 'no-row';
        var bs=[].slice.call(row.querySelectorAll('.mini'));
        for (var j=0;j<bs.length;j++){
            if(bs[j].textContent===${JSON.stringify(btnText)}){ bs[j].click(); return 'clicked'; }
        }
        return 'no-btn';
    })()`);
    /** 编辑器窗口当前状态（DOM 快照） */
    const edState = async (ws) => JSON.parse(await evalJs(ws, `JSON.stringify({
        name: document.getElementById('ieName').textContent,
        before: document.getElementById('imgBefore').getAttribute('src'),
        after: document.getElementById('imgAfter').getAttribute('src'),
        hint: document.getElementById('hint').textContent,
        saveOff: document.getElementById('btnSave').disabled,
        rmOff: document.getElementById('btnRemove').disabled,
        tolOff: document.getElementById('tol').disabled,
        tolVal: document.getElementById('tolVal').textContent
    })`));
    /** 等编辑器装载完会话。name = 期望的显示名（括号前那截）——
     *  复用窗口时旧会话的标题也含「（」，不按名字等就会读到上一颗图标的状态
     *  （r31 第三轮 B6 就这么误过一次：知乎的会话重载还没渲染，断言先跑了）。 */
    const edReady = (ws, name) => waitFor(ws,
        "document.getElementById('ieName').textContent.indexOf('（') >= 0"
        + " && !!document.getElementById('imgBefore').getAttribute('src')"
        + (name ? " && document.getElementById('ieName').textContent.split('（')[0] === "
            + JSON.stringify(name) : ""), 15000);

    /* =====================================================================
     *  实例：横条页 + 设置页 + 编辑器窗，全程同一个实例
     * ===================================================================== */
    rec('');
    rec('############ 实例 E：#143 全链路（算法像素级 + 编辑器窗口）############');
    const qsE = makeConf(path.join(tmpRoot, 'E'));

    // 光标先挪开：别预停在横条上（横条每次弹同 rect，会有不补发 pointermove 的老问题）
    SetCursorPos(Math.round(SW / 2), Math.round(SH * 0.30));
    await sleep(200);
    spawnInstance(qsE, 9411, '-probe-r31');
    await sleep(8000);
    const barWs = await connectWhere(isBarPage, 30000);
    if (!barWs || !(await waitInvoke(barWs))) {
        chk('★ E0 连上横条页', false);
        rec('连不上横条页，后续全部跳过');
        rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
        flush();
        for (const p of instances) { try { p.kill(); } catch (e) { } }
        process.exit(1);
    }
    chk('★ E0 连上横条页（CDP 9411）', true);
    waitBar(10000);
    await sleep(1500);

    /* 打开设置窗，直接落「引擎」分页（横条成员列表在那里） */
    await evalJs(barWs, "invoke('open_settings', {tab:'engines'}).catch(function(e){})");
    const SET = await connectWhere(isSettingsPage, 25000);
    if (!SET || !(await waitInvoke(SET))) {
        chk('★ E0b 设置窗口打开（引擎分页）', false, '连不上 settings.html');
        rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
        flush();
        for (const p of instances) { try { p.kill(); } catch (e) { } }
        process.exit(1);
    }
    chk('★ E0b 设置窗口打开（引擎分页）', true);
    const rowsOk = await waitFor(SET,
        "document.querySelectorAll('#barList .item:not(.add-row)').length >= 7", 15000);
    chk('  E0c 横条成员列表渲染出 7 行（Google/百度/必应/知乎/@ocr/@app/@fav）', rowsOk);

    /* =====================================================================
     *  A 段：算法像素级（直接调 icon_remove_bg，把结果 PNG 解码验像素）
     * ===================================================================== */
    rec('');
    rec('---- A 段：消除背景算法像素级（#143）----');
    const removeBg = (ws, src, tol) => evalJs(ws,
        "invoke('icon_remove_bg', {src: " + JSON.stringify(src)
        + ", tolerance: " + JSON.stringify(tol) + "})"
        + ".then(function(r){return JSON.stringify(r);},"
        + "function(e){return 'ERR:'+e;})")
        .then((s) => { try { return JSON.parse(s); } catch (e) { return { __raw: s }; } });

    // A1：纯色底 + 蓝圆盘 → 四角透明、主体原样、计数合理
    {
        const r = await removeBg(SET, dataUrl(IMG_SUBJ), 48);
        chk('★ A1 纯色底图：命令成功返回', !!r && !r.__raw && !!r.src, r && (r.__raw || ''));
        if (r && r.src) {
            const img = decodePng(bufOfDataUrl(r.src));
            const corners = [[1, 1], [62, 1], [1, 62], [62, 62]]
                .map(([x, y]) => img.at(x, y)[3]);
            chk('  A1 四角 alpha = 0（底色被抠掉）', corners.every((a) => a === 0),
                'alpha=' + corners.join(','));
            const c = img.at(32, 32);
            chk('  A1 圆心还是主体蓝（RGB 不变、不透明）',
                c[0] === 30 && c[1] === 90 && c[2] === 220 && c[3] === 255,
                'rgba=' + c.join(','));
            const above = img.at(32, 20);
            chk('  A1 主体上沿（圆心上方 12px）不透明', above[3] === 255, 'alpha=' + above[3]);
            chk('  A1 removed 计数合理（>2500 且 < 全图 4096）',
                r.removed > 2500 && r.removed < 4096, 'removed=' + r.removed);
            chk('  A1 输出尺寸不变（64×64 ≤ 512 不缩放）',
                img.w === 64 && img.h === 64, img.w + 'x' + img.h);
        }
    }

    // A2：全透明图 → removed = 0（没有可抠的底色）
    {
        const r = await removeBg(SET, dataUrl(transImg()), 48);
        chk('  A2 全透明图 removed = 0（已是透明底，不动它）',
            !!r && !r.__raw && r.removed === 0, 'removed=' + (r && r.removed));
    }

    // A3：SVG → 明确拒收（矢量图没有位图背景）
    {
        const r = await removeBg(SET, 'data:image/svg+xml;base64,' + Buffer.from(SVG_SRC).toString('base64'), 48);
        chk('  A3 SVG 被拒收且提示说清原因',
            !!r && typeof r.__raw === 'string' && /SVG/.test(r.__raw), r && String(r.__raw).slice(0, 60));
    }

    // A4：容差 0 → 只抠与四边**完全同色**的像素
    {
        const r = await removeBg(SET, dataUrl(IMG_SUBJ), 0);
        chk('★ A4 容差 0：纯色底仍被精确抠掉', !!r && !r.__raw && r.removed > 2500,
            'removed=' + (r && r.removed));
        if (r && r.src) {
            const img = decodePng(bufOfDataUrl(r.src));
            chk('  A4 四角 alpha = 0', img.at(1, 1)[3] === 0 && img.at(62, 62)[3] === 0);
            const c = img.at(32, 32);
            chk('  A4 主体完好', c[0] === 30 && c[1] === 90 && c[2] === 220 && c[3] === 255,
                'rgba=' + c.join(','));
        }
    }

    // A5：渐变底 + 蓝方块 → 主体保留、能抠掉一部分渐变底
    {
        const r = await removeBg(SET, dataUrl(IMG_GRAD), 48);
        chk('  A5 渐变底图：命令成功', !!r && !r.__raw && !!r.src);
        if (r && r.src) {
            const img = decodePng(bufOfDataUrl(r.src));
            const c = img.at(32, 32);
            chk('  A5 主体蓝块保留（中心不透明、颜色不变）',
                c[0] === 30 && c[1] === 90 && c[2] === 220 && c[3] === 255, 'rgba=' + c.join(','));
            chk('  A5 渐变底被抠掉一部分（removed > 0）', r.removed > 0, 'removed=' + r.removed);
        }
    }

    // A6：容差单调性 + 超大容差钳制（双色底：外圈亮红 / 内区暗红，相距 ≈85）
    {
        const TONE = dataUrl(toneImg());
        const r48 = await removeBg(SET, TONE, 48);
        const rBig = await removeBg(SET, TONE, 9999);
        chk('  A6 双色底图：命令成功返回', !!r48 && !!rBig && !r48.__raw && !rBig.__raw,
            rBig && String(rBig.__raw || '').slice(0, 60));
        // 外圈 = 64² - 48² = 1792 个像素；小容差只该抠这一圈
        chk('  A6 容差 48：只抠外圈（removed 恰好 = 环上像素数 1792）',
            r48 && r48.removed === 1792, 'removed=' + (r48 && r48.removed));
        if (r48 && r48.src) {
            const a = decodePng(bufOfDataUrl(r48.src));
            chk('  A6 容差 48：内区暗红原样保留（不透明、颜色不变）',
                a.at(10, 10)[3] === 255 && a.at(10, 10)[0] === 120 && a.at(10, 10)[1] === 60,
                'rgba=' + a.at(10, 10).join(','));
            chk('  A6 容差 48：四角透明', a.at(1, 1)[3] === 0 && a.at(62, 62)[3] === 0);
        }
        chk('  A6 超大容差被钳制在 150（不报错）', !!rBig && !rBig.__raw && !!rBig.src);
        chk('  A6 容差越大抠得越多（双色底上 150 > 48，内区 85 ≤ 150 也被抠）',
            rBig && r48 && (rBig.removed || 0) > (r48.removed || 0) + 1000,
            'removed 48=' + (r48 && r48.removed) + ' / 9999→150=' + (rBig && rBig.removed));
        if (rBig && rBig.src) {
            const b = decodePng(bufOfDataUrl(rBig.src));
            chk('  A6 容差 150：内区也透明了', b.at(10, 10)[3] === 0,
                'alpha=' + b.at(10, 10)[3]);
            chk('  A6 容差 150：四角仍透明', b.at(1, 1)[3] === 0 && b.at(62, 62)[3] === 0);
            const c = b.at(32, 32);
            chk('  A6 两种容差下主体蓝块都完好（不透明、颜色不变）',
                c[0] === 30 && c[1] === 90 && c[2] === 220 && c[3] === 255, 'rgba=' + c.join(','));
        }
    }

    // A7：>512px 长边先缩放到 512（防大图噎住 IPC）
    {
        const r = await removeBg(SET, dataUrl(bigImg()), 48);
        chk('  A7 600×400 缩到 512 长边再处理',
            !!r && !r.__raw && r.src && (() => {
                const img = decodePng(bufOfDataUrl(r.src));
                return img.w === 512 && img.h > 300 && img.h <= 512;
            })(), r && r.src ? (decodePng(bufOfDataUrl(r.src)).w + 'x' + decodePng(bufOfDataUrl(r.src)).h) : 'fail');
    }

    /* =====================================================================
     *  B 段：编辑器窗口真实链路（设置页「编辑图标」→ iconedit 窗）
     * ===================================================================== */
    rec('');
    rec('---- B 段：编辑器窗口全链路（#143）----');

    // B1：Google 行（override 红底蓝盘）→ 编辑器开起来，装载正确
    {
        const clicked = await clickRowBtn(SET, '/Google/', '编辑图标');
        chk('★ B1 Google 行有「编辑图标」且点得动', clicked === 'clicked', clicked);
        const ED = await connectWhere(isIconEditPage, 30000);
        if (!ED) {
            chk('★ B1 编辑器窗口打开（iconedit.html）', false, '连不上 iconedit.html');
        } else {
            chk('★ B1 编辑器窗口打开（iconedit.html）', true);
            const ready = await edReady(ED, 'Google');
            chk('  B1 页面装载完会话（标题带键名）', ready);
            if (ready) {
                const st = await edState(ED);
                chk('  B1 标题显示引擎名 Google', /Google/.test(st.name), st.name);
                chk('  B1 编辑前预览 = override 的那张图（data URL 逐字节一致）',
                    st.before === dataUrl(IMG_SUBJ), 'before=' + String(st.before).slice(0, 42));
                chk('  B1 初始态：保存禁用 / 消除可用 / 容差禁用',
                    st.saveOff === true && st.rmOff === false && st.tolOff === true,
                    'save=' + st.saveOff + ' rm=' + st.rmOff + ' tol=' + st.tolOff);
                chk('  B1 编辑后 pane 还是占位提示', !st.after, 'after=' + st.after);

                // B2：一键消除背景 → 页面上的结果图解码验像素
                await evalJs(ED, "document.getElementById('btnRemove').click()");
                const ok2 = await waitFor(ED,
                    "document.getElementById('hint').textContent.indexOf('已消除') >= 0"
                    + " && !!document.getElementById('imgAfter').getAttribute('src')", 15000);
                chk('★ B2 点「一键消除背景」出结果（提示 + 结果图）', ok2);
                const st2 = await edState(ED);
                if (ok2) {
                    chk('  B2 提示报出抠掉的像素数', /已消除 [\d,]+ 个背景像素/.test(st2.hint), st2.hint);
                    chk('  B2 保存按钮解禁', st2.saveOff === false);
                    chk('  B2 容差滑块消过一次后启用', st2.tolOff === false);
                    const img = decodePng(bufOfDataUrl(st2.after));
                    chk('  B2 结果图四角透明（底色去除）',
                        img.at(1, 1)[3] === 0 && img.at(62, 62)[3] === 0);
                    const c = img.at(32, 32);
                    chk('  B2 结果图主体完好（圆心蓝、不透明）',
                        c[0] === 30 && c[1] === 90 && c[2] === 220 && c[3] === 255, 'rgba=' + c.join(','));
                    info('B2 编辑器提示：' + st2.hint);

                    // B3：保存 → 落库 + 换文件 + 旧文件删掉
                    await evalJs(ED, "document.getElementById('btnSave').click()");
                    const cfg3 = await waitCfg(qsE, (c) => c.overrides
                        && c.overrides.Google && c.overrides.Google !== 'g-subj.png', 12000);
                    chk('★ B3 保存后 config.overrides.Google 换成新文件', !!cfg3,
                        cfg3 ? cfg3.overrides.Google : '没变');
                    if (cfg3) {
                        const newFile = path.join(qsE, 'icons', cfg3.overrides.Google);
                        chk('  B3 新图标文件写进 icons 目录', fs.existsSync(newFile), cfg3.overrides.Google);
                        chk('  B3 旧图标文件被清掉（没人引用就不占地）',
                            !fs.existsSync(path.join(qsE, 'icons', 'g-subj.png')));
                        if (fs.existsSync(newFile)) {
                            const img = decodePng(fs.readFileSync(newFile));
                            chk('  B3 落库文件四角透明、主体完好',
                                img.at(1, 1)[3] === 0 && img.at(32, 32)[3] === 255
                                && img.at(32, 32)[0] === 30 && img.at(32, 32)[2] === 220,
                                img.w + 'x' + img.h);
                        }
                    }
                    const closed3 = await waitFor(SET, "true", 500).then(() => true);
                    info('B3 保存后编辑器自行关窗（Rust 侧 close_icon_editor）');
                }
            }
        }
    }

    // B4：百度行（icons 目录同名默认图，第三级解析）→ 取消 → 配置一字不改
    {
        const cfgBefore = fs.readFileSync(path.join(qsE, 'config.json'), 'utf8');
        const clicked = await clickRowBtn(SET, '/百度/', '编辑图标');
        chk('  B4 百度行（目录默认图）有「编辑图标」', clicked === 'clicked', clicked);
        const ED = await connectWhere(isIconEditPage, 20000);
        if (!ED) { chk('  B4 编辑器复用/打开', false, '连不上'); }
        else {
            const ready = await edReady(ED, '百度');
            if (ready) {
                const st = await edState(ED);
                chk('  B4 标题显示百度', /百度/.test(st.name), st.name);
                chk('  B4 编辑前预览 = icons/百度.png（目录默认图通道）',
                    st.before === dataUrl(IMG_DIR2), 'before=' + String(st.before).slice(0, 42));
                await evalJs(ED, "document.getElementById('btnCancel').click()");
                await sleep(1200);
                const cfgAfter = fs.readFileSync(path.join(qsE, 'config.json'), 'utf8');
                chk('★ B4 取消后 config.json 一字未改（不写任何东西）',
                    cfgBefore === cfgAfter,
                    cfgBefore === cfgAfter ? '' : '内容变了');
            } else { chk('  B4 编辑器装载会话', false); }
        }
    }

    // B5：必应行（双色底 override）→ 容差滑块：48 → 120 从原图重算，抠得更多
    {
        const clicked = await clickRowBtn(SET, '/必应/', '编辑图标');
        chk('  B5 必应行（双色底 override）有「编辑图标」', clicked === 'clicked', clicked);
        const ED = await connectWhere(isIconEditPage, 20000);
        if (!ED) { chk('  B5 编辑器复用/打开', false, '连不上'); }
        else {
            const ready = await edReady(ED, '必应');
            if (ready) {
                await evalJs(ED, "document.getElementById('btnRemove').click()");
                const ok1 = await waitFor(ED,
                    "document.getElementById('hint').textContent.indexOf('已消除') >= 0"
                    + " && !!document.getElementById('imgAfter').getAttribute('src')", 15000);
                const st1 = await edState(ED);
                const n1 = ok1 ? Number((st1.hint.match(/已消除 ([\d,]+) 个/) || [0, '0'])[1].replace(/,/g, '')) : -1;
                const out1 = ok1 ? decodePng(bufOfDataUrl(st1.after)) : null;
                chk('  B5 默认容差 48 先消一次', ok1 && n1 >= 0, 'removed=' + n1);
                // 拖容差到 120（防抖 180ms，等 500ms 足够）
                const tolShown = await evalJs(ED, `(function(){
                    var t=document.getElementById('tol');
                    t.value='120';
                    t.dispatchEvent(new Event('input',{bubbles:true}));
                    return document.getElementById('tolVal').textContent;
                })()`);
                chk('  B5 滑块拖动即时更新数值显示', tolShown === '120', 'tolVal=' + tolShown);
                await sleep(600);
                const st2 = await edState(ED);
                const n2 = Number((st2.hint.match(/已消除 ([\d,]+) 个/) || [0, '0'])[1].replace(/,/g, ''));
                chk('★ B5 拖容差后按新值从原图重算（双色底上 120 比 48 抠得多）',
                    n2 > n1, 'removed 48=' + n1 + ' → 120=' + n2);
                if (out1 && st2.after) {
                    const out2 = decodePng(bufOfDataUrl(st2.after));
                    const t1 = out1.countAlpha(0, 0), t2 = out2.countAlpha(0, 0);
                    chk('  B5 像素级：透明像素数随容差变大而变多', t2 > t1,
                        'alpha=0 像素 ' + t1 + ' → ' + t2);
                    const c = out2.at(32, 32);
                    chk('  B5 主体在两种容差下都完好',
                        c[0] === 30 && c[1] === 90 && c[2] === 220 && c[3] === 255, 'rgba=' + c.join(','));
                }
            } else { chk('  B5 编辑器装载会话', false); }
        }
    }

    // B6：知乎行（SVG override）→ 复用同一个窗口，消除禁用、保存可用
    {
        const nTargetsBefore = (await targets()).filter((t) => isIconEditPage(t.url || '')).length;
        const clicked = await clickRowBtn(SET, '/知乎/', '编辑图标');
        chk('  B6 知乎行（SVG override）有「编辑图标」', clicked === 'clicked', clicked);
        const ED = await connectWhere(isIconEditPage, 20000);
        if (!ED) { chk('  B6 编辑器复用（不新建窗口）', false, '连不上'); }
        else {
            const ready = await edReady(ED, '知乎');
            if (ready) {
                const st = await edState(ED);
                chk('  B6 复用同一窗口换会话（标题换成知乎）', /知乎/.test(st.name), st.name);
                chk('  B6 SVG 会话：「一键消除背景」禁用（没有位图背景）', st.rmOff === true);
                chk('  B6 SVG 会话：保存仍可用（原样应用）', st.saveOff === false);
                chk('  B6 有说明提示', /SVG/.test(st.hint), st.hint);
                const nTargetsAfter = (await targets()).filter((t) => isIconEditPage(t.url || '')).length;
                chk('  B6 全程只有 1 个编辑器窗口（复用不重复建窗）',
                    nTargetsAfter === 1 && nTargetsBefore === 1,
                    'before=' + nTargetsBefore + ' after=' + nTargetsAfter);
            } else { chk('  B6 编辑器装载会话', false); }
        }
    }

    // B7：收藏目录哨兵（@fav:<id>）→ 显示名解析成目录名 + 保存落库
    {
        const clicked = await clickRowBtn(SET, '/轮31收藏/', '编辑图标');
        chk('  B7 收藏目录行（@fav: 哨兵）有「编辑图标」', clicked === 'clicked', clicked);
        const ED = await connectWhere(isIconEditPage, 20000);
        if (!ED) { chk('  B7 编辑器复用/打开', false, '连不上'); }
        else {
            const ready = await edReady(ED, '轮31收藏');
            if (ready) {
                const st = await edState(ED);
                chk('★ B7 哨兵键解析成人话（标题显示目录名，不是 @fav:xxx）',
                    /^轮31收藏（/.test(st.name), st.name);
                await evalJs(ED, "document.getElementById('btnRemove').click()");
                const ok2 = await waitFor(ED,
                    "document.getElementById('hint').textContent.indexOf('已消除') >= 0", 15000);
                chk('  B7 哨兵图也能正常消除背景', ok2);
                if (ok2) {
                    await evalJs(ED, "document.getElementById('btnSave').click()");
                    const cfg7 = await waitCfg(qsE, (c) => c.overrides
                        && c.overrides['@fav:r31fav'] && c.overrides['@fav:r31fav'] !== 'fav-subj.png', 12000);
                    chk('★ B7 保存后 @fav: 哨兵的 override 换成新文件', !!cfg7,
                        cfg7 ? cfg7.overrides['@fav:r31fav'] : '没变');
                }
            } else { chk('  B7 编辑器装载会话', false); }
        }
    }

    // B8：外部软件哨兵（@app:<id>）→ 显示名 = 软件名 → Esc 关窗
    {
        const clicked = await clickRowBtn(SET, '/轮31软件/', '编辑图标');
        chk('  B8 外部软件行（@app: 哨兵）有「编辑图标」', clicked === 'clicked', clicked);
        const ED = await connectWhere(isIconEditPage, 20000);
        if (!ED) { chk('  B8 编辑器复用/打开', false, '连不上'); }
        else {
            const ready = await edReady(ED, '轮31软件');
            if (ready) {
                const st = await edState(ED);
                chk('★ B8 哨兵键解析成人话（标题显示软件名，不是 @app:xxx）',
                    /^轮31软件（/.test(st.name), st.name);
                // Esc 关窗（页面级 keydown 监听）
                await cdp(ED, 'Input.dispatchKeyEvent', {
                    type: 'rawKeyDown', key: 'Escape', code: 'Escape',
                    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
                });
                await cdp(ED, 'Input.dispatchKeyEvent', {
                    type: 'keyUp', key: 'Escape', code: 'Escape',
                    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
                });
                const gone = await (async () => {
                    const t0 = Date.now();
                    while (Date.now() - t0 < 8000) {
                        if ((await targets()).filter((t) => isIconEditPage(t.url || '')).length === 0) return true;
                        await sleep(300);
                    }
                    return false;
                })();
                chk('★ B8 按 Esc 关掉编辑器（不保存任何东西）', gone);
                const cfg8 = readCfg(qsE);
                chk('  B8 Esc 后配置里没有多出/改动这个哨兵的图标',
                    cfg8 && cfg8.overrides['@app:r31app'] === 'app-subj.png',
                    cfg8 ? JSON.stringify(cfg8.overrides['@app:r31app']) : 'null');
            } else { chk('  B8 编辑器装载会话', false); }
        }
    }

    // 收尾：设置页应收到过「图标已更新」提示（保存链路 Toast 通道）
    info('保存链路 toast 走 qs://toast → 设置页（Rust 侧 toast_settings）');

    rec('');
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    process.exit(failN === 0 ? 0 : 1);
})().catch((e) => {
    rec('探针本身抛异常：' + (e && (e.stack || e.message || String(e))));
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    process.exit(1);
});
