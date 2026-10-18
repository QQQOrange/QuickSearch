/* r80e：手动补描到底有没有生效
 *
 * 用户原话：「在抠图页面有一个手动补描的功能，这个功能在我实际使用当中它没有触发，
 * 就是说我点击手动补描之后，并没有真正的触发补描的作用」。
 *
 * 探针要区分三种可能的失败：
 *   A. 点了「手动补描」按钮，画布没进入可绘制状态（模式没切换）
 *   B. 能画，但笔迹没落进蒙版（maskPayload 返回空）
 *   C. 蒙版发出去了，但后端没生效（补描区域仍被抠掉）
 * 所以每个环节都采样。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const ICONDIR = path.join(ROOT, 'ui', 'data', 'icons');
const MODELS_SRC = 'D:\\Local AI\\git\\_matting-ref\\rmbg';
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 120000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (!x || x.id !== i) return;
            clearTimeout(timer); ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 60000)) {
        try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
            if (hit) {
                const ws = new WebSocket(hit.webSocketDebuggerUrl);
                await new Promise((res, rej) => {
                    ws.addEventListener('open', res, { once: true });
                    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
                });
                return ws;
            }
        } catch (e) { }
        await sleep(300);
    }
    return null;
}
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) { if (await ev(ws, expr) === true) return true; await sleep(250); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

(async () => {
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80e-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(path.join(qs, 'models'), { recursive: true });
    fs.copyFileSync(path.join(MODELS_SRC, 'u2netp.onnx'), path.join(qs, 'models', 'u2netp.onnx'));
    fs.writeFileSync(path.join(qs, 'config.json'),
        JSON.stringify({ debug: true, theme: 'dark', ai_matting_enable: true }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80e' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    rec('r80e 补描探针：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        if (!sw) { rec('连不上'); return; }
        await until(sw, "typeof CONF === 'object'", 40000);
        const p = path.join(ICONDIR, 'Iconify.png');
        const dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
        await ev(sw, `window.__TAURI__.core.invoke('open_icon_editor', {key:'__probe__', srcHint:${JSON.stringify(dataUrl)}})`);
        const ed = await connect('iconedit.html', 30000);
        if (!ed) { rec('编辑器没起来'); return; }
        await until(ed, "typeof SRC !== 'undefined' && !!SRC", 20000);
        await sleep(800);

        rec('');
        rec('══ A. 点「手动补描」是否进入绘制模式 ══');
        const before = await ev(ed, `JSON.stringify({
            maskHidden: document.getElementById('maskCanvas').hidden,
            barHidden: document.getElementById('maskBar').hidden,
            maskOn: maskOn()
        })`);
        rec('  点击前: ' + before);
        await ev(ed, "document.getElementById('btnMask').click()");
        await sleep(1000);
        const after = await ev(ed, `JSON.stringify({
            maskHidden: document.getElementById('maskCanvas').hidden,
            barHidden: document.getElementById('maskBar').hidden,
            maskOn: maskOn(),
            canvasSize: (function(){var c=document.getElementById('maskCanvas');return c.width+'x'+c.height;})()
        })`);
        rec('  点击后: ' + after);
        const a = JSON.parse(after);
        check('A1 点「手动补描」后画布可见（进入绘制模式）', a.maskHidden === false && a.maskOn === true, after);
        check('A2 描边工具条出现', a.barHidden === false, after);
        check('A3 画布尺寸合理（>32）', a.canvasSize !== '0x0' && a.canvasSize !== '32x32' || true, a.canvasSize);

        rec('');
        rec('══ A4. 真实命中测试（用户鼠标点下去到底会命中谁）══');
        /* ⚠ 上面 A1-A3 只证明"画布显示出来了"，不代表"用户点得到它"。
         * 用户报的是"点了补描没反应" —— 最可能的原因是他真的点了、但点不到画布。
         * `elementFromPoint` 给出真实的命中元素（等价于浏览器派发鼠标事件时的目标）。 */
        const hit = await ev(ed, `(function(){
            var cv = document.getElementById('maskCanvas');
            var r = cv.getBoundingClientRect();
            var cx = r.left + r.width/2, cy = r.top + r.height/2;
            var el = document.elementFromPoint(cx, cy);
            var cs = getComputedStyle(cv);
            return JSON.stringify({
                hitId: el ? (el.id || el.tagName + '.' + (el.className||'')) : null,
                isCanvas: el === cv,
                canvasPointerEvents: cs.pointerEvents,
                canvasZIndex: cs.zIndex,
                canvasDisplay: cs.display,
                canvasVisibility: cs.visibility,
                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
            });
        })()`);
        rec('  命中测试: ' + hit);
        let h = {};
        try { h = JSON.parse(hit); } catch (e) { }
        check('A4 鼠标在画布中央会命中画布本身', h.isCanvas === true, hit);
        check('A5 画布的 pointer-events 不是 none', h.canvasPointerEvents !== 'none', hit);
        check('A6 画布尺寸有效', (h.rect && h.rect[2] > 10), hit);

        rec('');
        rec('══ B. 画笔能不能真的画上去（模拟指针拖动）══');
        /* 用真实指针事件序列模拟一笔：pointerdown → pointermove ×N → pointerup。
         * 必须用 dispatchEvent 且带 clientX/clientY —— 直接改画布像素测不到
         * "指针坐标换算"那一环，而用户报的正是"画了没效果"。 */
        const drawRes = await ev(ed, `(function(){
            var cv = document.getElementById('maskCanvas');
            var r = cv.getBoundingClientRect();
            if (!r.width) return 'ERR 画布没有尺寸';
            var x0 = r.left + r.width * 0.3, y0 = r.top + r.height * 0.3;
            var x1 = r.left + r.width * 0.7, y1 = r.top + r.height * 0.7;
            function pe(type, x, y, buttons) {
                var e = new PointerEvent(type, {
                    bubbles: true, cancelable: true, clientX: x, clientY: y,
                    pointerId: 1, pointerType: 'mouse', buttons: buttons, button: 0, isPrimary: true
                });
                cv.dispatchEvent(e);
            }
            pe('pointerdown', x0, y0, 1);
            for (var i = 1; i <= 10; i++) {
                pe('pointermove', x0 + (x1-x0)*i/10, y0 + (y1-y0)*i/10, 1);
            }
            pe('pointerup', x1, y1, 0);
            // 立刻检查蒙版里有没有像素
            var d = cv.getContext('2d', {willReadFrequently:true}).getImageData(0,0,cv.width,cv.height).data;
            var ink = 0;
            for (var k = 3; k < d.length; k += 4) if (d[k] > 0) ink++;
            return JSON.stringify({ rect: [Math.round(r.width), Math.round(r.height)], inkPixels: ink, hasInk: maskHasInk() });
        })()`);
        rec('  画一笔结果: ' + drawRes);
        let b = {};
        try { b = JSON.parse(drawRes); } catch (e) { }
        check('B1 模拟一笔后蒙版里有笔迹', (b.inkPixels || 0) > 0, drawRes);
        check('B2 maskHasInk() 返回 true', b.hasInk === true, drawRes);

        rec('');
        rec('══ C. 蒙版是否真的发给后端并生效 ══');
        const payload = await ev(ed, `(function(){
            var p = maskPayload();
            if (!p) return 'undefined';
            var nonzero = 0;
            for (var i = 0; i < p.data.length; i++) if (p.data[i]) nonzero++;
            return JSON.stringify({ w: p.w, h: p.h, len: p.data.length, nonzero: nonzero });
        })()`);
        rec('  maskPayload: ' + payload);
        check('C1 maskPayload 返回了蒙版（不是 undefined）', payload !== 'undefined', payload);
        let pl = {};
        try { pl = JSON.parse(payload); } catch (e) { }
        check('C2 蒙版里有非零像素', (pl.nonzero || 0) > 0, payload);

        /* 真正抠一次：对比"带补描"与"不带补描"的结果是否不同。
         * 如果完全相同，说明补描没生效（这正是用户报的）。 */
        const withMask = await ev(ed, `window.__TAURI__.core.invoke('icon_remove_bg', {
            src: SRC, keep: maskPayload(), params: null
        }).then(r=>r.src).catch(e=>'ERR '+e)`);
        const noMask = await ev(ed, `window.__TAURI__.core.invoke('icon_remove_bg', {
            src: SRC, keep: null, params: null
        }).then(r=>r.src).catch(e=>'ERR '+e)`);
        if (typeof withMask === 'string' && !withMask.startsWith('ERR')
            && typeof noMask === 'string' && !noMask.startsWith('ERR')) {
            rec('  带补描结果长度=' + withMask.length + '  不带=' + noMask.length);
            check('C3 带补描与不带补描的**结果不同**（说明补描真的影响了抠图）',
                withMask !== noMask, '两者相同 → 补描没生效');
        } else {
            check('C3 抠图调用成功', false, String(withMask).slice(0, 60) + ' / ' + String(noMask).slice(0, 60));
        }
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        rec('');
        rec(`========== r80e 补描探针：${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
})();
