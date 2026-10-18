/* ============================================================================
 *  r55：路径判据的「双实现一致性」探针
 *
 *  背景：`paths::looks_like_path`（Rust）和 `qsLooksLikePath`（shared.js）是
 *  **同一套判据的两份实现** —— 前端要弹出图标、后端要真的去开，两边都得判。
 *  共享判据的麻烦在于：改了一边忘了另一边，症状是「有图标但点不开」或
 *  「能打开但没图标」，而且只在特定形态的字符串上现形。
 *
 *  这个探针把一批**边界样本**同时喂给两边，逐条比对结论：
 *    一致 → 记 PASS
 *    不一致 → 记 FAIL，并把两边的结论都打出来（一眼看出是哪边偏了）
 *
 *  Rust 侧怎么取值：`looks_like_path` 是 pub fn，写一个临时单测把它
 *  跑成 CSV 打出来（见 _paths-crosscheck.rs 那个文件，跑完即删）。
 *  JS 侧直接在 Node 里 require shared.js 求值（那边只依赖 window）。
 *
 *  用法：node tools/r55-paths-crosscheck.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NODE = 'C:/Users/64381/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe';

/* ---- 边界样本：每一条都是历史上栽过或可能栽的形态 ---- */
const CASES = [
    // ① 盘符
    'C:\\Users\\me\\a.txt',
    'c:/Users/me/a.txt',
    'D:\\data',
    'C:\\',
    'C:',
    'C:abc',
    'C:\\Users\\me\\a.txt\\',
    '1:\\not-a-drive',
    // ② UNC
    '\\\\server\\share\\a.txt',
    '\\\\server\\share',
    '\\\\s',
    '\\\\',
    '//server/share/a.txt',
    // ③ 相对路径
    '.\\bin\\tool.exe',
    './bin/tool.exe',
    '..\\a\\b.txt',
    '../a/b.txt',
    '.',
    '..',
    './',
    '.\\',
    '.a\\b',
    // ④ 环境变量
    '%APPDATA%\\QuickSearch',
    '%TEMP%',
    '%APPDATA%',
    '%A%\\b',
    'a%APPDATA%\\b',
    'a\\%APPDATA%\\b',
    '%_UNDERSCORE%\\x',
    '%%',
    '%1%',
    // ⑤ 网址（必须都不是）
    'https://example.com/a',
    'http://a.com',
    'ftp://x',
    'file:///C:/a.txt',
    'www.example.com',
    'example.com',
    // ⑥ 文件名 / 句子（必须都不是）
    'index.html',
    'package.json',
    'bin\\tool.exe',
    'backup.zip',
    '版本1.2',
    '张三.李四',
    'hello world',
    // ⑦ 引号 / 空白
    '"C:\\Program Files\\x"',
    "'D:\\a'",
    '   ',
    '',
    'C:\\Users\\me\\a.txt  ',
    // ⑧ 长度边界
    'C:\\' + 'a'.repeat(300),
];

(async function main() {
    const L = [];
    let pass = 0, fail = 0;
    const rec = (s) => { L.push(s); console.log(s); };
    const flush = () => fs.writeFileSync(path.join(__dirname, 'r55-paths-crosscheck.txt'), L.join('\n'), 'utf8');
    const check = (name, ok, extra) => {
        if (ok) { pass++; rec('PASS  ' + name); }
        else { fail++; rec('FAIL  ' + name + (extra !== undefined ? '   [' + extra + ']' : '')); }
    };

    /* ---------- 1. JS 侧 ---------- */
    // shared.js 只往 window 上挂东西，Node 里造一个 window 再 eval
    const jsSrc = fs.readFileSync(path.join(ROOT, 'ui', 'shared.js'), 'utf8');
    const win = {};
    const vm = require('vm');
    const ctx = vm.createContext({ window: win, navigator: { userAgent: 'node' }, document: undefined });
    vm.runInContext(jsSrc, ctx);
    const jsFn = win.qsLooksLikePath;
    check('shared.js 导出了 qsLooksLikePath', typeof jsFn === 'function');
    if (typeof jsFn !== 'function') { flush(); process.exit(1); }
    const jsRes = CASES.map((c) => { try { return !!jsFn(c); } catch (e) { return 'ERR'; } });

    /* ---------- 2. Rust 侧：跑一个临时单测把结果打成 CSV ---------- */
    const OUT_TXT = path.join(os.tmpdir(), 'qs-r55-paths-rust.txt');
    try { fs.unlinkSync(OUT_TXT); } catch (e) { }
    const tmpTest = path.join(ROOT, 'src', '_paths_crosscheck.rs');
    const casesJson = JSON.stringify(CASES);
    fs.writeFileSync(tmpTest,
        '//! r55 临时：把 paths::looks_like_path 对一批样本的结论打成 CSV（跑完即删）。\n'
        + '#[test]\nfn dump_paths_crosscheck() {\n'
        + '    let cases: Vec<String> = serde_json::from_str(' + JSON.stringify(casesJson) + ').unwrap();\n'
        + '    let mut out = String::new();\n'
        + '    for c in &cases {\n'
        + '        let r = crate::paths::looks_like_path(c);\n'
        + '        out.push_str(if r.is_some() { "true" } else { "false" });\n'
        + '        out.push(\'\\n\');\n'
        + '    }\n'
        + '    std::fs::write(' + JSON.stringify(OUT_TXT) + ', out).unwrap();\n'
        + '}\n', 'utf8');
    // 挂到 main.rs（临时）—— cargo 只认 mod 声明
    const mainRs = path.join(ROOT, 'src', 'main.rs');
    const orig = fs.readFileSync(mainRs, 'utf8');
    if (!orig.includes('mod _paths_crosscheck;')) {
        fs.writeFileSync(mainRs, orig.replace('mod clip;', 'mod _paths_crosscheck;\nmod clip;'), 'utf8');
    }
    let rustLines = null;
    try {
        execFileSync('C:/Users/64381/.cargo/bin/cargo.exe', ['test', '--release', 'dump_paths_crosscheck', '--', '--nocapture'],
            { cwd: ROOT, stdio: 'pipe' });
        if (fs.existsSync(OUT_TXT)) {
            rustLines = fs.readFileSync(OUT_TXT, 'utf8').trim().split(/\r?\n/);
        }
        check('Rust 侧单测跑通并输出了结果', Array.isArray(rustLines) && rustLines.length === CASES.length,
            '输出 ' + (rustLines ? rustLines.length : 0) + ' 行 / 期望 ' + CASES.length);
    } catch (e) {
        check('Rust 侧单测跑通', false, String(e.message).slice(0, 300));
    } finally {
        // 复原 main.rs、删临时文件
        fs.writeFileSync(mainRs, orig, 'utf8');
        try { fs.unlinkSync(tmpTest); } catch (e) { }
        try { fs.unlinkSync(OUT_TXT); } catch (e) { }
    }
    check('main.rs 已复原（临时 mod 声明没留下）', !fs.readFileSync(mainRs, 'utf8').includes('mod _paths_crosscheck;'));

    /* ---------- 3. 逐条比对 ---------- */
    rec('');
    rec('样本数：' + CASES.length + '；Rust 输出 ' + (rustLines ? rustLines.length : 0) + ' 行');
    rec('');
    rec('idx | JS   | Rust | 样本');
    let diff = 0;
    for (let i = 0; i < CASES.length; i++) {
        const j = jsRes[i];
        const r = rustLines ? String(rustLines[i]).trim() === 'true' : null;
        const show = CASES[i].length > 40 ? CASES[i].slice(0, 37) + '...' : CASES[i];
        const same = (r === null) ? false : (j === r);
        if (!same) diff++;
        rec(String(i).padStart(3) + ' | '
            + String(j).padEnd(5) + '| '
            + String(r === null ? '?' : r).padEnd(5) + '| '
            + JSON.stringify(show) + (same ? '' : '   ← 不一致'));
    }
    rec('');
    check('两份实现结论完全一致（' + CASES.length + ' 条样本）', diff === 0, diff + ' 条不一致');

    rec('');
    rec('========== r55 路径判据一致性：' + pass + ' PASS / ' + fail + ' FAIL ==========');
    flush();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    console.log('探针自身崩了：' + (e && e.stack ? e.stack : e));
    try { fs.writeFileSync(path.join(__dirname, 'r55-paths-crosscheck.txt'), String(e && e.stack), 'utf8'); } catch (_) { }
    process.exit(2);
});
