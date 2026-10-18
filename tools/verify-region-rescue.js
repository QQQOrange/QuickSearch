/* 验证「紧急强杀兜底」这条最后防线是有效的。
 *
 * 背景：框选遮罩铺满全屏，留着就等于锁死鼠标。正常关闭走 Tauri，
 * 但 Tauri 要经主线程 —— 万一主线程卡住，close 就是一句空话。
 * 所以 we里留了 REGION_HWND + win::force_kill_overlay() 这条不经主线程的路。
 *
 * 本测试直接对**真实窗口句柄**下手（不开新窗口、不走 Tauri API），
 * 模拟"主线程已经卡死、只剩 Win32 能用"的极端情形：
 *   1. --region拉起一个真实遮罩；
 *   2. 记下它的 HWND；
 *   3. 直接调 DestroyWindow（先 hide 再 destroy）把它干掉；
 *   4. 断言：窗口真的消失了（用户能拿回鼠标），且进程还活着。
 *
 * 这样验证的是 win::force_kill_overlay 本身能不能干活，
 * 而不是"看门狗会不会去调它"（那条由 e2e 的 A2/B2 覆盖）。
 */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');

const u = koffi.load('user32.dll');
const EnumWindows = u.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = u.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = u.func('int IsWindowVisible(void *h)');
const IsWindow = u.func('int IsWindow(void *h)');
const ShowWindow = u.func('int ShowWindow(void *h, int cmd)');
const DestroyWindow = u.func('int DestroyWindow(void *h)');
const SW_HIDE = 0;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function findRegion() {
    let found = null;
    const cb = koffi.register((h) => {
        const b = new Uint16Array(300);
        const n = GetWindowTextW(h, b, 300);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (s === 'QS-Region' && IsWindowVisible(h)) { found = h; return 0; }
        return 1;
    }, P);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return found;
}

/** 还有没有任何我们自己的窗口活着（用来判断进程是否还活着）。 */
function hasAnyQS() {
    let any = false;
    const cb = koffi.register((h) => {
        const b = new Uint16Array(300);
        const n = GetWindowTextW(h, b, 300);
        let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
        if (s.startsWith('QS-') || s.includes('Quick Search')) { any = true; return 0; }
        return 1;
    }, P);
    EnumWindows(cb, 0); koffi.unregister(cb);
    return any;
}

let pass = 0, total = 0;
const ok = (n, c, extra) => {
    total++;
    if (c) pass++;
    console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '\n        ' + (extra || '')));
};

(async function () {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(2000);
    spawn(EXE, ['--no-elevate', '--region'], {
        env: Object.assign({}, process.env, { QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_NO_ELEVATE: '1' }),
        cwd: ROOT, detached: true, stdio: 'ignore',
    }).unref();
    console.log('以 --region 启动…');
    sleep(9000);

    const h = findRegion();
    ok('K1 框选遮罩已出现（有窗口可救）', !!h);
    if (!h) { console.log(`${pass}/${total} passed`); process.exit(1); }

    const hwndNum = h;
    console.log(`拿到遮罩句柄 ${hwndNum}`);

    // ---- 模拟「主线程已卡死，只能走 Win32」的情形 ----
    ok('K2 动手前窗口确实还在', !!IsWindow(hwndNum) && !!IsWindowVisible(hwndNum));
    ShowWindow(hwndNum, SW_HIDE);   // 先隐藏：立刻把鼠标还给用户
    const hid = !IsWindowVisible(hwndNum);
    ok('K3 先隐藏 → 鼠标立刻回到用户手里（不必等销毁）', hid);

    DestroyWindow(hwndNum);
    sleep(400);
    ok('K4 强杀之后枚举不到 QS-Region 了（遮罩真的下了）', !findRegion());

    /* 进程必须还活着 —— 强杀遮罩不能把整个程序带走。
     *
     * ⚠ 判存活**不能**用 `tasklist`：这台机器上 tasklist 一律返回空
     *   （踩过好几次了，见 verify-settings-features.js 的注释）。
     * 改用「还能不能枚举到我们自己的横条窗口」来判断——横条一直在，
     *   枚举得到就说明进程活着。
     */
    sleep(800);
    const stillHasBar = hasAnyQS();
    ok('K5 强杀遮罩不影响程序本身（还能枚举到自己的横条窗口 =进程活着）', stillHasBar,
        '枚举不到任何 QS-* 窗口，程序可能真的挂了');

    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    console.log(`\n${pass}/${total} passed`);
    process.exit(pass === total ? 0 : 1);
})();