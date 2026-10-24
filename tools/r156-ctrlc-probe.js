/* r156 探针：验证「Ctrl+C 哪怕没复制到文本，也必须弹横条」。
 *
 * 为什么要有这个探针（v1.5.6）：
 *   用户原话：「按 control 加 c 的时候，就哪怕没有复制到文本，那也得换出横条，
 *   这是一个逻辑问题」。也就是说 Ctrl+C 是**独立的第二条唤起通道**，不能挂在
 *   "剪贴板必须变"这个前提上。
 *
 *   这条口径没法只用单测证明（单测只覆盖 ctrl_copy_bar 这个判定，不覆盖
 *   read_current 的等待、空条弹出、late_text_patch 的接续）。所以这里调
 *   `__probe_copy_trigger` 把「按了一次 Ctrl+C」完整走一遍真路径：
 *     · copy = null    → 模拟"按了但什么都没复制到"
 *     · copy = '文字'  → 模拟"复制成功"
 *   然后读真日志断言横条真的出来、字数是 0 还是 N、走的是哪条分支。
 *
 *   ⚠ 关键安全属性：空条**绝不能**装上次剪贴板的旧内容（那是 2026-10-23 用户
 *     报的「横条莫名其妙出来」的真正原因）。所以先用 copy 写一段 7 字的旧内容，
 *     再调一次 copy=null，断言第二次是 **0 字** 而不是 10 字。
 *
 * 用法: node tools/r156-ctrlc-probe.js
 * 前提: cargo build --release
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const DATA = path.join(ROOT, 'target', 'release', 'Quick search data');
const OUT = path.join(__dirname, 'r156-ctrlc.txt');
const PORT = 9428;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra === undefined ? '' : '   [' + extra + ']')); }
}

let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (x.id !== i) return;
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails
        ? 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)
        : r.result.value;
};

async function connect(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && /(index\.html|\/)$/.test(t.url || ''));
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

const LOG = path.join(DATA, 'log.txt');
/* off 是**字节**偏移（statSync().size），必须按 Buffer 切 —— utf8 里一个汉字
 * 3 字节、一个字符，字节偏移当字符下标用会切过头（r155 探针踩过这个坑）。 */
const readLogFrom = (off) => {
    try {
        const b = fs.readFileSync(LOG);
        return b.subarray(Math.min(off, b.length)).toString('utf8');
    } catch (e) { return ''; }
};
const logSize = () => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } };

/** 本次调用之后**第一条**匹配的行（不是最后一条：探针实例也装着全局钩子，
 *  期间用户真按一次 Ctrl+C 就会多一条，取最后一条会读到别人的）。 */
function firstLine(txt, needle) {
    const lines = txt.split(/\r?\n/).filter((s) => s.indexOf(needle) >= 0);
    return lines.length ? lines[0] : null;
}
const firstShowChars = (txt) => {
    const s = firstLine(txt, 'show_bar: ');
    if (!s) return null;
    const m = s.match(/show_bar: (\d+) 字/);
    return m ? +m[1] : null;
};
const firstShowAtMouse = (txt) => {
    const s = firstLine(txt, 'show_bar: atMouse=');
    if (!s) return null;
    const m = s.match(/atMouse=(\w+)/);
    return m ? m[1] : null;
};

(async () => {
    if (!fs.existsSync(EXE)) { rec('没找到 ' + EXE + '，先 cargo build --release'); process.exit(1); }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r156-'));
    const env = Object.assign({}, process.env, {
        QS_DEBUG: '1',
        QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r156' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r156 探针：pid=' + proc.pid + '（不影响已部署的那个实例）');
    await sleep(8000);

    const ws = await connect();
    if (!ws) { rec('连不上横条页面'); try { proc.kill(); } catch (e) { } process.exit(1); }

    for (let i = 0; i < 40; i++) {
        const ok = await ev(ws, `!!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)`);
        if (ok) break;
        await sleep(250);
    }
    const pre = await ev(ws, `window.__TAURI__.core.invoke('get_config')
        .then(function(c){ return JSON.stringify({ barNeedText: c.barNeedText, triggerCopy: c.triggerCopy }); })
        .catch(function(e){ return 'ERR ' + e; })`);
    rec('预检 config -> ' + pre);

    const invoke = (arg) => ev(ws, `window.__TAURI__.core.invoke('__probe_copy_trigger', ${arg})
        .then(function(v){ return 'ok seq=' + v; }).catch(function(e){ return 'ERR ' + e; })`);

    /* ---------- ① 复制成功：文字必须真的进横条 ---------- */
    const off1 = logSize();
    const r1 = await invoke(`{ copy: 'OLDCONTENT' }`);   // 10 个字母，数起来不会错
    rec('[copy] invoke __probe_copy_trigger -> ' + r1);
    await sleep(1200);
    const txt1 = readLogFrom(off1);
    const chars1 = firstShowChars(txt1);
    check('[copy] 复制成功时横条弹出来了（after-show visible=true）',
        !!firstLine(txt1, 'after-show: visible=true'));
    check('[copy] 文字真的进了横条（show_bar 记 10 字）', chars1 === 10, 'chars=' + chars1);
    check('[copy] Ctrl+C 这条路贴鼠标（atMouse=true）', firstShowAtMouse(txt1) === 'true',
        'atMouse=' + firstShowAtMouse(txt1));

    /* ---------- ② 没复制到东西：照样弹，且必须是空条 ---------- */
    const off2 = logSize();
    const r2 = await invoke('{ copy: null }');
    rec('[no-copy] invoke __probe_copy_trigger -> ' + r2);
    await sleep(1600);   // 120ms 等待 + 弹窗 + late_text_patch 的 900ms 都走完
    const txt2 = readLogFrom(off2);
    const chars2 = firstShowChars(txt2);
    check('[no-copy] 真的弹出来了（after-show visible=true）',
        !!firstLine(txt2, 'after-show: visible=true'),
        txt2.split(/\r?\n/).slice(-3).join(' | '));
    check('[no-copy] 走的是"没等到剪贴板变化"那条分支',
        !!firstLine(txt2, '剪贴板序号都没变 —— 这次没复制到东西，照样弹空条'));
    check('[no-copy] 横条是空的（0 字）', chars2 === 0, 'chars=' + chars2);
    check('[no-copy] 没有复用剪贴板里的旧内容（10 字 → 0 字）',
        chars2 === 0 && chars1 === 10, '前=' + chars1 + ' 后=' + chars2);

    /* ---------- ③ barNeedText 开着也必须弹（默认值就是开） ---------- */
    const cfg = JSON.parse(pre);
    check('[no-copy] 「划选没取到文字就不弹」开着也照样弹（Ctrl+C 不受它管）',
        cfg.barNeedText === true, 'barNeedText=' + cfg.barNeedText);

    rec('');
    rec(`结果：${pass} PASS / ${fail} FAIL`);
    try { proc.kill(); } catch (e) { }
    process.exit(fail ? 1 : 0);
})().catch((e) => { rec('探针异常：' + (e && e.stack || e)); process.exit(2); });
