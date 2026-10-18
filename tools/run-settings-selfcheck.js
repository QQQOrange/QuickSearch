/* ============================================================================
 *  设置页「内建自检」跑一遍，收集结果
 *
 *  设置页里本来就带一段 qsSelfTest()（见 ui/settings.js）：它在**真 WebView**
 *  里用 element.click() 驱动真控件、走真 invoke 往返，再把
 *  `[js] SELFTEST PASS/FAIL xxx` 打进日志。只在 QS_SELFTEST=1 时跑。
 *
 *  这个脚本就是把它跑起来、把日志里的 SELFTEST 行捞出来判分。
 *  比在外面注入鼠标点可靠得多（不受 DPI、窗口位置、时序影响）。
 *
 *  用法：node tools/run-settings-selfcheck.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const LOG = path.join(process.env.APPDATA || '', 'QuickSearch', 'log.txt');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function killOld() {
    try { execSync('taskkill /IM QuickSearch.exe /F', { stdio: 'ignore' }); } catch (e) { }
    sleep(900);
}

function readLog() {
    try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; }
}

(function main() {
    killOld();
    const mark = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

    const env = Object.assign({}, process.env, {
        QS_DEBUG: '1', QS_SELFTEST: '1', QS_NO_ELEVATE: '1',
    });
    spawn(EXE, ['--no-elevate', '--settings'],
        { env, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    console.log('已启动 QuickSearch.exe --settings（QS_SELFTEST=1）');

    // 自检里有一堆 await wait(...)，整段跑完要十几秒；给足时间。
    sleep(30000);

    const buf = fs.readFileSync(LOG);
    const fresh = buf.slice(mark).toString('utf8');
    const lines = [...fresh.matchAll(/\[js\] SELFTEST (.+)/g)].map((m) => m[1].trim());

    killOld();

    if (!lines.length) {
        console.log('没有拿到任何 SELFTEST 行 —— 自检没跑起来（检查 QS_SELFTEST 是否被读到）');
        process.exit(1);
    }

    let pass = 0, fail = 0;
    for (const l of lines) {
        if (l === 'begin') continue;
        // 自检里还夹着一些不带 PASS/FAIL 的进度行（done / RESTORED …），
        // 它们不是断言，原样打出来但不计分 —— 否则会被误判成 FAIL。
        if (l.startsWith('PASS')) { pass++; console.log('PASS  ' + l.slice(4).trim()); }
        else if (l.startsWith('FAIL')) { fail++; console.log('FAIL  ' + l.slice(4).trim()); }
        else console.log('  ·  ' + l);
    }
    console.log('\n' + pass + '/' + (pass + fail) + ' passed');
    process.exit(fail === 0 ? 0 : 1);
})();
