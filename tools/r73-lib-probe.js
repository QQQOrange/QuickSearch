/* ============================================================================
 *  r73 引擎库「三级下钻 + 首字母索引」验证
 *
 *  用户原话：
 *    ·「默认只显示这 4 个大类，当我点击某一个大类之后才会展开这个大类下相应的
 *      中类，点击某一个中类之后才会展示该中类下的某一小类。」
 *    ·「点击全部引擎的时候，所有的引擎就以 abcdefg 这样的首字母的形式来排列，
 *      同时当我点击首字母之后，就会一次性把所有的首字母给陈列出来，然后点击任一个
 *      字母就能够快速跳转到相应的位置，就像 win11 的菜单一样。」
 *    ·「现在的不仅丑，而且还是属于一种浮在页面上的，因为我能够在这个大类跟窗口
 *      中间看到引擎从那儿经过。」（→ 目录不许吸顶）
 *    ·「显示全部引擎的过程当中，就不显示我说的这些（中类/主题/小类标题），
 *      就只以 abcd 这样的来显示。」
 *    ·「把主题这一栏全部给删掉。」
 *
 *  用法: node tools/r73-lib-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r73-lib-probe.txt');
let PORT = 0;
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
let WV = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}

async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP 超时：' + m)); }, 8000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (!x || x.id !== i) return;
            clearTimeout(timer);
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
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
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
        if (await ev(ws, expr) === true) return true;
        await sleep(250);
    }
    return false;
}

(async () => {
    PORT = await freePort();
    WV = WV_BASE + PORT;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r73-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const CFG = path.join(qs, 'config.json');
    fs.writeFileSync(CFG, JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r73' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r73 探针：pid=' + proc.pid);

    try {
        const sw = await connect('settings.html');
        check('L1 连上设置页', !!sw);
        if (!sw) return;
        const booted = await until(sw, "typeof CATALOG === 'object' && !!CATALOG.categories", 30000);
        check('L2 引擎数据加载完成', booted === true);
        try { await cdp(sw, 'Page.bringToFront'); } catch (e) { }
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(800);

        /* ---------- ① 默认：只有四个大类，列表是空的 ---------- */
        const def = JSON.parse(await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row'));
            return JSON.stringify({
                rows: rows.length,
                labels: rows.map(function(r){ var i = r.querySelector('.eng-nav-lv'); return i ? i.textContent : ''; }),
                chips: [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item')).map(function(b){ return b.textContent; }),
                listKids: document.getElementById('allList').children.length,
                hint: (document.querySelector('#allList .hint') || {}).textContent || '',
                sticky: getComputedStyle(document.getElementById('allGrpNav')).position
            });
        })()`));
        rec('默认状态：' + JSON.stringify(def));
        check('L3 默认只显示「大类」一行（4 颗），没有中类/小类/主题行',
            def.rows === 1 && def.labels[0] === '大类' && def.chips.length === 4, JSON.stringify(def));
        check('L4 默认不铺任何引擎（只有一句提示）',
            def.listKids === 1 && /选一个大类/.test(def.hint), JSON.stringify(def));
        check('L5 目录**不吸顶**（用户点名"别浮在页面上"）',
            def.sticky !== 'sticky', def.sticky);
        check('L6 目录里没有「主题」这一级', def.labels.indexOf('主题') < 0 && def.chips.indexOf('主题') < 0,
            JSON.stringify(def));

        /* ---------- ② 全部引擎：A-Z 分组 + 字母索引 ---------- */
        await ev(sw, `[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
            .find(function(b){ return b.textContent === '全部引擎'; }).click()`);
        await sleep(900);
        const letters = JSON.parse(await ev(sw, `(function(){
            var heads = [].slice.call(document.querySelectorAll('#allList .eng-letter-h'));
            var idx = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-track.wrap .eng-nav-item'))
                .map(function(b){ return b.textContent; });
            return JSON.stringify({
                heads: heads.map(function(h){ return h.textContent.replace(/[0-9]+$/,''); }),
                idx: idx,
                headsShown: heads.length,
                idxShown: idx.length,
                subHeaders: document.querySelectorAll('#allList .eng-sub-h, #allList .eng-theme-h').length,
                catHeaders: document.querySelectorAll('#allList .eng-cat-h').length,
                rows: document.querySelectorAll('#allList .list .item').length,
                wrapMode: !!document.querySelector('#allGrpNav .eng-nav-track.wrap')
            });
        })()`));
        rec('全部引擎：' + JSON.stringify({ heads: letters.heads.length, idx: letters.idx.length,
            rows: letters.rows, sub: letters.subHeaders, cat: letters.catHeaders }));
        /* 组头必须是"严格递增的单个字母/井号"——A→Z 的顺序 + 不重复 */
        const seq = letters.heads.join('');
        const orderKey = seq.replace(/#/g, '~');
        check('L7 「全部引擎」按字母分组（A→Z、不重复，末尾 # 收数字/符号）',
            letters.headsShown >= 20
            && orderKey === Array.from(orderKey).sort().join('')
            && new Set(orderKey.split('')).size === orderKey.length,
            JSON.stringify(letters.heads));
        check('L8 字母索引一次性全部陈列出来（和分组一一对应）',
            letters.idxShown === letters.headsShown && letters.wrapMode === true,
            'idx=' + letters.idxShown + ' heads=' + letters.headsShown);
        check('L9 「全部引擎」里**没有任何中类/主题/小类标题**（用户点名）',
            letters.subHeaders === 0 && letters.catHeaders === 0,
            'sub=' + letters.subHeaders + ' cat=' + letters.catHeaders);
        check('L10 全部引擎总行数 = 库里引擎数（777）', letters.rows === 777, String(letters.rows));

        /* ---------- ③ 点字母跳到那一组，且不被任何东西盖住 ---------- */
        const jump = JSON.parse(await ev(sw, `(function(){
            var idx = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-track.wrap .eng-nav-item'));
            var b = idx[idx.length - 1];          // 最后一个字母，肯定在页面深处
            var L = b.textContent;
            b.click();
            var h = document.getElementById('allLetter-' + L);
            var r = h ? h.getBoundingClientRect() : null;
            return JSON.stringify({ L: L, top: r ? Math.round(r.top) : null,
                navBottom: Math.round(document.getElementById('allGrpNav').getBoundingClientRect().bottom),
                winH: window.innerHeight });
        })()`));
        await sleep(400);
        const after = JSON.parse(await ev(sw, `(function(){
            var h = document.getElementById('allLetter-' + ${JSON.stringify(jump.L)});
            if (!h) return JSON.stringify({ err: 'no-head' });
            var r = h.getBoundingClientRect();
            return JSON.stringify({ top: Math.round(r.top), winH: window.innerHeight,
                ok: r.top >= 0 && r.top < window.innerHeight });
        })()`));
        rec('点字母 ' + jump.L + '：' + JSON.stringify(after));
        check('L11 点字母能跳到那一组（落在视口里）', after.ok === true, JSON.stringify(after));

        /* ---------- ④ 选大类 → 出现中类；选中小类 → 出现小类 ---------- */
        await ev(sw, `[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
            .find(function(b){ return b.textContent === '网页引擎'; }).click()`);
        await sleep(700);
        const lv2 = JSON.parse(await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row'));
            return JSON.stringify({
                rows: rows.length,
                labels: rows.map(function(r){ var i = r.querySelector('.eng-nav-lv'); return i ? i.textContent : ''; }),
                chips: [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item')).map(function(b){ return b.textContent; }),
                chips3: [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row:last-child .eng-nav-item')).map(function(b){ return b.textContent; }),
                catHeads: document.querySelectorAll('#allList .eng-cat-h').length,
                letterHeads: document.querySelectorAll('#allList .eng-letter-h').length
            });
        })()`));
        rec('选网页引擎：' + JSON.stringify({ rows: lv2.rows, labels: lv2.labels, chips: lv2.chips.slice(0, 8) }));
        /* r74：小类目录汇总**选了中大类就出现**（用户原话：「引擎库这里有一级
         * 大类，有中类，但是小类的目录汇总就没显示出来，小类的目录要显示出
         * 来」）。web 大类的全部小类 = 24 个。 */
        check('L12 选了大类出现「中类 + 小类」两行（r74 小类汇总始终给出）',
            lv2.rows === 3 && lv2.labels.join('/') === '大类/中类/小类' && lv2.chips.length >= 3,
            JSON.stringify(lv2.labels) + ' chips=' + lv2.chips.length);
        check('L13 下钻视图按小类分节（没有主题、没有字母组头）',
            lv2.catHeads > 0 && lv2.letterHeads === 0,
            'cat=' + lv2.catHeads + ' letter=' + lv2.letterHeads);

        await ev(sw, `[].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
            .find(function(b){ return b.textContent.indexOf('网页搜索引擎') === 0; }).click()`);
        await sleep(700);
        const lv3 = JSON.parse(await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row'));
            return JSON.stringify({
                rows: rows.length,
                labels: rows.map(function(r){ var i = r.querySelector('.eng-nav-lv'); return i ? i.textContent : ''; }),
                chips3: [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row:last-child .eng-nav-item')).map(function(b){ return b.textContent; }),
                catHeads: document.querySelectorAll('#allList .eng-cat-h').length,
                rows3: document.querySelectorAll('#allList .list .item').length
            });
        })()`));
        rec('选网页搜索引擎：' + JSON.stringify({ rows: lv3.rows, labels: lv3.labels, cats: lv3.chips3.length }));
        check('L14 小类行跟着中类收窄（只剩这个中类的小类，且和正文节一一对应）',
            lv3.rows === 3 && lv3.labels.join('/') === '大类/中类/小类' && lv3.chips3.length >= 2
            && lv3.catHeads === lv3.chips3.length, 'rows=' + lv3.rows + ' cats=' + lv3.chips3.length
            + ' heads=' + lv3.catHeads);

        /* 小类胶囊：r74 的口径是「点小类 = 只跳转、不重新过滤」；本次按用户要求
         * 改成**点小类 = 只看这一类**（用户原话：「小类最好是每一个就都呈现出来，
         * 一种胶囊的形式，这样我要哪个我点击就可以了，不用再一个个的找。
         * 还有设置引擎库里面也是这样」—— 横条面板那边也改成了平铺胶囊）。
         * 断言：点最后一个小类 → 正文只剩这一类（不再写节标题）、目录给出
         * 「全部小类」恢复入口；再点「全部小类」→ 行数回到点击前。 */
        const jumpCat = JSON.parse(await ev(sw, `(function(){
            var chips = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row:last-child .eng-nav-item'));
            var b = chips[chips.length - 1];      // 最后一个小类，引擎最多
            var name = b.textContent.replace(/[0-9]+$/, '');
            var before = document.querySelectorAll('#allList .list .item').length;
            b.click();
            return JSON.stringify({ name: name, before: before,
                anchor: b.dataset.jump || '' });
        })()`));
        await sleep(500);
        const afterJump = JSON.parse(await ev(sw, `(function(){
            var all = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row:last-child .eng-nav-item'))
                .find(function(x){ return x.textContent.indexOf('全部小类') === 0; });
            return JSON.stringify({
                rows: document.querySelectorAll('#allList .list .item').length,
                catHeads: document.querySelectorAll('#allList .eng-cat-h').length,
                allChip: all ? all.textContent : ''
            });
        })()`));
        rec('点小类「' + jumpCat.name + '」过滤：' + JSON.stringify(afterJump));
        check('L15 点目录小类 = 只看这一类（行数变少、不写节标题、给「全部小类」入口）',
            afterJump.rows > 0 && afterJump.rows < jumpCat.before
            && afterJump.catHeads === 0 && afterJump.allChip.indexOf('全部小类') >= 0,
            JSON.stringify(afterJump));

        // 点「全部小类」→ 恢复全量（行数回到点击前那个数）
        await ev(sw, `(function(){
            var all = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row:last-child .eng-nav-item'))
                .find(function(x){ return x.textContent.indexOf('全部小类') === 0; });
            if (all) all.click();
        })()`);
        await sleep(600);
        const restored = JSON.parse(await ev(sw,
            "JSON.stringify({ rows: document.querySelectorAll('#allList .list .item').length,"
            + " heads: document.querySelectorAll('#allList .eng-cat-h').length })"));
        rec('点「全部小类」恢复：' + JSON.stringify(restored));
        check('L15c 点「全部小类」恢复全量（行数与点击前一致）',
            restored.rows === jumpCat.before && restored.heads === lv3.chips3.length,
            JSON.stringify(restored));

        // 节标题上的「只看」按钮仍然保留（同一条过滤路，从正文里也能点）
        const pickOnly = JSON.parse(await ev(sw, `(function(){
            var heads = [].slice.call(document.querySelectorAll('#allList .eng-cat-h'));
            var h = heads[0];
            var btn = h.querySelector('.eng-cat-only');
            if (!btn) return JSON.stringify({ err: 'no-only-btn' });
            var name = h.textContent.replace(/[0-9]+$/, '').replace('只看', '');
            btn.click();
            return JSON.stringify({ name: name });
        })()`));
        await sleep(700);
        const catOnly = JSON.parse(await ev(sw, `(function(){
            return JSON.stringify({
                catHeads: document.querySelectorAll('#allList .eng-cat-h').length,
                rows: document.querySelectorAll('#allList .list .item').length,
                allChip: (function(){
                    var b = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-row:last-child .eng-nav-item'))
                        .find(function(x){ return x.textContent.indexOf('全部小类') === 0; });
                    return b ? b.textContent : '';
                })()
            });
        })()`));
        rec('点节标题「只看」（' + pickOnly.name + '）后：' + JSON.stringify(catOnly));
        check('L15b 节标题「只看」只列这一类、不重复写标题，且目录给「全部小类」恢复入口',
            catOnly.catHeads === 0 && catOnly.rows > 0 && catOnly.allChip.indexOf('全部小类') >= 0,
            JSON.stringify(catOnly));

        /* ---------- ⑤ 识图「留在剪贴板」开关 ---------- */
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"imgsearch\"]').click()");
        await sleep(500);
        const sw1 = JSON.parse(await ev(sw, `(function(){
            var el = document.getElementById('s-imgKeepClip');
            if (!el) return JSON.stringify({ err: 'no-switch' });
            return JSON.stringify({ exists: true, checked: el.checked,
                label: (el.closest('.row').querySelector('.rt b') || {}).textContent || '' });
        })()`));
        rec('剪贴板开关：' + JSON.stringify(sw1));
        check('L16 识图页有「框完的图留在剪贴板」开关，默认关',
            sw1.exists === true && sw1.checked === false, JSON.stringify(sw1));

        await ev(sw, `(function(){
            var el = document.getElementById('s-imgKeepClip');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await sleep(900);
        let disk = {};
        for (let i = 0; i < 20; i++) {
            try { disk = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { }
            if (disk.img_keep_clip === true) break;
            await sleep(200);
        }
        check('L17 打开开关写进配置（img_keep_clip = true）', disk.img_keep_clip === true,
            'disk=' + JSON.stringify(disk.img_keep_clip));

        /* ---------- ⑥ r74：首字母聚合索引（Win11 式） ----------
         * 用户原话：「当我点击大类全部引擎之后，这里有首字母，我确实可以点击
         * 快速的到那里，但我也希望在目录中的首字母位置，我点击之后能够像
         * win11 菜单一样，把所有的首字母都聚在一起，那这时候我点击任意一个
         * 首字母就能够跳转到相应的位置，而不是说每次我要搞不同的首字母还要
         * 跳到最上面然后再选。」 */
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(400);
        await ev(sw, `(function(){
            var chip = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
                .find(function(b){ return b.textContent === '全部引擎'; });
            if (chip) chip.click();
        })()`);
        await sleep(900);

        // L18 点目录里的字母 → 聚合面板打开，27 个格子全列，亮的与组头一一对应
        const idxOpen1 = JSON.parse(await ev(sw, `(function(){
            var chips = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item[data-letter]'));
            if (!chips.length) return JSON.stringify({ err: 'no-letter-chips' });
            chips[chips.length - 1].click();      // 点最后一个字母（页面最深处那组）
            var pop = document.getElementById('allIdxPop');
            var cells = [].slice.call(document.querySelectorAll('#allIdxPop .idx-pop-i'));
            return JSON.stringify({
                popOpen: !!pop && !pop.hidden,
                cells: cells.length,
                lit: cells.filter(function(c){ return !c.classList.contains('off'); }).length,
                fabVisible: !document.getElementById('allIdxFab').hidden,
                groups: document.querySelectorAll('#allList .eng-letter-h').length
            });
        })()`));
        await sleep(400);
        rec('点目录字母 → 聚合面板：' + JSON.stringify(idxOpen1));
        check('L18 点目录字母叫出聚合面板：27 格全列、亮格与组头一一对应、浮动钮可见',
            idxOpen1.popOpen === true && idxOpen1.cells === 27 && idxOpen1.lit === idxOpen1.groups
            && idxOpen1.fabVisible === true, JSON.stringify(idxOpen1));

        // L19 面板里点另一个字母 → 面板不关、跳到新组、当前字母在面板/目录/浮动钮三处点亮
        const idxJump = JSON.parse(await ev(sw, `(function(){
            var cells = [].slice.call(document.querySelectorAll('#allIdxPop .idx-pop-i:not(.off)'));
            var target = cells[0];                 // 第一个亮着的字母（肯定不是当前组）
            var L = target.textContent;
            target.click();
            return JSON.stringify({ L: L });
        })()`));
        await sleep(500);
        const idxAfter = JSON.parse(await ev(sw, `(function(){
            var h = document.getElementById('allLetter-' + ${JSON.stringify(idxJump.L)});
            var r = h ? h.getBoundingClientRect() : null;
            var pop = document.getElementById('allIdxPop');
            var onInPop = [].slice.call(pop.querySelectorAll('.idx-pop-i.on')).map(function(b){ return b.textContent; });
            var onInNav = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item[data-letter].on'))
                .map(function(b){ return b.textContent; });
            return JSON.stringify({
                L: ${JSON.stringify(idxJump.L)},
                popStillOpen: !pop.hidden,
                jumped: !!r && r.top >= 0 && r.top < window.innerHeight,
                onInPop: onInPop, onInNav: onInNav,
                fabBadge: (document.querySelector('#allIdxFab .idx-fab-c') || {}).textContent || ''
            });
        })()`));
        rec('面板里点 ' + idxJump.L + '（连跳）：' + JSON.stringify(idxAfter));
        check('L19 面板连跳：面板不关、跳到新组、面板/目录/浮动钮同步点亮当前字母',
            idxAfter.popStillOpen === true && idxAfter.jumped === true
            && idxAfter.onInPop.length === 1 && idxAfter.onInPop[0] === idxJump.L
            && idxAfter.onInNav.length === 1 && idxAfter.onInNav[0] === idxJump.L
            && idxAfter.fabBadge === idxJump.L, JSON.stringify(idxAfter));

        // L20 Esc 收起；再点浮动钮重新打开；点面板外面也收起
        const escRes = JSON.parse(await ev(sw, `(function(){
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            var pop = document.getElementById('allIdxPop');
            var afterEsc = pop.hidden;
            document.getElementById('allIdxFab').click();
            var afterFab = !pop.hidden;
            document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            var afterOutside = pop.hidden;
            return JSON.stringify({ afterEsc: afterEsc, afterFab: afterFab, afterOutside: afterOutside,
                fabStillThere: !document.getElementById('allIdxFab').hidden });
        })()`));
        rec('Esc / 浮动钮 / 点外面：' + JSON.stringify(escRes));
        check('L20 Esc 收起、点浮动钮重开、点外面收起（浮动钮始终在）',
            escRes.afterEsc === true && escRes.afterFab === true && escRes.afterOutside === true
            && escRes.fabStillThere === true, JSON.stringify(escRes));

        // L21 滚动监听：滚到哪一组，目录字母胶囊亮到哪
        const spyRes = JSON.parse(await ev(sw, `(function(){
            var heads = [].slice.call(document.querySelectorAll('#allList .eng-letter-h'));
            var h = heads[Math.min(5, heads.length - 1)];
            document.getElementById('allIdxFab').click();          // 先把面板打开（不关着也行）
            var main = document.querySelector('main') || document.scrollingElement;
            var target = document.getElementById('allLetter-' + h.textContent.replace(/[0-9]+$/, ''));
            main.scrollTop = main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top - 90;
            return new Promise(function(res){
                setTimeout(function(){
                    var L = h.textContent.replace(/[0-9]+$/, '');
                    var onNav = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item[data-letter].on'))
                        .map(function(b){ return b.textContent; });
                    res(JSON.stringify({ L: L, onNav: onNav,
                        badge: (document.querySelector('#allIdxFab .idx-fab-c') || {}).textContent || '' }));
                }, 500);
            });
        })()`));
        rec('滚动监听：' + JSON.stringify(spyRes));
        check('L21 滚动监听：滚到哪一组，目录字母胶囊与浮动钮徽章亮到哪',
            spyRes.onNav.length === 1 && spyRes.onNav[0] === spyRes.L && spyRes.badge === spyRes.L,
            JSON.stringify(spyRes));

        // L22 切走分页 → 浮动钮必须收起来（它是 fixed，不收会漂在别的页上面）；切回恢复
        const tabRes = JSON.parse(await ev(sw, `(function(){
            document.querySelector('#tabs button[data-tab=\"general\"]').click();
            var away = document.getElementById('allIdxFab').hidden;
            document.querySelector('#tabs button[data-tab=\"engines\"]').click();
            return new Promise(function(res){
                setTimeout(function(){
                    res(JSON.stringify({
                        awayHidden: away,
                        backVisible: !document.getElementById('allIdxFab').hidden
                    }));
                }, 300);
            });
        })()`));
        rec('分页切换：' + JSON.stringify(tabRes));
        check('L22 切走引擎页浮动钮收起、切回来恢复（不漂在别的页上）',
            tabRes.awayHidden === true && tabRes.backVisible === true, JSON.stringify(tabRes));

        // L23 下钻模式浮动钮同样收起来（只在全部引擎/搜索的字母视图出现）
        const drillFab = JSON.parse(await ev(sw, `(function(){
            var chip = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item'))
                .find(function(b){ return b.textContent === '网页引擎'; });
            if (chip) chip.click();
            return new Promise(function(res){
                setTimeout(function(){
                    var spy = [].slice.call(document.querySelectorAll('#allGrpNav .eng-nav-item[data-jump].spy'))
                        .map(function(b){ return b.textContent; });
                    res(JSON.stringify({ fabHidden: document.getElementById('allIdxFab').hidden,
                        jumpChips: document.querySelectorAll('#allGrpNav .eng-nav-item[data-jump]').length,
                        spy: spy }));
                }, 600);
            });
        })()`));
        rec('下钻模式：' + JSON.stringify(drillFab));
        check('L23 下钻模式浮动钮收起，小类目录 chip 带 data-jump（滚动监听认领用）',
            drillFab.fabHidden === true && drillFab.jumpChips > 0, JSON.stringify(drillFab));

        try { sw.close(); } catch (e) { }
    } finally {
        try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        rec('----------------------------------------');
        rec('r73 引擎库探针：' + pass + ' / ' + (pass + fail) + ' 通过');
    }
})().catch((e) => { rec('探针抛异常：' + ((e && e.stack) || e)); process.exit(1); });
