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

fn main() {
    println!("cargo:rerun-if-changed=app.rc");

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
