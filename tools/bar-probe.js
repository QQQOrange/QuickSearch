/* ============================================================================
 *  横条问题复现 / 验证（bar-probe.js）
 *
 *  一次跑完用户报的那几个横条相关现象，把客观数据写进 bar-probe.txt：
 *    A 唤起横条，记下窗口矩形（基准）
 *    B 点「⋯ 更多引擎」→ 面板展开后的窗口矩形（看横条有没有被挪位置）
 *    C 点面板底栏「设置…」→ 设置窗口到底开没开、开在哪、多大
 *    D 收起后再唤起、再点「⋯ 更多引擎」→ 面板是不是只剩一小截
 *    E 收藏面板：从 ⋯ 面板点收藏夹目录 → 面板矩形 + 横条位置有没有动
 *
 *  用法：node bar-probe.js [--keep]
 *  说明：自带「启动 + 交互」，因为 QuickSearch.exe 一旦由别的进程拉起、
 *        父进程退出就会跟着没（踩过），所以必须在同一个活着的进程里做完。
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'bar-probe.txt');
const PORT = 9333;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

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
const MOVE = 0x0001, ABS = 0x8000;
function moveTo(x, y) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeInt32LE(Math.round(x * 65535 / (SW - 1)), 8);
    b.writeInt32LE(Math.round(y * 65535 / (SH - 1)), 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(MOVE | ABS, 20);
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return SendInput(1, b, 40);
}

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

/* ------------------------------ 输入 ------------------------------ */
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
const VK_CONTROL = 0x11, VK_C = 0x43, VK_ESCAPE = 0x1B;
function ctrlC() {
    kb(VK_CONTROL, false); sleep(60);
    kb(VK_C, false); sleep(80);
    kb(VK_C, true); sleep(60);
    kb(VK_CONTROL, true); sleep(60);
}
const esc = () => { kb(VK_ESCAPE, false); sleep(60); kb(VK_ESCAPE, true); };

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
const find = (title) => wins().find((w) => w.title === title) || null;
const findHas = (sub) => wins().find((w) => w.title.includes(sub)) || null;
const barRect = () => {
    const w = find('QuickSearchBar');
    return w ? w.rect : null;
};
function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; sleep(150); }
    return false;
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
            ws.removeEventListener('error', onErr);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        const onErr = (e) => {
            ws.removeEventListener('message', onMsg);
            ws.removeEventListener('error', onErr);
            reject(new Error('ws: ' + (e && e.message || e)));
        };
        ws.addEventListener('message', onMsg);
        ws.addEventListener('error', onErr);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    }
    return r.result.value;
}
async function targetFor(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
            if (hit) return hit;
        } catch (e) { }
        await sleep(300);
    }
    return null;
}async function connect(sub) {
    const t = await targetFor(sub);
    if (!t) return null;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', (e) => rej(new Error('ws 连不上')), { once: true });
    });
    return ws;
}
/** 横条 DOM 快照 */
const SNAP = `(function(){
  const q=(s)=>document.querySelector(s);
  const box=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect();
    return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; };
  const p=q('#panel');
  return {
    panelHidden: !p || p.hidden,
    favMode: !!(p && p.classList.contains('fav-mode')),
    panel: box(p),
    body: box(q('#panelBody')),
    bar: box(q('#bar')),
    stage: box(q('#stage')),
    stageMinH: (q('#stage')||{}).style ? q('#stage').style.minHeight : '',
    stageMinW: (q('#stage')||{}).style ? q('#stage').style.minWidth : '',
    panelMaxH: p ? p.style.maxHeight : '',
    panelH: p ? p.style.height : '',
    docH: document.documentElement.scrollHeight,
    docW: document.documentElement.scrollWidth,
    innerH: window.innerHeight, innerW: window.innerWidth,
    favEntries: document.querySelectorAll('.fav-entry').length,
    cells: document.querySelectorAll('#panelBody .cell').length,
  };
})()`;

/* ------------------------------ 主流程 ------------------------------ */
(async function main() {
    const keep = process.argv.includes('--keep');
    // 临时 APPDATA：拷一份真实配置（保留用户的收藏夹/引擎），不碰用户数据
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-barprobe-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const realCfg = path.join(process.env.APPDATA, 'QuickSearch', 'config.json');
    // ⚠ 拷过来的配置里带着用户真实的 WebDAV 设置 —— 启动同步会把云端配置拉下来
    //   覆盖掉本地这份（实测：日志里「启动同步：云端配置更新，已恢复到本机」），
    //   探测的前提就没了。这里先把 WebDAV 关掉，让这次探测完全跑在本地副本上。
    {
        const c = JSON.parse(fs.readFileSync(realCfg, 'utf8'));
        c.webdav_url = '';
        c.webdav_user = '';
        c.webdav_pass = '';
        c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');

    try { execSync('taskkill /IM QuickSearch.exe /T /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1200);

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env: env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid + '  APPDATA=' + tmp);
    sleep(9000);

    // 把光标挪到屏幕中间，横条会出现在这儿附近
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(400);
    const pt = { x: 0, y: 0 };
    GetCursorPos(pt);
    rec('光标 (' + pt.x + ',' + pt.y + ')');

    // 横条页面的 URL 是根路径 http://tauri.localhost/（不是 index.html）
    const barWs = await connect('tauri.localhost/');
    rec('CDP 连横条：' + (barWs ? 'OK' : '失败'));
    if (!barWs) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            rec('调试端口在线，目标数=' + ts.length);
            for (const t of ts) rec('  target type=' + t.type + ' url=' + t.url);
        } catch (e) {
            rec('调试端口连不上：' + e.message);
        }
        rec('当前可见窗口：');
        for (const w of wins()) rec('  ' + w.title + '  ' + fmt(w.rect));
        try {
            rec('log.txt 尾部：\n' + fs.readFileSync(logp, 'utf8').split('\n').slice(-25).join('\n'));
        } catch (e) { }
        proc.kill(); flush(); process.exit(0);
    }

    // ---- A 唤起横条 ----
    ctrlC();
    const a1 = waitFor(() => { const r = barRect(); return r && r[0] > -10000; }, 8000);
    const A = barRect();
    rec('A 唤起横条：' + (a1 ? 'OK' : 'FAIL') + '  窗口 ' + fmt(A));
    sleep(700);
    rec('A DOM ' + JSON.stringify(await evalJs(barWs, SNAP)));

    // ---- B 点「⋯ 更多引擎」 ----
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(1200);
    const B = barRect();
    rec('B 点更多引擎：窗口 ' + fmt(B) + '  横条位移 ' + (A && B ? (B[0] - A[0]) + ',' + (B[1] - A[1]) : '?'));
    rec('B DOM ' + JSON.stringify(await evalJs(barWs, SNAP)));
    // 收藏夹入口的「胶囊」是否真的去掉了：读计算样式（border 宽度 + 圆角半径）
    rec('B 收藏夹入口样式 ' + JSON.stringify(await evalJs(barWs,
        "(function(){const b=document.querySelector('.fav-entry'); if(!b) return 'NONE';"
        + "const s=getComputedStyle(b);"
        + "return {borderTopWidth:s.borderTopWidth, borderTopColor:s.borderTopColor,"
        + " radius:s.borderRadius, bg:s.backgroundColor,"
        + " h:Math.round(b.getBoundingClientRect().height)};})()")));
    rec('B 引擎分类胶囊样式 ' + JSON.stringify(await evalJs(barWs,
        "(function(){const b=document.querySelector('.cat-nav-item:not(.fav-entry)');"
        + "if(!b) return 'NONE'; const s=getComputedStyle(b);"
        + "return {borderTopWidth:s.borderTopWidth, radius:s.borderRadius};})()")));
    execSync('python tools/shot.py tools/_bar-B.png', { cwd: ROOT, stdio: 'ignore' });

    // ---- C 点面板底栏「设置…」 ----
    await evalJs(barWs, "document.getElementById('btnSettings').click()");
    const c1 = waitFor(() => findHas('Quick Search 设置'), 12000);
    const C = findHas('Quick Search 设置');
    rec('C 点设置…：设置窗口 ' + (c1 ? '出现' : '**没出现**') + '  ' + fmt(C && C.rect)
        + (C ? ' 可见=' + C.vis : ''));
    // 可见性可能要等页面首帧（ready 信号）或 2.5s 兜底，多等一会儿再判
    const c2 = waitFor(() => { const w = findHas('Quick Search 设置'); return w && w.vis; }, 9000);
    const C2 = findHas('Quick Search 设置');
    rec('C 等待可见：' + (c2 ? 'OK 可见' : '**始终不可见**') + '  ' + fmt(C2 && C2.rect));
    execSync('python tools/shot.py tools/_bar-C.png', { cwd: ROOT, stdio: 'ignore' });

    // ---- D 关掉设置、再唤起横条、再点更多引擎（主线程有没有被卡住）----
    const PostMessageW = user32.func('int PostMessageW(void *h, uint32 msg, uintptr wp, intptr lp)');
    if (C2) {
        PostMessageW(C2.hwnd, 0x0010 /* WM_CLOSE */, 0, 0);
        const d0 = waitFor(() => !findHas('Quick Search 设置'), 6000);
        rec('D 关设置窗口：' + (d0 ? '已关闭' : '**关不掉**'));
    }
    sleep(600);
    ctrlC();
    waitFor(() => { const r = barRect(); return r && r[0] > -10000; }, 6000);
    sleep(700);
    const D1 = barRect();
    rec('D 重新唤起横条：窗口 ' + fmt(D1));
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(1400);
    const D2 = barRect();
    const dDom = await evalJs(barWs, SNAP);
    rec('D 再点更多引擎：窗口 ' + fmt(D2) + '  （应比收起态高出一大截）');
    rec('D DOM ' + JSON.stringify(dDom));
    rec('D 判定：面板高度 ' + (dDom.panel ? dDom.panel[3] : '?')
        + ' 窗口高度 ' + (D2 ? D2[3] : '?')
        + ' → ' + ((dDom.panel && dDom.panel[3] > 150) ? 'PASS 面板完整' : 'FAIL 面板只剩一小截'));
    execSync('python tools/shot.py tools/_bar-D.png', { cwd: ROOT, stdio: 'ignore' });

    // ---- E 收藏面板：横条会不会被挤走 ----
    const favIdx = await evalJs(barWs,
        "(function(){const b=document.querySelector('.fav-entry'); if(!b) return -1;"
        + "b.click(); return 1;})()");
    sleep(1400);
    const E1 = barRect();
    const eDom = await evalJs(barWs, SNAP);
    rec('E 点收藏夹目录：favEntry=' + favIdx + '  窗口 ' + fmt(E1)
        + '  横条位移 ' + (D2 && E1 ? (E1[0] - D2[0]) + ',' + (E1[1] - D2[1]) : '?'));
    rec('E DOM ' + JSON.stringify(eDom));
    rec('E 判定：' + ((D2 && E1 && Math.abs(E1[0] - D2[0]) <= 2 && Math.abs(E1[1] - D2[1]) <= 2)
        ? 'PASS 横条没被挤走' : 'FAIL 横条被挪了位置'));
    execSync('python tools/shot.py tools/_bar-E.png', { cwd: ROOT, stdio: 'ignore' });

    try {
        const lg = fs.readFileSync(logp, 'utf8').split('\n');
        rec('--- log.txt 尾部 30 行 ---');
        rec(lg.slice(-30).join('\n'));
    } catch (e) { rec('读日志失败 ' + e.message); }
    flush();
    if (!keep) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { } }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
