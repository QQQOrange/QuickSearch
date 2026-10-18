/* ============================================================================
 *  专项探针：「更多引擎」面板的滚动行为（本轮用户报的两条）
 *
 *  本轮要证的两件事：
 *    ① 【收藏夹分类不被隐藏】引擎面板里，收藏夹入口排在引擎分类导航**上面**。
 *       以前两条 nav 各自 `position:sticky; top:0` 钉在同一条顶边，滚下去之后
 *       后出现的引擎分类导航会盖住收藏夹入口 —— 用户看到"滚一下收藏夹分类就被
 *       隐藏了"。现在两条 nav 装进同一个 sticky 容器，滚动到底之后：
 *         · 收藏夹入口仍顶在 panel-body 顶端（sticky 生效）；
 *         · 引擎分类导航紧挨在它下面，两者不重叠；
 *         · elementFromPoint 命中收藏夹入口本身（说明没被压在下面）。
 *       并且做一次 **A/B 对照**：把两条 nav 搬回 panel-body 直接子节点（= 旧结构，
 *       恢复基础 .cat-nav 的 sticky），同样的滚动下 elementFromPoint 会命中
 *       引擎分类导航 —— 直接证明"被盖住"就是旧 bug 的机制。
 *    ② 【滚动位置每次打开重置】滚到底 → 收起面板 → 重新打开 → panelBody.scrollTop
 *       必须是 0。根因是 panelBody 是常驻节点，Chromium 在"同一帧先删后加"时
 *       scrollHeight 从未掉到 0，滚动量被原样保留，必须显式归零。
 *
 *  做法：另起一个测试实例（QS_INSTANCE_TAG + --bar），全部操作走 CDP 的 DOM 调用，
 *        不碰用户的全局输入。临时配置里塞带内容的收藏树（不然收藏夹入口是空的），
 *        并关掉 trigger_select / trigger_copy / ocr_enable。
 *
 *  用法：node tools/panel-scroll-probe.js
 *  输出：tools/panel-scroll-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'panel-scroll-probe.txt');
const PORT = 9339;
const TAG = '-probe-scroll';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

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
/** 把当前面板区域截一张（肉眼证据）。clip 用 CSS px。 */
async function shot(ws, name, clip) {
    const r = await cdp(ws, 'Page.captureScreenshot', clip
        ? { format: 'png', clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }, captureBeyondViewport: true }
        : { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
    rec('  [截图] ' + name);
}

async function connect(sub) {    const t0 = Date.now();
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

/* ---------------- 页面侧采集 ----------------
 * 一律用 `:scope >` / 精确选择器。踩过的坑：g.querySelector('.x') 会捞到**子孙**。 */
const SNAP = `(function(){
  var pb = document.getElementById('panelBody');
  var pbr = pb.getBoundingClientRect();
  var hd = document.querySelector('.panel-sticky');
  /* ⚠ 用**全局**选择器，不用后代选择器限定在 sticky 头里：A/B 那段会把两条 nav
   *   搬出 sticky 头（复原旧结构），那时按后代选择器查就是 null、量不到东西。 */
  var fav = document.querySelector('.cat-nav.fav-nav');
  var eng = document.querySelector('.cat-nav:not(.fav-nav)');
  var R = function(el){ if(!el) return null; var b = el.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  var hit = function(el){
    if(!el) return null; var b = el.getBoundingClientRect();
    if(b.height <= 0 || b.width <= 0) return 'ZERO';
    var e = document.elementFromPoint(Math.round(b.left + b.width/2), Math.round(b.top + b.height/2));
    if(!e) return 'null';
    return { tag: e.tagName, text: (e.textContent||'').slice(0,10),
             isFav: !!(e.closest && e.closest('.fav-entry')),
             isEngNav: !!(e.closest && e.closest('.cat-nav-item') && !e.closest('.fav-entry')),
             inHead: !!(e.closest && e.closest('.panel-sticky')) };
  };
  return {
    hidden: !!document.getElementById('panel').hidden,
    innerW: window.innerWidth, innerH: window.innerHeight,
    outerW: window.outerWidth, outerH: window.outerHeight,
    docW: document.documentElement.clientWidth, docH: document.documentElement.clientHeight,
    vis: document.visibilityState,
    scrollTop: Math.round(pb.scrollTop),
    scrollMax: Math.round(pb.scrollHeight - pb.clientHeight),
    body: R(pb), head: R(hd), fav: R(fav), eng: R(eng),
    favInHead: !!(fav && fav.closest && fav.closest('.panel-sticky')),
    favCount: document.querySelectorAll('.cat-nav.fav-nav .fav-entry').length,
    engCount: document.querySelectorAll('.cat-nav:not(.fav-nav) .cat-nav-item:not(.fav-entry)').length,
    headPos: hd ? getComputedStyle(hd).position : null,
    favPos: fav ? getComputedStyle(fav).position : null,
    engPos: eng ? getComputedStyle(eng).position : null,
    hitFav: hit(document.querySelector('.cat-nav.fav-nav .fav-entry')),
    hitEng: hit(document.querySelector('.cat-nav:not(.fav-nav) .cat-nav-item:not(.fav-entry)'))
  };
})()`;

/** 把两条 nav 从 sticky 头里搬回 panelBody（= 复原旧结构，基础 .cat-nav 的 sticky 重新生效） */
const TO_LEGACY = `(function(){
  var hd = document.querySelector('.panel-sticky');
  if (!hd) return 'NO_HEAD';
  var fav = hd.querySelector(':scope > .cat-nav.fav-nav');
  var eng = hd.querySelector(':scope > .cat-nav:not(.fav-nav)');
  hd.parentNode.insertBefore(fav, hd);
  if (eng) hd.parentNode.insertBefore(eng, hd);
  hd.remove();
  var pb = document.getElementById('panelBody');
  var f = document.querySelector('.cat-nav.fav-nav');
  return { favPos: getComputedStyle(f).position,
           engPos: eng ? getComputedStyle(eng).position : null,
           headGone: !document.querySelector('.panel-sticky') };
})()`;

const SCROLL_BOTTOM = "(function(){var pb=document.getElementById('panelBody');"
    + "pb.scrollTop = pb.scrollHeight; return Math.round(pb.scrollTop);})()";

/** 从 log.txt 里读最后一条 layout_bar 报上来的窗口 CSS 尺寸 [w,h] */
function lastCss(txt) {
    const m = txt.match(/layout_bar css=\(([\-\d,]+)\)/g);
    if (!m) return null;
    const nums = m[m.length - 1].match(/\(([\-\d,]+)\)/)[1].split(',').map(Number);
    return [nums[0], nums[1]];
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-scroll-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const mkItem = (id, t) => ({ id, kind: 'text', text: t, html: '', image: '', remark: '' });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        c.trigger_select = false; c.trigger_copy = false; c.ocr_enable = false;
        c.auto_start = false; c.delay_ms = 0;
        c.fav_panel_sizes = {};
        c.favorites = [
            { id: 'sg1', name: '滚动甲', icon: '', items: [mkItem('si1', '甲内容')], children: [] },
            { id: 'sg2', name: '滚动乙', icon: '', items: [mkItem('si2', '乙内容')], children: [] },
        ];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    const readLog = () => { try { return fs.readFileSync(logp, 'utf8'); } catch (e) { return ''; } };
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid + '（QS_INSTANCE_TAG=' + TAG + ' + --bar；全程走 CDP，不碰全局输入）');
    sleep(9000);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上（端口 ' + PORT + '）'); try { proc.kill(); } catch (e) { } flush(); process.exit(0); }

    const cats = await evalJs(ws, "CATALOG && CATALOG.categories ? CATALOG.categories.length : -1");
    rec('引擎分类数 = ' + cats + '（>1 才会画分类导航）');

    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(900);
    /* 探针自备一个"够大的画布"。
     *
     * 为什么不靠应用自己把窗口撑开：--bar 弹出来的横条随时可能被**真实用户的一次点击**
     * （点在横条外）收起来 —— 收起会清掉锚点，之后所有 layout_bar 一律走
     * 「尚无锚点，只记录尺寸、不摆放窗口」，窗口就停在横条那么大（实测 355x77），
     * 面板整块被裁掉，`elementFromPoint` 的采样点直接落到视口外返回 null。
     *   这条不是产品 bug（用户真要开面板时横条必然是显示着的、锚点在），只是探针跑在
     * 一台有人在用的机器上。sticky / 滚动归零这些行为跟窗口尺寸无关，
     * 探针只要一块够大的画布来采样即可 —— 所以显式 grow_bar 一下。
     *   ⚠ grow_bar 在 `!shown` 时会直接返回；点开面板会先走一次 layout_bar（它把
     *     shown 置 true），所以这里调用是有效的。 */
    await evalJs(ws, "window.__TAURI__.core.invoke('grow_bar', {need_w: 660, need_h: 640})"
        + ".then(function(){return 'ok'}).catch(function(e){return 'err:'+e})");
    sleep(500);
    rec('探针自备视口：inner=' + await evalJs(ws, 'window.innerWidth + "x" + window.innerHeight'));

    const S0 = await evalJs(ws, SNAP);
    rec('');
    rec('=== 结构 ===');
    rec('  sticky 头 position=' + S0.headPos + '  收藏夹 nav position=' + S0.favPos
        + '  引擎分类 nav position=' + S0.engPos);
    rec('  头 ' + JSON.stringify(S0.head) + '  收藏夹 nav ' + JSON.stringify(S0.fav)
        + '  引擎分类 nav ' + JSON.stringify(S0.eng));
    rec('  panel-body ' + JSON.stringify(S0.body) + '  收藏夹入口 ' + S0.favCount + ' 个 / 分类胶囊 ' + S0.engCount + ' 个');

    /* ---------------- ① 滚到底，收藏夹分类还在 ---------------- */
    rec('');
    rec('=== ① 滚到底：收藏夹分类必须仍可见、且没被引擎分类盖住 ===');
    await evalJs(ws, SCROLL_BOTTOM);
    sleep(500);
    const S1 = await evalJs(ws, SNAP);
    rec('  滚到底 scrollTop=' + S1.scrollTop + ' / 最大 ' + S1.scrollMax
        + '  inner=' + S1.innerW + 'x' + S1.innerH
        + ' outer=' + S1.outerW + 'x' + S1.outerH
        + ' docEl=' + S1.docW + 'x' + S1.docH + ' vis=' + S1.vis);
    rec('  sticky 头 ' + JSON.stringify(S1.head) + '（panel-body 顶边 y=' + S1.body.y + '）'
        + ' 后端最近一次 layout_bar css=' + JSON.stringify(lastCss(readLog())));
    rec('  收藏夹 nav ' + JSON.stringify(S1.fav) + '  引擎分类 nav ' + JSON.stringify(S1.eng));
    rec('  elementFromPoint(收藏夹入口中心) = ' + JSON.stringify(S1.hitFav));
    rec('  elementFromPoint(引擎分类胶囊中心) = ' + JSON.stringify(S1.hitEng));

    /* 被钉住的是外层 sticky 头，收藏夹 nav 坐在头里（头有 padding:6px，所以竖直上
     * 比头低 6px）。断言要按这个结构写，别拿 nav.y 直接跟 body.y 比。 */
    const tol = 4;
    const headPinned = !!S1.head && Math.abs(S1.head.y - S1.body.y) <= tol;
    const favVisible = !!S1.fav && S1.favInHead === true && S1.fav.h > 0;
    const noOverlap = !!S1.fav && !!S1.eng && S1.eng.y >= S1.fav.y + S1.fav.h - 2;
    const favClickable = !!S1.hitFav && S1.hitFav.isFav === true;
    const engClickable = !!S1.hitEng && S1.hitEng.isEngNav === true;
    const scrolledReal = S1.scrollMax > 20 && S1.scrollTop > 20;
    rec('  → sticky 头钉在面板顶端     : ' + (headPinned ? 'PASS' : 'FAIL')
        + '（head.y=' + (S1.head && S1.head.y) + ' body.y=' + S1.body.y + '）');
    rec('  → 收藏夹 nav 就在这个头里    : ' + (favVisible ? 'PASS' : 'FAIL')
        + '（favInHead=' + S1.favInHead + ' fav.h=' + (S1.fav && S1.fav.h) + '）');
    rec('  → 引擎分类在它下面不重叠    : ' + (noOverlap ? 'PASS' : 'FAIL')
        + '（eng.y=' + (S1.eng && S1.eng.y) + ' ≥ fav.y+fav.h=' + (S1.fav ? S1.fav.y + S1.fav.h : '?') + '）');
    rec('  → 收藏夹入口真的可点(没被盖) : ' + (favClickable ? 'PASS' : 'FAIL'));
    rec('  → 引擎分类胶囊也可点         : ' + (engClickable ? 'PASS' : 'FAIL'));
    rec('  （这一轮确实滚动了：scrollTop=' + S1.scrollTop + ' > 20 → ' + (scrolledReal ? 'yes' : 'no') + '）');
    await shot(ws, '_panel-scroll-new.png', {
        x: Math.max(0, S1.body.x - 6), y: Math.max(0, S1.body.y - 6),
        width: S1.body.w + 12, height: S1.body.h + 12,
    });

    /* ---------------- A/B 对照：复现旧结构 ---------------- */
    rec('');
    rec('=== A/B 对照：把两条 nav 搬回 panel-body（=旧结构）后重滚 ===');
    const lg = await evalJs(ws, TO_LEGACY);
    rec('  改结构 = ' + JSON.stringify(lg) + '（favPos/engPos 恢复成 sticky 即复现成功）');
    await evalJs(ws, SCROLL_BOTTOM);
    sleep(500);
    const S2 = await evalJs(ws, SNAP);
    rec('  滚到底 scrollTop=' + S2.scrollTop);
    rec('  sticky 头 = ' + JSON.stringify(S2.head) + '（该 null = 头确实被拆掉了）');
    rec('  收藏夹 nav ' + JSON.stringify(S2.fav) + ' position=' + S2.favPos);
    rec('  引擎分类 nav ' + JSON.stringify(S2.eng) + ' position=' + S2.engPos);
    rec('  elementFromPoint(收藏夹入口中心) = ' + JSON.stringify(S2.hitFav));
    rec('  elementFromPoint(引擎分类胶囊中心) = ' + JSON.stringify(S2.hitEng));
    const legacyBroken = S2.head === null && S2.favPos === 'sticky'
        && !!S2.hitFav && S2.hitFav.isFav !== true && S2.hitFav.isEngNav === true;
    await shot(ws, '_panel-scroll-legacy.png', {
        x: Math.max(0, S2.body.x - 6), y: Math.max(0, S2.body.y - 6),
        width: S2.body.w + 12, height: S2.body.h + 12,
    });
    rec('  → 旧结构下收藏夹入口被引擎分类盖住 : ' + (legacyBroken ? 'REPRO(符合预期)' : '未复现'));
    rec('    （"未复现"不影响结论：只要"现结构 PASS + 旧结构 REPRO"两者都在，机制就成立）');

    // 恢复：重画一次自然回到新结构
    await evalJs(ws, "renderPanel()");
    sleep(500);

    /* ---------------- ② 每次打开重置滚动位置 ---------------- */
    rec('');
    rec('=== ② 每次打开都重置到顶部 ===');
    await evalJs(ws, SCROLL_BOTTOM);
    sleep(400);
    const before = await evalJs(ws, "Math.round(document.getElementById('panelBody').scrollTop)");
    rec('  滚到底 scrollTop = ' + before + '（该 > 0）');
    await evalJs(ws, "document.getElementById('btnPanelClose').click()");
    sleep(400);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(900);
    const after = await evalJs(ws, "Math.round(document.getElementById('panelBody').scrollTop)");
    rec('  收起 → 重新打开 → scrollTop = ' + after + '（该 0）');

    // 再来一遍，确认不是第一回的偶然
    await evalJs(ws, SCROLL_BOTTOM);
    sleep(300);
    const before2 = await evalJs(ws, "Math.round(document.getElementById('panelBody').scrollTop)");
    await evalJs(ws, "document.getElementById('btnPanelClose').click()");
    sleep(300);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(900);
    const after2 = await evalJs(ws, "Math.round(document.getElementById('panelBody').scrollTop)");
    rec('  第二轮：' + before2 + ' → 重开 ' + after2 + '（该 0）');

    // 重开之后 sticky 头还在不在（重画不能把头拆了）
    const S3 = await evalJs(ws, SNAP);
    rec('  重开后结构：head=' + JSON.stringify(S3.head) + ' favPos=' + S3.favPos
        + ' 收藏夹入口 ' + S3.favCount + ' 个');

    rec('');
    rec('=== 汇总 ===');
    rec('  ① 滚到底收藏夹分类仍可见且可点 : ' + (headPinned && favVisible && favClickable && scrolledReal ? 'PASS' : 'FAIL'));
    rec('  ① 与引擎分类不重叠             : ' + (noOverlap && engClickable ? 'PASS' : 'FAIL'));
    rec('  ① A/B：旧结构确实被盖住       : ' + (legacyBroken ? 'REPRO' : '未复现'));
    rec('  ② 每次打开滚动位置归零         : ' + (before > 0 && after === 0 && before2 > 0 && after2 === 0 ? 'PASS' : 'FAIL'));

    rec('');
    rec('--- log.txt 尾部 40 行（原样）---');
    for (const s of readLog().split('\n').slice(-40)) rec('  ' + s);

    flush();
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
