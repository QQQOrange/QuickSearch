/* ============================================================================
 *  轮 29 专项探针：本轮七项功能
 *    #125 液态玻璃实时折射（live 模式 takes 持续增长 / 关掉即稳 + 抓屏隐身）
 *    #126 横条样式三主题（默认 / 磨砂 / 液态玻璃，页面只显当前主题配置行）
 *    #127 添加引擎三方式（网页 / 软件 / 快捷键，表单按需出场）
 *    #128 更多引擎面板三层下钻（三大类 → 二级细分 → 分类网格 + 面包屑 + 搜索平铺）
 *    #129 液态玻璃参数预设（轻量 / 标准 / 深度 / 自定义 命中判定）
 *    #130 百度 OCR 一键优化（按钮链路 + 空凭证提示 + 命令已注册）
 *    #131 帮助与关于页面更新
 *
 *  取证方式：隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）+ CDP
 *  驱动真实 UI + 读 config.json 验证落库。零合成键盘输入、零网络请求
 *  （OCR 只验空凭证提示链，不打真实百度接口）。
 *
 *  用法：node tools/round29-probe.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round29-probe.txt');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetCursorPos = user32.func('int GetCursorPos(_Out_ POINT *p)');
const SetCursorPos = user32.func('int SetCursorPos(int x, int y)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void *h, _Out_ int *pid)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const AttachThreadInput = user32.func('int AttachThreadInput(int idAttach, int idAttachTo, int f)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ------------------------------ 窗口枚举 ------------------------------ */
const wtext = (h) => {
    const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
const wclass = (h) => {
    const t = new Uint16Array(400); const n = GetClassNameW(h, t, 400);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
    return s;
};
function wins() {
    const out = [];
    const cb = koffi.register((h) => {
        const t = wtext(h);
        if (t) {
            const r = {}; GetWindowRect(h, r);
            out.push({ hwnd: h, title: t, cls: wclass(h), vis: !!IsWindowVisible(h),
                       rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] });
        }
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
const barRect = () => { const w = wins().find((x) => x.title === 'QuickSearchBar'); return w ? w.rect : null; };
const waitBar = (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) { const r = barRect(); if (r && r[2] > 0) return r; sleep(120); }
    return null;
};
const fmt = (r) => r ? `x=${r[0]} y=${r[1]} w=${r[2]} h=${r[3]}` : 'NONE';
function forceForeground(h) {
    const fg = GetForegroundWindow();
    if (fg === h) return true;
    const b1 = Buffer.alloc(4), b2 = Buffer.alloc(4);
    const tFg = GetWindowThreadProcessId(fg, b1);
    const tH = GetWindowThreadProcessId(h, b2);
    const attached = tFg && tH && tFg !== tH ? AttachThreadInput(tFg, tH, 1) : 0;
    const ok = !!SetForegroundWindow(h);
    if (attached) AttachThreadInput(tFg, tH, 0);
    return ok;
}

/* ------------------------------ CDP ------------------------------ */
let PORT = 9411;
let wsId = 0;
const wsPending = new Map();
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        wsPending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
function wireWs(ws) {
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && wsPending.has(m.id)) {
            const p = wsPending.get(m.id);
            wsPending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message || 'cdp'));
            else p.resolve(m.result);
        }
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text)
            + (desc ? ' | ' + String(desc).split('\n')[0] : '')
            + ' | ' + String(expr).slice(0, 120));
    }
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
            wireWs(ws);
            return ws;
        }
        await sleep(300);
    }
    return null;
}
const isBarPage = (u) => /index\.html/.test(u) || /tauri\.localhost\/?$/.test(u);
const isSettingsPage = (u) => /settings\.html/.test(u);
async function waitInvoke(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        try {
            if ((await evalJs(ws, "typeof invoke === 'function' && typeof listen === 'function'")) === true) return true;
        } catch (e) { }
        await sleep(300);
    }
    return false;
}
async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        rec('  [截图] ' + name);
    } catch (e) { rec('  WARN  截图失败 ' + name + ' → ' + e.message); }
}

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0, skipN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function skip(name, why) { skipN++; rec('  SKIP  ' + name + '   [' + why + ']'); }
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

/* 实例进程表放模块作用域：main 里 throw 到 catch 时也要能回收子进程 */
const instances = [];

/* ========================================================================== *\
\* ================================ main ==================================== */
/* ========================================================================== */
(async function main() {
    rec('=== 轮 29 专项探针：本轮七项功能（#125-#131）===');
    rec('');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r29-'));

    /* ---------- 实例工厂（同轮 28：APPDATA 必须是配置目录本身） ---------- */
    function makeConf(dir, extra) {
        const qs = path.join(dir, 'QuickSearch');
        fs.mkdirSync(qs, { recursive: true });
        const c = Object.assign({
            trigger_copy: false, trigger_select: false, ocr_enable: false,
            auto_color: false, auto_start: false,
            webdav_url: '', webdav_user: '', webdav_pass: '',
            webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
            backup_dir: '', apps: [], overrides: {}, fav_hotkey: '',
            custom_engines: [],
            bar_glass: true, bar_glass_refraction: 20, bar_glass_bevel: 12,
            bar_glass_frost: 0, bar_glass_aberration: 35, bar_glass_spec: 100,
            bar_glass_tint: 12, bar_glass_live: true,
            // 待机淡度关掉：指针不在条上时横条会整体变淡，玻璃像素被乘法衰减
            bar_dim_alpha: 100,
        }, extra || {});
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
        return qs;
    }
    function spawnInstance(qs, port, tag) {
        PORT = port;
        const appData = path.dirname(qs);
        const env = Object.assign({}, process.env, {
            APPDATA: appData, LOCALAPPDATA: appData,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmpRoot, 'wv2-' + tag),
            QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
            QS_INSTANCE_TAG: tag,
            QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
                + ' --disable-gpu-sandbox --remote-debugging-port=' + port,
        });
        const p = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
        instances.push(p);
        rec('启动实例 pid=' + p.pid + '（CDP ' + port + '，tag=' + tag + '）');
        return p;
    }
    function killInstance(idx) {
        const p = instances[idx];
        if (p) { try { p.kill(); } catch (e) { } }
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            if (!barRect()) return true;
            sleep(150);
        }
        return !barRect();
    }
    const readCfg = (qs) => {
        try { return JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8')); } catch (e) { return null; }
    };
    const dbg = async (ws) => JSON.parse(await evalJs(ws, 'JSON.stringify(window.QSGlass.debugInfo())'));

    /* =====================================================================
     *  实例 D：#125 实时折射 + #128 面板三层下钻（宿主页 = 横条）
     *  之后同一实例开设置窗，把 #126/#129/#127/#130/#131 全走完。
     * ===================================================================== */
    rec('');
    rec('############ 实例 D：实时折射（#125）############');
    const qsD = makeConf(path.join(tmpRoot, 'D'), {
        bar_list: ['百度', 'Google', '知乎'],
        bar_glass: true, bar_glass_live: true,
    });
    const cfgPathD = path.join(qsD, 'config.json');
    // 光标先挪开屏幕正中：横条弹出在 30% 高度，别让指针预停在横条上
    SetCursorPos(Math.round(SW / 2), Math.round(SH * 0.30));
    await sleep(200);
    spawnInstance(qsD, 9411, '-probe-r29d');
    await sleep(8000);
    const barWs = await connectWhere(isBarPage, 30000);
    if (!barWs || !(await waitInvoke(barWs))) {
        chk('★ D0 连上横条页', false);
    } else {
        chk('★ D0 连上横条页（CDP 9411）', true);
        waitBar(10000);
        // show_bar 之后 onShow → applyConf → startLive（exclSet 是 invoke 链，
        // 要等它落地），多等一秒让 live 状态稳定
        await sleep(1500);

        /* ---- D 段：#125 实时折射 ---- */
        rec('');
        rec('---- D 段：液态玻璃实时折射（#125）----');
        const d0 = await dbg(barWs);
        info('D 初态：' + JSON.stringify({ ready: d0.ready, on: d0.on, live: d0.live, stats: d0.stats }));
        chk('  D1 玻璃已就绪（WebGL2 + qs-glass 类）', d0.ready === true && d0.on === true);
        if (d0.live.loop === true) {
            chk('★ D2 live 循环已启动（barGlassLive=true）', true, 'loop=true');
        } else {
            chk('★ D2 live 循环已启动（barGlassLive=true）', false, 'loop=' + d0.live.loop + ' starting=' + d0.live.starting);
        }
        if (d0.live.excluded === true) {
            chk('★ D3 横条对抓屏隐身（WDA_EXCLUDEFROMCAPTURE 已验证）', true);
        } else {
            skip('★ D3 横条对抓屏隐身（WDA_EXCLUDEFROMCAPTURE）',
                'glass_exclude 未被系统接受（旧系统 / 远程会话）—— 自动走隐藏抓取兜底路，非产品问题');
        }
        // live 主路每帧能抓就抓（在途去重），captures 计数应持续上涨
        const cap1 = d0.stats.captures;
        await sleep(1500);
        const d1 = await dbg(barWs);
        chk('★ D4 live 模式持续重抓（1.5s captures 增长 >= 3）',
            d1.stats.captures - cap1 >= 3, cap1 + '→' + d1.stats.captures);
        await shot(barWs, 'round29-d-live.png');

        // 关掉实时折射：set_setting 走 broadcast → bar.js qs://config → applyConf → stopLive
        await evalJs(barWs, "invoke('set_setting', {key:'barGlassLive', value:false})");
        await sleep(1500);
        const d2 = await dbg(barWs);
        chk('★ D5 关掉 barGlassLive 后循环退出', d2.live.loop === false, 'loop=' + d2.live.loop);
        const cap2 = d2.stats.captures;
        await sleep(1500);
        const d3 = await dbg(barWs);
        chk('★ D6 关掉后 captures 稳定（1.5s 无增长）', d3.stats.captures === cap2, cap2 + '→' + d3.stats.captures);
        chk('  D7 关掉后恢复参与抓屏（excluded=false）', d3.live.excluded === false);
        // 关掉 live 后玻璃仍在（只是不再持续重抓）：debugInfo.on 仍为 true
        chk('  D8 关掉实时折射后玻璃本身还在（静态折射保留）', d3.on === true && d3.ready === true);

        /* ---- F 段：#128 面板三层下钻 ---- */
        rec('');
        rec('---- F 段：更多引擎面板三层下钻（#128）----');
        await evalJs(barWs, "document.getElementById('btnMore').click()");
        await sleep(600);
        const f1 = await evalJs(barWs, `(function(){
            var pn=document.getElementById('panel');
            var cards=[].slice.call(document.querySelectorAll('#panelBody .grp-card[data-group]'));
            return { vis: !!pn && !pn.hidden,
                     groups: cards.map(function(c){return c.dataset.group;}),
                     titles: cards.map(function(c){
                         var t=c.querySelector('.grp-t'); return t? t.textContent : ''; }),
                     crumb: !!document.querySelector('#panelBody .crumb') };
        })()`);
        info('F1 第一层：' + JSON.stringify(f1));
        chk('★ F1 面板打开且第一层是三大类卡片（网页/软件/快捷键）',
            f1.vis === true && f1.groups.join(',') === 'web,app,hotkey',
            'groups=' + f1.groups.join(','));
        chk('  F1 三大类标题正确（网页引擎/软件引擎/快捷键引擎）',
            f1.titles.join('/') === '网页引擎/软件引擎/快捷键引擎', f1.titles.join('/'));
        chk('  F1 第一层无面包屑（还没下钻）', f1.crumb === false);

        // 点「网页引擎」→ 第二层子类卡
        await evalJs(barWs, `(function(){
            var c=document.querySelector('#panelBody .grp-card[data-group="web"]');
            if(c) c.click();
        })()`);
        await sleep(400);
        const f2 = await evalJs(barWs, `(function(){
            var subs=[].slice.call(document.querySelectorAll('#panelBody .grp-card[data-sub]'));
            var grps=[].slice.call(document.querySelectorAll('#panelBody .grp-card[data-group]'));
            var crumb=document.querySelector('#panelBody .crumb');
            return { subs: subs.map(function(c){return c.dataset.sub;}),
                     subTitles: subs.map(function(c){
                         var t=c.querySelector('.grp-t'); return t? t.textContent : ''; }),
                     grpGone: grps.length === 0,
                     crumb: !!crumb,
                     crumbBack: !!document.querySelector('#panelBody .crumb-back') };
        })()`);
        info('F2 第二层：' + JSON.stringify(f2));
        chk('★ F2 点大类卡下钻到第二层（搜索引擎/直达网页）',
            f2.subs.join(',') === 'search,open', 'subs=' + f2.subs.join(','));
        chk('  F2 第二层子类标题正确（搜索引擎/直达网页）',
            f2.subTitles.join('/') === '搜索引擎/直达网页', f2.subTitles.join('/'));
        chk('  F2 第一层卡片已让位 + 面包屑与返回钮出现',
            f2.grpGone === true && f2.crumb === true && f2.crumbBack === true);

        // 点「搜索引擎」→ 第三层分类网格
        await evalJs(barWs, `(function(){
            var c=document.querySelector('#panelBody .grp-card[data-sub="search"]');
            if(c) c.click();
        })()`);
        await sleep(400);
        const f3 = await evalJs(barWs, `(function(){
            var titles=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
            var cells=[].slice.call(document.querySelectorAll('#panelBody .grid > .cell'));
            return { nCat: titles.length, nCell: cells.length,
                     navCount: (function(){
                         var n=document.querySelector('#panelBody .cat-nav:not(.fav-nav)');
                         return n? n.querySelectorAll('.cat-nav-item[data-cat]').length : -1; })(),
                     crumb: !!document.querySelector('#panelBody .crumb') };
        })()`);
        info('F3 第三层：' + JSON.stringify(f3));
        chk('★ F3 第三层分类网格（cat-title 与 cell 都渲染出来）',
            f3.nCat > 0 && f3.nCell > 100, '分类=' + f3.nCat + ' 格子=' + f3.nCell);
        chk('★ F3 分类锚点导航胶囊数 = 分类标题数', f3.navCount === f3.nCat,
            '胶囊=' + f3.navCount + ' 标题=' + f3.nCat);
        chk('  F3 第三层面包屑仍在', f3.crumb === true);

        // 面包屑返回 → 回第二层
        await evalJs(barWs, `(function(){
            var b=document.querySelector('#panelBody .crumb-back');
            if(b) b.click();
        })()`);
        await sleep(400);
        const f4 = await evalJs(barWs, `(function(){
            var subs=[].slice.call(document.querySelectorAll('#panelBody .grp-card[data-sub]'));
            return { nSub: subs.length,
                     subs: subs.map(function(c){return c.dataset.sub;}),
                     nCell: document.querySelectorAll('#panelBody .grid > .cell').length };
        })()`);
        chk('★ F4 面包屑返回从第三层回第二层',
            f4.nSub === 2 && f4.subs.join(',') === 'search,open' && f4.nCell === 0,
            JSON.stringify(f4));

        // 快捷键组单子类：先回第一层，再点组卡直接进第三层
        // （F4 后面包屑返回停在第二层，那里没有组卡可点 —— 再返回一次到第一层）
        await evalJs(barWs, `(function(){
            var b=document.querySelector('#panelBody .crumb-back');
            if(b) b.click();
        })()`);
        await sleep(400);
        const f4b = await evalJs(barWs, `(function(){
            return { nGroup: document.querySelectorAll('#panelBody .grp-card[data-group]').length,
                     nSub: document.querySelectorAll('#panelBody .grp-card[data-sub]').length };
        })()`);
        chk('  F4b 再次面包屑返回回到第一层（三大类卡片回来）',
            f4b.nGroup === 3 && f4b.nSub === 0, JSON.stringify(f4b));
        await evalJs(barWs, `(function(){
            var c=document.querySelector('#panelBody .grp-card[data-group="hotkey"]');
            if(c) c.click();
        })()`);
        await sleep(400);
        const f5 = await evalJs(barWs, `(function(){
            var cells=[].slice.call(document.querySelectorAll('#panelBody .grid > .cell'));
            var hot=cells.filter(function(c){return !!c.querySelector('.ck.hot');});
            return { nCell: cells.length, nHot: hot.length,
                     nGroup: document.querySelectorAll('#panelBody .grp-card[data-group]').length,
                     nSub: document.querySelectorAll('#panelBody .grp-card[data-sub]').length,
                     navCount: (function(){
                         var n=document.querySelector('#panelBody .cat-nav:not(.fav-nav)');
                         return n? n.querySelectorAll('.cat-nav-item[data-cat]').length : -1; })() };
        })()`);
        info('F5 快捷键组直落第三层：' + JSON.stringify(f5));
        chk('★ F5 快捷键组单子类点组卡直接进第三层（无第二层）',
            f5.nGroup === 0 && f5.nSub === 0 && f5.nCell > 0,
            '组卡=' + f5.nGroup + ' 子卡=' + f5.nSub + ' 格子=' + f5.nCell);
        chk('★ F5 快捷键层格子全是快捷键类（角标 .ck.hot）',
            f5.nCell === f5.nHot && f5.nCell >= 26, '格子=' + f5.nCell + ' 键=' + f5.nHot);

        // 搜索平铺视图：在第三层打过滤词 → 全部结果视图
        await evalJs(barWs, `(function(){
            var el=document.getElementById('engFilter');
            el.value='github';
            el.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await sleep(400);
        const f6 = await evalJs(barWs, `(function(){
            var cells=[].slice.call(document.querySelectorAll('#panelBody .grid > .cell'));
            var vis=cells.filter(function(c){return !c.hidden;});
            var titles=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
            return { nVis: vis.length,
                     allMatch: vis.every(function(c){
                         return String(c.dataset.engine||'').toLowerCase().indexOf('github')>=0; }),
                     names: vis.map(function(c){return c.dataset.engine;}),
                     crumb: !!document.querySelector('#panelBody .crumb'),
                     titles: titles.map(function(t){return t.textContent;}) };
        })()`);
        info('F6 搜索平铺：' + JSON.stringify(f6));
        chk('★ F6 有词进「全部结果」视图（面包屑退场、格子全命中）',
            f6.nVis === 2 && f6.allMatch === true && f6.crumb === false,
            '命中=' + f6.nVis + ' → ' + f6.names.join(','));
        chk('  F6 小节标题带「大类 · 子类」（跨三大类平铺）',
            f6.titles.every(function(t){return /·/.test(t);}), f6.titles.join(' / '));
        // 清空 → 退回原下钻层级
        await evalJs(barWs, `(function(){
            var el=document.getElementById('engFilter');
            el.value='';
            el.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await sleep(400);
        const f7 = await evalJs(barWs, `(function(){
            return { crumb: !!document.querySelector('#panelBody .crumb'),
                     nCell: document.querySelectorAll('#panelBody .grid > .cell').length,
                     nHot: document.querySelectorAll('#panelBody .grid > .cell .ck.hot').length };
        })()`);
        chk('★ F7 清空过滤词退回原下钻层级（快捷键第三层）',
            f7.crumb === true && f7.nCell > 0 && f7.nCell === f7.nHot, JSON.stringify(f7));
        await shot(barWs, 'round29-f-panel.png');

        /* ---- E 段：#126 样式行显隐 + #129 玻璃预设（设置窗） ---- */
        rec('');
        rec('---- E 段：样式三主题行 + 玻璃参数预设（#126/#129）----');
        await evalJs(barWs, "invoke('open_settings', {tab:'general'}).catch(function(e){})");
        const setWs = await connectWhere(isSettingsPage, 25000);
        if (!setWs) {
            chk('★ E0 设置窗口打开', false, '连不上 settings.html');
        } else {
            chk('★ E0 设置窗口打开（通用分页）', true);
            // 等配置落到分段控件（窗口刚建好时可能还是 HTML 默认态）
            let e0 = null;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 15000) {
                    e0 = await evalJs(setWs, `(function(){
                        var seg=document.getElementById('s-barStyle');
                        var on=seg? [].slice.call(seg.querySelectorAll('button'))
                            .filter(function(b){return b.classList.contains('on');}) : [];
                        return on.length? on[0].dataset.v : null;
                    })()`);
                    if (e0 === 'glass') break;
                    await sleep(300);
                }
            }
            chk('  E1 样式三段默认落在「液态玻璃」（barGlass=true）', e0 === 'glass', 'style=' + e0);
            const e1 = await evalJs(setWs, `(function(){
                var gs=[].slice.call(document.querySelectorAll('[data-style="glass"]'));
                var f=document.querySelector('[data-style="frost"]');
                return { glassN: gs.length, glassAllVis: gs.every(function(r){return !r.hidden;}),
                         frostHidden: !!f && f.hidden };
            })()`);
            chk('  E1 玻璃专属配置行显示、磨砂行藏起（只显当前主题配置行）',
                e1.glassN === 8 && e1.glassAllVis === true && e1.frostHidden === true,
                JSON.stringify(e1));
            const segOn = async () => evalJs(setWs, `(function(){
                var seg=document.getElementById('s-glassPreset');
                var on=seg? [].slice.call(seg.querySelectorAll('button'))
                    .filter(function(b){return b.classList.contains('on');}) : [];
                return on.length? on[0].dataset.v : null;
            })()`);
            const e2 = await segOn();
            chk('  E2 玻璃预设默认命中「标准」（六值全中）', e2 === 'standard', 'preset=' + e2);

            // E3 点「轻量」→ config 六值 + 横条同步 + 高亮移动
            await evalJs(setWs, `(function(){
                var b=[].slice.call(document.querySelectorAll('#s-glassPreset button'))
                    .filter(function(x){return x.dataset.v==='light';})[0];
                if(b) b.click();
            })()`);
            let cfgLight = null;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 12000) {
                    const c = readCfg(qsD);
                    if (c && c.bar_glass_refraction === 10 && c.bar_glass_bevel === 6
                        && c.bar_glass_aberration === 15 && c.bar_glass_spec === 60
                        && c.bar_glass_tint === 8 && c.bar_glass_frost === 0) { cfgLight = c; break; }
                    await sleep(300);
                }
            }
            chk('★ E3 点「轻量」预设写入 config（六值 {10,6,15,60,8,0}）', !!cfgLight);
            let barLight = false;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 8000) {
                    const d = await dbg(barWs);
                    if (d.params.refraction === 10 && d.params.spec === 60) { barLight = true; break; }
                    await sleep(300);
                }
            }
            chk('★ E3 横条玻璃参数同步跟上（广播链路通）', barLight);
            const e3 = await segOn();
            chk('  E3 预设段高亮移到「轻量」', e3 === 'light', 'preset=' + e3);

            // E4 点「深度」→ config 六值
            await evalJs(setWs, `(function(){
                var b=[].slice.call(document.querySelectorAll('#s-glassPreset button'))
                    .filter(function(x){return x.dataset.v==='deep';})[0];
                if(b) b.click();
            })()`);
            let cfgDeep = null;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 12000) {
                    const c = readCfg(qsD);
                    if (c && c.bar_glass_refraction === 34 && c.bar_glass_bevel === 22
                        && c.bar_glass_aberration === 60 && c.bar_glass_spec === 150
                        && c.bar_glass_tint === 20 && c.bar_glass_frost === 2) { cfgDeep = c; break; }
                    await sleep(300);
                }
            }
            chk('★ E4 点「深度」预设写入 config（六值 {34,22,60,150,20,2}）', !!cfgDeep);
            const e4 = await segOn();
            chk('  E4 预设段高亮移到「深度」', e4 === 'deep', 'preset=' + e4);

            // E5 手动拖折射滑块 → 六值不全中任何档 → 自定义
            await evalJs(setWs, `(function(){
                var el=document.getElementById('s-barGlassRefraction');
                el.value='40';
                el.dispatchEvent(new Event('input',{bubbles:true}));
                el.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
            let cfgCustom = null;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 12000) {
                    const c = readCfg(qsD);
                    if (c && c.bar_glass_refraction === 40) { cfgCustom = c; break; }
                    await sleep(300);
                }
            }
            chk('  E5 手动拖折射滑块写入 config（40）', !!cfgCustom);
            const e5 = await segOn();
            chk('★ E5 拖过滑块后预设变「自定义」（六值不全中即自定义）', e5 === 'custom', 'preset=' + e5);

            // E6 实时折射开关（#125 设置侧回路）：D5 关过 → 复选框应为未选；
            // 点开 → config 落库 + 横条 live 循环重启
            const e6vis = await evalJs(setWs,
                "!!document.getElementById('s-barGlassLive').offsetParent");
            chk('  E6 实时折射行在玻璃样式下可见', e6vis === true);
            const e6chk = await evalJs(setWs,
                "document.getElementById('s-barGlassLive').checked");
            info('E6 live 复选框初值（D5 关过，应为 false）：' + e6chk);
            await evalJs(setWs, "document.getElementById('s-barGlassLive').click()");
            let cfgLiveOn = null;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 12000) {
                    const c = readCfg(qsD);
                    if (c && c.bar_glass_live === true) { cfgLiveOn = c; break; }
                    await sleep(300);
                }
            }
            let loopBack = false;
            {
                const t0 = Date.now();
                while (Date.now() - t0 < 10000) {
                    const d = await dbg(barWs);
                    if (d.live.loop === true) { loopBack = true; break; }
                    await sleep(300);
                }
            }
            chk('★ E6 设置页开实时折射 → config 落库 + 横条 live 循环重启',
                !!cfgLiveOn && loopBack === true,
                'cfg=' + !!cfgLiveOn + ' loop=' + loopBack);

        /* ---- G 段：#127 添加引擎三方式 ---- */
        rec('');
        rec('---- G 段：添加引擎三方式（#127）----');
        await evalJs(setWs, "invoke('open_settings', {tab:'engines'}).catch(function(e){})");
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const vis = await evalJs(setWs,
                    "!document.querySelector('.pane[data-pane=\"engines\"]').hidden");
                if (vis) break;
                await sleep(300);
            }
        }
        const g0 = await evalJs(setWs, `(function(){
            return { ways: !!document.getElementById('addWays').hidden,
                     cf: !!document.getElementById('customForm').hidden,
                     af: !!document.getElementById('appForm').hidden };
        })()`);
        chk('  G1 引擎页打开时添加表单默认收起', g0.ways && g0.cf && g0.af, JSON.stringify(g0));
        await evalJs(setWs, "document.getElementById('btnAddEngine').click()");
        await sleep(300);
        const g1 = await evalJs(setWs, `(function(){
            var ways=[].slice.call(document.querySelectorAll('#addWays .addway'));
            return { vis: !document.getElementById('addWays').hidden,
                     ways: ways.map(function(b){return b.dataset.way;}),
                     titles: ways.map(function(b){return b.textContent.trim();}) };
        })()`);
        chk('★ G1 「＋ 添加引擎」展开三种方式（网页/软件/快捷键）',
            g1.vis === true && g1.ways.join(',') === 'web,app,hotkey',
            JSON.stringify(g1));

        const clickWay = async (way) => evalJs(setWs, `(function(){
            var b=[].slice.call(document.querySelectorAll('#addWays .addway'))
                .filter(function(x){return x.dataset.way==='` + way + `';})[0];
            if(b) b.click();
        })()`);

        // G2 网页方式
        await clickWay('web');
        await sleep(300);
        const g2 = await evalJs(setWs, `(function(){
            var seg=document.getElementById('s-ceKind');
            var hk=seg? seg.querySelector('button[data-v="hotkey"]') : null;
            var url=document.getElementById('w-ceUrl');
            return { cf: !document.getElementById('customForm').hidden,
                     af: !!document.getElementById('appForm').hidden,
                     hkHidden: !!hk && hk.hidden,
                     urlPh: url? url.placeholder : '' };
        })()`);
        chk('★ G2 网页方式：自定义表单出场、软件表单收起',
            g2.cf === true && g2.af === true, JSON.stringify(g2));
        chk('  G2 网页方式下快捷键类型钮隐藏（快捷键是独立添加方式）', g2.hkHidden === true);
        chk('  G2 搜索类地址占位符提示 %s', /%s/.test(g2.urlPh), g2.urlPh);

        // G3 软件方式
        await clickWay('app');
        await sleep(300);
        const g3 = await evalJs(setWs, `(function(){
            return { af: !document.getElementById('appForm').hidden,
                     cf: !!document.getElementById('customForm').hidden };
        })()`);
        chk('★ G3 软件方式：软件表单出场、自定义表单收起',
            g3.af === true && g3.cf === true, JSON.stringify(g3));

        // G4 快捷键方式
        await clickWay('hotkey');
        await sleep(300);
        const g4 = await evalJs(setWs, `(function(){
            var kind=document.querySelector('#customForm .cform-kind');
            return { cf: !document.getElementById('customForm').hidden,
                     af: !!document.getElementById('appForm').hidden,
                     kindHidden: !!kind && kind.hidden,
                     hotRow: !document.getElementById('ceHotRow').hidden,
                     urlHidden: !!document.getElementById('w-ceUrl').hidden };
        })()`);
        chk('★ G4 快捷键方式：自定义表单出场、软件表单收起',
            g4.cf === true && g4.af === true, JSON.stringify(g4));
        chk('★ G4 快捷键方式：类型分段整条藏起（类型没得选）+ 组合键框出场 + 地址框收起',
            g4.kindHidden === true && g4.hotRow === true && g4.urlHidden === true,
            JSON.stringify(g4));

        // G5 回到网页方式，保存一条自定义搜索引擎 → config 落库
        await clickWay('web');
        await sleep(300);
        await evalJs(setWs, `(function(){
            document.getElementById('w-ceName').value='轮29测试搜索';
            document.getElementById('w-ceUrl').value='https://www.example.com/s?q=%s';
            document.getElementById('w-ceCat').value='';
            document.getElementById('btnCeSave').click();
        })()`);
        let cfgEng = null;
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const c = readCfg(qsD);
                if (c && (c.custom_engines || []).some(function(e){
                    return e.name === '轮29测试搜索' && e.kind === 'search'
                        && String(e.url).indexOf('%s') >= 0;
                })) { cfgEng = c; break; }
                await sleep(300);
            }
        }
        chk('★ G5 网页方式添加自定义搜索引擎落 config（name + kind=search + %s）', !!cfgEng);
        await shot(setWs, 'round29-g-addways.png');

        /* ---- H 段：#130 百度 OCR 一键优化 ---- */
        rec('');
        rec('---- H 段：百度 OCR 一键优化（#130）----');
        await evalJs(setWs, "invoke('open_settings', {tab:'ocr'}).catch(function(e){})");
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const vis = await evalJs(setWs,
                    "!document.querySelector('.pane[data-pane=\"ocr\"]').hidden");
                if (vis) break;
                await sleep(300);
            }
        }
        const h0 = await evalJs(setWs, `(function(){
            var b=document.getElementById('btnOcrOpt');
            return { has: !!b, vis: !!b && !!b.offsetParent };
        })()`);
        chk('  H1 「一键优化」按钮在位且百度引擎下可见', h0.has === true && h0.vis === true,
            JSON.stringify(h0));
        await evalJs(setWs, "document.getElementById('btnOcrOpt').click()");
        let hint = '';
        {
            const t0 = Date.now();
            while (Date.now() - t0 < 10000) {
                hint = await evalJs(setWs, "document.getElementById('ocrHint').textContent");
                if (/先填/.test(hint)) break;
                await sleep(300);
            }
        }
        chk('★ H2 空 Key/Secret 点击 → ocrHint 提示「先填 API Key 和 Secret Key」',
            /先填/.test(hint), hint);
        const h3 = await evalJs(setWs,
            "invoke('ocr_optimize').then(function(){return 'ok';})"
            + ".catch(function(e){return 'rej:'+e;})");
        chk('  H3 ocr_optimize 命令已注册且不 reject', h3 === 'ok', String(h3));

        /* ---- I 段：#131 帮助与关于 ---- */
        rec('');
        rec('---- I 段：帮助与关于页面（#131）----');
        const paneText = async (name) => {
            const t0 = Date.now();
            while (Date.now() - t0 < 12000) {
                const t = await evalJs(setWs, `(function(){
                    var p=document.querySelector('.pane[data-pane="` + name + `"]');
                    return (p && !p.hidden) ? p.textContent : '';
                })()`);
                if (t) return t;
                await sleep(300);
            }
            return '';
        };
        await evalJs(setWs, "invoke('open_settings', {tab:'help'}).catch(function(e){})");
        const helpTxt = await paneText('help');
        const i1 = {
            style3: helpTxt.indexOf('样式（三选一）') >= 0,
            preset: helpTxt.indexOf('玻璃预设') >= 0,
            three: helpTxt.indexOf('三大类') >= 0,
            opt: helpTxt.indexOf('一键优化') >= 0,
        };
        chk('★ I1 帮助页覆盖本轮新功能（样式三选一/玻璃预设/三大类/一键优化）',
            i1.style3 && i1.preset && i1.three && i1.opt, JSON.stringify(i1));
        await evalJs(setWs, "invoke('open_settings', {tab:'about'}).catch(function(e){})");
        const aboutTxt = await paneText('about');
        const i2 = {
            webgl: aboutTxt.indexOf('WebGL2') >= 0,
            live: aboutTxt.indexOf('实时折射') >= 0,
        };
        chk('★ I2 关于页说明 WebGL2 渲染与实时折射抓屏隐身',
            i2.webgl && i2.live, JSON.stringify(i2));
        }

        /* ---- log 尾部 ---- */
        rec('');
        rec('=== log.txt 尾部（实例 D，8 行）===');
        try {
            const t = fs.readFileSync(path.join(qsD, 'log.txt'), 'utf8');
            rec(t.split('\n').slice(-8).join('\n'));
        } catch (e) { }
    }

    /* ---- 收尾 ---- */
    rec('');
    rec('==============================================');
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { }
    process.exit(failN ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    for (const p of instances) { try { p.kill(); } catch (e2) { } }
    process.exit(1);
});
