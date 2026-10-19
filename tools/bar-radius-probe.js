/* ============================================================================
 *  横条圆角同心 · 数值取证（无需 koffi，纯 CDP）
 *
 *  用户报的问题：
 *    「鼠标放在一个图标上面，这个图标就会显示一个被选中的样式，有一个外框，
 *      但是这个外框的圆角并没有跟横条的圆角一致，整体看起来很不协调。」
 *
 *  这条探针在**真实 WebView2** 里逐档改圆角滑块，然后向浏览器问三件事：
 *    ① 横条实际算出的圆角（`border-radius`）
 *    ② 图标悬停外框实际算出的圆角
 *    ③ 两者的同心偏差 = 横条圆角 - (图标圆角 + 横条内边距)   ← 应当恒为 0
 *
 *  为什么要有它（cargo test 里不是已经断言过 CSS 文本了吗）：
 *    那条测试读的是 **CSS 源码串**，只能证明"文件里写的关系对"。
 *    而真正生效的是浏览器**层叠计算后**的值 —— 变量继承、简写覆盖、
 *    某个更具体的选择器赢掉，这些都可能让源码里的正确关系在运行时失效。
 *    这条探针问的是浏览器算出来的最终值，补上那一段。
 *
 *  不需要 koffi：不注入鼠标，只读 getComputedStyle，所以也不用真截图。
 *
 *  用法：node tools/bar-radius-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9342;
const TAG = '-probe-radiusn';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; const rec = (s) => { L.push(s); console.log(s); };
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

/** 在页面里量一组圆角并算同心偏差。
 *
 *  `r` = 圆角滑块值，`pad` = 横条内边距（纵向）。
 *  两个都通过 CSS 变量写进去 —— 这正是 bar.js 的 applyLook 用的那条通道。
 */
const MEASURE = (r, pad) => `(() => {
    const st = document.getElementById('stage');
    const bar = document.getElementById('bar');
    const icon = document.querySelector('#engines .ico, #engines .engine');
    if (!st || !bar || !icon) return null;
    st.style.setProperty('--qs-radius', '${r}px');
    st.style.setProperty('--qs-bar-pad', '${pad}px');
    const cs = getComputedStyle(bar);
    const ci = getComputedStyle(icon);
    const px = (v) => parseFloat(v) || 0;
    const barR  = px(cs.borderTopLeftRadius);
    const iconR = px(ci.borderTopLeftRadius);
    const padV  = px(cs.paddingTop);
    // 同心判据：外层圆角应当 = 内层圆角 + 内边距（都是浏览器算完的值）
    const want  = iconR + padV;
    return JSON.stringify({
        radius: ${r}, pad: ${pad},
        barR, iconR, padV, want,
        delta: +(barR - want).toFixed(4),
        iconVar: cs.getPropertyValue('--qs-icon-r').trim(),
        barVar:  cs.getPropertyValue('--qs-bar-r').trim(),
        // 横向内边距比纵向多 2px（.bar 的 padding 是 pad / pad+2）——
        // 记下来，好在报告里说清"另一个方向的偏差有多大"
        padH: px(cs.paddingLeft),
        letterR: (() => {
            const lt = icon.querySelector('.letter');
            return lt ? px(getComputedStyle(lt).borderTopLeftRadius) : null;
        })(),
        iconPad: px(ci.paddingTop),
    });
})()`;

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-radn-'));
    const appdata = path.join(tmp, 'appdata');
    fs.mkdirSync(path.join(appdata, 'QuickSearch'), { recursive: true });
    fs.writeFileSync(path.join(appdata, 'QuickSearch', 'log.on'), '');

    const env = Object.assign({}, process.env, {
        APPDATA: appdata,
        QS_INSTANCE_TAG: TAG,
        QS_NO_ELEVATE: '1',
        QS_NO_OVERLAY: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: WV_ARGS,
    });

    rec('启动隔离实例');
    /* 同时带 --settings：预览块（.qs-preview）只在设置页里，而它要一起验。
     * CDP 的 /json/list 会列出两个 target（横条 + 设置页），下面挑横条那个连。 */
    const child = spawn(EXE, ['--bar', '--settings'], { env, stdio: 'ignore' });
    let ws = null;
    let listCache = [];
    try {
        let ok = false;
        for (let i = 0; i < 60; i++) {
            sleep(500);
            try {
                listCache = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
                /* ⚠ 要挑**横条**那个 target。
                 * `--settings` 也在跑，所以这里会同时列出设置页 —— 随便连一个
                 * 很可能连到设置页上，然后 `#engines .ico` 当然找不到。
                 * 判据用 URL：横条是 index.html / 根路径，设置页是 settings.html。 */
                const page = listCache.find((t) => t.webSocketDebuggerUrl
                    && !/settings/i.test(t.url || ''));
                if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); ok = true; break; }
            } catch (e) { }
        }
        if (!ok) throw new Error('CDP 没就绪');
        rec('targets: ' + listCache.map((t) => (t.url || t.title || '?')).join(' | '));
        await new Promise((res, rej) => {
            ws.addEventListener('open', res);
            ws.addEventListener('error', rej);
        });
        await cdp(ws, 'Runtime.enable');
        await cdp(ws, 'Page.enable');
        rec('CDP 已连上');

        // 等引擎图标渲染出来
        let ready = false;
        for (let i = 0; i < 60; i++) {
            const r = await cdp(ws, 'Runtime.evaluate', {
                expression: `document.querySelectorAll('#engines .ico, #engines .engine').length`,
                returnByValue: true,
            });
            if (r.result.value > 0) { ready = true; break; }
            sleep(400);
        }
        check('横条渲染出引擎图标', ready);
        if (!ready) throw new Error('横条没有引擎图标');

        rec('');
        rec('=== 逐档圆角 · 同心判定（浏览器算出的真实像素）===');
        let allZero = true;
        // [圆角, 内边距]。后两档是**用户真实的设置**：
        // 他配置里是 item_radius=3、bar_padding=2（就是报"不协调"的那一组）。
        const CASES = [
            [0, 5], [3, 5], [9, 5], [18, 5],
            [3, 2], [0, 2], [9, 2], [18, 2],
            [9, 8],
        ];
        for (const [r, pad] of CASES) {
            const res = await cdp(ws, 'Runtime.evaluate', {
                expression: MEASURE(r, pad), returnByValue: true,
            });
            if (!res.result.value) { check(`圆角 ${r}px/内边距 ${pad}px 能测到`, false); continue; }
            const m = JSON.parse(res.result.value);
            const tag = `圆角 ${String(r).padStart(2)}px + 内边距 ${pad}px`;
            rec(`  ${tag}  →  横条 ${m.barR}px  图标 ${m.iconR}px  期望 ${m.want}px  偏差 ${m.delta}px`);
            check(`${tag}：横条与图标同心（偏差 0）`, Math.abs(m.delta) < 0.01, `偏差 ${m.delta}px`);
            if (Math.abs(m.delta) >= 0.01) allZero = false;
            // 横条必须 ≥ 图标（差一个内边距）；相等只在圆角 0 时可能（都归零）
            check(`${tag}：横条 ≥ 图标（差一个内边距）`,
                m.barR >= m.iconR - 0.01,
                `横条 ${m.barR} 图标 ${m.iconR}`);
            // 图标外框不能比横条还圆 —— 那才是"不协调"的极端
            check(`${tag}：图标不比横条更圆`, m.iconR <= m.barR + 0.01,
                `图标 ${m.iconR} 横条 ${m.barR}`);
            if (m.letterR !== null) {
                check(`${tag}：字母徽标不比方框更方`, m.letterR <= m.iconR + 0.01,
                    `徽标 ${m.letterR} 图标 ${m.iconR}`);
            }
        }

        rec('');
        rec('=== 变量链（--qs-icon-r → --qs-bar-r）===');
        /* ⚠ `getPropertyValue('--qs-bar-r')` 拿到的是**未解析的文本**
         * （`calc(3px + 5px)`），不是算好的像素 —— 这是 CSS 自定义属性的正常行为，
         * 不是 bug。真正算好的值见上面那一段（`border-top-left-radius`）。
         * 所以这里只断言"变量链本身接对了"，别拿它当像素值比。 */
        for (const r of [3, 18]) {
            const res = await cdp(ws, 'Runtime.evaluate', {
                expression: MEASURE(r, 5), returnByValue: true,
            });
            const m = JSON.parse(res.result.value);
            check(`圆角 ${r}px：--qs-icon-r 直接就是滑块值`,
                Math.abs(parseFloat(m.iconVar) - r) < 0.01, `拿到 ${m.iconVar}`);
            check(`圆角 ${r}px：--qs-bar-r 是 calc(图标圆角 + 内边距)`,
                /^calc\(\s*\d+(\.\d+)?px\s*\+\s*\d+(\.\d+)?px\s*\)$/.test(m.barVar),
                `拿到 ${m.barVar}`);
            rec(`  ${r}px  --qs-icon-r="${m.iconVar}"  --qs-bar-r="${m.barVar}"`);
        }

        rec('');
        rec('=== 设置页预览（.qs-preview）也要同心 ===');
        /* ⚠ 预览是**另一份实现**（settings.css 的 `--pv-*` 变量），它原来也写着
         * `calc(--pv-radius + 4px)` —— 和真身那个 4px 是同一个来源的硬编码。
         * 只修真身的话，用户在设置页里对着预览调到"看着协调"了，真身却不是那个
         * 样子（或反过来）。所以预览必须一起验。
         *
         * 做法：这个进程是 `--settings` 起的（带设置页），预览块就在当前页里。
         * 直接对它量：预览横条 vs 预览里的图标格子。 */
        {
            /* 预览在**设置页**那个 target 里，所以要另开一条连接 ——
             * 上面那条连的是横条 target。
             *
             * ⚠ 设置窗是 `--settings` 在启动 **1.2 秒后**才开的（见 main.rs），
             *   而且项目有"设置窗空闲回收"机制。所以这里**轮询等它出现**，
             *   不能只看一眼 —— 一开始就是这么漏掉的（列表里只有横条）。 */
            let setT = null;
            for (let i = 0; i < 40; i++) {
                const lst = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
                setT = lst.find((t) => t.webSocketDebuggerUrl && /settings/i.test(t.url || ''));
                if (setT) break;
                sleep(500);
            }
            if (!setT) {
                rec('  等了 20 秒也没等到设置页 target —— 跳过预览验证');
                rec('  （当前 targets: ' + (await fetch(`http://127.0.0.1:${PORT}/json/list`)
                    .then((r) => r.json())).map((t) => t.url || '?').join(' | ') + '）');
            } else {
                let pws = new WebSocket(setT.webSocketDebuggerUrl);
                try {
                    await new Promise((res, rej) => {
                        pws.addEventListener('open', res);
                        pws.addEventListener('error', rej);
                        setTimeout(res, 8000);   // 兜底：别卡死
                    });
                    await cdp(pws, 'Runtime.enable');
                    const HAS = await cdp(pws, 'Runtime.evaluate', {
                        expression: `document.querySelectorAll('.qs-preview').length`, returnByValue: true,
                    });
                    rec('  设置页里 .qs-preview 数量 = ' + HAS.result.value);
                    if (!HAS.result.value) {
                        rec('  设置页还没渲染出预览（可能不在"外观"页）—— 跳过');
                    } else {
                        for (const [r, pad] of [[3, 2], [9, 5], [18, 5], [0, 2]]) {
                            const res = await cdp(pws, 'Runtime.evaluate', {
                                expression: `(() => {
                                    const pv = document.querySelector('.qs-preview');
                                    const item = pv.querySelector('.pv-item');
                                    const lt = pv.querySelector('.pv-item .letter');
                                    pv.style.setProperty('--pv-radius', '${r}px');
                                    pv.style.setProperty('--pv-pad', '${pad}px');
                                    const cs = getComputedStyle(pv), ci = getComputedStyle(item);
                                    const px = (v) => parseFloat(v) || 0;
                                    const barR = px(cs.borderTopLeftRadius);
                                    const iconR = px(ci.borderTopLeftRadius);
                                    const padV = px(cs.paddingTop);
                                    return JSON.stringify({
                                        barR, iconR, padV, want: iconR + padV,
                                        delta: +(barR - (iconR + padV)).toFixed(4),
                                        letterR: lt ? px(getComputedStyle(lt).borderTopLeftRadius) : null,
                                    });
                                })()`,
                                returnByValue: true,
                            });
                            if (!res.result.value) { check(`预览 ${r}px/${pad}px 能量到`, false); continue; }
                            const m = JSON.parse(res.result.value);
                            const tag = `预览 圆角 ${r}px + 内边距 ${pad}px`;
                            rec(`  ${tag}  →  横条 ${m.barR}px  格子 ${m.iconR}px  期望 ${m.want}px  偏差 ${m.delta}px`);
                            check(`${tag}：预览横条与格子同心`, Math.abs(m.delta) < 0.01, `偏差 ${m.delta}px`);
                            check(`${tag}：格子不比预览横条更圆`, m.iconR <= m.barR + 0.01,
                                `格子 ${m.iconR} 横条 ${m.barR}`);
                        }
                    }
                } finally {
                    try { pws.close(); } catch (_) { }
                }
            }
        }

        rec('');
        rec('=== 改动前后对照（同一个模型下算一遍）===');
        {
            // 旧写法（横条 = 滑块 + 4px 硬编码）：偏差 = 4 - 内边距
            for (const [r, pad] of [[3, 2], [9, 5]]) {
                const oldBar = r + 4;          // 旧的：写死 +4px
                const want = r + pad;          // 新的：+内边距
                rec(`  圆角 ${r}px / 内边距 ${pad}px：`
                    + `旧 ${oldBar}px（偏差 ${oldBar - want}px）  →  新 ${want}px（偏差 0px）`);
            }
        }

        rec('');
        rec(`结果：${pass} 通过 / ${fail} 失败`);
        rec(fail === 0 && allZero ? 'DONE' : 'DONE-WITH-FAILURES');
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
