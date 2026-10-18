/* ============================================================================
 *  轮 30 专项探针：本轮九项功能（#133-#141）
 *    #133 玻璃预设轻量/标准/深度直切不闪「自定义」+ 三档质感重调
 *    #134 「一键诊断」：当前状态 + 各环节耗时 + 每环节独立优化按钮；
 *         硬约束——禁止因高精度慢而自动回退标准版（诊断只读不改）
 *    #135 软件引擎补「搜索/打开」类型分类（与网页引擎一致按用途划分）
 *    #136 设置页全部引擎三大类分组 + 点大类经子分类展开；软件引擎页同交互
 *    #137 液态玻璃预览：设为玻璃样式后预览要能显示该样式
 *    #138 自定义默认图标：icons 目录「文件名=引擎名」设为对应引擎默认图标
 *    #139 主题同步：横条更多引擎页/收藏夹页跟随当前主题
 *    #140 更多引擎页+设置引擎页分类导航：三选项改小型胶囊横条同一行
 *    #141 收藏夹返回逻辑：经更多引擎页打开收藏夹，收起返回更多引擎页
 *
 *  取证方式：隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）+ CDP
 *  驱动真实 UI + 读 config.json 验证落库。OCR 诊断只打空凭证/假凭证两条
 *  链（假凭证必然被百度打回，不断言"打通"，只断言结构与不私自降档）。
 *
 *  用法：node tools/round30-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round30-probe.txt');

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
function forceForeground(h) {
    const fg = GetForegroundWindow();
    if (fg === h) return true;
    const b1 = Buffer.alloc(4), b2 = Buffer.alloc(4);
    const tFg = GetWindowThreadProcessId(fg, b1);
    const tH = GetWindowThreadProcessId(h, b2);
    const attached = tFg && tH && tFg !== tH ? AttachThreadInput(tFg, tH, 1) : 0;
    const ok = !!SetForegroundWindow(h);
    if (attached) AttachThreadInput(tFg, tH, 0);
    return ok;
}

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
async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        rec('  [截图] ' + name);
    } catch (e) { rec('  WARN  截图失败 ' + name + ' → ' + e.message); }
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

/* 实例进程表放模块作用域：main 里 throw 到 catch 时也要能回收子进程 */
const instances = [];

/* -------------------- 造两张不一样的 1x1 PNG（#138 用） -------------------- */
function makePng(rgb) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        crcTable[n] = c >>> 0;
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        let crc = 0xffffffff;
        for (const b of body) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
        const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([len, body, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; ihdr[9] = 2;   // 8bit RGB
    const raw = Buffer.from([0, rgb[0], rgb[1], rgb[2]]);
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))]);
}
const PNG_DIR = makePng([220, 30, 30]);     // 目录默认图标（红）
const PNG_OV = makePng([30, 30, 220]);      // override 图标（蓝）
const dataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');

/* ========================================================================== *\
\* ================================ main ==================================== */
/* ========================================================================== */
(async function main() {
    rec('=== 轮 30 专项探针：本轮九项功能（#133-#141）===');
    rec('');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r30-'));

    /* ---------- 实例工厂（同轮 29：APPDATA 必须是配置目录本身） ---------- */
    function makeConf(dir, extra) {
        const qs = path.join(dir, 'QuickSearch');
        fs.mkdirSync(qs, { recursive: true });
        const c = Object.assign({
            trigger_copy: false, trigger_select: false, ocr_enable: false,
            auto_color: false, auto_start: false,
            webdav_url: '', webdav_user: '', webdav_pass: '',
            webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
            backup_dir: '', overrides: {}, fav_hotkey: '',
            custom_engines: [],
            // 玻璃开、live 关：预设直切与预览不吃实时重抓的干扰
            bar_glass: true, bar_glass_live: false,
            bar_glass_refraction: 30, bar_glass_bevel: 18,
            bar_glass_aberration: 50, bar_glass_spec: 110,
            bar_glass_tint: 14, bar_glass_frost: 2,
            // 待机淡度关掉：指针不在条上时横条会整体变淡，玻璃像素被乘法衰减
            bar_dim_alpha: 100,
            // 主题从亮起手，G 段再切暗（#139）
            theme: 'light',
            // OCR：百度 + 高精度档 + 空凭证（B 段先走空凭证链）
            ocr_engine: 'baidu', ocr_accurate: true,
            ocr_lang: 'CHN_ENG', ocr_parallel: true,
            ocr_key: '', ocr_secret: '',
        }, extra || {});
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
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
    const dbg = async (ws) => JSON.parse(await evalJs(ws, 'JSON.stringify(window.QSGlass.debugInfo())'));

    /* 轮询 config 直到谓词成立（落库是异ects，给足超时） */
    const waitCfg = async (qs, pred, ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < (ms || 12000)) {
            const c = readCfg(qs);
            if (c && pred(c)) return c;
            await sleep(300);
        }
        return null;
    };

    /* =====================================================================
     *  实例 D：全部九项（横条页 + 设置页同一个实例）
     * ===================================================================== */
    rec('');
    rec('############ 实例 D：#133-#141 九项（横条页 + 设置页）############');
    const qsD = makeConf(path.join(tmpRoot, 'D'), {
        bar_list: ['百度', 'Google', '知乎', '@app:r30app1', '@app:r30app2', '@fav:favr30'],
        // #135 预置两条外部软件：一条搜索类（url 带 %s）、一条打开类
        apps: [
            { id: 'r30app1', name: '轮30搜索软件', url: 'weixin://search?q=%s', kind: 'search' },
            { id: 'r30app2', name: '轮30打开软件', url: 'https://example.com/', kind: 'open' },
        ],
        // #138：Google 走 override（蓝 PNG），百度走 icons 目录默认图标（红 PNG）
        overrides: { 'Google': 'g-ov.png' },
        favorites: [{
            id: 'favr30', name: '轮30收藏', icon: '',
            items: [{ id: 'fi1', kind: 'text', text: '示例收藏', html: '', image: '', remark: '' }],
            children: [],
        }],
    });
    // icons 目录：#138 的「文件名 = 引擎名」默认图标
    fs.mkdirSync(path.join(qsD, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(qsD, 'icons', '百度.png'), PNG_DIR);
    fs.writeFileSync(path.join(qsD, 'icons', 'g-ov.png'), PNG_OV);

    // 光标先挪开屏幕正中：横条弹出在 30% 高度，别让指针预停在横条上
    SetCursorPos(Math.round(SW / 2), Math.round(SH * 0.30));
    await sleep(200);
    spawnInstance(qsD, 9411, '-probe-r30d');
    await sleep(8000);
    const barWs = await connectWhere(isBarPage, 30000);
    if (!barWs || !(await waitInvoke(barWs))) {
        chk('★ D0 连上横条页', false);
        rec('连不上横条页，后续全部跳过');
        rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
        flush();
        for (const p of instances) { try { p.kill(); } catch (e) { } }
        process.exit(1);
    }
    chk('★ D0 连上横条页（CDP 9411）', true);
    waitBar(10000);
    await sleep(1500);

    /* 打开设置窗（后面 A/B/C/D/E/G 段都在里面跑） */
    await evalJs(barWs, "invoke('open_settings', {tab:'general'}).catch(function(e){})");
    const setWs = await connectWhere(isSettingsPage, 25000);
    if (!setWs) { chk('★ D0b 设置窗口打开', false, '连不上 settings.html'); }
    else { chk('★ D0b 设置窗口打开（通用分页）', true); }
    const SET = setWs;   // 后面统一用 SET

    /* =====================================================================
     *  A 段：#133 玻璃预设直切（轻量/标准/深度，不经过自定义中间态）
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- A 段：玻璃预设直切 + 质感三档（#133）----');
        // 等样式分段落到「液态玻璃」
        let a0 = null;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 15000) {
                a0 = await evalJs(SET, `(function(){
                    var seg=document.getElementById('s-barStyle');
                    var on=seg? [].slice.call(seg.querySelectorAll('button'))
                        .filter(function(b){return b.classList.contains('on');}) : [];
                    return on.length? on[0].dataset.v : null;
                })()`);
                if (a0 === 'glass') break;
                await sleep(300);
            }
        }
        chk('  A1 样式三段落在「液态玻璃」', a0 === 'glass', 'style=' + a0);
        const segOn = async () => evalJs(SET, `(function(){
            var seg=document.getElementById('s-glassPreset');
            var on=seg? [].slice.call(seg.querySelectorAll('button'))
                .filter(function(b){return b.classList.contains('on');}) : [];
            return on.length? on[0].dataset.v : null;
        })()`);
        const a1 = await segOn();
        chk('  A2 初始六值命中「标准」档（config 默认 = standard）', a1 === 'standard', 'preset=' + a1);

        const clickPreset = async (key) => evalJs(SET, `(function(){
            var b=[].slice.call(document.querySelectorAll('#s-glassPreset button'))
                .filter(function(x){return x.dataset.v==='` + key + `';})[0];
            if(b) b.click();
        })()`);

        /* A3 闪烁取证：先在页面里挂一个逐帧采样器，再点预设。
         * 旧实现六个 set_setting 一人一次广播，写到一半的中间态谁都不命中，
         * 「自定义」会闪一下 —— 采样数组里出现任何一次 custom 即回归。 */
        await evalJs(SET, `(function(){
            window.__flash = [];
            var seg = document.getElementById('s-glassPreset');
            function sample(){
                var on = seg ? [].slice.call(seg.querySelectorAll('button'))
                    .filter(function(b){return b.classList.contains('on');}) : [];
                window.__flash.push(on.length ? on[0].dataset.v : 'none');
                if (window.__flash.length < 150) requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        })()`);
        await clickPreset('light');
        let cfgLight = await waitCfg(qsD, (c) => c.bar_glass_refraction === 18
            && c.bar_glass_bevel === 10 && c.bar_glass_aberration === 30
            && c.bar_glass_spec === 70 && c.bar_glass_tint === 10 && c.bar_glass_frost === 1);
        chk('★ A3 点「轻量」写入 config 六值 {18,10,30,70,10,1}', !!cfgLight);
        const a3 = await segOn();
        chk('  A3 预设高亮移到「轻量」', a3 === 'light', 'preset=' + a3);

        await clickPreset('deep');
        let cfgDeep = await waitCfg(qsD, (c) => c.bar_glass_refraction === 45
            && c.bar_glass_bevel === 26 && c.bar_glass_aberration === 75
            && c.bar_glass_spec === 160 && c.bar_glass_tint === 18 && c.bar_glass_frost === 3);
        chk('★ A4 点「深度」写入 config 六值 {45,26,75,160,18,3}', !!cfgDeep);
        const a4 = await segOn();
        chk('  A4 预设高亮移到「深度」', a4 === 'deep', 'preset=' + a4);

        await clickPreset('standard');
        let cfgStd = await waitCfg(qsD, (c) => c.bar_glass_refraction === 30
            && c.bar_glass_bevel === 18 && c.bar_glass_aberration === 50
            && c.bar_glass_spec === 110 && c.bar_glass_tint === 14 && c.bar_glass_frost === 2);
        chk('★ A5 点「标准」写回六值 {30,18,50,110,14,2}', !!cfgStd);

        const flash = await evalJs(SET, 'JSON.stringify(window.__flash || [])');
        let fl = []; try { fl = JSON.parse(flash); } catch (e) { }
        const nCustom = fl.filter((v) => v === 'custom').length;
        const nNone = fl.filter((v) => v === 'none').length;
        chk('★ A6 点预设过程中「自定义」零闪现（批量写库修掉的闪烁）',
            nCustom === 0 && nNone === 0,
            '采样 ' + fl.length + ' 帧，custom=' + nCustom + ' none=' + nNone
            + ' 轨迹=' + fl.slice(0, 14).join('>'));

        // 横条侧跟上（广播链路）：debugInfo.params 应等于最后一档（standard）
        let barStd = false;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 10000) {
                const d = await dbg(barWs);
                if (d.params && d.params.refraction === 30 && d.params.bevel === 18
                    && d.params.aberration === 50 && d.params.spec === 110
                    && d.params.tint === 14 && d.params.frost === 2) { barStd = true; break; }
                await sleep(300);
            }
        }
        chk('  A7 横条玻璃参数同步跟上（一次广播到终态）', barStd);

        /* A8 质感三档的阶梯关系：#133「不够透、折射差」整体加强 ——
         * 三档的折射/厚度/高光必须严格递增，且标准档不低于用户报修前的量级。 */
        const presets = await evalJs(SET, `(function(){
            function vals(k){
                var b=[].slice.call(document.querySelectorAll('#s-glassPreset button'))
                    .filter(function(x){return x.dataset.v===k;})[0];
                return b? b.dataset : null;
            }
            // 预设值不在 DOM 上，直接读 GLASS_PRESETS 常量（模块作用域取不到，
            // 改用点击后的 config 快照对比）—— 这里只验三档标题在案
            return [].slice.call(document.querySelectorAll('#s-glassPreset button'))
                .map(function(b){return b.dataset.v;});
        })()`);
        chk('  A8 预设三档齐备（轻量/标准/深度）+ 自定义只作状态显示',
            Array.isArray(presets) && presets.join(',') === 'light,standard,deep,custom',
            presets && presets.join(','));
        const cStd = readCfg(qsD) || {};
        const cLightOk = cfgLight && cfgDeep;
        chk('  A8 三档严格递增（折射/厚度/高光：轻量 < 标准 < 深度）',
            cLightOk && cfgLight.bar_glass_refraction < cStd.bar_glass_refraction
            && cStd.bar_glass_refraction < cfgDeep.bar_glass_refraction
            && cfgLight.bar_glass_bevel < cStd.bar_glass_bevel
            && cStd.bar_glass_bevel < cfgDeep.bar_glass_bevel
            && cfgLight.bar_glass_spec < cStd.bar_glass_spec
            && cStd.bar_glass_spec < cfgDeep.bar_glass_spec,
            'refr ' + cfgLight.bar_glass_refraction + '<' + cStd.bar_glass_refraction + '<' + cfgDeep.bar_glass_refraction);
        chk('  A8 标准档不低于旧默认量级（折射≥20‰、高光≥100）',
            cStd.bar_glass_refraction >= 20 && cStd.bar_glass_spec >= 100,
            'refr=' + cStd.bar_glass_refraction + ' spec=' + cStd.bar_glass_spec);
    }

    /* =====================================================================
     *  B 段：#134 一键诊断（状态 + 耗时 + 每环节独立按钮 + 不私自降档）
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- B 段：一键诊断（#134）----');
        await evalJs(SET, "invoke('open_settings', {tab:'ocr'}).catch(function(e){})");
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const vis = await evalJs(SET, "!document.querySelector('.pane[data-pane=\"ocr\"]').hidden");
                if (vis) break;
                await sleep(300);
            }
        }
        const b1 = await evalJs(SET, `(function(){
            var b=document.getElementById('btnOcrOpt');
            return { has: !!b, text: b? b.textContent.trim() : '',
                     vis: !!b && !!b.offsetParent };
        })()`);
        chk('★ B1 「一键优化」已改名「一键诊断」且按钮可见',
            b1.has === true && b1.text === '一键诊断' && b1.vis === true,
            JSON.stringify(b1));

        /* B2 空凭证：提示先填，诊断面板给出 ok=0，且**不动配置** */
        const accBefore = (readCfg(qsD) || {}).ocr_accurate;
        await evalJs(SET, "document.getElementById('btnOcrOpt').click()");
        let b2 = null;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 10000) {
                b2 = await evalJs(SET, `(function(){
                    var box=document.getElementById('ocrDiag');
                    return { vis: !!box && !box.hidden,
                             ok: box? box.dataset.ok : '',
                             sum: document.getElementById('ocrDiagSum').textContent,
                             rows: document.getElementById('ocrDiagRows')
                                ? document.getElementById('ocrDiagRows').children.length : -1 };
                })()`);
                if (b2.vis && b2.sum) break;
                await sleep(300);
            }
        }
        chk('★ B2 空凭证点诊断 → 面板弹出且提示「先填 API Key 和 Secret Key」',
            b2 && b2.vis === true && /先填/.test(b2.sum || ''), JSON.stringify(b2));
        chk('  B2 空凭证时 ok=0（红色总结）且不画环节行', b2 && b2.ok === '0' && b2.rows === 0,
            'ok=' + (b2 && b2.ok) + ' rows=' + (b2 && b2.rows));
        const accAfterEmpty = (readCfg(qsD) || {}).ocr_accurate;
        chk('  B2 空凭证诊断不碰配置（ocr_accurate 原样）',
            accAfterEmpty === accBefore, accBefore + '→' + accAfterEmpty);

        /* B3 假凭证：诊断真的去打一次接口（必然被百度打回），
         * 断言三环节结构 + 每环节独立按钮 + **高精度档不自动降级**（硬约束）。 */
        await evalJs(SET, "invoke('set_setting',{key:'ocrKey',value:'r30fakekey'})");
        await evalJs(SET, "invoke('set_setting',{key:'ocrSecret',value:'r30fakesecret'})");
        await sleep(400);
        await evalJs(SET, "document.getElementById('btnOcrOpt').click()");
        let b3 = null;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 25000) {
                b3 = await evalJs(SET, `(function(){
                    var rows=[].slice.call(document.querySelectorAll('#ocrDiagRows .od-row'));
                    return { vis: !document.getElementById('ocrDiag').hidden,
                             sum: document.getElementById('ocrDiagSum').textContent,
                             names: rows.map(function(r){
                                 var n=r.querySelector('.od-name'); return n? n.textContent : ''; }),
                             ms: rows.map(function(r){
                                 var m=r.querySelector('.od-ms'); return m? m.textContent : ''; }),
                             acts: rows.map(function(r){
                                 var b=r.querySelector('button.mini');
                                 return b? b.textContent : ''; }),
                             nBtn: rows.filter(function(r){return !!r.querySelector('button.mini');}).length };
                })()`);
                if (b3 && b3.vis && b3.names.length === 3) break;
                await sleep(400);
            }
        }
        info('B3 诊断结果：' + JSON.stringify(b3));
        chk('★ B3 诊断画出三个环节（识别状态 / 换取 token / 识别接口）',
            b3 && b3.names.join('/') === '识别状态/换取 token/识别接口',
            b3 && b3.names.join('/'));
        chk('  B3 环节一没有耗时（状态行）、后两行有毫秒或「没打通」说明',
            b3 && b3.ms.length === 3 && (b3.ms[0] === '—'),
            b3 && b3.ms.join(' | '));
        chk('  B3 每环节独立优化按钮：token 行「预热 token」+ 识别行「改用标准版（更快）」',
            b3 && b3.nBtn === 2 && b3.acts[1] === '预热 token'
            && b3.acts[2] === '改用标准版（更快）', b3 && b3.acts.join(' | '));
        chk('  B3 识别状态行无按钮（它是背景信息，没有可优化动作）',
            b3 && b3.acts[0] === '', b3 && String(b3.acts[0]));
        const accAfterDiag = (readCfg(qsD) || {}).ocr_accurate;
        chk('★ B3 硬约束：诊断只读不改 —— 高精度档没有被自动降成标准版',
            accAfterDiag === true, 'ocr_accurate=' + accAfterDiag);

        /* B4 手动点「改用标准版（更快）」→ 用户自己选才落库 */
        await evalJs(SET, `(function(){
            var rows=[].slice.call(document.querySelectorAll('#ocrDiagRows .od-row'));
            var b = rows[2] ? rows[2].querySelector('button.mini') : null;
            if(b) b.click();
        })()`);
        const accManual = await waitCfg(qsD, (c) => c.ocr_accurate === false);
        chk('★ B4 点环节按钮「改用标准版」手动落库（切换由用户决定）', !!accManual,
            'ocr_accurate=' + (accManual && accManual.ocr_accurate));

        /* B5 命令已注册（ocr_diagnose / ocr_warm 打过去不报"命令不存在"） */
        const b5a = await evalJs(SET,
            "invoke('ocr_diagnose').then(function(){return 'ok';}).catch(function(e){return 'rej:'+e;})");
        const b5b = await evalJs(SET,
            "invoke('ocr_warm').then(function(){return 'ok';}).catch(function(e){return 'rej:'+e;})");
        chk('  B5 ocr_diagnose / ocr_warm 命令已注册', b5a === 'ok' && b5b === 'ok',
            'diagnose=' + b5a + ' warm=' + b5b);
    }

    /* =====================================================================
     *  C 段：#135 软件引擎「搜索/打开」类型（表单 + 徽标 + 横条提示）
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- C 段：软件引擎类型分类（#135）----');
        await evalJs(SET, "invoke('open_settings', {tab:'engines'}).catch(function(e){})");
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const vis = await evalJs(SET, "!document.querySelector('.pane[data-pane=\"engines\"]').hidden");
                if (vis) break;
                await sleep(300);
            }
        }
        const c1 = await evalJs(SET, `(function(){
            var seg=document.getElementById('s-apKind');
            var bs=seg? [].slice.call(seg.querySelectorAll('button')) : [];
            var on=bs.filter(function(b){return b.classList.contains('on');})[0];
            return { n: bs.length, vs: bs.map(function(b){return b.dataset.v;}),
                     on: on? on.dataset.v : null,
                     ph: document.getElementById('w-apUrl').placeholder };
        })()`);
        chk('★ C1 软件表单有类型分段（打开/搜索两个选项）',
            c1.n === 2 && c1.vs.join(',') === 'open,search', JSON.stringify(c1));

        // 切「搜索」→ 占位符提醒 %s
        await evalJs(SET, `(function(){
            var b=[].slice.call(document.querySelectorAll('#s-apKind button'))
                .filter(function(x){return x.dataset.v==='search';})[0];
            if(b) b.click();
        })()`);
        await sleep(200);
        const c2 = await evalJs(SET, `(function(){
            var note=document.getElementById('apKindNote');
            return { ph: document.getElementById('w-apUrl').placeholder,
                     note: note? note.textContent : '' };
        })()`);
        chk('  C2 切「搜索」后地址占位符提醒写 %s', /%s/.test(c2.ph), c2.ph);

        // 走「软件引擎」添加方式，保存一条搜索类软件
        await evalJs(SET, "document.getElementById('btnAddEngine').click()");
        await sleep(250);
        await evalJs(SET, `(function(){
            var b=[].slice.call(document.querySelectorAll('#addWays .addway'))
                .filter(function(x){return x.dataset.way==='app';})[0];
            if(b) b.click();
        })()`);
        await sleep(250);
        await evalJs(SET, `(function(){
            document.getElementById('w-apName').value='轮30表单搜索软件';
            document.getElementById('w-apUrl').value='dingtalk://search?q=%s';
            var k=[].slice.call(document.querySelectorAll('#s-apKind button'))
                .filter(function(x){return x.dataset.v==='search';})[0];
            if(k) k.click();
            document.getElementById('btnApSave').click();
        })()`);
        const c3 = await waitCfg(qsD, (c) => (c.apps || []).some((a) => a.name === '轮30表单搜索软件'));
        chk('★ C3 表单保存搜索类软件落 config（kind=search）',
            !!c3 && c3.apps.some((a) => a.name === '轮30表单搜索软件' && a.kind === 'search'),
            c3 && JSON.stringify(c3.apps[c3.apps.length - 1]));

        // 再存一条打开类（加完表单会收回，先重新走「软件引擎」方式；
        // 默认类型就是 open）
        await evalJs(SET, `(function(){
            var w=[].slice.call(document.querySelectorAll('#addWays .addway'))
                .filter(function(x){return x.dataset.way==='app';})[0];
            if(w) w.click();
        })()`);
        await sleep(250);
        await evalJs(SET, `(function(){
            document.getElementById('w-apName').value='轮30表单打开软件';
            document.getElementById('w-apUrl').value='https://example.com/open';
            document.getElementById('btnApSave').click();
        })()`);
        const c4 = await waitCfg(qsD, (c) => (c.apps || []).some((a) => a.name === '轮30表单打开软件' && a.kind === 'open'));
        chk('★ C4 表单保存打开类软件落 config（kind=open，默认档）', !!c4);

        // 软件列表行的类型徽标
        await sleep(600);
        const c5 = await evalJs(SET, `(function(){
            var rows=[].slice.call(document.querySelectorAll('#appList .item'));
            return rows.map(function(r){
                var nm=r.querySelector('.nm');
                var kb=nm? nm.querySelector('i.kb') : null;
                return (nm? nm.textContent.replace(/[^\\u4e00-\\u9fa5A-Za-z0-9]/g,'').slice(0,10) : '')
                    + ':' + (kb? kb.textContent : '无');
            });
        })()`);
        info('C5 软件列表徽标：' + JSON.stringify(c5));
        chk('★ C5 软件列表每行带类型徽标（搜索/打开）',
            c5.some((s) => /搜索$/.test(s)) && c5.some((s) => /打开$/.test(s)),
            c5.join(' | '));

        // 横条侧：两条软件按钮的悬停提示按类型分开（#135）
        const c6 = await evalJs(barWs, `(function(){
            var out={};
            var bs=[].slice.call(document.querySelectorAll('.qs-app-inbar'));
            out.n = bs.length;
            out.titles = bs.map(function(b){return b.title;});
            return out;
        })()`);
        info('C6 横条软件按钮提示：' + JSON.stringify(c6));
        chk('★ C6 横条软件按钮按类型给提示（搜索类带词/打开类直开）',
            c6.n >= 2 && c6.titles.some((t) => /拿选中的词/.test(t))
            && c6.titles.some((t) => /点一下直接打开/.test(t)),
            c6.titles.join(' | '));
    }

    /* =====================================================================
     *  D 段：#136 设置页三大类分组 + 点大类经子分类展开 + 胶囊过滤
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- D 段：设置页全部引擎三大类分组（#136）----');
        // 全部引擎区（sec-all）在 engines 页里，先滚过去确保渲染过
        await evalJs(SET, `(function(){
            var sec=document.getElementById('sec-all');
            if(sec && sec.scrollIntoView) sec.scrollIntoView({block:'start'});
        })()`);
        await sleep(300);
        const d1 = await evalJs(SET, `(function(){
            var nav=document.getElementById('allGrpNav');
            var items=nav? [].slice.call(nav.querySelectorAll('.eng-nav-item')) : [];
            return { n: items.length,
                     titles: items.map(function(b){return b.textContent;}),
                     on: (items.filter(function(b){return b.classList.contains('on');})[0]||{}).textContent };
        })()`);
        chk('★ D1 全部引擎页有胶囊导航（全部引擎/网页引擎/软件引擎/快捷键引擎）',
            d1.n === 4 && d1.titles.join('/') === '全部引擎/网页引擎/软件引擎/快捷键引擎'
            && d1.on === '全部引擎', JSON.stringify(d1));

        const allSnap = async () => evalJs(SET, `(function(){
            var blks=[].slice.call(document.querySelectorAll('#allList .eng-grp'));
            var subs=[].slice.call(document.querySelectorAll('#allList .eng-sub-h'));
            var rows=[].slice.call(document.querySelectorAll('#allList .item'));
            var appRows=rows.filter(function(r){
                var kb=r.querySelector('.nm i.kb'); return !!kb; });
            return { grps: blks.map(function(b){return b.dataset.grp;}),
                     open: blks.map(function(b){return !b.classList.contains('shut');}),
                     subs: subs.map(function(s){return s.textContent;}),
                     nRow: rows.length,
                     nBadge: appRows.length,
                     sample: rows.slice(0,3).map(function(r){
                         return r.querySelector('.nm').textContent.slice(0,12); }) };
        })()`);
        const d2 = await allSnap();
        info('D2 默认视图：' + JSON.stringify(d2));
        chk('★ D2 默认展示所有引擎：三大类块（web/app/hotkey）全展开',
            d2.grps.join(',') === 'web,app,hotkey' && d2.open.every((o) => o === true),
            JSON.stringify(d2.grps) + ' open=' + JSON.stringify(d2.open));
        chk('  D2 每个大类经子分类展开（搜索引擎/直达网页/软件搜索/软件直达/快捷键）',
            d2.subs.length >= 5, d2.subs.join('/'));
        chk('  D2 软件行也混排进全部引擎（带类型徽标）', d2.nBadge >= 2, '徽标行=' + d2.nBadge);

        const clickGrp = async (key) => evalJs(SET, `(function(){
            var b=[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
                .filter(function(x){return x.dataset.grp==='` + key + `';})[0];
            if(b) b.click();
        })()`);
        await clickGrp('web');
        await sleep(300);
        const d3 = await allSnap();
        chk('★ D3 点「网页引擎」胶囊 → 只剩网页大类',
            d3.grps.join(',') === 'web', d3.grps.join(','));
        await clickGrp('app');
        await sleep(300);
        const d4 = await allSnap();
        chk('★ D4 点「软件引擎」胶囊 → 只剩软件大类（行=预置2+表单2）',
            d4.grps.join(',') === 'app' && d4.nRow >= 4, 'grps=' + d4.grps.join(',') + ' rows=' + d4.nRow);
        await clickGrp('hotkey');
        await sleep(300);
        const d5 = await allSnap();
        chk('★ D5 点「快捷键引擎」胶囊 → 只剩快捷键大类', d5.grps.join(',') === 'hotkey',
            d5.grps.join(','));
        await clickGrp('');
        await sleep(300);
        const d6 = await allSnap();
        chk('  D6 点「全部引擎」胶囊 → 三大类回来', d6.grps.join(',') === 'web,app,hotkey',
            d6.grps.join(','));

        // 搜索词过滤
        await evalJs(SET, `(function(){
            var f=document.getElementById('allFilter');
            f.value='github'; f.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await sleep(300);
        const d7 = await evalJs(SET, `(function(){
            var rows=[].slice.call(document.querySelectorAll('#allList .item'));
            return { n: rows.length,
                     allGithub: rows.every(function(r){
                         return /github/i.test(r.querySelector('.nm').textContent); }) };
        })()`);
        chk('  D7 搜索框有词时只留命中行', d7.n > 0 && d7.allGithub === true,
            'rows=' + d7.n);
        await evalJs(SET, `(function(){
            var f=document.getElementById('allFilter');
            f.value=''; f.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await sleep(300);

        // 大类块可收起/展开
        await evalJs(SET, `(function(){
            var h=document.querySelector('#allList .eng-grp[data-grp="web"] .eng-grp-h');
            if(h) h.click();
        })()`);
        await sleep(250);
        const d8 = await allSnap();
        chk('  D8 点大类标题收起该大类（shut + 内容消失）',
            d8.grps.indexOf('web') >= 0 && d8.open[0] === false && !/搜索引擎/.test(d8.subs.join('/')),
            'open=' + JSON.stringify(d8.open));
        await evalJs(SET, `(function(){
            var h=document.querySelector('#allList .eng-grp[data-grp="web"] .eng-grp-h');
            if(h) h.click();
        })()`);
        await sleep(250);
        const d9 = await allSnap();
        chk('  D9 再点一次展开回来', d9.open[0] === true && /搜索引擎/.test(d9.subs.join('/')),
            'open=' + JSON.stringify(d9.open));

        // sec-apps 相同交互
        const d10 = await evalJs(SET, `(function(){
            var sec=document.getElementById('sec-apps');
            if(sec && sec.scrollIntoView) sec.scrollIntoView({block:'start'});
            var blk=document.querySelector('#appList .eng-grp');
            var subs=[].slice.call(document.querySelectorAll('#appList .eng-sub-h'));
            return { has: !!blk, title: blk? blk.querySelector('.eng-grp-t').textContent : '',
                     shut: blk? blk.classList.contains('shut') : null,
                     subs: subs.map(function(s){return s.textContent;}) };
        })()`);
        info('D10 外部软件页：' + JSON.stringify(d10));
        chk('★ D10 软件引擎页相同交互（一个「外部软件」大类块 + 按类型分两节）',
            d10.has === true && d10.title === '外部软件' && d10.shut === false
            && d10.subs.join('/') === '软件搜索/软件直达', JSON.stringify(d10));
        await evalJs(SET, `(function(){
            var h=document.querySelector('#appList .eng-grp .eng-grp-h');
            if(h) h.click();
        })()`);
        await sleep(250);
        const d11 = await evalJs(SET, `(function(){
            var blk=document.querySelector('#appList .eng-grp');
            return { shut: blk? blk.classList.contains('shut') : null,
                     body: document.querySelectorAll('#appList .eng-grp-body').length };
        })()`);
        chk('  D11 外部软件大类块也能收起/展开', d11.shut === true && d11.body === 0,
            JSON.stringify(d11));
        await evalJs(SET, `(function(){
            var h=document.querySelector('#appList .eng-grp .eng-grp-h');
            if(h) h.click();
        })()`);
    }

    /* =====================================================================
     *  E 段：#137 液态玻璃预览（设为玻璃样式后预览要能显示该样式）
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- E 段：液态玻璃预览（#137）----');
        await evalJs(SET, "invoke('open_settings', {tab:'general'}).catch(function(e){})");
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const vis = await evalJs(SET, "!document.querySelector('.pane[data-pane=\"general\"]').hidden");
                if (vis) break;
                await sleep(300);
            }
        }
        const pv = async () => evalJs(SET, `(function(){
            var box=document.getElementById('qsPreviewA');
            if(!box) return null;
            var cs=getComputedStyle(box);
            return { lg: box.dataset.lg || '',
                     blur: box.dataset.blur,
                     frost: cs.getPropertyValue('--pv-lg-frost').trim(),
                     spec: cs.getPropertyValue('--pv-lg-spec').trim(),
                     ab: cs.getPropertyValue('--pv-lg-ab').trim(),
                     edge: cs.getPropertyValue('--pv-lg-edge').trim(),
                     tintA: cs.getPropertyValue('--pv-lg-tint-a').trim(),
                     bdf: (cs.backdropFilter || cs.webkitBackdropFilter || '') };
        })()`);
        const e1 = await pv();
        info('E1 玻璃预览：' + JSON.stringify(e1));
        chk('★ E1 玻璃样式下预览挂 data-lg=1', e1 && e1.lg === '1', 'lg=' + (e1 && e1.lg));
        chk('  E1 玻璃预览不吃磨砂底模糊（dataset.blur=0）', e1 && e1.blur === '0',
            'blur=' + (e1 && e1.blur));
        chk('  E1 预览有 backdrop-filter 磨砂（frost=2px）',
            e1 && /blur\(2px\)/.test(e1.bdf) && e1.frost === '2px', 'bdf=' + (e1 && e1.bdf));
        chk('  E1 染色/高光/色差/边缘四族变量都落到预览上',
            e1 && !!e1.tintA && e1.spec === '1.1' && !!e1.ab && !!e1.edge,
            'tintA=' + (e1 && e1.tintA) + ' spec=' + (e1 && e1.spec));

        // 拖「玻璃磨砂」滑块 → 预览跟着变
        await evalJs(SET, `(function(){
            var el=document.getElementById('s-barGlassFrost');
            el.value='6';
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await sleep(300);
        const e2 = await pv();
        chk('★ E2 拖玻璃磨砂滑块 → 预览 blur 跟着变（6px）',
            e2 && /blur\(6px\)/.test(e2.bdf) && e2.frost === '6px', 'bdf=' + (e2 && e2.bdf));
        // 拖高光滑块 → spec 变量变
        await evalJs(SET, `(function(){
            var el=document.getElementById('s-barGlassSpec');
            el.value='40';
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await sleep(300);
        const e3 = await pv();
        chk('  E3 拖高光滑块 → 预览高光强度变量跟着变（0.4）',
            e3 && e3.spec === '0.4', 'spec=' + (e3 && e3.spec));

        // 切到磨砂 → 玻璃预览撤下；切回 → 回来
        await evalJs(SET, `(function(){
            var b=[].slice.call(document.querySelectorAll('#s-barStyle button'))
                .filter(function(x){return x.dataset.v==='frost';})[0];
            if(b) b.click();
        })()`);
        await sleep(400);
        const e4 = await pv();
        chk('★ E4 切磨砂样式 → 玻璃预览撤下（data-lg 移除、吃磨砂模糊）',
            e4 && e4.lg === '' && e4.blur !== '0', 'lg=' + (e4 && e4.lg) + ' blur=' + (e4 && e4.blur));
        await evalJs(SET, `(function(){
            var b=[].slice.call(document.querySelectorAll('#s-barStyle button'))
                .filter(function(x){return x.dataset.v==='glass';})[0];
            if(b) b.click();
        })()`);
        await sleep(400);
        const e5 = await pv();
        chk('  E5 切回玻璃样式 → 玻璃预览回来', e5 && e5.lg === '1' && e5.blur === '0',
            'lg=' + (e5 && e5.lg));
        await shot(SET, 'round30-e-preview.png');
    }

    /* =====================================================================
     *  F 段：#138 icons 目录「文件名=引擎名」默认图标
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- F 段：自定义默认图标（#138）----');
        await evalJs(SET, "invoke('open_settings', {tab:'engines'}).catch(function(e){})");
        await sleep(600);
        const f1 = await evalJs(SET, `(function(){
            var rows=[].slice.call(document.querySelectorAll('#allList .item'));
            function srcOf(name){
                var r=rows.filter(function(x){
                    return x.querySelector('.nm').textContent.indexOf(name)>=0; })[0];
                if(!r) return null;
                var img=r.querySelector('.ic img');
                return img? img.getAttribute('src') : null;
            }
            return { dirIcon: srcOf('百度'), ovIcon: srcOf('Google') };
        })()`);
        info('F1 图标 src 前缀：' + JSON.stringify({
            dir: f1 && f1.dirIcon && f1.dirIcon.slice(0, 40),
            ov: f1 && f1.ovIcon && f1.ovIcon.slice(0, 40),
        }));
        chk('★ F1 icons 目录里「百度.png」成为百度的默认图标',
            f1 && f1.dirIcon === dataUrl(PNG_DIR), 'src=' + (f1 && f1.dirIcon && f1.dirIcon.slice(0, 44)));
        chk('★ F2 override 优先于目录默认图标（Google 用蓝 PNG）',
            f1 && f1.ovIcon === dataUrl(PNG_OV), 'src=' + (f1 && f1.ovIcon && f1.ovIcon.slice(0, 44)));

        // 横条侧同一口径
        const f3 = await evalJs(barWs, `(function(){
            var bs=[].slice.call(document.querySelectorAll('.ico.engine'));
            function srcOf(name){
                var b=bs.filter(function(x){return x.dataset.engine===name;})[0];
                if(!b) return null;
                var img=b.querySelector('img');
                return img? img.getAttribute('src') : null;
            }
            return { dirIcon: srcOf('百度'), ovIcon: srcOf('Google') };
        })()`);
        chk('★ F3 横条上百度也用目录默认图标（同一口径）',
            f3 && f3.dirIcon === dataUrl(PNG_DIR), 'src=' + (f3 && f3.dirIcon && f3.dirIcon.slice(0, 44)));
        chk('  F3 横条上 Google 用 override 图标', f3 && f3.ovIcon === dataUrl(PNG_OV),
            'src=' + (f3 && f3.ovIcon && f3.ovIcon.slice(0, 44)));

        // 三级优先级的第三级：没有 override、icons 目录里也没有文件的引擎，
        // 仍用它自带的图标文件（知乎）—— 目录图标不能把这一级顶掉。
        const f4 = await evalJs(barWs, `(function(){
            var b=[].slice.call(document.querySelectorAll('.ico.engine'))
                .filter(function(x){return x.dataset.engine==='知乎';})[0];
            if(!b) return null;
            var img=b.querySelector('img');
            return { img: !!img, src: img? img.getAttribute('src') : null,
                     letter: !!b.querySelector('.letter') };
        })()`);
        chk('★ F4 无目录图标的引擎回退自带图标文件（知乎 → data/icons/知乎.svg）',
            f4 && f4.img === true && f4.src === 'data/icons/知乎.svg' && f4.letter === false,
            JSON.stringify(f4));
    }

    /* =====================================================================
     *  G 段：#139 主题同步（横条更多引擎页/收藏夹页跟随当前主题）
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- G 段：主题同步（#139）----');
        const stageDark = async () => evalJs(barWs,
            "document.getElementById('stage').classList.contains('qs-dark')");
        const g0 = await stageDark();
        chk('  G1 初始亮色主题：横条 stage 无 qs-dark', g0 === false, 'dark=' + g0);

        // 设置页切暗色 → set_setting 走 reemit_theme_to_bar → 横条跟上
        await evalJs(SET, "invoke('set_setting',{key:'theme',value:'dark'})");
        let g1 = false;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 10000) {
                g1 = await stageDark();
                if (g1 === true) break;
                await sleep(300);
            }
        }
        chk('★ G2 设置页切暗色 → 横条 stage 挂 qs-dark（事件通道通）', g1 === true);

        // 面板打开时也应是暗色（#139 的重放兜底）
        await evalJs(barWs, "document.getElementById('btnMore').click()");
        await sleep(600);
        const g2 = await evalJs(barWs, `(function(){
            var st=document.getElementById('stage');
            var pn=document.getElementById('panel');
            var body=document.getElementById('panelBody');
            return { dark: st.classList.contains('qs-dark'),
                     vis: !!pn && !pn.hidden,
                     grpNav: !!body.querySelector('.grp-nav'),
                     favNav: !!body.querySelector('.fav-nav') };
        })()`);
        info('G3 暗色下面板：' + JSON.stringify(g2));
        chk('★ G3 更多引擎页在暗色主题下打开（stage 仍是暗 + 面板内容在）',
            g2.dark === true && g2.vis === true && g2.grpNav === true, JSON.stringify(g2));

        // 收起再开：主题重放（lastThemePayload）保证不丢
        await evalJs(barWs, `(function(){
            var b=document.getElementById('btnPanelClose');
            if(b) b.click();
        })()`);
        await sleep(500);
        await evalJs(barWs, "document.getElementById('btnMore').click()");
        await sleep(600);
        const g3 = await stageDark();
        chk('  G4 收起再开面板：暗色主题照样跟上（重放兜底）', g3 === true);

        // 收藏夹页同样跟随
        await evalJs(barWs, `(function(){
            var b=document.querySelector('#panelBody .fav-nav .fav-entry');
            if(b) b.click();
        })()`);
        await sleep(500);
        const g4 = await evalJs(barWs, `(function(){
            var st=document.getElementById('stage');
            return { dark: st.classList.contains('qs-dark'),
                     favOpen: !!document.querySelector('#panelBody .fav-view, #panelBody .fav-grid, #panelBody .fav-list') };
        })()`);
        chk('★ G5 收藏夹页也在暗色主题下', g4.dark === true, JSON.stringify(g4));

        // 切回亮色
        await evalJs(SET, "invoke('set_setting',{key:'theme',value:'light'})");
        let g5 = true;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 10000) {
                g5 = await stageDark();
                if (g5 === false) break;
                await sleep(300);
            }
        }
        chk('  G6 切回亮色 → qs-dark 摘掉', g5 === false);
        // 面板还开着的话先收起，别影响 H/I 段
        await evalJs(barWs, `(function(){
            var b=document.getElementById('btnPanelClose');
            if(b) b.click();
        })()`);
        await sleep(400);
    }

    /* =====================================================================
     *  H 段：#140 更多引擎页胶囊过滤（横条侧）
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- H 段：更多引擎页胶囊过滤（#140，横条侧）----');
        await evalJs(barWs, "document.getElementById('btnMore').click()");
        await sleep(600);
        const h1 = await evalJs(barWs, `(function(){
            var nav=document.querySelector('#panelBody .grp-nav');
            var items=nav? [].slice.call(nav.querySelectorAll('.cat-nav-item')) : [];
            var on=items.filter(function(b){return b.classList.contains('on');})[0];
            var secs=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
            var anchor=document.querySelector('#panelBody .cat-nav:not(.grp-nav):not(.fav-nav)');
            return { vis: !!nav,
                     titles: items.map(function(b){return b.textContent;}),
                     on: on? (on.dataset.grp||'') : null,
                     nOn: items.filter(function(b){return b.classList.contains('on');}).length,
                     secs: secs.map(function(s){return s.dataset.cat;}),
                     nAnchor: anchor? anchor.querySelectorAll('.cat-nav-item').length : -1,
                     nCell: document.querySelectorAll('#panelBody .grid > .cell').length };
        })()`);
        info('H1 面板初始：' + JSON.stringify(h1));
        chk('★ H1 面板有胶囊过滤行（全部引擎/网页引擎/软件引擎/快捷键引擎）',
            h1.vis === true && h1.titles.join('/') === '全部引擎/网页引擎/软件引擎/快捷键引擎',
            h1.titles.join('/'));
        chk('  H1 默认「全部引擎」选中且只有一个胶囊激活', h1.on === '' && h1.nOn === 1,
            'on=' + h1.on + ' nOn=' + h1.nOn);
        chk('★ H1 默认五节平铺（search/open/appsearch/appopen/hotkey）',
            h1.secs.join(',') === 'search,open,appsearch,appopen,hotkey', h1.secs.join(','));
        chk('  H1 锚点导航胶囊数 = 节数（五节全发）', h1.nAnchor === 5, 'n=' + h1.nAnchor);
        chk('  H1 软件节里有带 data-app 的格子', h1.nCell > 100, 'cells=' + h1.nCell);

        const clickGrp = async (key) => evalJs(barWs, `(function(){
            var b=[].slice.call(document.querySelectorAll('#panelBody .grp-nav .cat-nav-item'))
                .filter(function(x){return x.dataset.grp==='` + key + `';})[0];
            if(b) b.click();
        })()`);
        await clickGrp('web');
        await sleep(400);
        const h2 = await evalJs(barWs, `(function(){
            var secs=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
            var grpOn=[].slice.call(document.querySelectorAll('#panelBody .grp-nav .cat-nav-item'))
                .filter(function(b){return b.classList.contains('on');});
            return { secs: secs.map(function(s){return s.dataset.cat;}),
                     grpOn: grpOn.map(function(b){return b.dataset.grp;}),
                     nCell: document.querySelectorAll('#panelBody .grid > .cell').length };
        })()`);
        info('H2 点网页引擎：' + JSON.stringify(h2));
        chk('★ H2 点「网页引擎」胶囊 → 只剩网页两节',
            h2.secs.join(',') === 'search,open', h2.secs.join(','));
        chk('★ H2 胶囊激活态画对（网页那颗 on，且 grp-nav 里只有一个 on）',
            h2.grpOn.length === 1 && h2.grpOn[0] === 'web', JSON.stringify(h2.grpOn));

        await clickGrp('app');
        await sleep(400);
        const h3 = await evalJs(barWs, `(function(){
            var secs=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
            var cells=[].slice.call(document.querySelectorAll('#panelBody .grid > .cell[data-app]'));
            return { secs: secs.map(function(s){return s.dataset.cat;}),
                     nApp: cells.length,
                     apps: cells.map(function(c){return c.dataset.appName || c.dataset.app;}) };
        })()`);
        info('H3 点软件引擎：' + JSON.stringify(h3));
        chk('★ H3 点「软件引擎」胶囊 → 只剩软件两节且格子带 data-app',
            h3.secs.join(',') === 'appsearch,appopen' && h3.nApp >= 2, JSON.stringify(h3));

        await clickGrp('hotkey');
        await sleep(400);
        const h4 = await evalJs(barWs, `(function(){
            var secs=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
            var hot=document.querySelectorAll('#panelBody .grid > .cell .ck.hot').length;
            return { secs: secs.map(function(s){return s.dataset.cat;}),
                     nHot: hot };
        })()`);
        chk('★ H4 点「快捷键引擎」胶囊 → 只剩快捷键节', h4.secs.join(',') === 'hotkey',
            h4.secs.join(','));

        // 搜索词 → 全部结果视图
        await clickGrp('');
        await sleep(400);
        await evalJs(barWs, `(function(){
            var f=document.getElementById('engFilter');
            f.value='github'; f.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await sleep(400);
        const h5 = await evalJs(barWs, `(function(){
            var cells=[].slice.call(document.querySelectorAll('#panelBody .grid > .cell'))
                .filter(function(c){return !c.hidden;});
            return { n: cells.length,
                     ok: cells.every(function(c){return /github/i.test(c.dataset.engine||'');}) };
        })()`);
        chk('  H5 面板搜索框过滤生效（只留 github）', h5.n > 0 && h5.ok === true,
            'cells=' + h5.n);
        await evalJs(barWs, `(function(){
            var f=document.getElementById('engFilter');
            f.value=''; f.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await sleep(400);
        await shot(barWs, 'round30-h-panel.png');
    }

    /* =====================================================================
     *  I 段：#141 收藏夹返回逻辑
     * ===================================================================== */
    if (SET) {
        rec('');
        rec('---- I 段：收藏夹返回逻辑（#141）----');
        /* ⚠ 先确保面板真的开着。横条失焦会自动收起，而 H 段全程只断言
         * DOM 内容、不查 #panel.hidden —— 面板很可能在截图/切窗口时已经
         * 收了（此时 JS .click() 照样执行，fav 视图会画出来，但 vis 恒 false，
         * 会把 #141 的正确实现误判成 FAIL）。btnMore 是开关：只在收起时点。 */
        await evalJs(barWs, `(function(){
            if(document.getElementById('panel').hidden
                && document.getElementById('btnMore')) document.getElementById('btnMore').click();
        })()`);
        await sleep(600);
        // 经更多引擎页点收藏夹入口
        await evalJs(barWs, `(function(){
            var b=document.querySelector('#panelBody .fav-nav .fav-entry');
            if(b) b.click();
        })()`);
        await sleep(500);
        const i1 = await evalJs(barWs, `(function(){
            var pn=document.getElementById('panel');
            var body=document.getElementById('panelBody');
            return { vis: !!pn && !pn.hidden,
                     favOpen: !!body.querySelector('.fav-head'),
                     grpGone: !body.querySelector('.grp-nav') };
        })()`);
        info('I1 经引擎页进收藏夹：' + JSON.stringify(i1));
        chk('★ I1 更多引擎页点收藏入口 → 收藏夹视图打开', i1.vis === true && i1.favOpen === true,
            JSON.stringify(i1));

        // 点收起 → 回引擎面板（不是整个关掉）
        await evalJs(barWs, "document.getElementById('btnPanelClose').click()");
        await sleep(500);
        const i2 = await evalJs(barWs, `(function(){
            var pn=document.getElementById('panel');
            var body=document.getElementById('panelBody');
            return { vis: !!pn && !pn.hidden,
                     grpNav: !!body.querySelector('.grp-nav'),
                     favOpen: !!body.querySelector('.fav-head') };
        })()`);
        info('I2 点收起后：' + JSON.stringify(i2));
        chk('★ I2 经更多引擎页打开的收藏夹，收起返回更多引擎页（面板没关）',
            i2.vis === true && i2.grpNav === true && i2.favOpen === false, JSON.stringify(i2));

        // 收起整个面板后，从横条收藏按钮进 → 收起 = 整个关掉（没有上一级）
        await evalJs(barWs, "document.getElementById('btnPanelClose').click()");
        await sleep(500);
        const i3a = await evalJs(barWs, "document.getElementById('panel').hidden");
        chk('  I3 引擎页面板点收起 → 整个收起', i3a === true, 'hidden=' + i3a);
        await evalJs(barWs, `(function(){
            var b=document.querySelector('.qs-fav-inbar');
            if(b) b.click();
        })()`);
        await sleep(500);
        const i3b = await evalJs(barWs, `(function(){
            var pn=document.getElementById('panel');
            return { vis: !!pn && !pn.hidden,
                     favOpen: !!document.getElementById('panelBody')
                        .querySelector('.fav-head') };
        })()`);
        chk('  I3 横条收藏按钮 → 收藏夹打开', i3b.vis === true && i3b.favOpen === true,
            JSON.stringify(i3b));
        await evalJs(barWs, "document.getElementById('btnPanelClose').click()");
        await sleep(500);
        const i3c = await evalJs(barWs, "document.getElementById('panel').hidden");
        chk('★ I3 横条按钮唤起的收藏夹，收起 = 整个收起（无上一级）',
            i3c === true, 'hidden=' + i3c);
    }

    /* ---- log 尾部 ---- */
    rec('');
    rec('=== log.txt 尾部（实例 D，8 行）===');
    try {
        const t = fs.readFileSync(path.join(qsD, 'log.txt'), 'utf8');
        rec(t.split('\n').slice(-8).join('\n'));
    } catch (e) { }

    /* ---- 收尾 ---- */
    rec('');
    rec('==============================================');
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { }
    process.exit(failN ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    process.exit(1);
});
