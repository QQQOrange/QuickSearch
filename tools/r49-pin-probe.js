/* ============================================================================
 *  r49 钉住面板 → 横条玻璃必须一起消失（r49-pin-probe.js）
 *
 *  用户报的 bug（原话）：
 *    「通过横条打开更多引擎，然后点击任意一个收藏夹之后，点击钉住，这之后横条
 *      里面的图标都不见了，但是横条却又存在。」
 *
 *  根因（代码层）：钉住只做了 `barEl.classList.toggle('ghost', true)`，
 *  而 `.bar.ghost` 是 `visibility: hidden` —— **只藏了 DOM**。横条那块玻璃是
 *  画在 `<canvas>` 上的（glass.js 的 `drawBox(barEl, rect)` 按元素的
 *  getBoundingClientRect 出玻璃，visibility 不改变盒子），于是画布上还端端正正
 *  留着一条玻璃：图标没了、横条还在。修法 = 挂/摘 `.ghost` 的同时调
 *  `QSGlass.setBarGhost(on)`，它把画布 `gl.clear` 成全透明并停掉实时抓屏。
 *
 *  本探针走**用户那条真实路径**（横条 → ⋯ → 收藏目录 → 📌 钉住），然后查三件事：
 *    ① .bar 上有没有 .ghost；
 *    ② QSGlass.isBarGhost() 是不是 true（玻璃层真的收到了通知）；
 *    ③ stats.ghostClears 有没有增加（画布**真的被擦过** —— 这条才是"横条不再空壳"）。
 *  再取消钉住，验证两边一起复位。
 *
 *  用法：node r49-pin-probe.js     输出：r49-pin-probe.txt
 *  ⚠ 自带身份（QS_INSTANCE_TAG + 独立 WebView2 目录），不杀任何别人的进程。
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r49-pin-probe.txt');
const PORT = 9341;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra ? '   [' + extra + ']' : '')); }
}

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

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-pin-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    {
        // 用真配置（收藏夹目录照旧），但**强制打开液态玻璃** —— 这条 bug 只在
        // 玻璃样式下看得见（没有画布就没有"空壳"）。
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        c.bar_style = 'glass';
        c.bar_glass = true;
        c.bar_glass_live = false;   // 实时抓屏关掉：本探针只看"擦画布"这件事
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const TAG = 'pin' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: TAG,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('r49 钉住探针：启动 pid=' + proc.pid);
    sleep(9000);
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(400);

    const barWs = await connect('tauri.localhost/');
    if (!barWs) { rec('横条 CDP 连不上'); proc.kill(); flush(); process.exit(1); }

    // 把横条叫出来（Ctrl+C 老路子），等玻璃层就绪
    ctrlC();
    sleep(2500);
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
        ready = (await evalJs(barWs,
            "(window.QSGlass && QSGlass.debugInfo && QSGlass.debugInfo().ready) === true")) === true;
        if (!ready) sleep(500);
    }
    rec('玻璃层就绪 = ' + ready + '   （debugInfo=' + await evalJs(barWs,
        "(window.QSGlass && QSGlass.debugInfo) ? JSON.stringify(QSGlass.debugInfo().stats) : 'no-QSGlass'") + '）');
    if (!ready) { rec('⚠ 玻璃层没就绪（显卡/环境问题），本探针只能跳过'); proc.kill(); flush(); process.exit(0); }

    // ① 走用户那条路：⋯ → 收藏目录 → 收藏面板
    const flow = await evalJs(barWs, `(function(){
      const more = document.getElementById('btnMore');
      if (more) more.click();
      return more ? 'more-clicked' : 'no-more';
    })()`);
    rec('打开「更多引擎」：' + flow);
    sleep(1200);
    const favOpen = await evalJs(barWs, `(function(){
      // ① 横条上直接有收藏格子（config 的 bar_list 里有 @fav: 哨兵）→ 点它
      //    ⚠ 属性名是 data-fav（见 bar.js 里 b.dataset.fav = name），不是 data-id
      const cell = document.querySelector('[data-fav^="@fav:"]')
                || document.querySelector('[data-id^="@fav:"]')
                || document.querySelector('[data-engine^="@fav:"]')
                || document.querySelector('[data-sentinel^="@fav:"]');
      if (cell) { cell.click(); return 'bar-cell:' + (cell.dataset.fav || cell.dataset.id || ''); }
      // ② 否则在「更多引擎」面板里找收藏目录（用户的原始路径）
      const card = document.querySelector('.fav-grp[data-named="1"] .fav-grp-head')
                || document.querySelector('.fav-grp[data-named="1"]')
                || document.querySelector('.fav-grp-head')
                || document.querySelector('[data-fav-id]');
      if (!card) return 'no-fav-card';
      card.click();
      return 'fav-card-clicked';
    })()`);
    rec('点一个收藏目录：' + favOpen);
    sleep(1500);
    const hasPin = await evalJs(barWs, "!!document.querySelector('.fav-pin')");
    rec('收藏面板里的图钉 = ' + hasPin);

    const before = await evalJs(barWs,
        "(window.QSGlass ? QSGlass.debugInfo().stats.ghostClears : -1)");
    const ghostBefore = await evalJs(barWs, "document.getElementById('bar').classList.contains('ghost')");
    check('钉住前：横条不是隐身态（画布在画玻璃）', ghostBefore === false && before === 0,
        'ghost=' + ghostBefore + ' clears=' + before);

    // ② 点「钉住」（真实按钮；找不到就退回同一对调用，输出里写清楚）
    let how = 'button';
    if (hasPin) {
        await evalJs(barWs, "document.querySelector('.fav-pin').click()");
    } else {
        how = 'fallback-call';
        await evalJs(barWs, `(function(){
          document.getElementById('bar').classList.add('ghost');
          if (window.QSGlass && QSGlass.setBarGhost) QSGlass.setBarGhost(true);
        })()`);
    }
    sleep(900);
    const stats1 = await evalJs(barWs,
        "(window.QSGlass ? JSON.stringify(QSGlass.debugInfo().stats) : 'no-QSGlass')");
    const s1 = JSON.parse(stats1);
    const ghostOn = await evalJs(barWs, "document.getElementById('bar').classList.contains('ghost')");
    const flagOn = await evalJs(barWs, "window.QSGlass ? QSGlass.isBarGhost() : null");
    rec('钉住后（走了 ' + how + '）：stats=' + stats1);
    check('钉住后：.bar 挂上了 .ghost', ghostOn === true);
    check('钉住后：玻璃层知道横条隐身了（QSGlass.isBarGhost()）', flagOn === true);
    check('钉住后：画布**真的被擦过**（ghostClears 增加 —— 这条才是"横条不再空壳"）',
        s1.ghostClears > before, 'clears=' + s1.ghostClears);

    // ③ 取消钉住 → 两边一起复位
    if (how === 'button') {
        await evalJs(barWs, "document.querySelector('.fav-pin').click()");
    } else {
        await evalJs(barWs, `(function(){
          document.getElementById('bar').classList.remove('ghost');
          if (window.QSGlass && QSGlass.setBarGhost) QSGlass.setBarGhost(false);
        })()`);
    }
    sleep(900);
    const ghostOff = await evalJs(barWs, "document.getElementById('bar').classList.contains('ghost')");
    const flagOff = await evalJs(barWs, "window.QSGlass ? QSGlass.isBarGhost() : null");
    check('取消钉住：.ghost 摘掉了', ghostOff === false);
    check('取消钉住：玻璃层跟着复位', flagOff === false);

    /* ④ 接线静态复核：运行时如果没能点到真图钉（收藏面板没打开），至少要证明
     *    **两处挂/摘 .ghost 的地方都同步调了玻璃层** —— 这个 bug 的本质就是
     *    "只改 class、没通知玻璃"，所以这条断言直指根因。 */
    try {
        const src = fs.readFileSync(path.join(ROOT, 'ui', 'bar.js'), 'utf8');
        const toggleIdx = src.indexOf("classList.toggle('ghost'");
        const removeIdx = src.indexOf("classList.remove('ghost'");
        const near = (i) => (i < 0 ? '' : src.slice(i, i + 400));
        check('接线复核：点「钉住」那处挂 .ghost 的旁边调了 QSGlass.setBarGhost',
            toggleIdx >= 0 && near(toggleIdx).indexOf('setBarGhost') >= 0,
            'how=' + how);
        check('接线复核：面板复位那处摘 .ghost 的旁边也调了 QSGlass.setBarGhost',
            removeIdx >= 0 && near(removeIdx).indexOf('setBarGhost') >= 0,
            'how=' + how);
    } catch (e) {
        check('接线复核：能读到 ui/bar.js', false, String(e));
    }

    rec('');
    rec('========== 汇总：PASS ' + pass + ' / FAIL ' + fail + ' ==========');
    flush();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    try { proc.kill(); } catch (e) { }
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(1);
});
