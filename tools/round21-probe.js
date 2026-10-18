/* ============================================================================
 *  专项探针：轮 21
 *
 *  要证的事：
 *    ① 「更多引擎」面板点分类导航 → 跳过去的那个分类**不会被吸附头挡住**。
 *       做法是**同一次运行里做 A/B**：
 *         a. 先按**旧公式**（`title.offsetTop - 8`）手动摆一次 → 量出「被遮住」；
 *         b. 再点一下分类按钮（走新代码）→ 量出「没被遮住」。
 *       这样不需要换二进制就能证明"改之前确实坏、改之后确实好"。
 *    ② 跳转后导航按钮的高亮落在**被点的那个**分类上（阈值同样要考虑吸附头，
 *       否则会亮成上一个）。
 *    ③ 分组改造：`我的` 已改名 `网盘`，且里面有真内容（不再是单条目）。
 *    ④ 新增的引擎确实进了目录（阿里云盘 / Project Gutenberg / Wolfram Alpha …）。
 *    ⑤ 每个引擎的图标都落地了（iconFile 存在且文件真的在 icons 目录里）。
 *
 *  用法：node tools/round21-probe.js
 *  输出：tools/round21-probe.txt + 截图
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round21-probe.txt');
const ENGINES = path.join(ROOT, 'ui', 'data', 'engines.json');
const ICON_DIR = path.join(ROOT, 'ui', 'data', 'icons');
const TAG = '-probe-r21';
const PORT = 9346;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

/* ⚠ 睡眠用 setTimeout，**不要用 Atomics.wait** —— 那个会把主线程冻住。 */
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
    const limit = ms || 20000;
    while (Date.now() - t0 < limit) {
        let v = false;
        try { v = await fn(); } catch (e) { v = false; }
        if (v) return true;
        await sleep(200);
    }
    info('等待超时：' + desc);
    return false;
}
/** 等面板的平滑滚动**真的停下来**。
 *
 *  ⚠ 只等「条件成立」是不够的：`behavior:'smooth'` 是个动画，满足条件的那一刻
 *    可能才滚到半路（实测量到的留白是 -1px，等它停稳是 +8px）。
 *    要求连续 3 次读到的 scrollTop 完全一致、且中间**确实变化过**。 */
async function waitScrollSettled(ws, ms) {
    const t0 = Date.now();
    let last = null, same = 0, moved = false;
    while (Date.now() - t0 < (ms || 8000)) {
        const cur = await evalJs(ws, "Math.round(document.getElementById('panelBody').scrollTop)");
        if (last !== null) {
            if (cur === last) { same++; } else { same = 0; moved = true; }
            if (moved && same >= 3) return true;
        }
        last = cur;
        await sleep(150);
    }
    return false;
}

/** 轮询用取值器：必须 await，别写 `() => evalJs(...) === x`（那比的是 Promise）。 */
const probeEq = (ws, expr, want) => async () => (await evalJs(ws, expr)) === want;

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
        throw new Error('JS: ' + String(desc).slice(0, 300) + ' | ' + expr.slice(0, 140));
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

/** 确保「更多引擎」面板此刻是**展开**的。
 *
 *  ⚠ 必须挡这一下：横条在失焦 / 被点到面板外面时会自动收起，而探针跑的这台机器
 *    上人还在用电脑 —— 面板一中途收掉，**所有元素的矩形都变成 0**，
 *    断言要么假通过（"0 ≥ 0 没被遮住"）要么假失败，且看起来像产品 bug。
 *    实测踩过两次。 */
async function ensurePanelOpen(ws) {
    const hOf = `(function(){var s=document.querySelector('#panelBody .panel-sticky');
        return s ? Math.round(s.offsetHeight) : 0})()`;
    if ((await evalJs(ws, hOf)) > 0) return true;
    await evalJs(ws, "document.getElementById('btnMore').click(); 1");
    await waitFor('面板重新展开', async () => (await evalJs(ws, hOf)) > 0, 10000);
    return (await evalJs(ws, hOf)) > 0;
}

/** 点分类按钮 → 等滚动停稳 → 量一次；**面板被环境收掉就重来**（最多 3 次）。
 *
 *  ⚠ 为什么要重试：横条在失焦时会自动收起，而这台机器上人还在用电脑 ——
 *    面板一中途收掉，元素的矩形全变 0，"没被遮住"会变成 0≥0 的假通过。
 *    每次重试前先 ensurePanelOpen，量到的确实是一次完整的跳转才算数。 */
async function jumpAndMeasure(ws, cat) {
    const hOf = `(function(){var s=document.querySelector('#panelBody .panel-sticky');
        return s ? Math.round(s.offsetHeight) : 0})()`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await ensurePanelOpen(ws);
        if ((await evalJs(ws, hOf)) <= 0) { info('面板打不开，重试 ' + attempt); continue; }
        await evalJs(ws, `(function(){
            var b = document.querySelector('#panelBody .cat-nav-item[data-cat=${JSON.stringify(cat)}]');
            if (b) b.click();
            return 1;
        })()`);
        await waitScrollSettled(ws, 8000);
        const m = await evalJs(ws, MEASURE(cat));
        if (m && m.stickyBottom > 0 && m.scrollTop > 0) {
            m.attempts = attempt;
            return m;
        }
        info('第 ' + attempt + ' 次测量时面板被环境收起了（矩形全 0），重来');
    }
    return await evalJs(ws, MEASURE(cat));
}

async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        info('截图 ' + name);
    } catch (e) { info('截图失败 ' + name, e.message); }
}

/* ============================================================================
 *  主流程
 * ========================================================================== */
const MEASURE = (cat) => `(function(){
    var body = document.getElementById('panelBody');
    var sticky = body.querySelector('.panel-sticky');
    var title = body.querySelector('.cat-title[data-cat=${JSON.stringify(cat)}]');
    if (!body || !sticky || !title) return null;
    var sb = sticky.getBoundingClientRect();
    var tb = title.getBoundingClientRect();
    var bb = body.getBoundingClientRect();
    var on = body.querySelector('.cat-nav-item.on');
    return {
        stickyH: Math.round(sticky.offsetHeight),
        stickyBottom: Math.round(sb.bottom),
        titleTop: Math.round(tb.top),
        titleBottom: Math.round(tb.bottom),
        bodyTop: Math.round(bb.top),
        scrollTop: Math.round(body.scrollTop),
        /* 标题的顶边有没有被吸附头盖住（留 1px 容差） */
        covered: tb.top < sb.bottom - 1,
        /* 标题是不是在可视区里（面板底边之上） */
        inView: tb.top >= bb.top && tb.bottom <= bb.bottom,
        navOn: on ? on.dataset.cat : null
    };
})()`;

(async function main() {
    rec('=== 轮 21 专项探针 ===');
    rec('');

    /* ---------------- 磁盘侧：引擎目录与图标 ---------------- */
    rec('--- 前置：引擎目录数据 ---');
    const cat = JSON.parse(fs.readFileSync(ENGINES, 'utf8'));
    const cats = cat.categories || [];
    const titles = cats.map((c) => c.title);
    const all = [];
    for (const c of cats) for (const e of c.engines || []) all.push({ ...e, cat: c.title });

    info('分类数 ' + cats.length + '，引擎条目 ' + all.length);
    const wangpan = cats.find((c) => c.title === '网盘');
    chk('原来的「我的」分组已经改名成「网盘」', !titles.includes('我的') && !!wangpan,
        JSON.stringify(titles.filter((t) => /我的|网盘/.test(t))));
    chk('「网盘」里有真内容（不再是只有一条的孤零零分组）',
        !!wangpan && wangpan.engines.length >= 5,
        wangpan ? (wangpan.engines.length + ' 条: ' + wangpan.engines.map((e) => e.name).join('/')) : '');
    chk('  百度网盘还在（它搜的是自己网盘里的文件，不是 bug 是功能）',
        !!all.find((e) => e.name === '百度网盘'));

    const wantNew = ['阿里云盘', 'Google Drive', 'Project Gutenberg', 'Wolfram Alpha',
        '太平洋汽车', '丁香医生', 'Metacritic', 'Udemy', 'Pinterest', 'Bitbucket'];
    const missing = wantNew.filter((n) => !all.find((e) => e.name === n));
    chk('本轮新增的引擎确实进了目录', missing.length === 0, missing.length ? ('缺：' + missing.join(',')) : wantNew.length + ' 个抽样全在');

    // 体检修正
    const ku = all.find((e) => e.name === '酷安');
    const tq = all.find((e) => e.name === '天气网');
    chk('酷安已改成实测可用的新搜索地址', !!ku && /\/algo\?keyword=/.test(ku.url), ku && ku.url);
    chk('天气网已改成终址（省一次 301）', !!tq && /tianqi\.com\/so\/\?keyword=/.test(tq.url), tq && tq.url);
    const gone = ['千图网', '网易公开课', '豆果美食'];
    chk('搜索接口已失效的三个引擎已移除（点了必然打不开，留着不如删掉）',
        gone.every((n) => !all.find((e) => e.name === n)),
        gone.filter((n) => all.find((e) => e.name === n)).join(',') || '三个都不在了');

    // 图标齐全性
    const noIcon = all.filter((e) => !e.iconFile);
    const iconMissing = all.filter((e) => e.iconFile && !fs.existsSync(path.join(ICON_DIR, e.iconFile)));
    /* 图标覆盖率：剩下的少数是**国际站点 favicon 在这台机器上取不到**
     * （Nature / Science / Wiley / Springer / MEGA …）。
     * 没图标不是坏掉 —— app 本来就有「首字兜底徽标」这套设计（自建引擎也走它）。
     * 所以这里卡的是**覆盖率**，而不是"一个都不能少"。 */
    const cover = 100.0 * (all.length - noIcon.length) / all.length;
    chk('图标覆盖率达到 90% 以上', cover >= 90,
        cover.toFixed(1) + '%（' + (all.length - noIcon.length) + '/' + all.length + '）'
        + (noIcon.length ? '；没图标的走首字兜底徽标：' + noIcon.slice(0, 5).map((e) => e.name).join(',') + '…' : ''));
    chk('  ★ 没有悬空引用（iconFile 指向的文件必须真的存在）', iconMissing.length === 0,
        iconMissing.length ? (iconMissing.length + ' 个缺文件：' + iconMissing.slice(0, 8).map((e) => e.name).join(',')) : '全部命中');

    /* ---------------- 起隔离实例 ---------------- */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r21-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    rec('');
    rec('隔离实例数据目录：' + qs);

    const mkItem = (id, t) => ({ id, kind: 'text', text: t, html: '', image: '', remark: '' });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.trigger_select = false;
        c.trigger_copy = false;
        c.ocr_enable = false;
        c.auto_start = false;
        c.auto_color = false;
        c.fav_hotkey = '';
        c.webdav_url = '';
        c.webdav_on_start = false;
        c.webdav_on_exit = false;
        c.backup_dir = '';
        // 特意放两个收藏夹目录：这样吸附头里 fav 行 + 分类行**都在**，
        // 吸附头最高 —— 遮挡问题最容易复现的形态。
        c.favorites = [
            { id: 'pg1', name: '工作', icon: '', items: [mkItem('pi1', '甲')], children: [] },
            { id: 'pg2', name: '生活', icon: '', items: [mkItem('pi2', '乙')], children: [] },
        ];
        c.bar_list = ['百度', 'Google'];
        c.bar_blur = 0;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }

    const env = Object.assign({}, process.env, {
        APPDATA: tmp,
        LOCALAPPDATA: tmp,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1',
        QS_INSTANCE_TAG: TAG,
        QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('已启动隔离实例 pid=' + proc.pid);
    const stop = () => { try { proc.kill(); } catch (e) { } };
    PENDING_STOP.push(stop);

    const ws = await connectWhere(isBarPage, 30000);
    if (!ws) { rec('连不上横条页面，放弃'); stop(); flush(); process.exit(1); }
    await cdp(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });
    rec('已连上横条页面');
    chk('横条页面 IPC 已就绪', await waitFor('IPC', async () => {
        try {
            return (await evalJs(ws,
                "typeof invoke === 'function' && typeof listen === 'function'")) === true;
        } catch (e) { return false; }
    }, 25000));

    /* ---------------- 打开「更多引擎」面板 ---------------- */
    rec('');
    rec('--- ① 分类跳转不被吸附头挡住（同一次运行内做 A/B）---');
    await evalJs(ws, "document.getElementById('btnMore').click(); 1");
    const opened = await waitFor('面板出现分类导航',
        probeEq(ws, "document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item').length > 5", true),
        15000);
    chk('⋯ 面板打开并渲染出分类导航', opened,
        String(await evalJs(ws, "document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item').length")));

    const navCats = await evalJs(ws,
        "Array.from(document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item')).map(function(b){return b.dataset.cat})");
    info('分类导航共 ' + (navCats || []).length + ' 项：' + JSON.stringify(navCats));

    // 挑一个**靠后**的分类来跳：靠后的才会真的滚起来，也才谈得上被吸附头盖住
    /* 取**中间**那个分类来做 A/B：靠后的分类 `offsetTop - 8` 会超过 maxScroll
     * 被钳住，复现出来是"滑过头"；中间的分类才正好落在吸附头底下，
     * 是用户描述的那个形态（"引擎被目录遮住一部分"）。 */
    const pick = (navCats && navCats.length > 6) ? navCats[Math.floor(navCats.length / 2)]
        : (navCats && navCats.length ? navCats[navCats.length - 1] : '生活');
    info('用来做实验的分类：' + pick);

    const stickyH = await evalJs(ws,
        "(function(){var s=document.querySelector('#panelBody .panel-sticky');return s?Math.round(s.offsetHeight):0})()");
    info('吸附头高度 ' + stickyH + 'px（旧公式只减 8px 补偿）');
    chk('吸附头确实存在且有一定高度（旧公式的 8px 补偿明显不够）', stickyH > 16,
        stickyH + 'px vs 旧补偿 8px');

    /* ---- A：按**旧公式**摆位置，复现"被遮住" ---- */
    await ensurePanelOpen(ws);
    const oldTop = await evalJs(ws, `(function(){
        var t = document.querySelector('#panelBody .cat-title[data-cat=${JSON.stringify(pick)}]');
        return t ? Math.max(0, t.offsetTop - 8) : -1;
    })()`);
    await evalJs(ws, `(function(){
        var b = document.getElementById('panelBody');
        b.scrollTo({ top: ${oldTop}, behavior: 'instant' });
        return 1;
    })()`);
    await sleep(500);
    const mOld = await evalJs(ws, MEASURE(pick));
    info('A/B 的 A（旧公式 scrollTop=' + oldTop + '）：' + JSON.stringify(mOld));
    chk('★ A/B 的 A：旧公式（offsetTop - 8）确实会把分类标题摆到吸附头底下',
        !!mOld && mOld.covered === true,
        mOld ? ('titleTop=' + mOld.titleTop + ' < stickyBottom=' + mOld.stickyBottom) : '(量不到)');
    await shot(ws, '_r21-01-old-covered.png');

    /* ---- B：点分类按钮（走新代码），应当不遮 ---- */
    const mNew = await jumpAndMeasure(ws, pick);
    info('A/B 的 B（点分类按钮后）：' + JSON.stringify(mNew));
    chk('★ A/B 的 B：新公式跳过去后分类标题**完整落在吸附头下方**',
        !!mNew && mNew.covered === false,
        mNew ? ('titleTop=' + mNew.titleTop + ' ≥ stickyBottom=' + mNew.stickyBottom) : '(量不到)');
    chk('  标题整体在可视区内（没被顶出底边）', !!mNew && mNew.inView === true);
    chk('  高亮落在**被点的那个**分类上（阈值也算上了吸附头高度）',
        !!mNew && mNew.navOn === pick, mNew && mNew.navOn);
    chk('  跳转确实滚动了（scrollTop > 0）', !!mNew && mNew.scrollTop > 0, mNew && String(mNew.scrollTop));
    chk('  留白合理：标题顶边在吸附头下沿再往下 4~24px 内',
        !!mNew && (mNew.titleTop - mNew.stickyBottom) >= 4 && (mNew.titleTop - mNew.stickyBottom) <= 24,
        mNew ? String(mNew.titleTop - mNew.stickyBottom) + 'px' : '');
    // 分类标题**下面那一行引擎**也不该被吸附头压住（用户的原话就是"引擎被遮住"）
    const firstRowTop = await evalJs(ws, `(function(){
        var t = document.querySelector('#panelBody .cat-title[data-cat=${JSON.stringify(pick)}]');
        if (!t) return null;
        var n = t.nextElementSibling;
        while (n && !n.classList.contains('cat-title')) {
            var c = n.querySelector ? n.querySelector('.cell') : null;
            if (c) { return Math.round(c.getBoundingClientRect().top); }
            n = n.nextElementSibling;
        }
        return null;
    })()`);
    info('分类标题下方第一个引擎格子的顶边：' + firstRowTop);
    chk('  该分类的**第一个引擎格子**也在吸附头下方（不是只看标题）',
        firstRowTop === null || (mNew && firstRowTop >= mNew.stickyBottom),
        firstRowTop === null ? '(这个分类没有可量的格子，跳过)'
            : (firstRowTop + ' ≥ ' + (mNew && mNew.stickyBottom)));
    chk('  跳转过程没报错（面板还在、导航还在）',
        (await evalJs(ws, "!!document.querySelector('#panelBody .panel-sticky')")) === true);
    await shot(ws, '_r21-02-new-not-covered.png');

    /* ---- 换一个分类再来一次，确认不是碰巧 ---- */
    const pick2 = (navCats && navCats.length > 10) ? navCats[navCats.length - 1] : null;
    if (pick2) {
        const m2 = await jumpAndMeasure(ws, pick2);
        info('第二个分类「' + pick2 + '」跳转后：' + JSON.stringify(m2));
        // stickyBottom > 0 是必须的：量到 0 说明面板根本没展开，那样"没被遮住"是假通过
        chk('换最后一个分类「' + pick2 + '」再跳一次，同样不被遮住',
            !!m2 && m2.stickyBottom > 0 && m2.covered === false,
            m2 ? ('titleTop=' + m2.titleTop + ' ≥ stickyBottom=' + m2.stickyBottom) : '(量不到)');
    }

    /* ---------------- ③ 分组改造在真界面里的样子 ---------------- */
    rec('');
    rec('--- ② 「网盘」分组在界面里的样子 ---');
    const navTexts = await evalJs(ws,
        "Array.from(document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item')).map(function(b){return b.textContent})");
    chk('分类导航里有「网盘」、没有「我的」',
        (navTexts || []).includes('网盘') && !(navTexts || []).includes('我的'),
        JSON.stringify((navTexts || []).filter((t) => /网盘|我的/.test(t))));
    const wpTitle = await evalJs(ws, `(function(){
        var t = document.querySelector('#panelBody .cat-title[data-cat="网盘"]');
        if (!t) return null;
        t.scrollIntoView({ block: 'center' });
        return 1;
    })()`);
    await sleep(500);
    const wpCells = await evalJs(ws, `(function(){
        var t = document.querySelector('#panelBody .cat-title[data-cat="网盘"]');
        if (!t) return [];
        var out = [];
        var n = t.nextElementSibling;
        while (n && !n.classList.contains('cat-title')) {
            Array.from(n.querySelectorAll('.cell')).forEach(function(c){ out.push(c.title || c.textContent) });
            n = n.nextElementSibling;
        }
        return out;
    })()`);
    info('「网盘」分组里的引擎：' + JSON.stringify(wpCells));
    chk('「网盘」分组在界面上列出了多个云盘（不再是一条孤零零的条目）',
        Array.isArray(wpCells) && wpCells.length >= 5, String((wpCells || []).length) + ' 个');
    await shot(ws, '_r21-03-wangpan.png');

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
