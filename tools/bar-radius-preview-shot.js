/* ============================================================================
 *  设置页「横条预览」圆角 · 修复前后对照截图（r83）
 *
 *  为什么单独拍预览：预览是**另一份实现**（settings.css 的 --pv-* 变量），
 *  它原来也写着 `calc(--pv-radius + 4px)` —— 和真身那个 4px 硬编码同源。
 *  只修真身的话，用户在设置页里对着预览调到"看着协调"了，真身却不是那样。
 *
 *  这条脚本强制预览里第一个格子的 :hover，拍两张：
 *    before  模拟修复前：圆角 3 / 内边距 2 / 预览横条 = 滑块 + 4px → 7px
 *    after   **修复后**：同参数，预览横条 = 格子圆角 + 内边距 → 5px
 *
 *  用法：node tools/bar-radius-preview-shot.js
 *  输出：tools/_r83-pv-before.png / _r83-pv-after.png
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9344;
const TAG = '-shot-pv-r83';
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-shotpv-'));
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

    rec('启动隔离实例（--settings 让设置页开起来）');
    const child = spawn(EXE, ['--bar', '--settings'], { env, stdio: 'ignore' });
    let ws = null;
    try {
        // 等设置页 target 出现
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
        rec('设置页 target 就绪');
        ws = new WebSocket(setT.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res);
            ws.addEventListener('error', rej);
        });
        await cdp(ws, 'Runtime.enable');
        await cdp(ws, 'Page.enable');
        await cdp(ws, 'DOM.enable');
        await cdp(ws, 'CSS.enable');
        rec('CDP 已连上（设置页）');

        // 等预览渲染出来
        let ready = false;
        for (let i = 0; i < 60; i++) {
            const r = await cdp(ws, 'Runtime.evaluate', {
                expression: `(document.querySelector('.qs-preview')||{}).querySelectorAll
                    ? document.querySelectorAll('.qs-preview .pv-item').length : 0`,
                returnByValue: true,
            });
            if (r.result.value > 0) { ready = true; break; }
            sleep(400);
        }
        if (!ready) throw new Error('预览里没有格子');
        rec('预览格子已渲染');

        const doc = await cdp(ws, 'DOM.getDocument', { depth: 1 });
        const q = await cdp(ws, 'DOM.querySelector', {
            nodeId: doc.root.nodeId, selector: '.qs-preview .pv-item',
        });
        if (!q.nodeId) throw new Error('找不到预览格子');
        await cdp(ws, 'CSS.forcePseudoState', { nodeId: q.nodeId, forcedPseudoClasses: ['hover'] });
        rec('已强制预览格子的 :hover');

        const CASES = [
            { name: 'pv-before', r: 3, pad: 2, barR: '7px' },
            { name: 'pv-after', r: 3, pad: 2, barR: null },
            { name: 'pv-default', r: 9, pad: 5, barR: null },
        ];
        for (const c of CASES) {
            const res = await cdp(ws, 'Runtime.evaluate', {
                expression: `(() => {
                    const pv = document.querySelector('.qs-preview');
                    pv.style.setProperty('--pv-radius', '${c.r}px');
                    pv.style.setProperty('--pv-pad', '${c.pad}px');
                    ${c.barR ? `pv.style.setProperty('--pv-bar-r', '${c.barR}');`
                             : `pv.style.removeProperty('--pv-bar-r');`}
                    const item = pv.querySelector('.pv-item');
                    const cs = getComputedStyle(pv), ci = getComputedStyle(item);
                    const px = (v) => parseFloat(v) || 0;
                    const b = pv.getBoundingClientRect();
                    return JSON.stringify({
                        barR: px(cs.borderTopLeftRadius), iconR: px(ci.borderTopLeftRadius),
                        padV: px(cs.paddingTop),
                        box: [b.left, b.top, b.width, b.height],
                    });
                })()`,
                returnByValue: true,
            });
            const m = JSON.parse(res.result.value);
            sleep(350);
            const shot = await cdp(ws, 'Page.captureScreenshot', {
                format: 'png', captureBeyondViewport: true,
                clip: { x: m.box[0], y: m.box[1], width: m.box[2], height: m.box[3], scale: 6 },
            });
            const file = path.join(__dirname, `_r83-${c.name}.png`);
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
            const delta = (m.barR - (m.iconR + m.padV)).toFixed(2);
            rec(`  ${c.name.padEnd(11)} 预览横条 ${String(m.barR).padStart(5)}px  格子 ${m.iconR}px  `
                + `内边距 ${m.padV}  偏差 ${delta}px  → ${path.basename(file)}`);
        }
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
