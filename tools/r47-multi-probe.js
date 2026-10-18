/* ============================================================================
 *  r47：「识别引擎」折叠列表 + 「同时识别」多选（取代「双引擎并行识别」开关）
 *
 *  用户这一轮的原话（决定了下面每一条断言）：
 *    ① 「在这里面我怎么没有给我一个设置默认引擎的选项？…那到底我要以什么样的方式
 *        才能选择默认的 ocr 呢？」            → 点一家 = 设为默认，必须有明确入口；
 *    ② 「把双引擎并行识别，改为选择 OCR 引擎同时识别…可以同时选个多个 OCR 同时进行。
 *        同时也只会显示自己选择的那一个。」    → 多选 + 只显示选中的；
 *    ③ 「关闭双引擎并行识别之后…仍然存在有一个本地的识别引擎，点击之后就可以跳过去」
 *                                            → 没勾的引擎不该出现在结果页；
 *    ④ 「现在的 ocr 引擎有这么多，但却一次性把它全部显示出来了，就很占用显示空间，
 *        就可以提供一个选项，你选择了哪一个，就会只显示那一个折叠」
 *                                            → 手风琴：只展开选中的那一家。
 *
 *  ⚠ 这个探针在**真 WebView** 里点真控件、走真 IPC，最后落到磁盘 config.json ——
 *    因为这一轮最容易出的错不是"函数返回不对"，而是"界面上点了、配置里没变"
 *    （老用户升级上来还会多一层：ocr_parallel 这个旧开关得**迁移**成新名单，
 *     不然用户"明明开着的并行识别"会凭空消失）。
 *  ⚠ 隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）：不动用户正在用的
 *    配置和日志；结束时只 taskkill 自己这一棵进程树。
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const TAG = 'r47multi';
const DIR = path.join(os.tmpdir(), 'qs-r47-' + process.pid);
fs.rmSync(DIR, { recursive: true, force: true });
const QS = path.join(DIR, 'QuickSearch');
fs.mkdirSync(QS, { recursive: true });
const CFG = path.join(QS, 'config.json');
/* 起点故意做成「老用户升级上来」的样子：
 *   · ocr_engine = siliconflow（真用户现在配的就是这家）；
 *   · ocr_parallel = true（老的「双引擎并行识别」开着）→ 必须被迁移成
 *     ocr_multi=["windows"]，否则用户会以为"我开的并行识别丢了"；
 *   · 百度只有老字段 ocr_key/ocr_secret（没有 ocr_keys map）→ 没配好。 */
fs.writeFileSync(CFG, JSON.stringify({
    debug: true,
    ocr_enable: true,
    ocr_engine: 'siliconflow',
    ocr_parallel: true,
    ocr_accurate: false,
    trigger_select: false,
    trigger_copy: false,
    auto_start: false,
    auto_elevate: false,
    theme: 'light',
    ocr_keys: { siliconflow: 'sk-probe-123' },
}, null, 1), 'utf8');

const PORT = 9427;
const asleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, total = 0;
const ok = (name, cond, extra) => {
    total++;
    if (cond) pass++;
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '\n        ' + (extra || '')));
};

const env = Object.assign({}, process.env, {
    APPDATA: DIR,
    LOCALAPPDATA: DIR,
    WEBVIEW2_USER_DATA_FOLDER: path.join(DIR, 'wv2-' + TAG),
    QS_DEBUG: '1',
    QS_INSTANCE_TAG: TAG,
    QS_ALLOW_INJECTED: '1',
    QS_T_WV_ARGS: '--remote-debugging-port=' + PORT,
});
console.log('启动隔离实例（APPDATA=' + DIR + '）');
const p = spawn(EXE, ['--no-elevate', '--settings'],
    { env, cwd: ROOT, detached: false, stdio: 'ignore' });

const readCfg = () => {
    try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return {}; }
};
async function waitCfg(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 9000)) {
        if (pred(readCfg())) return true;
        await asleep(200);
    }
    return pred(readCfg());
}

/* ---------------- CDP 小工具（与 r37 / r44 / r45 同一套） ---------------- */
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
    if (r.exceptionDetails) throw new Error('JS: ' + String(expr).slice(0, 160));
    return r.result.value;
}
async function findPage(re, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
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
async function waitJs(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) {
        try { if (await evalJs(ws, expr)) return true; } catch (e) { }
        await asleep(200);
    }
    return false;
}
/* 页面上的一次「点」：优先点真实元素，点不到就报 null 让断言自己去失败 */
const jsClick = (sel) => "(function(){var e=document.querySelector(" + JSON.stringify(sel)
    + "); if(!e) return 'no-el'; e.click(); return 'ok';})()";
const jsInfo = (sel) => "(function(){var e=document.querySelector(" + JSON.stringify(sel)
    + "); return e ? JSON.stringify({t: e.textContent.trim().slice(0,40),"
    + " id: e.dataset.id || '', cls: e.className}) : null;})()";

(async function main() {
    const sw = await findPage(/settings\.html/, 40000);
    ok('R1 连上了设置页（--settings 启动参数）', !!sw, 'CDP 里没找到 settings.html');
    if (!sw) return;

    const ready = await waitJs(sw, "document.querySelectorAll('#w-ocrEngList .eng-row').length > 5");
    ok('R2 设置页 JS 跑完、引擎列表渲染出来', ready);

    /* ---------------- ① 手风琴：只展开「默认引擎」那一家 ---------------- */
    const rows = JSON.parse(await evalJs(sw,
        "JSON.stringify(Array.from(document.querySelectorAll('#w-ocrEngList .eng-row'))"
        + ".map(function(r){return {id:r.dataset.id, open:r.classList.contains('open'),"
        + " on:r.classList.contains('on')};}))"));
    const opened = rows.filter((r) => r.open).map((r) => r.id);
    ok('R3 手风琴：**只有一家**是展开的（其余折成一行名字，不占地方）',
        opened.length === 1, JSON.stringify(rows));
    ok('R4 展开的正是**默认引擎**（点一家 = 设为默认，展开块跟着走）',
        opened[0] === 'siliconflow', '展开的是 ' + JSON.stringify(opened));

    const boxInfo = JSON.parse(await evalJs(sw,
        "JSON.stringify({n: document.querySelectorAll('#w-ocrEngList .eng-body').length,"
        + " row: (function(){var b=document.getElementById('w-ocrCredBox');"
        + " if(!b) return null; var r=b.closest('.eng-row'); return r?r.dataset.id:null;})()})"));
    ok('R5 凭据框（Key/模型那一块）挂在展开的那一行里 —— 不是单独一大块铺在页面上',
        boxInfo.n === 1 && boxInfo.row === 'siliconflow', JSON.stringify(boxInfo));

    const otherOpen = JSON.parse(await evalJs(sw,
        "JSON.stringify(Array.from(document.querySelectorAll('#w-ocrEngList .eng-row'))"
        + ".filter(function(r){return !r.classList.contains('open')})"
        + ".map(function(r){return r.id}).filter(function(id){"
        + "return !!document.querySelector('#w-ocrEngList .eng-row[data-id=\"'+id+'\"] .eng-body')}))"));
    ok('R6 折叠的那些行里没有凭据块（没选中的引擎不占显示空间）',
        otherOpen.length === 0, JSON.stringify(otherOpen));

    /* ---------------- ② 老配置的迁移：ocr_parallel → ocr_multi ---------------- */
    /* ⚠ 迁移发生在**读配置时**（config.rs 的 sanitize）：内存里立刻就是新口径，
     *   config.json 那个文件要等下一次保存才重写 —— 所以这里先量内存里的
     *   config_view（用户看到的就是它），落盘在 R7b 量。 */
    const view1 = JSON.parse(await evalJs(sw,
        "JSON.stringify({m: CONF.ocrMulti, p: CONF.ocrParallel})"));
    ok('R7 老的「双引擎并行识别」(ocr_parallel=true) 被**迁移**成「同时识别：[本地]」'
        + '（用户的并行识别不会凭空消失）',
        JSON.stringify(view1.m) === JSON.stringify(['windows']) && view1.p === false,
        JSON.stringify(view1));

    const legacySwitch = await evalJs(sw, "!!document.getElementById('s-ocrParallel')");
    ok('R8 老的「双引擎并行识别」勾选框已从界面上删掉（改成勾引擎胶囊）',
        legacySwitch === false);

    /* ---------------- ③ 多选：勾谁跑谁，默认引擎不在名单里 ---------------- */
    const chipInfo = JSON.parse(await evalJs(sw,
        "JSON.stringify({n: document.querySelectorAll('#w-ocrMultiBox .multi-chip').length,"
        + " hasDefault: !!document.querySelector('#w-ocrMultiBox .multi-chip[data-id=\"siliconflow\"]'),"
        + " win: (function(){var c=document.querySelector('#w-ocrMultiBox .multi-chip[data-id=\"windows\"]');"
        + " return c ? c.className : null;})()})"));
    ok('R9 「同时识别」胶囊里**不包含默认引擎**（它一定参与，勾不勾都是它）',
        chipInfo.hasDefault === false && chipInfo.n >= 12, JSON.stringify(chipInfo));
    ok('R10 迁移过来的「本地」是**选中态**（用户看得见、点一下就能取消）',
        /(^|\s)on(\s|$)/.test(String(chipInfo.win)), 'className=' + chipInfo.win);

    const bail = await evalJs(sw,
        "JSON.stringify({warn: !!document.querySelector('#w-ocrMultiBox .multi-chip[data-id=\"baidu\"] .multi-warn'),"
        + " txt: (function(){var c=document.querySelector('#w-ocrMultiBox .multi-chip[data-id=\"baidu\"]');"
        + " return c ? c.textContent.trim() : null;})()})");
    const bailInfo = JSON.parse(bail);
    ok('R11 没填凭据的那家当场标「没配」（勾了会被跳过，不说清楚就又是"配了怎么没用"）',
        bailInfo.warn === true && /没配/.test(String(bailInfo.txt)), bail);

    // 勾上百度 → 落盘 + 行上出现「同时识别」徽标（并且带 warn）
    await evalJs(sw, jsClick('#w-ocrMultiBox .multi-chip[data-id="baidu"]'));
    const added = await waitCfg((c) => Array.isArray(c.ocr_multi) && c.ocr_multi.indexOf('baidu') >= 0, 8000);
    const disk2 = readCfg();
    ok('R12 点一颗胶囊 → 真的存进 config.json（不是只改了界面）',
        added, JSON.stringify(disk2.ocr_multi));
    ok('R7b 迁移结果随这次保存一起落盘：ocr_multi 写进文件、老开关 ocr_parallel 归 false',
        Array.isArray(disk2.ocr_multi) && disk2.ocr_parallel === false,
        JSON.stringify({ m: disk2.ocr_multi, p: disk2.ocr_parallel }));
    ok('R13 名单按**注册表顺序**归一（本地在前、百度在后），不是点击顺序',
        JSON.stringify(disk2.ocr_multi) === JSON.stringify(['windows', 'baidu']),
        JSON.stringify(disk2.ocr_multi));
    const tag = await waitJs(sw,
        "!!document.querySelector('#w-ocrEngList .eng-row[data-id=\"windows\"] .eng-tag')");
    ok('R14 已经在名单里的那一家，行上多一个「同时识别」徽标', tag);

    await evalJs(sw, jsClick('#w-ocrMultiBox .multi-chip[data-id="baidu"]'));
    const removed = await waitCfg((c) => Array.isArray(c.ocr_multi) && c.ocr_multi.indexOf('baidu') < 0, 8000);
    ok('R15 再点一下取消 → 配置里也真的没了（勾选是可逆的）', removed,
        JSON.stringify(readCfg().ocr_multi));

    /* ---------------- ④ 换默认引擎：整块跟着搬过去 ---------------- */
    await evalJs(sw, jsClick('#w-ocrEngList .eng-row[data-id="tencent"] .eng-name'));
    const switched = await waitCfg((c) => c.ocr_engine === 'tencent', 8000);
    ok('R16 点另一家的名字 = 设为默认引擎（磁盘上的 ocr_engine 跟着变）', switched,
        'ocr_engine=' + readCfg().ocr_engine);
    const moved = await waitJs(sw,
        "document.querySelector('#w-ocrEngList .eng-row[data-id=\"tencent\"]').classList.contains('open')");
    const oldClosed = await evalJs(sw,
        "!document.querySelector('#w-ocrEngList .eng-row[data-id=\"siliconflow\"]').classList.contains('open')");
    ok('R17 展开块（凭据 + 同时识别）跟着搬到新的默认引擎那边，旧的自动折起来',
        moved === true && oldClosed === true, 'moved=' + moved + ' oldClosed=' + oldClosed);

    // 把默认引擎切成名单里的「本地」→ 后端必须把它从名单里剔掉
    // （名单不含默认引擎，否则配置里会留一条永远不生效的勾）
    await waitCfg((c) => Array.isArray(c.ocr_multi) && c.ocr_multi.indexOf('windows') >= 0, 5000);
    await evalJs(sw, jsClick('#w-ocrEngList .eng-row[data-id="windows"] .eng-name'));
    const cleaned = await waitCfg((c) => c.ocr_engine === 'windows'
        && Array.isArray(c.ocr_multi) && c.ocr_multi.indexOf('windows') < 0, 8000);
    ok('R18 某一家被设成默认引擎后，后端把它从「同时识别」名单里剔掉（配置里不留死勾）',
        cleaned, JSON.stringify({ e: readCfg().ocr_engine, m: readCfg().ocr_multi }));

    const view = await evalJs(sw, "JSON.stringify({has: 'ocrMulti' in CONF, v: CONF.ocrMulti})");
    ok('R19 config_view 里有 ocrMulti（结果页据此只列参与的那几家）',
        String(view).indexOf('"has":true') >= 0, view);

    /* ---------------- ⑤ 文案：帮助里不能再教"双引擎并行" ---------------- */
    const html = fs.readFileSync(path.join(ROOT, 'ui/settings.html'), 'utf8');
    ok('R20 帮助⑤ 讲的是「同时识别（可多选）」，不再教老的「双引擎并行」开关',
        html.indexOf('同时识别（可多选）') >= 0 && html.indexOf('<b>双引擎并行</b>') < 0);
    ok('R21 OCR 页说明讲了「点一家 = 设为默认引擎」+ 展开/折叠',
        html.indexOf('点一家 = 设为<b>默认引擎</b>') >= 0, '说明文案没跟上 r47 的交互');

    try { sw.close(); } catch (e) { }
})()
    .catch((e) => ok('r47 探针本身没有抛异常', false, String((e && e.stack) || e)))
    .finally(() => {
        /* 只收自己这一棵进程树，绝不动用户开着的实例 */
        try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        console.log('\n' + pass + '/' + total + ' passed');
        process.exit(pass === total ? 0 : 1);
    });
