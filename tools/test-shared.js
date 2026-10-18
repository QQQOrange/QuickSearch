/* ============================================================================
 *  shared.js 纯逻辑单元测试
 *
 *  shared.js 只依赖 window 这一个全局，所以在纯 Node 里塞个假 window
 *  就能直接跑，不用起 WebView —— 跑一次不到一秒，适合改完随手验证。
 *
 *  重点盯两处最容易出错的地方：
 *    ① qsNormalizeBarList 的边界（开头/结尾/连续重复的分隔线）；
 *    ② qsMergeCustomEngines 的幂等性（反复调用不能越并越多，
 *       删除后旧条目必须真的消失）。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'ui', 'shared.js');
global.window = {};
new Function('window', fs.readFileSync(SRC, 'utf8'))(global.window);

const SEP = global.window.QS_SEP;
const norm = global.window.qsNormalizeBarList;
const merge = global.window.qsMergeCustomEngines;

let pass = 0, fail = 0;
const results = [];
function eq(name, got, want) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    const ok = a === b;
    ok ? pass++ : fail++;
    results.push((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n        期望 ${b}\n        实际 ${a}`));
}

/* ------------------------------ 1. 归一化 ------------------------------ */
console.log('--- qsNormalizeBarList ---');
eq('空列表', norm([]), []);
eq('没有分隔线时原样返回', norm(['a', 'b', 'c']), ['a', 'b', 'c']);
eq('开头分隔线丢掉', norm([SEP, 'a']), ['a']);
eq('结尾分隔线丢掉', norm(['a', SEP]), ['a']);
eq('连续重复只留一条', norm(['a', SEP, SEP, SEP, 'b']), ['a', SEP, 'b']);
eq('中间正常保留', norm(['a', SEP, 'b']), ['a', SEP, 'b']);
eq('多条独立的都保留', norm(['a', SEP, 'b', SEP, 'c']), ['a', SEP, 'b', SEP, 'c']);
eq('两头都有的杂讯', norm([SEP, SEP, 'a', SEP, SEP, 'b', SEP]), ['a', SEP, 'b']);
eq('全是分隔线 -> 空', norm([SEP, SEP, SEP]), []);
eq('null 安全', norm(null), []);

/* ------------------------------ 2. 合并 ------------------------------ */
console.log('--- qsMergeCustomEngines ---');

/** 造一份和真 engines.json 同形状的最小目录 */
function freshCatalog() {
    return {
        toolbar: [],
        categories: [
            { title: 'AI 工具', engines: [{ name: 'DeepSeek', url: 'https://d/?q=%s' }] },
            { title: '知识', engines: [{ name: '知乎', url: 'https://z/?q=%s' }] },
        ],
    };
}
function freshByName(cat) {
    const m = new Map();
    for (const c of cat.categories) for (const e of c.engines) m.set(e.name, e);
    return m;
}
const CONF = () => ({
    customEngines: [
        { name: '内网搜索', url: 'https://s.example/?q=%s', category: '自定义' },
        { name: '备用 Kimi', url: 'https://k.example/?q=%s', category: 'AI 工具' },
    ],
});

// ① 首次合入
{
    const cat = freshCatalog(), m = freshByName(cat);
    const n = merge(cat, m, CONF());
    eq('首次合入 2 个', n, 2);
    eq('byName 里能查到', m.has('内网搜索') && m.has('备用 Kimi'), true);
    eq('新建了「自定义」分类',
        cat.categories.some((c) => c.title === '自定义'), true);
    eq('「AI 工具」分类被并入而不是新建',
        cat.categories.filter((c) => c.title === 'AI 工具').length, 1);
    eq('AI 工具里现在有 2 个',
        cat.categories.find((c) => c.title === 'AI 工具').engines.length, 2);
}

// ② 重复合入必须幂等 —— 这是最容易翻车的地方
{
    const cat = freshCatalog(), m = freshByName(cat);
    merge(cat, m, CONF());
    // 返回值是「本轮并入了几个」，不是「新增了几个」——
    // 幂等性不看它，看下面这些总数与分类数。
    const n2 = merge(cat, m, CONF());
    eq('第二次并入数量仍是 2（每轮都重新并一遍）', n2, 2);
    eq('总数没膨胀', m.size, 4);
    eq('AI 工具仍只有 2 个',
        cat.categories.find((c) => c.title === 'AI 工具').engines.length, 2);
    eq('「自定义」分类没有重复',
        cat.categories.filter((c) => c.title === '自定义').length, 1);
    merge(cat, m, CONF());
    merge(cat, m, CONF());
    eq('跑四次仍然稳定', m.size, 4);
    eq('跑四次分类数也不变', cat.categories.length, 3);
}

// ③ 改名：旧名字必须消失
{
    const cat = freshCatalog(), m = freshByName(cat);
    merge(cat, m, CONF());
    const conf2 = { customEngines: [{ name: '内网搜索', url: 'https://s/?q=%s', category: '自定义' }] };
    merge(cat, m, conf2);
    eq('删掉一个后 byName 里没了', m.has('备用 Kimi'), false);
    eq('总数回到 3', m.size, 3);
    eq('AI 工具回到 1 个',
        cat.categories.find((c) => c.title === 'AI 工具').engines.length, 1);
}

// ④ 全部删光：空分类必须整组消失，不能留个光标题
{
    const cat = freshCatalog(), m = freshByName(cat);
    merge(cat, m, CONF());
    merge(cat, m, { customEngines: [] });
    eq('清空后只剩内置 2 个', m.size, 2);
    eq('没有留下空标题的分类', cat.categories.length, 2);
    eq('分类标题里没有「自定义」',
        cat.categories.some((c) => c.title === '自定义'), false);
}

// ⑤ 坏数据不能把渲染带崩
{
    const cat = freshCatalog(), m = freshByName(cat);
    const n = merge(cat, m, {
        customEngines: [
            { name: '', url: 'https://a/?q=%s' },                 // 名字空
            { name: '没有地址', url: '' },                        // 地址空
            { name: '知乎', url: 'https://dup/?q=%s' },           // 和内置重名
            { name: '好用的', url: 'https://ok/?q=%s' },          // 这条应该进
            null, undefined,
        ],
    });
    eq('只收下合法的 1 个', n, 1);
    eq('重名的没顶掉内置',
        m.get('知乎').url, 'https://z/?q=%s');
    eq('内置总数没变多', m.size, 3);
}

// ⑥ 没填分类 -> 落到「自定义」
{
    const cat = freshCatalog(), m = freshByName(cat);
    merge(cat, m, { customEngines: [{ name: 'X', url: 'https://x/?q=%s' }] });
    eq('空分类归到「自定义」',
        cat.categories.find((c) => c.title === '自定义').engines[0].name, 'X');
}

/* ------------------------------ 汇总 ------------------------------ */
console.log('');
for (const r of results) console.log(r);
console.log('');
console.log(`${pass} / ${pass + fail} 通过  ->  ${fail === 0 ? '全部通过' : '存在失败'}`);
fs.writeFileSync(path.join(__dirname, 'test-shared.result.txt'),
    results.join('\n') + `\n\n${pass}/${pass + fail} passed\n`, 'utf8');
process.exit(fail === 0 ? 0 : 1);
