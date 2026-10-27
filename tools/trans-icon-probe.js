/* ============================================================================
 *  翻译按钮默认图标 · 真机 DOM 取证（#49）
 *
 *  截图裁不准（多显示器 + DPI 缩放 + 透明窗 PrintWindow 全黑），改成
 *  直接问 WebView：翻译按钮里那个 <img> 的 src 是不是内置的
 *  data/icons/trans.png、有没有真的加载出来（naturalWidth > 0）。
 *
 *  用隔离实例（独立 APPDATA / WEBVIEW2_USER_DATA_FOLDER）+ CDP，
 *  不碰用户的生产实例。
 *
 *  用法：node tools/trans-icon-probe.js
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.QS_E2E_EXE
    ? process.env.QS_E2E_EXE
    : path.join(ROOT, 'target', 'release', 'QuickSearch.exe');
const PORT = 9349;
const WV_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
    + ' --disable-gpu-sandbox --remote-debugging-port=' + PORT;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const L = [];
function rec(s) { L.push(s); console.log(s); }
function ok(cond, name, extra) {
    const line = (cond ? 'OK  ' : 'NO  ') + name + (extra ? ' → ' + extra : '');
    rec(line);
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
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
}
async function connect(sub) {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-transicon-'));
    const qs = path.join(tmp, 'QuickSearch');
    fs.mkdirSync(qs, { recursive: true });
    const conf = {
        trans_enable: true,
        trans_engine: 'deepseek',
        trans_keys: { deepseek: 'sk-probe' },
        bar_list: ['@trans'],
        bar_idle_sec: 0,
        bar_away_px: 0,
        shadow: false,
        bar_need_text: false,
    };
    fs.writeFileSync(path.join(qs, 'config.json'), JSON.stringify(conf, null, 2), 'utf8');

    const env = Object.assign({}, process.env, {
        // ⚠ QS_DATA_DIR 才是**真正**的隔离开关：程序的数据目录「便携优先」，
        //   压根不看 APPDATA（见 src/config.rs 的 data_dir()）。
        //   只设 APPDATA 的话，隔离实例会跟开发目录共用同一份 config/log，
        //   而且那份 config 是**加密**的 —— 探针会莫名其妙地启动失败。
        QS_DATA_DIR: path.join(tmp, 'QuickSearch'),
        APPDATA: tmp, LOCALAPPDATA: tmp, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
        QS_INSTANCE_TAG: '-probe-transicon', QS_T_WV_ARGS: WV_ARGS,
    });
    const proc = spawn(EXE, ['--no-elevate', '--bar'], { env, cwd: ROOT, detached: false, stdio: 'ignore' });
    rec('隔离实例 PID=' + proc.pid);

    const ws = await connect('tauri.localhost/');
    if (!ws) { rec('CDP 连不上'); try { proc.kill(); } catch (e) { } process.exit(1); }
    rec('CDP 已连上');
    await sleep(2500);

    /* ① 横条上的翻译按钮 */
    const r1 = await evalJs(ws, `(function(){
      var b = document.querySelector('#engines .qs-trans-inbar');
      if (!b) return { found:false };
      var img = b.querySelector('img');
      var span = b.querySelector('.qs-trans-tag,.trans-tag');
      return {
        found: true,
        html: b.innerHTML.slice(0, 300),
        imgSrc: img ? img.getAttribute('src') : null,
        natural: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
        complete: img ? img.complete : null,
        badgeText: span ? span.textContent : null,
        imgCount: b.querySelectorAll('img').length,
      };
    })()`);
    rec('横条翻译按钮：' + JSON.stringify(r1));
    ok(r1.found, '横条渲染出翻译按钮');
    ok(r1.imgCount === 1 && /data\/icons\/trans\.png$/.test(r1.imgSrc || ''),
        '  按钮里是内置的「翻译.png」<img>', r1.imgSrc);
    ok(r1.natural && r1.natural !== '0x0', '  这张图**真的加载出来了**', r1.natural);
    ok(!r1.badgeText, '  没有退回「译」文字徽标', String(r1.badgeText));

    /* ② 换一张自定义图：用户的图必须优先于内置默认图 */
    await evalJs(ws, `(function(){
      var b = document.querySelector('#engines .qs-trans-inbar');
      b.click();
      return true;
    })()`);
    await sleep(500);

    /* ③ 直接改配置里的 overrideIcons，重渲染后应显示用户那张 */
    await evalJs(ws, `(function(){
      var c = window.CONF || {};
      c.overrideIcons = c.overrideIcons || {};
      c.overrideIcons['@trans'] = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      return true;
    })()`);
    await evalJs(ws, '(function(){ if (window.renderBar) { renderBar(true); return 1; } return 0; })()');
    await sleep(900);
    const r3 = await evalJs(ws, `(function(){
      var b = document.querySelector('#engines .qs-trans-inbar');
      if (!b) return { found:false };
      var img = b.querySelector('img');
      return { found:true, imgSrc: img ? img.getAttribute('src') : null,
               natural: img ? img.naturalWidth+'x'+img.naturalHeight : null };
    })()`);
    rec('换成自定义图后：' + JSON.stringify(r3));
    ok(/base64/.test(r3.imgSrc || ''), '  用户换过的图优先于内置默认图', r3.imgSrc);

    /* ④ 设置页：横条列表里的 @trans 成员行 + 预览 */
    try { await evalJs(ws, "(function(){ if (window.__TAURI__) { window.__TAURI__.core.invoke('open_settings'); return 1; } return 0; })()"); } catch (e) { }
    await sleep(3500);
    const setWs = await connect('settings.html');
    if (!setWs) {
        rec('设置页 CDP 没连上（跳过设置页验证）');
    } else {
        rec('设置页 CDP 已连上');
        await sleep(1500);
        const r4 = await evalJs(setWs, `(function(){
          var rows = document.querySelectorAll('#barList .trans-row-item');
          var hit = null;
          for (var i=0;i<rows.length;i++){
            var nm = rows[i].querySelector('.nm');
            if (nm && nm.textContent.indexOf('翻译') >= 0) { hit = rows[i]; break; }
          }
          if (!hit) return { found:false, rowCount: rows.length };
          var img = hit.querySelector('img');
          var badge = hit.querySelector('.trans-tag,.qs-trans-tag');
          return {
            found:true,
            imgSrc: img ? img.getAttribute('src') : null,
            natural: img ? img.naturalWidth+'x'+img.naturalHeight : null,
            badgeText: badge ? badge.textContent : null,
            imgCount: hit.querySelectorAll('img').length,
          };
        })()`);
        rec('设置页 @trans 成员行：' + JSON.stringify(r4));
        ok(r4.found, '设置页渲染出 @trans 成员行');
        ok(r4.imgCount === 1 && /data\/icons\/trans\.png$/.test(r4.imgSrc || ''),
            '  成员行图标是内置的「翻译.png」', r4.imgSrc);
        ok(r4.natural && r4.natural !== '0x0', '  设置页那张图也真的加载出来了', r4.natural);
    }

    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    fs.writeFileSync(path.join(__dirname, 'trans-icon-probe.txt'), L.join('\n'), 'utf8');
    process.exit(0);
})().catch((e) => {
    rec('ERR ' + (e && e.stack || e));
    fs.writeFileSync(path.join(__dirname, 'trans-icon-probe.txt'), L.join('\n'), 'utf8');
    process.exit(1);
});
