/* ============================================================================
 *  r74 「更多引擎」面板遮挡修复验证（需求 C）
 *
 *  用户原话：「如果在屏幕中下位置触发横条，这时候点开更多引擎，因为横条位置
 *  原因导致所有的内容都被遮挡住了，只看得到收藏夹和引擎大类，但看不到任何
 *  一个引擎的内容，所以我希望你完善一下逻辑，肯定是要以显示更多引擎的内容
 *  为主，这时候把横条往上面移一点都是可以的，但收起更多引擎之后，横条要
 *  回到原来的位置。」
 *
 *  修法（ui/bar.js renderPanel）：引擎面板**不再**按「横条下面还剩多少」
 *  （barRoomBelow）收窄高度，只按屏幕百分比封顶；放不下时由 Rust 的
 *  layout_bar 用「横条 ∪ 面板」包围盒整体上移。收起后包围盒缩回横条，
 *  位置自动复位（钳制的自然结果，不需要前端记状态）。
 *
 *  本探针逐条验证：
 *    P1 锚点真的在屏幕中下部（余量本来只够一条缝）
 *    P2 面板高度是完整的（不再是 ~180px 的小条），引擎内容真的看得见
 *    P3 横条确实临时上移了（用户允许），且整个包围盒不出工作区
 *    P4 收起面板后横条回到原位（窗口矩形和收起前一致）
 *    P5 收藏面板策略没被带坏（横条不动、面板按余量收窄——老策略照旧）
 *
 *  用法: node tools/r74-panel-shift-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r74-panel-shift-probe.txt');
const PORT = 9471;
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
const SetCursorPos = user32.func('int SetCursorPos(int x, int y)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetCursorPos = user32.func('int GetCursorPos(_Out_ POINT *p)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}

/* ------------------------------ 窗口枚举 ------------------------------ */
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
const barRect = () => { const w = find('QuickSearchBar'); return w ? w.rect : null; };
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
            reject(new Error('ws: ' + ((e && e.message) || e)));
        };
        ws.addEventListener('message', onMsg);
        ws.addEventListener('error', onErr);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
const ev = async (ws, expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
};
async function targetFor(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            /* ⚠ 别用 url.indexOf(sub)：tauri.localhost/ 是所有页面的前缀。
             * 横条页面是根路径（tauri.localhost/ 或带 index.html）。 */
            const hit = ts.find((t) => t.type === 'page'
                && /tauri\.localhost\/?(index\.html)?(\?|$)/.test(t.url || ''));
            if (hit) return hit;
        } catch (e) { }
        await sleep(300);
    }
    return null;
}
async function connectBar() {
    const t = await targetFor();
    if (!t) return null;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('ws 连不上')), { once: true });
    });
    return ws;
}

/** 横条 DOM 快照：面板/横条/窗口尺寸 + 引擎格子的可见性 */
const SNAP = `(function(){
  const q=(s)=>document.querySelector(s);
  const box=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect();
    return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; };
  const p=q('#panel');
  const body=q('#panelBody');
  const cells=[].slice.call(document.querySelectorAll('#panelBody .cell'));
  // 「看得见」的引擎格子：完整落在面板 body 视口里（sticky 头下面的才算数）
  let visCells=0, firstVis=null;
  if (body) {
    const br=body.getBoundingClientRect();
    for (const c of cells) {
      const r=c.getBoundingClientRect();
      if (r.height>0 && r.top>=br.top-1 && r.bottom<=br.bottom+1) {
        visCells++;
        if (!firstVis) firstVis=[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)];
      }
    }
  }
  return {
    panelHidden: !p || p.hidden,
    favMode: !!(p && p.classList.contains('fav-mode')),
    panel: box(p), body: box(body), bar: box(q('#bar')),
    panelMaxH: p ? p.style.maxHeight : '',
    innerH: window.innerHeight, innerW: window.innerWidth,
    cells: cells.length, visCells: visCells, firstVis: firstVis,
    favEntries: document.querySelectorAll('.fav-entry').length,
  };
})()`;

(async () => {
    try { execSync('taskkill /IM QuickSearch.exe /T /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1000);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r74p-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, theme: 'light', bar_list: ['百度', 'Google'],
        /* 预置一个收藏目录：P5 要验「收藏面板老策略没被带坏」，
         * 没数据的话 .fav-entry 根本不会渲染，点了等于没点。 */
        favorites: [{
            id: 'g1', name: '常用',
            items: [{ id: 'i1', kind: 'text', text: '探针收藏内容' }],
        }],
    }, null, 1), 'utf8');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r74p' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r74 面板遮挡探针：pid=' + proc.pid + '  APPDATA=' + tmp);
    sleep(9000);

    try {
        /* ---------- ① 把光标放到屏幕中下部，再唤出横条 ----------
         * 屏幕高 SH，光标放在 SH-60：锚点距屏幕底只剩 ~60px，
         * 老逻辑下面板会被钳成一条缝（用户报的场景）。
         * ⚠ 回读校验 + 重试：这是真实机器，用户/输入法/别的程序随时可能
         *   挪鼠标 —— 只 set 一次不验证，锚点飘了后面全白测（踩过：
         *   期望 y=2100 实测 1207）。 */
        const mx = Math.round(SW / 2), my = SH - 60;
        let pt = { x: 0, y: 0 };
        for (let i = 0; i < 12; i++) {
            SetCursorPos(mx, my);
            await sleep(90);
            GetCursorPos(pt);
            if (Math.abs(pt.x - mx) <= 4 && Math.abs(pt.y - my) <= 60) break;
        }
        rec('光标 (' + pt.x + ',' + pt.y + ')  屏幕 ' + SW + 'x' + SH
            + '  期望 (' + mx + ',' + my + ')  重试校准 ' + (Math.abs(pt.y - my) <= 60 ? 'OK' : '未收敛'));
        check('P1 光标落在屏幕中下部（锚点距底 < 200px，复现用户场景）',
            pt.y > SH - 200 && Math.abs(pt.x - mx) <= 4,
            'pt.y=' + pt.y + ' SH=' + SH);

        const ws = await connectBar();
        check('P1b 连上横条页面', !!ws);
        if (!ws) { try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { } return; }
        await ev(ws, `window.__TAURI__.core.invoke('show_bar', { text: '测试文本', atMouse: true, viaCopy: false })`);
        await sleep(1400);

        // 收起态：基准窗口矩形 + DOM
        const A = barRect();
        const domA = await ev(ws, SNAP);
        rec('A 收起态：窗口 ' + fmt(A));
        rec('A DOM ' + JSON.stringify(domA));
        check('P1c 横条已弹出（收起态窗口存在）', !!A && A[1] > 0, fmt(A));

        /* ---------- ② 点「⋯ 更多引擎」→ 面板展开 ---------- */
        await ev(ws, "document.getElementById('btnMore').click()");
        await sleep(1800);
        const B = barRect();
        const domB = await ev(ws, SNAP);
        rec('B 展开态：窗口 ' + fmt(B) + '  （收起态 ' + fmt(A) + '）');
        rec('B DOM ' + JSON.stringify(domB));

        /* P2 面板是完整高度，不是被钳出来的小条。
         * 面板自然高度约 450px（body 344 + sticky 头 + 底栏）；
         * 老逻辑在中下部锚点下只剩 ~180px。阈值取 320。 */
        const panelH = domB.panel ? domB.panel[3] : 0;
        check('P2 面板完整展开（高度 > 320px，不再是~180px 的小条）',
            !domB.panelHidden && panelH > 320, 'panelH=' + panelH);

        /* P2b 引擎内容真的看得见：面板 body 里至少 3 个格子完整可见，
         * 第一个可见格子在 sticky 头下面（隐患场景是只看到头、一个格子都没有）。 */
        check('P2b 引擎内容可见（≥3 个格完整落在面板里，sticky 头不再占满）',
            domB.visCells >= 3 && !!domB.firstVis, 'cells=' + domB.cells + ' vis=' + domB.visCells
            + ' first=' + JSON.stringify(domB.firstVis));

        /* P3 横条临时上移（用户允许「往上面移一点」），且整个包围盒
         * 不出工作区底部（Rust 钳制的职责）。 */
        const moved = A && B ? A[1] - B[1] : 0;
        check('P3 横条随面板临时上移（内容优先，用户明确允许）',
            !!A && !!B && B[1] < A[1] && B[1] > -1000,
            'A.y=' + (A && A[1]) + ' B.y=' + (B && B[1]) + ' 上移=' + moved);
        check('P3b 展开态整个窗口不出屏幕底部（Rust 包围盒钳制兜住）',
            !!B && B[1] + B[3] <= SH + 2, fmt(B) + ' SH=' + SH);

        try { execSync('python tools/shot.py tools/_r74-panel-open.png', { cwd: ROOT, stdio: 'ignore' }); } catch (e) { }

        /* ---------- ③ 收起面板 → 横条回原位 ---------- */
        await ev(ws, "document.getElementById('btnMore').click()");
        await sleep(1200);
        const C = barRect();
        const domC = await ev(ws, SNAP);
        rec('C 收起后：窗口 ' + fmt(C) + '  （基准 ' + fmt(A) + '）');
        rec('C DOM ' + JSON.stringify(domC));
        check('P4 收起后面板真的关了', domC.panelHidden === true, JSON.stringify(domC.panelHidden));
        check('P4b 收起后横条回到原位（窗口矩形与展开前一致，±2px）',
            !!A && !!C && Math.abs(C[0] - A[0]) <= 2 && Math.abs(C[1] - A[1]) <= 2
            && Math.abs(C[2] - A[2]) <= 2 && Math.abs(C[3] - A[3]) <= 2,
            'A=' + fmt(A) + ' C=' + fmt(C));

        try { execSync('python tools/shot.py tools/_r74-panel-closed.png', { cwd: ROOT, stdio: 'ignore' }); } catch (e) { }

        /* ---------- ④ 收藏面板策略没被带坏 ----------
         * 用户当年点名「一点收藏夹，横条立刻跑到别的地方去了」—— 收藏
         * 面板必须保持「横条不动、面板按余量收窄、内部滚动」老策略。
         * ⚠ .fav-entry 只在面板展开时才在 DOM 里（renderPanel 画的），
         *   上一步刚收起过，这里要先重新展开。
         * ⚠ 底部锚点场景下收藏面板**也会**被 Rust 从锚点重算后上移 —— 那是
         *   renderFavPanel（r74 一行没动）自 r50 起就有的行为：capByRoom 只
         *   在锚点远离底部时才兜得住。用户报「收藏夹横条跑掉」的场景是横条
         *   在屏幕中部，所以真正的断言放下面中部锚点那次。 */
        await ev(ws, "document.getElementById('btnMore').click()");
        await sleep(1200);
        const fav = JSON.parse(await ev(ws, `(function(){
            var b = document.querySelector('.fav-entry');
            if (!b) return JSON.stringify({ err: 'no-fav-entry' });
            b.click();
            return JSON.stringify({ clicked: true });
        })()`));
        rec('点收藏夹入口（底部锚点场景）：' + JSON.stringify(fav));
        await sleep(1500);
        const D = barRect();
        const domD = await ev(ws, SNAP);
        rec('D 收藏面板（底部场景）：窗口 ' + fmt(D) + '  （收起态基准 ' + fmt(A) + '）');
        rec('D DOM ' + JSON.stringify(domD));
        check('P5b 收藏面板按余量收窄（maxHeight 被 barRoomBelow 钳过，内部滚动）',
            domD.favMode === true && /px$/.test(domD.panelMaxH || ''),
            'maxH=' + domD.panelMaxH + ' panel=' + JSON.stringify(domD.panel));

        /* ---------- ⑤ 中部锚点：收藏面板「横条不动」的老策略 ----------
         * 重现在用户当年报「一点收藏夹，横条立刻跑到别的地方去了」的场景：
         * 锚点在屏幕中部，下方余量充足。收藏面板按 capByRoom 收窄到放得下，
         * 窗口向下生长，横条不许动。 */
        const mx2 = Math.round(SW / 2), my2 = Math.round(SH / 2);
        let pt2 = { x: 0, y: 0 };
        for (let i = 0; i < 12; i++) {
            SetCursorPos(mx2, my2);
            await sleep(90);
            GetCursorPos(pt2);
            if (Math.abs(pt2.x - mx2) <= 4 && Math.abs(pt2.y - my2) <= 60) break;
        }
        rec('中部锚点光标 (' + pt2.x + ',' + pt2.y + ')  期望 (' + mx2 + ',' + my2 + ')');
        await ev(ws, `window.__TAURI__.core.invoke('show_bar', { text: '测试文本', atMouse: true, viaCopy: false })`);
        await sleep(1400);
        const A2 = barRect();
        rec('A2 中部锚点收起态：窗口 ' + fmt(A2));
        await ev(ws, "document.getElementById('btnMore').click()");
        await sleep(1500);
        const B2 = barRect();
        const domB2 = await ev(ws, SNAP);
        rec('B2 中部锚点引擎面板：窗口 ' + fmt(B2) + '  DOM ' + JSON.stringify(domB2));
        const fav2 = JSON.parse(await ev(ws, `(function(){
            var b = document.querySelector('.fav-entry');
            if (!b) return JSON.stringify({ err: 'no-fav-entry' });
            b.click();
            return JSON.stringify({ clicked: true });
        })()`));
        await sleep(1500);
        const D2 = barRect();
        const domD2 = await ev(ws, SNAP);
        rec('D2 中部锚点收藏面板：窗口 ' + fmt(D2) + '  （收起态 ' + fmt(A2) + '）');
        rec('D2 DOM ' + JSON.stringify(domD2));
        check('P5 收藏面板老策略：中部锚点下横条不动（窗口 y 与收起态一致）',
            !!A2 && !!D2 && fav2.clicked === true && domD2.favMode === true
            && Math.abs(D2[1] - A2[1]) <= 2, 'A2.y=' + (A2 && A2[1]) + ' D2.y=' + (D2 && D2[1]));
        check('P5c 收藏面板比引擎面板矮（按余量收窄生效，不是撑满）',
            !!B2 && !!D2 && D2[3] < B2[3],
            'B2.h=' + (B2 && B2[3]) + ' D2.h=' + (D2 && D2[3]));

        try { ws.close(); } catch (e) { }
    } finally {
        try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        rec('----------------------------------------');
        rec('r74 面板遮挡探针：' + pass + ' / ' + (pass + fail) + ' 通过');
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})().catch((e) => { rec('探针抛异常：' + ((e && e.stack) || e)); process.exit(1); });
