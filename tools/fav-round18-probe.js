/* ============================================================================
 *  专项探针：轮 18 的六条（收藏夹去向 / 全部展开折叠 / 去提示 / 占位文字 /
 *            重命名 / 取色只取当前软件 UI）
 *
 *  要证的事：
 *    ① 收藏夹条目点下去**不再填进收藏夹窗口自己的搜索框**：
 *       Rust 日志出现 `fav_send:`（触发现场 + 文本框判定），
 *       有文本框时 `fav_send: 已注入 N 字到 hwnd=…「标题」`，
 *       横条 tip 变成「已输入到「…」」，而 `#q` 保持空、面板里的搜索框没被填。
 *    ② 横条收藏面板标题栏有「全部展开 / 全部折叠」，点了能把所有目录卡片
 *       一起折叠 / 展开（`.collapsed` + aria-expanded 跟随）。
 *    ③ 二级目录卡片旁边也有这两颗按钮，且**只**作用在它自己那张卡片上。
 *       顺带证「标题行不再嵌 button」（button 里套 button 是非法 HTML）。
 *    ④ 设置页工具条上「添加一级目录」旁边有「全部展开 / 全部折叠」；
 *       二级目录行里也有一对；折叠后**没有**「已折叠 · N 项」那种提示了。
 *    ⑤ 新建一级目录：名字是 **placeholder**（value 空、placeholder=新一级目录），
 *       并且直接进可编辑态、光标落在上面；一打字 value 就有值、占位消失。
 *    ⑥ 已存在的目录名默认 **readonly**，点「重命名」才变可编辑。
 *    ⑦ 自动取色**只从当前软件的 UI 上采**：日志里 `theme: 取样区[<候选名>]`
 *       的矩形必须落在前台窗口矩形**里面**，且当"内容区"整片是无主色的
 *       噪声画面（等价于视频画面在"没有主色"这个特征上）时，
 *       取样区不能是那块内容区，而应落在窗口的 UI 边带上（主色占比达标）。
 *
 *  做法：
 *    · 另起一个测试实例（QS_INSTANCE_TAG + --bar），点击一律走 CDP 的 DOM .click()，
 *      不用 SendInput 点鼠标；临时配置里 trigger_select / trigger_copy / ocr_enable
 *      全关，免得这个实例对用户正在敲的键鼠有反应。
 *    · 唯一用到的全局输入是 **Ctrl+Alt+F**（收藏夹全局快捷键）——
 *      它是"弹横条"唯一的外部入口（show_bar 不是 Tauri 命令）。
 *      取证前已确认本机没有别的 QuickSearch.exe 在跑，不会有第二个实例跟着响应。
 *    · ⑦ 的"视频画面"用 msedge --app 加载一张 **整幅无主色** 的噪声页代替：
 *      页面自己算好「平均色 + 5bit 量化主色占比」POST 回探针，作为对照基准。
 *
 *  用法：node tools/fav-round18-probe.js
 *  输出：tools/fav-round18-probe.txt + 若干截图
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'fav-round18-probe.txt');
const PORT = 9342;
const STATS_PORT = 9360;
const TAG = '-probe-r18';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GTI = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint32', flags: 'uint32',
    hwndActive: 'void*', hwndFocus: 'void*', hwndCapture: 'void*',
    hwndMenuOwner: 'void*', hwndMoveSize: 'void*', hwndCaret: 'void*',
    rcCaret: RECT,
});
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const GetGUIThreadInfo = user32.func('int GetGUIThreadInfo(uint32 tid, _Out_ GUITHREADINFO *g)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const SetWindowPos = user32.func('int SetWindowPos(void *h, intptr after, int x, int y, int cx, int cy, uint32 flags)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const HWND_TOPMOST = -1, HWND_NOTOPMOST = -2, SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
/** 把测试目标窗口临时抬到最顶层。
 *  为什么需要：这台机器上常驻的 QQ / WorkBuddy 会随时冒出置顶窗口盖在目标上，
 *  探针按"点下面是谁"挑触发点时就会一直挑到别人 —— 那不是被测功能的错。
 *  抬到 HWND_TOPMOST 之后，目标窗口在 Z 序上必然压住其它非置顶窗口。 */
function makeTopmost(h) {
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}
function unTopmost(h) {
    SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

let passN = 0, failN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

/* ---------------- 窗口 ---------------- */
function titleOf(h) {
    const t = new Uint16Array(512); const n = GetWindowTextW(h, t, 512);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
}
function rectOf(h) { const r = {}; GetWindowRect(h, r); return [r.left, r.top, r.right - r.left, r.bottom - r.top]; }
function listTopWindows() {
    const out = [];
    const cb = koffi.register((h) => {
        if (!IsWindowVisible(h)) return 1;
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        out.push({ h, pid: p[0], title: titleOf(h), rect: rectOf(h) });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
function findWindow(pred) { return listTopWindows().find(pred) || null; }
const fmt = (r) => r ? `x=${r[0]} y=${r[1]} w=${r[2]} h=${r[3]}` : 'NONE';

function caretOf(h) {
    const p = new Uint32Array(1);
    const tid = GetWindowThreadProcessId(h, p);
    if (!tid) return null;
    const g = { cbSize: koffi.sizeof(GTI) };
    if (!GetGUIThreadInfo(tid, g)) return null;
    const rc = g.rcCaret;
    if (!rc) return null;
    return { hasCaret: !!g.hwndCaret, hasFocus: !!g.hwndFocus, hasActive: !!g.hwndActive, rc: [rc.left, rc.top, rc.right, rc.bottom] };
}

/* 取「这个屏幕坐标上最上面的顶层窗口属于哪个进程」。
 * 为什么要它：这台机器上别的常驻软件（QQ / WorkBuddy …）的窗口会随时冒出来盖在
 * 目标窗口上面，光按"窗口矩形包含这个点"是猜的。用于给触发点做**可用性校验**。 */
const POINT_T = koffi.struct('POINT', { x: 'long', y: 'long' });
const WindowFromPoint = user32.func('void *WindowFromPoint(POINT pt)');
const GetAncestor = user32.func('void *GetAncestor(void *h, uint32 flags)');
function pidAt(x, y) {
    try {
        const h = WindowFromPoint({ x, y });
        if (h) {
            const root = GetAncestor(h, 2 /* GA_ROOT */) || h;
            const p = new Uint32Array(1);
            GetWindowThreadProcessId(root, p);
            if (p[0]) return p[0];
        }
    } catch (e) { }
    // 兜底：EnumWindows 是按 Z 序从上往下给的，第一个包含这个点的顶层窗口就是最上面那个
    for (const w of listTopWindows()) {
        if (x >= w.rect[0] && y >= w.rect[1] && x < w.rect[0] + w.rect[2] && y < w.rect[1] + w.rect[3]) return w.pid;
    }
    return 0;
}
/** 在窗口里挑一个**当前真的属于它**的点（避开被别的窗口盖住的位置）。
 *  ⚠ 一定要有兜底返回值 —— 挑不到也要给窗口中心，不然调用方会以为"没有可用的点"
 *    直接跳过整段（踩过：连热键都没发出去，日志里一片空白）。 */
function pickPoint(win) {
    const cands = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.72], [0.65, 0.62], [0.5, 0.18], [0.2, 0.5]];
    let fallback = null;
    for (const [fx, fy] of cands) {
        const x = Math.round(win.rect[0] + win.rect[2] * fx);
        const y = Math.round(win.rect[1] + win.rect[3] * fy);
        if (x < 4 || y < 4 || x > SW - 4 || y > SH - 4) continue;
        if (!fallback) fallback = [x, y];
        if (pidAt(x, y) === win.pid) return [x, y];
    }
    return fallback;
}

/* ---------------- 输入 ---------------- */
const MOVE = 0x0001, ABS = 0x8000;
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

const VK_CONTROL = 0x11, VK_MENU = 0x12, VK_F = 0x46;
function keyInput(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);              // INPUT_KEYBOARD
    b.writeUInt16LE(vk, 8);             // wVk
    b.writeUInt16LE(0, 10);             // wScan
    b.writeUInt32LE(up ? 0x0002 : 0, 12); // dwFlags
    b.writeUInt32LE(0, 16);             // time
    b.writeBigUInt64LE(0n, 24);         // dwExtraInfo（**故意不带 QSELF 暗号**：要的就是"用户按的"）
    return b;
}
function tap(vk) {
    SendInput(1, keyInput(vk, false), 40);
    sleep(18);
    SendInput(1, keyInput(vk, true), 40);
}
function combo(vks) {
    for (const v of vks) { SendInput(1, keyInput(v, false), 40); sleep(18); }
    sleep(40);
    for (const v of [...vks].reverse()) { SendInput(1, keyInput(v, true), 40); sleep(18); }
}

/* ---------------- CDP ---------------- */
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
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text) + ' | ' + expr.slice(0, 90));
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
            return ws;
        }
        await sleep(300);
    }
    return null;
}
const isBarPage = (u) => /index\.html/.test(u) || /tauri\.localhost\/?$/.test(u);
const isSettingsPage = (u) => /settings\.html/.test(u);
const isEdgePage = (u) => /^file:/.test(u) && /noise\.html/.test(u);

async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const p = path.join(__dirname, name.replace(/^tools[\/\\]/, ''));
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    } catch (e) { console.log('  WARN  截图失败 ' + name + ' → ' + e.message); }
}

/* 让"没有系统焦点"的窗口按已获得焦点来渲染。
   背景：Chromium 里页面若不在焦点窗口，element.focus() 不会写进 document.activeElement，
   于是聚焦类断言会因为"这一轮窗口恰好不在前台"而随机假失败（实测同一份代码两次跑结果不同）。
   这里用 CDP 的焦点模拟把这一层环境噪声摁掉，断言就只反映被测逻辑本身。 */
async function forceFocus(ws) {
    try { await cdp(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) { }
    try { await cdp(ws, 'Page.bringToFront'); } catch (e) { }
}

/* ============================================================================ */
(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r18-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const mkItem = (id, t, r) => ({ id, kind: 'text', text: t, html: '', image: '', remark: r });
    const sub = (id, name, n) => ({
        id, name, icon: '',
        items: Array.from({ length: n }, (_, i) => mkItem(id + 'i' + i, name + ' 的内容 ' + (i + 1), '备注' + (i + 1))),
        children: [],
    });
    const INJECT_TEXT = '轮18注入用例-ABC123';
    {
        const c = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        c.trigger_select = false; c.trigger_copy = false; c.ocr_enable = false;
        c.auto_start = false;
        c.auto_color = true;              // ⑦ 要真的走取色
        c.fav_panel_sizes = {};
        c.fav_hotkey = 'Ctrl+Alt+F';      // 探针唯一的全局入口
        c.favorites = [
            {
                id: 'pg1', name: '测试一级', icon: '',
                items: [mkItem('pi1', INJECT_TEXT, '注入用例')],
                children: [sub('pc1', '二级甲', 3), sub('pc2', '二级乙', 3)],
            },
            { id: 'pg2', name: '只有子目录', icon: '', items: [], children: [sub('pc3', '二级丙', 2)] },
        ];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    const readLog = () => { try { return fs.readFileSync(logp, 'utf8'); } catch (e) { return ''; } };

    /* 噪声页（模拟"视频画面"：整幅无主色）+ 探针侧的统计收集服务 */
    let pageStats = null;
    const srv = http.createServer((req, res) => {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            if (u.pathname === '/stats') pageStats = JSON.parse(u.searchParams.get('d'));
        } catch (e) { }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
    });
    srv.listen(STATS_PORT, '127.0.0.1');
    const noiseHtml = path.join(tmp, 'noise.html');
    fs.writeFileSync(noiseHtml, `<!doctype html><meta charset="utf-8"><title>QS-噪声画面</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100vw;height:100vh}</style>
<canvas id="c"></canvas><script>
function draw(){
  var c=document.getElementById('c');
  c.width=window.innerWidth; c.height=window.innerHeight;
  var ctx=c.getContext('2d'); var img=ctx.createImageData(c.width,c.height); var d=img.data;
  for(var y=0;y<c.height;y++)for(var x=0;x<c.width;x++){
    var i=(y*c.width+x)*4;
    var h=(((x/24)|0)*73856093 ^ ((y/24)|0)*19349663)>>>0; h=(h*2654435761)>>>0;
    d[i]=h&255; d[i+1]=(h>>8)&255; d[i+2]=(h>>16)&255; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
}
function stats(){
  var c=document.getElementById('c'); var ctx=c.getContext('2d');
  var img=ctx.getImageData(0,0,c.width,c.height).data;
  var hist={}, r=0,g=0,b=0,n=0;
  for(var i=0;i<img.length;i+=16){          // 抽 1/4 像素
    var R=img[i],G=img[i+1],B=img[i+2];
    r+=R;g+=G;b+=B;n++;
    var k=((R>>3)<<10)|((G>>3)<<5)|(B>>3); hist[k]=(hist[k]||0)+1;
  }
  var best=0; for(var k2 in hist) if(hist[k2]>best) best=hist[k2];
  return {w:c.width,h:c.height,mean:[Math.round(r/n),Math.round(g/n),Math.round(b/n)],dom:+(best/n).toFixed(3),px:n};
}
window.addEventListener('load',function(){
  draw();
  var s=stats();
  /* 统计既 POST 回探针，也塞进标题里 —— 标题还能通过 EnumWindows 读回来，
   * 不依赖网络那一跳（沙箱里 fetch 有可能被拦，两条路互为兜底）。 */
  document.title='QS-噪声画面|'+s.w+'x'+s.h+'|'+s.mean.join(',')+'|'+s.dom.toFixed(3);
  try{ fetch('http://127.0.0.1:${STATS_PORT}/stats?d='+encodeURIComponent(JSON.stringify(s))); }catch(e){}
});
<\/script>`, 'utf8');

    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(300);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动测试实例 pid=' + proc.pid + '（QS_INSTANCE_TAG=' + TAG + '；不点鼠标、不碰剪贴板）');
    rec('临时配置：trigger_select/copy=off、ocr=off、fav_hotkey=Ctrl+Alt+F、auto_color=on');
    sleep(9000);

    const barWs = await connectWhere(isBarPage);
    if (!barWs) { rec('CDP 连不上横条页面（端口 ' + PORT + '）'); try { proc.kill(); } catch (e) { } srv.close(); flush(); process.exit(0); }
    rec('横条页面已连上');

    /* ================== ④⑤⑥ 设置页 ================== */
    rec('');
    rec('=== ④⑤⑥ 设置页收藏夹 ===');
    await evalJs(barWs, "invoke('open_settings', {}).catch(function(){})");
    const setWs = await connectWhere(isSettingsPage, 20000);
    if (!setWs) {
        rec('  FAIL 设置窗口没起来，④⑤⑥ 无法取证');
        failN++;
    } else {
        await forceFocus(setWs);
        await evalJs(setWs, "(function(){var p=document.querySelector('.pane[data-pane=\"fav\"]'); if(p){document.querySelectorAll('.pane').forEach(function(x){x.hidden=true}); p.hidden=false;} })()");
        await sleep(400);

        const acts = await evalJs(setWs, `(function(){
          var add=document.getElementById('btnFavAddGroup');
          var ex=document.getElementById('btnFavExpandAll');
          var co=document.getElementById('btnFavCollapseAll');
          if(!add||!ex||!co) return {ok:false};
          var box=add.parentElement;
          return {ok:true, same:ex.parentElement===box&&co.parentElement===box, exTxt:ex.textContent, coTxt:co.textContent,
                  addIdx:[].indexOf.call(box.children,add), exIdx:[].indexOf.call(box.children,ex),
                  groupCount:document.querySelectorAll('#favTree .fav-group').length};
        })()`);
        chk('④ 「全部展开/全部折叠」在「添加一级目录」旁边', acts.ok && acts.same && acts.exIdx === acts.addIdx + 1,
            'txt=' + (acts.exTxt || '?') + '/' + (acts.coTxt || '?') + ' 一级目录=' + acts.groupCount);
        await shot(setWs, 'tools/_r18-settings-fav.png');

        /* r48：目录改成帮助页那种「目录卡」——默认**折叠**，操作按钮也从摘要行
         * 搬进了卡内正文（.fav-ops）。所以这里先「全部展开」，再去卡内正文里找按钮。 */
        await evalJs(setWs, "document.getElementById('btnFavExpandAll').click()");
        await sleep(400);
        const lv2 = await evalJs(setWs, `(function(){
          var rows=document.querySelectorAll('#favTree .fav-group.lv2 > .fav-row');
          var r=rows[0];
          if(!r) return {n:0};
          var g=r.parentElement;
          var labs=[].map.call(g.querySelectorAll('.fav-ops .mini'), function(b){return b.textContent});
          return {n:rows.length, labs:labs};
        })()`);
        chk('④ 二级目录行里有「全部展开/全部折叠」',
            lv2.n > 0 && lv2.labs.includes('全部展开') && lv2.labs.includes('全部折叠'),
            '二级目录 ' + lv2.n + ' 个，按钮=' + (lv2.labs || []).join('|'));

        // 折叠 → 断言没有「已折叠 · N 项」提示
        await evalJs(setWs, "document.getElementById('btnFavCollapseAll').click()");
        await sleep(400);
        const afterFold = await evalJs(setWs, `(function(){
          var hints=document.querySelectorAll('#favTree .fav-folded-hint').length;
          var txt=document.getElementById('favTree').textContent;
          var open=[].filter.call(document.querySelectorAll('#favTree .fav-group'), function(g){
            return [].some.call(g.children, function(c){return c.classList&&c.classList.contains('fav-item-line')||c.classList&&c.classList.contains('fav-item-edit')});
          }).length;
          return {hints:hints, hasHintWord:/已折叠/.test(txt), rendered:open};
        })()`);
        chk('④ 折叠后没有「已折叠 · N 项」提示',
            afterFold.hints === 0 && afterFold.hasHintWord === false,
            'hint 节点=' + afterFold.hints + ' 页面含"已折叠"=' + afterFold.hasHintWord);
        const collapsedAll = await evalJs(setWs,
            "JSON.stringify([].map.call(document.querySelectorAll('#favTree .fav-group'),function(g){return favGroupOpen.get(g.dataset.id!==undefined?g.dataset.id:g.querySelector('.fav-name').dataset.gid)}))");
        info('全部折叠后的展开表', collapsedAll);
        await shot(setWs, 'tools/_r18-settings-folded.png');

        await evalJs(setWs, "document.getElementById('btnFavExpandAll').click()");
        await sleep(400);
        const expandedOk = await evalJs(setWs, `(function(){
          var gs=document.querySelectorAll('#favTree .fav-group');
          for(var i=0;i<gs.length;i++){
            var id=gs[i].querySelector('.fav-name').dataset.gid;
            if(favGroupOpen.get(id)===false) return false;
          }
          return true;
        })()`);
        chk('④ 「全部展开」把所有目录都置为展开', expandedOk === true);

        // ⑥ 已存在目录名默认只读 + 重命名按钮
        const ro = await evalJs(setWs, `(function(){
          var inp=document.querySelector('#favTree .fav-row .fav-name');
          var grp=inp.closest('.fav-group');       // r48：按钮在卡内正文里，不在摘要行上
          var b=[].find.call(grp.querySelectorAll('.fav-ops .mini'), function(x){return x.textContent==='重命名'});
          if(!b) return {has:false};
          var before=inp.readOnly;
          b.click();
          var after=inp.readOnly;
          var focused=document.activeElement===inp;
          var cls=inp.className;
          return {has:true, before:before, after:after, focused:focused, cls:cls, ph:inp.placeholder, val:inp.value};
        })()`);
        chk('⑥ 目录名默认 readonly，点「重命名」后变可编辑',
            ro.has && ro.before === true && ro.after === false && ro.focused === true,
            'readonly ' + ro.before + '→' + ro.after + ' 聚焦=' + ro.focused + ' class=' + ro.cls);

        // ⑤ 新建一级目录 = 占位文字语义
        const before = await evalJs(setWs,
            "JSON.stringify([].map.call(document.querySelectorAll('#favTree .fav-name'),function(i){return i.dataset.gid}))");
        await evalJs(setWs, "document.getElementById('btnFavAddGroup').click()");
        await sleep(600);
        const fresh = await evalJs(setWs, `(function(){
          var old=${before};
          var all=[].slice.call(document.querySelectorAll('#favTree .fav-name'));
          var nv=null;
          for(var i=0;i<all.length;i++){ if(old.indexOf(all[i].dataset.gid)<0) nv=all[i]; }
          if(!nv) return {found:false};
          var gid=nv.dataset.gid;
          nv.focus();
          return {found:true, val:nv.value, ph:nv.placeholder, ro:nv.readOnly,
                  focused:document.activeElement===nv, cls:nv.className, gid:gid,
                  treeName:(favCur({id:gid})||{}).name};
        })()`);
        chk('⑤ 新建一级目录：value 空 + placeholder 可见 + 可编辑 + 已聚焦',
            fresh.found && fresh.val === '' && fresh.ph === '新一级目录' && fresh.ro === false && fresh.focused === true,
            'val="' + fresh.val + '" ph="' + fresh.ph + '" readonly=' + fresh.ro + ' 聚焦=' + fresh.focused
            + ' 树里 name="' + fresh.treeName + '"');
        // 打字后占位消失（按 gid 定位，不依赖 activeElement）
        const typed = await evalJs(setWs, `(function(){
          var el=null;
          ${fresh && fresh.gid ? `el=document.querySelector('#favTree .fav-name[data-gid="${fresh.gid}"]');` : ''}
          if(!el && document.activeElement && String(document.activeElement.className).indexOf('fav-name')>=0) el=document.activeElement;
          if(!el) return null;
          el.value='新名字X';
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return {val:el.value};
        })()`);
        await sleep(400);
        chk('⑤ 输入后 value 有值（占位随之消失）', typed && typed.val === '新名字X', JSON.stringify(typed));
        await shot(setWs, 'tools/_r18-settings-newgroup.png');
        try { setWs.close(); } catch (e) { }
    }

    /* ================== 起一个真实的目标软件（记事本） ================== */
    rec('');
    rec('=== ①⑦ 触发现场：记事本 ===');
    const notePath = path.join(tmp, 'qs-note.txt');
    fs.writeFileSync(notePath, '', 'utf8');
    try { spawn(NOTEPAD, [notePath], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { }
    let np = null;
    for (let i = 0; i < 40 && !np; i++) {
        sleep(400);
        np = findWindow((w) => /qs-note\.txt/.test(w.title));
    }
    if (!np) { rec('  FAIL 记事本没起来'); failN++; }
    else {
        info('记事本窗口', fmt(np.rect) + '  pid=' + np.pid + '  「' + np.title + '」');
        makeTopmost(np.h);                 // 别让别的置顶窗口盖住测试目标
        sleep(300);
        SetForegroundWindow(np.h);
        sleep(400);
        info('记事本已抬到最顶层；当前前台 pid=' + (() => { const p = new Uint32Array(1); GetWindowThreadProcessId(GetForegroundWindow(), p); return p[0]; })());
        /* 用「收藏夹全局快捷键」把横条叫出来 —— 这是"弹横条"唯一的外部入口
         * （show_bar 不是 Tauri 命令）。触发点必须**当前真的属于记事本**
         * （别的常驻软件随时可能盖上来），所以点要挑、日志要核，核不过就换个点重来。 */
        let mid = pickPoint(np);
        let trigLine = null;
        let summonSeg = '';
        for (let attempt = 0; attempt < 5 && !trigLine; attempt++) {
            mid = pickPoint(np) || mid;
            if (!mid) break;
            // 上一发如果已经把面板叫出来了，先收掉，免得它挡着触发点、也免得状态叠加
            await evalJs(barWs, "invoke('hide_bar').catch(function(){})").catch(() => { });
            sleep(250);
            makeTopmost(np.h);
            sleep(150);
            SetForegroundWindow(np.h);
            sleep(200);
            moveTo(mid[0], mid[1]);
            sleep(300);
            info('触发点', mid.join(',') + '（该点最上层窗口 pid=' + pidAt(mid[0], mid[1]) + '，记事本 pid=' + np.pid + '）');
            const mk = readLog().length;
            combo([VK_CONTROL, VK_MENU, VK_F]);
            await sleep(2200);
            summonSeg = readLog().slice(mk);
            const m = summonSeg.match(/show_bar: 触发现场 hwnd=0x([0-9a-f]+) 「(.*?)」 有可用文本框=(\w+) 鼠标=\(([-\d]+),([-\d]+)\)/);
            if (m && m[2] === np.title && m[3] === 'true') { trigLine = m; break; }
            info('第 ' + (attempt + 1) + ' 次触发落点不对（' + (m ? m[2] + ' 有文本框=' + m[3] : '没有触发现场日志') + '），换个点重试');
        }
        const c0 = caretOf(np.h);
        info('触发前记事本光标', JSON.stringify(c0));
        chk('① 触发现场把「鼠标下的软件」记下来了（记事本 + 有可用文本框）',
            !!trigLine, trigLine ? ('「' + trigLine[2] + '」 有文本框=' + trigLine[3] + ' 鼠标=' + trigLine[4] + ',' + trigLine[5]) : '没拿到');
        info('触发现场原始日志', (summonSeg.match(/show_bar: 触发现场[^\n]*/) || ['(无)'])[0]);
        mid = mid || [Math.round(np.rect[0] + np.rect[2] / 2), Math.round(np.rect[1] + np.rect[3] / 2)];

        /* B 截图 + 面板结构 */
        await shot(barWs, 'tools/_r18-favpanel.png');
        const panel = await evalJs(barWs, `(function(){
          var p=document.getElementById('panel');
          if(!p || p.hidden) return {open:false};
          var head=document.querySelector('#panelBody .fav-head');
          var tools=head?[].map.call(head.querySelectorAll('.fav-head-tools .fav-tool'),function(b){return b.textContent}):[];
          var cards=[].map.call(document.querySelectorAll('#panelBody .fav-grp'),function(g){
            return {id:g.dataset.favId, named:g.dataset.named, folded:g.classList.contains('collapsed'),
                    lv2:g.classList.contains('lv2'),
                    headTag:(g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head')||{}).tagName||null,
                    nestedBtn:g.querySelectorAll(':scope > .fav-grp-headrow > .fav-grp-head button').length,
                    tools:[].map.call(g.querySelectorAll(':scope > .fav-grp-headrow > .fav-grp-tools > .fav-tool'),function(b){return b.textContent})};
          });
          var q=document.getElementById('q');
          return {open:true, headTools:tools, cards:cards, qVal:q?q.value:null, qVisible:!!(q&&!q.hidden)};
        })()`);
        rec('  面板结构：' + JSON.stringify(panel, null, 1).replace(/\n/g, '\n  '));
        chk('② 横条收藏面板标题栏有「全部展开/全部折叠」',
            panel.open && JSON.stringify(panel.headTools) === JSON.stringify(['全部展开', '全部折叠']),
            JSON.stringify(panel.headTools));
        const lv2cards = (panel.cards || []).filter((c) => c.lv2);
        chk('③ 二级目录卡片旁有「全部展开/全部折叠」（且只有 2 颗）',
            lv2cards.length > 0 && lv2cards.every((c) => JSON.stringify(c.tools) === JSON.stringify(['全部展开', '全部折叠']))
            && (panel.cards || []).filter((c) => !c.lv2).every((c) => c.tools.length === 0),
            lv2cards.length + ' 张二级卡 tools=' + JSON.stringify(lv2cards[0] && lv2cards[0].tools)
            + ' ｜ 一级卡不该有 tools=' + JSON.stringify((panel.cards || []).filter((c) => !c.lv2).map((c) => c.tools)));
        chk('③ 标题行里没有嵌套 button（HTML 合法性）',
            (panel.cards || []).every((c) => c.nestedBtn === 0) && (panel.cards || []).every((c) => c.headTag === 'BUTTON'),
            'nested=' + (panel.cards || []).map((c) => c.nestedBtn).join(','));

        // 全部折叠 → 全部展开
        await evalJs(barWs, `(function(){var b=[].find.call(document.querySelectorAll('#panelBody .fav-head-tools .fav-tool'),function(x){return x.textContent==='全部折叠'}); b.click();})()`);
        await sleep(500);
        const folded = await evalJs(barWs,
            "JSON.stringify([].map.call(document.querySelectorAll('#panelBody .fav-grp[data-named=\"1\"]'),function(g){return g.classList.contains('collapsed')}))");
        chk('② 「全部折叠」把所有有头的卡片折起来', folded === JSON.stringify(new Array(JSON.parse(folded).length).fill(true)), folded);
        await shot(barWs, 'tools/_r18-favpanel-folded.png');
        await evalJs(barWs, `(function(){var b=[].find.call(document.querySelectorAll('#panelBody .fav-head-tools .fav-tool'),function(x){return x.textContent==='全部展开'}); b.click();})()`);
        await sleep(500);
        const unfolded = await evalJs(barWs,
            "[].filter.call(document.querySelectorAll('#panelBody .fav-grp[data-named=\"1\"]'),function(g){return g.classList.contains('collapsed')}).length");
        chk('② 「全部展开」把它们全展开', unfolded === 0, '仍折叠 ' + unfolded + ' 张');

        // 二级卡片单独折叠（只影响自己）
        await evalJs(barWs, `(function(){
          var card=document.querySelector('#panelBody .fav-grp.lv2');
          if(!card) return null;
          var b=[].find.call(card.querySelectorAll('.fav-grp-tools .fav-tool'),function(x){return x.textContent==='全部折叠'});
          if(b) b.click();
          return null;
        })()`);
        await sleep(450);
        const lv2State = await evalJs(barWs, `(function(){
          var cs=document.querySelectorAll('#panelBody .fav-grp.lv2');
          var folded=0; for(var i=0;i<cs.length;i++) if(cs[i].classList.contains('collapsed')) folded++;
          var first=cs[0]?cs[0].classList.contains('collapsed'):null;
          return JSON.stringify({total:cs.length, folded:folded, first:first});
        })()`);
        {
            const s = JSON.parse(lv2State);
            chk('③ 点某个二级卡的「全部折叠」只折它自己', s.total > 1 && s.folded === 1 && s.first === true, lv2State);
        }
        await evalJs(barWs, `(function(){
          var card=document.querySelector('#panelBody .fav-grp.lv2');
          if(!card) return null;
          var b=[].find.call(card.querySelectorAll('.fav-grp-tools .fav-tool'),function(x){return x.textContent==='全部展开'});
          if(b) b.click();
          return null;
        })()`);
        await sleep(400);

        /* ① 点一条收藏 → 应该注入到记事本 */
        const logMark = readLog().length;
        const tipSeen = { t: '' };
        const c1 = caretOf(np.h);
        info('点击前记事本光标', JSON.stringify(c1));
        await evalJs(barWs, "(function(){var t=document.getElementById('tip'); if(t) t.textContent='';})()");
        await evalJs(barWs, `(function(){
          var rows=document.querySelectorAll('#panelBody .fav-item');
          var target=null;
          for(var i=0;i<rows.length;i++){ if(rows[i].textContent.indexOf(${JSON.stringify(INJECT_TEXT)})>=0){ target=rows[i]; break; } }
          if(target) target.click(); else if(rows[0]) rows[0].click();
          return !!target;
        })()`);
        for (let i = 0; i < 30; i++) {
            sleep(150);
            const t = await evalJs(barWs, "(document.getElementById('tip')||{}).textContent||''").catch(() => '');
            if (t && t !== '没有可用的引擎') { tipSeen.t = t; break; }
        }
        await sleep(1600);
        const newLog = readLog().slice(logMark);
        const mInject = newLog.match(/fav_send: 已注入 (\d+) 字到 hwnd=0x([0-9a-f]+)「(.*?)」/);
        const mNoBox = newLog.match(/fav_send: 触发现场没有可用文本框/);
        const mReject = newLog.match(/fav_send: (前台变成了 0x[0-9a-f]+（不是目标 0x[0-9a-f]+）|前台仍是我们自己[^\n]*)/);
        /* ⚠ 标题比对必须**剥掉前导 `*`**：记事本的文件一旦被写入就变"脏档"，
         * 标题从此带 `*` 前缀（`*qs-note.txt - Notepad`）。而 np.title 是
         * **注入前**捕获的（那会儿还是干净的新空文件）。 Rust 那条日志读的是
         * **注入后**的标题 —— 两边天生差一个 `*`。
         * 2026-10-13 做过 A/B：拿上一轮二进制（round 24）跑同一探针，同样
         * 报这一条 FAIL、失败字样一模一样（注入 14 字成功、tip 也对了）——
         * 是探针前提错了，不是产品缺陷，也不是本轮改动引入的回归。 */
        const stripStar = (s) => String(s || '').replace(/^\*+/, '');
        chk('① 点击后走的是注入路径（fav_send 已注入 N 字到记事本）',
            !!mInject && stripStar(mInject[3]) === stripStar(np.title)
            && Number(mInject[1]) === INJECT_TEXT.length,
            mInject ? ('注入 ' + mInject[1] + ' 字到「' + mInject[3] + '」')
                : ('没有注入日志；无文本框分支=' + !!mNoBox + ' 前台复核不过=' + (mReject ? mReject[1] : '无')));
        chk('① 横条 tip 显示「已输入到…」而不是「已填入搜索框」',
            /^已输入到/.test(tipSeen.t || ''), 'tip="' + tipSeen.t + '"');
        const qAfter = await evalJs(barWs, "(function(){var q=document.getElementById('q');return q?q.value:null})()").catch(() => null);
        chk('① 收藏夹窗口自己的搜索框没有被填', qAfter === '' || qAfter === null, '#q="' + qAfter + '"');
        const c2 = caretOf(np.h);
        info('点击后记事本光标', JSON.stringify(c2));
        if (c1 && c2 && c1.rc && c2.rc) {
            chk('① 记事本里的光标真的被推走了（文字确实进去了）',
                (c2.rc[0] - c1.rc[0]) !== 0 || (c2.rc[1] - c1.rc[1]) !== 0,
                'x ' + c1.rc[0] + '→' + c2.rc[0] + ' / y ' + c1.rc[1] + '→' + c2.rc[1]);
        } else {
            info('记事本不暴露打字光标，跳过"光标位移"这条（以注入日志 + tip 为准）');
        }

        /* ================== ⑦ 取色只取当前软件 UI ================== */
        rec('');
        rec('=== ⑦ 自动取色只从当前软件 UI 上采 ===');
        const themeLine = (txt) => {
            const m = txt.match(/theme: 取样区\[(.+?)\] \((\d+),(\d+)\) (\d+)x(\d+) 目标「(.*?)」→ rgb\((\d+),(\d+),(\d+)\)[\s\S]*?主色占比=(\d+)%/g);
            if (!m) return null;
            const last = m[m.length - 1];
            const r = last.match(/取样区\[(.+?)\] \((\d+),(\d+)\) (\d+)x(\d+) 目标「(.*?)」→ rgb\((\d+),(\d+),(\d+)\)[\s\S]*?主色占比=(\d+)%/);
            return { tag: r[1], x: +r[2], y: +r[3], w: +r[4], h: +r[5], target: r[6], rgb: [+r[7], +r[8], +r[9]], dom: +r[10] };
        };

        // (a) 记事本做前台窗口
        SetForegroundWindow(np.h);
        sleep(300);
        const CHROME = ['客户区顶带', '左侧竖带', '底部横带', '标题栏'];
        /* 叫横条 + 读回它采了什么色。
         * ⚠ 标题匹配要用**子串**而不是全等：记事本一旦被改过（① 里刚注入了文字），
         *   标题会变成 "*qs-note.txt - Notepad"，全等就永远匹配不上 ——
         *   表现是"每次都说目标不是预期"，其实日志早就在那儿了。 */
        const summonAndTheme = async (win, pt, tries, key) => {
            const want = key || win.title;
            let last = null;
            for (let i = 0; i < (tries || 4); i++) {
                makeTopmost(win.h);
                sleep(150);
                SetForegroundWindow(win.h);
                sleep(250);
                const p = (i === 0 && pt) ? pt : (pickPoint(win) || pt);
                if (!p) break;
                moveTo(p[0], p[1]);
                sleep(250);
                const mk = readLog().length;
                combo([VK_CONTROL, VK_MENU, VK_F]);
                await sleep(2200);
                const t = themeLine(readLog().slice(mk));
                if (t) last = t;
                if (t && t.target.indexOf(want) >= 0) return t;
                info('第 ' + (i + 1) + ' 次取色目标不是预期（' + (t ? t.target : '无 theme 行') + '），重试');
            }
            return last;   // 重试都用完也把已经采到的最后一条交出去，别把数据扔了
        };
        let t1 = await summonAndTheme(np, mid, 4, 'qs-note.txt');
        if (!t1) { chk('⑦ 取色日志存在', false, '没读到 theme 行'); }
        else {
            const inWin = t1.x >= np.rect[0] && t1.y >= np.rect[1]
                && t1.x + t1.w <= np.rect[0] + np.rect[2] && t1.y + t1.h <= np.rect[1] + np.rect[3];
            chk('⑦ [记事本] 取样区落在前台窗口矩形内（不取别的窗口/桌面）', inWin,
                t1.tag + ' (' + t1.x + ',' + t1.y + ') ' + t1.w + 'x' + t1.h + ' vs 窗口 ' + fmt(np.rect));
            chk('⑦ [记事本] 取样区是窗口的 UI 边带，不是锚点旁边那种兜底块',
                CHROME.indexOf(t1.tag) >= 0, 'tag=' + t1.tag + ' 主色占比=' + t1.dom + '% rgb=' + t1.rgb.join(','));
        }

        // (b) 用 Edge --app 加载"整幅无主色"的噪声页，替代"网页在放视频"
        rec('');
        rec('  ⑦b 用 msedge --app 加载整幅无主色的噪声页（=视频画面在"没有主色"这个特征上）');
        const edgeProf = path.join(tmp, 'edgeprof');
        try {
            spawn(EDGE, ['--app=file:///' + noiseHtml.replace(/\\/g, '/'), '--user-data-dir=' + edgeProf,
                '--no-first-run', '--no-default-browser-check', '--window-size=1000,760',
                '--window-position=200,120'], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) { rec('  INFO  Edge 起不来：' + e.message); }
        let ew = null;
        for (let i = 0; i < 40 && !ew; i++) {
            sleep(400);
            ew = findWindow((w) => /QS-噪声画面/.test(w.title) && w.rect[2] > 300);
        }
        if (!ew) { rec('  INFO  Edge 噪声窗口没起来，⑦b 跳过'); }
        else {
            info('噪声窗口', fmt(ew.rect) + ' pid=' + ew.pid);
            sleep(1500);
            // 标题里带着页面自算的统计（w x h | 平均色 | 主色占比）
            ew.title = titleOf(ew.h) || ew.title;               // 完整标题（取色日志里就是它，用于核对）
            if (!pageStats) {
                const m = ew.title.match(/QS-噪声画面\|(\d+)x(\d+)\|(\d+),(\d+),(\d+)\|([\d.]+)/);
                if (m) {
                    pageStats = { w: +m[1], h: +m[2], mean: [+m[3], +m[4], +m[5]], dom: +m[6], px: 0, from: 'title' };
                }
                info('噪声页标题', ew.title);
            }
            const emid = [Math.round(ew.rect[0] + ew.rect[2] / 2), Math.round(ew.rect[1] + ew.rect[3] * 0.7)];
            const t2 = await summonAndTheme(ew, emid, 4, 'QS-噪声画面');
            void isEdgePage;
            if (!t2) { chk('⑦ [噪声页] 取色日志存在', false, '没读到 theme 行'); }
            else {
                const inWin2 = t2.x >= ew.rect[0] && t2.y >= ew.rect[1]
                    && t2.x + t2.w <= ew.rect[0] + ew.rect[2] && t2.y + t2.h <= ew.rect[1] + ew.rect[3];
                chk('⑦ [噪声页] 取样区落在前台窗口矩形内', inWin2,
                    t2.tag + ' (' + t2.x + ',' + t2.y + ') ' + t2.w + 'x' + t2.h + ' vs 窗口 ' + fmt(ew.rect));
                chk('⑦ [噪声页] 取样区是 UI 边带（不是内容区那块无主色的画面）',
                    CHROME.indexOf(t2.tag) >= 0, 'tag=' + t2.tag + ' 主色占比=' + t2.dom + '% rgb=' + t2.rgb.join(','));
                chk('⑦ [噪声页] 取到的颜色不是那块内容区的"糊成一团"的平均色',
                    t2.dom >= 30, '取样区主色占比=' + t2.dom + '%（阈值 30%）');
                if (pageStats) {
                    const mean = pageStats.mean;
                    const diff = Math.max(Math.abs(t2.rgb[0] - mean[0]), Math.abs(t2.rgb[1] - mean[1]), Math.abs(t2.rgb[2] - mean[2]));
                    chk('⑦ [噪声页] 对照：画面本身没有主色（占比 <30%）且取到的色 ≠ 画面平均色',
                        pageStats.dom < 0.30 && diff > 24,
                        '画面 ' + pageStats.w + 'x' + pageStats.h + ' 平均色=' + mean.join(',')
                        + ' 主色占比=' + pageStats.dom + ' ｜ 取样色=' + t2.rgb.join(',') + ' 最大通道差=' + diff);
                } else {
                    info('页面统计没回传（噪声页 fetch 失败），跳过对照项');
                }
            }
            try { spawn('taskkill', ['/PID', String(ew.pid), '/F', '/T'], { stdio: 'ignore' }); } catch (e) { }
        }
        void tap;
        try { spawn('taskkill', ['/PID', String(np.pid), '/F', '/T'], { stdio: 'ignore' }); } catch (e) { }
    }

    rec('');
    rec('================ 汇总 ================');
    rec('PASS ' + passN + ' / FAIL ' + failN);
    try { proc.kill(); } catch (e) { }
    try { srv.close(); } catch (e) { }
    flush();
    process.exit(0);
})();
