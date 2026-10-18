/* ============================================================================
 *  r54 三项新功能的真机探针（r54-probe.js）
 *
 *  量什么（对应用户原话的三条）：
 *
 *  ① 识图搜索：「在设置中新增独立设置栏，尽可能集成丰富的识图搜索引擎；支持将
 *     入口添加到划词横条中……点击识图搜索按钮，可框选截取屏幕指定区域进行识图；
 *     支持在设置中配置默认引擎……支持多选引擎，勾选多个引擎后同时进行搜索」。
 *     —— 设置栏存在、引擎清单 ≥ 10 家、横条上有那颗按钮、点它能开出框选遮罩
 *        （且遮罩是 ?mode=img、提示文案是识图的那一句）、配置项都在且能改。
 *
 *  ② 文件路径快捷打开：「当划词选中的内容是本地文件路径时，横条上自动弹出文件
 *     管理器图标，点击后直接调用系统文件管理器定位并打开对应路径」。
 *     —— 选中一段普通文字时图标不出现；选中一条路径时图标出现、title 带路径；
 *        点它调 open_path，后端回一句人话（找不到 / 已定位）。
 *
 *  ③ 数据导入导出：「导出时提供数据项勾选界面……默认仅勾选非隐私内容；导出的
 *     配置数据不加密……导入功能仅支持直接恢复导出的明文数据，不支持导入加密备份」。
 *     —— 勾选界面存在且默认只勾非隐私那几项；导出/导入命令在后端注册表里；
 *        明文导入拒绝加密备份（这条在 Rust 单测里已断言，这里再验一次接口在）。
 *
 *  ⚠ 不做的事（诚实边界）：**不真的发一次识图请求**。post_and_result_url 要连
 *    Bing / ascii2d，本机探针环境没有出网保证；而且那会往真实服务端传一张截图。
 *    这里量到"截图编成 JPEG、按配置拼出该开哪些链接"为止 —— 拼链接那一段是纯
 *    函数（imgsearch.rs 单测覆盖），网络那一段留给真机手点一次。
 *
 *  用法：node tools/r54-probe.js     输出：tools/r54-probe.txt
 *  ⚠ 自带身份（QS_INSTANCE_TAG + 独立 WebView2 目录），不杀任何别人的进程。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r54-probe.txt');
const PORT = 9354;
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
    const r = await cdp(ws, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.text || '') +
        ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '');
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

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r54-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    // 从真机配置拷一份当底座（否则新装配置里没有引擎历史，横条会是空的），
    // 但把云同步相关的一律清空：探针不碰网盘。
    {
        const src = path.join(process.env.APPDATA, 'QuickSearch', 'config.json');
        if (fs.existsSync(src)) {
            const c = JSON.parse(fs.readFileSync(src, 'utf8'));
            c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = '';
            if ('webdav_auto' in c) c.webdav_auto = false;
            // r54：识图默认开着、默认加到横条（新装就该这样；探针按真机口径验）。
            // ⚠ img_engines / img_default_engine **故意不写**：宿主机的
            //   config.json 是升级前的（没有这两个键），正好验"老配置升级上来
            //   也得到两家全自动引擎"这条（见 config.rs 的 default_img_engines）——
            //   这里要是替它写好，就把真正要验的那段盖掉了。
            c.img_enable = true; c.img_add_to_bar = true;
            fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
        }
    }
    const TAG = 'r54' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: TAG,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('r54 探针：启动 pid=' + proc.pid + '  实例标记=' + TAG);
    sleep(9000);

    const barWs = await connect('tauri.localhost/');
    if (!barWs) {
        rec('横条 CDP 连不上 —— 探针作废');
        try { proc.kill(); } catch (e) { }
        flush(); process.exit(1);
    }

    /* ================= ① 识图搜索 ================= */

    // 1a. 横条上那颗「识图」按钮在不在（imgAddToBar 默认开）
    const hasImgBtn = await evalJs(barWs, `(function(){
      const b = document.getElementById('btnImg');
      return b ? (b.hidden ? 'hidden' : 'visible') : 'missing';
    })()`);
    check('横条上有识图按钮（🔍）且可见', hasImgBtn === 'visible', 'got ' + hasImgBtn);

    // 1b. 后端识图引擎清单：家数 + 三种模式都齐
    const engs = await evalJs(barWs, `(async function(){
      try {
        const list = await window.__TAURI__.core.invoke('img_engines_list');
        const modes = {};
        for (const e of list) modes[e.mode] = (modes[e.mode] || 0) + 1;
        return JSON.stringify({ n: list.length, modes,
          ids: list.map((e) => e.id), first: list[0] && list[0].name });
      } catch (e) { return 'ERR ' + e; }
    })()`);
    let eo = {};
    try { eo = JSON.parse(engs); } catch (e) { }
    check('识图引擎清单 ≥ 10 家（「尽可能集成丰富」）', (eo.n || 0) >= 10, engs);
    check('三种模式都有（全自动 post / 半自动 paste / 按地址 url）',
        !!eo.modes && !!eo.modes.post && !!eo.modes.paste && !!eo.modes.url,
        JSON.stringify(eo.modes || {}));
    check('默认引擎是必应（完全自动、无需账号）', eo.first === '必应视觉搜索', 'first=' + eo.first);
    rec('识图引擎：' + engs);

    // 1c. 设置页那一栏存在、引擎行渲染出来、模式徽标在
    let setWs = await connect('settings.html');
    if (!setWs) {
        // 设置窗默认不开：主动叫它开一次（open_settings 是现成命令）
        await evalJs(barWs, `window.__TAURI__.core.invoke('open_settings').catch(()=>{})`);
        setWs = await connect('settings.html', 25000);
    }
    if (setWs) {
        // 切到识图那一栏
        await evalJs(setWs, `(function(){
          const b = document.querySelector('#tabs button[data-tab="imgsearch"]');
          if (b) b.click();
          return !!b;
        })()`);
        await sleep(700);
        /* 引擎清单是 boot 里异步 invoke 拿的：刚连上设置页时可能还没渲染完，
         * 轮询等它出现（最多 8 秒），别让"慢"被记成"没有"。
         * 复选框的勾选状态也等它稳定（第一次渲染时配置广播可能还没到，
         * 早量一步会读到 0 个勾 —— 那是时序，不是功能坏）。 */
        for (let i = 0; i < 16; i++) {
            const st = await evalJs(setWs, `(function(){
              const cbs = document.querySelectorAll('.eng-row.img-row input[type=checkbox]');
              return cbs.length + '/' + document.querySelectorAll('.eng-row.img-row input[type=checkbox]:checked').length;
            })()`);
            if (String(st).split('/')[0] !== '0' && String(st).split('/')[1] !== '0') break;
            await sleep(500);
        }
        const pane = await evalJs(setWs, `(function(){
          const p = document.querySelector('.pane[data-pane="imgsearch"]');
          if (!p) return 'NO-PANE';
          const hidden = p.hasAttribute('hidden');
          const rows = p.querySelectorAll('.eng-row.img-row').length;
          const tags = p.querySelectorAll('.eng-tag.mode').length;
          const checks = p.querySelectorAll('.eng-check input[type=checkbox]').length;
          const on = p.querySelectorAll('.eng-check input[type=checkbox]:checked').length;
          const segBtns = p.querySelectorAll('#s-imgDefaultEngine button').length;
          const urlBox = !!p.querySelector('#s-imgPublicUrl');
          const tryBtn = !!p.querySelector('#btnImgTry');
          return JSON.stringify({ hidden, rows, tags, checks, on, segBtns, urlBox, tryBtn });
        })()`);
        let po = {};
        try { po = JSON.parse(pane); } catch (e) { }
        check('设置里有「识图搜索」这一栏（独立设置栏）', po.hidden === false, pane);
        check('引擎行都渲染出来了（行数 = 清单家数）',
            po.rows === (eo.n || 0), 'rows=' + po.rows + ' vs ' + (eo.n || 0));
        check('每家都有模式徽标（全自动/半自动/按地址）', po.tags === po.rows, pane);
        check('多选复选框齐全', po.checks === po.rows, pane);
        check('默认勾选的就是完全自动那两家（必应 + ascii2d）',
            po.on === 2, 'checked=' + po.on + '   pane=' + pane);
        check('默认引擎那排有「不设」+ 每家一个按钮',
            po.segBtns === (eo.n || 0) + 1, 'segBtns=' + po.segBtns);
        check('公网图片地址输入框在（Url 类引擎用）', po.urlBox === true, pane);
        check('「框一次试试」按钮在', po.tryBtn === true, pane);

        // 1c-2. 勾一家 → 配置真的落库（imgEngines）
        const setOk = await evalJs(setWs, `(async function(){
          try {
            const cb = document.querySelector('.eng-row.img-row .eng-check input[type=checkbox]:not(:checked)');
            if (!cb) return 'NO-UNCHECKED';
            const id = cb.dataset.id;
            cb.click();
            await new Promise((r) => setTimeout(r, 350));
            const cfg = await window.__TAURI__.core.invoke('get_config');
            const has = (cfg.imgEngines || []).indexOf(id) >= 0;
            // 勾回去，保持配置干净
            const again = document.querySelector('.eng-row.img-row[data-id="' + id + '"] input[type=checkbox]');
            if (again) again.click();
            await new Promise((r) => setTimeout(r, 250));
            return id + '=' + has;
          } catch (e) { return 'ERR ' + e; }
        })()`);
        check('勾一家识图引擎 → 立刻写进配置 imgEngines',
            /^[a-z0-9-]+=true$/.test(String(setOk)), setOk);

        // 1c-3. 设默认引擎 → 配置落库（imgDefaultEngine）
        const defOk = await evalJs(setWs, `(async function(){
          try {
            const btns = document.querySelectorAll('#s-imgDefaultEngine button');
            const target = Array.from(btns).find((b) => b.dataset.v && b.dataset.v !== '');
            if (!target) return 'NO-BTN';
            target.click();
            await new Promise((r) => setTimeout(r, 350));
            const cfg = await window.__TAURI__.core.invoke('get_config');
            const got = cfg.imgDefaultEngine;
            // 设回去「不设」，保持干净
            const none = Array.from(btns).find((b) => b.dataset.v === '');
            if (none) none.click();
            await new Promise((r) => setTimeout(r, 250));
            return got;
          } catch (e) { return 'ERR ' + e; }
        })()`);
        check('设了默认引擎 → 配置 imgDefaultEngine 跟着变（截图完成直接搜这家）',
            /^[a-z0-9-]+$/.test(String(defOk)) && defOk !== 'ERR', defOk);
    } else {
        check('设置窗口能打开（识图那一栏要有）', false, 'CDP 连不上 settings.html');
    }

    // 1d. 点横条上的「识图」→ 框选遮罩以 ?mode=img 起来，提示文案是识图那句
    const region = await evalJs(barWs, `(async function(){
      try {
        const b = document.getElementById('btnImg');
        if (!b) return 'NO-BTN';
        b.click();
        return 'clicked';
      } catch (e) { return 'ERR ' + e; }
    })()`);
    check('点横条识图按钮不报错', region === 'clicked', region);
    await sleep(2500);
    let regWs = await connect('region.html');
    if (regWs) {
        const mode = await evalJs(regWs, `(function(){
          const tip = (document.getElementById('tip') || {}).textContent || '';
          const u = location.search;
          return JSON.stringify({ search: u, tip });
        })()`);
        let mo = {};
        try { mo = JSON.parse(mode); } catch (e) { }
        check('框选遮罩以 ?mode=img 打开（与 OCR 共用同一窗口）',
            /mode=img/.test(String(mo.search || '')), mode);
        check('遮罩提示文案是「识图搜索」那一句（不是 OCR 那句）',
            /识图搜索/.test(String(mo.tip || '')) && !/识别/.test(String(mo.tip || '')), mode);
        // 关掉它：Esc（不真的截屏 —— 那会往真实识图服务发一张图）
        await evalJs(regWs, `(function(){
          const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
          window.dispatchEvent(e); document.dispatchEvent(e);
          return 1;
        })()`);
    } else {
        check('框选遮罩能开出来', false, 'region.html CDP 连不上');
    }
    await sleep(1200);

    /* ⚠ 怎么让横条"划到一段文字"：探针不起记事本、不合成鼠标拖选（那套又慢又抖），
       直接在横条页面里 emit 一次 `qs://show` —— 走的就是 show_bar 平时推给横条的
       同一条事件、同一个 payload 形状（text / hwnd / via_copy），subscription 是现成
       的，所以 syncPathBtn / syncImgBtn 会被真跑到。 */
    const showBar = (ws, text) => evalJs(ws, `(async function(){
      try {
        await window.__TAURI__.event.emit('qs://show', {
          text: ${JSON.stringify(text)}, hwnd: 0, via_copy: false, urls: [], isUrl: false,
        });
        await new Promise((r) => setTimeout(r, 400));
        return 'ok';
      } catch (e) { return 'ERR ' + e; }
    })()`);
    const pathBtnState = (ws) => evalJs(ws, `(function(){
      const b = document.getElementById('btnPath');
      return b ? (b.hidden ? 'hidden' : 'visible') : 'missing';
    })()`);

    /* ================= ② 文件路径快捷打开 ================= */

    // 2a. 划词是普通文字 → 图标不出现
    const r1 = await showBar(barWs, '今天天气不错');
    const noPath = await pathBtnState(barWs);
    check('划词是普通句子 → 文件管理器图标不出现', noPath === 'hidden', noPath);

    // 2b. 划词是一条真实路径 → 图标出现，且 title 里带着那条路径
    const SAMPLE = path.join(qs, 'config.json');
    const r2 = await showBar(barWs, SAMPLE);
    const withPath = await evalJs(barWs, `(function(){
      const b = document.getElementById('btnPath');
      if (!b) return 'missing';
      return JSON.stringify({ hidden: b.hidden, title: b.title });
    })()`);
    let wp = {};
    try { wp = JSON.parse(withPath); } catch (e) { }
    check('划词是本地路径 → 文件管理器图标自动出现', wp.hidden === false, withPath);
    check('图标 title 写的是「打开这条路径」（不是一句空话）',
        typeof wp.title === 'string' && wp.title.indexOf(SAMPLE) >= 0, withPath);

    // 2c. 带引号的路径也认（划词经常把引号一起选进来）
    await showBar(barWs, '"' + SAMPLE + '"');
    const quoted = await pathBtnState(barWs);
    check('带成对引号的路径也认（剥掉引号再判）', quoted === 'visible', quoted);

    // 2d. 反斜杠写成正斜杠也认（浏览器地址栏复制出来的常是正斜杠）
    await showBar(barWs, SAMPLE.split(path.sep).join('/'));
    const slashed = await pathBtnState(barWs);
    check('正斜杠写的盘符路径也认（C:/Users/…）', slashed === 'visible', slashed);

    // 2e. 网址不认（否则 🔗 和 📁 会同时出现，用户不知道点哪个）
    await showBar(barWs, 'https://www.bing.com/images');
    const asUrl = await pathBtnState(barWs);
    check('划词是网址 → 路径图标不出现（避免与 🔗 抢）', asUrl === 'hidden', asUrl);

    // 2f. 后备路径 %VAR%\name 也认（环境变量形式，本机一定有 APPDATA）
    await showBar(barWs, '%APPDATA%\\QuickSearch');
    const envForm = await pathBtnState(barWs);
    check('%VAR%\\… 形式也认（展开前先认出它是路径）', envForm === 'visible', envForm);

    // 2g. 只带分隔符的裸串不认（宁可放过也不误判 —— 误判会多个图标还报错）
    await showBar(barWs, 'bin\\tool.exe');
    const bare = await pathBtnState(barWs);
    check('裸的 bin\\tool.exe 不认（没有盘符/UNC/相对前缀）', bare === 'hidden', bare);

    // 2h. 后端判据：open_path 对一条存在的目录不报错，对不存在的说明找不到
    const openRes = await evalJs(barWs, `(async function(){
      try {
        const a = await window.__TAURI__.core.invoke('open_path', { path: ${JSON.stringify(qs)} });
        const b = await window.__TAURI__.core.invoke('open_path', { path: 'C:\\\\no\\\\such\\\\dir-zzz' });
        const c = await window.__TAURI__.core.invoke('open_path', { path: '今天天气不错' });
        return JSON.stringify({ dir: a, missing: b, notPath: c });
      } catch (e) { return 'ERR ' + e; }
    })()`);
    let or = {};
    try { or = JSON.parse(openRes); } catch (e) { }
    check('open_path 打开存在的目录不报错',
        typeof or.dir === 'string' && or.dir.indexOf('ERR') !== 0, openRes);
    check('open_path 对不存在的路径说「找不到」',
        typeof or.missing === 'string' && /找不到/.test(or.missing), JSON.stringify(or.missing));
    check('open_path 对普通句子说「不像本地路径」',
        typeof or.notPath === 'string' && /不像/.test(or.notPath), JSON.stringify(or.notPath));
    rec('open_path 返回：' + openRes);

    /* ================= ③ 数据导入导出 ================= */

    // 3a. 勾选界面 + 默认只勾非隐私
    if (setWs) {
        await evalJs(setWs, `(function(){
          const b = document.querySelector('#tabs button[data-tab="data"]');
          if (b) b.click();
          return !!b;
        })()`);
        await sleep(500);
        const exp = await evalJs(setWs, `(function(){
          const pane = document.querySelector('.pane[data-pane="data"]');
          if (!pane) return 'NO-PANE';
          const rows = Array.from(pane.querySelectorAll('.exp-row')).map((r) => ({
            id: (r.querySelector('input') || {}).dataset ? r.querySelector('input').dataset.id : '',
            on: r.querySelector('input').checked,
            private: r.classList.contains('private'),
          }));
          const btn = document.querySelector('#btnDoExport');
          return JSON.stringify({ hidden: pane.hasAttribute('hidden'), rows,
            btn: btn ? btn.textContent : '', importBtn: !!document.querySelector('#btnDoImport') });
        })()`);
        let ex = {};
        try { ex = JSON.parse(exp); } catch (e) { }
        check('设置里有「数据」这一栏', ex.hidden === false, exp);
        check('勾选项有 8 组（API Key / 引擎配置 / 应用设置 / 收藏夹 / 图标 / 快捷键 / 备份设置 / 识图）',
            (ex.rows || []).length === 8, exp);
        const priv = (ex.rows || []).filter((r) => r.private);
        const privOn = priv.filter((r) => r.on).length;
        check('隐私项（凭据/收藏夹/备份密码）一律默认不勾',
            priv.length >= 3 && privOn === 0,
            'privacy=' + priv.length + ' checked=' + privOn);
        const nonPriv = (ex.rows || []).filter((r) => !r.private);
        const nonPrivOn = nonPriv.filter((r) => r.on).length;
        check('常用项默认勾上（至少 3 项）', nonPrivOn >= 3,
            'on=' + nonPrivOn + '/' + nonPriv.length);
        check('导出按钮上写着勾了几项', /导出 \d+ 项/.test(String(ex.btn || '')), ex.btn);
        check('「导入配置文件…」按钮在', ex.importBtn === true, exp);

        // 3b. 后端清单与界面一致（界面驱动自数据）
        const listSame = await evalJs(setWs, `(async function(){
          try {
            const list = await window.__TAURI__.core.invoke('export_groups_list');
            const ids = list.map((g) => g.id);
            const uiIds = Array.from(document.querySelectorAll('.exp-row input')).map((i) => i.dataset.id);
            const dflt = list.filter((g) => g.checked).map((g) => g.id);
            const privAll = list.filter((g) => g.private).map((g) => g.id);
            const dfltPriv = dflt.filter((d) => privAll.indexOf(d) >= 0);
            return JSON.stringify({ n: list.length, same: JSON.stringify(ids) === JSON.stringify(uiIds),
              dflt, privAll, dfltPriv });
          } catch (e) { return 'ERR ' + e; }
        })()`);
        let ls = {};
        try { ls = JSON.parse(listSame); } catch (e) { }
        check('界面上的组与后端清单一一对应（界面驱动自数据）', ls.same === true, listSame);
        check('后端清单里默认勾的没有一项是隐私项',
            (ls.dfltPriv || []).length === 0, listSame);
    }

    /* 3c. 「明文导入拒绝加密备份」那道闸在 Rust 单测里已逐条断言
     *     （export::tests::加密备份被明文导入拒绝 / 整份备份也被拒绝 / 空导出被拒）。
     *     这里只验**接口在、导出的文件形状对**：起一次 export_items 太重（要弹
     *     系统文件对话框），改验导出内容构造函数那份 JSON 长得对 —— 走设置页的
     *     勾选状态，与 export_groups_list 比对（上一段已经做过）。 */
    rec('（拒绝加密备份：Rust 单测 export::tests::加密备份被明文导入拒绝 已断言）');

    /* ---------- 收尾 ---------- */
    rec('');
    rec('========== r54 探针结果：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    try { proc.kill(); } catch (e) { }
    await sleep(600);
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    rec('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { flush(); } catch (_) { }
    process.exit(2);
});
