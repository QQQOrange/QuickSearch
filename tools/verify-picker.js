/* ============================================================================
 *  黑白名单「鼠标点选程序」覆盖层 —— 真机验证
 *
 *  用户明确要求：点「添加」后出现一个十字光标/箭头，把鼠标放到目标程序上点一下，
 *  那个程序就自动加进黑/白名单。本脚本验证这条链路：
 *    开覆盖层（真窗口） -> 点一个真程序窗口 -> 程序名落进 filter_list -> 覆盖层关掉
 *
 *  为了不受「点设置页小按钮」的 DPI/定位折磨，程序提供了一条 --pick-app 调试入口，
 *  直接把覆盖层拉起来（等价于用户点了那个按钮）。
 *
 *  用法：node verify-picker.js
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
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const mouse_event = user32.func('void mouse_event(uint32 f, uint32 x, uint32 y, uint32 d, uintptr e)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');
const SW = GetSystemMetrics(0), SH = GetSystemMetrics(1);
const MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const moveTo = (x, y) => mouse_event(MOVE | ABS, Math.round(x * 65535 / (SW - 1)), Math.round(y * 65535 / (SH - 1)), 0, 0);
const click = (x, y) => { moveTo(x, y); sleep(160); mouse_event(LDOWN, 0, 0, 0, 0); sleep(110); mouse_event(LUP, 0, 0, 0, 0); };

function windows() {
    const out = [];
    const cb = koffi.register((h) => {
        const b = new Uint16Array(400); const n = GetWindowTextW(h, b, 400);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        const r = {}; GetWindowRect(h, r);
        out.push({ t: s, vis: !!IsWindowVisible(h), l: r.left, tp: r.top, r: r.right, b: r.bottom, h });
        return 1;
    }, ENUMPROC_PTR);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return out;
}
const has = (title) => windows().some((w) => w.t === title && w.vis);
function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; sleep(120); } return false; }
const cfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return null; } };
const tail = (n) => { try { return fs.readFileSync(LOG, 'utf8').split('\n').slice(-n).join('\n'); } catch (e) { return ''; } };

const results = [];
const ok = (n, c, e) => { results.push({ n, c: !!c, e }); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '\n        ' + (e || ''))); };

function done() {
    const pass = results.filter((r) => r.c).length;
    const out = results.map((r) => (r.c ? 'PASS  ' : 'FAIL  ') + r.n + (r.c ? '' : '\n        ' + (r.e || ''))).join('\n')
        + `\n\n${pass}/${results.length} passed\n`;
    fs.writeFileSync(path.join(__dirname, 'verify-picker.result.txt'), out, 'utf8');
    console.log(`\n${pass}/${results.length} passed`);
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    process.exit(pass === results.length ? 0 : 1);
}

function main() {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(1800);

    // 清空名单，方便断言；并备份原值，跑完还原
    const orig = cfg() || {};
    const origList = (orig.filter_list || []).slice();
    const origMode = orig.filter_mode || 'off';
    const w0 = Object.assign({}, orig, { filter_list: [], filter_mode: 'blacklist' });
    fs.writeFileSync(CFG, JSON.stringify(w0, null, 2));
    sleep(300);

    const env = Object.assign({}, process.env, { QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_NO_ELEVATE: '1' });
    // 必须同时开设置窗口：拾取到程序名之后，是「设置窗口」收到 qs://picked-app
    // 事件才把它并进 filter_list 的。只开拾取器、不开设置窗口，等于没人接这一棒。
    spawn(EXE, ['--no-elevate', '--settings', '--pick-app'], { env, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    console.log('已启动 QuickSearch.exe --settings --pick-app');
    sleep(9000);

    const got = waitFor(() => has('QS-Picker'), 8000);
    ok('P1 点「用鼠标点选程序」后出现了十字覆盖层窗口', got,
        '窗口=' + JSON.stringify(windows().filter(w => /QS|Picker/.test(w.t)).map(w => w.t)));

    // 找一个「真程序」窗口来点：优先记事本/资源管理器这类系统自带窗口，
    // 避开我们自己的窗口和桌面。
    const cands = windows().filter((w) => w.vis
        && w.t && !/QS-|QuickSearchBar|Quick Search|识别结果|Program Manager|^$/.test(w.t)
        && (w.r - w.l) > 200 && (w.b - w.tp) > 120);
    console.log('候选窗口:', cands.slice(0, 8).map((w) => w.t.slice(0, 24)));

    if (got && cands.length) {
        // 一个个候选去点，直到某次点出结果为止（有些窗口的进程名取不到，
        // 比如某些启动器/UWP 的宿主窗口；这属于环境噪声，不该算进结论）。
        let picked = null;
        for (const target of cands.slice(0, 5)) {
            const cx = Math.round((target.l + target.r) / 2);
            const cy = Math.round((target.tp + target.b) / 2);
            console.log(`点向「${target.t.slice(0, 30)}」中心 (${cx},${cy})`);
            click(cx, cy);
            sleep(1600);
            const list = (cfg() || {}).filter_list || [];
            if (list.length >= 1) { picked = list; break; }
            // 覆盖层若已被点掉，重新拉起再试下一个
            if (!has('QS-Picker')) {
                // 用设置窗口的按钮不现实，这里直接用另一个实例入口：重启带 --pick-app
                console.log('（覆盖层已关闭，重新拉起以便继续试下一个候选）');
                try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
                sleep(1200);
                spawn(EXE, ['--no-elevate', '--pick-app'], { env, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
                sleep(7000);
            }
        }

        ok('P2 每次点完覆盖层都会自己关掉', !has('QS-Picker'),
            '还开着：' + JSON.stringify(windows().filter(w => w.t === 'QS-Picker').map(w => w.t)));
        ok('P3 目标程序名进了黑/白名单', !!picked && picked.length >= 1,
            '名单=' + JSON.stringify((cfg() || {}).filter_list) + ' 日志尾部=' + tail(6));
        ok('P4 日志记录了拾取结果', /pick_app_at/.test(tail(500)), tail(8));
        ok('P5 落盘的是程序名（xxx.exe 形态）', !!picked && picked.some((x) => /\.exe$/i.test(x)),
            '名单=' + JSON.stringify(picked));
    } else if (!got) {
        ok('P2 覆盖层没开起来，后续跳过', false);
    } else {
        ok('P2 没有可点的候选窗口', false);
    }

    // 还原配置
    const c2 = cfg() || {};
    c2.filter_list = origList;
    c2.filter_mode = origMode;
    fs.writeFileSync(CFG, JSON.stringify(c2, null, 2));
    done();
}
main();
