/* ============================================================================
 *  横条圆角同心 · 修复前后对照截图（r83）
 *
 *  用户报的问题：
 *    「鼠标放在一个图标上面……有一个外框，但是这个外框的圆角并没有跟横条的
 *      圆角一致，整体看起来很不协调。」
 *
 *  这条脚本拍几张图做对照：
 *    before   模拟**修复前**：圆角 3px、内边距 2px、横条圆角=滑块+4px（旧的硬编码）→ 7px
 *    after    **修复后**：同参数，横条圆角 = 图标圆角 + 内边距 → 5px
 *    default  默认档：圆角 9px、内边距 5px → 横条 14px / 图标 9px
 *    after-r18 上限档（最圆，最容易看出不协调）
 *
 *  ## 为什么用 CSS.forcePseudoState 而不是真移鼠标
 *
 *  `:hover` 是**浏览器的状态**，JS 改不了（加个类不算真 hover，看不出真实渲染）。
 *  CDP 有 `CSS.forcePseudoState` 专门干这个：强制某个节点处于 hover 态，
 *  渲染管线会真的按 `:hover` 那条规则画。这样：
 *    · 不用猜图标的屏幕坐标（上一版脚本就把鼠标放到了横条左边缘、没碰到图标）；
 *    · 每次截图之间不会因为鼠标移动而抖动，对照图的差异**只**来自圆角。
 *
 *  ## 输出
 *
 *  tools/_r83-before.png / _r83-after.png / _r83-default.png / _r83-after-r18.png
 *  tools/_r83-cases.json（每档实测到的圆角数值）
 *
 *  用法：node tools/bar-radius-shot.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9343;
const TAG = '-shot-r83';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rec = (s) => console.log(s);

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

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-shotr83-'));
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
    const child = spawn(EXE, ['--bar'], { env, stdio: 'ignore' });
    let ws = null;
    try {
        let ok = false;
        for (let i = 0; i < 60; i++) {
            sleep(500);
            try {
                const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
                const page = list.find((t) => t.webSocketDebuggerUrl);
                if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); ok = true; break; }
            } catch (e) { }
        }
        if (!ok) throw new Error('CDP 没就绪');
        await new Promise((res, rej) => {
            ws.addEventListener('open', res);
            ws.addEventListener('error', rej);
        });
        await cdp(ws, 'Runtime.enable');
        await cdp(ws, 'Page.enable');
        await cdp(ws, 'DOM.enable');
        await cdp(ws, 'CSS.enable');
        rec('CDP 已连上');

        let ready = false;
        for (let i = 0; i < 60; i++) {
            const r = await cdp(ws, 'Runtime.evaluate', {
                expression: `document.querySelectorAll('#engines .ico, #engines .engine').length`,
                returnByValue: true,
            });
            if (r.result.value > 0) { ready = true; break; }
            sleep(400);
        }
        if (!ready) throw new Error('横条没有引擎图标');
        rec('引擎图标已渲染');

        /* 拿第一颗图标的 nodeId。
         *
         * ⚠ 这里踩过一次坑：一开始用 `Runtime.evaluate` 拿到 objectId、
         *   再 `DOM.requestNode` 换 nodeId —— 结果返回 **nodeId = 0**，
         *   紧接着 `CSS.forcePseudoState` 报 "Could not find node with given id"。
         *   原因：`Runtime.evaluate` 在那个页面上执行时，返回的 remote object
         *   属于页面主世界之外（或者被当成非元素节点），requestNode 换不出来。
         *
         * 可靠的办法是走 DOM 自己的查询：`DOM.getDocument` 拿根节点，
         * 再用 `DOM.querySelector` 按选择器找 —— 这条路返回的 nodeId 一定能用。
         */
        const doc = await cdp(ws, 'DOM.getDocument', { depth: 1 });
        const rootId = doc.root.nodeId;
        const q = await cdp(ws, 'DOM.querySelector', {
            nodeId: rootId,
            selector: '#engines .ico, #engines .engine',
        });
        const nodeId = q.nodeId;
        if (!nodeId) throw new Error('DOM.querySelector 没找到第一颗图标（nodeId=0）');
        rec('第一颗图标 nodeId = ' + nodeId);

        await cdp(ws, 'CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
        rec('已强制 :hover');

        const CASES = [
            { name: 'before', r: 3, pad: 2, barR: '7px' },
            { name: 'after', r: 3, pad: 2, barR: null },
            { name: 'default', r: 9, pad: 5, barR: null },
            { name: 'after-r18', r: 18, pad: 5, barR: null },
        ];

        const out = [];
        for (const c of CASES) {
            const setRes = await cdp(ws, 'Runtime.evaluate', {
                expression: `(() => {
                    const st = document.getElementById('stage');
                    st.style.setProperty('--qs-radius', '${c.r}px');
                    st.style.setProperty('--qs-bar-pad', '${c.pad}px');
                    ${c.barR ? `st.style.setProperty('--qs-bar-r', '${c.barR}');` : `st.style.removeProperty('--qs-bar-r');`}
                    const bar = document.getElementById('bar');
                    const icon = document.querySelectorAll('#engines .ico, #engines .engine')[0];
                    const cs = getComputedStyle(bar), ci = getComputedStyle(icon);
                    const px = (v) => parseFloat(v) || 0;
                    const b = bar.getBoundingClientRect();
                    return JSON.stringify({
                        barR: px(cs.borderTopLeftRadius),
                        iconR: px(ci.borderTopLeftRadius),
                        padV: px(cs.paddingTop),
                        padH: px(cs.paddingLeft),
                        box: [b.left, b.top, b.width, b.height],
                    });
                })()`,
                returnByValue: true,
            });
            const m = JSON.parse(setRes.result.value);
            sleep(350);

            const shot = await cdp(ws, 'Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: true,
                clip: { x: m.box[0], y: m.box[1], width: m.box[2], height: m.box[3], scale: 6 },
            });
            const file = path.join(__dirname, `_r83-${c.name}.png`);
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
            const delta = (m.barR - (m.iconR + m.padV)).toFixed(2);
            rec(`  ${c.name.padEnd(10)} 横条 ${String(m.barR).padStart(5)}px  图标 ${m.iconR}px  `
                + `内边距 ${m.padV}/${m.padH}  同心偏差 ${delta}px   → ${path.basename(file)}`);
            out.push({ name: c.name, r: c.r, pad: c.pad, barR: m.barR, iconR: m.iconR, delta: Number(delta), file: path.basename(file) });
        }

        fs.writeFileSync(path.join(__dirname, '_r83-cases.json'), JSON.stringify(out, null, 2));
        rec('DONE');
    } catch (e) {
        rec('EXCEPTION: ' + (e && e.message));
        process.exitCode = 1;
    }
    try { if (ws) ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
    sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
})();
