/* 验证「设置页已恢复原样 + 帧率选项可用」（r87）。
 *
 * ## 两条要同时成立的断言
 *
 *  ① **设置页样式回到原样** —— 用户明确要求「删掉所有设置页主题效果，
 *     恢复原来的样子」。所以要断言那些玻璃痕迹**真的没了**：
 *     没有 `data-skin`、卡片是不透明白、没有 backdrop-filter、
 *     背景是纯色（没有色斑渐变）、圆角回到 12px。
 *
 *  ② **帧率选项还在且能用** —— 那是**功能**（用户要求"刷新率提高、可配"），
 *     不是主题，必须留着。断言档位存在、默认高亮 30、点一下能落到配置里。
 *
 * ⚠ 这两条容易互相矛盾：回退样式时很容易把功能一起退掉（我第一版就
 *   把帧率控件退没了）。所以放在同一条探针里，一起看。
 *
 * 用法：node tools/settings-skin-probe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9387;
const TAG = '-probe-skin';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rec = (s) => console.log(s);
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; rec('  PASS  ' + name); }
    else { fail++; rec('  FAIL  ' + name + (detail ? '  ← ' + detail : '')); }
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
        setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(method + ' timeout')); }, 20000);
    });
}

const PROBE = `(() => {
  const card = document.querySelector('.pane:not([hidden]) .card, .card');
  if (!card) return JSON.stringify({ err: '没有 .card' });
  const cs = getComputedStyle(card);
  const root = getComputedStyle(document.documentElement);
  const htmlCs = getComputedStyle(document.documentElement);
  return JSON.stringify({
    // ① 玻璃痕迹该消失的那些
    dataSkin: document.documentElement.getAttribute('data-skin'),
    cardBg: cs.backgroundColor,
    cardBackdrop: (cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
    cardRadius: cs.borderTopLeftRadius,
    cardBorderColor: cs.borderTopColor,
    htmlBgImage: htmlCs.backgroundImage.slice(0, 40),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    // ② 帧率控件该还在的那些
    fpsRow: !!document.querySelector('#rowGlassFps'),
    fpsSeg: !!document.querySelector('#segGlassFps'),
    fpsButtons: [...document.querySelectorAll('#segGlassFps button')].map((b) => b.dataset.v),
    fpsOn: [...document.querySelectorAll('#segGlassFps button.on')].map((b) => b.dataset.v),
  });
})()`;

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-skin-'));
    const appdata = path.join(tmp, 'appdata');
    fs.mkdirSync(path.join(appdata, 'QuickSearch'), { recursive: true });
    fs.writeFileSync(path.join(appdata, 'QuickSearch', 'log.on'), '');
    // 用户配置：开实时折射，帧率故意写成没有的值 → 应回落到默认 30
    fs.copyFileSync(path.join(os.homedir(), 'AppData', 'Roaming', 'QuickSearch', 'config.json'),
        path.join(appdata, 'QuickSearch', 'config.json'));
    const cf = path.join(appdata, 'QuickSearch', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cf, 'utf8'));
    /* ⚠⚠ 磁盘配置里是 **snake_case**（`bar_glass_fps`），不是前端的 camelCase！
     *
     * 我第一版写成 `cfg.barGlassFps` / `cfg.barGlass`（照着前端的键名顺手写的），
     * 于是 `delete cfg.barGlassFps` **什么都没删** —— 用户配置里原有的
     * `bar_glass_fps: 60` 原样留着，探针于是看到高亮 60 并报了一条 FAIL，
     * 看起来像"默认值没生效"的产品缺陷。**实际是探针自己没改动配置文件。**
     *
     * 记住这个对应关系，别再混：
     *   前端 CONF / 命令参数 → camelCase（barGlassFps）
     *   磁盘 config.json      → snake_case（bar_glass_fps）
     */
    cfg.bar_glass = true;
    cfg.bar_glass_live = true;
    delete cfg.bar_glass_fps;        // 模拟"老配置没有这个键" → 应回落到默认 30
    fs.writeFileSync(cf, JSON.stringify(cfg, null, 2));

    const env = Object.assign({}, process.env, {
        APPDATA: appdata, QS_INSTANCE_TAG: TAG,
        QS_NO_ELEVATE: '1', QS_NO_OVERLAY: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: WV_ARGS,
    });

    rec('启动隔离实例（--bar --settings）');
    const child = spawn(EXE, ['--bar', '--settings'], { env, stdio: 'ignore' });
    let ws = null;
    try {
        let setT = null;
        for (let i = 0; i < 60; i++) {
            sleep(500);
            try {
                const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
                setT = list.find((t) => t.webSocketDebuggerUrl && /settings/i.test(t.url || ''));
                if (setT) break;
            } catch (e) { }
        }
        if (!setT) throw new Error('等不到设置页 target');
        ws = new WebSocket(setT.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        await cdp(ws, 'Runtime.enable');
        rec('CDP 已连上');

        for (let i = 0; i < 40; i++) {
            const r = await cdp(ws, 'Runtime.evaluate', {
                expression: `document.querySelectorAll('.card').length`, returnByValue: true,
            });
            if (r.result.value > 0) break;
            sleep(400);
        }

        const ev = async (expr) => {
            const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
            return r && r.result ? r.result.value : null;
        };

        const m = JSON.parse(await ev(PROBE) || '{}');
        rec('');
        rec('=== 实测值 ===');
        for (const [k, v] of Object.entries(m)) rec(`  ${k.padEnd(16)} = ${JSON.stringify(v)}`);

        rec('');
        rec('=== ① 设置页样式已恢复原样 ===');
        check('没有 data-skin（玻璃皮肤没生效）', !m.dataSkin, String(m.dataSkin));
        /* ⚠ 判"透不透明"要分清 rgb() 与 rgba()：
         * gb(30, 31, 36) 是**不透明**的（三个通道值），
         * gba(30, 31, 36, .5) 才有第四个数是 alpha。
         * 我第一版的正则 gb?\(...([\d.]+)\) 对 rgb() 会把**蓝通道**
         * 当成 alpha 抓出来（36 ≠ 1 → 误判成"半透明"）。 */
        const alpha = (c) => {
            const s = String(c || '');
            if (!/^rgba\(/.test(s)) return 1;          // rgb() → 不透明
            const parts = s.slice(5, -1).split(',');
            return parts.length >= 4 ? parseFloat(parts[3]) : 1;
        };
        check('卡片是不透明白（不是半透明玻璃）', alpha(m.cardBg) === 1, m.cardBg);
        check('卡片没有 backdrop-filter', m.cardBackdrop === 'none', m.cardBackdrop);
        check('卡片圆角回到 12px', parseFloat(m.cardRadius) === 12, m.cardRadius);
        check('背景没有色斑渐变', m.htmlBgImage === 'none', m.htmlBgImage);
        check('body 有不透明底色（不是透明）', alpha(m.bodyBg) === 1, m.bodyBg);

        rec('');
        rec('=== ② 帧率选项仍可用（这是功能，不是主题）===');
        check('帧率那一行还在', m.fpsRow === true);
        check('帧率分段控件还在', m.fpsSeg === true);
        /* 档位断言按**数值排序**再比：DOM 里的顺序是给人读的（15,30,60,120,跟随显示器），
         * 不是数值序。我第一版按数值序断言，被 DOM 顺序判成 FAIL。 */
        const fpsSorted = (m.fpsButtons || []).map(Number).sort((a, b) => a - b);
        check('档位是 0/30/60/120 四个（15 那一档已按用户要求删除）',
            JSON.stringify(fpsSorted) === JSON.stringify([0, 30, 60, 120]),
            JSON.stringify(m.fpsButtons));
        check('老配置缺这个键时高亮落到默认 30',
            JSON.stringify(m.fpsOn) === JSON.stringify(['30']), JSON.stringify(m.fpsOn));

        // 点一下「60」，看是否真的落到后端配置
        await ev(`(() => {
            const b = [...document.querySelectorAll('#segGlassFps button')]
                .find((x) => x.dataset.v === '60');
            if (b) b.click();
            return !!b;
        })()`);
        sleep(1200);
        /* ⚠ 读配置要走 `awaitPromise`：
         * `get_config` 是 Tauri 的异步命令（返回 Promise）。`Runtime.evaluate`
         * 默认拿到的是 **Promise 对象本身**，`returnByValue` 序列化出来是
         * `[object Object]` —— 我第一版就是这么炸的：`JSON.parse` 报
         * `"[object Object]" is not valid JSON`。
         * 带上 `awaitPromise: true` 之后 CDP 会等它 resolve 再取值。 */
        const cfgRes = await cdp(ws, 'Runtime.evaluate', {
            expression: `(async () => {
                const r = await window.__TAURI__.core.invoke('get_config');
                return { fps: r.barGlassFps };
            })()`,
            returnByValue: true,
            awaitPromise: true,
        });
        const cfgNow = (cfgRes && cfgRes.result && cfgRes.result.value) || {};
        rec(`  点「60」之后后端配置 barGlassFps = ${cfgNow.fps}`);
        check('点档位真的落到了配置（功能通路通）', Number(cfgNow.fps) === 60, String(cfgNow.fps));

        rec('');
        rec(`结果：${pass} 通过 / ${fail} 失败`);
        rec(fail === 0 ? 'DONE' : 'DONE-WITH-FAILURES');
        if (fail > 0) process.exitCode = 1;
    } catch (e) {
        rec('EXCEPTION: ' + (e && e.message));
        process.exitCode = 1;
    }
    try { if (ws) ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
    sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
})();
