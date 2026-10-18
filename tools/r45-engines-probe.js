/* ============================================================================
 *  r45：多引擎在线 OCR + 每家的「? 申请教程」按钮（需求 2）端到端回归
 *
 *  需求原话：「多添加一些在线 OCR 的方式，在线 OCR 的引擎。尽可能的多添加
 *            （每一个在线引擎旁边加一个问号按钮，点击后跳转到申请 api 的官方教程）」
 *
 *  这一轮最容易出的三类问题，都不是"函数返回值不对"，而是"看着有反应、其实没生效"：
 *    ① **界面名单和后端注册表对不上** —— 后端加了引擎、界面上找不到（或者反过来）；
 *    ② **凭据存不进磁盘** —— 输入框改了、CONF 也改了，config.json 里却没有，
 *       下次重启就"Key 又没了"（老用户百度 Key 的继承问题也属于这一类）；
 *    ③ **问号按钮是摆设** —— 有按钮、点了没反应，或者跳到我们自己写的说明页
 *       而不是用户要的"官方申请页面"。
 *  所以这个探针把这三条链**整条串起来**验，而不是测某个函数的返回值：
 *
 *    界面（引擎列表 / 问号按钮）→ 后端注册表 → 磁盘 config.json → 再读回来
 *
 *  ⚠ 隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）：
 *    不动用户正在用的那份配置和日志，也不会 taskkill 掉用户开着的实例。
 *  ⚠ 起点配置里**故意只写老字段** ocr_key/ocr_secret（没有 ocr_keys 这个 map）：
 *    这就是老用户升级上来的样子，验证"百度 Key 不会突然没了"。
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const TAG = 'r45eng';
const DIR = path.join(os.tmpdir(), 'qs-r45-' + process.pid);
fs.rmSync(DIR, { recursive: true, force: true });
const QS = path.join(DIR, 'QuickSearch');
fs.mkdirSync(QS, { recursive: true });
const CFG = path.join(QS, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({
    debug: true,
    ocr_enable: true,
    ocr_engine: 'baidu',
    ocr_accurate: false,
    trigger_select: false,
    trigger_copy: false,
    auto_start: false,
    auto_elevate: false,
    theme: 'light',
    // 老字段：升级上来的用户，百度密钥只在这里
    ocr_key: 'legacy-baidu-key',
    ocr_secret: 'legacy-baidu-secret',
}, null, 1), 'utf8');

const PORT = 9424;
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

/* ---------------- CDP 小工具（与 r37 / r44 同一套） ---------------- */
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
    if (r.exceptionDetails) throw new Error('JS: ' + String(expr).slice(0, 120));
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
async function waitReady(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
        try { if (await evalJs(ws, expr)) return true; } catch (e) { }
        await asleep(300);
    }
    return false;
}
/** 轮询直到 expr 为真（用于"点了以后等后端落盘"这种异步断言）。 */
async function waitJs(ws, expr, ms) {
    return waitReady(ws, expr, ms);
}

(async () => {
    const sw = await findPage(/settings\.html/);
    ok('R1 连上了设置页（--settings 启动参数）', !!sw, 'CDP 列表里没有 settings.html');
    if (!sw) return;

    /* ---------------- ① 引擎列表：界面名单必须来自后端注册表 ---------------- */
    const ready = await waitReady(sw,
        "typeof CONF === 'object' && document.querySelectorAll('#w-ocrEngList .eng-row').length > 0");
    ok('R2 设置页 JS 跑完，引擎列表渲染出来了', ready, '引擎列表一直是空的');

    const list = await evalJs(sw, `(() => {
        const rows = Array.from(document.querySelectorAll('#w-ocrEngList .eng-row'));
        return {
            n: rows.length,
            ids: rows.map((r) => r.dataset.id),
            withHelp: rows.filter((r) => !!r.querySelector('.eng-help')).map((r) => r.dataset.id),
            helpTxt: Array.from(document.querySelectorAll('#w-ocrEngList .eng-help'))
                .map((b) => b.textContent.trim()),
            titles: Array.from(document.querySelectorAll('#w-ocrEngList .eng-help'))
                .map((b) => b.title || ''),
            on: (document.querySelector('#w-ocrEngList .eng-row.on') || {}).dataset
                ? document.querySelector('#w-ocrEngList .eng-row.on').dataset.id : null,
        };
    })()`);
    ok('R3 引擎列表有 13 家以上（12 家在线 + 本地识别）',
        !!list && list.n >= 13, '只有 ' + (list && list.n) + ' 家：' + JSON.stringify(list && list.ids));
    ok('R4 列表里确实有「本地识别」（离线那家不能被漏掉）',
        !!list && list.ids.indexOf('windows') >= 0, JSON.stringify(list && list.ids));
    ok('R5 每个在线引擎旁边都有一颗问号按钮（用户点名的需求）',
        !!list && list.withHelp.length >= 12
        && list.withHelp.indexOf('windows') < 0,
        '有问号的：' + JSON.stringify(list && list.withHelp));
    ok('R6 问号按钮上写的就是「?」，并且 title 说清了点开去哪家',
        // ⚠ 只看**问号**（文案是 "?" 的），别把「文档」那几颗一起算进来 ——
        //   它们的 title 是另一句话，混在一起验会误判。
        !!list && list.helpTxt.filter((t) => t === '?').length >= 12
        && list.titles.filter((t) => t.indexOf('申请 API 的官方页面') > 0).length >= 12,
        JSON.stringify(list && { helpTxt: list.helpTxt, titles: list.titles.slice(0, 3) }));
    ok('R7 当前引擎（老配置里的 baidu）在列表里是选中态',
        !!list && list.on === 'baidu', '选中的是 ' + (list && list.on));

    /* 后端注册表本身：每家的申请页必须是 https、而且**互不相同**
     * （最阴的 bug 是复制粘贴时忘了改，十几家全指向同一页 —— 界面看着没问题）。 */
    const reg = await evalJs(sw, "invoke('ocr_engines_list')");
    const online = (reg || []).filter((e) => e.online);
    const signs = online.map((e) => e.signup);
    ok('R8 后端注册表：每家在线引擎的申请页都是 https 且互不相同',
        online.length >= 12
        && signs.every((u) => /^https:\/\//.test(u))
        && new Set(signs).size === signs.length,
        '在线 ' + online.length + ' 家，不同的申请页 ' + new Set(signs).size + ' 个');
    ok('R9 后端注册表：文档页也齐全（「文档」那颗按钮用）',
        online.every((e) => /^https:\/\//.test(e.docs)),
        JSON.stringify(online.filter((e) => !/^https:\/\//.test(e.docs)).map((e) => e.id)));

    /* ---------------- ② 老配置的百度 Key 要继承过来 ---------------- */
    const cred = await evalJs(sw, `(() => {
        const box = document.getElementById('w-ocrCredBox');
        const k = box.querySelector('input[data-field="key"]');
        const s = box.querySelector('input[data-field="secret"]');
        return { key: k ? k.value : null, secret: s ? s.value : null,
                 baiduReady: (CONF.ocrCreds && CONF.ocrCreds.baidu || {}).ready };
    })()`);
    ok('R10 老字段 ocr_key/ocr_secret 被继承：凭据框里显示的是老 Key（不是空）',
        !!cred && cred.key === 'legacy-baidu-key' && cred.secret === 'legacy-baidu-secret',
        JSON.stringify(cred));
    ok('R11 百度在注册表里被标成「已填好」（老用户升级上来不该显示成没配）',
        !!reg && reg.filter((e) => e.id === 'baidu')[0].ready === true,
        JSON.stringify((reg || []).filter((e) => e.id === 'baidu')));

    /* ---------------- ③ 切换引擎：注册表决定"要填哪几样" ---------------- */
    const switchTo = async (id) => {
        await evalJs(sw, `document.querySelector('#w-ocrEngList .eng-row[data-id="${id}"] .eng-name').click()`);
        return waitJs(sw, `CONF.ocrEngine === '${id}'
            && !!document.querySelector('#w-ocrEngList .eng-row.on[data-id="${id}"]')`, 8000);
    };
    const fields = async () => evalJs(sw, `(() => {
        const box = document.getElementById('w-ocrCredBox');
        return Array.from(box.querySelectorAll('input')).map((i) => i.dataset.field);
    })()`);

    ok('R12 点引擎名能切换：切到腾讯云（磁盘上的 ocr_engine 也要跟着变）',
        (await switchTo('tencent')) && (await waitCfg((c) => c.ocr_engine === 'tencent')),
        '磁盘=' + JSON.stringify(readCfg().ocr_engine));

    const fTencent = await fields();
    ok('R13 腾讯云要两样：API Key + SecretKey（按注册表生成，不是写死的）',
        JSON.stringify(fTencent) === JSON.stringify(['key', 'secret']), JSON.stringify(fTencent));

    await switchTo('zhipu');
    const fZhipu = await fields();
    // ⚠ r46 起口径变了：**走大模型的那几家总是多一栏「模型名」** ——
    //   用户原话是「你默认就算填了 api key，它到底调哪个模型呢？」。
    //   预置了默认模型 ≠ 不用让用户看见 / 不用让用户换，所以 key + model 都在，
    //   而 base 仍然不出现（注册表预置了，不需要用户填）。
    ok('R14 智谱：API Key + 模型名（模型栏看得见也能换，base 仍不出现）',
        JSON.stringify(fZhipu) === JSON.stringify(['key', 'model']), JSON.stringify(fZhipu));

    await switchTo('custom');
    const fCustom = await fields();
    ok('R15 自定义要三样：API Key + 接口地址 + 模型名（base/model 都要用户填）',
        JSON.stringify(fCustom) === JSON.stringify(['key', 'base', 'model']), JSON.stringify(fCustom));

    /* ---------------- ④ 凭据真的落盘了吗（最容易"看着有反应"的一环） ---------------- */
    await switchTo('tencent');
    await evalJs(sw, `(() => {
        const box = document.getElementById('w-ocrCredBox');
        const set = (f, v) => {
            const el = box.querySelector('input[data-field="' + f + '"]');
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('key', 'probe-secret-id');
        set('secret', 'probe-secret-key');
        return true;
    })()`);
    const saved = await waitCfg((c) => (c.ocr_keys || {}).tencent === 'probe-secret-id'
        && (c.ocr_secrets || {}).tencent === 'probe-secret-key');
    ok('R16 填完自动保存：磁盘 config.json 里 ocr_keys/ocr_secrets 真的有值',
        saved, JSON.stringify({ keys: readCfg().ocr_keys, secrets: readCfg().ocr_secrets }));

    // ⚠ invoke() 返回的是 Promise（没有 .length）—— 别再写 `(invoke(...)||[]).length`，
    //   那永远是 undefined，条件为假就直接返回 null，看着像"后端说没填好"。
    const readyAfter = await evalJs(sw,
        "invoke('ocr_engines_list').then((l) => l.filter((e) => e.id === 'tencent')[0].ready)");
    ok('R17 存完那家引擎变成「已填好」（ready 由后端按注册表算，不是前端猜的）',
        readyAfter === true, String(readyAfter));

    // 清空 = 删掉这一项（不能留个空串在配置里 —— 那样"到底配没配"就说不清了）
    await evalJs(sw, `(() => {
        const box = document.getElementById('w-ocrCredBox');
        const el = box.querySelector('input[data-field="key"]');
        el.value = '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    const cleared = await waitCfg((c) => !(c.ocr_keys || {}).tencent);
    ok('R18 清空输入框 = 从配置里删掉这一项（不是留个空串）',
        cleared, JSON.stringify(readCfg().ocr_keys));

    /* ---------------- ⑤ 问号按钮：真的走了后端那条命令 ---------------- */
    // 不认识的引擎：必须报错，绝不能"瞎开一个浏览器"
    const bad = await evalJs(sw,
        "invoke('ocr_open_help', { engine: 'no-such-engine' }).then(() => 'ok').catch((e) => String(e))");
    ok('R19 不认识的引擎调 ocr_open_help 会报错（不会瞎开浏览器）',
        typeof bad === 'string' && bad.indexOf('不认识的识别引擎') >= 0, String(bad));

    // 真点一次问号：页面会弹「已打开申请页面：https://…」——
    // 这一条证明按钮 → invoke → 后端 → 系统浏览器 整条链是通的。
    // （副作用：会在默认浏览器里开一个标签页，就是用户点它时该发生的事。）
    await switchTo('baidu');
    await evalJs(sw,
        "document.querySelector('#w-ocrEngList .eng-row[data-id=\"ocrspace\"] .eng-help').click()");
    const toastOk = await waitReady(sw,
        "document.getElementById('toast').textContent.indexOf('已打开申请页面：https://') === 0", 6000);
    const toastTxt = await evalJs(sw, "document.getElementById('toast').textContent");
    ok('R20 点问号 → 页面提示「已打开申请页面：https://…」（整条链真的通了）',
        toastOk && /^已打开申请页面：https:\/\/ocr\.space/.test(toastTxt), String(toastTxt));
    ok('R21 问号打开的是那家**官方申请页**（不是我们自己写的说明页）',
        /ocr\.space\/ocrapi\/freekey/.test(toastTxt), String(toastTxt));

    /* ---------------- ⑥ 配置视图里要有 ocrCreds（设置页靠它渲染） ---------------- */
    const viewOk = await evalJs(sw, "!!CONF.ocrCreds && Object.keys(CONF.ocrCreds).length >= 13");
    ok('R22 config_view 里有 ocrCreds（每个引擎一份，设置页据此显示已填内容）', viewOk === true);

    try { sw.close(); } catch (e) { }
})()
    .catch((e) => ok('r45 探针本身没有抛异常', false, String((e && e.stack) || e)))
    .finally(() => {
        /* 只收自己这一棵进程树，绝不动用户开着的实例 */
        try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        console.log('\n' + pass + '/' + total + ' passed');
        process.exit(pass === total ? 0 : 1);
    });
