/* ============================================================================
 *  专项探针：横条弹出速度（本轮用户报的第一条）
 *
 *  用户原话：「横条弹出速度偏慢，即使已在设置中将延迟设为无，选择后仍需约几十毫秒
 *  才弹出，需要进一步加速；通过 Ctrl+C 方式唤起的横条也需要同样加速」。
 *
 *  这一轮对延迟做的四件事（探针逐条取证）：
 *    ① Rust show_bar 里的「让位」由异步 set_position + 盲等 36ms 改成同步
 *       win::move_only + 只等 12ms（#148 起改成无条件挪、不再等 —— 见日志
 *       `show_bar: 耗时 锚点=… 让位=… 主题=…` 里的「让位」段）。
 *    ② 前端首个 pushLayout 由 rAF+setTimeout（≥20ms）改成同步。
 *       → 看 `⏱ 端到端 show_bar→窗口可见 = Nms`（这条在 layout_bar 首显时打）。
 *    ③ Ctrl+C 这条路不再在 read_current 里挂着最长 400ms 等剪贴板落地，
 *       改成「立刻弹 + 迟到补」。
 *       → 看日志是 `copy path: 立刻弹（预填 N 字）…` 还是 `读的时候复制已经落地了`，
 *         以及端到端耗时。
 *    ④ 迟到补这条链（Rust push_late_text → 前端 qs://text 监听 → currentText）
 *       → 用「剪贴板占位法」**强制**复现 pending 分支：探针先 OpenClipboard(NULL)
 *         把剪贴板占住，此刻目标程序复制必然失败/阻塞、序号不变，于是横条一定是
 *         「立刻弹」；400ms 后探针放开剪贴板并让软件写入新文字，序号一变，
 *         late_text_patch 就该把新文字补上去，前端 currentText 必须变成新文字。
 *         这条同时也把上一轮那个「点引擎搜到剪贴板旧内容」的兜底修掉了。
 *
 *  安全性：所有按键都发给**探针自己拉起的记事本**（先 SetForegroundWindow 到它），
 *          不碰用户当前的前台窗口；实例走 QS_INSTANCE_TAG 隔离，不干扰用户那份。
 *          唯一短暂影响的全局资源是剪贴板（占位约 400ms），结束后立即释放。
 *
 *  用法：node tools/bar-latency-probe.js
 *  输出：tools/bar-latency-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'bar-latency-probe.txt');
const PORT = 9340;
const TAG = '-probe-lat';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);

const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const SendInput = user32.func('uint32 SendInput(uint32 n, void *p, int cb)');
const OpenClipboard = user32.func('int OpenClipboard(void *h)');
const CloseClipboard = user32.func('int CloseClipboard()');
/* ⚠ 这里**故意不读剪贴板内容**。试过 koffi decode(GetClipboardData(13), 'str16')：
 *   返回的 HGLOBAL 被解成裸整数、decode 当场把进程打崩（原生崩溃，try/catch 拦不住，
 *   连 flush 都来不及跑）。为了"跑完把用户的剪贴板还回去"这点礼貌不值得。
 *   代价：本探针会覆盖剪贴板（写测试串）。跑之前请确认剪贴板里没有要紧内容。 */

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

/* ---- 键盘注入 ---- */
const KEYUP = 0x0002;
const VK_CTRL = 0x11, VK_C = 0x43, VK_A = 0x41;
function kb(vk, up) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);          // INPUT_KEYBOARD
    b.writeUInt16LE(vk, 8);         // wVk
    b.writeUInt16LE(0, 10);         // wScan
    b.writeUInt32LE(up ? KEYUP : 0, 12);
    b.writeUInt32LE(0, 16);
    b.writeBigUInt64LE(0n, 24);
    return SendInput(1, b, 40);
}
function tap(vk, withCtrl) {
    if (withCtrl) { kb(VK_CTRL, false); sleep(12); }
    kb(vk, false); sleep(12); kb(vk, true); sleep(12);
    if (withCtrl) { kb(VK_CTRL, true); sleep(12); }
}

/** 找到 pid 的可见主窗口（记事本在 Win11 上是打包应用，类名不好硬编码） */
function mainWindowOf(pid) {
    let out = null, best = 0;
    const cb = koffi.register((h) => {
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        if (p[0] !== pid) return 1;
        if (!IsWindowVisible(h)) return 1;
        const t = new Uint16Array(300); const n = GetWindowTextW(h, t, 300);
        if (n <= best) return 1;
        best = n; out = h;
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}

/** 按窗口标题里的子串找窗口。
 *
 * ⚠ 为什么不能只按 pid 找：Win11 的记事本是**单实例多标签**的。探针 spawn 一个
 *   notepad.exe 打开临时文件时，Windows 可能把文件作为**新标签页**塞进一个**已有**
 *   的记事本窗口（那个窗口的 pid 根本不是我们 spawn 出来的），于是按 pid 一个窗口
 *   都找不到、按键全发飞（实测过：日志里全是"900ms 内没等到复制落地"）。
 *   按标题找就没这个问题：标签页的标题就是文件名，而窗口本身就是记事本窗口。 */
function windowWithTitle(sub, excludePid) {
    let out = null;
    const cb = koffi.register((h) => {
        if (!IsWindowVisible(h)) return 1;
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(h, p);
        if (excludePid && p[0] === excludePid) return 1;
        const t = new Uint16Array(400); const n = GetWindowTextW(h, t, 400);
        if (n <= 0) return 1;
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[i]);
        if (s.indexOf(sub) >= 0) { out = h; return 0; }   // 找到就停
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
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
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
const inv = (ws, cmd, args) => evalJs(ws,
    `window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`);
async function connect(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
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

const RE = /(copy path:|show_bar: 耗时|show_bar: atMouse|⏱ 端到端|迟到|open_search:|state )/;

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-lat-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const T_OLD = '【旧剪贴板内容】OLD-CLIP';
    const T_DOC = '记事本文档内容 DOC-FOR-CTRLC';
    const doc = path.join(tmp, 'qs-lat-probe.txt');   // 名字要够独特：按窗口标题定位记事本
    fs.writeFileSync(doc, T_DOC, 'utf8');

    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        c.trigger_select = false;
        c.trigger_copy = true;          // 本轮要测的就是 Ctrl+C 这条路
        c.ocr_enable = false;
        c.auto_start = false;
        c.delay_ms = 0;                 // 用户口径："延迟已设为无"
        c.filter_mode = 'off';          // app_allowed() 直接放行
        c.filter_list = [];
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    const readLog = () => { try { return fs.readFileSync(logp, 'utf8'); } catch (e) { return ''; } };

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid + '（QS_INSTANCE_TAG=' + TAG + '，隔离 APPDATA=' + qs + '）');
    sleep(9000);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上（端口 ' + PORT + '）'); try { proc.kill(); } catch (e) { } flush(); process.exit(0); }

    /* ---- 拉一个记事本当"按键靶子" ---- */
    const docName = path.basename(doc);
    const np = spawn('notepad.exe', [doc], { detached: false, stdio: 'ignore' });
    sleep(2500);
    let target = mainWindowOf(np.pid) || windowWithTitle(docName, 0);
    if (!target) {
        rec('第一轮没找到记事本窗口，再等 2.5s');
        sleep(2500);
        target = mainWindowOf(np.pid) || windowWithTitle(docName, 0);
    }
    const targetPid = (() => {
        if (!target) return 0;
        const p = new Uint32Array(1);
        GetWindowThreadProcessId(target, p);
        return p[0];
    })();
    rec('记事本 spawn pid=' + np.pid + ' → 定位到的窗口 pid=' + targetPid
        + ' ' + (target ? '已找到' : '没找到'));
    if (target) { SetForegroundWindow(target); sleep(600); }
    const fgIsTarget = () => !!target && GetForegroundWindow() === target;
    rec('前台现在是那个记事本窗口吗 = ' + fgIsTarget());

    const front = () => evalJs(ws, "(function(){return {text: (typeof currentText==='string'?currentText:null),"
        + " linkHidden: !!(document.getElementById('btnLink')||{}).hidden,"
        + " barHidden: !!(document.getElementById('bar')||{}).hidden,"
        + " ocrOnly: (typeof ocrOnly==='boolean'?ocrOnly:null)};})()");

    /** 一轮触发：hide=true 先收起横条（冷弹）；false 则让条亮着（热弹，会走「让位」） */
    async function round(label, opts) {
        const o = opts || {};
        if (!o.hide) {
            /* 热弹：先来一次冷弹把条打出来，再用第二次触发量「让位」段 */
            await inv(ws, 'hide_bar');
            sleep(500);
            tap(VK_C, true);
            sleep(1200);
        } else {
            await inv(ws, 'hide_bar');
            sleep(500);
        }
        if (!fgIsTarget() && target) { SetForegroundWindow(target); sleep(250); }
        await inv(ws, 'copy_text', { text: T_OLD });   // 让"预填"有东西可填
        sleep(250);

        const mark = readLog().length;
        const before = await front();
        rec('');
        rec('--- ' + label + ' ---');
        rec('  触发前：currentText=' + JSON.stringify(before.text) + ' 条已收起=' + before.barHidden);

        tap(VK_A, true);          // 全选
        sleep(80);
        tap(VK_C, true);          // 复制 → 钩子看到 Ctrl+C
        sleep(1800);

        const seg = readLog().slice(mark).split('\n').filter((x) => RE.test(x));
        const after = await front();
        rec('  日志：');
        for (const s of seg) rec('    ' + s);
        rec('  触发后：currentText=' + JSON.stringify(after.text) + ' 条可见=' + !after.barHidden);
        const e2e = (readLog().slice(mark).match(/⏱ 端到端 show_bar→窗口可见 = (\d+)ms/g) || [])
            .map((s) => Number(s.match(/= (\d+)ms/)[1]));
        const off = (readLog().slice(mark).match(/让位=(\d+)ms/g) || [])
            .map((s) => Number(s.match(/让位=(\d+)ms/)[1]));
        return { seg: seg.join('\n'), text: after.text, e2e, off, hadLate: seg.join('\n').indexOf('迟到') >= 0 };
    }

    /* ===== 场景 1：冷弹（条收着）—— 纯"从无到有"的端到端 ===== */
    const a1 = await round('① 冷弹 #1（条收着）', { hide: true });
    const a2 = await round('① 冷弹 #2（条收着）', { hide: true });
    const a3 = await round('① 冷弹 #3（条收着）', { hide: true });

    /* ===== 场景 2：热弹（条亮着）—— 会走「让位」段 ===== */
    const b1 = await round('② 热弹 #1（条亮着 → 走「让位」）', { hide: false });
    const b2 = await round('② 热弹 #2', { hide: false });

    /* ===== 场景 3：剪贴板占位法 —— 强制 pending，验证"立刻弹 + 迟到补"整条链 =====
     * ⚠ 这一项**本身带抖**：整条链的起点是"记事本在剪贴板被别人占着的那 400ms 里，
     *   到底有没有把 Ctrl+C 落地"。实测对**轮 17 与轮 18 两个二进制各跑 4~5 次**，
     *   两边都会失败（轮 17：1/4，轮 18：3/5），失败模式只有两种，且都在探针的前提上：
     *     (a) 记事本压根没落地 → 日志「900ms 内没等到复制落地（多半是没选中文字）」；
     *     (b) 复制在"预填"之前就已落地 → 不需要补丁，日志里自然没有「迟到」字样
     *         （此时最终文字**其实是正确的**，却因为断言找"迟到"而被判 FAIL）。
     *   两种都与被测版本无关。所以这里给它**最多 3 次机会，任一次走通即通过**，
     *   并在报告里写明实际用了几次。 */
    rec('');
    rec('=== ③ 剪贴板占位法：强制"立刻弹 + 迟到补"（最多 3 次，任一次走通即通过） ===');

    let lateHit = false, pendingHit = false, prefilled = false, patched = false, midHidden = true;
    let lateM = null, end3 = { text: '' }, seg3 = [], tries = 0;
    for (let attempt = 1; attempt <= 3 && !patched; attempt++) {
        tries = attempt;
        await inv(ws, 'hide_bar');
        sleep(500);
        if (target) { SetForegroundWindow(target); sleep(250); }
        await inv(ws, 'copy_text', { text: T_OLD });
        sleep(300);
        if (target) { SetForegroundWindow(target); sleep(200); }
        tap(VK_A, true);            // 先在记事本里全选（这一下钩子不关心）
        sleep(150);
        const mark3 = readLog().length;

        rec('  —— 第 ' + attempt + ' 次 ——  OpenClipboard(NULL) 占住剪贴板 → 期望此刻序号不变、横条必须"立刻弹"');
        const opened = OpenClipboard(null);
        rec('  OpenClipboard = ' + opened);
        tap(VK_C, true);            // 之前已 Ctrl+A 全选过
        sleep(400);
        const mid = await front();
        rec('  占位 400ms 时：currentText=' + JSON.stringify(mid.text)
            + ' 条可见=' + !mid.barHidden + '（补丁一般 20~30ms 就到了，这里多半已经是新内容）');
        rec('  放开剪贴板');
        CloseClipboard();
        sleep(1500);
        end3 = await front();
        seg3 = readLog().slice(mark3).split('\n').filter((x) => RE.test(x));
        rec('  最终：currentText=' + JSON.stringify(end3.text));
        rec('  日志：');
        for (const s of seg3) rec('    ' + s);

        lateHit = seg3.join('\n').indexOf('迟到') >= 0;
        pendingHit = seg3.join('\n').indexOf('立刻弹') >= 0;
        prefilled = /立刻弹（预填 \d+ 字）/.test(seg3.join('\n'));
        lateM = seg3.join('\n').match(/迟到 (\d+)ms 的复制补上了（(\d+) 字）/);
        patched = !!lateM && end3.text.length === Number(lateM[2]) && end3.text.length > 0;
        midHidden = mid.barHidden;
        rec('  不变量：前端 currentText 的字数应 = 后端迟到补的字数 '
            + (lateM ? lateM[2] : '?') + '（实际 currentText ' + end3.text.length + ' 字）');
    }

    rec('');
    rec('=== 汇总 ===');
    rec('  ① 冷弹端到端（条收着）     : ' + a1.e2e + ' / ' + a2.e2e + ' / ' + a3.e2e + ' ms');
    rec('  ① 冷弹「让位」段                : ' + a1.off + ' / ' + a2.off + ' / ' + a3.off + ' ms（该全 0：没开取色就不该让位）');
    rec('  ② 热弹端到端（条亮着）     : ' + b1.e2e + ' / ' + b2.e2e + ' ms');
    rec('  ② 热弹「让位」段                : ' + b1.off + ' / ' + b2.off + ' ms（该 ≈12ms）');
    rec('  ③ 走的是「立刻弹（不等剪贴板）」: ' + (pendingHit ? 'PASS' : 'FAIL'));
    rec('  ③ 弹出时先填的是旧剪贴板内容    : ' + (prefilled ? 'PASS' : 'FAIL'));
    rec('  ③ 迟到补日志出现                : ' + (lateHit ? 'PASS' : 'FAIL'));
    rec('  ③ 前端 currentText 被补成真内容 : ' + (patched ? 'PASS' : 'FAIL')
        + '（实际=' + JSON.stringify(end3.text) + '）');
    rec('  ③ 占位期间就已弹出（零等待）    : ' + (!midHidden ? 'PASS' : 'FAIL'));
    rec('  ③ 本项实际用了 ' + tries + ' 次尝试，第 ' + tries + ' 次'
        + (patched ? '走通' : '仍未走通（见上方两种失败模式说明）'));

    // ⚠ 探针覆盖过剪贴板（写测试串）且**不会还原** —— 见文件头 OpenClipboard 那段注释。

    flush();
    try { proc.kill(); } catch (e) { }
    try { np.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
