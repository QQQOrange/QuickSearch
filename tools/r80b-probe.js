/* ============================================================================
 *  r80b：验证两件事
 *
 *  1. **换图标的开关逻辑**（用户报的第一个问题）
 *     用户原话：「抠图的功能默认不打开。就只有在设置通用里面打开之后，换图标
 *     才会有个编辑的这个页面。没打开抠图功能的时候，点击换图标就直接选择文件替换」
 *     并且确认口径是「彻底禁用编辑器」。
 *     所以：开关关 → 换图标直接替换、且**没有**「编辑图标」按钮
 *           开关开 → 换图标进编辑器、且**有**「编辑图标」按钮
 *
 *  2. **下载源可用性**（用户报的第二个问题）
 *     用户原话：「除了轻量版的模型之外，其他的 3 个模型都下载不了」。
 *     实测根因是 `huggingface.co` 被 DNS 污染。修法是每个模型给多个镜像源
 *     （modelscope 优先）。**这个探针要真去下** —— 之前那版探针是"预置本地模型"
 *     跑的，从没测过下载路径，所以漏掉了这个问题。
 *
 *  用法：node tools/r80b-probe.js [--download]
 *        不带 --download 时只测连通（HEAD + 1 字节 Range），不下整个文件；
 *        带 --download 时真的下第一个模型（4.4MB）验证全流程。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const OUT = path.join(__dirname, 'r80b-probe.txt');
const WV_BASE = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DO_DOWNLOAD = process.argv.includes('--download');

const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra ? '   [' + extra + ']' : '')); }
}

let PORT = 0, id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => { ws.removeEventListener('message', on); rej(new Error('timeout ' + m)); }, 300000);
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (!x || x.id !== i) return;
            clearTimeout(timer); ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, e) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
};
async function connect(sub, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 60000)) {
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
async function until(ws, expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) { if (await ev(ws, expr) === true) return true; await sleep(250); }
    return false;
}
async function freePort() {
    const net = require('net');
    return await new Promise((res, rej) => {
        const s = net.createServer(); s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

/* 后端清单里的 URLs（探针里复制一份 —— 这样能独立于程序验证源是否可达，
 * 不依赖 exe 跑起来）。改清单时要同步这里。 */
const SOURCES = {
    'u2netp': [
        'https://www.modelscope.cn/models/AI-ModelScope/rembg/resolve/master/u2netp.onnx',
        'https://hf-mirror.com/tomjackson2023/rembg/resolve/main/u2netp.onnx',
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    ],
    'rmbg-quantized': [
        'https://www.modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model_quantized.onnx',
        'https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
    ],
    'rmbg-fp16': [
        'https://www.modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model_fp16.onnx',
        'https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model_fp16.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
    ],
    'rmbg-full': [
        'https://www.modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model.onnx',
        'https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
    ],
};
const SIZES = {
    'u2netp': 4574861, 'rmbg-quantized': 44403226,
    'rmbg-fp16': 88217533, 'rmbg-full': 176153355,
};

/** 用一个 Range 请求探源：能拿到**真实数据**（不是错误页）才算可用。 */
function probeSource(url) {
    return new Promise((resolve) => {
        const tmp = path.join(os.tmpdir(), 'probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
        const args = ['-sS', '-L', '--max-time', '40', '-r', '0-1023', '-o', tmp,
            '-w', '%{http_code}', url];
        const p = spawn('curl.exe', args);
        let out = '';
        p.stdout.on('data', (d) => { out += d.toString(); });
        p.on('close', () => {
            let bytes = 0, head = '';
            try {
                bytes = fs.statSync(tmp).size;
                if (bytes >= 4) {
                    const buf = fs.readFileSync(tmp).subarray(0, 8);
                    head = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');
                }
                fs.unlinkSync(tmp);
            } catch (e) { }
            // ONNX 文件头是 protobuf：08 xx 12 xx ... （0x08=field1, 0x12=field2）
            const isOnnx = head.startsWith('08 ');
            resolve({ code: out.trim(), bytes, head, isOnnx });
        });
        p.on('error', () => resolve({ code: 'spawn-fail', bytes: 0, head: '', isOnnx: false }));
    });
}

(async () => {
    /* ══ 第一部分：下载源 ══ */
    rec('══ 一、下载源可用性（每源探 1KB，验证拿到的是真 ONNX）══');
    rec('');
    const sourceOk = {};
    for (const [id, urls] of Object.entries(SOURCES)) {
        const szMB = (SIZES[id] / 1024 / 1024).toFixed(1);
        let okCount = 0;
        for (const u of urls) {
            const host = u.split('//')[1].split('/')[0];
            const r = await probeSource(u);
            const ok = r.isOnnx || (r.code === '206' && r.bytes === 1024);
            if (ok) okCount++;
            rec(`  ${id.padEnd(16)} ${host.padEnd(22)} http=${r.code} ${String(r.bytes).padStart(5)}B 头=${r.head.slice(0, 17)} ${ok ? '✓' : '✗'}`);
        }
        sourceOk[id] = okCount;
        check(
            `${id}（${szMB}MB）至少有一个可用源`,
            okCount >= 1,
            `可用 ${okCount}/${urls.length}`
        );
    }
    rec('');
    rec('  ↑ 只要每个模型**至少一个源**可用，用户就能下到（程序会自动逐个试）');

    /* ══ 第二部分：换图标开关逻辑 ══ */
    rec('');
    rec('══ 二、换图标的开关逻辑（开关关 → 直接替换、无编辑按钮）══');
    rec('');
    PORT = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80b-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify({ debug: true, theme: 'light' }, null, 1), 'utf8');
    const env = Object.assign({}, process.env, {
        APPDATA: tmp, LOCALAPPDATA: tmp, QS_DEBUG: '1',
        QS_INSTANCE_TAG: 'r80b' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV_BASE + PORT,
    });
    const proc = spawn(EXE, ['--no-elevate', '--settings'], { env, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
    rec('  探针进程 pid=' + proc.pid);
    try {
        const sw = await connect('settings.html');
        check('S1 设置页起来了', !!sw);
        if (!sw) throw new Error('连不上设置页');
        await until(sw, "typeof CONF === 'object'", 40000);

        /* 默认状态：开关关着 */
        const off = await ev(sw, "JSON.stringify({ on: !!(CONF && CONF.aiMattingEnable) })");
        check('2a 默认开关是关的', JSON.parse(off).on === false, off);

        /* 关着时：editorEnabled 必须是 false（所有「编辑图标」按钮都以它为准） */
        const fnOff = await ev(sw, "typeof iconEditorEnabled === 'function' ? iconEditorEnabled() : 'NO_FN'");
        check('2b 关着时 iconEditorEnabled() 返回 false', fnOff === false, 'got=' + fnOff);

        /* 关着时：页面上不该有「编辑图标」按钮 */
        const editBtnsOff = await ev(sw,
            "document.querySelectorAll('.mini,.ops button').length ? " +
            "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='编辑图标').length : 0");
        check('2c 关着时页面上没有「编辑图标」按钮', editBtnsOff === 0, '实际 ' + editBtnsOff + ' 个');

        /* 打开开关（走真实命令，模拟用户在界面上点） */
        const swEl = await ev(sw, "!!document.getElementById('s-aiMatting')");
        check('2d 通用页里有 AI 抠图开关', swEl === true);
        await ev(sw, "document.getElementById('s-aiMatting').click()");
        /* ⚠ 等待要**轮询 CONF**，不能只等 checked。
         * checked 是 DOM 自己的状态（点一下就变），而 CONF 是 JS 变量 ——
         * change 处理器是异步的（要 invoke 后端）。只等 checked 会在
         * "CONF 还没更新"时就往下走，然后误报"配置没落盘"。
         * 这个坑我自己踩过：探针报 4 个 FAIL，实际是开关逻辑本来就是好的。 */
        await until(sw, "document.getElementById('s-aiMatting').checked === true", 8000);
        await until(sw, "!!(window.CONF && CONF.aiMattingEnable)", 15000);

        const on = await ev(sw, "JSON.stringify({ on: !!(CONF && CONF.aiMattingEnable) })");
        check('2e 打开后配置已同步到 CONF', JSON.parse(on).on === true, on);

        const fnOn = await ev(sw, "iconEditorEnabled()");
        check('2f 打开后 iconEditorEnabled() 返回 true', fnOn === true, 'got=' + fnOn);

        /* 打开后应该有「编辑图标」按钮出现（有图可编的那些行）。
         * 按钮是 renderAll() 重建 DOM 的结果，所以要等一会儿。 */
        let editBtnsOn = 0;
        for (let i = 0; i < 30; i++) {
            editBtnsOn = await ev(sw,
                "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='编辑图标').length");
            if (editBtnsOn > 0) break;
            await sleep(300);
        }
        check('2g 打开后出现了「编辑图标」按钮', editBtnsOn > 0, '实际 ' + editBtnsOn + ' 个');

        /* 后端也确认一次（不只信前端 CONF） */
        const be = await ev(sw,
            "window.__TAURI__.core.invoke('ai_matting_status').then(r=>String(r.enable))");
        check('2h 后端状态里的 enable 也是 true', be === 'true', 'got=' + be);

        /* 再关回去 → 「编辑图标」按钮应当**消失**（闭环验证：开关是双向生效的，
         * 不是"打开后按钮就一直留在那儿"） */
        await ev(sw, "document.getElementById('s-aiMatting').click()");
        await until(sw, "!(window.CONF && CONF.aiMattingEnable)", 15000);
        let editBtnsBack = 99;
        for (let i = 0; i < 30; i++) {
            editBtnsBack = await ev(sw,
                "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='编辑图标').length");
            if (editBtnsBack === 0) break;
            await sleep(300);
        }
        check('2i 关回去后「编辑图标」按钮消失', editBtnsBack === 0, '实际 ' + editBtnsBack + ' 个');
    } catch (e) {
        rec('探针出错：' + (e && e.message));
        fail++;
    } finally {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
        await sleep(500);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }

    /* ══ 第三部分（可选）：真的下一个模型 ══ */
    if (DO_DOWNLOAD) {
        rec('');
        rec('══ 三、真实下载（--download）：走程序自己的下载链路 ══');
        PORT = await freePort();
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r80bd-'));
        const qs2 = path.join(tmp2, 'QuickSearch');
        fs.mkdirSync(qs2, { recursive: true });
        fs.writeFileSync(path.join(qs2, 'config.json'), JSON.stringify({ debug: true }, null, 1), 'utf8');
        const env2 = Object.assign({}, process.env, {
            APPDATA: tmp2, LOCALAPPDATA: tmp2, QS_DEBUG: '1',
            QS_INSTANCE_TAG: 'r80bd' + Date.now().toString(36),
            WEBVIEW2_USER_DATA_FOLDER: path.join(tmp2, 'wv2'),
            QS_T_WV_ARGS: WV_BASE + PORT,
        });
        const p2 = spawn(EXE, ['--no-elevate', '--settings'], { env: env2, cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
        try {
            const sw = await connect('settings.html');
            if (!sw) throw new Error('连不上设置页（下载测试）');
            await until(sw, "typeof CONF === 'object'", 40000);
            /* 监听进度事件，然后触发下载 */
            await ev(sw, `(function(){
                window.__dlLog = [];
                window.__TAURI__.event.listen('model-download', function(e){
                    window.__dlLog.push(e.payload);
                });
                return true;
            })()`);
            const t0 = Date.now();
            await ev(sw, "window.__TAURI__.core.invoke('ai_matting_download',{id:'u2netp'}).catch(e=>'ERR '+e)");
            /* 等 done / error / canceled */
            let phase = '';
            for (let i = 0; i < 240; i++) {
                await sleep(1000);
                const last = await ev(sw, "(window.__dlLog && window.__dlLog.length) ? window.__dlLog[window.__dlLog.length-1].phase : ''");
                if (last === 'done' || last === 'error' || last === 'canceled') { phase = last; break; }
            }
            const secs = Math.round((Date.now() - t0) / 1000);
            const log = JSON.parse(await ev(sw, "JSON.stringify((window.__dlLog||[]).slice(-3))"));
            rec(`  下载结果 phase=${phase} 用时 ${secs}s，最近事件：${JSON.stringify(log)}`);
            check('3a 程序自己的下载链路能下到 u2netp（4.4MB）', phase === 'done', 'phase=' + phase);
            const modelFile = path.join(qs2, 'models', 'u2netp.onnx');
            const exists = fs.existsSync(modelFile);
            const size = exists ? fs.statSync(modelFile).size : 0;
            check('3b 文件真的落到 models/u2netp.onnx 且大小正确',
                exists && size === SIZES['u2netp'], `exists=${exists} size=${size}`);
            /* 下完之后状态应当是 ready */
            const st = JSON.parse(await ev(sw, "window.__TAURI__.core.invoke('ai_matting_status').then(r=>JSON.stringify(r))"));
            check('3c 下完后 currentReady 变成 true', st.currentReady === true, JSON.stringify(st.models.find(m => m.id === 'u2netp')));
        } catch (e) {
            rec('下载测试出错：' + (e && e.message));
            fail++;
        } finally {
            try { execSync(`taskkill /PID ${p2.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { }
            await sleep(500);
            try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) { }
        }
    } else {
        rec('');
        rec('（未加 --download，跳过真实下载测试）');
    }

    rec('');
    rec(`========== r80b 探针：${pass} PASS / ${fail} FAIL ==========`);
    process.exit(fail === 0 ? 0 : 1);
})();
