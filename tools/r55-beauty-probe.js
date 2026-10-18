/* ============================================================================
 *  r55 美化验针 ①：标签页图标 + 更新日志可读性
 *
 *  背景：设置页从 1 张卡长到 10 个分页，横向一排汉字扫过去要找半天。
 *  r55 给每颗 tab 加了个 emoji 图标（纯装饰），把「形状」这一维也利用上。
 *
 *  这个探针验的是「加了图标没把别的弄坏」：
 *   ① 十颗 tab 都在，且每颗都带图标（aria-hidden，读屏跳过）；
 *   ② 可访问名没被图标污染（`button.textContent.trim()` 必须还是「通用」这种纯名字，
 *      不然用读屏软件的人会听到"⚙️ 通用"）；
 *   ③ 点每颗 tab 都能真的切过去（图标没挡住点击 / 没破坏布局）；
 *   ④ 「更新日志」渲染出来了且没有漏转换的 markdown 星号。
 *
 *  用法：node tools/r55-beauty-probe.js     输出：tools/r55-beauty-probe.txt
 *  ⚠ 隔离实例，不碰用户配置。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r55-beauty-probe.txt');
const PORT = 9387;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
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
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.text || '');
    return r.result.value;
}
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
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
/** 点某个 tab 并等它的 pane 可见 */
async function gotoTab(ws, tab) {
    await evalJs(ws, `(function(){
      const b = document.querySelector('#tabs button[data-tab="${tab}"]');
      if (b) b.click();
      return !!b;
    })()`);
    for (let i = 0; i < 30; i++) {
        const ok = await evalJs(ws,
            `(function(){ const p = document.querySelector('.pane[data-pane="${tab}"]'); return p ? !p.hidden : false; })()`);
        if (ok === true) return true;
        await sleep(300);
    }
    return false;
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r55beauty-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
    const TAG = 'r55beauty' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: TAG, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('r55 美化探针：pid=' + proc.pid + '  标记=' + TAG);
    sleep(10000);

    const ws = await connect('settings.html');
    if (!ws) { rec('设置页 CDP 连不上'); flush(); process.exit(1); }

    /* ---- ① 十颗 tab 都在，每颗都带图标 ---- */
    const tabs = await evalJs(ws,
        `(function(){
           const out = [];
           for (const b of document.querySelectorAll('#tabs button[data-tab]')) {
             const ic = b.querySelector('.tb-i');
             out.push(b.dataset.tab + '|' + (ic ? 'icon' : 'noicon') + '|'
                      + (ic ? (ic.getAttribute('aria-hidden') || '') : '') + '|'
                      + b.textContent.trim());
           }
           return out;
         })()`);
    const arr = Array.isArray(tabs) ? tabs : [];
    rec('标签页（tab|图标|aria-hidden|可访问名）：');
    for (const t of arr) rec('    ' + t);
    const expected = ['general', 'engines', 'ai', 'ocr', 'imgsearch', 'fav', 'data', 'backup', 'help', 'about'];
    check('十颗 tab 一颗不少', arr.length === 10, '实得 ' + arr.length);
    check('十颗 tab 的顺序没变（老用户肌肉记忆）',
        expected.every((t, i) => arr[i] && arr[i].startsWith(t + '|')),
        arr.map((s) => s.split('|')[0]).join(','));
    check('每颗 tab 都带上了装饰图标', arr.every((s) => s.indexOf('|icon|') > 0));
    check('图标都标了 aria-hidden（读屏软件不该念它）', arr.every((s) => s.indexOf('|icon|true|') > 0));
    /* ---- ② 可访问名没被污染 ---- */
    // textContent.trim() 会把图标字符一起带进来（emoji 是文本节点），所以这里要单独
    // 验证「去掉图标后的纯文字」仍是期望值。
    const names = await evalJs(ws,
        `(function(){
           const out = {};
           for (const b of document.querySelectorAll('#tabs button[data-tab]')) {
             const ic = b.querySelector('.tb-i');
             const t = b.cloneNode(true);
             if (ic) t.removeChild(t.querySelector('.tb-i'));
             out[b.dataset.tab] = t.textContent.trim();
           }
           return out;
         })()`);
    const want = {
        general: '通用', engines: '引擎', ai: 'AI 工具', ocr: '文字识别',
        imgsearch: '识图搜索', fav: '收藏夹', data: '数据', backup: '备份',
        help: '帮助', about: '关于',
    };
    let bad = [];
    for (const k of Object.keys(want)) {
        if (!names || names[k] !== want[k]) bad.push(k + '=' + (names ? names[k] : '?'));
    }
    check('去掉图标后 tab 的可访问名一字不差（读屏听到的还是「通用」）',
        bad.length === 0, bad.join(' '));

    /* ---- ③ 每颗 tab 都点得进去（图标没挡住点击 / 没破坏布局） ---- */
    let allClick = true;
    const failed = [];
    for (const t of expected) {
        const ok = await gotoTab(ws, t);
        if (!ok) { allClick = false; failed.push(t); }
    }
    check('十颗 tab 全都能点开（图标没挡住、布局没破）', allClick, failed.join(','));

    /* ---- ④ 更新日志可读性 ---- */
    const onAbout = await gotoTab(ws, 'about');
    check('关于页能打开', onAbout);
    if (onAbout) {
        const stray = await evalJs(ws,
            `Array.from(document.querySelectorAll('.cl-list li')).filter((li) => li.textContent.includes('**')).length`);
        check('更新日志里没有漏转换的 ** 标记（不会把星号显示给用户）', Number(stray) === 0, stray + ' 条');
        const hasCode = await evalJs(ws, `document.querySelectorAll('.cl-list li code').length`);
        rec('更新日志里的 <code> 行内标记数：' + hasCode);
        check('更新日志里的路径/文件名渲染成了 <code>（等宽，好认）', Number(hasCode) >= 2, hasCode + ' 个');
    }

    rec('');
    rec('========== r55 美化探针：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
