/* ============================================================================
 *  轮 24 专项探针：外部软件接入（把第三方应用加成横条上一颗图标）
 *
 *  用户原话（轮 24 / 任务 #102）：
 *    「在引擎管理面板中提供"新建引擎"入口，支持输入目标软件的 URL 并为其
 *      配置自定义图标；保存后将该图标固定到界面横栏中；点击横栏图标即可
 *      直接唤起或跳转至对应软件的相关功能……并妥善处理无效 URL、图标加载
 *      失败等异常情况。」
 *
 *  取证方式（全部客观、可复现；全程不真的唤起任何第三方程序）：
 *    ① 无效 URL：填 javascript:alert(1) → 保存 → 中文原因显示在表单下，
 *       config.json 里**没有**这条软件，横条上**没有**这颗格子；
 *    ② 正当添加：填 weixin:// → 保存 → config.json 的 apps 多一条、
 *       bar_list 末尾多一根 @app:<id> 哨兵（"保存即固定"），横条 DOM 多一颗
 *       .qs-app-inbar 格子（tooltip 带软件名、没挑图标时是首字徽标）；
 *    ③ 自定义图标：往 icons 目录放一张真 PNG + config 里按 @app:<id> 挂上 →
 *       **重启实例** → 横条格子变成那张图（数据持久化 + 图标键按 id 存）；
 *       同一次重启里还验：手改 config 塞一根悬空 @app:dead 哨兵 → 启动即被剪掉，
 *       横条不渲染、设置页"横条上的引擎"也不显示乱码行；
 *    ④ 点击横条格子：另加一个指向**本机不存在路径**的 file:// 软件（校验合法、
 *       打开必然失败）→ 点它 → open_app 真的到了 Rust（log.txt 有那一行）、
 *       失败原因显示在横条提示位上。全程没有任何程序被唤起；
 *    ⑤ 改名：编辑改名 → config 里 name 变、id 不变，横条格子还在、tooltip 变新名；
 *    ⑥ 删除：两步确认 → config 里软件没了、哨兵没了、横条格子没了。
 *
 *  为什么用 file:// 不存在的路径验 ④：点一下必须真的走到 shell_open 才算
 *  "接线成功"，但又不能在人桌上弹出一个浏览器 / 唤起微信。不存在的路径
 *  ShellExecuteW 直接返 SE_ERR_FNOFOUND（不弹任何对话框），open::that 报错，
 *  前端把原因显示在横条提示位上 —— 整条链（点击 → invoke → Rust → 失败反馈）
 *  都被走到，且零副作用。正当 URL 的成功路径由 open::that（成熟 crate，
 *  open_search/open_link 早就走它）+ 单测 + test-ui 共同覆盖。
 *
 *  全程隔离：临时 APPDATA + 独立 WebView2 数据目录 + QS_INSTANCE_TAG，
 *  不碰真实环境。每次重启都换 CDP 端口和实例 tag —— 旧实例的浏览器进程
 *  万一残留，也只会占着旧端口，不可能让探针连错页面。
 *
 *  用法：node tools/round24-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round24-probe.txt');
const TAG = '-probe-r24';
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';

// 一个校验合法、但打开必然失败的地址（本机没有这个目录）
const FAIL_URL = 'file:///C:/qs-probe-no-such-dir-xyz/none.exe';

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
 *  CDP 基建（与轮 23 同一套）
 * ========================================================================== */
let PORT = 9350;
let wsId = 0;
const wsPending = new Map();
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        wsPending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
function wireWs(ws) {
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && wsPending.has(m.id)) {
            const p = wsPending.get(m.id);
            wsPending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message || 'cdp'));
            else p.resolve(m.result);
        }
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        // text 只有 "Uncaught"，真实原因（ReferenceError: invoke is not defined …）
        // 在 exception.description 里，必须一起打出来
        const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text)
            + (desc ? ' | ' + String(desc).split('\n')[0] : '')
            + ' | ' + expr.slice(0, 120));
    }
    return r.result.value;
}
/** 等 Tauri IPC 注入完（页面 target 一连上就 eval 会撞 ReferenceError） */
async function waitInvoke(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        try {
            if ((await evalJs(ws, "typeof invoke === 'function' && typeof listen === 'function'")) === true) return true;
        } catch (e) { /* 上下文还没建好，继续等 */ }
        await sleep(300);
    }
    return false;
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
            wireWs(ws);
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

/* ============================================================================
 *  主流程
 * ========================================================================== */
(async function main() {
    rec('=== 轮 24 专项探针：外部软件接入（#102） ===');
    rec('');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r24-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(path.join(qs, 'icons'), { recursive: true });
    rec('隔离实例数据目录：' + qs);

    /* ---------- 临时配置：干净起步，触发全关 ---------- */
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
        c.apps = [];
        c.overrides = {};
        c.bar_list = ['百度', 'Google'];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }

    const cfgPath = path.join(qs, 'config.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const writeCfg = (c) => fs.writeFileSync(cfgPath, JSON.stringify(c, null, 1), 'utf8');
    const readLog = () => { try { return fs.readFileSync(path.join(qs, 'log.txt'), 'utf8'); } catch (e) { return ''; } };

    /* ---------- 起隔离实例（端口 / tag 每次换，重启互不干扰） ---------- */
    let proc = null;
    function spawnInstance() {
        PORT = 9350 + Math.floor(Math.random() * 40);
        const env = Object.assign({}, process.env, {
            APPDATA: tmp,
            LOCALAPPDATA: tmp,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
            QS_DEBUG: '1',
            QS_INSTANCE_TAG: TAG + '-' + PORT,
            QS_T_WV_ARGS: WV_BASE + PORT,
        });
        proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
        rec('启动隔离实例 pid=' + proc.pid + '（CDP 端口 ' + PORT + '）');
    }
    const stop = () => { try { proc.kill(); } catch (e) { } };
    /** 关掉当前实例并起一个新的（换端口 + 换 tag，旧残留连不上来） */
    async function restart() {
        stop();
        await new Promise((res) => {
            const t0 = Date.now();
            const tick = setInterval(() => {
                if (proc.exitCode !== null || Date.now() - t0 > 8000) { clearInterval(tick); res(); }
            }, 200);
        });
        await sleep(1500);
        spawnInstance();
        barWs = await connectWhere(isBarPage, 30000);
        if (!barWs) throw new Error('重启后连不上横条页面');
        if (!(await waitInvoke(barWs))) throw new Error('重启后 IPC 没就绪（invoke 一直没注入）');
        await evalJs(barWs, "invoke('open_settings', {tab:'engines'}).catch(function(){})");
        setWs = await connectWhere(isSettingsPage, 25000);
        if (!setWs) throw new Error('重启后设置窗口没起来');
        await sleep(1200);
    }

    spawnInstance();
    let barWs = await connectWhere(isBarPage, 30000);
    if (!barWs) {
        rec('CDP 连不上横条页面 —— 实例可能没起来');
        stop(); flush(); process.exit(1);
    }
    if (!(await waitInvoke(barWs))) {
        rec('IPC 没就绪（invoke 一直没注入）');
        stop(); flush(); process.exit(1);
    }
    await evalJs(barWs, "invoke('open_settings', {tab:'engines'}).catch(function(){})");
    let setWs = await connectWhere(isSettingsPage, 25000);
    if (!setWs) {
        rec('设置窗口没起来，后面几条无法取证');
        stop(); flush(); process.exit(1);
    }
    await sleep(1200);
    info('横条页与设置页（引擎分页）都已连上');

    /** 横条上外部软件格子的快照 */
    const barAppBtns = () => evalJs(barWs, `Array.from(
        document.querySelectorAll('#engines button.qs-app-inbar')).map(function(b){
            var ic = b.querySelector('img') || b.querySelector('.letter');
            return { app: b.dataset.app, title: b.title,
                     icon: ic ? (ic.tagName === 'IMG' ? 'img:' + ic.src.slice(0, 24) : 'letter:' + ic.textContent) : 'none' };
        })`);
    /** 设置页「外部软件」列表的快照 */
    const setAppRows = () => evalJs(setWs, `Array.from(
        document.querySelectorAll('#appList .item')).map(function(r){
            return r.textContent.replace(/\\s+/g, ' ').slice(0, 120);
        })`);
    /** 等配置真的落盘（轮询，不固定睡眠） */
    async function waitCfg(pred, ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < (ms || 15000)) {
            let c = null; try { c = readCfg(); } catch (e) { }
            if (c && pred(c)) return c;
            await sleep(300);
        }
        return readCfg();
    }
    const setVal = (id, v) => evalJs(setWs, `(function(){
        var el = document.getElementById(${JSON.stringify(id)});
        el.value = ${JSON.stringify(v)};
        return el.value;
    })()`);

    /* =====================================================================
     *  ① 无效 URL：拦在保存之前
     * ===================================================================== */
    rec('');
    rec('=== ① 无效 URL（javascript:…）被拦下，不落库、不上横条 ===');
    await setVal('w-apName', '坏地址');
    await setVal('w-apUrl', 'javascript:alert(1)');
    await evalJs(setWs, "$('btnApSave').click()");
    await sleep(1200);
    const hint1 = await evalJs(setWs, "document.getElementById('apHint').textContent");
    info('表单下方提示：' + hint1);
    chk('★ 无效地址给出中文原因（不是英文堆栈、不是静默失败）',
        /协议|打不开/.test(hint1), hint1);
    chk('  提示里点名了 javascript:', /javascript/.test(hint1), hint1);
    const cA = readCfg();
    chk('  config.json 里没有这条软件', (cA.apps || []).length === 0,
        JSON.stringify(cA.apps));
    chk('  横条上也没有多出格子', (await barAppBtns()).length === 0);

    /* =====================================================================
     *  ② 正当添加：保存即固定到横条
     * ===================================================================== */
    rec('');
    rec('=== ② 正当添加：落库 + 钉进横条 + 横条渲染出格子 ===');
    await setVal('w-apName', '微信');
    await setVal('w-apUrl', 'weixin://');
    await evalJs(setWs, "$('btnApSave').click()");
    const cB = await waitCfg((c) => (c.apps || []).length === 1);
    chk('★ 保存后 config.json 里多了一条软件', (cB.apps || []).length === 1,
        JSON.stringify(cB.apps));
    const appId = cB.apps[0] && cB.apps[0].id;
    chk('  带上了 id（横条哨兵与图标都按它钉）', !!appId && appId.length > 0, appId);
    chk('  名字 / 地址原样落库',
        cB.apps[0].name === '微信' && cB.apps[0].url === 'weixin://',
        JSON.stringify(cB.apps[0]));
    chk('★ bar_list 末尾自动多出 @app:<id> 哨兵（"保存后固定到横栏"）',
        cB.bar_list[cB.bar_list.length - 1] === '@app:' + appId,
        JSON.stringify(cB.bar_list));
    chk('  原有横条成员一个没少（哨兵是追加，不是替换）',
        cB.bar_list.slice(0, 2).join(',') === '百度,Google', JSON.stringify(cB.bar_list));
    await sleep(800);   // 等 qs://config 广播把横条重画完
    const btnsB = await barAppBtns();
    chk('★ 横条上渲染出了这一格', btnsB.length === 1, JSON.stringify(btnsB));
    chk('  tooltip 带软件名 + 「点一下直接打开」',
        btnsB[0] && /微信/.test(btnsB[0].title) && /直接打开/.test(btnsB[0].title),
        btnsB[0] && btnsB[0].title);
    chk('  没挑图标时用软件名首字徽标（不是哨兵名的 @）',
        btnsB[0] && btnsB[0].icon === 'letter:微', btnsB[0] && btnsB[0].icon);
    const rowsB = await setAppRows();
    chk('  设置页列表也出现了这一行', rowsB.length === 1 && /微信/.test(rowsB[0]),
        JSON.stringify(rowsB));
    await shot(setWs, '_r24-apps-added.png');
    await shot(barWs, '_r24-bar-app-cell.png');

    /* =====================================================================
     *  ③ 自定义图标 + 悬空哨兵剪枝（重启实例）
     * ===================================================================== */
    rec('');
    rec('=== ③ 自定义图标持久化 & 悬空哨兵剪枝（重启实例） ===');
    {
        // 一张一眼能认出来的真 PNG（4×4 纯色）
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8DwnwEIGBmw' +
            'AwMDAAAA//8DAAoAAdoCLb0AAAAASUVORK5CYII=', 'base64');
        fs.writeFileSync(path.join(qs, 'icons', '_probe-app.png'), png);
        const c = readCfg();
        c.overrides = c.overrides || {};
        c.overrides['@app:' + appId] = '_probe-app.png';   // 按哨兵（= 按 id）挂图标
        c.bar_list.push('@app:dead');                       // 手改配置塞一根悬空哨兵
        writeCfg(c);
        info('已往 icons/ 放 _probe-app.png、config 里挂到 @app:' + appId
            + '，并塞了一根悬空哨兵 @app:dead');
    }
    await restart();
    const btnsC = await barAppBtns();
    chk('★ 重启后横条格子用的是那张自定义图标（img，且 src 是 data URL）',
        btnsC.length === 1 && /^img:data:/.test(btnsC[0].icon),
        JSON.stringify(btnsC));
    chk('★ 悬空的 @app:dead 被剪掉了：横条上还是只有那一格',
        btnsC.length === 1, JSON.stringify(btnsC));
    const barRowsC = await evalJs(setWs, `Array.from(
        document.querySelectorAll('#barList .item:not(.add-row)'))
        .map(function(r){ return r.textContent.replace(/\\s+/g,' ').slice(0,60); })`);
    chk('  设置页「横条上的引擎」里也没有 @app:dead 乱码行',
        barRowsC.every((t) => !/@app:/.test(t)), JSON.stringify(barRowsC));
    chk('  那一行显示的是软件名 + 「外部软件」标注',
        barRowsC.some((t) => /微信/.test(t) && /外部软件/.test(t)),
        JSON.stringify(barRowsC));
    await shot(barWs, '_r24-bar-app-icon.png');

    /* =====================================================================
     *  ④ 点击横条格子：真的走到 open_app（用一个打开必败的地址）
     * ===================================================================== */
    rec('');
    rec('=== ④ 点击横条图标 → open_app（失败原因显示在横条提示位） ===');
    await setVal('w-apName', '打不开的');
    await setVal('w-apUrl', FAIL_URL);
    await evalJs(setWs, "$('btnApSave').click()");
    const cD = await waitCfg((c) => (c.apps || []).length === 2);
    const failId = cD.apps[1] && cD.apps[1].id;
    chk('  校验合法的 file:// 地址加得进来', !!failId, JSON.stringify(cD.apps));
    await sleep(800);
    {
        const before = (await barAppBtns()).length;
        chk('  横条上现在有两颗软件格子', before === 2, String(before));
        // 点第二颗（打不开的那个）
        await evalJs(barWs, `(function(){
            var bs = document.querySelectorAll('#engines button.qs-app-inbar');
            bs[bs.length - 1].click();
            return true;
        })()`);
        // 轮询提示位（showBarTip 有 2.6s 自动恢复，别睡死）
        let tip = '', hidden = true;
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
            const st = await evalJs(barWs, `(function(){
                var t = document.getElementById('tip');
                return { hidden: t.hidden, text: t.textContent };
            })()`);
            tip = st.text; hidden = st.hidden;
            if (!st.hidden && /打不开/.test(st.text)) break;
            await sleep(250);
        }
        info('横条提示位：hidden=' + hidden + ' text=' + JSON.stringify(tip));
        chk('★ 点下去真的调用了 open_app，且失败原因显示在横条上',
            hidden === false && /打不开/.test(tip), tip);
        chk('  提示是一句短人话（找不到那个路径），不是一整段启动器英文',
            /找不到/.test(tip) && tip.length <= 90, tip.length + ' 字符');
        await sleep(300);
        const log = readLog();
        chk('  log.txt 里有 open_app 那一行（命令真的到了 Rust）',
            log.indexOf('open_app: ' + failId) >= 0,
            log.split('\n').filter((l) => l.indexOf('open_app') >= 0).slice(-1)[0] || '(没有)');
        chk('  日志里带着完整地址（排查时看得见点的是什么）',
            log.indexOf(FAIL_URL) >= 0);
    }
    await shot(barWs, '_r24-bar-open-failed.png');

    /* =====================================================================
     *  ⑤ 改名：id 不变、横条格子还在
     * ===================================================================== */
    rec('');
    rec('=== ⑤ 改名：横条格子按 id 钉，改名不该让它消失 ===');
    await evalJs(setWs, `(function(){
        var rows = document.querySelectorAll('#appList .item');
        var btn = Array.from(rows[0].querySelectorAll('.mini'))
            .find(function(b){ return b.textContent === '编辑'; });
        btn.click();
        return true;
    })()`);
    await sleep(600);
    const nameVal = await evalJs(setWs, "document.getElementById('w-apName').value");
    chk('  点编辑后表单被填入原名字', nameVal === '微信', nameVal);
    await setVal('w-apName', '企业微信');
    await evalJs(setWs, "$('btnApSave').click()");
    const cE = await waitCfg((c) => c.apps[0] && c.apps[0].name === '企业微信');
    chk('★ 改名落库', cE.apps[0].name === '企业微信', JSON.stringify(cE.apps[0]));
    chk('★ id 没变（格子是按 id 钉的）', cE.apps[0].id === appId,
        cE.apps[0].id + ' vs ' + appId);
    chk('  地址也没被动', cE.apps[0].url === 'weixin://', cE.apps[0].url);
    await sleep(800);
    const btnsE = await barAppBtns();
    chk('★ 横条格子还在（没有因为改名消失）',
        btnsE.some((b) => b.app === '@app:' + appId), JSON.stringify(btnsE));
    chk('  tooltip 跟着变成新名字',
        btnsE[0] && /企业微信/.test(btnsE[0].title), btnsE[0] && btnsE[0].title);

    /* =====================================================================
     *  ⑥ 删除：两步确认，软件 / 哨兵 / 格子三清
     * ===================================================================== */
    rec('');
    rec('=== ⑥ 删除：两步确认 → 软件、哨兵、横条格子三清 ===');
    await evalJs(setWs, `(function(){
        var rows = document.querySelectorAll('#appList .item');
        var del = Array.from(rows[0].querySelectorAll('.mini'))
            .find(function(b){ return b.textContent === '删除'; });
        del.click();
        return del.textContent;
    })()`);
    await sleep(300);
    const delLabel = await evalJs(setWs, `(function(){
        var rows = document.querySelectorAll('#appList .item');
        var del = Array.from(rows[0].querySelectorAll('.mini'))
            .find(function(b){ return /删除/.test(b.textContent); });
        return del ? del.textContent : '(没了)';
    })()`);
    chk('  第一次点只是变成确认态', /确认/.test(delLabel), delLabel);
    const cAfterFirst = readCfg();
    chk('  确认态下还没有真的删', (cAfterFirst.apps || []).length === 2,
        JSON.stringify(cAfterFirst.apps.map((a) => a.name)));
    await evalJs(setWs, `(function(){
        var rows = document.querySelectorAll('#appList .item');
        var del = Array.from(rows[0].querySelectorAll('.mini'))
            .find(function(b){ return /确认/.test(b.textContent); });
        del.click();
        return true;
    })()`);
    const cF = await waitCfg((c) => (c.apps || []).length === 1);
    chk('★ 第二次点才真的删掉软件', cF.apps.length === 1 && cF.apps[0].id === failId,
        JSON.stringify(cF.apps));
    chk('★ bar_list 里的哨兵一起清掉（不留点不动的幽灵格子）',
        !cF.bar_list.some((n) => n === '@app:' + appId), JSON.stringify(cF.bar_list));
    chk('  icons 挂载键（overrides）也清掉，不留孤儿图标',
        !(cF.overrides || {})['@app:' + appId],
        JSON.stringify(Object.keys(cF.overrides || {})));
    await sleep(800);
    const btnsF = await barAppBtns();
    chk('★ 横条上那颗格子真的消失了', btnsF.length === 1, JSON.stringify(btnsF));
    chk('  剩下的是另一个软件（删对了对象）',
        btnsF[0] && btnsF[0].app === '@app:' + failId, JSON.stringify(btnsF));
    await shot(setWs, '_r24-apps-after-delete.png');

    /* ---------- 收尾 ---------- */
    rec('');
    rec('=== 汇总 ===');
    rec('  PASS ' + passN + ' 项 / FAIL ' + failN + ' 项');
    rec('');
    rec('--- log.txt 里与 open_app 相关的行 ---');
    rec('  ' + (readLog().split('\n').filter((l) => l.indexOf('open_app') >= 0).join('\n  ') || '(无)'));

    stop(); flush();
    process.exit(failN ? 1 : 0);
})().catch((e) => {
    rec('探针本身出错：' + (e && e.stack || e));
    // 探针异常退出也要收掉子进程（否则隔离实例变孤儿，占着端口和图标缓存）
    try { if (proc) proc.kill(); } catch (e2) { }
    flush();
    process.exit(2);
});
