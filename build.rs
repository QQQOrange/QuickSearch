//! 把 Windows 资源（图标 + 版本信息）编进 exe，**并把前端 ui/ 压缩后一起嵌进去**。
//!
//! 为什么要嵌前端：发布出去的是一个单独的 exe（GitHub Release 只挂 `QuickSearch.exe`），
//! 而 WebView 需要 index.html / bar.js / data/icons/*.png。以前这些文件靠
//! 「exe 同目录的 ui/」提供，找不到就回退到一个**开发者本机的绝对路径** ——
//! 换台机器就是白屏。自动更新只会下载 exe，不会带 ui/ 目录。
//!
//! 为什么压缩：前端原始 4.36 MB（图标 2.54 MB + 文本 1.82 MB），直接 include_bytes
//! 会让 exe 从 5.07 MB 涨到 9.57 MB。整包 deflate 之后约 1.8 MB，exe 约 6.9 MB。
//! 运行时首次请求时解压一次到内存（几十毫秒），之后就是个 HashMap 查表。

use std::io::Write as _;
use std::path::{Path, PathBuf};

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            walk(&p, base, out);
        } else if p.is_file() {
            if let Ok(rel) = p.strip_prefix(base) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, p));
            }
        }
    }
}

/// 这一版**被构建出来**的本地时间，形如 `2026-10-31 21:56:00`。
///
/// 为什么要在这里算：「关于」页有一行「版本更新时间」，用户明确要求它显示
/// **当前这一版发出去的时间**。以前 `config::BUILT_AT` 写的是
/// `option_env!("QS_BUILD_STAMP")`，但**从来没有人注入过这个变量** ——
/// 于是那一行永远显示"未知"。
///
/// 不用 exe 的 mtime：复制、解压、杀软重写都会把它改掉，显示的就不是发版时间了。
///
/// 取本地时间（东八区）：构建脚本里没有时区数据库，直接按 UTC+8 算 ——
/// 发版机就在东八区，这样得到的正是"发版那一刻"。格式固定、不依赖系统区域设置，
/// 不会出现 `2026/10/31 下午9:56:00` 这种。
///
/// 想手动钉一个时间（比如补一个历史版本）时，构建前设 `QS_BUILD_STAMP` 即可。
fn build_stamp() -> String {
    if let Ok(s) = std::env::var("QS_BUILD_STAMP") {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // UTC+8
    let local = secs as i64 + 8 * 3600;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days：把"1970-01-01 起的天数"换成 (年, 月, 日)。
/// 不用第三方日期库 —— 构建脚本的依赖越少越好。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn main() {
    println!("cargo:rerun-if-changed=app.rc");
    /* 「版本更新时间」：每次构建都算一遍当下时间并注入（见 `build_stamp`）。
     * `rerun-if-env-changed` 是为了手动指定时（QS_BUILD_STAMP）能立刻生效。 */
    println!("cargo:rerun-if-env-changed=QS_BUILD_STAMP");
    println!("cargo:rustc-env=QS_BUILD_STAMP={}", build_stamp());

    /* 版本资源**不会**跟着 Cargo.toml 自动走 —— 它是手写在 app.rc 里的。
     * v2.1.0 就踩过：程序里 `config::VERSION` 是 2.1.0，右键属性却还写着 2.0.0，
     * `OriginalFilename` 更是留着构建名 `QuickSearch-lite.exe`（用户以为装错了）。
     * 这里在构建期对一次账，不一致就大声警告，别等发出去才发现。 */
    if let Ok(rc) = std::fs::read_to_string("app.rc") {
        let want = env!("CARGO_PKG_VERSION");
        if !rc.contains(&format!("VALUE \"FileVersion\", \"{want}\"")) {
            println!("cargo:warning=app.rc 的 FileVersion 与 Cargo.toml 的 {want} 不一致 —— 右键属性会显示旧版本号");
        }
        if !rc.contains("VALUE \"OriginalFilename\", \"QuickSearch.exe\"") {
            println!("cargo:warning=app.rc 的 OriginalFilename 不是 QuickSearch.exe —— 属性里会显示构建名");
        }
    }

    println!("cargo:rerun-if-changed=icons/icon.ico");
    // rc.exe 找不到（没装 Windows SDK）时不要中断构建，只是没有图标而已
    let _ = embed_resource::compile("app.rc", embed_resource::NONE);

    // ---- 前端打包 + 压缩 ----
    // 格式：magic("QSUI1") | u32 条目数 | 重复{ u16 名字长 | 名字 | u32 数据长 | 数据 }
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ui");
    println!("cargo:rerun-if-changed=ui");
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    walk(&base, &base, &mut files);
    files.sort();

    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(b"QSUI1");
    raw.extend_from_slice(&(files.len() as u32).to_le_bytes());
    for (rel, abs) in &files {
        let Ok(data) = std::fs::read(abs) else { continue };
        let name = rel.as_bytes();
        raw.extend_from_slice(&(name.len() as u16).to_le_bytes());
        raw.extend_from_slice(name);
        raw.extend_from_slice(&(data.len() as u32).to_le_bytes());
        raw.extend_from_slice(&data);
    }

    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(&raw).expect("压缩前端失败");
    let packed = enc.finish().expect("压缩前端失败");

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("ui.bundle");
    std::fs::write(&out, &packed).expect("写 ui.bundle 失败");
    println!(
        "cargo:warning=前端已内嵌：{} 个文件，{:.2} MB → 压缩后 {:.2} MB",
        files.len(),
        raw.len() as f64 / 1048576.0,
        packed.len() as f64 / 1048576.0
    );
}
