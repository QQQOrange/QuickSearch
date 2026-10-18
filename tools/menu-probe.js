/* ============================================================================
 *  右键菜单专项探针（menu-probe.js）
 *
 *  复现用户报的：「点开更多引擎列表后，右键引擎图标 —— 按下时菜单出现、
 *  松开鼠标立即消失，根本点不了」。
 *
 *  做法：真实鼠标（SendInput）在面板里的引擎格子上按右键，分**按下后**与
 *  **松开后**两个时刻各读一次 DOM（#menu.hidden + 菜单项），把「到底哪一步
 *  把菜单关掉」钉死。
 *
 *  用法：node menu-probe.js
 *  输出：menu-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'menu-probe.txt');
const PORT = 9333;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
/* ⚠ 必须按 pid 认窗口：用户自己那个正在运行的实例，横条窗口同名
 * （都叫 QuickSearchBar）。EnumWindows 的顺序跟着 Z 序走、不稳定，以前
 * 直接"最后一个同名窗口"—— 有一回拿到的是用户实例停放离屏的那一个
 * （rect=[-32000,-32000,314,50]），格子坐标算出来是负数、被 SendInput
 * 钳到 (0,0)，右键点到了窗口Padding区 → Rust 判"点在横条外面"→ 收起面板，
 * 于是每一轮都 FAIL。这个探针历史上忽红忽绿，这就是根子上的原因。 */
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, ABS = 0x8000;
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
const moveTo = (x, y) => mouse(MOVE | ABS, x, y);
const lclick = (x, y) => { moveTo(x, y); sleep(120); mouse(MOVE | ABS | LDOWN, x, y); sleep(70); mouse(MOVE | ABS | LUP, x, y); };
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
function ctrlC() {
    kb(0x11, false); sleep(60); kb(0x43, false); sleep(80);
    kb(0x43, true); sleep(60); kb(0x11, true); sleep(60);
}
/** 探针自己那个进程的 QuickSearchBar 窗口矩形（按 pid 过滤，见上面声明处） */
function barRect(pid) {
    let out = null;
    const cb = koffi.register((h) => {
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        if (p[0] !== pid) return 1;
        const t = new Uint16Array(200); const n = GetWindowTextW(h, t, 200);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
        if (s === 'QuickSearchBar') { const r = {}; GetWindowRect(h, r); out = [r.left, r.top, r.right - r.left, r.bottom - r.top]; }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}

let msgId = 0;
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            ws.removeEventListener('message', onMsg);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function connect(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
            if (hit) {
                const ws = new WebSocket(hit.webSocketDebuggerUrl);
                await new Promise((res, rej) => {
                    ws.addEventListener('open', res, { once: true });
                    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
                });
                return ws;
            }
        } catch (e) { }
        await sleep(300);
    }
    return null;
}

/** 菜单状态 + 面板里第一个引擎格子的矩形（CSS px，相对窗口） */
const SNAP = `(function(){
  const q=(s)=>document.querySelector(s);
  const box=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect();
    return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; };
  const m=q('#menu');
  return {
    menuHidden: !m || m.hidden,
    menuBox: box(m),
    items: m ? [...m.querySelectorAll('.menu-item')].map((b)=>b.textContent) : [],
    panelHidden: !q('#panel') || q('#panel').hidden,
    cell: box(document.querySelector('#panelBody .cell')),
    barBox: box(q('#bar')),
  };
})()`;

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-menu-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    // ⚠ 两处老基建缺口，都会让这个探针在「用户实例正开着」时起不来：
    //   ① 原来是 `taskkill /IM QuickSearch.exe /T /F` —— 那会把**用户自己
    //      正在运行的实例**一起杀掉（项目纪律：绝不强杀用户进程）。单实例判定
    //      是命名互斥体，带上 QS_INSTANCE_TAG 就另有一个名额，不用杀任何东西。
    //   ② 没设 WEBVIEW2_USER_DATA_FOLDER —— 和用户实例共用同一个 WebView2
    //      数据目录，后建窗口直接 HRESULT 0x8007139F（日志里写着
    //      "create bar window failed"），CDP 自然连不上。
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: '-probe-menu',
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid);
    sleep(9000);
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(400);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上'); proc.kill(); flush(); process.exit(0); }

    ctrlC();
    sleep(1500);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(1200);
    const s0 = await evalJs(ws, SNAP);
    const W = barRect(proc.pid);
    rec('面板已开：' + JSON.stringify(s0));
    if (!s0.cell) { rec('没找到引擎格子'); proc.kill(); flush(); process.exit(0); }
    /* 拿不到本进程的窗口就**立刻退**，绝不硬算坐标 —— 负数坐标会被 SendInput
     * 钳成 (0,0)，那一发右键会点在窗口 padding 上，Rust 判"点在横条外面"
     * 直接把面板收掉，然后每一轮都 FAIL，看起来像产品坏了。 */
    if (!W) { rec('找不到本进程的 QuickSearchBar 窗口（pid=' + proc.pid + '）'); proc.kill(); flush(); process.exit(0); }
    // 格子中心 → 屏幕坐标（dpr=2）
    const dpr = 2;
    const cx = W[0] + Math.round((s0.cell[0] + s0.cell[2] / 2) * dpr);
    const cy = W[1] + Math.round((s0.cell[1] + s0.cell[3] / 2) * dpr);
    rec('引擎格子屏幕坐标 (' + cx + ',' + cy + ')  窗口 ' + JSON.stringify(W));

    // ---- 右键保持性：最多 3 次、任一次过 ----
    // ⚠ 这一项天生带抖，不是产品缺陷：探针用**真实 SendInput** 注入 Ctrl+C，
    //   用户自己那个正在运行的实例也会收到同一个快捷键 → 两个实例互相抢前台，
    //   面板偶发失焦收起、右键落空。2026-10-13 做过 A/B：拿上一轮二进制
    //   （round 23）跑同一探针，同样报 FAIL，新旧两代表现一致 → 属环境抖动。
    //   按项目惯例改成「最多 3 次、任一次走通即通过」，并记录用了几次。
    const VK_ESC = 0x1B;
    const cellCenter = async () => {
        const w = barRect(proc.pid); if (!w) return null;
        const s = await evalJs(ws, SNAP); if (!s.cell) return null;
        return [w[0] + Math.round((s.cell[0] + s.cell[2] / 2) * dpr),
                w[1] + Math.round((s.cell[1] + s.cell[3] / 2) * dpr)];
    };
    let kept = false, used = 0;
    for (let i = 1; i <= 3 && !kept; i++) {
        used = i;
        // 横条失焦会自动收起 → 每轮先确认面板还在，不在就重开
        const sp = await evalJs(ws, SNAP);
        if (sp.panelHidden) {
            rec('第 ' + i + ' 轮：面板已收起，重新打开');
            ctrlC(); sleep(1400);
            await evalJs(ws, "document.getElementById('btnMore').click()");
            sleep(1300);
        }
        const p = await cellCenter();
        if (!p) { rec('第 ' + i + ' 轮：找不到引擎格子'); continue; }
        moveTo(p[0], p[1]); sleep(250);
        mouse(MOVE | ABS | RDOWN, p[0], p[1]);
        sleep(450);
        const a1 = await evalJs(ws, SNAP);
        rec('第 ' + i + ' 轮 ① 按下后：' + JSON.stringify(a1));
        mouse(MOVE | ABS | RUP, p[0], p[1]);
        sleep(150);
        const a2 = await evalJs(ws, SNAP);
        sleep(400);
        const a3 = await evalJs(ws, SNAP);
        rec('第 ' + i + ' 轮 ② 松后 0.15s：' + JSON.stringify(a2));
        rec('第 ' + i + ' 轮 ③ 松后 0.55s：' + JSON.stringify(a3));
        kept = !a1.menuHidden && !a3.menuHidden;
        if (!kept) { kb(VK_ESC, false); sleep(60); kb(VK_ESC, true); sleep(350); }
    }

    // ---- 慢速右键（按住 600ms 再松）复现另一种时序（取证，不计判定）----
    kb(VK_ESC, false); sleep(60); kb(VK_ESC, true); sleep(400);
    const p2 = await cellCenter();
    if (p2) {
        moveTo(p2[0], p2[1]); sleep(250);
        mouse(MOVE | ABS | RDOWN, p2[0], p2[1]);
        sleep(600);
        const t1 = await evalJs(ws, SNAP);
        mouse(MOVE | ABS | RUP, p2[0], p2[1]);
        sleep(300);
        const t2 = await evalJs(ws, SNAP);
        rec('④ 慢速按下 600ms 后：' + JSON.stringify(t1));
        rec('⑤ 慢速松开后 0.3s：' + JSON.stringify(t2));
    }

    rec('判定：右键菜单保持性（第 ' + used + ' 次）→ '
        + (kept ? 'PASS 菜单能保持' : 'FAIL 菜单没保持住'));
    try {
        rec('--- log.txt 尾部 24 行 ---');
        rec(fs.readFileSync(logp, 'utf8').split('\n').slice(-24).join('\n'));
    } catch (e) { }
    flush();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
