/* r62 探针：多选引擎要多标签页 + 并行上传（速度）
 *
 * 用户原话：
 *  「如果在识图搜索里面把引擎都勾选，那点击横条中的识图搜索框选完之后，
 *    就应该在不同的标签页里面打开不同的识图，这个是功能没做」
 *  「现在识图搜索速度好慢呢，可能要过一段时间才能真正的开始进行搜索」
 *
 * ⚠ 不真跑 img_region（会拉起浏览器、还会挡住后续 CDP）。这里验**代码形状**：
 *   · img_plan 在勾了多家时不再被默认引擎缩成一家；
 *   · 开标签页走 img_open_tab（不经 open_links 的 12 条上限、不再抽 URL）；
 *   · 上传是并行的（每家用线程 + channel）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'r62-probe.txt');
const L = []; let pass = 0, fail = 0;
const rec = (s) => { L.push(s); console.log(s); try { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); } catch (e) { } };
function check(n, ok, extra) {
    if (ok) { pass++; rec('PASS  ' + n); }
    else { fail++; rec('FAIL  ' + n + (extra !== undefined && extra !== null && extra !== '' ? '   [' + extra + ']' : '')); }
}
const main = fs.readFileSync(path.join(ROOT, 'src', 'main.rs'), 'utf8').replace(/\r\n/g, '\n');

rec('r62 探针：多标签页 + 并行上传');
rec('');

/* ---------- A. img_plan：勾了多家就全开 ---------- */
const planStart = main.indexOf('fn img_plan(');
const planEnd = main.indexOf('\nfn ', planStart + 10);
const plan = main.slice(planStart, planEnd < 0 ? main.length : planEnd);

check('A1 img_plan 里有 `multi`（勾多家 = 全部打开）的判断', /let multi = picked\.len\(\) >= 2;/.test(plan), plan.slice(0, 200));
check('A2 默认引擎只在**非 multi**时才缩减成一家', /if !multi && !cfg\.img_default_engine\.is_empty\(\)/.test(plan));
check('A3 multi 时把默认那家顶到最前（顺序稳定）', /picked\.insert\(0, id\)/.test(plan));
check('A4 不再有"设了默认就直接 return 一家"的无条件分支',
    !/^    if !cfg\.img_default_engine\.is_empty\(\) \{/m.test(plan));

/* ---------- B. 开标签页不走 open_links ---------- */
check('B1 有 img_open_tab（直接 open::that，不经 open_links）', /fn img_open_tab\(url: &str\)/.test(main));
check('B2 img_region 里改用 img_open_tab 开页面/结果页',
    (main.match(/img_open_tab\(/g) || []).length >= 4, String((main.match(/img_open_tab\(/g) || []).length));
/* 只在 **img_region 函数体**里找 open_links —— 别在整个文件里找：
 * OCR 结果窗那颗「打开链接」用的就是 open_links，那是合法的。
 * （第一版写成了全文搜索，于是把 OCR 那条也当成"识图还在走 open_links"，误报。） */
const imgStart = main.indexOf('fn img_region(');
const imgEnd = main.indexOf('\nfn ', imgStart + 10);
const imgBody = main.slice(imgStart, imgEnd < 0 ? main.length : imgEnd);
check('B3 img_region 里**不再**调 open_links（那条有 12 条上限）',
    !/open_links\(/.test(imgBody), imgBody.length + ' 字节');
check('B4 open_links 的 12 条上限还在（别的功能仍需要它）', /const MAX: usize = 12;/.test(main));

/* ---------- C. 并行上传 ---------- */
const upStart = main.indexOf('let mut pending_upload');
const upEnd = main.indexOf('if opened == 0', upStart);
const up = main.slice(upStart, upEnd < 0 ? upStart + 3000 : upEnd);
check('C1 上传类先攒起来、之后再处理（不在主循环里串行 POST）',
    /let mut pending_upload: Vec<&'static imgsearch::Engine> = Vec::new\(\);/.test(up));
check('C2 每家用一个线程同时上传', /std::thread::spawn\(move \|\| \{/.test(up));
check('C3 用 channel 收结果（谁先回来先处理）', /mpsc::channel/.test(up) && /rx\.recv\(\)/.test(up));
check('C4 上传成功就**立刻**开那个标签页（不等其它家）',
    /上传完成，开结果页/.test(up) && /img_open_tab\(&u\)/.test(up));
check('C5 不需要上传的（page/url）在循环里**立刻**开，不等上传',
    /imgsearch::Mode::Page => \{\n\s*img_open_tab\(e\.page\);/.test(up), up.slice(0, 400));

/* ---------- D. 失败退回 ---------- */
check('D1 上传失败会退回打开那一家页面（不静默失败）',
    /上传失败（\{msg\}），退回打开页面/.test(up) && /img_open_tab\(e\.page\)/.test(up));

rec('');
rec('========== r62：' + pass + ' PASS / ' + fail + ' FAIL ==========');
process.exit(fail > 0 ? 1 : 0);
