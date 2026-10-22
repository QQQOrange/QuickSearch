//! 文件路径快捷打开（用户第九批需求 2）。
//!
//! 用户原话：「当划词选中的内容是本地文件路径时，横条上自动弹出文件管理器图标，
//! 点击后直接调用系统文件管理器定位并打开对应路径。」
//!
//! ## 判据：什么算「一条本地路径」
//!
//! 划词来的是一段**任意文字**，绝大多数不是路径（一句英文、一行代码、一个
//! 网址）。所以判据必须**宁可放过也不误判**：误判的代价是横条上凭空多一个
//! 图标、点下去弹一个报错框，比「没认出来」烦人得多。
//!
//! 认这几种（都能在没有真实文件的情况下先判出来）：
//!   · `C:\Users\me\Desktop\a.txt`      —— 盘符 + 反斜杠
//!   · `\\server\share\a.txt`           —— UNC 网络路径
//!   · `C:/Users/me/a.txt`              —— 盘符 + 正斜杠（浏览器/代码里常这么写）
//!   · `.\bin\tool.exe` / `..\a\b.txt`  —— 相对路径（以 `.\` `..\` `./` `../` 开头）
//!   · `%APPDATA%\QuickSearch`          —— 含环境变量的路径
//!   · 纯路径段 `bin\tool.exe`          —— 像路径（带目录分隔符 + 有扩展名，
//!                                        且不是网址）—— 单独出现时**不算**，
//!                                        见下面 ⚠
//!
//! ⚠ 最后一条是刻意的取舍：光有 `bin\tool.exe` 这种串也可能是别的东西（一句
//!   话里带了个反斜杠）。它单独成串时**不弹图标**；但它跟在盘符/UNC/`.\` 后面、
//!   或者用户整串选中时，前面的判据已经能命中。
//!
//! ## 打开方式
//!
//! 用资源管理器（explorer.exe）而不是 ShellExecute —— 用户要的是「**定位并
//! 打开**」，即文件所在的那个窗口：
//!   · 是**文件** → `explorer /select,<path>`：选中这个文件，所在目录打开
//!     （用户看到的是"高亮在资源管理器里"，这才是"定位"）；
//!   · 是**目录** → `explorer <path>`：直接打开这个目录。
//!
//! ⚠ 走 `std::process::Command` 而不是 `open::that`：`open::that` 在 Windows 上
//!   等价于 ShellExecuteW("open")，对**文件**会用关联程序把它**打开**（点一个
//!   .txt 会弹记事本），对目录也会开但拿不到"选中目标文件"的效果。用户要的是
//!   文件管理器，explorer.exe 的 `/select,` 是唯一正解。

/// 一段文字是不是一条本地路径。是则返回**规范化前的原文**（去掉引号/空白），
/// 不是返回 None。
///
/// 调用方拿到的路径还要过 [`resolve`]（展开 `%VAR%`、拼工作目录）才能用。
pub fn looks_like_path(text: &str) -> Option<&str> {
    let t = strip(text);
    if t.is_empty() || t.len() > 260 {
        return None; // 260 = Windows MAX_PATH 附近，超了 explorer 也打不开
    }
    // ① 明确不是路径的东西先排掉，避免误判
    if is_url(t) || t.contains('\n') || t.contains('\r') {
        return None;
    }
    // ①b `file:///C:/...` —— 从浏览器地址栏复制出来的**文件地址**。
    //     用户原话里的「文件浏览器的地址」就是它。以前它被 is_url 当成网址
    //     直接排掉，横条上压根不出图标。现在单独认下来，由 resolve 转成本地路径。
    //     ⚠ 用 has_file_scheme（按字节比）而不是 `t[..7]`：中文路径的字节边界
    //       不在 7 上，切片会 panic。这类 panic 只在"划词是一串中文"时触发，
    //       平时根本测不到。
    if t.len() > 8 && has_file_scheme(t) {
        return Some(t);
    }
    // ② UNC：\\server\share...
    if t.starts_with("\\\\") && t.len() > 3 {
        return Some(t);
    }
    // ③ 盘符 + 分隔符：C:\... / c:/...
    //    ⚠ 三个位置各有各的判据，别写混：byte[0] = 盘符（字母）、
    //       byte[1] = ':'、byte[2] = 分隔符（\ 或 /）。第一版这里把
    //       byte[2] 写成"是不是字母"，于是所有盘符路径全部失明（单测抓住的）。
    if t.len() >= 4
        && t.as_bytes()[0].is_ascii_alphabetic()
        && t.as_bytes()[1] == b':'
        && (t.as_bytes()[2] == b'\\' || t.as_bytes()[2] == b'/')
    {
        return Some(t);
    }
    // ④ 相对路径：.\ ..\ ./ ../
    for pre in [".\\", "./", "..\\", "../"] {
        if t.starts_with(pre) && t.len() > pre.len() {
            return Some(t);
        }
    }
    // ⑤ 环境变量：%APPDATA%\...（至少一个完整 %VAR% 段，且后面有分隔符或就是全部）
    if t.contains('%') {
        if let Some(i) = t.find('%') {
            if let Some(j) = t[i + 1..].find('%') {
                let var = &t[i + 1..i + 1 + j];
                if !var.is_empty()
                    && var
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && (i == 0 || t.as_bytes()[i - 1] == b'\\' || t.as_bytes()[i - 1] == b'/')
                {
                    return Some(t);
                }
            }
        }
    }
    None
}

/// 去掉首尾空白、最外层成对的引号，以及**尾部标点**。
///
/// 划词经常把 `"C:\Program Files\x"` 连引号一起选进来 —— 不剥掉的话
/// explorer 会拿一个带引号的路径去开，必然失败。
///
/// r57 补的第二件事：**尾部标点**。从聊天/文档里选一条路径，很容易把句号、
/// 逗号、冒号一起选进来（`C:\Users\me\Desktop\报告.docx。`）。这种串
/// `looks_like_path` 是认的（它以 `C:\` 开头），于是横条上**照样会冒出 📁**，
/// 但点下去 `exists()` 必然 false —— 用户看到的就是「图标出来了，点了没反应」。
/// 这正是用户报的那条。
///
/// ⚠ 敢无脑剥尾部标点，是因为 **Windows 文件名本来就不许以点/空格结尾**
///   （资源管理器会拒绝创建 `a.` / `a ` 这种名字）。所以尾部这些字符
///   不可能是路径的一部分，剥掉只会让结果更对。
/// ⚠ 但不剥**中间**的标点 —— `C:\a,b\c.txt` 里的逗号是合法文件名的一部分。
fn strip(text: &str) -> &str {
    let mut t = text.trim();
    /* 反复剥到不再变化：因为剥掉尾部标点之后**可能又露出一个引号**
     * （`"C:\a\b.txt"，` → 剥 `，` → `"C:\a\b.txt"` → 这时候才轮到引号），
     * 一次性的"先引号后标点"顺序处理不了这种夹心形状。
     * 循环一定会停：每一轮至少少一个字节，且 t 只会变短。 */
    loop {
        let before_len = t.len();
        // ① 首尾空白
        t = t.trim();
        // ② 最外层成对引号
        let b = t.as_bytes();
        if b.len() >= 2
            && ((b[0] == b'"' && b[b.len() - 1] == b'"')
                || (b[0] == b'\'' && b[b.len() - 1] == b'\''))
        {
            t = t[1..t.len() - 1].trim();
        }
        // ③ 尾部标点/收尾括号
        //    ⚠ 引号**不放在这个字符类里**：放进来会把 `"C:\a.txt"，` 的
        //      收尾引号先吃掉，剩下一个孤零零的前引号再也没人剥
        //      （第一版就是这么错的，单测当场抓住）。引号交给 ② 那一步
        //      成对处理，或者交给下面的 ④ 单独剥前引号。
        let s = t.trim_end().trim_end_matches(|c: char| {
            matches!(
                c,
                '。' | '，' | '、' | '；' | '：' | '！' | '？' | '」' | '』' | '）' | '》'
                    | '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '>'
            )
        });
        t = s;
        if t.len() == before_len {
            break;
        }
    }
    /* ⑤ 循环结束后再剥**孤零零的前引号**。
     *    为什么不能放在循环里：`"C:\a.txt"，` 在循环第 1 轮剥掉 `，` 之后变成
     *    `"C:\a.txt"` —— 这时两个引号是**成对**的，该由 ② 处理；如果这一轮
     *    顺手把前引号也剥了，剩下 `C:\a.txt"` 就再也没人管（第一版就是这么错的）。
     *    放到循环外，成对的已经在 ② 走掉了，剩下的前引号一定是没配对的。
     *    Windows 文件名里不允许出现 `"`，所以它必然是选词带进来的。 */
    t.trim_start_matches(['"', '\'']).trim_start()
}

/// 是不是网址。**判据必须极其保守**，否则会把带扩展名的本地路径误判成网址。
///
/// ⚠ 这里栽过一次：第一版顺手加了个「有 `.com` `.cn` 这种点+顶级域就是网址」的
///   启发式，结果 `C:\Users\me\a.txt`（尾段 `.txt` 也是 2~6 个字母）被当成
///   `www.txt` 拒绝掉 —— 任何带扩展名的本地路径全部失明。所以现在**只认三种
///   确定是网址的形状**，其余一律交给后面的盘符/UNC/相对判据去认：
///     · 有 scheme：`http://` `https://` `ftp://` …
///     · 协议相对：`//host/…`
/// 至于 `foo.com\bar` 这种模糊串 —— 它既没有盘符也不是 UNC 也不是相对路径，
/// 本来就不会被判成路径（`None`），不需要在这里提前拦。
///
/// ⚠ r57：`file://` **不算网址** —— 它是"一条本地文件"的另一种写法，
///   用户从浏览器地址栏复制出来的就是它。排掉它等于把一整类真实输入弄瞎。
fn is_url(t: &str) -> bool {
    if has_file_scheme(t) {
        return false;
    }
    t.starts_with("//") || t.contains("://")
}

/// 这条串是不是以 `file://` 开头（ASCII 大小写不敏感）。
///
/// ⚠ 单独抽出来是因为**不能写成 `&t[..7]`**：`t` 是任意用户文字，中文的
///   UTF-8 字节边界不在 7 上，`&t[..7]` 会 panic。按字节比就永远不会切错。
///   这个坑只在"划词是一串中文"时才炸，功能测试很容易漏掉 ——
///   所以这里刻意写成不依赖字符边界的形式。
fn has_file_scheme(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() >= 7 && b[..7].eq_ignore_ascii_case(b"file://")
}

/// 把判据命中的文字变成一条能交给资源管理器的**绝对**路径。
///
/// 做的事（顺序固定，每一步都可能失败）：
///   1. 去掉引号空白（`looks_like_path` 已做，这里再兜一次）；
///   2. 展开 `%VAR%`（`%APPDATA%` → 真目录）；
///   3. 相对路径按进程工作目录拼成绝对路径；
///   4. 归一化分隔符（正斜杠统一成反斜杠 —— explorer 两种都吃，但统一了
///      后面的存在性判断少一条分支）。
///
/// 返回 None = 这条文字解不出可用的路径（环境变量没定义 / 拼出来是空的）。
pub fn resolve(text: &str) -> Option<String> {
    let t = strip(text);
    if t.is_empty() {
        return None;
    }
    /* r57：`file:///C:/Users/me/a.txt` → `C:\Users\me\a.txt`。
     *
     * 从浏览器地址栏复制出来的本地文件地址就是这个形状。规则（按 RFC 8089
     * 的常见写法，够用即可）：
     *   · `file:///C:/x`  → 去掉 `file://` 之后是 `/C:/x`，盘符前那个多余
     *     斜杠要吃掉；
     *   · `file://server/share/x`（UNC）→ `\\server\share\x`；
     *   · `%20` 之类的百分号编码要还原（文件名里常有空格）。
     *
     * ⚠ 只处理本地路径，不联网、不解析 `file://` 之外的 scheme ——
     *   上面 `is_url` 已经把它们挡在外面了。 */
    if t.len() >= 7 && has_file_scheme(t) {
        let rest = &t[7..];
        // UNC：file://server/share → \\server\share
        let local = if rest.starts_with('/') {
            let r = rest.trim_start_matches('/');
            // `/C:/x` 这种：盘符前那个斜杠去掉
            if r.len() >= 2 && r.as_bytes()[1] == b':' && r.as_bytes()[0].is_ascii_alphabetic() {
                r.to_string()
            } else {
                // 既不是盘符也不是 UNC 的裸 `/x` —— 当作当前盘根
                r.to_string()
            }
        } else {
            format!("\\\\{}", rest)
        };
        let decoded = percent_decode(&local).replace('/', "\\");
        let p = std::path::PathBuf::from(decoded);
        let s = p.to_string_lossy().to_string();
        if s.is_empty() || s.len() > 260 {
            return None;
        }
        return Some(s);
    }
    // 先展开环境变量，再判断是盘符还是相对 —— %SYSTEMDRIVE%\x 这种要先展开
    //
    /* r59：这里原来按**字节**遍历，`expanded.push(bytes[i] as char)` 把每个
     * UTF-8 字节当成一个 Latin-1 字符拼回去 —— **任何非 ASCII 路径都会被改坏**。
     *
     * 后果非常具体：`C:\Users\me\OneDrive\桌面\377程子人才补贴材料` 会被变成
     * `C:\Users\me\OneDrive\æ¡é¢\377ç¨åäººæè¡¥è´´ææ`，于是
     * `Path::exists()` 返回 false，`open()` 报「找不到这个路径」——
     * 用户看到的正是「📁 图标出来了，点了跳不过去」。而纯英文路径一切正常，
     * 所以这个 bug 能藏很久（r54 加这个功能时，测试用的都是 ASCII 路径）。
     *
     * 现在改成按**字符**遍历：只处理 `%`，其余原样 push 字符，不再碰字节。 */
    let mut expanded = String::with_capacity(t.len());
    let mut rest = t;
    while let Some(pct) = rest.find('%') {
        // 找配对的第二个 %
        let after = &rest[pct + 1..];
        let Some(j) = after.find('%') else {
            // 没有配对的 %：把剩下的原样留下（它可能就是文件名里的百分号）
            break;
        };
        let var = &rest[pct + 1..pct + 1 + j];
        // 变量名合法、且 % 前面是串首或分隔符，才当成环境变量
        let at_boundary = pct == 0
            || rest[..pct].ends_with('\\')
            || rest[..pct].ends_with('/');
        let valid = !var.is_empty()
            && var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && at_boundary;
        if !valid {
            // 不是环境变量：把这一段的 `%` 连同前面的内容原样搬过去，继续往后找
            expanded.push_str(&rest[..pct + 1]);
            rest = &rest[pct + 1..];
            continue;
        }
        match std::env::var(var) {
            Ok(v) => {
                expanded.push_str(&rest[..pct]);
                expanded.push_str(&v);
                rest = &rest[pct + j + 2..];
            }
            // 没定义的环境变量：**放弃整条**，别拿字面量 `%VAR%` 去开
            // （那必然失败，还会弹一个莫名其妙的报错框）。
            Err(_) => return None,
        }
    }
    expanded.push_str(rest);
    let p = std::path::PathBuf::from(expanded.replace('/', "\\"));
    let abs = if p.is_absolute() {
        p
    } else {
        std::env::current_dir().ok()?.join(p)
    };
    let s = abs.to_string_lossy().to_string();
    if s.is_empty() || s.len() > 260 {
        return None;
    }
    Some(s)
}

/// 还原 URL 里的百分号编码（`%20` → 空格）。只处理 `%XX` 形式，其余原样。
///
/// 给 `file://` 那条路用：地址栏里的空格是 `%20`，不还原的话 explorer
/// 会去找一个名字里带字面 `%20` 的文件，必然"找不到"。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 打开一条路径。返回一句人话（成功也返回，界面用来做 toast）。
///
/// 判据是「**磁盘上真实存在**」：不存在就明确告诉用户，而不是让 explorer
/// 弹一个它自己的英文报错（用户原话的隐含要求：点了就有反应）。
pub fn open(path: &str) -> String {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return format!("找不到这个路径：{path}");
    }
    /* 目录 → 直接打开；文件 → /select, 定位。
     *
     * ⚠ r57：`/select,` 和路径分成**两个参数**传，不再拼成一个
     *   `format!("/select,{path}")`。拼成一个串时，路径里带空格 / 逗号 /
     *   结尾反斜杠都要靠 Windows 的命令行转义规则去猜，猜错的表现就是
     *   **explorer 静默什么都不开**（用户看到的就是"点了没反应"）。
     *   分开传之后，引号由系统按参数边界加，路径里有空格也不用我们操心。
     *   这是 explorer 的官方写法：`explorer.exe /select,"C:\path\to\file"`。 */
    let out = if p.is_dir() {
        std::process::Command::new("explorer.exe").arg(path).spawn()
    } else {
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()
    };
    match out {
        Ok(_) => if p.is_dir() {
            "已在文件管理器中打开"
        } else {
            "已在文件管理器中定位"
        }
        .to_string(),
        Err(e) => format!("打开失败：{e}"),
    }
}

/// r97：**用系统默认程序打开这个文件**（用户新需求）。
///
/// 用户原话：「还要再增加一个直达文件的功能，就是说我选中了一个文件路径，
/// 那这个时候横条上就会弹出一个按钮，点击这个按钮就会自动调用系统默认的
/// 相应文件的软件来打开这个文件。」
///
/// # 与 [`open`] 的分工
///
/// | | 目录 | 文件 |
/// |---|---|---|
/// | [`open`]（📁 在文件管理器中打开） | 打开目录 | **定位**（资源管理器里高亮） |
/// | [`open_file`]（📄 打开文件） | —— 不给这个按钮 | **用默认程序打开**（.txt→记事本） |
///
/// 所以「打开文件」按钮**只在选中物是文件时出现**，目录下不需要它
/// （在文件管理器里打开目录已经是默认程序的行为了）。
///
/// # 为什么用 `open::that`
///
/// 它就是 ShellExecuteW("open") 的封装 —— 走的是 Windows 的**文件关联**，
/// 和用户在资源管理器里双击这个文件完全一致（.txt → 记事本、.mp4 → 播放器、
/// 没有关联 → 弹出"你要用什么打开"的系统对话框，这也是双击的行为）。
///
/// ⚠ 判据仍然是「磁盘上真实存在」：不存在就明说，不去弹一个系统报错框。
pub fn open_file(path: &str) -> String {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return format!("找不到这个文件：{path}");
    }
    if p.is_dir() {
        // 目录没有"默认程序"这个概念（双击 = 在资源管理器里打开），
        // 调用方不会给目录传进来，这里只是防御。
        return open(path);
    }
    match open::that(path) {
        Ok(()) => format!("已用默认程序打开：{}", file_name_of(path)),
        Err(e) => format!("打开失败：{e}"),
    }
}

/// 只取文件名（路径里的最后一段），给 toast 用 —— 整条路径太长会撑爆横条。
fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得出盘符路径() {
        assert_eq!(looks_like_path(r"C:\Users\me\a.txt"), Some(r"C:\Users\me\a.txt"));
        assert_eq!(looks_like_path("C:/Users/me/a.txt"), Some("C:/Users/me/a.txt"));
        assert_eq!(looks_like_path("d:\\x\\y"), Some("d:\\x\\y"));
    }

    #[test]
    fn 认得出_unc_和_相对_和_环境变量() {
        assert_eq!(looks_like_path(r"\\server\share\a.txt"), Some(r"\\server\share\a.txt"));
        assert_eq!(looks_like_path(r".\bin\tool.exe"), Some(r".\bin\tool.exe"));
        assert_eq!(looks_like_path(r"..\a\b.txt"), Some(r"..\a\b.txt"));
        assert_eq!(looks_like_path("%APPDATA%\\QuickSearch"), Some("%APPDATA%\\QuickSearch"));
    }

    #[test]
    fn 不认网址_和_普通句子() {
        assert_eq!(looks_like_path("https://example.com/a"), None);
        assert_eq!(looks_like_path("www.example.com/a"), None);
        assert_eq!(looks_like_path("foo.com\\bar"), None);
        assert_eq!(looks_like_path("这是一句普通的话"), None);
        assert_eq!(looks_like_path("hello world"), None);
        // 单独的 bin\tool.exe 不算（见模块注释里的取舍说明）
        assert_eq!(looks_like_path(r"bin\tool.exe"), None);
    }

    #[test]
    fn 剥掉成对引号() {
        assert_eq!(looks_like_path(r#""C:\Program Files\x""#), Some(r"C:\Program Files\x"));
    }

    /// 这一条是**修过的 bug 的回归测试**：第一版把「点+顶级域」当网址启发式，
    /// 于是 `C:\Users\me\a.txt` 的尾段 `.txt` 被当成顶级域，任何带扩展名的
    /// 本地路径全部失明。判据改成"只认有 scheme 的 / 协议相对的"之后，
    /// 这条必须永远成立。
    #[test]
    fn 带扩展名的路径不能被当网址() {
        for p in [
            r"C:\Users\me\a.txt",
            r"D:\download\photo.jpg",
            r"E:\tools\app.exe",
            r"\\nas\share\backup.zip",
            r"C:\www\index.html",
            r"C:\x\com.cn\file.com",
        ] {
            assert_eq!(looks_like_path(p), Some(p), "应当认成路径：{p}");
        }
    }

    #[test]
    fn 多行和空串都不是() {
        assert_eq!(looks_like_path(""), None);
        assert_eq!(looks_like_path("   "), None);
        assert_eq!(looks_like_path("a\\b\nc\\d"), None);
    }

    #[test]
    fn resolve_展开环境变量() {
        // PATH 是每个 Windows 上都定义的环境变量
        std::env::set_var("QS_TEST_VAR", "C:\\qs-test");
        let got = resolve("%QS_TEST_VAR%\\a.txt").unwrap();
        assert!(got.ends_with("\\a.txt"));
        assert!(got.contains("qs-test"));
    }

    #[test]
    fn resolve_未定义的环境变量就放弃() {
        assert!(resolve("%QS_NO_SUCH_VAR_XYZ%\\a.txt").is_none());
    }

    #[test]
    fn resolve_正斜杠归一成反斜杠() {
        std::env::set_var("QS_TEST_VAR2", "C:\\qs2");
        let got = resolve("%QS_TEST_VAR2%/a/b.txt").unwrap();
        assert!(!got.contains('/'), "应当全是反斜杠：{got}");
    }

    #[test]
    fn resolve_相对路径拼成绝对() {
        let got = resolve(r".\a\b.txt").unwrap();
        assert!(got.contains('\\'), "应当是绝对路径：{got}");
        assert!(got.ends_with(r"a\b.txt"));
    }

    /// r55：跨端判据分叉的回归。
    ///
    /// `%VAR%` 的变量名判据是「一个或多个字母/数字/下划线」—— **不以字母开头
    /// 也行**（`%1%` 是合法变量名）。前端 shared.js 曾经要求"字母或下划线开头"，
    /// 于是 `%1%` 两边结论相反：Rust 说该弹图标、JS 说不弹。症状是「有时有图标
    /// 有时没有」，用户根本无法复现。
    ///
    /// 一致性由 `tools/r55-paths-crosscheck.js` 逐条比对（50 个边界样本），
    /// 这里钉住 Rust 侧这一半的判据本身，防止后人"顺手"把它改严。
    #[test]
    fn 环境变量名不要求以字母开头() {
        // 纯数字也是合法变量名
        assert!(looks_like_path("%1%").is_some());
        assert!(looks_like_path("%1%\\a.txt").is_some());
        // 下划线开头同样合法
        assert!(looks_like_path("%_X%\\a.txt").is_some());
        // 空变量名 / 含非法字符的仍然不算
        assert!(looks_like_path("%%").is_none());
        assert!(looks_like_path("%a-b%").is_none());
        // 段前必须是串首或分隔符（"a%VAR%\b" 不算）
        assert!(looks_like_path("a%APPDATA%\\b").is_none());
        assert!(looks_like_path("\\%APPDATA%\\b").is_some());
    }

    #[test]
    fn open_不存在的路径给出明确反馈() {
        let msg = open("Z:\\definitely-not-here-qs\\x.txt");
        assert!(msg.contains("找不到"), "应当告诉用户找不到：{msg}");
    }

    /* ---------------- r97：用默认程序打开文件 ---------------- */

    /// 造一个临时文件，返回（路径, 保活守卫）。
    fn tmp_file_with(tag: &str, body: &str) -> (String, TempDirLike) {
        let dir = std::env::temp_dir().join(format!(
            "qs-openfile-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("探针文件.txt");
        std::fs::write(&f, body).unwrap();
        (f.to_string_lossy().to_string(), TempDirLike(dir))
    }

    struct TempDirLike(std::path::PathBuf);
    impl Drop for TempDirLike {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// r97 新功能的直接验证：选中一个**文件**路径 → 用系统默认程序打开。
    ///
    /// 用户原话：「还要再增加一个直达文件的功能，就是说我选中了一个文件路径，
    /// 那这个时候横条上就会弹出一个按钮，点击这个按钮就会自动调用系统默认的
    /// 相应文件的软件来打开这个文件。」
    ///
    /// ⚠ 这条会**真的**用默认程序打开一个 .txt（弹一下记事本）。测试机上这是
    ///   可接受的（一个空文本框），但别把它改成"只判存在性"—— 那验不到
    ///   `open::that` 这条路本身，而它正是这个功能的全部。
    #[test]
    fn open_file_用默认程序打开真实文件() {
        let (f, _keep) = tmp_file_with("real", "QuickSearch r97 探针");
        let msg = open_file(&f);
        // 返回值是人话，含文件名（不含整条路径 —— 会撑爆横条）
        assert!(msg.contains("探针文件.txt"), "提示里该有文件名：{msg}");
        assert!(msg.starts_with("已用默认程序打开"), "该报告成功：{msg}");
        assert!(!msg.contains('\\'), "提示里不该出现整条路径：{msg}");
    }

    /// 目录**没有**"默认程序"这个概念，给它该退回资源管理器行为而不是报错。
    #[test]
    fn open_file_对目录退回复位行为() {
        let dir = std::env::temp_dir().join(format!(
            "qs-openfile-dir-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let msg = open_file(&dir.to_string_lossy());
        assert!(
            msg.contains("文件管理器"),
            "目录该走资源管理器那条路：{msg}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件不存在时给**中文人话**，不弹系统英文报错框。
    #[test]
    fn open_file_不存在时给明确反馈() {
        let msg = open_file(r"Z:\qs-not-here-qs\x.txt");
        assert!(msg.contains("找不到这个文件"), "该告诉用户找不到：{msg}");
    }

    /// 判据同源：`looks_like_path` 认得出来，`open_file` 才可能被调到
    /// （前端按钮的显隐走它）。文件、目录、`%VAR%`、`file://` 四种都要认。
    #[test]
    fn open_file_的判据与_looks_like_path_同源() {
        assert!(looks_like_path(r"C:\Users\me\a.txt").is_some());
        assert!(looks_like_path(r"C:\Users\me\Documents").is_some());
        assert!(looks_like_path("%TEMP%\\a.txt").is_some());
        assert!(looks_like_path("file:///C:/Users/me/a.txt").is_some());
    }

    /* ---------------- r57：用户报「图标出来了、点了没反应」的两种真实形态 ---------------- */

    /// 形态一：从**浏览器地址栏**复制出来的 `file:///C:/...`。
    ///
    /// 用户原话「我选中了一个**文件浏览器的地址**或者说文件的地址」——
    /// 地址栏给的就是这个形状。以前 `is_url` 把它当网址直接排掉，横条上
    /// 压根不出图标；现在要认，而且要能转成本地路径去开。
    #[test]
    fn file地址认得出也转得对() {
        // 认
        assert!(looks_like_path("file:///C:/Users/me/a.txt").is_some());
        assert!(looks_like_path("FILE:///C:/Users/me/a.txt").is_some(), "大小写不敏感");
        // 转：三个斜杠 + 盘符 → 正常盘符路径
        assert_eq!(
            resolve("file:///C:/Users/me/a.txt").as_deref(),
            Some(r"C:\Users\me\a.txt")
        );
        // 百分号编码要还原（地址栏里的空格是 %20）
        assert_eq!(
            resolve("file:///C:/Program%20Files/a.txt").as_deref(),
            Some(r"C:\Program Files\a.txt")
        );
        // UNC：file://server/share → \\server\share
        assert_eq!(
            resolve("file://server/share/a.txt").as_deref(),
            Some(r"\\server\share\a.txt")
        );
        // 但真正的网址仍然不算路径（别因为放行 file:// 把 https:// 也放进来了）
        assert!(looks_like_path("https://example.com/a.txt").is_none());
        assert!(looks_like_path("ftp://example.com/a").is_none());
    }

    /// 形态二：从聊天/文档里选一条路径，**尾部带标点**。
    ///
    /// `C:\Users\me\报告.docx。` 这种串：`looks_like_path` 认（以 `C:\` 开头），
    /// 于是横条上**照样冒出 📁**，但 `exists()` 必然 false —— 用户看到的就是
    /// 「图标出来了、点了没反应」。剥掉尾部标点就对了。
    #[test]
    fn 路径尾部的标点要剥掉() {
        assert_eq!(strip(r"C:\a\b.txt。"), r"C:\a\b.txt");
        assert_eq!(strip(r"C:\a\b.txt，"), r"C:\a\b.txt");
        assert_eq!(strip(r"C:\a\b.txt："), r"C:\a\b.txt");
        assert_eq!(strip(r"C:\a\b.txt、"), r"C:\a\b.txt");
        // 成对引号 + 尾部标点一起出现（划词最常见的组合）
        assert_eq!(strip(r#""C:\a\b.txt"，"#), r"C:\a\b.txt");
        // 中间的标点**不许**动（那是合法文件名的一部分）
        assert_eq!(strip(r"C:\a,b\c.txt"), r"C:\a,b\c.txt");
        // 正常路径原样
        assert_eq!(strip(r"C:\Users\me\Desktop"), r"C:\Users\me\Desktop");
    }

    /// 中文串不许 panic。`has_file_scheme` 如果写成 `&t[..7]`，中文的 UTF-8
    /// 字节边界不在 7 上就会 panic —— 而这条只在"划词是一串中文"时才触发，
    /// 功能测试很容易漏。这里把几种典型中文串都过一遍。
    #[test]
    fn 中文串不会因为切字节而崩() {
        for s in [
            "今天天气不错",
            "中文",
            "中",
            "a中文b",
            "中a文bcde",
            "这是一段很长的中文，用来测试不会崩",
            "C:\\中文路径\\文件.txt",
        ] {
            // 不 panic 就算过；返回值不重要（大部分应当 None）
            let _ = looks_like_path(s);
            let _ = resolve(s);
        }
        // 中文路径本身要认（这是真实场景）
        assert!(looks_like_path(r"C:\中文路径\文件.txt").is_some());
    }

    /// r59：**带中文的路径必须原样活下来**。
    ///
    /// 这是一条真 bug 的回归测试：`resolve` 以前按字节遍历、
    /// `push(bytes[i] as char)` 把 UTF-8 字节当成 Latin-1 字符拼回去，
    /// 于是 `C:\…\桌面\377程子人才补贴材料` 被改成
    /// `C:\…\æ¡é¢\377ç¨åäººæè¡¥è´´ææ`，`exists()` 为假 →
    /// 用户点 📁 得到「找不到这个路径」。纯 ASCII 路径一切正常，
    /// 所以这个 bug 在 r54 加功能后藏了五轮。
    #[test]
    fn 中文路径要原样保留() {
        let p = r"C:\Users\me\OneDrive\桌面\377程子人才补贴材料";
        let got = resolve(p).expect("中文路径必须能解析");
        assert_eq!(got, p, "中文路径不许被改坏");
        // 带环境变量的中文路径：变量展开之后中文段也必须完好
        let with_var = r"%USERPROFILE%\桌面\材料";
        let g2 = resolve(with_var).expect("应当能解析");
        assert!(g2.ends_with(r"\桌面\材料"), "变量展开后中文段坏了：{g2}");
        assert!(!g2.contains('%'), "环境变量没展开：{g2}");
        // 正斜杠 + 中文：分隔符要统一，中文不能动
        assert_eq!(
            resolve("C:/Users/me/桌面/材料").as_deref(),
            Some(r"C:\Users\me\桌面\材料")
        );
        // file:// + 中文（地址栏里中文通常是百分号编码，这里两种都要能过）
        assert_eq!(
            resolve("file:///C:/Users/me/桌面/材料").as_deref(),
            Some(r"C:\Users\me\桌面\材料")
        );
    }
}
