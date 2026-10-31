//! 应用内置的右下角提示（v2.6.8 起取代托盘的系统气泡通知）。
//!
//! ## 为什么不用系统通知
//! 以前走 `Shell_NotifyIconW` + `NIF_INFO`（见 trayhost::balloon）：那是**系统通知** ——
//! Win10/11 会把它塞进操作中心、时长和样式全由系统决定，用户既关不掉时长、
//! 也觉得"太频繁、太打扰"。现在改成**应用自己的小窗口**：
//!   · 样式跟应用一致（圆角、主题色、深色模式跟随系统）；
//!   · 显示秒数由设置决定（`notify_seconds`）；
//!   · 不抢焦点、不进任务栏、鼠标穿透（点下去落到下面的程序上），
//!     所以它只是"扫一眼的信息"，不会打断正在做的事。
//!
//! ## 成本
//! 窗口**只建一次**（第一次要提示时才建），之后复用：隐藏/显示。
//! 每次通知都新建一个 WebView2 会有几百毫秒延迟、内存也会一涨一落。
//!
//! ## 生命周期
//! 1. Rust `show()` → 记下内容 → 摆位置 → 显示窗口 → emit `qs://hint`；
//! 2. `toast.html` 收到后渲染 + 播进场动画 + 自己按 `ms` 计时；
//! 3. 到时播退场动画，动画结束调 `toast_hide` → Rust `ShowWindow(SW_HIDE)`。
//!
//! ⚠ 页面首帧可能比第一次 emit **晚**到（新窗口正在加载 WebView2），所以
//! 内容还存在 `PENDING` 里，页面加载完会主动 `toast_pull` 拉一次。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::json;

use crate::t::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use crate::win;

const LABEL: &str = "toast";
/// 逻辑像素（tao 的 inner_size 收逻辑值，摆位置要乘 scale_factor）
const W_LP: i32 = 336;
const H_LP: i32 = 88;
const MARGIN_LP: i32 = 18;

/// 最近一次提示的内容：(正文, 显示毫秒)。`toast_pull` 读它。
static PENDING: Mutex<Option<(String, u64)>> = Mutex::new(None);

/// 第几次提示。页面那边**正常**会自己计时并调 `toast_hide`，但万一把页面卡住
/// （或 invoke 没送到），提示就会赖在屏幕上 —— 这里在后台补一道定时兜底：
/// 到点（ms + 1.5s）如果还是同一代，就直接把窗口藏起来。
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// 弹出提示。`text` 是正文（已经拼好"正在使用：功能 · 软件"）。
pub fn show(app: &AppHandle, text: &str, ms: u64) {
    if let Ok(mut g) = PENDING.lock() {
        *g = Some((text.to_string(), ms));
    }
    // 兜底定时器：只有"还是同一代"才动手，新提示一进来旧定时器就作废
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let a_fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms + 1500));
        if GENERATION.load(Ordering::SeqCst) == gen {
            let a = a_fallback;
            let _ = a.run_on_main_thread(|| hide_inner());
        }
    });
    let a = app.clone();
    let a2 = a.clone();
    let text = text.to_string();
    let _ = a.run_on_main_thread(move || place_and_emit(&a2, &text, ms));
}

/// 页面加载完来取一次内容（防止第一次 emit 早于首帧）。
pub fn pending() -> Option<(String, u64)> {
    PENDING.lock().ok().and_then(|g| g.clone())
}

fn place_and_emit(app: &AppHandle, text: &str, ms: u64) {
    let payload = json!({ "text": text, "ms": ms });
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.emit("qs://hint", payload);
        reveal(&w);
        return;
    }
    // 第一次：建窗口。建好先摆位置再显示，避免"先在左上角闪一下"
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("toast.html".into()))
        .title("QS-Toast")
        .inner_size(W_LP as f64, H_LP as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        .focused(false)
        .visible(false);
    /* 必须和横条/设置窗口用**同一套** WebView2 参数，否则环境配置冲突、
     * 窗口建不起来（HRESULT 0x8007139F，踩过一次记一辈子） */
    let wa = crate::wv_args();
    if !wa.is_empty() {
        b = b.additional_browser_args(&wa);
    }
    match b.build() {
        Ok(w) => {
            place(&w);
            let _ = w.emit("qs://hint", payload);
            reveal(&w);
        }
        Err(e) => win::log(&format!("toast: 窗口建不起来: {e}")),
    }
}

/// 摆位置 → 显示 → **再补一次窗口样式**。
///
/// ⚠ `make_click_through` 必须放在 `show()` **之后**：tao 的 `set_visible(true)`
/// 会重写窗口样式，之前设好的 `WS_EX_NOACTIVATE / WS_EX_TRANSPARENT / WS_EX_TOOLWINDOW`
/// 会被覆盖掉。实测建窗时设过、显示后读出来 `0x40118` —— 三个标志一个都不剩，
/// 后果是"提示一弹出来就把前台焦点抢走"，横条立刻自己收起（用户会以为提示把功能打断了）。
fn reveal(w: &crate::t::WebviewWindow) {
    place(w);
    let _ = w.show();
    if let Ok(h) = w.hwnd() {
        win::make_click_through(h);
    }
}

/// 摆到工作区右下角（避开任务栏），不激活窗口。
fn place(w: &crate::t::WebviewWindow) {
    let Ok(h) = w.hwnd() else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    let (vx, vy, vw, vh) = win::virtual_screen();
    let wa = win::work_area_near(vx + vw - 1, vy + vh - 1);
    let pw = (W_LP as f64 * sf).round() as i32;
    let ph = (H_LP as f64 * sf).round() as i32;
    let m = (MARGIN_LP as f64 * sf).round() as i32;
    let x = wa.right - pw - m;
    let y = wa.bottom - ph - m;
    win::move_resize(h, x, y, pw, ph, false);
}

/// 藏起来（页面播完退场动画后调）。窗口留着下次复用。
pub fn hide() {
    if let Some(a) = crate::APP.get() {
        let a = a.clone();
        let _ = a.run_on_main_thread(hide_inner);
    }
}

fn hide_inner() {
    if let Some(w) = crate::app().get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
