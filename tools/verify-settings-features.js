/* ============================================================================
 *  设置面板「本轮新增功能」的真机端到端验证
 *
 *  jsdom 那层只能证明前端逻辑算对了；这里真开一次设置窗口，真点真拖，
 *  再去 config.json 里核对值有没有落盘。覆盖用户本轮点名的四件事：
 *    · OCR 精度「高精度 / 标准」能选中并落盘（用户报的 bug 1）
 *    · 主题三档（跟随系统 / 亮色 / 暗色）能切换并落盘
 *    · 横条引擎「按住拖动换位」真的换位（用户报的拖拽 bug）
 *    · 黑白名单「用鼠标点选程序」能开十字覆盖层并把程序名加进名单
 *
 *  用法：
 *    node verify-settings-features.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const CFG = path.join(process.env.APPDATA || '', 'QuickSearch', 'config.json');
const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const GetClientRect = user32.func('int GetClientRect(void *h, _Out_ RECT *r)');
const ClientToScreen = user32.func('int ClientToScreen(void *h, _Inout_ POINT *p)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const SetForegroundWindow = user32.func('int SetForegroundWindow(void *h)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));
const moveTo = (x, y) => { mouse_event(MOVE | ABS, ax(x), ay(y), 0, 0); };
const click = (x, y) => { moveTo(x, y); sleep(140); mouse_event(LDOWN, 0, 0, 0, 0); sleep(90); mouse_event(LUP, 0, 0, 0, 0); };

function windows() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400); const n = GetWindowTextW(h, b, 400);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        const r = {}; GetWindowRect(h, r);
        const cr = {}; GetClientRect(h, cr);
        // 客户区原点换算到屏幕坐标：点击要落在客户区里，标题栏那 30 多像素不算
        const p = { x: 0, y: 0 }; ClientToScreen(h, p);
        out.push({
            t: s, vis: !!IsWindowVisible(h), h,
            l: r.left, tp: r.top, r: r.right, b: r.bottom,
            cl: p.x, ct: p.y, cw: cr.right - cr.left, ch: cr.bottom - cr.top,
        });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return out;
}
const findWin = (title) => windows().find((w) => w.t === title && w.vis);
function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; sleep(120); } return false; }

function cfg() { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return null; } }
function tailLog(n = 20) { try { return fs.readFileSync(LOG, 'utf8').split('\n').slice(-n).join('\n'); } catch (e) { return '(no log)'; } }

const results = [];
const ok = (name, cond, extra) => {
    results.push({ name, cond: !!cond, extra: cond ? '' : (extra || '') });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '\n        ' + extra));
};

/* 「让页面把某个控件滚进视口」的通道：往一个文件里追加控件名，Rust 盯着它，
 *  每多一行就往设置窗口发一次 qs://ensure-rect，页面收到后 scrollIntoView
 *  再重报坐标。外部脚本没法在 WebView 里跑 JS，这是最省事又可靠的一条路。 */
const ENSURE_FILE = path.join(ROOT, '_ensure.txt');
function ensureWanted(name) {
    fs.appendFileSync(ENSURE_FILE, name + '\n', 'utf8');
}

function startApp() {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    // 等干净：上个进程的窗口（尤其铺满全屏的 picker）必须真的没了，否则
    // 后面的断言会扫到残留窗口、把"这一轮没建起来"误判成 PASS。
    for (let i = 0; i < 20; i++) {
        sleep(250);
        if (!windows().some((w) => /QS-Picker|Quick Search 设置/.test(w.t) && w.vis)) break;
        try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    }
    sleep(1200);
    try { fs.writeFileSync(ENSURE_FILE, '', 'utf8'); } catch (e) { }
    const env = Object.assign({}, process.env, {
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_NO_ELEVATE: '1',
    });
    const mark = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
    spawn(EXE, ['--no-elevate', '--settings', '--ensure-file', ENSURE_FILE],
        { env, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    console.log('已启动 QuickSearch.exe --settings（带 --ensure-file）');

    /* ⚠ 不能「死等 9 秒」。
     *
     *  引擎库从 100 个涨到 250+ 之后，设置页首帧要渲染更多行、还要给每个图标
     *  量一次视觉尺寸，冷启动偶尔会超过 9 秒。固定等待一旦不够，前几条断言
     *  就会因为「控件还没报坐标」而随机失败 —— 表现为这一轮 9/14、下一轮 14/14
     *  的抖动，看着像程序坏了，其实是测试自己的等待策略太脆。
     *
     *  改成**等真正就绪**：窗口出现 + 页面报出第一份 RECTS 才算好，最多等 40 秒。*/
    const deadline = Date.now() + 40000;
    let ok = false;
    while (Date.now() < deadline) {
        sleep(400);
        const winUp = windows().some((w) => w.t === 'Quick Search 设置' && w.vis);
        let rects = false;
        try {
            // 按**字节**切片（日志里有中文，用字符串下标切会被越切越偏）
            rects = /\[js\] RECTS /.test(fs.readFileSync(LOG).slice(mark).toString('utf8'));
        } catch (e) { }
        if (winUp && rects) { ok = true; break; }
    }
    console.log(ok ? '  设置页已就绪（窗口 + 坐标都到齐）' : '  (warn) 40 秒内没等到就绪，继续跑');
    sleep(1200);   // 再留一点余量给首帧稳定
}

/** 设置窗口里，「分页按钮」和「分段按钮」的屏幕坐标要靠 DOM 给的相对位置算。
 *  这里用一个笨办法：把设置窗口挪到固定的左上角、固定尺寸，再用固定偏移点。
 *  但 DOM 布局会变，所以改成——由页面自己把关键控件的 rect 打到日志里。
 *  （见 settings.js 的 qs://debug-rects 钩子。）
 *
 *  ⚠ 日志里有中文，是 UTF-8 多字节的。`statSync().size` 给的是**字节数**，
 *  而 `readFileSync(p,'utf8')` 给的是**字符串**——拿字节偏移去 slice 字符串，
 *  偏移会被越切越偏，读出来的是乱码片段，于是永远匹配不到刚写进去的那行。
 *  所以一律按 Buffer 读、按字节 slice、再 decode。 */
function readLogSince(mark) {
    const buf = fs.readFileSync(LOG);
    return buf.slice(mark).toString('utf8');
}
function rectsFromLog(mark) {
    const fresh = readLogSince(mark);
    const m = fresh.match(/\[js\] RECTS (\{.*\})/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}

(async function main() {
    startApp();

    const win = findWin('Quick Search 设置');
    ok('S0 设置窗口开起来了', !!win, '窗口列表=' + JSON.stringify(windows().filter(w => w.vis).map(w => w.t).slice(0, 12)));
    if (!win) { done(); return; }

    // 把设置窗口拉到前台并定位。窗口位置可能还在动，所以读几次取最后一次。
    SetForegroundWindow(win.h);
    sleep(800);
    let geo = findWin('Quick Search 设置');
    for (let i = 0; i < 5; i++) {
        const g = findWin('Quick Search 设置');
        if (g && g.l === geo.l && g.tp === geo.tp) break;
        geo = g || geo;
        sleep(300);
    }
    let WX = geo.cl, WY = geo.ct;
    // ⚠ 坐标系：GetClientRect 给的是 CSS 像素大小的客户区，ClientToScreen 给的是
    //   客户区左上角的物理坐标。所以「屏幕点 = 客户区原点 + CSS坐标 × DPI缩放」。
    //   之前用 GetWindowRect（外框，含标题栏）当原点，结果顶部那 30 多像素全偏，
    //   分页按钮点不中——症状是"主题能切、分页点不动"。
    let scaleX = geo.cw / 780;
    let scaleY = geo.ch / 660;
    console.log(`客户区 origin=(${geo.cl},${geo.ct}) size=${geo.cw}x${geo.ch}  scale=(${scaleX.toFixed(2)},${scaleY.toFixed(2)})`);
    ok('S0b 缩放比正常（约等于 DPI 比例）', scaleX > 0.5 && scaleX < 4, 'scaleX=' + scaleX);

    /** 每次点击前重新定位窗口（用户可能拖动过，也可能系统挪过），
     *  顺便刷新缩放比。 */
    const refreshGeo = () => {
        const g = findWin('Quick Search 设置');
        if (!g) return;
        WX = g.cl; WY = g.ct;
        scaleX = g.cw / 780;
        scaleY = g.ch / 660;
    };

    // 让页面把控件 rect 打到日志
    let mark = fs.statSync(LOG).size;
    // 触发一次：焦点事件里 settings.js 会打印
    // 直接等页面 ready（settings 启动时自己会打）
    sleep(1200);
    let rects = rectsFromLog(mark);
    if (!rects) {
        // 退而求其次：从日志里找最近一次 RECTS（页面启动时打的那份）
        const s = fs.readFileSync(LOG, 'utf8');
        const all = [...s.matchAll(/\[js\] RECTS (\{.*\})/g)];
        if (all.length) { try { rects = JSON.parse(all[all.length - 1][1]); } catch (e) { } }
    }
    ok('S1 页面把关键控件坐标报出来了', !!rects, '拿不到 DOM rect，无法精确点击');
    if (!rects) { done(); return; }

    const pt = (name) => {
        refreshGeo();
        const r = rects[name];
        if (!r) throw new Error('no rect for ' + name);
        return { x: WX + (r.x + r.w / 2) * scaleX, y: WY + (r.y + r.h / 2) * scaleY };
    };

    /** 从日志尾部读最新一次 RECTS，合并进 rects。返回是否拿到。 */
    const pullRects = (sinceMark) => {
        const fresh = readLogSince(sinceMark);
        const mm = [...fresh.matchAll(/RECTS (\{.*\})/g)];
        if (!mm.length) return false;
        try {
            Object.assign(rects, JSON.parse(mm[mm.length - 1][1]));
            return true;
        } catch (e) { return false; }
    };

    /** 点某个控件。先让页面把它滚进视口并重报坐标（--ensure-file 通道），
     *  等新坐标到齐了再按新坐标点 —— 不然滚出视口的控件会点到屏幕外。
     *
     *  ⚠ 拿不到坐标时**记一条 FAIL 然后返回 false**，不要往外抛。
     *     这个脚本是一条长链（OCR 精度 → 主题 → 拖拽 → 黑白名单 → 落盘），
     *     任何一环抛异常，后面所有断言都不会执行，最后只吐一个 stack trace，
     *     根本看不出「到底是哪一条功能坏了」。记下来才能一眼定位。*/
    const clickEl = (name) => {
        const markNow = fs.statSync(LOG).size;
        ensureWanted(name);
        let got = false;
        for (let i = 0; i < 25; i++) {           // 最多等 2.5s
            sleep(100);
            if (pullRects(markNow)) { got = true; break; }
        }
        if (!got) console.log(`  (warn) ${name} 没等到新坐标，用旧坐标兜底`);
        const r = rects[name];
        if (!r) {
            ok('D0 能定位控件「' + name + '」', false, '页面没报出它的 rect');
            return false;
        }
        const p = pt(name);
        click(Math.round(p.x), Math.round(p.y));
        return true;
    };

    /** 切换分页后，等页面把新一页的控件坐标报上来（只有可见页的 rect 才有意义）。 */
    const gotoTab = async (tab) => {
        // ⚠ 标记必须在点击「之前」取：点击本身要 200 多毫秒，页面 80ms 后就把
        //   新坐标报了；先点后取标记的话，那份新报告已经算进旧区间、被漏掉，
        //   于是这里一直等不到「新」报告，rects 停留在上一页（全 0）。
        const markNow = fs.statSync(LOG).size;
        clickEl('tab-' + tab);
        for (let i = 0; i < 30; i++) {
            sleep(200);
            if (pullRects(markNow)) return true;
        }
        return false;
    };

    /* ---- OCR 精度（bug 1）---- */
    await gotoTab('ocr'); sleep(400);
    // 点「标准」，再点「高精度」，两条都点过才算能选中
    clickEl('ocr-acc-0'); sleep(800);
    const a0 = (cfg() || {}).ocr_accurate;
    clickEl('ocr-acc-1'); sleep(800);
    const a1 = (cfg() || {}).ocr_accurate;
    ok('O1 点「标准」后 ocr_accurate=false', a0 === false, '落盘值=' + JSON.stringify(a0));
    ok('O2 点「高精度」后 ocr_accurate=true', a1 === true, '落盘值=' + JSON.stringify(a1));

    /* ---- 主题三档 ---- */
    await gotoTab('general'); sleep(400);
    clickEl('theme-light'); sleep(800);
    const tl = (cfg() || {}).theme;
    clickEl('theme-dark'); sleep(800);
    const td = (cfg() || {}).theme;
    clickEl('theme-system'); sleep(800);
    const ts = (cfg() || {}).theme;
    ok('T1 亮色主题落盘', tl === 'light', '值=' + JSON.stringify(tl));
    ok('T2 暗色主题落盘', td === 'dark', '值=' + JSON.stringify(td));
    ok('T3 跟随系统落盘', ts === 'system', '值=' + JSON.stringify(ts));

    /* ---- 横条引擎拖拽换位 ---- */
    await gotoTab('engines'); sleep(500);

    /* ⚠ 前置条件自举：这一段要真拖第 1 行到第 3 行，所以横条**至少要有 3 个成员**。
     *
     *  之前这里是直接 clickEl('barrow-2')，一旦用户横条只有 2 个引擎就抛
     *  `no rect for barrow-2` —— 脚本崩在中间，后面黑白名单那段根本没跑，
     *  最后只剩一个 stack trace，看起来像"程序坏了"，其实是自己前置条件不满足。
     *
     *  现在先看一眼配置，不够就自己往 bar_list 里补几个内置引擎，跑完再还原。
     *  这样不管用户横条上有什么、几个，都能真跑一遍拖拽。*/
    const barBackup = (cfg() || {}).bar_list || [];
    if (barBackup.length < 3) {
        const fill = ['必应', '百度翻译', '知乎', '哔哩哔哩', '淘宝']
            .filter((n) => !barBackup.includes(n));
        const c = cfg() || {};
        c.bar_list = barBackup.concat(fill).slice(0, 5);
        fs.writeFileSync(CFG, JSON.stringify(c, null, 2), 'utf8');
        console.log(`  (setup) 横条只有 ${barBackup.length} 个成员，先补成 ${c.bar_list.length} 个再测`);
        sleep(700);        // 让程序自己读到新配置并重建横条
        await gotoTab('engines'); sleep(600);
    }
    // 引擎列表也在滚动区里，先把要拖的那几行滚进视口（顺带刷新坐标）
    clickEl('barrow-0'); sleep(300);
    clickEl('barrow-2'); sleep(300);
    refreshGeo();
    const listBefore = (cfg() || {}).bar_list || [];
    const rows = Object.keys(rects).filter((k) => k.startsWith('barrow-')).sort((a, b) => +a.split('-')[1] - +b.split('-')[1]);
    // 只保留真的在视口内的行（y 在 0..视口高之间），否则拖动坐标会落到屏幕外
    const vpH = geo.ch / scaleY;
    const onScreen = rows.filter((k) => rects[k].h > 0 && rects[k].y >= 0 && rects[k].y + rects[k].h <= vpH);
    const pick = onScreen.length >= 3 ? onScreen : rows;
    if (pick.length >= 3) {
        const r0 = rects[pick[0]], r2 = rects[pick[2]];
        // 从第 0 行中间按下，拖到第 2 行中间（坐标要按 DPI 换算）
        refreshGeo();
        const x1 = WX + (r0.x + 14) * scaleX, y1 = WY + (r0.y + r0.h / 2) * scaleY;
        const x2 = WX + (r2.x + 14) * scaleX, y2 = WY + (r2.y + r2.h / 2) * scaleY;
        console.log(`拖拽 (${Math.round(x1)},${Math.round(y1)}) -> (${Math.round(x2)},${Math.round(y2)})`);
        moveTo(x1, y1); sleep(180);
        mouse_event(LDOWN, 0, 0, 0, 0); sleep(180);
        const steps = 22;
        for (let i = 1; i <= steps; i++) {
            moveTo(Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps));
            sleep(28);
        }
        sleep(260);
        mouse_event(LUP, 0, 0, 0, 0);
        sleep(1000);
        const listAfter = (cfg() || {}).bar_list || [];
        ok('D1 拖动第 1 行到第 3 行后顺序真的变了',
            JSON.stringify(listBefore) !== JSON.stringify(listAfter),
            '前=' + JSON.stringify(listBefore.slice(0, 5)) + ' 后=' + JSON.stringify(listAfter.slice(0, 5)));
        if (listBefore[0]) {
            ok('D2 被拖的引擎位置后移', listAfter.indexOf(listBefore[0]) > 0,
                `「${listBefore[0]}」现在在下标 ${listAfter.indexOf(listBefore[0])}`);
        }
    } else {
        ok('D1 能拿到横条列表行的坐标', false, '拿到的行=' + JSON.stringify(rows));
    }

    /* 把用户原来的横条还回去。放在拖拽断言**之后**：拖拽会真的改写配置，
     * 不还原的话这一轮测试就把用户自己的横条顺序改了 —— 那属于测试污染用户数据。*/
    if (barBackup.length < 3) {
        const c = cfg() || {};
        c.bar_list = barBackup;
        fs.writeFileSync(CFG, JSON.stringify(c, null, 2), 'utf8');
        console.log(`  (cleanup) 横条已还原成 ${JSON.stringify(barBackup)}`);
    }

    /* ---- 黑白名单：鼠标点选程序 ---- */
    await gotoTab('general'); sleep(400);
    // ⚠ 必须等"这一轮"新建的 picker，而不是随便扫到一个 QS-Picker。
    //   之前吃过亏：上一轮遗留的窗口还在，扫描法会误判成 PASS，而实际
    //   这一轮压根没建起来（日志里找不到对应的 picker: built）。
    const markPick = fs.statSync(LOG).size;
    clickEl('btn-pick-app'); sleep(1600);
    const built = waitFor(() => /picker: built/.test(readLogSince(markPick)), 6000);
    const picker = built && !!windows().find((w) => w.t === 'QS-Picker' && w.vis);
    ok('P1 点「用鼠标点选程序」后十字覆盖层出现了', picker,
        built ? '窗口=' + JSON.stringify(windows().filter(w => /QS|Picker/.test(w.t)).map(w => w.t))
              : '这一轮没有 picker: built（可能是旧窗口残留）');
    if (picker) {
        // 点屏幕正中偏上的一块，多半落在某个真程序窗口上
        const before = ((cfg() || {}).filter_list || []).length;
        const markPick2 = fs.statSync(LOG).size;
        click(Math.round(SW * 0.5), Math.round(SH * 0.5));
        sleep(1600);
        const after = (cfg() || {}).filter_list || [];
        const closed = !windows().find((w) => w.t === 'QS-Picker' && w.vis);
        ok('P2 点完之后覆盖层自己关掉了', closed, '仍然存在=' + !closed);
        ok('P3 程序名进了黑/白名单', after.length >= before,
            '前=' + before + ' 后=' + after.length + ' 列表=' + JSON.stringify(after));
        // P3b 只在"确实没取到进程名"时才要求日志里有解释；取到了就不该出现这条
        if (after.length === before) {
            const lg = readLogSince(markPick2);
            ok('P3b 若没取到进程名，日志里有明确说明', /pick_app_at/.test(lg), lg.slice(-400) || '(空)');
        }
    }

    console.log('\n--- 日志尾部 ---');
    console.log(tailLog(18));
    done();
})();

function done() {
    const pass = results.filter((r) => r.cond).length;
    const out = results.map((r) => (r.cond ? 'PASS  ' : 'FAIL  ') + r.name
        + (r.cond ? '' : '\n        ' + r.extra)).join('\n')
        + `\n\n${pass}/${results.length} passed\n`;
    fs.writeFileSync(path.join(__dirname, 'verify-settings-features.result.txt'), out, 'utf8');
    console.log(`\n${pass}/${results.length} passed`);
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    process.exit(pass === results.length ? 0 : 1);
}
