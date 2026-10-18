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