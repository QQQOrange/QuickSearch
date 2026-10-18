/* r58「快捷键引擎 → 绑定应用」探针
 *
 * 用户原话：「绑定应用，作用是一个快捷键，绑定应用，当在横条里面点击这个快捷键
 * 对应的图标之后，软件内部要先确定这个应用真的已经打开了，如果打开了就直接把
 * 这个快捷键给运用出来，如果没有打开，那就先打开这个应用，然后再实行快捷键。
 * 每一个快捷键引擎都要添加一个这个逻辑的开关。也要可选是否以管理员方式打开该应用」
 *
 * 验五组：
 *   A. 设置页表单：快捷键类才出现「绑定应用」；勾开关 → 出现选应用；
 *      选了应用 → 才出现「以管理员身份打开」。切回搜索类整块消失。
 *   B. 保存校验：勾了开关却没选应用 / 选了不存在的应用 → 当场报错。
 *   C. 落库：三件套真的进了 config.json（且只有快捷键类带得上）。
 *   D. 运行时「应用已经在跑」：绑到自己（QuickSearch.exe）→ 日志说 已在运行=true、
 *      窗口=true、按键已发送。
 *   E. 运行时「应用没在跑」：绑到 whoami.exe（跑一下就自己退出，零副作用）
 *      → 日志说 已在运行=false、已拉起、然后就绪检查完成。
 *
 * ⚠ 这一轮会真的发一次 F24 到当前前台窗口。F24 在 Windows 上几乎没有任何
 *   默认行为，选它是为了"验到了按键真的发出去了，又不会误触任何东西"。
 * ⚠ 不会去拉起 notepad / 浏览器这类会留窗口的东西：E 组用 whoami.exe，
 *   它打印一行就退出，不留痕迹，也不需要事后清理。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r58-probe.txt');
const PORT = 9403;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
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
const readLog = (tmp) => {
    try { return fs.readFileSync(path.join(tmp, 'QuickSearch', 'log.txt'), 'utf8'); } catch (e) { return ''; }
};
/** 某个元素此刻是不是"看得见"（hidden 属性 + 计算样式都算）。 */
const vis = (sel) => `(function(){
    var e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return 'missing';
    if (e.hidden) return false;
    var s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return true;
})()`;

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r58-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        bar_list: [],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r58' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r58 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页连不上'); flush(); process.exit(1); }

    await ev(ws, `document.querySelector('#tabs button[data-tab="engines"]').click()`);
    await sleep(900);

    /* ================= A. 表单联动 ================= */
    rec('');
    rec('--- A. 设置页表单联动 ---');

    // 用「网页引擎」这种方式进来（这样类型分段是可见的，能切 hotkey/search）
    await ev(ws, `document.querySelector('.addway[data-way="web"]').click()`);
    await sleep(500);
    await ev(ws, `document.querySelector('#s-ceKind button[data-v="hotkey"]').click()`);
    await sleep(500);

    check('A1 选「快捷键」类型 → 「绑定应用」整块出现', (await ev(ws, vis('#ceBindRow'))) === true,
        String(await ev(ws, vis('#ceBindRow'))));
    check('A2 还没勾开关时，「选应用」那一行不出现', (await ev(ws, vis('#ceBindPathRow'))) === false);
    check('A3 还没选应用时，「管理员」那一行不出现', (await ev(ws, vis('#ceBindAdminRow'))) === false);

    // 勾上开关
    await ev(ws, `(function(){
        var c = document.getElementById('w-ceBindApp');
        c.checked = true;
        c.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
    })()`);
    await sleep(400);
    check('A4 勾上「先确保这个应用在运行」→ 「选应用」那一行出现',
        (await ev(ws, vis('#ceBindPathRow'))) === true);
    check('A5 勾了但还没选应用时，「管理员」仍然不出现（没意义的组合不显示）',
        (await ev(ws, vis('#ceBindAdminRow'))) === false);

    /* ⚠ 绝对**不能**真的点 #btnCePickApp：它会弹原生文件对话框，把整个进程
     *   挂在那儿（r56 就栽过一次，探针跑了 300 秒被杀）。这里只把输入框的
     *   值填上，再手动触发一次联动 —— 和"用户选完之后"的状态完全一致。 */
    await ev(ws, `(function(){
        var p = document.getElementById('w-ceAppPath');
        p.value = ${JSON.stringify(EXE)};
        p.dispatchEvent(new Event('input', { bubbles: true }));
        p.dispatchEvent(new Event('change', { bubbles: true }));
        // 触发一次联动（等价于选完应用后的状态）
        var c = document.getElementById('w-ceBindApp');
        c.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
    })()`);
    await sleep(400);
    const alive = await ev(ws, `1+1`);
    check('A6 页面还活着（没有去点那个会弹原生对话框的「选择…」）', Number(alive) === 2, String(alive));
    check('A7 选好应用之后，「以管理员身份打开」那一行才出现',
        (await ev(ws, vis('#ceBindAdminRow'))) === true);

    // 切回搜索类 → 整块消失
    await ev(ws, `document.querySelector('#s-ceKind button[data-v="search"]').click()`);
    await sleep(400);
    check('A8 切回「搜索」类 → 「绑定应用」整块消失（搜索类没有发按键这回事）',
        (await ev(ws, vis('#ceBindRow'))) === false);

    /* ================= B. 保存校验 ================= */
    rec('');
    rec('--- B. 保存校验 ---');
    const noPath = await ev(ws, `(async function(){
        try { await window.__TAURI__.core.invoke('add_custom_engine', {
            name: '没选应用的键', url: '', category: '', kind: 'hotkey', hotkey: 'f24',
            bindApp: true, appPath: '', appAdmin: false }); return 'OK'; }
        catch (e) { return String(e); }
    })()`);
    rec('勾了开关但没选应用 → ' + noPath);
    check('B1 勾了「先确保应用在运行」却没选应用 → 保存被拒，并说清原因',
        String(noPath).indexOf('选一个应用') >= 0, String(noPath));

    const badPath = await ev(ws, `(async function(){
        try { await window.__TAURI__.core.invoke('add_custom_engine', {
            name: '路径不存在的键', url: '', category: '', kind: 'hotkey', hotkey: 'f24',
            bindApp: true, appPath: 'C:\\\\definitely\\\\not\\\\here-qs\\\\app.exe', appAdmin: false }); return 'OK'; }
        catch (e) { return String(e); }
    })()`);
    rec('应用路径不存在 → ' + badPath);
    check('B2 选了不存在的应用 → 保存被拒', String(badPath).indexOf('找不到这个应用') >= 0, String(badPath));

    /* ================= C. 落库 ================= */
    rec('');
    rec('--- C. 落库 ---');
    const addOk = await ev(ws, `(async function(){
        try { await window.__TAURI__.core.invoke('add_custom_engine', {
            name: '绑自己', url: '', category: '', kind: 'hotkey', hotkey: 'f24',
            bindApp: true, appPath: ${JSON.stringify(EXE)}, appAdmin: true }); return 'OK'; }
        catch (e) { return String(e); }
    })()`);
    check('C1 合法的绑定应用引擎能存进去', String(addOk) === 'OK', String(addOk));

    // 非快捷键类即使传了也要被清掉
    await ev(ws, `window.__TAURI__.core.invoke('add_custom_engine', {
        name: '搜索类不该带', url: 'https://x/?q=%s', category: '', kind: 'search', hotkey: '',
        bindApp: true, appPath: ${JSON.stringify(EXE)}, appAdmin: true }).catch(()=>{})`);
    await sleep(1200);

    const cfg = await ev(ws, `(async function(){
        var c = await window.__TAURI__.core.invoke('get_config');
        return JSON.stringify((c.customEngines||[]).map(function(e){
            return { name: e.name, kind: e.kind, hotkey: e.hotkey,
                     bind_app: e.bind_app, app_path: e.app_path, app_admin: e.app_admin };
        }));
    })()`);
    let ces = [];
    try { ces = JSON.parse(cfg); } catch (e) { }
    rec('customEngines = ' + cfg);
    const hot = ces.find((e) => e.name === '绑自己') || {};
    check('C2 快捷键类：bind_app / app_path / app_admin 三件套都落库了',
        hot.bind_app === true && hot.app_path === EXE && hot.app_admin === true, JSON.stringify(hot));
    const search = ces.find((e) => e.name === '搜索类不该带') || {};
    check('C3 搜索类：三件套被强制清空（不许脏数据活过来）',
        search.bind_app === false && search.app_path === '' && search.app_admin === false,
        JSON.stringify(search));
    // 落盘文件里也要在（不是只在内存）
    let onDisk = {};
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8'));
        onDisk = (raw.custom_engines || []).find((e) => e.name === '绑自己') || {};
    } catch (e) { }
    check('C4 config.json 里也真的写进去了（不是只在内存）',
        onDisk.bind_app === true && onDisk.app_path === EXE, JSON.stringify(onDisk));

    /* ================= D. 运行时：应用已经在跑 ================= */
    rec('');
    rec('--- D. 运行时：应用已经在跑 ---');
    let logBefore = readLog(tmp).length;
    await ev(ws, `window.__TAURI__.core.invoke('open_search', { engine: '绑自己', text: 'x' }).catch(()=>{})`);
    await sleep(6000);
    let newLog = readLog(tmp).slice(logBefore);
    rec('新增日志：\n' + newLog.split('\n').filter((l) => l.indexOf('open_search') >= 0).join('\n'));
    check('D1 日志说「已在运行=true」（真的去查了进程）', /绑定应用 QuickSearch\.exe 已在运行=true/.test(newLog), newLog.slice(-400));
    check('D2 找到了它的窗口（就绪检查 窗口=true）', /就绪检查完成，窗口=true/.test(newLog));
    check('D3 按键真的发出去了（模拟按键 f24 已发送）', /模拟按键 f24 -> 已发送/.test(newLog));

    /* ================= E. 运行时：应用没在跑 → 先拉起 ================= */
    rec('');
    rec('--- E. 运行时：应用没在跑 → 先拉起 ---');
    const who = 'C:\\Windows\\System32\\whoami.exe';
    const add2 = await ev(ws, `(async function(){
        try { await window.__TAURI__.core.invoke('add_custom_engine', {
            name: '绑whoami', url: '', category: '', kind: 'hotkey', hotkey: 'f24',
            bindApp: true, appPath: ${JSON.stringify(who)}, appAdmin: false }); return 'OK'; }
        catch (e) { return String(e); }
    })()`);
    check('E0 whoami.exe 能作为绑定目标存进去（前置条件）', String(add2) === 'OK', String(add2));

    logBefore = readLog(tmp).length;
    await ev(ws, `window.__TAURI__.core.invoke('open_search', { engine: '绑whoami', text: 'x' }).catch(()=>{})`);
    // whoami 跑完就退出，等它走完"拉起 + 等就绪"那一段（wait_app_ready 上限 15s）
    await sleep(20000);
    newLog = readLog(tmp).slice(logBefore);
    rec('新增日志：\n' + newLog.split('\n').filter((l) => l.indexOf('open_search') >= 0).join('\n'));
    check('E1 日志说「已在运行=false」（先确认了它没开）',
        /绑定应用 whoami\.exe 已在运行=false/.test(newLog), newLog.slice(-400));
    check('E2 日志说「已拉起 whoami.exe」（没开就先打开）', /已拉起 whoami\.exe/.test(newLog));
    check('E3 拉起之后仍然走完了就绪检查（不卡死）', /就绪检查完成/.test(newLog));
    check('E4 最后按键照样发出去了（先开应用、再实行快捷键）', /模拟按键 f24 -> 已发送/.test(newLog));

    rec('');
    rec('========== r58 快捷键绑定应用：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
