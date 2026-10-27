/* ============================================================================
 *  「快捷键类引擎不再冻住主线程」真机取证（v1.5.18）
 *
 *  `open_search` 是**同步命令**（跑在主线程）。它的快捷键分支里有一串等待：
 *  等应用建窗（最多 20 秒）、拉起后再等 `app_launch_delay`、抢焦点最多 10×120ms。
 *  以前这些都压在命令栈里 —— 用户点一下，整个软件冻住一两秒（横条不收、
 *  托盘没响应、翻译窗里正在流的字也停）。
 *
 *  修法：整段搬进 `fire_hotkey_engine`，命令只负责 spawn。
 *
 *  这里用**隔离实例自己**当那个「绑定应用」（不牵扯任何外部软件）：
 *    · `app_running(QuickSearch.exe)` = true（就是自己），不会真的再拉一个；
 *    · 但 `app_bring_front: true` 会让它走**抢焦点重试**那条路（最多 1.2 秒）——
 *      正是我们要量的那段。
 *
 *  判据：`open_search` 必须在 **500ms 内**返回（改之前是 1200ms 起步）。
 *
 *  用法：node tools/hotkey-nonblock-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? process.env.QS_E2E_EXE
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const CDP_PORT = 9355;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + CDP_PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let FAILED = 0;
function ok(cond, name, extra) {
    if (!cond) FAILED++;
    console.log((cond ? 'OK  ' : 'NO  ') + name + (extra ? ' → ' + extra : ''));
}

let msgId = 0;
function cdp(ws, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const timer = setTimeout(() => {
            ws.removeEventListener('message', onMsg);
            reject(new Error('CDP 超时: ' + method));
        }, timeoutMs || 30000);
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
}
async function evalJs(ws, expr, timeoutMs) {
    const r = await cdp(ws, 'Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function connect(sub, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
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
        await sleep(250);
    }
    return null;
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-hotkey-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });

    const conf = {
        trans_enable: true,
        bar_list: ['HK', '@trans'], bar_idle_sec: 0, bar_away_px: 0,
        shadow: false, bar_need_text: false,
        custom_engines: [{
            name: 'HK',
            url: '',
            category: '',
            kind: 'hotkey',
            hotkey: 'f24',
            bind_app: true,
            // ★ 绑到"自己"：已经在跑（不会真拉第二个实例），
            //   但 bring_front=true 会走抢焦点重试那条路（最多 10×120ms）
            app_path: EXE,
            app_admin: false,
            app_launch_delay: 0,
            app_bring_front: true,
        }],
    };
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(conf, null, 2), 'utf8');

    const env = Object.assign({}, process.env, {
        QS_DATA_DIR: qs,
        APPDATA: tmp, LOCALAPPDATA: tmp,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_INSTANCE_TAG: '-probe-hotkey', QS_T_WV_ARGS: WV_ARGS, QS_NO_ELEVATE: '1',
        QS_LOG: '1',   // 用来验证"后台线程真的把整套流程跑完了"，而不只是"命令返回得快"
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env: env, cwd: ROOT, detached: false, stdio: 'ignore' });
    console.log('隔离实例 PID=' + proc.pid);

    const bail = (msg) => {
        console.log(msg);
        try { proc.kill(); } catch (e) { }
        process.exit(1);
    };

    const ws = await connect('tauri.localhost/');
    if (!ws) bail('CDP 连不上');
    await sleep(1500);

    // 先确认引擎真的被认成"快捷键类 + 绑了应用"（否则量到的等待是假的）
    const info = await evalJs(ws, `(function(){
        return window.__TAURI__.core.invoke('get_config').then(function(c){
            var e = (c.customEngines || []).filter(function(x){ return x.name === 'HK'; })[0];
            // ⚠ get_config 给的是 Rust 结构体的**原样**序列化，字段是 snake_case
            return e ? { kind: e.kind, bind: e.bind_app, path: e.app_path,
                         bring: e.app_bring_front, hotkey: e.hotkey } : null;
        });
    })()`);
    console.log('引擎：' + JSON.stringify(info));
    ok(!!info && info.kind === 'hotkey' && info.bind === true && !!info.path,
        '隔离实例里的 HK 是"绑了应用"的快捷键引擎', JSON.stringify(info));
    ok(!!info && info.bring === true,
        '  并且开着「把目标窗口调到前台」（才会走抢焦点重试那段）', String(info && info.bring));

    // 量一次命令耗时（同步命令本身）
    const t = await evalJs(ws, `(function(){
        var t0 = performance.now();
        return window.__TAURI__.core.invoke('open_search', { engine: 'HK' })
            .then(function(){ return Math.round(performance.now() - t0); },
                  function(e){ return 'ERR:' + e; });
    })()`, 20000);
    console.log('open_search 返回耗时：' + t + 'ms');
    ok(typeof t === 'number', 'open_search 正常返回（没报错）', String(t));
    ok(typeof t === 'number' && t < 500,
        '命令在 500ms 内返回（整段等待已在后台线程）', t + 'ms');

    // 再确认：返回之后主线程仍然能响应别的命令（真要冻住了这里会超时）
    const t2 = await evalJs(ws, `(function(){
        var t0 = performance.now();
        return window.__TAURI__.core.invoke('app_is_locked')
            .then(function(v){ return { ms: Math.round(performance.now() - t0), v: v }; });
    })()`, 20000);
    console.log('随后的 app_is_locked：' + JSON.stringify(t2));
    ok(!!t2 && t2.ms < 1000, '紧接着的命令依然立刻响应（主线程没被占）', JSON.stringify(t2));

    /* 关键一条：命令"返回得快"必须是因为**活挪到了后台**，而不是"根本没干"。
     * 抓隔离实例自己的 log.txt，看抢焦点/发键那几行有没有出现。 */
    await sleep(2000);
    let logTxt = '';
    try { logTxt = fs.readFileSync(path.join(qs, 'log.txt'), 'utf8'); } catch (e) { }
    const ranBind = logTxt.indexOf('open_search: HK 绑定应用') >= 0;
    const ranKey = logTxt.indexOf('模拟按键 f24') >= 0;
    console.log('日志里：绑定应用=' + ranBind + '  发键=' + ranKey);
    ok(ranBind, '后台线程真的走了「查应用在不在跑」那一步');
    ok(ranKey, '后台线程真的把键发出来了（活没丢）');

    try { proc.kill(); } catch (e) { }
    await sleep(300);
    console.log(FAILED ? ('\n❌ ' + FAILED + ' 项失败') : '\n✅ 全部通过');
    process.exit(FAILED ? 1 : 0);
})();
