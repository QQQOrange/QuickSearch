/* ============================================================================
 *  r72：OCR 凭据区两件事（需求 D，用户原话）
 *
 *    ①「选择在线引擎之后，有的在线引擎可以拉取模型，但拉取模型之后为什么模型
 *       列表却没有陈列出来以让我选择呢？」
 *       —— 根因：以前只往 <datalist> 里塞，WebView2 的 datalist 没有可见的
 *       下拉入口，拉完不知道去哪挑。现在模型行下方多一块**可见清单**
 *       （.cred-models），视觉模型带徽标排前面，点一下写回输入框并存档。
 *    ②「填入 api key 之后……直接明文显示了，至少要隐藏吧，最多 api key 这
 *       一个文本框最后留一个眼睛的图标，点击后可以显示。」
 *       —— 根因：API Key 那栏 secret=false，明文摆着。现在 Key 与 Secret
 *       一致默认密码框，框尾挂眼睛按钮点击切换可见性。
 *
 *  探针同样不依赖任何厂商 Key：本地假 OpenAI 兼容服务当"自定义那家"，
 *  base_url 指过去 —— 拉回来的模型列表、点选后落盘、下一个请求用的模型名，
 *  全部可观测。
 *
 *  ⚠ 隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG），
 *    不碰用户配置，不 taskkill 用户开着的实例。
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const TAG = 'r72ocr' + Date.now().toString(36);   // 每轮唯一：tag 相同会撞单实例互斥体
const DIR = path.join(os.tmpdir(), 'qs-r72-' + process.pid);
fs.rmSync(DIR, { recursive: true, force: true });
const QS = path.join(DIR, 'QuickSearch');
fs.mkdirSync(QS, { recursive: true });
const CFG = path.join(QS, 'config.json');

/* 两个端口都**每轮随机取空闲口**：写死端口时，上一轮被 timeout 杀掉的探针可能
 * 留下一个还占着口的旧实例，新一轮的 findPage 会连到那个旧页面上 —— 症状是
 * R1 通过、之后 Runtime.evaluate 全部超时（渲染进程早就没人管了）。 */
let API_PORT = 0;
let CDP_PORT = 0;
let API = '';                    // http://127.0.0.1:<API_PORT>/v1，main 里拼

/** 让系统分一个空闲端口给我们。 */
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => res(p));
        });
    });
}

/* 模型清单里故意混三种：两个名字看着能看图（排前面）、一个纯文本。
 * probe-vl-model 同时还是配置里预置的默认模型 —— 进页面它就该带 .sel。 */
const M_VL_A = 'Qwen/Qwen2.5-VL-32B-Instruct';
const M_VL_B = 'probe-vl-model';
const M_TXT = 'bge-m3';

/** 写隔离配置（端口定下来之后才写，所以放在 main 里调）。 */
function writeConfig() {
    fs.writeFileSync(CFG, JSON.stringify({
        debug: true,
        ocr_enable: true,
        ocr_engine: 'custom',
        ocr_parallel: false,
        ocr_accurate: false,
        ocr_lang: 'CHN_ENG',
        trigger_select: false,
        trigger_copy: false,
        auto_start: false,
        auto_elevate: false,
        theme: 'light',
        ocr_keys: { custom: 'probe-key-123', tencent: 'tencent-key-456' },
        ocr_secrets: { tencent: 'tencent-secret-789' },
        ocr_bases: { custom: API },
        ocr_models: { custom: M_VL_B },
    }, null, 1), 'utf8');
}

const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, total = 0;
const ok = (name, cond, extra) => {
    total++;
    if (cond) pass++;
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '\n        ' + (extra || '')));
};

/* ---------------- 本地假 OpenAI 兼容服务 ---------------- */
const hits = [];        // 收到的每一个请求
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
                    { id: M_TXT },
                    { id: M_VL_B },
                    { id: M_VL_A },
                ],
            }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '假服务器认出来的字' } }] }));
    });
});

/* ---------------- CDP 小工具（r37/r44/r45/r46 同一套） ---------------- */
/* CDP 请求序号（每个请求自己挂监听，见 cdp 的说明）。 */
let wsId = 0;

/* CDP：**每个请求单独挂一个监听**（不用共享 id→resolve 表）。
 * 共享表在目标被重建 / 上下文被替换时会出现"响应到了却对不上号"的假超时，
 * 排查时看到的现象是"第一个 evaluate 有回音、后面全部卡死"，很难定位。 */
function cdp(ws, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        const timer = setTimeout(() => {
            ws.removeEventListener('message', on);
            reject(new Error('CDP 超时：' + method));
        }, timeoutMs || 8000);
        const on = (e) => {
            let m; try { m = JSON.parse(e.data); } catch (err) { return; }
            if (!m || m.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', on);
            if (m.error) reject(new Error(m.error.message || 'cdp'));
            else resolve(m.result);
        };
        ws.addEventListener('message', on);
        try { ws.send(JSON.stringify({ id, method, params: params || {} })); }
        catch (err) { clearTimeout(timer); ws.removeEventListener('message', on); reject(err); }
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

/* 读盘上的某个 OCR 配置项（带重试：保存是异步落盘的）。 */
async function readDisk(field, engine, expect, ms) {
    const t0 = Date.now();
    let val = '';
    while (Date.now() - t0 < (ms || 8000)) {
        try {
            val = (JSON.parse(fs.readFileSync(CFG, 'utf8'))[field] || {})[engine] || '';
        } catch (e) { }
        if (val === expect) return val;
        await asleep(200);
    }
    return val;
}

(async () => {
    CDP_PORT = await freePort();
    API_PORT = await freePort();
    API = 'http://127.0.0.1:' + API_PORT + '/v1';
    writeConfig();
    await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));
    console.log('假 OCR 服务已起在 ' + API + '（调试端口 ' + CDP_PORT + '）');

    const env = Object.assign({}, process.env, {
        APPDATA: DIR,
        LOCALAPPDATA: DIR,
        WEBVIEW2_USER_DATA_FOLDER: path.join(DIR, 'wv2-' + TAG),
        QS_DEBUG: '1',
        QS_INSTANCE_TAG: TAG,
        QS_ALLOW_INJECTED: '1',
        /* ⚠ additional_browser_args 是**整体替换**默认值，不是追加 —— 只写
         * `--remote-debugging-port` 会把 `--disable-gpu-sandbox` 弄丢。本机
         * Chromium 的 GPU 进程在沙箱里会连崩，渲染进程随即失联：表现是第一条
         * Runtime.evaluate 有回音、之后全部超时（探针看起来"卡在某一步"）。
         * 所以这里必须带上和正式启动同一套参数。 */
        QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
            + ' --disable-gpu-sandbox --remote-debugging-port=' + CDP_PORT,
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

    /* ============ ② API Key 默认隐藏（密码框） ============ */
    const keyType = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox input[data-field=\"key\"]') || {}).type || ''");
    ok('R3 填了 API Key 的那一栏默认是**密码框**（不再明文摆着）',
        keyType === 'password', 'type=' + keyType);
    const keyVal = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox input[data-field=\"key\"]') || {}).value || ''");
    ok('R4 密码框里就是配好的那把 Key（值是进来了的，只是看不见）',
        keyVal === 'probe-key-123', 'value=' + keyVal);
    const eye = await evalJs(sw,
        "!!document.querySelector('#w-ocrCredBox .cred-eye-wrap .cred-eye-btn')");
    ok('R5 密码框尾部挂了眼睛按钮（.cred-eye-btn）', eye === true);

    /* 点眼睛：密码 ↔ 明文，值不能丢 */
    await evalJs(sw,
        "document.querySelector('#w-ocrCredBox .cred-eye-wrap .cred-eye-btn').click()");
    const shown = await evalJs(sw, `(() => {
        const i = document.querySelector('#w-ocrCredBox input[data-field="key"]');
        const b = document.querySelector('#w-ocrCredBox .cred-eye-btn');
        return { type: i.type, val: i.value, on: b.classList.contains('on') };
    })()`);
    ok('R6 点一下眼睛变明文（type=text，值还在，按钮切到 on 态）',
        shown.type === 'text' && shown.val === 'probe-key-123' && shown.on === true,
        JSON.stringify(shown));
    await evalJs(sw,
        "document.querySelector('#w-ocrCredBox .cred-eye-wrap .cred-eye-btn').click()");
    const hidden = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox input[data-field=\"key\"]') || {}).type || ''");
    ok('R7 再点一下回到密码态（默认仍然是藏着的）', hidden === 'password', 'type=' + hidden);

    /* ============ ②b 换一家（腾讯：Key + Secret 两栏）都该是密码框 ============ */
    await evalJs(sw,
        "document.querySelector('#w-ocrEngList .eng-row[data-id=\"tencent\"]').click()");
    const tencentOk = await waitReady(sw,
        "!!document.querySelector('#w-ocrCredBox input[data-field=\"secret\"]')", 15000);
    const tc = await evalJs(sw, `(() => {
        const k = document.querySelector('#w-ocrCredBox input[data-field="key"]');
        const s = document.querySelector('#w-ocrCredBox input[data-field="secret"]');
        return {
            keyType: k ? k.type : '', keyVal: k ? k.value : '',
            secType: s ? s.type : '', secVal: s ? s.value : '',
            eyes: document.querySelectorAll('#w-ocrCredBox .cred-eye-btn').length,
        };
    })()`);
    ok('R8 腾讯（Key+Secret 两家）两栏都是密码框、值都在、各带一颗眼睛',
        tencentOk && tc.keyType === 'password' && tc.secType === 'password'
        && tc.keyVal === 'tencent-key-456' && tc.secVal === 'tencent-secret-789'
        && tc.eyes === 2, JSON.stringify(tc));

    /* 切回 custom（MODELS 是模块级缓存，切回去面板该还在——但此刻还没拉过，
     * 所以先验无面板，再拉）。 */
    await evalJs(sw,
        "document.querySelector('#w-ocrEngList .eng-row[data-id=\"custom\"]').click()");
    await waitReady(sw,
        "!!document.querySelector('#w-ocrCredBox input[data-field=\"model\"]')", 15000);
    const noPanelYet = await evalJs(sw,
        "!document.querySelector('#w-ocrCredBox .cred-models')");
    ok('R9 没拉过模型时没有清单面板（不拿空面板占地方）', noPanelYet === true);

    /* ============ ① 拉完模型要**陈列出来** ============
     * r76：默认**只留视觉模型**（用户原话「它搜索模型有的是视觉模型，那就保存
     * 非视觉模型就默认排除在模型列表之外」）。假服务返回 3 个（2 视觉 +
     * 1 纯文本 bge-m3），所以面板里现在是 **2 个**。
     * ⚠ 这一条以前断言的是 3 个（过滤前的行为），r76 起改成 2 ——
     *   不是探针放水，是产品口径变了：纯文本模型压根吃不了图，
     *   列出来只会让人在几十个名字里挑一个必然失败的。 */
    await evalJs(sw, "document.querySelector('#w-ocrCredBox .cred-pull').click()");
    const panelUp = await waitReady(sw,
        "document.querySelectorAll('#w-ocrCredBox .cred-models .cred-model-item').length === 2",
        25000);
    ok('R10 点「拉取模型」后模型清单**陈列出来**了（2 个 .cred-model-item，纯文本已被排除）',
        panelUp === true);

    const head = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox .cred-models-h') || {}).textContent || ''");
    ok('R11 清单标题写清数量（2 个 · 2 个能看图）',
        /2 个/.test(head) && /2 个能看图/.test(head), head);

    const items = await evalJs(sw, `(() => {
        const its = [...document.querySelectorAll('#w-ocrCredBox .cred-models .cred-model-item')];
        return its.map((x) => ({
            id: (x.querySelector('.cm-id') || {}).textContent || '',
            vis: !!x.querySelector('.v-badge'),
            sel: x.classList.contains('sel'),
        }));
    })()`);
    const order = items.map((x) => x.id);
    ok('R12 纯文本模型已被默认排除（清单里没有 bge-m3）',
        order.indexOf(M_TXT) < 0, JSON.stringify(order));
    ok('R12b 两个视觉模型都在清单里',
        order.indexOf(M_VL_A) >= 0 && order.indexOf(M_VL_B) >= 0, JSON.stringify(order));
    const vlA = items.find((x) => x.id === M_VL_A);
    const vlB = items.find((x) => x.id === M_VL_B);
    const txt = items.find((x) => x.id === M_TXT);
    ok('R13 视觉模型带「视觉」徽标',
        !!vlA && vlA.vis === true && !!vlB && vlB.vis === true, JSON.stringify(items));
    ok('R14 配置里预置的那个模型在清单里带选中标（.sel）',
        !!vlB && vlB.sel === true, JSON.stringify(vlB));

    /* 点一项 → 回填输入框 + 选中标搬家 + 落盘。
     * r76：清单里现在只剩视觉模型，所以点 VL_A（原来点的是纯文本那个）。 */
    await evalJs(sw,
        `[...document.querySelectorAll('#w-ocrCredBox .cred-models .cred-model-item')]`
        + `.find((x) => (x.querySelector('.cm-id') || {}).textContent === '${M_VL_A}').click()`);
    const picked = await waitReady(sw,
        `document.querySelector('#w-ocrCredBox input[data-field="model"]').value === '${M_VL_A}'`
        + ` && !!document.querySelector('#w-ocrCredBox .cred-model-item.sel .cm-id')`
        + ` && document.querySelector('#w-ocrCredBox .cred-model-item.sel .cm-id').textContent === '${M_VL_A}'`,
        15000);
    ok('R15 点一下清单项：输入框回填、选中标搬到该项', picked === true);
    const diskModel = await readDisk('ocr_models', 'custom', M_VL_A);
    ok('R16 点选后模型名落进自己的配置（ocr_models.custom）',
        diskModel === M_VL_A, 'disk=' + diskModel);

    /* 端到端：下一个请求用的就是刚点选的那个模型 */
    const n0 = hits.length;
    await evalJs(sw, "invoke('ocr_test_engine', { engine: 'custom' })");
    const h2 = await waitHit((h) => h.path.indexOf('/chat/completions') >= 0
        && hits.indexOf(h) >= n0, 25000);
    const reqModel = h2 ? (JSON.parse(h2.body || '{}').model || '') : '';
    ok('R17 点选完再测，请求体里带的就是刚点的模型（端到端闭环）',
        reqModel === M_VL_A, 'model=' + reqModel);

    /* ============ 面板可收起（几百个模型的中转站默认展开太长） ============ */
    await evalJs(sw,
        "document.querySelector('#w-ocrCredBox .cred-models-h').click()");
    const shut = await evalJs(sw, `(() => {
        const w = document.querySelector('#w-ocrCredBox .cred-models');
        const b = document.querySelector('#w-ocrCredBox .cred-models-b');
        return { shut: w.classList.contains('shut'), vis: getComputedStyle(b).display };
    })()`);
    ok('R18 点标题行收起清单（.shut，body 隐藏）',
        shut.shut === true && shut.vis === 'none', JSON.stringify(shut));
    await evalJs(sw,
        "document.querySelector('#w-ocrCredBox .cred-models-h').click()");
    const open = await evalJs(sw,
        "getComputedStyle(document.querySelector('#w-ocrCredBox .cred-models-b')).display");
    ok('R19 再点一下展开回来', open !== 'none', 'display=' + open);

    /* ============ 回归：r46 的 datalist 路线没被拿掉 ============ */
    const dl = await evalJs(sw, `(() => {
        const d = document.getElementById('ocrModelList');
        const i = document.querySelector('#w-ocrCredBox input[data-field="model"]');
        return {
            opts: d ? [...d.querySelectorAll('option')].map((o) => o.value) : null,
            list: i ? i.getAttribute('list') : '',
        };
    })()`);
    /* r76：datalist 也跟着只留视觉的（2 个）—— 纯文本的 bge-m3 在清单和
     * 下拉里都不该再出现，两条路必须一致。 */
    ok('R20 datalist 回归：输入框仍挂着列表、选项与面板一致（手打+下拉两条路都在）',
        Array.isArray(dl.opts) && dl.opts.length === 2
        && dl.opts.indexOf(M_VL_A) >= 0 && dl.opts.indexOf(M_VL_B) >= 0
        && dl.opts.indexOf(M_TXT) < 0 && dl.list === 'ocrModelList',
        JSON.stringify(dl));

    const pullTxt = await evalJs(sw,
        "(document.querySelector('#w-ocrCredBox .cred-pull') || {}).textContent || ''");
    ok('R21 拉过之后按钮文字带上数量（拉取模型（2））',
        pullTxt.indexOf('2') >= 0, pullTxt);

    /* 布局：模型行里输入框在按钮左边（DOM 顺序即视觉顺序） */
    const layout = await evalJs(sw, `(() => {
        const i = document.querySelector('#w-ocrCredBox input[data-field="model"]');
        const b = document.querySelector('#w-ocrCredBox .cred-pull');
        if (!i || !b) return null;
        const ri = i.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return { iRight: ri.right, bLeft: rb.left, iW: ri.width };
    })()`);
    ok('R22 模型行布局：输入框在「拉取模型」按钮左边（按钮贴在输入框右边）',
        !!layout && layout.iRight <= layout.bLeft + 1, JSON.stringify(layout));

    /* ============ 面板在重绘后还在（切走再切回） ============ */
    await evalJs(sw,
        "document.querySelector('#w-ocrEngList .eng-row[data-id=\"tencent\"]').click()");
    await waitReady(sw,
        "!!document.querySelector('#w-ocrCredBox input[data-field=\"secret\"]')", 15000);
    await evalJs(sw,
        "document.querySelector('#w-ocrEngList .eng-row[data-id=\"custom\"]').click()");
    const back = await waitReady(sw,
        "document.querySelectorAll('#w-ocrCredBox .cred-models .cred-model-item').length === 2",
        15000);
    ok('R23 切走再切回：清单还在（拉到的模型不白丢）', back === true);

    try { sw.close(); } catch (e) { }
})()
    .catch((e) => ok('r72 探针本身没有抛异常', false, String((e && e.stack) || e)))
    .finally(() => {
        try { server.close(); } catch (e) { }
        /* 只收自己这一棵进程树，绝不动用户开着的实例 */
        try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        console.log('----------------------------------------');
        console.log('r72 结果：' + pass + ' / ' + total + ' 通过');
        console.log('（隔离实例已销毁，APPDATA=' + DIR + ' 可删）');
        process.exit(pass === total ? 0 : 1);
    });
