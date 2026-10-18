/* ============================================================================
 *  本地 OCR 环境检测 —— 真机探针（零物理输入，全程 CDP）
 *
 *  验证目标（用户本轮需求）：
 *    ① 设置窗一打开就自动检测（boot 时机），检测结果落在 #w-ocrDep 卡片里；
 *    ② invoke('ocr_env_check') 真实返回三项依赖，字段齐全（后端只读检测）；
 *    ③ 界面渲染与真实检测结果一致：全就绪→绿卡，缺项→黄卡「缺 N 项组件」；
 *    ④ 每个组件都写明「作用」；缺项另有「现状/怎么补」；
 *    ⑤ 按钮齐全：缺项给「一键安装」（winrt 缺再加「查看官方教程」），
 *       任何时候都有「重新检测」；点「重新检测」真的会重跑检测；
 *    ⑥ 切到「Windows 本地」引擎会顺带刷新检测，并把引擎写回隔离配置。
 *
 *  ⚠ 不点「一键安装」「查看官方教程」—— 那两个会真的打开系统设置页 /
 *    浏览器，探针只验证 DOM 里按钮存在、文案正确。
 *
 *  用法：node tools/ocr-dep-probe.js
 * ===========================================================================
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'ocr-dep-probe.txt');
const PORT = 9422;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0, skipN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function skip(name, why) { skipN++; rec('  SKIP  ' + name + '   [' + why + ']'); }
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }

/* ------------------------------ CDP ------------------------------ */
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
        const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text)
            + (desc ? ' | ' + String(desc).split('\n')[0] : '')
            + ' | ' + String(expr).slice(0, 120));
    }
    return r.result.value;
}
async function targets() {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); }
    catch (e) { return []; }
}
async function connectWhere(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
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
const isSettingsPage = (u) => /settings\.html/.test(u);
async function waitInvoke(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        try {
            if ((await evalJs(ws, "typeof invoke === 'function' && typeof listen === 'function'")) === true) return true;
        } catch (e) { }
        await sleep(300);
    }
    return false;
}
/** 点一下元素（CDP 内 element.click()，零物理输入） */
async function clickEl(ws, sel) {
    return evalJs(ws, `(() => { const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return false; e.click(); return true; })()`);
}
/** 等 #w-ocrDep 重新渲染出 banner（点 recheck / 切 tab 后内部先亮 .dep-tip） */
async function waitDepBanner(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
        try {
            if (await evalJs(ws, "!!document.querySelector('#w-ocrDep .dep-banner')")) return true;
        } catch (e) { }
        await sleep(250);
    }
    return false;
}
async function shot(ws, name) {
    try {
        const r = await cdp(ws, 'Page.captureScreenshot',
            { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
        rec('  [截图] ' + name);
    } catch (e) { rec('  WARN  截图失败 ' + name + ' → ' + e.message); }
}

/* ------------------------------ 实例工厂 ------------------------------ */
function makeConf(dir, extra) {
    const qs = path.join(dir, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const c = Object.assign({
        trigger_copy: false, trigger_select: true, ocr_enable: false,
        auto_color: false, auto_start: false, delay_ms: 0,
        filter_mode: 'off', filter_list: [],
        webdav_url: '', webdav_user: '', webdav_pass: '',
        webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
        backup_dir: '', overrides: {}, fav_hotkey: '',
        custom_engines: [],
        bar_glass: false,
        bar_dim_alpha: 100,
        theme: 'light',
        fav_panel_sizes: {},
        ocr_engine: 'baidu',
    }, extra || {});
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    return qs;
}

const TAG = 'qdep';
let child = null;
let qsLive = null;

function spawnInstance(qs) {
    const appData = path.dirname(qs);
    const env = Object.assign({}, process.env, {
        APPDATA: appData, LOCALAPPDATA: appData,
        WEBVIEW2_USER_DATA_FOLDER: path.join(path.dirname(appData), 'wv2-' + TAG),
        QS_DEBUG: '1',
        QS_INSTANCE_TAG: TAG,
        QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
            + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT,
    });
    child = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动实例 pid=' + child.pid + '（CDP ' + PORT + '，隔离 APPDATA=' + appData + '）');
}
function killInstance() {
    // 只杀自己 spawn 的隔离实例。⚠ 不要用 taskkill /IM QuickSearch.exe ——
    // 那会把用户正在运行的真实实例一起杀掉。
    if (child) { try { child.kill(); } catch (e) { } }
    sleep(600);
}

/* ------------------------------ 主流程 ------------------------------ */
(async function main() {
    const dir = path.join(os.tmpdir(), 'qs-ocrdep');
    fs.rmSync(dir, { recursive: true, force: true });
    const qs = makeConf(dir, {});
    qsLive = qs;
    spawnInstance(qs);

    const ws = await connectWhere(isSettingsPage, 35000);
    if (!ws) { rec('连不上设置页 CDP —— 收场'); killInstance(); flush(); process.exit(1); }
    rec('已连上设置页 CDP');
    if (!await waitInvoke(ws)) { rec('invoke 没就绪 —— 收场'); killInstance(); flush(); process.exit(1); }

    /* ============ A1 后端检测：真实返回三项依赖 ============ */
    rec('');
    rec('=== A1 后端检测（invoke ocr_env_check）===');
    let items = null;
    try {
        items = await evalJs(ws, "invoke('ocr_env_check')");
    } catch (e) {
        rec('  FAIL  调用失败 → ' + e.message);
    }
    if (!Array.isArray(items)) {
        chk('ocr_env_check 返回数组', false, JSON.stringify(items).slice(0, 120));
    } else {
        chk('ocr_env_check 返回数组', true, items.length + ' 项');
        chk('覆盖三项依赖：winrt / lang / profile',
            items.length === 3 && ['winrt', 'lang', 'profile'].every((id) => items.some((x) => x.id === id)),
            items.map((x) => x.id).join(','));
        const fieldOk = items.every((x) =>
            typeof x.name === 'string' && x.name &&
            typeof x.purpose === 'string' && x.purpose &&
            typeof x.detail === 'string' &&
            typeof x.fix === 'string' && typeof x.ok === 'boolean');
        chk('每项字段齐全（name/purpose/detail/fix/ok）', fieldOk,
            items.map((x) => x.id + '=' + (x.ok ? 'ok' : 'miss')).join(' '));
    }
    const miss = Array.isArray(items) ? items.filter((x) => !x.ok) : [];
    const winrtMiss = miss.some((x) => x.id === 'winrt');
    const allOk = Array.isArray(items) && miss.length === 0;
    info('本机检测结果', allOk ? '三项全就绪'
        : '缺 ' + miss.length + ' 项：' + miss.map((x) => x.name).join('、')
            + '（' + miss.map((x) => x.detail).join(' / ') + '）');

    /* ============ A2 折叠态 → 点按钮才检测（r46 改口径） ============ */
    rec('');
    rec('=== A2 默认折叠；点「检测本地 OCR 环境」才真去检测 ===');
    const domState = () => evalJs(ws, `(() => {
        const box = document.querySelector('#w-ocrDep');
        if (!box) return null;
        const banner = box.querySelector('.dep-banner');
        return {
            hasBanner: !!banner,
            bannerCls: banner ? banner.className : '',
            bannerText: banner ? banner.textContent.trim().slice(0, 60) : '',
            items: box.querySelectorAll('.dep-item').length,
            okItems: box.querySelectorAll('.dep-item.is-ok').length,
            missItems: box.querySelectorAll('.dep-item.is-miss').length,
            fixRows: [...box.querySelectorAll('.dep-line')].filter((d) => {
                const i = d.querySelector('i'); return i && i.textContent === '怎么补';
            }).length,
            purposeRows: [...box.querySelectorAll('.dep-line')].filter((d) => {
                const i = d.querySelector('i'); return i && i.textContent === '作用';
            }).length,
            langBtn: !!box.querySelector('button[data-act="lang"]'),
            helpBtn: !!box.querySelector('button[data-act="help"]'),
            recheckBtn: !!box.querySelector('button[data-act="recheck"]'),
            badges: [...box.querySelectorAll('.dep-badge')].map((b) => b.textContent.trim()),
        }; })()`);
    let st = await domState();
    /* ⚠ r46 改口径（用户要求）：「这个环境检测你直接提供一个按钮，我没点击，
     *   他就不用告诉我说是否已准备就绪」。所以 boot 时必须是**折叠态**：
     *   没有 banner、没有依赖卡片，只有一颗按钮。 */
    chk('boot 时是折叠态：没有检测结论、也没有自动去检测',
        st && !st.hasBanner && st.items === 0, JSON.stringify(st));
    chk('折叠态给了一颗「检测本地 OCR 环境」按钮',
        await evalJs(ws, "!!document.querySelector('#w-ocrDep button[data-act=\"check\"]')") === true);
    const clickedCheck = await clickEl(ws, '#w-ocrDep button[data-act="check"]');
    chk('找到并点了「检测本地 OCR 环境」', clickedCheck);
    chk('点了立刻亮「正在检测」占位（同步重排）',
        await evalJs(ws, "!!document.querySelector('#w-ocrDep .dep-tip')") === true);
    chk('随后 banner 渲染出来（检测跑完）', await waitDepBanner(ws));
    st = await domState();
    chk('三项依赖卡片都渲染出来了', st && st.items === 3, st && ('ok=' + st.okItems + ' miss=' + st.missItems));
    chk('每个组件都写明了「作用」', st && st.purposeRows === 3, st && st.purposeRows + ' 行');
    if (allOk) {
        chk('全就绪 → 绿色 banner（.dep-banner.ok）', st && st.bannerCls.includes('ok'), st && st.bannerCls);
        chk('  文案含「环境就绪」', st && /环境就绪/.test(st.bannerText), st && st.bannerText);
        chk('  三个徽标全写「已就绪」',
            st && st.badges.length === 3 && st.badges.every((b) => b === '已就绪'),
            st && st.badges.join(','));
        chk('  就绪项不给「怎么补」行', st && st.fixRows === 0, st && st.fixRows + ' 行');
        chk('  不出现「一键安装」按钮', st && !st.langBtn);
    } else {
        chk('缺 ' + miss.length + ' 项 → 黄色 banner（.dep-banner.miss）',
            st && st.bannerCls.includes('miss'), st && st.bannerCls);
        chk('  banner 明说「缺 ' + miss.length + ' 项组件」',
            st && st.bannerText.indexOf('缺 ' + miss.length + ' 项组件') >= 0, st && st.bannerText);
        chk('  缺项徽标写「待补充」（' + st && st.missItems + ' 个）',
            st && st.missItems === miss.length && st.badges.filter((b) => b === '待补充').length === miss.length,
            st && st.badges.join(','));
        chk('  每个缺项都有「怎么补」行', st && st.fixRows === miss.length, st && st.fixRows + ' 行');
        chk('  出现「一键安装：打开语言设置」按钮', st && st.langBtn);
        if (winrtMiss) chk('  引擎本体也缺 → 追加「查看官方教程」按钮', st && st.helpBtn);
        else chk('  引擎本体没缺 → 不出现「查看官方教程」', st && !st.helpBtn);
    }
    chk('「重新检测」按钮常在（任何状态都在）', st && st.recheckBtn);

    /* ============ A3 切到 OCR 标签页：沿用缓存，不再自动检测 ============ */
    rec('');
    rec('=== A3 切到「文字识别」标签页：沿用缓存、不再自动检测 ===');
    const clickedTab = await clickEl(ws, 'button[data-tab="ocr"]');
    chk('找到并点了「文字识别」标签', clickedTab);
    // r46：切页不再触发检测（缓存还在就直接重画，连"正在检测"占位都不该出现）
    sleep(500);
    chk('切页不会清成「正在检测」占位（缓存结果直接沿用）',
        await evalJs(ws, "!document.querySelector('#w-ocrDep .dep-tip')") === true);
    st = await domState();
    chk('切页后卡片仍在、且与检测结果一致（is-ok=' + (st && st.okItems) + ' is-miss=' + (st && st.missItems) + '）',
        st && st.items === 3 && st.okItems + st.missItems === 3
        && (allOk ? st.bannerCls.includes('ok') && !st.langBtn
                  : st.bannerCls.includes('miss') && st.bannerText.indexOf('缺 ' + miss.length + ' 项') >= 0),
        st && st.bannerCls + ' | ' + st.bannerText);

    /* ============ A4 重新检测按钮：真的重跑 ============ */
    rec('');
    rec('=== A4 点「重新检测」===');
    const clickedRc = await clickEl(ws, '#w-ocrDep button[data-act="recheck"]');
    chk('找到并点了「重新检测」', clickedRc);
    chk('点了立刻亮「正在检测」占位（同步重排）',
        await evalJs(ws, "!!document.querySelector('#w-ocrDep .dep-tip')") === true);
    chk('占位之后 banner 又回来了（检测跑完）', await waitDepBanner(ws));
    st = await domState();
    chk('重检后结果一致（没把状态改坏）',
        st && st.items === 3 && (allOk ? st.bannerCls.includes('ok') : st.bannerCls.includes('miss')),
        st && st.bannerCls);

    /* ============ A5 切引擎：不再顺带检测，但设置要写回配置 ============ */
    rec('');
    rec('=== A5 切「本地识别」引擎：不再顺带检测，但写回配置 ===');
    // ⚠ 引擎选择器从 r45 起是**列表**（#w-ocrEngList，一行一家）——
    //   老的两档 seg（#s-ocrEngine button[data-v=…]）已经不存在了。
    const clickedEng = await clickEl(ws, '#w-ocrEngList .eng-row[data-id="windows"] .eng-name');
    chk('找到并点了「本地识别」那一行', clickedEng);
    sleep(500);
    chk('切引擎不再自动检测（改成按需了）',
        await evalJs(ws, "!document.querySelector('#w-ocrDep .dep-tip')") === true);
    const baiduHidden = await evalJs(ws, `[...document.querySelectorAll('[data-baidu-only]')]
        .every((r) => r.style.display === 'none')`);
    chk('切到本地引擎后百度专用行整体隐藏', baiduHidden === true);
    // set_setting 写盘 → 隔离配置里应出现 "ocr_engine": "windows"
    let cfgOk = false, cfgTxt = '';
    for (let i = 0; i < 20; i++) {
        try { cfgTxt = fs.readFileSync(path.join(qs, 'config.json'), 'utf8'); } catch (e) { cfgTxt = ''; }
        if (/"ocr_engine"\s*:\s*"windows"/.test(cfgTxt)) { cfgOk = true; break; }
        await sleep(300);
    }
    chk('引擎切换写回隔离配置（ocr_engine=windows）', cfgOk, cfgOk ? '配置已落盘' : '20 次轮询未见');

    /* ============ A6 截图留证 ============ */
    rec('');
    rec('=== A6 截图 ===');
    await shot(ws, 'ocr-dep-pane.png');

    /* ============ 收场 ============ */
    killInstance();
    rec('');
    rec('总结: ' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    process.exit(failN === 0 ? 0 : 1);
})().catch((e) => {
    rec('探针异常: ' + (e && (e.stack || e.message || String(e))));
    killInstance();
    flush();
    process.exit(1);
});
