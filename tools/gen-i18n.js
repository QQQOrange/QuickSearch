/* 生成 ui/i18n.en.js —— 把 `_i18n_parts/*.json` 合并成一份运行时字典。
 *
 * 为什么不手工维护 i18n.en.js：
 *   · 531 条起步、后面还要长到一千多条，手改容易重复 / 漏逗号；
 *   · 分片按"界面分区"切（01 外壳、02 通用…），翻译时一次只看一小块，
 *     比在一个 3000 行的对象里翻要省心得多；
 *   · 键冲突（同一个中文在不同分区译法不同）必须**有确定的赢家**：
 *     这里按文件名排序、后者覆盖前者，规则固定。
 *
 * 特殊键：
 *   `@block:<名字>`  —— 值是一大段英文 HTML（整块替换用，见 i18n.js 的
 *                       `data-i18n-block`）。帮助页那种几百句的静态长文
 *                       走这条，一是不用拆成几百个键，二是不会因为空白
 *                       差异失配。
 *   `@rules`         —— 单独放在 99_rules.json，值是 `[[正则源, 替换], ...]`。
 *
 * 整块英文另外支持直接写成 `_i18n_parts/<名字>.html`（更好读、能高亮、
 * 能 diff），文件名就是块名 —— 帮助页那份就是这么来的。
 *
 * 用法：node tools/gen-i18n.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '_i18n_parts');
const OUT = path.join(ROOT, 'ui', 'i18n.en.js');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const dict = new Map();
const blocks = new Map();
const pre = new Map();
const suf = new Map();
let rules = [];

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (k === '@rules') { rules = v; continue; }
    if (k.startsWith('@block:')) { blocks.set(k.slice(7), v); continue; }
    /* `p:` = 句首碎片、`s:` = 句尾碎片（JS 里拼出来的那些提示语，
     * 见 i18n.js 的 lookupLoose）。 */
    if (k.startsWith('p:')) { pre.set(k.slice(2), v); continue; }
    if (k.startsWith('s:')) { suf.set(k.slice(2), v); continue; }
    /* 译成自己的条目一律丢掉：留着除了让"缺失审计"永远报一条，没有任何作用，
     * 而且一旦 setText 写进同值还会触发观察器空转。 */
    if (!k || typeof v !== 'string' || k === v) continue;
    dict.set(k, v);
  }
}

/* 整块英文也可以直接放 `_i18n_parts/<名字>.html` —— 长文写 JSON 字符串
 * 太难受（换行、引号全要转义），单独一个 .html 才能正常审阅。 */
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html')).sort()) {
  blocks.set(path.basename(f, '.html'), fs.readFileSync(path.join(DIR, f), 'utf8'));
}

const esc = (s) => JSON.stringify(s).slice(1, -1);
const q = (s) => '"' + esc(s) + '"';

const lines = [];
lines.push('/* ============================================================================');
lines.push(' * Quick Search —— English dictionary (v1.5.13)');
lines.push(' * ----------------------------------------------------------------------------');
lines.push(' * 中文原文 → English。由 ui/i18n.js 在运行时按文本节点 / 整句 / 属性查表。');
lines.push(' *');
lines.push(' * ⚠ 这个文件是**生成**出来的，别直接改 —— 改 `_i18n_parts/*.json`');
lines.push(' *   再跑 `node tools/gen-i18n.js`。');
lines.push(' * ========================================================================== */');
lines.push('');
lines.push('window.QS_I18N.add({');
const entries = [...dict.entries()];
entries.forEach(([k, v], i) => {
  lines.push('    ' + q(k) + ': ' + q(v) + (i === entries.length - 1 ? '' : ','));
});
lines.push('});');
lines.push('');

if (blocks.size) {
  lines.push('/* 整块替换：帮助页那种静态长文（见 i18n.js 的 data-i18n-block）。 */');
  for (const [name, html] of blocks) {
    lines.push('window.QS_I18N.addBlock(' + q(name) + ', ' + q(html.replace(/\s*\n\s*/g, ' ')) + ');');
  }
  lines.push('');
}

if (pre.size || suf.size) {
  lines.push('/* 句子碎片：JS 里 `\'已添加「\' + name + \'」并固定到横条\'` 这种拼出来的提示，');
  lines.push(' * 一片片剥完再拼（见 i18n.js 的 lookupLoose）。 */');
  lines.push('window.QS_I18N.addFrag({');
  if (pre.size) {
    lines.push('    pre: {');
    [...pre.entries()].forEach(([k, v], i) => {
      lines.push('        ' + q(k) + ': ' + q(v) + (i === pre.size - 1 ? '' : ','));
    });
    lines.push('    }' + (suf.size ? ',' : ''));
  }
  if (suf.size) {
    lines.push('    suf: {');
    [...suf.entries()].forEach(([k, v], i) => {
      lines.push('        ' + q(k) + ': ' + q(v) + (i === suf.size - 1 ? '' : ','));
    });
    lines.push('    }');
  }
  lines.push('});');
  lines.push('');
}

lines.push('/* 带占位符的句子（渲染后才知道具体数字/名字的那些）。');
lines.push(' * 只做**整串**匹配：`已选中 3 项` 命中，`我复制了 3 项` 不会被误伤。 */');
lines.push('window.QS_I18N.addRules([');
rules.forEach(([src, dst], i) => {
  /* 正则字面量里的 `/` 必须转义，否则 `a / b` 会把字面量提前截断。 */
  const body = String(src).replace(/\\\//g, '/').replace(/\//g, '\\/');
  lines.push('    [/' + body + '/, ' + q(dst) + ']' + (i === rules.length - 1 ? '' : ','));
});
lines.push(']);');
lines.push('');

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('wrote ' + OUT);
console.log('  entries=' + dict.size + '  blocks=' + blocks.size +
            '  frag=' + (pre.size + suf.size) + '  rules=' + rules.length);
