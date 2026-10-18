/* ============================================================================
 *  r44：OCR 文本整理（需求 5）+ 设置里的默认开关（需求 7）端到端回归
 *
 *  这一轮加的东西有一个共同点：**每一环都容易"看着有反应、其实没生效"**。
 *    · 设置页控件 → set_setting 是**白名单式**的，不登记就是"点了没存"；
 *    · 配置 → 后端开关掩码（clean_mask_now）中间隔着一次派生；
 *    · 后端掩码 → 结果页按钮的亮灭，隔着一次 qs://config 广播。
 *  所以这个探针不测"函数返回了什么"，而是把这三环**串起来**验：
 *
 *    ① 设置页四个新控件在不在、默认值对不对；
 *    ② 点一下控件 → **磁盘上的 config.json** 真的变了（这是"没存"唯一能抓到的地方）；
 *    ③ 改完设置 → 结果页按钮的亮灭跟着变（广播那条路）；
 *    ④ 后端返回的开关掩码 == 设置里的默认（不动按钮也生效，这才是需求 7）。
 *
 *  ⚠ 隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）：
 *    不动用户正在用的那份配置和日志，也不会 taskkill 掉用户开着的实例。
 *  ⚠ 起窗用 `--settings`（设置页开机就开）+ `--ocr-demo`（结果窗喂假结果），
 *    两个窗口都是应用自己的正常路径，不是测试专用后门。
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const TAG = 'r44clean';
const DIR = path.join(os.tmpdir(), 'qs-r44-' + process.pid);
fs.rmSync(DIR, { recursive: true, force: true });
const QS = path.join(DIR, 'QuickSearch');
fs.mkdirSync(QS, { recursive: true });
const CFG = path.join(QS, 'config.json');
/* 起点：四项里开三项、空格=智能。
 * ocr_clean_* 就是本轮新增的配置键 —— 老配置里没有它们，走 config.rs 的默认值。 */
fs.writeFileSync(CFG, JSON.stringify({
    debug: true,
    ocr_enable: true,
    ocr_engine: 'windows',
    ocr_accurate: false,
    trigger_select: false,
    trigger_copy: false,
    auto_start: false,
    auto_elevate: false,
    theme: 'light',
    ocr_clean_garbage: true,
    ocr_clean_space: 'smart',
    ocr_clean_width: true,
    ocr_clean_unwrap: true,
}, null, 1), 'utf8');

const PORT = 9423;
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
    QS_T_OCR_TEXT: '被断开的第一行\n接上去的第二行。\uFFFD乱码ＡＢＣ１２３',
});
console.log('启动隔离实例（APPDATA=' + DIR + '）');
const p = spawn(EXE, ['--no-elevate', '--settings', '--ocr-demo'],
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

/* ---------------- CDP 小工具（与 r37 同一套） ---------------- */
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
/** 等页面里的 JS 真的跑起来（控件挂上监听才算 boot 完）。 */
async function waitReady(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
        try { if (await evalJs(ws, expr)) return true; } catch (e) { }
        await asleep(300);
    }
    return false;
}

(async () => {
    /* ---------------- ① 设置页：控件在不在、默认值对不对 ---------------- */
    const sw = await findPage(/settings\.html/);
    ok('R1 连上了设置页（--settings 启动参数）', !!sw, 'CDP 列表里没有 settings.html');
    if (sw) {
        const ready = await waitReady(sw,
            "typeof CONF === 'object' && !!document.getElementById('s-ocrCleanSpace')");
        ok('R2 设置页 JS 跑完了（新控件已渲染并挂上监听）', ready);

        const ctl = await evalJs(sw, `(() => {
            const segOn = document.querySelector('#s-ocrCleanSpace button.on');
            return {
                g: !!document.getElementById('s-ocrCleanGarbage'),
                w: !!document.getElementById('s-ocrCleanWidth'),
                u: !!document.getElementById('s-ocrCleanUnwrap'),
                s: !!document.getElementById('s-ocrCleanSpace'),
                segOn: segOn ? segOn.dataset.v : null,
                gChecked: document.getElementById('s-ocrCleanGarbage').checked,
                wChecked: document.getElementById('s-ocrCleanWidth').checked,
            };
        })()`);
        ok('R3 设置页「文字识别」里四个新控件都在（去乱码 / 空格 / 全角半角 / 合并换行）',
            !!(ctl && ctl.g && ctl.w && ctl.u && ctl.s));
        ok('R4 控件按配置里的默认值摆好（空格=智能、去乱码/全角=开）',
            !!ctl && ctl.segOn === 'smart' && ctl.gChecked === true && ctl.wChecked === true,
            JSON.stringify(ctl));

        // 控件摆不对的第一嫌疑永远是"配置视图里压根没这个键"（前端只能退到默认值），
        // 所以单独钉一条：config_view() 必须把这四个键发出来。
        const keys = await evalJs(sw, `(() => {
            const g = (k) => JSON.stringify(CONF[k]);
            return {
                keys: Object.keys(CONF).filter((k) => /clean/i.test(k)).sort().join(','),
                g: g('ocrCleanGarbage'), s: g('ocrCleanSpace'),
                w: g('ocrCleanWidth'), u: g('ocrCleanUnwrap'),
                disk: g('ocrCleanGarbage'),
            };
        })()`);
        ok('R4b config_view 里有这四个新键（否则前端只能退到默认值，怎么点都对不上）',
            keys && keys.keys === 'ocrCleanGarbage,ocrCleanSpace,ocrCleanUnwrap,ocrCleanWidth',
            'keys=' + JSON.stringify(keys && keys.keys) + ' 值=' + JSON.stringify(keys));
        console.log('        [诊断] 配置视图里的四个值：' + JSON.stringify(keys)
            + ' / 磁盘=' + JSON.stringify({
                g: readCfg().ocr_clean_garbage,
                s: readCfg().ocr_clean_space,
                w: readCfg().ocr_clean_width,
                u: readCfg().ocr_clean_unwrap,
            }));

        /* ---------------- ② 点控件 → 磁盘上的 config.json 真的变 ---------------- */
        const clickState = async () => evalJs(sw, `(() => {
            const b = document.getElementById('s-ocrCleanGarbage');
            return { checked: b.checked, conf: JSON.stringify(CONF.ocrCleanGarbage) };
        })()`);
        await evalJs(sw, "document.getElementById('s-ocrCleanGarbage').click()");
        const after1 = await clickState();
        const offOk = await waitCfg((c) => c.ocr_clean_garbage === false);
        ok('R5 点掉「去乱码」→ config.json 里存成 false（白名单登记过才存得下来）',
            offOk, 'disk=' + JSON.stringify(readCfg().ocr_clean_garbage)
            + ' 点完=' + JSON.stringify(after1));

        await evalJs(sw, "document.getElementById('s-ocrCleanGarbage').click()");
        const after2 = await clickState();
        const onOk = await waitCfg((c) => c.ocr_clean_garbage === true);
        ok('R6 再点回来 → config.json 里变回 true', onOk,
            'disk=' + JSON.stringify(readCfg().ocr_clean_garbage)
            + ' 点完=' + JSON.stringify(after2));

        await evalJs(sw, "document.querySelector('#s-ocrCleanSpace button[data-v=force]').click()");
        const forceOk = await waitCfg((c) => c.ocr_clean_space === 'force');
        ok('R7 空格档位切「强力」→ config.json 里存成 force', forceOk,
            'disk=' + JSON.stringify(readCfg().ocr_clean_space));

        try { sw.close(); } catch (e) { }
    }

    /* ---------------- ③④ 结果窗：按钮亮灭 + 后端掩码都跟着设置走 ---------------- */
    const ow = await findPage(/ocr\.html/);
    ok('R8 连上了 OCR 结果窗（--ocr-demo）', !!ow, 'CDP 列表里没有 ocr.html');
    if (ow) {
        await waitReady(ow, "typeof CONF === 'object' && !!document.getElementById('btnGarbage')");
        // 设置改完会广播 qs://config → 结果窗的 CONF 与按钮亮灭跟着走
        let btns = null;
        for (let i = 0; i < 30; i++) {
            btns = await evalJs(ow, `({
                garbage: document.getElementById('btnGarbage').classList.contains('on'),
                width: document.getElementById('btnWidth').classList.contains('on'),
                unwrap: document.getElementById('btnUnwrap').classList.contains('on'),
                smart: document.getElementById('btnSmartSpace').classList.contains('on'),
                force: document.getElementById('btnForceSpace').classList.contains('on'),
            })`);
            if (btns && btns.force && btns.garbage) break;
            await asleep(300);
        }
        ok('R9 结果页按钮亮灭如实反映设置（去乱码/全角/合并亮着，空格亮「强力」）',
            !!btns && btns.garbage && btns.width && btns.unwrap && btns.force && !btns.smart,
            JSON.stringify(btns));

        // 后端开关掩码：不动任何按钮，直接由设置派生（clean_mask_now → config）
        const st = await evalJs(ow, "invoke('ocr_reclean', { mode: 'smart' })");
        ok('R10 后端开关掩码由设置派生：garbage/width/unwrap 都跟着配置走（需求 7 的真效果）',
            !!st && st.garbage === true && st.width === true && st.unwrap === true
            && st.space === 'smart', JSON.stringify(st));

        // 布尔项：on=true / on=false 是**期望状态**，不是"取反"
        const g1 = await evalJs(ow, "invoke('ocr_reclean', { mode: 'garbage', on: false })");
        const g2 = await evalJs(ow, "invoke('ocr_reclean', { mode: 'garbage', on: false })");
        ok('R11 on=false 是幂等的（两次都关，不会因为"取反"又打开）',
            !!g1 && g1.garbage === false && !!g2 && g2.garbage === false,
            JSON.stringify(g1) + ' / ' + JSON.stringify(g2));

        const g3 = await evalJs(ow, "invoke('ocr_reclean', { mode: 'garbage', on: true })");
        ok('R12 on=true 之后确实置位（并且没把其它开关冲掉）',
            !!g3 && g3.garbage === true && g3.width === true && g3.unwrap === true,
            JSON.stringify(g3));

        try { ow.close(); } catch (e) { }
    }
})()
    .catch((e) => ok('r44 探针本身没有抛异常', false, String((e && e.stack) || e)))
    .finally(() => {
        /* 只收自己这一棵进程树，绝不动用户开着的实例 */
        try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        console.log('\n' + pass + '/' + total + ' passed');
        process.exit(pass === total ? 0 : 1);
    });
