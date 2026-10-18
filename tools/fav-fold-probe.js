/* ============================================================================
 *  专项探针：收藏夹目录折叠 + 引擎面板搜索框（本轮用户报的三条）
 *
 *  本轮要证的三件事：
 *    ① 【折叠】横条收藏夹里带标题头的目录（二级目录、以及根视图下的一级目录）
 *       点标题行能**收起来**：内容层 display:none、面板高度收窄、aria-expanded
 *       跟随、同一条尺寸会如实报给后端（layout_bar css=…）；再点一下**原样展开**。
 *    ② 【输入框】「更多引擎」的 #q：搜一次之后必须被清空（点引擎 / 回车两条路），
 *       收起再打开也不留上次的词，且 autocomplete=off（挡掉表单历史下拉）。
 *    ③ 【搜索文本】点引擎时带过去的 text 必须等于**横条当前这条文字**
 *       （currentText），而不是让后端去猜（后端猜就可能猜到旧剪贴板上）。
 *
 *  做法：
 *    · 另起一个测试实例（QS_INSTANCE_TAG + --bar），**完全不碰全局输入**：
 *      所有点击都走 CDP 的 DOM .click()，不用 SendInput；
 *      临时配置里 trigger_select / trigger_copy / ocr_enable 全关掉，
 *      免得这个实例对用户正在敲的键鼠有反应。
 *    · 临时 APPDATA 里塞一棵**自带内容的**收藏树（真配置里的二级目录是空的，
 *      折起来高度不变、量不出效果），并清空 fav_panel_sizes 让面板按内容自适应。
 *    · ③ 不去拦 invoke（Tauri 的 __TAURI_INTERNALS__ 是冻住的，运行时替换无效 —
 *      这一轮实测确认过），改看 **Rust 日志**：open_search 现在会把
 *      「前端传的文本 / 来源（前端传入 or 后端选区兜底）/ 实际查询」写进 log.txt。
 *      这条日志本来就是为这一类"到底搜了哪份文字"的问题加的。
 *    · 窗口尺寸变化同样从日志的 `layout_bar css=(…)` 里读 —— 面板高度不算数，
 *      要看到它**真的报给了后端**。
 *
 *  用法：node tools/fav-fold-probe.js
 *  输出：tools/fav-fold-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'fav-fold-probe.txt');
const PORT = 9337;
const TAG = '-probe-fold';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

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

/** 本进程的 QuickSearchBar 窗口矩形（用户自己的实例同名，必须按 pid 过滤） */
function barRect(pid) {
    let out = null;
    const cb = koffi.register((h) => {
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        if (p[0] !== pid) return 1;
        const t = new Uint16Array(200); const n = GetWindowTextW(h, t, 200);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
        if (s === 'QuickSearchBar') {
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

/* ---------------- 页面侧采集 ---------------- */

/* ⚠ 一律用 :scope > 取**直接子节点**。
 * 第一版写成 g.querySelector('.fav-grp-head') —— 那会把**子孙**的标题头也捞进来，
 * 于是「一级卡片」量出来的是它二级子卡的标题（name/aria/body 全是别人的），
 * 判据看着全 FAIL、其实功能是好的。 */
const SNAP = `(function(){
  const p = document.getElementById('panel');
  const pb = p ? p.getBoundingClientRect() : null;
  const box = function(el){ return el ? Math.round(el.getBoundingClientRect().height) : null; };
  const grps = [].slice.call(document.querySelectorAll('.fav-grp')).map(function(g){
    var h = g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head');
    var b = g.querySelector(':scope > .fav-grp-body');
    var n = g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head > .fav-grp-name');
    var own = g.querySelectorAll(':scope > .fav-grp-body > .fav-item');
    var shownOwn = 0;
    for (var i = 0; i < own.length; i++) if (own[i].getBoundingClientRect().height > 0) shownOwn++;
    return {
      cls: g.className,
      name: n ? n.textContent : '(无头)',
      h: Math.round(g.getBoundingClientRect().height),
      headH: box(h),
      headTag: h ? h.tagName : null,
      caret: !!g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head > .fav-grp-caret'),
      bodyDisp: b ? getComputedStyle(b).display : null,
      nOwn: own.length, shownOwn: shownOwn,
      aria: h ? h.getAttribute('aria-expanded') : null,
      folded: g.classList.contains('collapsed')
    };
  });
  var q = document.getElementById('q');
  return {
    panelHidden: !!p.hidden, panelH: pb ? Math.round(pb.height) : null,
    panelW: pb ? Math.round(pb.width) : null, innerH: window.innerHeight,
    grps: grps,
    q: q ? { ac: q.getAttribute('autocomplete'), v: q.value } : null
  };
})()`;

/** 点第 idx 个匹配 sel 的目录的标题行 */
const CLICK_HEAD = (sel, idx) => `(function(){
  var g = document.querySelectorAll(${JSON.stringify(sel)})[${idx}];
  if (!g) return null;
  var h = g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head');
  if (!h) return 'NO_HEAD';
  h.click();
  return g.className + '|' + (g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head > .fav-grp-name') || {}).textContent;
})()`;

/** 从 log.txt 里读最后一条 layout_bar 报上来的窗口尺寸 [w,h] */
function lastCss(txt) {
    const m = txt.match(/layout_bar css=\(([\-\d,]+)\)/g);
    if (!m) return null;
    const nums = m[m.length - 1].match(/\(([\-\d,]+)\)/)[1].split(',').map(Number);
    return [nums[4], nums[5]];
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-fold-'));
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
        c.trigger_select = false; c.trigger_copy = false; c.ocr_enable = false;
        c.auto_start = false;
        c.fav_panel_sizes = {};
        c.favorites = [
            {
                id: 'pg1', name: '测试一级', icon: '',
                items: [mkItem('pi1', '一级内容 A', '一级备注')],
                children: [sub('pc1', '二级甲', 5), sub('pc2', '二级乙', 4)],
            },
            { id: 'pg2', name: '只有子目录', icon: '', items: [], children: [sub('pc3', '二级丙', 3)] },
        ];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    const readLog = () => { try { return fs.readFileSync(logp, 'utf8'); } catch (e) { return ''; } };
    moveTo(Math.round(SW / 2), Math.round(SH / 2));
    sleep(300);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid + '（QS_INSTANCE_TAG=' + TAG + ' + --bar；不碰全局输入）');
    sleep(9000);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上（端口 ' + PORT + '）'); try { proc.kill(); } catch (e) { } flush(); process.exit(0); }
    rec('横条已摆出：窗口 ' + fmt(barRect(proc.pid)));
    // 记录一下 Tauri 内部对象是不是冻住的（③ 的取证方式就是据此选的）
    rec('__TAURI_INTERNALS__ frozen=' + await evalJs(ws, 'String(Object.isFrozen(window.__TAURI_INTERNALS__))')
        + '  core.invoke 可写=' + await evalJs(ws,
            '(function(){try{var d=Object.getOwnPropertyDescriptor(window.__TAURI__.core,"invoke");return String(!!d&&d.writable)}catch(e){return "err"}})()'));

    /* ================= ② ③ 引擎面板的搜索框 ================= */
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(900);
    const cells = await evalJs(ws, "document.querySelectorAll('#panelBody .cell').length");
    rec('');
    rec('=== ② ③ 引擎面板搜索框（引擎格子 ' + cells + ' 个）===');
    rec('   （open_search 的入参看 Rust 日志：engine / 前端文本 / 来源 / 实际查询）');

    const clickCell = (i, qval, cur) => `(function(){
      var q = document.getElementById('q');
      q.value = ${JSON.stringify(qval)};
      currentText = ${JSON.stringify(cur)};
      var c = document.querySelectorAll('#panelBody .cell')[${i}];
      c.dataset.engine = '__probe_no_engine__';   // 假引擎名：后端查不到模板，不会真开浏览器
      c.click();
      return q.value;
    })()`;

    let logMark = readLog().length;
    const val3 = await evalJs(ws, clickCell(0, '', '【横条当前文本】SELECTED'));
    sleep(1000);
    let l3 = readLog().slice(logMark).split('\n').filter((x) => x.indexOf('open_search:') >= 0);
    rec('③ 输入框留空 + currentText=【横条当前文本】SELECTED → 点引擎');
    rec('   ' + (l3.join('\n   ') || '(日志里没找到 open_search)'));
    rec('   输入框点完的值 = ' + JSON.stringify(val3) + '（该是空串）');

    logMark = readLog().length;
    const val2 = await evalJs(ws, clickCell(1, '手打关键词KW', '【横条当前文本】SELECTED'));
    sleep(1000);
    let l2 = readLog().slice(logMark).split('\n').filter((x) => x.indexOf('open_search:') >= 0);
    rec('② 输入框打「手打关键词KW」→ 点引擎');
    rec('   ' + (l2.join('\n   ') || '(日志里没找到 open_search)'));
    rec('   输入框点完的值 = ' + JSON.stringify(val2) + '（该是空串）');

    logMark = readLog().length;
    const val2b = await evalJs(ws, `(function(){
      var q = document.getElementById('q');
      q.value = '回车关键词ENTER';
      currentText = '【横条当前文本】SELECTED';
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return q.value;
    })()`);
    sleep(1000);
    let l2b = readLog().slice(logMark).split('\n').filter((x) => x.indexOf('open_search:') >= 0);
    rec('② 输入框打「回车关键词ENTER」→ 回车（默认引擎）');
    rec('   ' + (l2b.join('\n   ') || '(日志里没找到 open_search)'));
    rec('   输入框回车后的值 = ' + JSON.stringify(val2b) + '（该是空串）');

    await evalJs(ws, "document.getElementById('q').value = '留着不该留的'; document.getElementById('btnPanelClose').click()");
    sleep(500);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(700);
    const afterClose = await evalJs(ws, "document.getElementById('q').value");
    const acAttr = await evalJs(ws, "document.getElementById('q').getAttribute('autocomplete')");
    rec('② 收起面板再打开 → 输入框 = ' + JSON.stringify(afterClose) + '（该是空串）'
        + '；autocomplete = ' + JSON.stringify(acAttr) + '（该是 off）');

    /* ================= ① 收藏夹目录折叠 ================= */
    rec('');
    rec('=== ① 收藏夹目录折叠 ===');
    const favEntry = await evalJs(ws,
        "(function(){var b=document.querySelector('#panelBody .fav-entry'); if(!b) return null; var t=b.textContent; b.click(); return t;})()");
    sleep(1600);
    rec('从引擎面板点收藏夹入口：' + JSON.stringify(favEntry) + '（单目录视图：一级无头、二级带头）');

    const sA0 = await evalJs(ws, SNAP);
    const cssA0 = lastCss(readLog());
    rec('折前：面板 ' + sA0.panelW + 'x' + sA0.panelH + ' 视口高 ' + sA0.innerH
        + ' 后端收到的窗口尺寸 ' + JSON.stringify(cssA0));
    rec('  目录：' + JSON.stringify(sA0.grps.map((g) => ({
        cls: g.cls, name: g.name, head: g.headTag, caret: g.caret,
        h: g.h, headH: g.headH, n: g.nOwn, aria: g.aria, folded: g.folded, body: g.bodyDisp,
    }))));

    // 折 / 展 各来一次，两次都用**同一个下标**定位（不按名字找 —— 一级卡里嵌着二级卡，
    // 名字会撞）
    const lv2Idx = 0;   // .fav-grp.lv2[0] = 二级甲
    const whoF = await evalJs(ws, CLICK_HEAD('.fav-grp.lv2', lv2Idx));
    sleep(900);
    const sA1 = await evalJs(ws, SNAP);
    const cssA1 = lastCss(readLog());
    rec('点二级目录标题 → ' + JSON.stringify(whoF));
    rec('   折后：面板 ' + sA1.panelW + 'x' + sA1.panelH + ' 后端窗口尺寸 ' + JSON.stringify(cssA1));
    const lv2F = sA1.grps.filter((g) => g.cls.indexOf('lv2') >= 0)[lv2Idx];
    rec('   该目录：folded=' + lv2F.folded + ' aria=' + lv2F.aria + ' body=' + lv2F.bodyDisp
        + ' 卡高 ' + lv2F.h + '（该≈头高 ' + lv2F.headH + '）'
        + ' 条目 ' + lv2F.shownOwn + '/' + lv2F.nOwn + ' 占位（该 0/' + lv2F.nOwn + '）');

    const whoU = await evalJs(ws, CLICK_HEAD('.fav-grp.lv2', lv2Idx));
    sleep(900);
    const sA2 = await evalJs(ws, SNAP);
    const cssA2 = lastCss(readLog());
    const lv2U = sA2.grps.filter((g) => g.cls.indexOf('lv2') >= 0)[lv2Idx];
    rec('再点同一处 → ' + JSON.stringify(whoU));
    rec('   展后：面板 ' + sA2.panelW + 'x' + sA2.panelH + ' 后端窗口尺寸 ' + JSON.stringify(cssA2));
    rec('   该目录：folded=' + lv2U.folded + ' aria=' + lv2U.aria + ' body=' + lv2U.bodyDisp
        + ' 卡高 ' + lv2U.h + ' 条目 ' + lv2U.shownOwn + '/' + lv2U.nOwn + ' 占位');

    const lv2_0 = sA0.grps.filter((g) => g.cls.indexOf('lv2') >= 0)[lv2Idx];
    const passFold = lv2F.folded && lv2F.bodyDisp === 'none' && lv2F.aria === 'false'
        && lv2F.shownOwn === 0 && lv2F.nOwn > 0
        && lv2F.h <= lv2F.headH + 4
        && sA1.panelH < sA0.panelH - 20
        && !!cssA1 && !!cssA0 && cssA1[1] < cssA0[1] - 20;
    const passUnfold = !lv2U.folded && lv2U.bodyDisp !== 'none' && lv2U.aria === 'true'
        && lv2U.shownOwn === lv2U.nOwn
        && Math.abs(lv2U.h - lv2_0.h) <= 4
        && Math.abs(sA2.panelH - sA0.panelH) <= 4
        && !!cssA2 && Math.abs(cssA2[1] - cssA0[1]) <= 4;
    rec('   → 二级目录折叠 ' + (passFold ? 'PASS' : 'FAIL')
        + ' / 展开还原 ' + (passUnfold ? 'PASS' : 'FAIL'));
    rec('   （末条 layout_bar：折前 h=' + (cssA0 && cssA0[1]) + ' → 折后 h=' + (cssA1 && cssA1[1])
        + ' → 展后 h=' + (cssA2 && cssA2[1]) + '）');

    /* ---- 根视图：一级目录也要能折 ---- */
    await evalJs(ws, "(function(){ try { openFavPanel(); } catch(e) { panelFav='root'; togglePanel(true); } })()");
    sleep(1600);
    const sB0 = await evalJs(ws, SNAP);
    const cssB0 = lastCss(readLog());
    rec('');
    rec('根视图 折前：面板高 ' + sB0.panelH + ' 后端窗口尺寸 ' + JSON.stringify(cssB0));
    rec('  目录：' + JSON.stringify(sB0.grps.map((g) => ({
        cls: g.cls, name: g.name, head: g.headTag, h: g.h, n: g.nOwn, aria: g.aria,
    }))));
    const who1 = await evalJs(ws, CLICK_HEAD('.fav-grp', 0));
    sleep(900);
    const sB1 = await evalJs(ws, SNAP);
    const cssB1 = lastCss(readLog());
    const b1 = sB1.grps[0];
    rec('折一级「' + b1.name + '」→ ' + JSON.stringify(who1));
    rec('   折后：面板高 ' + sB1.panelH + ' 后端窗口尺寸 ' + JSON.stringify(cssB1)
        + ' folded=' + b1.folded + ' aria=' + b1.aria + ' body=' + b1.bodyDisp + ' 卡高 ' + b1.h);
    await evalJs(ws, CLICK_HEAD('.fav-grp', 0));
    sleep(900);
    const sB2 = await evalJs(ws, SNAP);
    const cssB2 = lastCss(readLog());
    rec('   再展开：面板高 ' + sB2.panelH + ' 后端窗口尺寸 ' + JSON.stringify(cssB2));
    const passLv1 = (b1.folded && b1.bodyDisp === 'none' && sB1.innerH < sB0.innerH - 20 || (cssB1 && cssB0 && cssB1[1] < cssB0[1] - 20))
        && (!sB2.grps[0].folded)
        && Math.abs(sB2.panelH - sB0.panelH) <= 4
        && (!!cssB2 && !!cssB0 && Math.abs(cssB2[1] - cssB0[1]) <= 4);
    rec('   → 一级目录折叠/还原 ' + (passLv1 ? 'PASS' : 'FAIL')
        + '（末条 layout_bar：' + (cssB0 && cssB0[1]) + ' → ' + (cssB1 && cssB1[1]) + ' → ' + (cssB2 && cssB2[1]) + '）');

    // 折叠状态是会话内的：重渲染（配置广播 / 切视图）不该忘
    const keep = await evalJs(ws, `(function(){
      var g = document.querySelectorAll('.fav-grp')[0];
      g.querySelector(':scope > .fav-grp-headrow > .fav-grp-head').click();
      return { folded: g.classList.contains('collapsed'), n: favCollapsed.size };
    })()`);
    sleep(300);
    await evalJs(ws, "renderFavPanel()");
    sleep(600);
    const keep2 = await evalJs(ws, `(function(){
      var g = document.querySelectorAll('.fav-grp')[0];
      return { folded: g.classList.contains('collapsed') };
    })()`);
    rec('   折叠状态跨重渲染：折时 ' + JSON.stringify(keep) + ' → renderFavPanel() 后 ' + JSON.stringify(keep2)
        + '（该保持 folded=true）');

    rec('');
    rec('=== 汇总 ===');
    rec('  ① 二级目录折叠/还原  : ' + (passFold && passUnfold ? 'PASS' : 'FAIL'));
    rec('  ① 一级目录折叠/还原  : ' + (passLv1 ? 'PASS' : 'FAIL'));
    rec('  ① 折叠状态跨重渲染   : ' + (keep2.folded ? 'PASS' : 'FAIL'));
    rec('  ② 输入框搜完清空     : ' + (val3 === '' && val2 === '' && val2b === '' && afterClose === '' ? 'PASS' : 'FAIL'));
    rec('  ② autocomplete=off   : ' + (acAttr === 'off' ? 'PASS' : 'FAIL'));
    rec('  ③ 搜索文本=横条当前  : ' + (l3.join(' ').indexOf('前端文本=Some("【横条当前文本】SELECTED")') >= 0
        && l3.join(' ').indexOf('来源=前端传入') >= 0 ? 'PASS' : 'FAIL'));
    rec('  ② 手打词优先         : ' + (l2.join(' ').indexOf('前端文本=Some("手打关键词KW")') >= 0 ? 'PASS' : 'FAIL'));
    rec('  ② 回车走默认引擎     : ' + (l2b.join(' ').indexOf('open_search: engine=') >= 0
        && l2b.join(' ').indexOf('__probe_no_engine__') < 0 ? 'PASS' : 'FAIL'));

    try {
        rec('');
        rec('--- log.txt 尾部 10 行 ---');
        rec(readLog().split('\n').slice(-10).join('\n'));
    } catch (e) { }
    flush();
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
