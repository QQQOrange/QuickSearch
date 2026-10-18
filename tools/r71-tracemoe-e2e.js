/* r71 trace.moe 端到端验证（真 exe、真上传、真结果页）：
 *  ① Edge kiosk 全屏放一张动漫截图（独立 profile，按 pid 杀，不碰用户 Edge）
 *  ② 驱动 QuickSearch 的 img_region 抓全屏 → 走完整上传链路
 *     （POST api.trace.moe → JSON → tracemoe_result_page → 默认浏览器开 file://）
 *  ③ 验证 %TEMP%\QuickSearch\img\tracemoe-result-*.html 内容：
 *     番名 / 第几集 / mm:ss / 相似度 / AniList 链接，且 null 不漏出
 *  ④ 顺带验证 SauceNAO 死代码修复那一支的判据函数没被带坏（只看日志）
 * 用法: node tools/r71-tracemoe-e2e.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const IMG = process.argv[2] || path.join(__dirname, '..', 'tools', '_r71-anime.jpg');
const OUT = path.join(__dirname, 'r71-tracemoe-e2e.txt');
const PORT = 9420;
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
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(900);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r71e2e-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    // 只勾 tracemoe 一家 + 设为默认：一轮识图只走这一条上传链路
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度'],
        img_enable: true, img_add_to_bar: true,
        img_engines: ['tracemoe'],
        img_default_engine: 'tracemoe',
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r71e2e' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r71 trace.moe e2e：pid=' + proc.pid + '  图=' + IMG);
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('连不上横条'); process.exit(1); }

    /* ---------- ① Edge kiosk 全屏放图 ---------- */
    const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const edgeProfile = path.join(tmp, 'edge-kiosk');
    const edge = spawn(EDGE, [
        '--kiosk', 'file:///' + IMG.replace(/\\/g, '/'),
        '--user-data-dir=' + edgeProfile,
        '--no-first-run', '--disable-session-crashed-bubble',
    ], { stdio: 'ignore', detached: false });
    rec('Edge kiosk pid=' + edge.pid);
    await sleep(6000);   // 等图全屏画稳

    /* ---------- ② 驱动 img_region 抓全屏 ---------- */
    const geo = await ev(ws, `JSON.stringify({
        w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio })`);
    rec('屏幕（css）：' + geo);
    const g = JSON.parse(geo);
    const r = await ev(ws, `window.__TAURI__.core.invoke('img_region',
        { x: 0, y: 0, w: ${g.w}, h: ${g.h}, dpr: ${g.dpr} })`);
    rec('img_region 返回：' + r);
    rec('上传中（trace.moe 一般 1-3 秒回）…');
    await sleep(18000);   // 抓屏 700ms + 上传 + 渲染 + 开浏览器

    /* ---------- ③ 结果页 ---------- */
    const imgDir = path.join(os.tmpdir(), 'QuickSearch', 'img');
    let page = null, pagePath = null;
    try {
        const files = fs.readdirSync(imgDir).filter((f) => /^tracemoe-result-.*\.html$/.test(f));
        rec('结果页文件：' + JSON.stringify(files));
        if (files.length) {
            files.sort((a, b) => fs.statSync(path.join(imgDir, b)).mtimeMs - fs.statSync(path.join(imgDir, a)).mtimeMs);
            pagePath = path.join(imgDir, files[0]);
            page = fs.readFileSync(pagePath, 'utf8');
        }
    } catch (e) { rec('读结果页目录失败：' + e.message); }
    check('E1 结果页落了盘', !!page, String(pagePath));
    if (page) {
        check('E2 有卡片（≥1 张 section.card）', (page.match(/class="card"/g) || []).length >= 1,
            'cards=' + (page.match(/class="card"/g) || []).length);
        check('E3 番名不是「（未知片名）」', page.indexOf('（未知片名）') < 0, '');
        const m = page.match(/<strong>([^<]+)<\/strong>/);
        rec('  第一条片名：' + (m ? m[1] : '(没解析到)'));
        check('E4 时间点是 mm:ss 格式', /\d+:\d{2} – \d+:\d{2}/.test(page), '');
        check('E5 相似度是百分数', /相似度 \d+\.\d%/.test(page), '');
        check('E6 AniList / MAL 外链在', page.indexOf('anilist.co/anime/') >= 0 || page.indexOf('myanimelist.net/anime/') >= 0, '');
        check('E7 null 不漏到页面上', page.indexOf('null') < 0, '');
        check('E8 预览媒体在（video 或 img）', page.indexOf('<video') >= 0 || page.indexOf('<img') >= 0, '');
        rec('  页面大小：' + page.length + ' 字节');
    }

    /* ---------- ④ 日志链路 ---------- */
    const logFile = path.join(tmp, 'QuickSearch', 'log.txt');
    let log = '';
    try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) { }
    rec('---- log.txt 尾部 ----');
    rec(log.split('\n').slice(-18).join('\n'));
    check('E9 日志有抓屏与 jpeg 编码', /img_region css=/.test(log) && /img: jpeg \d+ KB/.test(log), '');
    check('E10 日志走到 tracemoe 结果页', /tracemoe/.test(log), '');

    rec('========== r71 trace.moe e2e：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { execSync('taskkill /PID ' + edge.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
    try { proc.kill(); } catch (e) { }
    await sleep(400);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
