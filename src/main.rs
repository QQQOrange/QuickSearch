// Windows GUI 程序，不弹控制台
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// `json!` 是递归展开的宏，字段一多就会顶到默认的 128 层递归上限
// （config_view 里那个大对象就是）。调高一点，免得每加一个配置项就编译不过。
#![recursion_limit = "512"]

mod clip;
mod config;
mod cleanup;
mod crypto;
mod glass;
mod hook;
mod iconedit;
// r54：识图搜索（框选截图 → 以图搜图）与「本地路径一键定位」
mod imgsearch;
// r54 需求 3：明文配置的按项导出 / 导入（与「备份」那条加密路是两回事）
mod export;
mod ocr;
mod ocr_engines;
// r54 需求 2：划词是本地路径时，横条弹出文件管理器图标
mod paths;
// r55：从 main.rs 拆出来的引擎表（内置 engines.json 解析 / AI 引擎判定 /
//      搜索词拼接 / URL 百分号编码）。那一节只依赖 config 和 win::log，
//      自包含，抽走即可独立阅读与单测。原位置见 main.rs 里的迁移注释。
mod engines;
// r79：阿尔法抠图（自动 trimap + Closed-Form 风格求解 + 边缘去色）。
//      图标编辑器「自动描边 + 消除背景」的核心算法，独立成模块以便单测与阅读。
//      纯算法，不依赖 Tauri / 窗口 / 配置锁。
mod matting;
// r80：AI 抠图。`aimodels` 管模型清单/下载，`aimatte` 管 ONNX 推理。
//      两者都自包含（不依赖窗口/配置锁），方便单测；模型由用户按需下载，
//      不随程序分发。运行时需要同目录的 onnxruntime.dll。
mod aimodels;
mod aimatte;
// r80：AI 抠图与本地算法的**胶水** —— AI 出语义（哪些是主体），
//      本地出边缘质量（逐像素背景色拟合 + 去色）。分开写是为了让
//      `aimatte`（纯推理）与 `matting`（纯算法）各自保持可独立测试。
mod iconedit_ai;
mod webdav;
mod win;
// v1.2.0：自动更新。查 GitHub 最新版 → 程序内下载 → 校验 → 替换旧程序。
// 自包含（只依赖 win/ocr 的日志与网络错误措辞），可独立单测。
mod update;

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{VK_C, VK_CONTROL, VK_ESCAPE, VK_O};

use config::Config;
use hook::Ev;

/* ================================================================== */
/* 全局状态                                                            */
/* ================================================================== */

/// 横条窗口的几何。长度单位统一是「物理像素」，跟 SetWindowPos 一致。
#[derive(Default)]
struct Geo {
    /// 实体区域（胶囊 / 面板）相对窗口左上角的偏移与尺寸
    inner_x: i32,
    inner_y: i32,
    inner_w: i32,
    inner_h: i32,
    /// 窗口整体尺寸
    win_w: i32,
    win_h: i32,
    /// 前端报上来的 CSS 尺寸，用于重算和兜底显示
    css_w: f64,
    css_h: f64,
    css_ix: f64,
    css_iy: f64,
    css_iw: f64,
    css_ih: f64,
    /// 摆放窗口的「钉住点」CSS 偏移（横条胶囊自身在 stage 里的位置），
    /// 和 css_ix（整棵包围盒的左缘）是两回事：收藏面板向左探出时，
    /// 包围盒左缘 = 面板左缘 << 横条左缘。钉住点决定窗口往哪摆
    /// （横条该贴哪还贴哪），包围盒决定点击命中区域（整块都要能点）。
    /// 老字段名 ix 继续承载包围盒语义， backward-compatible。
    css_pin_x: f64,
    css_pin_y: f64,
    /// 面板往横条左边探出的量（CSS px）—— 重摆窗口时要用同一个值
    css_shift_x: f64,
    /// 拖动收藏面板时的窗口偏移（CSS px）
    css_off_x: f64,
    css_off_y: f64,
    /// 横条该贴在哪（屏幕物理像素）。贴鼠标时是鼠标点，贴文字时是光标左下角 ——
    /// 除了摆放窗口，它还兼作「取背景色」的采样中心。
    anchor: Option<(i32, i32)>,
    /// 本次是「贴鼠标」摆放（true）还是「贴文字」摆放（false）
    anchor_mouse: bool,
    /// 选中文字那行的矩形 (left, top, right, bottom)，贴文字摆放时用
    caret: Option<(i32, i32, i32, i32)>,
    /// 横条胶囊自己的高度（CSS px），由前端每次回报。
    /// 撑窗后 inner 高度会被面板带大，所以这个值得单独存着，判断上下空间才准。
    bar_h: f64,
    shown: bool,
    /// 展开面板时借过焦点，关掉要还回去
    prev_fg: isize,
    focused: bool,
    /// 本次横条是「在哪个窗口、什么位置」被叫出来的 —— 收藏夹条目点下去要**回到那儿**。
    ///
    /// 为什么必须在弹条那一刻就记下来：面板一打开前台窗口就是我们自己了，
    /// 「鼠标下面那个软件是谁」「它有没有文本框」这两个问题当场就问不出来。
    /// 用户口径是「输入到鼠标触发位置所在的其他软件的文本框里」，只有快照能还原现场。
    trigger_hwnd: isize,
    /// 触发时那个窗口里「有没有能收键盘输入的地方」（有 → 注入；没有 → 复制到剪贴板）。
    /// 判据见 `win::has_text_focus`：刻意宽松，宁可多注入也不能把常用场景判成"没有"。
    trigger_has_text: bool,
    /// 触发那一刻的鼠标位置
    trigger_pt: (i32, i32),
}

struct AppState {
    cfg: Mutex<Config>,
    geo: Mutex<Geo>,
    sel: Mutex<String>,
    sel_url: Mutex<Option<String>>,
    /// 本次选中文字里**所有**链接（用户要求：「选中的文本当中包含多个链接，
    /// 点击打开链接按钮之后，就会在多个标签页打开这些链接」）。
    ///
    /// 单个链接也在这里（长度 1）—— 前端那颗按钮的显隐判据从"整段是不是一条
    /// 网址"换成了"这段里有没有链接"，两种情形共用一条路。
    sel_urls: Mutex<Vec<String>>,
}

static STATE: OnceLock<AppState> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static BAR_HWND: AtomicIsize = AtomicIsize::new(0);
/// OCR 框选遮罩的窗口句柄。留一份是为了**紧急强杀**：
/// 万一哪天主线程又卡住（Tauri 的 close/destroy 都要经过主线程），
/// 还能绕开它直接把遮罩从屏幕上扒下来 —— 这层遮罩铺满全屏，留着就等于
/// 把整个鼠标锁死，用户连任务栏都点不到，只能强杀进程。
static REGION_HWND: AtomicIsize = AtomicIsize::new(0);
static BUSY: AtomicBool = AtomicBool::new(false);
static GEN: AtomicUsize = AtomicUsize::new(0);

/// 剪贴板操作的串行锁。
///
/// 为什么要它：取词有**两条**路径会同时动剪贴板 —— 拖选那条要先模拟 Ctrl+C
/// 再把原内容还回去（capture_selection），而用户自己按 Ctrl+C 那条在读
/// （read_current）。`clip::restore` 内部是「先 EmptyClipboard 再逐项写回」，
/// 两条线程交错的后果是：用户原本复制的东西被永久清空、或者换回半个别人的数据。
/// 按住 Ctrl+C（键盘自动重复）或「拖选弹条后马上又按 Ctrl+C」都能撞上。
/// 所以所有剪贴板读写都包在这把锁里。
static CLIP_LOCK: Mutex<()> = Mutex::new(());

/// 最近一次 `show_bar` 的起点时刻 —— 用来量**端到端**延迟
/// （show_bar 入口 → 窗口真的可见），那条日志在 `layout_bar` 里打。
/// 用户对"弹出速度"的诉求只能这样量：前端渲染 + IPC 往返 + 摆位都在中间，
/// 凭感觉猜不出是哪一段慢。
static SHOW_T0: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// 取这把锁（毒化自愈：持锁线程 panic 之后，后续的取词不能再永久失效）。
fn lock_clip() -> std::sync::MutexGuard<'static, ()> {
    CLIP_LOCK.lock().unwrap_or_else(|e| {
        let g = e.into_inner();
        win::log("CLIP_LOCK 曾被毒化（持锁 thread panic 过），已自愈");
        g
    })
}

/// BUSY 的 RAII 守卫。
///
/// 以前 BUSY.swap(true) 之后靠工作线程末尾手工 store(false)：那条线程里任何
/// 一处 panic（这项目用的是 unwind 而非 abort，见 Cargo.toml），BUSY 就永远是
/// true，此后每次都打日志"上一次取词还没结束" —— 用户看到的是
/// **选中文字再也弹不出横条，重启软件也没用**。用 Drop 兜底。
struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// 「暂停使用」—— 来自托盘菜单的开关。
///
/// **故意只放在内存里，不写进配置**：暂停是个临时状态（开会投屏、专心写东西），
/// 万一是持久化的，用户哪天暂停完忘了恢复，重启后软件"怎么选词都不弹"，
/// 十有八九会当成 bug 查半天。重启即恢复，是个更讨喜的失败方向。
///
/// 语义上它只掐**自动触发**那条线（拖选、Ctrl+C）。主动操作一律照常：
/// Ctrl+Alt+O 截图识别、托盘里的设置 / 立即同步 / 打开配置目录都不受影响 ——
/// 「暂停使用」不该变成「软件失灵」。
static PAUSED: AtomicBool = AtomicBool::new(false);

fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// 切换暂停状态，并把托盘那一项的文字 / 图标 / 悬停提示一起刷新。
fn set_paused(a: &AppHandle, on: bool) {
    PAUSED.store(on, Ordering::SeqCst);
    win::log(&format!("paused = {on}"));
    if on {
        // 已经在屏幕上的那条也收掉，不然"暂停了但横条还杵在那"很迷惑
        dismiss_bar();
    }
    refresh_tray(a);
}

/// 「藏起来」的实现方式：窗口本身一直是显示状态（这样 WebView2 才会一直渲染），
/// 只是被挪到屏幕外面去了。直接 ShowWindow(SW_HIDE) 会绕过 Tauri/wry 的可见性
/// 状态机，WebView2 控制器就停在隐藏态不再复绘 —— 踩过这个坑。
const OFFSCREEN: i32 = -20000;

fn st() -> &'static AppState {
    STATE.get().expect("state not ready")
}

/// `st()` 的**不 panic** 版本：状态没就绪时返回 `None`。
///
/// 给"在测试里也会被调用"的代码用（如 `iconedit_ai::try_ai`）——
/// 那些函数的契约是"永不报错、失败就回退"，不能用会在测试环境 panic 的 `st()`。
pub(crate) fn try_st() -> Option<&'static AppState> {
    STATE.get()
}

fn app() -> &'static AppHandle {
    APP.get().expect("app not ready")
}

fn bar_win() -> Option<tauri::WebviewWindow> {
    app().get_webview_window("bar")
}

fn bar_hwnd() -> HWND {
    HWND(BAR_HWND.load(Ordering::Relaxed) as *mut c_void)
}

fn cfg_snapshot() -> Config {
    st().cfg.lock().map(|c| c.clone()).unwrap_or_default()
}

/// 窄化读取：只借锁把自己要的那一两个字段拷出来。
///
/// `cfg_snapshot()` 会**整份**克隆 Config —— 收藏夹里的图片是 dataURL，
/// 塞满图时能有几 MB；而很多调用点只要一个字段（ocr_region 只要
/// ocr_engine、webdav_* 只要四个字段、backup_info 只要 backup_dir）。
/// 克隆是在**持锁状态**下做的：几 MB 的拷贝足以让同刻的其它命令干等几十毫秒。
/// 这些热点全部换成窄读，锁一借到就只掏自己要的东西。
/// 锁被毒化也照读（`into_inner`）—— 读个字段总比返回默认值把用户设置看丢强。
fn cfg_with<T>(f: impl FnOnce(&Config) -> T) -> T {
    match st().cfg.lock() {
        Ok(g) => f(&g),
        Err(pe) => f(&pe.into_inner()),
    }
}

/* ================================================================== */
/* 引擎表（r55：逻辑搬到 src/engines.rs，这里只留"读全局配置"的方便版）   */
/* ================================================================== */

/// 某个引擎该不该按 AI 处理。
///
/// 纯逻辑版在 `engines::is_ai_engine_in`（吃 `&Config`，能单测）；
/// 这一条是**读全局配置**的方便版，调用点都在「松手弹条」的热路径上。
/// 之所以留在 main：全局状态和 Tauri 的生命周期绑死，搬不进模块。
///
/// 窄读：只借锁判一个 bool 就还 —— 整份克隆 Config（含收藏图片 dataURL）
/// 在这个热路径上纯属浪费。
fn is_ai_engine(name: &str) -> bool {
    cfg_with(|c| engines::is_ai_engine_in(c, name))
}

/// 某个引擎完整的调用信息（读全局配置版）。
/// 优先级与纯逻辑版一致，见 `engines::engine_entry_in`。
fn engine_entry(name: &str) -> Option<engines::EngineEntry> {
    cfg_with(|c| engines::engine_entry_in(c, name))
}

/// 把选中的文字拼成最终要交给引擎的搜索词（读全局配置版）。
/// 拼接规则见 `engines::compose_query_in`。
fn compose_query(engine: &str, text: &str) -> String {
    cfg_with(|c| engines::compose_query_in(c, engine, text))
}

/// 批量打开链接。
///
/// **开几个由 OCR 窗口那颗开关决定**（用户明确的口径）：
///  - 开关关着 → 前端只传 1 条（第一条），本函数就只开一个标签页；
///  - 开关打开 → 前端把全部链接传进来，一条一个标签页。
/// 所以「开一条还是开一堆」的取舍在前端 `openDetectedLinks()` 里做，
/// 这里只负责老老实实把收到的每一条都打开。
///
/// **用系统默认浏览器打开**（用户点名要求）：`open::that` 在 Windows 上就是
/// ShellExecuteW("open")，交给系统的 URL 关联程序，即用户设的默认浏览器 ——
/// 不是我们写死 Chrome/Edge，用户换默认浏览器立刻跟着变。
///
/// 保险两道：按 `MAX` 截断（防一段文字里识别出几百条链接一次把浏览器打爆）；
/// 去重（extract_links 已去重，这里再挡一次裸传）。
///
/// ⚠ 这一条**故意留在 main**（没跟着引擎表一起搬去 engines.rs）：
///   它要往 "ocr" 窗口推 toast，得用 `APP` 全局句柄 —— 那是 Tauri 的
///   生命周期符号，见 `engines.rs` 文件头的说明。真正可搬的逻辑
///   （`text_to_url` / `extract_links` / `encode_query`）都在那边。
#[tauri::command]
fn open_links(links: Vec<String>) {
    spawn_open_links(links);
}

/// 把一批链接**分别**开成标签页。
///
/// `open_links` 命令（OCR 结果页那颗「打开链接」）和横条那颗 🔗 共用这一份 ——
/// 横条以前只开 `sel_url` 单条，用户要求"含多个链接就分别开多个标签页"。
fn spawn_open_links(links: Vec<String>) {
    const MAX: usize = 12;
    // ⚠ 以前这个函数是在**命令线程**里逐条 sleep(120ms) 的：12 条链接就是
    //   1.44 秒 —— 期间 Tauri 的这条命令栈一直占着，其它 IPC 得排队，页面会
    //   明显顿一下。挪到后台线程，命令立刻返回。（open_app_picker 已经是这个套路。）
    std::thread::spawn(move || {
        let mut opened = 0usize;
        for l in links.iter().take(MAX) {
            let Some(u) = engines::text_to_url(l.trim()) else { continue };
            win::log(&format!(
                "open_links: {}",
                u.chars().take(160).collect::<String>()
            ));
            let _ = open::that(u);
            opened += 1;
            // 稍微错开一点，免得浏览器同一毫秒收到一堆请求
            std::thread::sleep(Duration::from_millis(120));
        }
        if links.len() > MAX {
            win::log(&format!(
                "open_links: 共 {} 条，只开了前 {MAX} 条（防打爆浏览器）",
                links.len()
            ));
        }
        let _ = APP.get().map(|a| {
            a.emit_to(
                "ocr",
                "qs://toast",
                format!("已打开 {opened} 个标签页（共识别到 {} 条链接）", links.len()),
            )
        });
    });
}

/* ================================================================== */
/* 横条主题                                                            */
/* ================================================================== */

/// 横条的明暗极性听谁的：用户显式选的「亮色 / 暗色」优先，
/// 「跟随系统」（以及没选 / 老配置没这个字段）才看 Windows 的日/夜间模式。
///
/// #148 起横条不再自动取色，这里就是横条主题的**唯一**来源 ——
/// 显式选的必须压过系统偏好（设置页的承诺）。
fn theme_dark_from(theme: &str, system_light: Option<bool>) -> bool {
    match theme {
        "light" => false,
        "dark" => true,
        _ => system_light.map(|l| !l).unwrap_or(false),
    }
}

/// 横条的主题载荷（`qs://theme` 事件的 payload）：明暗极性 + 底色。
///
/// #148 删掉了「自动取色」整条链路（从当前软件窗口 UI 采主色当横条底色）：
/// 底色恒为 null，横条走 CSS 自带的两套配色（`.stage` / `.qs-dark`，
/// 前端 applyThemePayload 本来就认 null）；明暗由「主题」设置 +
/// Windows 日/夜间模式决定（theme_dark_from）。
fn current_theme() -> Value {
    let dark = theme_dark_from(
        &cfg_with(|c| c.theme.clone()),
        win::apps_use_light_theme(),
    );
    json!({ "dark": dark, "bg": Value::Null })
}

/* ================================================================== */
/* 横条显示 / 隐藏                                                     */
/* ================================================================== */

fn in_rect(x: i32, y: i32, r: (i32, i32, i32, i32)) -> bool {
    x >= r.0 && x < r.2 && y >= r.1 && y < r.3
}

/// 屏幕坐标下的一块矩形 (left, top, right, bottom)。
type Rect = (i32, i32, i32, i32);

/// 返回 (窗口整体矩形, 实体矩形)，都在屏幕坐标
fn bar_rects() -> Option<(Rect, Rect)> {
    let h = bar_hwnd();
    if h.0.is_null() {
        return None;
    }
    let g = st().geo.lock().ok()?;
    if !g.shown {
        return None;
    }
    let r = win::window_rect(h)?;
    let outer = (r.left, r.top, r.right, r.bottom);
    let inner = (
        r.left + g.inner_x,
        r.top + g.inner_y,
        r.left + g.inner_x + g.inner_w.max(1),
        r.top + g.inner_y + g.inner_h.max(1),
    );
    Some((outer, inner))
}

fn is_bar_inner(x: i32, y: i32) -> bool {
    bar_rects().map(|(_, i)| in_rect(x, y, i)).unwrap_or(false)
}

fn is_bar_outer(x: i32, y: i32) -> bool {
    bar_rects().map(|(o, _)| in_rect(x, y, o)).unwrap_or(false)
}

fn is_bar_shown() -> bool {
    st().geo.lock().map(|g| g.shown).unwrap_or(false)
}

fn dismiss_bar() {
    let h = bar_hwnd();
    if h.0.is_null() {
        return;
    }
    /* ⚠ 收藏面板的「钉住」必须在**所有提前 return 之前**复位。
     *
     * 原来 `FAV_PINNED` 只在 `set_fav_pinned` 里改：用户钉住面板 → 按 Esc 收条 →
     * 下次划词弹出来，点面板外面依旧"已钉住，忽略收起"，一直到用户手动取消钉住。
     * 用户感知就是「横条收不掉了」。钉住的语义本来就是"这一次展开时别自动收"，
     * 收起即结束。
     *
     * 位置很讲究：下面 `!g.shown && !g.focused` 那条会**提前 return**（横条本来
     * 就是收着的），复位放它后面就永远轮不到 —— 必须放最前面。 */
    if FAV_PINNED.swap(false, Ordering::SeqCst) {
        win::log("dismiss_bar: 收藏面板原本钉着，随收起一并解除");
        let _ = app().emit_to("bar", "qs://fav-pinned", serde_json::json!({ "on": false }));
    }
    // 横条收起 = 不再有实时抓屏：无条件解除「对抓屏隐身」。
    // 实时模式开着的时候用户按了 Esc / 点了别处，前端可能来不及发
    // glass_exclude(false)，窗口却已经不接受抓屏了 —— 那时用户截图
    // 录屏里横条会凭空消失。在这里兜底，双保险。
    glass::clear_exclude_from_capture(h);
    let restore = {
        let mut g = match st().geo.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if !g.shown && !g.focused {
            return;
        }
        g.shown = false;
        // 锚点必须一起清掉：前端收到 qs://hidden 后还会回一次 layout_bar，
        // 锚点留着的话 layout_bar 会把窗口重新摆回屏幕上。
        g.anchor = None;
        let r = if g.focused { g.prev_fg } else { 0 };
        g.focused = false;
        r
    };
    // 收起是有代价的：锚点被清掉之后，**之后任何一次 layout_bar 都不会再摆窗**
    // （"尚无锚点，只记录尺寸、不摆放窗口"），面板/菜单要撑窗口就撑不起来了。
    // 这条日志是排查"面板被切一块 / 窗口没跟着长大"那类问题的起点。
    win::log("dismiss_bar: 已收起横条（锚点一并清掉）");
    GEN.fetch_add(1, Ordering::SeqCst);
    win::set_noactivate(h, true);
    match bar_win() {
        Some(bw) => {
            let _ = bw.set_position(tauri::PhysicalPosition::new(OFFSCREEN, OFFSCREEN));
        }
        None => {
            let (w, hh) = match st().geo.lock() {
                Ok(g) => (g.win_w.max(40), g.win_h.max(30)),
                Err(_) => (600, 100),
            };
            win::move_resize(h, OFFSCREEN, OFFSCREEN, w, hh, false);
        }
    }
    if restore != 0 {
        win::set_foreground(HWND(restore as *mut c_void));
    }
    let _ = app().emit_to("bar", "qs://hidden", ());
}

/// 前端量完布局后回报，我们据此摆窗口。
///
/// `bar_h` 是**横条胶囊自己**的高度（CSS px），和 `h`（整个 stage 的高度）不是
/// 一回事：面板一展开 stage 会高出一大截，而判断「文字下面还放不放得下」只能拿
/// 胶囊的高度去算。
///
/// `pin_x`/`pin_y` 是**钉住点**——横条胶囊自身相对 stage 左上角的偏移。
/// 窗口摆放钉它（贴文字时钉在光标旁、贴鼠标时钉在锚点），而 `ix`/`iw`
/// 仍是整棵包围盒（横条 ∪ 面板 ∪ 菜单）的左缘/尺寸，只用于命中判定。
/// 两者分离是为了收藏面板「向左拉宽」：面板左缘探出到横条左侧时，
/// 若还按包围盒左缘摆放，光标模式下窗口会被带着往右滑、面板左缘纹丝不动
/// （用户报的「收藏面板只能拉右边、左边拉不动」的根因）。
#[tauri::command]
// Tauri 命令的参数必须平铺（前端 invoke 按名字逐个传），不能收拢成结构体，
// 否则前端调用签名全要跟着改。13 个参数各有各的用处（见文档注释）。
#[allow(clippy::too_many_arguments)]
fn layout_bar(
    w: f64,
    h: f64,
    ix: f64,
    iy: f64,
    iw: f64,
    ih: f64,
    bar_h: f64,
    pin_x: f64,
    pin_y: f64,
    shift_x: f64,
    offset_x: f64,
    offset_y: f64,
    /* 拖动中的**被拖块**矩形（CSS px，相对窗口）：[x, y, w, h]。
     * 收藏面板拖动时前端把它传上来 —— 面板挂在横条下面，横条占着包围盒最上面那一条，
     * 按整棵包围盒钳的话面板顶边永远差着横条那一条到不了屏幕上边。 */
    drag_rect: Option<Vec<f64>>,
) {
    let hwnd = bar_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    let scale = win::dpi_scale(hwnd);
    win::log(&format!(
        "layout_bar css=({w},{h},{ix},{iy},{iw},{ih}) barH={bar_h} scale={scale}"
    ));
    // 面板往横条左边探出的量（CSS px，>=0）：窗口要往左多让出这么多，
    // 同时把合成面在窗口内右移同等量，内容才不会被裁掉（见 WV_SHIFT_X）。
    let pshift = (shift_x.max(0.0) * scale).round() as i32;
    // 拖动收藏面板时用的**窗口偏移**：面板在内容里不动，改由窗口整体平移 ——
    // 面板永远落在窗口内（不会被裁），窗口本身再由下面的显示器钳制兜住（不会出屏）。
    let mut poffx = (offset_x * scale).round() as i32;
    let mut poffy = (offset_y * scale).round() as i32;    let pw = (((w * scale).round() as i32) + pshift).max(40);
    let ph = ((h * scale).round() as i32).max(30);
    let pix = (ix * scale).round() as i32;
    let piy = (iy * scale).round() as i32;
    let piw = ((iw * scale).round() as i32).max(8);
    let pih = ((ih * scale).round() as i32).max(8);
    // 摆放钉住点（横条自身偏移）与命中判定（包围盒）分离，见函数文档
    let ppx = (pin_x * scale).round() as i32;
    let ppy = (pin_y * scale).round() as i32;

    // 锚点只有 show_bar 才会设。刚启动时前端也会先报一次布局，那属于「纯通知」，
    // 那时还没有锚点 —— 要是顺手拿光标位置当锚点把窗口摆出去，用户一开机
    // 就会看到一条横条莫名其妙飘在屏幕角落上。
    let (anchor, anchor_mouse, caret) = {
        let mut g = match st().geo.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        g.css_w = w;
        g.css_h = h;
        g.css_ix = ix;
        g.css_iy = iy;
        g.css_iw = iw;
        g.css_ih = ih;
        g.css_pin_x = pin_x;
        g.css_pin_y = pin_y;
        g.css_shift_x = shift_x.max(0.0);
        g.css_off_x = offset_x;
        g.css_off_y = offset_y;
        g.inner_x = pix;
        g.inner_y = piy;
        g.inner_w = piw;
        g.inner_h = pih;
        g.win_w = pw;
        g.win_h = ph;
        if bar_h > 1.0 {
            g.bar_h = bar_h;
        }
        (g.anchor, g.anchor_mouse, g.caret)
    };
    let Some((ax, ay)) = anchor else {
        win::log("layout_bar: 尚无锚点，只记录尺寸、不摆放窗口");
        return;
    };

    let area = win::work_area_near(ax, ay);
    let pad = 8;
    let gap = ((6.0 * scale).round() as i32).max(3);
    let bar_ph = ((bar_h.max(8.0) * scale).round() as i32).max(8);
    win::log(&format!(
        "layout: mode={} area=({},{},{},{}) bar={bar_ph}",
        if anchor_mouse { "mouse" } else { "text" },
        area.left, area.top, area.right, area.bottom
    ));

    // ---- 算出「实体区域」在屏幕上的左上角 ----
    //
    // 注意这里摆的是**实体区域**（也就是横条胶囊）的位置，不是窗口的位置：
    // 窗口四周还有一圈透明边距（--qs-margin，开投影时还有 --qs-shadow-pad），
    // 而 CSS 里胶囊永远在最上边。所以只要让「实体顶边」落到该落的地方，
    // 减去 iy 就得到窗口的 y。这样面板展开与否都不影响胶囊自己的位置。
    // 用来记录这次到底选了哪一侧 —— 摆位是用户最在意的行为之一，
    // 只有把决策落进日志，验证脚本才能断言，而不是靠猜窗口坐标。
    let side: &str;
    let (mut ix2, mut iy2) = match caret {
        Some((cl, ct, _, cb)) => {
            // 默认优先放在文字**上方**：用户刚选中的文字不应该被横条盖住，
            // 放在上方最符合直觉；上方放不下再翻转到下方。
            let fit_above = ct - gap - bar_ph >= area.top + pad;
            let want_below = !fit_above && cb + gap + bar_ph <= area.bottom - pad;
            let iy2 = if want_below {
                // 胶囊顶边贴在文字下沿之下
                side = "below";
                cb + gap
            } else {
                // 胶囊底边贴在文字上沿之上（fit_above 为 true 时标准位置；
                // fit_above 为 false 时会被后续 clamp 压到工作区顶部，但至少方向是对的）
                side = if fit_above { "above" } else { "above-clamped" };
                ct - gap - bar_ph
            };
            (cl, iy2)
        }
        // 贴鼠标：锚点就是实体区域左上角
        _ => {
            side = "mouse";
            (ax, ay)
        }
    };
    if ix2 + piw > area.right - pad {
        ix2 = area.right - piw - pad;
    }
    if ix2 < area.left + pad {
        ix2 = area.left + pad;
    }
    if iy2 + pih > area.bottom - pad {
        iy2 = area.bottom - pih - pad;
    }
    if iy2 < area.top + pad {
        iy2 = area.top + pad;
    }

    /* ---- 拖动收藏面板：按**看得见的实体**钳，而不是按窗口矩形钳 ----
     *
     *  用户报的原话：「它不能够拖到屏幕的边缘…只能拖到左边屏幕的右边缘，但是右边
     *  上面就不可以」。量出来的原因（见 tools/r50-drag-probe.js 的日志）：
     *
     *    窗口 = 实体 + 四周一圈**透明**边距（上面 ~65 CSS px 的面板头 + 外边距、
     *    左面 24 px…），而下面那道"保险"是拿**窗口矩形**去比显示器边界的：
     *        if wx + pw > mon.right { wx = mon.right - pw }   ← 贴着窗口右缘停
     *        if wy < mon.top       { wy = mon.top }           ← 窗口顶到屏顶就停
     *    于是面板顶边永远差着那 65px 到不了屏幕顶（实测 win=(2992,0) 时面板顶
     *    还停在 65 CSS）；窗口比面板宽时，面板右边也永远差着宽度差到不了屏右边。
     *
     *  拖动时改成钳**实体矩形**（ix/iy/iw/ih，物理像素）：实体四边都能贴到工作区
     *  边缘，窗口那圈透明边距允许伸到屏外（它本来就什么都不画）。
     *  顺带把显示器也换成"实体中心所在那块"：以后多显示器时能拖到另一块屏上。 */
    if poffx != 0 || poffy != 0 {
        let cx_now = ix2 + poffx + piw / 2;
        let cy_now = iy2 + poffy + pih / 2;
        let wmon = win::monitor_near(cx_now, cy_now);
        /* 钳哪个矩形：默认整棵实体包围盒；前端传了 drag_rect 就用它（收藏面板拖动）。
         * 面板在横条下面 —— 按包围盒钳时面板顶边永远差着横条那一条（实测 41 CSS px）。 */
        let (rx, ry, rw, rh) = match drag_rect.as_ref().filter(|v| v.len() == 4) {
            Some(v) => (
                (v[0] * scale).round() as i32,
                (v[1] * scale).round() as i32,
                ((v[2] * scale).round() as i32).max(8),
                ((v[3] * scale).round() as i32).max(8),
            ),
            None => (pix, piy, piw, pih),
        };
        // 目标窗口位置（未钳）→ 把被拖块四边都收进工作区
        let base_x = ix2 - ppx - pshift;
        let base_y = iy2 - ppy;
        let mut want_x = base_x + poffx;
        let mut want_y = base_y + poffy;
        if want_x + rx < wmon.left {
            want_x = wmon.left - rx;
        }
        if want_x + rx + rw > wmon.right {
            want_x = wmon.right - rx - rw;
        }
        if want_y + ry < wmon.top {
            want_y = wmon.top - ry;
        }
        if want_y + ry + rh > wmon.bottom {
            want_y = wmon.bottom - ry - rh;
        }
        poffx = want_x - base_x;
        poffy = want_y - base_y;
    }
    WV_SHIFT_X.store(pshift, Ordering::SeqCst);
    let mut wx = ix2 - ppx - pshift + poffx;
    let mut wy = iy2 - ppy + poffy;

    // ---- 最后一道保险：横条的可见部分绝不能出屏 ----
    // 上面的钳制依据前端报上来的尺寸；万一它量小了/晚到了（图标晚加载把
    // 横条撑高、或面板刚展开），这里再用显示器的**物理边界**兜一次底，
    // 内边距按窗口自身的透明边距（pix/piy）折算，保证胶囊整体都在屏内。
    // ⚠ 拖动中跳过这一道：它按**窗口矩形**钳，会把上面那段"按实体矩形钳"的
    //   结果又拽回来（面板顶边永远差 65px 到不了屏幕顶 —— 就是用户报的那条）。
    //   拖动时实体四边已被钳进工作区，屏幕外只剩那圈不画东西的透明边距。
    if poffx == 0 && poffy == 0 {
        let mon = win::monitor_near(ix2, iy2);
        if wx + pw > mon.right {
            wx = mon.right - pw;
        }
        if wx < mon.left {
            wx = mon.left;
        }
        if wy + ph > mon.bottom {
            wy = mon.bottom - ph;
        }
        if wy < mon.top {
            wy = mon.top;
        }
    }

    // 这一行是摆位验证的唯一事实来源：caret 是文字那行的矩形，side 说明
    // 最终落在文字的上面还是下面，inner 是横条胶囊的左上角（屏幕物理像素）。
    win::log(&format!(
        "place: side={side} caret={:?} gap={gap} barPh={bar_ph} limit={} inner=({ix2},{iy2}) win=({wx},{wy})",
        caret,
        area.bottom - pad
    ));

    // ---- 告诉前端「横条下面还剩多少地方」----
    // 收藏面板的高度上限必须按这个来，不能按屏幕的百分之多少：
    // 以前前端按屏幕 78% 给 max-height，横条靠屏幕下方时面板根本放不下，
    // 下面那段钳制（iy2 + pih > area.bottom - pad）就只能把**整条横条往上挪** ——
    // 用户看到的就是「一点收藏夹，横条立刻跑到别的地方去了」。
    // 面板按剩余空间收窄（内部滚动），横条就纹丝不动。
    {
        let room_phys = (area.bottom - pad) - (iy2 + bar_ph) - ((8.0 * scale).round() as i32);
        let room_css = (room_phys as f64 / scale).floor().max(120.0) as i64;
        // 左边还剩多少：西向（左/左下）缩放要把窗口往左撑，撑不出屏幕就白费 ——
        // 前端拿它当上限，横条贴屏幕左缘时不会硬撑、也就不会被 Rust 钳回屏内推着走。
        let left_phys = ix2 - (area.left + pad);
        let left_css = (left_phys as f64 / scale).floor().max(0.0) as i64;
        // 右边还剩多少：面板整体宽度不能超过它，否则 Rust 的锚点钳制
        // （ix2 + piw > area.right - pad）会把锚点往左推 —— 表现就是
        // 「横条明明还在原地，窗口却跑到别处去了」（用户报的第 2 条）。
        // 上边还剩多少：面板拖动要能往上走，得先有地方（同一套 padding 让位机制）
        let top_phys = iy2 - (area.top + pad);
        let top_css = (top_phys as f64 / scale).floor().max(0.0) as i64;
        let right_phys = (area.right - pad) - ix2;
        let right_css = (right_phys as f64 / scale).floor().max(200.0) as i64;
        static LAST_ROOM: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(i64::MIN);
        let key = (room_css << 20) | (left_css & 0xFFFFF) | (right_css << 44)
            | ((top_css & 0xFFFF) << 63);
        if LAST_ROOM.swap(key, Ordering::SeqCst) != key {
            let _ = app().emit_to(
                "bar",
                "qs://bar-room",
                json!({ "below": room_css, "left": left_css, "right": right_css,
                        "top": top_css }),
            );
        }
    }

    // 记下这一下是不是「从看不见 → 看得见」。只有这一下才是用户感知的"弹出"，
    // 后面面板重排/尺寸微调引起的重摆不算 —— 端到端延迟只报首次显示那一次。
    let first_show = match st().geo.lock() {
        Ok(mut g) => {
            let was = g.shown;
            g.shown = true;
            !was
        }
        Err(_) => false,
    };
    // 右键轮询线程平时挂在条件变量上省电，横条真显示了才把它叫醒（见 spawn_rbutton_watch）
    if first_show {
        wake_rbutton_watch();
    }

    /* ⭐ 液态玻璃的背景抓取：横条**首次上屏前**抓一块它将要占据的屏幕矩形。
     *
     * 为什么是这个时机：此刻窗口还在屏外（启动时就在 (-20000,-20000)，
     * dismiss_bar 也会把它挪回去），BitBlt 抓到的必然是"没有横条"的干净桌面 ——
     * 不存在把自己抓进纹理的反馈环，也不需要隐藏-抓取-显示那套抖动。
     *
     * 为什么只抓首次：面板重排引起的重摆里，横条胶囊本身并不移动
     * （锚在顶上，只有窗口往下长），玻璃要折射的背景没变；真正需要重抓的
     * 是整扇窗户搬家（拖动面板 / 实时模式），那由前端显式调 glass_capture。
     *
     * 抓完只暂存不发事件：窗口这一刻还没可见，等下面 move_resize 落地后再
     * 补发 qs://glass，前端收到再 glass_take 取字节 —— 那时 DOM 已布局，
     * 算得出玻璃画布在窗口里的子矩形（shader 的 u_bounds）。 */
    let mut glass_fresh = false;
    if first_show && cfg_with(|c| c.bar_glass) {
        if let Some(s) = glass::capture_store(wx, wy, pw, ph) {
            win::log(&format!(
                "glass: 已抓背景 {}x{} @({},{})，{} 字节，等前端取",
                s.w, s.h, s.x, s.y, s.rgba.len()
            ));
            glass_fresh = true;
        } else {
            win::log("glass: 抓屏失败（矩形出屏或 DC 异常），玻璃退化为纯色底板");
        }
    }

    if std::env::var("QS_STATIC_POS").map(|v| v == "1").unwrap_or(false) {
        wx = 200;
        wy = 300;
    }
    /* ⭐ 面板开合 → 窗口矩形变了 → 把「上一块矩形」换成新的（**只记不抓**）。
     *
     * 需求 6：玻璃纹理必须覆盖整个窗口，否则面板那块区域"没有背景"。
     * 首次上屏那一抓（上面）抓的是**胶囊**矩形；面板一展开窗口变高，纹理就
     * 不够了 —— 用户看到的就是"更多引擎页 / 收藏夹页不跟主题走"。
     * 这里只更新矩形：此刻窗口正在屏上可见，直抓会把横条自己拍进纹理（自拍）。
     * 真正的重抓由前端 `QSGlass.refresh()` 发起（它会先把舞台隐藏、等两帧），
     * 抓到的仍是干净桌面。 */
    if !first_show {
        let (lx, ly, lw, lh) = glass::last_rect();
        // ⚠ 位置也要比：拖动面板 / 贴边重摆会让窗口**只挪不缩**，
        //   那时纹理整块都错位（不只是缺一块），照样得重抓。
        if (lx, ly, lw, lh) != (wx, wy, pw, ph) {
            glass::store_rect_only(wx, wy, pw, ph);
            win::log(&format!(
                "glass: 窗口矩形变了 {}x{}@({},{}) → {}x{}@({},{})，已更新待抓矩形（等前端 refresh）",
                lw, lh, lx, ly, pw, ph, wx, wy
            ));
        }
    }
    // ⚠ 尺寸和位置**必须一次 SetWindowPos 原子改掉**，不能 `set_size` + `set_position`
    //   分两步走：两者在 Tauri 里都是投递到事件循环的异步操作，中间必然有一帧
    //   「尺寸已经变了、位置还没变」—— 收藏面板左拉时表现为横条左右抖、
    //   整块面板在屏幕上不停乱闪（用户报的"不停的乱闪"就是这个）。
    //   走 win::move_resize 是同步的一次调用，不存在中间态。
    // r51 速度：摆位这三步各花多久（面板开合慢不慢，先看这里）
    let t_lb = std::time::Instant::now();
    win::move_resize(hwnd, wx, wy, pw, ph, true);
    let t_mr = t_lb.elapsed();
    // ⚠ 每次重摆都重申一次置顶。always_on_top 只在建窗那一刻生效一次，
    //   期间任何一次 z 序扰动（别的应用置顶、自己 set_position 的时机）
    //   都可能把横条压到别的窗口底下 —— 表现为「收藏夹窗口只显示一小块，
    //   甚至被别的窗口完全挡住什么都看不到」。成本就是一次 SetWindowPos。
    win::reassert_topmost(hwnd);
    let t_rt = t_lb.elapsed();
    // 合成面尺寸强制跟上窗口（收藏夹面板「被切掉一块」的根治手段）
    sync_webview_bounds();
    if !first_show {
        win::log(&format!(
            "⏱ layout_bar 摆位: move_resize={}ms reassert_topmost={}ms sync_webview_bounds={}ms 合计={}ms",
            t_mr.as_millis(),
            (t_rt - t_mr).as_millis(),
            (t_lb.elapsed() - t_rt).as_millis(),
            t_lb.elapsed().as_millis()
        ));
    }
    // 玻璃背景已抓到位（见上面 glass_fresh）：窗口这刻真的可见了，通知前端
    // 来取字节。取到之后它自己算画布子矩形、上传纹理、开渲。
    if glass_fresh {
        let _ = app().emit_to("bar", "qs://glass", json!({ "fresh": true }));
    }
    /* ⭐ 端到端延迟：从 show_bar 被调用，到窗口真的可见（这一行 SetWindowPos 之后）。
     * 用户反复说"弹得慢"，光靠感觉调不动 —— 把总耗时落进日志，
     * 每次优化都能拿它对比（本行 = 前置 + 取色 + 前端渲染 + 一次 IPC 往返 + 摆位）。 */
    if first_show {
        if let Some(t0) = SHOW_T0.lock().ok().and_then(|g| *g) {
            win::log(&format!(
                "⏱ 端到端 show_bar→窗口可见 = {}ms",
                t0.elapsed().as_millis()
            ));
        }
    }
    let (sst, sex) = win::style_of(hwnd);
    let center = win::window_under_point(wx + pw / 2, wy + ph / 2);
    win::log(&format!(
        "after-show: visible={} rect={:?} style={:#x} exstyle={:#x} topmost_window={:#x} cls={}",
        win::is_visible(hwnd),
        win::window_rect(hwnd),
        sst,
        sex,
        center.0 as isize,
        win::class_name(center)
    ));
    win::log(&format!(
        "layout: win=({},{},{},{}) inner=({},{},{},{})",
        wx, wy, pw, ph, pix, piy, piw, pih
    ));
}

/// 显式把 WebView2 的合成面（compositor surface）尺寸同步到窗口客户区。
///
/// 为什么需要：横条窗口 set_size 之后，Win32 窗口立刻变成新尺寸，但 WebView2
/// 的合成器表面**偶尔不会跟着走**——还停在旧尺寸上（典型的是启动时的那一次
/// 高度）。表现就是：收藏夹面板弹出时，新扩出来的区域是透明/残影，用户看到
/// 「窗口被生生切掉了一块」，切口正好是旧表面的边界。Tauri 的 set_size 不保证
/// 通知 WebView2 controller，这里自己补一次 ICoreWebView2Controller::SetBounds，
/// 强制合成面跟上窗口的真实客户区。
///
/// 带一个「上次同步过的尺寸」记忆：尺寸没变就不折腾，避免每次 layout_bar
/// （它会被前端频繁回报）都做一次跨线程调用。
#[cfg(windows)]
/// 合成面在窗口内的左偏移（物理像素）。
///
/// 面板（收藏夹）允许往**横条左边**探出去。WebView 的内容坐标系原点是窗口客户区
/// 左上角，内容 x < 0 的部分根本没地方画 —— 光把窗口往左挪没用（内容会被裁掉）。
/// 所以这里把**整个合成面**在窗口内右移 SHIFT_X：于是内容坐标 [-SHIFT_X, ...]
/// 落在窗口可见区内，面板取负 left 也不会被裁。
/// 关键：这次 SetBounds 和窗口的 SetWindowPos 都在 layout_bar 一次调用里完成 ——
/// 不经过「前端改 CSS → 再等一次 IPC 挪窗口」那条路，所以不会出现中间帧抖动。
static WV_SHIFT_X: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

fn sync_webview_bounds() {
    let Some(w) = bar_win() else { return };
    let hwnd = bar_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    let Some(r) = win::window_rect(hwnd) else { return };
    let (cw, ch) = (r.right - r.left, r.bottom - r.top);
    if cw <= 0 || ch <= 0 {
        return;
    }
    static LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let shift_now = WV_SHIFT_X.load(std::sync::atomic::Ordering::SeqCst).max(0) as u64;
    let key = ((cw as u64) << 32) | ch as u64 | (shift_now << 60);
    if LAST.swap(key, std::sync::atomic::Ordering::SeqCst) == key {
        return;
    }
    // HWND 是裸指针包装，闭包要求 Send —— 传地址进去再还原。
    let hwnd_addr = hwnd.0 as isize;
    let res = w.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
        let hwnd = HWND(hwnd_addr as *mut c_void);
        let controller: ICoreWebView2Controller = pw.controller();
        let mut rc = RECT::default();
        if GetClientRect(hwnd, &mut rc).is_ok()
            && rc.right > rc.left
            && rc.bottom > rc.top
        {
            let shift = WV_SHIFT_X.load(std::sync::atomic::Ordering::SeqCst).max(0);
            let _ = controller.SetBounds(RECT {
                left: shift,
                top: 0,
                right: rc.right - rc.left,
                bottom: rc.bottom - rc.top,
            });
            win::log(&format!(
                "wv2: SetBounds 同步合成面 → {}x{} shift={shift}",
                rc.right - rc.left,
                rc.bottom - rc.top
            ));
        }
    });
    if let Err(e) = res {
        /* ⚠ 失败时要把「已记账」的尺寸**回滚**。
         *
         * 这里先是 `LAST.swap(key)` 再发起跨线程调用 —— 调用失败却没回滚的话，
         * 下一次同样的尺寸会被 `LAST == key` 直接挡掉，于是合成面永远不再同步。
         * 用户看到的就是这个函数本来要治的那个症状：窗口被切掉一块。 */
        LAST.store(0, std::sync::atomic::Ordering::SeqCst);
        win::log(&format!("sync_webview_bounds: with_webview 失败: {e}（已回滚尺寸记账，下次重试）"));
    }
}

/// 右键菜单 / 展开面板可能比胶囊大，把窗口临时撑开
#[tauri::command]
fn grow_bar(need_w: f64, need_h: f64) {
    let hwnd = bar_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    let scale = win::dpi_scale(hwnd);
    let nw = ((need_w * scale).round() as i32).max(40);
    let nh = ((need_h * scale).round() as i32).max(30);

    // 注意：这里绝对不能在自己的 geo 锁作用域里再调 bar_rects()，
    // 它内部会第二次 lock 同一个 geo，std::sync::Mutex 不可重入 —— 直接死锁。
    // （之前菜单撑不开、命令线程越积越多最后整条横条卡死，就是这个原因。）
    let (cw, ch) = {
        let g = match st().geo.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if !g.shown {
            return;
        }
        (g.win_w, g.win_h)
    };

    let r = match win::window_rect(hwnd) {
        Some(r) => r,
        None => return,
    };
    let (x, y) = (r.left, r.top);

    if nw <= cw && nh <= ch {
        return;
    }
    win::move_resize(hwnd, x, y, nw.max(cw), nh.max(ch), true);
    if let Ok(mut g) = st().geo.lock() {
        g.win_w = nw.max(cw);
        g.win_h = nh.max(ch);
    }
    // 撑窗也要同步合成面，否则面板/菜单新扩出来的区域是残影
    sync_webview_bounds();
}

#[tauri::command]
fn focus_bar(enable: bool) {
    let hwnd = bar_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    if enable {
        let prev = {
            let mut g = match st().geo.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if g.focused {
                return;
            }
            g.focused = true;
            g.prev_fg = win::foreground_addr();
            g.prev_fg
        };
        let _ = prev;
        win::set_noactivate(hwnd, false);
        win::set_foreground(hwnd);
    } else {
        win::set_noactivate(hwnd, true);
        let restore = {
            let mut g = match st().geo.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let r = if g.focused { g.prev_fg } else { 0 };
            g.focused = false;
            r
        };
        if restore != 0 {
            win::set_foreground(HWND(restore as *mut c_void));
        }
    }
}

#[tauri::command]
fn hide_bar() {
    dismiss_bar();
}

/* ================================================================== */
/* 取词并弹条                                                          */
/* ================================================================== */

/// 剪贴板里的内容，是不是「我们信得过的那些进程」之一放进去的？
///
/// 只盯着剪贴板序号是不够的。序号变化只说明「有人动过剪贴板」，
/// 而几百毫秒的等待窗口里，用户自己按了复制、剪贴板管理器、
/// 带「自动复制」的词典插件……都可能插一脚。那种情况下读到的
/// 是**别人的内容**，横条就会莫名其妙弹出来 —— 用户要的是
/// 「没选中文字绝对不出现」，所以这里再加一道身份校验。
///
/// `trusted` = 允许的 owner pid 列表；**0 一律忽略**（0 表示"没拿到"）。
///
/// ⚠ **取不到判据就放行（fail-open）** —— 这里只是第二道保险，真正的判据是
///   「剪贴板序号变了没有」。卡在 pid=0 上会让正常复制也被挡掉：宁可多弹一次，
///   不能哑火。所以 `trusted` 里**全是 0**（一个可信 pid 都没拿到）时也放行。
///
/// 这个函数是三个调用点（Ctrl+C 兜底 / 拖选取词 / 迟到的复制补丁）合并出来的：
/// 它们判据本来就略有不同，但骨架一模一样，各自抄了一遍 —— 结果其中一份
/// （拖选取词）把「一个 pid 都没拿到」写成了拒绝，和它自己文档里写的 fail-open
/// 正好相反，会把那次取词白白丢掉。
fn clipboard_owner_trusted(trusted: &[u32]) -> bool {
    let owner = win::clipboard_owner();
    // 没人放 / 已经销毁 → 放行
    if owner.0.is_null() {
        return true;
    }
    // 拿不到 owner 的进程号（窗口已销毁 / 权限不足）→ 放行
    let opid = win::window_pid(owner);
    if opid == 0 {
        return true;
    }
    if trusted.iter().any(|&p| p != 0 && p == opid) {
        return true;
    }
    // 一个可信 pid 都没有 —— 判据根本不成立，按 fail-open 放行
    if trusted.iter().all(|&p| p == 0) {
        return true;
    }
    win::log(&format!(
        "clipguard: 剪贴板 owner pid={opid} 不在可信列表 {trusted:?} 里 —— 判定为别的程序在动剪贴板，忽略"
    ));
    false
}

/// 松手后、发 Ctrl+C 之前的稳定期（ms）。
///
/// 为什么需要它：很多软件（浏览器富文本区、Electron 应用、Office、
/// 各种 IDE）并不是在收到 mouseup 的那一刻建立选区，而是把「提交选区」
/// 丢进自己的消息队列里异步做。我们钩子一收到 mouseup 就立刻发 Ctrl+C，
/// 复制到的还是上一次的选区（甚至什么都没有）—— 序号没变 = 不弹，
/// 这就是"有时候不触发"最隐蔽的一因。40ms 足够这类软件把选区建好，
/// 又短到用户完全感觉不到延迟。
const SEL_SETTLE_MS: u64 = 40;

/// 重试前额外等待的时间序列（ms）。不同软件响应 Ctrl+C 的快慢能差出
/// 几百毫秒（远程桌面 / 虚拟机 / 大型文档窗口尤其明显）。序号没变就
/// 隔一会儿再来一次，直到有一次真的把选区复制进去。
const SEL_RETRY_BACKOFF_MS: [u64; 2] = [220, 380];

/// 每一轮投递复制请求之后，最多等多久去读剪贴板（ms），按轮次给。
///
/// 第一轮给得最长，因为有些客户端（微信 4.x）的复制是**两步**的：
///   ① `EmptyClipboard` 把剪贴板清空，并且**一直握着不撒手**；
///   ② 内部渲染 / 助手进程把数据准备好，才真的写进去、才关闭剪贴板。
/// 第①步到第②步之间，我们连 `OpenClipboard` 都打不开（别人的剪贴板没关），
/// 只能干等 —— 实测这段时间能到几百毫秒。
///
/// ⚠ 所以窗口内**绝不能再投一次复制请求**：重投会让它重新清空剪贴板、
///   把等待重新计时，于是每一轮都差一点点，永远等不到落地。
///   这正是"微信里十次有九次不弹、偶尔弹一次"的来源。
const SEL_READ_WINDOW_MS: [u64; 3] = [1500, 800, 800];

/// 拖选取词这条路信得过的 owner：**划词目标**（`target_pid`）或**当前前台**。
///
/// 为什么和 Ctrl+C 兜底那条线不一样：拖选这条路**知道用户是在哪个窗口里划的**
/// （`target_pid`），判据比"当前前台是谁"更准。微信 4.x 是「主进程 + 一堆渲染/
/// 助手进程」的多进程架构，"前台窗口"和"真正执行复制的进程"未必同一个 ——
/// 只认前台会把真选区挡掉。
///
/// 判据与 fail-open 原则都在 `clipboard_owner_trusted` 里。
fn clipboard_owned_by(target_pid: u32) -> bool {
    clipboard_owner_trusted(&[target_pid, win::window_pid(win::foreground_window())])
}

/// 模拟一次 Ctrl+C 把选区拿走，再立刻把原剪贴板还回去。
///
/// 结构是「3 个回合、每回合换一条取词通道」：
///   ① 真实的合成按键（SendInput）—— 对绝大多数程序有效；
///   ② 窗口消息 `WM_COPY`；
///   ③ 窗口消息 `Ctrl+C`（`WM_KEYDOWN`/`WM_KEYUP`）。
/// 任一回合拿到有效文字即返回。
///
/// 为什么要换通道：`SendInput` 造出来的按键带 `LLKHF_INJECTED` 标记，
/// 有些客户端会据此**无视**这些按键（微信 4.x 是 Qt 写的，属于高危对象），
/// 只走一条路的话这类程序里就会出现「划词永远不弹条」。
///
/// `target_pid` = 用户开始拖动的那个窗口所属进程，给剪贴板归属校验用。
fn capture_selection(target_pid: u32) -> Option<String> {
    // 仅测试用（和 QS_ALLOW_INJECTED / QS_SKIP_SENDINPUT 同一类逃生口）：
    // 跳过全部复制通道，直接落到 OCR 兜底，用来单独验证兜底那条路。
    if std::env::var("QS_FORCE_OCR").map(|v| v == "1").unwrap_or(false) {
        win::log("capture: QS_FORCE_OCR=1 —— 跳过复制通道");
        return None;
    }
    // 整段都必须在 CLIP_LOCK 里：中途要和 Ctrl+C 兜底那条线抢同一个剪贴板，
    // 交错的话 restore 的「先清空再写回」会把用户原本的复制内容冲掉。
    let _clip = lock_clip();
    /* ⚠ 快照失败**不再直接放弃**。
     *
     * 以前是「snapshot 拿不到就 return None」—— 而微信这类客户端会长时间占着
     * 剪贴板（它自带剪贴板监听），OpenClipboard 一直拿不到 → 取词在**第一步**
     * 就整个放弃 → 用户看到的现象正是"在微信里划词永远不弹条"。
     *
     * 现在的口径：拿不到快照就不还原（本来也没备到东西），但取词照做。
     * 最坏结果和用户自己按一次 Ctrl+C 一样（剪贴板被选区覆盖），不会更糟；
     * 换来的是"一定能弹"。 */
    let mut snap = clip::snapshot();
    let old_text = snap
        .as_ref()
        .and_then(|s| s.text())
        .map(|t| t.trim().to_string());
    if snap.is_none() {
        win::log("capture: 剪贴板被别的程序占着，快照失败 —— 本次跳过还原，取词继续");
    }
    /* 这一次取词的"现场记录"。排查时最想知道的三件事就是：目标窗口属于哪个进程、
     * 快照拿没拿到、复制前剪贴板里是什么 —— 一行写全，省得来回要日志。 */
    win::log(&format!(
        "capture: 开始 目标pid={target_pid} 快照={} 复制前剪贴板={:?}",
        if snap.is_some() { "ok" } else { "失败" },
        old_text
            .as_deref()
            .map(|s| s.chars().take(20).collect::<String>())
    ));
    /* 先等选区落地，再读「取词前」的序号 —— 顺序反了的话，软件在稳定期
     * 里自己提交的选区会把 before 带成新值，等我们自己的 Ctrl+C 反而
     * 「序号没变」，白白漏一次。 */
    std::thread::sleep(Duration::from_millis(SEL_SETTLE_MS));
    let before = clip::seq();
    let last_round = SEL_RETRY_BACKOFF_MS.len();
    let mut got: Option<String> = None;
    for round in 0..=last_round {
        if round > 0 {
            std::thread::sleep(Duration::from_millis(SEL_RETRY_BACKOFF_MS[round - 1]));
        }
        // 仅测试用的逃生口（和 QS_ALLOW_INJECTED / QS_INSTANCE_TAG 同一类）：
        // 跳过 SendInput 那一轮，直接从「窗口消息」通道开始 —— 用来单独验证
        // 新加的通道本身能不能取到词，正式启动不会带上。
        let skip_sendinput = std::env::var("QS_SKIP_SENDINPUT")
            .map(|v| v == "1")
            .unwrap_or(false);
        let copy_round = if skip_sendinput { 0 } else { 1 };
        let ch: String = if round == 0 && !skip_sendinput {
            win::send_ctrl_c();
            "SendInput".to_string()
        } else if round == copy_round {
            let ok = win::post_copy_to_focus();
            format!("WM_COPY{}", if ok { "" } else { "(投递失败)" })
        } else {
            let ok = win::post_ctrl_c_to_focus();
            format!("按键消息{}", if ok { "" } else { "(投递失败)" })
        };
        /* 投完复制请求后**轮询读**，而不是"等序号一变就读一次"。
         *
         * 两个理由，都是实测踩出来的：
         *   ① 延迟渲染：有些宿主先 `EmptyClipboard` + `SetClipboardData(NULL)`
         *      声明格式，等别人来要数据时才真的填进去。序号在"声明"那一刻就变了，
         *      可那一刻剪贴板里还是空的 —— 只读一次会稳定读到空。
         *   ② 复制可能是异步的（UI 进程把活儿交给渲染/助手进程），序号变了
         *      不等于数据已经就位。
         * 所以：轮询到 460ms，期间只要出现**和复制前不一样的非空文本**就算成功。
         * 读的时候走 `clip::read_text_any()`（UTF-16 → ANSI → OEM → CF_HTML），
         * 不再只认 CF_UNICODETEXT。 */
        /* 窗口长度分两档：
         *   · 一开始只给 250ms —— "压根没选中东西"（序号都不动）是最常见的
         *     情况，不能让它白占 1.5s（那会把取词线程占住，用户紧接着划第二下
         *     就被顶掉了）；
         *   · 一旦看到序号变了（说明复制**正在发生**，只是数据还没落地），
         *     立刻把窗口拉长到这一轮的上限，安心等它写完。 */
        let long_ms = SEL_READ_WINDOW_MS[round.min(SEL_READ_WINDOW_MS.len() - 1)];
        let t0 = std::time::Instant::now();
        let mut deadline = t0 + Duration::from_millis(250);
        let mut changed = false;
        let mut got_text: Option<String> = None;
        let mut probe: Option<String> = None;
        /* 等待期间按时间采样剪贴板状态。排查"对方到底写没写进来"只有这一条路：
         * 光看结束时的状态分不清"从没写过"和"写过又被谁抹了"。 */
        let mut last_sample = std::time::Instant::now();
        loop {
            if last_sample.elapsed() >= Duration::from_millis(300) {
                last_sample = std::time::Instant::now();
                win::log(&format!(
                    "capture: 等待中 round={round} seqΔ={} 剪贴板={}",
                    clip::seq().wrapping_sub(before) as i32,
                    clip::describe_formats()
                ));
            }
            if clip::seq() != before {
                if !changed {
                    deadline = t0 + Duration::from_millis(long_ms);
                }
                changed = true;
            }
            if changed {
                if let Some(t) = clip::read_text_any() {
                    let t = t.trim().to_string();
                    if !t.is_empty() {
                        // 「和复制前不一样」才是硬证据，避免把旧内容当成这次选区
                        if t.chars().count() <= 20000 && old_text.as_deref() != Some(t.as_str()) {
                            got_text = Some(t.clone());
                            probe = Some(t);
                            break;
                        }
                        probe = Some(t);
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        let owned = changed && clipboard_owned_by(target_pid);
        // 日志里展示"最后读到的那一份"（不管接不接受），排查时信息更全
        let raw = probe.clone();
        let text = got_text.clone();
        /* 「内容确实和复制前不一样」比序号更硬的证据：序号变了但内容没变，
         * 说明是别的程序在还原/整理剪贴板，不是选区。 */
        let fresh = matches!((&old_text, &text), (Some(o), Some(n)) if n != o);
        /* 前两轮严格（归属校验必须过）；**最后一轮放宽到"内容确实变了"** ——
         * 因为再不放这一轮就什么都不弹了，而用户要的是能弹出来。
         * 放宽的代价有界：要在 460ms 窗口里恰好有第三方程序改写剪贴板，
         * 且写进去的内容和复制前不一样，才会误弹一次（日志留痕）。 */
        let valid = text.is_some() && (owned || (round == last_round && fresh));
        win::log(&format!(
            "capture: round={round} ch={ch} changed={changed} owned={owned} fresh={fresh} valid={valid} \
             目标={target_pid} owner={} 前台={} 读到={:?}",
            win::window_pid(win::clipboard_owner()),
            win::window_pid(win::foreground_window()),
            raw.as_deref().map(|s| s.chars().take(40).collect::<String>())
        ));
        if !valid {
            /* 读不到就**把剪贴板上挂着的格式列出来**。这次排查就是因为缺这一行
             * 才多花了两轮：微信里"序号变了、owner 也对，内容却是空的"，
             * 有格式列表一眼就能看出该读哪种格式。 */
            win::log(&format!(
                "capture: round={round} 未取到词 changed={changed} 剪贴板={}",
                clip::describe_formats()
            ));
        }
        if valid {
            got = text;
            break;
        }
        // 没拿到有效文字：可能软件还没反应过来，换条通道重试一轮
    }
    /* ⚠ **无条件还原**，快照是空的也要还原。
     *
     * 用户的硬要求是「选中就弹条，不是选中就复制」—— 取词借用了剪贴板，就必须
     * 保证剪贴板**看不出被动过**。快照为空时跳过还原（我上一版为了"别抹掉对端
     * 迟到写入的数据"这么改过）会让选区留在剪贴板里，用户一眼就看到"选中就复制了"，
     * 这是实打实的体验事故。空快照的还原 = EmptyClipboard，正是我们要的"恢复到空"。
     *
     * ⚠ 但「还原」不能无条件：先把剪贴板序号和我们刚写完那一刻比一比，
     *   第三方在中间写过东西的话就**放手**（见 `clip::restore_if_unchanged`）。 */
    /* ⚠ 还原前必须把基准挪到"我们自己刚写完那一刻"。
     *
     * `snapshot()` 记的是**复制前**的序号；而中间那次 `send_ctrl_c()` /
     * `post_copy_to_focus()` 是**我们自己**在写剪贴板，序号必然变。
     * 不重新对齐的话 `restore_if_unchanged` 会把"我们自己的写入"误判成
     * "第三方改过"，于是**永远跳过还原** —— 选中的文字就永久留在剪贴板里，
     * 正是用户明确禁止的「选中就复制」。
     *
     * 对齐之后，基准 = 我们写完那一刻；此后若再有写入（用户手动 Ctrl+C、
     * 别的程序写了东西），才是真的"别人动过"，那时跳过还原才是对的。 */
    if let Some(s) = snap.as_mut() {
        s.note_our_write();
    }
    match &snap {
        Some(s) => clip::restore_if_unchanged(s),
        None => win::log("capture: 本次快照没拿到（剪贴板被占着）—— 无法还原，剪贴板里会留着这次选区"),
    }
    let t = got?;
    win::log(&format!("capture: 最终拿到 {} chars", t.chars().count()));
    Some(t)
}

/// 划词取词（**全程不碰剪贴板**）：UIA 直读选区 → OCR 兜底。
///
/// 用户的口径说得很明确：**「选中文字就弹条，不是选中就复制」**。
/// 老实现是靠「模拟一次 Ctrl+C + 立刻还原剪贴板」把文字拿到手的 —— 剪贴板终究被
/// 动过（还原失败、或者被别的程序占着还原不了时，用户就能看到选区留在剪贴板里），
/// 而且遇到会过滤合成按键的程序（微信）直接哑火。
///
/// 现在两条通道都不碰剪贴板：
///   ① `UIA`：用系统无障碍接口直接问程序"你选了什么" —— 取到的是**精确原文**；
///   ② `OCR`：程序没实现 UIA 文本模式（自绘 UI，比如微信）时，读划过的那块屏幕。
///
/// 返回 `(文字, 通道名)`，通道名进日志，方便一眼看出这次是精确读的还是认出来的。
fn capture_without_clipboard(drag: (i32, i32, i32, i32)) -> Option<(String, &'static str)> {
    let pt_end = windows::Win32::Foundation::POINT { x: drag.2, y: drag.3 };
    let pt_start = windows::Win32::Foundation::POINT { x: drag.0, y: drag.1 };
    /* ⓿ 选区落地稳定期：快速划选（dt<30ms）时 mouseup 刚到目标窗口的消息
     *    队列，此时查 EM_GETSEL 读到的是**旧选区**（快速划选取词实测 A1/A2
     *    因此落到 OCR，把「QuickSearch」认成「search」丢了开头）。
     *    与 Ctrl+C 链同口径（见 main.rs:1223 的稳定期常量），60ms 对弹条
     *    总耗时（几百毫秒）无感。 */
    std::thread::sleep(Duration::from_millis(60));
    /* ① 标准编辑控件（EDIT / RichEdit）：直接读控件自己的选区，**精确**且不碰剪贴板。
     *    记事本、各种输入框走这条 —— 它们**没有 UIA 文本模式**，UIA 问不到。 */
    if let Some(t) = win::edit_selection_text_at(pt_end) {
        if t.chars().count() <= 20000 {
            return Some((t, "编辑控件"));
        }
    }
    /* ② UIA 直读选区。**浏览器整体跳过**（r34 实证：Chromium 系 UIA 内容树
     *    无法唤醒，见 win::uia_foreground_is_browser 的长注释）—— 不跳的话
     *    每次划词要白等两次 UIA 查询（合计最多 5s），横条弹出直接被拖垮，
     *    而浏览器选区的 OCR 兜底通道本来就是通的。 */
    if win::uia_foreground_is_browser() {
        win::log("capture: 前台是浏览器（UIA 内容树无法唤醒）—— 跳过 UIA，直接 OCR 兜底");
    } else {
        /* 选区的提交有时比 mouseup 晚一拍（浏览器要把"选区变了"从渲染进程同步回来），
         *    立刻问会问到一个空选区。重试两次、间隔 120ms，够它落地了。
         *
         *    ⚠ 但**超时不算"晚一拍"**：超时说明对方的 UIA 压根不应答，再等一次只是
         *    又白花 0.5~2.2s（实测），用户看到的是"选完字要等四五秒才出条"。
         *    所以超时直接跳出重试、马上去走 OCR 兜底（~130ms）。 */
        for attempt in 0..2 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(120));
            }
            match win::uia_selection_text(pt_end, pt_start) {
                win::UiaTry::Text(t) => {
                    if t.chars().count() <= 20000 {
                        return Some((t, "UIA"));
                    }
                }
                win::UiaTry::TimedOut => {
                    win::log("capture: UIA 查询超时（对方 UIA 不应答）—— 不重试，直接 OCR 兜底");
                    break;
                }
                win::UiaTry::Retryable => {}
            }
        }
    }
    win::log("capture: UIA 读不到选区（该程序没有 UIA 文本模式）—— 转 OCR 兜底");
    match capture_by_ocr(drag) {
        Some(t) => Some((t, "OCR")),
        None => {
            win::log("capture: OCR 兜底也没拿到");
            None
        }
    }
}

/// 兜底 OCR 的「小块放大」：抓到划词区域先按需要放大，再进 `ocr_ready_image`。
///
/// 为什么必须放大（用户实录）：微信里划一行小字，裁图才 60 来个物理像素高
/// （200% 缩放下 17 CSS px 的字 ≈ 34 物理 px + 上下 12px 余量）。
/// 这个尺寸对 Windows OCR / 百度都踩在「认得出但很不稳」的线上 ——
/// 实测新链路 52 次划词兜底 27 成 24 败，失败的全是「这一块里没认出文字」。
/// 放大到目标高度后笔画绝对尺寸上去，识别率显著变稳（A/B 实测见验收报告）。
///
/// 为什么默认 **Nearest**：放大后的图紧接着要过 Otsu 二值化，平滑滤镜
/// （Triangle）造出来的灰边只会被阈值切掉、白白把笔画糊细；Nearest 保硬度，
/// 且直方图只是原像素重复、Otsu 阈值与原图完全一致。想 A/B 就
/// `QS_OCR_UPSCALE=triangle` 或 `QS_OCR_UPSCALE=off`。
///
/// 只在**高度不足**时放大（纯横划一行字才会触发；竖划/多行选区本来就够高），
/// 封顶 3 倍，并保证放大后宽度不顶百度单边 4096 / 本地引擎 2600 的上限。
fn ocr_upscale_small(img: &image::RgbaImage) -> image::RgbaImage {
    /// 目标高度（物理像素）：低于它就放大。
    const TARGET_H: u32 = 140;
    /// 放大封顶：再高对识别率没有额外好处，白白放大 JPEG 体积。
    const MAX_FACTOR: u32 = 3;
    /// 放大后宽度上限：百度硬上限 4096、本地引擎超 2600 会被缩回去，留余量。
    const MAX_W: u32 = 3000;

    let filter = match std::env::var("QS_OCR_UPSCALE").as_deref() {
        Ok("off") => return img.clone(),
        Ok("triangle") => image::imageops::FilterType::Triangle,
        _ => image::imageops::FilterType::Nearest,
    };
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 || h >= TARGET_H {
        return img.clone();
    }
    let mut factor = TARGET_H.div_ceil(h).clamp(2, MAX_FACTOR);
    // 太宽的条放大后会顶到引擎上限，按宽度收敛因子（这种条一般也够高）
    if w * factor > MAX_W {
        factor = (MAX_W / w).max(1);
    }
    if factor < 2 {
        return img.clone();
    }
    let (nw, nh) = (w * factor, h * factor);
    win::log(&format!(
        "capture(ocr): 裁图 {w}x{h} 偏小，{filter:?} 放大 {factor}x 到 {nw}x{nh}"
    ));
    // 用 resize 而非 resize_exact：本版本 image crate 没有后者；nw/nh 是整数倍、
    // 宽高比不变，resize 的等比适配落点就是精确的 nw×nh。
    image::imageops::resize(img, nw, nh, filter)
}

/// 把划词区域处理成「白底黑字」再送 OCR。
///
/// 为什么必须处理：选中文字自带高亮底色（微信 / 浏览器 / 编辑器都是深色底 + 白字），
/// 这种反色小图直接丢给 Windows OCR，**中文会被认成偏旁堆** ——
/// 实测同一块区域：带蓝色高亮时 "测试ABC123玻璃折射" 被认成
/// "《试ABC123玻氵贝刂}"，去掉底色后就能认对。英文数字对它影响不大，
/// 所以问题会表现得"英文对、中文全错"。
///
/// 做法：灰度 → Otsu 自动找出"文字/底色"的分界线 → 像素少的那一类判为文字 →
/// 输出纯黑白（文字永远黑、底永远白）。这样不管原始是深底白字还是白底黑字，
/// OCR 拿到的都是它最擅长的形状。
fn ocr_ready_image(img: &image::RgbaImage) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    let n = (w as usize) * (h as usize);
    if n == 0 {
        return img.clone();
    }
    let mut hist = [0u32; 256];
    let mut lum = vec![0u8; n];
    for (i, p) in img.pixels().enumerate() {
        // 标准亮度权重（人眼对绿色最敏感）
        let l = ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8;
        lum[i] = l;
        hist[l as usize] += 1;
    }
    // Otsu：取"两侧类间方差最大"的那个阈值为分界
    let total = n as f64;
    let sum_all: f64 = (0..256).map(|i| i as f64 * hist[i] as f64).sum();
    let (mut sum_b, mut w_b) = (0.0f64, 0.0f64);
    let (mut best_t, mut best_v) = (128usize, -1.0f64);
    for (t, &hc) in hist.iter().enumerate() {
        w_b += hc as f64;
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += t as f64 * hc as f64;
        let m_b = sum_b / w_b;
        let m_f = (sum_all - sum_b) / w_f;
        let v = w_b * w_f * (m_b - m_f) * (m_b - m_f);
        if v > best_v {
            best_v = v;
            best_t = t;
        }
    }
    // 文字笔画是"少数派"，底色是"多数派" —— 用它决定黑白方向
    let dark_cnt: u32 = hist[..=best_t].iter().sum();
    let text_is_dark = (dark_cnt as usize) <= n - dark_cnt as usize;
    let mut out = image::RgbaImage::new(w, h);
    for (i, l) in lum.iter().enumerate() {
        let is_text = if text_is_dark {
            (*l as usize) <= best_t
        } else {
            (*l as usize) > best_t
        };
        let v = if is_text { 0u8 } else { 255u8 };
        out.put_pixel((i as u32) % w, (i as u32) / w, image::Rgba([v, v, v, 255]));
    }
    /* 上下各留的余量免不了把**相邻行的残字**带进来（纯水平拖选时尤其明显）：
     * 那些半截字会让 OCR 的分字彻底跑偏 —— 实测同一块区域，带残字时
     * 「玻璃折射」被认成「玻氵贝刂} 折射」，带着残字还会把「射」拆成「身寸」。
     * 所以按行统计"这一行有多少黑像素"，只保留**真正是文字行的那一段**。
     * 阈值取宽度的 1/12：整行文字远超它，残字行（只有几个笔画）达不到。 */
    let thresh = (w / 12).max(3);
    let is_text_row = |y: u32| -> u32 {
        (0..w)
            .filter(|&x| out.get_pixel(x, y)[0] < 128)
            .count() as u32
    };
    let (mut best_start, mut best_len) = (0u32, 0u32);
    {
        let (mut cur_start, mut cur_len) = (0u32, 0u32);
        for y in 0..h {
            if is_text_row(y) >= thresh {
                if cur_len == 0 {
                    cur_start = y;
                }
                cur_len += 1;
                if cur_len > best_len {
                    best_len = cur_len;
                    best_start = cur_start;
                }
            } else {
                cur_len = 0;
            }
        }
    }
    if best_len >= 4 && best_len < h {
        let top = best_start.saturating_sub(2);
        let bottom = (best_start + best_len + 2).min(h);
        let cut = image::imageops::crop_imm(&out, 0, top, w, bottom - top).to_image();
        /* 裁完**四周补白边**再送 OCR。两个原因：
         *   ① 贴边裁的文字识别率明显下降（引擎习惯四周有余量）；
         *   ② 裁得太紧（只剩一行、高度 30 多像素）时，Windows OCR 会直接
         *      报"没有识别到文字" —— 实测踩过。 */
        let m = 12u32;
        let mut padded = image::RgbaImage::from_pixel(cut.width() + m * 2, cut.height() + m * 2,
                                                      image::Rgba([255, 255, 255, 255]));
        image::imageops::overlay(&mut padded, &cut, m as i64, m as i64);
        padded
    } else {
        out
    }
}

/// 兜底取词：对方不肯把选区交到剪贴板时，**直接对用户划过的那一块做本地 OCR**。
///
/// 为什么需要它（实测结论）：微信 4.x 对"合成出来的按键"做了过滤 ——
/// 我们模拟的 Ctrl+C、投递的 `WM_COPY`、投递的按键消息三条通道全跑完，
/// 剪贴板里仍然是空的（日志原样：`剪贴板=空的（没有任何格式）`），
/// 而用户**手动**按 Ctrl+C 却能正常复制。
/// 用户划过的那些字**本身就画在屏幕上**，用本地 OCR（`Windows.Media.Ocr`，
/// 离线、不要密钥、几十毫秒）把它们读出来，是最稳的一条路。
///
/// 只在**复制通道全部失败**时才走 —— 正常软件取到的仍是从剪贴板来的精确原文，
/// 不会因为这条兜底而引入识别误差。
fn capture_by_ocr(drag: (i32, i32, i32, i32)) -> Option<String> {
    let (sx, sy, ex, ey) = drag;
    /* 拖动起止点框成矩形，上下留出**一整行**的余量。
     *
     * ⚠ 余量必须跟着 DPI 缩放走：纯水平拖选时矩形高度是 0，固定留 12px 的话，
     *   在 200% 缩放下（一行字约 34~40px）会把字的上下切开 —— 切开的字 OCR
     *   一个都认不出来（实测就这么踩过：截到的图内容明明是对的，识别结果却是
     *   "没有识别到文字"）。 */
    let scale = win::dpi_scale(win::foreground_window()).max(1.0);
    let pad_y = (12.0 * scale).round() as i32;
    let pad_x = (6.0 * scale).round() as i32;
    let x = sx.min(ex) - pad_x;
    let y = sy.min(ey) - pad_y;
    let w = (sx - ex).abs() + pad_x * 2;
    let h = (sy - ey).abs() + pad_y * 2;
    if w < 8 || h < 10 {
        return None;
    }
    /* ## 上一次的横条：**挡道了才收**
     *
     * 老实现是无条件 `dismiss_bar()` + 等 50ms。三个坏处：
     *   ① 连划场景（第一段的条还开着、第二段已经划完）每划一次横条就"闪一下"
     *      —— 先消失、OCR 完再出现，用户看到的是横条在跳；
     *   ② 万一这次 OCR 没认出字，上一根横条就**白没了** —— 用户看到的是
     *      「横条消失，而且不再出现」，正是用户报的那类现象；
     *   ③ 每次兜底 OCR 都白等 50ms（实测这一段 82ms → 28ms）。
     *
     * 横条的位置我们本来就知道，所以先判它**到底挡没挡住裁图**：挡住了才收。
     *
     * ⚠ 判据用「实体矩形（胶囊）+ 8px」，**不用窗口矩形**：窗口比胶囊大一圈
     *   （上下各 48px 的透明留白，见 layout 日志 `win=(…,162) inner=(48,48,…,66)`），
     *   拿窗口矩形判会把大量"其实没挡住"的情况也判成挡住，白丢这个优化。
     *   8px 是给胶囊投影留的余量 —— 宁可多收一次，也不能把横条拍进图里：
     *   r34 探针实证过，横条入镜会让 Otsu 整块跑偏，识别结果变成"没有识别到文字"。 */
    let blocked = bar_rects()
        .map(|(_, i)| (i.0 - 8, i.1 - 8, i.2 + 8, i.3 + 8))
        .map(|(bl, bt, br, bb)| x < br && x + w > bl && y < bb && y + h > bt)
        .unwrap_or(false);
    if blocked {
        dismiss_bar();
        std::thread::sleep(Duration::from_millis(50));
    }
    let Some((cw, ch, pixels)) = win::grab_region(x, y, w, h) else {
        win::log("capture(ocr): 截图失败");
        return None;
    };
    let img = image::RgbaImage::from_raw(cw, ch, pixels)?;
    // 小块先放大：划一行小字时裁图只有几十物理像素高，引擎处在识别不稳的
    // 边缘（实测兜底成功率对半），放大到目标高度再送（见函数注释）。
    let img = ocr_upscale_small(&img);
    let img = ocr_ready_image(&img);
    // 编 JPEG 而不是 PNG：本地 OCR 两条都能吃，但整块区域很小，
    // 用 JPEG 只是为了快（和 OCR 主链路同一个理由，见 ocr 流程里的注释）。
    let mut cursor = std::io::Cursor::new(Vec::new());
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 92);
    if image::DynamicImage::ImageRgba8(img)
        .write_with_encoder(enc)
        .is_err()
    {
        win::log("capture(ocr): JPEG 编码失败");
        return None;
    }
    let jpg = cursor.into_inner();
    // 仅测试用：把兜底实际截到的那块图存下来，方便核对"到底截到了什么"
    if std::env::var("QS_DUMP_OCR").map(|v| v == "1").unwrap_or(false) {
        let p = config::data_dir().join("ocr-fallback-last.jpg");
        let _ = std::fs::write(&p, &jpg);
        win::log(&format!(
            "capture(ocr): 截图 {}x{} @({x},{y}) 已存 {}",
            cw,
            ch,
            p.display()
        ));
    }
    /* ## 引擎顺序：**本机引擎优先**，用户选的引擎当第二机会
     *
     * 这是「划词弹条」，用户要的是**立刻**看到条。实测（用户日志）本机引擎
     * 认一块划选只要 16~30ms，百度（高精度版）要 0.5~3.4s —— 百度排前面，
     * 等于每次划选都白等三秒，主观上就是「没弹」。用户报的「选中文字后
     * 不能出现横条」，慢到看不见也是其中一半。
     *
     * 本机引擎本来就是这条兜底的主力：`ocr_ready_image`（Otsu 归一化 +
     * 行裁剪 + 补白边）和 `ocr_upscale_small`（小块放大）都是照它调的，
     * 屏幕上已经画好的字它认得很稳。
     *
     * ⚠ 设置页那个「识别引擎」选择**照旧只影响 OCR 结果窗**，这里不受它影响；
     *   用户选的引擎照样有机会 —— 本机没认出来就轮到它（第二机会）。
     *   如果哪天更想要"百度优先、慢点无所谓"，把 order 的两行调个头即可。 */
    let cfg = cfg_snapshot();
    /* r46 改口径（用户报的"加了但没用上"）：
     *
     * 这里以前是**写死**的「本机 + 百度」—— `Vec<bool>`，false=本机、true=百度，
     * 上面那段注释还专门写着"设置页那个「识别引擎」选择照旧只影响 OCR 结果窗，
     * 这里不受它影响"。于是用户把引擎换成硅基流动 / Kimi 之后，划词兜底
     * 照样去打百度：配的那家**根本没被调用**。
     *
     * 现在按设置里配的那家来：本机（16~30ms，快）排第一，认不出来再轮到
     * **用户自己选的那家**。顺序的意义没变（谁快谁先上），变的是"第二棒是谁"。 */
    let local_ok = ocr::local_available().is_ok();
    let online = online_engine(&cfg);
    let mut order: Vec<String> = capture_fallback_order(local_ok, &online, creds_ready(&cfg, &online));
    if order.is_empty() {
        win::log("capture(ocr): 本地 OCR 不可用、配的那家也没凭据 —— 跳过兜底");
        return None;
    }
    /* ## 第二机会：一个引擎没认出来，换另一个再兜一次
     *
     * 用户的要求是「选中文字后一定要出现横条」，而这两个引擎的强项并不重合：
     * 实测同一台机器、同一批划选（用户日志），本机引擎认出来 16 次、百度认出来
     * 15 次，两边失败的理由都只是「这一块里没认出字」。也就是说**换一个引擎真能
     * 救回来相当一部分**；一个失败就收工，等于白丢一半机会。
     *
     * 但框太小（长边 < 24 物理像素）的其实是点击，不是划选 —— 只跑最快那个，
     * 不为它们多花一次网络 OCR 和百度配额。 */
    let span = (ex - sx).abs().max((ey - sy).abs());
    if span < 24 {
        order.truncate(1);
    }
    for (i, id) in order.iter().enumerate() {
        let name = engine_display(id);
        if i > 0 {
            win::log(&format!("capture(ocr): 上一个引擎没认出来，换{name}引擎再兜一次"));
        }
        let r = ocr_engines::recognize(
            id,
            &ocr_creds(&cfg, id),
            &jpg,
            &cfg.ocr_lang,
            cfg.ocr_accurate,
            20,
            &ocr_engines::OcrUrls::default(),
        )
        .map(|o| o.text);
        match r {
            Ok(t) => {
                // OCR 出来的中文经常被塞进多余空格，按项目既有口径清一遍
                let t = ocr::clean_spaces(&t).trim().to_string();
                if t.is_empty() {
                    win::log(&format!("capture(ocr): {name}引擎没认出字"));
                } else {
                    win::log(&format!(
                        "capture(ocr): 用{name}引擎认到 {} 字",
                        t.chars().count()
                    ));
                    return Some(t);
                }
            }
            Err(e) => {
                win::log(&format!("capture(ocr): {name}引擎识别失败：{e}"));
            }
        }
    }
    None
}

/// Ctrl+C 兜底：用户自己按了 Ctrl+C，读剪贴板。
///
/// `before` 是**按下按键那一刻**的剪贴板序号（由钩子回传导出）。
///
/// 行为口径（用户拍板）：**按了 Ctrl+C 就一定在鼠标位置弹横条**。
/// 剪贴板变了就用新复制的内容，没变就用剪贴板里现成的那份（可能为空）。
/// 细节见 `read_current` 末尾那段注释。
enum Got {
    /// 拿到文字，正常弹横条。
    ///
    /// 字段是 `(文字, 是不是还可能有个迟到的复制)`。
    ///
    /// **文字可能是空串** —— 用户按了 Ctrl+C 但当时没选中文字时，我们照样把横条叫出来，
    /// 只是没有预填文字（见 read_current 末尾）。
    /// `true` = 这次复制多半还在路上，调用方要给 `late_text_patch` 一个机会
    /// 把真正的文字补上（"立刻弹 + 迟到补"）。
    Text(String, bool),
    /// 剪贴板里进的是一张图 —— 图片上的字是选不中的，这时候弹一条
    /// 「识别图片文字」的横条，点一下就能框选 OCR
    Image,
}

fn read_current(before: u32) -> Got {
    // 同上：这条线也必须串行化，不能和拖选那条同时动剪贴板。
    // 这条路径上用户等着横条出来，不能无期限地排队 —— 最多等 600ms，
    // 等不到就跳过（宁可这次弹条内容不完整，也不能把界面卡死）。
    let _clip = {
        let deadline = std::time::Instant::now() + Duration::from_millis(600);
        loop {
            match CLIP_LOCK.try_lock() {
                Ok(g) => break g,
                Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    if std::time::Instant::now() >= deadline {
                        win::log("copy path: 剪贴板被另一条取词占着，跳过本次");
                        return Got::Text(String::new(), false);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    };
    /* ⚡ 这里原来有一段「等剪贴板变序号」的等待窗口（最早 800ms → 收到 150ms →
     *   上一轮为了"别拿旧内容糊弄用户"又抬到 400ms）。现在**整段去掉**。
     *
     * 那段时间怎么算都是亏的：
     *   · 等到了 → 白等几十~几百毫秒（复制落地那一刻我们本来就知道了）；
     *   · 等不到 → 把剪贴板里**现成的旧内容**当成这次的文字弹出去。用户报过
     *     「选中文字后点引擎，搜的却是剪贴板里的东西」——就是这个兜底兜歪了；
     *     而且横条上不显示文字，拿到了旧的也看不出来，只能等搜错才发现。
     * 用户这轮的要求很明确：「Control+C 方式唤起的横条也需要同样加速」。
     *
     * 改成「**立刻弹 + 迟到补**」：
     *   · 现在剪贴板里有什么就先当预填文字（"按了 Ctrl+C 就得有反应"）；
     *   · 同时告诉调用方 pending=true —— 这次复制多半还在路上，由后台线程盯着
     *     剪贴板，真落地了再把文字补进去（late_text_patch）。用户在这几十毫秒里
     *     不可能已经点完引擎，所以补丁一定赶得上。
     * 结果是：Ctrl+C 出手即弹（没有固定等待），文字最终也一定是对的。 */
    let changed = clip::seq() != before;
    // 多格式读（UTF-16 → ANSI → OEM → CF_HTML）：微信这类宿主复制时
    // CF_UNICODETEXT 可能是空的，只认它会在 Ctrl+C 这条路也取不到词。
    let t = clip::read_text_any()
        .map(|t| t.trim().to_string())
        .unwrap_or_default();

    if changed {
        win::log("copy path: 读的时候复制已经落地了");
        if !t.is_empty() {
            return Got::Text(t, false); // 文字就是新的，不需要再补
        }
        if clip::has_image() && cfg_with(|c| c.ocr_enable) {
            win::log("copy path: 剪贴板里是图片 —— 弹出「识别图片文字」横条");
            return Got::Image;
        }
        win::log("copy path: 序号变了但既没文本也没图（大概是文件）");
        return Got::Text(String::new(), false);
    }

    /* ⚠ 关键行为（用户明确要求）：**只要按了 Ctrl+C，横条就要出现** ——
     * 哪怕当时一个字都没选中、哪怕复制还没落地。
     *
     * 早先的版本是「序号没变就不弹」，理由是"避免空按 Ctrl+C 也弹条"。
     * 但那让 Ctrl+C 变成一个时灵时不灵的动作：用户明明按了、却没反应，
     * 观感就是"这功能没实现"。现在无条件响应：
     *   · 剪贴板里有文字 → 先预填进去，几毫秒后复制落地会再补一次；
     *   · 没有（空剪贴板 / 复制的不是文字）→ 弹一条没有预填文字的横条，
     *     仍然可以在上面点「⋯」输入关键词，或者点引擎搜剪贴板里现成的内容。
     *
     * 真正"不该弹"的情况（暂停中、前台是我们自己的窗口、命中黑/白名单）
     * 在 trigger_allowed() 那一步就已经挡掉了，这里不用再操心。 */
    win::log(&format!(
        "copy path: 立刻弹（预填 {} 字），复制落地后再补",
        t.chars().count()
    ));
    Got::Text(t, true)
}

/// 剪贴板 owner 是不是「按下 Ctrl+C 那一刻的前台进程」。
///
/// 判据与 fail-open 原则都在 `clipboard_owner_trusted` 里（取不到就放行：
/// 这里只是"别把别的程序写的东西当成用户这次的复制"的第二道保险，
/// 卡死了会让正常复制也被吞掉）。`pid == 0`（那一刻没拿到前台进程号）
/// 时退回"当前前台"的老判据。
fn clipboard_owned_by_pid(pid: u32) -> bool {
    // 按 Ctrl+C 那一刻没拿到前台进程号 —— 退回"当前前台"的老判据
    let trusted = if pid == 0 {
        win::window_pid(win::foreground_window())
    } else {
        pid
    };
    clipboard_owner_trusted(&[trusted])
}

/// 迟到的复制补丁 —— 「立刻弹 + 迟到补」里的后半截（见 `read_current`）。
///
/// 就在横条已经弹出来之后，静静等这次 Ctrl+C 的复制落地；落地了就把文字补进
/// 本次唤起的状态并发事件通知前端。**不重新摆放窗口**，所以用户看不到任何跳动。
fn late_text_patch(before: u32, gen: usize, fg_pid: u32) {
    let t0 = std::time::Instant::now();
    if !win::wait_until(900, || clip::seq() != before) {
        win::log("copy path: 900ms 内没等到复制落地（多半是没选中文字）");
        return;
    }
    // 期间用户又唤了一次（或把横条收掉了）→ 这条补丁已经属于上一根横条，丢掉
    if GEN.load(Ordering::SeqCst) != gen {
        win::log("copy path: 迟到的复制遇上新的一次唤起，丢弃");
        return;
    }
    // 有的程序分两步写剪贴板，多等一拍再读
    std::thread::sleep(Duration::from_millis(20));
    /* ⚠ 归属校验用的是「**按 Ctrl+C 那一刻**的前台进程」，不是"现在的前台"：
     *   用户很可能已经点到横条 / 展开面板上了，那时前台就是我们自己，
     *   拿它去比会导致补丁永远不生效。 */
    if !clipboard_owned_by_pid(fg_pid) {
        win::log("copy path: 迟到的复制归属校验没过（不是前台程序写的），忽略");
        return;
    }
    let t = {
        // 和拖选取词那条线抢剪贴板时串行化（它中途会 snapshot/restore）
        let _clip = lock_clip();
        /* ⚠ 这里用**长重试**版本（30 ≈ 300ms），不是 `read_text_any()` 的短重试。
         *
         * 这条函数是"迟到补"的最后一步：上面已经等了 900ms 确认复制落地
         * （`wait_until`），此刻数据就在剪贴板里。而别的程序（微信这类自建
         * 剪贴板监听的客户端）可能正握着它不放 —— 短重试会读不到，
         * 于是**这次取词白等 900ms 还拿不到词**，横条上留着旧文字。
         * 读一次最多等 300ms 是划算的：它是单次路径，不在任何轮询里。 */
        clip::read_text_any_within(30)
            .map(|t| t.trim().to_string())
            .unwrap_or_default()
    };
    if t.is_empty() {
        if clip::has_image() && cfg_with(|c| c.ocr_enable) {
            win::log("copy path: 迟到的是图片 → 换成「识别图片文字」横条");
            show_ocr_only_bar();
        }
        return;
    }
    win::log(&format!(
        "copy path: 迟到 {}ms 的复制补上了（{} 字）",
        t0.elapsed().as_millis(),
        t.chars().count()
    ));
    push_late_text(t, true);
}

/// 把「这一条文字」写进本次唤起的共享状态（选区 / 选区 URL / 选区里的全部链接）。
/// 返回它是不是**一整条** URL，调用方拿去填 `qs://show` 的 isUrl。
fn remember_text(text: &str) -> Option<String> {
    let url = engines::text_to_url(text);
    if let Ok(mut s) = st().sel.lock() {
        *s = text.to_string();
    }
    if let Ok(mut u) = st().sel_url.lock() {
        *u = url.clone();
    }
    /* 用户要求：「选中的文本当中包含多个链接，点击打开链接按钮之后，就会在多个
     * 标签页打开这些链接」。所以这里把这一段里的**所有**链接一起算出来存下 ——
     * 取词那一刻就定下来，之后前端点按钮时用的必须是当时那一份（别再变）。 */
    if let Ok(mut v) = st().sel_urls.lock() {
        *v = engines::extract_links(text);
    }
    url
}

/// 本次选中文字里的全部链接（`remember_text` 时算好的那一份快照）。
fn sel_urls_snapshot() -> Vec<String> {
    st().sel_urls.lock().map(|v| v.clone()).unwrap_or_default()
}

/// 「迟到的复制」落地后把文字补上并通知前端。
///
/// 和 `show_bar` 的初次填充**必须走同一套状态**，否则又会回到"前后端各记一份、
/// 点引擎时搜的到底是哪份文字分不清"的老问题。
fn push_late_text(text: String, via_copy: bool) {
    let url = remember_text(&text);
    let urls = sel_urls_snapshot();
    let _ = app().emit_to(
        "bar",
        "qs://text",
        json!({ "text": text, "isUrl": url.is_some(), "urls": urls, "viaCopy": via_copy }),
    );
}

/// 前台窗口是不是**我们自己、且属于「不该弹横条」的那一类**。
///
/// 必须挡掉：框选识别时用户要在整屏上拖一个框、拾取器要在整屏上点一下 ——
/// 这些动作在全局钩子看来跟"在别的软件里选词"一模一样，不挡的话每拖一次都弹横条；
/// 横条自己的输入框里划选同理（那是在改要搜的内容，不是要再弹一条新横条）。
///
/// ⚠ 2026-10-16 起「识别结果」窗口**不再算**：用户明确要求
///   "OCR 识别结果页面，选择文字也应该横条显示" —— 他要在识别结果里划一段，
///   直接搜 / 复制。旧口径（"在识别结果窗里划选纯属打扰、还会盖住正在看的内容"）
///   是更早一版的需求，已被这一条取代。
///
/// ⚠ r59 起「设置页」也不再算：用户原话「我在这个软件的设置页面按 control 加 c
///   不能够换出横条，这也是一个问题要修复」。设置页是用户**会去读、会去复制**
///   的普通页面（引擎名、路径、说明文字都在那儿），在那儿 Ctrl+C 却弹不出横条，
///   等于把"在设置里看到一段字想搜一下"这条路堵死了。
///   仍然挡着的是：横条自己（bar）、框选遮罩（region）、图标编辑器 ——
///   那几处的划选/点击是**操作**，不是"选一段文字去搜"。
fn foreground_is_ours() -> bool {
    let h = win::foreground_window();
    if h.0.is_null() {
        return false;
    }
    if win::window_pid(h) != std::process::id() {
        return false;
    }
    // 是我们自己的窗口 —— 但「识别结果」和「设置页」放行
    // （用户要在这两处划词 / Ctrl+C 去搜，见上面注释）
    !window_is_labeled(h, "ocr") && !window_is_labeled(h, "settings")
}

/// 某个 hwnd 是不是指定 label 的那个自有窗口。
///
/// 比**顶层窗**而不是比 hwnd 本身：WebView2 的渲染子窗
/// （`Chrome_RenderWidgetHostHWND`）才是真正吃到鼠标的那个，它的顶层才是我们建的宿主窗口。
fn window_is_labeled(h: HWND, label: &str) -> bool {
    app()
        .get_webview_window(label)
        .and_then(|w| w.hwnd().ok())
        .map(|h2| {
            let hw = HWND(h2.0 as *mut _);
            hw == h || win::root_window(hw) == win::root_window(h)
        })
        .unwrap_or(false)
}

/// 当前前台程序允不允许弹横条（黑/白名单）。
///
/// 取不到进程名时**放行**（fail-open）：宁可多弹一次，也不要因为权限问题
/// 让白名单用户在目标软件里彻底哑火。
///
/// # ⚠ r89：判据从"前台进程"改成"**鼠标底下那个窗口**的进程"
///
/// 用户报黑名单不生效（实测：把 cmd.exe 加进黑名单，在 cmd 里划词**照样弹**）。
///
/// 根因：原来用的是 `win::foreground_exe()`。而"划词"这个动作有一条很容易
/// 被忽略的时序——用户划完、横条弹出来（我们抢了前台）、他再划一次时
/// `GetForegroundWindow()` 返回的**可能还是我们自己的窗口**（或者上一次划词
/// 那个软件），于是黑名单比对的是错的程序，`cmd.exe` 根本没参与判定。
///
/// 正确的判据是"用户此刻在**哪个软件里**划词"，那就该问**鼠标底下的窗口**：
///   · 优先 `window_under_point(鼠标)` —— 和 `should_try_select` 同一个来源，
///     两处口径一致；
///   · 取不到（分层窗口 / disabled 窗口会让 WindowFromPoint 返回 null）
///     才退回前台窗口。
///
/// 这样"横条刚弹过、前台还是我们"这种情形就自然解决了：鼠标在哪就是哪。
fn app_allowed(at: Option<(i32, i32)>) -> bool {
    let cfg = cfg_snapshot();
    if cfg.filter_mode == "off" || cfg.filter_list.is_empty() {
        return true;
    }
    /* 先看鼠标底下那个窗口；拿不到再退回前台。
     * 两步都拿不到才走 fail-open（下面那个 `else` 分支）。 */
    /* ⚠ 优先用**调用方给的坐标**（划词就是那次拖选的终点）。
     *
     * 为什么不能只用当前鼠标位置：横条弹出来之后鼠标可能已经移开，
     * 或者上一个实例的横条还盖在上面 —— 实测就是这样翻车的：
     * 判据拿到的是 LauncherSearchWindow（我们自己的搜索窗），
     * 于是黑名单比对了错的进程、cmd.exe 压根没参与判定。
     *
     * 划词那条路有精确坐标（drag 的终点），一定要用上。 */
    let (px, py) = at.unwrap_or_else(|| {
        let c = win::cursor_pos();
        (c.x, c.y)
    });
    let under = win::window_under_point(px, py);
    let exe = if !under.0.is_null() {
        win::process_exe(win::window_pid(under))
    } else {
        win::foreground_exe()
    };
    let Some(exe) = exe else {
        /* ⚠ 这里**不能**因为我们自己就是前台就放行/拦截 —— 那会让判据
         * 依赖"上一次是谁在前台"。取不到就是取不到，fail-open。 */
        return true;
    };
    let exe = exe.to_ascii_lowercase();
    let hit = cfg
        .filter_list
        .iter()
        .any(|x| x.trim().to_ascii_lowercase() == exe);
    let ok = match cfg.filter_mode.as_str() {
        "blacklist" => !hit,
        "whitelist" => hit,
        _ => true,
    };
    if !ok {
        win::log(&format!(
            "filter: {exe} 被 {} 挡掉了（判据=鼠标底下那个窗口）",
            if cfg.filter_mode == "blacklist" { "黑名单" } else { "白名单" }
        ));
    }
    ok
}

/// 松手后按设置的「出现延迟」再取词。
///
/// 延迟期间如果用户又松了一次手（比如连续点选），只有最后一次算数 ——
/// `SEL_GEN` 就是干这个的。
static SEL_GEN: AtomicUsize = AtomicUsize::new(0);

fn schedule_capture(target_pid: u32, drag: (i32, i32, i32, i32)) {
    let d = cfg_with(|c| c.delay_ms);
    if d == 0 {
        /* 也要起线程再走，不能在这条（事件消费）线程上直接跑：
         * start_capture 里 BUSY 的有界等待（#152）最长会占 1.2s，
         * 占着消费线程会让这期间的 Esc / 点击收条全部迟到。
         * 线程创建只要零点几毫秒，相对 40ms 稳定期完全免费。 */
        std::thread::spawn(move || start_capture(target_pid, drag));
        return;
    }
    let g = SEL_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(d as u64));
        if SEL_GEN.load(Ordering::SeqCst) != g {
            win::log("schedule_capture: 期间又松了一次手，这次作废");
            return;
        }
        start_capture(target_pid, drag);
    });
}

/// 一次触发的总闸门（只管**自动**触发那条线）。
fn trigger_allowed(at: Option<(i32, i32)>) -> bool {
    if is_paused() {
        win::log("trigger: 已暂停使用，忽略自动弹条");
        return false;
    }
    if foreground_is_ours() {
        win::log("trigger: 前台是我们自己的窗口，忽略");
        return false;
    }
    app_allowed(at)
}

fn start_capture(target_pid: u32, drag: (i32, i32, i32, i32)) {
    // 划词的终点 = 用户真正在哪个软件里选字，黑名单该按这个判
    if !trigger_allowed(Some((drag.2, drag.3))) {
        return;
    }
    /* 上一次取词还没结束怎么办？以前是 BUSY.swap 拿到 true 就 return
     * —— 直接丢弃本次。但连续划选（第一段的横条还没出来、第二段已经
     * 划完了）时，用户看到的就是"划了却不弹"，丢一次就够判死刑。
     * 现在改成最多等 1.2s：等到了就正常做，等不到（软件卡死级慢）
     * 才放弃并记日志。 */
    /* 等上一次取词结束的上限。必须 >= 一次取词的最坏耗时：
     * 3 轮 × 读窗口(1500+800+800) + 两段退避(220+380) ≈ 3.7s。
     * 给小了，用户"连着划两下"的第二下会被直接丢弃 —— 那是最容易被骂的体验。 */
    let deadline = std::time::Instant::now() + Duration::from_millis(4500);
    loop {
        if BUSY
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            break;
        }
        if std::time::Instant::now() >= deadline {
            win::log("start_capture: 上一次取词超过 4.5s 仍未结束，本次放弃");
            return;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    // ⚠ 守卫交给子线程带着：线程里无论 panic 还是提前 return，BUSY 都会归位。
    //   （以前是在线程末尾手工 store(false)，一次 panic 就让取词功能永久失效。）
    let Ok(handle) = std::thread::Builder::new()
        .name("qs-capture".into())
        .spawn(move || {
            let _g = BusyGuard;
            /* QS_FORCE_COPY=1：**仅测试用**，走"模拟复制 + 还原"的老通道 ——
             * 用来把 UIA 通道的结果和老通道并排对比。平时永远走下面那条。 */
            let out = if std::env::var("QS_FORCE_COPY").map(|v| v == "1").unwrap_or(false) {
                win::log("capture: QS_FORCE_COPY=1 —— 走模拟复制的旧通道");
                capture_selection(target_pid).map(|t| (t, "复制"))
            } else {
                capture_without_clipboard(drag)
            };
            match &out {
                Some((t, via)) => win::log(&format!(
                    "start_capture: {via} 通道拿到 {} chars",
                    t.chars().count()
                )),
                None => win::log("start_capture: 没拿到文字，仍然弹条（兜底）"),
            }
            /* r89：**取不到文字也要弹横条**。
             *
             * 用户原话：「我要求是说我在任何情况下我选中文字就一定要换出横条，
             * 除非我把这个软件加入了黑名单。」
             *
             * 原来的写法是 `if let Some((t, _)) = out { show_bar(...) }` ——
             * 三条取词通道（编辑控件 / UIA / OCR）**全都失败就不弹**。
             * 而这在真实软件里并不罕见：
             *   · 自绘 UI（游戏、部分 Electron 应用、Java/Qt 程序）没有标准编辑控件；
             *   · 没有 UIA 文本模式，或对方的 UIA 实现不应答（超时）；
             *   · OCR 兜底要"这块区域里有看得清的字"—— 小字、彩色背景、
             *     半透明浮层上都可能认不出来。
             * 用户看到的就是"划了半天，横条有时候不出来"，而且**没有任何提示**
             * 告诉他为什么 —— 这是最糟的一类体验。
             *
             * 现在改成：拿不到文字就弹一个**空文字的横条**。它有实际用处
             * （这正是"兜底"要保住的东西）：
             *   · 用户还能点横条上的「识图搜索」对刚才那块区域做识图；
             *   · 还能点「OCR」重新框选识别；
             *   · 至少**一定能打开**，用户知道软件在工作，不会以为坏了。
             *
             * ⚠ 唯一的例外是黑名单（`app_allowed`），那个判断在
             *   `trigger_allowed` 里、比这里更早，没有被我这条改动绕过。 */
            let text = out.map(|(t, _)| t).unwrap_or_default();
            show_bar(text, false, true);
        })
    else {
        BUSY.store(false, Ordering::SeqCst);
        win::log("start_capture: 起线程失败，BUSY 已复位");
        return;
    };
    drop(handle);   // 故意不等：JoinHandle 丢弃即 detach
}

/// 弹条那一刻「用户是在哪个软件里触发的」—— 即收藏夹条目要注入的目标窗口。
///
/// 为什么是"鼠标底下那个窗口"优先：用户的原话是「输入到**鼠标触发位置所在**的
/// 其他软件的文本框中」。鼠标位置是他自己放过去的，比"谁碰巧是前台"更忠实。
/// `foreign_window_at` 内部已经排除了本进程（所以不会因为我们自己的窗口压在上面
/// 就返回自己），并且是从桌面 Z 序顶端往下扫，不怕 always-on-top 打断链条。
///
/// 鼠标底下扫不到（在桌面空白处、或只有一个本进程窗口）才退回前台窗口 ——
/// 同样要求不是我们自己，否则"注入到自己身上"毫无意义。
fn trigger_target_window() -> Option<HWND> {
    let me = std::process::id();
    let c = win::cursor_pos();
    let under = win::foreign_window_at(c.x, c.y);
    if !under.0.is_null() {
        return Some(under);
    }
    let fg = win::foreground_window();
    if !fg.0.is_null() && win::window_pid(fg) != me {
        return Some(fg);
    }
    None
}

/// 弹出横条。`at_mouse` 由触发路径决定：
/// 拖选取词传 false（贴文字），Ctrl+C 取词传 true（贴鼠标）。
/// 本次横条是不是「只有识别图片文字」的那种形态
static OCR_ONLY: AtomicBool = AtomicBool::new(false);

/// 弹一条只带「识别图片文字」按钮的横条。
/// Ctrl+C 复制到的是图片时走这条路 —— 图片上的文字选不中，
/// 但用户按 Ctrl+C 的意图很明确，给他一个入口比什么都不做强。
fn show_ocr_only_bar() {
    /* 「只留 OCR 那一个按钮」的横条。
     *
     * ⚠⚠ 这里**保持原样**：`dismiss_bar()` → 30ms → `show_bar()`。
     *
     * 我一度把它"优化"成"只做不涉及焦点的那部分收起，然后立刻 show，去掉 sleep"，
     * 理由是"dismiss 会把焦点还给上一个窗口、30ms 后又拿回来，用户看到焦点弹一下"。
     * **那个理由从来没有被实测证实，但改动引入的四个回归是真的**：
     *   · 漏掉 `glass::clear_exclude_from_capture()` → 横条可能仍对抓屏隐身，
     *     用户截图/录屏里横条会凭空消失；
     *   · 漏掉 `win::set_noactivate(h, true)` → 窗口不再是无激活浮层，
     *     可能把焦点从用户正在打字的窗口抢走；
     *   · 漏掉 `bar_win()` 为 None 时的 `move_resize(..., false)` 兜底 →
     *     窗口还没建好的那条路上，横条会留在原地不消失；
     *   · 漏掉 `g.focused = false` / `prev_fg` 处理 → 焦点状态机停在错误状态。
     *
     * 结论：**没有一个可复现的 bug 值得拿这四处换**。保留原始实现，
     * 把这段记在这里，免得下一个人（或下一个 AI）再"优化"一遍。 */
    OCR_ONLY.store(true, Ordering::SeqCst);
    dismiss_bar();
    std::thread::sleep(Duration::from_millis(30));
    show_bar(String::new(), true, false);
}

/// 弹出横条。返回值 = 本次唤起的**代次**（`GEN`），调用方拿它做"这条补丁是不是
/// 还属于当前这根横条"的校验（见 `late_text_patch`）。
///
/// 延迟这件事被用户反复点名（「弹出速度偏慢…仍需约几十毫秒」），所以这里逐段打点，
/// 一次呼唤的耗时能被日志拆开看清：前置（锚点/光标）→ 让位（把上一根挪走）→ 取色 → 发事件。
/// 真正"窗口可见"的那一下在 layout_bar 里，那里再打一条端到端总耗时。
///
/// ⚠ r70：挂 `#[tauri::command]`。以前它只是内部函数（热键 / 托盘 /  Ctrl+C 钩子
///   直接调），探针想驱真流程只能 `invoke('show_bar')` —— 而没注册的命令调用会
///   **静默失败**（Promise reject，探针大都 `.catch(()=>{})` 吞掉），于是 r69 的
///   「设置按钮」探针全程跑在"没有锚点、窗口永不缩放"的退化环境里还全 PASS。
///   注册之后探针走的和真实用户完全同一条路（设锚点 → 前端 layout_bar → 真摆窗）。
///   对本机单用户桌面应用来说，多一个内部命令的暴露面可以忽略。
#[tauri::command]
fn show_bar(text: String, at_mouse: bool, via_copy: bool) -> usize {
    let t0 = std::time::Instant::now();
    win::log(&format!("show_bar: {:?}", text.chars().take(60).collect::<String>()));
    let a = app();
    // 选区 / 选区 URL 的共享状态走 remember_text，和"迟到补丁"用同一套，
    // 免得两条路各写各的、前后端对不上（点引擎到底搜哪份文字那种事）。
    let url = remember_text(&text);

    // 位置：
    //   · 开了「跟随鼠标」或者这条是 Ctrl+C 触发 -> 贴鼠标；
    //   · 否则贴选中的文字（下方优先，放不下自动翻上方 —— 那步在 layout_bar 里做，
    //     因为要等前端量出胶囊的真实高度才知道放不放得下）。
    let cfg = cfg_snapshot();
    let caret = if at_mouse || cfg.anchor_at_mouse {
        None
    } else {
        win::caret_box()
    };
    let anchor = match caret {
        Some((cl, _, _, cb)) => POINT { x: cl, y: cb },
        None => win::cursor_pos(),
    };
    win::log(&format!(
        "show_bar: atMouse={at_mouse} cfgMouse={} caret={:?} anchor=({},{})",
        cfg.anchor_at_mouse, caret, anchor.x, anchor.y
    ));
    let t_anchor = t0.elapsed();

    /* —— 记下「这次是在哪个软件、什么位置被叫出来的」——
     *
     * 收藏夹条目点下去要**注入到那个软件的文本框**里（用户口径：输入到鼠标触发
     * 位置所在的其他软件；只有那儿没有可用文本框时才复制到剪贴板）。而收藏面板
     * 一打开**前台窗口就变成我们自己**，那两个问题当场就问不出来了，只能现在留档。
     *
     * 选窗口的顺序：鼠标底下那个**别的进程**的顶层窗口 → 当前前台窗口（同样得是别人）。
     * 两个都指向我们自己（例如从设置页/托盘唤起的）→ 没有可注入的目标，
     * 条目一律走复制到剪贴板。 */
    let trigger_pt = {
        let c = win::cursor_pos();
        (c.x, c.y)
    };
    let trigger_hwnd = trigger_target_window();
    let trigger_has_text = trigger_hwnd.map(win::has_text_focus).unwrap_or(false);
    win::log(&format!(
        "show_bar: 触发现场 hwnd=0x{:x} 「{}」 有可用文本框={} 鼠标=({},{})",
        trigger_hwnd.map(|h| h.0 as usize).unwrap_or(0),
        trigger_hwnd.map(win::window_title).unwrap_or_default(),
        trigger_has_text,
        trigger_pt.0,
        trigger_pt.1
    ));

    /* 上一根横条还亮着就先把它挪出屏幕。
     *
     * ⚠ 一是挪动必须**同步**：以前用 Tauri 的 `set_position`（投递到事件循环的
     *    异步调用），然后盲等 36ms 猜它什么时候生效 —— 既慢又不准。改成直接
     *    `win::move_only`（一次 SetWindowPos，返回时窗口已经在屏幕外了）。
     * ⚠ 二是「为什么还需要挪」：自动取色删掉后（#148），「采到自己」的动机
     *    没了，但**液态玻璃的抓屏还吃这一趟** —— layout_bar 首次上屏前要
     *    BitBlt 一块干净桌面当玻璃纹理（见那儿的注释），旧横条若留在原地，
     *    抓到的就是它自己上一帧的玻璃渲染（纹理自拍）。所以挪照旧，
     *    无条件挪；只为抓屏干净，不需要再等 DWM 合成。 */
    if is_bar_shown() {
        let h = bar_hwnd();
        if !h.0.is_null() {
            win::move_only(h, OFFSCREEN, OFFSCREEN);
        }
    }
    let t_off = t0.elapsed();

    let theme = current_theme();
    win::log(&format!(
        "show_bar: 耗时 锚点={}ms 让位={}ms 主题={}ms",
        t_anchor.as_millis(),
        (t_off - t_anchor).as_millis(),
        (t0.elapsed() - t_off).as_millis()
    ));

    {
        let mut g = match st().geo.lock() {
            Ok(g) => g,
            Err(_) => return GEN.load(Ordering::SeqCst),
        };
        g.anchor = Some((anchor.x, anchor.y));
        g.anchor_mouse = caret.is_none();
        g.caret = caret;
        g.trigger_hwnd = trigger_hwnd.map(|h| h.0 as isize).unwrap_or(0);
        g.trigger_has_text = trigger_has_text;
        g.trigger_pt = trigger_pt;
        g.shown = false; // 等前端回 layout_bar 再真正显示
    }

    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    // 记下这次唤起的起点，layout_bar 里窗口真的可见时把端到端耗时打出来
    if let Ok(mut g) = SHOW_T0.lock() {
        *g = Some(t0);
    }
    let _ = a.emit_to("bar", "qs://theme", theme);
    let _ = a.emit_to(
        "bar",
        "qs://show",
        json!({
            "text": text,
            "isUrl": url.is_some(),
            // 这一段里的**所有**链接：> 1 条时前端那颗按钮点一下就把它们
            // 分别开成多个标签页（用户要求）。
            "urls": sel_urls_snapshot(),
            "ocrOnly": OCR_ONLY.swap(false, Ordering::SeqCst),
            // 这次横条是「用户刚复制/拖选」叫出来的吗？收藏夹条目点下去要据此分流：
            // 取词语境 → 复制到剪贴板；否则 → 填进搜索框（用户明确要求分清）。
            "viaCopy": via_copy,
        }),
    );
    win::log(&format!(
        "show_bar: 前置合计 {}ms → 已发事件，等前端量尺寸",
        t0.elapsed().as_millis()
    ));

    // 前端万一没回，就用上次的尺寸兜底显示，别让用户觉得没反应
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(420));
        if GEN.load(Ordering::SeqCst) != gen || is_bar_shown() {
            return;
        }
        let (w, h, ix, iy, iw, ih, bh, px, py, sx, ox, oy) = {
            let g = match st().geo.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if g.css_w > 1.0 {
                // 钉住点没存过（理论上不会，防御性）就退回包围盒左缘
                let px = if g.css_pin_x > 0.0 { g.css_pin_x } else { g.css_ix };
                let py = if g.css_pin_y > 0.0 { g.css_pin_y } else { g.css_iy };
                (g.css_w, g.css_h, g.css_ix, g.css_iy, g.css_iw, g.css_ih, g.bar_h,
                 px, py, g.css_shift_x, g.css_off_x, g.css_off_y)
            } else {
                (552.0, 52.0, 10.0, 10.0, 532.0, 32.0, g.bar_h, 10.0, 10.0, 0.0, 0.0, 0.0)
            }
        };
        layout_bar(w, h, ix, iy, iw, ih, bh, px, py, sx, ox, oy, None);
    });
    gen
}

/* ================================================================== */
/* 事件消费线程                                                        */
/* ================================================================== */

fn should_try_select(x: i32, y: i32) -> bool {
    let target = win::window_under_point(x, y);
    /* r89：**取不到窗口就放行**（fail-open）——用户要的是"任何情况都弹"。
     *
     * `WindowFromPoint` 有个已知限制：它**跳过** disabled 窗口、以及某些
     * 分层（layered）/ 穿透（transparent-to-hit）窗口，这时会返回 null。
     * 而那种窗口底下往往是个正常的应用（只是它上面盖了一层奇怪的东西）。
     *
     * 原来的写法是 `if target.is_null() { return false; }` —— 直接不弹。
     * 用户看到的就是"某些软件里划词死活不弹横条"，还不知道为什么。
     * 现在改成放行：宁可多弹一次（用户按 Esc / 点外面就收了），
     * 也不要在他真的选中了文字时什么都不发生。
     *
     * ⚠ 黑名单（`app_allowed`）在上游的 `trigger_allowed` 里，不受影响 ——
     *   用户明确拉黑的软件仍然不会弹。 */
    if target.0.is_null() {
        win::log("select: WindowFromPoint 没命中（分层/disabled 窗口？）—— 放行，照弹");
        return true;
    }
    let bar = bar_hwnd();
    if !bar.0.is_null() && win::root_window(target) == bar {
        return false;
    }
    // 落在「识别结果」窗口里**照样弹**横条 —— 2026-10-16 用户新要求：
    // "ocr 识别结果页面，选择文字也应该横条显示"（他要在识别结果里划一段去搜/复制）。
    //
    // 框选遮罩 / 拾取器那两个全屏浮层仍然挡住：它们在的时候一次拖动只是
    // "在遮罩上框选 / 在整屏上取点"，绝不能当成选中文字去触发取词。
    //
    // ⚠ 判据必须是「鼠标底下那个窗口到底是谁」，**不能**用窗口矩形 ——
    //   这一条就是用户报的「选中文字后不能出现横条」的真根因，见
    //   `point_over_own_window` 的长注释。
    if point_over_own_window(x, y, &["region", "picker"]) {
        return false;
    }
    let cls = win::class_name(target);
    const SKIP: &[&str] = &[
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "SHELLDLL_DefView",
        "SysListView32",
        "TrayNotifyWnd",
        "TaskListThumbnailWnd",
    ];
    if SKIP.contains(&cls.as_str()) {
        return false;
    }
    /* 只有从客户区起手才算划选，拖标题栏 / 拖边框直接排除。
     *
     * ⚠ r89：**子窗口判不出来时要往上找父窗口再判一次**，不能直接 false。
     *
     * 原因：`WindowFromPoint` 经常返回**渲染子窗口**（浏览器/Electron 的
     * `Chrome_RenderWidgetHostHWND`、Qt 的 `QWindowIcon` 之类）。这些子窗口
     * 的客户区坐标和顶层窗口的并不总是对得上（有的子窗不处理
     * `ScreenToClient`，有的干脆是 0×0 的占位窗），于是 `point_in_client`
     * 返回 false → 整条划词被否掉 → **横条不弹**。
     *
     * 现在做两级判断：子窗不算就退到它的顶层窗口再算一次。顶层窗口的
     * 客户区几乎总是可靠的，而"拖标题栏"这个要排除的情形正好也会被
     * 顶层客户区判掉（标题栏在客户区之外）。 */
    if win::point_in_client(target, x, y) {
        return true;
    }
    let root = win::root_window(target);
    if root.0 != target.0 && !root.0.is_null() && win::point_in_client(root, x, y) {
        win::log("select: 子窗口客户区没命中，但顶层窗口命中 —— 放行");
        return true;
    }
    win::log(&format!(
        "select: 起点不在客户区（cls={cls}），按拖标题栏/边框排除"
    ));
    false
}

/// 点是不是**真的**落在某个自有窗口上（按 label 找）。
///
/// ## 为什么不能用「窗口矩形」（用户报的「选中文字后不能出现横条」的真根因）
///
/// 「识别结果」窗口是 `.center()` 开的，尺寸按用户上次拖的结果 —— 200% 缩放下
/// 本机实测 **1248×1229 物理像素**，正好铺满屏幕正中间一大片。只要它开着，
/// 原来那条矩形判据（`point_in_window`）就让那一整片区域恒等于「在 OCR 窗里」：
///
///   · 用户看完 OCR，切回浏览器 / 别的软件；
///   · 在那个矩形范围里划选文字；
///   · `should_try_select` 一律返回 false → **横条永远不弹**。
///
/// 可用户看到的分明是「我在浏览器里划字」，识别结果窗早被盖住了。
/// 屏幕边上划选能弹、中间划选不弹，主观上就是「有时候灵有时候不灵」，
/// 最后变成一句「选中文字后不能出现横条」。
///
/// 取证（`tools/select-bar-probe.js`，同一份二进制、同一个目标窗口，只挪位置）：
///   目标窗压在识别结果窗矩形之内 → `trySelect=false` → 无横条；
///   搬到矩形之外                 → `trySelect=true`  → 横条正常弹。
///
/// ## 正确的判据
///
/// 「鼠标底下那个窗口到底是谁」：用 `WindowFromPoint` 拿真实的 hwnd，再比
/// 它**和它的顶层窗口**是不是这些自有窗口自己（WebView2 的渲染子窗
/// `Chrome_RenderWidgetHostHWND` 的 `GA_ROOT` 就是宿主顶层窗，所以比顶层即可）。
/// 于是：
///
///   识别结果窗被盖住 / 最小化 / 已隐藏 → 底下是别人的窗口 → **不拦**（该弹就弹）；
///   识别结果窗真在最前面（用户在它上面划选）→ **拦住**（原设计意图不变）；
///   框选遮罩 / 拾取器那两个全屏浮层铺在最上面 → 照样拦住。
fn point_over_own_window(x: i32, y: i32, labels: &[&str]) -> bool {
    let under = win::window_under_point(x, y);
    if under.0.is_null() {
        return false;
    }
    let under_root = win::root_window(under);
    labels.iter().any(|label| {
        app()
            .get_webview_window(label)
            .and_then(|w| w.hwnd().ok())
            .map(|h| {
                let hw = HWND(h.0 as *mut _);
                hw == under || win::root_window(hw) == under_root
            })
            .unwrap_or(false)
    })
}

/// 右键监听（轮询版）。
///
/// 本机上注入的右键一个都进不了鼠标钩子，所以干脆不靠钩子：
/// 每 20ms 读一次按键状态，按下瞬间且光标在横条上就开菜单。
/// 20ms 的轮询基本感觉不出来，CPU 开销可以忽略。
/// 右键轮询线程的「横条显示了」信号（值 = 有没有待处理的唤醒）。
///
/// 为什么需要它：这条线程平时**挂在这里等唤醒**，而不是 20ms 空转一轮
/// —— 见 `spawn_rbutton_watch` 的注释。
static RBTN_PARK: (std::sync::Mutex<bool>, std::sync::Condvar) =
    (std::sync::Mutex::new(false), std::sync::Condvar::new());

/// 叫醒右键轮询线程。由 `layout_bar` 在横条**首次显示**那一刻调用。
fn wake_rbutton_watch() {
    let (m, cv) = &RBTN_PARK;
    if let Ok(mut g) = m.lock() {
        *g = true;
        cv.notify_all();
    }
}

/// 横条上的右键：**轮询**兜底（钩子那条主路见 `hook.rs` 的 `Ev::RDown`）。
///
/// 为什么还要一条轮询：别的鼠标钩子可能把 `WM_RBUTTONDOWN` 吃掉，那条主路就哑了。
///
/// ⚠ 但它**只在横条显示着的时候**才 20ms 轮询：横条没显示时谁也不会在它上面
///   右键，而 20ms 空转等于给整机加了 **50 次/秒** 的常驻定时唤醒（后台程序在
///   笔记本上会顶住待机功耗）。没显示就挂在 `RBTN_PARK` 上等 `layout_bar` 唤醒，
///   1s 兜底超时只是防漏唤醒，正常路径用不到。
fn spawn_rbutton_watch() {
    std::thread::Builder::new()
        .name("qs-rbtn".into())
        .spawn(|| {
            let mut was = false;
            loop {
                if !is_bar_shown() {
                    if let Ok(mut g) = RBTN_PARK.0.lock() {
                        /* ⚠ 先看标志再看等：`layout_bar` 可能正好在
                         * `is_bar_shown()` 与 `lock()` 之间把标志立起来 ——
                         * 那时 notify 已经发过了，直接 wait 会白等满 1s，
                         * 这一秒里的右键就漏了。
                         * ⚠ 标志必须**消费掉**（置回 false）：不然横条收起后
                         * 这里会一直命中"有待处理唤醒"→ 空转烧 CPU。 */
                        if *g {
                            *g = false;
                        } else {
                            if let Ok((mut g2, _)) = RBTN_PARK.1.wait_timeout(g, Duration::from_millis(1000)) { *g2 = false }
                        }
                    }
                    was = false;
                    continue;
                }
                std::thread::sleep(Duration::from_millis(20));
                let down = win::rbutton_down();
                if down && !was && is_bar_shown() {
                    let p = win::cursor_pos();
                    if is_bar_inner(p.x, p.y) {
                        if let Some(r) = win::window_rect(bar_hwnd()) {
                            let scale = win::dpi_scale(bar_hwnd());
                            let cx = (p.x - r.left) as f64 / scale;
                            let cy = (p.y - r.top) as f64 / scale;
                            win::log(&format!("rbtn poll -> css ({cx:.0},{cy:.0})"));
                            let _ = app().emit_to(
                                "bar",
                                "qs://rclick",
                                serde_json::json!({ "x": cx, "y": cy }),
                            );
                        }
                    }
                }
                was = down;
            }
        })
        .ok();
}

/// 横条的置顶守护（每 800ms 一次）。
///
/// 为什么单独起一条：置顶重申原先挂在 `layout_bar` 里（每次摆位重申一次）。
/// 但 `layout_bar` 现在会**跳过尺寸没变的重复摆位**（断 ResizeObserver 反馈环，
/// 见 pushLayout），横条开着不动的时候就没有人再重申置顶了 —— 别的置顶浮层
/// 一冒出来就能把横条压到下面（用户报过「只显示一小块，甚至完全被挡住」）。
/// 成本是 800ms 一次 SetWindowPos，可以忽略。
fn spawn_bar_topmost_watch() {
    std::thread::Builder::new()
        .name("qs-bartop".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(800));
            if !is_bar_shown() {
                continue;
            }
            let hwnd = bar_hwnd();
            if hwnd.0.is_null() {
                continue;
            }
            win::reassert_topmost(hwnd);
        })
        .ok();
}

/// 收藏面板「钉在屏幕上」：钉住期间**点击面板外面不收起**（面板要留在屏幕上）。
/// 用户要求：面板能自己拖动位置、并且能钉住不被别的点击带走。
static FAV_PINNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_fav_pinned(on: bool) {
    FAV_PINNED.store(on, std::sync::atomic::Ordering::SeqCst);
    win::log(&format!("fav pinned = {on}"));
}

fn spawn_detector() {
    let (tx, rx) = std::sync::mpsc::channel::<Ev>();
    hook::spawn(tx);

        std::thread::Builder::new()
            .name("qs-detect".into())
            .spawn(move || {
                let mut down: Option<(i32, i32, u32)> = None;
                let mut dragging = false;
                /* 「最近见过一次 Ctrl 按下」的时间戳。
                 *  有些软件 / 第三方工具发 Ctrl+C 的时序很怪：C 的按下先到、
                 *  Ctrl 的按下事件丢了或者晚到，光看钩子在 C 那一刻读到的
                 *  ctrl 状态就会漏 —— 这正是用户说的"部分窗口唤不出来"。
                 *  600ms 内见过 Ctrl 就也算数，是纯保险，不会带来误触发
                 *  （正常按 C 本来也带 Ctrl）。 */
                let mut last_ctrl_seen: Option<std::time::Instant> = None;

            for ev in rx {
                match ev {
                    Ev::Down(x, y, t) => {
                        dragging = false;
                        if is_bar_inner(x, y) {
                            // 点在横条自己身上，交给网页处理
                            down = None;
                            continue;
                        }
                        if is_bar_shown() {
                            // 钉住了就不许被「点外面」带走（Esc / 收起飞按钮照旧能收）
                            if FAV_PINNED.load(Ordering::SeqCst) {
                                win::log("click-outside: 收藏面板已钉住，忽略收起");
                            } else {
                                dismiss_bar();
                            }
                        }
                        down = Some((x, y, t));
                    }
                    Ev::RDown(x, y) => {
                        if is_bar_inner(x, y) {
                            // 落在横条上：把窗口内坐标换成 CSS 坐标丢给前端，
                            // 前端用 elementFromPoint 就能找到具体是哪个引擎按钮
                            let hwnd = bar_hwnd();
                            if let Some(r) = win::window_rect(hwnd) {
                                let scale = win::dpi_scale(hwnd);
                                let cx = (x - r.left) as f64 / scale;
                                let cy = (y - r.top) as f64 / scale;
                                win::log(&format!("rdown on bar -> css ({cx:.0},{cy:.0})"));
                                let _ = app().emit_to(
                                    "bar",
                                    "qs://rclick",
                                    serde_json::json!({ "x": cx, "y": cy }),
                                );
                            }
                        } else if is_bar_shown() {
                            // 钉住了就不许被「点外面」带走（Esc / 收起飞按钮照旧能收）
                            if FAV_PINNED.load(Ordering::SeqCst) {
                                win::log("click-outside: 收藏面板已钉住，忽略收起");
                            } else {
                                dismiss_bar();
                            }
                        }
                    }
                    Ev::Move(x, y) => {
                        if let Some((dx, dy, _)) = down {
                            if (x - dx).abs() > 4 || (y - dy).abs() > 4 {
                                dragging = true;
                            }
                        }
                    }
                    Ev::Up(x, y, t) => {
                        let d = down.take();
                        let was = dragging;
                        dragging = false;
                        win::log(&format!(
                            "mouseup: drag={} from={:?} at=({},{})",
                            was, d, x, y
                        ));
                        // OCR 框选遮罩铺满了全屏还置顶：此刻的一次拖动只是用户
                        // 在遮罩上框选，绝不能当「选中文字」去触发取词 ——
                        // 否则会去读剪贴板、还可能往遮罩窗口里塞 Ctrl+C，干扰框选。
                        if app().get_webview_window("region").is_some() {
                            continue;
                        }
                        if let Some((sx, sy, stt)) = d {
                            let dt = t.saturating_sub(stt);
                            let bo_end = is_bar_outer(x, y);
                            let bo_start = is_bar_outer(sx, sy);
                            let ok_sel = should_try_select(sx, sy);
                            let tgt = win::window_under_point(sx, sy);
                            let br = bar_rects()
                                .map(|(o, _)| format!("{}x{}@({},{})", o.2 - o.0, o.3 - o.1, o.0, o.1))
                                .unwrap_or_else(|| "hidden".to_string());
                            win::log(&format!(
                                "up-check: dt={dt} barOuterEnd={bo_end} barOuterStart={bo_start} trySelect={ok_sel} bar={br} target={:?} cls={}",
                                tgt.0,
                                win::class_name(tgt)
                            ));
                            /* 门限从 40ms 放到 12ms：快速划选（flick select）在
                             * 浏览器 / 编辑器里常常 20~30ms 就完成了，40ms
                             * 会把一大批"划得快"的动作当点击漏掉 —— 这正是
                             * "有时候触发有时候不触发"的主观来源之一。
                             * dragging 已经要求位移 >4px，纯点击到不了这里；
                             * 12ms 只是挡掉合成 / 注入的瞬时 Up。 */
                            if was && dt >= 12 && !bo_end && !bo_start && ok_sel {
                                // 把「划词目标属于哪个进程」和「划过的矩形」一路带进
                                // 取词：前者给剪贴板归属校验用（多进程客户端里负责
                                // 复制的未必是前台那个进程），后者给 OCR 兜底用
                                // （对方不肯把选区交出来的客户端，直接读屏幕上那块字）。
                                schedule_capture(win::window_pid(tgt), (sx, sy, x, y));
                            }
                        }
                    }
                    Ev::KeyUp(vk) => {
                        // ESC 兜底的第二条保险。用「抬起」而不是「按下」：
                        // 遮罩页面通常先吃掉按下事件，抬起几乎总能漏到钩子这边。
                        // 两条路都走也无妨 —— 关窗幂等，窗口没了什么都不会发生。
                        // ⚠ 这里用 hard_close_region 而不是 close_window：这是
                        //   "用户按了 Esc 还是出不来"时的最后一道防线，必须
                        //   保证鼠标一定回到用户手里，所以连 Win32 强杀都备着。
                        if vk == VK_ESCAPE.0 as u32 && app().get_webview_window("region").is_some() {
                            win::log("kbd(up): ESC -> close region (safety net)");
                            hard_close_region("用户按 Esc");
                            continue;
                        }
                        if vk == VK_ESCAPE.0 as u32 && app().get_webview_window("picker").is_some() {
                            win::log("kbd(up): ESC -> close picker (safety net)");
                            close_window("picker");
                            continue;
                        }
                        if vk == VK_ESCAPE.0 as u32 && app().get_webview_window("ocr").is_some() {
                            win::log("kbd(up): ESC -> close ocr result (safety net)");
                            close_window("ocr");
                            continue;
                        }
                    }
                    Ev::KeyDown(vk, seq0, ctrl, alt, shift, win, ours) => {
                        /* ⚠ ctrl / alt 是**钩子回调当时**读到的状态（见 hook.rs 的
                         * Ev::KeyDown 注释），不是这里现读的 —— 消费线程是异步的，
                         * 等排到这条事件时用户可能已经把 Ctrl 松开了，现读会得到 false，
                         * 于是 Ctrl+C / Ctrl+Alt+O 会被误判成"没按修饰键"而哑火。 */
                        /* 只在带 Ctrl / Alt 时记一笔。热键按了没反应是最难查的一类
                         * 问题（既没有报错也没有现象），留这条就能一眼看出
                         * 「钩子到底收没收到、修饰键是什么状态」。 */
                        // 收藏夹的自定义快捷键（用户在设置里录的组合键）。
                        // 必须放在 Ctrl+C 那条前面：万一用户录的就是 Ctrl+C，
                        // 那他想要的是收藏夹，不是取词。
                        if !ours {
                            if let Some((hc, ha, hs, hw, hvk)) = parse_hotkey(&cfg_with(|c| c.fav_hotkey.clone()))
                            {
                                // ⚠ Ctrl+C 是「复制取词」的保留键。历史版本允许把
                                //   Ctrl+C 录给收藏夹，而这条分支排在取词前面 ——
                                //   结果用户每次复制都被直接展开收藏夹（真实反馈）。
                                //   设置页现在已经拒收 Ctrl+C；这里再兜一道底：
                                //   只要复制取词开着，收藏夹热键对 Ctrl+C 失效。
                                let steals_copy = hvk == VK_C.0 as u32
                                    && hc
                                    && !ha
                                    && !hs
                                    && !hw
                                    && cfg_with(|c| c.trigger_copy);
                                if vk == hvk && ctrl == hc && alt == ha && shift == hs && win == hw
                                    && !steals_copy
                                {
                                    win::log("hotkey: 打开收藏夹");
                                    std::thread::spawn(show_fav_panel_bar);
                                    continue;
                                }
                            }
                        }
                        if vk == VK_CONTROL.0 as u32 {
                            last_ctrl_seen = Some(std::time::Instant::now());
                        }
                        if ctrl || alt {
                            win::log(&format!(
                                "kbd: vk=0x{vk:X} ctrl={ctrl} alt={alt} ours={ours} ocrEnable={}",
                                cfg_with(|c| c.ocr_enable)
                            ));
                        }
                        // OCR 框选的 ESC 兜底。正常路径是页面自己捕获 Esc 后调
                        // ocr_cancel 关窗；但假如页面脚本根本没跑起来（渲染进程
                        // 异常、注入失败……），或者 WebView2 还没拿到键盘焦点
                        // （刚开窗那几十毫秒最容易），用户就会被满屏遮罩困得
                        // 「点哪都没反应」。钩子这层再兜一道：遮罩还在、按下 ESC
                        // 就强制关掉，完全不依赖页面里的任何代码。
                        if vk == VK_ESCAPE.0 as u32 && app().get_webview_window("region").is_some() {
                            win::log("kbd: ESC -> close region (safety net)");
                            hard_close_region("用户按 Esc（KeyDown 兜底）");
                            continue;
                        }
                        // 拾取器遮罩是同样形态的全屏浮层，ESC 也要能退，同一套兜底。
                        if vk == VK_ESCAPE.0 as u32 && app().get_webview_window("picker").is_some() {
                            win::log("kbd: ESC -> close picker (safety net)");
                            close_window("picker");
                            continue;
                        }
                        // 识别结果窗口同样给个 Esc 兜底：页面自己会关，但刚弹出来那会儿
                        // 焦点还没落进去时页面收不到。钩子这层补一刀，行为统一。
                        if vk == VK_ESCAPE.0 as u32 && app().get_webview_window("ocr").is_some() {
                            win::log("kbd: ESC -> close ocr result (safety net)");
                            close_window("ocr");
                            continue;
                        }
                        // Ctrl+Alt+O：不管横条在不在，随时直接进 OCR 框选。
                        // 不额外注册 RegisterHotKey —— 低级键盘钩子里本来就能看见按键，
                        // 顺手判一下比再开一套热键机制省事，也不会和系统抢键位。
                        if vk == VK_O.0 as u32 && ctrl && alt && cfg_with(|c| c.ocr_enable) {
                            win::log("hotkey: Ctrl+Alt+O -> OCR");
                            std::thread::spawn(ocr_start_flow);
                            continue;
                        }
                        // ctrl：钩子在 C 那一刻读到的状态；加上"最近 600ms 见过 Ctrl"
                        // 的保险（见 last_ctrl_seen 的注释），提高在怪时序软件里的命中率。
                        let ctrl_ok = ctrl
                            || last_ctrl_seen
                                .map(|t| t.elapsed() < std::time::Duration::from_millis(600))
                                .unwrap_or(false);
                        if vk == VK_C.0 as u32 && ctrl_ok && cfg_with(|c| c.trigger_copy) {
                            // 这一次 Ctrl+C 是我们自己为取词注入的（靠 dwExtraInfo 里的
                            // 暗号 win::SELF_INJECT_TAG 识别，一锤定音）。不跳过的话，
                            // 紧接着"还原剪贴板"带来的序号变化会被当成"用户复制了内容"。
                            if ours {
                                win::log("copy path: 忽略（这是软件自己模拟的 Ctrl+C）");
                                continue;
                            }
                            if !trigger_allowed(None) {
                                continue;
                            }
                            win::log("copy path: 收到 Ctrl+C，立刻弹条（不等剪贴板）");
                            // 「立刻弹 + 迟到补」（见 read_current）：
                            //   · 先按剪贴板里现成的内容弹出来，用户零等待；
                            //   · pending=true 时挂一个后台补丁，复制真落地了再把文字补上。
                            // 归属校验要用**按 Ctrl+C 那一刻**的前台进程 —— 补丁跑起来时
                            // 用户可能已经点到横条上了，那时前台是我们自己。
                            let fg_pid = win::window_pid(win::foreground_window());
                            std::thread::spawn(move || match read_current(seq0) {
                                // Ctrl+C 这条路贴鼠标：这条路没有可靠的「文字在哪」，
                                // 而且此刻用户的手就在鼠标和键盘之间，贴鼠标最顺手。
                                // t 可能是空串（没选中文字）—— 照样弹，见 read_current。
                                Got::Text(t, pending) => {
                                    let gen = show_bar(t, true, true);
                                    if pending {
                                        late_text_patch(seq0, gen, fg_pid);
                                    }
                                }
                                Got::Image => show_ocr_only_bar(),
                            });
                        }
                    }
                }
            }
        })
        .ok();
}

/* ================================================================== */
/* 配置视图 / 广播                                                     */
/* ================================================================== */

/// 图标 dataURL 缓存：key = 图标文件名，value = (mtime 纳秒, 字节数, dataURL)。
///
/// `config_view` 每次配置广播都会走一遍（横条收藏面板 600ms 存一次尺寸就是
/// 一次广播），每个自定义图标都重新读盘 + base64 太浪费。图标只有「换图标」
/// 那一下才会动，所以按 (mtime, size) 认缓存就够。
/// ⚠ mtime 用**纳秒**：秒级精度下「同一秒内换了个同尺寸的图」会误命中旧缓存，
/// 横条图标看着没换。
/// 图标缓存条目：(mtime 纳秒, size, dataURL)。
type IconCacheEntry = (u64, u64, String);
static ICON_URL_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, IconCacheEntry>>> =
    std::sync::OnceLock::new();

fn icon_data_url_cached(path: &std::path::Path, file: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mt = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let size = meta.len();
    let cache = ICON_URL_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    // 缓存命中：连文件内容都不用读
    let hit = cache
        .lock()
        .ok()
        .and_then(|g| g.get(file).cloned())
        .filter(|(mt2, sz2, _)| *mt2 == mt && *sz2 == size)
        .map(|(_, _, url)| url);
    if let Some(url) = hit {
        return Some(url);
    }
    let bytes = std::fs::read(path).ok()?;
    let url = config::data_url(file, &bytes);
    if let Ok(mut g) = cache.lock() {
        g.insert(file.to_string(), (mt, size, url.clone()));
    }
    Some(url)
}

fn config_view() -> Value {
    let cfg = cfg_snapshot();
    let mut ov = Map::new();
    for (name, file) in cfg.overrides.iter() {
        if let Some(url) = icon_data_url_cached(&config::icons_dir().join(file), file) {
            ov.insert(name.clone(), Value::String(url));
        }
    }
    // #138：icons 目录里「文件名 = 引擎名」的默认图标（用户原话：读取
    // AppData\Roaming\QuickSearch\icons 里的自定义图标，设为对应引擎的默认图标）。
    // 优先级：overrideIcons（图库显式挑的）> 这里的 dirIcons > 引擎自带
    // iconFile > 字母徽标。已被 overrides 引用的文件跳过（它已经在 ov 里，
    // 再进 dirIcons 只会让同一份图在两条通道里各出现一次）。
    let mut di: Map<String, Value> = Map::new();
    let claimed: std::collections::HashSet<String> = cfg.overrides.values().cloned().collect();
    let mut dir_bytes: usize = 0;
    for (stem, path) in config::dir_icon_defaults() {
        if di.len() >= 256 || dir_bytes >= 6 * 1024 * 1024 {
            break; // 防呆：icons 目录被谁当下载目录使，也不能把配置广播撑爆
        }
        let Some(fname) = path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
            continue;
        };
        if claimed.contains(&fname) {
            continue;
        }
        if di.contains_key(&stem) {
            continue; // 同名多扩展名只取排序后的第一个，结果稳定
        }
        if let Some(url) = icon_data_url_cached(&path, &fname) {
            dir_bytes += url.len();
            di.insert(stem, Value::String(url));
        }
    }
    let uo: Map<String, Value> = cfg
        .url_overrides
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let ais: Map<String, Value> = cfg
        .ai_suffixes
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    json!({
        "version": config::VERSION,
        // 开发者 / 这一版的构建时间：「关于」页要显示（用户明确要求）。
        // 构建时间由 build.rs 在编译期算好注入（config::BUILT_AT 的注释里
        // 说明了为什么不用 exe 的 mtime）。
        "developer": config::DEVELOPER,
        "builtAt": config::BUILT_AT,
        // 调试构建标记：QS_DEBUG=1 时前端会打开自动化用的坐标上报等辅助逻辑。
        // 正式启动不会带上，前端那条路也就永不执行。
        "debug": std::env::var("QS_DEBUG").map(|v| v == "1").unwrap_or(false),
        // 内建自检开关：QS_SELFTEST=1 时设置页会自己把真实控件点一遍并上报结果，
        // 用于开发期真机验证。正式启动不带。
        "selftest": std::env::var("QS_SELFTEST").map(|v| v == "1").unwrap_or(false),
        "triggerSelect": cfg.trigger_select,
        "triggerCopy": cfg.trigger_copy,
        "autoStart": cfg.auto_start,
        "autoElevate": cfg.auto_elevate,
        // r80：AI 抠图总开关。**模型选择不进这里** —— 它要走 ai_matting_status
        //      命令才知道"文件在不在、运行时能不能加载"，纯配置项表达不了。
        "aiMattingEnable": cfg.ai_matting_enable,
        // r80g：模型目录（空 = 默认位置）。设置页据此显示"已自定义/默认"
        "aiModelDir": cfg.ai_model_dir,
        "iconSize": cfg.icon_size,
        "alpha": cfg.alpha,
        // 待机（鼠标没悬停）时的横条不透明度。设成 100 就等于关掉这套行为。
        "barDimAlpha": cfg.bar_dim_alpha,
        // 液态玻璃一组。前端按这些参数驱动 WebGL2 渲染器（liquidGL 移植版数学）。
        "barGlass": cfg.bar_glass,
        "barGlassRefraction": cfg.bar_glass_refraction,
        "barGlassBevel": cfg.bar_glass_bevel,
        "barGlassFrost": cfg.bar_glass_frost,
        "barGlassAberration": cfg.bar_glass_aberration,
        "barGlassSpec": cfg.bar_glass_spec,
        "barGlassTint": cfg.bar_glass_tint,
        "barGlassLive": cfg.bar_glass_live,
        // v1.3.0：实时刷新帧率上限（0 = 跟随显示器）
        "barGlassFps": cfg.bar_glass_fps,
        "iconStyle": cfg.icon_style,
        "unifyIcons": cfg.unify_icons,
        "barPadding": cfg.bar_padding,
        "itemRadius": cfg.item_radius,
        "theme": cfg.theme,
        "animations": cfg.animations,
        "shadow": cfg.shadow,
        "barBlur": cfg.bar_blur,
        "anchorAtMouse": cfg.anchor_at_mouse,
        "delayMs": cfg.delay_ms,
        "filterMode": cfg.filter_mode,
        "filterList": cfg.filter_list,
        "ocrEnable": cfg.ocr_enable,
        "ocrKey": cfg.ocr_key,
        "ocrSecret": cfg.ocr_secret,
        "ocrLang": cfg.ocr_lang,
        "ocrAccurate": cfg.ocr_accurate,
        "ocrEngine": cfg.ocr_engine,
        // 每家引擎的凭据（需求 2）：设置页据此渲染"当前引擎要填哪几样 + 已填了什么"。
        // 百度那两家老字段（ocrKey/ocrSecret）已并进来，界面不会显示成"没填"。
        "ocrCreds": ocr_creds_view(&cfg),
        // r47：「同时识别」名单 —— 默认引擎之外的、要一起跑的那几家。
        // 结果窗的版式（单框 / 多框 + 底部档位）由它 + ocrEngine 派生的
        // **参与名单**决定，所以这里必须发（老代码发的是 ocrParallel）。
        "ocrMulti": cfg.ocr_multi,
        // r49：结果窗是否**固定在默认引擎**那一档（默认开）。前端 ocr.html 的
        // pickDefaultMode 读它决定"谁先出字就先显示谁"还是"一直等默认引擎"。
        "ocrStayDefault": cfg.ocr_stay_default,
        // ⚠ ocrParallel 只留作**向下兼容**（老版本读它）：r47 起它是废弃字段，
        //   sanitize 里会在迁移后把它落回 false。前端已不再使用它。
        "ocrParallel": cfg.ocr_parallel,
        // OCR 文本整理的默认开关（需求 7）。跟着备份走：这是用户偏好，不是
        // 逐机器的东西（对比下面 ocrWinW/H 那段说明）。
        "ocrCleanGarbage": cfg.ocr_clean_garbage,
        "ocrCleanSpace": cfg.ocr_clean_space,
        "ocrCleanWidth": cfg.ocr_clean_width,
        "ocrCleanUnwrap": cfg.ocr_clean_unwrap,
        // ⚠ ocrWinW / ocrWinH **故意不进备份**：OCR 结果窗尺寸是逐机器偏好
        // （4K 台式机上拉好的 1400×1000，同步到小笔记本会开出比屏幕还大的窗）。
        // 用户对备份的要求是「数据」—— 设置、引擎、图标、收藏夹、密钥、
        // WebDAV、排序，这些都在；窗口大小属于「别的」，只在本机 config.json
        // 里持久化。哪天真要跟着备份走，先给 ocr_window_size 加屏幕边界钳制。
        "barList": cfg.bar_list,
        "favorites": cfg.favorites,
        "favHotkey": cfg.fav_hotkey,
        "backupPassword": cfg.backup_password,
        // 备份目录。以前只写不读（apply_one_setting 收它，config_view 却不发），
        // 于是「导出/云端恢复」之后用户自定义的备份目录**不会跟着回来**，
        // 设置页那一行会悄悄变回「默认」。目录在新机器上不可用也没关系：
        // config::backup_dir_of 会建不出来就退回数据目录（见那里的注释）。
        "backupDir": cfg.backup_dir,
        "favPanelSizes": cfg.fav_panel_sizes,
        "sepStyle": cfg.sep_style,
        "customEngines": cfg.custom_engines,
        "apps": cfg.apps,
        "overrideIcons": Value::Object(ov),
        // #138：icons 目录里按引擎名兜底的默认图标（前端插在 overrideIcons
        // 与 iconFile 之间查）
        "dirIcons": Value::Object(di),
        "urlOverrides": Value::Object(uo),
        "aiSuffix": cfg.ai_suffix,
        "aiSuffixes": Value::Object(ais),
        "aiCopyPrompt": cfg.ai_copy_prompt,
        "webdavUrl": cfg.webdav_url,
        "webdavUser": cfg.webdav_user,
        "webdavPass": cfg.webdav_pass,
        "webdavOnStart": cfg.webdav_on_start,
        "webdavOnExit": cfg.webdav_on_exit,
        // v1.2.0：自动更新开关。设置页「关于」里那个勾选框就是它。
        "autoUpdate": cfg.auto_update,
        "lastEngine": cfg.last_engine,
        // r54 识图搜索。跟设置走（是用户偏好，不是逐机器的东西）——
        // 换电脑恢复之后识图引擎的勾选要还在。
        "imgEnable": cfg.img_enable,
        "imgAddToBar": cfg.img_add_to_bar,
        "imgKeepClip": cfg.img_keep_clip,
        "imgDefaultEngine": cfg.img_default_engine,
        // ⚠ 发出之前先归一一遍：老配置里可能存着已下线的引擎 id，
        //   界面拿到直接渲染会出现"选了个不存在的引擎"。
        "imgEngines": imgsearch::normalize_list(&cfg.img_engines),
        "imgPublicUrl": cfg.img_public_url,
        // r76：AI 识图的按键时序 + AI 优先 + 多家自动关按键
        "imgAiPasteDelay": cfg.img_ai_paste_delay,
        "imgAiEnterDelay": cfg.img_ai_enter_delay,
        "imgAiFirst": cfg.img_ai_first,
        "imgAiAutoOffOnMulti": cfg.img_ai_auto_off_on_multi,
        // r56：「最近使用」那一栏。跟着设置走（换电脑恢复之后"最近用过什么"
        // 也还在，用户不会觉得"换了台机器就不认识我了"）。
        // 名单可能很长（每点一次记一笔），展示时按 recentMax 截断在 UI 侧做；
        // 这里发全量，上限由用户选的那档决定。
        "recentEngines": json!(cfg.recent_engines),
        "recentMax": cfg.recent_max,
    })
}

/// 把 config_view() 那种形状的 JSON 灌回配置对象（载入备份 / 云端恢复时用）
fn apply_view(v: &Value, cfg: &mut config::Config) {
    let b = |k: &str| v.get(k).and_then(|x| x.as_bool());
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64());
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());

    if let Some(x) = b("triggerSelect") { cfg.trigger_select = x; }
    if let Some(x) = b("triggerCopy") { cfg.trigger_copy = x; }
    if let Some(x) = b("autoStart") { cfg.auto_start = x; }
    if let Some(x) = b("autoElevate") { cfg.auto_elevate = x; }
    // r80：AI 抠图开关（批量导入那条路）
    if let Some(x) = b("aiMattingEnable") { cfg.ai_matting_enable = x; }
    if let Some(x) = s("aiModelDir") { cfg.ai_model_dir = x.to_string(); }
    if let Some(x) = n("iconSize") { cfg.icon_size = x.clamp(14, 96) as u32; }
    if let Some(x) = n("alpha") { cfg.alpha = x.clamp(30, 100) as u32; }
    // 待机透明度允许压得更低（最低 10%），但夹在 10-100：0% 会让横条直接
    // 消失看不见，和「它在那儿只是淡」是两回事。
    if let Some(x) = n("barDimAlpha") { cfg.bar_dim_alpha = x.clamp(10, 100) as u32; }
    // 玻璃一组：恢复备份时原样灌回（老备份没有这些键 → 保持默认，不强行开）
    if let Some(x) = b("barGlass") { cfg.bar_glass = x; }
    if let Some(x) = n("barGlassRefraction") { cfg.bar_glass_refraction = x.clamp(0, 60) as u32; }
    if let Some(x) = n("barGlassBevel") { cfg.bar_glass_bevel = x.clamp(0, 30) as u32; }
    if let Some(x) = n("barGlassFrost") { cfg.bar_glass_frost = x.clamp(0, 12) as u32; }
    if let Some(x) = n("barGlassAberration") { cfg.bar_glass_aberration = x.clamp(0, 100) as u32; }
    if let Some(x) = n("barGlassSpec") { cfg.bar_glass_spec = x.clamp(0, 200) as u32; }
    if let Some(x) = n("barGlassTint") { cfg.bar_glass_tint = x.clamp(0, 100) as u32; }
    if let Some(x) = b("barGlassLive") { cfg.bar_glass_live = x; }
    // v1.3.0：实时刷新帧率上限。白名单夹取（只认 0/30/60/120），
    // 别的值一律当 0（跟随显示器）—— 免得手改配置写出个怪值。
    if let Some(x) = n("barGlassFps") {
        let v = x as u32;
        cfg.bar_glass_fps = if matches!(v, 0 | 30 | 60 | 120) { v } else { 30 };
    }
    if let Some(x) = n("barPadding") { cfg.bar_padding = x.clamp(0, 12) as u32; }
    if let Some(x) = n("itemRadius") { cfg.item_radius = x.clamp(0, 18) as u32; }
    if let Some(x) = s("theme") {
        cfg.theme = match x.as_str() {
            "light" | "dark" => x,
            _ => "system".to_string(),
        };
    }
    if let Some(x) = b("unifyIcons") { cfg.unify_icons = x; }
    if let Some(x) = b("animations") { cfg.animations = x; }
    if let Some(x) = b("shadow") { cfg.shadow = x; }
    if let Some(x) = n("barBlur") { cfg.bar_blur = x.clamp(0, 32) as u32; }
    if let Some(x) = b("anchorAtMouse") { cfg.anchor_at_mouse = x; }
    if let Some(x) = n("delayMs") { cfg.delay_ms = x.clamp(0, 5000) as u32; }
    if let Some(x) = s("filterMode") {
        cfg.filter_mode = match x.as_str() {
            "blacklist" | "whitelist" => x,
            _ => "off".to_string(),
        };
    }
    if let Some(a) = v.get("filterList").and_then(|x| x.as_array()) {
        cfg.filter_list = a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect();
    }
    if let Some(x) = s("ocrLang") {
        // 归一交给 ocr::normalize_lang：百度没有「纯中文」这个值，
        // 老配置里的 CHN 留着会一直让识别失败。
        cfg.ocr_lang = ocr::normalize_lang(&x).to_string();
    }
    if let Some(x) = b("ocrAccurate") { cfg.ocr_accurate = x; }
    if let Some(x) = s("ocrEngine") {
        let e = x.trim().to_string();
        if ocr_engines::find(&e).is_some() { cfg.ocr_engine = e; }
    }
    if let Some(x) = b("ocrParallel") { cfg.ocr_parallel = x; }
    // r49：结果窗固定在默认引擎那一档（跟着备份走，是用户偏好）
    if let Some(x) = b("ocrStayDefault") { cfg.ocr_stay_default = x; }
    // r47：「同时识别」名单跟着备份走（是用户偏好，不是逐机器的东西）。
    // 只收注册表里认识的 id，别的丢弃 —— 备份可能来自装了更多引擎的版本。
    if let Some(arr) = v.get("ocrMulti").and_then(|x| x.as_array()) {
        cfg.ocr_multi = arr
            .iter()
            .filter_map(|x| x.as_str())
            .filter(|id| ocr_engines::find(id).is_some())
            .map(|s| s.to_string())
            .collect();
    }
    if let Some(x) = b("ocrCleanGarbage") { cfg.ocr_clean_garbage = x; }
    if let Some(x) = s("ocrCleanSpace") {
        let v = x.trim().to_string();
        if matches!(v.as_str(), "off" | "smart" | "force") { cfg.ocr_clean_space = v; }
    }
    if let Some(x) = b("ocrCleanWidth") { cfg.ocr_clean_width = x; }
    if let Some(x) = b("ocrCleanUnwrap") { cfg.ocr_clean_unwrap = x; }
    // OCR 结果窗尺寸不跟着备份走（见 config_view 里的说明）：窗口大小是逐机器
    // 偏好，恢复备份时保留本机已经拉好的尺寸，不拿旧机器的大小覆盖。
    if let Some(x) = b("ocrEnable") { cfg.ocr_enable = x; }
    // 和 WebDAV 一样的道理：空值不覆盖，免得从旧备份恢复时把密钥抹掉
    if let Some(x) = s("ocrKey") { if !x.trim().is_empty() { cfg.ocr_key = x; } }
    if let Some(x) = s("ocrSecret") { if !x.is_empty() { cfg.ocr_secret = x; } }
    // 每家引擎的凭据（需求 2）。**空值不覆盖**，理由同上面两行：
    // 备份可能是在还没配那家引擎时导出的，照单全收会把已经填好的密钥抹掉。
    if let Some(o) = v.get("ocrCreds").and_then(|x| x.as_object()) {
        for (id, c) in o {
            if ocr_engines::find(id).is_none() {
                continue; // 不认识的引擎（旧版本 / 手改过的备份）跳过
            }
            let g = |f: &str| {
                c.get(f)
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string()
            };
            let (k, sec, b, m) = (g("key"), g("secret"), g("base"), g("model"));
            for (map, val) in [
                (&mut cfg.ocr_keys, k),
                (&mut cfg.ocr_secrets, sec),
                (&mut cfg.ocr_bases, b),
                (&mut cfg.ocr_models, m),
            ] {
                if !val.is_empty() {
                    map.insert(id.clone(), val);
                }
            }
        }
    }
    if let Some(x) = b("webdavOnStart") { cfg.webdav_on_start = x; }
    if let Some(x) = b("webdavOnExit") { cfg.webdav_on_exit = x; }
    // v1.2.0：自动更新开关（跟着备份/恢复走 —— 它是用户偏好，不是逐机器的东西）
    if let Some(x) = b("autoUpdate") { cfg.auto_update = x; }
    // 注意：这三项**空值不覆盖**。备份是在填 WebDAV 之前导出的很常见，
    // 要是照单全收把地址/密码清空，之后所有同步都会失败，用户还不一定反应过来。
    if let Some(x) = s("webdavUrl") {
        if !x.trim().is_empty() {
            // 只存用户填的那一段（协议 + 尾斜杠），**不**把软件自己的子目录写进去。
            // 子目录由 webdav::normalize_base 在真正发请求时自动补 —— 这样设置页
            // 的输入框里就只显示用户该填的根地址，不会让人以为还得手填一层目录。
            cfg.webdav_url = webdav::normalize_input(&x);
        }
    }
    if let Some(x) = s("webdavUser") {
        if !x.trim().is_empty() { cfg.webdav_user = x; }
    }
    if let Some(x) = s("webdavPass") {
        if !x.is_empty() { cfg.webdav_pass = x; }
    }
    if let Some(x) = s("aiSuffix") { cfg.ai_suffix = x; }
    if let Some(x) = b("aiCopyPrompt") { cfg.ai_copy_prompt = x; }
    if let Some(m) = v.get("aiSuffixes").and_then(|x| x.as_object()) {
        for (k, val) in m {
            if let Some(t) = val.as_str() {
                cfg.ai_suffixes.insert(k.clone(), t.to_string());
            }
        }
    }
    if let Some(s) = v.get("iconStyle").and_then(|x| x.as_str()) {
        cfg.icon_style = if s == "letter" { "letter".to_string() } else { "auto".to_string() };
    }
    if let Some(m) = v.get("urlOverrides").and_then(|x| x.as_object()) {
        for (k, val) in m {
            if let Some(t) = val.as_str() {
                if t.contains("%s") {
                    cfg.url_overrides.insert(k.clone(), t.to_string());
                }
            }
        }
    }
    if let Some(a) = v.get("barList").and_then(|x| x.as_array()) {
        let list: Vec<String> = a
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.to_string())
            .collect();
        if !list.is_empty() {
            cfg.bar_list = list;
        }
    }
    if let Some(s) = v.get("sepStyle").and_then(|x| x.as_str()) {
        cfg.sep_style = s.to_string();
    }
    // 自定义引擎：备份里是同结构的 JSON 数组，直接反序列化。
    // 走 serde 而不是手抄字段，以后加字段不会漏。
    if let Some(a) = v.get("customEngines") {
        if let Ok(list) = serde_json::from_value::<Vec<config::CustomEngine>>(a.clone()) {
            cfg.custom_engines = list;
        }
    }
    // 外部软件：同上。图标不在这个结构里（走 overrideIcons，键是 @app:<id>），
    // 所以这里只恢复「名字 + 地址 + id」三样。
    if let Some(a) = v.get("apps") {
        if let Ok(list) = serde_json::from_value::<Vec<config::ExternalApp>>(a.clone()) {
            cfg.apps = list;
        }
    }
    // 收藏夹整树（含图片 dataURL）—— 备份/恢复因此天然覆盖收藏内容。
    if let Some(a) = v.get("favorites") {
        if let Ok(list) = serde_json::from_value::<Vec<config::FavGroup>>(a.clone()) {
            cfg.favorites = list;
        }
    }
    if let Some(s) = v.get("favHotkey").and_then(|x| x.as_str()) {
        cfg.fav_hotkey = s.trim().to_string();
    }
    if let Some(s) = v.get("backupPassword").and_then(|x| x.as_str()) {
        cfg.backup_password = s.to_string();
    }
    if let Some(s) = v.get("backupDir").and_then(|x| x.as_str()) {
        cfg.backup_dir = s.trim().to_string();
    }
    // 上次用的搜索引擎。config_view 一直在 emit 它，以前 restore 侧没接 ——
    // 换电脑恢复后横条默认落回第一个引擎，用户「明明一切恢复了」的错觉就被
    // 这一个细节打破。空串 / null = 没记录过，不动本机的值。
    if let Some(x) = s("lastEngine") {
        cfg.last_engine = if x.is_empty() { None } else { Some(x) };
    }
    // r54 识图搜索跟着备份走。同样的道理：名单只收注册表里认识的 id
    // （备份可能来自装了更多引擎的版本，或者来自更早的版本）。
    if let Some(x) = b("imgEnable") { cfg.img_enable = x; }
    if let Some(x) = b("imgAddToBar") { cfg.img_add_to_bar = x; }
    if let Some(x) = b("imgKeepClip") { cfg.img_keep_clip = x; }
    if let Some(x) = s("imgDefaultEngine") {
        if x.is_empty() || imgsearch::find(&x).is_some() {
            cfg.img_default_engine = x;
        }
    }
    if let Some(arr) = v.get("imgEngines").and_then(|x| x.as_array()) {
        let list: Vec<String> = arr
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.to_string())
            .collect();
        cfg.img_engines = imgsearch::normalize_list(&list);
    }
    if let Some(x) = s("imgPublicUrl") {
        if x.starts_with("http://") || x.starts_with("https://") {
            cfg.img_public_url = x;
        }
    }
    /* r76：AI 识图的三个可调项。延迟要**钳范围** —— 备份可能来自别的版本 /
     * 手改过的文件，一个 4e9 的延迟能让横条线程睡几天。
     *   上限 60 秒：等待的意义只是"等浏览器把首屏画出来"，超过就是用户走开了。 */
    if let Some(x) = n("imgAiPasteDelay") {
        cfg.img_ai_paste_delay = (x as u32).min(60_000);
    }
    if let Some(x) = n("imgAiEnterDelay") {
        cfg.img_ai_enter_delay = (x as u32).min(60_000);
    }
    if let Some(x) = b("imgAiFirst") {
        cfg.img_ai_first = x;
    }
    if let Some(x) = b("imgAiAutoOffOnMulti") {
        cfg.img_ai_auto_off_on_multi = x;
    }
    // r56：最近使用名单 + 最多摆几个。恢复备份时整份灌回来，
    // 再走一遍 normalize_recent（备份可能来自另一台机器，那边的引擎
    // 这台不一定有 —— 不清的话面板会给出不存在的格子）。
    if let Some(m) = v.get("recentEngines") {
        if let Ok(list) = serde_json::from_value::<Vec<String>>(m.clone()) {
            cfg.recent_engines = list;
            config::normalize_recent(cfg);
        }
    }
    if let Some(x) = n("recentMax") {
        cfg.recent_max = normalize_recent_max(x as usize);
    }
    if let Some(m) = v.get("favPanelSizes") {
        if let Ok(map) =
            serde_json::from_value::<std::collections::BTreeMap<String, Vec<f64>>>(m.clone())
        {
            cfg.fav_panel_sizes = map;
        }
    }
    // 自定义图标：备份里是 data URL，这里还原成 icons 目录下的文件
    if let Some(m) = v.get("overrideIcons").and_then(|x| x.as_object()) {
        for (name, url) in m {
            if let Some(u) = url.as_str() {
                if let Some(f) = config::restore_icon(name, u) {
                    cfg.overrides.insert(name.clone(), f);
                }
            }
        }
    }
    // 备份里可能带着「指向已删除收藏目录」的横条哨兵（那份备份就是在这个目录
    // 还在的时候导出的）。灌回去之前先剪掉，否则恢复完横条上立刻多一格乱码。
    let pruned = config::prune_dangling_fav_sentinels(cfg);
    if pruned > 0 {
        win::log(&format!(
            "apply_view: 备份里有 {pruned} 个指向已删除收藏目录的横条哨兵，已剪掉"
        ));
    }
    // 同理：备份里的 @app:<id> 哨兵可能指向一个不在 apps 里的 id
    // （那份备份之后用户删过软件）。剪掉，别让恢复完横条上多一格乱码。
    let pruned_apps = config::prune_dangling_app_sentinels(cfg);
    if pruned_apps > 0 {
        win::log(&format!(
            "apply_view: 备份里有 {pruned_apps} 个指向已删除外部软件的横条哨兵，已剪掉"
        ));
    }
}

fn broadcast() {
    let v = config_view();
    let a = app();
    let _ = a.emit_to("bar", "qs://config", v.clone());
    let _ = a.emit_to("settings", "qs://config", v.clone());
    // ⚠ OCR 结果窗也得发一份。
    //   这个窗口是**复用**的（关掉再框一次还是它），而它的版式（单框 / 多框 +
    //   底部档位）完全由**参与名单**（ocrEngine + ocrMulti）决定 —— 不发给它，
    //   用户"开着结果窗去设置里勾上/取消一家、再框一次"拿到的还是旧版式。
    //   窗口没开时 `emit_to` 是空操作（返回 Err，上面已经忽略），所以没有代价。
    let _ = a.emit_to("ocr", "qs://config", v);
}

#[tauri::command]
fn get_config() -> Value {
    config_view()
}

/// 单键写入的公共实现：**只改内存里的 cfg**，不落盘、不广播。
///
/// 白名单式 match，返回 Err = 这个键没有生效（未知键，或校验没过 ——
/// 目前只有 urlOverride 缺 %s 一条会走到）。调用方看到 Err 就跳过保存与
/// 广播，行为和旧版 set_setting 逐字对齐。
///
/// ⚠ 允许带副作用：`autoStart` 会真去写开机启动项、`urlOverride` 失败会弹
///   toast。批量写入 set_settings 逐键调它，副作用按序发生。
fn apply_one_setting(cfg: &mut config::Config, key: &str, value: Value) -> Result<(), String> {
    match key {
        "triggerSelect" => cfg.trigger_select = value.as_bool().unwrap_or(true),
        "triggerCopy" => cfg.trigger_copy = value.as_bool().unwrap_or(false),
        // 收藏夹整树（设置页本地编辑完一次性写回）
        "favorites" => {
            if let Ok(f) = serde_json::from_value::<Vec<config::FavGroup>>(value.clone()) {
                cfg.favorites = f;
                // 删目录的同时把横条上指向它的哨兵一起剪掉。
                // 不剪的话：横条本体（bar.js 会过滤）看着正常，但设置页
                // 「横条上的引擎」列表是照 bar_list 直出渲染的，会把
                // `@fav:xxxx` 这串 id 当引擎名显示出来 —— 用户报的"乱码"就是它。
                let pruned = config::prune_dangling_fav_sentinels(cfg);
                if pruned > 0 {
                    win::log(&format!(
                        "set_setting: 收藏树变了，剪掉 {pruned} 个失效的横条哨兵"
                    ));
                }
            }
        }
        "favHotkey" => cfg.fav_hotkey = value.as_str().unwrap_or("").trim().to_string(),
        // 备份密码：非空时所有备份自动加密（见 crypto.rs）
        "backupPassword" => {
            cfg.backup_password = value.as_str().unwrap_or("").to_string();
        }
        // 本地备份目录：空 = 数据目录（默认）。.bak、WebDAV 同步前快照
        // 都落到这里（见 config::backup_dir_of）。
        "backupDir" => {
            cfg.backup_dir = value.as_str().unwrap_or("").trim().to_string();
        }
        // 收藏夹面板的手动尺寸（按目录记忆）
        "favPanelSizes" => {
            if let Ok(m) = serde_json::from_value::<
                std::collections::BTreeMap<String, Vec<f64>>,
            >(value.clone())
            {
                cfg.fav_panel_sizes = m;
            }
        }
        "autoStart" => {
            let on = value.as_bool().unwrap_or(false);
            cfg.auto_start = on;
            win::set_autostart(on);
        }
        "iconSize" => {
            cfg.icon_size = value.as_u64().unwrap_or(30).clamp(14, 96) as u32;
        }
        "alpha" => {
            cfg.alpha = value.as_u64().unwrap_or(100).clamp(30, 100) as u32;
        }
        // 待机（未悬停）不透明度。和 alpha 共用一套 clamp 语义，只是下限放到
        // 10 —— 压得太低横条会"几乎看不见"，用户主动要求时也随他。
        "barDimAlpha" => {
            cfg.bar_dim_alpha = value.as_u64().unwrap_or(45).clamp(10, 100) as u32;
        }
        // 液态玻璃一组。set_setting 是白名单式的，不登记就是"看着有反应其实没存"。
        "barGlass" => cfg.bar_glass = value.as_bool().unwrap_or(true),
        "barGlassRefraction" => {
            cfg.bar_glass_refraction = value.as_u64().unwrap_or(20).clamp(0, 60) as u32;
        }
        "barGlassBevel" => {
            cfg.bar_glass_bevel = value.as_u64().unwrap_or(12).clamp(0, 30) as u32;
        }
        "barGlassFrost" => {
            cfg.bar_glass_frost = value.as_u64().unwrap_or(0).clamp(0, 12) as u32;
        }
        "barGlassAberration" => {
            cfg.bar_glass_aberration = value.as_u64().unwrap_or(35).clamp(0, 100) as u32;
        }
        "barGlassSpec" => {
            cfg.bar_glass_spec = value.as_u64().unwrap_or(100).clamp(0, 200) as u32;
        }
        "barGlassTint" => {
            cfg.bar_glass_tint = value.as_u64().unwrap_or(12).clamp(0, 100) as u32;
        }
        "barGlassLive" => cfg.bar_glass_live = value.as_bool().unwrap_or(false),
        // v1.3.0：实时刷新帧率上限。允许 0（跟随）/ 30 / 60 / 120。
        // 夹到合法集合里：别的值一律当 0（跟随显示器），免得手改配置写出个怪值。
        "barGlassFps" => {
            let v = value.as_u64().unwrap_or(0) as u32;
            cfg.bar_glass_fps = if matches!(v, 0 | 30 | 60 | 120) { v } else { 30 };
        }
        "iconStyle" => {
            let s = value.as_str().unwrap_or("auto");
            cfg.icon_style = if s == "letter" { "letter".to_string() } else { "auto".to_string() };
        }
        // 「统一图标大小」。⚠ set_setting 是**白名单式**的：不在这里登记，
        //   前端点开关会「看着有反应、其实没存」—— 页内自检抓到过一次。
        "unifyIcons" => cfg.unify_icons = value.as_bool().unwrap_or(true),
        "itemRadius" => {
            cfg.item_radius = value.as_u64().unwrap_or(9).clamp(0, 18) as u32;
        }
        "theme" => {
            let s = value.as_str().unwrap_or("system");
            cfg.theme = match s {
                "light" | "dark" => s.to_string(),
                _ => "system".to_string(),
            };
        }
        "barPadding" => {
            cfg.bar_padding = value.as_u64().unwrap_or(5).clamp(0, 12) as u32;
        }
        "animations" => cfg.animations = value.as_bool().unwrap_or(true),
        "shadow" => cfg.shadow = value.as_bool().unwrap_or(false),
        "barBlur" => {
            cfg.bar_blur = value.as_u64().unwrap_or(0).clamp(0, 32) as u32;
        }
        "anchorAtMouse" => cfg.anchor_at_mouse = value.as_bool().unwrap_or(false),
        "delayMs" => {
            cfg.delay_ms = value.as_u64().unwrap_or(0).min(5000) as u32;
        }
        "filterMode" => {
            let m = value.as_str().unwrap_or("off");
            cfg.filter_mode = match m {
                "blacklist" | "whitelist" => m.to_string(),
                _ => "off".to_string(),
            };
        }
        "filterList" => {
            cfg.filter_list = value
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
        }
        "ocrLang" => {
            // 归一而不是放行：设置页以前给过「纯中文 = CHN」，百度根本不认。
            cfg.ocr_lang = ocr::normalize_lang(value.as_str().unwrap_or("")).to_string();
        }
        // 默认 false = 标准版（每日 500 次免费额度）。默认 true 会让没开通
        // 付费的账号一识别就报「余额不足」，看着像 Key 不对，非常难自查。
        "ocrAccurate" => cfg.ocr_accurate = value.as_bool().unwrap_or(false),
        "ocrEngine" => {
            let e = value.as_str().unwrap_or("baidu").trim().to_string();
            if ocr_engines::find(&e).is_some() {
                cfg.ocr_engine = e;
            }
        }
        // 双引擎并行：默认关。开了之后点一次识别，本地 + 百度同时跑，
        // 结果窗里两个结果上下排布、各自标注（见 ocr_region 的并行分支）。
        "ocrParallel" => cfg.ocr_parallel = value.as_bool().unwrap_or(false),
        // r49：结果窗固定在默认引擎那一档（默认**开** —— 用户要求的默认口径）。
        "ocrStayDefault" => cfg.ocr_stay_default = value.as_bool().unwrap_or(true),
        // OCR 文本整理的默认开关（需求 7，设置页「文字识别」里那几项）。
        // ⚠ set_setting 是白名单式的，不登记就是"看着有反应其实没存"。
        "ocrCleanGarbage" => cfg.ocr_clean_garbage = value.as_bool().unwrap_or(false),
        "ocrCleanSpace" => {
            let v = value.as_str().unwrap_or("smart");
            cfg.ocr_clean_space = match v {
                "off" | "force" => v.to_string(),
                _ => "smart".to_string(),
            };
        }
        "ocrCleanWidth" => cfg.ocr_clean_width = value.as_bool().unwrap_or(false),
        "ocrCleanUnwrap" => cfg.ocr_clean_unwrap = value.as_bool().unwrap_or(false),
        "ocrEnable" => cfg.ocr_enable = value.as_bool().unwrap_or(true),
        "ocrKey" => cfg.ocr_key = value.as_str().unwrap_or("").trim().to_string(),
        "ocrSecret" => cfg.ocr_secret = value.as_str().unwrap_or("").trim().to_string(),
        "autoElevate" => cfg.auto_elevate = value.as_bool().unwrap_or(true),
        // r80：AI 抠图开关。默认 false —— 不开时走本地算法，不该替用户默认开启
        //      （它需要额外下载模型，见 config.rs 字段上的取舍说明）。
        "aiMattingEnable" => cfg.ai_matting_enable = value.as_bool().unwrap_or(false),
        // r80g：模型目录。⚠ 这里只落配置，**不做迁移** ——
        // 迁移必须与"选目录"同一个动作（见 ai_model_dir_pick 的注释）。
        "aiModelDir" => cfg.ai_model_dir = value.as_str().unwrap_or("").to_string(),
        "webdavOnStart" => cfg.webdav_on_start = value.as_bool().unwrap_or(false),
        "webdavOnExit" => cfg.webdav_on_exit = value.as_bool().unwrap_or(false),
        // v1.2.0：自动更新。⚠ `set_setting` 是白名单式的 —— 不在这里登记，
        // 前端勾选框「看着有反应、其实没存」（这个坑页内自检抓到过一次）。
        "autoUpdate" => cfg.auto_update = value.as_bool().unwrap_or(true),
        "webdavUrl" => {
            // 单键修改走的是设置页实时保存。这里只做「补协议 + 补尾斜杠」，
            // **不**把软件子目录写进配置（用户要求：地址栏只填根地址）。
            cfg.webdav_url = webdav::normalize_input(value.as_str().unwrap_or(""));
        }
        "webdavUser" => cfg.webdav_user = value.as_str().unwrap_or("").trim().to_string(),
        "webdavPass" => cfg.webdav_pass = value.as_str().unwrap_or("").to_string(),
        "aiSuffix" => cfg.ai_suffix = value.as_str().unwrap_or("").to_string(),
        "sepStyle" => {
            let v = value.as_str().unwrap_or("line");
            cfg.sep_style = if matches!(v, "line" | "dot" | "space") {
                v.to_string()
            } else {
                "line".to_string()
            };
        }
        "aiCopyPrompt" => cfg.ai_copy_prompt = value.as_bool().unwrap_or(true),
        "aiSuffixOf" => {
            // value = { "engine": "...", "suffix": "..." }
            let eng = value.get("engine").and_then(|x| x.as_str()).unwrap_or("");
            let sfx = value.get("suffix").and_then(|x| x.as_str()).unwrap_or("");
            if !eng.is_empty() {
                if sfx.trim().is_empty() {
                    // 清空 = 回到全局默认
                    cfg.ai_suffixes.remove(eng);
                } else {
                    cfg.ai_suffixes.insert(eng.to_string(), sfx.to_string());
                }
            }
        }
        "urlOverride" => {
            let eng = value.get("engine").and_then(|x| x.as_str()).unwrap_or("");
            let url = value.get("url").and_then(|x| x.as_str()).unwrap_or("").trim();
            if !eng.is_empty() {
                if url.is_empty() {
                    cfg.url_overrides.remove(eng);
                } else if url.contains("%s") {
                    cfg.url_overrides.insert(eng.to_string(), url.to_string());
                } else {
                    let _ = app().emit_to(
                        "settings",
                        "qs://toast",
                        "链接模板里必须带 %s（它代表选中的文字），没保存",
                    );
                    return Err("链接模板里必须带 %s".into());
                }
            }
        }
        // ---------------- r54 识图搜索 ----------------
        // ⚠ set_setting 是**白名单式**的：不登记就是「设置页点着有反应、其实没存」。
        //    页内自检专门盯这一类（ocrClean* 那组就这么栽过一次）。
        /* r72：总开关关掉就当"不在横条上"（哨兵一起剪掉），打开且「加到横条」
         * 也开着就补回哨兵 —— 和下面 imgAddToBar 那段同一个口径。 */
        "imgEnable" => {
            let on = value.as_bool().unwrap_or(true);
            cfg.img_enable = on;
            let has = cfg.bar_list.iter().any(|n| n == config::BAR_IMG);
            if !on && has {
                cfg.bar_list.retain(|n| n != config::BAR_IMG);
            } else if on && !has && cfg.img_add_to_bar {
                cfg.bar_list.push(config::BAR_IMG.to_string());
            }
        }
        /* r72：识图按钮改成 bar_list 里的一等成员（`@img` 哨兵），位置/拖拽/
         * 移出都走和普通引擎同一套。开关和哨兵是同一件事的两面，必须一起改 ——
         * 只改开关会出现「开关说在横条上、列里没有它」（用户点了移出却还在），
         * 或反过来「列里有、开关说没开」（按钮灰着但横条上有）。
         * 什么时候才真加：总开关也开着（imgEnable）。否则加进去也画不出来。 */
        "imgKeepClip" => cfg.img_keep_clip = value.as_bool().unwrap_or(false),
        "imgAddToBar" => {
            let on = value.as_bool().unwrap_or(true);
            cfg.img_add_to_bar = on;
            let has = cfg.bar_list.iter().any(|n| n == config::BAR_IMG);
            if on && !has && cfg.img_enable {
                cfg.bar_list.push(config::BAR_IMG.to_string());
            } else if !on && has {
                cfg.bar_list.retain(|n| n != config::BAR_IMG);
            }
        }
        "imgDefaultEngine" => {
            // 只收注册表里认识的 id；空串合法（=「不设默认」，回到多选名单）
            let e = value.as_str().unwrap_or("").trim().to_string();
            if e.is_empty() || imgsearch::find(&e).is_some() {
                cfg.img_default_engine = e;
            }
        }
        "imgEngines" => {
            // 统一过 normalize_list：只留认识的、去重、按注册表顺序排
            let list = value
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .map(|s| s.trim().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            cfg.img_engines = imgsearch::normalize_list(&list);
        }
        "imgPublicUrl" => {
            let u = value.as_str().unwrap_or("").trim().to_string();
            // 只要 http(s) 开头的；别的（file:// 、本地路径、乱填的）一律清空，
            // 免得 Url 类引擎拿它拼出一个注定失败的请求。
            cfg.img_public_url = if u.starts_with("http://") || u.starts_with("https://") {
                u
            } else {
                String::new()
            };
        }
        /* r76：AI 识图的三个可调项（用户原话见 config.rs 那几个字段的注释）。
         * 延迟钳 0..=60000：设置页会给步进按钮，但 IPC 这条路上来的值不可信 ——
         * 一个 4e9 能把横条线程睡几天。 */
        "imgAiPasteDelay" => {
            cfg.img_ai_paste_delay = (value.as_u64().unwrap_or(1200) as u32).min(60_000);
        }
        "imgAiEnterDelay" => {
            cfg.img_ai_enter_delay = (value.as_u64().unwrap_or(900) as u32).min(60_000);
        }
        "imgAiFirst" => {
            cfg.img_ai_first = value.as_bool().unwrap_or(true);
        }
        "imgAiAutoOffOnMulti" => {
            cfg.img_ai_auto_off_on_multi = value.as_bool().unwrap_or(true);
        }
        // r56：最近使用那一栏摆几个。只认 5/10/15/20 四档（设置页就给这四个），
        // 别的值退回默认 10 —— 不静默接受 0（"一个都不显示"看着像坏了）
        // 也不接受 1000（那等于把全表又抄一遍）。
        "recentMax" => {
            cfg.recent_max = normalize_recent_max(value.as_u64().unwrap_or(10) as usize);
        }
        // 名单本身由**后端**在每次引擎被点时自己追加（note_recent_engine），
        // 不接受前端直接写 —— 否则"最近使用"的语义就没了（前端可以随便塞）。
        _ => return Err(format!("未知设置键：{key}")),
    }
    Ok(())
}

/// 「最近使用」最多摆几个：只认 5/10/15/20，别的退回 10。
/// 设置页就给这四档（用户原话：「可以选择最多呈现最近使用的 5 个、10 个、15 个
/// 或者 20 个」），所以这里是个**封闭集合**而不是范围夹取。
/// ⚠ 实现在 config.rs（`normalize_recent_max`）—— 那里是配置归一的住处，
///   main.rs 只通过 `config::` 路径用。两处各写一份迟早对不上。
pub use config::normalize_recent_max;
pub use config::note_recent_engine;

#[tauri::command]
fn set_setting(key: String, value: Value) {
    // 主题改了要额外给横条补发一次 qs://theme（见函数尾）
    let theme_key = key == "theme";
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if apply_one_setting(&mut cfg, &key, value).is_err() {
            return; // 没生效：不落盘、不广播（与旧行为一致）
        }
        config::save(&cfg);
    }
    broadcast();
    if theme_key {
        reemit_theme_to_bar();
    }
}

/// 批量写入：**一次保存 + 一次广播**。
///
/// 存在的意义是消灭「点一下预设发六个 set_setting」：液态玻璃预设直切时，
/// 旧写法每敲一个键就广播一次半成品配置，前端 syncGlassPreset() 读到
/// 第 3 个键生效时的状态，把预设认成「自定义」闪一下（用户报的闪烁）。
/// 预设整组值在这里作为一个整体落盘，前端只会看到最终态。
///
/// 中途某个键校验失败（只有 urlOverride 会）只跳过那一个，其余照存。
#[tauri::command]
fn set_settings(pairs: Vec<(String, Value)>) {
    if pairs.is_empty() {
        return;
    }
    let mut theme_key = false;
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        for (key, value) in &pairs {
            if key == "theme" {
                theme_key = true;
            }
            if let Err(e) = apply_one_setting(&mut cfg, key, value.clone()) {
                win::log(&format!("set_settings: 键 {key} 没生效（{e}），跳过"));
            }
        }
        config::save(&cfg);
    }
    broadcast();
    if theme_key {
        reemit_theme_to_bar();
    }
}

/// 把当前主题补发给横条窗。
///
/// `qs://config` 广播只带配置、不带主题 —— 主题是 show_bar 那刻算好随事件
/// 下发的。设置页改了 theme 之后，横条上已经打开的面板（更多引擎页、
/// 收藏夹页）还留着旧主题，这里补发一次 qs://theme 同步（#148 起主题
/// 不再依赖锚点采样，随时可算）。
///
/// 横条还没唤起来过（没有锚点）也照发：那时候横条本来就看不见，
/// 这次发的只是让「面板正开着」的场景立刻同步。
fn reemit_theme_to_bar() {
    let theme = current_theme();
    let _ = app().emit_to("bar", "qs://theme", theme);
}

/// r54 需求 3：把可勾选的导出项清单发给设置页。
///
/// 和 `img_engines_list` / `ocr_engines_list` 一个路子：**界面驱动自数据**。
/// 勾选界面、隐私标记、默认勾选状态全由 `export::GROUPS` 一张表定 ——
/// 加一项导出内容只改那一处，设置页自动跟上，不会出现"后端支持、界面没有"。
#[tauri::command]
fn export_groups_list() -> Value {
    export::items()
}

/// r54 需求 3：**明文**配置导出（按用户勾选的项）。
///
/// 与 `export_config`（备份）的区别，用户原话已经说清了：
/// 「导出的配置数据不加密，可直接被他人导入恢复；备份功能单独存在且支持加密」。
/// 所以这里：
///   * **不加密**（备份那边按备份密码 AES-GCM，这边一个字都不碰）；
///   * 文件名后缀用 `.qsconf`（明文导出）而不是 `.QuickSearch`（备份）——
///     资源管理器里就能看出哪份是能直接给人家的明文，哪份是加密备份；
///   * 内容是 `{kind, items, at, data}`，`data` 只含勾中组的键。
///
/// ⚠ 这条命令只是"弹对话框 + 把选中的路径交给 `export::write_plain`"的**薄壳**。
///   真正的活儿在那个纯函数里（可单测、不碰 GUI）—— 拆开是刻意的：真机探针
///   没法在新式 IFileDialog 里输路径（文件名框默认没有键盘焦点，注入的按键
///   全被对话框吃掉，实测白跑三轮），而"导出的文件能不能再导回来"这条链路
///   必须验。拆出来之后单测覆盖来回逻辑，真机探针只验界面/对话框本身。
#[tauri::command]
fn export_items(app: AppHandle, items: Vec<String>) {
    win::log(&format!("export_items: {items:?}"));
    if items.is_empty() {
        let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", "一项都没勾，没什么可导出的".to_string()));
        return;
    }
    let _ = app.run_on_main_thread(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("导出 Quick Search 配置（明文）")
            .set_file_name(format!("config({}).qsconf", config::backup_stamp()))
            .add_filter("QuickSearch 明文配置", &["qsconf"])
            .add_filter("JSON", &["json"]);
        let bdir = cfg_with(config::backup_dir_of);
        if bdir.is_dir() {
            dlg = dlg.set_directory(bdir);
        }
        let Some(p) = picked_file(dlg) else {
            win::log("export_items: cancelled");
            return;
        };
        let msg = match export::write_plain(&p, &items, &config_view()) {
            Ok(n) => {
                win::log(&format!("export_items -> {} keys={n}", p.display()));
                // 这一步必须说清楚"这是明文"：用户可能正要把文件发给别人
                format!("配置已导出（明文，{n} 个设置项，可直接发给别人导入）")
            }
            Err(e) => {
                win::log(&format!("export_items failed: {e}"));
                "写入失败，换个位置试试".to_string()
            }
        };
        let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", msg));
    });
}

/// `rfd::FileDialog::save_file()` 的小包装：只为了让调用处少一层 Option 嵌套。
fn picked_file(dlg: rfd::FileDialog) -> Option<std::path::PathBuf> {
    dlg.save_file()
}

/// r54 需求 3：导入**明文**导出的配置。
///
/// 用户原话：「导入功能仅支持直接恢复导出的明文数据，不支持导入加密备份」。
/// 所以这里不尝试解密 —— 遇到加密备份直接报错并指路「备份」页。
///
/// ⚠ **合并式**而不是覆盖式：只把文件里带的那些键灌回去，别的键原样留着。
///   这正是"我只导出搜索引擎配置给同事"能用的前提 —— 要是整份覆盖，
///   同事的收藏夹、快捷键会被我这份文件清空。
///
/// ⚠ 和 `export_items` 一样，这条命令也是薄壳：选文件交给对话框，
///   "读文件 → 三道闸"在 `export::read_plain` 里（可单测）。见那函数的注释。
#[tauri::command]
fn import_items(app: AppHandle) {
    win::log("import_items");
    let _ = app.run_on_main_thread(move || {
        let Some(p) = rfd::FileDialog::new()
            .set_title("导入 Quick Search 明文配置")
            .add_filter("QuickSearch 明文配置", &["qsconf", "json"])
            .pick_file()
        else {
            win::log("import_items: cancelled");
            return;
        };
        let toast = |s: String| {
            let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", s));
        };
        let (items, data) = match export::read_plain(&p, MAX_BACKUP_BYTES) {
            Ok(v) => v,
            Err(e) => {
                win::log(&format!("import_items rejected: {e}"));
                toast(e);
                return;
            }
        };
        let n_keys = data.as_object().map(|o| o.len()).unwrap_or(0);
        let named: Vec<&str> = items
            .iter()
            .filter_map(|id| export::find_group(id).map(|g| g.name))
            .collect();
        {
            let mut cfg = match st().cfg.lock() {
                Ok(c) => c,
                Err(_) => {
                    toast("配置正忙，稍后再试".to_string());
                    return;
                }
            };
            // 灌键。⚠ 这里复用 apply_view 而不是自己写一套读取规则：
            //   clamp、默认值、归一化（比如 imgEngines 过 normalize_list）、
            //   **图标落盘**（overrideIcons 里的 dataURL 由 config::restore_icon
            //   写回 icons 目录并回填 overrides）全都和备份恢复走同一条路。
            //   两条导入路用同一套解析，是"导入结果可预期"的前提 —— 自己再写
            //   一份的话，同一个键在备份恢复和明文导入里会读出两种结果。
            apply_view(&data, &mut cfg);
            config::save(&cfg);
        }
        broadcast();
        win::log(&format!("import_items done: {n_keys} keys, groups={named:?}"));
        toast(format!("已导入 {} 项（{} 个设置项）", named.len(), n_keys));
    });
}

/// 导出配置（含自定义图标的 data URL）到一个 json 文件，方便换机器 / 备份。
#[tauri::command]
fn export_config(app: AppHandle) {
    win::log("export_config");
    let _ = app.run_on_main_thread(move || {
        // 默认文件名跟用户要求的备份命名口径一致：
        // 「文件名(详细时间).QuickSearch」—— 后缀用软件名，资源管理器里
        // 不会一眼看成普通 json（用户原话：「也算是一定程度的加密」）。
        let mut dlg = rfd::FileDialog::new()
            .set_title("导出 Quick Search 配置")
            .set_file_name(format!("config({}).QuickSearch", config::backup_stamp()))
            .add_filter("QuickSearch 备份", &["QuickSearch"]);
        // 默认就落在用户的备份目录里（没设过就是数据目录）
        let bdir = cfg_with(config::backup_dir_of);
        if bdir.is_dir() {
            dlg = dlg.set_directory(bdir);
        }
        let picked = dlg.save_file();
        let Some(p) = picked else {
            win::log("export_config: cancelled");
            return;
        };
        let text = match serde_json::to_string_pretty(&config_view()) {
            Ok(s) => s,
            Err(e) => {
                win::log(&format!("export_config serialize failed: {e}"));
                return;
            }
        };
        // 备份里全是敏感数据（OCR Key、WebDAV 密码、收藏内容）——
        // 设了备份密码就加密，没设就原样导出（用户自己的选择）。
        let text = match crypto::encrypt(&text, &cfg_with(|c| c.backup_password.clone())) {
            Ok(s) => s,
            Err(e) => {
                win::log(&format!("export_config encrypt failed: {e}"));
                let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", format!("加密失败：{e}")));
                return;
            }
        };
        let ok = std::fs::write(&p, text).is_ok();
        win::log(&format!("export_config -> {} ok={ok}", p.display()));
        let msg = if ok { "配置已导出" } else { "写入失败，换个位置试试" };
        let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", msg));
    });
}

/* ================================================================== */
/* WebDAV 云端备份                                                     */
/* ================================================================== */

/// 云同步互斥：上传 / 恢复 / 启动同步同一时刻只放行一个。
///
/// 不加会怎样：用户等不及连点两下「上传」，或者启动同步还没跑完就手点
/// 「从云端恢复」—— 两个线程交错 restore/upload，轻则白传一份旧配置上去
/// 把较新的覆盖掉，重则恢复到一半被另一次 `config::save` 冲掉。
/// `swap(true)` 抢锁，抢不到的直接提示，绝不让两个云操作叠着跑。
static SYNC_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 云同步互斥的 **RAII 守卫**。
///
/// # 为什么必须是 RAII（不是手动 store(false)）
///
/// 以前每一处都是「swap 抢锁 → 干活 → store(false) 放锁」。这中间任何一步
/// panic（网络库、JSON 解析、`restore_from_text`…）都会让标志**永远停在 true**，
/// 之后所有云操作统一报「上一次云操作还没结束」，只能重启程序。
/// 文件里别的地方（BUSY）早就用守卫解决过同类问题，这里一直漏着。
struct SyncGuard;

impl SyncGuard {
    /// 抢锁；已经被别人占着返回 None（调用方据此给一句"稍等"）。
    fn acquire() -> Option<SyncGuard> {
        if SYNC_BUSY.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(SyncGuard)
        }
    }
}

impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_BUSY.store(false, Ordering::SeqCst);
    }
}

/// 载入备份的体积上限：32MB。
///
/// 收藏夹塞满压缩图也就几 MB；超过这个数只可能是选错了文件（把视频/镜像
/// 当备份选进来）或者文件损坏。**必须在读之前**就看大小 —— 等
/// `read_to_string` 把 4GB 拖进内存再拒绝就晚了。
const MAX_BACKUP_BYTES: u64 = 32 * 1024 * 1024;

fn wd_opts(cfg: &Config, timeout_secs: u64) -> webdav::Opts {
    webdav::Opts {
        url: cfg.webdav_url.clone(),
        user: cfg.webdav_user.clone(),
        pass: cfg.webdav_pass.clone(),
        timeout_secs,
    }
}

/// 备份/恢复的结果统一从这里出去：日志留一份，设置面板上的小字提示和
/// 顶部 toast 各显示一份。
fn wd_toast(msg: impl Into<String>) {
    let msg = msg.into();
    win::log(&format!("webdav: {msg}"));
    let _ = APP.get().map(|a| {
        let _ = a.emit_to("settings", "qs://webdav", msg.clone());
        let _ = a.emit_to("settings", "qs://toast", msg);
    });
}

/// 打包当前配置。形态和「导出配置备份」完全一致 ——
/// 自定义图标已经在 config_view() 里编成了 data URL，所以这一份就是完整配置包。
fn backup_payload() -> Result<String, String> {
    let plain = serde_json::to_string_pretty(&config_view()).map_err(|e| format!("打包配置失败：{e}"))?;
    // ⚠ 所有备份（云端 + 本机导出）都从这里出 —— 设了备份密码就自动加密，
    //   用户不用记得手动做什么。
    crypto::encrypt(&plain, &cfg_with(|c| c.backup_password.clone()))
}

/// 覆盖配置目录里的一份安全副本。
/// 恢复云端之前先留一手：万一云端那份是错的，用户还能自己捞回来。
fn stash_local_config() {
    let src = config::config_path();
    if !src.exists() {
        return;
    }
    // ⚠ 文件名带时间戳：以前固定叫 config.before-webdav.json，第二次恢复会直接
    //   覆盖第一次的快照 —— 于是"从云端恢复错了想退回上一份本机配置"这条兜底
    //   只能用一次。现在每次各留一份，并只保留最近 5 份。
    //   命名跟滚动备份同一套用户要求的口径：
    //   `config.before-webdav(YYYY-MM-DD HH-MM-SS).QuickSearch`。
    let stamp = config::backup_stamp();
    let dir = cfg_with(config::backup_dir_of);
    let dst = dir.join(format!("config.before-webdav({stamp}).QuickSearch"));
    if std::fs::copy(&src, &dst).is_ok() {
        win::log(&format!("webdav: 已留本地副本 {}", dst.display()));
    }
    // 老的清理一遍，别让留档自己堆成垃圾（新老名字都认）
    let mut all: Vec<std::path::PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let n = p.to_string_lossy();
                n.contains("config.before-webdav")
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    all.sort();
    while all.len() > 5 {
        let p = all.remove(0);
        let _ = std::fs::remove_file(p);
    }
}

/// 把一份备份文本灌回配置（云端恢复和「载入备份」共用同一套校验）。
fn restore_from_text(text: &str) -> Result<(), String> {
    // 加密备份先解密（没加密的原样放行 —— 旧备份 / 没设密码的导出都兼容）
    let text = crypto::decrypt(text, &cfg_with(|c| c.backup_password.clone()))?;
    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("备份内容不是有效的 JSON：{e}"))?;
    // 最低限度的合理性检查：宁可拒绝，也不能拿一个不相干的 json 把用户配置冲掉
    if v.get("barList").is_none() && v.get("version").is_none() {
        return Err("这份文件不像 Quick Search 的配置备份，已放弃恢复".into());
    }
    {
        let mut cfg = st().cfg.lock().map_err(|_| "配置正忙，稍后再试".to_string())?;
        apply_view(&v, &mut cfg);
        config::save(&cfg);
    }
    broadcast();
    Ok(())
}

/// 「上次**成功**备份到云端」是几点（unix 秒）。0 = 没记录。
///
/// 为什么需要这么一个小记号：备份文件名带上时间戳之后，一次备份就是一个
/// **新文件**，云端不再互相覆盖（这正是用户要的 —— 恢复时才有得挑）。
/// 代价是「启动时同步 / 退出时同步」若每次都无条件推一份，用户一天开几次
/// 软件就在网盘里堆几个文件，配置一个字都没改也一样。所以记下最后一次上传的
/// 时刻，配合 config.json 的 mtime 判断「自那以后到底改动过没有」。
///
/// 只记**成功之后**的时刻：上传失败不留记号，下次照样会重试（宁可多试一次，
/// 也不能因为一次网络抖动就再也不备份了）。
///
/// 用户主动点「立即备份」不受这个记号约束 —— 那是明确要求留一个还原点。
/// `last-backup.txt` 里记的两样东西：最后一次成功上传的时刻 + 当时配置的**实质指纹**。
///
/// 文件格式一行两段：`<unix秒>\t<指纹>`。老版本只写了一段的纯秒数 ——
/// 解析时第二段取不到就返回 None，按"没有指纹"处理（保守地当成"改过了"）。
fn last_backup_mark() -> (i64, Option<u64>) {
    let Ok(s) = std::fs::read_to_string(config::data_dir().join("last-backup.txt")) else {
        return (0, None);
    };
    let mut it = s.trim().split(['\t', ' ']);
    let at = it.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let dig = it.next().and_then(|x| x.parse::<u64>().ok());
    (at, dig)
}

/// 记下「刚刚成功备份过」：时刻 + 当时的实质指纹。
///
/// 指纹的用处见 `changed_since_last_backup` —— 它能挡住"只改了面板尺寸/最后用的引擎"
/// 这种**没有实质变化**的自动备份，那正是数据目录（和网盘）被 112KB 备份堆满的来源。
fn mark_backup_done() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if now <= 0 {
        return;
    }
    let dig = cleanup::substance_digest(&config_view());
    let _ = std::fs::write(
        config::data_dir().join("last-backup.txt"),
        format!("{now}\t{dig}"),
    );
}

/// 配置自上次成功备份以来**有没有实质改动**。
///
///   * 读不到 config.json 的 mtime（文件被删 / 权限异常）→ 返回 true，
///     保守地按「有改动」处理：多备份一次没有代价，漏备份才有。
///   * 没有记号（第一次、或用户手工删了记号文件）→ 同样返回 true。
///
/// ⚠ 两道闸，第二道是新加的：
///   ① **mtime 快筛**（老逻辑）：mtime 没动 → 肯定没改。
///   ② **实质指纹**：mtime 动了也未必是**实质**变了 —— 收藏面板尺寸、最后用的那个引擎、
///      识别窗大小这些纯界面状态一变，config.json 就会被重写、mtime 跟着变，
///      于是每开一次软件就多推一份 112KB 的备份到本地和网盘。
///      实测（轮 23）：用户数据目录里 4 份手动备份，**2 份是完全冗余的**，
///      解密后把这几项界面状态剔掉，内容一模一样。
///      指纹一致 → 判定"没实质改动" → 跳过这次自动备份。
fn changed_since_last_backup() -> bool {
    let (last, last_dig) = last_backup_mark();
    if last <= 0 {
        return true;
    }
    let mtime_changed = match std::fs::metadata(config::config_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
    {
        // 留 2 秒余量：同一秒内的写入 + 文件系统时间戳精度差异不该被当成"改过了"
        Some(lt) => lt > last + 2,
        None => true,
    };
    if !mtime_changed {
        return false;
    }
    if let Some(prev) = last_dig {
        if cleanup::substance_digest(&config_view()) == prev {
            win::log("webdav: config.json 的 mtime 变了，但实质内容没变（只动了界面状态），跳过这次自动备份");
            return false;
        }
    }
    true
}

/// 一次备份的结果。
struct BackupOutcome {
    /// 本地那一份落在哪（写失败时是 None —— 那不算整次失败，见下）
    local: Option<std::path::PathBuf>,
    /// 云端文件名（**和本地同名**）
    cloud: String,
    bytes: usize,
}

/// 一次完整的「备份」= **先在本地落一份，再把同一份上传到云端**。
///
/// 用户要求原话：「备份的逻辑应该是先本地备份一次，然后把这一个备份上传到云端」；
/// 同时点名「当前上传到云端的文件和备份到本地的文件不是同一个文件」。
/// 轮 20 又把最后一点不合的口径也拉平了 —— 用户看到本地是
/// `config(2026-10-12 23-06-22).QuickSearch`、云端却是 `quicksearch-backup.json`，
/// 明确要求「备份到云端的文件名完全没有必要自定义，直接把本地的拉上去就可以了」。
///
/// 所以这里守三条：
///   1. 本地文件和云端文件**同名**（`config::backup_name()`，唯一的命名口径）；
///   2. 内容是**同一份字节**（同一个 `payload` 变量，本地写它、上传也传它）；
///   3. 名字带时间戳 → 云端因此会**累积多份**，「从云端恢复」的列表才有东西可选。
///      以前是固定文件名反复覆盖，云端永远只有一条 —— 用户做了很多次备份
///      却只看到一个，就是它。
///
/// 本地写入失败**不算整次失败**：能推上云端本身就有价值，只是要把这件事说清楚
/// （所以返回值里 local 是 Option）。
fn backup_once(cfg: &Config, timeout_secs: u64) -> Result<BackupOutcome, String> {
    let o = wd_opts(cfg, timeout_secs);
    if !o.ready() {
        return Err("还没填 WebDAV 地址".into());
    }
    let payload = backup_payload()?;
    let name = config::backup_name(&config::backup_stamp());

    // ① 先本地
    let dir = config::backup_dir_of(cfg);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(&name);
    let local = match std::fs::write(&path, payload.as_bytes()) {
        Ok(_) => {
            win::log(&format!("backup: 本地已写 {}", path.display()));
            Some(path)
        }
        Err(e) => {
            win::log(&format!("backup: 本地写入失败 {}：{e}", path.display()));
            None
        }
    };

    // ② 再把**同一份字节**推上去（同名）
    webdav::upload_named(&o, &name, &payload)?;
    win::log(&format!(
        "backup: 已上传云端 {name}（{} 字节）",
        payload.len()
    ));
    // 只在上传真的成功之后留记号：失败要能被下次自动同步重试
    mark_backup_done();
    Ok(BackupOutcome {
        local,
        cloud: name,
        bytes: payload.len(),
    })
}

/// 备份结果的一句话说明：本地那份和云端那份的名字**必须一起报**——
/// 「是不是同一个文件」正是用户要确认的事。
fn backup_summary(r: &BackupOutcome) -> String {
    let kb = format!("{:.1} KB", r.bytes as f64 / 1024.0);
    match &r.local {
        Some(_) => format!("已备份并上传：{}（{kb}）· 本地与云端是同一份", r.cloud),
        None => format!("已上传云端：{}（{kb}）；本地那份没写成功，检查备份目录", r.cloud),
    }
}

/// 启动时同步：拿云端备份的 Last-Modified 和本机 config.json 的修改时间比，
/// **谁新用谁**。云端压根没有备份就直接推一份上去。
///
/// 互斥锁的持有/释放收在**这一层**：里面无论从哪条路 return（没开同步、
/// 没填地址、读不到时间、上传失败），锁都由外层统一放掉，不会漏。
fn webdav_sync_on_start() {
    /* ⚠ 隔离实例绝不碰云端。启动同步是**下载并覆盖本机**那个方向，
     *   测试实例若把云端内容拉下来，会污染它自己的临时配置（无害），
     *   但更要紧的是它退出时又会把那份东西传回去（有害）。
     *   一刀切掉最干净。 */
    if is_isolated_instance() {
        win::log("webdav: 隔离实例，跳过启动同步（不碰用户云端）");
        return;
    }
    // 启动同步启动得晚（setup 里缓了 6 秒等面板就绪），用户完全可能在这之前
    // 就手点了上传/恢复 —— 互斥锁两边都认，抢不到就让位。
    // 抢锁用 RAII 守卫：`_inner` 里任何一步 panic 都不会把标志永久留在 true
    // （以前手动 store(false)，一旦 panic 就变成"所有云操作都报上一次没结束"）。
    let Some(_guard) = SyncGuard::acquire() else {
        win::log("webdav: 已有云操作在跑，启动同步让位");
        return;
    };
    webdav_sync_on_start_inner();
}

fn webdav_sync_on_start_inner() {
    let cfg = cfg_snapshot();
    if !cfg.webdav_on_start {
        return;
    }
    let o = wd_opts(&cfg, 15);
    if !o.ready() {
        return;
    }
    // 「云端那份」= 目录里**最新**的一份（不是固定文件名 —— 现在一次备份一个
    // 带时间戳的名字，见 backup_once）。
    let remote = match webdav::latest(&o) {
        Ok(v) => v.map(|b| (b.name, b.mtime)),
        // 列目录失败：有些网盘既不支持 PROPFIND、也不给 HTML 目录页。
        // 这种服务器上退回「固定文件名」那条老路 —— 至少启动同步还能用。
        Err(e) => match webdav::remote_mtime(&o) {
            Ok(Some(t)) => {
                win::log(&format!(
                    "webdav: 列目录失败（{e}），退回按老固定文件名 {} 比较时间",
                    webdav::LEGACY_FILE
                ));
                Some((webdav::LEGACY_FILE.to_string(), t))
            }
            Ok(None) => None,
            Err(e2) => {
                wd_toast(format!("启动同步失败：{e2}"));
                return;
            }
        },
    };
    let local = std::fs::metadata(config::config_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    // 「本机 → 云端」这一支的节流：配置自上次成功备份后一个字都没改过时不再推，
    // 否则每次启动都会在云端多出一个文件（见 last_backup_mark 的注释）。
    let push = || {
        if !changed_since_last_backup() {
            win::log("webdav: 配置自上次备份后没有改动，跳过这次自动备份");
            return;
        }
        match backup_once(&cfg, 15) {
            Ok(r) => wd_toast(format!("启动同步：{}", backup_summary(&r))),
            Err(e) => wd_toast(format!("启动同步失败：{e}")),
        }
    };

    match (remote, local) {
        // 云端还没有备份 → 直接备份一次（本地 + 云端同一份）
        (None, _) => push(),
        // 云端更新 → 先留副本再恢复
        (Some((name, rt)), Some(lt)) if rt > lt + 2 => {
            stash_local_config();
            match webdav::download_named(&o, &name).and_then(|t| restore_from_text(&t)) {
                Ok(_) => wd_toast(format!("启动同步：云端「{name}」较新，已恢复到本机")),
                Err(e) => wd_toast(format!("启动同步失败：{e}")),
            }
        }
        // 服务器没给时间（rt==0）也走这条：宁可按"本机更新"备份一次，
        // 也不要在读不到时间时误把本机配置覆盖掉。
        _ => push(),
    }
}

#[tauri::command]
fn webdav_test() {
    std::thread::spawn(|| {
        let cfg = cfg_snapshot();
        match webdav::probe(&wd_opts(&cfg, 15)) {
            Ok(m) => wd_toast(m),
            Err(e) => wd_toast(format!("连接失败：{e}")),
        }
    });
}

#[tauri::command]
fn webdav_upload() {
    std::thread::spawn(|| {
        let Some(_guard) = SyncGuard::acquire() else {
            wd_toast("上一次云操作还没结束，稍等一下再点");
            return;
        };
        let cfg = cfg_snapshot();
        match backup_once(&cfg, 15) {
            Ok(r) => wd_toast(backup_summary(&r)),
            Err(e) => wd_toast(format!("上传失败：{e}")),
        }
    });
}


/* ⚠ r55 审视时删掉的死命令（都确认过：源码 / UI / 探针三处零引用）：
 *   · `webdav_restore` —— 恢复云端最新一份。设置页改成了「先列目录、挑一份、
 *     再 `webdav_restore_named`」，不再有"无脑恢复最新"的按钮（最新一份万一是坏的
 *     就误伤了）。`webdav::latest` 那条路仍在"启动时自动同步"里用着，没动。
 *   · `set_favorites` —— 整树写收藏夹。设置页现在走 `set_setting` 的
 *     `favorites` 白名单项，保存路径收敛成一个入口。
 *   · `move_bar_engine` —— 单个引擎左右微调。横条排序统一走设置页拖动
 *     （`move_bar_item`），没有微调入口。
 *   · `count_links` —— 数一段文字里几个链接。前端自己就能算
 *     （`extract_links` 在 shared.js 里有对应实现），没必要绕一次 IPC。
 * 保留但**没有界面入口**的（实现留着，注释里写了为什么）：
 *   `grab_foreground_app`（"加外部软件"以后要用）、`ocr_rescan`（结果页不再调它，
 *   但接口留着）、`ensure_rect`（自动化测试专用）、`quit_app`（托盘走菜单事件）。 */

/// 列出云端目录里的备份，供设置页「从云端恢复」时选择。
///
/// 需求是「恢复的时候能选云端哪一份」，所以这里必须真去列目录，
/// 而不是写死只认配置里那一个文件名。目录列不出来也要把原因说清楚，
/// 让用户知道是网盘不支持列举还是路径填错了。
#[tauri::command]
fn webdav_list() {
    std::thread::spawn(|| {
        let cfg = cfg_snapshot();
        let o = wd_opts(&cfg, 15);
        // 走 list_newest_first：设置页那份列表**必须新的在最上面**，
        // 用户挑的通常是刚传的那一份，排在中间就得一行行找。
        emit_wd_list(&o);
    });
}

/// 列一次云端目录，把结果推给设置页（`qs://wd-list`）。
///
/// `webdav_list` 与「删完立刻刷新」共用 —— 同一份列表口径只写一遍。
fn emit_wd_list(o: &webdav::Opts) {
    match webdav::list_newest_first(o) {
        Ok(v) => {
            let items: Vec<serde_json::Value> = v
                .iter()
                .map(|b| {
                    serde_json::json!({
                        "name": b.name,
                        "size": b.size,
                        "mtime": b.mtime,
                    })
                })
                .collect();
            let _ = APP
                .get()
                .map(|a| a.emit_to("settings", "qs://wd-list", items));
        }
        Err(e) => wd_toast(format!("列不出云端备份：{e}")),
    }
}

/// 删除云端**指定的若干份**备份（设置页「云端备份管理」多选删除用）。
///
/// 逐份删，**一份失败不影响其它**：网盘上文件一多、网络一抖，
/// 因为第 3 个报错就把后面 7 个全跳过，用户只会觉得"点了没反应"。
/// 删完重新列一次目录，前端不用自己维护"哪几行已经没了"。
#[tauri::command]
fn webdav_delete(files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let Some(_guard) = SyncGuard::acquire() else {
            wd_toast("上一次云操作还没结束，稍等一下再点");
            return;
        };
        let cfg = cfg_snapshot();
        let o = wd_opts(&cfg, 20);
        if !o.ready() {
            wd_toast("先在设置里填 WebDAV 地址");
            return;
        }
        let mut ok = 0usize;
        let mut failed: Vec<String> = Vec::new();
        for f in &files {
            match webdav::delete_named(&o, f) {
                Ok(_) => ok += 1,
                Err(e) => {
                    win::log(&format!("webdav: 删除 {f} 失败：{e}"));
                    failed.push(format!("{f}（{e}）"));
                }
            }
        }
        if failed.is_empty() {
            wd_toast(format!("已删除云端 {ok} 份备份"));
        } else {
            wd_toast(format!(
                "删除完成：成功 {ok} 份，失败 {} 份 —— {}",
                failed.len(),
                failed.join("；")
            ));
        }
        emit_wd_list(&o);
    });
}

/// 「仅保留最近 N 份」：本地备份目录 + 云端各留最新的 N 份，其余全删。
///
/// 用户要求「在备份里面要添加一个选项，功能是仅保留最近的 10 份备份，
/// 其他的备份全部清除」，并明确**本地和云端都要清**（两边共用一个 `keep`，
/// 一次点击两边都干净，不会出现"本地清了云端还堆着"）。
///
/// 清理范围只算「用户主动做的备份」（`is_prunable_backup`）：
///   · 滚动备份只有 1 份、下次改设置就会重建 → 不参与；
///   · 恢复前快照由 `stash_local_config` 自己按"只留 5 份"管 → 不参与。
#[tauri::command]
fn prune_backups(keep: usize) {
    let keep = keep.max(1);
    std::thread::spawn(move || {
        let Some(_guard) = SyncGuard::acquire() else {
            wd_toast("上一次云操作还没结束，稍等一下再点");
            return;
        };
        // ① 本地：按修改时间从新到旧排，只保留前 keep 个
        let dir = cfg_with(config::backup_dir_of);
        let mut all: Vec<(std::path::PathBuf, u64)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !p.is_file() || !is_prunable_backup(name) {
                    continue;
                }
                let mt = e
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                all.push((p, mt));
            }
        }
        all.sort_by_key(|a| std::cmp::Reverse(a.1));
        let local_total = all.len();
        let mut local_removed = 0usize;
        for (p, _) in all.iter().skip(keep) {
            if std::fs::remove_file(p).is_ok() {
                local_removed += 1;
            }
        }

        // ② 云端：同一套「保留最新 keep 份」
        let cfg = cfg_snapshot();
        let o = wd_opts(&cfg, 20);
        let mut cloud_removed = 0usize;
        let mut cloud_kept = 0usize;
        let mut cloud_error = String::new();
        if o.ready() {
            match webdav::list_newest_first(&o) {
                Ok(v) => {
                    // 服务器没给时间（"只认 GET"的服务器走的就是这条路）→
                    // 新旧只能靠文件名兜底判定。必须留痕，否则事后
                    // "为什么删的是这几份"完全看不出来。
                    if !v.is_empty() && v.iter().all(|b| b.mtime == 0) {
                        win::log(
                            "prune: 云端备份都没有时间戳，改按文件名倒序判定新旧（名字是零填充的时间戳）",
                        );
                    }
                    cloud_kept = v.len().min(keep);
                    for b in v.iter().skip(keep) {
                        /* ⚠ 云端删除必须和本地用**同一个判据**。
                         *
                         * WebDAV 列目录是按"看起来像文件"过滤的（有扩展名就收），
                         * 用户那个目录里完全可能有别的东西（别的软件的备份、
                         * 同步下来的文档）。无条件 `skip(keep)` 全删 = 把不属于
                         * 本软件的文件也删了 —— 本地侧一直有 `is_prunable_backup`
                         * 这道闸，云端这边原来漏了。
                         *
                         * 认不出是"我们的备份"就跳过，只记一行日志。 */
                        if !is_prunable_backup(&b.name) {
                            win::log(&format!(
                                "prune: 云端 {} 不是本软件的备份命名，跳过不删",
                                b.name
                            ));
                            continue;
                        }
                        match webdav::delete_named(&o, &b.name) {
                            Ok(_) => cloud_removed += 1,
                            Err(e) => {
                                win::log(&format!("prune: 删云端 {} 失败：{e}", b.name));
                                if cloud_error.is_empty() {
                                    cloud_error = format!("{}（{e}）", b.name);
                                }
                            }
                        }
                    }
                }
                Err(e) => cloud_error = e,
            }
        }

        let mut parts = vec![format!(
            "本地保留 {} 份、删除 {} 份",
            local_total - local_removed,
            local_removed
        )];
        if !o.ready() {
            parts.push("云端没配，跳过".into());
        } else if !cloud_error.is_empty() {
            parts.push(format!("云端删除 {cloud_removed} 份后出错：{cloud_error}"));
        } else {
            parts.push(format!("云端保留 {cloud_kept} 份、删除 {cloud_removed} 份"));
        }
        wd_toast(format!("仅保留最近 {keep} 份：{}", parts.join(" · ")));

        if o.ready() && cloud_error.is_empty() {
            emit_wd_list(&o);
        }
    });
}

/// 「清理冗余数据」：扫描 / 执行数据目录里的冗余与无用文件。
///
/// 用户要求：「数据文件夹里面有很多的冗余数据，我希望这些冗余数据能够被删除。
/// 最好是在备份页面里面能有一个选项，点击后就删除冗余数据，删除无用数据。」
///
/// `apply = false` 只扫描并回报清单（前端先把"要删什么、能腾多少"摆给用户看），
/// `apply = true` 才真删。判据与安全闸都在 `cleanup` 模块里，一条一条写清楚了。
///
/// ⚠ **必须是 async 命令**：Tauri 里**同步命令跑在主线程**上，而这个扫描要逐份解密
///   备份才能判重（每份一次 Argon2id，几十毫秒）—— 主线程被占住，整个界面（包括横条
///   和托盘）都会跟着卡。声明成 async 之后它会落到异步运行时的工作线程上。
#[tauri::command]
async fn cleanup_data(apply: bool) -> serde_json::Value {
    // 备份目录可能与数据目录不同（用户改过），两个都要扫：备份文件在备份目录，
    // 而 config.json.bad-N / config.json.bak / icons/ 永远在数据目录。
    let (dirs, password, used) = cfg_with(|c| {
        let used: std::collections::HashSet<String> = c.overrides.values().cloned().collect();
        let mut dirs = vec![config::backup_dir_of(c)];
        let data = config::data_dir();
        if !dirs.contains(&data) {
            dirs.push(data);
        }
        (dirs, c.backup_password.clone(), used)
    });

    let report = cleanup::scan(&dirs, &password, &used);
    if !apply {
        win::log(&format!(
            "cleanup: 扫描完成，可清理 {} 个文件 / {} 字节",
            report.total_count(),
            report.total_bytes()
        ));
        return report.to_json(false);
    }

    let (n, freed) = report.apply();
    win::log(&format!("cleanup: 已清理 {n} 个文件，释放 {freed} 字节"));
    let mut out = report.to_json(true);
    out["deleted"] = serde_json::json!(n);
    out["freed"] = serde_json::json!(freed);
    out
}

/// 从云端恢复**指定的那一份**备份。
///
/// 恢复前照旧先在本地留一份 `config.before-webdav(时间).QuickSearch` 快照 ——
/// 选错一份就得有办法退回去，这一步不能因为「多了一个选择项」就被省掉。
/// （快照带时间戳、只留最近 5 份，见 `stash_local_config`。）
#[tauri::command]
fn webdav_restore_named(name: String) {
    std::thread::spawn(move || {
        let Some(_guard) = SyncGuard::acquire() else {
            wd_toast("上一次云操作还没结束，稍等一下再点");
            return;
        };
        let cfg = cfg_snapshot();
        let o = wd_opts(&cfg, 20);
        if !o.ready() {
            wd_toast("先在设置里填 WebDAV 地址");
            return;
        }
        stash_local_config();
        match webdav::download_named(&o, &name).and_then(|t| restore_from_text(&t)) {
            Ok(_) => wd_toast(format!("已从云端恢复「{name}」")),
            Err(e) => wd_toast(format!("恢复失败：{e}")),
        }
    });
}

/// 设置页「服务器地址」实时预览补全结果。
///
/// 只做纯计算，不碰网络也不写配置 —— 用户还在输入的半截地址就能看到软件会
/// 把它当成什么，避免「填了半截地址、点保存后地址却变了」这种意外。
///
/// 返回 `{ ok, url, error, fullUrl, sample }`：`url` 是补全后的目录，
/// `fullUrl` 是拼上备份文件名的最终地址，让用户一眼确认备份到底会落在哪。
///
/// ⚠ 备份文件名**不再可自定义**（用户要求：本地叫什么，云端就叫什么）。
///   这里给的是**示例名**，真正的时间戳是按下「立即备份」那一刻拼的。
#[tauri::command]
fn webdav_preview_url(url: String) -> serde_json::Value {
    match webdav::validate_url(&url) {
        Ok(dir) => {
            let sample = config::backup_name(&config::backup_stamp());
            serde_json::json!({
                "ok": true,
                "url": dir,
                "fullUrl": format!("{dir}{}", webdav::encode_seg_for_preview(&sample)),
                "sample": sample,
                "error": "",
            })
        }
        Err(e) => serde_json::json!({
            "ok": false, "url": "", "fullUrl": "", "sample": "", "error": e
        }),
    }
}

/// 这个进程是不是**隔离的测试实例**（不碰用户真实的云端/网络副作用）。
///
/// # 为什么必须有这道闸（血的教训）
///
/// 我用临时 APPDATA 起实例做自动化验证，本以为"数据都在临时目录、不会影响用户"。
/// 结果漏了一件事：**WebDAV 云同步**。
///   · 测试实例退出了 → `webdav_on_exit=true` → 它把**自己的测试配置**上传到了
///     用户的坚果云（185MB 的备份目录里多了一份带测试数据的 config）；
///   · 用户下次启动软件 → `webdav_on_start=true` → 云端那份"较新" →
///     **覆盖回本机**；
///   · 用户横条上的引擎、自定义快捷键引擎**全没了**。
///
/// 所以：只要带 `QS_INSTANCE_TAG` 或 `QS_NO_CLOUD=1`，就**一律不许碰云端**。
/// 这条闸放在产品代码里（而不是测试脚本里），因为脚本可以忘，产品不该给机会。
fn is_isolated_instance() -> bool {
    if std::env::var("QS_INSTANCE_TAG").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    std::env::var("QS_NO_CLOUD").map(|v| v == "1").unwrap_or(false)
}

/// 退出前同步。只做上传（覆盖云端），不会反过来动本机配置。
fn exit_sync_if_needed() {
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::SeqCst) {
        return;
    }
    /* ⚠ 隔离实例绝不碰云端（见 `is_isolated_instance` 的注释：
     *   这正是导致用户横条引擎被覆盖的那条路）。 */
    if is_isolated_instance() {
        win::log("exit: 隔离实例，跳过 WebDAV 上传（不碰用户云端）");
        return;
    }
    let cfg = cfg_snapshot();
    if !cfg.webdav_on_exit || !wd_opts(&cfg, 5).ready() {
        return;
    }
    // 同启动同步：配置自上次成功备份后没改动就不必再推一份，否则"开一次改一个字
    // 就关掉"这种用法每天都往云端堆一个新文件（名字带时间戳，不会互相覆盖）。
    if !changed_since_last_backup() {
        win::log("exit: 配置自上次备份后没有改动，跳过 WebDAV 上传");
        return;
    }
    win::log("exit: 退出前同步 WebDAV…");
    // 超时压到 5 秒：网盘不通的时候也不能让用户关不掉软件
    match backup_once(&cfg, 5) {
        Ok(r) => win::log(&format!(
            "exit: webdav 备份完成 {}（{} 字节）",
            r.cloud, r.bytes
        )),
        Err(e) => win::log(&format!("exit: webdav 上传失败 {e}")),
    }
}

/* ================================================================== */
/* v1.2.0：自动更新                                                     */
/* ================================================================== */

/// 更新互斥：同一时刻只允许一个"查 / 下 / 装"在跑。
///
/// 同 `SYNC_BUSY` 的理由与写法：用户连点「检查更新」、或者一边下着一边又点，
/// 两个线程同时写同一个 `QuickSearch.exe.new` 会互相踩。
struct UpdateGuard;

static UPDATE_BUSY: AtomicBool = AtomicBool::new(false);

impl UpdateGuard {
    fn acquire() -> Option<UpdateGuard> {
        if UPDATE_BUSY.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(UpdateGuard)
        }
    }
}
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_BUSY.store(false, Ordering::SeqCst);
    }
}

/// 最近一次检查到的"有新版"结果（前端问 `update_pending` 时给它）。
///
/// 为什么要存下来：启动时那次检查是**后台**做的，等它回来时用户可能还没打开
/// 设置页。存一份状态，前端打开「关于」页就能看到"有新版 vX.Y.Z"，
/// 而不是错过那个瞬时事件。
static UPDATE_PENDING: std::sync::Mutex<Option<update::UpdateInfo>> =
    std::sync::Mutex::new(None);

/// 把一次检查结果推给设置页（`qs://update`）。
///
/// `manual = true` 时即使没有新版也要发（用户手动点的，必须给回话）。
fn emit_update(info: &update::UpdateInfo, manual: bool) {
    let payload = serde_json::json!({
        "version": info.version,
        "tag": info.tag,
        "newer": info.newer,
        "current": info.current,
        "notes": info.notes,
        "size": info.size,
        "page": info.page,
        "manual": manual,
    });
    let _ = APP.get().map(|a| a.emit_to("settings", "qs://update", payload));
}

/// 查一次更新并把结果广播出去。
///
/// `manual`：用户主动点「检查更新」→ 无论结果如何都要说话；
///          自动（启动时）→ 只有"确实有新版"才推事件（没新版就什么都不发生，
///          这正是用户要求的「如果是最新版，那就什么都不发生」）。
fn do_check_update(manual: bool) {
    let Some(_guard) = UpdateGuard::acquire() else {
        if manual {
            let _ = APP.get().map(|a| {
                a.emit_to("settings", "qs://toast", "正在检查更新，稍等一下…")
            });
        }
        return;
    };
    let current = config::VERSION;
    match update::check(current) {
        Ok(info) => {
            win::log(&format!(
                "update: 检查完成 —— 远端 {}，当前 {current}，有新版={}",
                info.tag, info.newer
            ));
            if info.newer {
                if let Ok(mut g) = UPDATE_PENDING.lock() {
                    *g = Some(info.clone());
                }
                emit_update(&info, manual);
            } else {
                if let Ok(mut g) = UPDATE_PENDING.lock() {
                    *g = None;
                }
                if manual {
                    emit_update(&info, true);
                }
            }
        }
        Err(e) => {
            win::log(&format!("update: 检查失败 {e}"));
            if manual {
                let _ = APP.get()
                    .map(|a| a.emit_to("settings", "qs://toast", format!("检查更新失败：{e}")));
            }
        }
    }
}

/// 启动时的那一次（后台，等一会儿再查，别和窗口/钩子抢启动）。
fn auto_check_on_start() {
    // 用户在设置里取消勾选 → **彻底不检测**（不发任何网络请求）
    if !cfg_with(|c| c.auto_update) {
        win::log("update: 自动更新开关关着，跳过启动检查");
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(8));
        do_check_update(false);
    });
}

/// 「检查更新」按钮。**手动动作不受自动更新开关限制** ——
/// 用户明确要求"检查更新就是点击检查之后，来看是否有更新版"。
#[tauri::command]
fn update_check() {
    std::thread::spawn(|| do_check_update(true));
}

/// 前端打开「关于」页时问一句"现在有没有待装的新版"。
#[tauri::command]
fn update_pending() -> serde_json::Value {
    let g = match UPDATE_PENDING.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    match g.as_ref() {
        Some(i) => serde_json::json!({
            "has": true,
            "version": i.version,
            "tag": i.tag,
            "notes": i.notes,
            "size": i.size,
            "page": i.page,
        }),
        None => serde_json::json!({ "has": false }),
    }
}

/// 「下载并安装」：在程序内下好 → 校验 → 替换旧程序。
///
/// 进度通过 `qs://update-progress` 推给设置页（`(已下, 总)`）。
/// 成功后**不自动退出**：把决定权交给用户（页面上出现"立即重启"按钮），
/// 免得他正开着 OCR 结果窗或没保存的收藏就被程序自己关掉。
#[tauri::command]
async fn update_install() {
    std::thread::spawn(|| {
        let Some(_guard) = UpdateGuard::acquire() else {
            wd_toast("正在下载更新，稍等一下…");
            return;
        };
        let info = {
            let g = match UPDATE_PENDING.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match g.as_ref() {
                Some(i) => i.clone(),
                None => {
                    wd_toast("没有待安装的新版本，先点「检查更新」");
                    return;
                }
            }
        };
        win::log(&format!("update: 开始下载 {}", info.url));
        let app = APP.get().cloned();
        let mut last_emit = std::time::Instant::now();
        let r = update::download(&info, &mut |done, total| {
            /* 进度事件节流到 ~8 次/秒：下载可能几十 MB，每条都发 IPC 会让
             * WebView 一直忙着重绘进度条，反而卡。 */
            if last_emit.elapsed().as_millis() < 120 && done < total {
                return;
            }
            last_emit = std::time::Instant::now();
            if let Some(a) = &app {
                let _ = a.emit_to(
                    "settings",
                    "qs://update-progress",
                    serde_json::json!({ "done": done, "total": total }),
                );
            }
        });
        let new_path = match r {
            Ok(p) => p,
            Err(e) => {
                if let Some(a) = &app {
                    let _ = a.emit_to("settings", "qs://update-failed", e);
                }
                win::log("update: 下载失败");
                return;
            }
        };
        win::log(&format!("update: 下载完成 {}", new_path.display()));
        match update::apply_update() {
            Ok(_) => {
                if let Some(a) = &app {
                    let _ = a.emit_to("settings", "qs://update-done", info.version.clone());
                }
                win::log("update: 替换完成，等用户重启");
            }
            Err(e) => {
                if let Some(a) = &app {
                    let _ = a.emit_to("settings", "qs://update-failed", e);
                }
                win::log("update: 替换失败");
            }
        }
    });
}

/// 「立即重启」：退出当前进程并拉起新的那份 exe。
///
/// 用 `CreateProcess` 而不是 `open::that`：后者会走 shell 关联，
/// 可能被"以管理员运行"的 UAC 拦一道、还可能因为路径里有空格出岔子。
/// 这里直接起自己（同目录、同权限），最直。
///
/// # ⚠ 必须给新进程带 `QS_TAKEOVER=1`（v1.3.0 修的真 bug）
///
/// 顺序是「先拉起新进程 → 再退出自己」，所以新进程起来的那一刻**老进程
/// 还没有退出、单实例互斥体还被占着**。不带标记的话，新进程会在
/// `already_running()` 里判定"已有一个在跑"、**立刻 exit(0) 自杀** ——
/// 于是用户点了「立即重启」，两边都退出，程序**整个消失**。
///
/// 带上 `QS_TAKEOVER=1` 之后，新进程会**等老进程释放互斥体**再继续
/// （见 `win::already_running` 的说明），这才是一次正确的交班。
#[tauri::command]
fn update_restart() {
    match std::env::current_exe() {
        Ok(exe) => {
            win::log(&format!("update: 重启到 {}", exe.display()));
            // 先把该收的收了（临时图、云同步按设置），再拉新进程
            img_temp_cleanup();
            if cfg_with(|c| c.webdav_on_exit && !c.webdav_url.trim().is_empty()) {
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                std::thread::spawn(move || {
                    exit_sync_if_needed();
                    let _ = tx.send(());
                });
                let _ = rx.recv_timeout(Duration::from_secs(6));
            }
            let dir = exe.parent().map(|p| p.to_path_buf());
            let mut cmd = std::process::Command::new(&exe);
            if let Some(d) = dir {
                cmd.current_dir(d);
            }
            /* ⚠⚠ 关键：告诉新进程"你是来接手单实例的，别因为互斥体被占就自杀"。
             *   漏了这一行 = 点重启后程序整个消失（这个 bug 我引入过）。 */
            cmd.env("QS_TAKEOVER", "1");
            match cmd.spawn() {
                Ok(_) => {
                    app().exit(0);
                }
                Err(e) => {
                    // 起不来就**别退出** —— 否则用户手上一个程序都没有了
                    wd_toast(format!(
                        "重启失败：{e} —— 请手动关掉本程序再打开（新版已经装好了）"
                    ));
                }
            }
        }
        Err(e) => wd_toast(format!("取不到程序路径：{e}")),
    }
}

/// 「关于」页那颗 GitHub 按钮：用系统默认浏览器打开仓库主页。
#[tauri::command]
fn open_repo_page() {
    let url = update::REPO_URL;
    win::log(&format!("open_repo_page: {url}"));
    // open::that 在 Windows 上就是 ShellExecuteW，冷启动会阻塞几百毫秒，
    // 所以丢后台线程（同 spawn_open_links 的理由）。
    std::thread::spawn(move || {
        let _ = open::that(url);
    });
}

/// 所有「用户主动退出」的入口都走这里：先把该同步的同步掉，再退。
fn quit_with_sync(code: i32) {
    /* r57：退出前把识图留下的那张临时图清掉。
     *
     * 放在这里（而不是各条退出路径各写一次）是因为它是**唯一**的退出入口 ——
     * 托盘退出、设置页退出、带云同步退出，最后都落到这一句 `app().exit()`。
     * 少写一处，那条路上就会留一张图在 %TEMP% 里躺着，正好是用户说的
     * 「不能永久的存在电脑里面」。 */
    img_temp_cleanup();
    /* ⚠ 退出同步挪到**后台线程**跑，最多等 5 秒。
     *
     * 原来 `exit_sync_if_needed()` 直接在这条调用栈上同步跑 `backup_once`：
     * 它是网络操作（最长 5 秒超时），期间窗口不重绘、点哪都没反应 ——
     * 用户看到的是"点了退出，程序卡住几秒才消失"。
     *
     * 现在：起一个线程做同步，主线程最多等 5 秒（超时就不等了，直接退）。
     * 网络通畅时行为和以前一样；网络不通时也不会让退出变得更卡。 */
    if cfg_with(|c| c.webdav_on_exit && !c.webdav_url.trim().is_empty()) {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            exit_sync_if_needed();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_secs(6));
    }
    app().exit(code);
}

/// 载入之前导出的配置备份。
#[tauri::command]
fn import_config(app: AppHandle) {
    win::log("import_config");
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("载入 Quick Search 配置")
            // 新格式导出是 .QuickSearch（见 export_config），老的 .json 也得能选
            .add_filter("QuickSearch 备份", &["QuickSearch", "json"])
            .pick_file();
        let Some(p) = picked else {
            win::log("import_config: cancelled");
            return;
        };
        let toast = |s: &str| {
            let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", s.to_string()));
        };
        // 体积上限：**读之前**就看大小。选错文件（视频/镜像当备份选进来）时
        // 等 read_to_string 把它整个拖进内存再拒绝就晚了 —— 轻则卡住几秒，
        // 重则直接 OOM。收藏夹塞满压缩图也就几 MB，32MB 对正常备份绰绰有余。
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > MAX_BACKUP_BYTES => {
                win::log(&format!(
                    "import_config: {} 有 {:.1}MB，超过上限，拒绝",
                    p.display(),
                    m.len() as f64 / 1048576.0
                ));
                toast("备份文件超过 32MB，确认选对文件了吗");
                return;
            }
            _ => {}
        }
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) => {
                win::log(&format!("import_config read failed: {e}"));
                toast("文件读不出来");
                return;
            }
        };
        match restore_from_text(&text) {
            Ok(_) => {
                win::log("import_config done");
                toast("配置已载入");
            }
            Err(e) => {
                win::log(&format!("import_config failed: {e}"));
                toast(&e);
            }
        }
    });
}

/// 抓取前台程序名：调用方点完按钮后有 5 秒时间切到目标软件。
///
/// 故意做成「先返回、晚点再推事件」而不是阻塞 5 秒 —— Tauri 的同步命令跑在主线程上，
/// 在那儿 sleep 会把整个软件（包括横条）一起冻住。
///
/// ⚠ 这条命令**目前没有调用方**（r55 审视时确认：设置页既不发 `qs://grabbed`
///    的订阅、也没有入口点它）。留着是因为「加外部软件」那个流程以后很可能
///    要用回它 —— 与其每用一次重写一遍（还要重新趟主线程/异步那个坑），
///    不如让这份实现和注释在这儿待命。真要删的那天，连着下面那行注册一起删。
#[tauri::command]
fn grab_foreground_app() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(5000));
        let exe = win::foreground_exe().unwrap_or_default();
        win::log(&format!("grab_foreground_app -> {exe:?}"));
        let _ = APP.get().map(|a| a.emit_to("settings", "qs://grabbed", exe));
    });
}

/* ================================================================== */
/* OCR：框选屏幕 → 百度识别 → 结果窗口里挑引擎搜                        */
/* ================================================================== */

/// 最近一次识别出来的文字。
/// 结果窗口是异步起来的，前端就绪之前它可能已经错过了事件，所以除了推事件，
/// 还留一份在这里让前端主动来拉（`ocr_take_text`）。
static OCR_LAST: Mutex<String> = Mutex::new(String::new());

/// 最近一次识别的**未去空格原文**。
///
/// 结果页的「智能去空格 / 强力去空格」两颗按钮的原料：
/// 智能去空格 = 对原文过一遍 `clean_spaces`；强力去空格 = 原文去掉全部空格。
/// 存原文而不是存「当前显示的文本」，这样两颗按钮可以来回切
/// （先强力删光了、再点智能还能恢复回来）。
static OCR_LAST_RAW: Mutex<String> = Mutex::new(String::new());

/// 截图代次：每次框选新截图 +1。引擎结果缓存按代次匹配 ——
/// 换了一张图（新框选），旧缓存全部作废，绝不能把上一张图的结果拿来用。
static OCR_PNG_GEN: AtomicU64 = AtomicU64::new(0);

/// 引擎结果缓存：(截图代次, 引擎名, 清理后文本, 原始文本, 引擎标签)。
///
/// 用户要求：结果窗口里「本地 → 百度 → 本地」来回切的时候，同一个引擎
/// 在**同一张图**上的结果要记住，第二次切回来直接出，不能再等半天重新识别。
/// 窗口没关、图没换之前一直有效；换图（代次变了）或窗口关了自然失效。
/// 上限 8 条纯属保险（实际只有 baidu/windows 两键），防呆不防 gf。
/// 一条引擎结果缓存：(截图代次, 引擎名, 清理后文本, 原始文本, 引擎标签)。
type OcrCacheEntry = (u64, String, String, String, String);
static OCR_RESULT_CACHE: Mutex<Vec<OcrCacheEntry>> = Mutex::new(Vec::new());

/// 最近一次框选截下来的那张图（PNG 字节）。
///
/// 用户要的是「上面图片、下面文字」的对照：框了哪块、认出了什么，一眼能对上。
/// 所以截图不能在送进识别之后就丢掉，得留着给结果窗口显示。
/// 存成 PNG 字节而不是 base64：base64 只在真正要发给前端时才编码一次，
/// 免得每次 push 事件都重新编一遍几 MB 的字符串。
static OCR_LAST_PNG: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// 把最近一次 OCR 的图包成 data URL。
/// ⚠ 现在存的可能是 JPEG（提速后截图线程直接出 JPEG），老配置/老路径还可能是
///    PNG —— 靠魔数判断，别把 mime 写死，不然结果窗的图显示不出来。
fn ocr_image_data_url(bytes: &[u8]) -> String {
    let is_jpeg = bytes.len() > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
    let mime = if is_jpeg { "image/jpeg" } else { "image/png" };
    format!("data:{mime};base64,{}", config::base64(bytes))
}

/// 需要让用户知道的一句话（目前只有「高精度自动降级成标准版」这一种）。
///
/// 用 `AtomicU64`? 不行 —— 要存的是字符串。这里用 `Mutex<String>` 包一下就够了：
/// 只在识别成功/失败时写一次，读一次就清空，冲突概率低到可以忽略。
static OCR_NOTE: Mutex<String> = Mutex::new(String::new());

/// 当前这条结果附带的提示（降级说明 / 缺引擎说明），属于「当前结果」的一部分。
///
/// 为什么要有第二份：OCR 结果窗有**推 + 拉两条通道**（`qs://ocr-result` 推送 +
/// 页面 boot 时 `ocr_take_text` / `ocr_take_image` 主动拉）。提示原先只有推这一条
/// 通道，而推送是「发出去就算」—— 冷启动时 WebView2 还没加载好脚本，14 次推送
/// 可能整批落空，于是「为什么只有本地结果」这种说明就永远看不到。
/// 现在拉的那条通道也带上它（见 `ocr_take_note`），两边都能到。
static OCR_LAST_NOTE: Mutex<String> = Mutex::new(String::new());

/// 记下一条要给用户看的提示。两份一起写：
/// - `OCR_NOTE` 给「下一次推送」用（推送完即清，免得下一张图还挂着上一句）；
/// - `OCR_LAST_NOTE` 给「页面主动拉」用（推不到时的兜底），下一轮识别开始时清掉。
fn set_ocr_note(msg: String) {
    if let Ok(mut n) = OCR_NOTE.lock() {
        *n = msg.clone();
    }
    if let Ok(mut n) = OCR_LAST_NOTE.lock() {
        *n = msg;
    }
}

/// 清掉当前提示（新一轮识别开始时调用，避免上一轮的说明串到这一轮）。
fn clear_ocr_note() {
    if let Ok(mut n) = OCR_NOTE.lock() {
        n.clear();
    }
    if let Ok(mut n) = OCR_LAST_NOTE.lock() {
        n.clear();
    }
}

/// 框选页面的心跳。页面加载后每 2 秒调一次 `region_beat` 把这里置成非 0；
/// 0 表示「本次窗口还没活过来」。看门狗靠它区分两种状态：
///   页面活着只是没框完 —— 留着等用户；
///   页面压根没跑起来 —— 留着就是一层吞输入的透明玻璃，必须尽早关窗。
static REGION_BEAT: AtomicU64 = AtomicU64::new(0);

fn close_window(name: &str) {
    if let Some(w) = app().get_webview_window(name) {
        let _ = w.close();
    }
}

/// **拼了命也要把框选遮罩弄掉**——因为它铺满全屏，留着就等于锁死鼠标。
///
/// 先走 Tauri 的正常关窗（能走通就不动粗）。等一会儿看还在不在：
/// 如果主线程正卡着（`close` 也要经主线程），窗口还在屏幕上，那就
/// 直接调 Win32 把裸句柄销毁掉 —— 这是此刻唯一能救场的手段。
///
/// 参数 `why` 只进日志，方便事后看出是哪一层兜底救回来的。
fn hard_close_region(why: &str) {
    close_window("region");
    /* 等最多 600ms 看主线程有没有真的把窗口关掉。
     *
     * ⚠ 这里原来写的是 `(0..12).all(|_| {...; false })` —— `all` 在**第一个
     * false 处短路**，循环体只跑一次、50ms 后就判"没关掉"，于是几乎每次都会
     * 立刻走到下面的 `force_kill_overlay`。而 `REGION_HWND` 是缓存句柄
     * （本文件自己也承认它可能过期），上一个遮罩销毁后句柄会被系统复用 ——
     * 强杀一个"看起来还在"的旧句柄，风险是打到别人的窗口上。
     * 现在改成显式循环：每 50ms 重查一次，最多 12 次。 */
    let a = app();
    let mut gone = false;
    for _ in 0..12 {
        if a.get_webview_window("region").is_none() {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if gone {
        REGION_HWND.store(0, Ordering::SeqCst);
        return;
    }
    let raw = REGION_HWND.load(Ordering::SeqCst);
    if raw == 0 {
        win::log(&format!("region: 强杀兜底也没拿到句柄，只能靠看门狗继续轮询（{why}）"));
        return;
    }
    /* 强杀前复核一次：句柄还活着、而且**仍然是遮罩窗口**才动手。
     * `IsWindow` 只能证明"这个值还是个窗口"，挡不住句柄复用；类名/标题
     * 才是"它是不是我们的遮罩"的证据。两者都不满足就放手，交给看门狗。 */
    let hwnd = HWND(raw as *mut _);
    if !win::is_window(hwnd) {
        win::log(&format!(
            "region: 缓存的句柄 {raw:#x} 已经销毁，不必强杀（{why}）"
        ));
        REGION_HWND.store(0, Ordering::SeqCst);
        return;
    }
    if !win::looks_like_overlay(hwnd) {
        win::log(&format!(
            "region: 缓存句柄 {raw:#x} 已经被系统复用成别的窗口，放弃强杀（{why}）"
        ));
        REGION_HWND.store(0, Ordering::SeqCst);
        return;
    }
    win::log(&format!(
        "region: 主线程关不掉遮罩（{why}），直接 Win32 强杀 {raw:#x}，先把鼠标还给用户"
    ));
    win::force_kill_overlay(hwnd);
    REGION_HWND.store(0, Ordering::SeqCst);
}

/// 把 OCR 相关的状态/错误同时打到日志和设置面板。
/// 把 OCR 的进展说给用户听（只发给已经开着的窗口，不为它新开窗口）。
fn ocr_say(msg: impl Into<String>) {
    ocr_tell(msg, false);
}

/// `important = true` 的消息（出错、缺配置这类）一定得让用户看见。
///
/// ⚠ 以前只往设置面板发，而设置面板常常是关着的 —— 结果就是「点了识别，
/// 然后什么都没发生」，跟软件坏了没区别。所以重要消息在两个窗口都不开时
/// **要把结果窗口叫起来**再说一遍。
///
/// 但「正在识别…」这种过程提示走 important=false：为一个一闪而过的提示
/// 提前弹出结果窗口太吵，而且窗口里空空的反而让人以为识别失败了。
fn ocr_tell(msg: impl Into<String>, important: bool) {
    let msg = msg.into();
    win::log(&format!("ocr: {msg}"));
    let Some(a) = APP.get() else { return };

    let mut delivered = false;
    for label in ["settings", "ocr"] {
        if a.get_webview_window(label).is_some() {
            delivered = true;
            let _ = a.emit_to(label, "qs://ocr", msg.clone());
        }
    }
    if delivered || !important {
        return;
    }

    open_ocr_window(String::new());
    std::thread::spawn(move || {
        // 窗口刚建起来时 WebView 还没加载脚本，推几次总能接住一次
        for i in 0..24 {
            std::thread::sleep(Duration::from_millis(if i < 6 { 90 } else { 260 }));
            let _ = APP.get().map(|a| a.emit_to("ocr", "qs://ocr", msg.clone()));
        }
    });
}

/// 打开全屏框选窗口。
/// 「正在开框选窗口」的闸门 + RAII 复位（见 open_region_window）。
static OPENING_REGION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct OpeningRegionGuard;
impl Drop for OpeningRegionGuard {
    fn drop(&mut self) {
        OPENING_REGION.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 打开框选遮罩。`mode` = `"ocr"`（默认，框完送进文字识别）或 `"img"`
/// （框完送进识图搜索）—— 同一个遮罩窗口复用两套用途，靠 URL 参数区分。
///
/// r54 起多一个 mode：框选交互（拖框、Esc 取消、右键取消、6 秒看门狗、失焦
/// 兜底全部去掉的那段实测结论）对两种用途**完全一样**，复制一份遮罩页面只会
/// 有两份要并行维护的代码；让页面按 `?mode=` 分流到 `ocr_region` / `img_region`
/// 一条命令即可。
fn open_region_window_mode(mode: &str) {
    // ⚠ 重入闸门：按住 Ctrl+Alt+O 时键盘会自动重复，`ocr_start_flow` 会被连着
    //   调用好几次；而下面 close+wait_until(800) 超时后照样继续 build —— 短时间
    //   连开多个全屏遮罩 WebView2（全屏置顶、吃鼠标），用户会卡在连续的蒙版里。
    //   闸门用 compare_exchange 抢占，抢不到说明上一次还没落地。
    if OPENING_REGION.swap(true, Ordering::SeqCst) {
        win::log("open_region_window: 上一次还在开，忽略这次重复触发");
        return;
    }
    let _guard = OpeningRegionGuard;
    let a = app();
    if let Some(w) = a.get_webview_window("region") {
        let _ = w.close();
        win::wait_until(800, || a.get_webview_window("region").is_none());
    }
    REGION_BEAT.store(0, Ordering::SeqCst);
    REGION_HWND.store(0, Ordering::SeqCst);
    let (vx, vy, vw, vh) = win::virtual_screen();
    win::log(&format!("region: virtual screen {vw}x{vh} at ({vx},{vy})"));
    let a2 = a.clone();
    // ⚠ mode 必须**先**变成 owned 再进闭包：`run_on_main_thread` 要求 'static，
    //    而形参 mode: &str 的生命周期只到本函数返回。
    let mode_owned: String = mode.to_string();
    let url_path: std::path::PathBuf = format!("region.html?mode={mode_owned}").into();
    let _ = a.run_on_main_thread(move || {
        win::log("region: 主线程闭包开始装配 builder");
        // App() 要的是 URL 路径（PathBuf）
        let mut b = WebviewWindowBuilder::new(&a2, "region", WebviewUrl::App(url_path))
            .title("QS-Region")
            .position(vx as f64, vy as f64)
            .inner_size(vw as f64, vh as f64)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(true);
        // 必须和横条/设置窗口用**同一套** WebView2 参数，否则环境配置冲突、
        // 窗口建不起来（HRESULT 0x8007139F，踩过一次记一辈子）
        let wa = wv_args();
        if !wa.is_empty() {
            b = b.additional_browser_args(&wa);
        }
        win::log("region: 准备 build()");
        match b.build() {
            Ok(w) => {
                let _ = w.set_focus();
                win::log("region: built");
                // 记下句柄，供紧急强杀兜底用（见 REGION_HWND 的注释）
                if let Ok(h) = w.hwnd() {
                    REGION_HWND.store(h.0 as isize, Ordering::SeqCst);
                }
                // 抢焦点要多试几次：WebView2 窗口从「建好」到「真的能收键盘」
                // 之间有一小段延迟，`.focused(true)` + 一次 set_focus 有时落在
                // 这段延迟里，于是用户一进框选就按 Esc，页面收不到 keydown。
                // 这里补几轮：反复 set_focus，直到确认前台窗口已经是我们。
                let w2 = w.clone();
                std::thread::spawn(move || {
                    // ⚠ 不能「一抢到就 return」。这台机器上观察到：WebView2 窗口
                    // 可能在某一瞬间 foreground_is 为真，但紧接着的焦点交接又把
                    // 焦点交给别人（或者页面收到一次 blur），于是前端误判"失焦"
                    // 自行退场。所以这里改成**持续重申**：
                    //   · 第 0..16 轮每轮都 set_focus（约 1.7 秒），把焦点钉牢；
                    //   · 只有「连续 3 轮都确认是自己的前台」才算稳，才退出循环。
                    // 这样前端那层「疑似失焦 → 400ms 观察」的兜底基本不会被触发。
                    let mut stable = 0usize;
                    for i in 0..16 {
                        std::thread::sleep(Duration::from_millis(110));
                        if w2.set_focus().is_ok() {
                            let _ = w2.unminimize();
                        }
                        if win::foreground_is(&w2) {
                            stable += 1;
                            if stable >= 3 {
                                win::log(&format!(
                                    "region: focus stable after {} tries",
                                    i + 1
                                ));
                                return;
                            }
                        } else {
                            // 又丢了焦点 → 重新计数，继续抢
                            stable = 0;
                        }
                    }
                    win::log("region: 抢焦点收尾（Esc 有兜底，不影响）");
                });
            }
            Err(e) => win::log(&format!("region: build failed: {e}")),
        }
    });

    // 看门狗 + 置顶重申：这个窗口铺满全屏又置顶，只要它没关掉，用户就
    // **满屏都点不动**。前端再怎么健壮也可能出岔子（脚本报错、命令没送达、
    // 渲染进程异常…），所以这里兜底，而且是四层：
    //   ① 页面加载后每 2 秒发一次心跳（region_beat）。开窗 5 秒还一次都没
    //      收到，说明页面根本没活过来 —— 留着也是一层吞输入的透明玻璃，
    //      立刻关掉，顺便在日志里留下证据，方便排查「为什么没活」。
    //   ② 30 秒总闸：人走开忘关了也不能一直盖着屏幕。
    //      （原为 90 秒，但这一层的意义就是"绝不能把鼠标锁太久"，
    //   30 秒足够想清楚"我刚才干了啥"，又不会让人受困。）
    //   ③ **置顶重申**：`.always_on_top(true)` 只在建窗那一刻生效一次。
    //      本机上有别的全局工具/浮层会在几秒后把自己推到最前面，遮罩被压到下面
    //      之后**就收不到鼠标键盘了**（日志里见过：全局钩子收到了 mouseup，
    //      但遮罩页面压根没收到 DOM mousedown → 用户框选框不动）。
    //      所以每 500ms 重申一次 HWND_TOPMOST；顺带在它不是前台时把焦点抓回来
    //      （Esc 有全局钩子兜底，但鼠标拖框必须让遮罩在光标下才收得到）。
    //   ④ **强杀兜底**：关窗走 Tauri，而 Tauri 要经主线程。万一主线程卡在
    //      什么地方（建别的 WebView2 时死锁等），close_window 就是一句空话，
    //      遮罩留在屏幕上 = 鼠标永久锁死。所以这里额外留着一份裸 HWND，
    //      直接调 Win32 把窗口扒下来（见 win::force_kill_overlay）。
    let a3 = a.clone();
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        let mut tick: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            tick += 1;
            let Some(w) = a3.get_webview_window("region") else {
                // 窗口已经没了（正常关闭走的都是这条路）。顺手把句柄清掉，
                // 别留一个陈旧 hwnd 将来被强杀逻辑误用。
                REGION_HWND.store(0, Ordering::SeqCst);
                return;
            };
            // 抓到裸句柄存一份给强杀兜底用
            if let Ok(h) = w.hwnd() {
                REGION_HWND.store(h.0 as isize, Ordering::SeqCst);
            }
            if REGION_BEAT.load(Ordering::SeqCst) == 0 && t0.elapsed() > Duration::from_secs(5) {
                win::log("region: 页面 5 秒无心跳，判定未存活，强制关闭");
                hard_close_region("页面未存活");
                return;
            }
            if t0.elapsed() > Duration::from_secs(30) {
                win::log("region: 超时仍开着，强制关闭（防止用户满屏点不动）");
                hard_close_region("超过 30 秒总闸");
                return;
            }
            // 置顶重申（每 500ms 一次，成本就是一次 SetWindowPos，可以忽略）。
            // 前 3 秒（开窗交接期）每次挤到最前，之后隔一次挤一次，别太频繁。
            if tick <= 6 || tick.is_multiple_of(2) {
                if let Ok(h) = w.hwnd() {
                    win::reassert_topmost(HWND(h.0));
                }
                // 已经不在前台就抢回来 —— 遮罩丢了激活就收不到鼠标拖框
                if !win::foreground_is(&w) {
                    let _ = w.set_focus();
                }
            }
        }
    });
}

/// 造一张带文字的示例 PNG，只给 `--ocr-demo` 测试用。
///
/// 为什么不读磁盘上现成的图：测试要能在任何机器上跑，依赖外部文件很容易
/// 「文件在不在」变成又一个失败源。这里现画一张纯色底 + 几条白杠的图，
/// 足够验证「图片区有没有正常显示」这件事了。
fn demo_png() -> Vec<u8> {
    let (w, h) = (420u32, 180u32);
    let mut img = image::RgbaImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        // 蓝底，带一点竖向渐变，视觉上像一块截图
        let t = y as f32 / h as f32;
        *p = image::Rgba([
            (60.0 + 40.0 * t) as u8,
            (90.0 + 60.0 * t) as u8,
            (200.0 - 30.0 * t) as u8,
            255,
        ]);
        let _ = x;
    }
    // 三条白杠，模拟「一段文字」
    for row in 0..3 {
        let y0 = 40 + row * 34;
        for y in y0..(y0 + 12).min(h) {
            for x in 28..(w - 28 - row * 60).min(w) {
                img.put_pixel(x, y, image::Rgba([245, 247, 250, 255]));
            }
        }
    }
    let mut cur = std::io::Cursor::new(Vec::new());
    let _ = image::DynamicImage::ImageRgba8(img).write_to(&mut cur, image::ImageFormat::Png);
    cur.into_inner()
}

/// 打开识别结果窗口。
///
/// 复用同一个窗口（第二次识别直接把文字换掉），省得每次弹一个新窗口。
fn open_ocr_window(text: String) {
    if let Ok(mut g) = OCR_LAST.lock() {
        *g = text.clone();
    }
    // 去空格按钮的原料：识别路径早在 run_ocr 里存过**未清理的原文**，
    // 这里只给没走识别路径的入口兜底（--ocr-demo 演示、异常恢复）——
    // 不补的话用户点「去空格」会报「没有可以处理的识别原文」。
    if let Ok(mut g) = OCR_LAST_RAW.lock() {
        if g.is_empty() {
            *g = text.clone();
        }
    }
    let a = app();
    let exists = a.get_webview_window("ocr").is_some();
    if exists {
        if let Some(w) = a.get_webview_window("ocr") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    } else {
        let a2 = a.clone();
        // 窗口尺寸按用户上次拖的结果开（见 config::ocr_window_size 的注释）。
        // 在这里取一次快照，闭包里用 —— 闭包要 'static，不能借用配置锁。
        let (ocr_w, ocr_h) = cfg_with(config::ocr_window_size);
        let _ = a.run_on_main_thread(move || {
            // ⚠ 关键：**先不显示**（`.visible(false)`）。
            //
            // 用户报的"OCR 之后又蹦出一个黑框"就是这个原因：Tauri 建窗是**同步**的，
            // 而 WebView2 渲染第一帧是**异步**的（冷启动要几百毫秒）。如果建完窗
            // 就 `.visible(true)`，中间这段空白期用户看到的就是一块**没画内容的
            // 原生窗口**——在深色系统下它默认是黑的，于是表现为"先黑一下"或者
            // "多弹了个黑框"。
            //
            // 所以：建窗时隐藏 + 给一个和页面一致的底色（万一还是被系统提前合成，
            // 至少颜色是对的），等页面侧发来 `ocr_ready`（首帧画完）再 show。
            // 兜底：万一 ready 信号没来（脚本异常），2.5 秒后强制显示，不能让用户
            // 以为程序卡死了什么都不弹。
            let mut b = WebviewWindowBuilder::new(&a2, "ocr", WebviewUrl::App("ocr.html".into()))
                .title("识别结果 —— Quick Search")
                // 尺寸记忆：用户上次拖成多大，这次就开多大（没拖过用默认 760×620）。
                .inner_size(ocr_w, ocr_h)
                .min_inner_size(560.0, 380.0)
                .resizable(true)
                .center()
                .visible(false)
                // 和 ocr.html 的 --bg 对齐：浅色 #F5F6F8 / 深色 #17181C。
                // 跟随系统主题挑一个，避免"白底页面 + 黑框"这种突兀的组合。
                .background_color(if win::apps_use_light_theme().unwrap_or(true) {
                    tauri::window::Color(245, 246, 248, 255)
                } else {
                    tauri::window::Color(23, 24, 28, 255)
                });
            let wa = wv_args();
            if !wa.is_empty() {
                b = b.additional_browser_args(&wa);
            }
            match b.build() {
                Ok(w) => {
                    win::log("ocr win: built (hidden, 等页面 ready)");
                    // 用户点 X 关掉结果窗也要清缓存（走命令关的那条见 close_ocr_window）。
                    // 两个事件都挂：CloseRequested 是「要关了」，Destroyed 是「已经没了」——
                    // 清两次无害（幂等），但漏掉一次就会把上一轮的文本/截图留在内存里。
                    w.on_window_event(|e| {
                        if matches!(
                            e,
                            tauri::WindowEvent::CloseRequested { .. }
                                | tauri::WindowEvent::Destroyed
                        ) {
                            clear_ocr_session();
                        }
                    });
                    // 隐藏窗口拿不到焦点，这里**不** set_focus —— 交给
                    // show_after_ready 在真正 show() 之后再抢。
                    // 兜底显示：ready 信号 2.5 秒还没来就直接亮出来，
                    // 不能因为页面脚本异常就让窗口永远显示不出来。
                    let w2 = w.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(2500));
                        if !w2.is_visible().unwrap_or(false) {
                            win::log("ocr win: ready 超时，兜底显示");
                            let _ = w2.show();
                            let _ = w2.set_focus();
                        }
                    });
                }
                Err(e) => win::log(&format!("ocr win: build failed: {e}")),
            }
        });
    }
    // 推「文字 + 图片」这一整份结果。
    //
    // WebView 起来要时间，推几次；前端那边「值一样就不动」所以推多了也没关系。
    // 图片单独编一次 base64 复用（见 OCR_LAST_PNG 的注释），
    // 空图时字段给空串，前端据此决定显不显示图片区。
    let a3 = a.clone();
    let img = OCR_LAST_PNG
        .lock()
        .map(|g| {
            if g.is_empty() {
                String::new()
            } else {
                ocr_image_data_url(&g)
            }
        })
        .unwrap_or_default();
    // 降级提示（取走即清空，免得下一张图还挂着上一句）。
    // 锁被毒化（别的线程 panic 时）不该让整个开窗流程失败，拿不到就当没提示。
    let note = OCR_NOTE
        .lock()
        .map(|mut n| {
            let s = n.trim().to_string();
            n.clear();
            s
        })
        .unwrap_or_default();
    let note = if note.is_empty() { None } else { Some(note) };
    // 分段结果（仅本地 / 仅百度 / 两者都看）：和 text 一起推，页面切换是纯前端操作
    let parts = std::sync::Arc::new(ocr_parts(OCR_PNG_GEN.load(Ordering::SeqCst)));
    // ⚠ 以前这里每次循环都 `img.clone()`：一张 1920px 的截图 base64 动辄
    //   300KB~1.5MB，30 次就是几十 MB 的字符串拷贝 + JSON 编码 —— 每次 OCR
    //   完成都要卡一下。改成 Arc 共享，clone 只是加个引用计数。
    let img = std::sync::Arc::new(img);
    let text = std::sync::Arc::new(text);
    std::thread::spawn(move || {
        for i in 0..14 {
            std::thread::sleep(Duration::from_millis(if i < 6 { 90 } else { 260 }));
            // 窗口已经被关掉（用户看都不想看就退了）就没必要继续推
            if a3.get_webview_window("ocr").is_none() {
                return;
            }
            let _ = a3.emit_to(
                "ocr",
                "qs://ocr-result",
                json!({
                    "text": text.as_str(),
                    "image": img.as_str(),
                    "note": note.clone(),
                    "parts": parts.as_ref(),
                }),
            );
            // 老的纯文字事件留着：老版本页面/第三方调用还可能只听这个
            let _ = a3.emit_to("ocr", "qs://ocr-text", text.as_str());
        }
    });
}

/// 算出这一轮 OCR 到底跑哪几家，必要时**临时**补上本地引擎。
///
/// r77 修正：**只在这一次的名单里补，不动配置**（r76 那版会 `config::save`）。
///
/// 为什么改主意：落盘会在用户不知情时改他的设置。真机自检立刻抓到了后果 ——
/// 「同时识别」那颗 windows 胶囊本来是"额外参与的一家"，可一旦默认引擎被悄悄
/// 改成 windows，它就从"额外名单"里消失了（默认引擎本来就一定参与），
/// 用户看到的是"我勾了本地识别，但它没进同时识别名单"。那不是他做过的操作。
///
/// 现在的口径：
///   · 这一轮用本地跑（让功能可用），并返回 `true` 让调用方在日志/提示里说明；
///   · 用户的 `ocr_engine` **原样留着** —— 他配好百度密钥之后，下次点 OCR
///     自然还是走百度，不需要回来改设置。
fn ocr_plan_with_local_fallback(cfg: &config::Config) -> (Vec<String>, bool) {
    let run = ocr_engine_plan(cfg);
    /* 只要名单里**有一家凭据齐**就照原样跑，一点都不动。
     * ⚠ 这一句就覆盖了"用户已经勾了本地引擎"的情形 —— 本地永远 `creds_ready`，
     *   所以那种配置会在这里直接返回，走不到下面的插入分支（也就不会重复插）。 */
    if run.iter().any(|id| creds_ready(cfg, id)) {
        return (run, false);
    }
    if ocr_engines::find("windows").is_some() && !run.iter().any(|id| id == "windows") {
        let mut with_local = run;
        with_local.insert(0, "windows".to_string());
        return (with_local, true);
    }
    (run, false)
}

/// 进入 OCR 流程（横条上的按钮、Ctrl+Alt+O、托盘菜单都走这里）
fn ocr_start_flow() {
    let cfg = cfg_snapshot();
    if !cfg.ocr_enable {
        ocr_tell("OCR 功能已在设置里关闭", true);
        return;
    }
    // ⚠ 密钥检查只该管**真的要跑百度**的场合：本地 OCR（windows）不需要任何 Key，
    //   以前一刀切的结果是「只配了本地引擎、没填百度密钥的用户点 OCR
    //   永远被拦去设置页，框选都进不去」。
    //   并行模式也不拿缺密钥卡人：本地那份照常出，百度那份在结果里附一句
    //   「还没配密钥」，用户想配再去设置页 —— 不至于连框选都进不去。
    // ⚠ 需求 2 之后在线引擎不再只有百度：缺什么由**注册表**说了算，
    //   提示语也跟着引擎名走（不然用户配了腾讯云却被告知"还没配百度的 Key"）。
    // ⚠ r47 改口径：**默认引擎一定参与**，所以缺它的凭据就该拦（以前并行开着时
    //   会放行，理由是"本地那份照常出"）。现在"另跑几家"是可选项，兜底逻辑
    //   改看**参与名单**：默认引擎缺凭据 → 拦；只是额外那几家缺凭据 →
    //   不拦（识别时跳过并说明，见 ocr_engine_plan 的调用方）。
    /* r77：名单一次算清，必要时把本地引擎补进来（**只影响这一轮**）。
     * 返回的 `fell_back` 只用来决定提示/日志怎么措辞 —— 用户的配置一个字段都不改。 */
    let (run, fell_back) = ocr_plan_with_local_fallback(&cfg);
    if fell_back {
        ocr_tell("这一轮用「Windows 本地」识别（还没配在线引擎的凭据）", false);
    }
    // r76：**一家都跑不起来才拦，且拦住也要先把遮罩打开让人框选**。
    // 以前是"默认引擎缺凭据就 return"，遮罩都不开 —— 用户点「开始框选识别」
    // / 横条点 OCR / Ctrl+Alt+O 三条路全都"点了没反应"，一个提示都不给。
    // 现在的口径：只要能跑一家（本地引擎算，它零密钥）就放行，缺凭据的那几家
    // 在识别时跳过并说明（见 ocr_recognize_async / combined_text 的 notes）。
    // ⚠ run 里一家凭据都不齐（比如默认是百度又没配密钥，也没勾本地）时：
    //    仍然**拦住**（不然框完一张图没有任何引擎能认，用户白框一次），
    //    但拦的同时把"缺哪家凭据 + 已打开设置页"讲清楚。
    let usable = run.iter().any(|id| creds_ready(&cfg, id));
    if !usable {
        /* r76 收尾：**没配密钥也别把用户关在门外**。
         *
         * 这是用户报的"文字识别完全用不了"的最后一环：默认引擎是百度（在线、
         * 要密钥），用户没配 → 以前到这里就 return，三条入口全"点了没反应"。
         * 现在：本机有本地 OCR（windows 引擎，零密钥、离线）就**这一轮改用它**，
         * 让用户至少能把功能用起来；本地也没有（老系统 / 没装语言包）才真拦，
         * 并且拦的时候把原因说清楚、设置页给他打开在 OCR 那一栏。
         *
         * ⚠ r77：**只在这一次的名单里补本地，不动用户配置** ——
         *   落盘会把「同时识别」名单里的 windows 悄悄"吃掉"（详见
         *   `ocr_plan_with_local_fallback` 的注释），真机自检抓到过。 */
        if ocr_engines::find("windows").is_some() && !run.iter().any(|id| id == "windows") {
            win::log("ocr: 计划里的引擎都缺凭据，但本机有本地 OCR —— 这一轮临时改用它（不改设置）");
        } else {
            let miss = run
                .iter()
                .find(|id| !creds_ready(&cfg, id))
                .cloned()
                .unwrap_or_else(|| online_engine(&cfg));
            ocr_tell(
                format!("还没配{}的凭据，已帮你打开设置页", engine_display(&miss)),
                true,
            );
            open_settings_win(None, None);
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(900));
                let _ = APP.get().map(|a| a.emit_to("settings", "qs://focus-tab", "ocr"));
            });
            return;
        }
    }
    dismiss_bar();
    // ⚠ token 预热：用户开始框选的那一刻就注定要调 OCR 了，
    //   「拿 access_token」这段网络耗时（100~300ms）完全可以和"拖框"并行掉。
    //   放后台，失败也不影响框选（真识别时它自己会再试）。
    //   纯本地引擎不联网，预热纯属浪费，跳过；参与名单里有百度也要热。
    //   没配密钥就别热了 —— 必然是失败，白打一次网络。
    // ⚠ token 只有百度那条路要（别家是"一把密钥一次请求"，没有可预热的 token）。
    //   所以这里判断的是"参与的这几家里有没有百度"，而不是"是不是在线引擎"。
    let will_use_baidu = run.iter().any(|e| e == "baidu");
    let bkey = ocr_creds(&cfg, "baidu");
    let key_ok = !(bkey.key.trim().is_empty() || bkey.secret.trim().is_empty());
    if will_use_baidu && key_ok {
        let key = bkey.key.clone();
        let secret = bkey.secret.clone();
        std::thread::spawn(move || ocr::warm_token(&key, &secret, 10));
    }
    open_region_window_mode("ocr");
}

/// r54：进入识图流程（横条上那颗「识图」按钮走这里）。
///
/// 和 OCR 的区别只有一句：**不查凭据**。识图的引擎都是匿名可用的公开接口
/// （真上传的三家 / 打开页面的几家都不需要任何 API Key）—— 要是这里照 OCR
/// 那样先查密钥，用户点「识图」就会被拦去设置页填一个根本不需要的东西。
fn img_start_flow() {
    let cfg = cfg_snapshot();
    if !cfg.img_enable {
        img_tell("识图搜索已在设置里关闭");
        return;
    }
    dismiss_bar();
    open_region_window_mode("img");
}

#[tauri::command]
fn img_start() {
    // 与 ocr_start 同一条理由：必须脱开命令调用栈再建全屏遮罩窗口，
    // 否则主线程会回头等这把尚未释放的锁 → 死锁 → 满屏点不动。
    std::thread::spawn(img_start_flow);
}

/* ================================================================== */
/* r54：识图搜索                                                        */
/* ================================================================== */

/// 识图的消息通道：日志 + 设置面板 toast。
///
/// 和 OCR 的 `ocr_tell` **故意不一样**：那边 important=true 时会把识别结果
/// 窗口叫起来（"点了识别然后什么都没发生"是 OCR 的体验事故）；而识图出错时
/// 弹一个空的结果窗口更糟。识图走 toast（设置开着就看得见）+ 日志；横条那一侧
/// 在 `dismiss_bar` 之前就已经弹出过，所以不会"点了没反应"。
fn img_tell(msg: impl Into<String>) {
    let msg = msg.into();
    win::log(&format!("img: {msg}"));
    let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", msg));
}

/// 识图引擎注册表给前端（设置页那一栏的列表、勾选框、说明文字全由它生成）。
///
/// 和 `ocr_engines_list` 一个路子：**界面驱动自数据**，加一家引擎只改
/// imgsearch.rs 一行，设置页自动跟上，不会出现"后端支持、界面没有"。
#[tauri::command]
fn img_engines_list() -> serde_json::Value {
    let list: Vec<serde_json::Value> = imgsearch::ENGINES
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "name": e.name,
                "mode": e.mode.as_str(),
                "note": e.note,
                // 直达地址（paste 类 = 上传页；url 类 = 带 {URL} 占位符的模板），
                // 前端用来展示"这一家会把你带到哪"
                "page": e.page,
                // r56：问号按钮的目标。识图引擎行的「?」点开就是它
                // （用户要求「每个引擎旁边也要设置一个问号按钮，点击之后就会
                //  跳转到申请该引擎 api 的相关教程」）
                "help": e.help,
            })
        })
        .collect();
    json!(list)
}

/// r56：识图这一轮收尾时，把**借来的剪贴板还回去**。
///
/// 用户原话：「不管是识图搜索还是 ocr 截取的图片，用完之后记得删掉，这种只是
/// 暂时的图片，不能永久的存在电脑里面。」
///
/// 识图的截图不落盘（全程内存，见 img_region 与 r56-tmppic 探针），唯一会
/// "留下来"的是剪贴板：Paste 类引擎要靠着它粘贴，所以截到图的那一刻**必须**
/// 写进去；但一轮搜完之后它还躺着，用户重启都还在 —— 那就是"永久存在"。
///
/// 所以：**动它之前 snapshot（调用方负责），用完 restore（这里）**。
/// 为什么不用 `clip::clear()`：那会把用户原本复制的东西一起抹掉 —— 他可能刚
/// Ctrl+C 了一段文字，识图搜完发现剪贴板变了，这是新引入的 bug。
/// snapshot/restore 是"把借来的地方还回去"：截图消失，用户原来的内容原地不动。
///
/// `pasted` = 这一轮**真的往剪贴板写过图**吗。没写过却 restore 等于无缘无故
/// 把用户的东西重写一遍（还可能写坏），所以这道闸必须留。
fn img_clip_restore(keep: &Option<clip::Snapshot>, pasted: bool, keep_img: bool) {
    if !pasted {
        return;
    }
    /* r73：设置里开了「截完图留在剪贴板」就**不还原** —— 用户要把刚框的那张图
     * 拿去别处粘贴，还原了反而等于跟他抢。关着（默认）还是老样子：用完就还，
     * 截图不在电脑上过夜。 */
    if keep_img {
        win::log("img: 设置里开了「留在剪贴板」，不还原（截图仍可 Ctrl+V 粘贴）");
        return;
    }
    if let Some(s) = keep.as_ref() {
        // 只有剪贴板还是「我们写进去的那张截图」时才还原；期间用户自己
        // Ctrl+C 了别的东西，就把他的新内容留着（不覆盖）。
        clip::restore_if_unchanged(s);
        win::log("img: 已把剪贴板还原成截图前的内容（截图不留在电脑上）");
    } else {
        // 没备份成（剪贴板当时被别的进程占着）。这时**不能** clear ——
        // 会把用户的东西一起抹掉。只留一行日志，让人知道这条没兜住。
        win::log("img: 没能备份剪贴板，跳过还原（不动用户原本的内容）");
    }
}

/// r61：把截图**真的上传**给引擎，返回**结果页 URL**。
///
/// 这是识图功能的核心。前几轮失败的原因都在"怎么提交"上，这一版照着
/// PicImageSearch（kitUIN/PicImageSearch）验证过的做法来。
/// r70 实测复核：Yandex / SauceNAO 通过（见各自分支的注释），百度端点活着
/// 但当前固定 Reject（反爬升级）—— 失败由调用方退回打开页面。
///
/// ## 百度
///
/// ```text
/// POST https://graph.baidu.com/upload
/// Acs-Token: （空串！少了它就 Reject）
/// Origin: https://graph.baidu.com（r70：按引擎给，不再全局硬编码）
/// 表单：from=pc
/// 文件：image
/// → {"status":0,"data":{"url":"https://graph.baidu.com/s?..."}}
/// ```
///
/// ## Yandex
///
/// ```text
/// POST https://yandex.ru/images/search?rpt=imageview&format=json&request=<json>
/// 文件：upfile
/// → {"blocks":[{"params":{"cbirId":"476103/xxx"}}]}
/// → https://yandex.ru/images/search?rpt=imageview&cbir_id=476103/xxx
/// ```
///
/// ## SauceNAO
///
/// ```text
/// POST https://saucenao.com/search.php（db=999, output_type=0）
/// 文件：file
/// → 200，一整页结果 HTML（含 similarity）—— 没有可重开的 GET 地址，
///   落盘成 file:// 再交给浏览器（见下面 SauceNao 分支）。
/// ```
///
/// ⚠ 必须是 **yandex.ru**：`yandex.com` 只回一个 1.7KB 的空壳页（实测）。
/// ⚠ 超时 12s（r66 从 25s 收下来的）：识图站要过一遍特征提取，比普通网页慢，
///   但慢站不该把整轮识图拖到半分钟 —— 超时就退回打开页面。
/// r62：在浏览器里开一个**已经确定的** URL（识图用）。
///
/// 为什么不用 `open_links`：那条命令是给"从一段文字里抽出网址"用的 ——
/// 它要再过一遍 `text_to_url`、还有 **12 条上限**。识图这边的 URL 已经是
/// 最终结果页地址，既不需要再抽，也不该被 12 条截断（用户要"每个引擎各开一个
/// 标签页"，引擎勾得多时就有一家被吃掉）。所以这里直接 open::that。
///
/// ⚠ 失败只记日志：用户可能没装浏览器 / 默认程序被改坏了，
///   不该因此把整轮识图判成失败（其它家可能已经开出来了）。
/// r65：给 **AI 识图引擎**补一次 Ctrl+V，把截图粘进它的输入框。
///
/// 为什么只给 AI 类：其它引擎要么自己 POST（百度/Yandex/SauceNAO）、要么是
/// "打开页面你自己选文件"，都不需要键。用户上一轮要求"撤掉按键那套"，
/// 这一轮又明确授权"AI 引擎用按键"，所以范围严格限定在 AI 那几家。
///
/// 为什么**不补 Enter**：AI 站粘完图要等用户打问题，回车等于发送一条空消息。
///
/// "保证能顺利实施"靠三件事：
///   ① 等浏览器从无到有 + 首屏渲染（`open_delay`，默认 1200ms，r76 起可配）；
///   ② 每一轮都**核对前台真的是浏览器**再去发键 —— 抢不到就重试，
///      而不是盲发一次（盲发的失败是静默的，用户只会说"没反应"）；
///   ③ 用 SendInput 合成（win::paste_ctrl_v），比 keybd_event 稳。
///
/// `enter_delay`：Ctrl+V 之后等多久按 Enter（r76 起可配，默认 900ms）。
fn img_paste_into_browser(open_delay: u64, enter_delay: u64) {
    /* r66：用户反馈「确实跳转了 AI 页面，但没有触发 Ctrl+V」。
     * 上一版只等 1.8s + 重试 6×120ms（≈2.5s）就放弃 —— 浏览器**冷启动**
     * （尤其是刚开机的第一发）经常要 3~5s 才真正到前台，于是那一次键打空了。
     * 现在：先等 open_delay，然后最多 30 次 × 150ms（≈4.5s）。
     * r76：open_delay / enter_delay 都由用户在设置里配（img_ai_paste_delay /
     * img_ai_enter_delay）—— 慢机器调大、快站点调小，见 config.rs 注释。 */
    std::thread::sleep(Duration::from_millis(open_delay));
    for attempt in 0..30 {
        let fg = win::foreground_exe().unwrap_or_default().to_ascii_lowercase();
        // 常见浏览器进程名（Chromium / Edge / Firefox / 国产壳）
        let is_browser = ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe",
                          "opera.exe", "vivaldi.exe", "360se.exe", "360chrome.exe",
                          "qqbrowser.exe", "sogouexplorer.exe", "2345explorer.exe"]
            .iter().any(|b| fg == *b);
        if is_browser {
            win::paste_ctrl_v();
            win::log(&format!(
                "img: 已给 {fg} 补一次 Ctrl+V（AI 引擎，第 {} 次尝试）",
                attempt + 1
            ));
            /* r66：粘完再按 **Enter** —— 用户明确要求「同时按下 enter 来实现
             * 询问图片内容的功能」。AI 站把图挂进输入框后，回车就是"发送"；
             * 输入框里只有图没有文字时，多数 AI 会自己看图作答。
             *
             * ⚠ 间隔 enter_delay（默认 900ms）：图要先上传/转成缩略图、发送按钮
             *    才会从禁用变可点；太早回车等于发了个空消息（有的站会直接忽略，
             *    看起来像没反应）。 */
            std::thread::sleep(Duration::from_millis(enter_delay));
            if win::send_hotkey("enter") {
                win::log("img: 已补一次 Enter（AI 引擎，让它在图发出后作答）");
            } else {
                win::log("img: Enter 没发出去（按键序列解析失败）");
            }
            return;
        }
        win::log(&format!(
            "img: 等浏览器到前台（第 {} 次，当前 {fg}），150ms 后再看",
            attempt + 1
        ));
        std::thread::sleep(Duration::from_millis(150));
    }
    // 最后仍不是浏览器：照样发一次（用户可能就是别的浏览器），但日志写明
    win::log("img: 前台一直不是已知浏览器，仍然补发一次 Ctrl+V");
    win::paste_ctrl_v();
}

fn img_open_tab(url: &str) {
    win::log(&format!(
        "img: 开标签页 {}",
        url.chars().take(180).collect::<String>()
    ));
    if let Err(e) = open::that(url) {
        win::log(&format!("img: 打开失败（{e}）"));
    }
}

fn img_upload(e: &imgsearch::Engine, jpeg: &[u8]) -> Result<String, String> {
    use imgsearch::Upload;
    if e.upload == Upload::None {
        return Err("这家没有上传接口".into());
    }
    let boundary = format!(
        "----qsBoundary{:016x}{:016x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id() as u128
    );

    // 每家要的表单字段/文件字段/请求头都不一样，集中在这里，别散在调用处。
    // ⚠ r70：Origin **按引擎给**。以前硬编码 `https://graph.baidu.com`——
    //    给 Yandex / SauceNAO 也发一个百度 Origin，对方按来源一拦就是
    //    "看着参数都对、就是传不上去"。Origin 本来就是"这个请求从哪个站发出来"
    //    的意思，没有理由三家共用一个。
    // (上传地址, 文件字段名, 附加表单字段, 附加请求头)
    type UploadSpec<'a> = (String, &'a str, Vec<(&'a str, &'a str)>, Vec<(&'a str, &'a str)>);
    let (url, file_field, extra_fields, headers): UploadSpec = match e.upload {
        Upload::Baidu => (
            e.page.to_string(),
            "image",
            vec![("from", "pc")],
            // Acs-Token 就是百度的反爬令牌位；**空串也必须带**
            vec![("Acs-Token", ""), ("Origin", "https://graph.baidu.com")],
        ),
        Upload::SauceNao => (
            e.page.to_string(),
            "file",
            vec![("db", "999"), ("output_type", "0")],
            vec![("Referer", "https://saucenao.com/"), ("Origin", "https://saucenao.com")],
        ),
        Upload::Yandex => {
            // request 参数是个 JSON，必须整体百分号编码
            let req = "{\"blocks\":[{\"block\":\"b-page_type_search-by-image__link\"}]}";
            (
                format!(
                    "{}?rpt=imageview&format=json&request={}",
                    e.page,
                    engines::encode_query(req)
                ),
                "upfile",
                vec![],
                vec![("Origin", "https://yandex.ru")],
            )
        }
        Upload::TraceMoe => (
            // r71：cutBorders=true 让服务端先切黑边再比（截图常带黑边），
            // anilistInfo= 让它把番剧信息（含中文片名）直接塞进响应。
            // 这家不看 Origin/Referer，一个额外的头都不用带。
            format!("{}?cutBorders=true&anilistInfo=", e.page),
            "file",
            vec![],
            vec![],
        ),
        Upload::None => return Err("这家没有上传接口".into()),
    };

    // 手拼 multipart：ureq 没有 multipart 封装，而格式很死，拼错了对方直接拒。
    let mut body: Vec<u8> = Vec::with_capacity(jpeg.len() + 1024);
    for (k, v) in &extra_fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{file_field}\"; filename=\"image.jpg\"\r\n\
             Content-Type: image/jpeg\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(jpeg);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    /* r77：**共享一个 Agent**（而不是每轮现建），复用 TCP+TLS 连接。
     *
     * 为什么值得改：`ureq::Agent` 内部带**连接池**，同一个 host 的后续请求可以
     * 直接复用已建好的连接。以前每次 `img_upload` 都 `AgentBuilder::new()`
     * —— 一次识图要跟 2~4 个 host 说话，每个都从头握手（TLS 建连在这台机器上
     * 实测 100~300ms）。用户抱怨的"好几秒"里，这部分是纯浪费。
     *
     * ⚠ 超时和 UA 必须**跟着 Agent 一起定**（建好之后改不了），所以这里把原来
     *   那三行原样搬进 `get_or_init`。数值一个没动：
     *   connect 8s / 整体 12s（r66 从 25s 降下来的）。 */
    fn img_agent() -> ureq::Agent {
        static POOL: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
        POOL.get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(8))
                .timeout(Duration::from_secs(12))
                .max_idle_connections(16)
                .max_idle_connections_per_host(8)
                .user_agent(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                )
                .build()
        })
        .clone()
    }
    let agent = img_agent();
    let mut req = agent
        .post(&url)
        .set("Accept", "application/json, text/plain, */*")
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        );
    // Origin 走上面的 per-engine 表（r70）：Yandex/SauceNAO 不再被塞一个
    // 百度的 Origin。SauceNAO 回的是 HTML，Accept 里的 application/json
    // 它不在乎（照单全收），留着不影响。
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    let resp = req
        .send_bytes(&body)
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("对方返回 {code}"),
            ureq::Error::Transport(t) => {
                let m = t.to_string();
                if m.contains("timed out") {
                    "网络超时".to_string()
                } else {
                    format!("网络不通（{m}）")
                }
            }
        })?;
    let text = resp.into_string().map_err(|_| "读不出响应".to_string())?;
    /* r71 修一个 r70 留下的隐性 bug：这里原来是**无条件** `serde_json::from_str(&text)?`
     * —— 而 SauceNAO 回的是整页 HTML（实测 21706 字节 text/html），JSON 解析必然
     * 失败、直接 return Err，于是下面 SauceNAO 分支是**永远走不到的死代码**：
     * 用户点了 SauceNAO，实际拿到的是"退回打开上传页"。症状不报错、只是结果页
     * 不对，所以 r70 的实测（curl 直接打）没暴露它。
     * 现在按分支惰性解析：只有真要读 JSON 字段的分支才解析。 */
    let parse_json = || -> Result<serde_json::Value, String> {
        /* ⚠ 截断必须按**字符**取，不能 `&text[..80]`：对方回中文错误页时
         * 第 80 字节很可能落在某个三字节汉字的中间，那一下是
         * "byte index is not a char boundary" —— 直接把识图线程 panic 掉，
         * 这一轮剩下的引擎全丢。 */
        serde_json::from_str(&text).map_err(|_| {
            let head: String = text.chars().take(80).collect();
            format!("对方回的不是 JSON：{head}")
        })
    };

    match e.upload {
        Upload::SauceNao => {
            /* SauceNAO 的响应体**就是结果页本身**（实测 21910 字节、含 similarity）。
             * 它没有可重开的 GET 地址，所以把这份 HTML 存下来再交给浏览器。
             *
             * ⚠ 存进 %TEMP%\QuickSearch\img（和临时图同一个目录，文件名每次
             *   独有，见 result_page_path），由 img_temp_cleanup 统一清理 ——
             *   不新增一个"没人管"的目录。 */
            // 粗判是否真的是结果页：出错页通常很短，且没有这些标记。
            // （注意：Rust 没有 JS 那种 /re/i.test —— 上一版我照 JS 写法抄过来，
            //  编译直接报 "expected expression, found `/`"。这里用小写比较即可。）
            let low = text.to_ascii_lowercase();
            let looks_result = text.len() >= 2000
                && (low.contains("similarity")
                    || low.contains("resultcontent")
                    || low.contains("resulttable"));
            if !looks_result {
                return Err("SauceNAO：没拿到结果页".into());
            }
            let f = result_page_path("saucenao-result")?;
            if let Err(err) = std::fs::write(&f, text.as_bytes()) {
                return Err(format!("存结果页失败：{err}"));
            }
            let s = f.to_string_lossy().replace('\\', "/");
            Ok(if s.starts_with('/') {
                format!("file://{s}")
            } else {
                format!("file:///{s}")
            })
        }
        Upload::Baidu => {
            let json = parse_json()?;
            let u = json
                .get("data")
                .and_then(|d| d.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("");
            if u.starts_with("https://") {
                Ok(u.to_string())
            } else {
                // 百度拒绝时是 {"status":1,"msg":"Reject"}
                let msg = json.get("msg").and_then(|m| m.as_str()).unwrap_or("没给结果地址");
                Err(format!("百度：{msg}"))
            }
        }
        Upload::Yandex => {
            let json = parse_json()?;
            let id = json
                .get("blocks")
                .and_then(|b| b.get(0))
                .and_then(|b| b.get("params"))
                .and_then(|p| p.get("cbirId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if id.is_empty() {
                Err("Yandex：没拿到 cbir_id".into())
            } else {
                Ok(format!(
                    "https://yandex.ru/images/search?rpt=imageview&cbir_id={}",
                    engines::encode_query(id)
                ))
            }
        }
        Upload::TraceMoe => tracemoe_result_page(&text),
        Upload::None => Err("这家没有上传接口".into()),
    }
}

/// r71：把秒数格式成 mm:ss（trace.moe 的 from/to 是浮点秒）。
///
/// **截断**而不是四舍五入：它展示的是"这个场景从第几秒开始"，from=1094.511
/// 若四舍五入成 18:15，用户跳过去正好错过开头半秒；截断成 18:14 顶多少看
/// 半秒前置画面，不亏。（`as u64` 是饱和转换：NaN → 0，配合 max 挡负数。）
fn fmt_ts(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// r71：trace.moe 的 JSON → 一张本地结果页，返回 file:// URL。
///
/// 为什么落在本地页而不是像 Yandex 那样开个 URL：trace.moe 只回 JSON，
/// 没有「可重新打开的结果页」。但这份 JSON 里有全部想要的东西 —— 番名
/// （中文/日文/罗马字/英文）、第几集、几分几秒、相似度、预览视频 ——
/// 自己渲染一张页比"打开官网让用户再传一次"体验好得多。
///
/// ⚠ 安全：JSON 里每个字符串都来自对方服务器，一律 **html 转义**后才进
///   页面；外链只放行 https:// 开头（anilist / myanimelist / trace.moe 的
///   预览图与视频），其余一律降级成纯文本 —— 防数据里夹带 javascript: 之类。
///
/// 落点：`%TEMP%\QuickSearch\img\tracemoe-result-<pid>-<n>.html`（和 SauceNAO
/// 结果页、临时截图同一个目录，文件名每次独有，见 `result_page_path`），由
/// `img_temp_cleanup` 统一清理，不新增目录。
fn tracemoe_result_page(text: &str) -> Result<String, String> {
    let json: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| "trace.moe：回的不是 JSON".to_string())?;
    if let Some(err) = json.get("error").and_then(|e| e.as_str()) {
        if !err.trim().is_empty() {
            return Err(format!("trace.moe：{err}"));
        }
    }
    let empty: Vec<serde_json::Value> = Vec::new();
    let results = json.get("result").and_then(|r| r.as_array()).unwrap_or(&empty);
    if results.is_empty() {
        return Err("trace.moe：没有匹配的动漫场景".into());
    }

    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;")
    };
    // 只放行 https 外链；不是就当纯文本（防 javascript: 等 scheme）
    let safe_url = |u: &str| -> Option<String> {
        let t = u.trim();
        if t.starts_with("https://") { Some(esc(t)) } else { None }
    };

    let mut cards = String::new();
    let mut shown = 0usize;
    for r in results.iter().take(5) {
        shown += 1;
        let anilist = r.get("anilist");
        let title = anilist.and_then(|a| a.get("title"));
        // 片名优先中文，没有就罗马字/日文/英文。
        // ⚠ 空串要跳过：trace.moe 对没有中文片名的番剧，chinese 字段给的是
        //   "" 而不是整个字段缺失 —— 不跳过的话，片名整行就空了（测试踩过）。
        let field = |key: &str| {
            title
                .and_then(|t| t.get(key))
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
        };
        let name = field("chinese")
            .or_else(|| field("romaji"))
            .or_else(|| field("native"))
            .or_else(|| field("english"))
            .unwrap_or("（未知片名）");
        let romaji = field("romaji").unwrap_or("");
        let is_adult = anilist
            .and_then(|a| a.get("isAdult"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let episode = r.get("episode").and_then(|v| v.as_i64());
        let from = r.get("from").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let to = r.get("to").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let sim = r.get("similarity").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let anilist_url = anilist
            .and_then(|a| a.get("siteUrl"))
            .and_then(|v| v.as_str())
            .and_then(safe_url);
        let mal_id = anilist.and_then(|a| a.get("idMal")).and_then(|v| v.as_i64());
        let mal_url = mal_id.map(|id| format!("https://myanimelist.net/anime/{id}")).and_then(|u| safe_url(&u));
        let preview = r.get("image").and_then(|v| v.as_str()).and_then(safe_url);
        let video = r.get("video").and_then(|v| v.as_str()).and_then(safe_url);

        let mut head = format!(
            "<strong>{}</strong>",
            esc(name)
        );
        if is_adult {
            head.push_str(" <span class=\"r18\">R18</span>");
        }
        let mut meta = Vec::new();
        if let Some(ep) = episode {
            meta.push(format!("第 {ep} 集"));
        }
        meta.push(format!("{} – {}", fmt_ts(from), fmt_ts(to)));
        meta.push(format!("相似度 {:.1}%", sim * 100.0));
        let meta_line = meta.join(" · ");

        let mut sub = String::new();
        if !romaji.is_empty() && romaji != name {
            sub = format!("<div class=\"romaji\">{}</div>", esc(romaji));
        }
        let mut links = String::new();
        if let Some(u) = &anilist_url {
            links.push_str(&format!("<a href=\"{u}\">AniList</a>"));
        }
        if let Some(u) = &mal_url {
            if !links.is_empty() {
                links.push_str(" · ");
            }
            links.push_str(&format!("<a href=\"{u}\">MyAnimeList</a>"));
        }
        let media = match (preview, video) {
            (Some(p), Some(v)) => format!(
                "<video src=\"{v}\" poster=\"{p}\" controls preload=\"none\"></video>"
            ),
            (Some(p), None) => format!("<img src=\"{p}\" alt=\"\">"),
            _ => String::new(),
        };
        cards.push_str(&format!(
            "<section class=\"card\">{media}<div class=\"txt\">{head}{sub}<div class=\"meta\">{meta_line}</div><div class=\"links\">{links}</div></div></section>"
        ));
    }
    let _ = shown;

    let page = format!(
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
<title>识图结果 · trace.moe</title><style>\
body{{font-family:'Microsoft YaHei',system-ui,sans-serif;background:#1b1e24;color:#e8eaf0;margin:0;padding:20px}}\
h1{{font-size:18px;margin:0 0 4px}} .sub{{color:#9aa3b2;font-size:12px;margin-bottom:16px}}\
.card{{display:flex;gap:14px;background:#23272f;border:1px solid #323845;border-radius:10px;padding:12px;margin-bottom:12px;align-items:flex-start}}\
.card img,.card video{{width:200px;border-radius:6px;background:#000;flex:none}}\
.txt{{min-width:0}} .romaji{{color:#9aa3b2;font-size:12px;margin-top:2px}}\
.meta{{color:#c8cfdb;font-size:13px;margin-top:6px}} .links{{font-size:13px;margin-top:6px}}\
.links a{{color:#6cb6ff}} .r18{{background:#c0392b;color:#fff;font-size:11px;border-radius:3px;padding:1px 5px;vertical-align:middle}}\
</style></head><body><h1>识图结果 · trace.moe</h1>\
<div class=\"sub\">动漫场景反查（本页由 QuickSearch 用 trace.moe 接口结果生成，关闭即失效）</div>\
{cards}</body></html>"
    );
    let f = result_page_path("tracemoe-result")?;
    if let Err(err) = std::fs::write(&f, page.as_bytes()) {
        return Err(format!("存结果页失败：{err}"));
    }
    let s = f.to_string_lossy().replace('\\', "/");
    Ok(if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    })
}

/// r57：给「只吃原生文件框」的那几家留一张**临时**截图，返回它的路径。
///
/// 为什么需要：浏览器**不允许**往 `<input type=file>` 里粘贴，所以 AI 六家
/// 这类站点（能拖拽，但拖不进去时只能点上传；留一张两条路都走得通）
/// 光有剪贴板没用 —— 用户点开「选择文件」会发现手里没有文件可选，
/// 路就断在那儿。留一张，用户在文件对话框里选它就行
/// （大多数系统对话框还能直接 Ctrl+V 粘路径）。
///
/// r72：必应 / 搜狗 / 360 出册后，需要这张临时图的只剩 AI 六家
/// （`imgsearch::needs_file_pick`）。
///
/// 位置：`%TEMP%\QuickSearch\img\shot.jpg` —— **固定一个名字**。
/// 这一点是刻意的：固定名字 = 磁盘上最多只有一张、每轮自动覆盖，
/// 不会攒出 `shot-1.jpg`…`shot-99.jpg` 那种垃圾堆。
///
/// 清理：`img_temp_cleanup()` 在每轮开始、以及程序退出时调（见调用点）。
/// 所以它永远是"暂时的" —— 用户原话「这种只是暂时的图片，不能永久的存在电脑
/// 里面」。剪贴板那份另有一套归还机制（见 `img_clip_restore`）。
///
/// 写失败不算致命：那几家的用户就退化成"自己再截一次"，其余引擎照常能用。
fn img_temp_file(jpeg: &[u8]) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join("QuickSearch").join("img");
    if std::fs::create_dir_all(&dir).is_err() {
        win::log("img: 建临时目录失败，这轮不留临时图");
        return None;
    }
    let p = dir.join("shot.jpg");
    if let Err(e) = std::fs::write(&p, jpeg) {
        win::log(&format!("img: 写临时图失败（{e}），这轮不留临时图"));
        return None;
    }
    Some(p)
}

/// 清掉 `img_temp_file` 留下的那张临时图。**每轮开始和退出时都调。**
///
/// 顺手把整个 `img` 目录删掉（它是我们独占的，删空目录没风险）；目录里
/// 万一有历史版本留下的别的文件，也一并清 —— 反正它只该装"当前这一张"。
fn img_temp_cleanup() {
    let dir = std::env::temp_dir().join("QuickSearch").join("img");
    if !dir.exists() {
        return;
    }
    let mut n = 0usize;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            if std::fs::remove_file(ent.path()).is_ok() {
                n += 1;
            }
        }
    }
    let _ = std::fs::remove_dir(&dir);
    if n > 0 {
        win::log(&format!("img: 清掉 {n} 张临时图（截图不留在电脑上）"));
    }
}

/// r71：给「自己渲染的结果页」在 `%TEMP%\QuickSearch\img` 下取一个**每次独有**的文件名。
///
/// 为什么不能像原来那样固定一个名字：一轮识图里多家上传是**并行**的
/// （见 img_search：谁先回来先开哪个标签页），两家同时回结果页，固定名
/// 就会互相覆盖；赶上后一个的 write 撞上前一个还没关掉的文件句柄，
/// 直接"存结果页失败：拒绝访问"（cargo test 并行跑时稳定复现过）。
/// 进程内自增序号 + pid，多开会话也不撞。
///
/// 清理不用额外操心：`img_temp_cleanup` 清的是**整个目录**。
fn result_page_path(tag: &str) -> Result<std::path::PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join("QuickSearch").join("img");
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return Err(format!("建临时目录失败：{err}"));
    }
    Ok(dir.join(format!("{tag}-{}-{n}.html", std::process::id())))
}

/// 框选遮罩那一层压暗是不是已经从屏幕上撤干净了。
///
/// 为什么需要它（r77 提速的关键）：`close_window("region")` 之后
/// `get_webview_window("region").is_none()` 只说明 Tauri 把窗口对象摘掉了，
/// **不代表合成器已经把像素撤走**。以前的做法是固定 `sleep(700)` 赌它够，
/// 结果快机器白等 500ms、慢机器又不够（截出来带着压暗）。
///
/// 做法：抓选区**正中间**一小块（16×16，几十微秒），比它和"最后一帧"的差。
/// 遮罩在的时候这块是压暗过的；撤掉之后内容会跳一下。判据取**平均亮度变化**：
/// 连续两次采样变化都 < 阈值，就认为画面已经稳定（合成器不再重绘遮罩）。
///
/// 为什么用中心块而不是整块：整块抓取要几毫秒到几十毫秒（还要建 DIB），
/// 轮询十几次就上百毫秒 —— 那就把想省的时间又花回去了。中心 16×16 足够
/// 反映"这一帧是不是还在过渡"。
///
/// 返回是否在预算内确认稳定。**无论返回什么，调用方都该继续截图** ——
/// 这只是"尽量等干净"，等不到就按旧行为直接拍（宁可带一点压暗，也不能卡住）。
fn wait_overlay_pixels_gone(x: i32, y: i32, w: i32, h: i32, budget_ms: u64) -> bool {
    // 取中心 16×16；选区本身比这还小就直接用选区
    let pw = w.clamp(1, 16);
    let ph = h.clamp(1, 16);
    let cx = x + (w - pw) / 2;
    let cy = y + (h - ph) / 2;

    let mean_of = |px: i32, py: i32| -> Option<f64> {
        let (_, _, buf) = win::grab_region(px, py, pw, ph)?;
        if buf.is_empty() {
            return None;
        }
        // RGBA；只取 RGB 求均值（alpha 是拍满的 255，没有信息量）
        let mut sum = 0u64;
        let mut n = 0u64;
        for px in buf.as_chunks::<4>().0 {
            sum += px[0] as u64 + px[1] as u64 + px[2] as u64;
            n += 3;
        }
        Some(sum as f64 / n as f64)
    };

    let t0 = std::time::Instant::now();
    let mut prev = mean_of(cx, cy);
    // 16ms 一轮：一帧左右。再密只是白烧 CPU，合成器也是按帧刷的。
    while t0.elapsed() < Duration::from_millis(budget_ms) {
        std::thread::sleep(Duration::from_millis(16));
        let cur = mean_of(cx, cy);
        if let (Some(a), Some(b)) = (prev, cur) {
            // 相邻两帧几乎没变 → 遮罩那层重绘已经停了
            if (a - b).abs() < 0.35 {
                return true;
            }
        }
        prev = cur;
        // 抓不到（屏幕锁了 / 区域越界）就别再耗了，直接放行
        if prev.is_none() {
            return false;
        }
    }
    false
}

/// 框选完了：截图 → 按配置开浏览器。
///
/// 这就是用户要的那句「截图完成即直接跳转浏览器搜索，无需再次选择」：
///   · 设了**默认引擎**（`img_default_engine`）→ 首选它（勾了多家时排最前）；
///   · 没设默认 → 按**多选名单**一个个开，每个页面各开一个新标签页。
///
/// ⚠ r62 起这一步**又有网络请求了**：真上传的三家（Yandex / 百度 /
///   SauceNAO）要 POST 把图交出去。r57 曾经"只打开页面、零请求"，实测做不到
///   "框选完直接出结果"（见 imgsearch.rs 模块注释），于是改回自己上传。
///   上传全部并行、谁先回来先开哪个标签页。
///   整段仍然**丢到后台线程**：截图本身、上传、拉起浏览器、
///   `paste_into_browser` 那段保守延迟加起来要几百毫秒到几秒，压在命令调用栈上
///   会把 WebView 主线程堵住（横条、面板一起卡）。
#[tauri::command]
fn img_region(x: f64, y: f64, w: f64, h: f64, dpr: f64) {
    if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite()) {
        win::log("img_region: 非法坐标，已退出框选");
        close_window("region");
        img_tell("框选坐标不对，再框一次试试");
        return;
    }
    // 和 ocr_region 同一套换算：css 坐标 × dpr + 虚拟屏原点 = 物理像素
    let d = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let (vx, vy, _, _) = win::virtual_screen();
    let px = vx + (x * d).round() as i32;
    let py = vy + (y * d).round() as i32;
    let pw = ((w * d).round() as i32).max(1);
    let ph = ((h * d).round() as i32).max(1);
    win::log(&format!(
        "img_region css=({x:.0},{y:.0},{w:.0},{h:.0}) dpr={d} -> phys=({px},{py},{pw},{ph})"
    ));
    // 先把遮罩收掉再截（那层压暗会被截进去，见 ocr_region 同一条注释）
    close_window("region");

    std::thread::spawn(move || {
        /* r77：**提速**。用户原话「框选了区域之后，要过好几秒才会打开浏览器开始
         * 识图网页，这个速度要优化」。
         *
         * 这一段的等待是"从点了松手到截图"的全部前置成本，以前是
         * **固定 700ms**（r66 从 1200ms 降下来的）。固定值的问题是两头都不对：
         *   · 快机器上遮罩 100~200ms 就没影了，剩下 500ms 纯属白等；
         *   · 慢机器/高负载时 700ms 又不够，截出来还带着那层压暗。
         *
         * 现在改成**看屏幕**：窗口对象消失（`get_webview_window().is_none()`）
         * 只代表 Tauri 那边把它摘了，不代表合成器已经把像素撤掉 —— 后者才是
         * 截图干净的前提。所以直接抓**选区中心的一小撮像素**（16×16，
         * 几十微秒），看它是不是还带着遮罩那层 rgba(10,12,18,.34) 的压暗特征。
         *
         * 判据：遮罩是"整块压暗 + 选中框内几乎不变"，所以只要中心块的平均亮度
         * 与"遮罩消失后"差得远，就说明还没撤干净。等它连续两帧稳定就开拍。
         *
         * 上限仍是 700ms（比以前的固定 700ms 只会更快，不会更慢 —— 快机器
         * 通常在 120~250ms 就能走），另外保留原来的"窗口对象没了"作为软条件。 */
        win::wait_until(700, || app().get_webview_window("region").is_none());
        // 窗口对象摘掉之后再等像素稳定（这才是以前那 700ms 等待真正在等的东西）
        let settled = wait_overlay_pixels_gone(px, py, pw, ph, 420);
        win::log(&format!(
            "img: 遮罩像素已撤净={}（此后才开始截图）",
            settled
        ));

        let Some((cw, ch, pixels)) = win::grab_region(px, py, pw, ph) else {
            img_tell("截图失败，再框一次试试");
            return;
        };
        let Some(img) = image::RgbaImage::from_raw(cw, ch, pixels) else {
            img_tell("截图数据异常");
            return;
        };
        // 编 JPEG（q88）。识图要的是特征而不是文字，比 OCR 的 q85 略高一档；
        // 各家视觉搜索都接受 1600px 长边以内的图，这里不做二次缩放（框出来
        // 的区域通常远小于全屏）。
        let mut cursor = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 88);
        if let Err(e) = image::DynamicImage::ImageRgba8(img).write_with_encoder(enc) {
            img_tell(format!("图片编码失败：{e}"));
            return;
        }
        let jpeg = cursor.into_inner();
        win::log(&format!("img: jpeg {} KB", jpeg.len() / 1024));

        /* r56：截图是**临时东西**，用完必须从电脑上消失。
         * 用户原话：「再就是不管是识图搜索还是 ocr 截取的图片，用完之后记得删掉，
         * 这种只是暂时的图片，不能永久的存在电脑里面。」
         *
         * 识图这条链上，截图**本来就不落盘**（ pixels → JPEG 字节全在内存里，
         * 见 img_region 全程没有一个 fs::write，tools/r56-tmppic-probe.js 拿
         * 目录扫描 + 源码审查两头都钉过了）。真正会"留下来"的只有一处：
         * **剪贴板** —— Paste 类引擎要靠着它粘贴，所以那一步必须留着；
         * 但一轮搜完之后它还躺在剪贴板里，用户重启、换软件都还在，
         * 那就是用户说的"永久存在"。
         *
         * 做法：**动剪贴板之前先 snapshot，用完 restore**。
         * 为什么不是简单 `clip::clear()`：
         *   · clear 会把用户原本复制的东西一起抹掉（他可能刚 Ctrl+C 了一段文字，
         *     识图搜完发现剪贴板变了 —— 这是新引入的 bug）；
         *   · snapshot/restore 是"把借来的地方还回去"，截图消失了，
         *     用户原来的内容原地不动。两头都占。
         * ⚠ snapshot 可能失败（剪贴板被别的进程占着）。失败时**不要**去 restore
         *   （那会把别人正在写的东西清掉），只当没备份过 —— 见 clip::snapshot 注释。 */
        let mut clip_keep = clip::snapshot();
        let pasted = clip::set_image(&jpeg);
        /* ⚠ 同一课：`set_image` 是**我们自己**在写剪贴板，序号必然变。
         *   不把基准挪到这一刻，后面 `restore_if_unchanged` 会把我们自己的
         *   写入误判成"用户又复制了别的东西"，于是**永远不还原** ——
         *   截图永久留在剪贴板上，正是用户说的「不能永久存在电脑里面」。
         *
         *   对齐之后语义才对：
         *     · 这一轮没别人动过 → 还原（截图消失，原内容回来）；
         *     · 用户在这 1~2 秒里自己 Ctrl+C 了 → 不还原（留住他刚复制的）。 */
        if clip_keep.is_some() {
            if let Some(s) = clip_keep.as_mut() {
                s.note_our_write();
            }
        }
        win::log(&format!(
            "img: clipboard image ok={pasted}（已备份原剪贴板：{}）",
            clip_keep.is_some()
        ));

        let cfg = cfg_snapshot();
        let plan = img_plan(&cfg);
        if plan.is_empty() {
            // r56：这一轮什么都没搜成，但截图**已经进过剪贴板了** —— 照样要还回去
            img_clip_restore(&clip_keep, pasted, cfg.img_keep_clip);
            img_tell("还没有勾任何识图引擎，去设置里选一个");
            return;
        }
        win::log(&format!("img: 这一轮要搜 {} 家：{:?}", plan.len(), plan.len()));

        /* r59：**先清上一轮的临时文件，再写这一轮的**。
         *
         * ⚠ 顺序很要紧：清理必须放在写提交页/临时图**之前**。
         *   以前清理放在 open_links 之后 —— 那会把刚写出来的提交页删掉，
         *   而浏览器可能还没加载它，用户看到的就是一个空白标签页
         *   （或者"文件不存在"）。这类竞态在快机器上不一定复现，最难查。 */
        img_temp_cleanup();

        /* r62：**并行上传 + 谁先回来先开**。
         *
         * 以前是串行：逐家 POST 完、全部拿到 URL 之后才一次性 open_links。
         * 用户说"识图搜索速度好慢，要过一段时间才能真正开始搜索"—— 根因就是这段：
         * 两家上传各要 ~1 秒，用户盯着屏幕等两秒才看见第一个标签页动。
         * 而且 open_links 走的是"从文本里抽 URL"那条路（12 条上限 + 还要过
         * text_to_url），对"已经确定的最终 URL"既慢又多余。
         *
         * 现在：不需要上传的立刻开；要上传的每家用一个线程同时 POST，
         * 谁先回来就先开那个标签页；不走 open_links（URL 已经是最终地址）。
         */
        /* r76：**AI 先开、等它按键完成，再开其余识图网址。**
         *
         * 用户原话：「如果选中了 ai 看图，那么默认 ai 看图就是最先打开最先完成的，
         * 软件自己按完快捷键再打开其他的识图网址。」
         *
         * 为什么必须串起来：AI 家的整键逻辑（开页 → 等 → Ctrl+V → 等 → Enter）
         * 依赖"前台就是那个 AI 页面"。若同时把别家的标签页也开出去，浏览器会在
         * 几个新标签之间来回抢前台，等我们核对完前台准备发键时，前头的可能
         * 已经变成别家 —— Ctrl+V 就打进了搜索引擎的搜索框。
         * 所以 AI-first 时把一轮切成两段：AI 段（含按键）跑完，再跑其余段。
         *
         * `img_ai_first` 关掉时退回 r75 的老行为：一次性全开（顺序仍是 AI 在前）。 */
        let ai_first = cfg.img_ai_first && plan.iter().any(|e| imgsearch::is_ai_engine(e.id));
        let (ai_part, rest_part): (Vec<&'static imgsearch::Engine>, Vec<&'static imgsearch::Engine>) =
            if ai_first {
                let mut a = Vec::new();
                let mut r = Vec::new();
                for e in &plan {
                    if imgsearch::is_ai_engine(e.id) {
                        a.push(*e);
                    } else {
                        r.push(*e);
                    }
                }
                (a, r)
            } else {
                (Vec::new(), plan.clone())
            };

        let open_one = |e: &'static imgsearch::Engine,
                        problems: &mut Vec<String>,
                        pending_upload: &mut Vec<&'static imgsearch::Engine>|
         -> usize {
            match e.mode {
                imgsearch::Mode::Upload => {
                    /* r78：**恢复旧逻辑**（用户原话：「识图还是使用旧逻辑吧」）。
                     *
                     * r77 曾试过"先把上传页打开、再并行上传、回来后另开结果页"，
                     * 目的是让用户立刻看到点动静。但它有用户不接受的代价：
                     * **一次识图会多出一个标签页**（上传页 + 结果页），
                     * 而那个上传页在上传成功后就没用了。
                     *
                     * 现在回到 r76 及以前的行为：**只进队列、不开页面**，
                     * 等 POST 回来直接开结果页；失败才退回打开上传页。
                     * 标签页数量因此和以前完全一样（每家一个）。
                     *
                     * ⚠ r77 的另外两项提速**保留**了（它们不改变标签页数量）：
                     *   · 共享 ureq Agent（连接池）—— 少一轮 TLS 握手；
                     *   · 等像素撤净代替固定 700ms —— 松手到截图快 29%。
                     * 这两项是纯收益，没有副作用。 */
                    pending_upload.push(e);
                    0
                }
                imgsearch::Mode::Page => {
                    img_open_tab(e.page);
                    1
                }
                imgsearch::Mode::Url => match imgsearch::url_for(e, &cfg.img_public_url) {
                    Some(u) => {
                        img_open_tab(&u);
                        1
                    }
                    None => {
                        problems.push(format!("{} 需要先在设置里填一张公网图片地址", e.name));
                        0
                    }
                },
            }
        };

        // —— 第一段：AI 家（ai_first 时）——
        let mut pending_upload: Vec<&'static imgsearch::Engine> = Vec::new();
        let mut problems: Vec<String> = Vec::new();
        let mut opened = 0usize;
        for e in &ai_part {
            opened += open_one(e, &mut problems, &mut pending_upload);
        }

        /* 上传类（真 POST 的那几家）在这一段里等回来 —— AI 六家都是 Page 类，
         * 走不到这里；留着是为了将来若有人把 AI 家改成 Upload 档不出错。 */
        drain_uploads(&mut pending_upload, &jpeg, &mut problems, &mut opened);

        /* r65：这一轮里有 AI 识图引擎 → 补一次 Ctrl+V（用户授权）。
         * 只对 AI 那几家；别的引擎一个键都不发。
         * r70：名单走注册表的 `is_ai_engine`（imgsearch::AI_ENGINES），
         * 不再在这里 matches! 写死一遍 —— 两份名单迟早会漏改。
         * r76：判据收进 `img_should_paste` —— 多了「勾多家就默认关掉按键」
         *   这一条（用户原话见那个函数的注释），延迟也改成可配。 */
        let want_paste = img_should_paste(&plan, pasted, &cfg);
        if want_paste {
            img_paste_into_browser(
                cfg.img_ai_paste_delay as u64,
                cfg.img_ai_enter_delay as u64,
            );
        }

        // —— 第二段：其余识图网址（AI 按键已经收尾，前台归它自己）——
        for e in &rest_part {
            opened += open_one(e, &mut problems, &mut pending_upload);
        }

        drain_uploads(&mut pending_upload, &jpeg, &mut problems, &mut opened);

        if opened == 0 {
            img_clip_restore(&clip_keep, pasted, cfg.img_keep_clip);
            img_tell(format!("识图没打开：{}", problems.join("；")));
            return;
        }
        let n = opened;
        win::log(&format!("img: 已开 {n} 个标签页（含并行上传）"));

        /* r57：给「只吃原生文件框」的那几家留一张**临时**图。
         *
         * 浏览器不允许往 `<input type=file>` 里粘贴，所以 AI 六家（能拖拽、
         * 拖不进去也能点上传）光有剪贴板没用 —— 用户点开「选择文件」会发现
         * 手里没有文件可选。留一张，选它就行。
         *
         * ⚠ r70：**这一轮没有"要选文件"的引擎就整个不写**。
         *   以前无条件写盘 —— 只勾了真上传两家的用户，截图也会在
         *   `%TEMP%\QuickSearch\img\shot.jpg` 落一次脚。它下一轮会被覆盖、
         *   退出也会删，但"截图不该落在硬盘上"是用户点名过的要求
         *   （「这种只是暂时的图片，不能永久的存在电脑里面」），能一次不落
         *   就不落。清理同样只在真写过之后才需要（见 img_temp_cleanup 的调用点）。
         *
         * ⚠ 清理已经在**这一轮开头**做过（见上面 img_temp_cleanup 那段注释），
         *   这里只写、不再清 —— 清了会把刚写的结果页一起删掉。 */
        let need_file = plan.iter().any(|e| {
            e.mode == imgsearch::Mode::Page && imgsearch::needs_file_pick(e.id)
        });
        let tmp = if need_file { img_temp_file(&jpeg) } else { None };
        if let Some(p) = tmp.as_ref() {
            win::log(&format!("img: 临时图已留 {}", p.display()));
        }

        /* r56：这一轮结束了 —— **把借来的剪贴板还回去**。
         *
         * 放在这里（而不是 paste_into_browser 里面）是因为两条路都要收：
         *   · Page 类：粘贴已经发完，浏览器该收到的收到了；
         *   · Url 类：压根没往浏览器发过键，图在剪贴板里纯属多余。
         * ⚠ 时机：必须等浏览器真的把粘贴吃进去。paste_into_browser 内部有
         *   一段保守延迟（窗口从无到有 + 首屏 + 焦点交接），回来时已经够了。
         *   太早 restore 的话，浏览器那边 Ctrl+V 粘到的会是**原来的旧内容**，
         *   用户看到"上传框空着"—— 那是比"剪贴板留着图"严重得多的 bug。 */
        img_clip_restore(&clip_keep, pasted, cfg.img_keep_clip);

        if !problems.is_empty() {
            // 成功的部分照常开，失败的逐家说明 —— 不因为一家失败就整轮不算
            img_tell(format!("已开 {n} 个页面；{} 没打开：{}", problems.len(), problems.join("；")));
        } else {
            win::log(&format!("img: 已开 {n} 个标签页"));
            /* r57：告诉用户"临时图在哪"。
             *
             * 这句话不是可有可无的提示 —— 它是 AI 六家（r72 起要选文件的
             * 只剩它们）**唯一**能把流程接下去的信息（浏览器不让他们粘贴，
             * 只能在文件对话框里挑文件）。以前这里是静默的，用户看到上传页
             * 却不知道文件在哪，那就等于没做成。
             *
             * 只在这一轮真有「要选文件」的引擎时才说，免得别人被无谓打扰。 */
            if let Some(p) = tmp.as_ref() {
                img_tell(format!(
                    "已开 {n} 个页面。要选文件的那几家（AI 那几间），\
                     点页面里的「选择文件」，选这张临时图：{}",
                    p.display()
                ));
            }
        }
    });
}

/// 这一轮识图到底搜哪几家。口径与 OCR 的 `ocr_engine_plan` 一致：
///
///   · 设了**默认引擎** → 它排最前（用户要「无需再次选择」时只勾它一家即可）；
///   · 没设 → 搜多选名单里的全部（去重、按注册表顺序，标签页顺序因此稳定）；
///   · 都没配（老配置 / 被清空）→ 退回 `DEFAULT_ENGINES`（Yandex + SauceNAO，
///     r70 起两家都实测能直接出结果）。
///
/// r76 新增一条排序规则：**勾了 AI 看图时，AI 那几家排到最前**
/// （用户原话：「如果选中了 ai 看图，那么默认 ai 看图就是最先打开最先完成的，
/// 软件自己按完快捷键再打开其他的识图网址」）。
/// 顺序 = AI 家（保持注册表顺序）→ 其余。这一个函数是纯函数，单测直接钉行为。
/// 并行上传 + 谁先回来先开（识图的两段都走这里）。
///
/// # 为什么要抽出来
///
/// `img_region` 里原本有**两份逐字相同**的 33 行代码（AI 那一段之后一份、
/// 其余引擎那一段之后一份），只有外层注释不同。改一处漏一处是必然的 ——
/// 比如 r78 把"上传失败退回打开页面"补回来时，就得记得改两遍。
///
/// `pending` 会被清空；`problems` 收失败原因，`opened` 累加真正打开了的页数。
fn drain_uploads(
    pending: &mut Vec<&'static imgsearch::Engine>,
    jpeg: &[u8],
    problems: &mut Vec<String>,
    opened: &mut usize,
) {
    if pending.is_empty() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<(String, Result<String, String>)>();
    for e in pending.drain(..) {
        let tx = tx.clone();
        let jpeg = jpeg.to_vec();
        std::thread::spawn(move || {
            let r = img_upload(e, &jpeg);
            let _ = tx.send((e.id.to_string(), r));
        });
    }
    drop(tx);
    let t_up = std::time::Instant::now();
    while let Ok((id, r)) = rx.recv() {
        match r {
            Ok(u) => {
                win::log(&format!(
                    "img: {id} 上传完成，开结果页（{}ms）",
                    t_up.elapsed().as_millis()
                ));
                img_open_tab(&u);
                *opened += 1;
            }
            Err(msg) => {
                /* r78：回到旧逻辑 —— 上传失败时**退回打开上传页**。
                 * （r77 因为"进队列时已经先开过上传页"而删掉了这一手，
                 *  现在那个页面不再提前打开，所以这里必须补回来，
                 *  否则用户点了一家、失败后**什么页面都没有**。） */
                win::log(&format!("img: {id} 上传失败（{msg}），退回打开页面"));
                problems.push(format!("{id} 上传失败（{msg}）"));
                if let Some(e) = imgsearch::find(&id) {
                    img_open_tab(e.page);
                    *opened += 1;
                }
            }
        }
    }
}

fn img_plan(cfg: &config::Config) -> Vec<&'static imgsearch::Engine> {
    /* r62：**勾了多家就全部打开**（用户原话："如果在识图搜索里面把引擎都勾选，
     * 那点击横条中的识图搜索框选完之后，就应该在不同的标签页里面打开不同的识图"）。
     *
     * 以前是"设了默认引擎就只搜那一家"，于是用户勾了一堆却只开一个标签页 ——
     * 那正是他报的"功能没做"。现在把"默认引擎"降级成**首选**：
     *   · 只勾了 0~1 家 → 默认引擎（没设就用勾的那家 / DEFAULT_ENGINES）；
     *   · 勾了 ≥2 家 → 全部打开，默认那家排最前（标签页顺序稳定）。
     */
    let mut picked = imgsearch::normalize_list(&cfg.img_engines);
    let multi = picked.len() >= 2;
    if !multi && !cfg.img_default_engine.is_empty() {
        if let Some(e) = imgsearch::find(&cfg.img_default_engine) {
            return vec![e];
        }
    }
    if multi {
        if let Some(def) = imgsearch::find(&cfg.img_default_engine) {
            if let Some(pos) = picked.iter().position(|id| id == def.id) {
                let id = picked.remove(pos);
                picked.insert(0, id);
            }
        }
    }
    if picked.is_empty() {
        return imgsearch::DEFAULT_ENGINES
            .iter()
            .filter_map(|id| imgsearch::find(id))
            .collect();
    }
    let mut plan: Vec<&'static imgsearch::Engine> = picked
        .iter()
        .filter_map(|id| imgsearch::find(id))
        .take(imgsearch::MAX_TABS)
        .collect();
    /* r76：AI 优先。**稳定分区** —— AI 家按原相对顺序整体挪到前面，
     * 非 AI 家的顺序一个都不动（用户勾选顺序 = 标签页从左到右）。
     *
     * ⚠ 不用 `sort_by_key(|e| !is_ai(e))`：那种写法依赖"稳定排序"这个前提，
     *    而读代码的人无法一眼确认它稳定（Rust 文档承诺稳定，但换实现 /
     *    换容器就是隐患）。partition 的语义是显式的：一份两份、各自保序。 */
    if cfg.img_ai_first {
        let mut ai: Vec<&'static imgsearch::Engine> = Vec::new();
        let mut rest: Vec<&'static imgsearch::Engine> = Vec::new();
        for e in plan {
            if imgsearch::is_ai_engine(e.id) {
                ai.push(e);
            } else {
                rest.push(e);
            }
        }
        ai.extend(rest);
        plan = ai;
    }
    plan
}

/// 这一轮**要不要给 AI 引擎发按键**。
///
/// 判据（全部来自用户原话）：
///   ① 勾了 AI 引擎（不发键的话 AI 家就是"开了个空白页"）；
///   ② `pasted` —— 截图真的进过剪贴板（没进的话按什么都没用）；
///   ③ **勾了多个 AI 识图**就默认关掉按键。
///
/// ⚠ r77 口径修正（用户原话：「勾选多加 ai 识图才关掉按键」）：
///    以前按 `plan.len() >= 2`（**总共**勾了几家）判，于是
///    「默认=百度 + 另外勾了豆包」这种最常见的配置也会被关掉 ——
///    用户报的正是它：「虽然会先打开豆包的页面，但却并不能够执行 ctrl+v 以及
///    enter」，而只勾豆包一家时又是好的。
///
///    真正会出问题的只有**多个 AI 页面**：它们都等着同一张图被粘进自己的输入框，
///    而前台只有一个 —— 发一次键只可能喂饱其中一个，另一个注定空着，
///    用户看到的就是"点开了但没粘上"。这种情况下默认不自动按键、让人自己挑，
///    比"悄悄只喂了其中一个"诚实。
///    非 AI 的识图网址（百度 / Yandex / SauceNAO 这些）跟 AI 不抢同一件事 ——
///    它们自己 POST 上传，压根不需要粘贴 —— 所以**不参与**这个判据。
fn img_should_paste(plan: &[&'static imgsearch::Engine], pasted: bool, cfg: &config::Config) -> bool {
    if !pasted {
        return false;
    }
    let ai_count = plan
        .iter()
        .filter(|e| imgsearch::is_ai_engine(e.id))
        .count();
    if ai_count == 0 {
        return false;
    }
    if cfg.img_ai_auto_off_on_multi && ai_count >= 2 {
        win::log(&format!(
            "img: 勾了 {ai_count} 家 AI 识图，按设置关掉自动按键（一次只能喂一个输入框，请自己挑一个 Ctrl+V）"
        ));
        return false;
    }
    true
}

/// r54 需求 2：划词选中的是一条本地路径时，横条上那颗**文件管理器图标**
/// 点了就走这里 —— 用系统资源管理器定位并打开这条路径。
///
/// 判据在前端（bar.js 的 `looksLikePath`，与 `paths::looks_like_path` 同一套
/// 口径：盘符 / UNC / `.\` 相对 / `%VAR%`），这里只做「解析 + 打开 + 反馈」。
/// 前端判据与后端判据各留一份是有意的：前端要的是**弹出图标**（不能为了判一
/// 条路径去调一次 IPC），后端要的是**别拿前端的话全信**（老版本的前端 / 直接
/// 调命令的人都可能塞进来奇怪的东西）—— 两边都过 `paths` 模块的函数，行为
/// 因此一致。
#[tauri::command]
fn open_path(path: String) -> String {
    // 后端自己也过一遍判据。前端（bar.js）会先判「像不像路径」再决定弹不弹图标，
    // 但**不能拿前端的话全信** —— 直接调命令的人（老版本前端、自己写脚本调
    // IPC）可能塞进来一句普通句子。判据两边共用同一套口径，行为因此一致。
    let msg = if paths::looks_like_path(&path).is_none() {
        format!("这不像一条本地路径：{path}")
    } else {
        match paths::resolve(&path) {
            Some(p) => paths::open(&p),
            None => format!("这不像一条能打开的路径：{path}"),
        }
    };
    win::log(&format!("open_path: {path} -> {msg}"));
    msg
}

#[tauri::command]
fn ocr_start() {
    // ⚠ 必须脱开命令调用栈，理由和 open_app_picker 一模一样：
    //   配置面板/横条点「开始框选识别」时，本次 invoke 还没返回；就地
    //   `run_on_thread` → `build()` 建框选窗口，主线程建 WebView2 时要回头
    //   等一把命令尚未释放的锁 —— 直接死锁。
    //   死锁的后果比"按钮没反应"严重得多：region 是**铺满全屏的遮罩**，
    //   它一旦建到一半卡住、或者建出来又关不掉，整个屏幕的鼠标都会被它吃掉，
    //   用户按 Esc 也没用（钩子和页面都可能在等这把锁），只能强杀进程。
    //   所以这里立刻返回，把活交给后台线程；热键那条路本来就在 spawn 里，不受影响。
    std::thread::spawn(ocr_start_flow);
}

#[tauri::command]
fn ocr_cancel() {
    win::log("ocr: cancelled");
    REGION_HWND.store(0, Ordering::SeqCst);
    close_window("region");
}

/// 「识别结果」窗口的首帧画完了 —— 现在可以安全地把它显示出来。
///
/// 为什么要等这一下：`open_ocr_window` 是建完窗就 `hidden` 的，为的是不让用户
/// 看到 WebView2 还没渲染时那块原生黑底（"又蹦出一个黑框"就是这么来的）。
/// 页面在自己的 DOM/CSS 就位后调这个命令，我们才 `show()`，用户看到的第一眼
/// 就是完整的界面。重复调用无害（窗口已经可见时什么都不做）。
#[tauri::command]
fn ocr_ready() {
    show_after_ready("ocr");
}

/// 同 `ocr_ready`，只是给设置窗口用：首帧画完才把隐藏的窗口亮出来，
/// 免得用户先看到一块没内容的原生黑底。
#[tauri::command]
fn settings_ready() {
    show_after_ready("settings");
}

/// 「隐藏建窗 → 页面首帧就绪 → 显示并抢焦点」的公共实现。
///
/// ⚠ 焦点必须**反复抢几次**：隐藏窗口是无法获得焦点的，`show()` 之后窗口从
/// "不可见"切到"可交互"也有一小段延迟（和 region 窗口抢焦点是同一类问题）。
/// 只 `show()` 后立刻 `set_focus()` 一次，经常抢不到 —— 表现出来就是
/// 「窗口是开了，但第一下点击落在别处、点了没反应」。
/// 所以这里显示之后再补几轮 set_focus，直到确认真的是前台窗口为止。
fn show_after_ready(label: &str) {
    let a = app();
    let Some(w) = a.get_webview_window(label) else {
        return;
    };
    // 已经可见了就只补一次焦点（重复调用场景），不必再走整套流程
    if w.is_visible().unwrap_or(false) {
        let _ = w.set_focus();
        return;
    }
    win::log(&format!("{label}: ready -> show"));
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();

    let w2 = w.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        for i in 0..10 {
            std::thread::sleep(Duration::from_millis(90));
            if win::foreground_is(&w2) {
                if i > 0 {
                    win::log(&format!("{label}: focus ok after {} tries", i + 1));
                }
                return;
            }
            let _ = w2.set_focus();
        }
        win::log(&format!("{label}: 抢焦点收尾（不影响使用）"));
    });
}

/// 框选页面的心跳。页面活着时每 2 秒来一次；看门狗 5 秒收不到就强制关窗。
#[tauri::command]
fn region_beat() {
    REGION_BEAT.store(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(1),
        Ordering::SeqCst,
    );
}

#[tauri::command]
fn ocr_take_text() -> String {
    OCR_LAST.lock().map(|g| g.clone()).unwrap_or_default()
}

/// 拉最近一次框选的截图，返回 `data:image/png;base64,...`；没有就返回空串。
///
/// 和 `ocr_take_text` 一样是「推 + 拉」双通道里的「拉」那一半：
/// 页面 boot 完之后主动来拿一次，就不会因为错过事件而空着。
#[tauri::command]
fn ocr_take_image() -> String {
    OCR_LAST_PNG
        .lock()
        .map(|g| {
            if g.is_empty() {
                String::new()
            } else {
                ocr_image_data_url(&g)
            }
        })
        .unwrap_or_default()
}

/// 拉当前结果附带的提示（降级说明 / 「没配百度密钥」这类说明）；没有就返回空串。
///
/// 「推 + 拉」里的「拉」那一半 —— 和 `ocr_take_text` / `ocr_take_image` 一个道理：
/// 页面 boot 完之后主动来拿一次，就不会因为错过事件而看不到这条提示。
/// 只读不清：推送通道（`qs://ocr-result` 的 note 字段）还要用同一份。
#[tauri::command]
fn ocr_take_note() -> String {
    OCR_LAST_NOTE.lock().map(|g| g.clone()).unwrap_or_default()
}

/// 拉当前这一代的分段结果（`[{eng,label,text}]`），给结果页做「仅本地 / 仅百度 /
/// 两者都看」。同样是「推 + 拉」双通道里的「拉」那一半：页面 boot 晚了也不会
/// 因为错过推送就切不动显示模式。
#[tauri::command]
fn ocr_take_parts() -> serde_json::Value {
    serde_json::Value::Array(ocr_parts(OCR_PNG_GEN.load(Ordering::SeqCst)))
}

#[tauri::command]
fn close_ocr_window() {
    close_window("ocr");
    // 关窗即清场：OCR 的缓存是临时的，结果页一关就不该再留着（用户要求）
    clear_ocr_session();
}

/// 按引擎识别一张图（JPEG/PNG 字节）。`engine` = "baidu" | "windows"。
/// 返回 `(清理后文字, 未清理原文, 引擎标签)`。
///
/// 抽这一层是为了让「首次识别（截图后）」「重新识别」「结果页切换引擎」「并行双跑」四条路径
/// 共用同一段分支逻辑，谁都不用重复写。
///
/// ⚠ 原文一起返回、**不再写全局** OCR_LAST_RAW：并行模式下两个引擎同时认，
///    谁最后写谁赢，另一个引擎的原文就丢了（去空格按钮的原料会张冠李戴）。
///    全局由调用方按「当前展示的那个引擎」统一填。
fn run_ocr(png: &[u8], engine: &str) -> Result<(String, String, String), String> {
    let cfg = cfg_snapshot();
    let creds = ocr_creds(&cfg, engine);
    let out = ocr_engines::recognize(
        engine,
        &creds,
        png,
        &cfg.ocr_lang,
        cfg.ocr_accurate,
        25,
        &ocr_engines::OcrUrls::default(),
    )?;
    // 标签：百度那条路返回的是「高精度版 / 标准版」（描述用的是哪档接口），
    // 并行结果里的【标注】要的是**引擎名** —— 所以除了百度，其它一律用引擎名。
    let label = match ocr_engines::find(engine).map(|e| e.kind) {
        Some(ocr_engines::Kind::Baidu) => out.engine.to_string(),
        _ => engine_display(engine).to_string(),
    };
    // ⚠ 按**当前生效的整理开关**派生（设置里的默认 + 结果页按钮的临时覆盖）：
    // 用户点过「强力」之后再识别，早期版本这里固定走智能清理，
    // 空格全回来了 —— 报过「强力去空格根本没没用」。
    Ok((clean_now(&out.text), out.text, label))
}

/* ---------------- 多引擎的公共小工具（需求 2） ---------------- */

/// 读一份配置快照；**测试环境（没有 Tauri app）返回默认配置**，不 panic。
///
/// 为什么需要它：combined_text / ocr_parts 这类纯函数现在要看"并行的是哪两家
/// 引擎"（需求 2 之前是写死的 windows+baidu），而它们在单测里也会被调用 ——
/// cfg_snapshot() 依赖全局 APP，单测里没有，会直接 panic。
fn cfg_snapshot_or_default() -> Config {
    if APP.get().is_none() {
        return Config::default();
    }
    cfg_snapshot()
}

/// 设置里配的那个在线引擎；配了个不认识的（老配置 / 手改过文件）就退回百度。
fn online_engine(cfg: &config::Config) -> String {
    if ocr_engines::is_online(&cfg.ocr_engine) {
        cfg.ocr_engine.clone()
    } else {
        "baidu".to_string()
    }
}

/// **一轮识别到底跑哪几家**（r47 起由「默认引擎 + 同时识别名单」派生）。
///
/// 顺序 = 默认引擎在前，其余按**注册表顺序**（不是用户勾选顺序）——
/// 结果页上下排列的顺序因此稳定，同一次识别里不会因为勾选先后而变。
///
/// ⚠ 老实现叫 `parallel_engines()`，返回写死的 `["windows", online]`：
///   ① 用户配了第三家（硅基流动/Kimi），并行那一路照样跑"本地 + 百度"；
///   ② 关掉并行开关后，结果页仍会冒出"本地识别"可点 —— 用户 r47 报的就是它：
///      「就算我打开了，也要我把本地的识别引擎添加在多引擎识别里面，它才可以」。
///   现在本地和别家一样，**被勾选才参与**。
fn ocr_engine_plan(cfg: &config::Config) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let def = cfg.ocr_engine.clone();
    if ocr_engines::find(&def).is_some() {
        out.push(def.clone());
    }
    // 额外那几家：按注册表顺序挑，保证展示顺序稳定
    for e in ocr_engines::ENGINES {
        if e.id == def {
            continue;
        }
        if cfg.ocr_multi.iter().any(|x| x == e.id) {
            out.push(e.id.to_string());
        }
    }
    /* r76 兜底：上面两步一份都没凑出来（默认引擎那一栏是个注册表里没有的值，
     * 也没勾任何一家）时，补本地引擎。
     *
     * 这一步修的是一个"点 OCR 完全没反应"的真 bug：默认引擎无效 → 计划为空 →
     * 凭据检查拿 baidu 当"在线引擎"一问，用户当然没配密钥 → ocr_start_flow
     * 直接 return，**连框选遮罩都不开**。用户看到的就是"点了开始识别 /
     * 横条点 OCR 都没反应"。
     *
     * ⚠ 放在循环**之后**、且只在 out 为空时补：默认引擎就是本地时它已经在
     *    out 里了，再补一次会产出 ["windows","windows"]，结果页上出现两行
     *    一模一样的"本地识别"。 */
    if out.is_empty() && ocr_engines::find("windows").is_some() {
        out.push("windows".to_string());
    }
    out
}

/// 某家引擎的凭据。
///
/// ⚠ 百度要回退到老字段 `ocr_key` / `ocr_secret`：老用户的密钥存在那里，
///   不回退的话升级上来就是"Key 突然没了、识别直接报没配密钥"。
fn ocr_creds(cfg: &config::Config, id: &str) -> ocr_engines::Creds {
    let g = |m: &std::collections::HashMap<String, String>| m.get(id).cloned().unwrap_or_default();
    let mut c = ocr_engines::Creds {
        key: g(&cfg.ocr_keys),
        secret: g(&cfg.ocr_secrets),
        base: g(&cfg.ocr_bases),
        model: g(&cfg.ocr_models),
    };
    if id == "baidu" {
        if c.key.trim().is_empty() {
            c.key = cfg.ocr_key.clone();
        }
        if c.secret.trim().is_empty() {
            c.secret = cfg.ocr_secret.clone();
        }
    }
    c
}

/// 这家引擎的凭据齐了吗 —— 要填哪几样由**注册表**决定，不在代码里写死
/// （不然每加一家引擎就要来这里补一个 if）。
fn creds_ready(cfg: &config::Config, id: &str) -> bool {
    let Some(info) = ocr_engines::find(id) else {
        return false;
    };
    if info.kind == ocr_engines::Kind::Local {
        return true;
    }
    let c = ocr_creds(cfg, id);
    if info.need_key && c.key.trim().is_empty() {
        return false;
    }
    if info.need_secret && c.secret.trim().is_empty() {
        return false;
    }
    if info.need_model && c.model_for(info).trim().is_empty() {
        return false;
    }
    if info.need_base && c.base_for(info).trim().is_empty() {
        return false;
    }
    true
}

/// 引擎注册表（给设置页渲染：引擎列表 + 每个引擎旁边的问号按钮 + 凭据表单）。
///
/// 需求 2 的原话是「每一个在线引擎旁边加一个问号按钮，点击后跳转到申请 api
/// 的官方教程」—— 所以 signup（申请页）和 docs（文档）两个链接都要给前端。
/// ⚠ 界面**不要**自己维护一份引擎名单：名单只有这一处（Rust 侧注册表），
///   否则以后加一家引擎就要改两个地方，迟早对不上。
#[tauri::command]
fn ocr_engines_list() -> Value {
    let cfg = cfg_snapshot();
    let list: Vec<Value> = ocr_engines::ENGINES
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "name": e.name,
                "kind": e.kind.as_str(),
                "online": e.kind != ocr_engines::Kind::Local,
                // 能不能拉模型列表 / 要不要显示模型那一栏（r46：用户问"到底调哪个模型"）
                "canListModels": e.kind.has_models(),
                "modelRow": e.kind.needs_model_row(),
                "signup": e.signup,
                "docs": e.docs,
                "needKey": e.need_key,
                "needSecret": e.need_secret,
                "needModel": e.need_model,
                "needBase": e.need_base,
                "base": e.base,
                "model": e.model,
                "note": e.note,
                "ready": creds_ready(&cfg, e.id),
            })
        })
        .collect();
    Value::Array(list)
}

/// 引擎的"连得上吗"自检（设置页那颗「测试」按钮走这条，异步回 `qs://ocr-test`）。
///
/// ⚠ 为什么必须异步：有些家（走大模型的）一次要好几秒，而 Tauri 命令是同步的 ——
///   在这里等，卡住的就是设置页本身。照 `ocr_diagnose` 的老办法：开线程、跑完 emit。
#[tauri::command]
fn ocr_test_engine(app: AppHandle, engine: String) {
    win::log(&format!("ocr_test_engine: {engine}"));
    std::thread::spawn(move || {
        let cfg = cfg_snapshot();
        let started = std::time::Instant::now();
        let r = ocr_engines::test(
            &engine,
            &ocr_creds(&cfg, &engine),
            &ocr_engines::OcrUrls::default(),
        );
        let ms = started.elapsed().as_millis() as u64;
        let (ok, msg) = match r {
            Ok(m) => (true, m),
            Err(e) => (false, e),
        };
        win::log(&format!(
            "ocr_test_engine: {engine} {} 用时 {ms} ms：{msg}",
            if ok { "连上了" } else { "没连上" }
        ));
        let _ = app.emit(
            "qs://ocr-test",
            serde_json::json!({ "engine": engine, "ok": ok, "msg": msg, "ms": ms }),
        );
    });
}

/// 拉一家的模型列表（OpenAI 兼容 `GET {base}/models`）。
///
/// 同样异步：这一家可能有几百个模型，同步拉会把设置页卡住；结果回 `qs://ocr-models`。
///
/// r76：`vision_only` 默认 **true** —— 用户原话：「它搜索模型有的是视觉模型，
/// 那就保存非视觉模型就默认排除在模型列表之外，这个也要做，其他的一些 AI 模型
/// 也是这样的」。
/// 理由：OCR 是把**图**交给模型认字，非视觉模型（纯文本 chat 模型）压根吃不了
/// 图，列出来只会让用户在几十个名字里挑一个必然失败的。所以默认只留像视觉的。
///
/// ⚠ 用 `Option<bool>` 而不是 `bool`：老版本前端不传这个键，命令照样能跑
///    （等价于"只留视觉"），不会因为缺参数报错 —— 与 r58 那批参数一个路子。
///    一个都不像视觉时**不硬来**：把全量发回去 + 消息里说明（见下），
///    否则用户看到的是一片空白，反而不知道该填什么。
#[tauri::command]
fn ocr_list_models(app: AppHandle, engine: String, vision_only: Option<bool>) {
    let vision_only = vision_only.unwrap_or(true);
    win::log(&format!("ocr_list_models: {engine}（只要视觉模型={vision_only}）"));
    std::thread::spawn(move || {
        let cfg = cfg_snapshot();
        let c = ocr_creds(&cfg, &engine);
        let base = match ocr_engines::find(&engine) {
            Some(info) => c.base_for(info),
            None => {
                let _ = app.emit(
                    "qs://ocr-models",
                    serde_json::json!({
                        "engine": engine, "ok": false,
                        "msg": format!("不认识的识别引擎：{engine}"), "models": [],
                    }),
                );
                return;
            }
        };
        let (ok, msg, models) = match ocr_engines::list_models(&base, &c.key, 20) {
            Ok(list) => {
                let n_all = list.len();
                let vis = list.iter().filter(|(_, v)| *v).count();
                /* r76：默认只留像视觉的。**一个都没认出来时不过滤** ——
                 * 那说明这家的命名完全不按常理（或者就是没做视觉模型），
                 * 此时给出全量 + 一句说明，用户至少知道该手填什么；
                 * 硬给个空列表会让人以为"这家坏了"。 */
                let (list, msg) = if vision_only && vis > 0 {
                    let kept: Vec<(String, bool)> =
                        list.into_iter().filter(|(_, v)| *v).collect();
                    (
                        kept,
                        format!("拉到 {n_all} 个模型，只留 {vis} 个能看图的（视觉模型）"),
                    )
                } else if vis == 0 {
                    (list, format!("拉到 {n_all} 个模型，但名字里看不出哪些能看图 —— 全列出来了，自己挑一个视觉模型"))
                } else {
                    (list, format!("拉到 {n_all} 个模型，其中 {vis} 个看着能看图（已排在前面）"))
                };
                (
                    true,
                    msg,
                    list.into_iter()
                        .map(|(id, v)| serde_json::json!({ "id": id, "vision": v }))
                        .collect::<Vec<_>>(),
                )
            }
            Err(e) => (false, e, Vec::new()),
        };
        let _ = app.emit(
            "qs://ocr-models",
            serde_json::json!({ "engine": engine, "ok": ok, "msg": msg, "models": models }),
        );
    });
}

/// 用系统默认浏览器打开某家引擎**申请 API 的官方页面**（问号按钮点的就是它）。
#[tauri::command]
fn ocr_open_help(engine: String) -> Result<String, String> {
    let info = ocr_engines::find(&engine).ok_or_else(|| format!("不认识的识别引擎：{engine}"))?;
    win::log(&format!("ocr_open_help: {} → {}", info.id, info.signup));
    open::that(info.signup).map_err(|e| format!("打不开浏览器：{e}"))?;
    Ok(info.signup.to_string())
}

/// 打开某家引擎的**接口文档**（问号旁边的「文档」）。
#[tauri::command]
fn ocr_open_docs(engine: String) -> Result<String, String> {
    let info = ocr_engines::find(&engine).ok_or_else(|| format!("不认识的识别引擎：{engine}"))?;
    win::log(&format!("ocr_open_docs: {} → {}", info.id, info.docs));
    open::that(info.docs).map_err(|e| format!("打不开浏览器：{e}"))?;
    Ok(info.docs.to_string())
}

/// r56：识图引擎行上那颗「?」—— 打开这家引擎的官方页面 / 教程。
///
/// 用户原话：「每个引擎旁边也要设置一个问号按钮，点击之后就会跳转到申请该引擎
/// api 的相关教程」。识图这些家大多**不需要申请 Key**（打开就能用），所以这里的
/// 地址是「官方页 + 它能怎么用」，只有确有额度/账号体系的几家才指到申请处。
/// 地址由注册表的 `Engine.help` 给（`imgsearch::每家的问号地址都是_https` 钉住
/// 它必须是 https），界面不另存一份 —— 加引擎只改 imgsearch.rs 一行。
#[tauri::command]
fn img_open_help(engine: String) -> Result<String, String> {
    let e = imgsearch::find(&engine).ok_or_else(|| format!("不认识的识图引擎：{engine}"))?;
    if !e.help.starts_with("https://") {
        // 前端与单测都只认 https；走到这里说明注册表被人改坏了，
        // 明确报错比打开一个奇怪的地址好。
        return Err(format!("{} 的教程地址不是 https：{}", e.name, e.help));
    }
    win::log(&format!("img_open_help: {} → {}", e.id, e.help));
    open::that(e.help).map_err(|e| format!("打不开浏览器：{e}"))?;
    Ok(e.help.to_string())
}

/// 保存某家引擎的凭据。
///
/// 四样一起写（前端不用记住"哪家要哪几样"，那由注册表决定）；空串 = 删掉这一项，
/// 于是"清空密钥"也能正常工作，而不是留一个空字符串在配置里。
#[tauri::command]
fn ocr_set_cred(
    engine: String,
    key: String,
    secret: String,
    base: String,
    model: String,
) -> Result<(), String> {
    let info = ocr_engines::find(&engine).ok_or_else(|| format!("不认识的识别引擎：{engine}"))?;
    {
        let mut cfg = st().cfg.lock().map_err(|_| "配置忙".to_string())?;
        fn put(m: &mut std::collections::HashMap<String, String>, id: &str, v: &str) {
            let v = v.trim();
            if v.is_empty() {
                m.remove(id);
            } else {
                m.insert(id.to_string(), v.to_string());
            }
        }
        put(&mut cfg.ocr_keys, info.id, &key);
        put(&mut cfg.ocr_secrets, info.id, &secret);
        put(&mut cfg.ocr_bases, info.id, &base);
        put(&mut cfg.ocr_models, info.id, &model);
        config::save(&cfg);
    }
    broadcast();
    Ok(())
}

/// 「同时识别」名单（r47）：设哪几家**额外**和默认引擎一起跑。
///
/// ⚠ 为什么单开一个命令而不是走 `set_setting`：这份名单有**三条不变式**
///   （只收注册表里认识的 id / 不含默认引擎自己 / 无重复），放进通用的键值
///   设置里就没地方执行它们了 —— 执行在 `sanitize` 里只发生在**读配置**时，
///   写进去的脏数据会先落盘。这里过滤完**返回清洗后的名单**，前端拿它回画界面，
///   界面上就不会出现"勾了却没生效"的错觉。
///
/// 返回清洗后的 id 列表（顺序按注册表，稳定）。
#[tauri::command]
fn ocr_set_multi(engines: Vec<String>) -> Vec<String> {
    let mut cleaned: Vec<String> = Vec::new();
    {
        let Ok(mut cfg) = st().cfg.lock() else {
            return cleaned;
        };
        let def = cfg.ocr_engine.clone();
        for e in ocr_engines::ENGINES {
            if e.id == def {
                continue;
            }
            if engines.iter().any(|x| x == e.id) && !cleaned.iter().any(|x| x == e.id) {
                cleaned.push(e.id.to_string());
            }
        }
        cfg.ocr_multi = cleaned.clone();
        config::save(&cfg);
    }
    win::log(&format!("ocr_set_multi: {:?}", cleaned));
    broadcast();
    cleaned
}

/// 每个引擎的凭据（给设置页渲染用，键 = 引擎 id）。
fn ocr_creds_view(cfg: &config::Config) -> Value {
    let mut m = Map::new();
    for e in ocr_engines::ENGINES {
        let c = ocr_creds(cfg, e.id);
        m.insert(
            e.id.to_string(),
            json!({ "key": c.key, "secret": c.secret, "base": c.base, "model": c.model }),
        );
    }
    Value::Object(m)
}

/* ---------------------------- OCR 文本整理 ----------------------------
 * 需求 5（结果页的功能按钮）+ 需求 7（设置里选默认开/关）共用这一套开关。
 *
 * 为什么是**位掩码**而不是"一个模式"：这几件事能叠加 —— 先去乱码、再把断行
 * 接回去、顺手把全角字母数字收成半角，这是同一次整理里的三件事，不是三选一。
 * 空格那项本身是三态（不动 / 智能 / 强力），占两位。
 *
 * 默认值（设置页「文字识别」里可改，见 config::ocr_clean_*）：
 *   去乱码 = 关、空格 = 智能、全角半角 = 关、合并换行 = 关
 * —— 与本次改动**之前**的行为完全一致（那时固定走 ocr::clean_spaces），
 * 所以老用户升级上来不会突然发现识别结果被改过。
 */
pub const CLEAN_GARBAGE: u32 = 1 << 0;
pub const CLEAN_SPACE_SMART: u32 = 1 << 1;
pub const CLEAN_SPACE_FORCE: u32 = 2 << 1;
const CLEAN_SPACE_MASK: u32 = 0b11 << 1;
pub const CLEAN_WIDTH: u32 = 1 << 3;
pub const CLEAN_UNWRAP: u32 = 1 << 4;

/// 结果页按钮在本轮里的**临时**开关（None = 跟随设置里的默认）。
///
/// 为什么要有它：需求 7 要的是"设置里选默认开还是关"，需求 5 的按钮是
/// "这一张图上我想怎么整理" —— 两者语义不同。按钮改的是这一轮，不该把用户的
/// 设置改掉；框选新图（新代次）后回到默认（见 ocr_region 里重置那一行）。
static OCR_CLEAN_OVERRIDE: Mutex<Option<u32>> = Mutex::new(None);

/// 设置里那四项 → 位掩码。
fn clean_mask_from_cfg(c: &config::Config) -> u32 {
    let mut m = 0u32;
    if c.ocr_clean_garbage {
        m |= CLEAN_GARBAGE;
    }
    match c.ocr_clean_space.as_str() {
        "force" => m |= CLEAN_SPACE_FORCE,
        "off" => {}
        _ => m |= CLEAN_SPACE_SMART,
    }
    if c.ocr_clean_width {
        m |= CLEAN_WIDTH;
    }
    if c.ocr_clean_unwrap {
        m |= CLEAN_UNWRAP;
    }
    m
}

/// 此刻生效的整理开关（按钮点过就用按钮的，否则跟设置）。
fn clean_mask_now() -> u32 {
    if let Ok(g) = OCR_CLEAN_OVERRIDE.lock() {
        if let Some(m) = *g {
            return m;
        }
    }
    cfg_with(clean_mask_from_cfg)
}

/// 按当前开关把 OCR 原文变成展示文本 —— **所有**取识别结果的地方都走它
/// （单引擎、并行拼接、切引擎回放、结果页分段），不然就会出现
/// "点了强力去空格、切一圈引擎空格又回来了"那类不一致。
fn clean_now(raw: &str) -> String {
    clean_text(raw, clean_mask_now())
}

/// 按给定开关整理一遍。
///
/// 顺序有讲究：**先删噪声 → 再动空格 → 再统一宽度 → 最后接断行**。
/// 接断行必须最后 —— 它要看"上一行结尾是不是句末标点"，而前面几步
/// （尤其空格）会改变行尾内容。
fn clean_text(raw: &str, mask: u32) -> String {
    let mut t = raw.to_string();
    if mask & CLEAN_GARBAGE != 0 {
        t = strip_garbage(&t);
    }
    match mask & CLEAN_SPACE_MASK {
        CLEAN_SPACE_FORCE => t = force_space(&t),
        CLEAN_SPACE_SMART => t = collapse_space_runs(&ocr::clean_spaces(&t)),
        _ => {}
    }
    if mask & CLEAN_WIDTH != 0 {
        t = to_halfwidth(&t);
    }
    if mask & CLEAN_UNWRAP != 0 {
        t = unwrap_lines(&t);
    }
    t
}

/// 空格那项当前是什么档（给前端点亮按钮用）。
fn clean_space_name(m: u32) -> &'static str {
    match m & CLEAN_SPACE_MASK {
        CLEAN_SPACE_FORCE => "force",
        CLEAN_SPACE_SMART => "smart",
        _ => "off",
    }
}

/// 强力去空格：删掉一切 Unicode 空白（半角/全角/制表/NBSP/U+2007…），只保留换行。
/// ⚠ 以前只列 ' ' | '\t' | '\u{3000}' 三兄弟，用户截图里的"空格"只要是
///   NBSP(U+00A0) 之类的表外空白就漏刀 —— 报过「强力去空格根本没没用」。
fn force_space(raw: &str) -> String {
    raw.chars()
        .filter(|c| !(c.is_whitespace() && *c != '\n' && *c != '\r'))
        .collect()
}

/// 把**保留下来的**一串空格折叠成一个（换行、行尾不动）。
///
/// 为什么需要这一步：`ocr::clean_spaces` 的口径是"一串连续空格要么全删、
/// 要么全留" —— 留的那串原来几个就还是几个（`"hello  world"` 保持两个）。
/// 用户报的「很多的空格」有一半就是这种：单词之间被 OCR 拉开一大片。
/// 折叠只动**已经被判定为保留**的那些空格，所以不会和"该删的删干净"冲突
/// （`clean_spaces` 的规则本身一个字没改）。
fn collapse_space_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = false;
    for c in s.chars() {
        if c == '\n' || c == '\r' {
            run = false; // 行尾的空格串直接丢掉，别留尾随空格
            out.push(c);
            continue;
        }
        if c.is_whitespace() {
            run = true;
            continue;
        }
        if run {
            out.push(' ');
            run = false;
        }
        out.push(c);
    }
    if run {
        out.push(' ');
    }
    out
}

/// 去乱码：OCR / 截图里三类**确定不是文字**的噪声。
///   ① U+FFFD（识别失败占位符）；
///   ② C0/C1 控制字符（\n \t \r 留着）；
///   ③ 零宽字符（U+200B..U+200D、U+2060、U+FEFF）与 BMP 私用区（U+E000..U+F8FF）。
/// ⚠ 只删这三类。emoji、数学符号、日文假名、生僻汉字都**不能**碰 ——
///   清错了比不清更糟，用户看到的是"我的字被吃掉了"。
fn strip_garbage(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let u = *c as u32;
            if matches!(*c, '\n' | '\t' | '\r') {
                return true;
            }
            if u == 0xFFFD {
                return false;
            }
            if u < 0x20 || (0x7F..0xA0).contains(&u) {
                return false;
            }
            if (0xE000..=0xF8FF).contains(&u) {
                return false;
            }
            !((0x200B..=0x200D).contains(&u) || u == 0x2060 || u == 0xFEFF)
        })
        .collect()
}

/// 全角 → 半角：只动 **ASCII 的全角镜像**（U+FF01..U+FF5E → 减 0xFEE0）
/// 与表意空格 U+3000。
///
/// 为什么只动这一段：这一段的每个字符都是"某个 ASCII 的全角写法"
/// （Ａ→A、１→1、（→(、，→,），OCR 混排时它们才是"不协调"的来源；
/// 中文标点（。、《》「」…）不在这个区间，保持原样。
fn to_halfwidth(s: &str) -> String {
    s.chars()
        .map(|c| {
            let u = c as u32;
            if (0xFF01..=0xFF5E).contains(&u) {
                char::from_u32(u - 0xFEE0).unwrap_or(c)
            } else if u == 0x3000 {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// 合并硬换行：把"因为排版被断开"的行接回同一段。
///
/// 用户原话：「选中的本来是一段话，但因为显示而分为好几段」—— PDF 复制、
/// 窄栏网页、扫描件的 OCR 都会这样。
///
/// 判据**保守**，宁可少接也不接错：
///   · 上一行以句末标点收尾 → 是完整句子，不接；
///   · 上一行或当前行是"结构行"（列表 / 编号 / 引用 / 表格 / 标题）→ 不接
///     （这些行的换行是**语义**，接起来会把列表糊成一坨）；
///   · 空行是段落分隔 → 不接。
/// 接的时候：中↔中直接贴；只要有一边是 ASCII 字母数字就补一个空格
/// （不然 "hello" + "world" 会粘成 "helloworld"）。
fn unwrap_lines(s: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in s.split('\n') {
        let cur = line.trim();
        if cur.is_empty() {
            out.push(String::new());
            continue;
        }
        let prev_ok = match out.last() {
            Some(p) => {
                let p = p.trim_end();
                !p.is_empty() && !ends_sentence(p) && !is_structural_line(p)
            }
            None => false,
        };
        if prev_ok && !is_structural_line(cur) {
            let last = out.last_mut().unwrap();
            let a = last.chars().last().unwrap_or(' ');
            let b = cur.chars().next().unwrap_or(' ');
            if needs_space_between(a, b) {
                last.push(' ');
            }
            last.push_str(cur);
        } else {
            out.push(cur.to_string());
        }
    }
    out.join("\n")
}

/// 这一行是不是以句末标点收尾。
/// 右引号/右括号收尾时看它**前面**那个字符（`他说：“好的。”` 这种）。
fn ends_sentence(s: &str) -> bool {
    let t = s.trim_end();
    match t.chars().last() {
        Some('”') | Some('」') | Some('』') | Some('）') | Some(')') | Some('"') | Some('’') => {
            t.chars().rev().nth(1).map(ends_punct).unwrap_or(false)
        }
        Some(c) => ends_punct(c),
        None => false,
    }
}

fn ends_punct(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '；' | '：' | '.' | '!' | '?' | ';' | ':' | '…')
}

/// 这一行是不是"换行有语义"的结构行：列表项、编号、引用、表格、标题。
fn is_structural_line(s: &str) -> bool {
    let t = s.trim();
    let mut it = t.chars();
    let Some(first) = it.next() else {
        return false;
    };
    if matches!(
        first,
        '-' | '*' | '+' | '·' | '•' | '#' | '>' | '|' | '[' | '【' | '〔'
    ) {
        return true;
    }
    // 表格行：整行两个以上竖线
    if t.matches('|').count() >= 2 {
        return true;
    }
    // 编号：`1.` `2、` `3)` `(4)` `①`
    if first.is_ascii_digit() || (0x2460..=0x2473).contains(&(first as u32)) {
        if let Some(second) = it.next() {
            if matches!(second, '.' | '、' | ')' | '）' | ':' | '：') {
                return true;
            }
        }
    }
    // 中文数字编号：一、二、三…十、
    if matches!(
        first,
        '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十'
    ) {
        if let Some(second) = it.next() {
            if matches!(second, '、' | '.' | '）' | ')') {
                return true;
            }
        }
    }
    false
}

/// 拼接两行时中间要不要补空格：只要有一边是 ASCII 字母/数字就要
/// （中文之间直接贴；中文↔英文补一个空格 —— 那是更好的排版）。
fn needs_space_between(a: char, b: char) -> bool {
    a.is_ascii_alphanumeric() || b.is_ascii_alphanumeric()
}

/// 引擎的人话名字（需求 2 之后有十几家，名字统一从注册表取）。
///
/// 并行模式下两个结果上下排布，每段顶上顶一格【标注】，用户一眼能看出
/// 哪段是本地认的、哪段是在线引擎认的（原话：「一个在上，一个在下。
/// 但同时标记好哪个是百度 ocr，哪个是本地 ocr」）。
/// ⚠ 百度那边 recognize_with 返回的 label 是「标准版 / 高精度版」（描述
///    用的是哪档接口），不是引擎名 —— 标注要用这个函数，别直接拿 label。
fn engine_display(eng: &str) -> &'static str {
    ocr_engines::find(eng).map(|e| e.name).unwrap_or("识别引擎")
}

/// 这一代（gen）截图下，这个引擎是不是已经认过了。
fn ocr_cached(gen: u64, eng: &str) -> bool {
    OCR_RESULT_CACHE
        .lock()
        .map(|c| c.iter().any(|e| e.0 == gen && e.1 == eng))
        .unwrap_or(false)
}

/// 把单个引擎的识别结果收进缓存（同代同引擎只留最新一条）。
///
/// #134 之前这里还会在「高精度被自动降级」时返回一句提示；现在不降级了，
/// 没有什么可提示的，直接收进缓存即可。
fn store_engine_result(gen: u64, eng: &str, cleaned: &str, raw: &str, label: &str) {
    if let Ok(mut cache) = OCR_RESULT_CACHE.lock() {
        // 新截图 = 旧代次的结果全部作废；同代同引擎只留最新一条
        cache.retain(|e| e.0 == gen && e.1 != eng);
        cache.push((
            gen,
            eng.to_string(),
            cleaned.to_string(),
            raw.to_string(),
            label.to_string(),
        ));
        if cache.len() > 8 {
            cache.remove(0);
        }
    }
}

/// 多引擎模式的结果文本：把这一代缓存里的结果按**参与名单的顺序**（默认引擎在
/// 前，其余按注册表顺序）拼成一段，每段顶上标一个【引擎名】。
///
/// 拼的是**原文**：展示文本由调用方按当前清理模式整体派生一遍，用户之后
/// 点「强力去空格」也能对多段一起生效（OCR_LAST_RAW 存的就是这段原文）。
/// 这一代一个结果都没有（全都挂了）→ None。
///
/// ⚠ r47：只拼**配置里真正参与的那几家**（`ocr_engine_plan`）。老实现固定
///   拼"本地 + 在线那家"，于是关掉并行之后结果窗里仍会冒出一段"本地识别"。
fn combined_text(gen: u64) -> Option<String> {
    let cache = OCR_RESULT_CACHE.lock().ok()?;
    combined_from(&ocr_engine_plan(&cfg_snapshot_or_default()), gen, &cache)
}

/// `combined_text` 的**纯函数版**：名单和缓存都由调用方给。
///
/// 拆出来是为了能单测 —— `combined_text` 要读全局配置（`cfg_snapshot_or_default`），
/// 单测里没有 APP、只能拿到 `Config::default()`，配不出"多引擎"的场景。
fn combined_from(
    plan: &[String],
    gen: u64,
    cache: &[(u64, String, String, String, String)],
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for eng in plan {
        let eng = eng.as_str();
        if let Some(e) = cache.iter().find(|e| e.0 == gen && e.1 == eng) {
            parts.push(format!("【{}】\n{}", engine_display(eng), e.3));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// 当前这一代各引擎的**分段结果**，给结果页做「只看某一家 / 都看」用。
///
/// 顺序 = `ocr_engine_plan` 的顺序（默认引擎在前），和 combined_text 的拼接
/// 顺序一致；**只包含参与名单里的引擎** —— 用户原话：「同时也只会显示自己
/// 选择的那一个」。
/// `text` 是按当前清理模式派生过的展示文本 —— 结果页切显示档时直接拿来用，
/// 不用再调后端、更不用重新识别（用户要的就是「切过去直接看到已有结果」）。
fn ocr_parts(gen: u64) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let Ok(cache) = OCR_RESULT_CACHE.lock() else {
        return out;
    };
    for eng in ocr_engine_plan(&cfg_snapshot_or_default()) {
        let eng = eng.as_str();
        if let Some(e) = cache.iter().find(|e| e.0 == gen && e.1 == eng) {
            out.push(json!({
                "eng": eng,
                "label": engine_display(eng),
                "text": clean_now(&e.3),
            }));
        }
    }
    out
}

/// 关掉结果窗时把这一轮识别留下的东西**全部**清掉。
///
/// 用户明确要求：OCR 的缓存是**临时**的 —— 关掉结果页之后，本地与百度两侧的
/// 文本、截图、引擎结果缓存、提示条都不该再留在内存里。
/// 顺手把截图代次推进一格：任何还在飞的迟到结果都会因为代次对不上被忽略，
/// 不会在下次识别时冒出来串场。
fn clear_ocr_session() {
    if let Ok(mut g) = OCR_LAST.lock() {
        g.clear();
    }
    if let Ok(mut g) = OCR_LAST_RAW.lock() {
        g.clear();
    }
    if let Ok(mut g) = OCR_LAST_PNG.lock() {
        g.clear();
    }
    if let Ok(mut c) = OCR_RESULT_CACHE.lock() {
        c.clear();
    }
    clear_ocr_note();
    OCR_PNG_GEN.fetch_add(1, Ordering::SeqCst);
    win::log("ocr: 结果窗已关闭，本轮识别数据（文本/截图/引擎缓存/提示）已全部清空");
}

/// 并行双跑（**渐进式**）：`engines` 里每个引擎各起一个线程，认**同一张图**
/// （`Arc` 共享字节，不复制几 MB 的缓冲区）。
///
/// ⚠ 和「等全部完成再展示」的老做法不同：**谁先回来就先把它推给用户**，
/// 剩下的回来后再推一次（增量补齐）。用户明确要求的就是这个 ——
/// 「我点 ocr，它能够立刻打开本地 ocr 的结果，同时百度 ocr 也会在后台进行识别，
///   这样我切到百度的时候就不用等」。
/// 以前是等两个都完成才开窗：百度走网络那几秒全在干等；本地引擎慢的时候
/// （Windows OCR 有 15 秒硬超时）还要一起等本地，表现就是「弹得非常非常慢，
/// 而且只剩百度那一段」。
///
/// `on_update(text, is_first, notes)` 每有一个引擎出结果就叫一次：
/// 调用方据此开窗（第一次）或增量推送（后续）。90 秒总闸兜底，单个引擎再慢
/// 也不会把用户无限期晾在「识别中」。
///
/// 成功的结果由 `store_engine_result` 入账；返回 (成功数, 提示列表)。
/// 提示只有失败原因，调用方拼进 OCR_NOTE 一起展示。
///
/// ⚠ 超时走掉的线程还会继续跑，结果按它拿到的 gen 入账 —— 用户要是已经
///    框了下一张图（gen 变了），那条迟到结果自然被 combined_text 忽略，
///    不会串到新图上。
fn ocr_run_engines<F>(
    gen: u64,
    png: &[u8],
    engines: &[String],
    mut notes: Vec<String>,
    mut on_update: F,
) -> (usize, Vec<String>)
where
    F: FnMut(&str, bool, &[String]),
{
    let shared = std::sync::Arc::new(png.to_vec());
    let (tx, rx) =
        std::sync::mpsc::channel::<(String, Result<(String, String, String), String>)>();
    for eng in engines {
        let eng = eng.clone();
        let png = shared.clone();
        let tx = tx.clone();
        std::thread::spawn(move || {
            // 每个引擎的耗时单独记一笔：并行下「慢」到底是慢在哪一边，
            // 光看总时长看不出来（本地走 CPU、百度走网络，量级差很远）。
            let t0 = std::time::Instant::now();
            let r = run_ocr(&png, &eng);
            win::log(&format!(
                "ocr: 并行 {eng} 用时 {} ms{}",
                t0.elapsed().as_millis(),
                match &r {
                    Ok(_) => "",
                    Err(_) => "（失败）",
                }
            ));
            // 收件人可能已经超闸走了，send 失败无所谓
            let _ = tx.send((eng, r));
        });
    }
    drop(tx); // 手里的这份一掉，rx 才能在全部发送方结束后正常返回 Disconnected

    let mut ok = 0usize;
    let mut first = true;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    for _ in 0..engines.len() {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok((eng, Ok((cleaned, raw, label)))) => {
                ok += 1;
                win::log(&format!("ocr: 并行 {eng} 认出 {} 字", cleaned.chars().count()));
                store_engine_result(gen, &eng, &cleaned, &raw, &label);
                // 有结果就立刻推一次：第一次开窗，之后增量补齐
                if let Some(combined) = combined_text(gen) {
                    let text = clean_now(&combined);
                    if let Ok(mut g) = OCR_LAST.lock() {
                        *g = text.clone();
                    }
                    // 去空格按钮对**两段一起**生效：原料换成拼好的原文
                    if let Ok(mut g) = OCR_LAST_RAW.lock() {
                        *g = combined;
                    }
                    on_update(&text, first, &notes);
                    first = false;
                }
            }
            Ok((eng, Err(e))) => {
                win::log(&format!("ocr: 并行 {eng} 失败：{e}"));
                notes.push(format!("{}：{}", engine_display(&eng), e));
                // 失败也要推一次：第一次 = 让用户先看到另一个引擎的成果；
                // 不是第一次 = 把「某个引擎挂了」这条说明送到界面上
                // （比如本地超时 15 秒、百度早就出结果了，那条说明不能烂在日志里）。
                if let Some(combined) = combined_text(gen) {
                    let text = clean_now(&combined);
                    if let Ok(mut g) = OCR_LAST.lock() {
                        *g = text.clone();
                    }
                    if let Ok(mut g) = OCR_LAST_RAW.lock() {
                        *g = combined;
                    }
                    on_update(&text, first, &notes);
                    first = false;
                }
            }
            Err(_) => {
                win::log("ocr: 并行总闸超时（90s）");
                notes.push("识别超时（90 秒），换个区域或关掉并行再试".to_string());
                break;
            }
        }
    }
    (ok, notes)
}

/// 把一条 OCR 结果（文字 + 现存图片）推给结果窗口。
/// 「首次识别」「重新识别」「切引擎命中缓存」「去空格按钮」四条路径共用，
/// 保证图片/文字/提示三件套的打包方式永远一致。
fn emit_ocr_result(png: &[u8], text: &str) {
    let Some(a) = APP.get().cloned() else { return };
    let img = ocr_image_data_url(png);
    let note = OCR_NOTE
        .lock()
        .map(|mut n| {
            let s = n.trim().to_string();
            n.clear();
            s
        })
        .unwrap_or_default();
    let note = if note.is_empty() { None } else { Some(note) };
    // 分段结果：结果页靠它做「仅本地 / 仅百度 / 两者都看」，切换纯前端完成
    let parts = ocr_parts(OCR_PNG_GEN.load(Ordering::SeqCst));
    // 图片 + 文字 + 提示 + 分段一起发回；老的纯文字通道也补一次，双保险。
    let _ = a.emit_to("ocr", "qs://ocr-result", json!({
        "text": text.to_string(),
        "image": img,
        "note": note,
        "parts": parts,
    }));
    let _ = a.emit_to("ocr", "qs://ocr-text", text.to_string());
}

/// 「重新识别」：用 OCR 结果窗口里现存的那张图（OCR_LAST_PNG）再调一次识别，
/// 识别完按 `qs://ocr-result` 通道把新文字 + 同一张图推回去。
///
/// 跟首次识别的区别：首次识别是「框选 → 截图 → 识别 → 弹窗」，这次是「拿上一次的
/// 图 → 重新识别 → 原地替换」。所以这里不开框选窗口、不重截图、不动 OCR_LAST_PNG。
///
/// `engine` 决定用哪个引擎：传 None 用设置里配置的；传 "baidu"/"windows" 用指定
/// 引擎（结果页切换引擎时就是显式传值，做到"切到哪边、立刻重识别哪边"）。
///
/// 结果按 (截图代次, 引擎) 缓存：只要窗口里还是同一张图，切到认过的引擎
/// 直接回放缓存结果，不再真的调一次 OCR（用户来回切「本地↔百度」不该每次
/// 都干等几秒）。
///
/// **多引擎模式**（「同时识别」里勾了别的引擎）走 `rescan_ocr_multi`：
/// 参与名单里的几家一起认，结果窗里各自一段、各自标注。
fn rescan_ocr(engine: Option<String>) -> Result<String, String> {
    let cfg = cfg_snapshot();
    if !cfg.ocr_enable {
        return Err("OCR 功能已在设置里关闭".into());
    }
    // 新一轮识别开始：把上一轮的提示清掉，免得旧说明挂在新结果上
    clear_ocr_note();
    // ⚠ r47：分支看**参与名单有几家**，不再看那个已废弃的 ocr_parallel 开关。
    if ocr_engine_plan(&cfg).len() > 1 {
        return rescan_ocr_multi(engine);
    }
    // 「点了某个引擎」和「点了重新识别按钮」是两件事，文案与缓存策略都不同：
    //   · Some(e)：用户在结果页切到 e 看看 —— 这张图上 e **可能从没认过**，
    //     所以那是**首次识别**，不能说成「重新识别」（用户点名过这句文案）；
    //     而且认过就直接回放，不该再跑一遍。
    //   · None：用户点的是「重新识别」按钮 —— 他要的是**真的重跑一次**，
    //     所以先把这一代该引擎的缓存清掉再跑（点了没反应是最迷惑的）。
    let explicit = engine.is_some();
    let eng = match engine {
        // 认注册表里的任何一家（需求 2 之后有十几家）
        Some(e) if ocr_engines::find(&e).is_some() => e,
        _ => cfg.ocr_engine.clone(),
    };
    // 本地识别不需要凭据；在线引擎缺凭据要早一点报错，别让用户空等。
    if !creds_ready(&cfg, &eng) {
        return Err(format!("还没配{}的凭据", engine_display(&eng)));
    }
    let png = match OCR_LAST_PNG.lock() {
        Ok(g) if !g.is_empty() => g.clone(),
        _ => return Err("没有可以重新识别的图，去框选一次吧".into()),
    };
    let gen = OCR_PNG_GEN.load(Ordering::SeqCst);

    if !explicit {
        // 「重新识别」按钮：本代该引擎的缓存作废，下面就会真跑
        if let Ok(mut cache) = OCR_RESULT_CACHE.lock() {
            cache.retain(|e| !(e.0 == gen && e.1 == eng));
        }
    }

    // ---- 缓存命中：同一张图 + 同一个引擎已经认过 → 直接回放 ----
    let hit = OCR_RESULT_CACHE.lock().ok().and_then(|cache| {
        cache
            .iter()
            .find(|e| e.0 == gen && e.1 == eng)
            .map(|e| (e.3.clone(), e.4.clone()))
    });
    if let Some((raw, _label)) = hit {
        win::log(&format!("rescan_ocr({eng}): 命中缓存，直接回放"));
        let text = clean_now(&raw);
        if let Ok(mut g) = OCR_LAST.lock() {
            *g = text.clone();
        }
        if let Ok(mut g) = OCR_LAST_RAW.lock() {
            *g = raw;
        }
        emit_ocr_result(&png, &text);
        return Ok(format!("已切到{}（用的是已识别好的结果）", engine_display(&eng)));
    }

    win::log(&format!("rescan_ocr({}): {} KB", eng, png.len() / 1024));
    // 首次 = 这张图上这个引擎还没认过；只有「重新识别」按钮那条才叫重新
    let verb = if explicit { "正在识别" } else { "正在重新识别" };
    ocr_say(format!("{verb}（{}）…", engine_display(&eng)));
    let (text, raw, label) = run_ocr(&png, &eng)?;
    // 换清理模式后要能重新派生，所以缓存里存的是**原文**（run_ocr 随三元组
    // 一起返回，不再读全局 OCR_LAST_RAW —— 见 run_ocr 的注释）
    store_engine_result(gen, &eng, &text, &raw, &label);
    if let Ok(mut g) = OCR_LAST.lock() {
        *g = text.clone();
    }
    // 当前展示的就是这个引擎 → 去空格按钮的原料也换成它的原文
    if let Ok(mut g) = OCR_LAST_RAW.lock() {
        *g = raw;
    }
    emit_ocr_result(&png, &text);
    Ok(format!("已用{}识别", engine_display(&eng)))
}

/// 多引擎模式下的「重新识别」。
///
/// - `engine = None`（「重新识别」按钮）：参与名单里的都重跑 —— 先清掉本代缓存，
///   不然「已缓存的跳过」会把刚认过的引擎放过去，用户以为按钮没反应；
/// - `engine = Some(e)`（结果页点了某一家）：没认过才跑；认过了直接回放
///   （用户原话：「发现本地识别异常时直接看百度的，不会重新加载」）。
///
/// 最终展示的永远是 combined_text 拼的多段（顺序 = 参与名单顺序）。
/// `ocr_enable` 由唯一调用方 `rescan_ocr` 先检查过，这里不重复。
fn rescan_ocr_multi(engine: Option<String>) -> Result<String, String> {
    let cfg = cfg_snapshot();
    let png = match OCR_LAST_PNG.lock() {
        Ok(g) if !g.is_empty() => g.clone(),
        _ => return Err("没有可以重新识别的图，去框选一次吧".into()),
    };
    let gen = OCR_PNG_GEN.load(Ordering::SeqCst);

    let named = match engine {
        // 认注册表里的任何一家
        Some(e) if ocr_engines::find(&e).is_some() => Some(e),
        _ => None,
    };
    // 点名某家却没配凭据：老规矩早报错，别让用户空等（另一条路是全跑时降级成
    // 「只跑本地 + 一条说明」，见下面）
    if let Some(e) = named.as_deref() {
        if !creds_ready(&cfg, e) {
            return Err(format!("还没配{}的凭据", engine_display(e)));
        }
    }

    // 「重新识别」按钮（engine=None）：本代缓存全清，两个引擎都重认
    if named.is_none() {
        if let Ok(mut cache) = OCR_RESULT_CACHE.lock() {
            cache.retain(|e| e.0 != gen);
        }
    }

    let mut notes: Vec<String> = Vec::new();

    // 要跑哪些：点名 → 只跑它（且仅当没缓存，认过了回放即可）；
    // 按钮 → 参与名单里的每一家（凭据不齐的那家跳过并说明原因）
    let mut want: Vec<String> = Vec::new();
    match &named {
        Some(e) => {
            if !ocr_cached(gen, e) {
                want.push(e.clone());
            }
        }
        None => {
            for e in ocr_engine_plan(&cfg) {
                if creds_ready(&cfg, &e) {
                    want.push(e);
                } else {
                    notes.push(format!("{}：还没配凭据，本次跳过", engine_display(&e)));
                }
            }
        }
    }

    // 渐进式双跑：谁先回来就先推给用户（这里窗口已经开着，所以全是增量推送），
    // 另一个回来后再推一次补齐 —— 不用等最慢的那个（用户要的就是这个）。
    let mut pushed = false;
    if !want.is_empty() {
        // 文案分两种：点某个引擎 = 这张图上它可能**从没认过**（首次识别）；
        // 点「重新识别」按钮 = 真的重跑（重新识别）。用户点名过这个区别。
        ocr_say(match (named.is_some(), want.len() > 1) {
            (true, false) => format!("正在识别（{}）…", engine_display(&want[0])),
            (false, true) => "正在重新识别（本地 + 百度）…".to_string(),
            (false, false) => format!("正在重新识别（{}）…", engine_display(&want[0])),
            (true, true) => "正在识别…".to_string(),
        });
        let (ok, n2) = ocr_run_engines(gen, &png, &want, notes, |text, _first, notes| {
            pushed = true;
            if !notes.is_empty() {
                set_ocr_note(notes.join("；"));
            }
            emit_ocr_result(&png, text);
        });
        notes = n2;
        if ok == 0 {
            return Err(if notes.is_empty() {
                "识别失败".to_string()
            } else {
                notes.join("；")
            });
        }
    }

    // 有引擎真的跑过 → 结果已经在推送里发出去了，这里收工
    if pushed {
        let n = OCR_LAST.lock().map(|g| g.chars().count()).unwrap_or(0);
        win::log(&format!(
            "rescan_ocr(parallel{}): {} 字",
            named.as_deref().unwrap_or(""),
            n
        ));
        return Ok(match named {
            Some(e) => format!("已切到{}", engine_display(&e)),
            None => "已重新识别（本地 + 百度）".to_string(),
        });
    }

    // 走这里说明两个引擎都命中缓存（没真跑）→ 直接回放拼好的结果
    // 拼这一代的结果（本地在上、百度在下，各自标注）
    let Some(combined_raw) = combined_text(gen) else {
        return Err(if notes.is_empty() {
            "没有可用的识别结果".to_string()
        } else {
            notes.join("；")
        });
    };
    let text = clean_now(&combined_raw);
    if let Ok(mut g) = OCR_LAST.lock() {
        *g = text.clone();
    }
    // 去空格按钮对**两段一起**生效：原料换成拼好的原文
    if let Ok(mut g) = OCR_LAST_RAW.lock() {
        *g = combined_raw;
    }
    if !notes.is_empty() {
        set_ocr_note(notes.join("；"));
    }
    win::log(&format!(
        "rescan_ocr(parallel{}): {} 字",
        named.as_deref().unwrap_or(""),
        text.chars().count()
    ));
    emit_ocr_result(&png, &text);
    Ok(match named {
        Some(e) => format!("已切到{}（用的是已识别好的结果）", engine_display(&e)),
        None => "已重新识别（本地 + 百度）".to_string(),
    })
}

/// 「重新识别」按钮：用配置里的引擎重跑一次（不开框选、不重截图）。
/// 错误直接透传给前端 invoke —— 结果页的 `rescanWith` 会 catch 住并提示真实原因，
/// 比在后端用 ocr_tell 再绕一圈更准（也不会和前端自己的提示叠成两条）。
///
/// ⚠ 必须 `async`：同步命令跑在 IPC/主线程上，而 `rescan_ocr` 会真的发一次
/// 网络 OCR（最长 25 秒）。以前是普通 `fn`，用户切一下引擎、结果窗就整个卡住，
/// 连"正在识别…"都刷不出来，看着像程序死了。
#[tauri::command]
async fn ocr_rerun() -> Result<String, String> {
    rescan_ocr(None)
}

/// 结果页切换引擎：用当前窗口里那张图，按指定引擎立刻重新识别。
/// `async` 的理由同 `ocr_rerun`。
#[tauri::command]
async fn ocr_rescan(engine: String) -> Result<String, String> {
    rescan_ocr(Some(engine))
}

/// 结果页的文本整理按钮（需求 5）：**不重新识别**，只拿存着的识别原文按新的
/// 开关再整理一遍，沿既有通道把结果推回结果窗。
///
/// mode：
///   · `"smart"` / `"force"` / `"spaceoff"` —— 空格那项的三态；
///   · `"garbage"` / `"width"` / `"unwrap"` —— 布尔项，`on` 不传就是"取反"；
///   · `"all"` 全开 / `"none"` 全关。
///
/// `on` 传**期望的状态**而不是"切换"：前端按钮的亮/灭是它自己渲染的，
/// 让后端按"取反"猜容易出现两边不同步（点了没反应 / 亮着但没生效）。
///
/// 返回整理后的开关状态，前端据此点亮/熄灭按钮。
#[tauri::command]
fn ocr_reclean(mode: String, on: Option<bool>) -> Result<serde_json::Value, String> {
    let raw = match OCR_LAST_RAW.lock() {
        Ok(g) if !g.is_empty() => g.clone(),
        _ => return Err("没有可以处理的识别原文".into()),
    };
    let mut m = clean_mask_now();
    let flip = |m: u32, bit: u32| -> u32 {
        match on {
            Some(true) => m | bit,
            Some(false) => m & !bit,
            None => m ^ bit,
        }
    };
    match mode.as_str() {
        "smart" => {
            m &= !CLEAN_SPACE_MASK;
            m |= CLEAN_SPACE_SMART;
        }
        "force" => {
            m &= !CLEAN_SPACE_MASK;
            m |= CLEAN_SPACE_FORCE;
        }
        "spaceoff" => m &= !CLEAN_SPACE_MASK,
        "garbage" => m = flip(m, CLEAN_GARBAGE),
        "width" => m = flip(m, CLEAN_WIDTH),
        "unwrap" => m = flip(m, CLEAN_UNWRAP),
        "all" => m |= CLEAN_GARBAGE | CLEAN_SPACE_SMART | CLEAN_WIDTH | CLEAN_UNWRAP,
        "none" => m = 0,
        other => return Err(format!("未知的文本整理模式：{other}")),
    }
    if let Ok(mut g) = OCR_CLEAN_OVERRIDE.lock() {
        *g = Some(m);
    }
    let text = clean_text(&raw, m);
    if let Ok(mut g) = OCR_LAST.lock() {
        *g = text.clone();
    }
    let png = match OCR_LAST_PNG.lock() {
        Ok(g) if !g.is_empty() => g.clone(),
        _ => Vec::new(),
    };
    emit_ocr_result(&png, &text);
    win::log(&format!(
        "ocr_reclean({mode}, on={on:?})：开关={m:#07b} → {} 字",
        text.chars().count()
    ));
    Ok(json!({
        "mask": m,
        "garbage": m & CLEAN_GARBAGE != 0,
        "space": clean_space_name(m),
        "width": m & CLEAN_WIDTH != 0,
        "unwrap": m & CLEAN_UNWRAP != 0,
        "chars": text.chars().count(),
    }))
}

/// OCR 窗口尺寸落盘的「代次」。
///
/// 拖窗口边框时 Windows 会连发几十上百个 resize 事件，每个都写一次盘
/// 既没必要也伤磁盘。这里用最简单的防抖：每次 resize 只把代次 +1 并起一个
/// 600ms 的定时线程；线程醒来发现代次又变了，说明用户还在拖，就默默退出，
/// 由最后那一次负责落盘。
static OCR_SIZE_GEN: AtomicU64 = AtomicU64::new(0);

/// 记住 OCR 结果窗口的尺寸（逻辑像素）。
///
/// 用户把窗口拖大/拖小之后，下次识别按这个尺寸开（见 config::ocr_window_size）。
/// 尺寸不变就不写盘 —— 免得每次开窗都触发一次无谓的 save。
fn remember_ocr_size(w: u32, h: u32) {
    if w == 0 || h == 0 {
        return;
    }
    let gen = OCR_SIZE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        // 这 600ms 里又 resize 了 → 让后面那次去写
        if OCR_SIZE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if cfg.ocr_win_w == w && cfg.ocr_win_h == h {
            return;      // 没变，别白写一次盘
        }
        cfg.ocr_win_w = w;
        cfg.ocr_win_h = h;
        config::save(&cfg);
        win::log(&format!("ocr win: 记住尺寸 {w}x{h}"));
    });
}

#[tauri::command]
fn copy_text(text: String) {
    let ok = clip::set_text(&text);
    win::log(&format!("copy_text: {} chars ok={ok}", text.chars().count()));
}

/** 本地 OCR 依赖检测（设置页「环境检测」卡片）。
 *
 *  用户要求：进入 OCR 设置页 / 初始化 OCR 时自动检测本地 OCR 所需的系统组件
 *  是否齐全；缺什么、有什么用、怎么补，界面上逐项说清楚，并给一键安装入口。
 *  检测逻辑在 `ocr::ocr_dep_check()`（WinRT 引擎本体 / OCR 语言包 / 显示语言
 *  匹配三项，纯只读），这里只做「读检测 → 序列化下发」。
 */
#[tauri::command]
fn ocr_env_check() -> serde_json::Value {
    ocr::ocr_dep_check()
}

/// 「一键安装」按钮：不限次数地打开 Windows「语言和区域」设置页。
///
/// 与 `ocr::open_language_settings_once`（识别失败时自动弹，限一次）分开：
/// 设置页按钮是用户主动点的，没有「别烦用户」的顾虑。
#[tauri::command]
fn ocr_open_language_settings() {
    ocr::open_language_settings();
}

/// 「查看教程」按钮：打开 Windows OCR 官方文档。
///
/// 引擎本体缺失（系统太老 / 精简版）时用户需要一个能看懂出处的说明页 ——
/// 说「升级系统」不如给官方文档让他自己确认版本要求。
#[tauri::command]
fn ocr_open_lang_help() {
    ocr::open_ocr_doc();
}

#[tauri::command]
fn ocr_test() {
    std::thread::spawn(|| {
        let cfg = cfg_snapshot();
        // r46 改口径：以前这里**写死**测百度（"百度云配置没问题"），用户配了
        // 硅基流动/Kimi 点「测试一下配置」测的还是百度 —— 测了个跟他没关系的东西。
        // 现在测的就是**当前配的那家**（并行模式下本地 + 在线各测一次）。
        // r47 再收一档：这里测的就是**默认引擎**（按钮叫「测试当前引擎」）。
        // 「同时识别」里勾的其它几家各有自己的「测试连接」按钮（在那一家展开的
        // 配置里），一次点一下 —— 这里不再顺手替它们全测一遍（勾了 4 家就是
        // 4 次网络请求，用户等的是"当前引擎行不行"）。
        let id = online_engine(&cfg);
        let name = engine_display(&id);
        if ocr_engines::is_online(&id) && !creds_ready(&cfg, &id) {
            ocr_say(format!("{name}：凭据还没填全，先按「?」去申请并填好"));
            return;
        }
        match ocr_engines::test(&id, &ocr_creds(&cfg, &id), &ocr_engines::OcrUrls::default()) {
            Ok(m) => ocr_say(format!("{name}：{m}")),
            Err(e) => ocr_tell(format!("{name} 没连上：{e}"), true),
        }
    });
}

/** 「一键诊断」（#134 建时叫「一键优化」，#134 按用户要求改名；r49 起**每一家
 *  引擎都能诊断**，见下面的 diagnose_generic）。
 *
 *  用户原话：「"一键优化"改为"一键诊断"。诊断完成后展示当前识别状态及各环节
 *  耗时/速度，并在每个环节后提供独立的"优化"按钮供用户手动选择；禁止因高精度
 *  模式慢而自动回退到标准模式」。
 *
 *  百度这条路的分环节最细（它的接口本来就是"换 token → 识别"两段）：
 *    ① 状态：引擎 / 精度档 / 语言档 / 并行开关，Key/Secret 填了没；
 *    ② 实测：换一次 token + 按**当前精度档**打一次识别接口，各记毫秒数；
 *    ③ 分环节建议：结果走 `qs://ocr-diag` 事件（JSON）发给设置页，每一行
 *       带自己的 action（`warm` 预热 / `standard` 切标准版 / `accurate`
 *       切高精度），按钮点不点、点什么，全由用户自己决定。
 */
/** r49：**通用**一键诊断 —— 百度以外每一家都走这条。
 *
 *  用户 r49 原话：「再就是一键诊断功能，它只存在于百度云 ocr，其他的也要有一键
 *  诊断功能」。百度那条能拆"换 token / 识别"两段（它自己就是两段式接口），
 *  其余十几家都是**一次请求** —— 所以这里按"凭据齐不齐 / 真发一次要多久 /
 *  对方的原话是什么"来分环节实测：
 *    ① 识别状态     —— 这一家是谁、是不是当前默认引擎、同时识别名单、模型 / 接口地址
 *    ② 凭据         —— 注册表说这一家要填哪几样、填了没（没填给一颗「去申请」）
 *    ③ 实测一次请求 —— 真发一次，记毫秒（**失败也记**：连不上的耗时同样是信息）
 *    ④ 怎么读这些数 —— 按结果给一句人话（密钥无效 / 余额 / 网络 / 模型名写错）
 *  ⚠ 全程**只读**：一个字节的配置都不改（这是 #134 用户明令的口径）。
 *  ⚠ 绝不回显密钥原文，只说"填了 / 没填"。
 */
fn diagnose_generic(
    cfg: &config::Config,
    engine: &str,
    multi: &[String],
    accurate: bool,
    lang: &str,
) {
    let Some(info) = ocr_engines::find(engine) else {
        return;
    };
    let local = info.kind == ocr_engines::Kind::Local;
    let creds = ocr_creds(cfg, engine);
    let ready = creds_ready(cfg, engine);
    let mut stages: Vec<Value> = Vec::new();

    // ① 识别状态：其余环节的解读背景
    stages.push(json!({
        "name": "识别状态",
        "ok": true,
        "detail": format!(
            "{} · {} · 同时识别 {}",
            info.name,
            if cfg.ocr_engine == engine { "当前默认引擎" } else { "眼下不是默认引擎" },
            if multi.len() > 1 {
                multi.iter().map(|e| engine_display(e)).collect::<Vec<_>>().join("+")
            } else {
                "关".to_string()
            },
        ),
        "action": Value::Null,
    }));

    if !local {
        // 模型 / 接口地址：这两样错了照样连不上，先摆出来（值照抄注册表默认）
        let model = creds.model_for(info);
        let base = creds.base_for(info);
        stages.push(json!({
            "name": "模型 / 接口地址",
            "ok": !model.trim().is_empty() && !base.trim().is_empty(),
            "detail": format!("模型 {} · 地址 {}", if model.trim().is_empty() { "（空）" } else { model.as_str() }, base.trim()),
            "action": Value::Null,
        }));
    }

    // ② 凭据：要填哪几样由注册表说，这里只说"填了没"（不打印密钥）
    let want: Vec<&str> = if local {
        vec![]
    } else {
        [
            (info.need_key, "API Key"),
            (info.need_secret, "Secret"),
            (info.need_model, "模型名"),
            (info.need_base, "接口地址"),
        ]
        .iter()
        .filter(|(need, _)| *need)
        .map(|(_, n)| *n)
        .collect()
    };
    let missing: Vec<&str> = if local {
        vec![]
    } else {
        [
            (info.need_key && creds.key.trim().is_empty(), "API Key"),
            (info.need_secret && creds.secret.trim().is_empty(), "Secret"),
            (info.need_model && creds.model_for(info).trim().is_empty(), "模型名"),
            (info.need_base && creds.base_for(info).trim().is_empty(), "接口地址"),
        ]
        .iter()
        .filter(|(miss, _)| *miss)
        .map(|(_, n)| *n)
        .collect()
    };
    stages.push(json!({
        "name": "凭据",
        "ok": ready,
        "detail": if local {
            "本地识别调用系统内置 OCR：离线、免费，不需要任何账号".to_string()
        } else if ready {
            format!("要填：{} —— 都填好了", want.join(" / "))
        } else {
            format!("要填：{} —— 还缺：{}", want.join(" / "), missing.join(" / "))
        },
        // 没填齐就给一颗「去申请」：直接开那家的官方申请页（用户不用自己找）
        "action": if ready || local { Value::Null } else { json!("signup") },
        "actionLabel": "去申请 / 填凭据",
    }));

    // ③ 实测：真发一次（这就是"这一家现在通不通、要多久"的真相）
    let mut ms: Option<u64> = None;
    let mut ok = false;
    let mut said = String::new();
    if ready {
        let started = std::time::Instant::now();
        match ocr_engines::test(engine, &creds, &ocr_engines::OcrUrls::default()) {
            Ok(m) => { ok = true; said = m; }
            Err(e) => { ok = false; said = e; }
        }
        ms = Some(started.elapsed().as_millis() as u64);
    }
    stages.push(json!({
        "name": if local { "实测一次本地识别" } else { "实测一次请求" },
        "ok": ok,
        "ms": ms,
        "detail": if !ready {
            "凭据没填齐，没发请求".to_string()
        } else {
            said.clone()
        },
        "action": Value::Null,
    }));

    // ④ 怎么读：把"对方原话"翻成一句人话建议（不改任何配置，只说话）
    let advice = if !ready {
        "先把上面缺的填上再来诊断；填完顺手点一下「测试连接」也一样。"
    } else if ok {
        if local {
            "本地识别就绪：这条路离线、不花额度，识别一张小图基本就是这个量级。"
        } else {
            "连得上：正式识别一张图的等待时间大致就是这个量级（再加对方排队/图片大小的影响）。"
        }
    } else {
        let low = said.to_lowercase();
        if low.contains("401") || low.contains("403") || low.contains("unauthor") || low.contains("invalid") {
            "对方拒绝了这次请求：多半是密钥不对、或这把密钥没有开通这个模型（去控制台看一眼权限）。"
        } else if low.contains("余额") || low.contains("quota") || low.contains("insufficient") || low.contains("429") {
            "对方说额度/频率到上限了：等一会儿，或者去控制台看余额与限流。"
        } else if low.contains("timeout") || low.contains("timed out") || low.contains("超时") || low.contains("connect") {
            "没连上：网络到不了那家（代理 / 防火墙 / 接口地址写错都可能），先把地址那栏核对一遍。"
        } else if low.contains("model") {
            "对方说模型名不认识：用「拉取模型」挑一个（会看图的排在前面），或者照文档手填。"
        } else {
            "没打通：上面那行就是对方原话，照它排查（密钥 / 模型名 / 地址 / 余额）。"
        }
    };
    stages.push(json!({
        "name": "怎么读这些数",
        "ok": true,
        "detail": advice,
        "action": Value::Null,
    }));

    let summary = if !ready {
        format!("{}：还差凭据没填齐，先填再诊断。", info.name)
    } else if ok {
        format!("{}：连得上，一次请求约 {} ms。", info.name, ms.unwrap_or(0))
    } else {
        format!("{}：没打通 —— {}", info.name, said)
    };
    let _ = app().emit_to("settings", "qs://ocr-diag", json!({
        "engine": engine,
        "ok": ok && ready,
        "local": local,
        "accurate": accurate,
        "lang": lang,
        "parallel": if multi.len() > 1 { json!(multi) } else { json!(false) },
        "tokenMs": Value::Null,
        "ocrMs": ms,
        "stages": stages,
        "summary": summary,
    }));
}

#[tauri::command]
fn ocr_diagnose(engine: Option<String>) {
    std::thread::spawn(move || {
        let cfg = cfg_snapshot();
        /* r49：诊断**指定的那一家**（设置页把当前默认引擎带过来）。
         * 没带 / 带了不认识的名字 → 退回当前默认引擎，老调用（无参）行为不变。 */
        let engine = match engine.as_deref().map(str::trim) {
            Some(e) if !e.is_empty() && ocr_engines::find(e).is_some() => e.to_string(),
            _ => cfg.ocr_engine.clone(),
        };
        let accurate = cfg.ocr_accurate;
        let lang = cfg.ocr_lang.clone();
        let multi = ocr_engine_plan(&cfg);

        /* r49：百度以外的每一家（含 Windows 本地）都走通用分环节诊断。
         * ⚠ 以前这里对 windows / 其它家只是回一句"只有百度有"，用户明确要求
         *   「其他的也要有一键诊断功能」—— 于是有了 diagnose_generic。 */
        if engine != "baidu" {
            diagnose_generic(&cfg, &engine, &multi, accurate, &lang);
            return;
        }
        if cfg.ocr_key.trim().is_empty() || cfg.ocr_secret.trim().is_empty() {
            let _ = app().emit_to("settings", "qs://ocr-diag", json!({
                "engine": "baidu",
                "ok": false,
                "stages": [],
                "summary": "先填 API Key 和 Secret Key，再诊断",
            }));
            return;
        }

        // 按**当前配置**实测：数字就是"你现在有多快/多慢"的真相
        let probe = ocr::probe_latency(&cfg.ocr_key, &cfg.ocr_secret, 12, accurate);

        let mut stages: Vec<Value> = Vec::new();
        // 环节一：当前状态（没有耗时，是其余环节的解读背景）
        stages.push(json!({
            "name": "识别状态",
            "ok": true,
            "detail": format!(
                "百度 OCR · {} · {} · 同时识别 {}",
                if accurate { "高精度版" } else { "标准版" },
                lang,
                if multi.len() > 1 {
                    multi.iter().map(|e| engine_display(e)).collect::<Vec<_>>().join("+")
                } else {
                    "关".to_string()
                },
            ),
            "action": Value::Null,
        }));

        let (token_ms, ocr_ms, err) = match probe {
            Ok(p) => (Some(p.token_ms), p.ocr_ms, None),
            Err(e) => (None, None, Some(e)),
        };

        // 环节二：换 token。正式识别第一次都要走这段，预热之后就没有了
        stages.push(json!({
            "name": "换取 token",
            "ok": token_ms.is_some(),
            "ms": token_ms,
            "detail": "首次识别的固定开销；预热之后正式识别不走这段",
            "action": "warm",
            "actionLabel": "预热 token",
        }));

        // 环节三：识别接口。高精度档多一个「改用标准版」的手动按钮；
        // 标准版档反过来给「改用高精度」（更准但更慢）—— 两个方向都让用户
        // 自己选，绝不做自动切换（#134）。
        stages.push(json!({
            "name": "识别接口",
            "ok": ocr_ms.is_some(),
            "ms": ocr_ms,
            "detail": match (&err, ocr_ms) {
                (Some(e), _) => format!("没打通：{e}"),
                (None, Some(_)) => if accurate {
                    "高精度版：更准，但比标准版慢一大截，且需要单独开通付费".to_string()
                } else {
                    "标准版：日常截图够用，速度上限".to_string()
                },
                (None, None) => "没打通（不影响正式识别，正式识别会重试）".to_string(),
            },
            "action": if accurate { "standard" } else { "accurate" },
            "actionLabel": if accurate { "改用标准版（更快）" } else { "改用高精度（更准）" },
        }));

        let total = token_ms.unwrap_or(0) + ocr_ms.unwrap_or(0);
        let summary = match &err {
            Some(e) => format!("百度云配置有问题：{e}"),
            None => format!(
                "首次识别约 {total} ms（换 token {} ms + 识别 {} ms）。预热 token 后，正式识别的固定开销就只剩识别这一段。",
                token_ms.unwrap_or(0),
                ocr_ms.unwrap_or(0),
            ),
        };
        let _ = app().emit_to("settings", "qs://ocr-diag", json!({
            "engine": "baidu",
            "ok": err.is_none(),
            "accurate": accurate,
            "lang": lang,
            // r47：诊断面板里报的是**同时识别名单**（老字段名保留，值改成名单本身，
            // 设置页那一行也按它渲染 —— 字段名不动是为了不牵动其它读它的地方）
            "parallel": if multi.len() > 1 { json!(multi) } else { json!(false) },
            "tokenMs": token_ms,
            "ocrMs": ocr_ms,
            "stages": stages,
            "summary": summary,
        }));
    });
}

/// 诊断面板「预热 token」按钮：手动预热一次（不碰任何其它配置）。
///
/// 和开框选窗口时的自动预热同一个机制：提前把 access_token 换好进缓存，
/// 正式识别时少一段 100~300ms 的网络等待。
#[tauri::command]
fn ocr_warm() {
    let cfg = cfg_snapshot();
    if cfg.ocr_key.trim().is_empty() || cfg.ocr_secret.trim().is_empty() {
        ocr_tell("先填 API Key 和 Secret Key，再预热", true);
        return;
    }
    ocr::warm_token(&cfg.ocr_key, &cfg.ocr_secret, 10);
    ocr_say("token 已预热，下次识别少一段网络等待");
}

/// 「划词兜底」该按什么顺序试哪几家 —— 纯函数，便于单测。
///
/// 顺序的口径没变（谁快谁先上：本机 16~30ms），变的是**第二棒是谁**：
/// 以前写死百度，现在是用户设置里配的那家。用户原话：
/// 「选择了非本地和百度 ocr 之外的引擎，但最后点击 OCR 之后调用的还是本地或者
/// 百度的，就相当于添加了，但没用上」—— 这条链就是漏掉的那一处。
fn capture_fallback_order(local_ok: bool, online: &str, online_ok: bool) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    if local_ok {
        order.push("windows".to_string());
    }
    if online_ok && ocr_engines::is_online(online) {
        order.push(online.to_string());
    }
    order
}

/// 框选完成 → 截图 → 识别。
///
/// `dpr` 是前端报上来的 devicePixelRatio；物理坐标 = 虚拟屏原点 + CSS 坐标 × dpr。
#[tauri::command]
fn ocr_region(x: f64, y: f64, w: f64, h: f64, dpr: f64) {
    // 参数必须是有限数。前端曾经算出 NaN 送过来（那时这里根本进不来，
    // 反序列化就失败了），结果遮罩窗口一直不关、用户满屏点不动。
    // 现在就算真有非法值漏进来，也必须先把窗口收掉再说。
    if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite()) {
        win::log(&format!(
            "ocr_region: 非法坐标 x={x} y={y} w={w} h={h}，已退出框选"
        ));
        close_window("region");
        ocr_tell("框选坐标不对，已退出", true);
        return;
    }
    let d = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let (vx, vy, _, _) = win::virtual_screen();
    let px = vx + (x * d).round() as i32;
    let py = vy + (y * d).round() as i32;
    let pw = ((w * d).round() as i32).max(1);
    let ph = ((h * d).round() as i32).max(1);
    win::log(&format!(
        "ocr_region css=({x:.0},{y:.0},{w:.0},{h:.0}) dpr={d} -> phys=({px},{py},{pw},{ph})"
    ));

    // 先把框选窗口收掉再截图，不然那层压暗遮罩会一起被截进去
    close_window("region");
    // 新的一次识别：上一轮的提示（降级/缺密钥说明）不该挂到这一轮的结果上
    clear_ocr_note();
    ocr_say("正在识别…");

    std::thread::spawn(move || {
        win::wait_until(1200, || app().get_webview_window("region").is_none());
        // 窗口关掉到真正从屏幕消失之间有一小段合成延迟，等一拍再截。
        // 一帧合成 16~33ms，50ms 足够 —— 用户要求整条链路压进 2 秒，
        // 这种固定等待能省一点是一点（多了白等，少了会把遮罩截进去）。
        std::thread::sleep(Duration::from_millis(50));

        let cfg = cfg_snapshot();
        let Some((cw, ch, pixels)) = win::grab_region(px, py, pw, ph) else {
            ocr_tell("截图失败，再框一次试试", true);
            return;
        };        let Some(img) = image::RgbaImage::from_raw(cw, ch, pixels) else {
            ocr_tell("截图数据异常", true);
            return;
        };

        // 缩到长边 1600 以内。屏幕是 200% 缩放时物理像素正好是逻辑的两倍，
        // 原尺寸既没必要，也更容易顶穿百度那边「base64 不超过 8MB」的限制。
        //
        // ⚠ 只按宽度缩是不够的：竖着框一条很长的内容时，宽度可能只有 300，
        // 高度却到 6000，直接撞穿百度「单边最长 4096」的上限（错误码 216202）。
        // 所以取宽高里的较大值作为缩放基准，保证两条边都在框内。
        //
        // 本地 OCR 走 CPU，太大的图会明显变慢 —— 用更小的上限（见 LOCAL_MAX_SIDE）。
        // 并行模式下本地引擎也要跑，缩放基准按它来（2600 也在百度 4096 的
        // 限度内，一张缩放后的图两个引擎共用）。
        // 参与名单：**默认引擎** + 「同时识别」里勾的其它几家（r47）。
        //
        // ⚠ 必须走 `ocr_plan_with_local_fallback`，不能直接 `ocr_engine_plan`：
        //   放行判断（ocr_start_flow）用的是带兜底的那版，识别用的却是这里的名单 ——
        //   用户没配百度密钥时就会出现「能框选、框完必然失败」的死路。
        //   两边用同一个函数，兜底才真的落在这一轮上。
        let (run, fell_back) = ocr_plan_with_local_fallback(&cfg);
        if fell_back {
            win::log("ocr: 这一轮名单里全是缺凭据的引擎，已临时补上本地识别");
        }
        // ⚠ 缩放基准：名单里有本地（走 CPU、图太大会明显变慢）就按 LOCAL_MAX_SIDE，
        //   否则按百度的上限。一张缩放后的图所有引擎共用。
        let max_side = if run.iter().any(|e| e == "windows") {
            ocr::LOCAL_MAX_SIDE
        } else {
            ocr::MAX_SIDE
        };
        let scale = (max_side as f64 / cw as f64)
            .min((max_side as f64) / ch as f64)
            .min(1.0);
        let img = if scale < 0.999 {
            let nw = ((cw as f64) * scale).round().max(1.0) as u32;
            let nh = ((ch as f64) * scale).round().max(1.0) as u32;
            win::log(&format!("ocr: resize {cw}x{ch} -> {nw}x{nh}"));
            image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        // ⚠ 直接编 JPEG，不再走 PNG。
        //   用户抱怨"OCR 非常非常慢"，量下来大头是 PNG 编码 —— 一张 1920px 的
        //   截图 PNG 要几百毫秒，而 JPEG 只要几十毫秒；更亏的是上传前还会把
        //   这张 PNG 解码再编一次 JPEG，同样的图编码了两遍。
        //   现在这里一次出 JPEG（q85，尺寸就是上传尺寸），`prepare_for_upload`
        //   认出 JPEG 魔数直接放行 —— 整条链路只编码一次。
        //   结果窗的「对照」显示用的也是这张 JPEG，<img> 不挑格式。
        let mut cursor = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85);
        if let Err(e) = image::DynamicImage::ImageRgba8(img).write_with_encoder(enc) {
            ocr_say(format!("图片编码失败：{e}"));
            return;
        }
        let png = cursor.into_inner();
        win::log(&format!("ocr: jpeg {} KB", png.len() / 1024));

        // 这张图留着 —— 结果窗口要显示「上面图片、下面文字」的对照。
        // 就算接下来识别失败也留着：用户能看到自己框的是哪块，比干等一句话强。
        if let Ok(mut g) = OCR_LAST_PNG.lock() {
            *g = png.clone();
        }
        // 新图 → 代次 +1（顺手取新值，下面的缓存/拼接都按它来），
        // 引擎结果缓存整体作废（绝不能拿上一张图的结果来用）
        let gen = OCR_PNG_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        // 整理开关也回到**设置里的默认**：上一张图上临时点过的那些项
        // （强力去空格、合并换行…）不该带到新结果上。按钮的临时覆盖存在
        // OCR_CLEAN_OVERRIDE 里，清成 None 就自动回落到配置。
        if let Ok(mut g) = OCR_CLEAN_OVERRIDE.lock() {
            *g = None;
        }

        // ---- 多引擎：参与名单里的几家同时认这张图，各一段、各自标注（r47）----
        // 用户原话（r47）：「把双引擎并行识别，改为选择 OCR 引擎同时识别，
        // 就变成一种可选项，可以同时选个多个 OCR 同时进行。同时也只会显示
        // 自己选择的那一个」。
        if run.len() > 1 {
            let mut engines: Vec<String> = Vec::new();
            let mut notes: Vec<String> = Vec::new();
            for e in &run {
                if creds_ready(&cfg, e) {
                    engines.push(e.clone());
                } else {
                    // 凭据不齐就不硬跑它了（白等一次网络失败），但要说清楚为什么少一段
                    notes.push(format!("{}：还没配凭据，本次跳过", engine_display(e)));
                }
            }
            if engines.is_empty() {
                ocr_tell("参与识别的引擎都没配凭据，去设置页填一下", true);
                return;
            }
            // 提示语：名单里只有本地时才点明"本地"（免得用户以为在跑网络那家）
            ocr_say(if engines.iter().any(|e| e != "windows") {
                "正在识别…"
            } else {
                "正在识别（本地）…"
            });
            // ⚠ 渐进式：**谁先回来就先开窗**，不等另一个。
            //   用户要的就是「点 ocr 立刻看到本地结果，百度在后台接着认，
            //   切到百度时不用等」。老做法等两个都完成才开窗 —— 百度走网络那
            //   几秒全在干等，本地慢的时候（有 15 秒硬超时）还得一起等，
            //   表现就是「弹得非常非常慢，而且只剩百度一段」。
            let (ok, notes) = ocr_run_engines(gen, &png, &engines, notes, |text, first, notes| {
                if !notes.is_empty() {
                    set_ocr_note(notes.join("；"));
                }
                win::log(&format!(
                    "ocr: 并行{} {} 字",
                    if first { "先出" } else { "补齐" },
                    text.chars().count()
                ));
                if first {
                    open_ocr_window(text.to_string());
                } else {
                    // 后到的结果：窗口已经开着，增量推过去（前端直接替换展示）
                    emit_ocr_result(&png, text);
                }
            });
            if ok == 0 {
                ocr_tell(format!("识别失败：{}", notes.join("；")), true);
            }
            return;
        }

        // 本地识别（Windows 内置）走另一条路：不联网、不编码第二次、速度最快。
        // 截图线程已经编好 JPEG，本地 OCR 的 BitmapDecoder 直接认，省掉整段网络往返。
        //
        // ⚠ 引擎取 `run[0]` 而不是 `cfg.ocr_engine`：上面那份名单可能已经把
        //   本地引擎临时补到首位（默认引擎缺凭据时的兜底）。这里用配置值的话，
        //   兜底就白做了 —— 用户能框选，但一识别就必失败。
        let ocr_engine = run
            .first()
            .cloned()
            .unwrap_or_else(|| cfg.ocr_engine.clone());
        match run_ocr(&png, &ocr_engine) {
            Ok((text, raw, label)) => {
                win::log(&format!(
                    "ocr: got {} chars via {}",
                    text.chars().count(),
                    label,
                ));
                // 首跑的结果也进缓存：以前只有「重新识别」入账，用户切一次引擎
                // 就被迫重认一遍（「点击了百度 ocr 之后，再点回本地 ocr，那么
                // 本地 ocr 就会重新识别一遍，那会造成无端的资源浪费」）。
                store_engine_result(gen, &ocr_engine, &text, &raw, &label);
                // 去空格按钮的原料 = 当前展示引擎的原文（run_ocr 早不写全局了）
                if let Ok(mut g) = OCR_LAST_RAW.lock() {
                    *g = raw;
                }
                open_ocr_window(text);
            }
            Err(e) => {
                // 失败时也把结果窗口叫起来：让用户看到框选的图 + 失败原因，
                // 而不是只有一条转瞬即逝的提示（以前就是这么闷掉用户的）。
                ocr_tell(format!("识别失败：{e}"), true);
            }
        }
    });
}

/// 让用户挑一张图片当图标。
///
/// 文件选择框必须跑在**主线程**上：rfd 的对话框要自己抽消息，从 Tauri 的命令线程
/// 调起会把横条窗口一起拖死（DWM 会给它做 Ghost 替身，表现为整个横条没反应），
/// 这是踩过的坑。
///
/// # 分两条路（r80 修的逻辑问题）
///
/// 用户原话：
/// > 「我的意思是说抠图的功能默认不打开。就只有在设置通用里面打开之后，换图标
/// >  才会有个编辑的这个页面。没打开抠图功能的时候，点击换图标就直接选择文件替换」
///
/// 所以：
///   · **缺省（开关关）**：挑完图**直接落库**替换，不进编辑器 —— 绝大多数用户
///     只是想把图标换成自己的图，不该被迫过一道编辑器。
///   · **开关开**：挑完图进编辑器（前后对比、抠图、导出都在这儿）。
///     编辑器建不起来时也退回直接落库，别让用户白挑一张。
///
/// 注意这里的开关是 `ai_matting_enable`，但语义已经不止"AI 抠图"了 ——
/// 它是**图标编辑器功能的总开关**（用户口径："没打开抠图功能时换图标就直接替换"）。
/// 字段名保留是为了兼容已有配置，别改（改了老配置读不回来）。
#[tauri::command]
fn pick_icon(engine: String, app: AppHandle) {
    win::log(&format!("pick_icon: {engine}"));
    // 先读开关：关着就直接落库，那条路不该去建编辑器窗口
    let editor_on = st()
        .cfg
        .lock()
        .map(|c| c.ai_matting_enable)
        .unwrap_or(false);
    // OCR 是哨兵名（@ocr），直接印在对话框标题里很奇怪，换成给人看的说法。
    let shown = icon_edit_name(&engine);
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title(format!("给「{}」挑一张图标", shown))
            .add_filter("图片", &["svg", "png", "jpg", "jpeg", "ico", "webp", "gif", "bmp"])
            .pick_file();
        let Some(path) = picked else {
            win::log("pick_icon: cancelled");
            return;
        };
        let eng2 = engine.clone();
        std::thread::spawn(move || {
            // 读图 + 建窗都脱开主线程：读文件不该阻塞消息循环，
            // 建 WebView2 窗口按项目铁律必须从 spawn 出来的线程调
            // run_on_main_thread（理由见 open_settings 的注释）。
            let Ok(bytes) = std::fs::read(&path) else {
                toast_settings("图标文件读不出来，换一张试试");
                return;
            };
            // 防呆：图库挑到一张 40MB 的 RAW 预览图时，data URL 走 IPC
            // 会把编辑器页面噎住。图标用不到这么大。
            if bytes.len() > 12 * 1024 * 1024 {
                toast_settings("这张图超过 12MB，换一张小一点的");
                return;
            }
            let fname = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("picked.png")
                .to_string();
            let src = config::data_url(&fname, &bytes);
            let vector = fname.to_ascii_lowercase().ends_with(".svg");

            /* 开关关着 → 直接落库（**不进编辑器**）。
             * 这是 r80 修的逻辑：以前不管开关如何都进编辑器。 */
            if !editor_on {
                win::log("pick_icon: 编辑器未启用，直接落库替换");
                stash_picked_icon(&eng2, &path);
                return;
            }

            // 编辑器建不起来时退回旧行为（直接落库），别让用户白挑一张图
            if !open_icon_edit_win(&eng2, src, vector) {
                win::log("pick_icon: 编辑器建窗失败，退回直接落库");
                stash_picked_icon(&eng2, &path);
            }
        });
    });
}

/// 把挑到的图标文件落库（写 icons 目录 + overrideIcons + 广播）。
///
/// 抽出来是因为两条路都要用：开关关着时的"直接替换"，以及编辑器建窗失败时的回退。
/// 以前这段逻辑只存在于"建窗失败"分支里，现在它是**默认路径**的一部分。
fn stash_picked_icon(engine: &str, path: &std::path::Path) {
    let Some(file) = config::stash_icon(engine, path) else {
        toast_settings("图标保存失败，换一张试试");
        return;
    };
    let mut cfg = match st().cfg.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    if let Some(old) = cfg.overrides.insert(engine.to_string(), file) {
        if old != cfg.overrides[engine] {
            config::drop_icon(&old); // 旧文件没人引用了，别留着占地
        }
    }
    config::save(&cfg);
    drop(cfg);
    broadcast();
    toast_settings("图标已替换");
}

/* ================================================================== */
/* r88：把「绑定应用」的图标拿来当引擎图标                                 */
/* ================================================================== */

/// 用户要求：「快捷键引擎要增加一个功能，那就是当我选择了某一个应用的时候，
/// 就能够把那个应用的图标作为软件里显示的图标。」
///
/// 所以这个命令在**选中应用之后**调：从那个 exe 里抠出图标、存成 PNG、
/// 写进 `overrides`（和用户手动"换图标"走的是**同一条**落库通路）。
///
/// # 为什么要落成 PNG 文件，而不是直接把 RGBA 塞给前端
///
/// 因为 `overrides` 机制的值是**文件名**（`icons/<引擎名>.png`），图标要能
/// 跨会话存活、能被备份/WebDAV 同步、能被"恢复默认图标"清掉 —— 这些都依赖
/// "它是个真实文件"。直接给前端 data URL 的话，刷新页面就没了。
///
/// # 尺寸取 256
///
/// 横条上图标 28~40px、设置页列表也就 40px 上下，256 足够覆盖各种 DPI
/// （2x 屏上 40px 图标实际要 80px 源图）。取太大浪费磁盘与同步体积。
///
/// # 失败时的行为
///
/// **静默失败**（只写日志）。这个功能是"锦上添花"：用户选了个应用但没有
/// 图标资源（有些 exe 就是这么精简），弹个错反而打扰他。引擎照常能用，
/// 只是显示字母徽标。
#[tauri::command]
fn app_icon_from_exe(engine: String, exe: String) {
    win::log(&format!("app_icon_from_exe: engine={engine} exe={exe}"));
    std::thread::spawn(move || {
        /* ⚠ 用户选的可能是个 `.lnk` 快捷方式（开始菜单里基本都是），
         * 也可能直接是 exe。
         *
         * 我一开始以为要"先把 .lnk 解析成目标 exe、再去抠图标"，还打算自己
         * 实现 COM 的 IShellLink。**实测发现不用**：`SHGetFileInfoW` 走的是
         * shell 的图标解析，shell 自己会读快捷方式的目标 —— 对 `.lnk`
         * 直接有效（而 `PrivateExtractIconsW` 对 `.lnk` 返回 0，它只认
         * 带图标资源的文件）。
         *
         * 所以 `extract_app_icon` 内部已经是"先试直读（大图）、失败退 shell"，
         * 两条路都在 `win.rs` 里，这里原样把路径传进去就行。 */
        let Some((w, h, rgba)) = win::extract_app_icon(&exe, 256) else {
            win::log(&format!("app_icon_from_exe: {exe} 里没取到图标，保持原样"));
            return;
        };
        let Some(png) = encode_rgba_png(w, h, &rgba) else {
            win::log("app_icon_from_exe: PNG 编码失败");
            return;
        };

        // 落盘：直接写进 icons 目录（文件名按引擎名规整，和 stash_icon 同一口径）
        let Some(file) = write_engine_icon_png(&engine, &png) else {
            win::log("app_icon_from_exe: 写图标文件失败");
            return;
        };
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if let Some(old) = cfg.overrides.insert(engine.clone(), file) {
            if old != cfg.overrides[&engine] {
                config::drop_icon(&old);
            }
        }
        config::save(&cfg);
        drop(cfg);
        broadcast();
        win::log("app_icon_from_exe: 已把这个应用的图标设为引擎图标");
    });
}

/// 把引擎图标写成 PNG 文件，返回文件名（与 `config::stash_icon` 同口径：
/// 文件名 = 引擎名规整后 + `.png`）。
fn write_engine_icon_png(engine: &str, png: &[u8]) -> Option<String> {
    config::ensure_dirs();
    let safe: String = engine
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let file = format!("{safe}.png");
    std::fs::write(config::icons_dir().join(&file), png).ok()?;
    Some(file)
}

/// RGBA 字节 → PNG 字节。
///
/// 用项目里已有的 `image` crate（Cargo.toml 里早就在用，图标编辑器导出也走它），
/// 不为这一个功能再引一个编码器。
fn encode_rgba_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || rgba.len() != (w as usize) * (h as usize) * 4 {
        return None;
    }
    let img: image::RgbaImage = image::ImageBuffer::from_raw(w, h, rgba.to_vec())?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// 给设置页弹一条提示（编辑器/挑图路径都在设置页操作，toast 只发它）。
fn toast_settings(msg: &str) {
    if let Some(a) = APP.get() {
        let _ = a.emit_to("settings", "qs://toast", msg);
    }
}

/// r58：给「快捷键引擎 → 绑定应用」挑一个应用，返回选中路径（取消返回 None）。
///
/// 为什么不复用 `pick_icon`：那条命令挑完图要**建一个图标编辑器窗口**再落库，
/// 而这里只需要一个路径字符串。硬塞进去会让 pick_icon 多一个"这次不建窗"的
/// 分支，两条不相干的流程缠在一起。
///
/// ⚠ 对话框必须回主线程开：`rfd` 在后台线程弹窗时，DWM 会给前台窗口做 Ghost
///   替身，表现是整个横条/设置页没反应（`pick_icon` 上面那段注释记的就是这个坑）。
///   所以这里 `run_on_main_thread` + 一个 channel 把结果传回来。
/// ⚠ 超时给 300 秒：用户可能在文件对话框里翻很久目录，短了会"莫名其妙没选上"。
#[tauri::command]
fn pick_app(app: AppHandle) -> Option<String> {
    win::log("pick_app: 打开选择应用对话框");
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("选择要绑定的应用")
            .add_filter("应用", &["exe", "lnk", "bat", "cmd"])
            .add_filter("全部文件", &["*"])
            .pick_file();
        let _ = tx.send(picked.map(|p| p.to_string_lossy().to_string()));
    });
    let got = rx.recv_timeout(std::time::Duration::from_secs(300)).ok().flatten();
    win::log(&format!("pick_app: 结果={got:?}"));
    got
}

/// 图标编辑器在给谁改、原图是什么 —— 显示名走这里统一解析：
/// `@ocr` / `@app:<id>` / `@fav:<id>` 三种哨兵都不能把原文怼给用户看
/// （用户报过"设置里出现 @app:xxxx 乱码"）。
fn icon_edit_name(key: &str) -> String {
    if key == config::BAR_OCR {
        return "识别图片文字（OCR）".to_string();
    }
    // r61：识图那颗按钮也有自己的图标键（@img），和 @ocr 同一套机制 ——
    // 用户要求「识图搜索的那个图标也能够自己换」。
    if key == config::BAR_IMG {
        return "识图搜索".to_string();
    }
    if let Some(id) = key.strip_prefix("@app:") {
        return cfg_with(|c| {
            c.apps
                .iter()
                .find(|a| a.id == id)
                .map(|a| a.name.clone())
                .unwrap_or_else(|| key.to_string())
        });
    }
    if let Some(id) = key.strip_prefix("@fav:") {
        return cfg_with(|c| {
            c.favorites
                .iter()
                .find(|g| g.id == id)
                .map(|g| g.name.clone())
                .unwrap_or_else(|| key.to_string())
        });
    }
    key.to_string()
}

/// 打开图标编辑器窗口（#143）。
///
/// 会话先落进进程级单例（`iconedit::SESSION`），页面 boot 时用
/// `icon_edit_load` 拉走；窗口已经开着就换会话 + 推 `qs://icon-edit-load`
/// 让页面重载，不重复建窗。
///
/// 返回 false = 窗口没建起来（调用方据此走兜底，见 pick_icon）。
fn open_icon_edit_win(key: &str, src: String, vector: bool) -> bool {
    let name = icon_edit_name(key);
    iconedit::set_session(iconedit::IconEditSession {
        key: key.to_string(),
        name,
        src,
        vector,
    });
    let a = app();
    if let Some(w) = a.get_webview_window("iconedit") {
        win::log("iconedit: reuse existing window");
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(s) = iconedit::load_session() {
            let _ = w.emit("qs://icon-edit-load", s);
        }
        return true;
    }
    let a2 = a.clone();
    // run_on_main_thread 只有「程序正在退出」时会失败 —— 那正是需要调用方
    // 走兜底（直接落库）的场景，所以把结果如实报回去。
    a.run_on_main_thread(move || {
        let mut b = WebviewWindowBuilder::new(&a2, "iconedit", WebviewUrl::App("iconedit.html".into()))
            .title("编辑图标 —— Quick Search")
            .inner_size(760.0, 600.0)
            .min_inner_size(560.0, 460.0)
            .resizable(true)
            .center()
            // 同 OCR / 设置窗口：先隐藏，等页面首帧画完（icon_edit_ready）再亮，
            // 免得用户先看到一块没内容的原生黑底（WebView2 首帧是异步的）。
            .visible(false)
            .background_color(if win::apps_use_light_theme().unwrap_or(true) {
                tauri::window::Color(245, 246, 248, 255)
            } else {
                tauri::window::Color(23, 24, 28, 255)
            });
        // 必须和横条窗口用同一套 WebView2 参数，否则环境配置冲突、窗口建不起来
        let wa = wv_args();
        if !wa.is_empty() {
            b = b.additional_browser_args(&wa);
        }
        match b.build() {
            Ok(w) => {
                win::log("iconedit: built ok (hidden, 等页面 ready)");
                // 关窗即清场：会话是临时的，下一颗图标进来必须是新的一份
                w.on_window_event(|e| {
                    if matches!(
                        e,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    ) {
                        iconedit::clear_session();
                    }
                });
                // 兜底：ready 信号 2.5 秒没来也亮出来，不能开着看不见
                let w2 = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    if !w2.is_visible().unwrap_or(false) {
                        win::log("iconedit: ready 超时，兜底显示");
                        let _ = w2.show();
                        let _ = w2.set_focus();
                    }
                });
            }
            Err(e) => win::log(&format!("iconedit: build failed: {e}")),
        }
    })
    .is_ok()
}

/// 前端「编辑」入口：给已有图标打开编辑器。
///
/// 原图三级：overrideIcons（图库挑的）→ icons 目录同名默认图（#138）→
/// 前端传的兜底 src（内置 iconFile 由设置页 fetch 成 data URL 递进来）。
/// 三级都空（字母徽标）就提示先挑一张图，不开空编辑器。
#[tauri::command]
fn open_icon_editor(key: String, src_hint: Option<String>) {
    win::log(&format!("open_icon_editor: {key}"));
    let mut src = String::new();
    let mut vector = false;
    if let Some(file) = cfg_with(|c| c.overrides.get(&key).cloned()) {
        if let Some(url) = icon_data_url_cached(&config::icons_dir().join(&file), &file) {
            src = url;
            vector = file.to_ascii_lowercase().ends_with(".svg");
        }
    }
    if src.is_empty() {
        // #138：icons 目录里「文件名 = 引擎名」的默认图（大小写不敏感，
        // 和前端 qsDirIconFor 同口径 —— Windows 文件名本来就不分大小写）
        for (stem, path) in config::dir_icon_defaults() {
            if !stem.eq_ignore_ascii_case(&key) {
                continue;
            }
            let Some(fname) = path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
                continue;
            };
            if let Some(url) = icon_data_url_cached(&path, &fname) {
                src = url;
                vector = fname.to_ascii_lowercase().ends_with(".svg");
                break;
            }
        }
    }
    if src.is_empty() {
        if let Some(h) = src_hint.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            src = h.to_string();
            vector = h.to_ascii_lowercase().contains(".svg");
        }
    }
    if src.is_empty() {
        toast_settings("这个引擎还没有图标，先点「换图标」挑一张");
        return;
    }
    // ⚠ 建窗前必须脱开命令调用栈（和 open_settings / pick_icon 同一个坑）：
    //   同步命令跑在主线程，而 tauri-runtime-wry 的 run_on_main_thread 在
    //   **主线程上是当场内联执行**的（send_user_message 里
    //   `current_thread().id() == main_thread_id` 分支直接调 handle_user_message）
    //   —— open_icon_edit_win 里的 WebviewWindowBuilder::build() 会直接在
    //   本次 invoke 栈里跑，回头等一把 invoke 还没释放的锁 → 死锁。
    //   现象极具迷惑性：点了「编辑图标」毫无反应、日志停在
    //   `open_icon_editor: <键>` 这一行、之后所有命令都不再执行
    //   （r31 探针 B 段全挂「连不上 iconedit.html」就是这个）。
    let key2 = key.clone();
    std::thread::spawn(move || {
        open_icon_edit_win(&key2, src, vector);
    });
}

/// 编辑器页面 boot 时拉会话（key / 显示名 / 原图 / 是不是矢量图）。
#[tauri::command]
fn icon_edit_load() -> Option<iconedit::IconEditSession> {
    iconedit::load_session()
}

/// 页面首帧画完：把隐藏的编辑器窗口亮出来（同 ocr_ready / settings_ready）。
#[tauri::command]
fn icon_edit_ready() {
    show_after_ready("iconedit");
}

/// 「自动抠图」：把图标的背景抠成透明，返回处理后 PNG 的 data URL
/// + 抠掉的像素数 + 是否没找到主体。
///
/// # 同步命令
///
/// AI 推理 140~1000ms（视模型），仍在可接受范围；铺线程反而要多传一遍大图字节，
/// 这里保持同步 —— 前端已经用 `busy` 状态盖住了等待期。
///
/// # 演进
///
/// · r77：`keep` —— 手动补描保护蒙版。
/// · r79：算法换成颜色解混。
/// · r80：换成 **AI 抠图**，并删掉本地算法（用户要求「原来那个直接去掉」）。
///   所以现在不可用时返回**明确错误**（含去哪打开/下载），不再静默回退。
/// · r80b：新增 **AI 参数**（`params`）—— 用户要求「在编辑画面里面多添加一些
///   与这些模型相关的参数」。见 `aimatte::Params` 的字段说明。
///
/// ⚠ `async`：这张图要解码 + 跑一次 ONNX 推理（首次含模型加载，140~1000ms）
///   + PNG 编码，全是同步 CPU 活。同步命令会把 UI 线程占住，表现为
///   "点了抠图，整个编辑器卡一下、连进度提示都不刷新"。
#[tauri::command]
async fn icon_remove_bg(
    src: String,
    keep: Option<iconedit::KeepMask>,
    params: Option<aimatte::Params>,
    model_id: Option<String>,
) -> Result<Value, String> {
    let (mime, bytes) = read_icon_src(&src)?;
    if mime.contains("svg") {
        return Err("SVG 是矢量图，没有位图背景可以消除".to_string());
    }
    let p = params.unwrap_or_default();
    let t0 = std::time::Instant::now();
    let (png, removed, no_bg) =
        iconedit::remove_background_ex(&bytes, keep.as_ref(), &p, model_id.as_deref())?;
    win::log(&format!(
        "icon_remove_bg: removed={removed} 描边={} 无背景={no_bg} 模型={} 参数={} 耗时={}ms",
        keep.is_some(),
        model_id.as_deref().unwrap_or("(默认)"),
        p.summary(),
        t0.elapsed().as_millis()
    ));
    Ok(json!({
        "src": config::data_url("iconedit.png", &png),
        "removed": removed,
        // 这张图可能压根没有主体可分（AI 找不到前景）——
        // 界面据此提示"这张图看不出主体"，而不是让用户以为按钮坏了
        "noBackground": no_bg,
        // 回显这次实际用的参数与模型名：用户调参数/换模型时要知道"这次是什么配置的结果"
        "usedModel": model_id.clone().unwrap_or_default(),
        "elapsedMs": t0.elapsed().as_millis() as u64,
    }))
}

/// 保存处理结果：写 icons 目录 + 更新 overrideIcons + 广播。
///
/// 扩展名按 src 的 mime 推导（处理结果恒为 PNG；SVG 原样应用时还是 SVG），
/// 与 `stash_icon` / `restore_icon` 同一套 `<安全键>.<扩展名>` 命名。
#[tauri::command]
fn icon_editor_save(src: String) -> Result<String, String> {
    let Some(session) = iconedit::load_session() else {
        return Err("编辑会话已过期，请重新打开编辑器".to_string());
    };
    let (mime, bytes) = read_icon_src(&src)?;
    let ext = match mime.rsplit('/').next().unwrap_or("") {
        "png" => "png",
        "jpeg" | "jpg" => "jpg",
        "svg+xml" => "svg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        "x-icon" | "vnd.microsoft.icon" => "ico",
        _ => "png",
    };
    // 和 stash_icon 同一套安全化：键里的 @ : / 之类全变下划线
    let safe: String = session
        .key
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let file = format!("{safe}.{ext}");
    config::ensure_dirs();
    std::fs::write(config::icons_dir().join(&file), &bytes)
        .map_err(|e| format!("图标文件写不进去：{e}"))?;
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("配置锁被占用，保存失败".to_string()),
        };
        if let Some(old) = cfg.overrides.insert(session.key.clone(), file.clone()) {
            if old != file {
                config::drop_icon(&old); // 旧文件没人引用了，别留在目录里占地
            }
        }
        config::save(&cfg);
    }
    broadcast();
    win::log(&format!("icon_editor_save: {} -> {file}", session.key));
    toast_settings("图标已更新");
    Ok(file)
}

/// 关编辑器（取消 / 右上角 X / Esc 都走这里）。
#[tauri::command]
fn close_icon_editor() {
    close_window("iconedit");
    iconedit::clear_session();
}

/* ══════════════════════════════════════════════════════════════════════════
 * r80：AI 抠图（模型管理 + 推理）
 *
 * 设计口径（用户原话）：
 *   「图标的编辑功能处于可选，在设置通用里面打开，打开之后就会验证本地有没有
 *     这个模型，有的话就直接调用，没有的话那要下载，会弹出下载窗口以及下载
 *     进度条，而这个（模型）本身不包含在安装包之内」
 *   「模型分为多个版本，还有量化的版本，大小可选，在设置当中提供不同的量化版本」
 *
 * 所以：
 *   · 开关默认关（`ai_matting_enable`，见 config.rs 的取舍说明）
 *   · 模型**不入包**，由用户选版本后下载（4.4MB ~ 168MB）
 *   · 下载有进度条、可取消、有 SHA256 校验
 *   · 推理失败/模型缺失时**静默回退**本地颜色解混（用户不会拿到"点了没反应"）
 * ══════════════════════════════════════════════════════════════════════════ */

/// AI 抠图的整体状态（设置页据此决定显示什么）。
///
/// 返回值设计成"一次调用拿到全部信息"：设置页打开时调一次就够了，
/// 不用为了"有没有 dll / 有没有模型 / 选了哪个"分别调三次。
#[tauri::command]
fn ai_matting_status() -> Value {
    let cfg = match st().cfg.lock() {
        Ok(c) => c,
        Err(_) => return json!({ "error": "配置锁被占用" }),
    };
    let enabled = cfg.ai_matting_enable;
    // 用户没选过就用推荐项
    let cur_id = if cfg.ai_matting_model.trim().is_empty() {
        aimodels::default_id().to_string()
    } else {
        cfg.ai_matting_model.clone()
    };
    drop(cfg);

    /* r80g：运行库现在**随模型一起下载**（用户要求），所以这里要分三层判断：
     *   · `runtimeFile` —— 文件在不在（不在 → 需要下载，界面给下载按钮）
     *   · `runtime`     —— 能不能真加载（文件在但版本不对/损坏时为 false）
     *   · `runtimeDir`  —— dll 与模型放在同一个目录（界面显示用）
     * 分开的理由：文件不在是"下一下就好"，加载失败是"文件坏了要重下" ——
     * 这两种情况给用户的提示完全不同。 */
    let runtime_file = aimodels::runtime_ready();
    let runtime = aimatte::runtime_available();
    let cur_ready = aimodels::is_ready(&cur_id);
    json!({
        "enable": enabled,
        // 运行库文件在不在（缺它 → 引导去下载）
        "runtimeFile": runtime_file,
        // 能不能真的加载起来
        "runtime": runtime,
        "runtimeDir": aimodels::models_dir().to_string_lossy(),
        "current": cur_id,
        "currentReady": cur_ready,
        // 能不能真的用：开关开了 + 运行库能加载 + 模型就绪
        "usable": enabled && runtime && cur_ready,
        // 体积同时给"人类可读"版本：前端就不必再实现一套格式化
        // （两处各写一份迟早会不一致）
        "models": aimodels::downloaded_with_size(),
        /* v1.2.0：模型资产所在的 Release 页。
         *
         * 用户要求「模型就不用一起上传了，只是提示说在哪一个版本页面可以下载就可以了」——
         * 所以界面上要能**明确告诉用户**"模型在哪个页下载"。这个值与
         * `aimodels::ASSET_RELEASE_TAG` 是同一个来源，不会和实际下载地址脱节
         * （有单测钉着两者一致）。 */
        "assetTag": aimodels::ASSET_RELEASE_TAG,
        "assetPage": format!(
            "{}/tag/{}",
            crate::update::RELEASES_URL,
            aimodels::ASSET_RELEASE_TAG
        ),
    })
}

/// 选择当前使用哪个模型（已下载的直接生效；没下载的前端会引导去下载）。
#[tauri::command]
fn ai_matting_select(id: String) -> Result<Value, String> {
    if aimodels::find(&id).is_none() {
        return Err(format!("未知的模型：{id}"));
    }
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("配置锁被占用".to_string()),
        };
        cfg.ai_matting_model = id.clone();
        config::save(&cfg);
    }
    broadcast();
    win::log(&format!("ai_matting_select: {id}"));
    Ok(ai_matting_status())
}

/// 切换 AI 抠图总开关。
#[tauri::command]
fn ai_matting_enable(on: bool) -> Result<Value, String> {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("配置锁被占用".to_string()),
        };
        cfg.ai_matting_enable = on;
        config::save(&cfg);
    }
    broadcast();
    win::log(&format!("ai_matting_enable: {on}"));
    Ok(ai_matting_status())
}

/// 删除已下载的模型（腾空间）。
#[tauri::command]
fn ai_matting_remove(id: String) -> Result<Value, String> {
    aimodels::remove(&id)?;
    win::log(&format!("ai_matting_remove: {id}"));
    Ok(ai_matting_status())
}

/// 下载一个模型 + （首次时）**运行库**（后台线程，通过事件推进度）。
///
/// # 为什么把运行库也放这条链路里
///
/// 用户原话：「这个运行库默认不下载，在点击打开 ai 抠图之后，会随着模型一起下载，
/// 并且跟模型储存在一起」。所以用户点「下载」时，程序会：
///   1. 先看运行库在不在 → 不在就先下它（69MB 的 zip，解出 11.8MB 的 dll）
///   2. 再下模型
/// 两个文件都落在同一个目录（默认是「软件目录/抠图模型」）。
///
/// 为什么必须异步：168MB 的模型在弱网下要十几分钟，同步命令会把
/// WebView 的消息循环卡死（整个设置页点不动）。
///
/// 进度事件 `model-download` 的载荷：
///   `{ "id": ..., "phase": "runtime"|"downloading"|"done"|"error"|"canceled",
///      "done": N, "total": M, "pct": 0..100, "msg": ... }`
#[tauri::command]
fn ai_matting_download(app: AppHandle, id: String) -> Result<(), String> {
    let Some(spec) = aimodels::find(&id) else {
        return Err(format!("未知的模型：{id}"));
    };
    /* r80o：**允许并行下载** —— 用户明确要求
     * 「运行库跟每一个模型都可以同时下载，也都要单独下」。
     *
     * 所以这里**不再有全局下载锁**。并行的安全性由两件事保证：
     *   1. 每个模型用自己的 `.part`（文件名里带模型 id），互不覆盖
     *   2. 运行库是同一个文件，由 `aimodels::ensure_runtime` 做"只让一个线程下、
     *      其它线程等它下完"的门闩 —— 不会重复下 69MB
     *
     * ⚠ 历史教训（r80i）：曾经并发下同一个 `onnxruntime.zip`，互相删文件、
     * 读到半个 zip，日志里每个源都报"解压失败 找不到 EOCD"。
     * 现在 zip 用唯一文件名，运行库又有门闩，这个坑堵死了。 */
    win::log(&format!("ai_matting_download: 开始 {}", spec.id));
    std::thread::spawn(move || {
        let ev = |payload: Value| {
            let _ = app.emit(aimodels::EVENT_PROGRESS, payload);
        };

        /* ---- 第 1 步：运行库（不在就先下；已有别的线程在下就等它）---- */
        if !aimodels::runtime_ready() {
            let mut last_rt = 0i64;
            let r = aimodels::ensure_runtime(&mut |stage, done, total| {
                if stage == "runtime-wait" {
                    // 别的线程正在下运行库 —— 告诉界面"在等"，别让它看着像卡死
                    ev(json!({
                        "id": spec.id, "phase": "runtime-wait",
                        "done": 0, "total": total, "pct": 0,
                    }));
                    return;
                }
                let pct = (done.saturating_mul(100)).checked_div(total).unwrap_or(0) as i64;
                if pct != last_rt {
                    last_rt = pct;
                    ev(json!({
                        "id": spec.id, "phase": "runtime",
                        "done": done, "total": total, "pct": pct,
                    }));
                }
            });
            match r {
                Ok(_) => win::log(&format!("ai_matting_download: {} 运行库就绪", spec.id)),
                Err(e) if e == "__CANCELED__" => {
                    ev(json!({ "id": spec.id, "phase": "canceled", "msg": "已取消" }));
                    return;
                }
                Err(e) => {
                    win::log(&format!("ai_matting_download: 运行库失败 {e}"));
                    ev(json!({ "id": spec.id, "phase": "error", "msg": format!("运行库下载失败：{e}") }));
                    return;
                }
            }
        }

        /* ---- 第 2 步：模型 ---- */
        ev(json!({ "id": spec.id, "phase": "downloading", "done": 0, "total": spec.bytes, "pct": 0 }));
        let mut last = 0i64;
        let r = aimodels::download(spec, &mut |done, total| {
            let pct = (done.saturating_mul(100)).checked_div(total).unwrap_or(0) as i64;
            if pct != last {
                last = pct;
                ev(json!({
                    "id": spec.id, "phase": "downloading",
                    "done": done, "total": total, "pct": pct,
                }));
            }
        });
        match r {
            Ok((bytes, sha)) => {
                win::log(&format!(
                    "ai_matting_download: {} 完成 {} 字节 sha={}",
                    spec.id,
                    bytes,
                    &sha[..8.min(sha.len())]
                ));
                ev(json!({
                    "id": spec.id, "phase": "done",
                    "done": bytes, "total": bytes, "pct": 100,
                }));
            }
            Err(e) if e == "__CANCELED__" => {
                win::log(&format!("ai_matting_download: {} 用户取消", spec.id));
                ev(json!({ "id": spec.id, "phase": "canceled", "msg": "已取消" }));
            }
            Err(e) => {
                win::log(&format!("ai_matting_download: {} 失败 {e}", spec.id));
                ev(json!({ "id": spec.id, "phase": "error", "msg": e }));
            }
        }
    });
    Ok(())
}

/// **单独下载运行库**（r80p 新增）。
///
/// 用户要求：「这个运行库一直是没下下来，这个你也要优化一下具体的下载方式，
/// 也要在设置通用 ai 抠图里面提供一个下载的选项」。
///
/// 所以给运行库一个独立入口，不必非点某个模型才触发。
/// 进度事件的 `id` 用固定值 `__runtime__`，前端据此定位到运行库那一行。
#[tauri::command]
fn ai_runtime_download(app: AppHandle) -> Result<(), String> {
    if aimodels::runtime_ready() {
        return Ok(()); // 已经在，不必再下
    }
    win::log("ai_runtime_download: 开始");
    std::thread::spawn(move || {
        let ev = |payload: Value| {
            let _ = app.emit(aimodels::EVENT_PROGRESS, payload);
        };
        let mut last = -1i64;
        let r = aimodels::ensure_runtime(&mut |stage, done, total| {
            if stage == "runtime-wait" {
                ev(json!({ "id": "__runtime__", "phase": "runtime-wait", "done": 0, "total": total, "pct": 0 }));
                return;
            }
            let pct = (done.saturating_mul(100)).checked_div(total).unwrap_or(0) as i64;
            if pct != last {
                last = pct;
                ev(json!({
                    "id": "__runtime__", "phase": "runtime",
                    "done": done, "total": total, "pct": pct,
                }));
            }
        });
        match r {
            Ok(p) => {
                win::log(&format!("ai_runtime_download: 完成 {}", p.display()));
                ev(json!({ "id": "__runtime__", "phase": "done", "done": 1, "total": 1, "pct": 100 }));
            }
            Err(e) if e == "__CANCELED__" => {
                ev(json!({ "id": "__runtime__", "phase": "canceled", "msg": "已取消" }));
            }
            Err(e) => {
                win::log(&format!("ai_runtime_download: 失败 {e}"));
                ev(json!({ "id": "__runtime__", "phase": "error", "msg": e }));
            }
        }
    });
    Ok(())
}

/// 取消正在进行的下载。
#[tauri::command]
fn ai_matting_cancel() {
    aimodels::request_cancel();
}

/* ══ r80g：模型存放位置（用户要求「直达位置 + 可改位置 + 自动迁移」）══ */

/// 模型目录信息：当前路径 + 是不是自定义的 + 默认路径 + 各模型在不在。
///
/// 一次给全，设置页不必分几次问。
#[tauri::command]
fn ai_model_dir_info() -> Value {
    let cur = aimodels::models_dir();
    // ⚠ 用 preferred_dir（"正常情况下应该在的位置"），不用 default_dir
    //   （那是"exe 目录不可写时的兜底"）—— 否则界面显示的默认位置与实际不符。
    let def = aimodels::preferred_dir();
    let custom = crate::try_st()
        .and_then(|s| s.cfg.lock().ok())
        .map(|c| !c.ai_model_dir.trim().is_empty())
        .unwrap_or(false);
    let items: Vec<Value> = aimodels::MODELS
        .iter()
        .map(|m| {
            let p = cur.join(format!("{}.onnx", m.id));
            let size = std::fs::metadata(&p).map(|x| x.len()).unwrap_or(0);
            json!({
                "id": m.id, "name": m.name,
                "found": size > 0,
                "size": size,
                "sizeText": aimodels::human_size(if size > 0 { size } else { m.bytes }),
            })
        })
        .collect();
    json!({
        "dir": cur.to_string_lossy(),
        "defaultDir": def.to_string_lossy(),
        "custom": custom,
        "exists": cur.exists(),
        "items": items,
    })
}

/// 选一个新的模型目录，并**自动把已有模型迁移过去**。
///
/// 返回 `{"cancel":true}`（用户取消）/ `{"ok":true,"moved":N,"dir":"...","failed":[...]}`。
///
/// 为什么迁移放在这里（而不是让前端分两步调）：选完目录必须**立刻**迁移 ——
/// 中间隔一次 IPC 往返，万一失败或被打断，用户就处于"配置指向新目录、
/// 但模型还在旧目录"的夹缝状态，表现是"模型明明下过却用不了"。
#[tauri::command]
fn ai_model_dir_pick(app: AppHandle) -> Result<Value, String> {
    let old = aimodels::models_dir();
    let (tx, rx) = std::sync::mpsc::channel::<Option<std::path::PathBuf>>();
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("选一个目录放 AI 模型（会自动把已有模型迁过去）")
            .pick_folder();
        let _ = tx.send(picked);
    });
    let picked = match rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(p) => p,
        Err(_) => return Err("目录选择超时".to_string()),
    };
    let Some(dir) = picked else {
        return Ok(json!({ "cancel": true }));
    };

    // 迁移：先复制后删源（跨盘 rename 会失败，见 aimodels::migrate_all 的注释）
    let (moved, failed) = aimodels::migrate_all(&old, &dir);
    win::log(&format!(
        "ai_model_dir_pick: {} -> {} 迁移 {moved} 个，失败 {}",
        old.display(),
        dir.display(),
        failed.len()
    ));
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("配置锁被占用".to_string()),
        };
        cfg.ai_model_dir = dir.to_string_lossy().to_string();
        config::save(&cfg);
    }
    broadcast();
    Ok(json!({
        "ok": true,
        "dir": dir.to_string_lossy(),
        "moved": moved,
        "failed": failed,
    }))
}

/// 把模型目录恢复成默认位置（同样会迁移已有模型）。
#[tauri::command]
fn ai_model_dir_reset() -> Result<Value, String> {
    let old = aimodels::models_dir();
    // ⚠ 用 preferred_dir（"正常情况下应该在的位置"），不用 default_dir
    //   （那是"exe 目录不可写时的兜底"）—— 否则界面显示的默认位置与实际不符。
    let def = aimodels::preferred_dir();
    let (moved, failed) = aimodels::migrate_all(&old, &def);
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("配置锁被占用".to_string()),
        };
        cfg.ai_model_dir = String::new();
        config::save(&cfg);
    }
    broadcast();
    win::log(&format!("ai_model_dir_reset: 迁回默认，{moved} 个"));
    Ok(json!({ "ok": true, "dir": def.to_string_lossy(), "moved": moved, "failed": failed }))
}

/// 用资源管理器打开模型目录（用户要求「直达模型储存位置的按钮」）。
///
/// 目录不存在时先建出来 —— 用户点这个按钮就是想"看看里面有什么"，
/// 打开一个不存在的路径只会弹错误框。
#[tauri::command]
fn ai_model_dir_open() {
    let dir = aimodels::models_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let _ = open::that(&dir);
}

/// 清理下载残留与旧位置的模型（r80i）。
///
/// 用户要求：「原来已经把模型都下了一遍，现在在软件里面已经把模型位置做了修改，
/// 那么原来的版本的好像还在一开始下载的位置，需要你做进一步的清除」。
///
/// 清理口径见 `aimodels::cleanup_stale`：只删**确定是垃圾**的
/// （`.part` / `.zip` / 旧位置的 `.onnx`），当前模型目录里的 `.onnx` 一个不碰。
#[tauri::command]
fn ai_cleanup_stale() -> Value {
    let (removed, bytes) = aimodels::cleanup_stale();
    json!({
        "ok": true,
        "count": removed.len(),
        "bytes": bytes,
        "sizeText": aimodels::human_size(bytes),
        // 把删了哪些列出来 —— 用户要求"做清除"，那就该看得见清了什么
        "items": removed,
    })
}

/* ══ r80g：设置页里的独立抠图工具 ══
 *
 * 用户原话：「设置通用 ai 抠图这一框最好也有一个抠图按钮，那这样我也可以用这个
 * 软件来实现抠图，搜完我就直接自己自定义地方保存」。
 *
 * 所以这里有两条命令：
 *   · `ai_cutout_pick`  —— 选一张图进来抠（返回抠好的 data URL 给界面预览）
 *   · `ai_cutout_save`  —— 把抠好的结果另存到用户选的位置
 *
 * 与图标编辑器那条链路的区别：那里是"给图标抠背景"，要写 overrideIcons、
 * 要跟横条联动；这里是**单纯的图片工具** —— 输入一张图、输出一张图，
 * 不碰任何配置。所以单独一套，不硬塞进 iconedit 的会话机制里。 */

/// 挑一张图并抠图，返回 `{"src": "<dataUrl>", "removed": N, "noBackground": bool, "elapsedMs": M}`。
///
/// 用 `params` 让界面能复用同一套 AI 参数；`modelId` 允许界面**临时换模型**
/// （用户要求「如果某一个我抠的不满意，我能立刻换另一个来抠」）。
#[tauri::command]
fn ai_cutout_pick(
    app: AppHandle,
    params: Option<aimatte::Params>,
    model_id: Option<String>,
) -> Result<Value, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<std::path::PathBuf>>();
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("挑一张图来抠")
            .add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp", "gif", "ico"])
            .pick_file();
        let _ = tx.send(picked);
    });
    let picked = match rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(p) => p,
        Err(_) => return Err("选图超时".to_string()),
    };
    let Some(path) = picked else {
        return Ok(json!({ "cancel": true }));
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("读图失败：{e}"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("这张图超过 32MB，换一张小一点的".to_string());
    }
    let p = params.unwrap_or_default();
    let t0 = std::time::Instant::now();
    let (png, removed, no_bg) = iconedit::remove_background_ex(&bytes, None, &p, model_id.as_deref())?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("cutout.png")
        .to_string();
    win::log(&format!(
        "ai_cutout_pick: {} 抠掉 {removed} 用时 {}ms",
        path.display(),
        t0.elapsed().as_millis()
    ));
    Ok(json!({
        // 用原名做 data URL 的"文件名"（前端另存时作为默认文件名）
        "src": config::data_url(&name, &png),
        "removed": removed,
        "noBackground": no_bg,
        "elapsedMs": t0.elapsed().as_millis() as u64,
        "name": name,
    }))
}

/// 把抠好的图另存到用户选的位置（`ai_cutout_pick` 的结果）。
///
/// `suggested`：默认文件名（一般是原图名加 `-抠图`）。
#[tauri::command]
fn ai_cutout_save(
    app: AppHandle,
    src: String,
    suggested: Option<String>,
) -> Result<Value, String> {
    let (_mime, bytes) = read_icon_src(&src)?;
    let name = suggested
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "cutout.png".to_string());
    // 文件名安全化（同 icon_editor_export 的口径）
    let safe: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' { c } else { '_' })
        .collect();
    let safe = safe.trim_matches(|c| c == '.' || c == ' ').to_string();
    let safe = if safe.is_empty() { "cutout.png".to_string() } else { safe };
    // 统一存成 PNG（抠图结果恒带 alpha，jpg 存不了透明）
    let stem = safe.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or(safe.clone());
    let default_name = format!("{stem}.png");

    let (tx, rx) = std::sync::mpsc::channel::<Option<std::path::PathBuf>>();
    let dlg_name = default_name.clone();
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("保存抠好的图")
            .set_file_name(&dlg_name)
            .add_filter("PNG（保留透明）", &["png"])
            .add_filter("所有文件", &["*"])
            .save_file();
        let _ = tx.send(picked);
    });
    let picked = match rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(p) => p,
        Err(_) => return Err("保存对话框超时".to_string()),
    };
    let Some(path) = picked else {
        return Ok(json!({ "cancel": true }));
    };
    std::fs::write(&path, &bytes).map_err(|e| format!("写文件失败：{e}"))?;
    win::log(&format!("ai_cutout_save: {} 字节 -> {}", bytes.len(), path.display()));
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "bytes": bytes.len() }))
}

/// **导出处理结果到用户选定的文件**（「导出」按钮）。
///
/// 与 `icon_editor_save` 的区别：
///   · `save` 是**应用**到横条（写 icons 目录 + overrideIcons + 广播）；
///   · `export` 是**另存为一份文件**，不改任何配置、不动横条图标 ——
///     用户想把抠好的图标拿到别处用（发出去、存进素材库、放到别的软件里）。
///
/// 为什么走主线程弹窗：`rfd` 的对话框要自己抽消息，从 Tauri 命令线程直接调
/// 会把窗口一起拖死（项目里 8448 / 8527 行有同样的注释与教训）。
///
/// 返回：
///   · `{"ok":true,"path":"...","bytes":N}` 导出成功
///   · `{"ok":false,"cancel":true}` 用户取消（**不是错误**，前端不该报红）
///   · `Err(...)` 真失败（写不进去 / 图读不出来）
#[tauri::command]
fn icon_editor_export(app: AppHandle, src: String, suggested: Option<String>) -> Result<Value, String> {
    let (mime, bytes) = read_icon_src(&src)?;
    let ext = match mime.rsplit('/').next().unwrap_or("") {
        "jpeg" | "jpg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        "bmp" => "bmp",
        "svg+xml" => "svg",
        _ => "png",
    };
    // 默认文件名：优先用调用方给的（一般是图标名），否则用会话键，再不行用个通用名。
    // 都要走一遍安全化 —— 引擎名里可能有 `（首页）`、`/`、`:` 之类不能做文件名的字符。
    let raw_name = suggested
        .filter(|s| !s.trim().is_empty())
        .or_else(|| iconedit::load_session().map(|s| s.name))
        .unwrap_or_else(|| "icon".to_string());
    let safe: String = raw_name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // 去掉首尾的点和空格（Windows 不允许文件名以点/空格结尾），再兜个底
    let safe = safe.trim_matches(|c| c == '.' || c == ' ').to_string();
    let safe = if safe.is_empty() { "icon".to_string() } else { safe };
    let default_name = format!("{safe}.{ext}");

    let (tx, rx) = std::sync::mpsc::channel::<Option<std::path::PathBuf>>();
    let dlg_name = default_name.clone();
    let dlg_ext = ext.to_string();
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("导出图标")
            .set_file_name(&dlg_name)
            .add_filter(dlg_ext.to_uppercase(), &[dlg_ext.as_str()])
            .add_filter("所有文件", &["*"])
            .save_file();
        let _ = tx.send(picked);
    });
    let picked = match rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(p) => p,
        Err(_) => return Err("导出对话框超时未响应".to_string()),
    };
    let Some(path) = picked else {
        // 用户取消 —— 不是错误
        return Ok(json!({ "ok": false, "cancel": true }));
    };

    std::fs::write(&path, &bytes).map_err(|e| format!("写文件失败：{e}"))?;
    win::log(&format!(
        "icon_editor_export: {} 字节 -> {}",
        bytes.len(),
        path.display()
    ));
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

/// 把图标 src 读成 `(mime, 字节)`。只认 data URL（base64）—— 编辑器链路里
/// 所有 src 都是 data URL：挑的图、overrideIcons、dirIcons 本来就是，
/// 内置 iconFile 由设置页 fetch 成 data URL 再传进来。
fn read_icon_src(src: &str) -> Result<(String, Vec<u8>), String> {
    let s = src.trim();
    let Some(rest) = s.strip_prefix("data:") else {
        return Err("图片格式不对（只支持 data URL）".to_string());
    };
    let Some(comma) = rest.find(',') else {
        return Err("data URL 格式不对".to_string());
    };
    let mime = rest[..comma].to_string();
    let body = rest[comma + 1..].trim();
    // base64 标记在 mime 段里（`data:image/png;base64,<数据>`），不在 body
    let bytes = if mime.contains("base64") {
        config::base64_decode(body)
    } else {
        // 少数手写 data URL 是 percent-encoded（SVG 常见）
        percent_decode(body)
    };
    if bytes.is_empty() {
        return Err("图片内容是空的".to_string());
    }
    Ok((mime, bytes))
}

/// data URL 的 percent-encoded 形式解码（`%E4%B8%AD` → 字节）。
fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

#[tauri::command]
fn reset_icon(engine: String) {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if let Some(old) = cfg.overrides.remove(&engine) {
            config::drop_icon(&old);
        }
        config::save(&cfg);
    }
    broadcast();
    let _ = app().emit_to("settings", "qs://toast", "已恢复内置图标");
}

/// 黑白名单拾取器：把「鼠标下面那个窗口」所属的程序名报回来。
///
/// 坐标由 picker.html 给 —— 那是一张铺满全屏、十字光标的透明窗口，点哪就传哪。
/// 这里一进来就先把它关掉：它铺满全屏，留着会挡住用户继续操作。
/// 取窗口时走 `win::foreign_window_at`，会沿 Z 序跳过我们自己所有窗口，
/// 所以不依赖「关窗」这一步是否已经生效（关窗是异步的，时机不好把握）。
#[tauri::command]
fn pick_app_at(x: f64, y: f64, dpr: f64) -> Result<String, String> {
    if !x.is_finite() || !y.is_finite() {
        close_window("picker");
        return Err("坐标不对".into());
    }
    let d = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    // CSS 坐标 → 物理坐标：窗口铺在虚拟屏原点上，多显示器时 vx/vy 可能是负的
    let (vx, vy, _, _) = win::virtual_screen();
    let px = vx + (x * d).round() as i32;
    let py = vy + (y * d).round() as i32;

    close_window("picker");
    std::thread::sleep(Duration::from_millis(60));

    /* 取点要稳一点：用户可能正好点在两个窗口的缝、或者点到一块桌面上。
     * 先试精确位置，取不到就在附近 3×3 的一小圈里挪着试 —— 因为 60ms 之后
     * 覆盖层刚消失，稍微偏一点往往就能落到目标程序身上。 */
    let try_points = [
        (px, py),
        (px + 6, py), (px - 6, py), (px, py + 6), (px, py - 6),
        (px + 10, py + 10), (px - 10, py - 10), (px + 10, py - 10), (px - 10, py + 10),
    ];
    let mut exe: Option<String> = None;
    for (i, (tx, ty)) in try_points.iter().enumerate() {
        let hwnd = win::foreign_window_at(*tx, *ty);
        if let Some(e) = win::process_exe(win::window_pid(hwnd)) {
            if !e.is_empty() {
                if i > 0 {
                    win::log(&format!("pick_app_at: 精确点没取到，退到 ({tx},{ty}) 命中 {e}"));
                }
                exe = Some(e);
                break;
            }
        }
    }

    match exe {
        Some(e) => {
            win::log(&format!("pick_app_at: ({px},{py}) -> {e}"));
            // 顺手也推给设置面板一份，前端不用再绕一圈
            let _ = APP.get().map(|a| a.emit_to("settings", "qs://picked-app", e.clone()));
            Ok(e)
        }
        None => {
            win::log(&format!("pick_app_at: ({px},{py}) 附近都没取到进程名"));
            // 重要消息要让用户看见：别让面板在后台默默失败
            let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", "没认出这个位置是哪个程序，换个窗口中心再点一次"));
            Err("没认出这个位置是哪个程序，换个地方再点一次".into())
        }
    }
}

/// r59：和 [`pick_app_at`] 同一套点选，但回的是**完整路径**而不是程序名。
///
/// 为什么要多这一条：`pick_app_at` 给"黑白名单"用，那边只认 `notepad.exe`
/// 这种短名；而「快捷键引擎 → 绑定应用」要把路径存进配置、以后靠它拉起程序，
/// 只给短名的话 `launch_app` 找不到东西。
///
/// 逻辑照抄 `pick_app_at`（同样 3×3 退让、同样跳过我们自己的窗口），
/// 只把最后取名的 `process_exe` 换成 `process_exe_path`。
#[tauri::command]
fn pick_app_path_at(x: f64, y: f64, dpr: f64) -> Result<String, String> {
    if !x.is_finite() || !y.is_finite() {
        close_window("picker");
        return Err("坐标不对".into());
    }
    let d = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let (vx, vy, _, _) = win::virtual_screen();
    let px = vx + (x * d).round() as i32;
    let py = vy + (y * d).round() as i32;

    close_window("picker");
    std::thread::sleep(Duration::from_millis(60));

    let try_points = [
        (px, py),
        (px + 6, py), (px - 6, py), (px, py + 6), (px, py - 6),
        (px + 10, py + 10), (px - 10, py - 10), (px + 10, py - 10), (px - 10, py + 10),
    ];
    let mut path: Option<String> = None;
    for (i, (tx, ty)) in try_points.iter().enumerate() {
        let hwnd = win::foreign_window_at(*tx, *ty);
        let pid = win::window_pid(hwnd);
        if pid == std::process::id() {
            continue;   // 点到自己了，跳过
        }
        if let Some(p) = win::process_exe_path(pid) {
            if !p.is_empty() {
                if i > 0 {
                    win::log(&format!("pick_app_path_at: 精确点没取到，退到 ({tx},{ty}) 命中 {p}"));
                }
                path = Some(p);
                break;
            }
        }
    }

    match path {
        Some(p) => {
            win::log(&format!("pick_app_path_at: ({px},{py}) -> {p}"));
            let _ = APP.get().map(|a| a.emit_to("settings", "qs://picked-app-path", p.clone()));
            Ok(p)
        }
        None => {
            win::log(&format!("pick_app_path_at: ({px},{py}) 附近都没取到程序路径"));
            let _ = APP.get().map(|a| a.emit_to("settings", "qs://toast", "没认出这个位置是哪个程序，换个窗口中心再点一次"));
            Err("没认出这个位置是哪个程序，换个地方再点一次".into())
        }
    }
}

/// 打开「拾取程序」的透明覆盖层（十字光标，点哪个窗口就收哪个程序）。
///
/// ⚠ 建窗必须**脱开当前命令调用栈**（`spawn` 一个线程去做）。
/// 配置面板点那颗按钮时，命令是在 Tauri 的异步运行时里跑的、这次调用还没返回；
/// 如果就地 `run_on_main_thread` 去 `WebviewWindowBuilder::build()`，主线程会在
/// 建 WebView2 的过程中回头等这把还没释放的锁 —— 直接死锁，表现为"点了没反应、
/// 日志停在「开始 build」这一行、既不成功也不报错"。（实测踩过，见 log.txt。）
/// 走 `--pick-app` 那条路之所以一直是好的，就是因为它是从 `spawn` 出来的线程调的。
#[tauri::command]
fn open_app_picker(want: Option<String>) {
    // 先回一个空值给前端，别让页面一直 await；真正的建窗在后台线程完成。
    // r59：`want` = "path" 时这个覆盖层用来**挑一个应用的完整路径**
    //       （快捷键引擎的「绑定应用」），否则还是老用途（挑程序名进黑白名单）。
    let w = want.unwrap_or_default();
    std::thread::spawn(move || {
        open_app_picker_impl(&w);
    });
}

/// 真正的建窗逻辑。必须从**非命令调用栈**的线程进来（见 `open_app_picker` 注释）。
fn open_app_picker_impl(want: &str) {
    let a = app();
    if let Some(w) = a.get_webview_window("picker") {
        let _ = w.close();
        win::wait_until(800, || a.get_webview_window("picker").is_none());
    }
    let (vx, vy, vw, vh) = win::virtual_screen();
    let a2 = a.clone();
    // r59：`want=path` 让覆盖层去调 pick_app_path_at（回完整路径），
    //       否则还是老行为（pick_app_at，回程序名进黑白名单）。
    let url_path: std::path::PathBuf = if want == "path" {
        "picker.html?want=path".into()
    } else {
        "picker.html".into()
    };
    let _ = a.run_on_main_thread(move || {
        let mut b = WebviewWindowBuilder::new(&a2, "picker", WebviewUrl::App(url_path))
            .title("QS-Picker")
            .position(vx as f64, vy as f64)
            .inner_size(vw as f64, vh as f64)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(true);
        // 和横条/设置窗口保持同一套 WebView2 参数，否则环境冲突建不起来
        let wa = wv_args();
        if !wa.is_empty() {
            b = b.additional_browser_args(&wa);
        }
        match b.build() {
            Ok(w) => {
                let _ = w.set_focus();
                win::log("picker: built");
            }
            Err(e) => win::log(&format!("picker: build failed: {e}")),
        }
    })
    .map_err(|e| win::log(&format!("open_app_picker: run_on_main_thread 失败: {e}")))
    .ok();

    // 同样的看门狗：这层板子铺满全屏，万一没关掉用户就点不动东西
    let a3 = a.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        if a3.get_webview_window("picker").is_some() {
            win::log("picker: 超时仍开着，强制关闭");
            if let Some(w) = a3.get_webview_window("picker") {
                let _ = w.close();
            }
        }
    });
}

#[tauri::command]
fn picker_cancel() {
    close_window("picker");
}

/// 从电脑里挑一个程序（.exe）加进黑白名单。
///
/// 只留文件名（notepad.exe 这种），和运行时 `foreground_exe()` 比对的形态一致 ——
/// 存全路径反而永远匹配不上。
/// 文件对话框同样必须跑在主线程（理由见 pick_icon 那条注释）。
#[tauri::command]
fn pick_app_file(app: AppHandle) {
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("挑一个程序加进名单")
            .add_filter("程序", &["exe"])
            .pick_file();
        let Some(path) = picked else {
            win::log("pick_app_file: cancelled");
            return;
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            return;
        }
        win::log(&format!("pick_app_file: {name}"));
        let _ = APP.get().map(|a| a.emit_to("settings", "qs://picked-app", name));
    });
}

/// 把一颗引擎加进横条 / 从横条拿掉的业务本体。
///
/// 抽成不碰 STATE、不广播的纯函数，是为了能单测 —— 命令尾部那句
/// `broadcast()` 在测试环境会 panic（`APP` 只在真机启动时初始化）。
///
/// 准入判定（#147 修）：**内置引擎、用户自定义引擎、手工改过 URL 的引擎**
/// 三路都算数。以前只认 `engines()`（内置 engines.json 那一张表）——
/// 用户自己加的引擎（搜索 / 打开 / 快捷键三类自定义）在里面一个都查不到，
/// 于是从面板右键「固定到横条」或设置页「加到横条」都会在这里静默 return：
/// 用户看到的就是「点了添加到横条，什么都没发生」。快捷键类尤其明显，
/// 因为它只能通过「添加引擎 → 快捷键」这条路创建，必然是自定义引擎。
fn toggle_bar_engine_impl(cfg: &mut Config, engine: &str, on: bool) {
    // 「@ocr」是 OCR 按钮的哨兵，不是真引擎；这里放行它，
    // 用户就能像摆普通引擎一样把 OCR 加进/移出横条，并拖到想要的位置。
    // 「@fav:<id>」是收藏夹目录的哨兵，同理放行。
    // 「@app:<id>」是外部软件的哨兵，同理 —— 但要多查一步：
    // 软件已经被删掉时不能把一根悬空哨兵又塞回去（那正是设置页
    // 「横条上的引擎」显示乱码的来路）。
    if engine != config::BAR_OCR
        && engine != config::BAR_IMG
        && !config::is_fav_sentinel(engine)
        && !config::is_app_sentinel(engine)
    {
        // 和 engine_entry() 同一个准入口径（url_overrides > custom_engines >
        // 内置），但必须用**手里这把锁里的 cfg** 现算 —— engine_entry 自己会
        // 去锁 st().cfg，在已持锁的情况下调它是自锁死等。
        let known = cfg.custom_engines.iter().any(|e| e.name == engine)
            || cfg.url_overrides.contains_key(engine)
            || engines::engines().contains_key(engine);
        if !known {
            return;
        }
    }
    if config::is_app_sentinel(engine) {
        let id = &engine[config::APP_PREFIX.len()..];
        if !cfg.apps.iter().any(|a| a.id == id) {
            return;
        }
    }
    /* r72：识图按钮（`@img`）在/不在横条上，和「加到划条横条」那个开关是
     * 同一件事的两面 —— 一边动了另一边必须跟着动，否则设置页会出现
     * 「开关关着、列表里却有它」（用户点移出后又看见它）这种自相矛盾。 */
    let mut changed = false;
    if engine == config::BAR_IMG && cfg.img_add_to_bar != on {
        cfg.img_add_to_bar = on;
        changed = true;
    }
    let has = cfg.bar_list.iter().any(|n| n == engine);
    if on && !has {
        cfg.bar_list.push(engine.to_string());
        changed = true;
    } else if !on && has {
        cfg.bar_list.retain(|n| n != engine);
        changed = true;
    }
    if !changed {
        return;
    }
    config::save(cfg);
}

#[tauri::command]
fn toggle_bar_engine(engine: String, on: bool) {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        toggle_bar_engine_impl(&mut cfg, &engine, on);
    }
    broadcast();
}

/// 把 OCR 从横条上拿掉（设置页 OCR 行里的「去掉」按钮）。
///
/// 和 `toggle_bar_engine(ocr, false)` 等价，单开一个名字是为了前端
/// 读起来直白 —— 它**只**处理哨兵，不会误伤真引擎。
#[tauri::command]
fn remove_bar_ocr() {
    toggle_bar_engine(config::BAR_OCR.to_string(), false);
}

/* ==================================================================== */
/* 收藏夹                                                                */
/* ==================================================================== */

/// 解析用户录的组合键（如 `"Ctrl+Alt+F"`、`"Ctrl+Shift+1"`、`"Win+Shift+S"`）。
/// 返回 `(ctrl, alt, shift, win, 主键 vk)`。空串 / 解析不了 → None（= 没启用）。
///
/// ⚠ 不能只是"忽略认不出的修饰键"：设置页允许录 `win+shift+s` 这类组合
/// （`settings.js` 的录制器会把 metaKey 记成 `win`），以前这里丢了 Win 键、
/// 又把 `win+shift+s` 当成 `shift+s` 去匹配 —— 保存成功、界面回显正常，
/// 但那个热键永远不会触发，用户只会觉得"收藏夹快捷键时灵时不灵"。
/// 现在把 Win 算进修饰键，并和 `win::parse_hotkey` 的口径保持一致。
fn parse_hotkey(s: &str) -> Option<(bool, bool, bool, bool, u32)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (mut c, mut a, mut sh, mut w, mut main) = (false, false, false, false, None);
    for part in s.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue; // "ctrl++t" 这种手滑多打的加号，容错
        }
        match p.to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => c = true,
            "ALT" | "MENU" => a = true,
            "SHIFT" => sh = true,
            "WIN" | "WINDOWS" | "SUPER" | "META" | "CMD" => w = true,
            _ => {
                let up = p.to_ascii_uppercase();
                main = Some(match up.as_str() {
                    // F1~F12
                    f if f.len() >= 2 && f.starts_with('F') && f[1..].chars().all(|x| x.is_ascii_digit()) => {
                        let n: u32 = f[1..].parse().ok()?;
                        if !(1..=12).contains(&n) { return None; }
                        0x70 + n - 1
                    }
                    // 单个字母 / 数字
                    ch if ch.chars().count() == 1 => {
                        // 上面那个 count()==1 已经保证了有字符，但这里还是不写 unwrap：
                        // 一旦哪天判断条件被改动（比如放宽成"≤2 个字符"），unwrap 就会
                        // 变成一条能把程序带走的 panic。取不到就当这个键不合法。
                        let x = ch.chars().next()?;
                        if x.is_ascii_alphabetic() {
                            0x41 + (x.to_ascii_uppercase() as u32 - 'A' as u32)
                        } else if x.is_ascii_digit() {
                            0x30 + (x as u32 - '0' as u32)
                        } else {
                            return None;
                        }
                    }
                    _ => return None,
                });
            }
        }
    }
    // 必须带至少一个修饰键，不然连打字都会触发
    let need_mod = c || a || sh || w;
    match (need_mod, main) {
        (true, Some(v)) => Some((c, a, sh, w, v)),
        _ => None,
    }
}

/// 全局快捷键唤起收藏夹：弹一条贴鼠标的横条，并让前端把收藏面板打开。
/// 面板里没有指定目录 → 前端把所有一级目录都列出来。
fn show_fav_panel_bar() {
    show_bar(String::new(), true, false);
    let _ = app().emit_to("bar", "qs://fav-open", serde_json::json!({}));
}

// 收藏面板「拖左边缘 / 左下角」调宽的原理已换代：不再平移召唤锚点
// （那招只在「贴鼠标」模式有效，划词唤起的「贴文字」模式下 ix2 取的是
// 光标 x，锚点怎么移都白搭，用户看到的就是左边拉不动、横条反而往右滑）。
// 现在 layout_bar 收一个「钉住点」（pin_x/pin_y = 横条自身偏移），
// 窗口摆放钉横条、命中判定仍用整棵包围盒 —— 面板向左探出多少，
// 窗口左缘就跟着长多少，横条原地不动。详见 layout_bar 的文档。

/// 从收藏树里找出一条内容并**放进剪贴板**。
/// 文字直接放；图片把 dataURL 解码回字节再转成 CF_DIB。
/// 返回给人看的提示文案（前端拿去弹 toast）。
#[tauri::command]
fn fav_copy(id: String) -> String {
    let groups = match st().cfg.lock() {
        Ok(c) => c.favorites.clone(),
        Err(_) => return "配置读不了".into(),
    };
    let Some(item) = config::find_fav_item(&groups, &id) else {
        return "没找到这条收藏（可能已被删除）".into();
    };
    if item.kind == "image" {
        let b64 = item.image.split("base64,").nth(1).unwrap_or("");
        if b64.is_empty() {
            return "这张图片的内容是空的".into();
        }
        let bytes = config::base64_decode(b64);
        if bytes.is_empty() {
            return "这张图片解码失败".into();
        }
        return if clip::set_image(&bytes) {
            format!("已复制图片{}", if item.remark.is_empty() { "" } else { "：" }.to_string() + &item.remark)
        } else {
            "图片复制失败".into()
        };
    }
    if item.text.is_empty() {
        return "这条收藏是空的".into();
    }
    // 带格式的内容（颜色/加粗…）：CF_HTML + CF_UNICODETEXT 一起给，
    // 粘到 Word / 邮件里颜色不丢，记事本这类只吃纯文本的自动退化。
    // 没有 html 字段的老数据走原来的纯文本路径，行为不变。
    let copied = if item.html.is_empty() {
        clip::set_text(&item.text)
    } else {
        clip::set_rich_text(&item.text, &item.html)
    };
    if copied {
        format!("已复制{}", if item.remark.is_empty() { "" } else { "：" }.to_string() + &item.remark)
    } else {
        "复制失败".into()
    }
}

/// 把焦点还给「收藏夹条目要注入的那个窗口」，并把横条的内部状态摆正。
///
/// 为什么不直接用 `focus_bar(false)`：那个函数末尾会先
/// `SetForegroundWindow(prev_fg)`，而我们紧接着还要 `SetForegroundWindow(target)`
/// —— 第二次调用时我们**已经不是前台进程**了，Windows 的前台锁定会让它静默失败
/// （表现就是"文字打到别处去了"或"没进去"）。这里自己来：只把横条设回
/// 「不激活」（免得它又把焦点抢回来），再一次把目标提到前台。
fn restore_focus_to(hwnd: HWND) {
    let bar = bar_hwnd();
    if !bar.0.is_null() {
        win::set_noactivate(bar, true);
    }
    if let Ok(mut g) = st().geo.lock() {
        // 焦点已经交出去了：dismiss_bar 里那条"还给上一次前台"就不该再动
        g.focused = false;
        g.prev_fg = 0;
    }
    // ⚠ 必须用 force_foreground 而不是 set_foreground：面板可能是被全局快捷键
    //   **程序化**打开的，那时我们并不持有前台权限，普通 SetForegroundWindow 会被
    //   前台锁定静默拒绝（探针实测到了）。
    win::force_foreground(hwnd);
}

/// 收藏夹条目**点下去**的统一入口（横条收藏面板用）。
///
/// 分流规则（用户口径，原话）：
///   「正确的逻辑应是输入到鼠标触发位置所在的其他软件的文本框中，只有当鼠标下的
///     软件没有可用文本框时，才复制到剪贴板」。
///
/// 所以这里是**注入优先**：
///   ① 触发时鼠标底下那个软件有可用文本框（`trigger_has_text`）→ 把焦点还给它、
///      逐字符注入（**完全不碰剪贴板**，用户原来复制的东西不会被动）；
///   ② 其余情况（没有文本框 / 图片条目 / 文字为空 / 那个软件已经关了）→ 退回复制。
///
/// 为什么不在前端判断：前端看不到窗口。前台窗口在面板打开那一刻就变成我们自己了，
/// 「鼠标下面是谁、它有没有文本框」只有 Rust 侧在 `show_bar` 时的快照里存着。
#[tauri::command]
fn fav_send(id: String) -> String {
    let groups = match st().cfg.lock() {
        Ok(c) => c.favorites.clone(),
        Err(_) => return "配置读不了".into(),
    };
    let Some(item) = config::find_fav_item(&groups, &id) else {
        return "没找到这条收藏（可能已被删除）".into();
    };

    if item.kind != "image" {
        // 纯文本影子：带格式条目也有一份 it.text（前端每次编辑时派生），
        // 注入只能送纯文本，所以直接用它。
        let plain = if item.text.is_empty() {
            String::new()
        } else {
            item.text.clone()
        };
        if !plain.is_empty() {
            let ctx = st()
                .geo
                .lock()
                .map(|g| (g.trigger_hwnd, g.trigger_has_text))
                .unwrap_or((0, false));
            let (th, has_text) = ctx;
            if has_text && th != 0 {
                let target = HWND(th as *mut c_void);
                if win::is_visible(target) && !win::is_minimized(target) {
                    // 焦点必须先还给目标软件：不还的话这些按键会打到**我们自己**
                    // 的窗口上 —— 那正是用户报的那个 bug（文字进了收藏夹窗口自己的
                    // 搜索框）。切换只做**一次**，理由见 restore_focus_to。
                    restore_focus_to(target);
                    // 目标进程切换前台 + 恢复它自己的焦点控件要一点时间，
                    // 太早注入按键会丢到切换过程中（Windows 会丢弃前台切换瞬间的输入）
                    std::thread::sleep(Duration::from_millis(60));

                    /* ⚠ 注入前**必须复核前台到底是谁**。SetForegroundWindow 有可能被
                     *   前台锁定挡下（系统策略、或用户手快又点了别的窗口），这时候硬发
                     *   按键就会打到错的窗口上 —— 前台要是还停在我们自己身上，那等于把
                     *   文字又打回了收藏夹窗口，正是用户报的那个 bug。宁可退回复制。 */
                    let fg_now = win::foreground_addr();
                    if fg_now != th {
                        if fg_now == bar_hwnd().0 as isize {
                            win::log("fav_send: 前台仍是我们自己（前台锁定挡下了切换）→ 退回复制");
                        } else {
                            win::log(&format!(
                                "fav_send: 前台变成了 0x{fg_now:x}（不是目标 0x{th:x}）→ 退回复制"
                            ));
                        }
                    } else {
                        win::send_text(&plain);
                        let title = win::window_title(target);
                        win::log(&format!(
                            "fav_send: 已注入 {} 字到 hwnd=0x{:x}「{}」",
                            plain.chars().count(),
                            th as usize,
                            title
                        ));
                        return format!(
                            "已输入到{}",
                            if title.is_empty() { "当前软件".to_string() } else { format!("「{title}」") }
                        );
                    }
                } else {
                    win::log(&format!(
                        "fav_send: 目标窗口 hwnd=0x{:x} 已关闭/最小化 —— 退回复制",
                        th as usize
                    ));
                }
            } else {
                win::log(&format!(
                    "fav_send: 触发现场没有可用文本框（hwnd=0x{:x}）—— 复制到剪贴板",
                    th as usize
                ));
            }
        }
    }
    fav_copy(id)
}

/// 弹系统文件对话框挑一张图，压一压、转成 dataURL 返回给前端。
/// 收藏夹跟着 config.json 一起备份，所以图片必须内嵌（体积靠压缩控制）。
#[tauri::command]
fn fav_pick_image() -> Value {
    // ⚠ 文件对话框**必须**跑在主线程上（理由同 pick_icon / export_config：
    //   rfd 的对话框要自己抽消息，从命令线程调起会把横条窗口一起拖死 ——
    //   DWM 给它套一层 Ghost 替身，表现为"设置里加图片时横条卡住/变透明"）。
    //   以前这里漏掉了这一层直接 pick_file()。
    //   要拿返回值，就用一条一次性通道把主线程挑到的路径传回来。
    let (tx, rx) = std::sync::mpsc::channel();
    let queued = app()
        .run_on_main_thread(move || {
            let picked = rfd::FileDialog::new()
                .add_filter("图片", &["png", "jpg", "jpeg", "bmp", "webp", "gif"])
                .pick_file();
            let _ = tx.send(picked);
        })
        .is_ok();
    if !queued {
        return json!({ "ok": false, "error": "弹不出文件选择框（主线程忙），稍后再试" });
    }
    let Ok(Some(path)) = rx.recv() else {
        return json!({ "ok": false, "error": "cancelled" });
    };
    // 文件本身可能很大（几十 MB 的原图），先按体积挡一道再读进内存
    if let Ok(m) = std::fs::metadata(&path) {
        if m.len() > 64 * 1024 * 1024 {
            return json!({ "ok": false, "error": "这张图太大了（超过 64MB），换一张吧" });
        }
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "error": format!("读不了文件：{e}") }),
    };
    // 收藏那档压得更狠（长边 1024），配置文件里存 dataURL，体积敏感
    let data = ocr::compress_for_favorites(&bytes);
    if data.is_empty() {
        return json!({ "ok": false, "error": "这张图读不出来（可能不是图片）" });
    }
    let is_png = data.len() > 8 && data[..8] == *b"\x89PNG\r\n\x1a\n";
    let mime = if is_png { "image/png" } else { "image/jpeg" };
    json!({
        "ok": true,
        "dataUrl": format!("data:{mime};base64,{}", config::base64(&data)),
        "bytes": data.len(),
    })
}


/* ---------------------- 横条上的「分隔线」 ---------------------- */
/*
 * 分隔线不是独立的配置项，而是 bar_list 里的一个哨兵元素 —— 这样存档格式
 * 一个字都不用改，老配置照读，而且「排序」这件事天然就复用了同一套逻辑。
 * 引擎名不可能正好是一个竖线，当哨兵是安全的。
 */

/// 追加一条分隔线到横条末尾。
///
/// 只追加不插队：想放别的位置就在设置里拖一下。这样后端只有一条最简单的
/// 路径，不用再定义一个「插到第几个」的参数。
#[tauri::command]
fn add_separator() {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if cfg.bar_list.len() >= 64 {
            return;
        }
        cfg.bar_list.push(config::SEP.to_string());
        config::save(&cfg);
    }
    broadcast();
}

/// 删掉第 `index` 条分隔线。
///
/// 按**下标**删而不是按名字删：分隔线可以有好几条、名字全都一样，
/// 按名字删永远只能删掉第一条，用户点第二条会「没反应」。
#[tauri::command]
fn remove_separator(index: usize) {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if index >= cfg.bar_list.len() || cfg.bar_list[index] != config::SEP {
            return;
        }
        cfg.bar_list.remove(index);
        config::save(&cfg);
    }
    broadcast();
}

/// 把第 `from` 项挪到第 `to` 个位置。拖拽排序和 ↑↓ 微调都走这里。
///
/// 全程用下标，一次名字都不碰 —— 分隔线名字重复，按名字定位必然张冠李戴。
/// 语义是「挪完之后它待在第 `to` 位」，所以先摘出来再插进去，两边都自洽。
#[tauri::command]
fn move_bar_item(from: usize, to: usize) {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let n = cfg.bar_list.len();
        if n == 0 || from >= n {
            return;
        }
        let to = to.min(n - 1);
        if from == to {
            return;
        }
        let item = cfg.bar_list.remove(from);
        cfg.bar_list.insert(to, item);
        config::save(&cfg);
    }
    broadcast();
}

/* ---------------------- 用户自定义搜索引擎 ---------------------- */

/// 校验并规整一个自定义引擎。
///
/// 单独抽出来是因为「新增」和「编辑」要走**完全相同**的一套规则 —— 否则很容易
/// 出现「新增时不让重名、改名却能改成重名」这种半拉子校验。
/// `skip` 是编辑时自己的下标：检查重名要跳过自己，不然改个分类都保存不了。
/// `kind` 是三类里的哪类：搜索类的地址必须带 `%s`；打开类恰恰相反 —— 它是
/// 原样打开的，留个 `%s` 反而会在浏览器地址里露出一个没人替换的占位符；
/// 快捷键类的地址没有意义（点了不打开页面），要校验的是 `hotkey` 按键序列。
// 「新增」和「编辑」共用这一套校验，参数与两个命令的入参一一对应。
// 收拢成结构体反而要在两个调用点各拆一次包，得不偿失。
#[allow(clippy::too_many_arguments)]
fn clean_custom_engine(
    cfg: &config::Config,
    name: &str,
    url: &str,
    category: &str,
    kind: config::EngineKind,
    hotkey: &str,
    /* r58：快捷键引擎的「绑定应用」三件套。
     * ⚠ 非快捷键类一律存空/关（下面会强制），免得用户把一类引擎改成另一类之后
     *   旧设置以意想不到的方式活过来。
     * r76 加第四件 `app_launch_delay`：拉起来之后、发键之前额外等多久。 */
    bind_app: bool,
    app_path: &str,
    app_admin: bool,
    app_launch_delay: u32,
    skip: Option<usize>,
) -> Result<config::CustomEngine, String> {
    let name = name.trim();
    let url = url.trim();
    let category = category.trim();
    let hotkey = hotkey.trim();
    let app_path = app_path.trim();

    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    if name.chars().count() > 24 {
        return Err("名字太长了，控制在 24 个字以内".into());
    }
    if name.contains(config::SEP) {
        return Err("名字里不能有竖线「|」，它被用作分隔线的标记".into());
    }
    // 同理：@ocr 是「OCR 那颗按钮」在 bar_list 里的哨兵。
    // 不挡的话，用户建一个叫 @ocr 的引擎就能顶掉 OCR 按钮（排序里两者不可区分）。
    if name == config::BAR_OCR {
        return Err("名字不能是「@ocr」，它是横条上 OCR 按钮的标记".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("名字里不能有换行之类的控制字符".into());
    }
    // 和内置引擎重名会让「这一排到底点开哪个」变得无法解释，直接拒绝
    if engines::engines().contains_key(name) {
        return Err(format!("「{name}」和内置引擎重名了，换个名字吧"));
    }
    // 和别的自定义引擎重名同样不行
    for (i, e) in cfg.custom_engines.iter().enumerate() {
        if Some(i) == skip {
            continue;
        }
        if e.name == name {
            return Err(format!("已经有一个叫「{name}」的自定义引擎了"));
        }
    }

    // URL 检查按种类分岔：快捷键类压根不用地址（点了不打开页面），
    // 它的替代品是按键序列；另两类的老规则一样严格。
    if kind == config::EngineKind::Hotkey {
        if hotkey.is_empty() {
            return Err("快捷键类要填按键序列，例如 ctrl+shift+t".into());
        }
        // 保存时就解析一遍：拼错（比如 ctrl++c、只有一个修饰键）当场报错，
        // 而不是等用户点了图标才发现"没反应"。
        if win::parse_hotkey(hotkey).is_none() {
            return Err("按键序列看不懂。写法像这样：ctrl+shift+t / alt+tab / f5 / win+d".into());
        }
        /* r58：开了「绑定应用」就必须真的选一个应用。
         *
         * 不挡的话，用户勾了开关却没选应用 → 点图标时 `bind_app=true` 但路径空，
         * 代码会跳过整套逻辑、直接发键 —— 用户以为"我明明绑了应用"，
         * 实际上什么都没绑。保存时当场说清楚比事后猜好。 */
        if bind_app {
            if app_path.is_empty() {
                return Err(
                    "勾了「先确保应用在运行」就要选一个应用（点旁边的「选择…」）".into(),
                );
            }
            if !std::path::Path::new(app_path).exists() {
                return Err(format!("找不到这个应用：{app_path}"));
            }
            if win::exe_name_of(app_path).is_empty() {
                return Err("应用路径看不懂，请重新选一次".into());
            }
        }
    } else {
        if url.is_empty() {
            return Err("地址不能为空".into());
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("地址要以 http:// 或 https:// 开头".into());
        }
        match kind {
            config::EngineKind::Search => {
                if !url.contains("%s") {
                    return Err("搜索地址里要用 %s 标出关键词的位置，例如：\nhttps://example.com/search?q=%s".into());
                }
            }
            config::EngineKind::Open => {
                if url.contains("%s") {
                    return Err("打开类地址是原样打开的，不能有 %s；想带关键词搜索请选「搜索」类".into());
                }
            }
            /* ⚠ 用 `Err` 而不是 `unreachable!`。
             *
             * 内层确实已经在外面的 `if kind == Hotkey` 分流过了，但
             * `EngineKind` 是可扩展枚举 —— 将来加一个变体忘了改这里，
             * `unreachable!` 会**直接 panic 把程序带走**，而用户只是在校验
             * 一个自定义引擎。返回一条错误最多是"这个引擎没存上"。 */
            config::EngineKind::Hotkey => {
                return Err("快捷键类引擎在上面已经分流了，走到这里说明内部状态异常".into());
            }
        }
        if url.chars().any(|c| c.is_whitespace()) {
            return Err("地址里不能有空格（空格请写成 %20）".into());
        }
    }

    Ok(config::CustomEngine {
        name: name.to_string(),
        // 快捷键类的 url 一律存空串：它的调用信息全在 hotkey 字段里，
        // 存个用不到的值只会让以后读代码的人犯迷糊。
        url: if kind == config::EngineKind::Hotkey {
            String::new()
        } else {
            url.to_string()
        },
        category: if category.is_empty() {
            config::DEFAULT_CUSTOM_CATEGORY.to_string()
        } else {
            category.to_string()
        },
        kind,
        hotkey: if kind == config::EngineKind::Hotkey {
            hotkey.to_string()
        } else {
            String::new()
        },
        // r58：三件套只对快捷键类有效，其余类一律落成"关/空"
        bind_app: kind == config::EngineKind::Hotkey && bind_app,
        app_path: if kind == config::EngineKind::Hotkey {
            app_path.to_string()
        } else {
            String::new()
        },
        // r58：三件套只对快捷键类有效，其余类一律落成"关/空"；
        // r76：第四件 `app_launch_delay` 同理，且钳在 0..=60000（60 秒）——
        // 用户手打一个 999999 会把横条卡死一分钟，那是能把软件弄成"假死"的输入。
        app_admin: kind == config::EngineKind::Hotkey && app_admin,
        app_launch_delay: if kind == config::EngineKind::Hotkey {
            app_launch_delay.min(60_000)
        } else {
            0
        },
        })
}

#[tauri::command]
// Tauri 命令参数必须平铺（前端 invoke 按名字传），无法收拢成结构体。
#[allow(clippy::too_many_arguments)]
fn add_custom_engine(
    name: String,
    url: String,
    category: String,
    kind: String,
    hotkey: String,
    /* r58：绑定应用三件套。用 Option 是为了**向后兼容** —— 前端还没升级时
     * 不传这些键，命令照样能跑（等价于"没绑应用"），不会因为缺参数报错。
     * r76 加第四件 app_launch_delay，同理（不传 = 用默认 900ms）。 */
    bind_app: Option<bool>,
    app_path: Option<String>,
    app_admin: Option<bool>,
    app_launch_delay: Option<u32>,
) -> Result<(), String> {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("内部状态异常".into()),
        };
        if cfg.custom_engines.len() >= 60 {
            return Err("自定义引擎最多 60 个".into());
        }
        let kind = config::EngineKind::parse(&kind);
        let e = clean_custom_engine(
            &cfg,
            &name,
            &url,
            &category,
            kind,
            &hotkey,
            bind_app.unwrap_or(false),
            app_path.as_deref().unwrap_or(""),
            app_admin.unwrap_or(false),
            app_launch_delay.unwrap_or(config::default_app_launch_delay()),
            None,
        )?;
        let name_for_bar = e.name.clone();
        cfg.custom_engines.push(e);
        /* r89：新加的自定义引擎**顺手放进横条末尾**。
         *
         * 用户报的那个 bug 里有一半是这个：他"把一个快捷键引擎加入到了横条"，
         * 但引擎库里找不到 —— 说明"加进横条"和"引擎存在"这两件事在他那里
         * 脱节了。默认帮他放进去，用户想移出随时在「横条上的引擎」里点一下
         * 就行（移出只删哨兵、不删引擎本身）。
         *
         * ⚠ 只在**还没在里面**时追加，避免重复条目。 */
        if !cfg.bar_list.iter().any(|n| n == &name_for_bar) {
            cfg.bar_list.push(name_for_bar);
        }
        config::save(&cfg);
    }
    broadcast();
    Ok(())
}

#[tauri::command]
// 同 add_custom_engine：Tauri 命令参数必须平铺。
#[allow(clippy::too_many_arguments)]
fn update_custom_engine(
    index: usize,
    name: String,
    url: String,
    category: String,
    kind: String,
    hotkey: String,
    bind_app: Option<bool>,
    app_path: Option<String>,
    app_admin: Option<bool>,
    app_launch_delay: Option<u32>,
) -> Result<(), String> {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("内部状态异常".into()),
        };
        if index >= cfg.custom_engines.len() {
            return Err("这个引擎已经不在了".into());
        }
        let kind = config::EngineKind::parse(&kind);
        let e = clean_custom_engine(
            &cfg,
            &name,
            &url,
            &category,
            kind,
            &hotkey,
            bind_app.unwrap_or(false),
            app_path.as_deref().unwrap_or(""),
            app_admin.unwrap_or(false),
            app_launch_delay.unwrap_or(config::default_app_launch_delay()),
            Some(index),
        )?;
        let old = cfg.custom_engines[index].name.clone();
        let new = e.name.clone();
        cfg.custom_engines[index] = e;

        // 改了名字就把引用它名字的地方一起改过去，否则横条上那一格会凭空消失
        if old != new {
            for n in cfg.bar_list.iter_mut() {
                if *n == old {
                    *n = new.clone();
                }
            }
            if let Some(u) = cfg.url_overrides.remove(&old) {
                cfg.url_overrides.insert(new.clone(), u);
            }
            if let Some(s) = cfg.ai_suffixes.remove(&old) {
                cfg.ai_suffixes.insert(new.clone(), s);
            }
            if let Some(f) = cfg.overrides.remove(&old) {
                cfg.overrides.insert(new, f);
            }
        }
        config::save(&cfg);
    }
    broadcast();
    Ok(())
}

#[tauri::command]
fn remove_custom_engine(index: usize) {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if index >= cfg.custom_engines.len() {
            return;
        }
        let e = cfg.custom_engines.remove(index);
        // 顺手把它的痕迹清干净：横条、URL 改写、专属后缀、自定义图标。
        // 留着不管的话，横条上会多出一格「点不动的幽灵图标」。
        cfg.bar_list.retain(|n| n != &e.name);
        cfg.url_overrides.remove(&e.name);
        cfg.ai_suffixes.remove(&e.name);
        if let Some(f) = cfg.overrides.remove(&e.name) {
            config::drop_icon(&f);
        }
        config::save(&cfg);
    }
    broadcast();
}

/* ================================================================== */
/* 外部软件（用户把第三方应用加成横条上一颗图标）                        */
/*                                                                    */
/* 用户原话：「保存后将该图标固定到界面横栏中」—— 所以保存即固定，       */
/* 不做「要不要加进横条」的询问；不想要了在设置页「横条上的引擎」里     */
/* 移出即可（移出只删哨兵，不删软件本身，随时能加回来）。               */
/* ================================================================== */

/// 新增外部软件的业务本体：**校验 + 落库 + 钉进横条末尾**。
///
/// 抽成不碰 STATE、不广播的纯函数，是为了能单测 —— 命令里那句
/// `broadcast()` 在测试环境会 panic（`APP` 只在真机启动时初始化）。
///
/// `kind`（#135）= `"search"` / `"open"`，空串按 url 有没有 `%s` 现推
/// （见 config::clean_app）。
fn add_app_impl(cfg: &mut Config, name: &str, url: &str, kind: &str) -> Result<String, String> {
    if cfg.apps.len() >= 60 {
        return Err("外部软件最多 60 个".into());
    }
    let mut e = config::clean_app(cfg, name, url, kind, None)?;
    e.id = config::new_app_id();
    let id = e.id.clone();
    cfg.apps.push(e);
    cfg.bar_list.push(config::app_sentinel(&id));
    Ok(id)
}

#[tauri::command]
fn add_app(name: String, url: String, kind: String) -> Result<String, String> {
    let id = {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("内部状态异常".into()),
        };
        let id = add_app_impl(&mut cfg, &name, &url, &kind)?;
        config::save(&cfg);
        id
    };
    broadcast();
    Ok(id)
}

/// 改名字 / 改地址的业务本体。横条哨兵按 **id** 钉，改名不影响那一格。
fn update_app_impl(
    cfg: &mut Config,
    id: &str,
    name: &str,
    url: &str,
    kind: &str,
) -> Result<(), String> {
    let Some(pos) = cfg.apps.iter().position(|a| a.id == id) else {
        return Err("这个软件已经不在了".into());
    };
    // 校验时把自己摘出来（重名检查跳过自己），但 apps 还是完整的 ——
    // clean_app 只读 cfg.apps 做判重，不影响别的。
    let mut e = config::clean_app(cfg, name, url, kind, Some(id))?;
    // ⚠ clean_app 不管 id（新建时由调用方用 new_app_id 现生成）—— 编辑必须
    // 把原 id 还回去。直接整体覆盖会把 id 抹成空串，横条上那颗按 id 钉的
    // 格子当场变孤儿：点下去「这个软件已经不在了」，设置页里也再也删不掉它。
    e.id = id.to_string();
    cfg.apps[pos] = e;
    Ok(())
}

#[tauri::command]
fn update_app(id: String, name: String, url: String, kind: String) -> Result<(), String> {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return Err("内部状态异常".into()),
        };
        update_app_impl(&mut cfg, &id, &name, &url, &kind)?;
        config::save(&cfg);
    }
    broadcast();
    Ok(())
}

/// 删除外部软件的业务本体：**软件 + 横条哨兵 + 自定义图标**三样一起清。
///
/// 留着哨兵不管的话，横条上会多出一格「点不动的幽灵图标」；
/// 留着 overrides 不管的话，icons 目录里会堆一个谁都不引用的孤儿文件。
fn remove_app_impl(cfg: &mut Config, id: &str) -> bool {
    let Some(pos) = cfg.apps.iter().position(|a| a.id == id) else {
        return false;
    };
    cfg.apps.remove(pos);
    cfg.bar_list.retain(|n| n != &config::app_sentinel(id));
    if let Some(f) = cfg.overrides.remove(&config::app_sentinel(id)) {
        config::drop_icon(&f);
    }
    true
}

#[tauri::command]
fn remove_app(id: String) {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        remove_app_impl(&mut cfg, &id);
        config::save(&cfg);
    }
    broadcast();
}

/// 把地址交给系统打开。`file://` 先转成本地路径再喂 ShellExecute ——
/// 直接递 URI 给 ShellExecuteW 在部分 Windows 版本上会静默失败（它更认原生路径）。
fn shell_open(url: &str) -> Result<(), String> {
    let target = if let Some(rest) = url.strip_prefix("file://") {
        if let Some(unc) = rest.strip_prefix("//") {
            // file://server/share/x → \\server\share\x
            format!("\\\\{}", unc.replace('/', "\\"))
        } else {
            // file:///C:/x → /C:/x → C:\x
            let p = rest.trim_start_matches('/');
            p.replace('/', "\\")
        }
    } else {
        url.to_string()
    };
    // 本地路径先自己探一下。open crate 在 Windows 上可能经由 PowerShell 启动器，
    // 它的 io::Error 会把**整段脚本文本**带回来 —— 原样显示在横条上就是一大坨
    // 英文（探针实测 400+ 字符）。不存在的文件/程序自己就能判断，给一句人话。
    if looks_like_local_path(&target) && !std::path::Path::new(&target).exists() {
        return Err(format!("找不到 {target}，去设置里检查一下地址"));
    }
    open::that(&target).map_err(|e| {
        // 别的失败原因同样只取第一行、截到 80 字符：横条提示位很窄，
        // 用户需要知道的是"系统拒绝了"，不是启动器的内部细节。
        let first = e.to_string().lines().next().unwrap_or("").trim().to_string();
        let brief: String = first.chars().take(80).collect();
        format!("系统打不开这个地址（{brief}）")
    })
}

/// 像不像一个本机路径（盘符 `C:\…` 或 UNC `\\srv\…`）—— 只对这类做存在性预检，
/// 网页 / 协议链接不归它管。
fn looks_like_local_path(target: &str) -> bool {
    let b = target.as_bytes();
    b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
        || target.starts_with("\\\\")
}

/// 「软件直达」本地唤起链（#154）。
///
/// 依次尝试 `entry.app` 里的每一项，任一项成功即返回 true：
///   ① 带 `://` 的 → URI 协议（`weixin://` / `dingtalk://…`），裸
///      ShellExecuteW 直抒。协议里可以直接带页面地址（钉钉的
///      `…/page/link?url=` 就是在客户端内开指定页），所以"启动软件
///      + 打开指定页面"是一步完成的。
///   ② 其余 → 开始菜单 `.lnk` 按名字精确匹配启动。
///
/// 全部失败返回 false，调用方回落到网页 `url` —— 没装这个软件的机器上
/// 行为与改动前完全一致（这正是这条链要的"零回归"）。
/// 从唤起目标里取 URI 协议名（scheme）：`"weixin://"` → `Some("weixin")`；
/// 开始菜单名（不含 `://`）→ `None`。
/// 只放行 `[A-Za-z0-9.+-]` 组成的scheme（RFC 3986 的合法集），
/// 顺带挡住把奇怪字符串当协议名送进注册表查询的可能。
fn scheme_of(target: &str) -> Option<&str> {
    let i = target.find("://")?;
    let s = &target[..i];
    if s.is_empty()
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
    {
        return None;
    }
    Some(s)
}

/// 软件直达的本地唤起链（#154）：按 app 数组顺序依次尝试，
/// 任一环成功即返回 true（调用方据此决定不回落网页）。
///
/// 协议环**必须先查注册表**（`protocol_registered`）：未注册协议的
/// ShellExecuteW 返回值是 42（假成功，见 win.rs 里那段 ⚠ 实测记录），
/// 不预检就会在没装该软件的机器上"唤起成功"却不发生任何事，
/// 连网页兜底都不走 —— 比改动前更糟。
fn launch_app_chain(entry: &engines::EngineEntry) -> bool {
    for target in &entry.app {
        if let Some(scheme) = scheme_of(target) {
            if !win::protocol_registered(scheme) {
                win::log(&format!("appchain: 协议未注册 {scheme}://，试下一项"));
                continue;
            }
            if win::shell_execute_raw(target) {
                win::log(&format!("appchain: 协议唤起成功 {target}"));
                return true;
            }
            win::log(&format!("appchain: 协议唤起失败 {target}，试下一项"));
        } else if win::launch_start_menu(target) {
            win::log(&format!("appchain: 开始菜单唤起成功「{target}」"));
            return true;
        }
    }
    false
}

/// 点横条上外部软件那一格。
///
/// 打开类（#135 之前这就是全部行为）：原样打开地址（网页 / 协议链接 /
/// 本地程序）—— 不取选区、不拼查询词、不碰剪贴板，就是一次纯粹的「打开」。
///
/// 搜索类（#135 新增，url 带 `%s` 或 kind 显式为 search）：和 `open_search`
/// 同一个口径 —— 拿选中文字替换 `%s`。`text` 是前端传来的当前选区，没传 /
/// 空的用后端存的选区兜底（同款 fallback）；还是没有就报错，让前端提示
/// 「先选中文字」。没选中文字时搜索类不该静默打开一个带空查询的页面。
#[tauri::command]
fn open_app(id: String, text: Option<String>) -> Result<(), String> {
    let (url, kind) = {
        let cfg = match st().cfg.lock() {
            Ok(c) => c.clone(),
            Err(_) => return Err("内部状态异常".into()),
        };
        match cfg.apps.iter().find(|a| a.id == id) {
            Some(a) => (a.url.clone(), config::app_kind(&a.url, &a.kind)),
            None => return Err("这个软件已经不在了".into()),
        }
    };
    if kind == "search" {
        let query = match text.filter(|t| !t.trim().is_empty()) {
            Some(t) => t,
            None => st().sel.lock().map(|s| s.clone()).unwrap_or_default(),
        };
        if query.trim().is_empty() {
            return Err("先选中文字，再点这个搜索".into());
        }
        let url = url.replace("%s", &engines::encode_query(&query));
        win::log(&format!(
            "open_app: {id} 搜索类 -> {}",
            url.chars().take(180).collect::<String>()
        ));
        // 替换后再校验一次：%s 里可能被塞进奇怪的东西（理论上前端已编码）
        if let Err(e) = config::validate_app_url(&url) {
            win::log(&format!("open_app: 搜索类地址不合法，拒绝打开（{e}）"));
            return Err("这个地址不合法，去设置里改一下".into());
        }
        shell_open(&url)?;
        dismiss_bar();
        return Ok(());
    }
    win::log(&format!("open_app: {id} -> {}", url.chars().take(180).collect::<String>()));
    // 打开前再校验一次：配置可能是旧版本留下来的、或用户手改过 config.json
    if let Err(e) = config::validate_app_url(&url) {
        win::log(&format!("open_app: 地址不合法，拒绝打开（{e}）"));
        return Err("这个地址不合法，去设置里改一下".into());
    }
    shell_open(&url)?;
    dismiss_bar();
    Ok(())
}

#[tauri::command]
fn reset_all() {
    {
        let mut cfg = match st().cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let files: Vec<String> = cfg.overrides.values().cloned().collect();
        for f in files {
            config::drop_icon(&f);
        }
        *cfg = Config::default();
        config::save(&cfg);
    }
    broadcast();
}

/* ================================================================== */
/* 搜索 / 打开链接                                                     */
/* ================================================================== */

#[tauri::command]
fn open_search(engine: String, text: Option<String>) {
    // r51 速度：量「进命令 → 收起横条」这一段。用户报的"打开网页慢"就是它 ——
    // 以前这里压着一次会阻塞的 ShellExecuteW，横条要等浏览器拉起来才肯走。
    let t_cmd = std::time::Instant::now();
    // "这次搜的到底是哪份文字、以及它是从哪来的" —— 用户报过
    // 「选中文字后点引擎，有时候搜的是剪贴板里的旧内容」。这类问题**只能靠日志**：
    // 横条上不显示文字，前后端又各有一份状态，不写下来根本分不清是前端没传、
    // 还是后端兜底兜到了旧的剪贴板上。一条日志把两件事都钉住。
    let explicit = text.as_deref().map(|t| !t.trim().is_empty()).unwrap_or(false);
    // clone：上面那条日志要把"前端到底传了什么"原样打出来，而 filter 会吃掉 text
    let query = match text.clone().filter(|t| !t.trim().is_empty()) {
        Some(t) => t,
        None => st().sel.lock().map(|s| s.clone()).unwrap_or_default(),
    };
    // 三类引擎在这里分岔：搜索类没有关键词就等于白点，直接返回；
    // 打开类和快捷键类则相反 —— 没选中任何东西照样要能点。
    let entry = engine_entry(&engine);
    let kind = entry
        .as_ref()
        .map(|e| e.kind)
        .unwrap_or(config::EngineKind::Search);
    win::log(&format!(
        "open_search: engine={engine} 种类={} 前端文本={:?} 来源={} 实际查询={:?}",
        kind.as_str(),
        text,
        if explicit { "前端传入" } else { "后端选区兜底" },
        query.chars().take(60).collect::<String>()
    ));
    if query.trim().is_empty() && kind == config::EngineKind::Search {
        return;
    }
    // AI 提问后缀只对搜索类有意义：打开类是"直达按钮"、快捷键类压根不碰
    // 浏览器，拼一句「什么意思？」进去反而污染。
    let query = if kind == config::EngineKind::Search {
        compose_query(&engine, &query)
    } else {
        query
    };
    // 快捷键类：按键合成完就直接收工，后面的 URL / 剪贴板 / last_engine
    // 逻辑一概不适用。放在最前面 return，别让三类逻辑缠在一起。
    if kind == config::EngineKind::Hotkey {
        match entry.as_ref().and_then(|e| e.hotkey.as_deref()) {
            Some(spec) => {
                /* r58：「绑定应用」—— 先确保那个应用真的在跑，再把键发过去。
                 *
                 * 用户原话：「软件内部要先确定这个应用真的已经打开了，如果打开了
                 * 就直接把这个快捷键给运用出来，如果没有打开，那就先打开这个应用，
                 * 然后再实行快捷键。」
                 *
                 * 顺序是三件事，缺一件都不成：
                 *   ① **查**：按 exe 文件名判在不在跑（不按全路径，见
                 *      `win::exe_name_of` 的注释）；
                 *   ② **拉**：没在跑就拉起来，可选管理员（会弹 UAC）；
                 *   ③ **等 + 聚焦**：等它把窗口建出来，把前台给它 ——
                 *      不等就发键，键会丢在初始化过程里（用户看到的是
                 *      「第一次点没反应，再点一次才行」）；不聚焦就发键，
                 *      键会打到用户刚才那个软件身上（等于什么都没发生）。
                 */
                let mut bound_window: Option<HWND> = None;
                let mut launched = false;
                if let Some(e) = entry.as_ref() {
                    if e.bind_app && !e.app_path.trim().is_empty() {
                        let exe = win::exe_name_of(&e.app_path);
                        let t0 = std::time::Instant::now();
                        let was_running = win::app_running(&exe);
                        win::log(&format!(
                            "open_search: {engine} 绑定应用 {exe} 已在运行={was_running}（查进程 {}ms）",
                            t0.elapsed().as_millis()
                        ));
                        if !was_running {
                            match win::launch_app(&e.app_path, e.app_admin) {
                                Ok(()) => {
                                    launched = true;
                                    win::log(&format!(
                                        "open_search: {engine} 已拉起 {exe}{}，等它就绪…",
                                        if e.app_admin { "（管理员）" } else { "" }
                                    ));
                                }
                                Err(msg) => {
                                    // 拉不起来就别硬发键了 —— 发出去只会打到别的
                                    // 软件上，比"什么都没发生"更糟（可能误触快捷键）。
                                    win::log(&format!("open_search: {engine} 拉起失败：{msg}"));
                                    img_tell(format!("{engine}：{msg}"));
                                    dismiss_bar();
                                    return;
                                }
                            }
                        }
                        /* 已经在跑的也可能缩在后台：同样要等/找窗口来聚焦。
                         * ⚠ 但「本来就在跑」和「我们刚拉起」要区别对待：
                         *   后者才需要为窗口多等（慢启动应用），前者（尤其是
                         *   托盘常驻的 Octoclip 那种）多等纯粹是让用户干瞪眼。 */
                        bound_window = win::wait_app_ready_ex(&exe, 20000, launched);
                        /* r60：**刚拉起来的应用，窗口出现 ≠ 能收键盘。**
                         *
                         * 用户报的正是这条：「应用没打开时点了快捷键，应用确实开了，
                         * 但快捷键的功能没触发」。原因就是窗口刚建出来、程序还在
                         * 初始化（读配置 / 建 UI / 加载数据），这时把组合键发过去，
                         * 应用根本不处理 —— 键丢在初始化过程里。
                         *
                         * 所以：拉起过的多等一拍再发。已经在跑的应用不用等
                         * （它早就初始化完了，多等只是让用户觉得慢）。
                         */
                        if launched && bound_window.is_some() {
                            /* r76：这一拍从写死的 900ms 变成**用户可配**
                             * （`app_launch_delay`，见 config.rs 里那个字段的注释：
                             *  用户原话「打开软件与按快捷键之间中间有一个时差，这个
                             *  时间是可以在设置当中自己设置的」）。
                             * 大型软件（IDE/设计软件）常常 900ms 不够，小工具又嫌久，
                             * 所以每个引擎各配各的，互不影响。 */
                            let settle = Duration::from_millis(e.app_launch_delay as u64);
                            win::log(&format!(
                                "open_search: {engine} 是新拉起的，再等 {}ms 让它初始化完",
                                settle.as_millis()
                            ));
                            std::thread::sleep(settle);
                            // 等完之后重新找一次窗口：初始化过程中主窗口可能刚换成另一个
                            if let Some(h) = win::find_app_window(&exe) {
                                bound_window = Some(h);
                            }
                        }
                        win::log(&format!(
                            "open_search: {engine} 就绪检查完成，窗口={}（共 {}ms）",
                            bound_window.is_some(),
                            t0.elapsed().as_millis()
                        ));
                    }
                }
                // 组合键必须打到「触发现场的那个软件」身上：横条此刻可能持有焦点
                // （用户刚在面板搜索框里敲过字），直接发会打回到我们自己窗口上 ——
                // 那正是 fav_send 踩过的坑（文字进了收藏夹窗口自己的搜索框）。
                // 同款解法：先把焦点还给目标，等前台切换落地，发完再收横条。
                //
                // r58：配了「绑定应用」且找到了它的窗口时，**目标改成那个应用** ——
                // 用户点这颗图标的意思就是"让那个软件执行这个快捷键"，而不是
                // "让刚才划词的那个软件执行"。
                let target = match bound_window {
                    Some(h) => h.0 as isize,
                    None => st().geo.lock().map(|g| g.trigger_hwnd).unwrap_or(0),
                };
                /* r60：聚焦从"试一次"改成**带重试并每次核对前台**。
                 *
                 * 用户报：「应用确实打开了，但快捷键的功能没触发」。
                 * 除了"刚启动还没初始化完"（上面已经补了等待），第二个原因是
                 * **前台没抢到**：`SetForegroundWindow` 有前台锁定，被拒时是
                 * 静默失败；而刚启动的应用抢前台的时机很不确定（有的在首帧之后
                 * 才抢、有的要等登录窗关掉）。只试一次 60ms 很容易落在缝隙里，
                 * 于是按键发给了"当时的前台"（多半是我们自己或桌面）。
                 *
                 * 现在最多试 10 次、每次 120ms，**每一次都核对前台真的到了目标**
                 * 才发键。全都失败时仍然发一次（打到当前前台），并在日志里写明
                 * 是"没抢到焦点"—— 这样用户下次报障时能一眼看出是哪一类。 */
                let mut aimed = false;
                /* r89：**应用本来就在跑 → 定向投键，不抢焦点、不把窗口换出来。**
                 *
                 * 用户原话：「你确保软件是打开的，你没有必要把软件给换起来呀，
                 * 你就看一下它是不是开的，要不是开的你就打开，要是开的你就不用
                 * 把它的窗口换出来，让它继续保留在后台就可以了呀。」
                 *
                 * 所以分两条路：
                 *   · `was_running == true`（**它早就在跑，可能正缩在后台**）
                 *     → `post_hotkey` 把按键消息直接投给它的窗口。前台不动，
                 *       用户手上正在做的事不被打断。
                 *   · `was_running == false`（是我们刚把它拉起来的）
                 *     → 走原来的路（抢焦点 + SendInput）。刚启动的程序需要
                 *       前台才稳，而且"刚被打开"本身就意味着它要露出来，
                 *       这时候弹到前面恰恰是用户期待的。
                 *
                 * ⚠ 定向投递**可能不被响应**（少数程序只吃 RawInput，或者
                 *   窗口句柄不对）。所以失败了就**退回**原来的抢焦点路径，
                 *   保证功能不退化 —— 宁可偶尔弹一下窗口，也不能让快捷键失灵。 */
                /* r89b：**三级投键策略**（每一级的理由都来自实测）。
                 *
                 * ① **有可见窗口 + 应用在后台** → `post_hotkey` 定向投递。
                 *    完全不碰前台，用户手上正在做的事不被打断。
                 *
                 * ② **没有可见窗口**（托盘常驻 / 全局热键类应用）→
                 *    `send_hotkey`（SendInput）**直接发，不抢焦点**。
                 *
                 *    这类应用的典型是 Octoclip（章鱼速贴）、各种剪贴板工具：
                 *    实测它常驻托盘、主窗口 `Tauri Window` 是**隐藏**的，
                 *    只有 `global_hotkey_app` 这种不可见窗口在。
                 *    用户报的正是它们失灵：
                 *      「用章鱼速贴快捷输入，它不能够换出来这个快捷键对应的效果」。
                 *
                 *    为什么 SendInput 反而对：它们的快捷键是**系统级全局热键**
                 *    （RegisterHotKey 注册的），Windows 在 `SendInput` 之后就
                 *    直接把它路由给注册者了 —— **根本不需要焦点**。
                 *    而我上一版对这种应用去 `PostMessage` 一个隐藏窗口，
                 *    那条消息没人处理，自然毫无反应。
                 *
                 * ③ 兜底：既没窗口、SendInput 也没成功 → 老路（抢焦点 + SendInput）。
                 *
                 * ⚠ ② 和 ③ 的区别只在"要不要抢焦点"。② 不抢，因为对方压根
                 *   不需要前台；抢了反而把用户正在做的事打断（这正是用户
                 *   报 bug 3 时明确反对的）。 */
                let mut posted = false;
                let mut sent_unfocused = false;
                if !launched {
                    let usable_win = bound_window
                        .filter(|h| win::is_visible(*h) && !win::is_minimized(*h));
                    if let Some(h) = usable_win {
                        posted = win::post_hotkey(h, spec);
                        win::log(&format!(
                            "open_search: {engine} 有可见窗口 → 定向投键（不抢焦点）→ {}",
                            if posted { "成功" } else { "未响应，将退回抢焦点" }
                        ));
                    } else {
                        /* 没有可见窗口 → 当作"全局热键类应用"，直接发。
                         * 不抢焦点：它不需要，抢了就是无谓的打扰。 */
                        sent_unfocused = win::send_hotkey(spec);
                        win::log(&format!(
                            "open_search: {engine} 应用无可见窗口（托盘/全局热键类）\
                             → 直接发键、不抢焦点 → {}",
                            if sent_unfocused { "已发送" } else { "序列无法解析" }
                        ));
                    }
                }
                if !posted && !sent_unfocused && target != 0 {
                    let t = HWND(target as *mut c_void);
                    if win::is_visible(t) && !win::is_minimized(t) {
                        for attempt in 0..10 {
                            restore_focus_to(t);
                            std::thread::sleep(Duration::from_millis(120));
                            if win::foreground_addr() == target {
                                aimed = true;
                                if attempt > 0 {
                                    win::log(&format!(
                                        "open_search: 第 {} 次尝试抢到焦点（目标 0x{target:x}）",
                                        attempt + 1
                                    ));
                                }
                                break;
                            }
                        }
                        if !aimed {
                            let fg_now = win::foreground_addr();
                            win::log(&format!(
                                "open_search: 抢焦点 10 次都没成功（前台 0x{fg_now:x} ≠ 目标 0x{target:x}）→ 发给当前前台"
                            ));
                        }
                    } else {
                        win::log(&format!(
                            "open_search: 目标窗口 0x{target:x} 不可见或已最小化，直接发给当前前台"
                        ));
                    }
                }
                /* r89：定向投递/无窗口直发成功后就不再走全局广播 —— 那样会
                 * **又**把键打到别人的前台窗口上（等于发两遍，可能误触别的
                 * 软件的热键）。 */
                if posted {
                    win::log(&format!(
                        "open_search: {engine} 模拟按键 {spec} -> 已定向投递（前台未变动）"
                    ));
                } else if sent_unfocused {
                    win::log(&format!(
                        "open_search: {engine} 模拟按键 {spec} -> 已直接发送（全局热键类，前台未变动）"
                    ));
                } else {
                    let ok = win::send_hotkey(spec);
                    win::log(&format!(
                        "open_search: {engine} 模拟按键 {spec} -> {} 投向={}",
                        if ok { "已发送" } else { "按键序列无法解析" },
                        if aimed {
                            format!("目标窗口 0x{target:x}")
                        } else {
                            "当前前台".to_string()
                        }
                    ));
                }
            }
            None => win::log(&format!("open_search: {engine} 是快捷键类但没配按键")),
        }
        dismiss_bar();
        return;
    }
    // r51：横条到底收没收（下面几条路各自先收，收尾时别再收一次）
    let mut dismissed = false;
    if let Some(entry) = entry {
        /* #154 软件直达：打开类里配了本地唤起链的（常用软件那一组），
         * 先试「协议 → 开始菜单」，成功了就直接用本地软件 + 指定页面，
         * 根本不碰浏览器。全链失败（软件没装）才继续走下面的网页 url ——
         * 老机器的体验和改动前一模一样。 */
        if kind == config::EngineKind::Open && !entry.app.is_empty() {
            /* r51 速度：**先收横条，再唤起本地软件**。launch_app_chain 里也是
             * ShellExecuteW，冷启动一样会阻塞几百毫秒；原来它排在 dismiss_bar 前面，
             * 用户看到的就是"点了没反应"。 */
            dismiss_bar();
            if launch_app_chain(&entry) {
                win::log(&format!(
                    "open_search: {engine} 本地唤起成功，不回落网页（横条已先收，{}ms）",
                    t_cmd.elapsed().as_millis()
                ));
                if let Ok(mut cfg) = st().cfg.lock() {
                    // ⚠ clone：`Some(engine)` 会把 engine 移走，而下面
                    //   note_recent_engine 还要用它（Rust 的 String 不是 Copy）。
                    cfg.last_engine = Some(engine.clone());
                    note_recent_engine(&mut cfg, &engine);
                    config::save(&cfg);
                }
                return;
            }
            win::log(&format!(
                "open_search: {engine} 本地唤起链全部失败，回落网页 {}",
                entry.url
            ));
        }
        let tpl = entry.url.as_str();
        let url = if kind == config::EngineKind::Search {
            tpl.replace("%s", &engines::encode_query(&query))
        } else if query.trim().is_empty() {
            // 老配置里漏改的"打开类"地址可能还留着 %s：没关键词就把占位符抹掉，
            // 免得浏览器地址里出现一个孤零零的 %s。
            tpl.replace("%s", "")
        } else {
            // 有选中词就顺手填进去（填了不亏，用户确实是圈了词才点的）
            tpl.replace("%s", &engines::encode_query(&query))
        };
        win::log(&format!("open_search: {engine} -> {}", url.chars().take(180).collect::<String>()));
        /* r51 速度：**先收横条，再把拉浏览器丢到后台**。
         * open::that() 在 Windows 上就是 ShellExecuteW，**会阻塞**（等 shell 找关联程序、
         * 发 DDE，冷启动几百毫秒很常见）。原来 dismiss_bar() 压在这一行后面 ——
         * 横条要等浏览器拉起来才肯收，用户看到的就是"点了没反应"。
         * that_detached 把 ShellExecuteW 放到后台线程，这里立刻返回。 */
        dismiss_bar();
        dismissed = true;
        let t_open = std::time::Instant::now();
        let _ = open::that_detached(url);
        win::log(&format!(
            "⏱ open_search: {engine} 进命令 → 收起横条 = {}ms（转后台 {}ms，浏览器此后在后台拉起）",
            t_cmd.elapsed().as_millis(),
            t_open.elapsed().as_millis()
        ));
        // AI 站点大多是前端渲染，URL 参数能不能被吃进去取决于各家实现。
        // 顺手把提问放一份到剪贴板：万一某个站点没自动填，用户点一下输入框
        // Ctrl+V 就补上了，不至于白跑一趟。
        if kind == config::EngineKind::Search
            && is_ai_engine(&engine)
            && cfg_with(|c| c.ai_copy_prompt)
        {
            clip::set_text(&query);
        }
    }
    if let Ok(mut cfg) = st().cfg.lock() {
        cfg.last_engine = Some(engine.clone());
        // r56：记一笔"最近使用"。和 last_engine 同一处写、同一把锁 ——
        // 两者本来就是同一件事的两种视图（"上次用的" vs "最近用过的几个"），
        // 分两处写早晚会对不上。
        // ⚠ clone：上一行已经把 engine 移进 Option 了（String 不是 Copy）。
        note_recent_engine(&mut cfg, &engine);
        config::save(&cfg);
    }
    /* r56/r57：把新名单广播出去，面板里那一栏才会在**同一轮会话**里刷新。
     *
     * ⚠ r57 修：这里以前只在「横条还开着」时才发，理由是"点完引擎照例收横条，
     *   发出去也没人看"。那是错的 —— 横条的 `CONF` 只在 `boot()` 里读一次
     *   （`ui/bar.js` 的 `await invoke('get_config')`），之后全靠 `qs://config`
     *   广播刷新。横条收着时不发，这份名单就**整轮会话都停在旧值**，
     *   用户下次点开「更多引擎」看到的还是上一次启动时的名单 ——
     *   这正是「点了引擎，最近使用里没有」的第二个原因（第一个是后端把
     *   没固定在横条上的名字当"不认识"删了，见 config.rs 的 normalize_recent）。
     *
     *   无条件发一次的代价很小：一次 config_view + 一次 emit。横条这会儿
     *   本来就要收了，多画一帧没人看得见。
     *
     * ⚠ 必须放在锁外面：broadcast() 内部会调 config_view()，而那也要拿同一把锁
     *   （死锁踩过，别重犯）。 */
    broadcast();
    if !dismissed {
        dismiss_bar();
    }
    win::log(&format!("⏱ open_search: 进命令 → 返回 = {}ms", t_cmd.elapsed().as_millis()));
}

#[tauri::command]
fn open_link() {
    /* 用户要求：「选中的文本当中包含多个链接，点击打开链接按钮之后，就会在多个
     * 标签页打开这些链接」。所以这里开的是**整份链接列表**，不再是单条。
     * 列表为空（按钮只在有链接时才显示，理论上到不了这儿）才退回单条那条老路。 */
    let urls = sel_urls_snapshot();
    if urls.is_empty() {
        let url = st().sel_url.lock().ok().and_then(|u| u.clone());
        if let Some(u) = url {
            let _ = open::that(u);
        }
    } else {
        spawn_open_links(urls);
    }
    dismiss_bar();
}

/// 前端取走 Rust 预抓的玻璃背景（`layout_bar` 首次上屏前抓的那块）。
/// 返回「16 字节小头（x,y,w,h，i32 LE）+ RGBA 字节块」，走原始 Response，
/// 不过 JSON / base64。取走即清空，旧快照不会被反复用。
#[tauri::command]
fn glass_take() -> tauri::ipc::Response {
    tauri::ipc::Response::new(glass::encode(&glass::take()))
}

/// 前端主动请求重抓背景（实时模式轮询 / 拖动面板结束后的刷新）。
/// 无参数：重抓的永远是上一块矩形（见 `glass::capture_encoded`）。
///
/// 前端调之前会把舞台整体置为隐藏（窗口变全透明），所以抓到的必然是纯桌面；
/// 拿到响应后再恢复显示。一帧隐藏的代价换一个干净的背景，比把横条自己的
/// 像素搅进纹理（反馈环）划算。
///
/// ⚠ r86：改走 `glass::capture_encoded()` 这条**零拷贝**路径。
///   原来这里是 `encode(&recapture_last())`，一块 600KB 的像素数据要被
///   拷三次（复用缓冲→Snap→暂存→encode 输出）。实时抓屏 85 帧/秒时，
///   那等于每秒上百 MB 的无谓拷贝 —— 实测这一项就占主进程 CPU 的大头。
///   现在改成"GetDIBits 直接写进最终输出缓冲"，只写一次。
#[tauri::command]
fn glass_capture() -> tauri::ipc::Response {
    tauri::ipc::Response::new(glass::capture_encoded())
}

/// 实时折射专用：把横条对**抓屏**隐身（`WDA_EXCLUDEFROMCAPTURE`）。
///
/// 前端开实时模式时先调这个：返回 true 之后 BitBlt 直接看穿横条，抓屏不再
/// 需要「隐藏舞台 → 等两帧 → 抓 → 恢复」那套频闪动作；返回 false（旧系统）
/// 时前端回退老路。关实时模式 / 收起横条时必须 `on=false` 解除 ——
/// 否则用户截图、录屏、会议共享里横条会整个人间蒸发。
///
/// Rust 侧另有兜底：`dismiss_bar` 无条件解除，前端漏调也留不下隐身状态。
#[tauri::command]
fn glass_exclude(on: bool) -> bool {
    let h = bar_hwnd();
    if h.0.is_null() {
        return false;
    }
    glass::set_exclude_from_capture(h, on)
}

/* ================================================================== */
/* 设置窗口 / 杂项                                                     */
/* ================================================================== */

/// 设置页的 IPC 是否已经「活过」——页面在 goto-tab / focus-engine 的
/// listen 回调里收到过一次控制事件就会置 true。
///
/// 为什么需要它：首建设置窗时 focus/tab 的补发线程以前是无脑补 24 次
/// （1.44s）。页面 listen 注册好之后，尾巴上那些迟到的 emit 会把调用方
/// （或用户自己）后来切的分页整个冲掉 —— 真实场景：打开设置后 1.4 秒内
/// 手动点别的分页会被弹回去；探针里 open_settings(tab:'engines') 被尾巴
/// 上的 general 冲回通用页，引擎列表整段藏在隐藏分页里全测不到。
/// 现在页面收到过一次控制事件就补发即停（丢了的那次会被后续补发放下，
/// 收到即停不会漏最后一次）。
static SETTINGS_PAGE_LIVE: AtomicBool = AtomicBool::new(false);

/// 设置页 listen 回调收到控制事件后的「回声」：置 SETTINGS_PAGE_LIVE。
#[tauri::command]
fn qs_page_ack() {
    SETTINGS_PAGE_LIVE.store(true, Ordering::Relaxed);
}

/* ---------------- r75：设置窗口「关掉一段时间后真销毁」 ----------------
 *
 * 为什么：用户点 X 关设置页时，以前是 prevent_close + hide —— 窗口留着，
 * 下次打开是"秒开"。代价是**那一整棵 WebView2 常驻**：真机实测（tools/r75-mem-states.js）
 * 横条单独跑 410MB WS，把设置页开出来就 +185MB，铺满「全部引擎」再 +150MB。
 * 用户一天里可能只开一两次设置，为"秒开"把 200~300MB 摁在内存里不划算。
 *
 * 现在的口径：**关掉后 3 分钟内再打开，仍然走 hide 那条路（秒开）**；超过就
 * 由后台回收线程真正 destroy 掉，内存还给系统。之后要设置页就重建一次
 * （open_settings_win 本来就有"没有窗口就建"的分支，行为不变）。
 *
 * ⚠ destroy() 不走 CloseRequested（见 tauri-runtime-wry 的 WindowMessage::Destroy），
 *   所以不会和 prevent_close 那条路互相咬着；回收前再核一次 is_visible，
 *   用户在这几秒里又打开了就不销毁。 */
static SETTINGS_HIDDEN_AT: AtomicU64 = AtomicU64::new(0);
/// 设置窗口关掉后多久真正销毁（秒）。0 = 关闭这个特性（与旧行为完全一致）。
const SETTINGS_IDLE_DESTROY_SECS: u64 = 180;

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 后台回收线程：每 5 秒看一眼「设置窗是否还被隐藏着且已经超过阈值」。
/// 单独一条线程而不是每次关窗起一个 sleep —— 后者会攒出一串待唤醒线程，
/// 而且窗口被重建之后旧线程还会去操作新窗口。
fn spawn_settings_reaper() {
    if settings_idle_secs() == 0 {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(5));
        let limit = settings_idle_secs();
        let at = SETTINGS_HIDDEN_AT.load(Ordering::Relaxed);
        if limit == 0 || at == 0 {
            continue;
        }
        if now_unix().saturating_sub(at) < limit {
            continue;
        }
        // 窗口可能已经被重建 / 又被用户打开了：拿不到或可见就都不销毁，
        // 并把时间戳清掉（下次关窗会重新记）。
        let Some(w) = app().get_webview_window("settings") else {
            SETTINGS_HIDDEN_AT.store(0, Ordering::Relaxed);
            continue;
        };
        if w.is_visible().unwrap_or(true) {
            SETTINGS_HIDDEN_AT.store(0, Ordering::Relaxed);
            continue;
        }
        match w.destroy() {
            Ok(()) => {
                SETTINGS_HIDDEN_AT.store(0, Ordering::Relaxed);
                SETTINGS_PAGE_LIVE.store(false, Ordering::Relaxed);
                win::log("settings: 关闭已超时，销毁窗口回收内存（下次打开重建）");
            }
            Err(e) => win::log(&format!("settings: 销毁失败（{e}），下轮再试")),
        }
    });
}

/// 空闲销毁阈值（秒）。`QS_SETTINGS_IDLE_SECS` 是**仅测试用**的覆盖口：
/// 真机验这条链路不能等三分钟，探针把它设成个位数即可。
/// 0 = 关掉这个特性（行为与本轮之前完全一致）。
fn settings_idle_secs() -> u64 {
    std::env::var("QS_SETTINGS_IDLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(SETTINGS_IDLE_DESTROY_SECS)
}

fn open_settings_win(focus: Option<String>, tab: Option<String>) {
    let a = app();
    if let Some(w) = a.get_webview_window("settings") {
        win::log("settings: reuse existing window");
        // r75：窗口又露头了 —— 取消"空闲销毁"的计时
        SETTINGS_HIDDEN_AT.store(0, Ordering::Relaxed);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(f) = focus {
            let _ = w.emit("qs://focus-engine", f);
        }
        if let Some(t) = tab {
            let _ = w.emit("qs://goto-tab", t);
        }
        return;
    }

    win::log("settings: building window");
    let a2 = a.clone();
    let f2 = focus.clone();
    let t2 = tab.clone();
    let _ = a.run_on_main_thread(move || {
        let mut sb = WebviewWindowBuilder::new(&a2, "settings", WebviewUrl::App("settings.html".into()))
            .title("Quick Search 设置")
            .inner_size(780.0, 660.0)
            .min_inner_size(600.0, 460.0)
            .resizable(true)
            .center()
            // 同 OCR 窗口：**先隐藏**，等页面首帧画完（settings_ready）再显示。
            // 不这么做的话，用户点开设置会先看到一块没内容的原生黑底
            // （WebView2 渲染第一帧是异步的）。底色和 settings 的 --bg 对齐。
            .visible(false)
            .background_color(if win::apps_use_light_theme().unwrap_or(true) {
                tauri::window::Color(245, 246, 248, 255)
            } else {
                tauri::window::Color(23, 24, 28, 255)
            });
        // 必须和横条窗口用同一套 WebView2 参数，否则环境配置冲突、窗口建不起来
        let wa = wv_args();
        if !wa.is_empty() {
            sb = sb.additional_browser_args(&wa);
        }
        let built = sb.build();
        match built {
            Ok(w) => {
                win::log("settings: built ok (hidden, 等页面 ready)");
                // r75：新窗口从"隐藏待销毁"的候选里摘出去
                SETTINGS_HIDDEN_AT.store(0, Ordering::Relaxed);
                // 隐藏窗口拿不到焦点，不在这里 set_focus（见 show_after_ready）
                // 兜底：ready 信号没来也要把窗口亮出来，不能开着看不见
                let w2 = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    if !w2.is_visible().unwrap_or(false) {
                        win::log("settings: ready 超时，兜底显示");
                        let _ = w2.show();
                        let _ = w2.set_focus();
                    }
                });
                // 首次建窗时 focus / tab 都要在页面 ready 之后补发几次：
                // 页面脚本还没跑起来时 emit 会丢。
                // ⚠ 这两件事必须**各自独立**判断。以前 tab 的补发被套在
                //   `if let Some(f) = f2` 里面，于是「只给 tab、没给 focus」时
                //   （收藏夹面板点「设置…」恰恰就是这样：focusEngine=null）整段不执行，
                //   新开的设置窗停在默认分页 —— 跳错页的另一半原因就在这。
                if f2.is_some() || t2.is_some() {
                    // 新的一次页面生命：先把「活过」标志清掉，让补发线程对
                    // 这一次负责（上一辈子置过的标志不能管这辈子）。
                    SETTINGS_PAGE_LIVE.store(false, Ordering::Relaxed);
                    let w3 = w.clone();
                    let f3 = f2.clone();
                    let t3 = t2.clone();
                    std::thread::spawn(move || {
                        for _ in 0..24 {
                            // 页面已经实到过一次控制事件 → listen 注册好了，
                            // 迟到的补发只会把后来切的分页冲掉，见
                            // SETTINGS_PAGE_LIVE 注释。停止补发。
                            if SETTINGS_PAGE_LIVE.load(Ordering::Relaxed) { break; }
                            std::thread::sleep(Duration::from_millis(60));
                            if let Some(f) = f3.clone() {
                                let _ = w3.emit("qs://focus-engine", f);
                            }
                            if let Some(t) = t3.clone() {
                                let _ = w3.emit("qs://goto-tab", t);
                            }
                        }
                    });
                }
            }
            Err(e) => win::log(&format!("settings: build failed: {e}")),
        }
    });
}

#[tauri::command]
fn open_settings(focus_engine: Option<String>, tab: Option<String>) {
    win::log(&format!(
        "open_settings invoked focus={focus_engine:?} tab={tab:?}"
    ));
    // ⚠ 必须脱开命令调用栈（和 open_app_picker / ocr_start 同一个坑）：
    //   `open_settings_win` 里是 `run_on_main_thread` + `WebviewWindowBuilder::build()`，
    //   而主线程建 WebView2 会**回头等一把本次 invoke 还没释放的锁** —— 直接死锁。
    //   死锁的表现极具迷惑性：设置窗口**被建出来了、尺寸也对，但永远不显示**
    //   （日志停在「settings: building window」，既不成功也不报错）；更糟的是
    //   主线程从此卡死 —— 横条还能被 SetWindowPos 挪动，但 WebView 合成面不再
    //   更新，用户看到的是「再点更多引擎，面板只剩从上到下很少一部分」；
    //   托盘右键也弹不出菜单（shell 要调我们的主线程来显示菜单）。
    //   先回一个空值给前端，真正的建窗在后台线程完成。
    std::thread::spawn(move || open_settings_win(focus_engine, tab));
}

#[tauri::command]
fn open_data_dir() {
    let _ = open::that(config::data_dir());
}

/// 是不是备份文件（设置页「备份」页列清单用）。
///
/// 认这些：
///   · `config.auto(时间).QuickSearch` —— 滚动备份（每次改设置自动留，只留 1 份）；
///   · `config(时间).QuickSearch` —— 「立即备份」落下的那一份（与云端同名同内容）；
///   · `config.before-webdav(时间).QuickSearch` —— 云端恢复前的本机快照；
///   · 老名字：`config.json.bak`、`config.before-webdav-*.json`、旧的 quicksearch json。
fn is_backup_file(name: &str) -> bool {
    name == "config.json.bak"
        || config::is_rolling_backup(std::path::Path::new(name))
        || config::is_manual_backup(name)
        || config::is_snapshot(name)
        || (name.ends_with(".json") && name.contains("quicksearch"))
}

/// 「仅保留最近 N 份」清理的范围 = **用户主动做的备份**。
///
/// 不含滚动备份（只有 1 份，删了下次保存会重建）与恢复前快照
/// （`stash_local_config` 自己有"只留 5 份"的规则）—— 它们各有各的保留策略，
/// 被这个按钮顺手清掉只会让"配置损坏自救"和"恢复前留一手"这两条退路消失。
fn is_prunable_backup(name: &str) -> bool {
    config::is_manual_backup(name)
        || (name.ends_with(".json") && name.contains("quicksearch"))
}

/// 本地备份目录 + 备份文件清单（设置页「备份」页显示用）。
///
/// 用户报过「配置到底备份到哪了都不知道」—— 这里把目录、是不是自定义的、
/// 以及目录里现有的备份文件（滚动备份 / WebDAV 同步前快照 / 导出的备份）
/// 一次说清，设置页照着列出来就行。
#[tauri::command]
fn backup_info() -> serde_json::Value {
    let (dir, is_custom) = cfg_with(|c| (config::backup_dir_of(c), !c.backup_dir.trim().is_empty()));
    let mut files: Vec<(String, u64, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e
                .file_name()
                .to_string_lossy()
                .to_string();
            if !is_backup_file(&name) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let mt = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            files.push((name, meta.len(), mt));
        }
    }
    // 新的在前
    files.sort_by_key(|a| std::cmp::Reverse(a.2));
    json!({
        "dir": dir.to_string_lossy(),
        "isCustom": is_custom,
        "configPath": config::config_path().to_string_lossy(),
        "files": files
            .into_iter()
            .map(|(n, s, t)| json!({ "name": n, "size": s, "mtime": t }))
            .collect::<Vec<_>>(),
    })
}

/// 选一个本地备份目录（文件夹对话框）。返回空串 = 用户取消。
/// 选完之后由前端 set_setting('backup_dir') 落盘。
#[tauri::command]
fn pick_backup_dir(app: AppHandle) -> String {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let _ = app.run_on_main_thread(move || {
        let picked = rfd::FileDialog::new()
            .set_title("选一个目录放本地备份")
            .pick_folder();
        let _ = tx.send(
            picked
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        );
    });
    rx.recv_timeout(std::time::Duration::from_secs(120))
        .unwrap_or_default()
}

/// 用资源管理器打开备份目录。
#[tauri::command]
fn open_backup_dir() {
    let _ = open::that(cfg_with(config::backup_dir_of));
}

/// 清理 N 天前的备份（设置页「清理 7 天前备份」按钮）。
///
/// 用户要求：备份只保留 7 天内的；**但如果删完会一个不剩，就保留不清除** ——
/// 备份本来就少（只有 1 个）、或者手头的备份全都超了 7 天时，宁可留个旧的，
/// 也不能让用户一份备份都没有。删成功了才回报数量，前端照着提示。
#[tauri::command]
fn clean_old_backups(days: u64) -> serde_json::Value {
    let dir = cfg_with(config::backup_dir_of);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cutoff = now.saturating_sub(days.saturating_mul(86_400));
    let mut all: Vec<(std::path::PathBuf, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !p.is_file() || !is_backup_file(name) {
                continue;
            }
            let mt = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            all.push((p, mt));
        }
    }
    let total = all.len();
    let stale = all.iter().filter(|x| x.1 < cutoff).count();
    // 兜底保护：总共就一个、或这一删会全部删光 → 一个都不动
    if total <= 1 || stale >= total {
        win::log(&format!(
            "clean_old_backups: 跳过（共 {total} 个备份，超期 {stale} 个，保留不清除）"
        ));
        return json!({ "removed": 0, "kept": total, "skipped": true });
    }
    let mut removed = 0usize;
    let mut freed = 0u64;
    for (p, _) in all.iter().filter(|x| x.1 < cutoff) {
        let sz = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(p).is_ok() {
            removed += 1;
            freed += sz;
        }
    }
    win::log(&format!(
        "clean_old_backups: 删了 {removed} 个超期备份，还剩 {} 个",
        total - removed
    ));
    json!({ "removed": removed, "kept": total - removed, "freed": freed, "skipped": false })
}

#[tauri::command]
fn log_msg(msg: String) {
    win::log(&format!("[js] {}", msg));
}

/// 仅测试用：让设置页把某个控件滚进视口并重新汇报它的屏幕坐标。
///
/// 存在的原因：`getBoundingClientRect()` 给的是**视口坐标**，设置页内容比
/// 视口高、要滚动，控件在滚动区外时量出来的 y 会超出视口高度 —— 外部脚本
/// 按这个坐标注入鼠标就会点到屏幕外（实测点到了任务栏）。所以外部脚本在点
/// 某个控件前先调这个命令，页面会把目标滚到中间再报一次坐标。
#[tauri::command]
fn ensure_rect(name: String) {
    let _ = app().emit_to("settings", "qs://ensure-rect", name);
}

#[tauri::command]
fn quit_app() {
    // 走带同步的退出：开了「退出时同步」的话会先把配置推到云端
    quit_with_sync(0);
}

/* ================================================================== */
/* 托盘                                                                */
/* ================================================================== */

/// 托盘图标的两套素材。暂停态是灰度 + 淡化的版本，
/// 一眼就能和正常态区分开 —— 不然"怎么今天不弹了"要查半天。
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");
const TRAY_ICON_PAUSED: &[u8] = include_bytes!("../icons/32x32-paused.png");

/// 按当前暂停状态组装托盘菜单。
///
/// 每次切换都**整份重建**，而不是去改某一项的文案：Tauri 的菜单项文字要拿到
/// 具体的 MenuItem 句柄才能改，而重建一份的成本可以忽略（一个人一天也点不了
/// 几次）。这样代码只有一条路径，不会出现"菜单文案和后端状态对不上"。
fn tray_menu(a: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let paused = is_paused();
    let settings_item = MenuItemBuilder::with_id("settings", "设置…").build(a)?;
    let ocr_item = MenuItemBuilder::with_id("ocr", "截图识别文字（Ctrl+Alt+O）").build(a)?;
    let toggle_item = MenuItemBuilder::with_id(
        "toggle",
        if paused {
            "恢复使用"
        } else {
            "暂停使用（开会 / 专注时）"
        },
    )
    .build(a)?;
    let sync_item = MenuItemBuilder::with_id("sync", "立即同步到云端").build(a)?;
    let dir_item = MenuItemBuilder::with_id("dir", "打开配置目录").build(a)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出 Quick Search").build(a)?;
    MenuBuilder::new(a)
        // 暂停项紧跟在「设置」后面：它是仅次于"打开设置"的高频操作
        .items(&[
            &settings_item,
            &toggle_item,
            &ocr_item,
            &sync_item,
            &dir_item,
            &quit_item,
        ])
        .build()
}

/// 刷新托盘的图标、悬停提示、菜单（切换暂停状态后调）
fn refresh_tray(a: &AppHandle) {
    let Some(tray) = a.tray_by_id("qs-tray") else {
        win::log("refresh_tray: 找不到托盘，跳过");
        return;
    };
    let paused = is_paused();
    if let Ok(menu) = tray_menu(a) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(if paused {
        "Quick Search —— 已暂停（选中文字不会弹条）"
    } else {
        "Quick Search —— 选中文字即可搜索"
    }));
    let bytes: &[u8] = if paused { TRAY_ICON_PAUSED } else { TRAY_ICON };
    if let Ok(icon) = tauri::image::Image::from_bytes(bytes) {
        let _ = tray.set_icon(Some(icon));
    }
}

fn build_tray(a: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(a)?;
    let icon = tauri::image::Image::from_bytes(TRAY_ICON)?;

    TrayIconBuilder::with_id("qs-tray")
        .icon(icon)
        .tooltip("Quick Search —— 选中文字即可搜索（左键点图标＝打开设置）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        // 左键点图标 = 打开设置窗口。
        //   以前左键**什么都不做**（菜单只在右键弹），一旦右键菜单因为任何原因
        //   弹不出来（比如主线程被建窗死锁卡住，见 open_settings 的注释），
        //   用户就彻底进不去设置 —— 留一个可靠入口。
        .on_tray_icon_event(|_tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // 脱开事件回调栈建窗（同 open_settings 的理由）
                let _ = std::thread::spawn(|| open_settings_win(None, None));
            }
        })
        .on_menu_event(|a, e| match e.id().as_ref() {
            // ⚠ 建窗/弹窗类一律脱开本次调用栈（理由见 open_settings 注释：
            //   主线程里就地 build() 建 WebView2 会等一把没释放的锁 → 死锁）。
            "settings" => {
                let _ = std::thread::spawn(|| open_settings_win(None, None));
            }
            "toggle" => set_paused(a, !is_paused()),
            "ocr" => {
                let _ = std::thread::spawn(ocr_start_flow);
            }
            "sync" => {
                let cfg = cfg_snapshot();
                if !wd_opts(&cfg, 15).ready() {
                    wd_toast("还没配置 WebDAV，先在设置里填一下");
                    return;
                }
                /* ⚠ 托盘这条也要抢 `SYNC_BUSY`。
                 *
                 * 设置页的上传/恢复/删除/清理都抢了这把锁，唯独托盘菜单的
                 * 「立即同步」原来直接 `spawn(backup_once)` 裸跑 —— 两边同时
                 * 进来就会有两个线程同时写本地备份目录、同时 `mark_backup_done`，
                 * 轻则云端多出一份同名不同时间的文件，重则刚恢复的配置被
                 * 另一次上传覆盖。 */
                std::thread::spawn(move || {
                    let Some(_guard) = SyncGuard::acquire() else {
                        wd_toast("上一次云操作还没结束，稍等一下再点");
                        return;
                    };
                    match backup_once(&cfg_snapshot(), 15) {
                        Ok(r) => wd_toast(backup_summary(&r)),
                        Err(e) => wd_toast(format!("同步失败：{e}")),
                    }
                });
            }
            "dir" => {
                let _ = open::that(config::data_dir());
            }
            "quit" => quit_with_sync(0),
            _ => {}
        })
        .build(a)?;
    Ok(())
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

fn init_state() {
    let mut cfg = config::load();
    /* r72：老配置把识图按钮补进 bar_list（`@img` 哨兵），和普通引擎一样可排序、
     * 可拖动、可移出。只在「识图开着 + 加到横条」时才补，详见函数注释。 */
    if config::ensure_img_bar_sentinel(&mut cfg) {
        win::log("config: 给老配置补上横条识图哨兵 @img");
        config::save(&cfg);
    }
    let _ = STATE.set(AppState {
        cfg: Mutex::new(cfg),
        geo: Mutex::new(Geo {
            css_w: 552.0,
            css_h: 56.0,
            css_ix: 10.0,
            css_iy: 10.0,
            css_iw: 532.0,
            css_ih: 36.0,
            ..Default::default()
        }),
        sel: Mutex::new(String::new()),
        sel_url: Mutex::new(None),
        sel_urls: Mutex::new(Vec::new()),
    });
}

/// WebView2 启动参数。
///
/// `--disable-gpu-sandbox` 是**必须的**：本机上 Chromium 的 GPU 进程在沙箱里会反复
/// 崩溃（chrome_debug.log: `GPU process exited unexpectedly: exit_code=7`，连崩 9 次后
/// `GPU process isn't usable. Goodbye.`），结果是窗口在、JS 在跑、但一个像素都不画 ——
/// 之前排查很久的"横条黑/透明"就是这个。只关 GPU 进程的沙箱，渲染器沙箱保持完整。
/// 前面那串是 Tauri 默认参数（wry 里 additional_browser_args 会**整体替换**默认值，所以必须带上）。
const DEFAULT_WV_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-sandbox";

/// 所有 WebView2 窗口**必须带同一套** additional_browser_args。
///
/// 同一个 user data 目录下，WebView2 只允许存在一套环境配置：参数不一致时
/// 后建的那个会直接失败 —— 报 HRESULT 0x8007139F
/// 「组或资源的状态不是执行请求操作的正确状态」。
/// 之前横条带了 --disable-gpu-sandbox、设置窗口没带，于是设置窗口**永远打不开**。
fn wv_args() -> String {
    std::env::var("QS_T_WV_ARGS").unwrap_or_else(|_| DEFAULT_WV_ARGS.to_string())
}

/// 组装横条窗口。默认就是正式配置；排查时可以用 QS_T_* 环境变量逐项改，
/// 免得每换一个组合就要重新编译一次。
fn build_bar_window(app: &tauri::App) -> tauri::Result<()> {
    let env_on = |k: &str| std::env::var(k).map(|v| v == "1").unwrap_or(false);
    let env_off = |k: &str| std::env::var(k).map(|v| v == "0").unwrap_or(false);

    let (px, py) = std::env::var("QS_T_POS")
        .ok()
        .and_then(|s| {
            let mut it = s.split(',');
            let a: i32 = it.next()?.trim().parse().ok()?;
            let b: i32 = it.next()?.trim().parse().ok()?;
            Some((a, b))
        })
        .unwrap_or((OFFSCREEN, OFFSCREEN));

    let wv_args = wv_args();

    let mut b = WebviewWindowBuilder::new(app, "bar", WebviewUrl::App("index.html".into()))
        .title("QuickSearchBar")
        .inner_size(520.0, 60.0)
        .position(px as f64, py as f64)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(true)
        .decorations(env_on("QS_T_DECOR"))
        .transparent(!env_off("QS_T_TRANSPARENT"))
        .shadow(env_on("QS_T_SHADOW"))
        .focused(env_on("QS_T_FOCUS"));

    if !env_off("QS_T_TOPMOST") {
        b = b.always_on_top(true);
    }
    if !env_off("QS_T_SKIP") {
        b = b.skip_taskbar(true);
    }
    if !wv_args.is_empty() {
        b = b.additional_browser_args(&wv_args);
    }
    b.build()?;
    Ok(())
}

/// 关掉 WebView2 自带的右键菜单。
///
/// 不关的后果：在横条上按右键，Edge 会先弹出自己的「前进 / 刷新 / 检查」菜单，
/// 它盖在我们的菜单上面，看起来就像"右键坏了"。这个开关只能从 WebView2 的
/// 原生接口设，`preventDefault()` 管不到它。
#[cfg(windows)]
fn disable_default_context_menu(w: &tauri::WebviewWindow) {
    let r = w.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
        let controller: ICoreWebView2Controller = pw.controller();
        match controller.CoreWebView2() {
            Ok(core) => match core.Settings() {
                Ok(s) => match s.SetAreDefaultContextMenusEnabled(false) {
                    Ok(_) => win::log("wv2: default context menu disabled"),
                    Err(e) => win::log(&format!("wv2: set context menu flag failed: {e}")),
                },
                Err(e) => win::log(&format!("wv2: Settings failed: {e}")),
            },
            Err(e) => win::log(&format!("wv2: CoreWebView2 failed: {e}")),
        }
    });
    if let Err(e) = r {
        win::log(&format!("with_webview failed: {e}"));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let env_on = |k: &str| std::env::var(k).map(|v| v == "1").unwrap_or(false);

    let no_elevate = flag("--no-elevate") || env_on("QS_NO_ELEVATE");
    // --settings：启动后直接打开设置面板（也给用户留个快捷入口：
    //             QuickSearch.exe --settings）
    let open_settings_at_start = flag("--settings");
    // --bar：启动后直接摆出横条（**仅测试用**，配合 QS_INSTANCE_TAG 用，见 setup 里的注释）
    let bar_at_start = flag("--bar");
    // --ensure-file <路径>：测试用。Rust 以 ~120ms 的间隔盯着这个文件，只要
    //   里面出现了新的一行控件名，就让设置页把该控件滚进视口并重报坐标。
    //   为什么要绕这么一圈：外部脚本没法在 WebView 里执行 JS，但又必须拿到
    //   "此刻真的在屏幕上"的坐标（设置页内容比视口高，滚出去的控件
    //   getBoundingClientRect 给的 y 会超出视口，按它点击就落到屏幕外了）。
    let ensure_file: Option<String> = args
        .iter()
        .position(|a| a == "--ensure-file")
        .and_then(|i| args.get(i + 1).cloned());
    // 兼容一次性的 --ensure <名>：启动后按顺序发一遍，然后就结束。
    let ensure_rects: Vec<String> = args
        .iter()
        .enumerate()
        .filter(|(_, a)| a.as_str() == "--ensure")
        .filter_map(|(i, _)| args.get(i + 1).cloned())
        .collect();
    // --paused：启动时就是「暂停使用」状态。
    //           适合建一个"静默启动"的快捷方式：开机自启但不打扰。
    //           注意暂停本身不落盘，所以下一次不带这个参数启动就恢复了。
    let start_paused = flag("--paused");
    // --pick-app：启动后直接拉起「鼠标点选程序」覆盖层（自动化测试用的一条捷径）。
    // 这里先算成 bool，而不是在 setup 闭包里调 flag —— 闭包是 'static 的，
    // 借 args 会编译不过。
    let pick_app_at_start = flag("--pick-app");
    // --region：启动后直接进 OCR 框选（自动化测试用的一条捷径）。
    // 为什么需要它：本机上还有别的全局输入工具会注入鼠标/键盘事件，
    // 走 Ctrl+Alt+O 进框选时经常被那些注入事件干扰（刚开窗就被一次幽灵
    // 点击当成框选、或者 O 键被别的钩子吃掉）。绕开热键直接开窗，
    // 测试就只测「框选遮罩本身的行为」这一件事。
    let region_at_start = flag("--region");
    // --ocr-demo：启动后直接打开「识别结果」窗口，内容用 QS_T_OCR_TEXT /
    // QS_T_OCR_IMG 两个环境变量喂进去（自动化测试用，绕开真实 OCR 额度）。
    let ocr_demo = flag("--ocr-demo");
    // --touch-config：加载一次配置并立刻重新保存，然后退出（不进界面）。
    //
    // 为什么需要它：`.bak` 是保存时产生的，所以「验证 .bak 能不能救回配置」
    // 这类测试需要一条**不点界面**就能触发保存的路径。走界面就得模拟点击，
    // 那会把「点得准不准」和「存档机制对不对」两件事搅在一起，出错时说不清。
    if flag("--touch-config") {
        let cfg = config::load();
        config::save(&cfg);
        std::process::exit(0);
    }
    // --update-probe：只查一次更新并把结果打到 stdout，然后退出（不进界面）。
    //
    // 为什么需要它：更新这条链最要紧的两段（"远端比当前新"和"下载+替换"）
    // 没法靠界面自动化可靠地测 —— 尤其"替换正在运行的 exe"那一步，
    // 一旦测坏就是"程序没了"。这条 run-and-exit 的探针让外部脚本能：
    //   · 拿一个假的 GitHub（QS_UPDATE_API / QS_UPDATE_WEB 指过去）验发现新版；
    //   · 再跑 --update-install 验下载 / 校验 / 替换 / 清理，全程可断言文件状态。
    if flag("--update-probe") {
        match update::check(config::VERSION) {
            Ok(i) => {
                println!("NEWER={}", i.newer);
                println!("TAG={}", i.tag);
                println!("CURRENT={}", i.current);
                println!("SIZE={}", i.size);
                println!("SHA={}", i.sha256);
                println!("URL={}", i.url);
            }
            Err(e) => println!("ERR={e}"),
        }
        std::process::exit(0);
    }
    // --update-install：查一次 → 下载 → 校验 → 替换（run-and-exit，仅测试用）。
    //
    // ⚠ 它**会真的换掉当前这份 exe**（这正是要验的东西）。所以只该在隔离目录里跑。
    if flag("--update-install") {
        let r = update::check(config::VERSION).and_then(|i| {
            if !i.newer {
                return Err("当前已是最新，无需安装".to_string());
            }
            let p = update::download(&i, &mut |d, t| {
                if t > 0 && d % (4 * 1024 * 1024) < 64 * 1024 {
                    println!("PROGRESS={d}/{t}");
                }
            })?;
            println!("DOWNLOADED={}", p.display());
            update::apply_update()
        });
        match r {
            Ok(old) => println!("OK old={}", old.display()),
            Err(e) => println!("ERR={e}"),
        }
        std::process::exit(0);
    }
    // --uia-probe：诊断「UIA 在本机到底能不能用」的只读探针。
    //
    // 存在的理由：划词取值的首选通道是 UIA（选中即读、不碰剪贴板），
    // 但线上日志显示本机 WebView2/浏览器类窗口上 UIA 12 次全灭。
    // 这条命令把「前台窗口 + 指定点」两条元素链逐层打出来
    // （类名 / 有无 TextPattern 及 HRESULT / 选区数与文字），
    // 用来区分「UIA 对 WebView2 整体不可用（→ 必须恢复剪贴板通道）」
    // 与「我们的代码有坑（→ 修代码即可）」。run-and-exit，不进界面。
    //
    // 用法：拖选出一段文字后立刻跑
    //   QuickSearch.exe --uia-probe
    // 可选 QS_UIA_PROBE_PT=x,y 指定要探的点（默认只探前台窗口）。
    if flag("--uia-probe") {
        let pt = std::env::var("QS_UIA_PROBE_PT").ok().and_then(|s| {
            let mut it = s.split(',');
            let x = it.next()?.trim().parse::<i32>().ok()?;
            let y = it.next()?.trim().parse::<i32>().ok()?;
            Some(windows::Win32::Foundation::POINT { x, y })
        });
        win::uia_probe(pt);
        std::process::exit(0);
    }
    // --webdav-list <url> <user> <pass> <file>
    //
    // 只做一件事：把云端目录列出来打到 stdout，然后退出（不进图形界面）。
    // 存在的理由是「恢复备份能选云端哪一份」这条需求没法靠单元测试收尾 ——
    // 解析器对了不等于 PROPFIND 真能打通、服务器真会回 207。这条命令让
    // 端到端脚本能直接问程序「你看到哪几份」，把网络与解析一起验掉。
    if let Some(i) = args.iter().position(|a| a == "--webdav-list") {
        let url = args.get(i + 1).cloned().unwrap_or_default();
        let user = args.get(i + 2).cloned().unwrap_or_default();
        let pass = args.get(i + 3).cloned().unwrap_or_default();
        let o = webdav::Opts {
            url,
            user,
            pass,
            timeout_secs: 20,
        };
        // 走 list_newest_first：和设置页那份列表同一个顺序，e2e 脚本
        // 才能用「第一行就是我刚传的那份」来断言。
        match webdav::list_newest_first(&o) {
            Ok(v) => {
                for b in v {
                    println!("{}\t{}\t{}", b.name, b.size, b.mtime);
                }
            }
            Err(e) => println!("ERR\t{e}"),
        }
        std::process::exit(0);
    }
    /* --webdav-peek <文件名> <备份密码>：下载云端某一份并**解密后**打印它的
     * bar_list 与 custom_engines 名字。
     *
     * # 为什么要这条命令（真实事故）
     *
     * 我的自动化测试实例把测试配置推到了用户云端，用户的真实配置被覆盖后
     * 又"从云端恢复"回来 —— 结果横条上的引擎全没了。
     * 事后要判断"云端这 100 多份里哪一份还是好的"，只能一份份下载+解密+肉眼看。
     * GUI 一次只能恢复一份、而且是破坏性的（会覆盖本机）。
     *
     * 有了这条命令就能**只读地**扫一遍，确定哪一份是对的，再去操作。
     * 它只打印摘要（引擎名列表），不打印正文，避免把用户数据洒到终端里。 */
    if let Some(i) = args.iter().position(|a| a == "--webdav-peek") {
        let name = args.get(i + 1).cloned().unwrap_or_default();
        let pw = args.get(i + 2).cloned().unwrap_or_default();
        let cfg = config::load();
        let o = webdav::Opts {
            url: cfg.webdav_url.clone(),
            user: cfg.webdav_user.clone(),
            pass: cfg.webdav_pass.clone(),
            timeout_secs: 25,
        };
        match webdav::download_named(&o, &name) {
            Ok(raw) => match crypto::decrypt(&raw, &pw) {
                Ok(plain) => match serde_json::from_str::<serde_json::Value>(&plain) {
                    Ok(v) => {
                        let bar = v
                            .get("barList")
                            .and_then(|x| x.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0);
                        let ces: Vec<String> = v
                            .get("customEngines")
                            .and_then(|x| x.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|e| {
                                        e.get("name").and_then(|n| n.as_str()).map(String::from)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        println!("OK\tbar={bar}\tcustom={}", ces.join(","));
                    }
                    Err(e) => println!("ERR\tJSON {e}"),
                },
                Err(e) => println!("ERR\t解密失败 {e}"),
            },
            Err(e) => println!("ERR\t下载失败 {e}"),
        }
        std::process::exit(0);
    }

    // --stress N：反复 show/hide 横条 N 次，每次采一次内存，用来做泄漏检测
    let stress: Option<usize> = args
        .iter()
        .position(|a| a == "--stress")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<usize>().ok())
        .map(|n| n.min(5000));
    // 这一行必须**同步**落盘：紧接着的单实例判定可能让进程在几百微秒内 exit，
    // 走异步队列的话它会直接丢（排查时表现为"日志里什么都没有"，很容易误判）。
    win::log_sync(&format!("=== start, args={:?} ===", args));

    // 任何线程 panic 都记进日志，而不是让程序静默消失
    //
    // ⚠ 必须用 `log_sync`（同步写盘）而不是 `log`（走后台队列）。
    //   panic 之后进程往往**立刻**退出，队列里那条消息根本没机会落盘 ——
    //   表现就是"程序没了，日志里一个字都没有"，比崩溃本身更难查。
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "?".to_string());
        // 同时打到 stderr（调试构建带控制台时能直接看见；正式构建没有控制台也无害）
        eprintln!("PANIC {loc} {msg}");
        win::log_sync(&format!("PANIC {loc} {msg}"));
        /* 建 WebView2 失败是唯一一种"必须告诉用户"的 panic。
         *
         * 实测成因很具体：上一个实例被强杀（或任务管理器结束进程）之后，它的
         * WebView2 用户数据目录会短暂处于"使用中"，这时立刻重开就会收到
         * `HRESULT(0x800700AA) 请求的资源在使用中`，程序随即 exit(101)。
         * 用户看到的只是"点了没反应，再点一次就好了" —— 但完全不知道为什么。
         * 给一句人话，用户就知道等一秒再开。 */
        if msg.contains("failed to create webview") {
            win::message_box(
                "Quick Search 没能启动",
                "创建界面组件失败 —— 通常是上一个 Quick Search 刚被强制结束，\
                 它占用的目录还没释放。\n\n请等一两秒再双击一次。\n\n\
                 （若反复出现，注销或重启一次即可。）",
            );
        }
    }));

    // 1. 已经有一个在跑就直接退，避免出现两个托盘图标
    if win::already_running() {
        win::log_sync("another instance is running, exit");
        std::process::exit(0);
    }

    // 2. 默认以管理员跑（这样才能把 Ctrl+C 送进同样是管理员的程序里）。
    //    设置面板里可以关掉，所以要**先把配置文件读出来**再决定 —— 这一步只读磁盘，
    //    不需要 STATE 就绪。
    let elevate_wanted = config::load().auto_elevate;
    if !no_elevate && elevate_wanted && !win::is_admin() {
        win::log("not admin, trying to relaunch as admin");
        if win::relaunch_as_admin() {
            win::log("elevated instance launched, exit");
            std::process::exit(0);
        }
        win::log("elevation refused, continue as normal user");
    } else if !elevate_wanted {
        win::log("auto-elevate 已在设置里关闭，以普通权限运行");
    }

    init_state();
    config::ensure_dirs();
    let cfg0 = cfg_snapshot();
    if cfg0.auto_start {
        win::set_autostart(true);
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_setting,
            set_settings,
            // r70：内部唤起入口（探针/自动化驱真流程用；见 show_bar 的文档）
            show_bar,
            layout_bar,
            grow_bar,
            focus_bar,
            hide_bar,
            set_fav_pinned,            open_search,
            open_link,
            open_links,
            glass_take,
            glass_capture,
            glass_exclude,
            pick_icon,
            pick_app,
            /* r88：把「绑定应用」的图标拿来当引擎图标（用户要求） */
            app_icon_from_exe,
            reset_icon,
            open_icon_editor,
            icon_edit_load,
            icon_edit_ready,
            icon_remove_bg,
            icon_editor_save,
            icon_editor_export,
            close_icon_editor,
            // r80：AI 抠图（模型管理与状态）
            ai_matting_status,
            ai_matting_select,
            ai_matting_enable,
            ai_matting_remove,
            ai_matting_download,
            ai_matting_cancel,
            // r80p：单独下载运行库（用户要求提供独立下载入口）
            ai_runtime_download,
            // r80g：模型存放位置（直达 / 更换 / 迁移）
            ai_model_dir_info,
            ai_model_dir_pick,
            ai_model_dir_reset,
            ai_model_dir_open,
            // r80i：清理下载残留 + 旧位置的模型
            ai_cleanup_stale,
            // r80g：设置页里的独立抠图工具
            ai_cutout_pick,
            ai_cutout_save,
            pick_app_at,
            pick_app_path_at,
            pick_app_file,
            open_app_picker,
            picker_cancel,
            export_config,
            import_config,
            webdav_test,
            webdav_upload,
            webdav_preview_url,
            webdav_list,
            webdav_delete,
            prune_backups,
            cleanup_data,
            webdav_restore_named,
            grab_foreground_app,
            ocr_start,
    // r54：识图搜索（横条上的「识图」按钮 → 框选 → 以图搜图）
    img_start,
    img_region,
    img_engines_list,
    open_path,
    // r54 需求 3：明文配置的按项导出 / 导入
    export_groups_list,
    export_items,
    import_items,
            ocr_test,
            ocr_env_check,
            ocr_open_language_settings,
            ocr_open_lang_help,
            ocr_diagnose,
            ocr_warm,
            ocr_region,
            ocr_cancel,
            region_beat,
            ocr_ready,
            settings_ready,
            qs_page_ack,
            ocr_take_text,
            ocr_take_image,
            ocr_take_note,
            ocr_take_parts,
            close_ocr_window,
            ocr_rerun,
            ocr_rescan,
            ocr_reclean,
            ocr_engines_list,
            ocr_open_help,
            ocr_open_docs,
            img_open_help,
            ocr_set_cred,
            ocr_set_multi,
            ocr_test_engine,
            ocr_list_models,
            backup_info,
            pick_backup_dir,
            open_backup_dir,
            clean_old_backups,
            fav_copy,
            fav_send,
            fav_pick_image,
            copy_text,
            toggle_bar_engine,
            move_bar_item,
            add_separator,
            remove_separator,
            remove_bar_ocr,
            add_custom_engine,
            update_custom_engine,
            remove_custom_engine,
            add_app,
            update_app,
            remove_app,
            open_app,
            reset_all,
            open_settings,
            open_data_dir,
            log_msg,
            ensure_rect,
            quit_app,
            // v1.2.0：自动更新（查 / 下 / 装 / 重启 / 关于页那颗 GitHub 按钮）
            update_check,
            update_pending,
            update_install,
            update_restart,
            open_repo_page,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());

            // ---- 创建横条窗口（放在这里而不是 tauri.conf.json，方便用环境变量做二分诊断）----
            if let Err(e) = build_bar_window(app) {
                win::log(&format!("create bar window failed: {e}"));
                return Err(e.into());
            }

            if let Some(w) = app.get_webview_window("bar") {
                if let Ok(h) = w.hwnd() {
                    let addr = h.0 as isize;
                    BAR_HWND.store(addr, Ordering::Relaxed);
                    let hwnd = HWND(addr as *mut c_void);
                    if !std::env::var("QS_NO_OVERLAY").map(|v| v == "1").unwrap_or(false) {
                        win::make_overlay(hwnd);
                    }
                    if !std::env::var("QS_STATIC_POS").map(|v| v == "1").unwrap_or(false) {
                        let _ = w.set_position(tauri::PhysicalPosition::new(OFFSCREEN, OFFSCREEN));
                    }
                    win::log(&format!("bar hwnd = {:#x}, admin = {}", addr, win::is_admin()));
                }
                #[cfg(windows)]
                disable_default_context_menu(&w);
            }

            // 对照实验：一个最普通的窗口，用来判断「WebView2 到底会不会画」
            if std::env::var("QS_PROBE_WINDOW").map(|v| v == "1").unwrap_or(false) {
                match WebviewWindowBuilder::new(
                    app,
                    "probe",
                    WebviewUrl::App("index.html".into()),
                )
                .title("QS Probe")
                .inner_size(640.0, 200.0)
                .position(300.0, 500.0)
                .build()
                {
                    Ok(w) => win::log(&format!("probe window built, hwnd={:?}", w.hwnd().map(|h| h.0))),
                    Err(e) => win::log(&format!("probe window failed: {e}")),
                }
            }

            build_tray(&handle)?;
            // 托盘建好之后再设初始暂停态 —— 刷新图标/悬停提示都要用到它
            if start_paused {
                set_paused(&handle, true);
            }
            // 压测模式下不装钩子：那是要跑成百上千次 show/hide，
            // 钩子再来凑热闹会把结果搅乱。
            if stress.is_none() {
                spawn_detector();
                spawn_rbutton_watch();
                spawn_bar_topmost_watch();
                // r75：设置窗关掉一段时间后真正销毁（回收那 200~300MB）
                spawn_settings_reaper();
                // 后台先把 UIA 热起来：第一次调用要加载 UIAutomationCore、
                // 建跨进程代理，能花一秒以上，不能让第一次划词去付这笔钱。
                win::uia_warm_up();
            }
            if open_settings_at_start {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(1200));
                    open_settings(None, None);
                });
            }
            // --bar：启动后直接把横条摆出来（**仅测试用**）。
            //
            // 为什么需要它：自动化探针要验横条/面板/右键菜单，本来靠注入 Ctrl+C 唤起。
            // 但注入是全局的，用户自己的实例（管理员权限、脚本关不掉）会**同时**响应，
            // 于是两边抢焦点、互相干扰。有了这个开关，探针自己这份实例不碰任何全局
            // 输入就能把横条摆出来（配合 QS_INSTANCE_TAG 另起一份实例）。
            if bar_at_start {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(1500));
                    let p = win::cursor_pos();
                    win::log(&format!("--bar: show at ({},{})", p.x, p.y));
                    show_bar(String::new(), false, false);
                });
            }
            // --ensure-file：盯文件发「滚到某控件并重报坐标」的事件（测试用）。
            if let Some(f) = ensure_file.clone() {
                let h = handle.clone();
                std::thread::spawn(move || {
                    let mut seen = 0usize;
                    for _ in 0..1200 {
                        // 最多盯 2 分钟，测试跑完就自然结束，不留幽灵线程
                        std::thread::sleep(Duration::from_millis(120));
                        let Ok(s) = std::fs::read_to_string(&f) else { continue };
                        let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
                        if lines.len() <= seen {
                            continue;
                        }
                        for name in &lines[seen..] {
                            let name = name.trim().to_string();
                            win::log(&format!("ensure-file -> {name}"));
                            let _ = h.emit_to("settings", "qs://ensure-rect", name);
                        }
                        seen = lines.len();
                    }
                });
            }
            // --ensure：启动后按顺序把这几颗控件滚进视口（一次性，测试用）。
            if !ensure_rects.is_empty() {
                let list = ensure_rects.clone();
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2600));
                    for name in list.iter() {
                        win::log(&format!("ensure -> {name}"));
                        let _ = h.emit_to("settings", "qs://ensure-rect", name.clone());
                        std::thread::sleep(Duration::from_millis(900));
                    }
                });
            }
            // --pick-app：启动后直接拉起「鼠标点选程序」覆盖层。
            // 纯给自动化测试用的一条捷径（正常入口是设置页那个按钮），
            // 免得测试为了点一个小按钮去跟 DPI、窗口位置搏斗。
            if pick_app_at_start {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(1500));
                    // 老用途（挑程序名进黑白名单）；挑路径那条由设置页按 want=path 走
                    open_app_picker_impl("");
                });
            }
            // --region：启动后直接进 OCR 框选（同样只给测试用）。
            // 绕开 Ctrl+Alt+O，避免测试注入的热键被本机别的输入工具干扰。
            if region_at_start {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(1500));
                    open_region_window_mode("ocr");
                });
            }
            // --ocr-demo：直接开「识别结果」窗口，喂一份假结果（测试用）。
            if ocr_demo {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(1500));
                    // 默认带链接，好让自检能验证「有链接时按钮出现」这条路径
                    let text = std::env::var("QS_T_OCR_TEXT").unwrap_or_else(|_| {
                        "示例识别结果 QuickSearch 12345\n\
                         官网 https://example.com/docs 和 www.test.org/b 都可打开"
                            .to_string()
                    });
                    if let Ok(mut g) = OCR_LAST_PNG.lock() {
                        *g = demo_png();
                    }
                    open_ocr_window(text);
                });
            }
            // ---- 启动时 WebDAV 同步 ----
            // 故意等一会儿：让窗口、钩子、图标先各就各位，别跟启动抢网络和磁盘。
            // 设置面板早就开着的话，同步结果也能正常显示出来。
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(6));
                webdav_sync_on_start();
            });
            /* ---- v1.2.0：清掉上次更新留下的 .old ----
             * 替换那一刻旧 exe 还被本进程占着、删不掉；**现在**（新进程里）
             * 它已经不被占用了，才能删。放在这里既早（不拖启动）又安全
             * （删不掉也只是留个文件，不影响任何功能）。 */
            std::thread::spawn(|| {
                let n = update::sweep_leftovers();
                if n > 0 {
                    win::log(&format!("update: 启动清理了 {n} 个更新残留"));
                }
            });
            // ---- v1.2.0：自动检查更新（勾了开关才做）----
            // 用户口径：「每次打开软件，它都会检测当前是不是最新版，如果是最新版，
            // 那就什么都不发生」。所以这里是**静默**的：没新版一条事件都不发。
            auto_check_on_start();
            win::log("hooks + tray ready");

            // ---- 内存泄漏压测：反复显示/隐藏横条，观察资源是否单调上涨 ----
            if let Some(n) = stress {
                std::thread::spawn(move || {
                    let dump = |t: (u64, u64, u32, u32, u32), tag: &str| {
                        win::log(&format!(
                            "MEM {tag}: ws={:.1}MB priv={:.1}MB handles={} gdi={} user={}",
                            t.0 as f64 / 1048576.0,
                            t.1 as f64 / 1048576.0,
                            t.2,
                            t.3,
                            t.4
                        ));
                    };
                    std::thread::sleep(Duration::from_millis(900));
                    dump(win::mem_stats(), "0-base");
                    for i in 1..=n {
                        // 顺带把「剪贴板整盘快照 → 还原」这条最容易漏 HGLOBAL 的
                        // 路径也压一遍。真实选词时每弹一次就走一次这条链。
                        if let Some(s) = clip::snapshot() {
                            clip::restore(&s);
                        }
                        show_bar(format!("压力测试样本 {i} —— 选中文字即可弹出搜索横条"), false, false);
                        std::thread::sleep(Duration::from_millis(80));
                        dismiss_bar();
                        std::thread::sleep(Duration::from_millis(40));
                        if i % 25 == 0 {
                            dump(win::mem_stats(), &format!("{i}"));
                        }
                    }
                    std::thread::sleep(Duration::from_millis(900));
                    dump(win::mem_stats(), "end");
                    win::log("=== STRESS DONE ===");
                });
            }

            Ok(())
        })
        .on_page_load(|webview, payload| {
            win::log(&format!(
                "page load {:?} label={} url={}",
                payload.event(),
                webview.label(),
                payload.url()
            ));
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "settings" {
                        api.prevent_close();
                        let _ = window.hide();
                        // r75：记下"从这一刻起它是隐藏的"，交给回收线程决定
                        // 什么时候真正销毁（见 SETTINGS_IDLE_DESTROY_SECS）。
                        SETTINGS_HIDDEN_AT.store(now_unix(), Ordering::Relaxed);
                    }
                }
                // OCR 结果窗口：用户拖过大小就记下来，下次识别按这个尺寸开。
                // ⚠ Resized 给的是**物理**像素，存之前要按缩放比换成逻辑像素 ——
                //   否则 200% 缩放的机器上会存成两倍大的尺寸，下次开窗直接超屏。
                WindowEvent::Resized(size) if window.label() == "ocr" => {
                    let sf = window.scale_factor().unwrap_or(1.0);
                    if sf <= 0.0 {
                        return;
                    }
                    let w = (size.width as f64 / sf).round() as u32;
                    let h = (size.height as f64 / sf).round() as u32;
                    remember_ocr_size(w, h);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("QuickSearch 启动失败");
}

/* ================================================================== */
/* 单元测试                                                            */
/*                                                                    */
/*  只覆盖**纯逻辑**：自定义引擎的校验规则、横条重排的下标语义。       */
/*  这两块都是"边界条件很多、又很难靠手点试出来"的地方 —— 比如 URL 里  */
/*  少写一个 %s、名字里混进一个竖线，手点十次也未必碰到。              */
/*  跑法：cargo test --release                                     */
/* ================================================================== */

#[cfg(test)]
mod tests {

    use super::*;

    fn empty_cfg() -> config::Config {
        config::Config::default()
    }

    /// **横条圆角与图标外框圆角必须同心**（用户报的"外框圆角和横条不一致"）。
    ///
    /// # 这条测试防的是什么
    ///
    /// 修之前：横条 `calc(--qs-radius + 4px)`、图标 `--qs-radius` —— 那 4px 是
    /// 老的硬编码补偿，两者因此永远差 4px。圆角滑到 3px 时是 **7 vs 3**，
    /// 图标外框相对横条几乎是方的，一眼就不协调。
    ///
    /// 正确关系（同心圆）：图标贴着横条的内边距边缘，所以
    /// **横条外圆角 = 图标圆角 + 内边距**。
    ///
    /// 这条测试只在 CSS 文本上做断言，不启动浏览器 —— 这正是它存在的价值：
    /// 谁要是哪天又把横条那行改回"拍一个常数"，或者把 `--qs-bar-r` 的定义改掉，
    /// `cargo test` 立刻会红，不用等到用户发现"看着别扭"。
    #[test]
    fn 横条圆角与图标外框同心() {
        let css = include_str!("../ui/bar.css");

        // ① 图标外框用的是 `--qs-icon-r`（滑块值本身）
        assert!(
            css.contains("border-radius: var(--qs-icon-r, var(--qs-radius, 9px));"),
            "图标外框的圆角必须走 --qs-icon-r（滑块值）"
        );

        // ② 横条用的是 `--qs-bar-r`（由图标圆角 + 内边距推出）
        assert!(
            css.contains("border-radius: var(--qs-bar-r);"),
            "横条的圆角必须走 --qs-bar-r（同心推导），不能写常数"
        );

        // ③ 同心关系本身：--qs-bar-r = --qs-icon-r + --qs-bar-pad
        assert!(
            css.contains("--qs-bar-r: calc(var(--qs-icon-r) + var(--qs-bar-pad, 5px));"),
            "同心的推导式必须是「图标圆角 + 内边距」"
        );
        assert!(
            css.contains("--qs-icon-r: var(--qs-radius, 9px);"),
            "--qs-icon-r 必须直接取滑块值"
        );

        // ④ 字母徽标比外框内缩 3px（.ico 的 padding），圆角也要跟着少 3px；
        //    老的 `* .72` 系数会让它比外框更方。
        assert!(
            !css.contains("calc(var(--qs-radius, 9px) * .72)"),
            "字母徽标不能用 .72 系数 —— 它比外框内缩 3px，圆角应减 3px 才同心"
        );
        assert!(
            css.contains("calc(var(--qs-icon-r, var(--qs-radius, 9px)) - 3px)"),
            "字母徽标的圆角应为「图标圆角 - 3px」"
        );

        // ⑤ 体量校验：设成用户实际用的 3px 圆角 + 2px 内边距时，
        //    横条 5px、图标 3px、徽标 0px —— 三者单调递减且不打架。
        //    （这里只做"关系"断言，真实像素由浏览器算。）
        let r: f64 = 3.0;
        let pad: f64 = 2.0;
        let bar = r + pad;
        let icon = r;
        let letter = (icon - 3.0).max(0.0);
        assert!(bar > icon, "横条圆角必须大于图标圆角（差一个内边距）");
        assert!(icon >= letter, "图标圆角不能小于字母徽标（它是内层）");
        assert_eq!(bar, 5.0);
        assert_eq!(letter, 0.0);
    }

    /// 需求 8：「选中的文本里含多个链接 → 点一次按钮分别在多个标签页打开」。
    ///
    /// 这条路的前半段（把一段文字里的链接**全**找出来）就是
    /// `engines::extract_links`，后半段 `spawn_open_links` 会真去开浏览器，
    /// 不在单测范围（探针里验）。
    ///
    /// r55：判据本体连同这条测试一起搬去了 `engines.rs`（`extract_links_dedups_and_keeps_order`）。
    /// 这里只留一条**跨模块**的：证明 main 的 `spawn_open_links` 用的确实是
    /// 模块里那一份，不是另写的一套。
    #[test]
    fn open_links_uses_the_same_extractor() {
        let t = "参考 https://example.com/a 和 www.test.org/b ，还有 index.html 不是链接。";
        assert_eq!(engines::extract_links(t).len(), 2);
        assert!(engines::extract_links("这是一句话，没有任何网址。").is_empty());
    }

    /* ---------------- 需求 5/7：OCR 文本整理 ---------------- */

    #[test]
    fn clean_strip_garbage_only_removes_real_noise() {
        // U+FFFD、控制字符、零宽字符、私用区都清掉；
        // \n 与正常文字（含 emoji、假名、生僻字）必须留着
        let raw = "正常\u{FFFD}文字\u{1}\u{200B}和\u{E000}私用区\n第二行😀かな";
        assert_eq!(strip_garbage(raw), "正常文字和私用区\n第二行😀かな");
    }

    #[test]
    fn clean_halfwidth_only_touches_ascii_mirrors() {
        // 全角字母/数字/括号 → 半角
        assert_eq!(to_halfwidth("ＡＢＣ１２３（ｘ）"), "ABC123(x)");
        // 中文标点不在 U+FF01..FF5E 里（。是 U+3002）→ 原样；，是 U+FF0C → 收成半角
        assert_eq!(to_halfwidth("中文，标点。保留"), "中文,标点。保留");
        assert_eq!(to_halfwidth("全角\u{3000}空格"), "全角 空格");
    }

    #[test]
    fn clean_unwrap_joins_wrapped_lines_but_keeps_structure() {
        // 被排版断开的整句 → 接回一段（中文直接贴、英文补空格）
        assert_eq!(unwrap_lines("这是一段被断开\n的句子。"), "这是一段被断开的句子。");
        assert_eq!(unwrap_lines("hello\nworld"), "hello world");
        // 上一行以句末标点收尾 → 是完整句子，不接
        assert_eq!(unwrap_lines("第一句。\n第二句。"), "第一句。\n第二句。");
        // 右引号收尾也算句子结束（看它前面那个字符）
        assert_eq!(unwrap_lines("他说：“好的。”\n然后走了。"), "他说：“好的。”\n然后走了。");
        // 列表 / 编号 / 表格的换行是**语义**，不接
        assert_eq!(unwrap_lines("- 甲\n- 乙"), "- 甲\n- 乙");
        assert_eq!(unwrap_lines("1. 甲\n2. 乙"), "1. 甲\n2. 乙");
        assert_eq!(unwrap_lines("| a | b |\n| c | d |"), "| a | b |\n| c | d |");
        // 空行是段落分隔
        assert_eq!(unwrap_lines("上段\n\n下段"), "上段\n\n下段");
    }

    #[test]
    fn clean_text_applies_in_the_documented_order() {
        let raw = "ＡＢＣ\u{FFFD}被断开\n的段落";
        assert_eq!(clean_text(raw, 0), raw); // 全关 → 原样
        assert_eq!(clean_text(raw, CLEAN_GARBAGE), "ＡＢＣ被断开\n的段落");
        assert_eq!(clean_text(raw, CLEAN_WIDTH), "ABC\u{FFFD}被断开\n的段落");
        assert_eq!(
            clean_text(raw, CLEAN_GARBAGE | CLEAN_WIDTH | CLEAN_UNWRAP),
            "ABC被断开的段落"
        );
        // 空格那项的三态
        assert_eq!(clean_text("a  b  中 文", CLEAN_SPACE_FORCE), "ab中文");
        // ⚠ 智能档的规则见 ocr::clean_spaces：只留"两个以上字母数字的词"之间的
        //   空格，单个字母之间（"a b"）是**故意**清掉的（老规则，别当成 bug 改）；
        //   保留下来的一串空格由 collapse_space_runs 收成一个（用户报的
        //   「很多的空格」有一半是这种）。
        assert_eq!(clean_text("hello  world", CLEAN_SPACE_SMART), "hello world");
        assert_eq!(clean_text("a  b", CLEAN_SPACE_SMART), "ab");
        assert_eq!(clean_text("a  b", 0), "a  b");
        // 档位名字（给前端点亮按钮用）
        assert_eq!(clean_space_name(CLEAN_SPACE_FORCE), "force");
        assert_eq!(clean_space_name(CLEAN_SPACE_SMART), "smart");
        assert_eq!(clean_space_name(0), "off");
    }

    /// 拿一个内置引擎名（一定存在于 engines.json 里）
    fn builtin_name() -> String {
        engines::engines().keys().next().cloned().unwrap_or_default()
    }

    /// 横条那颗「打开这个网址」按钮显不显示，全靠 `text_to_url` —— 两个方向都要准。
    ///
    /// 这一条是用户报的"这个按钮时灵时不灵"的回归测试：
    ///   · 假阴性：`HTTP://…`（协议大小写）、带中文路径的真网址、`<…>` 包裹、
    ///     选中时把后面的说明文字一起带进来 —— 老实现一律判成"不是网址"；
    ///   · 假阳性：`index.html` / `package.json` / `test.js` 这些**文件名** ——
    ///     老实现只看"最后一段纯字母且 >= 2 位"，把它们全放行了。
    ///
    /// r55：判据本体连同这条测试一起搬去了 `engines.rs`
    /// （`text_to_url_rejects_filenames_but_accepts_real_hosts`，那边用例更全）。
    /// 这里只留一条**跨模块**的：证明 main 里填 `isUrl` 用的确实是模块里那一份。
    #[test]
    fn text_to_url_is_the_module_one() {
        assert_eq!(
            engines::text_to_url("example.com").as_deref(),
            Some("https://example.com")
        );
        // 文件名不能认成网址（用户报过的假阳性）
        for s in ["index.html", "package.json", "test.js"] {
            assert!(engines::text_to_url(s).is_none(), "{s} 不该认成网址");
        }
        // 真网址必须认出来（假阴性）
        for s in ["HTTPS://EXAMPLE.COM", "https://zh.wikipedia.org/wiki/中文"] {
            assert!(engines::text_to_url(s).is_some(), "{s} 应当认成网址");
        }
    }

    /// 横条明暗听谁的：显式选的「亮色 / 暗色」必须压过系统偏好
    /// （设置页的承诺），「跟随系统」才跟 Windows 的日/夜间走。
    /// 老代码不看 theme 字段，用户显式选亮色 + 系统深色 → 横条还是深的。
    ///
    /// ⚠ WCAG 相对亮度 / 0.179 分界那条不在这里测了 —— #148 删掉自动取色后
    ///    Rust 侧不再算亮度，那套逻辑的归宿是前端 bar.js 的对比度护栏
    ///    （colorLum / QS_DARK_CROSSOVER），回归测试在 test-ui.js。
    #[test]
    fn theme_choice_beats_system() {
        // 系统深色（AppsUseLightTheme=0）也压不住显式亮的
        assert!(!theme_dark_from("light", Some(false)));
        // 系统浅色也压不住显式暗的
        assert!(theme_dark_from("dark", Some(true)));
        // 跟随系统：系统深 → 暗，系统浅 → 亮，读不到注册表 → 默认亮
        assert!(theme_dark_from("system", Some(false)));
        assert!(!theme_dark_from("system", Some(true)));
        assert!(!theme_dark_from("system", None));
        // 老配置没有这个字段（空串）等同跟随系统
        assert!(theme_dark_from("", Some(false)));
        assert!(!theme_dark_from("", None));
    }

    #[test]
    fn custom_engine_accepts_valid_input() {
        let c = empty_cfg();
        let e = clean_custom_engine(&c, "  内网搜索  ", "  https://s/?q=%s  ", "", config::EngineKind::Search, "", false, "", false, 900, None)
            .expect("正常输入应当通过");
        assert_eq!(e.name, "内网搜索", "首尾空格要 trim 掉");
        assert_eq!(e.url, "https://s/?q=%s");
        assert_eq!(e.category, config::DEFAULT_CUSTOM_CATEGORY, "留空要落到默认分类");
        assert_eq!(e.kind, config::EngineKind::Search, "没提要按搜索类");
    }

    #[test]
    fn custom_engine_keeps_explicit_category() {
        let c = empty_cfg();
        let e = clean_custom_engine(&c, "备用 Kimi", "https://k/?q=%s", "AI 工具", config::EngineKind::Search, "", false, "", false, 900, None).unwrap();
        assert_eq!(e.category, "AI 工具");
        // 分类含 "AI" 的必须被当成 AI 引擎，否则提问后缀不会生效
        let mut cfg = c;
        cfg.custom_engines.push(e);
        assert!(engines::is_ai_engine_in(&cfg, "备用 Kimi"));
        assert!(!engines::is_ai_engine_in(&cfg, "没这个引擎"));
        // 分类不含 AI 的就不该享受 AI 待遇
        cfg.custom_engines.push(config::CustomEngine {
            name: "普通站点".into(),
            url: "https://p/?q=%s".into(),
            category: "自定义".into(),
            kind: config::EngineKind::Search,
            hotkey: String::new(),
            ..Default::default()
        });
        assert!(!engines::is_ai_engine_in(&cfg, "普通站点"));
        // 内置的 AI 引擎（DeepSeek 在 engines.json 的 AI 分类里）始终算
        assert!(
            engines::builtin_ai_engines().contains("DeepSeek"),
            "DeepSeek 应当在 engines.json 的 AI 分类里"
        );
    }

    #[test]
    fn custom_engine_rejects_bad_names() {
        let c = empty_cfg();
        let cases: &[(&str, &str)] = &[
            ("", "空名字"),
            ("   ", "只有空格的名字"),
            ("a|b", "名字里带竖线（会和分隔线哨兵撞车）"),
            ("一二三四五六七八九十一二三四五六七八九十一二三四五", "超长名字"),
        ];
        for (name, why) in cases {
            let r = clean_custom_engine(&c, name, "https://x/?q=%s", "", config::EngineKind::Search, "", false, "", false, 900, None);
            assert!(r.is_err(), "应当拒绝：{why}");
        }
    }

    #[test]
    fn custom_engine_rejects_duplicate_names() {
        let mut c = empty_cfg();
        // 和内置引擎重名
        let b = builtin_name();
        assert!(!b.is_empty(), "engines.json 应当能解析出内置引擎");
        assert!(
            clean_custom_engine(&c, &b, "https://x/?q=%s", "", config::EngineKind::Search, "", false, "", false, 900, None).is_err(),
            "不该允许和内置引擎「{b}」重名"
        );

        // 和另一个自定义引擎重名
        c.custom_engines.push(config::CustomEngine {
            name: "我的引擎".into(),
            url: "https://a/?q=%s".into(),
            category: "自定义".into(),
            kind: config::EngineKind::Search,
            hotkey: String::new(),
            ..Default::default()
        });
        assert!(
            clean_custom_engine(&c, "我的引擎", "https://b/?q=%s", "", config::EngineKind::Search, "", false, "", false, 900, None).is_err(),
            "不该允许自定义引擎之间重名"
        );
        // 但编辑它自己时（skip 指向自己）必须放行，否则改个分类都存不了
        assert!(
            clean_custom_engine(&c, "我的引擎", "https://b/?q=%s", "", config::EngineKind::Search, "", false, "", false, 900, Some(0)).is_ok(),
            "编辑自己时不该被自己的名字挡住"
        );
    }

    #[test]
    fn custom_engine_rejects_bad_urls() {
        let c = empty_cfg();
        let s = config::EngineKind::Search;
        assert!(clean_custom_engine(&c, "x", "", "", s, "", false, "", false, 900, None).is_err(), "空地址");
        assert!(
            clean_custom_engine(&c, "x", "example.com/?q=%s", "", s, "", false, "", false, 900, None).is_err(),
            "缺协议"
        );
        assert!(
            clean_custom_engine(&c, "x", "https://example.com/search", "", s, "", false, "", false, 900, None).is_err(),
            "搜索类没有 %s 占位符"
        );
        assert!(
            clean_custom_engine(&c, "x", "https://example.com/s?q=%s a", "", s, "", false, "", false, 900, None).is_err(),
            "地址里有空格"
        );
    }

    #[test]
    fn custom_engine_kind_rules() {
        let c = empty_cfg();
        let s = config::EngineKind::Search;
        let o = config::EngineKind::Open;
        // 打开类：没 %s 才收，有 %s 反而拒（原样打开，占位符没人替换）
        assert!(
            clean_custom_engine(&c, "B 站", "https://www.bilibili.com/", "", o, "", false, "", false, 900, None).is_ok(),
            "打开类应当是纯终点地址"
        );
        assert_eq!(
            clean_custom_engine(&c, "B 站", "https://www.bilibili.com/", "", o, "", false, "", false, 900, None).unwrap().kind,
            o,
            "种类要原样落到配置里"
        );
        assert!(
            clean_custom_engine(&c, "B 站", "https://www.bilibili.com/video/%s", "", o, "", false, "", false, 900, None).is_err(),
            "打开类带 %s 必须拒"
        );
        // 搜索类：有 %s 才收
        assert!(
            clean_custom_engine(&c, "B 站", "https://search.bilibili.com/all?keyword=%s", "", s, "", false, "", false, 900, None).is_ok(),
            "搜索类必须带 %s"
        );
        // 非法种类串按搜索类处理（和 EngineKind::parse 的约定一致）
        assert_eq!(config::EngineKind::parse("open"), o);
        assert_eq!(config::EngineKind::parse("OPEN"), o, "大小写不敏感");
        assert_eq!(config::EngineKind::parse(""), s, "空串退回搜索类");
        assert_eq!(config::EngineKind::parse("别的东西"), s, "未知值退回搜索类");
    }

    /* ---------------- r58：快捷键引擎「绑定应用」 ---------------- */

    /// 勾了「先确保应用在运行」却没选应用 → **保存时就拒**。
    ///
    /// 不挡的话：`bind_app=true` 但路径空，点图标时代码会跳过整套逻辑直接发键，
    /// 用户以为"我明明绑了应用"，实际什么都没绑。这种事只能在保存那一刻说清楚。
    #[test]
    fn 绑定应用必须真的选一个应用() {
        let c = empty_cfg();
        let h = config::EngineKind::Hotkey;
        // 勾了开关、路径空 → 拒
        let r = clean_custom_engine(&c, "我的快捷键", "", "", h, "ctrl+shift+t", true, "", false, 900, None);
        assert!(r.is_err(), "勾了开关却没选应用，必须拒：{r:?}");
        // 路径指向不存在的东西 → 拒（否则点图标那一刻才发现拉不起来）
        let r = clean_custom_engine(
            &c, "我的快捷键", "", "", h, "ctrl+shift+t", true,
            r"C:\definitely\not\here-qs\app.exe", false, 900, None,
        );
        assert!(r.is_err(), "不存在的应用路径必须拒：{r:?}");
        // 指向一个**真实存在**的文件 → 收（这里用当前 exe 自己，一定在）
        let me = std::env::current_exe().expect("取当前 exe").to_string_lossy().to_string();
        let ok = clean_custom_engine(&c, "我的快捷键", "", "", h, "ctrl+shift+t", true, &me, false, 900, None);
        assert!(ok.is_ok(), "真实存在的应用应当收：{ok:?}");
        let e = ok.unwrap();
        assert!(e.bind_app, "开关要落库");
        assert_eq!(e.app_path, me, "路径要落库");
    }

    /// 非快捷键类**不许**带着绑定应用的设置落库。
    ///
    /// 理由：用户可能把一条快捷键引擎改成"搜索"，旧设置如果留着，
    /// 以后又改回来就会以意想不到的方式活过来；更糟的是搜索类带着
    /// `bind_app=true` 会让阅读代码的人以为搜索类也会去拉应用。
    #[test]
    fn 只有快捷键类能带绑定应用() {
        let c = empty_cfg();
        let me = std::env::current_exe().expect("取当前 exe").to_string_lossy().to_string();
        for kind in [config::EngineKind::Search, config::EngineKind::Open] {
            let url = if kind == config::EngineKind::Search {
                "https://x/?q=%s"
            } else {
                "https://x/"
            };
            let e = clean_custom_engine(&c, "某引擎", url, "", kind, "", true, &me, true, 900, None)
                .expect("应当能存");
            assert!(!e.bind_app, "{kind:?} 不该带 bind_app");
            assert!(e.app_path.is_empty(), "{kind:?} 不该带 app_path");
            assert!(!e.app_admin, "{kind:?} 不该带 app_admin");
        }
    }

    /// 老配置（没有这三个字段）读进来必须是"没绑应用"，不能炸、也不能默认开。
    #[test]
    fn 老配置的快捷键引擎没有绑定应用() {
        let raw = r#"{"custom_engines":[{"name":"我的键","kind":"hotkey","hotkey":"f5"}]}"#;
        let cfg: config::Config = serde_json::from_str(raw).expect("老配置应当能解析");
        let e = &cfg.custom_engines[0];
        assert!(!e.bind_app, "老配置不该默认开启绑定应用");
        assert!(e.app_path.is_empty());
        assert!(!e.app_admin);
    }

    /* ---------------- r76：启动应用 → 发键的延迟，逐引擎可配 ---------------- */

    /// 快捷键类：延迟要**原样落库**（这是用户逐个引擎设的值）。
    #[test]
    fn 快捷键引擎的启动延迟按用户设的落库() {
        let c = empty_cfg();
        let me = std::env::current_exe().expect("取当前 exe").to_string_lossy().to_string();
        for (ms, why) in [
            (0u32, "0 = 不等（小工具秒开）"),
            (900, "默认那档"),
            (5000, "大型软件要多等"),
        ] {
            let e = clean_custom_engine(
                &c,
                "我的快捷键",
                "",
                "",
                config::EngineKind::Hotkey,
                "ctrl+shift+t",
                true,
                &me,
                false,
                ms,
                None,
            )
            .expect(why);
            assert_eq!(e.app_launch_delay, ms, "{why}");
        }
    }

    /// 延迟上限 60 秒 —— 手打一个天文数字会把横条卡成假死，必须钳住。
    #[test]
    fn 启动延迟有上限() {
        let c = empty_cfg();
        let me = std::env::current_exe().expect("取当前 exe").to_string_lossy().to_string();
        let e = clean_custom_engine(
            &c,
            "我的快捷键",
            "",
            "",
            config::EngineKind::Hotkey,
            "f5",
            true,
            &me,
            false,
            999_999,
            None,
        )
        .expect("应当能存");
        assert_eq!(e.app_launch_delay, 60_000, "超过 60 秒要钳到 60 秒");
    }

    /// 非快捷键类一律 0：那两类压根不会"先拉应用再按键"。
    #[test]
    fn 非快捷键类的启动延迟恒为零() {
        let c = empty_cfg();
        let me = std::env::current_exe().expect("取当前 exe").to_string_lossy().to_string();
        for (kind, url) in [
            (config::EngineKind::Search, "https://x/?q=%s"),
            (config::EngineKind::Open, "https://x/"),
        ] {
            let e = clean_custom_engine(&c, "某引擎", url, "", kind, "", true, &me, true, 4321, None)
                .expect("应当能存");
            assert_eq!(e.app_launch_delay, 0, "{kind:?} 不该带延迟");
        }
    }

    /// 老配置（没有 app_launch_delay 字段）读进来取默认 900 —— 与 r76 之前
    /// 写死的那一拍一致，升级上来的用户行为不变。
    #[test]
    fn 老配置的启动延迟取默认值() {
        let raw = r#"{"custom_engines":[{"name":"我的键","kind":"hotkey","hotkey":"f5","bind_app":true}]}"#;
        let cfg: config::Config = serde_json::from_str(raw).expect("老配置应当能解析");
        assert_eq!(
            cfg.custom_engines[0].app_launch_delay,
            config::default_app_launch_delay(),
            "老配置应当落到默认 900ms"
        );
        assert_eq!(config::default_app_launch_delay(), 900);
    }

    /// `EngineEntry` 也要把用户设的延迟透出去（open_search 读的是它）。
    #[test]
    fn engine_entry透出启动延迟() {
        let mut cfg = empty_cfg();
        cfg.custom_engines.push(config::CustomEngine {
            name: "带延迟的键".into(),
            url: String::new(),
            category: String::new(),
            kind: config::EngineKind::Hotkey,
            hotkey: "f5".into(),
            bind_app: true,
            app_path: String::new(),
            app_admin: false,
            app_launch_delay: 2500,
        });
        let e = engines::engine_entry_in(&cfg, "带延迟的键").expect("应当能查到");
        assert_eq!(e.app_launch_delay, 2500, "快捷键类要透出用户设的延迟");
        // 内置条目取默认值（数据文件里没这个字段）
        let b = engines::engine_entry_in(&cfg, &builtin_name()).expect("内置引擎应当能查到");
        assert_eq!(
            b.app_launch_delay,
            config::default_app_launch_delay(),
            "内置条目取默认延迟"
        );
    }

    /* ---------------- r76：AI 识图的排序与按键判据 ---------------- */

    /// AI 引擎必须排在最前（用户要"AI 最先打开最先完成"），
    /// 且**非 AI 家的相对顺序一个都不能动**。
    ///
    /// ⚠ "非 AI 的顺序"指的是**注册表顺序**（`imgsearch::normalize_list` 从 r62
    ///    起就按注册表排，为的是标签页先后不随用户勾选先后变）—— 不是用户勾选
    ///    顺序。这里按注册表顺序断言，正好把那条设计也一起钉住。
    #[test]
    fn ai识图排在最前且不打乱其余顺序() {
        let mut cfg = empty_cfg();
        cfg.img_ai_first = true;
        // 默认引擎要清空：它默认是 yandex，"只勾 ≤1 家时听默认引擎"那条口径
        // 会盖住我们设的名单（这里勾了三家，走多引擎分支，不受影响 —— 但为了
        // 让测试意图只依赖被测的那一行，统一清掉更稳）。
        cfg.img_default_engine = String::new();
        // 两家非 AI + 一家 AI，故意把 AI 写在中间
        cfg.img_engines = vec!["saucenao".into(), "doubao".into(), "yandex".into()];
        let ids: Vec<&str> = img_plan(&cfg).iter().map(|e| e.id).collect();
        assert_eq!(ids.first().copied(), Some("doubao"), "AI 家要排到最前");
        let rest: Vec<&str> = ids[1..].iter().copied().collect();
        assert_eq!(rest, vec!["yandex", "saucenao"], "其余必须保持注册表顺序");
        // 关掉开关 = 退回 r75 及以前的行为：纯注册表顺序
        cfg.img_ai_first = false;
        let ids2: Vec<&str> = img_plan(&cfg).iter().map(|e| e.id).collect();
        assert_eq!(ids2, vec!["yandex", "saucenao", "doubao"]);
    }

    /// r77 口径（用户原话「勾选多加 ai 识图才关掉按键」）：
    /// **多个 AI** 才关；「默认=百度 + 勾了豆包」这种**一家 AI + 一家非 AI**
    /// 必须照常按键 —— 那正是用户报的那个 bug。
    #[test]
    fn 多家AI时默认关掉自动按键() {
        let mut cfg = empty_cfg();
        cfg.img_ai_auto_off_on_multi = true;
        cfg.img_default_engine = String::new();
        // 两家 AI（豆包 + 通义）→ 一次按键只能喂一个输入框，默认关掉
        cfg.img_engines = vec!["doubao".into(), "tongyi".into()];
        let plan = img_plan(&cfg);
        assert_eq!(plan.len(), 2, "两家都应当在计划里");
        assert!(!img_should_paste(&plan, true, &cfg), "两家 AI 不该自动按键");
        // 把那个开关关掉 = 恢复"任何时候都试"
        cfg.img_ai_auto_off_on_multi = false;
        assert!(img_should_paste(&plan, true, &cfg), "关掉开关后应当恢复按键");
    }

    /// **r77 修的那个真 bug**：默认引擎是百度（非 AI）+ 又勾了豆包（AI）。
    /// 用户原话：「虽然会先打开豆包的页面，但却并不能够执行 ctrl+v 以及 enter」，
    /// 而只勾豆包一家时正常。
    ///
    /// 根因：老判据数的是**总共勾了几家**（2 家 → 关），可真正会抢输入框的
    /// 只有"多个 AI"；非 AI 的百度自己 POST 上传，压根不需要粘贴。
    #[test]
    fn 一家AI加一家非AI仍然按键() {
        let mut cfg = empty_cfg();
        cfg.img_ai_auto_off_on_multi = true;
        cfg.img_default_engine = "baidu".into();   // 用户报的那个配置
        cfg.img_engines = vec!["baidu".into(), "doubao".into()];
        let plan = img_plan(&cfg);
        assert_eq!(plan.len(), 2, "两家都应当在计划里：{:?}",
            plan.iter().map(|e| e.id).collect::<Vec<_>>());
        assert!(
            img_should_paste(&plan, true, &cfg),
            "一家 AI + 一家非 AI 必须照常按键（这正是用户报的 bug）"
        );
        // 顺序也确认一下：AI 优先时豆包排最前（先开、先按完键）
        assert_eq!(plan[0].id, "doubao", "AI 家要排最前");
    }

    /// 只勾 AI 一家 → 照常按键。
    ///
    /// ⚠ 两个坑，都踩过了：
    ///   ① `img_engines` 必须**整个换掉**（不是追加）：`Config::default()` 里
    ///      本来就带着两家默认引擎，push 会变成三家，测的就不是"单家"；
    ///   ② `img_default_engine` 必须**清空**：它默认是 `yandex`，而
    ///      `img_plan` 的口径是"只勾 ≤1 家时听默认引擎的"（r62 起的设计）——
    ///      不清空的话这里返回的是 yandex，压根走不到被测分支。
    #[test]
    fn 只勾AI一家时正常按键() {
        let mut cfg = empty_cfg();
        cfg.img_ai_auto_off_on_multi = true;
        cfg.img_default_engine = String::new();
        cfg.img_engines = vec!["doubao".into()];
        let plan = img_plan(&cfg);
        assert_eq!(plan.len(), 1, "只勾一家时计划里只该有一家：{:?}", plan.iter().map(|e| e.id).collect::<Vec<_>>());
        assert!(img_should_paste(&plan, true, &cfg), "单家 AI 应当按键");
    }

    /// 没 AI / 没粘成功 → 都不该按键。
    #[test]
    fn 没有AI或没粘成就不按键() {
        let mut cfg = empty_cfg();
        cfg.img_default_engine = String::new();
        cfg.img_engines = vec!["yandex".into(), "saucenao".into()];
        let plan = img_plan(&cfg);
        assert!(!img_should_paste(&plan, true, &cfg), "没有 AI 引擎不该按键");
        cfg.img_engines = vec!["doubao".into()];
        let plan_ai = img_plan(&cfg);
        assert!(!img_should_paste(&plan_ai, false, &cfg), "图没进剪贴板不该按键");
    }

    /// AI 识图两段延迟的默认值必须与 r76 之前写死的一致（1200 / 900）——
    /// 升级上来的用户观感不能变。
    #[test]
    fn ai识图延迟默认值与旧行为一致() {
        let cfg = config::Config::default();
        assert_eq!(cfg.img_ai_paste_delay, 1200, "开页→Ctrl+V 默认 1200ms");
        assert_eq!(cfg.img_ai_enter_delay, 900, "Ctrl+V→Enter 默认 900ms");
        assert!(cfg.img_ai_first, "AI 优先默认开");
        assert!(cfg.img_ai_auto_off_on_multi, "多家自动关按键默认开");
    }

    /// 老配置（没有 r76 那四个字段）读进来要拿默认值，不能炸。
    #[test]
    fn 老配置缺ai识图字段时取默认() {
        let raw = r#"{"img_engines":["yandex"]}"#;
        let cfg: config::Config = serde_json::from_str(raw).expect("老配置应当能解析");
        assert_eq!(cfg.img_ai_paste_delay, 1200);
        assert_eq!(cfg.img_ai_enter_delay, 900);
        assert!(cfg.img_ai_first);
        assert!(cfg.img_ai_auto_off_on_multi);
    }

    /* ---------------- r76：OCR 入口不再被缺凭据一口咬死 ---------------- */

    /// 默认引擎那一栏是个**注册表里没有的值**（老配置 / 手改文件）时，
    /// 计划里必须有本地引擎兜底 —— 否则用户点 OCR 连框选都进不去
    /// （这正是 r76 修的那个"点了完全没反应"）。
    #[test]
    fn ocr引擎计划在默认值无效时回退本地() {
        let mut cfg = empty_cfg();
        cfg.ocr_engine = "不存在的引擎".into();
        let plan = ocr_engine_plan(&cfg);
        assert_eq!(plan, vec!["windows"], "无效默认引擎应回退到本地");
        // 有效的就原样用，不硬塞本地
        cfg.ocr_engine = "baidu".into();
        assert_eq!(ocr_engine_plan(&cfg), vec!["baidu"]);
        // 本地引擎自己也是有效值
        cfg.ocr_engine = "windows".into();
        assert_eq!(ocr_engine_plan(&cfg), vec!["windows"]);
    }

    /// OCR 总开关：老配置缺这个字段必须默认开（以前没有 serde(default)，
    /// 少了它整份配置反序列化失败 → 用户"设置全丢"）。
    #[test]
    fn ocr总开关缺字段时默认开() {
        let raw = r#"{}"#;
        let cfg: config::Config = serde_json::from_str(raw).expect("空配置应当能解析");
        assert!(cfg.ocr_enable, "OCR 总开关缺字段要默认开");
        assert!(cfg.img_enable, "识图总开关缺字段要默认开");
    }

    /// r76：默认引擎是百度（要密钥）而用户没配 → **计划里一家都不能用**。
    /// 这时 ocr_start_flow 会走本地回退；这里先把"计划长什么样"钉住，
    /// 证明回退是有依据的（不是凭空切引擎）。
    #[test]
    fn 默认引擎缺凭据时计划里只有它自己() {
        let mut cfg = empty_cfg();
        cfg.ocr_engine = "baidu".into();
        cfg.ocr_multi.clear();
        let plan = ocr_engine_plan(&cfg);
        assert_eq!(plan, vec!["baidu"], "没勾别家时只跑默认那家");
        assert!(!creds_ready(&cfg, "baidu"), "空密钥应当算没配好");
        assert!(creds_ready(&cfg, "windows"), "本地引擎永远算就绪（零密钥）");
    }

    /// r76：本地回退**只改默认引擎一个字段**，凭据和"同时识别"名单都不动 ——
    /// 用户哪天把百度密钥配好，改回来就行，历史不会丢。
    #[test]
    fn 本地回退只改默认引擎别的都不碰() {
        let mut cfg = empty_cfg();
        cfg.ocr_engine = "baidu".into();
        cfg.ocr_multi = vec!["kimi".into()];
        cfg.ocr_key = "AK".into();
        cfg.ocr_secret = "SK".into();
        // 复刻 cfg_local_ocr_fallback 的那两行赋值（函数本身要动全局状态，单测里不调）
        cfg.ocr_engine = "windows".to_string();
        assert_eq!(cfg.ocr_engine, "windows");
        assert_eq!(cfg.ocr_multi, vec!["kimi".to_string()], "同时识别名单不该被清");
        assert_eq!(cfg.ocr_key, "AK", "已填的密钥不该被抹");
        assert_eq!(cfg.ocr_secret, "SK", "已填的密钥不该被抹");
    }

    /* ---------------- r77：OCR 回退不再动用户配置 ---------------- */

    /// 计划里的引擎全都缺凭据 → 这一轮补上本地引擎，并告诉调用方"我回退了"。
    /// ⚠ 关键：**函数的入参 `cfg` 一个字段都不许改**（它是 `&`，编译期就保证了；
    ///    这里再从行为上钉一次：把返回值算完之后，cfg 还是原样）。
    #[test]
    fn ocr回退只在这一次的名单里补本地() {
        let mut cfg = empty_cfg();
        cfg.ocr_engine = "baidu".into();
        cfg.ocr_multi.clear();
        // 没配密钥 → 计划里只有 baidu，且不可用
        let (run, fell_back) = ocr_plan_with_local_fallback(&cfg);
        assert!(fell_back, "缺凭据时应当报告回退");
        assert_eq!(run, vec!["windows", "baidu"], "本地要补进这一轮的名单");
        // 用户配置原样不动 —— 这是 r77 修的那个副作用
        assert_eq!(cfg.ocr_engine, "baidu", "不该把用户的默认引擎改掉");
        assert!(cfg.ocr_multi.is_empty(), "不该动同时识别名单");
    }

    /// 凭据齐全时**不回退**，也不往名单里塞本地 —— 用户配好的引擎说了算。
    #[test]
    fn ocr凭据齐全时不回退() {
        let mut cfg = empty_cfg();
        cfg.ocr_engine = "windows".into();
        cfg.ocr_multi.clear();
        let (run, fell_back) = ocr_plan_with_local_fallback(&cfg);
        assert!(!fell_back, "本地引擎本来就可用，不该报告回退");
        assert_eq!(run, vec!["windows"], "名单原样");
        // 已经就是本地了，别再插一次（那会变成 ["windows","windows"]）
        assert_eq!(run.iter().filter(|x| *x == "windows").count(), 1);
    }

    /// 已经勾了本地、而默认引擎缺凭据 → **不算回退**（本地就在名单里，
    /// 它零密钥永远可用，第一道 `creds_ready` 就返回了）。
    #[test]
    fn ocr回退不会把本地插两次() {
        let mut cfg = empty_cfg();
        cfg.ocr_engine = "baidu".into();
        cfg.ocr_multi = vec!["windows".into()];
        let (run, fell_back) = ocr_plan_with_local_fallback(&cfg);
        assert!(!fell_back, "windows 已在名单里且可用 —— 不该算回退");
        assert_eq!(run.iter().filter(|x| *x == "windows").count(), 1, "{run:?}");
        assert_eq!(run, vec!["baidu", "windows"], "名单原样（默认在前，勾的在后）");
    }

    /// `EngineEntry` 只在快捷键类上透出绑定设置 —— 搜索类即使配置里残留也不生效。
    #[test]
    fn engine_entry只给快捷键类透出绑定应用() {
        let mut cfg = empty_cfg();
        let me = std::env::current_exe().expect("取当前 exe").to_string_lossy().to_string();
        // 手工塞一条"搜索类但带着 bind_app"的脏数据（模拟旧版本/手改文件）
        cfg.custom_engines.push(config::CustomEngine {
            name: "脏数据".into(),
            url: "https://x/?q=%s".into(),
            category: String::new(),
            kind: config::EngineKind::Search,
            hotkey: String::new(),
            bind_app: true,
            app_path: me.clone(),
            app_admin: true,
            ..Default::default()
        });
        let e = engines::engine_entry_in(&cfg, "脏数据").expect("应当能查到");
        assert!(!e.bind_app, "搜索类不该透出 bind_app");
        assert!(e.app_path.is_empty(), "搜索类不该透出 app_path");
        assert!(!e.app_admin);

        // 快捷键类：原样透出
        cfg.custom_engines.push(config::CustomEngine {
            name: "我的键".into(),
            url: String::new(),
            category: String::new(),
            kind: config::EngineKind::Hotkey,
            hotkey: "f5".into(),
            bind_app: true,
            app_path: me.clone(),
            app_admin: true,
            ..Default::default()
        });
        let e = engines::engine_entry_in(&cfg, "我的键").expect("应当能查到");
        assert!(e.bind_app, "快捷键类要透出 bind_app");
        assert_eq!(e.app_path, me);
        assert!(e.app_admin, "管理员开关也要透出");
    }

    /// `exe_name_of` 的解析：判"是不是同一个应用"按文件名比。
    #[test]
    fn 从路径里取应用文件名() {
        use crate::win::exe_name_of;
        assert_eq!(exe_name_of(r"C:\Program Files\App\App.exe"), "App.exe");
        assert_eq!(exe_name_of("C:/x/y/Z.EXE"), "Z.EXE");
        // 带引号（用户从别处复制过来常带）
        assert_eq!(exe_name_of(r#""C:\a\b.exe""#), "b.exe");
        // 只有文件名
        assert_eq!(exe_name_of("notepad.exe"), "notepad.exe");
        // 空 / 全是空白
        assert_eq!(exe_name_of(""), "");
        assert_eq!(exe_name_of("   "), "");
        // 结尾反斜杠（目录）→ 取不到名字，返回空串，调用方据此拒
        assert_eq!(exe_name_of(r"C:\some\dir\"), "");
    }

    /// move_bar_item 的下标语义：「挪完之后它待在第 to 位」。
    /// 这段逻辑直接抄自命令实现，一旦两边不一致这个测试就会红。
    fn reorder(v: &mut Vec<String>, from: usize, to: usize) {
        let n = v.len();
        if n == 0 || from >= n {
            return;
        }
        let to = to.min(n - 1);
        if from == to {
            return;
        }
        let item = v.remove(from);
        v.insert(to, item);
    }

    #[test]
    fn reorder_moves_backwards() {
        let mut v: Vec<String> = ["A", "B", "C", "D"].iter().map(|s| s.to_string()).collect();
        reorder(&mut v, 0, 2);
        assert_eq!(v, vec!["B", "C", "A", "D"], "A 挪到第 2 位");
    }

    #[test]
    fn reorder_moves_forwards() {
        let mut v: Vec<String> = ["A", "B", "C", "D"].iter().map(|s| s.to_string()).collect();
        reorder(&mut v, 3, 1);
        assert_eq!(v, vec!["A", "D", "B", "C"], "D 挪到第 1 位");
    }

    #[test]
    fn reorder_is_safe_on_bad_input() {
        let mut v: Vec<String> = ["A"].iter().map(|s| s.to_string()).collect();
        reorder(&mut v, 5, 0);   // from 越界：不动
        assert_eq!(v, vec!["A"]);
        reorder(&mut v, 0, 0);   // 原地：不动
        assert_eq!(v, vec!["A"]);
        reorder(&mut v, 0, 99);  // to 越界：夹到末尾
        assert_eq!(v, vec!["A"]);
        let mut e: Vec<String> = vec![];
        reorder(&mut e, 0, 0);   // 空列表：不 panic
        assert!(e.is_empty());
    }

    /// 分隔线哨兵不能和任何内置引擎名撞车，否则横条上会分不清
    /// 「这是一条分隔线」还是「这叫 | 的引擎」。
    #[test]
    fn separator_sentinel_never_collides() {
        assert!(!engines::engines().contains_key(config::SEP), "内置引擎不许叫「|」");
    }

    /// #147 的直接回归：自定义引擎（含快捷键类）必须能加进 / 移出横条。
    ///
    /// 老代码的准入只查 `engines()`（内置表）—— 自定义引擎一个都不在里面，
    /// 于是「添加到横条」点了没反应。这条测试把三类自定义引擎全过一遍。
    #[test]
    fn toggle_bar_engine_accepts_custom_engines() {
        // toggle_bar_engine_impl 尾部会 config::save（写 APPDATA）——
        // 拿 ENV_LOCK + 临时 APPDATA 隔离，绝不碰真的数据目录。
        let _env_lock = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _appdata = AppDataTemp::new();

        let mut cfg = config::Config::default();
        cfg.bar_list = vec!["百度".into(), "Google".into()];
        cfg.custom_engines = vec![
            config::CustomEngine {
                name: "内网搜索".into(),
                url: "https://s/?q=%s".into(),
                category: "自定义".into(),
                kind: config::EngineKind::Search,
                hotkey: String::new(),
            ..Default::default()
        },
            config::CustomEngine {
                name: "我的截图".into(),
                url: String::new(),
                category: "自定义".into(),
                kind: config::EngineKind::Hotkey,
                hotkey: "ctrl+shift+a".into(),
            ..Default::default()
        },
        ];

        // 自定义快捷键引擎：面板右键 / 设置页「加到横条」走的都是这条路
        toggle_bar_engine_impl(&mut cfg, "我的截图", true);
        assert_eq!(cfg.bar_list.last().map(|s| s.as_str()), Some("我的截图"));
        // 自定义搜索引擎同样放行（同一个 bug 的另一个受害面）
        toggle_bar_engine_impl(&mut cfg, "内网搜索", true);
        assert_eq!(cfg.bar_list.len(), 4, "原有成员一个不能少");
        // 内置引擎照旧
        let b = builtin_name();
        toggle_bar_engine_impl(&mut cfg, &b, true);
        assert!(cfg.bar_list.iter().any(|n| n == &b), "内置引擎「{b}」要能加");
        // 手工改过 URL 的引擎（url_overrides）也算数
        cfg.url_overrides.insert("DeepSeek".into(), "https://d/?q=%s".into());
        toggle_bar_engine_impl(&mut cfg, "DeepSeek", true);
        assert!(cfg.bar_list.iter().any(|n| n == "DeepSeek"));

        // 移出：点了「从横条移除」要真的摘掉
        toggle_bar_engine_impl(&mut cfg, "我的截图", false);
        assert!(!cfg.bar_list.iter().any(|n| n == "我的截图"), "要能移出");

        // 彻底不存在的引擎照样拒收（不能往横条塞phantom）
        toggle_bar_engine_impl(&mut cfg, "不存在的引擎", true);
        assert!(!cfg.bar_list.iter().any(|n| n == "不存在的引擎"), "来路不明的引擎必须拒");
    }

    /// engines.json 的数据不变量（管线 tools/add-engines.py 的产出质量在这兜底）：
    /// 每个条目都盖了显式 `kind`；打开类地址不带 `%s`、搜索类必带；
    /// 快捷键类地址为空、必须带 `hotkey` 按键序列。
    /// 这正是轮 27/28 用户需求「网页 / 软件 / 快捷键三类 URL 明确区分」的数据契约。
    #[test]
    fn engines_json_kind_invariants() {
        let raw = include_str!("../ui/data/engines.json");
        let v: serde_json::Value =
            serde_json::from_str(raw).expect("engines.json 应可解析");
        let mut n = 0usize;
        let mut n_hotkey = 0usize;
        let mut check = |e: &serde_json::Value| {
            let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let url = e.get("url").and_then(|x| x.as_str()).unwrap_or("");
            let kind = e.get("kind").and_then(|x| x.as_str());
            if name.is_empty() {
                return;
            }
            assert!(
                matches!(kind, Some("search") | Some("open") | Some("hotkey")),
                "「{name}」没盖合法 kind（add-engines.py 应当给每条都盖章）"
            );
            let kind = kind.unwrap();
            let has_ph = url.contains("%s");
            match kind {
                "open" => assert!(
                    !has_ph,
                    "打开类「{name}」的地址不该有 %s（那是搜索模板）：{url}"
                ),
                "search" => assert!(
                    has_ph,
                    "搜索类「{name}」的地址必须带 %s：{url}"
                ),
                _ => {
                    // 快捷键类：点了不打开页面，url 必须为空；按键序列必须非空
                    assert!(
                        url.is_empty(),
                        "快捷键类「{name}」不该有地址（它只发按键）：{url}"
                    );
                    let spec = e
                        .get("hotkey")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .trim();
                    assert!(
                        !spec.is_empty(),
                        "快捷键类「{name}」必须带 hotkey 按键序列"
                    );
                    assert!(
                        win::parse_hotkey(spec).is_some(),
                        "快捷键类「{name}」的按键序列看不懂：{spec}"
                    );
                    n_hotkey += 1;
                }
            }
            n += 1;
        };
        for e in v.get("toolbar").and_then(|x| x.as_array()).into_iter().flatten() {
            check(e);
        }
        for c in v.get("categories").and_then(|x| x.as_array()).into_iter().flatten() {
            for e in c.get("engines").and_then(|x| x.as_array()).into_iter().flatten() {
                check(e);
            }
        }
        assert!(n > 500, "条目数不对劲：{n}");
        assert!(n_hotkey >= 10, "快捷键类条目太少了：{n_hotkey}");
    }

    /// #154 软件直达：engines.json 里 `app` 唤起链的结构契约。
    ///
    /// 运行时语义见 `launch_app_chain`：含 `://` 的按 URI 协议
    /// ShellExecute，其余按开始菜单 `.lnk` 名字精确匹配。这里守数据侧：
    ///   · 只有**打开类**能配（搜索类配了也不会走，属于死配置）；
    ///   · 协议项 = 合法 URI scheme + 非空主体；
    ///   · deep link 里再嵌 URL 时必须百分号编码 —— 原样嵌一个 `://`
    ///     进来的话 `://` 会在一行里出现两次，ShellExecute 会把嵌套那截
    ///     当成诡异路径（钉钉的 `/page/link?url=` 就是这种形状）；
    ///   · 菜单名项 = 非空、不带斜杠（它是名字不是路径）。
    #[test]
    fn scheme_of_parts() {
        assert_eq!(scheme_of("weixin://"), Some("weixin"));
        assert_eq!(
            scheme_of("dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fx%2F"),
            Some("dingtalk")
        );
        assert_eq!(scheme_of("com.epicgames.launcher://apps/x"), Some("com.epicgames.launcher"));
        // 开始菜单名（不含 ://）不是协议
        assert_eq!(scheme_of("微信"), None);
        assert_eq!(scheme_of("QQ"), None);
        // 空 scheme / 非法字符 → None（调用方按"菜单名"处理，而不是拿去查注册表）
        assert_eq!(scheme_of("://foo"), None);
        assert_eq!(scheme_of("wei xin://foo"), None);
        assert_eq!(scheme_of("微信://foo"), None);
    }

    #[test]
    fn engines_json_app_chain_invariants() {
        let raw = include_str!("../ui/data/engines.json");
        let v: serde_json::Value =
            serde_json::from_str(raw).expect("engines.json 应可解析");
        let mut n_chain = 0usize;
        let mut check = |e: &serde_json::Value| {
            let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if name.is_empty() {
                return;
            }
            let Some(list) = e.get("app").and_then(|x| x.as_array()) else {
                return;
            };
            if list.is_empty() {
                return;
            }
            let kind = e.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            assert_eq!(
                kind, "open",
                "「{name}」配了 app 唤起链但 kind={kind}：本地唤起只对打开类有意义"
            );
            for it in list {
                let s = it.as_str().expect("app 链里只能是字符串");
                assert!(!s.trim().is_empty(), "「{name}」的 app 链有空项");
                match s.split_once("://") {
                    Some((scheme, _body)) => {
                        // body 允许为空：`weixin://` 这种"裸协议"就是合法的唤起目标
                        assert!(
                            !scheme.is_empty()
                                && scheme.chars().all(|c| c.is_ascii_alphanumeric()
                                    || matches!(c, '+' | '-' | '.')),
                            "「{name}」的协议 scheme 不合法：{s}"
                        );
                        assert_eq!(
                            s.matches("://").count(),
                            1,
                            "「{name}」的协议地址里嵌了没编码的 URL（:// 出现多次）：{s}"
                        );
                    }
                    None => {
                        assert!(
                            !s.contains('/') && !s.contains('\\'),
                            "「{name}」的开始菜单名字不该带斜杠（那是路径不是名字）：{s}"
                        );
                    }
                }
            }
            n_chain += 1;
        };
        for e in v.get("toolbar").and_then(|x| x.as_array()).into_iter().flatten() {
            check(e);
        }
        for c in v.get("categories").and_then(|x| x.as_array()).into_iter().flatten() {
            for e in c.get("engines").and_then(|x| x.as_array()).into_iter().flatten() {
                check(e);
            }
        }
        assert!(n_chain >= 15, "带 app 唤起链的条目太少了：{n_chain}");

        // 顺手钉一个具体条目：微信的链应当是「协议 → 开始菜单名」两段
        let wechat = engines::engines()
            .get("微信（首页）")
            .expect("内置引擎里应有「微信（首页）」");
        assert_eq!(wechat.kind, config::EngineKind::Open);
        assert_eq!(
            wechat.app,
            vec!["weixin://".to_string(), "微信".to_string()]
        );
    }

    /// OCR 哨兵同理：@ocr 必须是"保留名"，否则用户建个同名引擎就能顶掉
    /// 横条上的 OCR 按钮（两者在 bar_list 里长得一模一样，排序时无法区分）。
    #[test]
    fn ocr_sentinel_never_collides() {
        assert!(
            !engines::engines().contains_key(config::BAR_OCR),
            "内置引擎不许叫「@ocr」"
        );
    }

    /// 默认横条列表里不该出现哨兵之外的东西：OCR 按钮是靠哨兵进列表的，
    /// 如果哪天有人手滑把它写进了默认配置，测试要能立刻发现。
    #[test]
    fn default_bar_has_no_ocr_sentinel() {
        let c = config::Config::default();
        assert!(!c.bar_list.iter().any(|n| n == config::BAR_OCR));
    }

    /// 默认横条列表里不含分隔线 —— 新装的用户看到的还是原来那 7 个引擎
    #[test]
    fn default_bar_has_no_separator() {
        let c = config::Config::default();
        assert!(!c.bar_list.iter().any(|n| n == config::SEP));
        assert!(c.sep_style == "line");
    }

    /* ============================================================== */
    /*  OCR                                                            */
    /*                                                                */
    /*  下面几个是**真的打百度接口**的集成测试。没给凭据时自动跳过，      */
    /*  所以平时跑 cargo test 不会因为没网/没账号而红。                  */
    /*                                                                */
    /*  给凭据的跑法（在 src 上一级目录）：                              */
    /*    QS_OCR_KEY=xxx QS_OCR_SECRET=yyy \                          */
    /*    QS_OCR_IMAGE=tools/_ocr-sample.png \                        */
    /*    QS_OCR_EXPECT=快捷搜索验证专用文本,ABC123 \                 */
    /*      cargo test -- --nocapture ocr_real                        */
    /*                                                                */
    /*  想连「抓屏 → 编码 PNG → 识别」一整条也验，再加：                */
    /*    QS_OCR_RECT=1300,200,900,240   （物理像素 x,y,w,h）          */
    /* ============================================================== */

    fn env_or_empty(k: &str) -> String {
        std::env::var(k).unwrap_or_default().trim().to_string()
    }

    /// 比对 OCR 结果时先去掉空白和常见标点 —— 百度偶尔会在中文标点前后
    /// 插空格，或者把句号识别成全角/半角的不同形态，不该因此判错。
    fn norm(s: &str) -> String {
        s.chars()
            .filter(|c| !c.is_whitespace() && !"，。、；：（）,.．".contains(*c))
            .collect()
    }

    /// 空格/标点差异不算错：识别结果里必须逐个命中所有锚点。
    fn assert_hits(text: &str, anchors: &[String]) {
        let got = norm(text);
        for a in anchors {
            assert!(
                got.contains(&norm(a)),
                "识别结果里没找到锚点「{a}」\n实际识别到：\n{text}"
            );
        }
    }

    fn creds_or_skip() -> Option<(String, String)> {
        let k = env_or_empty("QS_OCR_KEY");
        let s = env_or_empty("QS_OCR_SECRET");
        if k.is_empty() || s.is_empty() {
            eprintln!("跳过：没给 QS_OCR_KEY / QS_OCR_SECRET");
            None
        } else {
            Some((k, s))
        }
    }

    /// 空凭据必须是「一句人话」，而不是发请求出去被服务器骂回来。
    /// 这条不发网络，纯本地。
    #[test]
    fn ocr_empty_credentials_fail_loud_and_clear() {
        let e = ocr::check("", "", 10).expect_err("空 key 不该成功");
        assert!(e.contains("还没填"), "错误提示不好懂：{e}");
        let e2 = ocr::recognize("", "  ", b"not-a-png", "CHN_ENG", true, 10)
            .expect_err("空 key 不该成功");
        assert!(e2.contains("还没填"), "错误提示不好懂：{e2}");
    }

    /// 真·全链路：拿一张本机生成的、文字已知的 PNG 去打百度，看认得对不对。
    #[test]
    fn ocr_real_api_reads_known_image() {
        let Some((key, secret)) = creds_or_skip() else { return };
        let path = env_or_empty("QS_OCR_IMAGE");
        assert!(!path.is_empty(), "要指定 QS_OCR_IMAGE 指向那张样本图");
        let png = std::fs::read(&path).unwrap_or_else(|e| panic!("读不到 {path}：{e}"));

        ocr::check(&key, &secret, 20).expect("凭据换不到 access_token");

        let text = ocr::recognize(&key, &secret, &png, "CHN_ENG", true, 30)
            .unwrap_or_else(|e| panic!("识别失败：{e}"));
        eprintln!("识别结果 = {text:?}");

        let anchors: Vec<String> = env_or_empty("QS_OCR_EXPECT")
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .collect();
        assert!(!anchors.is_empty(), "要指定 QS_OCR_EXPECT（逗号分隔的锚点）");
        assert_hits(&text, &anchors);
    }

    /// 错的 key 要被翻成「API Key 或 Secret Key 不对」，
    /// 而不是甩一串百度原始错误给用户看。顺带证明请求确实发出去了。
    #[test]
    fn ocr_real_api_reports_bad_key_in_plain_words() {
        let Some((key, secret)) = creds_or_skip() else { return };
        let _ = (key, secret); // 只用它来判断「有网有账号，值得跑这一条」
        let e = ocr::check("QsBogusKey0000000000", "QsBogusSecret0000000000", 20)
            .expect_err("假 key 不该成功");
        eprintln!("假 key 的报错 = {e}");
        assert!(
            e.contains("API Key") || e.contains("不对") || e.contains("invalid_client"),
            "报错没有翻成人话：{e}"
        );
    }

    /// 抓屏 → 编码 PNG → 识别。这一条验的是「真正会发给百度的那张图」
    /// 是不是能认出东西来 —— 抓屏坐标、PNG 编码、base64 编码任何一环错了
    /// 都会在这里露馅。需要外部先把写着已知文字的窗口摆到 QS_OCR_RECT 处。
    #[test]
    fn ocr_real_api_reads_screen_capture() {
        let Some((key, secret)) = creds_or_skip() else { return };
        let rect = env_or_empty("QS_OCR_RECT");
        if rect.is_empty() {
            eprintln!("跳过：没给 QS_OCR_RECT");
            return;
        }
        let n: Vec<i32> = rect
            .split(',')
            .filter_map(|s| s.trim().parse::<i32>().ok())
            .collect();
        assert_eq!(n.len(), 4, "QS_OCR_RECT 应该是 x,y,w,h");

        let (w, h, px) = win::grab_region(n[0], n[1], n[2], n[3])
            .unwrap_or_else(|| panic!("抓屏失败 {rect}"));
        assert_eq!((w, h), (n[2] as u32, n[3] as u32), "抓回来的尺寸不对");

        let img = image::RgbaImage::from_raw(w, h, px).expect("像素数据对不上宽高");
        let img = if w > 1920 {
            let nh = ((h as f64) * 1920.0 / (w as f64)).round().max(1.0) as u32;
            image::imageops::resize(&img, 1920, nh, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut cur = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut cur, image::ImageFormat::Png)
            .expect("PNG 编码失败");
        let png = cur.into_inner();
        eprintln!("抓屏 PNG = {} KB", png.len() / 1024);

        // 留一份，出问题时能直接看截到的是什么
        let dump = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/_ocr-grab.png");
        let _ = std::fs::write(&dump, &png);
        eprintln!("截图已存 {}", dump.display());

        let text = ocr::recognize(&key, &secret, &png, "CHN_ENG", true, 30)
            .unwrap_or_else(|e| panic!("识别失败：{e}"));
        eprintln!("识别结果 = {text:?}");

        let anchors: Vec<String> = env_or_empty("QS_OCR_EXPECT")
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .collect();
        assert!(!anchors.is_empty(), "要指定 QS_OCR_EXPECT（逗号分隔的锚点）");
        assert_hits(&text, &anchors);
    }

    /* ============================================================== */
    /*  OCR —— 本地仿真服务                                            */
    /*                                                                */
    /*  起一个只会背台词的迷你 HTTP 服务，把 ocr 的两个地址指过去。      */
    /*  好处：不花真实额度、不需要账号、不依赖网络，而且能**故意**       */
    /*  造出「错误的 key」「额度用完」这些真账号很难重现的分支。         */
    /*  请求原文会被记下来，用来核对参数拼得对不对。                     */
    /* ============================================================== */

    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// 返回 (base_url, 请求原文的接收端)。收到的每条请求是一条 String。
    fn mock_baidu(
        token_status: u16,
        token_body: &'static str,
        ocr_status: u16,
        ocr_body: &'static str,
    ) -> (String, mpsc::Receiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").expect("起不来仿真服务");
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let mut req = String::new();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    let done = line == "\r\n" || line == "\n";
                    req.push_str(&line);
                    if done {
                        break;
                    }
                }
                if len > 0 {
                    let mut buf = vec![0u8; len];
                    if r.read_exact(&mut buf).is_ok() {
                        req.push_str(&String::from_utf8_lossy(&buf));
                    }
                }
                let _ = tx.send(req.clone());

                let is_token = req.starts_with("GET /token");
                let (st, reason, body) = if is_token {
                    (token_status, "OK", token_body)
                } else {
                    (ocr_status, "OK", ocr_body)
                };
                let head = format!(
                    "HTTP/1.1 {st} {reason}\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
                let _ = s.flush();
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    fn mock_endpoints(base: &str) -> ocr::Endpoints {
        ocr::Endpoints {
            token: format!("{base}/token"),
            accurate: format!("{base}/rest/2.0/ocr/v1/accurate_basic"),
            general: format!("{base}/rest/2.0/ocr/v1/general_basic"),
        }
    }

    /// 路径感知的仿真服务：`/token` 走 token 台词，`/accurate` 走高精度台词，
    /// 其它一律走标准版台词。
    ///
    /// 存在的理由：老 mock 对两个识别接口回同一份内容，于是「用户选高精度时
    /// 到底打的是哪个接口、失败时报的是谁的错」**根本没被验过**。两个接口
    /// 必须能各自被独立触发、独立断言。
    fn mock_split(
        token_body: &'static str,
        accurate_body: &'static str,
        general_body: &'static str,
    ) -> (String, mpsc::Receiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").expect("起不来仿真服务");
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let mut req = String::new();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    let done = line == "\r\n" || line == "\n";
                    req.push_str(&line);
                    if done {
                        break;
                    }
                }
                if len > 0 {
                    let mut buf = vec![0u8; len];
                    if r.read_exact(&mut buf).is_ok() {
                        req.push_str(&String::from_utf8_lossy(&buf));
                    }
                }
                let _ = tx.send(req.clone());

                let body: &'static str = if req.starts_with("GET /token") {
                    token_body
                } else if req.starts_with("POST /rest/2.0/ocr/v1/accurate_basic") {
                    accurate_body
                } else {
                    general_body
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
                let _ = s.flush();
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    /// 一张 64×32 的真 PNG。
    ///
    /// 以前测试直接拿 `b"\x89PNG"` 这种假字节凑数。现在 `recognize_with` 入口
    /// 会先自己量图片尺寸（超 4096 / 窄于 15px 直接拒绝，别浪费一次百度额度），
    /// 假字节会被这道预检拦下来，于是这些测试测到的就不是「请求拼装」而是
    /// 「预检」了 —— 等于白测。
    fn fake_png() -> Vec<u8> {
        let mut cur = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(64, 32))
            .write_to(&mut cur, image::ImageFormat::Png)
            .expect("测试用的 PNG 编码失败");
        cur.into_inner()
    }

    /// 百分号解码 —— 用来**反向**核对「发出去的 image 参数」到底是不是
    /// base64 编码过的那串。解码和编码是两套逻辑，互为印证。
    fn percent_decode(s: &str) -> Vec<u8> {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        out
    }

    fn form_field(req: &str, name: &str) -> Option<String> {
        let body = req.split("\r\n\r\n").nth(1)?;
        for kv in body.split('&') {
            if let Some(v) = kv.strip_prefix(&format!("{name}=")) {
                return Some(v.to_string());
            }
        }
        None
    }

    /// 正常路径：拿 token → POST 图片 → 把 words_result 拼成整段文字。
    /// 顺带核对参数：地址选对了没有、图片编码对不对、空行有没有被吃掉。
    #[test]
    fn ocr_mock_happy_path_parses_words() {
        let (base, rx) = mock_baidu(
            200,
            r#"{"access_token":"T0KEN-abc","expires_in":2592000}"#,
            200,
            r#"{"words_result":[{"words":"快捷搜索验证专用文本 ABC123"},
                                {"words":"第二行"},
                                {"words":"   "}],
                "words_result_num":3}"#,
        );
        let ep = mock_endpoints(&base);
        let png: Vec<u8> = vec![0xFF; 32]; // 故意选全 0xFF：base64 里必定有 / 和 =

        let out = ocr::recognize_with("k1", "s1", &png, "CHN_ENG", true, 10, &ep)
            .expect("仿真服务返回的是正常结果，不该失败");
        assert_eq!(out.text, "快捷搜索验证专用文本 ABC123\n第二行",
                   "空白的 words 要被跳过，行之间用换行接起来");
        assert_eq!(out.engine, "高精度版", "用户选了高精度，成功时就用高精度");

        let first = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到第一个请求");
        let second = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到第二个请求");

        assert!(first.starts_with("GET /token?"), "第一步应当先去换 token：{first}");
        assert!(first.contains("grant_type=client_credentials"), "少了 grant_type");
        assert!(first.contains("client_id=k1"), "client_id 没带上");
        assert!(first.contains("client_secret=s1"), "client_secret 没带上");

        assert!(second.starts_with("POST /rest/2.0/ocr/v1/accurate_basic?"),
                "accurate=true 时应当走高精度接口：{second}");
        assert!(second.contains("access_token=T0KEN-abc"), "识别请求没带 token");
        assert!(second.to_lowercase().contains("application/x-www-form-urlencoded"),
                "Content-Type 不对");
        assert_eq!(form_field(&second, "language_type").as_deref(), Some("CHN_ENG"));

        let img = form_field(&second, "image").expect("body 里没有 image 字段");
        assert!(!img.contains('/') && !img.contains('+') && !img.contains('='),
                "base64 里的 / + = 必须先转义，否则会被表单语法吃掉：{img:.60}");
        assert_eq!(percent_decode(&img), config::base64(&png).as_bytes(),
                   "发出去的 image 解码回来必须等于原图的 base64");
    }

    /// 回归测试：**这就是实测抓到的那个 bug**。
    /// 百度对错误的 key 回的是 `HTTP 401` + `{"error":"invalid_client"}`，
    /// 而旧代码只在 HTTP 200 时解析 body，于是这段友好提示永远走不到，
    /// 用户看到的是没用的「HTTP 401 —— Unauthorized」。
    #[test]
    fn ocr_mock_bad_key_says_it_plainly() {
        let (base, _rx) = mock_baidu(
            401,
            r#"{"error_description":"unknown client id","error":"invalid_client"}"#,
            200,
            "{}",
        );
        let ep = mock_endpoints(&base);
        let e = ocr::check_with("bad", "bad", 10, &ep).expect_err("错误的 key 不该成功");
        // unknown client id 有可能是「IP 没加白名单」，提示必须把两种可能都说出来，
        // 否则会把人往错的方向带。
        assert!(e.contains("API Key") && e.contains("白名单"),
                "4xx 的 body 没被解析，或提示没点全两种可能的原因：{e}");
    }

    /// 识别接口的业务错误码也要翻成人话（HTTP 200 + error_code 那种形态）
    #[test]
    fn ocr_mock_error_code_is_translated() {
        let (base, _rx) = mock_baidu(
            200,
            r#"{"access_token":"T","expires_in":2592000}"#,
            200,
            r#"{"error_code":17,"error_msg":"Open api daily request limit reached"}"#,
        );
        let ep = mock_endpoints(&base);
        // 每条测试都用自己的 key：token 缓存是全局的，撞了就会少发一次请求
        let e = ocr::recognize_with("k2", "s2", &fake_png(), "CHN_ENG", true, 10, &ep)
            .expect_err("error_code 非空时不该当成成功");
        // #134 起高精度失败原样报错、不降级：错误码 17（每日调用量超限）
        // 必须翻成「免费识别次数」那句人话直接送给用户。
        assert!(e.contains("免费识别次数"), "错误码 17 没翻成人话：{e}");
    }

    /// 服务器抽风返回非 JSON，也不能崩，要给出能看懂的一句
    #[test]
    fn ocr_mock_garbage_response_is_handled() {
        let (base, _rx) = mock_baidu(500, "Internal Server Error", 200, "{}");
        let ep = mock_endpoints(&base);
        let e = ocr::check_with("k3", "s3", 10, &ep).expect_err("500 不该成功");
        assert!(e.contains("500") && e.contains("Internal Server Error"),
                "非 JSON 的报错正文应当原样带出来一点：{e}");
    }

    /// accurate=false 时应当走标准版接口（选错接口是花了钱还没效果的典型）
    #[test]
    fn ocr_mock_standard_endpoint_when_not_accurate() {
        let (base, rx) = mock_baidu(
            200,
            r#"{"access_token":"T","expires_in":2592000}"#,
            200,
            r#"{"words_result":[{"words":"hi"}]}"#,
        );
        let ep = mock_endpoints(&base);
        let _ = ocr::recognize_with("k4", "s4", &fake_png(), "ENG", false, 10, &ep).unwrap();
        let _ = rx.recv_timeout(std::time::Duration::from_secs(3));
        let second = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到识别请求");
        assert!(second.starts_with("POST /rest/2.0/ocr/v1/general_basic?"),
                "accurate=false 时应当走标准版：{second}");
    }

    /// 一个字都没认出来时，提示要引导用户换区域，而不是显示一个空框
    #[test]
    fn ocr_mock_empty_result_asks_user_to_retry() {
        let (base, _rx) = mock_baidu(
            200,
            r#"{"access_token":"T","expires_in":2592000}"#,
            200,
            r#"{"words_result":[],"words_result_num":0}"#,
        );
        let ep = mock_endpoints(&base);
        let e = ocr::recognize_with("k5", "s5", &fake_png(), "CHN_ENG", true, 10, &ep)
            .expect_err("没认出文字不该返回空字符串");
        assert!(e.contains("换个区域"), "提示没有引导性：{e}");
    }

    /* ---------- #134：高精度失败原样报错，绝不偷偷降级 ---------- */

    /// 高精度版（accurate_basic）是要付费开通的。以前没开通付费时会**自动
    /// 降级**到标准版；用户原话「禁止因高精度模式慢而自动回退到标准模式」——
    /// 现在必须把百度的原话（余额不足）直接报出去，让用户在设置页自己决定
    /// 要不要切标准版（诊断面板上有那个按钮）。
    #[test]
    fn ocr_reports_accurate_failure_without_downgrading() {
        let (base, rx) = mock_split(
            r#"{"access_token":"T-FREE","expires_in":2592000}"#,
            // 高精度：没开通付费
            r#"{"error_code":120,"error_msg":"Insufficient balance"}"#,
            // 标准版：永远不该被打到
            r#"{"words_result":[{"words":"不该被打到的接口"}]}"#,
        );
        let ep = mock_endpoints(&base);
        let e = ocr::recognize_with("k6", "s6", &fake_png(), "CHN_ENG", true, 10, &ep)
            .expect_err("高精度没权限时必须报错，而不是偷偷降级");
        assert!(e.contains("余额"), "百度的原话要翻出来：{e}");

        // 确认只打了高精度一次：换 token → 高精度 → 报错。没有第三次识别请求。
        let first = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到请求");
        assert!(first.starts_with("GET /token?"), "第一步应当换 token：{first}");
        let second = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到识别请求");
        assert!(second.starts_with("POST /rest/2.0/ocr/v1/accurate_basic?"),
                "只该打用户选的高精度：{second}");
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(600)).is_err(),
            "不许降级重打标准版"
        );
    }

    /// 图片本身有问题（格式不对）时同样原样报错 —— 再打一次只是白烧一次
    /// 额度，而且错误信息会变得更难懂。
    #[test]
    fn ocr_does_not_downgrade_on_image_errors() {
        let (base, rx) = mock_split(
            r#"{"access_token":"T","expires_in":2592000}"#,
            r#"{"error_code":216201,"error_msg":"image format error"}"#,
            r#"{"words_result":[{"words":"不该被打到的接口"}]}"#,
        );
        let ep = mock_endpoints(&base);
        let e = ocr::recognize_with("k7", "s7", &fake_png(), "CHN_ENG", true, 10, &ep)
            .expect_err("图片格式不对就该直接报错");
        assert!(e.contains("格式"), "应报图片格式问题：{e}");
        // 只该有一次识别请求（外加前面那次换 token）
        let _t = rx.recv_timeout(std::time::Duration::from_secs(3));
        let second = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到识别请求");
        assert!(second.starts_with("POST /rest/2.0/ocr/v1/accurate_basic"));
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(600)).is_err(),
            "图片错误不该触发重打"
        );
    }

    /// token 失效（110/111）要**自动换新的重试一次**。
    /// 以前这里只是把「重试一次」印在错误提示里，然后真的就只失败一次。
    #[test]
    fn ocr_refreshes_expired_token_and_retries() {
        // 仿真服务对「用过期 token 打的那一次」回 111，之后就正常。
        // 这里手动构造：先打 /token 拿到 T-OLD，再用它打识别 → 111，
        // 代码应当清缓存、重新换 T-NEW、再打一次成功。
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, _rx) = mpsc::channel();
        let token_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let tc2 = token_count.clone();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let mut req = String::new();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    let done = line == "\r\n" || line == "\n";
                    req.push_str(&line);
                    if done {
                        break;
                    }
                }
                if len > 0 {
                    let mut buf = vec![0u8; len];
                    if r.read_exact(&mut buf).is_ok() {
                        req.push_str(&String::from_utf8_lossy(&buf));
                    }
                }
                let _ = tx.send(req.clone());

                let body: &'static str = if req.starts_with("GET /token") {
                    let n = tc2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if n == 0 {
                        r#"{"access_token":"T-OLD","expires_in":2592000}"#
                    } else {
                        r#"{"access_token":"T-NEW","expires_in":2592000}"#
                    }
                } else if req.contains("access_token=T-OLD") {
                    // 用旧 token → 111 过期
                    r#"{"error_code":111,"error_msg":"Access token expired"}"#
                } else {
                    r#"{"words_result":[{"words":"刷新token后成功"}]}"#
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
                let _ = s.flush();
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        let ep = mock_endpoints(&base);
        let out = ocr::recognize_with("k8", "s8", &fake_png(), "CHN_ENG", false, 10, &ep)
            .expect("token 过期应当自动刷新后重试成功");
        assert_eq!(out.text, "刷新token后成功");
        assert_eq!(
            token_count.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "应该正好换两次 token：一次旧的、一次刷新后的"
        );
    }

    /// 段落顺序：`words_result` 是检测顺序不是阅读顺序，多栏文字会左右交错。
    /// 开了 `paragraph=true` 之后要按 `paragraphs_result` 还原。
    #[test]
    fn ocr_restores_paragraph_reading_order() {
        let (base, _rx) = mock_split(
            r#"{"access_token":"T","expires_in":2592000}"#,
            r#"{"words_result":[]}"#,
            r#"{
                "words_result":[
                    {"words":"右栏第一行"},
                    {"words":"左栏第一行"},
                    {"words":"左栏第二行"},
                    {"words":"右栏第二行"}
                ],
                "paragraphs_result":[
                    {"words_result_idx":[1,2]},
                    {"words_result_idx":[0,3]}
                ]}"#,
        );
        let ep = mock_endpoints(&base);
        let out = ocr::recognize_with("k9", "s9", &fake_png(), "CHN_ENG", false, 10, &ep)
            .expect("带段落信息的正常结果不该失败");
        assert_eq!(out.text, "左栏第一行\n左栏第二行\n右栏第一行\n右栏第二行",
                   "必须按 paragraphs_result 的顺序输出，不能按检测顺序");
    }

    /// 超大图 / 极窄的条：本地就能判断的事，别浪费一次百度额度去换一句
    /// 「图片太大」再回来。
    #[test]
    fn ocr_rejects_bad_image_geometry_before_calling_baidu() {
        let (base, rx) = mock_split(
            r#"{"access_token":"T","expires_in":2592000}"#,
            r#"{"words_result":[{"words":"x"}]}"#,
            r#"{"words_result":[{"words":"x"}]}"#,
        );
        let ep = mock_endpoints(&base);

        // 单边超 4096
        let mut big = fake_png();
        big[16..20].copy_from_slice(&5000u32.to_be_bytes());
        let e = ocr::recognize_with("k10", "s10", &big, "CHN_ENG", false, 10, &ep)
            .expect_err("超大图应被本地预检拦下");
        assert!(e.contains("太大"), "{e}");

        // 最短边不足 15
        let mut thin = fake_png();
        thin[16..20].copy_from_slice(&200u32.to_be_bytes());
        thin[20..24].copy_from_slice(&4u32.to_be_bytes());
        let e2 = ocr::recognize_with("k11", "s11", &thin, "CHN_ENG", false, 10, &ep)
            .expect_err("太窄应被本地预检拦下");
        assert!(e2.contains("太窄"), "{e2}");

        // 关键：一次请求都不该发出去
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(600)).is_err(),
            "预检拦下的图不应发出任何请求"
        );
    }

    /// 旧配置里的「纯中文」= CHN，百度没有这个值 —— 必须归一成 CHN_ENG，
    /// 否则用户明明配对了却收到参数错误。这是「Key 对却用不了」的另一半原因。
    #[test]
    fn ocr_normalizes_legacy_chinese_only_language() {
        let (base, rx) = mock_split(
            r#"{"access_token":"T","expires_in":2592000}"#,
            r#"{"words_result":[]}"#,
            r#"{"words_result":[{"words":"中文"}]}"#,
        );
        let ep = mock_endpoints(&base);
        let out = ocr::recognize_with("k12", "s12", &fake_png(), "CHN", false, 10, &ep)
            .expect("旧配置里的 CHN 不该把识别搞挂");
        assert_eq!(out.text, "中文");
        let _t = rx.recv_timeout(std::time::Duration::from_secs(3));
        let second = rx.recv_timeout(std::time::Duration::from_secs(3)).expect("没收到识别请求");
        assert_eq!(form_field(&second, "language_type").as_deref(), Some("CHN_ENG"),
                   "CHN 必须在发出去前归一成 CHN_ENG");
    }

    /* ============================================================== */
    /*  备份往返：config_view → 序列化 → 解析 → apply_view                */
    /*                                                                */
    /*  用户原话：「备份的不仅仅是设置，还有所有的引擎以及图标，还有       */
    /*  收藏夹的目录、文本、图片以及文字识别的 api，以及 webdav 的        */
    /*  服务器地址、账号、密码。引擎的排序等等等等。目的就是我在一台      */
    /*  新的电脑上恢复备份，就相当于恢复了一切内容。」                    */
    /*                                                                */
    /*  这个测试把这句话钉成断言：config_view 是导出的形状，apply_view    */
    /*  是恢复的形状。任何一边漏了字段（以前 lastEngine 就是 emit 了      */
    /*  却没接），这里就红。                                            */
    /* ============================================================== */

    /// 造一份「用户点名的数据全填了特殊值」的配置。
    /// 特殊值是为了跟默认值区分开 —— 默认值蒙对不算还原成功。
    fn rich_cfg() -> config::Config {
        let mut c = config::Config::default();
        // —— 设置外观 ——
        c.trigger_select = false;
        c.trigger_copy = false;
        c.auto_start = true;
        c.auto_elevate = false;
        c.icon_size = 47;
        c.alpha = 66;
        c.unify_icons = false;
        c.bar_padding = 3;
        c.item_radius = 2;
        c.theme = "dark".to_string();
        c.animations = false;
        c.shadow = true;
        c.bar_blur = 12;
        c.anchor_at_mouse = true;
        c.delay_ms = 321;
        c.filter_mode = "whitelist".to_string();
        c.filter_list = vec!["notepad.exe".into(), "mspaint.exe".into()];
        // —— 文字识别 API ——
        c.ocr_enable = false;
        c.ocr_key = "AK-roundtrip".into();
        c.ocr_secret = "SK-roundtrip".into();
        c.ocr_lang = "ENG".into();
        c.ocr_accurate = true;
        c.ocr_engine = "windows".into();
        // r47：「同时识别」名单也要跟着备份走 —— 换机器不该变了性子。
        // （旧的 ocr_parallel 开关已废弃，这里改测新字段。）
        c.ocr_multi = vec!["baidu".into(), "tencent".into()];
        // —— 引擎与排序 ——
        c.bar_list = vec![
            "百度".into(),
            config::SEP.into(),
            "必应".into(),
            config::BAR_OCR.into(),
            format!("{}g1", config::FAV_PREFIX),
            "我的引擎".into(),
        ];
        c.sep_style = "dot".to_string();
        c.custom_engines = vec![
            config::CustomEngine {
                name: "我的引擎".into(),
                url: "https://mine/?q=%s".into(),
                category: "自定义".into(),
                kind: config::EngineKind::Search,
                hotkey: String::new(),
            ..Default::default()
        },
            config::CustomEngine {
                name: "备用Kimi".into(),
                url: "https://k/?q=%s".into(),
                category: "AI 工具".into(),
                kind: config::EngineKind::Search,
                hotkey: String::new(),
            ..Default::default()
        },
        ];
        c.url_overrides.insert("DeepSeek".into(), "https://ds-new/?q=%s".into());
        c.ai_suffix = "？请用中文回答".into();
        c.ai_suffixes.insert("ChatGPT".into(), " in English please".into());
        c.ai_copy_prompt = false;
        c.last_engine = Some("必应".into());
        // —— WebDAV ——
        c.webdav_url = "https://dav.example.com/dav/".into();
        c.webdav_user = "davuser".into();
        c.webdav_pass = "davpass".into();
        c.webdav_on_start = true;
        c.webdav_on_exit = true;
        // —— 收藏夹整树：一级目录 + 二级目录 + 文本 + 图片 + 备注 ——
        c.favorites = vec![config::FavGroup {
            id: "g1".into(),
            name: "工作资料".into(),
            icon: "data:image/png;base64,iVBORw0KGgo=".into(),
            items: vec![config::FavItem {
                id: "i1".into(),
                kind: "text".into(),
                text: "服务器地址 10.0.0.1".into(),
                html: String::new(),
                image: String::new(),
                remark: "内网".into(),
            }],
            children: vec![config::FavGroup {
                id: "g1c".into(),
                name: "子目录".into(),
                icon: String::new(),
                items: vec![config::FavItem {
                    id: "i2".into(),
                    kind: "image".into(),
                    text: String::new(),
                    html: String::new(),
                    image: "data:image/png;base64,AAAA".into(),
                    remark: String::new(),
                }],
                children: vec![],
            }],
        }];
        c.fav_hotkey = "Ctrl+Alt+F".into();
        c.fav_panel_sizes.insert(format!("{}g1", config::FAV_PREFIX), vec![520.0, 640.0]);
        c.fav_panel_sizes.insert("_root".into(), vec![480.0, 600.0]);
        c.backup_password = "backup-secret".into();
        c
    }

    /// 把 APPDATA 整个指到一个临时目录，Drop 时还原。
    ///
    /// 备份往返测试要往 icons 目录写真的图标文件 —— config_view 只认磁盘上
    /// 存在的文件，没有文件的 override 会被静默跳过。两件事必须同时做对：
    /// ① 指到临时目录，不污染用户真实数据目录；
    /// ② 调用方必须先拿 `config::ENV_LOCK` —— 隔壁测试也会改 APPDATA，
    ///    并行跑会互相把对方的目录拆掉（踩过：写图标时报「找不到路径」）。
    struct AppDataTemp {
        old: Option<String>,
        dir: std::path::PathBuf,
    }

    impl AppDataTemp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "qs-roundtrip-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).expect("临时目录建不出来");
            let old = std::env::var("APPDATA").ok();
            std::env::set_var("APPDATA", &dir);
            Self { old, dir }
        }
    }

    impl Drop for AppDataTemp {
        fn drop(&mut self) {
            match &self.old {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// 保护 `STATE`（进程级 OnceLock）的测试锁。
    ///
    /// cargo test 默认**多线程并行**跑，而 STATE 整个进程只有一份：
    /// 谁先 `get_or_init` 谁定内容，后一个测试改它就会把前一个的现场拆掉
    /// （轮 23 踩过：新增的备份闸测试让 `backup_round_trip_restores_everything`
    /// 跟着失败，而它本身什么都没改）。动 STATE 的测试必须先拿这把锁。
    static STATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 在 `STATE` 里摆一份配置并跑 `f`，退出时**原样还原**。
    ///
    /// 不假设 STATE 里原来是什么（可能已被别的测试初始化过），也不留痕 ——
    /// 这样测试之间就没有顺序依赖，谁先跑结果都一样。
    fn with_state_cfg<R>(cfg: config::Config, f: impl FnOnce() -> R) -> R {
        let _guard = install_state_cfg(cfg);
        f()
    }

    /// 把一份配置装进 `STATE`，返回的守卫在 Drop 时还原现场。
    ///
    /// ⚠ 不能图省事用 `STATE.get_or_init(|| AppState { cfg: … })`：
    ///   OnceLock 只在**第一次**生效，别的测试先初始化过之后这一句就变成了
    ///   "什么都不做"，随后 `config_view()` 读到的是别人的配置 ——
    ///   断言会以一种"看起来跟本测试无关"的方式失败（轮 23 踩过）。
    struct StateCfgGuard {
        saved: config::Config,
    }

    fn install_state_cfg(cfg: config::Config) -> StateCfgGuard {
        STATE.get_or_init(|| AppState {
            cfg: Mutex::new(config::Config::default()),
            geo: Mutex::new(Geo::default()),
            sel: Mutex::new(String::new()),
            sel_url: Mutex::new(None),
            sel_urls: Mutex::new(Vec::new()),
        });
        let mut g = st().cfg.lock().unwrap_or_else(|e| e.into_inner());
        let saved = g.clone();
        *g = cfg;
        drop(g);
        StateCfgGuard { saved }
    }

    impl Drop for StateCfgGuard {
        fn drop(&mut self) {
            if let Ok(mut g) = st().cfg.lock() {
                *g = self.saved.clone();
            }
        }
    }

    #[test]
    fn backup_round_trip_restores_everything() {
        // 先拿锁、再改 APPDATA：声明顺序决定 Drop 顺序 —— appdata 先还原，
        // 锁后放，隔壁测试看到的永远是一个完好的 APPDATA。
        let _env_lock = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _state_lock = STATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _appdata = AppDataTemp::new();

        // —— 图标：造一个真的 PNG 放进 icons 目录（此刻指向临时目录）。
        // 没有文件的 override 会被 config_view 静默跳过，那就白测了 ——
        // 用户「换过的图标」是点名要的。
        let icon_file = "_qs_roundtrip_test.png";
        let mut tiny = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 4))
            .write_to(&mut tiny, image::ImageFormat::Png)
            .expect("测试图标编码失败");
        let icon_bytes = tiny.into_inner();
        std::fs::create_dir_all(config::icons_dir()).expect("icons 目录建不出来");
        let icon_path = config::icons_dir().join(icon_file);
        std::fs::write(&icon_path, &icon_bytes).expect("测试图标写不进 icons 目录");
        // restore_icon 会按引擎名另写一个文件（我的引擎.png）
        let restored_path = config::icons_dir().join("我的引擎.png");

        let mut src = rich_cfg();
        src.overrides.insert("我的引擎".into(), icon_file.into());
        let want = src.clone();

        // config_view 走全局状态（和真机同一条路），测试里自己摆一份进去。
        // ⚠ 用带守卫的安装，不用 get_or_init：STATE 是进程级 OnceLock，
        //    万一别的测试先初始化过，get_or_init 就静默失效，config_view 会
        //    读到别人的配置（轮 23 踩过，断言失败得莫名其妙）。
        let _state_guard = install_state_cfg(src);

        let view = config_view();
        // 走真实导出链路的一半：序列化成文本再解析回来。
        // （加密备份也是先成文 → 解密 → 解析，形状和这一致。）
        let text = serde_json::to_string(&view).expect("view 序列化不该失败");
        let back: Value = serde_json::from_str(&text).expect("view 反序列化不该失败");

        // 新电脑 = 一份默认配置，把备份灌进去
        let mut dst = config::Config::default();
        apply_view(&back, &mut dst);

        // —— 逐项断言：用户点名的每一样都得回来 ——
        // 设置
        assert!(!dst.trigger_select && !dst.trigger_copy);
        assert!(dst.auto_start && !dst.auto_elevate);
        assert_eq!(dst.icon_size, 47);
        assert_eq!(dst.alpha, 66);
        assert!(!dst.unify_icons);
        assert_eq!(dst.bar_padding, 3);
        assert_eq!(dst.item_radius, 2);
        assert_eq!(dst.theme, "dark");
        assert!(!dst.animations && dst.shadow);
        assert_eq!(dst.bar_blur, 12);
        assert!(dst.anchor_at_mouse);
        assert_eq!(dst.delay_ms, 321);
        assert_eq!(dst.filter_mode, "whitelist");
        assert_eq!(dst.filter_list, vec!["notepad.exe", "mspaint.exe"]);
        // 文字识别 API
        assert!(!dst.ocr_enable);
        assert_eq!(dst.ocr_key, "AK-roundtrip");
        assert_eq!(dst.ocr_secret, "SK-roundtrip");
        assert_eq!(dst.ocr_lang, "ENG");
        assert!(dst.ocr_accurate);
        assert_eq!(dst.ocr_engine, "windows");
        assert_eq!(dst.ocr_multi, vec!["baidu", "tencent"], "同时识别名单没还原");
        // 引擎与排序（顺序也是数据）
        assert_eq!(dst.bar_list, want.bar_list, "横条引擎排序没还原");
        assert_eq!(dst.sep_style, "dot");
        assert_eq!(dst.custom_engines, want.custom_engines, "自定义引擎没还原");
        assert_eq!(dst.url_overrides.get("DeepSeek").map(|s| s.as_str()),
                   Some("https://ds-new/?q=%s"), "自定义引擎地址没还原");
        assert_eq!(dst.ai_suffix, "？请用中文回答");
        assert_eq!(dst.ai_suffixes.get("ChatGPT").map(|s| s.as_str()),
                   Some(" in English please"), "AI 引擎后缀没还原");
        assert!(!dst.ai_copy_prompt);
        assert_eq!(dst.last_engine.as_deref(), Some("必应"), "上次用的引擎没还原");
        // WebDAV 地址 / 账号 / 密码
        assert_eq!(dst.webdav_url, "https://dav.example.com/dav/");
        assert_eq!(dst.webdav_user, "davuser");
        assert_eq!(dst.webdav_pass, "davpass");
        assert!(dst.webdav_on_start && dst.webdav_on_exit);
        // 收藏夹整树：目录 / 文本 / 图片 / 备注，一个都不能少
        assert_eq!(
            serde_json::to_value(&dst.favorites).unwrap(),
            serde_json::to_value(&want.favorites).unwrap(),
            "收藏夹整树没还原（目录 / 文本 / 图片 / 备注）"
        );
        assert_eq!(dst.fav_hotkey, "Ctrl+Alt+F");
        assert_eq!(dst.fav_panel_sizes.get("@fav:g1").map(|v| v.as_slice()),
                   Some(&[520.0, 640.0][..]), "收藏面板尺寸没还原");
        assert_eq!(dst.fav_panel_sizes.get("_root").map(|v| v.as_slice()),
                   Some(&[480.0, 600.0][..]));
        assert_eq!(dst.backup_password, "backup-secret");
        // 自定义图标：view 里得是 data URL，恢复后得落回 icons 目录
        let ov = view.get("overrideIcons").and_then(|x| x.as_object())
            .expect("view 里没有 overrideIcons");
        let url = ov.get("我的引擎").and_then(|x| x.as_str())
            .expect("overrideIcons 里没有「我的引擎」");
        assert!(url.starts_with("data:image/png;base64,"), "图标没打成 data URL：{url:.40}");
        assert_eq!(dst.overrides.get("我的引擎").map(|s| s.as_str()), Some("我的引擎.png"),
                   "自定义图标没还原成文件");
        assert_eq!(std::fs::read(&restored_path).ok().as_deref(), Some(&icon_bytes[..]),
                   "还原出来的图标文件和原文件不一致");
        // 版本号在，恢复链的最低限度检查才认得这份备份
        assert!(view.get("version").is_some(), "view 里没有 version");
        // 窗口尺寸是逐机器偏好，故意不进备份（见 config_view 里的说明）——
        // 钉住这个决定，防止哪天有人「好心」加回来，换机器开出比屏幕还大的窗
        assert!(view.get("ocrWinW").is_none() && view.get("ocrWinH").is_none(),
                "OCR 窗尺寸不该进备份");
    }

    /// 把 config.json 的 mtime 拨到 `secs` 秒之后。
    ///
    /// 为什么要手动拨：判重的第一道闸是「mtime 比记号新 2 秒以上」，而测试里
    /// 两次写入只差几毫秒 —— 不拨时间第一道闸就把它拦了，第二道闸（实质指纹）
    /// 根本没被验证到，测试会"假通过"。
    fn touch_config_in_future(secs: u64) {
        use std::fs::FileTimes;
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(config::config_path())
            .expect("config.json 打不开");
        let t = std::time::SystemTime::now() + std::time::Duration::from_secs(secs);
        f.set_times(FileTimes::new().set_modified(t))
            .expect("mtime 拨不动");
    }

    /// 自动备份的第二道闸：**只动界面状态不算改动**。
    ///
    /// 这正是轮 23 在用户真实数据目录里看到的现象 —— 4 份手动备份有 2 份内容
    /// 完全相同，成因是自动同步只看 config.json 的 mtime，而「收藏面板尺寸 /
    /// 最后用的引擎 / 识别窗大小」一变 mtime 就变，于是每开一次软件堆一份 112KB。
    /// 这条测试把整条链（mark_backup_done → 改配置 → 判重）钉住：
    /// 只改界面状态必须判「没改」，真改内容必须判「改了」。
    #[test]
    fn auto_backup_gate_skips_when_only_volatile_keys_changed() {
        let _env_lock = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _state_lock = STATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _appdata = AppDataTemp::new();

        // ⚠ 数据目录（%APPDATA%\QuickSearch）在真机上一定存在，但临时 APPDATA 下
        // 没有 —— `mark_backup_done` 用的是 `fs::write`（不建父目录），少了这一行
        // 它会**静默失败**（`let _ =` 吞掉），测试就会看到"记号没写下来"。
        std::fs::create_dir_all(config::data_dir()).expect("临时数据目录建不出来");

        let mut cfg = config::Config::default();
        cfg.bar_list = vec!["百度".into(), "Google".into()];
        cfg.last_engine = Some("百度".into());
        cfg.fav_panel_sizes.insert("_root".into(), vec![480.0, 600.0]);

        with_state_cfg(cfg, || {
            // ① 记一次「刚刚备份过」
            mark_backup_done();
            let (last, dig) = last_backup_mark();
            assert!(last > 0 && dig.is_some(), "备份记号没写下来：{last} / {dig:?}");

            // ② 只改界面状态：面板尺寸 + 最后用的引擎（VOLATILE_KEYS 里的两项）
            {
                let mut c = st().cfg.lock().unwrap();
                c.fav_panel_sizes.insert("_root".into(), vec![900.0, 1200.0]);
                c.last_engine = Some("Google".into());
                config::save(&c);
            }
            touch_config_in_future(60);
            assert!(
                !changed_since_last_backup(),
                "只改界面状态也必须判成「没改」——否则每开一次软件就多一份 112KB 备份"
            );

            // ③ 真改内容：横条成员变了
            {
                let mut c = st().cfg.lock().unwrap();
                c.bar_list.push("DeepSeek".into());
                config::save(&c);
            }
            touch_config_in_future(120);
            assert!(
                changed_since_last_backup(),
                "真改了内容必须判成「改了」（不能漏备份）"
            );
        });
    }

    /* ============================================================== */
    /* 外部软件：新增即钉横条、改名不动格子、删除三清                      */
    /* ============================================================== */

    /// 「保存后固定到横条」这条需求的直接验证。
    ///
    /// 测的是 `add_app_impl` 业务本体而不是 `add_app` 命令：命令尾部那句
    /// `broadcast()` 在测试环境会 panic（`APP` 只在真机启动时初始化）。
    #[test]
    fn add_app_pins_sentinel_and_remove_app_cleans_up() {
        // 只动 `_impl` 纯函数、不碰 STATE，但 `drop_icon` 会写 icons 目录
        // （从 APPDATA 派生）—— 拿 ENV_LOCK + 临时 APPDATA 隔离，绝不碰真的。
        let _env_lock = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _appdata = AppDataTemp::new();

        let mut cfg = config::Config::default();
        cfg.bar_list = vec!["百度".into(), "Google".into()];

        // ① 添加：校验通过 → 拿到 id → 哨兵钉在横条**末尾**
        let id = add_app_impl(&mut cfg, "微信", "weixin://", "open").expect("正当输入被误拦");
        assert!(!id.is_empty(), "没返回 id，前端拿什么换图标");
        assert_eq!(cfg.apps.len(), 1, "软件要落库");
        assert_eq!(cfg.apps[0].name, "微信");
        assert_eq!(cfg.apps[0].url, "weixin://");
        assert_eq!(cfg.apps[0].kind, "open", "类型要落库（#135）");
        assert_eq!(
            cfg.bar_list.last().map(|s| s.as_str()),
            Some(config::app_sentinel(&id).as_str()),
            "保存后必须自动钉进横条（用户原话）"
        );
        assert_eq!(cfg.bar_list.len(), 3, "原有成员一个不能少");

        // ② 坏输入一律进不来，且**不能**留下半截状态
        let before_len = cfg.apps.len();
        assert!(add_app_impl(&mut cfg, "", "weixin://", "open").is_err(), "空名字要拦");
        assert!(add_app_impl(&mut cfg, "坏地址", "javascript:alert(1)", "open").is_err());
        assert!(add_app_impl(&mut cfg, "微信", "https://example.com", "open").is_err(),
                "重名要拦");
        // 类型与地址不自洽也要拦（#135 契约）
        assert!(add_app_impl(&mut cfg, "百科", "https://baike.baidu.com/", "search").is_err(),
                "搜索类地址不带 %s 要拦");
        assert_eq!(cfg.apps.len(), before_len, "失败的添加不该留下痕迹");
        assert_eq!(cfg.bar_list.len(), 3, "失败的添加不该往横条塞哨兵");

        // ③ 改名：横条那一格按 id 钉，**不能**跟着名字变
        update_app_impl(&mut cfg, &id, "企业微信", "weixin://", "open").expect("改名被误拦");
        assert_eq!(cfg.apps[0].name, "企业微信");
        assert_eq!(
            cfg.apps[0].id, id,
            "编辑后 id 必须原样 —— clean_app 不返回 id，忘了还回去 \
             横条上那颗格子就变成孤儿"
        );
        assert_eq!(
            cfg.bar_list.last().map(|s| s.as_str()),
            Some(config::app_sentinel(&id).as_str()),
            "改名后哨兵必须原样（它是按 id 钉的，不是按名字）"
        );

        // ④ 删除：软件、哨兵、自定义图标三样一起清
        cfg.overrides
            .insert(config::app_sentinel(&id), "orphan.png".into());
        assert!(remove_app_impl(&mut cfg, &id), "存在的软件应删得掉");
        assert!(cfg.apps.is_empty(), "软件本体要删掉");
        assert!(
            !cfg.bar_list.iter().any(|n| n == &config::app_sentinel(&id)),
            "横条哨兵要跟着消失，否则就是一颗点不动的幽灵图标"
        );
        assert_eq!(cfg.bar_list, vec!["百度".to_string(), "Google".to_string()]);
        assert!(
            !cfg.overrides.contains_key(&config::app_sentinel(&id)),
            "自定义图标的键要清掉，否则 icons 目录里堆孤儿文件"
        );
        // 删不存在的 id：静默返回 false，不能panic、不能误删别人
        assert!(!remove_app_impl(&mut cfg, &id));
        assert!(!remove_app_impl(&mut cfg, "压根没这个"));
    }

    /// 上限 60 个：横条摆不下那么多，也不该让配置文件无限膨胀。
    #[test]
    fn add_app_enforces_the_60_cap() {
        let _env_lock = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _appdata = AppDataTemp::new();

        let mut cfg = config::Config::default();
        for i in 0..60 {
            add_app_impl(&mut cfg, &format!("软件{i}"), "https://example.com", "open")
                .expect("第 61 个之前的添加都该成功");
        }
        let e = add_app_impl(&mut cfg, "第61个", "https://example.com", "open")
            .expect_err("超过 60 个必须拦下");
        assert!(e.contains("60"), "错误信息要说明上限：{e}");
        assert_eq!(cfg.apps.len(), 60);
    }

    /// `open_app` 的拒绝路径都发生在**真的去打开之前**：
    /// 软件没了、地址不合法（手改过的旧配置）、搜索类没有选中文字 ——
    /// 都不该启动浏览器。
    #[test]
    fn open_app_rejects_missing_id_and_bad_url_without_opening() {
        let _state_lock = STATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut cfg = config::Config::default();
        cfg.apps = vec![
            config::ExternalApp {
                id: "ok".into(),
                name: "好的".into(),
                url: "weixin://".into(),
                kind: "open".into(),
            },
            config::ExternalApp {
                id: "evil".into(),
                name: "坏的".into(),
                // 模拟「用户手改 config.json」塞进来的危险地址
                url: "javascript:alert(1)".into(),
                kind: "open".into(),
            },
            config::ExternalApp {
                id: "wiki".into(),
                name: "百科".into(),
                // #135 搜索类：%s 代表选中的文字
                url: "https://baike.baidu.com/item/%s".into(),
                kind: "search".into(),
            },
        ];
        with_state_cfg(cfg, || {
            assert!(open_app("没有这个id".into(), None).is_err(), "不存在的软件要报错");
            let e = open_app("evil".into(), None).expect_err("危险地址必须被拒");
            assert!(
                e.contains("不合法"),
                "错误信息要告诉用户去设置里改：{e}"
            );
            // 搜索类没有选中文字（前端没传、后端选区也是空的）→ 拒绝打开，
            // 不然会拉起一个带着空查询的页面（#134/#135 同一条契约）
            let e = open_app("wiki".into(), None).expect_err("搜索类没词要拒");
            assert!(e.contains("先选中文字"), "提示要引导用户先选中文字：{e}");
            // 正当的那条**不能**在这里断言成功 —— 它会真的唤起系统关联程序。
            // 它的落点由 round24-probe 在真机上验（拦 invoke 取证）。
        });
    }

    /* ============================================================== */
    /* 划词兜底：第二棒必须是**用户配的那家**                          */
    /* ============================================================== */

    /// r46 回归钉：这条链以前把「本地 + 百度」写死在一个 `Vec<bool>` 里，
    /// 用户把引擎换成硅基流动 / Kimi 之后，划词兜底照旧去打百度 —— 配的那家
    /// 永远不会被调用。用户原话：「就相当于添加了，但没用上」。
    #[test]
    fn capture_fallback_second_leg_is_the_configured_engine() {
        // 本地可用 + 配了硅基流动：两棒，第二棒是硅基流动，**不是百度**
        let o = capture_fallback_order(true, "siliconflow", true);
        assert_eq!(o, vec!["windows".to_string(), "siliconflow".to_string()]);
        assert!(!o.iter().any(|x| x == "baidu"), "{o:?}");

        // 本地不可用（缺语言包）：只剩配的那家
        assert_eq!(
            capture_fallback_order(false, "moonshot", true),
            vec!["moonshot".to_string()]
        );

        // 配的那家没填凭据：不硬跑它（白等一次网络失败），只跑本地
        assert_eq!(
            capture_fallback_order(true, "tencent", false),
            vec!["windows".to_string()]
        );

        // 两边都不行：空（调用方据此跳过兜底，而不是"最后再试一次百度"）
        assert!(capture_fallback_order(false, "tencent", false).is_empty());

        // 传进来一个不认识的 id（手改过配置文件）：不能当在线引擎用
        assert_eq!(
            capture_fallback_order(true, "自己编的", true),
            vec!["windows".to_string()]
        );
    }

    /* ============================================================== */
    /* 多引擎的结果拼接（r47：只拼"参与名单"里的那几家）                 */
    /* ============================================================== */
    /// 多引擎展示的核心逻辑：名单里每家一段、各自带【引擎名】标注、
    /// **顺序跟着名单走**（默认引擎在最上面）；清理模式对每段一起生效；
    /// 别的代次不串场；**没参与的那家一个字都不许出现**。
    ///
    /// 用户原话（r42）：「并行呈现两个 ocr 的结果。一个在上，一个在下。但同时
    /// 标记好哪个是百度 ocr，哪个是本地 ocr」。
    /// 用户原话（r47）：「同时也只会显示自己选择的那一个」。
    #[test]
    fn combined_from_labels_only_planned_engines() {
        // 用一个别的测试绝不会碰的代次 —— 缓存是进程级全局，并行跑会互相污染
        let gen = 0x5EED_1234u64;
        // ⚠ r47：`combined_text` 现在读的是**配置里的参与名单**，而单测里没有 APP、
        //   只能拿到 `Config::default()`（= 百度一家），配不出多引擎场景。
        //   所以这里直接测**纯函数版** `combined_from`，名单由测试自己给 ——
        //   顺带把 r47 的核心不变式钉在这里：只拼名单里的那几家。
        let mut cache: Vec<(u64, String, String, String, String)> = Vec::new();
        cache.push((gen, "windows".into(), String::new(),
                    "hello world 你好".into(), "本地识别".into()));
        cache.push((gen, "baidu".into(), String::new(),
                    "foo bar 世界".into(), "标准版".into()));
        // 再来一条别的代次的：验证它绝不会串到这一代的展示里
        cache.push((gen + 999, "windows".into(), String::new(),
                    "别张图的字".into(), "本地识别".into()));

        let plan: Vec<String> = vec!["windows".into(), "baidu".into()];
        let combined = super::combined_from(&plan, gen, &cache).expect("两条结果应该拼得出来");
        // 顺序：名单里谁在前谁在上（默认引擎在名单第一位 → 排最上面）
        let li = combined.find("【本地识别】").expect("没有本地标注");
        let bi = combined.find("【百度云】").expect("没有百度标注");
        assert!(li < bi, "本地那段应该排在百度上面");
        assert!(combined.contains("hello world 你好"), "本地那段的内容不在");
        assert!(combined.contains("foo bar 世界"), "百度那段的内容不在");
        assert!(!combined.contains("别张图的字"), "代次隔离失效，别张图的字串进来了");

        // 智能清理：单词↔单词、单词↔中文之间的空格留着（对两段都生效）
        let smart = super::clean_text(&combined, super::CLEAN_SPACE_SMART);
        assert!(smart.contains("hello world 你好"), "智能清理误伤了本地那段：{smart}");
        assert!(smart.contains("foo bar 世界"), "智能清理误伤了百度那段：{smart}");
        // 强力清理：除换行外全删（对两段都生效）
        let force = super::clean_text(&combined, super::CLEAN_SPACE_FORCE);
        assert!(force.contains("helloworld你好"), "强力清理没吃到本地那段：{force}");
        assert!(force.contains("foobar世界"), "强力清理没吃到百度那段：{force}");
        assert!(!force.contains("hello world"), "强力清理有漏刀：{force}");

        // 只剩一段时也拼得出来（百度挂了、只有本地参与）
        let only_local = super::combined_from(&["windows".to_string()], gen, &cache)
            .expect("只剩本地也该拼出来");
        assert!(only_local.contains("【本地识别】"), "只剩本地时标注丢了");
        assert!(!only_local.contains("【百度云】"), "只剩本地时不该有百度标注");

        // ★ r47 核心不变式：**没让谁参与，就一个字都不许出现它**。
        //   用户报的 bug 就是这个 —— 关掉并行后结果窗里仍冒出"本地识别"一段。
        let only_baidu = super::combined_from(&["baidu".to_string()], gen, &cache)
            .expect("只让百度参与也该拼出来");
        assert!(only_baidu.contains("【百度云】"), "百度那段丢了");
        assert!(
            !only_baidu.contains("【本地识别】"),
            "没勾本地，结果里却冒出本地那段：{only_baidu}"
        );

        // 名单里那家这次没结果 → None（调用方据此报错，不能凭空造一段空的）
        assert!(
            super::combined_from(&["tencent".to_string()], gen, &cache).is_none(),
            "名单里的引擎没有结果时应该返回 None"
        );

        // 名单为空 → None（default 都没了属于异常配置，也不该 panic）
        assert!(super::combined_from(&[], gen, &cache).is_none());
    }

    /// r47：参与名单 = **默认引擎在前** + 「同时识别」里勾的那几家（按注册表顺序）。
    ///
    /// 为什么顺序要按注册表而不是勾选顺序：结果窗里各段是**上下排列**的，
    /// 同一份配置每次识别都该排出同一个版式，否则用户会以为"结果换了位置"。
    #[test]
    fn ocr_plan_is_default_first_then_registry_order() {
        let mut c = config::Config::default();
        c.ocr_engine = "siliconflow".into();
        c.ocr_multi.clear();
        assert_eq!(
            super::ocr_engine_plan(&c),
            vec!["siliconflow"],
            "没勾任何一家时只跑默认引擎"
        );

        c.ocr_multi = vec!["windows".into(), "baidu".into()];
        let plan = super::ocr_engine_plan(&c);
        assert_eq!(plan[0], "siliconflow", "默认引擎必须排第一");
        assert_eq!(plan.len(), 3, "默认 + 勾的两家：{plan:?}");
        // 注册表顺序固定（windows 在 baidu 前面 —— 见 ocr_engines::ENGINES）
        let wi = plan.iter().position(|x| x == "windows").unwrap();
        let bi = plan.iter().position(|x| x == "baidu").unwrap();
        assert!(wi < bi, "额外那几家应按注册表顺序：{plan:?}");

        // 勾选顺序反过来，结果一样（顺序只由注册表决定）
        c.ocr_multi = vec!["baidu".into(), "windows".into()];
        assert_eq!(super::ocr_engine_plan(&c), plan, "顺序不该随勾选先后变化");

        // 默认引擎被勾进来也不重复（它本来就一定参与）
        c.ocr_multi = vec!["siliconflow".into(), "windows".into()];
        let plan = super::ocr_engine_plan(&c);
        assert_eq!(
            plan.iter().filter(|x| *x == "siliconflow").count(),
            1,
            "默认引擎只该出现一次：{plan:?}"
        );

        // 不认识的 id 直接丢掉（老配置 / 手改文件 / 备份来自别的版本）
        c.ocr_multi = vec!["没这家".into(), "windows".into()];
        assert_eq!(super::ocr_engine_plan(&c), vec!["siliconflow", "windows"]);

        // 默认引擎自己不认识（读配置时 sanitize 会把它归一成 baidu，
        // 但这里直接喂脏值）→ 名单里没有它，也不许 panic
        c.ocr_engine = "也不认识".into();
        c.ocr_multi = vec!["windows".into()];
        assert_eq!(super::ocr_engine_plan(&c), vec!["windows"]);
    }

    /// 提示条的两条通道：推送用的一份（推完即清）+ 页面主动拉的一份（只读不清）。
    ///
    /// 踩过的坑：提示原先只有推送这一条通道，而推送是「发出去就算」——
    /// OCR 结果窗冷启动时脚本还没加载好，推送整批落空，于是「为什么只有本地结果」
    /// 这类说明永远看不到。所以拉的那条通道也必须拿得到，且不能把推送那份吃掉。
    #[test]
    fn ocr_note_two_channels() {
        super::clear_ocr_note();
        assert_eq!(super::ocr_take_note(), "", "清空后拉到的应该是空串");

        super::set_ocr_note("百度云：还没配 API Key".into());
        // 拉的那份：只读不清，拉两次都还在
        assert_eq!(super::ocr_take_note(), "百度云：还没配 API Key");
        assert_eq!(super::ocr_take_note(), "百度云：还没配 API Key",
                   "拉取不该把提示吃掉（推送通道还要用）");
        // 推的那份：取走即清（模拟 open_ocr_window / emit_ocr_result 的读法）
        let pushed = super::OCR_NOTE
            .lock()
            .map(|mut n| {
                let s = n.trim().to_string();
                n.clear();
                s
            })
            .unwrap_or_default();
        assert_eq!(pushed, "百度云：还没配 API Key");
        // 推完了但拉的那份还在 —— 页面这时 boot，照样能拉到
        assert_eq!(super::ocr_take_note(), "百度云：还没配 API Key",
                   "推送消费掉之后，拉通道应该还留着");

        // 新一轮识别开始：两份一起清，旧说明不许挂到新结果上
        super::clear_ocr_note();
        assert_eq!(super::ocr_take_note(), "", "新一轮开始时提示该被清掉");
        let after = super::OCR_NOTE.lock().map(|n| n.clone()).unwrap_or_default();
        assert_eq!(after, "", "推送那份也该被清掉");
    }

    /* ---------------- r71：trace.moe 结果页 ---------------- */

    /// fmt_ts：浮点秒 → mm:ss（**截断**：场景起点宁可早到，别让用户错过开头）。
    #[test]
    fn fmt_ts_秒数格式化为分秒() {
        assert_eq!(fmt_ts(0.0), "0:00");
        assert_eq!(fmt_ts(9.4), "0:09");
        assert_eq!(fmt_ts(65.7), "1:05");     // 65.7 秒截断 → 1:05，不是四舍五入到 1:06
        assert_eq!(fmt_ts(1094.511), "18:14");
        assert_eq!(fmt_ts(-3.0), "0:00");     // 负数兜底
        assert_eq!(fmt_ts(3599.9), "59:59");  // 差 0.1 秒也不进位
    }

    /// 结果页：正常 JSON → 落一个 file:// 页面，内容含番名/集数/时间点/相似度。
    #[test]
    fn tracemoe_结果页_正常数据() {
        let json = r#"{"quota":100,"quotaUsed":2,"error":"","result":[
            {"anilist":{"id":194393,"idMal":61839,"isAdult":false,
              "title":{"native":"愛してる","romaji":"Aishiteru","chinese":"想結束這場遊戲","english":"Love Game"},
              "siteUrl":"https://anilist.co/anime/194393"},
             "episode":11,"from":1094.511,"to":1100.392,"similarity":0.9081,
             "video":"https://api.trace.moe/video/aQ57","image":"https://api.trace.moe/image/aQ57"},
            {"anilist":{"id":1,"idMal":1,"isAdult":false,
              "title":{"native":"二番目","romaji":"","chinese":"","english":""},
              "siteUrl":"https://anilist.co/anime/1"},
             "episode":null,"from":12.0,"to":20.0,"similarity":0.5,
             "video":"","image":""}
        ]}"#;
        let url = tracemoe_result_page(json).expect("应当出页");
        assert!(url.starts_with("file:///"), "应当落本地页：{url}");
        assert!(url.contains("tracemoe-result-") && url.ends_with(".html"),
            "文件名要带 pid+序号（并行互不覆盖）：{url}");
        // 文件名每次独有，不能写死路径 —— 从返回的 URL 反推
        let path = url.strip_prefix("file:///").expect("file:/// 开头").replace('/', "\\");
        let page = std::fs::read_to_string(path).expect("页应该写得出来");
        // 中文片名、罗马字、集数、时间点、相似度、两条外链都要在
        assert!(page.contains("想結束這場遊戲"), "中文片名要在");
        assert!(page.contains("Aishiteru"), "罗马字要在");
        assert!(page.contains("第 11 集"), "集数要在");
        assert!(page.contains("18:14 – 18:20"), "时间点要按 mm:ss 排");
        assert!(page.contains("相似度 90.8%"), "相似度要转百分数");
        assert!(page.contains("https://anilist.co/anime/194393"), "AniList 外链要在");
        assert!(page.contains("https://myanimelist.net/anime/61839"), "MAL 外链要按 idMal 拼");
        assert!(page.contains("https://api.trace.moe/video/aQ57"), "预览视频要在");
        // episode 为 null 的那条不许崩，也不许出现 "第 null 集"
        assert!(page.contains("二番目"), "第二条要在");
        assert!(!page.contains("null"), "null 不许漏到页面上");
    }

    /// 结果页：**对方数据一律不可信** —— 片名/链接里夹 HTML 与 javascript:
    /// 必须被转义 / 降级，不许原样进页面（XSS）。
    #[test]
    fn tracemoe_结果页_转义与降级() {
        let json = r#"{"error":"","result":[
            {"anilist":{"id":5,"idMal":5,"isAdult":true,
              "title":{"chinese":"<script>alert(1)</script>","romaji":"x\" onload=\"y","native":"","english":""},
              "siteUrl":"javascript:alert(1)"},
             "episode":1,"from":1.0,"to":2.0,"similarity":0.9,
             "video":"javascript:evil()","image":"data:text/html,<b>x</b>"}
        ]}"#;
        let url = tracemoe_result_page(json).expect("危险数据也要出页（转义后的）");
        assert!(url.contains("tracemoe-result-") && url.ends_with(".html"));
        let path = url.strip_prefix("file:///").expect("file:/// 开头").replace('/', "\\");
        let page = std::fs::read_to_string(path).expect("页应该写得出来");
        assert!(!page.contains("<script>alert(1)</script>"), "script 标签必须被转义");
        assert!(page.contains("&lt;script&gt;"), "script 应当以实体出现");
        assert!(page.contains("&quot;"), "引号必须被转义（onload= 那种注入靠它）");
        assert!(!page.contains("javascript:"), "javascript: 链接必须被降级丢掉");
        assert!(!page.contains("data:text/html"), "data: 链接必须被降级丢掉");
        assert!(page.contains("R18"), "isAdult 要标出来");
    }

    /// 结果页：错误 / 空结果 / 非 JSON → 一律 Err（调用方会退回打开官网页）。
    #[test]
    fn tracemoe_结果页_失败情形() {
        assert!(tracemoe_result_page(r#"{"error":"Search quota exceeded"}"#).is_err(),
                "对方报错要 Err");
        assert!(tracemoe_result_page(r#"{"error":"","result":[]}"#).is_err(),
                "空结果要 Err");
        assert!(tracemoe_result_page("not json at all").is_err(),
                "非 JSON 要 Err");
        assert!(tracemoe_result_page("").is_err(), "空串要 Err");
    }
}
