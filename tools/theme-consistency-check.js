/* 主题一致性静态检查（v1.5.20）
 *
 * 为什么要这条：设计令牌曾经在 5 个文件里各抄一份，深色再各抄一遍，
 * 已经漂移过（--hover 两套值、--danger 两种色）。这个脚本把"单一来源"
 * 这件事钉死：
 *   1. ui/theme.css 必须四段齐全（浅色默认 / 系统深色 / 强制暗 / 强制亮）；
 *   2. 系统深色与强制暗色的令牌必须**逐值相同**（防再次漂移）；
 *   3. 四个窗口都必须引用 theme.css，且不许自己再定义 --bg 这类令牌；
 *   4. shared.js 必须提供 data-theme 引导。
 *
 * 运行：node tools/theme-consistency-check.js
 */
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'ui') + path.sep;
let fail = 0;
function chk(name, cond, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; }

const t = fs.readFileSync(P + 'theme.css', 'utf8');
chk('theme.css 有浅色默认 :root', /:root\s*\{[\s\S]*?--bg:/.test(t));
chk('theme.css 有系统深色（@media + not light）',
    /@media \(prefers-color-scheme: dark\)[\s\S]*?:root:not\(\[data-theme="light"\]\)[\s\S]*?--bg:/.test(t));
chk('theme.css 有强制暗色 [data-theme="dark"]', /:root\[data-theme="dark"\]\s*\{[\s\S]*?--bg:/.test(t));
chk('theme.css 有强制亮色 [data-theme="light"]', /:root\[data-theme="light"\]\s*\{[\s\S]*?--bg:/.test(t));

function block(re) { const m = t.match(re); return m ? m[0] : ''; }
function val(blk, k) { const m = blk.match(new RegExp('--' + k + ':\\s*([^;]+);')); return m ? m[1].trim() : ''; }
const mediaBlk = block(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n\}/);
const darkBlk = block(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/);
let sameDark = true, diffs = [];
for (const k of ['bg', 'card', 'fg', 'fg-dim', 'line', 'hover', 'accent', 'danger', 'ok', 'warn']) {
    if (val(mediaBlk, k) !== val(darkBlk, k)) { sameDark = false; diffs.push(k + '[' + val(mediaBlk, k) + ' vs ' + val(darkBlk, k) + ']'); }
}
chk('系统深色与强制暗色令牌完全一致', sameDark, diffs.join(' '));

for (const f of ['settings.html', 'ocr.html', 'trans.html', 'iconedit.html']) {
    const h = fs.readFileSync(P + f, 'utf8');
    chk(f + ' 引用 theme.css', /href="theme\.css"/.test(h));
    chk(f + ' 不再自己定义 --bg', !/^\s*--bg:/m.test(h));
}
chk('settings.css 不再自己定义 --bg', !/^\s*--bg:/m.test(fs.readFileSync(P + 'settings.css', 'utf8')));

const sj = fs.readFileSync(P + 'shared.js', 'utf8');
chk('shared.js 有 qsApplyPageTheme', /qsApplyPageTheme/.test(sj));
chk('shared.js 会写 data-theme', /dataset\.theme\s*=\s*cur/.test(sj));

chk('theme.css 有 --elev-1 / --elev-2', /--elev-1:/.test(t) && /--elev-2:/.test(t));
chk('theme.css 有 --radius-sm/md/lg', /--radius-sm:/.test(t) && /--radius-md:/.test(t) && /--radius-lg:/.test(t));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail ? 1 : 0);
