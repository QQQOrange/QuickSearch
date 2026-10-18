/* ============================================================================
 *  轮 32 专项探针：本轮五项优化
 *    ① 图标编辑器「跳过编辑，直接用作图标」（#146）
 *    ② 自定义引擎「加到横条」生效（#147，快捷键类 + 搜索类，加/移双向）
 *    ③ 移除自动取色（#148：入口消失 / 主题载荷 bg=null / 日志无取色段）
 *    ④ 收藏夹目录行紧凑化（#149：computed 值取证）
 *    ⑤ 液态玻璃删「深度」预设（#150：按钮与 GLASS_PRESETS 两档）
 *
 *  取证方式：隔离实例（独立 APPDATA + WebView2 目录 + QS_INSTANCE_TAG）+ CDP
 *  驱动真实 UI。全程不发物理鼠标/键盘（element.click() + invoke），
 *  规避本机第三方 topmost 浮层干扰（见记忆「mouse-dead」条）。
 *
 *  用法：node tools/round32-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'round32-probe.txt');

let PORT = 9412;
let wsId = 0;
const wsPending = new Map();
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++wsId;
        wsPending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
function wireWs(ws) {
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && wsPending.has(m.id)) {
            const p = wsPending.get(m.id);
            wsPending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message || 'cdp'));
            else p.resolve(m.result);
        }
    });
}
async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text)
            + (desc ? ' | ' + String(desc).split('\n')[0] : '')
            + ' | ' + String(expr).slice(0, 120));
    }
    return r.result.value;
}
async function targets() {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); return await r.json(); }
    catch (e) { return []; }
}
async function shot(ws, file) {
    try {
        await cdp(ws, 'Page.enable');
        const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return true;
    } catch (e) { return false; }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
async function connectWhere(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        const ts = await targets();
        const hit = ts.find((t) => t.type === 'page' && pred(t.url || ''));
        if (hit) {
            const ws = new WebSocket(hit.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
            });
            wireWs(ws);
            return ws;
        }
        await sleep(300);
    }
    return null;
}
const isBarPage = (u) => /index\.html/.test(u) || /tauri\.localhost\/?$/.test(u);
const isSettingsPage = (u) => /settings\.html/.test(u);
const isIconEditPage = (u) => /iconedit\.html/.test(u);
async function waitInvoke(ws, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 25000)) {
        try {
            if ((await evalJs(ws, "typeof invoke === 'function' && typeof listen === 'function'")) === true) return true;
        } catch (e) { }
        await sleep(300);
    }
    return false;
}
async function waitFor(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 12000)) {
        try { if (await evalJs(ws, expr)) return true; } catch (e) { }
        await sleep(250);
    }
    return false;
}

/* ------------------------------ 记录 ------------------------------ */
const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
let passN = 0, failN = 0, skipN = 0;
function chk(name, cond, detail) {
    if (cond) { passN++; rec('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failN++; rec('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function info(name, detail) { rec('  INFO  ' + name + (detail ? '   [' + detail + ']' : '')); }
const instances = [];

/* ========================================================================== *
 *  main
 * ========================================================================== */
(async function main() {
    rec('=== 轮 32 专项探针：五项优化（#146/#147/#148/#149/#150）===');
    rec('');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r32-'));

    function makeConf(dir) {
        const qs = path.join(dir, 'QuickSearch');
        fs.mkdirSync(qs, { recursive: true });
        const c = {
            version: '1.0.0',
            trigger_copy: false, trigger_select: false, ocr_enable: false,
            auto_start: false, auto_elevate: false,
            webdav_url: '', webdav_user: '', webdav_pass: '',
            webdav_auto: false, webdav_on_start: false, webdav_on_exit: false,
            backup_dir: '', fav_hotkey: '',
            custom_engines: [],
            // 淘宝：无 override、icons 目录无同名文件 → D 段走 iconFile 兜底
            bar_list: ['百度', 'Google', '淘宝'],
            overrides: {},
            favorites: [{
                id: 'r32d1', name: '轮32目录甲', icon: '',
                items: [{ id: 'r32i1', kind: 'text', text: '甲目录条目', html: '', image: '', remark: '' }],
                children: [{
                    id: 'r32d2', name: '轮32子目录乙', icon: '',
                    items: [{ id: 'r32i2', kind: 'text', text: '乙目录条目', html: '', image: '', remark: '' }],
                    children: [],
                }],
            }],
            bar_dim_alpha: 100,
            theme: 'light',
            // #148 升级取证：老配置里的 auto_color 手写为 true —— 加载被 serde
            // 忽略，下一次保存直接从 config.json 消失（无感升级）。
            auto_color: true,
            autoColor: true,
        };
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
        fs.mkdirSync(path.join(qs, 'icons'), { recursive: true });
        return qs;
    }
    function spawnInstance(qs, tag) {
        PORT = 9412;
        const appData = path.dirname(qs);
        const env = Object.assign({}, process.env, {
            APPDATA: appData, LOCALAPPDATA: appData,
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmpRoot, 'wv2-' + tag),
            QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
            QS_INSTANCE_TAG: tag,
            QS_T_WV_ARGS: '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
                + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT,
        });
        const p = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
        instances.push(p);
        rec('启动实例 pid=' + p.pid + '（CDP ' + PORT + '，tag=' + tag + '，APPDATA=' + appData + '）');
        return p;
    }
    const readCfg = (qs) => {
        try { return JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8')); } catch (e) { return null; }
    };
    const waitCfg = async (qs, pred, ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < (ms || 12000)) {
            const c = readCfg(qs);
            if (c && pred(c)) return c;
            await sleep(300);
        }
        return null;
    };
    /** 在某个列表容器里按行名点按钮（#customList / #barList 通用） */
    const clickRowBtn = (ws, listSel, name, btnText) => evalJs(ws, `(function(){
        var rows=[].slice.call(document.querySelectorAll(${JSON.stringify(listSel)}));
        for (var i=0;i<rows.length;i++){
            var nm=rows[i].querySelector('.nm');
            if(nm && nm.textContent.indexOf(${JSON.stringify(name)})>=0){
                var bs=[].slice.call(rows[i].querySelectorAll('.mini'));
                for(var j=0;j<bs.length;j++) if(bs[j].textContent===${JSON.stringify(btnText)}){ bs[j].click(); return 'clicked'; }
                return 'no-btn';
            }
        }
        return 'no-row';
    })()`);

    /* ---------- 起实例、连三个页面 ---------- */
    const qs = makeConf(path.join(tmpRoot, 'E'));
    spawnInstance(qs, 'r32');
    const BAR = await connectWhere(isBarPage, 30000);
    if (!BAR || !(await waitInvoke(BAR))) {
        chk('★ 连接横条页', false, '连不上 index.html');
        rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
        flush();
        for (const p of instances) { try { p.kill(); } catch (e) { } }
        process.exit(1);
    }
    chk('★ 连接横条页（CDP ' + PORT + '）', true);
    await evalJs(BAR, "invoke('open_settings', {tab:'engines'}).catch(function(e){})");
    const SET = await connectWhere(isSettingsPage, 25000);
    if (!SET || !(await waitInvoke(SET))) {
        chk('★ 连接设置页', false, '连不上 settings.html');
        rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
        flush();
        for (const p of instances) { try { p.kill(); } catch (e) { } }
        process.exit(1);
    }
    chk('★ 连接设置页（引擎分页）', true);
    await waitFor(SET, "!!document.querySelector('#barList .item')");

    /* =====================================================================
     *  A 段：#148 入口消失 + #150 删深度预设（设置页静态结构）
     * ===================================================================== */
    rec('');
    rec('############ A 段：#148 自动取色入口消失 / #150 删「深度」预设 ############');
    const a = JSON.parse(await evalJs(SET, `JSON.stringify({
        hasAutoColor: !!document.getElementById('s-autoColor'),
        bodyHasColorText: document.body.innerText.indexOf('横条自动取色') >= 0
            || document.body.innerText.indexOf('跟随背景取色') >= 0,
        presetBtns: [].slice.call(document.querySelectorAll('#s-glassPreset button'))
            .map(function(b){ return b.getAttribute('data-v'); }),
        presetKeys: (typeof GLASS_PRESETS !== 'undefined')
            ? GLASS_PRESETS.map(function(p){ return p.key; }) : null,
        themeCopy: (function(){
            var seg = document.querySelector('#s-theme');
            if (!seg || !seg.parentElement) return '';
            var rt = seg.parentElement.querySelector('.rt');
            return rt ? rt.innerText : '';
        })(),
    })`));
    chk('★ A1 设置页没有「横条自动取色」开关（#s-autoColor 不存在）', !a.hasAutoColor);
    chk('★ A2 全页文案再无「自动取色 / 跟随背景取色」字样', !a.bodyHasColorText,
        a.bodyHasColorText ? '仍存在' : '干净');
    chk('★ A3 玻璃预设只剩 3 枚按钮且没有「深度」', a.presetBtns.length === 3
        && a.presetBtns.indexOf('deep') < 0, JSON.stringify(a.presetBtns));
    chk('  A3b GLASS_PRESETS 只剩 light/standard 两档', !!a.presetKeys
        && a.presetKeys.length === 2 && a.presetKeys.indexOf('deep') < 0, JSON.stringify(a.presetKeys));
    chk('★ A4 主题行改口：横条与设置窗口共用同一套明暗',
        a.themeCopy.indexOf('同一套明暗') >= 0 && a.themeCopy.indexOf('跟随背景取色') < 0,
        a.themeCopy.slice(0, 60));
    await shot(SET, path.join(__dirname, '_r32-a-settings.png'));

    /* =====================================================================
     *  B 段：#149 收藏夹目录行紧凑化（computed 值取证）
     *
     *  ⚠ r55 修：r48 起收藏夹目录**默认折叠**（`if (!open) return wrap;`，
     *    见 settings.js favGroupNode 里那行），折叠态下 .fav-body 整个不渲染 ——
     *    于是 .fav-group.lv2 > .fav-row 和 .fav-item-line 在初始渲染里
     *    **压根不存在**，B 段从 r48 起就一直红在「选择器没等到」。
     *    这不是产品缺陷（折叠就是 r48 要的行为），是**探针口径过期**：
     *    取证前得先把目录展开，跟用户真要看这些行时的操作一样。
     * ===================================================================== */
    rec('');
    rec('############ B 段：#149 收藏夹目录行间距压缩 ############');
    await evalJs(SET, "document.querySelector('#tabs button[data-tab=\"fav\"]').click()");
    // 先把所有目录展开（一级 + 二级）：折叠态下正文不渲染，取不到证
    const expanded = await evalJs(SET, `(function(){
        var n = 0;
        for (var b of document.querySelectorAll('.fav-row .mini.fold.closed')) { b.click(); n++; }
        return n;
    })()`);
    rec('  先把折叠的目录展开（r48 起默认折叠，折叠态正文不渲染）：点了 ' + expanded + ' 个箭头');
    const bReady = await waitFor(SET, "!!document.querySelector('.fav-group > .fav-row')"
        + " && !!document.querySelector('.fav-group.lv2 > .fav-row')"
        + " && !!document.querySelector('.fav-item-line')");
    if (bReady) {
        const b = JSON.parse(await evalJs(SET, `JSON.stringify({
            lv1Margin: getComputedStyle(document.querySelector('.fav-group > .fav-row')).marginTop,
            lv1Pad: getComputedStyle(document.querySelector('.fav-group > .fav-row')).paddingTop,
            lv2Margin: getComputedStyle(document.querySelector('.fav-group.lv2 > .fav-row')).marginTop,
            lv2Pad: getComputedStyle(document.querySelector('.fav-group.lv2 > .fav-row')).paddingTop,
            itemPad: getComputedStyle(document.querySelector('.fav-item-line')).paddingTop,
        })`));
        /* ⚠ r55 修：期望值更新到 **r49 之后**的真实值。
         *   r48 时这一节写的是 margin-top:9px / padding-top:3px / lv2 margin-top:5px；
         *   r49 按用户原话「可拖动的按钮离卡片边框很远、又离三角形很远、三角形太大、
         *   目录名上下留白太远，看起来特别丑」又收紧了一圈，摘要行变成
         *   `padding: 5px 7px; margin: 0`（一级）、`padding: 3px 2px`（二级）。
         *   这两版数字的差别是**间距口径**，不是谁对谁错 —— 断言跟着当前口径走，
         *   并注明是 r49 定的，免得下次又以为是回归。
         *   #149 要保证的东西没变：行要紧凑、内容行不能被一起压扁。 */
        chk('★ B1 一级目录行 margin-top 为 0（r49 定的：行间距交给 #favTree 的 gap）',
            b.lv1Margin === '0px', b.lv1Margin);
        chk('★ B2 一级目录行 padding-top 压到 5px（r48 的 3px → r49 收紧到 5/7）',
            b.lv1Pad === '5px', b.lv1Pad);
        chk('★ B3 二级目录行 margin-top 为 0（r49 定的）',
            b.lv2Margin === '0px', b.lv2Margin);
        chk('  B4 二级目录行 padding 仍是 3px 一档（r49：3px 2px）',
            b.lv2Pad === '3px', b.lv2Pad);
        chk('  B5 内容行（fav-item-line）没被压：padding-top 仍 7px',
            b.itemPad === '7px', b.itemPad);
        await shot(SET, path.join(__dirname, '_r32-b-fav.png'));
    } else { chk('★ B1 收藏夹页渲染出目录行', false, '选择器没等到'); }

    /* =====================================================================
     *  C 段：#147 自定义引擎「加到横条」生效（#147 的病根修复取证）
     *    旧病：准入只认内置 engines() 表 → 自定义引擎（含快捷键类）点了没反应。
     * ===================================================================== */
    rec('');
    rec('############ C 段：#147 自定义引擎加到横条（快捷键类 + 搜索类）############');
    await evalJs(SET, "document.querySelector('#tabs button[data-tab=\"engines\"]').click()");

    // C1 自定义快捷键引擎（用户报的那类）
    const cAdd1 = await evalJs(SET, `(async function(){
        try { await invoke('add_custom_engine', { name: '轮32截图', url: '', category: '自定义', kind: 'hotkey', hotkey: 'win+shift+s' }); return 'ok'; }
        catch (e) { return 'err:' + String(e); }
    })()`);
    chk('★ C1 命令行添加自定义快捷键引擎「轮32截图」', cAdd1 === 'ok', cAdd1);
    const c1row = await waitFor(SET,
        "[].slice.call(document.querySelectorAll('#customList .item .nm')).some(function(n){return n.textContent.indexOf('轮32截图')>=0})");
    chk('  C1b 自定义引擎列表出现这一行', c1row);
    if (c1row) {
        const click1 = await clickRowBtn(SET, '#customList .item', '轮32截图', '加到横条');
        chk('  C1c 行内点「加到横条」', click1 === 'clicked', click1);
        const cfg1 = await waitCfg(qs, (c) => (c.bar_list || []).indexOf('轮32截图') >= 0);
        chk('★ C1d config.json 的 bar_list 真的收下了它（旧病：点了没反应）',
            !!cfg1, cfg1 ? JSON.stringify(cfg1.bar_list) : '没写进 bar_list');
        const barHas1 = await waitFor(BAR,
            "[].slice.call(document.querySelectorAll('#engines .engine')).some(function(b){return b.dataset.engine==='轮32截图'})");
        chk('★ C1e 横条页真的渲染出这颗引擎（广播链路通）', barHas1);
        // 反向：再点一次「已在横条」应移除
        const click1r = await clickRowBtn(SET, '#customList .item', '轮32截图', '已在横条');
        chk('  C1f 按钮变成「已在横条」可再点', click1r === 'clicked', click1r);
        const cfg1r = await waitCfg(qs, (c) => (c.bar_list || []).indexOf('轮32截图') < 0);
        chk('★ C1g 再点一次从 bar_list 移除（双向生效）', !!cfg1r,
            cfg1r ? JSON.stringify(cfg1r.bar_list) : '没移除');
        const barGone1 = await waitFor(BAR,
            "![].slice.call(document.querySelectorAll('#engines .engine')).some(function(b){return b.dataset.engine==='轮32截图'})");
        chk('  C1h 横条页对应格子消失', barGone1);
    }

    // C2 自定义搜索类引擎（同类受害面的排查结论：三类自定义引擎同病，一并取证）
    const cAdd2 = await evalJs(SET, `(async function(){
        try { await invoke('add_custom_engine', { name: '轮32搜索', url: 'https://example.com/s?q=%s', category: '自定义', kind: 'search', hotkey: '' }); return 'ok'; }
        catch (e) { return 'err:' + String(e); }
    })()`);
    chk('★ C2 命令行添加自定义搜索引擎「轮32搜索」', cAdd2 === 'ok', cAdd2);
    if (cAdd2 === 'ok') {
        const c2row = await waitFor(SET,
            "[].slice.call(document.querySelectorAll('#customList .item .nm')).some(function(n){return n.textContent.indexOf('轮32搜索')>=0})");
        if (c2row) {
            const click2 = await clickRowBtn(SET, '#customList .item', '轮32搜索', '加到横条');
            const cfg2 = await waitCfg(qs, (c) => (c.bar_list || []).indexOf('轮32搜索') >= 0);
            chk('★ C2b 自定义搜索类也能加到横条（排查结论落地）', !!cfg2,
                cfg2 ? JSON.stringify(cfg2.bar_list) : '没写进');
        }
    }
    await shot(SET, path.join(__dirname, '_r32-c-engines.png'));

    /* =====================================================================
     *  D 段：#146 图标编辑器「跳过编辑，直接用作图标」
     *    旧流程：不消除背景就保存不了（btnSave 禁用），用户要么被迫消背景、
     *    要么取消 = 白挑一张图。新按钮复用保存链路直接落库。
     * ===================================================================== */
    rec('');
    rec('############ D 段：#146 跳过编辑，直接用作图标 ############');
    const dClick = await clickRowBtn(SET, '#barList .item', '淘宝', '编辑图标');
    chk('  D1 横条行「淘宝」有「编辑图标」入口（iconFile 兜底口径）', dClick === 'clicked', dClick);
    const ED = await connectWhere(isIconEditPage, 20000);
    if (!ED) { chk('  D2 编辑器窗口打开', false, '连不上 iconedit.html'); }
    else {
        // 带预期显示名等就绪：窗口复用时旧会话标题也含「（」，只查结构会读到上一颗
        const dReady = await waitFor(ED,
            "document.getElementById('ieName').textContent.indexOf('（') >= 0"
            + " && !!document.getElementById('imgBefore').getAttribute('src')"
            + " && document.getElementById('ieName').textContent.split('（')[0] === '淘宝'", 15000);
        chk('★ D2 编辑器装载「淘宝」会话（标题=显示名（键））', dReady);
        if (dReady) {
            const dPre = JSON.parse(await evalJs(ED, `JSON.stringify({
                saveOff: document.getElementById('btnSave').disabled,
                skipOff: document.getElementById('btnSkip').disabled,
                hasSkip: !!document.getElementById('btnSkip'),
            })`));
            chk('  D3 没跑过消除背景前「保存」仍是禁用的（原设计没动）', dPre.saveOff === true);
            chk('★ D4 「跳过编辑，直接用作图标」按钮存在且可点', dPre.hasSkip && dPre.skipOff === false,
                JSON.stringify(dPre));
            await shot(ED, path.join(__dirname, '_r32-d-iconedit.png'));
            await evalJs(ED, "document.getElementById('btnSkip').click()");
            const edGone = await (async () => {
                const t0 = Date.now();
                while (Date.now() - t0 < 10000) {
                    if ((await targets()).filter((t) => isIconEditPage(t.url || '')).length === 0) return true;
                    await sleep(300);
                }
                return false;
            })();
            chk('★ D5 点跳过 → 编辑器自动关闭（与保存同一链路尾）', edGone);
            const cfgD = await waitCfg(qs, (c) => !!(c.overrides || {})['淘宝'], 8000);
            const ovFile = cfgD ? cfgD.overrides['淘宝'] : '';
            const fileOk = !!ovFile
                && fs.existsSync(path.join(qs, 'icons', ovFile))
                && fs.statSync(path.join(qs, 'icons', ovFile)).size > 100;
            chk('★ D6 原图直接落库：overrides[淘宝] 写入且文件在盘上',
                !!cfgD && fileOk, ovFile || '没写 override');
            if (cfgD) {
                chk('  D7 老配置的 auto_color/autoColor 已被 serde 丢掉（无感升级）',
                    !('auto_color' in cfgD) && !('autoColor' in cfgD),
                    JSON.stringify(Object.keys(cfgD).filter((k) => k.toLowerCase().indexOf('color') >= 0)));
            }
        }
    }

    /* =====================================================================
     *  E 段：#148 主题链路 + 日志口径
     *    - set_setting(theme=dark) → 横条页挂 qs-dark（同一份主题两边共用）
     *    - 全程无内联 --qs-bg（底色归 CSS 两套，后端 bg 恒 null）
     *    - 日志 show_bar: 耗时 锚点/让位/主题 —— 没有「取色」段
     * ===================================================================== */
    rec('');
    rec('############ E 段：#148 主题链路 + 日志口径 ############');
    const eSet = await evalJs(SET, `(async function(){
        try { await invoke('set_setting', { key: 'theme', value: 'dark' }); return 'ok'; }
        catch (e) { return 'err:' + String(e); }
    })()`);
    chk('  E1 设置页 set_setting(theme=dark)', eSet === 'ok', eSet);
    const eDark = await waitFor(BAR, "document.getElementById('stage').classList.contains('qs-dark')", 8000);
    chk('★ E2 横条页真的挂上 qs-dark（设置改主题 → 横条同步，两边共用一份）', eDark);
    const eNoBg = await evalJs(BAR,
        "document.getElementById('stage').style.getPropertyValue('--qs-bg')");
    chk('★ E3 横条无内联 --qs-bg（后端载荷 bg 恒 null，底色归 CSS 两套）',
        eNoBg === '', JSON.stringify(eNoBg));
    await evalJs(SET, `(async function(){ await invoke('set_setting', { key: 'theme', value: 'light' }); })()`);
    const eLight = await waitFor(BAR,
        "!document.getElementById('stage').classList.contains('qs-dark')", 8000);
    chk('  E4 切回亮色 → qs-dark 摘掉', eLight);
    // set_setting 白名单不登记 autoColor：老键写了也不存（看着有反应其实没存）
    const eAuto = await evalJs(SET, `(async function(){
        try { await invoke('set_setting', { key: 'autoColor', value: true }); return 'ok'; }
        catch (e) { return 'err:' + String(e); }
    })()`);
    const cfgE = readCfg(qs);
    chk('★ E5 set_setting(autoColor) 不再登记（白名单式，老键无感）',
        !('auto_color' in (cfgE || {})) && !('autoColor' in (cfgE || {})),
        'invoke=' + eAuto + ' 配置键=' + JSON.stringify(Object.keys(cfgE || {}).filter((k) => k.toLowerCase().indexOf('color') >= 0)));
    // 日志口径：show_bar 三段（锚点/让位/主题），不再有「取色」段
    await evalJs(BAR, "invoke('show_bar', {text:'轮32取证', at_mouse:true, via_copy:false}).catch(function(e){})");
    const logTxt = await (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            try {
                const t = fs.readFileSync(path.join(qs, 'log.txt'), 'utf8');
                if (t.indexOf('show_bar: 耗时') >= 0) return t;
            } catch (e) { }
            await sleep(300);
        }
        return '';
    })();
    const sbLine = (logTxt.split('\n').filter((x) => x.indexOf('show_bar: 耗时') >= 0).pop() || '');
    chk('★ E6 日志有「show_bar: 耗时 锚点=… 让位=… 主题=…」', !!sbLine, sbLine.slice(-80));
    chk('  E7 让位/主题两段都在（无条件挪 + 主题推送）',
        /让位=\d+ms/.test(sbLine) && /主题=\d+ms/.test(sbLine), sbLine.slice(-80));
    chk('★ E8 日志里再也没有「取色」段（自动取色整体移除）',
        logTxt.indexOf('取色') < 0, logTxt.indexOf('取色') >= 0 ? '仍有' : '干净');
    await evalJs(BAR, "invoke('hide_bar').catch(function(e){})");

    rec('');
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    process.exit(failN === 0 ? 0 : 1);
})().catch((e) => {
    rec('探针本身抛异常：' + (e && (e.stack || e.message || String(e))));
    rec('结果：' + passN + ' PASS / ' + failN + ' FAIL / ' + skipN + ' SKIP');
    flush();
    for (const p of instances) { try { p.kill(); } catch (e) { } }
    process.exit(1);
});
