/* ============================================================================
 *  收藏面板「左下角缩放」专项探针（fav-rz-probe.js）
 *
 *  复现用户报的两个现象：
 *    ① 点横条收藏夹后用**左下角**调整大小 → 窗口与横条一起闪烁；
 *    ② 调完之后不管怎么改都「恢复原样」（尺寸被重置）。
 *
 *  做法：真实鼠标（SendInput）拖 .fav-rz.sw 把手 —— 不能用 CDP 合成鼠标事件，
 *  因为西向缩放会**移动窗口**，合成事件的 clientX 语义和真实屏幕坐标对不上，
 *  补偿逻辑（真实位移 = clientX 差 - 上次申请的窗口位移）就失真了。
 *
 *  用法：node fav-rz-probe.js
 *  输出：fav-rz-probe.txt（逐帧的窗口矩形 / 面板矩形 / 内联样式 / 配置里的尺寸）
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'fav-rz-probe.txt');
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
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

/* ------------------------------ 输入 ------------------------------ */
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
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
const ldown = (x, y) => mouse(MOVE | ABS | LDOWN, x, y);
const lup = (x, y) => mouse(MOVE | ABS | LUP, x, y);
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

/* ------------------------------ 窗口 ------------------------------ */
const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function barRect() {
    let out = null;
    const cb = koffi.register((h) => {
        if (wtext(h) === 'QuickSearchBar') {
            const r = {}; GetWindowRect(h, r);
            out = [r.left, r.top, r.right - r.left, r.bottom - r.top];
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const fmt = (r) => r ? `x=${r[0]} y=${r[1]} w=${r[2]} h=${r[3]}` : 'NONE';

/* ------------------------------ CDP ------------------------------ */
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

/** 面板 + 把手 + 内联样式 + 配置里存的尺寸，一次量全 */
const SNAP = `(function(){
  const q=(s)=>document.querySelector(s);
  const box=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect();
    return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; };
  const p=q('#panel'), st=q('#stage');
  const hz=q('.fav-rz.sw');
  return {
    panel: box(p), handle: box(hz), stage: box(st),
    padL: st?st.style.paddingLeft:'', minH: st?st.style.minHeight:'', minW: st?st.style.minWidth:'',
    pw: p?p.style.width:'', ph: p?p.style.height:'', pmaxH: p?p.style.maxHeight:'',
    pl: p?p.style.left:'', pt: p?p.style.top:'',
    docH: document.documentElement.scrollHeight, innerH: window.innerHeight,
  };
})()`;

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-favrz-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const realCfg = path.join(process.env.APPDATA, 'QuickSearch', 'config.json');
    {
        const c = JSON.parse(fs.readFileSync(realCfg, 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');

    try { execSync('taskkill /IM QuickSearch.exe /T /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1200);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid);
    sleep(9000);
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(400);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上，退出'); proc.kill(); flush(); process.exit(0); }

    // 唤起横条 → 打开 ⋯ 面板 → 点收藏夹目录
    ctrlC();
    sleep(1500);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(1000);
    const favN = await evalJs(ws,
        "(function(){const b=document.querySelector('.fav-entry'); if(!b) return 0; b.click(); return 1;})()");
    sleep(1500);
    rec('打开收藏面板：favEntry=' + favN);
    rec('初始 ' + JSON.stringify(await evalJs(ws, SNAP)) + '  窗口 ' + fmt(barRect()));

    // 把手在屏幕上的位置（DOM CSS 坐标 × dpr + 窗口原点）
    const s0 = await evalJs(ws, SNAP);
    const W0 = barRect();
    if (!s0.handle) { rec('没找到 .fav-rz.sw 把手，退出'); proc.kill(); flush(); process.exit(0); }
    const dpr = 2;
    const hx = W0[0] + Math.round((s0.handle[0] + s0.handle[2] / 2) * dpr);
    const hy = W0[1] + Math.round((s0.handle[1] + s0.handle[3] / 2) * dpr);
    rec('把手屏幕坐标 (' + hx + ',' + hy + ')  面板 ' + JSON.stringify(s0.panel));

    // ---- 拖：往左 + 往下（左下角语义）----
    const frames = [];
    moveTo(hx, hy); sleep(150);
    ldown(hx, hy); sleep(120);
    for (let i = 1; i <= 8; i++) {
        const x = hx - i * 25, y = hy + i * 15;
        moveTo(x, y);
        sleep(90);
        const s = await evalJs(ws, SNAP);
        frames.push({ i, x, y, panel: s.panel, padL: s.padL, pw: s.pw, ph: s.ph, win: barRect() });
    }
    lup(hx - 200, hy + 120);
    sleep(300);
    const afterDrag = await evalJs(ws, SNAP);
    rec('拖完（松手 0.3s）' + JSON.stringify(afterDrag) + '  窗口 ' + fmt(barRect()));

    // ---- 等 600ms 保存 + 配置广播回来，看尺寸会不会被弹回去 ----
    sleep(1500);
    const afterSave = await evalJs(ws, SNAP);
    // CONF 是页面内联脚本里的模块级变量，CDP 摸不到 —— 直接读落盘的配置文件，
    // 那才是「到底存进去没有」的唯一事实来源
    let confSize = 'n/a';
    try {
        const c = JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8'));
        confSize = JSON.stringify(c.fav_panel_sizes || null);
    } catch (e) { confSize = '读配置失败 ' + e.message; }
    rec('保存后（1.8s）' + JSON.stringify(afterSave) + '  窗口 ' + fmt(barRect()));
    rec('配置文件里的 favPanelSizes = ' + confSize);

    rec('--- 逐帧 ---');
    for (const f of frames) {
        rec('  #' + f.i + ' 鼠标(' + f.x + ',' + f.y + ') 窗口 ' + fmt(f.win)
            + ' 面板 ' + JSON.stringify(f.panel) + ' padL=' + f.padL
            + ' w=' + f.pw + ' h=' + f.ph);
    }
    // 判定
    const p0 = s0.panel, p1 = afterDrag.panel, p2 = afterSave.panel;
    const grew = p1 && p0 && (p1[2] > p0[2] + 20 || p1[3] > p0[3] + 20);
    const kept = p2 && p1 && Math.abs(p2[2] - p1[2]) <= 4 && Math.abs(p2[3] - p1[3]) <= 4;
    rec('判定：拖动确实变大了=' + grew + '  保存后没被弹回=' + kept
        + '  → ' + (grew && kept ? 'PASS' : 'FAIL'));
    try {
        rec('--- log.txt 尾部 12 行 ---');
        rec(fs.readFileSync(logp, 'utf8').split('\n').slice(-12).join('\n'));
    } catch (e) { }
    flush();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
