/* ============================================================================
 *  「启动后无响应」真机复现 / 回归探针
 *
 *  复现的 bug（用户原话）：
 *    「应用启动后经常出现无响应的情况：系统托盘显示该应用已开启，选中文字时
 *      没有任何反应，点击托盘图标既不弹出右键菜单，也无法唤起软件主界面。」
 *
 *  根因：主线程事件循环被死锁。
 *    - 同步 Tauri 命令跑在**主线程**上（tauri-macros `body_blocking`）；
 *    - tauri-runtime-wry 的 `run_on_main_thread` 在主线程上**当场内联执行**
 *      闭包（`send_user_message` 主线程分支直接调 `handle_user_message`，不排队）；
 *    - 于是 `WebviewWindowBuilder::build()` 跑在这次 invoke 的栈里 →
 *      主线程建 WebView2 时要泵消息，与尚未释放的命令锁互相卡死。
 *
 *  探针怎么验：
 *    在**同步命令栈**里调 `ocr_warm`（没配 Key 时它会 `ocr_tell(important=true)`
 *    → `open_ocr_window` 建窗 —— 正是当年漏掉 spawn 的那条路）。
 *    如果死锁：invoke 永远不返回，**之后所有** CDP 求值也会一起卡死。
 *    如果修好：invoke 立刻返回，OCR 窗口正常建出来，主线程继续转。
 *
 *  用法：node tools/hang-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? process.env.QS_E2E_EXE
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9351;
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
            reject(new Error('CDP 超时 ' + timeoutMs + 'ms: ' + method));
        }, timeoutMs || 10000);
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
        { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs || 10000);
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

/** 用 SendMessageTimeout(WM_NULL) 测目标进程主线程还活着吗。 */
function probeThreadAlive(pid) {
    const ps = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
"@
$res = New-Object System.Collections.ArrayList
$cb = [W+EnumWindowsProc]{
  param($h,$l)
  $p = 0
  [W]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq ${pid}) {
    $sb = New-Object System.Text.StringBuilder 256
    [W]::GetWindowText($h, $sb, 256) | Out-Null
    $r = [IntPtr]::Zero
    $ok = [W]::SendMessageTimeout($h, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$r)
    [void]$res.Add([pscustomobject]@{ HWND=$h.ToInt64(); Title=$sb.ToString(); Visible=[W]::IsWindowVisible($h); Responding=($ok -ne [IntPtr]::Zero) })
  }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$res | ConvertTo-Json -Compress
`;
    try {
        const out = execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', ps],
            { encoding: 'utf8', timeout: 40000 });
        const txt = out.trim();
        if (!txt) return [];
        const j = JSON.parse(txt);
        return Array.isArray(j) ? j : [j];
    } catch (e) { return null; }
}

(async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-hang-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    // 故意**不配** ocr key：`ocr_warm` 会走 `ocr_tell(important=true)` → 建 OCR 窗。
    const conf = {
        bar_list: ['@trans'],
        bar_idle_sec: 0,
        bar_away_px: 0,
        shadow: false,
        bar_need_text: false,
        ocr_key: '',
        ocr_secret: '',
    };
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(conf, null, 2), 'utf8');

    const env = Object.assign({}, process.env, {
        // ⚠ QS_DATA_DIR 才是**真正**的隔离开关：程序的数据目录「便携优先」，
        //   压根不看 APPDATA（见 src/config.rs 的 data_dir()）。
        //   只设 APPDATA 的话，隔离实例会跟开发目录共用同一份 config/log，
        //   而且那份 config 是**加密**的 —— 探针会莫名其妙地启动失败。
        QS_DATA_DIR: path.join(tmp, 'QuickSearch'),
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_INSTANCE_TAG: '-probe-hang', QS_T_WV_ARGS: WV_ARGS, QS_NO_ELEVATE: '1',
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('隔离实例 PID=' + proc.pid);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上'); try { proc.kill(); } catch (e) { } process.exit(1); }
    rec('CDP 已连上');
    await sleep(2500);

    /* ① 基线：主线程此刻是活的 */
    const base = probeThreadAlive(proc.pid);
    rec('基线窗口：' + JSON.stringify(base));
    ok(Array.isArray(base) && base.some((w) => w.Responding === true), '主线程基线正常响应');
    ok(base && base.every((w) => w.Responding === true), '  所有窗口都响应', JSON.stringify(base));

    /* ② 在同步命令栈里触发建窗路径（当年死锁的那条） */
    rec('--- 调 ocr_warm（同步命令 → ocr_tell → open_ocr_window）---');
    const t0 = Date.now();
    let invokeRet = null, invokeErr = null;
    try {
        invokeRet = await evalJs(ws,
            `(function(){
               if (!window.__TAURI__) return { skipped:true };
               return window.__TAURI__.core.invoke('ocr_warm').then(
                 function(){ return { ok:true }; },
                 function(e){ return { err:String(e) }; });
             })()`, 15000);
    } catch (e) {
        invokeErr = String(e && e.message || e);
    }
    const dt = Date.now() - t0;
    rec('invoke 结果：' + JSON.stringify({ ret: invokeRet, err: invokeErr, ms: dt }));
    ok(!invokeErr, '同步命令 invoke 有返回（没卡死）', invokeErr || ('耗时 ' + dt + 'ms'));
    ok(!invokeErr && dt < 8000, '  invoke 在 8 秒内返回', dt + 'ms');

    /* ③ OCR 窗口是否真的建出来了 */
    await sleep(2000);
    const ts = await listTargets();
    const ocrHit = ts.find((t) => (t.url || '').indexOf('ocr.html') >= 0);
    ok(!!ocrHit, 'OCR 窗口建出来了', ocrHit ? ocrHit.url : '没找到 ocr.html target');

    /* ④ 关键：主线程还活着吗（划词 / 托盘 / 双击全靠它） */
    const after = probeThreadAlive(proc.pid);
    rec('事后窗口：' + JSON.stringify(after));
    ok(Array.isArray(after) && after.length > 0, '还能枚举到窗口');
    ok(after && after.every((w) => w.Responding === true),
        '  所有窗口主线程仍然响应（托盘/划词/双击的命脉）', JSON.stringify(after));

    /* ⑤ 再调一次别的同步命令，验证事件循环还在转 */
    const r5 = await evalJs(ws,
        `(function(){
           if (!window.__TAURI__) return { skipped:true };
           return window.__TAURI__.core.invoke('app_is_locked').then(
             function(v){ return { v: v }; }, function(e){ return { err:String(e) }; });
         })()`, 8000).catch((e) => ({ err: String(e.message || e) }));
    rec('app_is_locked 结果：' + JSON.stringify(r5));
    ok(r5 && !r5.err, '事件循环仍在处理后续命令', JSON.stringify(r5));

    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    fs.writeFileSync(path.join(__dirname, 'hang-probe.txt'), L.join('\n'), 'utf8');
    rec(FAILED ? ('\n❌ 有 ' + FAILED + ' 项失败') : '\n✅ 全部通过');
    process.exit(FAILED ? 1 : 0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    fs.writeFileSync(path.join(__dirname, 'hang-probe.txt'), L.join('\n'), 'utf8');
    process.exit(1);
});
