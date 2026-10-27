#!/usr/bin/env node
/* 翻译多引擎**真机端到端**自测（v1.5.16 第二轮）。
 *
 * 单元测试（src/trans.rs 的 tests）用本地 http 桩验了请求体/错误归类，
 * jsdom（tools/test-ui.js）验了界面逻辑；这条脚本补上剩下那一块：
 *   · 真 exe + 真 WebView2 + 真 reqwest，走完整条 trans_run 链路；
 *   · **两家引擎并行**各发一次（mock 的 JSONL 里数得到）；
 *   · 一家 401、一家 200 时互不连坐（截图 + mock 日志双重为证）；
 *   · 翻译窗真的把两家并排摆出来（全屏截图，人工/模型复核）。
 *
 * 隔离手段（一样都不少）：
 *   · QS_INSTANCE_TAG  —— 单实例互斥体另起一份，用户自己的实例（管理员权限）
 *                         可以照常开着，互不干扰；
 *   · QS_DATA_DIR      —— 配置/日志全落 scratch 目录，绝不碰真实数据；
 *   · QS_NO_CLOUD=1    —— 双保险，隔离实例不许碰云端同步；
 *   · --no-elevate     —— 不弹 UAC。
 *
 * 用法：node tools/run-trans-e2e.js
 * 产出：tools/_trans-e2e.result.txt（结论）+ tools/_trans-e2e-*.png（截图）
 *       + tools/_trans-e2e.mock.jsonl（mock 收到的每个请求）
 *       （都带 `_` 前缀 —— .gitignore 里"重跑就有"的产物不入库）
 * 环境变量：QS_E2E_EXE —— 换一个 exe 来验（比如发版时验部署到
 *           D:\software\myself\ 那一份，默认验 target/release 的）。
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? path.resolve(process.env.QS_E2E_EXE)
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const MOCK = path.join(__dirname, 'trans-e2e-mock.js');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}/v1`;
const MOCK_LOG = path.join(__dirname, '_trans-e2e.mock.jsonl');
const RESULT = path.join(__dirname, '_trans-e2e.result.txt');
const SCRATCH = path.join(__dirname, '.trans-e2e-data');

const TEXT = 'Hello from QuickSearch e2e. 这是翻译联调文字。';

/* WebView2 额外参数：默认那一串（--disable-gpu-sandbox 是必须的，见 main.rs
 * 的 DEFAULT_WV_ARGS）+ e2e 专用的远程调试端口。⚠ additional_browser_args 是
 * **整体替换**，所以默认那串必须原样带上，否则渲染会黑屏。
 *
 * 端口**每次运行随机**一个：WebView2 的调试端口是"先到先得"，上一次跑剩下
 * 的浏览器进程还占着 9333 的话，这一次的页面就静默不进 CDP（表现是探针
 * 连得上、却列不出 trans.html 目标）。随机端口让每次跑都不受上一次影响。 */
const CDP_PORT = 9400 + Math.floor(Math.random() * 300);
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ` --disable-gpu-sandbox --remote-debugging-port=${CDP_PORT}`;
const CDP_PROBE = path.join(__dirname, 'trans-cdp-probe.js');

const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const ok = (cond, name, detail) => {
    say((cond ? 'OK   ' : 'NO   ') + name + (!cond && detail ? '\n       ' + String(detail) : ''));
    if (!cond) fails++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 场景配置：两家引擎都指向本地 mock（base 覆盖注册表预置值）。
 *
 * ⚠ `backup_dir` 必须显式指到 scratch 里：备份目录的默认值是
 * **exe 旁边**的 `QuickSearch back\`（见 config.rs 的 default_backup_dir），
 * 它**不认** QS_DATA_DIR。拿部署版 exe 跑联调时，不设这一条就会把测试用的
 * 残缺配置备份写进用户真实的备份目录，还会把保留名额挤掉。 */
function conf(over) {
    return Object.assign({
        trans_enable: true,
        trans_engine: 'deepseek',
        trans_multi: ['siliconflow'],
        trans_target: 'en',
        trans_keys: { deepseek: 'sk-mock-ds', siliconflow: 'sk-mock-sf' },
        trans_bases: { deepseek: BASE, siliconflow: BASE },
        trans_models: { deepseek: 'mock-deepseek', siliconflow: 'mock-sf' },
        bar_list: ['百度', 'Google', '@trans'],
        backup_dir: path.join(SCRATCH, 'backups'),
    }, over || {});
}

/** 起一份隔离实例，等它把翻译窗开出来，再杀掉。返回 { pid, log, dom, leaked }。
 *  `leaked` = 这次跑**新写进 exe 旁边备份目录**的文件（正常应为空，
 *  见 conf() 里 backup_dir 的注释）。 */
async function runOnce(cfg, shotPath, waitMs) {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

    /* 安全网：备份目录的默认值在 exe 旁边且不认 QS_DATA_DIR（见 conf() 的注释）。
     * 跑之前先把那里的文件清单拍下来，跑完再比一次 —— 真漏了要当场报出来，
     * 而不是等用户在备份列表里看见一堆测试残留。 */
    const exeBackupDir = path.join(path.dirname(EXE), 'QuickSearch back');
    const before = new Set(fs.existsSync(exeBackupDir)
        ? fs.readdirSync(exeBackupDir) : []);

    const env = Object.assign({}, process.env, {
        QS_INSTANCE_TAG: 'trans-e2e',
        QS_DATA_DIR: SCRATCH,
        QS_NO_CLOUD: '1',
        QS_DEBUG: '1',
        QS_T_WV_ARGS: WV_ARGS,
        QS_T_TRANS_TEXT: TEXT,
    });
    const proc = spawn(EXE, ['--trans-demo', '--no-elevate'], { env, cwd: ROOT, detached: false });
    await sleep(waitMs);

    if (shotPath) {
        const shot = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(__dirname, 'shot.ps1'), shotPath], { encoding: 'utf8' });
        say('  截图：' + (shot.stdout || '').trim().split('\n').pop());
    }

    /* 读一次真 DOM（CDP）。放在杀进程之前 —— 进程一杀页面就没了。 */
    const cdpOut = path.join(__dirname, '_trans-e2e.dom.txt');
    const probe = spawnSync(process.execPath,
        [CDP_PROBE, cdpOut, '--wait-ms', '400', '--port', String(CDP_PORT)],
        { encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { CDP_PORT: String(CDP_PORT) }) });
    const dom = parseDom(cdpOut);
    if (probe.stdout) say('  CDP（端口 ' + CDP_PORT + '）：' + probe.stdout.trim());

    /* 收尾：先收**这一份实例**的 WebView2 子进程（按父进程号点名，绝不碰
     * 别的应用的 WebView2），再收主进程。直接 taskkill /T 有时收不干净，
     * 剩下的浏览器进程会把调试端口占着，影响下一次跑。 */
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"`
        + ` | Where-Object { $_.ParentProcessId -eq ${proc.pid} }`
        + ` | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { encoding: 'utf8' });
    try { proc.kill(); } catch (e) { /* 已经没了 */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { encoding: 'utf8' });
    await sleep(800);

    const logFile = path.join(SCRATCH, 'log.txt');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const after = new Set(fs.existsSync(exeBackupDir)
        ? fs.readdirSync(exeBackupDir) : []);
    const leaked = [...after].filter((f) => !before.has(f));
    return { pid: proc.pid, log, dom, leaked };
}

/** 把 CDP 探针的输出解析成对象（`KEY value` + `<<< >>>` 多行块）。
 *  块分两种：`KEY <<<`（纯文本）和 `PANE <i> <<<`（每行一个 `字段=值`）。 */
function parseDom(file) {
    const d = { panes: [] };
    if (!fs.existsSync(file)) return d;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let block = null;
    for (const line of lines) {
        if (block) {
            if (line === '>>>') {
                if (block.key === 'PANE') d.panes.push(block.obj);
                else d[block.key] = block.buf.join('\n');
                block = null;
            } else if (block.key === 'PANE') {
                const i = line.indexOf('=');
                if (i > 0) block.obj[line.slice(0, i)] = line.slice(i + 1);
            } else {
                block.buf.push(line);
            }
            continue;
        }
        const i = line.indexOf(' ');
        const key = i < 0 ? line : line.slice(0, i);
        const rest = i < 0 ? '' : line.slice(i + 1);
        if (rest.slice(-3) === '<<<') {
            block = { key, buf: [], obj: {} };
            continue;
        }
        d[key] = rest;
    }
    return d;
}

/** mock 收到的请求（每次跑之前清档）。 */
function mockReqs() {
    if (!fs.existsSync(MOCK_LOG)) return [];
    return fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean);
}
function resetMockLog() { try { fs.unlinkSync(MOCK_LOG); } catch (e) { /* 头一次没有 */ } }

(async function main() {
    say('=== 翻译多引擎真机端到端自测（v1.5.16） ===');
    say('exe: ' + EXE);

    // ---------- 0. mock 服务 ----------
    resetMockLog();
    const mock = spawn(process.execPath, [MOCK, String(PORT)], { cwd: ROOT });
    await sleep(700);
    let mockUp = false;
    for (let i = 0; i < 20 && !mockUp; i++) {
        const r = spawnSync(process.execPath, ['-e',
            `require('http').get('http://127.0.0.1:${PORT}/v1/models',r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',()=>process.exit(1))`],
            { encoding: 'utf8' });
        mockUp = r.status === 0;
        if (!mockUp) await sleep(300);
    }
    ok(mockUp, `mock OpenAI 兼容服务已在 127.0.0.1:${PORT} 起来`);
    if (!mockUp) {
        say('mock 没起来，后面的场景都失去意义，收工');
        try { mock.kill(); } catch (e) { /* 已经没了 */ }
        finish(1);
        return;
    }

    /* ---------- 场景一：两家都正常 → 并行各发一次，并排摆出来 ---------- */
    say('');
    say('--- 场景一：两家引擎都通（并行 + 并排呈现） ---');
    resetMockLog();
    const r1 = await runOnce(conf(), path.join(__dirname, '_trans-e2e-1-both.png'), 6500);

    const reqs = mockReqs().filter((r) => r.method === 'POST'
        && String(r.url).indexOf('/chat/completions') >= 0);
    ok(reqs.length === 2, '两家引擎各发了一次翻译请求（共 2 次）',
        reqs.map((r) => r.model + ' @ ' + r.url).join(' | ') || '（一次都没有）');
    const models = reqs.map((r) => r.model).sort();
    ok(JSON.stringify(models) === JSON.stringify(['mock-deepseek', 'mock-sf']),
        '各带自己家的模型（deepseek / siliconflow 不串门）', models.join(','));
    const auths = reqs.map((r) => r.auth).sort();
    ok(auths[0] === 'Bearer sk-mock-ds' && auths[1] === 'Bearer sk-mock-sf',
        '各带自己家的 Key（分 map 存储生效）', auths.join(' | '));
    const t0 = reqs.length ? new Date(reqs[0].t).getTime() : 0;
    const spread = reqs.length === 2 ? Math.abs(new Date(reqs[1].t).getTime() - t0) : -1;
    ok(spread >= 0 && spread < 1500, '两次请求是并行发出的（间隔 ' + spread + 'ms，不是串行等）',
        spread);
    const sys = (reqs[0] && reqs[0].messages && reqs[0].messages[0] && reqs[0].messages[0].content) || '';
    ok(sys.indexOf('English') >= 0 && sys.indexOf('只输出译文') >= 0,
        '系统提示词带目标语言（English）+ 「别加前言」约束', sys.slice(0, 120));
    const users = reqs.map((r) => (r.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join(''));
    ok(users.every((u) => u.indexOf('QuickSearch e2e') >= 0),
        '原文原样进了请求体（横条/OCR 带过来的那段文字）', users.join(' || '));
    ok(r1.log.indexOf('trans win: built') >= 0, '翻译窗真的建起来了（日志有据）',
        r1.log.split('\n').filter((l) => l.indexOf('trans') >= 0).slice(-3).join(' / ') || '（日志里没有 trans 字样）');
    ok(fs.existsSync(path.join(__dirname, '_trans-e2e-1-both.png')),
        '场景一截图已留档（tools/_trans-e2e-1-both.png，人工/模型复核两家并排）');
    ok(r1.leaked.length === 0, '联跑没有往 exe 旁边的真实备份目录里写东西',
        r1.leaked.join(', '));

    /* ---- 真 DOM（CDP 读的，不是猜的） ---- */
    const d1 = r1.dom;
    say('');
    say('--- 场景一：翻译窗真 DOM（CDP 读取） ---');
    ok(d1.panes.length === 2, '页面里真有两个译文框（.tp × 2）', '实际 ' + d1.panes.length);
    const p1 = d1.panes[0] || {}, p2 = d1.panes[1] || {};
    ok(p1.id === 'deepseek' && p2.id === 'siliconflow', '两家按注册表顺序排（deepseek 在前）',
        (p1.id || '?') + ',' + (p2.id || '?'));
    ok(/DeepSeek/.test(p1.name || '') && /mock-deepseek/.test(p1.name || ''),
        '第一框标题带着引擎名 + 模型名', p1.name);
    ok(/硅基流动/.test(p2.name || '') && /mock-sf/.test(p2.name || ''),
        '第二框标题带着引擎名 + 模型名', p2.name);
    ok((p1.st || '').indexOf('已完成') >= 0 && (p2.st || '').indexOf('已完成') >= 0,
        '两家状态都是「已完成」', (p1.st || '?') + ' / ' + (p2.st || '?'));
    ok((p1.ta || '').indexOf('【mock·mock-deepseek】') >= 0
        && (p1.ta || '').indexOf('QuickSearch e2e') >= 0,
        'DeepSeek 的译文落进了它自己的框', p1.ta);
    ok((p2.ta || '').indexOf('【mock·mock-sf】') >= 0
        && (p2.ta || '').indexOf('QuickSearch e2e') >= 0,
        '硅基流动的译文落进了它自己的框（没被别家覆盖）', p2.ta);
    ok((p1.ta || '').indexOf('mock-sf') < 0 && (p2.ta || '').indexOf('mock-deepseek') < 0,
        '两框内容没有互相串门');
    ok((d1.SRC || '').indexOf('QuickSearch e2e') >= 0, '原文框里是带过来的那段文字', d1.SRC);
    ok(d1.TARGET === 'en', '目标语言下拉是配置里的默认值 en', d1.TARGET);
    ok((d1.ENGCAP || '').indexOf('2') >= 0, '顶部摘要标出参与几家', d1.ENGCAP);
    ok(d1.NOTE_HIDDEN === '1' || !(d1.NOTE_TEXT || '').trim(),
        '两家都成功时汇总条不出现', d1.NOTE_TEXT);

    /* ---------- 场景二：一家 401、一家 200 → 不连坐 ---------- */
    say('');
    say('--- 场景二：一家 Key 是坏的（401）、一家好的 → 互不连坐 ---');
    resetMockLog();
    const r2 = await runOnce(conf({ trans_models: { deepseek: 'mock-bad-key', siliconflow: 'mock-sf' } }),
        path.join(__dirname, '_trans-e2e-2-onebad.png'), 6500);

    const reqs2 = mockReqs().filter((r) => r.method === 'POST'
        && String(r.url).indexOf('/chat/completions') >= 0);
    ok(reqs2.length === 2, '照样是两家各发一次（失败也发，不吞请求）',
        reqs2.map((r) => r.model).join(','));
    ok(reqs2.some((r) => r.model === 'mock-bad-key') && reqs2.some((r) => r.model === 'mock-sf'),
        '坏的那家照旧发自己的请求（mock 会回它 401）',
        reqs2.map((r) => r.model).join(','));
    const transLog = r2.log.split('\n').filter((l) => l.indexOf('trans') >= 0);
    say('  （日志里的 trans 行：' + (transLog.slice(-4).join(' / ') || '无') + '）');
    ok(fs.existsSync(path.join(__dirname, '_trans-e2e-2-onebad.png')),
        '场景二截图已留档（tools/_trans-e2e-2-onebad.png，一家有译文、一家显示失败原因）');

    /* ---- 真 DOM：一家红、一家绿，错误只挂在失败那一家身上 ---- */
    const d2 = r2.dom;
    say('');
    say('--- 场景二：翻译窗真 DOM（CDP 读取） ---');
    ok(d2.panes.length === 2, '照样是两个框', '实际 ' + d2.panes.length);
    const q1 = d2.panes[0] || {}, q2 = d2.panes[1] || {};
    ok((q1.st || '').indexOf('失败') >= 0 && q1.bad === '1',
        'Key 坏的那一家的状态是「失败」（红字）', (q1.st || '?') + ' bad=' + q1.bad);
    ok((q1.note || '').indexOf('DeepSeek') >= 0 && (q1.note || '').indexOf('401') >= 0,
        '它自己的 note 里带着 401 和厂商名（Rust 归类好的人话）', q1.note);
    ok(!q1.ta || !q1.ta.trim(), '失败那家的译文框是空的（不塞别家的译文）', q1.ta);
    ok((q2.st || '').indexOf('已完成') >= 0
        && (q2.ta || '').indexOf('【mock·mock-sf】') >= 0,
        '另一家照常出译文（一家挂不连坐另一家）', (q2.st || '?') + ' / ' + q2.ta);
    ok((d2.NOTE_HIDDEN === '0') && (d2.NOTE_TEXT || '').indexOf('401') >= 0,
        '汇总条也报了这一家的错', d2.NOTE_TEXT);
    ok(r2.leaked.length === 0, '联跑没有往 exe 旁边的真实备份目录里写东西',
        r2.leaked.join(', '));

    /* ---------- 收尾 ---------- */
    try { mock.kill(); } catch (e) { /* 已经没了 */ }
    spawnSync('taskkill', ['/IM', 'QuickSearch.exe', '/FI', 'PID eq ' + r1.pid, '/T', '/F'], { encoding: 'utf8' });
    fs.rmSync(SCRATCH, { recursive: true, force: true });

    say('');
    say('=== 结论：' + (fails ? fails + ' 项没过' : '全部通过') + ' ===');
    finish(fails ? 1 : 0);
})();

function finish(code) {
    fs.writeFileSync(RESULT, out.join('\n') + '\n', 'utf8');
    process.exit(code);
}
