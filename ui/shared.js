/* ============================================================================
 *  横条项与引擎目录的公共逻辑
 *
 *  横条、设置面板、识别结果窗口这三个页面都要做同样两件事：
 *    ① 让「用户自己加的引擎」出现在引擎目录里；
 *    ② 认识 barList 里代表分隔线的哨兵元素。
 *
 *  这两件事各写三遍迟早会不一致（改了一处忘了另一处，表现为「设置在，
 *  横条上没有」），所以抽成这个共享文件 —— 三个页面都引它。
 * ========================================================================== */

/** barList 里代表分隔线的哨兵。和 Rust 侧 config::SEP 必须保持一致。 */
window.QS_SEP = '|';

/**
 * barList 里代表「OCR 那颗按钮」的哨兵。
 *
 * 为什么让 OCR 也当一个"横条成员"来排序：用户要求**它在横条里的位置能自定义**，
 * 而位置自定义天然就是"和其它引擎一起拖"。所以把它塞进 barList 参与排序，
 * 渲染时遇到它就画 OCR 按钮而不是引擎图标。
 *
 * 这样定字符串哨兵而不是塞 DOM，是因为 barList 要能整体存进 config.json、
 * 参与 `qsNormalizeBarList` 的清理逻辑、和设置页的拖拽列表共用一套代码。
 * 用一个不会和引擎重名的符号（同引擎名里不可能出现这一串）即可。
 * Rust 侧 config::BAR_OCR 必须与之保持一致。
 */
window.QS_OCR = '@ocr';
/** r61：横条上那颗「识图搜索」按钮的哨兵。
 *  和 @ocr 同一套地位：能出现在「横条上的引擎」列表里、能用 pick_icon 换图标。 */
window.QS_IMG = '@img';
/** v1.5.16：横条上那颗「翻译」按钮的哨兵。
 *  和 @ocr / @img 同一套地位：bar_list 成员、可拖拽排序、可换图标、可移出。
 *  Rust 侧 config::BAR_TRANS 必须与之保持一致。 */
window.QS_TRANS = '@trans';
/** 翻译按钮的**内置默认图标**（用户指定的「翻译-copy.png」）。
 *
 *  ⚠ v1.5.19：这张图**内嵌**在这里 —— 整张 PNG 以 base64 data URI 写死，
 *    运行时不再去读任何外部图片文件。
 *
 *  为什么必须内嵌（用户原话：「要让这些图标变成内嵌的图标」）：
 *    以前它是 `data/icons/trans.png` —— 一个**相对路径**，靠 WebView 去解析
 *    和拉取。这条路有三个坑：
 *      ① 打包漏掉这个文件 → 图读不出来 → 按钮悄悄退回「译」字徽标，
 *         而用户根本不知道"图标怎么变成字了"；
 *      ② 相对路径要靠当前页面位置解析，多一个入口（横条 / 设置列表 /
 *         设置预览）就多一处可能解析错的地方；
 *      ③ 一张 200×200 的 PNG，为了显示成 28px 要让 WebView 走一次
 *         外部资源加载（data URI 不会）。
 *    改成 base64 内嵌后：图和代码同生共死，打包进 exe 就一定在，
 *    零请求、零失败路径。
 *
 *  ⚠ 为什么不是 overrideIcons：overrideIcons 的语义是「用户**自己挑**的图」，
 *    点「恢复默认」时会被清掉。把程序自带的默认图塞进去，那「恢复默认」就变成
 *    「恢复成程序自带的那张」—— 语义正好反了。所以内置图走独立这一路，
 *    overrideIcons 只负责「用户覆盖过」的情况。
 *
 *  （素材原图已随「零残留」清理删除，需要时从 git 历史取回。） */
window.QS_TRANS_ICON = 'data:image/png;base64,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';

/** 识图按钮的**内置默认图标**（用户指定的「识图键.png」）。
 *
 *  和上面那颗翻译图同一条路：**base64 内嵌**，不依赖任何外部文件。
 *
 *  ⚠ 它顶替的是原来那份「四角取景框 + 放大镜」的内联 SVG（QS_IMG_SVG）。
 *    那份 SVG 还在，但只作**最后兜底** —— 万一这张 PNG 出问题（理论上不会，
 *    data URI 不存在"读不出来"），不至于让识图按钮变成一颗空白方块。
 *
 *  （素材原图已随「零残留」清理删除，需要时从 git 历史取回。） */
window.QS_IMG_ICON = 'data:image/png;base64,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';
/** r70：识图按钮的**内置图标**（四角取景框 + 放大镜）的内联 SVG 标记。
 *  语义：框选屏幕的一块区域（四角）→ 按图去搜（放大镜）。
 *  以前这份标记只存在于横条的 index.html 里，设置页想显示同一颗图标只能
 *  抄一份（两份迟早不一致）—— 现在收在这里，横条 / 设置页共用。
 *  ⚠ path 上**不能带 fill**：留着会盖掉主题色（悬停变蓝、深色模式都会失效），
 *    颜色由 CSS 的 `fill: currentColor` 控制。 */
window.QS_IMG_SVG = '<svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><path d="M97.28 350.72c17.92 0 32.256-15.872 32.256-33.792V187.904c0-32.256 26.112-57.856 57.856-57.856H317.44c15.36 0 29.184-9.728 32.768-24.576 5.12-21.504-11.264-40.96-31.744-40.96h-138.24c-64 0-116.224 52.224-116.224 116.224v138.24c0 17.408 14.336 31.744 33.28 31.744zM317.952 894.464H187.392c-32.256 0-57.856-26.112-57.856-57.856V706.56c0-15.36-9.728-29.184-24.576-32.768-21.504-5.12-40.96 11.264-40.96 31.744v138.24c0 64 52.224 116.224 116.224 116.224h136.704c16.384 0 31.744-11.776 33.792-28.16 3.072-19.968-12.8-37.376-32.768-37.376zM772.096 791.04c8.192 0 15.872-3.072 22.016-8.704 6.656-6.144 10.24-13.824 10.752-23.04 0.512-8.704-2.56-16.896-8.704-23.552l-115.712-115.712c67.072-89.6 57.856-216.064-21.504-295.424-80.384-80.384-208.896-88.576-299.008-18.432-98.816 76.8-116.736 219.648-39.936 317.952 75.776 97.28 216.064 116.224 314.368 42.496l115.712 115.712c6.144 6.144 14.336 8.704 22.016 8.704zM385.024 599.04c-30.72-30.72-47.104-71.168-47.104-114.176s16.896-83.456 47.104-113.664l2.048-2.048c62.976-60.416 163.328-59.904 225.792 2.048 62.976 62.976 62.976 164.864 0 227.84-62.976 62.464-164.864 62.464-227.84 0zM926.72 673.28c-17.92 0-32.256 15.872-32.256 33.792v129.536c0 32.256-26.112 57.856-57.856 57.856H706.56c-15.36 0-29.184 9.728-32.768 24.576-5.12 21.504 11.264 40.96 31.744 40.96h138.24c64 0 116.224-52.224 116.224-116.224v-138.24c0-17.92-14.336-32.256-33.28-32.256zM843.776 64H706.56c-15.36 0-29.184 9.728-32.768 24.576-5.12 21.504 11.264 40.96 31.744 40.96h131.072c32.256 0 57.856 26.112 57.856 57.856V317.44c0 15.36 9.728 29.184 24.576 32.768 21.504 5.12 40.96-11.264 40.96-31.744v-138.24c0-64-52.224-116.224-116.224-116.224z"/></svg>';
/** 收藏夹目录放进横条时的哨兵前缀：`@fav:<groupId>`。
 *  和 @ocr 一样是保留名 —— 后面那段 id 由后端在渲染时查收藏树解析。 */
window.QS_FAV_PREFIX = '@fav:';
/** 外部软件放进横条时的哨兵前缀：`@app:<id>`。
 *  它和 @fav: 是同一类东西（"横条成员，但不是搜索引擎"），区别只在
 *  点下去的行为：收藏夹弹面板，外部软件直接唤起对应软件。
 *  Rust 侧 config::APP_PREFIX 必须与之保持一致。 */
window.QS_APP_PREFIX = '@app:';

/** 靠哨兵名（`@app:<id>`）找到对应的外部软件记录；没有返回 null。
 *  横条、设置页、OCR 结果窗三处都要用，别各写一遍。 */
window.qsAppBySentinel = function (name) {
    if (typeof name !== 'string' || !name.startsWith(window.QS_APP_PREFIX)) return null;
    const id = name.slice(window.QS_APP_PREFIX.length);
    const list = (window.CONF && window.CONF.apps) || [];
    for (const a of list) if (a && a.id === id) return a;
    return null;
};

/** 外部软件那一格的图标节点。
 *
 *  优先用用户挑的那张图（按 `@app:<id>` 存在 overrideIcons 里，和换引擎图标
 *  同一套机制）；其次 icons 目录里**文件名 = 软件名**的默认图标（#138）；
 *  都没有才用**软件名**的首字徽标（不是哨兵名 —— 那一画出来是个 "@"，
 *  用户根本认不出）。
 *
 *  横条、设置页列表、设置页预览三处共用这一个函数，样子才不会对不上。
 *  图片加载失败时把图藏起来：徽标底下有兜底底色，至少还是一颗能点的方块。 */
window.qsAppIconNode = function (sentinel) {
    const app = window.qsAppBySentinel(sentinel);
    const nm = (app && app.name) || '软';
    const custom = window.CONF && window.CONF.overrideIcons
        ? window.CONF.overrideIcons[sentinel] : null;
    const dir = window.qsDirIconFor(nm);
    if (custom || dir) {
        const img = document.createElement('img');
        img.src = custom || dir;
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, window.CONF ? window.CONF.unifyIcons !== false : true);
        }
        return img;
    }
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = (nm.match(/[A-Za-z0-9\u4e00-\u9fa5]/) || ['软'])[0].toUpperCase();
    const P = ['#4E6EF2', '#E8500F', '#0FA36B', '#B0182A', '#7A5AF8',
        '#0E7C86', '#C2410C', '#2563EB', '#9333EA', '#0F766E'];
    let h = 0;
    for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) | 0;
    span.style.setProperty('--lt-color', P[Math.abs(h) % P.length]);
    return span;
};

/** 把一个"横条成员名"翻译成**给人看的名字**。
 *
 *  为什么需要：横条成员里有大量内部哨兵（`@ocr` / `@trans` / `@img` /
 *  `@app:<id>` / `@go:<id>` / `@fav:<id>`）。横条上它们是图标，用户只看到图；
 *  但网格页和设置列表里必须显示文字，直接把哨兵原样打出来就成了
 *  `@ocr`、`@//ocr/` 这种谁也看不懂的符号（用户原话："难以理解的符号和缩写"）。
 *
 *  规则（从具体到宽泛）：
 *    1. `@app:` / `@go:` / `@fav:` → 取对应条目的名称（收藏夹就是"收藏夹"）
 *    2. 已知固定哨兵 → 固定中文名（OCR / 翻译 / 识图 / 分隔线）
 *    3. 兜底：把 `@`、`/`、`\` 这些符号去掉；去掉后如果还是空的，退回原名
 */
/**
 * 一条「智能直达」在界面上的**显示名**。
 *
 * 优先级：**备注 > 名称 > 目标**。
 *
 * 用户口径（2026-10-31）：「即使已设置备注，备注也没有作为名称显示。需改为优先显示备注，
 * 仅在无备注时才显示名称」。所以备注不是"附带说明"，而是**主标题** ——
 * 备注通常是自动抓来的网页标题（"百度一下，你就知道"），比域名好认得多。
 *
 * 所有地方（设置列表、横条、网格格子、添加内容选板）都走这一个函数，口径不会跑偏。
 */
window.qsGoLabel = function (it) {
    if (!it) return '';
    const note = String(it.note || '').trim();
    if (note) return note;
    const name = String(it.name || '').trim();
    if (name) return name;
    return String(it.target || '').trim();
};

window.qsDisplayName = function (name) {
    if (typeof name !== 'string') return String(name == null ? '' : name);
    const raw = name.trim();
    if (!raw) return '';
    // ⓪ 模型绑定格子（@ocr:<id> / @trans:<id>）：功能名 + 具体模型
    const bound = window.qsFuncBound ? window.qsFuncBound(raw) : null;
    if (bound && bound.kind === 'txt') {
        /* 文本处理：**只显示那一件的名字**（用户口径：「文本处理这四个字就可以
         * 隐去，只显示智能去空格就可以了」）。格子本来就小，"文本处理 · 智能去空格"
         * 一挤就变成省略号，反而看不出是哪一件；分组信息由图标（同一张"纸"）
         * 和它在横条/网格里的位置表达。 */
        const meta = window.qsTextOpMeta(bound.id);
        return meta ? meta.label : ('文本处理 · ' + bound.id);
    }
    if (bound && bound.kind === 'wrap') {
        /* 单项包裹：和 @txt:<op> 一个口径 —— 只显示那一组符号的名字（「书名号」），
         * 不写"包裹符号 · 书名号"（格子小，一挤就成省略号）。
         * 符号表还没到就退回 key，绝不把 `@wrap:title` 原样糊到界面上。 */
        const meta = window.qsWrapPairMeta(bound.id);
        return meta ? meta.name : ('包裹符号 · ' + bound.id);
    }
    if (bound) {
        const baseLabel = window.qsDisplayName('@' + bound.kind);
        const model = window.qsModelName(bound.kind, bound.id);
        return baseLabel ? (baseLabel + ' · ' + model) : model;
    }
    // ① 带 id 的哨兵：去查真实名字
    try {
        if (raw.startsWith(window.QS_APP_PREFIX)) {
            const a = window.qsAppBySentinel && window.qsAppBySentinel(raw);
            if (a && a.name) return a.name;
        }
        if (window.QS_GO_PREFIX && raw.startsWith(window.QS_GO_PREFIX)) {
            const g = window.qsGoBySentinel && window.qsGoBySentinel(raw);
            /* 备注优先（用户要求"设了备注就用备注当名字"）—— 见 qsGoLabel。 */
            if (g) return window.qsGoLabel(g);
        }
        if (window.QS_FAV_PREFIX && raw.startsWith(window.QS_FAV_PREFIX)) {
            /* v2.6.2：以前一律回"收藏夹"这个泛称，网格/设置列表里两个目录
             * 长得一模一样，分不出是哪个 —— 现在回目录真名（找不到才用泛称）。 */
            const g = window.qsFavFindGroup && window.qsFavFindGroup(raw.slice(window.QS_FAV_PREFIX.length));
            return (g && g.name) || '收藏夹';
        }
    } catch (_) { /* 上面的查询失败不该影响显示 */ }
    // ② 固定哨兵 → 可读名。规范化时把 @ / \ 空格都去掉、转小写，
    //    这样 "@ocr"、"@//ocr/" 这类写法都能认出来。
    const key = raw.replace(/^[@\\/\s]+|[@\\/\s]+$/g, '').toLowerCase();
    const FIXED = {
        ocr: '文字识别',
        trans: '翻译',
        img: '识图',
        /* 包裹符号：以前漏了这一项，`@wrap` 落到下面的兜底分支，`@` 被剥掉之后
         * 界面上显示成一个英文单词「wrap」（用户报的"wrap 选项看不懂"）。
         * 它在网格里是一颗**功能格子**：点开一组符号（“” 《》 【】 等），
         * 把选中的文字套上 / 拆掉 / 换一对，和横条上那颗 [ ] 是同一件事。 */
        wrap: '包裹符号',
        txt: '文本处理',
        '|': '分隔线',
    };
    if (Object.prototype.hasOwnProperty.call(FIXED, key)) return FIXED[key];
    // ③ 兜底：还有 @ 或斜杠就剥掉；剥空了就用原名
    if (/^[@\\/]/.test(raw) || /[@\\/]$/.test(raw)) {
        const cleaned = raw.replace(/^[@\\/\s]+|[@\\/\s]+$/g, '');
        if (cleaned) return cleaned;
    }
    return raw;
};

/** 智能直达放进横条时的哨兵前缀：`@go:<id>`。
 *  和 `@app:` 同一类：横条成员、不是搜索引擎，点下去直接打开目标。
 *  Rust 侧 config::SHORTCUT_PREFIX 必须与之保持一致。 */
window.QS_GO_PREFIX = '@go:';

/** 靠哨兵名（`@go:<id>`）找到对应的直达入口；没有返回 null。 */
window.qsGoBySentinel = function (name) {
    if (typeof name !== 'string' || !name.startsWith(window.QS_GO_PREFIX)) return null;
    const id = name.slice(window.QS_GO_PREFIX.length);
    const list = (window.CONF && window.CONF.shortcuts) || [];
    for (const it of list) if (it && it.id === id) return it;
    return null;
};

/** 包裹符号在横条/网格里的哨兵名。 */
window.QS_WRAP = '@wrap';

/* ---------------- 包裹符号的「单项」（v2.11.0） ----------------
 *
 * `@wrap:<key>` 和 `@wrap` 的关系，等于 `@txt:trim` 和 `@txt`：
 *   · `@wrap`        —— 点开 12 组符号的菜单（老行为，一格全包）；
 *   · `@wrap:title`  —— 这一格只管「书名号」，点一下直接套上/拆掉并回写。
 *
 * 为什么要有：用户要求「包裹符号中的每一项单独配置到横条或网格页」——
 * 常用的人只想摆一颗「书名号」，不想每次都先点开菜单再挑。
 *
 * ⚠ 符号表**不在 JS 里另抄一份**（后端 `wrap_pairs` 是唯一来源）。这里只缓存
 *   `key → {left,right,name}`，用来出显示名；缓存没到之前，显示名退回
 *   `包裹符号 · <key>` —— 只影响标签那一瞬间，不影响功能。
 */
window.QS_WRAP_PAIRS = window.QS_WRAP_PAIRS || {};
/** `@wrap:title` → `'title'`；不是单项包裹就返回 null。 */
window.qsWrapPairId = function (name) {
    if (typeof name !== 'string') return null;
    const p = window.QS_WRAP + ':';
    if (!name.startsWith(p)) return null;
    const id = name.slice(p.length).trim();
    return id || null;
};
/** key → 那一组符号的信息（缓存没到 / 不认识的 key 返回 null）。 */
window.qsWrapPairMeta = function (id) {
    return (id && window.QS_WRAP_PAIRS[id]) || null;
};
/** 把后端 `wrap_pairs` 的结果登记进来（横条与设置页各拉一次，幂等）。 */
window.qsRegWrapPairs = function (list) {
    if (!Array.isArray(list)) return;
    for (const p of list) {
        if (p && p.key) window.QS_WRAP_PAIRS[p.key] = p;
    }
};
/** 符号表首次需要时自己拉一次（页面没主动登记时兜底）。 */
window.qsWrapLoad = async function () {
    if (window.QS_WRAP_LOADED) return window.QS_WRAP_PAIRS;
    window.QS_WRAP_LOADED = true;
    try {
        if (typeof invoke === 'function') {
            window.qsRegWrapPairs(await invoke('wrap_pairs'));
        }
    } catch (_) { /* 拿不到就继续用 key 当名字，不阻断任何操作 */ }
    return window.QS_WRAP_PAIRS;
};

/* ---------------- 文本处理（v2.10.0） ---------------- */

/** 文本处理的哨兵前缀：`@txt:<op>`（op 见 [window.QS_TEXT_OPS]）。
 *
 *  和 `@go:<id>` / `@ocr:<id>` 同一套路：**具体功能写在名字里**，所以同一个
 *  「文本处理」可以在横条/网格里放好几颗、各管一件事，互不覆盖。
 *  后端的 `text_op` 命令就是按冒号后面这段分发。
 *
 *  ⚠ 顺序即选板 / 设置页的展示顺序，按"常用的排前面"：先去空格和换行（这两件
 *    在 PDF、公众号里几乎必做），再标点，最后大小写。 */
window.QS_TEXT = '@txt';
window.QS_TEXT_OPS = [
    {
        id: 'trim', label: '智能去空格', short: '去空格', glyph: '␣',
        hint: '折叠多余空格，去掉中文之间、行首行尾的空白（换行保留）',
    },
    {
        id: 'nl', label: '智能换行', short: '合并换行', glyph: '¶',
        hint: '把排版断开的行接回一段；句末标点、列表、编号、表格的换行不动',
    },
    {
        id: 'punct:full', label: '标点转全角', short: '全角标点', glyph: '，',
        hint: ', ; : ! ? ( ) 等收成中文全角标点（不动小数点、网址）',
    },
    {
        id: 'punct:half', label: '标点转半角', short: '半角标点', glyph: ',',
        hint: '，；：！？（） 等收成英文半角标点',
    },
    {
        id: 'case:lower', label: '英文转小写', short: '转小写', glyph: 'a',
        hint: '整段英文转成小写（中文与符号不动）',
    },
    {
        id: 'case:upper', label: '英文转大写', short: '转大写', glyph: 'A',
        hint: '整段英文转成大写',
    },
    {
        id: 'case:title', label: '首字母大写（每词）', short: '首字母', glyph: 'Ab',
        hint: '每个单词的首字母大写，其余保持原样',
    },
    {
        id: 'case:sentence', label: '句首字母大写', short: '句首', glyph: 'A.',
        hint: '每句话的第一个字母大写（按 . ! ? 和换行断句）',
    },
];

/** `@txt:trim` → `'trim'`；不是文本处理就返回 null。 */
window.qsTextOpId = function (name) {
    if (typeof name !== 'string') return null;
    if (!name.startsWith(window.QS_TEXT + ':')) return null;
    return name.slice(window.QS_TEXT.length + 1);
};

/** op id → 那条元信息（找不到返回 null）。 */
window.qsTextOpMeta = function (id) {
    return window.QS_TEXT_OPS.find((o) => o.id === id) || null;
};

/** 横条/网格/设置三处共用的图标：一张带横线的纸，中间写着这个 op 的记号。 */
window.qsTextIconNode = function (opId) {
    const meta = window.qsTextOpMeta(opId);
    const glyph = (meta && meta.glyph) || '≡';
    const sp = document.createElement('span');
    sp.style.cssText = 'display:block;width:100%;height:100%;position:relative';
    sp.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
        + ' style="display:block;width:100%;height:100%;opacity:.85">'
        + '<path d="M5.5 3.5h9l4 4v13h-13z" fill="none"/>'
        + '<path d="M8.5 12h7M8.5 15.5h7M8.5 8.5h3"/></svg>'
        + '<span style="position:absolute;right:-1px;bottom:-1px;font-size:7.5px;'
        + 'line-height:1;font-weight:700;color:currentColor;background:var(--qs-bg,#fff);'
        + 'border-radius:2px;padding:0 1px"></span>';
    // 右下角那个小记号单独写（上面用 innerHTML 拼字符串，文本要转义）
    const tag = sp.lastChild;
    tag.textContent = glyph;
    return sp;
};

/** 内置功能的**统一图标节点**（OCR / 翻译 / 识图 / 包裹 / 文本处理）。
 *
 *  为什么要有它：网格页的格子里以前是 emoji（🔤🌐🖼），而横条上是各功能自己的
 *  图标（OCR 徽标、翻译那张图、识图那颗 SVG）—— 同一个功能两处长得不一样，
 *  用户会以为是两个东西。这里统一按"横条上的样子"产出，网格、预览、设置三处共用。
 *
 *  卡片里没有对应节点时（比如设置页没加载 bar），退回一个简洁的内联 SVG，
 *  绝不返回 null —— 少一张图比留个空洞好。
 */
/* 模型绑定格子（v2.8.0）：`@ocr:<id>` / `@img:<id>` / `@trans:<id>`。
 *
 * 为什么需要它：网格里原来只有"文字识别"这一颗通用格子，用哪家模型由
 * 设置里的全局选择决定。用户要的是"这一格就用百度 OCR"——所以格子名带上
 * 具体模型 id，执行时把 id 传给后端，不再回退到全局默认。
 *
 * 三处（横条 / 网格预览 / 设置列表）都要能认这种名字，所以解析放在 shared.js。 */
window.qsFuncBound = function (name) {
    if (typeof name !== 'string') return null;
    /* v2.11.0：`wrap` 也进这张表 —— `@wrap:title` 的 base 是 `@wrap`，
     * 图标 / 分发 / 显示名都要靠这条归一（和 @txt:trim 完全同构）。 */
    const m = /^@(ocr|img|trans|txt|wrap):(.+)$/.exec(name.trim());
    return m ? { kind: m[1], id: m[2] } : null;
};

/** 模型 id → 显示名。由 bar.js / settings.js 拿到后端注册表后调用登记，
 *  这样 `qsDisplayName('@ocr:baidu')` 才说得出"百度 OCR"而不是干巴巴的 id。 */
window.QS_MODEL_NAMES = window.QS_MODEL_NAMES || {};
window.qsRegModelName = function (kind, id, name) {
    if (!kind || id == null) return;
    window.QS_MODEL_NAMES[String(kind) + ':' + String(id)] = name || String(id);
};
window.qsModelName = function (kind, id) {
    return window.QS_MODEL_NAMES[String(kind) + ':' + String(id)] || String(id);
};

/** 把 `@ocr:<id>` 归一成基础哨兵 `@ocr`（图标、功能分发都用它）。 */
window.qsFuncBase = function (name) {
    const b = window.qsFuncBound(name);
    return b ? '@' + b.kind : name;
};

window.qsFuncIcon = function (name) {
    // 绑定格子（@ocr:<id> 等）用基础哨兵那张图 —— 图标表达"功能"，模型由文字说明
    const rawName = name;
    name = window.qsFuncBase ? window.qsFuncBase(name) : name;
    const conf = window.CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[name] : null;
    if (custom) {
        const img = document.createElement('img');
        img.src = custom;
        img.alt = '';
        img.draggable = false;
        return img;
    }
    if (name === window.QS_TRANS && window.qsTransIconNode) {
        return window.qsTransIconNode();
    }
    /* 识图：走 qsImgIconNode（用户指定的「识图键.png」+ 换过图标优先）。
     *
     * ⚠ v2.11.0 修的真 bug：这里原来是 `document.getElementById('btnImg')`
     *   clone 那颗按钮里的内联 SVG。两个问题：
     *     ① 那颗按钮里的图是 **v1.5.19 之前的旧四角框**，默认图早已换成
     *        「识图键.png」—— 横条上的 @img 格子与固定位按钮长得不一样，
     *        用户说"识图图标来源不明"；
     *     ② 设置页 / 网格预览里**根本没有** #btnImg，clone 出来是 null，
     *        直接掉到函数末尾那个「•」兜底（一格黑点）。 */
    if (name === window.QS_IMG) {
        if (window.qsImgIconNode) return window.qsImgIconNode();
        const src = document.getElementById('btnImg');
        const svg = src && src.querySelector('svg');
        if (svg) return svg.cloneNode(true);
    }
    if (name === window.QS_OCR) {
        /* 统一走 qsOcrIconNode：横条上那枚「OCR」徽标（.qs-ocr-tag，accent 色
         * 9.5px）。以前这里另画一枚 .letter 字母方块（8px/#B45309），
         * 于是同一个 OCR 在横条和网格/设置里两副样子。 */
        if (window.qsOcrIconNode) return window.qsOcrIconNode();
    }
    if (name === window.QS_TEXT) {
        /* 文本处理：所有 op 共用一张"带横线的纸"，具体是哪一件看格子标签。
         * 传空 opId → 不带右下角记号（选板里"文本处理"那一整组用的就是它）。 */
        return window.qsTextIconNode(window.qsTextOpId(rawName) || '');
    }
    if (name === window.QS_WRAP) {
        /* 单项（`@wrap:title`）与整颗（`@wrap`）共用同一张图 —— 和 @txt:<op>
         * 一个口径：图标表达"这是一件包裹符号的事"，具体是哪一组由格子标签说。
         * 尺寸等细节见 qsWrapIconNode 的注释（内联写死，别指望各页 CSS）。 */
        if (window.qsWrapIconNode) return window.qsWrapIconNode();
    }
    /* 最后兜底：一个点。绝不返回空节点 —— 空白格比丑图标更像"坏了"。 */
    const sp = document.createElement('span');
    sp.textContent = '•';
    return sp;
};

/** 智能直达的**内置图标**：一条 SVG path + 配色。
 *
 *  为什么用内联 SVG 而不是 emoji / 字母徽标：
 *    · emoji 在不同 Windows 版本里长得不一样（有的还是彩色的），和横条风格打架；
 *    · 字母徽标只能告诉你"首字是什么"，看不出这是网址还是视频；
 *    · SVG 走 `currentColor`，亮暗主题自动跟着变，不用维护两套图。
 *
 *  这套图只做**默认值**：用户一旦在设置里换了图（`icon` 非空），那张图永远优先。
 */
window.QS_GO_ICONS = {
    url: {
        c: '#2563EB',
        d: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.9 2.4 14.1 0 17M12 3.5c-2.4 2.9-2.4 14.1 0 17"/>',
    },
    app: {
        c: '#C2410C',
        d: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    },
    folder: {
        c: '#B45309',
        d: '<path d="M3.5 7.5A1.8 1.8 0 0 1 5.3 5.7h3.9l2.1 2.4h7.4a1.8 1.8 0 0 1 1.8 1.8v6.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"/>',
    },
    image: {
        c: '#0F766E',
        d: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="M3.8 17.2l4.6-4.4 3.3 3.1 2.6-2.4 5.4 5"/>',
    },
    video: {
        c: '#7C3AED',
        d: '<rect x="3.5" y="5.5" width="12" height="13" rx="2"/><path d="M15.5 10.3l4.4-2.6v8.6l-4.4-2.6z"/>',
    },
    audio: {
        c: '#DB2777',
        d: '<path d="M9 17V6l9-2v11"/><circle cx="6.6" cy="17.4" r="2.4"/><circle cx="15.6" cy="15.4" r="2.4"/>',
    },
    text: {
        c: '#475569',
        d: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.2 3.6v4.3h4.2"/><path d="M9 12h6M9 15.4h6M9 8.6h2.4"/>',
    },
    pdf: {
        c: '#B91C1C',
        d: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.2 3.6v4.3h4.2"/><path d="M9 17.2V12h1.4a1.4 1.4 0 0 1 0 2.8H9M13 17.2V12h1.6a2.6 2.6 0 0 1 0 5.2z"/>',
    },
    archive: {
        c: '#64748B',
        d: '<rect x="3.5" y="5" width="17" height="4.6" rx="1.2"/><path d="M5.2 9.6h13.6v9a1.6 1.6 0 0 1-1.6 1.6H6.8a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M10.6 13h2.8"/>',
    },
    code: {
        c: '#0E7490',
        d: '<path d="M9 7.5L4.5 12 9 16.5M15 7.5L19.5 12 15 16.5"/>',
    },
    doc: {
        c: '#1D4ED8',
        d: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.2 3.6v4.3h4.2"/><path d="M9 11.4h6M9 14.6h6M9 17.6h4"/>',
    },
    file: {
        c: '#6B7280',
        d: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.2 3.6v4.3h4.2"/>',
    },
};

/** 拼一个图标节点（内部用）。`kind` 认不出就退回通用文件图。 */
function qsGoSvgIcon(kind) {
    const spec = window.QS_GO_ICONS[kind] || window.QS_GO_ICONS.file;
    const span = document.createElement('span');
    span.className = 'qs-go-icon';
    span.style.color = spec.c;
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
        + spec.d + '</svg>';
    return span;
}

/** 智能直达那一格的图标节点。
 *
 *  优先级（用户要求：不同类型有不同默认图，但也允许手动改）：
 *    1. 用户自己设的图标（本地图片 / 图片地址，存成 data URL）；
 *    2. `iconKind` 对应的内置图（网址=地球、文件夹=文件夹、视频=播放器、
 *       音频=音符、图片=相框、文本=文档、软件=四方块…）；
 *    3. 实在没有（老数据、悬空哨兵）→ 退回名称首字徽标，不能留空白方块。
 *
 *  `iconKind` 由后端 `go_icon_kind()` 实时算出来（目录 / 扩展名），所以
 *  \"把 .txt 改成 .mp4\" 之后图标会自己跟着变，不需要用户重设。
 */
window.qsGoIconNode = function (sentinel) {
    const it = window.qsGoBySentinel(sentinel);
    if (it && it.icon) {
        const img = document.createElement('img');
        img.src = it.icon;
        img.alt = '';
        img.draggable = false;
        // 图裂了（用户填了个失效地址）就退回内置图，不能留个空白方块
        img.addEventListener('error', () => {
            const fb = qsGoSvgIcon(it.iconKind || it.kind || 'file');
            if (img.parentNode) img.parentNode.replaceChild(fb, img);
        });
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, window.CONF ? window.CONF.unifyIcons !== false : true);
        }
        return img;
    }
    if (it) return qsGoSvgIcon(it.iconKind || it.kind || 'file');
    // 悬空哨兵（条目刚被删、配置广播还没到）：首字徽标兜底
    const nm = (it && it.name) || '直';
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = (nm.match(/[A-Za-z0-9\u4e00-\u9fa5]/) || ['直'])[0].toUpperCase();
    span.style.setProperty('--lt-color', '#6B7280');
    return span;
};

/* ------------------------------------------------------------------ */
/* 翻译按钮（@trans）的默认图标                                          */
/* ------------------------------------------------------------------ */

/**
 * 翻译按钮的图标节点 —— **横条 / 设置页列表 / 设置页预览三处共用这一份**。
 *
 *  优先级只有两级（翻译不是真引擎，没有 iconFile 那一级）：
 *    1. 用户换过的图（overrideIcons['@trans']）—— 用户挑的永远最优先；
 *    2. 程序自带的默认图（base64 内嵌，见下方 QS_TRANS_ICON；用户 2026-10-27 指定的那张）。
 *
 *  以前这里是三处各画一枚「译」文字徽标 —— 同一个意思三份实现，改一处
 *  忘了另两处就会对不上。收到默认图标后统一收在这里。
 *
 *  图加载失败（文件被裁掉、路径写错）时退回「译」文字徽标：宁可丑一点，
 *  也不能让翻译按钮变成一颗空白方块。
 */
window.qsTransIconNode = function () {
    const conf = window.CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[window.QS_TRANS] : null;
    const unify = conf.unifyIcons !== false;
    const src = custom || window.QS_TRANS_ICON;
    if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, unify);
        }
        img.addEventListener('error', () => {
            // 自带的图读不出来 → 换回文字徽标（只在没换过图时才换：
            // 用户自己挑的图挂了，不该偷偷改成别的东西）。
            if (custom) { img.style.visibility = 'hidden'; return; }
            const span = document.createElement('span');
            // 两个 class 都带上：横条页认 .qs-trans-tag，设置页认 .trans-tag
            //（两个页面各引各的 css，兜底徽标在哪儿都得有样式）。
            span.className = 'qs-trans-tag trans-tag';
            span.textContent = '译';
            span.setAttribute('data-i18n-skip', '');
            if (img.parentNode) img.parentNode.replaceChild(span, img);
        });
        return img;
    }
    const span = document.createElement('span');
    span.className = 'qs-trans-tag trans-tag';
    span.textContent = '译';
    span.setAttribute('data-i18n-skip', '');
    return span;
};

/* ------------------------------------------------------------------ */
/* OCR 按钮（@ocr）的图标                                              */
/* ------------------------------------------------------------------ */

/**
 * 横条上那枚「OCR」徽标 —— **横条 / 网格 / 网格预览 / 设置列表四处共用**。
 *
 * 为什么要收成一份（v2.11.0）：以前横条画 `.qs-ocr-tag`（accent 色、9.5px，
 * 见 bar.css），而 `qsFuncIcon('@ocr')` 另画一枚 `.letter` 字母方块
 * （8px、`#B45309`）—— 同一个「文字识别」在横条和网格里两副样子，用户问
 * "文本识别的图标是不是用错了"。现在只有这一份。
 *
 * 优先级：用户换过的图（`overrideIcons['@ocr']`）→ 文字标。
 */
window.qsOcrIconNode = function () {
    const conf = window.CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[window.QS_OCR] : null;
    if (custom) {
        const img = document.createElement('img');
        img.src = custom;
        img.alt = '';
        img.draggable = false;
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, conf.unifyIcons !== false);
        }
        return img;
    }
    const sp = document.createElement('span');
    /* 两个 class 都带上：横条页认 .qs-ocr-tag、设置页认 .ocr-tag，
     * 两个页面各引各的 css，兜底徽标在哪儿都得有样式（同 qsTransIconNode）。 */
    sp.className = 'qs-ocr-tag ocr-tag';
    sp.textContent = 'OCR';
    sp.setAttribute('data-i18n-skip', '');
    return sp;
};

/* ------------------------------------------------------------------ */
/* 包裹符号（@wrap）的图标                                             */
/* ------------------------------------------------------------------ */

/**
 * 包裹符号的图标：**一对包角 + 中间一行字**，表达"把这段文字套起来"。
 *
 * 为什么换掉老图（v2.11.0）：老的是一对 `[` `]` 括号（`M9.5 4.5H6.5v15h3…`），
 * 在 12~24px 下几乎就是两个竖条，和「链接 / 附件」那类图标在小尺寸里分不开
 * （设置页子导航里原本还用 🧷 别针，更像附件）。现在中间加一条文字线，
 * 语义变成"文字被符号包住"，不会再被认成链接。
 *
 * ⚠ 尺寸必须写在**内联样式**里，不能指望各页面的 CSS：
 *   `.pickic > svg` / `.qs-gicon > svg` 都只认**直接子节点**，而这里外面套了
 *   一层 span（要和 .letter 那类徽标保持同一种返回形态）。以前没写尺寸，
 *   包裹图标在横条、网格、选板里全是 0×0 —— 按钮在、点得动，看着像空白格。
 */
window.qsWrapIconNode = function () {
    const conf = window.CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[window.QS_WRAP] : null;
    if (custom) {
        const img = document.createElement('img');
        img.src = custom;
        img.alt = '';
        img.draggable = false;
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, conf.unifyIcons !== false);
        }
        return img;
    }
    const sp = document.createElement('span');
    sp.style.cssText = 'display:block;width:100%;height:100%';
    sp.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
        + ' style="display:block;width:100%;height:100%">'
        + '<path d="M8.2 6.2H5.4v11.6h2.8M15.8 6.2h2.8v11.6h-2.8"/>'
        + '<path d="M9.9 12h4.2" opacity=".75"/></svg>';
    return sp;
};

/* ------------------------------------------------------------------ */
/* 识图按钮（@img）的默认图标                                          */
/* ------------------------------------------------------------------ */

/**
 * 识图按钮的图标节点 —— **横条固定位那颗 / 横条 bar_list 里那颗 /
 * 设置页列表 / 设置页预览，四处共用这一份**。
 *
 *  优先级只有两级（和翻译那颗一模一样）：
 *    1. 用户换过的图（overrideIcons['@img']）—— 用户挑的永远最优先；
 *    2. 程序自带的默认图（QS_IMG_ICON，用户指定的「识图键.png」，base64 内嵌）。
 *
 *  v1.5.19 之前这儿画的是「四角取景框 + 放大镜」的内联 SVG。用户指定了新图标，
 *  顶上去了；SVG 留作最后兜底（PNG 万一有问题，至少还是一颗能点的方块）。
 *
 *  以前这份实现在 bar.js 里（imgIconNode），横条和设置页各画各的 ——
 *  现在收在这里，两边共用一份，不会"一个换了另一个还是老样子"。
 */
window.qsImgIconNode = function () {
    const conf = window.CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[window.QS_IMG] : null;
    const unify = conf.unifyIcons !== false;
    const src = custom || window.QS_IMG_ICON;
    if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, unify);
        }
        img.addEventListener('error', () => {
            // 自带的图读不出来 → 换回内联 SVG（只在没换过图时才换：
            // 用户自己挑的图挂了，不该偷偷改成别的东西）。
            if (custom) { img.style.visibility = 'hidden'; return; }
            const holder = document.createElement('span');
            holder.innerHTML = window.QS_IMG_SVG || '';
            const svg = holder.querySelector('svg');
            if (svg) {
                svg.style.width = '100%';
                svg.style.height = '100%';
                svg.style.display = 'block';
                svg.style.fill = 'currentColor';
                if (window.qsApplyOpticalScale) window.qsApplyOpticalScale(svg, unify);
                if (img.parentNode) img.parentNode.replaceChild(svg, img);
                return;
            }
            const badge = document.createElement('span');
            badge.className = 'letter';
            badge.textContent = '识';
            badge.setAttribute('data-i18n-skip', '');
            if (img.parentNode) img.parentNode.replaceChild(badge, img);
        });
        return img;
    }
    /* 连内置图都没有（常量被改坏了）→ 退回内联 SVG。 */
    const holder = document.createElement('span');
    holder.innerHTML = window.QS_IMG_SVG || '';
    const svg = holder.querySelector('svg');
    if (svg) {
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.display = 'block';
        svg.style.fill = 'currentColor';
        if (window.qsApplyOpticalScale) window.qsApplyOpticalScale(svg, unify);
        return svg;
    }
    const badge = document.createElement('span');
    badge.className = 'letter';
    badge.textContent = '识';
    badge.setAttribute('data-i18n-skip', '');
    return badge;
};

/* ------------------------------------------------------------------ */
/* 默认图标目录（#138）+ 软件引擎类型（#135）+ 全部引擎平铺（#136/#140） */
/* ------------------------------------------------------------------ */

/** icons 目录里「文件名 = 引擎名」的默认图标（#138）。
 *
 *  用户原话：「读取 C:\Users\64381\AppData\Roaming\QuickSearch\icons 目录中的
 *  自定义图标，并将其设为软件中相应引擎的默认图标」。Rust 侧 config_view 把
 *  这个目录扫成 CONF.dirIcons（stem → data URL），已剔除被 overrideIcons
 *  引用的文件。这里只做查找：先精确命中，再忽略大小写命中（Windows 文件名
 *  本来就不区分大小写，用户丢进去的 `Baidu.png` 也该给「百度」用上）。
 *
 *  三级优先级的中间那一级：overrideIcons（图库显式挑的）> 本函数 > 引擎
 *  自带 iconFile > 字母徽标。 */
window.qsDirIconFor = function (name) {
    const di = window.CONF && window.CONF.dirIcons;
    if (!di || typeof name !== 'string' || !name) return null;
    if (di[name]) return di[name];
    const lower = name.toLowerCase();
    for (const k of Object.keys(di)) {
        if (k.toLowerCase() === lower) return di[k];
    }
    return null;
};

/** 一条外部软件的用途分类（#135）：`'search'` / `'open'`。
 *  kind 为空（老配置）时按 url 里有没有 %s 现推 —— 和 Rust 侧
 *  config::app_kind、网页引擎的 qsEngineKind 同一个口径。 */
window.qsAppKind = function (app) {
    if (!app) return 'open';
    if (app.kind === 'search' || app.kind === 'open') return app.kind;
    return String(app.url || '').indexOf('%s') >= 0 ? 'search' : 'open';
};

/** 全部引擎的平铺列表（#136 设置页 / #140 横条面板的新「全部引擎」视图用）。
 *
 *  两个来源合成一个扁数组，每条带足分组信息：
 *    · 网页引擎与快捷键引擎：engines.json 分类里的条目（含自定义引擎合进来
 *      的），分组信息直接复用 qsCatalogGroups 的结论（ bucket 逻辑只有那一
 *      份实现，两边必须一致）；
 *    · 软件引擎：**用户自己加的外部软件**（CONF.apps，#135 起有 search/open
 *      两类）—— 以前它们只躺在设置页「软件引擎」里，横条面板看不到。
 *
 *  每条：{ name, kind, group, sub, cat, eng, isApp }
 *    group: 'web' | 'app' | 'hotkey'；sub: 'search' | 'open' | 'appsearch'
 *    | 'appopen' | 'hotkey'；cat = 分类标题（软件统一「外部软件」）。
 *
 * @param groups qsCatalogGroups(catalog) 的输出（调用方传，避免重复计算）
 */
window.qsAllEngineRows = function (groups) {
    const rows = [];
    for (const g of groups || []) {
        for (const s of g.subs) {
            for (const cat of s.cats) {
                for (const e of cat.engines || []) {
                    if (s.kinds.indexOf(window.qsEngineKind(e)) < 0) continue;
                    rows.push({
                        name: e.name, kind: window.qsEngineKind(e),
                        group: g.key, sub: s.key, cat: cat.title, eng: e, isApp: false,
                        // r70：中间分类层（主题组）。qsCatalogGroups 挂在分类对象上，
                        // 这里透传到行 —— 设置页引擎库按它分中间层（见 renderAllList）。
                        theme: cat.theme || null,
                    });
                }
            }
        }
    }
    // 外部软件：按 #135 的类型进「软件搜索 / 软件直达」
    for (const a of (window.CONF && window.CONF.apps) || []) {
        if (!a || !a.name) continue;
        const kind = window.qsAppKind(a);
        rows.push({
            name: a.name, kind,
            group: 'app', sub: kind === 'search' ? 'appsearch' : 'appopen',
            cat: '外部软件', eng: a, isApp: true,
            // 外部软件自成一组（本机软件主题），不参与网页那 27 类的主题划分
            theme: { key: 'local-apps', title: '本机软件', desc: '' },
        });
    }
    return rows;
};

/* ------------------------------------------------------------------ */
/* 磨砂强度：滑块值 → 实际模糊半径的**唯一换算口径**                      */
/* ------------------------------------------------------------------ */
/** 滑块值（0-32）→ 实际模糊半径（px，带一位小数）。0 = 关。
 *
 *  三处共用：横条落样式（bar.js）、设置页滑块标签（settings.js）、
 *  设置页预览（settings.js）—— 各算各的必然出现"标签写着 16px、
 *  实际糊的是 11px"这种对不上。
 *
 *  曲线刻意做成**前段陡、后段封顶**：
 *    · 前段陡：滑块刚离开 0 就要看得见效果。原来 1:1 映射时，低值区
 *      （1-4px）在横条这种尺寸上几乎等于没开，用户会觉得"这选项没用"；
 *    · 后段封顶 24px：backdrop-filter 的 GPU 代价随半径**超线性**上涨，
 *      32px 在一条 40px 高的横条上纯属白烧，观感却和 20px 差不多。
 *
 *  实测：1→2.3px、4→4.4px、8→7.2px、16→12.8px、24→18.4px、32→24px。 */
window.qsBlurPx = function (v) {
    const n = Math.max(0, Math.min(32, Number(v) || 0));
    if (n <= 0) return 0;
    return Math.round(Math.min(24, 1.6 + n * 0.70) * 10) / 10;
};

/** 随强度一起调的饱和/亮度增益：让"毛玻璃"看起来像玻璃，而不是单纯变糊。
 *  只有 blur 时，一块灰底糊完还是灰底 —— 提饱和 + 微提亮才有玻璃的通透感。 */
window.qsBlurTone = function (v) {
    const n = Math.max(0, Math.min(32, Number(v) || 0));
    return {
        sat: Math.round((1 + Math.min(0.6, n * 0.025)) * 100) / 100,
        bright: Math.round((1 + Math.min(0.10, n * 0.0035)) * 1000) / 1000,
    };
};

/* ------------------------------------------------------------------ */
/* 收藏夹：横条 / 设置预览 / 设置列表三处**共用**的工具                  */
/* ------------------------------------------------------------------ */

/** 收藏树（两级）。以 CONF.favorites 为准。 */
window.qsFavGroups = function () {
    return (window.CONF && Array.isArray(window.CONF.favorites)) ? window.CONF.favorites : [];
};

/** 在收藏树里按 id 找目录（一级、二级都翻）。 */
window.qsFavFindGroup = function (id) {
    for (const g of window.qsFavGroups()) {
        if (g.id === id) return g;
        for (const sub of g.children || []) {
            if (sub.id === id) return sub;
        }
    }
    return null;
};

/** 收藏夹目录的图标，**三处必须长一个样**（用户报过"预览和横条不一致"）：
 *   1. 换过自定义图标（overrides 里有）→ 那张图；
 *   2. 目录自带图标（g.icon）→ 那张图；
 *   3. 都没有 → **首字徽标**：目录名第一个字 + 圆形外框。
 * 样式在各页面的 css 里定义 `.qs-fav-badge`（变量不同，观感一致）。 */
window.qsFavIconNode = function (sentinel) {
    const conf = window.CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[sentinel] : null;
    const mkImg = (src) => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        return img;
    };
    if (custom) return mkImg(custom);
    const g = window.qsFavFindGroup(String(sentinel).slice(window.QS_FAV_PREFIX.length));
    if (g && g.icon) return mkImg(g.icon);
    const d = document.createElement('span');
    d.className = 'qs-fav-badge';
    d.textContent = ((g && g.name) || '★').trim().charAt(0) || '★';
    return d;
};

/**
 * 把 `CONF.customEngines` 合并进引擎目录。
 *
 * @param catalog  已经 fetch 好的 data/engines.json（会被就地修改）
 * @param byName   name -> 引擎对象 的 Map（会被就地填充）
 * @param conf     Rust 侧配置（读 customEngines）
 * @returns        这次实际并入的引擎个数
 *
 * **这个函数是幂等的，可以反复调用**：开头的第一件事是把上一次并进去的
 * 自定义引擎全部摘干净，再按当前的配置重新并一遍。
 * 不这么做的话，用户删掉一个自定义引擎、或者把「Kimi 镜像」改名成
 * 「备用 Kimi」之后，旧条目会赖在目录里不走 —— 面板上会出现一个点了没反应、
 * 也搜不出东西的幽灵图标。
 *
 * 合并规则：
 *   · 按 category 分组 —— 同名分类就并进去，新分类就追加一组；
 *   · 用户填「AI 工具」时正好命中内置的 AI 分类，于是自动获得 AI 待遇
 *     （提问后缀 + 复制整份提问到剪贴板），不需要额外开关。
 */
window.qsMergeCustomEngines = function (catalog, byName, conf) {
    if (!catalog) return 0;

    // ---- ① 先把上次并进去的摘干净（标记是 custom: true）----
    for (const [name, eng] of Array.from(byName)) {
        if (eng && eng.custom) byName.delete(name);
    }
    if (Array.isArray(catalog.categories)) {
        for (const c of catalog.categories) {
            if (Array.isArray(c.engines)) {
                c.engines = c.engines.filter((e) => !(e && e.custom));
            }
        }
        // 摘空了的分类整组删掉，免得面板上留一个只有标题没有内容的空栏
        catalog.categories = catalog.categories.filter(
            (c) => Array.isArray(c.engines) && c.engines.length > 0
        );
    }

    // ---- ② 再按当前配置重新并 ----
    const list = (conf && conf.customEngines) || [];
    if (!list.length) return 0;

    const byTitle = new Map();
    for (const c of catalog.categories || []) byTitle.set(c.title, c.engines);

    let added = 0;
    for (const ce of list) {
        const name = ((ce && ce.name) || '').trim();
        const url = ((ce && ce.url) || '').trim();
        const hotkey = ((ce && ce.hotkey) || '').trim();
        if (!name) continue;
        // kind 先定：快捷键类的地址本来就是空的（点了不打开页面），
        // 拿「url 非空」当准入条件会把它整条筛掉。
        const kind = (ce && ce.kind === 'open') ? 'open'
            : (ce && ce.kind === 'hotkey') ? 'hotkey'
                : (url.indexOf('%s') >= 0 ? 'search' : 'open');
        if (kind === 'hotkey' && !hotkey) continue;
        if (kind !== 'hotkey' && !url) continue;
        // 和内置引擎重名时内置优先 —— 后端本来就拦着不让重名，这里只是兜底
        if (byName.has(name)) continue;

        const title = ((ce.category || '自定义').trim()) || '自定义';
        let arr = byTitle.get(title);
        if (!arr) {
            arr = [];
            catalog.categories = catalog.categories || [];
            catalog.categories.push({ title, engines: arr });
            byTitle.set(title, arr);
        }
        // kind 一起带过来：面板格子 / 横条气泡要靠它区分「搜 / 开 / 键」三类。
        const eng = {
            name, url, custom: true, kind,
        };
        if (kind === 'hotkey') eng.hotkey = hotkey;
        arr.push(eng);
        byName.set(name, eng);
        added++;
    }
    return added;
};


/**
 * 这个引擎是哪一类：`search` = 拿选中的词跳过去搜；`open` = 直接打开指定页面；
 * `hotkey` = 点了把一串组合键模拟发给前台软件（不碰浏览器）。
 *
 * engines.json 的每个条目都带显式的 `kind`，这里优先听它的；没写这个字段的
 * （老数据 / 手搓条目）按 URL 里有没有 `%s` 推断 —— 和 Rust 的 `engine_entry`
 * 同一个口径，两边判必须一致，否则界面说"打开"、点下去却去搜索了。
 *
 * @param eng 引擎对象（ engines.json 的一条，或合并进来的自定义引擎）
 * @returns 'search' | 'open' | 'hotkey'
 */
window.qsEngineKind = function (eng) {
    if (!eng) return 'search';
    if (eng.kind === 'open' || eng.kind === 'search' || eng.kind === 'hotkey') return eng.kind;
    return String(eng.url || '').indexOf('%s') >= 0 ? 'search' : 'open';
};


/**
 * 从引擎目录派生「三大类 × 二级细分」的展示结构。
 *
 * engines.json（schema 2）给每个分类打了 group / sub 标签：
 *   · group: 'web' 网页引擎 | 'app' 软件引擎 | 'hotkey' 快捷键引擎；
 *   · sub:   'both'（网页类：搜/开两类混在一个分类里，按 kind 现场拆）|
 *            'appsearch' 软件搜索 | 'appopen' 软件直达 | 'hotkey' 快捷键。
 * 老数据 / 用户自建分类（自定义引擎合进来的「自定义」等）没有标签 ——
 * 里面全是 hotkey 的归快捷键引擎，其余一律归网页引擎、sub='both'。
 *
 * r70：**主题层（中间分类）**。27 个小分类（网页 / 知识 / 开发 / 购物…）
 * 以前在大类 → 中类下面**一字平铺**，用户原话「避免仅有小分类，分类结构要
 * 清晰完整」。现在 engines.json 的 `themes` 把它们归成 8 个主题组
 * （搜索与 AI / 知识教育 / 开发工具 / 影音娱乐 / 生活消费 / 社交资讯 /
 * 本机软件 / 组合键），qsCatalogGroups 把 `theme`（{key,title,desc}）挂到
 * 每个分类对象上，渲染层按它分组即可。没进任何主题的（用户自建分类）
 * 落到 `其他`。
 *
 * 返回：
 *   [{ key, title, desc, count,
 *      subs: [{ key, title, desc, kinds: ['search'|'open'|'hotkey'],
 *               cats: [分类对象…（带 theme）], count }] }]
 * sub.cats 里同一个分类可能被 search/open 两个子类同时引用（sub='both'），
 * 渲染时用 sub.kinds 过滤条目即可；快捷键组的分类只进 hotkey 子类。
 */
window.qsCatalogGroups = function (catalog) {
    const cats = (catalog && Array.isArray(catalog.categories)) ? catalog.categories : [];
    const metas = (catalog && Array.isArray(catalog.groups)) ? catalog.groups : [];

    const GMETA = {
        web: { title: '网页引擎', desc: '浏览器里的搜索引擎与网页直达' },
        app: { title: '软件引擎', desc: '本机软件与系统工具：搜索、直达' },
        hotkey: { title: '快捷键引擎', desc: '把组合键发给前台软件' },
    };
    for (const g of metas) {
        if (g && GMETA[g.key]) {
            if (g.title) GMETA[g.key].title = g.title;
            if (g.desc) GMETA[g.key].desc = g.desc;
        }
    }

    // 子类模板：标题/描述优先用 json 元数据，缺省用内置文案
    const SUB_DEF = [
        { key: 'search', group: 'web', title: '搜索引擎', kinds: ['search'],
          desc: '拿选中的词跳过去搜（地址带 %s，没有选中文字时点了没反应）' },
        { key: 'open', group: 'web', title: '直达网页', kinds: ['open'],
          desc: '不依赖选中的文字，点了直接打开这个页面' },
        { key: 'appsearch', group: 'app', title: '软件搜索', kinds: ['search'],
          desc: '调用本机软件执行搜索：填软件自己的协议地址，用 %s 标出搜索词' },
        { key: 'appopen', group: 'app', title: '软件直达', kinds: ['open'],
          desc: '点一下直接打开这个软件（或软件内指定的页面）' },
        { key: 'hotkey', group: 'hotkey', title: '快捷键', kinds: ['hotkey'],
          desc: '点了把一串组合键模拟发给当时的前台软件（不碰浏览器）' },
    ];
    const subMeta = (key, group) => {
        for (const g of metas) {
            const s = (g.subs || []).find((x) => x.key === key);
            if (s) return s;
        }
        const d = SUB_DEF.find((x) => x.key === key);
        return d || { key, title: key, kinds: [], desc: '' };
    };

    const bucket = (c) => {
        let g = c.group;
        if (g !== 'web' && g !== 'app' && g !== 'hotkey') {
            g = (c.engines || []).some((e) => qsEngineKind(e) === 'hotkey') ? 'hotkey' : 'web';
        }
        const s = c.sub;
        if (g === 'hotkey' || s === 'hotkey') return { group: 'hotkey', sub: 'hotkey' };
        if (g === 'app') {
            return { group: 'app', sub: s === 'appsearch' ? 'appsearch' : 'appopen' };
        }
        // 网页引擎：没标签 / 'both' 的分类搜开两类都进；显式标了 search/open 的
        // （自定义引擎自建分类可能这么标）只进对应子类
        return { group: 'web', sub: (s === 'search' || s === 'open') ? s : 'both' };
    };

    /* r70：主题层（中间分类）。数据优先用 engines.json 的 `themes`，
     * 缺失（老数据文件 / 用户自建）用这份代码兜底 —— 和 SUB_DEF 同一个套路：
     * 两份描述同一件事，数据那份赢。 */
    const THEME_DEF = [
        { key: 'search-ai', title: '搜索与 AI', desc: '综合搜索与 AI 问答' },
        { key: 'knowledge', title: '知识教育', desc: '百科 / 学术 / 学习 / 阅读 / 词典 / 翻译' },
        { key: 'dev-tools', title: '开发工具', desc: '编程 / 在线工具 / 网盘 / 邮箱' },
        { key: 'media-fun', title: '影音娱乐', desc: '图片 / 音乐 / 视频 / 游戏' },
        { key: 'life-shop', title: '生活消费', desc: '购物 / 汽车 / 生活服务 / 财经 / 地图' },
        { key: 'social-news', title: '社交资讯', desc: '社交平台与新闻资讯' },
        { key: 'local-apps', title: '本机软件', desc: '本机软件与系统工具' },
        { key: 'hotkeys', title: '组合键', desc: '发给前台软件的组合键' },
    ];
    // 分类标题 → 主题（兜底表）
    const THEME_OF = {
        '网页': 'search-ai', 'AI 工具': 'search-ai',
        '知识': 'knowledge', '学术': 'knowledge', '学习': 'knowledge',
        '阅读': 'knowledge', '词典': 'knowledge', '翻译': 'knowledge',
        '开发': 'dev-tools', '工具': 'dev-tools', '应用': 'dev-tools',
        '网盘': 'dev-tools', '邮箱': 'dev-tools',
        '图片': 'media-fun', '音乐': 'media-fun', '视频': 'media-fun', '游戏': 'media-fun',
        '购物': 'life-shop', '汽车': 'life-shop', '生活': 'life-shop',
        '财经': 'life-shop', '地图': 'life-shop',
        '社交': 'social-news', '新闻': 'social-news',
        '软件搜索': 'local-apps', '常用软件': 'local-apps',
        '快捷键': 'hotkeys',
    };
    const themesMeta = (catalog && Array.isArray(catalog.themes)) ? catalog.themes : [];
    const themeMeta = (key) => {
        for (const t of themesMeta) if (t && t.key === key) return t;
        const d = THEME_DEF.find((x) => x.key === key);
        return d || null;
    };
    // 一个分类的主题：json themes 点名 > 兜底表 > 其他
    const themeOfCat = (c) => {
        const title = String(c.title || '');
        for (const t of themesMeta) {
            if (t && Array.isArray(t.cats) && t.cats.indexOf(title) >= 0) {
                return { key: t.key || title, title: t.title || title, desc: t.desc || '' };
            }
        }
        const k = THEME_OF[title];
        if (k) {
            const m = themeMeta(k);
            return { key: k, title: (m && m.title) || k, desc: (m && m.desc) || '' };
        }
        return { key: 'other', title: '其他', desc: '' };
    };

    const acc = { web: {}, app: {}, hotkey: {} };
    for (const c of cats) {
        const b = bucket(c);
        // r70：主题信息直接挂在分类对象上（渲染层按 c.theme 分组）
        c.theme = themeOfCat(c);
        if (b.sub === 'both') {
            (acc.web.search = acc.web.search || []).push(c);
            (acc.web.open = acc.web.open || []).push(c);
        } else {
            (acc[b.group][b.sub] = acc[b.group][b.sub] || []).push(c);
        }
    }

    const out = [];
    for (const gkey of ['web', 'app', 'hotkey']) {
        const subs = SUB_DEF.filter((d) => d.group === gkey).map((d) => {
            const m = subMeta(d.key, gkey);
            const list = acc[gkey][d.key] || [];
            const count = list.reduce((n, c) => n
                + c.engines.filter((e) => d.kinds.indexOf(qsEngineKind(e)) >= 0).length, 0);
            return {
                key: d.key, title: m.title || d.title, desc: m.desc || d.desc,
                kinds: d.kinds, cats: list, count,
            };
        }).filter((s) => s.cats.length > 0);
        out.push({
            key: gkey, title: GMETA[gkey].title, desc: GMETA[gkey].desc,
            subs, count: subs.reduce((n, s) => n + s.count, 0),
        });
    }
    return out.filter((g) => g.subs.length > 0);
};


/**
 * 去掉无意义的分隔线：开头、结尾的，以及连着出现好几条的。
 *
 * 不清理的话，用户在设置里手滑加两条就会在横条上看到一根粗了一倍、
 * 或者贴在左边缘的竖线 —— 看起来像 bug，其实是数据。
 */
window.qsNormalizeBarList = function (list) {
    const SEP = window.QS_SEP;
    const out = [];
    for (const n of list || []) {
        if (n === SEP) {
            if (!out.length) continue;               // 开头的丢掉
            if (out[out.length - 1] === SEP) continue; // 连着重复的丢掉
            out.push(SEP);
        } else {
            out.push(n);
        }
    }
    while (out.length && out[out.length - 1] === SEP) out.pop(); // 结尾的丢掉
    return out;
};


/* ============================================================================
 *  图标「视觉尺寸」归一
 *
 *  问题：图标都是按「整张画布缩进同一个方框」（object-fit: contain）来显示的，
 *  可各家图标的画布留白差得很远 ——
 *    · 铺满型（大多数内置 SVG）：内容 = 画布的 100%
 *    · 带留白的 PNG：内容只有画布的 84%~96%
 *  结果就是同一排图标里，带留白的那些看起来**明显偏小**，一排大小参差不齐。
 *  （实测用户换的淘宝/天猫图标：200×200 画布，内容只有 88%。）
 *
 *  做法：把图标真的画到一块小画布上，量出**非透明内容**的包围盒，
 *  得到一个「内容占画布多大」的比例 fill；再给这个图标一个放大系数
 *  k = 1/fill（夹在 1~1.5），把内容撑到和铺满型图标一样的视觉尺寸。
 *
 *  为什么不用 Rust 侧算：图标有 61 个 SVG，SVG 没法用 image crate 解码，
 *  而浏览器**本来就会渲染**它 —— 画进 canvas 再量包围盒，SVG 的 viewBox 留白
 *  也一并算进去了，比任何静态分析都准，而且内置图标和用户自定义图标一视同仁。
 *
 *  只在同一个页面里缓存一次（Map），量完就同步取用，不会反复解码。
 * ========================================================================== */

(function () {
    /** 测量用的画布边长。
     *  96 是精度和开销的折中：64 的时候，一个内容占 96% 的图标（京东）会因为
     *  降采样误差被量成 98%，直接顶到「铺满型」阈值上、拿不到补偿。 */
    const S = 96;
    /** 降采样会把内容边缘「晕开」约 1 个像素（200→96 时尤其明显），
     *  量出来的包围盒比真实内容大一圈。这里统一收掉 1 像素再算占比，
     *  否则接近铺满的图标会被误判成铺满。 */
    const EDGE_INSET = 1;
    /** 放大系数上限。留白极端离谱的图标也不至于被撑爆。 */
    const K_MAX = 1.5;
    /** 占比高于这个值就当「已经是铺满型」，不动它 ——
     *  铺满型图标量出来会有 1 个像素上下的抗锯齿误差，不该因此被缩一下。 */
    const NOOP_FILL = 0.98;
    /** 算 bbox 时用「这行/列至少要有这么多非透明像素」作为收边阈值。
     *
     *  之前的问题：单纯用「alpha > 8 的像素」的最小包围盒，**离群的稀疏像素**
     *  （比如右上角一个小小的版权小字、几条装饰边线）会把整张图的包围盒顶满。
     *  一个 88% 的图标被这种像素「拉满」后 → 算出来 fill = 1.0 → 拿到 1.0 倍补偿
     *  → 看上去还是比邻居那张 92% 的图标小。
     *
     *  修法：先按 alpha > 8 拿一个粗 bbox；然后**逐行/逐列统计非透明像素密度**，
     *  把低于这个阈值的行/列从上下左右两侧剪掉，得到「主体区域」的 bbox。
     *  阈值 0.04 ≈ 96px 上不到 4 个像素就当稀疏噪声，跟抗锯齿晕开一个量级，
     *  不会误剪真图标。 */
    const ROW_DENSITY_THRESHOLD = 0.04;

    /** url -> 放大系数（已量好） */
    const done = new Map();
    /** url -> 等待回调数组（正在量） */
    const waiting = new Map();

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /** 算 a/b =「这一行/列里非透明像素数 / 该行/列总像素数」。 */
    function densityAt(pixels, idx) {
        // pixels 在调用方保证是 4 字节步长，且已经按 alpha > 8 填过。
        let n = 0;
        for (let i = 0; i < S; i++) {
            if (pixels[(idx * S + i) * 4 + 3] > 8) n++;
        }
        return n / S;
    }

    /** 紧致包围盒：上下左右四个方向逐行/逐列往里找，凡是密度低于阈值的行/列
     *  就当噪声，从那侧退出。返回的 box 是闭区间 [x0..x1, y0..y1]。 */
    function tightBox(pixels, x0, y0, x1, y1) {
        let ty0 = y0;
        while (ty0 <= y1 && densityAt(pixels, ty0) < ROW_DENSITY_THRESHOLD) ty0++;
        let ty1 = y1;
        while (ty1 >= ty0 && densityAt(pixels, ty1) < ROW_DENSITY_THRESHOLD) ty1--;
        let tx0 = x0;
        while (tx0 <= x1 && colDensity(pixels, tx0, y0, y1) < ROW_DENSITY_THRESHOLD) tx0++;
        let tx1 = x1;
        while (tx1 >= tx0 && colDensity(pixels, tx1, y0, y1) < ROW_DENSITY_THRESHOLD) tx1--;
        if (ty0 > ty1 || tx0 > tx1) {
            // 整个图都被判成噪声了 —— 退回粗 bbox，别给空盒子。
            return { x0, y0, x1, y1 };
        }
        return { x0: tx0, y0: ty0, x1: tx1, y1: ty1 };
    }

    function colDensity(pixels, x, y0, y1) {
        let n = 0;
        for (let y = y0; y <= y1; y++) {
            if (pixels[(y * S + x) * 4 + 3] > 8) n++;
        }
        return n / Math.max(1, y1 - y0 + 1);
    }

    /** 把图标画进小画布，量出主体区域（非离群像素）的包围盒，换算成放大系数。 */
    function measure(url) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (k) => { if (!settled) { settled = true; resolve(k); } };
            // 兜底：图片永远不 load/error 时别把回调挂死
            setTimeout(() => finish(1), 4000);

            const img = new Image();
            img.onload = () => {
                try {
                    const cv = document.createElement('canvas');
                    cv.width = cv.height = S;
                    const cx = cv.getContext('2d', { willReadFrequently: true });
                    cx.clearRect(0, 0, S, S);
                    // 显式给目标尺寸：SVG 只有 viewBox 时也能按 contain 语义渲染进来
                    cx.drawImage(img, 0, 0, S, S);
                    const d = cx.getImageData(0, 0, S, S).data;

                    /* —— 先认出"底色"，再量主体 ——
                     * 用户反馈：很多图标自带一圈白边/色块外框（比如一个字外面
                     * 套了个圆底），光按"非透明像素"量 bbox 根本裁不掉它，
                     * 于是"统一图标大小"也救不回来 —— 外框本身就是主体的一部分。
                     * 做法：取四角里第一个不透明像素当"底色"，量 bbox 时把
                     * 颜色和它足够接近的像素**当作背景**一起排除。
                     * 全透明底（图标本身就是镂空的）就退回只按 alpha 判，
                     * 跟原来一个行为 —— 不至于把同色主体误伤掉。 */
                    let br = 0, bg = 0, bb = 0, ba = 0;
                    const corners = [
                        0,
                        (S - 1) * 4,
                        (S - 1) * S * 4,
                        ((S - 1) * S + (S - 1)) * 4,
                    ];
                    for (const o of corners) {
                        if (d[o + 3] > 8) { br = d[o]; bg = d[o + 1]; bb = d[o + 2]; ba = d[o + 3]; break; }
                    }
                    const hasBg = ba > 8;
                    const TOL = 14;   // 每通道容差：抗锯齿的渐变边也算背景
                    const isBg = (i) => {
                        if (d[i + 3] <= 8) return true;                 // 透明一律算背景
                        if (!hasBg) return false;
                        return Math.abs(d[i] - br) <= TOL
                            && Math.abs(d[i + 1] - bg) <= TOL
                            && Math.abs(d[i + 2] - bb) <= TOL;
                    };

                    let x0 = S, y0 = S, x1 = -1, y1 = -1;
                    for (let y = 0; y < S; y++) {
                        for (let x = 0; x < S; x++) {
                            // 主体像素 = 既不透明、颜色又不像底色（白边/外框在这一步被裁掉）
                            if (!isBg((y * S + x) * 4)) {
                                if (x < x0) x0 = x;
                                if (x > x1) x1 = x;
                                if (y < y0) y0 = y;
                                if (y > y1) y1 = y;
                            }
                        }
                    }
                    if (x1 < 0) { finish(1); return; }        // 全是背景：别乱缩放

                    // 第一步拿到的是「整张图所有非透明像素」的最小 bbox ——
                    // 但离群的稀疏像素（角上的版权、远端的小元素）会把 bbox
                    // 顶满，结果这种图标就拿不到补偿。
                    // 第二步：把这个粗 bbox 里的主体区域重新收紧：逐行/逐列
                    // 检查密度，低于阈值的行/列从那侧剪掉。
                    const t = tightBox(d, x0, y0, x1, y1);

                    const cw = Math.max(1, t.x1 - t.x0 + 1 - EDGE_INSET);
                    const ch = Math.max(1, t.y1 - t.y0 + 1 - EDGE_INSET);
                    const fill = Math.max(cw, ch) / S;
                    if (!(fill > 0.02)) { finish(1); return; }
                    if (fill >= NOOP_FILL) { finish(1); return; }  // 已经是铺满型
                    finish(clamp(1 / fill, 1, K_MAX));
                } catch (e) {
                    // canvas 被跨域污染 / 环境不支持 → 不缩放，保持原样最安全
                    finish(1);
                }
            };
            img.onerror = () => finish(1);
            img.src = url;
        });
    }

    /**
     * 一份 data URL 映射表的**轻量指纹**（键 + 每项长度 + 首尾片段）。
     *
     * 用途：横条 / 设置页都要判断"图标有没有变过、要不要重画"，而配置广播
     * 很频繁（收藏面板拖一下尺寸就 600ms 一次）。
     *  - 不能直接 `JSON.stringify(map)`：收藏夹里的图片是几 MB 的 base64，
     *    每次广播整串拼一遍，防抖本身就成了新开销；
     *  - 也不能只看键：**换图标**时键不变、图变了，列表必须重画。
     *
     * 折中：长度变了 / 首尾 12 字符变了，就当作"换过了"。图标文件的
     * 编解码是确定性的，同内容一定同长度同首尾，不会漏判。
     */
    window.qsIconSigOf = function (map) {
        if (!map) return '';
        const keys = Object.keys(map);
        if (!keys.length) return '';
        let s = '';
        for (const k of keys) {
            const v = String(map[k] || '');
            s += k + ':' + v.length + ':' + v.slice(0, 12) + v.slice(-12) + '\u0001';
        }
        return s;
    };

    /**
     * 取某个图标 URL 的放大系数。
     * @returns 已量好 → 数字；还没量 → null（同时触发测量，量完回调 onReady）
     */
    window.qsIconScale = function (url, onReady) {
        if (!url) return 1;
        if (done.has(url)) return done.get(url);
        const list = waiting.get(url);
        if (list) {
            if (onReady) list.push(onReady);
            return null;
        }
        waiting.set(url, onReady ? [onReady] : []);
        measure(url).then((k) => {
            done.set(url, k);
            const cbs = waiting.get(url) || [];
            waiting.delete(url);
            for (const cb of cbs) {
                try { cb(k); } catch (e) { /* 回调自己出错不该影响别人 */ }
            }
        });
        return null;
    };

    /**
     * 把归一后的放大系数落到一个图标节点上。
     *
     * 走 CSS 变量 `--qs-optical`，和原有的 `--qs-inset`（引擎目录里手工微调的
     * 光学补偿）**相乘**：两者各管一段、互不覆盖。
     *
     * ⚠ r70：**内联 SVG 也走这条管线**。以前只认 `<img>`（`tagName !== 'IMG'`
     *   直接 return），于是横条上那颗识图搜索按钮（index.html 里的内联 SVG）
     *   从来没被量过 —— 用户报的「内置的消除主体以外多余部分的算法没在识图
     *   图标上生效」就是这一句：不是算法不工作，是算法**根本没被调用**。
     *   SVG 的处理：序列化成 data URL → 和 <img> 完全同一条测量管线
     *   （canvas 画进去量主体包围盒）→ 系数写回节点自己的 `--qs-optical`，
     *   由 CSS 的 `transform: scale(var(--qs-optical,1))` 应用。
     *   颜色不受影响：量的是 alpha，序列化副本没有 currentColor 也能量。
     *
     * @param node    图标节点（<img> 或内联 <svg>）
     * @param enabled 总开关（设置里的「统一图标大小」）；关掉就清掉系数
     */
    window.qsApplyOpticalScale = function (node, enabled) {
        if (!node) return;
        if (!enabled) {
            node.style.removeProperty('--qs-optical');
            return;
        }
        if (node.tagName === 'svg') {
            applyToSvg(node);
            return;
        }
        if (node.tagName !== 'IMG') return;
        const img = node;
        const url = img.src;
        if (!url) return;
        const set = (k) => {
            if (k && k > 1.0001) img.style.setProperty('--qs-optical', String(k));
            else img.style.removeProperty('--qs-optical');
        };
        const k = window.qsIconScale(url, set);
        if (k != null) set(k);      // 已缓存：同步生效，不闪
    };

    /** 内联 SVG 的光学补偿：序列化 → 测量 → 落系数（见 qsApplyOpticalScale 文档）。 */
    function applyToSvg(svg) {
        let url;
        try {
            // 补上显式宽高：SVG 只有 viewBox 时，drawImage 的 contain 语义依赖
            // 调用方给目标尺寸（measure 里是 cx.drawImage(img,0,0,S,S)），但
            // 有些内核对"无宽高 SVG"的 natural size 报 0，量出来是个空盒子。
            const clone = svg.cloneNode(true);
            if (!clone.getAttribute('width')) clone.setAttribute('width', '256');
            if (!clone.getAttribute('height')) clone.setAttribute('height', '256');
            if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            const markup = new XMLSerializer().serializeToString(clone);
            url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
        } catch (e) {
            return;   // 序列化失败（极端老环境）：不缩放，保持原样最安全
        }
        const set = (k) => {
            if (k && k > 1.0001) svg.style.setProperty('--qs-optical', String(k));
            else svg.style.removeProperty('--qs-optical');
        };
        const k = window.qsIconScale(url, set);
        if (k != null) set(k);
    }
})();

/* ============================================================================
 *  富文本收藏：HTML 白名单 sanitize
 *
 *  收藏夹的文字要能带格式（用户要求「文字颜色跟着文本的格式走」）：
 *  从网页 / Word 复制带颜色的文字粘进收藏夹，颜色得存得住、显示得了、
 *  复制出去还要带得走。
 *
 *  但 HTML 是执行面 —— <img onerror=…>、<a href="javascript:…">、
 *  style 里夹 url()/expression() 都能在这儿跑起来，而这段 HTML 来自剪贴板
 *  （完全不可信）还要进 config.json、被另一个窗口（横条）渲染。
 *  所以只放行一张很小的白名单，其余一律摘掉、只留文本。
 *
 *  入口：window.qsSanitizeRichText(html) -> 干净 HTML（可能为空串）
 *  · 存进收藏树之前 sanitize 一次（settings.js 的粘贴/输入处理）；
 *  · 渲染之前再 sanitize 一次（bar.js / settings.js）—— 配置可能从备份
 *    恢复、可能被手改，渲染端不信任任何存进来的内容。
 * ========================================================================== */
(function () {
    /** 放行的标签（结构 + 文字样式）。其余全部拆栈、保留文本。 */
    const TAGS = {
        B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, INS: 1,
        SPAN: 1, BR: 1, DIV: 1, P: 1, FONT: 1, MARK: 1, SMALL: 1, SUB: 1,
        SUP: 1, CODE: 1,
    };
    /** 放行的 style 属性（其余属性全部丢弃 —— 包括 on*、href、src、class）。 */
    const STYLE_PROPS = {
        color: 1, 'background-color': 1,
        'font-weight': 1, 'font-style': 1, 'text-decoration': 1,
    };
    /** 颜色值：hex / rgb() / rgba() / 英文颜色名。挡掉 url()、expression()。 */
    const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[0-9.%\s,/+]*\)|[a-z]{3,24})$/i;
    const FONT_WEIGHT_RE = /^(normal|bold|bolder|lighter|[1-9]00)$/;
    const FONT_STYLE_RE = /^(normal|italic|oblique)$/;
    const TD_TOKENS = { none: 1, underline: 1, 'line-through': 1, overline: 1 };

    /** 按属性名校验样式值，不合法返回 null（= 丢掉这个属性）。 */
    function cleanStyleValue(prop, raw) {
        const v = String(raw || '').trim().toLowerCase();
        if (!v) return null;
        if (prop === 'color' || prop === 'background-color') {
            return COLOR_RE.test(v) ? v : null;
        }
        if (prop === 'font-weight') return FONT_WEIGHT_RE.test(v) ? v : null;
        if (prop === 'font-style') return FONT_STYLE_RE.test(v) ? v : null;
        if (prop === 'text-decoration') {
            const parts = v.split(/\s+/).filter(Boolean);
            if (!parts.length) return null;
            for (const t of parts) if (!TD_TOKENS[t]) return null;
            return parts.join(' ');
        }
        return null;
    }

    /** 把一个元素的 style 属性过一遍白名单，返回干净的 "k:v;k:v"（可能为空）。 */
    function cleanStyleAttr(styleText) {
        const out = [];
        for (const decl of String(styleText || '').split(';')) {
            const i = decl.indexOf(':');
            if (i <= 0) continue;
            const prop = decl.slice(0, i).trim().toLowerCase();
            if (!STYLE_PROPS[prop]) continue;
            const v = cleanStyleValue(prop, decl.slice(i + 1));
            if (v) out.push(prop + ':' + v);
        }
        return out.join(';');
    }

    /** 递归重建一棵干净的树。src -> dst（dst 是白名单元素或容器）。 */
    function walk(src, dst) {
        for (const node of Array.from(src.childNodes)) {
            if (node.nodeType === 3) {                       // 文本节点：原样搬
                dst.appendChild(document.createTextNode(node.nodeValue));
            } else if (node.nodeType === 1) {                // 元素节点
                const name = node.tagName.toUpperCase();
                if (!TAGS[name]) {                           // 黑名单标签：拆栈留文本
                    walk(node, dst);
                    continue;
                }
                const el = document.createElement(name.toLowerCase());
                const st = cleanStyleAttr(node.getAttribute('style'));
                if (st) el.setAttribute('style', st);
                // <font color="red">：Word / 老网页的遗产格式，翻成 style
                if (name === 'FONT') {
                    const c = cleanStyleValue('color', node.getAttribute('color'));
                    if (c) el.setAttribute('style', (st ? st + ';' : '') + 'color:' + c);
                }
                walk(node, el);
                dst.appendChild(el);
            }
            // 注释、CDATA、处理指令：全丢
        }
    }

    window.qsSanitizeRichText = function (html) {
        if (!html) return '';
        try {
            const doc = new DOMParser().parseFromString(String(html), 'text/html');
            const box = document.createElement('div');
            walk(doc.body, box);
            return box.innerHTML;
        } catch (e) {
            return '';   // 解析失败：宁可丢格式也不放进来的东西
        }
    };
})();


/* ============================================================================
 *  r53：层级目录的「胶囊选择器」—— 设置页与横条面板**共用这一个**，口径不会分叉
 *
 *  用户要求（横条「更多引擎」）：「只显示一级目录，一些详细的子目录要隐藏，我点击
 *  一级目录之后再会弹出 2 级目录。不然所有的目录都混在一起太杂了……最好所有的 2 级
 *  目录它都用一个胶囊显示，我点开胶囊之后它会展开，我选择哪一个然后就显示哪一个」
 *
 *  用法：qsPickNav(host, { items, value, onPick })
 *    host  : 放胶囊的容器（会自动加 .qs-pick-host，即 position:relative）
 *    items : [{ key, text, count }]，第一项通常是"全部…"（key = null）
 *    value : 当前选中的 key（null = 第一项）
 *    onPick: 选中某个 key 时的回调（key 与当前相同则不回调）
 *  返回：胶囊按钮元素
 * ========================================================================== */
window.qsPickNav = function (host, opts) {
    const o = opts || {};
    const items = o.items || [];
    if (!host || !items.length) return null;
    const cur = items.find(function (it) { return it.key === o.value; }) || items[0];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qs-pick';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    function addText(parent, text, cls) {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        parent.appendChild(s);
    }
    addText(btn, cur.text, 'qs-pick-t');
    if (cur.count !== undefined && cur.count !== null) addText(btn, cur.count, 'qs-pick-n');
    addText(btn, '\u25be', 'qs-pick-a');
    const menu = document.createElement('div');
    menu.className = 'qs-pick-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'qs-pick-item' + (it.key === o.value ? ' on' : '');
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', it.key === o.value ? 'true' : 'false');
        addText(b, it.text, 'qs-pick-t');
        if (it.count !== undefined && it.count !== null) addText(b, it.count, 'qs-pick-n');
        b.addEventListener('pointerdown', stopEv);
        b.addEventListener('mousedown', stopEv);
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            close();
            if (it.key === o.value) return;
            if (o.onPick) o.onPick(it.key);
        });
        menu.appendChild(b);
    }
    function onDoc(ev) { if (!host.contains(ev.target)) close(); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    function close() {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
    }
    function open() {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
    }
    function stopEv(ev) { ev.stopPropagation(); }
    btn.addEventListener('pointerdown', stopEv);
    btn.addEventListener('mousedown', stopEv);
    btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (menu.hidden) open(); else close();
    });
    host.classList.add('qs-pick-host');
    host.appendChild(btn);
    host.appendChild(menu);
    return btn;
};

/* ============================================================================
 *  r54 需求 2：判断一段文字是不是一条**本地路径**
 *
 *  用户原话：「当划词选中的内容是本地文件路径时，横条上自动弹出文件管理器
 *  图标，点击后直接调用系统文件管理器定位并打开对应路径。」
 *
 *  ⚠ 判据与后端 `paths::looks_like_path` **逐字同源**（那边是 Rust，这里是 JS，
 *     两边都要过是因为：前端弹出图标不能为判一条路径去调一次 IPC，而后端不能
 *     拿前端的话全信）。改一边必须改另一边，单测各测各的。
 *
 *  认这四种：
 *    C:\Users\me\a.txt   盘符 + 分隔符（\ 或 / 都行）
 *    \\server\share\a    UNC 网络路径
 *    .\bin\tool.exe      相对路径（.\ ..\ ./ ../ 开头）
 *    %APPDATA%\QuickSearch  含一个完整 %VAR% 段
 *
 *  ⚠ 不认「裸的 bin\tool.exe」：光有分隔符 + 扩展名的话也可能只是句子里带了
 *     反斜杠；误判的代价（横条上多个图标、点下去弹报错）比漏判大。
 *  ⚠ 判 URL **只认** `scheme://` 和 `//` 开头。曾经加过「点 + 顶级域」的启发式，
 *     结果 .txt / .jpg / .exe 这些扩展名（同样 2~6 个字母）把带扩展名的路径
 *     全部误杀 —— 这条坑记在 Rust 侧的回归测试里。
 *  ⚠ `%VAR%` 的变量名判据是「一个或多个字母/数字/下划线」，**不以字母开头也行**
 *     （`%1%` 也是合法变量名）。这条两边曾经不一致，见下面正则处的注释。
 * ========================================================================== */
window.qsLooksLikePath = function (text) {
    const t = stripQuotes(String(text == null ? '' : text).trim());
    if (!t || t.length > 260) return false;
    if (/[\r\n]/.test(t)) return false;
    /* ① 确定是网址的先排掉（否则 `//` 会被 UNC 判据吃掉）
     * ⚠ `file://` **不算网址** —— 它是"一条本地文件"的另一种写法，用户从
     *   浏览器地址栏复制出来的就是它。排掉它等于把一整类真实输入弄瞎。
     *   与后端 paths.rs 的 is_url 同一条口径。 */
    if (t.startsWith('//')) return false;
    if (t.includes('://') && !/^file:\/\//i.test(t)) return false;
    // ①b file:///C:/… —— 从地址栏复制的文件地址，认
    if (/^file:\/\/./i.test(t)) return true;
    // ② UNC：\\server\share…
    if (t.startsWith('\\\\') && t.length > 3) return true;
    // ③ 盘符 + 分隔符：C:\… 、c:/…
    if (t.length >= 4 && /^[A-Za-z]:[\\/]/.test(t)) return true;
    // ④ 相对路径：.\ ..\ ./ ../
    if (/^\.{1,2}[\\/]./.test(t) && t.length > 3) return true;
    // ⑤ 环境变量：%VAR% 段，且段前是串首或分隔符
    // ⚠ 正则必须与后端 paths.rs 的判据**逐字同源**：那边是
    //   `var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')`，
    //   即「一个或多个字母/数字/下划线」，**不要求以字母开头**。
    //   曾经这里写成 `[A-Za-z_][A-Za-z0-9_]*`（要求字母或下划线开头），
    //   于是 `%1%` 这种纯数字变量名两边结论相反 —— JS 说不弹图标、
    //   Rust 说该弹（且 resolve 真会去展开它）。跨端判据分叉比漏判更坏：
    //   用户看到的是「有时有图标有时没有」，根本没法复现。
    //   现在两边一致：`[A-Za-z0-9_]+`。
    const m = /%([A-Za-z0-9_]+)%/.exec(t);
    if (m) {
        const i = m.index;
        if (i === 0 || t[i - 1] === '\\' || t[i - 1] === '/') return true;
    }
    return false;

    function stripQuotes(s) {
        const b = s[0], e = s[s.length - 1];
        if (s.length >= 2 && ((b === '"' && e === '"') || (b === '\'' && e === '\''))) {
            s = s.slice(1, -1).trim();
        }
        /* r57：再剥**尾部标点**。从聊天/文档里选一条路径，很容易把句号、
         * 逗号、冒号一起选进来（`C:\Users\me\报告.docx。`）。这种串本来会被
         * 判成路径 → 横条上冒出 📁 → 点下去 exists() 为假 → 用户看到的就是
         * 「图标出来了、点了没反应」。
         * ⚠ 只剥尾部、不剥中间（`C:\a,b\c.txt` 里的逗号是合法文件名的一部分）。
         * ⚠ 敢无脑剥是因为 Windows 文件名本来就不许以点/空格结尾。
         * ⚠ 与后端 paths.rs 的 strip() **同一条口径**，改一边必须改另一边。 */
        return s.replace(/[\s。，、；：！？」』）》。,;:!?)\]}>"']+$/u, '');
    }
};
/* ==========================================================================
 * 统一主题引导（v1.5.20）
 *
 * 为什么放在 shared.js：ocr / 翻译 / 图标编辑器这几个独立窗口过去只写了
 * `@media (prefers-color-scheme: dark)`，于是「应用里选了强制亮色、系统却是
 * 深色」时，这些窗口仍然是深色 —— 三套皮肤各走各的。现在统一由这里把配置里
 * 的 theme 写到 <html data-theme>，CSS 只认 data-theme（见 theme.css），
 * 所有窗口的明暗永远一致。
 *
 * ⚠ data-theme 保留 system/light/dark 三个原值，不在这里解析成 dark/light：
 *   设置页的现有单测断言了「跟随系统时 data-theme 记成 system」，解析归 CSS。
 * ========================================================================== */
(function () {
    if (window.qsApplyPageTheme) return;           // 只装一次
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var cur = 'system';
    function paint() {
        var el = document.documentElement;
        el.dataset.theme = cur;                     // system / light / dark 原样记
        var dark = cur === 'dark' || (cur !== 'light' && mq.matches);
        el.style.colorScheme = dark ? 'dark' : 'light';
    }
    window.qsApplyPageTheme = function (t) { cur = t || 'system'; paint(); };
    if (mq.addEventListener) mq.addEventListener('change', function () { if (cur === 'system') paint(); });
    function pull() {
        try {
            if (typeof invoke === 'function') {
                invoke('get_config').then(function (c) {
                    window.qsApplyPageTheme(c && c.theme);
                }).catch(function () {});
            }
        } catch (e) { /* 非 Tauri 环境：保持默认 */ }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pull);
    else pull();
    /* ⚠ 这里**不再**自己监听 qs://config：各窗口本来就有自己的监听，
     *   而测试环境的 event.listen 是单监听槽 —— 这里再挂一个会把页面
     *   自己的监听顶掉（表现：翻译 DOM 不随配置重建）。首帧定色已经够用；
     *   页面若需要在配置变更时改主题，调 window.qsApplyPageTheme(c.theme)。 */
})();
