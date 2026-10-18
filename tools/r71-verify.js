/* r71 综合验证（参考 FlutterPicOrigin / PicImageSearch 完善识图之后）：
 *  ① 识图设置页：引擎行数 = 12（r72 起必应/搜狗/360 出册，15 - 3）
 *  ② 新引擎在册：tracemoe / yuanbao / wenxin / tracemoe-url
 *  ③ 默认徽标仍是 Yandex（排最前），无 Lens / TinEye 残留
 *  ④ AI 看图六家齐全（豆包/通义/Kimi/智谱/元宝/文心）
 *  ⑤ 引擎表元数据：tracemoe 是 Upload 档；tracemoe-url 的 page 带 ?url={URL}
 *  ⑥ 帮助节提到 trace.moe 本地结果页（settings.html ⑤b 已同步）
 * 用法: node tools/r71-verify.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r71-verify.txt');
const PORT = 9419;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}
let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const on = (ev) => {
            let x; try { x = JSON.parse(ev.data); } catch (e) { return; }
            if (x.id !== i) return;
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) : r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
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

(async () => {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(900);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r71v-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    // ⚠ Config 的 serde 用 Rust 字段名（snake_case）—— 写 camelCase 会被静默忽略，
    //   img_default_engine 落成空串，def 行就不存在（r70 探针踩过没人发现而已：
    //   它只断言了 ids[0]）。
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, bar_list: ['百度', 'Google'],
        img_enable: true, img_add_to_bar: true,
        img_engines: ['yandex', 'baidu', 'saucenao', 'tracemoe', 'bing', 'doubao', 'yuanbao', 'wenxin', 'yandex-url', 'tracemoe-url'],
        img_default_engine: 'yandex',
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r71v' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r71 探针：设置页 pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('settings.html');
    if (!ws) { rec('连不上设置页'); process.exit(1); }
    await ev(ws, `document.querySelector('#tabs [data-tab="imgsearch"]').click()`);
    await sleep(1800);

    /* ---------- ① 识图引擎行 ---------- */
    const imgRows = JSON.parse(await ev(ws, `(function(){
        var rows = document.querySelectorAll('#w-imgEngList .img-row');
        var names = [];
        rows.forEach(function(r){ names.push(r.dataset.id); });
        var def = document.querySelector('#w-imgEngList .img-row.def');
        var defBtn = def ? def.querySelector('.eng-btn.def') : null;
        return JSON.stringify({ n: rows.length, ids: names,
            defId: def ? def.dataset.id : null,
            defText: defBtn ? defBtn.textContent.trim() : '' });
    })()`));
    rec('识图设置行（' + imgRows.n + ' 家）：' + imgRows.ids.join(', '));
    check('V1a 识图引擎 12 家', imgRows.n === 12, JSON.stringify(imgRows));
    check('V1b tracemoe 在册', imgRows.ids.indexOf('tracemoe') >= 0, imgRows.ids.join(','));
    check('V1c yuanbao 在册', imgRows.ids.indexOf('yuanbao') >= 0, '');
    check('V1d wenxin 在册', imgRows.ids.indexOf('wenxin') >= 0, '');
    check('V1e tracemoe-url 在册', imgRows.ids.indexOf('tracemoe-url') >= 0, '');
    check('V1f 无 Lens / TinEye 残留', imgRows.ids.indexOf('lens-url') < 0 && imgRows.ids.indexOf('tineye-url') < 0, '');
    check('V1g 默认徽标仍是 Yandex', imgRows.defId === 'yandex', 'defId=' + imgRows.defId + ' defText=' + imgRows.defText);
    check('V1h Yandex 排最前', imgRows.ids[0] === 'yandex', imgRows.ids[0]);
    // AI 六家：doubao/tongyi/kimi/chatglm（r69 已有）+ yuanbao/wenxin（r71 新增）
    const aiOk = ['doubao', 'tongyi', 'kimi', 'chatglm', 'yuanbao', 'wenxin']
        .every((x) => imgRows.ids.indexOf(x) >= 0);
    check('V1i AI 六家齐全（豆包/通义/Kimi/智谱/元宝/文心）', aiOk, imgRows.ids.join(','));

    /* ---------- ② 引擎表元数据（走后端命令） ---------- */
    // ⚠ CDP returnByValue 直接把 invoke 的返回值递过来（已是数组），不要再 JSON.parse
    const list = await ev(ws, `window.__TAURI__.core.invoke('img_engines_list')`);
    const arr = Array.isArray(list) ? list : [];
    rec('img_engines_list（' + arr.length + ' 家）');
    const tm = arr.find((e) => e.id === 'tracemoe') || {};
    const tmu = arr.find((e) => e.id === 'tracemoe-url') || {};
    check('V2a tracemoe 是 Upload 档', tm.mode === 'upload', JSON.stringify(tm).slice(0, 160));
    check('V2b tracemoe page 指向 api.trace.moe', String(tm.page || '').indexOf('api.trace.moe') >= 0, String(tm.page));
    check('V2c tracemoe-url 带 ?url={URL}', String(tmu.page || '').indexOf('?url={URL}') >= 0, String(tmu.page));
    check('V2d 总数 12', arr.length === 12, String(arr.length));
    const aiRows = arr.filter((e) => String(e.name || '').indexOf('AI') >= 0);
    check('V2e 名字带 AI 的正好六家', aiRows.length === 6, JSON.stringify(aiRows.map((e) => e.id)));

    /* ---------- ③ 帮助节同步（⑤b） ---------- */
    const helpHit = await ev(ws, `(function(){
        var p = document.querySelector('[data-pane="help"]');
        if (!p) return 'no-help-pane';
        var t = p.textContent || '';
        var miss = [];
        if (t.indexOf('十二家') < 0) miss.push('十二家');
        if (t.indexOf('trace.moe') < 0) miss.push('trace.moe');
        if (t.indexOf('元宝') < 0) miss.push('元宝');
        if (t.indexOf('文心') < 0) miss.push('文心');
        return miss.length ? '缺：' + miss.join('/') : 'ok';
    })()`);
    rec('⑤b 帮助节检查：' + helpHit);
    check('V3a 帮助节已更新（十二家 + trace.moe + 元宝/文心）', helpHit === 'ok', String(helpHit));

    rec('========== r71 验证：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(400);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { rec('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
