/* r60 探针：快捷键「绑定应用」拉起之后，热键到底有没有生效？
 *
 * 用户原话：「如果那个应用没有打开，我点击横条当中的该应用的快捷键，确实会把该
 * 应用打开，但是却不能够触发快捷键相应的功能。」
 *
 * 这条不能只看日志说"已发送"—— 发出去不等于对方收到了。所以设计成一个**闭环**：
 *
 *   1. 绑定 charmap.exe，热键设成 **alt+f4**（对控制台窗口就是"关闭"）；
 *   2. 第一次点：cmd 没开 → 拉起 → 等它就绪 → 抢焦点 → 发 alt+f4；
 *   3. 如果热键**真的送达**，cmd 窗口会被关掉、进程退出；
 *   4. 再点第二次：日志必须再次出现「已在运行=false」——
 *      说明它真的被关掉了，也就反证第一次的热键确实打到了它身上。
 *
 * 如果热键没生效，第二次会读到「已在运行=true」，这条测试就红。
 * 这比"日志里写了已发送"强得多 —— 用户报的正是"发了但没生效"。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r60-probe.txt');
const PORT = 9407;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
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
const readLog = (tmp) => { try { return fs.readFileSync(path.join(tmp, 'QuickSearch', 'log.txt'), 'utf8'); } catch (e) { return ''; } };

const CMD = 'C:\\Windows\\System32\\charmap.exe';

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r60-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, bar_list: [] }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r60' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r60 探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页连不上'); flush(); process.exit(1); }

    /* ---- 建一条绑定了 cmd.exe 的快捷键引擎，热键 alt+f4 ---- */
    const add = await ev(ws, `(async function(){
        try { await window.__TAURI__.core.invoke('add_custom_engine', {
            name: '关字符映射', url: '', category: '', kind: 'hotkey', hotkey: 'alt+f4',
            bindApp: true, appPath: ${JSON.stringify(CMD)}, appAdmin: false }); return 'OK'; }
        catch (e) { return String(e); }
    })()`);
    check('R1 绑定 charmap.exe 的快捷键引擎建好了（热键 alt+f4）', String(add) === 'OK', String(add));

    /* ---- 第一次点：cmd 没开 → 应该拉起 → 等就绪 → 发 alt+f4 ---- */
    rec('');
    rec('--- 第一次点（cmd 没开）---');
    let before = readLog(tmp).length;
    await ev(ws, `window.__TAURI__.core.invoke('open_search', { engine: '关字符映射', text: 'x' }).catch(()=>{})`);
    // 拉起 + 等窗口 + 900ms 初始化 + 抢焦点重试 + 发键，给足 25 秒
    await sleep(25000);
    let log1 = readLog(tmp).slice(before);
    const lines1 = log1.split('\n').filter((l) => l.indexOf('open_search') >= 0);
    rec(lines1.join('\n'));

    check('R2 先确认了它没在跑（已在运行=false）', /绑定应用 charmap\.exe 已在运行=false/.test(log1), log1.slice(-400));
    check('R3 确实拉起了它（已拉起 charmap.exe）', /已拉起 charmap\.exe/.test(log1));
    check('R4 拉起之后**多等了一拍让它初始化**（新拉起的，再等 900ms）',
        /是新拉起的，再等 900ms/.test(log1), log1.slice(-600));
    check('R5 等到了它的窗口（就绪检查完成，窗口=true）', /就绪检查完成，窗口=true/.test(log1));
    check('R6 热键发出去了（模拟按键 alt+f4 -> 已发送）', /模拟按键 alt\+f4 -> 已发送/.test(log1));
    check('R7 焦点抢到了目标窗口上（不是「发给当前前台」）',
        /投向=目标窗口 0x[0-9a-f]+/.test(log1),
        (log1.match(/投向=[^\n]*/g) || []).join(' | '));

    /* ---- 第二次点：如果 alt+f4 真的送达，cmd 已经被关掉，应当再次「已在运行=false」 ---- */
    rec('');
    rec('--- 第二次点（验证上一次的 alt+f4 是否真的生效）---');
    before = readLog(tmp).length;
    await ev(ws, `window.__TAURI__.core.invoke('open_search', { engine: '关字符映射', text: 'x' }).catch(()=>{})`);
    await sleep(20000);
    const log2 = readLog(tmp).slice(before);
    const again = /绑定应用 charmap\.exe 已在运行=false/.test(log2);
    const stillRunning = /绑定应用 charmap\.exe 已在运行=true/.test(log2);
    rec(log2.split('\n').filter((l) => l.indexOf('已在运行') >= 0 || l.indexOf('模拟按键') >= 0).join('\n'));
    check('R8 **上一轮的 alt+f4 真的送达了**（charmap 已被关掉 → 这次又读到「已在运行=false」）',
        again && !stillRunning, stillRunning ? 'charmap 还在跑，说明热键没生效' : log2.slice(-300));

    rec('');
    rec('========== r60：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
