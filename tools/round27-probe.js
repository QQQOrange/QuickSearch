/* ============================================================================
 *  轮 27 专项探针：横条「悬停淡度」+ 两类 URL（搜 / 开）
 *
 *  用户原话（轮 27）：
 *    「横条出现后初始为高透明度（数值需可在设置中自定义调节），当鼠标悬停时
 *      以平滑过渡变为完全不透明。」
 *    「明确区分两类 URL：一类跳转到目标软件并触发搜索，另一类直接打开目标
 *      软件指定页面……在配置结构、界面展示及调用逻辑上清晰区分。」
 *
 *  取证方式（全部客观、可复现；全程不真的打开任何网页 / 程序）：
 *    A 待机淡度：弹出即淡（opacity≈.45）→ 鼠标进横条→全不透明 → 离开→又淡
 *      → 面板开着时不淡 → 面板收起恢复淡。计算样式 + classList 双通道取证。
 *    B 自定义 + 持久化：设置页滑块拖到 100 → --qs-dim-alpha=1.00；重启后仍在，
 *      且不悬停时 opacity 就是 1（整套行为等于关掉）。
 *    C 两类 URL：面板里「搜 / 开」角标；横条 tooltip 区分；
 *      点打开类（自定义 file:// 不存在路径）→ log.txt 记 kind=open 直达地址；
 *      点搜索类（自定义 file:// 不存在路径 + %s、带选中词）→ log.txt 记
 *      kind=search 且 %s 被替换成 URL 编码后的词。file:// 不存在路径的
 *      ShellExecuteW 直接返错、不弹任何东西，所以「点了真的走到 Rust」可证，
 *      而桌面上零副作用。
 *
 *  全程隔离：临时 APPDATA + 独立 WebView2 数据目录 + QS_INSTANCE_TAG，
 *  不碰真实环境。用法：node tools/round27-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round27-probe.txt');
const TAG = '-probe-r27';

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const SendInput = user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetCursorPos = user32.func('int GetCursorPos(_Out_ POINT *p)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ------------------------------ 输入 ------------------------------ */
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
const MOVE = 0x0001, ABS = 0x8000, LDOWN = 0x0002, LUP = 0x0004;
function moveTo(x, y) { return mouse(MOVE | ABS, x, y); }
function clickAt(x, y) {
    moveTo(x, y); sleep(60);
    mouse(LDOWN, x, y); sleep(40); mouse(LUP, x, y); sleep(80);
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
const VK_CONTROL = 0x11, VK_A = 0x41, VK_C = 0x43, VK_ESCAPE = 0x1B;
const KEYEVENTF_UNICODE = 0x0004;
function typeAscii(s) {
    for (const ch of s) {
        const code = ch.charCodeAt(0);
        const b = Buffer.alloc(40);
        b.writeUInt32LE(1, 0);
        b.writeUInt16LE(0, 8);            // wVk = 0（unicode 直投）
        b.writeUInt16LE(code, 10);        // wScan = 字符码
        b.writeUInt32LE(KEYEVENTF_UNICODE, 12);
        b.writeUInt32LE(0, 16);
        b.writeBigUInt64LE(0n, 24);
        SendInput(1, b, 40); sleep(12);
        b.writeUInt32LE(KEYEVENTF_UNICODE | 0x0002, 12);   // up
        SendInput(1, b, 40); sleep(12);
    }
}
function ctrl(vk) {
    kb(VK_CONTROL, false); sleep(50); kb(vk, false); sleep(90);
    kb(vk, true); sleep(50); kb(VK_CONTROL, true); sleep(80);
}
const ctrlC = () => ctrl(VK_C);
const ctrlA = () => ctrl(VK_A);
const esc = () => { kb(VK_ESCAPE, false); sleep(50); kb(VK_ESCAPE, true); };

/* ------------------------------ 窗口 ------------------------------ */
const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function wins() {
    const out = [];
    const cb = koffi.register((h) => {
        const t = wtext(h);
        if (t) {
            const r = {}; GetWindowRect(h, r);
            out.push({ hwnd: h, title: t, vis: !!IsWindowVisible(h),
                       rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] });
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const winCount = () => wins().filter((w) => w.title).length;
const barRect = () => { const w = wins().find((x) => x.title === 'QuickSearchBar'); return w ? w.rect : null; };
function waitBar(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) { const r = barRect(); if (r && r[2] > 0) return r; sleep(120); }
    return null;
}
function waitGone(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (!barRect()) return true; sleep(120); }
    return false;
}
const fmt = (r) => r ? `x=${r[0]} y=${r[1]} w=${r[2]} h=${r[3]}` : 'NONE';

/* ------------------------------ CDP ------------------------------ */
let PORT = 9377;
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

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

/* ============================================================================
 *  主流程
 * ========================================================================== */
(async function main() {
    rec('=== 轮 27 专项探针：横条悬停淡度 + 两类 URL（搜 / 开） ===');
    rec('');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r27-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    rec('隔离实例数据目录：' + qs);

    /* ---------- 临时配置：干净起步 + 两颗测试引擎（打开类 / 搜索类） ----------
     * file:// 指向**本机不存在**的路径：点了必然打开失败（ShellExecuteW 直接
     * 返 SE_ERR_FNOFOUND，不弹任何对话框），但 Rust 侧的分流日志照样落盘 ——
     * 「点了真的走到那类分支」可证，桌面零副作用。 */
    {
        const c = {
            trigger_copy: true, trigger_select: false,
            bar_list: ['QS27打开类', 'QS27搜索类', '百度'],
            custom_engines: [
                { name: 'QS27打开类', url: 'file:///C:/qs27-none/', category: '工具', kind: 'open' },
                { name: 'QS27搜索类', url: 'file:///C:/qs27-none/%s', category: '工具', kind: 'search' },
            ],
            webdav_url: '', webdav_user: '', webdav_pass: '',
            webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
            backup_dir: '', apps: [], overrides: {},
            auto_color: false, fav_hotkey: '',
        };
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const cfgPath = path.join(qs, 'config.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const readLog = () => { try { return fs.readFileSync(path.join(qs, 'log.txt'), 'utf8'); } catch (e) { return ''; } };

    const spawns = [];
    function spawnInstance() {
        PORT = 9377 + Math.floor(Math.random() * 30);
        const env = Object.assign({}, process.env, {
            APPDATA: tmp, LOCALAPPDATA: tmp,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
            QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
            QS_INSTANCE_TAG: TAG + '-' + PORT,
            QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
                + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT,
        });
        const p = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
        spawns.push(p);
        rec('启动隔离实例 pid=' + p.pid + '（CDP 端口 ' + PORT + '）');
        return p;
    }
    let proc = spawnInstance();
    sleep(9000);

    let barWs = await connectWhere(isBarPage, 30000);
    if (!barWs || !(await waitInvoke(barWs))) {
        rec('CDP 连不上横条页面 / IPC 没就绪 —— 实例可能没起来');
        rec('当前窗口：'); for (const w of wins()) rec('  ' + w.title + ' ' + fmt(w.rect));
        rec('log.txt 尾部：\n' + readLog().split('\n').slice(-20).join('\n'));
        flush(); process.exit(1);
    }
    info('横条页已连上，IPC 就绪');

    /** 横条 #bar 的样式快照（淡度三件套：计算 opacity / qs-dim / --qs-dim-alpha） */
    const barStyle = () => evalJs(barWs, `(function(){
        var b = document.getElementById('bar');
        var s = getComputedStyle(b);
        return { opacity: s.opacity, dim: b.classList.contains('qs-dim'),
                 noanim: b.classList.contains('qs-dim-noanim'),
                 alpha: s.getPropertyValue('--qs-dim-alpha').trim() };
    })()`);
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;

    /* =====================================================================
     *  准备触发环境：记事本里打一段字，全选复制
     * ===================================================================== */
    const { spawn: sp2 } = require('child_process');
    sp2('notepad', [], { detached: true, stdio: 'ignore' });
    sleep(1500);
    typeAscii('qs27');
    sleep(200);
    ctrlA();
    sleep(200);
    info('已在记事本输入 qs27 并全选');

    /* =====================================================================
     *  A 待机淡度
     * ===================================================================== */
    rec('');
    rec('=== A 待机淡度（默认 45%） ===');
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(300);
    ctrlC();
    const A0 = waitBar(9000);
    chk('★ Ctrl+C 唤出横条', !!A0, fmt(A0));
    // 横条是照着光标弹的：先把鼠标挪到屏幕角上，避开「指针已在横条上」的
    // 特例，专门测「弹出来、鼠标不在上面」这一路。
    moveTo(SW - 40, SH - 40);
    sleep(600);
    const a1 = await barStyle();
    info('弹出后（鼠标已避开）：' + JSON.stringify(a1));
    chk('  A1 弹出即淡：opacity≈0.45', near(a1.opacity, 0.45), 'opacity=' + a1.opacity);
    chk('  A1 挂着 qs-dim 类', a1.dim === true);
    chk('  A1 --qs-dim-alpha 落成 0.45', a1.alpha === '0.45', a1.alpha);

    // 悬停 → 平滑过渡到全不透明
    const cx = A0[0] + Math.round(A0[2] / 2), cy = A0[1] + Math.round(A0[3] / 2);
    moveTo(cx, cy);
    sleep(600);   // transition .22s，留足余量
    const a2 = await barStyle();
    info('鼠标进横条：' + JSON.stringify(a2));
    chk('★ A2 悬停后完全不透明', a2.opacity === '1' || near(a2.opacity, 1), 'opacity=' + a2.opacity);
    chk('  A2 qs-dim 已摘掉', a2.dim === false);

    // 离开 → 又淡回去
    moveTo(SW - 40, SH - 40);
    sleep(600);
    const a3 = await barStyle();
    info('鼠标离开：' + JSON.stringify(a3));
    chk('  A3 离开后又淡回去', near(a3.opacity, 0.45) && a3.dim === true,
        'opacity=' + a3.opacity + ' dim=' + a3.dim);

    /* =====================================================================
     *  A4/A5 面板开着时不淡
     * ===================================================================== */
    rec('');
    rec('=== A4/A5 面板开着 = 不淡 ===');
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(900);
    moveTo(SW - 40, SH - 40);       // 鼠标明确离开横条
    sleep(600);
    const a4 = await barStyle();
    info('面板开着 + 鼠标离开：' + JSON.stringify(a4));
    chk('★ A4 面板开着不淡（opacity=1、无 qs-dim）', a4.dim === false && (a4.opacity === '1' || near(a4.opacity, 1)),
        'opacity=' + a4.opacity + ' dim=' + a4.dim);

    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(700);
    moveTo(SW - 40, SH - 40);
    sleep(600);
    const a5 = await barStyle();
    info('面板收起 + 鼠标离开：' + JSON.stringify(a5));
    chk('  A5 面板收起恢复淡', near(a5.opacity, 0.45) && a5.dim === true,
        'opacity=' + a5.opacity + ' dim=' + a5.dim);
    esc();                          // 关掉面板可能残留的状态
    sleep(400);

    /* =====================================================================
     *  C 两类 URL
     * ===================================================================== */
    rec('');
    rec('=== C 两类 URL（搜 / 开） ===');
    // 先确保横条在（A5 之后 esc 收掉了）
    moveTo(Math.round(SW / 2), Math.round(SH / 2)); sleep(300);
    ctrlC();
    const C0 = waitBar(9000);
    chk('  C0 再次唤出横条（为点击引擎）', !!C0, fmt(C0));

    // ---- C1 面板角标 + 横条 tooltip ----
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(1000);
    const c1 = await evalJs(barWs, `(function(){
        var cells = document.querySelectorAll('#panelBody .cell');
        var open = 0, search = 0;
        cells.forEach(function(c){
            var k = c.querySelector('.ck');
            if (!k) return;
            if (k.classList.contains('open')) open++; else search++;
        });
        return { cells: cells.length, open: open, search: search };
    })()`);
    info('面板角标统计：' + JSON.stringify(c1));
    chk('  C1 面板有「开」角标（打开类）', c1.open > 100, 'open=' + c1.open);
    chk('  C1 面板有「搜」角标（搜索类）', c1.search > 100, 'search=' + c1.search);

    // 打开类格子的气泡里要点明「直接打开、不搜索」
    const c1b = await evalJs(barWs,
        `(function(){var c=document.querySelector('#panelBody .cell .ck.open');`
        + `if(!c) return 'NONE'; var cell=c.closest('.cell'); return cell.title||'';})()`);
    chk('  C1 打开类格子气泡说明「直接打开这个页面，不搜索」', /直接打开这个页面，不搜索/.test(c1b), c1b);

    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(700);

    // 横条 tooltip 区分
    const c1c = await evalJs(barWs, `(function(){
        var o = document.querySelector('#engines button[data-engine="QS27打开类"]');
        var s = document.querySelector('#engines button[data-engine="QS27搜索类"]');
        return { openT: o ? o.title : 'NONE', searchT: s ? s.title : 'NONE' };
    })()`);
    info('横条 tooltip：' + JSON.stringify(c1c));
    chk('  C1 打开类 tooltip 说「直接打开」', /直接打开/.test(c1c.openT), c1c.openT);
    chk('  C1 搜索类 tooltip 说「左键搜索」', /左键搜索/.test(c1c.searchT), c1c.searchT);

    /* ---- 点引擎：elementFromPoint 校准 + CDP 原生鼠标事件 ----
     * 为什么用 CDP Input 而不是 SendInput 物理点击：浏览器视口左上角未必和
     * 窗口矩形左上角重合（本机实测内缩 20,20 —— wv2 SetBounds 的合成面与
     * 窗口 rect 之间有 inset），按窗口 rect 折算会整体偏 20px，点到的就是
     * 旁边的格子。CDP 的事件坐标就是客户端坐标，和 getBoundingClientRect
     * 同一坐标系，零折算误差。 */
    async function clickEngine(name) {
        const rc = await evalJs(barWs, `(function(){
            var b = document.querySelector('#engines button[data-engine=${JSON.stringify(name)}]');
            if (!b) return null;
            var r = b.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        })()`);
        if (!rc) return { ok: false, why: '横条上找不到引擎按钮 ' + name };
        const relX = rc[0] + rc[2] / 2, relY = rc[1] + rc[3] / 2;
        const hit = await evalJs(barWs,
            `(function(){var el=document.elementFromPoint(${relX},${relY});`
            + `if(!el) return 'NONE'; var b=el.closest('button'); return b?(b.dataset.engine||'?'):'?';})()`);
        if (hit !== name) return { ok: false, why: 'elementFromPoint 命中「' + hit + '」不是「' + name + '」' };
        await cdp(barWs, 'Input.dispatchMouseEvent',
            { type: 'mousePressed', x: relX, y: relY, button: 'left', clickCount: 1 });
        await cdp(barWs, 'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: relX, y: relY, button: 'left', clickCount: 1 });
        return { ok: true };
    }

    // ---- C2 打开类：点了直达，log 里 kind=open ----
    const before2 = readLog().length;
    const clk1 = await clickEngine('QS27打开类');
    chk('  C2 点中打开类引擎', clk1.ok, clk1.why || '');
    await sleep(1200);
    const log2 = readLog().slice(before2);
    info('C2 log 增量：\n' + log2.trim().split('\n').map((s) => '    ' + s).join('\n'));
    chk('★ C2 日志记 kind=open', /种类=open/.test(log2));
    chk('  C2 直达地址（不带 %s）', log2.indexOf('QS27打开类 -> file:///C:/qs27-none/') >= 0,
        (log2.match(/QS27打开类 -> \S+/) || [''])[0]);

    // ---- C3 搜索类：选中词替换进 %s，log 里 kind=search ----
    moveTo(Math.round(SW / 2), Math.round(SH / 2)); sleep(300);
    ctrlC();
    waitBar(9000); sleep(500);
    const before3 = readLog().length;
    const clk2 = await clickEngine('QS27搜索类');
    chk('  C3 点中搜索类引擎', clk2.ok, clk2.why || '');
    await sleep(1200);
    const log3 = readLog().slice(before3);
    info('C3 log 增量：\n' + log3.trim().split('\n').map((s) => '    ' + s).join('\n'));
    chk('★ C3 日志记 kind=search', /种类=search/.test(log3));
    /* %s 被替换成「本次实际查询」。查询词本身不写死 —— 剪贴板里躺的是哪段
     * 文字由现场决定（别的探针注入的残留也放过），只要求：URL 以模板前缀
     * 开头、后面跟着非空的一段、且里面再也没有 %s 占位符。 */
    const m3 = log3.match(/QS27搜索类 -> (\S+)/);
    const url3 = m3 ? m3[1] : '';
    chk('  C3 %s 被替换成实际查询（不留占位符）',
        !!url3 && url3.indexOf('file:///C:/qs27-none/') === 0
        && url3.length > 'file:///C:/qs27-none/'.length && url3.indexOf('%s') < 0, url3);

    /* =====================================================================
     *  B 悬停前透明度可调 + 重启持久化
     * ===================================================================== */
    rec('');
    rec('=== B 悬停前透明度：设置页滑块（拖到 100）+ 重启持久化 ===');
    await evalJs(barWs, "invoke('open_settings', {tab:'general'}).catch(function(e){})");
    let setWs = await connectWhere(isSettingsPage, 25000);
    if (!setWs) {
        chk('  B0 设置窗口打开', false, '连不上 settings.html');
    } else {
        chk('  B0 设置窗口打开（通用分页）', true);
        const got = await evalJs(setWs, `(function(){
            var el = document.getElementById('s-barDimAlpha');
            el.value = '100';
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return { v: el.value, label: document.getElementById('s-barDimAlphaVal').textContent };
        })()`);
        info('滑块已拖到：' + JSON.stringify(got));
        const t0 = Date.now(); let cfgB = null;
        while (Date.now() - t0 < 12000) {
            try { const c = readCfg(); if (c.bar_dim_alpha === 100) { cfgB = c; break; } } catch (e) { }
            await sleep(300);
        }
        chk('  B1 设置写入 config.json（bar_dim_alpha=100）', !!cfgB,
            cfgB ? 'bar_dim_alpha=' + cfgB.bar_dim_alpha : 'config 里还不是 100');
        // 横条页（还活着）应当收到广播并改写 --qs-dim-alpha
        let saw100 = false;
        const t1 = Date.now();
        while (Date.now() - t1 < 12000) {
            const st = await barStyle();
            if (st.alpha === '1.00') { saw100 = true; break; }
            await sleep(300);
        }
        chk('★ B1 横条 --qs-dim-alpha 变 1.00（整套行为=关掉）', saw100,
            (await barStyle()).alpha);
    }

    // ---- 重启：磁盘上的值还在，且不悬停时出来就是实的 ----
    rec('');
    rec('=== B2 重启后仍生效（不悬停 opacity=1）===');
    try { proc.kill(); } catch (e) { }
    await sleep(2500);
    proc = spawnInstance();
    sleep(9000);
    barWs = await connectWhere(isBarPage, 30000);
    if (!barWs || !(await waitInvoke(barWs))) {
        chk('  B2 重启后连上横条', false);
    } else {
        chk('  B2 重启后连上横条', true);
        const cfgAfter = readCfg();
        info('重启后 config.bar_dim_alpha = ' + cfgAfter.bar_dim_alpha);
        chk('  B2 值持久化（100）', cfgAfter.bar_dim_alpha === 100);
        moveTo(Math.round(SW / 2), Math.round(SH / 2)); sleep(300);
        ctrlC();
        const B2 = waitBar(9000);
        chk('  B2 重启后横条能唤出', !!B2, fmt(B2));
        moveTo(SW - 40, SH - 40); sleep(700);
        const b2 = await barStyle();
        info('重启后弹出（鼠标避开）：' + JSON.stringify(b2));
        chk('★ B2 不悬停也完全不透明（100% = 关掉待机淡度）',
            b2.opacity === '1' || near(b2.opacity, 1), 'opacity=' + b2.opacity);
        chk('  B2 --qs-dim-alpha 仍是 1.00', b2.alpha === '1.00', b2.alpha);
    }

    /* =====================================================================
     *  收尾
     * ===================================================================== */
    rec('');
    rec('=== log.txt 尾部 25 行 ===');
    rec(readLog().split('\n').slice(-25).join('\n'));
    rec('');
    rec('==============================================');
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL');
    flush();
    for (const p of spawns) { try { p.kill(); } catch (e) { } }
    try { require('child_process').execSync('taskkill /IM notepad.exe /T /F', { stdio: 'ignore' }); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(failN ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(1);
});
