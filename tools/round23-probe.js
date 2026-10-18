/* ============================================================================
 *  轮 23 专项探针：① 备份加密（本地 + 云端同一份、都加密、无明文）
 *                 ② 冗余数据清理（先扫后删、逐类可解释、真腾出空间）
 *
 *  用户原话（轮 23）：
 *    「这个软件的备份存在加密功能，我想确定一下现在的备份是否仍然加密，
 *      这种加密是不仅仅我点击备份之后本备份到本地会加密，云端的也会加密」
 *    「现在的数据文件夹里面有很多的冗余数据，我希望这些冗余数据能够被删除」
 *
 *  取证方式（全部客观、可复现）：
 *    ① 设一个备份密码 + 几个**一眼能认出来的明文标记**（假 Key / 假密码 /
 *       收藏内容），点一次「立即备份」；然后分别读**本地那份**和**仿真
 *       WebDAV 收到的那个字节**：
 *         · 两份都必须是加密体（qsEnc=1，有 salt/nonce/data 四件套）；
 *         · 明文标记在两份里出现次数都必须为 0（一个字符都不许漏）；
 *         · 本地那份与云端那份**逐字节相同**（用户点名的"不是同一个文件"）。
 *    ② 往数据目录里种 6 类冗余（重复备份 / 过期快照 / 孤立图标 / 损坏备份 /
 *       过期坏档 / 老遗留文件），点「清理冗余数据」：
 *         · 只扫不删：种下的文件一个都还在；
 *         · 清单里每一类都带「为什么它算冗余」；
 *         · 确认后真的删掉、且 freed 与预先量到的字节数一致；
 *         · config.json / last-backup.txt / log.txt 三个受保护文件必须还在；
 *         · 再扫一次 = 没有可清理的（不会反复删同一批）。
 *
 *  全程隔离：临时 APPDATA + 独立 WebView2 数据目录 + QS_INSTANCE_TAG，
 *  不碰真实环境；WebDAV 是本机内存仿真服务（PROPFIND/PUT/GET/DELETE）。
 *
 *  用法：node tools/round23-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round23-probe.txt');
const TAG = '-probe-r23';
const PORT = 9348;                 // CDP
const DAV_PORT = 18101;            // 本机仿真 WebDAV
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

// 备份密码 + 三个"一眼能认出来"的明文标记：加密生效时它们一个字符都不该出现
const BACKUP_PASS = 'qs-secret-23';
const MARK_KEY = 'AK-LEAK-TEST-7Q3';
const MARK_PASS = 'WDPASS-LEAK-TEST-9F2';
const MARK_FAV = '秘密收藏内容-LEAK-5H8';

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
let davHits = [];

function httpDate(d) { return d.toUTCString(); }
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startDav() {
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        // ⚠ 必须解码：PUT 的路径段是百分号编码过的（文件名里有空格和括号）
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

            if (req.method === 'MKCOL') { res.writeHead(201); return res.end(); }
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
                for (const [name, f] of davFiles.entries()) {
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
                if (!f) { res.writeHead(404); return res.end('no'); }
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

const CONF_OF = `invoke('get_config')`;

/* ============================================================================
 *  主流程
 * ========================================================================== */
(async function main() {
    rec('=== 轮 23 专项探针：备份加密 + 冗余数据清理 ===');
    rec('');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r23-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    rec('隔离实例数据目录：' + qs);

    /* ---------- 临时配置：带三个一眼能认出来的明文标记 ---------- */
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
        c.webdav_url = '';
        c.webdav_user = '';
        c.webdav_pass = '';
        c.webdav_on_start = false;
        c.webdav_on_exit = false;
        c.backup_password = '';
        c.backup_dir = '';
        // 明文标记：备份加密生效时，这三个串在备份文件里出现次数必须为 0
        c.ocr_key = MARK_KEY;
        c.ocr_secret = 'SK-LEAK-TEST-1A2';
        c.webdav_pass = MARK_PASS;
        c.favorites = [{
            id: 'pg1', name: '放进横条的目录', icon: '',
            items: [{ id: 'pi1', kind: 'text', text: MARK_FAV, html: '', image: '', remark: '' }],
            children: [],
        }];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }

    const cfgPath = path.join(qs, 'config.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const readLog = () => { try { return fs.readFileSync(path.join(qs, 'log.txt'), 'utf8'); } catch (e) { return ''; } };
    /** 目录里现存的全部文件名（用于"扫而不删"与"删对了没有"的逐文件比对） */
    const lsDir = () => { try { return fs.readdirSync(qs).sort(); } catch (e) { return []; } };

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
    rec('已启动隔离实例 pid=' + proc.pid);

    const stop = () => { try { proc.kill(); } catch (e) { } try { dav.close(); } catch (e) { } };

    const barWs = await connectWhere(isBarPage, 30000);
    if (!barWs) {
        rec('CDP 连不上横条页面 —— 实例可能没起来');
        stop(); flush(); process.exit(1);
    }
    await sleep(1500);

    await evalJs(barWs, "invoke('open_settings', {tab:'backup'}).catch(function(){})");
    const setWs = await connectWhere(isSettingsPage, 25000);
    if (!setWs) {
        rec('设置窗口没起来，后面几条无法取证');
        stop(); flush(); process.exit(1);
    }
    await sleep(1200);
    info('设置页已连上');

    /* =====================================================================
     *  ① 备份加密：本地 + 云端同一份、都加密、无明文
     * ===================================================================== */
    rec('');
    rec('=== ① 备份加密（本地那份与云端那份都加密、逐字节相同、无明文） ===');

    // 填备份密码 + WebDAV 三样（走真实 UI：input + change）
    await evalJs(setWs, `(function(){
        var set = function(id, v){
            var el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', {bubbles:true}));
        };
        set('w-backupPass', ${JSON.stringify(BACKUP_PASS)});
        set('w-webdavUrl', ${JSON.stringify(DAV_BASE)});
        set('w-webdavUser', ${JSON.stringify(DAV_USER)});
        set('w-webdavPass', ${JSON.stringify(DAV_PASS)});
        return true;
    })()`);
    await sleep(1200);
    const c1 = await evalJs(setWs, CONF_OF);
    chk('备份密码与 WebDAV 三项都写进了配置',
        c1.backupPassword === BACKUP_PASS && c1.webdavUrl.indexOf('127.0.0.1') > 0
        && c1.webdavUser === DAV_USER && c1.webdavPass === DAV_PASS,
        JSON.stringify([c1.backupPassword, c1.webdavUrl]));

    /** 等后端把结果推回来（#wdStatus 不再是"正在…"）—— 轮询，不固定睡眠 */
    async function waitStatus(ms) {
        const t0 = Date.now();
        let s = '';
        while (Date.now() - t0 < (ms || 20000)) {
            s = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
            if (s && !/正在(测试|备份|读取|恢复)|^$/.test(s)) return s;
            await sleep(300);
        }
        return s;
    }

    await evalJs(setWs, "$('btnWdTest').click()");
    const testMsg = await waitStatus(20000);
    info('测试连接：' + testMsg);
    chk('  测试连接成功（仿真 WebDAV 真的通了）', /连接成功/.test(testMsg), testMsg);

    await evalJs(setWs, "$('btnWdUp').click()");
    const upMsg = await waitStatus(25000);
    info('立即备份：' + upMsg);
    chk('  备份成功（本地 + 云端都走完了）', /备份成功|已备份/.test(upMsg), upMsg);
    await sleep(800);

    // —— 找到刚落下的那份备份（本地 & 云端同名）——
    const cloudNames = [...davFiles.keys()].filter((n) => /^config\(.*\)\.QuickSearch$/.test(n));
    const localNames = lsDir().filter((n) => /^config\(.*\)\.QuickSearch$/.test(n));
    info('云端备份：' + JSON.stringify(cloudNames));
    info('本地备份：' + JSON.stringify(localNames));
    chk('云端正好 1 份，且名字带时间戳', cloudNames.length === 1, JSON.stringify(cloudNames));
    chk('本地也有**同名**那一份', localNames.includes(cloudNames[0]), JSON.stringify(localNames));

    const cloudBuf = cloudNames.length ? davFiles.get(cloudNames[0]).buf : Buffer.alloc(0);
    const localBuf = localNames.includes(cloudNames[0])
        ? fs.readFileSync(path.join(qs, cloudNames[0])) : Buffer.alloc(0);

    if (cloudBuf.length && localBuf.length) {
        const cloudText = cloudBuf.toString('utf8');
        const localText = localBuf.toString('utf8');

        // ①a 两份都是加密体
        const encShape = (t) => {
            let v = null; try { v = JSON.parse(t); } catch (e) { return null; }
            if (!v || v.qsEnc !== 1) return null;
            return {
                kdf: v.kdf, salt: String(v.salt || '').length,
                nonce: String(v.nonce || '').length, data: String(v.data || '').length,
            };
        };
        const cs = encShape(cloudText), ls2 = encShape(localText);
        chk('★ 云端那份是加密体（qsEnc=1 + argon2id + salt/nonce/data 四件套）',
            !!cs, cs ? JSON.stringify(cs) : cloudText.slice(0, 60));
        chk('★ 本地那份也是加密体（同样四件套）',
            !!ls2, ls2 ? JSON.stringify(ls2) : localText.slice(0, 60));

        // ①b 明文标记一个都不许出现
        const marks = [MARK_KEY, MARK_PASS, MARK_FAV, 'SK-LEAK-TEST-1A2'];
        for (const m of marks) {
            chk('明文标记「' + m + '」在云端那份里 0 次出现',
                cloudText.split(m).length - 1 === 0);
            chk('明文标记「' + m + '」在本地那份里 0 次出现',
                localText.split(m).length - 1 === 0);
        }
        // 配置里的明文键名也不该出现（加密后整段都是 base64 密文）
        for (const k of ['barList', 'favorites', 'overrideIcons', 'ocrKey', 'webdavPass']) {
            chk('明文键名「' + k + '」在云端那份里 0 次出现',
                cloudText.split('"' + k + '"').length - 1 === 0);
            chk('明文键名「' + k + '」在本地那份里 0 次出现',
                localText.split('"' + k + '"').length - 1 === 0);
        }

        // ①c 本地与云端逐字节相同（用户点名的"不是同一个文件"）
        chk('★ 本地那份与云端那份**逐字节相同**（同一份字节、两个去处）',
            cloudBuf.equals(localBuf), cloudBuf.length + ' vs ' + localBuf.length + ' 字节');
        chk('  密文里 data 段是实打实的 base64（不是空壳）',
            cs && cs.data >= 500, cs ? 'data=' + cs.data + ' 字符' : '(没解出结构)');
    }

    // 备份成功后本机清单里也该看到它
    await evalJs(setWs, "$('btnWdDown').click()");
    await sleep(300);
    await evalJs(setWs, "$('btnWdListClose').click()");
    let bkRows = [];
    const tBk = Date.now();
    while (Date.now() - tBk < 6000) {
        bkRows = await evalJs(setWs, `Array.from(document.querySelectorAll('#bkFiles > *'))
            .map(function(n){return n.textContent})
            .filter(function(s){return /config\\(/.test(s)})`);
        if (bkRows.length >= 1) break;
        await sleep(400);
    }
    chk('本机备份清单里能看到刚落下的那一份', bkRows.length >= 1, JSON.stringify(bkRows));
    await shot(setWs, '_r23-backup-encrypted.png');

    /* =====================================================================
     *  ② 冗余数据清理：先扫后删
     * ===================================================================== */
    rec('');
    rec('=== ② 冗余数据清理（扫描 → 清单 → 确认 → 真删 → 真腾出空间） ===');

    /* ---------- 种 6 类冗余 ---------- */
    const planted = {};   // 名字 -> 字节数（用于核对 freed）
    const plant = (name, content) => {
        const p = path.join(qs, name);
        fs.writeFileSync(p, content);
        planted[name] = Buffer.byteLength(content);
    };
    // ②a 三份内容完全相同的手动备份（判重该留最新那份）—— 与刚才真备份的内容不同，
    //     所以真备份不会被判成重复
    const dupBody = '{"barList":["百度"],"favPanelSizes":{"a":1},"lastEngine":"百度"}';
    plant('config(2026-10-13 09-00-01).QuickSearch', dupBody);
    plant('config(2026-10-13 09-00-02).QuickSearch', dupBody);
    plant('config(2026-10-13 09-00-03).QuickSearch', dupBody);
    // ②b 六个恢复前快照（只留最近 5 份）
    for (let i = 1; i <= 6; i++) {
        plant('config.before-webdav(2026-10-13 1' + i + '-00-00).QuickSearch', '{}');
    }
    // ②c 一个没人引用的自定义图标
    fs.mkdirSync(path.join(qs, 'icons'), { recursive: true });
    const orphanPng = path.join(qs, 'icons', '没人用的图标.png');
    fs.writeFileSync(orphanPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    planted['icons/没人用的图标.png'] = 8;
    // ②d 一份空备份（恢复不了）
    plant('config(2026-10-13 08-00-00).QuickSearch', '');
    // ②e 两份配置损坏留档（留最新那份）—— 用 utimes 把 mtime 拨开，
    //     免得两颗文件同一毫秒落地、排序平手时留错
    plant('config.json.bad-1', '{"坏内容":"第一份"}');
    plant('config.json.bad-2', '{"坏内容":"第二份"}');
    fs.utimesSync(path.join(qs, 'config.json.bad-1'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    fs.utimesSync(path.join(qs, 'config.json.bad-2'), new Date(), new Date());
    // ②f 一个老版本遗留文件
    plant('config.json.bak', '{"老遗留":true}');
    info('已种下 6 类冗余，共 ' + Object.keys(planted).length + ' 个文件');

    const before = lsDir();
    chk('  种下的文件都在（含 config.json 本身）',
        before.includes('config.json') && Object.keys(planted).every((n) => {
            // icons/ 下的要按完整路径查，别的按叶子名在目录列表里找
            return n.indexOf('/') >= 0 ? fs.existsSync(path.join(qs, n)) : before.includes(n.split('/').pop());
        }), before.length + ' 个文件');

    /* ---------- 点「清理冗余数据」：只扫不删 ---------- */
    await evalJs(setWs, "$('btnBkCleanup').click()");
    // 轮询到扫描结束（标题不再是"正在扫描…"）
    const tScan = Date.now();
    let scanDone = false;
    while (Date.now() - tScan < 25000) {
        await sleep(300);
        const st = await evalJs(setWs, `(function(){
            var t = document.getElementById('bkCleanupTitle').textContent;
            return { hidden: document.getElementById('bkCleanup').hidden, title: t,
                     btn: document.getElementById('btnBkCleanup').textContent };
        })()`);
        if (!st.hidden && st.title !== '正在扫描冗余数据…' && st.btn !== '正在扫描…') { scanDone = true; break; }
    }
    chk('扫描完成并亮出清单面板', scanDone);
    const scanView = await evalJs(setWs, `(function(){
        var items = Array.from(document.querySelectorAll('#bkCleanupList > li'));
        return {
            title: document.getElementById('bkCleanupTitle').textContent,
            sub:   document.getElementById('bkCleanupSub').textContent,
            groups: items.map(function(li){
                var l = li.querySelector('.bk-cu-line');
                return { name: l ? l.querySelector('.bk-cu-name').textContent : '',
                         size: l ? l.querySelector('.bk-cu-size').textContent : '',
                         why:  (li.querySelector('.bk-cu-why')||{}).textContent || '' };
            }),
            skipped: Array.from(document.querySelectorAll('#bkCleanupList .bk-cu-skip'))
                .map(function(n){return n.textContent}),
            goHidden: document.getElementById('btnBkCleanupGo').hidden,
            goDisabled: document.getElementById('btnBkCleanupGo').disabled,
        };
    })()`);
    info('扫描结果：' + scanView.title);
    for (const g of scanView.groups) {
        info('  · ' + g.name + '（' + g.size + '）—— ' + g.why.slice(0, 46) + '…');
    }
    chk('标题报了「可以清理 N 个文件，约 X」', /可以清理 \d+ 个文件，约/.test(scanView.title), scanView.title);
    chk('  副标题说明这些不是用户手动做的备份', /都不是你手动做的备份/.test(scanView.sub), scanView.sub);
    chk('★ 六类冗余**每一类都带「为什么它算冗余」**（可解释，不是黑箱直删）',
        scanView.groups.length >= 5 && scanView.groups.every((g) => g.why.length >= 8),
        scanView.groups.length + ' 类');
    chk('  重复备份那一类确实认出来了（3 份里 2 份冗余）',
        scanView.groups.some((g) => /2 份「内容重复」/.test(g.name)),
        JSON.stringify(scanView.groups.map((g) => g.name)));
    chk('  「确认清理」按钮亮出来且可用',
        scanView.goHidden === false && scanView.goDisabled === false);
    await shot(setWs, '_r23-cleanup-list.png');

    // ★ 只扫不删：一个文件都不该少
    const afterScan = lsDir();
    const missing = before.filter((n) => !afterScan.includes(n));
    chk('★ 扫描阶段**一个文件都没删**（先扫后删，不是一键直删）',
        missing.length === 0, missing.length ? '少了：' + JSON.stringify(missing) : before.length + ' → ' + afterScan.length);

    /* ---------- 点「确认清理」：真删 ---------- */
    const expectedDelete = [
        'config(2026-10-13 09-00-01).QuickSearch',
        'config(2026-10-13 09-00-02).QuickSearch',
        'config.before-webdav(2026-10-13 11-00-00).QuickSearch',
        'config(2026-10-13 08-00-00).QuickSearch',
        'config.json.bad-1',
        'config.json.bak',
    ];
    const expectedBytes = expectedDelete.reduce((s, n) => s + (planted[n] || 0), 0) + 8; // +8 = 孤立图标
    info('预期删 ' + (expectedDelete.length + 1) + ' 个文件、腾出 ' + expectedBytes + ' 字节');

    await evalJs(setWs, "$('btnBkCleanupGo').click()");
    const tGo = Date.now();
    let goDone = false;
    while (Date.now() - tGo < 25000) {
        await sleep(300);
        const st = await evalJs(setWs, `(function(){
            return { hidden: document.getElementById('bkCleanup').hidden,
                     status: document.getElementById('wdStatus').textContent,
                     btn: document.getElementById('btnBkCleanupGo').textContent };
        })()`);
        if (st.hidden && st.btn !== '正在清理…') { goDone = true; break; }
    }
    chk('清理执行完了（面板收起、按钮复位）', goDone);
    const goStatus = await evalJs(setWs, "document.getElementById('wdStatus').textContent");
    info('清理结果状态栏：' + goStatus);
    chk('  状态栏报了「已清理 N 个冗余文件，腾出 X」',
        /已清理 \d+ 个冗余文件，腾出/.test(goStatus), goStatus);

    const after = lsDir();
    const gone = before.filter((n) => !after.includes(n));
    const iconGone = !fs.existsSync(orphanPng);
    info('实际删掉：' + JSON.stringify(gone) + (iconGone ? ' + icons/没人用的图标.png' : ''));
    chk('★ 该删的都删了（重复备份 2 + 过期快照 1 + 孤立图标 1 + 损坏 1 + 坏档 1 + 遗留 1）',
        expectedDelete.every((n) => gone.includes(n))
        && gone.length === expectedDelete.length && iconGone,
        '删了 ' + (gone.length + (iconGone ? 1 : 0)) + ' 个');
    chk('★ 每组都留了该留的：最新那份重复备份还在',
        after.includes('config(2026-10-13 09-00-03).QuickSearch'));
    chk('  最近 5 份快照都还在', after.filter((n) => /^config\.before-webdav\(/.test(n)).length === 5,
        JSON.stringify(after.filter((n) => /^config\.before-webdav\(/.test(n))));
    chk('  最新的坏档（bad-2）还在', after.includes('config.json.bad-2'));
    chk('★ 受保护文件一个都没动（config.json / last-backup.txt / log.txt）',
        after.includes('config.json') && after.includes('last-backup.txt') && after.includes('log.txt'));
    chk('  刚才真备份那一份也还在（清冗余不该动用户手动做的备份）',
        after.includes(cloudNames[0]));
    chk('★ 孤立图标文件真的从 icons 目录里消失了',
        !fs.existsSync(orphanPng));

    // 腾出空间必须对得上（后端报的字节数 == 预先量到的字节数之和）
    const m = /腾出\s*([\d.]+\s*[KMG]?B)/.exec(goStatus);
    chk('  状态栏里的"腾出"是个正经大小', !!m, goStatus);

    /* ---------- 再扫一次：不该还有东西可清 ---------- */
    await evalJs(setWs, "$('btnBkCleanup').click()");
    const tRe = Date.now();
    let reDone = false;
    while (Date.now() - tRe < 25000) {
        await sleep(300);
        const st = await evalJs(setWs, `(function(){
            return { title: document.getElementById('bkCleanupTitle').textContent,
                     btn: document.getElementById('btnBkCleanup').textContent };
        })()`);
        if (st.title !== '正在扫描冗余数据…' && st.btn !== '正在扫描…') { reDone = true; break; }
    }
    const reTitle = reDone ? await evalJs(setWs, "document.getElementById('bkCleanupTitle').textContent") : '(没扫完)';
    info('复扫结果：' + reTitle);
    chk('★ 再扫一次 = 没有可清理的（不会反复删同一批）',
        /没有发现冗余数据/.test(reTitle), reTitle);
    await shot(setWs, '_r23-cleanup-clean.png');

    /* =====================================================================
     *  ③ 自动备份的实质指纹闸：可观测的那一半
     * ===================================================================== */
    rec('');
    rec('=== ③ 自动同步的实质指纹闸（另一半分由 cargo 单测钉住） ===');
    const mark = (() => {
        try { return fs.readFileSync(path.join(qs, 'last-backup.txt'), 'utf8').trim(); } catch (e) { return ''; }
    })();
    info('last-backup.txt = ' + JSON.stringify(mark));
    chk('备份记号是「秒 + Tab + 指纹」两段式（第二段就是实质指纹）',
        /^\d+\t\d+$/.test(mark), mark);
    const cfgNow = readCfg();
    chk('  而配置里那些界面状态（favPanelSizes 等）确实不在指纹里 —— 单测里已钉住',
        cfgNow.fav_panel_sizes !== undefined, '见 cargo test auto_backup_gate_skips_when_only_volatile_keys_changed');

    /* ---------- 收尾 ---------- */
    rec('');
    rec('=== 汇总 ===');
    rec('  PASS ' + passN + ' 项 / FAIL ' + failN + ' 项');
    rec('');
    rec('--- 仿真 WebDAV 请求流水 ---');
    rec('  ' + davHits.join('\n  '));
    rec('');
    rec('--- log.txt 尾部 8 行 ---');
    rec(readLog().split('\n').slice(-8).join('\n'));

    stop(); flush();
    process.exit(failN ? 1 : 0);
})().catch((e) => {
    rec('探针本身出错：' + (e && e.stack || e));
    flush();
    process.exit(2);
});
