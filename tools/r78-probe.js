/* ============================================================================
 *  r78：四项改动的真机验证
 *
 *  覆盖：
 *    A. 识图恢复旧逻辑 —— 上传类引擎不再"先开上传页"（标签页数量回到每家一个）
 *    B. 同时识别 → 结果窗并排多个文本框（pickDefaultMode 返回 all + 多框 DOM）
 *    C. 「识别引擎」那一行的小字没了（"点一家 = 设为默认引擎并展开它…"）
 *    D. 凭据区的介绍文字没了（cred-tip / multi-tip / 状态行提示）
 *
 *  用法：node tools/r78-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r78-probe.txt');
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r78-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, theme: 'light',
        ocr_engine: 'windows', ocr_multi: [],
        img_default_engine: 'doubao', img_engines: ['doubao'],
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r78' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r78 探针：pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        check('S1 设置页起来了', !!sw);
        if (!sw) return;
        await until(sw, "typeof CONF === 'object'", 30000);

        /* ---------- C. 「识别引擎」那一行的小字没了 ---------- */
        await ev(sw, "document.querySelector('#tabs button[data-tab=\"ocr\"]').click()");
        await sleep(1200);
        const c = await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('.pane[data-pane="ocr"] .row'));
            var engRow = rows.find(function(r){
                var b = r.querySelector('.rt > b');
                return b && b.textContent.trim() === '识别引擎';
            });
            return JSON.stringify({
                found: !!engRow,
                smallText: engRow && engRow.querySelector('.rt > small')
                    ? engRow.querySelector('.rt > small').textContent.trim() : '',
                rowH: engRow ? Math.round(engRow.getBoundingClientRect().height) : 0,
            });
        })()`);
        const C = JSON.parse(c);
        rec('「识别引擎」行：' + c);
        check('C1 找到「识别引擎」那一行', C.found === true);
        check('C2 它下面的说明小字已删除（"点一家 = 设为默认引擎并展开它…"）',
            C.smallText === '', JSON.stringify(C.smallText));

        /* ---------- D. 凭据区没有介绍文字 ---------- */
        const d = await ev(sw, `(function(){
            var tip = document.getElementById('w-ocrCredTip');
            var mtip = document.getElementById('w-ocrMultiTip');
            var rows = [].slice.call(document.querySelectorAll('#w-ocrCredBox .cred-row'));
            var foot = document.querySelector('#w-ocrCredBox .cred-status');
            return JSON.stringify({
                credTip: tip ? tip.textContent.trim() : '(无元素)',
                multiTip: mtip ? mtip.textContent.trim() : '(无元素)',
                footText: foot ? foot.textContent.trim() : '',
                hasFields: rows.length,
            });
        })()`);
        const D = JSON.parse(d);
        rec('凭据区：' + d);
        check('D1 凭据区顶部那句介绍没了（"本地识别不需要账号和密钥……"）',
            D.credTip === '', JSON.stringify(D.credTip));
        check('D2 「同时识别」下面那段说明没了（"勾上的引擎会和默认引擎一起跑……"）',
            D.multiTip === '', JSON.stringify(D.multiTip));
        check('D3 状态行提示没了（"填完上面的项再点「测试连接」。"）',
            D.footText === '', JSON.stringify(D.footText));
        /* ⚠ 上面 hasFields 大概率是 0 —— 因为探针配置里默认引擎是 **windows
         * （本地）**，而本地引擎本来就没有任何要填的字段（renderOcrCred 直接
         * return）。这不是 bug，是设计。为了确实验证"删掉的是说明文字、
         * 不是把输入框也删了"，这里切到一家**在线**引擎再看一次。 */
        const onlineOk = await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#w-ocrEngList .eng-row'));
            var on = rows.find(function(r){
                // 在线的行带「?」按钮（本地那家没有）
                return !!r.querySelector('.eng-help');
            });
            if (!on) return 'no-online-row';
            var id = on.dataset.id;
            on.click();
            return id;
        })()`);
        rec('切到在线引擎：' + onlineOk);
        await sleep(900);
        const d2 = await ev(sw, `(function(){
            var rows = [].slice.call(document.querySelectorAll('#w-ocrCredBox .cred-row'));
            var tip = document.getElementById('w-ocrCredTip');
            var labels = rows.map(function(r){
                var l = r.querySelector('label');
                return l ? l.textContent.trim() : '';
            });
            return JSON.stringify({
                fields: rows.length,
                labels: labels,
                credTip: tip ? tip.textContent.trim() : '',
            });
        })()`);
        const D2 = JSON.parse(d2);
        rec('在线引擎凭据区：' + d2);
        check('D4 在线引擎的输入框仍在（删的是介绍文字，不是控件）',
            D2.fields > 0, JSON.stringify(D2));
        check('D5 在线引擎的提示文字也是空的', D2.credTip === '', JSON.stringify(D2.credTip));

        /* ---------- B. 同时识别 → 多框并排 ---------- */
        // 勾一家额外的（windows 是默认，挑别的）
        const b = await ev(sw, `(function(){
            var chips = [].slice.call(document.querySelectorAll('#w-ocrMultiBox .multi-chip'));
            var cur = (CONF && CONF.ocrEngine) || '';
            var pick = chips.find(function(x){ return x.dataset.id && x.dataset.id !== cur; });
            if (pick) { pick.click(); return 'clicked:' + pick.dataset.id; }
            return 'none';
        })()`);
        rec('勾同时识别：' + b);
        await sleep(700);
        const plan = await ev(sw, "window.__TAURI__.core.invoke('get_config').then(function(c){return JSON.stringify({eng:c.ocrEngine, multi:c.ocrMulti});})");
        rec('配置：' + plan);

        // 打开 OCR 结果窗验证多框（需要先跑一次识别；用假图不方便，
        // 改为直接验证 pickDefaultMode 的纯逻辑 + DOM 结构）
        const src = fs.readFileSync(path.join(ROOT, 'ui', 'ocr.html'), 'utf8');
        check('B1 pickDefaultMode 在参与 ≥ 2 家时返回 all',
            /if \(plan\.length >= 2\) return 'all';/.test(src));
        check('B2 多框容器 #panesMulti 与 per-engine 文本框构造函数都在',
            src.indexOf('id="panesMulti"') >= 0 && src.indexOf("className = 'pm'") >= 0);
        check('B3 默认档不再无条件停在默认引擎（多引擎时让位给 all）',
            /if \(plan\.length >= 2\) return 'all';[\s\S]{0,400}const stay = /.test(src));

        /* ---------- A. 识图恢复旧逻辑 ---------- */
        const rs = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
        // Upload 分支里不该再出现"先开页面"（那个 if e.upload != TraceMoe { img_open_tab }）
        const hasPreOpen = /Mode::Upload => \{[\s\S]{0,900}?img_open_tab\(e\.page\);[\s\S]{0,200}?pending_upload\.push/
            .test(rs);
        check('A1 上传类引擎不再"进队列前先开页面"（恢复旧逻辑）',
            !hasPreOpen);
        check('A2 上传失败仍然退回打开页面（旧行为保住了）',
            /上传失败（\{msg\}），退回打开页面/.test(rs));
        // r77 的两项纯收益提速应保留
        check('A3 共享 ureq Agent（连接池）仍在',
            /fn img_agent\(\) -> ureq::Agent/.test(rs) && /POOL\.get_or_init/.test(rs));
        check('A4 等像素撤净的快速等待仍在',
            /fn wait_overlay_pixels_gone/.test(rs));
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        rec('');
        rec(`========== r78 探针：${pass} PASS / ${fail} FAIL ==========`);
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(600);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
        process.exit(fail === 0 ? 0 : 1);
    }
})();