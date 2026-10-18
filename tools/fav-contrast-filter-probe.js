/* ============================================================================
 *  专项探针：收藏夹文字对比度 + 「更多引擎」搜索框（本轮用户反馈）
 *
 *  本轮要证的三件事：
 *    ① 【收藏夹里字跟背景一个颜色】底色是后端从**前台窗口画面**采来的，
 *       字色原先只有"浅色/深色"两套、靠后端一个布尔值切 —— 那个布尔值用
 *       「sRGB 数值加权」当亮度、分界还定在 0.5，而且"中亮度往两头推"推的只是
 *       判断用的变量、rgb 原样发下来。于是中亮底色配浅色字，最差对比度 2.33:1。
 *       本段对一组典型底色**同时跑旧逻辑和新逻辑**，各自量真实 DOM 里
 *       .fav-item .fav-main 与 .panel 有效底色的 WCAG 对比度：
 *         · 旧逻辑：探针里照抄已发布的判定 + 手写它那三步落色（见 LEGACY_APPLY）
 *         · 新逻辑：调产品自己的 applyThemePayload（后端还发同一个带 alpha 的 rgba）
 *       断言 旧 < 4.5:1（bug 成立）且 新 ≥ 4.5:1（修好了）。
 *    ② 【引擎太多找不到】面板头部新增的 #engFilter 能即时过滤引擎列表：
 *       打开面板光标就落在里面；输入"知"只剩含"知"的；输入"阿里巴巴图标库"
 *       能筛出 iconfont（= 阿里巴巴矢量图标库，表里的 name 是英文）；
 *       输入查不到的词出占位；清空完全还原。
 *    ③ 【回车就用第一个命中项】把它拦下来（不真去开浏览器）验证。
 *
 *  做法：另起测试实例（QS_INSTANCE_TAG + --bar），操作全走 CDP，
 *        不碰用户的全局输入；配置用真实配置的副本（收藏夹里有内容，
 *        截图才是用户看到的那一屏），但关掉 trigger_select/trigger_copy/ocr。
 *
 *  用法：node tools/fav-contrast-filter-probe.js
 *  输出：tools/fav-contrast-filter-probe.txt
 * ========================================================================== */
const koffi = require('koffi');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'fav-contrast-filter-probe.txt');
const PORT = 9341;
const TAG = '-probe-contrast';
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) { }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');

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
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function shot(ws, name, clip) {
    const r = await cdp(ws, 'Page.captureScreenshot', clip
        ? { format: 'png', clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }, captureBeyondViewport: true }
        : { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
    rec('  [截图] ' + name);
}
/** 真键盘回车（比合成事件更接近用户按下去）。
 *  rawKeyDown 只派发 keydown、不插字符 —— 单行 input 也不需要插 '\r'。 */
async function pressEnter(ws) {
    for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp(ws, 'Input.dispatchKeyEvent', {
            type, key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
    }
}

async function connect(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
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

/* ---------------- 页面侧：对比度测量 ----------------
 * 量的是**真实渲染出来的计算值**：.fav-item .fav-main 的 color 对 .panel 的
 * 背景色（--qs-bg-fill → 计算出的 background-color）。
 *   · opaque：把底色的 alpha 当成 1 —— 这是产品护栏的"契约口径"
 *     （护栏保证的是字色对**那个颜色本身**达标）。
 *   · worst ：按真实 alpha 分别与"白底/黑底"合成，取两者里更差的 ——
 *     这是屏幕上最坏情况的口径，只报不判定（面板整体还挂着 opacity，本来就
 *     会再混一点，用户的不透明度滑杆是他自己的选择）。
 */
const MEASURE = `(function(){
  function lin(v){ var s=v/255; return s<=0.04045 ? s/12.92 : Math.pow((s+0.055)/1.055,2.4); }
  function lum(c){ return 0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2]); }
  function ratio(a,b){ var hi=Math.max(a,b), lo=Math.min(a,b); return (hi+0.05)/(lo+0.05); }
  function parse(s){
    var m=String(s).match(/rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)/i);
    if(!m) return null;
    return [Math.round(+m[1]),Math.round(+m[2]),Math.round(+m[3]), m[4]===undefined?1:+m[4]];
  }
  // 把某个主题变量解析成**真实 rgb**：临时造一个元素、给它 color: var(x)、读计算值。
  // 这样拿到的就是"主题此刻给出来的字色"，可以拿它跟元素实际用的字色对比 ——
  // 能直接证伪"靠继承的元素根本没继承到主题色"这一类问题。
  function resolveVar(name){
    var st=document.getElementById('stage');
    var d=document.createElement('div');
    d.style.color='var('+name+')';
    st.appendChild(d);
    var c=getComputedStyle(d).color;
    st.removeChild(d);
    return c;
  }
  var panel=document.getElementById('panel');
  var item=document.querySelector('.fav-item .fav-main') || document.querySelector('.fav-item');
  var cs=getComputedStyle(panel);
  var bg=parse(cs.backgroundColor);
  var fgStr=getComputedStyle(item).color;
  var fg=parse(fgStr);
  if(!bg||!fg) return {err:'parse', bgRaw:cs.backgroundColor, fgRaw:fgStr};
  var bgOpaque=[bg[0],bg[1],bg[2]];
  var over=function(back){ // 底色按真实 alpha 合成到 back 上
    var a=bg[3], out=[];
    for(var i=0;i<3;i++) out.push(Math.round(bg[i]*a + back*(1-a)));
    return out;
  };
  var rOp=ratio(lum(fg), lum(bgOpaque));
  var rB=ratio(lum(fg), lum(over(0)));
  var rW=ratio(lum(fg), lum(over(255)));
  var themeFg=resolveVar('--qs-fg');
  return {
    panelBg: cs.backgroundColor, textColor: fgStr, panelOpacity: cs.opacity,
    themeFg: themeFg,
    followsTheme: fgStr.replace(/\s/g,'') === themeFg.replace(/\s/g,''),
    fgEffective: getComputedStyle(item).opacity,
    dark: document.getElementById('stage').classList.contains('qs-dark'),
    qsBg: document.getElementById('stage').style.getPropertyValue('--qs-bg').trim(),
    fgOverride: document.getElementById('stage').style.getPropertyValue('--qs-fg').trim(),
    ratioOpaque: Math.round(rOp*100)/100,
    ratioOverBlack: Math.round(rB*100)/100,
    ratioOverWhite: Math.round(rW*100)/100,
  };
})()`;

/** 旧逻辑三步落色（照抄已发布的 handler + sample_theme 的判定，用于 A/B）。
 *  ⚠ 这段是**故意**把旧行为固化下来做对照的，不要"顺手修好"。 */
const LEGACY_APPLY = `(function(r,g,b,alpha){
  // —— 已发布的 sample_theme 里的判定 ——
  var lum=(0.2126*r+0.7152*g+0.0722*b)/255.0;
  if(lum>=0.40 && lum<=0.60){ lum = lum<0.5 ? 0.35 : 0.65; }
  var dark = lum<0.5;
  // —— 已发布的 qs://theme handler ——
  var st=document.getElementById('stage');
  // 旧 handler 从没写过 --qs-fg/--qs-fg-dim/--qs-tip 的内联覆盖，所以"旧状态"
  // 就是"没有任何覆盖"。不先清掉，上一轮新逻辑写的覆盖会漏进这一轮，A/B 就废了。
  st.style.removeProperty('--qs-fg');
  st.style.removeProperty('--qs-fg-dim');
  st.style.removeProperty('--qs-tip');
  st.classList.toggle('qs-dark', !!dark);
  st.style.setProperty('--qs-bg','rgba('+r+','+g+','+b+','+alpha+')');
  syncBarBg();
  return dark;
})`;

/** 新逻辑：走产品自己的 applyThemePayload（dark 提示沿用旧判定，模拟"后端没改"的极端） */
const NEW_APPLY = `(function(r,g,b,alpha){
  var lum=(0.2126*r+0.7152*g+0.0722*b)/255.0;
  if(lum>=0.40 && lum<=0.60){ lum = lum<0.5 ? 0.35 : 0.65; }
  applyThemePayload({ dark: lum<0.5, bg: 'rgba('+r+','+g+','+b+','+alpha+')' });
  return document.getElementById('stage').classList.contains('qs-dark');
})`;

function relLum(r, g, b) {
    const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/* 一组"典型前台窗口底色"。挑的都是会把老逻辑打穿的中亮/彩色：
 *   白/近黑      —— 正常情况，两套逻辑都该没事
 *   中灰 150,152,160 —— 相对亮度 0.31，老逻辑判成"暗色底"→浅字，字就没了
 *   洋红 255,75,255 —— 老逻辑的最差解（2.33:1）
 *   中绿 40,135,35  —— 正好压在黑白字的分界点附近（0.179） */
const SAMPLES = [
    ['白（亮色软件）', 255, 255, 255],
    ['近黑（暗色软件）', 19, 19, 24],
    ['中灰（编辑器侧栏）', 150, 152, 160],
    ['浅灰（工具栏）', 137, 137, 137],
    ['洋红（彩色页面）', 255, 75, 255],
    ['中绿（彩色页面）', 40, 135, 35],
    ['灰蓝（莫兰迪）', 120, 130, 145],
];

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-contrast-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    let alphaPct = 95;
    {
        const src = path.join(process.env.APPDATA, 'QuickSearch', 'config.json');
        const c = JSON.parse(fs.readFileSync(src, 'utf8'));
        alphaPct = Number(c.alpha) || 95;
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        c.trigger_select = false; c.trigger_copy = false; c.ocr_enable = false;
        c.auto_start = false; c.delay_ms = 0;
        c.fav_panel_sizes = {};
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const logp = path.join(qs, 'log.txt');
    const readLog = () => { try { return fs.readFileSync(logp, 'utf8'); } catch (e) { return ''; } };

    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_DEBUG: '1', QS_INSTANCE_TAG: TAG, QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('启动 pid=' + proc.pid + '（QS_INSTANCE_TAG=' + TAG + ' + --bar；全程走 CDP，不碰全局输入）');
    rec('配置：真实配置的副本（含 ' + ((JSON.parse(fs.readFileSync(path.join(qs, 'config.json'), 'utf8')).favorites || []).length) + ' 个收藏目录），不透明度 alpha=' + alphaPct + '%');
    sleep(9000);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上（端口 ' + PORT + '）'); try { proc.kill(); } catch (e) { } flush(); process.exit(0); }

    const alpha = (alphaPct / 100).toFixed(2);

    /* 打开收藏面板（快捷键那条路：panelFav='root'，列出所有一级目录） */
    await evalJs(ws, "openFavPanel(null)");
    sleep(900);
    await evalJs(ws, "window.__TAURI__.core.invoke('grow_bar', {need_w: 660, need_h: 640})"
        + ".then(function(){return 'ok'}).catch(function(e){return 'err:'+e})");
    sleep(500);
    const view = await evalJs(ws, 'window.innerWidth + "x" + window.innerHeight');
    rec('收藏面板已打开，探针自备视口 ' + view);

    /* ================= ① 对比度 A/B ================= */
    rec('');
    rec('=== ① 收藏夹文字 vs 面板底色的 WCAG 对比度（同一份 CSS，只换落色逻辑） ===');
    rec('  样本                                  相对亮度  旧逻辑  旧对比度  新逻辑  新对比度   新字色覆盖');
    let worstOld = 999, worstNew = 999, worstNewName = '', worstOldName = '';
    let legacyFollowsAll = true, legacyBrokeCases = 0;
    const detail = [];
    for (const [name, r, g, b] of SAMPLES) {
        const oldDark = await evalJs(ws, LEGACY_APPLY + '(' + r + ',' + g + ',' + b + ',"' + alpha + '")');
        const mOld = await evalJs(ws, MEASURE);
        const newDark = await evalJs(ws, NEW_APPLY + '(' + r + ',' + g + ',' + b + ',"' + alpha + '")');
        const mNew = await evalJs(ws, MEASURE);
        const pad = (s, n) => String(s).padEnd(n, ' ');
        rec('  ' + pad(name, 24) + pad(relLum(r, g, b).toFixed(3), 8)
            + pad('dark=' + oldDark, 8) + pad(mOld.ratioOpaque.toFixed(2) + ':1', 10)
            + pad('dark=' + newDark, 8) + pad(mNew.ratioOpaque.toFixed(2) + ':1', 10)
            + pad(mNew.fgOverride || '（未覆盖）', 18)
            + (mNew.followsTheme ? '' : '  ⚠ 字色没跟着主题（实际 ' + mNew.textColor + ' / 主题 ' + mNew.themeFg + '）'));
        detail.push({ name, mOld, mNew, rgb: [r, g, b] });
        if (mOld.ratioOpaque < worstOld) { worstOld = mOld.ratioOpaque; worstOldName = name; }
        if (mNew.ratioOpaque < worstNew) { worstNew = mNew.ratioOpaque; worstNewName = name; }
        // 旧行为里"字色压根没跟着主题走"的情况（继承落到 canvastext）
        if (!mOld.followsTheme) { legacyBrokeCases += 1; }
    }
    const legacyBad = worstOld < 4.5;
    const newOk = worstNew >= 4.5;
    rec('  → 旧行为最差 ' + worstOld.toFixed(2) + ':1（' + worstOldName + '）'
        + ' —— 低于 WCAG 正文门槛 4.5:1 : ' + (legacyBad ? 'REPRO(符合预期，bug 成立)' : '未复现'));
    rec('  → 新行为最差 ' + worstNew.toFixed(2) + ':1（' + worstNewName + '）'
        + ' —— 全部 ≥ 4.5:1 : ' + (newOk ? 'PASS' : 'FAIL'));

    /* ①b：把根因单独钉出来 —— 收藏面板的文字到底有没有继承到主题字色。
     * 旧 CSS 里主题变量只在 .stage 上定义，而 html,body 那条 `color: var(--qs-fg)`
     * 在 .stage 之外取不到它 → 整条声明作废 → 落到 canvastext（跟系统日/夜走）。
     * 这里用"把 .stage 的 color 强制设成 canvastext"来复现旧行为。 */
    rec('');
    rec('  ①b 收藏面板文字色是否真跟着主题（根因验证）');
    /* 旧 CSS 里 `html, body { color: var(--qs-fg) }` 取不到 .stage 上的 --qs-fg →
     * 整条声明作废 → 落到 canvastext（跟**系统**日/夜间走，跟取色底色无关）。
     * 这里把 .stage 的 color 强制成 canvastext 来复现旧行为。
     * ⚠ 两种底色都测：canvastext 到底偏黑还是偏白取决于本机系统主题，
     *   只测一种的话，结论会随跑探针的机器变 —— 那样就不是证据了。 */
    // 直接量 canvastext 到底解析成什么（不能读 html 的 color —— 修复后那已经是主题色了）
    const canvasText = await evalJs(ws, "(function(){var st=document.getElementById('stage');"
        + "var old=st.style.color; st.style.color='canvastext';"
        + "var c=getComputedStyle(st).color; st.style.color=old; return c;})()");
    rec('    本机 canvastext = ' + canvasText + '（= 旧那条作废声明落到的东西，跟系统日/夜走）');
    let oldInheritWorst = 999, oldInheritName = '', fixedWorst = 999;
    let fixedFollowsAll = true, oldFollowsFalse = 0;
    for (const [nm, r, g, b] of [['白底（取色采到亮色软件）', 255, 255, 255],
                                 ['近黑底（取色采到暗色软件）', 19, 19, 24]]) {
        await evalJs(ws, NEW_APPLY + '(' + r + ',' + g + ',' + b + ',"' + alpha + '")');
        sleep(160);
        const fixed = await evalJs(ws, MEASURE);
        // 同一屏、同一块底色，先留一张"修复后"，再切到旧行为留一张 —— 一对照就看得出来
        const wantShot = oldInheritWorst === 999;   // 只在第一轮（白底）留证据
        const panelBox = async () => evalJs(ws,
            "(function(){var p=document.getElementById('panel');var b=p.getBoundingClientRect();"
            + "return {x:Math.round(b.left),y:Math.round(b.top),"
            + "w:Math.round(b.width),h:Math.round(b.height)};})()");
        if (wantShot) {
            const bx = await panelBox();
            await shot(ws, '_fav-contrast-invisible-fixed.png', {
                x: Math.max(0, bx.x - 6), y: Math.max(0, bx.y - 6),
                width: bx.w + 12, height: bx.h + 12,
            });
        }
        await evalJs(ws, "document.getElementById('stage').style.color='canvastext'");
        sleep(150);
        const old = await evalJs(ws, MEASURE);
        if (wantShot && old.ratioOpaque < 2) {
            const bx = await panelBox();
            await shot(ws, '_fav-contrast-invisible-legacy.png', {
                x: Math.max(0, bx.x - 6), y: Math.max(0, bx.y - 6),
                width: bx.w + 12, height: bx.h + 12,
            });
            rec('      → 已截图 _fav-contrast-invisible-{legacy,fixed}.png：'
                + '同一块底色（' + old.panelBg + '），旧行为 ' + old.textColor
                + '（' + old.ratioOpaque.toFixed(2) + ':1）vs 修复后 ' + fixed.textColor
                + '（' + fixed.ratioOpaque.toFixed(2) + ':1）');
        }
        await evalJs(ws, "document.getElementById('stage').style.removeProperty('color')");
        sleep(150);
        rec('    ' + nm + '：旧行为文字 ' + old.textColor + ' → ' + old.ratioOpaque.toFixed(2) + ':1'
            + ' ｜ 修复后 ' + fixed.textColor + ' → ' + fixed.ratioOpaque.toFixed(2) + ':1'
            + (fixed.followsTheme ? '（跟主题一致）' : '  ⚠ 没跟主题'));
        if (old.ratioOpaque < oldInheritWorst) { oldInheritWorst = old.ratioOpaque; oldInheritName = nm; }
        if (fixed.ratioOpaque < fixedWorst) fixedWorst = fixed.ratioOpaque;
        if (!fixed.followsTheme) fixedFollowsAll = false;
        if (!old.followsTheme) oldFollowsFalse += 1;
    }
    rec('  → 旧 CSS 下字色不跟主题（继承落到 canvastext） : '
        + (oldFollowsFalse > 0 ? 'REPRO' : '未复现')
        + '，最差 ' + oldInheritWorst.toFixed(2) + ':1（' + oldInheritName + '）');
    rec('  → 修复后字色确实继承主题（最差 ' + fixedWorst.toFixed(2) + ':1） : '
        + (fixedFollowsAll && fixedWorst >= 4.5 ? 'PASS' : 'FAIL'));

    /* 顺带把"最差那一条"的屏幕像素也截一张：肉眼证据 */
    const worst = detail.find((d) => d.mNew.ratioOpaque === worstNew) || detail[0];
    await evalJs(ws, NEW_APPLY + '(' + worst.rgb[0] + ',' + worst.rgb[1] + ',' + worst.rgb[2] + ',"' + alpha + '")');
    sleep(200);
    const fbox = await evalJs(ws, "(function(){var p=document.getElementById('panel');"
        + "var b=p.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),"
        + "w:Math.round(b.width),h:Math.round(b.height)};})()");
    rec('  新逻辑最差样本 rgb(' + worst.rgb.join(',') + ') 的实际渲染（' + worst.mNew.panelBg + '）：');
    await shot(ws, '_fav-contrast-new.png', {
        x: Math.max(0, fbox.x - 6), y: Math.max(0, fbox.y - 6),
        width: fbox.w + 12, height: fbox.h + 12,
    });
    await evalJs(ws, LEGACY_APPLY + '(' + worst.rgb[0] + ',' + worst.rgb[1] + ',' + worst.rgb[2] + ',"' + alpha + '")');
    sleep(200);
    await shot(ws, '_fav-contrast-legacy.png', {
        x: Math.max(0, fbox.x - 6), y: Math.max(0, fbox.y - 6),
        width: fbox.w + 12, height: fbox.h + 12,
    });
    rec('  （_fav-contrast-legacy.png = 旧逻辑的同一屏，对照着看：字糊在底色里）');

    /* 顺带验一次"真事件通道"：从 JS emit qs://theme，看它是否也走同一套护栏 */
    rec('');
    rec('--- 走真实事件通道（qs://theme）复核一次 ---');
    const emitted = await evalJs(ws,
        "window.__TAURI__.event.emit('qs://theme', { dark: false, bg: 'rgba(150,152,160,0.95)' })"
        + ".then(function(){return 'emitted'}).catch(function(e){return 'err:'+e})");
    sleep(400);
    const mEvt = await evalJs(ws, MEASURE);
    rec('  emit 结果=' + emitted + '  → 面板底色 ' + mEvt.panelBg + ' / 字色 ' + mEvt.textColor
        + ' / 对比度 ' + mEvt.ratioOpaque.toFixed(2) + ':1');
    const evtOk = emitted === 'emitted' && mEvt.ratioOpaque >= 4.5;
    rec('  → 真实事件通道也达标 : ' + (evtOk ? 'PASS' : 'FAIL(看上面 emit 结果)'));

    /* ================= ② 引擎过滤 ================= */
    rec('');
    rec('=== ② 「更多引擎」面板的引擎搜索 ===');
    await evalJs(ws, "document.getElementById('btnPanelClose').click()");
    sleep(400);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(900);

    const FILTER_STATE = `(function(){
  var inp=document.getElementById('engFilter');
  var cells=[].slice.call(document.querySelectorAll('#panelBody .grid > .cell'));
  var vis=cells.filter(function(c){return !c.hidden;});
  var titles=[].slice.call(document.querySelectorAll('#panelBody .cat-title[data-cat]'));
  var navItems=[].slice.call(document.querySelectorAll('#panelBody .cat-nav:not(.fav-nav) .cat-nav-item'));
  var nav=document.querySelector('#panelBody .cat-nav:not(.fav-nav)');
  var nores=document.querySelector('#panelBody .eng-noresult');
  var cs=inp?getComputedStyle(inp):null;
  var r=cs?inp.getBoundingClientRect():null;
  return {
    has: !!inp, value: inp?inp.value:null,
    display: cs?cs.display:null,
    visible: !!cs && cs.display!=='none' && !!r && r.width>0,
    focused: !!inp && document.activeElement===inp,
    total: cells.length, shown: vis.length,
    names: vis.map(function(c){return c.dataset.engine;}),
    titlesTotal: titles.length, titlesShown: titles.filter(function(t){return !t.hidden;}).length,
    navTotal: navItems.length, navShown: navItems.filter(function(b){return !b.hidden;}).length,
    navHidden: !!nav && nav.hidden,
    noresult: nores?!nores.hidden:null,
    qValue: document.getElementById('q').value,
    favMode: document.getElementById('panel').classList.contains('fav-mode'),
  };
})()`;

    const S0 = await evalJs(ws, FILTER_STATE);
    rec('  打开面板：搜索框存在=' + S0.has + ' 可见=' + S0.visible + ' 已聚焦=' + S0.focused
        + ' 引擎共 ' + S0.total + ' 个 / 分类标题 ' + S0.titlesTotal + ' 个 / 分类胶囊 ' + S0.navTotal + ' 个');
    rec('  → 打开面板光标就在引擎搜索框里 : '
        + (S0.has && S0.visible && S0.focused ? 'PASS' : 'FAIL'));

    const setFilter = async (text) => {
        await evalJs(ws, "(function(){var i=document.getElementById('engFilter');"
            + "i.focus();i.value=" + JSON.stringify(text)
            + ";i.dispatchEvent(new Event('input',{bubbles:true}));})()");
        sleep(320);
        return evalJs(ws, FILTER_STATE);
    };

    const S1 = await setFilter('知');
    rec('');
    rec('  过滤「知」：剩 ' + S1.shown + ' / ' + S1.total + ' 个 → '
        + S1.names.slice(0, 10).join('、') + (S1.names.length > 10 ? ' …' : ''));
    rec('    分类标题剩 ' + S1.titlesShown + ' / ' + S1.titlesTotal
        + '，分类胶囊剩 ' + S1.navShown + ' / ' + S1.navTotal + '（整条导航隐藏=' + S1.navHidden + '）');
    // 命中判据只看"确实筛掉了东西"：名字里没有"知"的也可能是**别名**命中
    // （过滤规则是 name + alias 一起比），所以在页面里逐个核对 name/alias，
    // 别在这里凭名字想当然。
    const misHit = await evalJs(ws,
        "(function(){var bad=[];"
        + "[].slice.call(document.querySelectorAll('#panelBody .grid > .cell')).forEach(function(c){"
        + "  if(c.hidden) return;"
        + "  var n=c.dataset.engine, e=ENGINE_BY_NAME.get(n)||{}, raw=e.alias;"
        + "  var list=Array.isArray(raw)?raw:(raw?[raw]:[]);"
        + "  var hit=(n.toLowerCase().indexOf('知')>=0)||list.some(function(a){return String(a).toLowerCase().indexOf('知')>=0;});"
        + "  if(!hit) bad.push(n);"
        + "});"
        + "return bad;})()");
    rec('    可见项里"名字和别名都不含知"的：' + (misHit.length ? misHit.join('、') : '（没有，全部命中）'));
    const hitRatio = S1.shown > 0 && S1.shown < S0.total && misHit.length === 0;
    rec('  → 过滤确实生效（不是全留也不是全空） : ' + (hitRatio ? 'PASS' : 'FAIL'));

    const S2 = await setFilter('阿里巴巴图标库');
    rec('');
    rec('  过滤「阿里巴巴图标库」：剩 ' + S2.shown + ' 个 → ' + S2.names.join('、'));
    const aliOk = S2.names.indexOf('iconfont') >= 0;
    rec('  → 能按中文名筛出 iconfont（阿里巴巴矢量图标库） : ' + (aliOk ? 'PASS' : 'FAIL'));

    const S3 = await setFilter('知乎');
    rec('');
    rec('  过滤「知乎」：剩 ' + S3.shown + ' 个 → ' + S3.names.join('、'));

    const S4 = await setFilter('zzzz-没有这个词');
    rec('');
    rec('  过滤「zzzz-没有这个词」：剩 ' + S4.shown + ' 个，占位显示=' + S4.noresult);
    rec('  → 查不到时出占位而不是空白 : ' + (S4.shown === 0 && S4.noresult === true ? 'PASS' : 'FAIL'));

    const S5 = await setFilter('');
    rec('');
    rec('  清空：剩 ' + S5.shown + ' / ' + S5.total + ' 个，分类标题 ' + S5.titlesShown + ' / '
        + S5.titlesTotal + '，胶囊 ' + S5.navShown + ' / ' + S5.navTotal + '，占位=' + S5.noresult);
    const restoreOk = S5.shown === S0.total && S5.titlesShown === S0.titlesTotal
        && S5.navShown === S0.navTotal && S5.noresult === false;
    rec('  → 清空后完整还原 : ' + (restoreOk ? 'PASS' : 'FAIL'));

    /* 回车 = 用第一个命中项（把它拦下来，别真去开浏览器） */
    rec('');
    rec('--- 回车键：应当拿"筛出来最前面那个"去搜 ---');
    await setFilter('必应');
    await evalJs(ws, "window.__probeEnter=null;window.__origRun=window.runEngineSearch;"
        + "window.runEngineSearch=function(n){window.__probeEnter=n;};");
    await pressEnter(ws);
    sleep(300);
    const entered = await evalJs(ws, "window.__probeEnter");
    const firstVisible = await evalJs(ws,
        "(function(){var c=document.querySelector('#panelBody .grid > .cell:not([hidden])');"
        + "return c?c.dataset.engine:null;})()");
    await evalJs(ws, "window.runEngineSearch=window.__origRun;window.__origRun=null;");
    rec('  回车后"被使用的引擎"=' + JSON.stringify(entered) + '，筛出来第一个=' + JSON.stringify(firstVisible));
    rec('  → 回车用第一个命中项 : ' + (entered && entered === firstVisible ? 'PASS' : 'FAIL'));

    /* 关键词框不受影响 + 收藏面板里不显示引擎搜索框 */
    rec('');
    rec('--- 两个输入框互不干扰 / 收藏面板里不显示它 ---');
    const qVal = await evalJs(ws, "document.getElementById('q').value");
    rec('  过滤过程中关键词框 #q 的值 = ' + JSON.stringify(qVal) + '（该为空，没被牵连）');
    await evalJs(ws, "document.getElementById('btnPanelClose').click()");
    sleep(300);
    await evalJs(ws, "openFavPanel(null)");
    sleep(800);
    const SF = await evalJs(ws, FILTER_STATE);
    rec('  收藏面板里：引擎搜索框 display=' + SF.display + '（该 none） favMode=' + SF.favMode);
    rec('  → 收藏面板里不显示引擎搜索框 : ' + (SF.favMode && SF.display === 'none' ? 'PASS' : 'FAIL'));
    const fbox2 = await evalJs(ws, "(function(){var p=document.getElementById('panel');"
        + "var b=p.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),"
        + "w:Math.round(b.width),h:Math.round(b.height)};})()");
    await shot(ws, '_fav-contrast-filter-favpanel.png', {
        x: Math.max(0, fbox2.x - 6), y: Math.max(0, fbox2.y - 6),
        width: fbox2.w + 12, height: fbox2.h + 12,
    });
    await evalJs(ws, "document.getElementById('btnPanelClose').click()");
    sleep(300);
    await evalJs(ws, "document.getElementById('btnMore').click()");
    sleep(900);
    const S6 = await evalJs(ws, FILTER_STATE);
    rec('  回到引擎面板：过滤词=' + JSON.stringify(S6.value) + ' 剩 ' + S6.shown + ' / ' + S6.total
        + ' 个（该是空词、全部可见）');
    rec('  → 离开引擎面板后过滤词被清掉 : '
        + (S6.value === '' && S6.shown === S6.total ? 'PASS' : 'FAIL'));

    const ebox = await evalJs(ws, "(function(){var p=document.getElementById('panel');"
        + "var b=p.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),"
        + "w:Math.round(b.width),h:Math.round(b.height)};})()");
    await shot(ws, '_eng-filter-panel.png', {
        x: Math.max(0, ebox.x - 6), y: Math.max(0, ebox.y - 6),
        width: ebox.w + 12, height: ebox.h + 12,
    });
    await setFilter('图标');
    const fbox3 = await evalJs(ws, "(function(){var p=document.getElementById('panel');"
        + "var b=p.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),"
        + "w:Math.round(b.width),h:Math.round(b.height)};})()");
    await shot(ws, '_eng-filter-iconfont.png', {
        x: Math.max(0, fbox3.x - 6), y: Math.max(0, fbox3.y - 6),
        width: fbox3.w + 12, height: fbox3.h + 12,
    });

    /* ================= ③ 右键菜单（同一个根因的另一处受害者） ================= */
    rec('');
    rec('=== ③ 右键菜单：主题变量是否取得到（同一个根因） ===');
    await evalJs(ws, "openFavPanel(null)");
    sleep(700);
    await evalJs(ws, "openMenu(60, 60, '百度')");
    sleep(400);
    const MK = await evalJs(ws, `(function(){
      var m=document.getElementById('menu');
      var it=m.querySelector('.menu-item');
      var cs=getComputedStyle(m);
      function resolveVar(name){
        var st=document.getElementById('stage');
        var d=document.createElement('div'); d.style.color='var('+name+')';
        st.appendChild(d); var c=getComputedStyle(d).color; st.removeChild(d); return c;
      }
      return {
        hidden: m.hidden,
        parentId: m.parentElement ? m.parentElement.id : null,
        bg: cs.backgroundColor,
        bgTransparent: /rgba?\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*(,\\s*0)?\\)/.test(cs.backgroundColor) || cs.backgroundColor==='transparent',
        itemColor: it ? getComputedStyle(it).color : null,
        themeFg: resolveVar('--qs-fg'),
      };
    })()`);
    rec('  菜单父节点 = ' + MK.parentId + '（该是 stage）  hidden=' + MK.hidden);
    rec('  菜单底色 = ' + MK.bg + '（该不是 transparent）');
    rec('  菜单项文字 = ' + MK.itemColor + ' / 主题 --qs-fg = ' + MK.themeFg);
    const menuOk = MK.parentId === 'stage' && !MK.bgTransparent
        && String(MK.itemColor).replace(/\s/g, '') === String(MK.themeFg).replace(/\s/g, '');
    rec('  → 菜单有底色、文字跟主题 : ' + (menuOk ? 'PASS' : 'FAIL'));
    await evalJs(ws, "closeMenu()");

    rec('');
    rec('=== 汇总 ===');
    rec('  ①a 旧取色判定确实会产出看不清的字（' + worstOld.toFixed(2) + ':1 < 4.5:1） : '
        + (legacyBad ? 'REPRO' : '未复现'));
    rec('  ①b 旧 CSS 下收藏面板字色不跟主题（落到 canvastext ' + canvasText + '） : '
        + (oldFollowsFalse > 0 ? 'REPRO' : '未复现')
        + '，最差 ' + oldInheritWorst.toFixed(2) + ':1（' + oldInheritName + '）');
    rec('  ①b 字色继承链已修好（最差 ' + fixedWorst.toFixed(2) + ':1） : '
        + (fixedFollowsAll && fixedWorst >= 4.5 ? 'PASS' : 'FAIL'));
    rec('  ③ 右键菜单同样修好（有底色 + 跟主题）      : ' + (menuOk ? 'PASS' : 'FAIL'));
    rec('  ①a 新逻辑全部达标（最差 ' + worstNew.toFixed(2) + ':1） : ' + (newOk ? 'PASS' : 'FAIL'));
    rec('  ① 真实事件通道 qs://theme 也达标         : ' + (evtOk ? 'PASS' : 'FAIL'));
    rec('  ② 打开面板光标落在引擎搜索框             : ' + (S0.has && S0.visible && S0.focused ? 'PASS' : 'FAIL'));
    rec('  ② 输入即过滤 / 清空即还原                : ' + (hitRatio && restoreOk ? 'PASS' : 'FAIL'));
    rec('  ② 查中文别名能筛出 iconfont              : ' + (aliOk ? 'PASS' : 'FAIL'));
    rec('  ② 空结果出占位                           : ' + (S4.shown === 0 && S4.noresult === true ? 'PASS' : 'FAIL'));
    rec('  ② 回车用第一个命中项                     : ' + (entered && entered === firstVisible ? 'PASS' : 'FAIL'));
    rec('  ② 收藏面板里不显示引擎搜索框             : ' + (SF.favMode && SF.display === 'none' ? 'PASS' : 'FAIL'));
    rec('  ② 离开引擎面板后过滤词清空               : ' + (S6.value === '' && S6.shown === S6.total ? 'PASS' : 'FAIL'));

    rec('');
    rec('--- log.txt 里的 theme: 行（新版会多打"相对亮度/预估对比度"）---');
    const themeLines = readLog().split('\n').filter((s) => s.indexOf('theme:') >= 0).slice(-6);
    if (!themeLines.length) rec('  （本次没触发后端取色 —— 探针走的是前端落色，属正常）');
    for (const s of themeLines) rec('  ' + s);

    flush();
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(0);
});
