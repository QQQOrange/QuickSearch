/* ============================================================================
 *  OCR 结果窗的 CDP 读取 / 点击（并行 e2e 用，由 run-ocr-parallel-e2e.py 驱动）
 *
 *  为什么走 CDP：QuickSearch 的窗口是 WebView2（Chromium）。应用启动时带了
 *  QS_T_WV_ARGS="... --remote-debugging-port=9333"（e2e 专用，正常启动不带），
 *  于是可以用 DevTools 协议直接读页面状态 / 点按钮 ——
 *    · 比按坐标点按钮确定得多（按钮宽度随字体/DPI 变，坐标点容易点到隔壁）；
 *    · 比 UIA 可靠（WebView2 的无障碍树个别环境不开，CDP 一定在）；
 *    · 顺便能把【本地识别】/【百度云】标注到底显没显示读出来，有客观答案。
 *
 *  用法：
 *    node ocr-cdp-check.js <outFile> [--click <元素id>] [--after-ms <毫秒>]
 *
 *  输出（outFile，UTF-8）：
 *    WINDOW <页面 title 或 NONE>
 *    TEXT_LEN / TEXT_HAS_LOCAL / TEXT_HAS_BAIDU / TEXT_LOCAL_BEFORE_BAIDU
 *    SEG_HIDDEN        （并行模式下结果页的引擎段控该藏着）
 *    NOTE_HIDDEN / NOTE_TEXT   （提示条：比如「还没配百度密钥」）
 *    TEXT <<< ... >>>          （文本框实际展示的文字）
 *    BUTTON <id> FOUND|MISSING / BUTTON_CLICKED 0|1
 *    TEXT_AFTER_LEN / TEXT_AFTER <<< ... >>>   （点了按钮、等了之后重读）
 * ========================================================================== */
const fs = require('fs');

const PORT = 9333;
const argv = process.argv.slice(2);
const outPath = argv[0];
let clickId = '';
let afterMs = 0;
for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--click') clickId = argv[++i] || '';
    if (argv[i] === '--after-ms') afterMs = parseInt(argv[++i] || '0', 10) || 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return r.json();
}

async function findOcrTarget() {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
        try {
            const ts = await listTargets();
            const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf('ocr.html') >= 0);
            if (hit) return hit;
        } catch (e) { /* 端口还没起来，接着等 */ }
        await sleep(300);
    }
    return null;
}

let msgId = 0;
function cdp(ws, method, params) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        const onMsg = (ev) => {
            let m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id !== id) return;
            ws.removeEventListener('message', onMsg);
            ws.removeEventListener('error', onErr);
            if (m.error) reject(new Error(method + ': ' + m.error.message));
            else resolve(m.result);
        };
        const onErr = (e) => {
            ws.removeEventListener('message', onMsg);
            ws.removeEventListener('error', onErr);
            reject(new Error(method + ' ws error: ' + (e && e.message || e)));
        };
        ws.addEventListener('message', onMsg);
        ws.addEventListener('error', onErr);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}

async function evalJs(ws, expr) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
        throw new Error('JS 抛异常：' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    }
    return r.result.value;
}

/** 读一整套页面状态 */
/* 并行模式下结果是**两个框**（本地 / 百度），各带一条不可编辑的来源标题。
 * 这里把「当前可见的那几个框」的文本拼起来当作 text，并据此给 has_local/has_baidu
 * —— 正好能直接验「三档切换控制显示哪个框」。 */
const SNAP_DUAL = `(function(){
  const q=(id)=>document.getElementById(id);
  const dual=q('dual');
  const on = !!(dual && !dual.hidden);
  const vis=(id)=>{const el=q(id); return !!(el && !el.classList.contains('hide'));};
  if(!on) {
    const t=(q('text')||{}).value || '';
    return {text:t, hasLocal: t.indexOf('【本地识别】')>=0, hasBaidu: t.indexOf('【百度云】')>=0, dual:0};
  }
  const l=vis('dualLocal'), b=vis('dualBaidu');
  const lt=(q('textLocal')||{}).value||'', bt=(q('textBaidu')||{}).value||'';
  return {text:(l?lt:'')+'\n'+(b?bt:''), hasLocal:l?1:0, hasBaidu:b?1:0, dual:1};
})()`;

async function snapshot(ws) {
    const [title, text, segHidden, noteHidden, noteText, showSegVisible, showModeOn] =
        await Promise.all([
            evalJs(ws, 'document.title'),
            evalJs(ws, SNAP_DUAL).then((r) => r.text),
            evalJs(ws, "!!(document.getElementById('ocrEngineSeg')||{}).hidden"),
            evalJs(ws, "!!(document.getElementById('note')||{}).hidden"),
            evalJs(ws, "(document.getElementById('note')||{}).textContent || ''"),
            // 并行模式专有的三档「仅本地/仅百度/两者都看」
            evalJs(ws, "(function(){const s=document.getElementById('ocrShowSeg');"
                + "return !!(s && !s.hidden);})()"),
            evalJs(ws, "(function(){const b=document.querySelector('#ocrShowSeg button.on');"
                + "return b ? b.dataset.m : 'NONE';})()"),
        ]);
    return { title, text, segHidden, noteHidden, noteText, showSegVisible, showModeOn };
}

function emit(d) {
    const L = [];
    L.push('WINDOW ' + (d.window || 'NONE'));
    L.push('TEXT_LEN ' + (d.text || '').length);
    L.push('TEXT_HAS_LOCAL ' + (d.text.indexOf('【本地识别】') >= 0 ? 1 : 0));
    L.push('TEXT_HAS_BAIDU ' + (d.text.indexOf('【百度云】') >= 0 ? 1 : 0));
    const li = d.text.indexOf('【本地识别】'), bi = d.text.indexOf('【百度云】');
    L.push('TEXT_LOCAL_BEFORE_BAIDU ' + (li >= 0 && bi >= 0 && li < bi ? 1 : 0));
    L.push('SEG_HIDDEN ' + (d.segHidden ? 1 : 0));
    L.push('NOTE_HIDDEN ' + (d.noteHidden ? 1 : 0));
    L.push('SHOWSEG_VISIBLE ' + (d.showSegVisible ? 1 : 0));
    L.push('SHOWMODE_ON ' + (d.showModeOn || 'NONE'));
    L.push('NOTE_TEXT <<<');
    L.push(d.noteText || '');
    L.push('>>>');
    L.push('TEXT <<<');
    L.push(d.text || '');
    L.push('>>>');
    return L;
}

(async function main() {
    const target = await findOcrTarget();
    if (!target) {
        fs.writeFileSync(outPath, 'WINDOW NONE\nTEXT_LEN 0\n', 'utf8');
        console.log('NO 没找到 ocr.html 的调试目标');
        process.exit(0);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', (e) => reject(new Error('ws 连不上：' + (e.message || e))), { once: true });
    });

    const out = [];
    const s1 = await snapshot(ws);
    s1.window = s1.title;
    out.push(...emit(s1));

    if (clickId) {
        // 先挂一个自己的监听，把后端推来的 payload 原样记一份 ——
        // 用来区分「后端压根没给 note」和「给了但前端没显示出来」。
        // （重编译一次要一分多钟，这个钩子能直接看到 payload 字段。）
        const hooked = await evalJs(ws, "(function(){try{"
            + "if(!window.__TAURI__||!window.__TAURI__.event)return 'no-tauri';"
            + "window.__TAURI__.event.listen('qs://ocr-result',function(ev){"
            + "window.__lastPayload=ev&&ev.payload;"
            + "window.__payloadN=(window.__payloadN||0)+1;});return 'hooked';"
            + "}catch(e){return 'hook-err:'+e.message}})()");
        out.push('HOOK ' + hooked);
        // 自证：从页面自己 emit 一条，看钩子收不收得到 ——
        // 收得到 = 前端事件通道没问题，后端 emit_to 没到；收不到 = 钩子本身有问题
        await evalJs(ws, "(function(){try{window.__TAURI__.event.emit("
            + "'qs://ocr-result',{note:'__probe__'});return 1}"
            + "catch(e){return 'emit-err:'+e.message}})()");
        await sleep(500);
        out.push('HOOK_SELF ' + (await evalJs(ws, "window.__payloadN || 0")));
        // 清干净，接下来只统计后端推来的
        await evalJs(ws, "window.__payloadN = 0; window.__lastPayload = null;");

        const found = await evalJs(ws, "!!document.getElementById(" + JSON.stringify(clickId) + ")");
        out.push('BUTTON ' + clickId + ' ' + (found ? 'FOUND' : 'MISSING'));
        if (found) {
            await evalJs(ws, "document.getElementById(" + JSON.stringify(clickId) + ").click()");
            out.push('BUTTON_CLICKED 1');
        } else {
            out.push('BUTTON_CLICKED 0');
        }
        if (afterMs > 0) {
            await sleep(afterMs);
            const s2 = await snapshot(ws);
            out.push('TEXT_AFTER_LEN ' + (s2.text || '').length);
            // 点完按钮后再读一次两段标注：渐进式并行下「第一次读只该有本地段」，
            // 最终态才该两段齐全 —— 两次都要有客观数据才说得清
            out.push('TEXT_AFTER_HAS_LOCAL ' + ((s2.text || '').indexOf('【本地识别】') >= 0 ? 1 : 0));
            out.push('TEXT_AFTER_HAS_BAIDU ' + ((s2.text || '').indexOf('【百度云】') >= 0 ? 1 : 0));
            {
                const li2 = (s2.text || '').indexOf('【本地识别】');
                const bi2 = (s2.text || '').indexOf('【百度云】');
                out.push('TEXT_AFTER_LOCAL_FIRST ' + (li2 >= 0 && bi2 >= 0 && li2 < bi2 ? 1 : 0));
            }
            // 顺带再读一次提示条：点完按钮时页面早就加载完了，这时提示条还不在
            // 就说明不是「推送太早、页面没接住」，而是真没设上
            out.push('NOTE_AFTER_HIDDEN ' + (s2.noteHidden ? 1 : 0));
            out.push('NOTE_AFTER_TEXT <<<');
            out.push(s2.noteText || '');
            out.push('>>>');
            // 后端 payload 里到底有没有 note（'NOPAYLOAD' = 一条都没收到）
            const raw = await evalJs(ws, "window.__lastPayload"
                + " ? JSON.stringify(window.__lastPayload.note) : 'NOPAYLOAD'");
            out.push('PAYLOAD_NOTE ' + raw);
            out.push('PAYLOAD_COUNT ' + (await evalJs(ws, "window.__payloadN || 0")));
            out.push('TEXT_AFTER <<<');
            out.push(s2.text || '');
            out.push('>>>');

            // ---- 并行模式的三档显示切换（纯前端，不重新识别）----
            // 用户要求：① 三档「仅本地/仅百度/两者都看」；② 切到百度要**直接呈现
            // 已有结果**，提示是「正在使用百度 OCR」而不是「重新用百度 OCR」。
            const showVisible = await evalJs(ws,
                "(function(){const s=document.querySelector('#ocrShowSeg');"
                + "return !!(s && !s.hidden);})()");
            out.push('SHOWSEG_VISIBLE ' + (showVisible ? 1 : 0));
            if (showVisible) {
                out.push('SHOWMODE_ON ' + (await evalJs(ws,
                    "(function(){const b=document.querySelector('#ocrShowSeg button.on');"
                    + "return b ? b.dataset.m : 'NONE';})()")));
                const segText = async (m) => {
                    await evalJs(ws, "document.querySelector('#ocrShowSeg button[data-m=\""
                        + m + "\"]').click()");
                    await sleep(320);
                    return snapshot(ws);
                };
                const sb = await segText('both');
                out.push('BOTH_HAS_LOCAL ' + (sb.text.indexOf('【本地识别】') >= 0 ? 1 : 0));
                out.push('BOTH_HAS_BAIDU ' + (sb.text.indexOf('【百度云】') >= 0 ? 1 : 0));
                out.push('BOTH_LEN ' + (sb.text || '').length);
                const sd = await segText('baidu');
                out.push('BAIDUONLY_HAS_LOCAL ' + (sd.text.indexOf('【本地识别】') >= 0 ? 1 : 0));
                out.push('BAIDUONLY_HAS_BAIDU ' + (sd.text.indexOf('【百度云】') >= 0 ? 1 : 0));
                out.push('BAIDUONLY_LEN ' + (sd.text || '').length);
                out.push('BAIDUONLY_TOAST <<<');
                out.push(await evalJs(ws,
                    "(function(){const t=document.querySelector('#toast');"
                    + "return t ? String(t.textContent||'') : '';})()"));
                out.push('>>>');
                const sl = await segText('local');
                out.push('LOCALONLY_HAS_LOCAL ' + (sl.text.indexOf('【本地识别】') >= 0 ? 1 : 0));
                out.push('LOCALONLY_HAS_BAIDU ' + (sl.text.indexOf('【百度云】') >= 0 ? 1 : 0));
                out.push('LOCALONLY_LEN ' + (sl.text || '').length);
            }
            // 最后：点「关闭」关掉结果窗 —— 缓存该被清空（用户要求 OCR 缓存是临时的）。
            // 清空本身在后端做，证据在日志里（"本轮识别数据…已全部清空"）。
            const closeOk = await evalJs(ws,
                "(function(){const b=document.getElementById('btnClose');"
                + "if(!b) return 0; b.click(); return 1;})()");
            out.push('CLOSE_CLICKED ' + closeOk);
        }
    }

    ws.close();
    fs.writeFileSync(outPath, out.join('\n'), 'utf8');
    console.log(out.filter((l) => !l.startsWith('TEXT <<<')).join('\n'));
    process.exit(0);
})().catch((e) => {
    try { fs.writeFileSync(outPath, 'WINDOW NONE\nTEXT_LEN 0\nERR ' + (e && e.message || e) + '\n', 'utf8'); } catch (_) { }
    console.log('ERR ' + ((e && e.message) || e));
    process.exit(0);
});
