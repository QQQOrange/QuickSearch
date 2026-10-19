/* 实测：横条**没显示**时，实时折射的 rAF 循环到底在不在跑（r84）。

## 为什么要探这一条

严格 A/B 已经证明 `bar_glass_live=true` 让空闲 CPU 从 0.5% 涨到 27%。
但代码里 `liveTick` 明明有一句"链条到此为止"：

    if (!shown || !glassOn(conf) || conf.barGlassLive !== true || !gl) return;

我的推断是**循环还在被启动**（或者 `shown` 恒为 true），所以这句拦不住。
这条探针直接从浏览器里问：
  · `shown` 变量的当前值（拿不到闭包变量，就用"循环在不在跳"间接判断）
  · 统计 `requestAnimationFrame` 的**实际回调频率** —— 这是最硬的证据：
    横条收起后若每秒仍有 ~60 次 rAF，说明循环没停。

做法：在页面里 hook `requestAnimationFrame`，数 2 秒内被调用的次数。
用 CDP 注入（Runtime.evaluate），不依赖任何闭包内部变量。

用法：node tools/bar-glass-idle-probe.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9346;
const TAG = '-probe-glassidle';
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

const EV = (expr) => `(() => { try { return JSON.stringify(${expr}); } catch(e){ return JSON.stringify({err:String(e)}); } })()`;

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-gidle-'));
    const appdata = path.join(tmp, 'appdata');
    fs.mkdirSync(path.join(appdata, 'QuickSearch'), { recursive: true });
    fs.writeFileSync(path.join(appdata, 'QuickSearch', 'log.on'), '');
    // 用**用户真实配置**（实时折射开）—— 复现的前提就是它
    fs.copyFileSync(process.env.QS_PROBE_CFG || path.join(os.homedir(), 'AppData', 'Roaming', 'QuickSearch', 'config.json'),
        path.join(appdata, 'QuickSearch', 'config.json'));

    const env = Object.assign({}, process.env, {
        APPDATA: appdata, QS_INSTANCE_TAG: TAG,
        QS_NO_ELEVATE: '1', QS_NO_OVERLAY: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: WV_ARGS,
    });

    rec('启动隔离实例（用户真实配置，含 bar_glass_live=true）');
    const child = spawn(EXE, ['--bar'], { env, stdio: 'ignore' });
    let ws = null;
    try {
        let ok = false;
        for (let i = 0; i < 60; i++) {
            sleep(500);
            try {
                const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
                const page = list.find((t) => t.webSocketDebuggerUrl && !/settings/i.test(t.url || ''));
                if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); ok = true; break; }
            } catch (e) { }
        }
        if (!ok) throw new Error('CDP 没就绪');
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        await cdp(ws, 'Runtime.enable');
        rec('CDP 已连上');

        // 装 rAF 计数器：hook 全局 requestAnimationFrame，统计真实回调频率
        await cdp(ws, 'Runtime.evaluate', {
            expression: `(() => {
                if (window.__rafStat) return 'already';
                window.__rafStat = { calls: 0, cbs: 0 };
                const orig = window.requestAnimationFrame.bind(window);
                window.requestAnimationFrame = function (cb) {
                    window.__rafStat.calls++;
                    return orig(function (t) { window.__rafStat.cbs++; return cb(t); });
                };
                return 'installed';
            })()`,
            returnByValue: true,
        });
        rec('已装 rAF 计数器');

        const sample = async (label) => {
            await cdp(ws, 'Runtime.evaluate', { expression: `window.__rafStat.calls=0;window.__rafStat.cbs=0;` });
            sleep(3000);
            const r = await cdp(ws, 'Runtime.evaluate', {
                expression: EV(`window.__rafStat`), returnByValue: true,
            });
            const st = JSON.parse(r.result.value);
            const perSec = st.calls / 3;
            rec(`  ${label}: rAF 调用 ${st.calls} 次（≈${perSec.toFixed(1)} 次/秒）`);
            return perSec;
        };

        /* 读玻璃层的统计计数。
         *
         * ⚠ 位置很容易搞错：`stats` **不是** 挂在 `window.QSGlass` 上的属性，
         *   而是 `window.QSGlass.debugInfo()` 的**返回值**里的一个字段
         *   （见 glass.js 末尾的 `debug: function () { return { …, stats: stats, … } }`）。
         *   我第一版写成 `window.QSGlass.stats` → 永远是 null，于是探针报
         *   "拿不到 stats"，看着像"玻璃层没就绪"，其实是**我查错了字段**。
         *
         * ⚠ 另外：这比 rAF 调用次数**有意义得多** —— 限帧的实现是"回调里提前
         *   return"，所以 rAF 的调用次数**不会变**，变的是**真正绘制/抓屏的次数**。 */
        const readStats = async () => {
            /* ⚠ 这里**不要**套 `EV()` 那个包装：EV 的作用是 `JSON.stringify(expr)`，
             *   而本表达式自己就是个 IIFE、自身就返回对象/ null。套上去之后
             *   内层返回 null 会变成字符串 `"null"`（**它是真值！**），
             *   于是 `JSON.parse("null")` 得到 null、却被外层的"取到了值"判据放行，
             *   表现为"拿不到 stats" 但也不报错 —— 我在这儿绕了两轮。
             *   直接返回对象，让 CDP 的 returnByValue 去序列化。 */
            const r = await cdp(ws, 'Runtime.evaluate', {
                expression: `(() => {
                    try {
                        if (!window.QSGlass || typeof window.QSGlass.debugInfo !== 'function') return null;
                        var d = window.QSGlass.debugInfo();
                        if (!d || !d.stats) return null;
                        return { passes: d.stats.passes, captures: d.stats.captures, takes: d.stats.takes };
                    } catch (e) { return { err: String(e) }; }
                })()`,
                returnByValue: true,
            });
            const v = r && r.result ? r.result.value : null;
            if (!v || typeof v !== 'object' || v.err) return null;
            return v;
        };
        const rate = async (label) => {
            const s1 = await readStats();
            sleep(3000);
            const s2 = await readStats();
            if (!s1 || !s2) { rec(`  ${label}: 拿不到 stats（玻璃层没就绪？）`); return null; }
            const dp = (s2.passes - s1.passes) / 3;
            const dc = (s2.captures - s1.captures) / 3;
            rec(`  ${label}: 着色器绘制 ${dp.toFixed(1)} 次/秒   抓屏 ${dc.toFixed(1)} 次/秒`);
            return { passes: dp, captures: dc };
        };

        rec('');
        rec('=== 阶段1：横条显示中 ===');
        const p1 = await sample('显示中');
        const r1 = await rate('显示中');

        rec('');
        rec('=== 阶段2：收起横条（Esc）===');
        await cdp(ws, 'Input.dispatchKeyEvent', {
            type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape',
        });
        await cdp(ws, 'Input.dispatchKeyEvent', {
            type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape',
        });
        sleep(1500);
        const p2 = await sample('收起后');
        const r2 = await rate('收起后');

        rec('');
        rec('=== 判定 ===');
        // 限帧后「显示中」的**绘制**频率应当落在 30fps 附近（不是 90/180）
        if (r1) {
            check('显示中着色器绘制 ≤ 35 次/秒（限帧生效）', r1.passes <= 35,
                `实际 ${r1.passes.toFixed(1)} 次/秒（限帧目标 30）`);
            check('显示中抓屏 ≤ 17 次/秒（实时链限帧生效）', r1.captures <= 17,
                `实际 ${r1.captures.toFixed(1)} 次/秒（限帧目标 15）`);
        }
        check('显示中 rAF 循环在跑（>20 次/秒）', p1 > 20, `实际 ${p1.toFixed(1)}/s`);
        check('收起后 rAF 循环已停止（<3 次/秒）', p2 < 3, `实际 ${p2.toFixed(1)}/s`);
        if (r2) {
            check('收起后不再绘制', r2.passes < 1, `绘制 ${r2.passes.toFixed(1)} 次/秒`);
            check('收起后不再抓屏', r2.captures < 1, `抓屏 ${r2.captures.toFixed(1)} 次/秒`);
        }

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
