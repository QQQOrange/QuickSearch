/* r71：验证必应「上传拿 insightsToken URL → 浏览器打开」这条路在真实浏览器里
 * 到底呈现什么。Edge 无头 + CDP，加载上传返回的 Location，等渲染后抓正文文本。
 * 用法: node tools/r71-bing-probe.js */
const PORT = Number(process.argv[2] || 9222);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let id = 0;

async function main() {
    // 1. 找页面 target
    let page = null;
    for (let i = 0; i < 40; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const ts = await r.json();
            page = ts.find((t) => t.type === 'page' && /bing\.com/.test(t.url || ''));
            if (page) break;
        } catch (e) { }
        await sleep(500);
    }
    if (!page) { console.log('找不到 bing 页面 target'); process.exit(1); }
    console.log('页面 URL: ' + page.url.slice(0, 160));

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true });
    });
    const cdp = (m, p) => new Promise((res, rej) => {
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
    const ev = async (e) => {
        const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
        return r.result.value;
    };

    // 2. 等页面渲染（必应结果页是重客户端）
    await sleep(6000);
    const url1 = await ev('location.href');
    const title = await ev('document.title');
    console.log('渲染后 URL: ' + String(url1).slice(0, 200));
    console.log('标题: ' + title);

    // 3. 抓可视搜索的标志物
    const marks = await ev(`(function(){
        var t = document.body ? document.body.innerText : '';
        var out = {
            len: t.length,
            hasVisualSearch: /Visual search|视觉搜索|Similar images|相似图片|Pages that include|包含.*页面/i.test(t),
            hasNoResult: /No results|没有找到|未找到/i.test(t),
            snippet: t.slice(0, 300).replace(/\\s+/g, ' ')
        };
        // 结果格子数（必应图片结果的类名）
        out.iusc = document.querySelectorAll('.iusc').length;
        out.imgptt = document.querySelectorAll('.imgpt').length;
        return JSON.stringify(out);
    })()`);
    console.log('正文标志: ' + marks);
    ws.close();
    process.exit(0);
}
main().catch((e) => { console.log('崩了：' + (e && e.stack ? e.stack : e)); process.exit(2); });
