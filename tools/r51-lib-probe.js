/* ============================================================================
 *  r51 引擎库分类 / 小目录 / 速度（r51-lib-probe.js）
 *
 *  量四件事，都对应你说的原话：
 *    ① 设置页的引擎库有没有按用途分类、小目录能不能跳（「点目录就能快速到达」）
 *    ② 横条「更多引擎」面板那侧的分类锚点是不是同一套（「不管横条还是设置页都要有」）
 *    ③ 读引擎库（data/engines.json）要多久 —— 700 多个引擎，这份 JSON 有 209 KB
 *    ④ 点「更多引擎」到面板里真的出现引擎格子，中间要多少毫秒
 *
 *  用法：node r51-lib-probe.js     输出：r51-lib-probe.txt
 *  ⚠ 自带身份（QS_INSTANCE_TAG + 独立 WebView2 目录），不杀任何别人的进程。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r51-lib-probe.txt');
const PORT = 9345;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); };
const flush = () => fs.writeFileSync(OUT, L.join('\n'), 'utf8');
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra ? '   [' + extra + ']' : '')); }
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

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-lib-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    {
        const c = JSON.parse(fs.readFileSync(
            path.join(process.env.APPDATA, 'QuickSearch', 'config.json'), 'utf8'));
        c.webdav_url = ''; c.webdav_user = ''; c.webdav_pass = ''; c.webdav_auto = false;
        fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(c, null, 1), 'utf8');
    }
    const TAG = 'lib' + Date.now().toString(36);
    const env = Object.assign({}, process.env, {
        APPDATA: tmp,
        QS_DEBUG: '1', QS_ALLOW_INJECTED: '1', QS_T_WV_ARGS: WV_ARGS,
        QS_INSTANCE_TAG: TAG,
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
    });
    const proc = spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('r51 探针：启动 pid=' + proc.pid);
    sleep(9000);

    const barWs = await connect('tauri.localhost/');
    if (!barWs) { rec('横条 CDP 连不上'); proc.kill(); flush(); process.exit(1); }

    /* ---------- ③ 读引擎库要多久（同一份 data/engines.json，两边窗口都读它） ---------- */
    const t = await evalJs(barWs, `(async function(){
      const t0 = performance.now();
      const txt = await fetch('data/engines.json').then((r) => r.text());
      const t1 = performance.now();
      const j = JSON.parse(txt);
      const t2 = performance.now();
      let n = 0;
      for (const c of j.categories) n += (c.engines || []).length;
      return JSON.stringify({ bytes: txt.length, fetchMs: +(t1 - t0).toFixed(1),
        parseMs: +(t2 - t1).toFixed(1), categories: j.categories.length, engines: n });
    })()`);
    rec('读引擎库：' + t);

    /* ---------- ④ 点「更多引擎」→ 面板里出现引擎格子，多少毫秒 ---------- */
    const openMs = await evalJs(barWs, `(async function(){
      const more = document.getElementById('btnMore');
      if (!more) return 'NO-BTN';
      const t0 = performance.now();
      more.click();
      for (let i = 0; i < 400; i++) {
        if (document.querySelectorAll('#panelBody .engine').length > 0) {
          // 再等一帧，确保是真的排完版了
          await new Promise((r) => requestAnimationFrame(() => r()));
          return Math.round(performance.now() - t0);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return -1;
    })()`);
    rec('点「更多引擎」→ 面板出现引擎格子：' + openMs + ' ms');

    /* ---------- ④b 这 100ms 花在哪：DOM / IPC+摆窗 / 合成上屏 ---------- */
    // ⚠ 等一会儿再读：painted 是"再过两帧"才写的，而上面那个轮询现在（第一节课格子
    //   改成同步建之后）会**早于**这两帧就成功 —— 不等就是把"还没写"当成 0。
    sleep(300);
    const timing = await evalJs(barWs, 'JSON.stringify(window.__qsPanelTiming || {})');
    rec('面板开合四段计时（ms）：' + timing);
    {
        let T = {};
        try { T = JSON.parse(timing); } catch (e) { T = {}; }
        check('④ 面板开合计时到位（built / painted 有数；摆窗 0 表示这次不用改窗口尺寸）',
            T.t0 > 0 && T.built > 0 && T.painted > 0, String(timing));
        if (T.built > 0 && T.painted > 0) {
            rec('    → 建 DOM ' + T.built + 'ms / 摆窗往返 ' + (T.layoutDone - T.layoutSent)
                + 'ms / 摆完到上屏 ' + (T.painted - T.layoutDone) + 'ms');
        }
    }
    /* 懒建的两面：打开时只建了前几节，滚到底之后才全建 —— 两面都得看 */
    const cells = await evalJs(barWs, `(async function(){
      const body = document.getElementById('panelBody');
      const first = body.querySelectorAll('.engine').length;
      for (let i = 1; i <= 14; i++) { body.scrollTop = Math.round(body.scrollHeight * i / 14); await new Promise((r) => setTimeout(r, 110)); }
      await new Promise((r) => setTimeout(r, 500));
      const all = body.querySelectorAll('.engine').length;
      const grids = body.querySelectorAll('.grid').length;
      const filled = body.querySelectorAll('.grid[data-filled="1"]').length;
      body.scrollTop = 0;
      return JSON.stringify({ first: first, afterScroll: all, grids: grids, filled: filled });
    })()`);
    rec('面板格子懒建：' + cells);
    {
        let C = {};
        try { C = JSON.parse(cells); } catch (e) { C = {}; }
        check('④ 打开瞬间只建了看得见的几节（不是 778 个全建）',
            C.first > 0 && C.first < 700, '打开时 ' + C.first + ' 个（一共 778）');
        check('④ 滚到底之后格子都建出来了（懒建没漏内容）',
            C.afterScroll > 300 && C.filled === C.grids,
            C.afterScroll + ' 个 / ' + C.filled + ' 节已填，共 ' + C.grids + ' 节');
    }

    /* ---------- ② 横条面板那侧的分类锚点 ---------- */
    const nav = await evalJs(barWs, `JSON.stringify({
      navChips: document.querySelectorAll('#panelBody [data-cat]').length,
      allChips: document.querySelectorAll('[data-cat]').length,
      sticky: !!document.querySelector('.panel-sticky'),
      engines: document.querySelectorAll('#panelBody .engine').length,
      groups: document.querySelectorAll('#panelBody .panel-sec, #panelBody .eng-sec, #panelBody .cat').length,
    })`);
    rec('横条面板那一侧：' + nav);
    const N = JSON.parse(nav);
    check('② 横条「更多引擎」面板一级目录（大类胶囊）在，且有吸附头', N.allChips > 1 || N.navChips > 1,
        'data-cat 按钮 = ' + N.allChips);
    check('④ 点开「更多引擎」到出现引擎格子 < 400ms',
        typeof openMs === 'number' && openMs >= 0 && openMs < 400, openMs + ' ms');

    /* ---------- ② 面板里点目录能不能"快速到达"（滚动定位） ---------- */
    const jump = await evalJs(barWs, `(async function(){
      const body = document.getElementById('panelBody');
      if (!body) return 'NO-BODY';
      const chips = Array.from(document.querySelectorAll('[data-cat]'))
        .filter((el) => el.closest('.panel-sticky, .cat-nav'));
      if (chips.length < 2) return 'NO-CHIPS(' + chips.length + ')';
      const target = chips[chips.length - 1];
      const key = target.dataset.cat;
      const before = body.scrollTop;
      const t0 = performance.now();
      target.click();
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => requestAnimationFrame(() => r()));
        if (Math.abs(body.scrollTop - before) > 4) break;
      }
      const ms = Math.round(performance.now() - t0);
      return JSON.stringify({ chips: chips.length, key: key,
        before: Math.round(before), after: Math.round(body.scrollTop), ms: ms });
    })()`);
    rec('横条面板里点分类锚点：' + jump);
    let J = {};
    try { J = JSON.parse(jump); } catch (e) { J = {}; }
    /* r52 的中类锚点在 r53 换成了「胶囊过滤」——这条不再假装还有锚点跳转，
       改成如实断言一级目录（大类）仍然是平铺胶囊，二级/三级默认收起由 ③ 覆盖。 */
    {
        const grpN = await evalJs(barWs, "document.querySelectorAll('.grp-nav .grp-item').length");
        const midN = await evalJs(barWs, "document.querySelectorAll('.cat-nav:not(.grp-nav):not(.fav-nav) .cat-nav-item').length");
        check('② 面板一级目录 = 大类胶囊（≥ 4 个：全部 + 网页/软件/快捷键引擎）',
            grpN >= 4, grpN + ' 个一级胶囊；老的中类锚点现在有 ' + midN + ' 个（应为 0）');
    }

    /* ---------- ③ 面板里也要三层（中类 / 小类）+ 目录不遮内容（r52） ---------- */
    const psub = await evalJs(barWs, `(function(){
      const body = document.getElementById('panelBody');
      const head = document.querySelector('.panel-sticky');
      return JSON.stringify({
        midHeads: body.querySelectorAll('.cat-title').length,
        subHeads: body.querySelectorAll('.cat-sub').length,
        subChips: document.querySelectorAll('.sub-nav .sub-item').length,
        pick2: document.querySelectorAll('#panelPick2 .cat-chip').length,
        pick3: document.querySelectorAll('#panelPick3 .cat-chip').length,
        headH: head ? head.offsetHeight : 0,
      });
    })()`);
    rec('面板三层：' + psub);
    {
        const P = JSON.parse(psub);
        check('③ 面板里也分了小类（AI 工具 / 知识 / 开发 / 购物…）',
            P.subHeads >= 5, P.subHeads + ' 个小类标题');
        check('③ 面板的二级/三级目录默认收起（打开只留一级大类）',
            P.subChips === 0 && P.pick2 === 0 && P.pick3 === 0,
            '小类平铺 ' + P.subChips + ' / pick2 ' + P.pick2 + ' / pick3 ' + P.pick3);
    }
    const pflow = await evalJs(barWs, `(async function(){
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const body = document.getElementById('panelBody');
      const head = document.querySelector('.panel-sticky');
      const out = {};
      window.__qsErr = null;
      window.addEventListener('error', (e) => { window.__qsErr = String(e.message) + ' @' + e.lineno; });
      try { renderPanel(); out.err = window.__qsErr || null; }
      catch (e) { out.err = 'renderPanel threw: ' + e; }
      out.afterManual = body.querySelectorAll('.cat-title').length;
      const g1 = Array.from(document.querySelectorAll('.grp-nav .grp-item'))
        .find((b) => b.textContent.indexOf('网页引擎') === 0);
      if (!g1) return 'NO-GRP1';
      g1.click();
      await sleep(500);
      // r75：二级也改成平铺胶囊（原来是一个下拉胶囊 + 菜单）
      out.pick2 = document.querySelectorAll('#panelPick2 .cat-chip').length;
      out.pick2Chips = document.querySelectorAll('#panelPick2 .cat-nav-item').length;
      out.pick2Texts = Array.from(document.querySelectorAll('#panelPick2 .cat-chip'))
        .map((b) => b.textContent);
      out.headH = head ? head.offsetHeight : 0;
      out.secsAfterGrp = body.querySelectorAll('.cat-title').length;
      out.pick3Before = document.querySelectorAll('#panelPick3 .cat-chip').length;
      const it = document.querySelectorAll('#panelPick2 .cat-chip')[1] || null;
      if (it) it.click();
      await sleep(500);
      out.secsAfterSub = body.querySelectorAll('.cat-title').length;
      out.pick3 = document.querySelectorAll('#panelPick3 .cat-chip').length;
      const i3 = document.querySelectorAll('#panelPick3 .cat-chip')[1] || null;
      if (i3) {
        out.pick3Text = i3.textContent;
        i3.click();
        await sleep(500);
        out.subsVisible = [...document.querySelectorAll('#panelBody .cat-sub')].filter((s) => !s.hidden).length;
        out.subsHidden = [...document.querySelectorAll('#panelBody .cat-sub')].filter((s) => s.hidden).length;
      }
      const t = body.querySelector('.cat-title');
      const head2 = document.querySelector('.panel-sticky');   // 每轮渲染都会重建，得重新抓
      out.headH = head2 ? head2.offsetHeight : 0;
      const hb = head2 ? head2.getBoundingClientRect().bottom : 0;
      out.firstTop = t ? Math.round(t.getBoundingClientRect().top) : null;
      out.headBottom = Math.round(hb);
      out.covered = t ? t.getBoundingClientRect().top < hb - 1 : null;
      out.err2 = window.__qsErr || null;                      // 点选过程中冒出来的异常
      out.bodySame = (document.getElementById('panelBody') === body);
      out.liveBody = !!document.getElementById('panelBody');
      out.liveSticky = document.querySelectorAll('.panel-sticky').length;
      return JSON.stringify(out);
    })()`);
    rec('面板渐进式胶囊：' + pflow);
    {
        let F3 = {};
        try { F3 = JSON.parse(pflow); } catch (e) { F3 = {}; }
        // r75：二级从下拉改成平铺胶囊 —— 点一级之后露出「全部中类 + 每个中类一颗」
        check('③ 面板：点一级之后二级胶囊才出现（r75：平铺一排 ≥ 3 颗）',
            F3.pick2 >= 3 && F3.pick2Chips === F3.pick2 && F3.pick3Before === 0,
            String(pflow));
        check('③ 面板：点一颗中类 → 只剩这一个（三级此时才展开）',
            F3.secsAfterSub === 1 && F3.pick3 >= 2, String(pflow));
        check('③ 面板：目录不遮内容（第一个分类标题在吸附头下沿之下）',
            F3.covered === false, String(pflow));
        check('③ 面板：三级胶囊里选一个小类 → 只剩这一个小类',
            F3.subsVisible === 1, String(pflow));
    }

    /* ---------- 进设置页，查引擎库 ---------- */
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(500);
    await evalJs(barWs, "document.getElementById('btnMore').click()");
    sleep(400);
    const setOk = await evalJs(barWs, `(function(){
      const m = document.getElementById('btnMore');
      if (m) m.click();
      return 1;
    })()`);
    sleep(700);
    await evalJs(barWs, "document.getElementById('btnSettings') && document.getElementById('btnSettings').click()");
    sleep(3500);
    const setWs = await connect('settings.html', 8000);
    if (!setWs) {
        rec('设置页 CDP 连不上（可能没开出来），引擎库那几条跳过');
    } else {
        rec('设置页连上了');
        const tab = await evalJs(setWs,
            "(function(){const t=document.querySelector('[data-tab=\"engines\"]'); if(!t) return 0; t.click(); return 1;})()");
        sleep(700);
        rec('切到引擎页：' + tab);
        const lib = await evalJs(setWs, `(function(){
          // r61：引擎库和「全部引擎」合并了 —— libToc/libBody 已删，
          // 列表容器变成 allGrpNav/allList。探针跟着落到合并后的 DOM 上。
          const toc = document.getElementById('libToc') || document.getElementById('allGrpNav');
          const body = document.getElementById('libBody') || document.getElementById('allList');
          if (!toc || !body) return 'NO-LIB';
          const secs = body.querySelectorAll('.lib-sec, .eng-grp');
          const chips = toc.querySelectorAll('.lib-chip, .eng-nav-item');
          let tiles = 0;
          for (const g of body.querySelectorAll('.lib-grid, .eng-grp')) tiles += (g.classList.contains('eng-grp') ? g.querySelectorAll('.eng-row').length : g.children.length);
          const firstSec = secs[0];
          const r0 = firstSec ? firstSec.getBoundingClientRect().top : 0;
          // 点第 5 个目录 → 那一节应该滚到跟前（首节 top 会变成负数）
          const target = chips[4];
          if (target) target.click();
          return JSON.stringify({
            secs: secs.length, chips: chips.length, tilesBuilt: tiles,
            firstTopBefore: Math.round(r0),
            titles: Array.from(chips).slice(0, 6).map((c) => c.textContent),
          });
        })()`);
        rec('引擎库（点目录之前）：' + lib);
        sleep(1200);
        const after = await evalJs(setWs, `(function(){
          const body = document.getElementById('libBody') || document.getElementById('allList');
          const secs = body.querySelectorAll('.lib-sec');
          let tiles = 0;
          for (const g of body.querySelectorAll('.lib-grid, .eng-grp')) tiles += (g.classList.contains('eng-grp') ? g.querySelectorAll('.eng-row').length : g.children.length);
          // 图标有没有真的加载上（路径写错了就静默没图 —— 只有 naturalWidth 能戳破）
          let imgs = 0, loaded = 0, bad = 0;
          for (const im of body.querySelectorAll('.lib-tile img')) {
            imgs++;
            if (im.naturalWidth > 0) loaded++;
            else if (im.complete) bad++;
          }
          return JSON.stringify({ firstTopAfter: Math.round(secs[0].getBoundingClientRect().top),
            tilesBuilt: tiles, imgs: imgs, loaded: loaded, bad: bad,
            scrollTop: Math.round(document.querySelector('.pane:not([hidden])') ?
              (document.querySelector('.pane:not([hidden])').scrollTop || 0) : 0) });
        })()`);
        rec('引擎库（点目录之后）：' + after);
        if (String(lib).indexOf('NO-LIB') !== 0 && String(lib).indexOf('ERR') !== 0) {
            const B = JSON.parse(lib), A = JSON.parse(after);
            /* r52：改成三层结构了，断言跟着事实改 —— 旧断言按"27 个平铺分类"
             * 写死，现在第一层是大类、第二层是中类、第三层才是那 27 个小类。 */
            const three = await evalJs(setWs, `(function(){
              const toc = document.getElementById('libToc');
              const body = document.getElementById('libBody') || document.getElementById('allList');
              const lv = (id) => { const r = document.getElementById(id);
                return r ? r.querySelectorAll('.lib-chip').length : 0; };
              const txt = (id, n) => { const r = document.getElementById(id);
                return r ? Array.from(r.querySelectorAll('.lib-chip')).slice(0, n)
                  .map((c) => c.textContent.replace(/[0-9]+/g, '').trim()) : []; };
              return JSON.stringify({ nav1: lv('libNav1'), nav2: lv('libNav2'), nav3: lv('libNav3'),
                nav1Text: txt('libNav1', 5), nav2Text: txt('libNav2', 8),
                secs: body.querySelectorAll('.lib-sec').length,
                subs: body.querySelectorAll('.lib-sub').length,
                navH: toc.offsetHeight });
            })()`);
            rec('引擎库三层目录：' + three);
            const T2 = JSON.parse(three);
            check('① 第一层 = 大类（全部 + 网页/软件/快捷键引擎）',
                T2.nav1 === 4 && T2.nav1Text.some((s) => s.indexOf('网页引擎') === 0),
                T2.nav1 + ' 个：' + T2.nav1Text.join(' / '));
            check('① 二级/三级目录默认隐藏（用户要求：开面板只显示一级）',
                T2.nav2 === 0 && T2.nav3 === 0,
                'libNav2 里的胶囊 ' + T2.nav2 + ' 个 / libNav3 里的胶囊 ' + T2.nav3 + ' 个');
            check('① 正文按中类分节、节里再分小类', T2.secs >= 3 && T2.subs >= 10,
                T2.secs + ' 节 / ' + T2.subs + ' 个小类');
            check('性能：引擎库不是一次性全建（懒建）',
                B.tilesBuilt < 700, '首屏已建 ' + B.tilesBuilt + ' 个格子');
            check('① 引擎库的图标真的加载上了（data/icons/ 路径）',
                A.imgs === 0 || (A.loaded > 0 && A.loaded >= A.imgs * 0.8),
                'img ' + A.loaded + '/' + A.imgs + '，complete 但没图 ' + A.bad);
            /* ★ r53：一级 →（点它）二级胶囊 →（点开选）三级胶囊，选哪层就只剩哪层 */
            const flow = await evalJs(setWs, `(async function(){
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const toc = document.getElementById('libToc');
              const body = document.getElementById('libBody') || document.getElementById('allList');
              const out = {};
              out.nav2Before = !!document.getElementById('libNav2');
              const g1 = Array.from(document.querySelectorAll('#libNav1 .lib-chip'))
                .find((c) => c.textContent.indexOf('网页引擎') === 0);
              if (!g1) return 'NO-GRP1';
              g1.click();
              await sleep(400);
              out.nav2 = !!document.getElementById('libNav2');
              out.nav2Picks = document.querySelectorAll('#libNav2 .qs-pick').length;
              out.nav2Chips = document.querySelectorAll('#libNav2 .lib-chip').length;
              out.nav3AfterGrp = !!document.getElementById('libNav3');
              out.secsAfterGrp = body.querySelectorAll('.lib-sec').length;
              const pick2 = document.querySelector('#libNav2 .qs-pick');
              if (!pick2) return JSON.stringify(out);
              pick2.click();
              await sleep(200);
              const menu2 = document.querySelector('#libNav2 .qs-pick-menu');
              out.menuOpen = !!menu2 && !menu2.hidden;
              out.menuItems = menu2 ? menu2.querySelectorAll('.qs-pick-item').length : 0;
              out.pickText = menu2 ? (menu2.querySelectorAll('.qs-pick-item')[1] || {}).textContent : '';
              const item2 = menu2 ? menu2.querySelectorAll('.qs-pick-item')[1] : null;
              if (item2) item2.click();
              await sleep(400);
              out.secsAfterSub = body.querySelectorAll('.lib-sec').length;
              out.subsAfterSub = body.querySelectorAll('.lib-sub').length;
              out.nav3 = !!document.getElementById('libNav3');
              out.nav3Picks = document.querySelectorAll('#libNav3 .qs-pick').length;
              const p3 = document.querySelector('#libNav3 .qs-pick');
              if (p3) {
                p3.click();
                await sleep(220);
                const m3 = document.querySelector('#libNav3 .qs-pick-menu');
                out.menu3Open = !!m3 && !m3.hidden;
                out.menu3Items = m3 ? m3.querySelectorAll('.qs-pick-item').length : 0;
                const i3 = m3 ? m3.querySelectorAll('.qs-pick-item')[1] : null;
                out.pick3Text = i3 ? i3.textContent : '';
                if (i3) i3.click();
                await sleep(450);
                out.subsAfterCat = body.querySelectorAll('.lib-sub').length;
                out.secsAfterCat = body.querySelectorAll('.lib-sec').length;
              }
              const firstSub = body.querySelector('.lib-sub');
              const navBottom = toc.getBoundingClientRect().bottom;
              out.firstTop = firstSub ? Math.round(firstSub.getBoundingClientRect().top) : null;
              out.covered = firstSub ? firstSub.getBoundingClientRect().top < navBottom - 1 : null;
              return JSON.stringify(out);
            })()`);
            rec('引擎库渐进式胶囊：' + flow);
            let F2 = {};
            try { F2 = JSON.parse(flow); } catch (e) { F2 = {}; }
            check('① 点一级之后二级胶囊才出现（一个胶囊，不是一排）',
                F2.nav2Before === false && F2.nav2 === true && F2.nav2Picks === 1
                    && F2.nav2Chips === 0,
                String(flow));
            check('① 点胶囊会展开列表（选哪个显示哪个）',
                F2.menuOpen === true && F2.menuItems >= 2, String(flow));
            check('① 选了二级 → 内容只剩这一个中类，且三级胶囊出现',
                F2.secsAfterSub === 1 && F2.nav3 === true && F2.nav3Picks === 1, String(flow));
            check('① 目录不遮内容（内容顶边在目录下沿之下）',
                F2.covered === false, String(flow));
            check('① 三级胶囊里选一个小类 → 正文只剩这一个小类（选哪个显示哪个）',
                F2.menu3Open === true && F2.subsAfterCat === 1, String(flow));
        } else {
            check('① 引擎库卡片渲染出来了', false, String(lib));
        }
    }

    /* ---------- ⑤ 打开网页那条路：先收横条，再让浏览器在后台起来 ----------
     * 这一段**只能做源码级断言**：真要量 ShellExecuteW 的毫秒数就得真开浏览器窗口，
     * 探针不该在你桌面上弹标签页。机制（阻塞 → 后台线程）由源码顺序钉住，
     * 真实耗时改完会由应用自己每次搜完写进 log.txt：`⏱ open_search: … 进命令 → 收起横条`。 */
    {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8');
        const i = src.indexOf('fn open_search(');
        const j = src.indexOf('\nfn ', i + 10);
        const body = src.slice(i, j > 0 ? j : i + 6000);
        // 先把注释剥掉再找 —— 注释里写了 "open::that() 会阻塞" 这句，
        // 不剥的话会把自己的说明文字当成调用（第一次跑就是这么误报的）。
        const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        const iDis = clean.indexOf('dismiss_bar();');
        const iOpen = clean.indexOf('open::that_detached(');
        const iOld = clean.indexOf('open::that(');
        rec('open_search：dismiss_bar@' + iDis + '  that_detached@' + iOpen
            + '  老的阻塞 that@' + iOld);
        check('⑤ open_search 先收横条、再让浏览器起来（dismiss_bar 在 that_detached 之前）',
            iDis > 0 && iOpen > 0 && iDis < iOpen, iDis + ' vs ' + iOpen);
        check('⑤ 打开网页不再走会阻塞的 open::that()', iOld < 0, 'open::that( 还在第 ' + iOld + ' 个字符');
    }

    /* ---------- ⑤b Rust 那一侧的摆位耗时（面板开合那一次） ---------- */
    try {
        const lg = fs.readFileSync(path.join(qs, 'log.txt'), 'utf8').split('\n');
        const hits = lg.filter((s) => s.indexOf('⏱ layout_bar 摆位') >= 0
            || s.indexOf('glass: 窗口矩形变了') >= 0 || s.indexOf('glass: 已抓背景') >= 0);
        rec('Rust 侧摆位/玻璃日志（最后 4 条）：');
        for (const h of hits.slice(-4)) rec('    ' + h.trim().slice(0, 160));
        rec('    （全部 ' + hits.length + ' 条）');
    } catch (e) { rec('读 log.txt 失败：' + e.message); }

    rec('');
    rec('========== 汇总：PASS ' + pass + ' / FAIL ' + fail + ' ==========');
    flush();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    try { proc.kill(); } catch (e) { }
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    flush();
    process.exit(1);
});
