/* ============================================================================
 *  设置页收藏夹样式验证（fav-style-probe.js）
 *
 *  r48 起口径变了：收藏夹改成**帮助页那份「目录卡」**——
 *    · .fav-group        一级目录 = 一张圆角卡（有描边；展开态挂 .open + 淡底）
 *    · .fav-group.lv2    二级目录 = 卡内正文里缩进的一块（**不是**卡，只有左侧引导线）
 *    · .fav-row          摘要行：折叠时整张卡只剩这一行（箭头 + 目录名 + 项数）
 *    · .fav-ops          操作按钮排：在卡内正文里，折叠时**不渲染**
 *    · .fav-item-line    内容行：无底无框的列表行
 *    · .fav-grip         拖拽把手：无底色盒子
 *  本探针用**计算样式 + 高度**说话（我看不到截图），并且把"折叠态 / 展开态"两遍都记下来
 *  —— 用户要的「上下宽度没有那么宽」就是 #favTree 高度这件事。
 *
 *  用法：node fav-style-probe.js
 *  输出：fav-style-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'fav-style-probe.txt');
const PORT = 9333;
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

/** 取一组选择器的关键计算样式（有没有描边 / 底色 / 圆角 = 有没有胶囊） */
const STYLE_JS = `(function(sel){
  const el = document.querySelector(sel);
  if (!el) return 'MISSING';
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return JSON.stringify({
    border: s.borderTopWidth + ' ' + s.borderLeftWidth,
    radius: s.borderTopLeftRadius,
    bg: s.backgroundColor,
    shadow: s.boxShadow === 'none' ? 'none' : 'yes',
    pad: s.paddingTop + '/' + s.paddingLeft,
    size: Math.round(r.width) + 'x' + Math.round(r.height),
  });
})`;

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-favstyle-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    /* ⚠ 这里原来是 `taskkill /IM QuickSearch.exe /T /F` —— 会把**用户自己**开着的
     * 实例一起杀掉（r47 我就是这么误伤过一次）。现在给这个探针一套自己的身份
     * （QS_INSTANCE_TAG + 独立 WebView2 数据目录），单实例锁认的是 tag，
     * 于是完全不需要杀任何别人的进程；结束时也只杀自己这棵进程树。 */
    const TAG = 'favstyle' + Date.now().toString(36);
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
    if (!barWs) { rec('横条 CDP 连不上'); proc.kill(); flush(); process.exit(0); }
    // 横条 → ⋯ 面板 → 设置…
    ctrlC();
    sleep(1500);
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(900);
    await evalJs(barWs, "document.getElementById('btnSettings').click()");
    sleep(3000);

    const setWs = await connect('settings.html');
    if (!setWs) { rec('设置页 CDP 连不上'); proc.kill(); flush(); process.exit(0); }
    rec('设置页已连上');
    // 切到「收藏夹」页
    const tabOk = await evalJs(setWs,
        "(function(){const t=document.querySelector('[data-tab=\"fav\"]'); if(!t) return 0; t.click(); return 1;})()");
    sleep(900);
    rec('切到收藏夹页：' + tabOk);
    rec('页面里收藏目录数 = ' + await evalJs(setWs,
        "document.querySelectorAll('.fav-group').length")
        + '  二级 = ' + await evalJs(setWs, "document.querySelectorAll('.fav-group.lv2').length")
        + '  内容行 = ' + await evalJs(setWs, "document.querySelectorAll('.fav-item-line').length"));

    for (const [sel, name] of [
        ['.fav-group', '目录卡（一级）'],
        ['.fav-group.open', '展开态的目录卡'],
        ['.fav-group.lv2', '二级目录容器'],
        ['.fav-group > .fav-row', '摘要行'],
        ['.fav-row .mini.fold', '折叠箭头'],
        ['.fav-grip', '拖拽把手'],
        ['.fav-count', '项数徽标'],
        ['.fav-body', '卡内正文'],
        ['.fav-ops', '操作按钮排'],
        ['.fav-item-line', '内容行'],
        ['.fav-item-line .fav-fmt', '「带格式」徽标'],
    ]) {
        rec('  ' + name.padEnd(14) + ' ' + sel + '  →  '
            + await evalJs(setWs, STYLE_JS + '(' + JSON.stringify(sel) + ')'));
    }

    /* 高度对比：这正是用户说的「上下的宽度没有那么宽」。
     * 折叠态（默认）→ 展开态各量一次 #favTree 的总高度与摘要行高度。 */
    const HEIGHT_JS = `(function(){
      const t = document.getElementById('favTree');
      if (!t) return 'MISSING';
      const cards = t.querySelectorAll('.fav-group');
      const row = t.querySelector('.fav-group > .fav-row');
      const rr = row ? row.getBoundingClientRect() : { height: 0 };
      return JSON.stringify({
        treeHeight: Math.round(t.getBoundingClientRect().height),
        cards: cards.length,
        summaryRow: Math.round(rr.height),
        itemLines: t.querySelectorAll('.fav-item-line').length,
        opsRows: t.querySelectorAll('.fav-ops').length,
        lv2: t.querySelectorAll('.fav-group.lv2').length,
      });
    })()`;
    rec('');
    rec('折叠态（默认进这一页的样子）： ' + await evalJs(setWs, HEIGHT_JS));
    await evalJs(setWs, "document.getElementById('btnFavExpandAll').click()");
    sleep(600);
    rec('点「全部展开」之后：           ' + await evalJs(setWs, HEIGHT_JS));
    rec('（展开/折叠按钮功能是否还在：' + await evalJs(setWs,
        "!!document.getElementById('btnFavCollapseAll')") + '）');
    flush();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
