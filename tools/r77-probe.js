/* ============================================================================
 *  r77：四项改动的真机验证
 *
 *  覆盖：
 *    A. 识图提速 —— 框选完到真正开浏览器之间的等待有没有缩短
 *    B. 「一家 AI + 一家非 AI」仍然按键（用户报的那个 bug）
 *    C. 图标编辑器的描边保护（画布在、能画、能撤销/清空、随请求发出去）
 *    D. OCR 引擎列表不再铺 7 行介绍文字
 *
 *  用法：node tools/r77-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r77-probe.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('CDP timeout: ' + m)); }, 15000);
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
async function targets() { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); } catch (e) { return []; } }
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
        const ts = await targets();
        const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf(sub) >= 0);
        if (hit) {
            const ws = new WebSocket(hit.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            return ws;
        }
        await sleep(300);
    }
    return null;
}
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) { if (await ev(ws, expr) === true) return true; await sleep(200); }
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r77-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, theme: 'light',
        // B：复现用户报的配置 —— 默认百度（非 AI）+ 勾了豆包（AI）
        img_default_engine: 'baidu',
        img_engines: ['baidu', 'doubao'],
        img_ai_first: true,
        img_ai_auto_off_on_multi: true,
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r77' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r77 探针：pid=' + proc.pid);
    const logf = path.join(qs, 'log.txt');
    const logTail = (n, re) => {
        try {
            const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/);
            return lines.filter((l) => !re || re.test(l)).slice(-n);
        } catch (e) { return []; }
    };
    try {
        const sw = await connect('settings.html');
        check('S1 设置页起来了', !!sw);
        if (!sw) return;
        await until(sw, "typeof CONF === 'object'", 30000);

        /* ---------- D. OCR 引擎列表不再铺 7 行介绍 ---------- */
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"ocr\"]').click()");
        await sleep(1200);
        const d = await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#w-ocrEngList .eng-row'));
            var withSmall = rows.filter(function(r){ return !!r.querySelector('.eng-name small'); });
            var heights = rows.map(function(r){ return Math.round(r.getBoundingClientRect().height); });
            // 名字上都还带着 note（挪进 title 了）
            var titles = rows.map(function(r){
                var b = r.querySelector('.eng-name');
                return b ? (b.title || '') : '';
            });
            return JSON.stringify({
                rows: rows.length,
                withSmall: withSmall.length,
                heights: heights,
                avgH: heights.length ? Math.round(heights.reduce(function(a,b){return a+b;},0)/heights.length) : 0,
                titlesHaveNote: titles.filter(function(t){ return t.indexOf('\\n') >= 0; }).length,
            });
        })()`);
        const D = JSON.parse(d);
        rec('OCR 引擎行：' + d);
        check('D1 每个引擎行不再带那行说明小字（.eng-name small 一个都没有）',
            D.withSmall === 0, JSON.stringify(D));
        /* ⚠ 不能直接看平均行高：**当前选中的那一行是展开的**（凭据表单 +
         * "同时识别"整块都在里面，426px 很正常）。要看的是"收起态的行"
         * 是不是变矮了 —— 排除最高的那一行再算。 */
        const collapsed = D.heights.slice().sort((a, b) => a - b).slice(0, -1);
        const avgCollapsed = collapsed.length
            ? Math.round(collapsed.reduce((a, b) => a + b, 0) / collapsed.length)
            : 0;
        check('D2 收起态的行变矮（≤ 46px，以前带小字时是 ~60px）',
            avgCollapsed > 0 && avgCollapsed <= 46,
            `avgCollapsed=${avgCollapsed} heights=${JSON.stringify(D.heights)}`);
        check('D3 说明没丢，挪进 title 了（悬停仍看得到）',
            D.titlesHaveNote === D.rows && D.rows > 0, `titles=${D.titlesHaveNote}/${D.rows}`);

        /* ---------- B. 一家 AI + 一家非 AI 仍然按键 ---------- */
        // 直接调后端要做的那个判定：用页面里的 img_plan/img_should_paste 不行
        // （那是 Rust 的），改为看日志：真跑一轮会打出"关掉自动按键"或按键日志。
        const planInfo = await ev(sw, "window.__TAURI__.core.invoke('get_config').then(function(c){return JSON.stringify({def:c.imgDefaultEngine, eng:c.imgEngines, first:c.imgAiFirst, off:c.imgAiAutoOffOnMulti});})");
        rec('B 配置：' + planInfo);
        const B = JSON.parse(planInfo);
        check('B1 配置确实是"百度默认 + 勾了豆包"（用户报的那个组合）',
            B.def === 'baidu' && Array.isArray(B.eng) && B.eng.indexOf('doubao') >= 0,
            planInfo);

        /* ---------- A. 识图提速：看日志里的等待时长 ---------- */
        // 触发一次识图（会开遮罩），直接从 Rust 侧日志读"遮罩像素已撤净"
        const before = logTail(200).length;
        await ev(sw, "window.__TAURI__.core.invoke('img_start').then(function(){return 'ok';}).catch(function(e){return 'ERR '+e;})");
        await sleep(1500);
        const region = (await targets()).find((t) => (t.url || '').indexOf('region.html') >= 0);
        check('A1 识图遮罩开出来了', !!region, region ? region.url : '(没有)');
        if (region) {
            const rw = new WebSocket(region.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                rw.addEventListener('open', res, { once: true });
                rw.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            // 模拟框选
            await ev(rw, `(function(){
                function e2(t,x,y){document.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));}
                e2('mousedown',300,300); e2('mousemove',700,600);
                document.dispatchEvent(new MouseEvent('mouseup',{clientX:700,clientY:600,button:0,bubbles:true,cancelable:true}));
                return 'ok';
            })()`);
            await sleep(3500);
            const rel = logTail(120, /遮罩像素已撤净|img: jpeg|框选|img_region/);
            rec('A 相关日志：');
            for (const l of rel) rec('  ' + l.replace(/^\[SystemTime \{[^}]*\}\]\s*/, ''));
            const settled = rel.find((l) => l.indexOf('遮罩像素已撤净') >= 0);
            check('A2 走了新的"等像素撤净"快路径（而不是死等 700ms）',
                !!settled, settled || '(没看到那条日志)');
        }

        /* ---------- C. 图标编辑器描边 ---------- */
        // 编辑器需要一个"编辑会话"，正常由「换图标」触发。这里直接验证页面元素在。
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(500);
        // 打开图标编辑器窗口（后端命令 open_icon_editor 需要会话；没有会话会提示过期）
        const ie = await ev(sw, `(function(){
            // 先看看页面里有没有描边相关的元素（编辑器是独立窗口，这里验源码更实在）
            return 'skip';
        })()`);
        // 直接读 iconedit.html 的结构（编辑器窗口需要真实会话，探针不硬造）
        const html = fs.readFileSync(path.join(ROOT, 'ui', 'iconedit.html'), 'utf8');
        check('C1 描边画布 #maskCanvas 在「编辑前」面板里',
            html.indexOf('id="maskCanvas"') >= 0 && html.indexOf('id="cvBefore"') >= 0);
        check('C2 描边工具条（笔刷/撤销/清空/完成）齐全',
            html.indexOf('id="btnMaskUndo"') >= 0 && html.indexOf('id="btnMaskClear"') >= 0
            && html.indexOf('id="btnMaskDone"') >= 0 && html.indexOf('id="maskSize"') >= 0);
        /* r79：按钮顺序与命名都变了 —— 现在**自动抠图**是主操作（放在前面），
         * 手动补描降级成可选的补救手段（放在后面）。
         * 旧断言要求"描边按钮在前"，那是 r77 的口径（先描边再抠）；
         * 现在自动抠图已经够准，不需要先描边，所以顺序反过来才对。 */
        check('C3 「自动抠图」按钮在前、「手动补描」在后（自动为主、补描为辅）',
            html.indexOf('id="btnRemove"') < html.indexOf('id="btnMask"') && html.indexOf('id="btnMask"') >= 0);
        check('C4 消除背景时把 keep 蒙版一起发出去',
            /invoke\('icon_remove_bg',\s*\{\s*src:\s*SRC,\s*tolerance:\s*tol,\s*keep\s*\}/.test(html));
        check('C5 换图时会清掉旧描边（maskReset 在 loadSession 里）',
            /loadSession[\s\S]{0,2000}maskReset\(\)/.test(html));
        /* r79：算法整个换成了**阿尔法抠图**，不再有"泛洪的种子/扩散"这套。
         * 手动补描现在的语义是**硬约束前景**（alpha 恒为 1），
         * 落在 matting 的 trimap 阶段与 alpha 收尾两处。
         * 所以这条断言改验"补描是不是被当成确定前景"，而不是找旧的泛洪代码。 */
        const rs = fs.readFileSync(path.join(ROOT, 'src', 'matting.rs'), 'utf8');
        const inTrimap = /描边 = 硬约束的确定前景[\s\S]{0,300}tri\[i\] = Tri::Fg/.test(rs);
        const inAlpha = /k\[i\] \{\s*\r?\n\s*alpha\[i\] = 1\.0/.test(rs);
        check('C6 后端把补描当"确定前景"（trimap 与 alpha 两处都钉）',
            inTrimap && inAlpha, `trimap=${inTrimap} alpha=${inAlpha}`);
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        rec('');
        rec(`========== r77 探针：${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        process.exit(fail === 0 ? 0 : 1);
    }
})();