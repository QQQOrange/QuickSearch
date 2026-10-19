//! WebDAV 备份。
//!
//! 走的就是 WebDAV 最普通的两条路：`PUT` 一个 json 上去、`GET` 下来。
//! 之所以选 ureq 而不是 reqwest —— 它是**同步阻塞**的，不需要 tokio 运行时，
//! 直接丢进后台线程就能用；TLS 走 rustls（纯 Rust），不用碰系统 OpenSSL。
//! 整个模块不碰任何全局状态，纯粹「给一份配置、上传/下载一段文本」。

use std::time::Duration;

/// 连接参数（从 Config 里摘出来，免得这个模块依赖主程序）。
#[derive(Clone, Debug)]
pub struct Opts {
    /// 服务器地址，目录形式，例如 https://dav.jianguoyun.com/dav/QuickSearch/
    pub url: String,
    pub user: String,
    pub pass: String,
    /// 单次请求最长等多久（秒）。
    /// 退出时的同步要卡着进程退出，所以那边会把它调小，免得网盘不通时关不掉软件。
    pub timeout_secs: u64,
}

/// 老版本的固定备份文件名。
///
/// ⚠ **只用于"服务器列不出目录"时的兜底探测**，再也不参与任何上传命名。
/// 现在一次备份就是一个 `config(时间).QuickSearch` 新文件（见 `config::backup_name`），
/// 云端文件名跟本地完全一致 —— 用户明确要求「直接把本地的拉上去就可以了」。
pub const LEGACY_FILE: &str = "quicksearch-backup.json";

impl Opts {
    pub fn ready(&self) -> bool {
        !self.url.trim().is_empty()
    }

    /// 兜底探测用的固定文件 URL（只给 `remote_mtime` 用）
    fn target(&self) -> String {
        self.target_of(LEGACY_FILE)
    }

    fn target_of(&self, file: &str) -> String {
        let base = normalize_base(&self.url);
        let f = file.trim();
        let f = if f.is_empty() { LEGACY_FILE } else { f };
        base + &encode_seg(f)
    }
}

/// 软件默认在坚果云那类网盘下使用的子目录名。
pub const DEFAULT_SUBDIR: &str = "QuickSearch";

/// 已知的网盘「根地址」，用来判断用户填的是不是只给了半截。
///
/// 坚果云的 WebDAV 根就是 `https://dav.jianguoyun.com/dav/`，用户按惯例
/// 只填这一段，剩下的目录（`QuickSearch/`）本该由软件补齐 —— 让人自己去
/// 网页版建文件夹再建应用密码，是这个功能最容易卡住的一步。
const KNOWN_ROOTS: &[&str] = &[
    "https://dav.jianguoyun.com/dav/",
    "http://dav.jianguoyun.com/dav/",
];

/// 把用户在设置页填的地址整理成「可存进配置」的形态 —— **不含**软件自己的子目录。
///
/// 干两件事：
///   1. 补 `https://` —— WebDAV 地址没有协议头时，按 https 试（各家都是 https）；
///   2. 末尾补 `/` —— 后面还要往上拼文件名，不带斜杠会拼出 `...dav/xxjson`。
///
/// 另外做一件**兼容老配置**的事：早期版本会把软件自己的子目录一起写进配置，
/// 于是输入框里显示成 `https://dav.jianguoyun.com/dav/QuickSearch/`，
/// 用户看到会以为"这一段也得我手填"。这里把这种形态还原成纯根地址 ——
/// 子目录在真正使用的时候由 `normalize_base` 自动补回来，最终地址完全一样，
/// 只是配置里和界面上不再出现那一段（用户明确要求）。
pub fn normalize_input(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // 只有 host 部分没写协议时才补；已经写了 http:// 就尊重用户
    let mut s = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    if !s.ends_with('/') {
        s.push('/');
    }

    // 还原「已知根地址 + 默认子目录」：只有在前面那段确实是已知根地址时才剥，
    // 用户自己起的同名目录（前面不是根地址）原样保留。
    let suffix = format!("{DEFAULT_SUBDIR}/");
    if s.len() > suffix.len() && s.to_ascii_lowercase().ends_with(&suffix.to_ascii_lowercase()) {
        let prefix = &s[..s.len() - suffix.len()];
        if KNOWN_ROOTS.iter().any(|r| prefix.eq_ignore_ascii_case(r)) {
            return prefix.to_string();
        }
    }
    s
}

/// 把地址整理成「一定是目录、且带软件子目录」的形态 —— **真正发请求时用它**。
///
/// 在 `normalize_input` 的基础上多干一件事：只填了已知网盘根地址时，
/// 补上软件自己的子目录（`QuickSearch/`）。这样用户只要填
/// `https://dav.jianguoyun.com/dav/`，剩下的目录名和文件夹创建都由软件负责。
///
/// 保留用户已经填好的任意层级路径：`https://dav.jianguoyun.com/dav/我的备份/`
/// 不会被改动，也不会再多套一层目录。
pub fn normalize_base(raw: &str) -> String {
    let s = normalize_input(raw);
    if s.is_empty() {
        return s;
    }
    // 与已知根地址逐个比对（大小写、末尾斜杠都归一后再比）。
    let is_bare_root = KNOWN_ROOTS.iter().any(|r| s.eq_ignore_ascii_case(r));
    if is_bare_root {
        format!("{s}{DEFAULT_SUBDIR}/")
    } else {
        s
    }
}

/// 校验地址形态，给设置页即时反馈用。
pub fn validate_url(raw: &str) -> Result<String, String> {
    let s = normalize_base(raw);
    if s.is_empty() {
        return Err("还没填服务器地址".into());
    }
    let Some(rest) = s.split("://").nth(1) else {
        return Err("地址里没有协议和主机名".into());
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err("地址里没有主机名".into());
    }
    if !host.contains('.') && host != "localhost" {
        return Err(format!("主机名「{host}」看着不像服务器地址"));
    }
    if s.contains(' ') {
        return Err("地址里有空格，检查一下是不是复制多了".into());
    }
    Ok(s)
}

/// 把文件名编码成可以直接拼在目录 URL 后面的样子（给设置页预览用）。
pub fn encode_seg_for_preview(s: &str) -> String {
    encode_seg(s)
}

/// 云端目录里的一份备份。
#[derive(Clone, Debug)]
pub struct Backup {
    pub name: String,
    pub size: u64,
    /// 最后修改的 Unix 秒；服务器没给就是 0
    pub mtime: i64,
}

/// 列出云端目录里的备份文件，按「新的在前」排。
///
/// 用户需求：恢复的时候要能**选云端哪一份**，而不是只有「恢复唯一那份」。
/// 于是这里必须能把目录列出来。
///
/// 用 PROPFIND（Depth: 1）—— 这是 WebDAV 列举的标准方法，坚果云 / Nextcloud /
/// 群晖都支持。为了兼容那些只认 GET 的服务器，PROPFIND 失败时再退回
/// GET + 解析 HTML 目录页；两条路都失败才报错。
pub fn list(o: &Opts) -> Result<Vec<Backup>, String> {
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    let dir = normalize_base(&o.url);
    if dir.is_empty() {
        return Err("还没填 WebDAV 地址".into());
    }
    let a = agent(o);
    match propfind(&a, o, &dir) {
        Ok(v) => Ok(v),
        // 只认 GET 的服务器：退化到解析目录页。
        //
        // ⚠ 这里**必须留痕**。以前是 `Err(_) => list_by_get(...)`，一个字都不记：
        //   于是"PROPFIND 到底成功没有"完全无从判断，两条路都失败时外面看到的
        //   还只是 GET 的错误，PROPFIND 的原因就此消失 —— 轮 20 排查
        //   "云端保留 0 份"就是这么卡住的，最后只能靠给这里加日志才定位到。
        Err(e) => {
            crate::win::log(&format!(
                "webdav: PROPFIND 列目录失败（{e}），退回解析 HTML 目录页"
            ));
            list_by_get(&a, o, &dir)
        }
    }
}

/// PROPFIND Depth:1
fn propfind(a: &ureq::Agent, o: &Opts, dir: &str) -> Result<Vec<Backup>, String> {
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/>
<D:getlastmodified/></D:prop></D:propfind>"#;
    let mut r = a
        .request("PROPFIND", dir)
        .set("Depth", "1")
        .set("Content-Type", "application/xml; charset=utf-8");
    if let Some(h) = auth_header(o) {
        r = r.set("Authorization", &h);
    }
    let resp = match r.send_string(body) {
        Ok(x) => x,
        Err(e) => return Err(explain(&e)),
    };
    let text = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    parse_multistatus(&text, dir)
}

/// 从 `207 Multi-Status` 里抽出文件列表。
///
/// 只留 resourcetype **不是** collection 的那些 —— 目录本身也出现在 Depth:1
/// 的结果里，把它当备份列出来会很奇怪。
/// 命名空间前缀各家不统一（`D:` / `d:` / 干脆没有），所以一律按小写标签名
/// 匹配，不写死前缀。
fn parse_multistatus(xml: &str, dir: &str) -> Result<Vec<Backup>, String> {
    let lower = xml.to_ascii_lowercase();
    let mut out: Vec<Backup> = Vec::new();

    // 按 `<…response` 这个**开标签**切段，段尾 = 下一个 response 的开标签
    // （或文档结尾）。
    //
    // ⚠ 两个踩过的坑，都表现为「一个文件都列不出来、外层却返回 Ok(())」：
    //   1) 一开始是从任意标签起点去找同名闭合标签，第一个匹配到的是
    //      `<D:multistatus>` 的标签名，于是一路跳到 `</D:multistatus>`，
    //      把整份响应当成一段跳过了；
    //   2) 改成「下一个 `<`」当段尾时，偏移是**相对 seg_end** 的，直接加到
    //      seg_end 上永远等于 seg_end+1，pos 不前进 → 死循环刷同一段。
    // 现在直接用 find 定位下一个 response 开标签，位置单调前进，不会绕圈。
    let dir_self = dir.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let mut search = 0usize;
    // 找形如 `<D:response` / `<response` 的开标签
    while let Some(start) = find_response_open(&lower, search) {
        let next = find_response_open(&lower, start + 1).unwrap_or(lower.len());
        search = start + 1;
        if next <= start {
            continue;
        }
        let seg = &xml[start..next];
        let segl = seg.to_ascii_lowercase();
        // 目录本身跳过
        if segl.contains("<collection") || segl.contains("<d:collection") {
            continue;
        }
        let Some(href) = tag_text(seg, "href") else { continue };
        // ⚠ 只在这里解一次（tag_text 已改成返回原文，见它的注释）
        let decoded = percent_decode(&href);
        let name = decoded.rsplit('/').next().unwrap_or("").trim().to_string();
        if name.is_empty() || name == dir_self {
            continue;
        }
        let size = tag_text(seg, "getcontentlength")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let mtime = tag_text(seg, "getlastmodified")
            .and_then(|s| parse_http_date(&s))
            .unwrap_or(0);
        out.push(Backup { name, size, mtime });
    }
    sort_newest_first(&mut out);
    Ok(out)
}

/// 找下一个 `<…response` 开标签的 `<` 位置；命名空间前缀可有可无。
fn find_response_open(lower: &str, from: usize) -> Option<usize> {
    let mut i = from;
    while let Some(rel) = lower[i..].find('<') {
        let abs = i + rel;
        let head = &lower[abs + 1..];
        let name_end = head
            .find([' ', '>', '/'])
            .unwrap_or(head.len());
        let name = &head[..name_end];
        // 「response」或「d:response」都算；但别把 <d:responsestatus> 也算进来
        let local = name.rsplit(':').next().unwrap_or(name);
        if local == "response" {
            return Some(abs);
        }
        i = abs + 1;
    }
    None
}

/// 取出某个标签的**原文**内容（忽略命名空间前缀，忽略大小写）。
///
/// ⚠ 这里**不做** percent-decode，解码由调用方做一次。以前它自己解、
///   `parse_multistatus` 又对结果解了一次 —— 文件名里只要带 `%` 就被解两遍
///   （`a%2541.txt` → `aA.txt`），下载会说"云端没有找到"，而 delete 把 404
///   当成功：删除"成功"但文件还在。
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let needle = format!(":{tag}>");
    let alt = format!(":{tag}/>");
    /* ⚠ 还要认**没有前缀**的写法。
     *
     * WebDAV 的 XML 有两种合法写法：带前缀（`<d:href>`）和默认命名空间
     * （`<multistatus xmlns="DAV:">…<href>`）。原来只找 `:{tag}>`，碰上后者
     * 一条都匹配不上 → `parse_multistatus` 返回**空列表**（不是 Err）→
     * 而 `list()` 只在 Err 时才回落 HTML 目录页 → 用户看到"云端一份备份都没有"，
     * 文件其实都好好躺在网盘里。同文件的 `find_response_open` 与 `<collection`
     * 判断本来就兼容两种写法，这里漏了。
     *
     * 顺序上**仍然优先带前缀的写法**：已经在用的服务器行为一个字节都不变，
     * 只有整份文档都没有带前缀写法时才退回无前缀形式（纯放宽，不可能改坏）。 */
    let plain = format!("<{tag}>");
    let (at, skip) = if let Some(i) = lower.find(&needle) {
        (i, needle.len())
    } else if let Some(i) = lower.find(&alt) {
        (i, alt.len())
    } else {
        let i = lower.find(&plain)?;
        (i, plain.len())
    };
    let rest = &xml[at + skip..];
    let end = rest.find('<')?;
    Some(rest[..end].trim().to_string())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(
                std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 「新的在前」。
///
/// ⚠ 平手时按**名字降序**，这个次序不是随便定的：
///   `parse_multiprop` 拿不到 `getlastmodified` 时 mtime 一律记 0
///   （"只认 GET" 的服务器走 `list_by_get`，那条路根本没有时间信息）。
///   于是**所有条目都是 0 分**，顺序完全由平手规则决定。如果平手按名字**升序**，
///   「保留最新 10 份」就会留下最旧的那 10 份、把用户**最新的备份删掉** ——
///   实测踩过一次（轮 20 探针里 12 → 10 删掉的正是 11、12 两份最新的）。
///   我们的备份名 `config(YYYY-MM-DD HH-MM-SS).QuickSearch` 是**零填充**的，
///   字典序 == 时间序，所以名字降序正好就是"新的在前"。
fn sort_newest_first(v: &mut [Backup]) {
    v.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| b.name.cmp(&a.name)));
}

/// 退化方案：GET 目录页，抠出 `<a href="…">`。
///
/// 只收「带扩展名形状」的链接，避免把服务端的导航链接（`../`、`?C=N;O=D`）
/// 也当成备份文件。
fn list_by_get(a: &ureq::Agent, o: &Opts, dir: &str) -> Result<Vec<Backup>, String> {
    let mut r = a.request("GET", dir);
    if let Some(h) = auth_header(o) {
        r = r.set("Authorization", &h);
    }
    let resp = match r.call() {
        Ok(x) => x,
        Err(ureq::Error::Status(404, _)) => return Ok(Vec::new()),
        Err(e) => return Err(explain(&e)),
    };
    let text = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    let lower = text.to_ascii_lowercase();
    let mut out: Vec<Backup> = Vec::new();
    let mut pos = 0usize;
    while let Some(i) = lower[pos..].find("<a ") {
        let abs = pos + i;
        let end = match lower[abs..].find('>') {
            Some(e) => abs + e,
            None => break,
        };
        let tag = &text[abs..end];
        pos = end + 1;
        let Some(href) = attr(tag, "href") else { continue };
        let decoded = percent_decode(&href);
        let name = decoded.rsplit('/').next().unwrap_or("").trim().to_string();
        if name.is_empty() || name == ".." || name == "." || name.starts_with('?') {
            continue;
        }
        // 只收看起来像文件的：带扩展名。
        //
        // ⚠ 上限写 6 的时候，**我们自己的备份名根本过不了这一关**：
        //   后缀是 `.QuickSearch`（11 个字符）。也就是说凡是"PROPFIND 用不了、
        //   只能靠解析 HTML 目录页"的服务器，备份列表永远是空的 ——
        //   界面上就是"云端一份备份都没有"，而文件明明躺在网盘里。
        //   放宽到 16（足够覆盖 .QuickSearch / .json / .backup），
        //   真正该排的是超长后缀那种明显不是备份的东西。
        let looks_file = name
            .rsplit_once('.')
            .map(|(_, e)| !e.is_empty() && e.len() <= 16)
            .unwrap_or(false);
        if !looks_file {
            continue;
        }
        out.push(Backup { name, size: 0, mtime: 0 });
    }
    sort_newest_first(&mut out);
    Ok(out)
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=\"");
    let at = lower.find(&needle)?;
    let start = at + needle.len();
    let end = tag[start..].find('"')?;
    Some(tag[start..start + end].to_string())
}

/// 按名字下载一份指定的备份（给「恢复哪一份」用）。
pub fn download_named(o: &Opts, name: &str) -> Result<String, String> {
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    // ⚠ 文件名是用户从云端列表里挑的，但仍然要防目录穿越：
    // 只要一个 `../` 就能读到配置目录之外的东西。
    let clean = name.trim().rsplit('/').next().unwrap_or("").trim();
    if clean.is_empty() || clean.contains("..") {
        return Err("备份文件名不合法".into());
    }
    let url = normalize_base(&o.url) + &encode_seg(clean);
    let a = agent(o);
    let mut r = a.request("GET", &url);
    if let Some(h) = auth_header(o) {
        r = r.set("Authorization", &h);
    }
    match r.call() {
        /* ⚠ 不能用 `into_string()`：ureq 对它的上限是 **10 MiB**，而备份允许到
         * 32 MiB（`MAX_BACKUP_BYTES`）。收藏夹塞满图片的合法备份会在这里报
         * "response too big for into_string" —— 而调用方此时已经 stash 过本地
         * 配置，用户看到的是"恢复失败"，白折腾一场。
         * 按上限读字节再转 UTF-8（备份本身就是 JSON 文本）。 */
        Ok(resp) => read_body_capped(resp, MAX_BACKUP_BYTES),
        Err(ureq::Error::Status(404, _)) => Err(format!("云端没有找到「{clean}」")),
        Err(e) => Err(explain(&e)),
    }
}

/// 备份文件的体积上限（32 MiB）—— 与 main.rs 的 `MAX_BACKUP_BYTES` 同一个数。
///
/// 为什么这里要单独有一份：那一个是 main.rs 里的私有常量，而
/// `download_named` 在 webdav 模块内、拿不到它。两边必须一致，改一处要改两处
/// （webdav 的测试里没有交叉断言，只能靠注释提醒）。
pub const MAX_BACKUP_BYTES: u64 = 32 * 1024 * 1024;

/// 按字节上限读响应体，超限给一句人话错误。
fn read_body_capped(resp: ureq::Response, cap: u64) -> Result<String, String> {
    use std::io::Read;
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut rd = resp.into_reader().take(cap + 1);
    rd.read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if buf.len() as u64 > cap {
        return Err(format!(
            "备份文件太大（超过 {} MiB 上限），无法直接恢复",
            cap / (1024 * 1024)
        ));
    }
    String::from_utf8(buf).map_err(|_| "云端文件不是 UTF-8 文本（可能已损坏）".to_string())
}

/// 删除云端的一份备份（DELETE）。
///
/// 给「云端备份管理」和「仅保留最近 N 份」用。两条口径：
///   * 文件名同样要防目录穿越（跟 `download_named` 一个道理）；
///   * **404 当成成功** —— 用户看到列表到点删除之间，文件可能已经被别的设备
///     删掉了。这时候报"删除失败"只会让人以为没删干净，然后反复点。
pub fn delete_named(o: &Opts, name: &str) -> Result<(), String> {
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    let clean = name.trim().rsplit('/').next().unwrap_or("").trim();
    if clean.is_empty() || clean.contains("..") {
        return Err("备份文件名不合法".into());
    }
    let url = normalize_base(&o.url) + &encode_seg(clean);
    let a = agent(o);
    let mut r = a.request("DELETE", &url);
    if let Some(h) = auth_header(o) {
        r = r.set("Authorization", &h);
    }
    match r.call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(404, _)) => Ok(()),
        Err(e) => Err(explain(&e)),
    }
}

/// 路径分段百分号编码。
/// 中文、空格、`#` 这些直接塞进 URL 会被服务器当成别的东西，必须先编码。
fn encode_seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~') {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

fn agent(o: &Opts) -> ureq::Agent {
    let t = o.timeout_secs.clamp(3, 60);
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(t.min(6)))
        .timeout(Duration::from_secs(t))
        // ⚠ **不复用空闲连接**（0 = 一个都不留）。
        //
        // ureq 会把连接放进池子里复用，但它**不会**先探测对端是否已经关掉了
        // 这条连接。而"空闲几秒后被服务端/中间设备主动关闭"是常态：
        // Node 的默认 keepAliveTimeout 只有 5 秒，nginx 是 75 秒，家用路由、
        // 运营商 NAT 更短。下一次请求写进一个"半关"的 socket 就是直接 IO 失败。
        //
        // 实测（轮 20）：两次云操作之间歇了 40 秒，PROPFIND 必失败 →
        // `list()` 静默退化到"解析 HTML 目录页" → 那一路拿不到 mtime、
        // 还因为后缀长度限制认不出 `.QuickSearch`，结果就是**云端列表凭空空了**，
        // 而文件明明都在网盘里。表面症状和"网盘不支持列目录"一模一样，极难查。
        //
        // 我们的请求本来就零星（一次备份 = MKCOL + PUT 两个），
        // 为省这点握手开销去踩一个静默失败的坑完全不值。
        .max_idle_connections(0)
        .user_agent("QuickSearch/1.0 (Windows)")
        .build()
}

fn auth_header(o: &Opts) -> Option<String> {
    if o.user.trim().is_empty() {
        return None;
    }
    let raw = format!("{}:{}", o.user.trim(), o.pass);
    Some(format!("Basic {}", crate::config::base64(raw.as_bytes())))
}

/// 把 ureq 的错误翻译成用户能看懂的一句话。
fn explain(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let hint = match *code {
                401 => "账号或应用密码不对",
                403 => "这个账号没有权限写这个目录",
                404 => "路径不存在，检查一下服务器地址",
                405 => "服务器不接受这个操作，可能不是 WebDAV 地址",
                409 => "云端目录不存在",
                507 => "云端空间不够了",
                _ => "服务器返回了错误",
            };
            let body: String = resp
                .status_text()
                .chars()
                .take(60)
                .collect::<String>();
            format!("HTTP {code} —— {hint}（{body}）")
        }
        ureq::Error::Transport(t) => format!("连不上：{t}"),
    }
}

/// 逐级 MKCOL 建目录。返回成功新建了几层。
///
/// 「相关文件夹软件要自动创建」这条需求的关键就在这儿。以前建目录只在
/// PUT 失败之后才试，而且**失败就算了** —— 用户看到的是一句含糊的
/// 「HTTP 409」，根本不知道要去网页版手动建文件夹。
///
/// 现在：
///   * 每一级都从根往下逐个 MKCOL，中间哪层失败不阻断（服务器可能不支持 MKCOL）；
///   * 409 / 405 / 301 都算「目录已存在」，是正常情况；
///   * 把真正建成功的层数回报出去，调用方可以写进日志/提示。
fn mkcol_dirs(a: &ureq::Agent, o: &Opts, file_url: &str) -> usize {
    let dir = match file_url.rfind('/') {
        Some(i) => &file_url[..=i],
        None => return 0,
    };
    let scheme_end = dir.find("://").map(|i| i + 3).unwrap_or(0);
    let host_end = dir[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i + 1)
        .unwrap_or(dir.len());
    let mut acc = dir[..host_end].to_string();
    let mut made = 0usize;
    for seg in dir[host_end..].split('/').filter(|s| !s.is_empty()) {
        acc.push_str(seg);
        acc.push('/');
        let mut r = a.request("MKCOL", &acc);
        if let Some(h) = auth_header(o) {
            r = r.set("Authorization", &h);
        }
        match r.call() {
            // 2xx = 真建出来了
            Ok(_) => made += 1,
            // 405 Method Not Allowed / 409 Conflict / 301 都意味着「已经有这个目录」
            Err(ureq::Error::Status(405, _))
            | Err(ureq::Error::Status(409, _))
            | Err(ureq::Error::Status(301, _))
            | Err(ureq::Error::Status(200, _)) => {}
            Err(_) => {}
        }
    }
    made
}

/// 列目录，并保证**新的在前**。
///
/// 排序规则：先按服务器给的 mtime 倒序；mtime 全都拿不到（有些服务器不给
/// `getlastmodified`）时退化成**按名字倒序** —— 我们的名字里带时间戳，
/// 而且时间戳是 `YYYY-MM-DD HH-MM-SS` 这种定宽格式，字典序恰好等于时间序。
///
/// ⚠ 一律走这个函数、不要直接用 `list()`：`list()` 返回的是**服务器目录顺序**，
/// 各家的排列方式还不一样（有的按名字、有的按写入时间、有的干脆是 inode 序）。
/// 设置页的「从云端恢复」列表和「最新一份」的判定都建立在这个顺序上，
/// 少排一次就会出现「最新那份被排在中间」这种看起来像 bug 的东西。
pub fn list_newest_first(o: &Opts) -> Result<Vec<Backup>, String> {
    let mut v = list(o)?;
    sort_newest_first(&mut v);
    Ok(v)
}

/// 列目录、取**最新**的那一份备份。目录空 → Ok(None)。
///
/// 为什么要它：以前云端只有**一个固定文件名**，每次上传都是覆盖同一份 ——
/// 于是「云端备份列表」永远只有一条，用户做了很多次备份也只看到一个
/// （明确反馈过）。改成一备份一个带时间戳的文件之后，「最新一份」就必须靠
/// 列目录来解析，不能再靠固定名字。
pub fn latest(o: &Opts) -> Result<Option<Backup>, String> {
    Ok(list_newest_first(o)?.into_iter().next())
}

/// 上传一次备份到云端（PUT）。返回 Ok 表示服务器收下了。
///
/// 「相关的文件夹软件要自动创建」—— 所以这里**无条件**先把路径上的目录
/// 逐级 MKCOL 建出来，而不是等 PUT 报 409 才回头补救：
///
///   * 有些服务器第一次 PUT 会直接 5xx 而不是 409，靠「失败再补」那条路会直接失败；
///   * 建目录是幂等的，已存在的目录回 405/409，被当成成功忽略，代价只有一次
///     极快的请求开销。
///
/// ⚠ `file` 必须显式给：一次备份就是一个新文件名，云端因此会累积多份、
///   恢复时才有得挑。以前固定用一个名字反复覆盖，云端永远只有一条 ——
///   那是用户反馈的「做了很多次备份，列表里却只有一个」。
///   名字由 `config::backup_name()` 给（跟本地那份**完全同名**）。
pub fn upload_named(o: &Opts, file: &str, payload: &str) -> Result<(), String> {
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    let a = agent(o);
    let url = o.target_of(file);
    let made = mkcol_dirs(&a, o, &url);
    // Err 变体大是 ureq::Error 自身的设计（内含 272 字节的响应体缓冲）。
    // 这里闭包只在函数内部用一次、不进热路径，装箱反而要在每个调用点解包，
    // 得不偿失；且下方 match 要按 ureq::Error::Status 分支，保留原类型最直接。
    #[allow(clippy::result_large_err)]
    let put = |u: &str| {
        let mut r = a
            .request("PUT", u)
            .set("Content-Type", "application/json; charset=utf-8");
        if let Some(h) = auth_header(o) {
            r = r.set("Authorization", &h);
        }
        r.send_string(payload)
    };
    match put(&url) {
        Ok(_) => Ok(()),
        // 还是失败：再补一次目录（可能上面那轮 MKCOL 被服务器限流忽略了），
        // 重试一次，并把两次的失败原因都摆出来，别让用户猜。
        Err(e @ (ureq::Error::Status(409, _) | ureq::Error::Status(404, _))) => {
            let first = explain(&e);
            mkcol_dirs(&a, o, &url);
            put(&url).map(|_| ()).map_err(|e2| {
                let second = explain(&e2);
                let made_txt = if made > 0 {
                    format!("（已自动创建 {made} 层文件夹）")
                } else {
                    String::new()
                };
                if second == first {
                    format!("{first}{made_txt}；重试仍失败")
                } else {
                    format!("{first}{made_txt}；建目录后重试仍失败：{second}")
                }
            })
        }
        Err(e) => Err(explain(&e)),
    }
}

/// 云端备份的最后修改时间（Unix 秒）。
///
/// 启动同步判断「云端和本机谁新」，正常情况下用 `latest()` 从目录列表里拿；
/// 只有那台服务器**列不出目录**（既不支持 PROPFIND，也不给 HTML 目录页）时才
/// 退回这里，按固定文件名问一次 `Last-Modified`。
/// 先用 HEAD，服务器不支持 HEAD（405/501）就退回 GET 只看响应头。
pub fn remote_mtime(o: &Opts) -> Result<Option<i64>, String> {
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    let a = agent(o);
    let url = o.target();
    // 同 upload_named：Err 变体大是 ureq::Error 自身设计，下方要按 Status 分支，
    // 保留原类型最直接；闭包仅本函数内用，不进热路径。
    #[allow(clippy::result_large_err)]
    let call = |method: &str| {
        let mut r = a.request(method, &url);
        if let Some(h) = auth_header(o) {
            r = r.set("Authorization", &h);
        }
        r.call()
    };
    let resp = match call("HEAD") {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(ureq::Error::Status(405, _)) | Err(ureq::Error::Status(501, _)) => match call("GET") {
            Ok(r) => r,
            Err(ureq::Error::Status(404, _)) => return Ok(None),
            Err(e) => return Err(explain(&e)),
        },
        Err(e) => return Err(explain(&e)),
    };
    Ok(resp.header("Last-Modified").and_then(parse_http_date))
}

/// 测试连接。
///
/// 改成**列目录**来探活（原来是 GET 一个固定文件名的备份）。
/// 为什么改：现在一次备份就是一个带时间戳的新文件，固定名那份可能压根不存在 ——
/// 继续按「固定文件在不在」判会对着一个有一堆备份的目录说"还没有备份文件"。
///
/// **顺手把目录建好**：列不出来通常意味着地址是通的、只是目录还没建。
/// 建完再列一次，并把"建了几层"如实说出来 —— 「自动建文件夹」这件事要让用户
/// 看得见，不然失败了用户根本不知道云端到底缺了什么。
pub fn probe(o: &Opts) -> Result<String, String> {
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    let a = agent(o);
    let mut made = 0usize;
    // 报「最新」之前必须先排序（见 list_newest_first 的注释）：不排的话
    // 这句话就是"随便挑三个文件名说它是最新的"，用户拿去对照自己刚传的那份
    // 会发现对不上。
    match list_newest_first(o) {
        Ok(v) if !v.is_empty() => {
            let head: Vec<&str> = v.iter().take(3).map(|b| b.name.as_str()).collect();
            return Ok(format!(
                "连接成功，云端已有 {} 份备份（最新：{}）",
                v.len(),
                head.join("、")
            ));
        }
        Ok(_) => {}
        Err(_) => {
            made = mkcol_dirs(&a, o, &o.target());
        }
    }
    match list_newest_first(o) {
        Ok(v) if !v.is_empty() => Ok(format!("连接成功，云端已有 {} 份备份", v.len())),
        Ok(_) => Ok(format!(
            "连接成功，云端目录已就绪{}（还没有备份，点「立即备份（本地 + 云端）」传一份上去）",
            if made > 0 {
                format!("（新建了 {made} 层文件夹）")
            } else {
                String::new()
            }
        )),
        Err(e) => Err(e),
    }
}

/// 解析 HTTP 日期 `Sun, 06 Nov 1994 08:49:37 GMT` → Unix 秒。
/// 只认 RFC 1123 这一种（WebDAV 服务器返回的基本都是它）。
fn parse_http_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let rest = s.split_once(", ").map(|(_, r)| r).unwrap_or(s);
    let mut it = rest.split_whitespace();
    let day: i64 = it.next()?.parse().ok()?;
    let mon: i64 = match it.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = it.next()?.parse().ok()?;
    let mut t = it.next()?.split(':');
    let hh: i64 = t.next()?.parse().ok()?;
    let mm: i64 = t.next()?.parse().ok()?;
    let ss: i64 = t.next()?.parse().ok()?;
    Some(days_from_civil(year, mon, day) * 86400 + hh * 3600 + mm * 60 + ss)
}

/// Howard Hinnant 的 days_from_civil，把年月日换成 1970-01-01 起的天数。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_joins_cleanly() {
        let o = Opts {
            url: "https://dav.jianguoyun.com/dav/QS".into(),
            user: String::new(),
            pass: String::new(),
            timeout_secs: 15,
        };
        assert_eq!(o.target_of("b.json"), "https://dav.jianguoyun.com/dav/QS/b.json");

        let o2 = Opts {
            url: "https://x.com/dav/".into(),
            user: String::new(),
            pass: String::new(),
            timeout_secs: 15,
        };
        assert_eq!(
            o2.target_of("我的 备份.json"),
            "https://x.com/dav/%E6%88%91%E7%9A%84%20%E5%A4%87%E4%BB%BD.json"
        );
    }

    /// 用户只填坚果云根地址时，后续目录必须由软件补齐 ——
/// 这是本次需求的核心：**不该要求用户先去网页版手动建文件夹**。
#[test]
    fn jianguoyun_bare_root_gets_subdir_appended() {
        for raw in [
            "https://dav.jianguoyun.com/dav/",
            "https://dav.jianguoyun.com/dav",
            "  https://dav.jianguoyun.com/dav/  ",
            "http://dav.jianguoyun.com/dav/",
        ] {
            // http:// 是用户自己写的就尊重用户，不擅自升级成 https
            let scheme = if raw.trim_start().starts_with("http://") { "http" } else { "https" };
            assert_eq!(
                normalize_base(raw),
                format!("{scheme}://dav.jianguoyun.com/dav/{DEFAULT_SUBDIR}/"),
                "根地址 {raw:?} 没被自动补全"
            );
        }

        // 大小写不同也要认出来是「同一个根」——但**保留用户写的原样**。
        // URL 路径是大小写敏感的，擅自把 DAV 改成 dav 反而会打到不存在的路径上。
        assert_eq!(
            normalize_base("https://dav.jianguoyun.com/DAV/"),
            "https://dav.jianguoyun.com/DAV/QuickSearch/"
        );
    }

    /// 用户已经填好子目录时**不能**再多套一层 —— 那是把用户的路径搞坏了。
    #[test]
    fn explicit_subdir_is_never_doubled() {
        assert_eq!(
            normalize_base("https://dav.jianguoyun.com/dav/我的备份/"),
            "https://dav.jianguoyun.com/dav/我的备份/"
        );
        assert_eq!(
            normalize_base("https://dav.jianguoyun.com/dav/QuickSearch"),
            "https://dav.jianguoyun.com/dav/QuickSearch/"
        );
        assert_eq!(
            normalize_base("https://dav.jianguoyun.com/dav/a/b/c"),
            "https://dav.jianguoyun.com/dav/a/b/c/"
        );
    }

    /// 没写协议时按 https 补 —— WebDAV 地址漏掉协议头是最常见的输入错误。
    #[test]
    fn missing_scheme_defaults_to_https() {
        assert_eq!(normalize_base("dav.jianguoyun.com/dav/"), "https://dav.jianguoyun.com/dav/QuickSearch/");
        assert_eq!(normalize_base("nextcloud.example.com/webdav"), "https://nextcloud.example.com/webdav/");
        // 已经写了 http 的尊重用户，不擅自升级
        assert_eq!(normalize_base("http://x.com/dav/"), "http://x.com/dav/");
        assert_eq!(normalize_base(""), "");
    }

    /// `normalize_input` 是**存进配置**用的：只补协议和尾斜杠，
    /// **绝不**把软件自己的子目录写进去（用户要求地址栏只显示根地址）。
    #[test]
    fn input_form_keeps_the_bare_root() {
        assert_eq!(
            normalize_input("dav.jianguoyun.com/dav/"),
            "https://dav.jianguoyun.com/dav/"
        );
        assert_eq!(
            normalize_input("https://dav.jianguoyun.com/dav"),
            "https://dav.jianguoyun.com/dav/"
        );
        // 用户自己起的目录原样保留，不会被动
        assert_eq!(
            normalize_input("https://dav.jianguoyun.com/dav/我的备份/"),
            "https://dav.jianguoyun.com/dav/我的备份/"
        );
        assert_eq!(normalize_input(""), "");
    }

    /// 兼容老配置：早期版本会把 `QuickSearch/` 一起写进 config，
    /// 读进来要还原成纯根地址 —— 否则设置页的输入框里会显示那一段，
    /// 用户以为必须手填（这正是用户反馈的问题）。
    #[test]
    fn legacy_baked_in_subdir_is_stripped_from_input() {
        assert_eq!(
            normalize_input("https://dav.jianguoyun.com/dav/QuickSearch/"),
            "https://dav.jianguoyun.com/dav/"
        );
        // 剥掉之后，真正用的时候会再补回来 —— 最终地址一字不差
        assert_eq!(
            normalize_base("https://dav.jianguoyun.com/dav/QuickSearch/"),
            "https://dav.jianguoyun.com/dav/QuickSearch/"
        );
        // 同名目录但前面不是已知根地址 → 那是用户自己的路径，不许动
        assert_eq!(
            normalize_input("https://my.server/dav/QuickSearch/"),
            "https://my.server/dav/QuickSearch/"
        );
    }

    /// 存进配置的形态和真正发请求的形态，最终必须指向同一个地址。
    #[test]
    fn input_then_base_round_trips() {
        for raw in [
            "dav.jianguoyun.com/dav/",
            "https://dav.jianguoyun.com/dav/QuickSearch/",
            "https://dav.jianguoyun.com/dav/我的备份/",
            "nextcloud.example.com/webdav",
        ] {
            assert_eq!(
                normalize_base(&normalize_input(raw)),
                normalize_base(raw),
                "{raw:?} 存/用两种形态算出来的地址不一致"
            );
        }
    }

    /// 补全之后拼出来的完整地址，必须正好落在软件自己的目录里。
    /// （`target()` 现在只服务「列不出目录」时的兜底探测，用的是老固定名。）
    #[test]
    fn bare_root_target_lands_in_our_folder() {
        let o = Opts {
            url: "https://dav.jianguoyun.com/dav/".into(),
            user: String::new(),
            pass: String::new(),
            timeout_secs: 15,
        };
        assert_eq!(
            o.target(),
            "https://dav.jianguoyun.com/dav/QuickSearch/quicksearch-backup.json"
        );
    }

    #[test]
    fn url_validation_rejects_junk() {
        assert!(validate_url("").is_err());
        assert!(validate_url("   ").is_err());
        assert!(validate_url("https://").is_err());
        assert!(validate_url("https://localhost/dav/").is_ok());
        assert!(validate_url("https://dav.jianguoyun.com/dav/").is_ok());
        assert!(validate_url("dav.jianguoyun.com/dav/").is_ok());
    }

    /// 「恢复时选云端哪一份」的基础：PROPFIND 的 207 响应要能解析出文件名。
    /// 这是真实服务器回来的形状（`D:` 前缀、collection 混在里面）。
    #[test]
    fn multistatus_lists_files_and_skips_collection() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/QuickSearch/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/QuickSearch/quicksearch-backup.json</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/>
      <D:getcontentlength>2048</D:getcontentlength>
      <D:getlastmodified>Sun, 06 Nov 1994 08:49:37 GMT</D:getlastmodified>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/QuickSearch/%E6%97%A7%E5%A4%87%E4%BB%BD.json</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>512</D:getcontentlength>
    <D:getlastmodified>Mon, 07 Nov 1994 08:49:37 GMT</D:getlastmodified>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;
        let v = parse_multistatus(xml, "https://dav.jianguoyun.com/dav/QuickSearch/")
            .expect("207 应该能解析");
        assert_eq!(v.len(), 2, "目录自身不该出现在列表里：{v:?}");
        // 新的排前面
        assert_eq!(v[0].name, "旧备份.json", "中文名要 URL 解码：{:?}", v[0].name);
        assert_eq!(v[0].size, 512);
        assert_eq!(v[1].name, "quicksearch-backup.json");
        assert_eq!(v[1].size, 2048);
        assert_eq!(v[1].mtime, 784111777);
    }

    /// 小写前缀 / 无前缀也要认 —— 各家 WebDAV 服务器的前缀写法不统一。
    #[test]
    fn multistatus_tolerates_namespace_variations() {
        let lower = r#"<d:multistatus xmlns:d="DAV:"><d:response>
            <d:href>/dav/QS/a.json</d:href><d:propstat><d:prop><d:resourcetype/>
            <d:getcontentlength>10</d:getcontentlength></d:prop></d:propstat>
            </d:response></d:multistatus>"#;
        let v = parse_multistatus(lower, "https://x/dav/QS/").unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "a.json");
        assert_eq!(v[0].size, 10);
    }

    /// 文件名是用户挑的，必须挡住 `../` 这种目录穿越。
    #[test]
    fn download_named_refuses_path_traversal() {
        let o = Opts {
            url: "https://dav.jianguoyun.com/dav/QuickSearch/".into(),
            user: String::new(),
            pass: String::new(),
            timeout_secs: 5,
        };
        assert!(download_named(&o, "../../secret.json").is_err());
        assert!(download_named(&o, "..").is_err());
        assert!(download_named(&o, "  ").is_err());
        // 删除走同一套防护
        assert!(delete_named(&o, "../../secret.json").is_err());
        assert!(delete_named(&o, "  ").is_err());
    }

    /// 服务器没给时间（"只认 GET"的服务器走 `list_by_get`，那条路拿不到 mtime）
    /// 时，新旧顺序只能靠**文件名**兜底 —— 而必须是**降序**。
    ///
    /// 踩过的坑（轮 20 探针实测）：平手按名字升序时，「保留最新 10 份」
    /// 会留下最旧的 10 份、把用户**最新的两份备份删掉**，而且界面上看不出异常
    /// （它确实"保留了 10 份"）。我们的备份名是零填充的时间戳，
    /// 字典序 == 时间序，所以降序正好等于"新的在前"。
    #[test]
    fn newest_first_falls_back_to_name_desc_when_mtime_missing() {
        let mk = |n: &str| Backup { name: n.to_string(), size: 0, mtime: 0 };
        let mut v = vec![
            mk("config(2026-10-12 10-00-01).QuickSearch"),
            mk("config(2026-10-12 10-00-12).QuickSearch"),
            mk("config(2026-10-12 10-00-05).QuickSearch"),
        ];
        sort_newest_first(&mut v);
        assert_eq!(
            v[0].name, "config(2026-10-12 10-00-12).QuickSearch",
            "没给时间时，名字最大的（= 最新的）必须排最前"
        );
        assert_eq!(v[2].name, "config(2026-10-12 10-00-01).QuickSearch");

        // 有时间时一律以时间为准，名字不参与
        let mut w = vec![
            Backup { name: "b".into(), size: 0, mtime: 100 },
            Backup { name: "a".into(), size: 0, mtime: 200 },
        ];
        sort_newest_first(&mut w);
        assert_eq!(w[0].name, "a");
    }

    #[test]
    fn http_date_parses() {
        // 784111777 = 1994-11-06T08:49:37Z
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784111777));
        assert_eq!(parse_http_date("Wed, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(parse_http_date("garbage"), None);
    }

    #[test]
    fn civil_days_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
    }
}
