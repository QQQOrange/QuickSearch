//! 引擎表：内置 engines.json 的解析、AI 引擎判定、搜索词拼接、URL 百分号编码。
//!
//! r55 从 `main.rs` 拆出来的（那一个文件 12200+ 行，改哪儿都要全文找）。
//! 拆的标准是「自包含」：这一节只依赖 `config` 与 `win::log`，
//! 不碰横条窗口、不碰托盘、不碰任何 Tauri 命令 —— 抽走即可独立阅读与测试。
//!
//! ⚠ 有一处**故意的**例外：本节的纯逻辑（AI 判定、URL 判定、搜索词拼接）
//!   不碰全局状态，但 `is_ai_engine` / `engine_entry` / `compose_query`
//!   要读运行时配置。所以它们收一个「读配置」的闭包参数（`cfg_with`），
//!   由调用方注入 —— 这样本模块既能在单测里塞一份假 Config 直接跑，
//!   又不必把 `AppState` / `STATE` 这套全局状态也搬过来（那个和 Tauri
//!   的生命周期绑死，搬不动也不该搬）。
//!
//! 名字后面带 `_in` 的是「纯逻辑版」：不吃全局状态，只吃传进去的 Config。
//! 不带后缀的是「方便版」：内部走 `cfg_with` 读全局配置。两套必须等价，
//! 单测里就靠「同一个输入、两个入口、同一个结果」钉住这条等价关系。

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::Value;

use crate::config;

/* ================================================================== */
/* 引擎表                                                              */
/* ================================================================== */

/// 哪些引擎算「AI 工具」。
///
/// 判据是 engines.json 里**分类标题含 "AI"** 的那一组 —— 不另外维护一份名单，
/// 免得以后加引擎时两头忘改。AI 引擎的搜索词会额外拼上「提问后缀」。
/// 内置的 AI 引擎名单：engines.json 里分类标题含 "AI" 的那一组。
/// 只算一次，之后永不改变。
pub fn builtin_ai_engines() -> &'static HashSet<String> {
    static AI_ENGINES: OnceLock<HashSet<String>> = OnceLock::new();
    AI_ENGINES.get_or_init(|| {
        let mut s = HashSet::new();
        let raw = include_str!("../ui/data/engines.json");
        if let Ok(v) = serde_json::from_str::<Value>(raw) {
            if let Some(cats) = v.get("categories").and_then(|x| x.as_array()) {
                for c in cats {
                    let title = c.get("title").and_then(|x| x.as_str()).unwrap_or("");
                    if !title.contains("AI") {
                        continue;
                    }
                    if let Some(list) = c.get("engines").and_then(|x| x.as_array()) {
                        for e in list {
                            if let Some(n) = e.get("name").and_then(|x| x.as_str()) {
                                s.insert(n.to_string());
                            }
                        }
                    }
                }
            }
        }
        s
    })
}

/// 某个引擎该不该按 AI 处理。
///
/// 内置的当然算；此外用户自定义的引擎只要分类里带 "AI"（例如填「AI 工具」）
/// 也算 —— 于是他自己加的 Kimi 镜像站、公司内网大模型，一样能自动带上
/// 提问后缀、一样会把整份提问放进剪贴板。
///
/// 注意这里必须**现查配置**：自定义引擎是运行时可增删的，以前那种
/// 「一次性建好静态表」的写法对它无效。
///
/// ⚠ 这一条**故意留在 `main.rs`**（r55 拆分时没搬）：它要读全局配置
///   （`cfg_with`），而全局状态和 Tauri 的生命周期绑死、搬不动。真正
///   可搬的是下面那条纯逻辑版 `is_ai_engine_in` —— 它一个全局符号都不碰，
///   于是能在单测里塞一份假 Config 直接跑。两套并存、调用点各取所需：
///   热路径走 main 里的方便版，测试走本模块的纯逻辑版。
///
/// 单测见 `is_ai_engine_in` 下面的 `mod tests`。
pub fn is_ai_engine_in(cfg: &config::Config, name: &str) -> bool {
    builtin_ai_engines().contains(name)
        || cfg
            .custom_engines
            .iter()
            .any(|e| e.name == name && e.category.contains("AI"))
}

/// 内置 engines.json 里解析出来的一个引擎。
///
/// 字段是 `pub` 的：main.rs 里好几处要读（横条点下去要知道开网页还是
/// 发快捷键、`open_app_picker` 要读本地唤起链）。设为私有的话那边就得
/// 每个字段配一个 getter，纯属啰嗦。
#[derive(Clone, Debug)]
pub struct EngineEntry {
    pub url: String,
    pub kind: config::EngineKind,
    /// 快捷键类的按键序列（如 `ctrl+shift+t`），别的类为 None
    pub hotkey: Option<String>,
    /// 「软件直达」本地唤起链（#154）：逐项尝试，任一项成功即停；
    /// 全部失败才回落到 `url`（网页）。含 `://` 的按 URI 协议直接
    /// ShellExecute，其余按开始菜单 `.lnk` 名字精确匹配。
    /// 空 vec = 纯网页引擎（打开类默认形态）。
    pub app: Vec<String>,

    /* ---------------- r58：快捷键引擎的「绑定应用」 ---------------- */
    /// 开不开「先确保应用在跑，再发快捷键」这套逻辑。
    /// 只有**用户自定义的快捷键引擎**能开；内置的快捷键条目一律 false
    /// （engines.json 里没有这个字段，也不该有 —— 那是用户自己的机器环境）。
    pub bind_app: bool,
    /// 绑定的应用路径。`bind_app=false` 或空串时忽略。
    pub app_path: String,
    /// 拉起应用时是否走管理员（runas，会弹 UAC）。
    pub app_admin: bool,
    /// 「启动应用 → 发快捷键」之间额外再等多少毫秒（r76，用户逐引擎可配）。
    ///
    /// 与 `config::CustomEngine::app_launch_delay` 同义，但 `EngineEntry` 是
    /// **运行时合并后的视图**（自定义引擎 + 内置 + 用户的 url 改写合成一份），
    /// 所以这里也要带一份 —— 否则 open_search 里读不到用户刚设的值。
    /// 内置条目一律取默认值（见 `config::default_app_launch_delay`）。
    pub app_launch_delay: u32,
    /// **触发这个快捷键时，要不要把目标应用的主窗口调到前台**（r90）。
    ///
    /// 与 `config::CustomEngine::app_bring_front` 同义 —— 同 `app_launch_delay`
    /// 的理由，运行时视图要带一份，否则 `open_search` 读不到用户刚设的值。
    ///
    /// 默认 `false`：应用已在后台就**不动它的窗口**，直接把按键交给系统路由。
    /// 内置的快捷键条目一律 false（`engines.json` 里没有这个字段）。
    pub app_bring_front: bool,
}

/// 直接从打包进去的 engines.json 里取 name -> (url, 种类)。
///
/// 种类的判定：条目里显式写了 `kind` 就听它的；没写就按 URL 里有没有 `%s`
/// 推断（有 = 搜索模板，没有 = 直达终点）—— 这样即使哪天有人往 json 里
/// 漏了新字段，行为也说得通。
///
/// 快捷键类是个例外：它的 `url` 本来就是空的（点了不打开任何页面），
/// 光看 url 非空会把它整条筛掉。所以「url 为空但 kind=hotkey 且带
/// `hotkey` 字段」的条目照样收 —— 否则横条上那颗快捷键引擎在运行时会
/// 查不到自己，点了没反应。
pub fn engines() -> &'static HashMap<String, EngineEntry> {
    static ENGINES: OnceLock<HashMap<String, EngineEntry>> = OnceLock::new();
    ENGINES.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        let raw = include_str!("../ui/data/engines.json");
        if let Ok(v) = serde_json::from_str::<Value>(raw) {
            let mut push = |arr: Option<&Vec<Value>>| {
                if let Some(list) = arr {
                    for e in list {
                        let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("");
                        let url = e.get("url").and_then(|x| x.as_str()).unwrap_or("");
                        if name.is_empty() {
                            continue;
                        }
                        let hotkey = e
                            .get("hotkey")
                            .and_then(|x| x.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty());
                        /* #154 软件直达：`app` 是本地唤起链（协议 / 开始菜单名）。
                         * 没有这个字段的老条目拿空数组，行为与改动前完全一致。 */
                        let app = e
                            .get("app")
                            .and_then(|x| x.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str())
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty())
                                    .collect::<Vec<String>>()
                            })
                            .unwrap_or_default();
                        let kind = match e.get("kind").and_then(|x| x.as_str()) {
                            Some(k) => config::EngineKind::parse(k),
                            None => {
                                if url.contains("%s") {
                                    config::EngineKind::Search
                                } else if hotkey.is_some() {
                                    config::EngineKind::Hotkey
                                } else {
                                    config::EngineKind::Open
                                }
                            }
                        };
                        // hotkey 类允许 url 为空；其余类没有 url 就没有意义
                        if url.is_empty() && kind != config::EngineKind::Hotkey {
                            continue;
                        }
                        if kind == config::EngineKind::Hotkey && hotkey.is_none() {
                            continue;
                        }
                        m.insert(
                            name.to_string(),
                            EngineEntry {
                                url: url.to_string(),
                                kind,
                                hotkey,
                                app,
                                // 内置条目（engines.json）不参与「绑定应用」：
                                // 那是用户自己机器上的路径，没法预先写进数据文件
                                bind_app: false,
                                app_path: String::new(),
                                app_admin: false,
                                app_launch_delay: config::default_app_launch_delay(),
                                // 内置快捷键条目：默认"不抢前台"
                                app_bring_front: false,
                            },
                        );
                    }
                }
            };
            push(v.get("toolbar").and_then(|x| x.as_array()));
            if let Some(cats) = v.get("categories").and_then(|x| x.as_array()) {
                for c in cats {
                    push(c.get("engines").and_then(|x| x.as_array()));
                }
            }
        }
        m
    })
}

/// 某个引擎完整的调用信息。优先级：
/// 单引擎手工改写（url_overrides，只可能是搜索模板）> 用户自定义引擎 > 内置
/// engines.json。查不到返回 None。
///
/// 纯逻辑版：配置由调用方传（`&Config`），一个全局符号都不碰 —— 于是能单测。
/// 方便版在 `main.rs`（要读全局配置，见 `is_ai_engine` 那段说明）。
pub fn engine_entry_in(cfg: &config::Config, name: &str) -> Option<EngineEntry> {
    if let Some(u) = cfg.url_overrides.get(name) {
        if u.contains("%s") {
            return Some(EngineEntry {
                url: u.clone(),
                kind: config::EngineKind::Search,
                hotkey: None,
                app: vec![],
                bind_app: false,
                app_path: String::new(),
                app_admin: false,
                app_launch_delay: config::default_app_launch_delay(),
                app_bring_front: false,
            });
        }
    }
    if let Some(e) = cfg.custom_engines.iter().find(|e| e.name == name) {
        let hotkey = if e.kind == config::EngineKind::Hotkey {
            Some(e.hotkey.trim().to_string()).filter(|s| !s.is_empty())
        } else {
            None
        };
        return Some(EngineEntry {
            url: e.url.clone(),
            kind: e.kind,
            hotkey,
            // 自定义引擎不走本地唤起链（设置页也没暴露这个字段）：
            // 「软件直达」目前只对内置的常用软件条目生效。
            app: vec![],
            // r58：绑定应用只对快捷键类有意义。搜索/打开类即使配置里残留了
            // 这几个字段也不生效 —— 否则用户把一类引擎改成另一类之后，
            // 旧设置会以意想不到的方式活过来。
            bind_app: e.kind == config::EngineKind::Hotkey && e.bind_app,
            app_path: if e.kind == config::EngineKind::Hotkey {
                e.app_path.clone()
            } else {
                String::new()
            },
            app_admin: e.kind == config::EngineKind::Hotkey && e.app_admin,
            // r76：同 app_admin —— 只对快捷键类透出，其余类拿默认值
            // （自定义引擎自己的值存在 config::CustomEngine::app_launch_delay 上，
            //   由 clean_custom_engine 在保存时按类钳好）。
            app_launch_delay: if e.kind == config::EngineKind::Hotkey {
                e.app_launch_delay
            } else {
                config::default_app_launch_delay()
            },
            // r90：同 app_admin —— 只对快捷键类透出。
            app_bring_front: e.kind == config::EngineKind::Hotkey && e.app_bring_front,
        });
    }
    engines().get(name).cloned()
}

/// 把选中的文字拼成最终要交给引擎的搜索词。
///
/// 对 AI 引擎来说，光把一段话丢过去，模型多半先反问「你想让我做什么」；
/// 在后面补一句意图明确的后缀（如「这句话什么意思？」），点完图标就是一份
/// 完整的提问。普通搜索引擎不做这件事。
///
/// 纯逻辑版：配置由调用方传。方便版在 `main.rs`。
pub fn compose_query_in(cfg: &config::Config, engine: &str, text: &str) -> String {
    if !is_ai_engine_in(cfg, engine) {
        return text.to_string();
    }
    let suffix = cfg
        .ai_suffixes
        .get(engine)
        .map(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(cfg.ai_suffix.as_str())
        .trim()
        .to_string();
    if suffix.is_empty() || text.contains(suffix.as_str()) {
        return text.to_string();
    }
    format!("{text}\n{suffix}")
}

/// 百分号编码（空格用 %20，避免污染 path / fragment）
pub fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 常见通用顶级域名（gTLD）。
///
/// 只用于**裸域名**那条路的收尾校验：不查它的话 `index.html` / `package.json`
/// 会被当成网址 —— 老规则是"最后一段纯字母且 >= 2 位"，这两个正好都满足。
///
/// ⚠ 故意**不含** `zip` / `mov`：它们确实是 2014 年后的真 gTLD，但用户手里
///   `备份.zip` 出现的概率远高于 `example.zip` 这种域名，宁可漏掉两个罕见的。
const GENERIC_TLDS: &str = "com net org edu gov mil int info biz name pro aero coop museum jobs \
mobi travel asia cat tel post app dev page site online shop store tech cloud blog wiki news media \
agency company center world life live today space website press design studio software solutions \
systems digital network group team club fun vip top xyz icu art bio bot cafe cash chat city codes \
coffee computer email energy engineer estate events exchange expert farm finance fish fit games \
gift global guru house ink land link ltd money ninja one plus pub red review rocks run show social \
style tools work zone";

/// 两位国家/地区顶级域名（ccTLD）。
///
/// 照抄 ISO 3166-1 alpha-2 里作为域名后缀在用的那一套。两位的裸域名基本只有它们，
/// 所以直接列表判定 —— 比老规则"两位字母一律放行"安全：后者会把 `test.js`、
/// `a.ts`、`logo.cs` 这些**源码/资源文件名**判成网址。
///
/// 注意 `md` / `py` / `rs` / `sh` / `cc` / `ai` / `io` 这些**既是 ccTLD 又是常见
/// 文件后缀**的两义项仍然保留（它们是真实在用的域名后缀），代价是 `笔记.md`
/// 这类选中仍会被认成网址 —— 这个两义性没有干净的解法。
const CC_TLDS: &str = "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh \
bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj \
dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr \
gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp \
kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu \
mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py \
qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg \
th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";

fn is_known_tld(last: &str) -> bool {
    let l = last.to_ascii_lowercase();
    GENERIC_TLDS.split_whitespace().any(|t| t == l)
        || CC_TLDS.split_whitespace().any(|t| t == l)
}

/// 主机名像不像一个真域名：至少两段点分、最后一段是**已知 TLD**、其余每段非空
/// 且只含字母数字和连字符。顺手剥掉 `user@` 和 `:port`。
fn host_looks_ok(host: &str) -> bool {
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let last = labels[labels.len() - 1];
    if last.len() < 2 || !last.chars().all(|c| c.is_ascii_alphabetic()) || !is_known_tld(last) {
        return false;
    }
    labels[..labels.len() - 1]
        .iter()
        .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// 选中的是不是一个网址；是就返回补全协议后的形式。
///
/// 调用方（`remember_text`）拿它填横条的 `isUrl`，横条据此决定那颗「打开这个网址」
/// 按钮显不显示 —— 所以**两个方向都要准**：该出现时不出现，用户以为软件不支持；
/// 不该出现时出现，点下去打不开（或打开一个莫名其妙的域名）。
///
/// ⚠ 2026-10-16 修掉的两类错判（用户报的"这个按钮时灵时不灵"）：
///
///   ① **假阳性**：裸域名那条路只看"host 至少两段、最后一段纯字母且 >= 2 位"，
///      于是 `index.html` / `package.json` / `test.js` 这些**文件名**全被当成网址。
///      现在最后一段必须是已知 TLD（见 `is_known_tld`）。
///   ② **假阴性**：
///      · 协议大小写敏感 → `HTTP://EXAMPLE.COM` 认不出来（现在不敏感）；
///      · 要求整串都是可见 ASCII → `https://zh.wikipedia.org/wiki/中文` 这种带中文
///        路径的真网址认不出来。现在**只在带协议时放宽**：裸域名那条路仍然要求
///        纯 ASCII，否则"张三.李四""版本1.2"就会被当成域名；
///      · 末尾 `<...>`、`「...」` 这类包裹字符没剥干净（现在一并剥掉）；
///      · 选中时把网址后面的说明文字一起带进来（`https://a.com 说明`）→ 现在取第一段。
///
/// ## r97：**划词选中网址却不出按钮**（用户 2026-10-22 报）
///
/// 用户原话：「我选中了一个网址但横条里并不能够弹出直达网址的按钮，但是如果我把
/// 这段网址复制下来了，因此而弹出的横条里面却能有直达网址的按钮」。
///
/// 两条路的文字来源不同：
///   · **复制**走剪贴板 → 拿到的是用户选中的原文，干净；
///   · **划词**走 `capture_without_clipboard` → 浏览器里 UIA 被整体跳过
///     （Chromium 内容树唤不醒，见 `uia_foreground_is_browser`），落到 **OCR 兜底**。
///     OCR 出来的东西会带它自己的噪声：行尾多一个空格、把 URL 从中间断开
///     （`https:// www.baidu.com`）、末尾粘一个中文句号……
///     于是"整串是不是 URL"这个判据就假阴性了。
///
/// 所以这里对**带协议**那条路再放宽一步：先把整串里的空白和零宽字符抹掉，
/// 再问它是不是一条 URL。`https:// www.baidu.com` → `https://www.baidu.com`。
/// 这不影响假阳性防线（文件名那条路仍然只走裸域名判据，一个字都没改）。
///
/// ⚠ 只抹**空白/零宽**，不抹别的：`https://a.com/x y` 里的空格是路径的一部分
///    （虽然少见），抹了会改出一个打不开的地址。所以抹的是"紧贴协议名的那一段"。
pub fn text_to_url(s: &str) -> Option<String> {
    let t = s
        .trim()
        // ⚠ 开括号和闭括号都要有：只列闭括号时 `「https://a.com」` 剥不掉开头的
        //   `「`（trim_matches 只剥两端，但两端都得命中才行）。
        .trim_matches(|c: char| ",.;:!?)]}\"'<>([{，。；：！？）】》、」』《》〈〉（【「『〔".contains(c))
        .trim()
        .to_string();
    if t.is_empty() || t.len() > 2048 {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    // ① 带协议：整串本来就是用户"选中了一段网址"，没有假阳性风险（没人会不小心
    //    选中 `http://…`），所以只挡明显不是网址的：空主机名。
    for scheme in ["http://", "https://"] {
        /* r97：用 `find` 而不是 `strip_prefix` —— 选中时前面可能带上别字
         * （「请访问 https://a.com」），协议在**任意位置**出现都算候选。
         * 空主机名的检查统一在后面做。 */
        let Some(at) = lower.find(scheme) else { continue };
        let rest = &t[at..];
        // 先试"取到第一个空白为止"（老行为，覆盖 99% 的情况：选中就是一条 URL，
        // 或者 URL 后面跟了说明文字）
        let first: String = rest
            .chars()
            .take_while(|c| !c.is_whitespace() && !is_zero_width(*c))
            .collect();
        /* r97：主机名必须"有个点"或是 IP —— 这一关同时挡掉三种东西：
         *   · `https://` 自己（空主机名）；
         *   · `https://​`（协议后面只有一个零宽字符，split_whitespace 不认它是
         *     空白，于是"第一段"带着它通过了长度检查）；
         *   · `https://www.`（OCR 把主机名后面的内容断开，第一段只剩一个
         *     孤零零的点结尾）。
         * 真 URL 的主机名必然含点（或是一个 IP），拿这个当统一关卡，
         * 比"长度大于协议名"可靠得多。 */
        if first.len() > scheme.len() && host_of(&first).is_some() && !is_url_tail_garbage(&first) {
            return Some(first);
        }
        /* r97：OCR 会把 URL 从中间断开（`https:// www.baidu.com`），于是
         * split_whitespace 只取到 `https://` 自己（长度正好等于协议名）。
         * 这时改用"把空白和零宽字符抹掉再取"：从协议起点往后吃到第一个
         * **非 URL 字符**为止。 */
        let squeezed: String = rest
            .chars()
            .take_while(|c| is_url_char_loose(*c) || c.is_whitespace() || is_zero_width(*c))
            .filter(|c| !c.is_whitespace() && !is_zero_width(*c))
            .collect();
        if squeezed.len() > scheme.len()
            && host_of(&squeezed).is_some()
            && !is_url_tail_garbage(&squeezed)
        {
            return Some(squeezed);
        }
        return None;
    }
    // ② 裸域名 / www.：整串必须是可见 ASCII —— 否则"张三.李四""版本1.2"这类
    //    中文句子会被当成域名（中文路径只有带协议那条路才放行）。
    if !t.chars().all(|c| {
        let v = c as u32;
        (0x21..=0x7E).contains(&v)
    }) {
        return None;
    }
    let host = t.split(['/', '?', '#']).next().unwrap_or("");
    if lower.starts_with("www.") && t.len() > 5 && host_looks_ok(host) {
        return Some(format!("https://{}", t));
    }
    if host_looks_ok(host) {
        return Some(format!("https://{}", t));
    }
    None
}

/// 零宽字符（OCR / 网页复制经常夹带）。它们不该出现在 URL 里，出现即噪声。
fn is_zero_width(c: char) -> bool {
    matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' | '\u{2060}')
}

/// 从一条（可能带协议的）URL 里取出**主机名**，形状不像主机名就返回 None。
///
/// # 为什么要它（r97）
///
/// 老判据是"第一段的长度 > 协议名长度"，这挡不住三种真实噪声：
///   · `https://` 自己 —— 长度正好等于协议名，老代码靠 `<=` 挡掉，但
///   · `https://​`（协议后只有一个零宽字符）—— `split_whitespace` 不认零宽是
///     空白，于是"第一段"长度 9 > 8，**通过了长度检查**；
///   · `https://www.`（OCR 把主机名后面断开）—— 只剩一个孤零零的点结尾。
///
/// 真 URL 的主机名必然**含点**（`www.baidu.com`）或**是一个 IP**
/// （`192.168.1.5`），拿这个当统一关卡比"比协议名长"可靠得多。
fn host_of(u: &str) -> Option<&str> {
    let after = u.split_once("://").map(|x| x.1).unwrap_or(u);
    let host = after.split(['/', '?', '#']).next().unwrap_or("");
    // 去掉 user@ 和 :port（和 host_looks_ok 同一套口径）
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        return None;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Some(host);
    }
    // 必须含点，且每一段都非空（`www..com` / `www.` 这种不算）
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty()) {
        return None;
    }
    Some(host)
}

/// URL 里允许出现的字符（比 `extract_links` 里那份宽松：中文路径里的字符也算）。
///
/// 为什么要宽松：`text_to_url` 的 r97 兜底路径是"从协议起点吃到第一个非 URL
/// 字符为止"。如果这里不含中文，`https://zh.wikipedia.org/wiki/中文` 就会被切成
/// `https://zh.wikipedia.org/wiki/` —— 打开一个没有目标的地址。
fn is_url_char_loose(c: char) -> bool {
    if c.is_ascii_alphanumeric() {
        return true;
    }
    matches!(
        c,
        '-' | '.' | '_' | '~' | ':' | '/' | '?' | '#' | '[' | ']' | '@' | '!'
            | '$' | '&' | '\'' | '(' | ')' | '*' | '+' | ',' | ';' | '=' | '%'
    ) || {
        let v = c as u32;
        // CJK 统一表意 + 扩展 A + 兼容表意 + 中文标点 + 全角
        (0x4E00..=0x9FFF).contains(&v)
            || (0x3400..=0x4DBF).contains(&v)
            || (0xF900..=0xFAFF).contains(&v)
            || (0x3000..=0x303F).contains(&v)
            || (0xFF00..=0xFFEF).contains(&v)
    }
}

/// 一段候选 URL 的**主机名自身**是不是含中文。
///
/// OCR 有时会把一整句话连到协议后面（`https://www.baidu.com这是百度`），
/// 抹掉空白之后它变成一段没有边界的串 —— 这种宁可不认（用户点下去打不开），
/// 也不要打开一个奇怪地址。
///
/// ⚠ 判据是"**主机名**含中文"，不是"路径含中文"：真 URL 的中文只该出现在
/// **路径**里（`https://zh.wikipedia.org/wiki/中文` 是合法且常见的），
/// 出现在主机名里说明是 OCR 把汉字粘上来了。
fn is_url_tail_garbage(seg: &str) -> bool {
    // 协议之后的那一段
    let after = seg.split_once("://").map(|x| x.1).unwrap_or(seg);
    // 主机名结束的位置（第一个 / ? #；没有就是整段）
    let host_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    // 只看主机名**自身**（路径里的中文不管）
    after[..host_end].chars().any(|c| {
        let v = c as u32;
        // CJK 统一表意 + 中文标点 + 全角
        (0x4E00..=0x9FFF).contains(&v)
            || (0x3000..=0x303F).contains(&v)
            || (0xFF00..=0xFFEF).contains(&v)
    })
}

/// 从一段（OCR 出来的）文字里把**所有**链接抠出来。
///
/// 为什么不能用 `split_whitespace` 一个个 token 去试：OCR 的中文排版里，
/// 链接常常紧贴着汉字（`详情见https://example.com/a 说明`），空格切不开。
/// 所以这里直接扫字符，找 `http://` / `https://` 起点，然后往后吃到
/// 第一个「不像 URL 的字符」为止。裸域名（www./不带协议的）也认，
/// 但只认「以 www. 开头」或「明显的域名形态」，避免把中文里的点号误判。
///
/// 结果去重且保持出现顺序 —— 用户看到的顺序就是打开标签页的顺序。
pub fn extract_links(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // 去重用的辅助集合：以前是线性 `out.contains` 扫描 —— 一页全是链接的截图
    // 会退化成 O(n²)。这里用 HashSet 判重、Vec 保序（顺序就是打开标签页的顺序）。
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0;

    // URL 里允许出现的字符。故意不含引号/尖括号/全角标点，
    // 这样 `"https://a.com"` 和 `【https://a.com】` 都能干净地切出来。
    let is_url_char = |c: char| -> bool {
        if c.is_ascii_alphanumeric() {
            return true;
        }
        matches!(
            c,
            '-' | '.' | '_' | '~' | ':' | '/' | '?' | '#' | '[' | ']' | '@' | '!'
                | '$' | '&' | '\'' | '(' | ')' | '*' | '+' | ',' | ';' | '=' | '%'
        )
    };

    // 收尾时再去掉末尾常见的「句读/包裹」类字符，它们多半是标点不是 URL 的一部分
    let trim_tail = |s: &str| -> String {
        s.trim_end_matches(|c| ".,;:!?)]}'\"".contains(c)).to_string()
    };

    // ⚠ 以前是 `chars[i..].iter().take(8).collect()`：对每个字符位置都分配一个
    //   String —— 几千字的 OCR 结果就是几千次堆分配（纯浪费）。这里直接在切片上
    //   做前缀比对，一次都不分配。
    while i < n {
        let tail = if i + 8 <= n { &chars[i..i + 8] } else { &chars[i..] };
        let start_here = tail.starts_with(&['h', 't', 't', 'p', 's', ':', '/', '/'])
            || tail.starts_with(&['h', 't', 't', 'p', ':', '/', '/'])
            || tail.starts_with(&['w', 'w', 'w', '.']);
        if !start_here {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && is_url_char(chars[j]) {
            j += 1;
        }
        let raw: String = chars[i..j].iter().collect();
        let cand = trim_tail(&raw);
        // 用 text_to_url 统一校验/补协议：它会把 www. 和裸域名都补成 https://
        if let Some(u) = text_to_url(&cand) {
            if seen.insert(u.clone()) {
                out.push(u);
            }
            i = if j > i { j } else { i + 1 };
            continue;
        }
        /* r97：OCR 会把 URL 从中间**断开**成两段（`https:// www.baidu.com`）。
         * 上面的 `is_url_char` 遇到空格就停，于是 raw = `https://` 自己 ——
         * text_to_url 拒掉，整条链接就漏了。
         *
         * 这里补一次"接续"：从当前位置往后看，把**空白和零宽字符跳过**之后
         * 仍然像 URL 字符的内容接上，再试一次。只接续一次（不再递归），
         * 避免把 `https:// 说明文字` 这种真句子硬拼成地址。 */
        let mut k = j;
        while k < n && (chars[k].is_whitespace() || is_zero_width(chars[k])) {
            k += 1;
        }
        if k > j {
            let mut m = k;
            while m < n && is_url_char(chars[m]) {
                m += 1;
            }
            if m > k {
                let joined: String = chars[i..k].iter().chain(chars[k..m].iter()).collect();
                let joined = trim_tail(&joined);
                if let Some(u) = text_to_url(&joined) {
                    if seen.insert(u.clone()) {
                        out.push(u);
                    }
                }
                i = if m > i { m } else { i + 1 };
                continue;
            }
        }
        i = if j > i { j } else { i + 1 };
    }
    out
}

/* ---- 本模块自测 ----------------------------------------------------
 * 这里钉的都是**纯逻辑**：不吃全局状态、不碰窗口，塞一份 Config 就能跑。
 * 要测的那几条判据（AI 引擎、URL 形态、搜索词拼接）历史上都改坏过，
 * 且都是"时灵时不灵"那种用户报上来极难复现的症状 —— 有测试兜着，
 * 下次再动这里立刻知道踩了什么。 */
#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份只带一个自定义 AI 引擎的配置。
    fn cfg_with_ai() -> config::Config {
        let mut c = config::Config::default();
        c.custom_engines = vec![config::CustomEngine {
            name: "公司内网大模型".into(),
            url: "https://llm.corp/%s".into(),
            kind: config::EngineKind::Search,
            category: "AI 工具".into(),
            hotkey: String::new(),
            ..Default::default()
        }];
        c
    }

    #[test]
    fn ai_engine_in_judges_by_name_and_category() {
        let c = cfg_with_ai();
        // 自定义引擎的分类里带 AI 就算
        assert!(is_ai_engine_in(&c, "公司内网大模型"));
        // 名字不在名单、分类也不带 AI 的，不算
        assert!(!is_ai_engine_in(&c, "百度"));
        // 内置名单里那些（分类标题含 AI）当然算
        let builtin = builtin_ai_engines();
        if !builtin.is_empty() {
            let one = builtin.iter().next().unwrap();
            assert!(is_ai_engine_in(&c, one));
        }
    }

    #[test]
    fn engine_entry_in_priority_override_then_custom_then_builtin() {
        let mut c = cfg_with_ai();
        // ① 手工改写优先（且必须是搜索模板才生效）
        c.url_overrides.insert("百度".into(), "https://x/%s".into());
        let e = engine_entry_in(&c, "百度").expect("override 应命中");
        assert_eq!(e.url, "https://x/%s");
        assert_eq!(e.kind, config::EngineKind::Search);
        // 不带 %s 的 override 不算数，落到下一级
        c.url_overrides.insert("必应".into(), "https://no-template".into());
        let e = engine_entry_in(&c, "必应").expect("内置应命中");
        assert_ne!(e.url, "https://no-template");
        // ② 自定义引擎
        let e = engine_entry_in(&c, "公司内网大模型").expect("自定义应命中");
        assert_eq!(e.url, "https://llm.corp/%s");
        // ③ 查不到的返回 None
        assert!(engine_entry_in(&c, "不存在的引擎").is_none());
    }

    #[test]
    fn compose_query_in_appends_suffix_only_for_ai() {
        let mut c = cfg_with_ai();
        c.ai_suffix = "这句话什么意思？".into();
        // AI 引擎：拼上后缀
        let q = compose_query_in(&c, "公司内网大模型", "你好");
        assert_eq!(q, "你好\n这句话什么意思？");
        // 普通引擎：原样返回
        assert_eq!(compose_query_in(&c, "百度", "你好"), "你好");
        // 已经含后缀就不再拼（免得越点越长）
        assert_eq!(
            compose_query_in(&c, "公司内网大模型", "你好\n这句话什么意思？"),
            "你好\n这句话什么意思？"
        );
        // 后缀为空 → 不拼
        c.ai_suffix = "   ".into();
        assert_eq!(compose_query_in(&c, "公司内网大模型", "你好"), "你好");
        // 单引擎后缀优先于全局后缀
        c.ai_suffix = "全局".into();
        c.ai_suffixes
            .insert("公司内网大模型".into(), "只给这家".into());
        assert_eq!(
            compose_query_in(&c, "公司内网大模型", "你好"),
            "你好\n只给这家"
        );
    }

    #[test]
    fn text_to_url_rejects_filenames_but_accepts_real_hosts() {
        // 假阳性防线：这些是文件名 / 版本号，不是网址
        for s in ["index.html", "package.json", "test.js", "a.ts", "logo.cs", "版本1.2"] {
            assert!(text_to_url(s).is_none(), "{s} 不该被判成网址");
        }
        // 真网址
        assert_eq!(text_to_url("example.com").as_deref(), Some("https://example.com"));
        assert_eq!(text_to_url("www.a.cn").as_deref(), Some("https://www.a.cn"));
        assert_eq!(text_to_url("https://a.com").as_deref(), Some("https://a.com"));
        // 大小写不敏感
        assert_eq!(text_to_url("HTTP://EXAMPLE.COM").as_deref(), Some("HTTP://EXAMPLE.COM"));
        // 带说明文字的，只取第一段
        assert_eq!(
            text_to_url("https://a.com 说明文字").as_deref(),
            Some("https://a.com")
        );
    }

    /// 用户报的"这个按钮时灵时不灵"的完整回归：两个方向都要准。
    /// （r55 从 main.rs 的 `text_to_url_two_way_accuracy` 原样搬来，用例一个没删。）
    #[test]
    fn text_to_url_two_way_accuracy() {
        // ---- 是网址：必须认出来 ----
        for s in [
            "https://example.com",
            "http://example.com/a?b=1#c",
            "HTTPS://EXAMPLE.COM",                 // 协议大小写不敏感
            "HtTp://Example.COM/Path",
            "www.example.com",
            "example.com",
            "example.com/path",
            "https://zh.wikipedia.org/wiki/中文",   // 带中文路径的真网址
            "<https://example.com>",                // 尖括号包裹
            "「https://example.com」",
            "（https://example.com）",
            "https://example.com/path 说明文字",     // 选中时带上了后面的说明
            "http://192.168.1.5:8080/x",            // IP + 端口
            "https://user@example.com/a",           // 带用户名
            "openai.ai",                            // .ai 是 ccTLD
            "https://a.io/",
            "example.xyz",
        ] {
            assert!(text_to_url(s).is_some(), "应当认成网址: {s}");
        }
        // 认出来之后要补全协议
        assert_eq!(
            text_to_url("example.com").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            text_to_url("www.example.com").as_deref(),
            Some("https://www.example.com")
        );
        assert_eq!(
            text_to_url("https://example.com/a").as_deref(),
            Some("https://example.com/a")
        );
        // 带说明文字时只取网址那一段
        assert_eq!(
            text_to_url("https://example.com/path 说明文字").as_deref(),
            Some("https://example.com/path")
        );

        // ---- 不是网址：必须不认 ----
        for s in [
            "index.html", "package.json", "test.js", "logo.png", "readme.txt",
            "main.ts", "a.csv", "app.log", "config.yml", "data.xml", "报告.docx",
            "backup.zip", "movie.mov", "安装包.exe",
            "张三.李四", "版本1.2", "1.5", "3.14", "这是一句话", "hello world",
            "", "   ", "http://", "https://", "https:// 说明",
            "www.", "www..com", "example.", ".com",
        ] {
            assert!(text_to_url(s).is_none(), "不该认成网址: {s}");
        }
    }

    #[test]
    fn extract_links_dedups_and_keeps_order() {
        let t = "详情见https://example.com/a 说明，还有 www.b.cn 和 https://example.com/a";
        let v = extract_links(t);
        assert_eq!(v, vec!["https://example.com/a".to_string(), "https://www.b.cn".to_string()]);
    }

    /* ---------------- r97：划词选中网址却不弹按钮（OCR 噪声） ---------------- */

    /// 用户报的 bug（2026-10-22）：
    ///
    /// 「我选中了一个网址但横条里并不能够弹出直达网址的按钮，但是如果我把这段网址
    ///   复制下来了，因此而弹出的横条里面却能有直达网址的按钮」。
    ///
    /// 根因：划词路径在浏览器里走 **OCR 兜底**（UIA 内容树唤不醒），OCR 出来的
    /// 东西带噪声 —— 最常见的是把 URL 从中间断开。复制路径拿的是剪贴板原文，
    /// 干干净净。于是同一个"选中一个网址"的动作，两条路结论相反。
    ///
    /// 这些用例就是那几种真实噪声形状。**判决必须和复制路径一致**。
    #[test]
    fn text_to_url_survives_ocr_noise() {
        // ① OCR 把协议和主机名断开（最常见）
        assert_eq!(
            text_to_url("https:// www.baidu.com").as_deref(),
            Some("https://www.baidu.com")
        );
        assert_eq!(
            text_to_url("http:// www.a.com").as_deref(),
            Some("http://www.a.com")
        );
        // ② 主机名中间断开
        assert_eq!(
            text_to_url("https://www. baidu.com").as_deref(),
            Some("https://www.baidu.com")
        );
        // ③ 尾部多一个空格 / 换行（trim 本来就管，这里钉住别退回去）
        assert_eq!(
            text_to_url("https://a.com\n").as_deref(),
            Some("https://a.com")
        );
        // ④ 零宽字符（网页复制经常夹带）
        assert_eq!(
            text_to_url("https://\u{200B}a.com").as_deref(),
            Some("https://a.com")
        );
        // ⑤ 整段话里夹一个网址（划词经常把说明文字一起带进来）
        assert_eq!(
            text_to_url("请访问 https://www.baidu.com 查看详情").as_deref(),
            Some("https://www.baidu.com")
        );
    }

    /// OCR 把 URL 断开之后，`extract_links`（按钮显隐的真正判据）也要能接上。
    #[test]
    fn extract_links_rejoins_ocr_broken_urls() {
        // 断开成两段：接续逻辑要把它拼回来
        assert_eq!(
            extract_links("https:// www.baidu.com"),
            vec!["https://www.baidu.com".to_string()]
        );
        // 一段话里夹一个断开的网址，前后都有中文
        let v = extract_links("详情见 https:// www.baidu.com 谢谢");
        assert_eq!(v, vec!["https://www.baidu.com".to_string()]);
        // 干净的那种不受影响（回归）
        assert_eq!(
            extract_links("https://a.com/x"),
            vec!["https://a.com/x".to_string()]
        );
    }

    /// r97 放宽之后，**假阳性防线一条都不许退**。
    ///
    /// 这条和上面那条同样重要：为了修"漏判"把文件名放进来，用户就会看到
    /// 「选中 report.docx 弹出 🔗、点下去打开一个奇怪域名」—— 比漏判更烦。
    #[test]
    fn ocr_relax_did_not_wake_up_filenames() {
        for s in [
            "index.html",
            "package.json",
            "test.js",
            "C:\\Users\\me\\report.docx",
            "C:\\www\\index.html",           // 带 www 的目录名，最容易误伤
            "张三.李四",
            "版本1.2",
            "hello world",
            "这是一句普通的话",
        ] {
            assert!(text_to_url(s).is_none(), "仍不该认成网址: {s}");
            assert!(extract_links(s).is_empty(), "仍不该抠出链接: {s}");
        }
        // 只有协议名、没有主机名的照样拒（`host_of` 那一关）
        for s in [
            "https://",
            "http://",
            "https:// 说明",
            "https://\u{200B}",               // 协议后只有一个零宽字符
            "https://​ 说明",
        ] {
            assert!(text_to_url(s).is_none(), "空主机名必须拒: {s:?}");
        }
        // 主机名不完整（OCR 从中间断开，只剩一个孤零零的点结尾）
        assert!(text_to_url("https://www.").is_none());
        assert!(text_to_url("https://a.").is_none());
    }

    /// `host_of` 自己的边界：它是 r97 那道"主机名必须有个点"的关。
    #[test]
    fn host_of_accepts_real_hosts_rejects_shapes() {
        assert_eq!(host_of("https://www.baidu.com"), Some("www.baidu.com"));
        assert_eq!(host_of("https://a.com/x?y=1"), Some("a.com"));
        assert_eq!(host_of("http://192.168.1.5:8080/x"), Some("192.168.1.5"));
        assert_eq!(host_of("https://user@example.com/a"), Some("example.com"));
        // 没有协议名的也认（extract_links 里 www. 那条路用）
        assert_eq!(host_of("www.baidu.com"), Some("www.baidu.com"));
        // 拒：空 / 没有点 / 有空段
        assert_eq!(host_of("https://"), None);
        assert_eq!(host_of("https://\u{200B}"), None);
        assert_eq!(host_of("https://www."), None);
        assert_eq!(host_of("https://www..com"), None);
        assert_eq!(host_of("https://说明"), None);
    }

    #[test]
    fn encode_query_percent_encodes_but_keeps_unreserved() {
        // 空格必须编码（否则污染查询串），保留字原样不动
        assert_eq!(encode_query("a b"), "a%20b");
        assert_eq!(encode_query("A-z_0.9~"), "A-z_0.9~");
        // ⚠ 斜杠**也要**编码：这是刻意的 —— 不然搜索词里带 / 会被浏览器
        //   当成路径分隔符，拼出来的 URL 直接走偏（见函数文档）。
        assert_eq!(encode_query("a/b"), "a%2Fb");
        assert_eq!(encode_query("中文"), "%E4%B8%AD%E6%96%87");
    }
}
