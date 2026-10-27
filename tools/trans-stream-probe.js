/* ============================================================================
 *  翻译「流式」真机取证（v1.5.18）
 *
 *  用户要求：翻译要**明显更快**，不要点完之后干等一个空框。
 *
 *  jsdom 只能证明「前端会处理增量事件」，证明不了「Rust 真的在流式发、界面
 *  真的在一点点长出来」。这里起一个**本地 SSE 服务**当翻译后端（不联网、不花
 *  额度），让隔离实例真的走一遍：
 *
 *      trans_start → 建窗 → 页面 boot → trans_run → 本地 SSE 逐段吐字
 *                  → qs://trans-chunk → 译文框一点点变长
 *
 *  判据：
 *    ① 请求体里 `stream` 必须是 true（不是让前端假装流）；
 *    ② 译文框要出现**中间态**（至少两个不同的值）—— 说明字是渐渐长出来的；
 *    ③ 最后的总值必须一个字不差（流式不能把内容拼错）；
 *    ④ 首字出现要明显早于整体结束（这就是"卡顿感消失"的量化版本）。
 *
 *  用法：node tools/trans-stream-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? process.env.QS_E2E_EXE
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const CDP_PORT = 9354;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + CDP_PORT;

/** 本地仿真后端吐出来的译文（拆成若干段，每段之间停一下）。 */
const PIECES = ['流', '式', '翻', '译', '真', '的', '很', '快', '，', '不', '用', '等'];
const GAP_MS = 220;
const TOTAL_MS = PIECES.length * GAP_MS;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let FAILED = 0;
function ok(cond, name, extra) {
    if (!cond) FAILED++;
    console.log((cond ? 'OK  ' : 'NO  ') + name + (extra ? ' → ' + extra : ''));
}

/* ------------------------------ 仿真后端 ------------------------------ */

let sawStreamFlag = null;
let reqCount = 0;

function startFakeBackend() {
    const srv = http.createServer((req, res) => {
        if (!req.url.includes('/chat/completions')) {
            res.writeHead(404).end('nope');
            return;
        }
        reqCount++;
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch (e) { /* 忽略 */ }
            // 只记第一轮的，便于断言
            if (sawStreamFlag === null) sawStreamFlag = body.stream === true;

            // 不是流式就回一整段 JSON（模拟"网关不吃 stream"那条回落路径）
            if (!body.stream) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: PIECES.join('') } }] }));
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            let i = 0;
            const tick = () => {
                if (i >= PIECES.length) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                res.write('data: ' + JSON.stringify({
                    choices: [{ delta: { content: PIECES[i] } }],
                }) + '\n\n');
                i++;
                setTimeout(tick, GAP_MS);
            };
            // 第一段也稍微等一下，模拟"模型想一下才吐第一个字"
            setTimeout(tick, GAP_MS);
        });
    });
    return new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

/* ------------------------------ CDP 小工具 ------------------------------ */

let msgId = 0;
function cdp(ws, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const timer = setTimeout(() => {
            ws.removeEventListener('message', onMsg);
            reject(new Error('CDP 超时: ' + method));
        }, timeoutMs || 15000);
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
async function evalJs(ws, expr, timeoutMs) {
    const r = await cdp(ws, 'Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function listTargets() {
    const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
    return r.json();
}
async function connect(sub, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 30000)) {
        try {
            const ts = await listTargets();
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

/* --------------------------------- 主流程 -------------------------------- */

(async function main() {
    const { srv, port } = await startFakeBackend();
    console.log('仿真后端 http://127.0.0.1:' + port + '/v1（每段间隔 ' + GAP_MS + 'ms，共 '
        + PIECES.length + ' 段 ≈ ' + TOTAL_MS + 'ms）');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-transstream-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const conf = {
        trans_enable: true,
        trans_engine: 'deepseek',
        trans_multi: [],
        trans_keys: { deepseek: 'sk-probe' },
        // ★ 把这一家的接口地址指到本地仿真后端 —— 整条链路走真 HTTP
        trans_bases: { deepseek: 'http://127.0.0.1:' + port + '/v1' },
        trans_target: 'zh',
        bar_list: ['@trans'], bar_idle_sec: 0, bar_away_px: 0,
        shadow: false, bar_need_text: false,
    };
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(conf, null, 2), 'utf8');

    const env = Object.assign({}, process.env, {
        QS_DATA_DIR: qs,
        APPDATA: tmp, LOCALAPPDATA: tmp,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_INSTANCE_TAG: '-probe-transstream', QS_T_WV_ARGS: WV_ARGS, QS_NO_ELEVATE: '1',
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    console.log('隔离实例 PID=' + proc.pid);

    const bail = (msg) => {
        console.log(msg);
        try { proc.kill(); } catch (e) { }
        try { srv.close(); } catch (e) { }
        process.exit(1);
    };

    let ws = await connect('tauri.localhost/');
    if (!ws) bail('CDP 连不上主窗');
    await sleep(1500);

    // 走「横条点翻译」那条真实路径
    const t0 = Date.now();
    await evalJs(ws, "(function(){ return window.__TAURI__.core.invoke('trans_start', { text: 'Hello' }); })()", 10000)
        .catch((e) => console.log('trans_start 异常：' + e.message));

    ws = await connect('trans.html', 15000);
    if (!ws) bail('翻译窗没开出来');
    const tWin = Date.now();
    console.log('翻译窗 CDP 已连上（+%dms）', tWin - t0);

    // 每 120ms 采一次样，记录"译文框第一次非空"和中间态
    const samples = [];
    let firstNonEmpty = 0;
    let finalText = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        let v = null;
        try {
            v = await evalJs(ws, `(function(){
                var ta = document.querySelector('.tp textarea');
                var st = document.querySelector('.tp .tp-st');
                return { t: ta ? ta.value : null, st: st ? st.textContent : '' };
            })()`);
        } catch (e) { }
        if (v && v.t !== null) {
            if (v.t && !firstNonEmpty) firstNonEmpty = Date.now() - t0;
            if (samples.length === 0 || samples[samples.length - 1] !== v.t) samples.push(v.t);
            finalText = v.t;
            if (v.st === '已完成') break;
        }
        await sleep(120);
    }
    const tDone = Date.now() - t0;

    const nonEmptyStates = samples.filter((s) => s && s.length > 0 && s !== finalText);
    console.log('采样到的中间态：' + JSON.stringify(samples.slice(0, 8)));
    console.log('首字 +' + firstNonEmpty + 'ms，收尾 +' + tDone + 'ms，最终长度 ' + finalText.length);

    ok(sawStreamFlag === true, '请求体里 stream=true（真流式，不是前端假装）', String(sawStreamFlag));
    ok(reqCount === 1, '只发了一次请求（没因为重试重复翻）', 'reqCount=' + reqCount);
    ok(finalText === PIECES.join(''), '译文一个字不差', JSON.stringify(finalText));
    ok(nonEmptyStates.length >= 2, '译文框出现过多个中间态（字是一点点长出来的）',
        '中间态 ' + nonEmptyStates.length + ' 个');
    ok(firstNonEmpty > 0 && firstNonEmpty < TOTAL_MS * 0.6,
        '首字明显早于整体结束',
        '首字 ' + firstNonEmpty + 'ms vs 全程 ' + TOTAL_MS + 'ms');
    ok(tDone >= TOTAL_MS * 0.8, '整体耗时符合预期（不是把整段一次塞进来）',
        tDone + 'ms');

    try { proc.kill(); } catch (e) { }
    try { srv.close(); } catch (e) { }
    await sleep(300);

    console.log(FAILED ? ('\n❌ ' + FAILED + ' 项失败') : '\n✅ 全部通过');
    process.exit(FAILED ? 1 : 0);
})();
