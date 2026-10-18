/* ============================================================================
 *  r37：OCR 结果窗（并行模式）行为回归
 *
 *  本轮修了 ocr.html 里四件事，全都是"用户看得见但没人测过"的：
 *    ① 并行模式下 `input` 监听只挂在 #text 上（真正可编辑的是 #textLocal/
 *       #textBaidu）→ 往百度框里粘网址，「打开链接」按钮不出现；
 *    ② `lastPart` 跨图活着 → 换新图后另一个引擎的框先显示**上一张图的文字**，
 *       而且链接按钮会连藏起来的框一起扫，于是"打开链接"打开的是上一张图的网址；
 *    ③ `setText` 把"空结果"当"没数据"→ 框到空白区域时文本框留着上一张图的文字；
 *    ④ 扫描中只禁用引擎段控，另外三颗按钮仍可点 → 同一张图并发跑两次 OCR。
 *
 *  验证方式：页面自己带自检（`ocrSelfTest`，跑在**真 WebView** 里量 DOM），
 *  结果按 `[ocrselftest] PASS/FAIL xxx` 写进实例日志。本探针用 `--ocr-demo`
 *  把结果窗叫起来（QS_T_OCR_TEXT 喂假结果，绕开真实 OCR 额度），再捞日志。
 *
 *  ⚠ 隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）：
 *    不动用户正在用的那份配置和日志，也不会 taskkill 掉用户开着的实例。
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
/* 真鼠标输入（R7 用）：取词的触发源是全局鼠标钩子，DOM 里改选区根本不经过钩子，
 * 所以"在结果窗里划选"这件事只能用真鼠标事件去演。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const GetTopWindow = user32.func('void *GetTopWindow(void *h)');
const GetDesktopWindow = user32.func('void *GetDesktopWindow()');
const GetWindow = user32.func('void *GetWindow(void *h, uint32 cmd)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, void *buf, int max)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 1, LDOWN = 2, LUP = 4, ABS = 0x8000;
const moveTo = (x, y) => mouse_event(MOVE | ABS,
    Math.round(Math.max(0, Math.min(SW - 1, x)) * 65535 / (SW - 1)),
    Math.round(Math.max(0, Math.min(SH - 1, y)) * 65535 / (SH - 1)), 0, 0);

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const TAG = 'r37ocr';
const DIR = path.join(os.tmpdir(), 'qs-r37');
fs.rmSync(DIR, { recursive: true, force: true });
const QS = path.join(DIR, 'QuickSearch');
fs.mkdirSync(QS, { recursive: true });
/* debug=true 是自检的开关（见 ocr.html boot 里 `if (CONF && CONF.debug)`）。
 * auto_start/auto_elevate 关掉：测试实例不许写注册表、不许弹 UAC。 */
fs.writeFileSync(path.join(QS, 'config.json'), JSON.stringify({
    debug: true,
    ocr_enable: true,
    ocr_engine: 'windows',
    ocr_accurate: false,
    trigger_select: false,
    trigger_copy: false,
    auto_start: false,
    auto_elevate: false,
    theme: 'light',
    // R8（需求 6）：面板也得是液态玻璃 —— 这一项开着，横条/面板才会走
    // glass.js 那条渲染路（Rust 抓屏 → WebGL2 画布）。
    bar_glass: true,
}, null, 1), 'utf8');

const LOG = path.join(QS, 'log.txt');
const PORT = 9421;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } };

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
    /* CDP：R5 那一段要**在真页面里**改设置、再看本窗口的 CONF / 版式跟没跟上
     * （这是"设置广播发不发 ocr 窗口"唯一的端到端验证手段）。 */
    QS_T_WV_ARGS: '--remote-debugging-port=' + PORT,
    QS_T_OCR_TEXT: '示例识别结果 QuickSearch 12345\n官网 https://example.com/docs 和 www.test.org/b 都可打开',
});
console.log('启动隔离实例（APPDATA=' + DIR + '）');
const p = spawn(EXE, ['--no-elevate', '--ocr-demo'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });

/* 自检的最后一条断言是「扫描结束：这些按钮恢复可点」—— 等它出现就说明整轮
 * 断言都跑完了（自检是一次性把 20 多条一起 log_msg 出来的）。 */
const DONE = '扫描结束：这些按钮恢复可点';
let seg = '';
let done = false;
for (let i = 0; i < 100; i++) {          // 最多等 ~50s
    sleep(500);
    seg = logText();
    if (seg.includes(DONE)) { done = true; break; }
}
if (!done) seg = logText();

const lines = seg.split('\n').filter((l) => l.includes('[ocrselftest]'));
ok('R1 页面自检跑起来了（真 WebView 里检查 DOM）', lines.length > 0,
    '实例日志里一条 [ocrselftest] 都没有 —— 说明页面脚本没跑到自检那步'
    + '（debug 没开？窗口没起来？）\n        日志尾部：' + seg.slice(-400));

for (const l of lines) {
    const m = l.split('[ocrselftest]')[1].trim();
    ok('R2 ' + m, !/^FAIL/.test(m));
}

/* 本轮新增的 7 条断言必须**真的跑到**（不是被 if 跳过、也不是没执行到）。
 * 只断言"没有 FAIL"是不够的：一条断言压根没执行也会"没有 FAIL"。 */
const NEED = [
    'r47：双框时代的残留元素确实没有了（没有 dual / textLocal / textBaidu）',
    'r50：「都看」+ 两家 → 一家一个文本框（#text 让位；再切回一家时复原）',
    '文本区空着时「打开链接」按钮藏着',
    '文本区里敲进一个网址后按钮出现（input 监听到位）',
    '把网址删掉后按钮又藏回去',
    '换新图后不再残留上一张图的分段结果',
    '换新图后「打开链接」按钮与框里的文字一致（不会因上一张图的网址亮着）',
    'setText("") 会把文本框清空（空结果 ≠ 没数据）',
    '扫描中：「重新识别」和五颗文本整理按钮都禁用',
    '扫描结束：这些按钮恢复可点',
    // 需求 5：文本整理按钮组（r44 新增）
    '文本整理按钮齐全（去乱码 / 全角半角 / 合并换行 + 智能·强力去空格）',
    'syncCleanBtns：开关状态 → 按钮亮灭一致',
    'syncCleanBtns：智能档只亮「智能去空格」',
    // r47：段控只列参与名单
    'r47：只参与一家时段控整块藏起来',
    'r47：没参与的引擎一个都不出现在段控里',
    'r47：段控只列参与的两家 + 都看',
    /* r49：默认档口径**变了**（用户报的 bug：默认引擎还没出结果时结果窗自动跳到本地）。
     *  ⚠ 这是**期望值更新**，不是把失败藏起来：以前那三条断言写的是旧行为
     *    （"先显示有字的那家""谁都没字退回都看"），新行为见 config.rs 的
     *    ocr_stay_default 与 ocr.html 的 pickDefaultMode。 */
    'r49 默认档：默认引擎（硅基流动）有字 → 显示它',
    'r49 默认档：默认引擎还没回来 → **仍然停在默认引擎**（不自动跳到本地）',
    'r49 默认档：谁都没字 → 也还是默认引擎那一档（显示它的等待文案）',
    'r49 关掉「固定在默认引擎」后：先显示有字的那家（旧口径）',
    'r49 关掉开关后：谁都没字 → 退回「都看」（旧口径）',
    'r49：没勾本地时它不在参与名单里',
];
for (const n of NEED) {
    ok('R3 本轮新增断言确实执行了：' + n, lines.some((l) => l.includes(n)));
}

const fails = lines.filter((l) => /\[ocrselftest\] FAIL/.test(l));
ok('R4 自检整体没有任何 FAIL', fails.length === 0, fails.join('\n        '));

/* ============================================================================
 *  R5：设置广播（qs://config）必须也发给 OCR 结果窗
 *
 *  修之前 `broadcast()` 只发 bar / settings，`CONF` 只在 boot 取一次 ——
 *  "开着结果窗去设置里打开双引擎并行、再框一次"拿到的还是旧版式。
 *  这里用 CDP 在**真页面里**改设置（set_setting → Rust broadcast），
 *  再看本窗口的 CONF 和版式跟没跟上。
 * ========================================================================== */
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
    if (r.exceptionDetails) throw new Error('JS: ' + String(expr).slice(0, 100));
    return r.result.value;
}
async function findPage(re, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
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

async function configBroadcastTest() {
    const ws = await findPage(/ocr\.html/);
    ok('R5 连上了 OCR 结果窗的 CDP 页面', !!ws, 'CDP 列表里没找到 ocr.html');
    if (!ws) return;
    for (let i = 0; i < 40; i++) {
        try { if (await evalJs(ws, "typeof invoke === 'function' && typeof CONF === 'object'")) break; }
        catch (e) { }
        await asleep(300);
    }
    // r47：起点是「只参与一家」（隔离配置里没勾任何「同时识别」）
    const before = await evalJs(ws, "(CONF && Array.isArray(CONF.ocrMulti)) ? CONF.ocrMulti.length : -1");
    ok('R5 起点只参与一家（隔离配置没勾「同时识别」）', before === 0, 'ocrMulti 长度=' + before);
    ok('R5 只参与一家时结果窗**不出现**「显示」段控',
        (await evalJs(ws, "$('ocrShowSeg').hidden")) === true);

    // 在页面里勾一家 → Rust 保存 + broadcast
    await evalJs(ws, "invoke('ocr_set_multi', { engines: ['baidu'] })");
    await asleep(1500);
    const after = await evalJs(ws, "JSON.stringify((CONF && CONF.ocrMulti) || null)");
    ok('R5 改设置后结果窗的 CONF 跟着更新了（改前从不更新，这个监听是死代码）',
        String(after).indexOf('baidu') >= 0, 'CONF.ocrMulti=' + after);
    const segState = await evalJs(ws, "JSON.stringify({hidden: $('ocrShowSeg').hidden, "
        + "cap: $('showCap').hidden, "
        + "ms: Array.from($('ocrShowSeg').querySelectorAll('button')).map(function(b){return b.dataset.m;})})");
    const st = JSON.parse(segState);
    ok('R5 参与两家时版式跟着变：出现「显示」段控，且**只列参与的那两家 + 都看**',
        st.hidden === false && st.cap === false && st.ms.length === 3
        && st.ms[0] === 'windows' && st.ms[1] === 'baidu' && st.ms[2] === 'all',
        JSON.stringify(st));

    // ⚠ 反例保护：广播**不许**重写文字。
    //   如果监听里图省事直接调 renderResultText()，非多引擎分支会 setText(ocrCombined)，
    //   把用户正在框里改的文字按 parts 冲掉 —— 这条断言就是钉住这个设计的。
    await evalJs(ws, "invoke('ocr_set_multi', { engines: [] })");
    await asleep(1200);
    const backHidden = await evalJs(ws, "$('ocrShowSeg').hidden");
    ok('R5 取消勾选后又回到「只参与一家」的版式（段控收起、没参与的引擎一个都不列）',
        backHidden === true, 'hidden=' + backHidden);
    await evalJs(ws, "$('text').value = 'USER-EDIT-12345'");
    await evalJs(ws, "invoke('set_setting', { key: 'theme', value: 'light' })");
    await asleep(1200);
    const kept = await evalJs(ws, "$('text').value");
    ok('R5 配置广播不会冲掉用户在结果框里改的文字', kept === 'USER-EDIT-12345',
        '实际="' + String(kept).slice(0, 40) + '"');

    /* 反例对照：同一个页面上，**不带 keepText** 直接调 renderResultText() 确实会
     * 把用户改的字冲掉 —— 证明上面那个参数不是多余的（如果监听里图省事直接调它，
     * 这条就是用户会遇到的后果）。 */
    await evalJs(ws, "$('text').value = 'USER-EDIT-12345'");
    await evalJs(ws, 'renderResultText()');
    const clobbered = await evalJs(ws, "$('text').value");
    ok('R5 反例对照：不带 keepText 的 renderResultText() 确实会冲掉用户改的字',
        clobbered !== 'USER-EDIT-12345', '实际="' + String(clobbered).slice(0, 40) + '"');
}

/* ============================================================================
 *  R6：横条的「打开这个网址」按钮 —— 按当前文字准确显示/隐藏
 *
 *  Rust 侧那条判据（`text_to_url`）由 `cargo test` 的
 *  `text_to_url_two_way_accuracy` 钉住；这里钉**前端接线**：
 *  `qs://show` 与 `qs://text`（迟到补）两处原来各抄了一份显隐逻辑，
 *  现在共用 `syncLinkBtn()` —— 这条断言保证"文字换了按钮就跟着换"。
 * ========================================================================== */
async function barLinkBtnTest() {
    const ws = await findPage(/index\.html|tauri\.localhost\/?$/);
    ok('R6 连上了横条页的 CDP', !!ws, 'CDP 列表里没找到横条页');
    if (!ws) return;
    let ready = false;
    for (let i = 0; i < 40; i++) {
        try { if (await evalJs(ws, "typeof syncLinkBtn === 'function'")) { ready = true; break; } }
        catch (e) { }
        await asleep(300);
    }
    ok('R6 横条页里 syncLinkBtn 就绪', ready);
    if (!ready) return;
    const btn = "document.getElementById('btnLink')";

    await evalJs(ws, "currentText = 'https://example.com'; currentIsUrl = true;"
        + " currentUrls = ['https://example.com']; ocrOnly = false; syncLinkBtn();");
    ok('R6 选中的是网址 → 「打开这个网址」按钮出现',
        (await evalJs(ws, btn + '.hidden')) === false);
    ok('R6 按钮 title 带上了这个网址',
        String(await evalJs(ws, btn + '.title')).includes('https://example.com'));

    /* 需求 8：一段话里**多个**链接 → 按钮照样出现，title 说明会开几个标签页 */
    await evalJs(ws, "currentText = '看 https://a.io/1 和 https://b.io/2';"
        + " currentIsUrl = false; currentUrls = ['https://a.io/1', 'https://b.io/2'];"
        + " ocrOnly = false; syncLinkBtn();");
    ok('R6 一段话里两个链接 → 按钮出现（判据是"有没有链接"，不是"整段是不是网址"）',
        (await evalJs(ws, btn + '.hidden')) === false);
    ok('R6 多链接时 title 说清会分别开标签页',
        /2\s*个链接/.test(String(await evalJs(ws, btn + '.title'))),
        String(await evalJs(ws, btn + '.title')));

    await evalJs(ws, "currentText = '这是一句话'; currentIsUrl = false;"
        + " currentUrls = []; ocrOnly = false; syncLinkBtn();");
    ok('R6 选中的不是网址 → 按钮藏起来（用户报的"不该出现时出现"）',
        (await evalJs(ws, btn + '.hidden')) === true);

    await evalJs(ws, "currentText = 'https://example.com'; currentIsUrl = true;"
        + " currentUrls = ['https://example.com']; ocrOnly = true; syncLinkBtn();");
    ok('R6 OCR-only 形态下不给开网址（没有「这段文字」可搜）',
        (await evalJs(ws, btn + '.hidden')) === true);

    // 还原，免得影响后面别的探针复用这个实例
    await evalJs(ws, "currentText = ''; currentIsUrl = false; currentUrls = [];"
        + " ocrOnly = false; syncLinkBtn();");
}

/* ============================================================================
 *  R7：在「识别结果」窗里划选，横条也要弹（2026-10-16 用户新要求）
 *
 *  "ocr 识别结果页面，选择文字也应该横条显示"
 *
 *  改前有两道门都把它挡住：
 *    ① `foreground_is_ours()` —— 前台是我们自己的进程就整条不弹，
 *       日志留「trigger: 前台是我们自己的窗口，忽略」；
 *    ② `should_try_select()` 里 `point_over_own_window(…, &["ocr", …])` ——
 *       鼠标底下是识别结果窗就直接判"不可划选"，日志留 `trySelect=false`。
 *  本轮两处都放行 ocr（region / picker 那两个全屏浮层照旧挡）。
 *
 *  ⚠ 必须用**真鼠标**：DOM 里 `setSelectionRange` 不经过全局钩子，测了等于没测。
 *  ⚠ 坐标要换成**物理屏幕像素**：本机 200% 缩放（dpr=2），CDP 给的是 CSS 像素。
 * ========================================================================== */
function findOcrWindow() {
    let h = GetTopWindow(GetDesktopWindow());
    let guard = 0;
    while (h && guard++ < 4000) {
        try {
            const b = new Uint16Array(512);
            const n = GetWindowTextW(h, b, 512);
            let s = '';
            for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
            if (s.includes('识别结果') && IsWindowVisible(h)) return h;
        } catch (e) { }
        h = GetWindow(h, 2 /* GW_HWNDNEXT */);
    }
    return null;
}

async function ocrWindowDragTest() {
    const h = findOcrWindow();
    ok('R7 找到了「识别结果」窗口（真窗口）', !!h, '窗口列表里没有可见的识别结果窗');
    if (!h) return;
    const cr = {};
    GetClientRect(h, cr);
    const org = { x: 0, y: 0 };
    ClientToScreen(h, org);
    ok('R7 结果窗客户区拿到了', cr.right > 200 && cr.bottom > 200,
        `client=${cr.right}x${cr.bottom} 屏幕原点=(${org.x},${org.y})`);

    const ws = await findPage(/ocr\.html/);
    ok('R7 连上了结果窗的 CDP', !!ws);
    if (!ws) return;
    const geo = await evalJs(ws, `(() => {
        const ta = (typeof curTa === 'function' && curTa()) || document.getElementById('text');
        if (!ta) return 'null';
        const tr = ta.getBoundingClientRect();
        const cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4) || 20;
        const pt = parseFloat(cs.paddingTop) || 0;
        const pl = parseFloat(cs.paddingLeft) || 0;
        /* ⚠ 两条弯路都试过了：① 拿"文本框top+14"猜第一行 → 拖在空白处，
         *   OCR 兜底「这块区域里没有识别到文字」；② 用 Range 量文字矩形 →
         *   textarea 上 setStart 直接抛 IndexSizeError（它没有子节点）。
         *   正解是用**自己的排版盒**算：左内边距 + 行高中线。 */
        return JSON.stringify({ l: tr.left + pl, t: tr.top + pt, lh: lh,
            w: tr.width - pl * 2, h: tr.height,
            head: (ta.value || '').slice(0, 24), dpr: window.devicePixelRatio || 1 });
    })()`);
    let g = null;
    try { g = JSON.parse(geo); } catch (e) { }
    ok('R7 量到了文本框第一行文字的屏幕位置', !!g && g.lh > 5 && g.w > 20, String(geo));
    if (!g || !(g.lh > 5)) return;
    console.log(`        文本框首段="${g.head}"  首行基线区=(${g.l},${g.t}) 行高=${g.lh}`);
    ok('R7 结果框里确实有文字（否则这条拖选测试本身无意义）',
        !!g.head && g.head.trim().length > 0, 'head=' + JSON.stringify(g.head));

    const dpr = g.dpr || 1;
    /* ⚠⚠ 坐标空间必须统一 —— 这里踩过一次大坑：
     *   node.exe **不是 DPI-aware 进程**，Windows 会把它的 Win32 坐标全部
     *   虚拟化成"逻辑像素"（ClientToScreen 给的、GetSystemMetrics 给的、
     *   mouse_event 的 ABS 映射用的，全是同一套逻辑像素 = CSS 像素）。
     *   而 CDP 给的也是 CSS 像素。所以**两边直接相加，一个 dpr 都不要乘**。
     *   第一版按"物理像素"思路乘了 dpr=2 → 真光标落到 2 倍远处（日志里
     *   裁图宽度 1217 而拖选只有 596，就是这个 2 倍），自然读不到字。 */
    const y = Math.round(org.y + g.t + g.lh / 2);
    const x1 = Math.round(org.x + g.l + 2);
    const x2 = Math.round(org.x + g.l + Math.min(g.w - 4, 300));
    console.log(`        拖选：屏幕 (${x1},${y}) → (${x2},${y})   逻辑像素`
        + `（dpr=${dpr} 只用来核对，不参与换算）`);

    const mark = logText().length;
    moveTo(x1, y); sleep(180);
    mouse_event(LDOWN, 0, 0, 0, 0); sleep(12);
    for (let i = 1; i <= 8; i++) {
        moveTo(Math.round(x1 + (x2 - x1) * i / 8), y);
        sleep(16);
    }
    sleep(30);
    mouse_event(LUP, 0, 0, 0, 0);
    await asleep(3000);

    const tail = logText().slice(mark);
    const ups = tail.split('\n').filter((l) => l.includes('up-check:'));
    const lastUp = ups.length ? ups[ups.length - 1].trim() : '';
    console.log('        ' + lastUp);
    ok('R7 在结果窗里划选被判定为「可划选」（trySelect=true）',
        /trySelect=true/.test(lastUp), '最后一条 up-check=' + (lastUp || '(没有 up-check)'));
    ok('R7 不再出现「前台是我们自己的窗口，忽略」（改前的第一道拦路虎）',
        !tail.includes('前台是我们自己的窗口'));
    const got = tail.split('\n').find((l) => l.includes('通道拿到'));
    console.log('        ' + (got || '').trim());
    ok('R7 取词真的拿到了文字', !!got, '尾巴日志=' +
        tail.split('\n').filter(Boolean).slice(-5).join(' | '));
    ok('R7 横条真的弹出来了（show_bar）', tail.includes('show_bar:'),
        '尾巴日志=' + tail.split('\n').filter(Boolean).slice(-5).join(' | '));
}

/* ============================================================================
 *  R8（需求 6）：横条打开的「更多引擎」/「收藏夹」面板也得是液态玻璃
 *
 *  改前的根因有两层，缺一层都还是"表面功夫"：
 *    ① 玻璃画布长在 `.bar` 里，而 `#panel` 是 `.bar` 的**兄弟**节点 ——
 *       面板那块区域压根没有玻璃；
 *    ② 就算画布铺满窗口，纹理是 Rust 按**窗口矩形**抓的，而首次上屏只抓了
 *       "胶囊"那一条；面板展开后窗口变高，新长出来那块没有背景。
 *
 *  所以这里的断言分两类：CSS（面板底板让位 + 薄纱托底）与
 *  纹理（按新矩形重抓 + 一帧画两块）。
 * ========================================================================== */
async function glassPanelTest() {
    const ws = await findPage(/index\.html|tauri\.localhost\/?$/);
    if (!ws) { ok('R8 连上了横条页（玻璃面板那条）', false, '没找到横条页'); return; }

    // 玻璃得真的起来：WebGL2 上下文 + Rust 抓到的纹理（R7 划选已经把横条叫出来了）
    let d = null;
    for (let i = 0; i < 40 && !d; i++) {
        const r = await evalJs(ws, 'window.QSGlass ? QSGlass.debugInfo() : null');
        if (r && r.ready && r.texW) d = r;
        else await asleep(150);
    }
    ok('R8 液态玻璃已就绪（WebGL2 + Rust 纹理都到位）', !!d,
        d ? '纹理=' + d.stats.lastRect
          : 'QSGlass 没就绪：' + JSON.stringify(await evalJs(ws, 'window.QSGlass ? QSGlass.debugInfo() : null')));
    if (!d) { try { ws.close(); } catch (e) { } return; }

    ok('R8 画布挂在 stage 上（不再只铺横条胶囊）',
        (await evalJs(ws, "!!document.querySelector('.stage.qs-glass > #qsGlass')")) === true);
    ok('R8 横条上仍保留 qs-glass 类（老选择器/老探针不用改）',
        (await evalJs(ws, "document.getElementById('bar').classList.contains('qs-glass')")) === true);

    const capRect = d.stats.lastRect;
    console.log('        胶囊态纹理=' + capRect
        + '  窗口=' + await evalJs(ws, 'innerWidth + "x" + innerHeight'));

    // 打开面板：走应用自己的路径（不是直接改 DOM.hidden）
    await evalJs(ws, 'togglePanel(true)');
    let grew = false, after = null;
    for (let i = 0; i < 35; i++) {
        await asleep(200);
        const r = await evalJs(ws, '({hidden: document.getElementById("panel").hidden,'
            + ' lr: QSGlass.debugInfo().stats.lastRect, p: QSGlass.debugInfo().stats.passes})');
        if (r && !r.hidden) grew = true;
        if (grew && r && r.lr !== capRect) { after = r; break; }
    }
    ok('R8 面板真的打开了（走 togglePanel 这条应用路径）', grew);
    ok('R8 窗口矩形变了之后，玻璃纹理按**新矩形**重抓（横条那块要有背景）',
        !!after, '纹理还停在 ' + capRect + ' —— 面板那块区域没有背景');

    if (after) {
        const w = await evalJs(ws, 'innerWidth * devicePixelRatio');
        const h = await evalJs(ws, 'innerHeight * devicePixelRatio');
        const mm = /^(\d+)x(\d+)@/.exec(String(after.lr)) || [];
        const tw = Number(mm[1] || 0), th = Number(mm[2] || 0);
        ok('R8 重抓的矩形 = 整个窗口（不是只有胶囊那一条）',
            Math.abs(tw - w) <= 4 && Math.abs(th - h) <= 4,
            '纹理=' + after.lr + ' 期望≈' + Math.round(w) + 'x' + Math.round(h));
    }

    /* ---- r47：「更多引擎」这类面板必须是**普通页面**，不是玻璃 ----
     *
     * 用户原话：「通过更多引擎打开的页面就还是普通的页面，默认的页面不要液态玻璃了，
     *   就不管任何主题都不会更改」。
     * 所以这里钉三件事（比"看代码里有没有那几行 CSS"更硬 —— 量的是**计算值**）：
     *   ① 面板底板是**实色**（玻璃那套是半透明薄纱）；
     *   ② 面板不带玻璃专用的文字阴影；
     *   ③ **一帧只画一块玻璃**（横条），面板不再被画 —— 用 passes/draws 的比值量：
     *      老实现一帧画两块，比值≈2；现在≈1。
     * 横条自己仍是玻璃（背景全透 + 画布在画），这条也一起钉住，免得"一刀切全关"。 */
    const bg = String(await evalJs(ws, 'getComputedStyle(document.getElementById("panel")).backgroundColor'));
    /* ⚠ 计算值有两种写法：rgba(r,g,b,a) 和 color(srgb r g b / a)（color-mix 的产物）。
     *   两种都吃，别把半透明误判成实色、也别反过来。 */
    let alpha = 1;
    const m1 = /rgba?\(([^)]+)\)/.exec(bg);
    const m2 = /\/\s*([\d.]+)\s*\)/.exec(bg);
    if (m1) {
        const p = m1[1].split(',').map((s) => parseFloat(s));
        if (p.length === 4) alpha = p[3];
    } else if (m2) {
        alpha = parseFloat(m2[1]);
    }
    ok('R8 r47：面板底板是**实色**（普通页面），不再是玻璃那层半透明薄纱',
        alpha >= 0.95, 'background-color=' + bg + ' alpha=' + alpha);

    const tsh = String(await evalJs(ws, 'getComputedStyle(document.getElementById("panel")).textShadow'));
    ok('R8 r47：面板不带玻璃专用的文字阴影（普通页面里的字不靠阴影兜可读性）',
        tsh === 'none' || tsh === '', 'text-shadow=' + tsh);

    // 一帧画几块玻璃：passes/draws 的增量比值（≈1 = 只画横条）
    const s1 = await evalJs(ws, 'QSGlass.debugInfo().stats');
    await asleep(900);
    const s2 = await evalJs(ws, 'QSGlass.debugInfo().stats');
    const dDraws = Number(s2.draws) - Number(s1.draws);
    const dPasses = Number(s2.passes) - Number(s1.passes);
    const ratio = dDraws > 0 ? dPasses / dDraws : 0;
    ok('R8 r47：面板打开时一帧只画**一块**玻璃（横条），不再连面板一起画',
        dDraws > 0 && ratio >= 0.9 && ratio < 1.5,
        'passes/draws=' + ratio.toFixed(2) + '（draws+' + dDraws + ' passes+' + dPasses + '）');

    const barBg = String(await evalJs(ws,
        'getComputedStyle(document.getElementById("bar")).backgroundColor'));
    ok('R8 横条那块仍是玻璃（自己不带底板，底色让位给画布）',
        /rgba?\([^)]*,\s*0\)|transparent/.test(barBg), 'bar background-color=' + barBg);

    /* ⚠ DOMRect 过不了 returnByValue（会变成 {}），必须自己把四个边取出来 */
    const cv = await evalJs(ws, '(function(){var c=document.getElementById("qsGlass").getBoundingClientRect();'
        + 'var p=document.getElementById("panel").getBoundingClientRect();'
        + 'return {cl:c.left,ct:c.top,cr:c.right,cb:c.bottom,pl:p.left,pt:p.top,pr:p.right,pb:p.bottom};})()');
    const covers = !!cv && cv.cl <= cv.pl + 0.5 && cv.ct <= cv.pt + 0.5
        && cv.cr >= cv.pr - 0.5 && cv.cb >= cv.pb - 0.5;
    ok('R8 玻璃画布仍然铺满整个窗口（含面板矩形）—— 只是面板那块不再交给它画', covers,
        cv ? 'canvas=[' + cv.cl + ',' + cv.ct + ',' + cv.cr + ',' + cv.cb + '] 面板=['
            + cv.pl + ',' + cv.pt + ',' + cv.pr + ',' + cv.pb + ']' : '量不到矩形');

    /* 收起面板：窗口缩回去，纹理也得跟着回胶囊矩形 —— 停在旧的大矩形上，
     * 下次开面板/挪窗口就是错位的背景。 */
    const bigRect = after ? after.lr : capRect;
    await evalJs(ws, 'togglePanel(false)');
    let back = null;
    for (let i = 0; i < 35; i++) {
        await asleep(200);
        const r = await evalJs(ws, '({hidden: document.getElementById("panel").hidden,'
            + ' lr: QSGlass.debugInfo().stats.lastRect})');
        if (r && r.hidden && r.lr !== bigRect) { back = r; break; }
    }
    ok('R8 收起面板后纹理跟着回到胶囊矩形（不留在旧的大矩形上）', !!back,
        '纹理=' + (back ? back.lr : bigRect + '(没变)'));

    try { ws.close(); } catch (e) { }
}

/* 需求 5/7：文本整理的开关在**真后端**上的行为（走真 IPC，不是页内假对象）。
 * 页内自检只验证"状态 → 按钮亮灭"的映射，管不到 Rust 那侧的 mode/on 解析 ——
 * 而这两处正是最容易"看着有反应、其实没生效"的地方。 */
async function cleanModesTest() {
    const ws = await findPage(/ocr\.html/);
    if (!ws) { ok('R9 连上了 OCR 结果窗（文本整理那条）', false, '没找到结果窗页面'); return; }
    // 走 promise + 轮询，不依赖 CDP 的 awaitPromise（换实现也不影响）
    const call = async (arg) => {
        await evalJs(ws, 'window.__r9 = "pending";'
            + ' window.__TAURI__.core.invoke("ocr_reclean", ' + JSON.stringify(arg) + ')'
            + ' .then(s => { window.__r9 = s; })'
            + ' .catch(e => { window.__r9 = {err: String((e && e.message) || e)}; })');
        for (let i = 0; i < 50; i++) {
            await asleep(100);
            const r = await evalJs(ws, 'window.__r9');
            if (r && r !== 'pending') return r;
        }
        return null;
    };

    // ① 全关：四个开关全灭，空格档位回到 off
    const off = await call({ mode: 'none' });
    ok('R9 全关（mode=none）：四个开关全灭、空格档位=off',
        !!off && !off.err && off.garbage === false && off.width === false
        && off.unwrap === false && off.space === 'off', JSON.stringify(off));

    // ② 布尔项：on=true 置位、on=false 清位（传**期望状态**，不让后端猜取反）
    const g1 = await call({ mode: 'garbage', on: true });
    const g2 = await call({ mode: 'garbage', on: false });
    ok('R9 去乱码：on=true 置位、on=false 清位',
        !!g1 && g1.garbage === true && !!g2 && g2.garbage === false,
        'true→' + (g1 && g1.garbage) + ' false→' + (g2 && g2.garbage));

    // ③ 空格那项的三态
    const f = await call({ mode: 'force' });
    const s = await call({ mode: 'smart' });
    ok('R9 空格档位：force / smart 切换生效（三态里的两档）',
        !!f && f.space === 'force' && !!s && s.space === 'smart',
        'force→' + (f && f.space) + ' smart→' + (s && s.space));

    // ④ 文本真的被重算过：去空格只会让字变少，不会变多
    ok('R9 字数不变量：全关 ≥ 强力去空格（后端确实按新开关重算了原文）',
        !!off && !!f && typeof off.chars === 'number' && typeof f.chars === 'number'
        && off.chars >= f.chars, '全关=' + (off && off.chars) + ' 强力=' + (f && f.chars));

    // 收尾：回到"只有智能去空格"的默认态（= 配置里的默认值），别给后面的用例留脏状态
    await call({ mode: 'none' });
    await call({ mode: 'smart' });

    try { ws.close(); } catch (e) { }
}

(async () => {
    await configBroadcastTest();
    await barLinkBtnTest();
    await ocrWindowDragTest();
    await cleanModesTest();
    await glassPanelTest();
})()
    .catch((e) => ok('R5/R6/R7/R8 CDP 那一段没有抛异常', false, String((e && e.stack) || e)))
    .finally(() => {
        /* 只收自己这一棵进程树，绝不动用户开着的实例 */
        try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
        console.log('\n' + pass + '/' + total + ' passed');
        process.exit(pass === total ? 0 : 1);
    });
