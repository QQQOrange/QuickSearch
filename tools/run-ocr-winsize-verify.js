/* ============================================================================
 *  OCR 结果窗口「尺寸记忆」的真机验证
 *
 *  用户要求：调整过 OCR 结果窗口的大小之后，下次识别要按这个大小开。
 *
 *  做法（端到端，不碰内部实现）：
 *    ① 把 config.json 里的 ocr_win_w/h 写成一组可辨认的值，启动 --ocr-demo；
 *       量结果窗口的**客户区**尺寸，换算成逻辑像素，看是不是那组值。
 *    ② 再把 ocr_win_w/h 清成 0（模拟「从没拖过窗口」），重来一次，
 *       这次应当回落到默认的 760×620。
 *    ③ 无论如何都把配置还原回去（try/finally），不能把用户配置改坏。
 *
 *  ⚠ 客户区尺寸（GetClientRect）才是 Tauri 的 inner_size；GetWindowRect 给的是
 *    含标题栏/边框的外框，拿去比会一直对不上。
 *  ⚠ 物理像素 → 逻辑像素要除以 DPI 缩放比，否则 200% 缩放的机器上永远差一倍。
 *
 *  用法：node tools/run-ocr-winsize-verify.js
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const CFG = path.join(process.env.APPDATA || '', 'QuickSearch', 'config.json');

const u = koffi.load('user32.dll');
try { u.func('int SetProcessDpiAwarenessContext(intptr c)')(-4); } catch (e) { }

const EnumWindows = u.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void*h,intptr l)'));
const GetWindowTextW = u.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const IsWindowVisible = u.func('int IsWindowVisible(void*h)');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetClientRect = u.func('int GetClientRect(void*h,_Out_ RECT*r)');
let GetDpiForSystem = null;
try { GetDpiForSystem = u.func('uint GetDpiForSystem()'); } catch (e) { }

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function findWindow(sub) {
    let found = null;
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400);
        const n = GetWindowTextW(h, b, 400);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (IsWindowVisible(h) && s.includes(sub)) { found = h; return 0; }
        return 1;
    }, P);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return found;
}

function clientSize(h) {
    const r = {};
    if (!GetClientRect(h, r)) return null;
    return { w: r.right - r.left, h: r.bottom - r.top };
}

let pass = 0, total = 0;
const ok = (n, c, extra) => {
    total++;
    if (c) pass++;
    console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '\n        ' + (extra || '')));
};

function killOld() {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1500);
}

function readCfg() { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2), 'utf8'); }

/** 启动一次 --ocr-demo，量出结果窗口的**逻辑**尺寸。 */
function measure() {
    killOld();
    spawn(EXE, ['--no-elevate', '--ocr-demo'], {
        env: Object.assign({}, process.env, {
            QS_DEBUG: '1', QS_NO_ELEVATE: '1',
            QS_T_OCR_TEXT: '尺寸记忆验证',
            QS_T_OCR_IMG: '1',
        }),
        cwd: ROOT, detached: true, stdio: 'ignore',
    }).unref();

    let h = null;
    for (let i = 0; i < 60; i++) {          // 最多等 15 秒
        sleep(250);
        h = findWindow('识别结果');
        if (h) break;
    }
    if (!h) return null;
    sleep(900);                              // 等它把尺寸定下来
    const cs = clientSize(h);
    if (!cs) return null;
    const dpi = GetDpiForSystem ? GetDpiForSystem() : 96;
    const scale = dpi > 0 ? dpi / 96 : 1;
    return { raw: cs, dpi, scale, w: Math.round(cs.w / scale), h: Math.round(cs.h / scale) };
}

const orig = readCfg();
const origText = fs.readFileSync(CFG, 'utf8');
try {
    // ---------- ① 记录过尺寸 → 按记录的尺寸开 ----------
    console.log('1 配置里记着 940×700 → 结果窗口应当就开成 940×700（逻辑像素）');
    {
        const c = readCfg();
        c.ocr_win_w = 940;
        c.ocr_win_h = 700;
        writeCfg(c);
    }
    let m = measure();
    console.log('   实测客户区 ' + JSON.stringify(m && m.raw)
        + '  dpi=' + (m && m.dpi) + '  逻辑=' + (m && (m.w + '×' + m.h)));
    ok('① 窗口按记忆的尺寸打开（940×700）',
        !!m && Math.abs(m.w - 940) <= 3 && Math.abs(m.h - 700) <= 3,
        m ? ('实测 ' + m.w + '×' + m.h) : '窗口没出现');

    // ---------- ② 没记录过（0） → 回落到默认 760×620 ----------
    console.log('2 配置里没记录过（0）→ 结果窗口应当回落到默认 760×620');
    {
        const c = readCfg();
        c.ocr_win_w = 0;
        c.ocr_win_h = 0;
        writeCfg(c);
    }
    let m2 = measure();
    console.log('   实测客户区 ' + JSON.stringify(m2 && m2.raw)
        + '  逻辑=' + (m2 && (m2.w + '×' + m2.h)));
    ok('② 没记录过时用默认尺寸（760×620）',
        !!m2 && Math.abs(m2.w - 760) <= 3 && Math.abs(m2.h - 620) <= 3,
        m2 ? ('实测 ' + m2.w + '×' + m2.h) : '窗口没出现');

    // ---------- ③ 两次尺寸确实不一样（证明配置真的被读了，不是硬编码） ----------
    ok('③ 两次开出来的尺寸确实不同（配置真的生效，不是写死的）',
        !!m && !!m2 && (m.w !== m2.w || m.h !== m2.h),
        m && m2 ? (m.w + '×' + m.h + ' vs ' + m2.w + '×' + m2.h) : '有一次没量到');
} finally {
    killOld();
    // 原样还原配置（连格式一起），绝不能把用户的配置改坏
    fs.writeFileSync(CFG, origText, 'utf8');
    const back = readCfg();
    const same = JSON.stringify(back) === JSON.stringify(orig);
    console.log(same ? '（配置已原样还原）' : '❌ 配置还原后与原来不一致，请手工检查 ' + CFG);
}

console.log('\n' + pass + '/' + total + ' passed');
process.exit(pass === total ? 0 : 1);
