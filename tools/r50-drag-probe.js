/* ============================================================================
 *  r50 收藏夹面板：拖动不能闪 + 必须能拖到屏幕四边（r50-drag-probe.js）
 *
 *  用户报的两条（原话）：
 *    ① 「通过横条更多引擎打开收藏夹页面会在拖动的时候闪烁」
 *    ② 「它不能够拖到屏幕的边缘…只能拖到左边屏幕的右边缘，但是右边上面就不可以」
 *
 *  这条探针不改任何东西，只**量**：
 *    · 屏幕到底多大（DPI 感知的物理像素 vs 页面 CSS 像素）—— ② 的前提；
 *    · 鼠标走 1 CSS px 时窗口实际走几个 CSS px（1:1 跟手？还是只走一半 → 到不了右边）；
 *    · 拖动期间面板样式的改动次数 / 应用摆位日志里的窗口坐标 —— ① 的"闪烁"要有可数的东西。
 *
 *  面板怎么打开：给这份配置的 bar_list **补一个 @fav:<第一个目录 id>**（用户自己的
 *  bar_list 里没有收藏哨兵，正常走托盘菜单那条 qs://fav-open），于是横条上出现收藏格子，
 *  点它 = openFavPanel（和用户那条路是同一个函数）。
 *
 *  用法：node r50-drag-probe.js     输出：r50-drag-probe.txt
 *  ⚠ 自带身份（QS_INSTANCE_TAG + 独立 WebView2 目录），不杀任何别人的进程。
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r50-drag-probe.txt');
const PORT = 9343;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

function moveTo(x, y) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeInt32LE(Math.round(x * 65535 / (SW - 1)), 8);
    b.writeInt32LE(Math.round(y * 65535 / (SH - 1)), 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(0x0001 | 0x8000, 20);
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return SendInput(1, b, 40);
}
function mouse(down) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(down ? 0x0002 : 0x0004, 20);   // LEFTDOWN / LEFTUP
    b.writeUInt32LE(0, 24);
    b.writeBigUInt64LE(0n, 32);
    return SendInput(1, b, 40);
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
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.text || '');
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

const SNAP = `JSON.stringify({
  win: [Math.round(window.screenX), Math.round(window.screenY)],
  outer: [window.outerWidth, window.outerHeight],
  rect: (function(){ const p = document.getElementById('panel');
    if (!p || p.hidden) return null; const r = p.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
})`;

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-drag-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    let favId = '';
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        const favs = Array.isArray(c.favorites) ? c.favorites : [];
        if (favs.length) {
            favId = favs[0].id;
            const sent = '@fav:' + favId;
            if (!Array.isArray(c.bar_list)) c.bar_list = [];
            if (c.bar_list.indexOf(sent) < 0) c.bar_list.push(sent);
        }
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    rec('探针自己 DPI 感知看到的屏幕：' + SW + 'x' + SH + ' 物理像素；补的收藏哨兵 = ' + (favId || '（没有收藏目录）'));
    const TAG = 'drag' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: TAG,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid);
    sleep(9000);
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(400);

    const barWs = await connect('tauri.localhost/');
    if (!barWs) { rec('横条 CDP 连不上'); proc.kill(); flush(); process.exit(1); }

    const env1 = await evalJs(barWs, `JSON.stringify({
      dpr: window.devicePixelRatio,
      screenW: screen.width, screenH: screen.height,
      availW: screen.availWidth, availH: screen.availHeight,
      winX: window.screenX, winY: window.screenY,
      outerW: window.outerWidth, outerH: window.outerHeight,
      innerW: window.innerWidth, innerH: window.innerHeight,
    })`);
    rec('页面里的坐标环境：' + env1);
    const E = JSON.parse(env1), dpr = E.dpr || 1;

    // 横条**窗口**是不是真在屏上（DOM 没 hidden ≠ 窗口已摆位：没锚点时
    // Rust 只记尺寸不摆窗口，窗口还停在 -10000 的停车位）
    if (E.winX <= -9000) {
        rec('横条窗口还在屏外停车位（' + E.winX + '）→ 先叫出来');
        moveTo(Math.round(SW / 2), Math.round(SH / 2));
        sleep(300);
        const u32 = koffi.load('user32.dll');
        const keybd = u32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)');
        keybd(0x11, 0, 0, 0); sleep(60); keybd(0x43, 0, 0, 0); sleep(80);
        keybd(0x43, 0, 2, 0); sleep(60); keybd(0x11, 0, 2, 0);
        sleep(1500);
        for (let i = 0; i < 20; i++) {
            const w = await evalJs(barWs, "[window.screenX, window.screenY]");
            if (Array.isArray(w) && w[0] > -9000) { rec('横条窗口已上屏：' + JSON.stringify(w)); break; }
            sleep(500);
        }
    }
    const env2 = await evalJs(barWs, SNAP);
    rec('叫出来之后：' + env2);

    const opened = await evalJs(barWs, `(function(){
      const cell = document.querySelector('[data-fav^="@fav:"]');
      if (!cell) return 'no-fav-cell';
      cell.click();
      return 'clicked:' + cell.dataset.fav;
    })()`);
    rec('点横条上的收藏格子：' + opened);
    sleep(1800);
    const p1 = await evalJs(barWs, SNAP);
    rec('打开后：' + p1);
    const head = await evalJs(barWs, `(function(){
      const p = document.getElementById('panel');
      if (!p || p.hidden) return 'NO-PANEL';
      const h = p.querySelector('.fav-head');
      if (!h) return 'NO-HEAD';
      window.__dragProbe = { styleChanges: 0, rectHist: [] };
      try {
        new MutationObserver((ms) => { window.__dragProbe.styleChanges += ms.length; })
          .observe(p, { attributes: true, attributeFilter: ['style'] });
      } catch (e) {}
      // 找一个"按下去不会落在按钮上"的点：startFavDrag 遇到 button/input/a 会直接放弃
      const hr = h.getBoundingClientRect();
      for (let x = Math.round(hr.left) + 6; x < Math.round(hr.right) - 6; x += 4) {
        for (const y of [Math.round(hr.top) + 6, Math.round(hr.bottom) - 6]) {
          const el = document.elementFromPoint(x, y);
          if (!el) continue;
          if (el.closest('button, input, a, .mini')) continue;
          return JSON.stringify({ x, y, hit: el.className || el.tagName,
            head: [Math.round(hr.left), Math.round(hr.top), Math.round(hr.width), Math.round(hr.height)] });
        }
      }
      return 'NO-SAFE-POINT';
    })()`);
    rec('拖动把手 .fav-head（CSS，含安全落点）：' + head);
    if (/^(NO-|ERR)/.test(String(head))) { rec('⚠ 拿不到把手，到此为止'); proc.kill(); flush(); process.exit(0); }
    const H = JSON.parse(head);

    /* ---------- 拖动：从把手出发，一路推到屏幕右上角 ---------- */
    // ⚠ 把手坐标是**视口内** CSS 坐标，SendInput 要的是**屏幕**物理坐标 ——
    //   必须加上窗口自己的屏幕位置再乘 dpr（第一版忘了这一步，点到了桌面空白处，
    //   结果是把横条"点没了"，看起来像拖动失败）。
    const before = await evalJs(barWs, SNAP);
    const B0 = JSON.parse(before);
    const fromX = Math.round((B0.win[0] + H.x) * dpr), fromY = Math.round((B0.win[1] + H.y) * dpr);
    const toX = SW - 6, toY = 6;
    rec('拖动（屏幕物理像素）：(' + fromX + ',' + fromY + ') → (' + toX + ',' + toY + ')');
    moveTo(fromX, fromY);
    sleep(300);
    mouse(true);
    sleep(120);
    const t0 = Date.now();
    const STEPS = 24;
    for (let i = 1; i <= STEPS; i++) {
        moveTo(Math.round(fromX + (toX - fromX) * i / STEPS),
              Math.round(fromY + (toY - fromY) * i / STEPS));
        sleep(35);
    }
    sleep(250);
    mouse(false);
    const dur = Date.now() - t0;
    sleep(800);
    const after = await evalJs(barWs, SNAP);
    rec('');
    rec('拖动前：' + before);
    rec('拖动后：' + after);
    const probe = await evalJs(barWs, "JSON.stringify(window.__dragProbe || {})");
    rec('拖动期间 ' + dur + 'ms / ' + STEPS + ' 步：' + probe);

    const b = JSON.parse(before), a = JSON.parse(after);
    const mouseCss = { x: (toX - fromX) / dpr, y: (toY - fromY) / dpr };
    const winMoved = { x: a.win[0] - b.win[0], y: a.win[1] - b.win[1] };
    const rx = mouseCss.x ? winMoved.x / mouseCss.x : 0;
    const ry = mouseCss.y ? winMoved.y / mouseCss.y : 0;
    rec('');
    rec('鼠标走了（CSS）：' + mouseCss.x.toFixed(1) + ' , ' + mouseCss.y.toFixed(1));
    rec('窗口走了（CSS）：' + winMoved.x + ' , ' + winMoved.y
        + '  →  跟手比例 x=' + rx.toFixed(3) + ' y=' + ry.toFixed(3)
        + '   （1.000 = 1:1 跟手；≈0.5 = 只走一半 → 永远到不了右边）');
    rec('面板左上角（CSS）：' + JSON.stringify(b.rect) + ' → ' + JSON.stringify(a.rect));
    if (a.rect) {
        const right = a.rect[0] + a.rect[2], bottom = a.rect[1] + a.rect[3];
        rec('面板右缘 = ' + right + ' / 页面可用宽 ' + E.innerW
            + '   → ' + (right >= E.innerW - 8 ? '✅ 贴到右边了' : '❌ 差 ' + (E.innerW - right) + 'px'));
        rec('面板顶边 = ' + a.rect[1] + '   → ' + (a.rect[1] <= 8 ? '✅ 贴到顶了' : '❌ 差 ' + a.rect[1] + 'px'));
        rec('面板下缘 = ' + bottom + ' / 页面可用高 ' + E.innerH);
    }
    flush();

    try {
        for (const f of fs.readdirSync(path.join(tmp, 'QuickSearch'))) {
            if (!/\.(log|txt)$/i.test(f)) continue;
            const lines = fs.readFileSync(path.join(tmp, 'QuickSearch', f), 'utf8').split('\n');
            const places = lines.filter((l) => /place: |layout_bar css=/.test(l));
            rec('');
            rec('应用日志 ' + f + '：place/layout 行 ' + places.length + ' 条；最后 8 条：');
            for (const l of places.slice(-8)) rec('    ' + l.trim());
        }
    } catch (e) { rec('（读应用日志失败：' + e.message + '）'); }

    flush();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    try { proc.kill(); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(1);
});
