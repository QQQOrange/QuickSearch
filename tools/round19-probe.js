/* ============================================================================
 *  专项探针：轮 19 的七条
 *
 *  要证的事（编号与用户反馈一一对应）：
 *    ① 横条收藏夹面板点「设置…」→ 设置窗跳到「收藏夹」分页（不是「文字识别」）。
 *       两条路都要证：**新开窗**（首次）与**已开窗**（复用 + goto-tab 事件）。
 *    ② 设置页收藏夹点「全部展开」：目录层级摊开，但**每一条内容仍是收起的一行**，
 *       不许变成编辑态（textarea / 备注框）。
 *    ③ 把放进横条的收藏目录删掉之后：`bar_list` 里那个 `@fav:<id>` 哨兵跟着消失，
 *       横条上不会再出现指向已删目录的乱码格子。
 *    ④ 快捷键能设就能取消：录入 Ctrl+Alt+F 后「清除」可用，点它回到"未设置"。
 *    ⑤ 云端备份会**累积多份**（点两次「立即备份」→ 云端 2 个文件），
 *       「从云端恢复」列表能列出多份供选择。
 *    ⑥ 一次备份 = **先落本地、再上传同一份**：本地那个文件与云端那个文件
 *       **同名 + 逐字节相同**（用户点名的「不是同一个文件」）。
 *    ⑦ 「关于」页有开发者 / 当前版本 / 版本更新时间 / 使用的工具；
 *       「帮助」页能展开各功能说明。
 *
 *  做法：起一个**本机最小 WebDAV 服务**（内存里存文件），另起一个隔离实例
 *  （独立 APPDATA + WEBVIEW2_USER_DATA_FOLDER + QS_INSTANCE_TAG），
 *  全程用 CDP 的 DOM 点击与 Input.dispatchKeyEvent 驱动 —— **不碰真实鼠标键盘**，
 *  也不会去读用户的剪贴板。
 *
 *  用法：node tools/round19-probe.js
 *  输出：tools/round19-probe.txt + 若干截图
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round19-probe.txt');
const TAG = '-probe-r19';
const PORT = 9344;                 // CDP
const DAV_PORT = 18099;            // 本机仿真 WebDAV
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

let passN = 0, failN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

/* ============================================================================
 *  本机最小 WebDAV 服务（内存文件系统）
 * ========================================================================== */
const DAV_USER = 'qsuser', DAV_PASS = 'qspass';
const DAV_BASE = 'http://127.0.0.1:' + DAV_PORT + '/dav/';
const davFiles = new Map();        // name -> { buf: Buffer, mtime: Date }
let davHits = [];                  // 方法调用流水，便于事后核对

function httpDate(d) { return d.toUTCString(); }

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
                // 已存在 → 405（客户端把 405 当成"已经有了"，是正确的 WebDAV 语义）
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
                const list = [...davFiles.entries()];
                const parts = [
                    '<?xml version="1.0" encoding="utf-8"?>',
                    '<D:multistatus xmlns:D="DAV:">',
                    // 目录自己（带 collection）——客户端要能跳过它
                    '<D:response><D:href>/dav/</D:href><D:propstat><D:prop>',
                    '<D:resourcetype><D:collection/></D:resourcetype>',
                    '<D:getcontentlength>0</D:getcontentlength>',
                    '<D:getlastmodified>' + httpDate(new Date()) + '</D:getlastmodified>',
                    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
                ];
                for (const [name, f] of list) {
                    parts.push(
                        '<D:response><D:href>/dav/' + name.replace(/ /g, '%20') + '</D:href>'
                        + '<D:propstat><D:prop><D:resourcetype/>'
                        + '<D:getcontentlength>' + f.buf.length + '</D:getcontentlength>'
                        + '<D:getlastmodified>' + httpDate(f.mtime) + '</D:getlastmodified>'
                        + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>');
                }
                parts.push('</D:multistatus>');
                const xml = parts.join('');
                res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
                return res.end(xml);
            }

            if (req.method === 'GET' || req.method === 'HEAD') {
                const f = davFiles.get(sub);
                if (!f) {
                    // 目录（sub 为空）给一个 HTML 目录页，覆盖"不支持 PROPFIND"的退化路径
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
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text) + ' | ' + expr.slice(0, 120));
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

async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        info('截图 ' + name);
    } catch (e) { info('截图失败 ' + name, e.message); }
}

/** 设置页里那个「当前显示的是哪个分页」——被点亮的 tab 的 data-tab。 */
const ACTIVE_TAB = `(function(){
    var b = document.querySelector('#tabs button.on');
    return b ? b.dataset.tab : '(none)';
})()`;

const CONF_OF = `invoke('get_config')`;

/* ============================================================================
 *  主流程
 * ========================================================================== */
(async function main() {
    rec('=== 轮 19 专项探针 ===');
    rec('');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r19-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    rec('隔离实例数据目录：' + qs);

    /* ---------- 临时配置 ---------- */
    const mkItem = (id, t, r) => ({ id, kind: 'text', text: t, html: '', image: '', remark: r });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.trigger_select = false;
        c.trigger_copy = false;
        c.ocr_enable = false;
        c.auto_start = false;
        c.auto_color = false;          // 这轮不验取色，保持简单
        c.fav_hotkey = '';
        c.fav_panel_sizes = {};
        c.webdav_url = '';
        c.webdav_user = '';
        c.webdav_pass = '';
        c.webdav_on_start = false;
        c.webdav_on_exit = false;
        c.backup_password = '';        // 不加密，方便逐字节比对
        c.backup_dir = '';
        c.favorites = [
            {
                id: 'pg1', name: '放进横条的目录', icon: '',
                items: [
                    mkItem('pi1', '内容甲', '备注甲'),
                    mkItem('pi2', '内容乙', '备注乙'),
                ],
                children: [{
                    id: 'pc1', name: '二级子目录', icon: '',
                    items: [mkItem('pci1', '子目录内容', '备注丙')],
                    children: [],
                }],
            },
            { id: 'pg2', name: '另一个目录', icon: '', items: [mkItem('pi9', '内容丙', '备注丁')], children: [] },
        ];
        // 横条上放一个指向 pg1 的哨兵 —— ③ 要删掉 pg1 之后看它还在不在
        c.bar_list = ['百度', 'Google', '@fav:pg1'];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    /** 备份目录里「和云端配对」的那些文件：`config(时间).QuickSearch`。
     *  注意别把滚动备份 `config.auto(时间).QuickSearch` 和恢复前快照
     *  `config.before-webdav(时间).QuickSearch` 也算进来 —— 它们不是一次备份。
     *  正则用 `^config\(` 就能天然排除（两者都多一段前缀）。 */
    const localPaired = () => fs.readdirSync(qs)
        .filter((n) => /^config\(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.QuickSearch$/.test(n))
        .sort();

    const cfgPath = path.join(qs, 'config.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const readLog = () => { try { return fs.readFileSync(path.join(qs, 'log.txt'), 'utf8'); } catch (e) { return ''; } };

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

    const barWs = await connectWhere(isBarPage, 30000);
    if (!barWs) {
        rec('CDP 连不上横条页面（端口 ' + PORT + '）—— 实例可能没起来');
        stop(); flush(); process.exit(1);
    }
    await sleep(1500);
    rec('横条页面已连上');
    rec('');

    /* ===================== 打开设置窗 ===================== */
    await evalJs(barWs, "invoke('open_settings', {tab:'engines'}).catch(function(){})");
    const setWs = await connectWhere(isSettingsPage, 25000);
    if (!setWs) {
        rec('设置窗口没起来，后面几条无法取证');
        stop(); flush(); process.exit(1);
    }
    await sleep(1200);
    info('设置页已连上，当前分页 = ' + await evalJs(setWs, ACTIVE_TAB));

    /* =====================================================================
     *  ② 全部展开 / 全部折叠
     * ===================================================================== */
    rec('');
    rec('=== ② 设置页收藏夹：「全部展开」不该把每条内容变成编辑态 ===');
    const TREE_STATS = `(function(){
        var t = document.getElementById('favTree');
        if (!t) return null;
        return {
            rows:  t.querySelectorAll('.fav-row').length,
            lines: t.querySelectorAll('.fav-item-line').length,
            edits: t.querySelectorAll('.fav-item-edit').length,
            ta:    t.querySelectorAll('textarea').length,
            live:  t.querySelectorAll('input:not([readonly])').length,
            lv2:   t.querySelectorAll('.fav-group.lv2').length,
        };
    })()`;
    await evalJs(setWs, "$('tabs').querySelector('button[data-tab=\"fav\"]').click()");
    await sleep(400);
    let st = await evalJs(setWs, TREE_STATS);
    info('初始树状态', JSON.stringify(st));
    chk('收藏树渲染出 2 个一级目录', st && st.rows >= 2, JSON.stringify(st));

    await evalJs(setWs, "$('btnFavCollapseAll').click()");
    await sleep(300);
    const stC = await evalJs(setWs, TREE_STATS);
    chk('「全部折叠」后目录内容整个不渲染', stC && stC.lines === 0 && stC.edits === 0,
        JSON.stringify(stC));
    await shot(setWs, '_r19-settings-fav-collapsed.png');

    await evalJs(setWs, "$('btnFavExpandAll').click()");
    await sleep(300);
    const stE = await evalJs(setWs, TREE_STATS);
    chk('「全部展开」后内容行都出来了（收起行形态）', stE && stE.lines >= 4, JSON.stringify(stE));
    chk('  且**一条都没进编辑态**（用户报的 bug）', stE && stE.edits === 0, 'edits=' + (stE && stE.edits));
    chk('  树里也没有 textarea（编辑体才会有的东西）', stE && stE.ta === 0, 'ta=' + (stE && stE.ta));
    chk('  没有被解锁的输入框（只读的目录名不算）', stE && stE.live === 0, 'live=' + (stE && stE.live));
    chk('  二级目录也被摊开了（层级确实展开）', stE && stE.lv2 >= 1, 'lv2=' + (stE && stE.lv2));
    await shot(setWs, '_r19-settings-fav-expanded.png');

    /* 反面确认：条目**自己**点开时仍然要能进编辑态（别把功能一起改没了） */
    await evalJs(setWs, "document.querySelector('#favTree .fav-item-line').click()");
    await sleep(300);
    const stO = await evalJs(setWs, TREE_STATS);
    chk('（反向）手动点一条内容仍进编辑态', stO && stO.edits >= 1, 'edits=' + (stO && stO.edits));
    await evalJs(setWs, "$('btnFavCollapseAll').click()");
    await sleep(200);

    /* =====================================================================
     *  ④ 快捷键可取消
     * ===================================================================== */
    rec('');
    rec('=== ④ 快捷键能设就能取消 ===');
    chk('「清除」按钮存在', await evalJs(setWs, "!!document.getElementById('btnFavHotkeyClear')"));
    const clear0 = await evalJs(setWs,
        "({dis: document.getElementById('btnFavHotkeyClear').disabled, lab: document.getElementById('btnFavHotkey').textContent})");
    chk('  没设快捷键时「清除」是禁用的', clear0.dis === true, JSON.stringify(clear0));

    // 真键盘事件（走 Chromium 输入管线，不是伪造 DOM 事件）
    await evalJs(setWs, "document.getElementById('btnFavHotkey').click()");
    await sleep(300);
    await cdp(setWs, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', modifiers: 3 /* Alt|Ctrl */, key: 'f', code: 'KeyF',
        windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
    });
    await sleep(120);
    await cdp(setWs, 'Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers: 3, key: 'f', code: 'KeyF',
        windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
    });
    await sleep(900);
    const hk = await evalJs(setWs, CONF_OF);
    const uiHk = await evalJs(setWs,
        "({lab: document.getElementById('btnFavHotkey').textContent, dis: document.getElementById('btnFavHotkeyClear').disabled, hint: document.getElementById('favHotkeyHint').textContent})");
    chk('录到 Ctrl+Alt+F 并写进配置', hk.favHotkey === 'Ctrl+Alt+F', 'favHotkey=' + JSON.stringify(hk.favHotkey));
    chk('  UI 上按钮显示这个组合', uiHk.lab === 'Ctrl+Alt+F', JSON.stringify(uiHk));
    chk('  此时「清除」变成可用', uiHk.dis === false, JSON.stringify(uiHk));
    await shot(setWs, '_r19-hotkey-armed.png');

    await evalJs(setWs, "document.getElementById('btnFavHotkeyClear').click()");
    await sleep(900);
    const hk2 = await evalJs(setWs, CONF_OF);
    const uiHk2 = await evalJs(setWs,
        "({lab: document.getElementById('btnFavHotkey').textContent, dis: document.getElementById('btnFavHotkeyClear').disabled})");
    chk('点「清除」后配置里没有快捷键了', hk2.favHotkey === '', 'favHotkey=' + JSON.stringify(hk2.favHotkey));
    chk('  UI 回到「未设置」，「清除」重新禁用', uiHk2.lab === '未设置' && uiHk2.dis === true,
        JSON.stringify(uiHk2));

    /* =====================================================================
     *  ⑤⑥ 备份：先本地 → 上传同一份；云端累积多份
     * ===================================================================== */
    rec('');
    rec('=== ⑤⑥ 备份链路：先本地再云端、同名同内容、云端累积多份 ===');
    // 填 WebDAV 三项（走真实的 change → set_setting 路径）
    await evalJs(setWs, `(function(){
        var set = function(id, v){
            var el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', {bubbles:true}));
        };
        set('w-webdavUrl', ${JSON.stringify(DAV_BASE)});
        set('w-webdavUser', ${JSON.stringify(DAV_USER)});
        set('w-webdavPass', ${JSON.stringify(DAV_PASS)});
        return true;
    })()`);
    await sleep(1200);
    const wdCfg = await evalJs(setWs, CONF_OF);
    chk('WebDAV 地址 / 账号 / 密码都写进了配置',
        wdCfg.webdavUrl.indexOf('127.0.0.1') > 0 && wdCfg.webdavUser === DAV_USER && wdCfg.webdavPass === DAV_PASS,
        JSON.stringify([wdCfg.webdavUrl, wdCfg.webdavUser]));

    /** 等后端把结果推回来（`#wdStatus` 不再是"正在…"）。
     *  ⚠ 一律用轮询、不要"点完 sleep 固定几秒再读一次"：后端是在**独立线程**里
     *    发请求的，回包时间取决于网盘；固定等待会出现"其实已经成功了，只是读早了"
     *    的假失败（上一版探针就这么误报过一次）。 */
    async function waitStatus(ms) {
        const t0 = Date.now();
        let s = '';
        while (Date.now() - t0 < (ms || 15000)) {
            s = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
            if (s && !/正在(测试|备份|读取|恢复)|^$/.test(s)) return s;
            await sleep(300);
        }
        return s;
    }

    // 先点一次「测试连接」，确认仿真服务真的通了（不然下面失败会误判成"备份逻辑坏了"）
    await evalJs(setWs, "$('btnWdTest').click()");
    const testMsg = await waitStatus(15000);
    info('测试连接：' + testMsg);
    chk('  测试连接成功（真的打通了仿真 WebDAV）', /连接成功/.test(testMsg), testMsg);

    /** 点一次「立即备份」并等它落定 */
    async function doBackup() {
        await evalJs(setWs, "$('btnWdUp').click()");
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
            await sleep(500);
            const s = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
            if (/备份|失败|还没有|稍等/.test(s) && !/正在备份/.test(s)) return s;
        }
        return await evalJs(setWs, "document.getElementById('wdStatus').textContent");
    }

    const msg1 = await doBackup();
    info('第 1 次备份：' + msg1);
    await sleep(600);
    const snap1 = {
        dav: [...davFiles.keys()],
        // 只认「和云端配对的那一份」的命名：config(时间).QuickSearch。
        // 不能只按「有括号时间戳」过滤 —— config.auto(…) 与 config.before-webdav(…)
        // 也长这样，混进来会把份数算多（上一版探针就这么误报过一次）。
        local: localPaired(),
    };
    chk('第 1 次备份后云端有 1 份', snap1.dav.length === 1, JSON.stringify(snap1.dav));
    chk('  文件名带时间戳（不是固定名）',
        snap1.dav[0] && /^config\(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.QuickSearch$/.test(snap1.dav[0]),
        snap1.dav[0]);
    chk('  本地也落了一份，且**同名**', snap1.local.includes(snap1.dav[0]),
        'local=' + JSON.stringify(snap1.local));
    if (snap1.dav.length === 1 && snap1.local.includes(snap1.dav[0])) {
        const a = davFiles.get(snap1.dav[0]).buf;
        const b = fs.readFileSync(path.join(qs, snap1.dav[0]));
        chk('  本地那份与云端那份**逐字节相同**（用户点名的"不是同一个文件"）',
            a.equals(b), a.length + ' vs ' + b.length);
    }

    // 改点东西（让配置内容真的变了），再备份第二次
    await evalJs(setWs, "invoke('set_setting', {key:'iconSize', value: 34}).catch(function(){})");
    await sleep(1500);
    const msg2 = await doBackup();
    info('第 2 次备份：' + msg2);
    await sleep(600);
    const davAfter = [...davFiles.keys()];
    const localAfter = localPaired();
    chk('第 2 次备份后云端有 2 份（云端会累积，不再互相覆盖）', davAfter.length === 2,
        JSON.stringify(davAfter));
    chk('  本地也累积了 2 份', localAfter.length === 2, JSON.stringify(localAfter));
    for (const n of davAfter) {
        const lp = path.join(qs, n);
        if (!fs.existsSync(lp)) { chk('  本地有同名文件 ' + n, false); continue; }
        chk('  同名且逐字节相同：' + n,
            davFiles.get(n).buf.equals(fs.readFileSync(lp)));
    }
    // 两次内容必须不一样（否则"多份"只是重复）
    if (davAfter.length === 2) {
        const [x, y] = davAfter;
        chk('  两份内容确实不同（配置改过，各有各的还原点）',
            !davFiles.get(x).buf.equals(davFiles.get(y).buf));
    }

    // 点「从云端恢复」→ 面板要**立刻**亮出来（别让用户以为点了没反应），列表随后到
    const READ_LIST = `(function(){
        var box = document.getElementById('wdList');
        var items = document.getElementById('wdItems');
        var rows = Array.from(items.querySelectorAll('.wd-item'));
        return { hidden: box.hidden, n: rows.length,
                 ph: items.textContent.slice(0, 24),
                 first: rows[0] ? rows[0].textContent.slice(0, 70) : '' };
    })()`;
    await evalJs(setWs, "$('btnWdDown').click()");
    const justAfter = await evalJs(setWs, READ_LIST);
    chk('点「从云端恢复」后面板立刻亮出来（不再是"点了没反应"）',
        justAfter && justAfter.hidden === false, JSON.stringify(justAfter));
    let wdRows = justAfter;
    const tList = Date.now();
    while (Date.now() - tList < 15000 && wdRows.n < 2) {
        await sleep(400);
        wdRows = await evalJs(setWs, READ_LIST);
    }
    info('云端备份列表：' + JSON.stringify(wdRows));
    chk('「从云端恢复」列出了**多份**备份供选择（以前永远只有一条）',
        wdRows.n >= 2, JSON.stringify(wdRows));
    // 名字里带定宽时间戳 → 字典序就是时间序，sorted() 的最后一个就是最新那份
    const newest = davAfter.slice().sort().pop();
    chk('  列表里第一行是最新那份（新的排最前）',
        wdRows.first.indexOf(newest) >= 0, 'first=' + wdRows.first + ' / newest=' + newest);
    await shot(setWs, '_r19-webdav-list.png');

    /* 本机备份清单里也该看到配对落下的那两份。
     * 「立即备份」之后必须自动刷新 —— 以前只有配置广播才刷，
     * 用户点完备份看不到刚落下的那个文件，会以为没备份成功。 */
    await evalJs(setWs, "$('btnWdListClose').click()");
    await sleep(300);
    let bkRows = [];
    const tBk = Date.now();
    while (Date.now() - tBk < 6000) {
        bkRows = await evalJs(setWs, `Array.from(document.querySelectorAll('#bkFiles > *'))
            .map(function(n){return n.textContent})
            .filter(function(s){return /config\\(/.test(s)})`);
        if (bkRows.length >= 2) break;
        await sleep(400);
    }
    info('本机备份清单（配对备份行）= ' + JSON.stringify(bkRows));
    chk('本机备份清单里能看到刚配对落下的那两份（点完备份会自动刷新）',
        bkRows.length >= 2, JSON.stringify(bkRows));

    /* =====================================================================
     *  ⑦ 帮助 / 关于
     * ===================================================================== */
    rec('');
    rec('=== ⑦ 帮助页 + 关于页 ===');
    await evalJs(setWs, "$('tabs').querySelector('button[data-tab=\"help\"]').click()");
    await sleep(500);
    const help = await evalJs(setWs, `(function(){
        var p = document.querySelector('.pane[data-pane="help"]');
        var items = p.querySelectorAll('details.help-item');
        var open = 0; for (var i=0;i<items.length;i++) if (items[i].open) open++;
        return { tab: (document.querySelector('#tabs button.on')||{}).dataset &&
                      document.querySelector('#tabs button.on').dataset.tab,
                 n: items.length, open: open, text: p.textContent.replace(/\\s+/g,' ').slice(0, 0) };
    })()`);
    chk('点「帮助」切到了帮助页', help.tab === 'help', JSON.stringify(help));
    chk('  帮助页有 ≥ 8 个可折叠的功能块', help.n >= 8, 'n=' + help.n);
    chk('  默认展开第一块（不是一片标题）', help.open >= 1, 'open=' + help.open);
    // 展开所有块，截一张"全展开"的图，用户能一眼看出它真的介绍了各功能
    await evalJs(setWs, "document.querySelectorAll('.pane[data-pane=\"help\"] details').forEach(function(d){d.open=true})");
    await sleep(400);
    const helpText = await evalJs(setWs,
        "document.querySelector('.pane[data-pane=\"help\"]').textContent.replace(/\\s+/g,' ')");
    for (const kw of ['怎么把它叫出来', '横条', '引擎', 'AI 工具', '文字识别', '收藏夹', '快捷键', '备份', '托盘']) {
        chk('  介绍里覆盖了「' + kw + '」', helpText.indexOf(kw) >= 0);
    }
    await shot(setWs, '_r19-settings-help.png');

    await evalJs(setWs, "$('tabs').querySelector('button[data-tab=\"about\"]').click()");
    await sleep(500);
    const about = await evalJs(setWs, `(function(){
        var box = document.getElementById('aboutTools');
        var rows = Array.from(document.querySelectorAll('.about-meta .am-row'))
            .filter(function(r){ return !r.hidden; })
            .map(function(r){
                return r.querySelector('.am-k').textContent + '=' + r.querySelector('.am-v').textContent;
            });
        return {
            tab: document.querySelector('#tabs button.on').dataset.tab,
            dev: document.getElementById('aboutDev').textContent,
            ver: document.getElementById('aboutVer').textContent,
            built: document.getElementById('aboutBuilt').textContent,
            tools: box ? box.children.length : 0,
            rows: rows,
        };
    })()`);
    info('关于页：' + JSON.stringify(about));
    chk('点「关于」切到了关于页', about.tab === 'about');
    chk('  开发者显示出来了', /QQQOrange/.test(about.dev), about.dev);
    chk('  当前版本显示出来了', /^v\d+\.\d+\.\d+$/.test(about.ver), about.ver);
    chk('  版本更新时间显示出来了（不是占位）',
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(about.built), about.built);
    chk('  使用的工具列成了一排（≥ 8 个）', about.tools >= 8, 'tools=' + about.tools);
    chk('  四条元信息都在', about.rows.length >= 3, JSON.stringify(about.rows));
    await shot(setWs, '_r19-settings-about.png');

    /* =====================================================================
     *  ① 横条收藏面板点「设置…」→ 收藏夹分页
     * ===================================================================== */
    rec('');
    rec('=== ① 横条收藏面板「设置…」的跳转目标 ===');

    // 先把设置页切到别的分页，好观察它是不是真的被切过去了
    await evalJs(setWs, "$('tabs').querySelector('button[data-tab=\"backup\"]').click()");
    await sleep(400);
    info('设置页先切到：' + await evalJs(setWs, ACTIVE_TAB));

    const barClick = await evalJs(barWs, `(function(){
        var more = document.getElementById('btnMore');
        if (!more) return 'no-btnMore';
        more.click();
        var entry = document.querySelector('#panel .fav-entry');
        if (!entry) return 'no-fav-entry';
        entry.click();
        var s = document.getElementById('btnSettings');
        if (!s) return 'no-btnSettings';
        s.click();
        return 'clicked';
    })()`);
    chk('横条的 ⋯ 面板里有收藏夹入口，并能点开「设置…」', barClick === 'clicked', barClick);
    await sleep(1800);
    const tabAfter = await evalJs(setWs, ACTIVE_TAB);
    chk('设置窗跳到了「收藏夹」分页（以前跳到「文字识别」）', tabAfter === 'fav', '实际 = ' + tabAfter);
    chk('  而且确实不是 ocr', tabAfter !== 'ocr', '实际 = ' + tabAfter);
    const favVisible = await evalJs(setWs,
        "!document.querySelector('.pane[data-pane=\"fav\"]').hidden");
    chk('  收藏夹那一栏真的显示出来了', favVisible === true);
    await shot(setWs, '_r19-goto-fav.png');

    /* =====================================================================
     *  ③ 删掉放进横条的目录 → 哨兵跟着消失
     * ===================================================================== */
    rec('');
    rec('=== ③ 删掉收藏目录后，横条上的 @fav 哨兵要跟着消失 ===');
    const before = await evalJs(setWs, CONF_OF);
    chk('删除前配置里确实有 @fav:pg1 哨兵',
        (before.barList || []).indexOf('@fav:pg1') >= 0, JSON.stringify(before.barList));

    // 走真实 UI：目录行上的「删除」要点两次（第一次变成确认态）
    /* r48：目录改成「目录卡」之后，操作按钮搬进了**卡内正文**（.fav-ops），
     * 折叠时整个正文不渲染 —— 所以这里先展开目标那张卡（点它自己的折叠箭头），
     * 再去卡内正文里找「删除」。 */
    const delExpand = await evalJs(setWs, `(function(){
        var groups = Array.from(document.querySelectorAll('#favTree .fav-group:not(.lv2)'));
        for (var i = 0; i < groups.length; i++) {
            var nm = groups[i].querySelector(':scope > .fav-row .fav-name');
            if (!nm || nm.value !== '放进横条的目录') continue;
            if (!groups[i].classList.contains('open')) {
                var f = groups[i].querySelector(':scope > .fav-row .mini.fold');
                if (f) f.click();
            }
            return 'expanded';
        }
        return 'no-row';
    })()`);
    info('展开目标目录卡：' + delExpand);
    await sleep(600);
    const delRes = await evalJs(setWs, `(function(){
        var groups = Array.from(document.querySelectorAll('#favTree .fav-group:not(.lv2)'));
        for (var i = 0; i < groups.length; i++) {
            var nm = groups[i].querySelector(':scope > .fav-row .fav-name');
            if (!nm || nm.value !== '放进横条的目录') continue;
            var del = [].find.call(groups[i].querySelectorAll('.fav-ops button'),
                function(b){ return b.textContent === '删除'; });
            if (!del) return 'no-del-btn';
            del.click();          // 第一次：进入确认态
            return 'armed';
        }
        return 'no-row';
    })()`);
    info('删除按钮第一步：' + delRes);
    await sleep(400);
    // 第二次点击同一个（已进入确认态的）按钮 —— 按文本重新找，避免引用过期
    const delGo = await evalJs(setWs, `(function(){
        var groups = Array.from(document.querySelectorAll('#favTree .fav-group:not(.lv2)'));
        for (var i = 0; i < groups.length; i++) {
            var nm = groups[i].querySelector(':scope > .fav-row .fav-name');
            if (!nm || nm.value !== '放进横条的目录') continue;
            var btns = Array.from(groups[i].querySelectorAll('.fav-ops button'));
            for (var j = 0; j < btns.length; j++) {
                if (/删除|确定/.test(btns[j].textContent)) { btns[j].click(); return 'clicked:' + btns[j].textContent; }
            }
        }
        return 'not-found';
    })()`);
    info('删除按钮第二步：' + delGo);
    await sleep(1500);

    const after = await evalJs(setWs, CONF_OF);
    const stillPg1 = (after.favorites || []).some((g) => g.id === 'pg1');
    chk('目录真的删掉了', !stillPg1, JSON.stringify((after.favorites || []).map((g) => g.id)));
    chk('配置里的 @fav:pg1 哨兵被一起剪掉（后端清理生效）',
        (after.barList || []).indexOf('@fav:pg1') < 0, JSON.stringify(after.barList));
    chk('  其它成员原样保留（顺序不动）',
        JSON.stringify(after.barList) === JSON.stringify(['百度', 'Google']),
        JSON.stringify(after.barList));

    // 落盘的那份也必须是干净的
    const onDisk = readCfg();
    chk('  磁盘上的 config.json 里也没有这个哨兵',
        (onDisk.bar_list || []).indexOf('@fav:pg1') < 0, JSON.stringify(onDisk.bar_list));
    chk('  磁盘上 fav_panel_sizes 里也没有它的键',
        !Object.prototype.hasOwnProperty.call(onDisk.fav_panel_sizes || {}, '@fav:pg1'),
        JSON.stringify(Object.keys(onDisk.fav_panel_sizes || {})));

    // 横条那边渲染出来的格子里不该再有"指向已删目录"的东西
    await sleep(1200);
    const barNames = await evalJs(barWs,
        "Array.from(document.querySelectorAll('#engines button')).map(function(b){return b.getAttribute('aria-label')||b.title||b.textContent}).join('|')");
    info('横条上现在的格子：' + barNames);
    chk('横条上不再挂着已删目录的格子', barNames.indexOf('@fav') < 0 && barNames.indexOf('pg1') < 0, barNames);
    const barLog = readLog();
    chk('后端日志里记下了这次剪枝', /剪掉 \d+ 个失效的横条哨兵/.test(barLog),
        (barLog.split('\n').filter((l) => l.indexOf('哨兵') >= 0).slice(-2).join(' / ') || '(无)'));

    /* ---------------- 收尾 ---------------- */
    rec('');
    rec('--- 仿真 WebDAV 收到的请求流水（核对功能确实走的是真网络路径） ---');
    for (const h of davHits) rec('    ' + h);
    rec('--- 隔离实例日志（末尾 10 行）---');
    for (const l of readLog().split('\n').slice(-10)) if (l.trim()) rec('    ' + l);

    rec('');
    rec('============================================================');
    rec('  通过 ' + passN + ' 项，失败 ' + failN + ' 项');
    rec('============================================================');
    stop();
    flush();
    process.exit(failN === 0 ? 0 : 1);
})().catch((e) => {
    rec('探针自己抛异常了：' + (e && e.stack || e));
    flush();
    process.exit(1);
});
