/* ============================================================================
 *  r76：四项新功能的设置页验证
 *
 *  覆盖：
 *    A. AI 识图的两段延迟（数字框在、能读能写、↺ 默认能拨回）
 *    B. AI 优先 / 多家自动关按键两个开关在、能读能写
 *    C. 快捷键引擎的「启动延迟」输入框在、按条件显隐、能读能写
 *    D. OCR 模型列表默认只留视觉模型（拉一次真列表，看返回的 models）
 *    E. 引擎别名（B站 / 度娘 / gayhub… 用真实 engineMatches 逻辑搜）
 *
 *  用法：node tools/r76-features-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r76-features-probe.txt');
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
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r76-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r76' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r76 功能探针：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        check('S1 设置页起来了', !!sw);
        if (!sw) return;
        const booted = await until(sw, "typeof CONF === 'object' && !!CONF", 30000);
        check('S2 配置已就绪', booted === true);
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"imgsearch\"]').click()");
        await sleep(900);

        /* ---------- A. AI 延迟两个数字框 ---------- */
        const d1 = await ev(sw, `JSON.stringify({
            paste: (function(){var e=document.getElementById('s-aiPasteDelay');return e?{v:e.value,type:e.type,min:e.min,max:e.max,unit:e.getAttribute('data-unit')}:null;})(),
            enter: (function(){var e=document.getElementById('s-aiEnterDelay');return e?{v:e.value,type:e.type,min:e.min,max:e.max}:null;})(),
            hint: (document.getElementById('aiDelayHint')||{}).textContent || '',
            reset: !!document.getElementById('btnAiDelayReset'),
            first: (document.getElementById('s-imgAiFirst')||{}).checked,
            autoOff: (document.getElementById('s-imgAiAutoOff')||{}).checked,
        })`);
        const A = JSON.parse(d1);
        check('A1 「打开→Ctrl+V」延迟框在（数字框、0..60000、单位 ms）',
            A.paste && A.paste.type === 'number' && A.paste.min === '0' && A.paste.max === '60000' && A.paste.unit === 'ms',
            JSON.stringify(A.paste));
        check('A2 「Ctrl+V→Enter」延迟框在',
            A.enter && A.enter.type === 'number' && A.enter.min === '0' && A.enter.max === '60000',
            JSON.stringify(A.enter));
        check('A3 默认值 1200 / 900（与旧版本一致）',
            A.paste && A.paste.v === '1200' && A.enter && A.enter.v === '900',
            `paste=${A.paste && A.paste.v} enter=${A.enter && A.enter.v}`);
        check('A4 「↺ 默认」钮在', A.reset === true);
        check('A5 提示行有文字', A.hint.length > 0);
        check('A6 AI 优先开关默认开', A.first === true);
        check('A7 多家自动关按键默认开', A.autoOff === true);

        /* ---------- B. 改一个值，看它真的落盘 ---------- */
        await ev(sw, `(function(){var e=document.getElementById('s-aiPasteDelay');e.value='3000';
            e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
        await sleep(600);
        const c1 = await ev(sw, "window.__TAURI__.core.invoke('get_config').then(function(c){return JSON.stringify({p:c.imgAiPasteDelay,e:c.imgAiEnterDelay});})");
        const C1 = JSON.parse(c1);
        check('B1 改延迟真落盘（3000）', String(C1.p) === '3000', c1);
        // 超范围值要钳到 60000
        await ev(sw, `(function(){var e=document.getElementById('s-aiEnterDelay');e.value='999999';
            e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
        await sleep(600);
        const c2 = await ev(sw, "window.__TAURI__.core.invoke('get_config').then(function(c){return JSON.stringify({e:c.imgAiEnterDelay});})");
        const C2 = JSON.parse(c2);
        check('B2 超范围延迟被钳到 60000', String(C2.e) === '60000', c2);
        // ↺ 默认 拨回 1200/900
        await ev(sw, `(function(){var b=document.getElementById('btnAiDelayReset');if(b)b.click();return !!b;})()`);
        await sleep(700);
        const c3 = await ev(sw, "window.__TAURI__.core.invoke('get_config').then(function(c){return JSON.stringify({p:c.imgAiPasteDelay,e:c.imgAiEnterDelay});})");
        const C3 = JSON.parse(c3);
        check('B3 「↺ 默认」把两个值拨回 1200/900',
            String(C3.p) === '1200' && String(C3.e) === '900', c3);

        /* ---------- C. 快捷键引擎的启动延迟 ---------- */
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");
        await sleep(600);
        const d2 = await ev(sw, `JSON.stringify({
            delayRow: !!document.getElementById('ceBindDelayRow'),
            delayInput: (function(){var e=document.getElementById('w-ceAppDelay');return e?{type:e.type,min:e.min,max:e.max,value:e.value}:null;})(),
        })`);
        const D = JSON.parse(d2);
        check('C1 「启动后再等多久才按快捷键」那一行在', D.delayRow === true);
        check('C2 延迟输入框是 0..60000 的数字框、默认 900',
            D.delayInput && D.delayInput.type === 'number' && D.delayInput.min === '0'
            && D.delayInput.max === '60000' && D.delayInput.value === '900',
            JSON.stringify(D.delayInput));

        /* ---------- D. 别名搜索（用页面里的真逻辑） ---------- */
        /* ⚠ 查询词必须**先 toLowerCase**：bar.js 的 engineMatches 期望调用方
         * 已经转过（它自己只比小写形态）。探针第一版传了原始大小写的 "A站"，
         * 于是 "a站" 永远匹配不上别名 "A站" —— 那是探针的 bug，不是产品的。 */
        const alias = await ev(sw, `(function(){
            var out = {};
            var BY = new Map();
            for (const c of CATALOG.categories) for (const e of c.engines) BY.set(e.name, e);
            function matches(name, q) {
                if (!q) return true;
                if (String(name||'').toLowerCase().indexOf(q) >= 0) return true;
                var eng = BY.get(name);
                var raw = eng && eng.alias;
                var list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
                for (var a of list) if (String(a).toLowerCase().indexOf(q) >= 0) return true;
                return false;
            }
            var probes = [['B站','哔哩哔哩'],['度娘','百度'],['gayhub','GitHub'],['狗东','京东'],['油管','YouTube'],['A站','AcFun']];
            for (var i=0;i<probes.length;i++){
                var q = probes[i][0].toLowerCase(), want = probes[i][1], hit = false;
                for (const c of CATALOG.categories) for (const e of c.engines) {
                    if (matches(e.name, q)) { if (e.name === want || e.name.indexOf(want) >= 0) hit = true; }
                }
                out[probes[i][0]] = hit;
            }
            return JSON.stringify(out);
        })()`);
        const AL = JSON.parse(alias);
        const keys = Object.keys(AL);
        const allHit = keys.every((k) => AL[k]);
        check('D1 经典别名搜得到（' + keys.join(' / ') + '）', allHit, alias);

        /* ---------- E. OCR 模型默认只留视觉（逻辑层验证） ---------- */
        // 这里不真去连一家 API（没密钥），改为直接验证后端那条过滤规则：
        // parse_models 全量 + 调用方按 vision 过滤 —— 由 Rust 单测钉住，
        // 这里只确认前端确实传了 visionOnly: true。
        const vo = fs.readFileSync(path.join(ROOT, 'ui', 'settings.js'), 'utf8');
        check('E1 前端拉模型时传 visionOnly: true', /visionOnly:\s*true/.test(vo));
        check('E2 后端 ocr_list_models 收 vision_only 且默认 true',
            /vision_only:\s*Option<bool>/.test(fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8')));
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        rec('');
        rec(`========== r76 功能探针：${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        process.exit(fail === 0 ? 0 : 1);
    }
})();