/* r80f：引擎库里"搜一个引擎出现多个同样的"——定位重复来源
 *
 * 怀疑点（settings.js 的 renderAllList）：
 * ```js
 * const extra = CATALOG.toolbar.filter((e) => !inCats.has(e.name));
 * if (extra.length) {
 *     for (const g of tree) for (const s of g.subs) {
 *         const mine = s.key === 'hotkey' ? buckets.hotkey : ... ;
 *         if (mine.length) s.cats.unshift({ title: '横条默认引擎', engines: mine });
 *     }
 * }
 * ```
 * `mine` 是**同一个数组引用**，却被 unshift 进**每一个** kind 匹配的 sub。
 * 而 kind 相同的 sub 在不同 group 下会有多个 → 同一个引擎被列多次。
 *
 * 这个探针直接数：搜索若干常见词，看每个名字出现几次，并列出它来自哪些
 * (group, sub, cat) 组合 —— 这样就知道重复是不是上面那条注入造成的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 90000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (!x || x.id !== i) return;
            clearTimeout(timer); ws.removeEventListener('message', on);
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
    while (Date.now() - t0 < (ms || 40000)) {
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
    while (Date.now() - t0 < (ms || 25000)) { if (await ev(ws, expr) === true) return true; await sleep(250); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80f-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80f' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    console.log('r80f 引擎重复诊断：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        if (!sw) { console.log('连不上'); return; }
        await until(sw, "typeof CONF === 'object' && typeof CATALOG === 'object' && !!CATALOG", 40000);

        /* 1. 数据层面：qsAllEngineRows 里每个名字出现几次 */
        const dupData = await ev(sw, `(function(){
            var tree = qsCatalogGroups(CATALOG);
            var rows = window.qsAllEngineRows(tree);
            var count = {}, where = {};
            rows.forEach(function(r){
                count[r.name] = (count[r.name]||0) + 1;
                (where[r.name] = where[r.name] || []).push(r.group + '/' + r.sub + '/' + r.cat);
            });
            var dups = Object.keys(count).filter(function(n){ return count[n] > 1; })
                .map(function(n){ return { name: n, times: count[n], where: where[n].slice(0,6) }; });
            return JSON.stringify({ total: rows.length, uniq: Object.keys(count).length, dupCount: dups.length, sample: dups.slice(0,8) });
        })()`);
        console.log('');
        console.log('=== 1. 数据层（qsAllEngineRows）===');
        console.log(dupData);

        /* 2. 找出"横条默认引擎"这条合成分类被注入了几次 */
        const inject = await ev(sw, `(function(){
            var tree = qsCatalogGroups(CATALOG);
            var inCats = new Set();
            for (var i=0;i<CATALOG.categories.length;i++) for (var j=0;j<CATALOG.categories[i].engines.length;j++) inCats.add(CATALOG.categories[i].engines[j].name);
            var extra = CATALOG.toolbar.filter(function(e){ return !inCats.has(e.name); });
            var subKeys = [];
            tree.forEach(function(g){ g.subs.forEach(function(s){ subKeys.push(g.key + '/' + s.key); }); });
            return JSON.stringify({
                toolbarTotal: CATALOG.toolbar.length,
                extraNotInCats: extra.length,
                extraNames: extra.map(function(e){ return e.name; }).slice(0,10),
                allSubKeys: subKeys
            });
        })()`);
        console.log('');
        console.log('=== 2. 「横条默认引擎」注入条件 ===');
        console.log(inject);

        /* 3. 界面层：真的搜一个词，数渲染出来的行 */
        const terms = ['baidu', '百度', 'google', 'b'];
        for (const term of terms) {
            const r = await ev(sw, `(function(){
                var f = document.getElementById('allFilter');
                f.value = ${JSON.stringify(term)};
                f.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
            await sleep(700);
            const rowsInfo = await ev(sw, `(function(){
                var box = document.getElementById('allList');
                var items = box ? box.querySelectorAll('[data-name]') : [];
                var names = [];
                for (var i=0;i<items.length;i++) names.push(items[i].getAttribute('data-name'));
                var count = {};
                names.forEach(function(n){ count[n] = (count[n]||0)+1; });
                var dups = Object.keys(count).filter(function(n){ return count[n]>1; });
                return JSON.stringify({ shown: names.length, dupNames: dups.slice(0,6), dupTimes: dups.slice(0,6).map(function(n){return n+'×'+count[n];}) });
            })()`);
            console.log('  搜「' + term + '」→ ' + rowsInfo);
        }
    } catch (e) {
        console.log('出错：' + (e && e.message));
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(500);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
