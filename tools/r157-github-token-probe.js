/* r157 探针：GitHub 个人访问令牌真的进了请求头吗？
 *
 * 为什么要有这个探针（v1.5.7）：
 *   单测只能证明"我们打算把令牌放进 Authorization"，证明不了 ureq 那一层
 *   真的发出去了、也证明不了"清空令牌后确实退回匿名"。所以这里起一个**本地
 *   假 GitHub**，让实例把请求打到它身上，再逐条对请求头：
 *
 *     ⓪ 启动时自动检查（不点按钮）→ 查到新版，但没令牌 → canAuto=false，
 *        界面上只能"用浏览器下载"，直接调 update_install 会被后端拒绝
 *     ① 填令牌    → `Authorization: Token ghp_probe_123` + 一次 API 拿全
 *     ② 清空令牌  → 不带 Authorization，且先走 302 那条省额度的路
 *     ③ 令牌被拒  → 带令牌试一次被 401，自动降级匿名重试并成功
 *     ④ 限流       → 错误文案里有"约 N 分钟"和"去填令牌"
 *     ⑤ 隐私       → 日志里绝不出现令牌原文
 *     ⑥ 验证按钮   → 有效令牌回报账号/额度、坏令牌说"无效"、**验证不落盘**
 *                    （v1.5.8 的「验证」按钮，打的是 /user 那个口子）
 *     ⑦ 备份可移植 → 没设备份密码报"仅本机可解"、设了报"可跨设备"，
 *                    顺带确认凭据计数把令牌算进去了（v1.5.9；测完原样还原）
 *
 * 用法: node tools/r157-github-token-probe.js
 * 前提: cargo build --release
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const DATA = path.join(ROOT, 'target', 'release', 'Quick search data');
const OUT = path.join(__dirname, 'r157-github-token.txt');
const PORT = 9431;
const WV = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=9432';
/* ⚠ 必须用**异步**等待，不能照抄 r155/r156 的 Atomics.wait：
 *   那个是同步阻塞，会把 Node 的事件循环一起冻住 —— 本轮探针自己起了一个
 *   本地假 GitHub，http server 就活在这个事件循环里，阻塞期间它一个请求都
 *   应不了，表现成"实例发了请求、服务端一条记录都没有"（踩过一次）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = [];
let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(name, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + name); }
    else { fail++; rec('FAIL  ' + name + (extra === undefined ? '' : '   [' + extra + ']')); }
}

/* ------------------------- 本地假 GitHub ------------------------- */
const TOKEN = 'ghp_probe_123';
/** ok | reject-token | ratelimit */
let MODE = 'ok';
const hits = [];
const release = () => ({
    tag_name: 'v99.0.0',
    body: '探针版本\nSHA256: ' + 'A'.repeat(64),
    html_url: 'http://127.0.0.1:' + PORT + '/release',
    assets: [{
        name: 'QuickSearch.exe',
        size: 12345,
        browser_download_url: 'http://127.0.0.1:' + PORT + '/QuickSearch.exe',
    }],
});
const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    hits.push({ path: req.url, auth, mode: MODE });
    if (req.url.indexOf('/web-latest') === 0) {
        // 匿名那条路的"拿 tag"：302 到 /tag/v99.0.0，不计 API 额度
        res.writeHead(302, { Location: 'http://127.0.0.1:' + PORT + '/tag/v99.0.0' });
        return res.end();
    }
    if (req.url.indexOf('/api/user') === 0) {
        /* v1.5.8：「验证」按钮打的就是这个口子（真机上是 /user）。
         * 判据和真 GitHub 对齐：令牌不对就是 401 Bad credentials。 */
        if (MODE === 'ratelimit') {
            res.writeHead(403, {
                'content-type': 'application/json',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
            });
            return res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        }
        if (auth !== 'Token ' + TOKEN) {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ message: 'Bad credentials' }));
        }
        res.writeHead(200, {
            'content-type': 'application/json',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4999',
            // 有兴趣就带上：证明 kind 的推断（有它就是经典令牌）
            'x-oauth-scopes': 'repo',
        });
        return res.end(JSON.stringify({ login: 'probe-user', name: '探针账号', id: 1 }));
    }
    if (req.url.indexOf('/api/rate-limit') === 0) {
        /* v1.5.10：令牌框下面那行「已用 X 次 / 共 Y 次」。
         * 真机上是 `/rate_limit`。有令牌 5000、匿名 60 —— 和 GitHub 的
         * 实际规则一致，这样探针验到的数字就是用户会看到的数字。
         * `remaining` 故意给个非整十的值，好让"已用 = 上限 - 剩余"算得出来。 */
        const ok = auth === 'Token ' + TOKEN;
        res.writeHead(200, {
            'content-type': 'application/json',
            'x-ratelimit-limit': ok ? '5000' : '60',
            'x-ratelimit-remaining': ok ? '4996' : '58',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
        });
        return res.end(JSON.stringify({
            resources: { core: { limit: ok ? 5000 : 60, remaining: ok ? 4996 : 58 } },
        }));
    }
    if (req.url.indexOf('/api-latest') === 0) {
        if (MODE === 'ratelimit') {
            res.writeHead(403, {
                'content-type': 'application/json',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
            });
            return res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        }
        // 只拒"带令牌"的请求：模拟"令牌过期/没权限，但公开仓库匿名可读"
        if (MODE === 'reject-token' && auth) {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ message: 'Bad credentials' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(release()));
    }
    res.writeHead(404);
    res.end();
});

let id = 0;
function cdp(ws, m, p) {
    return new Promise((res, rej) => {
        const i = ++id;
        const on = (e) => {
            let x; try { x = JSON.parse(e.data); } catch (err) { return; }
            if (x.id !== i) return;
            ws.removeEventListener('message', on);
            x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
        };
        ws.addEventListener('message', on);
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
}
const ev = async (ws, expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails
        ? 'ERR ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)
        : r.result.value;
};

async function connect(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
        try {
            const r = await fetch('http://127.0.0.1:9432/json/list');
            const ts = await r.json();
            const hit = ts.find((t) => t.type === 'page' && /(index\.html|\/)$/.test(t.url || ''));
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

const LOG = path.join(DATA, 'log.txt');
const readLogFrom = (off) => {
    try {
        const b = fs.readFileSync(LOG);
        return b.subarray(Math.min(off, b.length)).toString('utf8');
    } catch (e) { return ''; }
};
const logSize = () => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } };

(async () => {
    if (!fs.existsSync(EXE)) { rec('没找到 ' + EXE + '，先 cargo build --release'); process.exit(1); }
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    rec('r157 探针：假 GitHub 在 127.0.0.1:' + PORT);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-r157-'));
    const env = Object.assign({}, process.env, {
        QS_DEBUG: '1',
        QS_ALLOW_INJECTED: '1',
        QS_INSTANCE_TAG: 'r157' + Date.now().toString(36),
        WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_T_WV_ARGS: WV,
        // ★ 这两条是探针专用逃生口（正式启动不带）——让实例去问本地假服务
        QS_UPDATE_API: 'http://127.0.0.1:' + PORT + '/api-latest',
        QS_UPDATE_WEB: 'http://127.0.0.1:' + PORT + '/web-latest',
        // v1.5.10：额度用量（真机是 /rate_limit，不消耗额度）
        QS_GITHUB_RATE_API: 'http://127.0.0.1:' + PORT + '/api/rate-limit',
        // v1.5.8：「验证」按钮的 /user，也要指到假服务上才测得了坏令牌
        QS_GITHUB_USER_API: 'http://127.0.0.1:' + PORT + '/api/user',
    });
    const launch = () => spawn(EXE, ['--no-elevate'], { env, cwd: ROOT, stdio: 'ignore' });
    const stop = (p) => new Promise((res) => {
        let done = false;
        const fin = () => { if (!done) { done = true; res(); } };
        p.once('exit', fin);
        try { p.kill(); } catch (e) { return fin(); }
        setTimeout(fin, 5000);
    });
    let ws = null;
    const call = (cmd, args) => ev(ws, `window.__TAURI__.core.invoke('${cmd}'${args ? ', ' + args : ''})
        .then(function(v){ return v === undefined ? 'ok' : JSON.stringify(v); })
        .catch(function(e){ return 'ERR ' + e; })`);
    const setTok = (v) => call('set_setting', `{ key: 'githubToken', value: ${JSON.stringify(v)} }`);
    const setAuto = (v) => call('set_setting', `{ key: 'autoUpdate', value: ${v} }`);
    const pending = async () => {
        const s = await call('update_pending');
        try { return JSON.parse(s); } catch (e) { return { raw: s }; }
    };
    const waitTauri = async () => {
        for (let i = 0; i < 40; i++) {
            const ok = await ev(ws, `!!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)`);
            if (ok) return true;
            await sleep(250);
        }
        return false;
    };

    /* ---------- 预检：把配置摆成"出厂状态" ----------
     * 探针和开发机共用 `target/release/Quick search data`，而上一轮跑完
     * 可能把"自动更新"关掉了（为了不让它中途插一脚）——那样这一轮启动时
     * 根本不会自动检查，第 ⓪ 组断言就成了空转。所以先起一个实例把
     * autoUpdate 打开、令牌清空，再杀掉，正式那一次才是确定的起点。 */
    {
        const p0 = launch();
        ws = await connect();
        if (!ws) { rec('预检连不上页面'); try { p0.kill(); } catch (e) { } server.close(); process.exit(1); }
        await waitTauri();
        await setAuto(true);
        await setTok('');
        await sleep(500);
        await stop(p0);
    }

    const offBoot = logSize();   // 只看"这次启动"之后写的日志，别被历史记录蒙过去
    const proc = launch();
    rec('实例 pid=' + proc.pid + '（不影响已部署的那个）');
    /* 等过"启动 8 秒后的自动检查"：这既是第 ⓪ 组要观察的对象，
     * 也避免它和后面的手动 update_check 撞在 UpdateGuard 上。 */
    await sleep(11000);

    ws = await connect();
    if (!ws) { rec('连不上页面'); try { proc.kill(); } catch (e) { } server.close(); process.exit(1); }
    await waitTauri();

    /* ---------- ⓪ 启动时自动检查（用户说的第一种检测方式）---------- */
    const logBoot = readLogFrom(offBoot);
    const pAuto = await pending();
    check('启动时自动检查：没点按钮就查到了新版',
        pAuto.has === true, JSON.stringify(pAuto).slice(0, 160));
    check('  日志确认那次是匿名请求（用令牌=false）',
        /update: 检查完成.*用令牌=false/.test(logBoot),
        logBoot.split(/\r?\n/).filter((s) => /检查完成/.test(s)).join(' | '));
    check('  没令牌 → canAuto=false（界面只能给"用浏览器下载"）',
        pAuto.canAuto === false, JSON.stringify(pAuto).slice(0, 160));
    check('  但下载网址照样带回来了（用户有出路）',
        /QuickSearch\.exe$/.test(pAuto.url || ''), pAuto.url);

    /* 就算界面被绕过、直接调下载命令，后端也必须拒 —— 这是"检测到了也不能下"的硬保证 */
    hits.length = 0;
    const offInstall = logSize();
    await call('update_install');
    await sleep(1000);
    const logInstall = readLogFrom(offInstall);
    check('没令牌时直接调 update_install 会被后端拒绝',
        /按口径不自动下载/.test(logInstall),
        logInstall.split(/\r?\n/).filter((s) => /update:/.test(s)).join(' | '));
    check('  而且一个下载请求都没发出去',
        !hits.some((h) => h.path.indexOf('/QuickSearch.exe') === 0),
        hits.map((h) => h.path).join(',') || '(无请求)');

    // 关掉自动更新，别让它在中途插一脚（收尾时会再打开）
    await setAuto(false);
    await sleep(300);

    /* ---------- ① 填了令牌：请求头必须是 Authorization: Token … ---------- */
    await setTok(TOKEN);
    await sleep(300);
    hits.length = 0;
    const off1 = logSize();
    await call('update_check');
    await sleep(1800);
    const api1 = hits.filter((h) => h.path.indexOf('/api-latest') === 0);
    rec('[令牌] 请求记录：' + hits.map((h) => h.path + (h.auth ? ' +auth' : '')).join(' | '));
    check('填了令牌：API 请求带 Authorization: Token <令牌>',
        api1.length > 0 && api1.every((h) => h.auth === 'Token ' + TOKEN),
        api1.map((h) => h.auth).join(','));
    check('有令牌时只调一次 API 就拿全（不再走 302 省额度）',
        api1.length === 1 && !hits.some((h) => h.path.indexOf('/web-latest') === 0),
        'api=' + api1.length + ' web=' + hits.filter((h) => h.path.indexOf('/web') === 0).length);
    const p1 = await pending();
    check('update_pending 回报 canAuto=true（前端才给"下载并安装"）',
        p1.canAuto === true, JSON.stringify(p1));
    check('  也如实记下这次检查用了令牌（authed=true）', p1.authed === true);
    check('  下载地址也带回来了', /QuickSearch\.exe$/.test(p1.url || ''), p1.url);
    const log1 = readLogFrom(off1);
    check('日志里不出现令牌原文（凭据不入日志）', log1.indexOf(TOKEN) < 0);

    /* ---------- ② 清空令牌：不带 Authorization，退回 302 省额度 ---------- */
    await setTok('');
    await sleep(300);
    hits.length = 0;
    await call('update_check');
    await sleep(1800);
    check('清空令牌后：请求不带 Authorization', hits.every((h) => !h.auth),
        hits.map((h) => h.auth).join(','));
    check('  走 302 那条路（/web-latest 被请求，省 API 额度）',
        hits.some((h) => h.path.indexOf('/web-latest') === 0),
        hits.map((h) => h.path).join(','));
    /* 手动检测这条路上同样要立住"没令牌不能下"（第 ⓪ 组测的是启动自动检测） */
    const p2 = await pending();
    check('  清空令牌后 canAuto 立刻变 false（不沿用那次检查的结论）',
        p2.canAuto === false, JSON.stringify(p2));

    /* ---------- ③ 令牌被拒：自动降级匿名重试 ---------- */
    MODE = 'reject-token';
    await setTok('ghp_expired');
    await sleep(300);
    hits.length = 0;
    const off3 = logSize();
    await call('update_check');
    /* ⚠ 这里要等足够久：降级路径是"401 → 退回匿名 → 302 拿 tag → 再调 API"，
     *   实测本机走完要 2.2s 左右（IPv4-first 的重连 + 两次请求）。等 2.2s
     *   会在"最后一个请求刚发出"的时刻断言，看起来像没重试（踩过一次）。 */
    await sleep(4500);
    check('令牌被拒：第一次确实带了令牌', hits.some((h) => h.auth === 'Token ghp_expired'));
    check('  然后自动用匿名请求重试（公开仓库照样能查）',
        hits.some((h) => !h.auth && h.path.indexOf('/api-latest') === 0),
        hits.map((h) => h.path + (h.auth ? '+auth' : '')).join(','));
    check('  日志写明降级原因',
        /令牌被 GitHub 拒了|令牌无效/.test(readLogFrom(off3)));
    const p3 = await pending();
    check('  降级后 authed=false（如实记下那次没用上令牌）',
        p3.authed === false, JSON.stringify(p3));
    /* 令牌被拒 ≠ 没填令牌：`canAuto` 只问"填没填"，所以这里仍是 true。
     * 下载不会因此坏掉 —— 公开仓库的资产匿名就能下，`open_update_stream`
     * 先匿名、失败了才带令牌重试。 */
    check('  但令牌还填着 → canAuto=true（下载走匿名兜底，不会 403）',
        p3.canAuto === true, JSON.stringify(p3));
    MODE = 'ok';

    /* ---------- ④ 限流：文案要给"等多久"和"去填令牌" ---------- */
    MODE = 'ratelimit';
    await setTok('');
    await sleep(300);
    const off4 = logSize();
    await call('update_check');
    await sleep(1800);
    const log4 = readLogFrom(off4);
    check('限流错误说清还要等多久（约 N 分钟）', /约 \d+ 分钟/.test(log4),
        log4.split(/\r?\n/).filter((s) => /限流/.test(s)).join(' | '));
    check('  没令牌时引导去填个人访问令牌', /个人访问令牌/.test(log4));
    MODE = 'ok';

    /* ---------- ⑥ 验证按钮（v1.5.8）：有效 / 无效 / 不落盘 ---------- */
    MODE = 'ok';
    await setTok('');
    await sleep(300);
    hits.length = 0;
    const off6 = logSize();
    const v1 = await call('verify_github_token', `{ token: ${JSON.stringify(TOKEN)} }`);
    let v1j = null;
    try { v1j = JSON.parse(v1); } catch (e) { }
    check('验证有效令牌：回报账号与额度',
        !!v1j && v1j.login === 'probe-user' && v1j.limit === 5000, v1);
    check('  认得这是经典令牌（响应头带 x-oauth-scopes）',
        !!v1j && v1j.kind === '经典令牌', v1j && v1j.kind);
    check('  验证请求确实带了令牌',
        hits.some((h) => h.path.indexOf('/api/user') === 0 && h.auth === 'Token ' + TOKEN),
        hits.map((h) => h.path + (h.auth ? ' +auth' : '')).join(','));
    /* ⚠ 这一条是"验证 ≠ 保存"的硬证据：验证过之后配置里仍是空的，
     *   所以 canAuto 还是 false。用户可以先验一个抄来的令牌再决定存不存。 */
    const p6 = await pending();
    check('  ⚠ 验证不落盘：配置里仍然没令牌，canAuto 还是 false',
        p6.canAuto === false, JSON.stringify(p6).slice(0, 160));

    const v2 = await call('verify_github_token', `{ token: 'ghp_wrong' }`);
    check('验证无效令牌：回一句人话（令牌无效/过期）',
        /令牌无效|Bad credentials/.test(String(v2)), String(v2).slice(0, 160));
    const v3 = await call('verify_github_token', `{ token: ${JSON.stringify('  ' + TOKEN + '\r\n')} }`);
    let v3j = null;
    try { v3j = JSON.parse(v3); } catch (e) { }
    check('  粘贴时带的空白/换行会被洗掉（和真正发请求同一套洗法）',
        !!v3j && v3j.login === 'probe-user', String(v3).slice(0, 160));
    check('  日志里同样不出现令牌原文', readLogFrom(off6).indexOf(TOKEN) < 0);

    /* ---------- ⑦ 备份可移植性（v1.5.9）----------
     *
     * 这一组回答一个很实际的问题：**这份备份换台电脑能不能解开**。
     * 界面以前写着"留空 = 不加密"，那是错的 —— 留空走 DPAPI，
     * 数据照样加密，但只有本机能解。后端必须能如实报出来。
     *
     * ⚠ 设备份密码会真的改动这台机器的主文件加密方式，所以这里
     *   **先读出原值、测完立刻还原**。探针绝不给用户留副作用。 */
    const cfgRaw = await call('get_config');
    let pwBefore = '';
    try { pwBefore = JSON.parse(cfgRaw).backupPassword || ''; } catch (e) { }

    await setTok(TOKEN);
    await sleep(300);
    const sec0 = await call('backup_security_state');
    let s0 = null;
    try { s0 = JSON.parse(sec0); } catch (e) { }
    check('有令牌时凭据计数把它算进去', !!s0 && s0.secretCount >= 1, sec0);
    check('  hasToken 如实反映"配置里有令牌"', !!s0 && s0.hasToken === true, sec0);

    /* 先把它摆到"没密码"这个最容易误判的状态，再摆回来。
     * 用临时值而不是直接清空：万一原值就是空，清空也是空，没差；
     * 原值非空时下面会还原成原值。 */
    await call('set_setting', '{ key: \'backupPassword\', value: \'\' }');
    await sleep(300);
    const sec1 = await call('backup_security_state');
    let s1 = null;
    try { s1 = JSON.parse(sec1); } catch (e) { }
    check('没设备份密码：如实报"仅本机可解"（portable=false）',
        !!s1 && s1.portable === false && s1.envelope === 'dpapi', sec1);

    await call('set_setting', '{ key: \'backupPassword\', value: \'probe-temp-pw\' }');
    await sleep(300);
    const sec2 = await call('backup_security_state');
    let s2 = null;
    try { s2 = JSON.parse(sec2); } catch (e) { }
    check('设了备份密码：改报"可跨设备恢复"（portable=true）',
        !!s2 && s2.portable === true && s2.envelope === 'password', sec2);
    check('  日志里不会出现备份密码原文',
        readLogFrom(0).indexOf('probe-temp-pw') < 0);

    // 还原：密码回到探针开跑前的那个值
    await call('set_setting', `{ key: 'backupPassword', value: ${JSON.stringify(pwBefore)} }`);
    await sleep(300);
    const sec3 = await call('backup_security_state');
    let s3 = null;
    try { s3 = JSON.parse(sec3); } catch (e) { }
    check('收尾：备份密码已还原成探针开跑前的状态',
        !!s3 && s3.portable === (pwBefore.trim().length > 0), sec3 + ' / before=' + JSON.stringify(pwBefore));

    /* ---------- ⑧ 额度用量（v1.5.10）----------
     *
     * 设置页令牌框下面那行「本小时已请求 X 次 / 共 Y 次」。
     * 关键是它必须走 `/rate_limit`（不计额度），不能拿 `/user` 去数 ——
     * 后者每开一次设置页就烧掉一次配额。下面的断言就是盯着请求路径。 */
    await setTok(TOKEN);
    await sleep(300);
    hits.length = 0;
    const r1 = await call('github_rate_state');
    let r1j = null;
    try { r1j = JSON.parse(r1); } catch (e) { }
    check('带令牌：额度上限 5000', !!r1j && r1j.ok && r1j.limit === 5000, r1);
    check('  已用次数 = 上限 - 剩余', !!r1j && r1j.used === 4, r1);
    check('  authed=true（如实反映这次带了令牌）', !!r1j && r1j.authed === true);
    check('  走的是 /rate_limit（不消耗额度那个口子）',
        hits.some((h) => h.path.indexOf('/api/rate-limit') === 0),
        hits.map((h) => h.path).join(','));

    await setTok('');
    await sleep(300);
    const r2 = await call('github_rate_state');
    let r2j = null;
    try { r2j = JSON.parse(r2); } catch (e) { }
    check('匿名：额度上限 60', !!r2j && r2j.ok && r2j.limit === 60, r2);
    check('  authed=false', !!r2j && r2j.authed === false, r2j && r2j.authed);
    check('  日志里没有令牌、也没有备份密码', readLogFrom(0).indexOf(TOKEN) < 0);

    // 收尾：把探针写进去的配置清干净（自动更新**要还原成 true**，
    // 否则下一轮启动时不会自动检查，第 ⓪ 组就白测了）
    await setTok('');
    await setAuto(true);
    await sleep(400);

    rec('');
    rec(`结果：${pass} PASS / ${fail} FAIL`);
    try { proc.kill(); } catch (e) { }
    try { server.close(); } catch (e) { }
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    rec('探针异常：' + (e && e.stack || e));
    try { server.close(); } catch (err) { }
    process.exit(2);
});
