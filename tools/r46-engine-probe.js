/* ============================================================================
 *  r46：OCR 引擎"真的用上了吗 / 真连得上吗 / 调的是哪个模型"（需求 1·3·4）
 *
 *  用户报的三件事（原话）：
 *    ①「选择了非本地和百度 ocr 之外的引擎，但最后点击 OCR 之后调用的还是本地
 *       或者百度的，就相当于添加了，但没用上」
 *    ②「本地 ocr 的环境检测，默认得是折叠住的……我没点击，他就不用告诉我说
 *       是否已准备就绪」
 *    ③「类似于硅基流动 kimi 等之类的其他的 ocr 的方式，你得留一个测试按钮，
 *       就是填完 apikey 之后，点击测试就能够确定是否真的连接上」
 *    ④「如果是调用 ai……那这时候是不是应该添加一个选择模型的功能呢？」
 *
 *  这个探针故意**不依赖任何厂商的 Key**：起一个本地假服务器当"OpenAI 兼容的
 *  那家"，把 base_url 指过去。这样"引擎有没有真的被调用"变成一件**可观测**的
 *  事 —— 假服务器收到的请求就是铁证，而不是靠读代码猜。
 *
 *  ⚠ 隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG），不碰用户正在
 *    用的配置，也不会 taskkill 掉用户开着的实例。
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const TAG = 'r46eng';
const DIR = path.join(os.tmpdir(), 'qs-r46-' + process.pid);
fs.rmSync(DIR, { recursive: true, force: true });
const QS = path.join(DIR, 'QuickSearch');
fs.mkdirSync(QS, { recursive: true });
const CFG = path.join(QS, 'config.json');

const API_PORT = 9477;           // 假"在线 OCR 服务"的端口
const CDP_PORT = 9426;           // 被探针驱动的实例的调试端口
const API = 'http://127.0.0.1:' + API_PORT + '/v1';
const FAKE_TEXT = '假服务器认出来的字';

fs.writeFileSync(CFG, JSON.stringify({
    debug: true,
    ocr_enable: true,
    // ① 配的就是**自定义（OpenAI 兼容）**这一家，base 指向本地假服务器。
    //    只要"点击 OCR 走的是这一家"，假服务器就一定会收到请求。
    ocr_engine: 'custom',
    ocr_parallel: false,
    ocr_accurate: false,
    ocr_lang: 'CHN_ENG',
    trigger_select: false,
    trigger_copy: false,
    auto_start: false,
    auto_elevate: false,
    theme: 'light',
    ocr_keys: { custom: 'probe-key-123' },
    ocr_bases: { custom: API },
    ocr_models: { custom: 'probe-vl-model' },
}, null, 1), 'utf8');

const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, total = 0;
const ok = (name, cond, extra) => {
    total++;
    if (cond) pass++;
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '\n        ' + (extra || '')));
};

/* ---------------- 本地假 OpenAI 兼容服务 ---------------- */
const hits = [];        // 收到的每一个请求
let mode = 'ok';        // ok | 403
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        hits.push({
            method: req.method,
            path: req.url,
            auth: req.headers['authorization'] || '',
            body,
        });
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                data: [
                    { id: 'bge-m3' },
                    { id: 'probe-vl-model' },
                    { id: 'Qwen/Qwen2.5-VL-32B-Instruct' },
                ],
            }));
            return;
        }
        if (mode === '403') {
            // 用户实际踩到的就是这一类：HTTP 403 + 响应体里写着真正的原因。
            // 以前代码只回 "403（Forbidden）"，把这句话整个丢掉。
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '余额不足，请充值' } }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: FAKE_TEXT } }] }));
    });
});

/* ---------------- CDP 小工具（r37/r44/r45 同一套） ---------------- */
let wsId = 0;
const pend = new Map();
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        pend.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
function wire(ws) {
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && pend.has(m.id)) {
            const q = pend.get(m.id);
            pend.delete(m.id);
            if (m.error) q.reject(new Error(m.error.message || 'cdp'));
            else q.resolve(m.result);
        }
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('JS: ' + String(expr).slice(0, 140));
    return r.result.value;
}
async function findPage(re, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && re.test(t.url || ''));
            if (hit) {
                const ws = new WebSocket(hit.webSocketDebuggerUrl);
                await new Promise((res, rej) => {
                    ws.addEventListener('open', res, { once: true });
                    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
                });
                wire(ws);
                return ws;
            }
        } catch (e) { }
        await asleep(300);
    }
    return null;
}
async function waitReady(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
        try { if (await evalJs(ws, expr)) return true; } catch (e) { }
        await asleep(250);
    }
    return false;
}
/** 等假服务器收到一条满足条件的请求。 */
async function waitHit(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
        const h = hits.find(pred);
        if (h) return h;
        await asleep(200);
    }
    return null;
}

(async () => {
    await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));
    console.log('假 OCR 服务已起在 ' + API);

    const env = Object.assign({}, process.env, {
        APPDATA: DIR,
        LOCALAPPDATA: DIR,
        WEBVIEW2_USER_DATA_FOLDER: path.join(DIR, 'wv2-' + TAG),
        QS_DEBUG: '1',
        QS_INSTANCE_TAG: TAG,
        QS_ALLOW_INJECTED: '1',
        QS_T_WV_ARGS: '--remote-debugging-port=' + CDP_PORT,
    });
    console.log('启动隔离实例（APPDATA=' + DIR + '）');
    const p = spawn(EXE, ['--no-elevate', '--settings'],
        { env, cwd: ROOT, detached: false, stdio: 'ignore' });

    const sw = await findPage(/settings\.html/);
    ok('R1 连上了设置页', !!sw, 'CDP 列表里没有 settings.html');
    if (!sw) return;
    const bootOk = await waitReady(sw,
        "typeof CONF === 'object' && !!document.querySelector('#w-ocrEngList .eng-row')");
    ok('R2 设置页 JS 跑完、引擎列表渲染出来', bootOk);

    /* ============ ② 环境检测默认折叠：不点就不查、不说 ============ */
    const folded = await evalJs(sw, `(() => {
        const box = document.getElementById('w-ocrDep');
        return {
            items: box.querySelectorAll('.dep-item').length,
            banner: box.querySelectorAll('.dep-banner').length,
            text: box.textContent.trim().slice(0, 60),
            btn: !!box.querySelector('button[data-act="check"]'),
        };
    })()`);
    ok('R3 进页面时环境检测是**折叠态**：没有检测结果、没有"就绪/不就绪"结论',
        !!folded && folded.items === 0 && folded.banner === 0,
        JSON.stringify(folded));
    ok('R4 折叠态给了一颗「检测本地 OCR 环境」按钮（用户点它才查）',
        !!folded && folded.btn === true, JSON.stringify(folded));

    const clicked = await evalJs(sw,
        "(() => { const b = document.querySelector('#w-ocrDep button[data-act=\"check\"]');"
        + " if (!b) return false; b.click(); return true; })()");
    const ran = await waitReady(sw, "document.querySelectorAll('#w-ocrDep .dep-item').length === 3", 15000);
    ok('R5 点了按钮才真去检测（三项组件卡片出现）', clicked && ran,
        'clicked=' + clicked + ' ran=' + ran);

    /* ============ ① 配的那家真的会被调用（假服务器收到请求） ============ */
    ok('R6 光是打开设置页，后端**不会**去连任何 OCR 厂商（没有偷偷联网）',
        hits.length === 0, JSON.stringify(hits.map((h) => h.path)));

    // 直接调 ocr_region —— 这正是"点 OCR 框选完"那一刻后端收到的命令。
    // 它内部会截图 + 按**设置里配的引擎**识别；配的是 custom（指向假服务器），
    // 所以假服务器收到请求 == 配置的引擎真的被用上了。
    const shot = await evalJs(sw, "invoke('ocr_region', { x: 40, y: 40, w: 320, h: 120, dpr: 1 })"
        + ".then(() => 'ok').catch((e) => 'err:' + e)");
    const sz = await waitHit((h) => h.path.indexOf('/chat/completions') >= 0, 25000);
    ok('R7 点 OCR（ocr_region）之后，请求打到了**设置里配的那家**（假服务器收到了）',
        !!sz, 'ocr_region=' + shot + ' hits=' + JSON.stringify(hits.map((h) => h.path)));

    const body = sz ? sz.body : '{}';
    const req = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
    ok('R8 请求里带的是**这一家的** Key（Authorization: Bearer probe-key-123）',
        !!sz && sz.auth === 'Bearer probe-key-123', sz && sz.auth);
    ok('R9 请求里带的是**配的那个模型名**（probe-vl-model，不是写死的别的）',
        req.model === 'probe-vl-model', JSON.stringify(req.model));
    // ⚠ 这条不能写死"必须是 image/png"：框选那条路编的是 **JPEG**（省几百毫秒），
    //   所以正确的断言是"声明的格式 == 真实字节的格式"。以前代码把它写死成
    //   image/png，等于把一张 JPEG 谎称成 PNG —— 严格的网关会直接 400/415。
    const mm = body.match(/"url"\s*:\s*"data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)"/);
    let mimeOk = false;
    let mimeSeen = '(没找到 data URL)';
    if (mm) {
        const declared = mm[1];
        const buf = Buffer.from(mm[2].slice(0, 32), 'base64');
        const real = (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ? 'image/jpeg'
            : (buf.slice(0, 8).toString('binary') === '\x89PNG\r\n\x1a\n') ? 'image/png'
                : '认不出来';
        mimeSeen = '声明=' + declared + ' 实际=' + real;
        mimeOk = real !== '认不出来' && declared === real;
    }
    ok('R10 声明的图片格式与真实字节一致（截图那条路是 JPEG，就不能再谎称 PNG）',
        mimeOk, mimeSeen);

    // 结果窗里显示的应该是假服务器返回的文字 —— 端到端证据：跑出来的就是配的那家。
    // （结果窗是独立窗口，要单独 attach；正文可能在 <textarea> 里，所以两边都看。）
    const ow = await findPage(/ocr\.html/, 15000);
    const probeText = "(() => { const t = document.body.innerText || '';"
        + " const v = [...document.querySelectorAll('textarea,input')].map((e) => e.value).join(' ');"
        + " return (t + ' ' + v).indexOf('" + FAKE_TEXT + "') >= 0; })()";
    const gotText = ow ? await waitReady(ow, probeText, 12000) : false;
    ok('R11 结果窗里显示的确实是那家返回的文字（端到端：配的那家跑出来了）',
        gotText === true, ow ? '结果窗里没有假服务器的文字' : '没等到结果窗');
    if (ow) { try { ow.close(); } catch (e) { } }

    /* ============ ③ 测试按钮：成功 / 失败都要说清 ============ */
    const before = hits.length;
    await evalJs(sw, "invoke('ocr_test_engine', { engine: 'custom' })");
    const th = await waitHit((h) => h.path.indexOf('/chat/completions') >= 0
        && hits.indexOf(h) >= before, 25000);
    ok('R12 点「测试连接」会真的发一次请求（不是假的"看起来在测"）', !!th,
        JSON.stringify(hits.slice(before).map((h) => h.path)));

    await evalJs(sw, "document.querySelector('#w-ocrCredBox .cred-foot .dep-btn').click()");
    const okState = await waitReady(sw,
        "!!document.querySelector('#w-ocrCredBox .cred-status.ok')", 25000);
    const okTxt = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox .cred-status') || {}).textContent || ''");
    ok('R13 测试通过时状态行变绿、写明"连上了"', okState && /连上了/.test(okTxt), okTxt);

    // 让假服务器开始回 403 + 响应体里写着真正的原因
    mode = '403';
    await evalJs(sw, "invoke('ocr_test_engine', { engine: 'custom' })");
    const badState = await waitReady(sw,
        "!!document.querySelector('#w-ocrCredBox .cred-status.bad')", 25000);
    const badTxt = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox .cred-status') || {}).textContent || ''");
    ok('R14 测试失败时状态行变红', badState === true, badTxt);
    ok('R15 失败原因带的是**对方响应体里的原话**（"余额不足"），不是干巴巴的 403',
        /余额不足/.test(badTxt) && /403/.test(badTxt), badTxt);
    mode = 'ok';

    /* ============ ④ 模型：能拉列表、能挑、挑完存得住 ============ */
    const modelRow = await evalJs(sw, `(() => {
        const i = document.querySelector('#w-ocrCredBox input[data-field="model"]');
        return i ? { val: i.value, list: i.getAttribute('list') } : null;
    })()`);
    ok('R16 走大模型的那家**总是**显示模型那一栏（能看见自己会调哪个模型）',
        !!modelRow && modelRow.list === 'ocrModelList', JSON.stringify(modelRow));

    await evalJs(sw, "document.querySelector('#w-ocrCredBox .cred-pull').click()");
    const pulled = await waitReady(sw,
        "(() => { const d = document.getElementById('ocrModelList');"
        + " return !!d && d.querySelectorAll('option').length >= 3; })()", 25000);
    ok('R17 点「拉取模型」把模型列表拉回来了（datalist 里有货）', pulled === true);
    const opts = await evalJs(sw,
        "[...document.getElementById('ocrModelList').querySelectorAll('option')].map((o) => o.value)");
    ok('R18 看着能看图的模型排在前面（Qwen2.5-VL 在纯文本模型 bge-m3 之前）',
        Array.isArray(opts) && opts.indexOf('Qwen/Qwen2.5-VL-32B-Instruct') >= 0
        && opts.indexOf('Qwen/Qwen2.5-VL-32B-Instruct') < opts.indexOf('bge-m3'),
        JSON.stringify(opts));

    // 换成另一个模型 → 必须落盘，且下一个请求用的就是它
    await evalJs(sw, `(() => {
        const i = document.querySelector('#w-ocrCredBox input[data-field="model"]');
        i.value = 'Qwen/Qwen2.5-VL-32B-Instruct';
        i.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    let diskModel = '';
    for (let i = 0; i < 25; i++) {
        try {
            diskModel = (JSON.parse(fs.readFileSync(CFG, 'utf8')).ocr_models || {}).custom || '';
        } catch (e) { }
        if (diskModel === 'Qwen/Qwen2.5-VL-32B-Instruct') break;
        await asleep(200);
    }
    ok('R19 选的模型写进了自己的配置（ocr_models.custom）',
        diskModel === 'Qwen/Qwen2.5-VL-32B-Instruct', 'disk=' + diskModel);

    const n0 = hits.length;
    await evalJs(sw, "invoke('ocr_test_engine', { engine: 'custom' })");
    const h2 = await waitHit((h) => hits.indexOf(h) >= n0, 25000);
    ok('R20 换完模型，下一次请求用的就是新模型名（不是还拿旧的预设值）',
        !!h2 && JSON.parse(h2.body || '{}').model === 'Qwen/Qwen2.5-VL-32B-Instruct',
        h2 && JSON.parse(h2.body || '{}').model);

    try { sw.close(); } catch (e) { }
})()
    .catch((e) => ok('r46 探针本身没有抛异常', false, String((e && e.stack) || e)))
    .finally(() => {
        try { server.close(); } catch (e) { }
        /* 只收自己这一棵进程树，绝不动用户开着的实例 */
        try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        console.log('\n' + pass + '/' + total + ' passed');
        process.exit(pass === total ? 0 : 1);
    });
