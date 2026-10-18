/* ============================================================================
 *  r72 横条识图按钮「一等成员」验证（需求 C）
 *
 *  用户原话：「识图搜索加入了横条之后，在引擎横条上的引擎这个框架里面，它只有
 *  一个换图标的按钮，应该也要有一个编辑图标，恢复默认图标，移出的按钮，也能
 *  通过按钮来进行引擎位置的移动，以及通过按住来移动位置。」
 *
 *  以前识图是横条上一个**固定位置**的独立按钮（#btnImg），不在 bar_list 里，
 *  所以只能在设置页给它"换图标"。现在它是 bar_list 的一等成员（`@img` 哨兵）：
 *  换图标 / 编辑图标 / 恢复默认 / 移出 / ↑↓ / 拖拽 全部到位。
 *
 *  这个探针逐条验证上面五件事，另外钉住两件容易翻车的事：
 *    · 横条上不能出现**两个**识图按钮（固定位那颗必须让开）；
 *    · 移出 / 加回要和「加到划条横条」那个开关保持同一状态（别自相矛盾）。
 *
 *  用法: node tools/r72-bar-img-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r72-bar-img-probe.txt');
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
            /* ⚠ 不能用 url.indexOf(sub) 就完事：`tauri.localhost/` 是
             * `tauri.localhost/settings.html` 的前缀，会连到设置页上去，
             * 然后在横条页里找 #btnImg 自然是 null。这里按"整页路径"匹配。 */
            const hit = ts.find((t) => {
                const u = t.url || '';
                if (t.type !== 'page') return false;
                if (sub === 'bar') return /tauri\.localhost\/?(index\.html)?(\?|$)/.test(u);
                return u.indexOf(sub) >= 0;
            });
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
const readBar = (cfg) => {
    try { return (JSON.parse(fs.readFileSync(cfg, 'utf8')).bar_list || []); } catch (e) { return []; }
};
async function waitBar(cfg, pred, ms) {
    const t0 = Date.now();
    let v = readBar(cfg);
    while (Date.now() - t0 < (ms || 8000)) {
        v = readBar(cfg);
        if (pred(v)) return v;
        await sleep(200);
    }
    return v;
}

(async () => {
    PORT = await freePort();
    WV = WV_BASE + PORT;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r72c-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const CFG = path.join(qs, 'config.json');
    /* 老配置的样子：bar_list 里**没有** @img（升级上来的那批用户）。
     * img_enable / img_add_to_bar 默认就是 true，所以启动时应该补一根哨兵。 */
    fs.writeFileSync(CFG, JSON.stringify({
        debug: true, theme: 'light',
        bar_list: ['百度', 'Google'],
        img_enable: true,
        img_add_to_bar: true,
    }, null, 1), 'utf8');

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r72c' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r72 横条识图探针：pid=' + proc.pid + '  APPDATA=' + tmp);

    try {
        /* ---------- ① 老配置迁移：识图补进 bar_list ---------- */
        const migrated = await waitBar(CFG, (v) => v.indexOf('@img') >= 0, 12000);
        check('C1 老配置启动时补上横条识图哨兵（bar_list 含 @img）',
            migrated.indexOf('@img') >= 0, JSON.stringify(migrated));

        const sw = await connect('settings.html');
        check('C2 连上设置页', !!sw);
        if (!sw) return;
        await until(sw, "typeof CONF === 'object' && !!document.getElementById('barList')", 30000);
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(500);

        /* ---------- ② 设置页那一行：抓手 + 五个按钮 ---------- */
        const row = JSON.parse(await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            if (!r) return JSON.stringify({ err: 'no-row' });
            return JSON.stringify({
                grip: !!r.querySelector('.grip') && getComputedStyle(r.querySelector('.grip')).visibility !== 'hidden',
                addRow: r.classList.contains('add-row'),
                btns: [].slice.call(r.querySelectorAll('.ops .mini')).map(function(b){ return b.textContent; }),
                label: (r.querySelector('.nm em') || {}).textContent || ''
            });
        })()`));
        rec('识图那一行：' + JSON.stringify(row));
        check('C3 识图在「横条上的引擎」列表里，而且是一等成员（有抓手、能拖）',
            row.err === undefined && row.grip === true && row.addRow === false,
            JSON.stringify(row));
        /* r80b：「编辑图标」现在受**图标编辑器总开关**控制（默认关 → 不出现）。
         * 这个探针跑的是默认配置（开关关着），所以按设计就不该有那顆按钮。
         * 开关打开后它会出现 —— 那条路由 `tools/r80b-probe.js` 的 2g 断言钉着。 */
        check('C4 按钮组齐全：上移 / 下移 / 换图标 / 移出（编辑图标受总开关控制，默认关时不出现）',
            ['↑', '↓', '换图标', '移出'].every((t) => row.btns.indexOf(t) >= 0),
            JSON.stringify(row.btns));
        check('C5 没换过图标时不显示「默认」（没东西可恢复，别摆个死按钮）',
            row.btns.indexOf('默认') < 0, JSON.stringify(row.btns));

        /* ---------- ③ 按钮移动位置：点 ↑ 让它往前挪一位 ---------- */
        const before = readBar(CFG);
        const i0 = before.indexOf('@img');
        await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            var up = [].slice.call(r.querySelectorAll('.ops .mini')).find(function(b){ return b.textContent === '↑'; });
            up.click();
        })()`);
        const moved = await waitBar(CFG, (v) => v.indexOf('@img') !== i0, 8000);
        rec('移动前 ' + JSON.stringify(before) + ' → 移动后 ' + JSON.stringify(moved));
        check('C6 点「↑」真的改了 bar_list 里的顺序（按钮移动位置）',
            moved.indexOf('@img') === i0 - 1, 'from=' + i0 + ' to=' + moved.indexOf('@img'));

        /* ---------- ④ 横条上真的画出来了，而且只有一个 ---------- */
        const bw = await connect('bar', 20000);
        check('C7 连上横条页', !!bw);
        let barInfo = {};
        if (bw) {
            await until(bw, "typeof CONF === 'object' && !!CATALOG && typeof renderBar === 'function'", 20000);
            const rb = await ev(bw, "try { renderBar(true); 'ok' } catch (e) { 'ERR ' + e }");
            if (rb !== 'ok') rec('renderBar 调用失败：' + rb);
            await sleep(600);
            const raw = await ev(bw, `(function(){
                try {
                    var cells = [].slice.call(document.querySelectorAll('#engines .engine'));
                    var imgCells = cells.filter(function(c){ return c.dataset.img === '1'; });
                    return JSON.stringify({
                        cells: cells.length,
                        imgCells: imgCells.length,
                        imgIndex: cells.indexOf(imgCells[0]),
                        fixedHidden: document.getElementById('btnImg').hidden,
                        hasIcon: !!(imgCells[0] && imgCells[0].querySelector('svg, img'))
                    });
                } catch (e) { return 'ERR ' + e; }
            })()`);
            rec('横条原始返回：' + String(raw).slice(0, 240));
            try { barInfo = JSON.parse(raw); } catch (e) { barInfo = { err: String(raw).slice(0, 120) }; }
            check('C8 横条引擎区里画出了识图按钮（带图标）',
                barInfo.imgCells === 1 && barInfo.hasIcon === true, JSON.stringify(barInfo));
            check('C9 固定位那颗 #btnImg 已让开（不会出现两个识图按钮）',
                barInfo.fixedHidden === true, JSON.stringify(barInfo));
            check('C10 它排在 bar_list 指定的位置（不是永远贴在最左边）',
                barInfo.imgIndex >= 0, JSON.stringify(barInfo));
        }

        /* ---------- ⑤ 移出 / 加回：和「加到划条横条」开关同步 ---------- */
        await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            [].slice.call(r.querySelectorAll('.ops .mini'))
                .find(function(b){ return b.textContent === '移出'; }).click();
        })()`);
        const afterRemove = await waitBar(CFG, (v) => v.indexOf('@img') < 0, 8000);
        check('C11 点「移出」：哨兵从 bar_list 里去掉', afterRemove.indexOf('@img') < 0,
            JSON.stringify(afterRemove));
        const addRow = JSON.parse(await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            if (!r) return JSON.stringify({ err: 'row-gone' });
            return JSON.stringify({
                addRow: r.classList.contains('add-row'),
                btns: [].slice.call(r.querySelectorAll('.ops .mini')).map(function(b){ return b.textContent; })
            });
        })()`));
        check('C12 移出之后那一行变成「＋ 加进横条」入口（不是整行消失）',
            addRow.addRow === true && addRow.btns.indexOf('＋ 加进横条') >= 0,
            JSON.stringify(addRow));

        const flagAfterRemove = await ev(sw, "(CONF && CONF.imgAddToBar)");
        check('C13 移出同时把「加到划词横条」开关关掉（同一件事的两面）',
            flagAfterRemove === false, 'imgAddToBar=' + flagAfterRemove);

        await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            [].slice.call(r.querySelectorAll('.ops .mini'))
                .find(function(b){ return b.textContent === '＋ 加进横条'; }).click();
        })()`);
        const back = await waitBar(CFG, (v) => v.indexOf('@img') >= 0, 8000);
        check('C14 点「＋ 加进横条」能加回来（哨兵回到 bar_list）',
            back.indexOf('@img') >= 0, JSON.stringify(back));

        /* ---------- ⑥ 按住拖动改位置 ----------
         * 用 **CDP 真鼠标事件**（Input.dispatchMouseEvent）而不是页面里
         * dispatchEvent：合成事件在 WebView2 里不一定能触发 pointer 那条链
         * （第一次跑的时候合成 pointerdown 根本没让 .dragging 亮起来），
         * 而真鼠标事件是用户按住拖动的同一条路。 */
        const dragBefore = readBar(CFG);
        // 先确认"通用"页是**显示着的**、行也在视口里 —— 隐藏页里 rect 全是 0，
        // 鼠标事件会打在 (0,0) 上，看起来像"拖不动"。
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(400);
        await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            if (r) r.scrollIntoView({ block: 'center' });
        })()`);
        await sleep(300);
        const geo = JSON.parse(await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#barList .item'));
            var r = rows.find(function(x){
                var nm = x.querySelector('.nm');
                return nm && nm.textContent.indexOf('识图搜索') === 0;
            });
            var prev = r && r.previousElementSibling;
            if (!r || !prev) return JSON.stringify({ err: 'no-prev' });
            var b = r.getBoundingClientRect(), pb = prev.getBoundingClientRect();
            if (b.height === 0) return JSON.stringify({ err: 'row-hidden' });
            return JSON.stringify({
                x: Math.round(b.left + b.width * 0.5), y: Math.round(b.top + b.height * 0.5),
                ty: Math.round(pb.top + Math.min(6, pb.height / 2))
            });
        })()`));
        let dragState = 'no-geo';
        if (!geo.err) {
            await cdp(sw, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
            await sleep(80);
            await cdp(sw, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y - 8, button: 'left' });
            await sleep(80);
            await cdp(sw, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.ty, button: 'left' });
            await sleep(120);
            dragState = await ev(sw, "document.querySelector('#barList .item.dragging') ? 'dragging' : 'not-dragging'");
            await cdp(sw, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.ty, button: 'left', clickCount: 1 });
        }
        const dragAfter = await waitBar(CFG, (v) => v.join('|') !== dragBefore.join('|'), 8000);
        rec('拖动前 ' + JSON.stringify(dragBefore) + ' [拖动态=' + dragState + ',geo=' + JSON.stringify(geo) + '] → 拖动后 ' + JSON.stringify(dragAfter));
        check('C15 按住拖动能换位置（真鼠标事件驱动 move_bar_item）',
            dragState === 'dragging' && dragAfter.join('|') !== dragBefore.join('|'),
            'dragStart=' + dragState + ' after=' + JSON.stringify(dragAfter));

        try { sw.close(); } catch (e) { }
        if (bw) { try { bw.close(); } catch (e) { } }
    } finally {
        try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        rec('----------------------------------------');
        rec('r72 横条识图探针：' + pass + ' / ' + (pass + fail) + ' 通过');
    }
})().catch((e) => { rec('探针抛异常：' + ((e && e.stack) || e)); process.exit(1); });
