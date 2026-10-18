/* r56「截图用完即删」探针
 * 用户原话：「再就是不管是识图搜索还是 ocr 截取的图片，用完之后记得删掉，
 * 这种只是暂时的图片，不能永久的存在电脑里面。」
 *
 * 这条需求分两半，必须分开验：
 *   A. **有没有往磁盘写截图** —— 期望：没有（截图是内存里的 Vec<u8>，
 *      走剪贴板/网络，不落盘）。验法：跑一次识图 + 一次 OCR，
 *      盯住 %TEMP%、APPDATA、临时目录、以及进程打开的文件句柄，
 *      一个图片文件都不该出现。
 *   B. **剪贴板里的图用完之后会不会留着** —— Paste 类引擎要靠它，所以那一步
 *      **必须留着**（清了用户就没法粘贴了）；但 Post 类全自动搜完之后，
 *      图在剪贴板里躺着就是"永久的痕迹"（重启还在）。验法：跑一次 Post 类
 *      识图，确认完之后剪贴板里的图被清掉。
 *
 * ⚠ 这里刻意**不断言"剪贴板一定被清空"**：那会把 Paste 类弄坏。真正的口径是
 *   "不再需要它的那一刻就清"，而那一刻在代码里是明确的（paste 分支才不清）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r56-tmppic-probe.txt');
const PORT = 9399;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
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
/** 列出目录下所有图片文件（递归，最多 3 层）。 */
function findPics(dir, depth) {
    const out = [];
    if (depth > 3) return out;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'wv2' || e.name === 'EBWebView') continue; // WebView 自己的缓存，不是截图
            out.push(...findPics(p, depth + 1));
        } else if (/\.(png|jpe?g|bmp|gif|webp|tiff?)$/i.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}
/** 进程打开的文件句柄里有没有图片（用 handle.exe 不可靠，改用：
 *  扫一遍常见落点 + 看进程有没有持有 .tmp/.png）。
 *  更直接的办法：`Get-Process` 拿不到句柄，所以这里只扫目录。 */
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r56tp-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    // 只勾 Post 类（全自动那两家）：这条验"用完之后剪贴板里的图被清掉"
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({
        debug: true,
        img_enable: true, img_add_to_bar: true,
        img_engines: ['bing', 'ascii2d'],
        img_default_engine: 'bing',
    }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1', QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r56tp' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'), QS_T_WV_ARGS: WV,
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    rec('r56「截图用完即删」探针：pid=' + proc.pid);
    sleep(9000);
    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('横条连不上'); flush(); process.exit(1); }

    /* ---------- 基线：启动后（还没截图）有哪些图片 ---------- */
    const base0 = findPics(tmp, 0);
    rec('基线（启动后、未截图）：临时区图片 ' + base0.length + ' 个');

    /* ---------- 跑一次识图（Post 类：真的会去 POST，但探针环境没有网也照走）----------
     * 用后端命令直接调，绕开"真机框选"（那需要鼠标在屏幕上拖，探针做不到）。
     * img_region 会：截图 → 编码 JPEG → 剪贴板 → POST → 开标签页。
     * 我们关心的就是这一路走完之后磁盘上多没多东西。 */
    const before = findPics(tmp, 0).length;
    await ev(ws, `window.__TAURI__.core.invoke('img_region', { x: 10, y: 10, w: 60, h: 40, dpr: 1 }).catch(()=>{})`);
    // 给它足够时间走完（等遮罩消失 + 编码 + POST 超时）
    await sleep(9000);
    const after = findPics(tmp, 0);
    rec('识图之后：隔离 APPDATA 里图片 ' + after.length + ' 个（基线 ' + before + '）');
    const newPics = after.slice(before);
    /* ⚠ r57 改口径：识图现在**会**写一张临时图（`%TEMP%\QuickSearch\img\shot.jpg`），
     *   因为 ascii2d / SauceNAO / IQDB 那些老站点只吃原生文件框，浏览器又不允许
     *   往文件框里粘贴 —— 不留一张，用户走到上传页就没法继续。
     *   所以"零落盘"这条断言已经不成立了，不能留着骗人。
     *   新的保证是：**只写一张、固定文件名、不往配置目录里写、退出即删**。
     *   这里验前两条；退出即删在下面 E 组验。 */
    check('A1 识图不往**配置目录**里写图片（截图不混进用户数据）',
        newPics.length === 0, newPics.slice(0, 3).join(', '));

    /* ---------- 临时图：只一张、固定名字 ---------- */
    const tmpImgDir = path.join(os.tmpdir(), 'QuickSearch', 'img');
    let tmpFiles = [];
    try { tmpFiles = fs.readdirSync(tmpImgDir); } catch (e) { }
    rec('临时图目录 ' + tmpImgDir + ' = ' + JSON.stringify(tmpFiles));
    check('A1b 识图留了一张临时图（给只吃文件框的那几家）', tmpFiles.length === 1, JSON.stringify(tmpFiles));
    check('A1c 临时图名字固定（shot.jpg），不会攒出 shot-1/2/3 那种垃圾',
        tmpFiles.length === 1 && tmpFiles[0] === 'shot.jpg', JSON.stringify(tmpFiles));

    /* ---------- 剪贴板：Post 类用完应该清掉 ----------
     * 判定用 clip::has_image()（后端命令）。先确认它现在**是**有的
     * （说明截图真的走到剪贴板了），再等一轮，看它有没有被清掉。 */
    const clipAfter = await ev(ws, `(async function(){
        // 没有直接的 has_image 命令暴露给前端，用 has_image 的姊妹：
        // 读一次剪贴板的文本（图的话返回空）不能证明什么。
        // 所以这里用一个间接证据：settings 页的图标编辑器同一条路。
        // ⚠ 改用**后端日志**：img_region 会打 "img: clipboard image ok=..."
        return 'see-log';
    })()`);

    /* ---------- OCR：同样跑一次，看落不落盘 ---------- */
    await ev(ws, `window.__TAURI__.core.invoke('ocr_region', { x: 10, y: 10, w: 60, h: 40, dpr: 1 }).catch(()=>{})`);
    await sleep(9000);
    const afterOcr = findPics(tmp, 0);
    const ocrNew = afterOcr.slice(after.length);
    rec('OCR 之后：隔离 APPDATA 里图片 ' + afterOcr.length + ' 个');
    check('A2 OCR 不往配置目录里写图片（它连剪贴板都不碰，也没有临时文件）',
        ocrNew.length === 0, ocrNew.slice(0, 3).join(', '));
    // OCR 不该动那张临时图（那是识图专用的）
    let tmpAfterOcr = [];
    try { tmpAfterOcr = fs.readdirSync(tmpImgDir); } catch (e) { }
    check('A2b OCR 不会额外留下图片（临时图目录里还是那唯一一张）',
        tmpAfterOcr.length === 1, JSON.stringify(tmpAfterOcr));

    /* ---------- 顺带看一眼后端日志怎么说（证明真跑了）----------
     * 日志在 data_dir()/log.txt（见 win.rs 的 log_sync / log_writer），
     * 不是 logs/quicksearch.log —— 第一版探针读错路径，白fail一条。 */
    const logPath = path.join(tmp, 'QuickSearch', 'log.txt');
    let logTxt = '';
    try { logTxt = fs.readFileSync(logPath, 'utf8'); } catch (e) { }
    const hasJpegLog = /img: jpeg \d+ KB/.test(logTxt);
    const hasClipLog = /img: clipboard image ok=/.test(logTxt);
    const hasOcrLog = /ocr_region|ocr: /.test(logTxt);
    rec('日志：JPEG 编码=' + hasJpegLog + ' 剪贴板=' + hasClipLog + ' OCR=' + hasOcrLog
        + '（日志 ' + logTxt.length + ' 字节 @ ' + logPath + '）');
    check('A3 识图确实跑了（日志有 JPEG 编码那一行）—— 证明上面两个断言不是"压根没执行"',
        hasJpegLog, logTxt.slice(-300));

    /* ---------- 静态确认：产品路径上没有"把截图写到磁盘"的通路 ----------
     * ⚠ 判定必须**区分测试/调试代码**：仓库里确实有两处写图片的 fs::write，
     *   一处是 `#[cfg(test)]` 里的探针辅助，一处是 `QS_DUMP_OCR=1` 才走的
     *   调试开关（默认关）。它们都不是产品行为，判成"产品会写盘"是误报。
     *   所以这里把每处调用点的**上下文**拉出来，逐个看它被什么条件挡着。 */
    const src = ['src/imgsearch.rs', 'src/ocr.rs', 'src/main.rs']
        .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    /* `mod tests { ... }` 的区间：写在这里面的 fs::write 全是测试代码。
     * ⚠ 不能只往前看几百字符找 #[cfg(test)] —— 那个属性在 mod tests 那一行，
     *   而测试体可能离它几千行（main.rs 的 tests 模块从 9981 行一直到文件尾）。
     *   所以先把整个 tests 区间算出来，落在里面的一律算测试。 */
    const testSpans = [];
    const modRe = /#\[cfg\(test\)\]\s*\r?\n\s*(?:pub\s+)?mod\s+tests\s*\{/gi;
    let mm;
    while ((mm = modRe.exec(src)) !== null) {
        // 从 '{' 开始配平括号，找到这个 mod 的结束
        let i = src.indexOf('{', mm.index);
        let depth = 0, end = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        testSpans.push([mm.index, end < 0 ? src.length : end]);
    }
    const inTests = (idx) => testSpans.some(([a, b]) => idx >= a && idx <= b);
    const writes = [];
    const re = /fs::write\s*\(|File::create\s*\(/gi;
    let m;
    while ((m = re.exec(src)) !== null) writes.push(m.index);
    const picish = [];
    for (const i of writes) {
        const ctx = src.slice(i, i + 400);
        if (!/jpg|png|jpeg|screenshot|截图/i.test(ctx)) continue;
        // 四类"不算违规"：① 在 mod tests 里；② 被调试环境变量挡着；
        // ③ 写的是图标而不是截图；④ **r57 刻意留的那张临时图**（img_temp_file）
        const before = src.slice(Math.max(0, i - 900), i);
        const debugGated = /QS_DUMP_OCR|env_or_empty|QS_[A-Z_]+/i.test(before);
        const isIcon = /icon|ico/i.test(ctx.slice(0, 120));
        // ④ 临时图：函数名在附近，且写的是 temp_dir/QuickSearch/img
        const isTempShot = /img_temp_file|temp_dir\(\)[\s\S]{0,120}QuickSearch/.test(before + ctx.slice(0, 200));
        picish.push({
            at: i,
            why: inTests(i) ? '测试代码（mod tests 内）'
                : (debugGated ? '调试开关挡着（QS_DUMP_OCR 之类）'
                    : (isIcon ? '写的是用户图标，不是截图'
                        : (isTempShot ? '刻意留的临时图（img_temp_file，每轮覆盖 + 退出删）'
                            : '⚠ 产品路径无条件写'))),
            ctx: ctx.slice(0, 130).replace(/\s+/g, ' '),
        });
    }
    const bad = picish.filter((p) => p.why.indexOf('⚠') === 0);
    rec('源码里 fs::write/File::create 共 ' + writes.length + ' 处；其中碰图片字节的 '
        + picish.length + ' 处：');
    for (const p of picish) rec('   · ' + p.why + ' → ' + p.ctx);
    /* r57 改口径：产品路径上**允许**有一处写图片 —— 就是那张临时图。
     * 旧断言"一处都不许有"已经不成立了（那是 r56 的设计），留着只会天天误报。
     * 新的保证：**除了那一处，不许再有别的**。 */
    const tempWrites = picish.filter((p) => p.why.indexOf('刻意留的临时图') === 0);
    check('A4 产品路径上写图片的地方**只有那一处临时图**（其余全在测试/调试开关/图标上）',
        bad.length === 0 && tempWrites.length >= 1,
        '无条件写的有 ' + bad.length + ' 处，临时图 ' + tempWrites.length + ' 处');

    /* ---------- B：剪贴板里的截图用完要消失 ----------
     * 需求的后半句（"不能永久的存在电脑里面"）真正要动的地方：识图的截图
     * 不落盘，唯一会留下痕迹的就是剪贴板。
     *
     * 验法（两头夹）：
     *   ① **日志**：一轮识图之后要有"已把剪贴板还原成截图前的内容"那一行
     *      （img_clip_restore 里打的）；
     *   ② **源码**：img_region 里确实是"先 snapshot → 写图 → 用完 restore"
     *      这个形状，而且三条早退路径（plan 空 / urls 空 / 编码失败）也都还原
     *      —— 漏一条就是"搜失败了反而把截图永久留在剪贴板里"。
     *   ③ "还原的是用户原来的内容而不是清空"由 clip.rs 的 Rust 单测
     *      `识图截图借了剪贴板要还` 钉（那里能真的往剪贴板写东西再读回来）。 */
    await ev(ws, `window.__TAURI__.core.invoke('img_region', { x: 12, y: 12, w: 50, h: 36, dpr: 1 }).catch(()=>{})`);
    await sleep(9000);

    let logTxt2 = '';
    try { logTxt2 = fs.readFileSync(path.join(tmp, 'QuickSearch', 'log.txt'), 'utf8'); } catch (e) { }
    const didWrite = /img: clipboard image ok=true/.test(logTxt2);
    const didRestore = /img: 已把剪贴板还原成截图前的内容/.test(logTxt2);
    rec('第二轮：剪贴板写过图=' + didWrite + ' 跑完还原了=' + didRestore);
    check('B1 识图确实把图写进过剪贴板（证明不是在验一个空操作）', didWrite);
    check('B2 一轮搜完之后剪贴板被还原（截图不会永久留在电脑上）', didRestore);

    /* ---- B3：三条早退路径也都还原 ---- */
    const mainRs = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
    const imgStart = mainRs.indexOf('fn img_region(');
    const imgEnd = mainRs.indexOf('\nfn img_plan(', imgStart);
    const imgBody = mainRs.slice(imgStart, imgEnd < 0 ? mainRs.length : imgEnd);
    const restores = (imgBody.match(/img_clip_restore\(/g) || []).length;
    const earlyReturns = (imgBody.match(/return;/g) || []).length;
    rec('img_region 里 img_clip_restore 调用 ' + restores + ' 处，return ' + earlyReturns + ' 处');
    check('B3 早退路径也还原剪贴板（搜失败也不会把截图永久留在剪贴板里）',
        restores >= 3, '只有 ' + restores + ' 处还原');

    /* ---- B4：OCR 那条路压根不碰剪贴板 ---- */
    const ocrSrc = fs.readFileSync(path.join(ROOT, 'src', 'ocr.rs'), 'utf8');
    check('B4 OCR 主链路不碰剪贴板（没有截图残留可清）',
        !/clip::/.test(ocrSrc), ocrSrc.match(/clip::\w+/g));

    /* ---------- E：退出时那张临时图必须被删掉 ----------
     *
     * 这是 r57 那条新保证的最后一块：临时图允许存在，但**不许活过这次运行**。
     * 验法是让程序自己走正常退出（`quit_app` → `quit_with_sync` → 清理 → exit），
     * 然后看文件还在不在。不是 kill —— kill 不会跑清理代码，验不出东西。 */
    const beforeExit = fs.existsSync(path.join(tmpImgDir, 'shot.jpg'));
    rec('退出前临时图存在 = ' + beforeExit);
    check('E1 退出前那张临时图确实在（否则下面那条是空验）', beforeExit);

    await ev(ws, `window.__TAURI__.core.invoke('quit_app').catch(()=>{})`);
    await sleep(3500);
    const afterExit = fs.existsSync(path.join(tmpImgDir, 'shot.jpg'));
    rec('正常退出后临时图存在 = ' + afterExit);
    check('E2 **正常退出后临时图被删掉**（截图不会永久留在电脑上）', afterExit === false);

    rec('');
    rec('========== r56 截图用完即删：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(500);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
