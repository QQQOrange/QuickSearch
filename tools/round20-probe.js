/* ============================================================================
 *  专项探针：轮 20 的五条
 *
 *  要证的事（编号与用户反馈一一对应）：
 *    ① 备份命名**只有一个口径**：本地落盘的文件名 == 云端上传的文件名
 *       （`config(YYYY-MM-DD HH-MM-SS).QuickSearch`），且**逐字节相同**、内容是加密的。
 *       「备份文件名」这个自定义设置项已经删掉。
 *    ② 滚动备份改叫 `config.auto(时间).QuickSearch` —— 每次改设置都会重写它，
 *       但**绝不能把用户手动做的那份备份一起删掉**（同名就会，这是灾难）。
 *    ③ 「仅保留最近 10 份」= 本地 + 云端**一起清**，两边都只留最新 10 份，
 *       更早的精确删除（不是"大概删几个"）。
 *    ④ 云端备份「管理」模式：点一下所有云端备份变成可勾选，勾完能删掉，
 *       删完列表自动刷新。
 *    ⑤ 磨砂强度：滑块值不再 1:1 当 px（走 qsBlurPx 曲线，低档可见、封顶 24px），
 *       横条上真吃 backdrop-filter；设置页预览舞台铺了纹理底，所以预览里
 *       也能看出效果（以前是纯色底，糊完还是纯色，用户以为这选项没用）。
 *    ⑥ 横条收藏面板的「全部展开 / 全部折叠」**只在目录含二级目录时出现**。
 *
 *  做法：起一个**本机最小 WebDAV 服务**（内存文件系统，支持 PROPFIND/PUT/MKCOL/
 *  GET/DELETE），另起一个隔离实例（独立 APPDATA + WEBVIEW2_USER_DATA_FOLDER +
 *  QS_INSTANCE_TAG），全程用 CDP 驱动 DOM 点击 —— 不碰真实鼠标键盘、不读剪贴板。
 *
 *  用法：node tools/round20-probe.js
 *  输出：tools/round20-probe.txt + 若干截图
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round20-probe.txt');
const TAG = '-probe-r20';
const PORT = 9345;                 // CDP
const DAV_PORT = 18100;            // 本机仿真 WebDAV
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

/* ⚠ **不能用 Atomics.wait 睡眠**。
 *
 *  这个探针自己还托管着一个 HTTP 服务（仿真 WebDAV），而 Atomics.wait 是把
 *  **主线程**整个冻住的 —— 冻住的这段时间 Node 的事件循环完全不转，
 *  服务端连 accept 都做不了。于是程序那边的 PROPFIND 会 **connect 超时**
 *  （实测日志：os error 10060，"连接方在一段时间后没有正确答复"），
 *  静默退化到"解析 HTML 目录页"。排查时看着像产品 bug，其实是探针自己
 *  把服务端按住了 —— 改用 setTimeout，睡眠期间事件循环照常跑。 */
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

/** 轮询用取值器：`waitFor('…', probeEq(ws, expr, 期望值), ms)`。
 *
 *  ⚠ 一定要用这个，别写 `() => evalJs(ws, expr) === 10` ——
 *    `evalJs` 返回的是 **Promise**，那个 `===` 比的是 Promise 本身，
 *    恒为 false。症状特别迷惑：轮询永远等不到超时，而紧跟着的直接读取
 *    又是对的，看起来像"等的时间不够"，其实是条件从来没成立过。 */
const probeEq = (ws, expr, want) => async () => (await evalJs(ws, expr)) === want;

/** 轮询到条件成立为止（**不写"点完 sleep 固定秒数再读"** —— 异步状态会让那种
 *  写法必假失败，这是前面几轮踩出来的）。返回 true/false，不抛。 */
async function waitFor(desc, fn, ms) {
    const t0 = Date.now();
    const limit = ms || 20000;
    while (Date.now() - t0 < limit) {
        let v = false;
        try { v = await fn(); } catch (e) { v = false; }
        if (v) return true;
        await sleep(250);
    }
    info('等待超时：' + desc);
    return false;
}

/* ============================================================================
 *  本机最小 WebDAV 服务（内存文件系统）
 * ========================================================================== */
const DAV_USER = 'qsuser', DAV_PASS = 'qspass';
const DAV_BASE = 'http://127.0.0.1:' + DAV_PORT + '/dav/';
const davFiles = new Map();        // name -> { buf: Buffer, mtime: Date }
let davHits = [];                  // 方法调用流水，便于事后核对

const httpDate = (d) => d.toUTCString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function startDav() {
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        // ⚠ 必须解码：PUT 的路径段是百分号编码过的（文件名里有空格和括号），
        //   不解码的话服务端存下来的键是 `config%282026-…%29.QuickSearch`，
        //   拿它去和本地真实文件名比对必然对不上 —— 那是探针自己的锅，不是功能的锅。
        const sub = decodeURIComponent(u.pathname.replace(/^\/dav\/?/, ''));
        davHits.push(req.method + ' /' + sub);

        const auth = req.headers['authorization'] || '';
        const want = 'Basic ' + Buffer.from(DAV_USER + ':' + DAV_PASS).toString('base64');
        if (auth !== want) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="qs"' });
            return res.end('need auth');
        }

        const body = [];
        req.on('data', (c) => body.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(body);

            if (req.method === 'MKCOL') {
                res.writeHead(201);
                return res.end();
            }

            if (req.method === 'PUT') {
                davFiles.set(sub, { buf: raw, mtime: new Date() });
                res.writeHead(201, { 'Content-Type': 'application/octet-stream' });
                return res.end();
            }

            if (req.method === 'DELETE') {
                davFiles.delete(sub);
                res.writeHead(204);
                return res.end();
            }

            if (req.method === 'PROPFIND') {
                const parts = [
                    '<?xml version="1.0" encoding="utf-8"?>',
                    '<D:multistatus xmlns:D="DAV:">',
                    '<D:response><D:href>/dav/</D:href><D:propstat><D:prop>',
                    '<D:resourcetype><D:collection/></D:resourcetype>',
                    '<D:getcontentlength>0</D:getcontentlength>',
                    '<D:getlastmodified>' + httpDate(new Date()) + '</D:getlastmodified>',
                    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
                ];
                for (const [name, f] of davFiles) {
                    parts.push(
                        '<D:response><D:href>/dav/' + name.replace(/ /g, '%20') + '</D:href>'
                        + '<D:propstat><D:prop><D:resourcetype/>'
                        + '<D:getcontentlength>' + f.buf.length + '</D:getcontentlength>'
                        + '<D:getlastmodified>' + httpDate(f.mtime) + '</D:getlastmodified>'
                        + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>');
                }
                parts.push('</D:multistatus>');
                res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
                return res.end(parts.join(''));
            }

            if (req.method === 'GET' || req.method === 'HEAD') {
                const f = davFiles.get(sub);
                if (!f) {
                    if (!sub) {
                        const links = [...davFiles.keys()]
                            .map((n) => '<a href="' + n.replace(/ /g, '%20') + '">' + esc(n) + '</a>')
                            .join('\n');
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        return res.end('<!doctype html><meta charset="utf-8"><h1>dav</h1>' + links);
                    }
                    res.writeHead(404);
                    return res.end('no');
                }
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': f.buf.length,
                    'Last-Modified': httpDate(f.mtime),
                });
                return req.method === 'HEAD' ? res.end() : res.end(f.buf);
            }

            res.writeHead(405);
            res.end();
        });
    });
    return new Promise((r) => srv.listen(DAV_PORT, '127.0.0.1', () => r(srv)));
}

/* ============================================================================
 *  CDP 客户端
 * ========================================================================== */
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
        // 只报 exceptionDetails.text 的话常常只有一个 "Uncaught"，等于什么都没说 ——
        // 真正的信息在 exception.description 里。
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
            // cdp() 是一次调用挂一个 message 监听、拿到自己要的那条就摘掉；
            // 轮询密集时短暂超过默认的 10 个上限会刷一堆 MaxListeners 警告，
            // 把真正的失败信息淹掉 —— 提一下上限即可。
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
const isSettingsPage = (u) => /settings\.html/.test(u);

/** 等页面的 Tauri IPC 注入完成。
 *
 *  ⚠ 教训：`connectWhere` 是按"页面的 URL 匹配"抓 target 的，而 target 在
 *    脚本跑起来**之前**就已经存在了。抓早了 `invoke` 还是 undefined，
 *    一调用就抛 "Uncaught"，而且看起来像后端出错 —— 其实纯粹是抢跑。
 *    必须先轮询到 `typeof invoke === 'function'` 再往下走。 */
async function waitReady(ws, ms) {
    return waitFor('页面 IPC 就绪', async () => {
        try {
            return (await evalJs(ws,
                "typeof invoke === 'function' && typeof listen === 'function'")) === true;
        } catch (e) { return false; }
    }, ms || 20000);
}

/** 把某个元素滚进可视区再截图。
 *
 *  ⚠ 设置页的滚动发生在**内部滚动容器**（.pane）里，CDP 的
 *    `captureBeyondViewport` 只按外层视口截 —— 不滚的话，位于折叠下方的
 *    云端列表压根不在画面里，两张不同状态的截图会长得一模一样
 *    （轮 20 第一次取证就是这么白拍了一张）。 */
async function shotScrolled(ws, selector, name) {
    try {
        await evalJs(ws, `(function(){var e=document.querySelector(${JSON.stringify(selector)});
            if(e&&e.scrollIntoView) e.scrollIntoView({block:'center'}); return 1;})()`);
        await sleep(450);
    } catch (e) { /* 滚不动就照原样截 */ }
    await shot(ws, name);
}

async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        info('截图 ' + name);
    } catch (e) { info('截图失败 ' + name, e.message); }
}

/* ============================================================================
 *  主流程
 * ========================================================================== */
const PENDING_STOP = [];
const MANUAL_RE = /^config\(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.QuickSearch$/;
const AUTO_RE = /^config\.auto\(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.QuickSearch$/;
const stampName = (i) => 'config(2026-10-12 10-00-' + String(i).padStart(2, '0') + ').QuickSearch';

(async function main() {
    rec('=== 轮 20 专项探针 ===');
    rec('');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r20-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    rec('隔离实例数据目录：' + qs);

    const cfgPath = path.join(qs, 'config.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const readLog = () => { try { return fs.readFileSync(path.join(qs, 'log.txt'), 'utf8'); } catch (e) { return ''; } };
    const localAll = () => fs.readdirSync(qs);
    const localManual = () => localAll().filter((n) => MANUAL_RE.test(n)).sort();
    const localAuto = () => localAll().filter((n) => AUTO_RE.test(n)).sort();
    const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

    const mkItem = (id, t, r) => ({ id, kind: 'text', text: t, html: '', image: '', remark: r });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.trigger_select = false;
        c.trigger_copy = false;
        c.ocr_enable = false;
        c.auto_start = false;
        c.auto_color = false;
        c.fav_hotkey = '';
        c.fav_panel_sizes = {};
        c.backup_dir = '';
        c.backup_password = 'probe-pass-20';     // 加密开着，顺带验证"本地的还加密过"
        c.webdav_url = DAV_BASE;
        c.webdav_user = DAV_USER;
        c.webdav_pass = DAV_PASS;
        c.webdav_on_start = false;
        c.webdav_on_exit = false;
        c.favorites = [
            {
                id: 'pg1', name: '有子目录的', icon: '',
                items: [mkItem('pi1', '内容甲', '备注甲')],
                children: [{
                    id: 'pc1', name: '二级子目录', icon: '',
                    items: [mkItem('pci1', '子目录内容', '备注丙')],
                    children: [],
                }],
            },
            { id: 'pg2', name: '没子目录的', icon: '', items: [mkItem('pi2', '内容乙', '备注乙')], children: [] },
        ];
        c.bar_list = ['百度', '@fav:pg1', '@fav:pg2'];
        c.icon_size = 30;
        c.bar_blur = 0;
        fs.writeFileSync(cfgPath, JSON.stringify(c, null, 1), 'utf8');
    }

    const dav = await startDav();
    rec('仿真 WebDAV 已在 ' + DAV_BASE + ' 监听（内存文件系统，账号 ' + DAV_USER + '）');

    /* ---------- 起隔离实例 ---------- */
    const env = Object.assign({}, process.env, {
        APPDATA: tmp,
        LOCALAPPDATA: tmp,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1',
        QS_INSTANCE_TAG: TAG,
        QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('已启动隔离实例 pid=' + proc.pid + '（独立 APPDATA / WebView2 数据目录，不碰真实环境）');
    const stop = () => { try { proc.kill(); } catch (e) { } try { dav.close(); } catch (e) { } };
    PENDING_STOP.push(stop);

    const barWs = await connectWhere(isBarPage, 30000);
    if (!barWs) { rec('连不上横条页面，放弃'); stop(); flush(); process.exit(1); }
    await cdp(barWs, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });
    rec('已连上横条页面');
    chk('横条页面的 IPC 已就绪', await waitReady(barWs, 25000));

    await evalJs(barWs, "invoke('open_settings', {tab:'backup'}).catch(function(){})");
    const setWs = await connectWhere(isSettingsPage, 25000);
    if (!setWs) { rec('连不上设置页，放弃'); stop(); flush(); process.exit(1); }
    await cdp(setWs, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });
    await cdp(setWs, 'Page.bringToFront').catch(() => { });
    rec('已连上设置页');
    chk('设置页的 IPC 已就绪', await waitReady(setWs, 25000));

    // 二次确认：WebView2 的原生 confirm 会阻塞 CDP，探针里统一打桩成"确定"，
    // 顺便数一数到底弹了几次（确认次数本身也是要证的：删东西必须问一句）。
    let confirms = 0;
    const stubConfirm = `(function(){ window.__qsConfirmN = 0;
        window.confirm = function(){ window.__qsConfirmN++; return true; }; return 1; })()`;
    await evalJs(setWs, stubConfirm);
    await evalJs(barWs, stubConfirm).catch(() => { });
    const confirmCount = () => evalJs(setWs, 'window.__qsConfirmN || 0');

    /* ---------- 先探一下列目录这条链路（后面 ③④ 全靠它） ---------- */
    rec('');
    rec('--- 前置：测试连接（确认列目录链路通）---');
    await evalJs(setWs, "document.getElementById('btnWdTest').click(); 1");
    await waitFor('测试连接结束', async () => {
        const t = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
        return typeof t === 'string' && t.indexOf('正在') < 0;
    }, 25000);
    rec('  INFO  测试连接结果：' + JSON.stringify(
        await evalJs(setWs, "document.getElementById('wdStatus').textContent")));
    rec('  INFO  仿真服务收到的请求：' + JSON.stringify(davHits));

    await sleep(1500);

    /* ======================================================================
     * ① 备份命名统一：本地 == 云端（同名 + 同一份字节 + 加密）
     * ==================================================================== */
    rec('');
    rec('--- ① 一次备份 = 先落本地、再把同一份传到云端（本地与云端同名同内容）---');
    const beforeManual = localManual();
    info('备份前本地的手动备份：' + JSON.stringify(beforeManual));

    await evalJs(setWs, "document.getElementById('btnWdUp').click(); 1");
    // 等到"云端有文件"或者"状态文字报了错"为止 —— 两种情况都要拿到证据，
    // 不能只等成功的那个分支（等不到就只剩一句"超时"，查不下去）。
    const stopped = await waitFor('备份流程结束',
        async () => {
            if (davFiles.size >= 1) return true;
            const t = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
            return typeof t === 'string' && /失败|错|没填|要先/.test(t);
        }, 30000);
    const upStatus = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
    info('备份后状态文字：' + JSON.stringify(upStatus));
    info('仿真服务收到的请求：' + JSON.stringify(davHits));
    info('实例日志末尾：' + JSON.stringify(readLog().split('\n').slice(-8)));
    chk('点「立即备份」后云端出现了一份备份', davFiles.size >= 1 && stopped,
        JSON.stringify([...davFiles.keys()]));

    const cloudNames = [...davFiles.keys()];
    const localNames = localManual();
    info('云端文件：' + JSON.stringify(cloudNames));
    info('本地文件：' + JSON.stringify(localNames));

    const cloudName = cloudNames[0] || '';
    chk('云端文件名是统一口径 config(时间).QuickSearch（不再是 quicksearch-backup.json）',
        MANUAL_RE.test(cloudName), cloudName);
    chk('本地也落了一份，且与云端**同名**',
        !!cloudName && localNames.includes(cloudName), 'local=' + JSON.stringify(localNames));

    if (cloudName && davFiles.has(cloudName) && localNames.includes(cloudName)) {
        const localBuf = fs.readFileSync(path.join(qs, cloudName));
        const cloudBuf = davFiles.get(cloudName).buf;
        chk('本地那份与云端那份**逐字节相同**（同一个文件，不是各生成一份）',
            md5(localBuf) === md5(cloudBuf),
            'local=' + md5(localBuf) + ' cloud=' + md5(cloudBuf));
        const text = localBuf.toString('utf8');
        let isEnc = false;
        try { isEnc = JSON.parse(text).qsEnc === 1; } catch (e) { isEnc = false; }
        chk('本地那份是**加密**过的（设了备份密码）', isEnc, text.slice(0, 40));
        chk('  加密后看不到任何明文配置（没有 bar_list 之类的键）',
            text.indexOf('bar_list') < 0 && text.indexOf('pg1') < 0);
    } else {
        chk('本地那份与云端那份**逐字节相同**（同一个文件，不是各生成一份）', false, '云端还没有文件');
        chk('本地那份是**加密**过的（设了备份密码）', false, '云端还没有文件');
        chk('  加密后看不到任何明文配置（没有 bar_list 之类的键）', false, '云端还没有文件');
    }

    const noFileInput = await evalJs(setWs, "!document.getElementById('w-webdavFile')");
    chk('设置页里「备份文件名」输入框已经删掉（用户：没必要自定义）', !!noFileInput);

    await shotScrolled(setWs, '#btnBkKeep10', '_r20-01-backup-naming.png');

    /* ======================================================================
     * ② 滚动备份不跟手动备份撞名
     * ==================================================================== */
    rec('');
    rec('--- ② 滚动备份改名 config.auto(…)，绝不能顺手删掉手动备份 ---');
    await evalJs(setWs, "invoke('set_setting', {key:'iconSize', value: 33}).catch(function(){})");
    const gotAuto = await waitFor('出现 config.auto(…) 滚动备份', () => localAuto().length >= 1, 15000);
    chk('改一次设置后出现滚动备份 config.auto(时间).QuickSearch', gotAuto,
        JSON.stringify(localAuto()));
    chk('  滚动备份与手动备份**不同名**（同名的话 save_to 会把手动备份删掉）',
        localAuto()[0] !== cloudName, localAuto()[0] + ' vs ' + cloudName);
    chk('  ★ 手动备份**还在**（这条是回归重点：撞名就会被 save 删掉）',
        localManual().includes(cloudName), JSON.stringify(localManual()));

    /* ======================================================================
     * ③ 仅保留最近 10 份（本地 + 云端一起清）
     * ==================================================================== */
    rec('');
    rec('--- ③ 「仅保留最近 10 份」：本地 + 云端都只留最新 10 份 ---');
    // 先清场，再造 12 份（本地 + 云端各 12，时间递增、名字可辨认）
    for (const n of localAll()) if (MANUAL_RE.test(n) || AUTO_RE.test(n)) fs.unlinkSync(path.join(qs, n));
    davFiles.clear();
    davHits = [];
    const N = 12;
    const seeded = [];
    for (let i = 1; i <= N; i++) {
        const name = stampName(i);
        seeded.push(name);
        const when = new Date(Date.UTC(2026, 9, 12, 2, 0, i));   // 秒递增 → mtime 递增
        // 本地
        const p = path.join(qs, name);
        fs.writeFileSync(p, 'seed-' + i, 'utf8');
        fs.utimesSync(p, when, when);
        // 云端
        davFiles.set(name, { buf: Buffer.from('seed-' + i, 'utf8'), mtime: when });
    }
    const newest10 = seeded.slice(-10);
    info('预置本地/云端各 ' + N + ' 份；应当保留的是 ' + JSON.stringify(newest10));

    const c0 = await confirmCount();
    await evalJs(setWs, "document.getElementById('btnBkKeep10').click(); 1");
    const prunedLocal = await waitFor('本地剩 10 份', () => localManual().length === 10, 20000);
    const prunedCloud = await waitFor('云端剩 10 份', () => davFiles.size === 10, 20000);
    chk('本地被清到只剩 10 份', prunedLocal, '剩 ' + localManual().length + '：' + JSON.stringify(localManual()));
    chk('云端被清到只剩 10 份（用户要求本地+云端一起清）', prunedCloud,
        '剩 ' + davFiles.size + '：' + JSON.stringify([...davFiles.keys()]));
    chk('本地留下的正好是**最新 10 份**',
        JSON.stringify(localManual()) === JSON.stringify([...newest10].sort()),
        JSON.stringify(localManual()));
    chk('云端留下的正好是**最新 10 份**',
        JSON.stringify([...davFiles.keys()].sort()) === JSON.stringify([...newest10].sort()),
        JSON.stringify([...davFiles.keys()].sort()));
    const c1 = await confirmCount();
    chk('删除前弹了二次确认', c1 > c0, 'confirm ' + c0 + ' → ' + c1);
    const log1 = readLog();
    chk('后端日志里记了这次清理', /仅保留最近 10 份/.test(log1),
        (log1.split('\n').filter((l) => l.indexOf('仅保留最近') >= 0).slice(-1).join('') || '(无)'));

    await shotScrolled(setWs, '#bkFiles', '_r20-02-after-prune.png');

    /* ======================================================================
     * ④ 云端备份「管理」多选删除
     * ==================================================================== */
    rec('');
    rec('--- ④ 云端备份「管理」：全部变可选 → 勾选 → 删除 ---');
    await evalJs(setWs, "document.getElementById('btnWdDown').click(); 1");
    const listOk = await waitFor('云端列表渲染出 10 条',
        probeEq(setWs, "document.querySelectorAll('#wdItems .wd-item').length", 10), 25000);
    chk('「从云端恢复」列出了全部 10 份', listOk,
        String(await evalJs(setWs, "document.querySelectorAll('#wdItems .wd-item').length")));
    chk('  默认是恢复模式：一条复选框都没有',
        (await evalJs(setWs, "document.querySelectorAll('#wdItems input[type=checkbox]').length")) === 0);
    chk('  管理模式的操作按钮默认收着',
        (await evalJs(setWs, "document.getElementById('wdActsManage').hidden")) === true);

    await evalJs(setWs, "document.getElementById('btnWdManage').click(); 1");
    await sleep(400);
    chk('点「管理」后每条都变成可勾选',
        (await evalJs(setWs, "document.querySelectorAll('#wdItems input[type=checkbox]').length")) === 10);
    chk('  管理模式按钮亮出来、恢复模式按钮收起',
        (await evalJs(setWs, "document.getElementById('wdActsManage').hidden")) === false
        && (await evalJs(setWs, "document.getElementById('wdActsNormal').hidden")) === true);
    chk('  没勾任何一份时「删除选中」是禁用的',
        (await evalJs(setWs, "document.getElementById('btnWdDelete').disabled")) === true);
    await shotScrolled(setWs, '#wdList', '_r20-03-cloud-manage.png');

    // 勾最新那两条
    const victims = [...newest10].sort().slice(-2);
    info('准备删除这两份：' + JSON.stringify(victims));
    await evalJs(setWs, `(function(){
        var rows = Array.from(document.querySelectorAll('#wdItems .wd-item'));
        var want = ${JSON.stringify(victims)};
        rows.forEach(function(r){
            var nm = r.querySelector('.nm').textContent;
            if (want.indexOf(nm) >= 0) {
                var ck = r.querySelector('input[type=checkbox]');
                ck.checked = true;
                ck.dispatchEvent(new Event('change', {bubbles:true}));
            }
        });
        return 1; })()`);
    await sleep(300);
    chk('勾选后按钮解禁并带上数量',
        (await evalJs(setWs, "document.getElementById('btnWdDelete').disabled")) === false
        && String(await evalJs(setWs, "document.getElementById('btnWdDelete').textContent")).indexOf('2') >= 0,
        String(await evalJs(setWs, "document.getElementById('btnWdDelete').textContent")));

    const c2 = await confirmCount();
    await evalJs(setWs, "document.getElementById('btnWdDelete').click(); 1");
    const deleted = await waitFor('云端剩 8 份', () => davFiles.size === 8, 25000);
    chk('删除后云端剩 8 份', deleted, '剩 ' + davFiles.size + '：' + JSON.stringify([...davFiles.keys()]));
    chk('  删掉的正是勾中的那两份',
        victims.every((v) => !davFiles.has(v)) && davFiles.size === 8,
        'victims=' + JSON.stringify(victims));
    const c3 = await confirmCount();
    chk('  删除前弹了二次确认', c3 > c2, 'confirm ' + c2 + ' → ' + c3);

    const listRefreshed = await waitFor('列表自动刷新成 8 条',
        probeEq(setWs, "document.querySelectorAll('#wdItems .wd-item, #wdItems .wd-item.sel').length", 8),
        20000);
    chk('删完列表自动刷新（不用用户手动点"重新拉取"）', listRefreshed,
        String(await evalJs(setWs, "document.querySelectorAll('#wdItems .wd-item, #wdItems .wd-item.sel').length")));

    // 退出管理模式
    await evalJs(setWs, "document.getElementById('btnWdManageDone').click(); 1");
    await sleep(300);
    chk('点「完成」退回恢复模式',
        (await evalJs(setWs, "document.querySelectorAll('#wdItems input[type=checkbox]').length")) === 0);

    /* ======================================================================
     * ⑤ 磨砂强度
     *
     * ⚠ 2026-10-16 r55 修（两处，都是探针口径问题，产品无缺陷）：
     *   ① 这里原来**没设样式**，横条跑在默认样式上 —— 而这份隔离配置里
     *      barGlass 默认是开着的，于是横条在**液态玻璃**模式，玻璃模式下
     *      `.stage.qs-glass[data-blur] > .bar` 那条规则**故意**把
     *      backdrop-filter 关成 none（玻璃由 WebGL 画布出，CSS 那层在透明
     *      悬浮窗里取样的是空的，纯浪费一层合成）。「横条真的吃到了
     *      backdrop-filter」因此一直红。
     *   ② 第一版修法写的是 `set_setting {key:'barStyle'}` —— 但**样式根本不
     *      是配置键**，是 barGlass / barBlur 推导出来的（见 settings.js 的
     *      qsBarStyle），而 config.rs 的 apply_one_setting 是白名单，
     *      那个键直接静默丢弃。正确写法：frost = barGlass 关 + barBlur > 0。
     * ==================================================================== */
    rec('');
    rec('--- ⑤ 磨砂强度：换算曲线 / 真吃 backdrop-filter / 预览能看出效果 ---');
    // 切到「磨砂」：barGlass 关掉、barBlur 给个正值（0 会被推导成 default）
    await evalJs(setWs, `invoke('set_setting', {key:'barGlass', value: false}).catch(function(){})`);
    const setBlur = (v) => evalJs(setWs,
        `invoke('set_setting', {key:'barBlur', value: ${v}}).catch(function(){})`);
    await setBlur(18);
    // ⚠ 判据是 stage 上**有没有 qs-glass 类**（glass.js 挂的），不是 dataset.style；
    //   probeEq 比的是 `=== 字符串`，classList.contains() 返回布尔，得 String()。
    const glassCls = () => `String(document.getElementById('stage').classList.contains('qs-glass'))`;
    const frostOn = await waitFor('横条退出玻璃模式（= 磨砂样式）',
        probeEq(barWs, glassCls(), 'false'), 15000);
    chk('先切成「磨砂」样式（磨砂链路只在该样式下有意义）', frostOn,
        String(await evalJs(barWs, "document.getElementById('stage').className")));
    const blurApplied = await waitFor('横条 data-blur=18',
        probeEq(barWs, "document.getElementById('stage').dataset.blur", '18'), 12000);
    chk('磨砂滑块 = 18 时横条 data-blur=18（记的是滑块原始值）', blurApplied,
        String(await evalJs(barWs, "document.getElementById('stage').dataset.blur")));

    const blurPx = await evalJs(barWs, "document.getElementById('stage').style.getPropertyValue('--qs-blur')");
    chk('--qs-blur 走 qsBlurPx 曲线（18 → 14.2px，不再 1:1）', blurPx === '14.2px', blurPx);

    const bf = await evalJs(barWs,
        "getComputedStyle(document.querySelector('.bar')).backdropFilter"
        + "|| getComputedStyle(document.querySelector('.bar')).webkitBackdropFilter");
    chk('横条上真的吃到了 backdrop-filter（blur + saturate + brightness）',
        /blur\(14\.2px\)/.test(bf) && /saturate/.test(bf) && /brightness/.test(bf), bf);

    const wc = await evalJs(barWs,
        "getComputedStyle(document.querySelector('.bar')).willChange");
    chk('开了 will-change: backdrop-filter（提前备好合成层，少一次重建顿挫）',
        /backdrop-filter/.test(wc), wc);

    // 预览：舞台必须有纹理底，否则糊完还是纯色、看不出任何变化
    await evalJs(setWs, "document.querySelector('#tabs button[data-tab=\"general\"]').click(); 1");
    await sleep(600);
    const stageBg = await evalJs(setWs,
        "getComputedStyle(document.getElementById('previewStageA')).backgroundImage");
    chk('预览舞台铺了纹理底（纯色底的话磨砂永远看不出效果）',
        !!stageBg && stageBg !== 'none' && /gradient/.test(stageBg), String(stageBg).slice(0, 90));
    const pvBf = await evalJs(setWs,
        "getComputedStyle(document.getElementById('qsPreviewA')).backdropFilter"
        + "|| getComputedStyle(document.getElementById('qsPreviewA')).webkitBackdropFilter");
    chk('  预览里的横条也吃到了同一套 backdrop-filter',
        /blur\(14\.2px\)/.test(pvBf), pvBf);
    const pvLabel = await evalJs(setWs, "document.getElementById('s-barBlurVal').textContent");
    chk('  滑块标签显示的是**实际模糊半径**（14.2 px）', pvLabel === '14.2 px', pvLabel);
    await shotScrolled(setWs, '#previewStageA', '_r20-04-blur-preview.png');

    /* ---- 反向断言：玻璃模式下横条**不许**有 CSS 磨砂 ----
     * 玻璃由 WebGL 画布出，CSS 那层留着是白烧一层合成（取样的是空的）。
     * 这条是防"谁把磨砂规则的选择器写重了又把玻璃盖掉"的回归。
     * ⚠ 进玻璃是 barGlass=true（不是 barStyle='glass'，那根本不是配置键）。 */
    await evalJs(setWs, `invoke('set_setting', {key:'barGlass', value: true}).catch(function(){})`);
    const glassOn = await waitFor('横条进入玻璃模式',
        probeEq(barWs, glassCls(), 'true'), 15000);
    chk('切成「液态玻璃」样式', glassOn,
        String(await evalJs(barWs, "document.getElementById('stage').className")));
    const bfGlass = await evalJs(barWs,
        "getComputedStyle(document.querySelector('.bar')).backdropFilter"
        + "|| getComputedStyle(document.querySelector('.bar')).webkitBackdropFilter");
    chk('玻璃模式下横条没有 CSS 磨砂（那层由 WebGL 画布出，留着纯浪费）',
        bfGlass === 'none' || bfGlass === '', bfGlass);
    // 切回磨砂，免得后面几段跑在玻璃模式下
    await evalJs(setWs, `invoke('set_setting', {key:'barGlass', value: false}).catch(function(){})`);
    const frostBack = await waitFor('切回磨砂样式',
        probeEq(barWs, glassCls(), 'false'), 15000);
    chk('切回「磨砂」样式（后面几段要跑在磨砂下）', frostBack,
        String(await evalJs(barWs, "document.getElementById('stage').className")));
    await sleep(400);

    await setBlur(0);
    const blurOff = await waitFor('磨砂关掉后 data-blur=0',
        probeEq(barWs, "document.getElementById('stage').dataset.blur", '0'), 12000);
    const bfOff = await evalJs(barWs,
        "getComputedStyle(document.querySelector('.bar')).backdropFilter"
        + "|| getComputedStyle(document.querySelector('.bar')).webkitBackdropFilter");
    chk('关掉磨砂后横条不再开 backdrop-filter（不白占 GPU 层）',
        blurOff && (bfOff === 'none' || bfOff === ''), 'data-blur=' + blurOff + ' bf=' + bfOff);

    /* ======================================================================
     * ⑥ 横条收藏面板：展开/折叠按钮只在含二级目录时出现
     * ==================================================================== */
    rec('');
    rec('--- ⑥ 横条收藏面板：全部展开/折叠只在目录含二级目录时出现 ---');
    const clickFav = (s) => evalJs(barWs,
        `(function(){ var b=document.querySelector('[data-fav="${s}"]'); if(!b) return 0; b.click(); return 1; })()`);
    const hasTools = () => evalJs(barWs,
        "!!document.querySelector('#panel .fav-head-tools')");

    chk('横条上有两个收藏夹格子', (await clickFav('@fav:pg2')) === 1);
    // 点开面板是异步的（renderPanel + pushLayout），轮询到内容出现再断言 ——
    // 别写"点完 sleep 固定秒数再读"。
    await waitFor('面板列出「没子目录的」内容',
        probeEq(barWs, "document.getElementById('panel').textContent.indexOf('内容乙') >= 0", true), 8000);
    chk('没有二级目录的收藏夹：**不出现**这两颗按钮', (await hasTools()) === false);
    chk('  但目录内容照样列出来了',
        !!(await evalJs(barWs, "document.getElementById('panel').textContent.indexOf('内容乙') >= 0")));
    await shot(barWs, '_r20-05-fav-no-sub.png');

    await clickFav('@fav:pg1');
    await waitFor('面板列出「有子目录的」内容',
        probeEq(barWs, "document.getElementById('panel').textContent.indexOf('内容甲') >= 0", true), 8000);
    chk('含二级目录的收藏夹：出现「全部展开 / 全部折叠」', (await hasTools()) === true);
    const toolTexts = await evalJs(barWs,
        "Array.from(document.querySelectorAll('#panel .fav-head-tools .fav-tool')).map(function(b){return b.textContent}).join('|')");
    chk('  正好两颗，文案是「全部展开|全部折叠」', toolTexts === '全部展开|全部折叠', toolTexts);
    await shot(barWs, '_r20-06-fav-with-sub.png');

    /* ---------------- 收尾 ---------------- */
    rec('');
    rec('--- 仿真 WebDAV 收到的请求流水（核对功能确实走的是真网络路径） ---');
    for (const h of davHits) rec('    ' + h);
    rec('--- 隔离实例日志（末尾 12 行）---');
    for (const l of readLog().split('\n').slice(-12)) if (l.trim()) rec('    ' + l);

    rec('');
    rec('============================================================');
    rec('  通过 ' + passN + ' 项，失败 ' + failN + ' 项');
    rec('============================================================');
    stop();
    flush();
    process.exit(failN === 0 ? 0 : 1);
})().catch((e) => {
    rec('探针自己抛异常了：' + (e && e.stack || e));
    rec('（已顺手收掉隔离实例与仿真服务，避免残留进程占着 CDP 端口）');
    try { PENDING_STOP.forEach((f) => f()); } catch (err) { }
    flush();
    process.exit(1);
});
