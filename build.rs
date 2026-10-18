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

    /* ⚠ r80g：这里**不再**把 onnxruntime.dll 拷到产物目录。
     *
     * 早期版本（r80）会拷 —— 那时 ort 是静态链接，dll 必须和 exe 放一起。
     * 现在改用 ort 的 `load-dynamic`：dll 由程序在**运行时**下载到
     * 「抠图模型」目录（用户要求「运行库随模型一起下载，并且跟模型存在一起」），
     * 再由 `aimatte::point_ort_at_runtime()` 通过 `ORT_DYLIB_PATH` 指过去。
     * 所以产物目录**不该**再有它 —— 有的话反而会让"随模型下载"看起来没生效。
     * 详见 Cargo.toml 的 `ort` 注释与 .cargo/config.toml。 */

    tauri_build::build()
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
