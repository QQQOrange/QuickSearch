//! 自动更新（v1.2.0 新增）。
//!
//! # 用户口径
//!
//! > 「自动更新的逻辑就是每次打开软件，它都会检测当前是不是最新版，如果是最新版，
//! >   那就什么都不发生，如果不是最新版，那就会提示说有最新版是否下载，下载也不用
//! >   跳转到网页，而是在当前软件里面自动下好，下好之后就自动删掉原来的，换上新的。
//! >   检查更新就是点击检查之后，来看是否有更新版」
//!
//! > 「自动更新它应该是一个选项……我打勾之后它才会开始自动更新」
//!
//! 落成四件事：
//!
//! | 场景 | 行为 |
//! |---|---|
//! | 勾了开关 + 启动 | 后台查一次 GitHub 最新 tag（**静默**，没新版什么都不弹） |
//! | 点「检查更新」 | 立刻查一次，**无论有没有新版都给回话**（手动动作要有反馈） |
//! | 发现新版 | 弹一句"有新版 vX.Y.Z，要下吗"，附版本说明与体积 |
//! | 点下载 | 在**程序内**下载 → 校验 SHA256 → 替换旧 exe → 提示重启 |
//!
//! # 为什么不去下 Release 页面而是直接搬 exe
//!
//! 「下载也不用跳转到网页」是用户的明确要求。所以：
//!   · 版本信息走 `api.github.com/repos/.../releases/latest`（拿 tag + 说明 + 资产列表）；
//!   · exe 走资产列表里的 `browser_download_url`（就是 `releases/download/...` 那条）。
//! 两条都**不需要浏览器**。
//!
//! # Windows 上"替换正在运行的程序"这个难点
//!
//! 正在运行的 exe 是**被锁住的**：直接 `fs::rename` 会报"另一个程序正在使用此文件"。
//! 这也是为什么大多数软件要"下载后重启才生效"。这里用 Win32 的
//! `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING | MOVEFILE_DELAY_UNTIL_REBOOT)`
//! 之外的更实用的一招：**先把自己改名、再把新的放进来**。
//!
//! 具体步骤（`apply_update`）：
//!   1. 新 exe 先下到 `<旧 exe 同目录>/QuickSearch.exe.new`（**必须同目录**，
//!      跨盘 rename 会失败）；
//!   2. 校验 SHA256（对不上就当失败删掉，绝不放一个坏程序上去）；
//!   3. `MoveFileExW(当前exe → 当前exe.old)` —— 运行中的 exe **允许被改名**
//!      （Windows 只锁"删除/写入"，不锁"改名"）；
//!   4. `MoveFileExW(.new → 正式名)`；
//!   5. 提示用户重启；`.old` 在下次启动时由 `sweep_leftovers()` 清掉
//!      （那时它已经不被任何进程占用了）。
//!
//! 任何一步失败都不会让用户"没有程序可用"：旧的那份只是被改了名，
//! 随时能改回来（`rollback_rename`）。

use std::path::{Path, PathBuf};

/// 本项目的 GitHub 仓库（`owner/repo`）—— 查更新与「关于」页链接共用。
pub const REPO: &str = "QQQOrange/QuickSearch";

/// 仓库主页（「关于」页那颗按钮点开的地址）。
pub const REPO_URL: &str = "https://github.com/QQQOrange/QuickSearch";

/// Releases 页（版本说明里告诉用户"模型在哪下"用的地址）。
pub const RELEASES_URL: &str = "https://github.com/QQQOrange/QuickSearch/releases";

/// 查更新用的 API 入口。
///
/// `/releases/latest` 会**跳过 draft 与 prerelease**，正好是我们要的
/// "当前对外发布的最新正式版"。
///
/// ⚠ `QS_UPDATE_API` / `QS_UPDATE_WEB` 是**仅测试用**的逃生口（和
/// `QS_INSTANCE_TAG` / `QS_ALLOW_INJECTED` 同一类）：让探针能把这两个地址
/// 指到一个本地假服务上，从而真正跑通"发现新版 → 下载 → 校验 → 替换"这条链
/// —— GitHub 上永远不会有"比当前更新的版本"等着我们测那条分支。
/// 正式启动不带这两个变量，走的就是下面写死的真地址。
fn latest_api() -> String {
    if let Ok(b) = std::env::var("QS_UPDATE_API") {
        if !b.trim().is_empty() {
            return b;
        }
    }
    format!("https://api.github.com/repos/{REPO}/releases/latest")
}

/// 「最新版」网页入口（302 那条）。
fn latest_web() -> String {
    if let Ok(b) = std::env::var("QS_UPDATE_WEB") {
        if !b.trim().is_empty() {
            return b;
        }
    }
    format!("{RELEASES_URL}/latest")
}

/// 请求超时（秒）。查更新是个"顺带做"的动作，不该让用户等太久。
const TIMEOUT_SECS: u64 = 15;

/// 一次"检查更新"的结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateInfo {
    /// 远端最新版本号（**不带 v**，例如 `1.2.0`）
    pub version: String,
    /// 远端 tag（带 v，例如 `v1.2.0`）
    pub tag: String,
    /// 有没有比当前新
    pub newer: bool,
    /// 当前版本（由调用方填）
    pub current: String,
    /// 版本说明（Release body，可能为空）
    pub notes: String,
    /// 更新包的下载地址（exe 资产）
    pub url: String,
    /// 更新包体积（字节，0 = 远端没给）
    pub size: u64,
    /// 更新包的 SHA256（从 Release 说明里解析；解析不到就是空串）
    pub sha256: String,
    /// 这个 release 的网页地址（想让用户自己去看时用）
    pub page: String,
    /// 这次查更新**是不是真的用了令牌**（诊断用）。
    ///
    /// 只进日志和"令牌为啥没生效"的提示，**不决定能不能下载** ——
    /// 那个口径是 [`can_auto_download`]（按**现在**的配置现算）。
    /// 两者会不一致，且这正是设计意图：
    ///   · 启动时的自动检查没令牌，用户十分钟后才填 → 这里 `false`，但能下载；
    ///   · 检查时令牌被 GitHub 拒掉 → 这里 `false`、`auth_warning` 有话说，
    ///     但点下载照样能成（公开仓库的资产匿名可下，`open_update_stream`
    ///     会先匿名、失败再带令牌重试）。
    pub authed: bool,
    /// 令牌有问题时的提示（只在"降级成匿名请求"那一轮出现，其余为 `None`）。
    ///
    /// 不放进日志（日志没人看），由界面显示一次 —— 用户填了个错令牌却毫无反应
    /// 是最难查的那类问题。
    pub auth_warning: Option<String>,
}

/// `1.2.10` 这类版本号 → 可比较的数字三元组。
///
/// 只取前三段（`major.minor.patch`）—— 够用，且不会因为 `-beta` 之类后缀崩。
/// 解析不出来的段按 0 算（宁可判"不比当前新"，也不要因为解析失败就催用户升级）。
fn parse_ver(s: &str) -> (u64, u64, u64) {
    let t = s.trim().trim_start_matches(['v', 'V']);
    let mut it = t.split(['.', '-', '+']);
    let mut take = |_| it.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
    (take(()), take(()), take(()))
}

/// `remote` 是不是比 `current` 新。
pub fn is_newer(remote: &str, current: &str) -> bool {
    parse_ver(remote) > parse_ver(current)
}

/// 从一段 Release 说明里找 exe 资产的 SHA256。
///
/// 我们自己的版本说明里会写一行 `SHA256: <64 位十六进制>`（见 PUSH-GUIDE 的
/// "写发布说明"一节）。这里把它抠出来，下载完做校验 —— 用户要求"自动下好换上新的"，
/// 那么"下到的东西是不是我们发的那一份"必须由程序自己把关，不能指望网络。
///
/// 找不到就返回空串（调用方按"无可校验"处理，只比对体积）。
pub fn sha_from_notes(notes: &str) -> String {
    // 找 `sha256` 这个词之后的第一串 64 位 hex（大小写都认）
    let lower = notes.to_ascii_lowercase();
    let Some(i) = lower.find("sha256") else {
        return String::new();
    };
    let rest = &notes[i..];
    let bytes = rest.as_bytes();
    let mut cur = String::new();
    for &b in bytes {
        let c = b as char;
        if c.is_ascii_hexdigit() {
            cur.push(c);
            if cur.len() == 64 {
                return cur.to_ascii_uppercase();
            }
        } else if !cur.is_empty() {
            cur.clear();
        }
    }
    String::new()
}

/// `ureq` 客户端（查更新用，带超时与 UA）。
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        // ★ r94：IPv4 优先 —— 本机 IPv6 有地址有路由但连不通，不挂这个
        //   每次请求都要先白等一次 IPv6 连接超时（实测 6s）。
        //   「检查更新」本来就在启动后不久跑，用户最容易觉得"卡住了"。
        //   原因与量据见 crate::net::ipv4_first。
        .resolver(crate::net::ipv4_first)
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        // GitHub API 对没有 UA 的请求会拒（403）。这个 UA 是"我们是谁"的最小声明。
        .user_agent(concat!("QuickSearch/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// 把配置里存的那串「GitHub 个人访问令牌」洗成真正能用的令牌。
///
/// 做三件事（都是实测会踩的坑）：
///   1. **兼容 `用户名:令牌` 这种老格式** —— 用户从别处抄配置、或者按某些
///      教程填的，前面会带用户名。GitHub 的令牌本身不含冒号，有冒号就取后面
///      那段（Obtainium 也专门做了这一步，见它的 `getTokenIfAny`）。
///   2. 去掉所有空白与控制字符（粘贴时常带换行）。
///   3. 空串 / 只有空白 → `None`（= 匿名请求，不是"填了个空令牌"）。
///
/// ⚠ 返回值是**凭据**：只能进 `Authorization` 头，不许进日志、不许拼 URL。
pub fn effective_token(raw: &str) -> Option<String> {
    let s = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    if s.is_empty() {
        return None;
    }
    // `user:token` → 取冒号之后；`token:` 这种（冒号在末尾）不算老格式，按原样
    let s = match s.find(':') {
        Some(i) if i + 1 < s.len() => s[i + 1..].trim(),
        _ => s,
    };
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// 当前配置里的令牌（没有就是 `None`）。
fn current_token() -> Option<String> {
    crate::cfg_with(|c| effective_token(&c.github_token))
}

/// 「现在能不能在程序内自动下载」—— 全程序**唯一**口径。
///
/// 用户 2026-10-24 的要求：**没填个人访问令牌时，即使查到了新版本也不能点下载**，
/// 只提示 + 给 GitHub 网址让浏览器去下。所以这条判断只认一件事：
/// 配置里**现在**有没有可用令牌。
///
/// # 为什么每次都现算，不存"检查那一刻"的结论
///
/// 检测更新只有两条路（启动后自动一次 / 手动点一次），但结果会被缓存
/// （`UPDATE_PENDING`）—— 存的是"8 秒后那次自动检查"的结论，而用户填令牌
/// 是**之后**才发生的事。如果拿旧结论当依据，会出现两种自相矛盾的界面：
///
///   · 启动时没令牌查到新版 → 用户随后填了令牌 → 还举着"用浏览器下载"；
///   · 检查时用了令牌 → 用户随后清空 → 还举着"下载并安装"，点了被后端拦。
///
/// 现算就没这个问题：填上立刻可下载，清掉立刻只给链接。
///
/// 注意它和 [`UpdateInfo::authed`] 不是一回事：那个记的是"**那次检查**实际
/// 用上了令牌"（填了但被 GitHub 拒掉也是 false，用于日志与降级提示）；
/// 这里是"**现在**有没有令牌"。令牌被拒时下载照样能成 —— 公开仓库的
/// release 资产匿名就能下，`open_update_stream` 会先匿名、失败再带令牌重试。
pub fn can_auto_download() -> bool {
    current_token().is_some()
}

/// 查一次最新版本。
///
/// 失败时给**人话**错误（网络不通 / 没有发布过 / 看不懂返回），
/// 调用方直接显示给用户或写进日志。
///
/// # 两条路：填了令牌就直连 API，没填就尽量省额度
///
/// **填了令牌**（v1.5.7 新增）：一次 `releases/latest` API 就把版本号、说明、
/// 下载地址全拿到 —— 认证请求是 5000 次/小时，一次请求的成本可以忽略，而且
/// 少一个来回更快。
///
/// **没填令牌**：GitHub 对匿名请求只给 60 次/小时，撞上限流是常事
/// （`X-RateLimit-Remaining: 0`，回 403 且 body 为空），用户那边的观感就是
/// "检查更新老是失败"。所以走两段式：
///  1. **版本号**：请求 `github.com/.../releases/latest`，**不做重定向**，
///     从 302 的 `Location` 里抠出 tag。这条**不计入 API 限流**，且极快。
///  2. **详情**（说明 / 下载地址 / 体积）：只有第 1 步判出"确实有新版"才去调
///     API —— 也就是说，日常"已是最新版"的情况**一次 API 都不消耗**。
pub fn check(current: &str) -> Result<UpdateInfo, String> {
    match current_token() {
        Some(tok) => check_with_token(current, &tok),
        None => check_anonymous(current),
    }
}

/// 没令牌那条路：302 省额度，确认有新版才调 API。
fn check_anonymous(current: &str) -> Result<UpdateInfo, String> {
    let tag = latest_tag().or_else(|e| {
        crate::win::log(&format!("update: 302 拿 tag 失败（{e}），退回用 API"));
        latest_tag_via_api()
    })?;
    let version = tag.trim_start_matches(['v', 'V']).to_string();

    /* 没有新版 → **不再调 API**，直接给一个"够用"的结果。
     * 调用方（手动检查）只需要知道"已是最新"，不需要说明与下载地址。 */
    if !is_newer(&version, current) {
        return Ok(UpdateInfo {
            version,
            tag,
            newer: false,
            current: current.to_string(),
            notes: String::new(),
            url: String::new(),
            size: 0,
            sha256: String::new(),
            page: RELEASES_URL.to_string(),
            // 匿名请求 —— 前端据此只给"去网页下载"，不在程序内自动下
            authed: false,
            auth_warning: None,
        });
    }
    fill_details(current)
}

/// 有令牌那条路：一次 API 拿全（5000 次/小时的额度，没必要再省那一次）。
///
/// # 令牌被拒要能自己退回去（Obtainium 的做法）
///
/// 用户可能填了一个过期的、拼错的、或者没有这个仓库权限的令牌。这时候
/// **不能让更新功能整个坏掉** —— 公开仓库匿名也能查。所以：
/// 401/403 且 body 明确说令牌有问题 → 记一条日志、改成匿名请求再查一遍，
/// 并把 `auth_warning` 带回前端提示用户（一次，不重复弹）。
fn check_with_token(current: &str, token: &str) -> Result<UpdateInfo, String> {
    match api_latest(Some(token)) {
        Ok(v) => info_from_api(&v, current, true),
        Err(ApiErr::AuthRejected) => {
            crate::win::log("update: 令牌被 GitHub 拒了（不是限流）—— 退回匿名请求");
            let mut info = check_anonymous(current)?;
            info.auth_warning = Some(
                "GitHub 令牌无效、已过期，或者没有这个仓库的权限 —— 已自动改用匿名请求，\
                 额度会降到 60 次/小时"
                    .to_string(),
            );
            Ok(info)
        }
        Err(e) => Err(e.into_message(true)),
    }
}

/// 第 1 步：从 `releases/latest` 的 302 `Location` 里拿 tag（**不吃 API 限流**）。
///
/// ⚠ `redirects(0)` 的返回形状很容易搞错（我第一版就搞错了）：
///   ureq 2.x 文档写的是「设成 0 就不跟随重定向，**改为给你一个带 3xx 状态的
///   Response 对象**」—— 也就是说它走的是 **`Ok(resp)`**，而不是
///   `Err(Status(302, ..))`。第一版按 `Err(Status)` 去 match，于是永远拿不到
///   Location，每次都白退到 API（实测日志里那句"没有重定向"就是这么来的）。
///   现在两种形状都认：先看 `Ok(resp)` 的状态码，再兜底 match `Err(Status)`。
fn latest_tag() -> Result<String, String> {
    let a = ureq::AgentBuilder::new()
        // ★ r94：IPv4 优先（见 crate::net::ipv4_first）。这条是"查更新"的第一跳，
        //   不挂它就要先白等一次 IPv6 超时，用户看到的是"检查更新半天没反应"。
        .resolver(crate::net::ipv4_first)
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .user_agent(concat!("QuickSearch/", env!("CARGO_PKG_VERSION")))
        // 不跟随重定向：我们要的就是那个 Location
        .redirects(0)
        .build();
    let url = latest_web();
    let loc_from = |r: &ureq::Response| -> Option<String> {
        r.header("Location").map(|s| s.to_string())
    };
    let loc = match a.get(&url).call() {
        // 形状 ①：3xx 作为正常响应回来（ureq 的 redirects(0) 就是这样）
        Ok(r) if (300..400).contains(&r.status()) => loc_from(&r),
        Ok(r) => {
            return Err(format!("没有重定向（HTTP {} —— GitHub 行为变了？）", r.status()));
        }
        // 形状 ②：某些版本/某些错误路径把 3xx 当 Status 错误抛
        Err(ureq::Error::Status(code, r)) if (300..400).contains(&code) => loc_from(&r),
        Err(e) => return Err(format!("请求失败：{e}")),
    };
    let Some(loc) = loc else {
        return Err("重定向响应里没有 Location".to_string());
    };
    let t = loc.rsplit('/').next().unwrap_or("").trim().to_string();
    if t.is_empty() {
        return Err("Location 里没有 tag".to_string());
    }
    Ok(t)
}

/// 第 1 步的兜底：直接问 API 的 `tag_name`。
fn latest_tag_via_api() -> Result<String, String> {
    let j = api_latest(None).map_err(|e| e.into_message(false))?;
    let tag = j
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() {
        return Err("这次响应里没有版本号（tag_name 缺失）".to_string());
    }
    Ok(tag)
}

/// GitHub API 的错误分类。
///
/// 为什么要分类：三种错法对用户/程序的意义完全不同 ——
///   · **令牌被拒**：可以（也应该）脱掉令牌用匿名请求再试一次，功能别整个坏掉；
///   · **限流**：要告诉用户"还要等多久"，没填令牌的还要顺手告诉他怎么解决；
///   · 其它：原样把人话错误抛给界面。
///
/// 顺序照 Obtainium 的做法（`githubErrorCheck`）：**先看限流头，再看认证** ——
/// 有的令牌在额度耗尽时也会被回 401，先判认证就会误报"令牌无效"。
enum ApiErr {
    /// 令牌被拒（401/403 且 body 说 access token / bad credentials）
    AuthRejected,
    /// 限流。`Some(n)` = 还要等 n 分钟（从 `x-ratelimit-reset` 算出来的）
    RateLimited(Option<u64>),
    /// 其它错误（已经翻成人话）
    Other(String),
}

impl ApiErr {
    /// 翻成给用户看的一句话。`authed` = 这次请求有没有带令牌（决定提示文案）。
    fn into_message(self, authed: bool) -> String {
        match self {
            ApiErr::AuthRejected => "GitHub 令牌无效或已过期 —— 到「更新」里换一个".to_string(),
            ApiErr::RateLimited(minutes) => rate_limit_message(minutes, authed),
            ApiErr::Other(s) => s,
        }
    }
}

/// 限流提示：说清"为什么"和"怎么解决"。
///
/// 没填令牌时**必须**带上"去填令牌"这条出路 —— 用户报的「检查更新老是失败」
/// 就是撞了那 60 次/小时，而界面上原来只写"过一会儿再试"，等于没给办法。
fn rate_limit_message(minutes: Option<u64>, authed: bool) -> String {
    let wait = match minutes {
        Some(m) => format!("约 {m} 分钟后恢复"),
        None => "过一会儿再试".to_string(),
    };
    if authed {
        format!("GitHub 接口限流了（这个令牌每小时的额度用完了）—— {wait}")
    } else {
        format!(
            "GitHub 接口限流了（没填令牌时每小时只有 60 次）—— {wait}。\
             到「更新」里填一个 GitHub 个人访问令牌，额度是 5000 次/小时"
        )
    }
}

/// 当前时间到某个 Unix 时间戳还有几分钟（向上取整，夹在 9999 以内）。
///
/// 时间戳已经过去 / 本机时钟比 GitHub 慢，都按 0 分钟算（不显示负数）。
fn minutes_until(epoch: u64) -> Option<u64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    // div_ceil：向上取整（"还剩 30 秒"要说成 1 分钟，不能说 0 分钟）
    Some(epoch.saturating_sub(now).div_ceil(60).min(9999))
}

/// 把 401/403 的响应体翻成"这是不是令牌问题"。
///
/// 判据抄 Obtainium 的 `_isAuthRejection`：只看 body 里的 `message` 有没有
/// `access token` / `bad credentials`。GitHub 对"令牌没这个仓库的权限"回的是
/// `Resource not accessible by personal access token`，对过期令牌回
/// `Bad credentials` —— 两种都要能自动降级，否则用户填错一个字符就再也
/// 检查不了更新。
fn auth_rejection(body: &str) -> bool {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_ascii_lowercase())
        })
        .unwrap_or_default();
    msg.contains("access token") || msg.contains("bad credentials") || msg.contains("bad oauth")
}

/// 调一次 `releases/latest` API，返回整份 JSON。
///
/// `token` = 要带的 GitHub 个人访问令牌（`None` = 匿名）。带令牌时请求头是
/// `Authorization: Token <它>` —— 和 Obtainium 一致；GitHub 同时接受
/// `Bearer`，但 `Token` 是 classic / fine-grained 都能用的那种写法。
fn api_latest(token: Option<&str>) -> Result<serde_json::Value, ApiErr> {
    let a = agent();
    let mut req = a
        .get(&latest_api())
        .set("Accept", "application/vnd.github+json");
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Token {t}"));
    }
    let resp = req.call().map_err(|e| match e {
        ureq::Error::Status(code, r) => {
            /* 先抓头，再读 body —— 顺序反了（先 into_string）头就没了。
             * 这两个头是判断"限流还是别的"的唯一依据。 */
            let remaining = r.header("x-ratelimit-remaining").map(|s| s.to_string());
            let reset = r
                .header("x-ratelimit-reset")
                .and_then(|s| s.parse::<u64>().ok());
            let body = r.into_string().unwrap_or_default();
            if remaining.as_deref() == Some("0") {
                return ApiErr::RateLimited(reset.and_then(minutes_until));
            }
            if (code == 401 || code == 403) && auth_rejection(&body) {
                return ApiErr::AuthRejected;
            }
            match code {
                404 => ApiErr::Other("这个仓库还没有发布过正式版本".to_string()),
                // 没带限流头的 403/429 多半还是限流（GitHub 有时不给头）
                403 | 429 => ApiErr::RateLimited(None),
                _ => {
                    let head: String = body.chars().take(120).collect();
                    ApiErr::Other(format!("GitHub 返回 HTTP {code}：{head}"))
                }
            }
        }
        other => ApiErr::Other(crate::ocr::explain(&other)),
    })?;
    let text = resp
        .into_string()
        .map_err(|e| ApiErr::Other(format!("读取响应失败：{e}")))?;
    serde_json::from_str(&text).map_err(|e| ApiErr::Other(format!("返回的不是 JSON：{e}")))
}

/// 一次「验证令牌」的结果（给设置页那个「验证」按钮用）。
///
/// 只报"这个令牌是谁的、能拿多少额度"，不含任何凭据 —— 前端要把它显示出来。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenCheck {
    /// 令牌属于哪个账号（`/user` 的 `login`）
    pub login: String,
    /// 账号昵称（没设就是空串）
    pub name: String,
    /// 这个令牌每小时的接口额度（带令牌正常是 5000）
    pub limit: u64,
    /// 本小时还剩多少次
    pub remaining: u64,
    /// 「经典令牌」/「细粒度令牌」—— 从响应头推的，只为了把话说清楚
    pub kind: String,
}

/// 验证令牌用的接口地址。
///
/// `QS_GITHUB_USER_API` 是**仅测试用**的逃生口（和 `QS_UPDATE_API` 同一类）：
/// 让探针把验证请求也指到本地假服务上，否则"令牌无效"这条分支只能靠手试。
fn user_api() -> String {
    if let Ok(b) = std::env::var("QS_GITHUB_USER_API") {
        if !b.trim().is_empty() {
            return b;
        }
    }
    "https://api.github.com/user".to_string()
}

/// 拿这串令牌去问一次 GitHub：「你是谁、额度多少」。
///
/// 为什么验证不用 `releases/latest`：那个接口对**没权限的令牌**回的是 404
/// （不是 401），分不清"令牌坏了"还是"仓库没发布过"；`/user` 只认令牌本身，
/// 401 = 坏、200 = 好，判据干净。而且 `/user` 需要的是最基本的账号读取权限，
/// 细粒度令牌默认就能过。
///
/// `raw` 是**输入框里的原值**（可能带粘贴垃圾），这里照 [`effective_token`]
/// 洗一遍再发 —— 和真正查更新/下载时用的是同一个洗法，否则会出现"验证通过、
/// 用的时候又不认"的怪事。
pub fn verify_token(raw: &str) -> Result<TokenCheck, String> {
    let tok = effective_token(raw)
        .ok_or_else(|| "还没填令牌 —— 把 github_pat_… 或 ghp_… 粘进来再点验证".to_string())?;
    let a = agent();
    let resp = a
        .get(&user_api())
        .set("Accept", "application/vnd.github+json")
        .set("Authorization", &format!("Token {tok}"))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                /* 先抓头再读 body —— 顺序反了头就没了（和 api_latest 同一个坑）。 */
                let remaining = r.header("x-ratelimit-remaining").map(|s| s.to_string());
                let reset = r
                    .header("x-ratelimit-reset")
                    .and_then(|s| s.parse::<u64>().ok());
                let body = r.into_string().unwrap_or_default();
                // 额度用完时 GitHub 也可能回 403，先认限流再认认证（同 api_latest）
                if remaining.as_deref() == Some("0") {
                    return rate_limit_message(reset.and_then(minutes_until), true);
                }
                if auth_rejection(&body) || code == 401 {
                    return "令牌无效或已过期（GitHub 回的是 Bad credentials）—— \
                            到网页上重新生成一个再粘过来"
                        .to_string();
                }
                match code {
                    403 => {
                        let head: String = body.chars().take(120).collect();
                        format!("这个令牌没被允许读账号信息（HTTP 403）：{head}")
                    }
                    404 => "验证接口不可达（HTTP 404）—— 检查一下网络或代理".to_string(),
                    _ => {
                        let head: String = body.chars().take(120).collect();
                        format!("GitHub 返回 HTTP {code}：{head}")
                    }
                }
            }
            other => crate::ocr::explain(&other),
        })?;

    /* 三个头必须在 into_string() 之前读。 */
    let scopes = resp.header("x-oauth-scopes").map(|s| s.to_string());
    let limit = resp
        .header("x-ratelimit-limit")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let remaining = resp
        .header("x-ratelimit-remaining")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let text = resp
        .into_string()
        .map_err(|e| format!("读取响应失败：{e}"))?;
    token_check_from(&text, scopes.as_deref(), limit, remaining)
}

/// 把 `/user` 的响应当场拆成 [`TokenCheck`]。
///
/// 单独拆出来是为了**能测**：`verify_token` 整条要联网，拆出这一段之后
/// "GitHub 回了 200 但不是令牌"这类边角就能用纯字符串验。
fn token_check_from(
    body: &str,
    scopes: Option<&str>,
    limit: u64,
    remaining: u64,
) -> Result<TokenCheck, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("返回的不是 JSON：{e}"))?;
    let login = v
        .get("login")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if login.is_empty() {
        return Err("GitHub 没回账号名 —— 这串东西可能不是个人访问令牌".to_string());
    }
    Ok(TokenCheck {
        login,
        name: v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        limit,
        remaining,
        // 经典令牌一定会带 x-oauth-scopes（哪怕值是空串）；细粒度令牌不带这个头
        kind: if scopes.is_some() {
            "经典令牌"
        } else {
            "细粒度令牌"
        }
        .to_string(),
    })
}

/// 从 API 的那份 JSON 里拼出 `UpdateInfo`。
///
/// `authed` = 这次是不是**真的**用了令牌。前端据此决定：有令牌 → 程序内
/// 下载安装；没令牌 → 只提示有新版 + 给网页下载链接（用户 2026-10-24 的要求）。
fn info_from_api(
    v: &serde_json::Value,
    current: &str,
    authed: bool,
) -> Result<UpdateInfo, String> {
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() {
        return Err("这次响应里没有版本号（tag_name 缺失）".to_string());
    }
    let version = tag.trim_start_matches(['v', 'V']).to_string();
    let newer = is_newer(&version, current);
    let notes = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let page = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .unwrap_or(RELEASES_URL)
        .to_string();

    /* 挑更新包：资产名**恒为 QuickSearch.exe**（见 PUSH-GUIDE 的上传步骤）。
     * 有新版却挑不到就报错 —— 不能给用户一个"有新版但没有下载地址"的状态
     * （没新版时 url 空着是正常的，界面根本不会展示下载入口）。 */
    let mut url = String::new();
    let mut size = 0u64;
    if let Some(assets) = v.get("assets").and_then(|x| x.as_array()) {
        for a in assets {
            let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if name.eq_ignore_ascii_case("QuickSearch.exe") {
                url = a
                    .get("browser_download_url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                size = a.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
                break;
            }
        }
    }
    if newer && url.is_empty() {
        return Err(format!("{tag} 这个版本里没有 QuickSearch.exe 更新包"));
    }

    Ok(UpdateInfo {
        version,
        tag,
        newer,
        current: current.to_string(),
        sha256: sha_from_notes(&notes),
        notes,
        url,
        size,
        page,
        authed,
        auth_warning: None,
    })
}

/// 没令牌那条路的第 2 步：确实有新版时，去 API 拿说明 / 下载地址 / 体积。
fn fill_details(current: &str) -> Result<UpdateInfo, String> {
    let v = api_latest(None).map_err(|e| e.into_message(false))?;
    info_from_api(&v, current, false)
}

/// 下载请求的失败文案。
fn download_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            let head: String = body.chars().take(120).collect();
            format!("下载更新包失败：HTTP {code} {head}")
        }
        other => format!("下载更新包失败：{}", crate::ocr::explain(&other)),
    }
}

/// 打开更新包的下载流。
///
/// 先按**匿名**请求：本项目的 release 资产是公开的，匿名一定能下 ——
/// 反过来，填了一个"对这个仓库没权限"的令牌去下载，反而可能被拒。
/// 只有匿名被拒（401/403/404，私有仓库的表现）且**确实配了令牌**时，
/// 才带令牌重试一次。
fn open_update_stream(
    a: &ureq::Agent,
    url: &str,
    token: Option<&str>,
) -> Result<Box<dyn std::io::Read + Send + Sync + 'static>, String> {
    match a.get(url).call() {
        Ok(r) => Ok(r.into_reader()),
        Err(ureq::Error::Status(code, _)) if matches!(code, 401 | 403 | 404) => match token {
            Some(t) => {
                crate::win::log(&format!(
                    "update: 匿名下载被拒（HTTP {code}），改用配置里的令牌重试"
                ));
                a.get(url)
                    .set("Authorization", &format!("Token {t}"))
                    .call()
                    .map(|r| r.into_reader())
                    .map_err(download_error)
            }
            None => Err(format!(
                "下载更新包失败：HTTP {code} —— 这个包可能不是公开的，\
                 试试在「更新」里填一个 GitHub 个人访问令牌"
            )),
        },
        Err(e) => Err(download_error(e)),
    }
}

/// 下载更新包到 `<exe 同目录>/QuickSearch.exe.new`，返回落地路径。
///
/// `progress(已下, 总)`：给前端画进度条用（和模型下载同一个套路）。
///
/// ⚠ 落点**必须在 exe 同目录**：跨盘 `rename` 会失败（EXDEV），
/// 而后面替换那一步就是同目录内的两次 rename。放 %TEMP% 再搬过来是行不通的
/// ——实测那样做要么失败、要么得整份复制（多花一份时间与空间）。
pub fn download(
    info: &UpdateInfo,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, String> {
    use std::io::{Read, Write};
    use sha2::Digest;

    let exe = std::env::current_exe().map_err(|e| format!("取不到当前程序路径：{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "程序路径没有父目录？".to_string())?
        .to_path_buf();
    let new_path = dir.join("QuickSearch.exe.new");

    // 上一轮留下的半截文件先清掉（大小可能不一样，不能续）
    let _ = std::fs::remove_file(&new_path);

    let a = agent();
    let total = if info.size > 0 { info.size } else { 0 };
    let mut reader = open_update_stream(&a, &info.url, current_token().as_deref())?;

    let mut file =
        std::fs::File::create(&new_path).map_err(|e| format!("写更新包失败（磁盘满？）：{e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last_pct = -1i64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("写文件失败：{e}"))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if total > 0 {
            // 已经用 `total > 0` 挡过除零，这里再走一次 `checked_div` 是给
            // clippy 看的（它认不出上面那句 if）。两者行为完全一致。
            let pct = (done.saturating_mul(100))
                .checked_div(total)
                .unwrap_or(0) as i64;
            if pct != last_pct {
                last_pct = pct;
                progress(done, total);
            }
        } else {
            // 远端没给体积（少见）：按 1MB 粒度报，前端显示"已下载多少"
            let chunk = done / (1024 * 1024);
            if chunk as i64 != last_pct {
                last_pct = chunk as i64;
                progress(done, 0);
            }
        }
    }
    let _ = file.flush();
    drop(file);

    let got = format!("{:X}", hasher.finalize());

    /* 校验：说明里给了 SHA256 就**必须**对上；没给就退回比体积
     * （用户要求"自动下好换上新的"，那"下到的确实是我们发的那一份"
     *  必须由程序自己把关，不能指望传输链）。 */
    if !info.sha256.is_empty() {
        if got != info.sha256 {
            let _ = std::fs::remove_file(&new_path);
            return Err(format!(
                "更新包校验失败（SHA256 对不上）—— 已删除，请稍后重试。\n期望 {}，实际 {got}",
                info.sha256
            ));
        }
    } else if info.size > 0 && done != info.size {
        let _ = std::fs::remove_file(&new_path);
        return Err(format!("更新包大小不对（期望 {}，实际 {done}）", info.size));
    }

    crate::win::log(&format!(
        "update: 已下载 {}（{} 字节，sha={}）",
        new_path.display(),
        done,
        &got[..8.min(got.len())]
    ));
    Ok(new_path)
}

/// 把下载好的 `.new` 换成正在运行的 exe。**成功后调用方应立即提示用户重启。**
///
/// 返回 `Ok(旧文件路径)` —— 那是被改名成 `.old` 的那一份，下次启动时清。
pub fn apply_update() -> Result<PathBuf, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let exe = std::env::current_exe().map_err(|e| format!("取不到当前程序路径：{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "程序路径没有父目录？".to_string())?
        .to_path_buf();
    let new_path = dir.join("QuickSearch.exe.new");
    if !new_path.exists() {
        return Err("还没有下载好更新包".to_string());
    }
    let old_path = dir.join("QuickSearch.exe.old");
    // 上一轮如果留下过 .old（更新过两次），先尽力清掉；清不掉也无妨
    let _ = std::fs::remove_file(&old_path);

    let wide = |p: &Path| -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    };
    let exe_w = wide(&exe);
    let old_w = wide(&old_path);
    let new_w = wide(&new_path);

    unsafe {
        /* ⚠ 顺序很重要：**先给正在运行的自己改名**，再把新的搬进来。
         *
         * Windows 允许给正在运行的 exe 改名（它锁的是"删除 / 写入"，不是"改名"），
         * 所以这一步能成；反过来（先删旧的）一定失败。
         *
         * `MOVEFILE_REPLACE_EXISTING` 让"目标已存在"也能覆盖（.old 已清过，
         * 这里再带上是为了幂等）。`MOVEFILE_WRITE_THROUGH` 保证调用返回时
         * 目录项已经落盘 —— 否则紧接着的第二次改名可能看到旧目录状态。 */
        if MoveFileExW(
            PCWSTR(exe_w.as_ptr()),
            PCWSTR(old_w.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .is_err()
        {
            // `MoveFileExW` 失败只回 bool，具体原因要问 `GetLastError`
            let code = windows::Win32::Foundation::GetLastError().0;
            return Err(format!(
                "替换失败：改不掉正在运行的程序（错误码 {code}）—— 可能是权限问题\
                 （程序装在 Program Files 且当前不是管理员）"
            ));
        }
        if MoveFileExW(
            PCWSTR(new_w.as_ptr()),
            PCWSTR(exe_w.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .is_err()
        {
            // 新程序没搬进来 → 把旧的改回去，保证"至少还有一个能用的程序"
            let code = windows::Win32::Foundation::GetLastError().0;
            let _ = MoveFileExW(
                PCWSTR(old_w.as_ptr()),
                PCWSTR(exe_w.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            );
            return Err(format!("替换失败（已回滚到旧版本）：错误码 {code}"));
        }
    }

    crate::win::log(&format!(
        "update: 已替换程序（旧版留在 {}，下次启动清理）",
        old_path.display()
    ));
    Ok(old_path)
}

/// 清理上次更新留下的 `QuickSearch.exe.old`（**启动时**调）。
///
/// 为什么放到启动时：替换那一刻旧 exe 还被本进程占着，删不掉；
/// 下次启动时它已经不被占用了，才能删掉。删不掉也只是留一个文件，
/// 下次再试 —— 绝不能因为清理失败影响启动。
pub fn sweep_leftovers() -> usize {
    let Ok(exe) = std::env::current_exe() else {
        return 0;
    };
    let Some(dir) = exe.parent() else {
        return 0;
    };
    let mut n = 0usize;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            // 只认我们自己的两个残留名，别误删用户目录里的别的东西
            let is_ours = name.eq_ignore_ascii_case("QuickSearch.exe.old")
                || name.eq_ignore_ascii_case("QuickSearch.exe.new");
            if is_ours && std::fs::remove_file(&p).is_ok() {
                n += 1;
                crate::win::log(&format!("update: 已清理残留 {}", p.display()));
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版本号比较按数字而不是字符串() {
        // 字符串比较会把 "1.10.0" 判成小于 "1.9.0" —— 这是最经典的坑
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("1.2.1", "1.2.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.2.0", "1.2.0"));
        assert!(!is_newer("1.1.9", "1.2.0"));
    }

    #[test]
    fn 版本号带v和前缀也能比() {
        assert!(is_newer("v1.3.0", "1.2.0"));
        assert!(is_newer("V1.3.0", "v1.2.0"));
        // 三段缺失按 0（1.2 == 1.2.0），不会误判成更新
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(is_newer("1.2.1", "1.2"));
    }

    #[test]
    fn 版本号解析不了时不催升级() {
        // 拿不到/看不懂远端版本 → 一律当"不比当前新"，宁可漏一次更新提示，
        // 也不要因为解析失败就天天弹"有新版本"
        assert!(!is_newer("", "1.2.0"));
        assert!(!is_newer("abc", "1.2.0"));
        assert!(!is_newer("????", "1.2.0"));
    }

    #[test]
    fn 从说明里抠出sha256() {
        let notes = "## 更新\n\n一些说明\n\nSHA256: 0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF\n\n许可…";
        assert_eq!(
            sha_from_notes(notes),
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
        );
        // 大小写混写的也要认，输出统一大写
        let low = "sha256: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        assert_eq!(
            sha_from_notes(low),
            "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"
        );
        // 没有就空串（调用方退回比体积）
        assert_eq!(sha_from_notes("这段说明里没有校验值"), "");
        // 长度不够的十六进制串不能当校验值（否则会拿一个残缺值去比，永远不等）
        assert_eq!(sha_from_notes("sha256: abcdef"), "");
    }

    #[test]
    fn 仓库地址与文档一致() {
        // 「关于」页的按钮与查更新都从这里取，写错一处就是 404
        assert!(REPO_URL.starts_with("https://github.com/"));
        assert!(REPO_URL.ends_with(REPO));
        assert!(latest_api().contains(REPO));
        assert!(latest_web().contains(REPO));
        // 模型资产页要与 aimodels::ASSET_RELEASE_TAG 对上（那条在 aimodels 里测）
        assert!(RELEASES_URL.ends_with("/releases"));
    }

    /// 逃生口只在**显式设置**时才改变地址。
    ///
    /// 这条防的是"测试开关忘了关、正式版跑去连本机"—— 那种事一旦发生，
    /// 用户侧的自动更新会全部失效，而且日志里只会看到"连不上"。
    #[test]
    fn 默认走真地址而不是逃生口() {
        // 同一个测试进程里不能改环境变量（会互相踩），所以这里只断言
        // **没有设置**时的形状 —— CI 上本来就不带这两个变量。
        if std::env::var("QS_UPDATE_API").is_err() {
            assert_eq!(
                latest_api(),
                format!("https://api.github.com/repos/{REPO}/releases/latest")
            );
        }
        if std::env::var("QS_UPDATE_WEB").is_err() {
            assert_eq!(latest_web(), format!("{RELEASES_URL}/latest"));
        }
    }

    /// 令牌清洗：三种"粘贴垃圾" + Obtainium 那种 `用户名:令牌` 老格式。
    ///
    /// 这一条对着的是真实场景：用户从网页上框选复制 → 前后带换行；
    /// 从终端 echo 出来 → 中间夹换行；照老教程填 → 带用户名。任何一处没洗，
    /// `Authorization: Token …` 都会 401，而用户只看到"检查更新失败"。
    #[test]
    fn 令牌清洗兼容老格式与粘贴垃圾() {
        assert_eq!(effective_token(""), None);
        assert_eq!(effective_token("  \n\t "), None, "只有空白 = 没填，不是空令牌");

        assert_eq!(effective_token("ghp_abc123"), Some("ghp_abc123".into()));
        // 从网页/终端复制常见的三种垃圾
        assert_eq!(effective_token("  \"ghp_abc\"\n"), Some("ghp_abc".into()));
        assert_eq!(effective_token("ghp_a\nbc"), Some("ghp_abc".into()));
        // `用户名:令牌` 老格式（Obtainium 的 getTokenIfAny 也专门兼容这一种）
        assert_eq!(effective_token("octocat:ghp_abc"), Some("ghp_abc".into()));
        // 冒号在末尾 → 不是老格式，原样保留（宁可多一个字符，也别把令牌吞了）
        assert_eq!(effective_token("ghp_abc:"), Some("ghp_abc:".into()));
        // fine-grained 令牌里的下划线不能被当成垃圾洗掉
        assert_eq!(
            effective_token("github_pat_11A_ bbb"),
            Some("github_pat_11A_bbb".into())
        );
    }

    /// 从 API 结果拼 `UpdateInfo`：挑对资产、把 `authed` 原样传下去。
    ///
    /// `authed` 是 v1.5.7 的关键：前端拿它决定"程序内下载"还是"只给网页链接"。
    #[test]
    fn 从api结果拼出更新信息并带上令牌状态() {
        let sha = "A".repeat(64);
        let v = serde_json::json!({
            "tag_name": "v9.9.9",
            "body": format!("修复若干\nSHA256: {sha}"),
            "html_url": "https://github.com/QQQOrange/QuickSearch/releases/tag/v9.9.9",
            "assets": [
                { "name": "other.zip", "size": 9, "browser_download_url": "https://x/other.zip" },
                { "name": "QuickSearch.exe", "size": 123, "browser_download_url": "https://x/QuickSearch.exe" }
            ]
        });
        let info = info_from_api(&v, "1.0.0", true).expect("应当能拼出来");
        assert_eq!(info.version, "9.9.9");
        assert_eq!(info.tag, "v9.9.9");
        assert!(info.newer);
        assert!(info.authed, "令牌状态要传给前端");
        assert_eq!(info.url, "https://x/QuickSearch.exe", "只认 exe 资产");
        assert_eq!(info.size, 123);
        assert_eq!(info.sha256, sha);
        assert!(info.auth_warning.is_none());

        // 匿名 / 令牌被拒降级 → 必须 false（否则前端会给一个必定 403 的下载按钮）
        assert!(!info_from_api(&v, "1.0.0", false).unwrap().authed);
    }

    /// 有新版却没 exe 资产 → 报错（不能给"有新版但没下载地址"的状态）；
    /// 没新版时没资产是正常的（界面根本不展示下载入口）。
    #[test]
    fn 有新版但没有安装包要报错() {
        let v = serde_json::json!({ "tag_name": "v9.9.9", "assets": [] });
        assert!(info_from_api(&v, "1.0.0", true).is_err());

        let v2 = serde_json::json!({ "tag_name": "v0.9.0", "assets": [] });
        let i = info_from_api(&v2, "1.0.0", true).unwrap();
        assert!(!i.newer);
        assert_eq!(i.url, "");
    }

    /// 限流文案：必须说清"等多久"和"怎么彻底解决"。
    ///
    /// 用户报的「检查更新老是失败」就是撞了匿名 60 次/小时，而老文案只写
    /// "过一会儿再试" —— 等于没给办法。
    #[test]
    fn 限流提示要给出填令牌这条出路() {
        let anon = rate_limit_message(Some(37), false);
        assert!(anon.contains("37 分钟"), "要告诉用户还要等多久：{anon}");
        assert!(
            anon.contains("个人访问令牌"),
            "没令牌时必须告诉他怎么解决：{anon}"
        );

        let authed = rate_limit_message(None, true);
        assert!(authed.contains("令牌"), "带上令牌后说的是令牌额度：{authed}");
        assert!(
            !authed.contains("60 次"),
            "填了令牌就别再提匿名额度，会让人以为令牌没用上：{authed}"
        );
    }

    /// 恢复时间按分钟**向上取整**，过期时间戳不能算出负数。
    #[test]
    fn 限流恢复时间按分钟向上取整() {
        assert_eq!(minutes_until(0), Some(0), "过期时间戳 → 0，不能是负数");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // 10 分钟后：±几秒的执行误差不会跨过分钟边界
        assert_eq!(minutes_until(now + 600), Some(10));
    }

    /// 「验证」按钮要的东西：账号名、额度、令牌种类。
    #[test]
    fn 验证结果要能拆出账号与额度() {
        let body = r#"{"login":"QQQOrange","name":"橙子","id":1}"#;
        // 细粒度令牌不带 x-oauth-scopes
        let c = token_check_from(body, None, 5000, 4998).unwrap();
        assert_eq!(c.login, "QQQOrange");
        assert_eq!(c.name, "橙子");
        assert_eq!((c.limit, c.remaining), (5000, 4998));
        assert_eq!(c.kind, "细粒度令牌");

        // 经典令牌一定带这个头（值是空串也算带了）
        let c = token_check_from(body, Some(""), 5000, 0).unwrap();
        assert_eq!(c.kind, "经典令牌");
        assert_eq!(c.remaining, 0, "还剩 0 次要能如实报出来");
    }

    /// 200 但不是令牌该有的形状 —— 不能假装验证通过。
    #[test]
    fn 验证响应不像令牌就报错() {
        let e = token_check_from(r#"{"message":"Bad credentials"}"#, None, 0, 0).unwrap_err();
        assert!(e.contains("不是个人访问令牌"), "{e}");
        let e = token_check_from("not json", None, 0, 0).unwrap_err();
        assert!(e.contains("不是 JSON"), "{e}");
    }

    /// 空令牌不去联网，直接告诉用户"先填一个"。
    #[test]
    fn 空令牌验证不联网直接报错() {
        let e = verify_token("   ").unwrap_err();
        assert!(e.contains("还没填令牌"), "{e}");
        // 粘贴垃圾要洗掉再判断（否则 "ghp_x\n" 会被当成有效令牌去请求）
        assert!(effective_token("  \"ghp_x\"\n").is_some());
    }
}
