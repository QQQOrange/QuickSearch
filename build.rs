fn main() {
    // ---------------------------------------------------------------
    // 必须先声明 ui/ 的依赖！
    //
    // ui/ 里的 html/css/js/图标是由 `tauri::generate_context!()` 在编译期
    // 打包进 exe 的（资源写到 OUT_DIR，主 crate 再 include! 进去）。
    // 如果构建脚本不重跑，OUT_DIR 里的资源就是旧的 —— 于是会出现
    // 「明明改了 bar.js，编译也过了，跑起来还是老行为」这种鬼打墙。
    // 加一条目录级 rerun-if-changed，Cargo 会递归盯着整棵树。
    // ---------------------------------------------------------------
    println!("cargo:rerun-if-changed=ui");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons");
    // src 也要盯：下面那条 BUILD_STAMP 是本脚本算出来的，只有在脚本重跑时
    // 才会刷新。如果只改了 src/*.rs 而没动 ui/，脚本不重跑 → 新编译出来的
    // exe 会挂着上一轮的构建时间，设置页「关于」里显示的就是个错的时间。
    // 盯上 src / Cargo.toml 之后：源码变了脚本必重跑，时间必是新的；
    // 源码没变时脚本不重跑，exe 也不会重编 —— 此时时间"不刷新"正好等于
    // "这一版没有任何改动"，语义上反而是对的。
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    println!("cargo:rustc-env=QS_BUILD_STAMP={}", build_stamp::now_local());

    copy_ort_runtime();

    tauri_build::build()
}

/// 把 `onnxruntime.dll` 拷到产物目录（r80 AI 抠图用）。
///
/// # 为什么自己拷，不用 ort 的 `copy-dylibs` feature
///
/// `copy-dylibs` 期望的目录结构是 `<ORT_LIB_LOCATION>/lib` + `<ORT_LIB_LOCATION>/Release`
/// （或 `Debug`）。而 ONNX Runtime **官方发布包**只有 `lib/` 一个目录，
/// 于是它两边都找不到、静默什么都不拷 —— 表现是"编译过了、跑起来报
/// `The requested API version [22] is not available`"（找不到 dll 就退到
/// 系统里其它版本的 ortnxruntime，API 版本对不上）。
///
/// 这个坑很难查（它不报错、产物看着也正常），所以显式拷一次、并在拷不到时
/// **不报错**（只是没有 AI 功能，程序仍要能编译能跑）。
///
/// 找库位置的顺序：
///   1. `ORT_LIB_LOCATION`（本地开发时显式指定，最高优先级）
///   2. `<repo>/vendor/ort/`（发布用的固定位置，随仓库）
fn copy_ort_runtime() {
    let Ok(out_dir) = std::env::var("OUT_DIR") else { return };
    // OUT_DIR = <target>/<profile>/build/<crate>-<hash>/out → 上溯 3 层到 <target>/<profile>
    let Some(profile_dir) = std::path::Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .map(|p| p.to_path_buf())
    else {
        return;
    };

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(loc) = std::env::var("ORT_LIB_LOCATION") {
        candidates.push(std::path::PathBuf::from(&loc).join("lib"));
        candidates.push(std::path::PathBuf::from(&loc));
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(root.join("vendor").join("ort").join("lib"));
    candidates.push(root.join("vendor").join("ort"));

    for dir in candidates {
        let dll = dir.join("onnxruntime.dll");
        if !dll.exists() {
            continue;
        }
        let dst = profile_dir.join("onnxruntime.dll");
        // 已存在且大小一致就不重复拷（省构建时间，168MB 项目里这块不小）
        let same = std::fs::metadata(&dst)
            .ok()
            .zip(std::fs::metadata(&dll).ok())
            .map(|(a, b)| a.len() == b.len())
            .unwrap_or(false);
        if !same {
            if let Err(e) = std::fs::copy(&dll, &dst) {
                println!("cargo:warning=拷贝 onnxruntime.dll 失败（AI 抠图将不可用）：{e}");
            } else {
                println!("cargo:warning=已拷贝 onnxruntime.dll → {}", dst.display());
            }
        }
        return;
    }
    // 找不到库不报错：AI 功能会通过 runtime_available() 自动降级，
    // 不该因为"没放 dll"就让整个编译失败。
    println!(
        "cargo:warning=没找到 onnxruntime.dll（AI 抠图不可用）。\
         把它放到 vendor/ort/lib/ 或用 ORT_LIB_LOCATION 指定目录"
    );
}

/// 算「这次构建发生在本地时间的哪一刻」，交给 `cargo:rustc-env` 打进二进制。
///
/// 为什么手写 `GetLocalTime` 而不引 chrono：build.rs 只要一个时间戳字符串，
/// 为它多背一个 crate（及其整条编译依赖链）不划算。SYSTEMTIME 全是 WORD，
/// 布局固定，`#[link(name="kernel32")]` 默认就已经链接上了。
///
/// 用户要求「关于」里给出**当前版本更新的时间** —— 用构建时刻而不是 exe 的
/// 文件修改时间，是因为后者会被「复制/下载/杀软扫描」这类和程序无关的动作改写，
/// 只有编译进二进制里的这个值，才是这一版代码真正被构建出来的时间。
mod build_stamp {
    #[cfg(windows)]
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        /// <https://learn.microsoft.com/windows/win32/api/sysinfoapi/nf-sysinfoapi-getlocaltime>
        fn GetLocalTime(lp_system_time: *mut SystemTime);
    }

    /// `YYYY-MM-DD HH:MM:SS`（本地时间）。
    ///
    /// 取不到就返回「未知」——「关于」页少一行信息是可以接受的，
    /// 但绝不能让构建脚本自己失败（那会把整个编译带崩）。
    pub fn now_local() -> String {
        #[cfg(windows)]
        {
            let mut t = SystemTime::default();
            unsafe { GetLocalTime(&mut t) };
            // 年份为 0 = API 没写进去，按失败处理
            if t.year == 0 {
                return "未知".to_string();
            }
            format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                t.year, t.month, t.day, t.hour, t.minute, t.second
            )
        }
        #[cfg(not(windows))]
        {
            "未知".to_string()
        }
    }
}
