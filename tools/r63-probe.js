/* r63：数一数「引擎库」里到底有没有那五个子类分节。
 * 用户说"网页搜索/网页直达、软件搜索/软件直达这些现在都没了"——
 * 代码里 ALL_SUBS / ALL_SUB_FALLBACK 是齐全的，必须跑起来看真实的 DOM。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r63-probe.txt');
const PORT = 9411;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
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
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r63-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度'],
        apps: [{ id: 'a1', name: '测试软件', url: 'https://example.com/?q=%s', kind: 'search' }],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r63' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r63 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页连不上'); process.exit(1); }

    await ev(ws, `document.querySelector('#tabs button[data-tab="engines"]').click()`);
    await sleep(2000);

    const dom = await ev(ws, `(function(){
        var subs = Array.from(document.querySelectorAll('#allList .eng-sub-h')).map(function(e){return e.textContent.trim();});
        var grps = Array.from(document.querySelectorAll('#allList .eng-grp-t')).map(function(e){return e.textContent.trim();});
        return JSON.stringify({ subs: subs, grps: grps,
            subCount: subs.length, grpCount: grps.length,
            // r64：第三层「用途分类」标题
            cats: Array.from(document.querySelectorAll('#allList .eng-cat-h')).map(function(e){return e.textContent.trim();}),
            // r65：第三层的**目录**（可点胶囊）
            catNav: !!document.getElementById('engCatNav'),
            catChips: Array.from(document.querySelectorAll('#engCatNav .eng-cat-chip')).map(function(e){return e.textContent;}),
            catNavHidden: (document.getElementById('engCatNav') || {}).hidden === true,
            // 行是 allRowNode 建的 div.item（不是 .eng-row，那是 OCR 那张表的类）
            rows: document.querySelectorAll('#allList .item').length });
    })()`);
    let D = {};
    try { D = JSON.parse(dom); } catch (e) { }
    rec('分节标题 = ' + JSON.stringify(D.subs));
    rec('大类标题 = ' + JSON.stringify(D.grps));

    check('大类有三个（网页/软件/快捷键）', D.grpCount === 3, String(D.grpCount));
    check('子类分节**确实渲染出来了**', D.subCount >= 3, String(D.subCount));
    for (const want of ['搜索', '直达', '快捷键']) {
        check('子类里有「' + want + '」这一类', D.subs.some((s) => s.indexOf(want) >= 0), JSON.stringify(D.subs));
    }
    check('列表里真有引擎行（不是空壳）', Number(D.rows) > 100, String(D.rows));
    /* r64：第三层「用途分类」 */
    rec('用途分类 = ' + JSON.stringify((D.cats || []).slice(0, 12)));
    check('第三层「用途分类」渲染出来了（购物/工具/娱乐 那类）',
        Array.isArray(D.cats) && D.cats.length >= 3, String((D.cats || []).length));
    check('用途分类不只一个（证明真的按 cat 分了，不是把所有行堆一节）',
        Array.isArray(D.cats) && D.cats.length > 5, String((D.cats || []).length));

    /* r69：横条分类目录已按用户要求**删掉**。
     * 用户原话：「除了横着的 4 个胶囊的目录之外，下面横条的目录就没有必要了，
     * 功能重复了，所以就直接删掉。」—— 这里改成"确认它真的没了"。
     * 目录删了，但**分类标题（第三层）和三级层级都还在**，下面继续验。 */
    rec('分类目录胶囊 = ' + JSON.stringify((D.catChips || []).slice(0, 12)));
    check('横条分类目录已删掉（与 4 个大类胶囊重复）', D.catNav === false);
    check('分类标题（第三层）还在 —— 删的是目录，不是分类本身',
        Array.isArray(D.cats) && D.cats.length >= 5, String((D.cats || []).length));

    // 逐个点大类胶囊，看筛选后子类是否跟着变
    for (const [g, label] of [['web', '网页引擎'], ['app', '软件引擎'], ['hotkey', '快捷键引擎']]) {
        await ev(ws, `(function(){
            var bs = Array.from(document.querySelectorAll('#allGrpNav .eng-nav-item'));
            var b = bs.find(function(x){ return x.textContent.indexOf(${JSON.stringify(label)}) >= 0; });
            if (b) b.click();
            return 'ok';
        })()`);
        await sleep(900);
        const one = await ev(ws, `(function(){
            var subs = Array.from(document.querySelectorAll('#allList .eng-sub-h')).map(function(e){return e.textContent.trim();});
            var grps = Array.from(document.querySelectorAll('#allList .eng-grp-t')).map(function(e){return e.textContent.trim();});
            return JSON.stringify({ subs: subs, grps: grps });
        })()`);
        let O = {};
        try { O = JSON.parse(one); } catch (e) { }
        rec('筛「' + label + '」→ 大类 ' + JSON.stringify(O.grps) + '，子类 ' + JSON.stringify(O.subs));
        check('筛「' + label + '」只剩这一类', Array.isArray(O.grps) && O.grps.length === 1, JSON.stringify(O.grps));
        check('筛「' + label + '」时子类分节还在', Array.isArray(O.subs) && O.subs.length >= 1, JSON.stringify(O.subs));
    }
    // 复位
    await ev(ws, `(function(){
        var bs = Array.from(document.querySelectorAll('#allGrpNav .eng-nav-item'));
        var b = bs.find(function(x){ return x.textContent.indexOf('全部引擎') >= 0; });
        if (b) b.click();
        return 'ok';
    })()`);

    rec('');
    rec('========== r63：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(400);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
