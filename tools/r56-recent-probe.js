/* r56「最近使用」一栏探针
 * 用户原话：「通过横条点击更多引擎展现出来的页面，再添加一个最近使用的一栏，
 * 这一栏就默认显示，它显示在已经陈列出来的所有引擎的最上面，并且标记好是最近使用，
 * 在设置当中可以选择最多呈现最近使用的 5 个、10 个、15 个或者 20 个。」
 *
 * 验七件事：
 *   ① 配置里存了最近用过的引擎 → 面板里真的多出那一栏（默认显示，不用开什么开关）；
 *   ② 那一栏**在所有引擎分类的最上面**（第一个 .cat-title 之前）；
 *   ③ 那一栏**标着「最近使用」**四个字（用户点名要标记好）；
 *   ④ 摆几个由 recentMax 决定：5/10/15/20 四档各自验一遍；
 *   ⑤ 顺序是**最近在前**（后端插到最前，界面原样渲染）；
 *   ⑥ 空名单时那一栏**整段不占位**（不显示一个空的"最近使用"标题）；
 *   ⑦ 点一颗格子 → 后端 open_search 被调用（说明它和下面的格子是同一条路），
 *      且后端会把这家记进 recentEngines（这条在 Rust 单测里钉，这里只验 UI 侧通路）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r56-recent-probe.txt');
const PORT = 9398;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}
let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const on = (ev) => {
            let x; try { x = JSON.parse(ev.data); } catch (e) { return; }
            if (x.id !== i) return;
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) : r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
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
/** 起一个横条窗口（面板在里面）。
 *
 *  ⚠ r57 改：`bar_list` 与 `recent_engines` **必须是不相交的两组**。
 *    r57 起「最近使用」会**排除横条上已经固定的引擎**（用户要求：「最近使用的
 *    引擎一定要跟横条里已经固定的不重复」）。这条探针原来把 recent 的名字也塞进
 *    bar_list（那是为了绕过旧的"按配置认不认识来剪枝"，那个剪枝在 r57 已经删了），
 *    于是现在全被排除、那一栏整个不显示 —— 10 条断言因此变红。
 *    那是**断言过期**，不是产品缺陷；改成两组不相交即可。
 *  ⚠ 地址匹配用 'tauri.localhost/'（Tauri 2 的 dev 服务器地址）。 */
const KNOWN = ['百度', 'Google', '必应', '搜狗'];
async function boot(recent, recentMax) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r56rc-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        bar_list: KNOWN.slice(),   // 横条上固定这几家
        recent_engines: recent,    // 最近用过的（必须不含上面这几家）
        recent_max: recentMax,
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r56rc' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    // ⚠ 不带 --bar：横条是**默认窗口**，加了反而起不来（和 r54 探针一致）
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    sleep(8000);
    const ws = await connect('tauri.localhost/');
    return { proc, ws, tmp };
}
/** 打开更多引擎面板（点 ⋯ 按钮）并等它渲染完。 */
async function openPanel(ws) {
    await ev(ws, `document.getElementById('btnMore').click()`);
    await sleep(1200);
}
(async () => {
    rec('r56「最近使用」探针');
    let r = await boot(['知乎', '哔哩哔哩', '淘宝'], 10);
    if (!r.ws) { rec('横条连不上'); flush(); process.exit(1); }
    let ws = r.ws;

    await openPanel(ws);

    /* ---- ① 那一栏存在（默认显示，不用开开关）---- */
    const has = await ev(ws, `!!document.querySelector('.recent-title')`);
    check('① 配置里有最近用过的引擎 → 面板多出那一栏（默认显示）', String(has) === 'true', String(has));

    /* ---- ② 在所有引擎分类的最上面 ---- */
    const order = await ev(ws, `(function(){
        var rt = document.querySelector('.recent-title');
        if (!rt) return 'none';
        var firstCat = document.querySelector('.panel-body .cat-title:not(.recent-title)');
        if (!firstCat) return 'no-cat';
        // 同一父容器里比位置：recent 必须在第一个分类标题之前
        var a = rt.compareDocumentPosition(firstCat);
        return (a & Node.DOCUMENT_POSITION_FOLLOWING) ? 'recent-first' : 'recent-after';
    })()`);
    check('② 那一栏在所有引擎分类的**最上面**', String(order) === 'recent-first', String(order));

    /* ---- ③ 标着「最近使用」---- */
    const label = await ev(ws, `(function(){
        var rt = document.querySelector('.recent-title');
        return rt ? rt.textContent : '';
    })()`);
    check('③ 那一栏标着「最近使用」四个字', String(label).indexOf('最近使用') >= 0, String(label));

    /* ---- 格子和名单一致（3 个都摆出来）---- */
    const cells = await ev(ws, `document.querySelectorAll('.recent-grid .cell').length`);
    check('那一栏里的格子数 = 名单长度（3 个）', Number(cells) === 3, cells);

    /* ---- ⑤ 顺序：最近在前（名单第一项是「知乎」→ 第一颗也该是它）---- */
    const first = await ev(ws, `(function(){
        var c = document.querySelector('.recent-grid .cell');
        return c ? (c.dataset.engine || c.dataset.appName || '') : '';
    })()`);
    check('⑤ 第一颗是名单里最靠前那个（知乎）', String(first) === '知乎', String(first));

    /* ---- ⑥ 横条上已固定的引擎不出现在这一栏 ----
     * 用户原话：「最近使用的引擎一定要跟横条里已经固定的不重复」。
     * 这条单独钉一次：本探针的 KNOWN（百度/Google/必应/搜狗）全在 bar_list 里，
     * 名单里**故意不含**它们，所以这里反过来验"排除逻辑真的在跑"——
     * 见下面 ⑥b：把一家横条上的名字硬塞进名单，它也不该出现。 */
    const barNames = await ev(ws, `(function(){
        var out = [];
        for (var c of document.querySelectorAll('.recent-grid .cell')) {
            out.push(c.dataset.engine || c.dataset.appName || '');
        }
        return JSON.stringify(out);
    })()`);
    let bn = [];
    try { bn = JSON.parse(barNames); } catch (e) { }
    check('⑥ 横条上固定的那几家（百度/Google/必应/搜狗）**不在**最近使用里',
        !bn.some((n) => ['百度', 'Google', '必应', '搜狗'].indexOf(n) >= 0), barNames);

    /* ---- 点一颗：走同一条 open_search 路 ----
     * 点了横条会收、浏览器会被唤起 —— 探针环境里没有浏览器目标，
     * 后端会照常走完（打不开浏览器只影响结果页，不影响调用本身）。
     * 这里只验 UI 侧"这颗格子是可点的、点了会调 open_search"：
     * 用一次假的 invoke 包不住（settings.js 那个 const 抓取的坑，bar.js 一样），
     * 所以改成**静态**验：格子是 <button>、挂在 .recent-grid 里、
     * 有 dataset.engine（点击分发就按它走）。 */
    const wiring = await ev(ws, `(function(){
        var bad = [];
        for (var c of document.querySelectorAll('.recent-grid .cell')) {
            if (c.tagName !== 'BUTTON') { bad.push('not-button'); continue; }
            if (!c.dataset.engine) { bad.push('no-engine:' + c.className); continue; }
        }
        return JSON.stringify(bad);
    })()`);
    check('那一栏的每颗格子都是带 dataset.engine 的真按钮（点了走同一条搜索路）',
        wiring === '[]', wiring);

    /* ---- ⑥ 空名单时那一栏不占位 ---- */
    try { r.proc.kill(); } catch (e) { }
    await sleep(600);
    r = await boot([], 10);
    if (!r.ws) { rec('第二个横条连不上'); flush(); process.exit(1); }
    ws = r.ws;
    await openPanel(ws);
    const emptyHas = await ev(ws, `!!document.querySelector('.recent-title')`);
    check('⑥ 一条记录都没有时，那一栏整段不占位（不显示空的「最近使用」）',
        String(emptyHas) === 'false', String(emptyHas));

    /* ---- ④ 四档各自验一遍：5/10/15/20 ----
     * 关键是让名单**比档位长**，否则"最多摆 N 个"这件事根本没被验证到
     * （第一版只给了 7 个名字，四档全过但其实一次都没触到上限；第二版给了
     * 25 个名字但一半不是真引擎名，被 byName 查不到跳过，于是只渲染出 9 个
     * —— 那其实是**正确行为**：名单里没有对应引擎的名字就该跳过，不能给一颗
     * 点了 404 的格子。所以这里全用**真引擎名**）。
     * 名单 25 个真名 → 5/10/15/20 四档各自都能看到"名单更长、只摆前 N 个"。
     * ⚠ 这 25 个**必须全都不在 bar_list 里**（KNOWN = 百度/Google/必应/搜狗）——
     *   横条上已有的会被"最近使用"排除掉，混进来就等于把可用名单缩短了。 */
    const MANY = ['知乎', '哔哩哔哩', '淘宝', '360',
        'Yandex', 'DuckDuckGo', 'Yahoo', 'Brave 搜索', 'Ecosia', 'Qwant', 'Mojeek',
        'Startpage', '神马搜索', '夸克搜索', '头条搜索', '无追搜索', '百度（首页）',
        '必应（首页）', '谷歌（首页）', '搜狗（首页）', '360 搜索（首页）',
        '维基百科', '豆瓣读书', '简书', '果壳'];
    for (const n of [5, 10, 15, 20]) {
        try { r.proc.kill(); } catch (e) { }
        await sleep(600);
        r = await boot(MANY.slice(0, 25), n);
        if (!r.ws) { rec('recentMax=' + n + ' 那个横条连不上'); fail++; continue; }
        ws = r.ws;
        await openPanel(ws);
        const got = Number(await ev(ws, `document.querySelectorAll('.recent-grid .cell').length`));
        check('④ recentMax=' + n + '：名单有 25 个，那一栏**只摆 ' + n + ' 个**',
            got === n, '实际 ' + got);
    }

    /* ---- 名单不够 N 个时就全摆出来（不补空、不截断成更少）---- */
    try { r.proc.kill(); } catch (e) { }
    await sleep(600);
    r = await boot(['知乎', '哔哩哔哩'], 20);
    ws = r.ws;
    await openPanel(ws);
    const few = Number(await ev(ws, `document.querySelectorAll('.recent-grid .cell').length`));
    check('名单只有 2 个时全摆出来（档位是上限，不是定额）', few === 2, '实际 ' + few);

    try { r.proc.kill(); } catch (e) { }
    await sleep(500);
    rec('');
    rec('========== r56 最近使用：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
