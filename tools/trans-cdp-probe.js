/* ============================================================================
 *  翻译窗的 CDP 读取（真机 e2e 用，由 run-trans-e2e.js 驱动）
 *
 *  为什么走 CDP：QuickSearch 的窗口是 WebView2（Chromium）。测试实例带
 *  QS_T_WV_ARGS="… --remote-debugging-port=9333"（e2e 专用，正常启动不带），
 *  于是能用 DevTools 协议**直接读页面 DOM** ——
 *    · 比截图可靠（截图只能人眼看，且本会话看不了图）；
 *    · 比按坐标点按钮确定得多；
 *    · 能把「两家并排、各落各的框、失败那家的 note 显示了什么」读成客观文本。
 *
 *  用法：node trans-cdp-probe.js <outFile> [--wait-ms <毫秒>] [--port <端口>]
 *  输出（outFile，UTF-8，`KEY value` 一行一个，多行文本用 <<< >>> 包住）：
 *    WINDOW / TARGET / ENGCAP / SRC / PANE_COUNT
 *    PANE <i> <<< id=… name=… st=… ta=… note=… >>>
 *    NOTE_HIDDEN / NOTE_TEXT
 * ========================================================================== */
const fs = require('fs');

const argv = process.argv.slice(2);
const outPath = argv[0];
let waitMs = 0;
let PORT = Number(process.env.CDP_PORT || 9333);
for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--wait-ms') waitMs = parseInt(argv[++i] || '0', 10) || 0;
    if (argv[i] === '--port') PORT = parseInt(argv[++i] || '0', 10) || PORT;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return r.json();
}

async function findTransTarget() {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
        try {
            const ts = await listTargets();
            const hit = ts.find((t) => t.type === 'page' && (t.url || '').indexOf('trans.html') >= 0);
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

/* 一整套翻译窗状态。⚠ 读的是**真 DOM**：一家一个 .tp 框、状态行、错误 note。 */
const SNAP = `(function(){
  const q=(id)=>document.getElementById(id);
  const txt=(el)=>el?el.textContent:'';
  const panes=[...document.querySelectorAll('.tp')].map((p)=>({
    id: p.dataset.eng || '',
    name: txt(p.querySelector('.tp-name')),
    st:   txt(p.querySelector('.tp-st')),
    bad:  !!(p.querySelector('.tp-st')||{}).classList
            && p.querySelector('.tp-st').classList.contains('err') ? 1 : 0,
    ta:   (p.querySelector('textarea')||{}).value || '',
    note: txt(p.querySelector('.tp-note')),
    noteHidden: !!(p.querySelector('.tp-note')||{}).hidden,
  }));
  const note=q('note');
  return {
    title: document.title,
    target: (q('target')||{}).value || '',
    engCap: txt(q('engCap')),
    src: (q('src')||{}).value || '',
    panes,
    noteHidden: !!(note&&note.hidden),
    noteText: txt(note),
  };
})()`;

(async function main() {
    const target = await findTransTarget();
    if (!target) {
        fs.writeFileSync(outPath, 'WINDOW NONE\nPANE_COUNT 0\n', 'utf8');
        console.log('NO 没找到 trans.html 的调试目标');
        process.exit(0);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', (e) => reject(new Error('ws 连不上：' + (e.message || e))), { once: true });
    });

    if (waitMs) await sleep(waitMs);
    const s = await evalJs(ws, SNAP);

    const L = [];
    L.push('WINDOW ' + (s.title || 'NONE'));
    L.push('TARGET ' + (s.target || ''));
    L.push('ENGCAP ' + (s.engCap || ''));
    L.push('SRC <<<');
    L.push(s.src || '');
    L.push('>>>');
    L.push('PANE_COUNT ' + s.panes.length);
    s.panes.forEach((p, i) => {
        L.push('PANE ' + i + ' <<<');
        L.push('id=' + p.id);
        L.push('name=' + p.name);
        L.push('st=' + p.st);
        L.push('bad=' + p.bad);
        L.push('noteHidden=' + (p.noteHidden ? 1 : 0));
        L.push('note=' + p.note);
        L.push('ta=' + p.ta);
        L.push('>>>');
    });
    L.push('NOTE_HIDDEN ' + (s.noteHidden ? 1 : 0));
    L.push('NOTE_TEXT <<<');
    L.push(s.noteText || '');
    L.push('>>>');

    fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
    console.log('OK 已写出 ' + outPath + '（' + s.panes.length + ' 个译文框）');
    process.exit(0);
})().catch((e) => {
    fs.writeFileSync(outPath, 'WINDOW NONE\nPANE_COUNT 0\nERR ' + e.message + '\n', 'utf8');
    console.log('NO ' + e.message);
    process.exit(0);
});
