/* ============================================================================
 *  专项探针：轮 22 —— 「更多引擎」面板的三个症状
 *
 *  用户在真机上报的三件事：
 *    ① 点分类跳过去之后，目标被「收藏夹 + 分类导航」那条吸附头挡住，
 *       要再滚一下才看到（上一轮已修，这里做回归 + 复查）；
 *    ② **点「工具」，内容跳到了工具，但导航高亮显示的是「财经」**——对不上；
 *    ③ **有时候点了目录之后会莫名其妙跳回最上面**。
 *
 *  ②③ 单靠"点完等一会儿再断言"抓不到，因为它们是**过程性**的：
 *  所以这个探针给面板装上仪表，把点击之后 4 秒内的每一次变化都录下来：
 *    · `navOn` / `scrollTop` / `covered` 每 100ms 采一次
 *    · MutationObserver 数「面板被整块重画」的次数（renderPanel 会清空 panelBody）
 *    · 自己挂一个 qs://config 监听，数「配置广播」次数
 *    · 包一层 panelBody.scrollTo，记下程序化滚动的目标值
 *
 *  用法：node tools/round22-probe.js
 *  输出：tools/round22-probe.txt + 截图
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round22-probe.txt');
const TAG = '-probe-r22';
const PORT = 9347;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

let passN = 0, failN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

const PENDING_STOP = [];
async function waitFor(desc, fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
        let v = false;
        try { v = await fn(); } catch (e) { v = false; }
        if (v) return true;
        await sleep(200);
    }
    info('等待超时：' + desc);
    return false;
}

/* ---------------------------- CDP ---------------------------- */
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
    if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
        throw new Error('JS: ' + String(desc).slice(0, 260) + ' | ' + expr.slice(0, 120));
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
            try { require('events').setMaxListeners(50, ws); } catch (e) { }
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

async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        info('截图 ' + name);
    } catch (e) { info('截图失败 ' + name, e.message); }
}

/* ============================================================================
 *  面板仪表
 * ========================================================================== */
const PATCH = `(function(){
    window.__r22 = { rebuilds: 0, configEvents: 0, scrollWrites: [] };
    var body = document.getElementById('panelBody');
    // ① 数「整块重画」：renderPanel 会先 textContent='' 再重建
    new MutationObserver(function(muts){
        for (var m of muts) {
            if (m.removedNodes && m.removedNodes.length > 3) { window.__r22.rebuilds++; break; }
        }
    }).observe(body, { childList: true });
    // ② 数配置广播（面板被重画的头号嫌疑）
    try { window.__TAURI__.event.listen('qs://config', function(){
        window.__r22.configEvents++; });
    } catch (e) { }
    // ②b 分别数 show / hidden，并记下每次 show 的 payload ——
    //     「面板被谁收掉的」必须能指名道姓：
    //       · qs://show    → 横条被重新弹出（旧代码无条件收面板 = 用户的"跳回最上面"）
    //       · qs://hidden  → 横条自己隐藏了（收面板是对的）
    __r22.shows = [];
    __r22.hidden = 0;
    try {
        window.__TAURI__.event.listen('qs://show', function(ev){
            var p = (ev && ev.payload) || {};
            __r22.shows.push({ t: Math.round(performance.now()),
                sig: [p.text || '', p.isUrl ? 1 : 0, p.viaCopy ? 1 : 0, p.ocrOnly ? 1 : 0].join('|'),
                panelOpen: !document.getElementById('panel').hidden });
        });
        window.__TAURI__.event.listen('qs://hidden', function(){
            __r22.hidden++; });
    } catch (e) { }
    // ②c 包一层 togglePanel：谁在什么时候把面板关了
    __r22.closes = [];
    var origToggle = window.togglePanel;
    if (typeof origToggle === 'function') {
        window.togglePanel = function(force){
            var before = !document.getElementById('panel').hidden;
            var r = origToggle.apply(this, arguments);
            var after = !document.getElementById('panel').hidden;
            if (before && !after) {
                __r22.closes.push({ t: Math.round(performance.now()),
                    via: new Error().stack.split(String.fromCharCode(10)).slice(1, 4).join(' <- ').slice(0, 200) });
            }
            return r;
        };
    }
    // ③ 记下每一次程序化滚动的目标
    var orig = body.scrollTo ? body.scrollTo.bind(body) : null;
    if (orig) {
        body.scrollTo = function(o){
            window.__r22.scrollWrites.push({
                t: Math.round(performance.now()),
                top: (o && typeof o === 'object') ? o.top : o
            });
            return orig.apply(body, arguments);
        };
    }
    return 1;
})()`;

const SAMPLE = `(function(){
    var body = document.getElementById('panelBody');
    var sticky = body.querySelector('.panel-sticky');
    if (!body || !sticky) return null;
    var sb = sticky.getBoundingClientRect();
    var on = body.querySelector('.cat-nav-item.on');
    var out = { on: on ? on.dataset.cat : null, scrollTop: Math.round(body.scrollTop),
                stickyH: Math.round(sticky.offsetHeight), stickyBottom: Math.round(sb.bottom) };
    if (on) {
        var t = body.querySelector('.cat-title[data-cat="' + (window.CSS && CSS.escape ? CSS.escape(on.dataset.cat) : on.dataset.cat) + '"]');
        if (t) out.onTitleTop = Math.round(t.getBoundingClientRect().top);
    }
    return out;
})()`;

function coverOf(cat) {
    return `(function(){
        var body = document.getElementById('panelBody');
        var s = body.querySelector('.panel-sticky');
        var t = body.querySelector('.cat-title[data-cat=${JSON.stringify(cat)}]');
        if (!s || !t) return null;
        var sb = s.getBoundingClientRect(), tb = t.getBoundingClientRect();
        var bb = body.getBoundingClientRect();
        return { titleTop: Math.round(tb.top), stickyBottom: Math.round(sb.bottom),
                 stickyH: Math.round(s.offsetHeight),
                 covered: tb.top < sb.bottom - 1,
                 gap: Math.round(tb.top - sb.bottom),
                 /* ⚠ "不被遮挡"必须**同时**要求它在视口里。
                  * 只写「tb.top >= bb.top」的话，"滚动被打断、内容停在上方/下方老远"
                  * 这种情况会被判成"没被遮挡"—— 那是**假通过**（本轮真踩到了：
                  * 面板被收起后 scrollTop=0、目标在下方 3792px 处，却判成 PASS）。 */
                 inView: tb.top >= bb.top && tb.bottom <= bb.bottom };
    })()`;
}

async function ensurePanelOpen(ws) {
    const hOf = `(function(){var s=document.querySelector('#panelBody .panel-sticky');
        return s ? Math.round(s.offsetHeight) : 0})()`;
    if ((await evalJs(ws, hOf)) > 0) return true;
    await evalJs(ws, "document.getElementById('btnMore').click(); 1");
    await waitFor('面板重新展开', async () => (await evalJs(ws, hOf)) > 0, 10000);
    return (await evalJs(ws, hOf)) > 0;
}
async function waitScrollSettled(ws, ms) {
    const t0 = Date.now();
    let last = null, same = 0, moved = false;
    while (Date.now() - t0 < (ms || 8000)) {
        const cur = await evalJs(ws, "Math.round(document.getElementById('panelBody').scrollTop)");
        if (last !== null) {
            if (cur === last) same++; else { same = 0; moved = true; }
            if (moved && same >= 3) return true;
        }
        last = cur;
        await sleep(150);
    }
    return false;
}
const clickCat = (ws, cat) => evalJs(ws, `(function(){
    var b = document.querySelector('#panelBody .cat-nav-item[data-cat=${JSON.stringify(cat)}]');
    if (b) b.click();
    return 1;
})()`);

/* ============================================================================
 *  主流程
 * ========================================================================== */
(async function main() {
    rec('=== 轮 22 专项探针：「更多引擎」面板 ===');
    rec('');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r22-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    rec('隔离实例数据目录：' + qs);

    const mkItem = (id, t) => ({ id, kind: 'text', text: t, html: '', image: '', remark: '' });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.trigger_select = false; c.trigger_copy = false; c.ocr_enable = false;
        c.auto_start = false; c.auto_color = false; c.fav_hotkey = '';
        c.webdav_url = ''; c.webdav_on_start = false; c.webdav_on_exit = false;
        c.backup_dir = '';
        // ★ 放 **8 个**收藏夹目录：这样吸附头里那条 fav 行一定会换行，
        //   吸附头比之前测的（2 个目录 → 122px）高得多 —— 更接近真机，
        //   也更容易暴露"高度算少了"的问题。
        c.favorites = [];
        for (let i = 1; i <= 8; i++) {
            c.favorites.push({
                id: 'pg' + i, name: '目录' + i, icon: '',
                items: [mkItem('pi' + i, '内容' + i)], children: [],
            });
        }
        c.bar_list = ['百度', 'Google'];
        c.bar_blur = 0;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('已启动隔离实例 pid=' + proc.pid);
    const stop = () => { try { proc.kill(); } catch (e) { } };
    PENDING_STOP.push(stop);

    const ws = await connectWhere(isBarPage, 30000);
    if (!ws) { rec('连不上横条页面，放弃'); stop(); flush(); process.exit(1); }
    await cdp(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });
    chk('横条页面 IPC 已就绪', await waitFor('IPC', async () => {
        try { return (await evalJs(ws, "typeof invoke === 'function'")) === true; }
        catch (e) { return false; }
    }, 25000));

    await evalJs(ws, "document.getElementById('btnMore').click(); 1");
    // 等收藏夹入口那一条也渲染出来：两条 nav 都在时吸附头最高，才是真机的形态
    await waitFor('收藏夹入口渲染出来',
        async () => (await evalJs(ws,
            "document.querySelectorAll('#panelBody .fav-nav .cat-nav-item').length")) > 0, 8000);
    await waitFor('面板渲染出分类导航',
        async () => (await evalJs(ws, "document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item').length")) > 5, 15000);
    await evalJs(ws, PATCH);
    await sleep(500);

    const navCats = await evalJs(ws,
        "Array.from(document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item')).map(function(b){return b.dataset.cat})");
    const navCount = await evalJs(ws,
        "document.querySelectorAll('#panelBody .fav-nav .cat-nav-item').length");
    info('分类导航 ' + navCats.length + ' 项；收藏夹入口 ' + navCount + ' 个');
    const stickyH = await evalJs(ws,
        "(function(){var s=document.querySelector('#panelBody .panel-sticky');return s?Math.round(s.offsetHeight):0})()");
    info('8 个收藏夹目录时，吸附头高度 = ' + stickyH + 'px');
    await shot(ws, '_r22-00-panel.png');

    /* ==================================================================
     * ① 用户的原话场景：点「工具」，录 4 秒的过程
     * ================================================================ */
    rec('');
    rec('--- ① 点「工具」并录下 4 秒内的每一次变化（用户报的"高亮显示成财经"）---');
    const target = navCats.includes('工具') ? '工具' : navCats[navCats.length - 1];
    await ensurePanelOpen(ws);
    await evalJs(ws, PATCH);            // （重新）装一遍并重置计数器
    await clickCat(ws, target);

    const trace = [];
    for (let i = 0; i < 40; i++) {      // 40 × 100ms = 4 秒
        const s = await evalJs(ws, SAMPLE);
        trace.push(s ? { t: i * 100, on: s.on, st: s.scrollTop } : { t: i * 100, on: '(面板被收起)' });
        await sleep(100);
    }
    const distinct = [];
    for (const p of trace) {
        const key = p.on + '@' + p.st;
        if (!distinct.length || distinct[distinct.length - 1].key !== key) distinct.push({ key, t: p.t });
    }
    rec('    时间轴（只在变化时记一行）：');
    for (const d of distinct) rec('      ' + String(d.t).padStart(5) + 'ms  ' + d.key);

    const after = await evalJs(ws,
        'JSON.stringify({rebuilds: __r22.rebuilds, configEvents: __r22.configEvents,'
        + ' hiddenEvents: __r22.hidden, scrollWrites: __r22.scrollWrites})');
    info('点击期间：' + after);
    info('期间的 qs://show：' + (await evalJs(ws, 'JSON.stringify(__r22.shows)')));
    info('面板被关掉的调用栈：' + (await evalJs(ws, 'JSON.stringify(__r22.closes)')));

    await ensurePanelOpen(ws);
    await waitScrollSettled(ws, 8000);
    const c1 = await evalJs(ws, coverOf(target));
    const on1 = await evalJs(ws, SAMPLE);
    info('稳定后：' + JSON.stringify(c1) + ' 高亮=' + (on1 && on1.on));
    chk('① 点「' + target + '」后目标不被吸附头遮挡、且确实停在视口里',
        !!c1 && c1.covered === false && c1.inView === true,
        c1 ? ('gap=' + c1.gap + 'px inView=' + c1.inView) : '(量不到)');
    chk('① 稳定后高亮就是被点的那个分类（不是"财经"之类的中途值）',
        !!on1 && on1.on === target, on1 && on1.on);
    await shot(ws, '_r22-01-jianggong.png');

    /* ==================================================================
     * ② 逐个点一遍所有分类：每次都验「不遮挡 + 高亮对得上」
     * ================================================================ */
    rec('');
    rec('--- ② 23 个分类逐个点一遍 ---');
    const bad = [];
    for (const cat of navCats) {
        /* 横条在失焦时会自动收起（这台机器上人还在用电脑），面板一中途收掉
         * 元素矩形就全变 0。所以每个分类最多试 3 次，**量到有效结果才算数** ——
         * 否则偶发的一次环境干扰会把结论带偏。 */
        let cc = null, ss = null, why = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
            await ensurePanelOpen(ws);
            await clickCat(ws, cat);
            await waitScrollSettled(ws, 6000);
            cc = await evalJs(ws, coverOf(cat));
            ss = await evalJs(ws, SAMPLE);
            if (ss && ss.stickyBottom > 0 && ss.scrollTop > 0 && cc && cc.inView) break;
            why = '(第' + attempt + '次测量时面板被环境收起了)';
        }
        const okCover = !!cc && cc.stickyBottom > 0 && cc.covered === false && cc.inView === true;
        const okOn = !!ss && ss.on === cat;
        if (!okCover || !okOn) {
            bad.push(cat + '(遮=' + (cc && cc.covered) + ' inView=' + (cc && cc.inView)
                + ' 高亮=' + (ss && ss.on) + ')' + why);
        }
    }
    chk('② 23 个分类：跳过去都不被遮挡、且高亮都等于被点的那个',
        bad.length === 0, bad.length ? ('有问题的：' + bad.join(' | ')) : '23 个全对');

    /* ==================================================================
     * ③ 连续快速点击（"莫名其妙跳回最上面"的嫌疑场景）
     * ================================================================ */
    rec('');
    rec('--- ③ 连续快速点两个分类 ---');
    const pairs = [[navCats[2], navCats[8]], [navCats[navCats.length - 1], navCats[navCats.length - 5]],
                   [navCats[12], navCats[3]]];
    const badFast = [];
    for (const [a, b] of pairs) {
        await ensurePanelOpen(ws);
        await clickCat(ws, a);
        await sleep(120);              // 动画进行中就点第二下
        await clickCat(ws, b);
        await waitScrollSettled(ws, 8000);
        const ss = await evalJs(ws, SAMPLE);
        const cc = await evalJs(ws, coverOf(b));
        const ok = ss && ss.on === b && cc && cc.covered === false && cc.inView === true && ss.scrollTop > 0;
        if (!ok) badFast.push(a + '→' + b + ' 最终高亮=' + (ss && ss.on) + ' scrollTop=' + (ss && ss.scrollTop));
    }
    chk('③ 连点两下：最终停在后点的那个分类，且不在最上面',
        badFast.length === 0, badFast.length ? badFast.join(' | ') : pairs.map((p) => p.join('→')).join(' / '));

    /* ==================================================================
     * ④ 滚动之后再点：会不会被配置广播重画、跳回顶部
     * ================================================================ */
    rec('');
    rec('--- ④ 点完之后静置 5 秒，看有没有"被重画/跳回顶部" ---');
    await ensurePanelOpen(ws);
    await clickCat(ws, navCats[Math.floor(navCats.length / 2)]);
    await waitScrollSettled(ws, 6000);
    const s0 = await evalJs(ws, SAMPLE);
    await evalJs(ws, 'window.__r22.rebuilds = 0; window.__r22.configEvents = 0; 1');
    await sleep(5000);
    const s1 = await evalJs(ws, SAMPLE);
    const cnt = await evalJs(ws, 'JSON.stringify({rebuilds: __r22.rebuilds, configEvents: __r22.configEvents})');
    info('静置 5 秒：' + cnt + '；scrollTop ' + (s0 && s0.scrollTop) + ' → ' + (s1 && s1.scrollTop));
    chk('④ 静置期间面板没有被整块重画', /"rebuilds":0/.test(cnt), cnt);
    chk('④ 静置期间滚动位置没有跳到最上面', !!s1 && s1.scrollTop > 0,
        s1 && String(s1.scrollTop));

    /* ---------------- 收尾 ---------------- */
    rec('');
    rec('============================================================');
    rec('  通过 ' + passN + ' 项，失败 ' + failN + ' 项');
    rec('============================================================');
    stop();
    flush();
    process.exit(failN === 0 ? 0 : 1);
})().catch((e) => {
    rec('探针自己抛异常了：' + (e && e.stack || e));
    try { PENDING_STOP.forEach((f) => f()); } catch (err) { }
    flush();
    process.exit(1);
});
