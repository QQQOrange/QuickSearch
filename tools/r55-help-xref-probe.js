/* ============================================================================
 *  r55 帮助页「交叉引用」验针
 *
 *  背景：帮助页有 13 节（① ~ ⑩ 加 ⑤b / ⑤c / ⑧b），节与节之间用
 *  「见 ⑤b」「帮助 ②」这种文字互相指。这种手写引用**没有编译器兜底** ——
 *  节一多、一改名，引用就指向错的块，用户顺着点过去看到不相关的内容，
 *  比没有引用更糟（至少没有的时候用户知道得自己找）。
 *
 *  这个探针把帮助正文里所有「N / Nx」形式的引用抠出来，逐个核对：
 *    ① 引用的节号**真实存在**；
 *    ② 引用的节标题**和指的事情对得上**（用一组人工核对表，不是模糊匹配）；
 *    ③ 引用自己的那一节里不该出现「见自己」（自己引自己毫无意义）。
 *
 *  用法：node tools/r55-help-xref-probe.js     输出：tools/r55-help-xref-probe.txt
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r55-help-xref-probe.txt');
const PORT = 9388;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}
let msgId = 0;
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            ws.removeEventListener('message', onMsg);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
const evalJs = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'ERR ' + r.exceptionDetails.text : r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
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

/** 人工核对表：**源节号** → 目标节号 → 目标节标题必须含有的关键词。
 *
 *  这张表是**人写的**（探针没法猜"提到玻璃应该指向哪节"），但它把"引用对不对"
 *  从「看代码的人心里有数」变成了「每次跑探针都查一遍」。
 *
 *  ⚠ 源节写**节号**（① ~ ⑩）不是分页名：帮助页的节和设置页的分页不是一回事，
 *    第一版这里误写成了分页名（general / engines…），八条全红。
 */
const XREF = [
    ['⑤', '⑤b', '识图'],    // ⑤ OCR 末尾提「框的是图片？见 ⑤b」
    ['⑤b', '⑤c', '路径'],   // 识图节里提「📁 那颗」
    ['⑤c', '⑤b', '识图'],   // 路径节里提「选中图片想搜图见 ⑤b」
    ['⑦', '⑤b', '识图'],    // 快捷键节里提「识图没有快捷键，见 ⑤b」
    ['⑦', '⑤c', '路径'],    // 快捷键节里提「选中路径多一颗 📁，见 ⑤c」
    ['③', '⑦', '快捷键'],   // 引擎节里提「键位怎么录见 ⑦」
    ['③', '④', 'AI'],       // 引擎节里提「AI 后缀怎么改见 ④」
    ['⑧b', '⑧', '备份'],   // 明文导出节里提「和 ⑧ 备份是两件事」
    ['⑩', '⑧b', '明文'],   // 数据位置节里提「.qsconf 怎么分享见 ⑧b」
];

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r55xref-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    const TAG = 'r55xref' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: TAG, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('r55 帮助交叉引用探针：pid=' + proc.pid + '  标记=' + TAG);
    sleep(10000);
    const ws = await connect('settings.html');
    if (!ws) { rec('设置页 CDP 连不上'); flush(); process.exit(1); }

    await evalJs(ws, `document.querySelector('#tabs button[data-tab="help"]').click()`);
    await sleep(1500);

    /* ---- 1. 取出所有小节的「节号 + 标题 + 正文」 ---- */
    const secs = await evalJs(ws,
        `(function(){
           const out = [];
           for (const d of document.querySelectorAll('.help-item')) {
             const s = d.querySelector('summary');
             const b = d.querySelector('.help-body');
             out.push({ title: s.textContent.trim(), body: b ? b.textContent : '' });
           }
           return out;
         })()`);
    if (!Array.isArray(secs) || !secs.length) {
        check('帮助页能打开且有内容', false, '小节数 ' + (secs ? secs.length : 0));
        try { proc.kill(); } catch (e) { }
        flush(); process.exit(1);
    }
    check('帮助页能打开且有内容（' + secs.length + ' 节）', true);
    rec('帮助小节：');
    for (const s of secs) rec('    ' + s.title.slice(0, 60));

    /* 每节的节号：从标题开头抠（① ~ ⑩、⑤b、⑤c、⑧b） */
    // ⚠ 同上：圈号显式列出，不写字符区间（区间写错会直接正则编译失败）。
    const CIRCLED_NUM = '①②③④⑤⑥⑦⑧⑨⑩';
    const numOf = (title) => {
        const m = new RegExp('^([' + CIRCLED_NUM + ']+[a-c]?)').exec(title.trim());
        return m ? m[1] : null;
    };
    const byNum = {};
    for (const s of secs) {
        const n = numOf(s.title);
        if (n) byNum[n] = s;
    }
    rec('');
    rec('识别到的节号：' + Object.keys(byNum).join(' '));
    check('十三个主/附节都有节号（编号没漏没重）', Object.keys(byNum).length === 13,
        Object.keys(byNum).length + ' 个');

    /* ---- 2. 正文里所有「N」形式的引用都必须指向真实存在的节 ---- */
    // 引用形态：`见 ⑤b`、`帮助 ②`、`（见 ⑤c）`、`见 ⑤b / ⑤c`
    // ⚠ 圈号**不能写字符区间**：① = U+2460 … ⑩ = U+2469 是连续的，但
    //   一旦把上界写成 ⑳(U+2473) 之外的字符，正则直接报 "Range out of order"。
    //   这里显式列出 ① ~ ⑩ 十个字符，稳且一眼看得出覆盖了哪些。
    const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
    const REF_RE = new RegExp('([' + CIRCLED + '])([a-c])?', 'g');
    let dangling = [];
    const refCount = {};
    for (const s of secs) {
        const me = numOf(s.title);
        let m;
        REF_RE.lastIndex = 0;
        while ((m = REF_RE.exec(s.body)) !== null) {
            const ref = m[1] + (m[2] || '');
            refCount[ref] = (refCount[ref] || 0) + 1;
            if (!byNum[ref]) dangling.push('「' + me + '」→ 不存在的 ' + ref);
            else if (ref === me) dangling.push('「' + me + '」引用了自己');
        }
    }
    rec('');
    rec('正文里出现的引用（节号 → 次数）：');
    for (const k of Object.keys(refCount).sort()) rec('    ' + k + ' → ' + refCount[k]);
    check('所有交叉引用都指向真实存在的节（没有指向空的编号）', dangling.length === 0,
        dangling.slice(0, 6).join('; '));

    /* ---- 3. 人工核对表：引用者的语境 ↔ 被引用节的主题 ---- */
    rec('');
    for (const [from, to, kw] of XREF) {
        const src = secs.find((s) => numOf(s.title) === from);
        const dst = byNum[to];
        if (!src) { check(from + ' → ' + to + '（源节存在）', false, '源节没找到'); continue; }
        if (!dst) { check(from + ' → ' + to + '（目标节存在）', false, '目标节没找到'); continue; }
        // 源节正文里必须真的提到了这个节号
        const mentions = new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(src.body);
        check(from + ' 节里确实提到了 ' + to, mentions);
        // 目标节标题必须含关键词（证明指对了地方，不是指到名字相近的另一节）
        check(to + ' 节的主题确实是「' + kw + '」', dst.title.indexOf(kw) >= 0, dst.title.slice(0, 40));
    }

    /* ---- 4. 老引用口径别漂：节号顺序必须单调 ---- */
    const order = ['①', '②', '③', '④', '⑤', '⑤b', '⑤c', '⑥', '⑦', '⑧', '⑧b', '⑨', '⑩'];
    const got = secs.map((s) => numOf(s.title)).filter(Boolean);
    check('小节排列顺序符合编号顺序（①→⑩，附节插在亲节后面）',
        order.length === got.length && order.every((o, i) => got[i] === o),
        got.join(' '));

    rec('');
    rec('========== r55 帮助交叉引用：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
