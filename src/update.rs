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

/// 备用下载源：`api.github.com` 上的资产入口。
///
/// 用法是 `GET` 这个地址 **并且** 带 `Accept: application/octet-stream`
/// （不带就只回一份 JSON 元数据，不是二进制）。
///
/// 和 `browser_download_url` 的区别只在**入口域名**：两者最后都 302 到同一个
/// CDN。但入口这一步恰恰是最容易卡住的 —— 本机实测 `github.com:443` 会
/// 间歇性 502，而 `api.github.com` 一直通。
///
/// ⚠ `QS_GITHUB_ASSET_API` 是测试逃生口（和 `QS_UPDATE_API` 同一类）：
/// 探针的假服务没法提供真资产 id，不给逃生口就会在测试里打真网。
fn asset_api(id: u64) -> String {
    let base = std::env::var("QS_GITHUB_ASSET_API")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases/assets"));
    format!("{}/{id}", base.trim_end_matches('/'))
}

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
    /// 更新包的下载地址（exe 资产，`browser_download_url`）
    pub url: String,
    /// 同一个资产的**API 入口**：`api.github.com/repos/.../releases/assets/{id}`。
    ///
    /// 为什么两条都要：两者最终都 302 到同一个 CDN，但**入口域名不同**。
    /// 本机实测 `github.com:443` 会间歇性 502（git push 连续 10 轮不通），
    /// 而同期的 `api.github.com` 一直 200。只留一条路，就变成
    /// 「能检测到新版、但下载总失败」—— 那正是用户报的现象。
    /// 空串 = 这次响应里没解析到 id（老数据 / 假服务），那就只有主源。
    pub asset_api_url: String,
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
            asset_api_url: String::new(),
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

/// `/rate_limit` 的地址（逃生口与上面几个同一个套路）。
///
/// ⚠ 这个端点和别的**不一样**：GitHub 明文规定查它**不计入**额度。
/// 所以"打开设置页就显示用了多少次"才可以做成常驻的 ——
/// 用 `/user` 去数的话，用户每开一次设置页就烧掉一次配额。
fn rate_api() -> String {
    if let Ok(b) = std::env::var("QS_GITHUB_RATE_API") {
        if !b.trim().is_empty() {
            return b;
        }
    }
    "https://api.github.com/rate_limit".to_string()
}

/// 当前接口额度的快照。给设置页那行「已用 X 次 / 共 Y 次」用。
#[derive(Debug, Clone, PartialEq)]
pub struct RateState {
    /// 这次查询**实际**带没带令牌（没填 / 被拒都会是 false）
    pub authed: bool,
    /// 每小时上限：有令牌 5000，匿名 60
    pub limit: u64,
    /// 本小时还剩多少
    pub remaining: u64,
    /// 额度重置的时刻（unix 秒）
    pub reset: u64,
}

impl RateState {
    /// 本小时已经用掉多少次。
    ///
    /// `saturating_sub` 而不是 `-`：GitHub 偶尔会给出 `remaining > limit`
    /// 的瞬时值（改了配额、或者中间缓存），减法会下溢 panic。
    pub fn used(&self) -> u64 {
        self.limit.saturating_sub(self.remaining)
    }
}

/// 查一次额度。
///
/// 只认响应头，不解析 body —— `x-ratelimit-limit/remaining/reset` 一定在，
/// 而 body 的 `resources.core` 形状哪天变了不该让这一行整个崩掉。
///
/// ⚠ 头和 body 的顺序：**先读头，再 `into_string()`**。反了头就没了
/// （`api_latest` 里踩过同一个坑）。
pub fn rate_state() -> Result<RateState, String> {
    let tok = current_token();
    let a = agent();
    let mut req = a
        .get(&rate_api())
        .set("Accept", "application/vnd.github+json");
    if let Some(t) = tok.as_deref() {
        req = req.set("Authorization", &format!("Token {t}"));
    }
    let resp = req.call().map_err(|e| match e {
        ureq::Error::Status(code, r) => {
            let _ = r.into_string();
            format!("查额度失败：GitHub 返回 HTTP {code}")
        }
        other => crate::ocr::explain(&other),
    })?;
    let num = |h: &str| -> u64 {
        resp.header(h)
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let st = RateState {
        authed: tok.is_some(),
        limit: num("x-ratelimit-limit"),
        remaining: num("x-ratelimit-remaining"),
        reset: num("x-ratelimit-reset"),
    };
    // 头已经读完了，body 不要了（但必须消费掉，否则连接不归还）
    let _ = resp.into_string();
    if st.limit == 0 {
        return Err("GitHub 没给额度信息（响应头里没有 x-ratelimit-limit）".to_string());
    }
    Ok(st)
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
    let mut asset_id = 0u64;
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
                asset_id = a.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                break;
            }
        }
    }
    if newer && url.is_empty() {
        return Err(format!("{tag} 这个版本里没有 QuickSearch.exe 更新包"));
    }
    /* 备用源：拿得到 id 才拼得出来。假服务 / 很老的响应可能没有 id，
     * 那就只有主源一条路（`download()` 照常工作，只是少了保险）。 */
    let asset_api_url = if asset_id > 0 {
        asset_api(asset_id)
    } else {
        String::new()
    };

    Ok(UpdateInfo {
        version,
        tag,
        newer,
        current: current.to_string(),
        sha256: sha_from_notes(&notes),
        notes,
        url,
        asset_api_url,
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

/// 下载重试轮数（每轮依次试所有可用源）。
///
/// 3 而不是 5：实测「主源连不上」时要白等一个连接超时，轮数越多用户干等越久。
/// 而真正的网络抖动通常 1~2 轮内就恢复了。
const DL_ATTEMPTS: usize = 3;
/// 第 n 轮失败后的等待（毫秒，线性退避：700 / 1400）。
const DL_BACKOFF_MS: u64 = 700;

/// 下载请求的失败文案（**不带**"下载失败"前缀 —— 外层会统一加，
/// 免得出现"下载失败：下载更新包失败：HTTP 404"这种结巴）。
fn download_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            let head: String = body.chars().take(120).collect();
            format!("HTTP {code} {head}")
        }
        other => crate::ocr::explain(&other),
    }
}

/// 下载专用的 agent：**不设总超时**。
///
/// # 这是「能检测到新版、但下载总失败」的头号原因
///
/// `agent()` 用的是 `.timeout(15s)`。在 ureq 里它是**整个调用**的上限：
/// DNS + 连接 + TLS + **把响应体读完**全算在里面。13 MB 的更新包在 15 MB/s
/// 下当然够，可 300 KB/s 就要 45 秒 —— 必然被掐断。而且断在 `read()`
/// 上，报出来是「下载中断」，看着像网络问题，其实是自己设的闸。
///
/// 这里只限制**建连接**和**两次读之间的空等**：连不上放弃（真不通就别耗着），
/// 但只要还在往下走，下多久都行。
///
/// 连接超时取 8 秒而不是 15：实测「主源域名不通」是最常见的失败（本机
/// `github.com` 直连超时、`api.github.com` 正常），一个连不上的源要白白
/// 等掉一整个超时。8 秒足够正常的 TLS 握手，又不至于让用户对着 0% 干等。
fn download_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .resolver(crate::net::ipv4_first)
        .timeout_connect(std::time::Duration::from_secs(8))
        .timeout_read(std::time::Duration::from_secs(60))
        .timeout_write(std::time::Duration::from_secs(60))
        .user_agent(concat!("QuickSearch/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// 一次下载尝试怎么失败的 —— 决定**断点留不留**。
enum DlFail {
    /// 传输层中断（连接断、读超时、写盘失败）：**保留断点**，下一轮用 Range 接着下
    Keep(String),
    /// 内容层不对（HTTP 4xx / 校验失败 / 大小不符）：**丢掉断点**，下轮从头来
    Drop(String),
}

impl DlFail {
    fn message(&self) -> &str {
        match self {
            DlFail::Keep(m) | DlFail::Drop(m) => m,
        }
    }
    fn keep_partial(&self) -> bool {
        matches!(self, DlFail::Keep(_))
    }
}

/// 更新包的两个下载源，按尝试顺序。
///
/// 两个地址最后都 302 到同一个 CDN，但**入口域名不同**。本机实测
/// `github.com:443` 会间歇性 502（`git push` 连续 10 轮不通），同期的
/// `api.github.com` 一直 200。只留一条路，就会变成"能检测到、下不下来"。
fn sources(info: &UpdateInfo) -> Vec<(String, bool)> {
    let mut v = Vec::new();
    if !info.url.trim().is_empty() {
        v.push((info.url.trim().to_string(), false));
    }
    if !info.asset_api_url.trim().is_empty() {
        v.push((info.asset_api_url.trim().to_string(), true));
    }
    v
}

/// 校验落盘的这份是不是我们要的那一份。
///
/// 从**文件**重算 SHA，而不是复用下载过程里的增量 hash —— 续传时前面那段
/// 字节不在本次流里，增量 hash 必然对不上。13 MB 重读一遍几十毫秒，
/// 换来一段不会出错的代码。
fn verify_file(path: &Path, info: &UpdateInfo) -> Result<(), String> {
    use std::io::Read;
    use sha2::Digest;

    let mut f = std::fs::File::open(path).map_err(|e| format!("校验时读不到更新包：{e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut len = 0u64;
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("校验时读文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    if info.size > 0 && len != info.size {
        return Err(format!("更新包大小不对（期望 {}，实际 {len}）", info.size));
    }
    if !info.sha256.is_empty() {
        let got = format!("{:X}", hasher.finalize());
        if got != info.sha256 {
            return Err(format!(
                "更新包校验失败（SHA256 对不上）：期望 {}，实际 {got}",
                info.sha256
            ));
        }
    }
    Ok(())
}

/// 从一个源往 `path` 里下（或续）。成功 = 文件已完整且校验通过。
fn fetch_into(
    a: &ureq::Agent,
    url: &str,
    is_api: bool,
    info: &UpdateInfo,
    path: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), DlFail> {
    use std::io::{Read, Write};

    let total = info.size;
    let mut have = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    /* 断点比目标还大 → 一定不是这个包（多半是上一版留下的）。
     * 不处理的话续传会拼出一份更大的垃圾，校验才报错，白下一轮。 */
    if total > 0 && have > total {
        let _ = std::fs::remove_file(path);
        have = 0;
    }
    // 已经下满：一字节都不用读，直接校验（续传的收尾就是这种情况）
    if total > 0 && have == total {
        return verify_file(path, info).map_err(DlFail::Drop);
    }

    let build = |a: &ureq::Agent, token: Option<&str>| {
        let mut r = a.get(url);
        if is_api {
            // 不带这个头，API 只回一份 JSON 元数据，不是二进制
            r = r.set("Accept", "application/octet-stream");
        }
        if have > 0 {
            r = r.set("Range", &format!("bytes={have}-"));
        }
        if let Some(t) = token {
            r = r.set("Authorization", &format!("Token {t}"));
        }
        r
    };

    /* 匿名优先：公开资产匿名一定能下；拿一个"对这个仓库没权限"的令牌去下，
     * 反而可能被拒（旧逻辑踩过）。被拒且确实配了令牌时，才带令牌重试一次。 */
    let resp = match build(a, None).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) if matches!(code, 401 | 403 | 404) => {
            match current_token() {
                Some(t) => {
                    crate::win::log(&format!(
                        "update: {url} 匿名被拒（HTTP {code}），带令牌重试"
                    ));
                    build(a, Some(&t))
                        .call()
                        .map_err(|e| DlFail::Drop(download_error(e)))?
                }
                None => {
                    return Err(DlFail::Drop(format!(
                        "HTTP {code} —— 这个包可能不是公开的，在「更新」里填个令牌再试"
                    )))
                }
            }
        }
        Err(e) => return Err(DlFail::Keep(download_error(e))),
    };

    let code = resp.status();
    /* 206 = 服务器接受了 Range；200 = 它忽略了（或我们本来就没发）。
     * 忽略时必须 `create` 从 0 写，用 append 会把新内容接在旧字节后面。 */
    let append = code == 206 && have > 0;
    if code != 200 && code != 206 {
        return Err(DlFail::Drop(format!("HTTP {code}")));
    }
    let mut file = if append {
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|e| DlFail::Keep(format!("打开断点文件失败：{e}")))?
    } else {
        std::fs::File::create(path)
            .map_err(|e| DlFail::Keep(format!("写更新包失败（磁盘满？）：{e}")))?
    };

    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = if append { have } else { 0 };
    let mut last_pct = -1i64;
    if done > 0 {
        crate::win::log(&format!("update: 从 {done} 字节处续传 {url}"));
    }
    loop {
        /* ⚠ 这里是"网络断了"最常见的位置。保留断点让下一轮用 Range 接着下 ——
         *   以前这里直接抛错，13 MB 下到 90% 断一次就全废，用户只能从头再点，
         *   而且重来还是从 0 开始。这才是"下载不顺利"的真实体感。 */
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                return Err(DlFail::Keep(format!(
                    "下载中断（已下 {done} 字节）：{e}"
                )))
            }
        };
        if n == 0 {
            break;
        }
        if let Err(e) = file.write_all(&buf[..n]) {
            return Err(DlFail::Keep(format!("写文件失败：{e}")));
        }
        done += n as u64;
        if total > 0 {
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

    if total > 0 && done < total {
        // 流干净地结束了但没下满 —— 连接被对端关了，属于可续的失败
        return Err(DlFail::Keep(format!(
            "下载提前结束（{done}/{total} 字节）"
        )));
    }
    verify_file(path, info).map_err(DlFail::Drop)
}

/// 下载更新包到 `<exe 同目录>/QuickSearch.exe.new`，返回落地路径。
///
/// `progress(已下, 总)`：给前端画进度条用（和模型下载同一个套路）。
///
/// ⚠ 落点**必须在 exe 同目录**：跨盘 `rename` 会失败（EXDEV），
/// 而后面替换那一步就是同目录内的两次 rename。放 %TEMP% 再搬过来是行不通的
/// ——实测那样做要么失败、要么得整份复制（多花一份时间与空间）。
///
/// # v1.5.11：这条路上补了三样东西
///
/// 用户报「能检测到新版，但下载不下来」。查下来是三个独立的坑叠在一起：
///
/// 1. **总超时 15 秒**（`agent()` 的 `.timeout`）—— 慢网络下 13 MB 根本下不完，
///    断在 `read()` 上却报成"下载中断"。下载改用 [`download_agent`]。
/// 2. **断了就从 0 重来** —— 没有 Range、没有重试。下到 90% 断一次就全废。
///    现在按断点续传，失败后自动退避重试。
/// 3. **只有一条下载链路**（`github.com`）—— 而这条正是本机最不稳的一条。
///    现在失败会换 `api.github.com` 的资产入口再试。
///
/// 失败时**保留断点**：下次用户再点，能接着下完（内容真不对时校验会兜住，
/// 自动丢弃重来）。
pub fn download(
    info: &UpdateInfo,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("取不到当前程序路径：{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "程序路径没有父目录？".to_string())?
        .to_path_buf();
    let new_path = dir.join("QuickSearch.exe.new");

    let srcs = sources(info);
    if srcs.is_empty() {
        return Err("这个版本没有可用的下载地址 —— 请点「用浏览器下载」".to_string());
    }
    let a = download_agent();
    let mut last = String::from("下载失败");
    for round in 1..=DL_ATTEMPTS {
        for (url, is_api) in &srcs {
            match fetch_into(&a, url, *is_api, info, &new_path, progress) {
                Ok(()) => {
                    crate::win::log(&format!(
                        "update: 已下载 {}（第 {round} 轮，源 {url}）",
                        new_path.display()
                    ));
                    return Ok(new_path);
                }
                Err(f) => {
                    let keep = f.keep_partial();
                    last = f.message().to_string();
                    if !keep {
                        /* 内容不对：断点必须作废。留着的话下一轮会接着往上拼，
                         * 永远拼不出正确的文件。 */
                        let _ = std::fs::remove_file(&new_path);
                    }
                    crate::win::log(&format!(
                        "update: 第 {round} 轮失败（{}）{url} —— {last}",
                        if keep { "保留断点" } else { "丢弃断点" }
                    ));
                }
            }
        }
        if round < DL_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(
                DL_BACKOFF_MS * round as u64,
            ));
        }
    }
    Err(format!(
        "{last}（已自动重试 {DL_ATTEMPTS} 轮）—— 网络一直不稳的话，点「用浏览器下载」"
    ))
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

    /* ── v1.5.11：下载韧性 ──────────────────────────────────────────
     *
     * 用户报「能检测到新版，但下载不下来」。三个坑里有两个能在纯逻辑层
     * 钉住：**源的选择顺序**、**失败分类**（决定断点留不留）。
     * 续传本身要真网络，由探针验。 */

    fn dl_info() -> UpdateInfo {
        UpdateInfo {
            version: "99.0.0".into(),
            tag: "v99.0.0".into(),
            newer: true,
            current: "1.0.0".into(),
            notes: String::new(),
            url: String::new(),
            asset_api_url: String::new(),
            size: 0,
            sha256: String::new(),
            page: String::new(),
            authed: false,
            auth_warning: None,
        }
    }

    /// 主源（github.com）在前，备源（api 资产入口）在后，都带"要不要 Accept 头"。
    #[test]
    fn 下载源主备顺序() {
        let mut i = dl_info();
        i.url = "https://github.com/o/r/releases/download/v1/QuickSearch.exe".into();
        i.asset_api_url = "https://api.github.com/repos/o/r/releases/assets/42".into();
        let s = sources(&i);
        assert_eq!(s.len(), 2, "两条路都要留着");
        assert_eq!(s[0].1, false, "主源走 browser_download_url，不需要 Accept 头");
        assert_eq!(s[1].1, true, "备源必须带 Accept: application/octet-stream");
        assert!(s[0].0.contains("releases/download"));

        // 老响应 / 假服务可能没有 asset id → 只有一条路，仍能下
        i.asset_api_url = String::new();
        assert_eq!(sources(&i).len(), 1);
        assert_eq!(sources(&i)[0].1, false);

        // 连主源都没有 → 空；download() 据此报"没有可用下载地址"
        i.url = String::new();
        assert!(sources(&i).is_empty());
    }

    /// 失败分类决定断点留不留 —— 这条错了会"永远拼不出正确的包"。
    #[test]
    fn 传输失败留断点内容失败丢断点() {
        assert!(
            DlFail::Keep("网络断了".into()).keep_partial(),
            "传输中断必须保住已下的部分，否则每次重来都从 0 开始"
        );
        assert!(
            !DlFail::Drop("校验不过".into()).keep_partial(),
            "内容不对必须丢掉断点，否则下一轮接着往上拼，越拼越错"
        );
        assert_eq!(DlFail::Keep("a".into()).message(), "a");
        assert_eq!(DlFail::Drop("b".into()).message(), "b");
    }

    /// 备源地址拼得对，并且测试逃生口生效（否则探针会打真网）。
    #[test]
    fn 备源地址与逃生口() {
        // 改进程级环境变量，和 config 那批测试共用一把锁，免得互相看到对方的值
        let _env = crate::config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let id = 673_052_494u64;
        std::env::remove_var("QS_GITHUB_ASSET_API");
        let real = asset_api(id);
        assert!(real.starts_with("https://api.github.com/repos/"));
        assert!(real.ends_with("/releases/assets/673052494"), "{real}");

        std::env::set_var("QS_GITHUB_ASSET_API", "http://127.0.0.1:9/assets/");
        let local = asset_api(id);
        assert_eq!(local, "http://127.0.0.1:9/assets/673052494", "尾斜杠要吃掉");
        std::env::remove_var("QS_GITHUB_ASSET_API");
    }

    /// 两个下载测试都会写 `<exe 同目录>/QuickSearch.exe.new`，
    /// 并行跑会互相覆盖 —— 用一把锁串起来。
    static DL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 一个极简 TCP 服务：**第一次只发 40% 就关连接**，之后按 Range 正常续。
    ///
    /// # 为什么要自己造这么一个东西
    ///
    /// 断点续传的核心风险是**拼接错位**（少拼一段、多拼一段、把旧字节接在
    /// 新内容后面），这种错误编译期发现不了，真网络也没法稳定复现"恰好断在
    /// 40%"。所以用本地 socket 精确控制。
    ///
    /// 返回 `(端口, 命中计数)`：计数用来断言"第二次请求真的带上了 Range"。
    fn spawn_flaky_server(
        body: Vec<u8>,
        cut_at: usize,
    ) -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let l = TcpListener::bind("127.0.0.1:0").expect("绑不了本地端口");
        let port = l.local_addr().unwrap().port();
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let h2 = hits.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let n = h2.fetch_add(1, Ordering::SeqCst);
                // 把请求头读出来（只要 Range 那一行）
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let req = String::from_utf8_lossy(&buf).to_string();
                let range = req
                    .lines()
                    .find(|ln| ln.to_ascii_lowercase().starts_with("range:"))
                    .and_then(|ln| ln.split('=').nth(1))
                    .and_then(|v| v.split('-').next())
                    .and_then(|v| v.trim().parse::<usize>().ok());
                if n == 0 {
                    // 第一次：**声称**完整长度，只发 40% 就 close
                    // （客户端会看到 EOF 早于 Content-Length —— 和真网络被掐断一样）
                    let _ = write!(
                        s,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                        body.len()
                    );
                    let _ = s.write_all(&body[..cut_at]);
                    let _ = s.flush();
                } else {
                    let start = range.unwrap_or(0);
                    let _ = write!(
                        s,
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\n\
                         Content-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                        start,
                        body.len() - 1,
                        body.len(),
                        body.len() - start
                    );
                    let _ = s.write_all(&body[start..]);
                    let _ = s.flush();
                }
            }
        });
        (port, hits)
    }

    /// **本轮的旗舰测试**：下到一半断了，第二次要接着下，而不是从 0 重来。
    ///
    /// 用户报「能检测到新版，但下载不下来」。旧代码在这里的表现是：
    /// 断一次 → 整个失败 → 用户再点 → **还是从 0 开始** → 在不稳的网络上
    /// 永远下不完。这条测试把这个行为钉死。
    #[test]
    fn 下载断了能续上而不是从头再来() {
        use sha2::Digest;
        use std::sync::atomic::Ordering;

        let _g = DL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // 造一份 64KB 的假更新包（内容有规律但不重复，拼错会立刻暴露）
        let body: Vec<u8> = (0..65_536usize).map(|i| (i % 251) as u8).collect();
        let want_sha = format!("{:X}", sha2::Sha256::digest(&body));
        let cut = body.len() * 4 / 10;
        let (port, hits) = spawn_flaky_server(body.clone(), cut);

        let mut info = dl_info();
        info.url = format!("http://127.0.0.1:{port}/QuickSearch.exe");
        info.size = body.len() as u64;
        info.sha256 = want_sha;

        let p = download(&info, &mut |_, _| {}).expect("断一次之后必须能续上下完");
        let got = std::fs::read(&p).expect("读不到落盘的更新包");

        assert_eq!(got.len(), body.len(), "最终大小必须是完整的");
        assert_eq!(got, body, "续传拼接的内容必须一字节不差");
        assert!(
            hits.load(Ordering::SeqCst) >= 2,
            "应当至少请求两次（第一次断、第二次续）"
        );
        let _ = std::fs::remove_file(&p);
    }

    /// 断点已经完整时不该再下一遍 —— 直接校验通过就返回。
    #[test]
    fn 断点已完整时不用重下() {
        use sha2::Digest;

        let _g = DL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let body: Vec<u8> = (0..8_192usize).map(|i| (i % 97) as u8).collect();
        let mut info = dl_info();
        info.size = body.len() as u64;
        info.sha256 = format!("{:X}", sha2::Sha256::digest(&body));

        let exe = std::env::current_exe().unwrap();
        let p = exe.parent().unwrap().join("QuickSearch.exe.new");
        std::fs::write(&p, &body).unwrap();

        // 一个**必然连不上**的地址：如果它还去下载，就会失败
        info.url = "http://127.0.0.1:1/QuickSearch.exe".into();
        let got = download(&info, &mut |_, _| {});
        assert!(got.is_ok(), "断点已经完整时应当直接通过，不该真的去下载");
        assert_eq!(std::fs::read(&p).unwrap(), body);
        let _ = std::fs::remove_file(&p);
    }

    /// 【手动跑，默认 ignore】对**真 GitHub** 下载一次，验证新下载器能下完。
    ///
    /// 默认不跑：它要联网、要几秒，CI 上会挂。发版前手动来一次：
    ///
    /// ```text
    /// cargo test 真实下载 -- --ignored --nocapture
    /// ```
    ///
    /// 为什么值得手动跑：本地假服务证明的是"续传逻辑对"，证明不了
    /// "对着真 GitHub 的 302 → CDN 链路也能下完"。这两件事失败的原因完全不同。
    #[test]
    #[ignore]
    fn 真实下载一次() {
        let _g = DL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let mut info = dl_info();
        info.version = "1.5.10".into();
        /* ⚠ 这里**必须**填上备源。本机实测：`github.com` 直连超时
         * （curl 能通是因为它走了系统代理，ureq 不走系统代理），
         * 而 `api.github.com` 直连是通的 —— 检测更新能用就是证据。
         * 只留主源，这条测试必然失败；填上备源才下得来。
         * 这正是「能检测到新版、却下载不下来」的机械原因。 */
        info.asset_api_url = asset_api(673_052_494);
        info.url =
            "https://github.com/QQQOrange/QuickSearch/releases/download/v1.5.10/QuickSearch.exe"
                .into();
        info.size = 13_415_936;
        info.sha256 = "8723CDCFE6F00DFEDC744ADE15973D03FE1D0BA998B883C7FBBA1232F452AF35".into();

        let mut last = 0u64;
        let p = download(&info, &mut |d, t| {
            if d >= last + 4 * 1024 * 1024 {
                last = d;
                println!("  已下 {d} / {t}");
            }
        })
        .expect("对真 GitHub 的下载应当成功");
        let n = std::fs::metadata(&p).unwrap().len();
        println!("  落地 {n} 字节");
        assert_eq!(n, 13_415_936, "大小必须和 release 资产一致");
        let _ = std::fs::remove_file(&p);
    }

    /// 【手动跑，默认 ignore】真实下载「先断一次再续」的另一种证明：
    /// 先用 Range 只取前半段放进 .new，再调 download() 让它续完。
    ///
    /// ```text
    /// cargo test 真实续传 -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn 真实续传从半个文件接着下() {
        let _g = DL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let exe = std::env::current_exe().unwrap();
        let p = exe.parent().unwrap().join("QuickSearch.exe.new");
        std::fs::write(&p, Vec::<u8>::new()).unwrap();

        // 造一个"已经下了 5MB"的断点（内容用 Range 从真服务取，保证前缀正确）
        let a = download_agent();
        let url =
            "https://github.com/QQQOrange/QuickSearch/releases/download/v1.5.10/QuickSearch.exe";
        let mut r = a
            .get(url)
            .set("Range", "bytes=0-5242879")
            .call()
            .expect("取前 5MB 失败")
            .into_reader();
        let mut head = Vec::new();
        use std::io::Read;
        r.read_to_end(&mut head).expect("读前 5MB 失败");
        assert_eq!(head.len(), 5_242_880, "前半段大小不对");
        std::fs::write(&p, &head).unwrap();
        println!("  造好断点：{} 字节", head.len());

        let mut info = dl_info();
        info.url = url.into();
        info.size = 13_415_936;
        info.sha256 = "8723CDCFE6F00DFEDC744ADE15973D03FE1D0BA998B883C7FBBA1232F452AF35".into();
        info.asset_api_url = String::new();

        let got = download(&info, &mut |_, _| {}).expect("从断点续传应当成功");
        let n = std::fs::metadata(&got).unwrap().len();
        println!("  续传完成 {n} 字节");
        assert_eq!(n, 13_415_936);
        let _ = std::fs::remove_file(&got);
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

    /// 额度用量里的"已用次数"。
    ///
    /// 这一行会直接显示在设置页（"本小时已请求 N 次 / 共 M 次"），
    /// 算错一个数用户就会以为自己的配额被人偷了。
    #[test]
    fn 已用次数是上限减剩余() {
        let s = RateState { authed: true, limit: 5000, remaining: 4997, reset: 0 };
        assert_eq!(s.used(), 3);

        // 一次没用
        let s = RateState { authed: false, limit: 60, remaining: 60, reset: 0 };
        assert_eq!(s.used(), 0);

        // 用光
        let s = RateState { authed: true, limit: 5000, remaining: 0, reset: 0 };
        assert_eq!(s.used(), 5000);

        /* ⚠ GitHub 偶尔会给出 remaining > limit（刚改配额、中间缓存），
         *   普通减法在这里会下溢 panic。saturating_sub 兜住。 */
        let s = RateState { authed: true, limit: 60, remaining: 61, reset: 0 };
        assert_eq!(s.used(), 0, "remaining 比 limit 大时按 0 算，不能 panic");
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
