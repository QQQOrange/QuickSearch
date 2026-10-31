/* ============================================================
   Quick Search 桌面版 —— 横条前端逻辑
   ------------------------------------------------------------
   Rust 侧负责：全局鼠标钩子、抓选区、算位置、显示/隐藏窗口
   本文件负责：把引擎渲染成按钮、把窗口尺寸回报给 Rust、
              处理点击（搜索 / 换图标 / 展开面板 / 关闭）
   ============================================================ */

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

/* 任何前端异常都写进日志，别让 bug 静默消失 */
window.addEventListener('error', (e) => {
    try { invoke('log_msg', { msg: `JS ERROR: ${e.message} @${e.lineno}:${e.colno}` }); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
    try {
        invoke('log_msg', { msg: `JS UNHANDLED: ${(e.reason && e.reason.message) || e.reason}` });
    } catch (_) {}
});

/* 这几个引擎的图标是纯黑剪影，深色底上要反白 */
const MONO_BRAND = new Set(['Twitter', 'GitHub', 'Threads', '维基百科']);

const LETTER_COLORS = [
    '#4E6EF2', '#E8500F', '#0FA36B', '#B0182A', '#7A5AF8',
    '#0E7C86', '#C2410C', '#2563EB', '#9333EA', '#0F766E'
];

const $ = (id) => document.getElementById(id);

const stage = $('stage');
const barEl = $('bar');
const enginesEl = $('engines');
const panelEl = $('panel');
const panelBody = $('panelBody');
const tipEl = $('tip');
// 注：原来的 #sepTail（引擎区右侧那条自动竖线）已按用户要求删除，
// 这个 DOM 元素连同它的 id 一起没了，详见 index.html 里的注释。
const btnLink = $('btnLink');
const btnMore = $('btnMore');
const btnOcr = $('btnOcr');
// r54：识图搜索入口（与 btnLink 同一套显隐口径 —— 取到内容之后再决定）
const btnImg = $('btnImg');
// r54 需求 2：划词是本地路径时才出现的文件管理器图标
const btnPath = $('btnPath');
// r97：划词是本地**文件**路径时才出现的「用默认程序打开」
const btnOpenFile = $('btnOpenFile');

/** 本次横条是不是「只有识别图片文字」这一种形态（Ctrl+C 复制到图片时用）。
 *  这时候不显示引擎：用户手上根本没有文字可以搜，摆一排搜索引擎只会误导。 */
let ocrOnly = false;
const btnPanelClose = $('btnPanelClose');
const inputQ = $('q');
const menuEl = $('menu');
/* 包裹符号菜单（#wrapMenu）。放在这里而不是跟包裹那一段的其它变量一起声明，
 * 是因为 `pushLayout()`（在上面很远的地方定义）要拿它算窗口包围盒 ——
 * 它每次被调用都可能早于包裹那段的 `const` 求值，那时引用就是 TDZ 报错。 */
const wrapMenuEl = $('wrapMenu');
/* 引擎搜索框（面板头部，在「关键词」框右边）。
 * ⚠ 它是 index.html 里的**常驻节点**，不在 renderPanel 里新建 —— 面板每次重画
 *   （改设置、主题广播、切换分类…）都重建元素的话，光标和已输入的过滤词全丢。 */
const inputEngFilter = $('engFilter');

let CATALOG = null;        // data/engines.json
let CONF = null;           // Rust 侧配置
let ENGINE_BY_NAME = new Map();
/** 名字 → 别名数组（**全表合并**）。和 ENGINE_BY_NAME 是两张表，别合并成一个：
 *  ENGINE_BY_NAME 是"先注册先得"的**单条**记录（toolbar 先注册，所以同名的
 *  toolbar 条目会遮掉分类表里那份完整的），而别名必须把所有来源累加。
 *  详见 buildAliasIndex 的注释。 */
let ENGINE_ALIASES = new Map();
let currentText = '';      // 当前选区文本
let currentIsUrl = false;
/** 本次选中文字里的**全部**链接（后端 `qs://show` / `qs://text` 的 urls）。
 *  > 1 条时点 🔗 就分别开成多个标签页（用户要求）。 */
let currentUrls = [];
let renderedSignature = '';// 用来判断要不要重建 DOM
let menuOwner = null;      // 右键菜单作用对象

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function hashColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return LETTER_COLORS[Math.abs(h) % LETTER_COLORS.length];
}

function firstGlyph(name) {
    const m = name.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
    return m ? m[0].toUpperCase() : '?';
}

/** 「统一图标大小」总开关（设置里可关）。默认开。 */
function unifyIcons() {
    return !CONF || CONF.unifyIcons !== false;
}

/** 造一个「图标内容」节点：自定义图 → 内置图标 → 字母兜底。
 *  「图标风格」选项已撤（用户要求）：有图标就用图标，没有就用字母徽标，
 *  这是唯一逻辑，不再给「一律字母」的开关。 */
function buildIconInner(engineName) {
    const eng = ENGINE_BY_NAME.get(engineName) || {};
    const custom = CONF && CONF.overrideIcons ? CONF.overrideIcons[engineName] : null;

    if (custom) {
        const img = document.createElement('img');
        img.src = custom;
        img.alt = '';
        // 带透明留白的图标会被自动放大到和铺满型图标一样大
        qsApplyOpticalScale(img, unifyIcons());
        return { node: img, mono: false, inset: 1 };
    }
    /* #138：icons 目录里「文件名 = 引擎名」的默认图标，优先级夹在
     * 「图库显式挑的」和「引擎自带 iconFile」之间。用户把一张 Baidu.png
     * 丢进那个目录，百度的格子就该用它 —— 不需要每个引擎再挑一次。 */
    const dir = window.qsDirIconFor ? window.qsDirIconFor(engineName) : null;
    if (dir) {
        const img = document.createElement('img');
        img.src = dir;
        img.alt = '';
        img.draggable = false;
        qsApplyOpticalScale(img, unifyIcons());
        return { node: img, mono: MONO_BRAND.has(engineName), inset: 1 };
    }
    if (eng.iconFile) {
        const img = document.createElement('img');
        img.src = 'data/icons/' + eng.iconFile;
        img.alt = '';
        img.draggable = false;
        /* r51 速度：面板一次要建 700 多个格子（每个一张图标），解码放到别的线程上，
         * 别在主线程上排队 —— 用户报的"更多引擎页面打开慢"有一段就在这儿。 */
        img.decoding = 'async';
        qsApplyOpticalScale(img, unifyIcons());
        return { node: img, mono: MONO_BRAND.has(engineName), inset: eng.inset || 1 };
    }
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = firstGlyph(engineName);
    span.style.setProperty('--lt-color', hashColor(engineName));
    return { node: span, mono: false, inset: 1 };
}

/** 横条上 OCR 按钮的内容节点。
 *
 *  默认是一枚「OCR」文字徽标；用户换过图标就显示那张图。
 *  横条上**两个**可能的 OCR 位置（bar_list 里的那个、以及右侧固定那个）
 *  都用它，换图标之后两处一起变，不会一个变了另一个还是老样子。 */
function ocrIconNode() {
    const custom = CONF && CONF.overrideIcons ? CONF.overrideIcons[QS_OCR] : null;
    if (custom) {
        const img = document.createElement('img');
        img.src = custom;
        img.alt = '';
        img.draggable = false;
        qsApplyOpticalScale(img, unifyIcons());
        return img;
    }
    const span = document.createElement('span');
    span.className = 'qs-ocr-tag';
    span.textContent = 'OCR';
    return span;
}

/** 横条上翻译按钮的内容节点。
 *
 *  v1.5.16：和 ocrIconNode 同一套规矩 —— 用户换过图标（overrideIcons['@trans']）
 *  就显示那张图，没换就是一枚「译」文字徽标。一个字而不是「翻译」两个字：
 *  横条图标只有 ~28px，「翻译」两个字缩进去会糊成一团。
 *  v1.5.17：默认徽标换成用户指定的「翻译.png」（v1.5.19 起已 base64 内嵌，不读外部文件），
 *  实现挪到 shared.js 的 qsTransIconNode —— 设置页列表 / 预览也走同一个函数，
 *  三处才不会一个图一个样。图读不出来时它自己退回「译」字。 */
function transIconNode() {
    return window.qsTransIconNode();
}

/* ------------------------------------------------------------------ */
/* 收藏夹（横条上的 @fav:<id> 哨兵）                                     */
/* ------------------------------------------------------------------ */

/** 当前配置里的收藏树（一级目录数组）。没配过就是空数组。 */
function favGroups() {
    return qsFavGroups();
}

/** 靠哨兵名（@fav:<id>）找到对应的目录 —— 一级、二级都翻。
 *  用户要求两级目录都能放进横条，所以这里不能只查顶层。 */
function favGroupBySentinel(name) {
    if (typeof name !== 'string' || !name.startsWith(QS_FAV_PREFIX)) return null;
    return qsFavFindGroup(name.slice(QS_FAV_PREFIX.length));
}

/** 收藏目录在横条上的图标 —— 直接走 shared.js 的共用实现，
 *  保证横条 / 设置预览 / 设置列表三处**长得一模一样**
 *  （用户报过"预览里的图标和横条实际不一致"）。 */
function favIconNode(sentinel) {
    return qsFavIconNode(sentinel);
}

/** 外部软件在横条上的图标 —— 走 shared.js 的共用实现，
 *  和设置页列表、设置页预览里那一格长得一模一样。 */
function appIconNode(sentinel) {
    return qsAppIconNode(sentinel);
}

/** 当前面板显示的是不是收藏夹：null = 引擎面板；'root' = 收藏夹根；'@fav:<id>' = 某目录。
 *  ⚠ 必须走这个状态而不是"先填 DOM 再 togglePanel"—— togglePanel(true) 会调
 *  renderPanel() 把 panelBody 整个重画，先填的内容会被抹掉（踩过）。 */
let panelFav = null;
/** 收藏面板是不是从「更多引擎」面板里点进来的（#141）。
 *
 *  是 → 点「收起」回到引擎面板（用户刚从那儿来，还没看够）；
 *  否（快捷键唤起、横条收藏按钮点开）→ 照旧整个收起。
 *  两个入口必须分清，不然「更多引擎 → 收藏夹 → 收起」会把面板连锅端，
 *  用户得重新点 ⋯ 再筛一遍大类（本轮反馈原话）。 */
let favFromEngines = false;
/** 最近一份 `qs://theme` 载荷（#139：打开面板时幂等重放，保证更多引擎页 /
 *  收藏夹页永远跟着当前主题，不依赖"事件恰好在上一次弹出时到达"）。 */
let lastThemePayload = null;
/** 横条下沿到工作区下沿还剩多少 CSS px（Rust 每次摆位后告诉前端）。
 *
 *  收藏面板的高度上限按它算 —— 按屏幕百分比算的话，横条靠屏幕下方时
 *  面板放不下，Rust 只能把整条横条往上挪（用户报的「一点收藏夹横条就跑到别处」）。 */
let barRoomBelow = 0;
/** 本次横条是不是「取词语境」（Ctrl+C / 拖选）叫出来的 —— 决定收藏条目点下去去哪儿。 */
let viaCopy = false;
/** 上一次 `qs://show` 的触发指纹（见 qs://show 里的 sameTrigger）。 */
let lastShowSig = null;

/* ---------------- 横条的「按应用专项」 ---------------- */
/** 本次唤起命中的横条专项内容（引擎名 / 哨兵名）；null = 用默认 `bar_list`。
 *
 *  后端在 `qs://show` 里带 `bar` 段（见 Rust `config::resolve_bar`）：
 *  `source === 'app'` 才算命中，`'default'` 表示"没配 / 配了但回退"。
 *  这里刻意**只在命中时覆盖** —— 三种回退情形（没配、配置被清空、校验失败）
 *  在后端已经统一成了同一份默认内容，前端不需要再分辨，展示结果必然一致。 */
let barOverride = null;
/** 这次 `bar` 段的原样副本（`source` / `matched` / `note`），排障用。 */
let barOverrideInfo = null;
/** 横条此刻是不是「弹出着」。
 *
 *  窗口本身是 Rust 显隐的，页面一直活着 —— 前端只能靠事件推：
 *  qs://show = 弹出来了，qs://hidden = 收起来了。
 *  只有**隐藏→弹出**的跳变才重放入场动画：同一次触发里
 *  qs://show 会来好几条（鼠标动一下就再 show 一条，实测一次运行 6 次），
 *  次次重放只会让横条一闪一闪。 */
let barVisible = false;
/** 鼠标此刻是不是压在横条上（mouseenter/mouseleave 维护，别用 :hover 猜）。
 *
 *  待机淡度靠它和面板状态决定：面板开着、或鼠标在横条上 → 全不透明；
 *  两者都没有 → 弹出一个淡淡的横条（就是不透明的那层在等用户过来）。 */
let barHovered = false;

/* ------------------- 横条「无操作自动收起」 -------------------
 * 用户 2026-10-23 原话：「还要给横条有一个时间逻辑，比如说横条出来了 5 秒，
 * 但 5 秒没有任何的操作，那么就消失，这个时间逻辑在设置当中可调」。
 *
 * 为什么这条放在前端而不是和后端那个"鼠标走远"放在一起：**"有没有操作"只有
 * 页面知道** —— 指针移进横条、点击、滚轮、按键、在搜索框里打字，全在页面里。
 * 后端只管"指针离得够远了"（那条要全局坐标，页面收不到）。
 *
 * 三条不算"没操作"的例外，缺一条都会被骂：
 *   · 指针正搁在横条上（哪怕一动不动）—— 人家正指着要点的按钮；
 *   · 「更多引擎」面板开着 —— 那是正在翻目录；
 *   · 右键菜单开着 —— 同上。
 */
let idleTimer = 0;

/** 配置里的秒数 → 毫秒。0 / 未设置 = 关掉这条。 */
function idleMs() {
    const s = Number(CONF && CONF.barIdleSec);
    return (Number.isFinite(s) && s > 0) ? Math.round(s * 1000) : 0;
}

/** （重新）开始计时。不满足条件就只清掉旧计时器。 */
function armIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    if (!barVisible) return;
    if (!panelEl.hidden) return;
    if (!menuEl.hidden) return;
    const ms = idleMs();
    if (!ms) return;
    idleTimer = setTimeout(onIdleFire, ms);
}

function onIdleFire() {
    idleTimer = 0;
    if (!barVisible) return;
    if (!panelEl.hidden || !menuEl.hidden) return;
    if (barHovered || barEl.matches(':hover')) {
        // 指针就在横条上（只是没动）—— 再等一轮，别把人正要点的东西收走
        armIdle();
        return;
    }
    invoke('log_msg', {
        msg: 'idle: 横条 ' + Math.round(idleMs() / 1000) + ' 秒没有任何操作，自动收起',
    }).catch(() => {});
    invoke('hide_bar').catch(() => {});
}

/* 任何一点操作都重新计时。capture 阶段、passive —— 只是"记一笔"，不拦事件。 */
for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'input']) {
    document.addEventListener(ev, () => { if (idleTimer) armIdle(); },
        { passive: true, capture: true });
}


/** 横条待机淡度的唯一落点（v1.5.21：改成「延迟渐隐」）。
 *
 *  行为：横条弹出后先按 --qs-alpha 全不透明显示，过了 barDimDelayMs 才平滑
 *  淡到 --qs-dim-alpha。
 *  旧实现是登场那一帧就挂 qs-dim + qs-dim-noanim —— 于是「一出现就是半透明的」，
 *  正是用户报的问题。现在「何时开始淡」由 barDimDelayMs 决定，0 = 立即淡。
 *
 *  「不该淡」的三种情况：① 指针在横条上；② 面板开着（用户正在里面点东西）；
 *  ③ barDimAlpha = 100（这套机制被关掉）。落到不该淡时立刻撤掉 qs-dim ——
 *  悬停必须马上变亮，不能等延迟。
 */
let dimTimer = 0;
function dimPct() {
    return Math.max(10, Math.min(100, Number(CONF && CONF.barDimAlpha) || 45));
}
function dimAllowed() {
    return panelEl.hidden && !barHovered && dimPct() < 100;
}
function syncDim() {
    if (dimTimer) { clearTimeout(dimTimer); dimTimer = 0; }
    if (!dimAllowed()) { barEl.classList.remove('qs-dim'); return; }
    /* 已经淡着就保持 —— 面板开合 / 布局重排会重复调 syncDim，
     * 每次都"先亮一下再重新计时"会闪。 */
    if (barEl.classList.contains('qs-dim')) return;
    const ms = Math.max(0, Math.min(10_000, Number(CONF && CONF.barDimDelayMs)));
    const delay = Number.isFinite(ms) ? ms : 1500;
    if (delay <= 0) { barEl.classList.add('qs-dim'); return; }
    dimTimer = setTimeout(() => {
        dimTimer = 0;
        if (dimAllowed()) barEl.classList.add('qs-dim');
    }, delay);
}
/** 收藏面板是否钉在屏幕上（后端 FAV_PINNED 同步）。 */
let favPinned = false;
/** 拖动收藏面板时累积的**窗口偏移**（CSS px）：面板在内容里不动，整块窗口平移。
 *  面板因此永远在窗口内，窗口由 Rust 按显示器钳制 → 自由拖拽且不出屏。 */
let winOffX = 0, winOffY = 0;
/** 横条左缘往左到工作区左缘还剩多少 CSS px（西向缩放能用多少，见 startFavResize）。 */
let barRoomLeft = 0;
/** 横条左缘往右到工作区右缘还剩多少 CSS px（面板总宽上限，防止被锚点钳制推走）。 */
let barRoomRight = 0;
/** 横条上方到工作区顶还剩多少 CSS px（面板拖动往上走要用的空间）。 */
let barRoomTop = 0;
/** 上一次真正发给 Rust 的布局参数（JSON 串）。一样就不再发 —— 断反馈环，见 pushLayout。 */
let lastLayoutKey = '';

/** 收藏内容指纹（只覆盖「渲染结果会变」的字段）。
 *
 *  用来挡掉与收藏无关的配置广播：那些广播会走到 renderFavPanel，而它会按配置里的
 *  尺寸把面板宽高重算一遍 —— 用户刚拖好的尺寸就被覆盖回旧值（「调整完又变回原样」）。 */
let lastFavSig = '';
/** 当前被**折起来**的收藏目录（按 group id 记）。
 *
 *  二级目录默认展开、点标题行才折（用户要求：「2 级目录照理来说也是可以展开或者
 *  收起来的」）。只做**会话内**记忆：折叠是"随手看一眼"的动作，不落盘 ——
 *  为它往配置里加一个用户看不懂的字段、还要动 set_setting 的白名单，不值当。 */
const favCollapsed = new Set();
/** 折叠/展开会把面板高度改掉，但那属于「内容变了」，不是「用户手动拉的尺寸」——
 *  这段时间里拦住 ResizeObserver 那条落盘逻辑（否则下次打开面板就永远是折起来的
 *  那个高度，用户会以为内容丢了）。 */
let favSizeSaveUntil = 0;
function favContentSig() {
    const parts = [];
    const walk = (g, tag) => {
        parts.push(tag + g.id + '|' + (g.name || ''));
        for (const it of g.items || []) {
            parts.push('i' + it.id + '|' + (it.remark || '') + '|'
                + String(it.text || '').slice(0, 40) + '|' + (it.html ? 1 : 0)
                + '|' + (it.image ? 1 : 0));
        }
        for (const c of g.children || []) walk(c, 'c');
    };
    for (const g of favGroups()) walk(g, 'g');
    return parts.join(';');
}
// panelBody 的 scroll 监听只需挂一次（见 renderPanel 里的注释）
let panelScrollBound = false;
/* 引擎过滤词（面板头部那个搜索框）。
 * 输入框本身是常驻节点、值不会丢；但面板重画时 .cell 会全部重建，
 * 所以要把词记在变量里、重画完再应用一次，否则一重画过滤就"失效"了。 */
let engineFilterText = '';
// 上上一次未正常收尾的收藏面板拖拽的清理钩子（见 startFavResize）
let favResizeCleanup = null;
/* 上一次落盘的磨砂参数（滑块值 + 饱和 + 亮度）。
 * applyLook 每次布局都会跑，值没变就跳过写 CSS 变量 —— 反复重设
 * --qs-blur 会把 backdrop-filter 的合成层标脏、白算一遍模糊。 */
let lastBlurKey = '';

/** 目录名——用户没起名时给个能看的兜底。
 *
 *  新建目录走的是 **placeholder 语义**（树里 name 是空的，输入框里灰着
 *  "新一级目录"，一打字就被顶掉，见 settings.js）。空名字一路上会碰到
 *  「横条图标首字 / 卡片标题 / 面板标题」三处显示，不给兜底就是一片空白。 */
function favDisplayName(g) {
    return ((g && g.name) || '').trim() || '未命名目录';
}

/** 把 `favCollapsed` 这份状态**一次性落到 DOM** 上。
 *
 *  三个入口都走这一条路：面板级的「全部展开 / 全部折叠」、二级目录卡片自己的
 *  「全部展开 / 全部折叠」、以及点标题行折叠。为什么不让它们各自改 class：
 *  各改各的早晚会有一处忘了同步「aria-expanded / 标题提示」，于是出现
 *  "看着是展开的、其实记着是折叠的"这种自相矛盾的状态。统一从 favCollapsed
 *  重算一遍，DOM 永远等于状态。 */
function applyFavCollapsed() {
    for (const el of panelBody.querySelectorAll('.fav-grp[data-named="1"]')) {
        const folded = favCollapsed.has(el.dataset.favId);
        el.classList.toggle('collapsed', folded);
        const h = el.querySelector('.fav-grp-head');
        if (h) {
            h.setAttribute('aria-expanded', folded ? 'false' : 'true');
            h.title = folded ? '展开这个目录' : '收起这个目录';
        }
    }
    // 高度突变 → 窗口要跟着重算；同时别让这次变化被当成"用户拉的尺寸"
    favSizeSaveUntil = Date.now() + 900;
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
}

/** 收藏夹面板：sentinel = '@fav:<id>' 时列那个目录；'root'（快捷键唤起）
 *  就把**所有一级目录**都列出来。点一条内容就输入到触发位置那个软件里
 *  （没有文本框才复制到剪贴板）。 */
function renderFavPanel() {
    const root = panelFav === 'root';
    const groups = root ? favGroups() : [favGroupBySentinel(panelFav)].filter(Boolean);
    // 收藏树读不到（一个目录都没有）→ 退回引擎面板。这里不聚焦引擎搜索框：
    // 用户要的是收藏夹，把光标塞进一个他没在看的输入框只会碍事。
    if (!groups.length) { panelFav = null; renderPanel(); return; }
    panelBody.textContent = '';
    panelEl.classList.add('fav-mode');   // 到这里才确定是收藏面板，样式才挂得上
    // 进收藏面板 = 离开引擎列表：引擎过滤词一并清掉（框在收藏面板里本来就是
    // display:none，清了也看不见）。这样下次点 ⋯ 回到引擎面板是「全部引擎都在」，
    // 不会莫名其妙只剩上次筛出来的那几个。
    if (inputEngFilter) inputEngFilter.value = '';
    engineFilterText = '';

    // ⚠ 收藏面板是**绝对定位**（.panel.fav-mode { position:absolute }）：
    //   左/左下角拖拽要把面板往横条左侧拉，流内布局做不到。
    //   left 对齐横条左缘、top 紧贴横条下方（8 = .stage 的 flex gap）。
    //   这两行必须在量 saved 尺寸之前 —— 否则首帧面板会闪现在 (0,0)。
    const stageBox = stage.getBoundingClientRect();
    const barBox = barEl.getBoundingClientRect();
    /* ⚠ 面板 left 的基准 = **横条的偏移（含 stage 的 padding-left）**，不要再减 padding。
     *
     *   绝对定位元素的包含块是「padding box」，而面板没有边框 —— padding box 的
     *   左缘**就等于** border box 左缘，所以 stage 上那点 padding-left 只把**流内的
     *   横条**往右推，压根不会给面板让出左侧空间。第一版按「padding 会平移包含块」
     *   去算（减掉 padding），结果面板 left 取到负值、被推到窗口左边之外裁掉，
     *   同时把实体宽度撑大、触发 Rust 的锚点钳制 —— 表现就是用户报的
     *   「横条还在原地，窗口却跑到别的地方去了」。
     *   正确关系：横条视口左 = 窗口左 + padding + 24，面板视口左 = 窗口左 + left；
     *   要让面板左缘比横条左缘向左探出 westOv → left = (padding + 24) − westOv。 */
    favBarOff0 = (barBox.left - stageBox.left) - favPad();   // P=0 时的横条内容 x
    /* 位置：**每次都回到默认位置**（贴在横条下面、左缘对齐）。
     * 用户要求：不继承上一次拖动后的位置，最多只继承上一次调整的**大小**。
     * 拖动在本次会话里仍然有效，只是不再落盘、下次打开一律回默认位。 */
    panelEl.style.left = (favBarOff0 + favPad() - westOv) + 'px';
    panelEl.style.top = (barBox.bottom - stageBox.top + 8) + 'px';
    // 纵向上限按**屏幕**算，不按窗口算 —— 窗口此刻还只有横条那么高，
    // vh 一来就把面板掐成半截（详见 bar.css .panel.fav-mode 的注释）。
    //
    // ⚠ 再叠加一层「横条下面还剩多少」的上限（barRoomBelow，Rust 摆位后报过来）：
    //   只按屏幕百分比给上限的话，横条落在屏幕下半部分时面板根本放不下，
    //   Rust 摆位就只能把**整条横条往上挪** —— 用户看到的就是「一点收藏夹，
    //   横条立刻跑到别的地方去了」。按剩余空间收窄（面板内部滚动），横条不动。
    const scrH = (window.screen && screen.availHeight) || 900;
    const capByScreen = Math.round(scrH * 0.78);
    const capByRoom = barRoomBelow > 0 ? Math.max(180, barRoomBelow) : capByScreen;
    panelEl.style.maxHeight = Math.min(capByScreen, capByRoom) + 'px';

    // 用户在横条上手动拉过的大小（仅收藏夹面板记忆，按目录各存各的）。
    // ⚠ 高度门槛 160：vh 反馈环 bug 盛行期间 RO 把「半截」高度（≤150）存进过
    //   配置，照单全收的话坏尺寸会一直阴魂不散（用户报的「弹出很小一块」）。
    const sizeKey = root ? '_root' : panelFav;
    const saved = CONF && CONF.favPanelSizes ? CONF.favPanelSizes[sizeKey] : null;
    if (saved && saved[0] > 160 && saved[1] > 160) {
        panelEl.style.width = saved[0] + 'px';
        panelEl.style.height = saved[1] + 'px';
    } else {
        panelEl.style.removeProperty('width');
        panelEl.style.removeProperty('height');
    }

    const head = document.createElement('div');
    head.className = 'fav-head';
    // 按住头部可拖动整块面板（见 startFavDrag）；光标提示由 CSS 给
    head.title = '按住这里拖动面板';
    head.addEventListener('pointerdown', (e) => startFavDrag(e));
    head.appendChild(Object.assign(document.createElement('b'), {
        textContent: root ? '收藏夹' : favDisplayName(groups[0]),
    }));
    {
        /* 「全部展开 / 全部折叠」—— 设置页放在「添加一级目录」旁边，
         * 横条这边就放在标题栏里。作用范围 = 面板里的**所有**目录卡片
         * （一级 + 二级）。
         *
         * ⚠ 轮 20：**只有目录里确实有二级目录时才显示这两颗按钮**。
         *   用户原话「需要添加一个逻辑，那就是只有当……」—— 完整口径是
         *   「该目录含二级目录时才显示」。
         *   为什么：这两个按钮真正的用途是"一口气摊开/收起所有子目录"。
         *   一个没有子目录的收藏夹，点「全部折叠」等于把整个面板收成一条
         *   光秃秃的标题栏（面板里唯一的那个一级目录被折起来了），
         *   点「全部展开」则什么都不发生 —— 摆在那儿只会让人误操作。
         *   判据按**面板里实际列出的目录**算：root 视图是全部一级目录，
         *   从横条点开时就是那一个。 */
        const hasSub = groups.some(
            (g) => Array.isArray(g && g.children) && g.children.length > 0);
        if (hasSub) {
            const tools = document.createElement('span');
            tools.className = 'fav-head-tools';
            const mk = (text, tip, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'fav-tool';
                b.textContent = text;
                b.title = tip;
                // 头部的 pointerdown 是"按住拖动整块面板"（见 startFavDrag）——
                // 不拦住的话，点按钮会顺便把面板拖走。
                b.addEventListener('pointerdown', (e) => e.stopPropagation());
                b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    fn();
                });
                tools.appendChild(b);
                return b;
            };
            mk('全部展开', '展开所有子目录', () => {
                favCollapsed.clear();
                applyFavCollapsed();
            });
            mk('全部折叠', '折叠所有子目录', () => {
                for (const el of panelBody.querySelectorAll('.fav-grp[data-named="1"]')) {
                    favCollapsed.add(el.dataset.favId);
                }
                applyFavCollapsed();
            });
            head.appendChild(tools);
        }
    }
    {
        // 图钉：钉住之后点面板外面不会被收起（后端 set_fav_pinned 控制）
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'fav-pin' + (favPinned ? ' on' : '');
        pin.textContent = favPinned ? '📌 已钉住' : '📌 钉住';
        pin.title = favPinned ? '取消钉住（钉住时点面板外面不会收起）'
            : '钉在屏幕上：点面板外面也不会收起';
        pin.addEventListener('click', (e) => {
            e.stopPropagation();
            favPinned = !favPinned;
            invoke('set_fav_pinned', { on: favPinned }).catch(() => {});
            // 用户要求：钉住之后**横条自动消失**（屏幕上只留被钉住的面板）。
            // ⚠ 取消钉住时**不**把横条换回来、**不**重排面板位置 ——
            //   用户的口径是：取消钉住后面板留在原地，点窗口外面它就消失。
            //   （以前这里调了 renderFavPanel()，位置被重置回默认位，看起来就是
            //     「一取消钉住就跳回横条刚出现的地方」。）
            // ⚠ 用 class 而不是 hidden：hidden 会把横条的盒子清零，钉住点就废了
            barEl.classList.toggle('ghost', favPinned);
            /* r49（修 bug）：`.ghost` 只藏 DOM 那一层，**玻璃是画在画布上的** ——
             * 不同时告诉玻璃层，画布上就还留着一整条玻璃空壳：用户看到
             * 「横条里的图标全不见了，可横条还在」（2026-10-16 报的）。
             * 这里必须挂/摘 class 的同时调它（两边永远一起动）。 */
            if (window.QSGlass && window.QSGlass.setBarGhost) {
                window.QSGlass.setBarGhost(favPinned);
            }
            pushLayout();
            tipEl.textContent = favPinned ? '已钉在屏幕上' : '已取消钉住';
            tipEl.hidden = false;
            setTimeout(() => { tipEl.hidden = true; }, 900);
            // 只刷新这颗按钮自己的样子（不重排面板 —— 那会把位置/大小重置）
            pin.textContent = favPinned ? '📌 已钉住' : '📌 钉住';
            pin.classList.toggle('on', favPinned);
            pin.title = favPinned ? '取消钉住（钉住时点面板外面不会收起）'
                : '钉在屏幕上：点面板外面也不会收起';
        });
        head.appendChild(pin);
    }
    panelBody.appendChild(head);

    let shown = 0;

    // 一条收藏内容（整行可点 = 复制）。备注在前、内容在后（用户要求）。
    const itemButton = (it, lv) => {
        shown += 1;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'fav-item lv' + lv + '-item';
        if (it.remark) {
            row.appendChild(Object.assign(document.createElement('span'), {
                className: 'fav-remark', textContent: it.remark,
            }));
        }
        const main = document.createElement('span');
        main.className = 'fav-main';
        if (it.kind === 'image' && it.image) {
            const img = document.createElement('img');
            img.src = it.image;
            img.alt = '';
            img.draggable = false;
            main.appendChild(img);
        } else if (it.html) {
            /* 带格式的收藏（颜色/加粗/下划线）：渲染 sanitize 过的 HTML。
             * 存的时候 sanitize 过一次，渲染前再过一次 —— 配置可能从备份
             * 恢复、可能被手改，渲染端不信任任何存进来的内容。 */
            main.innerHTML = window.qsSanitizeRichText(it.html);
        } else {
            main.textContent = it.text || '（空）';
        }
        row.appendChild(main);
        row.addEventListener('click', async () => {
            /* 去向规则（用户口径，最直白的那条）：
             *   · **有文本框**（鼠标触发位置那个软件里有能收键盘输入的地方）
             *     → 把文字**输入进去**，完全不碰剪贴板；
             *   · **没有文本框**（或条目是图片 / 文字为空 / 那个软件已经关了）
             *     → 复制到剪贴板。
             *
             * ⚠ 这里以前是「面板里的搜索框可见就 q.value = plain」—— 那正是用户
             *   报的 bug：文字被填进了**收藏夹窗口自己**的搜索框。原因是面板一打开
             *   前台窗口就变成我们自己了，前端在外面那个软件是一点都看不到的。
             *   所以判断和注入**只能交给 Rust**：show_bar 那一刻的"触发现场"快照
             *   （trigger_hwnd / trigger_has_text）+ fav_send 命令。前端只剩一件事——
             *   把面板收掉，别挡着用户看结果。 */
            const msg = await invoke('fav_send', { id: it.id }).catch(() => '操作失败');
            tipEl.textContent = msg;
            tipEl.hidden = false;
            setTimeout(() => {
                // ⚠ 这里以前调的是一个压根不存在的 dismiss()：整段回调在这里抛出
                //   ReferenceError，下一行 renderBar 永远跑不到 —— 结果是提示
                //   永久挂在横条上、横条还被撑宽。收起横条要调后端命令 hide_bar。
                //   三行都各包一层 try：任何一步失败都不能连累最后的 tip 复位。
                try { togglePanel(false); } catch (_) { }
                invoke('hide_bar').catch(() => { });
                try { renderBar(true); } catch (_) { }   // 恢复 tip 的正常显隐状态
            }, 520);
        });
        return row;
    };

    /* 一个目录 = 一张卡片：目录名 + 条目数徽标 + 内容行，二级目录是卡内嵌卡。
     * 以前是扁平的「小标题 + 缩进行」，层级全靠缩进硬挤，看起来又碎又土；
     * 卡片化之后每个目录有自己的底色和圆角，扫一眼就知道边界在哪。
     * named=false 时不出卡片头（面板标题已经写过目录名，别重复两遍）。
     *
     * **有标题头的目录一律可折叠**（二级目录，以及根视图下的一级目录）——
     * 用户报的「2 级目录也应该能展开/收起」。单目录视图下的一级目录没有头
     * （名字在面板标题上），所以它没有折叠开关，这是对的。 */
    const groupCard = (g, lv, named) => {
        const card = document.createElement('div');
        card.className = 'fav-grp' + (lv === 2 ? ' lv2' : '');
        // data-fav-id / data-named：给 applyFavCollapsed 反查用（它只认 DOM，
        // 不想再拿一份节点表去跟卡片一一对应 —— 那是两处状态，迟早对不上）。
        card.dataset.favId = g.id;
        if (named) card.dataset.named = '1';
        const folded = named && favCollapsed.has(g.id);
        if (folded) card.classList.add('collapsed');
        if (named) {
            /* 标题行整条就是开关：命中面积大、不用去瞄那个小箭头。
             * 用 button 而不是 div —— 键盘 Tab 能到、回车能开合，顺手就有无障碍。
             *
             * ⚠ 外面必须再包一层 .fav-grp-headrow：二级目录旁边要挂「全部展开 /
             *   全部折叠」两颗按钮，而 button 里**不能再嵌 button**（HTML 不允许，
             *   浏览器会把内层那个甩到外面去，布局和点击都会错位）。
             *   所以做成「一条 flex 行 = 标题按钮（占满剩余）+ 工具按钮组」。 */
            const hrow = document.createElement('div');
            hrow.className = 'fav-grp-headrow';
            const h = document.createElement('button');
            h.type = 'button';
            h.className = 'fav-grp-head';
            h.setAttribute('aria-expanded', folded ? 'false' : 'true');
            h.title = folded ? '展开这个目录' : '收起这个目录';
            h.appendChild(Object.assign(document.createElement('span'), {
                className: 'fav-grp-caret', textContent: '▾',
            }));
            h.appendChild(Object.assign(document.createElement('span'), {
                className: 'fav-grp-name', textContent: favDisplayName(g),
            }));
            h.appendChild(Object.assign(document.createElement('span'), {
                className: 'fav-grp-count',
                // 徽标要算上**子目录**：只数条目的话，一个"里面只有子目录"的目录会在
                // 标题右边写着「0 项」，而它下面明明挂着目录 —— 看着像空的。
                textContent: ((g.items || []).length + (g.children || []).length) + ' 项',
            }));
            h.addEventListener('click', (e) => {
                // 别把这次点击冒出去 —— 面板/横条上有别的 click 逻辑（比如收起）
                e.stopPropagation();
                if (favCollapsed.has(g.id)) favCollapsed.delete(g.id);
                else favCollapsed.add(g.id);
                applyFavCollapsed();   // 状态 → DOM 只走这一条路，见函数注释
            });
            hrow.appendChild(h);
            // 二级目录旁边也放一份「全部展开 / 全部折叠」（用户要求），
            // 作用范围 = **这个二级目录自己的内容**（里面不再有子目录，就是那几条）。
            if (lv === 2) {
                const gt = document.createElement('span');
                gt.className = 'fav-grp-tools';
                const mk2 = (text, tip, fn) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'fav-tool';
                    b.textContent = text;
                    b.title = tip;
                    b.addEventListener('click', (e) => {
                        e.stopPropagation();
                        fn();
                    });
                    gt.appendChild(b);
                };
                mk2('全部展开', '展开这个二级目录里的内容', () => {
                    favCollapsed.delete(g.id);
                    applyFavCollapsed();
                });
                mk2('全部折叠', '折叠这个二级目录里的内容', () => {
                    favCollapsed.add(g.id);
                    applyFavCollapsed();
                });
                hrow.appendChild(gt);
            }
            card.appendChild(hrow);
        }
        // 内容单独包一层：折叠时整层 display:none（见 bar.css .fav-grp.collapsed）
        const body = document.createElement('div');
        body.className = 'fav-grp-body';
        for (const it of g.items || []) body.appendChild(itemButton(it, lv));
        if (lv === 1) {
            for (const sub of g.children || []) body.appendChild(groupCard(sub, 2, true));
        }
        card.appendChild(body);
        return card;
    };

    for (const g of groups) panelBody.appendChild(groupCard(g, 1, root));

    if (shown === 0) {
        panelBody.appendChild(Object.assign(document.createElement('div'), {
            className: 'fav-empty',
            textContent: '收藏夹还是空的，去设置的「收藏夹」里添加内容',
        }));
    }

    // ⚠ 布局要量两次：第一帧量的时候 WebView 可能还没把新内容排完版
    //   （尤其刚切到收藏面板、窗口尺寸在变），只量一次会把窗口撑得太矮，
    //   内容被裁掉、只能滚动才能看到（用户报的"一条内容都要滚轮"就是这个）。
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
    setTimeout(pushLayout, 140);
    // 记下这次渲染对应的内容指纹：配置广播来时内容没变就不必再渲染一遍
    lastFavSig = favContentSig();
}

function openFavPanel(sentinel) {
    // sentinel = '@fav:<id>' 打开某个目录；null/undefined = 收藏夹根（快捷键唤起）
    panelFav = sentinel || 'root';
    // 快捷键 / 横条收藏按钮唤起的：没有"上一级是引擎面板"这回事
    favFromEngines = false;
    togglePanel(true);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function barList() {
    const all = CATALOG.toolbar.map((e) => e.name);
    /* 按应用专项优先（整份取代默认横条）。没命中时走原来的 `CONF.barList` ——
     * 于是"没配 / 配了被清空 / 校验失败回退"三条路在这里看起来**完全一样**。 */
    const raw = (barOverride && barOverride.length)
        ? barOverride
        : (CONF && Array.isArray(CONF.barList) && CONF.barList.length
            ? CONF.barList
            : all);
    // 注意别把分隔线一起过滤掉：它不是引擎，但确实是横条上的一员。
    // OCR 哨兵同理 —— 它是"横条上的 OCR 按钮"，用户能拖到任意位置。
    // 收藏夹目录（@fav:<id>，一级二级都行）也是一员；目录被删掉时对应哨兵自动消失。
    // 外部软件（@app:<id>）同理：软件被删掉时对应哨兵也消失（后端已剪，
    // 这里再兜一层，防配置广播到达前那一帧画出悬空的一格）。
    const kept = raw.filter((n) => {
        // r72：识图（@img）也是一等成员了，别被后面那条"必须是认识的名字"筛掉。
        // v1.5.16：翻译（@trans）同理。
        if (n === QS_SEP || n === QS_OCR || n === window.QS_IMG
            || n === window.QS_TRANS || n === window.QS_WRAP) return true;
        if (typeof n === 'string' && n.startsWith(QS_FAV_PREFIX)) {
            return !!favGroupBySentinel(n);
        }
        if (typeof n === 'string' && n.startsWith(QS_APP_PREFIX)) {
            return !!qsAppBySentinel(n);
        }
        // 智能直达（@go:<id>）：入口被删掉时那一格自动消失。
        if (typeof n === 'string' && n.startsWith(window.QS_GO_PREFIX)) {
            return !!window.qsGoBySentinel(n);
        }
        if (ENGINE_BY_NAME.has(n)) return true;
        /* 定义存在、但"不完整"的自定义引擎（快捷键类没按键序列 / 其余类没地址）
         * **照样留在横条上**。
         *
         * 用户原话（2026-10-22）：「你不能把它给删掉啊！没显示是很严重的问题」——
         * 以前这里一票否决（目录里查不到就当它不存在），横条上那一格凭空消失，
         * 而设置页还写着「已在横条」，两边对不上，用户完全不知道发生了什么。
         * 现在照样画出来，右上角一个「!」，点一下提示去设置里补全。 */
        return !!(CONF && (CONF.customEngines || []).some((e) => e && e.name === n));
    });
    // OCR 总开关关着时，别把 @ocr 渲染出来（留一条空位毫无意义）。
    // 哨兵仍保留在配置里，用户下次开开关它就回到原位。
    // 翻译总开关关着时 @trans 同理（v1.5.16）。
    let vis = (CONF && CONF.ocrEnable !== false)
        ? kept
        : kept.filter((n) => n !== QS_OCR);
    if (!(CONF && CONF.transEnable !== false)) {
        vis = vis.filter((n) => n !== window.QS_TRANS);
    }
    // 开头的、结尾的、连着重复的分隔线在这里一次性抹平，
    // 后面渲染就不用再操心「这根竖线怎么贴边上了」。
    return qsNormalizeBarList(vis);
}

/** 把 CSS 颜色串解析成 {r,g,b,a}。支持 rgb()/rgba()/#rgb/#rrggbb。
 *  解析不出来返回 null —— 调用方会退回纯色 --qs-bg，绝不至于变透明。 */
function parseCssColor(s) {
    if (!s) return null;
    const t = String(s).trim();
    let m = t.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m) {
        return {
            r: Math.round(Number(m[1])),
            g: Math.round(Number(m[2])),
            b: Math.round(Number(m[3])),
            a: m[4] === undefined ? 1 : Number(m[4]),
        };
    }
    m = t.match(/^#([0-9a-f]{6})$/i);
    if (m) {
        const h = m[1];
        return {
            r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16), a: 1,
        };
    }
    m = t.match(/^#([0-9a-f]{3})$/i);
    if (m) {
        const h = m[1];
        return {
            r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16),
            b: parseInt(h[2] + h[2], 16), a: 1,
        };
    }
    return null;
}

/** 应用一份主题（后端 qs://theme 的载荷）。
 *
 *  载荷：`{ dark: 后端判的明暗 }`。自 #148 移除自动取色后，横条底色只由
 *  CSS 自带的两套配色给出（.stage / .qs-dark），不再有运行时注入的底色，
 *  明暗完全由这个 dark 决定。
 *  这里做两件事：清掉可能残留的内联覆盖（读 CSS 原色时不能被自己骗到），
 *  按 dark 挂 .qs-dark 类。 */
function applyThemePayload(p) {
    const payload = p || {};
    stage.style.removeProperty('--qs-fg');
    stage.style.removeProperty('--qs-fg-dim');
    stage.style.removeProperty('--qs-tip');
    stage.style.removeProperty('--qs-bg');

    stage.classList.toggle('qs-dark', !!payload.dark);
    // 顺序要紧：先挂类再同步背景，读到的 --qs-bg 才是新极性那套
    syncBarBg();
}

/** 同步横条背景色。
 *
 * ⚠ 口径（用户明确要求）：**「不透明度」滑块是唯一的透明度控制**。
 *  早期版本磨砂开启时会把背景额外压一层透明（好让 backdrop-filter 有东西可糊），
 *  结果 alpha=100 也透底 —— 用户怀疑"磨砂跟透明混在一起了"，就是这样。
 *  现在改回来：背景 = --qs-bg 原样（Rust 已把用户的不透明度烘进颜色里），
 *  磨砂只负责 backdrop-filter。想看出磨砂的玻璃感，把「不透明度」调低即可
 *  （设置里那行提示也改了）。
 *
 *  为什么这个函数还在：它负责把 --qs-bg 解析成一条**带兜底**的
 *  `--qs-bg-fill`。绝不能用 CSS 的 color-mix(calc(...)) 现算 —— 那条路一旦
 *  表达式失效整条 background-color 会被丢弃，横条直接全透明（踩过的坑）。 */
function syncBarBg() {
    let raw = stage.style.getPropertyValue('--qs-bg');
    let c = parseCssColor(raw);
    if (!c) {
        // 内联没有（正常路径）—— --qs-bg 由样式表给出（.stage / .qs-dark 两套）。
        // 读**计算值**才能拿到它 —— 不然默认（浅色）这条路径永远解析失败，
        // 磨砂 / 玻璃的底色也就永远写不进去。
        raw = String(getComputedStyle(stage).getPropertyValue('--qs-bg') || '').trim();
        c = parseCssColor(raw);
    }
    if (!c) {
        // 解析不出来（不该发生）→ 清掉覆盖，老老实实用 --qs-bg 本身
        stage.style.removeProperty('--qs-bg-fill');
        return;
    }
    /* 背景色由 JS 算好一个完整的 rgba 写进 --qs-bg-fill，alpha 就是**底色自身
     * 的 alpha**（CSS 两套是 hex，恒 1.000）—— "不透明度滑块是唯一的透明度
     * 控制"这条口径分毫没动，磨砂只动 --qs-blur-* 增益，见 applyLook。 */
    const a = c.a;
    stage.style.setProperty('--qs-bg-fill',
        'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + a.toFixed(3) + ')');
}

/** 图标大小、不透明度、内边距、底板、动画这些外观项，统一落到 CSS 变量/类上 */
function applyLook() {
    const size = Math.max(14, Math.min(96, Number(CONF && CONF.iconSize) || 30));
    stage.style.setProperty('--qs-btn', (size + 6) + 'px');

    const alpha = Math.max(30, Math.min(100, Number(CONF && CONF.alpha) || 100));
    stage.style.setProperty('--qs-alpha', (alpha / 100).toFixed(2));

    /* 待机透明度：横条弹出后、鼠标还没过来时的淡度。用户要求「初始高透明度、
     * 悬停时平滑过渡到完全不透明」，这就是那个「初始」值。
     *   · 100 → 行为和以前完全一样（待机就是全不透明，这套机制等于关掉）；
     *   · 更低 → 弹出先淡着，鼠标一进来立刻过渡到 --qs-alpha。
     * 下限夹到 10：0 会让横条整个看不见，和「淡」是两回事。 */
    const dim = Math.max(10, Math.min(100, Number(CONF && CONF.barDimAlpha) || 45));
    stage.style.setProperty('--qs-dim-alpha', (dim / 100).toFixed(2));

    const pad = Math.max(0, Math.min(12, Number(CONF && CONF.barPadding)));
    stage.style.setProperty('--qs-bar-pad', (Number.isFinite(pad) ? pad : 5) + 'px');

    // 圆角：设置里那根滑块，横条胶囊和图标按钮都吃这一个值
    const r = Math.max(0, Math.min(18, Number(CONF && CONF.itemRadius)));
    stage.style.setProperty('--qs-radius', (Number.isFinite(r) ? r : 9) + 'px');

    stage.classList.toggle('qs-noanim', !(CONF && CONF.animations !== false));
    // 浮层投影：默认关闭。开启后 .qs-shadow 会把 --qs-shadow-pad 撑到 18px，
    // 窗口尺寸跟着变大，正好给投影留出绘制空间，不会被切边。
    stage.classList.toggle('qs-shadow', !!(CONF && CONF.shadow));

    // 磨砂（backdrop-filter）—— 用 data-blur 标个**原始滑块值**，
    // CSS 那边靠这个属性开关模糊规则（值为 0 时不生效，免得白白开 GPU 层）。
    //
    // ⚠ 滑块值不直接当 px 用：走 qsBlurPx() 换算（shared.js，和设置页标签、
    //   设置页预览同一个口径）。低值区看得见、高值区不白烧 GPU，见那里的注释。
    const blur = Math.max(0, Math.min(32, Number(CONF && CONF.barBlur) || 0));
    const tone = qsBlurTone(blur);
    const blurKey = blur + '|' + tone.sat + '|' + tone.bright;
    // ⚠ 值没变就别重复写自定义属性：applyLook 每次布局都会跑，
    //   反复重设 --qs-blur 会把 backdrop-filter 那条合成层标脏、白算一遍模糊。
    if (blurKey !== lastBlurKey) {
        lastBlurKey = blurKey;
        const px = qsBlurPx(blur);
        stage.dataset.blur = String(blur);
        stage.style.setProperty('--qs-blur', px + 'px');
        stage.style.setProperty('--qs-blur-sat', String(tone.sat));
        stage.style.setProperty('--qs-blur-bright', String(tone.bright));
    }

    // 分隔线样式：细竖线 / 点状 / 纯留白。三档都用 CSS 类表达，
    // 免得在这里写一堆内联样式。
    const sep = (CONF && CONF.sepStyle) || 'line';
    stage.classList.toggle('qs-sep-dot', sep === 'dot');
    stage.classList.toggle('qs-sep-space', sep === 'space');

    // 背景色最后算：它依赖 --qs-blur（上面刚写）和当前的 --qs-bg（样式表两套配色）。
    syncBarBg();
}


/** 横条上那颗 OCR 按钮的显隐。
 *
 * 现在 OCR 有**两个可能的位置**，靠「bar_list 里有没有 @ocr 哨兵」来区分：
 *   · 有  → OCR 是横条的一员，位置由用户拖拽决定，渲染在引擎区里
 *           （`[data-ocr]` 那颗），index.html 里这颗固定的必须藏掉，
 *           否则横条上会出现两个 OCR。
 *   · 没有 → 走老样子，OCR 固定待在右侧那颗（index.html 里的 #btnOcr）。
 *
 * 为什么要留这条兼容分支：老用户的 config.json 里 bar_list 只有引擎名，
 * 不含 @ocr。如果他一升级就发现 OCR 按钮没了，那是功能倒退。
 * 等他在设置里把 OCR 拖过一次（bar_list 里写进 @ocr）之后才切到新形态。
 *
 * 另外仍受「OCR 总开关」和「本次是不是 OCR-only 形态」管。
 */
function ocrInBarList() {
    const raw = CONF && Array.isArray(CONF.barList) ? CONF.barList : [];
    return raw.some((n) => n === QS_OCR);
}

function syncOcrBtn() {
    if (ocrOnly) {
        // OCR-only 形态：它已经变成中间那颗大按钮了，两处固定按钮都收掉
        btnOcr.hidden = true;
        return;
    }
    const enabled = !!(CONF && CONF.ocrEnable !== false);
    // 固定那颗：只有「OCR 不在 bar_list 里」时才显示
    btnOcr.hidden = !enabled || ocrInBarList();
    // 图标跟着配置走：用户换了 OCR 图标，这颗固定按钮也要一起变
    // （不然把 OCR 从 bar_list 里拿掉、退回固定位置时会突然变回老样子）。
    if (!btnOcr.hidden) {
        btnOcr.textContent = '';
        btnOcr.appendChild(ocrIconNode());
    }
}

/** 在横条的提示位上临时显示一句话（外部软件打不开时用）。
 *  ⚠ renderBar 管着 tipEl 的显隐（有引擎就藏），所以到点要按它的规则恢复，
 *  不能一藏了之 —— 否则下一次「没有可用的引擎」的提示位置被占着不显示。 */
let barTipTimer = 0;
function showBarTip(text) {
    clearTimeout(barTipTimer);
    tipEl.textContent = text;
    tipEl.hidden = false;
    barTipTimer = setTimeout(() => {
        if (enginesEl.querySelector('.ico')) {
            tipEl.hidden = true;
        } else {
            tipEl.textContent = '没有可用的引擎';
            tipEl.hidden = false;
        }
    }, 2600);
}

function renderBar(force) {
    // ⚠ 冷启动时 qs://show 可能比 boot() 的两个 await 早到，那时 CATALOG/CONF
    //   还是 null —— 直接进渲染会在 barList()/签名里抛 TypeError，本次横条就空了
    //   （下一帧 boot 完成后会自己补一次渲染）。
    if (!CATALOG || !CONF) return;
    /* 网格页开着的时候别用"文字横条的引擎行"去重画它 ——
     * 配置广播（比如在设置里加/减横条成员）刚好落在网格页展开期间时，
     * 这里会把格子全部换成引擎按钮，网格页当场变成一堆错位的图标。
     * 网格有自己那套 renderGrid，等下一次唤起自然是最新的。 */
    if (gridOn) return;
    const list = barList();
    /* ⚠ 签名必须覆盖**所有会改变渲染结果**的输入。
     *
     * 曾经漏掉的两项，症状都是"点了没反应"：
     *  · `unifyIcons`（统一图标大小开关）—— 它决定每颗图标跑不跑光学补偿
     *    （见 `qsApplyOpticalScale`）。开关一改，横条上一颗图标都不动。
     *  · `dirIcons`（icons 目录里"文件名 = 引擎名"那批默认图）—— 用户往目录里
     *    丢一张图，横条不重画，得等下一次触发才看到。
     *
     * 另外 `overrideIcons` 不能用 `JSON.stringify`（几 MB base64，每次广播都拼），
     * 用 shared.js 的轻量指纹（键 + 长度 + 首尾片段）。 */
    const sig = (ocrOnly ? 'OCR|' : '') + list.join('\u0001') + '|'
        + (window.qsIconSigOf ? window.qsIconSigOf(CONF.overrideIcons) : '')
        + '|' + (window.qsIconSigOf ? window.qsIconSigOf(CONF.dirIcons) : '')
        + '|' + (unifyIcons() ? '1' : '0')
        // 外部软件的增删改名也要能触发重画 —— 哨兵串里带的是 id，
        // 光看 id 是发现不了"名字换了"的。
        + '|' + JSON.stringify(CONF.apps || []);
    if (!force && sig === renderedSignature) return;
    renderedSignature = sig;

    enginesEl.textContent = '';
    // OCR-only 形态：把「识别图片文字」当成唯一一颗引擎摆进去。
    // 复用 .engine 这套样式，尺寸/悬停效果跟其它图标完全一致。
    if (ocrOnly) {
        const btn = document.createElement('button');
        btn.className = 'ico engine qs-ocr-big';
        btn.title = '识别图片里的文字（拖框选中要识别的区域）';
        btn.dataset.ocr = '1';
        const custom = CONF && CONF.overrideIcons ? CONF.overrideIcons[QS_OCR] : null;
        if (custom) {
            // 用户换过图标：就用他的图标当这颗大按钮的脸
            btn.appendChild(ocrIconNode());
        } else {
            const label = document.createElement('span');
            label.className = 'qs-ocr-label';
            label.textContent = '识别图片文字';
            btn.appendChild(label);
        }
        enginesEl.appendChild(btn);
        tipEl.hidden = true;
        return;
    }
    let engines = 0;
    for (const name of list) {
        // 分隔线：用户自己摆的分组标记，直接渲染成一根竖线
        if (name === QS_SEP) {
            const sp = document.createElement('span');
            sp.className = 'sep';
            enginesEl.appendChild(sp);
            continue;
        }
        // OCR 按钮：和引擎一样参与排序，所以这里画出来的是 OCR 而不是图标。
        //
        // ⚠ 画进引擎区（而不是留在原来那个固定位置），位置才真正由 bar_list 决定 ——
        //   用户把它拖到第 3 个，它就出现在第 3 个。原来的 #btnOcr（index.html 里
        //   那个）在这个形态下要隐藏，否则会出现两个 OCR。
        if (name === QS_OCR) {
            const b = document.createElement('button');
            b.className = 'ico engine qs-ocr-inbar';
            b.title = '识别图片里的文字（Ctrl+Alt+O）';
            b.dataset.ocr = '1';
            // 图标走 ocrIconNode：换过就显示那张图，没换就是 OCR 徽标
            b.appendChild(ocrIconNode());
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        /* r72：**识图按钮**也进了 bar_list（`@img` 哨兵），和普通引擎一样按
         * 顺序画进引擎区 —— 位置、拖拽、移出全由这张表决定。
         *
         * 以前它是横条上一个固定位置的独立按钮（`#btnImg`），设置页那一行只能
         * 写"位置固定"，用户要的「按钮移动 + 按住拖动」在那种结构下做不到
         * （原话：「它只有一个换图标的按钮，应该也要有……移出的按钮，也能通过
         * 按钮来进行引擎位置的移动，以及通过按住来移动位置」）。 */
        if (name === QS_IMG) {
            const b = document.createElement('button');
            b.className = 'ico engine qs-img-inbar';
            b.title = '识图搜索：框选屏幕上的一块区域，拿它去按图搜索';
            b.dataset.img = '1';
            /* 右键菜单按 `.engine` + dataset.engine 认人（钩子那条路），
             * 填上 @img 之后"换图标 / 恢复默认图标 / 从横条移除"三项目录
             * 和普通引擎完全一致。 */
            b.dataset.engine = window.QS_IMG;
            b.appendChild(imgIconNode());
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                invoke('img_start').catch(() => {});
            });
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        /* v1.5.16：**翻译按钮**。和 @img 同一套地位（bar_list 成员，可拖、
         * 可换图标、可移出），点下去把横条此刻这段文字送进翻译窗口。
         *
         * 为什么带 currentText：用户的使用姿势是「在别处选中/复制一段文字 →
         * Ctrl+C 叫出横条 → 点翻译」。这段文字就是 currentText（唤起横条时
         * 那份选区/剪贴板内容），和 open_search 带的口径完全一致。
         * 没文字也照发（text: null）—— 后端会把窗口开成空的，让用户自己粘贴，
         * 比弹一句"先选文字"再让他重点一次省事。 */
        if (name === QS_TRANS) {
            const b = document.createElement('button');
            b.className = 'ico engine qs-trans-inbar';
            b.title = '翻译：把横条此刻这段文字翻成别的语言（默认中文）';
            b.dataset.trans = '1';
            // 右键菜单按 .engine + dataset.engine 认人（换图标 / 移出与普通引擎一致）
            b.dataset.engine = window.QS_TRANS;
            b.appendChild(transIconNode());
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const t = (currentText || '').trim();
                invoke('trans_start', { text: t || null }).catch(() => {});
            });
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        /* 包裹符号（@wrap）：和 @trans 同一套地位 —— bar_list 成员、可拖可移出，
         * 点下去打开包裹菜单。设置 → 附加功能 → 包裹符号 里可以加进横条。 */
        if (name === window.QS_WRAP) {
            const b = document.createElement('button');
            b.className = 'ico engine qs-wrap-inbar';
            b.title = '包裹符号：把当前这段文字套成 “” 《》 【】 等（再点一次拆掉）';
            b.dataset.engine = window.QS_WRAP;
            b.appendChild(window.qsFuncIcon(window.QS_WRAP));
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                openWrapMenu();
            });
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        if (typeof name === 'string' && name.startsWith(QS_FAV_PREFIX)) {
            // 收藏夹目录：点开列出内容（不是搜索引擎，不走 open_search）
            const g = favGroupBySentinel(name);
            const b = document.createElement('button');
            b.className = 'ico engine qs-fav-inbar';
            b.title = (g ? g.name : '收藏夹') + '　（点开查看收藏）';
            b.dataset.fav = name;
            b.appendChild(favIconNode(name));
            b.addEventListener('click', () => {
                // 再点一次要**收起**（用户报过"点第二次没反应"）：
                // 面板开着、且开的正是这个目录 → 收起；否则打开。
                if (!panelEl.hidden && panelFav === name) togglePanel(false);
                else openFavPanel(name);
            });
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        if (typeof name === 'string' && name.startsWith(QS_APP_PREFIX)) {
            // 外部软件：点一下**直接唤起对应软件**（网页 / 协议链接 / 本地程序）。
            // 搜索类软件（#135）例外：把横条此刻这条文字带上，由后端拼进 %s。
            const app = qsAppBySentinel(name);
            const kind = qsAppKind(app);
            const b = document.createElement('button');
            b.className = 'ico engine qs-app-inbar';
            b.title = (app ? app.name : '外部软件')
                + (kind === 'search'
                    ? '　（拿选中的词交给这个软件搜）'
                    : '　（点一下直接打开）');
            b.dataset.app = name;
            b.appendChild(appIconNode(name));
            b.addEventListener('click', () => {
                // 打开失败（协议没注册、路径不存在…）时把原因显示在横条的
                // 提示位上 —— 不然用户点一下什么都没发生，只会以为软件坏了。
                // 截断：后端已经把人话压到一行，这里再兜一层，别让窄窄的
                // 提示位被一段底层错误撑爆。
                invoke('open_app', {
                    id: name.slice(QS_APP_PREFIX.length),
                    text: kind === 'search' ? (currentText || null) : null,
                }).catch((e) => showBarTip('打不开：' + String(e || '未知错误').slice(0, 60)));
            });
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        if (typeof name === 'string' && name.startsWith(window.QS_GO_PREFIX)) {
            /* 智能直达：点一下**直接打开**（网址走默认浏览器，软件/文件交给系统关联）。
             * 悬停提示带上备注 —— 用户给入口写的备注往往比名字更能说明用途。 */
            const it = window.qsGoBySentinel(name);
            const b = document.createElement('button');
            b.className = 'ico engine qs-go-inbar';
            const kindTip = it && it.kind === 'url' ? '网址'
                : (it && it.kind === 'app' ? '软件' : '文件');
            b.title = ((it && it.name) || '直达')
                + (it && it.note ? '\n' + it.note : '')
                + '\n（' + kindTip + '·点一下直接打开）';
            b.dataset.go = name;
            b.appendChild(window.qsGoIconNode(name));
            b.addEventListener('click', () => {
                // 打不开时把原因写在横条提示位上：路径被移动、软件被卸掉这类
                // 情况必须让用户看见原因，不能点了没反应。
                invoke('shortcut_open', { id: name.slice(window.QS_GO_PREFIX.length) })
                    .catch((e) => showBarTip('打不开：' + String(e || '未知错误').slice(0, 60)));
            });
            enginesEl.appendChild(b);
            engines++;
            continue;
        }
        const icon = buildIconInner(name);
        const btn = document.createElement('button');
        btn.className = 'ico engine' + (icon.mono ? ' qs-mono' : '');
        /* 打开类不搜索、快捷键类不碰浏览器：悬停提示要说清楚"点了直接打开"、
         * "点了发送组合键"，别让人以为没选中文字所以坏了（它们压根不要求选中文字）。 */
        const barEng = ENGINE_BY_NAME.get(name);
        /* 定义不完整（快捷键没按键 / 搜索类没地址）：照样画出来，标个「!」，
         * 点击只提示去补全，不发 open_search（后端也没有可用的定义）。
         * 见 barList() 里那段说明 —— 用户明确要求"不能把它删掉"。 */
        if (!barEng) {
            btn.classList.add('qs-dead');
            btn.title = name
                + '　（定义不完整：没填按键序列 / 地址 —— 去「设置 → 自定义引擎」补上）';
            btn.dataset.engine = name;
            btn.dataset.dead = '1';
            btn.style.setProperty('--qs-inset', icon.inset);
            btn.appendChild(icon.node);
            enginesEl.appendChild(btn);
            engines++;
            continue;
        }
        const isOpen = qsEngineKind(barEng) === 'open';
        const isHot = qsEngineKind(barEng) === 'hotkey';
        btn.title = name + (isOpen
            ? '　（点一下直接打开这个页面）'
            : isHot
                ? '　（点一下发送组合键 ' + ((barEng && barEng.hotkey) || '') + '）'
                : '　（左键搜索 / 右键换图标）');
        btn.dataset.engine = name;
        btn.style.setProperty('--qs-inset', icon.inset);
        btn.appendChild(icon.node);
        enginesEl.appendChild(btn);
        engines++;
    }
    /* 提示文字：**只有在一个引擎都没有时**才显示。
     * 曾经在"有引擎但没选中文字"时也提示一句"没选中文字 · 点 ⋯ 输入关键词"，
     * 用户明确说这种提示没必要，已删掉 —— 横条上不该有多余的说明文字。 */
    if (engines === 0) {
        tipEl.textContent = '没有可用的引擎';
        tipEl.hidden = false;
    } else {
        tipEl.hidden = true;
    }
    /* ⚠ 这里**故意不再画**「引擎区和右侧功能按钮之间那条自动竖线」。
     *
     * 用户报过一个 bug："最后一个搜索引擎后面明明没有加竖线，结果还是有一根"。
     * 根因就是那条自动线 —— 它只要引擎区非空就出现（sepTail.hidden = engines === 0），
     * 可用户根本没加过分隔线，凭什么给他画一根。
     * 现在引擎区里的每一根竖线都严格对应用户在设置里加的那一条，
     * 加几根画几根，一根都不多。 */
}


/* ---------------------------------------------------------------- */
/* 「更多引擎」面板：三大类（网页 / 软件 / 快捷键）胶囊过滤 + 平铺      */
/* ---------------------------------------------------------------- */

/* 面板的大类过滤（#140）：
 *   panelGroupFilter = null    → 全部引擎（默认）：三大类平铺都在
 *   'web' | 'app' | 'hotkey'   → 只显示该大类的引擎
 * 用户原话：「网页/软件/快捷键三选项改小型胶囊横条同一行；默认展示所有
 * 引擎，点某类只显示该类」—— 所以默认不再是「三大类卡片」那种下钻首页，
 * 而是直接看到全部引擎，胶囊只是**筛子**。
 * panelSearchMode = 搜索框有词 → 同样平铺，但只留命中的（跨全表）。
 *
 * ⚠ 这三层筛子（大类 / 中类 / 小类）**必须同生同灭**：只复位其中一层，
 *   剩下那层就成了"看不见的筛子"——用户报的「搜哔哩哔哩只搜得到首页、
 *   搜不到它的搜索引擎」正是这么来的（详见 applyEngineFilter 里那段说明）。 */
let panelGroupFilter = null;
let panelSearchMode = false;

/** r92：面板上一次渲染的指纹（避免 `qs://config` 广播导致的无谓重建 + 闪烁）。
 *  详见 `renderPanel` 里那段说明。空串 = 还没画过。 */
let panelRenderSig = '';

/** 三大类的展示结构。每次现算 —— 自定义引擎合进目录后分类会变，不能缓存。 */
function panelTree() {
    return qsCatalogGroups(CATALOG);
}

/** 造一颗引擎格子（三个层级共用）。

 *  ⚠ 必须带 `engine` 类 —— 右键菜单的判据就是它（见 qs://rclick 那段：
 *  `btn.classList.contains('engine') ? btn.dataset.engine : null`）。
 *  曾经漏了它：面板里的引擎格子只有 `cell`，右键一律被判成「非引擎区右键」。
 *  纯语义标记：全项目没有任何 `.engine` 的 CSS 规则，不影响外观。 */
function makeEngineCell(eng) {
    const icon = buildIconInner(eng.name);
    const cell = document.createElement('button');
    cell.className = 'cell engine' + (icon.mono ? ' qs-mono' : '');
    cell.dataset.engine = eng.name;
    /* 气泡提示把**别名**也列上：有些引擎表里存的是英文/品牌名，而用户心里
     * 记的是中文叫法（iconfont ↔ 阿里巴巴图标库）。 */
    const engKind = qsEngineKind(eng);
    cell.title = aliasTip(eng.name)
        + (engKind === 'open' ? '　（打开类：直接打开这个页面，不搜索）' : '')
        + (engKind === 'hotkey'
            ? '　（快捷键类：点一下发送组合键 ' + (eng.hotkey || '') + '）'
            : '');

    const wrap = document.createElement('span');
    wrap.className = 'ci';
    wrap.style.setProperty('--qs-inset', icon.inset);
    wrap.appendChild(icon.node);

    const label = document.createElement('span');
    label.className = 'cn';
    label.textContent = eng.name;

    /* 类型角标：搜 / 开 / 键。三类点下去做的事完全不同，一屏密密麻麻的格子
     * 靠这个角标就能看出"这颗点了不搜索、不要求选中文字"。 */
    const kb = document.createElement('i');
    kb.className = 'ck' + (engKind === 'open' ? ' open' : engKind === 'hotkey' ? ' hot' : '');
    kb.textContent = engKind === 'open' ? '开' : engKind === 'hotkey' ? '键' : '搜';
    kb.title = engKind === 'open' ? '打开类：直接打开这个页面'
        : engKind === 'hotkey' ? '快捷键类：点一下发送组合键 ' + (eng.hotkey || '')
            : '搜索类：拿选中的词去搜';

    cell.appendChild(kb);
    cell.appendChild(wrap);
    cell.appendChild(label);
    return cell;
}



/** 造一颗外部软件的格子（#135 之后软件引擎也进平铺视图，用的就是它）。
 *
 *  和网页引擎格子的差别：
 *   · 图标走 qsAppIconNode（换过的图 → icons 目录默认图 → 首字徽标，三级都在
 *     shared.js 里，横条/设置/面板三处一个样）；
 *   · 挂 data-app（软件 id）而不是 dataset.engine —— 面板点击分发据此走
 *     open_app（打开类原样拉起；搜索类把当前文字拼进 %s 再拉起）；
 *   · 不带 engine 类：右键菜单那套（换图标/恢复默认）按 .engine 判据，
 *     软件的管理集中在设置页「软件引擎」，面板里不弹右键菜单。 */
function makeAppCell(row) {
    const app = row.eng;
    const kind = window.qsAppKind(app);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell app-cell';
    cell.dataset.app = app.id;
    cell.dataset.appName = app.name;
    cell.title = app.name + (app.url ? '　' + app.url : '')
        + (kind === 'search'
            ? '　（软件搜索：拿选中的词交给这个软件搜）'
            : '　（软件直达：点一下直接打开）');

    const icon = window.qsAppIconNode(window.QS_APP_PREFIX + app.id);
    const wrap = document.createElement('span');
    wrap.className = 'ci';
    wrap.style.setProperty('--qs-inset', 1);
    wrap.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'cn';
    label.textContent = app.name;

    /* 类型角标和网页引擎同一个口径（搜 / 开），扫一眼就知道这颗点下去
     * 要不要先选中文字。 */
    const kb = document.createElement('i');
    kb.className = 'ck' + (kind === 'search' ? '' : ' open');
    kb.textContent = kind === 'search' ? '搜' : '开';
    kb.title = kind === 'search' ? '软件搜索：拿选中的词交给这个软件搜'
        : '软件直达：点一下直接打开';

    cell.appendChild(kb);
    cell.appendChild(wrap);
    cell.appendChild(label);
    return cell;
}

/** 一行平铺数据 → 一颗格子（网页/快捷键引擎 or 外部软件）。 */
function panelRowCell(row) {
    return row.isApp ? makeAppCell(row) : makeEngineCell(row.eng);
}

/* 一级（大类）过滤导航：全部引擎 + 网页 / 软件 / 快捷键 三颗胶囊。
 *
 * ⚠ 这颗胶囊的激活态（panelGroupFilter）与分类锚点胶囊
 *    不是锚点：激活态由 appendGroupNav 按 panelGroupFilter 画，这里
 *    挂的是 data-grp 而不是 data-cat —— 分类锚点那套机器
 *    （paintCatNav / scrollPanelToCat / applyEngineFilter 里的导航收扩）
 *    全都按 data-cat 找按钮，不会误伤这颗。 */
function appendGroupNav(head, groups) {
    const nav = document.createElement('nav');
    nav.className = 'cat-nav grp-nav';
    nav.setAttribute('aria-label', '引擎大类过滤');
    const items = [{ key: null, title: '全部引擎' }].concat(
        groups.map((g) => ({ key: g.key, title: g.title })));
    for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cat-nav-item grp-item';
        b.textContent = it.title;
        b.dataset.grp = it.key === null ? '' : it.key;
        b.title = it.key === null ? '显示全部引擎' : '只显示' + it.title;
        if (panelGroupFilter === it.key) b.classList.add('on');
        b.addEventListener('click', () => {
            if (panelGroupFilter === it.key) return;   // 已经是它了，别白重画
            panelGroupFilter = it.key;
            panelSubFilter = null;   // 换了大类，二/三级的选择作废（r53）
            panelCatFilter = null;
            renderPanel();
            requestAnimationFrame(() => setTimeout(pushLayout, 0));
        });
        nav.appendChild(b);
    }
    head.appendChild(nav);
}

/** 子类兜底元信息：groups 里没有这一族时用（用户把某类引擎删光了就会出现）。
 *  顺序即节的展示顺序。 */
const PANEL_SUBS = ['search', 'open', 'appsearch', 'appopen', 'hotkey'];
const PANEL_SUB_FALLBACK = {
    search: { group: 'web', title: '搜索引擎' },
    open: { group: 'web', title: '直达网页' },
    appsearch: { group: 'app', title: '软件搜索' },
    appopen: { group: 'app', title: '软件直达' },
    hotkey: { group: 'hotkey', title: '快捷键' },
};
const PANEL_GROUP_FALLBACK = { web: '网页引擎', app: '软件引擎', hotkey: '快捷键引擎' };

/** 子类元信息表（所属大类 / 大类标题 / 子类标题）。
 *  分节标题和锚点导航的胶囊文案都从这取 —— 两处各算各的迟早对不上。 */
function panelSubMeta(groups) {
    const m = {};
    for (const g of groups) {
        for (const s of g.subs) m[s.key] = { group: g.key, gtitle: g.title, title: s.title };
    }
    for (const k of PANEL_SUBS) if (!m[k]) m[k] = PANEL_SUB_FALLBACK[k];
    return m;
}

/** 当前过滤下实际会出现的子类节（按 PANEL_SUBS 顺序）。
 *  锚点导航只给**有内容**的节发胶囊，空节点类一律不发。 */
function panelSectionSubs(groups, filterKey) {
    const rows = window.qsAllEngineRows(groups);
    const live = {};
    for (const r of rows) {
        if (filterKey && r.group !== filterKey) continue;
        live[r.sub] = true;
    }
    return PANEL_SUBS.filter((s) => live[s]);
}

/** 面板主体：按「大类 · 子类」分节平铺（#140 的新默认视图 + 搜索结果视图共用）。
 *
 *  rows 来自 qsAllEngineRows —— 网页/快捷键取自 engines.json 分类（含自定义
 *  引擎合进来的），软件取自 CONF.apps（#135 起分搜索/直达两类的那些）。
 *
 *  ⚠ 节里不再按 24 个分类细分标题：默认视图要的是"一屏扫完所有引擎"，
 *    分类各自一个小标题会把列表切得稀碎；子类节已经够用，锚点导航也挂在
 *    子类上（5 颗胶囊）。搜索视图同理 —— 跨全表平铺，命中即见。
 *
 *  ⚠ DOM 形状必须保持「.cat-title + .grid」交替：过滤（applyEngineFilter）、
 *    锚点跳转（scrollPanelToCat / syncActiveCatNav）、吸附头避让那三套机器
 *    全都按这个形状找元素，换了形状它们会集体失灵。 */
/* ------------------------------------------------------------------ */
/* r51 速度：引擎面板的格子懒建                                        */
/*  用户报「通过更多引擎打开更多引擎页面的速度」。实测点开面板 ~100ms，  */
/*  其中 **88ms 是建 DOM**（778 个格子），摆窗往返 0ms、合成上屏 30ms。   */
/*  所以照设置页那套来：每个分类先只建标题 + 一个空 .grid 壳，           */
/*  滚到跟前（rootMargin 400px）才填格子。                              */
/*  三条必须配平的规则：                                                */
/*    · 搜索/过滤时**强制全建** —— 过滤是按 .cell 找的，壳子里没有       */
/*      .cell 就永远筛不到；                                           */
/*    · 空过滤词那一趟**不许隐藏没填过的 grid**（否则会被当成"一条都    */
/*      没命中"藏掉，点目录跳过去也是一片空白）；                       */
/*    · 点分类锚点跳到某一类 → 那一类进视口 → 观察器自然把它填上。       */
/* ------------------------------------------------------------------ */
let panelFillers = [];
let panelIO = null;
/* r70：懒填之后的补量。
 *
 * 为什么必须补：格子是**滚到跟前才建**的，而 pushLayout 发生在重渲染后的下一帧 ——
 * 那一刻只有第一节填了格子，其余还是空壳（高度 0）。空壳后来被观察器补上，
 * 面板随之长高，**窗口却不会自己跟着长** → 底栏被窗口下缘裁掉。
 * 这正是用户报的「点软件引擎之后设置按钮就不见了」的真正根因：
 * 点胶囊 → 重渲染 → 窗口按瞬态短高度收缩 → 懒填补齐 → 面板长出窗口。
 * （r69 当时归因为 max-height 钳制，只加了一道钳、没管量窗时机，所以没修住。）
 *
 * 做法：每次懒填完排一次 pushLayout。它有载荷去重（尺寸没变一条 IPC 都不发），
 * 滚动时持续补填也不会刷屏；rAF 合并同一帧里的多次补填。 */
let panelPushRaf = 0;
function schedulePanelPush() {
    if (panelPushRaf) return;
    panelPushRaf = requestAnimationFrame(() => {
        panelPushRaf = 0;
        if (panelEl.hidden || panelFav) return;
        pushLayout();
    });
}

function panelFillOne(it) {
    if (!it || it.done) return;
    it.done = true;
    for (const row of it.list) it.grid.appendChild(panelRowCell(row));
    it.grid.dataset.filled = '1';
    // r70：见 schedulePanelPush 的注释 —— 补填改变了面板高度，窗口要跟上
    schedulePanelPush();
}

/* ------------------------------------------------------------------ */
/* r81：分片填充（搜索/过滤时不再一次性建 777 个格子）                  */
/*                                                                     */
/* 用户实测：在「更多引擎」里敲下**第一个字符**，界面会卡住一两秒。     */
/* 原因就是原来过滤入口那句 `if (q) panelFillAllNow()` —— 过滤是按      */
/* `.cell` 找的，所以有词时必须先把所有空壳填满；而一次建 777 个格子、 */
/* 每个格子还要跑一次「统一图标大小」的 canvas 像素测量，全在主线程上   */
/* 同步做完。                                                          */
/*                                                                     */
/* 现在改成**按时间片分批**：每片最多 8ms（约半帧），片与片之间让出     */
/* 主线程。用户看到的是"结果一片片出现"，而不是"卡死两秒然后突然全出来"。*/
/* 填完之后再按当前词收一次过滤，保证最终结果和一次性填充**完全一致**。 */
/* ------------------------------------------------------------------ */
let panelFillJob = 0;

/** 把还没填的格子分批填完；返回"是否真的还有活要干"。
 *
 *  没有待填格子 → 返回 false（调用方可以立刻做后面的过滤）。
 *  有 → 起一个后台分片任务，返回 true（这一趟先只用已有格子过滤）。 */
function panelFillAllChunked() {
    const todo = panelFillers.filter((it) => !it.done);
    if (!todo.length) return false;
    const id = ++panelFillJob;   // 新的任务作废旧任务
    let i = 0;
    const step = () => {
        if (id !== panelFillJob) return;          // 被更新的输入取代了，收手
        const t0 = performance.now();
        // 8ms ≈ 半帧：再长就会掉帧
        while (i < todo.length && performance.now() - t0 < 8) {
            panelFillOne(todo[i++]);
        }
        if (i < todo.length) {
            setTimeout(step, 0);
            return;
        }
        panelFillJob = 0;
        // 填完了：按当前过滤词再收一遍（新出现的格子必须参与过滤，
        // 否则用户会看到"搜索了，但列表里还留着没命中的旧格子"）
        if (engineFilterText) applyEngineFilter(engineFilterText);
    };
    setTimeout(step, 0);
    return true;
}
function panelWatch() {
    if (panelIO) { panelIO.disconnect(); panelIO = null; }
    // 搜索/过滤词在的时候偷不了懒；没有 IntersectionObserver 也一样
    if (engineFilterText || panelSearchMode || typeof IntersectionObserver !== 'function') {
        /* ⚠ 这里同样走**分批**（r81）：面板在"有过滤词"状态下重画时，
         *   一次性填 777 格依然是主线程上的一两秒卡顿。
         *   分批本身会在填完后按当前词再过滤一遍，结果与一次性填充一致。 */
        panelFillAllChunked();
        return;
    }
    panelIO = new IntersectionObserver((ents) => {
        for (const en of ents) {
            if (!en.isIntersecting) continue;
            const it = panelFillers.find((x) => x.grid === en.target);
            if (it) panelFillOne(it);
            panelIO.unobserve(en.target);
        }
    }, { root: panelBody, rootMargin: '400px 0px' });
    for (const it of panelFillers) panelIO.observe(it.grid);
}

/* ------------------------------------------------------------------ */
/* r56：「最近使用」一栏                                                 */
/*                                                                      */
/* 用户原话：「通过横条点击更多引擎展现出来的页面，再添加一个最近使用的   */
/* 一栏，这一栏就默认显示，它显示在已经陈列出来的所有引擎的最上面，并且   */
/* 标记好是最近使用，在设置当中可以选择最多呈现最近使用的 5 个、10 个、   */
/* 15 个或者 20 个。」                                                  */
/*                                                                      */
/* 三条设计口径：                                                       */
/*   ① **默认显示**，且**钉在最上面** —— 在 sticky 头和第一个分类标题     */
/*      之间。不需要用户去开什么开关；没有任何记录时整段不占位。          */
/*   ② 摆几个由 `CONF.recentMax`（5/10/15/20，设置页四档）决定。          */
/*      名单本身可以比这长得多，展示时只取前 N 个。                      */
/*   ③ 格子和下面平铺区**完全同一颗**（makeEngineCell / makeAppCell），   */
/*      点了也是同一条 open_search 路 —— 于是"最近用过"的记录也照常更新。 */
/*                                                                      */
/* ⚠ 它**不参与**大类过滤和搜索过滤 —— 但这不等于"过滤时也显示它"：       */
/*   恰恰相反，**有过滤条件时整个不画**（见 renderPanel 里的调用点）。      */
/*   理由：过滤是"把列表收窄"，而这一栏横跨所有分类、不受任何过滤影响，     */
/*   留着它只会把筛完的结果往下挤，看上去像"筛不干净"。真正需要它的是       */
/*   **默认视图**（用户刚点开面板、还没做任何筛选），那也是用户说"默认显示" */
/*   的那个场景。                                                         */
/* ------------------------------------------------------------------ */
function renderRecentSection() {
    const cfg = window.CONF || {};
    const names = Array.isArray(cfg.recentEngines) ? cfg.recentEngines : [];
    if (!names.length) return;
    const max = Math.max(1, Math.min(20, Number(cfg.recentMax) || 10));
    /* r57：**横条上已经固定住的不放进「最近使用」。**
     *
     * 用户原话：「最近使用的引擎一定要跟横条里已经固定的不重复，毕竟都在横条里
     * 固定住了，那你再放到最近使用就没有必要了，因为放到横条里的肯定是要经常
     * 使用的。」
     *
     * 这条不只是"去重"——它决定了这一栏**还剩什么价值**：横条上的引擎本来就在
     * 眼皮底下、一格就能点，再把它们抄到"最近使用"里，等于这一栏永远只显示
     * 你早就有的东西，真正需要"捞回来"的那几家反而被挤到 max 之外。
     *
     * ⚠ 用 barList()（横条此刻真正的成员，悬空哨兵已剪掉），别读 CONF.barList
     *   原始数组 —— 里面可能有已删软件的哨兵，会误判"在横条上"。
     * ⚠ 过滤在**取前 max 个之前**做：先排除再截断，否则名额被横条上的引擎
     *   占掉，这一栏实际显示的数会比用户设的少。 */
    const inBar = barList();
    const barSet = new Set(inBar);
    const rows = window.qsAllEngineRows(panelTree());
    const byName = {};
    for (const r of rows) byName[r.name] = r;
    const picks = [];
    for (const n of names) {
        if (picks.length >= max) break;
        if (barSet.has(n)) continue;   // 横条上已经有了，不重复
        const r = byName[n];
        // 名单里可能有已经不存在的引擎（配置恢复 / 引擎被删）：跳过，
        // 别给一颗点了 404 的格子。
        if (r) picks.push(r);
    }
    /* 排除完横条上的之后可能一颗都不剩（用户最近用的全是横条上那几家）。
     * 这时**整栏不显示** —— 显示一个只有标题的空栏，比不显示更像坏了。 */
    if (!picks.length) return;

    // 标题：和分类标题同一形状（.cat-title），所以滚动同步/锚点那套机器
    // 认它也不碍事 —— 但它**没有** data-cat，锚点导航不会给它发胶囊。
    const t = document.createElement('div');
    t.className = 'cat-title recent-title';
    t.dataset.recent = '1';
    const txt = document.createElement('span');
    txt.textContent = '最近使用';
    t.appendChild(txt);
    const hint = document.createElement('small');
    hint.textContent = '你刚用过的引擎，按最近顺序排';
    t.appendChild(hint);
    panelBody.appendChild(t);

    const grid = document.createElement('div');
    grid.className = 'grid recent-grid';
    /* 直接填，不走懒建：这一栏最多 20 颗，懒建的观察器开销比省下的 DOM 还大。
     *
     * ⚠ 必须打 `data-filled="1"`。面板的懒建有一套不变量：
     *   「所有 .grid 都填过 ⇔ filled 数 === grids 数」（r51 探针 ④ 就是按这个判
     *   "懒建没漏内容"）。这一栏是**急切**填的，不打这个标记就会让那个等式
     *   差 1，看上去像"有一节漏填了" —— 实际是标记没跟上。
     *   打上之后它既是"已填"，也和懒建那套账对得上。 */
    grid.dataset.filled = '1';
    for (const r of picks) grid.appendChild(panelRowCell(r));
    panelBody.appendChild(grid);
}

function renderFlatBody(groups, filterKey) {
    const rows = window.qsAllEngineRows(groups);
    const meta = panelSubMeta(groups);
    const bySub = {};
    for (const r of rows) {
        if (filterKey && r.group !== filterKey) continue;
        // r53：胶囊里选中的二级 / 三级也要真的过滤内容（"选哪个就只显示哪个"）
        if (panelSubFilter && r.sub !== panelSubFilter) continue;
        if (panelCatFilter && (r.cat || '未分类') !== panelCatFilter) continue;
        (bySub[r.sub] = bySub[r.sub] || []).push(r);
    }
    panelFillers = [];
    for (const sub of PANEL_SUBS) {
        const list = bySub[sub];
        if (!list || !list.length) continue;
        const m = meta[sub];
        const t = document.createElement('div');
        t.className = 'cat-title';
        t.id = 'cat-' + sub;
        t.dataset.cat = sub;
        t.textContent = (m.gtitle || PANEL_GROUP_FALLBACK[m.group]) + ' · ' + m.title;
        panelBody.appendChild(t);
        /* r52：中类里面再按**小类**分小节（AI 工具 / 知识 / 开发 / 购物…）。
         *  用户要求「网页搜索引擎里面再分，比如说 ai 工具、知识开发、搜索等等」，
         *  并且横条这侧也要有 —— 所以小类的标题 + 单独的格子容器都在这儿建，
         *  懒建的粒度也从"整个中类"细化成"一个小类"。 */
        const byCat = new Map();
        for (const r of list) {
            const k = r.cat || '未分类';
            if (!byCat.has(k)) byCat.set(k, []);
            byCat.get(k).push(r);
        }
        for (const [cat, rowsOfCat] of byCat) {
            const sh = document.createElement('div');
            sh.className = 'cat-sub';
            sh.dataset.sub = sub + '::' + cat;
            sh.textContent = cat;
            const sn = document.createElement('span');
            sn.className = 'n';
            sn.textContent = rowsOfCat.length + ' 个';
            sh.appendChild(sn);
            panelBody.appendChild(sh);
            const grid = document.createElement('div');
            grid.className = 'grid';
            panelBody.appendChild(grid);
            /* 格子**先不建**：挂进待填清单，滚到跟前（panelWatch）再说 */
            panelFillers.push({ grid: grid, list: rowsOfCat, done: false });
        }
    }
    /* ⚠ 第一个分类**必须同步建出来**：观察器是异步的（下一帧才回调），
     * 全留给它的话，面板打开瞬间上面那一节是**空的** —— 实测要 350ms 才
     * 冒出第一批格子，比改之前还难看。
     *
     * 2026-10-25：**从"填一节"改成"填够一屏"**。
     *
     * 只填一节的问题：一节通常 5~35 个格子，撑不满 .panel-body 那 344px 的
     * 上限，于是面板先按"矮"的样子被量一次 → 窗口按矮尺寸摆好 → 观察器
     * 补填下一节 → 面板长高 → 窗口再改一次尺寸。用户看到的就是
     * 「点开更多引擎，画面跳两三次才稳定」。
     *
     * 现在同步填到 scrollHeight 够 344px 为止（每个分类几毫秒，最多多花
     * 十几毫秒）。高度第一帧就是终值，观察器后面补的全落在滚动区里，
     * 不再改变整体高度、也就不会再动窗口。
     *
     * 344 = bar.css 里 .panel-body 的 max-height，到量就没有继续填的必要
     * （再填只影响滚动内容，不影响面板高度）。引擎少、填完全部还不到 344
     * 也无所谓 —— 那种情况下懒填本来就没东西可填。 */
    for (let i = 0; i < panelFillers.length; i++) {
        panelFillOne(panelFillers[i]);
        if (panelBody.scrollHeight >= 344) break;
    }
    panelWatch();
}

function renderPanel(focusFilter, keepScroll) {
    /* 面板要重画时，先把当前滚动位置记下来。
     *
     * ⚠ `keepScroll` 是给「配置广播引起的重画」用的（见 qs://config 那段）。
     *   那种重画**不是用户要求换内容**，纯粹是别的地方改了设置 ——
     *   如果顺手把用户正在浏览的位置滚回顶部，用户看到的就是
     *   「我正翻着引擎列表，它自己跳回最上面了」。
     *   用户主动打开面板（togglePanel）、下钻、改过滤词时仍然归零，那是应该的。 */
    const prevScroll = keepScroll ? panelBody.scrollTop : 0;
    /* r69/r70 的历史结论（盒模型部分至今有效，高度策略已被 r74 取代 —— 见下一段）：
     *
     * 用户原话：「在更多引擎弹出来的页面下面有一个设置按钮，如果当我点击软件引擎
     * 之后，这个设置按钮就不见了。」
     *
     * 实测根因（r70 修正 r69 的结论）：面板内容一多就顶到 454px 高，而窗口没有
     * 跟着长（或横条落在屏幕下半部分、下面没地方了），底栏那颗「设置…」被挤到
     * **窗口外面** —— 按钮本身 display/visibility 都正常，纯粹是位置在视口外。
     *
     * ⚠ r69 只加了道 max-height 钳制，**没修盒模型** —— .panel 当时还是普通
     *   块布局，max-height 只钳面板框、三个子盒（head/body/foot）一个都不让位，
     *   底栏被挤到面板框外照样被窗口裁掉。
     *   r70 修好了盒模型（这个结论一直有效）：
     *     .panel 改 flex 列 + body min-height:0（和收藏面板同一套盒模型，
     *     见 bar.css）—— 被钳高时 body 自己收窄出滚动条，底栏永远在框内。
     *   r74 起高度策略换成下一段那套（不再按余量收窄），但盒模型不能退回去 ——
     *   两种策略都依赖它保证「底栏永远看得见」。 */
    /* r74：引擎面板**只按屏幕百分比封顶**，不再按「横条下面还剩多少」收窄。
     *
     * 老逻辑（r69/r70）是 min(屏幕 78%, barRoomBelow)：横条落在屏幕中下部时
     * 余量往往只有一两百 px，面板被钳成一条 —— sticky 头（收藏夹入口 + 大类
     * 胶囊 + 二级胶囊）就把它占满了。用户原话：「在屏幕中下位置触发横条，这时候
     * 点开更多引擎，因为横条位置原因导致所有的内容都被遮挡住了，只看得到收藏夹
     * 和引擎大类，但看不到任何一个引擎的内容」。
     *
     * 现在的口径（用户原话：「肯定是要以显示更多引擎的内容为主，这时候把横条
     * 往上面移一点都可以，但收起更多引擎之后，横条要回到原来的位置」）：
     *   · 面板按自然高度长（.panel-body 自己还有 344px 上限，总共约 450px）；
     *   · 屏幕放不下时，Rust 的 layout_bar 拿「横条 ∪ 面板」这个**包围盒**往
     *     工作区里钳（`iy2 + pih > area.bottom` 就把 iy2 整体上移）—— 横条
     *     临时上移、面板完整可见，这正是用户允许的「往上面移一点」；
     *   · 收起面板后包围盒缩回横条自己，iy2 回到锚点算出的原位 —— 复位是
     *     Rust 钳制的自然结果，不需要前端额外记状态、也不怕失步。
     *
     * ⚠ 收藏面板（fav-mode）**不走这套**：那边还是「横条不动、面板按剩余空间
     *    收窄、内部滚动」的老策略（用户当年点名「一点收藏夹，横条立刻跑到别的
     *    地方去了」）。两个面板两种策略，见 renderFavPanel 与 qs://bar-room
     *    handler 里各自的注释。 */
    if (!panelFav) {
        const scrH = (window.screen && screen.availHeight) || 900;
        panelEl.style.maxHeight = Math.round(scrH * 0.78) + 'px';
    }

    /* r92：**内容没变就不要重建 DOM**（用户报「更多引擎页面闪烁」的修复）。
     *
     * # 为什么会闪
     *
     * 这里原来是 `panelBody.textContent = ''` 无条件清空，然后把几百个格子
     * 重新 createElement 一遍。一次重建要几十毫秒，这期间浏览器可能已经
     * 把"空面板"画到屏幕上了 —— 视觉上就是一帧白闪。
     *
     * 什么时候会重复渲染？`qs://config` 广播（收藏面板拖尺寸 600ms 一次、
     * 改任何设置、横条尺寸变化都会触发）都会走到这里。用户翻着引擎列表时
     * 面板每隔几百毫秒重建一次，闪得很有节奏 —— 就是他看到的那样。
     *
     * # 判据
     *
     * 用「渲染输入」的指纹：大类/中类/小类过滤 + 当前是否收藏模式 + 收藏
     * 数据 + 自定义引擎/外部软件名单 + 图标覆盖。这些都没变，重画出来的
     * DOM 一模一样，重建没有任何收益，只剩闪烁。
     *
     * ⚠ 和设置页 `renderAllList` 的指纹是同一套思路（那边早就这么做了，
     *   面板这边一直漏着）。指纹**不含滚动位置** —— 位置由 prevScroll 单独管。 */
    const sig = [
        panelGroupFilter || '',
        panelSubFilter || '',
        panelCatFilter || '',
        panelFav || '',
        (CONF.customEngines || []).map((x) => x.name).join('\u0001'),
        (CONF.apps || []).map((x) => x.name).join('\u0001'),
        window.qsIconSigOf ? window.qsIconSigOf(CONF.overrideIcons) : '',
        window.qsIconSigOf ? window.qsIconSigOf(CONF.dirIcons) : '',
        // 收藏树整体（展开/折叠、增删条目都会变）
        JSON.stringify(CONF.favorites || []),
        /* 2026-10-25：**「最近使用」也算渲染输入**。
         *
         * 这一栏画的是 CONF.recentEngines（用过哪些引擎）+ CONF.recentMax（露几个），
         * 而且会剔掉横条上已经固定的那几个（见 renderRecentSection，用的是
         * barList() 而不是 CONF.barList 原始数组）。这三样以前都没进指纹 ——
         * 别处不改，指纹就一直一样，于是"刚用了某个引擎"这一栏要等下一次
         * 真重画才更新。
         *
         * 补进来是为了配合下面那条新口径：缓存必须覆盖**所有**影响 DOM 的输入，
         * 否则"不重建"就会变成"显示过期内容"。 */
        (CONF.recentEngines || []).join('\u0001'),
        Number(CONF.recentMax) || 0,
        barList().join('\u0001'),
    ].join('\u0002');
    /* 指纹一样 + 面板里已经有内容 → **一个节点都不动**。
     *
     * ⚠ 这里以前是 `if (!focusFilter && ...)` —— 把 `focusFilter`（= 打开面板）
     *   当成了"必须重画"的信号。可打开面板恰恰是**最不该重画**的那一次：
     *   内容跟上次收起时一模一样，重建的收益是零，代价却是一帧白闪 ——
     *   `panelBody.textContent = ''` 之后要 createElement 几百个格子，这几十
     *   毫秒里浏览器已经把"空面板"合成到屏幕上了。
     *
     *   用户报的「选择一段文字后点开更多引擎，页面要闪好几次才稳定」，
     *   第一下就是它（第二下见 renderFlatBody 末尾"一次填够一屏"，
     *   第三下见 togglePanel 里收起时恢复 DOM 过滤状态那一段）。
     *
     * 现在只要指纹没变，就只做三件事：复位滚动、把光标送回搜索框、同步分类高亮。
     * 打开面板变成"啪"的一下 —— 没有中间态，没有白闪。
     *
     * `keepScroll` 仍然管住"配置广播引起的重画不该把用户正在看的位置滚回顶部"。 */
    if (sig === panelRenderSig && panelBody.childElementCount) {
        if (keepScroll) panelBody.scrollTop = prevScroll;
        else panelBody.scrollTop = 0;
        if (focusFilter && inputEngFilter && !panelEl.classList.contains('fav-mode')) {
            try { inputEngFilter.focus(); } catch (_) { }
        }
        syncActiveCatNav();
        return;
    }
    panelRenderSig = sig;

    panelBody.textContent = '';

    /* 收藏夹入口 + 大类胶囊过滤 + 分类锚点导航共用**同一个 sticky 头**。
     *
     * ⚠ 以前是「两个 .cat-nav 各自 position:sticky; top:0」—— 它俩都在 panel-body
     *   这同一个滚动容器里、都钉在同一条顶边。滚动时后出现的引擎分类导航（DOM 靠后，
     *   同层同 z-index 下后绘制）会**盖住**先出现的收藏夹入口。现在把三者装进
     *   同一个 sticky 容器：容器占一整条，里面几行正常堆叠，钉住后同时可见。 */
    const head = document.createElement('div');
    head.className = 'panel-sticky';

    // —— 收藏夹入口（面板里也应该有收藏夹）——
    // 一级目录平铺在最上面，点一下就切到那个目录的收藏视图。
    const favs = favGroups();
    if (favs.length) {
        const favNav = document.createElement('nav');
        favNav.className = 'cat-nav fav-nav';
        favNav.setAttribute('aria-label', '收藏夹目录');
        for (const g of favs) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cat-nav-item fav-entry';
            const badge = document.createElement('span');
            badge.className = 'fav-entry-badge';
            badge.textContent = (g.name || '★').trim().charAt(0) || '★';
            b.appendChild(badge);
            b.appendChild(Object.assign(document.createElement('span'), { textContent: g.name }));
            b.addEventListener('click', () => {
                panelFav = QS_FAV_PREFIX + g.id;
                // #141：记下来路 —— 收起时靠它决定「回引擎面板」还是「整个收起」
                favFromEngines = true;
                renderFavPanel();
                requestAnimationFrame(() => setTimeout(pushLayout, 0));
            });
            favNav.appendChild(b);
        }
        head.appendChild(favNav);
    }

    const groups = panelTree();

    // —— 大类胶囊过滤行（#140）：全部引擎 / 网页引擎 / 软件引擎 / 快捷键引擎 ——
    appendGroupNav(head, groups);

    // —— 子类锚点导航：只给当前过滤下**有内容**的节发胶囊 ——
    const meta = panelSubMeta(groups);
    const sections = panelSectionSubs(groups, panelGroupFilter)
        .map((s) => ({ key: s, title: meta[s].title }));
    /* r53：二级 / 三级目录收进**一个胶囊**（用户：「所有的 2 级目录它都用一个胶囊
     * 显示，我点开胶囊之后它会展开，我选择哪一个然后就显示哪一个」）。
     * 一级（大类）仍然平铺一行，点了它才把二级露出来；选了二级才有三级。
     * 原来三层全铺开 —— 用户说"太杂、影响观感、也占内容的地方"。 */
    appendPickNav(head, groups, sections);
    applyPickFilter();   // r53：胶囊选中的那一类一定留下，其余一定收起（DOM 兜底）

    /* 头里没东西就别塞一个空盒子 —— 空容器也会占一行 padding + 下边框，
     * 让第一个分类标题凭白往下掉一截。 */
    if (head.childElementCount) panelBody.appendChild(head);

    // —— r56：「最近使用」一栏，钉在**所有引擎分类的最上面** ——
    // 用户原话：「通过横条点击更多引擎展现出来的页面，再添加一个最近使用的一栏，
    // 这一栏就默认显示，它显示在已经陈列出来的所有引擎的最上面，并且标记好是最近
    // 使用，在设置当中可以选择最多呈现最近使用的 5 个、10 个、15 个或者 20 个。」
    //
    // ⚠ r57：**有过滤条件时不显示这一栏**。用户点开胶囊筛「只看软件引擎」、
    //   或者在搜索框打了词，是在"把列表收窄"；这时顶上还杵着一栏不受任何
    //   过滤影响的"最近使用"，会把筛完的结果挤下去，观感就是"筛不干净"。
    //   默认视图（没有任何过滤）才是用户要它"默认显示"的那个场景。
    //   r51 探针 ③「点胶囊展开、选一个就只剩这一个」钉的正是这条 ——
    //   不加这个判断，那一节会从 1 变成 2。
    if (!engineFilterText && !panelSearchMode && !panelGroupFilter
        && !panelSubFilter && !panelCatFilter) {
        renderRecentSection();
    }

    // —— 主体：平铺。胶囊行控制显示哪个大类；搜索模式只是同一份平铺的筛子 ——
    renderFlatBody(groups, panelGroupFilter);

    // 「一条都没命中」的占位。放在所有分类之后：靠 hidden 属性开关，
    // 平时完全不占位（[hidden]{display:none!important}）
    panelBody.appendChild(Object.assign(document.createElement('div'), {
        className: 'eng-noresult',
        hidden: true,
        textContent: '没有匹配的引擎（换个词试试，或者点「设置…」加一个）',
    }));

    /* ⚠ 每次重画都**显式**把滚动位置归零。
     *
     * 用户报「上次滚到的位置下次打开还在」。根因：panelBody 是 index.html 里的
     * **常驻节点**，renderPanel 只换它的内容、不换节点；而 Chromium 在「同一个任务里
     * 先删空、再一股脑填回去」这种情况下，中间那次布局根本没发生，scrollHeight
     * 从未真正掉到 0 —— 于是滚动量既不会被自动钳制、也不会被重置，原样留到下一轮。
     * （这也解释了为什么"清空子节点"看起来没生效：确实没生效。）
     *
     * 所以必须显式置 0，而且放在**内容全部填完之后**：一是此时 scrollHeight 是终值、
     * 置 0 一定成立；二是避免置完之后再插入内容触发滚动锚定（scroll anchoring）
     * 把位置又拽回去。
     *
     * ⚠ 例外：`keepScroll` 时恢复的是**重画前的位置**（配置广播引起的重画不该
     *   动用户正在看的地方）。内容高度可能变了，浏览器自己会把值钳到合法范围内。 */
    panelBody.scrollTop = prevScroll;

    /* 重画之后把过滤词再应用一次：.cell 全是新建的、默认都"可见"，
     * 不重放一遍的话，过滤状态会在「改个设置触发的重画」之后静默消失。 */
    if (engineFilterText) applyEngineFilter(engineFilterText);

    /* 打开面板时把光标送进引擎搜索框（只走 togglePanel 打开那条路）。 */
    if (focusFilter && inputEngFilter && !panelEl.classList.contains('fav-mode')) {
        try { inputEngFilter.focus(); } catch (_) { }
    }

    // 渲染完之后，把当前滚动位置对应的小节标成「激活」，让用户看一眼就知道自己在哪段。
    syncActiveCatNav();
    // ⚠ 挂一次就够。panelBody 是 index.html 里的常驻节点，renderPanel 只清内容、
    //   不换节点 —— 每次渲染都 add 一个监听的话，面板开 30 次滚一下就要跑 30 遍
    //   syncActiveCatNav（每遍两次 querySelectorAll + 读 offsetTop 强制重排）。
    if (!panelScrollBound) {
        panelBody.addEventListener('scroll', syncActiveCatNav, { passive: true });
        /* 滚动**结束**（动画走完）→ 解除跳转锁并把控制权交还给 syncActiveCatNav。
         * `scrollend` 是 Chromium 114+ 才有的事件，老内核不认也无所谓：
         * scrollPanelToCat 里还有一个兜底超时，两条路谁先到算谁。 */
        panelBody.addEventListener('scrollend', endCatJump, { passive: true });
        panelScrollBound = true;
    }
}

/** CSS 选择器里的属性值转义（分类名可能带空格、斜杠、引号）。 */
function cssEscapeValue(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

/** 重建「名字 → 别名数组」索引：**把全表所有来源的别名累加**。
 *
 *  ⚠ 为什么不直接读 ENGINE_BY_NAME：那张表是"先注册先得"建起来的，而
 *    `CATALOG.toolbar`（横条上默认那几颗）**先**注册，且 toolbar 里的条目
 *    **一律没有 alias 字段**。于是像「哔哩哔哩」这种"既在 toolbar、又在分类表里"
 *    的引擎，它的别名（B站 / bilibili / 小破站 / BILI）会被 toolbar 那份**遮掉** ——
 *    按别名搜它一律搜不到，用户看到的就是"这个引擎明明在列表里，就是搜不出来"。
 *    （实测：搜「B站」只出「哔哩哔哩（首页）」，搜索引擎那一颗被藏了；
 *      它俩在 engines.json 里别名一模一样，差别就在 toolbar 遮没遮。）
 *
 *  调用点：boot 之后、以及每次 `qs://config` 之后（自定义引擎可增删改）。
 *  自定义引擎没有 alias 字段，加进来也不会出错。 */
function buildAliasIndex() {
    const map = new Map();
    const add = (e) => {
        if (!e || !e.name) return;
        const raw = e.alias;
        const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        if (!list.length) return;
        const cur = map.get(e.name) || [];
        for (const a of list) {
            const s = String(a).trim();
            if (s && cur.indexOf(s) < 0) cur.push(s);
        }
        map.set(e.name, cur);
    };
    if (CATALOG) {
        for (const e of CATALOG.toolbar || []) add(e);
        for (const c of CATALOG.categories || []) for (const e of c.engines || []) add(e);
    }
    for (const e of (CONF && CONF.customEngines) || []) add(e);
    ENGINE_ALIASES = map;
}

/** 某个引擎的全部别名（索引表优先；索引表里没有就退回单条记录）。
 *  ⚠ 返回的是**副本**，调用方随便改，不会污染索引。 */
function aliasesOf(name) {
    const hit = ENGINE_ALIASES.get(name);
    if (hit && hit.length) return hit.slice();
    const eng = ENGINE_BY_NAME.get(name);
    const raw = eng && eng.alias;
    return (Array.isArray(raw) ? raw : (raw ? [raw] : []))
        .map((s) => String(s).trim()).filter(Boolean);
}

/** 引擎格子上的气泡提示：名字 + 别名（有别名才带括号）。 */
function aliasTip(name) {
    const list = aliasesOf(name);
    return list.length ? name + '（' + list.join(' / ') + '）' : name;
}

/** 一个引擎是否命中过滤词。**名字 + 别名**都算。
 *
 *  ⚠ 别名（engines.json 里可选的 `alias`）不是装饰：像「阿里巴巴图标库」这种中文
 *    叫法，表里的 name 是 `iconfont`（阿里自家的矢量图标站），只比 name 的话
 *    用户按自己的叫法根本搜不出来 —— 于是他就会以为"没有这个引擎"。
 *  ⚠ 别名走 aliasesOf()（全表合并），不能只读 ENGINE_BY_NAME 那一条 —— 见
 *    buildAliasIndex 的注释（toolbar 条目会遮掉分类表里的别名）。 */
function engineMatches(name, q) {
    if (!q) return true;
    const nm = name == null ? '' : String(name);
    if (nm.toLowerCase().indexOf(q) >= 0) return true;
    for (const a of aliasesOf(nm)) {
        if (String(a).toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
}

/** 「更多引擎」面板的即时过滤。
 *
 *  用户反馈：「引擎太多了，很难一次就找到自己想要的引擎，希望提供搜索功能」。
 *  这里输入即过滤，命中的留下、没命中的隐藏：
 *    · 整组都没命中 → 连分类标题一起收掉（不然一屏全是空标题）；
 *    · 小节胶囊同步只留还有内容的那些（点它仍然能滚到那一段，语义不变）；
 *    · 一条都没命中 → 出「没有匹配的引擎」占位，而不是留一屏空白让人以为卡了。
 *  清空输入框 = 完整还原，不留任何"曾经过滤过"的痕迹。
 *
 *  ⚠ 层级切换：有词 = 进「全部结果」视图（跨三大类平铺，在哪一层打框都能搜），
 *  没词 = 退回原来的下钻层级。
 *
 *  ⚠ 切换**不再靠重画**（以前是 `renderPanel(false); return;`）。两个原因：
 *    ① 重画 = 清空 + 分片重建几百个格子，敲第一个字就闪一下（r92 好不容易修掉）；
 *    ② renderPanel 有"指纹没变就提前返回"的缓存，而敲第一个字时指纹恰好没变
 *       （筛子都是 null）—— 于是它 return 了，连尾部那句"按当前词再筛一次"
 *       都走不到，用户看到的是"第一下没反应"。
 *  现在两个视图的真实差异只有顶上那栏「最近使用」，用 hidden 开关就行。 */
/** 「最近使用」那一栏的显隐（搜索态里不画）。
 *
 *  只动两个节点的 hidden、**不删 DOM**：搜索是边打边筛的，每敲一个字重画一次
 *  几百个格子的话，用户看到的就是 r92 修掉的那个"闪一下"。 */
function setRecentSectionHidden(hide) {
    if (!panelBody) return;
    const t = panelBody.querySelector('.cat-title.recent-title');
    const g = panelBody.querySelector('.grid.recent-grid');
    if (t) t.hidden = !!hide;
    if (g) g.hidden = !!hide;
}

function applyEngineFilter(raw) {
    const text = raw == null ? '' : String(raw);
    const q = text.trim().toLowerCase();
    engineFilterText = text;

    const wasSearch = panelSearchMode;
    panelSearchMode = !!q;
    const enteringSearch = !wasSearch && panelSearchMode;

    /* 进搜索态 = 跨全表搜，必须把那三层筛子清掉，否则用户会撞上一个
     * **既看不见、也点不掉**的筛子。真实复现路径：
     *
     *   ① 点「网页引擎」→ 二级胶囊出现 → 选「直达网页」→ panelSubFilter = 'open'；
     *   ② 关面板 → 当时只复位了 panelGroupFilter，panelSubFilter / panelCatFilter
     *      原样留着（togglePanel 里已一并修好）；
     *   ③ 再打开 → 二级胶囊要 panelGroupFilter 才画，于是它**不出现**了，
     *      那个 'open' 筛子从此没有任何 UI 能清掉；
     *   ④ 正文只剩 sub === 'open' 的行 → 搜「哔哩哔哩」只出「哔哩哔哩（首页）」
     *      （open 类），「哔哩哔哩」搜索引擎（search 类）被悄悄筛掉了。
     *
     *  togglePanel(false) 治"关面板"那条路，这里再兜一层（治任何别的路径留下
     *  的脏状态）：**刚进搜索态那一刻**一律清干净。
     *  ⚠ 只在"进入"时清，不是搜索态里每次按键都清 —— 用户搜索途中主动点了某颗
     *    大类胶囊，那是他看得见的筛选，不能下一键就给他撤掉。
     *  真动过筛子就必须重画 —— 胶囊高亮、正文、节标题全都跟着变；
     *  重画尾部会把当前词再应用一次。 */
    if (enteringSearch && (panelGroupFilter || panelSubFilter || panelCatFilter)) {
        panelGroupFilter = null;
        panelSubFilter = null;
        panelCatFilter = null;
        renderPanel(false);
        return;
    }

    setRecentSectionHidden(panelSearchMode);

    let shown = 0;
    /* r81：有过滤词就把还没填的格子填出来 —— 但要**分批**。
     *
     * 以前这里直接 `panelFillAllNow()`：一次建 777 个格子、每格还跑一次
     * canvas 像素测量，敲第一个字符就卡住一两秒（用户实测反馈）。
     * 现在先只用**已经填好的**格子筛一遍（几乎是瞬时的，用户立刻看到一部分
     * 结果），剩下的在后台分片填，填完自动按同一个词再收一次。
     *
     * ⚠ 空壳 grid 在下面的循环里被当成"不确定"，所以不会因为"格子里没命中"
     *   被整块隐藏 —— 分片填到它之后那次重算会给出最终结论。 */
    if (q) panelFillAllChunked();
    for (const cell of panelBody.querySelectorAll('.grid > .cell')) {
        // 软件格子（#135 进平铺视图的那批）没有 dataset.engine，名字在
        // dataset.appName 上 —— 两种格子的过滤口径必须一致。
        const hit = engineMatches(cell.dataset.appName || cell.dataset.engine, q);
        cell.hidden = !hit;
        if (hit) shown += 1;
    }
    for (const grid of panelBody.querySelectorAll('.grid')) {
        /* r51：还没填过的壳子不能因为"里面没有 .cell"被当成没命中藏掉 ——
         * 藏了之后点目录跳过去就是一片空白（懒建 + 过滤的交叉坑）。 */
        if (grid.dataset.filled !== '1') { grid.hidden = false; continue; }
        grid.hidden = !grid.querySelector('.cell:not([hidden])');
    }
    /* r52：标题的显隐要按**顺序**过一次 —— 中类标题底下现在有一串小类
     * （小类标题 + 它自己的 grid），老写法只看紧挨着的那一个兄弟节点。 */
    {
        let curTitle = null, anyVisible = false;
        const flushTitle = () => { if (curTitle) curTitle.hidden = !anyVisible; };
        for (const el of Array.from(panelBody.children)) {
            if (el.classList.contains('cat-title')) {
                flushTitle();
                curTitle = el;
                anyVisible = false;
            } else if (el.classList.contains('grid')) {
                // 还没填过的壳子不算"没命中"（懒建的代价在这儿补）
                const vis = el.dataset.filled !== '1'
                    || !!el.querySelector('.cell:not([hidden])');
                const prev = el.previousElementSibling;
                if (prev && prev.classList.contains('cat-sub')) prev.hidden = !vis;
                if (vis) anyVisible = true;
            }
        }
        flushTitle();
    }
    /* ⚠ 头里现在有**两条**非收藏导航：大类胶囊行（.grp-nav，data-grp）和
     * 子类锚点导航（data-cat）。以前只 querySelector 第一条 —— 那条恰好是
     * 大类胶囊行，它的胶囊不带 data-cat，于是真正的锚点导航永远收不掉，
     * 过滤后留着一排点不动的空胶囊。现在两条都处理。 */
    for (const nav of panelBody.querySelectorAll('.cat-nav:not(.fav-nav)')) {
        for (const b of nav.querySelectorAll('.cat-nav-item[data-cat]')) {
            const t = panelBody.querySelector(
                '.cat-title[data-cat="' + cssEscapeValue(b.dataset.cat) + '"]');
            b.hidden = !!t && t.hidden;
        }
        /* 大类胶囊行**永不收起**：它是筛子不是锚点 —— 当前大类万一被筛空了，
         * 用户还得靠它切回「全部引擎」，收起来就把人困死了。 */
        if (nav.classList.contains('grp-nav')) continue;
        // 一个胶囊都不剩时把整条导航收掉，不然会留一条空的行高 + 下边框
        nav.hidden = ![...nav.querySelectorAll('.cat-nav-item')].some((b) => !b.hidden);
    }
    const noRes = panelBody.querySelector('.eng-noresult');
    if (noRes) noRes.hidden = !q || shown > 0;

    /* ⚠ 必须放在上面那两轮显隐**之后**：它们会按"还有没有可见格子"重算
     *  .recent-title / .recent-grid 的 hidden，而搜索态里这一栏是**无条件**不画的
     *  （命中的引擎在正文里本来就有一份，留在这儿只是把结果往下挤）。 */
    setRecentSectionHidden(panelSearchMode);

    // 过滤后内容变短了，滚动位置跟着归零，免得停在一段空白上
    panelBody.scrollTop = 0;
    syncActiveCatNav();
}

/** 吸附头（`.panel-sticky`）此刻占的高度。
 *
 *  ⚠ 它是**流内**的元素 + `position: sticky; top: 0`，滚动之后会钉在
 *    panel-body 的顶端**盖在内容之上**。所以任何"滚到某个分类"的计算都必须
 *    把这个高度减掉 —— 否则目标正好落在吸附头底下被挡住。
 *    用户报的「点了目录，引擎被目录遮住一部分」就是这里少减了它。
 *    （fav 入口那一行在不在、有没有换行都会改变高度，所以必须实时量，不能写死。） */
function panelStickyH() {
    const el = panelBody && panelBody.querySelector('.panel-sticky');
    return el ? el.offsetHeight : 0;
}

/** 把导航里某一项置为激活（其余全部取消）。 */
function paintCatNav(name) {
    if (!panelBody) return;
    for (const b of panelBody.querySelectorAll('.cat-nav-item')) {
        /* 大类胶囊行（.grp-nav）里的按钮也带 cat-nav-item 类，但它是**筛子**
         * 不是锚点：激活态由 appendGroupNav 按 panelGroupFilter 画，这里
         * 按 data-cat 重画会把它的 'on' 剥掉（实测：点「网页引擎」后胶囊
         * 高亮立刻熄灭）。跳过大类行，只接管真正的锚点导航。
         * ⚠ r73/r75 起二、三级也改成平铺胶囊（.pick-nav 里的 .cat-chip），
         *    它们同样是筛子、同样没有 data-cat —— 不一起跳过的话，这里会按
         *    `dataset.cat === undefined` 把它们的 'on' 全部熄掉：用户点了
         *    「搜索引擎」/ 某个小类，胶囊一个都不亮，还以为自己没点上。 */
        if (b.closest('.grp-nav') || b.closest('.pick-nav')) continue;
        const on = b.dataset.cat === name;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
}

/* 「正在程序化跳转」的锁：用户点了哪个分类，在滚动动画走完之前就**一直亮它**。
 *
 * ⚠ 为什么非要有这把锁：平滑滚动是**动画**，过程中 `scroll` 事件会逐帧触发
 *   `syncActiveCatNav()`，而它是按**当时的位置**反推"当前分类"的 ——
 *   于是高亮会被一帧一帧改掉。探针实测时间轴（点「工具」）：
 *
 *       0ms 工具 → 100ms 网页 → 200ms AI 工具 → 300ms 图片 → 400ms 应用
 *       → 500ms 社交 → 600ms 新闻 → 700ms 财经（动画被打断，凝固在这里）
 *
 *   用户看到的就是「我点的是工具，它却亮着财经」——完全对得上。
 *   动画一旦中途被打断（比如横条重新弹出把面板收掉），高亮就永远停在那一帧。
 *
 *   正确语义：**用户点的是谁，就一直亮谁**；等动画结束再把控制权交还给
 *   `syncActiveCatNav`，此后用户自己滚轮才由位置决定高亮。 */
let catJumpLock = null;
let catJumpEndTimer = 0;

/** 跳转动画结束 → 解锁，并按最终位置校正一次高亮。 */
function endCatJump() {
    if (catJumpLock === null) return;
    catJumpLock = null;
    if (catJumpEndTimer) { clearTimeout(catJumpEndTimer); catJumpEndTimer = 0; }
    syncActiveCatNav();
}

/** 点大类按钮 → 把面板滚到那个分类，并把按钮置为激活。 */
function scrollPanelToCat(title, btn) {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'));
    const t = panelBody.querySelector('.cat-title[data-cat="' + esc(title) + '"]');
    if (!t) return;
    /* ⚠ 位置要用**视口矩形**换算，不能用 `t.offsetTop`。
     *
     *   `.panel-body` 没有 `position`，所以 `.cat-title` 的 offsetParent 不是它，
     *   `offsetTop` 是相对更外层祖先量的 —— 原来的 `offsetTop - 8` 只是"大概对"，
     *   再叠上**钉在顶端、盖住内容**的吸附头（`.panel-sticky`），跳过去的目标
     *   正好落在它底下：用户看到的就是「点了目录，引擎被目录遮住一部分」。
     *
     *   现在算的是「目标当前在滚动视口里的 y」→ 加上 scrollTop 得到它在内容里的
     *   偏移 → 再减掉吸附头高度和 8px 空隙。与 offsetParent 是谁完全无关。 */
    const bodyTop = panelBody.getBoundingClientRect().top + panelBody.clientTop;
    const top = panelBody.scrollTop
        + (t.getBoundingClientRect().top - bodyTop)
        - panelStickyH() - 8;
    // 先上锁再滚：这样动画的每一帧都不会把高亮改掉（见上面的时间轴）。
    catJumpLock = title;
    panelBody.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    // 立刻把按钮置为激活，别等 scroll 事件触发 —— 用户点了就该立刻看到反馈。
    paintCatNav(title);
    /* 解锁：优先用 `scrollend`（Chromium 114+，WebView2 有），
     * 没有就靠兜底超时 —— 两条路都留着，任何一条先到就算结束。 */
    if (catJumpEndTimer) clearTimeout(catJumpEndTimer);
    catJumpEndTimer = setTimeout(endCatJump, 900);
}

/** 某个元素在 `.panel-body` **滚动内容坐标系**里的纵向偏移。
 *
 *  ⚠ 不能直接拿 `offsetTop`：`.panel-body` 没有 `position`，元素的 offsetParent
 *    是更外层的祖先，两套坐标差着一个常量。用一次视口矩形把它折算过来。 */
function catContentTop(el) {
    const bodyTop = panelBody.getBoundingClientRect().top + panelBody.clientTop;
    return panelBody.scrollTop + (el.getBoundingClientRect().top - bodyTop);
}

/** 面板滚到哪段 → 顶部对应的导航按钮置为激活。 */
function syncActiveCatNav() {
    if (!panelBody) return;
    /* 程序化跳转动画期间**不接管高亮**：那一段位置是动画的中间态，
     * 按它反推会把高亮一帧帧改掉（见 catJumpLock 上面那段时间轴）。
     * 跳转期间保持用户点的那个亮着。 */
    if (catJumpLock !== null) {
        paintCatNav(catJumpLock);
        return;
    }
    /* ⚠ 过滤时被隐藏（display:none）的标题 offsetTop 恒为 0，照单全收的话
     *   「当前分类」会被算成最后一个被藏起来的分类（高亮乱跳）。
     *   所以只拿**还显示着**的标题来定位。 */
    const titles = [...panelBody.querySelectorAll('.cat-title[data-cat]')]
        .filter((t) => !t.hidden);
    if (!titles.length) return;
    /* 已经滚到底 → 「当前分类」直接就是最后一个。
     *
     * ⚠ 不能只靠位置判定：**内容末尾那个分类**常常长得不足以让它滚到
     *   「吸附头下沿 + 8px」，滚动被钳在 maxScroll 上，于是它的标题停在更靠下的
     *   位置、够不着下面那个阈值 —— 位置判定就会把高亮判给**上一个**分类。
     *   实测点最后一个分类「工具」时高亮亮的是「生活」，就是它。
     *   （`maxScroll > 4` 那半句是给"内容一屏装得下、根本不能滚"准备的：
     *    那时 maxScroll 是 0，不加这道闸就会把高亮死死钉在最后一个分类上。） */
    const maxScroll = panelBody.scrollHeight - panelBody.clientHeight;
    if (maxScroll > 4 && panelBody.scrollTop >= maxScroll - 1) {
        paintCatNav(titles[titles.length - 1].dataset.cat);
        return;
    }
    /* 标定一次「offsetTop → 滚动内容坐标」的原点，后面全用差值 ——
     * 每次滚动只读一次布局，不会因为 23 个标题逐个 getBoundingClientRect 而抖。
     * （所有标题共用一个 offsetParent，所以这个常量对它们都成立。） */
    const origin = catContentTop(titles[0]) - titles[0].offsetTop;
    /* 阈值要把**吸附头的高度**算进去：跳转后目标分类停在「吸附头下沿 + 8px」，
     * 若阈值只有 scrollTop + 12，它恰好够不着，高亮会停在**上一个**分类上 ——
     * 点完 A 却亮着 B。 */
    const limit = panelBody.scrollTop + panelStickyH() + 12;
    let activeTitle = titles[0];
    for (const t of titles) {
        if (origin + t.offsetTop <= limit) activeTitle = t;
        else break;
    }
    const name = activeTitle.dataset.cat;
    paintCatNav(name);
}

/** 把「窗口尺寸 + 实体区域」回报给 Rust。
 *
 * 实体区域 = 横条胶囊 ∪ 展开的面板 ∪ 右键菜单，三者的外接矩形。
 * Rust 会按这个尺寸把窗口撑开，所以菜单/面板绝不会被窗口裁掉。
 * （stage 是 max-content 的，绝对定位的菜单撑不动它，必须自己取 max。）
 *
 * 另外单独报一个 barH = **胶囊自己**的高度：Rust 要用它算「文字下面还放不放得下」，
 * 而 ih 在面板展开时会被带大，拿它去算会误判。 */
/** 上一次 pushLayout 算出来的载荷（拖动时只换 offset 复用，不重新量 DOM）。 */
let lastLayoutPayload = null;
/** 正在拖收藏面板。拖动期间冻结"面板最大高度"那条重排，松手再恢复。 */
let favDragging = false;

/** 一帧合并一次 `pushLayout`（拖拽/缩放这类高频指针回调专用）。
 *
 *  为什么不直接调 pushLayout：一次 pushLayout = 4~6 次 getBoundingClientRect
 *  （每次强制同步布局）+ 一条 IPC + Rust 侧一次 SetWindowPos + 一次跨线程
 *  SetBounds。pointermove 在 120Hz 鼠标上每 8ms 就来一条，直接调等于每帧跑
 *  两三遍，拖起来发飘。 */
let layoutPushRaf = 0;
function scheduleLayoutPush() {
    if (layoutPushRaf) return;
    layoutPushRaf = requestAnimationFrame(() => {
        layoutPushRaf = 0;
        pushLayout();
    });
}

function pushLayout() {
    // ⚠ 收藏面板是绝对定位（见 renderFavPanel），向 stage 下方伸出，
    //   而 body 是 max-content 高度 + overflow:hidden —— 不把 stage 盒子
    //   撑到覆盖面板，超出 stage 底边的部分会被 body 沿盒边裁掉。这就是
    //   用户报的「收藏夹窗口显示不完整 / 被生生切掉一块」（已用 Edge 无头
    //   截图复现确认：不是 WebView2 合成面问题，SetBounds 修不到它）。
    //   引擎面板是流内的、stage 自然长高，不受影响；只在收藏模式下补。
    if (panelFav && !panelEl.hidden) {
        const sBox = stage.getBoundingClientRect();
        const pBox = panelEl.getBoundingClientRect();
        // 纵向：撑到覆盖面板底边
        const need = Math.ceil(pBox.bottom - sBox.top);
        const cur = parseFloat(stage.style.minHeight) || 0;
        // 只增不减：拖拽中间态可能量到偏小的值，长了不缩回，收起时统一清
        if (need > cur) stage.style.minHeight = need + 'px';
        // ⚠ 横向同理（同一个病根的另一半）：面板向左对齐横条左缘、宽 400px 起，
        //   比 stage 本身宽 —— 超出的右半截会被 body 的 overflow:hidden 裁掉。
        //   裁掉的正是面板的右缘，于是**右边看起来是直角、圆角没了**
        //   （用户报的「右边还是一个直角形，也没有圆角」）。把 stage 撑到覆盖
        //   面板右缘，圆角才画得出来。
        const needW = Math.ceil(pBox.right - sBox.left);
        const curW = parseFloat(stage.style.minWidth) || 0;
        if (needW > curW) stage.style.minWidth = needW + 'px';
    } else {
        if (stage.style.minHeight) stage.style.removeProperty('min-height');
        if (stage.style.minWidth) stage.style.removeProperty('min-width');
    }
    const s = stage.getBoundingClientRect();
    const barRect = barEl.getBoundingClientRect();
    // 幽灵横条（钉住面板时）只用来算钉住点，不进包围盒 —— 否则窗口会多出一条
    // 透明带盖在横条原位置，挡住点击。
    const rects = barEl.classList.contains('ghost') ? [] : [barRect];
    if (!panelEl.hidden) rects.push(panelEl.getBoundingClientRect());
    if (!menuEl.hidden) rects.push(menuEl.getBoundingClientRect());
    /* ⚠ 包裹菜单**必须**进包围盒，别以为"它是 stage 的子节点、窗口自然会跟着长高"就够了：
     *   窗口高度确实会长（h 取的 s.height），但 Rust 侧判断"点是不是落在横条自己身上"
     *   用的是 iw/ih 这块**实体矩形**（`is_bar_inner` → `bar_rects().1`）。漏了这块，
     *   点符号按钮那一下就会被当成"点在横条外面"→ 先 `dismiss_bar()` 收条再谈点击，
     *   于是菜单还在、点哪个都没反应 —— 用户报的「包裹符号功能并没有真正生效」就是这个。
     *   （引擎面板和右键菜单早就加进来了，包裹菜单是后写的，漏了这一步。） */
    if (wrapMenuEl && !wrapMenuEl.hidden) rects.push(wrapMenuEl.getBoundingClientRect());

    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));

    // pinX/pinY = 横条胶囊自身在 stage 里的偏移 —— Rust 用它钉窗口位置
    // （贴文字时钉在光标旁、贴鼠标时钉在锚点）。ix/iy 仍是整棵包围盒的
    // 左缘，只用于命中判定。两者分开是为了「面板比横条宽」时也能钉住横条：
    // 包围盒左缘可能比横条左缘更靠左，拿包围盒去钉会把横条带着滑。
    const payload = {
        w: Math.max(Math.ceil(s.width), Math.ceil(right - s.left)),
        h: Math.max(Math.ceil(s.height), Math.ceil(bottom - s.top)),
        ix: Math.round(left - s.left),
        iy: Math.round(top - s.top),
        iw: Math.round(right - left),
        ih: Math.round(bottom - top),
        barH: barRect.height,
        pinX: Math.round(barRect.left - s.left),
        pinY: Math.round(barRect.top - s.top),
        // 实体往 stage 左缘之外探出的量（CSS px）。正常为 0；万一有，
        // Rust 会把窗口左移同等量并把合成面右移，内容不会被裁（见 WV_SHIFT_X）。
        shiftX: Math.max(0, Math.round(s.left - left)),
        // 拖动面板时整块窗口的平移量（Rust 会把它钳在显示器工作区内）
        offsetX: Math.round(winOffX),
        offsetY: Math.round(winOffY),
        /* 被拖块矩形：拖动中的收藏面板（松手后**继续报**，否则 Rust 换回按包围盒钳，
         * 面板会当场往下跳 41 CSS px）。没拖动过（winOff 还是 0）就不报，保持老行为。 */
        ...(panelFav && !panelEl.hidden && (favDragging || winOffX || winOffY)
            ? {
                dragRect: (function () {
                    const r = panelEl.getBoundingClientRect();
                    return [r.left, r.top, r.width, r.height];
                })(),
            }
            : {}),
    };
    /* ⚠ 尺寸完全没变就别再发 IPC 了。
     *
     * 这是个**反馈环**的断点：面板尺寸一变 → ResizeObserver 叫 pushLayout →
     * Rust 改窗口尺寸 → WebView 视口变 → CSS 重排 → 面板尺寸又量出个新值 →
     * RO 再叫一次…… 两边互相追着改，屏幕上就是「不停乱闪」。
     * 只要数字收敛到一样，这里直接停手，环就断了（顺手省掉拖拽时每帧一条 IPC）。 */
    const key = JSON.stringify(payload);
    lastLayoutPayload = payload;
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    // r51 速度：这次 IPC 来回各用了多久（面板开合那四段计时里的 layoutSent/layoutDone）
    const __t0 = performance.now();
    invoke('layout_bar', payload).then(() => {
        const T = window.__qsPanelTiming;
        if (T && T.t0) {
            T.layoutSent = Math.round(__t0 - T.t0);
            T.layoutDone = Math.round(performance.now() - T.t0);
        }
    }).catch((e) => {
        invoke('log_msg', { msg: 'layout_bar ERROR: ' + e }).catch(() => {});
    });
    // pushLayout 在拖拽缩放时是**每个 pointermove 一次**；dumpState 又会额外发一条
    // IPC + 强制一次同步布局。只在调试模式（QS_DEBUG=1）才跟着打。
    if (CONF && CONF.debug) dumpState('after-pushLayout');
}

/* 拖动专用的轻量推送（见下方 startFavDrag / dragPushLayout 的注释）。
 *
 * 用户报的 bug：「通过横条更多引擎打开收藏夹页面会在拖动的时候闪烁」。
 * 根因是每来一条 pointermove 都走一遍完整 pushLayout：量 3~4 次
 * getBoundingClientRect（强制同步布局）→ 发 IPC → Rust 挪窗口 → WebView 重合成。
 * pointermove 一秒能来上百条，窗口就一步一跳地往前蹭，看着就是闪。
 *
 * 这里做两件事：
 *   · 只换 offset，复用上次量好的尺寸 —— 拖动中面板尺寸本来就没变；
 *   · 由调用方按 requestAnimationFrame 去抖，一帧最多发一次。
 * 松手时再走一次完整 pushLayout 对齐（那一下量得准）。 */
function dragPushLayout() {
    if (!lastLayoutPayload) { pushLayout(); return; }
    const payload = Object.assign({}, lastLayoutPayload, {
        offsetX: Math.round(winOffX),
        offsetY: Math.round(winOffY),
    });
    /* dragRect 已经由 pushLayout 放进载荷里（松手后也继续带 —— 见那里的注释），
     * 这里只管复用，不再重新量 DOM：拖动中每帧省下 3~4 次强制同步布局。 */
    lastLayoutPayload = payload;
    lastLayoutKey = JSON.stringify(payload);
    invoke('layout_bar', payload).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 交互：横条                                                          */
/* ------------------------------------------------------------------ */

barEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    // OCR-only 横条上那颗大按钮
    if (btn.dataset.ocr === '1') {
        invoke('ocr_start').catch(() => {});
        return;
    }
    if (btn.classList.contains('engine')) {
        // ⚠ 还要看 dataset.engine：收藏夹格子（qs-fav-inbar）和外部软件格子
        // （qs-app-inbar）也带 engine 类，但它们的 click 各自处理（弹面板 /
        // 唤起软件），不该再顺手发一条 open_search —— 那条会带着
        // engine=undefined 被 Rust 拒掉，白跑一趟 IPC。
        if (!btn.dataset.engine) return;
        /* 定义不完整的引擎（没按键 / 没地址）不发 open_search —— 后端拿不到能用的
         * 定义，发了只会被拒或打开一个空地址。改成把原因说给用户听，
         * 并指路去补全。 */
        if (btn.dataset.dead === '1' || !ENGINE_BY_NAME.has(btn.dataset.engine)) {
            showBarTip('「' + btn.dataset.engine + '」还没填按键序列或地址：去「设置 → 自定义引擎」补上');
            return;
        }
        // 和引擎面板点格子同一套口径：带上横条此刻这条文字，别让后端去猜
        // （详见 runEngineSearch 的注释）。
        invoke('open_search', {
            engine: btn.dataset.engine,
            text: currentText || null,
        }).catch(() => {});
    }
});

btnOcr.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('ocr_start').catch(() => {});
});

// 右键菜单：钩子驱动为主（DOM 的 contextmenu **不再兜底**，理由见下）。
let lastMenuAt = 0;   // 钩子那条路的去重时间戳（见下面 qs://rclick）

/* ⚠ 这里**只压掉 WebView2 的原生右键菜单，不再兜底开我们的菜单**。
 *
 * 以前这里还会 `openMenuOnce(...)` 兜一次底（怕钩子那条路没到）。但 Windows 上
 * contextmenu 是**右键抬起**时才触发的 —— 于是松手瞬间会用「窗口已经变大/挪位
 * 之后」的 clientX/clientY 把菜单整个重建一遍（openMenu 第一句就是
 * menuEl.textContent = ''，菜单项全清空重来）。用户看到的就是
 * 「按住鼠标菜单在、一松开菜单就没了，根本点不进去」（本次反馈的第 3 条）。
 * 菜单一律由 Rust 全局钩子的 RDown 驱动 —— 那条路本来就比 DOM 可靠
 * （无激活浮层上 WebView2 的 contextmenu 时有时无），不需要兜底。 */
document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
}, true);

/* ------------------------------------------------------------------ */
/* 包裹符号                                                            */
/*                                                                     */
/* 用户口径：选中文字 → 一键套成成对符号（双引号 / 单引号 / 书名号 /    */
/* 中括号 / 大括号…）。反复点同一对要来回切换，套两层要能一次拆干净，  */
/* 已经包着别的符号时点另一对是**换外层**而不是再叠一层。               */
/* 逻辑全在后端 `wrap_apply`（纯函数 + 单测），这里只负责交互与展示。   */
/* ------------------------------------------------------------------ */


/** 符号表缓存。**后端 `wrap_pairs` 是唯一来源**，不在 JS 里另抄一份。 */
let wrapPairsCache = null;

/** 本次菜单会话的"当前文字"：点一次包一层，再点同一对就是拆。 */
let wrapBase = '';

/** 打开菜单时那段原文。用来判断"是不是换了一段新选中的字"。 */
let wrapOrigin = '';

/** 这一轮菜单里**已经真的替换过原文**了吗？
 *
 *  v2.6.2 起点符号会把结果直接输入回原来那个软件（不用手动粘贴）。
 *  第一次是"整段替换当前选区"；之后再点，光标已经停在上一版末尾、选区没了，
 *  后端必须先按上次的字数退格再输入新版 —— 前端这个标记就是告诉它
 *  "这是第几次"。菜单一关就复位（下一次唤起是新的选区）。 */
let wrapPasted = false;

/** 压成一行 + 截断 —— 菜单头那行必须永远只占一行，否则窗口会随内容变高变矮。 */
function oneLine(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > 42 ? t.slice(0, 42) + '…' : t;
}

/** v2.6.3：横条上**不再有一颗固定的包裹按钮**。
 *
 *  以前 index.html 里有个常驻的 `#btnWrap`，只要选中了文字就冒出来 ——
 *  可它是写死的，和 `bar_list` 完全无关：用户在设置里把「包裹符号」
 *  从横条移除了，这颗按钮照样在（用户报的「取消了但横条里还显示」）。
 *
 *  现在唯一的入口就是 `bar_list` 里的 `@wrap` 成员（和翻译 / OCR 同一套），
 *  加进来才出现、移出去立刻消失，按钮状态和横条内容天然一致。
 *  这个函数留空壳是因为 `qs://show` / `qs://text` 等处还在调它 ——
 *  删调用点没必要，留着也不会做任何事。 */
function syncWrapBtn() { }

function closeWrapMenu() {
    if (!wrapMenuEl || wrapMenuEl.hidden) return;
    wrapMenuEl.hidden = true;
    wrapBase = '';
    wrapOrigin = '';
    wrapPasted = false;
    wrapQueued = null;
    pushLayout();
    armIdle();
}

async function openWrapMenu() {
    if (!currentText || !currentText.trim()) {
        // 没选中文字：明确说一句，别让按钮点了毫无反应
        showBarTip('先选中一段文字，再来包符号');
        return;
    }
    // 和引擎面板互斥：两块同时展开会把窗口撑得老高，而且语义上互不需要
    if (!panelEl.hidden) togglePanel(false);
    closeMenu();
    wrapBase = currentText;
    wrapOrigin = currentText;
    wrapPasted = false;
    wrapMenuEl.hidden = false;
    $('wmCur').textContent = '当前：' + oneLine(wrapBase);
    $('wmFoot').textContent = '点一次就套上并替换原文；再点同一组是拆掉，换一组是替换外层符号。';
    await renderWrapGrid();
    pushLayout();
    // 菜单刚显示时高度还要再量一次（字体/换行落定后），否则窗口会矮一截
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
}

async function renderWrapGrid() {
    const grid = $('wmGrid');
    if (!grid) return;
    if (!wrapPairsCache) {
        try {
            wrapPairsCache = await invoke('wrap_pairs');
        } catch (_) {
            wrapPairsCache = [];
        }
    }
    grid.textContent = '';
    for (const p of wrapPairsCache) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wm-item';
        b.dataset.key = p.key;
        b.title = '用' + p.name + '包住选中的文字';
        const sym = document.createElement('span');
        sym.className = 'wm-sym';
        // 中间放个「文」当占位：一眼看出左右符号各长什么样（对称符号也不会看成两个）
        sym.textContent = p.left + '文' + p.right;
        const nm = document.createElement('span');
        nm.className = 'wm-nm';
        nm.textContent = p.name;
        b.appendChild(sym);
        b.appendChild(nm);
        b.addEventListener('click', () => applyWrap(p.key));
        grid.appendChild(b);
    }
}

/** 回写是"一次一条"的：上一次还在往目标软件里粘贴时，再点一次**不能并发**发出去
 *  （实测：连点两下，两次退格/粘贴互相插队，正文被糊成两份）。
 *  这里把点击排成队：正在跑就记下"最后一次点的符号"，等这一条落地再补发。 */
let wrapBusy = false;
let wrapQueued = null;

async function applyWrap(key) {
    if (wrapBusy) { wrapQueued = key; return; }
    wrapBusy = true;
    try {
        let k = key;
        for (;;) {
            await applyWrapOnce(k);
            if (wrapQueued == null) break;
            k = wrapQueued;
            wrapQueued = null;
        }
    } finally {
        wrapBusy = false;
        wrapQueued = null;
    }
}

/** 真正干活的那一下（排队逻辑见上面的 applyWrap）。 */
async function applyWrapOnce(key) {
    if (!wrapBase || !wrapBase.trim()) {
        showBarTip('先选中一段文字，再来包符号');
        return;
    }
    try {
        /* apply = 直接把结果输入回原来那个软件（用户要求"不用手动粘贴"）。
         * fresh = 这一轮菜单里还没替换过 —— 第一次是整段替换手头的选区；
         * 从第二次起，后端要先退格删掉上一版再输入（光标这时停在上一版末尾）。 */
        const r = await invoke('wrap_text', {
            text: wrapBase,
            pair: key,
            apply: true,
            fresh: !wrapPasted,
        });
        // 会话内以新结果为基准：于是"再点一次同一对"就是拆，点另一对就是换外层
        wrapBase = r.text;
        const act = r.action === 'unwrap'
            ? '已拆掉这组符号'
            : (r.action === 'swap' ? '已换成这组符号' : '已包裹');
        $('wmCur').textContent = '当前：' + oneLine(wrapBase);
        if (r.applied) {
            wrapPasted = true;
            $('wmFoot').textContent = act + '，已替换原文（Ctrl+Z 可撤销）';
            showBarTip(act + '（已替换原文）');
        } else {
            /* 回写没做成：退回复制那套，并说清为什么，别让用户以为点丢了。
             * 同时把"已经替换过"的标记清掉 —— 目标文档其实没被我们动过，
             * 下一次点击应该重新按"替换当前选区"来（fresh）。 */
            wrapPasted = false;
            const why = r.note ? '（' + r.note + '）' : '';
            $('wmFoot').textContent = r.copied
                ? act + '，已复制到剪贴板' + why + ' —— 回原处 Ctrl+V 覆盖即可'
                : act + '，但剪贴板被占用，没能复制' + why;
            showBarTip(r.copied ? act + '（已复制）' : act);
        }
        /* 结果变长/变短后菜单可能多一行或少一行 —— 重新量一次，
         * 不然窗口还按上一次的高度算，新多出来那行会被裁在窗口外面。 */
        pushLayout();
    } catch (e) {
        showBarTip(String(e || '操作失败'));
    }
}

if ($('btnWrapClose')) $('btnWrapClose').addEventListener('click', closeWrapMenu);

/** 「打开这个网址」按钮显不显示。口径与 `syncPathBtn` 一致。
 *
 *  ⚠ 抽成函数是因为原来 `qs://show` 和 `qs://text`（迟到补那一路）**各抄了一遍** ——
 *    改一处漏一处就会出现"按钮亮着、点下去用的却是上一段的文字/状态"。
 *    `ocrOnly`（OCR 结果窗那种只有文字的形态）下没有"这段文字"可搜，也不给开网址。
 *
 *  ⚠ 显隐判据 2026-10-16 换成「这段文字里**有没有链接**」（`currentUrls`），
 *    不再是"整段是不是一条网址"：用户要求"选中文本含多个链接时，点一下就把
 *    它们分别开成多个标签页" —— 一段话里夹着两个网址当然也该给按钮。
 *    `currentIsUrl` 留作兜底（万一某条载荷没带 `urls`）。
 *
 *  r97：**修「划词选中网址却不弹按钮」**（用户 2026-10-22 报）。
 *    原话：「我选中了一个网址但横条里并不能够弹出直达网址的按钮，但是如果我把
 *    这段网址复制下来了，因此而弹出的横条里面却能有直达网址的按钮」。
 *
 *    根因：两条路拿到的**文字**不一样。复制走剪贴板，是用户选中的原文；
 *    划词在浏览器里 UIA 被整体跳过（Chromium 内容树唤不醒），落到 OCR 兜底 ——
 *    OCR 出来的东西带它自己的噪声（把 URL 从中间断开成 `https:// a.com`、
 *    行尾多一个空格），于是"整串是不是 URL"判成 false，按钮不出现。
 *    Rust 侧 `text_to_url` / `extract_links` 已经对这类噪声放宽（见那边 r97 注释），
 *    所以这里**判据本身不用改**，改的是「点了之后拿什么去开」：
 *    以前 `urls` 为空就 invoke 一个不带参数的 `open_link`，后端读共享状态里的
 *    `sel_url` —— 而 sel_url 正是那个判失败的 None。现在前端直接把文字传过去，
 *    让后端用同一套判据再解析一次（解析失败它会自己兜底打开原文）。 */
function syncLinkBtn() {
    const n = (currentUrls || []).length;
    const has = n > 0 || currentIsUrl;
    btnLink.hidden = !has || ocrOnly;
    if (n > 1) btnLink.title = `打开这 ${n} 个链接（分别开标签页）`;
    else if (n === 1) btnLink.title = '打开：' + currentUrls[0];
    else btnLink.title = has ? '打开：' + currentText : '';
}
btnLink.addEventListener('click', () => {
    /* 多条链接走 `open_links`（后端分别开标签页，带去重 + 12 条上限）——
     * 和 OCR 结果页那颗「打开链接」同一条命令，行为一致。
     *
     * r97：**把文字一起传给后端**。以前是 `invoke('open_link')`（无参数），
     * 后端读 `sel_url`；而划词路径上 sel_url 常常是 None（OCR 噪声让判据失败），
     * 于是按钮明明亮着、点下去什么都没发生。现在带上 currentText，
     * 后端拿它重新过一遍 `text_to_url` / `extract_links`，失败也有兜底。 */
    const n = (currentUrls || []).length;
    if (n > 0) invoke('open_links', { links: currentUrls }).catch(() => {});
    else invoke('open_link', { text: (currentText || '').trim() }).catch(() => {});
});

/* ------------------------------------------------------------------ */
/* r54：识图搜索按钮 + 本地路径按钮                                     */
/* ------------------------------------------------------------------ */

/** 「识图」按钮显不显示。口径与 `syncLinkBtn` 一致：跟着配置开关走。
 *
 *  为什么**不用**看取到的文字：识图是「框一块屏幕来搜」，跟这次划到的是
 *  文字还是图片无关（用户原话：点击识图搜索按钮，可框选截取屏幕指定区域
 *  进行识图）。所以只要总开关开着、并且用户选了「加到横条」，它就常驻。
 *
 *  ⚠ OCR-only 形态（Ctrl+C 复制到图片那种）不显示：那时横条只有一颗
 *    「开始识别」大按钮，摆别的会误导。 */
/** 识图按钮的图标节点（自定义图 or 内置 SVG，都吃「统一图标大小」）。
 *
 *  r72：识图成了 bar_list 的成员，横条上它可能画在引擎区中间，所以把"这张
 *  脸"抽出来复用 —— 固定位那颗 `#btnImg` 与引擎区里那颗 `@img` 用同一份逻辑，
 *  换图标 / 恢复默认之后两处不会出现"一个变了另一个还是老样子"。 */
function imgIconNode() {
    /* v1.5.19：默认图标从「内联 SVG」换成用户指定的「识图键.png」（base64 内嵌）。
     *
     *  实现搬到 shared.js 的 qsImgIconNode —— 和翻译那颗（qsTransIconNode）
     *  同一套结构：横条固定位那颗、横条 bar_list 里那颗、设置页列表、
     *  设置页预览，四处长得一模一样，不会"一个换了另一个还是老样子"。
     *  shared.js 没加载上（理论上不可能）才退回下面这段老逻辑。 */
    if (window.qsImgIconNode) return window.qsImgIconNode();
    const custom = CONF && CONF.overrideIcons && CONF.overrideIcons[window.QS_IMG];
    const unify = !window.CONF || window.CONF.unifyIcons !== false;
    if (custom) {
        const im = document.createElement('img');
        im.alt = '';
        im.draggable = false;
        im.src = custom;
        im.addEventListener('error', () => { im.style.visibility = 'hidden'; });
        if (window.qsApplyOpticalScale) window.qsApplyOpticalScale(im, unify);
        return im;
    }
    const holder = document.createElement('span');
    holder.innerHTML = builtinImgSvg() || window.QS_IMG_SVG || '';
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
    return badge;
}

function syncImgBtn() {
    const on = !!(CONF && CONF.imgEnable) && !!(CONF && CONF.imgAddToBar);
    /* r72：识图进了 bar_list 之后，横条上那颗由 renderBar 画在引擎区里 ——
     * 固定位这颗必须让开，否则会同时出现两个识图按钮。 */
    const inList = (CONF && Array.isArray(CONF.barList) ? CONF.barList : []).indexOf(window.QS_IMG) >= 0;
    btnImg.hidden = !on || ocrOnly || inList;
    if (btnImg.hidden) return;
    /* r61：用户换过图标就显示那张图，否则用内置的 SVG。
     *
     * 键是 `CONF.overrideIcons['@img']`（一个 data URL）—— 和 @ocr / @app:<id>
     * 完全同一套机制：`pick_icon('@img')` 落库，config_view 发回来就是 data URL。
     * 用户原话：「识图搜索的那个图标也能够自己换」。
     *
     * ⚠ 内置 SVG 要留一份在 JS 里（而不是 innerHTML 读一次缓存）：切回内视图标时
     *   得能还原，而且这段代码只在这颗按钮可见时跑，开销可以忽略。 */
    const custom = CONF && CONF.overrideIcons && CONF.overrideIcons[window.QS_IMG];
    if (custom) {
        if (btnImg.dataset.custom !== custom) {
            btnImg.dataset.custom = custom;
            btnImg.innerHTML = '<img alt="" draggable="false">';
            const im = btnImg.querySelector('img');
            if (im) {
                im.src = custom;
                im.addEventListener('error', () => { im.style.visibility = 'hidden'; });
                /* r69：**和别的图标一样走「主体裁剪」**。
                 *
                 * 用户原话：「我在这个软件里面已经内置了说消除一个图标内除主体之外
                 * 多余部分的相关算法，但好像在这上面也没有得到实施」。
                 *
                 * qsApplyOpticalScale 会把图里主体之外的透明/空白边裁掉再等比缩到格子里 ——
                 * 别的引擎图标、软件图标、收藏夹图标全都走它，只有识图这颗是漏的，
                 * 于是用户挑的图在这里显示得"偏小/带一圈空白"。
                 *
                 * ⚠ 开关跟设置里「统一图标大小」走同一个（unifyIcons !== false）。 */
                if (window.qsApplyOpticalScale) {
                    window.qsApplyOpticalScale(im, window.CONF ? window.CONF.unifyIcons !== false : true);
                }
            }
        }
    } else {
        /* r70：**内置 SVG 也要走「主体裁剪」**。
         *
         * 用户原话：「识图搜索的那个图标…大小不一致，并且消除主体以外多余部分的
         * 算法在这个图标上面也没有生效」。
         *
         * 根因有两半，都在这一行代码里补上：
         *   ① 尺寸：SVG 原来按 em 缩（~13px），邻居 <img> 吃满按钮内容盒（22px），
         *      观感就是"这颗小一圈"—— CSS 已改成 width/height:100%（见 bar.css）；
         *   ② 算法：qsApplyOpticalScale 以前只认 <img>（tagName !== 'IMG' 直接
         *      return），内联 SVG 从来没被调用过。shared.js r70 起支持 <svg>：
         *      序列化 → 同一条 canvas 测量管线 → 系数写回 --qs-optical。
         * 这颗内置 SVG 的 viewBox 留白约 12%（四角取景框不占满），量出来的系数
         * 会把主体撑到和铺满型图标一致。 */
        /* v1.5.19：内置默认图标从「内联 SVG」换成用户指定的「识图键.png」
         *  （base64 内嵌，见 shared.js 的 QS_IMG_ICON）。
         *
         *  两种情况下要重建按钮内容：
         *    ① 刚从「用户自定义图」切回默认 —— dataset.custom 标记还在；
         *    ② 第一次渲染 —— 按钮里还是 index.html 里那份静态 SVG 骨架。
         *  用 dataset.builtin 打标记，避免每次 syncImgBtn 都重建（重建会让
         *  <img> 重新解码，肉眼能看见闪一下）。 */
        if (btnImg.dataset.custom || !btnImg.dataset.builtin) {
            delete btnImg.dataset.custom;
            btnImg.innerHTML = '';
            btnImg.dataset.builtin = '1';
            btnImg.appendChild(imgIconNode());
        }
        const im = btnImg.querySelector('img');
        if (im && window.qsApplyOpticalScale) {
            window.qsApplyOpticalScale(im, window.CONF ? window.CONF.unifyIcons !== false : true);
        }
    }
}
/** 识图按钮的内置图标（四角取景框 + 放大镜），和 index.html 里那份一致。
 *  单独存一份是为了"换过自定义图标之后还能换回来"。
 *
 *  ⚠ **必须懒取**：这段代码在脚本求值时就跑，那时 `#btnImg` 可能还没解析出来
 *  （脚本在 <head> 里、或 DOM 还没到那一段），提前取会拿到空串，之后
 *  一换图标就再也换不回来 —— 表现是"清掉自定义图标后按钮变成空白"。
 *
 *  r70：缓存前把 `--qs-optical` 的 inline 样式剥掉。它会被 syncImgBtn 写到
 *  那颗活着的 SVG 上（统一图标大小的系数），连样式一起抄走的话，将来用户
 *  关掉「统一图标大小」再换回内置图标，旧系数会跟着回来 —— 图标莫名偏大。
 *  取不到 DOM 时退回 shared.js 的共享常量（QS_IMG_SVG），两条路都不会空。 */
let builtinImgSvgCache = '';
function builtinImgSvg() {
    if (builtinImgSvgCache) return builtinImgSvgCache;
    try {
        const el = document.getElementById('btnImg');
        // 只有还是内置 SVG 时才抄（万一已经被换成 <img>，抄来的就是那张图）
        if (el && el.querySelector('svg')) {
            const clone = el.cloneNode(true);
            const svg = clone.querySelector('svg');
            if (svg) svg.removeAttribute('style');
            builtinImgSvgCache = clone.innerHTML;
        }
    } catch (_) { }
    if (!builtinImgSvgCache && window.QS_IMG_SVG) builtinImgSvgCache = window.QS_IMG_SVG;
    return builtinImgSvgCache;
}

/** 「文件管理器」按钮 + r97「打开文件」按钮显不显示。
 *
 * 判据与后端 `paths::looks_like_path` 同源（盘符 / UNC / `.\` 相对 /
 * `%VAR%`），前后端各留一份是刻意的：前端要的是"别为了判一条路径去调一次
 * IPC"，后端要的是"别拿前端的话全信"（老版本前端、直接调命令的人都可能
 * 塞进来奇怪的东西）。两边用同一套口径，行为因此一致。
 *
 * ⚠ 宁可放过也不误判：误判的代价是横条上凭空多一个图标、点下去弹一个
 *   报错框，比「没认出来」烦人得多。
 *
 * r97：新增「📄 打开文件」按钮（用户原话：「还要再增加一个直达文件的功能，
 * 就是说我选中了一个文件路径，那这个时候横条上就会弹出一个按钮，点击这个
 * 按钮就会自动调用系统默认的相应文件的软件来打开这个文件」）。
 *
 * 分工：
 *   · 📁 `btnPath`     —— 在**文件管理器**里定位/打开（资源管理器）
 *   · 📄 `btnOpenFile` —— 用**系统默认程序**打开（.txt → 记事本）
 * 目录只有 📁（目录没有"默认程序"概念，双击它就是资源管理器打开）；
 * 文件两颗都给，用户要哪个点哪个。
 *
 * ⚠ 「是文件还是目录」必须问后端（`path_kind`）：`resolve` 要展开 `%VAR%`、
 *   拼工作目录、还原 `file://` 编码，前端重复一遍必然分叉。
 *   所以这里是"先按路径判据把 📁 显示出来，再异步问类型决定 📄 显不显示" ——
 *   📁 立即可见（不依赖 IPC），📄 等答案回来（一次 IPC 几毫秒，无感）。 */
function syncPathBtn() {
    const t = (currentText || '').trim();
    let hit = false;
    if (t && t.length <= 260 && !ocrOnly) {
        try {
            hit = !!window.qsLooksLikePath && window.qsLooksLikePath(t);
        } catch (_) {
            hit = false; // 判据出错就当没命中，绝不让一颗坏按钮卡住横条
        }
    }
    btnPath.hidden = !hit;
    if (hit) btnPath.title = '在文件管理器中打开：' + t;
    /* r97：问后端「这条路径是文件还是目录」。
     * ⚠ 每次都重新问（不带缓存）：这段文字每次划词都可能不同，缓存反而要
     *   处理失效。path_kind 是只读命令，开销就是一次 IPC。 */
    if (btnOpenFile) {
        if (!hit) {
            btnOpenFile.hidden = true;
        } else {
            invoke('path_kind', { path: t })
                .then((kind) => {
                    /* 这段文字可能已经变了（用户又划了一次）—— 以当前为准。
                     * 不加这个判断就会出现"上一段是文件、这一段是目录，
                     * 结果 📄 按钮留在了目录那一轮上"。 */
                    if ((currentText || '').trim() !== t) return;
                    const isFile = (kind === 'file');
                    btnOpenFile.hidden = !isFile;
                    if (isFile) {
                        const name = t.split(/[\\/]/).pop() || t;
                        btnOpenFile.title = '用默认程序打开：' + name;
                    }
                })
                .catch(() => { btnOpenFile.hidden = true; });
        }
    }
}

/** 横条上的一句临时反馈（复用 #tip，和收藏夹「已发送」共用同一套显隐）。
 *
 * 为什么不做 toast 弹窗：横条是「跟着鼠标弹出来的无激活浮层」，弹一个
 * 自己的窗口会抢焦点、还可能被我们自己的失焦逻辑收掉。#tip 就在横条上，
 * 用户视线本来就在那儿。 */
function tip(msg) {
    try {
        tipEl.textContent = msg;
        tipEl.hidden = false;
        window.clearTimeout(tipTimer);
        tipTimer = window.setTimeout(() => {
            // 复位要按 renderBar 的规则（有引擎就藏起来），不能无条件 hidden ——
            // 不然横条上"没有可用的引擎"这条提示再也回不来。
            try { renderBar(true); } catch (_) {
                tipEl.hidden = true;
            }
        }, 1600);
    } catch (_) { }
}
let tipTimer = 0;

btnImg.addEventListener('click', (e) => {
    e.stopPropagation();
    // 走和 OCR 同一套框选遮罩（region.html?mode=img），截图完按配置跳浏览器
    invoke('img_start').catch(() => {});
});

btnPath.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = (currentText || '').trim();
    // 返回值是一句人话（成功/找不到/不像路径），原样说给用户听
    invoke('open_path', { path: t })
        .then((msg) => { if (msg) tip(msg); else tip('已打开'); })
        .catch(() => tip('打开失败'));
});

/* r97：「用默认程序打开这个文件」。与 📁 分工见 syncPathBtn 的注释。 */
if (btnOpenFile) {
    btnOpenFile.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = (currentText || '').trim();
        invoke('open_file', { path: t })
            .then((msg) => { if (msg) tip(msg); else tip('已打开'); })
            .catch(() => tip('打开失败'));
    });
}

btnMore.addEventListener('click', (e) => {
    e.stopPropagation();
    // 「⋯ 更多引擎」的语义 = 引擎面板的开关，和收藏夹面板互斥：
    //   · 收藏面板开着 → 点它 = 收起收藏、展开引擎面板（不是整个收起！
    //     以前直接 togglePanel()，收藏开着时把面板连锅端、panelFav 也清了，
    //     用户看到的就是「点更多引擎，收藏夹收了但更多引擎没出来」）；
    //   · 引擎面板开着 → 点它 = 收起；
    //   · 全收着 → 点它 = 展开引擎面板。
    if (!panelEl.hidden && !panelFav) togglePanel(false);
    else {
        panelFav = null;
        favFromEngines = false;
        togglePanel(true);
    }
});

/* 横条上没有关闭按钮：点是点别处由主程序收掉，ESC 也能关 */

/* ------------------------------------------------------------------ */
/* 交互：面板                                                          */
/* ------------------------------------------------------------------ */

/* 待机淡度的两个 hover 入口。mouseenter/leave 只在指针真的跨越元素边界时发，
 * 比轮询 :hover 便宜也可靠。面板开着时横条始终不透明（见 syncDim）。 */
barEl.addEventListener('mouseenter', () => { barHovered = true; syncDim(); });
barEl.addEventListener('mouseleave', () => { barHovered = false; syncDim(); });

function togglePanel(force) {
    const want = force === undefined ? panelEl.hidden : force;
    panelEl.hidden = !want;
    btnMore.classList.toggle('qs-active', want);
    // ⚠ fav-mode 只在**确实渲染了收藏面板**时才挂。以前在这里就挂，
    //   万一收藏树读不到（qsFavGroups 返回空 → renderFavPanel 退回引擎面板），
    //   引擎面板会顶着 400px 宽 + 无最大高度 + resize 的样式被撑满整屏 ——
    //   用户看到的"面板拉长到上下顶满"就是它。
    panelEl.classList.remove('fav-mode');
    // 西向缩放期间 stage 上预撑过 padding-left（横条因此在窗口内右移、窗口左缘
    // 向左扩出同等量）。收起时必须还原，否则横条会一直偏在窗口右侧、
    // 下次开引擎面板也跟着歪；同时把探出量归零。
    stage.style.removeProperty('padding-left');
    stage.style.removeProperty('padding-top');
    westOv = 0;
    favPinned = false;
    winOffX = 0;
    winOffY = 0;
    barEl.classList.remove('ghost');
    // r49：和上面挂 ghost 的那一处对称 —— 摘掉隐身时也要让玻璃层恢复（否则横条再出来时是空的）
    if (window.QSGlass && window.QSGlass.setBarGhost) window.QSGlass.setBarGhost(false);
    invoke('set_fav_pinned', { on: false }).catch(() => {});
    panelEl.style.removeProperty('left');
    panelEl.style.removeProperty('top');
    // 收藏模式给 stage 撑过的 min-height / min-width 也要还原，否则横条收起后
    // 窗口还是高高的/宽宽的（且下次引擎面板会被这块余高顶穿）
    stage.style.removeProperty('min-height');
    stage.style.removeProperty('min-width');
    // 收藏面板按屏幕算的纵向上限别带给引擎面板（引擎面板 body 自有 344px 上限）
    panelEl.style.removeProperty('max-height');

    if (want) {
        /* r51 速度：把「点开面板」拆成四段，探针直接读 window.__qsPanelTiming ——
         * 用户说"更多引擎页面打开慢"，到底是**建 DOM**、**IPC+摆窗**、还是**合成上屏**，
         * 光看一个总数看不出来，这四个数能。
         *   built      = 面板 DOM 建完（renderPanel 返回）
         *   layoutSent = 尺寸载荷发出去的时刻
         *   layoutDone = Rust 摆完窗口、IPC 回来的时刻
         *   painted    = 再过两帧（真的画到屏幕上） */
        const T = window.__qsPanelTiming =
            { t0: performance.now(), built: 0, layoutSent: 0, layoutDone: 0, painted: 0 };
        /* #139：面板内容按当前主题渲染。落色变量本身在 .stage 上是活的，
         * 但"打开面板"这一刻重放一次幂等的主题，能兜住事件在隐藏窗口期间
         * 被吞、或载荷比最近一次 show_bar 还新等情况。 */
        if (lastThemePayload) applyThemePayload(lastThemePayload);
        if (panelFav) renderFavPanel();
        else {
            // 引擎面板不吃收藏面板被拉过的尺寸（那是按目录记的）
            panelEl.style.removeProperty('width');
            panelEl.style.removeProperty('height');
            renderPanel(true);   // true = 打开面板，把光标送进引擎搜索框
            T.built = Math.round(performance.now() - T.t0);
            // 两帧之后才算真的画到屏幕上（合成 + 玻璃那套也在这一帧里结算）
            requestAnimationFrame(() => requestAnimationFrame(() => {
                T.painted = Math.round(performance.now() - T.t0);
            }));
        }
        invoke('focus_bar', { enable: true }).catch(() => {});
    } else {
        panelFav = null;   // 收起就退出收藏模式，下次 ⋯ 还是引擎面板
        favFromEngines = false;
        /* 过滤复位：下次打开面板是「全部引擎」，不接着上次筛的那一类。
         *
         * ⚠ 三层筛子必须**一起**复位。以前只清了 panelGroupFilter，中类 / 小类
         *   那两个留在内存里 —— 而二级、三级胶囊是"选了大类才出现"的，
         *   panelGroupFilter 一清，胶囊也就不画了：那个筛子从此既看不见、
         *   也点不掉，正文永远只剩它筛出来的那半截。
         *   用户报的「搜哔哩哔哩只搜得到首页、搜不到搜索引擎」就是它
         *   （中类停在「直达网页」，search 类的引擎全被筛掉）。 */
        panelGroupFilter = null;
        panelSubFilter = null;
        panelCatFilter = null;
        panelSearchMode = false;
        // 搜索框跟着一起清：它是一个**一次性**的关键词口，留到下次打开就是
        // 用户说的"输入框带记忆功能"（下次点引擎会拿上次的词去搜）。
        inputQ.value = '';
        // 引擎过滤词同理：下次打开应该是"全部引擎都在"，而不是上次筛剩的那几个
        const hadFilter = !!engineFilterText || panelSearchMode;
        if (inputEngFilter) inputEngFilter.value = '';
        engineFilterText = '';
        /* 2026-10-25：**DOM 上的过滤状态也必须撤干净**，不能只清变量。
         *
         * 以前这里只把 engineFilterText 置空，被 `cell.hidden = true` 藏掉的
         * 格子原样留着 —— 反正"下次打开必然重画"，脏状态会被 textContent=''
         * 抹掉，看不出来。
         *
         * 但 renderPanel 现在改成了"指纹没变就不重建"：DOM 不清的话，再打开
         * 会命中缓存，用户看到的是上次筛剩下的那半截列表 —— 比闪烁更糟。
         * 所以这里显式翻回来（applyEngineFilter('') 就是干这个的：取消所有
         * hidden、还原分类标题、还原「最近使用」那一栏）。
         *
         * 面板此刻已经 hidden，这几百次 hidden 赋值用户看不见，也不会引发
         * 额外的重排 —— 只改 class/属性，没有几何变化。 */
        if (hadFilter && panelBody.childElementCount) applyEngineFilter('');
        else setRecentSectionHidden(false);
        invoke('focus_bar', { enable: false }).catch(() => {});
    }
    // 面板开合直接决定横条该不该淡（开着 = 用户在里面点东西，横条陪着亮着）
    syncDim();
    /* 面板开合也算"在用它"：开着时停掉无操作计时，收起后重新开始计。
     * （armIdle 自己会看 panelEl.hidden，这里两边都调一次是最省事的写法。） */
    armIdle();
    // 布局变了，等一帧再量
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
    // 窗口矩形跟着变了 → 玻璃纹理要按新矩形重抓（需求 6）
    glassRefit();
}

/** 玻璃纹理跟着窗口矩形重新对齐（需求 6：面板也得是玻璃）。
 *
 *  玻璃纹理是 Rust 按**窗口矩形**抓的一整块。面板开合/拖动会改变窗口矩形 ——
 *  不重抓的话，新长出来那块区域没有背景（表现就是"面板不跟主题走"：其实底下
 *  根本没有玻璃）。Rust 在 layout_bar 里只更新"待抓矩形"（那一刻窗口正在屏上，
 *  直抓会把横条自己拍进去），真正的抓屏由这里发起：QSGlass.refresh() 会先把
 *  舞台隐藏、等两帧，所以抓到的仍是干净桌面。
 *
 *  ⚠ 必须等摆位落地：togglePanel 里 pushLayout 是 IPC 过去之后 Rust 才
 *    SetWindowPos，立刻 refresh 抓的还是旧矩形。两次（250/700ms）是为了兜
 *    "慢一拍的摆位"；refresh 自己有在途去重（captureBusy），多调一次不会叠加
 *    抓屏，也不会闪。 */
function glassRefit() {
    if (!window.QSGlass) return;
    const once = () => { try { QSGlass.refresh(); } catch (e) { } };
    setTimeout(once, 250);
    setTimeout(once, 700);
}

/* 引擎面板的一次搜索。
 *
 * 用的文字按优先级取：
 *   ① 面板输入框里**手打的关键词**（有就优先，这是用户当下明确的意图）；
 *   ② **横条此刻这条文字**（currentText，就是唤起横条时那份选中/复制的内容）；
 *   ③ 都没有 → 传 null，留给后端用它自己记的选区兜底。
 *
 * ⚠ ② 这一步以前是**完全**交给后端 `sel` 兜的（text 一律传 null）。但 `sel` 是
 *   一个全局态，别条路也会写它（比如快捷键唤收藏夹那条 `show_bar("")` 会把它
 *   清空、OCR-only 那条同理）—— 前端手里的 currentText 才是"横条现在这条"的
 *   唯一权威，直接带上最不容易错。
 *
 * ⚠ 搜完**一律把输入框清空**。它是"一次性关键词口"：留着的话，下一次点引擎
 *   会拿上一次的词去搜（用户报的「这输入框带记忆功能，搜一次就该清掉」）。 */
/* ------------------------------------------------------------------ */
/* 网格页（Ctrl+C）                                                     */
/* ------------------------------------------------------------------ */

/** 当前是不是网格形态（决定 pushLayout 之后要不要恢复文字横条的排版）。 */
let gridOn = false;

/** 网格里可以放的特殊按钮 → 显示名与点击动作。
 *  这些不是"搜索引擎"，点下去走各自原来那条路（复用横条上那颗按钮的点击）。 */
const GRID_SENTINELS = {
    '@ocr': { label: '文字识别' },
    '@trans': { label: '翻译' },
    '@img': { label: '识图' },
    // 包裹符号：点一下直接打开包裹菜单（把剪贴板/当前这段文字套成一对符号）
    '@wrap': { label: '包裹符号' },
};

/** 三类「模型」：文字识别 / 识图 / 翻译各自的引擎清单。
 *
 *  为什么要单独拉一份：网格的"添加内容"选板里，用户搜「百度」时应该既看到
 *  百度搜索，也看到**百度 OCR**；搜「翻译」时应该看到翻译模型而不是只有搜索引擎。
 *  这些清单在 Rust 那边是注册表，前端只通过命令读，避免两处各写一份名字。
 *
 *  ⚠ 格子本身仍然只是"这个功能"（`@ocr` / `@img` / `@trans`）—— 具体用哪一家
 *  由 设置 → 附加功能 里选中的模型决定。这里把模型列出来是为了**能被搜到、
 *  能看清有哪些**，不是给每一格单独绑模型。 */
const GRID_MODELS = { ocr: [], img: [], trans: [] };

async function loadGridModels() {
    const grab = async (cmd, key) => {
        try {
            const r = await invoke(cmd);
            if (Array.isArray(r)) GRID_MODELS[key] = r;
        } catch (_) { /* 命令不可用：该分组直接不出现，不影响其它内容 */ }
    };
    await Promise.all([
        grab('ocr_engines_list', 'ocr'),
        grab('img_engines_list', 'img'),
        grab('trans_engines_list', 'trans'),
    ]);
}

/** 内置功能格子的点击动作。
 *
 *  ⚠ 以前这里是 `document.getElementById(sent.btn).click()` —— 但横条上**根本没有
 *  btnTrans / btnWrap 这些按钮**（翻译是作为 bar_list 成员动态渲染出来的），
 *  于是网格里的「翻译」点了完全没反应（用户报的原话）。
 *  改成直连后端命令，和横条上那颗按钮走的是同一条路。 */
function runGridFunc(key) {
    const t = (currentText || '').trim();
    if (key === '@ocr') {
        invoke('ocr_start').catch(() => { });
        return;
    }
    if (key === '@img') {
        invoke('img_start').catch(() => { });
        return;
    }
    if (key === '@trans') {
        // 没文字也照发（后端会开一个空翻译窗让用户自己粘贴），与横条一致
        invoke('trans_start', { text: t || null }).catch(() => { });
        return;
    }
    if (key === '@wrap') {
        openWrapMenu();
    }
}

/* ------------------------------------------------------------------ */
/* 点空位 → 「添加内容」面板                                           */
/* ------------------------------------------------------------------ */

/** 最近一次网格载荷（往格子里加完内容要按它重画）。 */
let gridLast = null;

/* ---------------- 多页 ---------------- */
/** 全部网格页（`[{id,name,items}]`），来自载荷。 */
let gridPages = [];
/** 当前显示第几页（下标）。 */
let gridPageIdx = 0;
/** 这次唤起是哪个应用叫出来的（进程名，可能为空）——滚轮切页要按它记住。 */
let gridApp = '';
/** 滚轮切页的节流：一次滚轮会连发很多条，不节流会"一滑翻三页"。 */
let gridWheelAcc = 0;
let gridWheelAt = 0;
/** 「这个应用看哪页」的落盘节流。
 *  每翻一页就写一次配置太重（配置是加密落盘的，还会广播一轮），
 *  连续翻五页没必要写五次 —— 400ms 合并成一次，收起时再兜底刷一次。 */
let gridPersistTimer = 0;
let gridPersistDirty = false;

/** 当前页对象（永远不返回 null）。 */
function gridPageNow() {
    return gridPages[gridPageIdx] || { id: '', name: '默认', items: (gridLast && gridLast.items) || [] };
}

/** 按当前状态拼一份载荷 —— 改完内容重画用（避免各处各拼一份、漏字段）。 */
function gridPayloadNow() {
    return Object.assign({}, gridLast || {}, {
        pages: gridPages,
        active: gridPageIdx,
        items: gridPageNow().items,
    });
}

/** 点格子行为（auto / home），由载荷给。 */
let gridClickMode = 'auto';

/** 空位能不能点开添加面板。 */
let gridAllowAdd = true;

/** 是不是"编辑模式"：格子上出现删除角标，点一下就移出。
 *  纯 UI 状态，不进配置（下次唤起就是正常模式）。 */
let gridEdit = false;

/** 正在给第几个空位选内容；-1 = 没在选。 */
let gridPickAt = -1;

/** 能往网格里加的东西，按用户要求分三组：内置功能 / 智能直达 / 引擎。 */
function gridPickGroups() {
    const inGrid = new Set((gridLast && Array.isArray(gridLast.items)) ? gridLast.items : []);
    const groups = [];

    // ① 软件内置功能（文字识别 / 翻译 / 识图）—— 即"当前软件内置的功能"
    const builtin = [];
    for (const key of ['@ocr', '@trans', '@img', '@wrap']) {
        const meta = GRID_SENTINELS[key];
        if (!meta || inGrid.has(key)) continue;
        builtin.push({
            name: key,
            label: meta.label,
            // 图标与横条上那颗同一套（以前这里是 emoji，和设置里对不上）
            node: () => (window.qsFuncIcon ? window.qsFuncIcon(key) : document.createTextNode('•')),
        });
    }
    if (builtin.length) groups.push({ title: '内置功能', items: builtin });

    // ② 智能直达（图标走统一的内置图 / 用户自定义图）
    const goItems = [];
    for (const it of ((window.CONF && window.CONF.shortcuts) || [])) {
        if (!it || !it.id) continue;
        const sentinel = window.QS_GO_PREFIX + it.id;
        if (inGrid.has(sentinel)) continue;
        goItems.push({
            name: sentinel,
            // 备注优先（备注 = 自动抓来的网页标题，比域名好认）
            label: (it.note || '').trim() || it.name || it.target,
            node: () => window.qsGoIconNode(sentinel),
        });
    }
    if (goItems.length) groups.push({ title: '智能直达', items: goItems });

    /* ②-b 收藏夹（v2.6.2）：一格 = 一个目录，加进去的是 `@fav:<id>` 哨兵。
     * 点格子会像横条上那颗收藏夹按钮一样展开这个目录（见 renderGrid 的哨兵分支），
     * 目录里的条目再点一下就是复制/注入到原软件。 */
    const favItems = [];
    const walkFav = (g, lv) => {
        if (!g || !g.id) return;
        const sent = QS_FAV_PREFIX + g.id;
        if (!inGrid.has(sent)) {
            favItems.push({
                name: sent,
                label: (lv ? '\u3000'.repeat(lv) + '└ ' : '') + (g.name || '收藏夹'),
                node: () => (window.qsFavIconNode ? window.qsFavIconNode(sent) : document.createTextNode('★')),
            });
        }
        for (const sub of (g.children || [])) walkFav(sub, lv + 1);
    };
    for (const g of window.qsFavGroups()) walkFav(g, 0);
    if (favItems.length) groups.push({ title: '收藏夹', items: favItems });

    // ③ 引擎（工具栏 + 全部分类，按名字去重；同样的名字在网格里只该出现一次）
    const seen = new Set();
    const engItems = [];
    const pushEng = (n) => {
        if (!n || seen.has(n) || inGrid.has(n)) return;
        seen.add(n);
        engItems.push({ name: n, label: n, eng: true });
    };
    try {
        for (const c of (CATALOG.categories || [])) for (const e of (c.engines || [])) pushEng(e.name);
        for (const e of (CATALOG.toolbar || [])) pushEng(e.name);
    } catch (_) { /* 目录还没加载出来就只显示前两组 */ }
    /* ②-c 三类「模型」：文字识别 / 识图 / 翻译，**各自成组**。
     *
     *  用户口径：「OCR 模型、图片识别模型、翻译模型等应能被搜索到并分别展示」——
     *  以前这里只有「内置功能 / 智能直达 / 收藏夹 / 引擎」，搜「百度」只能搜到
     *  搜索引擎，搜「翻译」只看得到那颗通用按钮，看不出有哪些模型可用。 */
    const addModelGroup = (title, list, sentinel, activeIds) => {
        if (!list.length || inGrid.has(sentinel)) return;
        const items = list.map((m) => ({
            name: sentinel,
            label: (m.name || m.id) + (activeIds.has(String(m.id)) ? '（当前使用）' : ''),
            /* 每行都用**功能自己的图标**：这三组的条目最终加进网格的就是那颗功能格子，
             * 用各家模型自己的 logo 反而会让人以为"这一格单独绑了那一家"。 */
            node: () => (window.qsFuncIcon ? window.qsFuncIcon(sentinel) : document.createTextNode('•')),
        }));
        if (items.length) groups.push({ title, items });
    };
    const imgOn = new Set(((window.CONF && window.CONF.imgEngines) || []).map(String));
    addModelGroup('文字识别模型', GRID_MODELS.ocr, '@ocr',
        new Set([String((window.CONF && window.CONF.ocrEngine) || '')]));
    addModelGroup('识图模型', GRID_MODELS.img, '@img', imgOn);
    addModelGroup('翻译模型', GRID_MODELS.trans, '@trans',
        new Set([String((window.CONF && window.CONF.transEngine) || '')]));

    if (engItems.length) groups.push({ title: '引擎', items: engItems });

    return groups;
}

/** 关掉选板（顺带把借来的焦点还回去）。 */
function closeGridPicker() {
    const p = barEl.querySelector('.qs-gpick');
    if (p) p.remove();
    gridPickAt = -1;
    if (gridPickFocusHeld) {
        gridPickFocusHeld = false;
        invoke('focus_bar', { enable: false }).catch(() => { });
    }
}

/** 进入 / 退出编辑模式。只切 UI，不动配置。 */
function toggleGridEdit() {
    gridEdit = !gridEdit;
    barEl.classList.toggle('qs-gedit', gridEdit);
    const b = document.getElementById('qsGridEdit');
    if (b) {
        b.classList.toggle('on', gridEdit);
        b.title = gridEdit ? '退出编辑（回到只读）' : '编辑格子：进入后才能添加内容、点 × 移出';
    }
    closeGridPicker();
    // 用当前页的内容重画（多页下不能再去读 CONF.gridItems —— 那是默认页的）
    renderGrid(gridPayloadNow());
    showBarTip(gridEdit ? '编辑模式：点空格子添加，点 × 移出' : '已退出编辑（只读）');
}

/** 把第 i 项从网格页移出（不删智能直达/引擎本身）。 */
async function gridRemoveAt(i) {
    const pg = gridPageNow();
    const cur = (Array.isArray(pg.items) ? pg.items : []).slice();
    if (i < 0 || i >= cur.length) return;
    const name = cur[i];
    cur.splice(i, 1);
    try {
        // 只改**当前这一页**（page 带上 id；空 id = 老单页载荷，后端按默认页处理）
        await invoke('set_grid_items', { items: cur, page: pg.id || null });
        pg.items = cur;
        renderGrid(gridPayloadNow());
        showBarTip('已移出：' + (window.qsDisplayName ? window.qsDisplayName(name) : name));
    } catch (e) {
        showBarTip('移出失败：' + String(e || '').slice(0, 40));
    }
}

/** 选板是否替我们向系统"借"过前台焦点（见 openGridPicker）。
 *  借了就要还 —— 不还的话关掉选板后键盘还锁在横条上，用户在别的软件里
 *  打字会全部落空。 */
let gridPickFocusHeld = false;

/** 切到上/下一页。`delta` = ±1。
 *
 *  - **首尾循环**：最后一页再往后回到第一页（页数通常只有两三页，循环比"卡住"
 *    更顺手，而且用户不会在边界上以为滚轮坏了）；
 *  - 只有一页时什么也不做（连提示都不给，避免噪音）；
 *  - 切页会**关掉"添加内容"选板**：它绑定的是某一个空格，换页后那个位置已经不对了；
 *  - 编辑模式、当前文字都保持 —— 用户可以在编辑态下连续改好几页；
 *  - 切完会把这个「应用 → 页」记下来（见 grid_app_page_set），
 *    下次在同一个应用里唤起还是这页。
 *
 * 返回是否真的切了（滚轮节流靠它判断要不要重置）。 */
function switchGridPage(delta) {
    const n = gridPages.length;
    if (n < 2) return false;
    const next = ((gridPageIdx + delta) % n + n) % n;
    if (next === gridPageIdx) return false;
    gridPageIdx = next;
    closeGridPicker();
    renderGrid(gridPayloadNow());
    const pg = gridPageNow();
    if (pg.id && gridApp) persistGridPageSoon();
    showBarTip('第 ' + (next + 1) + '/' + n + ' 页 · ' + (pg.name || '未命名'));
    return true;
}

/** 把「当前应用 → 当前页」记下来（400ms 合并一次）。 */
function persistGridPageSoon() {
    if (!gridApp) return;
    gridPersistDirty = true;
    if (gridPersistTimer) return;
    gridPersistTimer = setTimeout(() => {
        gridPersistTimer = 0;
        flushGridPagePersist();
    }, 400);
}

/** 立刻落盘（收起 / 切页结束都要调，不能把用户刚翻的页丢掉）。 */
function flushGridPagePersist() {
    if (!gridPersistDirty) return;
    gridPersistDirty = false;
    const pg = gridPageNow();
    if (!gridApp || !pg.id) return;
    invoke('grid_app_page_set', { app: gridApp, page: pg.id }).catch(() => { });
}

/** 清掉上一次网格会话的临时状态（每次唤起网格页时调）。
 *  只清 UI 状态，**不动配置** —— 格子内容仍然是用户保存的那份。 */
function resetGridTransient() {
    // 先把手头没落盘的那次切页写掉（用户翻完立刻按 Esc 的场景）
    flushGridPagePersist();
    gridEdit = false;
    barEl.classList.remove('qs-gedit');
    closeGridPicker();          // 顺手把焦点还回去
    gridPickAt = -1;
    gridWheelAcc = 0;
    gridWheelAt = 0;
    if (gridPersistTimer) { clearTimeout(gridPersistTimer); gridPersistTimer = 0; }
}

/** 打开选板。`index` = 被点的空位下标（新内容插到这个位置）。 */
async function openGridPicker(index) {
    gridPickAt = typeof index === 'number' ? index : -1;
    renderGridPicker();
    /* 横条默认是"不抢焦点"的浮层（WS_EX_NOACTIVATE）：鼠标点得动，但键盘
     * 永远进不来 —— 表现就是选板里的搜索框点了也没法打字（用户报的）。
     * 引擎面板打开时做的是同一件事（focus_bar(true)），这里照抄。
     * 引擎面板已经借过焦点时不重复借，免得关选板时把它的焦点也一起还了。 */
    if (panelEl.hidden && !gridPickFocusHeld) {
        gridPickFocusHeld = true;
        try { await invoke('focus_bar', { enable: true }); } catch (_) { }
    }
    focusGridPickSearch();
}

/** 把光标送进选板的搜索框（刚建出来时元素还没完成布局，聚焦可能落空，
 *  所以补一次延时重试 —— 和设置页那个弹窗同一个坑）。 */
function focusGridPickSearch() {
    const q = barEl.querySelector('.qs-gpick-search');
    if (!q) return;
    q.focus();
    requestAnimationFrame(() => { const el = q; if (el && document.contains(el)) el.focus(); });
    setTimeout(() => { if (document.contains(q)) q.focus(); }, 80);
}

/** 画选板。外壳只建一次，之后换搜索词只重画列表 —— 否则每敲一个字
 *  输入框都会被重建，焦点直接丢掉。 */
function renderGridPicker(query) {
    let box = barEl.querySelector('.qs-gpick');
    if (!box) {
        box = document.createElement('div');
        box.className = 'qs-gpick';

        const head = document.createElement('div');
        head.className = 'qs-gpick-head';
        const ti = document.createElement('span');
        ti.className = 'qs-gpick-title';
        ti.textContent = '添加到这一格';
        head.appendChild(ti);
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'qs-gbtn';
        x.title = '关闭';
        x.textContent = '✕';
        x.addEventListener('click', closeGridPicker);
        head.appendChild(x);
        box.appendChild(head);

        const q = document.createElement('input');
        q.className = 'qs-gpick-search';
        q.type = 'text';
        q.spellcheck = false;
        q.placeholder = '搜索引擎 / 智能直达 / 收藏夹 / 识别·识图·翻译模型';
        q.addEventListener('input', () => renderGridPicker());
        // 选板里打字不应该被横条的按键处理截走（Esc 留给全局关闭）
        q.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') e.stopPropagation();
        });
        box.appendChild(q);

        const body = document.createElement('div');
        body.className = 'qs-gpick-body';
        box.appendChild(body);

        barEl.appendChild(box);
        q.focus();
    }
    const q = box.querySelector('.qs-gpick-search');
    if (typeof query === 'string' && q.value !== query) q.value = query;
    renderGridPickBody(box.querySelector('.qs-gpick-body'), (q.value || '').trim().toLowerCase());
}

/** 选板里的列表主体。 */
function renderGridPickBody(body, kw) {
    if (!body) return;
    body.textContent = '';
    let shown = 0;
    for (const g of gridPickGroups()) {
        const items = kw
            ? g.items.filter((it) => String(it.label || it.name).toLowerCase().includes(kw))
            : g.items;
        if (!items.length) continue;
        const ct = document.createElement('div');
        ct.className = 'qs-gpick-cat';
        ct.textContent = g.title;
        body.appendChild(ct);
        for (const it of items) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qs-gpick-item';
            const ic = document.createElement('span');
            ic.className = 'qs-gpick-ic';
            if (it.node) {
                ic.appendChild(it.node());
            } else if (it.eng) {
                try {
                    ic.appendChild(buildIconInner(it.name).node);
                } catch (_) {
                    ic.textContent = '🔎';
                }
            } else {
                ic.textContent = it.icon || '•';
            }
            b.appendChild(ic);
            const nm = document.createElement('span');
            nm.className = 'qs-gpick-nm';
            nm.textContent = it.label || it.name;
            b.appendChild(nm);
            b.title = String(it.label || it.name);
            b.addEventListener('click', () => gridAddItem(it.name));
            body.appendChild(b);
            shown++;
        }
    }
    if (!shown) {
        const e = document.createElement('div');
        e.className = 'qs-gpick-empty';
        e.textContent = kw ? '没找到匹配的内容' : '没有可添加的内容了（都已在网格里）';
        body.appendChild(e);
    }
}

/** 把 `name` 加到被点的那一格。落库走 `set_grid_items`，和其它改动同一套。 */
async function gridAddItem(name) {
    if (!name) return;
    const pg = gridPageNow();
    const cur = (Array.isArray(pg.items) ? pg.items : []).slice();
    if (cur.includes(name)) {
        showBarTip('这一项已经在网格里了');
        return;
    }
    // 插到被点的那个位置；位置超出当前长度就追加（空位本来就在末尾之后）
    const at = Math.max(0, Math.min(gridPickAt >= 0 ? gridPickAt : cur.length, cur.length));
    cur.splice(at, 0, name);
    try {
        await invoke('set_grid_items', { items: cur, page: pg.id || null });
        pg.items = cur;
        closeGridPicker();
        renderGrid(gridPayloadNow());
        showBarTip('已添加');
    } catch (e) {
        showBarTip('添加失败：' + String(e || '').slice(0, 50));
    }
}

/** 退出网格形态：摘类名、把文字横条的成员重新画回来。
 *
 *  注意这里**不重建 DOM**：紧接着 qs://show 的正常分支会走它自己那套渲染
 *  （renderBar），这里只负责把网格留下的痕迹清掉（类名 + 网格变量）。 */
function exitGridMode() {
    if (!gridOn) return;
    gridOn = false;
    barEl.classList.remove('qs-grid');
    barEl.classList.remove('qs-gnolabel');
    barEl.style.removeProperty('--gcols');
    barEl.style.removeProperty('--grows');
    barEl.style.removeProperty('--gcw');
    barEl.style.removeProperty('--gch');
    /* 头部（网格页 / ⚙）和「添加内容」选板都是**网格专属**的 DOM，
       它们挂在 #bar 上、不是 #bar 的子 —— 不摘掉，下一次文字横条重画时
       会莫名其妙多出一颗齿轮。 */
    const h = barEl.querySelector('.qs-ghead');
    if (h) h.remove();
    const p = barEl.querySelector('.qs-gpick');
    if (p) p.remove();
    /* 编辑态也跟着退出：不然下一次唤起还是"带 × 的编辑版"，
     * 用户会以为程序坏了（编辑是临时动作，不该跨次生效）。 */
    gridEdit = false;
    barEl.classList.remove('qs-gedit');
    gridPickAt = -1;
    gridLast = null;
    gridPages = [];
    gridPageIdx = 0;
    gridApp = '';
}

/** 画网格页。`g` = { rows, cols, cellW, cellH, items[] } */
function renderGrid(g) {
    gridOn = true;
    // 记住这一次的载荷：往格子里加完内容要按它重画（后端广播只带 config，
    // 不会重发 grid 载荷），见 gridAddItem。
    gridLast = g;
    const rows = Math.max(1, Math.min(10, g.rows | 0 || 3));
    const cols = Math.max(1, Math.min(10, g.cols | 0 || 3));
    const cw = Math.max(40, Math.min(260, g.cellW | 0 || 104));
    const ch = Math.max(40, Math.min(200, g.cellH | 0 || 76));
    /* 多页：载荷里 `pages` 是整份页列表，`active` 是这次该显示哪一页
     * （后端按"这个应用绑了哪页"算好）。老载荷没有 pages 时退化成单页。 */
    gridPages = (Array.isArray(g.pages) && g.pages.length)
        ? g.pages
        : [{ id: '', name: '默认', items: Array.isArray(g.items) ? g.items : [] }];
    const wantIdx = Math.max(0, Math.min(gridPages.length - 1, g.active | 0));
    // 只有"换了一次唤起"才采纳载荷里的 active；页内重画（编辑/增删）保留用户当前翻到的那页
    if (g.__fresh !== false) gridPageIdx = wantIdx;
    if (g.app !== undefined) gridApp = String(g.app || '');
    const items = Array.isArray(gridPageNow().items) ? gridPageNow().items : [];

    // 间距与格子圆角：和设置页预览取自同一份配置（gap / radius）
    const gap = Math.max(0, Math.min(24, g.gap | 0 || (g.gap === 0 ? 0 : 8)));
    const grad = Math.max(0, Math.min(24, g.radius | 0 || (g.radius === 0 ? 0 : 12)));
    // 点格子行为：auto = 有文字就搜；home = 永远开首页
    gridClickMode = (g.click === 'home') ? 'home' : 'auto';
    gridAllowAdd = g.allowAdd !== false;

    barEl.classList.add('qs-grid');
    /* 「格子文字」：默认显示名称；用户在 设置 → 网格页设置 → 外观 里选"只显示图标"
     * 时整条藏掉名称（格子会显得更清爽，小尺寸格子也不会被文字挤爆）。 */
    /* 高度小于 66px 时**自动只显图标**：那时图标 + 名称根本放不下，
     * 强行并排只会把字裁成半截（用户把格子调矮时的观感）。 */
    barEl.classList.toggle('qs-gnolabel', g.showLabel === false || ch < 66);
    barEl.style.setProperty('--gcols', String(cols));
    barEl.style.setProperty('--grows', String(rows));
    barEl.style.setProperty('--gcw', cw + 'px');
    barEl.style.setProperty('--gch', ch + 'px');
    barEl.style.setProperty('--ggap', gap + 'px');
    barEl.style.setProperty('--gr', grad + 'px');

    /* 头部：左边一句页码说明，右边一颗 ⚙ 直通设置。
     * 每帧都复用同一个节点（只建一次），否则反复唤起会叠加监听。 */
    let head = barEl.querySelector('.qs-ghead');
    if (!head) {
        head = document.createElement('div');
        head.className = 'qs-ghead';
        const t = document.createElement('span');
        t.className = 'qs-gtitle';
        t.textContent = '网格页 · 点空格子添加内容';
        head.appendChild(t);

        /* 翻页器：‹ 页名 1/3 ›。只有一页时整块隐藏（别让用户以为坏了）。
         * 滚轮也能翻（见下方 wheel 处理），这两个箭头是给鼠标党/触控板的兜底。 */
        const pager = document.createElement('span');
        pager.className = 'qs-gpager';
        pager.hidden = true;
        const mk = (dir, label, ch) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qs-gpbtn';
            b.dataset.d = String(dir);
            b.textContent = ch;
            b.title = label;
            b.setAttribute('aria-label', label);
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                switchGridPage(dir);
            });
            return b;
        };
        pager.appendChild(mk(-1, '上一页', '‹'));
        const nm = document.createElement('span');
        nm.className = 'qs-gpname';
        pager.appendChild(nm);
        const num = document.createElement('span');
        num.className = 'qs-gpnum';
        pager.appendChild(num);
        pager.appendChild(mk(1, '下一页', '›'));
        head.appendChild(pager);
        const gb = document.createElement('button');
        gb.type = 'button';
        gb.className = 'qs-gbtn';
        gb.id = 'qsGridSet';
        gb.title = '打开设置';
        gb.setAttribute('aria-label', '打开设置');
        // 滑块样式的齿轮图标：比放射状齿轮稳，小尺寸下也看得清
        gb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/>'
            + '<circle cx="15" cy="8" r="2.1"/><circle cx="9" cy="16" r="2.1"/></svg>';
        gb.addEventListener('click', () => {
            /* 网格页上的「设置」：直接进设置界面。
             * 先藏横条再开设置 —— 不然两层浮层叠在一起，设置窗会被挡在下面。
             * tab 给 grid：网格页的行列/外观/功能/内容现在集中在「网格页设置」里。 */
            closeGridPicker();
            invoke('hide_bar').catch(() => {});
            invoke('open_settings', { focusEngine: null, tab: 'grid' }).catch(() => {});
        });
        head.appendChild(gb);

        /* 编辑按钮：进入/退出编辑模式。放在 ⚙ 左边（⚙ 永远是最后一颗，
         * 位置不变，用户不会点错）。 */
        const eb = document.createElement('button');
        eb.type = 'button';
        eb.className = 'qs-gbtn';
        eb.id = 'qsGridEdit';
        eb.title = '编辑格子：进入后才能添加内容、点 × 移出';
        eb.setAttribute('aria-label', '编辑格子');
        eb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/></svg>';
        eb.addEventListener('click', () => toggleGridEdit());
        head.appendChild(eb);

        barEl.insertBefore(head, enginesEl);
    }
    /* 标题跟着模式走：只读态明确告诉用户"要改得先进编辑"，
     * 编辑态告诉用户"现在能加、也能点 × 移出"。每帧都刷，因为
     * toggleGridEdit 就是靠重画这个网格来切模式的。 */
    const titleEl = head.querySelector('.qs-gtitle');
    if (titleEl) {
        titleEl.textContent = gridEdit
            ? '编辑模式 · 点空格子添加，点 × 移出'
            : '网格页 · 只读（点 ✏️ 编辑）';
    }
    const editBtn = head.querySelector('#qsGridEdit');
    if (editBtn) editBtn.setAttribute('aria-pressed', gridEdit ? 'true' : 'false');

    /* 翻页器状态：页名 + n/N；只有一页就整块收起来 */
    const pagerEl = head.querySelector('.qs-gpager');
    if (pagerEl) {
        const multi = gridPages.length > 1;
        pagerEl.hidden = !multi;
        if (multi) {
            const nmEl = pagerEl.querySelector('.qs-gpname');
            const numEl = pagerEl.querySelector('.qs-gpnum');
            if (nmEl) nmEl.textContent = gridPageNow().name || '未命名';
            if (numEl) numEl.textContent = (gridPageIdx + 1) + '/' + gridPages.length;
            pagerEl.title = '滚轮 / ← → 在网格页之间切换（共 ' + gridPages.length + ' 页）';
        }
    }

    enginesEl.textContent = '';
    const total = rows * cols;
    for (let i = 0; i < total; i++) {
        const name = items[i];
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'qs-gcell';
        if (!name) {
            /* 空位：**可点**（用户要求：点空白位置弹出添加面板）。
             * 原来这里是 disabled 的装饰性占位，用户看到虚框却点不动，
             * 想加内容只能跑去设置页 —— 现在就地能加。 */
            cell.classList.add('qs-gempty');
            const plus = document.createElement('span');
            plus.className = 'qs-gplus';
            plus.textContent = '+';
            cell.appendChild(plus);
            /* v2.6.2：网格页**默认只读** —— 空位只是占位，点它不弹添加面板；
             * 只有进了编辑模式（右上角 ✏️）才允许加内容。这样"看一眼网格"
             * 和"改网格"是两件事，不会手一滑就把内容加进去。
             * 设置里的「点空白格子可添加」仍然是总闸（关掉就编辑态也不给加）。 */
            const canAdd = gridEdit && gridAllowAdd;
            if (canAdd) {
                cell.title = '点一下添加内容（引擎 / 智能直达 / 收藏夹 / 内置功能）';
                cell.addEventListener('click', () => openGridPicker(i));
            } else {
                cell.title = gridAllowAdd
                    ? '只读：点右上角 ✏️ 进入编辑后才能添加'
                    : '空位（「点空白格子可添加」已在设置里关闭）';
                cell.style.cursor = 'default';
            }
            enginesEl.appendChild(cell);
            continue;
        }
        const sent = GRID_SENTINELS[name];
        if (sent) {
            cell.dataset.sentinel = name;
            const inner = document.createElement('span');
            inner.className = 'qs-gicon';
            // 图标与横条上那颗**同一套**（翻译就是翻译那张图，OCR 就是 OCR 徽标）
            inner.appendChild(window.qsFuncIcon ? window.qsFuncIcon(name) : document.createTextNode('•'));
            cell.appendChild(inner);
            const lb = document.createElement('span');
            lb.className = 'qs-glabel';
            lb.textContent = sent.label;
            cell.appendChild(lb);
            cell.title = sent.label;
            cell.addEventListener('click', () => runGridFunc(name));
        } else if (typeof name === 'string' && (name.startsWith(window.QS_GO_PREFIX || '@go:') || name.startsWith(QS_APP_PREFIX) || name.startsWith(QS_FAV_PREFIX))) {
            // 哨兵项（直达 / 外部软件 / 收藏夹）：图标与点击都复用横条那套
            const inner = document.createElement('span');
            inner.className = 'qs-gicon';
            if (name.startsWith(window.QS_GO_PREFIX)) inner.appendChild(window.qsGoIconNode(name));
            else if (name.startsWith(QS_APP_PREFIX)) inner.appendChild(appIconNode(name));
            /* 收藏夹格子必须走 favIconNode：buildIconInner 只认搜索引擎，
             * 给它 `@fav:xxx` 会生成一个 "F" 字母徽标（用户看到的就是这个乱码感）。 */
            else inner.appendChild(favIconNode(name));
            cell.appendChild(inner);
            const lb = document.createElement('span');
            lb.className = 'qs-glabel';
            const it = window.qsGoBySentinel(name) || qsAppBySentinel(name) || favGroupBySentinel(name);
            lb.textContent = (it && it.name)
                || (window.qsDisplayName ? window.qsDisplayName(name) : name);
            cell.appendChild(lb);
            cell.title = lb.textContent;
            cell.addEventListener('click', () => {
                if (name.startsWith(window.QS_GO_PREFIX)) {
                    invoke('shortcut_open', { id: name.slice(window.QS_GO_PREFIX.length) })
                        .catch((e) => showBarTip('打不开：' + String(e || '').slice(0, 60)));
                } else if (name.startsWith(QS_APP_PREFIX)) {
                    invoke('open_app', { id: name.slice(QS_APP_PREFIX.length), text: currentText || null })
                        .catch((e) => showBarTip('打不开：' + String(e || '').slice(0, 60)));
                } else {
                    openFavPanel(name);
                }
            });
        } else {
            // 普通引擎：图标 + 名字，点一下拿当前文字去搜（没文字就开首页）
            const icon = buildIconInner(name);
            const inner = document.createElement('span');
            inner.className = 'qs-gicon' + (icon.mono ? ' qs-mono' : '');
            inner.appendChild(icon.node);
            cell.appendChild(inner);
            const lb = document.createElement('span');
            lb.className = 'qs-glabel';
            // 可读名：普通引擎就是原名；哨兵（@ocr 之类）翻成中文，
            // 绝不让 "@//ocr/" 这种内部写法露到界面上
            const label = (window.qsDisplayName ? window.qsDisplayName(name) : name);
            lb.textContent = label;
            cell.appendChild(lb);
            const willSearch = gridClickMode === 'auto' && !!currentText;
            cell.title = label + (willSearch ? '　（点一下用这段文字搜索）' : '　（点一下打开首页）');
            cell.dataset.engine = name;
            cell.addEventListener('click', () => runEngineSearch(name, gridClickMode === 'home' ? null : undefined));
        }
        /* 编辑模式：每格右上角挂一个 ×，点它把这格内容移出网格页
         * （只动 grid_list，不删智能直达/引擎本身 —— 移出 ≠ 删除）*/
        if (gridEdit) {
            const del = document.createElement('span');
            del.className = 'qs-gdel';
            del.textContent = '×';
            del.title = '从网格页移出这一项';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                gridRemoveAt(i);
            });
            cell.appendChild(del);
        }
        enginesEl.appendChild(cell);
    }
    // 交给常规的尺寸上报：Rust 会按网格实际大小把窗口撑开
    pushLayout();
}

function runEngineSearch(engine, forceText) {
    if (!engine) return;
    const kw = inputQ.value.trim();
    // forceText === null → 明确要求"不带文字"（网格页的"总是打开首页"模式）
    const text = forceText === null ? '' : (kw || currentText || '');
    invoke('open_search', { engine, text: text ? text : null }).catch(() => {});
    inputQ.value = '';
}

/** 回车时用的默认引擎：上次用过的那个，没记录就横条上第一个。 */
function defaultEngine() {
    return (CONF && CONF.lastEngine) || barList()[0] || '';
}

/** 激活面板里一颗格子（点击 / 过滤框回车两条路共用）。
 *
 *  网页 / 快捷键引擎 → open_search（带上横条此刻这条文字）；
 *  外部软件（#135 起出现在平铺视图里）→ open_app：打开类原样拉起，
 *  搜索类由后端把当前文字拼进 %s（没有选中文字时报「先选中文字」）。 */
function activatePanelCell(cell) {
    if (!cell) return;
    if (cell.dataset.app) {
        invoke('open_app', { id: cell.dataset.app, text: currentText || null })
            .catch(() => {});
        return;
    }
    runEngineSearch(cell.dataset.engine);
}

panelBody.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    activatePanelCell(cell);
});

inputQ.addEventListener('keydown', (e) => {
    /* ⚠ 输入法保护：中文/日文输入法在**上屏候选词**时也会发 Enter
     *   （`isComposing` 为真，或旧内核给 keyCode 229）。不拦的话，用户打拼音
     *   按回车选词，会直接拿半截拼音去搜索并把横条收起来 —— 全项目此前
     *   一次 IME 判断都没有。 */
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
        runEngineSearch(defaultEngine());
    } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (inputQ.value) inputQ.value = '';
        else togglePanel(false);
    }
});

/* 引擎搜索框（面板头部，在关键词框右边）：边打边筛，回车就用第一个命中项。
 * ⚠ 它是常驻节点，监听只挂一次 —— 面板重画不会重建它，光标和词都不会丢。 */
if (inputEngFilter) {
    inputEngFilter.addEventListener('input', () => applyEngineFilter(inputEngFilter.value));
    inputEngFilter.addEventListener('keydown', (e) => {
        // IME 上屏的 Enter / Esc 不算（理由见关键词框那处注释）
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
            // 回车 = 「就用筛出来最前面那个」。用户多半是打了个名字片段想直接开跑，
            // 让他再回鼠标点一下是多余的；一个都没筛出来时什么都不做，不误触。
            // ⚠ 必须挑**看得见**的格子：过滤是"整格 hidden + 整块 grid hidden"
            //   两层，只判 cell 的话会选到藏在已隐藏 grid 里的那颗（比如搜索态
            //   被收起来的「最近使用」），用户按回车打开的就不是屏幕上第一个。
            const first = panelBody.querySelector('.grid:not([hidden]) > .cell:not([hidden])');
            if (first) activatePanelCell(first);
        } else if (e.key === 'Escape') {
            // 有词先清词，没词才收面板（和关键词框同一套手感）
            e.stopPropagation();
            if (inputEngFilter.value) {
                inputEngFilter.value = '';
                applyEngineFilter('');
            } else togglePanel(false);
        }
    });
}

btnPanelClose.addEventListener('click', () => {
    /* #141：从「更多引擎」面板点进收藏夹的，点收起**回到引擎面板**，
     * 不把整个面板关掉 —— 用户刚从那儿来，还可能想继续筛引擎。
     * 快捷键 / 横条收藏按钮唤起的收藏夹没有上一级，照旧整个收起。
     *
     * #153：回程必须走 togglePanel(true)，不能直接 renderPanel()。
     * 收藏面板是**另一套盒模型**（.fav-mode：position:absolute、
     * 内联 width/height、overflow:hidden、#engFilter 被 display:none、
     * stage 上还撑着 min-width/min-height、winOffX/winOffY 偏移、
     * fav-pinned 标记……十几项 fav-mode 专属状态）。以前只把
     * panelFav 清成 null 就 renderPanel，这些状态全部残留：引擎格子
     * 被 absolute + 固定高裁掉、搜索框整个隐身、横条偏在窗口一角 ——
     * 用户看到的"页面显示不完整"就是它。togglePanel 开头那一整套
     * removeProperty / 复位正是为回程准备的，复用它。 */
    if (panelFav && favFromEngines) {
        // ⚠ 必须先摘 panelFav：togglePanel(true) 里是 `if (panelFav)
        //   renderFavPanel()`，不清就原地重画回收藏面板，回不去引擎面板。
        panelFav = null;
        favFromEngines = false;
        togglePanel(true);
        return;
    }
    togglePanel(false);
});

// 面板底栏的「设置…」：不依赖右键也能进设置
const btnSettings = $('btnSettings');
if (btnSettings) {
    btnSettings.addEventListener('click', () => {
        // 面板底栏的「设置…」要**跳到对应的分页**（用户要求）：
        //   收藏夹面板 → 收藏夹；引擎面板 → 引擎
        // ⚠ 这里以前写成 `panelFav ? 'ocr' : 'engines'` —— 收藏夹面板点「设置…」
        //   会跳到「文字识别」，用户明确报过这个 bug。tab 必须跟着当前面板走。
        const tab = panelFav ? 'fav' : 'engines';
        togglePanel(false);
        invoke('open_settings', { focusEngine: null, tab }).catch(() => {});
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        /* 包裹菜单开着时 Esc **只收菜单** —— 用户想退出的是菜单，
         * 顺手把整条横条关掉会让他重新选一次文字。 */
        if (wrapMenuEl && !wrapMenuEl.hidden) {
            closeWrapMenu();
            return;
        }
        closeMenu();
        invoke('hide_bar').catch(() => {});
        return;
    }
    /* 菜单开着时按 1~9 直接选第 N 组符号：键盘党不用挪鼠标。
     * 屏幕上排 4 列，序号按"阅读顺序"数（左上起往右）。 */
    /* 网格页开着、且不止一页时，← → 也能翻页。
     * 正在输入框里打字时不算（否则光标移动都被吃掉了）。 */
    if (gridOn && gridPages.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!typing) {
            e.preventDefault();
            switchGridPage(e.key === 'ArrowRight' ? 1 : -1);
            return;
        }
    }
    if (wrapMenuEl && !wrapMenuEl.hidden && /^[1-9]$/.test(e.key)) {
        const items = wrapMenuEl.querySelectorAll('.wm-item');
        const i = Number(e.key) - 1;
        if (items[i]) {
            e.preventDefault();
            items[i].click();
        }
    }
});

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

function openMenu(x, y, engineName) {
    menuOwner = engineName;
    menuEl.textContent = '';

    const add = (label, handler) => {
        const b = document.createElement('button');
        b.className = 'menu-item';
        b.textContent = label;
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            invoke('log_msg', { msg: `menu click: ${label}` }).catch(() => {});
            closeMenu();
            handler();
        });
        menuEl.appendChild(b);
    };
    const sep = () => {
        const d = document.createElement('div');
        d.className = 'menu-sep';
        menuEl.appendChild(d);
    };

    // ⚠ 菜单项只留「针对这颗图标」的动作。
    //   · 去掉「打开设置…」：面板底栏已经有「设置…」，重复（用户点名）。
    //   · 去掉「关闭横条」：不该靠右键图标来关横条（用户点名）。
    //   · 引擎区之外没有可做的动作 → **干脆不弹菜单**，别弹一个空壳。
    if (engineName) {
        add('更换这个图标…', () => invoke('pick_icon', { engine: engineName }).catch(() => {}));
        if (CONF && CONF.overrideIcons && CONF.overrideIcons[engineName]) {
            add('恢复默认图标', () => invoke('reset_icon', { engine: engineName }).catch(() => {}));
        }
        sep();
        /* 第三项跟着「在不在横条里」换名字：
         *   · 横条上的格子 → 「从横条移除」（点了真会摘掉）；
         *   · 面板里列的是**全部**引擎，没固定过的那颗得说「固定到横条」——
         *     以前写死「从横条移除」，在面板里对一颗没上横条的引擎点它，
         *     Rust 那边 `on=false` 遇上 `has=false` 直接 return，用户点什么都没发生。
         * ⚠ 判据用 barList()（横条此刻真正的成员，悬空哨兵已剪掉），**别直接读
         *   CONF.bar_list** —— 前端拿到的是 config_view 的**驼峰**视图
         *   （barList，见 main.rs 的 `"barList": cfg.bar_list`），读错键会让
         *   每一颗引擎都变成"没上过横条"，横条上右键也跟着说"固定到横条"。 */
        const inBar = barList().indexOf(engineName) >= 0;
        add(inBar ? '从横条移除' : '固定到横条',
            () => invoke('toggle_bar_engine', { engine: engineName, on: !inBar }).catch(() => {}));
    } else {
        menuEl.hidden = true;
        invoke('log_msg', { msg: 'menu: 非引擎区右键，无可用项，不弹菜单' }).catch(() => {});
        return;
    }

    menuEl.hidden = false;
    // 菜单绝对定位，不参与 stage 的尺寸计算，所以得把窗口撑开才看得见
    menuEl.style.left = Math.max(0, x) + 'px';
    menuEl.style.top = Math.max(0, y) + 'px';

    /* ⚠ 这段"把菜单和每一项的矩形打进日志"只在调试构建里跑。
     *   右键是高频动作，而它每次都要对容器 + 每个菜单项各做一次
     *   getBoundingClientRect（强制同步布局）再发一条 IPC —— 正式使用时
     *   没有任何消费方，纯属给每次右键加一次卡顿。 */
    if (CONF && CONF.debug) {
        const mr = menuEl.getBoundingClientRect();
        const items = [...menuEl.querySelectorAll('.menu-item')]
            .map((b) => { const r = b.getBoundingClientRect(); return `${b.textContent}@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`; });
        invoke('log_msg', {
            msg: `menu rect ${Math.round(mr.left)},${Math.round(mr.top)} ${Math.round(mr.width)}x${Math.round(mr.height)} dpr=${window.devicePixelRatio} | ${items.join(' | ')}`
        }).catch(() => {});
    }

    // 菜单不参与 stage 的尺寸计算，所以得把窗口撑开才看得见
    pushLayout();
    // 菜单开着也算"在用它"，别在这时候把横条收走
    armIdle();
}

function closeMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    menuOwner = null;
    pushLayout();
    armIdle();
}

document.addEventListener('mousedown', (e) => {
    // ⚠ 只认左键。
    //   右键的 mousedown 和「全局钩子 → IPC → 开菜单」是两条独立路径，谁先到
    //   不确定：IPC 先到就会出现「菜单刚开好、紧接着被这一次 mousedown 当成
    //   点在菜单外面关掉」。左键点在菜单外面才是真的「点了别处、该收」。
    if (e.button !== 0) return;
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
}, true);

/* ------------------------------------------------------------------ */
/* Rust → 前端 事件                                                    */
/* ------------------------------------------------------------------ */

/** 重放横条的入场动画（升起那一下）。
 *
 *  为什么需要"重放"：CSS animation 只在元素**首次获得**该动画时播放
 *  （页面加载时放一次就完了）。横条窗口是 Rust 反复显隐的，页面从不重建，
 *  所以不重放的话，第二次以后弹出都是"啪"地一下，没有任何过渡 ——
 *  用户要的"流畅的视觉过渡"就只剩第一回。
 *
 *  ⚠ 做法是「摘类 → 强制重排 → 挂类」：直接 add 一个**已经挂着**的类，
 *     浏览器认为"没有变化"，不会重启那条 animation。中间那次
 *     `void barEl.offsetWidth` 逼一次同步布局，让浏览器承认类真的掉过。
 *  ⚠ 动画总开关关着（设置里的「动画」）就整个跳过：类都不挂。 */
function replayBarIn() {
    if (CONF && CONF.animations === false) return;
    barEl.classList.remove('qs-bar-in');
    void barEl.offsetWidth;
    barEl.classList.add('qs-bar-in');
}

listen('qs://show', (ev) => {
    const p = ev.payload || {};
    /* ── 网格页（Ctrl+C / 自定义快捷键） ────────────────────────────
     * 后端每次唤起都会带 `grid`：非 null 表示"这次画网格"，null 表示普通文字横条。
     * 两条路在这里分流，**文字横条那条完全不受影响**（它的 grid 恒为 null）。
     * 网格没有"选中文字"的概念，但可以把剪贴板里已有的文字带上 —— 点格子在
     * 有文字时直接搜它，没文字就打开引擎首页（后端 open_search 自己处理）。 */
    if (p.grid) {
        // 网格页跟横条内容是两回事：这次不展示横条，覆盖一并作废
        barOverride = null;
        barOverrideInfo = null;
        currentText = p.text || '';
        currentIsUrl = false;
        currentUrls = [];
        viaCopy = false;
        ocrOnly = false;
        lastShowSig = null;
        if (!barVisible) {
            barVisible = true;
            replayBarIn();
        }
        /* 每一次唤起都是**全新的一次**：上次的编辑态、打开着的选板、
         * 上次点的是哪一格，全部丢掉。
         *
         * 以前这些只在 `exitGridMode()` 里清，而它只在"下一次弹出的是文字横条"
         * 时才跑 —— 用户连按两下网格快捷键（网格 → 网格），上一次的编辑模式
         * 就带过来了：格子还带着 ×、空位也还能点。用户口径：
         * 「网格页不应保留上一次选择过的按钮或功能」。 */
        resetGridTransient();
        renderGrid(p.grid);
        return;
    }
    // 普通横条：先把网格态摘干净，防止样式残留把文字条画歪
    exitGridMode();
    /* 按应用解析后的横条内容（见 Rust `config::resolve_bar`）。
     * 只有 `source === 'app'` 才覆盖；否则清空覆盖，沿用默认 `bar_list`。 */
    barOverrideInfo = (p.bar && typeof p.bar === 'object') ? p.bar : null;
    barOverride = (barOverrideInfo && barOverrideInfo.source === 'app'
        && Array.isArray(barOverrideInfo.items) && barOverrideInfo.items.length)
        ? barOverrideInfo.items.slice()
        : null;
    /* 「这次弹出」的触发指纹：文字 / 是不是网址 / 是不是复制唤起 / 是不是 OCR 形态。
     *
     * ⚠ 用它来区分「换了一次触发」和「同一次触发的回声」。
     *   横条会在**鼠标移动**（选中/复制弹出那套钩子）时被反复 show_bar，
     *   而每次的 payload 常常一模一样（都是空文字、都是鼠标触发）。
     *   以前这里无条件 `togglePanel(false)`，于是用户开着面板浏览时，
     *   只要鼠标动一下触发一次 show，**面板就被收掉、滚动位置归零** ——
     *   用户看到的就是「我刚点开的目录，怎么莫名其妙跳回最上面了」。
     *   实测（轮 22 探针）一次运行里 show_bar 触发了 6 次，面板被收了 6 次。 */
    const showSig = [p.text || '', p.isUrl ? 1 : 0, p.viaCopy ? 1 : 0, p.ocrOnly ? 1 : 0]
        .join('\u0001');
    /* ⚠ 指纹**未知**（这一轮还没见过任何 show）时也按"同一次触发"处理 —— 也就是
     *   **不收面板**。理由：面板此刻本来就只有可能是用户自己点开的，而这次 show
     *   多半只是鼠标挪了一下触发的回声；为了它把用户刚打开的东西关掉，
     *   代价远大于"少收一次面板"。实测（轮 22 探针）就是这一条没挡住：
     *   两次 show 的 payload 一模一样，却因为第一次 lastShowSig 还是 null
     *   被当成"新触发"，面板照样被收了。 */
    const sameTrigger = (lastShowSig === null) || (showSig === lastShowSig);
    lastShowSig = showSig;
    currentText = p.text || '';
    currentIsUrl = !!p.isUrl;
    currentUrls = Array.isArray(p.urls) ? p.urls : [];
    // 这次横条是「用户刚复制/拖选」叫出来的吗？（见 Rust 侧 show_bar 的 via_copy）
    // 收藏夹条目点下去要据此分流：取词语境→复制到剪贴板；否则→填进搜索框。
    viaCopy = !!p.viaCopy;
    ocrOnly = !!p.ocrOnly;
    // OCR-only 形态下没有「这段文字」可以搜，把跟文字有关的两颗按钮收掉
    syncOcrBtn();

    closeMenu();
    /* 入场动画：只在「横条原本收着 → 现在弹出」时放一次。
     * （同一次触发的回声不放 —— 见 barVisible 的注释。） */
    if (!barVisible) {
        barVisible = true;
        replayBarIn();
        /* v1.5.21：弹出时**先保持不透明**，过了 barDimDelayMs 才平滑淡到
         * --qs-dim-alpha。
         * 旧写法是登场那一帧就 add('qs-dim','qs-dim-noanim') —— 于是横条
         * 「一出现就是半透明的」，与用户要的"先亮着、过一会再淡"相反。
         * ⚠ 指针可能已经在横条上方（横条就是照着它弹出来的）：这时不该淡。 */
        barHovered = barEl.matches(':hover');
        barEl.classList.remove('qs-dim');   // 复用窗口时清掉上一轮的残留
        syncDim();                          // 延迟计时从这一帧开始
    }
    /* 只有**真的换了一次触发**才收起面板。
     * 同一次触发的重复 show（鼠标挪一下就再来一条）不该动用户已经打开的东西 ——
     * 这正是"面板自己关了 / 跳回最上面"的来源。 */
    if (!panelEl.hidden && !sameTrigger) togglePanel(false);

    // 引擎区右侧那条自动竖线（#sepTail）已删除，不用再管它跟"这次选中的是不是
    // 网址"的关系了 —— 现在引擎区里有几根竖线，完全由用户加了几条分隔线决定。
    syncLinkBtn();
    // r54：识图入口跟着配置开关走；文件管理器图标跟着「这段文字像不像路径」走
    syncImgBtn();
    syncPathBtn();
    syncWrapBtn();
    /* 换了一段新选中的文字就把包裹菜单收掉 —— 它还指着上一段，
     * 继续操作会包错东西。同一段文字的重复 show（鼠标挪一下）不动它。 */
    if (wrapMenuEl && !wrapMenuEl.hidden && currentText !== wrapOrigin) closeWrapMenu();

    renderBar(false);
    /* ⚠⚠ **重新弹出必须作废"上次报过的尺寸"** —— 这是"弹得慢"的真正元凶。
     *
     * pushLayout 末尾有一道去重：payload 的 JSON 串没变就 `return`，一条 IPC 都不发
     * （那是为了断「面板尺寸变 → Rust 改窗口 → 视口变 → 面板尺寸又变」这个反馈环）。
     * 但**横条重新弹出**时尺寸本来就常常一模一样（横条上只有引擎图标，跟这次选中的
     * 文字无关），于是这一发被去重吃掉 —— 前端压根没告诉 Rust「我准备好了」。
     * 结果：Rust 只能等 show_bar 末尾那个 **420ms 兜底线程**（"前端万一没回就用上次
     * 尺寸兜底显示"）才把窗口摆出来。探针实测端到端 **422ms**，且每一轮都一样；
     * 那个兜底明明只是保险，实际成了主路径。
     *
     * 清空 key 之后，每一次弹出都必然把当前布局真报一次，兜底线程回到它该有的角色。
     * 反馈环照样断得住：拖动/缩放那些路径不会走到这里，去重逻辑本身没动。
     *
     * 下面这次上报**是同步的**（不夹 rAF 也不夹 setTimeout）：renderBar 刚改完 DOM，
     * pushLayout 里的 getBoundingClientRect() 会强制一次同步布局，拿到的就是真实尺寸，
     * 不需要等帧。rAF 那条保留作兜底（图标是异步加载的，加载完还要再报一次）。 */
    lastLayoutKey = '';
    pushLayout();
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
    // ⚠ 图标是异步加载的：加载完成后横条可能变高/变宽，但 pushLayout 只在
    //   渲染当下量了一次 —— 后端按"小一号"的尺寸摆的窗口，图标一到齐横条
    //   长出去，屏幕边缘那侧就会有一截跑到屏幕外（用户报的就是这个）。
    //   补两次延迟重报，让后端拿最终尺寸重新钳制位置。
    setTimeout(() => { if (!panelEl.hidden || !barEl.hidden) pushLayout(); }, 260);
    setTimeout(() => { if (!panelEl.hidden || !barEl.hidden) pushLayout(); }, 700);
    /* ⚠ 诊断上报只在调试构建里跑（`QS_DEBUG=1` 时后端把 debug 塞进配置）。
     *   以前这里无条件 `setTimeout(dumpState, 60)` —— 而 dumpState 会读一整套
     *   盒模型再发一条 IPC，`qs://show` 实测一次触发 6 次，等于每次划词都白做
     *   六遍布局 + 六条 IPC。正式使用对这条数据没有任何消费方。 */
    if (CONF && CONF.debug) setTimeout(dumpState, 60);
    // 液态玻璃：建上下文（首次）/ 重新起渲染循环。背景字节等 Rust 的
    // qs://glass 事件（layout_bar 抓完了才发），到了再 onFresh。
    if (window.QSGlass) QSGlass.onShow();
    /* 弹出即开始"无操作计时"（配置里关掉 / 面板菜单开着时它自己会跳过）。
     * 放在最后：上面那些 pushLayout / 动画都不算用户操作。 */
    armIdle();
});

/* Rust 的「迟到补」通道 —— 配合 Ctrl+C 路径的加速（见 Rust 侧 read_current /
 * late_text_patch / push_late_text）。
 *
 * 以前 Ctrl+C 唤起横条要**先等剪贴板**：read_current 里挂着最长 400ms 的轮询，
 * 等到复制真的落地才敢弹。现在改成"立刻弹 + 迟到补"：横条先带着（可能的）旧文本
 * 弹出来，复制落地后 Rust 再发这一条事件，把真正的文字补给前端。
 *
 * 所以这里要做的事就是"把横条这条文字换掉"。引擎区不随文字变（renderBar 的签名
 * 只看 bar_list / 图标覆盖），但网址按钮要看 currentIsUrl，得重算一次。 */
listen('qs://text', (ev) => {
    const p = ev.payload || {};
    // 横条已经收起来了就别改：这份文字属于上一条横条，补上来只会串味。
    if (barEl.hidden) return;
    currentText = p.text || '';
    currentIsUrl = !!p.isUrl;
    currentUrls = Array.isArray(p.urls) ? p.urls : [];
    viaCopy = !!p.viaCopy;
    syncLinkBtn();
    syncWrapBtn();
    renderBar(false);
    // 文字换掉后（可能从空变长）横条宽度会变，重新报一次尺寸让后端重新摆位。
    pushLayout();
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
});

function dumpState(tag) {
    const r = barEl.getBoundingClientRect();
    invoke('log_msg', {
        msg: (tag || 'state') + ' inner=' + window.innerWidth + 'x' + window.innerHeight
            + ' outer=' + window.outerWidth + 'x' + window.outerHeight
            + ' doc=' + document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight
            + ' dpr=' + window.devicePixelRatio
            + ' vis=' + document.visibilityState
            + ' scroll=' + Math.round(document.body.scrollWidth) + 'x' + Math.round(document.body.scrollHeight)
            + ' bar=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
            + ' readyState=' + document.readyState
    }).catch(() => {});
}

listen('qs://config', (ev) => {
    CONF = window.CONF = ev.payload || {};
    // 自定义引擎增删改之后也会走到这里，重新合并一次再渲染
    qsMergeCustomEngines(CATALOG, ENGINE_BY_NAME, CONF);
    // 别名索引跟着重建（自定义引擎可增删改，别名表不能停在开机那一份）
    buildAliasIndex();
    applyLook();
    // 液态玻璃参数跟着配置走（开/关、折射、色差、实时模式…）
    if (window.QSGlass) QSGlass.applyConf(CONF);
    syncOcrBtn();
    // r54：配置广播也要刷新这两颗按钮 —— 用户在设置里改了「加到横条」/总开关，
    // 横条应该立刻跟上，而不是等下一次划词
    syncImgBtn();
    syncPathBtn();
    renderBar(true);
    // ⚠ 面板开着时也要跟着重渲染，但**必须按当前模式渲染**：
    //   在收藏面板（panelFav 非空）开着时，如果无脑 renderPanel() 去画引擎九宫格，
    //   就会把收藏面板顶掉、跳回「⋯」那一页 —— 用户点开收藏夹没几秒就被弹回引擎页，
    //   就是这个。
    //
    // ⚠ 收藏面板还多一层判断：**收藏内容没变就别重渲染**。
    //   renderFavPanel 会把面板的宽高/位置按配置里的尺寸重算一遍，而配置广播
    //   的触发源很多（主题、圆角、引擎改动…），其中还可能带着**还没更新到的
    //   旧 favPanelSizes** —— 用户刚拖好的尺寸会被这一下覆盖回去（他报的
    //   「调整完又变回另一个样子」）。用内容指纹挡掉无关广播即可。
    if (!panelEl.hidden) {
        if (panelFav) {
            const sig = favContentSig();
            if (sig !== lastFavSig) {
                lastFavSig = sig;
                renderFavPanel();
            }
        } else {
            // keepScroll：配置广播引起的重画**不该**把用户正在浏览的位置滚回顶部
            renderPanel(false, true);
        }
    }
    requestAnimationFrame(() => setTimeout(pushLayout, 0));
    /* 用户可能在设置里改了「几秒无操作就收起」—— 按新值重新计时。
     * （armIdle 会先清旧计时器，所以改成更大的值也不会被旧的那一发提前收掉。） */
    armIdle();
});

/* 主题（后端 qs://theme 的载荷，只含 dark）。
 *
 * ⚠ 必须设在 stage 上：.stage 自己声明了 --qs-bg 默认值，设在 <html> 上会被后代
 *   那条声明盖掉，明暗就白切了。（--qs-bg-fill 的重算也在里面 —— 漏了它，
 *   开了磨砂时横条会停在上一轮的旧底色上。）
 *
 * ⚠ 真正的落色逻辑在 applyThemePayload 里，这里只是入口。
 *   别把逻辑写回来：探针要按同一份代码测，两处两份逻辑早晚会岔开。 */
listen('qs://theme', (ev) => {
    // #139：存一份。主题事件只在 show_bar 和设置页改主题时来，面板又是
    // "打开时渲染一次"的 —— 存下来，打开面板时幂等重放一次兜底
    // （隐藏窗口期间事件被节流吞掉的那种边角情况，用户看到的就是
    //  「更多引擎页还是上一版主题的颜色」）。
    lastThemePayload = ev.payload || null;
    applyThemePayload(ev.payload);
    // 主题一切换，玻璃的染色（亮色提亮 / 暗色压深蓝）就要跟着变 —— 重画一帧
    if (window.QSGlass) QSGlass.kick();
});

// 液态玻璃：Rust 在 layout_bar 首次上屏前抓好了背景，来取字节。
listen('qs://glass', () => { if (window.QSGlass) QSGlass.onFresh(); });

// 全局快捷键唤起收藏夹：后端先弹横条再发这条事件，前端把收藏面板铺开。
listen('qs://fav-open', () => openFavPanel(null));

/* Rust 每次摆完位都会告诉前端「横条下沿往下还剩多少空间」（CSS px）。
 * 收藏面板的高度上限定它 —— 面板永远放得下，横条就不会被挤得挪位置（那边是
 * 「横条不动、面板收窄」的策略，用户当年点名要的）。
 * 面板此刻已经开着的话，只在「新的上限更小」时收一下（只收不放，
 * 免得和摆位互相追着改出抖动）。
 *
 * r74：**引擎面板不再这里收窄**。它换成「内容优先」策略（见 renderPanel 的
 * 长注释）：放不下由 Rust 把横条连同面板整体上移。要是在这儿再按余量收一次，
 * 用户刚点开的列表又会被掐成只有 sticky 头的那一条 —— 正是本轮修掉的
 * 「只看得到收藏夹和引擎大类，看不到任何引擎内容」。 */
listen('qs://bar-room', (ev) => {
    const p = (ev && ev.payload) || {};
    const v = Number(p.below || 0);
    const l = Number(p.left || 0);
    if (l > 0 || p.left === 0) barRoomLeft = Math.max(0, l);
    // 右侧余量：面板整体宽度不能超过它，否则 Rust 的锚点钳制会把横条一起推走
    const r = Number(p.right || 0);
    if (r > 0) barRoomRight = Math.max(200, r);
    const t = Number(p.top || 0);
    if (t >= 0) barRoomTop = Math.max(0, t);
    if (!v || v < 0) return;
    const prev = barRoomBelow;
    barRoomBelow = v;
    // ⚠ 拖动中不改面板最大高度：改它 = 面板内层重排 = 拖动时跟着闪一次
    //   （用户报的"拖动的时候闪烁"的另一半）。松手时那次完整 pushLayout 会带上。
    if (!favDragging && panelFav && !panelEl.hidden && v < prev) {
        const cur = parseFloat(panelEl.style.maxHeight) || 0;
        if (!cur || v < cur) {
            panelEl.style.maxHeight = Math.max(180, v) + 'px';
            requestAnimationFrame(() => setTimeout(pushLayout, 0));
        }
    }
});

/* 收藏夹面板支持手动拉长宽高，并按目录**记忆**（用户要求）。
 * 拉动时实时重算窗口尺寸（不然内容会溢出外框），停手 600ms 后保存。 */
let favSizeTimer = 0;
if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
        if (panelEl.hidden || !panelFav) return;
        requestAnimationFrame(() => setTimeout(pushLayout, 0));
        clearTimeout(favSizeTimer);
        favSizeTimer = setTimeout(() => {
            // ⚠ 面板收起时 panelFav 已被置空，600ms 后这个回调才跑 ——
            //   不拦一下会把 key=null、rect=[0,0] 的垃圾写进配置（踩过）。
            if (panelEl.hidden || !panelFav) return;
            // 刚折叠/展开过：这次高度变化是"内容变少/变多"，不是用户拉的尺寸，
            // 记下来会让面板下次打开就是折起来那点高（见 favSizeSaveUntil）。
            if (Date.now() < favSizeSaveUntil) return;
            const key = panelFav === 'root' ? '_root' : panelFav;
            const r = panelEl.getBoundingClientRect();
            if (r.width < 40 || r.height < 40) return;   // 隐藏态量到的空矩形
            const sizes = Object.assign({}, (CONF && CONF.favPanelSizes) || {});
            sizes[key] = [Math.round(r.width), Math.round(r.height)];
            invoke('set_setting', { key: 'favPanelSizes', value: sizes }).catch(() => {});
        }, 600);
    }).observe(panelEl);
}

/* ---- 收藏面板自绘缩放热区（左/右/下/左下/右下五边）----
 * CSS resize:both 只有右下角一个抓手，用户明确要求左边也要能拉。
 *
 * ⚠ 西向（左 / 左下）缩放踩过两轮，这里把结论写清楚：
 *   · 第一轮：同时改 stage 的 padding-left（让横条在窗口内右移）和移动窗口左缘 ——
 *     CSS 是即时生效的、窗口位移要等一次 IPC 往返，中间必然有一帧「padding 已变、
 *     窗口还没动」，表现就是**横条和窗口一起抖**（用户报的「乱闪」）。
 *   · 第二轮：为了不抖，干脆只改宽度、不碰 padding —— 结果**方向反了**：
 *     拖左边却把右缘往右撑（用户报的「实际被改变尺寸的是右侧」）。
 *   现在把两件事彻底拆开：
 *     ① 按下那一刻**一次性**把 stage 的 padding-left 撑到本次可用余量，窗口随之
 *        向左扩出同等量 —— 横条与面板的屏幕位置都不变，所以这一步是**不可见**的
 *        （窗口只是多了一块还没用上的空地）；
 *     ② 拖动过程中只改 panel 的 left/width：left = 自然偏移 − 位移量、
 *        width = 原始宽 + 位移量 → **左缘跟鼠标走、右缘纹丝不动、窗口全程不动**
 *        → 既不抖、也不反向；
 *     ③ 松手时把 padding 归一到**真实位移量**（同样不动横条/面板的屏幕位置），
 *        免得窗口左侧一直留着一大块透明空地挡点击。
 *   为什么非得用 padding：面板是 stage 里的绝对定位元素，它的包含块是 stage 的
 *   padding box；没有这块 padding 的话，left 取负值会被 body 的 overflow 裁掉。 */
const FAV_RZ_MIN_W = 220;
const FAV_RZ_MAX_W = 900;     // 宽度上限（左右两个方向共用）
const FAV_RZ_MAX_OV = 480;    // 西向最多向左探出多少（受屏幕左侧余量再收一次）
const FAV_RZ_MIN_H = 120;

/** 当前面板会话已向左探出的量（CSS px）；收起面板时归零。 */
let westOv = 0;
/** 横条在 stage 里的**自然**偏移（不含西向 padding 撑出来的那部分）。 */
let favBarOff0 = 24;

/** 当前给内容让出的左侧 padding（CSS px）。西向缩放与拖动面板都靠它让出空间。 */
function favPad() { return parseFloat(stage.style.paddingLeft) || 0; }

function setFavPad(px, noPush) {
    const v = Math.max(0, Math.round(px));
    if (v > 0) stage.style.paddingLeft = v + 'px';
    else stage.style.removeProperty('padding-left');
    if (!noPush) pushLayout();
}

/** 收藏面板尺寸落盘（缩放结束 / 拖动结束时调）。 */
function saveFavPanelSize() {
    if (!panelFav || panelEl.hidden) return;
    const r = panelEl.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    const key = panelFav === 'root' ? '_root' : panelFav;
    const sizes = Object.assign({}, (CONF && CONF.favPanelSizes) || {});
    sizes[key] = [Math.round(r.width), Math.round(r.height)];
    invoke('set_setting', { key: 'favPanelSizes', value: sizes }).catch(() => {});
}

/* ---- 按住面板头部拖动整块面板 ----
 *
 * ⚠ 架构（这是踩了 N 轮才定下来的正解）：拖动**不动面板的内容坐标**，而是整块**窗口**
 *   跟着鼠标平移（把偏移量报给 Rust，由 Rust 挪窗口）。
 *   之前那套「撑 padding 让内容留出空间、面板在内容里移动」的路子，每换一个方向就会冒出
 *   新的边界问题（窗口裁切、内容坐标 >= 0、窗口位置异步导致区间算偏…），永远补不完。
 *   现在：
 *     · 面板永远落在窗口内部 → 不可能被窗口边缘裁掉；
 *     · 窗口位置由 Rust 按**显示器工作区**钳制 → 不可能拖出屏幕（上下左右都出不去）；
 *     · 窗口与内容一起动 → 按住的那个点天然一直贴在鼠标下面，1:1 不放大。
 *   用户要求：自由拖拽但不得超出屏幕可视范围 —— 这两条由此同时成立。 */
function startFavDrag(e) {
    if (!panelFav || panelEl.hidden) return;
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button, input, a')) return;
    e.preventDefault();
    e.stopPropagation();
    if (favResizeCleanup) { favResizeCleanup(); favResizeCleanup = null; }
    const off0X = winOffX, off0Y = winOffY;
    const startSX = e.screenX, startSY = e.screenY;
    let moved = false;
    let rafId = 0;
    favDragging = true;
    const onMove = (ev) => {
        const dx = ev.screenX - startSX, dy = ev.screenY - startSY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;   // 防手抖
        moved = true;
        winOffX = off0X + dx;
        winOffY = off0Y + dy;
        // 一帧最多推一次（见 dragPushLayout 的注释：逐条 pointermove 推 = 闪）
        if (rafId) return;
        rafId = requestAnimationFrame(() => { rafId = 0; dragPushLayout(); });
    };
    const onUp = () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        favDragging = false;
        panelEl.removeEventListener('pointermove', onMove);
        panelEl.removeEventListener('pointerup', onUp);
        panelEl.removeEventListener('pointercancel', onUp);
        panelEl.removeEventListener('lostpointercapture', onUp);
        window.removeEventListener('blur', onUp);
        favResizeCleanup = null;
        try { panelEl.releasePointerCapture(e.pointerId); } catch (_) {}
        // 松手这一下走完整 pushLayout：把拖动期间"只换 offset、没重量 DOM"补回来
        lastLayoutKey = '';
        pushLayout();
        // 需求 6：拖动面板 = 整块窗口平移，玻璃纹理整块错位 —— 松手后重抓一次。
        // （纯移动不会触发 DOM 的 resize 事件，所以那条路兜不住这里。）
        glassRefit();
    };
    favResizeCleanup = onUp;
    try { panelEl.setPointerCapture(e.pointerId); } catch (_) {}
    panelEl.addEventListener('pointermove', onMove);
    panelEl.addEventListener('pointerup', onUp);
    panelEl.addEventListener('pointercancel', onUp);
    panelEl.addEventListener('lostpointercapture', onUp);
    window.addEventListener('blur', onUp);
}

function setupFavResizeHandles() {
    /* ⚠ 暂时只装「右 / 下 / 右下」三个抓手。
     *
     *   左 / 左下这两条（西向缩放）需要**窗口向左扩出去**才能让面板左缘往左探。
     *   上一版是靠 stage 的 padding-left 让出空地 —— 但绝对定位元素的包含块是
     *   padding box，而没有边框时 padding box 的左缘就等于 border box 左缘，
     *   所以 padding 只把**流内的横条**往右推，压根不给面板让位；面板 left 取负值
     *   就被推到窗口左边之外裁掉，实体宽度还被撑大、触发 Rust 的锚点钳制 ——
     *   用户看到的就是「横条还在原地，窗口却跑到别的地方去了」。
     *   根因已定位并修好（left 基准改成「横条偏移 − 探出量」），但这一版还没在真机上
     *   复验通过，**宁可不给这个抓手，也不能再交一个会乱跑的行为**。
     *   下一步做「按住面板头部拖动整块面板 + 钉在屏幕上」（用户第 1 条诉求），
     *   那个能力会顺带覆盖「把面板往左拉」的场景。 */
    for (const dir of ['w', 'e', 's', 'sw', 'se']) {
        const hz = document.createElement('div');
        hz.className = 'fav-rz ' + dir;
        hz.addEventListener('pointerdown', (e) => startFavResize(e, dir));
        panelEl.appendChild(hz);
    }
}

function startFavResize(e, dir) {
    if (!panelFav || panelEl.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    if (favResizeCleanup) { favResizeCleanup(); favResizeCleanup = null; }
    const wantsWest = dir === 'w' || dir === 'sw';
    /* ---- 西向缩放的正确模型（前几轮一直错在这里）----
     *
     * 面板是 stage 里的绝对定位元素，包含块 = stage 的 **padding box**；而面板没有
     * 边框 —— padding box 的左缘**就等于** border box 左缘，所以给 stage 加
     * padding-left 只把**流内的横条**往右推，并不会平移面板的包含块。
     * 那 padding 到底起什么作用？—— 它让**内容坐标系**里横条右边去了：
     *   横条内容 x = P + m0   （P = padding，m0 = stage 自身边距 ≈ 24）
     *   面板内容 x = L        （L 相对包含块，也就是内容原点，必须 >= 0 否则被 body 裁）
     * 于是面板左缘能到的最左位置是 L = 0，也就是**比横条左缘再往左 P + m0** ——
     * 左拉能探出的余量就是 P + m0。所以：
     *   ① 按下时把 P 一次性撑到本次可用余量（窗口随之左移同等量、合成面覆盖到位），
     *      并把面板 left 设成 m0 + P（屏幕位置不变 → 这一步不可见）；
     *   ② 拖动中只改面板 left/width：left = m0 + P − ov、width = 原始宽 + ov
     *      → 左缘跟鼠标、右缘不动、**窗口全程不动**（P 不变）；
     *   ③ 松手把 P 归一到「刚好够用」（max(0, ov − m0)），窗口把那块没用的空地还回去，
     *      横条与面板的屏幕位置都不变。
     */
    const m0 = favBarOff0;                      // 横条在「P=0」时的内容 x
    /* ⚠ 不再「按下就把 padding 一次性撑到 480」—— 那会让窗口在拖动开始的一瞬间
     *   平移一大截，用户看到的就是「一按就开始闪」。改成**按需小步让位**：
     *   只有当面板真要探到内容原点左边（ov > m0）时才把 padding 补到刚够，
     *   每次最多补一帧的位移量（几 px），视觉上察觉不到。 */
    const room = Math.min(FAV_RZ_MAX_OV, Math.max(0, barRoomLeft));
    const box = panelEl.getBoundingClientRect();
    const startW = box.width, startH = box.height;
    const baseW = Math.max(FAV_RZ_MIN_W, startW - westOv);
    const capByScreen = Math.round(((window.screen && screen.availHeight) || 900) * 0.78);
    const maxH = barRoomBelow > 0 ? Math.min(capByScreen, Math.max(180, barRoomBelow)) : capByScreen;
    const maxOv = Math.max(westOv, Math.min(FAV_RZ_MAX_OV, Math.max(room, barRoomLeft)));
    const maxW = Math.max(FAV_RZ_MIN_W, Math.min(FAV_RZ_MAX_W,
        barRoomRight > 0 ? barRoomRight : FAV_RZ_MAX_W));
    const startSX = e.screenX, startSY = e.screenY;
    const westOv0 = westOv;
    if (wantsWest) panelEl.style.left = (m0 + room - westOv) + 'px';

    const applyWest = (ev) => {
        const dx = ev.screenX - startSX;
        // 往里缩：ov 允许取负（负值 = 面板左缘往右收、宽度变窄）
        const minOv = -(baseW - FAV_RZ_MIN_W);
        const nOv = Math.min(Math.max(westOv0 - dx, minOv), Math.max(0, maxW - baseW), maxOv);
        if (nOv === westOv) return;
        westOv = nOv;
        // 只有真需要时才补 padding（够用即止，避免一次性大位移）。
        // ⚠ 顺序：先按**新 padding** 算好面板 left，再落 padding，最后只推一次 ——
        //   否则 Rust 会收到「padding 已变、面板还没补偿」的中间态（同拖动那个 bug）。
        const need = Math.max(favPad(), nOv - m0 + 8);
        panelEl.style.left = (m0 + need - westOv) + 'px';
        panelEl.style.width = (baseW + westOv) + 'px';
        if (need > favPad()) setFavPad(need, true);
        /* ⚠ 每个 pointermove 都推一次布局 = 一次 IPC + 一次 SetWindowPos +
         *   一次跨线程 SetBounds，而 pointermove 在 120Hz 鼠标上是每 8ms 一条。
         *   这里和隔壁收藏面板拖动用同一套 rAF 合并：一帧最多推一次。 */
        scheduleLayoutPush();
    };
    const applySize = (ev) => {
        const dx = ev.screenX - startSX, dy = ev.screenY - startSY;
        if (dir === 'e' || dir === 'se') {
            panelEl.style.width = Math.min(Math.max(startW + dx, FAV_RZ_MIN_W), maxW) + 'px';
        }
        if (dir === 's' || dir === 'sw' || dir === 'se') {
            panelEl.style.height = Math.min(Math.max(startH + dy, FAV_RZ_MIN_H), maxH) + 'px';
        }
        scheduleLayoutPush();
    };
    const onMove = (ev) => {
        if (dir === 'w' || dir === 'sw') applyWest(ev);
        if (dir !== 'w') applySize(ev);
    };
    const onUp = () => {
        panelEl.removeEventListener('pointermove', onMove);
        panelEl.removeEventListener('pointerup', onUp);
        panelEl.removeEventListener('pointercancel', onUp);
        panelEl.removeEventListener('lostpointercapture', onUp);
        window.removeEventListener('blur', onUp);
        favResizeCleanup = null;
        try { panelEl.releasePointerCapture(e.pointerId); } catch (_) {}
        if (wantsWest) {
            // ③ 归一化：padding 收到「刚好让面板 left >= 0」的量，屏幕位置不变
            setFavPad(Math.max(0, Math.round(westOv - m0)));
            panelEl.style.left = (m0 + favPad() - westOv) + 'px';
        }
        saveFavPanelSize();
        pushLayout();
    };
    favResizeCleanup = onUp;
    try { panelEl.setPointerCapture(e.pointerId); } catch (_) {}
    panelEl.addEventListener('pointermove', onMove);
    panelEl.addEventListener('pointerup', onUp);
    panelEl.addEventListener('pointercancel', onUp);
    panelEl.addEventListener('lostpointercapture', onUp);
    window.addEventListener('blur', onUp);
}

// 右键菜单由 Rust 的全局钩子驱动（WebView2 的 contextmenu 在无激活浮层上
// 不可靠）。钩子把窗口内 CSS 坐标发过来，这里用 elementFromPoint 找按钮。
listen('qs://rclick', (ev) => {
    const p = ev.payload || {};
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    // ⚠ 先查重、再决定要不要动现有菜单。以前是先把菜单藏起来再查重，
    //   150ms 内的重复事件（右键抬起等）会把菜单藏掉又不重开 ——
    //   用户看到的就是「按住右键有菜单、一松开就消失」。
    const now = performance.now();
    if (now - lastMenuAt < 150) {
        invoke('log_msg', { msg: `rclick-hook dedup at ${Math.round(x)},${Math.round(y)}` }).catch(() => {});
        return;
    }
    lastMenuAt = now;
    menuEl.hidden = true; // 后收掉，免得 elementFromPoint 命中旧菜单
    const el = document.elementFromPoint(x, y);
    const btn = el && el.closest ? el.closest('button') : null;
    const name = btn && btn.classList.contains('engine') ? btn.dataset.engine : null;
    invoke('log_msg', { msg: `rclick-hook at ${Math.round(x)},${Math.round(y)} engine=${name}` }).catch(() => {});
    openMenu(x, y, name);
});

listen('qs://hidden', () => {
    // 收起来了 —— 无操作计时器没有任何意义了，直接停（别让它在后台再发一次 hide）
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    ocrOnly = false;
    renderedSignature = null;
    /* 横条收回去了：下一次 qs://show 是 隐藏→弹出 跳变，
     * 横条的入场动画该重放（见 barVisible / replayBarIn）。 */
    barVisible = false;
    // 液态玻璃：停渲染循环和实时轮询（纹理留着，下次弹出 Rust 会重抓覆盖）
    if (window.QSGlass) QSGlass.onHidden();
    // 悬停状态一并归零：横条下次弹出在别处，鼠标可不会"顺便"发一次 mouseleave
    barHovered = false;
    // 横条都收掉了，下一次弹出必然是"新的触发" → 清掉指纹，
    // 别让上一轮的签名把下一轮的第一次 show 误判成"回声"。
    lastShowSig = null;
    /* 收起时一并把"上次报过的布局"作废：下次弹出必须重新真报一次。
     * （不清空的话，尺寸恰好一样时那一发会被去重吃掉，横条就得等 Rust 那个 420ms
     *  兜底线程才出现 —— qs://show 里也清了一次，两处都清是保险：dismiss_bar 走
     *  set_position 异步挪窗、时机上未必先于 qs://show。） */
    lastLayoutKey = '';
    barOverride = null;
    barOverrideInfo = null;
    syncOcrBtn();
    closeMenu();
    /* 网格会话到此结束：编辑态 / 选板 / 借来的焦点 / 网格 DOM 全部收干净。
     * 以前要等"下一次弹出的是文字横条"才由 exitGridMode() 清，中间这段时间
     * `gridOn` 一直是 true —— 配置广播（比如刚在设置里加了/减了横条成员）
     * 会因为"网格页开着"而跳过重画，横条上该出现/消失的按钮要等下次才生效。 */
    resetGridTransient();
    exitGridMode();
    if (!panelEl.hidden) togglePanel(false);
    /* ⚠ 钉住状态随收起复位（后端 dismiss_bar 也会清 FAV_PINNED 并补发
     *   qs://fav-pinned，这里同步一次是为了前端状态**立刻**一致 ——
     *   否则下次弹出时图钉按钮还显示"已钉住"，但后端已经不认了）。 */
    favPinned = false;
    barEl.classList.remove('ghost');
    if (window.QSGlass && window.QSGlass.setBarGhost) {
        window.QSGlass.setBarGhost(false);
    }
});

/* 后端复位钉住状态时同步前端（dismiss_bar 里发的）。 */
listen('qs://fav-pinned', (ev) => {
    const on = !!(ev.payload && ev.payload.on);
    if (on === favPinned) return;
    favPinned = on;
    barEl.classList.toggle('ghost', favPinned);
    if (window.QSGlass && window.QSGlass.setBarGhost) {
        window.QSGlass.setBarGhost(favPinned);
    }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
    CATALOG = await fetch('data/engines.json').then((r) => r.json());
    for (const e of CATALOG.toolbar) ENGINE_BY_NAME.set(e.name, e);
    for (const c of CATALOG.categories) {
        for (const e of c.engines) if (!ENGINE_BY_NAME.has(e.name)) ENGINE_BY_NAME.set(e.name, e);
    }

    CONF = window.CONF = await invoke('get_config');
    // 用户自己加的引擎要在渲染之前并进来，否则横条上那一格会被当成
    // 「不认识的引擎」直接过滤掉 —— 表现为设置在、横条上没有。
    qsMergeCustomEngines(CATALOG, ENGINE_BY_NAME, CONF);
    // 别名索引（全表合并）—— 面板搜索框按别名找引擎靠它，见 buildAliasIndex
    buildAliasIndex();
    applyLook();
    /* 液态玻璃：boot 里就把配置灌给 QSGlass。
     * 它的 conf 只由 qs://config 广播填充，而**启动后没有任何一次广播** ——
     * 第一次 qs://show（Ctrl+C 或 --bar）比任何广播都先到时，onShow 看到
     * conf=null，glassOn(null)=false 直接返回：玻璃建不起来，表现为
     * 「每次开软件，第一次唤出横条没有玻璃效果，第二次才有」。
     * 和 qs://config 监听里那次调用保持同一条路。 */
    if (window.QSGlass) QSGlass.applyConf(CONF);
    renderBar(true);
    /* r54：识图入口 / 文件管理器图标这两颗按钮的初始状态。
     * 必须在这里补一次：它们跟 OCR 那颗不一样 —— OCR 由 renderBar 内部按配置
     * 决定显隐，而这两颗只在 syncImgBtn / syncPathBtn 里管。少了这一句，
     * 开机后第一次唤出横条时它们是 hidden（HTML 里的初值），要等第一次配置
     * 广播或 qs://show 才冒出来 —— 实测就是这个现象（配置明明开着、按钮不显示）。 */
    syncImgBtn();
    syncPathBtn();
    setupFavResizeHandles();
    // 选板里要列出 OCR / 识图 / 翻译的模型（见 GRID_MODELS 的注释）
    loadGridModels();

    // 让 WebView 别弹右键菜单 / 别缩放
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    /* 滚轮默认被整页关掉（横条不需要滚动）。这里给两处放行：
     *   ① 引擎面板的列表；
     *   ② 网格页的「添加内容」选板 —— 它的列表在 .qs-gpick-body 里。
     * 指针落在选板的标题/搜索框上时，也把滚动**转给**列表，
     * 否则用户会觉得"这个弹层根本滚不动"（用户报的正是这个）。 */
    document.addEventListener('wheel', (e) => {
        const pick = e.target instanceof Element ? e.target.closest('.qs-gpick') : null;
        if (pick) {
            const body = pick.querySelector('.qs-gpick-body');
            if (body && !body.contains(e.target)) {
                body.scrollTop += e.deltaY;
                e.preventDefault();
            }
            return;
        }
        /* 网格页：滚轮在**格子区域**上翻页（选板里不算，上面已经 return 了）。
         *
         * 节流有两层：① 一次滚动会连发几十条 wheel，攒到 40px 才算"翻一格"；
         * ② 翻完 180ms 内不再翻 —— 否则一滑就跳好几页，用户根本看不清。
         * 首尾循环（见 switchGridPage）。 */
        if (gridOn && gridPages.length > 1) {
            const now = Date.now();
            if (now - gridWheelAt > 500) gridWheelAcc = 0;   // 停顿久了重新计数
            gridWheelAcc += e.deltaY;
            e.preventDefault();
            if (Math.abs(gridWheelAcc) >= 40 && now - gridWheelAt > 180) {
                const dir = gridWheelAcc > 0 ? 1 : -1;
                gridWheelAcc = 0;
                gridWheelAt = now;
                switchGridPage(dir);
            }
            return;
        }
        if (!panelBody.contains(e.target)) e.preventDefault();
    }, { passive: false });

    // ⚠ 不能纯忽略。WebView2 偶发「窗口尺寸变了、合成层没跟上」：
    //   新扩出来的区域完全不透明地空着（用户看到的「收藏夹窗口只显示
    //   一小块/啥都没显示」就有这个成分）。在这里做一次强制重排+重绘，
    //   把合成层踹醒。display:none 同帧还原，肉眼无感。
    //   拖拽缩放时 resize 会连珠炮地来，防抖 120ms 只在停顿时踹一次。
    let repaintTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(repaintTimer);
        repaintTimer = setTimeout(() => {
            // ⚠ 不能用 display:none —— 面板尺寸会瞬间归 0，ResizeObserver 被叫醒后
            //   拿塌陷后的矩形上报 Rust，横条/面板会抖一帧（表现像"闪一下位移")。
            //   这里只碰合成层的 transform，几何完全不动。
            panelEl.style.transform = 'translateZ(0)';
            void panelEl.offsetHeight;   // 强制同步重排，让合成层重画
            panelEl.style.transform = '';
            /* 需求 6：窗口矩形变了，玻璃纹理得按新矩形重抓一次。
             * 放在这里而不是 togglePanel 里，是因为 resize 事件才是"尺寸真的
             * 落地了"的权威信号 —— 面板开合、拖动缩放、贴边重摆都会走到，
             * 一处接住所有路径（togglePanel 那条只是"请求摆位"，Rust 摆完
             * 尺寸才变）。 */
            glassRefit();
        }, 120);
    });
    invoke('log_msg', {
        msg: 'BUILD-V10 bar ready engines=' + ENGINE_BY_NAME.size
            + ' bar=' + barList().length
            + ' dpr=' + window.devicePixelRatio
            + ' css=' + Math.round(document.documentElement.clientWidth)
            + 'x' + Math.round(document.documentElement.clientHeight)
    }).catch(() => {});
    pushLayout();
}

boot().catch((err) => {
    // 用 textContent 而不是拼 innerHTML：错误消息里将来可能带上用户可控的字符串，
    // 拼进 HTML 就是白送一个注入点。
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#c00;font-size:11px;padding:10px;white-space:pre-wrap';
    pre.textContent = String((err && err.stack) || err);
    document.body.textContent = '';
    document.body.appendChild(pre);
});

/* ------------------------------------------------------------------ */
/* r52：面板里的第三层（小类）导航 + 跳转                                */
/*  用户要求「这样一些分类也得对应到通过横条打开的更多引擎页面里面」、    */
/*  「不能出现目录遮住引擎内容的问题」。                                  */
/*  中类标题是 .cat-title[data-cat]（老机器，自带高亮），小类标题是        */
/*  .cat-sub[data-sub="中类::小类"]（新加的，只跳转、不参与高亮）。        */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* r53：面板目录的渐进式展开                                             */
/*   一级（大类）：平铺一行胶囊（appendGroupNav，点它=过滤 + 露出二级）    */
/*  用户原话：「只显示一级目录……点击一级目录之后再会弹出 2 级目录。不然所有 */
/*  的目录都混在一起太杂了」。                                            */
/* r73：三级（小类）从下拉菜单改成平铺胶囊 —— 用户原话：「选择完中类之后， */
/*   小类最好是每一个就都呈现出来，一种胶囊的形式，这样我要哪个我点击就可以 */
/*   了，不用再一个个的找」。                                             */
/* r75：二级（中类）也改成平铺胶囊 —— 用户原话：「最好中类也作为胶囊式的，   */
/*   点击中类后，才会展开中类下面的小类」。三层现在一个口径：都是平铺胶囊，  */
/*   点谁看谁，「全部」恢复全量；下一级只在上一级真的选了一个之后才出现。   */
/* ------------------------------------------------------------------ */
var panelSubFilter = null;   // 选中的中类（null = 全部）
var panelCatFilter = null;   // 选中的小类（null = 全部）

/** 往导航行里加一颗胶囊。二级 / 三级共用（曾经两行各写一遍，改口径时容易只改一头）。 */
function panelPickChip(host, key, text, count, tip, on, onPick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat-nav-item cat-chip' + (on ? ' on' : '');
    b.title = tip;
    /* 用 aria-pressed（按钮的"按下/选中"语义），不用 aria-selected ——
     * 后者只对 role=option/tab 才合法，挂在裸 button 上等于没写。 */
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.appendChild(Object.assign(document.createElement('span'),
        { textContent: text }));
    if (count != null) {
        b.appendChild(Object.assign(document.createElement('span'),
            { className: 'n', textContent: count }));
    }
    b.addEventListener('click', () => {
        if (on) return;   // 已经是它了，别白重画
        onPick(key);
    });
    host.appendChild(b);
    return b;
}

function appendPickNav(head, groups, sections) {
    const rows = window.qsAllEngineRows(groups);
    const meta = panelSubMeta(groups);
    // —— 二级（中类）：选了大类才出现，**平铺一行胶囊** ——
    /*  用户原话（本次）：「最好中类也作为胶囊式的，点击中类后，才会展开中类
     *  下面的小类」。原来是 r53 那套「一个胶囊 + 下拉菜单」：中类一个大类底下
     *  也就两三个（网页族 = 搜索引擎 / 直达网页，软件族 = 软件搜索 / 软件直达），
     *  全铺开也只有一行，却还要多点一次"展开菜单"；和大类、小类的操作口径也不一致。
     *  现在三层一个样：都是平铺胶囊，点谁看谁，「全部中类」恢复全量。
     *  只有**选了中类**，下面那行小类才出现（panelSubFilter 非空才画）。
     *  ⚠ 一个大类下一个中类都没有时（用户把某族的引擎删光了）整行不画 ——
     *    只留一颗「全部中类」是没有意义的一行，还白占吸附头的高度。 */
    if (panelGroupFilter && sections.length) {
        const host = document.createElement('nav');
        host.className = 'cat-nav pick-nav';
        host.id = 'panelPick2';
        host.setAttribute('aria-label', '中类');
        let total = 0;
        for (const r of rows) if (r.group === panelGroupFilter) total++;
        panelPickChip(host, null, '全部中类', total,
            '不限定中类（列出这个大类的全部引擎）',
            panelSubFilter === null,
            (k) => {
                panelSubFilter = k;
                panelCatFilter = null;
                renderPanel();
                requestAnimationFrame(() => setTimeout(pushLayout, 0));
            });
        for (const s of sections) {
            /* ⚠ sections 是 [{key,title}] **对象**数组（老锚点导航用 sec.key），
               不是字符串数组 —— 直接拿它当过滤键会让 r.sub !== panelSubFilter
               永远成立，正文一节都不剩（探针 ③ 抓到的就是这个）。 */
            const sk = (s && s.key) ? s.key : s;
            let n = 0;
            for (const r of rows) if (r.group === panelGroupFilter && r.sub === sk) n++;
            const m = meta[sk];
            panelPickChip(host, sk, (m && m.title) || sk, n,
                '只看「' + ((m && m.title) || sk) + '」（' + n + ' 个）',
                panelSubFilter === sk,
                (k) => {
                    panelSubFilter = k;
                    panelCatFilter = null;
                    renderPanel();
                    requestAnimationFrame(() => setTimeout(pushLayout, 0));
                });
        }
        head.appendChild(host);
    }
    // —— 三级（小类）：**全部铺开**成一行胶囊（选了中类才出现） ——
    /*  用户原话（r73）：「更多引擎面板选择完中类之后，小类最好是每一个就都呈现
     *  出来，一种胶囊的形式，这样我要哪个我点击就可以了，不用再一个个的找」。
     *
     *  原来是 r53 那套「一个胶囊 + 下拉菜单」：网页那一族底下 24 个小类，
     *  想换一个就得点开菜单、在长列表里找、点完菜单又收起来 —— 换个类目重复一遍。
     *  现在和大类、中类一样平铺：一颗小类一颗胶囊，点谁就只剩谁；「全部」恢复全量。
     *
     *  ⚠ 数量级：一个中类底下最多 24 个小类（网页搜索引擎那一档），全铺开约 3 行。
     *    所以这一行用紧凑款胶囊（.cat-row：19px 高 / 10.5px 字 / 更紧的间距），
     *    否则吸附头会把只有 344px 高的正文挤没。
     *  ⚠ 「全部」那颗只在**没有**选中任何小类时高亮；选中某类时高亮跟着它走。
     *  ⚠ 只有一个小类时整行不画（没得选，画了反而多占一行）。 */
    if (panelSubFilter) {
        const seen = new Map();
        for (const r of rows) {
            if (r.group !== panelGroupFilter || r.sub !== panelSubFilter) continue;
            const k = r.cat || '未分类';
            seen.set(k, (seen.get(k) || 0) + 1);
        }
        if (seen.size > 1) {
            const host = document.createElement('nav');
            host.className = 'cat-nav pick-nav cat-row';
            host.id = 'panelPick3';
            host.setAttribute('aria-label', '小类');
            let total = 0;
            for (const n of seen.values()) total += n;
            panelPickChip(host, null, '全部', total,
                '不限定小类（列出这个中类下的全部引擎）',
                panelCatFilter === null,
                (k) => {
                    panelCatFilter = k;
                    renderPanel();
                    requestAnimationFrame(() => setTimeout(pushLayout, 0));
                });
            for (const [k, n] of seen) {
                panelPickChip(host, k, k, n,
                    '只看「' + k + '」（' + n + ' 个）',
                    panelCatFilter === k,
                    (k2) => {
                        panelCatFilter = k2;
                        renderPanel();
                        requestAnimationFrame(() => setTimeout(pushLayout, 0));
                    });
            }
            head.appendChild(host);
        }
    }
}
/* r53 兜底：胶囊选中之后，直接按 DOM 把不合的节收起来。
   —— 为什么还要这一层：正文的行过滤由 renderFlatBody 负责，但面板的渲染路径
   不止一条（搜索态 / 大类过滤 / 重画），只靠行过滤出现了"选了中类正文变空"的
   现象（探针 ③）。这一层只看 DOM，无论走哪条路径，选中的那一类一定留下、
   其余一定收起来；渲染逻辑不用动，也就不会再出现两种口径。 */
function applyPickFilter() {
    if (!panelBody) return;
    for (const t of panelBody.querySelectorAll('.cat-title[data-cat]')) {
        t.hidden = !!(panelSubFilter && t.dataset.cat !== panelSubFilter);
    }
    for (const s of panelBody.querySelectorAll('.cat-sub[data-sub]')) {
        const cat = String(s.dataset.sub || '').split('::')[1] || '';
        s.hidden = !!(panelCatFilter && cat !== panelCatFilter);
        const g = s.nextElementSibling;
        if (g && g.classList && g.classList.contains('grid')) {
            g.hidden = !!(panelCatFilter && cat !== panelCatFilter);
        }
    }
}