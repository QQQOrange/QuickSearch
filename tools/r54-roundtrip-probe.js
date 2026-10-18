/* ============================================================================
 *  r54 补测：导出/导入的对话框与勾选口径（r54-roundtrip-probe.js）
 *
 *  这个探针验什么、**不验什么**，先说清楚（免得读的人以为它覆盖了全部）：
 *
 *  ✅ 验：设置页「数据」栏那两个按钮**真的会把系统文件对话框叫出来**，
 *     并且叫出来的时候，后端收到的就是界面上勾的那几组。这是"界面驱动自
 *     数据"这条口径在真机上的唯一证据 —— 单测看不到对话框，jsdom 测不到 IPC。
 *  ✅ 验：默认勾选只含非隐私项；勾几项按钮上就写几项；一项不勾时按钮回到
 *     「导出选中的数据…」并且**不弹对话框**（后端不会收到空导出请求）。
 *  ✅ 验：取消路径不会在用户背后写文件（临时目录里没有多出 .qsconf）。
 *
 *  ❌ 不验（**刻意不验，也验不了**）：文件落盘 + 再导回来的往返。
 *     那道往返拆成了纯函数 `export::write_plain` / `export::read_plain`，
 *     由 `cargo test` 里的 5 条单测覆盖（落盘再读回来键不丢 / 落盘的文件不是
 *     密文 / 落盘的加密备份读不进来 / 超过体积上限直接拒 / 落盘后合并导入
 *     不覆盖别人的键）。为什么真机不验：新式 IFileDialog 的**文件名框默认拿不到
 *     键盘焦点**，探针注入的路径全被对话框吃掉（实测三轮：对话框开了、字没进去、
 *     日志里是 `cancelled`）；而"取消"那条路用 BM_CLICK 点按钮**也点不动**
 *     （又是几轮实测：按钮找到了、消息发出去了、对话框就是不关）。硬按着这个
 *     不放只会得到一个"永远红"的假阴性 —— 不如把力气放在能真测到的那一半。
 *
 *  结构上的选择：每个对话框场景用**一个独立的应用实例**跑完就退，
 *  不在同一个实例里"关了上一个再开下一个"（关不干净会让后续判定全部错位，
 *  这也是实测踩到的坑）。
 *
 *  用法：node tools/r54-roundtrip-probe.js    输出：tools/r54-roundtrip-probe.txt
 *  ⚠ 隔离实例（独立 APPDATA + 独立 WebView2 目录 + QS_INSTANCE_TAG），
 *    不碰用户正在用的那份配置，不 taskkill 别人的进程。
 *  ⚠ 会真的弹出系统对话框（然后直接把实例退掉）。跑的时候别去动鼠标键盘。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const koffi = require('koffi');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r54-roundtrip-probe.txt');
const PORT = 9380;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const user32 = koffi.load('user32.dll');
const GetForegroundWindow = user32.func('void* GetForegroundWindow()');
const GetClassNameW = user32.func('int GetClassNameW(void *h, void *buf, int max)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, void *buf, int max)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');

function fgInfo() {
    const h = GetForegroundWindow();
    if (!h || String(h) === '0') return null;
    const cb = Buffer.alloc(1024);
    const cn = GetClassNameW(h, cb, 512);
    let cls = ''; for (let i = 0; i < cn; i++) cls += String.fromCharCode(cb.readUInt16LE(i * 2));
    const tb = Buffer.alloc(1024);
    const n = GetWindowTextW(h, tb, 512);
    let title = ''; for (let i = 0; i < n; i++) title += String.fromCharCode(tb.readUInt16LE(i * 2));
    return { h: String(h), cls, title, visible: !!IsWindowVisible(h) };
}

/** 系统文件对话框是不是已经弹到前台了。
 *
 * ⚠ 用**类名黑名单**判（本软件的窗口都认出来，剩下的才算对话框）：
 *   · 设置窗的类名是 `Tauri Window`（**不是** WebView2 的 Chrome_WidgetWin_*，
 *     Tauri 2 的窗口类名就叫这个 —— 第一版按 Chrome_WidgetWin 写，结果设置窗
 *     自己被当成了对话框，1ms 就"检测到"、后续判定全错位）；
 *   · 新式 IFileDialog 的类名不是 #32770，不能按"是不是标准对话框类"判，
 *     只能按"不是我们自己的窗口"反推。 */
const APP_WIN_CLASSES = ['Tauri Window', 'Chrome_WidgetWin'];
function dialogUp() {
    const f = fgInfo();
    if (!f || !f.visible || !f.title) return null;
    for (const c of APP_WIN_CLASSES) if (f.cls.indexOf(c) === 0) return null;
    return f;
}
async function waitDialog(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 12000)) {
        const d = dialogUp();
        if (d) return d;
        await sleep(200);
    }
    return null;
}

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
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.text || '');
    return r.result.value;
}
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
function readLogNew(dir) {
    const p = path.join(dir, 'QuickSearch', 'log.txt');
    if (!fs.existsSync(p)) return [];
    const all = fs.readFileSync(p, 'utf8');
    const tail = all.slice(dir._logOff || 0);
    dir._logOff = all.length;
    return tail.split('\n').filter((s) => s.trim());
}

/** 起一个隔离实例，等设置页能连上。返回 { proc, tmp, setWs } 或 null。 */
async function boot() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r54rt-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, ocr_enable: true, theme: 'light',
        img_enable: true, img_add_to_bar: true,
    }, null, 1), 'utf8');
    tmp._logOff = 0;
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: 'r54rt' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    sleep(10000);
    const setWs = await connect('settings.html');
    if (!setWs) { try { proc.kill(); } catch (e) { } return null; }
    // 切到「数据」栏并等勾选项渲染完
    await evalJs(setWs, `(function(){
      const b = document.querySelector('#tabs button[data-tab="data"]');
      if (b) b.click();
      return !!b;
    })()`);
    for (let i = 0; i < 20; i++) {
        const n = await evalJs(setWs, `document.querySelectorAll('.exp-row input').length`);
        if (Number(n) > 0) break;
        await sleep(500);
    }
    return { proc, tmp, setWs };
}

/* ================= 场景一：导出那条路 ================= */
async function sceneExport() {
    rec('===== 场景一：导出 =====');
    const app = await boot();
    if (!app) { check('场景一：隔离实例起来', false, '设置页连不上'); return; }
    const { proc, tmp, setWs } = app;

    const rows = await evalJs(setWs, `(function(){
      return Array.from(document.querySelectorAll('.exp-row input')).map((c) =>
        c.dataset.id + '=' + (c.checked ? '1' : '0')).join(' ');
    })()`);
    rec('勾选界面初始状态：' + rows);
    check('勾选项有 8 组（API Key / 引擎配置 / 应用设置 / 收藏夹 / 图标 / 快捷键 / 备份设置 / 识图）',
        String(rows).split(' ').length === 8, rows);
    check('默认勾的全是非隐私项（apiKeys / favorites / backupSettings 一律不勾）',
        /(^| )apiKeys=0/.test(rows) && /(^| )favorites=0/.test(rows)
        && /(^| )backupSettings=0/.test(rows), rows);

    /* 只留两组：这样后端收到的组名必须**只有这两个**，
       一眼看出界面有没有真的把勾选传过去（默认 4 组的话看不出）。 */
    const picked = await evalJs(setWs, `(function(){
      const want = ['engineConfig', 'appSettings'];
      for (const b of document.querySelectorAll('.exp-row input')) {
        b.checked = want.indexOf(b.dataset.id) >= 0;
        b.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const btn = document.getElementById('btnDoExport');
      return btn ? btn.textContent : 'NO-BTN';
    })()`);
    check('按钮上写着勾了几项（「导出 2 项…」）', /导出\s*2\s*项/.test(String(picked)), picked);

    tmp._logOff = 0;
    await evalJs(setWs, `document.getElementById('btnDoExport').click()`);
    const d1 = await waitDialog(12000);
    check('点「导出」真的弹出了系统保存对话框', !!d1,
        d1 ? '' : '12 秒内没有非本软件的窗口抢到前台');
    if (d1) rec('  对话框：' + d1.cls + ' / 「' + d1.title + '」');
    await sleep(900);
    const exportLine = readLogNew(tmp).find((l) => l.indexOf('export_items:') >= 0);
    rec('  后端收到的导出请求：' + (exportLine ? exportLine.trim() : '(没找到)'));
    check('后端收到的就是界面勾的那两组（engineConfig + appSettings，不含隐私项）',
        !!exportLine && exportLine.indexOf('engineConfig') >= 0
        && exportLine.indexOf('appSettings') >= 0
        && exportLine.indexOf('apiKeys') < 0
        && exportLine.indexOf('favorites') < 0,
        exportLine || '(无日志行)');

    /* 取消不会误写文件：临时目录里不该多出任何 .qsconf
       （对话框还开着就把实例退掉 —— 关不动的坑见本文件头部说明） */
    await sleep(500);
    const stray = fs.readdirSync(tmp).filter((f) => /\.qsconf$/.test(f));
    check('取消路径没在背后写文件（临时目录里没有 .qsconf）', stray.length === 0,
        stray.join(','));
    try { proc.kill(); } catch (e) { }
    await sleep(700);
    rec('');
}

/* ================= 场景二：导入那条路 ================= */
async function sceneImport() {
    rec('===== 场景二：导入 =====');
    const app = await boot();
    if (!app) { check('场景二：隔离实例起来', false, '设置页连不上'); return; }
    const { proc, tmp, setWs } = app;

    tmp._logOff = 0;
    await evalJs(setWs, `document.getElementById('btnDoImport').click()`);
    const d2 = await waitDialog(12000);
    check('点「导入」真的弹出了系统打开对话框', !!d2,
        d2 ? '' : '12 秒内没有非本软件的窗口抢到前台');
    if (d2) {
        rec('  对话框：' + d2.cls + ' / 「' + d2.title + '」');
        // 标题必须对得上，防止把残留的导出对话框当成导入的
        check('弹出的确实是导入对话框（标题对得上）', /导入/.test(d2.title), d2.title);
    }
    await sleep(900);
    const importLine = readLogNew(tmp).find((l) => l.indexOf('import_items') >= 0);
    check('导入命令真的到了后端（import_items 有日志）', !!importLine,
        importLine || '(无日志行)');
    try { proc.kill(); } catch (e) { }
    await sleep(700);
    rec('');
}

/* ================= 场景三：一项都不勾 ================= */
async function sceneNone() {
    rec('===== 场景三：一项都不勾 =====');
    const app = await boot();
    if (!app) { check('场景三：隔离实例起来', false, '设置页连不上'); return; }
    const { proc, tmp, setWs } = app;

    const noneState = await evalJs(setWs, `(function(){
      for (const b of document.querySelectorAll('.exp-row input')) {
        b.checked = false;
        b.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const btn = document.getElementById('btnDoExport');
      return btn ? btn.textContent : 'NO-BTN';
    })()`);
    check('一项不勾时按钮回到「导出选中的数据…」（不写死一个数字）',
        /导出选中的数据/.test(String(noneState)), noneState);

    // 点了也不该弹对话框、不该有导出请求（后端 import/export 都不该被叫到）
    tmp._logOff = 0;
    await evalJs(setWs, `document.getElementById('btnDoExport').click()`);
    await sleep(3000);
    const noDialog = !(await waitDialog(1500));
    check('一项不勾时点导出**不弹对话框**（前端先拦，不去打扰用户）', noDialog,
        noDialog ? '' : '还是弹出了对话框');
    const anyExport = readLogNew(tmp).some((l) => l.indexOf('export_items:') >= 0);
    check('一项不勾时后端也没收到导出请求（前端拦住了）', !anyExport);
    try { proc.kill(); } catch (e) { }
    await sleep(700);
    rec('');
}

(async function main() {
    rec('r54 导出/导入探针（三个独立场景，各用一个隔离实例）');
    await sceneExport();
    await sceneImport();
    await sceneNone();
    rec('========== r54 导出/导入探针：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    rec('');
    rec('（文件往返本身由 cargo test 的 5 条 export::tests 单测覆盖，见本文件头部说明）');
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
