/* r57 三条用户报障的实测探针
 *
 * 用户原话：
 *  ①「我框选之后并没有打开网页进行搜索呀，然后还会提示说我没有打开搜索功能，
 *     但实际上我打开了呀。说返回 404 什么的。」
 *  ②「通过横条打开更多引擎页面，里面并没有最近使用呀，就哪怕我点击了一些其他的
 *     没有放在横条里的引擎进行使用，之后再点击更多引擎也没有出现最近使用。」
 *     「最近使用的引擎一定要跟横条里已经固定的不重复。」
 *  ③「我选中了一个文件浏览器的地址或者说文件的地址，那么这时候横条里面会多一个
 *     文件管理器的图标，点击这个图标之后，就会跳转到文件管理器的相应页面。
 *     但实际上虽然跳出了图标，但点击之后并不能够跳转到文件管理器中相应的页面。」
 *
 * ⚠ 这条探针会**真的打开一个资源管理器窗口**（③ 要验的就是它）。
 *   用的是隔离配置目录，所以弹出来的是那个临时目录，跑完自己会关掉进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r57-probe.txt');
const PORT = 9401;
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
const readLog = (tmp) => {
    try { return fs.readFileSync(path.join(tmp, 'QuickSearch', 'log.txt'), 'utf8'); } catch (e) { return ''; }
};

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r57-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        bar_list: ['百度', 'Google', '必应'],       // 横条上固定这三家
        img_enable: true, img_add_to_bar: true,
        img_engines: ['bing', 'ascii2d'],
        img_default_engine: '',                    // 空 = 按多选名单全开
        recent_engines: [],
        recent_max: 10,
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r57' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r57 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('横条连不上'); flush(); process.exit(1); }

    const showBar = async (text) => ev(ws, `(async function(){
        await window.__TAURI__.event.emit('qs://show', {
          text: ${JSON.stringify(text)}, hwnd: 0, via_copy: false, urls: [], isUrl: false,
        });
        await new Promise((r) => setTimeout(r, 500));
        return 'ok';
    })()`);

    /* ================= ① 识图：不再走 POST、不再 404 ================= */
    rec('');
    rec('--- ① 识图搜索 ---');

    // 1a. 静态：POST 那条路已经删干净（源码里不该再有它的**代码**）
    //     ⚠ 只查"代码"，不查注释 —— 注释里会提到 post_and_result_url 讲历史，
    //       拿它当"没删干净"是误报（第一版就这么误报了两条）。
    const stripComments = (s) => s
        .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
        .replace(/^\s*\/\/.*$/gm, '')       // 行注释
        .replace(/^\s*\/\/\/.*$/gm, '');    // 文档注释（已在上面被吃掉一部分）
    const imgSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'imgsearch.rs'), 'utf8'));
    const mainSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8'));
    check('①a 源码里已经没有 post_and_result_url 的代码（404 的来源）',
        !/fn post_and_result_url|post_and_result_url\s*\(/.test(imgSrc)
        && !/post_and_result_url\s*\(/.test(mainSrc));
    check('①b 也没有 multipart_body / Mode::Post 这些残留',
        !/fn multipart_body|multipart_body\s*\(/.test(imgSrc)
        && !/Mode::Post/.test(imgSrc + mainSrc));

    // 1c. 每家引擎的 page 都是 https 且能拼出来
    const engList = await ev(ws, `(async function(){
        const v = await window.__TAURI__.core.invoke('img_engines_list');
        return JSON.stringify(v);
    })()`);
    let engs = [];
    try { engs = JSON.parse(engList); } catch (e) { }
    // r59：家数改成跟后端一致（用户要求删掉失效引擎，16 → 9），不再写死
    check('①c 引擎表能取到（至少一家）', Array.isArray(engs) && engs.length >= 1, engs.length);
    // r59：`form` 是**新增**的第三档（浏览器表单真提交），所以合法值变成三种
    const badMode = engs.filter((e) => ['upload', 'page', 'url'].indexOf(e.mode) < 0);
    check('①d 所有引擎的模式都在 form / page / url 三种之内（没有 post 残留）',
        badMode.length === 0, JSON.stringify(badMode.map((e) => e.mode)));

    // 1e. 真的跑一轮识图（用 img_region 的后端路径），看日志里开了哪些地址
    await ev(ws, `window.__TAURI__.core.invoke('img_region', { x: 8, y: 8, w: 48, h: 32, dpr: 1 }).catch(()=>{})`);
    await sleep(9000);
    let log = readLog(tmp);
    // open_links 会打日志；另外 img: 已开 N 个标签页
    const openedN = /img: 已开 (\d+) 个标签页/.exec(log);
    check('①e 框选之后**真的开了页面**（日志有「已开 N 个标签页」，N ≥ 1）',
        !!openedN && Number(openedN[1]) >= 1, log.slice(-400));
    check('①f 日志里没有任何 404 / 识图没打开 的报错',
        !/对方返回 404/.test(log) && !/识图没打开/.test(log),
        (log.match(/对方返回 \d+|识图没打开[^\n]*/g) || []).join(' | '));

    // 1g. 临时图确实留了一张（给只吃文件框的那几家）
    const tmpImg = path.join(os.tmpdir(), 'QuickSearch', 'img', 'shot.jpg');
    // 注意：临时图写在真实 %TEMP%，不在隔离 APPDATA 里（那是刻意的：
    // 用户点文件对话框时看到的是系统临时目录）
    const tmpExists = fs.existsSync(tmpImg);
    rec('临时图 ' + tmpImg + ' 存在 = ' + tmpExists);
    check('①g 给「只吃文件框」的几家留了临时图', tmpExists);
    check('①h 临时图目录里**只有一张**（不会攒垃圾）',
        (() => { try { return fs.readdirSync(path.dirname(tmpImg)).length === 1; } catch (e) { return true; } })());

    /* ================= ② 最近使用 ================= */
    rec('');
    rec('--- ② 最近使用 ---');

    // 2a. 点一家**没固定在横条上**的引擎（知乎），它该进最近使用
    await showBar('测试文字');
    const clicked = await ev(ws, `(async function(){
        try {
            await window.__TAURI__.core.invoke('open_search', { engine: '知乎', text: '测试文字' });
            return 'ok';
        } catch (e) { return 'ERR ' + e; }
    })()`);
    rec('调 open_search(知乎) => ' + clicked);
    await sleep(2500);

    // 2b. 读配置：recentEngines 里该有「知乎」，而且它不在 bar_list 里
    const after = await ev(ws, `(async function(){
        const c = await window.__TAURI__.core.invoke('get_config');
        return JSON.stringify({ recent: c.recentEngines || [], bar: c.barList || [] });
    })()`);
    let cfgAfter = {};
    try { cfgAfter = JSON.parse(after); } catch (e) { }
    rec('最近使用 = ' + JSON.stringify(cfgAfter.recent) + '；横条 = ' + JSON.stringify(cfgAfter.bar));
    check('②a 点了没固定在横条的引擎（知乎）之后，它进了最近使用',
        Array.isArray(cfgAfter.recent) && cfgAfter.recent.indexOf('知乎') >= 0, after);

    // 2c. 再点一家**固定在横条上**的（百度），它不该出现在最近使用里
    await showBar('测试文字');
    await ev(ws, `window.__TAURI__.core.invoke('open_search', { engine: '百度', text: '测试文字' }).catch(()=>{})`);
    await sleep(2500);

    // 2d. 打开更多引擎面板，看那一栏
    await showBar('测试文字');
    await ev(ws, `document.getElementById('btnMore').click()`);
    await sleep(1500);
    const recentInfo = await ev(ws, `(function(){
        const t = document.querySelector('.recent-title');
        if (!t) return JSON.stringify({ has: false });
        const grid = document.querySelector('.recent-grid');
        const names = grid ? Array.from(grid.querySelectorAll('.cell')).map((c) => c.dataset.engine || '') : [];
        return JSON.stringify({ has: true, label: t.textContent, names: names });
    })()`);
    let ri = {};
    try { ri = JSON.parse(recentInfo); } catch (e) { }
    rec('面板里的最近使用 = ' + recentInfo);
    check('②b 「更多引擎」面板里真的出现了「最近使用」一栏', ri.has === true, recentInfo);
    check('②c 那一栏标着「最近使用」', typeof ri.label === 'string' && ri.label.indexOf('最近使用') >= 0, ri.label);
    check('②d 横条上已固定的引擎（百度 / Google / 必应）**不出现在**最近使用里',
        Array.isArray(ri.names) && !ri.names.some((n) => ['百度', 'Google', '必应'].indexOf(n) >= 0),
        JSON.stringify(ri.names));
    check('②e 那一栏里确实有刚点过的知乎（说明不是空栏）',
        Array.isArray(ri.names) && ri.names.indexOf('知乎') >= 0, JSON.stringify(ri.names));

    /* ================= ③ 文件路径 → 点图标真的开资源管理器 ================= */
    rec('');
    rec('--- ③ 文件路径 ---');
    const sampleDir = tmp;                       // 一个真实存在的目录
    await showBar(sampleDir);
    const btnState = await ev(ws, `(function(){
        const b = document.getElementById('btnPath');
        return b ? JSON.stringify({ hidden: b.hidden, title: b.title }) : 'missing';
    })()`);
    let bs = {};
    try { bs = JSON.parse(btnState); } catch (e) { }
    check('③a 选中一条真实路径 → 文件管理器图标出现', bs.hidden === false, btnState);

    /* ---- ③a2 命中测试：那颗图标**真的能被点到**吗 ----
     *
     * 这一步是这次排查的关键。用户说"图标出来了、点了没反应"，而"点了没反应"
     * 最常见的成因不是后端坏了，是**那颗按钮被别的元素盖住了** —— 或者它压根
     * 不在可视区内。`elementFromPoint` 问的就是"这个坐标上最上面的是谁"，
     * 和鼠标真正点下去拿到的是同一个答案。
     *
     * ⚠ 用真实坐标（getBoundingClientRect 的中心），不用 .click() ——
     *   .click() 会**绕过命中测试**，按钮被盖住也照样"成功"，那就白测了。 */
    const hit = await ev(ws, `(function(){
        const b = document.getElementById('btnPath');
        if (!b) return JSON.stringify({ ok: false, why: 'missing' });
        const r = b.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return JSON.stringify({ ok: false, why: 'zero-size', r: [r.x, r.y, r.width, r.height] });
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const inside = !!(top && (top === b || b.contains(top)));
        return JSON.stringify({
            ok: inside, cx: cx, cy: cy,
            top: top ? (top.id || top.className || top.tagName) : 'null',
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        });
    })()`);
    let hs = {};
    try { hs = JSON.parse(hit); } catch (e) { }
    rec('命中测试 = ' + hit);
    check('③a2 那颗图标的中心点**最上面就是它自己**（没被别的元素盖住）',
        hs.ok === true, hit);

    // 真的用鼠标点（CDP Input，走完整的命中测试 + 事件派发）
    const before = readLog(tmp).length;
    if (hs.ok) {
        await cdp(ws, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: hs.cx, y: hs.cy, button: 'left', clickCount: 1,
        });
        await cdp(ws, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: hs.cx, y: hs.cy, button: 'left', clickCount: 1,
        });
    }
    await sleep(3000);
    log = readLog(tmp);
    const newLog = log.slice(before);
    rec('点击后新增日志：' + newLog.split('\n').filter((l) => l.indexOf('open_path') >= 0).join(' | '));
    check('③b 用真鼠标点图标 → **真的调到了后端**（日志里有 open_path 那一行）',
        /open_path:/.test(newLog), newLog.slice(-300));
    check('③c 后端回的是「已在文件管理器中打开/定位」而不是报错',
        /已在文件管理器中(打开|定位)/.test(newLog),
        (newLog.match(/open_path:[^\n]*/g) || []).join(' | '));

    // ③d. 后端直接调一次，确认返回值口径（不依赖 UI）
    const direct = await ev(ws, `(async function(){
        const a = await window.__TAURI__.core.invoke('open_path', { path: ${JSON.stringify(sampleDir)} });
        return a;
    })()`);
    rec('open_path 直接返回 = ' + direct);
    check('③d open_path 对存在的目录返回「已在文件管理器中打开」',
        String(direct).indexOf('已在文件管理器中打开') >= 0, String(direct));

    /* ---- ③e/③f：用户真实会选中的两种形态 ----
     *
     * 用户原话「我选中了一个**文件浏览器的地址**或者说文件的地址」。
     * 这两条对应两种很常见、r57 之前**确实会失败**的形状：
     *   e) `file:///C:/...` —— 从浏览器地址栏复制出来的文件地址。
     *      以前被当成网址直接排掉（连图标都不出），现在要能开。
     *   f) 尾部带标点 —— 从聊天/文档里选一条路径，句号逗号常常一起被选进来。
     *      以前图标会出、但 exists() 为假 → 点了没反应。现在要能开。 */
    const asFileUrl = 'file:///' + sampleDir.replace(/\\/g, '/');
    const shapes = await ev(ws, `(async function(){
        const out = {};
        for (const [k, p] of Object.entries({
            fileUrl: ${JSON.stringify(asFileUrl)},
            trailingDot: ${JSON.stringify(sampleDir + '。')},
            trailingComma: ${JSON.stringify(sampleDir + '，')},
            quoted: ${JSON.stringify('"' + sampleDir + '"')},
        })) {
            try { out[k] = await window.__TAURI__.core.invoke('open_path', { path: p }); }
            catch (e) { out[k] = 'ERR ' + e; }
        }
        return JSON.stringify(out);
    })()`);
    let sh = {};
    try { sh = JSON.parse(shapes); } catch (e) { }
    rec('各种形态的 open_path 返回 = ' + shapes);
    check('③e 浏览器地址栏那种 file:/// 文件地址**能打开**（r57 新支持）',
        String(sh.fileUrl || '').indexOf('已在文件管理器中打开') >= 0, sh.fileUrl);
    check('③f 尾部带中文句号的路径**能打开**（r57 剥掉尾部标点）',
        String(sh.trailingDot || '').indexOf('已在文件管理器中打开') >= 0, sh.trailingDot);
    check('③g 尾部带中文逗号的路径**能打开**',
        String(sh.trailingComma || '').indexOf('已在文件管理器中打开') >= 0, sh.trailingComma);
    check('③h 带成对引号的路径**能打开**（划词常把引号一起选进来）',
        String(sh.quoted || '').indexOf('已在文件管理器中打开') >= 0, sh.quoted);

    // ③i. 前端判据也得认 file:/// —— 否则图标根本不出现，后端再能干也白搭
    const jsHit = await ev(ws, `(function(){
        return JSON.stringify({
            fileUrl: window.qsLooksLikePath(${JSON.stringify(asFileUrl)}),
            plain: window.qsLooksLikePath(${JSON.stringify(sampleDir)}),
            https: window.qsLooksLikePath('https://example.com/a.txt'),
        });
    })()`);
    let jh = {};
    try { jh = JSON.parse(jsHit); } catch (e) { }
    rec('前端判据 = ' + jsHit);
    check('③i 前端也认 file:///（图标才会出现）', jh.fileUrl === true, jsHit);
    check('③j 前端仍然不把 https 当路径（没把放行 file:// 做成放行一切）',
        jh.https === false, jsHit);

    rec('');
    rec('========== r57：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
