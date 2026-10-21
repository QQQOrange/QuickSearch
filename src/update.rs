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

/// 查一次最新版本。
///
/// 失败时给**人话**错误（网络不通 / 没有发布过 / 返回看不懂），
/// 调用方直接把它显示给用户或写进日志。
///
/// # 两段式：先"拿版本号"，必要时才"拿详情"（抗 API 限流）
///
/// GitHub 的 REST API 对**未认证**请求限到 60 次/小时，一台机器上多开几次
/// 设置页、或者跟别的工具共用公网 IP，很容易撞上限流 —— 实测就撞过一次
/// （`X-RateLimit-Remaining: 0`，回 403 且 body 为空）。用户那边的观感就是
/// "检查更新老是失败"。
///
/// 所以分成两步：
///  1. **版本号**：请求 `github.com/.../releases/latest`，**不做重定向**，
///     从 302 的 `Location` 里抠出 tag。这条**不计入 API 限流**，且极快。
///  2. **详情**（说明 / 下载地址 / 体积）：只有第 1 步判出"确实有新版"才去调
///     API —— 也就是说，日常"已是最新版"的情况**一次 API 都不消耗**。
pub fn check(current: &str) -> Result<UpdateInfo, String> {
    let tag = latest_tag().or_else(|e| {
        crate::win::log(&format!("update: 302 拿 tag 失败（{e}），退回用 API"));
        latest_tag_via_api()
    })?;
    let version = tag.trim_start_matches(['v', 'V']).to_string();
    let newer = is_newer(&version, current);

    /* 没有新版 → **不再调 API**，直接给一个"够用"的结果。
     * 调用方（手动检查）只需要知道"已是最新"，不需要说明与下载地址。 */
    if !newer {
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
        });
    }
    fill_details(tag, version, current)
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
    let j = api_latest()?;
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

/// 调一次 `releases/latest` API，返回整份 JSON。
fn api_latest() -> Result<serde_json::Value, String> {
    let a = agent();
    let resp = a
        .get(&latest_api())
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "这个仓库还没有发布过正式版本".to_string(),
            /* 403 / 429 基本都是限流。给人话 + 明确的"等一会儿再试"，
             * 而不是甩一个 "HTTP 403 Forbidden" 让用户猜。 */
            ureq::Error::Status(403, _) | ureq::Error::Status(429, _) => {
                "GitHub 接口暂时限流了（未登录请求每小时只有 60 次），过一会儿再试".to_string()
            }
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                let head: String = body.chars().take(120).collect();
                format!("GitHub 返回 HTTP {code}：{head}")
            }
            other => crate::ocr::explain(&other),
        })?;
    let text = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("返回的不是 JSON：{e}"))
}

/// 第 2 步：确实有新版时，去 API 拿说明 / 下载地址 / 体积。
fn fill_details(tag: String, version: String, current: &str) -> Result<UpdateInfo, String> {
    let v = api_latest()?;
    let notes = v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let page = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .unwrap_or(RELEASES_URL)
        .to_string();

    /* 挑更新包：资产名**恒为 QuickSearch.exe**（见 PUSH-GUIDE 的上传步骤）。
     * 挑不到就报错 —— 不能给用户一个"有新版但没有下载地址"的状态。 */
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
    if url.is_empty() {
        return Err(format!("{tag} 这个版本里没有 QuickSearch.exe 更新包"));
    }

    Ok(UpdateInfo {
        newer: true,
        sha256: sha_from_notes(&notes),
        notes,
        url,
        size,
        page,
        version,
        tag,
        current: current.to_string(),
    })
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
    let mut reader = a
        .get(&info.url)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                let head: String = body.chars().take(120).collect();
                format!("下载更新包失败：HTTP {code} {head}")
            }
            other => format!("下载更新包失败：{}", crate::ocr::explain(&other)),
        })?
        .into_reader();

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
}
