/* ============================================================
   Quick Search 桌面版 —— 设置窗口逻辑
   ============================================================ */

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const MONO_BRAND = new Set(['Twitter', 'GitHub', 'Threads', '维基百科']);

const $ = (id) => document.getElementById(id);

let CATALOG = null;
let CONF = null;
let BY_NAME = new Map();

/* ------------------------------------------------------------------ */

function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    t.classList.add('show');
    /* ⚠ 两个定时器都要能取消。
     *   以前只存了外层那个：1900ms 内连来第二条时，**第一条**的 220ms 内层
     *   回调仍会执行 `t.hidden = true` —— 第二条刚显示就被藏掉，
     *   用户看到的是"提示一闪而过 / 干脆没出现"。 */
    clearTimeout(toast._t);
    clearTimeout(toast._t2);
    toast._t = setTimeout(() => {
        t.classList.remove('show');
        toast._t2 = setTimeout(() => { t.hidden = true; }, 220);
    }, 1900);
}

function hashColor(name) {
    const P = ['#4E6EF2', '#E8500F', '#0FA36B', '#B0182A', '#7A5AF8',
        '#0E7C86', '#C2410C', '#2563EB', '#9333EA', '#0F766E'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return P[Math.abs(h) % P.length];
}

/* 未处理的 Promise 拒绝统一兜底。
 *
 * 页面里有二十来处 invoke(...) 没接 .catch —— 但凡后端命令 Err / panic，
 * Tauri 都会把它转成 Promise reject：没人接就是一个静默失败（用户看到
 * 「点了没反应」，控制台一条 unhandledrejection）。这里统一给出可见反馈，
 * 比逐个补 catch 稳（将来新加的调用也自动被覆盖）。 */
window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const msg = (r && r.message) || String(r || '');
    try {
        console.warn('[qs] unhandled rejection:', r);
        if (msg) toast('操作失败：' + msg);
        invoke('log_msg', { msg: '[settings] unhandledrejection: ' + msg }).catch(() => { });
    } catch (_) { }
});

/** 「统一图标大小」总开关（设置里可关）。默认开。 */
function unifyIcons() {
    return !CONF || CONF.unifyIcons !== false;
}

function iconNode(name, size) {
    /* 翻译按钮（@trans）不是真引擎，但也有默认图标了（v1.5.17）——
     * 走共用实现，别落到下面的字母徽标分支去（那会画出一个 "T"）。 */
    if (name === QS_TRANS) return window.qsTransIconNode();
    const eng = BY_NAME.get(name) || {};
    const custom = CONF.overrideIcons && CONF.overrideIcons[name];
    // #138：icons 目录里「文件名 = 引擎名」的默认图标，优先级夹在
    // 「图库显式挑的」和「引擎自带 iconFile」之间（和横条 buildIconInner 同序）。
    const dir = window.qsDirIconFor ? window.qsDirIconFor(name) : null;
    let node;
    if (custom) {
        node = document.createElement('img');
        node.src = custom;
    } else if (dir) {
        node = document.createElement('img');
        node.src = dir;
    } else if (eng.iconFile) {
        node = document.createElement('img');
        node.src = 'data/icons/' + eng.iconFile;
        if (MONO_BRAND.has(name) && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            node.style.filter = 'invert(1) brightness(1.7)';
        }
    } else {
        node = document.createElement('span');
        node.className = 'letter';
        node.textContent = (name.match(/[A-Za-z0-9\u4e00-\u9fa5]/) || ['?'])[0].toUpperCase();
        node.style.setProperty('--lt-color', hashColor(name));
        node.style.fontSize = (size ? size * 0.5 : 12) + 'px';
    }
    // r75：「全部引擎」一屏铺 700+ 行、每行一张图标，默认会把 407 张图**全部**
    // 解码进渲染进程（实测光是解码后的位图就几十 MB）。懒加载 + 异步解码之后
    // 只有视口附近那几十张真正解码，滚动时再补 —— 列表构建也更快。
    // ⚠ 与「统一图标大小」不冲突：那条走 qsIconScale 自己 new Image() 量，
    //   不看这张 <img> 的加载状态（见 shared.js 的 qsApplyOpticalScale）。
    if (node.tagName === 'IMG') {
        node.loading = 'lazy';
        node.decoding = 'async';
    }
    // 是图片就套上「统一图标大小」的补偿（带透明留白的图标会被放大）
    qsApplyOpticalScale(node, unifyIcons());
    return node;
}

/** 横条上一个**成员**的图标。
 *
 *  和 iconNode 的区别只有一个：OCR 哨兵不是真引擎（没有图标文件），
 *  直接丢给 iconNode 会拿名字里的 "o" 生成一个字母徽标 —— 用户根本认不出
 *  那是 OCR。所以这里单独给它一个「OCR」文字标；用户换过图标就优先用图标。
 *  预览、横条列表、全部引擎列表三处都走这一个函数，样子才不会各处一个样。 */
function barItemIcon(name, size) {
    if (name === QS_OCR) {
        const custom = CONF.overrideIcons && CONF.overrideIcons[QS_OCR];
        if (custom) {
            const img = document.createElement('img');
            img.src = custom;
            qsApplyOpticalScale(img, unifyIcons());
            return img;
        }
        const t = document.createElement('span');
        t.className = 'ocr-tag';
        t.textContent = 'OCR';
        return t;
    }
    /* r72：识图按钮成了横条成员（`@img`）—— 设置里这张脸要和横条上一致：
     * 换过图标显示那张图，没换显示内置的「四角取景框 + 放大镜」。 */
    if (name === QS_IMG) {
        const custom = CONF.overrideIcons && CONF.overrideIcons[QS_IMG];
        if (custom) {
            const img = document.createElement('img');
            img.src = custom;
            qsApplyOpticalScale(img, unifyIcons());
            return img;
        }
        const holder = document.createElement('span');
        holder.innerHTML = window.QS_IMG_SVG || '';
        const svg = holder.querySelector('svg');
        if (svg) {
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.display = 'block';
            svg.style.fill = 'currentColor';
            svg.style.color = 'var(--fg-dim)';
            qsApplyOpticalScale(svg, unifyIcons());
            return svg;
        }
    }
    /* v1.5.16：翻译按钮（@trans）—— 和 OCR 同一套：换过图标显示图，
     * 没换显示默认图标。
     * v1.5.17：默认图标从「译」文字徽标换成用户指定的「翻译.png」
     * （内置在 data/icons/trans.png）。实现挪到 shared.js 的
     * qsTransIconNode —— 和横条上那颗走同一个函数，三处长得一模一样。 */
    if (name === QS_TRANS) {
        return window.qsTransIconNode();
    }
    return iconNode(name, size);
}

/* ------------------------------------------------------------------ */
/* 图标编辑器（#143）                                                   */
/* ------------------------------------------------------------------ */

/** 这个成员当前图标对应的 data URL（编辑器窗口的「原图」）。
 *
 *  三级口径和 Rust 的 `open_icon_editor` 对齐：
 *    1. overrideIcons（图库挑的 / 上次编辑器存的）；
 *    2. icons 目录里「文件名 = 引擎名」的默认图（#138，外部软件传软件名）；
 *    3. extraSrc（收藏夹目录自带的 legacy `g.icon`）。
 *  四级都没有 → 空串。只认 `data:` 开头 —— Rust 侧读字节只吃 data URL，
 *  相对路径（老配置里可能遗留的 g.icon）递过去也解不出字节，宁可当没有。 */
function iconEditSrc(key, engineName, extraSrc) {
    let src = (CONF.overrideIcons && CONF.overrideIcons[key]) || '';
    if (!src && engineName && window.qsDirIconFor) src = window.qsDirIconFor(engineName) || '';
    if (!src && extraSrc) src = extraSrc;
    return src.indexOf('data:') === 0 ? src : '';
}

/** 图标编辑器功能是否启用（r80）。
 *
 *  用户口径：「抠图的功能默认不打开。只有在设置通用里面打开之后，换图标才会有个
 *  编辑的这个页面。没打开抠图功能的时候，点击换图标就直接选择文件替换」，
 *  并且确认了「彻底禁用编辑器」—— 开关关着时：
 *    · 「换图标」挑完直接替换（后端 `pick_icon` 按 `ai_matting_enable` 分支）
 *    · 「编辑图标」按钮**不出现**
 *
 *  为什么 UI 里也判一次（后端已经判了）：按钮点下去才发现不能用的体验很差，
 *  不如一开始就不给；后端那道判断是兜底（防前端旧版本/被改过）。
 *
 *  注意字段名是 `aiMattingEnable` —— 它的语义已从"AI 抠图"扩成"图标编辑器总开关"，
 *  但字段名不动（改了老配置读不回来）。 */
function iconEditorEnabled() {
    return !!(CONF && CONF.aiMattingEnable);
}

/** 这个成员有没有一张「图片」图标可编辑。
 *
 *  字母徽标（从没挑过图的引擎 / 目录）没有像素可编辑，不亮按钮；
 *  真引擎还能吃内置 iconFile（fetch 成 data URL 递进编辑器），
 *  而 `@ocr` / `@app:` / `@fav:` 哨兵没有内置图，前两级空就是空。
 *
 *  ⚠ r80：**编辑器功能没开时一律返回 false**。
 *  所有「编辑图标」按钮都以这个函数为判据（6 处：OCR 行、识图/收藏哨兵行、
 *  引擎行、外部软件行、收藏夹目录、软件行），所以在这里加一道判断就全都生效 ——
 *  比在 6 个地方各写一遍可靠（漏一处就会出现"开关关着却还有编辑按钮"）。
 *  （识图那行原本有个"始终显示"的特例，见调用处的注释，现在被这道总开关覆盖。） */
function hasIconToEdit(key, engineName, extraSrc) {
    if (!iconEditorEnabled()) return false;
    if (iconEditSrc(key, engineName, extraSrc)) return true;
    /* v1.5.17：翻译按钮（@trans）现在有**内置默认图**了（data/icons/trans.png），
     * 所以它和真引擎一样有像素可编辑 —— 用户能在这张默认图上抠背景。
     * 以前它只是一枚「译」字徽标，才落到下面这条「@ 开头一律不可编辑」里。 */
    if (key === QS_TRANS) return true;
    if (key.indexOf('@') === 0) return false;
    const eng = BY_NAME.get(engineName || key);
    return !!(eng && eng.iconFile);
}

/** 把页面内的图片（内置 `data/icons/xxx.png`）读成 data URL。 */
async function iconSrcDataUrl(rel) {
    const r = await fetch(rel);
    if (!r.ok) throw new Error('读不到 ' + rel);
    const b = await r.blob();
    return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error('图片读取失败'));
        fr.readAsDataURL(b);
    });
}

/** 打开图标编辑器窗口（ui/iconedit.html）。
 *
 *  key = overrideIcons 的键：引擎名 / `@ocr` / `@app:<id>` / `@fav:<id>`；
 *  engineName = 找「默认图标」用的名字（外部软件传软件名，哨兵传自己即可）；
 *  extraSrc = 收藏夹目录的 legacy `g.icon`（其余场景不传）。 */
async function openIconEditor(key, engineName, extraSrc) {
    let src = iconEditSrc(key, engineName, extraSrc);
    if (!src) {
        const eng = BY_NAME.get(engineName || key);
        if (eng && eng.iconFile) {
            try {
                src = await iconSrcDataUrl('data/icons/' + eng.iconFile);
            } catch (e) {
                toast('内置图标读不出来：' + ((e && e.message) || e));
                return;
            }
        }
    }
    /* v1.5.17：翻译按钮（@trans）的内置默认图也能进编辑器 ——
     * 它不是真引擎（BY_NAME 里没有），走不到上面那条 iconFile 分支，
     * 这里单独兜一次。取的是同一张 data/icons/trans.png。 */
    if (!src && key === QS_TRANS && window.QS_TRANS_ICON) {
        try {
            src = await iconSrcDataUrl(window.QS_TRANS_ICON);
        } catch (e) {
            toast('内置图标读不出来：' + ((e && e.message) || e));
            return;
        }
    }
    if (!src) {
        toast('这颗图标还没有图片，先点「换图标」挑一张');
        return;
    }
    invoke('open_icon_editor', { key, srcHint: src }).catch(() => { });
}

/* ------------------------------------------------------------------ */
/* 标签页                                                              */
/* ------------------------------------------------------------------ */

function bindTabs() {
    const tabs = $('tabs');
    for (const b of tabs.querySelectorAll('button')) {
        b.addEventListener('click', () => {
            for (const x of tabs.querySelectorAll('button')) x.classList.toggle('on', x === b);
            for (const p of document.querySelectorAll('.pane')) {
                p.hidden = p.dataset.pane !== b.dataset.tab;
            }
            // r46：切到 OCR 页**不再自动跑检测**（用户原话："我没点击，他就不用
            // 告诉我说是否已准备就绪"）。已经检测过就沿用缓存结果，没测过就显示
            // 那个「检测本地 OCR 环境」按钮等他点。
            if (b.dataset.tab === 'ocr') renderOcrDep();
            /* v1.2.0：切到「关于」时初始化更新那块（接按钮 + 问一句有没有待装的）。
             * 放这里而不是 boot 里一次性做完，是因为 `update_pending` 问的是
             * "**此刻**有没有待装的新版"——启动时那次检查可能还没回来，
             * 等用户真的打开这一页再问，拿到的才准。幂等，重复切页无副作用。 */
            if (b.dataset.tab === 'about') updInit();
            /* r74：首字母索引浮动钮只许在引擎页亮着。切走先收起来（它是
             * position:fixed，不收就漂在别的页上面）；切回引擎页时如果仍是
             * 「全部引擎」档，按 DOM 现况恢复 —— 不重画列表（会弹回顶部）。 */
            idxFabHide();
            if (b.dataset.tab === 'engines' && allGroupFilter === '*') idxReshow();
            /* 切回引擎页时作废渲染指纹：指纹相同就意味着"不用重画"，但用户
             * 可能刚在别处换过图（比如在「横条上的引擎」里换了图标，那里的
             * 行没走 renderAllList 的指纹），切回来必须看到新图标。 */
            if (b.dataset.tab === 'engines') invalidateAllList();
            // 调试构建：换页后让「引擎」页的行控件也上报一次坐标
            if (document.body.dataset.qsDebug === '1') {
                invoke('log_msg', { msg: 'TAB ' + b.dataset.tab }).catch(() => { });
                if (window.__qsReportRects) setTimeout(window.__qsReportRects, 80);
            }
        });
    }
}

/* ------------------------------------------------------------------ */
/* 横条引擎列表                                                        */
/* ------------------------------------------------------------------ */

/* 拖拽排序：不用 HTML5 原生拖放，改用 pointer 事件。
 *
 * 为什么换：WebView2 里原生拖放的 dragstart 触发依赖焦点/合成器状态，
 * 真机上出现过「抓手提示在、按住却拖不动」的假死情况；而
 * pointerdown/move/up 是页面最基础的事件路径，一定可靠。
 * 代价是落点插位要自己算（见 slotAt）。 */
let dragState = null; // { from, x, y, row, active }

/** 横条列表里**真正参与排序**的那些行。
 *
 *  「＋ 把 OCR 加进横条」那种操作入口行用 `.add-row` 标出来，这里必须排除 ——
 *  它不是横条成员，如果混进来，它的下标会被当成 bar_list 的下标传给
 *  move_bar_item，顺序就挪错位了。 */
function barItemRows() {
    const box = $('barList');
    return box ? [...box.querySelectorAll('.item:not(.add-row)')] : [];
}

/** 指针 Y 对应列表的哪个插入槽。用每一行的「中点」当分界，
 *  行与行之间 3px 的缝隙就不会成为「拖到哪里都没反应」的死角。 */
function slotAt(y) {
    const rows = barItemRows();
    let slot = rows.length;
    for (let i = 0; i < rows.length; i++) {
        const b = rows[i].getBoundingClientRect();
        if (y < b.top + b.height / 2) { slot = i; break; }
    }
    return { rows, slot };
}

function paintSlot(y) {
    const { rows, slot } = slotAt(y);
    clearDropMarks();
    if (slot < rows.length) rows[slot].classList.add('drop-before');
    else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
}

document.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    if (!dragState.active) {
        // 5px 以内只当手抖，不进拖拽
        if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < 5) return;
        dragState.active = true;
        dragState.row.classList.add('dragging');
        try { dragState.row.setPointerCapture(e.pointerId); } catch (_) { }
    }
    paintSlot(e.clientY);
});

/** 结束拖拽。commitY 为 null（pointercancel）表示放弃。 */
function endDrag(commitY) {
    const st = dragState;
    dragState = null;
    if (!st || !st.active) return;
    st.row.classList.remove('dragging');
    clearDropMarks();
    if (commitY === null || commitY === undefined) return;
    const { rows, slot } = slotAt(commitY);
    if (!rows.length) return;
    // 插入槽换算成「挪完之后待在第几位」：被拖走的那一项
    // 会让它后面的下标整体前移一格，所以要补回来。
    const to = slot > st.from ? slot - 1 : slot;
    if (to !== st.from) invoke('move_bar_item', { from: st.from, to });
}

document.addEventListener('pointerup', (e) => endDrag(e.clientY));
document.addEventListener('pointercancel', () => endDrag(null));

function renderBarList() {
    const box = $('barList');
    box.textContent = '';
    /* 防御性过滤：指向**已删除目录**的 `@fav:<id>` 哨兵不该出现在列表里。
     *
     * 后端在收藏树变化时已经剪过 bar_list（`config::prune_dangling_fav_sentinels`），
     * 这里再兜一层 —— 配置广播到达之前的那一帧、或用户手工改过 config.json 时，
     * 列表里仍然可能是脏的。脏的那一行会把 `@fav:xxxx` 原文当引擎名显示出来
     * （用户报的"乱码"），图标也会退化成异常造型。
     *
     * ⚠ **必须保留原始下标**：↑↓ 和拖拽排序都是按下标算的（move_bar_item），
     *   过滤后重新编号会让"上移"作用到别的行上。
     */
    const list = (CONF.barList || [])
        .map((name, idx) => ({ name, idx }))
        .filter((x) => !(typeof x.name === 'string' && x.name.startsWith(QS_FAV_PREFIX)
            && !qsFavFindGroup(x.name.slice(QS_FAV_PREFIX.length))))
        // 同理：外部软件被删掉后，@app:<id> 哨兵也不能出现在列表里
        // （后端删软件时已经剪过，这里是广播到达前那一帧的兜底）。
        .filter((x) => !(typeof x.name === 'string' && x.name.startsWith(QS_APP_PREFIX)
            && !qsAppBySentinel(x.name)));

    if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '横条现在是空的，去「全部引擎」里打开几个吧。';
        box.appendChild(d);
    }

    list.forEach(({ name, idx }) => {
        const isSep = name === QS_SEP;
        const isOcr = name === QS_OCR;
        /* r72：识图按钮现在是横条成员（`@img`）—— 和普通引擎一样有抓手、
         * ↑↓、拖拽、换图标 / 编辑 / 恢复默认 / 移出。
         * v1.5.16：翻译按钮（@trans）同一套地位。 */
        const isImg = name === QS_IMG;
        const isTrans = name === QS_TRANS;
        // 外部软件哨兵（@app:<id>）：要翻译成软件名，不然设置里显示一串乱码。
        const app = qsAppBySentinel(name);
        const isApp = !!app;
        // 收藏夹哨兵（@fav:<id>）：必须翻译成目录名，不然设置里显示一串
        // "乱码"，用户根本看不出这是哪个收藏夹（用户原话）。
        // 收藏夹哨兵（@fav:<id>）：必须翻译成目录名，不然设置里显示一串
        // "乱码"，用户根本看不出这是哪个收藏夹（用户原话）。
        // 用 shared.js 的 qsFavFindGroup 直接从 window.CONF.favorites 取 ——
        // 它是**权威数据源**，渲染横条列表时一定已经就绪；
        // 之前用本地 favFindGroup 翻 favTree（收藏夹编辑面板的草稿副本），
        // 那一副本在「文字识别」页早渲染时还没初始化，于是认不出目录、
        // 把哨兵当普通名字画出来就成了乱码 + 异常图标。
        const favGroup = (typeof name === 'string' && name.startsWith(QS_FAV_PREFIX))
            ? qsFavFindGroup(name.slice(QS_FAV_PREFIX.length))
            : null;
        const isFav = !!favGroup;
        const row = document.createElement('div');
        row.className = 'item' + (isSep ? ' sep-row' : '') + (isOcr ? ' ocr-row' : '')
            + (isImg ? ' img-row-item' : '')
            + (isTrans ? ' trans-row-item' : '')
            + (isFav ? ' fav-row-item' : '') + (isApp ? ' app-row-item' : '');
        row.dataset.idx = String(idx);

        // 抓手：光靠整行可拖不容易被发现，给个明确的视觉提示
        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.textContent = '⋮⋮';
        grip.title = '按住拖动换位置';

        const ic = document.createElement('span');
        ic.className = 'ic';
        if (isSep) {
            const bar = document.createElement('i');
            bar.className = 'sepic';
            ic.appendChild(bar);
        } else if (isFav) {
            // 收藏夹目录：和横条上**同一套图标实现**（shared.js 的 qsFavIconNode），
            // 换过图标显示图、没换显示首字徽标 —— 不然预览/设置/横条三处对不上。
            ic.appendChild(qsFavIconNode(name));
        } else if (isApp) {
            // 外部软件：同理走共用实现（shared.js 的 qsAppIconNode）
            ic.appendChild(qsAppIconNode(name));
        } else {
            // OCR 也走 barItemIcon：它换过图标就显示图标，没换就显示 OCR 徽标。
            ic.appendChild(barItemIcon(name, 24));
        }

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = isSep ? '分隔线'
            : (isOcr ? '识别图片文字'
                : (isImg ? '识图搜索'
                    : (isTrans ? '翻译'
                        : (isFav ? favGroup.name : (isApp ? app.name : name)))));
        if (isFav) {
            const em = document.createElement('em');
            em.textContent = '收藏夹目录 · 拖它可以改位置';
            nm.appendChild(em);
        } else if (isSep) {
            const em = document.createElement('em');
            em.textContent = '把左右两边的图标分成两组';
            nm.appendChild(em);
        } else if (isOcr) {
            const em = document.createElement('em');
            em.textContent = CONF.overrideIcons[QS_OCR]
                ? '自定义图标 · 拖它可以改位置'
                : '拖它可以改 OCR 在横条上的位置';
            nm.appendChild(em);
        } else if (isImg) {
            const em = document.createElement('em');
            em.textContent = CONF.overrideIcons[QS_IMG]
                ? '自定义图标 · 点一下框选搜索 · 拖它可以改位置'
                : '点一下框选屏幕搜索 · 拖它可以改位置';
            nm.appendChild(em);
        } else if (isTrans) {
            const em = document.createElement('em');
            em.textContent = CONF.overrideIcons[QS_TRANS]
                ? '自定义图标 · 点一下翻译横条上的文字 · 拖它可以改位置'
                : '点一下翻译横条上的文字 · 拖它可以改位置';
            nm.appendChild(em);
        } else if (isApp) {
            const em = document.createElement('em');
            em.textContent = '外部软件 · 点一下直接打开 · 拖它可以改位置';
            nm.appendChild(em);
        } else if (CONF.overrideIcons[name]) {
            const em = document.createElement('em');
            em.textContent = '自定义图标';
            nm.appendChild(em);
        }

        const ops = document.createElement('span');
        ops.className = 'ops';

        const mk = (text, title, cls, fn) => {
            const b = document.createElement('button');
            b.className = 'mini ' + (cls || '');
            b.textContent = text;
            if (title) b.title = title;
            b.addEventListener('click', fn);
            ops.appendChild(b);
            return b;
        };

        // 上下移动一律走**下标**（move_bar_item），不走名字。
        // 分隔线可以有好几条、名字全都一样，按名字找位置必然张冠李戴。
        // 另外 usize 收不下负数，边界必须在 JS 这边挡住。
        const up = mk('↑', '上移', 'icon-only',
            () => invoke('move_bar_item', { from: idx, to: idx - 1 }));
        if (idx === 0) { up.disabled = true; up.title = '已经在最前面了'; }
        const dn = mk('↓', '下移', 'icon-only',
            () => invoke('move_bar_item', { from: idx, to: idx + 1 }));
        /* ⚠ 比的是**原始下标**，不能拿 `list.length - 1`：list 是过滤后的数组
         *   （脏项 —— 指向已删目录/软件的哨兵 —— 会被滤掉），两个下标空间
         *   一比就错位，最后一行的「↓」该禁用却没禁用（点了后端直接 return，
         *   用户看到的是"按了没反应"）。 */
        if (idx === (list[list.length - 1] || {}).idx) {
            dn.disabled = true; dn.title = '已经在最后面了';
        }

        if (isSep) {
            mk('删除', '删掉这条分隔线', '',
                () => invoke('remove_separator', { index: idx }));
        } else if (isOcr) {
            // OCR 行：位置用 ↑↓ 或直接拖；图标也能自己换（用户点名要的）。
            // 「去掉」只是把它从横条上拿掉，不影响热键 Ctrl+Alt+O。
            mk('换图标', '给 OCR 按钮挑一张图片', '',
                () => invoke('pick_icon', { engine: QS_OCR }));
            // #143：挑过图才能编辑（一键消除背景），没挑过就是 OCR 徽标
            if (hasIconToEdit(QS_OCR, QS_OCR)) {
                mk('编辑图标', '编辑这颗图标：一键消除背景、前后对比', '',
                    () => openIconEditor(QS_OCR, QS_OCR));
            }
            if (CONF.overrideIcons[QS_OCR]) {
                mk('默认', '恢复默认的 OCR 徽标', '',
                    () => invoke('reset_icon', { engine: QS_OCR }));
            }
            mk('去掉', '把 OCR 从横条上拿掉（不影响热键 Ctrl+Alt+O）', '',
                () => invoke('remove_bar_ocr'));
        } else {
            mk('换图标', '从电脑里挑一张图片', '', () => invoke('pick_icon', { engine: name }));
            /* #143「编辑图标」：收藏夹目录 / 外部软件的哨兵行也走这条
             * （它们的键就是哨兵本身，和 pick_icon 同一套机制）。
             * 外部软件按**软件名**找 icons 目录默认图（和 qsAppIconNode 同口径）；
             * 收藏夹目录额外认 legacy 的 g.icon。
             *
             * r72：识图（@img）这一行**始终**摆出「编辑图标」—— 用户明确要求
             * 「应该也要有一个编辑图标」。还没换过图标时它没有像素可编辑，
             * 点了会提示先挑一张（比"按钮凭空消失"清楚）。
             *
             * r80：这个"始终"要**叠加总开关** —— 编辑器功能没开时，
             * 任何行都不该出现编辑按钮（用户口径："彻底禁用编辑器"）。 */
            const ieName = isApp ? app.name : (isFav ? null : name);
            const ieExtra = isFav ? ((favGroup && favGroup.icon) || '') : '';
            if (iconEditorEnabled() && (hasIconToEdit(name, ieName, ieExtra) || isImg)) {
                mk('编辑图标', '编辑这颗图标：一键消除背景、前后对比', '', () => {
                    if (hasIconToEdit(name, ieName, ieExtra)) {
                        openIconEditor(name, ieName, ieExtra);
                    } else {
                        toast('这颗图标还没有图片，先点「换图标」挑一张');
                    }
                });
            }
            if (CONF.overrideIcons[name]) {
                // 外部软件没有「内置图标」可言，恢复的是首字徽标
                mk('默认', isApp ? '恢复成首字徽标' : '恢复内置图标', '',
                    () => invoke('reset_icon', { engine: name }));
            }
            mk('移出', '从横条上移除', '',
                () => invoke('toggle_bar_engine', { engine: name, on: false }));
        }

        row.appendChild(grip);
        row.appendChild(ic);
        row.appendChild(nm);
        row.appendChild(ops);

        /* ------------------------- 拖拽排序 -------------------------
         * 只有 pointerdown 挂在行上；move/up/cancel 是模块级的全局监听，
         * 配合 setPointerCapture，拖出整行也照样跟手。
         * 按在按钮 / 输入框上不算拖行，归它们自己响应。 */
        row.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || dragState) return;
            if (e.target.closest('button, input, select, textarea, a, [contenteditable]')) return;
            dragState = { from: idx, x: e.clientX, y: e.clientY, row, active: false };
        });

        box.appendChild(row);
    });

    /* r72：识图按钮现在已经**就是横条成员**（`@img` 哨兵），上面那个 forEach
     * 会像普通引擎一样把它画出来（抓手 / ↑↓ / 拖拽 / 换图标 / 编辑 / 默认 / 移出）。
     *
     * 用户原话：「识图搜索加入了横条之后，在引擎横条上的引擎这个框架里面，它只有
     * 一个换图标的按钮，应该也要有一个编辑图标，恢复默认图标，移出的按钮，也能
     * 通过按钮来进行引擎位置的移动，以及通过按住来移动位置。」
     * —— 以前它是横条上一个**固定位置**的独立按钮（#btnImg），不在 bar_list 里，
     *    所以只能"换图标"，别的都做不了。现在它进了表，五件事全都有了。
     *
     * 这里只处理**还没进横条**的情况：识图开着、但用户点了「移出」之后 ——
     * 给一个「＋ 加回横条」的入口行，不然在这一页再也找不到它（和 OCR 那颗
     * 入口行同一个道理）。这一行是操作入口不是成员，用 .add-row 标出来，
     * 排序 / 报坐标时都会被排除（见 barItemRows）。 */
    if (CONF && CONF.imgEnable && !list.some((x) => x.name === QS_IMG)) {
        const row = document.createElement('div');
        row.className = 'item add-row img-add-row';

        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.style.visibility = 'hidden';

        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.appendChild(barItemIcon(QS_IMG, 24));

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = '识图搜索';
        const em = document.createElement('em');
        em.textContent = '还没加进横条 · 加进来之后就能拖到任意位置、换图标、上下移';
        nm.appendChild(em);

        const ops = document.createElement('span');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = '＋ 加进横条';
        b.title = '把识图按钮放回横条，之后可以拖到任意位置';
        b.addEventListener('click', () => invoke('toggle_bar_engine', { engine: QS_IMG, on: true }));
        ops.appendChild(b);

        row.appendChild(grip);
        row.appendChild(ic);
        row.appendChild(nm);
        row.appendChild(ops);
        box.appendChild(row);
    }

    /* 横条里还没有 OCR 时，在最下面补一个「＋ 把 OCR 加进横条」的入口行。
     *
     * 用户的原话是「OCR 能在横条出现，但在引擎那一列里看不到 OCR，
     * 没法选它放哪儿」。根因就是：OCR 没进 bar_list 时，这一页**根本不画**
     * OCR 那一行，用户自然找不到入口，只能跑去「文字识别」页点按钮。
     * 现在两处都能加，而且加完立刻变成正常的一行，可以拖到任意位置。
     *
     * 这一行是**操作入口不是横条成员**，所以用 .add-row 标出来，
     * 排序/报坐标时都会被排除（见 barItemRows）。
     *
     * ⚠ 判定必须用 `some((x) => x.name === QS_OCR)`，**不能** `list.includes(QS_OCR)`：
     *    上面的 list 是 `.map((name, idx) => ({ name, idx }))` 之后的**对象数组**
     *    （下标要保留给 ↑↓/拖拽用），includes 一个字符串永远为 false ——
     *    于是 OCR 已经在横条里时，入口行照画不误，用户看到"两行 OCR"，
     *    点那颗「＋ 加进横条」还真的会再加一次哨兵（用户报的重复显示）。 */
    if (!list.some((x) => x.name === QS_OCR)) {
        const add = document.createElement('div');
        add.className = 'item add-row ocr-row';

        // 占位抓手：这一行不可拖，但留一个同样宽度的空位，
        // 图标才能和上面那些真成员行对齐。
        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.style.visibility = 'hidden';

        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.appendChild(barItemIcon(QS_OCR, 24));

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = '识别图片文字（OCR）';
        const em = document.createElement('em');
        em.textContent = '还没加进横条 · 加进来之后就能拖到任意位置、也能换图标';
        nm.appendChild(em);

        const ops = document.createElement('span');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = '＋ 加进横条';
        b.title = '把 OCR 按钮放到横条上，之后可以拖到任意位置';
        b.addEventListener('click', () => invoke('toggle_bar_engine', { engine: QS_OCR, on: true }));
        ops.appendChild(b);

        add.appendChild(grip);
        add.appendChild(ic);
        add.appendChild(nm);
        add.appendChild(ops);
        box.appendChild(add);
    }

    /* v1.5.16：翻译按钮（@trans）的入口行 —— 和上面 OCR / 识图两条同一个道理：
     * 横条里没有它时，在这一页给一个「＋ 加进横条」的入口，不然用户只能跑去
     * 「翻译」页点按钮（那一页也有一颗，两处都能加）。 */
    if (CONF && CONF.transEnable !== false && !list.some((x) => x.name === QS_TRANS)) {
        const row = document.createElement('div');
        row.className = 'item add-row trans-add-row';

        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.style.visibility = 'hidden';

        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.appendChild(barItemIcon(QS_TRANS, 24));

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = '翻译';
        const em = document.createElement('em');
        em.textContent = '还没加进横条 · 加进来之后就能拖到任意位置、也能换图标';
        nm.appendChild(em);

        const ops = document.createElement('span');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = '＋ 加进横条';
        b.title = '把翻译按钮放到横条上，之后可以拖到任意位置';
        b.addEventListener('click', () => invoke('toggle_bar_engine', { engine: QS_TRANS, on: true }));
        ops.appendChild(b);

        row.appendChild(grip);
        row.appendChild(ic);
        row.appendChild(nm);
        row.appendChild(ops);
        box.appendChild(row);
    }
}

function clearDropMarks() {
    for (const r of barItemRows()) {
        r.classList.remove('drop-before', 'drop-after');
    }
}

/* ------------------------------------------------------------------ */
/* 全部引擎（#136：三大类分组 + 点大类经子分类展开 + 胶囊过滤）           */
/* ------------------------------------------------------------------ */

/** 三大类的固定顺序与标题（横条面板 bar.js 同一套口径）。
 *  顺序即展示顺序：网页 → 软件 → 快捷键。 */
const ALL_GROUPS = [
    { key: 'web', title: '网页引擎' },
    { key: 'app', title: '软件引擎' },
    { key: 'hotkey', title: '快捷键引擎' },
];
/** 每个大类底下按 #136 要经过的子分类（搜索 / 直达）。 */
const ALL_SUBS = {
    web: ['search', 'open'],
    app: ['appsearch', 'appopen'],
    hotkey: ['hotkey'],
};
/** 子类标题兜底：engines.json 里没这个 sub 时用（用户把某类引擎删光了会出现）。 */
const ALL_SUB_FALLBACK = {
    search: '搜索引擎', open: '直达网页',
    appsearch: '软件搜索', appopen: '软件直达', hotkey: '快捷键',
};

/** 当前选中的大类：`''` = **还没选**（默认，页面上只有四个大类按钮）；
 *  `'*'` = 全部引擎（按首字母排）；`'web'` / `'app'` / `'hotkey'` = 看这一大类。
 *
 *  用户原话（r73）：「默认只显示这 4 个大类，当我点击某一个大类之后才会展开这个
 *  大类下相应的中类，点击某一个中类之后才会展示该中类下的某一小类。而点击全部
 *  引擎的时候，所有的引擎就以 abcdefg 这样的首字母的形式来排列。」 */
let allGroupFilter = '';
/** 中类（null = 全部中类）——选了大类才出现这一层。 */
let allMidFilter = null;
/** 小类标题（null = 全部小类）——选了中类才出现这一层。 */
let allCatFilter = null;
/** 「全部引擎」列表上一次渲染用的输入指纹（见 renderAllList 的广播防抖）。
 *  `''` = 还没有渲染过 / 被显式作废（切分页、改筛选时清空）。 */
let allListSig = '';

/** 作废「全部引擎」的渲染指纹 —— 下一次 renderAllList 一定会重画。
 *
 *  什么时候必须调：任何**不体现在指纹里**却改变渲染结果的操作。目前是
 *  「切回引擎分页」和「索引浮动钮重建」。改筛选条件不用调（它们本身在指纹里）。 */
function invalidateAllList() {
    allListSig = '';
}

/** 「外部软件」页（sec-apps）那个大类块的收起状态 —— #136 要求相同交互。
 *  （引擎库自己的大类收起状态 r70 起没有了：大类标题栏整个删掉，见
 *   renderAllList 里那段注释 —— 筛选用胶囊，不再需要第二套开关。） */
let appGroupOpen = true;

function inBar(name) {
    return (CONF.barList || []).includes(name);
}

/** 子类标题：优先用 engines.json 树里的，缺失用兜底表。 */
function allSubTitle(tree, subKey) {
    for (const g of tree) for (const s of g.subs) if (s.key === subKey) return s.title;
    return ALL_SUB_FALLBACK[subKey] || subKey;
}

/** 可折叠的大类块外壳（#136 的「三大类分组」在全部引擎页 / 外部软件页共用）。
 *  标题行整行可点（鼠标 + 键盘），右侧一个箭头表展开状态；
 *  返回 { blk, body } —— body 已挂上，收起时为 null（调用方别往 null 里塞）。
 *  onToggle 自己翻状态再调渲染函数：状态归调用方，外壳只管样子。 */
function engGroupShell(gkey, title, countText, open, onToggle) {
    const blk = document.createElement('div');
    blk.className = 'eng-grp' + (open ? '' : ' shut');
    blk.dataset.grp = gkey;

    const h = document.createElement('div');
    h.className = 'eng-grp-h';
    h.setAttribute('role', 'button');
    h.tabIndex = 0;
    const ht = document.createElement('span');
    ht.className = 'eng-grp-t';
    ht.textContent = title;
    const hn = document.createElement('span');
    hn.className = 'eng-grp-n';
    hn.textContent = countText;
    const hc = document.createElement('i');
    hc.className = 'eng-grp-c';
    h.appendChild(ht);
    h.appendChild(hn);
    h.appendChild(hc);
    h.addEventListener('click', onToggle);
    h.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(); }
    });
    blk.appendChild(h);

    let body = null;
    if (open) {
        body = document.createElement('div');
        body.className = 'eng-grp-body';
        blk.appendChild(body);
    }
    return { blk, body };
}

/** 一条平铺数据是否命中搜索词（网页/快捷键引擎与外部软件同一口径）。
 *  除了名字，别名、类型关键词、快捷键序列、软件地址都能搜。 */
function allRowHit(r, kw) {
    if (!kw) return true;
    const ap = r.isApp ? r.eng : null;
    const hay = [
        r.name,
        ap ? '' : (r.eng.alias || []).join(' '),
        r.kind === 'open' ? '打开 open 直达' : r.kind === 'hotkey' ? '快捷键 热键 hotkey' : '搜索 search',
        r.kind === 'hotkey' ? (r.eng.hotkey || '') : '',
        ap ? (ap.url || '') : '',
    ].join(' ').toLowerCase();
    return hay.includes(kw);
}

/** 全部引擎页里的一行（网页/快捷键引擎 or 外部软件，#135 之后软件也进这里）。
 *
 *  两个来源的差别只有三处：图标怎么来、overrideIcons 的键是引擎名还是
 *  `@app:<id>` 哨兵、徽标文案。换图标 / 恢复默认 / 加到横条完全同一套。 */
function allRowNode(r) {
    const key = r.isApp ? QS_APP_PREFIX + r.eng.id : r.name;
    const on = inBar(key);
    const row = document.createElement('div');
    row.className = 'item' + (on ? '' : ' off');

    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.appendChild(r.isApp ? appRowIcon(r.eng) : iconNode(r.name, 24));

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.name;
    if (CONF.overrideIcons[key]) {
        const em = document.createElement('em');
        em.textContent = '自定义图标';
        nm.appendChild(em);
    }
    // 类型徽标：搜 / 开 / 键一眼可见（打开类不搜索、快捷键类会真的去按键）。
    // 网页搜索类是绝对主力，不给徽标；软件两种类型都给（#135）。
    if (r.kind !== 'search' || r.isApp) {
        const kb = document.createElement('i');
        kb.className = 'kb' + (r.kind === 'open' ? ' open' : r.kind === 'hotkey' ? ' hot' : '');
        kb.textContent = r.kind === 'open' ? '打开' : r.kind === 'hotkey' ? '快捷键' : '搜索';
        kb.title = r.kind === 'open'
            ? '打开类：点了直接打开这个页面，不搜索'
            : r.kind === 'hotkey'
                ? '快捷键类：点了把组合键 ' + (r.eng.hotkey || '') + ' 发给前台软件'
                : '软件搜索：拿选中的词交给这个软件搜（地址里带 %s）';
        nm.appendChild(kb);
    }
    // 软件的地址露出来（和 sec-apps 一个理由）；快捷键类的组合键露出来
    if (r.isApp && r.eng.url) {
        const u = document.createElement('small');
        u.className = 'curl';
        u.textContent = r.eng.url;
        nm.appendChild(u);
    }
    if (r.kind === 'hotkey' && r.eng.hotkey) {
        const hk = document.createElement('small');
        hk.className = 'chot';
        hk.textContent = r.eng.hotkey;
        nm.appendChild(hk);
    }

    const ops = document.createElement('span');
    ops.className = 'ops';

    const bIcon = document.createElement('button');
    bIcon.className = 'mini';
    bIcon.textContent = '换图标';
    bIcon.title = '从电脑里挑一张图片';
    bIcon.addEventListener('click', () => invoke('pick_icon', { engine: key }));
    ops.appendChild(bIcon);

    // #143「编辑图标」：软件行按**软件名**找默认图（r.name 就是软件名），
    // 网页/快捷键行键和名相同。没有图片图标（字母徽标）时不亮按钮。
    if (hasIconToEdit(key, r.name)) {
        const bE = document.createElement('button');
        bE.className = 'mini';
        bE.textContent = '编辑图标';
        bE.title = '编辑这颗图标：一键消除背景、前后对比';
        bE.addEventListener('click', () => openIconEditor(key, r.name));
        ops.appendChild(bE);
    }

    if (CONF.overrideIcons[key]) {
        const bR = document.createElement('button');
        bR.className = 'mini';
        bR.textContent = '默认';
        bR.title = '恢复内置图标';
        bR.addEventListener('click', () => invoke('reset_icon', { engine: key }));
        ops.appendChild(bR);
    }

    const bT = document.createElement('button');
    bT.className = 'mini' + (on ? ' on' : '');
    bT.textContent = on ? '已在横条' : '加到横条';
    bT.addEventListener('click', () =>
        invoke('toggle_bar_engine', { engine: key, on: !on }));
    ops.appendChild(bT);

    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(ops);
    return row;
}

/* ---------------- r73：引擎库「先下钻，再看列表」+ 全部引擎 A-Z ---------------- */

/** 拼音首字母：中文用 zh 排序器的边界字推算，拉丁字母直接用，数字/符号归 `#`。
 *
 *  为什么不做一张「汉字 → 首字母」的大表：库里 777 个引擎用了 **170 个不同的
 *  中文首字**，全表要几千行。这里借 ICU 的拼音排序（Chromium / WebView2 自带）：
 *  给每个首字母一个「边界字」，逐个比一次就知道落在哪一段。实测这 170 个字
 *  全部命中正确首字母，没有一个掉进 `#`。 */
const PY_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
/** 展示顺序：**完整 26 个字母** + `#`。
 *  ⚠ 不能直接用 PY_LETTERS：那 23 个是「中文拼音可能出现的首字母」（没有 I/U/V），
 *    而库里确实有 Instagram / Udemy / Vimeo 这类英文名 —— 用 23 个去遍历会把它们
 *    整组漏掉（实测少 33 个引擎）。PY_LETTERS 只用于中文首字的边界推算。 */
const ALL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['#']);
const PY_REF = '阿八擦搭蛾发噶哈击喀拉妈拿哦怕期然撒他挖昔压匝';
let ALL_COLL = null;
function allColl() {
    if (!ALL_COLL) {
        try { ALL_COLL = new Intl.Collator('zh', { usage: 'sort' }); }
        catch (e) { ALL_COLL = { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) }; }
    }
    return ALL_COLL;
}
function allInitialOf(name) {
    const s = String(name || '').trim();
    const ch = s ? s[0] : '#';
    if (/[A-Za-z]/.test(ch)) return ch.toUpperCase();
    if (ch.codePointAt(0) < 128) return '#';        // 数字 / 标点
    let ans = '#';
    for (let i = 0; i < PY_REF.length; i++) {
        if (allColl().compare(ch, PY_REF[i]) >= 0) ans = PY_LETTERS[i];
    }
    return ans;
}

/** 引擎库正文的滚动容器：从 #allList 往上找第一个「真的能滚」的祖先。 */
function allScroller() {
    let el = $('allList');
    while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 4) return el;
        el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
}

/** 滚到某一节。
 *
 *  r73：目录**不再吸顶**（用户原话：「而且还是属于一种浮在页面上的，因为我能够
 *  在这个大类跟窗口中间看到引擎从那儿经过」），所以不用再让位置 —— 跳过去之后
 *  目标就在滚动容器顶部。 */
function allJumpTo(el) {
    if (!el) return;
    const sc = allScroller();
    const scTop = sc.getBoundingClientRect().top + (sc.clientTop || 0);
    const top = sc.scrollTop + (el.getBoundingClientRect().top - scTop) - 8;
    sc.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
}

/** 目录里的一颗胶囊（名字 + 数量 + 悬停说明）。 */
function allChip(text, count, tip, on, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'eng-nav-item' + (on ? ' on' : '');
    b.textContent = text;
    if (tip) b.title = tip;
    if (count !== null && count !== undefined && count !== '') {
        const n = document.createElement('span');
        n.className = 'eng-nav-n';
        n.textContent = count;
        b.appendChild(n);
    }
    b.addEventListener('click', onClick);
    return b;
}

/** 目录里的一行：左边是级别标签，右边是胶囊。
 *  @param label 级别名（大类 / 中类 / 小类 / 首字母）
 *  @param wrap  false = 单行横滚（条目名长，免得目录太高）；
 *               'wrap' = 换行铺开（字母索引用它 —— 用户要「一次性把所有首字母
 *               陈列出来」）；
 *               'wrap cats' = 换行铺开 + 紧凑小胶囊（小类目录汇总用） */
function allNavRow(label, wrap) {
    const row = document.createElement('div');
    row.className = 'eng-nav-row';
    const lab = document.createElement('i');
    lab.className = 'eng-nav-lv';
    lab.textContent = label;
    row.appendChild(lab);
    const track = document.createElement('div');
    track.className = 'eng-nav-track' + (wrap ? ' ' + wrap : '');
    row.appendChild(track);
    return { row, track };
}

/** 画目录。只画「当前层级该有的那几行」：大类 → 中类 → 小类目录 / 首字母索引。
 *
 *  r74：下钻视图里「小类」行**始终给出当前范围内的全部小类**（选了大类就是该大类的
 *  全部小类，再选中类收窄到该中类的）—— 用户原话：「引擎库这里有一级大类，有中类，
 *  但是小类的目录汇总就没显示出来，小类的目录要显示出来，我点击小类就能够跳转到
 *  相关位置」。点一颗胶囊 = 滚到那一节（不重新过滤）；「只看某一类」的过滤收进
 *  节标题里的小按钮（renderAllDrill）。 */
function renderAllNav(nav, ctx) {
    nav.textContent = '';

    // 一级：大类。默认四个都在这里，什么都没选。
    {
        const { row, track } = allNavRow('大类', false);
        /* ⚠ 大类胶囊**不带数量**：它主要出现在"默认空页"上，四个干净的名字更像
         * 目录；数量留给中类/小类胶囊（那两级是真的要挑一个）。
         * 另外 textContent 要保持就是纯名字 —— 探针和页内自检都是按
         * `textContent === '全部引擎'` 找按钮的，后面挂数字会让它们全部找不到。 */
        const items = [{ key: '*', title: '全部引擎' }]
            .concat(ALL_GROUPS.map((g) => ({ key: g.key, title: g.title })));
        for (const it of items) {
            track.appendChild(allChip(
                it.title, null,
                it.key === '*' ? '按首字母看全部引擎' : '只看' + it.title,
                !ctx.searching && allGroupFilter === it.key,
                () => {
                    /* r89：**再点一次同一个大类要收起来**（用户报的 bug 1）。
                     *
                     * 用户原话：「我点击任意一个引擎，那么它就会展开内容，但是我
                     * 再点击一下引擎目录，它不会自己收着，这个要修一下。」
                     *
                     * 原来的写法是「点了就设成这个大类」，于是点第二次仍然
                     * `allGroupFilter === it.key` —— 状态没变、界面当然不变，
                     * 看着就是"点了没反应、收不起来"。
                     *
                     * 现在做成开关语义：
                     *   · 点**别的**大类 → 切过去；
                     *   · 点**当前这个**大类 → 取消选择，回到"什么都没选"的空页
                     *     （`null` 会让 renderAllList 走 mode='none'，
                     *     也就是那句"上面选一个大类开始浏览"）。
                     *
                     * ⚠ 「全部引擎」那一档（key='*'）**不参与取消**：
                     *   它本身就是"看全部"的默认视图，再点一下变成"什么都不选"
                     *   只是让用户困惑 —— 那是唯一一个"点了必然有内容"的入口。 */
                    if (it.key !== '*' && allGroupFilter === it.key) {
                        allGroupFilter = null;
                    } else {
                        allGroupFilter = it.key;
                    }
                    allMidFilter = null;
                    allCatFilter = null;
                    renderAllList();
                }
            ));
        }
        nav.appendChild(row);
    }

    // 全部引擎（或搜索结果）：字母索引，一次全部列出，点一下跳到那一组。
    if (ctx.mode === 'letters') {
        const seen = {};
        for (const r of ctx.rows) seen[allInitialOf(r.name)] = 1;
        const { row, track } = allNavRow('首字母', 'wrap');
        for (const L of ALL_LETTERS) {
            if (!seen[L]) continue;
            const chip = allChip(L, null, '跳到 ' + L + ' 开头的引擎', false,
                () => {
                    allJumpTo(document.getElementById('allLetter-' + L));
                    // r74：点字母也把聚合索引面板叫出来（用户「点击之后……把所有的
                    // 首字母都聚在一起」）—— 面板不关，接着点下一个字母即可。
                    idxOpen(L);
                });
            chip.dataset.letter = L;   // 滚动监听 / 索引面板按它认领
            track.appendChild(chip);
        }
        nav.appendChild(row);
    }

    // 二级：中类（选了大类才展开）
    if (ctx.mode === 'drill') {
        const { row, track } = allNavRow('中类', false);
        track.appendChild(allChip('全部中类', null, '不限定中类', allMidFilter === null,
            () => { allMidFilter = null; allCatFilter = null; renderAllList(); }));
        for (const s of ctx.subs) {
            track.appendChild(allChip(s.title, s.count, '只看' + s.title, allMidFilter === s.key,
                () => { allMidFilter = s.key; allCatFilter = null; renderAllList(); }));
        }
        nav.appendChild(row);

        /* 三级：小类目录汇总（r74）。内容 = 当前范围内的全部小节，顺序与正文的
         * 分节一一对应（同一个 sections 数组，renderAllList 算好后两边都用）。
         *
         * ⚠ 本次改成**点击 = 只看这一类**（以前是"只跳转、不重新过滤"）。
         *   用户原话：「更多引擎面板选择完中类之后，小类最好是每一个就都呈现出来，
         *   一种胶囊的形式，这样我要哪个我点击就可以了，不用再一个个的找。
         *   还有设置引擎库里面也是这样」—— 横条面板那边已经改成平铺胶囊了，
         *   这里保持同一个手感：点一颗 = 正文只剩这一类，再点同一颗 = 恢复全部。
         *   （原来那套"跳转到那一节"的语义并没有丢：取消过滤时还会把你送回那一节，
         *    免得列表跳回顶部、位置全丢。） */
        if (ctx.sections && ctx.sections.length) {
            const { row: r3, track: t3 } = allNavRow('小类', 'wrap cats');
            if (allCatFilter) {
                t3.appendChild(allChip('全部小类', null, '恢复列出全部小类', true,
                    () => { allCatFilter = null; renderAllList(); }));
            }
            for (const s of ctx.sections) {
                const chip = allChip(s.title, s.count,
                    '只看「' + s.title + '」这一类（共 ' + s.count + ' 个）；再点一次恢复全部',
                    allCatFilter === s.title,
                    () => {
                        const wasOn = allCatFilter === s.title;
                        allCatFilter = wasOn ? null : s.title;
                        renderAllList();
                        /* 过滤状态下这一节**没有**节标题、也就没有锚点（正文直接从它
                         * 开始，本来就在视野顶部，不用跳）。只有"取消过滤"这一下
                         * 需要把人送回原处 —— 否则整份列表重画、滚动位置回到顶部。 */
                        if (wasOn) {
                            const el = document.getElementById(s.anchor);
                            if (el) allJumpTo(el);
                        }
                    });
                chip.dataset.jump = s.anchor;   // 滚动监听认领用
                t3.appendChild(chip);
            }
            nav.appendChild(r3);
        }
    }
}

/** 全部引擎：按首字母分组（A→Z，数字/符号归 #），组内按拼音排。
 *  这一档**不写任何分类标题** —— 用户原话：「显示全部引擎的过程当中，就不显示
 *  我说的这些，就只以 abcd 这样的来显示」。 */
function renderAllLetters(box, rows) {
    const groups = new Map();
    for (const r of rows) {
        const L = allInitialOf(r.name);
        if (!groups.has(L)) groups.set(L, []);
        groups.get(L).push(r);
    }
    let shown = 0;
    for (const L of ALL_LETTERS) {
        const list = groups.get(L);
        if (!list || !list.length) continue;
        list.sort((a, b) => allColl().compare(a.name, b.name));
        const h = document.createElement('div');
        h.className = 'eng-letter-h';
        h.id = 'allLetter-' + L;
        h.dataset.anchor = 'allLetter-' + L;
        h.textContent = L;
        const n = document.createElement('small');
        n.textContent = list.length;
        h.appendChild(n);
        box.appendChild(h);
        const ls = document.createElement('div');
        ls.className = 'list';
        for (const r of list) { shown++; ls.appendChild(allRowNode(r)); }
        box.appendChild(ls);
    }
    if (!shown) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '没有匹配的引擎。';
        box.appendChild(d);
    }
}

/** 下钻：按小类分节列引擎（小类就是最后一层，不再套任何中间标题）。
 *
 *  r74：每节标题带锚点（allCat-N，和目录行 sections 同一份顺序），点目录里的
 *  小类胶囊就滚到那一节。「只看这一类」从目录行收进这里 —— 目录行改成纯跳转
 *  后，r72 那个「每一级都有直达按钮」的小类过滤不能丢，搁节标题上正好。 */
function renderAllDrill(box, rows, catFilter, sections) {
    const groups = new Map();
    for (const r of rows) {
        const c = r.cat || '其他';
        if (catFilter && c !== catFilter) continue;
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(r);
    }
    let shown = 0;
    let idx = 0;
    for (const [cat, list] of groups) {
        // 锚点与目录行共用（renderAllList 传来的 sections 顺序一致）
        const anchor = (sections && sections[idx] && sections[idx].anchor) || ('allCat-' + idx);
        idx++;
        if (!catFilter) {
            const h = document.createElement('div');
            h.className = 'eng-cat-h';
            h.id = anchor;
            h.dataset.anchor = anchor;
            h.textContent = cat;
            const n = document.createElement('small');
            n.textContent = list.length;
            h.appendChild(n);
            const only = document.createElement('button');
            only.type = 'button';
            only.className = 'eng-cat-only';
            only.textContent = '只看';
            only.title = '只列出「' + cat + '」这一类引擎（点目录里的「全部小类」恢复）';
            only.addEventListener('click', (e) => {
                e.stopPropagation();
                allCatFilter = cat;
                renderAllList();
            });
            h.appendChild(only);
            box.appendChild(h);
        }
        const ls = document.createElement('div');
        ls.className = 'list';
        for (const r of list) { shown++; ls.appendChild(allRowNode(r)); }
        box.appendChild(ls);
    }
    if (!shown) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '这一类下没有匹配的引擎。';
        box.appendChild(d);
    }
}

function renderAllList() {
    const f = $('allFilter');
    const box = $('allList');
    /* ⚠ `listen('qs://config')` 是**模块顶层**注册的，早于 boot() 里
     *   `CATALOG = await fetch('ui/data/engines.json')`。窗口刚建好就到达的
     *   广播会走到这里，那时 CATALOG 还是 null —— 下一行的 CATALOG.categories
     *   直接抛 TypeError，把广播处理函数后面那一整段刷新（自定义引擎 / 外部
     *   软件 / 开关同步 / 绑定）全部带停。数据没就绪就先不画：boot() 拉到
     *   数据之后会自己再画一次。 */
    if (!CATALOG || !f || !box) return;
    /* ⚠ 广播防抖（性能 + 不打断滚动）：`qs://config` 每来一次都会走到这里，而
     *   收藏面板拖尺寸是 600ms 一次广播（bar.js），每次都把 777 行全部拆了重建 ——
     *   列表还会弹回顶部，用户正在「全部引擎」里滚动时看着就是"页面自己跳了"。
     *
     *   判据用**渲染输入**的指纹：过滤词 + 三个下钻态 + 自定义引擎/外部软件的名字
     *   集合 + 图标覆盖的键。这些都没变，说明这次广播改的是别的东西（收藏尺寸、
     *   AI 后缀…），重画没有任何收益。
     *
     *   指纹存模块级 `allListSig`：切分页 / 用户主动改筛选时由调用方清空（见
     *   `invalidateAllList`），保证"该重画的时候一定重画"。 */
    const sig = [
        f.value,
        allGroupFilter || '',
        allMidFilter || '',
        allCatFilter || '',
        (CONF.customEngines || []).map((x) => x.name).join('\u0001'),
        (CONF.apps || []).map((x) => x.name).join('\u0001'),
        /* ⚠ 下面这三项是**渲染真的会变**的输入，必须进指纹。
         *
         *  · `barList`：列表行上的「☆ 已在横条 / ＋ 加到横条」是按它画的，
         *    用户在横条面板里右键增删、或在「横条上的引擎」里拖动，都会改它。
         *  · `aiMattingEnable`：它决定每一行**有没有**「编辑图标」按钮
         *    （见 `iconEditorEnabled` / `hasIconToEdit`）。
         *  · `dirIcons`：文件名 = 引擎名 的那批默认图标。
         *
         * 漏掉它们的时候症状是"界面没反应"：开关点了、横条引擎增删了，
         * 但列表一行都不重画，用户得切一次分页才看到变化
         * （`bindSwitches` 里那条注释说的就是这个病，我加指纹时又漏了一遍）。 */
        (CONF.barList || []).join('\u0001'),
        CONF.aiMattingEnable ? '1' : '0',
        CONF.unifyIcons === false ? '0' : '1',
        /* 图标覆盖：键 + 值的长度 + 首尾各 12 字符。
         * 只取键不够 —— 「给同一颗引擎换一张图」键不变、图变了，列表里的图标
         * 必须跟着变（用户会以为没换成功）。又不能把整串 data URL 拼进指纹
         * （收藏夹那种几 MB 的 base64 会让每次广播都白算一遍）。 */
        window.qsIconSigOf(CONF.overrideIcons),
        window.qsIconSigOf(CONF.dirIcons),
    ].join('\u0002');
    if (sig === allListSig && box.childElementCount) return;
    allListSig = sig;
    const kw = f.value.trim().toLowerCase();
    box.textContent = '';

    /* 三大类 × 二级细分（ engines.json schema 2 的 groups 元数据派生）。
     * 和横条面板（ bar.js 的 panelTree）同一棵树、同一个派生函数。 */
    const tree = qsCatalogGroups(CATALOG);

    // 横条默认引擎里若有不在任何分类中的（自定义数据可能出现），
    // 按类型合成一个分类挂到对应子类下面，别让它们从列表里消失
    const inCats = new Set();
    for (const c of CATALOG.categories) for (const e of c.engines) inCats.add(e.name);
    const extra = CATALOG.toolbar.filter((e) => !inCats.has(e.name));
    if (extra.length) {
        const buckets = { hotkey: [], search: [], open: [] };
        for (const e of extra) buckets[qsEngineKind(e)].push(e);
        for (const g of tree) {
            for (const s of g.subs) {
                const mine = s.key === 'hotkey' ? buckets.hotkey
                    : (s.key === 'search' || s.key === 'appsearch') ? buckets.search
                        : buckets.open;
                if (mine.length) s.cats.unshift({ title: '横条默认引擎', engines: mine });
            }
        }
    }

    /* 平铺数据源（shared.js 的 qsAllEngineRows）：网页/快捷键引擎来自分类树
     * （含自定义引擎合进来的），外部软件来自 CONF.apps。
     * 每条 { name, kind, group, sub, cat, eng, isApp }。 */
    const rows = window.qsAllEngineRows(tree);

    // 搜索：不分层级、直接全表（字母分组）—— 输了关键字还要先点三级目录才能
    // 看到结果，那才叫难用。
    const searching = !!kw;
    /* ⚠ r80f：搜索时**必须按名字去重**（用户报「搜一个引擎出现多个同样的」）。
     *
     * 根因是**数据模型**而不是渲染 bug：一个引擎可以同时属于多个分类 ——
     * 实测 `qsAllEngineRows` 里 777 行有 8 个名字重复，例如
     * ```
     *   知乎 ×3    → web/search/知识 + web/search/社交 + web/search/新闻
     *   微博 ×2    → web/search/社交 + web/search/新闻
     *   任务管理器 ×2 → app/appopen/常用软件 + hotkey/hotkey/快捷键
     * ```
     * 这本身是合理的（知乎既是知识站也是社交平台），**按分类浏览时也该各出现一次**；
     * 但**搜索结果是一份清单**，同一个引擎列三遍只会让人以为程序出错了。
     *
     * 去重口径：同一个名字只留一条，优先留"归属更贴切"的那个 ——
     * 排序依据是**大类/子类的语义优先级**（不是随便取第一条）：
     *   网页搜索 > 软件搜索 > 网页直达 > 软件直达 > 快捷键
     * 因为用户搜一个网站名时，最想要的是"用搜索引擎搜它"，而不是"打开官网"。
     * （知乎那条就应当留 web/search 而不是 web/open。） */
    const KIND_RANK = { search: 0, appsearch: 1, open: 2, appopen: 3, hotkey: 4 };
    const hits = (() => {
        const list = searching ? rows.filter((r) => allRowHit(r, kw)) : rows;
        if (!searching) return list;
        const best = new Map();   // name -> 目前最好的一条
        for (const r of list) {
            const cur = best.get(r.name);
            if (!cur) { best.set(r.name, r); continue; }
            // 排名小的更优先；同排名时保留**先出现**的（保持原顺序稳定）
            const a = KIND_RANK[r.kind] === undefined ? 9 : KIND_RANK[r.kind];
            const b = KIND_RANK[cur.kind] === undefined ? 9 : KIND_RANK[cur.kind];
            if (a < b) best.set(r.name, r);
        }
        // 按原顺序输出（Map 的迭代顺序 = 插入顺序，但替换会保留位置；
        // 这里显式按 list 顺序过滤，保证界面顺序与去重前一致）
        const kept = new Set();
        const out = [];
        for (const r of list) {
            if (best.get(r.name) === r) { out.push(r); kept.add(r.name); }
            else if (!kept.has(r.name) && best.get(r.name) === undefined) { out.push(r); }
        }
        return out;
    })();

    let mode = 'none';
    if (searching || allGroupFilter === '*') mode = 'letters';
    else if (allGroupFilter) mode = 'drill';

    // 下钻用的三层数据（切了大类之后中类/小类不在范围内就自动复位）
    const groupRows = mode === 'drill' ? hits.filter((r) => r.group === allGroupFilter) : [];
    const subs = [];
    if (mode === 'drill') {
        for (const key of ALL_SUBS[allGroupFilter] || []) {
            const list = groupRows.filter((r) => r.sub === key);
            if (list.length) subs.push({ key, title: allSubTitle(tree, key), count: list.length });
        }
        if (allMidFilter && !subs.some((s) => s.key === allMidFilter)) allMidFilter = null;
    }
    const midRows = allMidFilter ? groupRows.filter((r) => r.sub === allMidFilter) : groupRows;
    const cats = [];
    {
        const seen = new Set();
        for (const r of midRows) {
            const c = r.cat || '其他';
            if (seen.has(c)) continue;
            seen.add(c);
            cats.push({ title: c, count: midRows.filter((x) => (x.cat || '其他') === c).length });
        }
        if (allCatFilter && !cats.some((c) => c.title === allCatFilter)) allCatFilter = null;
    }
    /* r74：小类分节表 = 目录行与正文**共用的一份顺序**（锚点 allCat-N 按这个下标发）。
     * 目录里点小类跳哪一节、正文里哪一节带哪个锚点，全看这张表，两边永不失同步。 */
    const sections = cats.map((c, i) => ({ title: c.title, count: c.count, anchor: 'allCat-' + i }));

    // —— 目录 ——
    const nav = $('allGrpNav');
    if (nav) renderAllNav(nav, { mode, rows: hits, subs, cats, sections, searching });

    // —— 正文 ——
    if (mode === 'none') {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '上面选一个大类开始浏览；点「全部引擎」则按首字母列出全部。';
        box.appendChild(d);
        idxFabHide();
        return;
    }
    if (mode === 'letters') {
        renderAllLetters(box, hits);
        // r74：字母视图把「聚合索引」那套家伙摆出来（浮动钮 + 面板内容）
        const seen = {};
        for (const r of hits) seen[allInitialOf(r.name)] = 1;
        idxRender(seen);
        return;
    }
    renderAllDrill(box, midRows, allCatFilter, sections);
    idxFabHide();
}

/* ------------------------------------------------------------------ */
/* r74：首字母聚合索引（Win11「所有应用」那一下）                        */
/* ------------------------------------------------------------------ */

/* 用户原话：「当我点击大类全部引擎之后，这里有首字母，我确实可以点击快速
 * 地到那里，但我也希望在目录中的首字母位置，我点击之后能够像 win11 菜单
 * 一样，把所有的首字母都聚在一起，那这时候我点击任意一个首字母就能够
 * 跳转到相应的位置，而不是说每次我要搞不同的首字母还要跳到最上面然后再选。」
 *
 * 落成三件套：
 *   ① 目录里的「首字母」行（renderAllNav 画）—— 一次性铺开，点一个跳一组；
 *   ② 右下角浮动钮 #allIdxFab —— letters 模式下常驻，点它把聚合面板叫出来；
 *   ③ 聚合面板 #allIdxPop —— 27 个字母一眼看全（没有引擎的变灰但占位），
 *      点一个跳一个，**面板不关**，可以连着跳；Esc / 点外面 / 再点浮动钮收起。
 * 另外有一条滚动监听（idxSpy*）：滚到哪一组，目录里对应的字母胶囊和浮动钮
 * 上的当前字母就亮到哪 —— 让用户始终知道「现在在哪」，不用回顶部确认。 */

/** 索引三件套的运行时状态。cur = 当前所在字母组（滚动监听维护）。 */
const idxState = { built: false, fab: null, pop: null, grid: null, cur: '', open: false };

/** 引擎页当前是否可见 —— 切走分页时浮动钮必须收起来（position:fixed，
 *  不收就漂在「通用 / AI / OCR」那些页上面，像个补丁）。 */
function idxPaneVisible() {
    const p = document.querySelector('.pane[data-pane="engines"]');
    return !!p && !p.hidden;
}

/** 从 DOM 反推「哪些字母真的有引擎」—— letters 模式的组标题（.eng-letter-h）
 *  就是权威，比再算一遍 rows 稳（自定义引擎、搜索过滤后的结果都直接反映）。 */
function idxSeenFromDom() {
    const seen = {};
    for (const h of document.querySelectorAll('#allList .eng-letter-h')) {
        const L = String(h.id || '').replace(/^allLetter-/, '');
        if (L) seen[L] = 1;
    }
    return seen;
}

/** 懒造浮动钮 + 聚合面板（整个进程只造一次，之后只换内容/显隐）。 */
function idxBuild() {
    if (idxState.built) return;
    idxState.built = true;

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'allIdxFab';
    fab.className = 'idx-fab';
    fab.hidden = true;
    fab.title = '首字母聚合索引：27 个字母一眼看全，点一个跳一个（面板不用关）';
    const fabT = document.createElement('span');
    fabT.className = 'idx-fab-t';
    fabT.textContent = 'A–Z 索引';
    const fabC = document.createElement('span');
    fabC.className = 'idx-fab-c';
    fab.appendChild(fabT);
    fab.appendChild(fabC);
    fab.addEventListener('click', (e) => { e.stopPropagation(); idxToggle(); });
    document.body.appendChild(fab);

    const pop = document.createElement('div');
    pop.id = 'allIdxPop';
    pop.className = 'idx-pop';
    pop.hidden = true;
    const hd = document.createElement('div');
    hd.className = 'idx-pop-h';
    const b = document.createElement('b');
    b.textContent = '首字母索引';
    const s = document.createElement('span');
    s.className = 'idx-pop-s';
    s.textContent = '点字母跳过去，面板不用关';
    hd.appendChild(b);
    hd.appendChild(s);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'idx-pop-x';
    x.textContent = '✕';
    x.title = '收起索引面板（Esc 也可以）';
    x.addEventListener('click', (e) => { e.stopPropagation(); idxClose(); });
    hd.appendChild(x);
    pop.appendChild(hd);
    const grid = document.createElement('div');
    grid.className = 'idx-pop-g';
    pop.appendChild(grid);
    document.body.appendChild(pop);

    idxState.fab = fab;
    idxState.pop = pop;
    idxState.grid = grid;

    /* 点外面 / Esc 收起。pointerdown 用捕获期之前的冒泡即可 —— 面板和浮动钮
     * 自己 stopPropagation，不会误伤。 */
    document.addEventListener('pointerdown', (e) => {
        if (!idxState.open) return;
        if (pop.contains(e.target) || fab.contains(e.target)) return;
        idxClose();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && idxState.open) { idxClose(); e.stopPropagation(); }
    });

    /* 滚动监听：scroll 事件不冒泡，但 capture 阶段能收到页面上所有滚动
     * （主容器 main 在滚、内层横滚轨道在滚，都算）。rAF 节流，一帧最多跑一次。
     * passive：监听里只读布局、不写，不占滚动帧预算。 */
    document.addEventListener('scroll', () => idxSpyRequest(), { capture: true, passive: true });
    window.addEventListener('resize', () => idxSpyRequest());
}

/** 填面板格子：27 个字母**全列**（索引的价值就是看全），没有引擎的变灰占位。 */
function idxFill(seen) {
    idxBuild();
    const g = idxState.grid;
    g.textContent = '';
    for (const L of ALL_LETTERS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.letter = L;
        if (seen && seen[L]) {
            b.className = 'idx-pop-i';
            b.textContent = L;
            b.title = '跳到 ' + L + ' 开头的引擎';
            b.addEventListener('click', (e) => { e.stopPropagation(); idxJump(L); });
        } else {
            b.className = 'idx-pop-i off';
            b.textContent = L;
            b.title = '没有 ' + L + ' 开头的引擎';
            b.disabled = true;
        }
        g.appendChild(b);
    }
}

/** letters 模式：把索引摆出来。renderAllList 每次重画都调（内容会跟着
 *  搜索词 / 自定义引擎变 —— 比如搜 "bili" 时只剩 B 一个是亮的）。 */
function idxRender(seen) {
    idxBuild();
    idxFill(seen);
    if (!idxPaneVisible()) { idxFabHide(); return; }
    idxState.fab.hidden = false;
    toTopStackSync();
    idxSpyRequest();
}

/** 切回引擎分页时按 DOM 现况恢复（**不重画列表** —— 重画会把用户正在看的
 *  位置弹回顶部，那是拿体验换代码省事）。 */
function idxReshow() {
    if (allGroupFilter !== '*') return;
    idxRender(idxSeenFromDom());
}

/** 收回浮动钮 + 关面板（下钻 / 空状态 / 切走分页时调）。 */
function idxFabHide() {
    idxClose();
    if (idxState.fab) idxState.fab.hidden = true;
    toTopStackSync();
}

function idxOpen(L) {
    idxBuild();
    if (!idxPaneVisible()) return;
    if (!idxState.grid.children.length) idxFill(idxSeenFromDom());
    idxState.fab.hidden = false;
    toTopStackSync();
    idxState.pop.hidden = false;
    idxState.open = true;
    if (L) idxMark(L);
}

function idxClose() {
    if (idxState.pop) idxState.pop.hidden = true;
    idxState.open = false;
}

function idxToggle() {
    if (idxState.open) idxClose();
    else idxOpen(idxState.cur);
}

/** 面板里点一个字母：跳过去 + 两处（面板/目录）标记当前字母，面板不关。 */
function idxJump(L) {
    allJumpTo(document.getElementById('allLetter-' + L));
    idxMark(L);
    idxSpyRequest();   // 跳完让监听重新确认当前组（容错：跳的目标被删过等）
}

/** 把「当前字母」在面板、目录字母行、浮动钮三处一起点亮 / 一起熄。 */
function idxMark(L) {
    idxState.cur = L || '';
    if (idxState.grid) {
        for (const b of idxState.grid.children) {
            b.classList.toggle('on', !!L && b.dataset.letter === L);
        }
    }
    for (const c of document.querySelectorAll('#allGrpNav .eng-nav-item[data-letter]')) {
        c.classList.toggle('on', !!L && c.dataset.letter === L);
    }
    if (idxState.fab) {
        idxState.fab.querySelector('.idx-fab-c').textContent = L || '';
        idxState.fab.classList.toggle('cur', !!L);
    }
}

/** 滚动监听的 rAF 节流：一帧最多算一次。 */
let idxSpyPending = false;
function idxSpyRequest() {
    if (idxSpyPending) return;
    idxSpyPending = true;
    requestAnimationFrame(() => { idxSpyPending = false; idxSpyRun(); });
}

/** 看当前滚到哪一节，点亮对应导航。
 *
 *  · letters 模式：节头是 allLetter-X → 当前字母 X（面板 / 目录 / 浮动钮联动）；
 *  · drill 模式：节头是 allCat-N → 目录里对应的小类胶囊加 .spy。这里**不
 *    复用 .on** —— .on 的含义是「正在只看这一类」（过滤态），混用会让用户
 *    以为滚到哪里就在过滤哪里；.spy 只点边框不填底色，一眼分得开。 */
function idxSpyRun() {
    const list = $('allList');
    if (!list) return;
    const heads = list.querySelectorAll('[data-anchor]');
    if (!heads.length) return;
    const sc = allScroller();
    const scTop = sc.getBoundingClientRect().top + (sc.clientTop || 0);
    let cur = null;
    for (const h of heads) {
        if (h.getBoundingClientRect().top - scTop <= 90) cur = h;
        else break;
    }
    const anchor = cur ? String(cur.dataset.anchor || '') : '';
    const L = anchor.replace(/^allLetter-/, '');
    if (L && ALL_LETTERS.indexOf(L) >= 0) {
        if (idxState.cur !== L) idxMark(L);
        return;
    }
    // 非字母节（下钻的小类节 / 还没滚到任何节）：熄掉字母标记，改点小类胶囊
    if (idxState.cur) idxMark('');
    for (const c of document.querySelectorAll('#allGrpNav .eng-nav-item[data-jump]')) {
        c.classList.toggle('spy', !!anchor && c.dataset.jump === anchor);
    }
}

/* ------------------------------------------------------------------ */
/* r75：回到顶部                                                        */
/* ------------------------------------------------------------------ */

/* 设置页的几个分页（引擎库 / 帮助 / 关于）动辄好几屏，滚到下半程想回顶部
 * 只能一路把滚轮拨回去。用户口径：「超过两页的内容，滑过两页之后加一颗到
 * 最上端的按钮」—— 判据就照这个写：main.scrollTop > 2 × main.clientHeight。
 * 「两页」按滚动容器自己的可视高度算，窗口拉大拉小都跟着走，不写死像素。
 *
 * 三件事值得记一笔：
 *  ① 浮动钮和首字母索引钮同占右下角（那块最好够到）。两个同时亮时这颗由
 *     body.idx-on 抬到索引钮上面，谁也不压谁；
 *  ② 滚动监听**自己装一条**：索引钮那条是 idxBuild 里装的（只有引擎页渲染
 *     过才存在），设置页别的分页也长得要命，不能指望它；
 *  ③ 显隐走 opacity + pointer-events 过渡，不用 [hidden]：滚动帧里最贵的
 *     就是插拔 fixed 元素触发布局，这里一次都不做。 */
let toTopState = { built: false, el: null, on: false, pending: false };

function toTopBuild() {
    if (toTopState.built) return;
    toTopState.built = true;

    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'toTopFab';
    b.className = 'to-top';
    b.title = '回到页面顶部（滚过两屏后出现）';
    b.setAttribute('aria-label', '回到页面顶部');
    b.setAttribute('aria-hidden', 'true');
    b.tabIndex = -1;
    const i = document.createElement('span');
    i.className = 'to-top-i';
    i.textContent = '↑';
    const t = document.createElement('span');
    t.textContent = '顶部';
    b.appendChild(i);
    b.appendChild(t);
    b.addEventListener('click', (e) => {
        e.stopPropagation();
        const m = $('main');
        if (!m) return;
        /* smooth 在这里可用：r72 那次不让用 smooth 是因为目标窗口不可见时
         * 浏览器会把动画节流停在中途，而设置页窗口一直是可见的。 */
        m.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(b);
    toTopState.el = b;

    document.addEventListener('scroll', () => toTopRequest(), { capture: true, passive: true });
    window.addEventListener('resize', () => toTopRequest());
}

/** rAF 节流：一帧最多判一次显隐。 */
function toTopRequest() {
    if (toTopState.pending) return;
    toTopState.pending = true;
    requestAnimationFrame(() => { toTopState.pending = false; toTopSync(); });
}

function toTopSync() {
    toTopBuild();
    const m = $('main');
    if (!m || !toTopState.el) return;
    const on = m.scrollTop > m.clientHeight * 2;
    if (on === toTopState.on) return;
    toTopState.on = on;
    toTopState.el.classList.toggle('on', on);
    toTopState.el.setAttribute('aria-hidden', on ? 'false' : 'true');
    toTopState.el.tabIndex = on ? 0 : -1;
}

/** 索引浮动钮的显隐会挤到同一个角落：记在 body 上一个类，CSS 负责抬升。
 *  三处调用点就是 fab.hidden 被改的三处（idxRender / idxOpen / idxFabHide）。 */
function toTopStackSync() {
    const idxOn = !!(idxState.fab && !idxState.fab.hidden);
    document.body.classList.toggle('idx-on', idxOn);
}

/* ------------------------------------------------------------------ */
/* 自定义引擎                                                          */
/* ------------------------------------------------------------------ */

/* 表单当前处于「新增」还是「编辑」。
   -1 = 新增；>= 0 = 正在编辑第几条。用一个变量而不是两套 DOM ，
   是为了让「校验规则」只有一份 —— 不然很容易出现「新增时拦重名、
   编辑时却放过」这种半拉子校验。 */
let ceEditIndex = -1;
/** 表单里当前选的引擎类型：search = 搜索（带 %s），open = 打开（直达页面），
 *  hotkey = 快捷键（点了发送组合键）。
 *  它**不进配置**（不是全局设置），只跟着表单走：新增时默认 search，
 *  编辑时读回那条引擎自己的 kind，保存时作为一个字段交给后端。 */
let ceKind = 'search';

/* ---- 添加引擎的方式选择（#127）----
 * 整张表单默认收起。点「＋ 添加引擎」展开三张方式卡，选一种才把对应表单
 * 放出来：web = 网页引擎（customForm，搜索/打开二选一）、
 * app = 软件引擎（appForm）、hotkey = 快捷键引擎（customForm 且类型锁死）。
 * null = 方式选择层也收起（或展开了但还没选）。 */
let addWay = null;

/** 切到某种添加方式。keep = true 时**不**重置表单（编辑老条目走这条：
 *  字段刚填好，一重置就全白了）。 */
function setAddWay(way, keep) {
    addWay = way;
    const ways = $('addWays');
    if (ways) {
        ways.hidden = false;
        for (const b of ways.querySelectorAll('.addway')) {
            b.classList.toggle('on', b.dataset.way === way);
        }
    }
    const cf = $('customForm');
    const af = $('appForm');
    if (way === 'app') {
        if (cf) cf.hidden = true;
        if (af) af.hidden = false;
        if (!keep) resetCeForm();
        try { $('w-apName').focus(); } catch (_) { }
    } else {
        if (af) af.hidden = true;
        if (cf) cf.hidden = false;
        if (!keep) resetAppForm();
        // 网页方式：类型分段只留「搜索 / 打开」（快捷键是独立的添加方式）；
        // 快捷键方式：类型没得选，整条分段藏起来
        if (way === 'hotkey') ceKind = 'hotkey';
        else if (ceKind === 'hotkey') ceKind = 'search';
        applyCeKind();
        try { $('w-ceName').focus(); } catch (_) { }
    }
}

/** 整层收起：方式卡 + 两张表单全收起来，字段归位。 */
function collapseAddWays() {
    addWay = null;
    const ways = $('addWays');
    if (ways) {
        ways.hidden = true;
        for (const b of ways.querySelectorAll('.addway')) b.classList.remove('on');
    }
    const cf = $('customForm'), af = $('appForm');
    if (cf) cf.hidden = true;
    if (af) af.hidden = true;
    resetCeForm();
    resetAppForm();
}

/** 表单提交成功之后：字段归位、表单收起，回到方式选择那一层（还能接着加）。 */
function afterAddDone(way) {
    addWay = null;
    const ways = $('addWays');
    if (ways) for (const b of ways.querySelectorAll('.addway')) b.classList.remove('on');
    if (way === 'app') {
        resetAppForm();
        $('appForm').hidden = true;
    } else {
        resetCeForm();
        $('customForm').hidden = true;
    }
}

/** 表单类型切换：换占位符、换提示、换「地址框 / 组合键框」谁出场，
 *  让「%s 该不该写」「要不要填按键」一眼可见。 */
function applyCeKind() {
    const seg = $('s-ceKind');
    if (seg) {
        for (const b of seg.querySelectorAll('button')) {
            b.classList.toggle('on', b.dataset.v === ceKind);
        }
        /* 快捷键是独立的「添加方式」：网页方式下不再出现在类型分段里，
         * 免得同一条路有两个入口。 */
        const hk = seg.querySelector('button[data-v="hotkey"]');
        if (hk) hk.hidden = (addWay === 'web');
        // 快捷键方式：类型没得选，整条分段（含说明）藏起来
        const row = seg.closest('.cform-kind');
        if (row) row.hidden = (addWay === 'hotkey');
    }
    const url = $('w-ceUrl');
    if (url) {
        url.placeholder = ceKind === 'open'
            ? 'https://example.com/page（直接打开，不要写 %s）'
            : 'https://example.com/search?q=%s';
        // 快捷键类压根不用地址：把地址框收起来，换上组合键框
        url.hidden = ceKind === 'hotkey';
    }
    const hotRow = $('ceHotRow');
    if (hotRow) hotRow.hidden = ceKind !== 'hotkey';
    /* r58：绑定应用整块只在快捷键类出现 —— 搜索/打开类没有"发按键"这回事，
     * 摆一个用不上的开关只会让人以为它能用。 */
    const bindRow = $('ceBindRow');
    if (bindRow) bindRow.hidden = ceKind !== 'hotkey';
    syncCeBind();
    const note = $('ceKindNote');
    if (note) {
        note.textContent = ceKind === 'open'
            ? '打开：不要求选中文字，点了直接打开这个页面（地址里不要写 %s）'
            : ceKind === 'hotkey'
                ? '快捷键：不要求选中文字，点了把组合键发给当时的前台软件（不用填地址）'
                : '搜索：带上选中的词跳过去搜，地址里要用 %s 标出关键词的位置';
    }
    // 录入态在切类型时一并退出：不然「录制…」按到一半切走，键盘还被捕获着
    if (ceRecArmed) ceRecDisarm();
}

/* ---- r58：快捷键引擎「绑定应用」的联动显隐 ----
 *
 * 三层是**逐层出现**的：不勾开关就看不到"选应用"，没选应用就看不到"管理员"。
 * 一次性全摆出来会让这个小表单显得比实际复杂；而且"没选应用却能勾管理员"
 * 是个没有意义的组合，干脆不显示。
 *
 * r76：第四层「启动后再等多久才按快捷键」跟管理员同一条件（勾了开关 + 选了应用）。
 * 它调的正是"我们拉起来应用"到"发快捷键"之间那一拍 —— 没绑应用就没有这一拍，
 * 所以藏在同一条件下正合适。
 *
 * 幂等：applyCeKind 每次切类型都会调它，所以里面不能有"只绑一次"的副作用。 */
function syncCeBind() {
    const on = $('w-ceBindApp');
    const pathRow = $('ceBindPathRow');
    const adminRow = $('ceBindAdminRow');
    const delayRow = $('ceBindDelayRow');
    if (!on) return;
    const bound = !!on.checked;
    if (pathRow) pathRow.hidden = !bound;
    // 管理员那一行：勾了开关、而且真的选了一个应用才出现
    const hasPath = !!($('w-ceAppPath') && $('w-ceAppPath').value.trim());
    if (adminRow) adminRow.hidden = !(bound && hasPath);
    // r76：启动延迟行同条件
    if (delayRow) delayRow.hidden = !(bound && hasPath);
    /* r90：「把应用窗口调到前台」这一行也同条件 ——
     * 没绑应用就谈不上"调谁到前台"。 */
    const frontRow = $('ceBringFrontRow');
    if (frontRow) frontRow.hidden = !(bound && hasPath);
}

function bindCeBind() {
    const on = $('w-ceBindApp');
    if (!on) return;
    on.addEventListener('change', () => {
        syncCeBind();
        // 勾上但还没选应用：直接把焦点送到「选择…」，省一次找
        if (on.checked && !($('w-ceAppPath') || {}).value) {
            const b = $('btnCePickApp');
            if (b) b.focus();
        }
    });
    const pick = $('btnCePickApp');
    if (pick) {
        pick.addEventListener('click', async () => {
            const hint = $('ceHint');
            if (hint) hint.textContent = '正在打开文件选择…';
            try {
                const p = await invoke('pick_app');
                if (p) {
                    $('w-ceAppPath').value = p;
                    if (hint) hint.textContent = '';
                    /* r88：选完应用顺带把它的图标拿来当引擎图标 */
                    adoptAppIcon(p);
                } else if (hint) {
                    hint.textContent = '';
                }
            } catch (e) {
                if (hint) hint.textContent = '选择应用失败：' + String(e);
            }
            syncCeBind();
        });
    }
    /* r59：**十字准星点选** —— 用户要求「点击之后鼠标变成一个十字，我把这个十字
     * 点到相关软件上，点一下就会自动选中这个软件」。
     *
     * 复用软件引擎那套 `picker.html` 覆盖层（铺满全屏 + 十字光标 + Esc 可退），
     * 只是让它回**完整路径**（`?want=path` → `pick_app_path_at`）。
     * 结果由后端 emit `qs://picked-app-path` 推回来，由下面那个监听负责填框。 */
    const byClick = $('btnCePickAppByClick');
    if (byClick) {
        byClick.addEventListener('click', () => {
            const hint = $('ceHint');
            if (hint) hint.textContent = '鼠标会变成十字：点一下要绑定的那个程序窗口（Esc 取消）';
            invoke('open_app_picker', { want: 'path' }).catch((e) => {
                if (hint) hint.textContent = '打不开点选器：' + String(e);
            });
        });
    }
    syncCeBind();
}

/* r59：十字准星点选的结果回到这里 —— 填进「应用路径」框。
 *
 * 为什么走事件而不是等 invoke 的返回值：覆盖层是**另一个窗口**，用户可能点好几秒，
 * 主命令早就返回了。所以后端在真正选中的那一刻 `emit_to('settings', ...)`。 */
listen('qs://picked-app-path', (ev) => {
    const p = typeof ev.payload === 'string' ? ev.payload : '';
    const box = $('w-ceAppPath');
    if (box && p) {
        box.value = p;
        const hint = $('ceHint');
        if (hint) hint.textContent = '已选中：' + p;
        /* r88：十字准星点选这条路同样顺带取图标 */
        adoptAppIcon(p);
        syncCeBind();
    }
});

/// 记下"选了应用但名字还没定"时那次选择，等表单提交时补上。
///
/// ⚠ 声明必须**在所有使用点之前**（模块级 `let` 有 TDZ）：`adoptAppIcon`
///   在运行时可能先于这行被调，而它里面会读这个变量。我第一版把声明放在
///   函数**后面**，靠"反正是模块级、函数调用晚于声明"侥幸 —— 但
///   `bindCeBind()` 里的监听是**用户交互时**才跑，那时确实已经过了声明，
///   看起来能用；然而 `adoptAppIcon` 若被更早的路径调用就会抛
///   "Cannot access before initialization"。放在这里没有歧义。
let pendingAppIcon = '';

/* r88：把「选中的那个应用」的图标拿来当这个快捷键引擎的图标。
 *
 * # 用户要求
 *
 * 「快捷键引擎要增加一个功能，那就是当我选择了某一个应用的时候，就能够把
 *  那个应用的图标作为软件里显示的图标。」
 *
 * # 什么时候**不**做
 *
 *   · 没在编辑快捷键类引擎时（这个编辑区根本不存在）→ 直接不调；
 *   · **用户已经手动换过图标**时 → 不覆盖。这是个取舍：自动取图标是
 *     "省事"，而用户手动挑一张是"明确表达"。抢他的手动选择是错的 ——
 *     所以只在 `overrides` 里**没有**这个引擎时才自动填。
 *     想换回应用图标，用「恢复默认图标」清掉之后再选一次应用即可。
 *
 * # 为什么是 fire-and-forget
 *
 * 后端那条路要读 exe / 建 DC / 编码 PNG，几十毫秒级；而且**可能失败**
 * （有些 exe 就是没有图标资源）——失败时后端只写日志、不打扰用户，
 * 引擎照常显示字母徽标。这里 don't await 也不报错，和它的语义一致。 */
function adoptAppIcon(path) {
    /* ⚠ 拿"引擎名"要从**名字输入框**读，不是从索引 ——
     * 这个表单的编辑态用 `ceEditIndex`（一个索引），而 overrides 的键是
     * **引擎名**。我第一版顺手写了个 `editingEngineName`，那个变量在这个
     * 项目里压根不存在（静默 undefined → 整条功能失效，还不报错）。 */
    const box = $('w-ceName');
    const name = box ? String(box.value || '').trim() : '';
    /* 名字还没填（用户在"先选应用、后起名"）：**把请求记下来**，
     * 等保存时再取 —— 见 `pendingAppIcon`。不这么做的话，这次选应用就白选了，
     * 用户还得重新点一次。 */
    if (!name) {
        pendingAppIcon = path;
        return;
    }
    applyAppIcon(name, path);
}

/** 真正去后端取图标（名字已经确定时调）。 */
function applyAppIcon(name, path) {
    if (!name || !path) return;
    // 已有手动图标 → 不覆盖（理由见上面 adoptAppIcon 的注释）
    const ov = (CONF && CONF.overrides) || {};
    if (ov[name]) return;
    invoke('app_icon_from_exe', { engine: name, exe: path }).catch(() => {});
}

function bindCeKind() {    const seg = $('s-ceKind');
    if (!seg) return;
    for (const b of seg.querySelectorAll('button')) {
        b.addEventListener('click', () => {
            ceKind = b.dataset.v === 'open' ? 'open'
                : b.dataset.v === 'hotkey' ? 'hotkey' : 'search';
            applyCeKind();
        });
    }
    applyCeKind();
}

/* ---- 快捷键录入：点「录制…」进入捕获态，下一个按键组合就是答案 ----
 * 和收藏夹唤起键（favHotkey）同一套交互：Esc 放弃、点到别处/窗口失焦自动退出。
 * 区别只在于录完往哪填：favHotkey 直接 invoke set_setting，这里填进表单输入框，
 * 等用户点「添加/保存」才真正落库（可能还在改名字呢）。 */
let ceRecArmed = false;
function ceRecDisarm() {
    if (!ceRecArmed) return;
    ceRecArmed = false;
    const b = $('btnCeRec');
    if (b) {
        b.textContent = '录制…';
        b.classList.remove('rec');
    }
}
$('btnCeRec').addEventListener('click', () => {
    ceRecArmed = !ceRecArmed;
    const b = $('btnCeRec');
    if (b) {
        b.textContent = ceRecArmed ? '请按下组合键…' : '录制…';
        b.classList.toggle('rec', ceRecArmed);
    }
    if (ceRecArmed) $('w-ceHotkey').focus();
});
// 捕获阶段的退路与 favHotkey 完全一致：点到别处、窗口失焦、按 Esc 都退出。
document.addEventListener('pointerdown', (e) => {
    if (ceRecArmed && e.target !== $('btnCeRec') && e.target !== $('w-ceHotkey')) ceRecDisarm();
}, true);
window.addEventListener('blur', ceRecDisarm);

/** 把一次 KeyboardEvent 归一成引擎按键序列（win::parse_hotkey 的词汇表）。
 *  修饰键固定按 ctrl+alt+shift+win 排序，主键名全部小写。 */
function ceComboFromEvent(e) {
    if (e.key === 'Escape') return null; // 由调用方处理成"放弃"
    const named = {
        Enter: 'enter', Tab: 'tab', ' ': 'space', Backspace: 'backspace',
        Delete: 'del', Insert: 'ins', Home: 'home', End: 'end',
        PageUp: 'pgup', PageDown: 'pgdn',
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        PrintScreen: 'prtsc', Pause: 'pause', CapsLock: 'capslock',
    };
    let main = null;
    if (/^[a-zA-Z]$/.test(e.key)) main = e.key.toLowerCase();
    else if (/^[0-9]$/.test(e.key)) main = e.key;
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) main = e.key.toLowerCase();
    else if (named[e.key]) main = named[e.key];
    else if (e.key.length === 1 && ",./;'[]\\-=`".includes(e.key)) main = e.key;
    // 单独按下一个修饰键（或只按 Win）不算组合，继续等
    if (!main) return '';
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('win');
    parts.push(main);
    return parts.join('+');
}

window.addEventListener('keydown', (e) => {
    if (!ceRecArmed) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { ceRecDisarm(); return; }
    const combo = ceComboFromEvent(e);
    if (!combo) return; // 只按了修饰键，继续等主键
    $('w-ceHotkey').value = combo;
    ceRecDisarm();
    $('ceHint').textContent = '已录入 ' + combo + '（点「添加/保存修改」生效）';
});

function renderCustomList() {
    const box = $('customList');
    box.textContent = '';
    const list = CONF.customEngines || [];

    if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有自定义引擎。在下面填上名字和搜索地址就能加一个。';
        box.appendChild(d);
        return;
    }

    list.forEach((ce, idx) => {
        const row = document.createElement('div');
        row.className = 'item' + (ceEditIndex === idx ? ' editing' : '');

        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.appendChild(iconNode(ce.name, 24));

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = ce.name;
        const em = document.createElement('em');
        em.textContent = ce.category || '自定义';
        nm.appendChild(em);
        // 类型徽标：搜 / 开 / 键（老配置没有 kind 字段 → 当搜索类，和 Rust 的默认一致）
        const kb = document.createElement('i');
        const ceK = (ce.kind === 'open' || ce.kind === 'hotkey') ? ce.kind : 'search';
        kb.className = 'kb' + (ceK === 'open' ? ' open' : ceK === 'hotkey' ? ' hot' : '');
        kb.textContent = ceK === 'open' ? '打开' : ceK === 'hotkey' ? '快捷键' : '搜索';
        kb.title = ceK === 'open'
            ? '打开类：不依赖选中的文字，点了直接打开这个页面'
            : ceK === 'hotkey'
                ? '快捷键类：点了把组合键发给前台软件'
                : '搜索类：拿选中的文字跳过去搜（地址带 %s）';
        nm.appendChild(kb);
        // 快捷键类显示组合键，另两类显示 URL（自定义引擎最容易记不清的就是
        // 「当初填的什么」—— 两类各露各的关键信息）
        const u = document.createElement('small');
        u.className = ceK === 'hotkey' ? 'chot' : 'curl';
        u.textContent = ceK === 'hotkey' ? (ce.hotkey || '') : ce.url;
        /* ⚠ 「空壳」记录：快捷键类没按键序列、其余类没地址 —— 这种定义干什么都不行，
         *   而且**横条上根本画不出来**（前端合并目录时按同一口径跳过它）。
         *   用户报的「设置里显示已在横条、横条里却没有」就是这种记录。
         *   这里当场标红说清楚，并且不给「加到横条」—— 免得再往横条里塞一颗幽灵
         *   （后端 `toggle_bar_engine` 也已经按同一口径拦了）。
         *   后端读配置时会把这类记录从横条/最近使用里**摘掉**、定义留着
         *   （config::repair_dead_custom_engines），所以正常情况下这里显示的是
         *   「可选但用不了」的状态 —— 把地址或按键补上就活。 */
        const usable = ceK === 'hotkey'
            ? !!(ce.hotkey || '').trim()
            : !!(ce.url || '').trim();
        if (!usable) {
            u.textContent = ceK === 'hotkey'
                ? '（没填按键序列 —— 这颗在横条上画不出来）'
                : '（没填地址 —— 这颗在横条上画不出来）';
            u.style.color = 'var(--danger, #E5484D)';
        }
        nm.appendChild(u);

        const ops = document.createElement('span');
        ops.className = 'ops';
        const mk = (text, title, fn) => {
            const b = document.createElement('button');
            b.className = 'mini';
            b.textContent = text;
            if (title) b.title = title;
            b.addEventListener('click', fn);
            ops.appendChild(b);
            return b;
        };

        const on = inBar(ce.name);
        mk('换图标', '从电脑里挑一张图片当图标', () => invoke('pick_icon', { engine: ce.name }));
        // #143「编辑图标」（和下面读表单的「编辑」区分开：一个是修图，一个是改配置）
        if (hasIconToEdit(ce.name, ce.name)) {
            mk('编辑图标', '编辑这颗图标：一键消除背景、前后对比',
                () => openIconEditor(ce.name, ce.name));
        }
        if (CONF.overrideIcons[ce.name]) {
            mk('默认图标', '恢复成首字母徽标', () => invoke('reset_icon', { engine: ce.name }));
        }
        /* 空壳记录不给「加到横条」：加进去也画不出来（见上面 usable 那段）。
         * 已经在横条里的，仍然给一颗「从横条移除」，让用户能自己把幽灵清掉。 */
        if (usable) {
            mk(on ? '已在横条' : '加到横条', on ? '从横条上移除' : '加到横条上',
                () => invoke('toggle_bar_engine', { engine: ce.name, on: !on }));
        } else if (on) {
            mk('从横条移除', '这条定义是空的（没地址/没按键），横条上本来也画不出来 —— 点这里把引用清掉',
                () => invoke('toggle_bar_engine', { engine: ce.name, on: false }));
        }
        mk('编辑', '把这个引擎读进下面的表单', () => fillCeForm(idx));
        // 删除做成「点一下变成确认、再点一下才真的删」。
        // 不用 window.confirm 是因为 WebView2 里的原生对话框不一定放行，
        // 而且原生对话框会打断拖拽之类的交互状态。
        const del = mk('删除', '连横条上的那一格一起删掉', () => {
            if (del.dataset.arm !== '1') {
                del.dataset.arm = '1';
                del.textContent = '确认删除？';
                del.classList.add('danger');
                clearTimeout(del._t);
                del._t = setTimeout(() => {
                    del.dataset.arm = '0';
                    del.textContent = '删除';
                    del.classList.remove('danger');
                }, 3000);
                return;
            }
            invoke('remove_custom_engine', { index: idx });
        });

        row.appendChild(ic);
        row.appendChild(nm);
        row.appendChild(ops);
        box.appendChild(row);
    });
}

/** 把第 idx 条读进表单，切到编辑模式 */
function fillCeForm(idx) {
    const ce = (CONF.customEngines || [])[idx];
    if (!ce) return;
    ceEditIndex = idx;
    $('w-ceName').value = ce.name;
    $('w-ceUrl').value = ce.url;
    $('w-ceCat').value = ce.category || '';
    $('w-ceHotkey').value = ce.hotkey || '';
    /* r58：绑定应用三件套回填（老配置没有这几个字段 → 关/空）。
     *
     * ⚠ 这里读的是 **snake_case**（`bind_app` / `app_path` / `app_admin`）：
     *   `config_view()` 是把 `cfg.custom_engines` **整个结构体**丢进 JSON 的，
     *   serde 用的是 Rust 字段名（snake_case）。而下面 `invoke(...)` 传的是
     *   **camelCase** —— Tauri 命令参数按那个口径映射。
     *   两个方向口径不同，很容易写错一个字母然后"存进去了但读不出来"，
     *   所以两边都在这里写明。 */
    $('w-ceBindApp').checked = !!ce.bind_app;
    $('w-ceAppPath').value = ce.app_path || '';
    $('w-ceAppAdmin').checked = !!ce.app_admin;
    /* r76：启动延迟回填。同样读 snake_case（`app_launch_delay`）。
     * 老配置没有这个字段 → 900（后端 serde default 也是 900），与升级前的
     * 写死行为一致。 */
    $('w-ceAppDelay').value = Number(ce.app_launch_delay) > 0 ? ce.app_launch_delay : 900;
    // r90：老配置没有这个字段 → undefined → false（默认不抢前台）
    $('w-ceBringFront').checked = ce.app_bring_front === true;
    // 类型读回那条引擎自己的 kind（老配置没这个字段 → 搜索类）
    ceKind = ce.kind === 'open' ? 'open' : ce.kind === 'hotkey' ? 'hotkey' : 'search';
    // 编辑老引擎：按它自己的类型选一种方式把表单放出来（keep=true 别重置刚填的字段）
    setAddWay(ceKind === 'hotkey' ? 'hotkey' : 'web', true);
    applyCeKind();
    $('btnCeSave').textContent = '保存修改';
    $('btnCeCancel').hidden = false;
    $('ceHint').textContent = '正在编辑「' + ce.name + '」';
    syncCeIcon();
    renderCustomList();
    $('w-ceName').focus();
    /* 滚到自定义引擎区让用户看到表单 —— 但 jsdom 没实现 scrollIntoView（也无意义），
     * 真机上才走这条。用 typeof 探一下，缺方法就别调。 */
    const sec = $('sec-custom');
    if (sec && typeof sec.scrollIntoView === 'function') {
        sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function resetCeForm() {
    ceEditIndex = -1;
    $('w-ceName').value = '';
    $('w-ceUrl').value = '';
    $('w-ceCat').value = '';
    $('w-ceHotkey').value = '';
    // r58：绑定应用也要清干净 —— 留着上一条的路径，下一条引擎会"莫名其妙
    // 绑了一个别家的应用"，而且这种错在界面上看着像是自己勾上去的。
    $('w-ceBindApp').checked = false;
    $('w-ceAppPath').value = '';
    $('w-ceAppAdmin').checked = false;
    // r76：启动延迟拨回默认 900（不是 0 —— 见 submitCeForm 里的同款注释）
    $('w-ceAppDelay').value = 900;
    // r90：新引擎默认"不把窗口调到前台"
    $('w-ceBringFront').checked = false;
    /* r88：表单清空时也要把"待取图标"那个待办清掉 ——
     * 不然用户取消/重置之后，下一次提交会把**上一条**引擎选的图标挂到
     * 新引擎上（串味，而且界面上看不出来）。 */
    pendingAppIcon = '';
    // 新增默认搜索类（历史行为：自定义引擎一直是要带 %s 的搜索入口）
    ceKind = 'search';
    applyCeKind();
    $('btnCeSave').textContent = '添加';
    $('btnCeCancel').hidden = true;
    $('ceHint').textContent = '';
    syncCeIcon();
}

/** 表单旁边那枚图标预览：编辑已有引擎时把它的图标显示出来，
 *  新建时（还没有名字）就收起来。 */
function syncCeIcon() {
    const img = $('ceIconPrev');
    if (!img) return;
    const key = (ceEditIndex >= 0 && (CONF.customEngines || [])[ceEditIndex])
        ? CONF.customEngines[ceEditIndex].name
        : '';
    const src = key && CONF.overrideIcons ? CONF.overrideIcons[key] : '';
    img.src = src || '';
    img.hidden = !src;
}

/* 给自定义引擎挑图标。
 * 新引擎得先有名字才能挂图标（图标是按引擎名存的），所以这里要求先填名字：
 * 新建时就先把它存下来，再弹文件框；已存在的引擎直接选。 */
$('btnCeIcon').addEventListener('click', async () => {
    const hint = $('ceHint');
    let name = '';
    if (ceEditIndex >= 0 && (CONF.customEngines || [])[ceEditIndex]) {
        name = CONF.customEngines[ceEditIndex].name;
    } else {
        name = $('w-ceName').value.trim();
        if (!name) {
            hint.textContent = '先填个名字，再挑图标';
            $('w-ceName').focus();
            return;
        }
    }
    hint.textContent = '正在打开文件选择…';
    await invoke('pick_icon', { engine: name }).catch(() => {});
});

async function submitCeForm() {
    const name = $('w-ceName').value;
    const url = $('w-ceUrl').value;
    const category = $('w-ceCat').value;
    // 快捷键类：地址框是收起来的，提交时传空串；组合键才是它的"地址"
    const hotkey = $('w-ceHotkey').value;
    /* r58：绑定应用三件套。非快捷键类一律传"关/空" —— 后端也会再强制一次，
     * 但前端先归一能省掉一次"存进去又被后端清掉"的困惑。
     * r76：第四件 appLaunchDelay（启动应用 → 发键之间等多久），同理逐引擎独立。 */
    const isHot = ceKind === 'hotkey';
    const bindApp = isHot && $('w-ceBindApp').checked;
    const appPath = isHot ? $('w-ceAppPath').value : '';
    const appAdmin = isHot && $('w-ceAppAdmin').checked;
    /* r90：要不要把目标应用的主窗口调到前台（每个快捷键引擎独立） */
    const appBringFront = isHot && $('w-ceBringFront').checked;
    // 延迟：不传 0 兜底，而是传**默认 900** —— 那是 r60 起"新拉起的应用多等一拍"
    // 的既有行为，用户没动过这个框时不该悄悄变成 0（会退回到"键打空"的老 bug）。
    const appLaunchDelay = (isHot && bindApp)
        ? Math.max(0, Math.min(60000, Math.round(Number($('w-ceAppDelay').value) || 900)))
        : 0;
    const editing = ceEditIndex >= 0;
    /* r88：如果用户是"先选应用、后起名字"，那份取图标的请求记在
     * `pendingAppIcon` 里 —— 现在名字确定了，补上它。
     * ⚠ 只对快捷键类做：非快捷键类没有"绑定应用"这回事，那个路径框
     *   本来也不会被填。 */
    if (isHot && pendingAppIcon && name.trim()) {
        applyAppIcon(name.trim(), pendingAppIcon);
        pendingAppIcon = '';
    }
    try {
        if (editing) {
            await invoke('update_custom_engine', {
                index: ceEditIndex, name, url, category, kind: ceKind, hotkey,
                bindApp, appPath, appAdmin, appLaunchDelay, appBringFront,
            });
            toast('已保存');
        } else {
            await invoke('add_custom_engine', {
                name, url, category, kind: ceKind, hotkey,
                bindApp, appPath, appAdmin, appLaunchDelay, appBringFront,
            });
            toast('已添加「' + name.trim() + '」');
        }
        // 加完/改完都收回表单，回到方式选择那一层
        if (!editing) afterAddDone(addWay);
        else resetCeForm();
    } catch (e) {
        // Rust 那边返回的是给人看的中文提示，直接展示在表单下面
        $('ceHint').textContent = String(e);
    }
}

/* ------------------------------------------------------------------ */
/* 外部软件（把第三方应用加成横条上一颗图标）                            */
/* ------------------------------------------------------------------ */

/* 表单当前在编辑哪一条：null = 新增；否则是那条的 id。
   和自定义引擎的 ceEditIndex 一个套路，但按 id 记 —— app 的键是 id 不是下标
   （删掉中间一条后下标会错位，编辑就会写到别的软件头上）。 */
let apEditId = null;

/** 外部软件那一格的图标：和横条真身共用 shared.js 的实现。 */
function appRowIcon(ap) {
    return qsAppIconNode(QS_APP_PREFIX + ap.id);
}

/** 「外部软件」页的一整行（换图标 / 固定到横条 / 试一下 / 编辑 / 删除）。
 *  从 renderAppList 里抽出来：#136 之后行按「软件搜索 / 软件直达」分节渲染，
 *  遍历结构变了，行本身的构造不该跟着变。 */
function appManageRow(ap) {
    const sentinel = QS_APP_PREFIX + ap.id;
    const on = inBar(sentinel);
    const row = document.createElement('div');
    row.className = 'item' + (apEditId === ap.id ? ' editing' : '');

    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.appendChild(appRowIcon(ap));

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = ap.name;
    const em = document.createElement('em');
    em.textContent = on ? '已在横条' : '没在横条上';
    nm.appendChild(em);
    // #135 类型徽标：搜索 = accent 色「搜索」，打开 = teal「打开」。
    // 和网页引擎的 .kb 同一套样式 —— 软件引擎点下去做的事也分两样，
    // 列表里必须一眼看出哪条会拿选中的词去搜、哪条是直接打开。
    const apKind = qsAppKind(ap);
    const kb = document.createElement('i');
    kb.className = 'kb' + (apKind === 'search' ? '' : ' open');
    kb.textContent = apKind === 'search' ? '搜索' : '打开';
    kb.title = apKind === 'search'
        ? '软件搜索：拿选中的词交给这个软件搜（地址里带 %s）'
        : '软件直达：点一下直接打开这个地址';
    nm.appendChild(kb);
    // 把地址也露出来：和自定义引擎一个理由 —— 最容易忘的就是当初填的什么
    const u = document.createElement('small');
    u.className = 'curl';
    u.textContent = ap.url;
    nm.appendChild(u);

    const ops = document.createElement('span');
    ops.className = 'ops';
    const mk = (text, title, fn) => {
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = text;
        if (title) b.title = title;
        b.addEventListener('click', fn);
        ops.appendChild(b);
        return b;
    };

    mk('换图标', '从电脑里挑一张图片当图标', () => invoke('pick_icon', { engine: sentinel }));
    // #143「编辑图标」（和下面读表单的「编辑」分开）：按**软件名**找默认图
    if (hasIconToEdit(sentinel, ap.name)) {
        mk('编辑图标', '编辑这颗图标：一键消除背景、前后对比',
            () => openIconEditor(sentinel, ap.name));
    }
    if (CONF.overrideIcons[sentinel]) {
        mk('默认图标', '恢复成首字徽标', () => invoke('reset_icon', { engine: sentinel }));
    }
    mk(on ? '已在横条' : '固定到横条', on ? '从横条上移除' : '固定到横条末尾',
        () => invoke('toggle_bar_engine', { engine: sentinel, on: !on }));
    // 「试一下」：马上打开这个地址。填错协议 / 程序没装时这里立刻能看见
    // 失败原因，不用等用户去点横条上那一格才发现点不动。
    // ⚠ mk 只收 (text, title, fn) 三参 —— 曾经照 renderBarList 的四参形式
    // 多写了一个 ''，点击回调被顶掉、点「试一下」什么都不会发生。
    // 搜索类（#135）没有选中文字可带，塞一个「测试」当占位词 —— 不然
    // 后端会拿"先选中文字"打回来，用户在设置页试不出到底填对没填对。
    mk('试一下', '马上打开这个地址，看填得对不对',
        () => invoke('open_app', { id: ap.id, text: apKind === 'search' ? '测试' : null })
            .then(() => toast('已交给系统打开「' + ap.name + '」'))
            .catch((e) => toast('打不开：' + String(e || '未知错误').slice(0, 60))));
    mk('编辑', '把这个软件读进上面的表单', () => fillAppForm(ap.id));
    // 删除同样是「点一下变确认、再点一下才真删」（不用原生 confirm）
    const del = mk('删除', '连横条上的那一格一起删掉', () => {
        if (del.dataset.arm !== '1') {
            del.dataset.arm = '1';
            del.textContent = '确认删除？';
            del.classList.add('danger');
            clearTimeout(del._t);
            del._t = setTimeout(() => {
                del.dataset.arm = '0';
                del.textContent = '删除';
                del.classList.remove('danger');
            }, 3000);
            return;
        }
        invoke('remove_app', { id: ap.id });
    });

    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(ops);
    return row;
}

function renderAppList() {
    const box = $('appList');
    box.textContent = '';
    const list = CONF.apps || [];

    if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有外部软件。到上面的「添加引擎」选「软件引擎」就能加一个。';
        box.appendChild(d);
        return;
    }

    /* #136：和「全部引擎」完全相同的分组交互 —— 一个「外部软件」大类块
     * （标题行可点，收起/展开），里面按 #135 的类型分「软件搜索 / 软件直达」
     * 两节。外壳、类名全部复用 .eng-grp 一家，两边样子才对得上。 */
    const { blk, body } = engGroupShell('app', '外部软件', '共 ' + list.length + ' 个',
        appGroupOpen, () => { appGroupOpen = !appGroupOpen; renderAppList(); });
    /* ⚠ 收起时 body 是 null（外壳故意不建）—— 必须先判再往里塞。
     * 以前无条件 append，点一下「外部软件」标题就 TypeError，
     * 而 box.textContent='' 已经执行完 → 整个列表被清空成白板
     * （round30 D11：shut=null body=0）。renderAllList 同位置有
     * if (open) 护栏，这里是漏了那一道。 */
    if (body) {
        for (const subKey of ['appsearch', 'appopen']) {
            const sub = list.filter((ap) =>
                (qsAppKind(ap) === 'search' ? 'appsearch' : 'appopen') === subKey);
            if (!sub.length) continue;
            const st = document.createElement('div');
            st.className = 'eng-sub-h';
            st.textContent = ALL_SUB_FALLBACK[subKey];
            body.appendChild(st);
            const ls = document.createElement('div');
            ls.className = 'list';
            for (const ap of sub) ls.appendChild(appManageRow(ap));
            body.appendChild(ls);
        }
    }
    box.appendChild(blk);
}

/** 软件表单的类型分段（#135）：当前选中 'open' / 'search'。
 *  新软件默认「打开」—— 大多数外部软件就是"点一下打开它"；搜索类才需要
 *  用户在地址里写 %s，是少数情况。 */
function apKind() {
    const seg = $('s-apKind');
    const on = seg && seg.querySelector('button.on');
    return (on && on.dataset.v) || 'open';
}

function setApKind(v) {
    const seg = $('s-apKind');
    if (!seg) return;
    for (const b of seg.querySelectorAll('button')) {
        b.classList.toggle('on', b.dataset.v === v);
    }
    syncApKindUI();
}

/** 类型一切换，地址框的占位符和说明跟着换：搜索类要提醒写 %s。 */
function syncApKindUI() {
    const url = $('w-apUrl');
    const note = $('apKindNote');
    if (apKind() === 'search') {
        if (url) url.placeholder = '软件自己的搜索地址，用 %s 标出搜索词，例如：weixin://search?q=%s';
        if (note) note.innerHTML = '搜索：拿选中的词交给这个软件搜 —— 地址里必须带 <b>%s</b>（它代表选中的文字），没有选中文字时点了会提示先选中';
    } else {
        if (url) url.placeholder = 'https://… / weixin://… / file:///C:/…/app.exe';
        if (note) note.innerHTML = '打开：点一下直接打开这个地址（不要求选中文字）· 搜索：拿选中的词交给这个软件搜，地址里用 <b>%s</b> 标出搜索词的位置';
    }
}

/** 把第 id 条读进表单，切到编辑模式 */
function fillAppForm(id) {
    const ap = (CONF.apps || []).find((a) => a.id === id);
    if (!ap) return;
    apEditId = id;
    $('w-apName').value = ap.name;
    $('w-apUrl').value = ap.url;
    setApKind(qsAppKind(ap));
    $('btnApSave').textContent = '保存修改';
    $('btnApCancel').hidden = false;
    $('apHint').textContent = '正在编辑「' + ap.name + '」';
    syncAppIcon();
    // 表单现在住在「添加引擎」卡片里：选「软件引擎」方式把它放出来
    setAddWay('app', true);
    renderAppList();
    $('w-apName').focus();
    const sec = $('sec-custom');
    if (sec && typeof sec.scrollIntoView === 'function') {
        sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function resetAppForm() {
    apEditId = null;
    $('w-apName').value = '';
    $('w-apUrl').value = '';
    setApKind('open');
    $('btnApSave').textContent = '添加';
    $('btnApCancel').hidden = true;
    $('apHint').textContent = '';
    syncAppIcon();
}

/** 表单旁边那枚图标预览：编辑已有软件时把它的图标显示出来；新建时收起。 */
function syncAppIcon() {
    const img = $('apIconPrev');
    if (!img) return;
    const src = apEditId && CONF.overrideIcons
        ? CONF.overrideIcons[QS_APP_PREFIX + apEditId] : '';
    img.src = src || '';
    img.hidden = !src;
}

/* 给外部软件挑图标。
 * ⚠ 图标是按 id 存的（`@app:<id>`），而**新建时还没有 id** —— 所以新建态
 * 不能挑图标，得先点「添加」保存、回来再挑。编辑态（apEditId 有值）直接挑。
 * 这和自定义引擎「先填名字再挑」是同一种约束，只是那边按名字存、这边按 id 存。 */
$('btnApIcon').addEventListener('click', async () => {
    const hint = $('apHint');
    if (!apEditId) {
        hint.textContent = '先点「添加」把它保存下来，再回来挑图标';
        return;
    }
    hint.textContent = '正在打开文件选择…';
    await invoke('pick_icon', { engine: QS_APP_PREFIX + apEditId }).catch(() => {});
});

async function submitAppForm() {
    const name = $('w-apName').value;
    const url = $('w-apUrl').value;
    const kind = apKind();
    const editing = !!apEditId;
    try {
        if (editing) {
            await invoke('update_app', { id: apEditId, name, url, kind });
            toast('已保存');
            resetAppForm();
        } else {
            await invoke('add_app', { name, url, kind });
            toast('已添加「' + name.trim() + '」并固定到横条');
            // 加完收回表单，回到方式选择那一层
            afterAddDone('app');
        }
    } catch (e) {
        // Rust 那边返回的是给人看的中文提示，直接展示在表单下面
        $('apHint').textContent = String(e);
    }
}

/* 软件类型分段的点击（#135）：只切 UI 状态，类型在提交时随表单一起写库。
 * 挂在初始化那一波绑定里（和 SEGS 同一时机），不重复绑。 */
function bindApKind() {
    const seg = $('s-apKind');
    if (!seg || seg.dataset.bound === '1') return;
    seg.dataset.bound = '1';
    for (const b of seg.querySelectorAll('button')) {
        b.addEventListener('click', () => {
            for (const x of seg.querySelectorAll('button')) x.classList.toggle('on', x === b);
            syncApKindUI();
        });
    }
    syncApKindUI();
}

/* ------------------------------------------------------------------ */
/* AI 工具：每个 AI 一个提问后缀输入框                                  */
/* ------------------------------------------------------------------ */

function aiEngines() {
    const c = CATALOG.categories.find((x) => x.title.indexOf('AI') >= 0);
    return c ? c.engines.map((e) => e.name) : [];
}

function renderAiList() {
    const box = $('aiList');
    box.textContent = '';
    const own = CONF.aiSuffixes || {};
    const dflt = CONF.aiSuffix || '';

    for (const name of aiEngines()) {
        const row = document.createElement('div');
        row.className = 'item';

        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.appendChild(iconNode(name, 22));

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = name;

        const inp = document.createElement('input');
        inp.className = 'sfx' + (own[name] !== undefined ? ' own' : '');
        inp.spellcheck = false;
        inp.value = own[name] !== undefined ? own[name] : '';
        inp.placeholder = dflt || '（默认后缀，留空则不加）';
        inp.title = '这个 AI 专属的提问后缀；清空就用上面的默认后缀';
        // 只在失焦 / 回车时提交，不然每敲一个字都写一次配置
        const commit = () => invoke('set_setting', {
            key: 'aiSuffixOf',
            value: { engine: name, suffix: inp.value }
        });
        inp.addEventListener('change', commit);
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { inp.blur(); }
        });

        row.appendChild(ic);
        row.appendChild(nm);
        row.appendChild(inp);
        box.appendChild(row);
    }
}

/* ------------------------------------------------------------------ */
/* 开关 / 滑块 / 分段 / 文本框                                          */
/* ------------------------------------------------------------------ */

const SWITCHES = [
    ['s-triggerSelect', 'triggerSelect'],
    ['s-triggerCopy', 'triggerCopy'],
    // 2026-10-23：划选没取到文字就不弹（误触乱弹的主要来源，默认开）
    // 2026-10-24：只管划选 —— Ctrl+C 一定弹，见 main.rs 的 ctrl_copy_bar
    ['s-barNeedText', 'barNeedText'],
    ['s-anchorAtMouse', 'anchorAtMouse'],
    ['s-autoStart', 'autoStart'],
    ['s-autoElevate', 'autoElevate'],
    ['s-unifyIcons', 'unifyIcons'],
    ['s-animations', 'animations'],
    ['s-shadow', 'shadow'],
    ['s-aiCopyPrompt', 'aiCopyPrompt'],
    ['s-ocrEnable', 'ocrEnable'],
    // v1.5.16：翻译总开关。默认**开**（与 config.rs 的 default_true 一致）——
    // 真正的入口是横条上的 @trans 哨兵，用户不加进横条就看不见按钮。
    ['s-transEnable', 'transEnable'],
    // v1.2.0：自动更新。⚠ 它不在「通用」页，而在「关于」页的更新区块里 ——
    // 但走同一张表、同一套绑定逻辑（少写一套状态同步）。
    ['s-autoUpdate', 'autoUpdate'],
    // r54 识图搜索。两个开关都**默认开**：用户这一批专门要了这个功能，
    // 开机就该能用（与 config.rs 的 default_true 一致）
    ['s-imgEnable', 'imgEnable'],
    ['s-imgAddToBar', 'imgAddToBar'],
    // r73：框完的图要不要留在剪贴板（默认关 = 用完就撤、还原原内容）
    ['s-imgKeepClip', 'imgKeepClip'],
    // r76：AI 识图 —— AI 优先 + 勾多家时自动关掉按键。两条都默认开
    // （用户要的就是"AI 先弄完再开别家""多家别乱按键"），这里给的是关掉的路。
    ['s-imgAiFirst', 'imgAiFirst'],
    ['s-imgAiAutoOff', 'imgAiAutoOffOnMulti'],
    // ⚠ r47：这里原来有一行 ['s-ocrParallel', 'ocrParallel']（双引擎并行开关）。
    //   用户要求删掉那个开关，改成「同时识别」多选 —— 名单走 ocr_set_multi，
    //   不是布尔开关，所以不在这张表里。ocrParallel 字段本身只用于老配置迁移
    //   （见 config.rs 的 sanitize）。
    // OCR 文本整理的默认开关（需求 7）。⚠ 语义：这里定的是"每次识别默认怎么
    // 整理"，结果页那几颗按钮点的是"这一轮"的临时覆盖，不会改这里。
    // r49：「结果窗固定在默认引擎」开关。默认**开** —— 用户口径是"不准自作主张
    // 跳到别家引擎"，所以老配置（没有这个键）也当开（见 config.rs 的 default_true）。
    ['s-ocrStayDefault', 'ocrStayDefault'],
    ['s-ocrCleanGarbage', 'ocrCleanGarbage'],
    ['s-ocrCleanWidth', 'ocrCleanWidth'],
    ['s-ocrCleanUnwrap', 'ocrCleanUnwrap'],
    ['s-webdavOnStart', 'webdavOnStart'],
    ['s-webdavOnExit', 'webdavOnExit'],
    // 液态玻璃一组：实时折射（总开关已被「横条样式」三分段取代）
    ['s-barGlassLive', 'barGlassLive'],
    /* r80：AI 抠图总开关（图标编辑器功能的开关）。
     *
     * ⚠ 它**必须**在这张表里，不能自己手写 change 监听 ——
     *   这张表统一负责「回填初值 / 写配置 / 广播 / 同步 CONF」四件事。
     *   第一版我漏了这一步，自己在 `aiBindSwitch` 里绑 change，
     *   结果探针抓到「点了开关但 CONF.aiMattingEnable 仍是 false」——
     *   命令确实写库了，但页面内的 CONF 没更新，
     *   于是「编辑图标」按钮不出现（`iconEditorEnabled()` 读的是 CONF）。
     *   教训：这张表就是这个页面的开关唯一入口，新开关一律加进来。 */
    ['s-aiMatting', 'aiMattingEnable'],
];

const SWITCH_DEFAULT = {
    ocrStayDefault: true,   // r49：缺省"固定在默认引擎那一档"
    ocrCleanGarbage: false,
    ocrCleanWidth: false,
    ocrCleanUnwrap: false,
    triggerSelect: true,
    triggerCopy: true,
    // 2026-10-23：划选没取到文字就不弹（与 config.rs 的 serde 默认值一致）
    barNeedText: true,
    anchorAtMouse: false,
    autoStart: false,
    autoElevate: true,
    unifyIcons: true,
    animations: true,
    shadow: false,
    aiCopyPrompt: true,
    ocrEnable: true,
    // v1.5.16：翻译默认开（老配置没有这个键时也当开，见 config.rs default_true）
    transEnable: true,
    // v1.2.0：自动更新默认**开**。功能名就叫"自动更新"，默认不勾等于默认没这功能；
    // 用户取消勾选后彻底不检测（见 main.rs 的 auto_check_on_start）。
    autoUpdate: true,
    // r54：识图搜索默认开着、默认加到横条（与 config.rs 的 default_true 对齐）
    imgEnable: true,
    imgAddToBar: true,
    // r76：AI 识图两条默认开（理由见上面 SWITCHES 表里的注释）
    imgAiFirst: true,
    imgAiAutoOffOnMulti: true,
    // r76：两段延迟的默认值。与 config.rs 的 default_ai_* 对齐 ——
    // 1200/900 也是 r76 之前写死在 Rust 里的那两个数，升级上来的用户观感不变。
    imgAiPasteDelay: 1200,
    imgAiEnterDelay: 900,
    // r47：「同时识别」名单（默认引擎之外的、要一起跑的那几家）。
    // 默认**空** = 只跑默认引擎一家 —— 用户点名要的正是这个：
    // 「就算我打开了（多引擎），也要我把本地的识别引擎添加在多引擎识别里面，
    //   它才可以」。老的 ocrParallel 开关已删（老配置的迁移在 config.rs）。
    ocrMulti: [],
    webdavOnStart: false,
    webdavOnExit: false,
    barGlassLive: false,
};

/* ==========================================================================
 * 横条样式三主题（默认 / 磨砂 / 液态玻璃）
 *
 * 刻意**不新增配置字段**，三态由既有字段推导：
 *   glass  = barGlass 开（横条抓桌面做 WebGL2 真折射）
 *   frost  = barGlass 关且 barBlur > 0（backdrop-filter 磨砂）
 *   default= 两者都关（纯色底板）
 * 这样老 config.json 零迁移，bar.css / bar.js / glass.js 的既有链路
 * 一行都不用动。设置页按推导结果显示当前主题的配置行，其余行隐藏。
 * ========================================================================== */
function qsBarStyle(c) {
    if (c && c.barGlass) return 'glass';
    return (c && Number(c.barBlur) || 0) > 0 ? 'frost' : 'default';
}

function syncStyleUI() {
    const st = qsBarStyle(CONF);
    const seg = $('s-barStyle');
    if (seg) {
        for (const b of seg.querySelectorAll('button')) {
            b.classList.toggle('on', b.dataset.v === st);
        }
    }
    for (const el of document.querySelectorAll('[data-style]')) {
        el.hidden = el.dataset.style !== st;
    }
    /* r95：切样式也要重刷帧率那一行。
     *
     * `data-style` 那轮循环只会把 `rowGlassFps` 设为**可见**（玻璃样式下），
     * 而它的最终可见性还有第二个条件（实时折射开着没）—— 那条件由
     * `syncGlassFpsUI` 判。以前只有「开关实时折射」才会调它，于是
     * 「玻璃+实时折射开着 → 切到默认/磨砂」这条路把帧率行留在了界面上：
     * 默认/磨砂下玻璃画布不跑，这一行的四个按钮全是无效的。
     *
     * ⚠ 必须排在 data-style 循环**之后** —— 反了会被那边改回可见。 */
    syncGlassFpsUI();
    // 玻璃参数预设的高亮跟着配置走（拖过滑块就变成「自定义」）
    syncGlassPreset();
}

/* v1.5.4：弹出位置控件跟着「横条跟随鼠标位置」联动。
 *
 * 贴鼠标弹的时候压根没有"文字在哪"（Ctrl+C 那条路也一样），选上方/下方
 * 没有意义 —— 此时把控件置灰，省得用户以为选了没生效。
 * 三种时机都要刷：首屏绑定、开关变化、后端广播回来。 */
function syncBarPosUI() {
    const seg = $('s-barPos');
    if (!seg) return;
    const off = !!CONF.anchorAtMouse;
    seg.classList.toggle('off', off);
    for (const b of seg.querySelectorAll('button')) b.disabled = off;
}

/* ==========================================================================
 * 液态玻璃参数预设（#129）
 *
 * 六个滑块（折射 / 厚度 / 色差 / 高光 / 染色 / 内部磨砂）单独调很难一次
 * 调出好看的一整套，这里给两档「一键全套」（#150 删掉了原来的「深度」）：
 *   light    轻量：折射弱、高光低，老机器 / 集成显卡也流畅
 *   standard 标准：默认那套，最像真玻璃
 *   custom   自定义：六个值不全命中任何一档就是它（默认态）
 *
 * 刻意**不含** barGlassLive（实时折射）—— 那是开销开关不是外观参数，
 * 不随预设变，用户开了就留着。命中判定是「六个值全中」，任一不同即自定义，
 * 所以预设永远只是快捷方式，不会和手动调节打起来。
 * #150：老配置里存的深度参数不会丢，只是再没有对应档位，照样显示「自定义」。
 * ========================================================================== */
const GLASS_PRESETS = [
    /* #133 质感重调：用户原话「不够透、折射差」。两档整体加强 ——
     *   折射（边缘扭曲）和厚度（边缘放大）是"像不像厚玻璃"的主线索；
     *   高光给到能看出镜面反光的量；染色略升让本体有"玻璃有感"的通透；
     *   内部磨砂 light 档从 0 改成 1 —— 完全清亮的玻璃在花桌面上一片糊，
     *   一点点内部磨砂反而更像真玻璃（真玻璃也极少全透明）。 */
    { key: 'light', values: { barGlassRefraction: 18, barGlassBevel: 10, barGlassAberration: 30, barGlassSpec: 70, barGlassTint: 10, barGlassFrost: 1 } },
    { key: 'standard', values: { barGlassRefraction: 30, barGlassBevel: 18, barGlassAberration: 50, barGlassSpec: 110, barGlassTint: 14, barGlassFrost: 2 } },
];

/** 当前配置命中哪个预设；六个值全中才算，任一不同即「自定义」。 */
function currentGlassPreset() {
    for (const p of GLASS_PRESETS) {
        let all = true;
        for (const k of Object.keys(p.values)) {
            if (Number(CONF[k] || 0) !== p.values[k]) { all = false; break; }
        }
        if (all) return p.key;
    }
    return 'custom';
}

function syncGlassPreset() {
    const seg = $('s-glassPreset');
    if (!seg) return;
    const cur = currentGlassPreset();
    for (const b of seg.querySelectorAll('button')) {
        b.classList.toggle('on', b.dataset.v === cur);
    }
}

/** 点预设：六个参数**一次**写库（set_settings 批量命令，一次保存一次广播）。
 *
 *  ⚠ 以前是六个 set_setting 一人一次广播 —— 每次广播回来 syncGlassPreset
 *    都会重算，写到一半的中间状态（比如折射已改、高光未改）谁都不命中，
 *    于是「自定义」会**闪一下**再跳回目标档。用户报「点预设时自定义闪一下」。
 *    现在批量一次落库，广播只有一份、且已是终态，不会再闪。 */
function bindGlassPreset() {
    const seg = $('s-glassPreset');
    if (!seg) return;
    for (const b of seg.querySelectorAll('button')) {
        b.addEventListener('click', () => {
            const p = GLASS_PRESETS.find((x) => x.key === b.dataset.v);
            if (!p) return;   // 「自定义」只是状态显示，点了不做事
            const pairs = Object.keys(p.values).map((k) => [k, p.values[k]]);
            // 立刻生效：不等后端广播回来（广播到达时 renderPreview 还会再画一次，
            // 两次都是终态，不会出现中间态闪烁）
            for (const [k, v] of pairs) CONF[k] = v;
            invoke('set_settings', { pairs }).catch(() => {});
            syncGlassPreset();
        });
    }
}

/** 点三分段：一次改动写两个既有键（barGlass / barBlur）。
 *  · 默认：两个都关；
 *  · 磨砂：关玻璃、磨砂强度没设过就给 12（低档位就能看出效果）；
 *  · 玻璃：开玻璃、磨砂强度**原样保留** —— 面板和右键菜单的磨砂吃的
 *    还是这个值（CSS 只把 .bar 自己的 backdrop-filter 让位给玻璃画布），
 *    从磨砂主题切过来的用户面板观感不变。 */
function bindBarStyle() {
    const seg = $('s-barStyle');
    if (!seg) return;
    for (const b of seg.querySelectorAll('button')) {
        b.addEventListener('click', () => {
            const v = b.dataset.v;
            const glass = v === 'glass';
            let blur = 0;
            if (v === 'frost') blur = Number(CONF.barBlur) > 0 ? Number(CONF.barBlur) : 12;
            Object.assign(CONF, { barGlass: glass, barBlur: blur });
            syncStyleUI();
            renderPreview();
            /* ⚠ 一次写完两个键。
             *   以前是两条 `set_setting`，每条各自 save + 广播 ——
             *   「磨砂→玻璃」「玻璃→默认」都会广播出一个中间态，
             *   syncStyleUI 按 qsBarStyle(CONF) 推导时会闪一下
             *   （文件里 2613 行那段注释说的就是这个病，这里是漏改的一处）。 */
            invoke('set_settings', {
                pairs: [['barGlass', glass], ['barBlur', blur]],
            }).catch(() => {});
        });
    }
}

const SEGS = [
    // v1.5.13：界面语言（简体中文 / English）。走泛型通路：值是字符串，
    // 后端 apply_one_setting 会过 config::normalize_ui_lang。
    ['s-uiLang', 'uiLang', 'zh'],
    // 「图标风格」已撤：有图标用图标、没有用字母徽标，是唯一逻辑（用户要求）
    ['s-filterMode', 'filterMode', 'off'],
    ['s-sepStyle', 'sepStyle', 'line'],
    ['s-ocrLang', 'ocrLang', 'CHN_ENG'],
    // ⚠ 识别引擎不再是 seg（需求 2）：在线引擎有十几家，seg 排不下。
    //   现在是引擎列表（#w-ocrEngList），由 renderOcrEngines() 按后端注册表生成。
    // 默认 0 = 标准版。默认给高精度会让没开通付费的账号一识别就报错，
    // 而报错信息（余额不足/无权限）在用户看来跟「Key 不对」没区别，非常难自查。
    ['s-ocrAccurate', 'ocrAccurate', '0'],
    // 空格档位三态（需求 7）：不动 / 智能 / 强力
    ['s-ocrCleanSpace', 'ocrCleanSpace', 'smart'],
    ['s-theme', 'theme', 'system'],
    // v1.5.4：横条弹出位置（文字上方 / 下方）。字符串值，正好走 SEGS 泛型通路；
    // 后端白名单在 config::normalize_bar_pos（脏值归一成 above）。
    ['s-barPos', 'barPos', 'above'],
];

/* r56：「最近使用」最多摆几个。**不走 SEGS** —— 那个泛型通路把 data-v 当字符串
 * 原样发给后端，而 recentMax 在 Rust 那边是 usize（`value.as_u64()`），
 * 收到 "10" 这种字符串会解析失败、静默退回默认 10。用户选了 20 结果摆 10 个，
 * 就是这个坑。所以这里自己发**数字**。
 *
 * 四档与后端 normalize_recent_max 的白名单一一对应（5/10/15/20），
 * 改一边另一边要跟着改 —— 那边注释里写着了。 */
const RECENT_MAX_CHOICES = [5, 10, 15, 20];

/* v1.3.0：实时折射的**刷新帧率上限**。
 *
 * # 为什么要单独写而不进 SEGS
 *
 * 和 `recentMax` 同一个理由：SEGS 的泛型通路把 `data-v` 当**字符串**发给后端，
 * 而 `barGlassFps` 在 Rust 那边是 u32（走 `value.as_u64()`），收到 "30" 这种
 * 字符串会解析失败、静默退回默认值 —— 用户选了「30」结果还是跟着显示器。
 * 所以这里自己发**数字**。
 *
 * # 各档位的代价（**实测**，详见 config.rs 里那段表）
 *
 * 抓屏里的 BitBlt 有约 6ms 的**固定开销、与抓取面积无关**（实测 16×16 与
 * 852×176 都是 6.24ms），所以频率直接换算成单核占用：
 *   30 → 19%    60 → 37%    120 → 75%    跟随显示器(实测85) → 53%
 *
 * 默认 30（后端 config.rs 里也是 30）：够跟手，又压在合理范围。
 *
 * ⚠ 后端 `set_setting` 对 barGlassFps 做了白名单夹取（只认 0/30/60/120），
 *   这里列的档位必须和那边一致，改一边要改另一边。 */
const GLASS_FPS_CHOICES = [0, 30, 60, 120];
function bindGlassFps() {
    const seg = $('segGlassFps');
    if (!seg) return;
    for (const b of seg.querySelectorAll('button')) {
        b.addEventListener('click', () => {
            const v = Number(b.dataset.v);
            for (const x of seg.querySelectorAll('button')) x.classList.toggle('on', x === b);
            CONF.barGlassFps = v;
            window.CONF.barGlassFps = v;
            /* 发数字（不是字符串）。后端白名单夹取会再兜一层。 */
            invoke('set_setting', { key: 'barGlassFps', value: v }).catch(() => {});
        });
    }
}

/** 把帧率档位的高亮同步到当前配置，并决定那一行的显隐。
 *  ⚠ 必须**容错**：配置里可能是老版本没有这个键（undefined），
 *    也可能是个白名单外的值（手改配置）。两种都当 30（默认档）。 */
function syncGlassFpsUI() {
    const seg = $('segGlassFps');
    if (!seg) return;
    const raw = Number(CONF && CONF.barGlassFps);
    const cur = GLASS_FPS_CHOICES.includes(raw) ? raw : 30;
    for (const b of seg.querySelectorAll('button')) {
        b.classList.toggle('on', Number(b.dataset.v) === cur);
    }
    /* r95：这一行要**两个条件同时成立**才显示：
     *   ① 当前是「液态玻璃」样式；
     *   ② 「实时折射」开着。
     *
     * 为什么①也要算（用户新报）：
     *   `data-style="glass"` 只挡掉了「默认 / 磨砂」下**整组玻璃参数**的显示，
     *   可用户一旦开过玻璃样式再切回默认/磨砂，`barGlassLive` 这个布尔值**不会
     *   跟着复位**（它是开销开关，不属于外观参数，见 GLASS_PRESETS 的注释）——
     *   于是 `CONF.barGlassLive` 仍是 true，帧率那一行就又冒出来了。
     *   而在默认 / 磨砂样式下玻璃画布压根不跑，帧率设多少都不起作用。
     *
     * ②的理由：实时折射关着时实时链根本不跑，帧率同样设了也白设。 */
    const row = $('rowGlassFps');
    if (row) {
        row.hidden = !(CONF && CONF.barGlassLive && qsBarStyle(CONF) === 'glass');
    }
}

function bindRecentMax() {
    const seg = $('s-recentMax');
    if (!seg) return;
    seg.textContent = '';
    const cur = Number(CONF && CONF.recentMax) || 10;
    for (const n of RECENT_MAX_CHOICES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.v = String(n);
        b.textContent = n + ' 个';
        b.classList.toggle('on', n === cur);
        b.title = `「最近使用」一栏最多列 ${n} 个引擎`;
        b.addEventListener('click', () => {
            for (const x of seg.querySelectorAll('button')) x.classList.toggle('on', x === b);
            CONF.recentMax = n;
            window.CONF.recentMax = n;
            invoke('set_setting', { key: 'recentMax', value: n }).catch(() => {});
            // 横条那边同步：广播会带过去，但先把本地这份改掉，
            // 免得用户在设置页连着改、横条要等下一轮广播才动
            if (window.qsRecentMaxHint) window.qsRecentMaxHint(n);
        });
        seg.appendChild(b);
    }
}

const SLIDERS = [
    ['s-iconSize', 's-iconSizeVal', 'iconSize', 30],
    ['s-barPadding', 's-barPaddingVal', 'barPadding', 5],
    ['s-itemRadius', 's-itemRadiusVal', 'itemRadius', 9],
    ['s-alpha', 's-alphaVal', 'alpha', 100],
    ['s-barDimAlpha', 's-barDimAlphaVal', 'barDimAlpha', 45],
    ['s-delay', 's-delayVal', 'delayMs', 0],
    // 2026-10-23：横条自己收起来的两条阈值（0 = 不收起）
    ['s-barIdle', 's-barIdleVal', 'barIdleSec', 5],
    ['s-barAway', 's-barAwayVal', 'barAwayPx', 400],
    ['s-barBlur', 's-barBlurVal', 'barBlur', 0],
    // 液态玻璃一组（单位见 SLIDER_LABEL：折射/厚度是‰，磨砂是 px）
    // 缺省值与 GLASS_PRESETS 的 standard 档一致（#133）
    ['s-barGlassRefraction', 's-barGlassRefractionVal', 'barGlassRefraction', 30],
    ['s-barGlassBevel', 's-barGlassBevelVal', 'barGlassBevel', 18],
    ['s-barGlassAberration', 's-barGlassAberrationVal', 'barGlassAberration', 50],
    ['s-barGlassSpec', 's-barGlassSpecVal', 'barGlassSpec', 110],
    ['s-barGlassTint', 's-barGlassTintVal', 'barGlassTint', 14],
    ['s-barGlassFrost', 's-barGlassFrostVal', 'barGlassFrost', 2],
];

/** 这几项改了会让横条的样子变化，拖动时预览要跟着走 */
const PREVIEW_KEYS = new Set(['iconSize', 'barPadding', 'itemRadius', 'alpha', 'barDimAlpha', 'barBlur',
    // 液态玻璃六个（#137：切到玻璃样式后，拖这些滑块预览要立刻看到玻璃的变化）
    'barGlassRefraction', 'barGlassBevel', 'barGlassAberration', 'barGlassSpec', 'barGlassTint', 'barGlassFrost']);

/** 滑块的"数值标签"用不同方式显示：barBlur 的 0 是「关」，要写"关"不要写"0"。 */
const SLIDER_LABEL = {
    barBlur: (v) => (v === 0 ? '关' : qsBlurPx(v) + ' px'),
    /* 「无操作收起 / 鼠标移远收起」：0 是"不收起"，写成 0 秒 / 0 px 会让人
     * 以为"立刻收"，必须显式说出来。 */
    barIdleSec: (v) => (Number(v) === 0 ? '不收起' : v + ' 秒'),
    barAwayPx: (v) => (Number(v) === 0 ? '不收起' : v + ' px'),
    barGlassFrost: (v) => (v === 0 ? '关' : v + ' px'),
    barGlassRefraction: (v) => v + ' ‰',
    barGlassBevel: (v) => v + ' ‰',
};

const TEXTS = [
    ['w-aiSuffix', 'aiSuffix'],
    ['w-webdavUrl', 'webdavUrl'],
    ['w-webdavUser', 'webdavUser'],
    ['w-webdavPass', 'webdavPass'],
    ['w-backupPass', 'backupPassword'],
    /* v1.5.7：GitHub 个人访问令牌。走同一套 change → set_setting，不另起逻辑；
     * 「检查更新」按钮点击时还会再落一次盘（见 updInit），防止 IPC 顺序问题。 */
    ['s-githubToken', 'githubToken'],
    // r54：识图的「公网图片地址」。⚠ 后端 apply_one_setting 只收 http(s) 开头的
    //   值（见 main.rs 的 imgPublicUrl 分支）—— 填个 file:// 之类的会被拒，
    //   所以界面在失焦时提示一句，别让人以为存进去了。
    ['s-imgPublicUrl', 'imgPublicUrl'],
    // ⚠ w-ocrKey / w-ocrSecret 已删除（需求 2）：百度只是十几家里的一家，
    //   它的 Key/Secret 现在由 renderOcrCred() 按注册表生成，走 ocr_set_cred 落盘。
    // ⚠ v1.5.16 第二轮的 w-transApiKey / w-transModel / w-transBase 也一并删除：
    //   翻译改成多引擎后，凭据按引擎 id 分 map 存（trans_keys/trans_bases/trans_models），
    //   由 renderTransCred() 按注册表生成输入框、走 trans_set_cred 落盘 ——
    //   和 OCR 那一栏完全同一个套路（见本文件「翻译（多引擎）」一节）。
];

/* r76：AI 识图的两段延迟 —— [元素 id, 配置键, 默认值]。
 * 为什么不并进上面 TEXTS：那边 change 时发的是**字符串**（"1200"），后端
 * `as_u64()` 收到字符串会拿 null，于是永远落默认值 —— 用户调了没反应。
 * 数字框必须单独一段（见 bindSwitches 末尾的 DELAYS 循环）。 */
const DELAYS = [
    ['s-aiPasteDelay', 'imgAiPasteDelay', 1200],
    ['s-aiEnterDelay', 'imgAiEnterDelay', 900],
];

/** r76：延迟那一行的提示文字 —— 当前值 vs 默认值，一眼看得出"改过没有"。 */
function aiDelayHint() {
    const hint = $('aiDelayHint');
    const a = $('s-aiPasteDelay');
    const b = $('s-aiEnterDelay');
    if (!hint || !a || !b) return;
    const va = Number(a.value) || 1200;
    const vb = Number(b.value) || 900;
    hint.textContent = (va === 1200 && vb === 900)
        ? '默认 1200ms / 900ms（与旧版本一致）。'
        : `当前 ${va}ms / ${vb}ms —— 与默认（1200 / 900）不同。`;
}

/** r76：「↺ 默认」那颗钮 —— 两个框一起拨回 1200 / 900 并落盘。 */
function bindAiDelayReset() {
    const btn = $('btnAiDelayReset');
    if (!btn) return;
    btn.addEventListener('click', () => {
        for (const [id, key, dflt] of DELAYS) {
            const el = $(id);
            if (el) el.value = dflt;
            invoke('set_setting', { key, value: dflt });
        }
        aiDelayHint();
    });
}

/* ==========================================================================
 * 主题
 *
 * **设置窗口与横条共用**的明暗皮肤（#148 起横条不再自动取色）。这里改主题后
 * 后端会用同一份 theme 通过 `qs://theme` 把 {dark} 推给横条，两边永远一致。
 * ========================================================================== */
function applyTheme() {
    const t = CONF.theme || 'system';
    document.documentElement.dataset.theme = t;
    const dark = t === 'dark'
        || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    // 同时告诉浏览器这套 UI 是亮还是暗，滚动条、下拉框这些原生部件才会跟着变
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

// 系统主题中途切换时，只有「跟随系统」这一档需要跟着变
try {
    window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => {
            if ((CONF.theme || 'system') === 'system') applyTheme();
        });
} catch (e) { /* 老浏览器没有 addEventListener，忽略 */ }

/** ==========================================================================
 * 「在深色背景上预览」开关
 *
 * 这个开关**不进配置**：它是设置窗口本地 UI 状态，不是横条本身的设置。
 * 跨会话记它没意义（用户重启软件本来就要重新看一次）。
 * 默认值跟随当前设置主题：深色主题下默认开（设置页本身就是深色，何必再换？）。
 * ========================================================================== */
function applyPreviewDark(on) {
    for (const id of ['previewStageA', 'previewStageB']) {
        const stage = $(id);
        if (!stage) continue;
        if (on) stage.setAttribute('data-dark', '1');
        else stage.removeAttribute('data-dark');
    }
    // 两个开关的视觉状态保持一致 —— 一个点开另一个也跟着亮，避免 UI 错位。
    for (const id of ['s-previewDark', 's-previewDarkB']) {
        const sw = $(id);
        if (sw && sw.checked !== on) sw.checked = on;
    }
}

function bindPreviewDark() {
    const a = $('s-previewDark');
    const b = $('s-previewDarkB');
    /* ⚠ 本函数每次 `qs://config` 广播都会重跑（bindSwitches 调的），所以
     *   "主题默认值"**只能在第一次推导**（bound 还是 false，即设置窗刚打开）。
     *   之后再回落默认就出过一个真 bug：深色主题下用户把这个开关取消勾选，
     *   随便改个别的东西触发一次广播，两个框又被 `applyPreviewDark(true)`
     *   重新勾上 —— 表现是「这个开关关不掉」。
     *   广播重跑时只做一件事：保持用户当前的选择，把两个开关的视觉对齐。 */
    if (bound) {
        applyPreviewDark(!!(a && a.checked) || !!(b && b.checked));
        return;
    }
    // 第一次：设置页当前主题为深色 → 默认开；否则默认关。
    const t = CONF.theme || 'system';
    const dark = t === 'dark'
        || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    let on = dark;
    if (a && a.checked) on = true;
    else if (b && b.checked) on = true;
    applyPreviewDark(on);
    // 监听只挂一次：以前无条件 add，广播几十次就挂几十个 change 监听。
    if (a) a.addEventListener('change', () => applyPreviewDark(a.checked));
    if (b) b.addEventListener('change', () => applyPreviewDark(b.checked));
}

/* ==========================================================================
 * 预览
 *
 * 把横条照着当前配置原样画一份出来：引擎顺序、分隔线、图标大小、内边距、
 * 圆角、分隔线样式全都跟真身一致。改任何一项都会立刻看到。
 * ========================================================================== */
function renderPreview() {
    for (const id of ['qsPreviewA', 'qsPreviewB']) {
        const box = $(id);
        if (!box) continue;
        box.textContent = '';

        // 先滤掉指向已删除目录的 @fav: 哨兵、指向已删软件的 @app: 哨兵，
        // **再**归一化分隔线 —— 顺序反了的话，滤掉中间一项后可能让开头/结尾
        // 冒出一根孤零零的竖线。
        const list = qsNormalizeBarList((CONF.barList || []).filter((n) =>
            !(typeof n === 'string' && n.startsWith(QS_FAV_PREFIX)
                && !qsFavFindGroup(n.slice(QS_FAV_PREFIX.length)))
            && !(typeof n === 'string' && n.startsWith(QS_APP_PREFIX)
                && !qsAppBySentinel(n))));
        const size = CONF.iconSize || 30;
        const pad = CONF.barPadding === undefined ? 5 : CONF.barPadding;
        const radius = CONF.itemRadius === undefined ? 9 : CONF.itemRadius;

        const alpha = Math.max(30, Math.min(100, Number(CONF.alpha) || 100));
        const dim = Math.max(10, Math.min(100, Number(CONF.barDimAlpha) || 45));

        box.style.setProperty('--pv-size', size + 'px');
        box.style.setProperty('--pv-pad', pad + 'px');
        box.style.setProperty('--pv-radius', radius + 'px');
        box.style.setProperty('--pv-alpha', (alpha / 100).toFixed(2));
        // 预览的横条默认就当"鼠标没上来"：先按待机淡度画（和真身弹出一致）。
        // 鼠标移到预览上 = 悬停 → 变全不透明，一套行为在设置页就能试。
        box.style.setProperty('--pv-dim-alpha', (dim / 100).toFixed(2));
        box.dataset.sep = CONF.sepStyle || 'line';

        /* 外影跟「浮层阴影」开关走：真身上 --qs-shadow 默认是全透明占位
         * （不开就没外影）。预览原来无条件用 var(--shadow)（设置页卡片的影子），
         * 于是"关着阴影"的用户在预览里永远看到一层真身没有的影子。
         * 现在两边一个口径：不开 → 占位。 */
        box.style.setProperty('--pv-shadow',
            CONF.shadow ? 'var(--shadow)' : '0 0 0 0 rgba(0, 0, 0, 0)');

        // 磨砂预览：预览舞台是**带纹理**的底（见 settings.css 的 .preview-stage），
        // 所以这里的 backdrop-filter 真能看出效果 —— 以前舞台是纯色，
        // 糊完还是同一块纯色，用户调滑块看不到任何变化，才会觉得"这选项没用"。
        // 半径同样走 qsBlurPx()（和横条真身、滑块标签一个口径）。
        const blur = Math.max(0, Math.min(32, Number(CONF.barBlur) || 0));
        const tone = qsBlurTone(blur);
        box.dataset.blur = String(blur);
        box.style.setProperty('--pv-blur', qsBlurPx(blur) + 'px');
        box.style.setProperty('--pv-blur-sat', String(tone.sat));
        box.style.setProperty('--pv-blur-bright', String(tone.bright));

        /* 液态玻璃预览（#137）。
         *
         * 用户原话：「设为玻璃样式后预览要能显示该样式」。以前预览只有
         * 「默认/磨砂」两套画法，切到液态玻璃时预览仍是那块实色底板 ——
         * 六个玻璃滑块拖着，预览纹丝不动，根本看不出自己调的是什么。
         *
         * 真折射是 WebGL2 抓屏幕的活（glass.js 的 liquidGL），设置页预览
         * 抓不到桌面，这里用可实现的层叠效果把玻璃的**样子**学过来：
         *   · 半透明染色本体（亮色偏白 / 暗色压深蓝，跟预览明暗联动）
         *   · 内部磨砂 backdrop-filter（「玻璃磨砂」滑块）
         *   · 上下缘亮线（高光滑块定强度；色差滑块让下缘带冷色偏移，
         *     模拟 R/B 通道分离 —— 这是"一眼看出不是塑料"的线索）
         *   · 一道斜向镜面反光（同走高光滑块）
         * 折射/厚度滑块映射到边缘亮线的厚度感（--pv-lg-edge）。 */
        /* 判据必须走 qsBarStyle(CONF) 推导，不能读 CONF.barStyle ——
         * 样式从来不是配置键，是由 barGlass/barBlur 推出来的（见 qsBarStyle）。
         * 以前这里读一个永远不存在的 CONF.barStyle，玻璃样式下预览永远
         * 挂不上 data-lg（round30 E 段五个 FAIL 的根因）。 */
        const useGlass = qsBarStyle(CONF) === 'glass';
        if (useGlass) {
            box.dataset.lg = '1';
            // 玻璃样式下不吃「磨砂」主题那套底板模糊（它是横条自己的底板用的），
            // 否则两层 backdrop-filter 叠一起，预览糊成一团
            box.dataset.blur = '0';
            const spec = Math.max(0, Math.min(200, Number(CONF.barGlassSpec) || 0)) / 100;
            const tint = Math.max(0, Math.min(100, Number(CONF.barGlassTint) || 0)) / 100;
            const ab = Math.max(0, Math.min(100, Number(CONF.barGlassAberration) || 0)) / 100;
            const frost = Math.max(0, Math.min(12, Number(CONF.barGlassFrost) || 0));
            const refr = Math.max(0, Math.min(60, Number(CONF.barGlassRefraction) || 0)) / 60;
            const bevel = Math.max(0, Math.min(30, Number(CONF.barGlassBevel) || 0)) / 30;
            box.style.setProperty('--pv-lg-spec', String(Math.round(spec * 100) / 100));
            box.style.setProperty('--pv-lg-ab', String(Math.round(ab * 100) / 100));
            box.style.setProperty('--pv-lg-frost', frost + 'px');
            box.style.setProperty('--pv-lg-edge', String(Math.round((refr * 0.6 + bevel * 0.4) * 100) / 100));
            // 染色浓度：滑块 0 也留一丝丝本体（全透的玻璃在纹理底上会看不见边）
            box.style.setProperty('--pv-lg-tint-a',
                String(Math.round((tint * 0.30 + 0.12) * 1000) / 1000));
        } else {
            box.removeAttribute('data-lg');
        }

        if (!list.length) {
            const s = document.createElement('span');
            s.className = 'pv-empty';
            s.textContent = '横条上还没有引擎，去下面加几个';
            box.appendChild(s);
            continue;
        }

        for (const name of list) {
            if (name === QS_SEP) {
                const sp = document.createElement('span');
                sp.className = 'pv-sep';
                box.appendChild(sp);
                continue;
            }
            const b = document.createElement('span');
            b.className = 'pv-item';
            const isFav = typeof name === 'string' && name.startsWith(QS_FAV_PREFIX)
                && !!qsFavFindGroup(name.slice(QS_FAV_PREFIX.length));
            const app = qsAppBySentinel(name);
            b.title = name === QS_OCR ? '识别图片文字'
                : (isFav ? qsFavFindGroup(name.slice(QS_FAV_PREFIX.length)).name + '（收藏夹）'
                    : (app ? app.name + '（外部软件）' : name));
            // ⚠ 收藏夹 / 外部软件的图标都走共用实现 —— 必须和横条上的一模一样
            // （用户报过不一致）
            b.appendChild(isFav ? qsFavIconNode(name)
                : (app ? qsAppIconNode(name) : barItemIcon(name, size)));
            box.appendChild(b);
        }
        /* ⚠ 这里**不再**追加一根收尾竖线。
         *
         * 以前画过一根「引擎区 | 功能按钮」的分界，理由是"真身上也有"。
         * 但真身那根自动竖线后来按用户要求删掉了（见 bar.js 里那段注释），
         * 预览却没跟着删 —— 于是用户在预览里看到一根自己从没加过的竖线，
         * 去横条上一看又没有，成了个"设置和实际对不上"的 bug。
         * 现在两边口径一致：预览里出现的每一根竖线，都严格对应用户加的分隔线。 */
    }
}

/** 只绑一次事件：qs://config 每次广播都会重新调本函数，重复绑会导致一次改动发多次命令 */
let bound = false;

/** 用户此刻是不是正在某个容器里编辑（焦点在它的输入框里）？
 *  用来在配置广播到达时跳过「会重建 DOM」的重渲染，避免打断输入。 */
function qsEditingIn(id) {
    const box = $(id);
    const ae = document.activeElement;
    return !!(box && ae && ae !== document.body && box.contains(ae));
}

/** 空安全的 textContent 写入：元素不在（改版 / 被删）就静默跳过，不炸整条流程。 */
function qsSetText(id, s) {
    const el = $(id);
    if (el) el.textContent = s;
}

function bindSwitches() {
    applyTheme();
    syncStyleUI();
    // v1.5.4：弹出位置控件的置灰态跟着「跟随鼠标」走（首屏 + 每次广播都刷）
    syncBarPosUI();
    /* 帧率档位的高亮 + 那一行的显隐。
     *
     * 以前只在这里调一次，且注释写着"必须排在 syncStyleUI 之后"
     * ——因为 syncStyleUI 会按 data-style 重设那一行的 hidden，
     * 而这一行还要叠一个"实时折射开着吗"的条件，顺序反了会被改回去。
     *
     * r95：反过来的那条路（切样式时也要重刷）当时是漏的，现在补上了 ——
     * 所以这里不再依赖调用顺序，留着这次调用只是兜底（幂等，没有副作用）。 */
    syncGlassFpsUI();
    renderPreview();
    // r56：「最近使用」摆几个。每次广播都重建一遍（幂等）——
    // 广播可能来自别处改了 recentMax，这边得跟上。
    bindRecentMax();
    // 收藏夹：以后端广播来的为准整体刷新（用户编辑时会先写回再等广播）。
    // ⚠ 但**正在编辑时绝不能重建**：此时 DOM 一换，光标就没了，输入法组合中的
    //   内容还会被旧值覆盖。广播很频繁（横条收藏面板每 600ms 存一次尺寸就会
    //   触发一次），所以这块必须护住。展开/折叠状态存在 favGroupOpen/favItemOpen
    //   里，重建不会掉。
    if (!qsEditingIn('favTree')) {
        favTree = Array.isArray(CONF.favorites) ? JSON.parse(JSON.stringify(CONF.favorites)) : [];
        favRender();
    }
    // 快捷键那块整体交给 favHotkeySyncUI（文案 + 「清除」可用态 + 行尾提示），
    // 免得三处各写一遍、状态对不上。
    favHotkeySyncUI();
    // 「在深色背景上预览」开关：纯前端 UI 状态，不写后端、不持久化（一次会话内有效），
    // 用户切换主题或重启设置窗口时按设置主题决定默认值（深色主题默认开）。
    bindPreviewDark();
    for (const [id, key] of SWITCHES) {
        const el = $(id);
        // 少一个开关元素不该把整页绑定带崩：跳过去，控制台吱一声就够了。
        if (!el) {
            console.warn('[qs] 找不到开关元素 #' + id + '（键 ' + key + '），已跳过');
            continue;
        }
        el.checked = CONF[key] === undefined ? !!SWITCH_DEFAULT[key] : !!CONF[key];
        if (bound) continue;
        el.addEventListener('change', () => {
            invoke('set_setting', { key, value: el.checked });
            /* ⚠ 本地 CONF 也要**立刻**更新，不能等后端广播。
             *
             * 为什么必须这样（r80 探针 2e 抓到的真 bug）：`iconEditorEnabled()`
             * 读的是 `CONF.aiMattingEnable`。如果只 invoke 不更新本地 CONF，
             * 那么在"广播回来之前"这段时间里，页面认为开关还是关的 ——
             * 于是「编辑图标」按钮不出现，用户以为开关没生效。
             * （广播最终会覆盖，但依赖"等一会儿"的 UI 就是 bug 温床。） */
            if (window.CONF) window.CONF[key] = el.checked;
            /* AI 抠图开关还要额外刷新一次**后端状态**（模型列表 / 运行时可用性），
             * 那些不是纯配置项，拉不到就显示不出来。 */
            if (key === 'aiMattingEnable' && typeof aiOnSwitchChanged === 'function') {
                aiOnSwitchChanged();
            }
            /* 打开/关闭图标编辑器会改变所有行的按钮组合（「编辑图标」出现或消失），
             * 所以要重绘列表 —— 否则用户得手动切分页才看到变化。
             *
             * ⚠ 这里以前调的是一个**全项目都不存在**的 `renderAll()`，`typeof`
             *   守卫把它变成永假分支 —— 于是开关点了、配置也存了，但四条列表
             *   一个字都不重画，用户看到的是"开关没生效"。四块各自重画即可。 */
            if (key === 'aiMattingEnable') {
                renderAllList();
                renderBarList();
                renderCustomList();
                renderAppList();
            }
            /* r95：任何会改变「是不是玻璃样式 / 实时折射开不开」的改动都要刷帧率行。
             *
             * 以前只有 `barGlassLive` 这一支，于是屏幕上的两条真实路径各漏一半：
             *   · 关「实时折射」→ 帧率行该消失（旧的，已覆盖）；
             *   · 切到默认 / 磨砂 → 帧率行也该消失（**漏的**，用户报的就是它）。
             *
             * 样式是由 barGlass / barBlur 推导的（qsBarStyle），所以两个键都算上。 */
            if (key === 'barGlassLive' || key === 'barGlass' || key === 'barBlur') {
                syncGlassFpsUI();
            }
            /* v1.5.4：「跟随鼠标位置」决定「弹出位置」有没有意义 ——
             * 贴鼠标弹时选上/下方是空操作，控件置灰。 */
            if (key === 'anchorAtMouse') {
                syncBarPosUI();
            }
        });
    }

    for (const [id, key, dflt] of SEGS) {
        const seg = $(id);
        if (!seg) {
            console.warn('[qs] 找不到分段控件 #' + id + '（键 ' + key + '），已跳过');
            continue;
        }
        /* 配置里的值和按钮上的 data-v 常常是两种形态：
         * Rust 那边的 ocrAccurate 是 bool，按钮上写的却是 "1"/"0"。
         * 以前直接 String(true) 得到 "true"，和 "1" 永远比不上 ——
         * 表现就是「怎么点都选不中」，其实值存进去了，只是界面不显示选中态。
         * 所以先归一化再比。 */
        const norm = (v) => {
            if (typeof v === 'boolean') return v ? '1' : '0';
            return v === undefined || v === null ? '' : String(v);
        };
        const cur = norm(CONF[key] === undefined ? dflt : CONF[key]);
        for (const b of seg.querySelectorAll('button')) {
            b.classList.toggle('on', norm(b.dataset.v) === cur);
            if (bound) continue;
            b.addEventListener('click', () => {
                for (const x of seg.querySelectorAll('button')) x.classList.toggle('on', x === b);
                // 原来配置是什么类型就还发什么类型：bool 的照旧发 bool，
                // 免得 Rust 那边 as_bool() 收不到。
                let v = b.dataset.v;
                if (typeof CONF[key] === 'boolean') v = (b.dataset.v === '1');
                // 立刻生效：不等后端广播回来，免得点了半天界面纹丝不动
                if (key === 'theme' || key === 'sepStyle') {
                    CONF[key] = v;
                    if (key === 'theme') applyTheme(); else renderPreview();
                }
                /* v1.5.13：语言要**当场**换，不能等广播。
                 *
                 * 广播会到（后端 save 之后立刻 broadcast），但那段路要先落盘、
                 * 再跨进程发事件；用户点一下「English」后两百毫秒界面才变，
                 * 会以为"没点上"，然后反复点。这里直接调 i18n，广播到了
                 * 再做一次（幂等，setLang 同语言直接返回）。 */
                if (key === 'uiLang') {
                    CONF[key] = v;
                    if (window.QS_I18N) window.QS_I18N.setLang(v);
                }
                // ocrEngine 同理：先把本地 CONF 改掉再同步，否则下面这句读到的
                // 还是旧引擎（切「Windows 本地」时百度专用行不隐藏、环境检测卡
                // 不刷新），要等广播兜一圈才动 —— 点击 feedback 慢半拍。
                if (key === 'ocrEngine') {
                    CONF[key] = v;
                    syncOcrEngineUI();
                }
                invoke('set_setting', { key, value: v }).catch(() => {});
            });
        }
    }
    // 首屏（以及每次重新绑定）都按当前引擎把百度专用项显隐一次，
    // 否则切到「Windows 本地」后刷新页面，那几行又会冒出来。
    //
    // ⚠ 广播到达时（bound=true）也要跑，但要**避开正在输入的那个框**：
    //   `syncOcrEngineUI` 会连带 `renderOcrEngines` + `renderOcrCred`，
    //   而后者自己已经加了"正在输入就不重建"的保护，所以这里照跑即可 ——
    //   以前这两句在 `if (bound) continue` 之外是无条件的，等于每次广播都
    //   重建一次整张 OCR 引擎表和凭据表单。
    syncOcrEngineUI();
    // 引擎列表要单独拉一次（renderOcrEngines 只负责渲染，数据来自后端注册表）
    if (!bound) loadOcrEngines();

    // v1.5.16 第二轮：翻译栏 —— 和 OCR 同一套（名单来自后端注册表）。
    // 语言表只拉一次（transLangsFilled 守着），但「选中哪项」「加进横条按钮显不显」
    // 「默认引擎是谁」每次广播都要刷。
    if (!bound) loadTransEngs();
    renderTransEngines();
    renderTransCred();
    renderTransMulti();
    transFillLangs();
    transSyncLang();
    syncTransInBarBtn();

    for (const [id, valId, key, dflt] of SLIDERS) {
        const el = $(id);
        const val = $(valId);
        // 和上面两段一样要挡一手：少一个滑块也只该少一个功能，
        // 不该把后面 TEXTS / 程序列表那一整段绑定全带崩。
        if (!el || !val) {
            console.warn('[qs] 找不到滑块 #' + id + ' 或它的数值显示 #' + valId + '，已跳过');
            continue;
        }
        // ⚠ 和下面 TEXTS、程序列表一个口径：正在拖 / 正在用键盘方向键调值时，
        //   不要被广播回来的旧值拨回去。少了这一手：拖动中若另一处配置变化
        //   引发广播，滑块会跳回旧位置，用户松手后 change 不再触发 ——
        //   这一次调整**整个丢失**（滑块在动、值没变）。
        if (document.activeElement !== el) {
            el.value = CONF[key] === undefined ? dflt : CONF[key];
        }
        val.textContent = (SLIDER_LABEL[key] || ((v) => v))(el.value);
        if (bound) continue;
        el.addEventListener('input', () => {
            val.textContent = (SLIDER_LABEL[key] || ((v) => v))(el.value);
            /* 拖滑块时预览跟着动 —— 用户点名要「调了立刻看到样子」。
             * change 要等松手才触发，那时预览才动就太迟了。 */
            if (PREVIEW_KEYS.has(key)) {
                CONF[key] = Number(el.value);
                renderPreview();
            }
        });
        el.addEventListener('change', () =>
            invoke('set_setting', { key, value: Number(el.value) }));
    }

    for (const [id, key] of TEXTS) {
        const el = $(id);
        if (!el) {
            console.warn('[qs] 找不到输入框 #' + id + '（键 ' + key + '），已跳过');
            continue;
        }
        // 正在输入时不要被广播回来的值打断光标
        if (document.activeElement !== el) {
            el.value = CONF[key] === undefined ? '' : CONF[key];
            /* v1.5.8：令牌的「保存」按钮要跟着"已落盘的值"走。
             * 只靠 updInit 里那一次刷新是不够的：updInit 可能在配置回填
             * **之前**就跑过（那时输入框还是空的，按钮会被误判成"有改动"）。 */
            if (key === 'githubToken') tokRefreshSave();
        }
        if (bound) continue;
        el.addEventListener('change', () => invoke('set_setting', { key, value: el.value }));
    }

    /* r76：AI 识图的两段延迟。它们是**数字框**，不能塞进 TEXTS ——
     * 那边 change 时发的是字符串（"1200"），后端 as_u64() 会拿到 null，
     * 于是永远落的是默认值，用户调了没反应。
     * 这里单独一段：钳范围、发数字、并维护「↺ 默认」那颗钮与提示文字。 */
    for (const [id, key, dflt] of DELAYS) {
        const el = $(id);
        if (!el) continue;
        if (document.activeElement !== el) {
            el.value = CONF[key] === undefined ? dflt : CONF[key];
        }
        if (bound) continue;
        // 顺手把单位徽标补上（CSS 画 attr(data-unit)，这里只保证属性在）
        el.setAttribute('data-unit', 'ms');
        el.addEventListener('change', () => {
            // 空 / NaN / 超出范围都退回默认 —— 但**不静默**：提示行说出来
            let n = Math.round(Number(el.value));
            if (!Number.isFinite(n) || n < 0) n = dflt;
            n = Math.min(60000, Math.max(0, n));
            el.value = n;
            invoke('set_setting', { key, value: n });
            aiDelayHint();
        });
    }
    aiDelayHint();

    // 程序列表（多行）：失焦时提交
    /* ⚠ 这里必须判空再往下走。
     *   同一个函数里 SWITCHES / SEGS / SLIDERS / TEXTS 都写了
     *   `if (!el) { console.warn(...); continue; }`，唯独这一处直接 `.value` ——
     *   元素一旦缺失（改版删错 id、HTML 没同步）就是 TypeError，
     *   把**后面**所有绑定（搜索防抖、备份按钮、收藏夹热键……）整段带崩，
     *   用户看到的是"设置页有一半按钮点了没反应"。 */
    const fl = $('s-filterList');
    if (fl) {
        if (document.activeElement !== fl) {
            fl.value = (CONF.filterList || []).join('\n');
        }
        if (!bound) {
            fl.addEventListener('change', () => {
                const list = fl.value.split('\n').map((s) => s.trim()).filter(Boolean);
                invoke('set_setting', { key: 'filterList', value: list });
            });
        }
    } else {
        console.warn('[qs] 找不到程序过滤列表 #s-filterList，已跳过');
    }

    if (!bound) bindBarStyle();
    if (!bound) bindGlassFps();
    if (!bound) bindGlassPreset();

    bound = true;
}

/* ------------------------------------------------------------------ */
/* 按钮                                                                */
/* ------------------------------------------------------------------ */

/* 引擎目录有 700+ 项，`renderAllList` 每次都是「清空 + 重建整棵列表（含图标
 * 节点、分组导航）」。输入框原来直接挂在 input 上，于是每敲一个键就重建一遍
 * —— 头一两个字符命中几百行时明显掉帧（输入法组合期间还会连续触发）。
 * 防抖 120ms：输入停一下再画，体感无差别，重建次数从「每键一次」降到「每停一次」。 */
let allFilterTimer = 0;
$('allFilter').addEventListener('input', () => {
    clearTimeout(allFilterTimer);
    allFilterTimer = setTimeout(renderAllList, 120);
});

$('btnDir').addEventListener('click', () => invoke('open_data_dir'));
// 「退出 Quick Search」按钮已删：没有账号体系，退出走托盘右键菜单
// （quit_app 命令保留，托盘还在用）。
$('btnExport').addEventListener('click', () => invoke('export_config'));
$('btnImport').addEventListener('click', () => invoke('import_config'));
$('btnReset').addEventListener('click', async () => {
    await invoke('reset_all');
    toast('已恢复默认');
});

/* ---- 本地备份目录 ----
 * 用户报过「配置到底备份到哪了都不知道」。.bak、WebDAV 同步前的时间戳快照
 * 都落在 backup_info 返回的目录里：默认是数据目录，也可以改到任何位置。
 * 这里把「当前目录 + 里面现有的备份文件」列出来，改完立刻刷新。 */
let bkInfoTimer = 0;
/* ==========================================================================
 *  v1.5.9：备份的可移植性状态
 *
 *  这一块解决的是**一句话的误导**。界面上长期写着「留空 = 不加密」，
 *  但 v1.4.0 起留空是走 DPAPI 的 —— 数据确实加密了，只是只有这台机器能解。
 *  用户照着那句话理解，会在换电脑那天才发现整份备份作废。
 *
 *  所以这里不问"用户填了什么"，只显示**事实**：现在这份备份换台机器能不能解开。
 * ========================================================================== */
async function refreshBackupSec() {
    const box = $('bkSec');
    if (!box) return;
    let st;
    try {
        st = await invoke('backup_security_state');
    } catch (_) {
        // 后端没起来 / 命令没注册：整条藏起来，别显示一句可能是错的结论
        box.hidden = true;
        return;
    }
    if (!st || typeof st !== 'object') return;
    const portable = !!st.portable;
    const n = Number(st.secretCount) || 0;
    box.className = 'bk-sec ' + (portable ? 'ok' : 'warn');
    box.hidden = false;
    box.textContent = '';

    const head = document.createElement('div');
    head.className = 'bk-sec-head';
    head.textContent = portable
        ? '✓ 可跨设备恢复 —— 这份备份用备份密码加密'
        : '⚠ 仅本机可解 —— 没设备份密码，现在用的是 Windows 账户加密';
    box.appendChild(head);

    const sub = document.createElement('div');
    sub.className = 'bk-sec-sub';
    const parts = [
        portable
            ? '换电脑：装上软件 → 在「备份」页填上同一个密码 → 从云端恢复，凭据会一起回来'
            : '换电脑后这份备份解不开。想跨设备用：在上面填一个备份密码，再重新备份一次',
        n ? `当前配置里有 ${n} 项凭据会跟着备份走` : '当前配置里还没有填任何凭据',
    ];
    /* 令牌单独提一句，但**不显示它的值** —— 这条状态条不需要、也不该出现凭据。 */
    if (st.hasToken) parts.push('含 GitHub 个人访问令牌');
    /* 每一截单独一个 `<span>`，只用 ` · ` 连起来。
     * 拼成一整串的话，多语言那边只能当成一整句去查 —— 而这几截的**组合有
     *  十几种**（能不能跨机 × 有没有凭据 × 有没有令牌），组合出来的句子永远
     *  进不了字典。切开之后每截都是固定文案，各自查各自的表就行。
     *  textContent 和原来的 `parts.join(' · ')` 完全一致，观感不变。 */
    sub.textContent = '';
    parts.forEach((p, i) => {
        if (i) sub.appendChild(document.createTextNode(' · '));
        const seg = document.createElement('span');
        seg.textContent = p;
        sub.appendChild(seg);
    });
    box.appendChild(sub);
}

/* 密码框一改，结论就该跟着变。等 400ms 是因为 set_setting 是异步落盘的
 * （TEXTS 里那套通用自动保存），马上问后端问到的还是旧状态。 */
{
    const pwEl = $('w-backupPass');
    if (pwEl && !pwEl.dataset.secbound) {
        pwEl.dataset.secbound = '1';
        pwEl.addEventListener('change', () => setTimeout(refreshBackupSec, 400));
    }
}

async function refreshBackupInfo() {
    refreshBackupSec();
    let info;
    try {
        info = await invoke('backup_info');
    } catch (_) {
        return;
    }
    // ⚠ 一定要挡这一下：`invoke` 拿到 null（命令没注册、被 ACL 拒了、或
    //   后端返回了 null）时，下一步取 `.dir` 就是 TypeError。这个函数在
    //   脚本加载时就会被调一次，抛出来的还是**未处理的 promise 拒绝** ——
    //   在 WebView2 里它不会打断别的脚本，只会静默地让「备份目录」那一块
    //   永远停在 '…'，最难查。
    if (!info || typeof info !== 'object') return;
    qsSetText('bkDirPath', String(info.dir || ''));
    const tag = $('bkDirTag');
    if (tag) {
        tag.textContent = info.isCustom ? '自定义' : '默认';
        tag.classList.toggle('custom', !!info.isCustom);
    }
    const box = $('bkFiles');
    if (!box) return;
    box.textContent = '';
    const files = Array.isArray(info.files) ? info.files : [];
    if (!files.length) {
        box.appendChild(Object.assign(document.createElement('div'), {
            className: 'bk-empty',
            textContent: '目录里还没有备份（改动一次设置就会自动留一份）',
        }));
        return;
    }
    const fmtSize = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');
    const fmtTime = (t) => {
        if (!t) return '';
        const d = new Date(t * 1000);
        const p = (x) => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
            + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    /* 三类备份长得不一样，清单里得说清楚是哪一类：
     *   auto = 每次改设置自动留的滚动备份（config.auto(...)）
     *   manual = 用户自己点「立即备份」的
     *   snapshot = 恢复/同步之前留的本机副本（config.before-*）
     * v1.4.1 起**三类都能点着恢复** —— 以前这份清单是纯展示，用户只能去
     * 「导入配置」的文件对话框里翻，而那条路又只认手动备份的格式。 */
    const kindText = (k) => (k === 'auto' ? '自动'
        : k === 'manual' ? '手动'
        : k === 'snapshot' ? '恢复前' : '其他');
    const head = document.createElement('div');
    head.className = 'bk-files-head';
    head.textContent = '备份文件（点一行就恢复，最多显示 20 份）';
    box.appendChild(head);
    for (const f of files.slice(0, 20)) {
        const nm = String(f.name || '');
        const row = document.createElement('div');
        row.className = 'bk-file';
        row.title = '点击用这份备份覆盖当前配置（会先自动留一份恢复前快照）';
        const nameEl = document.createElement('span');
        nameEl.className = 'bk-name';
        const k = document.createElement('i');
        k.className = 'bk-kind kind-' + String(f.kind || 'other');
        k.textContent = kindText(String(f.kind || ''));
        nameEl.appendChild(k);
        nameEl.appendChild(document.createTextNode(nm));
        row.appendChild(nameEl);
        row.appendChild(Object.assign(document.createElement('span'), {
            className: 'bk-meta', textContent: fmtTime(f.mtime) + ' · ' + fmtSize(Number(f.size) || 0),
        }));
        row.addEventListener('click', async () => {
            if (!nm) return;
            if (!confirm('用这份备份覆盖当前配置？\n\n' + nm
                + '\n\n当前配置会先自动留一份（恢复前快照），挑错了还能退回来。')) return;
            try {
                /* 后端返回的是"凭据怎么样了"的补充说明（可能为空）：
                 * 恢复是整份覆盖，用户最该知道令牌动没动。 */
                const note = await invoke('restore_backup_file', { name: nm });
                toast('已恢复：' + nm + (note ? String(note) : ''));
            } catch (e) {
                toast('恢复失败：' + ((e && e.message) || e));
            }
            refreshBackupInfo();
        });
        box.appendChild(row);
    }
}

$('btnBkPick').addEventListener('click', async () => {
    const dir = await invoke('pick_backup_dir').catch(() => '');
    if (!dir) return;   // 用户取消了
    await invoke('set_setting', { key: 'backupDir', value: dir }).catch(() => {});
    toast('备份目录已更改，今后的自动备份都放这里');
    refreshBackupInfo();
});
$('btnBkDefault').addEventListener('click', async () => {
    await invoke('set_setting', { key: 'backupDir', value: '' }).catch(() => {});
    toast('已恢复默认备份目录（数据目录）');
    refreshBackupInfo();
});
$('btnBkOpen').addEventListener('click', () => invoke('open_backup_dir').catch(() => {}));
// 清理 7 天前的备份：删超期的，但 backend 有兜底 —— 只剩一个备份（或这一删会
// 全部删光）时一个都不动，返回 skipped:true。前端把话说清楚，别让用户以为按钮没反应。
$('btnBkClean').addEventListener('click', async () => {
    let r;
    try {
        r = await invoke('clean_old_backups', { days: 7 });
    } catch (e) {
        toast('清理失败：' + ((e && e.message) || e));
        return;
    }
    if (r && r.skipped) {
        toast(`没有可清理的：当前 ${r.kept} 个备份，超期的一个没删（至少给你留一个）`);
    } else if (r && r.removed > 0) {
        toast(`已清理 ${r.removed} 个 7 天前的备份，还剩 ${r.kept} 个`);
    } else {
        toast('没有超过 7 天的备份，不用清理');
    }
    refreshBackupInfo();
});
// 切到备份页时刷一次（文件时间会变）；启动也刷
document.querySelector('#tabs button[data-tab="backup"]')
    ?.addEventListener('click', () => refreshBackupInfo());
refreshBackupInfo();

/* 「仅保留最近 10 份」：本地 + 云端一起清。
 *
 * 后端一次把两边都处理完（本地删完再列云端目录删旧的），结果通过
 * qs://webdav 那条通道回来说一句话；这里只负责点之前问一句 ——
 * 删除是不可逆的，而且云端删的是用户网盘上的文件，必须二次确认。 */
$('btnBkKeep10').addEventListener('click', async () => {
    if (!window.confirm('只保留最近 10 份备份，更早的全部删除。\n'
                      + '本地备份目录和云端网盘都会被清理，删除后无法恢复。\n\n确定继续吗？')) {
        return;
    }
    $('wdStatus').textContent = '正在清理旧备份（本地 + 云端）…';
    try {
        await invoke('prune_backups', { keep: 10 });
    } catch (e) {
        toast('清理失败：' + ((e && e.message) || e));
        return;
    }
    refreshBackupInfo();
});

/* ---------------- 清理冗余数据（先扫后删） ----------------
 * 用户要求：「数据文件夹里面有很多的冗余数据……最好是在备份页面里面能有一个选项，
 * 点击后就删除冗余数据，删除无用数据。」
 *
 * ⚠ 刻意做成**两段式**：点一下先只扫描，把「要删什么、为什么算冗余、能腾多少」
 *   摆出来，用户确认了才真删。理由：这个按钮碰的是**数据目录里的文件**，
 *   而 `confirm('确定删除吗？')` 这种问法，用户其实不知道自己同意了些什么 ——
 *   把清单摆在他面前，"删掉不影响恢复"这句话才立得住。
 *   判据全在 Rust 侧的 `cleanup` 模块里，前端只负责显示。 */
function bkCleanupRender(rep) {
    const box = $('bkCleanup');
    const list = $('bkCleanupList');
    if (!box || !list) return;
    const groups = (rep && rep.groups) || [];
    const skipped = (rep && rep.skipped) || [];
    const count = (rep && rep.count) || 0;
    const bytes = (rep && rep.bytes) || 0;

    box.hidden = false;
    list.textContent = '';
    $('bkCleanupTitle').textContent = count
        ? `可以清理 ${count} 个文件，约 ${fmtBytes(bytes)}`
        : '没有发现冗余数据';
    $('bkCleanupSub').textContent = count
        ? '下面这些都不是你手动做的备份，删掉不影响恢复。'
        : '数据目录已经很干净了，不需要清理。';

    for (const g of groups) {
        const li = document.createElement('li');
        const line = document.createElement('div');
        line.className = 'bk-cu-line';
        line.appendChild(Object.assign(document.createElement('span'), {
            className: 'bk-cu-name', textContent: g.label,
        }));
        line.appendChild(Object.assign(document.createElement('span'), {
            className: 'bk-cu-size', textContent: fmtBytes(g.bytes || 0),
        }));
        li.appendChild(line);
        li.appendChild(Object.assign(document.createElement('div'), {
            className: 'bk-cu-why', textContent: g.why || '',
        }));
        list.appendChild(li);
    }
    if (!groups.length) {
        list.appendChild(Object.assign(document.createElement('div'), {
            className: 'bk-cu-none', textContent: '没有需要清理的东西。',
        }));
    }
    // 看见了但**故意没动**的，也要说清楚 —— 否则用户会以为漏了
    for (const s of skipped) {
        list.appendChild(Object.assign(document.createElement('div'), {
            className: 'bk-cu-skip', textContent: '· ' + s,
        }));
    }
    const go = $('btnBkCleanupGo');
    if (go) {
        go.hidden = !count;
        go.disabled = !count;
    }
}

$('btnBkCleanup').addEventListener('click', async () => {
    const btn = $('btnBkCleanup');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在扫描…';
    $('bkCleanup').hidden = false;
    $('bkCleanupTitle').textContent = '正在扫描冗余数据…';
    $('bkCleanupSub').textContent = '要逐份解开备份才能判重，稍等一两秒。';
    $('bkCleanupList').textContent = '';
    try {
        bkCleanupRender(await invoke('cleanup_data', { apply: false }));
    } catch (e) {
        const msg = (e && e.message) || String(e);
        toast('扫描失败：' + msg);
        $('bkCleanupTitle').textContent = '扫描失败';
        $('bkCleanupSub').textContent = msg;
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
});

$('btnBkCleanupCancel').addEventListener('click', () => {
    $('bkCleanup').hidden = true;
});

$('btnBkCleanupGo').addEventListener('click', async () => {
    const btn = $('btnBkCleanupGo');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在清理…';
    try {
        const rep = await invoke('cleanup_data', { apply: true });
        const n = (rep && rep.deleted) || 0;
        const freed = (rep && rep.freed) || 0;
        const msg = n
            ? `已清理 ${n} 个冗余文件，腾出 ${fmtBytes(freed)}`
            : '没有发现需要清理的冗余数据';
        toast(msg);
        $('wdStatus').textContent = msg;
        $('bkCleanup').hidden = true;
        refreshBackupInfo();
    } catch (e) {
        toast('清理失败：' + ((e && e.message) || e));
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
});

// ---- 往黑白名单里加程序 ----
/* 两条路：
 *   ① 点「用鼠标点选程序」→ 弹出一层十字光标的透明板子，点哪个窗口就收哪个程序；
 *   ② 点「从电脑里挑程序」→ 直接选一个 .exe。
 * 以前那条「点完 5 秒内切到目标软件」的做法已经删掉了：要用户掐着秒切窗口太别扭，
 * 而且切过去的瞬间前台不一定稳，抓错的概率不低。直接点窗口是确定的。
 *
 * 两条路的结果都走 qs://picked-app 回来，下面统一处理。
 */
function addAppToFilter(name) {
    const hint = $('grabHint');
    const n = String(name || '').trim();
    if (!n) {
        hint.textContent = '没认出来，再试一次';
        return;
    }
    const cur = $('s-filterList').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (cur.some((x) => x.toLowerCase() === n.toLowerCase())) {
        hint.textContent = n + ' 已经在列表里了';
        return;
    }
    cur.push(n);
    $('s-filterList').value = cur.join('\n');
    invoke('set_setting', { key: 'filterList', value: cur }).catch(() => {});
    hint.textContent = '已加入列表：' + n;
}

$('btnPickApp').addEventListener('click', () => {
    $('grabHint').textContent = '鼠标会变成十字，点一下目标程序的窗口…';
    invoke('open_app_picker').catch(() => {});
});

$('btnPickFile').addEventListener('click', () => {
    $('grabHint').textContent = '正在打开文件选择…';
    invoke('pick_app_file').catch(() => {});
});

listen('qs://picked-app', (ev) => addAppToFilter(ev.payload));

listen('qs://focus-tab', (ev) => {
    const want = String(ev.payload || '');
    for (const b of $('tabs').querySelectorAll('button')) {
        if (b.dataset.tab === want) b.click();
    }
});

// ---- 横条编排：分隔线 + 自定义引擎 ----
$('btnAddSep').addEventListener('click', () => invoke('add_separator'));

/* 「＋ 添加引擎」：展开/收起方式选择层。展开时两张表单都收着，
 * 由用户选一种方式再放对应的那张。 */
$('btnAddEngine').addEventListener('click', () => {
    const ways = $('addWays');
    if (!ways) return;
    if (ways.hidden) {
        ways.hidden = false;
        addWay = null;
        $('customForm').hidden = true;
        $('appForm').hidden = true;
        resetCeForm();
        resetAppForm();
    } else {
        collapseAddWays();
    }
});
// 三种方式：点了就把对应表单放出来（方式卡高亮，另一张表单收起）
for (const b of $('addWays').querySelectorAll('.addway')) {
    b.addEventListener('click', () => setAddWay(b.dataset.way));
}

$('btnCeSave').addEventListener('click', submitCeForm);
$('btnCeCancel').addEventListener('click', () => {
    resetCeForm();
    renderCustomList();
});
// 表单里按回车直接提交，省得每次都去够鼠标
for (const id of ['w-ceName', 'w-ceUrl', 'w-ceCat']) {
    $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitCeForm();
        }
        if (e.key === 'Escape') {
            resetCeForm();
            renderCustomList();
        }
    });
}

// ---- 外部软件：新建 / 编辑 / 回车提交 ----
$('btnApSave').addEventListener('click', submitAppForm);
$('btnApCancel').addEventListener('click', () => {
    resetAppForm();
    renderAppList();
});
for (const id of ['w-apName', 'w-apUrl']) {
    $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitAppForm();
        }
        if (e.key === 'Escape') {
            resetAppForm();
            renderAppList();
        }
    });
}

// ---- OCR ----
$('btnOcr').addEventListener('click', () => invoke('ocr_start'));
$('btnOcrTest').addEventListener('click', async () => {
    $('ocrHint').textContent = '正在测试…';
    const r = await invoke('ocr_test').catch((e) => '失败：' + e);
    $('ocrHint').textContent = r;
});

/* 一键诊断（#134 建的「一键优化」改的名；r49 起**每一家引擎都能诊断**）。
 *
 *  用户原话：「"一键优化"改为"一键诊断"。诊断完成后展示当前识别状态及各环节
 *  耗时/速度，并在每个环节后提供独立的"优化"按钮供用户手动选择；禁止因高精度
 *  模式慢而自动回退到标准模式」；r49 追加：「它只存在于百度云 ocr，其他的也要有
 *  一键诊断功能」。
 *
 *  后端 ocr_diagnose 是**只读**的（一个字节的配置都不改），实测完各环节后
 *  经 qs://ocr-diag 把 JSON 送来；这里只负责画。每个环节的按钮：
 *    预热 token     → ocr_warm（提前换好 token，正式识别少一段网络等待）
 *    改用标准版     → set_setting ocrAccurate=false（更快）
 *    改用高精度     → set_setting ocrAccurate=true（更准但更慢，要付费）
 *    去申请 / 填凭据 → 打开那家的官方申请页（ocr_open_help）
 *  点不点、点什么，全部由用户自己决定。 */
$('btnOcrOpt').addEventListener('click', async () => {
    const hint = $('ocrHint');
    const eng = CONF.ocrEngine || 'baidu';
    const info = engineById(eng);
    if (hint) hint.textContent = '正在诊断并实测「' + ((info && info.name) || eng) + '」（会真发一次请求，稍等）…';
    try {
        // r49：把当前默认引擎带过去 —— 诊断的就是用户眼前这一家
        await invoke('ocr_diagnose', { engine: eng });
    } catch (e) {
        if (hint) hint.textContent = '诊断失败：' + String(e || '未知错误').slice(0, 80);
    }
});

/** 画诊断面板。payload 形状见 src/main.rs 的 ocr_diagnose。 */
function renderOcrDiag(p) {
    const box = $('ocrDiag');
    const sum = $('ocrDiagSum');
    const rows = $('ocrDiagRows');
    if (!box || !sum || !rows) return;
    const d = p || {};
    sum.textContent = d.summary || '';
    box.dataset.ok = d.ok === false ? '0' : '1';
    rows.textContent = '';

    for (const st of d.stages || []) {
        const row = document.createElement('div');
        row.className = 'od-row';

        const nm = document.createElement('span');
        nm.className = 'od-name';
        nm.textContent = st.name || '';
        row.appendChild(nm);

        const ms = document.createElement('span');
        ms.className = 'od-ms';
        if (st.ms === null || st.ms === undefined) {
            ms.textContent = '—';
            ms.title = '这个环节没有实测数据';
        } else {
            ms.textContent = st.ms + ' ms';
        }
        row.appendChild(ms);

        const dt = document.createElement('span');
        dt.className = 'od-detail';
        dt.textContent = st.detail || '';
        row.appendChild(dt);

        /* 每个环节独立的「优化」按钮：动作完全由用户点，绝不自动执行。
         * ⚠ 按钮只在有 action 时出现；「识别状态」那一环是背景信息，没有动作。 */
        if (st.action) {
            const b = document.createElement('button');
            b.className = 'mini';
            b.type = 'button';
            b.textContent = st.actionLabel || '优化';
            b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    if (st.action === 'warm') {
                        await invoke('ocr_warm');
                        toast('token 已预热，下次识别少一段网络等待');
                    } else if (st.action === 'standard') {
                        await invoke('set_setting', { key: 'ocrAccurate', value: false });
                        toast('已改用标准版（更快）');
                    } else if (st.action === 'accurate') {
                        await invoke('set_setting', { key: 'ocrAccurate', value: true });
                        toast('已改用高精度（更准，但需要百度付费权限）');
                    } else if (st.action === 'signup') {
                        // r49：凭据没填/要补 —— 直接把用户送到那家的官方申请页
                        await invoke('ocr_open_help', { engine: st.engine || (CONF.ocrEngine || 'baidu') });
                        toast('已在浏览器里打开官方申请页');
                    } else if (st.action === 'docs') {
                        await invoke('ocr_open_docs', { engine: st.engine || (CONF.ocrEngine || 'baidu') });
                        toast('已在浏览器里打开接口文档');
                    }
                } catch (e) {
                    toast('操作失败：' + String(e || '未知错误').slice(0, 60));
                } finally {
                    b.disabled = false;
                }
            });
            row.appendChild(b);
        }
        rows.appendChild(row);
    }
    box.hidden = false;
}

listen('qs://ocr-diag', (ev) => renderOcrDiag(ev.payload));

/* 「把 OCR 加进横条」：加的是 @ocr 哨兵（见 shared.js 的 QS_OCR）。
 * 加完之后它就是横条里的一分子，去「引擎」页拖它就能改位置。 */
$('btnOcrInBar').addEventListener('click', async () => {
    await invoke('toggle_bar_engine', { engine: QS_OCR, on: true });
    toast('已加进横条，去「引擎」页拖它可以改位置');
});

/* ⚠ 这里原来有一颗「换个图标…」按钮（btnOcrIcon）。
 * 用户指出它和「引擎」页里 OCR 那一行的「换图标」功能重复，已删除 ——
 * 换图标统一走「引擎」页（那条通路和普通引擎完全一致：pick_icon + overrides）。 */

/* 同步那颗按钮的显隐。
 *
 * 用户明确要求：**OCR 已经在横条里时，这颗按钮直接隐藏**；
 * 只有当横条里没有 OCR 时才出现。
 * （留着它、写着"把 OCR 加进横条"却点不动，只会让人困惑。） */
function syncOcrInBarBtn() {
    const b = $('btnOcrInBar');
    if (!b) return;
    b.hidden = (CONF.barList || []).includes(QS_OCR);
}

/* ------------------------------------------------------------------ */
/* 翻译（v1.5.16 第二轮：多引擎，整套对齐「识别引擎」那一栏）             */
/* ------------------------------------------------------------------ */

/* 用户原话（v1.5.16 第二轮）：「翻译不能只有内置一个模型，要跟文字识别的硅基流动
 * 部分一样，能够拉取模型列表并选择一个；也要增加其他翻译引擎，像 OCR 识别一样
 * 可以同时多选几个，同一个页面同时呈现出来。具体逻辑参照 OCR 识别部分。」
 *
 * 所以这一栏整套照 OCR 那一栏的路子来：
 *   · 名单来自后端注册表（trans_engines_list），前端不自己维护；
 *   · 点一行 = 设为默认引擎（写 transEngine，每次翻译一定用它）；
 *   · 展开那一行填凭据（Key / 接口地址 / 模型 —— 填哪几样由注册表的
 *     need_key / need_base / need_model 决定），模型行带「拉取模型」按钮 +
 *     拉完**陈列**出来直接点选（方向与 OCR 相反：只要**对话**模型）；
 *   · 「同时翻译」多选（trans_multi）= 额外和默认引擎一起翻的那几家，
 *     后端 trans_set_multi 负责清洗（剔默认引擎 / 重复 / 不认识的 id）后回传。 */

let TRANS_ENGS = [];

async function loadTransEngs() {
    try {
        const list = await invoke('trans_engines_list');
        TRANS_ENGS = Array.isArray(list) ? list : [];
    } catch (e) {
        TRANS_ENGS = [];
    }
    renderTransEngines();
    renderTransCred();
    renderTransMulti();
}

function transEngById(id) {
    return TRANS_ENGS.find((e) => e.id === id) || null;
}

/* 引擎列表：点一行 = 设为默认引擎。展开的"身体"（凭据 + 同时翻译）只挂在
 * 默认那一行下面 —— 凭据属于谁，摆在哪一行底下就说清楚了。 */
function renderTransEngines() {
    const box = $('w-transEngList');
    if (!box) return;
    const body = $('w-transBody');
    const home = $('w-transBodyHome');
    // 上一次可能把它搬进了某一行 → 先让它回家（DOM 只有一份）
    if (body && home && body.parentElement !== home) home.appendChild(body);
    if (!TRANS_ENGS.length) {
        box.innerHTML = '<div class="dep-tip">读不到引擎列表（后端没起来？重开设置页试试）</div>';
        return;
    }
    const cur = CONF.transEngine || 'siliconflow';
    const multi = Array.isArray(CONF.transMulti) ? CONF.transMulti : [];
    box.innerHTML = '';
    for (const e of TRANS_ENGS) {
        const isCur = e.id === cur;
        const row = document.createElement('div');
        row.className = 'eng-row' + (isCur ? ' on open' : '');
        row.dataset.id = e.id;
        if (!isCur) row.addEventListener('click', () => pickTransEngine(e.id));

        const dot = document.createElement('span');
        dot.className = 'eng-dot';
        dot.setAttribute('aria-hidden', 'true');
        row.appendChild(dot);

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'eng-name';
        name.title = isCur
            ? `当前默认引擎：${e.name}${e.note ? '\n' + e.note : ''}`
            : `设为默认引擎：${e.name}${e.note ? '\n' + e.note : ''}`;
        const b = document.createElement('b');
        b.textContent = e.name;
        name.appendChild(b);
        name.addEventListener('click', (ev) => {
            ev.stopPropagation();
            pickTransEngine(e.id);
        });
        row.appendChild(name);

        if (isCur) {
            row.appendChild(engTag('默认', '这一家是默认引擎：每次翻译一定用它'));
        }
        if (multi.indexOf(e.id) >= 0) {
            row.appendChild(engTag(
                '同时翻译',
                e.ready
                    ? '每次翻译都会连它一起翻'
                    : '还没填凭据 —— 一起翻时它那一格会显示失败原因',
                !e.ready
            ));
        }

        if (e.signup) {
            const help = document.createElement('button');
            help.type = 'button';
            help.className = 'eng-help';
            help.textContent = '?';
            help.title = `打开「${e.name}」申请 API 的官方页面`;
            help.addEventListener('click', (ev) => {
                ev.stopPropagation();
                invoke('trans_open_help', { engine: e.id })
                    .then((u) => toast('已打开申请页面：' + u))
                    .catch((err) => toast('打不开浏览器：' + err));
            });
            row.appendChild(help);
        }
        if (e.docs) {
            const doc = document.createElement('button');
            doc.type = 'button';
            doc.className = 'eng-help doc';
            doc.textContent = '文档';
            doc.title = `打开「${e.name}」的接口文档`;
            doc.addEventListener('click', (ev) => {
                ev.stopPropagation();
                invoke('trans_open_docs', { engine: e.id })
                    .then((u) => toast('已打开文档：' + u))
                    .catch((err) => toast('打不开浏览器：' + err));
            });
            row.appendChild(doc);
        }

        const chev = document.createElement('span');
        chev.className = 'eng-chev';
        chev.textContent = '▾';
        row.appendChild(chev);

        box.appendChild(row);

        if (isCur && body) {
            row.appendChild(body);
            body.hidden = false;
        }
    }
}

/* 「同时翻译」多选。默认引擎**不在这里**（它一定参与），这里只列"另外还要
 * 一起翻"的那几家；勾选结果原样发给 trans_set_multi，后端清洗后回传。 */
function renderTransMulti() {
    const box = $('w-transMultiBox');
    if (!box) return;
    const cur = CONF.transEngine || 'siliconflow';
    const multi = Array.isArray(CONF.transMulti) ? CONF.transMulti : [];
    const others = TRANS_ENGS.filter((e) => e.id !== cur);
    box.innerHTML = '';
    if (!others.length) {
        box.innerHTML = '<div class="dep-tip">引擎名单还没读到…</div>';
        return;
    }
    for (const e of others) {
        const on = multi.indexOf(e.id) >= 0;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'multi-chip' + (on ? ' on' : '') + (on && !e.ready ? ' warn' : '');
        chip.dataset.id = e.id;
        chip.title = on
            ? `取消勾选：下次翻译不再连「${e.name}」一起翻`
            : `勾上：每次翻译都连「${e.name}」一起翻` +
              (e.ready ? '' : '（它还没填凭据，那一格会显示失败原因）');
        const tick = document.createElement('span');
        tick.className = 'multi-tick';
        tick.textContent = on ? '✓' : '+';
        chip.appendChild(tick);
        const nm = document.createElement('span');
        nm.textContent = e.name;
        chip.appendChild(nm);
        if (!e.ready) {
            const w = document.createElement('i');
            w.className = 'multi-warn';
            w.textContent = '没配';
            chip.appendChild(w);
        }
        chip.addEventListener('click', () => toggleTransMulti(e.id));
        box.appendChild(chip);
    }
    const tip = $('w-transMultiTip');
    if (tip) tip.textContent = '';
}

function toggleTransMulti(id) {
    const list = Array.isArray(CONF.transMulti) ? CONF.transMulti.slice() : [];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.push(id);
    saveTransMulti(list);
}

/** 存名单。后端回传**清洗过**的名单，拿它覆盖本地 CONF。 */
function saveTransMulti(list) {
    invoke('trans_set_multi', { engines: list })
        .then((cleaned) => {
            CONF.transMulti = Array.isArray(cleaned) ? cleaned : [];
            renderTransEngines();
            renderTransMulti();
        })
        .catch((e) => toast('保存同时翻译名单失败：' + e));
}

function pickTransEngine(id) {
    if ((CONF.transEngine || 'siliconflow') === id) return;
    invoke('set_setting', { key: 'transEngine', value: id })
        .then(() => {
            CONF.transEngine = id;
            renderTransEngines();
            renderTransCred();
            renderTransMulti();
            // 新默认引擎原来可能在「同时翻译」名单里（名单不含默认引擎）→
            // 让后端把它剔掉，别让配置文件里留一条永远不生效的勾
            if (Array.isArray(CONF.transMulti) && CONF.transMulti.indexOf(id) >= 0) {
                saveTransMulti(CONF.transMulti);
            }
        })
        .catch((e) => toast('切换失败：' + e));
}

/* 当前引擎要填的凭据。填哪几样由**注册表**决定（need_key / need_base /
 * need_model），所以按 need* 逐个生成输入框 —— 加一家引擎不用改界面代码。 */
function renderTransCred() {
    const box = $('w-transCredBox');
    if (!box) return;
    /* ⚠ 正在这个框里打字时**不许重建**（凭据的落库时机是 change，而配置广播
     * 很频繁；无条件重建会把刚敲的字冲掉）。同 renderOcrCred 的教训。 */
    if (qsEditingIn('w-transCredBox')) return;
    const title = $('w-transCredTitle');
    const tip = $('w-transCredTip');
    const e = transEngById(CONF.transEngine || 'siliconflow');
    box.innerHTML = '';
    if (!e) {
        if (title) title.textContent = '凭据';
        if (tip) tip.textContent = '';
        return;
    }
    if (title) title.textContent = `${e.name} 的凭据`;
    if (tip) tip.textContent = '';

    const creds = (CONF.transCreds || {})[e.id] || {};
    const fields = [];
    if (e.needKey) {
        // 标签按引擎来：百度是「APP ID」、有道是「应用 ID」，其余是「API Key」。
        const keyLabel = e.id === 'baidu' ? 'APP ID'
            : e.id === 'youdao' ? '应用 ID' : 'API Key';
        fields.push(['key', keyLabel, creds.key, true, '粘贴 ' + keyLabel]);
    }
    // 副凭据：百度要「密钥」、有道要「应用密钥」—— 少一样都签不出请求。
    if (e.needSecret) {
        const secLabel = e.id === 'baidu' ? '密钥' : '应用密钥';
        fields.push(['secret', secLabel, creds.secret, true, '粘贴 ' + secLabel]);
    }
    if (e.needBase) fields.push(['base', '接口地址', creds.base, false, e.base || 'https://…/v1']);
    // 模型那一栏：注册表说"这家靠模型名工作"（modelRow）或强制要填（needModel）就显示。
    // 翻译全部走对话模型，所以「拉取模型」拉回来的就是能对话的那批（后端已过滤）。
    if (e.modelRow || e.needModel) {
        fields.push(['model', '模型名', creds.model, false,
            e.model || (e.needModel ? '填模型名或接入点 ID' : '模型名')]);
    }

    const pulled = TRANS_MODELS[e.id] || [];
    for (const [f, label, val, secret, ph] of fields) {
        const row = document.createElement('div');
        row.className = 'cred-row';
        const lab = document.createElement('label');
        lab.textContent = label;
        const inp = document.createElement('input');
        inp.className = 'txt';
        inp.spellcheck = false;
        if (secret) inp.type = 'password';
        inp.placeholder = ph;
        inp.value = val || '';
        inp.dataset.field = f;
        inp.addEventListener('change', () => saveTransCred(e.id));
        row.appendChild(lab);
        if (secret) {
            const wrap = document.createElement('span');
            wrap.className = 'cred-eye-wrap';
            wrap.appendChild(inp);
            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'cred-eye-btn';
            eye.tabIndex = -1;
            eye.title = '显示 / 隐藏';
            eye.setAttribute('aria-label', '显示或隐藏');
            eye.innerHTML = '<svg class="ic-eye" viewBox="0 0 24 24" fill="none" '
                + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
                + '<svg class="ic-eye-off" viewBox="0 0 24 24" fill="none" '
                + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94'
                + 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19'
                + 'm-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
            eye.addEventListener('click', () => {
                inp.type = inp.type === 'password' ? 'text' : 'password';
                eye.classList.toggle('on', inp.type === 'text');
                inp.focus();
            });
            wrap.appendChild(eye);
            row.appendChild(wrap);
        } else {
            row.appendChild(inp);
        }
        if (f === 'model') {
            inp.setAttribute('list', 'transModelList');
            let dl = document.getElementById('transModelList');
            if (!dl) {
                dl = document.createElement('datalist');
                dl.id = 'transModelList';
                document.body.appendChild(dl);
            }
            const ids = pulled.map((m) => m.id);
            if (e.model && ids.indexOf(e.model) < 0) ids.unshift(e.model);
            dl.innerHTML = '';
            for (const id of ids) {
                const o = document.createElement('option');
                o.value = id;
                dl.appendChild(o);
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dep-btn ghost cred-pull';
            btn.textContent = pulled.length ? `拉取模型（${pulled.length}）` : '拉取模型';
            btn.title = pulled.length
                ? `已拉到 ${pulled.length} 个模型（列在下面，点一下就能选用）；再点一次重新拉`
                : '按上面填的 Key 去这家拉一次模型列表，然后就能在这里挑';
            btn.addEventListener('click', () => pullTransModels(e.id));
            row.appendChild(btn);
        }
        box.appendChild(row);
    }

    if (pulled.length) {
        renderTransModelPanel(box, e.id, pulled,
            box.querySelector('input[data-field="model"]'));
    }

    // 状态行 + 「测试连接」：填完 Key 点一下就知道到底通不通
    const st = document.createElement('div');
    st.className = 'cred-foot';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'dep-btn';
    test.textContent = '测试连接';
    test.title = '真翻一句固定的话，确认 Key / 地址 / 模型名是不是真的能用';
    test.addEventListener('click', () => runTransTest(e.id, test, st));
    const hint = document.createElement('span');
    hint.className = 'cred-status';
    hint.textContent = '';
    st.appendChild(test);
    st.appendChild(hint);
    box.appendChild(st);
}

/** 把拉到的模型列表**陈列**在模型行下方，点一下选用（同 OCR 那一套：
 *  WebView2 的 datalist 没有可见下拉入口，光塞进去用户不知道去哪挑）。 */
function renderTransModelPanel(box, id, models, inp) {
    const wrap = document.createElement('div');
    wrap.className = 'cred-models';
    wrap.dataset.engine = id;

    const h = document.createElement('div');
    h.className = 'cred-models-h';
    h.setAttribute('role', 'button');
    h.tabIndex = 0;
    const ht = document.createElement('b');
    ht.textContent = '模型列表';
    const hn = document.createElement('small');
    const chat = models.filter((m) => m.chat).length;
    hn.textContent = `${models.length} 个 · ${chat} 个能对话 · 点一下选用`;
    const arrow = document.createElement('i');
    arrow.className = 'cm-arrow';
    arrow.textContent = '▾';
    h.appendChild(ht);
    h.appendChild(hn);
    h.appendChild(arrow);
    const toggle = () => wrap.classList.toggle('shut');
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });

    const body = document.createElement('div');
    body.className = 'cred-models-b';
    for (const m of models) {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'cred-model-item'
            + (m.chat ? ' vis' : '')
            + (inp && inp.value === m.id ? ' sel' : '');
        it.title = m.chat ? '选用这个模型（名字看着能对话）' : '选用这个模型';
        const nm = document.createElement('span');
        nm.className = 'cm-id';
        nm.textContent = m.id;
        it.appendChild(nm);
        if (m.chat) {
            const b = document.createElement('i');
            b.className = 'v-badge';
            b.textContent = '对话';
            it.appendChild(b);
        }
        it.addEventListener('click', () => {
            if (inp) {
                inp.value = m.id;
                inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            body.querySelectorAll('.cred-model-item').forEach((x) => x.classList.remove('sel'));
            it.classList.add('sel');
        });
        body.appendChild(it);
    }

    wrap.appendChild(h);
    wrap.appendChild(body);
    box.appendChild(wrap);
}

/* ------------------------------------------------------------------ */
/* 测试连接 / 拉取模型                                                  */
/* ------------------------------------------------------------------ */

let TRANS_MODELS = {};    // engineId -> [{id, chat}]
let transTestBusy = false;

/* trans_test 是**一问一答**的命令（后端真翻一句固定的话），结果直接在返回值里，
 * 不像 OCR 那样走事件 —— 翻译没有"异步回推"的必要。 */
async function runTransTest(id, btn, st) {
    if (transTestBusy) return;
    transTestBusy = true;
    const old = btn.textContent;
    btn.textContent = '测试中…';
    st.className = 'cred-status';
    st.textContent = '正在真翻一句…';
    try {
        const out = await invoke('trans_test', { engine: id });
        st.className = 'cred-status ok';
        st.textContent = '✓ ' + String(out || '');
    } catch (e) {
        st.className = 'cred-status bad';
        st.textContent = '✗ ' + String(e || '').slice(0, 160);
    } finally {
        btn.textContent = old;
        transTestBusy = false;
    }
}

async function pullTransModels(id) {
    const e = transEngById(id);
    if (!e) return;
    // 先用界面上**当前**的值存一次：用户可能刚改了 Key 还没失焦
    saveTransCred(id);
    toast('正在拉模型列表…');
    try {
        /* 翻译方向只要**对话**模型（后端 list_models 已按 looks_chat 过滤排序），
         * 所以不像 OCR 那样传 visionOnly —— 这里没有可传的开关，口径在后端。 */
        await invoke('trans_list_models', { engine: id });
    } catch (err) {
        toast('拉模型列表失败：' + err);
    }
}

function onTransModels(p) {
    if (!p || !p.ok) {
        toast('拉不到模型列表：' + ((p && p.msg) || '未知原因'));
        return;
    }
    TRANS_MODELS[p.engine] = p.models || [];
    toast(p.msg);
    renderTransCred();
}

/* 存某家引擎的凭据：三样一起发给后端（它按注册表决定用哪几样），空串 = 清掉。
 * 存完重新拉一次注册表 —— ready 标记（"已填好 / 还没填全"）要跟着变。 */
function saveTransCred(id) {
    const box = $('w-transCredBox');
    if (!box || !transEngById(id)) return;
    const get = (f) => {
        const el = box.querySelector(`input[data-field="${f}"]`);
        return el ? el.value : '';
    };
    const body = {
        engine: id,
        key: get('key'),
        secret: get('secret'),
        base: get('base'),
        model: get('model'),
    };
    invoke('trans_set_cred', body)
        .then(() => invoke('trans_engines_list'))
        .then((list) => {
            TRANS_ENGS = Array.isArray(list) ? list : TRANS_ENGS;
            CONF.transCreds = CONF.transCreds || {};
            CONF.transCreds[id] = {
                key: body.key,
                secret: body.secret,
                base: body.base,
                model: body.model,
            };
            renderTransCred();
            renderTransEngines();
            renderTransMulti();
        })
        .catch((err) => toast('保存失败：' + err));
}

/* 默认目标语言下拉框。
 *
 * 语言表**只有 Rust 一份**（`trans::LANGS`），这里启动时拉一次 `trans_langs`
 * 现填 —— 以后加语言只改 Rust，界面不用动。填充只做一次（options 建好就
 * 不动了）：每次配置广播都重建会把人正在看的选项晃没。 */
let transLangsFilled = false;
async function transFillLangs() {
    const sel = $('w-transTarget');
    if (!sel || transLangsFilled) return;
    let langs = [];
    try { langs = await invoke('trans_langs'); } catch (e) { langs = []; }
    langs = Array.isArray(langs) ? langs : [];
    sel.textContent = '';
    for (const l of langs) {
        const o = document.createElement('option');
        o.value = l.code;
        o.textContent = l.label;
        sel.appendChild(o);
    }
    transLangsFilled = true;
    transSyncLang();
}

/* 把下拉框刷成配置里的默认语言。
 *  ⚠ 聚焦时不刷：用户正开着下拉选呢，一广播就把人家选中的项跳回去了。
 *  ⚠ 配置里的值不在选项里（脏配置 / 后端归一失败）时落回 'zh'。 */
function transSyncLang() {
    const sel = $('w-transTarget');
    if (!sel || !sel.options.length) return;
    if (document.activeElement === sel) return;
    const codes = Array.prototype.map.call(sel.options, (o) => o.value);
    let want = CONF.transTarget;
    if (codes.indexOf(want) < 0) want = codes.indexOf('zh') >= 0 ? 'zh' : codes[0];
    if (want) sel.value = want;
}

/* 「把翻译加进横条」：加的是 @trans 哨兵，加完就是横条里的一分子，
 * 去「引擎」页拖它就能改位置。已经在横条里时按钮隐藏（同 OCR 那颗）。 */
$('btnTransInBar').addEventListener('click', async () => {
    await invoke('toggle_bar_engine', { engine: QS_TRANS, on: true });
    toast('已加进横条，去「引擎」页拖它可以改位置');
});

function syncTransInBarBtn() {
    const b = $('btnTransInBar');
    if (!b) return;
    b.hidden = (CONF.barList || []).includes(QS_TRANS);
}

/* 目标语言下拉的 change：写配置 + 立刻更新本地 CONF（不能等广播）。 */
{
    const sel = $('w-transTarget');
    if (sel) sel.addEventListener('change', () => {
        invoke('set_setting', { key: 'transTarget', value: sel.value });
        if (window.CONF) window.CONF.transTarget = sel.value;
    });
}

/* 选了「Windows 本地」引擎时，百度云那几个配置项（API Key / Secret Key /
 * 识别语言 / 识别精度）就完全用不到了 —— 留着只会让人以为还缺配置。
 * 把它们整体隐藏；切回「百度云」再显示回来。 */
function syncOcrEngineUI() {
    const useBaidu = (CONF.ocrEngine || 'baidu') === 'baidu';
    for (const r of document.querySelectorAll('[data-baidu-only]')) {
        r.style.display = useBaidu ? '' : 'none';
    }
    // r46：切到「Windows 本地」也**不再自动检测**（同上，改成按需）。
    if (!useBaidu) renderOcrDep();
    // 引擎列表和凭据表单也跟着当前引擎走（需求 2）
    renderOcrEngines();
    renderOcrCred();
}

/* ------------------------------------------------------------------ */
/* 多引擎选择（需求 2）                                                 */
/* ------------------------------------------------------------------ */

/* 用户原话：「多添加一些在线 OCR 的方式，在线 OCR 的引擎。尽可能的多添加
 * （每一个在线引擎旁边加一个问号按钮，点击后跳转到申请 api 的官方教程）」
 *
 * ⚠ 引擎名单**不在前端维护**：全部来自后端注册表（命令 ocr_engines_list）。
 *   前端要是自己抄一份，以后加一家引擎就得改两个地方，迟早对不上 ——
 *   而"界面上找不到刚加的那家引擎"是最难查的一类问题。
 *
 * 每家的问号按钮 → ocr_open_help(id)：后端用系统默认浏览器打开**那家申请 API
 * 的官方页面**（不是我们自己写的说明页 —— 用户要的就是官方教程）。
 */
let ENGINES = [];

async function loadOcrEngines() {
    try {
        ENGINES = await invoke('ocr_engines_list');
    } catch (e) {
        ENGINES = [];
    }
    renderOcrEngines();
    renderOcrCred();
    renderOcrMulti();
}

function engineById(id) {
    return ENGINES.find((e) => e.id === id) || null;
}

/* ==========================================================================
 *  r54：识图搜索（需求 1）
 *
 *  用户原话：「在设置中新增独立设置栏，尽可能集成丰富的识图搜索引擎」——
 *  所以这是设置里**独立的一栏**（左边导航「识图搜索」），并且引擎名单同样
 *  不在前端维护：命令 img_engines_list 从后端注册表拿（见 src/imgsearch.rs）。
 *
 *  一张表驱动的三件事：
 *    ① 勾选框（多选）：写成 imgEngines，勾几个就同时搜几个，各开一个新标签页；
 *    ② 默认引擎（单选 seg）：写成 imgDefaultEngine，设了它截图完成直接跳这家；
 *    ③ 公网图片地址（文本框）：写成 imgPublicUrl，只对 Url 类引擎有用。
 *
 *  ⚠ 每种引擎能干什么、为什么默认只勾 Yandex + SauceNAO，见 imgsearch.rs 的模块
 *    注释（Upload / Page / Url 三种模式的取舍，是这一功能的设计地基；
 *    默认名单 = r70 实测通过的两家真上传）。
 * ========================================================================== */
let IMG_ENGINES = [];

/** 每种模式在界面上怎么说 —— 与后端 imgsearch::Mode 三个值一一对应。
 *
 *  r61：淘汰了 `form`（浏览器表单提交）和"粘贴+回车"两套过渡方案 ——
 *  用户要求「原来通过按键的一些形式就全部撤销」，并要"框选完直接出结果"。
 *  现在 `upload` 就是**软件自己 POST 上传、拿结果页 URL 开浏览器**。 */
const IMG_MODE_TEXT = {
    upload: ['真搜索', '框选完直接传到对方、落在结果页上'],
    page: ['打开页面', '只打开这一家的页面，不再模拟任何按键'],
    url: ['按图片地址', '只看不传：拼一个带公网图片地址的搜索链接'],
};

async function loadImgEngines() {
    const box = $('w-imgEngList');
    try {
        const list = await invoke('img_engines_list');
        // 收成数组：后端万一回了 null / 一个对象（老版本、异常路径），
        // 也不能让设置页白屏 —— 那正是"点了没反应"最难查的一类
        IMG_ENGINES = Array.isArray(list) ? list : [];
    } catch (e) {
        IMG_ENGINES = [];
    }
    renderImgEngines();
}

/* ==========================================================================
 *  r56：识图引擎一行一家（用户原话见下）
 *
 *  「识图搜索这一栏的引擎，不要一个胶囊显示所有的引擎，应该每个引擎单独一行显示，
 *    每个引擎都可以自定义图标，也可以在每个引擎旁边点击默认按钮，把这个引擎设为
 *    默认，同时每个引擎旁边也要设置一个问号按钮，点击之后就会跳转到申请该引擎
 *    api 的相关教程。」
 *
 *  改法：把原来「顶部一排胶囊选默认 + 下面一张多选表」**合并成一张表**，
 *  每行自带四样东西（复选框 / 图标 / 默认按钮 / 问号按钮）。
 *  原来的 `renderImgDefault()`（那排胶囊）因此**整个删掉** —— 一行一家之后
 *   "默认"这件事在行上就能做，再留一排胶囊是重复入口，两处还会各存一份状态。
 *
 *  每行的构成（从左到右）：
 *    ① 复选框   —— 参与多选搜索（写 imgEngines）
 *    ② 图标     —— overrideIcons 里挑过的图 > icons 目录同名默认图 > 首字徽标
 *    ③ 名字+说明 —— 说明里带"全自动 / 要粘贴 / 要图片地址"
 *    ④ 模式徽标 —— post / paste / url 三色，标黄的是不能一步到位的
 *    ⑤ [默认]    —— 点了把它设成 imgDefaultEngine（截图完成直接跳它）
 *    ⑥ [换图标]  —— pick_icon，和横条换图标同一套机制
 *    ⑦ [?]       —— img_open_help，后端注册表里的官方页 / 教程地址
 *
 *  ⚠ 点击穿透要自己管：复选框那格是 <label>（点它只切勾选），
 *    三颗按钮各自 stopPropagation + 不冒泡到行。
 *  ⚠ 每次配置广播都会调这个函数，第一句必须 innerHTML = ''（否则行数翻倍，
 *    这个坑 OCR 那边注释里也记着）。
 * ========================================================================== */
function renderImgEngines() {
    const box = $('w-imgEngList');
    if (!box) return;
    /* ⚠ 清空必须放在**最前面**，不能只放在后面那条分支里。
     *   以前是「列表为空 → 写一句提示 → return」，那个分支不清 DOM ——
     *   上一次已经画出的十几行会留在原地，提示语追加在后面，看着像
     *   "加载失败但还能点"。 */
    box.innerHTML = '';
    if (!IMG_ENGINES.length) {
        box.innerHTML = '<div class="dep-tip">读不到引擎列表（后端没起来？重开设置页试试）</div>';
        return;
    }
    const conf = CONF || {};
    const picked = Array.isArray(conf.imgEngines) ? conf.imgEngines.slice() : [];
    const def = (conf.imgDefaultEngine || '') + '';
    // 后端发来的就是归过序的（默认那两家在最前），界面按注册表顺序画，
    // 不按用户勾选先后重排 —— 「标签页顺序稳定」是用户看得见的一条。
    IMG_ENGINES.forEach((e) => {
        const on = picked.indexOf(e.id) >= 0;
        const isDef = def === e.id;
        const mode = IMG_MODE_TEXT[e.mode] || ['', ''];
        const row = document.createElement('div');
        row.className = 'eng-row img-row' + (on ? ' on' : '') + (isDef ? ' def' : '');
        row.dataset.id = e.id;

        /* ---- ① 复选框（多选：勾几个就同时搜几个）---- */
        const label = document.createElement('label');
        label.className = 'eng-check';
        label.title = on ? `取消勾选：识图时不再搜「${e.name}」` : `勾上：识图时同时搜「${e.name}」`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = on;
        cb.dataset.id = e.id;
        cb.addEventListener('change', () => {
            // 勾选立刻落库（不用等"保存"按钮 —— 设置页没有那个概念）
            const cur = Array.isArray(CONF.imgEngines) ? CONF.imgEngines : [];
            const arr = cur.slice();
            const at = arr.indexOf(e.id);
            if (cb.checked && at < 0) arr.push(e.id);
            if (!cb.checked && at >= 0) arr.splice(at, 1);
            CONF.imgEngines = arr;
            invoke('set_setting', { key: 'imgEngines', value: arr }).catch(() => {});
            row.classList.toggle('on', cb.checked);
            label.title = cb.checked
                ? `取消勾选：识图时不再搜「${e.name}」`
                : `勾上：识图时同时搜「${e.name}」`;
        });
        label.appendChild(cb);
        row.appendChild(label);

        /* ---- ② 图标：换过的是用户的图，没换过是首字徽标 ----
         * 优先级和横条上那颗完全一致（overrideIcons > icons 目录同名 > 徽标），
         * 所以"设置里看到的"和"横条上看到的"对得上。 */
        const ico = document.createElement('span');
        ico.className = 'eng-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.appendChild(imgEngineIconNode(e));
        row.appendChild(ico);

        /* ---- ③ 名字 + 说明 ---- */
        const nm = document.createElement('span');
        nm.className = 'n';
        const b = document.createElement('b');
        b.textContent = e.name;
        const small = document.createElement('small');
        small.textContent = e.note || mode[1] || '';
        nm.appendChild(b);
        nm.appendChild(small);
        row.appendChild(nm);

        /* ---- ④ 模式徽标：告诉用户"这家打开之后要不要你自己动手" ----
         * 不说清楚的话，用户勾了 AI 那几家发现页面没自动出结果，只会觉得软件坏了。
         * r59：三档的颜色各有含义 ——
         *   `upload`（真提交）= 不标黄，绿色，最省事；
         *   `page`（打开页面）= 标黄，要你补一下粘贴/选文件；
         *   `url`（按图片地址）= 不标黄，但下面会另加一颗"要填图片地址"。 */
        const tag = document.createElement('span');
        tag.className = 'eng-tag mode mode-' + e.mode + (e.mode === 'page' ? ' warn' : '');
        tag.textContent = mode[0] || e.mode;
        tag.title = mode[1] || '';
        row.appendChild(tag);

        // Url 类：没填公网地址时它是搜不动的，当场标黄
        if (e.mode === 'url' && !((conf.imgPublicUrl || '') + '').trim()) {
            const warn = document.createElement('span');
            warn.className = 'eng-tag warn';
            warn.textContent = '要填图片地址';
            warn.title = '下面「公网图片地址」没填，这家暂时不会参与搜索';
            row.appendChild(warn);
        }

        /* ---- ⑤ 「设为默认」按钮 ----
         * 已经是默认了就渲染成静态徽标（点击无效），不然用户会以为
         * "再点一次能取消" —— 取消默认有顶部那句「不设」之外的另一种做法：
         * 把别家设为默认。这里不给重复入口，避免两种取消方式语义打架。 */
        const defBtn = document.createElement('button');
        defBtn.type = 'button';
        defBtn.className = 'eng-btn def' + (isDef ? ' on' : '');
        if (isDef) {
            defBtn.textContent = '当前默认';
            defBtn.title = `截图完成直接搜「${e.name}」，不再让你选。把别家设为默认即可换掉`;
        } else {
            defBtn.textContent = '设为默认';
            defBtn.title = `设为默认引擎：截图完成直接搜「${e.name}」，不再让你选`;
            defBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // r70：抽成共享函数 —— paintImgDefaultMove 动态造的那颗按钮
                // 走同一条路（以前它漏了"自动勾选"那半截，见 setImgDefault 注释）
                setImgDefault(e.id, row);
            });
        }
        row.appendChild(defBtn);

        /* ---- ⑥ 「换图标」：和横条换图标同一套机制 ---- */
        const ic = document.createElement('button');
        ic.type = 'button';
        ic.className = 'eng-btn ico';
        ic.title = conf.overrideIcons && conf.overrideIcons[e.id]
            ? `给「${e.name}」换一张图标（当前是你在图库里挑的那张）`
            : `给「${e.name}」挑一张图标（挑完横条上也跟着变）`;
        ic.appendChild(imgEngineIconNode(e, true));
        ic.addEventListener('click', (ev) => {
            ev.stopPropagation();
            invoke('pick_icon', { engine: e.id }).catch((err) => toast('打不开图库：' + err));
        });
        row.appendChild(ic);

        /* ---- ⑦ 「?」：官方页 / 教程 ---- */
        const help = document.createElement('button');
        help.type = 'button';
        help.className = 'eng-help';
        help.textContent = '?';
        help.title = `打开「${e.name}」的官方页面 / 使用教程`;
        help.addEventListener('click', (ev) => {
            ev.stopPropagation();
            invoke('img_open_help', { engine: e.id })
                .then((u) => toast('已打开：' + u))
                .catch((err) => toast('打不开浏览器：' + err));
        });
        row.appendChild(help);

        box.appendChild(row);
    });
}

/** 识图引擎行上那颗小图标：overrideIcons > icons 目录同名 > 首字徽标。
 *  `bare` = 只要图标节点本身（用在「换图标」按钮里），不要外面那层壳。 */
function imgEngineIconNode(e, bare) {
    const conf = CONF || {};
    const custom = conf.overrideIcons ? conf.overrideIcons[e.id] : null;
    const dir = window.qsDirIconFor ? window.qsDirIconFor(e.name) : null;
    if (custom || dir) {
        const img = document.createElement('img');
        img.src = custom || dir;
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        if (window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(img, conf.unifyIcons !== false);
        }
        return img;
    }
    // 首字徽标：颜色按名字散列，同一家永远同一个色（和横条上的徽标同算法）
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = (e.name.match(/[A-Za-z0-9\u4e00-\u9fa5]/) || [e.name.charAt(0)])[0].toUpperCase();
    return span;
}

/** 把某家识图引擎设为默认（renderImgEngines 的按钮和 paintImgDefaultMove
 *  动态造的那颗按钮**共用**这一条路）。
 *
 *  r59：设成默认的这家**同时自动勾进多选名单**。
 *  用户原话：「我设置默认引擎之后，那一个引擎就不会被默认打勾、默认勾选。」
 *  —— 默认引擎不参与搜索是自相矛盾的：设了默认就等于"截图完就搜它"，
 *  可它连勾都没勾，界面看着像没生效。两处状态不能打架。
 *
 *  ⚠ r70：这条逻辑以前只写在 renderImgEngines 的按钮里，而
 *  paintImgDefaultMove 换默认时动态造的那颗按钮**另写了一份**、漏了自动勾选
 *  这半截 —— 症状：第一次设默认好好的，换一家默认，新默认那行复选框不亮，
 *  名单里也没有它（用户报"设了默认却没打勾"的第二条路径）。抽成共享函数，
 *  两条路从此一个行为。
 *
 *  @param id  引擎 id
 *  @param row 那一行的 DOM（拿来同步复选框与底色；找不到就只改状态） */
function setImgDefault(id, row) {
    if (!CONF) return;
    const e = IMG_ENGINES.find((x) => x.id === id);
    if (!e) return;
    const cur = Array.isArray(CONF.imgEngines) ? CONF.imgEngines.slice() : [];
    const needAdd = cur.indexOf(id) < 0;
    if (needAdd) cur.push(id);
    CONF.imgDefaultEngine = id;
    CONF.imgEngines = cur;
    /* ⚠ 两个键必须**一次**写下去。
     *
     * 以前是两条独立的 `set_setting`：每条各自 `config::save` + `broadcast()`，
     * 于是中间那一份广播里 `imgDefaultEngine` 已经是新引擎、`imgEngines` 还是
     * 旧的 —— 界面重画后那一行显示"当前默认"但复选框没勾上，正是上面
     * paintImgDefaultMove 注释里说"已经修好"的那个症状的另一条来源。
     * `set_settings` 是批量入口，一次落两键、一次广播。 */
    invoke('set_settings', {
        pairs: needAdd
            ? [['imgDefaultEngine', id], ['imgEngines', cur]]
            : [['imgDefaultEngine', id]],
    }).catch(() => {});
    if (needAdd && row) {
        // 同步这一行的复选框与底色（不整表重画，理由见 paintImgDefaultMove）
        const box = row.querySelector('.eng-check input[type=checkbox]');
        if (box) box.checked = true;
        row.classList.add('on');
    }
    // 不整表重画：只把上一行的"当前默认"退回按钮、这一行反过来。
    // 整表重画会让用户正在看的滚动位置跳回去（列表有十几行，实测会滚到顶）
    // —— 只为改一个徽标不值得。
    paintImgDefaultMove(id);
    toast(`默认引擎：${e.name}（已同时勾选）`);
}

/** 换默认引擎时只改两行的样子，不整表重画（重画会把滚动位置弹回顶部）。 */
function paintImgDefaultMove(newId) {
    for (const row of document.querySelectorAll('#w-imgEngList .img-row')) {
        const isIt = row.dataset.id === newId;
        row.classList.toggle('def', isIt);
        const btn = row.querySelector('.eng-btn.def');
        if (!btn) continue;
        const e = IMG_ENGINES.find((x) => x.id === row.dataset.id);
        if (!e) continue;
        if (isIt) {
            btn.classList.add('on');
            btn.textContent = '当前默认';
            btn.title = `截图完成直接搜「${e.name}」，不再让你选。把别家设为默认即可换掉`;
            // 已经是默认了，这一颗不再接受点击（换成静态徽标）。
            // ⚠ cloneNode 不带事件监听 —— 这正是"不再接受点击"的实现方式，
            //   别改成"保留监听再加判断"，那会多一个永远不生效的分支。
            btn.replaceWith(btn.cloneNode(true));
        } else if (btn.classList.contains('on')) {
            const nb = document.createElement('button');
            nb.type = 'button';
            nb.className = 'eng-btn def';
            nb.textContent = '设为默认';
            nb.title = `设为默认引擎：截图完成直接搜「${e.name}」，不再让你选`;
            nb.addEventListener('click', (ev) => {
                ev.stopPropagation();
                setImgDefault(e.id, row);
            });
            btn.replaceWith(nb);
        }
    }
}

/* 引擎列表：一行一家 —— 但**只展开当前默认的那一家**。
 *
 * 用户 r47 原话：「现在的 ocr 引擎有这么多，但却一次性把它全部显示出来了，
 * 就很占用显示空间，就可以提供一个选项，你选择了哪一个，就会只显示那一个折叠，
 * 其他的，然后再可以配置相关的数据，同时也刚好把选择那一个作为默认的 ocr 引擎」。
 * 于是这一块围着"默认引擎"一个概念干三件事：
 *   ① 单选：点一行 = 把它设为默认引擎（写入 `ocrEngine`）；
 *   ② 手风琴：只有默认那一家展开（凭据 / 测试连接 / 同时识别都在展开块里），
 *      其余十几家折成一行名字；
 *   ③ 「?」/「文档」：每家在线引擎的申请页与接口文档。
 *
 * ⚠ 展开块 `#w-ocrBody` 是**一整块 DOM**（单例）。每次渲染先把它搬回
 *   `#w-ocrBodyHome`、再搬进当前那一行：列表和它同在一个父节点里，不先搬走，
 *   下面那次 `box.innerHTML = ''` 会连它一起清掉 —— 表现是"切一次引擎，
 *   凭据框就永远不见了"。
 */
function renderOcrEngines() {
    const box = $('w-ocrEngList');
    if (!box) return;
    const body = $('w-ocrBody');
    const home = $('w-ocrBodyHome');
    // 上一次可能把它搬进了某一行 → 先让它回家
    if (body && home && body.parentElement !== home) home.appendChild(body);
    if (!ENGINES.length) {
        box.innerHTML = '<div class="dep-tip">读不到引擎列表（后端没起来？重开设置页试试）</div>';
        return;
    }
    const cur = CONF.ocrEngine || 'baidu';
    const multi = Array.isArray(CONF.ocrMulti) ? CONF.ocrMulti : [];
    box.innerHTML = '';
    for (const e of ENGINES) {
        const isCur = e.id === cur;
        const row = document.createElement('div');
        row.className = 'eng-row' + (isCur ? ' on open' : '');
        row.dataset.id = e.id;
        // 点整行 = 设为默认引擎（已经是默认就不动，免得白写一次配置）
        if (!isCur) row.addEventListener('click', () => pickOcrEngine(e.id));

        // 单选圆点：给"这能选"一个明确的视觉（以前只有一行名字，用户找不到在哪设默认）
        const dot = document.createElement('span');
        dot.className = 'eng-dot';
        dot.setAttribute('aria-hidden', 'true');
        row.appendChild(dot);

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'eng-name';
        /* r77：用户原话「设置文字识别识别引擎这一栏，有 7 行的介绍文字，莫名其妙
         * 的把他们一行行的显示，这样特别占空间，直接把这 7 行文字给去掉」。
         * 于是每个引擎**只留名字**，`e.note` 不再铺在列表里 —— 但**不能丢**：
         * 它挪到 title 提示里（悬停/读屏仍然拿得到），外加每行原有的「?」按钮
         * 直接开官方申请页。信息还在，只是不再占那 7 行高度。 */
        name.title = isCur
            ? `当前默认引擎：${e.name}${e.note ? '\n' + e.note : ''}`
            : `设为默认引擎：${e.name}${e.note ? '\n' + e.note : ''}`;
        const b = document.createElement('b');
        b.textContent = e.name;
        name.appendChild(b);
        // 整行已接管点击；名字这颗按钮自己也处理一次，
        // 保证键盘 Tab + Enter（button 的默认行为）同样能切
        name.addEventListener('click', (ev) => {
            ev.stopPropagation();
            pickOcrEngine(e.id);
        });
        row.appendChild(name);

        if (isCur) {
            row.appendChild(
                engTag('默认', '这一家是默认引擎：横条的 OCR 按钮、快捷键、划词兜底都用它')
            );
        }
        if (multi.indexOf(e.id) >= 0) {
            row.appendChild(
                engTag(
                    '同时识别',
                    e.ready
                        ? '每次识别都会连它一起跑'
                        : '还没填凭据 —— 勾了也会被跳过（识别时会说明原因）',
                    !e.ready
                )
            );
        }

        if (e.online) {
            const help = document.createElement('button');
            help.type = 'button';
            help.className = 'eng-help';
            help.textContent = '?';
            help.title = `打开「${e.name}」申请 API 的官方页面`;
            help.addEventListener('click', (ev) => {
                ev.stopPropagation();
                invoke('ocr_open_help', { engine: e.id })
                    .then((u) => toast('已打开申请页面：' + u))
                    .catch((err) => toast('打不开浏览器：' + err));
            });
            row.appendChild(help);

            const doc = document.createElement('button');
            doc.type = 'button';
            doc.className = 'eng-help doc';
            doc.textContent = '文档';
            doc.title = `打开「${e.name}」的接口文档`;
            doc.addEventListener('click', (ev) => {
                ev.stopPropagation();
                invoke('ocr_open_docs', { engine: e.id })
                    .then((u) => toast('已打开文档：' + u))
                    .catch((err) => toast('打不开浏览器：' + err));
            });
            row.appendChild(doc);
        }

        // 折叠箭头：只表示"这一行现在展开着"（展开与否由"是不是默认引擎"决定）
        const chev = document.createElement('span');
        chev.className = 'eng-chev';
        chev.textContent = '▾';
        row.appendChild(chev);

        box.appendChild(row);

        // 展开块只挂在默认那一家下面（凭据 + 同时识别），别的家没有
        if (isCur && body) {
            row.appendChild(body);
            body.hidden = false;
        }
    }
}

/** 行上的小徽标（默认 / 同时识别）。`warn` = 标黄提醒（比如没填凭据）。 */
function engTag(text, title, warn) {
    const t = document.createElement('span');
    t.className = 'eng-tag' + (warn ? ' warn' : '');
    t.textContent = text;
    if (title) t.title = title;
    return t;
}

/* ==========================================================================
 *  r54 需求 3：数据导入 / 导出（明文）
 *
 *  用户原话：「导出时提供数据项勾选界面……默认仅勾选非隐私内容；导出的配置
 *  数据不加密，可直接被他人导入恢复；备份功能单独存在且支持加密；导入功能
 *  仅支持直接恢复导出的明文数据，不支持导入加密备份。」
 *
 *  ⚠ 这一栏与「备份」那栏是**两件事**，不是同一个功能的两个入口：
 *    · 备份 = 整份配置（.QuickSearch），按备份密码加密，恢复时全量覆盖；
 *    · 数据 = 挑几项，**明文**（.qsconf），可直接发给别人导入，恢复时只合
 *      并勾过的那几项（同事的收藏夹/快捷键不会被我的文件清空）。
 *    两边文件格式不同（备份是裸 config_view，导出带 kind/items/data），
 *    所以导入侧能明确拒绝加密备份、并指路「备份」页。
 * ========================================================================== */
let EXPORT_GROUPS = [];   // 后端 export_groups_list 发来的八组

async function loadExportGroups() {
    try {
        const list = await invoke('export_groups_list');
        EXPORT_GROUPS = Array.isArray(list) ? list : [];
    } catch (e) {
        EXPORT_GROUPS = [];
    }
    renderExportBox();
}

function renderExportBox() {
    const box = $('w-exportBox');
    if (!box) return;
    if (!EXPORT_GROUPS.length) {
        box.innerHTML = '<div class="dep-tip">读不到导出项清单（后端没起来？重开设置页试试）</div>';
        return;
    }
    box.innerHTML = '';
    for (const g of EXPORT_GROUPS) {
        const row = document.createElement('label');
        // 隐私项整行偏红：用户点"导出"之前就该看见哪几项会带走敏感数据
        row.className = 'exp-row' + (g.private ? ' private' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!g.checked;         // 默认勾选状态由后端定（只有一处口径）
        cb.dataset.id = g.id;
        cb.addEventListener('change', () => syncExportCount());
        row.appendChild(cb);
        const t = document.createElement('span');
        t.className = 't';
        const b = document.createElement('b');
        b.textContent = g.name;
        const small = document.createElement('small');
        small.textContent = g.desc;
        t.appendChild(b);
        t.appendChild(small);
        row.appendChild(t);
        box.appendChild(row);
    }
    syncExportCount();
}

/// 当前勾了哪几组（顺序按后端那张表的顺序，与导出文件里的 items 一致）。
function pickedExportGroups() {
    const box = $('w-exportBox');
    if (!box) return [];
    const out = [];
    for (const cb of box.querySelectorAll('input[type=checkbox]')) {
        if (cb.checked) out.push(cb.dataset.id);
    }
    // 按后端顺序排：导出文件里的 items 顺序稳定，导入界面显示也稳定
    return EXPORT_GROUPS.filter((g) => out.indexOf(g.id) >= 0).map((g) => g.id);
}

/// 把勾了几项写在按钮上（「导出选中的数据…」→ 「导出 3 项…」），
/// 并维护「加密导出」勾选框的状态。
///
/// 为什么值得做：这一栏最容易被误用的点就是"不知道自己导出的是什么"，
/// 数字是最省字的一句说明。
///
/// # v1.5.10：隐私项强制加密
///
/// 用户 2026-10-25：「如果导出的数据包括涉及隐私的，那么就强制加密」。
/// 勾到隐私组时把勾选框**勾上并锁住** —— 锁住是必要的：
/// 如果只是"偷偷加密"，用户会以为自己导的是明文（拿去当普通文件处理），
/// 结果打开一堆乱码；如果只弹提示不锁，用户能取消勾选，那"强制"就不成立了。
///
/// ⚠ 前端按"勾了隐私组"锁，后端按"隐私组里真有内容"判 —— 前端更保守。
///   勾了「个人访问令牌」但本机没填令牌时，这里仍然锁住加密，结果只是
///   多加密一次，不会漏。
function syncExportCount() {
    const btn = $('btnDoExport');
    if (btn) {
        const n = pickedExportGroups().length;
        btn.textContent = n ? `导出 ${n} 项…` : '导出选中的数据…';
    }

    const picked = pickedExportGroups();
    const forced = picked.some((id) => {
        const g = EXPORT_GROUPS.find((x) => x.id === id);
        return !!g && !!g.private;
    });
    const cb = $('s-exportEncrypt');
    if (cb) {
        if (forced) {
            cb.checked = true;
            cb.disabled = true;
            cb.dataset.forced = '1';
        } else {
            /* 从"强制"退出来时恢复成未勾选。
             * 不恢复的话，下次只勾普通项时它会带着上次的强制状态 ——
             * 用户会得到一个自己没要求过的加密文件。 */
            if (cb.dataset.forced === '1') {
                cb.checked = false;
                cb.dataset.forced = '';
            }
            cb.disabled = false;
        }
    }
    const wrap = $('exportEncWrap');
    if (wrap) wrap.classList.toggle('locked', forced);
    const hint = $('exportEncHint');
    if (hint) {
        hint.hidden = !forced;
        if (forced) {
            hint.textContent =
                '已勾选隐私项（API Key / 个人访问令牌 / WebDAV 密码 / 备份密码 / 收藏内容），'
                + '这次导出会强制加密 —— 收件方要输入密码才能导入。';
        }
    }
}

/* ==========================================================================
 *  v1.5.10：导入密码框
 *
 *  后端选完文件之后才知道"这份是密码加密的"，所以它发事件，这里弹框。
 *
 *  密码只用来解**这一个文件**：不写配置、不进日志、关掉就丢。
 *  也**不**拿它去改「备份」页那个备份密码 —— 那是另一件事，
 *  改了会连累这台机器上所有其他加密备份。
 * ========================================================================== */
function impPassShow(name) {
    const box = $('impPassBox');
    if (!box) return;
    const sub = $('impPassSub');
    if (sub) {
        sub.textContent = name
            ? `输入导出「${name}」时用的密码`
            : '输入导出这份配置时用的密码';
    }
    const inp = $('impPassInput');
    if (inp) {
        inp.value = '';
        // 焦点必须落在密码框上：用户刚点了"导入"，就该能直接开始打字
        setTimeout(() => inp.focus(), 0);
    }
    const err = $('impPassErr');
    if (err) {
        err.hidden = true;
        err.textContent = '';
    }
    box.hidden = false;
}

function impPassHide() {
    const box = $('impPassBox');
    if (box) box.hidden = true;
}

async function impPassSubmit() {
    const inp = $('impPassInput');
    const err = $('impPassErr');
    const pw = inp ? inp.value : '';
    if (!pw) {
        if (err) {
            err.textContent = '先输入密码';
            err.hidden = false;
        }
        if (inp) inp.focus();
        return;
    }
    const ok = $('btnImpPassOk');
    if (ok) ok.disabled = true;
    try {
        await invoke('import_with_password', { password: pw });
        /* 成功时的 toast 由后端发（它知道导入了多少项）—— 这里只关框，
         * 否则会出现两条内容不一样的"导入成功"。 */
        impPassHide();
    } catch (e) {
        /* 密码错了**绝不关框**：这是最可能的重试场景，
         * 关了用户就得重新走一遍选文件。 */
        if (err) {
            err.textContent = '解不开：' + ((e && e.message) || e);
            err.hidden = false;
        }
        if (inp) {
            inp.focus();
            inp.select();
        }
    } finally {
        if (ok) ok.disabled = false;
    }
}

/// 取消 = 放弃这次导入（后端也要把待导入的路径丢掉）。
function impPassCancel() {
    impPassHide();
    invoke('import_cancel').catch(() => {});
}

listen('qs://import-need-password', (ev) => {
    const p = ev && ev.payload ? ev.payload : {};
    impPassShow(p.name);
});

{
    const box = $('impPassBox');
    if (box && !box.dataset.bound) {
        box.dataset.bound = '1';
        const okBtn = $('btnImpPassOk');
        if (okBtn) okBtn.addEventListener('click', impPassSubmit);
        const cancel = $('btnImpPassCancel');
        if (cancel) cancel.addEventListener('click', impPassCancel);
        // 点遮罩与点「取消」同一语义
        const mask = box.querySelector('.qmodal-mask');
        if (mask) mask.addEventListener('click', impPassCancel);
        const inp = $('impPassInput');
        if (inp) {
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    impPassSubmit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    impPassCancel();
                }
            });
        }
    }
}

function bindDataTab() {
    const btnE = $('btnDoExport');
    if (btnE && !btnE._bound) {
        btnE._bound = true;
        btnE.addEventListener('click', () => {
            const items = pickedExportGroups();
            if (!items.length) {
                toast('一项都没勾，没什么可导出的');
                return;
            }
            /* v1.5.10：把勾选框的状态交给后端。
             * 后端还会自己判一次"隐私项必须加密"——前端这一票不能覆盖它。 */
            const encrypt = !!($('s-exportEncrypt') || {}).checked;
            invoke('export_items', { items, encrypt }).catch((e) => toast('导出失败：' + e));
        });
    }
    // 勾选框变化只影响按钮上的字？不 —— 它不改项数，所以这里不用重算。
    // 绑定只为让键盘用户（空格切换）也有反馈；状态由后端在导出时读取。
    const btnI = $('btnDoImport');
    if (btnI && !btnI._bound) {
        btnI._bound = true;
        btnI.addEventListener('click', () => {
            /* 导入是**合并**式的：只把文件里带的那几项灌回去，别的一律不动。
             * 这一步要说清楚 —— 用户最怕的就是"导入完我别的东西没了"。
             *
             * v1.5.10：这条命令只负责"选文件"。如果文件是密码加密的，
             * 后端会发 `qs://import-need-password` 让下面那个弹框接上。 */
            invoke('import_items').catch((e) => toast('导入失败：' + e));
        });
    }
    const btnTry = $('btnImgTry');
    if (btnTry && !btnTry._bound) {
        btnTry._bound = true;
        btnTry.addEventListener('click', () => {
            invoke('img_start').catch(() => {});
        });
    }
}

/* 「同时识别」多选（r47 取代「双引擎并行识别」那个开关）。
 *
 * 用户原话：「把双引擎并行识别，改为选择 OCR 引擎同时识别，就变成一种可选项，
 * 可以同时选个多个 OCR 同时进行。同时也只会显示自己选择的那一个」。
 *
 * ⚠ 默认引擎**不在这里**：它一定参与，勾不勾都是它。这里只列"另外还要一起跑"
 *   的那几家 —— 勾选结果原样就是后端要的 `ocr_multi`（见 ocr_set_multi，
 *   后端会把默认引擎 / 重复项 / 不认识的 id 剔掉后回传）。
 * ⚠ 没填凭据的那几家**照样能勾**（用户可能正要去填），但要当场标出来：识别时
 *   它会被跳过，不说清楚就又是一次"我配了怎么没用"（r46 的教训）。
 */
function renderOcrMulti() {
    const box = $('w-ocrMultiBox');
    if (!box) return;
    const cur = CONF.ocrEngine || 'baidu';
    const multi = Array.isArray(CONF.ocrMulti) ? CONF.ocrMulti : [];
    const others = ENGINES.filter((e) => e.id !== cur);
    box.innerHTML = '';
    if (!others.length) {
        box.innerHTML = '<div class="dep-tip">引擎名单还没读到…</div>';
        return;
    }
    for (const e of others) {
        const on = multi.indexOf(e.id) >= 0;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'multi-chip' + (on ? ' on' : '') + (on && !e.ready ? ' warn' : '');
        chip.dataset.id = e.id;
        chip.title = on
            ? `取消勾选：下次识别不再跑「${e.name}」`
            : `勾上：每次识别都连「${e.name}」一起跑` +
              (e.ready ? '' : '（它还没填凭据，勾了也会被跳过）');
        const tick = document.createElement('span');
        tick.className = 'multi-tick';
        tick.textContent = on ? '✓' : '+';
        chip.appendChild(tick);
        const nm = document.createElement('span');
        nm.textContent = e.name;
        chip.appendChild(nm);
        if (!e.ready) {
            const w = document.createElement('i');
            w.className = 'multi-warn';
            w.textContent = '没配';
            chip.appendChild(w);
        }
        chip.addEventListener('click', () => toggleOcrMulti(e.id));
        box.appendChild(chip);
    }
    /* r78：这里原来会拼一段很长的说明（"勾上的引擎会和默认引擎一起跑同一张图，
     * 结果窗里各占一段、各自标注；没勾的一律不参与……X 是默认引擎，一定参与、
     * 不用勾。"）。用户要求把这些介绍文字全部去掉 —— 设置页只留控件，
     * 说明在帮助⑤ 里。这里清空而不是删掉元素：DOM 留着，以后要恢复文案
     * 只改这一处。 */
    const tip = $('w-ocrMultiTip');
    if (tip) tip.textContent = '';
}

/** 勾/取消勾一家「同时识别」。 */
function toggleOcrMulti(id) {
    const list = Array.isArray(CONF.ocrMulti) ? CONF.ocrMulti.slice() : [];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.push(id);
    saveOcrMulti(list);
}

/** 存名单。后端会回传**清洗过**的名单（不含默认引擎 / 重复 / 不认识的 id），
 *  拿它覆盖本地 CONF —— 界面上于是不会出现"勾了却没生效"的错觉。 */
function saveOcrMulti(list) {
    invoke('ocr_set_multi', { engines: list })
        .then((cleaned) => {
            CONF.ocrMulti = Array.isArray(cleaned) ? cleaned : [];
            renderOcrEngines();     // 行上的「同时识别」徽标跟着变
            renderOcrMulti();       // 提示里那句"默认引擎是谁"也跟着变
        })
        .catch((e) => toast('保存同时识别名单失败：' + e));
}

function pickOcrEngine(id) {
    if ((CONF.ocrEngine || 'baidu') === id) return;
    invoke('set_setting', { key: 'ocrEngine', value: id })
        .then(() => {
            // 先把本地 CONF 改掉再同步，否则下面几句读到的还是旧引擎
            CONF.ocrEngine = id;
            renderOcrEngines();
            renderOcrCred();
            renderOcrMulti();
            syncOcrEngineUI();
            // 新默认引擎原来可能在「同时识别」名单里（名单不含默认引擎）→
            // 让后端把它剔掉，别让配置文件里留一条永远不会生效的勾
            if (Array.isArray(CONF.ocrMulti) && CONF.ocrMulti.indexOf(id) >= 0) {
                saveOcrMulti(CONF.ocrMulti);
            }
        })
        .catch((e) => toast('切换失败：' + e));
}

/* 当前引擎要填的凭据。
 * 要填哪几样（Key / Secret / 模型名 / base_url）**由注册表决定**，
 * 所以这里按 needKey/needSecret/needModel/needBase 逐个生成输入框。 */
function renderOcrCred() {
    const box = $('w-ocrCredBox');
    if (!box) return;
    /* ⚠ 正在这个框里打字时**不许重建**。
     *
     * 凭据输入框的落库时机是 `change`（失焦 / 回车），而配置广播很频繁
     * （横条收藏面板每 600ms 存一次尺寸就会广播一次）。以前这里无条件
     * `box.innerHTML = ''` 重建：用户刚敲完 Key、还没失焦，一次广播过来
     * 输入框被换掉 —— 里面是旧值，**刚打的字直接丢**。
     * 同页的 `renderAiList` / `favTree` 早就加了这道保护，这里漏了。 */
    if (qsEditingIn('w-ocrCredBox')) return;
    const title = $('w-ocrCredTitle');
    const tip = $('w-ocrCredTip');
    const e = engineById(CONF.ocrEngine || 'baidu');
    box.innerHTML = '';
    if (!e) {
        if (title) title.textContent = '凭据';
        if (tip) tip.textContent = '';
        return;
    }
    if (title) title.textContent = e.online ? `${e.name} 的凭据` : '凭据';
    /* r78：用户原话「任意一个文字识别引擎点开，这里面就弹出了很多的介绍文档，
     * 这些介绍的一些文字都应该在帮助里面呀……这些没有必要的多余的介绍文字
     * 全部去掉」。
     *
     * 所以这一整块 `tip`（"本地识别不需要账号和密钥：完全离线……" /
     * "已填好，可以识别了。密钥只存在本机 config.json……" /
     * "还没填全 —— 点右边那颗 ? 去官方页面申请……"）**全部不再显示**。
     * 帮助⑤ 里本来就有同样的内容，设置页只留"填什么"本身。
     *
     * ⚠ 保留但只保留**真正有用的状态**：填没填全 —— 那直接影响用户下一步做什么，
     *   而且用一颗小圆点/颜色就能表达（见下面 cred-status），不需要一整句话。 */
    if (tip) tip.textContent = '';
    if (!e.online) {
        // 本地引擎没有任何要填的，直接返回（以前这里还有一句"完全离线"的介绍）
        return;
    }
    const creds = (CONF.ocrCreds || {})[e.id] || {};
    const fields = [];
    /* r72：API Key 默认**密码框**。用户原话：「填入 api key 之后，这个 api key
     * 也默认没有说是隐藏，而是直接明文显示了，至少要隐藏吧」—— 密钥明文摆在那，
     * 截图、共享屏幕、旁边有人时顺手就漏了。Secret 那几栏本来就是密码框，
     * 现在 Key 与 Secret 一致，且都在框尾挂一颗眼睛切换可见性（见下面循环）。 */
    if (e.needKey) fields.push(['key', 'API Key', creds.key, true, '粘贴 API Key']);
    if (e.needSecret) {
        const label = e.id === 'tencent' ? 'SecretKey' : e.id === 'youdao' ? '应用密钥' : 'Secret Key';
        fields.push(['secret', label, creds.secret, true, '粘贴密钥']);
    }
    if (e.needBase) fields.push(['base', '接口地址', creds.base, false, e.base || 'https://…/v1']);
    // 模型那一栏：注册表说"这家靠模型名工作"就**总是**显示（哪怕预置了默认模型）——
    // 用户有权知道自己会调哪个模型，也有权换掉。AI 中转站上有几百个模型，
    // 所以配一个「拉取模型」按钮 + <datalist>：既能下拉挑，也能手打。
    if (e.modelRow || e.needModel) fields.push(['model', '模型名', creds.model, false, e.model || '模型名或接入点 ID']);

    const pulledModels = MODELS[e.id] || [];
    for (const [f, label, val, secret, ph] of fields) {
        const row = document.createElement('div');
        row.className = 'cred-row';
        const lab = document.createElement('label');
        lab.textContent = label;
        const inp = document.createElement('input');
        inp.className = 'txt';
        inp.spellcheck = false;
        if (secret) inp.type = 'password';
        inp.placeholder = ph;
        inp.value = val || '';
        inp.dataset.field = f;
        inp.addEventListener('change', () => saveOcrCred(e.id));
        row.appendChild(lab);
        if (secret) {
            /* 密码框外包一层：眼睛按钮绝对定位在输入框右端，点一下在
             * password / text 之间切（ Feather 那对眼睛图标，见 CSS）。 */
            const wrap = document.createElement('span');
            wrap.className = 'cred-eye-wrap';
            wrap.appendChild(inp);
            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'cred-eye-btn';
            eye.tabIndex = -1;
            eye.title = '显示 / 隐藏';
            eye.setAttribute('aria-label', '显示或隐藏' + label);
            eye.innerHTML = '<svg class="ic-eye" viewBox="0 0 24 24" fill="none" '
                + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
                + '<svg class="ic-eye-off" viewBox="0 0 24 24" fill="none" '
                + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94'
                + 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19'
                + 'm-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
            eye.addEventListener('click', () => {
                inp.type = inp.type === 'password' ? 'text' : 'password';
                eye.classList.toggle('on', inp.type === 'text');
                inp.focus();
            });
            wrap.appendChild(eye);
            row.appendChild(wrap);
        } else {
            /* 非密码栏：输入框先入列，模型行的「拉取模型」按钮跟在它右边
             * （CSS 注释写的"贴在输入框右边"，DOM 顺序即视觉顺序）。 */
            row.appendChild(inp);
        }
        // 模型那一栏：datalist 让"下拉挑"和"手打"在同一个控件里共存
        if (f === 'model') {
            inp.setAttribute('list', 'ocrModelList');
            let dl = document.getElementById('ocrModelList');
            if (!dl) {
                dl = document.createElement('datalist');
                dl.id = 'ocrModelList';
                document.body.appendChild(dl);
            }
            const modelIds = (pulledModels).map((m) => m.id);
            if (e.model && modelIds.indexOf(e.model) < 0) modelIds.unshift(e.model);
            dl.innerHTML = '';
            for (const id of modelIds) {
                const o = document.createElement('option');
                o.value = id;
                dl.appendChild(o);
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dep-btn ghost cred-pull';
            btn.textContent = pulledModels.length ? `拉取模型（${pulledModels.length}）` : '拉取模型';
            btn.title = pulledModels.length
                ? `已拉到 ${pulledModels.length} 个模型（列在下面，点一下就能选用）；再点一次重新拉`
                : '按上面填的 Key 去这家拉一次模型列表，然后就能在这里挑';
            btn.addEventListener('click', () => pullOcrModels(e.id));
            row.appendChild(btn);
        }
        box.appendChild(row);
    }

    /* r72：拉到的模型**陈列出来**直接点选。
     * 以前只往 <datalist> 里塞 —— WebView2 的 datalist 没有可见的下拉入口，
     * 用户拉完列表不知道去哪挑（原话：「拉取模型之后模型列表却没有陈列出来
     * 以让我选择呢」）。这里在模型行下方列一块清单：视觉模型带徽标、排前面
     * （后端已排），点一下写回输入框并存档。 */
    if (pulledModels.length) {
        renderOcrModelPanel(box, e.id, pulledModels,
            box.querySelector('input[data-field="model"]'));
    }

    // 状态行 + 「测试」按钮：填完 Key 点一下就知道到底通不通
    const st = document.createElement('div');
    st.className = 'cred-foot';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'dep-btn';
    test.textContent = '测试连接';
    test.title = '用一张自带的小测试图真发一次请求，确认 Key / 地址 / 模型名是不是真的能用';
    test.addEventListener('click', () => runOcrTest(e.id, test, st));
    const hint = document.createElement('span');
    hint.className = 'cred-status';
    /* r78：这里原来会写一句"填完上面的项再点「测试连接」。"——属于同一类
     * 多余的介绍文字，去掉。状态行只在**真跑过一次测试**之后才有内容
     * （由 onOcrTestResult 填 ✓/✗），那才是有信息量的。 */
    hint.textContent = '';
    st.appendChild(test);
    st.appendChild(hint);
    box.appendChild(st);
}

/** r72：把拉到的模型列表**陈列**在模型行下方，点一下选用。
 *
 *  为什么不再只靠 <datalist>：WebView2 的 datalist 没有可见下拉入口，用户拉完
 *  列表不知道去哪挑（用户原话：「拉取模型之后模型列表却没有陈列出来以让我
 *  选择呢」）。清单里视觉模型带徽标排在前面（后端 `list_models` 已排），
 *  点一项就写回上面的输入框并存档；标题行点一下收起/展开（几百个模型的
 *  中转站默认展开会很长，所以收起态也保留）。
 *
 *  @param box    凭据容器（面板挂在它末尾）
 *  @param id     引擎 id（仅用于日志语义）
 *  @param models [{id, vision}]，已按"视觉优先 + 名字"排好
 *  @param inp    模型名输入框（点选后回填） */
function renderOcrModelPanel(box, id, models, inp) {
    const wrap = document.createElement('div');
    wrap.className = 'cred-models';
    wrap.dataset.engine = id;

    const h = document.createElement('div');
    h.className = 'cred-models-h';
    h.setAttribute('role', 'button');
    h.tabIndex = 0;
    const ht = document.createElement('b');
    ht.textContent = '模型列表';
    const hn = document.createElement('small');
    const vis = models.filter((m) => m.vision).length;
    hn.textContent = `${models.length} 个 · ${vis} 个能看图 · 点一下选用`;
    const arrow = document.createElement('i');
    arrow.className = 'cm-arrow';
    arrow.textContent = '▾';
    h.appendChild(ht);
    h.appendChild(hn);
    h.appendChild(arrow);
    const toggle = () => wrap.classList.toggle('shut');
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });

    const body = document.createElement('div');
    body.className = 'cred-models-b';
    for (const m of models) {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'cred-model-item'
            + (m.vision ? ' vis' : '')
            + (inp && inp.value === m.id ? ' sel' : '');
        it.title = m.vision ? '选用这个模型（名字看着能看图）' : '选用这个模型';
        const nm = document.createElement('span');
        nm.className = 'cm-id';
        nm.textContent = m.id;
        it.appendChild(nm);
        if (m.vision) {
            const b = document.createElement('i');
            b.className = 'v-badge';
            b.textContent = '视觉';
            it.appendChild(b);
        }
        it.addEventListener('click', () => {
            if (inp) {
                inp.value = m.id;
                inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            body.querySelectorAll('.cred-model-item').forEach((x) => x.classList.remove('sel'));
            it.classList.add('sel');
        });
        body.appendChild(it);
    }

    wrap.appendChild(h);
    wrap.appendChild(body);
    box.appendChild(wrap);
}

/* ------------------------------------------------------------------ */
/* 测试连接 / 拉取模型                                                  */
/* ------------------------------------------------------------------ */

/* 结果都由后端**异步**回事件（qs://ocr-test、qs://ocr-models）：
 * 有些家一次要好几秒，同步等会把设置页整个卡住。 */
let MODELS = {};        // engineId -> [{id, vision}]
let testBusy = false;

async function runOcrTest(id, btn, st) {
    if (testBusy) return;
    testBusy = true;
    const old = btn.textContent;
    btn.textContent = '测试中…';
    st.className = 'cred-status';
    st.textContent = '正在真发一次请求…';
    try {
        await invoke('ocr_test_engine', { engine: id });
    } catch (e) {
        st.className = 'cred-status bad';
        st.textContent = '测不了：' + String(e).slice(0, 160);
        btn.textContent = old;
        testBusy = false;
    }
}

function onOcrTestResult(p) {
    testBusy = false;
    const box = $('w-ocrCredBox');
    const btn = box && box.querySelector('.cred-foot .dep-btn');
    if (btn) btn.textContent = '测试连接';
    const st = box && box.querySelector('.cred-status');
    if (st) {
        st.className = 'cred-status ' + (p.ok ? 'ok' : 'bad');
        st.textContent = (p.ok ? '✓ ' : '✗ ') + p.msg + (p.ms ? `（${p.ms} ms）` : '');
    }
    toast((p.ok ? '连上了：' : '没连上：') + p.msg);
}

async function pullOcrModels(id) {
    const e = engineById(id);
    if (!e) return;
    // 先用界面上**当前**的值存一次：用户可能刚改了 Key 还没失焦
    saveOcrCred(id);
    toast('正在拉模型列表…');
    try {
        /* r76：`visionOnly: true` —— 用户原话「它搜索模型有的是视觉模型，那就保存
         * 非视觉模型就默认排除在模型列表之外」。OCR 是把图交给模型认字，纯文本
         * 模型压根吃不了图，列出来只会让人在几十个名字里挑一个必然失败的。
         * 后端默认也是 true，这里显式写出来是为了让"这个口径由前端决定"这件事
         * 在代码里看得见（以后要改成"全列"只改这一处）。 */
        await invoke('ocr_list_models', { engine: id, visionOnly: true });
    } catch (err) {
        toast('拉模型列表失败：' + err);
    }
}

function onOcrModels(p) {
    if (!p.ok) {
        toast('拉不到模型列表：' + p.msg);
        return;
    }
    MODELS[p.engine] = p.models || [];
    toast(p.msg);
    renderOcrCred();
}

/* 存某家引擎的凭据。
 * 四样一起发给后端（它按注册表决定用哪几样），空串 = 清掉那一项。
 * 存完重新拉一次注册表：ready 标记（"已填好 / 还没填全"）要跟着变。 */
function saveOcrCred(id) {
    const box = $('w-ocrCredBox');
    if (!box || !engineById(id)) return;
    const get = (f) => {
        const el = box.querySelector(`input[data-field="${f}"]`);
        return el ? el.value : '';
    };
    const body = {
        engine: id,
        key: get('key'),
        secret: get('secret'),
        base: get('base'),
        model: get('model'),
    };
    invoke('ocr_set_cred', body)
        .then(() => invoke('ocr_engines_list'))
        .then((list) => {
            ENGINES = list;
            CONF.ocrCreds = CONF.ocrCreds || {};
            CONF.ocrCreds[id] = {
                key: body.key,
                secret: body.secret,
                base: body.base,
                model: body.model,
            };
            renderOcrCred();
            // r47：凭据一变，列表行上的「同时识别（没配）」标红和胶囊上的「没配」
            // 都得跟着更新 —— 否则用户刚填完 Key，界面还挂着"没配"。
            renderOcrEngines();
            renderOcrMulti();
        })
        .catch((err) => toast('保存失败：' + err));
}

/* ------------------------------------------------------------------ */
/* 本地 OCR 环境检测                                                    */
/* ------------------------------------------------------------------ */

/* 用户要求：进入 OCR 设置页 / 初始化 OCR 时，自动检测本地 OCR 所需的系统组件
 * 是否齐全；缺什么、有什么用、怎么补，界面上逐项说清楚，并给一键安装入口。
 * 检测逻辑在后端纯只读跑（WinRT 试建引擎 + 枚举语言包，见 ocr::ocr_dep_check），
 * 这里只做「调检测 → 渲染卡片 → 分发按钮」。刷新时机三个：
 *   ① boot（设置窗打开即初始化）② 切到 OCR 标签页 ③ 引擎切到「Windows 本地」。
 *
 * ⚠ ③ 这条是**每次配置广播**都会走的（syncOcrEngineUI 里调的），所以检测结果
 *   必须缓存：`ocr_env_check` 在 Rust 侧要 CoInitializeEx + 逐个语言
 *   TryCreateFromLanguage，而每次重跑都会先把卡片清成"正在检测系统组件…"——
 *   用户在 OCR 页上随便改个别设置就看见它闪一下。 */
let depBusy = false;
let ocrDepCache = null;   // 上一次 ocr_env_check 的结果
let ocrDepAt = 0;         // 上一次检测的时间戳
const OCR_DEP_TTL = 30000;

function depItemHtml(x) {
    return `<div class="dep-item ${x.ok ? 'is-ok' : 'is-miss'}">
        <div class="dep-head"><span class="dep-dot"></span><b>${x.name}</b>
            <span class="dep-badge">${x.ok ? '已就绪' : '待补充'}</span></div>
        <div class="dep-line"><i>作用</i>${x.purpose}</div>
        <div class="dep-line"><i>现状</i>${x.detail}</div>
        ${x.ok ? '' : `<div class="dep-line"><i>怎么补</i>${x.fix}</div>`}
    </div>`;
}

/** 把一份检测结果画进卡片（**不发起检测** —— 见 renderOcrDep 的缓存说明）。 */
function paintOcrDep(items) {
    const box = $('w-ocrDep');
    if (!box) return;
    const missing = items.filter((x) => !x.ok);
    const acts = `<div class="dep-acts">
            ${missing.length ? '<button type="button" class="dep-btn" data-act="lang">一键安装：打开语言设置</button>' : ''}
            ${missing.some((x) => x.id === 'winrt') ? '<button type="button" class="dep-btn" data-act="help">查看官方教程</button>' : ''}
            <button type="button" class="dep-btn ghost" data-act="recheck">重新检测</button>
        </div>`;
    if (missing.length === 0) {
        box.innerHTML =
            `<div class="dep-banner ok"><b>环境就绪</b>Windows 本地 OCR 所需的系统组件已全部安装，随时可以识别。</div>` +
            items.map(depItemHtml).join('') + acts;
    } else {
        box.innerHTML =
            `<div class="dep-banner miss"><b>缺 ${missing.length} 项组件</b>本地 OCR 暂时用不了，按下面的说明补齐后点「重新检测」即可。</div>` +
            items.map(depItemHtml).join('') + acts;
    }
}

/** 折叠态：**不跑检测**，只给一个按钮。
 *
 * 用户 r46 原话：「本地 ocr 的环境检测，默认得是折叠住的，或者说这个环境检测
 * 你直接提供一个按钮，我没点击，他就不用告诉我说是否已准备就绪。」
 * 所以这里只写一行说明 + 一颗按钮 —— 点之前绝不去探测系统组件，
 * 也就不存在"一进页面就被告知就绪/不就绪"。 */
function paintOcrDepIdle() {
    const box = $('w-ocrDep');
    if (!box) return;
    box.innerHTML = `<div class="dep-tip">想用「本地识别」（离线、不花钱、不联网）？
        先点一下检测，看看这台电脑缺不缺组件。</div>
        <div class="dep-acts">
            <button type="button" class="dep-btn" data-act="check">检测本地 OCR 环境</button>
        </div>`;
}

async function renderOcrDep(force) {
    const box = $('w-ocrDep');
    if (!box || depBusy) return;
    // r46：**没点过按钮就不检测**。以前 boot / 切 OCR 页 / 换引擎都会自动跑，
    // 用户一进来就看到"环境就绪/缺组件"，而他并没有问过。
    if (!force && !ocrDepCache) {
        paintOcrDepIdle();
        return;
    }
    // 缓存还新鲜：直接重画，不跑 WinRT 探测、也不闪"正在检测"占位
    if (!force && ocrDepCache && Date.now() - ocrDepAt < OCR_DEP_TTL) {
        paintOcrDep(ocrDepCache);
        return;
    }
    depBusy = true;
    box.innerHTML = '<div class="dep-tip">正在检测系统组件…</div>';
    try {
        const items = await invoke('ocr_env_check');
        ocrDepCache = items;
        ocrDepAt = Date.now();
        paintOcrDep(items);
    } catch (e) {
        // 检测本身失败（后端异常）：不装成「环境有问题」——那是另一回事，
        // 用户能做的只有重试。
        box.innerHTML = `<div class="dep-banner miss"><b>检测没跑起来</b></div>
            <div class="dep-line"><i>原因</i>${String(e).slice(0, 200)}</div>
            <div class="dep-acts"><button type="button" class="dep-btn" data-act="recheck">重试</button></div>`;
    }
    depBusy = false;
}

/* 卡片里所有按钮走一个委托：渲染是按 innerHTML 重建的，逐按钮 bind 会随
 * 每次渲染丢事件。 */
function bindOcrDep() {
    const box = $('w-ocrDep');
    if (!box) return;
    box.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b || !box.contains(b)) return;
        const act = b.dataset.act;
        if (act === 'check') renderOcrDep(true);
        else if (act === 'recheck') renderOcrDep(true);
        else if (act === 'lang') invoke('ocr_open_language_settings').catch(() => {});
        else if (act === 'help') invoke('ocr_open_lang_help').catch(() => {});
    });
}

// ---- WebDAV ----
$('btnWdTest').addEventListener('click', () => {
    $('wdStatus').textContent = '正在测试…';
    invoke('webdav_test');
});
$('btnWdUp').addEventListener('click', () => {
    $('wdStatus').textContent = '正在备份（先落本地，再传云端）…';
    invoke('webdav_upload');
});
$('btnWdDown').addEventListener('click', () => {
    $('wdStatus').textContent = '正在读取云端备份列表…';
    // ⚠ 这里必须**自己**把面板亮出来、并给一个"正在拉取"的占位。
    //   以前这里调的是 `showWdList(null)`，而那个函数是 `if (items) box.hidden = false`
    //   —— 参数是 null 时**什么都不做**。于是点「从云端恢复」之后画面纹丝不动，
    //   用户只能一直等那个异步事件推回来（网盘慢的时候就是好几秒的"点了没反应"）。
    //   顺手把旧列表清掉：留着上一轮的条目会让人以为"已经刷新好了"。
    const box = $('wdList');
    const wrap = $('wdItems');
    if (box) box.hidden = false;
    // 新一次拉取 → 退回恢复模式（不然会停在上一轮的管理态，用户以为卡住了）
    wdItems = [];
    setWdManage(false, true);
    if (wrap) {
        wrap.textContent = '';
        const ph = document.createElement('div');
        ph.className = 'wd-empty';
        ph.textContent = '正在读取云端目录…';
        wrap.appendChild(ph);
    }
    invoke('webdav_list').catch((e) => {
        $('wdStatus').textContent = '读取失败：' + (e || '');
    });
});

/* ---- 云端备份列表：恢复时能选哪一份 ----
 *
 *  需求原话是「恢复备份能选择云端哪一份」。所以这里不直接恢复，而是：
 *    点「从云端恢复」→ 列目录 → 用户点某一份 → 二次确认 → 才真恢复。
 *  二次确认不是多余的客套：恢复会覆盖本机配置，点错了得靠
 *  config.before-webdav(时间).QuickSearch 快照手动回滚，很烦。
 *
 *  ⚠ 这里原来还有一个 `showWdList(items)` 包装，实现是
 *  `if (items) box.hidden = false` —— 只有一个调用点，传的却是 null，
 *  于是它永远什么都不做（死逻辑），还让调用方误以为"面板已经亮出来了"。
 *  亮面板的活已经挪进「从云端恢复」那个点击处理里，这个函数删掉。
 */

/* 云端备份列表有两种模式：
 *   · 恢复模式（默认）—— 每条整行可点 = 恢复这一份（二次确认）；
 *   · 管理模式 —— 点「管理」进来，每条变成「复选框 + 名字」，选中后批量删除。
 * 两种模式共用同一份 `wdItems`，切换只重画、不重新拉取目录。
 *
 * 需求原话：「增加一个选项，点击后会使所有的云端备份处于可选状态，选择后就可以删除」。
 */
let wdItems = [];
let wdManage = false;
const wdPicked = new Set();

function fmtWdTime(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
         + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** 管理模式开关：按钮文案、两组操作按钮、提示语一起切。
 *  `skipPaint` 给"列表马上要被占位文案覆盖"的调用点用（见 btnWdDown）。 */
function setWdManage(on, skipPaint) {
    wdManage = !!on;
    if (!wdManage) wdPicked.clear();
    const mg = $('btnWdManage');
    if (mg) mg.textContent = wdManage ? '退出管理' : '管理';
    const normal = $('wdActsNormal');
    const manage = $('wdActsManage');
    if (normal) normal.hidden = wdManage;
    if (manage) manage.hidden = !wdManage;
    const hint = $('wdListHint');
    if (hint) {
        hint.textContent = wdManage
            ? '勾选要删除的备份 · 删除后无法恢复'
            : '选一份恢复 · 恢复前会在本机留一份副本';
    }
    if (!skipPaint) paintWdList();
}

function paintWdList() {
    const box = $('wdList');
    const wrap = $('wdItems');
    if (!box || !wrap) return;
    box.hidden = false;
    wrap.textContent = '';
    if (!wdItems.length) {
        const e = document.createElement('div');
        e.className = 'wd-empty';
        e.textContent = '云端目录里还没有备份文件。点「立即备份」可以先把当前配置传上去。';
        wrap.appendChild(e);
        syncWdDeleteBtn();
        return;
    }
    for (const it of wdItems) {
        const t = fmtWdTime(it.mtime);
        const sz = fmtBytes(it.size);
        const meta = [t, sz].filter(Boolean).join(' · ') || '（服务器没给时间）';
        if (!wdManage) {
            // —— 恢复模式：整行是一个按钮 ——
            const b = document.createElement('button');
            b.className = 'wd-item';
            b.type = 'button';
            b.innerHTML = `<span class="nm"></span><span class="meta"></span>`;
            b.querySelector('.nm').textContent = it.name;   // textContent，不拼 HTML
            b.querySelector('.meta').textContent = meta;
            b.title = '恢复「' + it.name + '」';
            b.addEventListener('click', () => {
                if (!window.confirm('确定用云端的「' + it.name + '」覆盖本机配置吗？\n'
                                  + '覆盖前会先在本机留一份 config.before-webdav(时间).QuickSearch。')) {
                    return;
                }
                $('wdStatus').textContent = '正在恢复「' + it.name + '」…';
                invoke('webdav_restore_named', { name: it.name }).catch((e) => {
                    $('wdStatus').textContent = '恢复失败：' + (e || '');
                });
            });
            wrap.appendChild(b);
        } else {
            // —— 管理模式：整行是一个 label（点哪都能勾），里面是复选框 ——
            // ⚠ 用 label 而不是 button 包复选框：button 里嵌 input 属于
            //   非法嵌套，浏览器会把 DOM 拆开、点击行为也跟着变。
            const row = document.createElement('label');
            row.className = 'wd-item sel' + (wdPicked.has(it.name) ? ' picked' : '');
            const ck = document.createElement('input');
            ck.type = 'checkbox';
            ck.className = 'ck';
            ck.checked = wdPicked.has(it.name);
            ck.addEventListener('change', () => {
                if (ck.checked) wdPicked.add(it.name);
                else wdPicked.delete(it.name);
                row.classList.toggle('picked', ck.checked);
                syncWdDeleteBtn();
            });
            const txt = document.createElement('span');
            txt.className = 'txt';
            const nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = it.name;
            const mt = document.createElement('span');
            mt.className = 'meta';
            mt.textContent = meta;
            txt.append(nm, mt);
            row.append(ck, txt);
            wrap.appendChild(row);
        }
    }
    syncWdDeleteBtn();
}

/** 「删除选中 (n)」按钮的可用态与计数。没勾任何一份时禁用 —— 别让用户
 *  点一个什么都不做的按钮然后怀疑软件坏了。 */
function syncWdDeleteBtn() {
    const b = $('btnWdDelete');
    if (!b) return;
    b.disabled = wdPicked.size === 0;
    b.textContent = wdPicked.size ? `删除选中 (${wdPicked.size})` : '删除选中';
}

function renderWdList(items) {
    wdItems = Array.isArray(items) ? items : [];
    // 列表刷新后，把已经不存在的名字从选中集合里剔掉
    if (wdPicked.size) {
        const alive = new Set(wdItems.map((x) => x.name));
        for (const n of [...wdPicked]) if (!alive.has(n)) wdPicked.delete(n);
    }
    // 列表空了就自动退出管理模式（否则会停在一个"没有条目可选"的死界面）
    if (!wdItems.length && wdManage) {
        setWdManage(false);
        return;
    }
    paintWdList();
}

$('btnWdManage').addEventListener('click', () => setWdManage(!wdManage));
$('btnWdManageDone').addEventListener('click', () => setWdManage(false));
$('btnWdSelAll').addEventListener('click', () => {
    for (const it of wdItems) wdPicked.add(it.name);
    paintWdList();
});
$('btnWdSelNone').addEventListener('click', () => {
    wdPicked.clear();
    paintWdList();
});
$('btnWdDelete').addEventListener('click', async () => {
    const names = [...wdPicked];
    if (!names.length) return;
    if (!window.confirm(`确定删除云端这 ${names.length} 份备份吗？\n\n`
                      + names.join('\n')
                      + '\n\n删除后无法恢复（本机的备份不受影响）。')) {
        return;
    }
    $('wdStatus').textContent = `正在删除 ${names.length} 份云端备份…`;
    const b = $('btnWdDelete');
    if (b) b.disabled = true;
    try {
        await invoke('webdav_delete', { files: names });
    } catch (e) {
        $('wdStatus').textContent = '删除失败：' + ((e && e.message) || e);
    }
    // 删除结果（成功几份 / 失败几份）由后端 qs://webdav 通道回来说；
    // 列表也会被后端重新推一次，这里不用自己猜哪几行没了。
});

$('btnWdListRefresh').addEventListener('click', () => {
    $('wdStatus').textContent = '正在重新读取云端备份列表…';
    invoke('webdav_list').catch((e) => {
        $('wdStatus').textContent = '读取失败：' + (e || '');
    });
});
$('btnWdListClose').addEventListener('click', () => {
    $('wdList').hidden = true;
    setWdManage(false);   // 收起时一定退回恢复模式，下次打开别停在管理态
});

listen('qs://wd-list', (ev) => renderWdList(ev.payload));

/** WebDAV 地址实时预览：把「补全后会变成什么」摆给用户看。
 *
 *  用户照文档只会填 `https://dav.jianguoyun.com/dav/`，剩下的目录名和备份文件
 *  是软件自己补的。补全发生在 Rust 那边（`webdav::normalize_base`），这里只
 *  负责把结果原样显示出来 —— 前端不自己拼 URL，免得两边规则不一致。
 *
 *  ⚠ 备份文件名**不再可自定义**（用户要求：本地叫什么云端就叫什么），
 *    所以这里不再传 file，示例名由后端按唯一口径给。 */
async function refreshWdPreview() {
    const out = $('wdPreview');
    if (!out) return;
    const url = $('w-webdavUrl').value || '';
    if (!url.trim()) {
        out.hidden = true;
        out.textContent = '';
        return;
    }
    let r;
    try {
        r = await invoke('webdav_preview_url', { url });
    } catch (_) {
        out.hidden = true;
        return;
    }
    if (!r || !r.ok) {
        out.hidden = false;
        out.dataset.bad = '1';
        out.textContent = '地址有问题：' + String((r && r.error) || '无法识别');
        return;
    }
    delete out.dataset.bad;
    out.hidden = false;
    // 补全前后不一样才提示「已自动补全」；本来就是完整地址就别啰嗦。
    const same = r.url === (url.trim().endsWith('/') ? url : url.trim() + '/');
    // ⚠ 文案必须说清"每备份一次是一个新文件"，而且**本地和云端同名**：
    //   以前这里写「将备份到：xxx.json」，用户会以为永远覆盖这一个文件 ——
    //   那正是"做了很多次备份却只看到一份"的由来。
    out.textContent = (same ? '将备份到目录：' : '已自动补全为：')
        + r.url + '（每次备份一个新文件，本地与云端同名，例如 ' + r.sample + '）';
}
$('w-webdavUrl').addEventListener('input', refreshWdPreview);

/* ================================================================== */
/* 收藏夹                                                              */
/* ================================================================== */

/** 本地编辑中的收藏树。qs://config 广播进来时整体刷新；
 *  用户每改一步就写回后端（防丢），后端广播回来再整体重画。 */
let favTree = [];

/* 收藏树的**展开/折叠**这类纯 UI 状态单独存这两个 map，绝不写进持久化树。
 *
 * 为什么：后端 FavGroup / FavItem 结构体里没有 _open 字段，写进树对象后一旦走
 * 「保存 → set_setting → 广播 → 前端整树深拷贝」这一圈，serde 就把未知字段丢了。
 * 挂在树上的后果用户已经见过两次：① 点折叠后一秒内自己又弹开；② 正在编辑的
 * 收藏条目突然被收成一行，输入中的备注/内容丢失。key 用 id —— 整树重建也稳定。 */
const favGroupOpen = new Map();   // 目录 id -> bool（r48 起**默认折叠**）
const favItemOpen = new Map();    // 条目 id -> bool（默认折叠）
/* r48：目录默认**折叠**。用户原话：「我希望收藏夹能用帮助页面目录的这样一种方式
 * 来显示，因为这样的话它上下的宽度没有那么宽，同时还比较好看」——
 * 帮助页那份目录就是"一列标题，想看哪条点哪条"（只有①默认展开）。
 * 以前这里是"默认展开"：收藏夹目录一多，进这一页就是十几张卡全摊开、
 * 每张卡还顶着一排操作按钮，整页高得离谱。现在折叠态只剩摘要行，
 * 要展开有那颗箭头，也可以一键「全部展开」。 */
const favGroupIsOpen = (id) => favGroupOpen.get(id) === true;
const favItemIsOpen = (id) => favItemOpen.get(id) === true;

/* 刚建出来、还没起过名的目录 id。
 *
 * 为什么要它：新建的目录走 **placeholder 语义** —— 树里 name 是空串，输入框里
 * 灰着「新一级目录」（看得见，但一打字就被顶掉、占位自动消失，这正是用户要的）。
 * 空名字的输入框默认是**只读**的（"已添加的目录不该始终可编辑"），所以必须给新建
 * 的那一个开个后门：渲染时自动进入"重命名中"、光标落上去，用户抬手就能打字。
 * 用 id 而不是"渲染第几次"来记 —— favTree 会被配置广播整树重建，节点换了但 id 不变。 */
const favNewly = new Set();

function favNewId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 在收藏树（两级）里按 id 找目录。 */
function favFindGroup(id) {
    for (const g of favTree) {
        if (g.id === id) return g;
        for (const sub of g.children || []) {
            if (sub.id === id) return sub;
        }
    }
    return null;
}

/** 把当前树写回后端（走 set_setting 的 favorites 白名单项）。 */
function favPersist() {
    invoke('set_setting', { key: 'favorites', value: favTree }).catch(() => {});
}

/** 按 id 从收藏树里删目录（一级 / 二级都能删）。
 *  为什么按 id 不按对象引用：qs://config 广播会让 favTree **整树深拷贝重建**，
 *  行节点闭包里攥着的 g 是上一轮的游离对象 —— 按引用 filter 永远匹配不上，
 *  表现就是用户报的「删除目录删除不了」。id 是稳定标识，重建也不会变。 */
function favRemoveGroup(id) {
    favTree = favTree.filter((x) => x.id !== id);
    for (const p of favTree) {
        if (Array.isArray(p.children)) {
            p.children = p.children.filter((c) => c.id !== id);
        }
    }
}

/** 拿 g 在**当前** favTree 里的活引用（找不到 = 已被删，返回 null）。
 *  树被广播重建后，闭包里的旧 g 和树已经断开 —— 改它的名字、往它身上
 *  push 内容都会静默丢失。任何写操作动手前先重新解析一次。 */
function favCur(g) {
    return favFindGroup(g && g.id);
}

/** 按 id 找一条收藏内容（一级 / 二级目录里都翻）。
 *  同 favCur 的理由：内容编辑框的 change 闭包也可能攥着游离的旧对象。 */
function favFindItem(id) {
    for (const g of favTree) {
        for (const it of g.items || []) if (it.id === id) return it;
        for (const sub of g.children || []) {
            for (const it of sub.items || []) if (it.id === id) return it;
        }
    }
    return null;
}

/** 判断 target 是否就是 ancestor 自己或嵌在它的子树里。
 *  拖拽「降为二级」前必须挡一下：把 A 拖到 A 自己的孩子中央会造出循环引用。 */
function favIsSelfOrDescendant(ancestor, id) {
    if (!ancestor) return false;
    if (ancestor.id === id) return true;
    return (ancestor.children || []).some((c) => favIsSelfOrDescendant(c, id));
}

/** 在某个分组里追加一条内容。kind = text | image */
async function favAddItem(g, kind) {
    const cur = favCur(g);
    if (!cur) return;
    if (kind === 'image') {
        const r = await invoke('fav_pick_image').catch(() => null);
        if (!r || !r.ok) return;
        cur.items.push({ id: favNewId(), kind: 'image', text: '', image: r.dataUrl, remark: '' });
    } else {
        const it = { id: favNewId(), kind: 'text', text: '', remark: '' };
        cur.items.push(it);
        // 新建的文字条目**直接摊开**（和"新建目录即可编辑"一个口径）：
        // 用户点的是「＋ 文字」，下一步必然是打字，不该再让他多点一下"点击编辑"。
        // 图片条目没有可打字的正文，保持收成一行。
        favItemOpen.set(it.id, true);
    }
    // r48：目录默认折叠 —— 点「＋ 文字 / ＋ 图片」时先把这张卡摊开，
    // 否则刚加的东西藏在折叠区里，用户会以为没加上。
    favGroupOpen.set(cur.id, true);
    favPersist();
    favRender();
}

/** 渲染整棵树。 */
function favRender() {
    const box = $('favTree');
    if (!box) return;
    box.textContent = '';
    if (!favTree.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有目录。点上面的「添加一级目录」建一个。';
        box.appendChild(d);
        return;
    }
    favTree.forEach((g) => box.appendChild(favGroupNode(g, 1)));

    // 拖拽落点：拖到这里 = 升为一级目录（二级→一级不用再去找「升为一级」按钮）。
    // 落下判定走 pointer 事件（见 favDragEnd），这里只把区域画出来；
    // 拖拽中由 favPaintTarget 统一给它加 drag-over 视觉反馈。
    const rootZone = document.createElement('div');
    rootZone.className = 'fav-root-zone';
    rootZone.textContent = '拖到这里：变成一级目录';
    box.appendChild(rootZone);
}

/** 一个 mini 按钮的工厂（复用设置页其它地方的观感）。 */
function favBtn(parent, text, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
}

/** 删除要两步确认（和自定义引擎那个删除同一套交互）。 */
function favArmedDelete(btn, fn) {
    if (btn.dataset.arm === '1') {
        fn();
        return;
    }
    btn.dataset.arm = '1';
    btn.textContent = '确认删除？';
    btn.classList.add('danger');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
        btn.dataset.arm = '0';
        btn.textContent = '删除';
        btn.classList.remove('danger');
    }, 3000);
}

/** 把一个目录从它现在的位置摘下来（一级 / 二级都能找）。 */
function favDetach(g) {
    let i = favTree.indexOf(g);
    if (i >= 0) return favTree.splice(i, 1)[0];
    for (const p of favTree) {
        const j = (p.children || []).indexOf(g);
        if (j >= 0) return p.children.splice(j, 1)[0];
    }
    return null;
}

/* 收藏夹拖拽：pointer 事件实现（不再用 HTML5 拖放）。
 *
 * 为什么弃用 HTML5 拖放：WebView2 里 grip 这种小把手的 dragstart 经常因为
 * 合成器 / 焦点状态不触发，表现就是「按住把手纹丝不动」—— 用户三次反馈
 * 「拖不动 = 没这功能」。pointerdown/move/up 是最底层事件路径，一定可靠
 * （横条列表的拖拽也是同一套思路）。落点插位 / 升降级逻辑复用 favDropMove。 */
let favDragState = null;

function favDragStart(g, level, e) {
    favDragState = { g, level, x: e.clientX, y: e.clientY, active: false };
}

function clearFavDropMarks() {
    document.querySelectorAll('.fav-row.drag-over, .fav-row.drag-child, .fav-root-zone.drag-over')
        .forEach((n) => n.classList.remove('drag-over', 'drag-child'));
}

/** 拖拽中：根据指针位置高亮落点（某行的边缘 = 排前后；某行中央 = 降为二级；
 *  最下面的根落点 = 升为一级）。 */
function favPaintTarget(x, y) {
    clearFavDropMarks();
    const rootZone = document.querySelector('.fav-root-zone');
    if (rootZone) {
        const rr = rootZone.getBoundingClientRect();
        if (x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom) {
            rootZone.classList.add('drag-over');
            favDragState.target = { kind: 'root' };
            return;
        }
    }
    const rows = [...document.querySelectorAll('.fav-row')]
        .filter((r) => !r.classList.contains('dragging'));
    for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
            const rel = (y - b.top) / Math.max(1, b.height);
            const lvl = Number(r.dataset.level);
            const middle = rel > 0.28 && rel < 0.72;
            if (middle && lvl === 1) r.classList.add('drag-over', 'drag-child');
            else r.classList.add('drag-over');
            favDragState.target = { kind: 'row', row: r, level: lvl, before: rel <= 0.28, middle };
            return;
        }
    }
    favDragState.target = null;
}

function favDragEnd(x, y) {
    const st = favDragState;
    favDragState = null;
    document.querySelectorAll('.fav-row.dragging').forEach((r) => r.classList.remove('dragging'));
    clearFavDropMarks();
    if (!st || !st.active || x == null) return;   // 没真正开始拖 / 取消：什么都不做

    // 源目录必须在**当前树**里重新解析一遍：拖拽期间若发生过配置广播，
    // favTree 已整树重建，闭包里的 st.g 是游离对象，摘不下来也插不进去。
    const src = favCur(st.g);
    if (!src) return;                             // 目录已被删，放弃这次拖拽

    // 升为一级（根落点）
    const rootZone = document.querySelector('.fav-root-zone');
    if (rootZone) {
        const rr = rootZone.getBoundingClientRect();
        if (x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom) {
            favDetach(src);
            favTree.push(src);
            favPersist();
            favRender();
            return;
        }
    }
    // 落到某行：边缘=兄弟排序，一级行中央=降为二级
    const rows = [...document.querySelectorAll('.fav-row')]
        .filter((r) => !r.classList.contains('dragging'));
    for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
            const target = favFindGroup(r.dataset.id);
            if (!target) return;
            const rel = (y - b.top) / Math.max(1, b.height);
            const middle = rel > 0.28 && rel < 0.72;
            const d = { g: src };
            if (middle && Number(r.dataset.level) === 1) favDropMove(d, target, 1, 'child', false);
            else if (!middle) favDropMove(d, target, Number(r.dataset.level), 'sibling', rel <= 0.28);
            return;
        }
    }
}

/* ⚠ 这里原本还有一份「收藏夹目录拖拽」的 document 级 pointermove/pointerup/
 *   pointercancel（早期只有目录拖拽时写的）。后来把「目录拖拽 + 内容长按拖拽」
 *   合并成下面 3400 多行的那一份时，这一份忘了删 —— 拖目录时两个 handler 都跑，
 *   `favPaintTarget` 里的 `clearFavDropMarks()` + 逐行 getBoundingClientRect()
 *   （强制同步布局）各做两遍。合并版是超集（含 favDragState 分支 + 内容拖拽），
 *   所以直接删掉即可。 */

/** 拖放落点的统一处理。
 *  mode = 'sibling'：插到 target 前/后（前后按落点在行的上/下半决定）
 *  mode = 'child'  ：变成 target 的二级目录（拖到行中央 —— 用户要求的
 *                     "把一级目录调成其他一级目录的二级目录"就是这个） */
function favDropMove(d, target, level, mode, before) {
    if (!d || !target) return;
    // 拖到自己或自己的子树里会造成循环引用 / 数据丢失，直接忽略
    if (favIsSelfOrDescendant(d.g, target.id)) return;
    favDetach(d.g);
    if (mode === 'child') {
        target.children = target.children || [];
        target.children.push(d.g);
        favGroupOpen.set(target.id, true);   // 刚被拖进来的要看得见
    } else if (level === 1) {
        const i = favTree.indexOf(target);
        if (i >= 0) favTree.splice(before ? i : i + 1, 0, d.g);
        else favTree.push(d.g);
    } else {
        for (const p of favTree) {
            const kids = p.children || [];
            const i = kids.indexOf(target);
            if (i >= 0) {
                kids.splice(before ? i : i + 1, 0, d.g);
                favGroupOpen.set(p.id, true);
                break;
            }
        }
    }
    favPersist();
    favRender();
}

/* ------------------------------------------------------------------ */
/* 收藏**内容**（文字 / 图片）的长按拖拽                                  */
/* ------------------------------------------------------------------ */

/* 用户原话：「设置收藏夹页面当中，并不能够长按文本或者图片内容进行拖拽，
 * 这一点是要求实现的」。
 *
 * 为什么是**长按**（目录是按住即拖）：条目行默认「点一下展开编辑」，
 * 按下即拖会和点击展开打架；长按 ~450ms 不动才进入拖拽态，点击语义完整
 * 保留。长按期间手指/鼠标移动超过 8px（想滚动页面 / 划词）自动取消，
 * 不会把滚动吃掉。
 *
 * 落点：另一条内容的行上/下边缘 = 排到它前/后（同目录排序、跨目录移动
 * 都走这条）；目录行上 = 放进这个目录（上半 = 插到最前，其余 = 末尾）。
 * 目录自己的 grip 拖拽管层级升降，这里是内容搬家，两套互不干扰。
 *
 * 和目录拖拽同一套底层思路：pointer 事件（HTML5 拖放在 WebView2 里
 * dragstart 经常不触发，用户三次反馈「拖不动」）、按 id 重新解析
 * （配置广播会整树重建，闭包里的旧对象是游离的）、落库走 favPersist。 */
let favItemDrag = null;
let favItemSuppressClick = false;   // 长按触发过拖拽 → 吞掉随后补发的那一次 click
const FAV_ITEM_HOLD_MS = 450;
const FAV_ITEM_MOVE_SLOP = 8;

function favItemHoldCancel() {
    if (!favItemDrag) return;
    if (favItemDrag.holdTimer) clearTimeout(favItemDrag.holdTimer);
    favItemDrag = null;
}

function favItemHoldFire(pointerId) {
    const st = favItemDrag;
    if (!st || st.active) return;
    // 长按的 450ms 里配置广播可能把树重建过：按 id 重新解析，解析不到
    // （条目被删了）就安静放弃这次拖拽。
    const cur = favFindItem(st.id);
    if (!cur) {
        favItemDrag = null;
        return;
    }
    st.active = true;
    st.holdTimer = 0;
    st.it = cur;
    favItemSuppressClick = true;   // 松手后那次 click 不能展开编辑
    const row = document.querySelector(`[data-item-id="${st.id}"]`);
    if (row) row.classList.add('dragging');
    document.body.classList.add('fav-item-dragging');
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();          // 长按可能已经划了词
    const hint = $('favHint');
    if (hint) hint.textContent = '拖动中：拖到别的内容行边缘 = 排序；拖到目录行 = 移进那个目录';
    try { document.body.setPointerCapture(pointerId); } catch (_) { }
}

/** 给一条内容的行（折叠行 / 展开行）绑长按拖拽。 */
function favItemBindDrag(row, it) {
    row.dataset.itemId = it.id;
    row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // 输入框 / 图片 / 别的按钮上的按压不启动长按：那是选文本、看图、点操作。
        // ⚠ 折叠行本身就是 button —— `bad !== row` 把行自身放过去，否则整行都没法拖。
        // ⚠ contenteditable 富文本编辑器同理：在里面按住是要光标/选文本，
        //   450ms 后不能把整行拖走（还会 removeAllRanges 毁掉选区）。
        const bad = e.target.closest('input, textarea, img, a, button, [contenteditable="true"]');
        if (bad && bad !== row) return;
        if (favItemDrag) return;              // 已经有长按在计时/拖拽中
        favItemDrag = { id: it.id, x: e.clientX, y: e.clientY, active: false, holdTimer: 0 };
        favItemDrag.holdTimer = setTimeout(
            () => favItemHoldFire(e.pointerId),
            FAV_ITEM_HOLD_MS,
        );
    });
}

/** 指针位置对应的落点（纯计算，不碰 DOM）。
 *  kind = 'group'：放进某个目录（gid）；kind = 'item'：排到某条内容前/后。 */
function favItemTargetAt(x, y, selfId) {
    // 目录行优先：整行都是「放进这个目录」
    for (const r of document.querySelectorAll('.fav-row')) {
        const b = r.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
            return { kind: 'group', gid: r.dataset.id, before: (y - b.top) / Math.max(1, b.height) <= 0.35 };
        }
    }
    // 内容行：上 35% = 排它前面，下 35% = 排它后面，中间 = 无落点（不提示）
    for (const r of document.querySelectorAll('.fav-item-line, .fav-item-edit')) {
        if (r.dataset.itemId === selfId) continue;
        const b = r.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
            const rel = (y - b.top) / Math.max(1, b.height);
            if (rel <= 0.35) return { kind: 'item', id: r.dataset.itemId, before: true };
            if (rel >= 0.65) return { kind: 'item', id: r.dataset.itemId, before: false };
            return null;
        }
    }
    return null;
}

/** 拖拽中：按落点画高亮（插入线 / 目录框）。 */
function favItemPaintTarget(x, y) {
    document.querySelectorAll(
        '.fav-item-line.drag-over, .fav-item-edit.drag-over, .fav-row.drag-over',
    ).forEach((n) => n.classList.remove('drag-over', 'drag-before', 'drag-after'));
    const st = favItemDrag;
    if (!st || !st.active) return;
    const t = favItemTargetAt(x, y, st.id);
    if (!t) return;
    if (t.kind === 'group') {
        const r = document.querySelector(`.fav-row[data-id="${t.gid}"]`);
        if (r) r.classList.add('drag-over');
    } else {
        const r = document.querySelector(`[data-item-id="${t.id}"]`);
        if (r) r.classList.add('drag-over', t.before ? 'drag-before' : 'drag-after');
    }
}

function favItemDragClearMarks() {
    document.querySelectorAll(
        '.fav-item-line.dragging, .fav-item-edit.dragging, .fav-item-dragging-body',
    ).forEach((n) => n.classList.remove('dragging'));
    document.body.classList.remove('fav-item-dragging');
    document.querySelectorAll(
        '.fav-item-line.drag-over, .fav-item-edit.drag-over, .fav-row.drag-over',
    ).forEach((n) => n.classList.remove('drag-over', 'drag-before', 'drag-after'));
    const hint = $('favHint');
    if (hint) hint.textContent = '';
}

function favItemPointerUp(x, y) {
    const st = favItemDrag;
    favItemDrag = null;
    favItemDragClearMarks();
    if (!st || !st.active || x == null) return;   // 没真正拖起来（普通点击）→ 什么都不做
    favItemSuppressClick = true;                  // 兜底：松手后补发的 click 一律吞掉
    const t = favItemTargetAt(x, y, st.id);
    if (!t) return;                               // 落在空白/行中间：无操作
    favItemMove(st.id, t);
}

/** 把一条内容移到落点处（同目录排序 / 跨目录移动 / 放进目录）。
 *  全部按 id 重新解析 —— 拖拽的 450ms 里树可能被广播重建过。 */
function favItemMove(id, t) {
    const from = favItemOwner(id);
    if (!from) return;
    const src = from.g.items[from.i];
    if (t.kind === 'group') {
        const g = favFindGroup(t.gid);
        if (!g) return;
        from.g.items.splice(from.i, 1);
        (g.items = g.items || []).splice(t.before ? 0 : g.items.length, 0, src);
    } else {
        // 先摘自己，再找参照物的**新**下标（src 原先在它前面时索引会 -1）
        from.g.items.splice(from.i, 1);
        const ref = favItemOwner(t.id);
        if (!ref) {
            // 参照物不知为何没了：放回原目录末尾，总比丢了强
            from.g.items.push(src);
        } else {
            ref.g.items.splice(t.before ? ref.i : ref.i + 1, 0, src);
        }
    }
    favPersist();
    favRender();
}

/** 找一条内容所在的一级/二级目录和下标。找不到 = 已被删。 */
function favItemOwner(id) {
    for (const g of favTree) {
        const i = (g.items || []).findIndex((x) => x.id === id);
        if (i >= 0) return { g, i };
        for (const sub of g.children || []) {
            const j = (sub.items || []).findIndex((x) => x.id === id);
            if (j >= 0) return { g: sub, i: j };
        }
    }
    return null;
}

document.addEventListener('pointermove', (e) => {
    // 目录拖拽（grip）和内容长按拖拽共用这一个监听，前者优先
    if (favDragState) {
        if (!favDragState.active) {
            if (Math.hypot(e.clientX - favDragState.x, e.clientY - favDragState.y) < 5) return;
            favDragState.active = true;
            const src = document.querySelector(
                '.fav-row[data-id="' + (window.CSS ? CSS.escape(favDragState.g.id) : favDragState.g.id) + '"]');
            if (src) src.classList.add('dragging');
            try { document.body.setPointerCapture(e.pointerId); } catch (_) { }
        }
        favPaintTarget(e.clientX, e.clientY);
        return;
    }
    const st = favItemDrag;
    if (!st) return;
    if (!st.active) {
        // 长按计时期间动了（滚动 / 划词）：取消长按，把控制权还给页面
        if (Math.hypot(e.clientX - st.x, e.clientY - st.y) >= FAV_ITEM_MOVE_SLOP) favItemHoldCancel();
        return;
    }
    favItemPaintTarget(e.clientX, e.clientY);
});
document.addEventListener('pointerup', (e) => {
    if (favItemDrag) favItemPointerUp(e.clientX, e.clientY);
    else favDragEnd(e.clientX, e.clientY);
});
document.addEventListener('pointercancel', () => {
    if (favItemDrag) favItemPointerUp(null, null);
    else favDragEnd(null, null);
});
// 长按（尤其触屏）会召出系统右键菜单，拖拽中一律拦掉
document.addEventListener('contextmenu', (e) => {
    if (favItemDrag && favItemDrag.active) e.preventDefault();
});
// 长按中途切窗（Alt+Tab / 点任务栏）：pointerup 可能永远不来，
// 主动收摊 —— 免得源行一直挂着 .dragging、body 一直禁着划词。
window.addEventListener('blur', () => {
    if (!favItemDrag) return;
    favItemDrag = null;
    favItemDragClearMarks();
});
// 长按触发过拖拽时，浏览器随后补发的那一次 click 必须吞掉 ——
// 否则「长按 → 拖动 → 松手」会把行顺手展开成编辑态。
document.addEventListener('click', (e) => {
    if (!favItemSuppressClick) return;
    favItemSuppressClick = false;
    e.stopPropagation();
    e.preventDefault();
}, true);

/** 一次把一棵子树（或整棵树）**按目录层级**摊开 / 收起。
 *
 *  g = null 表示**整棵树**（工具条上那两颗「全部展开 / 全部折叠」）。
 *  小到二级目录那两颗按钮（作用范围 = 该二级目录自己的内容）也走这一个函数，
 *  这样"展开到哪一级"的语义只有一处定义，不会两个入口两种深浅。
 *
 *  ⚠ 只管目录（favGroupOpen），**不碰条目的编辑态**（favItemOpen）：
 *  这两件事是两个维度 —— 目录是"要不要看到里面"，条目是"要不要打字改它"。
 *  展开时如果连条目也摊开，用户点的是「全部展开」却得到"一屏输入框"，
 *  明确报过这个问题。折叠时顺手把条目收回去是合理的（都叫「全部折叠」了，
 *  不该还留着一堆摊开的编辑器），所以只有 open=false 那一支动 favItemOpen。 */
function favSetSubtreeOpen(g, open) {
    const walk = (node) => {
        if (!node) return;
        // 只管**目录层级**（favGroupOpen）。
        //
        // ⚠ 以前这里还顺手 `favItemOpen.set(it.id, open)` —— 于是点「全部展开」会把
        //   每条内容都摊开成编辑态（文字框 + 备注框），一屏全是输入框，用户点了
        //   「展开目录」却得到「开始编辑每一条」，明确报过。条目的编辑态是**另一个
        //   维度**：由用户自己点那一行来控制。折叠时顺手把它们收回去是合理的
        //   （都叫「全部折叠」了，不该还留着一堆摊开的编辑器），展开时不动。
        favGroupOpen.set(node.id, open);
        if (!open) for (const it of node.items || []) favItemOpen.set(it.id, false);
        for (const c of node.children || []) walk(c);
    };
    if (g) walk(favCur(g) || g);   // 树可能已被广播重建，按 id 取回活引用
    else for (const root of favTree) walk(root);
    favRender();
}

function favGroupNode(g, level) {
    // r48：展开态挂 .open —— 卡片描边/淡底跟着它变（和帮助页 .help-item[open] 同一套）。
    const open = favGroupIsOpen(g.id);
    const wrap = document.createElement('div');
    wrap.className = 'fav-group' + (level === 2 ? ' lv2' : '') + (open ? ' open' : '');

    // —— 目录标题行 ——
    const row = document.createElement('div');
    row.className = 'fav-row';

    /* r48：折叠/展开只有这一处逻辑 —— 箭头按钮点它、点整行摘要也点它
     * （帮助页目录就是"点标题那一行"开合；收藏夹这张卡也照做，
     *  不然那颗 22px 的箭头太难点）。
     * ⚠ 拖拽把手、正在改名的输入框、以及行内其它按钮都要排除掉。 */
    const toggleOpen = () => {
        const cur = favCur(g);              // 树可能已被广播重建，写旧对象会丢
        if (!cur) return;
        favGroupOpen.set(cur.id, !open);
        favRender();
    };
    const groupEmpty = !(g.items || []).length && !(g.children || []).length;
    if (!groupEmpty) {
        const fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'mini fold' + (open ? '' : ' closed');
        fold.textContent = open ? '▾' : '▸';
        fold.title = open ? '折叠这个目录' : '展开这个目录';
        fold.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });
        row.appendChild(fold);
    }

    // —— 拖拽排序 / 调层级（pointer 事件，WebView2 上比 HTML5 拖放稳）——
    // 把手虽是独立 span，但 HTML5 拖放在 WebView2 里 dragstart 经常不触发，
    // 表现就是"按住把手纹丝不动"。改 pointer 事件后一定可靠。
    // 拖到另一行边缘（上 28% / 下 28%）= 排到它前/后；
    // 拖到另一行中央 = 降为它的二级目录；拖到最下面的根落点 = 升为一级。
    row.dataset.id = g.id;
    row.dataset.level = String(level);
    const grip = document.createElement('span');
    grip.className = 'fav-grip';
    grip.textContent = '⋮⋮';
    grip.title = '按住我拖：拖到别的目录边缘=排序；拖到中央=变成它的二级目录；拖到最下面=升为一级';
    grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();   // 别误触发行的折叠 / 输入框
        favDragStart(g, level, e);
    });
    row.appendChild(grip);

    const nm = document.createElement('input');
    nm.className = 'txt fav-name';
    nm.value = g.name;
    /* 目录名一律**占位文字**，不是内容：
     *   · 新建目录的 name 是空串 → 这里灰着「新一级目录 / 新二级目录」，
     *     看得见、一打字就被顶掉（用户要求的 placeholder 语义）；
     *   · 已有目录也不拿它当提示（它自己的名字已经填在 value 里了）。 */
    nm.placeholder = level === 1 ? '新一级目录' : '新二级目录';
    nm.spellcheck = false;
    nm.dataset.gid = g.id;   // 新建后要按 id 把光标找回来

    /* 目录名默认**只读**（用户要求：「已添加的目录不应始终处于可编辑状态」），
     * 点「重命名」才进编辑态；回车 / 失焦 / Esc 退出。
     * Esc 与回车的区别：Esc 丢弃这次改动（把 value 拨回树里的值再失焦），
     * 回车等于"改完了"（走 change → 落盘）。 */
    nm.readOnly = true;
    const setEditing = (on) => {
        nm.readOnly = !on;
        nm.classList.toggle('editing', on);
        if (on) {
            nm.focus();
            try { nm.select(); } catch (_) { }
        }
    };
    const commit = () => {
        const cur = favCur(g);          // 树可能已被广播重建，写旧对象会丢
        if (!cur) return;
        const v = nm.value.trim();
        if (v !== cur.name) {
            cur.name = v;
            favPersist();
        }
        favNewly.delete(g.id);          // 起过名（哪怕还是空的）就不再是"新建中"了
        setEditing(false);
    };
    nm.addEventListener('change', commit);
    nm.addEventListener('blur', commit);
    nm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            nm.blur();                   // 走 blur → commit
        } else if (e.key === 'Escape') {
            e.preventDefault();
            nm.value = (favCur(g) || {}).name || '';
            nm.blur();
        }
    });
    row.appendChild(nm);
    // 新建的目录：渲染挂进文档之后再进编辑态（渲染途中 focus 是无效的）
    if (favNewly.has(g.id)) {
        setTimeout(() => {
            if (nm.isConnected) setEditing(true);
        }, 0);
    }

    const ops = document.createElement('span');
    // r48：这一排按钮从「摘要行」搬进了卡内正文（见下面 .fav-body）——
    // 展开才看得见。类名同时留 .ops（老选择器 / 探针认得它）。
    ops.className = 'ops fav-ops';
    // 「重命名」：目录名默认只读，点它才进编辑态（用户要求：
    // 已添加的目录不该始终可编辑 —— 否则框里整天是个有光标的输入框，
    // 用户只是想点一下目录、结果把名字改出一个字符）。
    favBtn(ops, '重命名', '改这个目录的名字（改完回车，或点别处）', () => setEditing(true));
    // 放进横条 / 换图标：**两级目录都可以**（用户要求）。
    // 「＋ 二级目录」只有一级才有 —— 最多两级。
    {
        const sentinel = QS_FAV_PREFIX + g.id;
        const on = (CONF.barList || []).includes(sentinel);
        const t = favBtn(ops, on ? '已在横条' : '放进横条', '把目录放进横条，点开就能看到内容',
            () => invoke('toggle_bar_engine', { engine: sentinel, on: !on }).then(favRender));
        if (on) t.classList.add('on');
        favBtn(ops, '换图标', '给横条上这颗目录换个图标', () => invoke('pick_icon', { engine: sentinel }));
        // #143「编辑图标」：目录图标只有 overrideIcons 和 legacy g.icon 两个来源
        // （qsFavIconNode 的口径），没有内置图可吃，所以第三个参数把 g.icon 递进去。
        if (hasIconToEdit(sentinel, null, (favCur(g) || {}).icon || '')) {
            favBtn(ops, '编辑图标', '编辑这颗图标：一键消除背景、前后对比',
                () => openIconEditor(sentinel, null, (favCur(g) || {}).icon || ''));
        }
        if (level === 1) {
            favBtn(ops, '＋ 二级目录', '在这个一级目录里建一个二级目录', () => {
                const cur = favCur(g);
                if (!cur) return;
                // 同「添加一级目录」：name 留空 = placeholder 语义（灰着「新二级目录」）
                const sub = { id: favNewId(), name: '', icon: '', items: [], children: [] };
                (cur.children = cur.children || []).push(sub);
                favNewly.add(sub.id);          // 建完直接进"重命名中"，抬手就能打字
                favGroupOpen.set(sub.id, true);
                favPersist();
                favRender();
            });
        } else {
            favBtn(ops, '升为一级', '把这个二级目录提升为一级目录', () => {
                const cur = favCur(g);
                if (!cur) return;
                favDetach(cur);
                favTree.push(cur);
                favPersist();
                favRender();
            });
            /* 「全部展开 / 全部折叠」—— 用户要求二级目录旁边也放一份，
             * 作用范围 = **这个二级目录自己的内容**：它自己 + 它下面每一条收藏。
             * （二级目录下不再有子目录，"内容"就是那些条目行。） */
            favBtn(ops, '全部展开', '展开这个二级目录里的全部内容', () => favSetSubtreeOpen(g, true));
            favBtn(ops, '全部折叠', '折叠这个二级目录里的全部内容', () => favSetSubtreeOpen(g, false));
        }
    }
    favBtn(ops, '＋ 文字', '收藏一段文字', () => favAddItem(g, 'text'));
    favBtn(ops, '＋ 图片', '从电脑里挑一张图', () => favAddItem(g, 'image'));
    // 删除必须**按 id**：favTree 会被配置广播整树重建，闭包里的 g 是游离对象，
    // 按引用 filter 永远删不掉（用户报的「删除目录删除不了」就是它）。
    // favRemoveGroup 同时覆盖一级（在根上）和二级（在父目录的 children 里）。
    const del = favBtn(ops, '删除', '删除这个目录（里面的内容一起删）',
        () => favArmedDelete(del, () => {
            favRemoveGroup(g.id);
            favPersist();
            favRender();
        }));
    /* r48：点摘要行（目录名 / 项数 / 空白处）= 展开或折叠 —— 和帮助页目录一个手感。
     * 排除：拖拽把手（那是拖的）、正在改名的输入框（那是打字的）、箭头（自己处理了）。 */
    if (!groupEmpty) {
        row.addEventListener('click', (e) => {
            const t = e.target;
            if (t === grip) return;
            if (t === nm && !nm.readOnly) return;
            if (t.closest && t.closest('.mini')) return;
            toggleOpen();
        });
    }

    /* 摘要行右侧：项数 + 「在横条」徽标。
     * r48 起折叠态只剩这一行，所以这两件事必须在**这一行**里说完：
     *   · 项数 = 内容条数 + 二级目录数（用户不用展开就知道里面有多少东西）；
     *   · 「在横条」= 这个目录已经放进横条（以前只有按了才会变成"已在横条"的按钮，
     *     折叠后连按钮都看不见了）。 */
    {
        const n = (g.items || []).length + (g.children || []).length;
        const cnt = document.createElement('span');
        cnt.className = 'fav-count';
        cnt.textContent = n ? n + ' 项' : '空目录';
        row.appendChild(cnt);
        const sentinel = QS_FAV_PREFIX + g.id;
        if ((CONF.barList || []).includes(sentinel)) {
            const onbar = document.createElement('span');
            onbar.className = 'fav-onbar';
            onbar.textContent = '在横条';
            onbar.title = '这个目录已经放进横条了：在横条上点它就能看到里面的内容';
            row.appendChild(onbar);
        }
    }
    wrap.appendChild(row);

    /* r48：折叠时整个正文不渲染（这才是"收起来"）；展开时正文 = 操作按钮 + 内容 + 二级目录。
     * ⚠ 这里以前还会补一行「已折叠 · N 项」的提示，用户明确要求删掉：
     *   折叠箭头自带状态（▾/▸），项数徽标现在直接写在摘要行上，再加一行字只是噪音。 */
    if (!open) return wrap;

    const body = document.createElement('div');
    body.className = 'fav-body';
    body.appendChild(ops);
    (g.items || []).forEach((it) => body.appendChild(favItemNode(it, () => {
        // 同删除目录的理由：按 id 删，别按引用（树可能已被广播重建）
        const cur = favCur(g);
        if (!cur) return;
        cur.items = (cur.items || []).filter((x) => x.id !== it.id);
        favPersist();
        favRender();
    })));
    (g.children || []).forEach((sub) => body.appendChild(favGroupNode(sub, 2)));
    wrap.appendChild(body);

    return wrap;
}

/** 一条内容。
 *  默认**收成一行**（用户要求）：左边备注（显眼），右边内容预览；
 *  点这一行才展开成编辑态（文字框 / 缩略图 + 备注框）。 */
function favItemNode(it, delFn) {
    // 默认折叠：左边备注、右边内容预览成一行的形态
    const preview = it.kind === 'image'
        ? '[图片]' + (it.remark ? '' : '')
        : (it.text || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '（空内容）';

    if (!favItemIsOpen(it.id)) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'fav-item-line';
        const rm = document.createElement('b');
        rm.className = 'fav-rm';
        rm.textContent = it.remark || '（无备注）';
        row.appendChild(rm);
        const prev = document.createElement('span');
        prev.className = 'fav-prev';
        prev.textContent = preview;
        row.appendChild(prev);
        // 存了带格式内容（颜色/加粗…）时给个小徽标：用户能一眼看出
        // 「这条的颜色保住了」，展开后编辑器里也是彩色的。
        if (it.kind === 'text' && it.html) {
            const fmt = document.createElement('small');
            fmt.className = 'fav-fmt';
            fmt.textContent = '带格式';
            fmt.title = '这条收藏存有带格式的内容（颜色/加粗等），展开可见';
            row.appendChild(fmt);
        }
        const hint = document.createElement('small');
        hint.className = 'fav-edit-hint';
        hint.textContent = '点击编辑';
        row.appendChild(hint);
        row.addEventListener('click', () => {
            favItemOpen.set(it.id, true);
            favRender();
        });
        favItemBindDrag(row, it);
        return row;
    }

    const row = document.createElement('div');
    row.className = 'fav-item-edit' + (it.kind === 'image' ? ' is-img' : '');

    if (it.kind === 'image' && it.image) {
        const img = document.createElement('img');
        img.className = 'fav-thumb';
        img.src = it.image;
        img.alt = '';
        img.draggable = false;
        row.appendChild(img);
    }

    const mid = document.createElement('div');
    mid.className = 'fav-mid';
    if (it.kind === 'text') {
        /* ★ 富文本编辑器：contenteditable 而不是 textarea ★
         *   用户要求「收藏夹文本框里的文字颜色跟着文本的格式走」——
         *   从网页 / Word 复制的红字、高亮、加粗粘进收藏夹，颜色要原样
         *   显示。textarea 显示不了颜色，所以这里必须是 contenteditable。
         *
         * 数据面：树里同时存两份 ——
         *   · it.text 纯文本影子（预览、搜索用， innerText 派生）；
         *   · it.html  sanitize 过的 HTML（显示/复制用，粘贴时由
         *     qsSanitizeRichText 白名单过滤，渲染前再过滤一次）。
         *   老数据没有 html 字段 → 走 textContent 老路，行为不变。
         *
         * 持久化：input 防抖 500ms + blur 立即落盘。不每键都写 ——
         *   每次 favPersist 都是一次 set_setting + 整树广播。 */
        const ta = document.createElement('div');
        ta.className = 'ta rich';
        ta.contentEditable = 'true';
        ta.setAttribute('role', 'textbox');
        ta.setAttribute('aria-multiline', 'true');
        ta.dataset.ph = '要收藏的文字内容';
        ta.spellcheck = false;
        if (it.html) ta.innerHTML = window.qsSanitizeRichText(it.html);
        else ta.textContent = it.text || '';
        ta.classList.toggle('empty', !(ta.innerText || '').trim());

        let favHold = 0;
        const favFlush = () => {
            clearTimeout(favHold);
            const cur = favFindItem(it.id);   // 树可能已被广播重建，写旧对象会丢
            if (!cur) return;
            cur.text = (ta.innerText || '').replace(/\u00a0/g, ' ');
            cur.html = window.qsSanitizeRichText(ta.innerHTML);
            ta.classList.toggle('empty', !cur.text.trim());
            favPersist();
        };
        ta.addEventListener('input', () => {
            clearTimeout(favHold);
            favHold = setTimeout(favFlush, 500);
        });
        ta.addEventListener('blur', favFlush);
        // 粘贴：优先 text/html（带格式）→ sanitize → 原样插入；
        // 没有 html 格式（记事本、终端）就按纯文本插，别把 \n 变成一堆 <div>。
        ta.addEventListener('paste', (e) => {
            const cd = e.clipboardData;
            if (!cd) return;
            const html = cd.getData('text/html');
            if (html) {
                e.preventDefault();
                const clean = window.qsSanitizeRichText(html);
                if (clean) document.execCommand('insertHTML', false, clean);
                return;
            }
            const txt = cd.getData('text/plain');
            if (txt) {
                e.preventDefault();
                document.execCommand('insertText', false, txt);
            }
        });
        mid.appendChild(ta);
    }
    const rm = document.createElement('input');
    rm.className = 'txt';
    rm.placeholder = '备注（可选，横条上会显示）';
    rm.value = it.remark || '';
    rm.spellcheck = false;
    rm.addEventListener('change', () => {
        const cur = favFindItem(it.id);
        if (!cur) return;
        cur.remark = rm.value.trim();
        favPersist();
    });
    mid.appendChild(rm);
    row.appendChild(mid);

    const ops = document.createElement('span');
    ops.className = 'ops';
    const del = favBtn(ops, '删除', '删除这条收藏', () => favArmedDelete(del, delFn));
    del.classList.add('danger');
    const close = favBtn(ops, '收起', '收成一行', () => {
        favItemOpen.set(it.id, false);
        favRender();
    });
    row.appendChild(ops);
    favItemBindDrag(row, it);
    return row;
}

// 「添加一级目录」
$('btnFavAddGroup').addEventListener('click', () => {
    /* 新建的一级目录 name 是**空的**（不是"新目录"这个真值）—— 这是用户要的
     * 占位文字语义：输入框里灰着「新一级目录」，看得见，一打字就被顶掉、
     * 占位自动消失。往 name 里塞真值就变成了"内容"，用户明确不要那种。 */
    const g = { id: favNewId(), name: '', icon: '', items: [], children: [] };
    favTree.push(g);
    // 新建的目录直接进"重命名中"（favNewly），并且一定是展开的 —— 不然用户点完
    // 看不到自己刚建的东西，会以为没反应。
    favNewly.add(g.id);
    favGroupOpen.set(g.id, true);
    favPersist();
    favRender();
});

/* ---- 工具条上的「全部展开 / 全部折叠」----
 * 用户要求放在「添加一级目录」旁边，作用范围是**所有一级目录**
 * （顺带把二级目录和里面的条目也一起摊开 / 收起 —— 只开一级的话，
 *  一级开着一堆合着的二级，看着不像"全展开"）。 */
$('btnFavExpandAll').addEventListener('click', () => favSetSubtreeOpen(null, true));
$('btnFavCollapseAll').addEventListener('click', () => favSetSubtreeOpen(null, false));

/* ---- 唤起收藏夹的组合键：点按钮进入录入态，下一个按键组合就是答案 ---- */
let favHotkeyArmed = false;
function favHotkeyLabel(s) {
    return s ? s : '未设置';
}
/** 「清除」按钮的可用态 + 提示。设了才可点。
 *
 *  用户反馈：软件里能自定义快捷键的地方**都没有取消的入口** —— 录完发现冲突 /
 *  不好用，只能再录一个别的把旧的顶掉，回不到"根本没有快捷键"。这里补上清除。
 *  三个状态（已设置 / 未设置 / 正在录入）都要有明确的可视反馈，不然用户点完
 *  不知道到底清掉没有。 */
function favHotkeySyncUI() {
    const b = $('btnFavHotkey');
    const c = $('btnFavHotkeyClear');
    const hint = $('favHotkeyHint');
    const cur = (CONF && CONF.favHotkey) || '';
    if (b && !favHotkeyArmed) b.textContent = favHotkeyLabel(cur);
    if (c) {
        c.disabled = !cur;
        c.title = cur ? '取消快捷键「' + cur + '」（收藏夹不再有唤起键）' : '现在就没有设置快捷键';
    }
    if (hint) hint.textContent = cur ? '当前：' + cur + '（点「清除」可取消）' : '当前没有快捷键';
}
/** 退出录入态并把按钮文案复位。 */
function favHotkeyDisarm() {
    if (!favHotkeyArmed) return;
    favHotkeyArmed = false;
    favHotkeySyncUI();
}
$('btnFavHotkey').addEventListener('click', () => {
    favHotkeyArmed = !favHotkeyArmed;
    $('btnFavHotkey').textContent = favHotkeyArmed ? '请按下组合键…' : favHotkeyLabel((CONF && CONF.favHotkey) || '');
    if (favHotkeyArmed) {
        const hint = $('favHotkeyHint');
        if (hint) hint.textContent = '正在录入：按下组合键，或按 Esc 放弃';
    } else {
        favHotkeySyncUI();
    }
});
/* 清除 = 把 favHotkey 置空。后端 `set_setting("favHotkey", "")` 会重新注册
 * 全局钩子（空串 = 不注册），回广播后这条 UI 自动复位 —— 这里先给一次即时反馈，
 * 免得等广播的那几十毫秒里用户以为没生效。 */
$('btnFavHotkeyClear').addEventListener('click', () => {
    favHotkeyArmed = false;
    const cur = (CONF && CONF.favHotkey) || '';
    if (!cur) return;
    invoke('set_setting', { key: 'favHotkey', value: '' }).catch(() => {});
    const b = $('btnFavHotkey');
    if (b) b.textContent = '未设置';
    const hint = $('favHotkeyHint');
    if (hint) hint.textContent = '已清除：' + cur + ' 不再唤起收藏夹';
    const c = $('btnFavHotkeyClear');
    if (c) { c.disabled = true; c.title = '现在就没有设置快捷键'; }
    toast('已清除快捷键 ' + cur);
});
// ⚠ 录入态是「捕获阶段吞掉所有按键」的：以前唯一的解除入口是再点一次那颗按钮
//   （或录到一个合法组合 / Esc）。用户点开录入态后改主意去别处打字，就会发现
//   整个设置页都打不进字。这里补三条退路：点到别处、窗口失焦、按 Esc。
document.addEventListener('pointerdown', (e) => {
    if (favHotkeyArmed && e.target !== $('btnFavHotkey')) favHotkeyDisarm();
}, true);
window.addEventListener('blur', favHotkeyDisarm);

window.addEventListener('keydown', (e) => {
    if (!favHotkeyArmed) return;
    e.preventDefault();
    e.stopPropagation();
    // Esc = 放弃录入
    if (e.key === 'Escape') {
        favHotkeyDisarm();
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let main = null;
    if (/^[a-zA-Z]$/.test(e.key)) main = e.key.toUpperCase();
    else if (/^[0-9]$/.test(e.key)) main = e.key;
    else if (/^F([1-9]|1[0-2])$/.test(e.key)) main = e.key.toUpperCase();
    if (!main) {
        // 按了个不带主键的（比如只按了 Ctrl）—— 提示但不结束录入
        $('btnFavHotkey').textContent = '再按一个字母 / 数字 / F 键…';
        return;
    }
    parts.push(main);
    if (parts.length < 2) {
        $('btnFavHotkey').textContent = '至少要带一个 Ctrl / Alt / Shift…';
        return;
    }
    const combo = parts.join('+');
    // ⚠ Ctrl+C 是「复制取词」的保留键：钩子里收藏夹热键排在取词前面，
    //   录成 Ctrl+C 的话每次复制都会直接展开收藏夹，取词就废了
    //   （用户遇到的「Ctrl+C 唤出横条默认展开收藏夹」正是录了这个组合）。
    //   Ctrl+Alt+O 是 OCR 框选的保留键，同样不收。
    if (combo === 'Ctrl+C' || combo === 'Ctrl+Alt+O') {
        favHotkeyArmed = false;
        favHotkeySyncUI();
        toast(combo === 'Ctrl+C'
            ? 'Ctrl+C 是复制取词的快捷键，不能给收藏夹，换一个组合吧'
            : 'Ctrl+Alt+O 是文字识别的快捷键，不能给收藏夹，换一个组合吧');
        return;
    }
    favHotkeyArmed = false;
    // 先给即时反馈（回广播前的那几十毫秒里按钮就该显示新组合），
    // 「清除」按钮的可用态等广播回来由 favHotkeySyncUI 统一刷新。
    $('btnFavHotkey').textContent = favHotkeyLabel(combo);
    const hkHint = $('favHotkeyHint');
    if (hkHint) hkHint.textContent = '当前：' + combo + '（点「清除」可取消）';
    const hkClear = $('btnFavHotkeyClear');
    if (hkClear) { hkClear.disabled = false; hkClear.title = '取消快捷键「' + combo + '」（收藏夹不再有唤起键）'; }
    invoke('set_setting', { key: 'favHotkey', value: combo }).catch(() => {});
}, true);


/* ------------------------------------------------------------------ */
/* 关于                                                                */
/* ------------------------------------------------------------------ */

/** 「关于」页里「使用的工具」那一排胶囊。
 *
 *  写成常量而不是从后端下发：这些是**编译期就定死的技术栈**，不会随运行
 *  环境变化，放前端省一次配置序列化。版本号级的自由度（比如 Tauri 升了
 *  大版本）跟着代码一起改，这本来就是一次发版动作。 */
const ABOUT_TOOLS = [
    'Tauri 2',
    'Rust',
    'WebView2',
    '原生 HTML / CSS / JS',
    'ureq（联网请求）',
    'image（图像编码）',
    'AES-256-GCM + Argon2id',
    'windows-rs',
    // ⚠ r46 起 OCR 不只两家了：14 家在线 + 1 家本地。这里列的是**类别**，
    //   不逐一罗列厂商（名单会变，而且界面里那份才是准的）。
    'Windows.Media.Ocr（本地识别）',
    'OpenAI 兼容视觉接口（硅基流动 / Kimi / 智谱 / 百炼 / 方舟 / OpenAI / Gemini / OpenRouter…）',
    '百度智能云 OCR',
    '腾讯云 / 有道 / OCR.space / Mistral OCR',
];

/** 渲染引擎（WebView2）的真实版本。
 *
 *  为什么从 UA 里抠而不问后端：WebView2 是**系统组件**，跟着 Edge 自己升级，
 *  和本软件的版本完全无关。用户报「某个样式在我这儿不对」时，十有八九是
 *  他那台机器的 WebView2 还停在好几年前 —— 这一行就是答案。
 *  抠不到（老内核 UA 里可能没有 Edg/）就整行藏起来，不留一个「未知」占位置。 */
function webviewLabel() {
    const m = /Edg\/(\d+\.\d+\.\d+)/.exec(navigator.userAgent || '');
    return m ? 'WebView2 · Edge ' + m[1] : '';
}

/** 「关于」页里「更新日志」那几段。
 *
 *  写成常量而不是从后端下发：它跟着**发版**走，本来就是一次代码改动 ——
 *  跟 `ABOUT_TOOLS` 同一个理由。只记用户能感知到的大功能，小修小补不占地方
 *  （那些在验收报告里，不在这里）。
 *
 *  写的时候守两条规矩：
 *   1. **从上往下是新到旧**，最新的排最前；
 *   2. 每条都用「用户能看懂的词」，不写模块名、不写函数名 ——
 *      看这页的人是用户，不是读代码的人。
 *
 *  ⚠ r80k 改掉的一个毛病：原来最新那条写的是
 *  `ver: 'v' + CONF.version + ' · 最新'` —— 版本号是**动态**的，
 *  于是不管发到哪个版本，它都显示"当前版本"，而里面的文字却还是
 *  v1.0.0 那批功能。用户看到的就是"版本号没更新"（其实更新了，
 *  但日志内容没跟着走）。现在**每条都写死自己的版本号**，
 *  发新版时**同时**加一条，对不上就是漏了。 */
const CHANGELOG = [
    {
        ver: 'v1.5.16',
        en: 'Translation is no longer "one engine, one model": eight engines share one list in Settings (pick a default, tick a few extras), models can be pulled from your account instead of typed by hand, and every engine now gets its own box in the translation window, filled in parallel. When one engine fails, only its own box goes red — the others still deliver.',
        items: [
            '<b>翻译不再是"只有一家、只有一个模型"</b> —— 设置页的翻译栏现在和「文字识别」一个路子：<b>八家引擎</b>（硅基流动 / 智谱 GLM / 通义千问 / DeepSeek / Kimi / 火山方舟 / OpenAI / 自定义）排成一列，<b>点一行就是把它设为默认引擎</b>；每家的 API Key、接口地址、模型名<b>各自一份</b>，换一家不用重新填一遍。',
            '<b>模型名可以「拉取」了</b> —— 以前只能手敲，敲错一个字母就报错。现在和识别一样，点「拉取模型」把这家账号下能用的模型列出来（只列<b>能对话</b>的那些，带「对话」小标），点一下就选用，还能顺手「测试连接」真翻一句话确认 Key 通不通。',
            '<b>可以几家一起翻，结果并排摆开</b> —— 勾上「同时翻译」，一次翻译会<b>并行</b>问好几家；翻译窗里<b>一家一个框</b>并排呈现，框顶上写着引擎名和模型，各自的状态（等待中 / 已完成 / 失败）各自标，<b>一家的译文不会盖掉另一家</b>。',
            '<b>一家出错，不连坐其他家</b> —— Key 过期、额度用完、网络不通，只有那一家的框变红，并在它自己下面写清楚原因（比如「API Key 不对或已失效（401）」）；别家该出译文照常出。底部汇总条会告诉你几家没翻出来、第一家是什么原因。',
            '<b>翻译窗本身也顺过了</b> —— 默认尺寸放宽到 860×600（两家并排不用换行，最小仍是 520×320）；点过哪个框，「复制译文」就复制哪个框的；切目标语言会<b>按新语言重翻</b>，不是只改个标题；Ctrl+Enter 直接翻，Esc 关窗。',
        ],
    },
    {
        ver: 'v1.5.15',
        en: 'If the Microsoft Edge WebView2 runtime is missing, the app now says so in plain words and offers a one-click trip to the official Microsoft download page, instead of doing nothing at all when you double-click it.',
        items: [
            '<b>缺运行组件时不再"双击没反应"</b> —— 整个界面是靠 Windows 的 <b>Microsoft Edge WebView2</b> 渲染的。Win11 自带、Win10 多数跟着 Edge 装好了，但 LTSC、精简版系统里被移除是常事。以前那种机器上双击图标，<b>进程起来又立刻退出，一个提示都没有</b>；现在会弹一个明确的说明框，点「是」直接打开<b>微软官方下载页</b>，装完再打开就能用。',
            '<small>检测刻意做得"宽松"：<b>三处证据</b>（WebView2 自己的接口、注册表登记、磁盘上的 msedgewebview2.exe）<b>任何一处查到就当作已安装</b>。宁可漏判也不误判 —— 把一台本来能用的电脑挡在门外，比漏掉一次提示糟得多。万一真遇到误判，用 <code>QuickSearch.exe --skip-webview2-check</code> 可以强行启动。</small>',
        ],
    },
    {
        ver: 'v1.5.14',
        en: 'Startup password: setting one now asks for it twice and refuses to save when the two entries differ, turning it off requires re-entering the current password, and the unlock window finally closes the moment the password is accepted — plus a Quit button for when you would rather not unlock.',
        items: [
            '<b>设启动密码现在要输两遍</b> —— 第一遍填密码、第二遍确认，<b>两次不一样就不许保存</b>，会红字告诉你「两次输入的密码不一致」并把第二个框清空让你重输。这不是多余的礼貌：启动密码<b>没有找回入口</b>（忘了只能手动删配置文件里那行哈希），单框时代打错一个字母，下次启动就把自己锁在门外了。改密码、第一次设密码都走这一步。',
            '<b>输对密码后锁屏窗立刻消失</b> —— 以前它会赖在屏幕上不动，明明密码对了却像卡住。原因是这个窗口为了防 Alt+F4 绕过密码，把「关闭」这件事整个拦住了 —— 连程序自己在密码正确后发的那次关闭也一起被拦。现在改成<b>直接销毁窗口</b>（不经过"关闭请求"这道闸），并且解锁之后的关闭请求一律放行，怎么都不会再卡住。',
            '<b>解锁后会亮出主界面</b> —— 解锁成功不只是"窗口没了"：横条（平时只活在托盘里的那个搜索框）会跟着弹出来，你能直接开始用。',
            '<b>锁屏窗左下角多了「退出程序」</b> —— 不想输密码、或者只是点错了，可以从这里干净地退出，不用去任务管理器杀进程。这条退出<b>不会</b>触发「退出时同步」：锁着的时候没必要把配置推到云端。',
            '<b>关掉启动密码要先验一遍原密码</b> —— 开关一拨不会再直接卸掉保护：先让你输当前启动密码，<b>验过才真的清掉</b>；输错或点「取消」，保护一点没动、开关弹回打开。后端也认这一条：绕过界面直接给「设置」传空值会被拒，所以「再输一次密码」不是只摆在界面上看的。',
        ],
    },
    {
        ver: 'v1.5.13',
        en: 'Interface language (Simplified Chinese / English) with a full English pass over every page and window, an automatic update prompt at launch with a download window that shows in the taskbar and a working Cancel, and an optional startup password that is separate from the backup password.',
        items: [
            '<b>新增：界面语言（简体中文 / English）</b> —— 「通用 → 语言」里切换，<b>当场生效、不用重启</b>，并且跟着配置持久化：换台电脑恢复备份之后还是你选的那种语言。中文是默认值，英文是一整套人工翻译（<b>不只是标签</b>：设置页每一段说明、帮助页整篇、横条面板、OCR 结果窗、更新窗、锁屏窗都在里面），切回中文是<b>还原成原文</b>而不是"再翻一遍"，所以你看到的每个字都和以前完全一样。',
            '<b>新增：启动时提示新版本</b> —— 每次打开软件自动查一次，有新版就弹一个窗告诉你版本号、更新说明和体积。<b>下载窗口会出现在任务栏里</b>（不再是一个容易被当成后台进程的隐形窗口），下到百分之几、还剩多少都写在上面；<b>「取消下载」随时可点</b> —— 取消之后<b>不会再偷偷换一条链路继续下</b>，已经下好的部分留着，下次点下载接着下。',
            '<b>新增：启动密码</b> —— 「通用 → 启动密码」可以开一项保护：开启后<b>启动软件必须先输入密码</b>，横条、快捷键 Ctrl+C、Ctrl+Alt+O、设置页、识图、托盘菜单<b>全都进不去</b>，输入正确才解锁。<b>关着的时候完全不影响使用</b>（默认就是关的）。它是<b>独立的一把密码</b>，和备份密码互不相同、互不影响：改这个不会动那个，忘了这个也照样能用备份密码恢复数据。密码本身只存 Argon2id 哈希，配置文件里看不到原文。',
            '<small>说明：v1.5.7 定下的「没填令牌不许在程序内下载」这条规则去掉了 —— 真正吃 GitHub 额度的是"查版本"，而公开仓库的更新包匿名就能下。现在<b>无论填没填令牌，点了下载就开始下</b>；令牌只影响查版本的额度（60 → 5000 次/小时）。</small>',
        ],
    },
    {
        ver: 'v1.5.11',
        en: 'Downloads: the 15-second cap is gone, an interrupted download resumes where it stopped, a second entry point is tried automatically, and a failure now states the reason and offers the browser as a fallback.',
        items: [
            '<b>「能检测到新版、却下载不下来」修好了</b> —— 这不是网络问题（虽然看起来很像），是三个自己的毛病叠在一起。① <b>下载被 15 秒总超时掐断</b>：那个超时本来是给"查一下有没有新版"用的，结果连"把 13MB 下完"也算在里头 —— 网速慢一点就必然失败，报出来还是"下载中断"，谁都会以为是网络断了。现在下载只限制"连不上"和"卡住不动"，只要还在往下走，下多久都行。',
            '<b>下载断了能接着下，不用从头来</b> —— 以前网一抖、下到 90% 断了，整份作废，你再点一次还是从 0 开始，在不稳的网络里就永远下不完。现在会记住已经下了多少，断了从那个位置接着下；同一轮还会自动重试几次。',
            '<b>一条路不通会自动换另一条</b> —— 更新包有两个入口（<code>github.com</code> 和 <code>api.github.com</code>），它俩最后到同一个地方，但入口这一步经常会一个通、一个不通。以前只走前一个，现在前一个不行就换后一个。',
            '<b>失败时会说清原因，并直接给你另一条路</b> —— 以前失败只在页面上写一句"更新失败"，真正的原因塞进一闪而过的提示里，你根本来不及看。现在原因会留在按钮旁边（包括"已自动重试 4 轮"），并且主按钮会<b>自动变成「用浏览器下载」</b>，下面连直链一起显示出来，复制或点开都行。',
            '<small>说明：这次修的是<b>下载器本身</b>，所以要装上这一版之后才生效。如果你现在卡在旧版下载不下来，请直接去 Release 页面手动下这一次（链接见 Release 说明），之后就能自动更新了。</small>',
        ],
    },
    {
        ver: 'v1.5.10',
        en: 'New optional “encrypted export” checkbox — forced on (and locked) whenever a private item such as an API key, token, password or favorite is selected.',
        items: [
            '<b>导出旁边多了「加密导出」勾选框</b> —— 你自己决定：勾了这份文件就是加密的（导入时要输密码），不勾就是明文（和以前一样，别人拿到直接就能导入）。',
            '<b>但勾到隐私项时会强制加密</b> —— API Key、个人访问令牌、WebDAV 密码、备份密码、收藏内容，只要选中了其中任何一项带内容，加密就会<b>自动勾上并锁住</b>。锁住不是不让你选，是这件事没得选：这些数据一旦明文落到别人手上，损失不是"打不开"而是"被拿走"。勾选框会明确写着"强制加密"，不会偷偷替你决定。',
            '<b>导入加密文件现在会让你输密码</b> —— 以前是拿本机备份密码偷偷试一次，解不开就报一句"密码不对"，可界面上根本没有地方能输。现在选完文件如果发现是加密的，会弹一个框让你输密码；<b>输错了不会关框</b>，直接改一下再试就行，不用重新选文件。明文文件和"只有这台电脑能解"的那种备份照旧不问密码，点了就导。',
            '<b>令牌框下面能看到额度用到哪了</b> —— 常驻一行「本小时已请求 X 次 / 共 Y 次 · 还剩 Z 次」。没填令牌时是 60 次/小时并提示可以提额，填了就是 5000。这一行查的是 GitHub 的<b>额度接口，不消耗额度</b>，所以开着设置页、反复刷新都不会占到你的配额。查不到（断网）就整行藏起来，不会留一个几小时前的旧数字骗你。',
        ],
    },
    {
        ver: 'v1.5.9',
        en: 'The personal access token can be exported now, and any export that carries it is encrypted automatically.',
        items: [
            '<b>个人访问令牌现在也能导出了</b> —— 以前它不属于任何一个导出分组，勾选界面上根本看不见它，等于"备份里带着、导出时带不走"。现在单列成「个人访问令牌」一项，默认不勾，要带走自己打勾。',
            '<b>带令牌的导出会被自动加密</b> —— 令牌给别人就等于把账号访问权给出去了，所以那份文件不再明文落盘，改用你的<b>备份密码</b>加密；接收方要在「备份」页填上同一个密码才能导入。没设过备份密码时会直接提示你先设一个，<b>绝不会</b>偷偷写成明文。',
            '<b>备份页终于说清了"能不能换台电脑恢复"</b> —— 那里以前写着"留空 = 不加密"，这句话从加密改造之后就一直是错的：留空其实是<b>用 Windows 账户加密</b>，数据照样是密文，但<b>只有这台电脑、这个 Windows 用户</b>能解开。现在直接显示结论：<b>✓ 可跨设备恢复</b> 还是 <b>⚠ 仅本机可解</b>，顺带告诉你当前有几个凭据会跟着备份走。换电脑前看一眼就知道该不该补个密码。',
            '<b>同步/恢复不会再把你的令牌冲成空</b> —— 另一台电脑没填令牌时，它那份备份里令牌是空的；这边一按"云端较新"同步，你的令牌就被清掉了，之后所有 GitHub 请求变成匿名（每小时只有 60 次），你还以为是自己点错了。现在"备份里没有、本机有"就保留本机，并在提示里说明「本机的个人访问令牌已保留」。备份里真有令牌时照样会恢复进来，换机不用重填。',
            '<b>换机恢复失败时会告诉你怎么做</b> —— 以前只有一句"DPAPI 解密失败"。现在分得清：这份备份是用做它那台电脑的 Windows 账户加密的（当时没设备份密码），换机解不开 —— 并告诉你怎么预防；密码不对时也会区分"本机还没填密码"和"填了但不对"。',
        ],
    },
    {
        ver: 'v1.5.8',
        en: 'New “Verify” and “Save” buttons beside the token: a precise verdict (whose token, classic or fine-grained, quota, remaining) and an explicit receipt when saving.',
        items: [
            '<b>令牌多了「验证」和「保存」两颗钮</b> —— 你要的。以前填完令牌只能靠"点一次检查更新"来试探它到底能不能用，现在可以先把令牌发给 GitHub 问一句：<b>「验证」会说清这是谁的令牌、是经典还是细粒度、每小时额度多少、本小时还剩多少次</b>。结果直接显示在输入框下面那一行，不会一闪就没了。',
            '<b>「验证」不会动你的配置</b> —— 它只拿输入框里当前这串去问一次，<b>不落盘</b>。所以你可以先验一个抄来的令牌，确认能用再保存，不用担心把原来好好的那个覆盖掉。输入框一改动，上一次的"✓ 有效"会自动消失（它给的是那串旧值的结论，留着会误导）。',
            '<b>「保存」给的是明确回执</b> —— 点下去等写入完成才显示"✓ 令牌已保存到本机加密配置，接口额度 5000 次/小时"，存好了按钮就变灰（表示没有待保存的改动），一改又亮起来。在输入框里直接按 <b>Enter</b> 也是保存。原来"失焦自动保存"照旧留着，这颗钮是给"我要确认它真的存进去了"的人用的。',
            '⚠ 验证失败会说清楚是哪种失败：<b>令牌无效或过期</b>（GitHub 回 401 / Bad credentials，让你重新生成）、<b>令牌没被允许读账号信息</b>（403）、<b>接口限流</b>（会算还要等多久）、或者纯粹<b>网络不通</b> —— 不会一律甩一句"验证失败"。',
        ],
    },
    {
        ver: 'v1.5.7',
        en: 'New: GitHub personal access token, raising the API quota from 60 to 5000 requests per hour and telling you exactly why a verification failed.',
        items: [
            '<b>新增：GitHub 个人访问令牌（解决"检查更新老是失败"）</b> —— 更新页多了一个输入框，填上令牌后所有 GitHub 请求都会带上它，接口额度从 <b>60 次/小时</b> 提到 <b>5000 次/小时</b>。不用再靠"少调接口"绕限额：有令牌时一次请求就把版本号、说明、下载地址全拿回来。令牌只存在<b>本机加密配置</b>里，不会上传、也<b>不会写进日志</b>；填错或过期时会自动退回匿名请求，并明确告诉你原因，不会让更新功能整个坏掉。',
            '<b>没填令牌时：只提示有新版本，不自动下载</b> —— 按你说的加了一条判断：没有令牌时程序<b>不执行自动下载</b>，而是把 GitHub 下载链接<b>完整显示出来</b>，点一下（或点「用浏览器下载」）就在浏览器里下。填了令牌才是原来的「下载并安装」——程序内下好、校验、替换。这条对<b>两种检测方式都成立</b>：启动时自动查到的、手动点「检查更新」查到的，一律只给链接；后端还有一道硬拦，绕不过去。判断按<b>当前</b>配置现算 —— 你当场填上令牌，按钮立刻就变，不用再查一次。',
            '<b>令牌旁边加了问号</b> —— 鼠标悬停或键盘聚焦会浮出提示气泡，点一下在浏览器打开 <b>GitHub 官方中文帮助文档</b>（什么是个人访问令牌、怎么创建、要勾哪些权限）。图标用原生按钮实现：Tab 能聚焦、回车/空格能触发，读屏软件也能念出用途。',
            '⚠ 一个容易忽略的细节：令牌输入框支持粘贴时常见的三种垃圾（首尾空白、中间换行、外层引号），也兼容 <code>用户名:令牌</code> 这种从别处抄来的老格式 —— 不然你复制过来的值会带着一个看不见的换行，然后一直 401。',
        ],
    },
    {
        ver: 'v1.5.6',
        en: 'Ctrl+C now always shows the bar (even when nothing was copied), the empty bar never carries stale clipboard content, and the reaction time dropped from 500 ms to 120 ms.',
        items: [
            '<b>补一条逻辑：Ctrl+C 哪怕没复制到文本，也一定弹横条</b> —— 你指出的：「现在有两种唤出横条的方式，一种是选中文本，一种是用 Ctrl+C，所以按 Ctrl+C 的时候，哪怕没有复制到文本，那也得换出横条」。以前这条通道其实<b>挂在"剪贴板必须变"这个前提上</b>：在那些"不接受复制"的软件里按 Ctrl+C，你看到的和"没这个功能"一模一样。现在 Ctrl+C <b>无条件弹</b>：复制成功就带文字弹；复制到的是图片就弹「识别图片文字」；什么都没复制到就弹一条<b>空横条</b>（还能点识图 / OCR，至少知道软件在工作）。',
            '<b>空横条不会装上次剪贴板里的旧内容</b> —— 这点特意守住了。以前"按了 Ctrl+C 就读剪贴板"的老毛病，就是在终端按 Ctrl+C（等于中断信号）、对话框里复制空选区、手滑碰一下，都会弹出一条装着你<b>上一次复制的东西</b>的横条，那正是"横条莫名其妙冒出来"的真正来源。现在走"没复制到"这条路时一律是空的，旧内容一个字都不会带出来。',
            '<b>顺带快了</b>：以前按 Ctrl+C 要先等最多 <b>500ms</b> 确认"剪贴板到底变没变"才决定弹不弹。现在这 500ms 变成 <b>120ms</b>，而且只用来决定"带不带文字"—— 正常复制几毫秒就到位，你感觉不到等待；复制特别慢的（远程桌面、剪贴板管理器转一手）先弹空条、随后把文字补进同一根横条，不会跳。',
            '⚠ 设置里那个开关改名成「<b>划选没取到文字就不弹</b>」：它现在<b>只管划选这一条路</b>（拖窗口、拖滚动条、拖画布那些误触取不到词时不弹）。Ctrl+C 是你主动按的、不存在误触，不受它管 —— 哪怕关着也一样弹。',
        ],
    },
    {
        ver: 'v1.5.5',
        en: 'Fixed “pop-up position”: when the real caret can\'t be read, the drag start and end points are used instead, so above/below finally works in browsers too.',
        items: [
            '<b>修：「弹出位置」其实没生效（选上方也弹在下面）</b> —— 你报的：「我不管是调文字上方还是文字下方，最后它出现的都是在文字下方」。上一版只做了「怎么选上下侧」的判断，<b>没检查"文字在哪"这个前提拿不拿得到</b>：程序问系统要光标位置用的那套接口，<b>只有记事本、输入框这类原生控件才给</b>；浏览器、Electron 程序里的光标是网页自己画的，系统那层永远报"没有光标"。拿不到 → 只能退回<b>贴鼠标</b>，而鼠标停在选区的右下角 —— 于是看起来永远在文字下方，两个选项完全没差别。现在改成：真光标拿不到时，<b>用你这次划选的两个点（按下 → 抬起）当文字范围</b>，上下各留半个行高再去判断 —— 浏览器、Electron、任何能划选的地方都有效。日志里能直接看出走了哪条路（<code>src=caret</code> / <code>src=drag</code>）。',
            '<b>顺带验证过的边界</b>：贴着屏幕最上沿划词、又选了「文字上方」时，会自动翻到下方，不会被压出屏幕。',
            '⚠ 说清楚一个例外：<b>Ctrl+C</b> 触发的那条路仍然贴鼠标（那是它的设计：没有"划选范围"可依）。双击选词、Shift+方向键这些不产生拖动的选法也一样。',
        ],
    },
    {
        ver: 'v1.5.4',
        en: 'New: choose whether the bar appears above or below the selected text, with automatic flipping when there is no room.',
        items: [
            '<b>新增：横条可以选「弹在文字上方还是下方」</b> —— 你要的：「还要可以选择横条是在选中文字的上方还是下方」。设置页 <b>外观 → 横条外观 → 弹出位置</b> 里选，默认<b>文字上方</b>（和以前一样：不盖住你刚选中的字）。这只是<b>首选方向</b>：选的那一侧放不下时，照样会自动翻到另一侧，不会出现"选了下却飞到了屏幕外"。打开「横条跟随鼠标位置」时本项无效（那条路一律贴鼠标），控件会置灰。改动<b>下次弹横条就生效</b>，不用重启。',
            '<b>「点横条外面就收起」确认完好</b> —— 你这次也问了这条。其实 v1.3.0 起就有：横条弹着的时候，鼠标左键/右键点到横条外面任何地方（别的窗口、桌面、任务栏都算），横条立刻收起；唯一例外是<b>收藏夹面板被钉住</b>的时候（钉住就是"别被随便点掉"）。从本机运行日志里抽查过：弹条 → 点外面 → 收起，链路是通的。要是你遇到过"点了外面没收起来"，告诉我是哪种情况（比如点在横条半透明的阴影上？），我再复现。',
        ],
    },
    {
        ver: 'v1.5.3',
        en: 'Fixed garbled text when selecting in browsers (the selection is verified and corrected), and the huge blank area after maximizing the window.',
        items: [
            '<b>修：划词取到的字不对，拿去搜是一串垃圾</b> —— 你报的：「选中了 马尾辫skill安装，用横条里的谷歌搜索，就变成了《马尾辫 sk 泔安装、」。根因不在引擎，在<b>取词</b>：浏览器和 Electron 程序里我们<b>不用系统无障碍接口</b>（Chromium 那套唤不醒），只能<b>读屏幕上那块像素认字</b>；认中英混排的小字很不稳，于是「马尾辫skill安装」被认成「《马尾辫 sk 泔安装、」（开头多一个《、结尾多一个、、skill 被认断成 sk 泔），再原样喂给谷歌。现在这类程序里取到字之后会<b>再校一遍</b>：模拟一次 Ctrl+C 把选区原文读回来（剪贴板读完立刻还原），拿到精确文字再替换掉认错的那份 —— 所以你看到横条弹出来、半秒内文字被纠正，点了引擎搜的就是对的。别的自绘程序（微信这类）不乱塞按键，改成<b>只在"看起来就像认歪了"时</b>才校：首尾多出落单的标点（如只有《没有》）、中间夹着 sk 这种碎字母片段，两条同时才算。',
            '⚠ 代价说清楚：浏览器里现在每次划词都会多用一次剪贴板（复制选区 → 读 → 立刻还原，约 30~80ms，你看不出来，但 Win+V 剪贴板历史里可能多一条）。要是你觉得这个代价不值，说一声，我可以改成"只在可疑时才校"。',
            '<b>修：窗口最大化之后右边一大片空白</b> —— 你报的「窗口放到最大之后，右边基本全是空的」。实测（无头 Edge 量出来的）：1920 宽时卡片被拉到 <b>1716px</b>，而一行里「说明文字 506 + 开关 40」只占 546px，中间<b>空出 1136px</b>；2560 宽时空 1776px。根子是内容列<b>没有上限</b>，窗口越宽越散。现在：① 内容列最宽 1240/1480 并居中，任何窗口尺寸下都是一个正常宽度的设置页；② <b>窗口够宽（≥1300）时多卡片的分栏自动排成两列</b>，把宽度真正用起来 —— 通用、外观、引擎这些页立刻从"一列流水"变成两列；③ 只有一个卡片的分栏（帮助 / 关于 / 范围 / 抠图…）仍然整宽铺开，不会变成"半列内容 + 半列空白"；帮助页的长段落另按 ~62em 折行，不至于一行 100 多字。实测 1920 宽时那 1136px 的空白降到 <b>135px</b>，且任何宽度下都没有横向滚动条。',
        ],
    },
    {
        ver: 'v1.5.2',
        en: 'Double-clicking the tray icon now opens settings; a single click does nothing.',
        items: [
            '<b>双击托盘图标 = 打开设置</b> —— 你要的那条。同时把<b>单击</b>打开设置这条关掉了：托盘就紧挨着时钟，误点一下弹出一个设置窗太容易（这一版前半段修的就是"误触发"）。现在进设置只有两条<b>明确</b>的路：<b>双击图标</b>，或右键菜单里的「设置…」。<br>⚠ 顺带填了一个底层坑：Tauri 用的托盘库给消息窗注册的窗口类<b>没带 CS_DBLCLKS</b>，系统的"双击"消息根本不会发出来 —— 只写原生双击事件的话，表现就是"双击毫无反应"、日志里也什么都没有。所以现在是两条路一起走：原生双击事件来了就开，没来就按「两次点击落在系统双击时限内」自己判一次。双击速度在 Windows 鼠标设置里调过也跟着走，不用改程序。',
        ],
    },
    {
        ver: 'v1.5.1',
        en: 'Appearance page reordered to theme → preview → appearance options, so the preview stays in view while you tweak.',
        items: [
            '<b>「外观」页重排：主题 → 预览 → 外观参数</b> —— 你要求的：「在外观面板里面，把预览应该放在最上面，不应该放最下面，放在最下面就不能够有一种即时的观察了。界面主题这一栏应该也放在外观」。现在这一页从上到下就是这三块：<b>界面主题</b>（明暗皮肤，它一变预览整条跟着换皮）→ <b>横条预览</b> → <b>横条外观</b>（样式 / 玻璃 / 图标大小 / 内边距 / 不透明度 / 动画）。这样拖参数时，预览就在上面的视野里，改一下看一眼。',
        ],
    },
    {
        ver: 'v1.5.0',
        en: 'Fixed the bar appearing out of nowhere, added pointer-distance and idle auto-hide, and split settings into more tabs.',
        items: [
            '<b>修：横条会「莫名其妙地冒出来」（这版的主修）</b> —— 你报的：「有时候横条会莫名其妙的出来，明明我只设置两种出来的方式」。查下来是三处兜底在乱弹：① 以前<b>只要按了 Ctrl+C 就弹</b>，于是 Ctrl+C 在终端里是「中断」、在对话框里是「复制一个空选区」、手滑碰一下……都会弹出一条装着<b>上一次剪贴板内容</b>的横条。现在会先等剪贴板<b>真的变了</b>（最多等 0.5 秒，落地即弹）才弹；② 拖选那条路以前<b>取不到文字也弹</b>（r89"任何情况都要弹"的兜底），于是拖窗口、拖滚动条、拖画布、拖文件都会被当成划选，弹一条空横条。现在<b>没拿到文字就不弹</b>，这条可以在「通用 → 触发 → 没取到文字就不弹」里关掉；③ 取词慢的时候（要试三条通道，几百毫秒），你在这中间点了别处或按了 Esc，它读完<b>照样会弹出来</b>。现在这种情况直接作废。',
            '<b>新增：横条会自己收起来了</b> —— 你要的两条：<b>「鼠标移远就收起」</b>（指针离弹出位置超过 400px，说明这条你不要了，立刻收起）和<b>「无操作自动收起」</b>（弹出后 5 秒没有任何操作就消失）。两个数都能在「通用 → 触发」里用滑块调，<b>0 = 不收起</b>。指针正搁在横条上不动、或者「更多引擎」面板/右键菜单开着的时候<b>不算"没操作"</b>—— 你正指着要点的东西，不能给你收走。',
            '<b>设置页重新分栏</b> —— 你的原话：「关于横条的外观的相关设置，你要单独列一栏来设置，现在是放在通用里面，这不好。还有黑名单、白名单也是这样。Ai 抠图也是。」现在拆成：<b>外观</b>（横条样式 / 玻璃 / 图标大小 / 内边距 / 不透明度 / 动画 + 实时预览）、<b>范围</b>（黑名单 / 白名单）、<b>抠图</b>（AI 抠图与模型下载）。<b>通用</b>只剩触发（含上面两个新滑块）、界面主题、系统。',
        ],
    },
    {
        ver: 'v1.4.4',
        en: 'Second-level engine categories became pills, the category highlight bug was fixed, and the test suite went green for the first time.',
        items: [
            '<b>「更多引擎」的二级目录也改成胶囊了</b> —— 你要求的：「最好中类也作为胶囊式的，点击中类后，才会展开中类下面的小类」。以前二级（搜索引擎 / 直达网页 / 软件搜索 / 软件直达）是<b>一个胶囊 + 下拉菜单</b>：中类一共就两三个，全铺开也只有一行，却还要多点一次"展开"再选。现在三级一个口径 —— 大类、中类、小类<b>全是平铺胶囊</b>，点谁看谁，「全部中类」恢复全量；下一级只在上一级真的选了一个之后才出现。和设置页「引擎库」的目录长得、用起来也都一样了。',
            '<b>修：点了中类 / 小类，胶囊不高亮</b> —— 顺着这次改动查出来的一个老问题（三级从 r73 起就是胶囊，一直藏着）：面板滚动时那个"高亮当前分类"的逻辑会把<b>所有</b>目录按钮按分类名重画一遍，而二、三级胶囊是筛子、没有分类名，于是点完选中的那颗<b>立刻被熄灭</b>—— 界面看着像"根本没点上"。现在筛选行一律不归它管，点谁谁亮。',
            '<b>测试套件第一次全绿</b> —— 顺带修了一批从没跑起来过的用例：图标编辑器那两段因为配置里没开「AI 抠图」总开关，一行按钮都不渲染，先 FAIL 再抛异常，把后面<b>一整半测试</b>（横条、面板目录、备份、收藏夹…）全带停了；还有几条断言停在已经删掉的「容差滑块」和旧版提示文案上。现在 <b>484 / 484</b> 全过，面板三层目录也补了"选中要高亮"的回归断言。',
        ],
    },
    {
        ver: 'v1.4.3',
        en: 'Changing a setting no longer feels sticky (the encryption key is derived once per session), plus a full optimization review report.',
        items: [
            '<b>提速：改设置不再"发涩"</b> —— 每改一个开关，程序都要把配置重新加密存盘，而那个加密（Argon2id，为了抗暴力破解特意设计得很"重"）每次都要花 <b>120~150 毫秒</b>，还是在你点完开关的那一瞬间花掉的，连点几个就能感觉到卡。现在同一把密码只算一次，后续保存几乎瞬时。<b>加密强度一点没降</b>：参数、算法、每条独立的 nonce 全都保持原样，改动的只是"同一台机器上不必反复重算同一把钥匙"。顺带启动时也不再重复解密同一份配置。',
            '<b>顺带：这版附了一份全盘审视报告</b> —— 把代码结构、健壮性、性能、体积、界面这五个方面过了一遍，按优先级列了 20 条可优化项和一张路线图（`docs/OPTIMIZATION-REVIEW-2026-10-22.md`）。其中最大的一块是<b>图标体积</b>：现在 2.6MB 的图标里有三个文件就占了 500KB，全部压到显示需要的尺寸后，程序本体能小 1.6MB 左右 —— 这一项要逐个目视验收，放在下一版做。',
        ],
    },
    {
        ver: 'v1.4.2',
        en: 'Fixed searching inside “More engines” (four bugs at once), flattened the section pills, and added a panel opening animation.',
        items: [
            '<b>修：在「更多引擎」里搜引擎，有时候搜不出来（这一版的主修）</b> —— 你报的：「搜索哔哩哔哩，照理应该搜出它的首页和它的搜索引擎，结果只有首页」。查下来是四个坑叠在一起：① 敲<b>第一个字</b>时面板正好命中"内容没变就不重画"的缓存，于是那一下<b>既没筛选也没填充</b>；② 关面板时只复位了"大类"筛选，<b>中类/小类</b>那两个筛子还留在内存里，而它们的目录按钮是"选了大类才出现"的 —— 于是变成一个<b>既看不见、也点不掉</b>的筛子，搜索永远只在一半引擎里进行；③ 搜索时顶上「最近使用」那一栏没收起来；④ 像「哔哩哔哩」这种<b>横条固定位 + 引擎库</b>里都有的引擎，它的<b>别名</b>（B站 / 小破站 / bilibili）被横条那一份覆盖掉了，按别名一律搜不到。现在四件事都修了：进搜索就清掉三层筛子、第一下输入立刻生效、搜索时收起「最近使用」、别名改成全表合并。实测搜「哔哩哔哩 / B站 / 小破站 / bilibili」都能出齐三颗（哔哩哔哩、哔哩哔哩（首页）、哔哩哔哩漫画（首页））。',
            '<b>新增：小类目录不再藏在下拉菜单里</b> —— 你要求的：「选择完中类之后，小类最好是每一个就都呈现出来，一种胶囊的形式，这样我要哪个我点击就可以了，不用再一个个的找」。横条面板里的第三级（视频 / 音乐 / 购物…）从"一个胶囊 + 下拉菜单"改成<b>一整行平铺胶囊</b>，点谁就只剩谁；设置页「引擎库」的小类胶囊也统一成"<b>点一下 = 只看这一类，再点一次恢复全部</b>"。',
            '<b>新增：「更多引擎」弹出来的动画</b> —— 你要求的「优雅但速度快」。面板本体淡入（150ms），头/身/尾各自从上方 7px 落位（190ms 强缓出），尾部晚 10ms 起跑，看起来像一层层铺开。设置里关掉动画、或系统开了"减少动态效果"，都会老实不播。',
            '<b>修：两条快捷键引擎"固定在横条上、横条里却没有"（严重，数据被吃掉过）</b> —— 你报的：「我把两个快捷键引擎固定到了横条里面，但横条里实际没显示，设置里又看到它们被放在了横条上」。真因不是你记错，是<b>恢复云端备份把数据打坏了</b>：13:56 那次「云端备份较新，已恢复到本机」，云端那份备份里<b>没有"种类 / 按键序列 / 绑定应用"这几个字段</b>，一填默认值，你的两条快捷键引擎就变成"搜索类 + 没地址 + 没按键"的空壳 —— 于是横条画不出来、引擎库里也查不到。这一版：① 从你本机 12:18 的备份里把这两条<b>原样恢复</b>（微信截图 = Alt+A 绑微信、章鱼速贴快捷输入 = Alt+V 绑 Octoclip 管理员启动），横条顺序也按当时还原；② 恢复备份时<b>再也不会用一份缺字段的定义去覆盖本机好用的那条</b>；③ 万一以后又出现"定义不完整"的引擎，横条上会<b>照常画出来</b>（半透明 + 红色「!」），点一下告诉你去设置里补，不再凭空消失。',
        ],
    },
    {
        ver: 'v1.3.8',
        en: 'Selecting a URL now offers “Open link”, and selecting a file path adds 📄 to open it with the default program.',
        items: [
            '<b>修：选中网址却不弹「打开网址」按钮</b> —— 你报的：「我选中了一个网址但横条里并不能够弹出直达网址的按钮，但是如果我把这段网址复制下来了，因此而弹出的横条里面却能有直达网址的按钮」。根因是两条路拿到的<b>文字不一样</b>：复制走剪贴板是干净原文，而划词在浏览器里走 OCR 兜底，OCR 会把网址从中间断开（<code>https:// www.baidu.com</code>）、行尾多一个空格 —— 于是"整串是不是网址"判成 false，按钮不出现。现在判据对这类噪声放宽了（空白/零宽字符会被接回去），而且按钮点下去时会把这段文字一起发给后端重新判一次，不再依赖那个已经判失败的状态。',
            '<b>新增：选中文件路径 → 📄 用默认程序打开</b> —— 你要求的：「还要再增加一个直达文件的功能，就是说我选中了一个文件路径，那这个时候横条上就会弹出一个按钮，点击这个按钮就会自动调用系统默认的相应文件的软件来打开这个文件」。现在选中一个<b>文件</b>路径时横条上出现两颗按钮：📁 在文件管理器里定位（原有）、📄 用系统默认程序打开（.txt → 记事本、.mp4 → 播放器，和你在资源管理器里双击完全一致）。<b>目录只有 📁</b>（目录没有"默认程序"这个概念）。',
            '<b>顺带：📁 那颗按钮的行为没变</b> —— 你问"直接打开文件夹的相关功能是不是也是这样"—— 审了一遍，文件夹那条路走的是同一个判据（<code>paths::looks_like_path</code>），划词和复制两条路拿到的文字只要像路径就都弹，没有 URL 那种分叉。但它以前只能"在资源管理器里定位"，现在文件多了一个"直接打开"的选择。',
        ],
    },
    {
        ver: 'v1.3.7',
        en: 'Fixed the “refresh rate” row showing up under the default and frosted styles, and stabilized two flaky tests.',
        items: [
            '<b>修：默认 / 磨砂主题下不该出现的「刷新帧率」</b> —— 你指出的：「液态玻璃里面有一个实时折射，然后就可以设置刷新的帧率，那么在默认和磨砂的横条主题下就没有必要来设置刷新的帧率」。根因是这一行的显隐只看了「实时折射开没开」，没看当前是哪种样式：只要你<b>开过玻璃 + 开过实时折射，再切回默认或磨砂</b>，那一行就凭一个残留的开关值又冒了出来 —— 而这两个样式下玻璃画布根本不跑，四个按钮全是无效的。现在两个条件同时满足才显示（<b>液态玻璃样式</b> + <b>实时折射开着</b>）。',
            '<b>顺手：两条自动化测试的偶发失败</b> —— 跑 300 遍测试时会以约 1/100 的概率红一次，根因是测试之间互相踩（都通过同一个环境变量拿数据目录，谁先改谁影响别人）。这不是功能问题，但"时红时绿"会让人以后不敢信测试结果，所以这一版把它们的隔离做严了：现在<b>连续 300 遍全绿</b>。',
        ],
    },
    {
        ver: 'v1.3.6',
        en: 'Baidu image search is about 7× faster (IPv4 first), key presses and uploads run in parallel, and auto-paste behaves correctly with several AI engines ticked.',
        items: [
            '<b>修：百度识图慢的真正原因（快了 7 倍）</b> —— 你报的「用百度引擎搜图，要等好多秒才能打开新标签」，根因不在百度、也不在我们的流程，而在<b>这台机器的 IPv6 是"假的"</b>：系统解析出的地址里 IPv6 排在前面，但这台机器的 IPv6 实际连不通，于是每个网络请求都要先在 IPv6 上白等一次超时（实测 6 秒）才回退到 IPv4。同一个百度上传请求：走 IPv6 白等 <b>6613ms</b>，走 IPv4 <b>627~901ms</b>。现在所有网络请求都改成<b>优先走 IPv4</b>（只有对方真没有 IPv4 地址时才用 IPv6），识图搜索、云端备份同步、检查更新、AI 模型下载<b>一起受益</b>。',
            '<b>识图：按键和上传并行，不再排队</b> —— 以前是"先给 AI 页面按完 Ctrl+V / Enter，再去上传百度"，两件事明明是独立的却排成一队。现在按键线程一启动、上传同时在飞。顺序仍然是「<b>先按完键，再开识图的新标签页</b>」——新标签会抢前台，会把你那张图粘进搜索引擎的搜索框里。',
            '<b>修：同时开识图 + 看图时，看图那边的自动按键失效</b> —— 你的原话：「勾了一个识图一个看图，那这时候看图页面也要有相关的按键触发呀，而且要触发完按键之后再打开识图的新标签页」。现在：<b>只勾一家 AI</b>（哪怕同时勾了百度这类识图网址）→ 照常自动 Ctrl+V + Enter；<b>勾了多家 AI 看图</b> → 关掉自动按键（一次只能喂一个输入框，请自己挑一个粘）。',
            '<b>修：选中文字有时候不弹横条</b> —— 判"这是拖选还是点击"原来只看中间有没有收到鼠标移动事件，而鼠标钩子在快速划选 / 系统繁忙时<b>会丢移动事件</b>，一丢就被判成"点击"，横条不弹 —— 所以表现为"有时候灵有时候不灵"。现在改用<b>按下点与松开点的实际距离</b>判定，不依赖中间事件。（代价：手抖超过 4 像素的点击也会弹条，按 Esc 就收。）',
            '<b>修：备份恢复仍是"取最新"，但加了防呆</b> —— 恢复当然是恢复最新那份（这条逻辑没变）。新加的检测是：如果最新那份<b>用户痕迹全空</b>（没有自定义引擎、没有收藏、没有 OCR / WebDAV / 备份密码、没有 AI 模型选择…），那基本不是"你手动删空了"，而是<b>某次启动把默认配置写回去了</b>，这时才回退到<b>更早的、有内容的</b>那份，并在日志里写明原因。真的手动清空也不会被误判成损坏。',
            '<b>设置页：备份同步的说明文字缩短了</b> —— 那两行原来各有一大段解释，现在只剩一句。「启动时同步：<b>比较云端与本机，谁新用谁</b>」「退出时同步：退出前把本机配置推到云端（只上传，不动本机）」。',
            '<b>修：设置页「启动时同步」那一行的开关错位</b> —— 同一组里其它开关都是"文字在左、开关靠右"，只有它被套上了纵向排列的样式，开关被拉成一整条，看起来像坏了。现在和旁边一致。',
        ],
    },
    {
        ver: 'v1.3.5',
        en: 'Recovered from a settings-wipe incident: encrypted backups are recognized and opened automatically, the backup password gets its own copy, and restores pick the most complete backup.',
        items: [
            '<b>修：这次更新让全部设置丢了（严重）</b> —— 你的 OCR Key、WebDAV 账号密码、收藏夹、两个自定义快捷键引擎、AI 模型选择全被恢复成默认。原因不是"更新会覆盖配置"，而是<b>配置损坏后的自动恢复链断在半路</b>：你设了备份密码，备份是加密的，而程序<b>只会按明文去读</b>，于是所有备份"都读不出来"；退而用默认配置启动，随即又把那份好的加密备份删了。已完整恢复你的数据，并堵死了整条链。',
            '<b>加密备份现在能自动解开了</b> —— 之前程序把密文备份当成"能读但内容是空的"（因为配置结构体对未知字段宽容，密文信封被当成一份全默认配置）。现在先判断它是不是密文，是就只走解密。',
            '<b>备份密码另存一份</b>（backup.key）—— 密码原来只存在 config.json 里，主文件一坏、密码跟着没了，加密备份就永远解不开。现在多存一份，安全性不变（同一个私有目录），换来的是"配置坏了还能救回来"。',
            '<b>恢复时挑"最完整的那份"</b>，不再盲取最新 —— 最新那份可能恰好是"配置被清空之后"写下的默认配置，恢复它等于没恢复。现在按内容完整度打分（有自定义引擎/OCR/WebDAV/收藏的各加分）。',
            '<b>备份轮转不再"只留一份"</b> —— 以前每次保存都删掉其它所有备份，包括那份内容完好的。现在最多留 8 份，且<b>绝不删除比本次更有价值的备份</b>。',
            '<b>本地滚动备份也加密了</b> —— 你指出的：「备份的文件都是加密了，怎么能有没有加密的呢？」之前云端加密、手动导出加密，偏偏本地滚动备份是明文，而它装的是一模一样的敏感数据。',
            '<b>修：更多引擎页面闪烁</b> —— 每次配置广播都无条件清空重建几百个格子，翻列表时每隔几百毫秒闪一次。现在内容没变就不重建。',
            '<b>修：OCR 按 Esc 退不出</b> —— 焦点在结果文本框里时 Esc 被忽略（而它通常自动聚焦在那里）。现在文本框里按 Esc 也能关窗；只有框里有选中内容时，第一次 Esc 只取消选中。',
        ],
    },
    {
        ver: 'v1.3.4',
        en: 'Cleanup: removed dead code, a failed runtime load no longer kills a background thread, and configuration pruning is written to disk.',
        items: [
            '<b>全盘审视：清理了一批死代码</b> —— 横条前端有 8 个函数写了却从没被调用过（面板导航、收藏布局的旧实现），共约 120 行。删掉它们不影响任何功能，但让代码更好读、更不容易误导后来改它的人。',
            '<b>修：AI 抠图运行库加载失败会打崩一个后台线程</b> —— 当 onnxruntime.dll 缺失或损坏时，底层库会直接 panic。虽然程序没整个崩，但那个线程废了。现在把探测放到一次性线程里跑，失败就安静地当"不可用"，主流程完全无感。',
            '<b>修：配置的自动清理结果没落盘</b> —— 程序启动时会把横条里"没有定义的幽灵条目"剪掉，但以前只改内存、不改磁盘文件。于是你手动看 config.json 时那些条目还在，而且每次启动都要白跑一遍清理。',
        ],
    },
    {
        ver: 'v1.3.3',
        en: 'Hotkey engines no longer force a background app to the foreground; a new per-engine switch controls it.',
        items: [
            '<b>快捷键引擎：后台挂着的应用不再被强行换到前台</b> —— 你原来就提过这个：微信截图、章鱼速贴这类工具在后台挂着的时候，点横条上那颗图标，<b>没必要把它的主窗口整个弹出来</b>再发快捷键。现在默认就是<b>不动它的窗口</b>，直接把按键发给系统。',
            '<b>每个快捷键引擎多了一个开关</b>：绑定应用那一组里新增「<b>把应用窗口调到前台再发键</b>」。<ul style="margin:4px 0 0 18px;padding:0"><li><b>不勾（默认）</b>：应用已经在后台跑 → 不弹它的窗口，你手上的事不被打断；</li><li><b>勾上</b>：每次触发都先把它的主窗口摆到最前面再按键 —— 适合必须在那个窗口里才生效的程序。</li></ul>应用<b>本来没开</b>时，两种情况都会先把它打开（那时会露出来，这是应该的）。',
            '<b>说明</b>：老配置里没有这个字段，一律按"不勾"处理 —— 也就是升级后你会立刻得到想要的行为，不需要挨个去改。',
        ],
    },
    {
        ver: 'v1.3.2',
        en: 'Fixed hotkey engines that would not fire (the bar itself held the foreground) and removed a “post message” path that faked success.',
        items: [
            '<b>修：章鱼速贴这类快捷键点不动（真正的根因）</b> —— 上一版我以为是"按键注入方式"的问题，其实不是。真正的原因是：<b>你点横条上那颗图标的那一瞬间，横条自己占着前台</b>，注入的按键就打在了我们自己身上，目标程序的全局热键根本收不到。现在改成<b>先收起横条、把前台还给你刚才在用的窗口，再发按键</b>。',
            '<b>顺带去掉了一处"自作聪明"的实现</b>：上一版我试过用窗口消息把按键"直接投给目标窗口"（想做<u>不抢焦点</u>），它返回的成功是假的 —— 消息塞进队列就没人管了，程序那头毫无反应。现在只剩一条路：<b>老老实实注入按键</b>，交给系统去分发。',
        ],
    },
    {
        ver: 'v1.3.1',
        en: 'Orphaned entries on the bar are cleaned up, tray-only hotkey apps work again, and bound apps stay in the background.',
        items: [
            '<b>修：横条上明明有、引擎库里却找不到</b> —— 横条里如果留着一个"没有定义"的旧名字（删引擎时没清干净、或从旧备份恢复带进来的），引擎库就永远看不到它，搜索也搜不到，可横条上那一格还在。现在打开软件时会自动把这类孤儿条目清掉；另外新加的自定义引擎会<b>自动放进横条</b>。',
            '<b>修：章鱼速贴这类快捷键唤不出来</b> —— 它们常驻在托盘、没有可见窗口，靠"系统级全局热键"响应。上一版换了按键注入方式，恰好对这类热键无效。现在改回能触发全局热键的那种方式，并且<b>不会把它的窗口弹到前台</b>。',
            '<b>修：绑定应用的窗口会被强行换到前台</b> —— 你点横条上那颗快捷键时，如果那个应用正在后台运行，以前会把它整个弹到最前面，打断你手上的事。现在只要它有窗口就直接把按键"送进去"，前台一动不动；只有它本来没开、由我们拉起来时才让它露脸。',
            '<b>修：某些软件里选中文字不弹横条</b> —— 一是取不到文字时原来会直接放弃（自绘界面、小字、特殊控件上很常见），现在<b>拿不到文字也照样弹</b>，你还能用识图/OCR；二是<b>黑名单其实一直没生效</b>（判据取错了窗口），现在按你真正划词的那个软件判。',
            '<b>修：引擎库的大类点第二次收不起来</b> —— 现在再点同一个大类就会收回去。',
            '<b>关于一次云端同步事故</b>：我做测试时用的隔离实例把你坚果云上的备份覆盖成了测试数据，之后软件启动又从云端恢复，导致横条引擎一度消失。已从本地备份完整恢复，被污染的那 15 份云端备份也清理掉了；同时给程序加了硬保护 —— 任何"隔离实例"都不再碰云端，这类事不会再发生。',
        ],
    },
    {
        ver: 'v1.3.0',
        en: 'Adjustable live-refraction frame rate, binding an app automatically adopts its icon, and “restart now” no longer leaves the app closed.',
        items: [
            '<b>横条的"实时折射"可以调刷新率了</b>（新）：上一版把背景刷新限到了 15 帧/秒，<b>滚动网页或放视频时玻璃会慢半拍、看着像卡住</b>。现在改成可调 —— 「液态玻璃」那一组里多了一行「刷新帧率」，默认 <b>30</b>（滚动、放视频都已看不出滞后），嫌费电可以调低，想最跟手就选「跟随显示器」跟着屏幕刷新率跑。每一档后面都标了实测的 CPU 占用，方便你按机器情况挑。',
            '<b>快捷键引擎：选中应用就自动用它的图标</b>（新）：给快捷键引擎「绑定应用」时，选完那个程序，<b>软件会自动把它的图标抠出来当作这个引擎的图标</b>，横条上一眼就能认出来 —— 不用再自己去截图、裁剪、上传。开始菜单里的快捷方式同样管用。<b>如果你已经手动换过图标，它不会覆盖你的选择</b>；想换回应用图标，用「恢复默认图标」清掉后再选一次应用即可。',
            '<b>修：点「立即重启」可能把程序整个关掉</b> —— 自动更新装好后点重启，新程序启动的那一瞬间会撞上"旧程序还没退干净"，于是它以为自己重复启动、直接退出；旧的那个也退了，结果<b>桌面上一个都不剩</b>。现在新程序会等旧程序让位再接手。',
            '<b>玻璃渲染快了不少</b>：把两条各自跑满刷新率的绘制循环合并成一条（原来实测每秒 180 多次，其中一半是白跑的），抓屏用上了常驻资源、不再每帧重建，一块 600KB 的画面也从"拷三次"减到"拷一次"。',
            '<b>设置页回到你熟悉的样子</b>：上一版试做的两种新皮肤没有保留，界面<b>和你一直在用的那个版本完全一致</b>。',
        ],
    },
    {
        ver: 'v1.2.2',
        en: 'Fixed idle CPU usage caused by two draw loops running at full refresh rate.',
        items: [
            '<b>修：待机时 CPU 占用偏高</b> —— 上一版为了让玻璃更跟手，开了两条各自跟着屏幕刷新率跑的绘制循环，实测每秒被调用 180 多次（本该 60）。对一条静止的横条来说，多出来的那些帧全是白烧的。现在按需绘制，空闲时<b>基本不占 CPU</b>。',
        ],
    },
    {
        ver: 'v1.2.1',
        en: 'The icon hover outline now shares the bar\'s corner radius, both on the real bar and in the preview.',
        items: [
            '<b>修：图标悬停外框的圆角跟横条对不上</b> —— 鼠标压到图标上时那个外框，圆角一直和横条差着 4px（横条写死了"+4px"这个补偿），圆角调小的时候特别明显，看着很不协调。现在改成<b>同心</b>：横条圆角 = 图标圆角 + 内边距，两者弧线永远平行，滑块滑到哪一格都对得上。',
            '顺带修了同一处的"双胞胎"：设置页右上角的<b>横条预览</b>是另一份实现，原来也写着同样的 +4px。只修真身的话，你在预览里调好了、用到真身上又不对。现在两边用同一套算法。',
        ],
    },
    {
        ver: 'v1.2.0',
        en: 'Automatic updates, the repository link on the About page, and custom icons baked in as defaults.',
        items: [
            '<b>自动更新</b>（新）：「关于」页里多了一个勾选框 —— 勾着时每次打开软件都会自动检查新版本，<b>没新版就什么都不发生</b>；有新版会告诉你可以下载。<b>下载不跳浏览器</b>：在软件内部下好、自动校验、自动换掉旧程序，装完点「立即重启」就行。旁边还有一颗「检查更新」按钮，不受那个开关限制，随时可以手动查一次。',
            '<b>关于页加上项目地址</b>：GitHub 仓库地址直接标在「关于」里，点一下用系统默认浏览器打开。',
            '<b>自定义图标变成内置默认图标</b>：百度 / Google / 知乎 / 小红书 / 淘宝 / 天猫 / 京东 / 豆瓣 这一批换成了你自己画的那张图 —— 之前是"覆盖项"，现在烘进程序里当默认图标，横条、面板、设置页三处同时生效，换台电脑也照样在。',
            '<b>修：剪贴板还原会把你的内容清空</b> —— 取词和识图都借用剪贴板，还原时如果快照恰好是空的，就会把你原本复制的东西抹掉。这条被一个一直红着的测试精确命中，现在修好了。',
            '<b>修：识图搜完会把你中途复制的内容覆盖回去</b> —— 那 1~2 秒里你要是又复制了别的东西，以前会被旧的盖掉；现在会先核对、放过你新复制的内容。',
            '<b>修：「清理冗余数据」会把自定义图标删光</b> —— 判据漏了「文件名 = 引擎名」那套默认图标。',
            '<b>修：自定义备份目录里的备份找不回</b> —— 主配置损坏时会直接落回默认配置。',
            '<b>修：中文输入法在横条上按回车会直接开搜</b> —— 打拼音选词那一下被当成"确认搜索"了。',
            '<b>修：深色模式下几个纯黑品牌图标看不见</b>（反白规则被另一条同权重规则顶掉了）。',
            '<b>修：腾讯云 OCR 一直不可用</b>（签名里写的请求头和实际发出去的不一致）。',
            '<b>修：没配在线密钥时框完必然识别失败</b>（放行判断用了本地兜底，识别时却没用同一份名单）。',
            '<b>快了很多</b>：引擎过滤框敲第一个字不再卡一两秒（改成分批建格子）；配置广播不再重建 777 行列表；高刷鼠标不再把上千条移动事件塞满队列；AI 模型不再每次抠图都重新加载一遍（168MB 那个尤其明显）；拖拽不再每个像素都发一次 IPC；大屏抓屏不再白清一遍内存。',
            '<b>稳了不少</b>：框选遮罩的"最后一道保险"以前其实是空的（跨线程销毁窗口必然失败），现在会正确请求销毁；玻璃渲染加上显示上下文丢失/恢复，显卡驱动重置后不用重启程序了。',
            '<b>这次是把整个项目从头到尾审了一遍</b>，一共修了 93 处（含我自己上一批改动里引入的问题）。逐条清单见仓库里的审计报告。',
        ],
    },
    {
        ver: 'v1.1.1',
        en: 'Fixed downloads that looked like they ran several times, the stale version number on the About page, and added “clean leftovers”.',
        items: [
            '<b>修：点一次下载却像下了好几遍</b> —— 同时发起多个下载时，它们会抢同一个临时文件、互相把对方下到一半的文件删掉，结果每一轮都失败、界面看着像"重复下载"。现在同一时刻只允许一个下载，重复点会明确提示"已经有一个在进行中"。',
            '<b>修：关于页的版本号不跟着更新</b> —— 之前版本号有两处是手写的，发新版时容易漏改。现在只从一处（构建配置）读取，不可能再对不上。',
            '<b>新增「清理残留」</b> —— 自动清掉下载中断留下的临时文件、以及旧位置遗留的模型（换过模型存放位置的话）。程序每次启动也会自动清一次。',
        ],
    },
    {
        ver: 'v1.1.0',
        en: 'AI-powered icon cutout with four downloadable models, brush touch-ups, model switching, and a configurable model folder.',
        items: [
            '<b>图标抠图换成 AI</b>：用神经网络识别主体，主体和背景颜色接近的图也能抠。四个模型按需下载（<b>4.4MB 的轻量版实测反而最准</b>，另有三档 42/84/168MB 可选），不打开这个功能就一个都不下。',
            '<b>涂抹修饰</b>：抠完直接在结果图上涂 —— 「擦除」把多余的部分涂掉、「保留」把误删的部分补回来；可<b>放大 1~8 倍</b>再涂，涂错能撤销、能重来。',
            '<b>换模型重抠</b>：同一张图不满意，下拉换个模型立刻重抠（只列已下载的）。',
            '<b>设置页里直接抠图</b>：不用进图标编辑器，挑一张图就能抠，抠完自己选地方保存（存 PNG，透明不丢）。',
            '<b>模型存放位置可改</b>：设置里能看到模型在哪、能一键打开那个目录、也能换位置；<b>换位置时已有模型自动搬过去</b>。默认就放在程序目录下的「抠图模型」文件夹里，整个文件夹拷走就带着模型。',
            '<b>提示更准</b>：抠图相关的失败都给能照着做的中文提示（缺模型、缺运行库、模型还没下），不再有"点了没反应"。',
        ],
    },
    {
        ver: 'v1.0.0',
        en: 'First release: image search, file-path shortcuts, plain-text import/export, multi-engine OCR, 777 engines, three bar styles, the icon editor, favorites and backups.',
        items: [
            '<b>识图搜索</b>：横条上多一颗 🖼，框一块屏幕就能以图搜图。十二家引擎可选（Yandex / 百度 / SauceNAO / trace.moe 是框选完直接把图交给它、浏览器落在结果上；六家 AI 是打开页面自动粘贴；另有两家按图片地址搜），默认带上 Yandex 和 SauceNAO；勾多家则一次框选后每家的结果各开一个新标签页。动漫截图可以用 trace.moe —— 番名（含中文）、第几集、几分几秒、相似度直接列在本地结果页上。',
            '<b>文件路径快捷打开</b>：选中一段本地路径（<code>C:\\...</code>、<code>\\\\server\\share</code>、带斜杠的、含 %VAR% 的都认），横条上自动多一颗 📁，点一下就在资源管理器里定位到它。',
            '<b>明文导入 / 导出</b>：「数据」页里挑着导出自己想要的几项，导出的是纯文本 JSON，可以直接发给别人导入；导入是<b>合并式</b>的，不会动你别的设置。和加密的「备份」是两条独立的路。',
            '<b>OCR 同时识别多家</b>：默认引擎下面勾几家，一次识别它们就同时跑同一张图，结果各占一段；结果窗默认停在默认引擎那一档，不会自作主张跳走。',
            '<b>引擎库扩充到 777 个</b>，三大类（网页 705 / 软件 46 / 快捷键 26）分组 + 「更多引擎」面板三层下钻 + 面板内直接搜。',
            '<b>横条样式三选一</b>：纯色 / 磨砂 / 液态玻璃。液态玻璃用 WebGL2 做真折射和色差，背后在放视频时还能开「实时折射」跟着动。',
            '<b>图标编辑器</b>：换图标可以自己抠背景、调尺寸，不用先去找个图片处理软件。',
            '<b>收藏夹大改</b>：两级目录、拖拽排序、长按拖动内容、面板可钉住可拖动、自定义图标目录。',
            '<b>备份体系</b>：本地 + WebDAV 云端双份、AES-256-GCM 加密、启动/退出自动同步、云端挑一份恢复、冗余数据清理。',
        ],
    },
];

/* 更新日志：**语言切换时要整块重画**。
 *
 * 英文版每个版本只有一句摘要 —— 中文那份是一手开发记录（每条都在解释
 * "你报的现象 → 根因 → 怎么修"，动辄几百字），逐句译成英文既冗长又容易
 * 走样；用户要看的是"这一版改了什么"，一句话就够。
 *
 * 用 `dataset.painted` 记住当前画的是哪种语言，避免每次配置广播都重画。 */
function paintChangelog() {
    const cl = $('changelog');
    if (!cl) return;
    const lang = (window.QS_I18N && window.QS_I18N.lang === 'en') ? 'en' : 'zh';
    if (cl.dataset.painted === lang) return;
    cl.textContent = '';
    for (const rel of CHANGELOG) {
        const g = document.createElement('div');
        g.className = 'cl-ver';
        g.textContent = rel.ver;
        const ul = document.createElement('ul');
        ul.className = 'cl-list';
        const items = (lang === 'en' && rel.en) ? [rel.en] : rel.items;
        for (const it of items) {
            const li = document.createElement('li');
            // 条目里允许两种行内标记：`<b>粗</b>` 写 HTML、`` `代码` `` 转 <code>。
            // 都是这份常量自己写的，不是外部输入。先转 <b>（inline markup）
            // 再把反引号换成 <code> —— 顺序不能反，否则 <b> 里的反引号会被误判。
            li.innerHTML = it
                .replace(/`([^`]+)`/g, '<code>$1</code>');
            ul.appendChild(li);
        }
        cl.appendChild(g);
        cl.appendChild(ul);
    }
    cl.dataset.painted = lang;
}

/* 语言一换就重画一次（i18n.js 在 setLang 之后派发这个事件）。 */
window.addEventListener('qs:lang', () => { paintChangelog(); });

function fillAbout() {
    qsSetText('aboutDev', CONF.developer || 'QQQOrange');
    qsSetText('aboutVer', 'v' + (CONF.version || '—'));
    qsSetText('aboutBuilt', CONF.builtAt || '未知');

    const wv = $('aboutWebview');
    if (wv) {
        const s = webviewLabel();
        wv.textContent = s;
        // 行和值一起藏，否则会留下一条「界面渲染」+ 空白
        const row = wv.closest('.am-row');
        if (row) row.hidden = !s;
    }

    const box = $('aboutTools');
    if (box && !box.dataset.done) {
        for (const t of ABOUT_TOOLS) {
            const s = document.createElement('span');
            s.textContent = t;
            box.appendChild(s);
        }
        box.dataset.done = '1';
    }

    paintChangelog();

    // 顶栏那行小字也补上悬浮说明（报 bug 时不用再翻到「关于」页去抄版本）
    const ver = $('ver');
    if (ver) {
        ver.title = '开发者 ' + (CONF.developer || 'QQQOrange')
            + ' · 构建于 ' + (CONF.builtAt || '未知');
    }

    /* v1.2.0：更新那块也顺手初始化一次。
     *
     * 为什么放在这里（而不是只在 boot 里做一次）：`fillAbout` 在**每次配置
     * 广播**都会跑，而广播会重设开关的 checked 状态 —— 按钮的绑定与"问一句
     * 有没有待装版本"必须跟着走，否则改个别的设置回来，那颗「检查更新」
     * 就成了没接线的装饰。函数内部全是幂等操作，重复调没有副作用。 */
    try { updInit(); } catch (e) { console.warn('[qs] updInit 失败', e); }
}


/* ------------------------------------------------------------------ */
/* v1.2.0：更新                                                         */
/*                                                                     */
/* 用户要求：                                                          */
/*   ① 关于里要有「自动更新」这个**勾选项**，勾了才会自动检查；        */
/*   ② 还有一个「检查更新」按钮，点了就去问有没有新版；                */
/*   ③ 发现新版要提示"是否下载"；                                      */
/*   ④ 下载**不跳浏览器**，在程序里下好 → 自动删掉原来的 → 换新的；     */
/*   ⑤ 关于里要有 GitHub 地址，点一下用浏览器打开。                     */
/*                                                                     */
/* 后端分工（见 src/update.rs 与 main.rs 的 update_* 命令）：          */
/*   update_check     → 查（结果走 qs://update 事件回来）               */
/*   update_pending   → 打开关于页时问一句"有没有待装的"                */
/*   update_install   → 下载 + 校验 + 替换（进度走 qs://update-progress）*/
/*   update_restart   → 起新进程再退出自己                                */
/* ------------------------------------------------------------------ */

/** 最近一次「有新版」的详情（`qs://update` / `update_pending` 都往里写）。
 *  结构：{ version, notes, size, page, url, canAuto }。
 *  `canAuto` = **现在**能不能在程序内自动下载（后端按当前配置现算），
 *  它决定主按钮是「下载并安装」还是「用浏览器下载」。
 *  `authed` 只是"那次检查实际用没用上令牌"，仅用于解释提示，不参与这个判断。 */
let UPD_INFO = null;

/** GitHub 个人访问令牌的官方中文帮助文档（那个问号图标点开的地址）。
 *
 *  集中放在这里：以后再改链接只动这一行，不用在 DOM / 事件里翻。
 *  ⚠ 用 `open_links` 交给系统浏览器打开，不在 WebView 里跳 —— 设置页是本地
 *    页面，跳走就回不来了。 */
const GITHUB_PAT_DOC_URL = 'https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';

/** 把字节数变成人话（和 Rust 的 aimodels::human_size 同口径）。 */
function updSizeText(n) {
    if (!n || n < 0) return '';
    const mb = 1024 * 1024;
    return n >= mb ? (n / mb).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

/** 进度条：`total` 为 0 时只显示"已下载多少"（远端没给体积的情况）。 */
function updPaintProgress(done, total) {
    const box = $('updProgress');
    const bar = $('updBar');
    const pct = $('updPct');
    if (!box || !bar || !pct) return;
    box.hidden = false;
    if (total > 0) {
        const p = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
        bar.style.width = p + '%';
        pct.textContent = p + '%  ·  ' + updSizeText(done) + ' / ' + updSizeText(total);
    } else {
        bar.style.width = '100%';
        bar.style.opacity = '.35';   // 不知道总量：显示一条"在动"的条，不假装百分比
        pct.textContent = '已下载 ' + updSizeText(done);
    }
}

/** 有新版 → 把详情块摆出来。 */
/** 把「这次能不能在程序内自动下载」画到界面上。
 *
 *  口径（用户 2026-10-24）：**没填 GitHub 令牌时只提示有新版本、不自动下载**，
 *  并给出 GitHub 下载链接让用户点去浏览器。所以：
 *    · 有令牌 → 主按钮「下载并安装」；
 *    · 没令牌 → 主按钮「用浏览器下载」，并把完整网址显示在下面。
 *
 *  判断只看 `canAuto`（后端按**当前**配置现算），不看 `authed`
 *  —— 后者是"检查那一刻用没用上令牌"，而启动时的检查比用户填令牌更早，
 *  拿它当依据会让"刚填好令牌"和"刚清空令牌"两种情形都显示错。 */
function updPaintAuthMode() {
    const info = UPD_INFO || {};
    const canAuto = !!info.canAuto;
    const url = info.url || '';
    const ins = $('btnUpdateInstall');
    if (ins) {
        ins.textContent = canAuto ? '下载并安装' : '用浏览器下载';
        ins.hidden = false;
        ins.disabled = false;
    }
    const row = $('updLinkRow');
    const link = $('updDownloadLink');
    if (link) {
        if (url) {
            // 同时显示完整网址：用户能看清、能复制，也能点开
            link.textContent = url;
            link.setAttribute('href', url);
        } else {
            link.textContent = '';
            link.removeAttribute('href');
        }
    }
    if (row) row.hidden = !url;
}

/** 输入框里这一串算不算"填了令牌"（后端 `effective_token` 的轻量镜像）。
 *
 *  只用来**预先**改按钮文字，不做校验：真正说了算的是后端（它还会截长、
 *  落盘前再清洗一遍，并用 `can_auto_download()` 现算）。这里宁可判宽一点 ——
 *  判宽了最多是"显示能下、点下去被后端拦一句"，判窄了会让人以为填了没用。 */
function updTokenFilled(v) {
    let s = String(v == null ? '' : v).trim();
    // 外层成对引号（从网页 / 文档里复制常带）
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
        s = s.slice(1, -1);
    }
    // 兼容从别处抄来的 `用户名:令牌` 老格式
    const colon = s.indexOf(':');
    if (colon >= 0) s = s.slice(colon + 1);
    // 去掉粘贴时混进来的空白 / 换行 / 控制字符，剩下的才算数
    return s.replace(/[\s\u0000-\u001f\u007f]/g, '').length > 0;
}

/** 令牌输入框变了 → 若正摆着"发现新版本"，按钮跟着变。
 *
 *  不联网、不问后端：只是把同一个口径（有没有令牌）重画一次。 */
function updSyncCanAuto(tokenValue) {
    if (!UPD_INFO) return;
    const canAuto = updTokenFilled(tokenValue);
    if (!!UPD_INFO.canAuto === canAuto) return;
    UPD_INFO.canAuto = canAuto;
    updPaintAuthMode();
    const hint = $('updHint');
    if (hint && UPD_INFO.version) {
        hint.textContent = canAuto
            ? '发现新版本 v' + UPD_INFO.version + '，可以下载'
            : '发现新版本 v' + UPD_INFO.version
                + ' —— 没填 GitHub 令牌，请点下面的链接去浏览器下载';
    }
}

/** 发现新版时的详情块。 */
function updShowFound(v) {
    const box = $('updFound');
    if (!box) return;
    box.hidden = false;
    qsSetText('updVer', 'v' + v);
    const info = UPD_INFO;
    const sizeEl = $('updSize');
    if (sizeEl) sizeEl.textContent = info && info.size ? '（' + updSizeText(info.size) + '）' : '';
    const notes = $('updNotes');
    if (notes) {
        /* ⚠ 版本说明用 textContent，不用 innerHTML —— Release body 是**服务端
         *   下发的内容**（理论上可被改），拼进 HTML 就是白送一个注入点。
         *   这里也不需要富文本：`.upd-notes` 已经设了 white-space:pre-wrap，
         *   Markdown 的换行照样看得清。 */
        notes.textContent = (UPD_INFO && UPD_INFO.notes) || '（这个版本没有写说明）';
    }
    // 主按钮的形态（自动下载 / 只用浏览器）与下载链接都在这儿定
    updPaintAuthMode();
}

/* v1.5.8：令牌的「验证 / 保存」两颗钮。
 *
 * `TOK_SAVED` = 最后一次**确认落盘**的那一版；`null` = 还没显式存过，
 * 这时候按 `CONF.githubToken` 算（见 `tokSaved`）。
 * 不直接只认 `CONF.githubToken`：TEXTS 里的 change 处理器只发 IPC，
 * **不会回写 CONF** —— 只认它的话，保存完按钮会一直亮着。 
 *
 * ⚠ change 处理器会更新 TOK_SAVED，但**不刷新**保存按钮的可用状态：
 *   点按钮时 change 先于 click 触发，若在那儿把按钮 disable 掉，
 *   浏览器就不会再派发 click（按钮直接"点不动"）。 */
let TOK_SAVED = null;

/** 令牌区的状态行（验证结果 / 保存回执）。`kind` = ok | warn | err | busy */
function tokSay(msg, kind) {
    const el = $('githubTokenStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'upd-token-status' + (kind ? ' ' + kind : '');
}

/* ==========================================================================
 *  v1.5.10：额度用量（"已经请求了多少次 / 总共多少次"）
 *
 *  用户 2026-10-25 的要求，常驻在令牌输入框下面。
 *
 *  数据来自 `github_rate_state`，它打的是 `/rate_limit` —— GitHub 明文规定
 *  查这个端点**不计入**额度。所以开着设置页、反复刷新都不会烧配额；
 *  换成 `/user` 去数的话，用户每开一次设置页就少一次更新检查的机会。
 *
 *  两条纪律：
 *    · 查不到（离线 / 被墙 / 没网）就把整行**藏起来** —— 宁可没有，
 *      也不要留一个可能是几小时前的数字在那儿冒充"现状"；
 *    · 数字一律先过 `Number()` 再拼进 HTML，不让任何外来字符串碰 DOM。
 * ========================================================================== */
async function refreshGithubRate() {
    const el = $('githubRateLine');
    if (!el) return;
    let st = null;
    try {
        st = await invoke('github_rate_state');
    } catch (_) {
        el.hidden = true;
        return;
    }
    if (!st || typeof st !== 'object' || !st.ok) {
        el.hidden = true;
        return;
    }
    const used = Number(st.used) || 0;
    const total = Number(st.limit) || 0;
    const left = Number(st.remaining) || 0;
    const authed = !!st.authed;
    el.className = 'upd-rate' + (authed ? '' : ' anon');
    el.hidden = false;
    el.innerHTML =
        '<i class="rdot"></i>本小时已请求 <b>' + used + '</b> 次 / 共 <b>' + total + '</b> 次'
        + ' · 还剩 ' + left + ' 次'
        + (authed ? '' : '（匿名额度，填令牌可提到 5000 次/小时）');
}

/** 令牌输入框里"已经存好的那一版"。
 *
 *  优先用 `TOK_SAVED`（显式保存 / change 自动落盘时记的），`null` 时退回
 *  `CONF.githubToken` —— 页面刚打开时就是这个状态，不需要挑时机去初始化
 *  （挑时机反而会踩"updInit 比配置先跑"的坑，按钮就一直亮着）。 */
function tokSaved() {
    if (TOK_SAVED !== null) return String(TOK_SAVED);
    return String((CONF && CONF.githubToken) || '');
}

/** 输入框里这版是不是还没（确认）保存过。 */
function tokDirty() {
    const el = $('s-githubToken');
    return !!el && el.value !== tokSaved();
}

/** 「保存」只在有改动时可按：按不动 = 当前输入已经存好了。 */
function tokRefreshSave() {
    const btn = $('btnGithubTokenSave');
    if (!btn) return;
    const dirty = tokDirty();
    btn.disabled = !dirty;
    btn.title = dirty
        ? '把令牌保存到本机加密配置（在输入框里按 Enter 也是保存）'
        : '当前输入已经保存过了';
}

/** 打开「关于」页时问后端一句"有没有待装的"，并把仓库按钮接上。 */
function updInit() {
    /* v1.5.10：额度用量。不 await —— 它要联网，不能让整页初始化等它。
     * 查不到会自己把那一行藏起来，不会留个空壳。 */
    refreshGithubRate();
    const repo = $('aboutRepo');
    if (repo && !repo.dataset.bound) {
        repo.dataset.bound = '1';
        /* 「标明 github 的地址，并且点击后能够直接通过浏览器打开」——
         * 走后端命令（ShellExecuteW），不是在 webview 里跳转。 */
        repo.addEventListener('click', () => {
            invoke('open_repo_page').catch(() => {});
        });
    }
    /* v1.5.7 / v1.5.8：令牌相关的入口。输入框本身仍在 TEXTS 里（change 时
     * 自动 set_setting），这里只做加法：帮助、验证、保存、清除。 */
    const help = $('btnGithubTokenHelp');
    if (help && !help.dataset.bound) {
        help.dataset.bound = '1';
        /* 原生 <button>：Tab 能聚焦，Enter / Space 会自动派发 click ——
         * 键盘用户不需要额外处理。这里只负责"打开官方文档"。 */
        help.addEventListener('click', () => {
            invoke('open_links', { links: [GITHUB_PAT_DOC_URL] })
                .catch((e) => toast('打不开帮助文档：' + e));
        });
    }
    /* 「验证」：把**输入框里当前这串**（可能还没保存）发给 GitHub 问一句。
     *
     * 为什么不先落盘再验证：验证是"我想确认这东西能用"，落盘是"我要用它"。
     * 混在一起的话，用户验一个抄来的坏令牌就把好令牌覆盖掉了。 */
    const ver = $('btnGithubTokenVerify');
    if (ver && !ver.dataset.bound) {
        ver.dataset.bound = '1';
        ver.addEventListener('click', () => {
            const el = $('s-githubToken');
            const saveBtn = $('btnGithubTokenSave');
            const raw = el ? el.value : '';
            if (!raw.trim()) {
                tokSay('先填一个令牌再验证。留空就是匿名请求（每小时 60 次），不需要验证。', 'warn');
                return;
            }
            ver.disabled = true;
            if (saveBtn) saveBtn.disabled = true;
            tokSay('正在向 GitHub 验证…', 'busy');
            /* 结果直接回在状态行里（不走 toast）：账号名、额度这些信息需要
             * 停留一会儿让人对照，toast 一闪就没了。 */
            invoke('verify_github_token', { token: raw })
                .then((r) => {
                    const info = r || {};
                    const who = info.name
                        ? info.name + '（' + info.login + '）'
                        : (info.login || '未知账号');
                    const quota = info.limit
                        ? '额度 ' + info.limit + ' 次/小时'
                            + (typeof info.remaining === 'number' ? '，本小时还剩 ' + info.remaining + ' 次' : '')
                        : '';
                    const parts = ['✓ 令牌有效：' + who];
                    if (info.kind) parts.push(info.kind);
                    if (quota) parts.push(quota);
                    let msg = parts.join(' · ');
                    if (tokDirty()) msg += ' —— 还没保存，点「保存」写入';
                    tokSay(msg, 'ok');
                })
                .catch((e) => {
                    tokSay('✗ ' + String(e), 'err');
                })
                .then(() => {
                    ver.disabled = false;
                    tokRefreshSave();
                });
        });
    }
    /* 「保存」：显式落盘 + 给回执。
     *
     * 输入框失焦时 TEXTS 已经会自动存一次，这颗钮是给"我要确认它真的进去了"
     * 的人用的：它等 IPC 回来才说"已保存"，不会让人对着一个"看起来存了"
     * 的界面猜。 */
    const saveBtn = $('btnGithubTokenSave');
    if (saveBtn && !saveBtn.dataset.bound) {
        saveBtn.dataset.bound = '1';
        saveBtn.addEventListener('click', () => {
            const el = $('s-githubToken');
            const v = el ? el.value : '';
            saveBtn.disabled = true;
            tokSay('正在保存…', 'busy');
            invoke('set_setting', { key: 'githubToken', value: v })
                .then(() => {
                    TOK_SAVED = v;
                    if (CONF) CONF.githubToken = v;
                    // 存完立刻按同一口径重画「下载并安装 / 用浏览器下载」
                    updSyncCanAuto(v);
                    tokSay(v.trim()
                        ? '✓ 令牌已保存到本机加密配置，接口额度 5000 次/小时'
                        : '✓ 已保存为匿名请求（每小时 60 次）', 'ok');
                })
                .catch((e) => tokSay('保存失败：' + e, 'err'))
                .then(() => {
                    tokRefreshSave();
                    // 额度从 60 变 5000（或反过来）—— 那一行必须跟着改
                    refreshGithubRate();
                });
        });
    }
    const clr = $('btnGithubTokenClear');
    if (clr && !clr.dataset.bound) {
        clr.dataset.bound = '1';
        clr.addEventListener('click', () => {
            const el = $('s-githubToken');
            if (el) el.value = '';
            if (CONF) CONF.githubToken = '';
            TOK_SAVED = '';
            updSyncCanAuto('');
            invoke('set_setting', { key: 'githubToken', value: '' })
                .then(() => {
                    tokSay('已清空令牌，改回匿名请求（每小时 60 次）', 'warn');
                    toast('已清空令牌，改回匿名请求（每小时 60 次）');
                })
                .catch((e) => tokSay('清空失败：' + e, 'err'))
                .then(() => {
                    tokRefreshSave();
                    refreshGithubRate();
                });
        });
    }
    /* 输入框一改，按钮立刻跟着变 + 该亮的「保存」亮起来。
     *
     * 为什么重画按钮：如果这会儿已经摆着"发现新版本"，而用户就地填上令牌，
     * 按钮还写着「用浏览器下载」就说不通了（他明明已经填了）。这里不联网、
     * 不问后端 —— 只是按同一个口径（有没有令牌）重画一次，省掉"再点一次
     * 检查更新"的动作。真正拦下载的仍是后端。
     *
     * ⚠ 输入一变就把上一轮验证的结论清掉：那是**旧**输入的结论，
     *   留着会让人拿"✓ 有效"去给一串改过的令牌背书。 */
    const tokEl0 = $('s-githubToken');
    if (tokEl0 && !tokEl0.dataset.canauto) {
        tokEl0.dataset.canauto = '1';
        tokEl0.addEventListener('input', () => {
            updSyncCanAuto(tokEl0.value);
            tokSay('');
            tokRefreshSave();
        });
        tokEl0.addEventListener('change', () => {
            /* change 时 TEXTS 已经在落盘了，这里只记账。
             * 不调 tokRefreshSave()：那会把按钮 disable 掉，而紧接着的 click
             * 就不会再派发（点「保存」会变成点了个寂寞）。 */
            TOK_SAVED = tokEl0.value;
            updSyncCanAuto(tokEl0.value);
        });
        /* 在输入框里按 Enter = 点「保存」。密码框回车最常见的期待就是这个。 */
        tokEl0.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const b = $('btnGithubTokenSave');
            if (b && !b.disabled) b.click();
        });
    }
    tokRefreshSave();
    const check = $('btnUpdateCheck');
    if (check && !check.dataset.bound) {
        check.dataset.bound = '1';
        check.addEventListener('click', () => {
            const hint = $('updHint');
            if (hint) hint.textContent = '正在检查…';
            check.disabled = true;
            // ⚠ 结果走事件回来（qs://update）。无论有没有新版都会回一条
            //   （manual=true），所以这里**不需要**超时兜底 —— 后端查失败
            //   时也会发 qs://toast 说明原因。但按钮不能一直按不动，
            //   给一个 20 秒的保险（比后端的 15 秒超时稍长）。
            setTimeout(() => { check.disabled = false; }, 20000);
            /* ⚠ 先把输入框里的令牌落盘再查：change 事件虽然会在点击时先触发，
             *   但两条 IPC 不保证按顺序执行 —— 用户"粘贴完直接点检查更新"很可能
             *   用的是落盘前的旧令牌，看起来就是"填了没生效"。 */
            const tokEl = $('s-githubToken');
            const saved = tokEl
                ? invoke('set_setting', { key: 'githubToken', value: tokEl.value }).catch(() => {})
                : Promise.resolve();
            saved.then(() => invoke('update_check')).catch((e) => {
                if (hint) hint.textContent = '检查失败：' + e;
            });
        });
    }
    const ins = $('btnUpdateInstall');
    if (ins && !ins.dataset.bound) {
        ins.dataset.bound = '1';
        ins.addEventListener('click', () => {
            const info = UPD_INFO || {};
            /* 没令牌 → 按口径不自动下载，直接把这个包交给浏览器。
             * 后端 `update_install` 还有同样一道拦截（双保险）。 */
            if (!info.canAuto) {
                if (!info.url) {
                    toast('没有拿到下载地址，先点「检查更新」');
                    return;
                }
                const hint0 = $('updHint');
                if (hint0) hint0.textContent = '已在浏览器中打开下载链接';
                invoke('open_links', { links: [info.url] })
                    .catch((e) => toast('打不开下载链接：' + e));
                return;
            }
            ins.disabled = true;
            const hint = $('updHint');
            if (hint) hint.textContent = '正在下载…';
            updPaintProgress(0, UPD_INFO ? UPD_INFO.size : 0);
            invoke('update_install').catch((e) => {
                toast('下载失败：' + e);
                ins.disabled = false;
            });
        });
    }
    /* 下载链接那一行：也走系统浏览器。用 <a> 是为了让"复制链接地址"
     * 这类浏览器原生操作照常可用，所以 href 填真地址、点击时再拦住。 */
    const dl = $('updDownloadLink');
    if (dl && !dl.dataset.bound) {
        dl.dataset.bound = '1';
        const openDl = (e) => {
            if (e) e.preventDefault();
            const url = (UPD_INFO && UPD_INFO.url) || dl.getAttribute('href') || '';
            if (!url || url === '#') return;
            invoke('open_links', { links: [url] }).catch((err) => toast('打不开下载链接：' + err));
        };
        dl.addEventListener('click', openDl);
        // <a> 回车本来就会派发 click；补一个空格，和原生按钮手感一致
        dl.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Spacebar') openDl(e);
        });
    }
    const rst = $('btnUpdateRestart');
    if (rst && !rst.dataset.bound) {
        rst.dataset.bound = '1';
        rst.addEventListener('click', () => {
            // 起新进程 + 退自己，都在后端一次做完（见 update_restart）
            invoke('update_restart').catch(() => {});
        });
    }
    const pg = $('btnUpdatePage');
    if (pg && !pg.dataset.bound) {
        pg.dataset.bound = '1';
        pg.addEventListener('click', () => {
            const url = (UPD_INFO && UPD_INFO.page) || '';
            if (!url) return;
            /* 复用现成的 `open_links`（它内部丢后台线程 ShellExecuteW，
             * 而且会先过一遍 URL 合法性）。不为"打开一个链接"新开一条命令。 */
            invoke('open_links', { links: [url] }).catch(() => {});
        });
    }
    // 问一句有没有待装的（启动时那次检查的结果可能已经在那儿了）
    invoke('update_pending').then((r) => {
        if (r && r.has) {
            UPD_INFO = {
                version: r.version, notes: r.notes, size: r.size, page: r.page,
                url: r.url, authed: !!r.authed, canAuto: !!r.canAuto,
            };
            updShowFound(r.version);
            const hint = $('updHint');
            if (hint) {
                hint.textContent = '发现新版本 v' + r.version
                    + (r.canAuto ? '' : ' —— 没填 GitHub 令牌，请点下面的链接去浏览器下载');
            }
        }
    }).catch(() => {});
}


/* 后端查完更新推回来（qs://update）。
 *
 * `manual = true` 表示这是用户点「检查更新」触发的 —— 那时候**无论有没有新版
 * 都要给回话**（用户主动问了，什么都不说等于"点了没反应"）。
 * 自动检查（manual=false）只有真有新版才会推过来，所以这里不用再判 newer。 */
listen('qs://update', (ev) => {
    const p = ev.payload || {};
    const check = $('btnUpdateCheck');
    if (check) check.disabled = false;
    /* v1.5.10：一次检查 = 一次 API 调用，额度那一行要跟着动。
     * 放最前面：不管后面走哪个分支（有新版本 / 没有 / 失败），
     * 这次请求都已经花掉了。 */
    refreshGithubRate();
    const hint = $('updHint');
    if (p.newer) {
        UPD_INFO = {
            version: p.version, notes: p.notes, size: p.size, page: p.page,
            url: p.url, authed: !!p.authed, canAuto: !!p.canAuto,
        };
        updShowFound(p.version);
        if (hint) {
            hint.textContent = p.canAuto
                ? '发现新版本 v' + p.version + '，可以下载'
                : '发现新版本 v' + p.version + ' —— 没填 GitHub 令牌，请点下面的链接去浏览器下载';
        }
    } else {
        const found = $('updFound');
        if (found) found.hidden = true;
        if (hint) hint.textContent = '已是最新版本（v' + (p.current || CONF.version || '—') + '）';
        if (p.manual) toast('已是最新版本');
    }
    /* 令牌填了但 GitHub 不认（过期 / 没权限）：后端已经自动降到匿名请求，
     * 那句原因必须让用户看见，否则"填了令牌却还是 60 次/小时"完全查不出来。 */
    if (p.authWarning) toast(p.authWarning);
});

/* 下载进度 */
listen('qs://update-progress', (ev) => {
    const p = ev.payload || {};
    updPaintProgress(p.done || 0, p.total || 0);
});

/* 装好了 */
listen('qs://update-done', (ev) => {
    const v = ev.payload || '';
    const bar = $('updBar');
    if (bar) { bar.style.width = '100%'; bar.style.opacity = '1'; }
    const ins = $('btnUpdateInstall');
    if (ins) ins.hidden = true;
    const rst = $('btnUpdateRestart');
    if (rst) rst.hidden = false;
    const tip = $('updDoneTip');
    if (tip) tip.hidden = false;
    const hint = $('updHint');
    if (hint) hint.textContent = 'v' + v + ' 已安装完成';
    toast('新版本 v' + v + ' 已装好，点「立即重启」生效');
});

/* 下载/替换失败 */
listen('qs://update-failed', (ev) => {
    const msg = (ev && ev.payload) || '未知原因';
    const ins = $('btnUpdateInstall');
    if (ins) ins.disabled = false;
    const pg = $('updProgress');
    if (pg) pg.hidden = true;
    const hint = $('updHint');
    /* v1.5.11：失败原因**留在页面上**。
     *
     * 以前这里只写"更新失败"，真正的原因塞进 toast 一闪就没 —— 用户只知道
     * "失败了"，不知道断在网络上、校验上、还是被拒，也就没法判断该重试
     * 还是换条路。后端现在会说清"已重试几轮"，这一句必须留在眼前。 */
    if (hint) hint.textContent = msg;
    /* 并且把主按钮切成**兜底入口**：后端已经自动换源重试过几轮，还失败说明
     * 这条路此刻真不通。与其让用户反复点同一个按钮，不如直接给他另一条路
     * —— 按钮变「用浏览器下载」，下面的直链也一并显示出来。 */
    if (UPD_INFO && UPD_INFO.url) {
        UPD_INFO.canAuto = false;
        updPaintAuthMode();
    }
    toast('下载失败：' + msg);
});

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */


listen('qs://config', (ev) => {
    CONF = window.CONF = ev.payload || {};
    /* ⚠ 广播会带着整份配置反复到达（横条收藏面板存一次尺寸就一次）。
     *   这里任何一处元素缺失或抛错，都会让后面的刷新整段中断 —— 表现就是
     *   "设置页在改了某项之后整个不再跟着刷新"。原来只靠"取值一律走
     *   qsSetText"来防，但事件监听里的**同步**异常连 unhandledrejection 都
     *   兜不住。整段套一层 try/catch：至少把错暴露出来，不再静默失效。 */
    try {
        applyConfigBroadcast();
    } catch (e) {
        console.error('[qs] 配置广播刷新出错', e);
        toast('设置页刷新出错：' + String(e).slice(0, 120));
    }
});

/** 广播到达后的整段刷新（拆成函数只是为了给调用处套 try/catch）。 */
function applyConfigBroadcast() {
    qsSetText('ver', 'v' + (CONF.version || '—'));
    fillAbout();
    // 自定义引擎可能刚被增删改，先后并一次再渲染
    qsMergeCustomEngines(CATALOG, BY_NAME, CONF);
    renderBarList();
    renderAllList();
    renderCustomList();
    renderAppList();
    /* 表单旁的图标预览也要跟着刷（overrideIcons 可能刚在列表行上被改掉 ——
     * 只刷列表的话，同一张图在列表里换了、表单里还是旧的）。 */
    syncCeIcon();
    syncAppIcon();
    // 用户正在 AI 后缀输入框里打字时别重建（同上：重建会丢光标、覆盖输入法组合）
    if (!qsEditingIn('aiList')) renderAiList();
    syncOcrInBarBtn();
    // r54：识图那一栏跟着配置走（默认引擎 / 勾选被别处改过时，设置开着也要
    // 立刻反映新状态 —— 否则"这边显示没勾、那边已经在用了"）
    renderImgEngines();
    refreshWdPreview();
    // 备份目录/文件清单：广播里带上（防抖 —— 横条收藏面板存一次尺寸就是一次
    // 广播，没必要每次都去读目录）
    clearTimeout(bkInfoTimer);
    bkInfoTimer = setTimeout(refreshBackupInfo, 400);
    bindSwitches();
    // v1.5.13：启动密码那两行也要跟着广播刷新（别处改了配置 / 恢复备份之后，
    // 「已设置」状态可能与页面上的开关不一致）。事件只绑一次，这里只回填。
    bindStartupPassword();
}

listen('qs://toast', (ev) => toast(String(ev.payload || '')));

listen('qs://webdav', (ev) => {
    const m = String(ev.payload || '');
    qsSetText('wdStatus', m);
    toast(m);
    // 每次云操作（备份 / 恢复 / 测试连接）之后都要重读一次本机备份目录：
    // 「立即备份」会在备份目录里落一份，不刷新的话用户看到的是**上一次**的清单，
    // 会以为"我明明备份了，怎么没落下来"。
    clearTimeout(bkInfoTimer);
    bkInfoTimer = setTimeout(refreshBackupInfo, 200);
});

listen('qs://ocr', (ev) => {
    const m = String(ev.payload || '');
    qsSetText('ocrHint', m);
    toast(m);
});

/* r46：「测试连接」和「拉取模型」的结果都走事件回来（后端异步跑，不卡设置页）。 */
listen('qs://ocr-test', (ev) => onOcrTestResult(ev.payload || {}));
listen('qs://ocr-models', (ev) => onOcrModels(ev.payload || {}));

/* v1.5.16 第二轮：翻译的「拉取模型」同样异步回事件（后端可能拉几百个模型）。
 * 「测试连接」不走事件 —— trans_test 是一问一答的命令，返回值里就有结果。 */
listen('qs://trans-models', (ev) => onTransModels(ev.payload || {}));

listen('qs://ensure-rect', (ev) => reportRects(String(ev.payload || '')));

// 横条面板里的「设置…」会带上要跳的分页（引擎面板→引擎、收藏夹面板→收藏夹）
listen('qs://goto-tab', (ev) => {
    // ⚠ 收到控制事件先回声：Rust 首建窗的补发线程靠这个停止补发 ——
    // 无脑补 1.44s 的话，尾巴上迟到的 emit 会把用户后来切的分页冲掉
    // （打开设置 1.4 秒内点别的页会被弹回去，踩过）。
    try { invoke('qs_page_ack'); } catch (e) { }
    const name = String((ev && ev.payload) || '').trim();
    if (!name) return;
    const b = document.querySelector('#tabs button[data-tab="' + name + '"]');
    if (b) b.click();
});

listen('qs://focus-engine', (ev) => {
    try { invoke('qs_page_ack'); } catch (e) { }
    const name = ev.payload;
    if (!name) return;
    // 跳到「引擎」标签页再高亮
    for (const b of $('tabs').querySelectorAll('button')) {
        if (b.dataset.tab === 'engines') b.click();
    }
    const box = $('barList');
    for (const row of box.children) {
        if (row.textContent.includes(name)) {
            $('sec-bar').classList.remove('hl');
            void $('sec-bar').offsetWidth;
            $('sec-bar').classList.add('hl');
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
            break;
        }
    }
});

/* ------------------------------------------------------------------ */
/* 自动化测试支持：把关键控件的 rect 汇报给后端日志                       */
/* ------------------------------------------------------------------ */

/** 给每个控件取一个稳定名字，连同 getBoundingClientRect 一起 JSON 化打日志。
 *  真机上没法用选择器点，只能靠屏幕坐标；坐标必须由页面自己给才准（受 DPI、
 *  字体缩放、滚动位置影响）。
 *
 *  ⚠ 两个坑，外部脚本靠屏幕坐标点击时一定会踩：
 *   1. getBoundingClientRect 是**视口坐标**。控件如果在滚动区里被滚出去了，
 *      返回的 y 会大于视口高度，换算成屏幕坐标就落到屏幕外 —— 点了个寂寞。
 *   2. 只有当前可见那一页的控件坐标才有效，别的页全是 0。
 *  所以多了个 `ensure`：点某个控件前，先把它 scrollIntoView 再重新报一次，
 *  报出来的就是它此刻**真实在屏幕上**的位置。 */
function reportRects(ensure) {
    const rects = {};
    const put = (name, el) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        rects[name] = { x: r.left, y: r.top, w: r.width, h: r.height };
    };

    // ensure 给的是控件名（如 'btn-pick-app'）；先滚到它再量，量到的才在视口里。
    if (ensure) {
        let target = null;
        if (ensure.startsWith('tab-')) {
            target = document.querySelector(`#tabs button[data-tab="${ensure.slice(4)}"]`);
        } else if (ensure.startsWith('barrow-')) {
            const rows = barItemRows();
            target = rows[+ensure.split('-')[1]];
        } else {
            const map = {
                'btn-pick-app': 'btnPickApp', 'btn-pick-file': 'btnPickFile', 'btn-ocr': 'btnOcr',
            };
            if (map[ensure]) {
                target = $(map[ensure]);
            } else {
                // theme-light / ocr-acc-0 / filter-blacklist / ocr-lang-ENG …
                const [key, val] = [ensure.slice(0, ensure.lastIndexOf('-')), ensure.slice(ensure.lastIndexOf('-') + 1)];
                const segMap = { theme: 's-theme', 'ocr-acc': 's-ocrAccurate', 'ocr-lang': 's-ocrLang', filter: 's-filterMode' };
                const seg = segMap[key] ? $(segMap[key]) : null;
                if (seg) target = [...seg.querySelectorAll('button')].find((b) => String(b.dataset.v) === val);
            }
        }
        if (target) {
            target.scrollIntoView({ block: 'center', behavior: 'instant' });
            // 同步几何：读一次 offsetHeight 逼浏览器立刻重排，别等到下一帧才量
            void target.offsetHeight;
        }
    }

    document.querySelectorAll('#tabs button').forEach((b) => put('tab-' + b.dataset.tab, b));

    for (const [id, key] of [['s-theme', 'theme'], ['s-ocrAccurate', 'ocrAccurate'],
        ['s-ocrLang', 'ocrLang'], ['s-filterMode', 'filterMode']]) {
        const seg = $(id);
        if (!seg) continue;
        seg.querySelectorAll('button').forEach((b) => {
            const v = (b.dataset.v || '').toString();
            put(`${key === 'theme' ? 'theme' : key === 'ocrAccurate' ? 'ocr-acc' : key === 'ocrLang' ? 'ocr-lang' : 'filter'}-${v}`,
                b);
        });
    }

    put('btn-pick-app', $('btnPickApp'));
    put('btn-pick-file', $('btnPickFile'));
    put('btn-ocr', $('btnOcr'));

    // 横条列表行（只有「引擎」页可见时坐标才有效，所以点之前要先切到引擎页）
    barItemRows().forEach((row, i) => put('barrow-' + i, row));

    const s = JSON.stringify(rects);
    invoke('log_msg', { msg: 'RECTS ' + s }).catch(() => { });
}

// 调试构建下，把 reportRects 挂到 window 上，并每次切分页后自动重报一次
// （只有当前可见那一页的控件坐标才是有效的）。
window.__qsReportRects = reportRects;

// 测试脚本要「先滚到某个控件再点」时用这个：window.__qsEnsureRect('btn-pick-app')
// 会把它滚进视口并立刻重报坐标，脚本随后去日志里取最新那份即可。
window.__qsEnsureRect = (name) => reportRects(name);

/* ------------------------------------------------------------------ */
/* 调试构建的内建自检                                                   */
/* ------------------------------------------------------------------ */

/** 在**真实 WebView** 里跑一遍：用 element.click() 驱动真实控件，走真实的
 *  Tauri invoke 往返，再看服务端 config 有没有真的变。比在外头注入鼠标点
 *  可靠得多（不受 DPI、窗口位置、时序影响），而且测的是真链路不是桩。
 *
 *  只有 QS_DEBUG=1 时才跑；结果打成 [js] SELFTEST 一行行进日志。 */
async function qsSelfTest() {
    const log = (s) => invoke('log_msg', { msg: 'SELFTEST ' + s }).catch(() => { });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cfgNow = () => invoke('get_config');

    const grab = (id) => document.getElementById(id);
    const clickBtn = (segId, val) => {
        const seg = grab(segId);
        if (!seg) return false;
        const b = [...seg.querySelectorAll('button')].find((x) => String(x.dataset.v) === String(val));
        if (!b) return false;
        b.click();
        return true;
    };
    const tab = (name) => {
        const b = document.querySelector('#tabs button[data-tab="' + name + '"]');
        if (b) b.click();
        return !!b;
    };

    log('begin');

    // 自检会真的改配置（这正是它的目的），所以先把原始值拍个快照，
    // 跑完再原样写回去 —— 免得开发机上的配置被测试弄乱。
    const snap = await cfgNow();

    // 1) 分页按钮都能切
    let tabsOk = 0;
    for (const t of ['engines', 'ai', 'ocr', 'backup', 'general']) {
        if (tab(t)) tabsOk++;
        const pane = document.querySelector('.pane[data-pane="' + t + '"]');
        if (!pane || pane.hidden) log('FAIL tab ' + t + ' 没切成');
        await wait(30);
    }
    log(tabsOk === 5 ? 'PASS 五个分页都能切' : 'FAIL 分页只切了 ' + tabsOk + ' 个');

    // 2) OCR 精度：点「标准」-> 测试 -> 点「高精度」
    tab('ocr'); await wait(50);
    clickBtn('s-ocrAccurate', '0'); await wait(500);
    let c = await cfgNow();
    log(c.ocrAccurate === false ? 'PASS OCR 精度=标准 落盘' : 'FAIL OCR 精度=标准 没落盘 ' + JSON.stringify(c.ocrAccurate));
    clickBtn('s-ocrAccurate', '1'); await wait(500);
    c = await cfgNow();
    log(c.ocrAccurate === true ? 'PASS OCR 精度=高精度 落盘' : 'FAIL OCR 精度=高精度 没落盘 ' + JSON.stringify(c.ocrAccurate));
    // 选中态有没有画对
    const onBtn = [...grab('s-ocrAccurate').querySelectorAll('button')].find((x) => x.classList.contains('on'));
    log(onBtn && onBtn.dataset.v === '1' ? 'PASS 高精度按钮显示为选中' : 'FAIL 高精度按钮没显示选中');

    // 3) OCR 语言
    clickBtn('s-ocrLang', 'ENG'); await wait(400);
    c = await cfgNow();
    log(c.ocrLang === 'ENG' ? 'PASS OCR 语言=纯英文 落盘' : 'FAIL OCR 语言没落盘 ' + JSON.stringify(c.ocrLang));
    clickBtn('s-ocrLang', 'CHN_ENG'); await wait(400);

    // 4) 主题三档
    tab('general'); await wait(50);
    for (const [v, want] of [['light', 'light'], ['dark', 'dark'], ['system', 'system']]) {
        clickBtn('s-theme', v); await wait(400);
        c = await cfgNow();
        log(c.theme === want ? 'PASS 主题 ' + v + ' 落盘' : 'FAIL 主题 ' + v + ' 没落盘 ' + JSON.stringify(c.theme));
    }

    // 5) 开关（OCR 总开关）
    const swOcr = grab('s-ocrEnable');
    if (swOcr) {
        swOcr.checked = false;
        swOcr.dispatchEvent(new Event('change'));
        await wait(400);
        c = await cfgNow();
        log(c.ocrEnable === false ? 'PASS OCR 总开关能关' : 'FAIL OCR 总开关没关掉 ' + JSON.stringify(c.ocrEnable));
        swOcr.checked = true;
        swOcr.dispatchEvent(new Event('change'));
        await wait(400);
        c = await cfgNow();
        log(c.ocrEnable === true ? 'PASS OCR 总开关能开回来' : 'FAIL OCR 总开关没开回来');
    } else {
        log('FAIL 找不到 OCR 总开关');
    }

    // 5b) 「同时识别」（r47：取代双引擎并行开关）——
    //     点一颗胶囊要真的落进配置的 ocrMulti，再点回来要能取消。
    /* ⚠ r77：胶囊列表里**不含当前默认引擎**（默认引擎本来就一定参与）。
     * 以前这里无脑取 `chips[0]` —— 当默认引擎恰好就是 chips[0] 那一颗时，
     * 点它等于"把默认引擎再勾进去一次"，后端会按设计把它剔掉，于是
     * 什么都没落盘，报出两条**假 FAIL**（r76 的 exe 上同样复现，与代码无关）。
     *
     * 现在：**先问后端**当前默认引擎是谁（CONF 可能落后于一次点击），
     * 再挑一颗明确不同的。 */
    tab('ocr'); await wait(50);
    const cfgNow0 = await cfgNow();
    const defNow = String(cfgNow0.ocrEngine || '');
    const chips = [...document.querySelectorAll('#w-ocrMultiBox .multi-chip')];
    const pick = chips.find((x) => x.dataset.id && x.dataset.id !== defNow && !x.classList.contains('on'))
        || chips.find((x) => x.dataset.id && x.dataset.id !== defNow)
        || null;
    if (pick) {
        const id = pick.dataset.id;
        pick.click();
        await wait(500);
        c = await cfgNow();
        const on = Array.isArray(c.ocrMulti) && c.ocrMulti.indexOf(id) >= 0;
        log(on ? 'PASS 同时识别能勾上（' + id + '，默认=' + defNow + '）'
            : 'FAIL 同时识别没落盘 ' + JSON.stringify(c.ocrMulti));
        const again = document.querySelector('#w-ocrMultiBox .multi-chip[data-id="' + id + '"]');
        if (again) again.click();
        await wait(500);
        c = await cfgNow();
        const off = Array.isArray(c.ocrMulti) && c.ocrMulti.indexOf(id) < 0;
        log(off ? 'PASS 同时识别能取消（' + id + '）' : 'FAIL 同时识别没取消 ' + JSON.stringify(c.ocrMulti));
    } else {
        log('FAIL 找不到「同时识别」的引擎胶囊');
    }

    // 6) 预览真的渲染出东西
    tab('engines'); await wait(60);
    const pv = grab('qsPreviewB');
    const pvCount = pv ? pv.querySelectorAll('.pv-item').length : 0;
    log(pvCount > 0 ? 'PASS 引擎预览渲染出 ' + pvCount + ' 个图标' : 'FAIL 预览是空的');

    // 6b) 预览里的竖线数量必须**等于**用户自己加的分隔线数量。
    //     以前预览末尾会白送一根「引擎区 | 功能按钮」的分界，而真身那根
    //     早就删了 —— 用户在预览里看到一根自己没加过的竖线，去横条上一看又没有。
    {
        const c0 = await cfgNow();
        const sepWanted = (c0.barList || []).filter((n) => n === QS_SEP).length;
        const sepShown = pv ? pv.querySelectorAll('.pv-sep').length : 0;
        log(sepShown === sepWanted
            ? 'PASS 预览竖线数=' + sepShown + '，与配置里的分隔线数一致（没有白送的竖线）'
            : 'FAIL 预览竖线数=' + sepShown + ' 但配置里只有 ' + sepWanted + ' 条分隔线');
    }

    // 6c) OCR 必须在「横条上的引擎」列表里看得见（用户报过「看不到 OCR、没法选位置」）
    {
        const rowsAll = [...grab('barList').querySelectorAll('.item')];
        const ocrRows = rowsAll.filter((r) => r.classList.contains('ocr-row'));
        const ocrRow = ocrRows[0];
        log(ocrRow ? 'PASS 横条列表里能看到 OCR 那一行' : 'FAIL 横条列表里没有 OCR 行');
        const c0 = await cfgNow();
        const inBar = (c0.barList || []).includes(QS_OCR);
        if (inBar) {
            log(ocrRow && !ocrRow.classList.contains('add-row')
                ? 'PASS OCR 已在横条里，显示为可拖动的成员行'
                : 'FAIL OCR 已在横条里，却没显示成成员行');
            // ★ 用户报过的 bug：OCR 已经在横条里，底部还挂着一个「＋ 加进横条」
            //   入口行（list.includes(字符串) 对对象数组恒 false）。这里钉死：
            //   在横条里时，整个列表里**不允许**再有 add-row 形态的 OCR 行。
            const dupAdd = ocrRows.filter((r) => r.classList.contains('add-row')).length;
            log(dupAdd === 0
                ? 'PASS OCR 已在横条里，没有再画「加进横条」入口行（不重复显示）'
                : 'FAIL OCR 已在横条里，却还画了 ' + dupAdd + ' 个入口行（重复显示）');
        } else {
            log(ocrRow && ocrRow.classList.contains('add-row')
                ? 'PASS OCR 未加入时给出「加进横条」入口行'
                : 'FAIL OCR 未加入时没有入口行');
            // 反方向也要钉：没加入时不该出现成员行（否则用户会以为已经加过了）
            const memberDup = ocrRows.filter((r) => !r.classList.contains('add-row')).length;
            log(memberDup === 0
                ? 'PASS OCR 未加入时只有入口行、没有成员行'
                : 'FAIL OCR 未加入时却出现了 ' + memberDup + ' 个成员行');
        }
        // 6d) OCR 行/入口行的图标必须是 OCR 徽标或用户挑的图（不能是 "@" / "O"
        //     这种字母兜底）。r70：判据放宽到「徽标 **或** 自定义图」—— 用户
        //     给 OCR 换过图标时行里就是 <img>，老判据只认 .ocr-tag，会在任何
        //     换过图标的机器上误报（本机配置就换过，r69 及以前一直红着）。
        const tag = ocrRow ? ocrRow.querySelector('.ocr-tag') : null;
        const customImg = ocrRow ? ocrRow.querySelector('.ic > img') : null;
        const letterFallback = ocrRow ? ocrRow.querySelector('.ic > .letter') : null;
        log((tag && tag.textContent === 'OCR') || (customImg && !letterFallback)
            ? 'PASS OCR 用的是 OCR 徽标/自定义图标（不是字母兜底）'
            : 'FAIL OCR 图标不对：' + (letterFallback ? '字母兜底' : (tag ? JSON.stringify(tag.textContent) : '没有徽标')));
    }

    // 6e) 「换个图标」不再放在文字识别页（用户要求删掉，功能在「引擎」页有）
    log(!grab('btnOcrIcon') ? 'PASS 文字识别页不再有重复的「换个图标…」按钮'
        : 'FAIL 文字识别页还留着「换个图标…」按钮');

    // 6f) 统一图标大小：带透明留白的图标要自动放大，铺满型的保持原样。
    //     这条直接对应「我看有的图标大、有的图标小」那个反馈。
    //     测量是异步的（要把图渲染进 canvas 量包围盒），所以先等一会儿。
    /* r73：引擎库默认只显示四个大类（列表是空的），所以先点开「全部引擎」
     * 把行铺出来 —— 不然下面按名字找不到行，四颗 k 全是 null。 */
    {
        const chip = [...document.querySelectorAll('#allGrpNav .eng-nav-item')]
            .find((b) => b.textContent === '全部引擎');
        if (chip) chip.click();
        await wait(900);
    }
    {
        await wait(2600);
        const opticalOf = (name) => {
            const row = [...grab('allList').querySelectorAll('.item')]
                .find((r) => {
                    const nm = r.querySelector('.nm');
                    return nm && nm.textContent.startsWith(name);
                });
            const im = row && row.querySelector('.ic > img');
            if (!im) return null;
            const v = parseFloat(getComputedStyle(im).getPropertyValue('--qs-optical'));
            return isFinite(v) ? v : 1;
        };
        // 秘塔AI搜索.png：1024 画布，内容只占 84% —— 典型「自带留白」
        const pad = opticalOf('秘塔AI搜索');
        // 百度百科.png：内容铺满画布 —— 典型「铺满型」
        const flat = opticalOf('百度百科');
        log(pad !== null && pad > 1.05
            ? 'PASS 带透明留白的图标被自动放大（秘塔AI搜索 k=' + pad.toFixed(3) + '）'
            : 'FAIL 带留白的图标没被放大：k=' + pad);
        log(flat !== null && flat <= 1.01
            ? 'PASS 铺满型图标保持原样（百度百科 k=' + flat.toFixed(3) + '）'
            : 'FAIL 铺满型图标被动了：k=' + flat);

        // 用户换过图标的那几个（淘宝/天猫/京东…）：必须和内置图标走**同一条**
        // 管线。r70→r71：判据两次修正，最后钉在**和产品同一把尺子**上——
        // shared.js 的 measure() 按「主体包围盒的最大边 / 画布」（tightBox 后
        // 再减 EDGE_INSET）算 fill：≥ NOOP_FILL(0.98) 判铺满不缩放，否则
        // k = clamp(1/fill, 1, K_MAX=1.5)。所以自检也量 bbox 占比，别量
        // alpha 填充率（京东的图左右贴边、上下留白，alpha 填充率只有 0.33，
        // 但 bbox 占比 1.0 —— 按产品口径就是铺满型，不该缩放；早先两版判据
        // 在这儿恒红，不是产品的 bug，是尺子拿错了）。
        const overrides = (await cfgNow()).overrideIcons || {};
        const swapped = ['淘宝', '天猫', '京东'].filter((n) => overrides[n]);
        if (swapped.length) {
            // 量一张图的主体包围盒占比（和 measure() 同思路：画进 canvas 数
            // 非透明像素的 bbox。底色排除那一步对这些透明底图标是空操作，
            // 量出来和产品同口径；tightBox 的密度收紧只会让 bbox 更小、
            // k 更大，所以「占比大 → 不缩放」这个方向的判据不受影响）。
            const extentOf = (url) => new Promise((res) => {
                const im = new Image();
                const done = (v) => res(v);
                im.onload = () => {
                    try {
                        const W = im.naturalWidth, H = im.naturalHeight;
                        const cv = document.createElement('canvas');
                        cv.width = W; cv.height = H;
                        const cx = cv.getContext('2d', { willReadFrequently: true });
                        cx.drawImage(im, 0, 0);
                        const d = cx.getImageData(0, 0, W, H).data;
                        let x0 = W, y0 = H, x1 = -1, y1 = -1;
                        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                            if (d[(y * W + x) * 4 + 3] > 8) {
                                if (x < x0) x0 = x; if (x > x1) x1 = x;
                                if (y < y0) y0 = y; if (y > y1) y1 = y;
                            }
                        }
                        if (x1 < 0) { done(1); return; }
                        done(Math.max(x1 - x0 + 1, y1 - y0 + 1) / Math.max(W, H));
                    } catch (e) { done(1); }
                };
                im.onerror = () => done(1);
                im.src = url;
            });
            const bad = [];
            const detail = [];
            for (const n of swapped) {
                const k = opticalOf(n);
                const ext = await extentOf(overrides[n]);
                const full = ext >= 0.98;   // NOOP_FILL：铺满型
                const wantK = full ? 1 : Math.min(1.5, 1 / ext);
                detail.push(n + ' k=' + (k || 1).toFixed(3) + ' 期望≈' + wantK.toFixed(3) + '(bbox=' + ext.toFixed(2) + ')');
                // 铺满型：必须没被放大（容差 0.02）；非铺满：必须放大过
                if (full && k && k > 1.02) bad.push(n + ' 铺满型却被放大');
                if (!full && !(k > 1.02)) bad.push(n + ' 有留白却没放大');
            }
            log(bad.length === 0
                ? 'PASS 用户换过的图标按包围盒占比补偿（' + detail.join(' ') + '）'
                : 'FAIL 用户换过的图标补偿不对：' + bad.join('；') + ' [' + detail.join(' ') + ']');
        }

        // 关掉开关之后，补偿要**立刻**清掉（用户点一下就该看到区别）
        const sw = grab('s-unifyIcons');
        if (sw) {
            sw.checked = false;
            sw.dispatchEvent(new Event('change'));
            await wait(1200);
            const off = opticalOf('秘塔AI搜索');
            log(off !== null && off <= 1.01
                ? 'PASS 关掉「统一图标大小」后不再补偿（k=' + off.toFixed(3) + '）'
                : 'FAIL 关掉开关后仍在补偿：k=' + off);
            sw.checked = true;
            sw.dispatchEvent(new Event('change'));
            await wait(1200);
        } else {
            log('FAIL 找不到「统一图标大小」开关 #s-unifyIcons');
        }
    }

    // 7) 横条列表与拖拽：用真实的 pointer 事件序列驱动第 0 行到第 3 行
    //    用 barItemRows()：把「＋ 加进横条」那种入口行排除掉，
    //    否则它的下标会混进 bar_list 的下标里，拖出来的结果没法对。
    const rows = barItemRows();
    log(rows.length > 3 ? 'PASS 横条列表渲染出 ' + rows.length + ' 行' : 'FAIL 横条列表行数=' + rows.length);
    if (rows.length > 3) {
        const before = (await cfgNow()).barList.slice();
        const src = rows[0], dst = rows[3];
        const r0 = src.getBoundingClientRect(), r3 = dst.getBoundingClientRect();
        const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 1, button: 0,
            clientX: x, clientY: y,
        }));
        const x0 = r0.left + 20, y0 = r0.top + r0.height / 2;
        const x3 = r3.left + 20, y3 = r3.top + r3.height / 2;
        fire(src, 'pointerdown', x0, y0);
        for (let i = 1; i <= 10; i++) {
            const xx = x0 + (x3 - x0) * i / 10, yy = y0 + (y3 - y0) * i / 10;
            fire(document, 'pointermove', xx, yy);
        }
        fire(document, 'pointerup', x3, y3);
        await wait(600);
        const after = (await cfgNow()).barList;
        log(JSON.stringify(before) !== JSON.stringify(after)
            ? 'PASS 拖拽换位生效 ' + JSON.stringify(before.slice(0, 4)) + ' -> ' + JSON.stringify(after.slice(0, 4))
            : 'FAIL 拖拽换位没生效 ' + JSON.stringify(before.slice(0, 4)));
    }

    // 8) 黑白名单：鼠标拾取 / 文件挑选按钮在（实际弹窗交给真机脚本点）
    tab('general'); await wait(50);
    log(grab('btnPickApp') ? 'PASS 「用鼠标点选程序」按钮在' : 'FAIL 找不到点选程序按钮');
    log(grab('btnPickFile') ? 'PASS 「从电脑里挑程序」按钮在' : 'FAIL 找不到挑程序按钮');

    // 9) 自定义引擎：能加、能删
    tab('engines'); await wait(50);
    const nameIn = grab('w-ceName'), urlIn = grab('w-ceUrl'), catIn = grab('w-ceCat');
    if (nameIn && urlIn) {
        nameIn.value = '__selftest__';
        urlIn.value = 'https://example.com/s?q=%s';
        if (catIn) catIn.value = '';
        grab('btnCeSave').click();
        await wait(600);
        c = await cfgNow();
        const added = (c.customEngines || []).some((e) => e.name === '__selftest__');
        log(added ? 'PASS 自定义引擎能添加' : 'FAIL 自定义引擎没加上');
        // 删掉它（走列表里的删除按钮）
        const crow = [...grab('customList').querySelectorAll('.item')].find((r) => r.textContent.includes('__selftest__'));
        if (crow) {
            const del = [...crow.querySelectorAll('button')].find((b) => /删除/.test(b.textContent));
            if (del) {
                // 删除是「点一下变确认、再点一下才真删」的防误触设计，所以要点两次
                del.click();
                await wait(120);
                if (del.dataset.arm === '1') del.click();
                await wait(600);
                c = await cfgNow();
                const gone = !(c.customEngines || []).some((e) => e.name === '__selftest__');
                log(gone ? 'PASS 自定义引擎能删除（含二次确认）' : 'FAIL 自定义引擎没删掉');
            } else {
                log('FAIL 找不到自定义引擎的删除按钮');
            }
        } else {
            log('FAIL 列表里找不到刚加的自定义引擎行');
        }
    } else {
        log('FAIL 找不到自定义引擎输入框');
    }

    /* 6c) r75：回到顶部浮动钮。
     *     判据是「滚过两屏」—— 这里按两屏上下各测一次（差一点不亮、超过就亮），
     *     再点一下看它真能把主容器拨回顶端。
     *     ⚠ 用「全部引擎」那一页测：它铺了 700+ 行，肯定不止两屏；帮助页在
     *       大窗口下可能本来就不够两屏，拿它测会得到"功能没坏、断言假失败"。 */
    {
        tab('engines'); await wait(120);
        const m = grab('main');
        const fab = grab('toTopFab');
        const maxScroll = m ? m.scrollHeight - m.clientHeight : 0;
        if (!m) {
            log('FAIL 找不到主滚动容器 #main');
        } else if (!fab) {
            log('FAIL 找不到回到顶部浮动钮');
        } else if (maxScroll < m.clientHeight * 2 + 200) {
            log('SKIP 当前列表不够两屏（可滚 ' + Math.round(maxScroll) + 'px / 屏 '
                + m.clientHeight + 'px），回到顶部这条测不了');
        } else {
            const page = m.clientHeight;
            // 先滚到「两屏差一点」：不该亮
            m.scrollTop = page * 2 - 40;
            await wait(140);
            log(!fab.classList.contains('on') ? 'PASS 没到两屏时回到顶部不出现' : 'FAIL 没到两屏就冒出来了');
            // 再滚过两屏：该亮
            m.scrollTop = page * 2 + 120;
            await wait(140);
            const clsOn = fab.classList.contains('on');
            const pe = getComputedStyle(fab).pointerEvents;
            const op = parseFloat(getComputedStyle(fab).opacity);
            log(clsOn && pe === 'auto' && op > 0.5
                ? 'PASS 滚过两屏后回到顶部出现且可点'
                : 'FAIL 滚过两屏后回到顶部没出现（class=' + clsOn + ' pointer-events=' + pe + ' opacity=' + op + '）');
            // 点它：应当把 main 拨回顶端（smooth 动画，最多给 2s）
            fab.click();
            let top = -1;
            for (let i = 0; i < 8; i++) {
                await wait(250);
                top = m.scrollTop;
                if (top <= 4) break;
            }
            log(top <= 4 ? 'PASS 点回到顶部能滚回顶端' : 'FAIL 点了没回顶端（scrollTop=' + top + '）');
            // 回顶之后钮自己收起来
            await wait(160);
            log(!fab.classList.contains('on') ? 'PASS 回顶后回到顶部自动收起' : 'FAIL 回顶后钮还亮着');
        }
    }

    log('done');

    // 还原快照：把自检改动过的键写回去（customEngines / barList 这些最容易被弄乱）
    try {
        const restore = ['theme', 'ocrAccurate', 'ocrLang', 'ocrEnable', 'unifyIcons'];
        for (const k of restore) {
            if (snap[k] !== undefined) await invoke('set_setting', { key: k, value: snap[k] });
        }
        // r47：同时识别名单是**数组**，走不了通用的 set_setting —— 用专用命令复原
        // （自检会点开/关掉一颗胶囊，不还原就把用户的名单改了）。
        if (Array.isArray(snap.ocrMulti)) {
            await invoke('ocr_set_multi', { engines: snap.ocrMulti });
        }
        // bar_list / custom_engines 没有通用的 set_setting 通道，用专用命令复原
        const cur = await cfgNow();
        // 先把自检临时加的自定义引擎清掉
        for (let i = (cur.customEngines || []).length - 1; i >= 0; i--) {
            if (cur.customEngines[i].name === '__selftest__') {
                await invoke('remove_custom_engine', { index: i });
            }
        }
        // 把横条顺序拨回快照（逐项调整，直到一致）
        const want = snap.barList || [];
        const now = (await cfgNow()).barList || [];
        for (let i = 0; i < want.length; i++) {
            const c2 = (await cfgNow()).barList || [];
            const at = c2.indexOf(want[i], i);
            if (at > i) await invoke('move_bar_item', { from: at, to: i });
        }
        log('RESTORED 已把配置还原到自检前');
    } catch (e) {
        log('RESTORE-FAIL ' + ((e && e.message) || e));
    }
}

/* ------------------------------------------------------------------ */
/* r80：AI 抠图（图标编辑器用）                                          */
/* ⚠ 这一整块必须在**顶层**，不能写在 boot() 里。                        */
/*   它原来确实在 boot 函数体内（`(async function boot() {` 一直到文件末尾  */
/*   才 `})();`），于是 15 个 ai* 函数全成了 boot 的局部函数 ——            */
/*   `bindSwitches` 里 `typeof aiOnSwitchChanged === 'function'` 永远为假， */
/*   开关切换后后端的模型 / 运行库状态永不刷新（用户看到"开关点了没反应"）。*/
/*   搬到顶层之后，boot 末尾那次 `aiInit()` 才真的能调到它。              */
/* ------------------------------------------------------------------ */

/* ══════════════════════════════════════════════════════════════════════════
 * r80：AI 抠图（图标编辑器用）
 *
 * 用户要求：
 *   ① 「图标的编辑功能处于可选，在设置通用里面打开」
 *   ② 「打开之后就会验证本地有没有这个模型，有的话就直接调用，没有的话那要下载，
 *      会弹出下载窗口以及下载进度条」
 *   ③ 「这个（模型）本身不包含在安装包之内」
 *   ④ 「模型分为多个版本，还有量化的版本，大小可选，想下载哪个那就用哪个」
 *
 * 所以这里的逻辑分四层：
 *   1. 开关打开 → 刷新状态（`ai_matting_status`）
 *   2. 状态里有运行时缺失 → 显示硬阻塞提示（模型能下但跑不了）
 *   3. 列出所有可选模型 + 体积 + 实测速度 + 是否已下载 + 哪个在用
 *   4. 点「下载」→ 就地显示进度条（可取消）；下完自动变成「使用」
 *
 * 为什么进度条放在卡片里而不是弹独立窗口：设置页本来就是个窗口，
 * 再弹一个窗口会挡住下面的选项、用户还得关它。就地显示最省事也最不易迷失。
 * （如果以后要独立窗口，进度事件 `model-download` 已经是通用的，换个宿主即可。）
 * ══════════════════════════════════════════════════════════════════════════ */

let AI_STATUS = null;          // 最近一次 ai_matting_status 的结果
const AI_DL = new Map();       // id -> { done, total, pct, phase }（正在下载的）

/** 人类可读体积（与 Rust 侧 aimodels::human_size 同口径，避免两边显示不一致）。 */
function aiSize(bytes) {
    const mb = 1024 * 1024;
    if (!bytes || bytes < 0) return '—';
    return bytes >= mb ? (bytes / mb).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
}

/** 渲染模型列表。 */
function aiRenderModels() {
    const box = $('aiModels');
    if (!box || !AI_STATUS) return;
    const models = AI_STATUS.models || [];
    const cur = AI_STATUS.current;
    box.innerHTML = '';
    for (const m of models) {
        const el = document.createElement('div');
        el.className = 'ai-model' + (m.id === cur ? ' on' : '');
        el.dataset.id = m.id;

        const downloading = AI_DL.get(m.id);
        // 「推荐」标记：用实测得分而不是写死的名字 —— 得分最高的那个才是推荐
        const best = Math.max(...models.map((x) => x.score || 0));
        const isBest = (m.score || 0) === best;

        const info = document.createElement('div');
        info.className = 'am-i';
        info.innerHTML =
            '<div class="am-n">' + aiEsc(m.name) +
            (isBest ? '<span class="am-tag">推荐</span>' : '') +
            (m.id === cur ? '<span class="am-tag" style="background:#16a34a">使用中</span>' : '') +
            '</div>' +
            '<div class="am-d">' + aiEsc(m.note) + '</div>' +
            '<div class="am-m">' + aiSize(m.bytes) +
            ' · 实测约 ' + (m.avgMs || 0) + ' ms' +
            ' · 输入 ' + (m.inputEdge || 0) + '×' + (m.inputEdge || 0) +
            (m.downloaded ? ' · 已下载' : '') +
            '</div>';
        el.appendChild(info);

        // 正在下载（运行库 / 等运行库 / 下模型）→ 进度条取代按钮
        if (downloading && (downloading.phase === 'downloading'
            || downloading.phase === 'runtime' || downloading.phase === 'runtime-wait')) {
            const wrap = document.createElement('div');
            wrap.style.flex = '1';
            /* r80p：三个阶段分别说清楚 ——
             *   runtime      正在下运行库（现在**直接下 11.84MB 的 dll**，不再下 69MB zip）
             *   runtime-wait 别的下载正在取运行库，本模型在等它
             *   downloading  正在下这个模型 */
            const label = downloading.phase === 'runtime'
                ? '正在下载运行库（11.84MB）'
                : (downloading.phase === 'runtime-wait'
                    ? '等运行库下载完成…'
                    : '正在下载模型');
            wrap.innerHTML =
                '<div class="ai-dl"><i style="width:' + (downloading.pct || 0) + '%"></i></div>' +
                '<div class="ai-dl-t"><span>' + label + '</span>' +
                '<span>' + (downloading.pct || 0) + '%</span>' +
                '<span>' + aiSize(downloading.done) + ' / ' + aiSize(downloading.total) + '</span></div>';
            el.appendChild(wrap);
            const cancel = document.createElement('button');
            cancel.className = 'btn';
            cancel.textContent = '取消';
            cancel.addEventListener('click', async () => {
                await invoke('ai_matting_cancel').catch(() => { });
            });
            el.appendChild(cancel);
        } else {
            const btns = document.createElement('div');
            btns.className = 'am-b';
            if (!m.downloaded) {
                const dl = document.createElement('button');
                dl.className = 'btn primary';
                dl.textContent = '下载';
                dl.title = '下载这个模型（' + aiSize(m.bytes) + '）';
                dl.addEventListener('click', () => aiStartDownload(m.id));
                btns.appendChild(dl);
            } else {
                if (m.id !== cur) {
                    const use = document.createElement('button');
                    use.className = 'btn primary';
                    use.textContent = '使用';
                    use.addEventListener('click', async () => {
                        AI_STATUS = await invoke('ai_matting_select', { id: m.id });
                        aiRender();
                    });
                    btns.appendChild(use);
                }
                const del = document.createElement('button');
                del.className = 'btn';
                del.textContent = '删除';
                del.title = '删掉已下载的模型文件腾出空间';
                del.addEventListener('click', async () => {
                    if (!confirm('删除「' + m.name + '」？下次要用得重新下载。')) return;
                    AI_STATUS = await invoke('ai_matting_remove', { id: m.id }).catch((e) => {
                        toast('删除失败：' + ((e && e.message) || e));
                        return null;
                    });
                    if (AI_STATUS) aiRender();
                });
                btns.appendChild(del);
            }
            el.appendChild(btns);
        }
        box.appendChild(el);
    }

    /* 一句总结：现在到底能不能用、还差什么。
     * 这是给"点了开关却发现没效果"的用户准备的 —— 别让他们自己猜。 */
    const tip = $('aiMatteTip');
    if (tip) {
        let msg;
        /* ⚠ 以前这里是两个一模一样的 `if (!AI_STATUS.runtime)` 分支 ——
         *   第二个 `else if` 永远不可能命中（死代码），而它承载的正是 r80g
         *   改口径之后**唯一正确**的那句提示（"运行库随模型一起下"）。
         *   也就是说：真正缺运行库时，用户看到的还是老文案"重新下载完整程序包"，
         *   照做也没用（安装包本来就不含 dll）。
         *   现在按**有没有模型已下载**分两种说法：
         *     · 一个模型都没有 → 告诉他"下模型时会一起下"（新口径）；
         *     · 已经有模型但运行库不在 → 这是异常（文件被删/被杀软隔离），
         *       告诉他去重新下载。 */
        const anyModel = models.some((m) => m.downloaded);
        if (!AI_STATUS.runtime) {
            msg = anyModel
                ? '运行库（onnxruntime.dll）不见了 —— 模型在但跑不了。点任意模型的「重新下载」，'
                    + '它会把运行库一起补上。'
                : '还差运行库（onnxruntime.dll）：不用单独找它，点某个模型的「下载」时会'
                    + '一起下好，并和模型放在同一个目录里。';
        } else if (!AI_STATUS.currentReady) {
            const cm = models.find((x) => x.id === cur);
            msg = '当前选的是「' + (cm ? cm.name : cur) + '」，但还没下载 —— 点上面的「下载」按钮，'
                + '下载完成后图标编辑器的自动抠图就会用上它。';
        } else {
            msg = '已就绪：图标编辑器 → 自动抠图、以及下面的「抠图工具」都能用了。';
        }
        tip.textContent = msg;
    }
}

/** 转义（模型名/说明里有 `（）` 与 `·`，但来源是本地清单，仍按规矩转义）。 */
function aiEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 根据当前状态决定显示/隐藏区块。 */
function aiRender() {
    const wrap = $('aiModelWrap');
    const rtRow = $('aiRuntimeRow');
    const on = !!(AI_STATUS && AI_STATUS.enable);
    if (wrap) wrap.hidden = !on;
    // 模型下拉框跟着状态走（哪些已下载会影响"可选但跑不了"的提示）
    if (on) aiCutFillModels();
    /* r80p：运行库那一行 —— 缺它、或者正在下它，都要显示 */
    const rtBusy = AI_DL.has('__runtime__');
    if (rtRow) rtRow.hidden = !(on && AI_STATUS && (!AI_STATUS.runtime || rtBusy));
    if (on) aiRenderModels();
    if (on) aiRenderRuntimeRow();
}

/** 拉一次状态并渲染。 */
async function aiRefresh() {
    try {
        AI_STATUS = await invoke('ai_matting_status');
    } catch (e) {
        AI_STATUS = null;
    }
    aiRender();
}

/** 开始下载：先把本地状态标成"下载中"（立刻出进度条），再发命令。
 *
 *  r80p：**允许并行下载** —— 用户明确要求
 *  「运行库跟每一个模型都可以同时下载，也都要单独下」。
 *
 *  所以这里不再挡"已有别的下载在跑"。每个模型有自己的 `AI_DL` 条目与
 *  自己的进度条，互不影响；后端那边运行库有门闩（只下一次），
 *  模型各自用自己的临时文件，不会互相踩。
 *
 *  ⚠ 唯一还要挡的是**同一个模型重复点**：那样会开出两个线程下同一个文件。
 */
async function aiStartDownload(id) {
    if (AI_DL.has(id)) {
        toast('这个模型正在下载中，稍等一下');
        return;
    }
    AI_DL.set(id, { done: 0, total: 0, pct: 0, phase: 'downloading' });
    aiRenderModels();
    try {
        await invoke('ai_matting_download', { id });
    } catch (e) {
        AI_DL.delete(id);
        aiRenderModels();
        toast('下载启动失败：' + ((e && e.message) || e));
    }
}

/** **单独下载运行库**（r80p 新增）。
 *
 *  用户要求：「这个运行库一直是没下下来，这个你也要优化一下具体的下载方式，
 *  也要在设置通用 ai 抠图里面提供一个下载的选项」。
 *
 *  所以给运行库一个**独立的下载按钮** —— 不必非得点某个模型才触发。
 *  用一个特殊的 id（`__runtime__`）复用它自己的进度条槽位。
 */
async function aiDownloadRuntime() {
    const KEY = '__runtime__';
    if (AI_DL.has(KEY)) { toast('运行库正在下载中'); return; }
    AI_DL.set(KEY, { done: 0, total: 0, pct: 0, phase: 'runtime' });
    aiRender();
    try {
        await invoke('ai_runtime_download');
    } catch (e) {
        AI_DL.delete(KEY);
        aiRender();
        toast('运行库下载启动失败：' + ((e && e.message) || e));
    }
}

/* 进度事件：后端每 1% 推一次（按百分比节流，见 aimodels::download 的注释）。
 * done / error / canceled 三种收尾都要刷新列表 —— 用户需要看到
 * "下好了，现在能用了" 或 "失败了，为什么"。 */
function aiBindProgress() {
    if (typeof listen !== 'function') return;
    listen('model-download', (ev) => {
        const p = (ev && ev.payload) || {};
        if (!p.id) return;
        /* r80p：阶段语义
         *   `runtime`       —— 正在下运行库（**现在是直接下 11.84MB 的 dll**）
         *   `runtime-wait`  —— 别的模型正在下运行库，本线程在等它（不要显示 0% 卡住）
         *   `downloading`   —— 正在下模型
         * 三种都塞进 AI_DL，让对应的那一行显示进度而不是按钮。 */
        if (p.phase === 'runtime' || p.phase === 'downloading' || p.phase === 'runtime-wait') {
            AI_DL.set(p.id, {
                done: p.done || 0, total: p.total || 0,
                pct: p.pct || 0, phase: p.phase,
            });
            aiRenderModels();
            aiRenderRuntimeRow();
            return;
        }
        // 收尾：清掉进度状态再刷新（刷新会拿到最新的 downloaded 标记）
        AI_DL.delete(p.id);
        const isRuntime = p.id === '__runtime__';
        if (p.phase === 'done') {
            toast(isRuntime ? '运行库下载完成' : '模型下载完成');
            aiRefresh();
        } else if (p.phase === 'canceled') {
            toast('已取消下载');
            aiRefresh();
        } else {
            toast((isRuntime ? '运行库下载失败：' : '下载失败：') + (p.msg || '未知原因'));
            aiRefresh();
        }
    });
}

/** 运行库那一行的进度显示（r80p）。
 *
 *  有下载在进行 → 进度条取代按钮；否则按"缺不缺"决定显示按钮还是整行隐藏。 */
function aiRenderRuntimeRow() {
    const row = $('aiRuntimeRow');
    const btns = $('aiRuntimeBtns');
    if (!row || !btns) return;
    const dl = AI_DL.get('__runtime__');
    if (dl) {
        row.hidden = false;
        const waiting = dl.phase === 'runtime-wait';
        const label = waiting
            ? '（另一个下载正在下运行库，等它完成）'
            : '正在下载运行库';
        btns.innerHTML = '<div style="flex:1">'
            + '<div class="ai-dl"><i style="width:' + (dl.pct || 0) + '%"></i></div>'
            + '<div class="ai-dl-t"><span>' + label + '</span>'
            + (waiting ? '' : '<span>' + (dl.pct || 0) + '%</span>'
                + '<span>' + aiSize(dl.done) + ' / ' + aiSize(dl.total) + '</span>')
            + '</div></div>';
        return;
    }
    // 没有进度 → 恢复按钮（行本身显不显示由 aiRender 决定）
    if (!btns.querySelector('#btnAiRuntimeDl')) {
        btns.innerHTML = '<button class="btn primary" id="btnAiRuntimeDl">下载运行库</button>';
        const b = $('btnAiRuntimeDl');
        if (b) b.addEventListener('click', () => aiDownloadRuntime());
    }
}

/* 初始化：拉一次状态（模型列表 / 运行时 / 选中的模型）。
 *
 * ⚠ 开关的**回填**不在这里做 —— `s-aiMatting` 已经进了上面的 `SWITCHES` 表，
 *   那张表统一负责回填初值与写配置。第一版我在这里又自己绑了 change 监听，
 *   结果是双重绑定（探针 2e 抓到配置没同步到 CONF）。 */
function aiInit() {
    aiBindProgress();
    aiToolsInit();
    aiRefresh();
    /* r80i：启动时**自动清一次残留**（用户不必手动点）。
     * 只清"确定是垃圾"的（.part / zip / 旧位置遗留的模型），
     * 当前模型目录里的 .onnx 一个都不碰 —— 所以自动执行是安全的。 */
    invoke('ai_cleanup_stale').then((r) => {
        if (r && r.count > 0) {
            console.log('[启动清理] 清掉', r.count, '项：', r.items);
            aiDirRefresh();
        }
    }).catch(() => { });
}

/** 开关变化后刷新模型列表 —— 由 `SWITCHES` 的绑定逻辑调用。
 *
 *  为什么需要：开关打开后才该显示模型选择区（`aiRender` 依赖 `AI_STATUS.enable`），
 *  而 `AI_STATUS` 是后端状态、不随 `CONF` 自动更新，所以要主动拉一次。 */
async function aiOnSwitchChanged() {
    await aiRefresh();
    // 模型下拉框要用最新的 AI_STATUS（哪个已下载 / 当前是哪个）
    aiCutFillModels();
}

/* ══════════════════════════════════════════════════════════════════════════
 * r80g：模型存放位置 + 独立抠图工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** 拉取并显示模型目录信息。 */
async function aiDirRefresh() {
    let info = null;
    try { info = await invoke('ai_model_dir_info'); } catch (e) { }
    if (!info) return;
    const pathEl = $('aiDirPath');
    const modeEl = $('aiDirMode');
    const resetBtn = $('btnAiDirReset');
    if (pathEl) pathEl.textContent = info.dir || '（未知）';
    if (modeEl) {
        modeEl.textContent = info.custom ? '已自定义' : '默认位置';
    }
    // 只有自定义过才显示「恢复默认」（默认状态下这个按钮点了也没意义）
    if (resetBtn) resetBtn.hidden = !info.custom;
    /* 目录不存在时给一句提示 —— 用户可能刚改到一个被删掉的路径，
     * 那时"已下载"全变成"未下载"，不说清楚会以为是程序出错了。 */
    if (pathEl && info.exists === false) {
        pathEl.textContent = (info.dir || '') + '（目录还不存在，下载模型时会自动创建）';
    }
}

/** 绑定模型目录那三个按钮。 */
function aiDirBind() {
    const open = $('btnAiDirOpen');
    if (open) {
        open.addEventListener('click', async () => {
            try { await invoke('ai_model_dir_open'); }
            catch (e) { toast('打开目录失败：' + ((e && e.message) || e)); }
        });
    }
    const pick = $('btnAiDirPick');
    if (pick) {
        pick.addEventListener('click', async () => {
            pick.disabled = true;
            try {
                const r = await invoke('ai_model_dir_pick');
                if (r && r.cancel) return;          // 用户取消，不当失败
                if (r && r.ok) {
                    const msg = r.moved > 0
                        ? `已迁移 ${r.moved} 个模型`
                        : '目录已切换（当前没有模型要迁移）';
                    toast(msg);
                    if (r.failed && r.failed.length) {
                        toast('有 ' + r.failed.length + ' 个模型迁移失败：' + r.failed.join('；'));
                    }
                }
            } catch (e) {
                toast('更换目录失败：' + ((e && e.message) || e));
            } finally {
                pick.disabled = false;
                await aiDirRefresh();
                await aiRefresh();       // 模型就绪状态要跟着更新
            }
        });
    }
    const reset = $('btnAiDirReset');
    if (reset) {
        reset.addEventListener('click', async () => {
            reset.disabled = true;
            try {
                const r = await invoke('ai_model_dir_reset');
                if (r && r.ok) {
                    toast(r.moved > 0 ? `已迁回默认位置（${r.moved} 个模型）` : '已恢复默认位置');
                }
            } catch (e) {
                toast('恢复默认失败：' + ((e && e.message) || e));
            } finally {
                reset.disabled = false;
                await aiDirRefresh();
                await aiRefresh();
            }
        });
    }
    /* r80i：清理残留。用户要求「原来的版本的好像还在一开始下载的位置，
     * 需要你做进一步的清除」—— 除了换位置时自动迁移，还要能主动清一次，
     * 因为残留的来源不止一个：半截的 .part、下运行库的 zip、
     * 以及 r80g 改默认位置之前下到数据目录的模型。 */
    const clean = $('btnAiCleanup');
    if (clean) {
        clean.addEventListener('click', async () => {
            clean.disabled = true;
            try {
                const r = await invoke('ai_cleanup_stale');
                if (r && r.ok) {
                    if (r.count > 0) {
                        toast(`清掉了 ${r.count} 项，释放 ${r.sizeText}`);
                        /* 把删了什么写进日志区的思路不适合这里（太长），
                         * 但至少让用户能在控制台看到具体路径。 */
                        try { console.log('[清理残留] 删除了：', r.items); } catch (e) { }
                    } else {
                        toast('没有需要清理的残留');
                    }
                }
            } catch (e) {
                toast('清理失败：' + ((e && e.message) || e));
            } finally {
                clean.disabled = false;
                await aiDirRefresh();
                await aiRefresh();
            }
        });
    }
}

/* ══ 独立抠图工具 ══ */

/** 上次抠好的结果（data URL）与文件名，给「保存结果」用。 */
let AI_CUT = { src: '', name: '' };

/** 把可选模型填进下拉框（含"未下载"标记，避免用户选了却跑不了）。 */
function aiCutFillModels() {
    const sel = $('aiCutModel');
    if (!sel || !AI_STATUS) return;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const m of AI_STATUS.models || []) {
        const o = document.createElement('option');
        o.value = m.id;
        // 已下载的标出来；没下的也允许选（用户可能先去下载）
        o.textContent = m.name + (m.downloaded ? '' : '（未下载）');
        sel.appendChild(o);
    }
    // 默认选当前生效的那个
    sel.value = prev || AI_STATUS.current;
    if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
}

/** 绑定抠图工具。 */
function aiCutBind() {
    const pick = $('btnAiCutout');
    if (pick) {
        pick.addEventListener('click', async () => {
            pick.disabled = true;
            const old = pick.textContent;
            pick.innerHTML = '<span class="spinner"></span>抠图中';
            try {
                const modelId = $('aiCutModel') ? $('aiCutModel').value : '';
                const r = await invoke('ai_cutout_pick', { params: null, modelId: modelId || null });
                if (r && r.cancel) return;
                if (!r || !r.src) throw new Error('后端没返回结果');
                AI_CUT = { src: r.src, name: r.name || 'cutout.png' };
                const img = $('aiCutImg');
                const box = $('aiCutPrev');
                if (img) img.src = r.src;
                if (box) box.hidden = false;
                const saveBtn = $('btnAiCutoutSave');
                if (saveBtn) saveBtn.disabled = false;
                const meta = $('aiCutMeta');
                if (meta) {
                    meta.textContent =
                        (r.name || '') + ' · 抠掉 ' + (Number(r.removed) || 0).toLocaleString() + ' 个背景像素'
                        + (r.elapsedMs ? ' · 用时 ' + r.elapsedMs + ' ms' : '')
                        + (r.noBackground ? ' · ⚠ 没认出主体（换一个模型或换张图试试）' : '');
                }
            } catch (e) {
                toast('抠图失败：' + ((e && e.message) || e));
            } finally {
                pick.disabled = false;
                pick.textContent = old;
            }
        });
    }
    const save = $('btnAiCutoutSave');
    if (save) {
        save.addEventListener('click', async () => {
            if (!AI_CUT.src) { toast('还没有可保存的抠图结果'); return; }
            save.disabled = true;
            try {
                // 默认文件名：原名去掉扩展名 + `-抠图`
                const stem = (AI_CUT.name || 'cutout').replace(/\.[^.]+$/, '');
                const r = await invoke('ai_cutout_save', {
                    src: AI_CUT.src,
                    suggested: stem + '-抠图.png',
                });
                if (r && r.cancel) return;
                if (r && r.ok) toast('已保存到 ' + r.path);
            } catch (e) {
                toast('保存失败：' + ((e && e.message) || e));
            } finally {
                save.disabled = false;
            }
        });
    }
}

/** 初始化这一整块（在 aiRefresh 之后调，因为下拉框要用 AI_STATUS）。 */
function aiToolsInit() {
    aiDirBind();
    aiCutBind();
    aiDirRefresh();
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/* 首帧一画完就通知 Rust 把（隐藏建出来的）设置窗口显示出来。
 *  为什么隐藏建窗：见 Rust 侧 open_settings_win 的注释 —— 主要是不让用户先看到
 *  WebView2 还没渲染时那块原生黑底。双重 rAF 保证这一帧真的提交上屏了再 show。 */
requestAnimationFrame(() => requestAnimationFrame(() => {
    invoke('settings_ready').catch(() => {});
}));

/* ==========================================================================
 *  v1.5.13：启动密码
 *
 *  用户要求：「在设置中新增可选的启动密码选项，关闭时不影响正常使用；开启后
 *  启动软件必须先输入正确的启动密码才能使用其功能。该启动密码为独立密码，
 *  与备份密码互不相同、互不影响。」
 *
 *  三条约定（都和"独立"有关）：
 *    · 写的键是 `startupPassword`，与备份密码 `backupPassword` **毫无关系** ——
 *      后端也是两个字段、两套校验，改一个不会碰另一个；
 *    · 后端只存 Argon2id 哈希，前端拿不到哈希（config_view 只报
 *      `startupPasswordSet` 这个布尔）；
 *    · **下次启动生效**。当前这次会话已经解锁了，改密码不该把人踢回锁屏。
 * ========================================================================== */
function startupPwdSay(msg, kind) {
    const el = $('startupPwdStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'upd-token-status' + (kind ? ' ' + kind : '');
}

/** 显隐「设置密码」那一行：开关开着才显示。 */
function startupPwdSyncRow() {
    const sw = $('s-startupPwd');
    const row = $('rowStartupPwd');
    if (!sw || !row) return;
    row.hidden = !sw.checked;
    /* 收起来的时候顺手清空：半截密码没有留在 DOM 里的理由，而且下次展开
     * 看到旧内容容易误以为"已经填过了"。 */
    if (row.hidden) startupPwdClear();
}

/** 清空两个密码框（保存成功 / 关掉开关 / 回填时都要做）。 */
function startupPwdClear() {
    const a = $('s-startupPwdVal');
    const b = $('s-startupPwdVal2');
    if (a) a.value = '';
    if (b) b.value = '';
}

/** 「关闭启动密码」那一行：只在"验证当前密码"这一步进行中才显示。 */
function startupPwdOffShow(on) {
    const row = $('rowStartupPwdOff');
    if (!row) return;
    row.hidden = !on;
    if (!on) {
        const inp = $('s-startupPwdOff');
        if (inp) inp.value = '';
        startupPwdOffSay('');
    }
}

function startupPwdOffSay(msg, kind) {
    const el = $('startupPwdOffStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'upd-token-status' + (kind ? ' ' + kind : '');
}

function bindStartupPassword() {
    const sw = $('s-startupPwd');
    const row = $('rowStartupPwd');
    const inp = $('s-startupPwdVal');
    const inp2 = $('s-startupPwdVal2');
    const btn = $('btnStartupPwdSave');
    if (!sw || !row || !inp || !btn) return;

    /* 「关闭要先验密码」那一组控件（v1.5.14）。和上面那组分开，是因为它们的
     * 语义是"确认是你"，不是"设新密码" —— 混在一起用户会以为在改密码。 */
    const offRow = $('rowStartupPwdOff');
    const offInp = $('s-startupPwdOff');
    const offBtn = $('btnStartupPwdOff');
    const offCancel = $('btnStartupPwdOffCancel');
    /* 正在验证关闭 的这段窗口里，别让配置广播把开关又拨回去。 */
    const offPending = () => !!(offRow && !offRow.hidden);

    /* 回填：以后端广播来的 `startupPasswordSet` 为准。
     * ⚠ 正在这几个输入框里打字时别动它（广播 600ms 就可能来一次，会清掉输入）。 */
    if (!offPending()
        && !inp.matches(':focus')
        && !(inp2 && inp2.matches(':focus'))
        && !(offInp && offInp.matches(':focus'))) {
        sw.checked = !!CONF.startupPasswordSet;
        startupPwdSyncRow();
        if (!sw.dataset.bound) startupPwdClear();
    }

    if (!sw.dataset.bound) {
        sw.dataset.bound = '1';
        sw.addEventListener('change', () => {
            startupPwdSyncRow();
            if (sw.checked) {
                startupPwdOffShow(false);
                startupPwdSay('两遍输同样的密码，再点「保存密码」；不保存就还是原来的状态', 'warn');
                setTimeout(() => inp.focus(), 30);
                return;
            }
            /* 关掉 ≠ 立刻卸掉保护：**要先输一次当前密码**
             * （用户要求「要取消密码，必须要再输一次解锁密码」）。
             * 只在"本来就没设过密码"（刚才把开关打开又关掉）时才直接收起来。 */
            if (!CONF.startupPasswordSet) {
                startupPwdClear();
                startupPwdSay('');
                return;
            }
            startupPwdOffShow(true);
            startupPwdOffSay('要关闭启动密码，请先输入当前密码', 'warn');
            setTimeout(() => { if (offInp) offInp.focus(); }, 30);
        });

        btn.addEventListener('click', () => {
            const v = inp.value;
            /* 没有第二个框的极老页面缓存：退化成单框行为，但这不是正常路径 —— */
            const v2 = inp2 ? inp2.value : v;
            if (!v.trim()) {
                startupPwdSay('密码不能为空 —— 要关闭这项功能，请把上面的开关关掉', 'warn');
                inp.focus();
                return;
            }
            /* **两次输入必须一致，否则一个字节都不写**。
             *
             * 这是启动密码唯一的一道防手滑闸：它没有"忘记密码"找回入口，设错了
             * 下次启动就进不来（只能手改 config.json 删掉那行哈希）。单框时代
             * 打错一个字母就把自己锁在门外，正是用户报的那个问题。 */
            if (v !== v2) {
                startupPwdSay('两次输入的密码不一致，请重新输入（第二个框已清空）', 'err');
                if (inp2) {
                    inp2.value = '';
                    inp2.focus();
                }
                return;
            }
            btn.disabled = true;
            invoke('set_setting', { key: 'startupPassword', value: v })
                .then(() => {
                    CONF.startupPasswordSet = true;
                    // 密码落盘之后就把它从输入框里抹掉：没有理由继续挂在 DOM 上
                    startupPwdClear();
                    startupPwdSay('已保存。下次启动时生效（当前这次不用重新输）', 'ok');
                })
                .catch((e) => startupPwdSay('保存失败：' + e, 'err'))
                .then(() => { btn.disabled = false; });
        });

        // 回车 = 保存（第一行打完直接回车也能提交，不用先把鼠标挪到按钮上）
        const enterSave = (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (!btn.disabled) btn.click();
        };
        inp.addEventListener('keydown', enterSave);
        if (inp2) inp2.addEventListener('keydown', enterSave);

        /* 一动手打字就把上次的红字清掉 —— 否则"两次不一致"会一直挂在那儿，
         * 看起来像这次也错了。 */
        const clearErr = () => {
            const el = $('startupPwdStatus');
            if (el && el.className.indexOf('err') >= 0) startupPwdSay('');
        };
        inp.addEventListener('input', clearErr);
        if (inp2) inp2.addEventListener('input', clearErr);

        /* ---- 「关闭启动密码」：验过当前密码才真的清哈希 ---- */
        if (offBtn && offInp) {
            const closeIt = () => {
                const v = offInp.value;
                if (!v) {
                    startupPwdOffSay('请输入当前启动密码', 'warn');
                    offInp.focus();
                    return;
                }
                offBtn.disabled = true;
                /* 走后端 `startup_password_disable`：**验和清是一件事**。
                 * 前端只发一次请求，验不过后端什么都不改 —— 开关弹回去，
                 * 保护一点没动。 */
                invoke('startup_password_disable', { password: v })
                    .then((ok) => {
                        if (!ok) {
                            offInp.value = '';
                            offInp.focus();
                            startupPwdOffSay('密码不对，启动密码没有被关闭', 'err');
                            return;
                        }
                        CONF.startupPasswordSet = false;
                        sw.checked = false;
                        startupPwdOffShow(false);
                        startupPwdSyncRow();
                        startupPwdClear();
                        startupPwdSay('已关闭启动密码（下次启动不再询问）', 'ok');
                    })
                    .catch((e) => startupPwdOffSay('关闭失败：' + e, 'err'))
                    .then(() => { offBtn.disabled = false; });
            };
            offBtn.addEventListener('click', closeIt);
            offInp.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (!offBtn.disabled) closeIt();
            });
        }
        if (offCancel) {
            offCancel.addEventListener('click', () => {
                /* 取消 = 什么都没发生：开关弹回打开，保护照旧。 */
                startupPwdOffShow(false);
                sw.checked = !!CONF.startupPasswordSet;
                startupPwdSyncRow();
                startupPwdSay('');
            });
        }
    }
}

(async function boot() {
    bindTabs();

    CATALOG = await fetch('data/engines.json').then((r) => r.json());
    for (const e of CATALOG.toolbar) BY_NAME.set(e.name, e);
    for (const c of CATALOG.categories) {
        for (const e of c.engines) if (!BY_NAME.has(e.name)) BY_NAME.set(e.name, e);
    }
    /* r74：旧 renderEngineLib（r51/r52 那套 #libToc/#libBody 三层库）连同它的
     * 两个前置版本一起删了 —— 那两个 DOM 节点在 r61 合并卡片时就不存在了，
     * 函数开头 `if (!toc || !body) return` 让整套代码一次都没跑过。引擎库现在
     * 只有 renderAllList 一条路（见上面 r73 那段）。 */

    CONF = window.CONF = await invoke('get_config');
    $('ver').textContent = 'v' + (CONF.version || '—');
    fillAbout();
    // 调试构建才打开自动化辅助（坐标上报等）
    if (CONF.debug) document.body.dataset.qsDebug = '1';

    // 内建自检：QS_SELFTEST=1 时把真实控件的自检跑一遍（只用于开发验证）
    if (CONF.selftest) setTimeout(() => { qsSelfTest().catch((e) => console.warn(e)); }, 300);
    // 用户自己的引擎必须在第一次渲染前并进目录，否则它不出现在
    // 「全部引擎」里，也就没法加到横条上。
    qsMergeCustomEngines(CATALOG, BY_NAME, CONF);

    renderBarList();
    renderAllList();
    renderCustomList();
    renderAppList();
    renderAiList();
    syncOcrInBarBtn();
    /* r54：识图搜索那一栏 + 数据那一栏从后端拿清单（界面不自己维护）。
     * ⚠ 这两个是**后台跑**、不拦在 bindSwitches 前面：boot 剩下的都是同步渲染，
     *    一拦就把"控件按配置摆好"整个推迟到两次 IPC 之后。实测（r44 探针）
     *    就是这个顺序让「空格=智能」那一档在窗口刚出来时还没摆上 ——
     *    用户看到的是"设置刚打开时几个开关是空的，过一下才对"。
     *    所以：先起动（fire and forget），bindSwitches 照老顺序跑，
     *    清单回来后 renderImgEngines / renderExportBox 自己会把内容填上。 */
    const imgListReady = loadImgEngines();
    bindDataTab();
    const exportReady = loadExportGroups();
    // 本地 OCR 环境检测：设置窗一打开先跑一次（用户要求「进入页面 / 初始化 OCR
    // 时自动检测」）——缺组件时用户在 OCR 页第一眼就能看到，不用先点「测试」。
    bindOcrDep();
    renderOcrDep();
    bindSwitches();
    // v1.5.13：启动密码的回填（开关状态 / 输入行显隐）。事件只绑一次。
    bindStartupPassword();
    bindCeKind();
    bindCeBind();   // r58：快捷键引擎「绑定应用」的联动（开关 → 选应用 → 管理员）
    bindApKind();
    // r76：AI 识图延迟那一行的「↺ 默认」钮
    bindAiDelayReset();
    // 上面那两份清单回来后补一次渲染（引擎行上的图标要等清单才知道有几家）
    await imgListReady;
    renderImgEngines();
    await exportReady;

    document.addEventListener('contextmenu', (e) => e.preventDefault());

    /* r75：回到顶部浮动钮。放在最后装 —— 它只是长页面的辅助入口，不能挡在
     * 配置读回来、控件按配置摆好这些正事前面。 */
    toTopBuild();
    toTopStackSync();
    toTopSync();

    // 自动化测试用的坐标上报：把关键控件的视口 rect 打一份到日志。
    // 只在调试构建（QS_DEBUG=1，由后端在启动时把开关塞进 body.dataset）时跑，
    // 正式使用不受任何影响；对用户来说这条路永不执行。
    if (document.body.dataset.qsDebug === '1') reportRects();




    // r80：AI 抠图（开关回填 + 状态查询 + 模型列表）
    aiInit();
})();