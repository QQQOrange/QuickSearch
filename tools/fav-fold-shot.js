/* ============================================================================
 *  收藏夹折叠 · 视觉取证（截图）
 *
 *  数值判定（tools/fav-fold-probe.js）已经全过，但"箭头长什么样、折起来观感对不对"
 *  这类事只有看图才知道。这里在临时实例里逐帧截图：
 *    01 单目录视图 · 全展开
 *    02 单目录视图 · 折掉「二级甲」 （箭头该朝右、标题下那条线该消失）
 *    03 根视图 · 全展开（一级/二级都有开关）
 *    04 根视图 · 折掉「测试一级」
 *
 *  截图走 CDP 的 Page.captureScreenshot（captureBeyondViewport + clip）——
 *  探针跑的时候横条窗口可能已经被"点外面收起"收掉了，窗口尺寸不再跟着面板长，
 *  普通截屏会把面板裁掉半截；captureBeyondViewport 直接按内容截，不受窗口限制。
 *
 *  用法：node tools/fav-fold-shot.js
 *  输出：tools/_fold-01.png … _fold-04.png
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9338;
const TAG = '-probe-foldshot';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; const rec = (s) => { L.push(s); console.log(s); };

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
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
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

/** 截「整页内容」（不受窗口大小限制）+ 报告面板/内容几何 */
async function shot(ws, file) {
    const geo = await evalJs(ws, `(function(){
      var b = document.body, d = document.documentElement;
      var p = document.getElementById('panel');
      var r = p ? p.getBoundingClientRect() : null;
      return { w: Math.max(b.scrollWidth, d.scrollWidth), h: Math.max(b.scrollHeight, d.scrollHeight),
               panel: r ? [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] : null,
               dpr: window.devicePixelRatio || 1 };
    })()`);
    const r = await cdp(ws, 'Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: geo.w, height: geo.h, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    rec('  → ' + path.basename(file) + '  内容 ' + geo.w + 'x' + geo.h
        + ' 面板 ' + JSON.stringify(geo.panel) + ' dpr=' + geo.dpr);
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-foldshot-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const mkItem = (id, t, r) => ({ id, kind: 'text', text: t, html: '', image: '', remark: r });
    const sub = (id, name, n) => ({
        id, name, icon: '',
        items: Array.from({ length: n }, (_, i) => mkItem(id + 'i' + i, name + ' 的内容 ' + (i + 1), '备注' + (i + 1))),
        children: [],
    });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        c.trigger_select = false; c.trigger_copy = false; c.ocr_enable = false; c.auto_start = false;
        c.fav_panel_sizes = {};
        c.favorites = [
            {
                id: 'pg1', name: '测试一级', icon: '',
                items: [mkItem('pi1', '一级内容 A —— 一段用来看看折叠观感的文字', '一级备注')],
                children: [sub('pc1', '二级甲', 4), sub('pc2', '二级乙', 3)],
            },
            { id: 'pg2', name: '只有子目录', icon: '', items: [], children: [sub('pc3', '二级丙', 3)] },
        ];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(300);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上'); try { proc.kill(); } catch (e) { } fs.writeFileSync(path.join(__dirname, 'fav-fold-shot.txt'), L.join('\n')); process.exit(0); }
    await cdp(ws, 'Page.enable');

    // 让面板有个像样的底：把窗口本身拉大一点（免得 captureBeyondViewport 之外还有干扰）
    rec('单目录视图（二级带头）');
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(800);
    await evalJs(ws, "(function(){var b=document.querySelector('#panelBody .fav-entry'); if(b) b.click();})()");
    sleep(1500);
    await shot(ws, path.join(__dirname, '_fold-01-lv2-open.png'));
    await evalJs(ws, CLICK('.fav-grp.lv2', 0));
    sleep(800);
    await shot(ws, path.join(__dirname, '_fold-02-lv2-folded.png'));

    rec('根视图（一级 + 二级都有开关）');
    await evalJs(ws, "(function(){ try { openFavPanel(); } catch(e) { panelFav='root'; togglePanel(true); } })()");
    sleep(1500);
    await shot(ws, path.join(__dirname, '_fold-03-root-open.png'));
    await evalJs(ws, CLICK('.fav-grp', 0));
    sleep(800);
    await shot(ws, path.join(__dirname, '_fold-04-root-lv1-folded.png'));

    fs.writeFileSync(path.join(__dirname, 'fav-fold-shot.txt'), L.join('\n'), 'utf8');
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    fs.writeFileSync(path.join(__dirname, 'fav-fold-shot.txt'), L.join('\n'), 'utf8');
    process.exit(0);
});

function CLICK(sel, idx) {
    return `(function(){
      var g = document.querySelectorAll(${JSON.stringify(sel)})[${idx}];
      if (!g) return null;
      var h = g.querySelector(':scope > .fav-grp-head');
      if (!h) return 'NO_HEAD';
      h.click();
      return g.className;
    })()`;
}
