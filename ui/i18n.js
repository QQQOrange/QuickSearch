/* ============================================================================
 * Quick Search —— 界面多语言（v1.5.13）
 * ----------------------------------------------------------------------------
 * 用户要求：「在设置中新增语言选项，提供简体中文与英文两种选择，切换后界面中
 * 所有与中文相关的文案、标签、提示等均完整替换为对应语言，且切换后应持久化生效。」
 *
 * # 为什么是"运行时替换"而不是把 9000 行 JS 里的字符串都改成 t('key')
 *
 * 这个项目的界面文案有两个特点：
 *   ① 绝大多数是**内联在 HTML / JS 里的整句中文**，不是可枚举的 key；
 *   ② 动态拼出来的很多（`共 12 个`、`已选 3 个引擎`），改一处要动一片。
 * 硬改成 key 会碰上千处、极易漏、而且以后每加一句都要记得包一层 —— 一旦忘了
 * 就是"英文界面里蹦出一句中文"。
 *
 * 所以这里的做法是：
 *   · 一份 **中→英字典**（`i18n.en.js`），键就是中文原文本身；
 *   · 一个**渲染后翻译**的引擎：文本节点、常见属性、以及"只含内联标签"的
 *     句子整体，都按字典换掉；
 *   · 一个 MutationObserver 兜住**后来才出现**的文案（面板重画、toast、
 *     引擎列表刷新……），所以动态内容不需要任何改造。
 *
 * 这样新增文案时只有一件事要做：往字典里补一行。补漏检查见 tools/`i18n-audit`。
 *
 * # 三条纪律
 *   1. **用户数据绝不翻译**：带 `data-i18n-skip` 的子树一律跳过（OCR 识别
 *      结果、剪贴板原文这类）。另外 `.nm` / `.letter` 这两个 class（引擎名、
 *      首字母块）也算数据 —— 见 `SKIP_CLASS`。默认只在字典命中时才替换，
 *      所以未收录的用户文本天然不受影响。
 *   2. **中文模式必须回到原文**：每个被改过的地方都记了原值，切回 zh 时逐个
 *      还原 —— 不是"再翻一遍"，而是真正的原文。
 *   3. **不碰输入框的值**：`<input value>` / textarea 里是用户正在输入的内容，
 *      只翻译 placeholder / title / aria-label。
 * ========================================================================== */

(function () {
    'use strict';

    /** 字典：中文原文 → 英文。由 i18n.en.js 在它之后调用 `QS_I18N.add()` 填充。 */
    const DICT = Object.create(null);

    /** 带占位符的句子（动态拼出来的那些）。
     *  每条形如 `[/^已选中 (\d+) 项$/, 'Selected $1 items']`。
     *  只用于文本节点整串匹配 —— 不做局部替换（局部替换会把用户数据里的
     *  某个词也换掉）。 */
    const RULES = [];

    /** 整块译文的登记表：`名字 → 英文 HTML`。
     *
     *  给**帮助页**这种几百句的静态长文用：拆成几百个句子键，一是维护起来
     *  像在编号字典，二是 HTML 里任何一个换行/缩进变了，键就失配、整句退回
     *  中文。整块替换只要求"这一段英文对应那一块"，标点、缩进、`<code>`
     *  都不参与匹配。
     *
     *  页面侧只需要在容器上写 `data-i18n-block="helpCard"`。 */
    const BLOCKS = Object.create(null);

    /** 句子碎片：JS 里拼出来的提示（`'已添加「' + name + '」并固定到横条'`）。
     *
     *  这类文案在源码里是好几片，拼完才是"一个文本节点" —— 单独把每一片塞进
     *  字典永远命中不了整句。所以这里分两张表：
     *    · `PRE`：**开头**碎片（`已添加「`），命中就把开头换掉、剩下继续翻；
     *    · `SUF`：**结尾**碎片（`」并固定到横条`），命中就换掉结尾。
     *  一片接一片地剥，最后拼起来就是英文句子。
     *
     *  ⚠ 只认**显式登记**的碎片（字典里 `p:` / `s:` 开头的键）。不按"任意
     *  以标点结尾的词"去猜 —— 收藏夹内容、引擎名、文件名都是用户数据，
     *  猜一次就可能把「打开的文件.txt」翻成「Open的文件.txt」。 */
    const PRE = Object.create(null);
    const SUF = Object.create(null);
    let PRE_KEYS = [];   // 按长度倒序，长的先试（`已添加到横条` 优先于 `已添加`）
    let SUF_KEYS = [];

    /** 当前语言："zh" | "en" */
    let LANG = 'zh';

    /** 改过的记录，切回中文时按它逐条还原。
     *  `SEEN` 让同一个节点只留**最新**一条 —— 设置页里同一块文案会被反复重写
     *  （`共 3 个` → `共 5 个`），留一堆旧记录的话，切回中文时会把节点还原成
     *  中间某个过期的值。 */
    const RECORDS = [];
    let SEEN = new WeakMap();   // node|el → record

    /** 正在还原/应用的标志：避免自己的写入又触发 MutationObserver（死循环）。 */
    let BUSY = false;

    /** 不翻译的标签（内容不是界面文案）。 */
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
        'PRE', 'CODE', 'KBD', 'CANVAS', 'SVG', 'PATH',
    ]);

    /** 只有这些标签算"内联"：一个元素如果只含它们，就可以按整句翻译。 */
    const INLINE_TAGS = new Set([
        'B', 'I', 'EM', 'STRONG', 'SPAN', 'A', 'U', 'SMALL', 'SUP', 'SUB',
        'BR', 'IMG', 'KBD', 'CODE', 'MARK', 'S', 'DEL',
    ]);

    /* 允许**整句**翻译的容器标签。
     *
     * ⚠ 为什么 `DIV` 故意不在里面：设置页的每一行都是
     *   `<div class="rt"><b>标题</b><small>说明</small></div>` —— 它"只含内联
     *   子元素"，如果按整句翻，标题和说明会被拼成一句、`<b>` 加粗也没了，
     *   一眼就能看出排版坏了。所以 div / section 一律只递归、不整句替换；
     *   `<small>` / `<p>` / `<li>` 这些才是"一句话"的容器。 */
    const BLOCK_TAGS = new Set([
        'SMALL', 'P', 'LI', 'LABEL', 'BUTTON', 'A', 'H1', 'H2', 'H3', 'H4',
        'TD', 'TH', 'SUMMARY', 'OPTION', 'LEGEND', 'DT', 'DD',
    ]);

    /** 这些 class 的 div 也是"一段话"（说明文字 / 提示）。
     *
     * 设置页的长段落全在 `<div class="hint">` 里（含 `<b>` 强调），按整段翻译
     * 才能保住语序和加粗；只按文本节点翻会把一句话拆成几截，英文读起来是断的。 */
    const BLOCK_CLASS = /(^|\s)(hint|desc|note|sub|help|tip|info|msg)(\s|$)/;

    function isBlock(el) {
        if (BLOCK_TAGS.has(el.tagName)) return true;
        return el.tagName === 'DIV' && BLOCK_CLASS.test(el.className || '');
    }

    /** 要翻译的属性。`placeholder` 覆盖搜索框；`title` 覆盖悬停提示；
     *  `aria-label` 是读屏用的可访问名，也该跟着换；`data-tip` 是本项目
     *  自绘小气泡的文案（原生 title 太慢，长按才出来）。 */
    const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];

    /** 这些 class 的元素里装的是**数据**，不是界面文案，一律原样留着。
     *
     *  引擎库有 600 多条名字（`百度`、`豆瓣读书`、`哔哩哔哩`…），而且用户自己
     *  也能往里加（`公司内网搜索`）。硬翻其中一部分，结果就是「豆包」变成了
     *  Doubao、「我的内网」还是中文 —— 同一张列表两种语言，比整张不翻更难看；
     *  何况名字是自己输入的检索词，翻了还和"我当初打的字"对不上。
     *  所以按数据对待：原名显示，搜索、别名、快捷键一概不动。
     *
     *  `.letter` 是名字首字母那个方块，`.eng-letter-h` 是按字母分的组标题。 */
    const SKIP_CLASS = new Set(['nm', 'letter', 'eng-letter-h']);

    function dataName(el) {
        const cls = el.className;
        if (!cls || typeof cls !== 'string') return false;
        const parts = cls.split(/\s+/);
        for (let i = 0; i < parts.length; i++) {
            if (SKIP_CLASS.has(parts[i])) return true;
        }
        return false;
    }

    const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

    /** 归一化：合并空白 + 去首尾。字典的键都是这个形态。 */
    function norm(s) {
        return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    }

    /** 查一条（先精确、再规则）。命中返回译文，否则 undefined。 */
    function lookup(text) {
        const key = norm(text);
        if (!key) return undefined;
        const exact = DICT[key];
        if (exact !== undefined) return exact;
        for (let i = 0; i < RULES.length; i++) {
            const m = key.match(RULES[i][0]);
            if (m) return key.replace(RULES[i][0], RULES[i][1]);
        }
        return undefined;
    }

    /** 连碎片一起查：整句没命中就一片片剥（见 `PRE` / `SUF`）。
     *
     *  只给"单个文本节点 / 属性值"用 —— 整句块（`<p>` 那种）不走这里：
     *  一段话从中间被碎片切开再拼回去，语序会散架。 */
    function lookupLoose(text, depth) {
        const d = depth || 0;
        const key = norm(text);
        if (!key) return undefined;
        const direct = lookup(key);
        if (direct !== undefined) return direct;
        if (d >= 4) return undefined;

        for (let i = 0; i < PRE_KEYS.length; i++) {
            const frag = PRE_KEYS[i];
            if (key.length <= frag.length || key.lastIndexOf(frag, 0) !== 0) continue;
            const rest = lookupLoose(key.slice(frag.length), d + 1);
            if (rest !== undefined) return PRE[frag] + rest;
        }
        for (let i = 0; i < SUF_KEYS.length; i++) {
            const frag = SUF_KEYS[i];
            if (key.length <= frag.length) continue;
            if (key.slice(-frag.length) !== frag) continue;
            const rest = lookupLoose(key.slice(0, key.length - frag.length), d + 1);
            if (rest !== undefined) return rest + SUF[frag];
        }

        /* 「标签：值」—— 后半截是后端抛回来的原话（"网络不通"、"路径不存在"、
         * 对方 API 的中文报错），字典里永远不会有；但前半截是我们自己的标签。
         * 只认**整段标签 + 全角冒号**，且标签本身必须是字典里的完整一条 ——
         * 用户数据里极少出现"某个界面标签 + 全角冒号"开头，误伤面很小。 */
        const cut = key.search(/[：:]/);
        if (cut > 0 && cut < 24) {
            const label = key.slice(0, cut + 1);
            const hit = DICT[label] !== undefined ? DICT[label] : PRE[label];
            const rest = key.slice(cut + 1).trim();
            if (hit !== undefined && rest) {
                const tail = lookupLoose(rest, d + 1);
                return hit + (tail !== undefined ? tail : rest);
            }
        }
        return undefined;
    }

    /** 元素是不是"只含内联子节点"（可以整句翻译，不会打散结构）。 */
    function inlineOnly(el) {
        const kids = el.children;
        for (let i = 0; i < kids.length; i++) {
            if (!INLINE_TAGS.has(kids[i].tagName)) return false;
        }
        return true;
    }

    /** 能不能把整句译文直接塞进 innerHTML。
     *
     *  里面只要挂了**带 id 的子元素**就不能 —— 那些是 JS 拿着引用实时改值的
     * 地方（`<small><span id="s-barBlurVal">30</span> ‰ · 模拟玻璃有多厚…</small>`）。
     *  整句换掉时译文里不带 span，`$('s-barBlurVal')` 当场变 null，滑块旁边那个
     *  实时数字就再也不动了。这种一律退化成"只翻文字节点"。 */
    function replaceable(el) {
        return !el.querySelector('[id]');
    }

    /** 这个节点该不该跳过（自己在 skip 子树里 / 标签本身不该翻）。 */
    function skippable(node) {
        let el = node.nodeType === 1 ? node : node.parentElement;
        /* 元素自己的那截文字就是名字（数据），别翻；但它里面的 `<em>` 之类
         * 仍是界面文案，所以只挡"直接子节点"这一层。 */
        if (node.nodeType === 3 && el && dataName(el)) return true;
        while (el && el !== document.documentElement) {
            if (el.hasAttribute && (el.hasAttribute('data-i18n-skip')
                || el.hasAttribute('data-i18n-raw'))) {
                return true;
            }
            if (SKIP_TAGS.has(el.tagName)) return true;
            if (el.isContentEditable) return true;
            el = el.parentElement;
        }
        return false;
    }

    /** 记一条（同一节点/元素的**同一处**只保留最新一条）。
     *
     *  ⚠ 不能只按元素去重：一个 `<input>` 上同时有 placeholder 和 title 两个要翻
     *  的属性，只按元素当 key 的话后一条会把前一条的 `name` / `zh` 直接**改写**掉，
     *  切回中文时只有一个属性被还原，另一个永远停在英文。所以二级索引 ——
     *  「元素 → 槽位」，槽位按 kind 区分，attr 再按属性名区分。 */
    function remember(rec, key) {
        let slots = SEEN.get(key);
        if (!slots) {
            slots = Object.create(null);
            SEEN.set(key, slots);
        }
        const slot = rec.kind === 'attr' ? 'attr:' + rec.name : rec.kind;
        const old = slots[slot];
        if (old) {
            old.node = rec.node; old.el = rec.el; old.name = rec.name;
            old.zh = rec.zh; old.kind = rec.kind;
            return;
        }
        slots[slot] = rec;
        RECORDS.push(rec);
    }

    /** 换掉一个文本节点，并记下原文。 */
    function setText(node, value) {
        /* ⚠ 值没变就别写。写一次同样内容会**再触发一次 characterData 变更**，
         *   MutationObserver 又把它排进下一轮 —— 字典里只要有一条"译成自己"
         *   （比如语言选项的「简体中文」），就成了死循环，页面直接卡死。 */
        if (node.nodeValue === value) return;
        remember({ kind: 'text', node, zh: node.nodeValue }, node);
        node.nodeValue = value;
    }

    /** 换掉整个元素的 innerHTML（整句翻译，译文里可以带 <b> 之类的内联标签），
     *  并记下原 HTML。 */
    function setHTML(el, html) {
        if (el.innerHTML === html) return;
        remember({ kind: 'html', el, zh: el.innerHTML }, el);
        el.innerHTML = html;
    }

    /** 换属性值（title / placeholder / aria-label），记下原值。 */
    function setAttr(el, name, value) {
        if (el.getAttribute(name) === value) return;
        remember({ kind: 'attr', el, name, zh: el.getAttribute(name) }, el);
        el.setAttribute(name, value);
    }

    /** 整块换掉一个容器的 innerHTML（`data-i18n-block`）。 */
    function swapBlock(el, html) {
        if (el.innerHTML === html) return;
        /* 先记下哪几块 `<details>` 是展开的 —— 整块换 innerHTML 会把展开状态
         * 一起冲掉，用户刚点开的那一条会自己合上。换完按**位置**还原。 */
        const opened = [];
        const before = el.querySelectorAll('details');
        for (let i = 0; i < before.length; i++) opened.push(before[i].open);
        remember({ kind: 'html', el, zh: el.innerHTML }, el);
        el.innerHTML = html;
        const after = el.querySelectorAll('details');
        for (let i = 0; i < after.length && i < opened.length; i++) {
            after[i].open = opened[i];
        }
    }

    /** 处理一个元素（深度优先）。 */
    function walk(el) {
        if (el.nodeType !== 1) return;
        if (el.hasAttribute('data-i18n-skip') || el.hasAttribute('data-i18n-raw')) return;
        if (el.isContentEditable) return;
        /* 引擎名之类的"数据名字"：自己那截文字不翻，但里面可能还夹着界面文案
         * （横条列表那行是 `<span class="nm">名字<em>还没加进横条 · …</em></span>`），
         * 所以只跳过直接文本，照样往里递归。 */
        if (dataName(el)) {
            for (let n = el.firstChild; n; n = n.nextSibling) {
                if (n.nodeType === 1) walk(n);
            }
            return;
        }

        /* 整块替换优先：这一块有自己的英文版本就整段换掉，不再往下翻。 */
        const blockName = el.getAttribute('data-i18n-block');
        if (blockName && BLOCKS[blockName]) {
            swapBlock(el, BLOCKS[blockName]);
            translateAttrs(el);
            return;
        }

        /* 输入类元素：**只翻提示语，不碰值**（value / 已输入内容都是用户的）。
         * 放在 SKIP_TAGS 判断之前 —— 否则搜索框的 placeholder 永远换不掉。 */
        if (SKIP_TAGS.has(el.tagName)) {
            translateAttrs(el);
            return;
        }

        /* 整句优先：只含内联子元素时，按 textContent 查一次。
         * 命中就替换（保留译文里的 <b>），**不再往下走** —— 否则子节点会被
         * 单独翻一遍，和整句译文打架。 */
        if (el.children.length && isBlock(el) && inlineOnly(el) && replaceable(el)) {
            const key = norm(el.textContent);
            if (key && CJK.test(key)) {
                const hit = lookup(key);
                if (typeof hit === 'string') {
                    if (/<[a-z][\s\S]*>/i.test(hit)) setHTML(el, hit);
                    else {
                        remember({ kind: 'html', el, zh: el.innerHTML }, el);
                        el.textContent = hit;
                    }
                    translateAttrs(el);
                    return;
                }
            }
        }

        // 属性
        translateAttrs(el);

        // 子节点
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) {
                const raw = n.nodeValue;
                if (!raw || !CJK.test(raw)) continue;
                if (skippable(n)) continue;
                const hit = lookupLoose(raw);
                if (typeof hit === 'string') setText(n, hit);
            } else if (n.nodeType === 1) {
                walk(n);
            }
        }
    }

    /** 元素的 title / placeholder / aria-label（只认整串精确命中）。 */
    function translateAttrs(el) {
        for (let i = 0; i < ATTRS.length; i++) {
            const name = ATTRS[i];
            const v = el.getAttribute(name);
            if (!v || !CJK.test(v)) continue;
            const hit = lookupLoose(v);
            if (typeof hit === 'string') setAttr(el, name, hit);
        }
    }

    /** 把记录里的中文全部还原回去（切回中文时用）。 */
    function restoreAll() {
        for (let i = RECORDS.length - 1; i >= 0; i--) {
            const r = RECORDS[i];
            try {
                if (r.kind === 'text') {
                    if (r.node) r.node.nodeValue = r.zh;
                } else if (r.kind === 'html') {
                    if (r.el && r.el.isConnected) r.el.innerHTML = r.zh;
                } else if (r.kind === 'attr') {
                    if (r.el && r.el.isConnected) {
                        if (r.zh == null) r.el.removeAttribute(r.name);
                        else r.el.setAttribute(r.name, r.zh);
                    }
                } else if (r.kind === 'title') {
                    document.title = r.zh;
                }
            } catch (_) { /* 节点没了就算了 */ }
        }
        RECORDS.length = 0;
        // 记录清空之后索引也得换新，否则下一次翻译会往"已摘掉"的旧记录里写
        SEEN = new WeakMap();
    }

    /** 全量应用一次（先还原再翻，保证幂等）。 */
    function applyAll() {
        if (BUSY) return;
        BUSY = true;
        try {
            restoreAll();
            if (LANG !== 'zh') {
                if (document.body) walk(document.body);
                // <title> 是文本节点但不在 body 里，单独来一次
                translateTitle();
            }
        } finally {
            BUSY = false;
        }
    }

    function translateTitle() {
        const t = document.title;
        if (!t || !CJK.test(t)) return;
        const hit = lookup(t);
        if (typeof hit === 'string') {
            RECORDS.push({ kind: 'title', zh: t });
            document.title = hit;
        }
    }

    /* ---------------------------------------------------------------- 观察器 */
    /* 面板重画 / toast / 列表刷新都是"后来才出现"的文案。只处理新增子树和
     * 变化的文本节点，不整页重扫 —— 设置页有几千个节点，整页扫一次要几十毫秒，
     * 每次广播都扫会明显卡。 */
    let pending = [];
    let scheduled = false;

    function flush() {
        scheduled = false;
        if (LANG === 'zh' || BUSY) { pending = []; return; }
        const jobs = pending;
        pending = [];
        BUSY = true;
        try {
            for (let i = 0; i < jobs.length; i++) {
                const n = jobs[i];
                if (!n) continue;
                /* 属性变更：只补这一处，不要把整棵子树再走一遍。 */
                if (n.__attrTarget) {
                    if (n.__attrTarget.isConnected) translateAttrs(n.__attrTarget);
                    continue;
                }
                if (!n.isConnected) continue;
                if (n.nodeType === 1) walk(n);
                else if (n.nodeType === 3) {
                    if (!CJK.test(n.nodeValue || '')) continue;
                    if (skippable(n)) continue;
                    const hit = lookupLoose(n.nodeValue);
                    if (typeof hit === 'string') setText(n, hit);
                }
            }
        } finally {
            BUSY = false;
        }
    }

    function enqueue(nodes) {
        if (LANG === 'zh') return;
        for (let i = 0; i < nodes.length; i++) pending.push(nodes[i]);
        if (scheduled) return;
        scheduled = true;
        // 微任务就够：同一轮 DOM 变更里插进来的节点会被合批处理
        Promise.resolve().then(flush);
    }

    function startObserver() {
        if (typeof MutationObserver !== 'function' || !document.body) return;
        const mo = new MutationObserver((list) => {
            if (BUSY || LANG === 'zh') return;
            const nodes = [];
            for (let i = 0; i < list.length; i++) {
                const m = list[i];
                if (m.type === 'characterData') nodes.push(m.target);
                else if (m.type === 'attributes') nodes.push({ __attrTarget: m.target });
                else if (m.type === 'childList') {
                    for (let k = 0; k < m.addedNodes.length; k++) nodes.push(m.addedNodes[k]);
                }
            }
            if (nodes.length) enqueue(nodes);
        });
        /* 属性也要盯着：`title` / `placeholder` 常常是**配置异步回来之后**才写
         * 上去的（版本号那句、令牌按钮的"当前输入已经保存过了"、快捷键的
         * "现在就没有设置快捷键"），光看 childList 会一直漏。 */
        mo.observe(document.body, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ATTRS,
        });
    }

    /* ------------------------------------------------------------------ API */
    const QS_I18N = {
        /** 当前语言 */
        get lang() { return LANG; },

        /** 补字典（i18n.en.js 用）。可多次调用，逐条并入。 */
        add(map) {
            if (!map) return;
            for (const k in map) {
                if (Object.prototype.hasOwnProperty.call(map, k)) DICT[k] = map[k];
            }
        },

        /** 补规则（同上，带占位符的句子）。 */
        addRules(list) {
            if (!list) return;
            for (let i = 0; i < list.length; i++) RULES.push(list[i]);
        },

        /** 登记一整块英文 HTML（帮助页那种长文，见 `data-i18n-block`）。 */
        addBlock(name, html) {
            if (!name || typeof html !== 'string') return;
            BLOCKS[name] = html;
        },

        /** 登记句子碎片：`{ pre: {'已添加「': 'Added 「'}, suf: {...} }`。
         *  合并多次调用（分片生成时会有好几批）。 */
        addFrag(map) {
            if (!map) return;
            const pre = map.pre || {};
            const suf = map.suf || {};
            for (const k in pre) if (Object.prototype.hasOwnProperty.call(pre, k)) PRE[k] = pre[k];
            for (const k in suf) if (Object.prototype.hasOwnProperty.call(suf, k)) SUF[k] = suf[k];
            PRE_KEYS = Object.keys(PRE).sort((a, b) => b.length - a.length);
            SUF_KEYS = Object.keys(SUF).sort((a, b) => b.length - a.length);
        },

        /** 显式翻译一句（给"不经过 DOM 的字符串"用：confirm 文案、原生窗口标题等）。
         *  `vars` 是 `{n: 3}` 这种占位符表，译文里写 `$n` 或 `{n}` 都认。 */
        t(text, vars) {
            if (LANG === 'zh') return text;
            let out = lookupLoose(text);
            if (typeof out !== 'string') out = text;
            if (vars) {
                out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
            }
            return out;
        },

        /** 切换语言：立刻整页重翻（或还原），并记到 <html lang>。 */
        setLang(lang) {
            const next = String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
            if (next === LANG) return;
            LANG = next;
            document.documentElement.setAttribute('lang', LANG === 'en' ? 'en' : 'zh-CN');
            applyAll();
            window.dispatchEvent(new CustomEvent('qs:lang', { detail: LANG }));
        },

        /** 页面启动时调一次：从配置里取语言（拿不到就按中文）。 */
        boot() {
            startObserver();
            const applyFromCfg = (cfg) => {
                const l = cfg && cfg.uiLang ? cfg.uiLang : 'zh';
                if (l !== LANG) {
                    LANG = String(l).startsWith('en') ? 'en' : 'zh';
                    document.documentElement.setAttribute(
                        'lang', LANG === 'en' ? 'en' : 'zh-CN');
                }
                applyAll();
            };
            if (window.CONF && window.CONF.uiLang) {
                applyFromCfg(window.CONF);
                return Promise.resolve(LANG);
            }
            try {
                return window.__TAURI__.core.invoke('get_config')
                    .then(applyFromCfg)
                    .catch(() => { applyAll(); return LANG; });
            } catch (_) {
                applyAll();
                return Promise.resolve(LANG);
            }
        },
    };

    window.QS_I18N = QS_I18N;

    /* 配置广播一进来就同步语言 —— 设置页一改，横条 / OCR 窗 / 更新窗都跟着换。
     * 这里**不依赖各页面自己的 qs://config 处理**（那几处各有各的节奏），
     * i18n 自己听一份，谁先到都行。 */
    function watchConfig() {
        try {
            if (!window.__TAURI__ || !window.__TAURI__.event) return;
            window.__TAURI__.event.listen('qs://config', (ev) => {
                const cfg = ev && ev.payload;
                if (cfg && cfg.uiLang) QS_I18N.setLang(cfg.uiLang);
            });
        } catch (_) { /* 非 Tauri 环境（jsdom 测试）忽略 */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            watchConfig();
            QS_I18N.boot();
        });
    } else {
        watchConfig();
        QS_I18N.boot();
    }
})();
