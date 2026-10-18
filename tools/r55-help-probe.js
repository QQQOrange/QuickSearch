/* ============================================================================
 *  r55 帮助/关于补充验针：三件新功能有没有真写进帮助、关于页有没有更新日志
 *
 *  背景：r1–r54 攒下来一堆功能，但「帮助」页的 ①–⑩ 还是老结构，
 *  识图搜索 / 文件路径快捷打开 / 明文导入导出这三件（r54）一条都没写 ——
 *  用户点了「帮助」看不到自己刚用上的功能，等于没写。
 *
 *  这个探针验的就是**补完之后**：
 *   ① 帮助里出现了 ⑤b / ⑤c / ⑧b 三节，标题文字对得上；
 *   ② 每节里都点了实处（引擎家数、默认只勾非隐私、合并式导入、路径形态…）；
 *   ③ ⑦ 快捷键那节没有凭空多出一个不存在的快捷键（Ctrl+Alt+I 这类）；
 *   ④ 「关于」页渲染出了更新日志，条目数 > 0，且第一条是识图搜索；
 *   ⑤ 折叠块数量、默认只展开第一条的老规矩没被改坏。
 *
 *  用法：node tools/r55-help-probe.js     输出：tools/r55-help-probe.txt
 *  ⚠ 隔离实例（独立 APPDATA + 独立 WebView2 目录 + QS_INSTANCE_TAG），
 *    不碰用户正在用的那份配置，不 taskkill 别人的进程。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r55-help-probe.txt');
const PORT = 9385;
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

/** 切到某个 tab 并等它的根节点可见 */
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r55help-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true, ocr_enable: true, theme: 'light',
        img_enable: true, img_add_to_bar: true,
    }, null, 1), 'utf8');

    const TAG = 'r55help' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: TAG, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('r55 帮助/关于探针：pid=' + proc.pid + '  标记=' + TAG);
    sleep(10000);

    const ws = await connect('settings.html');
    if (!ws) { rec('设置页 CDP 连不上'); flush(); process.exit(1); }

    const onHelp = await gotoTab(ws, 'help');
    check('帮助页能打开', onHelp);
    if (!onHelp) { try { proc.kill(); } catch (e) { } flush(); process.exit(1); }

    /* ---- ① 三节都在 ---- */
    const titles = await evalJs(ws,
        `Array.from(document.querySelectorAll('.help-item summary')).map((s) => s.textContent.trim())`);
    rec('帮助现有小节：');
    for (const t of (Array.isArray(titles) ? titles : [])) rec('    · ' + t);

    const joined = (Array.isArray(titles) ? titles : []).join(' | ');
    check('帮助里有「识图搜索」专节（⑤b）', /识图搜索/.test(joined), joined);
    check('帮助里有「文件路径」专节（⑤c）', /文件路径/.test(joined), joined);
    check('帮助里有「明文导入 / 导出」专节（⑧b）', /明文导入\s*\/\s*导出/.test(joined), joined);

    /* ---- ② 每节都点到实处 ----
     * ⚠ 不要「一次把所有小节拼成一个大字符串再回来 split」：帮助页文字量很大，
     *   CDP 的 returnByValue 对超长字符串会截断，回来split 就会少几节、
     *   判定莫名其妙全红（第一版就是这么翻的车）。改成**按标题现取现验**，
     *   每次只搬一小节过来。 */
    /** 取标题匹配某个正则的那一节的正文（只取一节） */
    async function helpBodyBy(titleRe) {
        return evalJs(ws,
            `(function(){
               for (const d of document.querySelectorAll('.help-item')) {
                 const s = d.querySelector('summary');
                 if (${titleRe}.test(s.textContent)) {
                   return d.querySelector('.help-body').textContent;
                 }
               }
               return 'NO-SECTION';
             })()`);
    }

    const imgSec = String(await helpBodyBy(/识图搜索/));
    check('识图那节抓到了正文', imgSec !== 'NO-SECTION', imgSec.slice(0, 40));
    check('识图那节写了十六家引擎 + 默认两家', /十六家引擎/.test(imgSec) && /ascii2d/.test(imgSec));
    check('识图那节写了「默认引擎配了就直达、不用再选」', /默认引擎/.test(imgSec) && /不再问|直接/.test(imgSec));
    check('识图那节写了多选各开新标签页', /新标签页/.test(imgSec));
    check('识图那节写明了三种接入方式 + 百度要手动点',
        /自动提交/.test(imgSec) && /打开上传页/.test(imgSec) && /填图片地址/.test(imgSec) && /手动点一下/.test(imgSec));
    check('识图那节说明了为什么不传第三方图床（隐私边界）', /图床/.test(imgSec));

    const pathSec = String(await helpBodyBy(/文件路径/));
    check('路径那节抓到了正文', pathSec !== 'NO-SECTION', pathSec.slice(0, 40));
    /* ⚠ 反斜杠的层数：探针源码里 `/C:\\Users/` 才是"一个反斜杠 + Users"
       （正则里 `\\` 表示一个字面反斜杠）。写成四个反斜杠就变成"两个反斜杠"，
       帮助文字里只有一条路径、一个反斜杠，于是永远不匹配 —— 第一版就在这
       翻了车，四个红全是它。 */
    check('路径那节列了认得的形态（盘符 / UNC / 相对 / %VAR%）',
        /C:\\Users/.test(pathSec) && /server\\share/.test(pathSec) && /%APPDATA%/.test(pathSec),
        'C:\\Users=' + /C:\\Users/.test(pathSec)
        + ' server\\share=' + /server\\share/.test(pathSec)
        + ' %APPDATA%=' + /%APPDATA%/.test(pathSec));
    check('路径那节说明了「是文件就定位到它」', /定位到它|选中那个文件/.test(pathSec));
    check('路径那节说明了「认不出来的不硬猜」', /不硬猜|不会硬猜/.test(pathSec));

    const ioSec = String(await helpBodyBy(/明文导入/));
    check('导入导出那节抓到了正文', ioSec !== 'NO-SECTION', ioSec.slice(0, 40));
    check('导入导出那节把「备份」和「明文导出」分清楚了',
        /\.QuickSearch/.test(ioSec) && /\.qsconf/.test(ioSec) && /整份覆盖/.test(ioSec));
    check('导入导出那节说了默认只勾非隐私项', /默认只勾非隐私项/.test(ioSec) && /API Key/.test(ioSec));
    check('导入导出那节说了导入是合并式', /合并式/.test(ioSec));
    check('导入导出那节说了明文导入不吃加密备份', /只吃明文导出/.test(ioSec));

    const hkSec = String(await helpBodyBy(/快捷键一览/));
    check('快捷键那节抓到了正文', hkSec !== 'NO-SECTION', hkSec.slice(0, 40));
    check('快捷键那节有一条识图/路径的说明（不凭空造组合键）', /识图/.test(hkSec), hkSec.slice(0, 80));
    check('快捷键那节仍然只有 Ctrl+C / Ctrl+Alt+O 两个真实快捷键',
        /Ctrl\+C/.test(hkSec) && /Ctrl\+Alt\+O/.test(hkSec));
    check('快捷键那节**没有**编造 Ctrl+Alt+I（后端没有这个热键）', !/Ctrl\+Alt\+I/.test(hkSec));

    /* ---- ④ 默认只展开第一条的老规矩 ---- */
    const openCount = await evalJs(ws,
        `Array.from(document.querySelectorAll('.help-item')).filter((d) => d.open).length`);
    check('折叠块默认只展开第一条（一大片文字墙没人读）', Number(openCount) === 1, '展开 ' + openCount + ' 条');

    /* ---- ⑤ 关于页的更新日志 ---- */    const onAbout = await gotoTab(ws, 'about');
    check('关于页能打开', onAbout);
    if (onAbout) {
        const cl = await evalJs(ws,
            `(function(){
               const box = document.getElementById('changelog');
               if (!box) return 'NO-BOX';
               const lis = box.querySelectorAll('.cl-list li');
               const first = lis[0] ? lis[0].textContent.trim() : '';
               return lis.length + ' 条；第一条：' + first.slice(0, 60);
             })()`);
        rec('关于 → 更新日志：' + cl);
        check('关于页渲染出了更新日志（不是空壳）', /条；第一条：/.test(String(cl)) && !/^0 条/.test(String(cl)), cl);
        check('更新日志第一条是识图搜索（最新功能排最前）', /识图搜索/.test(String(cl)), String(cl).slice(0, 80));
        const clVer = await evalJs(ws, `(document.querySelector('.cl-ver') || {}).textContent || ''`);
        check('更新日志有版本号行', String(clVer).trim().length > 0, clVer);
        // 更新日志条目里不该再有没转换的 markdown 星号（**xxx** 漏转会原样显示）
        const stray = await evalJs(ws,
            `Array.from(document.querySelectorAll('.cl-list li')).filter((li) => li.textContent.includes('**')).length`);
        check('更新日志里没有漏转换的 ** 标记', Number(stray) === 0, stray + ' 条带 **');
    }

    rec('');
    rec('========== r55 帮助/关于探针：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
