/* r70 诊断：设置页「引擎库」的真实 DOM 结构。
 * 目的：看清 4 颗大类胶囊下方到底有哪几条横向目录栏、层级是否完整。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9414;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = [];
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(path.join(__dirname, 'r70-lib-diag.txt'), L.join('\n'), 'utf8'); } catch (e) { } };
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
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(900);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r70-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度', 'Google'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r70' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('已启动设置页 pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('连不上设置页'); process.exit(1); }

    // 切到「引擎」分页
    await ev(ws, `(function(){
        var b = document.querySelector('[data-tab="engines"]') || document.querySelector('.nav [data-tab="engines"]');
        if (!b) { var ns = document.querySelectorAll('.nav button, .nav a'); for (var n of ns) if ((n.textContent||'').indexOf('引擎') >= 0) { b = n; break; } }
        if (b) b.click();
        return b ? 'clicked ' + (b.dataset.tab || b.textContent) : 'NOT FOUND';
    })()`);
    await sleep(2500);

    const dump = await ev(ws, `(function(){
        var sec = document.getElementById('sec-lib');
        if (!sec) return 'NO sec-lib';
        var lines = [];
        lines.push('sec-lib 直接子元素:');
        for (var ch of sec.children) {
            lines.push('  <' + ch.tagName.toLowerCase() + ' class="' + (ch.className || '') + '" id="' + (ch.id || '') + '"> children=' + ch.children.length);
        }
        var nav = document.getElementById('allGrpNav');
        lines.push('allGrpNav 胶囊数: ' + (nav ? nav.children.length : 'N/A'));
        if (nav) for (var b of nav.children) lines.push('    · ' + b.textContent);
        // 第一条横向目录栏（若有）
        var anyNav = sec.querySelectorAll('.eng-nav, .lib-toc, .cat-nav');
        lines.push('sec-lib 内导航条数量: ' + anyNav.length);
        anyNav.forEach(function(n, i){ lines.push('    nav#' + i + ' class=' + n.className + ' items=' + n.children.length + ' first=' + (n.children[0] ? n.children[0].textContent : '')); });
        // 列表层级
        var box = document.getElementById('allList');
        lines.push('allList 顶层子元素序列（前 30 个）:');
        var n = 0;
        for (var ch of box.children) {
            if (n++ >= 30) break;
            var txt = (ch.textContent || '').trim().slice(0, 40);
            lines.push('    <' + ch.tagName.toLowerCase() + ' class="' + (ch.className || '') + '"> ' + txt);
        }
        return lines.join('\\n');
    })()`);
    rec('=== 引擎库 DOM ===\\n' + dump);
    try { proc.kill(); } catch (e) { }
    await sleep(400);
    process.exit(0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
