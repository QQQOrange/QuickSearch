//! 识图搜索：框选屏幕 → 截图 → 丢给各家「以图搜图」引擎（用户第九批需求 1）。
//!
//! 用户原话：
//! 「在设置中新增独立设置栏，尽可能集成丰富的识图搜索引擎；支持将入口添加到划词
//!   横条中。用户通过现有方式唤出横条后，点击识图搜索按钮，可框选截取屏幕指定区域
//!   进行识图；支持在设置中配置默认引擎，设置后截图完成即直接跳转浏览器搜索，无需
//!   再次选择；支持多选引擎，勾选多个引擎后同时进行搜索，且每个引擎结果分别在新标签
//!   页中打开。」
//!
//! ## 三种走法（r70 定稿）
//!
//! 「以图搜图」理论上只有两条输入通道：把**字节**交给服务端（multipart），
//! 或者给服务端一个**公网可达的图片地址**（URL 参数）。
//!
//! r55/r57 走过的弯路（自己 POST 拿 302、浏览器表单提交）都删了，原因见
//! `Mode::Upload` 的文档。现在按**这家能不能真的把图收下来**分三档：
//!
//! · **`Upload` 类**（百度 / Yandex / SauceNAO / trace.moe）—— 软件自己 POST 上传，
//!   拿到**可重新打开的结果页 URL** 再交给浏览器。这才是用户要的
//!   「框选完直接出识图结果」。r70/r71 实测（2026-10-17，本机网络）：
//!     · Yandex   ✅ 返回 cbirId，结果页直接开；
//!     · SauceNAO ✅ 回 21KB 真结果页（落盘后开）；
//!     · trace.moe ✅ POST api.trace.moe/search 回 JSON（含中文番名、集数、
//!                   时间点、相似度、预览视频），渲染成本地结果页再开；
//!     · 百度     ⚠️ 端点活着、协议对，但当前**固定返回 Reject**
//!                （反爬升级，Acs-Token 空串已不够；带真实会话 Cookie 复测
//!                 仍是 Reject）。失败时按老路退回打开它的上传页，
//!                 所以留着，但**不再进默认名单**。
//!
//! · **`Page` 类**（豆包 / 通义 / Kimi / 智谱 / 元宝 / 文心一言）——
//!   打开这一家的页面，把截图放进剪贴板（`clip::set_image`），AI 那几家再补
//!   一次 Ctrl+V + Enter。这是**人自己会做**的那套动作，只要人能用浏览器
//!   搜图，这条就能用。这几家的页面既能拖拽也能点上传，所以额外留一张
//!   **临时文件**（`img_temp_file`），拖不进去时点「选择文件」选它即可。
//!
//! ⚠ r72 删掉的三家（**真实 Edge 逐家复测全部走不通**，且两个参考项目里
//!   都没有有效实现）：必应（`cn.bing.com/images` 强制 302 到固定搜索结果
//!   页，无文件框无相机入口）、搜狗（`pic.sogou.com` 只剩 `#app` 空壳，
//!   上传 UI 渲染不出来）、360（首页有文件框，但 POST 上传只 302 回首页）。
//!   详细证据见 `ENGINES` 里那段注释。
//!
//! · **`Url` 类**（同一家的「按图片地址搜」入口）—— 只有用户自己在设置里
//!   填了一张公网图片地址才走得通（`img_public_url`）。没填就**不参与**，
//!   界面会说明原因，绝不悄悄跳过。
//!
//! ⚠ r70 删掉的两家（**本机网络实测不可用**，和 r59 删 ascii2d / Lens 同一
//!   口径 —— "默认值跟着实测走"）：
//!   · `lens-url`（Google Lens）：连不通（google.com 全网不可达）；
//!   · `tineye-url`（TinEye）：DNS 被投毒到 Facebook 的 IP（face:b00c），
//!     连接必然失败。
//!   老配置里残留的这两个 id 会被 `normalize_list` 自动滤掉，不报错。
//!
//! ⚠ r71 参考两个开源识图项目（kitUIN/PicImageSearch、4evergr8/FlutterPicOrigin）
//! 逐家复核后**确认不加**的，理由记在 `验收报告.md` 的 r71 一节，摘要：
//!   · Google Lens / TinEye / ascii2d：连不通 / Cloudflare 403（同上口径）；
//!   · iqdb / 3d.iqdb：上传协议通，但要 **47 秒**才回结果（后端多站串查），
//!     体验不可接受；
//!   · Lenso.ai：上游自己标了 DEPRECATED（Cloudflare turnstile）；
//!   · copyseeker：靠轮换的 `next-action` token，桌面端跟不上；
//!   · 必应真上传：上传端点通、能拿 bcid，但结果页 URL 在真实浏览器里会
//!     302 丢会话（insights API 要签名，签名在拿不到的页面里）—— r72 据此
//!     连同页面入口一起把必应出册（连"打开页面"都已被重定向毁掉）；
//!   · 图床中转（catbox / 0x0.st）：一个被墙、一个关停，且把用户截图传上
//!     公网图床有隐私问题，不做。
//!
//! ⚠ 诚实边界：`Page` 类靠**跨进程往浏览器发 Ctrl+V**，能不能被认出来取决于
//!   浏览器与站点版本。这是这条路的天花板，不是本软件的 bug。所以界面上每家
//!   那行小字都写清楚了「打开后会自动粘贴」还是「点选择文件选那张临时图」，
//!   **不再有任何一家承诺"全自动、你不用动手"** —— 除了 Upload 类。
//!
//! ⚠ 关于「截图不留痕」：剪贴板那份用完就还原（见 `img_clip_restore`）；
//!   临时文件只留**一张、固定文件名、每轮覆盖**，并且每轮开始与退出时都删
//!   （见 `img_temp_file` 与 `img_temp_cleanup`）。所以它永远是"暂时的"。

/// 引擎的走法。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// **真的把图交出去**：软件自己 POST 上传，拿到**可重新打开的结果页 URL**，
    /// 再交给浏览器打开。这才是用户要的「框选完直接出识图结果」。
    ///
    /// 前面几轮走过的弯路：
    ///   · r55 自己 POST → 端点/请求头不对，必应 404、ascii2d 403；
    ///   · r57 干脆只打开页面（用户："并没有把节选的部分发给相应的网址"）；
    ///   · r59 让浏览器表单提交（真提交了，但用户要求"通过按键的形式全部撤销"，
    ///     而且那条路要先开一个本地页再跳）。
    /// 现在改成软件自己上传 —— 用的是 PicImageSearch（kitUIN）验证过的端点与
    /// 请求头，不是拍脑袋的提交。实测两家都通（见 Upload 枚举）。
    Upload,
    /// 只打开这一家的页面，**不模拟任何按键**。
    /// 给"上传接口拿不到可重新打开的结果 URL"的几家用。
    Page,
    /// 用用户在设置里填的公网图片地址拼直链（没填就不参与）。
    Url,
}

/// 上传时"怎么发、怎么读结果"，按引擎分。每个变体都对应一家**实测通过**的接口。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Upload {
    /// 不走上传（Page / Url 类）。
    None,
    /// 百度识图：POST 收图接口，表单 from=pc + 文件 image，
    /// **必须带 Acs-Token 头（空串即可）** —— 少了它就是
    /// {"status":1,"msg":"Reject"}（这一条实测踩过）。读 JSON 的 data.url。
    ///
    /// # ⚠ r93：**已改成"跳过上传、直接开页面"**（用户报"识图好慢"）
    ///
    /// 用户原话：「一定要优化一下识图搜索的速度，识图搜索用百度引擎来搜索图片，
    ///   速度真的好慢好慢，要等好多秒才能打开新标签，那这一定要修一下。」
    ///
    /// 慢的原因不是"百度响应慢"，而是**我们明知会失败还要等**：
    ///   百度反爬升级后**固定返回 `{"status":1,"msg":"Reject"}`**
    ///   （注释里早就写着"带真实会话 Cookie 复测仍是 Reject"），
    ///   而失败路径要等完 8s 连接 + 12s 总超时，**之后**才退回打开上传页。
    ///   用户看到的就是"点了识图，愣好几秒，然后才开页面"。
    ///
    /// 修法：百度这个变体**保留**（老配置里可能还引用它），但上传路径直接
    /// 返回一个"请打开页面"的结果，让调用方**立刻**开标签页，一秒都不等。
    /// 这样"百度识图"的体验 = 点一下立刻出页面，用户自己在页面上传图。
    ///
    /// ⚠ 没有直接删掉这个变体：老配置的 `img_engines` 里可能还存着 `baidu`，
    ///   删了会变成"这家引擎不存在"，那比"打开页面"更糟。
    Baidu,
    /// Yandex：POST yandex.ru/images/search?...format=json，文件 upfile，
    /// 读 blocks[0].params.cbirId，再拼 ?rpt=imageview&cbir_id=…。
    /// ⚠ 必须是 **yandex.ru** —— yandex.com 只回一个 1.7KB 的空壳页（实测）。
    Yandex,
    /// SauceNAO：POST 回来的是**一整页结果 HTML**，没有可重开的 URL。
    /// 所以把这份 HTML 落盘、再交给浏览器打开（见 main.rs 的 img_upload）。
    SauceNao,
    /// trace.moe：POST api.trace.moe/search 回的是 **JSON**（动漫场景库，
    /// 1.7 亿帧）。字段：result[].anilist（含中文/日文/罗马字/英文片名、
    /// isAdult、idMal、siteUrl）、episode、from/to（秒）、similarity、
    /// video/image（预览）。拿它渲染一张本地结果页（见 main.rs）。
    ///
    /// r71 实测：匿名额度 quota=100，上传 2~4 秒回 JSON，`cutBorders=true`
    /// 让服务端先切黑边再比（截图带黑边时命中率明显更高）。
    TraceMoe,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Upload => "upload",
            Mode::Page => "page",
            Mode::Url => "url",
        }
    }
}

/// 一家识图引擎的全部静态信息。设置页的引擎列表、多选框、说明文字全由它生成。
pub struct Engine {
    pub id: &'static str,
    pub name: &'static str,
    pub mode: Mode,
    /// 走法对应的地址：Upload → 收图接口；Page → 要打开的页面；
    /// Url → 直链模板（{URL} 是公网图片地址）。
    pub page: &'static str,
    /// Upload 类的上传方式（怎么发、怎么读结果）。
    pub upload: Upload,
    /// 界面上那行小字：点下去会发生什么。
    pub note: &'static str,
    /// **官方主页 / 教程地址** —— 每个引擎行上那颗「?」点开的就是它。
    /// 一律 https:// 开头（前端与 ocr_open_help 同款校验）。
    pub help: &'static str,
}

/// 全部引擎。顺序 = 设置页列表里的顺序。
///
/// 分组口径：**先放「真上传、框选完直接出结果」的四家**（Yandex / 百度 /
/// SauceNAO / trace.moe），再放「打开页面 + 自动粘贴」的 AI 六家，最后是
/// 直链类。r70 起 Google Lens 与 TinEye 出册（本机网络不可达，见模块注释）；
/// r72 起必应 / 搜狗 / 360 出册（页面已无可用上传入口，见下面那段注释）。
/// 按图片地址搜有 Yandex 与 trace.moe 两家。
pub static ENGINES: &[Engine] = &[
    // ---------------- 真上传：框选完直接落在结果页上 ----------------
    Engine {
        id: "yandex",
        name: "Yandex 识图",
        mode: Mode::Upload,
        page: "https://yandex.ru/images/search",
        upload: Upload::Yandex,
        note: "框选完**直接把图交给它**，浏览器落在结果页上。找人脸、找相似图很准。",
        help: "https://yandex.ru/images/",
    },
    Engine {
        id: "baidu",
        name: "百度识图",
        mode: Mode::Upload,
        page: "https://graph.baidu.com/upload",
        upload: Upload::Baidu,
        note: "国内图、商品、明星脸都好用。对方反爬升级后上传可能被拒，被拒时自动打开它的上传页自己传。",
        help: "https://graph.baidu.com/",
    },
    Engine {
        id: "saucenao",
        name: "SauceNAO（动漫图源）",
        mode: Mode::Upload,
        page: "https://saucenao.com/search.php",
        upload: Upload::SauceNao,
        note: "框选完**直接把图交给它**，结果页在本地打开（免费额度有限）。Pixiv / Twitter / 二次元图主力反查站。",
        help: "https://saucenao.com/user.php",
    },
    Engine {
        id: "tracemoe",
        name: "trace.moe（动漫场景）",
        mode: Mode::Upload,
        page: "https://api.trace.moe/search",
        upload: Upload::TraceMoe,
        note: "框选完**直接把图交给它**，本地打开结果页：番名（含中文）、第几集、几分几秒、相似度、预览视频。动漫截图主力。",
        help: "https://trace.moe/",
    },
    // ---------------- 只打开页面（拿不到可重新打开的结果 URL）----------------
    /* r72：必应 / 搜狗 / 360 三家出册。
     *
     * 这三家原来是"打开页面 + 自己点上传 / 选那张临时图"。r72 用真实 Edge
     * （新 profile、无扩展、正常 UA）逐家复测，全部走不通：
     *
     *   · **必应** `cn.bing.com/images` 现在**强制 302 到固定搜索结果页**
     *     （实测落到 `?q=世界旅游胜地&form=HDRSC2`）：DOM 里没有文件框、
     *     没有相机入口，用户看到的就是一页别人的搜索结果。真上传这条路
     *     也走不通 —— multipart POST `/images/search?iss=sbiupload` 能拿到
     *     `bcid_…`，但 `insightsToken` 结果页在真实浏览器里会 302 丢掉会话，
     *     `images/api/custom/knowledge` 要 `skey` + XOR 签名，本地区拿不到
     *     （r71 已用参考实现 kitUIN/PicImageSearch 的 bing.py 逐字段核对过）。
     *   · **搜狗** `pic.sogou.com` 只剩一个 `#app` 空壳：等 9 秒虚拟时间后
     *     DOM 仍是 9.8KB，文件框和上传文案一个都没有，上传 UI 根本渲染不出来。
     *   · **360** `st.so.com` 首页有 `<input type=file name=upload>`，但把图
     *     POST 到 `/r?src=st&srcsp=home` 只回 302 到 `/`（静默失败，无结果页）。
     *
     * 两个参考项目（4evergr8/FlutterPicOrigin、kitUIN/PicImageSearch）里
     * **都没有搜狗与 360**；必应虽有实现，但在本地区落不到可打开的页面上。
     * 用户的要求是「若项目中不存在有效实现，则删除这三个入口」——照办，
     * 不留"点了没反应"的入口。老配置里残留的 id 由 `normalize_list` 滤掉。
     */
    // ---------------- AI 看图 ----------------
    Engine {
        id: "doubao",
        name: "豆包（AI 看图）",
        mode: Mode::Page,
        page: "https://www.doubao.com/chat/",
        upload: Upload::None,
        note: "打开豆包，把那张临时图拖进去（或点上传），再问「这张图是什么」。适合让它解释截图内容。",
        help: "https://www.doubao.com/chat/",
    },
    Engine {
        id: "tongyi",
        name: "通义千问（AI 看图）",
        mode: Mode::Page,
        // r70：tongyi.aliyun.com 已 301 跳 qianwen.com，直接用新域名
        page: "https://www.qianwen.com/",
        upload: Upload::None,
        note: "打开通义千问，上传那张临时图，再问它这张图讲什么。适合解释截图、读表格。",
        help: "https://www.qianwen.com/",
    },
    Engine {
        id: "kimi",
        name: "Kimi（AI 看图）",
        mode: Mode::Page,
        // r70：kimi.moonshot.cn 已 302 跳 kimi.com，直接用新域名
        page: "https://www.kimi.com/",
        upload: Upload::None,
        note: "打开 Kimi，上传那张临时图，再让它解释这张图。长文档 / 表格截图尤其好用。",
        help: "https://www.kimi.com/",
    },
    Engine {
        id: "chatglm",
        name: "智谱清言（AI 看图）",
        mode: Mode::Page,
        page: "https://chatglm.cn/main/alltoolsdetail",
        upload: Upload::None,
        note: "打开智谱清言，上传那张临时图，再让它看图说话。",
        help: "https://chatglm.cn/",
    },
    Engine {
        id: "yuanbao",
        name: "腾讯元宝（AI 看图）",
        mode: Mode::Page,
        // r71：yuanbao.tencent.com/chat/ 会 301 回首页，直接用根地址
        page: "https://yuanbao.tencent.com/",
        upload: Upload::None,
        note: "打开腾讯元宝，上传那张临时图，再让它看图说话。微信生态的 AI，读长图、表格截图都行。",
        help: "https://yuanbao.tencent.com/",
    },
    Engine {
        id: "wenxin",
        name: "文心一言（AI 看图）",
        mode: Mode::Page,
        // r71：yiyan.baidu.com 302 到 wenxin.baidu.com，直接用新域名
        page: "https://wenxin.baidu.com/",
        upload: Upload::None,
        note: "打开文心一言，上传那张临时图，再让它解释这张图。中文理解稳。",
        help: "https://wenxin.baidu.com/",
    },
    // ---------------- 直链类 ----------------
    Engine {
        id: "yandex-url",
        name: "Yandex（按图片地址）",
        mode: Mode::Url,
        page: "https://yandex.ru/images/search?rpt=imageview&url={URL}",
        upload: Upload::None,
        note: "要一张公网图片地址（设置里填）。",
        help: "https://yandex.ru/images/search?rpt=imageview",
    },
    Engine {
        id: "tracemoe-url",
        name: "trace.moe（按图片地址）",
        mode: Mode::Url,
        // r71：网页版支持 ?url= 直接搜（实测 200）
        page: "https://trace.moe/?url={URL}",
        upload: Upload::None,
        note: "要一张公网图片地址（设置里填）。动漫场景按地址搜。",
        help: "https://trace.moe/",
    },
];
/// 按 id 找一家；不认识（老配置 / 手改过文件）返回 None。
pub fn find(id: &str) -> Option<&'static Engine> {
    ENGINES.iter().find(|e| e.id == id)
}

/// **AI 看图**的那几家（打开页面后要补 Ctrl+V + Enter 的）。
///
/// r70：从 main.rs 的 `has_ai` 判断收拢到注册表旁边。以前 main.rs 里
/// `matches!(e.id, "doubao" | "tongyi" | "kimi" | "chatglm")` 写死一份 ——
/// 将来往注册表加一家 AI 引擎而忘了改那行，症状是"页面开了但图没粘进去"，
/// 而这种漏改**没有任何测试会红**。名单放在这里，加引擎时一眼能看见。
///
/// r71：加元宝 / 文心一言（两家都实测可达、都能上传图片）。
pub const AI_ENGINES: &[&str] = &["doubao", "tongyi", "kimi", "chatglm", "yuanbao", "wenxin"];

/// 这一家是不是 AI 看图引擎（见 `AI_ENGINES`）。
pub fn is_ai_engine(id: &str) -> bool {
    AI_ENGINES.contains(&id)
}

/// 默认勾选的引擎。
///
/// r70 换成「Yandex + SauceNAO」—— 两家都实测能"框选完直接出结果"：
///   · Yandex 上传返回 cbirId，结果页直接开（覆盖面最广的通用识图）；
///   · SauceNAO 回真结果页（二次元图主力，免费额度有限所以排第二）。
/// r59 曾是「SauceNAO + 必应」、r61 是「百度 + Yandex」—— 百度在 r70 复测
/// 中上传固定被拒（反爬升级，见模块注释），所以退出默认名单（留着，失败会
/// 自动退回打开它的上传页）。
pub const DEFAULT_ENGINES: &[&str] = &["yandex", "saucenao"];

/// 默认引擎（配置里没存过时用它）。
/// r70：选 Yandex —— 实测最稳的真上传（cbirId 直接开结果页）。
pub const DEFAULT_ENGINE: &str = "yandex";

/// 多引擎一次最多开几个标签页。
///
/// 用户要求「勾多个就同时搜、每个结果各开一个新标签页」—— 但一次弹十几二十个
/// 标签页会把用户的浏览器冲垮（见过 Chrome 这么干直接卡住）。15 是浏览器友好
/// 与「够多」的折中，和 OCR 那条 open_links 的上限保持一致（口径统一）。
pub const MAX_TABS: usize = 15;

/// 这一家的页面**只吃原生文件框**吗？（浏览器不允许往 `<input type=file>` 里粘贴）
///
/// 这直接决定要不要给用户留一张临时文件：只吃文件框的站点，光把图放剪贴板是
/// **没用**的 —— 用户点开「选择文件」会发现手里没有文件可选，流程就断在那儿。
///
/// ⚠ 判定宁可**多报不可漏报**：多报的代价只是提示里多一句"图在哪"（不打扰），
///   漏报的代价是用户走到上传页却没法继续（等于功能没做成）。
///
/// r59：名单跟着引擎表收窄 —— `ascii2d` / `iqdb` / `3diqdb` / `karma` / `trace`
/// 已经从注册表里删掉了（站点挂了 / botcheck / 连不上），留着只会让
/// `要选文件的引擎都在注册表里` 那条测试红。
/// r70：AI 四家（豆包 / 通义 / Kimi / 智谱）留着 —— 它们能拖拽也能上传，
/// 留一张临时图两条路都走得通；真上传的三家（Yandex / 百度 / SauceNAO）
/// 不需要，图是软件自己 POST 上去的。
/// r71：AI 名单扩到六家（加元宝 / 文心）；trace.moe 是真上传，不进这里。
/// r72：必应 / 搜狗 / 360 出册（页面已无可用上传入口，见 ENGINES 上方说明），
/// 名单只剩 AI 六家。
pub fn needs_file_pick(id: &str) -> bool {
    // 只有"打开页面 + 你自己选文件"的那几家需要临时图。
    matches!(id, "doubao" | "tongyi" | "kimi" | "chatglm" | "yuanbao" | "wenxin")
}

/// 把 JSON 数组里的引擎 id 收干净：只留注册表认识的、去重、按注册表顺序排。
///
/// 顺序固定成注册表顺序而不是用户勾选顺序 —— 标签页的先后因此稳定，
/// 不会因为用户勾选时先点谁后点谁而变（口径与 OCR 的 ocr_engine_plan 一致）。
pub fn normalize_list(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in ENGINES {
        if list.iter().any(|x| x == e.id) && !out.iter().any(|x| x == e.id) {
            out.push(e.id.to_string());
        }
    }
    out
}

/// `Url` 类引擎拼出来的最终地址。占位符换成用户填的公网图片地址。
///
/// 返回 None 的情形：没填地址 / 填的不是 http(s) 开头。**宁可不搜也不发一个
/// 明显会被对方拒掉的请求** —— 界面上已经把「要公网图片地址」写在 note 里。
pub fn url_for(e: &Engine, public_url: &str) -> Option<String> {
    let u = public_url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return None;
    }
    Some(e.page.replace("{URL}", &percent_encode(u)))
}

/// 拼 URL 参数值（百分号编码）。
///
/// 图床地址里经常带 `?` `&` `=`（签名参数），不编码直接拼进去会被解析成新的
/// 查询参数，地址就错了。只编码真正会坏事的那几个字符，其余原样 —— 地址
/// 在日志里读起来还认得。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '"' => out.push_str("%22"),
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '&' => out.push_str("%26"),
            '+' => out.push_str("%2B"),
            '=' => out.push_str("%3D"),
            '?' => out.push_str("%3F"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// r59：样本跟着注册表改 —— `ascii2d` / `lens` 已经不在册了（站点挂了 /
    /// 网络连不上，见 ENGINES 上面那段实测记录）。这条测的是**归一逻辑**
    /// （去未知、去重、按注册表顺序），不是"某一家还在不在"，所以样本换成
    /// 在册的三家即可；顺序期望按 ENGINES 的实际顺序（saucenao 在最前）。
    /// r72：必应 / 搜狗 / 360 出册 —— 它们从"有效样本"挪到"必须被滤掉"的
    /// 那一栏，正好一并钉住"老配置残留 id 不会漏进计划"这条。
    #[test]
    fn normalize_list_只收认识的并按注册表顺序() {
        let list = vec![
            "yandex".to_string(),
            "baidu".to_string(),
            "不认识的引擎".to_string(),
            "yandex".to_string(),
            "saucenao".to_string(),
            // r70：删掉的两家 —— 老配置里可能还留着，归一时必须被滤掉
            "lens-url".to_string(),
            "tineye-url".to_string(),
            // r72：删掉的三家 —— 同上
            "bing".to_string(),
            "sogou".to_string(),
            "so360".to_string(),
        ];
        // 注册表顺序是 yandex → baidu → saucenao → …，所以输出按这个排
        let got = normalize_list(&list);
        assert_eq!(got, vec!["yandex", "baidu", "saucenao"]);
    }

    #[test]
    fn normalize_list_全不认识就为空() {
        assert!(normalize_list(&["xyz".to_string()]).is_empty());
    }

    /// r56：问号按钮的目标地址必须**每家都有**、且一律 https。
    ///
    /// 用户要求「每个引擎旁边也要设置一个问号按钮，点击之后就会跳转到申请该引擎
    /// api 的相关教程」。这条测试防两件事：
    ///   ① 新加一家引擎忘了填 help → 前端那颗「?」点了没反应（静默失败）；
    ///   ② 填了 http:// / 相对路径 → 前端 `ocr_open_help` 的校验会拒，
    ///      同样是"点了没反应"，而且错误只在真机点那一刻才现。
    /// 前端只用 `starts_with("https://")` 这一条判据（与 OCR 那侧同一个口径），
    /// 所以这里也只钉这一条 —— 两边判据一致，改一边另一边会红。
    #[test]
    fn 每家的问号地址都是_https() {
        for e in ENGINES {
            assert!(
                e.help.starts_with("https://"),
                "引擎 {} 的 help 不是 https 开头：{}",
                e.id,
                e.help
            );
            // 占位符不该出现在这里（那是 page 的事）；help 是给人看的固定页
            assert!(
                !e.help.contains("{URL}"),
                "引擎 {} 的 help 不该带 {{URL}} 占位符",
                e.id
            );
        }
    }

    #[test]
    fn url_for_拒绝非_http_开头() {
        // r70：Lens 出册后，按图片地址搜只剩 Yandex 一家，样本换成它
        let e = find("yandex-url").unwrap();
        assert!(url_for(e, "").is_none());
        assert!(url_for(e, "  ").is_none());
        assert!(url_for(e, "file:///c:/a.jpg").is_none());
        assert!(url_for(e, "ftp://x/a.jpg").is_none());
    }

    #[test]
    fn url_for_拼接并编码() {
        let e = find("yandex-url").unwrap();
        let got = url_for(e, "https://img.host/a.jpg?w=800&h=600").unwrap();
        // 方案（`://`）和斜杠原样留着 —— 图床地址读起来还认得；
        // 但 `?` `&` `=` **必须**编码，否则会被解析成 Yandex 自己的查询参数，地址就错了
        assert!(got.starts_with("https://yandex.ru/images/search?rpt=imageview&url=https://img.host/a.jpg"));
        assert!(got.contains("%3Fw%3D800%26h%3D600"));
        // 编码之后不能还有裸的 & —— 否则截断成两个参数
        let after = got.split("url=").nth(1).unwrap_or("");
        assert!(!after.contains('&'), "裸 & 会截断地址：{after}");
    }

    #[test]
    fn 注册表里没有重复_id() {
        for (i, a) in ENGINES.iter().enumerate() {
            for b in ENGINES.iter().skip(i + 1) {
                assert_ne!(a.id, b.id, "id 重复：{}", a.id);
            }
        }
    }

    /// 走法的不变量（r57 立、r59 扩到三档）：
    ///   · `Page` 类的 `page` 必须是一个 https 地址（打开它，不是 POST 它），
    ///     且不带 `{URL}`（那是 Url 类的事）；
    ///   · `Form` 类的 `page` 是**收图接口**，必须 https、必须有 `field`
    ///     （文件字段名）、不能带 `{URL}`；
    ///   · `Url` 类的模板必须带 `{URL}`（不然拼出来是个死链）。
    ///
    /// 这条防的是"新加一家忘了填字段"——那种错不会编译报错，只会在用户
    /// 点下去那一刻变成一个空提交或者死链。
    #[test]
    fn 三种走法的字段都对得上() {
        for e in ENGINES {
            match e.mode {
                Mode::Page => {
                    assert!(
                        e.page.starts_with("https://"),
                        "{} 的 page 不是 https：{}",
                        e.id,
                        e.page
                    );
                    assert!(
                        !e.page.contains("{URL}"),
                        "{} 是 Page 类却带 {{URL}}：{}",
                        e.id,
                        e.page
                    );
                }
                Mode::Upload => {
                    assert!(
                        e.page.starts_with("https://"),
                        "{} 的收图接口不是 https：{}",
                        e.id,
                        e.page
                    );
                    assert!(
                        e.upload != Upload::None,
                        "{} 是 Upload 类却没填上传方式",
                        e.id
                    );
                    assert!(
                        !e.page.contains("{URL}"),
                        "{} 是 Upload 类却带 {{URL}}：{}",
                        e.id,
                        e.page
                    );
                }
                Mode::Url => {
                    assert!(
                        e.page.contains("{URL}"),
                        "{} 的模板缺 {{URL}}：{}",
                        e.id,
                        e.page
                    );
                }
            }
        }
        // 至少得有一家 Page 类（打开页面的通用路），否则整个功能是空的
        assert!(
            ENGINES.iter().any(|e| e.mode == Mode::Page),
            "一家 Page 类都没有，识图等于没做"
        );
        /* r61：必须至少有两家 `Upload` —— 那是"框选完直接出结果"的唯一走法。
         * 一家都没有的话，识图就退化成"只会打开网址"，正是用户反复报的问题。
         * 也不许有 Upload 类却填 `Upload::None`（等于假装能上传）。 */
        let uploaders: Vec<&str> = ENGINES
            .iter()
            .filter(|e| e.mode == Mode::Upload)
            .map(|e| e.id)
            .collect();
        assert!(
            uploaders.len() >= 2,
            "真上传的引擎少于 2 家（现在 {:?}），识图会退化成只会打开网址",
            uploaders
        );
        assert!(
            ENGINES
                .iter()
                .filter(|e| e.mode == Mode::Upload)
                .all(|e| e.upload != Upload::None),
            "有 Upload 类引擎没填上传方式"
        );
        // 非 Upload 类一律不许带上传方式（否则代码里会"看起来能传、其实不走"）
        for e in ENGINES.iter().filter(|e| e.mode != Mode::Upload) {
            assert!(
                e.upload == Upload::None,
                "{} 不是 Upload 类却填了 {:?}",
                e.id,
                e.upload
            );
        }
        // 默认勾选的必须全是能真上传的 —— 用户第一次用就该"框完直接出结果"
        for id in DEFAULT_ENGINES {
            let e = find(id).expect("默认名单里有不存在的引擎");
            assert!(
                e.mode == Mode::Upload,
                "默认引擎 {} 不是真上传的，第一次用就会失望",
                id
            );
        }
    }

    /// r61：`Upload` 类的**地址必须就是收图接口**，不是"首页"。
    ///
    /// 这条防的是最容易犯的错：把 `https://graph.baidu.com/`（首页）当成上传点。
    /// 首页在浏览器里打开是给人看的页面，POST 上去不会收图 ——
    /// 表现就是"点了没反应"。所以这里逐家钉住接口路径。
    #[test]
    fn 真上传的引擎地址就是收图接口() {
        for (id, want) in [
            ("baidu", "https://graph.baidu.com/upload"),
            ("yandex", "https://yandex.ru/images/search"),
        ] {
            let e = find(id).expect("引擎必须在册");
            assert_eq!(e.mode, Mode::Upload, "{id} 应当是 Upload 类");
            assert_eq!(e.page, want, "{id} 的收图接口地址不对");
            assert!(
                e.upload != Upload::None,
                "{id} 是 Upload 类却没填上传方式"
            );
        }
        // Yandex 必须是 .ru —— .com 只回一个 1.7KB 的空壳页（实测）
        let yx = find("yandex").unwrap();
        assert!(
            yx.page.contains("yandex.ru"),
            "Yandex 必须走 yandex.ru（yandex.com 只回空壳页）：{}",
            yx.page
        );
    }

    /// `needs_file_pick` 里点名的 id 必须**真的在注册表里** —— 写错一个字母的
    /// 后果是"那家永远不提示临时图在哪"，用户走到上传页却没法继续，
    /// 而且这种错静默、不会报错。
    #[test]
    fn 要选文件的引擎都在注册表里() {
        // "打开页面 + 你自己选文件"的那几家（r61：百度/Yandex 已改真上传，不在列；
        // r71：AI 六家 = 豆包/通义/Kimi/智谱/元宝/文心；
        // r72：必应/搜狗/360 出册，名单只剩 AI 六家）
        for id in ["doubao", "tongyi", "kimi", "chatglm", "yuanbao", "wenxin"] {
            assert!(find(id).is_some(), "needs_file_pick 点名了不存在的引擎 {id}");
            assert!(needs_file_pick(id), "{id} 应当被判为需要选文件");
        }
        // r72 出册的三家：既不在注册表、也不该被判为"要选文件"
        for id in ["bing", "sogou", "so360"] {
            assert!(find(id).is_none(), "{id} 已出册，注册表里不该还有");
            assert!(!needs_file_pick(id), "{id} 已出册，不该还要临时图");
        }
        // 真上传的四家**不需要**临时图：图是软件自己 POST 上去的
        for id in ["baidu", "yandex", "saucenao", "tracemoe"] {
            assert!(!needs_file_pick(id), "{id} 是真上传，不该要临时图");
        }
        // Url 类不涉及文件框
        for e in ENGINES.iter().filter(|e| e.mode == Mode::Url) {
            assert!(!needs_file_pick(e.id), "Url 类 {} 不该要文件", e.id);
        }
    }

    /// r71：trace.moe 的三条不变量 —— 它是唯一一家「上传拿 JSON、自己渲染
    /// 结果页」的引擎，字段填错的症状全是静默的（用户点下去看到空页 /
    /// 打不开 / 图没传上去），所以在这儿钉住：
    ///   ① page 就是 API 端点（https、不带 {URL}）；
    ///   ② 是真上传（不能进 needs_file_pick，也不能进 AI 名单）；
    ///   ③ 不在默认名单也没关系，但必须在册（老配置可能勾过）。
    #[test]
    fn tracemoe_在册且字段对得上() {
        let e = find("tracemoe").expect("trace.moe 必须在册");
        assert_eq!(e.mode, Mode::Upload, "trace.moe 应当是 Upload 类");
        assert_eq!(e.upload, Upload::TraceMoe, "trace.moe 的上传方式不对");
        assert_eq!(e.page, "https://api.trace.moe/search", "trace.moe 的端点不对");
        assert!(!e.page.contains("{URL}"), "Upload 类不该带 {{URL}}");
        assert!(!needs_file_pick("tracemoe"), "trace.moe 是真上传，不该要临时图");
        assert!(!is_ai_engine("tracemoe"), "trace.moe 不是 AI 引擎，别进名单");
        // 按图片地址搜的那家也得在册、且模板带 {URL}
        let u = find("tracemoe-url").expect("trace.moe 直链必须在册");
        assert_eq!(u.mode, Mode::Url);
        assert_eq!(u.page, "https://trace.moe/?url={URL}", "trace.moe 直链模板不对");
    }

    /// r70：AI 名单的三条不变量 —— 写错不会有编译错误，只会在用户点下去那一刻
    /// 变成"页面开了但图没粘进去"（静默失败），所以在这里钉住：
    ///   ① 点名的都在册；② 全是 Page 类（真上传的不需要按键）；
    ///   ③ 都要临时图（AI 站的输入框吃得下拖拽，留一张两条路都通）。
    #[test]
    fn ai_名单都在册且都是打开页面类() {
        for id in AI_ENGINES {
            let e = find(id).unwrap_or_else(|| panic!("AI 名单点了不在册的 {id}"));
            assert_eq!(e.mode, Mode::Page, "{id} 是 AI 引擎，应当是 Page 类");
            assert!(needs_file_pick(id), "{id} 应当要临时图");
        }
        // 反过来：不是 AI 名单的 Page 引擎不该被当 AI（不会误发按键）
        for e in ENGINES.iter().filter(|e| e.mode == Mode::Page) {
            if !is_ai_engine(e.id) {
                assert!(
                    !["doubao", "tongyi", "kimi", "chatglm"].contains(&e.id),
                    "{} 在 AI 名单里却不是 AI 引擎？",
                    e.id
                );
            }
        }
    }

    #[test]
    fn url_类模板必须带占位符() {
        for e in ENGINES.iter().filter(|e| e.mode == Mode::Url) {
            assert!(e.page.contains("{URL}"), "{} 的模板缺 {{URL}}", e.id);
        }
    }

    #[test]
    fn 默认引擎在注册表里() {
        assert!(find(DEFAULT_ENGINE).is_some());
        for id in DEFAULT_ENGINES {
            assert!(find(id).is_some(), "默认名单里有不存在的 {id}");
        }
    }

    /// r70：出册名单 + 默认名单的**实测结论**钉死在这里。
    ///
    /// 删过的两家（Google Lens / TinEye）不许悄悄回来 —— 它们的死因是
    /// 网络层不可达（连不通 / DNS 投毒），不是"参数没调对"，回来只会让用户
    /// 勾一个永远搜不动的引擎。默认名单必须全是实测通过的真上传。
    #[test]
    fn r70_实测结论_出册与默认() {
        for gone in ["lens-url", "tineye-url"] {
            assert!(find(gone).is_none(), "{gone} 已实测不可用，不应在册");
        }
        // 默认名单 = 两家实测通过的真上传
        assert_eq!(DEFAULT_ENGINES, &["yandex", "saucenao"]);
        for id in DEFAULT_ENGINES {
            assert_eq!(find(id).unwrap().mode, Mode::Upload, "{id} 必须是真上传");
        }
        assert_eq!(find(DEFAULT_ENGINE).unwrap().mode, Mode::Upload);
        // 通义 / Kimi 的域名已迁（r70）：老域名只会 301/302，直接用新家
        assert_eq!(find("tongyi").unwrap().page, "https://www.qianwen.com/");
        assert_eq!(find("kimi").unwrap().page, "https://www.kimi.com/");
    }
}
