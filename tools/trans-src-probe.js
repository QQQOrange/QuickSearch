/* ============================================================================
 *  翻译窗「原文」文本框三问题 · 真机取证
 *
 *  用户报的三个问题：
 *    1. 文本框缺少圆角边框；
 *    2. 固定尺寸，不能拖拽调宽高；
 *    3. 内容被设成只读，不能直接编辑。
 *
 *  jsdom 只能证明「CSS 写对了」，证不了「真机里生效了」。
 *  这里用隔离实例 + CDP 直连真实 WebView2，读 getComputedStyle 的**实际值**，
 *  并真实地往框里敲字（insertText）看能不能编辑、能不能触发翻译。
 *
 *  用法：node tools/trans-src-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? process.env.QS_E2E_EXE
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9353;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = [];
function rec(s) { L.push(String(s)); console.log(s); }
let FAILED = 0;
function ok(cond, name, extra) {
    if (!cond) FAILED++;
    rec((cond ? 'OK  ' : 'NO  ') + name + (extra ? ' → ' + extra : ''));
}

let msgId = 0;
function cdp(ws, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const timer = setTimeout(() => {
            ws.removeEventListener('message', onMsg);
            reject(new Error('CDP 超时: ' + method));
        }, timeoutMs || 15000);
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}
async function evalJs(ws, expr, timeoutMs) {
    const r = await cdp(ws, 'Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function listTargets() {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return r.json();
}
async function connect(sub, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 30000)) {
        try {
            const ts = await listTargets();
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-transsrc-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const conf = {
        trans_enable: true, trans_engine: 'deepseek', trans_keys: { deepseek: 'sk-probe' },
        bar_list: ['@trans'], bar_idle_sec: 0, bar_away_px: 0, shadow: false, bar_need_text: false,
    };
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(conf, null, 2), 'utf8');

    const env = Object.assign({}, process.env, {
        // ⚠ QS_DATA_DIR 才是**真正**的隔离开关：程序的数据目录「便携优先」，
        //   压根不看 APPDATA（见 src/config.rs 的 data_dir()）。
        //   只设 APPDATA 的话，隔离实例会跟开发目录共用同一份 config/log，
        //   而且那份 config 是**加密**的 —— 探针会莫名其妙地启动失败。
        QS_DATA_DIR: path.join(tmp, 'QuickSearch'),
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_INSTANCE_TAG: '-probe-transsrc', QS_T_WV_ARGS: WV_ARGS, QS_NO_ELEVATE: '1',
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('隔离实例 PID=' + proc.pid);

    let ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上'); try { proc.kill(); } catch (e) { } process.exit(1); }
    await sleep(2000);

    // 打开翻译窗（走 trans_start —— 正是「横条点译」那条路）
    await evalJs(ws, "(function(){ return window.__TAURI__.core.invoke('trans_start', { text: 'Hello 原型' }); })()", 10000)
        .catch((e) => rec('trans_start 异常：' + e.message));
    await sleep(3000);

    ws = await connect('trans.html', 15000);
    if (!ws) { rec('翻译窗没开出来 / CDP 连不上'); try { proc.kill(); } catch (e) { } process.exit(1); }
    rec('翻译窗 CDP 已连上');
    await sleep(1500);

    /* ① 圆角 + 边框 —— 真机 getComputedStyle */
    const r1 = await evalJs(ws, `(function(){
      var s = document.getElementById('src');
      if (!s) return { found:false };
      var cs = getComputedStyle(s);
      var tp = document.querySelector('.tp textarea');
      var csTp = tp ? getComputedStyle(tp) : null;
      return {
        found: true,
        borderRadius: cs.borderRadius,
        borderWidth: cs.borderWidth,
        borderStyle: cs.borderStyle,
        borderColor: cs.borderColor,
        background: cs.backgroundColor,
        tpRadius: csTp ? csTp.borderRadius : null,
        tpBorder: csTp ? csTp.borderWidth + ' ' + csTp.borderStyle : null,
      };
    })()`);
    rec('样式：' + JSON.stringify(r1));
    ok(r1.found, '找到原文框 #src');
    ok(parseFloat(r1.borderRadius) >= 6, '  圆角生效（≥6px）', r1.borderRadius);
    ok(r1.borderStyle === 'solid' && parseFloat(r1.borderWidth) >= 1,
        '  1px 实线边框生效', r1.borderStyle + ' ' + r1.borderWidth);
    ok(r1.tpRadius && r1.borderRadius === r1.tpRadius,
        '  跟译文区圆角一致', r1.borderRadius + ' vs ' + r1.tpRadius);

    /* ② 可拖拽调整宽高 */
    const r2 = await evalJs(ws, `(function(){
      var s = document.getElementById('src');
      var cs = getComputedStyle(s);
      var box = s.getBoundingClientRect();
      var pane = s.parentElement.getBoundingClientRect();
      return { resize: cs.resize, height: cs.height, minHeight: cs.minHeight,
               w: Math.round(box.width), h: Math.round(box.height),
               paneW: Math.round(pane.width), paneH: Math.round(pane.height) };
    })()`);
    rec('尺寸：' + JSON.stringify(r2));
    ok(r2.resize === 'both', '  resize: both（右下角有拖拽把手）', r2.resize);
    ok(parseFloat(r2.height) > 0 && r2.height !== 'auto', '  有明确高度可拖', r2.height);

    // 真拖一次：模拟拖拽把手（改 width/height 后看布局是否同步）
    const r3 = await evalJs(ws, `(function(){
      var s = document.getElementById('src');
      var before = { w: s.offsetWidth, h: s.offsetHeight };
      // 浏览器拖拽把手写的是**行内样式**，这里复现同样的效果
      s.style.height = (s.offsetHeight + 120) + 'px';
      s.style.width  = (s.offsetWidth - 160) + 'px';
      var after = { w: s.offsetWidth, h: s.offsetHeight };
      var pane = s.parentElement.getBoundingClientRect();
      var tps = document.getElementById('tps').getBoundingClientRect();
      return { before: before, after: after,
               paneH: Math.round(pane.height), tpsH: Math.round(tps.height),
               tpsVisible: tps.height > 0 };
    })()`);
    rec('拖拽后：' + JSON.stringify(r3));
    ok(r3.after.h > r3.before.h, '  拖高生效', r3.before.h + ' → ' + r3.after.h);
    ok(r3.after.w < r3.before.w, '  拖窄生效', r3.before.w + ' → ' + r3.after.w);
    ok(r3.paneH > r3.before.h, '  父容器高度跟着长（布局同步）', 'paneH=' + r3.paneH);
    ok(r3.tpsVisible, '  译文区还在（没被挤没）', 'tpsH=' + r3.tpsH);

    /* ③ 可编辑：真实敲字 */
    const r4 = await evalJs(ws, `(function(){
      var s = document.getElementById('src');
      s.focus();
      var cs = getComputedStyle(s);
      return { userSelect: cs.userSelect, webkitUserSelect: cs.webkitUserSelect,
               readOnly: s.readOnly, disabled: s.disabled,
               active: document.activeElement === s,
               value: s.value };
    })()`);
    rec('编辑态：' + JSON.stringify(r4));
    ok(r4.readOnly === false && r4.disabled === false, '  不是只读', JSON.stringify(r4));
    ok(r4.userSelect === 'text' || r4.webkitUserSelect === 'text',
        '  user-select: text（能选中）', r4.userSelect + ' / ' + r4.webkitUserSelect);
    ok(r4.active, '  能拿到焦点');

    // 真的往里敲字（CDP Input.insertText 走真实的输入管道）
    await evalJs(ws, "(function(){ var s=document.getElementById('src'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); return true; })()");
    await cdp(ws, 'Input.insertText', { text: '——我改的字' }, 8000).catch((e) => rec('insertText 失败: ' + e.message));
    await sleep(400);
    const r5 = await evalJs(ws, "(function(){ var s=document.getElementById('src'); return { value: s.value, len: s.value.length }; })()");
    rec('敲字后：' + JSON.stringify(r5));
    ok(r5.value.indexOf('我改的字') >= 0, '  文字真的敲进去了（不是只读）', r5.value);

    /* ④ 编辑后能触发翻译流程
     *    注意：页面里 `const invoke = window.__TAURI__.core.invoke` 是**加载时
     *    捕获**的引用（trans.html:366），事后替换 core.invoke 拦不到它。
     *    所以这里不去 monkey-patch，而是从**后端**看：翻译请求会带着原文
     *    发出去，页面上「译文区」也会多出内容 —— 用这两个可观测量来证。 */
    const r6 = await evalJs(ws, `(function(){
      var before = document.querySelectorAll('.tp textarea').length;
      var s = document.getElementById('src');
      var val = s.value;
      document.getElementById('btnGo').click();
      // 等 2 秒，看译文区有没有被填（说明确实发起了翻译）
      return new Promise(function(res){
        setTimeout(function(){
          var tas = document.querySelectorAll('.tp textarea');
          var filled = 0;
          for (var i=0;i<tas.length;i++){ if (tas[i].value && tas[i].value.trim()) filled++; }
          var note = document.getElementById('note');
          res({ before: before, after: tas.length, filled: filled,
                busyDisabled: document.getElementById('btnGo').disabled,
                // 探针用的是假 key，翻译**会失败** —— 但失败也证明流程跑完了
                // （runAll → trans_run → 出错 → showNote 写原因 → setBusy(false)）。
                note: note ? (note.textContent || '').trim() : '',
                noteShown: note ? !note.hidden : false,
                srcValue: val });
        }, 2000);
      });
    })()`, 12000);
    rec('翻译调用：' + JSON.stringify(r6));
    ok(r6.after >= 1, '  点「翻译」后译文区有框', 'count=' + r6.after);
    ok(r6.filled >= 1 || r6.busyDisabled || r6.noteShown,
        '  翻译流程真的跑起来了（译文有内容 / 进入忙碌态 / 失败也写下了原因）',
        'filled=' + r6.filled + ' busy=' + r6.busyDisabled + ' note=' + JSON.stringify(r6.note));
    // 编辑后的内容确实被取走了：runAll() 读的是 $('src').value 的**此刻**值
    const r6b = await evalJs(ws, `(function(){
      var s = document.getElementById('src');
      return { value: s.value, hasEdit: s.value.indexOf('我改的字') >= 0 };
    })()`);
    rec('编辑后框里的内容：' + JSON.stringify(r6b));
    ok(r6b.hasEdit, '  框里保留着用户编辑后的文字（翻译取的是这个）', r6b.value);

    /* ⑤ 译文区交互没被破坏 */
    const r7 = await evalJs(ws, `(function(){
      var tas = document.querySelectorAll('.tp textarea');
      if (!tas.length) return { count:0 };
      var cs = getComputedStyle(tas[0]);
      return { count: tas.length, resize: cs.resize, userSelect: cs.userSelect,
               hasActive: !!document.querySelector('.tp.tp-active') };
    })()`);
    rec('译文区：' + JSON.stringify(r7));
    ok(r7.count >= 1, '  译文框还在', 'count=' + r7.count);
    ok(r7.resize === 'none', '  译文框仍是 resize:none（没被我改坏）', r7.resize);
    ok(r7.userSelect === 'text', '  译文框仍可选中', r7.userSelect);

    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    fs.writeFileSync(path.join(__dirname, 'trans-src-probe.txt'), L.join('\n'), 'utf8');
    rec(FAILED ? ('\n❌ 有 ' + FAILED + ' 项失败') : '\n✅ 全部通过');
    process.exit(FAILED ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    fs.writeFileSync(path.join(__dirname, 'trans-src-probe.txt'), L.join('\n'), 'utf8');
    process.exit(1);
});
