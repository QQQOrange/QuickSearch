//! 配置持久化：`<exe>\Quick search data\config.json`（v1.4.0 起便携 + 全加密）

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::imgsearch;

pub const APP_DIR: &str = "QuickSearch";

/* ══════════════════════════════════════════════════════════════════════
 * v1.4.0：`LOCKED` —— 「主文件解不开」时**禁止任何写盘**
 *
 * 场景：换过 Windows 用户/机器（或者 backup.key 丢了），本地 config.json
 * 是用备份密码加密的、现在没钥匙。这时程序只能带着默认配置跑。
 *
 * 如果不拦住写盘：`load()` 一看"主文件不可用"就 `save_to` 一份默认配置，
 * 把那份**完好但解不开**的加密配置直接覆盖掉 —— 用户一旦想起密码，
 * 数据已经没了。这比"这次没读到设置"严重一万倍。
 *
 * 所以只要出现过"解不开"，整个进程内 `save` 一律拒绝（日志留痕），
 * 用户的文件原样躺着，等他把密码填回来（或从云端恢复）再说。
 * ══════════════════════════════════════════════════════════════════════ */
static LOCKED: AtomicBool = AtomicBool::new(false);

/// 本次运行是不是处于「主文件解不开、已锁写」的状态（设置页可以据此提示）。
pub fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// 程序版本 —— **直接取自 `Cargo.toml`**，不手写。
///
/// # ⚠ 为什么改成这样（r80i 修的 bug）
///
/// 这里原来是手写的 `"1.0.0"`。发 v1.1.0 时我只改了 `Cargo.toml` /
/// `tauri.conf.json` / `package.json` 三处，**漏了这里** —— 于是：
///   · 关于页显示 "v1.0.0"
///   · 界面右下角显示 "v1.0.0"
///   · 而 exe 的版本资源是 1.1.0（那个来自 tauri.conf.json）
/// 用户直接看到"桌面版本的版本号没有更新"。
///
/// 手写版本号就是这么容易漏 —— 所以改成编译期从 `CARGO_PKG_VERSION` 取，
/// 它由 cargo 根据 `Cargo.toml` 自动注入，**根本不可能写错**。
/// 以后升版本只需要改 `Cargo.toml` 一处（另外两处是给打包/前端用的）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 开发者。「关于」页要显示出来（用户明确要求）。
pub const DEVELOPER: &str = "QQQOrange";

/// 这一版被**构建出来**的本地时间，形如 `2026-10-12 22:30:00`。
///
/// 由 `build.rs` 算出并注入（见那边的 `build_stamp::now_local`）。用
/// `option_env!` 是为了让「没有构建脚本的场合」（比如 rust-analyzer 单文件
/// 分析、或有人直接把 src 拖进别的工程）也能编译过 —— 那种情况下少一行信息，
/// 比编译不过强。
pub const BUILT_AT: &str = match option_env!("QS_BUILD_STAMP") {
    Some(s) => s,
    None => "未知",
};

/// 横条默认放这几个（和浏览器版一致）
pub const DEFAULT_BAR: &[&str] = &[
    "百度",
    "Google",
    "必应",
    "百度翻译",
    "知乎",
    "哔哩哔哩",
    "淘宝",
];

/// 选中文字丢给 AI 时，默认在后面追加的这句话。
/// 光把一段话扔给 AI，它常常回一句"好的，请问你想让我做什么"；补一句意图明确的
/// 后缀，点完图标就是一份完整的提问，AI 直接开始干活。
pub const DEFAULT_AI_SUFFIX: &str = "请解释一下这句话的意思，并说明它可能的出处或语境。";

/// 横条列表里代表「分隔线」的哨兵元素。
///
/// 把它做成 bar_list 里的一个普通元素、而不是单独的配置项，有两个好处：
///   ① 存档格式一个字都不用改，老配置照读，也不用写迁移代码；
///   ② 「分隔线往左挪一格」和「引擎往左挪一格」变成同一件事，排序逻辑只写一份。
/// 引擎名不可能正好是一个竖线，所以当哨兵不会误伤真引擎。
pub const SEP: &str = "|";

/// 横条列表里代表「OCR 按钮」的哨兵元素。
///
/// 为什么 OCR 也要当"横条成员"：用户要求**它在横条里的位置可以自定义**，
/// 而"位置自定义"天然就等于"和其它引擎一起拖"。塞进 bar_list 参与同一套排序，
/// 就不用为它单写一套「上下移动」按钮，也不用在设置页给它单开一个列表。
/// 渲染时遇到这个哨兵就画 OCR 按钮而不是引擎图标。
///
/// 和 `SEP` 同理：引擎名不可能正好是这一串，当哨兵不会误伤真引擎。
/// 前端 `window.QS_OCR` 必须与本常量保持一致。
pub const BAR_OCR: &str = "@ocr";

/// r61：横条上那顆「识图搜索」按钮的哨兵。
///
/// 用户原话：「识图搜索加入了横条，但是我在引擎页面横条上的引擎这里没有看到识图
/// 搜索的按钮，而且我希望识图搜索的那个图标也能够自己换。」
///
/// 所以它和 `BAR_OCR` 一样：能出现在「横条上的引擎」列表里、能用 `pick_icon`
/// 换图标（overrideIcons 的键就是这一串）。
/// 前端 `window.QS_IMG` 必须与本常量保持一致。
pub const BAR_IMG: &str = "@img";

/// v1.5.16：横条上「翻译」按钮的哨兵。
///
/// 和 `BAR_OCR` / `BAR_IMG` 完全同一套机制：能出现在「横条上的引擎」列表里、
/// 位置可拖动、能用 `pick_icon` 换图标（overrideIcons 的键就是这一串）。
/// 前端 `window.QS_TRANS` 必须与本常量保持一致。
pub const BAR_TRANS: &str = "@trans";

/// 用户自己加的搜索引擎。
///
/// 只存「名字 + URL 模板 + 分类」几样东西。图标故意不放进这个结构 ——
/// 它复用既有的「按引擎名换图标」机制（`overrides`），于是：
///   · 换图标、恢复默认图标这些功能立刻对新引擎生效，一行都不用改；
///   · 备份 / WebDAV 同步也不用为它单开一条通路。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct CustomEngine {
    /// 显示名，也是引擎的唯一标识（不能和内置引擎重名）
    pub name: String,
    /// URL。`kind=search` 时它是**模板**，必须含 `%s`（查询词会先做 URL
    /// 编码再替换进去）；`kind=open` 时它是**终点**，原样打开。
    pub url: String,
    /// 归到哪个分类下。填「AI 工具」就会被当成 AI 引擎 —— 自动追加提问后缀、
    /// 自动把整份提问放进剪贴板。
    pub category: String,
    /// 这个引擎是哪一类：`search` = 拿选中的词去搜；`open` = 直接打开指定页面；
    /// `hotkey` = 点了把一串按键模拟发给前台软件（不碰浏览器）。
    ///
    /// 老配置里没有这个字段 → `Search`（历史行为：自定义引擎一直是要带 %s
    /// 的搜索入口）。见 [`EngineKind`]。
    pub kind: EngineKind,
    /// `kind=hotkey` 时的按键序列，例如 `ctrl+shift+t`、`alt+tab`、`f5`。
    /// 两类别的引擎这里是空串。解析与合成在 `win::send_hotkey`。
    pub hotkey: String,

    /* ---------------- r58：快捷键引擎的「绑定应用」 ---------------- */
    /// 开不开「先确保这个应用在跑，再发快捷键」这套逻辑。
    ///
    /// 用户原话：「绑定应用，作用是一个快捷键……软件内部要先确定这个应用真的
    /// 已经打开了，如果打开了就直接把这个快捷键给运用出来，如果没有打开，那就
    /// 先打开这个应用，然后再实行快捷键。每一个快捷键引擎都要添加一个这个逻辑
    /// 的开关。」
    ///
    /// 所以它是一个**开关**而不是"配了就一定生效"：用户可能就想要"不管应用在
    /// 不在，直接把键发出去"（比如那个键是全局热键，应用自己在后台收）。
    /// 关掉时行为与本功能不存在之前**完全一样**。
    #[serde(default)]
    pub bind_app: bool,
    /// 绑定的应用（exe / 快捷方式路径）。`bind_app=false` 时忽略。
    ///
    /// 判"是不是同一个应用"按**文件名**比，不按全路径（见 `win::exe_name_of`
    /// 的注释：同一个程序可能从快捷方式、更新后的新目录启动）。
    #[serde(default)]
    pub app_path: String,
    /// 拉起这个应用时要不要**以管理员身份**运行（走 `ShellExecuteW` 的
    /// `runas` 动词，会弹 UAC）。
    ///
    /// 用户原话：「也要可选是否以管理员方式打开该应用」。
    /// ⚠ 只影响"由我们拉起来"的那一次；应用已经在跑时不会去动它的权限。
    #[serde(default)]
    pub app_admin: bool,
    /// 「启动应用 → 发快捷键」之间**额外再等多少毫秒**（r76）。
    ///
    /// 用户原话：「如果一个软件没打开，但我这个快捷键是绑定这个软件的，那么就会
    /// 先打开这个软件，再按快捷键，那么打开软件与按快捷键之间中间有一个时差，
    /// 那么这个时间是可以在设置当中自己设置的」。
    ///
    /// 默认 **900**：窗口建出来 ≠ 能收键盘（程序还在读配置/建 UI/加载数据），
    /// 早就为了"第一次点没反应"加过一拍 900ms 的等待，那一拍以前是写死的。
    /// 现在它变成可调的：
    ///   · 大型软件（IDE / 设计软件）常常 900ms 不够 → 调大；
    ///   · 小工具秒开 → 调小，甚至 0，少等一瞬。
    /// ⚠ 只对「**本次由我们拉起来**」的应用生效 —— 本来就在跑的不用等
    ///   （它早就初始化完了）。与 `app_admin` 一样只对快捷键类引擎有意义，
    ///   其余类恒为 0（见 `clean_custom_engine`）。
    #[serde(default = "default_app_launch_delay")]
    pub app_launch_delay: u32,
    /// **触发这个快捷键时，要不要把目标应用的主窗口调到前台。**
    ///
    /// # 用户原话（这一版新增开关的直接原因）
    ///
    /// 「如果这个软件已经存在于后台，那没有必要说我触发这个快捷键的时候把这个
    ///   快捷键给换出来。比如说我设置了一个 alt+a 的微信截图快捷键，那微信在
    ///   后台挂着的时候，那就算它需要检测微信留存，那没有必要把微信的窗口换
    ///   出来，然后再 alt+a。」
    ///
    /// 「在每一个快捷引擎里面添加个按钮，打开这个按钮之后，点击这个快捷引擎
    ///   图标触发快捷键会把主窗口打开，如果把这个按钮关闭，那么触发快捷引擎
    ///   功能就不会把相应软件的主窗口打开。」
    ///
    /// # 两种语义（`false` 是默认，也是用户的主要诉求）
    ///
    ///   · **`false`（默认）** —— 应用**已经在跑**就**不动它的窗口**：
    ///     直接把按键注入给系统，由系统路由。适合"后台常驻、靠全局热键响应"
    ///     的工具（微信截图、章鱼速贴、各种截图/剪贴板工具）。
    ///     应用**没在跑**时仍然会拉起来（不然按键无处可去），
    ///     那种情况把它带到前台是合理的 —— 用户刚"打开"它。
    ///
    ///   · **`true`** —— 每次触发都把目标窗口抢到前台再发键。
    ///     适合"必须在那个窗口里才生效"的程序（老式 Win32 菜单命令、
    ///     只吃局部热键、或者用户就是想看着它执行）。
    ///
    /// ⚠ 为什么默认 `false` 而不是 `true`：`true` 会**打断用户手上的事**
    ///   （他正打字、正在别的窗口操作），而这个引擎的全部意义是"不离开当前
    ///   工作就完成一件事"。真要看着目标窗口的人，自己去打开这个开关。
    ///
    /// ⚠ 只对快捷键类有意义（`clean_custom_engine` 会把其它类强制成默认值）。
    #[serde(default)]
    pub app_bring_front: bool,
}

impl Default for CustomEngine {
    fn default() -> Self {
        Self {
            name: String::new(),
            url: String::new(),
            category: String::new(),
            kind: EngineKind::Search,
            hotkey: String::new(),
            bind_app: false,
            app_path: String::new(),
            app_admin: false,
            app_launch_delay: default_app_launch_delay(),
            // r90：默认**不**把目标窗口调到前台（用户的主要诉求）
            app_bring_front: false,
        }
    }
}

/// 引擎的三个种类 ——「跳转过去触发搜索」「直接打开指定页面」「模拟一串按键」。
///
/// 内置 engines.json 的每个条目也带同名字段（`kind: "search" | "open" | "hotkey"`，
/// 缺省按 URL 里有没有 `%s` 推断）。三类的区别贯穿全链：
///   · 数据：search 的 url 带 `%s`；open 不带；hotkey 的 url 为空、按键序列放 `hotkey` 字段；
///   · 界面：面板格子 / 横条气泡 / 设置列表各有「搜 / 开 / 键」徽标；
///   · 调用：open 不要求有选中文字；hotkey 同样不要求，点了直接合成按键。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    /// 搜索类：选中文字（或手打关键词）后点它，跳到目标站点并自动带上搜索词
    #[default]
    Search,
    /// 直达类：不依赖选中文字，点了直接打开目标软件的指定页面
    Open,
    /// 快捷键类：不依赖选中文字，点了把 `hotkey` 里的按键序列模拟发给前台软件
    /// （例如 `ctrl+shift+t` 重新打开刚关的标签页、`win+d` 显示桌面）
    Hotkey,
}

impl EngineKind {
    /// 配置里序列化/反序列化用的字符串形式（"search" / "open" / "hotkey"）。
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineKind::Search => "search",
            EngineKind::Open => "open",
            EngineKind::Hotkey => "hotkey",
        }
    }

    /// 从任意来源（内置 json / 用户填写）解析种类；不认识的一律按 search
    /// （历史默认行为，宁可多要求一个 %s，也不把搜索入口静默变成直达）。
    pub fn parse(s: &str) -> EngineKind {
        if s.trim().eq_ignore_ascii_case("open") {
            EngineKind::Open
        } else if s.trim().eq_ignore_ascii_case("hotkey") {
            EngineKind::Hotkey
        } else {
            EngineKind::Search
        }
    }
}

/// 自定义引擎没填分类时用的默认分类名
pub const DEFAULT_CUSTOM_CATEGORY: &str = "自定义";

/// 外部软件启动器：用户把第三方应用「加成一颗引擎」摆在横条上，点一下直接唤起。
///
/// 和 [`CustomEngine`]（搜索引擎）是两回事，别混：
///   · CustomEngine 的 url 带 `%s`，点它 = 拿当前选中的词去搜；
///   · ExternalApp 的 url 是**终点**，点它 = 原样打开（网页 / 软件自己的协议链接 /
///     本地程序路径），跟当前选中什么文字毫无关系。
///
/// 用 `id` 而不是 `name` 做键：名字用户随时能改，而改名不该让横条上那一格
/// 凭空消失（自定义引擎用 name 做键，改名就得迁移一串引用，很痛）。
/// 放进横条的哨兵是 `@app:<id>`（见 [`APP_PREFIX`]）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
#[derive(Default)]
pub struct ExternalApp {
    /// 唯一 id。横条哨兵 = `APP_PREFIX + id`，也是自定义图标的键。
    pub id: String,
    /// 显示名（随时能改，不影响横条上那一格 —— 那是按 id 钉的）
    pub name: String,
    /// 目标地址：网页 / 软件自己的协议链接（weixin:// 之类）/ 本地程序路径
    pub url: String,
    /// 用途分类（#135）：`"search"` = 搜索类（url 必须带 `%s`，拿选中文字去搜）、
    /// `"open"` = 打开类（url 禁带 `%s`，原样打开）。空串 = 老数据没存过，
    /// 由 [`app_kind`] 按 url 里有没有 `%s` 现推，读出来永远非空。
    pub kind: String,
}


/// 一条外部软件的用途分类：`"search"` / `"open"`。
///
/// kind 为空（老配置、没存过这个字段）时按 url 里有没有 `%s` 现推 ——
/// 和 shared.js 的 `qsEngineKind` 对网页引擎的推断同一个口径。
pub fn app_kind(url: &str, kind: &str) -> &'static str {
    match kind {
        "search" => "search",
        "open" => "open",
        _ => {
            if url.contains("%s") {
                "search"
            } else {
                "open"
            }
        }
    }
}

/// 横条列表里代表「外部软件」的哨兵前缀：`@app:<id>`。
/// 和 `@fav:` 一样是保留名 —— 后面那段 id 由后端在 `apps` 里查。
/// 前端 `window.QS_APP_PREFIX` 必须与本常量保持一致。
pub const APP_PREFIX: &str = "@app:";

pub fn is_app_sentinel(name: &str) -> bool {
    name.starts_with(APP_PREFIX)
}

/// 由 app id 拼出横条哨兵
pub fn app_sentinel(id: &str) -> String {
    format!("{APP_PREFIX}{id}")
}

/// 剪掉 `bar_list` 里指向**已经不存在的外部软件**的 `@app:<id>` 哨兵。返回剪掉几个。
///
/// 和 [`prune_dangling_fav_sentinels`] 同一个病根：删 app 只动 `apps`，
/// `bar_list` 里那根哨兵谁也不管的话，设置页「横条上的引擎」会把
/// `@app:xxxx` 原文当引擎名显示出来（用户看到的就是"乱码"）。
pub fn prune_dangling_app_sentinels(cfg: &mut Config) -> usize {
    let ids: std::collections::HashSet<&str> =
        cfg.apps.iter().map(|a| a.id.as_str()).collect();
    let before = cfg.bar_list.len();
    cfg.bar_list
        .retain(|n| !is_app_sentinel(n) || ids.contains(&n[APP_PREFIX.len()..]));
    before - cfg.bar_list.len()
}

/// r89：剪掉 `bar_list` 里**找不到定义**的引擎名。返回剪掉的条数。
///
/// # 为什么需要（这条是给用户报的真 bug 收尾）
///
/// 用户报：「我之前把一个快捷键引擎加入到了横条，但是现在在引擎库里面我找不到
/// 那个引擎，但横条里有客观存在这个，我通过搜索方式也搜索不出来。」
///
/// 查下来是**`bar_list` 里留着一个没有定义的孤儿名字**：
/// `custom_engines` 里没有它、内置目录里也没有它，于是
///   · 引擎库（数据源是"目录 + custom_engines"）**看不到**它；
///   · 搜索也搜不到（搜的就是引擎库那份数据）；
///   · 横条那边按名字查不到定义，渲染成一颗点不动的幽灵图标。
///
/// 造成孤儿的最直接原因是"定义被覆盖/删除、但 `bar_list` 没跟着清"。
/// 正常路径（`remove_custom_engine`）是**会**清 `bar_list` 的，所以这次是
/// 一份被覆盖的配置留下的历史垃圾；而程序**没有任何机制**去发现并修复它，
/// 于是它就那么一直躺着，用户只看到"横条上有、引擎库里没有"。
///
/// 所以补这一道启动自检：凡是横条里既不是分隔线、也不是哨兵、又不在
/// 「内置引擎 + 自定义引擎」名单里的名字，一律剪掉。
///
/// ⚠ 只剪"**确定无定义**"的条目，判断口径必须和前端完全一致：
///   · 分隔线 `|`、OCR 哨兵 `@ocr`、识图哨兵 `@img`、外部软件哨兵
///     `@app:<id>` 都不是引擎名，跳过（前三个由别处校验，`@app:` 由
///     `prune_dangling_app_sentinels` 管）；
///   · 剩下的必须在 `engines::engines()`（内置）或 `custom_engines` 里找得到。
///   口径不一致的后果很严重：剪错了就等于**用户横条上的引擎无故消失**。
pub fn prune_undefined_bar_engines(cfg: &mut Config) -> usize {
    let builtin = crate::engines::engines();
    let custom: std::collections::HashSet<&str> =
        cfg.custom_engines.iter().map(|e| e.name.as_str()).collect();
    let before = cfg.bar_list.len();
    cfg.bar_list.retain(|n| {
        /* 分隔线与**所有**哨兵：不在这里判（各有各的归属校验）。
         *
         * ⚠ 这一串必须穷举干净 —— 漏一个就等于"用户横条上那格无故消失"。
         *   实测漏 `@fav:` 时，既有测试 `sanitize_prunes_dangling_sentinels`
         *   立刻变红（它构造了 `@fav:alive` 并期望它留着）。**这条测试救了我**：
         *   我第一版只排除了 `|` / `@ocr` / `@img` / `@app:` 四种。
         *
         * 现有哨兵全集（改这里时对着 config.rs 里的常量清单核一遍）：
         *   `|`        分隔线（SEP）
         *   `@ocr`     OCR 按钮
         *   `@img`     识图搜索按钮
         *   `@trans`   翻译按钮
         *   `@app:<id>`  外部软件
         *   `@fav:<id>`  收藏夹
         */
        if n == SEP
            || n == BAR_OCR
            || n == BAR_IMG
            || n == BAR_TRANS
            || is_app_sentinel(n)
            || is_fav_sentinel(n)
        {
            return true;
        }
        // 空白名没意义，剪掉
        if n.trim().is_empty() {
            return false;
        }
        builtin.contains_key(n.as_str()) || custom.contains(n.as_str())
    });
    before - cfg.bar_list.len()
}

/// 一条自定义引擎"能不能真的用起来"。
///
/// 判据和前端 `qsMergeCustomEngines` **逐条同源**（那边是 `kind === 'hotkey' &&
/// !hotkey → continue` / `kind !== 'hotkey' && !url → continue`）：
///   · 快捷键类：要有一串按键（`hotkey`），地址本来就没意义；
///   · 搜索 / 打开类：要有地址（搜索类还要求带 `%s`，那是写入时校验的，这里只管空）。
///
/// ⚠ 两边口径必须一致，否则就会出现用户报的那个 bug：后端认为"这条引擎是好的"
///   （所以 `toggle_bar_engine` 放行、设置页显示「已在横条」），而前端合并目录时
///   按同一份数据把它当成"没定义"跳过 —— 横条渲染时按名字查不到，那一格就
///   **画不出来**。用户看到的正是「设置里明明在横条上，横条里却没有」。
pub fn custom_engine_usable(e: &CustomEngine) -> bool {
    match e.kind {
        EngineKind::Hotkey => !e.hotkey.trim().is_empty(),
        _ => !e.url.trim().is_empty(),
    }
}

/// 修「空壳」自定义引擎。返回救回来的条数。
///
/// # 为什么需要（用户报的 bug，2026-10-22）
///
/// 「我把两个快捷键引擎固定到了横条里面，但横条里实际没显示，设置里又看到
///   它们被放在了横条上。」
///
/// 现场：配置里那两条是 `{name:"微信截图", url:"", kind:"search", hotkey:""}` ——
/// 既是搜索类（要求地址）又没地址、也没有按键序列，什么都干不了。查本地备份
/// 可以确认它们是**被一份缺字段的云端备份覆盖**成这样的（12:18 的备份里还是
/// `kind:"hotkey", hotkey:"alt+a", app_path:"D:\software\Weixin\Weixin.exe"`，
/// 13:56 那次「云端备份较新，已恢复到本机」之后就全空了）。
/// 根因那半边在 `apply_view`（已修）；这里只做**补救**。
///
/// 处理：有按键序列、只是种类丢了 → 认回快捷键类（救回来）。
///
/// ⚠ 真·空壳（什么都没有）这里**不删、也不从横条上摘**。用户原话：
///   「你不能把它给删掉啊！没显示是很严重的问题」—— 定义是他起的名字、
///   上面还挂着他换过的图标，摘掉等于把他做的东西藏起来。
///   横条那边改成：画一颗带「!」的格子，点一下提示「去设置里补上」
///   （bar.js 的 `barList()` / `renderBar`），设置页那一行标红。
///   这样"设置说在横条上"和"横条里看得见"两句话重新对得上。
pub fn repair_dead_custom_engines(cfg: &mut Config) -> usize {
    let mut fixed = 0usize;
    for e in cfg.custom_engines.iter_mut() {
        if custom_engine_usable(e) {
            continue;
        }
        /* 名字上挂着「手工改写的地址」（url_overrides）也算能用 —— `engine_entry`
         * 的优先级是 url_overrides > custom_engines，它真能打开 / 能搜。 */
        if cfg.url_overrides.contains_key(&e.name) {
            continue;
        }
        // 有按键序列 → 它本来就是快捷键类，只是种类丢了（缺字段的备份常见）
        if e.kind != EngineKind::Hotkey && !e.hotkey.trim().is_empty() {
            e.kind = EngineKind::Hotkey;
            e.url = String::new();
            fixed += 1;
            continue;
        }
        crate::win::log(&format!(
            "config: 自定义引擎「{}」既没地址也没按键序列（可能是缺字段的备份覆盖过），横条上会显示成待补全的格子",
            e.name
        ));
    }
    fixed
}

/// r72：把识图按钮并进 `bar_list`（`@img` 哨兵）。返回是否改动过。
/// 以前识图是横条上一个**位置固定**的按钮（`#btnImg`），不在 bar_list 里，
/// 所以设置页那一行只能写「位置固定」：不能上下移、不能拖、也没有「移出」。
/// 用户原话：「识图搜索加入了横条之后，在引擎横条上的引擎这个框架里面，它只有
/// 一个换图标的按钮，应该也要有一个编辑图标，恢复默认图标，移出的按钮，也能
/// 通过按钮来进行引擎位置的移动，以及通过按住来移动位置。」
///
/// 要这五件事都成立，它就必须和普通引擎一样是 bar_list 的成员 —— 排序、拖拽、
/// 移除全是按这张表走的。老配置里没有这根哨兵，所以启动时补一根（追加到末尾，
/// 和它原来在横条上的位置基本一致）；«关掉识图» 或 «不加到横条» 的配置不补。
pub fn ensure_img_bar_sentinel(cfg: &mut Config) -> bool {
    if !cfg.img_enable || !cfg.img_add_to_bar {
        return false;
    }
    if cfg.bar_list.iter().any(|n| n == BAR_IMG) {
        return false;
    }
    cfg.bar_list.push(BAR_IMG.to_string());
    true
}

/// v1.5.16：把翻译按钮并进 `bar_list`（`@trans` 哨兵）。
///
/// 和 `ensure_img_bar_sentinel` 同一套道理：翻译按钮要能拖位置、能换图标、
/// 能移出，就必须是 bar_list 的一员。老配置里没有这根哨兵，启动时补一根
/// （追加到末尾）；「翻译」总开关关着时不补 —— 用户主动关掉的功能，
/// 不该在升级时又把按钮塞回横条。
pub fn ensure_trans_bar_sentinel(cfg: &mut Config) -> bool {
    if !cfg.trans_enable {
        return false;
    }
    if cfg.bar_list.iter().any(|n| n == BAR_TRANS) {
        return false;
    }
    cfg.bar_list.push(BAR_TRANS.to_string());
    true
}

/// 一次翻译参与的引擎（口径同 main.rs 的 `ocr_engine_plan`）：
/// 默认引擎 + 「同时翻译」名单，按**注册表顺序**排（翻译窗里几家文本框的
/// 左右顺序由此决定，稳定才找得到自己要看的那家），并去重。
///
/// `sanitize` 已经保证过两份名单都合法，这里仍然逐个 `find` 兜底 ——
/// 命令路径（`trans_run` 等）拿到的配置可能来自还没 sanitize 的快照。
pub fn trans_plan(c: &Config) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let def = c.trans_engine.trim();
    if crate::trans_engines::find(def).is_some() {
        out.push(def.to_string());
    }
    for e in crate::trans_engines::ENGINES {
        if e.id == def {
            continue;
        }
        if c.trans_multi.iter().any(|x| x == e.id) && !out.iter().any(|x| x == e.id) {
            out.push(e.id.to_string());
        }
    }
    out
}

/// 某家翻译引擎的凭据（用户填的那部分）。
///
/// 模型 / base 的**缺省值不在这里补** —— 那是注册表的事，读的人统一走
/// `trans_engines::Creds::model_for / base_for`（和 OCR 的 `ocr_creds`
/// 一个路子：填了用填的，没填用注册表预置的）。
pub fn trans_creds(c: &Config, id: &str) -> crate::trans_engines::Creds {
    let g = |m: &HashMap<String, String>| m.get(id).cloned().unwrap_or_default();
    crate::trans_engines::Creds {
        key: g(&c.trans_keys),
        secret: g(&c.trans_secrets),
        base: g(&c.trans_bases),
        model: g(&c.trans_models),
    }
}

/// 外部软件地址里**不允许出现**的协议。
///
/// 这些要么是脚本/数据载体（javascript:、data:、vbscript:），要么是
/// 浏览器内部页面（about:、chrome:、res:），要么是 Windows 上出了名的
/// 漏洞载体（ms-msdt:、search-ms:、mhtml:）。它们对「打开一个软件」没有任何
/// 正当用途，拦住比留着安全。
const APP_URL_BLOCKED_SCHEMES: &[&str] = &[
    "javascript", "vbscript", "data", "blob", "about", "chrome", "edge",
    "res", "mhtml", "ms-msdt", "search-ms",
];

/// 地址长度上限。再长的地址不可能是人手填的，只可能是误粘贴。
pub const APP_URL_MAX: usize = 2048;

/// 只校验**地址**本身（打开前也要走一遍，见 main.rs 的 open_app）。
/// 错误信息都是直接给用户看的中文。
pub fn validate_app_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("地址不能为空".into());
    }
    if url.chars().count() > APP_URL_MAX {
        return Err("地址太长了，检查一下是不是贴错了".into());
    }
    if url.chars().any(|c| c.is_whitespace()) {
        return Err("地址里不能有空格（空格请写成 %20）".into());
    }
    // 取协议名：第一个冒号之前那一段。没有冒号 = 用户填的是
    // 「www.example.com」这种不带协议的形式 —— 不猜，直接要求补全。
    let Some(colon) = url.find(':') else {
        return Err("地址要带协议，例如：\nhttps://example.com\nweixin://\nfile:///C:/App/app.exe".into());
    };
    let scheme = &url[..colon];
    if scheme.is_empty()
        || !scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return Err("协议名不对：地址要以「字母://」开头，例如 https://".into());
    }
    let lower = scheme.to_ascii_lowercase();
    if APP_URL_BLOCKED_SCHEMES.contains(&lower.as_str()) {
        return Err(format!("「{lower}:」这种地址打不开软件，已拦住"));
    }
    // http/https 至少得有个主机名，光一个 https:// 没有意义
    if lower == "http" || lower == "https" {
        let rest = &url[colon + 1..];
        let host = rest.strip_prefix("//").unwrap_or("");
        if host.trim_matches('/').is_empty() {
            return Err("http(s) 地址后面要跟上网址，例如 https://example.com".into());
        }
    }
    Ok(())
}

/// 校验并产出一条外部软件记录。错误信息都是直接给用户看的中文。
///
/// `skip_id` = 编辑时正在改的那条的 id（重名检查要跳过自己）。
/// 新建时传 None，`id` 由调用方用 [`new_app_id`] 现生成一个。
///
/// `kind`（#135）= `"search"` / `"open"`，空串按 url 有没有 `%s` 现推
/// （容忍没带类型的老调用方）。类型与地址必须自洽，契约和网页引擎三类型
/// 完全一致：搜索类的 `%s` 代表选中的文字，打开类原样打开、带了 `%s`
/// 反而打不开。
pub fn clean_app(
    cfg: &Config,
    name: &str,
    url: &str,
    kind: &str,
    skip_id: Option<&str>,
) -> Result<ExternalApp, String> {
    let name = name.trim();
    let url = url.trim();

    let kind = match kind {
        "search" => "search",
        "open" => "open",
        "" => {
            if url.contains("%s") {
                "search"
            } else {
                "open"
            }
        }
        _ => return Err("类型只能选「搜索」或「打开」".into()),
    };

    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    if name.chars().count() > 24 {
        return Err("名字太长了，控制在 24 个字以内".into());
    }
    if name.contains(SEP) {
        return Err("名字里不能有竖线「|」，它被用作分隔线的标记".into());
    }
    if name == BAR_OCR {
        return Err("名字不能是「@ocr」，它是横条上 OCR 按钮的标记".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("名字里不能有换行之类的控制字符".into());
    }
    for a in cfg.apps.iter() {
        if Some(a.id.as_str()) == skip_id {
            continue;
        }
        if a.name == name {
            return Err(format!("已经有一个叫「{name}」的外部软件了"));
        }
    }

    validate_app_url(url)?;

    // 类型与地址自洽（和 engines.json 的 kind 不变量同一条契约）：
    // 搜索类必须带 %s，打开类禁带 —— 带着 %s 点打开类，字面量 "%s" 会被
    // 当成地址的一部分，必然打不开。
    if kind == "search" && !url.contains("%s") {
        return Err("搜索类地址里必须带 %s（它代表选中的文字）".into());
    }
    if kind == "open" && url.contains("%s") {
        return Err("打开类地址里不能有 %s —— 它是原样打开的，带了会打不开".into());
    }

    Ok(ExternalApp {
        id: String::new(),
        name: name.to_string(),
        url: url.to_string(),
        kind: kind.to_string(),
    })
}

/// 生成一个不会撞的 app id。
///
/// 时间戳（毫秒）+ 进程内自增。⚠ 老写法是 `format!("{ms:x}{n:x}")` 再
/// `truncate(12)` —— 毫秒位就有 12+ 字符，序号被整段切掉，**同一毫秒里
/// 连点两次「添加」就撞 id**（哨兵按 id 钉，撞了就是两个格子抢同一个软件）。
/// 现在改成：毫秒只保留低位、序号放后面且绝不参与截断。
pub fn new_app_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // base36 压一下长度：config.json 里这一串要出现两次（apps.id + bar_list 哨兵）
    let ms_hex = format!("{ms:x}");
    // 毫秒取低 9 位（36 bit，约 3.4 年才绕回）+ 序号原样接在后面。
    // 软件总数有 60 上限，序号实际不超过两位，整串最长 12 字符。
    let keep = ms_hex.len().saturating_sub(9);
    format!("{}{n:x}", &ms_hex[keep..])
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    /// 鼠标拖选就弹
    pub trigger_select: bool,
    /// Ctrl+C 也弹
    pub trigger_copy: bool,
    /// 开机自启
    pub auto_start: bool,
    /// 图标边长（CSS px）
    pub icon_size: u32,
    /// 横条不透明度（30-100）
    pub alpha: u32,
    /// 横条**待机（鼠标没悬停）时**的不透明度（10-100）。
    ///
    /// 交互：横条弹出后先按这个值半透明地「让开」屏幕内容，鼠标一悬停就
    /// 平滑过渡到完全不透明（`.bar.qs-dim` → 去掉该类，CSS transition）；
    /// 鼠标移开又回到待机值。设成 100 等于关掉这套行为（和以前一样）。
    ///
    /// ⚠ 旧 config.json 里没有这个字段时按 45 处理（升级即生效，但远没到
    ///    看不见的程度；想要旧行为把滑块拉到 100 即可）。
    #[serde(default = "default_dim_alpha")]
    pub bar_dim_alpha: u32,
    /// 液态玻璃总开关。开 = 横条弹出时抓一块背后的桌面当纹理，由前端 WebGL2
    /// 按 liquidGL 同款数学渲染（真折射 / 倒角 / 色差 / 高光）。
    /// 关 = 回到普通磨砂底板（`data-blur` 那套）。
    pub bar_glass: bool,
    /// 折射强度（0-60，实际值 = 该数 / 1000）。liquidGL 默认 0.01；
    /// 横条矮（60px 上下），边缘可读的扭曲需要更陡的梯度，默认 20（=0.02）。
    pub bar_glass_refraction: u32,
    /// 倒角深度（0-30，实际值 = 该数 / 100）。liquidGL 默认 0.08。
    /// 控制"玻璃有多厚"—— 边缘处背景被放大的程度。
    pub bar_glass_bevel: u32,
    /// 磨砂半径（CSS px，0-12）。0 = 完全清晰（真玻璃默认就是清的）。
    pub bar_glass_frost: u32,
    /// 色差强度（0-100）。蓝移大于红移，模拟真玻璃的色散 ——
    /// 这是"一眼看出不是塑料"的关键线索，默认 35。
    pub bar_glass_aberration: u32,
    /// 高光 / 边缘亮线强度倍率（0-200，100 = 基准）。同时驱动
    /// 指针跟随的镜面光斑和上下缘的锐利亮线。
    pub bar_glass_spec: u32,
    /// 染色强度（0-100）。玻璃本体微微带色（亮色下偏白、暗色下偏深蓝），
    /// 由前端按明暗主题选色，这里只给强度。
    pub bar_glass_tint: u32,
    /// 实时刷新：横条开着的时候持续重抓背后的桌面（背后放视频也能跟着动）。
    /// 关 = 只在弹出时抓一次（零成本、零闪烁）。
    pub bar_glass_live: bool,
    /// **实时刷新的帧率上限**（0 = 跟随显示器）。
    ///
    /// # 为什么要有这个选项
    ///
    /// 用户报：「滚动网页时横条里的液态玻璃**不跟随**，像卡住了一样」。
    /// 根因是我给实时抓屏链限了 15fps（66ms 一轮），滚动时背景变化
    /// 肉眼可见地滞后。
    ///
    /// # 各档位的代价（**实测**，不是估的）
    ///
    /// 关键发现：抓屏里的 `BitBlt` 有 **6.24ms 的固定开销，与抓取面积无关**
    /// （实测 16×16 和 852×176 都是 6.24ms，1920×1080 才 12.5ms）。
    /// 那是 Windows 上从**屏幕 DC** 抓取的固有代价（要等 DWM 合成 / GPU 回读），
    /// 换 API 或减少拷贝都省不掉。所以抓屏频率**直接**换算成 CPU：
    ///
    /// | 上限 | 抓屏占单核 |
    /// |---|---|
    /// | **30（默认）** | **18.7%** |
    /// | 60  | 37.4% |
    /// | 120 | 74.8% |
    /// | 0（跟随显示器，实测 85） | ≈53% |
    ///
    /// 定 **30** 作默认，是按用户的原话"能接受为美观增加的合理开销，但一定要合理"：
    /// 30fps 已经完全看不出滞后（滚动、放视频都跟得上），而开销压在单核 19% 以内。
    /// **"跟随显示器"仍然保留** —— 它最跟手，但代价明确标在设置页上，由用户自己选。
    ///
    /// ⚠ **15 那一档已删**（用户要求）：它正是"卡住"的来源，留着只会让人误选。
    ///   所以白名单是 0/30/60/120 四档，别再往回加。
    pub bar_glass_fps: u32,
    /// 图标风格："auto" = 用内置图标（缺图标时退字母）；"letter" = 一律字母徽标
    pub icon_style: String,
    /// 「统一图标大小」：自动量出每个图标**实际画面**的大小，把自带透明留白的
    /// 图标放大到和铺满型图标一样的视觉尺寸。
    ///
    /// 默认开。各来源图标的画布留白差别很大（内置 SVG 多数铺满，
    /// 用户自己换的 PNG 往往只剩 84%~96%），不归一就会一排大小参差不齐。
    /// 关掉则完全按原图显示（给不喜欢自动补偿的用户留后路）。
    pub unify_icons: bool,
    /// 横条胶囊的内边距（CSS px，0-12）
    pub bar_padding: u32,
    /// 圆角大小（CSS px，0-18）。一套值同时决定横条胶囊、图标按钮、
    /// 设置页预览的圆角，改一处就能整体从「方正」调到「全圆」。
    pub item_radius: u32,
    /// 横条与设置窗口共用的明暗皮肤：
    ///   "system" = 跟随系统日/夜间模式（默认）
    ///   "light"  = 恒定亮色
    ///   "dark"   = 恒定暗色
    ///
    /// #148 起横条不再「自动取色」（从当前软件窗口 UI 上采主色那条链路已删），
    /// 明暗只由这一条决定；老 config.json 里的 `auto_color` 字段被 serde
    /// 忽略，无感升级。
    pub theme: String,
    /// 弹出/展开动画
    pub animations: bool,
    /// 浮层投影（横条/面板/右键菜单下方的柔和阴影）。
    /// 默认**关闭**：投影会占掉一圈窗口空间，且深浅底下的观感差别很大，
    /// 交给用户自己按需打开。
    pub shadow: bool,
    /// 横条磨砂（背景模糊）强度（0-32，滑块值；0 = 关）。
    ///
    /// 用 `backdrop-filter: blur()` 把横条底下的屏幕糊掉，让横条有「玻璃感」。
    /// 0 = 完全不模糊（默认，原来的实色横条）；滑块值经 `qsBlurPx()` 换算成
    /// 实际模糊半径（1→2.3px … 32→24px 封顶），blur 只负责"糊"。
    ///
    /// 磨砂必须**配上半透明背景**才看得出效果：把「不透明度」调低即可
    /// （alpha 滑块是唯一的透明度控制，前后端一个口径）。
    pub bar_blur: u32,
    /// 横条固定出现在鼠标指针位置。
    ///
    /// false（默认）= 贴着选中的文字弹（文字下方放不下就自动翻到上方）；
    /// true = 一律贴着鼠标指针弹，适合「复制完就想在鼠标那儿点一下」的场景。
    ///
    /// 注意 Ctrl+C 那条触发路径**始终**跟随鼠标：那条路没有可靠的"文字在哪"信息，
    /// 而且用户按 Ctrl+C 时手指就在键盘上、鼠标也刚动过，贴鼠标反而更顺手。
    pub anchor_at_mouse: bool,
    /// 横条弹出时优先贴在选中文字的哪一侧：
    ///   `"above"` = 文字**上方**（默认，老行为）
    ///   `"below"` = 文字**下方**
    ///
    /// 用户 2026-10-24 原话：「还要可以选择横条是在选中文字的上方还是下方」。
    ///
    /// 这只是**首选方向**：首选那一侧放不下时照样会自动翻到另一侧
    /// （老逻辑就是"上方优先、放不下翻下方"，默认值沿袭这一行为）。
    /// 「跟随鼠标」打开、或走 Ctrl+C 那条路触发时本项无效 —— 那两条路
    /// 没有可靠的"文字在哪"信息，一律贴鼠标。
    #[serde(default = "default_bar_pos")]
    pub bar_pos: String,
    /// 收藏夹。`groups` 是一级目录；每个 group 里既能直接放 items，
    /// 也能放 children（二级目录）—— 用户要求最多两级。
    /// 放进横条的哨兵是 `@fav:<groupId>`（见 FAV_PREFIX）。
    /// 图片以 dataURL 形式存（导入时已压缩），所以跟着 config.json 一起备份/恢复。
    #[serde(default)]
    pub favorites: Vec<FavGroup>,
    /// 唤起收藏夹的组合键，如 "Ctrl+Alt+F"。空串 = 没启用。
    #[serde(default)]
    pub fav_hotkey: String,
    /// 备份密码。非空时，所有备份（云端上传 + 本机导出）都会用它做
    /// AES-256-GCM 加密（密钥用 Argon2id 从这个密码派生）。
    /// 和 WebDAV 密码一样只存本机 config.json。
    #[serde(default)]
    pub backup_password: String,
    /// 收藏夹面板被用户手动拉过的长宽（px），按目录各记各的。
    /// 键 = `@fav:<id>`（横条目录）/ `_root`（快捷键唤起的收藏夹根视图）。
    #[serde(default)]
    pub fav_panel_sizes: std::collections::BTreeMap<String, Vec<f64>>,
    /// 启动时自动以管理员身份重启自己。
    ///
    /// 默认开：只有管理员进程才把 Ctrl+C 送进同样是管理员的程序（任务管理器、
    /// 各种以管理员装的编辑器……里选词才不会哑火）。关掉之后下次启动就是普通权限。
    pub auto_elevate: bool,
    /// 松手之后等多少毫秒才弹横条（0 = 立刻弹）。
    /// 调大一点可以避开「手还在拖就已经弹出来」的观感。
    pub delay_ms: u32,
    /// 横条弹出后，多少秒没有任何操作就自己收起来（0 = 不收）。
    ///
    /// 用户 2026-10-23 原话：「还要给横条有一个时间逻辑，比如说横条出来了 5 秒，
    /// 但 5 秒没有任何的操作，那么就消失，这个时间逻辑在设置当中可调」。
    ///
    /// 判定在前端（`ui/bar.js`）：横条弹出、且**没打开面板/菜单**时开始计时，
    /// 指针移进横条、点击、按键、滚轮都会重置。只在横条那一排图标上生效 ——
    /// 用户打开「更多引擎」面板正在翻目录，那显然不算"没有任何操作"。
    #[serde(default = "default_bar_idle_sec")]
    pub bar_idle_sec: u32,
    /// 横条弹出后，鼠标离**弹出位置**超过多少像素就收起来（0 = 不收）。
    ///
    /// 用户原话：「如果横条出来之后，如果鼠标移动了很大的一个范围，那么就说明
    /// 这个横条是不会需要的，那这个时候横条就要消失」。
    ///
    /// 判定在 Rust（`bar_away_guard`）：只有全局钩子/轮询才看得见横条外面的
    /// 指针，页面里收不到那些事件。指针贴着横条时会把"基准点"跟着挪过去，
    /// 所以"从远处移向横条"不会被误判成"走开了"。
    #[serde(default = "default_bar_away_px")]
    pub bar_away_px: i32,
    /// **划选**没取到任何文字时**不弹**横条（默认开）。
    ///
    /// 这是"误触乱弹"的主要来源：拖窗口 / 拖滚动条 / 拖画布都会触发一次
    /// `mouseup` 取词，三条通道全失败时老版本照样弹一条**空横条**
    /// （r89 为"任何情况都要弹"加的兜底）。现在默认收紧：没文字就不弹。
    /// 真遇到自绘界面（游戏、部分 Electron / Qt 程序）划词取不到词的用户，
    /// 可以在设置里把这个开关关掉，回到"无论如何都弹"。
    ///
    /// ⚠ **只管划选这一条路**（2026-10-24 用户口径）：Ctrl+C 是用户主动按下的
    /// 第二条唤起通道，不适用这个开关 —— 它哪怕没复制到内容也一定弹
    /// （见 `main.rs` 的 `ctrl_copy_bar`）。两条路的"误触"性质完全不同：
    /// 拖动到处都是，Ctrl+C 只有真的按了才有。
    #[serde(default = "default_true")]
    pub bar_need_text: bool,
    /// 生效范围："off" = 全部软件；"blacklist" = 列出的软件里不弹；
    /// "whitelist" = 只在列出的软件里弹。
    pub filter_mode: String,
    /// 进程名列表（如 notepad.exe），不区分大小写
    pub filter_list: Vec<String>,
    /// OCR 功能总开关。关掉之后横条上的 OCR 按钮、Ctrl+Alt+O、托盘菜单项统统失效 ——
    /// 不用 OCR 的人可以收干净，避免误碰。
    ///
    /// r76：补上 `#[serde(default)]`。这个字段以前**没有** default，配置里少了它
    /// （手改文件 / 老版本留下 / 探针写的最小配置）时 serde 直接反序列化失败，
    /// 整份 load() 落到默认值上 —— 用户看到的是"设置全丢了"。
    /// 默认值 `ocr_enable: true`，与 `Default for Config` 保持一致。
    #[serde(default = "default_true")]
    pub ocr_enable: bool,
    /// 百度智能云文字识别的 API Key
    pub ocr_key: String,
    /// 同上，Secret Key
    pub ocr_secret: String,
/// 识别语言。
///
/// ⚠ 百度通用识别只认 `CHN_ENG`（中英混合）/ `ENG`（纯英文）……这一串枚举，
/// **没有「纯中文」这个值**。旧版本这里存过 `CHN`，发出去百度会回参数错误
/// （错误码 1/2/3），表现就是「配对了也识别不出来」。所以读配置时统一归一。
pub ocr_lang: String,
/// 用高精度版（accurate_basic）还是标准版（general_basic）。
///
/// 默认 **false**：标准版注册即送每日 500 次免费额度，而高精度版是**按量付费**
/// 的（0.005 元/次）。绝大多数用户没开通付费，默认给高精度等于一用就报错。
/// 勾了之后若高精度没权限，代码会自动降级回标准版，只是会提示一句。
pub ocr_accurate: bool,
    /// OCR 用哪个引擎：`baidu`（百度云，需要 API Key）或 `windows`
    /// （Windows 11/10 内置 OCR，离线、免费、更快）。默认百度 ——
    /// 因为没装语言包时本地识别会失败，百度是更稳的默认。
    pub ocr_engine: String,
    /// 双引擎并行识别（**r47 起废弃**，只留着读老配置做一次性迁移）。
    ///
    /// ⚠ 用户 r47 原话：「删除双引擎并行识别，因为原来双引擎并行识别就是为了
    ///   实现百度和本地的同时显示，但现在 ocr 这么多，那你怎么同时双行呢」。
    ///   它被 `ocr_multi` 取代 —— 不再是一个"开/关"，而是"选哪几家一起跑"。
    ///   迁移规则见 `Config::migrate_legacy`：老配置里这个开关是 true 的，
    ///   迁成 `ocr_multi = ["windows"]`（= 本地作为"额外同时跑"的那一家），
    ///   行为与升级前**逐字一致**，用户想关掉就取消勾选。
    pub ocr_parallel: bool,
    /// **同时识别**的引擎（r47 新增，取代 `ocr_parallel`）。
    ///
    /// 语义（口径来自用户）：
    ///   · `ocr_engine` 是**默认引擎**，任何一轮识别它一定参与；
    ///   · 这个列表是"**另外还要一起跑**的引擎"（不含默认引擎），可空；
    ///   · 真正参与一轮识别的 = `[默认引擎] + 这个列表`（去重后的
    ///     `ocr_run_engines`），结果页**只显示这些** —— 用户原话：
    ///     「同时也只会显示自己选择的那一个」「就算我打开了，也要我把本地的
    ///     识别引擎添加在多引擎识别里面，它才可以」。
    ///
    /// ⚠ 本地（`windows`）不再被**默认**塞进来：老代码的并行写死
    ///   `["windows", 在线那家]`，于是关掉并行之后结果页仍冒出"本地识别"
    ///   可点 —— 那正是用户报的 bug。现在本地要和别家一样被显式选中才参与。
    #[serde(default)]
    pub ocr_multi: Vec<String>,
    /// **结果窗是否固定在默认引擎那一档**（r49 新增，默认**开**）。
    ///
    /// 用户原话：「如果我先选硅基流动，然后在里面选同时显示本地 ocr，那这时候
    ///   硅基流动没跑出来，ocr 窗口会先跳到本地 ocr，照理来说就算没跑出来也应该
    ///   还是硅基流动的窗口，只是说我可以可选的点本地 ocr，而不能你自作主张
    ///   自动给我跳到本地 ocr」。
    ///
    /// 语义：
    ///   · `true`（默认）= 一轮识别结束后，结果窗**始终停在默认引擎**（`ocr_engine`）
    ///     那一档 —— 它还没回来就显示它的等待文案，回来了就地填上；想看他家自己点。
    ///   · `false` = 旧行为：谁先出字就先显示谁，等默认引擎出字了再自动切回去。
    #[serde(default = "default_true")]
    pub ocr_stay_default: bool,
    /// OCR 文本整理的**默认**开关（需求 7：设置 → 文字识别 里选默认开/关）。
    ///
    /// ⚠ 结果页那几颗按钮（去乱码 / 全角半角 / 合并换行 / 去空格）点的是
    ///   **这一轮**的临时覆盖，不改这里 —— 见 main.rs 的 OCR_CLEAN_OVERRIDE。
    ///   语义分开是有意的：设置是"我默认要什么"，按钮是"这张图我想怎么整理"。
    ///
    /// 去乱码：U+FFFD 替换符 / C0·C1 控制字符 / 零宽字符 / BMP 私用区。默认**关**。
    pub ocr_clean_garbage: bool,
    /// 空格档位：`off` / `smart`（只留单词间与中英之间的空格）/ `force`（除换行外全删）。
    /// 默认 `smart` —— 与老版本行为一致（那时固定走智能清理）。
    pub ocr_clean_space: String,
    /// 全角 → 半角：只动 ASCII 的全角镜像（ＦＦ０１..ＦＦ５Ｅ）与表意空格。默认**关**。
    pub ocr_clean_width: bool,
    /// 合并硬换行（PDF / 窄栏复制断行的修复）。默认**关** —— 它会改变排版，
    /// 该不该合并因材料而异，让用户自己决定。
    pub ocr_clean_unwrap: bool,
    /// 每家在线 OCR 引擎的凭据（需求 2：引擎从 2 家变成 14 家）。
    ///
    /// 键 = 引擎 id（见 `ocr_engines::ENGINES`），值 = 那家的密钥/模型/base。
    /// 分四个 map 而不是一个嵌套结构，是为了让"只改某一家某个字段"这件事
    /// 在 JSON 里也能一眼看懂、手改不容易写错。
    ///
    /// ⚠ 百度那两家**保留老字段** `ocr_key` / `ocr_secret`：老用户的密钥
    ///   存在那里，读的时候会回退过去（见 main.rs 的 ocr_creds），
    ///   所以升级上来不会"Key 突然没了"。
    pub ocr_keys: HashMap<String, String>,
    pub ocr_secrets: HashMap<String, String>,
    pub ocr_bases: HashMap<String, String>,
    pub ocr_models: HashMap<String, String>,

    /* ---------------- v1.5.16：翻译（多引擎，对齐 OCR 那套） ---------------- */
    /// 翻译功能总开关。关掉后横条上的翻译按钮不渲染、OCR 窗口里的翻译入口也失效。
    ///
    /// 默认**开**：真正的"入口"是 bar_list 里那个 `@trans` 哨兵 —— 用户把它加进
    /// 横条才会看见按钮，所以这里开着的默认值不会凭空多出个按钮。
    #[serde(default = "default_true")]
    pub trans_enable: bool,
    /// 默认翻译引擎（`trans_engines::ENGINES` 里的 id）。任何一次翻译它一定参与。
    pub trans_engine: String,
    /// **同时翻译**的引擎（v1.5.16，语义同 `ocr_multi`）：
    ///   · `trans_engine` 是默认引擎，一定参与；
    ///   · 这个列表是"另外还要一起翻的"（不含默认引擎），可空；
    ///   · 真正参与一次翻译的 = `[默认引擎] + 这个列表`（见 `trans_plan`），
    ///     翻译窗里**一家一个文本框并排呈现**。
    #[serde(default)]
    pub trans_multi: Vec<String>,
    /// 每家翻译引擎的凭据（v1.5.16）。键 = 引擎 id，值 = 那家的 Key/模型/base。
    /// 和 OCR 的 `ocr_keys` 那套一个路子：翻译和识别可能用不同账号/额度。
    /// 磁盘上不会明文落盘 —— 整个 config.json 是加密信封（见 `save_to`）。
    pub trans_keys: HashMap<String, String>,
    pub trans_models: HashMap<String, String>,
    pub trans_bases: HashMap<String, String>,
    /// 每家翻译引擎的**副凭据**（百度的「密钥」、有道的「应用密钥」）。
    ///
    /// 老牌那几家的凭据是"两样一起"：APP ID + 密钥 / 应用 ID + 应用密钥，
    /// 少一样都签不出请求。所以要单独一个 map（和 OCR 的 `ocr_secrets` 一个路子）。
    #[serde(default)]
    pub trans_secrets: HashMap<String, String>,
    /// 默认目标语言（语言代码，见 `trans::LANGS`）。默认 `zh`。
    ///
    /// ⚠ 这是**默认值**，不是"当前值"：翻译窗口里切了语言只影响那一次，
    ///   除非用户在窗口里点了「设为默认」—— 那个按钮才会写回这里。
    pub trans_target: String,

    /// 横条上显示哪些引擎、什么顺序
    pub bar_list: Vec<String>,
    /// 横条上两条分隔线之间的样式：line（细竖线）/ dot（点状）/ space（纯留白）
    pub sep_style: String,
    /// 用户自己添加的搜索引擎
    pub custom_engines: Vec<CustomEngine>,
    /// 用户自己加的外部软件（点横条上那一格直接唤起）
    #[serde(default)]
    pub apps: Vec<ExternalApp>,
    /// 引擎名 -> 自定义图标文件名（存在 icons 目录里）
    pub overrides: HashMap<String, String>,
    /// 引擎名 -> 自定义搜索 URL 模板（带 %s 占位符）。
    /// 给 AI 站点留的后路：官方页面哪天改了参数，用户不用等新版本，自己改一行就行。
    pub url_overrides: HashMap<String, String>,
    /// 所有 AI 引擎通用的提问后缀，例如「这句话什么意思？」。
    /// 会拼在选中的文字后面一起丢给 AI。
    pub ai_suffix: String,
    /// 引擎名 -> 该引擎专属的提问后缀（留空则用 ai_suffix）
    pub ai_suffixes: HashMap<String, String>,
    /// 点 AI 图标时，顺便把「文字 + 后缀」这份最终提问放一份到剪贴板。
    /// 各家 AI 网页对 URL 参数的支持各不相同，万一没自动填，用户 Ctrl+V 就能补上。
    pub ai_copy_prompt: bool,
    /// WebDAV 备份：服务器地址（目录形式）
    pub webdav_url: String,
    pub webdav_user: String,
    pub webdav_pass: String,
    /// 启动时同步：比较云端与本机的备份时间，谁新用谁
    pub webdav_on_start: bool,
    /// 退出时同步：把本机配置推到云端
    pub webdav_on_exit: bool,
    /// **自动更新开关**（v1.2.0 新增）。
    ///
    /// 用户口径：「自动更新它应该是一个选项……我打勾之后它才会开始自动更新」。
    /// 所以它是一个**显式的勾选框**，勾上之后：
    ///   · 每次启动时后台查一次 GitHub 上的最新版本；
    ///   · 发现比当前新 → 弹一句"有新版，要下吗"；
    ///   · 用户点了下载 → 在**程序内部**下好、校验、替换掉旧程序，不跳浏览器。
    ///
    /// 默认 **true**（勾上）：功能名就叫"自动更新"，默认不勾等于默认没这功能；
    /// 用户取消勾选后**彻底不检测** —— 不再产生任何网络请求（含启动那次）。
    /// 未勾选时「检查更新」按钮仍然可用（那是一次手动动作，不受开关限制）。
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// GitHub 个人访问令牌（Personal Access Token）。
    ///
    /// 空串 = 匿名请求 —— GitHub REST API 对匿名请求只给 **60 次/小时**，
    /// 一台机器上多开几次设置页、或者跟别的工具共用公网 IP 就会撞限流
    /// （用户报的「检查更新老是失败」就是这么来的）。
    ///
    /// 填了之后所有 GitHub 请求都带 `Authorization: Token <它>`，额度提到
    /// **5000 次/小时**，并且可以直连 API 一次把版本号/说明/下载地址全拿到
    /// （见 `update::check`）。
    ///
    /// ⚠ 这是**凭据**，两条铁律：
    ///   ① 绝不写日志、绝不拼进 URL（`update.rs` 里的日志只记"有没有令牌"）；
    ///   ② 只存本机 config.json —— 它整体是加密信封（见 `save_to`），
    ///      备份/WebDAV 上传的也是加密后的那一份。
    ///
    /// ⚠ 兼容 `用户名:令牌` 这种老格式（用户从别处抄配置时常见，Obtainium
    ///   也专门兼容过）：真正发请求前由 `update::effective_token` 取冒号后的部分。
    #[serde(default)]
    pub github_token: String,
    /// OCR 结果窗口的宽 / 高（逻辑像素）。
    /// 用户拖过窗口大小之后记下来，下次识别就按这个尺寸开 —— 免得每次都要
    /// 重新拉一遍。0 表示「还没记录过」，这时用默认的 760×620。
    ///
    /// ⚠ 这两项**不进** config_view（云端备份/导出）里。窗口大小跟屏幕尺寸绑死，
    /// 4K 台式机上存的 1400×1000 同步到小笔记本上会开出比屏幕还大的窗。
    /// 所以它只在本机 config.json 里持久化，恢复备份时由 apply_view 原样保留。
    pub ocr_win_w: u32,
    pub ocr_win_h: u32,
    /// 本地备份目录。空 = 用默认的数据目录（%APPDATA%/QuickSearch）。
    ///
    /// 用户报过「配置到底备份到哪了都不知道」—— .bak、WebDAV 同步前的
    /// 时间戳快照、导出的 json 全都可以落到这个目录，设置在备份页可见可改。
    #[serde(default)]
    pub backup_dir: String,
    pub last_engine: Option<String>,
    // ---------------- r54：识图搜索 ----------------
    /// 识图搜索总开关。关掉之后横条上的「识图」按钮、设置里的那一栏都不出现。
    ///
    /// 默认 **true**：用户这一批专门要了这个功能，开机就该能用（与 OCR 总开关
    /// 一个口径，但那个是为了"不用的人收干净"，这个是"新功能默认可见"）。
    #[serde(default = "default_true")]
    pub img_enable: bool,
    /// **AI 抠图总开关**（r80）。用户原话：「图标的编辑功能处于可选，在设置通用
    /// 里面打开」。
    ///
    /// 默认 **false**（与 `img_enable` 相反的取舍）：
    ///   · 它需要额外**下载模型**（4.4MB~168MB），不能默认就替用户下；
    ///   · 它依赖 `onnxruntime.dll`（11.8MB，随程序分发）；
    ///   · 不开时图标编辑器走本地颜色解混算法（毫秒级、零依赖），功能不受影响。
    /// 只有用户在设置里主动打开、且选好模型之后才会走 AI。
    #[serde(default)]
    pub ai_matting_enable: bool,
    /// 用户选定的 AI 抠图模型 id（见 `aimodels::MODELS`）。
    ///
    /// 空串 = 还没选过，这时按 `aimodels::default_id()`（推荐项 u2netp）走。
    /// 存 **id** 而不是文件名：换下载源/改名都不影响用户配置。
    #[serde(default)]
    pub ai_matting_model: String,
    /// **模型存放目录**（r80g）。空串 = 用默认目录（`<数据目录>/models`）。
    ///
    /// 用户原话：「下载的模型它位置在哪儿呢？……如果我点击更换模型位置，
    /// 换完位置之后，也得软件自动的把模型都迁移过去」。
    /// 存**绝对路径**：数据目录一变（换机器/改 APPDATA），相对路径就失效了。
    #[serde(default)]
    pub ai_model_dir: String,
    /// 识图**默认引擎**。配了之后截图完成**直接**跳这个引擎，不再让用户选。
    ///
    /// 用户原话：「支持在设置中配置默认引擎，设置后截图完成即直接跳转浏览器
    /// 搜索，无需再次选择」。空串 = 没配过，这时走 `img_engines` 多选名单。
    #[serde(default)]
    pub img_default_engine: String,
    /// 识图**多选名单**：勾几个就同时搜几个，每个结果各开一个新标签页。
    ///
    /// 用户原话：「支持多选引擎，勾选多个引擎后同时进行搜索，且每个引擎结果
    /// 分别在新标签页中打开」。读进来统一过 `imgsearch::normalize_list`。
    ///
    /// 默认值见 `default_img_engines`（必应 + Google Lens，打开页面就自动粘贴）。
    #[serde(default = "default_img_engines")]
    pub img_engines: Vec<String>,
    /// 识图入口要不要加到划词横条上（用户要求「支持将入口添加到划词横条中」）。
    ///
    /// 默认 **true**：横条上 OCR 按钮旁边多一颗「识图」。
    #[serde(default = "default_true")]
    pub img_add_to_bar: bool,
    /// 识图框完的那张图**要不要留在剪贴板里**（r73，用户要求）。
    ///
    /// 默认 **false** = 用完就还：截图只是"借"剪贴板一用，搜完把它撤掉、
    /// 还原用户原来复制的东西（用户点名过「这种只是暂时的图片，不能永久的存在
    /// 电脑里面」）。
    /// 打开之后 = **留着**：搜完还能 Ctrl+V 把刚框的那张图粘到别处
    /// （发群、贴文档）。此时不还原剪贴板 —— 用户原话：「打开之后可以把节选的
    /// 图片保存到剪贴板，关闭后则使用后销毁」。
    #[serde(default)]
    pub img_keep_clip: bool,
    /// `Url` 类引擎（Google Lens / Yandex / TinEye 的"按图片地址搜"）用的
    /// 公网图片地址，由**用户自己填**。留空则那几家不参与搜索（界面会写明）。
    ///
    /// 为什么不自己做图床：本软件不替用户把截图传到第三方 —— 那会静默改变
    /// 隐私边界，用户没同意过。要这条路的人自己填地址，责任与效果都清楚。
    #[serde(default)]
    pub img_public_url: String,

    /* ---------------- r76：AI 识图的「整键延迟」 ---------------- */
    /// AI 识图引擎的按键时序：打开 AI 网址之后，过多久按一次 **Ctrl+V** 把图粘
    /// 进去；再过多**久按 Enter** 发送。两段都可以自己设。
    ///
    /// 用户原话：「这 ai 看图说是通过打开网页后的快捷键来实现一系列的功能，那么
    /// 这快捷键之间的延迟得是可以自定义设置的，比如说打开 ai 网址之后过多少毫秒
    /// 按 control 加 c，过多少毫秒再按 enter。」
    ///
    /// 为什么需要可调：这两段等待以前写死在 main.rs 里（1.2s / 900ms），对
    /// **慢机器 / 冷启动浏览器**不够（键打空了），对快站点又太久（用户干等）。
    /// 各家 AI 站的首屏速度差得很远，没有一串数字能同时讨好所有情况。
    ///
    /// ⚠ 这两段只是"第一发之前的基础等待"，真正的保证在别处：
    ///   发 Ctrl+V 之前会**核对前台真的是浏览器**，不是就重试（最多 30 次 ×
    ///   150ms）；Enter 之前也固定等 900ms 让图先上传完（见 img_paste_into_browser）。
    #[serde(default = "default_ai_paste_delay")]
    pub img_ai_paste_delay: u32,
    #[serde(default = "default_ai_enter_delay")]
    pub img_ai_enter_delay: u32,
    /// AI 识图要不要**排在最前**、并且等它按键完成再开别的识图网址（r76）。
    ///
    /// 用户原话：「如果选中了 ai 看图，那么默认 ai 看图就是最先打开最先完成的，
    /// 软件自己按完快捷键再打开其他的识图网址。」
    ///
    /// 默认 **true**：AI 那一轮先开、先按键，收尾之后才轮到别家。否则几个
    /// 标签页几乎同时往外冒，AI 站的输入框还没建出来，Ctrl+V 就打进了
    /// **刚抢到前台的另一个标签页** —— 那是比"慢一点"严重得多的 bug
    /// （图粘到搜索引擎的搜索框里去了）。
    #[serde(default = "default_true")]
    pub img_ai_first: bool,
    /// 多选引擎时还要不要**自动按键**（r76）。
    ///
    /// 用户原话：「如果同时勾选了多个识图网址，那么软件自己按快捷键的功能就默认
    /// 关闭。」
    ///
    /// 默认 **true**：勾了多家就自动关掉按键。理由同上一条 —— 好几个标签页
    /// 同时打开时前台归属不确定，盲发按键会把图粘到错误的页面。这个开关只是
    /// 让"老用户想恢复旧行为"时有一条路（关掉它 = 任何时候都尝试按键）。
    #[serde(default = "default_true")]
    pub img_ai_auto_off_on_multi: bool,
    // ---------------- r56：更多引擎面板的「最近使用」 ----------------
    /// 最近用过的引擎（最新在最后）。点面板里那颗格子时往里记一笔。
    ///
    /// 用户原话：「通过横条点击更多引擎展现出来的页面，再添加一个最近使用的一栏，
    /// 这一栏就默认显示，它显示在已经陈列出来的所有引擎的最上面，并且标记好是最近
    /// 使用，在设置当中可以选择最多呈现最近使用的 5 个、10 个、15 个或者 20 个。」
    ///
    /// 只存**引擎名**（和 bar_list / custom_engines 一个口径，引擎名就是主键）。
    /// 列表本身会**无限增长**（每点一次记一笔），真正展示时按
    /// `recent_max` 截断 —— 上限见那个字段。清理：列表里出现过、但配置里
    /// 已经没有的引擎（用户删了它）会在读进来时被剔掉，见 `normalize_recent`。
    #[serde(default)]
    pub recent_engines: Vec<String>,
    /// 「最近使用」一栏最多摆几个：5 / 10 / 15 / 20，默认 10。
    ///
    /// 为什么默认 10：再多就把"最近使用"变成"又一张全表"，那它就失去了
    /// "最近"的意义（用户要的是"刚才那几颗在哪"，不是"所有引擎按时间排"）。
    #[serde(default = "default_recent_max")]
    pub recent_max: usize,

    /* ---------------- v1.5.13：界面语言 ---------------- */
    /// 界面语言：`"zh"`（简体中文，默认）/ `"en"`（English）。
    ///
    /// 用户 2026-10-26 的要求：设置里提供简体中文与英文两种，切换后界面文案
    /// 完整替换并**持久化生效**。所以它是一个普通的配置项 —— 跟着备份走，
    /// 换机器恢复之后语言也还在。
    ///
    /// ⚠ 只有这两个值。读进来先过 [`normalize_ui_lang`]，脏值一律落回 `zh`
    ///   （界面找不到字典时退回中文，绝不能变成"满屏英文 key"）。
    #[serde(default = "default_ui_lang")]
    pub ui_lang: String,

    /* ---------------- v1.5.13：启动密码 ---------------- */
    /// 启动密码的 **Argon2id 哈希**（PHC 字符串，形如
    /// `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`）。空串 = **没启用**。
    ///
    /// # 为什么存哈希，并且和备份密码**完全分开**
    ///
    /// 用户明确要求：「启动密码为独立密码，与备份密码互不相同、互不影响」。
    /// 所以它是**另一个字段、另一套校验**，改一个绝不碰另一个：
    ///   · 备份密码（`backup_password`）必须原文留着 —— 它要拿去派生加密密钥；
    ///   · 启动密码只需要"对不对"，没有任何理由留原文，所以只存 Argon2id 哈希。
    ///
    /// 即使 config.json 被整个拿走，哈希也不能反推出密码；而 config.json 本身
    /// 还是 DPAPI + 机器绑定的信封（见 crypto.rs），两层是独立的。
    #[serde(default)]
    pub startup_password_hash: String,
}

/// 默认界面语言：简体中文。
fn default_ui_lang() -> String {
    "zh".to_string()
}

/// 界面语言归一化：只认 `"zh"` / `"en"`，别的一律当 `"zh"`。
///
/// 兼容几种常见写法（`zh-CN`、`en-US`、`ZH`、`English`），因为它们很容易
/// 从系统语言 / 手改配置里混进来。
pub fn normalize_ui_lang(raw: &str) -> String {
    let s = raw.trim().to_ascii_lowercase();
    if s.starts_with("en") || s == "english" {
        "en".to_string()
    } else {
        "zh".to_string()
    }
}

/// `recent_max` 的默认值：10 个。设置页给 5/10/15/20 四档。
fn default_recent_max() -> usize {
    10
}

impl Default for Config {
    fn default() -> Self {
        Self {
            trigger_select: true,
            trigger_copy: true,
            auto_start: false,
            icon_size: 30,
            alpha: 100,
            bar_dim_alpha: 45,
            bar_glass: true,
            // 与 settings.js GLASS_PRESETS 的 standard 档一致（#133 质感重调）——
            // 两边对不上的话，新装机的预设徽标会显示「自定义」而不是「标准」。
            bar_glass_refraction: 30,
            bar_glass_bevel: 18,
            bar_glass_frost: 2,
            bar_glass_aberration: 50,
            bar_glass_spec: 110,
            bar_glass_tint: 14,
            bar_glass_live: false,
            /* 30fps：按**实测**的 6.24ms/次固定开销算，占单核约 18.7%。
             * 够跟手（滚动网页、背后放视频都不滞后），又压在"合理"范围内。
             * 想更跟手可以自己在设置里选「跟随显示器」（代价在设置页写明了：
             * 实测 85fps ≈ 53% 单核）。 */
            bar_glass_fps: 30,
            icon_style: "auto".to_string(),
            unify_icons: true,
            bar_padding: 5,
            item_radius: 9,
            theme: "system".to_string(),
            animations: true,
            shadow: false,
            bar_blur: 0,
            anchor_at_mouse: false,
            bar_pos: default_bar_pos(),
            favorites: Vec::new(),
            fav_hotkey: String::new(),
            backup_password: String::new(),
            fav_panel_sizes: std::collections::BTreeMap::new(),
            auto_elevate: true,
            delay_ms: 0,
            bar_idle_sec: default_bar_idle_sec(),
            bar_away_px: default_bar_away_px(),
            bar_need_text: true,
            filter_mode: "off".to_string(),
            filter_list: Vec::new(),
            ocr_enable: true,
            ocr_key: String::new(),
            ocr_secret: String::new(),
            ocr_lang: "CHN_ENG".to_string(),
            ocr_accurate: false,
            ocr_engine: "baidu".to_string(),
            ocr_parallel: false,
            ocr_multi: Vec::new(),
            ocr_stay_default: true,
            ocr_clean_garbage: false,
            ocr_clean_space: "smart".to_string(),
            ocr_clean_width: false,
            ocr_clean_unwrap: false,
            ocr_keys: HashMap::new(),
            ocr_secrets: HashMap::new(),
            ocr_bases: HashMap::new(),
            ocr_models: HashMap::new(),
            trans_enable: true,
            trans_engine: "siliconflow".to_string(),
            trans_multi: Vec::new(),
            trans_keys: HashMap::new(),
            trans_models: HashMap::new(),
            trans_bases: HashMap::new(),
            trans_secrets: HashMap::new(),
            trans_target: crate::trans::DEFAULT_TARGET.to_string(),
            bar_list: DEFAULT_BAR.iter().map(|s| s.to_string()).collect(),
            sep_style: "line".to_string(),
            custom_engines: Vec::new(),
            apps: Vec::new(),
            overrides: HashMap::new(),
            url_overrides: HashMap::new(),
            ai_suffix: DEFAULT_AI_SUFFIX.to_string(),
            ai_suffixes: HashMap::new(),
            ai_copy_prompt: true,
            webdav_url: String::new(),
            webdav_user: String::new(),
            webdav_pass: String::new(),
            webdav_on_start: false,
            webdav_on_exit: false,
            auto_update: true,
            github_token: String::new(),
            ocr_win_w: 0,
            ocr_win_h: 0,
            backup_dir: String::new(),
            last_engine: None,
            // r54 识图：默认开着、默认勾「框选完直接出结果」的两家、
            // 默认引擎 = Yandex（r70 起；r72 必应/搜狗/360 出册，见 imgsearch.rs）
            img_enable: true,
            /* r80 AI 抠图：默认**关**（见字段上的取舍说明）。
             * 模型选择留空 = 还没选过，运行时会落到 `aimodels::default_id()`。 */
            ai_matting_enable: false,
            ai_matting_model: String::new(),
            ai_model_dir: String::new(),
            img_default_engine: imgsearch::DEFAULT_ENGINE.to_string(),
            img_engines: imgsearch::DEFAULT_ENGINES.iter().map(|s| s.to_string()).collect(),
            img_add_to_bar: true,
            img_keep_clip: false,
            img_public_url: String::new(),
            // r76：AI 识图的按键时序 + AI 优先 + 多家自动关按键
            img_ai_paste_delay: default_ai_paste_delay(),
            img_ai_enter_delay: default_ai_enter_delay(),
            img_ai_first: true,
            img_ai_auto_off_on_multi: true,
            recent_engines: Vec::new(),
            recent_max: default_recent_max(),
            ui_lang: default_ui_lang(),
            startup_password_hash: String::new(),
        }
    }
}

/// OCR 结果窗口的默认尺寸（逻辑像素）。用户没拖过窗口时用它。
pub const OCR_WIN_DEFAULT_W: f64 = 760.0;
pub const OCR_WIN_DEFAULT_H: f64 = 620.0;

/// OCR 窗口允许的尺寸区间。夹一下是为了防止配置被手改成一个荒唐的值
/// （比如 0 或者 100000），那样窗口会小到看不见或大到超出屏幕。
pub const OCR_WIN_MIN_W: f64 = 480.0;
pub const OCR_WIN_MIN_H: f64 = 320.0;
pub const OCR_WIN_MAX_W: f64 = 4000.0;
pub const OCR_WIN_MAX_H: f64 = 3000.0;

/// 把配置里记的 OCR 窗口尺寸换算成可用的 (宽, 高)。
/// 没记录过（0）或者值不合理时，回落到默认尺寸。
pub fn ocr_window_size(cfg: &Config) -> (f64, f64) {
    let w = cfg.ocr_win_w as f64;
    let h = cfg.ocr_win_h as f64;
    let ok = (OCR_WIN_MIN_W..=OCR_WIN_MAX_W).contains(&w)
        && (OCR_WIN_MIN_H..=OCR_WIN_MAX_H).contains(&h);
    if ok {
        (w, h)
    } else {
        (OCR_WIN_DEFAULT_W, OCR_WIN_DEFAULT_H)
    }
}

/* ══════════════════════════════════════════════════════════════════════
 * v1.4.0：便携数据目录
 *
 * 用户要求（原话）：「这个软件的所有数据都要保存在软件所在的文件夹当中，
 *   命名为 Quick search data，所有备份的文件也要备份在这个文件夹里面，
 *   文件夹的名字叫做 quicksearch back」。
 *
 * 默认布局：
 *   `<exe 所在目录>\Quick search data\`   配置 / 图标 / 日志 / AI 模型
 *   `<exe 所在目录>\QuickSearch back\`    所有备份（滚动 + 立即备份 + 快照）
 *
 * `data_dir()` 的三条优先级：
 *   ① `QS_DATA_DIR` 环境变量 —— 测试 / 调试 / 用户想自己指定；
 *   ② 便携目录 —— 能建、能写就用（正常安装走这条）；
 *   ③ `%APPDATA%\QuickSearch` —— exe 落在 Program Files 这类只读位置时兜底。
 *
 * ⚠ 只有"生产 + 没设环境变量"这条分支才缓存（`OnceLock`）。
 *   `QS_DATA_DIR` 是进程级环境变量，测试里每条都改它 —— 缓存了就会串味，
 *   这正是 2026-10-22 那次"测试把用户配置洗成默认值"的同款隐患。
 * ══════════════════════════════════════════════════════════════════════ */

/// 便携数据目录名（exe 旁边）。
pub const DATA_DIR_NAME: &str = "Quick search data";
/// 备份目录名（exe 旁边）。
pub const BACKUP_DIR_NAME: &str = "QuickSearch back";

/// 可执行文件所在目录 —— 便携模式的一切都挂在它下面。
///
/// 取不到（理论上不会）就退回当前工作目录，宁可写错地方也不要 panic：
/// 这个函数在启动最早期就会被调用。
pub fn exe_dir() -> PathBuf {
    static C: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|x| x.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    })
    .clone()
}

/// `<exe>\Quick search data`（不管存不存在）。
pub fn portable_data_dir() -> PathBuf {
    exe_dir().join(DATA_DIR_NAME)
}

/// `<exe>\QuickSearch back`（不管存不存在）。
pub fn portable_backup_dir() -> PathBuf {
    exe_dir().join(BACKUP_DIR_NAME)
}

/// 目录能不能建出来、能不能写 —— 便携模式的准入判据。
///
/// 为什么要真写一个探针文件：`create_dir_all` 成功不代表能写（只读介质、
/// 杀软拦截、组策略只给"列出"权限都会这样）。写一次再删，最可靠。
fn ensure_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".qs-write-probe");
    let ok = std::fs::write(&probe, b"1").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// 测试专用：一个进程级临时目录（**永远不碰真实目录**）。
///
/// 2026-10-22 的事故就是测试写到了真实 `%APPDATA%`。现在测试二进制连
/// "便携目录"这条路都走不到 —— 就算某条测试忘了设 `QS_DATA_DIR`，
/// 也只会在临时目录里乱写。
#[cfg(test)]
fn test_scratch_dir() -> PathBuf {
    static C: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        let p = std::env::temp_dir().join(format!("qs-test-data-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    })
    .clone()
}

pub fn data_dir() -> PathBuf {
    // ① 显式覆盖（测试、调试、以及"我想把数据放别处"的用户）
    if let Ok(d) = std::env::var("QS_DATA_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    // ② 测试二进制绝不落到真实目录
    #[cfg(test)]
    {
        return test_scratch_dir();
    }
    // ③ 生产：便携目录优先，只读位置兜底 %APPDATA%（结果缓存，含探测）
    #[cfg(not(test))]
    {
        static C: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        C.get_or_init(|| {
            let portable = portable_data_dir();
            if ensure_writable(&portable) {
                return portable;
            }
            let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
            let fallback = PathBuf::from(base).join(APP_DIR);
            let _ = std::fs::create_dir_all(&fallback);
            crate::win::log(&format!(
                "config: exe 旁边的数据目录不可写（{}），退回 {}",
                portable.display(),
                fallback.display()
            ));
            fallback
        })
        .clone()
    }
}

pub fn icons_dir() -> PathBuf {
    data_dir().join("icons")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

/* ══════════════════════════════════════════════════════════════════════
 * v1.4.0：老用户迁移（`%APPDATA%\QuickSearch` → exe 旁边的便携目录）
 *
 * 顺序刻意是「**先搬、再校验、最后才删**」：
 *   1. 用老目录自己的钥匙读出老配置（可能是明文，也可能是密码/DPAPI 信封）；
 *   2. 写进新目录（`save_to` 顺手把主文件、备份、`backup.key` 全部换成加密形态）；
 *   3. 图标 / 模型整目录搬过去（同盘 rename 是瞬时的）；
 *   4. 老备份**逐个重新封装**后放进 `QuickSearch back`（明文备份不能原样搬）；
 *   5. 回读新配置，和搬之前那份逐字节比一次；
 *   6. 只有 5 通过了，才删老目录 —— 用户要求「迁移成功后删掉整个旧目录」，
 *      但这条必须以"新目录真的能用"为前提，否则等于删库。
 *
 * ⚠ `log.txt` **不搬**：里面记着用户划过的文字（老版本没脱敏），
 *   搬过去就等于把明文用户数据带进了新目录。日志是诊断材料，不搬。
 * ══════════════════════════════════════════════════════════════════════ */

/// 从某个 `backup.key` 文件里读出备份密码（兼容 DPAPI 信封与老式明文）。
fn read_password_file(p: &std::path::Path) -> String {
    let Ok(s) = std::fs::read_to_string(p) else {
        return String::new();
    };
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    if crate::crypto::looks_dpapi(s) {
        return crate::crypto::decrypt_dpapi(s)
            .map(|t| t.trim().to_string())
            .unwrap_or_default();
    }
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        return t.to_string();
    }
    String::new()
}

/// 目录递归复制（跨盘迁移时用；同盘优先走 rename）。
fn copy_dir_all(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let src = e.path();
        let dst = to.join(e.file_name());
        if src.is_dir() {
            copy_dir_all(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// 把一个目录搬到新位置：同盘 rename（瞬时、原子）；跨盘或目标已存在就逐文件复制。
fn move_dir(from: &std::path::Path, to: &std::path::Path) -> bool {
    if !from.is_dir() {
        return true;
    }
    if !to.exists() && std::fs::rename(from, to).is_ok() {
        return true;
    }
    copy_dir_all(from, to).is_ok()
}

/// 判断老目录里的一个文件是不是"配置/备份"（要搬走并重新封装的那些）。
fn is_config_family(name: &str) -> bool {
    name == "config.json"
        || name.starts_with("config(")
        || name.starts_with("config.auto(")
        || name.starts_with("config.before-")
        || name.starts_with("config.broken")
        || name.starts_with("config.wiped")
        || name.starts_with("config.json.bad-")
}

/// 老版本数据目录（`%APPDATA%\QuickSearch`）。
fn legacy_data_dir() -> Option<PathBuf> {
    let base = std::env::var("APPDATA").ok()?;
    let p = PathBuf::from(base).join(APP_DIR);
    p.is_dir().then_some(p)
}

/// 需要迁移就迁移。返回一句人话（进日志 / 托盘提示），没事可做返回 None。
///
/// 幂等：进程内只真跑一次（`OnceLock`），外部条件不满足就直接返回。
pub fn migrate_legacy_if_needed() -> Option<String> {
    static DONE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    DONE.get_or_init(migrate_legacy_inner).clone()
}

fn migrate_legacy_inner() -> Option<String> {
    // 测试、以及用户显式指定了数据目录 —— 都不碰真实目录
    if cfg!(test) {
        return None;
    }
    if std::env::var("QS_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return None;
    }
    let new_dir = data_dir();
    let old_dir = legacy_data_dir()?;
    if old_dir == new_dir {
        return None;
    }
    // 新目录已经有配置 = 已经迁移过（或本来就是便携安装）→ 不动老目录
    if config_path().exists() {
        return None;
    }
    let old_cfg_path = old_dir.join("config.json");
    if !old_cfg_path.exists() {
        return None;
    }

    /* ⚠ 先把日志开关搬过去，**再**打第一条日志。
     *
     * `win::log` 的开关是进程级 `OnceLock`（`log_on`），第一次判断时如果新目录
     * 里还没有 `log.on`，整个进程的日志就永久关闭 —— 迁移这种"一辈子一次、
     * 出事必须能查"的操作，不能连一行记录都留不下来（第一次实测就踩了）。 */
    let _ = std::fs::create_dir_all(&new_dir);
    if old_dir.join("log.on").exists() {
        let _ = std::fs::copy(old_dir.join("log.on"), new_dir.join("log.on"));
    }
    crate::win::log(&format!(
        "migrate: 开始从 {} 迁移到 {}",
        old_dir.display(),
        new_dir.display()
    ));    // ① 用老目录自己的钥匙读老配置
    let old_pw = read_password_file(&old_dir.join("backup.key"));
    let Ok(text) = std::fs::read_to_string(&old_cfg_path) else {
        crate::win::log("migrate: 老配置读不出来，放弃迁移（老数据原样保留）");
        return None;
    };
    let plain = match crate::crypto::unseal(&text, &old_pw) {
        Ok(p) => p,
        Err(e) => {
            crate::win::log(&format!(
                "migrate: 老配置解不开（{e}）—— 放弃迁移，老数据原样保留"
            ));
            return None;
        }
    };
    let Ok(cfg) = serde_json::from_str::<Config>(&plain) else {
        crate::win::log("migrate: 老配置不是有效 JSON —— 放弃迁移");
        return None;
    };
    /* 期望值用 `sanitize(cfg)`：`load_from` 读回来会过一遍 sanitize，
     * 而这里是从老文件直接解析的（没过）。老版本留下的"该被剪掉的值"
     * （比如百度不认的 `ocr_lang = CHN`）会让两边天然不一致 —— 拿 sanitize
     * 之后的形态当基准，校验才既严格又不会误判。
     *
     * ⚠ 用 Value 比（键顺序无关）：Config 里的 HashMap 每次序列化顺序都不一样 */
    let want = serde_json::to_value(sanitize(cfg.clone())).unwrap_or_default();

    // ② 写进新目录（save_to 会把主文件、滚动备份、backup.key 全换成加密形态）
    if !ensure_writable(&new_dir) {
        crate::win::log("migrate: 新数据目录不可写 —— 放弃迁移");
        return None;
    }
    save_to(&config_path(), &cfg);
    // ③ 图标 / 模型整目录搬过去
    let _ = move_dir(&old_dir.join("icons"), &icons_dir());
    let _ = move_dir(&old_dir.join("models"), &new_dir.join("models"));
    // ④ 老备份逐个重新封装进备份目录（明文备份不能原样搬）
    let bdir = default_backup_dir();
    let mut moved = 0usize;
    let mut kept = 0usize;
    if let Ok(rd) = std::fs::read_dir(&old_dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let Some(name) = p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
                continue;
            };
            if !p.is_file() || !is_config_family(&name) || name == "config.json" {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&p) else {
                kept += 1;
                continue;
            };
            // 已经是密文的原样搬；明文的先封再搬（用老密码，保证搬过去还能解）
            let body = if crate::crypto::looks_encrypted(&raw) {
                raw
            } else {
                match crate::crypto::seal(&raw, &old_pw) {
                    Ok(t) => t,
                    Err(_) => {
                        kept += 1;
                        continue;
                    }
                }
            };
            let dst = bdir.join(&name);
            if std::fs::write(&dst, body.as_bytes()).is_ok() {
                moved += 1;
            } else {
                kept += 1;
            }
        }
    }
    // log.on（空标记文件，不含数据）也搬；log.txt 刻意不搬
    let _ = std::fs::copy(old_dir.join("log.on"), new_dir.join("log.on"));

    // ⑤ 回读校验：新目录里那份必须和搬之前**完全一致**（按 JSON 值比，与键序无关）
    let back = load_from(&config_path());
    let got = serde_json::to_value(&back).unwrap_or_default();
    if got != want {
        /* 不一致就**保留老目录**，一份东西都不删。
         * 诊断只打"哪个字段不一样 + 两边长度" —— 不打值（那是用户数据）。 */
        let a: serde_json::Value = want.clone();
        let b: serde_json::Value = got.clone();
        let mut diff: Vec<String> = Vec::new();
        if let (Some(oa), Some(ob)) = (a.as_object(), b.as_object()) {
            for (k, va) in oa {
                match ob.get(k) {
                    Some(vb) if vb == va => {}
                    Some(vb) => diff.push(format!(
                        "{k}({}→{}字)",
                        serde_json::to_string(va).map(|s| s.len()).unwrap_or(0),
                        serde_json::to_string(vb).map(|s| s.len()).unwrap_or(0)
                    )),
                    None => diff.push(format!("{k}(没了)")),
                }
            }
            for k in ob.keys() {
                if !oa.contains_key(k) {
                    diff.push(format!("{k}(多了)"));
                }
            }
        }
        crate::win::log(&format!(
            "migrate: 回读校验不一致 —— 保留老目录，不删任何东西。差异字段：{}",
            diff.join("、")
        ));
        return Some(format!(
            "数据迁移校验没通过（差异字段：{}），旧目录已保留",
            diff.join("、")
        ));
    }

    // ⑥ 删老目录（含明文 config.json / 明文备份 / 旧日志）
    let removed = std::fs::remove_dir_all(&old_dir).is_ok();
    crate::win::log(&format!(
        "migrate: 完成 —— 备份搬了 {moved} 份、跳过 {kept} 份；旧目录{}",
        if removed { "已删除" } else { "删除失败（可手工删）" }
    ));
    Some(format!(
        "数据已迁到 exe 旁边的「{}」，备份在「{}」（搬了 {moved} 份备份）",
        DATA_DIR_NAME, BACKUP_DIR_NAME
    ))
}

/* ══════════════════════════════════════════════════════════════════════
 * r92：备份密码的**独立存档**（让"配置坏了还能解开备份"成为可能）
 *
 * ## 为什么必须独立存
 *
 * 加密备份的价值全在"主文件坏了还能救回来"。但密码原本**只存在
 * config.json 里** —— 主文件一坏、密码字段跟着没了，那份加密备份就
 * 永远解不开了。这是自相矛盾的：**保护数据的机制，反而让数据不可恢复**。
 *
 * 用户的真实遭遇就是这条：config.json 截断 → 密码读不出 →
 * 100 多份加密备份全部作废 → 落回默认配置。
 *
 * ## 做法
 *
 * 把密码另存一份到 `backup.key`（和 config.json 同目录、同样受
 * `%APPDATA%` 的文件系统权限保护）。它不是明文散落在各处 ——
 * 只是把"同一个秘密"多存一份，位置和 config.json 一样私密。
 *
 * ⚠ 安全性权衡（说清楚，别让人误以为这是加固）：
 *   这**不降低**也比不上"不存密码"的安全性 —— 能读 `%APPDATA%` 的程序
 *   本来就能读 config.json 里的密码。它换来的是**可恢复性**，
 *   代价是零（多一个小文件）。真正的威胁模型（同机恶意程序）两者一样。
 * ══════════════════════════════════════════════════════════════════════ */

/// 备份密码的独立存档路径。
pub fn backup_key_path() -> PathBuf {
    data_dir().join("backup.key")
}

/// 把备份密码写进独立存档（空密码 = 删掉存档）。
///
/// ⚠ v1.4.0：**存档本身也必须加密**。用户要求「所有本地数据都要加密，不能
///   以任何明文方式显示用户数据」—— 密码是最敏感的那一项，明文躺在
///   `backup.key` 里等于前功尽弃。
///
/// 用什么加密：DPAPI（跟着当前 Windows 用户走、不需要密码）。这里是唯一
/// 必须"无钥匙自解"的地方 —— 它是钥匙的钥匙，不能自己问自己要密码。
pub fn stash_backup_password(pw: &str) {
    let p = backup_key_path();
    let pw = pw.trim();
    if pw.is_empty() {
        let _ = std::fs::remove_file(&p);
        return;
    }
    let Ok(body) = crate::crypto::encrypt_dpapi(pw) else {
        crate::win::log("config: 备份密码存档加密失败（DPAPI 不可用）—— 不写明文");
        return;
    };
    if std::fs::write(&p, body).is_err() {
        crate::win::log("config: 备份密码独立存档写入失败（不影响主流程）");
    }
}

/// 从独立存档里读备份密码（读不到返回空串）。
///
/// 兼容三种形态：
///   · v1.4.0 起的 DPAPI 信封（正常路径）；
///   · 老版本的明文存档（`# 注释` + 一行密码）—— 读出来之后调用方会立刻
///     用 `stash_backup_password` 重写成加密的（见 `migrate_legacy_if_needed`）；
///   · 文件不存在 / 解不开 → 空串（调用方按"没有密码"处理）。
pub fn load_backup_password() -> String {
    let Ok(s) = std::fs::read_to_string(backup_key_path()) else {
        return String::new();
    };
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    if crate::crypto::looks_dpapi(s) {
        return match crate::crypto::decrypt_dpapi(s) {
            Ok(pw) => pw.trim().to_string(),
            Err(e) => {
                crate::win::log(&format!(
                    "config: backup.key 解不开（{e}）—— 换过 Windows 用户/机器？"
                ));
                String::new()
            }
        };
    }
    // 老格式：跳过以 # 开头的注释行，取第一行非空内容
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        return t.to_string();
    }
    String::new()
}

/// 备份文件名里的「详细时间」：本地时间 `YYYY-MM-DD HH-MM-SS`。
///
/// 用户要求备份文件名形如「文件名(详细时间).QuickSearch」—— 时间必须是本地
/// 时间（备份是给人看的，UTC 时间用户对不上自己几点做的备份）。Windows 文件名
/// 不能含 `:`，时分秒之间用连字符。走 WinRT Calendar（已在依赖里）取本地时间；
/// 取不到就退回 UNIX 秒，绝不让备份因为拿不到时间而失败。
pub fn backup_stamp() -> String {
    #[cfg(windows)]
    {
        use windows::Globalization::Calendar;
        if let Ok(cal) = Calendar::new() {
            let _ = cal.SetToNow();
            let (y, mo, d) = (cal.Year(), cal.Month(), cal.Day());
            let (h, mi, s) = (cal.Hour(), cal.Minute(), cal.Second());
            if let (Ok(y), Ok(mo), Ok(d), Ok(h), Ok(mi), Ok(s)) = (y, mo, d, h, mi, s) {
                return format!(
                    "{:04}-{:02}-{:02} {:02}-{:02}-{:02}",
                    y, mo, d, h, mi, s
                );
            }
        }
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|t| t.as_secs())
        .unwrap_or(0);
    format!("unix-{secs}")
}

/// 「立即备份」的文件名 —— 本地落盘与云端上传**完全同名**。
///
/// 用户原话：「本地备份的文件名是 config(2026-10-12 23-06-22).QuickSearch，
/// 而备份到云端的文件名是 quicksearch-backup.json，这完全对不上……备份到云端的
/// 文件名完全没有必要自定义，直接把本地的拉上去就可以了呀」。
///
/// 所以现在**只有这一个命名口径**：本地写什么名字，云端就 PUT 什么名字，
/// 内容也是同一份字节（见 `backup_once`）。以前那套「基名 + 时间戳 + .json」
/// 的云端自定义名连同设置项一起删掉了。
pub fn backup_name(stamp: &str) -> String {
    format!("config({stamp}).QuickSearch")
}

/// 滚动备份（每次改设置自动留的那份，只保留 1 份）。
///
/// ⚠ 必须跟 `backup_name` **区分开**：`save_to` 每次保存都会把同目录里旧的
/// 滚动备份删掉，如果两者同名，用户手动做的备份会被下一次改设置顺手删光。
/// 多一层 `.auto` 前缀，两族文件互不干扰。
pub fn rolling_backup_name(stamp: &str) -> String {
    format!("config.auto({stamp}).QuickSearch")
}

/// 默认备份目录：exe 旁边的 `QuickSearch back`（v1.4.0 起）。
///
/// 用户要求：「所有备份的文件也要备份在这个文件夹里面」。建不出来（只读位置）
/// 就退回数据目录 —— 备份绝不能因为"目录不可写"而整个失败。
pub fn default_backup_dir() -> PathBuf {
    #[cfg(test)]
    {
        // 测试里绝不往 exe 旁边写（理由见 `test_scratch_dir`）
        return data_dir();
    }
    #[cfg(not(test))]
    {
        static C: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        C.get_or_init(|| {
            let p = portable_backup_dir();
            if ensure_writable(&p) {
                p
            } else {
                crate::win::log(&format!(
                    "config: 备份目录 {} 不可写，退回数据目录",
                    p.display()
                ));
                data_dir()
            }
        })
        .clone()
    }
}

/// 本地备份目录：用户在设置里指定的；没指定（或指定的不可用）就用默认备份目录。
/// 滚动备份、立即备份、WebDAV 同步前的时间戳快照、导出文件都落在这里。
pub fn backup_dir_of(cfg: &Config) -> PathBuf {
    let d = cfg.backup_dir.trim();
    if d.is_empty() {
        return default_backup_dir();
    }
    let p = PathBuf::from(d);
    // 目录不存在就试着建；建不出来（盘没了/权限）就退回默认目录，
    // 备份这件事绝不能因为"用户填了个怪路径"而整个失败。
    if std::fs::create_dir_all(&p).is_ok() && p.is_dir() {
        p
    } else {
        crate::win::log(&format!(
            "config: 备份目录 {:?} 不可用，回退到默认备份目录",
            p
        ));
        default_backup_dir()
    }
}

pub fn ensure_dirs() {
    let _ = std::fs::create_dir_all(icons_dir());
}

/// 读配置。
///
/// ⚠ 这里以前是 `unwrap_or_default()` —— **JSON 只要有一点解析不了，就整个
/// 静默换成默认配置**。用户重启电脑后看到「设置全没了、横条回到出厂」，
/// 最常见的原因就是它：写文件的过程中断电/被杀/杀软锁文件，留下半截 JSON，
/// 下次启动就静默归零，而且**连一句提示都没有**，用户根本不知道发生了什么。
///
/// 现在的行为：
///   * 主文件坏了 → 试着读 `config.json.bak`（上一份好配置）；
///   * 备份也没有 → 才用默认值，但会把坏文件另存为 `config.json.bad-<n>`，
///     同时写日志。用户至少还能手工捞回一部分内容，而不是"什么都没了"。
pub fn load() -> Config {
    let p = config_path();
    let c = load_from(&p);
    // 走到这里说明主文件**坏了**。必须把恢复出来的配置立刻写回去，
    // 否则磁盘上那份坏文件会一直躺着 —— 用户看到的仍然是「配置没回来」，
    // 而且下一次启动还要再走一遍同样的兜底。
    //
    // 什么时候才算坏：磁盘上的正式文件此刻**用不了**（读不出 / 解不开 / 不是配置）。
    // ⚠ v1.4.0：主文件是密文，"解析不出来"不再等于"坏了" —— 必须真的能解出
    //   一份配置才算可用，见 `main_file_usable`。
    if !main_file_usable(&p) && !is_locked() {
        crate::win::log("config: 磁盘上的配置不可用，已按恢复结果重建 config.json");
        save_to(&p, &c);
    }
    c
}

/// 主文件此刻是不是"能用"：存在 + 能解 + 能解析成配置。
///
/// 注意 `is_locked()` 单独判断：解不开的时候 `main_file_usable` 也是 false，
/// 但那种情况**绝不能**重建（会把完好的密文覆盖成默认配置）。
fn main_file_usable(path: &std::path::Path) -> bool {
    let Ok(s) = std::fs::read_to_string(path) else {
        return false;
    };
    match crate::crypto::unseal(&s, &load_backup_password()) {
        Ok(plain) => serde_json::from_str::<Config>(&plain).is_ok(),
        Err(_) => false,
    }
}

/// `load` 的可注入版本（测试专用）。
///
/// 生产路径永远用 `load()`。之所以把「读哪个文件」抽成参数，是为了能在
/// 单元测试里模拟真实事故场景 —— 把一份坏掉的 config.json 摆好，验证重启后
/// 用户配置**真的还在**，而不是静默变成默认值。这个性质没法靠读代码确认。
pub fn load_from(path: &std::path::Path) -> Config {
    ensure_dirs();
    let pw = load_backup_password();
    let parsed = match std::fs::read_to_string(path) {
        Ok(s) => {
            /* ⚠⚠ v1.4.0：**先判信封，再解析**。
             *
             * 顺序反了就是 r92 那个事故的翻版：`Config` 整份带
             * `#[serde(default)]`，密文信封也会"解析成功"但内容全默认。
             * 明文（老版本 / 迁移前的文件）原样放行。 */
            let plain = match crate::crypto::envelope_version(&s) {
                Some(v) => match crate::crypto::unseal(&s, &pw) {
                    Ok(p) => Some(p),
                    Err(e) => {
                        /* 解不开有两种：钥匙没了（换机/换用户）或者文件坏了。
                         * 两种都**绝不能覆盖**原文件 —— 见 LOCKED 的注释。 */
                        crate::win::log(&format!(
                            "config: config.json 是加密的（信封 v{v}）但解不开：{e}"
                        ));
                        LOCKED.store(true, Ordering::SeqCst);
                        None
                    }
                },
                None => Some(s.clone()),
            };
            match plain {
                Some(p) => match serde_json::from_str::<Config>(&p) {
                    Ok(c) => Some(c),
                    Err(e) => {
                        crate::win::log(&format!("config: config.json 解析失败（{e}），尝试读备份"));
                        preserve_broken(path, &s);
                        match load_backup_of(path) {
                            Some(c) => Some(c),
                            None => {
                                crate::win::log("config: 备份也没有，用默认配置启动（坏文件已留档）");
                                None
                            }
                        }
                    }
                },
                // 解不开：留档可以（密文留档仍是密文），但绝不当作"配置已恢复"
                None => {
                    preserve_broken(path, &s);
                    match load_backup_of(path) {
                        Some(c) => {
                            crate::win::log("config: 主文件解不开，但备份能用 —— 本次按备份启动");
                            Some(c)
                        }
                        None => None,
                    }
                }
            }
        }
        // 文件压根不存在 = 第一次运行，不是错误
        Err(_) => None,
    };
    // 读到几处值都要做一次归一，不只是从备份恢复的那条。
    //
    // 旧版本设置页给过一个「纯中文 = CHN」，而百度**没有**这个枚举值。
    // 只在 `apply_view`（恢复云端备份那条路）里归一是不够的：本地 config.json
    // 同样可能存着 CHN，于是设置页两个语言按钮一个都不亮 —— 用户看着像设置丢了，
    // 而识别请求又一直返回参数错误。两头都对不上。
    //
    // r91：sanitize 之后**有修改就写回磁盘**。
    //
    // 为什么以前不写也"没出事"：剪掉的东西只影响内存视图，下次启动还会再剪
    // 一遍 —— 功能上无感。但有两个真实的代价：
    //   1. 用户手动看 config.json 时，幽灵条目还躺在里面（他刚在界面上
    //      确认过"已经没有了"，文件里却在 —— 像没修干净）；
    //   2. 每次启动都要重跑一遍剪除（枚举内置引擎 + 建HashSet，纯浪费）。
    //
    // 判据用「序列化结果是否一致」：sanitize 改的字段不止 bar_list 一个
    // （语言归一 / OCR 名单 / WebDAV 地址…），逐个 diff 太碎；整个 JSON
    // 对比一次最省心，且只在启动时跑一次（几 KB 的序列化，微秒级）。
    /* ⚠ 判据必须用 `serde_json::Value` 比，**不能**比 `to_string` 的结果：
     * `Config` 里有好几个 `HashMap`（overrides / fav_panel_sizes / ocr_keys…），
     * 每次序列化的键顺序是随机的 —— 同一份配置两次 to_string 出来的文本
     * 就可能不一样。v1.4.0 第一版迁移校验就是被这个坑到："差异字段"一个都没有，
     * 但字符串不相等，于是迁移永远判失败。 */
    let before = parsed
        .as_ref()
        .map(|c| serde_json::to_value(c).unwrap_or_default());
    let raw = parsed.map(sanitize).unwrap_or_default();
    if let (Some(before), true) = (&before, path.exists()) {
        let after = serde_json::to_value(&raw).unwrap_or_default();
        if before != &after {
            /* ⚠ r99：这里必须写回**刚读的那个 path**，不能写 `save()`。
             *
             * `save()` 写的是全局 `config_path()`（真实 `%APPDATA%`）。而
             * `load_from` 是可注入版本 —— 测试传的是临时文件。原来这一行是
             * `save(&raw)`，于是**任何测试只要触发一次"启动归一有修改"，
             * 就会把测试用的那份配置写进用户真实的数据目录**。
             *
             * 真实事故（2026-10-22）：`cargo test` 跑完，用户的
             * `config.json` 变成了一份 `delay_ms = 4321` 的测试配置 ——
             * 自定义引擎、收藏夹、图标、OCR/WebDAV 密钥全没了，而且因为
             * `backup_password` 跟着变成空串，启动时 `stash_backup_password("")`
             * 还把 `backup.key`（解开加密备份的唯一钥匙）删掉了。
             * 写回自己的 path，这条污染链就断了。 */
            save_to(path, &raw);
            crate::win::log("config: 启动归一有修改，已写回磁盘");
        }
    }
    raw
}

// （下面的 sanitize 系列：把配置里那些「历史上写进去过、现在不该再出现的值」归一。）
/* ==================================================================== */
/* 收藏夹                                                                */
/* ==================================================================== */

/// 收藏夹里的一条内容（文字或图片，都带备注）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FavItem {
    pub id: String,
    /// `"text"` 或 `"image"`
    #[serde(default = "default_fav_kind")]
    pub kind: String,
    /// kind = text 时的内容
    #[serde(default)]
    pub text: String,
    /// kind = text 时带格式的内容（**已白名单 sanitize 的 HTML 子集**：
    /// 只允许 span/div/p/b/i/u/… 与 color / font-weight / font-style /
    /// text-decoration 等几个 style 属性）。空 = 纯文本（老数据、或用户
    /// 没粘过带格式的内容）。显示与复制都以它为准，text 是它的纯文本影子，
    /// 供预览/搜索等不需要格式的场合用。
    ///
    /// 为什么要存 HTML：用户从网页 / Word 复制的文字是带颜色的（红字标题、
    /// 高亮批注…），早先只存纯文本，颜色全丢 —— 报过「收藏夹文本框的文字
    /// 颜色要跟着文本的格式走」。 sanitize 在前端粘贴时做（shared.js
    /// qsSanitizeRichText），后端不信任任何来源的这段 HTML。
    #[serde(default)]
    pub html: String,
    /// kind = image 时的 dataURL（导入时已压过，控制配置体积）
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub remark: String,
}

fn default_fav_kind() -> String {
    "text".to_string()
}

/// 老配置里没有 `bar_dim_alpha` 这个键时的默认待机透明度。45% 已经能明显
/// 「让开」背后的内容，又不至于看不清横条上的图标。
fn default_dim_alpha() -> u32 {
    45
}

/// 新增的布尔开关默认值（老配置里没有这个键时取 `true`）。
/// 目前只有 `ocr_stay_default` / `img_enable` / `img_add_to_bar` / `bar_need_text` 用它。
fn default_true() -> bool {
    true
}

/// 横条无操作自动收起的默认秒数（5 秒 —— 用户指定的那个数）。
fn default_bar_idle_sec() -> u32 {
    5
}

/// 鼠标离开多远自动收起的默认像素（400 —— 大约是 1080p 屏宽的 1/5，够区分
/// "顺手挪一下"和"人已经去干别的了"）。
fn default_bar_away_px() -> i32 {
    400
}

/// 横条首选弹出方向的默认值：文字**上方**。
///
/// 沿袭 v1.5.3 及以前的行为（`layout_bar` 里"上方优先、放不下翻下方"），
/// 老配置里没有这个键、或手改成乱七八糟的值时，都回到这一个。
fn default_bar_pos() -> String {
    "above".to_string()
}

/// 弹出方向的白名单归一：只认 `above` / `below`，别的（含空串）一律回默认。
///
/// 一条入口给两处用：`sanitize`（读配置/恢复备份时）和 main.rs 的
/// `apply_one_setting`（设置页点选时）—— 两边口径一致，才不会出现
/// "界面选了下、存进去的却是别的"。
pub fn normalize_bar_pos(s: &str) -> String {
    match s {
        "below" => "below".to_string(),
        _ => default_bar_pos(),
    }
}

/// 识图多选名单的默认值：两家**框选完直接出结果**的真上传引擎
/// （r70 起 = Yandex + SauceNAO，实测通过；百度当前上传被反爬拒绝，退出默认）。
///
/// 历史：r55「必应 + ascii2d」→ r57「必应 + Lens」（POST 路死了之后的次优解）
/// → r61「百度 + Yandex」（改成真上传）→ r70「Yandex + SauceNAO」
/// （百度复测固定 Reject）。每一轮都跟着实测走，理由见 imgsearch.rs 模块注释。
///
/// ⚠ 为什么不能只写 `#[serde(default)]`：那样 serde 会用 `Vec::default()`
///   （**空数组**）而不是这里的名单。空名单对老配置有两处别扭：
///   ① 设置页「要搜哪些引擎」一格勾选都不亮，用户以为功能是坏的；
///   ② 虽然 `img_plan` 有"名单空就退回 DEFAULT_ENGINES"的兜底（识图照旧能
///      用），但界面和实际行为不一致，比直接给默认值更难懂。
///   所以这里显式给默认值 —— 老配置升级上来也是这两家，与新装机一致。
fn default_img_engines() -> Vec<String> {
    imgsearch::DEFAULT_ENGINES.iter().map(|s| s.to_string()).collect()
}

/// `app_launch_delay` 的默认值：900ms。
///
/// 这个数字不是拍脑袋 —— 见 `CustomEngine::app_launch_delay` 的注释：r60 就是
/// 为了修「应用确实开了，但快捷键没触发」而加的一拍等待，那一拍原本写死在
/// main.rs 里（`let settle = Duration::from_millis(900)`），r76 把它提成可配置。
pub fn default_app_launch_delay() -> u32 {
    900
}

/// AI 识图：打开网址后等多久发第一发 Ctrl+V（默认 1200ms）。
fn default_ai_paste_delay() -> u32 {
    1200
}

/// AI 识图：Ctrl+V 之后等多久发 Enter（默认 900ms）。
///
/// 900ms 是让图先上传/转成缩略图、发送按钮从禁用变可点 —— 太早回车等于发了
/// 个空消息（有的站直接忽略，看起来像没反应）。
fn default_ai_enter_delay() -> u32 {
    900
}

/// 收藏夹的一个分组。一级目录和二级目录**共用**这个结构：
/// 一级可以同时有 items（直接收藏的内容）和 children（二级目录）；
/// 二级只会有 items（children 被忽略 —— 用户要求最多两级）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct FavGroup {
    pub id: String,
    pub name: String,
    /// 放进横条时的图标（dataURL）。空 = 用默认的 ★ 徽标
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub items: Vec<FavItem>,
    /// 二级目录
    #[serde(default)]
    pub children: Vec<FavGroup>,
}

/// 横条上收藏夹按钮的哨兵名：`@fav:<groupId>`。
pub const FAV_PREFIX: &str = "@fav:";

pub fn is_fav_sentinel(name: &str) -> bool {
    name.starts_with(FAV_PREFIX)
}

/// 收藏树里所有目录的 id（一级 + 二级）。
pub fn fav_group_ids(groups: &[FavGroup]) -> std::collections::HashSet<String> {
    fn walk(g: &FavGroup, out: &mut std::collections::HashSet<String>) {
        out.insert(g.id.clone());
        for c in &g.children {
            walk(c, out);
        }
    }
    let mut out = std::collections::HashSet::new();
    for g in groups {
        walk(g, &mut out);
    }
    out
}

/// 剪掉 `bar_list` 里指向**已经不存在的目录**的 `@fav:<id>` 哨兵。返回剪掉几个。
///
/// 用户报过：把某个目录放进横条，然后把那个目录删掉 —— 横条上那一格不但没收起，
/// 还显示成一串看不懂的 id。原因是删目录只改 `favorites`，`bar_list` 里那根哨兵
/// 谁也不管：`ui/bar.js` 渲染时会把它过滤掉（所以横条本体看着还正常），
/// 但**设置页「横条上的引擎」列表是直接照 bar_list 渲染的**，于是把哨兵原文
/// 当成引擎名显示出来（用户看到的就是"乱码"）。
///
/// 做成**单点清理**：任何改到收藏树的路径（设置页删除、载入备份、从云端恢复、
/// 导入配置）最后都会经过 `set_setting("favorites")` 或 `sanitize()`，两边都调它，
/// 就不会再有第二条漏网的路径。
pub fn prune_dangling_fav_sentinels(cfg: &mut Config) -> usize {
    let ids = fav_group_ids(&cfg.favorites);
    let before = cfg.bar_list.len();
    cfg.bar_list.retain(|n| {
        if !is_fav_sentinel(n) {
            return true;
        }
        ids.contains(&n[FAV_PREFIX.len()..])
    });
    // 顺手把「按目录记住的面板尺寸」里指向已删目录的键也清掉 —— 目录没了，
    // 那份尺寸永远不会再被读到，留着只是配置里的垃圾（也是"这个收藏夹的
    // 残留信息"）。`_root` 那个键不属于任何目录，保留。
    cfg.fav_panel_sizes.retain(|k, _| {
        if !is_fav_sentinel(k) {
            return true;
        }
        ids.contains(&k[FAV_PREFIX.len()..])
    });
    before - cfg.bar_list.len()
}

/// 在收藏树里按 id 找一条内容（一级和二级都会翻）。
pub fn find_fav_item<'a>(groups: &'a [FavGroup], id: &str) -> Option<&'a FavItem> {
    for g in groups {
        if let Some(it) = g.items.iter().find(|i| i.id == id) {
            return Some(it);
        }
        if let Some(it) = find_fav_item(&g.children, id) {
            return Some(it);
        }
    }
    None
}

pub(crate) fn sanitize(mut c: Config) -> Config {
    // 界面语言：只认 zh / en（见 normalize_ui_lang）。脏值落回中文而不是报错 ——
    // 语言只是一个显示偏好，不该让整个配置读不进来。
    let lang = normalize_ui_lang(&c.ui_lang);
    if c.ui_lang != lang {
        crate::win::log(&format!("config: 界面语言 {:?} 不认识，归一为 zh", c.ui_lang));
        c.ui_lang = lang;
    }
    let want = crate::ocr::normalize_lang(&c.ocr_lang);
    if c.ocr_lang != want {
        crate::win::log(&format!(
            "config: 识别语言 {:?} 不是百度的合法值，归一为 {:?}",
            c.ocr_lang, want
        ));
        c.ocr_lang = want.to_string();
    }
    // 识别引擎只认注册表里登记过的 id（baidu / windows / tencent / …），
    // 其它一概退回百度（最稳的默认）。
    // ⚠ 别再写死 `!= "baidu" && != "windows"`：需求 2 之后引擎有十几家，
    //   写死的白名单会把用户新配的引擎在下次读配置时"归一"掉 ——
    //   表现是"设了腾讯云，重启又变回百度"。
    if crate::ocr_engines::find(&c.ocr_engine).is_none() {
        crate::win::log(&format!(
            "config: 识别引擎 {:?} 不认识，归一为 baidu",
            c.ocr_engine
        ));
        c.ocr_engine = "baidu".to_string();
    }
    // OCR 文本整理的空格档位只认三个值，其它一律回到 smart（老版本的行为）。
    if !matches!(c.ocr_clean_space.as_str(), "off" | "smart" | "force") {
        crate::win::log(&format!(
            "config: 文本整理空格档位 {:?} 不认识，归一为 smart",
            c.ocr_clean_space
        ));
        c.ocr_clean_space = "smart".to_string();
    }
    /* ---- v1.5.16：翻译（多引擎，口径同 OCR 那两段） ----
     *
     * 目标语言只认 `trans::LANGS` 里的代码。脏值（手改配置、老版本留的空串）
     * 一律归一成简体中文 —— 界面上「翻译成中文」是默认，绝不能变成一个空下拉。 */
    let want_target = crate::trans::normalize_lang(&c.trans_target);
    if want_target != c.trans_target {
        crate::win::log(&format!(
            "config: 翻译目标语言 {:?} 不认识，归一为 {:?}",
            c.trans_target, want_target
        ));
        c.trans_target = want_target;
    }
    // 默认引擎只认注册表里登记过的 id（siliconflow / zhipu / dashscope / …），
    // 其它一概退回硅基流动（国内直连、有免费额度的默认）。
    if crate::trans_engines::find(&c.trans_engine).is_none() {
        crate::win::log(&format!(
            "config: 翻译引擎 {:?} 不认识，归一为 siliconflow",
            c.trans_engine
        ));
        c.trans_engine = "siliconflow".to_string();
    }
    // 同时翻译的名单：只认注册表里登记过的 id，并去掉默认引擎自己与重复项
    // （默认引擎**一定**参与，不该在"额外"名单里再出现一次 —— 与 ocr_multi 同口径）。
    {
        let def = c.trans_engine.clone();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let before = c.trans_multi.len();
        c.trans_multi.retain(|id| {
            crate::trans_engines::find(id).is_some() && *id != def && seen.insert(id.clone())
        });
        if c.trans_multi.len() != before {
            crate::win::log(&format!(
                "config: 同时翻译名单里有 {} 项不认识 / 重复 / 就是默认引擎，已清理",
                before - c.trans_multi.len()
            ));
        }
    }
    // ---- r47：旧开关 `ocr_parallel` → 新列表 `ocr_multi` 的一次性迁移 ----
    //
    // 老语义是「**本地 + 设置里配的那家**同时跑」，而且那个组合是写死的
    // （旧 `parallel_engines()` 返回 `["windows", online]`）。所以开关为 true 的
    // 用户迁成"额外同时跑本地"，升级前后的识别行为**逐字不变**；
    // 迁完把老开关落回 false —— 新代码不再读它，留着只会在文件里误导人。
    // 想关掉：在新界面里取消勾选「本地识别」即可。
    if c.ocr_parallel {
        if c.ocr_multi.is_empty() {
            c.ocr_multi.push("windows".to_string());
        }
        c.ocr_parallel = false;
        crate::win::log("config: 旧的「双引擎并行识别」开关已迁移为「同时识别：[windows]」");
    }
    // 同时识别的名单：只认注册表里登记过的 id，并去掉默认引擎自己与重复项
    // （默认引擎**一定**参与，不该在"额外"名单里再出现一次）。
    {
        let def = c.ocr_engine.clone();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let before = c.ocr_multi.len();
        c.ocr_multi.retain(|id| {
            crate::ocr_engines::find(id).is_some() && *id != def && seen.insert(id.clone())
        });
        if c.ocr_multi.len() != before {
            crate::win::log(&format!(
                "config: 同时识别名单里有 {} 项不认识 / 重复 / 就是默认引擎，已清理",
                before - c.ocr_multi.len()
            ));
        }
    }
    // WebDAV 地址只存「用户填的那一段」。
    // 老版本会把软件自己的子目录（QuickSearch/）一起写进配置，用户打开设置页
    // 看到那一截会以为必须手填 —— 用户明确说过"补全 /QuickSearch/ 就够了，再多不用"。
    // 读进来时还原成纯根地址；子目录在真正发请求时由 webdav::normalize_base 补，
    // 最终访问的地址一字不差。
    let want_url = crate::webdav::normalize_input(&c.webdav_url);
    if want_url != c.webdav_url {
        crate::win::log(
            "config: WebDAV 地址里带的软件子目录已还原成根地址（子目录发请求时会自动补）",
        );
        c.webdav_url = want_url;
    }
    // 横条上指向已删除目录的收藏夹哨兵：读配置时就清掉。
    // 这样即使用户的手工编辑 / 一份旧备份里带着这种残留，启动后也不会冒出来。
    let pruned = prune_dangling_fav_sentinels(&mut c);
    if pruned > 0 {
        crate::win::log(&format!(
            "config: 清掉 {pruned} 个指向已删除收藏目录的横条哨兵"
        ));
    }
    // 同理：外部软件被删掉后，横条上那根 @app:<id> 哨兵也该在读配置时就清掉。
    let pruned_apps = prune_dangling_app_sentinels(&mut c);
    if pruned_apps > 0 {
        crate::win::log(&format!(
            "config: 清掉 {pruned_apps} 个指向已删除外部软件的横条哨兵"
        ));
    }
    /* r89：横条里**找不到定义**的引擎名（用户报的那个 bug）。
     *
     * 症状是"横条上明明有、引擎库里搜不到"—— 因为引擎库的数据源是
     * 「内置目录 + custom_engines」，孤儿名字在哪都查不到，只在 bar_list 里躺着。
     * 放在这里（读配置的统一归一点）而不是只放 UI 侧，理由和上面两条一样：
     * 配置可能从本地 / 备份 / 云端恢复 / 导入进来，每一路都该干净。 */
    /* 自定义引擎里的「空壳」记录：有按键序列但种类丢了 → 认回快捷键类。
     * ⚠ 真·空壳**不删、不从横条摘**（用户明确要求"不能把它删掉"）——
     *   横条 / 设置页那边会把它显示成"待补全"，由用户自己补。 */
    let repaired = repair_dead_custom_engines(&mut c);
    if repaired > 0 {
        crate::win::log(&format!(
            "config: 救回 {repaired} 条自定义引擎（有按键序列但没有种类，已按快捷键类处理）"
        ));
    }
    let pruned_undefined = prune_undefined_bar_engines(&mut c);
    if pruned_undefined > 0 {
        crate::win::log(&format!(
            "config: 清掉 {pruned_undefined} 个横条里没有定义的引擎名（孤儿条目）"
        ));
    }
    // r56：「最近使用」名单里那些已经不存在的引擎（用户在设置里删了它），
    // 读配置时就剔掉。不清的话，面板那一栏会给一颗点了 404 的格子。
    let pruned_recent = normalize_recent(&mut c);
    if pruned_recent > 0 {
        crate::win::log(&format!(
            "config: 最近使用名单里 {pruned_recent} 个引擎已不存在，已清理"
        ));
    }
    /* 横条自动收起的两条阈值（2026-10-23）：手改配置文件 / 老备份恢复进来的
     * 值可能离谱（`bar_idle_sec: 99999` = 永远不收；`bar_away_px: 3` = 一动就没）。
     * 界面上是滑块，但配置文件是明文可编辑的，读的时候还得夹一道。
     *   · 0 一律保留 —— 那是"关掉这条"的合法值；
     *   · 秒数上限 300（5 分钟），像素上限 4000（够大屏）。 */
    if c.bar_idle_sec > 300 {
        crate::win::log(&format!(
            "config: 无操作收起 {} 秒太离谱，夹到 300 秒",
            c.bar_idle_sec
        ));
        c.bar_idle_sec = 300;
    }
    if !(0..=4000).contains(&c.bar_away_px) {
        crate::win::log(&format!(
            "config: 鼠标远离阈值 {} px 不合法，夹到 400 px",
            c.bar_away_px
        ));
        c.bar_away_px = default_bar_away_px();
    }
    /* 弹出方向（2026-10-24）：白名单外的一律回「上方」。serde 默认已经是
     * above，这里挡的是手改配置 / 老备份恢复进来的脏值。 */
    if !matches!(c.bar_pos.as_str(), "above" | "below") {
        crate::win::log(&format!(
            "config: 弹出位置 「{}」 不合法，回到「上方」",
            c.bar_pos
        ));
        c.bar_pos = normalize_bar_pos(&c.bar_pos);
    }
    /* GitHub 令牌（2026-10-24）：粘贴进来的值经常带三种垃圾 ——
     *   ① 首尾空白/换行（从网页上框选复制的典型形态）；
     *   ② 中间夹的换行（终端里 `echo` 出来的样子）；
     *   ③ 外层引号（`"ghp_xxx"` / `'ghp_xxx'`）。
     * 这些都会让 `Authorization: Token …` 直接 401，而用户完全看不出为什么。
     * 这里在读配置时就洗干净；空串是合法值（= 匿名请求）。 */
    let tok = c
        .github_token
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'')
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_control())
        /* 长度上限：GitHub 的令牌最长也就 255 左右（fine-grained 更短）。
         * 512 足够容错，再长的一定是粘贴了别的东西 —— 截断而不是拒绝，
         * 免得用户填了个带说明文字的值就整个更新功能不工作。 */
        .take(512)
        .collect::<String>();
    if tok != c.github_token {
        crate::win::log(&format!(
            "config: GitHub 令牌格式归一（{} → {} 字符）",
            c.github_token.chars().count(),
            tok.chars().count()
        ));
        c.github_token = tok;
    }
    c
}

/// 「最近使用」名单归一：去重（保留**最后一次**出现的位置）、
/// 剔掉**当前配置里不存在**的引擎。返回剔掉了几项。
///
/// 判据用"配置里现在认不认这个引擎"，和 `imgsearch::normalize_list` 一个路子：
/// 网页引擎看 `bar_list` + 自定义引擎，快捷键和外部软件各有各的表。
/// 为什么不在 UI 侧做：配置可能被手工编辑、从旧备份恢复、跨机器同步 ——
/// 每一路进来的都得干净，只在读配置这一处归一最靠得住。
/// 「最近使用」最多摆几个：只认 5/10/15/20，别的退回 10。
/// 设置页就给这四档（用户原话：「可以选择最多呈现最近使用的 5 个、10 个、15 个
/// 或者 20 个」），所以这里是个**封闭集合**而不是范围夹取。
pub fn normalize_recent_max(n: usize) -> usize {
    match n {
        5 | 10 | 15 | 20 => n,
        _ => 10,
    }
}

/// 记一笔"最近用了这个引擎"。点了面板里那颗格子时调。
///
/// 语义是"最近一次排最前"，所以实现成**插到最前面**（不是 push 到尾部 ——
/// 那要在展示时整个 reverse，每处展示都得记得反一次，容易漏）。
/// 去重：同名的先把旧的划掉再插，于是同名只出现一次、且位置是最新的。
/// 上限：名单本身可以无限长（它不是配置里要展示的东西），但**没必要**攒
/// 几十年 —— 超过 200 条就把尾巴裁掉，配置文件不会因此无上限膨胀。
pub fn note_recent_engine(cfg: &mut Config, engine: &str) {
    let name = engine.trim();
    if name.is_empty() {
        return;
    }
    cfg.recent_engines.retain(|e| e != name);
    cfg.recent_engines.insert(0, name.to_string());
    // 名单长度上限。200 条足够覆盖"换着用几十家引擎"的场景，
    // 又不至于让 config.json 因为一个使用记录变得难读。
    const RECENT_KEEP: usize = 200;
    if cfg.recent_engines.len() > RECENT_KEEP {
        cfg.recent_engines.truncate(RECENT_KEEP);
    }
}

/// 把「最近使用」名单收干净：**去重**，同名的只留最近那一次。
///
/// ⚠ r57 修的一个真 bug：这里以前还按"配置里认不认识这个名字"过滤，判据是
///   `bar_list` + 自定义引擎 + 外部软件。结果**面板里点过、但没固定到横条上的
///   引擎全被当成"不认识"删掉了** —— 而"最近使用"这一栏存在的意义恰恰就是
///   "点那些没固定在横条上的引擎"。于是用户点了十几次，那一栏永远是空的。
///
///   现在**不再做存在性过滤**。理由：
///     · 前端 `renderRecentSection` 本来就会按名字在引擎表里查，查不到就跳过
///       （不给一颗点了没反应的格子），兜底已经有了；
///     · 跨机器恢复备份时，另一台机器上的引擎这台可能没有 —— 这种"不认识的
///       名字"留着不占位、也不报错，比"读配置时悄悄删掉用户的使用记录"温和；
///     · 名单本身有 200 条上限（`note_recent_engine`），不会无限长。
///
/// 只去重（保留最近那一次）是有意义的：`note_recent_engine` 写的时候已经去过，
/// 但手改配置文件 / 旧版本留下的重复项得在读的时候收一次。
pub fn normalize_recent(c: &mut Config) -> usize {
    let before = c.recent_engines.len();
    // 自后向前扫：同名的保留**最靠后**那一次（= 最近一次），前面的丢掉。
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::with_capacity(c.recent_engines.len());
    for name in c.recent_engines.iter().rev() {
        if name.trim().is_empty() {
            continue;
        }
        if seen.insert(name.clone()) {
            out.push(name.clone());
        }
    }
    out.reverse();
    c.recent_engines = out;
    before - c.recent_engines.len()
}
/// 一份配置里"算凭据"的字段此刻填了几项。
///
/// # 用途
///
/// 「备份」页要回答用户一个很实际的问题：**这份备份把哪些东西一起带走了**。
/// 凭据是最该被看见的那类（它们决定"这份备份泄露了我多少"），所以单独数出来。
///
/// # 为什么清单是写死的
///
/// 没有遍历"所有 String 字段"：那样会把 `hotkey`、语言、代理地址之类
/// 全数进来，数字看着大、实际没意义。凭据是会新增的（github_token 就是
/// v1.5.7 才有的），每次新增都该有人明确判断"它算不算凭据"——
/// 这个函数就是那个判断的落点。
///
/// map 那两组按**实际填了值的条目**数：空 map 和"填了一半"不该同分。
/// # 为什么百度那套要去重
///
/// 百度的 Key 有**两种存法**：老字段 `ocr_key` / `ocr_secret`（v1.3 之前），
/// 和新 map `ocr_keys` / `ocr_secrets`。老用户升级上来时老字段还在（读的时候
/// 会回退过去，见 main.rs 的 `ocr_creds`）。两边都数就会把"1 个百度 Key"
/// 报成 2 项 —— 用户看到数字对不上自己的记忆，反而会怀疑备份漏了东西。
pub fn secret_count(c: &Config) -> usize {
    let mut n = 0;
    for s in [&c.backup_password, &c.webdav_pass, &c.github_token] {
        if !s.trim().is_empty() {
            n += 1;
        }
    }
    // 百度在 map 里有条目就只认 map，老字段不重复计
    let baidu_in_map =
        c.ocr_keys.contains_key("baidu") || c.ocr_secrets.contains_key("baidu");
    if !baidu_in_map {
        for s in [&c.ocr_key, &c.ocr_secret] {
            if !s.trim().is_empty() {
                n += 1;
            }
        }
    }
    n += c.ocr_keys.values().filter(|v| !v.trim().is_empty()).count();
    n += c.ocr_secrets.values().filter(|v| !v.trim().is_empty()).count();
    n
}

/// 一份备份"值不值得用来恢复"的打分。**分数越高越完整**。
///
/// # 为什么需要打分（r92：这是"更新后所有设置归零"的最后一道防线）
///
/// 事故链条的最后一环：
///   1. `config.json` 损坏；
///   2. `load_backup_of` 按**文件名排序取最新**；
///   3. 而最新那份 `config.auto(...)` 恰好是**配置被清空之后**写下的
///      （设置全没了 → 程序用默认值保存了一次 → 生成一份"默认配置"备份）；
///   4. 于是"恢复"恢复的是一份空配置 —— 看起来恢复成功，实际什么都没救回来。
///
/// 用户看到的就是：更新完，一切设置都是默认值。
///
/// 所以恢复时不能只认"最新"，还要看"这份里有没有真东西"：
///   · 有自定义引擎 / OCR key / WebDAV 账号 / 收藏 —— 用户手工配过的证据，各加分；
///   · 全都没有 = 一份"默认配置"，**几乎肯定不是用户想要的**，分数接近 0。
///
/// 分数相同的，才按文件名（时间）新的优先。
fn backup_quality(c: &Config) -> i32 {
    let mut score = 0;
    if !c.custom_engines.is_empty() {
        score += 40;
    }
    if !c.ocr_key.trim().is_empty() {
        score += 20;
    }
    if !c.ocr_secret.trim().is_empty() {
        score += 10;
    }
    if !c.webdav_url.trim().is_empty() {
        score += 20;
    }
    if !c.webdav_user.trim().is_empty() {
        score += 10;
    }
    if !c.webdav_pass.trim().is_empty() {
        score += 10;
    }
    if !c.favorites.is_empty() {
        score += 25;
    }
    if !c.backup_password.trim().is_empty() {
        score += 5;
    }
    if !c.ai_matting_model.trim().is_empty() {
        score += 10;
    }
    if !c.overrides.is_empty() {
        score += 5;
    }
    if !c.apps.is_empty() {
        score += 15;
    }
    // 横条里含自定义引擎名 = 用户真配过的铁证（默认横条也有七八条，长度本身不算分）
    let names: std::collections::HashSet<&str> =
        c.custom_engines.iter().map(|e| e.name.as_str()).collect();
    if c.bar_list.iter().any(|n| names.contains(n.as_str())) {
        score += 15;
    }
    score
}


fn load_backup_of(path: &std::path::Path) -> Option<Config> {
    // 候选位置都试一遍：走到这里说明主文件已经坏了，此时还不知道用户把备份
    // 目录设到哪，只能都找 —— 找到哪个用哪个。
    //
    // 当前滚动备份叫 `config(YYYY-MM-DD HH-MM-SS).QuickSearch`（用户要求：
    // 「文件名(详细时间).软件名后缀」，后缀用软件名也算一层防误认）。
    // 老名字（config.json.bak / config.before-webdav-*.json）继续兼容，
    // 升级上来的用户不至于丢掉上一份备份。
    // 候选顺序（先命中谁用谁）：
    //   ① 主文件**同目录**的最新滚动备份 `config(...).QuickSearch`
    //      —— save_to 的 cfg.backup_dir 指向旁边时备份就落在这儿；
    //   ② 主文件同目录的老名 `config.json.bak`（旧版布局 / 测试手写备份）；
    //   ③ 数据目录（= 没设备份目录时的落点）的最新滚动备份；
    //   ④ 数据目录的老名 `config.json.bak`（老版遗留，升级用户兜底）。
    //
    // ⚠ ③④ 必须排在 ①② 后面：用户机器上数据目录躺着的那份老备份是**旧内容**，
    //   ①② 才和主文件同代。曾经把老 bak 排在最前，结果「截断恢复」恢复出的
    //   是一份陈配置（delay_ms 之类对不上），排查半天。
    //
    // 走到这里说明主文件已经坏了，此刻还不知道用户把备份目录设到哪，
    // 只能把可能的位置都找一遍 —— 找到哪个用哪个。
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let scan = |dir: &PathBuf| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_file() && is_rolling_backup(&p) {
                    v.push(p);
                }
            }
        }
        v.sort();
        v
    };
    // ⚠ 两个目录**各自**取最新，不能混在一起 sort：混排后按整路径字符串比，
    //   完全可能把数据目录那份排到最后（Temp 的盘符/路径恰好更小），
    //   于是「同目录优先」名存实亡。
    let local_roll = scan(&parent);
    /* ⚠ 自定义备份目录也要扫。
     *
     * 旧代码这里是 `backup_dir_of(&Config::default())` —— 默认配置的
     * `backup_dir` 是空串，于是它恒等于"数据目录"，**永远扫不到用户自己设的
     * 备份目录**。而 `save_to` 写滚动备份时用的是 `backup_dir_of(cfg)`，
     * 也就是真按用户设的目录落盘。后果：用户设过备份目录之后，主文件一坏，
     * 候选位置全是空的，直接落回默认配置（用户的引擎排序/密钥/收藏全没了）。
     *
     * 正确做法：先把主文件里能读到的 `backup_dir` 抠出来（哪怕整份 JSON
     * 已经坏了，只要那个字符串还在就能救），再按它扫一遍。 */
    let bdir = configured_backup_dir(path)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| backup_dir_of(&Config::default()));
    let bdir_roll = if bdir != parent { scan(&bdir) } else { Vec::new() };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(newest) = local_roll.last() {
        candidates.push(newest.clone());
    }
    candidates.push(path.with_extension("json.bak"));
    if let Some(newest) = bdir_roll.last() {
        candidates.push(newest.clone());
    }
    if bdir != parent {
        candidates.push(bdir.join("config.json.bak"));
    }
    /* r92：**先把备份密码抠出来**，否则加密备份一个都读不了
     * （这正是"更新后所有设置归零"那次事故的真根因，详见
     *   `read_backup_config` 上面那段完整记录）。
     *
     * 三个来源，按可靠性排序：
     *   ① 主文件（哪怕已经坏了，只要 `backup_password` 字段还完好）；
     *   ② **任何一个能读成明文的备份**（老备份是明文，里面也存着密码）；
     *   ③ 都没有 —— 那就只救得了明文备份。
     *
     * ② 很重要：主文件被截断/损坏时密码字段往往正好丢了，
     *   而"上上次的明文备份"里还有密码 —— 有它就能解开最近那份加密备份。 */
    /* ① 优先读独立存档 —— 它不随 config.json 一起损坏 */
    let mut backup_pw = load_backup_password();
    if !backup_pw.is_empty() {
        crate::win::log("config: 从 backup.key 读到了备份密码");
    }
    /* ② 存档没有，再从（可能已损坏的）主文件里抠 */
    if backup_pw.is_empty() {
        backup_pw = configured_string(path, "backup_password").unwrap_or_default();
    }
    if backup_pw.is_empty() {
        for bak in &candidates {
            // 只从**能当明文解析**的备份里抠（密文备份抠不出来）
            if let Ok(s) = std::fs::read_to_string(bak) {
                if !crate::crypto::looks_encrypted(&s) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                        if let Some(p) = v.get("backup_password").and_then(|x| x.as_str()) {
                            if !p.trim().is_empty() {
                                backup_pw = p.trim().to_string();
                                crate::win::log(&format!(
                                    "config: 从备份 {} 里找到了备份密码",
                                    bak.display()
                                ));
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    if !backup_pw.is_empty() {
        crate::win::log("config: 拿到备份密码，加密备份可以尝试解密恢复了");
    } else {
        crate::win::log("config: 没拿到备份密码 —— 加密备份无法解开");
    }

    /* ══════════════════════════════════════════════════════════════════
     * r93：**默认恢复最新一份**，只在"疑似被清空"时才往回找
     *
     * 用户原话：「备份肯定是要恢复最新的呀，这个逻辑就不能变，但要多一个
     *   检测环节，如果确实是手动操作，从而使得备份内容减少，那这应该就是
     *   正常的，而不是说一刀切看什么最多恢复什么。」
     *
     * r92 我为了修"恢复出空配置"，改成"按完整度挑最高分"—— 那是**矫枉过正**：
     * 用户手动删掉几个引擎、清空收藏，本来是最新状态，却被恢复成一份
     * "内容更多但更旧"的备份。这是错的。
     *
     * 正确逻辑（两层）：
     *   ① **默认取最新那份**（文件名含时间戳，字典序即时间序）；
     *   ② **异常检测**：只有当最新那份"看起来被清空了"（见 `looks_wiped`）
     *      才往回退到最近一份正常的。手动删减**不算**被清空 —— 判据是
     *      "有没有残留的用户配置痕迹"，不是"内容多少"。
     * ══════════════════════════════════════════════════════════════════ */
    let mut readable: Vec<(String, std::path::PathBuf, Config)> = Vec::new();
    for bak in candidates {
        if let Some(c) = read_backup_config(&bak, &backup_pw) {
            let name = bak.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            crate::win::log(&format!(
                "config: 候选备份 {name}（完整度 {}）",
                backup_quality(&c)
            ));
            readable.push((name, bak, c));
        }
    }
    if readable.is_empty() {
        crate::win::log("config: 所有候选备份都读不出来，只能落回默认配置");
        return None;
    }
    // 按文件名（含时间戳）从新到旧
    readable.sort_by(|a, b| b.0.cmp(&a.0));
    let newest = readable.remove(0);

    /* ② 异常检测：最新那份像不像"被清空了"？ */
    if looks_wiped(&newest.2) {
        if let Some((name, _, c)) = readable.into_iter().find(|(_, _, c)| !looks_wiped(c)) {
            crate::win::log(&format!(
                "config: 最新备份 {} 疑似被清空（没有任何用户配置痕迹），\
                 回退到更早的 {name}（完整度 {}）",
                newest.0,
                backup_quality(&c)
            ));
            return Some(c);
        }
        crate::win::log("config: 所有备份都没有用户配置痕迹，用最新那份");
        return Some(newest.2);
    }

    crate::win::log(&format!(
        "config: 从 {} 恢复最新一份（完整度 {}）",
        newest.1.display(),
        backup_quality(&newest.2)
    ));
    Some(newest.2)
}

/// 一份配置看起来**像不像是"被清空了"**（而不是用户手动删减）。
///
/// # 为什么要区分这两件事
///
/// 用户可能自己删掉几个引擎、清空收藏夹 —— 那是**正常操作**，
/// 备份就该忠实记录这个状态，恢复时也该用最新的。
///
/// 但如果是配置损坏/程序 bug 导致的"一切归零"，就必须救回来。
///
/// # 判据：看有没有**残留痕迹**
///
///   · 手动删减 → 总有痕迹：`overrides` 里还留着某个引擎的图标、
///     `fav_panel_sizes` 里还留着某个收藏目录的尺寸、`url_overrides`
///     里还有自定义 URL、`recent_engines` 里还有用过的引擎……
///   · 意外清空 → 这些**一次性全没了**（都在同一个配置文件里，一起被默认值覆盖）。
///
/// 所以：**有痕迹 = 手动删的（正常）；零痕迹 = 被清空的（异常）**。
/// 注意这跟"内容多少"无关 —— 删到只剩一个引擎但留着它的图标，就是正常的。
///
/// ⚠ r94：`bar_list` 也要算痕迹 —— 有一种"只有横条被改过"的用户：
///   他不动引擎库、不设收藏、不填 OCR/WebDAV，只是把内置引擎在横条上
///   删几个、挪个位置。这种人如果只按上面那些字段判，会被当成"被清空"，
///   于是恢复出一份**更旧**的横条排列 —— 正是用户明令禁止的"一刀切".
///   判据用"和默认排列不一样"（不是"非空"：`bar_list` 永远非空）。
fn looks_wiped(c: &Config) -> bool {
    let default_bar: Vec<String> = DEFAULT_BAR.iter().map(|s| s.to_string()).collect();
    let has_traces = !c.custom_engines.is_empty()
        || !c.overrides.is_empty()
        || !c.url_overrides.is_empty()
        || !c.favorites.is_empty()
        || !c.fav_panel_sizes.is_empty()
        || !c.ai_suffixes.is_empty()
        || !c.ocr_key.trim().is_empty()
        || !c.ocr_secret.trim().is_empty()
        || !c.webdav_url.trim().is_empty()
        || !c.webdav_user.trim().is_empty()
        || !c.backup_password.trim().is_empty()
        || !c.ai_matting_model.trim().is_empty()
        || !c.apps.is_empty()
        || !c.recent_engines.is_empty()
        || c.bar_list != default_bar;
    !has_traces
}

/* ══════════════════════════════════════════════════════════════════════
 * r92：从**加密**备份里恢复（这是"更新后数据全丢"那次的真根因修复）
 *
 * ## 事故经过
 *
 * 用户报：「这次更新基本上就把一切软件设置都恢复了默认设置」——
 * OCR key / WebDAV 账号密码 / 收藏夹 / 自定义引擎 / AI 模型选择全没了。
 *
 * 查下来是一条**恢复链断在半路**：
 *   1. `config.json` 某次损坏（`preserve_broken` 留了档，证据是
 *      `config.broken(2026-10-20 12-22-12).QuickSearch`）；
 *   2. `load_backup_of` 去找滚动备份，逐个 `serde_json::from_str::<Config>`；
 *   3. 但用户**设了备份密码**，滚动备份里躺着的是 `{"qsEnc":1,"kdf":...}`
 *      这种**密文信封** —— 明文解析必然失败；
 *   4. 所有候选全部失败 → `None` → **落回 `Config::default()`** →
 *      用户所有设置归零。
 *
 * ## 为什么以前没暴露
 *
 * 没设备份密码的人，滚动备份是明文，这条链能走通。**设了密码的人，
 * 反而失去了自动恢复能力** —— 加密本来是保护，结果成了数据丢失的帮凶。
 *
 * ## 修法
 *
 * 解析失败时，**再试一次解密**（用配置里的 `backup_password`）。
 * 密码从哪来？主文件坏了就读不出来 —— 所以这里也支持从**候选备份自己**
 * 里抠（备份里也存着 `backup_password`，前提是那份能解开……鸡生蛋问题）。
 * 实际可行的做法：先用**已知的**密码试（调用方传入），拿不到就用空密码
 * 试一次（未加密的备份走这条），最后才放弃。
 *
 * ⚠ 这是"尽力而为"：密码本身丢了就真救不回来（那正是加密的意义）。
 *   但**只要密码还在**（比如主文件只是尾部截断、密码字段完好），就能恢复。
 * ══════════════════════════════════════════════════════════════════════ */

/// 从一个备份文件里读出 `Config`：**先按明文，失败再按密文解**。
///
/// `password` 是用户设的备份密码（可能为空 = 没设过，那就只走明文）。
///
/// 返回 `None` 的三种情形：文件读不出 / 明文与密文都解析不了 / 密文密码不对。
pub fn read_backup_config(path: &std::path::Path, password: &str) -> Option<Config> {
    let s = std::fs::read_to_string(path).ok()?;

    /* ⚠⚠ r92 关键修正：**先判密文，再试明文**。
     *
     * 原来的顺序是"先试明文解析"，这是致命的：
     * `Config` 结构体整个带 `#[serde(default)]`，所以
     * `serde_json::from_str::<Config>` 对 `{"qsEnc":1,"data":"...","kdf":...}`
     * 这种**密文信封会"解析成功"** —— 未知字段被忽略，其余字段全取默认值。
     *
     * 后果：一份完好的加密备份被当成"解析成功但内容是全默认"，
     * 于是恢复出一份空配置 —— 用户看到的就是"更新后所有设置归零"。
     *
     * 所以必须**先看它是不是密文信封**，是就只走解密这条路。
     *
     * v1.4.0：`unseal` 已经把两种信封（密码 / DPAPI）都收了口 ——
     * 这里不再自己判 kdf，交给它按信封版本选钥匙。 */
    if crate::crypto::looks_encrypted(&s) {
        return match crate::crypto::unseal(&s, password) {
            Ok(plain) => match serde_json::from_str::<Config>(&plain) {
                Ok(c) => {
                    crate::win::log(&format!(
                        "config: {} 是加密备份，已解开（完整度 {}）",
                        path.display(),
                        backup_quality(&c)
                    ));
                    Some(c)
                }
                Err(e) => {
                    crate::win::log(&format!(
                        "config: {} 解密成功但内容不是有效配置（{e}）",
                        path.display()
                    ));
                    None
                }
            },
            Err(e) => {
                crate::win::log(&format!(
                    "config: {} 解密失败（{e}）—— 密码不对或文件损坏",
                    path.display()
                ));
                None
            }
        };
    }

    // ② 明文（没设密码的备份、或老版本留下的）
    serde_json::from_str::<Config>(&s).ok()
}

/// 从**可能已经损坏**的 config.json 里抠出 `backup_dir`。
///
/// 为什么单独写一个"只读一个字段"的函数：`load_backup_of` 被调用的前提就是
/// 整份文件已经解析不了（严重损坏），这时候 `serde_json::from_str::<Config>`
/// 必然失败 —— 但用户设的备份目录只是一段普通字符串，多半还完好地躺在文件里。
/// 只解析成 `serde_json::Value`（对多余/缺失字段宽容得多），取一个键即可。
///
/// 取不到（文件读不出、不是 JSON、字段为空）→ None，调用方回落默认目录。
fn configured_backup_dir(path: &std::path::Path) -> Option<String> {
    configured_string(path, "backup_dir")
}

/// 从（可能损坏的）配置里抠出**任意一个字符串字段**。
///
/// 泛化自 `configured_backup_dir` —— r92 需要 `backup_password` 走同一套
/// "整份解析失败也要把这一小段捞出来"的逻辑：加密备份能不能恢复，全看
/// 这个密码能不能从坏文件里捞出来。
///
/// 两级兜底：① 整份当 `serde_json::Value` 解析（对多余/缺失字段很宽容）；
/// ② 纯字符串搜索 `"key" : "..."`（应对截断 / 尾部半损）。
fn configured_string(path: &std::path::Path, key_name: &str) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
        if let Some(d) = v.get(key_name).and_then(|x| x.as_str()) {
            let d = d.trim();
            if !d.is_empty() {
                return Some(d.to_string());
            }
        }
    }
    // 截断 / 半损：退回字符串搜索 `"key"\s*:\s*"..."` 的第一处
    let key = format!("\"{key_name}\"");
    let i = s.find(&key)?;
    let rest = s[i + key.len()..].trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let d = rest[..end].trim();
    if d.is_empty() {
        None
    } else {
        Some(d.to_string())
    }
}

/// 是不是「滚动备份」—— save_to 每次保存时留下的那一份。
/// 名字形如 `config(2026-10-12 06-30-37).QuickSearch`。
pub fn is_rolling_backup(p: &std::path::Path) -> bool {
    let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    name.starts_with("config.auto(") && name.ends_with(").QuickSearch")
}

/// 是不是「立即备份」产生的备份文件（本地与云端同名的那一族）。
///
/// 老版本里滚动备份也叫这个名字，所以老用户的目录里会留下几份 ——
/// 它们内容上就是完整的配置备份，**照常当备份认**，由「仅保留最近 N 份」清理。
pub fn is_manual_backup(name: &str) -> bool {
    name.starts_with("config(") && name.ends_with(").QuickSearch")
}

/// 「恢复之前留的本机快照」—— 恢复云端之前（`stash_local_config`）和
/// **恢复本地备份之前**（`stash_before_restore`，v1.4.1）都留一份。
///
/// 只认前缀：新名字是 `config.before-*(时间).QuickSearch`，
/// 老版本还留过 `config.before-webdav-*.json`，两种都得算进来。
pub fn is_snapshot(name: &str) -> bool {
    name.starts_with("config.before-")
}

/// 把坏内容留档，别直接覆盖掉 —— 用户还能手工捞。
///
/// ⚠ v1.4.0：留档也**必须加密**。坏文件里可能是明文（老版本）也可能是密文；
///   明文那份如果原样写到 `.bad-N`，等于在磁盘上又留了一份明文用户数据。
///   所以：已经是密文就原样留，明文就先封再留（封不了就干脆不留 —— 宁可
///   少一份排查材料，也不能违反"不留明文"）。
fn preserve_broken(path: &std::path::Path, text: &str) {
    let body = if crate::crypto::looks_encrypted(text) {
        text.to_string()
    } else {
        match crate::crypto::seal(text, &load_backup_password()) {
            Ok(t) => t,
            Err(e) => {
                crate::win::log(&format!("config: 坏配置留档失败（加密不了：{e}），不写明文"));
                return;
            }
        }
    };
    for i in 0..9 {
        let mut p = path.to_path_buf();
        p.set_file_name(format!(
            "{}.bad-{}",
            path.file_name().and_then(|s| s.to_str()).unwrap_or("config.json"),
            i + 1
        ));
        if !p.exists() {
            let _ = std::fs::write(&p, body.as_bytes());
            crate::win::log(&format!("config: 坏配置已留档（加密）{}", p.display()));
            return;
        }
    }
}

/// 存配置。
///
/// 改成「先写临时文件 → 换名覆盖」，而不是直接往目标文件写。
///
/// 直接写的坏处是：写到一半进程被杀 / 断电，磁盘上就留下半截 JSON，
/// 下次启动 `load()` 解析失败 → 用户配置全丢。写临时文件再 rename 的话，
/// 崩溃只会留下一份 `.tmp` 垃圾，正式文件始终是完整的上一版。
///
/// 另外每次成功保存都顺手留一份滚动备份（`config(时间).QuickSearch`），
/// 供上面 `load()` 的兜底路径使用。
pub fn save(cfg: &Config) {
    save_to(&config_path(), cfg);
}

/// `save` 的可注入版本（测试专用，理由同 `load_from`）。
pub fn save_to(path: &std::path::Path, cfg: &Config) {
    ensure_dirs();
    /* ⚠⚠ v1.4.0：主文件解不开时**一律不写盘**（详见 `LOCKED` 的注释）。
     * 否则"带着默认配置跑一次"就会把那份完好但解不开的加密配置覆盖掉。 */
    if is_locked() {
        crate::win::log("config: 主文件解不开（已锁写），本次不保存 —— 数据原样保留");
        return;
    }
    let Ok(s) = serde_json::to_string_pretty(cfg) else {
        return;
    };
    /* ══════════════════════════════════════════════════════════════════
     * v1.4.0：**主文件和备份全部加密，磁盘上不留任何明文**
     *
     * 用户要求（原话）：「仔细核查一下，我们这个软件的所有的本地数据都要
     *   加密，就不能够以任何明文的方式来显示任何的用户数据」。
     *
     * r92 时只加密了备份，主文件 `config.json` 故意留明文（理由写在这儿：
     * "加密它就得在启动最早期要密码"）。v1.4.0 把这条口子堵上：
     *   · 有备份密码 → 用密码加密（可跨机，用户选的口径）；
     *   · 没有密码（首次运行）→ DPAPI 加密（跟 Windows 账户走）；
     *   · **加密失败就整体放弃写盘**，绝不退化成写明文。
     *
     * 启动时"要不要输密码"的问题用 `backup.key` 解决：密码本身用 DPAPI
     * 存一份（`stash_backup_password`），所以本机上无感解锁；换机时才需要
     * 用户重新填（见 `load_backup_password`）。
     * ══════════════════════════════════════════════════════════════════ */
    // 备份密码先取出来：写备份要用它加密，轮转时读旧备份也要用它解密
    let backup_pw = cfg.backup_password.trim().to_string();
    /* r92：把密码另存一份到 `backup.key` —— 这样 config.json 坏了
     * 之后仍然解得开加密备份（详见 `stash_backup_password` 的说明）。 */
    stash_backup_password(&backup_pw);
    let seal = |plain: &str| -> Option<String> {
        match crate::crypto::seal(plain, &backup_pw) {
            Ok(t) => Some(t),
            Err(e) => {
                crate::win::log(&format!("config: 加密失败（{e}）—— 本次不写盘，绝不落明文"));
                None
            }
        }
    };
    let Some(main_text) = seal(&s) else {
        return;
    };
    let backup_text = match seal(&s) {
        Some(t) => t,
        None => {
            // 加密失败不能写明文（那就把用户的"加密"承诺破了）
            crate::win::log("config: 滚动备份加密失败，本次不留备份（不写明文）");
            String::new()
        }
    };
    // 滚动备份落在**备份目录**（用户在设置里指定的目录；没指定就是数据目录），
    // 名字按用户要求来：`config(YYYY-MM-DD HH-MM-SS).QuickSearch` ——
    // 「文件名(详细时间)」+ 软件名后缀（后缀用软件名也算一层防误认，
    // 资源管理器里不会一眼看成普通 json）。
    //
    // 每次成功保存之后，让备份与正式文件**保持一致**。早先只在「替换已有
    // 文件」时才留备份，于是「首次运行」这条路压根没有备份：用户装好、没改过
    // 设置、某次写文件写坏了 → 没有备份可退 → 配置直接归零。现在每次都写一份，
    // 代价是多一次几十 KB 的写入，换来的是任何时刻都有一份可用的完整副本。
    //
    // ⚠ 只保留**一份**：save_to 调用非常频繁（横条尺寸之类的小改动都会存一次），
    // 每次保存都新写一个带时间戳的文件，一天就能攒出几百个垃圾。
    //
    // ⚠ 但"先删旧的、再写新的"顺序是错的：主文件写失败时这里会 return，
    //   那时旧的滚动备份已经被删干净、新的还没写 —— 备份族一份不剩。
    //   正确顺序是**先写新备份、成功了再删旧的**（下面就是这么排的）。
    /* 滚动备份落点（v1.4.0 口径）：
     *
     *   · 用户设了备份目录 → 用他的；
     *   · 没设 + 写的是**正式主文件** → exe 旁边的 `QuickSearch back`
     *     （用户要求"所有备份都放这个文件夹"）；
     *   · 没设 + 写的是**注入的路径**（测试传临时文件）→ 就放它旁边，
     *     绝不往真实目录里塞测试配置（2026-10-22 的事故，见 r99 记录）。 */
    let bdir = if !cfg.backup_dir.trim().is_empty() {
        backup_dir_of(cfg)
    } else if path == config_path() {
        default_backup_dir()
    } else {
        path.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(default_backup_dir)
    };
    let bak = bdir.join(rolling_backup_name(&backup_stamp()));
    let tmp = path.with_extension("json.tmp");
    // ⚠ 换名失败（杀软实时扫描 / 网盘占用 / 权限）时**绝不能直接往目标文件写**。
    //
    // 以前这里有一句"换名失败就退回 std::fs::write(path)"——那恰恰把整段注释
    // 宣称要避免的事情又做了一遍：直接写到一半被杀/断电，就会留下半截 JSON，
    // 下次 load 解析失败，用户配置全丢（而且 .bak 是在这之后才写的，连退路都
    // 来不及留）。现在的做法是：换个小退避重试几次，仍然失败就整体放弃
    // ——宁可这次没存上，也不能冒"把唯一的好文件写坏"的风险。
    let mut write_ok = false;
    for attempt in 0..3 {
        // ⚠ 写的是 `main_text`（密文信封），**不是** `s`（明文）
        if std::fs::write(&tmp, main_text.as_bytes()).is_ok()
            && std::fs::rename(&tmp, path).is_ok()
        {
            write_ok = true;
            break;
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_millis(30 * (attempt + 1)));
        }
    }
    if !write_ok {
        let _ = std::fs::remove_file(&tmp);
        crate::win::log(&format!(
            "config: 保存失败（{} 换个磁盘/windows 位置？），本次不写盘",
            path.display()
        ));
        return;
    }
    /* 新备份也走"临时文件 + rename"（以前是裸 fs::write，写一半被杀就只剩
     * 半截文件，而它恰恰是主文件坏掉时唯一的退路）。写成功之后再清旧的。
     *
     * r92：写的是 `backup_text`（设了密码时是密文信封），不再是明文 `s`。
     * 加密失败时 `backup_text` 是空串 —— 那种情况**整个跳过备份写入**，
     * 绝不退化成写明文。 */
    if backup_text.is_empty() {
        return;
    }
    let bak_tmp = bak.with_extension("tmp");
    let bak_ok = std::fs::write(&bak_tmp, backup_text.as_bytes()).is_ok()
        && std::fs::rename(&bak_tmp, &bak).is_ok();
    if !bak_ok {
        let _ = std::fs::remove_file(&bak_tmp);
        crate::win::log(&format!(
            "config: 滚动备份写入失败（{}），保留旧的备份不删",
            bak.display()
        ));
        return;
    }
    /* ══════════════════════════════════════════════════════════════════
     * r92：滚动备份**不再"只留一份"**（这是数据丢失的最后一环）
     *
     * 用户报「这次更新把一切设置都恢复成默认」—— 事故链的最后一步在这里：
     *   1. config.json 损坏 → 恢复失败 → 用默认配置启动；
     *   2. 程序随即 `save`（把默认配置写回）；
     *   3. **这里把同目录所有其他滚动备份全删了** ——
     *      包括那份"恢复失败但内容完好"的加密备份；
     *   4. 于是退路被自己销毁，用户再也没法捞回来。
     *
     * 现在的规则：
     *   · 最多保留 `MAX_ROLLING` 份（按时间留最新的）；
     *   · **绝不删除"比本次写下的这份更有价值"的备份** ——
     *     用 `backup_quality` 比：一份含自定义引擎/OCR key/收藏的备份，
     *     不能被一份"默认配置"挤掉。这条是关键：
     *     恢复失败后用默认配置启动时，那份好备份必须活着。
     * ══════════════════════════════════════════════════════════════════ */
    const MAX_ROLLING: usize = 8;
    let new_quality = backup_quality(cfg);
    let mut keep: Vec<(String, i32, PathBuf)> = Vec::new();   // (文件名, 分数, 路径)
    if let Ok(rd) = std::fs::read_dir(&bdir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p.is_file() || p == bak || !is_rolling_backup(&p) {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            // 读一下这份旧备份的完整度（读不出来当 0 —— 它本来就是坏的）
            let q = read_backup_config(&p, &backup_pw)
                .map(|c| backup_quality(&c))
                .unwrap_or(0);
            /* ⚠ 核心保护：**比本次更有价值的备份一律不删**。
             *   本次写的是"默认配置"（q=0）时，所有有内容的旧备份都会被保住。 */
            if q > new_quality {
                crate::win::log(&format!(
                    "config: 保留旧备份 {name}（完整度 {q} > 本次 {new_quality}）"
                ));
                continue;
            }
            keep.push((name, q, p));
        }
    }
    // 按文件名（含时间戳）从新到旧排序，只保留前 MAX_ROLLING-1 份（加上本次那份）
    keep.sort_by(|a, b| b.0.cmp(&a.0));
    for (name, _, p) in keep.into_iter().skip(MAX_ROLLING.saturating_sub(1)) {
        crate::win::log(&format!("config: 轮转清掉旧备份 {name}"));
        let _ = std::fs::remove_file(&p);
    }
}

/// 把用户挑的图片复制进 icons 目录，返回落地后的文件名
pub fn stash_icon(engine: &str, src: &std::path::Path) -> Option<String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let safe: String = engine
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let file = format!("{}.{}", safe, ext);
    ensure_dirs();
    std::fs::copy(src, icons_dir().join(&file)).ok()?;
    Some(file)
}

pub fn drop_icon(file: &str) {
    let _ = std::fs::remove_file(icons_dir().join(file));
}

pub fn mime_of(file: &str) -> &'static str {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub fn data_url(file: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", mime_of(file), base64(bytes))
}

pub fn base64_decode(s: &str) -> Vec<u8> {
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 3);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    out
}

/// 把导出文件里的 data URL 还原成 icons 目录下的图标文件，返回文件名。
pub fn restore_icon(engine: &str, data_url: &str) -> Option<String> {
    let comma = data_url.find(',')?;
    let head = &data_url[..comma];
    let body = data_url[comma + 1..].trim();
    let ext = if head.contains("svg") {
        "svg"
    } else if head.contains("jpeg") || head.contains("jpg") {
        "jpg"
    } else if head.contains("gif") {
        "gif"
    } else if head.contains("webp") {
        "webp"
    } else if head.contains("bmp") {
        "bmp"
    } else if head.contains("icon") {
        "ico"
    } else {
        "png"
    };
    let bytes = base64_decode(body);
    if bytes.is_empty() {
        return None;
    }
    let safe: String = engine
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let file = format!("{}.{}", safe, ext);
    ensure_dirs();
    std::fs::write(icons_dir().join(&file), bytes).ok()?;
    Some(file)
}

/// icons 目录里「文件名 = 引擎名」的默认图标（#138）。
///
/// 用户原话：「读取 C:\Users\64381\AppData\Roaming\QuickSearch\icons 目录中的
/// 自定义图标，并将其设为软件中相应引擎的默认图标」。
///
/// 约定与 [`stash_icon`] 的落地规则一致（用户在图库挑的图就存成
/// `<引擎名>.<ext>`），所以这个目录里躺着的文件**大概率本身就是 override
/// 文件**。调用方（main.rs 的 config_view）会先把 overrides 已引用的文件
/// 剔掉，剩下的才是「用户手动丢进来、想当某个引擎默认图标」的。
///
/// 返回 `(文件名去掉扩展名, 文件路径)`，按路径排序保证结果稳定。
/// 只收图片扩展名，别的文件（.json、.db 之类）不碰。
pub fn dir_icon_defaults() -> Vec<(String, std::path::PathBuf)> {
    let dir = icons_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, std::path::PathBuf)> = Vec::new();
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg"
        ) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        out.push((stem.to_string(), path));
    }
    out.sort();
    out
}

/// 动 APPDATA 的测试拿这把锁串行 —— set_var 是进程级的，并行跑会互相踩。
///
/// 放在模块级（而不是 mod tests 里）是为了让 main.rs 的测试也能拿：
/// 备份往返测试要写真的图标文件进 icons 目录，而 icons_dir() 是从 APPDATA
/// 派生的 —— 不拿这把锁的话，隔壁测试把 APPDATA 指到临时目录、用完
/// remove_dir_all 一删，这边写文件就「系统找不到指定的路径」。
#[cfg(test)]
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// r96：**跨模块**的测试大锁。
///
/// # 为什么 ENV_LOCK 不够
///
/// `ENV_LOCK` 只保护"**正在改** APPDATA"的那一小段。而 `load_from` /
/// `save_to` / `data_dir()` 是在**读**它 —— 改和读不在同一时刻发生，
/// 并发下 A 测试已改完、B 测试正在读，照样串味。
///
/// 实测（150 遍里第 1 遍就复现）：
///   `auto_backup_gate_skips_when_only_volatile_keys_changed`
///   panicked at main.rs:15633 —— 它断言"改了 bar_list 就该判成有改动"，
///   而 `changed_since_last_backup` 读到的 config_view 是隔壁 config 测试
///   摆进去的那份（bar_list 恰好也含 Google），实质指纹撞车。
///
/// 于是 config.rs 自己那一摞测试 + main.rs 里用 `AppDataTemp` 的测试，
/// **全部共用这一把**。
///
/// # 用法
///
/// ```ignore
/// let _serial = config::test_lock();
/// ```
///
/// ⚠ 守卫要活到测试结束：绑到 `_serial` 这种下划线变量上，
/// 别写 `let _ = ...`（那会当场 drop、锁立刻释放，还一句警告都没有）。
#[cfg(test)]
static CFG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 拿 [`CFG_TEST_LOCK`]；锁被 poison 了也照拿（一条测试炸了不该连累其余）。
#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    CFG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ══════════════════════════════════════════════════════════════════
     * r96：**所有**碰 config 文件的测试共用一把进程级互斥锁
     *
     * # 为什么要全员串行
     *
     * 之前只有个别测试拿 `ENV_LOCK`（改 APPDATA 的那两条），其余并行跑。
     * 而 `load_from` / `save_to` 都**间接依赖**进程级环境：
     *   · `load_backup_of` 最后会退到 `backup_dir_of(&Config::default())`
     *     → `data_dir()` → **读 `%APPDATA%`**；
     *   · `save_to` 的滚动备份落点同样是它。
     *
     * 于是并发下会出现这样的交叉：A 测试把 APPDATA 换成自己的 TempDir，
     * B 测试正在"写坏主文件→期望从**自己的**目录回退"，却读到 A 目录里
     * 的备份。实测症状（100 遍里第 15 遍）：
     *   `config_survives_restart_and_corruption` 断言 `delay_ms == 4321`，
     *   实际拿到 **2** —— 那是隔壁测试 `save_never_leaves_a_half_written_config`
     *   循环里的第 3 次保存值。
     *
     * # 为什么不用"每条测试自己改 APPDATA"
     *
     * 那是把进程级状态当局部变量用：cargo test 默认多线程并行，
     * set_var 的**窗口期**没法消除（哪怕各自 restore，中间那一瞬就是竞态）。
     * 真正隔离只能靠进程级的串行。
     *
     * # 代价
     *
     * 这些测试全部串行：config 模块 100+ 条子里大头是纯内存计算，
     * 真碰盘的是少数几条，串行后总时长从 ~0.6s 涨到 ~1.5s —— 可接受。
     *
     * ⚠️ 实体（`CFG_TEST_LOCK`）放在**模块级**而不是这里，另配 `pub fn
     *   test_lock()`：main.rs 那摞用 `AppDataTemp` 的测试同样在改 / 读
     *   `%APPDATA%`，必须拿**同一把**。只在各自模块内互斥的话，跨模块
     *   照样互相踩（实测见 `test_lock` 的注释）。
     * ══════════════════════════════════════════════════════════════════ */

    /// 拿进程级大锁。锁被 poison 了也照拿（一条测试炸了不该连累其余）。
    ///
    /// 实体在模块级（`CFG_TEST_LOCK`，另有 `pub fn test_lock()`）——
    /// 因为 main.rs 的测试（用 `AppDataTemp` 改 `%APPDATA%`）也要拿**同一把**。
    ///
    /// `pub(super)`：隔壁 `mod sanitize_tests` 复用同一把（两把锁挡不住
    /// 同一份进程级状态）。
    pub(super) fn big_lock() -> std::sync::MutexGuard<'static, ()> {
        test_lock()
    }

    /// `big_lock` 的**哨兵变量名**（只为说明调用点该用什么名字）。
    ///
    /// 统一 `let _serial = big_lock();` 而不是 `let _g = ...`：
    /// 那几条用 `tmp_file()` 的测试已经有一个 `let (f, _g) = tmp_file(...)`
    /// （`_g` 是临时候目录的保活句柄）。两处都叫 `_g` 会撞名 ——
    /// 锁的句柄当场被覆盖、**锁就释放了**，等于没加隔离，
    /// 而编译器一句警告都没有（`_` 前缀允许重定义）。
    /// 调 `set_setting` 的 main.rs 测试那边统一用 `_serial`，这里保持同一个名字。
    #[allow(dead_code)]
    const SERIAL_GUARD: () = ();

    /// 一个临时目录，测试结束自动删。
    ///
    /// 刻意**不用**改 `APPDATA` 的全局环境变量来隔离 —— 那是进程级的，
    /// 并行跑测试时会互相踩（A 的测试跑到一半 B 改了 APPDATA）。
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "qs-cfg-{}-{}",
                tag,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn file(&self) -> std::path::PathBuf {
            self.0.join("config.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 把 `data_dir()` 临时指到某个目录（v1.4.0 起走 `QS_DATA_DIR`）。
    ///
    /// 为什么不再用 `APPDATA`：便携模式的数据目录在 exe 旁边，`data_dir()`
    /// 只有在 `QS_DATA_DIR` 没设、且**不是测试二进制**时才会去探便携目录。
    /// 测试想模拟"真实数据目录"，唯一正确的方式就是设 `QS_DATA_DIR`。
    struct DataDirEnv {
        old: Option<String>,
    }

    impl DataDirEnv {
        fn new(dir: &std::path::Path) -> Self {
            let old = std::env::var("QS_DATA_DIR").ok();
            std::env::set_var("QS_DATA_DIR", dir);
            Self { old }
        }
    }

    impl Drop for DataDirEnv {
        fn drop(&mut self) {
            match &self.old {
                Some(v) => std::env::set_var("QS_DATA_DIR", v),
                None => std::env::remove_var("QS_DATA_DIR"),
            }
        }
    }

    // ENV_LOCK 声明在模块级（文件上方），main.rs 的测试拿的是同一把 ——
    // 那边也要写 icons 目录，必须和这里改 APPDATA 的测试串行。

    /* ══════════════════════════════════════════════════════════════════
     * r99：`load_from` 归一之后**只能写回自己那个 path**
     *
     * 2026-10-22 的真实事故：`cargo test` 跑完，用户真实的 `config.json`
     * 变成了一份 `delay_ms = 4321` 的测试配置（自定义引擎/收藏/图标/
     * OCR+WebDAV 密钥全没了，连 `backup.key` 都被删了）。
     *
     * 链条就是这一行：`load_from(临时文件)` → sanitize 改了东西 →
     * `save()`（写**全局** config_path()）→ 真实配置被测试数据覆盖。
     * 这条测试把它钉死。
     * ══════════════════════════════════════════════════════════════════ */
    /* ── v1.5.9：凭据计数 ──────────────────────────────────────────────
     *
     * 这个数字会出现在「备份」页（"当前配置里有 N 项凭据会跟着备份走"）。
     * 数错了不会崩，但会让人怀疑自己的 Key 没被备份 —— 所以口径要钉住：
     * **只数填了值的**，空白不算；百度那套老字段与 map 不重复计。 */
    #[test]
    fn 凭据只数填了值的项() {
        let mut c = Config::default();
        assert_eq!(secret_count(&c), 0, "默认配置一项都没有");

        c.github_token = "ghp_x".into();
        assert_eq!(secret_count(&c), 1, "令牌算一项");

        c.ocr_key = "AKID".into();
        c.webdav_pass = "app-pw".into();
        assert_eq!(secret_count(&c), 3);

        // 纯空白不算填了 —— sanitize 之后仍可能是空白，别把它数进去
        c.github_token = "   ".into();
        assert_eq!(secret_count(&c), 2);

        // 多引擎那两组按**条目**数，空条目跳过
        c.ocr_keys.insert("baidu".into(), "k1".into());
        c.ocr_keys.insert("ali".into(), "  ".into());
        c.ocr_secrets.insert("baidu".into(), "s1".into());
        // 此时：webdav_pass(1) + k1(1) + s1(1) = 3
        // ocr_key 是百度老字段，map 里已有 baidu → 不重复计
        assert_eq!(secret_count(&c), 3, "webdav_pass + baidu 的 k1/s1，老字段不重复计");
    }

    /// 百度老字段与 map 不能各算一次（同一份 Key 的两种存法）。
    #[test]
    fn 百度老字段与map不重复计() {
        let mut c = Config::default();
        c.ocr_key = "old-key".into();
        c.ocr_secret = "old-secret".into();
        assert_eq!(secret_count(&c), 2, "只有老字段时按两项算");

        // 迁移到 map 之后，老字段还在（读取会回退），但只能算一次
        c.ocr_keys.insert("baidu".into(), "old-key".into());
        c.ocr_secrets.insert("baidu".into(), "old-secret".into());
        assert_eq!(secret_count(&c), 2, "map 里有 baidu 时老字段不再计");
    }

    #[test]
    fn load_from_never_writes_the_global_config_path() {
        let _serial = big_lock();
        let _env_lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // 假装"真实数据目录"就是这个空目录
        let fake = TempDir::new("global");
        let _dir_env = DataDirEnv::new(&fake.0);

        // 摆一份"启动归一会改动"的配置：`CHN` 是百度不认的旧枚举，会归一成 CHN_ENG
        let t = TempDir::new("inject");
        let mut c = Config::default();
        c.ocr_lang = "CHN".to_string();
        save_to(&t.file(), &c);
        let back = load_from(&t.file());
        assert_eq!(back.ocr_lang, "CHN_ENG", "归一应当生效");
        assert!(
            !config_path().exists(),
            "load_from 把测试配置写进了真实数据目录：{}",
            config_path().display()
        );
    }

    /* ══════════════════════════════════════════════════════════════════
     * v1.4.0：磁盘上**不许有明文用户数据**
     *
     * 用户要求（原话）：「仔细核查一下，我们这个软件的所有的本地数据都要加密，
     *   就不能够以任何明文的方式来显示任何的用户数据」。
     *
     * 这三条测试就是那句话的可执行版本：主文件、备份、backup.key 三处
     * 落盘之后，文件内容里都不能出现任何一条用户数据。
     * ══════════════════════════════════════════════════════════════════ */

    /// 有备份密码时：主文件是密码信封，磁盘上看不到 OCR key / 密码 / 字段名。
    #[test]
    fn config_on_disk_is_encrypted_with_password() {
        let _serial = big_lock();
        let _env_lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = TempDir::new("enc1");
        let _dir_env = DataDirEnv::new(&t.0);

        let mut c = Config::default();
        c.backup_password = "pw-秘密-123".into();
        c.ocr_key = "AKID-秘密-密钥".into();
        save_to(&t.file(), &c);

        let raw = std::fs::read_to_string(t.file()).unwrap();
        assert_eq!(
            crate::crypto::envelope_version(&raw),
            Some(1),
            "有密码时主文件必须是密码信封"
        );
        for secret in ["AKID-秘密-密钥", "pw-秘密-123", "ocr_key", "backup_password"] {
            assert!(!raw.contains(secret), "磁盘上出现了明文：{secret}");
        }
        // 而且必须能原样读回来
        let back = load_from(&t.file());
        assert_eq!(back.ocr_key, "AKID-秘密-密钥");
        assert_eq!(back.backup_password, "pw-秘密-123");
    }

    /// 没有备份密码时：退回 DPAPI 信封，**依然**看不到明文。
    #[test]
    fn config_on_disk_is_encrypted_without_password() {
        let _serial = big_lock();
        let _env_lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = TempDir::new("enc2");
        let _dir_env = DataDirEnv::new(&t.0);

        let mut c = Config::default();
        c.webdav_user = "我的坚果云账号".into();
        c.ocr_key = "AKID-无密码也要密".into();
        save_to(&t.file(), &c);

        let raw = std::fs::read_to_string(t.file()).unwrap();
        assert_eq!(
            crate::crypto::envelope_version(&raw),
            Some(2),
            "没密码时应当退回 DPAPI 信封"
        );
        for secret in ["AKID-无密码也要密", "我的坚果云账号", "webdav_user"] {
            assert!(!raw.contains(secret), "磁盘上出现了明文：{secret}");
        }
        let back = load_from(&t.file());
        assert_eq!(back.ocr_key, "AKID-无密码也要密");
        assert_eq!(back.webdav_user, "我的坚果云账号");
    }

    /// `backup.key` 里也不能有明文密码（以前它是纯文本一行）。
    #[test]
    fn backup_key_is_not_plaintext() {
        let _serial = big_lock();
        let _env_lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = TempDir::new("bkey");
        let _dir_env = DataDirEnv::new(&t.0);

        stash_backup_password("我的密码-abc123");
        let raw = std::fs::read_to_string(backup_key_path()).unwrap();
        assert!(!raw.contains("我的密码-abc123"), "backup.key 里出现了明文密码");
        assert!(crate::crypto::looks_dpapi(&raw), "backup.key 应当是 DPAPI 信封");
        assert_eq!(load_backup_password(), "我的密码-abc123");

        // 清空密码 = 删掉存档（不能留个空文件让人误会）
        stash_backup_password("");
        assert!(!backup_key_path().exists());
    }

    /// 迁移时"哪些文件算配置族"的判据（搬走并重新封装的那些）。
    #[test]
    fn migration_classifies_config_files() {
        for n in [
            "config.json",
            "config(2026-10-22 10-00-00).QuickSearch",
            "config.auto(2026-10-22 10-00-00).QuickSearch",
            "config.before-webdav(2026-10-22 10-00-00).QuickSearch",
            "config.broken(2026-10-22 10-00-00).QuickSearch",
            "config.wiped(2026-10-21 07-29-56).QuickSearch",
            "config.json.bad-1",
        ] {
            assert!(is_config_family(n), "{n} 应当算配置族");
        }
        for n in ["log.txt", "log.on", "last-backup.txt", "icons", "backup.key"] {
            assert!(!is_config_family(n), "{n} 不该算配置族");
        }
    }

    /// 便携目录的名字必须和用户说的一字不差（这是他自己要去文件夹里找的）。
    #[test]
    fn portable_dir_names_match_the_request() {
        assert_eq!(DATA_DIR_NAME, "Quick search data");
        assert_eq!(BACKUP_DIR_NAME, "QuickSearch back");
        assert!(portable_data_dir().ends_with(DATA_DIR_NAME));
        assert!(portable_backup_dir().ends_with(BACKUP_DIR_NAME));
        assert_eq!(
            portable_data_dir().parent(),
            portable_backup_dir().parent(),
            "数据目录和备份目录必须都在 exe 旁边"
        );
    }

    /* ══════════════════════════════════════════════════════════════════
     * r94：锁住"恢复最新 + 只在疑似被清空时才回退"这条口径
     *
     * 用户的硬要求（原话）：「备份肯定是要恢复最新的呀，这个逻辑就不能变，
     *   但要多一个检测环节，如果确实是手动操作，从而使得备份内容减少，
     *   那这应该就是正常的，而不是说一刀切看什么最多恢复什么。」
     *
     * 所以最容易改坏的两件事必须由测试钉住：
     *   ① 一份**纯默认**配置 → 判为"被清空"（异常，要救）；
     *   ② 一份**用户手动删减过**的配置 → 绝不能判成"被清空"（正常，照用）。
     * ══════════════════════════════════════════════════════════════════ */

    #[test]
    fn default_config_looks_wiped() {
        // 全新安装 = 全是默认值 = 零痕迹 → 必须判成"被清空"。
        // 这就是事故现场那一份（默认配置把用户数据盖掉后又存进了备份）。
        assert!(
            looks_wiped(&Config::default()),
            "纯默认配置必须被判定为「疑似被清空」"
        );
    }

    #[test]
    fn manual_trimming_is_not_wipe() {
        // 场景一：只留一个引擎，但留着它的自定义图标 —— 这是人手改的。
        let mut c = Config::default();
        c.overrides
            .insert("百度".into(), "baidu-1.png".into());
        assert!(!looks_wiped(&c), "有图标覆盖痕迹 → 不是被清空");

        // 场景二：只改过横条排列（不动引擎库 / 收藏 / 密钥）—— 也是人手改的。
        let mut c = Config::default();
        c.bar_list = vec!["必应".to_string(), "知乎".to_string()];
        assert!(!looks_wiped(&c), "横条被改过 → 不是被清空");

        // 场景三：清空了收藏，但还留着用过的引擎记录。
        let mut c = Config::default();
        c.recent_engines = vec!["Google".to_string()];
        assert!(!looks_wiped(&c), "有最近使用记录 → 不是被清空");
    }

    fn marked() -> Config {
        marked_in("")
    }

    /// 备份目录指到 dir 的 marked 配置（dir 空 = 数据目录）。
    ///
    /// 测试用它把滚动备份关进 TempDir，**不碰真实 %APPDATA%**：否则
    /// 「截断恢复」恢复出的可能是隔壁测试（甚至真机配置）写在数据目录里
    /// 的那份备份，断言对不上还查不出原因。
    fn marked_in(dir: &str) -> Config {
        let mut c = Config::default();
        c.backup_dir = dir.to_string();
        c.delay_ms = 4321;
        c.icon_size = 41;
        c.theme = "dark".into();
        c.bar_list = vec!["百度".into(), "Google".into()];
        // ⚠ 用**根地址**：sanitize 读回时会把"根地址 + 软件子目录"还原成根地址，
        //   marked() 里若存带子目录的形态，round-trip 对比就会差一截。
        c.webdav_url = "https://dav.jianguoyun.com/dav/".into();
        c
    }

    /// **这是「重启后配置还在」这条需求的直接验证。**
    ///
    /// 旧实现是 `unwrap_or_default()`：文件只要解析不了就静默换成默认配置。
    /// 表现就是用户重启电脑后看到设置全没了、横条回到出厂，而且**没有任何提示**。
    /// 这里逐个破坏文件，确认配置都还在。
    #[test]
    fn config_survives_restart_and_corruption() {
        let _serial = big_lock();
        let t = TempDir::new("restart");
        let f = t.file();
        // 备份关进 TempDir：滚动备份 config(...).QuickSearch 就落在 f 旁边，
        // 恢复路径走「同目录滚动备份」这条，跟真机行为一致且完全隔离。
        let mc = marked_in(&t.0.to_string_lossy());

        // 第一次运行：存一份有辨识度的配置
        save_to(&f, &mc);
        assert!(f.exists(), "save_to 没把文件写出来");

        // 重启 1：正常读回
        let c1 = load_from(&f);
        assert_eq!(c1.delay_ms, 4321);
        assert_eq!(c1.icon_size, 41);
        assert_eq!(c1.theme, "dark");
        assert_eq!(c1.bar_list, vec!["百度", "Google"]);

        // 重启 2：文件被**截断**（写到一半被杀 / 断电，最常见的损坏形态）
        save_to(&f, &mc); // 先确保滚动备份有一份好的
        std::fs::write(&f, r#"{"delay_ms": 43"#).unwrap();
        let c2 = load_from(&f);
        assert_eq!(
            c2.delay_ms, 4321,
            "截断的配置应回退到滚动备份，而不是默认的 0"
        );
        assert_eq!(c2.icon_size, 41, "整份配置都要回来，不能只回退一部分");

        // 重启 3：文件是空文件
        std::fs::write(&f, "").unwrap();
        let c3 = load_from(&f);
        assert_eq!(c3.delay_ms, 4321, "空文件也要能回退");

        // 重启 4：文件里塞了不是 JSON 的东西
        std::fs::write(&f, "这不是 JSON").unwrap();
        let c4 = load_from(&f);
        assert_eq!(c4.delay_ms, 4321);

        // 坏内容必须留档，不能被下一次保存覆盖掉
        let bad: Vec<_> = std::fs::read_dir(&t.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name().to_string_lossy().contains(".bad-")
            })
            .collect();
        assert!(!bad.is_empty(), "坏配置应该另存一份留档，用户还能手工捞");
    }

    /// 坏配置**且**没有备份时，才允许退到默认 —— 但坏内容仍要留档。
    ///
    /// ⚠ 必须把 APPDATA 整个指到一个空临时目录：真实数据目录里躺着的是
    /// **真机/隔壁测试**留下的合法滚动备份，load_backup_of 会拿它恢复 ——
    /// 那不是本测试要验的「无备份」场景。set_var 是进程级的，所以这里要拿
    /// **两把**锁：`big_lock` 挡住其它读 data_dir() 的 config 测试，
    /// `ENV_LOCK` 是给 main.rs 那侧（写 icons 目录）用的旧约定，一并占住。
    #[test]
    fn falls_back_to_default_only_when_there_is_no_backup() {
        let _serial = big_lock();
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = TempDir::new("nobak");
        let f = t.file();
        let _dir_env = DataDirEnv::new(&t.0);
        std::fs::write(&f, "{ this is not json").unwrap();
        let c = load_from(&f);
        assert_eq!(c.delay_ms, Config::default().delay_ms);
        let kept = std::fs::read_dir(&t.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".bad-"));
        assert!(kept, "即使没备份，坏内容也要留档");
    }

    /// 保存必须**原子**：任何时刻磁盘上的正式文件都是完整的一份 JSON。
    /// 直接覆盖写的话，写到一半崩溃就留下半截 → 下次启动静默归零。
    #[test]
    fn save_never_leaves_a_half_written_config() {
        let _serial = big_lock();
        let t = TempDir::new("atomic");
        let f = t.file();
        for i in 0..20u32 {
            let mut c = marked();
            c.delay_ms = i;
            save_to(&f, &c);
            // 每一次保存之后，正式文件都必须能原样解析
            let back = load_from(&f);
            assert_eq!(back.delay_ms, i, "第 {i} 次保存后配置读不回来");
            // 且不能留下 .tmp（换名成功的话它应该已经不在了）
            assert!(
                !f.with_extension("json.tmp").exists(),
                "临时文件没被清掉，说明 rename 走了降级路径"
            );
        }
    }

    /// WebDAV 地址的口径（用户拍板）：**配置里只存用户填的根地址**，
    /// 软件自己的子目录（QuickSearch/）不写进配置，发请求时才补。
    /// 所以老配置里就算带着子目录，读回来也要被还原成根地址。
    #[test]
    fn webdav_url_stores_bare_root_only() {
        let _serial = big_lock();
        let t = TempDir::new("dav");
        let f = t.file();
        // 用户只填根地址 → 原样保留
        let mut c = marked();
        c.webdav_url = "https://dav.jianguoyun.com/dav/".into();
        save_to(&f, &c);
        assert_eq!(load_from(&f).webdav_url, "https://dav.jianguoyun.com/dav/");

        // 老配置带着子目录 → 读回来被还原成根地址（子目录发请求时才补）
        let mut c2 = marked();
        c2.webdav_url = "https://dav.jianguoyun.com/dav/QuickSearch/".into();
        save_to(&f, &c2);
        assert_eq!(load_from(&f).webdav_url, "https://dav.jianguoyun.com/dav/");
    }

    /// OCR 窗口尺寸：用户拖过就记住，重启后还在（「记忆窗口大小」这条需求）。
    #[test]
    fn ocr_window_size_is_remembered() {
        let _serial = big_lock();
        let t = TempDir::new("ocrwin");
        let f = t.file();
        let mut c = Config::default();
        c.ocr_win_w = 1024;
        c.ocr_win_h = 800;
        save_to(&f, &c);
        let back = load_from(&f);
        assert_eq!((back.ocr_win_w, back.ocr_win_h), (1024, 800));
        assert_eq!(ocr_window_size(&back), (1024.0, 800.0));
    }

    /// 没记录过（0）或值不合理时，必须回落到默认尺寸 ——
    /// 不能把 0 直接当窗口尺寸交给系统，那样窗口会小到看不见。
    #[test]
    fn ocr_window_size_falls_back_when_absent_or_absurd() {
        let _serial = big_lock();
        let mut c = Config::default();
        assert_eq!(
            ocr_window_size(&c),
            (OCR_WIN_DEFAULT_W, OCR_WIN_DEFAULT_H),
            "没记录过应当用默认尺寸"
        );

        for (w, h) in [(0u32, 0u32), (10, 10), (99999, 99999), (800, 0)] {
            c.ocr_win_w = w;
            c.ocr_win_h = h;
            assert_eq!(
                ocr_window_size(&c),
                (OCR_WIN_DEFAULT_W, OCR_WIN_DEFAULT_H),
                "尺寸 {w}x{h} 不合理，应当回落到默认"
            );
        }

        // 边界值要算「合理」，别把用户刚好拖到最小/最大的情况也当垃圾丢掉
        c.ocr_win_w = OCR_WIN_MIN_W as u32;
        c.ocr_win_h = OCR_WIN_MIN_H as u32;
        assert_eq!(ocr_window_size(&c), (OCR_WIN_MIN_W, OCR_WIN_MIN_H));
    }

    /// 「统一图标大小」默认必须是**开**的 —— 用户报的就是图标大小参差不齐，
    /// 默认关掉等于什么都没做。而且它要能正常存取。
    #[test]
    fn unify_icons_defaults_on_and_persists() {
        let _serial = big_lock();
        assert!(Config::default().unify_icons, "默认应当是开启");

        let t = TempDir::new("unify");
        let f = t.file();
        let mut c = Config::default();
        c.unify_icons = false;
        save_to(&f, &c);
        assert!(!load_from(&f).unify_icons, "关掉之后要能读回来");
    }
}

#[cfg(test)]
mod sanitize_tests {
    use super::*;

    /* ⚠ r96：这一摞测试也碰磁盘（save_to / load_from → 间接读 `%APPDATA%`），
     * 所以要和隔壁 `mod tests` 用**同一把**锁。
     *
     * 写成 `super::tests::big_lock()` 而不是自己再 new 一把 Mutex ——
     * 两把锁挡不住同一份进程级状态（`%APPDATA%` 只有一个）。 */
    fn big_lock() -> std::sync::MutexGuard<'static, ()> {
        tests::big_lock()
    }

    fn tmp_file(tag: &str) -> (std::path::PathBuf, TempDirLike) {
        let dir = std::env::temp_dir().join(format!(
            "qs-san-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, "{}").unwrap();
        (f, TempDirLike(dir))
    }

    struct TempDirLike(std::path::PathBuf);
    impl Drop for TempDirLike {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 旧版本设置页存过 `CHN`（「纯中文」），但百度**没有**这个枚举值。
    ///
    /// 只在恢复云端备份那条路上归一是不够的：本地 config.json 同样存着它。
    /// 不归一的后果是设置页两个语言按钮一个都不亮（看着像设置丢了），
    /// 而识别请求又一直返回参数错误 —— 两头都对不上，极难自查。
    #[test]
    fn legacy_chinese_only_is_normalized_on_load() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("lang");
        std::fs::write(&f, r#"{"ocr_lang":"CHN"}"#).unwrap();
        assert_eq!(load_from(&f).ocr_lang, "CHN_ENG");

        // 备份里存着也要归一
        let (f2, _g2) = tmp_file("lang2");
        std::fs::write(&f2, "{ broken").unwrap();
        std::fs::write(f2.with_extension("json.bak"), r#"{"ocr_lang":"CHN"}"#).unwrap();
        assert_eq!(load_from(&f2).ocr_lang, "CHN_ENG");

        // 合法值不能被动到
        let (f3, _g3) = tmp_file("lang3");
        std::fs::write(&f3, r#"{"ocr_lang":"ENG"}"#).unwrap();
        assert_eq!(load_from(&f3).ocr_lang, "ENG");
    }

    /// r47：旧的「双引擎并行识别」开关 → 新的「同时识别」名单。
    ///
    /// 老语义是**写死**的「本地 + 设置里配的那家」(`parallel_engines()`)，所以开关
    /// 为 true 的用户必须迁成 `ocr_multi = ["windows"]`（"额外同时跑本地"）——
    /// 升级前后的识别行为逐字不变，不想要就在新界面里取消勾选。
    ///
    /// ⚠ 开关为 false / 缺字段的用户**绝不能**被塞上本地：那正是用户 r47 报的 bug
    ///   （关掉并行后结果窗里仍冒出一段"本地识别"）。
    #[test]
    fn legacy_parallel_switch_migrates_to_multi_list() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("multi");
        std::fs::write(&f, r#"{"ocr_engine":"siliconflow","ocr_parallel":true}"#).unwrap();
        let c = load_from(&f);
        assert_eq!(c.ocr_multi, vec!["windows"], "老开关该迁成「额外跑本地」");
        assert!(
            !c.ocr_parallel,
            "迁完老开关要落回 false —— 否则每次读配置都会再迁一遍"
        );

        // 幂等：把迁移结果原样写回去再读一次，名单不变、也不重复加
        let once = serde_json::to_string(&c).unwrap();
        std::fs::write(&f, &once).unwrap();
        assert_eq!(load_from(&f).ocr_multi, vec!["windows"]);
        assert_eq!(load_from(&f).ocr_multi.len(), 1, "第二次读不该再迁一遍");

        // 开关 false / 压根没这个键 → 名单保持空
        std::fs::write(&f, r#"{"ocr_engine":"siliconflow","ocr_parallel":false}"#).unwrap();
        assert!(
            load_from(&f).ocr_multi.is_empty(),
            "开关关着却塞进了本地 —— 用户报的就是这个"
        );
        std::fs::write(&f, r#"{"ocr_engine":"siliconflow"}"#).unwrap();
        assert!(load_from(&f).ocr_multi.is_empty());
    }

    /// r47：名单里的脏数据在**读配置**时就清掉 —— 不认识的 id / 默认引擎自己 /
    /// 重复项。这些都是"手改过文件 / 备份来自装了更多引擎的版本"会出现的。
    #[test]
    fn multi_list_is_sanitized_on_load() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("multidirty");
        std::fs::write(
            &f,
            r#"{"ocr_engine":"baidu","ocr_multi":["baidu","没这家","windows","windows"]}"#,
        )
        .unwrap();
        assert_eq!(
            load_from(&f).ocr_multi,
            vec!["windows"],
            "默认引擎自己 / 重复 / 不认识的都该清掉"
        );
    }

    /* ---------- v1.5.16：翻译多引擎 ---------- */

    /// 翻译计划 = 默认引擎 + 同时翻译名单，按**注册表顺序**排（翻译窗里几家
    /// 文本框的左右顺序由此决定），去重；脏 id 一律不计入。
    #[test]
    fn trans_plan_orders_by_registry_and_dedups() {
        let mut c = Config::default();
        c.trans_engine = "deepseek".into();
        c.trans_multi = vec!["moonshot".into(), "没这家".into(), "deepseek".into()];
        // 注册表顺序：siliconflow, zhipu, dashscope, deepseek, moonshot, …
        assert_eq!(
            super::trans_plan(&c),
            vec!["deepseek", "moonshot"],
            "默认引擎在前，额外的那家按注册表顺序跟上"
        );
        // 默认引擎无效（sanitize 会修，但命令路径要能自己兜住）——
        // 此时计划里只剩 multi 里合法的那些，绝不含无效 id
        c.trans_engine = "没这家".into();
        assert_eq!(
            super::trans_plan(&c),
            vec!["deepseek", "moonshot"],
            "默认引擎无效时不该把无效 id 塞进计划"
        );
    }

    /// 各家凭据分 map 存；没填的键读出来是空串（缺省值由注册表补，见
    /// `trans_engines::Creds::model_for`）。
    #[test]
    fn trans_creds_reads_per_engine_maps() {
        let mut c = Config::default();
        c.trans_keys.insert("siliconflow".into(), "sk-x".into());
        c.trans_models.insert("siliconflow".into(), "my-chat".into());
        let cr = super::trans_creds(&c, "siliconflow");
        assert_eq!(cr.key, "sk-x");
        assert_eq!(cr.model, "my-chat");
        assert_eq!(cr.base, "", "没填 base 就是空串，用的时候落注册表预置值");
        // 没配过的家：全空
        let none = super::trans_creds(&c, "zhipu");
        assert!(none.key.is_empty() && none.model.is_empty() && none.base.is_empty());
    }

    /// 老牌那几家的**副凭据**（百度的密钥 / 有道的应用密钥）也分 map 存，
    /// 且和主凭据一样是"没填就是空串"。
    #[test]
    fn trans_secrets_reads_per_engine_maps() {
        let mut c = Config::default();
        c.trans_keys.insert("baidu".into(), "APP123".into());
        c.trans_secrets.insert("baidu".into(), "SECRET".into());
        let cr = super::trans_creds(&c, "baidu");
        assert_eq!(cr.key, "APP123");
        assert_eq!(cr.secret, "SECRET");
        // 谷歌只要一个 Key，没有副凭据
        c.trans_keys.insert("google".into(), "GK".into());
        let g = super::trans_creds(&c, "google");
        assert_eq!(g.key, "GK");
        assert!(g.secret.is_empty());
    }

    /// 读配置时归一：默认引擎 / 同时翻译名单里的脏数据都要清（口径同 OCR）。
    #[test]
    fn trans_lists_are_sanitized_on_load() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("transdirty");
        std::fs::write(
            &f,
            r#"{"trans_engine":"没这家","trans_multi":["没这家","siliconflow","siliconflow"]}"#,
        )
        .unwrap();
        let c = load_from(&f);
        assert_eq!(c.trans_engine, "siliconflow", "不认识的默认引擎落回硅基流动");
        assert_eq!(
            c.trans_multi,
            Vec::<String>::new(),
            "名单里：不认识的清掉、默认引擎自己清掉、重复清掉"
        );
        // 合法值原样保留
        let (f2, _g2) = tmp_file("transok");
        std::fs::write(
            &f2,
            r#"{"trans_engine":"deepseek","trans_multi":["zhipu","moonshot"]}"#,
        )
        .unwrap();
        let c2 = load_from(&f2);
        assert_eq!(c2.trans_engine, "deepseek");
        assert_eq!(c2.trans_multi, vec!["zhipu", "moonshot"]);
    }

    /// 配置文件里完全没有 ocr_accurate 这个键时，必须落到「标准版」。
    ///
    /// 默认高精度是有代价的：那是要付费的接口，没开通的账号一识别就失败，
    /// 而错误信息看着跟「Key 不对」一样。老配置里可能压根没这个字段。
    #[test]
    fn missing_ocr_accuracy_defaults_to_free_tier() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("acc");
        std::fs::write(&f, "{}").unwrap();
        assert!(
            !load_from(&f).ocr_accurate,
            "缺字段时应默认标准版（免费额度），而不是付费的高精度版"
        );
        // 用户自己存了 true 要尊重
        let (f2, _g2) = tmp_file("acc2");
        std::fs::write(&f2, r#"{"ocr_accurate":true}"#).unwrap();
        assert!(load_from(&f2).ocr_accurate);
    }

    /// 收藏内容的 html（带格式）字段：老配置没有它要能读（默认空 = 纯文本
    /// 老路），存了要能原样读回（颜色不能丢）。
    ///
    /// 这条对应「收藏夹文本框文字颜色跟着文本的格式走」：html 是颜色的
    /// 载体，round-trip 丢一个字节用户看到的都是褪色的收藏。
    #[test]
    fn fav_item_html_survives_round_trip_and_defaults_for_legacy() {
        let _serial = big_lock();
        // 老数据：只有 text，没有 html
        let (f, _g) = tmp_file("favhtml");
        std::fs::write(
            &f,
            r#"{"favorites":[{"id":"g1","name":"目录","items":[{"id":"i1","kind":"text","text":"纯文本老数据"}]}]}"#,
        )
        .unwrap();
        let c = load_from(&f);
        let it = find_fav_item(&c.favorites, "i1").expect("条目要能读出来");
        assert_eq!(it.text, "纯文本老数据");
        assert!(it.html.is_empty(), "老数据没有 html 字段，默认必须是空串（走纯文本老路）");

        // 新数据：html 原样读回
        let html = r#"<span style="color:#c00">红字</span>"#;
        let (f2, _g2) = tmp_file("favhtml2");
        let json = format!(
            r#"{{"favorites":[{{"id":"g1","name":"目录","items":[{{"id":"i1","kind":"text","text":"红字","html":{}}}]}}]}}"#,
            serde_json::to_string(html).unwrap()
        );
        std::fs::write(&f2, json).unwrap();
        let c2 = load_from(&f2);
        let it2 = find_fav_item(&c2.favorites, "i1").expect("条目要能读出来");
        assert_eq!(it2.html, html, "带格式内容 round-trip 后一个字节都不能差");
    }

    /// 删掉收藏目录之后，横条上那个 `@fav:<id>` 哨兵必须一起消失。
    ///
    /// 用户报过这个 bug：目录删了，横条里还留着它的位置，渲染出来是一串
    /// 乱码（哨兵名被当引擎名画在格子里）。这里覆盖三层：
    /// - 指向**存活**目录（含二级目录 id）的哨兵要保留；
    /// - 指向**已删**目录的哨兵要剪掉，返回值就是剪掉的个数；
    /// - `fav_panel_sizes` 里对应的键也要清掉（`_root` 不是目录，保留）。
    #[test]
    fn dangling_fav_sentinels_are_pruned() {
        let _serial = big_lock();
        let mut c = Config::default();
        c.favorites = vec![FavGroup {
            id: "g1".into(),
            name: "一级".into(),
            icon: String::new(),
            items: vec![],
            children: vec![FavGroup {
                id: "g1c".into(),
                name: "二级".into(),
                icon: String::new(),
                items: vec![],
                children: vec![],
            }],
        }];
        c.bar_list = vec![
            "百度".into(),
            format!("{}g1", FAV_PREFIX),   // 存活的一级目录 → 留
            format!("{}g1c", FAV_PREFIX),  // 存活的二级目录 → 留
            format!("{}gone", FAV_PREFIX), // 已删目录 → 剪
            "百度翻译".into(),
        ];
        c.fav_panel_sizes
            .insert(format!("{}gone", FAV_PREFIX), vec![300.0, 200.0]);
        c.fav_panel_sizes
            .insert(format!("{}g1", FAV_PREFIX), vec![400.0, 260.0]);
        c.fav_panel_sizes.insert("_root".into(), vec![520.0, 340.0]);

        let pruned = prune_dangling_fav_sentinels(&mut c);
        assert_eq!(pruned, 1, "只该剪掉指向已删目录的那 1 个哨兵");

        assert_eq!(
            c.bar_list,
            vec![
                "百度".to_string(),
                format!("{}g1", FAV_PREFIX),
                format!("{}g1c", FAV_PREFIX),
                "百度翻译".to_string(),
            ],
            "普通引擎与存活目录的哨兵都要原样保留，顺序也不能乱"
        );
        assert!(
            !c.fav_panel_sizes.contains_key(&format!("{}gone", FAV_PREFIX)),
            "已删目录的面板尺寸键是垃圾，必须清掉"
        );
        assert!(
            c.fav_panel_sizes.contains_key(&format!("{}g1", FAV_PREFIX)),
            "存活目录的尺寸要留着"
        );
        assert!(
            c.fav_panel_sizes.contains_key("_root"),
            "`_root` 不算目录，不能被误清"
        );

        // 幂等：再剪一次什么都不该动
        assert_eq!(prune_dangling_fav_sentinels(&mut c), 0);
        // 收藏树整个清空时，所有哨兵都该走
        c.favorites.clear();
        assert_eq!(prune_dangling_fav_sentinels(&mut c), 2);
        assert!(!c.bar_list.iter().any(|n| is_fav_sentinel(n)));
    }

    /// `sanitize()` 是载入配置（本地 / 备份 / 云端恢复 / 导入）的公共入口，
    /// 必须在那一层就把失效哨兵剪掉 —— 否则从这个入口进来的老配置又会带着
    /// 乱码格子出现在横条上。
    #[test]
    fn sanitize_prunes_dangling_sentinels() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("prune");
        let json = format!(
            r#"{{"favorites":[{{"id":"alive","name":"活着"}}],"bar_list":["百度","{}alive","{}dead"],"fav_panel_sizes":{{"{}dead":[1.0,2.0]}}}}"#,
            FAV_PREFIX, FAV_PREFIX, FAV_PREFIX
        );
        std::fs::write(&f, json).unwrap();
        let c = load_from(&f);
        assert_eq!(
            c.bar_list,
            vec!["百度".to_string(), format!("{}alive", FAV_PREFIX)],
            "载入时就该只剩存活的哨兵"
        );
        assert!(
            c.fav_panel_sizes.is_empty(),
            "指向已删目录的尺寸键应在载入时清掉"
        );
    }

    /// r89：横条里**找不到定义**的引擎名要被剪掉，但**各类哨兵一个都不能误剪**。
    ///
    /// 这条守的是用户报的那个 bug：
    /// 「我之前把一个快捷键引擎加入到了横条，但是现在在引擎库里面我找不到那个
    ///   引擎，但横条里有客观存在这个，我通过搜索方式也搜索不出来。」
    ///
    /// 根因是 `bar_list` 里留着一个孤儿名字 —— `custom_engines` 里没有它、
    /// 内置目录里也没有它，于是引擎库（数据源 = 目录 + custom_engines）看不到、
    /// 搜索也搜不到，只有横条上那一格按名字查不到定义。
    ///
    /// ⚠ 另一半是"**不能剪错**"：分隔线、OCR、识图、外部软件、收藏夹这几类哨兵
    ///   都不是引擎名，各有各的归属校验。我第一版漏了 `@fav:`，
    ///   既有测试 `sanitize_prunes_dangling_sentinels` 立刻变红。
    ///   所以这条测试把**全部五种**哨兵都摆进来一起验。
    #[test]
    fn prune_undefined_bar_engines_prunes_orphans_only() {
        let _serial = big_lock();
        let mut c = Config::default();
        // 一个真实的内置引擎（从目录里取，避免写死名字后目录改了测试就挂）
        let builtin = crate::engines::engines()
            .keys()
            .next()
            .cloned()
            .expect("内置引擎目录不该是空的");
        c.custom_engines = vec![CustomEngine {
            name: "我的自定义".into(),
            kind: EngineKind::Hotkey,
            hotkey: "alt+v".into(),
            ..Default::default()
        }];
        c.bar_list = vec![
            builtin.clone(),
            "我的自定义".to_string(),
            "这个引擎没有定义".to_string(),        // ← 孤儿，该剪
            "   ".to_string(),                     // ← 空白名，该剪
            SEP.to_string(),
            BAR_OCR.to_string(),
            BAR_IMG.to_string(),
            format!("{}abc", APP_PREFIX),
            format!("{}xyz", FAV_PREFIX),
        ];

        let pruned = prune_undefined_bar_engines(&mut c);
        assert_eq!(pruned, 2, "只该剪掉孤儿与空白名这两个");

        assert!(c.bar_list.contains(&builtin), "内置引擎要留着");
        assert!(c.bar_list.iter().any(|n| n == "我的自定义"), "自定义引擎要留着");
        for keep in [
            SEP.to_string(),
            BAR_OCR.to_string(),
            BAR_IMG.to_string(),
            format!("{}abc", APP_PREFIX),
            format!("{}xyz", FAV_PREFIX),
        ] {
            assert!(
                c.bar_list.contains(&keep),
                "哨兵「{keep}」被误剪了 —— 会导致横条上那一格无故消失"
            );
        }

        // 幂等：干净的数据再剪一次不该动
        assert_eq!(prune_undefined_bar_engines(&mut c), 0);
    }

    /// 「空壳自定义引擎」的补救：**只认回种类，绝不删、绝不摘横条**。
    ///
    /// 用户原话（2026-10-22）：「这两个是快捷键引擎呀……你不能把它给删掉啊！
    /// 所以没显示是很严重的问题」—— 那次事故的根因是云端备份覆盖（已由
    /// `merge_restored_custom_engines` 堵住），这里只做补救与兜底：
    ///   ① 有按键、种类丢了  → 认回快捷键类（救回来）
    ///   ② 全空              → **原样留着**（定义、横条位置都不动；横条画成
    ///      「待补全」的格子，设置页标红，等用户补）
    ///   ③ 正常的搜索类      → 原样留着
    ///   ④ 快捷键类没按键    → 同 ②
    #[test]
    fn repair_dead_custom_engines_recovers_kind_only() {
        let _serial = big_lock();
        let mut c = Config::default();
        c.custom_engines = vec![
            CustomEngine {
                name: "有按键但种类丢了".into(),
                url: String::new(),
                kind: EngineKind::Search,
                hotkey: "alt+v".into(),
                ..Default::default()
            },
            CustomEngine {
                name: "空壳".into(),
                url: String::new(),
                kind: EngineKind::Search,
                hotkey: String::new(),
                ..Default::default()
            },
            CustomEngine {
                name: "正常的搜索类".into(),
                url: "https://example.com/s?q=%s".into(),
                kind: EngineKind::Search,
                ..Default::default()
            },
            CustomEngine {
                name: "没按键的快捷键".into(),
                kind: EngineKind::Hotkey,
                hotkey: String::new(),
                ..Default::default()
            },
        ];
        let bar_before = vec![
            "空壳".to_string(),
            "没按键的快捷键".to_string(),
            "正常的搜索类".to_string(),
            "有按键但种类丢了".to_string(),
            SEP.to_string(),
        ];
        c.bar_list = bar_before.clone();
        c.recent_engines = vec!["空壳".to_string(), "正常的搜索类".to_string()];

        assert_eq!(repair_dead_custom_engines(&mut c), 1, "只该救回 1 条");

        // 定义一条都不删
        assert_eq!(c.custom_engines.len(), 4, "自定义引擎的定义不能被删掉");

        let rescued = c
            .custom_engines
            .iter()
            .find(|e| e.name == "有按键但种类丢了")
            .expect("救回来的那条还在");
        assert_eq!(rescued.kind, EngineKind::Hotkey, "种类要认回快捷键类");
        assert_eq!(rescued.hotkey, "alt+v", "按键序列要原样留着");
        assert!(rescued.url.is_empty(), "快捷键类的地址保持空串");

        // 横条 / 最近使用**一个字都不许动** —— 用户明确说过不能删
        assert_eq!(c.bar_list, bar_before, "bar_list 不能被这条补救逻辑改动");
        assert!(
            c.recent_engines.iter().any(|n| n == "空壳"),
            "最近使用也不能被摘"
        );

        // 幂等
        assert_eq!(repair_dead_custom_engines(&mut c), 0);
    }

    /// 外部软件地址的三类正当形态都要放行：网页、软件自己的协议、
    /// 本机程序路径。这是用户原话「输入目标软件的 URL」能落地的前提。
    #[test]
    fn app_url_validation_accepts_three_shapes() {
        for ok in [
            "https://example.com",
            "http://example.com/path?q=1",
            "weixin://",
            "obsidian://open?vault=x",
            "steam://run/570",
            "file:///C:/App/app.exe",
            "file://srv/share/app.exe",
            "thunder://abcdef",
        ] {
            assert!(
                validate_app_url(ok).is_ok(),
                "正当地址被误拦：{ok} -> {:?}",
                validate_app_url(ok)
            );
        }
    }

    /// 拦下来的每一种都有真实事故背景：不带协议的点不开、javascript:
    /// 是脚本载体、ms-msdt:/search-ms: 是 Windows 上出了名的漏洞入口、
    /// 空格会把地址截断。错误信息必须是给用户看的中文。
    #[test]
    fn app_url_validation_rejects_bad_shapes() {
        for bad in [
            "",
            "   ",
            "www.example.com",             // 不带协议
            "javascript:alert(1)",
            "JavaScript:alert(1)",         // 大小写也要拦
            "data:text/html,hi",
            "blob:xxx",
            "about:blank",
            "chrome://settings",
            "ms-msdt:/id",
            "search-ms:query=x",
            "https://",                    // 有协议没主机
            "http://",
            "https://exa mple.com",        // 中间带空格
            "1https://example.com",        // 协议名不是字母开头
            "ht tp://example.com",
        ] {
            let e = validate_app_url(bad)
                .err()
                .unwrap_or_else(|| panic!("危险地址被放行了：{bad:?}"));
            assert!(!e.is_empty(), "错误信息不能是空的（要显示给用户）");
            assert!(
                e.chars().any(|c| c as u32 > 127),
                "错误信息应该是中文，用户看得懂：{bad:?} -> {e}"
            );
        }
    }

    /// 超长地址只可能是误粘贴 —— 2048 是上限，差一个字符都不行。
    #[test]
    fn app_url_rejects_overlong() {
        let ok = format!("https://example.com/{}", "a".repeat(2048 - 20));
        assert!(validate_app_url(&ok).is_ok(), "贴着上限的正当地址被误拦");
        let bad = format!("https://example.com/{}", "a".repeat(2048));
        assert!(validate_app_url(&bad).is_err(), "超过上限的地址必须拦下");
    }

    /// `clean_app` 是「新建引擎」表单的服务端关卡：名字（空/太长/撞分隔线
    /// 标记/撞保留名/带控制字符/重名）和地址两头都要拦。
    #[test]
    fn clean_app_rejects_bad_names_and_duplicates() {
        let mut cfg = Config::default();
        cfg.apps = vec![ExternalApp {
            id: "a1".into(),
            name: "微信".into(),
            url: "weixin://".into(),
            kind: "open".into(),
        }];

        // 名字的各种死法
        for bad in ["", "   ", &"x".repeat(25), "a|b", "@ocr", "a\nb"] {
            let e = clean_app(&cfg, bad, "https://example.com", "open", None)
                .err()
                .unwrap_or_else(|| panic!("坏名字被放行了：{bad:?}"));
            assert!(!e.is_empty());
        }
        // 重名（同一台机器上两个「微信」用户分不清）
        assert!(clean_app(&cfg, "微信", "https://example.com", "open", None).is_err());
        // 编辑自己时不该被自己的名字挡住
        assert!(clean_app(&cfg, "微信", "weixin://", "open", Some("a1")).is_ok());
        // 改名成别人的名字仍然要拦
        assert!(clean_app(&cfg, "微信", "weixin://", "open", Some("zz")).is_err());

        // 正当输入：trim 后落库，id 由调用方用 new_app_id 补
        let app = clean_app(&cfg, "  网易云  ", " https://music.163.com ", "open", None)
            .expect("正当输入被误拦");
        assert_eq!(app.name, "网易云", "名字要 trim 后再存");
        assert_eq!(app.url, "https://music.163.com", "地址也要 trim");
        assert!(app.id.is_empty(), "id 不归 clean_app 管（调用方现生成）");
        assert_eq!(app.kind, "open");
    }

    /// #135：类型（搜索/打开）与地址必须自洽 —— 和 engines.json 的 kind
    /// 不变量同一条契约：搜索类带 %s、打开类不带。
    #[test]
    fn clean_app_enforces_kind_url_contract() {
        let cfg = Config::default();
        // 搜索类必须带 %s
        assert!(clean_app(&cfg, "百科", "https://baike.baidu.com/item/%s", "search", None).is_ok());
        assert!(clean_app(&cfg, "百科", "https://baike.baidu.com/", "search", None).is_err());
        // 打开类禁带 %s
        assert!(clean_app(&cfg, "网易云", "https://music.163.com", "open", None).is_ok());
        assert!(clean_app(&cfg, "网易云", "https://music.163.com/%s", "open", None).is_err());
        // 空 kind = 老调用方：按 url 现推
        let app = clean_app(&cfg, "网易云", "https://music.163.com", "", None).unwrap();
        assert_eq!(app.kind, "open");
        let app = clean_app(&cfg, "百科", "https://baike.baidu.com/item/%s", "", None).unwrap();
        assert_eq!(app.kind, "search");
        // 乱填的类型直接拦
        assert!(clean_app(&cfg, "网易云", "weixin://", "其他", None).is_err());
    }

    /// id 必须不撞：横条哨兵按 id 钉，撞了就是两个格子抢同一个软件。
    #[test]
    fn new_app_ids_do_not_collide() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..500 {
            let id = new_app_id();
            assert!(!id.is_empty(), "id 不能为空");
            assert!(id.len() <= 12, "id 太长了：{id}");
            assert!(
                id.chars().all(|c| c.is_ascii_alphanumeric()),
                "id 会进横条哨兵和文件名，只准字母数字：{id}"
            );
            assert!(seen.insert(id.clone()), "id 撞了：{id}");
        }
    }

    /// 删软件后，横条里那根 `@app:<id>` 哨兵必须跟着消失。
    ///
    /// 不剪的话设置页「横条上的引擎」会把 `@app:xxxx` 原文当引擎名显示 ——
    /// 用户看到的就是乱码（收藏夹哨兵踩过的坑，同款病根）。
    #[test]
    fn dangling_app_sentinels_are_pruned() {
        let mut c = Config::default();
        c.apps = vec![
            ExternalApp {
                id: "a1".into(),
                name: "微信".into(),
                url: "weixin://".into(),
                kind: "open".into(),
            },
            ExternalApp {
                id: "a2".into(),
                name: "网易云".into(),
                url: "https://music.163.com".into(),
                kind: "open".into(),
            },
        ];
        c.bar_list = vec![
            "百度".into(),
            app_sentinel("a1"),        // 存活 → 留
            app_sentinel("a2"),        // 存活 → 留
            app_sentinel("gone"),      // 已删软件 → 剪
            app_sentinel(""),          // 空 id 也是悬空 → 剪
            "百度翻译".into(),
            "|".into(),                // 分隔线哨兵不是 app 哨兵，不能误伤
            "@ocr".into(),             // OCR 哨兵同理
        ];

        let pruned = prune_dangling_app_sentinels(&mut c);
        assert_eq!(pruned, 2, "只该剪掉指向已删软件的那 2 根");
        assert_eq!(
            c.bar_list,
            vec![
                "百度".to_string(),
                app_sentinel("a1"),
                app_sentinel("a2"),
                "百度翻译".to_string(),
                "|".to_string(),
                "@ocr".to_string(),
            ],
            "普通引擎、存活哨兵和别的哨兵都要原样保留，顺序也不能乱"
        );

        // 幂等：再剪一次什么都不该动
        assert_eq!(prune_dangling_app_sentinels(&mut c), 0);
        // 软件清空时所有 app 哨兵都该走，别的哨兵一个不碰
        c.apps.clear();
        assert_eq!(prune_dangling_app_sentinels(&mut c), 2);
        assert!(!c.bar_list.iter().any(|n| is_app_sentinel(n)));
        assert_eq!(c.bar_list.len(), 4, "普通引擎和别的哨兵要留着");
    }

    /// 和收藏夹哨兵一样：**载入配置时**（本地 / 备份 / 云端恢复 / 导入）
    /// 就要把悬空 app 哨兵剪掉，别等它冒到横条上。
    #[test]
    fn sanitize_prunes_dangling_app_sentinels() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("appprune");
        let json = format!(
            r#"{{"apps":[{{"id":"alive","name":"活着","url":"weixin://"}}],"bar_list":["百度","{}alive","{}dead"]}}"#,
            APP_PREFIX, APP_PREFIX
        );
        std::fs::write(&f, json).unwrap();
        let c = load_from(&f);
        assert_eq!(
            c.bar_list,
            vec!["百度".to_string(), format!("{}alive", APP_PREFIX)],
            "载入时就该只剩存活的哨兵"
        );
        assert_eq!(c.apps.len(), 1, "apps 本身要能读回来");
    }

    /// 老配置里**没有** `apps` 这个键（`#[serde(default)]` 的职责）：
    /// 读出来是空 Vec，横条上一个 `@app:` 都不会多出来。
    #[test]
    fn legacy_config_without_apps_still_loads() {
        let _serial = big_lock();
        let (f, _g) = tmp_file("applegacy");
        std::fs::write(&f, r#"{"bar_list":["百度","Google"]}"#).unwrap();
        let c = load_from(&f);
        assert!(c.apps.is_empty(), "老配置没有 apps，默认应为空");
        assert_eq!(c.bar_list, vec!["百度", "Google"]);
    }

    /// 备份命名的**唯一口径**：本地落盘与云端上传必须同名。
    ///
    /// 用户反馈原话：「本地备份的文件名是 config(2026-10-12 23-06-22).QuickSearch，
    /// 而备份到云端的文件名是 quicksearch-backup.json，这完全对不上」。
    /// 现在两边都从 `backup_name` 出，这条断言就是"再也不会岔开"的护栏。
    #[test]
    fn backup_name_is_the_single_source_of_truth() {
        let stamp = "2026-10-12 23-06-22";
        assert_eq!(backup_name(stamp), "config(2026-10-12 23-06-22).QuickSearch");
    }

    /// 滚动备份**绝不能**跟「立即备份」同名。
    ///
    /// `save_to` 每次保存都会把同目录里旧的滚动备份删掉 —— 一旦两者同名，
    /// 用户手动做的备份会被下一次改设置顺手删光，那是灾难性的。
    #[test]
    fn rolling_backup_never_collides_with_manual_backup() {
        let stamp = "2026-10-12 23-06-22";
        let roll = rolling_backup_name(stamp);
        let manual = backup_name(stamp);
        assert_ne!(roll, manual, "两族备份文件名撞了");
        assert!(
            is_rolling_backup(std::path::Path::new(&roll)),
            "滚动备份没被 is_rolling_backup 认出来"
        );
        assert!(
            !is_rolling_backup(std::path::Path::new(&manual)),
            "手动备份被误判成滚动备份 → 下次保存会被删掉"
        );
        assert!(is_manual_backup(&manual));
        assert!(!is_manual_backup(&roll));
    }

    /// 恢复前快照的新老两种名字都要认。
    #[test]
    fn snapshot_names_are_recognized() {
        assert!(is_snapshot("config.before-webdav(2026-10-12 23-06-22).QuickSearch"));
        assert!(is_snapshot("config.before-webdav-3.json"));
        assert!(!is_snapshot("config(2026-10-12 23-06-22).QuickSearch"));
    }

    /// r54 栽过的坑：`#[serde(default)]` 用在 `Vec<String>` 上时，serde 取的是
    /// `Vec::default()`（**空数组**），不是 `Default for Config` 里那份名单。
    ///
    /// 后果：升级用户（config.json 里没有 `img_engines` 这个键）读进来是空名单，
    /// 设置页「要搜哪些引擎」一格勾选都不亮 —— 虽然 `img_plan` 有"名单空就退回
    /// DEFAULT_ENGINES"的兜底（识图照旧能用），但界面和行为不一致，用户只会觉得
    /// "这功能是不是坏的"。所以改为显式 `default = "default_img_engines"`。
    ///
    /// 这条断言把"老配置 → 默认两家能直接用的引擎"钉住，也是**升级路径**的回归测试。
    /// r70 默认值换成「Yandex + SauceNAO」—— 两家都实测"框选完直接出结果"
    /// （Yandex 返回 cbirId 直接开结果页；SauceNAO 回真结果页）。百度在 r70
    /// 复测中上传固定被拒（反爬升级），退出默认名单（留着，失败会自动退回
    /// 打开它的上传页）。**这里跟着改是因为默认值真的换了，不是把测试改绿。**
    #[test]
    fn 老配置升级后识图默认名单还在() {
        let old = r#"{"trigger_select":true,"ocr_enable":true}"#;
        let cfg: Config = serde_json::from_str(old).expect("老配置应当能解析");
        assert_eq!(
            cfg.img_engines,
            vec!["yandex".to_string(), "saucenao".to_string()],
            "老配置升级后应当预勾两家打开就能用的引擎"
        );
        assert_eq!(cfg.img_default_engine, "", "默认引擎默认不设");
        assert!(cfg.img_enable, "识图总开关默认开");
        assert!(cfg.img_add_to_bar, "识图入口默认加到横条");
    }

    /// 名单里带未知 id 也必须在**读配置阶段**就活得下去（归一在使用端做）。
    ///
    /// 读阶段**不做**去重/归一：`serde_json::from_str` 原样解析（重复 id 也留着），
    /// 归一交给 `imgsearch::normalize_list` —— 这样 `config_view` 发出去的那份
    /// 才是干净名单，而配置对象本身不被悄悄改掉（保存时不会把用户数据改瘦）。
    /// r59：样本里的 `lens` 已经不在注册表里了，换成在册的 `sogou`。
    /// 这条测的是"读阶段原样留、使用端才归一"，与具体是哪一家无关。
    /// r72：`sogou` / `bing` 出册，样本换成仍在册的 `yandex` / `baidu`
    /// （同一个意图：未知的丢掉、重复的合并、顺序按注册表）。
    #[test]
    fn 老配置里的未知引擎id不炸() {
        let old = r#"{"img_engines":["nope","yandex","yandex","baidu"]}"#;
        let cfg: Config = serde_json::from_str(old).expect("应当能解析");
        assert_eq!(
            cfg.img_engines,
            vec!["nope".to_string(), "yandex".to_string(), "yandex".to_string(), "baidu".to_string()],
            "读配置阶段原样留下（含重复与未知 id）"
        );
        // 归一由使用端做：去掉未知的 nope、重复项合并且按注册表顺序排
        let norm = imgsearch::normalize_list(&cfg.img_engines);
        assert_eq!(norm, vec!["yandex".to_string(), "baidu".to_string()],
            "归一后：未知 id 丢掉、重复项合并且按注册表顺序");
    }

    /* ---------------- r56：最近使用 ---------------- */

    /// 老配置升级：两个新键都不在文件里，读进来应当是「空名单 + 默认 10 个」。
    /// 这两个默认值直接决定用户第一次打开「更多引擎」面板看到什么 ——
    /// 名单空 = 那一栏整段不显示（renderRecentSection 里 `if (!names.length) return`），
    /// 10 = 真有时最多摆 10 颗。
    #[test]
    fn 老配置升级后最近使用是空名单默认十档() {
        let old = r#"{"trigger_select":true}"#;
        let cfg: Config = serde_json::from_str(old).expect("老配置应当能解析");
        assert!(cfg.recent_engines.is_empty(), "没记录过就不该有最近使用");
        assert_eq!(cfg.recent_max, 10, "默认档位是 10 个");
    }

    /// `recentMax` 只认 5/10/15/20 四档。这是**封闭集合**而不是范围夹取 ——
    /// 设置页就给这四个数（用户原话），接受 0 会让那一栏整个消失（看着像坏了），
    /// 接受 1000 等于把全表又抄一遍，"最近"的意义就没了。
    #[test]
    fn recent_max只认四档() {
        assert_eq!(normalize_recent_max(5), 5);
        assert_eq!(normalize_recent_max(10), 10);
        assert_eq!(normalize_recent_max(15), 15);
        assert_eq!(normalize_recent_max(20), 20);
        // 其余一律退回 10
        assert_eq!(normalize_recent_max(0), 10, "0 会让那一栏消失，不能收");
        assert_eq!(normalize_recent_max(1), 10);
        assert_eq!(normalize_recent_max(7), 10);
        assert_eq!(normalize_recent_max(100), 10, "1000 颗就不是「最近」了");
    }

    /// 记一笔：同名去重、**最新排最前**、空串忽略。
    /// "最新排最前"这个方向是刻意选的 —— push 到尾部的话，每一处展示都得记得
    /// reverse 一次，漏一处顺序就整个反了。
    #[test]
    fn 记一笔时同名去重且最新的排最前() {
        let mut cfg = Config::default();
        cfg.bar_list = vec!["百度".into(), "Google".into(), "必应".into()];
        note_recent_engine(&mut cfg, "百度");
        note_recent_engine(&mut cfg, "Google");
        note_recent_engine(&mut cfg, "百度"); // 再用一次百度 → 它该回到最前
        assert_eq!(cfg.recent_engines, vec!["百度".to_string(), "Google".to_string()],
            "同名只出现一次，且最近一次排最前");
        // 空白串不该进名单（否则面板会画一颗没有名字的格子）
        note_recent_engine(&mut cfg, "   ");
        assert_eq!(cfg.recent_engines.len(), 2, "空白串被忽略");
    }

    /// r57 改：`normalize_recent` **不再按"配置里认不认识"过滤**。
    ///
    /// 旧版本这里会剔掉 `bar_list` 里没有的名字，本意是"清理跨机器恢复备份时
    /// 带过来的、这台机器上没有的引擎"。但它把一件更要紧的事弄坏了：
    /// **面板里点过、但没固定到横条上的引擎全被当成"不认识"删掉了** ——
    /// 而"最近使用"这一栏存在的意义恰恰就是"捞回那些没固定在横条上的引擎"。
    /// 用户点了十几次，那一栏永远是空的，这就是他报的
    /// 「哪怕我点击了一些其他的没有放在横条里的引擎进行使用，之后也
    ///   没有出现最近使用」。
    ///
    /// 现在只**去重**（保留最近那一次）。"名字在引擎表里查不到"由前端
    /// `renderRecentSection` 兜底（查不到就跳过，不给一颗点了没反应的格子）。
    ///
    /// 这条测试钉的是**新语义**：不认识的、没固定在横条上的名字都**留着**。
    #[test]
    fn 最近使用不按配置认不认识过滤() {
        let mut cfg = Config::default();
        cfg.bar_list = vec!["百度".into()];
        cfg.recent_engines = vec![
            "百度".into(),
            "已删除的引擎".into(),
            "百度".into(), // 重复项该合掉
            "Google".into(), // 不在 bar_list 里 —— r57 起**保留**
        ];
        let n = normalize_recent(&mut cfg);
        assert_eq!(n, 1, "只该合掉那一个重复项");
        assert_eq!(
            cfg.recent_engines,
            vec!["已删除的引擎".to_string(), "百度".to_string(), "Google".to_string()],
            "顺序保持原样，只去重；不认识的、没固定到横条的都不许删"
        );
    }

    /// 自定义引擎和外部软件点过之后当然也要留在名单里（它们同样是"引擎"）。
    /// r57 起这一点更简单了 —— 压根不做存在性过滤，谁点过就记谁。
    #[test]
    fn 自定义引擎和外部软件都留着() {
        let mut cfg = Config::default();
        cfg.custom_engines = vec![CustomEngine {
            name: "我的小站".into(),
            url: "https://example.com/?q=%s".into(),
            category: String::new(),
            kind: EngineKind::Search,
            hotkey: String::new(),
            ..Default::default()
        }];
        cfg.apps = vec![ExternalApp {
            id: "a1".into(),
            name: "小软件".into(),
            url: "https://example.com/?q=%s".into(),
            kind: "search".into(),
        }];
        cfg.recent_engines = vec!["我的小站".into(), "小软件".into(), "不明物体".into()];
        let n = normalize_recent(&mut cfg);
        assert_eq!(n, 0, "没有重复项，一个都不该删");
        assert_eq!(
            cfg.recent_engines,
            vec!["我的小站".to_string(), "小软件".to_string(), "不明物体".to_string()]
        );
    }

    /// 名单长度有上限：它是**使用记录**，不该无限增长把 config.json 撑坏。
    #[test]
    fn 最近使用名单长度有上限() {
        let mut cfg = Config::default();
        for i in 0..300 {
            cfg.bar_list.push(format!("引擎{i}"));
        }
        for i in 0..300 {
            note_recent_engine(&mut cfg, &format!("引擎{i}"));
        }
        assert!(cfg.recent_engines.len() <= 200, "名单不许无上限增长，实际 {}",
            cfg.recent_engines.len());
    }

    /// 整条链的回归：`sanitize` 之后名单**原样保留**（只去重），
    /// 不认识的名字不会被悄悄抹掉。
    /// 这条钉的是"读配置 → 归一 → 用"三处接得上，而不是只测归一函数本身。
    #[test]
    fn sanitize不会清掉最近使用() {
        let raw = r#"{"recent_engines":["不存在的引擎","百度","百度"],"bar_list":["百度"]}"#;
        let mut cfg: Config = serde_json::from_str(raw).expect("应当能解析");
        let n = normalize_recent(&mut cfg);
        assert_eq!(n, 1, "只该合掉那个重复的「百度」");
        assert_eq!(
            cfg.recent_engines,
            vec!["不存在的引擎".to_string(), "百度".to_string()],
            "不认识的名字也要留着（前端查不到会跳过，但后端不许删用户的使用记录）"
        );
    }

    /// 2026-10-23：横条「自己收起来」两条阈值的读入归一。
    ///
    /// 配置文件是明文可编辑的，也可能是老版本/别的机器恢复过来的 ——
    /// `bar_idle_sec: 99999`（永远不收）和 `bar_away_px: -20`（一动就收）都得夹回去；
    /// 而 **0 是"关掉这条"的合法值**，不能被当成非法值改回默认。
    #[test]
    fn sanitize_clamps_bar_auto_hide_thresholds() {
        let _serial = big_lock();
        let c = Config::default();
        assert_eq!(
            (c.bar_idle_sec, c.bar_away_px, c.bar_need_text),
            (5, 400, true),
            "默认值：5 秒无操作收起 / 鼠标移远 400px 收起 / 没取到文字不弹"
        );

        let mut bad = Config::default();
        bad.bar_idle_sec = 99_999;
        bad.bar_away_px = -20;
        let bad = sanitize(bad);
        assert_eq!(bad.bar_idle_sec, 300, "离谱的秒数要夹到 300");
        assert_eq!(bad.bar_away_px, 400, "负数要回到默认值");

        let mut off = Config::default();
        off.bar_idle_sec = 0;
        off.bar_away_px = 0;
        let off = sanitize(off);
        assert_eq!(
            (off.bar_idle_sec, off.bar_away_px),
            (0, 0),
            "0 = 不收起，是合法值，不能夹掉"
        );
    }

    /// 2026-10-24：横条弹出位置（文字上方 / 下方）的读入归一。
    ///
    /// 默认是「上方」（沿袭老行为）；白名单外的一律回默认，空串也是。
    #[test]
    fn sanitize_normalizes_bar_pos() {
        let _serial = big_lock();
        let c = Config::default();
        assert_eq!(c.bar_pos, "above", "默认弹在文字上方（老行为）");
        assert_eq!(normalize_bar_pos("below"), "below");
        assert_eq!(normalize_bar_pos("above"), "above");
        assert_eq!(normalize_bar_pos(""), "above", "空串回默认");
        assert_eq!(normalize_bar_pos("left"), "above", "白名单外回默认");

        let mut bad = Config::default();
        bad.bar_pos = "下面".to_string();
        let bad = sanitize(bad);
        assert_eq!(bad.bar_pos, "above", "手改的脏值要夹回默认");

        // 合法值原样保留（用 struct 更新语法构造，免得 clippy 念
        // field_reassign_with_default —— 那一票老测试已经在念了，不添新的）
        let below = sanitize(Config {
            bar_pos: "below".to_string(),
            ..Default::default()
        });
        assert_eq!(below.bar_pos, "below", "合法值原样保留");
    }
}
