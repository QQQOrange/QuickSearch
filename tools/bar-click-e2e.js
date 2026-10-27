/* ============================================================================
 *  横条 @trans 按钮真点击联调（修「选中文字点翻译没反应」专用）
 *
 *  背景：用户实测「选中文字 → 点翻译 → 什么都没发生」。部署版日志证明：
 *    · 点击确实落在横条内容区（up-check 的 from=None = 按下时在横条上）；
 *    · 19ms 后有一次 dismiss_bar（trans_start 里那句的签名）；
 *    · 但**从来没有** `trans win: built` —— 窗口压根没建出来。
 *
 *  为什么不用 CDP：隔离实例带 QS_T_WV_ARGS（调试端口）时，WebView2 会以
 *  不同的 browser args 去抢生产实例正占着的 EBWebView 用户数据目录，
 *  直接 0x8007139F「组或资源的状态不是执行请求操作的正确状态」，
 *  整个 app 在 setup 阶段 panic（日志实测）。所以这里走项目现成的路：
 *    · `--bar` 启动参数直接把横条摆出来（不注入任何全局输入，不打扰生产实例）；
 *    · koffi 驱**真鼠标**点真按钮（tools/click.js 同款机制）；
 *    ·  Plain click（按下抬起同点）不会触发生产实例的划词取词 ——
 *       Ev::Up 的 was=false 分支直接跳过 schedule_capture，两边互不干扰。
 *
 *  几何算法：横条名单只放 ['@trans'] 一颗 → 引擎区第一个按钮就是它。
 *    窗口矩形/缩放从日志的 `layout: win=(X,Y,W,H)` + `layout_bar css=… scale=N` 读；
 *    按钮位置按 bar.css 现算：stage 边距 24 CSS + .bar 横向 padding 7 + 半颗按钮。
 *
 *  用法：node tools/bar-click-e2e.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const koffi = require('koffi');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? path.resolve(process.env.QS_E2E_EXE)
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const SCRATCH = path.join(__dirname, '.bar-click-data');
const LOG = path.join(SCRATCH, 'log.txt');
const RESULT = [];

/* 关掉 idle（5 秒无操作收起）和 away（鼠标走远收起）—— 本联调要排除这两种
 * 自动收起，只验证「点击」这一条路。bar_list 只留 @trans：第一颗按钮就是目标。 */
const CONF = {
    trans_enable: true,
    trans_engine: 'deepseek',
    trans_multi: [],
    trans_target: 'en',
    trans_keys: { deepseek: 'sk-bar-click-test' },
    bar_list: ['@trans'],
    bar_idle_sec: 0,
    bar_away_px: 0,
    shadow: false,
    bar_need_text: false,
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function ok(cond, name, extra) {
    const line = (cond ? 'OK  ' : 'NO  ') + name + (extra !== undefined && extra !== '' ? ' → ' + extra : '');
    RESULT.push(line);
    console.log(line);
}
function say(s) { console.log('    ' + s); }

/* ---------------- 真鼠标（koffi → user32.mouse_event） ---------------- */
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
const ax = (x) => Math.round(x * 65535 / (SW - 1));
const ay = (y) => Math.round(y * 65535 / (SH - 1));
const moveTo = (x, y) => { mouse_event(MOVE | ABS, ax(x), ay(y), 0, 0); };
function click(x, y) {
    moveTo(x, y); sleep(160);
    mouse_event(LDOWN, 0, 0, 0, 0); sleep(90);
    mouse_event(LUP, 0, 0, 0, 0);
}

/* ---------------- 日志工具 ---------------- */
function logText() { return fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''; }
function logLen() { return fs.existsSync(LOG) ? fs.statSync(LOG).size : 0; }
function readFrom(pos) {
    if (!fs.existsSync(LOG)) return '';
    const size = fs.statSync(LOG).size;
    if (size <= pos) return '';
    const buf = Buffer.alloc(size - pos);
    const fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    return buf.toString('utf8');
}
/** 等日志里出现包含 sub 的行，返回等到时的全文；超时返回 null。 */
function waitLog(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const t = logText();
        if (t.indexOf(sub) >= 0) return t;
        sleep(120);
    }
    return null;
}

/* 从日志里取横条窗口矩形与缩放：
 *   `layout: win=(X,Y,W,H)` —— 最后一次（--bar 之后的）
 *   `layout_bar css=(…) barH=.. scale=N` —— 同一次 */
function barGeometry() {
    const lines = logText().split('\n');
    let win = null, scale = 2, barH = 33;
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!win) {
            const m = /layout: win=\((\d+),(\d+),(\d+),(\d+)\)/.exec(l);
            if (m) win = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
        }
        if (scale === 2 || barH === 33) {
            const ms = /scale=([\d.]+)/.exec(l);
            if (ms) scale = parseFloat(ms[1]);
            const mh = /barH=([\d.]+)/.exec(l);
            if (mh) barH = parseFloat(mh[1]);
        }
        if (win && (scale !== 2 || barH !== 33)) break;
    }
    return win ? { win, scale, barH } : null;
}

(async function main() {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, 'config.json'), JSON.stringify(CONF, null, 2), 'utf8');

    /* 先把鼠标挪到主屏中央偏左上：--bar 会把横条摆在光标处，
     * 这样横条一定落在主屏内（绝对坐标映射只覆盖主屏）。 */
    moveTo(Math.round(SW * 0.35), Math.round(SH * 0.3));
    sleep(200);

    const env = Object.assign({}, process.env, {
        QS_INSTANCE_TAG: 'bar-click-e2e',
        QS_DATA_DIR: SCRATCH,
        QS_NO_CLOUD: '1',
        QS_DEBUG: '1',
    });
    /* ⚠ 绝不带 QS_T_WV_ARGS：那会让 WebView2 换一套 browser args 去抢生产实例
     *    正占着的用户数据目录，直接 0x8007139F，app 在 setup 就 panic。 */
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false });
    say('已启动 PID=' + proc.pid + '（无 CDP，走 --bar + 真鼠标）');

    /* ---- ① 等横条真弹出来 ---- */
    const t = waitLog('layout: win=', 40000);
    ok(!!t, '横条弹出来了（日志出现 layout: win=）');
    if (!t) { finish(proc); return; }
    sleep(600);   // 等 layout_bar / after-show 打完

    const geo = barGeometry();
    if (!geo) { ok(false, '读到横条窗口几何'); finish(proc); return; }
    const { win, scale, barH } = geo;
    say('窗口矩形=' + JSON.stringify(win) + ' scale=' + scale + ' barH=' + barH);

    /* ---- ② 算 @trans 按钮中心（bar_list 只有它一颗 → 引擎区第一个） ---- */
    const btnCss = barH - 10;                       // .bar 纵向 padding 5+5
    const cxCss = 24 + 7 + btnCss / 2;              // stage 边距 24 + .bar 横 padding 7 + 半颗
    const cyCss = 24 + 5 + btnCss / 2;
    const px = Math.round(win.x + cxCss * scale);
    const py = Math.round(win.y + cyCss * scale);
    say('按钮中心 CSS=(' + cxCss.toFixed(1) + ',' + cyCss.toFixed(1) + ') → 物理 (' + px + ',' + py + ')');

    /* ---- ③ 真点它 ---- */
    const before = logLen();
    click(px, py);
    sleep(2500);

    const fresh = readFrom(before);
    const transLines = fresh.split('\n').filter((l) => /trans|dismiss|panic|PANIC/.test(l));
    say('点击后的日志片段：');
    for (const l of transLines.slice(-8)) say('  ' + l);

    const built = fresh.indexOf('trans win: built') >= 0;
    const buildFailed = fresh.indexOf('trans win: build failed') >= 0;
    const disabled = fresh.indexOf('功能已关闭') >= 0;
    const dismissed = fresh.indexOf('dismiss_bar:') >= 0;
    const readyFallback = fresh.indexOf('ready 超时') >= 0;
    const panicked = /panicked|PANIC/.test(fresh);

    ok(dismissed, '横条按设计收起（trans_start 里的 dismiss_bar）');
    ok(built, '点 @trans → 日志出现 `trans win: built`', buildFailed ? '（但出现了 build failed）' : '（没有 trans win 行）');
    ok(!buildFailed, '翻译窗没有构建失败', buildFailed ? transLines.filter((l) => l.indexOf('build failed') >= 0).pop() : '');
    ok(!disabled, '翻译功能没有被判成"已关闭"');
    ok(!panicked, '没有 panic');

    /* ---- ④ 翻译窗真的在屏幕上吗（按标题找窗口） ---- */
    const wins = listWindows();
    const transWin = wins.find((w) => w.t.indexOf('翻译') >= 0 && w.vis);
    ok(!!transWin, '屏幕上出现了标题带「翻译」的窗口',
        transWin ? `${wins.length ? transWin.t : ''} @(${transWin.l},${transWin.tp}) ${transWin.r - transWin.l}x${transWin.b - transWin.tp}`
                 : '（枚举到的窗口：' + wins.map((w) => w.t).filter(Boolean).slice(0, 12).join(' | ') + '）');

    /* ---- ⑤ 窗口活着的前提下，再验一次 idle/away 没被误开 ---- */
    const cfgNow = safeJson(path.join(SCRATCH, 'config.json'));
    ok(cfgNow && cfgNow.bar_idle_sec === 0, '测试配置确实关掉了 idle 自动收起');

    finish(proc);
})().catch((e) => {
    console.log('NO 联调脚本异常：' + (e && e.stack || e));
    RESULT.push('NO 联调脚本异常：' + (e && e.message || e));
    process.exit(1);
});

/* ---------------- 窗口枚举（koffi → user32） ---------------- */
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
function listWindows() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400);
        const n = GetWindowTextW(h, b, 400);
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        const r = {};
        GetWindowRect(h, r);
        out.push({ t: s, vis: !!IsWindowVisible(h), l: r.left, tp: r.top, r: r.right, b: r.bottom });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return out;
}
function safeJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function finish(proc) {
    try { proc.kill(); } catch (e) { /* 已经退了 */ }
    spawnSync('taskkill', ['/IM', 'QuickSearch.exe', '/FI', 'PID eq ' + proc.pid, '/T', '/F'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(__dirname, '_bar-click.result.txt'), RESULT.join('\n') + '\n', 'utf8');
    const bad = RESULT.filter((r) => r.startsWith('NO')).length;
    console.log('==== ' + (RESULT.length - bad) + '/' + RESULT.length + ' 通过 ====');
    process.exit(bad ? 1 : 0);
}
