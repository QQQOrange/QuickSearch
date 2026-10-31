#![allow(dead_code)]
//! 本模块是 **Tauri 兼容层**：照 Tauri 的 API 面留壳，让按 Tauri 写的代码
//! 能原样编译。其中一部分方法本项目当前没有调用（例如 App 的路径查询、
//! 窗口管理里尚未用到的几个），但它们是**接口的一部分** —— 删掉会让以后
//! 移植代码时对不上号，所以保留并在模块级放行 dead_code。
//!
//! 真正确认无引用、且不属于任何接口的独立函数已直接删除（box_err /
//! window_op / reg_window_op、trayhost::remove）。
//! Tauri API 兼容垫层（tao + wry 实现）
//!
//! 目的：让原项目的 19977 行 `main.rs` 几乎原样编译运行，只替换掉 Tauri 运行时。
//! 只实现原项目**实际用到**的那部分 API —— 不是通用实现，够用即可。
//!
//! 线程模型（和 Tauri 保持一致，这是原代码注释里反复强调的前提）：
//!   · 同步命令跑在**主线程**（事件循环线程）上；
//!   · 建窗/改窗只在主线程做，`run_on_main_thread` 负责把闭包投递回来；
//!   · 窗口与 WebView 对象不是 Send，存在 thread_local 里。

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tao::dpi::{LogicalPosition, LogicalSize, PhysicalPosition as TaoPhysPos};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder, WindowId};
use wry::WebViewBuilder;

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}
impl From<wry::Error> for Error {
    fn from(e: wry::Error) -> Self {
        Error(e.to_string())
    }
}
impl From<tao::error::OsError> for Error {
    fn from(e: tao::error::OsError) -> Self {
        Error(e.to_string())
    }
}

/// `tauri::Wry` 的占位：原代码只在泛型参数位置用到它。
pub struct Wry;

/// 对应 Tauri 的 `PlatformWebview`：原代码只用它的 `.controller()`。
pub struct PlatformWebview {
    ctrl: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
}

impl PlatformWebview {
    pub fn controller(
        &self,
    ) -> webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller {
        self.ctrl.clone()
    }
}

pub type Result<T> = std::result::Result<T, Error>;


pub mod window {
    #[derive(Clone, Copy, Debug)]
    pub struct Color(pub u8, pub u8, pub u8, pub u8);
}

pub mod image {
    #[derive(Clone)]
    pub struct Image {
        pub bytes: Vec<u8>,
    }
    impl Image {
        pub fn from_bytes(bytes: &[u8]) -> crate::t::Result<Self> {
            if bytes.is_empty() {
                return Err(crate::t::Error("空图标".into()));
            }
            Ok(Image {
                bytes: bytes.to_vec(),
            })
        }
    }
}

pub mod ipc {
    /// 原样把二进制交回前端（Tauri 会给出 ArrayBuffer）。
    pub struct Response(pub Vec<u8>);
    impl Response {
        pub fn new(v: impl Into<Vec<u8>>) -> Self {
            Response(v.into())
        }
    }
}

pub mod async_runtime {
    use std::future::Future;

    /// 把阻塞任务丢到工作线程，返回一个可 await 的句柄。
    pub struct JoinHandle<T>(std::sync::mpsc::Receiver<T>);

    impl<T> Future for JoinHandle<T> {
        type Output = std::result::Result<T, String>;
        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            match self.0.try_recv() {
                Ok(v) => std::task::Poll::Ready(Ok(v)),
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    std::task::Poll::Ready(Err("工作线程意外退出".into()))
                }
            }
        }
    }

    pub fn spawn_blocking<F, T>(f: F) -> JoinHandle<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        JoinHandle(rx)
    }
}

pub use window::Color;

pub type PhysicalPosition = TaoPhysPos<i32>;
pub use tao::dpi::PhysicalSize;

#[derive(Clone, Debug)]
pub enum WebviewUrl {
    App(PathBuf),
    External(String),
}

#[derive(Clone, Debug)]
pub enum WindowEvent {
    CloseRequested { api: CloseApi },
    Destroyed,
    Focused(bool),
    Resized(PhysicalSize<u32>),
    Moved(PhysicalPosition),
    ScaleFactorChanged { scale_factor: f64, new_inner_size: PhysicalSize<u32> },
    ThemeChanged,
}

/// `CloseRequested { api }` 里的 api —— 原来用来 prevent_close。
#[derive(Clone, Debug, Default)]
pub struct CloseApi {
    pub prevented: Arc<Mutex<bool>>,
}
impl CloseApi {
    pub fn prevent_close(&self) {
        if let Ok(mut g) = self.prevented.lock() {
            *g = true;
        }
    }
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

pub type Invoker = fn(&Ctx, &Value) -> std::result::Result<Value, String>;

pub enum HostEvent {
    /// 有一批 IPC 请求待处理
    Pump,
    /// 在某（或全部）窗口里执行一段 JS
    Eval { label: Option<String>, js: String },
    /// 把闭包扔回主线程执行（对应 tauri 的 run_on_main_thread）
    Job(Box<dyn FnOnce() + Send>),
    /// 退出
    Exit(i32),
}

/// 窗口的**跨线程可见**状态镜像。
///
/// 真正的 `tao::Window` / `wry::WebView` 不是 Send，只能躺在主线程的 thread_local 里；
/// 但取词来自钩子线程、还有一堆 spawn 出来的线程会调 `show()/is_visible()/hwnd()`。
/// 所以：
///   · 读 → 读这份镜像（任何线程都能读，不会阻塞）；
///   · 写 → 改镜像（立刻对其他线程可见）+ 把真正的动作投递到主线程执行。
#[derive(Clone)]
pub struct WinState {
    pub visible: bool,
    pub title: String,
    pub w: u32,
    pub h: u32,
    pub x: i32,
    pub y: i32,
    pub hwnd: isize,
}

pub type WinHandler = Arc<dyn Fn(&WindowEvent) + Send + Sync>;

pub struct Inner {
    pub cmds: OnceLock<HashMap<&'static str, Invoker>>,
    pub labels: Mutex<HashSet<String>>,
    pub states: Mutex<HashMap<String, WinState>>,
    pub handlers: Mutex<HashMap<String, Vec<WinHandler>>>,
}

/// 主线程 id：判断某个调用要不要投递。
pub static MAIN_TID: OnceLock<std::thread::ThreadId> = OnceLock::new();

fn on_main() -> bool {
    MAIN_TID
        .get()
        .map(|t| *t == std::thread::current().id())
        .unwrap_or(true)
}

fn post<F: FnOnce() + Send + 'static>(f: F) {
    send_event(HostEvent::Job(Box::new(f)));
}

#[derive(Clone)]
pub struct AppHandle(Arc<Inner>);

impl AppHandle {
    pub fn proxy(&self) -> Option<EventLoopProxy<HostEvent>> {
        PROXY.lock().ok().and_then(|g| g.clone())
    }

    /// 事件循环线程同步执行即返回；别的线程则投递过去。
    pub fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
        send_event(HostEvent::Job(Box::new(f)));
        Ok(())
    }

    pub fn exit(&self, code: i32) {
        send_event(HostEvent::Exit(code));
    }
}

/// 命令执行时的上下文。
#[derive(Clone)]
pub struct Ctx {
    app: AppHandle,
    label: String,
}

impl Ctx {
    pub fn new(app: AppHandle, label: impl Into<String>) -> Self {
        Ctx {
            app,
            label: label.into(),
        }
    }
    pub fn app(&self) -> &AppHandle {
        &self.app
    }
    pub fn window(&self) -> WebviewWindow {
        WebviewWindow {
            app: self.app.clone(),
            label: self.label.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// 参数解析 / 序列化
// ---------------------------------------------------------------------------

pub fn arg<T: DeserializeOwned>(
    args: &Value,
    camel: &str,
    snake: &str,
) -> std::result::Result<T, String> {
    let v = args
        .get(camel)
        .or_else(|| args.get(snake))
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| format!("参数 {snake} 解析失败：{e}"))
}

pub fn to_value<T: Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub fn block_on<F: Future>(f: F) -> F::Output {
    pollster::block_on(f)
}

/// 启动期追踪：GUI 子系统下 stdout/stderr 可能拿不到，所以直接写文件。
pub fn trace(msg: &str) {
    // 默认不写文件：只有排查时设 QS_TRACE=1 才落盘，免得正式使用留垃圾。
    if std::env::var("QS_TRACE").map(|v| v != "1").unwrap_or(true) {
        return;
    }
    use std::io::Write;
    let base = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(base.join("qslite-trace.log"))
    {
        let _ = writeln!(f, "{msg}");
    }
}

// ---------------------------------------------------------------------------
// 窗口存储（只在主线程访问，所以用 thread_local）
// ---------------------------------------------------------------------------

struct WinSlot {
    window: Option<Window>,
    webview: Option<wry::WebView>,
    handlers: Vec<Arc<dyn Fn(&WindowEvent) + Send + Sync>>,
    visible: bool,
    title: String,
}

thread_local! {
    static WINS: RefCell<HashMap<String, WinSlot>> = RefCell::new(HashMap::new());
    static ID2LABEL: RefCell<HashMap<WindowId, String>> = RefCell::new(HashMap::new());
}

/// 全局（跨线程）可读的待处理 IPC 队列与主线程目标。
/// `EventLoopWindowTarget` 既不是 Send 也不是 Sync（内部是 Rc + 裸指针），
/// 但它活得比整个事件循环长，且只会在主线程上被解引用 —— 所以用裸地址包一层。
pub struct TargetCell(pub usize);
unsafe impl Send for TargetCell {}
unsafe impl Sync for TargetCell {}

pub struct Global {
    pub target: OnceLock<TargetCell>,
    pub queue: Mutex<VecDeque<(String, String)>>,
    pub root: OnceLock<PathBuf>,
}

pub static G: OnceLock<Arc<Global>> = OnceLock::new();

pub fn global() -> &'static Arc<Global> {
    G.get().expect("runtime 未初始化")
}

// ---------------------------------------------------------------------------
// Emitter / Manager
// ---------------------------------------------------------------------------

pub trait Target {
    fn target_label(&self) -> String;
}
impl Target for str {
    fn target_label(&self) -> String {
        self.to_string()
    }
}
impl Target for &str {
    fn target_label(&self) -> String {
        (*self).to_string()
    }
}
impl Target for String {
    fn target_label(&self) -> String {
        self.clone()
    }
}
impl Target for WebviewWindow {
    fn target_label(&self) -> String {
        self.label.clone()
    }
}
impl Target for &WebviewWindow {
    fn target_label(&self) -> String {
        self.label.clone()
    }
}

pub trait Emitter {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()>;
    fn emit_to<S: Serialize + Clone, T: Target>(
        &self,
        target: T,
        event: &str,
        payload: S,
    ) -> Result<()>;
}

pub trait Manager {
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow>;
    fn windows(&self) -> HashMap<String, WebviewWindow>;
    fn path(&self) -> PathResolver;
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct PathResolver {
    root: PathBuf,
}

impl PathResolver {
    pub fn app_data_dir(&self) -> Result<PathBuf> {
        Ok(self.root.join("data"))
    }
    pub fn app_config_dir(&self) -> Result<PathBuf> {
        Ok(self.root.join("data"))
    }
    pub fn app_local_data_dir(&self) -> Result<PathBuf> {
        Ok(self.root.join("data"))
    }
    pub fn app_cache_dir(&self) -> Result<PathBuf> {
        Ok(self.root.join("cache"))
    }
    pub fn resource_dir(&self) -> Result<PathBuf> {
        Ok(self.root.clone())
    }
    pub fn app_log_dir(&self) -> Result<PathBuf> {
        Ok(self.root.join("logs"))
    }
}

// ---------------------------------------------------------------------------
// WebviewWindow
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct WebviewWindow {
    app: AppHandle,
    label: String,
}

impl WebviewWindow {
    pub fn label(&self) -> &str {
        &self.label
    }

    fn st(&self) -> Option<WinState> {
        self.app
            .0
            .states
            .lock()
            .ok()
            .and_then(|g| g.get(&self.label).cloned())
    }

    fn upd(&self, f: impl FnOnce(&mut WinState)) {
        if let Ok(mut g) = self.app.0.states.lock() {
            if let Some(st) = g.get_mut(&self.label) {
                f(st);
            }
        }
    }

    /// 只在主线程上调（内部用）：直接操作真正的窗口对象。
    fn with_slot<R>(&self, f: impl FnOnce(&mut WinSlot) -> R) -> Option<R> {
        WINS.with(|m| m.borrow_mut().get_mut(&self.label).map(f))
    }

    /// 窗口动作：在主线程上就地执行，否则投递过去。
    fn act<F: FnOnce(&mut WinSlot) + Send + 'static>(&self, f: F) {
        if on_main() {
            let _ = self.with_slot(f);
        } else {
            let label = self.label.clone();
            post(move || {
                WINS.with(|m| {
                    if let Some(slot) = m.borrow_mut().get_mut(&label) {
                        f(slot);
                    }
                });
            });
        }
    }

    pub fn hwnd(&self) -> Result<windows::Win32::Foundation::HWND> {
        let st = self.st().ok_or_else(|| Error("窗口不存在".into()))?;
        if st.hwnd == 0 {
            return Err(Error("窗口还没有句柄".into()));
        }
        Ok(windows::Win32::Foundation::HWND(
            st.hwnd as *mut std::ffi::c_void,
        ))
    }

    pub fn show(&self) -> Result<()> {
        self.upd(|s| s.visible = true);
        self.act(|slot| {
            slot.visible = true;
            if let Some(w) = slot.window.as_ref() {
                w.set_visible(true);
            }
        });
        Ok(())
    }

    pub fn hide(&self) -> Result<()> {
        self.upd(|s| s.visible = false);
        self.act(|slot| {
            slot.visible = false;
            if let Some(w) = slot.window.as_ref() {
                w.set_visible(false);
            }
        });
        Ok(())
    }

    pub fn is_visible(&self) -> Result<bool> {
        Ok(self.st().map(|s| s.visible).unwrap_or(false))
    }

    pub fn set_focus(&self) -> Result<()> {
        self.act(|slot| {
            if let Some(w) = slot.window.as_ref() {
                w.set_focus();
            }
        });
        Ok(())
    }

    pub fn set_title(&self, t: &str) -> Result<()> {
        self.upd(|s| s.title = t.to_string());
        let t = t.to_string();
        self.act(move |slot| {
            slot.title = t.clone();
            if let Some(w) = slot.window.as_ref() {
                w.set_title(&t);
            }
        });
        Ok(())
    }

    pub fn title(&self) -> Result<String> {
        Ok(self
            .st()
            .map(|s| s.title)
            .unwrap_or_else(|| "Quick Search".into()))
    }

    pub fn inner_size(&self) -> Result<PhysicalSize<u32>> {
        let st = self.st();
        Ok(PhysicalSize::new(
            st.as_ref().map(|s| s.w).unwrap_or(0),
            st.as_ref().map(|s| s.h).unwrap_or(0),
        ))
    }

    pub fn outer_position(&self) -> Result<PhysicalPosition> {
        let st = self.st();
        Ok(TaoPhysPos::new(
            st.as_ref().map(|s| s.x).unwrap_or(0),
            st.as_ref().map(|s| s.y).unwrap_or(0),
        ))
    }

    pub fn scale_factor(&self) -> Result<f64> {
        if on_main() {
            Ok(self
                .with_slot(|s| s.window.as_ref().map(|w| w.scale_factor()))
                .flatten()
                .unwrap_or(1.0))
        } else {
            Ok(1.0)
        }
    }

    pub fn set_position(&self, p: TaoPhysPos<i32>) -> Result<()> {
        self.upd(|s| {
            s.x = p.x;
            s.y = p.y;
        });
        self.act(move |slot| {
            if let Some(w) = slot.window.as_ref() {
                w.set_outer_position(p);
            }
        });
        Ok(())
    }

    pub fn unminimize(&self) -> Result<()> {
        self.act(|slot| {
            if let Some(w) = slot.window.as_ref() {
                w.set_minimized(false);
            }
        });
        Ok(())
    }

    pub fn minimize(&self) -> Result<()> {
        self.act(|slot| {
            if let Some(w) = slot.window.as_ref() {
                w.set_minimized(true);
            }
        });
        Ok(())
    }

    pub fn close(&self) -> Result<()> {
        self.destroy()
    }

    pub fn destroy(&self) -> Result<()> {
        let label = self.label.clone();
        if let Ok(mut l) = self.app.0.labels.lock() {
            l.remove(&label);
        }
        if let Ok(mut st) = self.app.0.states.lock() {
            st.remove(&label);
        }
        if let Ok(mut h) = self.app.0.handlers.lock() {
            h.remove(&label);
        }
        let lbl = label.clone();
        post(move || {
            WINS.with(|m| {
                let mut g = m.borrow_mut();
                if let Some(mut slot) = g.remove(&lbl) {
                    if let Some(id) = slot.window.as_ref().map(|w| w.id()) {
                        ID2LABEL.with(|x| {
                            x.borrow_mut().remove(&id);
                        });
                    }
                    slot.webview.take();
                    slot.window.take();
                }
            });
        });
        Ok(())
    }

    pub fn on_window_event<F: Fn(&WindowEvent) + Send + Sync + 'static>(&self, f: F) {
        if let Ok(mut g) = self.app.0.handlers.lock() {
            g.entry(self.label.clone())
                .or_default()
                .push(Arc::new(f));
        }
    }

    /// 拿到 WebView2 控制器执行一段闭包。
    ///
    /// 主线程就地执行；其它线程投递过去（控制器是 COM 对象，只能在主线程碰）。
    pub fn with_webview<F>(&self, f: F) -> Result<()>
    where
        F: FnOnce(PlatformWebview) + Send + 'static,
    {
        let mut f = Some(f);
        self.act(move |slot| {
            if let (Some(cb), Some(wv)) = (f.take(), slot.webview.as_ref()) {
                use wry::WebViewExtWindows;
                cb(PlatformWebview {
                    ctrl: wv.controller(),
                });
            }
        });
        Ok(())
    }

    pub fn eval(&self, js: &str) {
        send_event(HostEvent::Eval {
            label: Some(self.label.clone()),
            js: js.to_string(),
        });
    }
}

impl Emitter for WebviewWindow {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        dispatch_emit(Some(self.label.clone()), event, &payload);
        Ok(())
    }
    fn emit_to<S: Serialize + Clone, T: Target>(
        &self,
        target: T,
        event: &str,
        payload: S,
    ) -> Result<()> {
        dispatch_emit(Some(target.target_label()), event, &payload);
        Ok(())
    }
}

impl Emitter for AppHandle {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        dispatch_emit(None, event, &payload);
        Ok(())
    }
    fn emit_to<S: Serialize + Clone, T: Target>(
        &self,
        target: T,
        event: &str,
        payload: S,
    ) -> Result<()> {
        dispatch_emit(Some(target.target_label()), event, &payload);
        Ok(())
    }
}

impl Manager for AppHandle {
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow> {
        let exists = self
            .0
            .labels
            .lock()
            .map(|s| s.contains(label))
            .unwrap_or(false);
        if exists {
            Some(WebviewWindow {
                app: self.clone(),
                label: label.to_string(),
            })
        } else {
            None
        }
    }
    fn windows(&self) -> HashMap<String, WebviewWindow> {
        let labels = self.0.labels.lock().map(|s| s.clone()).unwrap_or_default();
        labels
            .into_iter()
            .map(|l| {
                (
                    l.clone(),
                    WebviewWindow {
                        app: self.clone(),
                        label: l,
                    },
                )
            })
            .collect()
    }
    fn path(&self) -> PathResolver {
        PathResolver {
            root: global().root.get().cloned().unwrap_or_else(|| PathBuf::from(".")),
        }
    }
}

impl AppHandle {
    /// 对应 tauri 的 `Manager::tray_by_id`。这里只回一个元数据句柄。
    pub fn tray_by_id(&self, id: &str) -> Option<tray::TrayIcon> {
        if tray::tray_exists(id) {
            Some(tray::TrayIcon {
                id: id.to_string(),
                icon: None,
                menu: None,
                tooltip: None,
                tooltip_text: None,
                _p: std::marker::PhantomData,
                on_menu: None,
                on_event: None,
            })
        } else {
            None
        }
    }
}

impl Manager for WebviewWindow {
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow> {
        self.app.get_webview_window(label)
    }
    fn windows(&self) -> HashMap<String, WebviewWindow> {
        self.app.windows()
    }
    fn path(&self) -> PathResolver {
        self.app.path()
    }
}

fn dispatch_emit<S: Serialize + Clone>(label: Option<String>, event: &str, payload: &S) {
    let json = serde_json::to_string(payload).unwrap_or_else(|_| "null".into());
    let js = format!(
        "window.__qsEmit && window.__qsEmit({}, {});",
        serde_json::to_string(event).unwrap_or_else(|_| "\"\"".into()),
        json
    );
    let _ = global()
        .proxy_send(HostEvent::Eval { label, js });
}

impl Global {
    fn proxy_send(&self, e: HostEvent) {
        send_event(e);
    }
}

/// `EventLoopProxy` 是 Send 但**不是 Sync**，所以不能直接放 OnceLock 静态里，
/// 用 Mutex 包一层。取用时克隆一份即可（克隆很便宜）。
pub static PROXY: Mutex<Option<EventLoopProxy<HostEvent>>> = Mutex::new(None);

pub fn set_proxy(p: EventLoopProxy<HostEvent>) {
    if let Ok(mut g) = PROXY.lock() {
        *g = Some(p);
    }
}

pub fn send_event(e: HostEvent) {
    if let Ok(g) = PROXY.lock() {
        if let Some(p) = g.as_ref() {
            let _ = p.send_event(e);
        }
    }
}

// ---------------------------------------------------------------------------
// 建窗
// ---------------------------------------------------------------------------

pub struct WebviewWindowBuilder {
    label: String,
    url: String,
    title: String,
    inner_size: (f64, f64),
    pos: Option<(f64, f64)>,
    min_size: Option<(f64, f64)>,
    resizable: bool,
    maximizable: bool,
    minimizable: bool,
    center: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    decorations: bool,
    visible: bool,
    transparent: bool,
    shadow: bool,
    focused: bool,
    bg: Option<[u8; 4]>,
    browser_args: Option<String>,
}

impl WebviewWindowBuilder {
    pub fn new(app: &impl AsApp, label: &str, url: WebviewUrl) -> Self {
        let _ = app;
        let url = match url {
            WebviewUrl::App(p) => {
                let s = p.to_string_lossy().replace('\\', "/");
                format!("qs://localhost/{}", s.trim_start_matches('/'))
            }
            WebviewUrl::External(u) => u,
        };
        WebviewWindowBuilder {
            label: label.to_string(),
            url,
            title: "Quick Search".into(),
            inner_size: (800.0, 600.0),
            pos: None,
            min_size: None,
            resizable: true,
            maximizable: true,
            minimizable: true,
            center: false,
            always_on_top: false,
            skip_taskbar: false,
            decorations: true,
            visible: true,
            transparent: false,
            shadow: true,
            focused: true,
            bg: None,
            browser_args: None,
        }
    }

    pub fn title(mut self, t: &str) -> Self {
        self.title = t.to_string();
        self
    }
    pub fn inner_size(mut self, w: f64, h: f64) -> Self {
        self.inner_size = (w, h);
        self
    }
    pub fn position(mut self, x: f64, y: f64) -> Self {
        self.pos = Some((x, y));
        self
    }
    pub fn min_inner_size(mut self, w: f64, h: f64) -> Self {
        self.min_size = Some((w, h));
        self
    }
    pub fn resizable(mut self, v: bool) -> Self {
        self.resizable = v;
        self
    }
    pub fn maximizable(mut self, v: bool) -> Self {
        self.maximizable = v;
        self
    }
    pub fn minimizable(mut self, v: bool) -> Self {
        self.minimizable = v;
        self
    }
    pub fn center(mut self) -> Self {
        self.center = true;
        self
    }
    pub fn always_on_top(mut self, v: bool) -> Self {
        self.always_on_top = v;
        self
    }
    pub fn skip_taskbar(mut self, v: bool) -> Self {
        self.skip_taskbar = v;
        self
    }
    pub fn decorations(mut self, v: bool) -> Self {
        self.decorations = v;
        self
    }
    pub fn visible(mut self, v: bool) -> Self {
        self.visible = v;
        self
    }
    pub fn transparent(mut self, v: bool) -> Self {
        self.transparent = v;
        self
    }
    pub fn shadow(mut self, v: bool) -> Self {
        self.shadow = v;
        self
    }
    pub fn focused(mut self, v: bool) -> Self {
        self.focused = v;
        self
    }
    pub fn background_color(mut self, c: Color) -> Self {
        self.bg = Some([c.0, c.1, c.2, c.3]);
        self
    }
    pub fn additional_browser_args(mut self, a: &str) -> Self {
        self.browser_args = Some(a.to_string());
        self
    }

    pub fn build(self) -> Result<WebviewWindow> {
        let target: &'static EventLoopWindowTarget<HostEvent> = global()
            .target
            .get()
            .map(|c| unsafe { &*(c.0 as *const EventLoopWindowTarget<HostEvent>) })
            .ok_or_else(|| Error("事件循环未就绪".into()))?;

        use tao::platform::windows::WindowBuilderExtWindows;
        let mut wb = WindowBuilder::new()
            .with_title(&self.title)
            .with_inner_size(LogicalSize::new(self.inner_size.0, self.inner_size.1))
            .with_resizable(self.resizable)
            .with_maximizable(self.maximizable)
            .with_minimizable(self.minimizable)
            .with_decorations(self.decorations)
            .with_transparent(self.transparent)
            .with_always_on_top(self.always_on_top)
            .with_visible(self.visible)
            .with_focused(self.focused)
            .with_skip_taskbar(self.skip_taskbar)
            .with_undecorated_shadow(self.shadow);
        if let Some((w, h)) = self.min_size {
            wb = wb.with_min_inner_size(LogicalSize::new(w, h));
        }
        if let Some((x, y)) = self.pos {
            wb = wb.with_position(LogicalPosition::new(x, y));
        } else if self.center {
            wb = wb.with_position(LogicalPosition::new(200.0, 200.0));
        }
        let window = wb.build(target).map_err(Error::from)?;

        let init = BRIDGE_JS.replace("__QS_LABEL__", &self.label);
        let mut wvb = WebViewBuilder::new()
            .with_url(&self.url)
            .with_initialization_script(&init)
            .with_background_color({
                let c = self.bg.unwrap_or([0, 0, 0, 0]);
                (c[0], c[1], c[2], c[3])
            });

        if let Some(a) = &self.browser_args {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", a);
        }

        // 自定义协议：从磁盘 ui/ 目录读
        let _root = global().root.get().cloned().unwrap_or_default();
        wvb = wvb.with_custom_protocol("qs".into(), move |_id, req| serve(req));

        // IPC
        let label = self.label.clone();
        wvb = wvb.with_ipc_handler(move |req: wry::http::Request<String>| {
            let body = req.body().clone();
            if let Ok(mut q) = global().queue.lock() {
                q.push_back((label.clone(), body));
            }
            send_event(HostEvent::Pump);
        });

        if let Some(cb) = ON_PAGE_LOAD.get() {
            let cb = cb.clone();
            let label = self.label.clone();
            wvb = wvb.with_on_page_load_handler(move |event, url| {
                if let Some(app) = APP.get() {
                    let w = WebviewWindow {
                        app: app.clone(),
                        label: label.clone(),
                    };
                    let ev = match event {
                        wry::PageLoadEvent::Started => PageLoadEvent::Started,
                        wry::PageLoadEvent::Finished => PageLoadEvent::Finished,
                    };
                    cb(&w, PageLoadPayload { event: ev, url });
                }
            });
        }

        let webview = wvb.build(&window).map_err(Error::from)?;

        let id = window.id();
        ID2LABEL.with(|m| {
            m.borrow_mut().insert(id, self.label.clone());
        });
        WINS.with(|m| {
            m.borrow_mut().insert(
                self.label.clone(),
                WinSlot {
                    window: Some(window),
                    webview: Some(webview),
                    handlers: Vec::new(),
                    visible: self.visible,
                    title: self.title.clone(),
                },
            );
        });
        let hwnd_addr = {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            WINS.with(|m| {
                m.borrow()
                    .get(&self.label)
                    .and_then(|s| s.window.as_ref())
                    .and_then(|w| w.window_handle().ok())
                    .map(|h| match h.as_raw() {
                        RawWindowHandle::Win32(x) => x.hwnd.get() as isize,
                        _ => 0,
                    })
                    .unwrap_or(0)
            })
        };
        let isz = WINS
            .with(|m| m.borrow().get(&self.label).and_then(|s| s.window.as_ref().map(|w| w.inner_size())))
            .unwrap_or(tao::dpi::PhysicalSize::new(0, 0));

        let mut labels_ok = false;
        if let Some(app) = APP.get() {
            if let Ok(mut s) = app.0.labels.lock() {
                s.insert(self.label.clone());
            }
            if let Ok(mut st) = app.0.states.lock() {
                st.insert(
                    self.label.clone(),
                    WinState {
                        visible: self.visible,
                        title: self.title.clone(),
                        w: isz.width,
                        h: isz.height,
                        x: self.pos.map(|p| p.0 as i32).unwrap_or(0),
                        y: self.pos.map(|p| p.1 as i32).unwrap_or(0),
                        hwnd: hwnd_addr,
                    },
                );
                labels_ok = true;
            }
        }
        let _ = labels_ok;

        Ok(WebviewWindow {
            app: APP
                .get()
                .cloned()
                .ok_or_else(|| Error("AppHandle 未初始化".into()))?,
            label: self.label,
        })
    }
}

pub static APP: OnceLock<AppHandle> = OnceLock::new();

// ---------------------------------------------------------------------------
// 协议（静态文件）
// ---------------------------------------------------------------------------

fn mime_of(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".html") || p.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if p.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if p.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if p.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".svg") {
        "image/svg+xml"
    } else if p.ends_with(".woff2") {
        "font/woff2"
    } else if p.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

/// 百分号解码（`%E7%99%BE` → `百`）。
///
/// 必需：前端用中文文件名引用图标（`data/icons/百度.png`），浏览器会把它们
/// 编码成 `%E7%99%BE...` 再发请求。不解码就直接拿编码串去 join 路径，
/// 结果一律 404 —— 表现就是"只有英文名的几个图标能显示"。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
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
    String::from_utf8_lossy(&out).into_owned()
}

/// 构建期生成的前端压缩包（见 build.rs）：整包 deflate。
///
/// 为什么不逐文件 `include_bytes!`：前端原始 4.36 MB（图标 2.54 + 文本 1.82），
/// 直接嵌会让 exe 从 5.07 MB 变成 9.57 MB。整包压缩后约 1.8 MB。
static EMBEDDED_UI_PACKED: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui.bundle"));

/// 解压后的前端（首次访问时构建一次，之后就是查表）。
static EMBEDDED_UI: std::sync::OnceLock<std::collections::HashMap<String, Vec<u8>>> =
    std::sync::OnceLock::new();

/// 包格式：`QSUI1` | u32 条目数 | 重复{ u16 名字长 | 名字 | u32 数据长 | 数据 }
fn embedded_ui() -> &'static std::collections::HashMap<String, Vec<u8>> {
    EMBEDDED_UI.get_or_init(|| {
        use std::io::Read as _;
        let mut map = std::collections::HashMap::new();
        let mut raw: Vec<u8> = Vec::new();
        let mut d = flate2::read::DeflateDecoder::new(EMBEDDED_UI_PACKED);
        if d.read_to_end(&mut raw).is_err() || raw.len() < 9 || &raw[..5] != b"QSUI1" {
            trace("embedded ui: 解压失败，前端将不可用");
            return map;
        }
        let mut i = 5usize;
        let Ok(cnt_b) = <[u8; 4]>::try_from(&raw[i..i + 4]) else { return map };
        let cnt = u32::from_le_bytes(cnt_b) as usize;
        i += 4;
        for _ in 0..cnt {
            if i + 2 > raw.len() {
                break;
            }
            let Ok(nl_b) = <[u8; 2]>::try_from(&raw[i..i + 2]) else { break };
            let nl = u16::from_le_bytes(nl_b) as usize;
            i += 2;
            if i + nl + 4 > raw.len() {
                break;
            }
            let name = String::from_utf8_lossy(&raw[i..i + nl]).into_owned();
            i += nl;
            let Ok(dl_b) = <[u8; 4]>::try_from(&raw[i..i + 4]) else { break };
            let dl = u32::from_le_bytes(dl_b) as usize;
            i += 4;
            if i + dl > raw.len() {
                break;
            }
            map.insert(name, raw[i..i + dl].to_vec());
            i += dl;
        }
        trace(&format!("embedded ui: 解压 {} 个文件，{} KB", map.len(), raw.len() / 1024));
        map
    })
}

fn serve(req: wry::http::Request<Vec<u8>>) -> wry::http::Response<std::borrow::Cow<'static, [u8]>> {
    use std::borrow::Cow;
    let path = req.uri().path().to_string();
    let path = percent_decode(&path);
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.contains("..") {
        return wry::http::Response::builder()
            .status(403)
            .body(Cow::Owned(b"forbidden".to_vec()))
            .unwrap();
    }
    /* ① 先查内嵌表 —— 发布版 exe 旁边没有 ui/ 目录，全靠这一路。
     *    放最前面还有个好处：用户/开发者本机残留的旧 ui/ 不会悄悄顶掉新版本。 */
    if let Some(bytes) = embedded_ui().get(rel) {
        return wry::http::Response::builder()
            .header("Content-Type", mime_of(&path))
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .body(Cow::Owned(bytes.clone()))
            .unwrap();
    }
    // ② 内嵌里没有 → 退回到 exe 同目录的 ui/（开发期便于直接改文件看效果）
    let root = global().root.get().cloned().unwrap_or_default();
    let file = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    match std::fs::read(&file) {
        Ok(bytes) => wry::http::Response::builder()
            .header("Content-Type", mime_of(&path))
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(e) => wry::http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(Cow::Owned(format!("404 {rel}: {e}").into_bytes()))
            .unwrap(),
    }
}

// ---------------------------------------------------------------------------
// 前端垫层：window.__TAURI__
// ---------------------------------------------------------------------------

pub const BRIDGE_JS: &str = include_str!("bridge.js");

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 菜单 / 托盘（先提供可编译的最小实现，后续补真实现）
// ---------------------------------------------------------------------------

pub mod menu {
    use super::{AppHandle, Result};
    use std::marker::PhantomData;

    #[derive(Clone, Debug)]
    pub struct MenuId(pub String);

    impl AsRef<str> for MenuId {
        fn as_ref(&self) -> &str {
            &self.0
        }
    }

    #[derive(Clone, Debug)]
    pub struct MenuEvent {
        pub id: MenuId,
    }

    impl MenuEvent {
        pub fn id(&self) -> MenuId {
            self.id.clone()
        }
    }

    #[derive(Clone)]
    pub struct MenuItem {
        pub id: String,
        pub text: String,
        pub checked: bool,
    }

    pub struct MenuItemBuilder {
        id: String,
        text: String,
        checked: bool,
    }
    impl MenuItemBuilder {
        pub fn with_id(id: &str, text: &str) -> Self {
            MenuItemBuilder {
                id: id.into(),
                text: text.into(),
                checked: false,
            }
        }
        pub fn checked(mut self, v: bool) -> Self {
            self.checked = v;
            self
        }
        pub fn build(self, _a: &AppHandle) -> Result<MenuItem> {
            Ok(MenuItem {
                id: self.id,
                text: self.text,
                checked: self.checked,
            })
        }
    }

    pub struct Menu<R: 'static = ()> {
        pub items: Vec<MenuItem>,
        pub _p: PhantomData<R>,
    }

    impl<R> Clone for Menu<R> {
        fn clone(&self) -> Self {
            Menu {
                items: self.items.clone(),
                _p: PhantomData,
            }
        }
    }

    pub struct MenuBuilder<R: 'static = ()> {
        items: Vec<MenuItem>,
        _p: PhantomData<R>,
    }

    impl<R: 'static> MenuBuilder<R> {
        pub fn new(_a: &AppHandle) -> Self {
            MenuBuilder {
                items: Vec::new(),
                _p: PhantomData,
            }
        }
        pub fn item(mut self, i: &MenuItem) -> Self {
            self.items.push(i.clone());
            self
        }
        pub fn items(mut self, list: &[&MenuItem]) -> Self {
            for i in list {
                self.items.push((*i).clone());
            }
            self
        }
        pub fn separator(self) -> Self {
            self
        }
        pub fn text(mut self, id: &str, t: &str) -> Self {
            self.items.push(MenuItem {
                id: id.into(),
                text: t.into(),
                checked: false,
            });
            self
        }
        pub fn build(self) -> Result<Menu<R>> {
            Ok(Menu {
                items: self.items,
                _p: PhantomData,
            })
        }
    }
}

pub mod tray {
    use super::menu::{Menu, MenuEvent};
    use super::{AppHandle, Result};
    use crate::t::image::Image;
    use std::marker::PhantomData;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum MouseButton {
        Left,
        Right,
        Middle,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum MouseButtonState {
        Up,
        Down,
    }

    #[derive(Clone, Debug)]
    pub enum TrayIconEvent {
        Click {
            id: String,
            position: (f64, f64),
            rect: (f64, f64, f64, f64),
            button: MouseButton,
            button_state: MouseButtonState,
        },
        DoubleClick {
            id: String,
            position: (f64, f64),
            rect: (f64, f64, f64, f64),
            button: MouseButton,
        },
        Enter { id: String },
        Move { id: String },
        Leave { id: String },
    }

    pub struct TrayIconBuilder<R: 'static = ()> {
        id: String,
        icon: Option<Image>,
        menu: Option<Menu<R>>,
        tooltip: Option<String>,
        left_click_menu: bool,
        on_menu: Option<Box<dyn Fn(&AppHandle, MenuEvent) + Send + Sync>>,
        on_event: Option<Box<dyn Fn(&TrayIcon<R>, TrayIconEvent) + Send + Sync>>,
    }

    impl<R: 'static> TrayIconBuilder<R> {
        pub fn with_id(id: &str) -> Self {
            TrayIconBuilder {
                id: id.into(),
                icon: None,
                menu: None,
                tooltip: None,
                left_click_menu: true,
                on_menu: None,
                on_event: None,
            }
        }
        pub fn icon(mut self, i: Image) -> Self {
            self.icon = Some(i);
            self
        }
        pub fn menu(mut self, m: &Menu<R>) -> Self {
            self.menu = Some(m.clone());
            self
        }
        pub fn tooltip(mut self, t: &str) -> Self {
            self.tooltip = Some(t.into());
            self
        }
        pub fn show_menu_on_left_click(mut self, v: bool) -> Self {
            self.left_click_menu = v;
            self
        }
        pub fn on_menu_event<F: Fn(&AppHandle, MenuEvent) + Send + Sync + 'static>(
            mut self,
            f: F,
        ) -> Self {
            self.on_menu = Some(Box::new(f));
            self
        }
        pub fn on_tray_icon_event<F>(mut self, f: F) -> Self
        where
            F: Fn(&TrayIcon<R>, TrayIconEvent) + Send + Sync + 'static,
        {
            self.on_event = Some(Box::new(f));
            self
        }
        pub fn build(self, _a: &AppHandle) -> Result<TrayIcon<R>> {
            let id = self.id.clone();
            let tip = self.tooltip.clone().unwrap_or_default();
            let items: Vec<(String, String, bool)> = self
                .menu
                .as_ref()
                .map(|m| {
                    m.items
                        .iter()
                        .map(|i| (i.id.clone(), i.text.clone(), i.checked))
                        .collect()
                })
                .unwrap_or_default();
            let png = self.icon.as_ref().map(|i| i.bytes.clone()).unwrap_or_default();

            // 菜单回调：(app, MenuEvent)
            let on_menu: Box<dyn Fn(&str) + Send + Sync> = match self.on_menu {
                Some(f) => Box::new(move |mid: &str| {
                    if let Some(a) = super::APP.get() {
                        f(
                            a,
                            super::menu::MenuEvent {
                                id: super::menu::MenuId(mid.to_string()),
                            },
                        );
                    }
                }),
                None => Box::new(|_: &str| {}),
            };

            // 图标事件回调：托盘只给鼠标消息，这里翻译成 TrayIconEvent
            let tray_id = id.clone();
            let on_event: Box<dyn Fn(u32) + Send + Sync> = match self.on_event {
                Some(f) => Box::new(move |msg: u32| {
                    const WM_LBUTTONDBLCLK: u32 = 0x0203;
                    let ev = if msg == WM_LBUTTONDBLCLK {
                        TrayIconEvent::DoubleClick {
                            id: tray_id.clone(),
                            position: (0.0, 0.0),
                            rect: (0.0, 0.0, 0.0, 0.0),
                            button: MouseButton::Left,
                        }
                    } else {
                        TrayIconEvent::Click {
                            id: tray_id.clone(),
                            position: (0.0, 0.0),
                            rect: (0.0, 0.0, 0.0, 0.0),
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                        }
                    };
                    let dummy: TrayIcon<R> = TrayIcon {
                        id: tray_id.clone(),
                        icon: None,
                        menu: None,
                        tooltip: None,
                        tooltip_text: None,
                        _p: PhantomData,
                        on_menu: None,
                        on_event: None,
                    };
                    f(&dummy, ev);
                }),
                None => Box::new(|_: u32| {}),
            };

            crate::trayhost::install(
                crate::trayhost::TrayDef {
                    id: id.clone(),
                    tip,
                    items,
                },
                &png,
                on_menu,
                on_event,
            );

            Ok(TrayIcon {
                id,
                icon: None,
                menu: None,
                tooltip: self.tooltip,
                tooltip_text: None,
                _p: PhantomData,
                on_menu: None,
                on_event: None,
            })
        }
    }

    pub struct TrayIcon<R: 'static = ()> {
        pub id: String,
        pub icon: Option<Image>,
        pub menu: Option<Menu<R>>,
        pub tooltip: Option<String>,
        pub tooltip_text: Option<String>,
        pub _p: PhantomData<R>,
        #[allow(clippy::type_complexity)]
        pub on_menu: Option<Box<dyn Fn(&AppHandle, MenuEvent) + Send + Sync>>,
        #[allow(clippy::type_complexity)]
        pub on_event: Option<Box<dyn Fn(&TrayIcon<R>, TrayIconEvent) + Send + Sync>>,
    }

    impl<R: 'static> TrayIcon<R> {
        pub fn set_icon(&self, i: Option<Image>) -> Result<()> {
            if let Some(img) = i {
                crate::trayhost::set_icon(&img.bytes);
            }
            Ok(())
        }
        pub fn set_tooltip(&self, t: Option<&str>) -> Result<()> {
            if let Some(t) = t {
                crate::trayhost::set_tooltip(t);
            }
            Ok(())
        }
        pub fn set_menu<M>(&self, m: Option<Menu<M>>) -> Result<()> {
            if let Some(m) = m {
                let items = m
                    .items
                    .iter()
                    .map(|i| (i.id.clone(), i.text.clone(), i.checked))
                    .collect();
                crate::trayhost::set_menu(items);
            }
            Ok(())
        }
    }

    // 托盘注册表：`tray_by_id` 用。只存元数据，真正的系统托盘在 host 侧。
    static TRAY_IDS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    fn tray_register<R>(t: &TrayIcon<R>) {
        if let Ok(mut v) = TRAY_IDS.lock() {
            if !v.contains(&t.id) {
                v.push(t.id.clone());
            }
        }
    }

    pub fn tray_exists(id: &str) -> bool {
        TRAY_IDS
            .lock()
            .map(|v| v.iter().any(|x| x == id))
            .unwrap_or(false)
    }
}

/// 页面加载完成回调的载荷（对应 tauri 的 PageLoadPayload）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageLoadEvent {
    Started,
    Finished,
}

pub struct PageLoadPayload {
    pub event: PageLoadEvent,
    pub url: String,
}

impl PageLoadPayload {
    pub fn event(&self) -> PageLoadEvent {
        self.event
    }
    pub fn url(&self) -> &str {
        &self.url
    }
}

#[allow(clippy::type_complexity)]
pub static ON_PAGE_LOAD: OnceLock<Arc<dyn Fn(&WebviewWindow, PageLoadPayload) + Send + Sync>> =
    OnceLock::new();

// ---------------------------------------------------------------------------
// 事件循环驱动
// ---------------------------------------------------------------------------

/// 主线程事件循环：处理 IPC、emit、投递任务。
///
/// `boot` 在事件循环第一次回调时执行 —— 那时才拿得到 `WindowTarget`，
/// 而建窗必须有它。tao 没有别的口子把 target 交出来，所以这里做一次
/// `'static` 转换（target 活得比整个循环长，安全）。
pub fn drive<F: FnOnce(&mut App) + 'static>(
    event_loop: EventLoop<HostEvent>,
    handle: AppHandle,
    f: F,
) {
    let mut app = App { handle };
    let mut boot = Some(f);
    let mut booted = false;
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        if !booted {
            booted = true;
            let t: &'static EventLoopWindowTarget<HostEvent> =
                unsafe { std::mem::transmute(target) };
            let _ = global().target.set(TargetCell(t as *const _ as usize));
            trace("drive: first tick, calling setup");
            if let Some(f) = boot.take() {
                f(&mut app);
            }
            trace("drive: setup returned");
        }
        match event {
            tao::event::Event::UserEvent(HostEvent::Pump) => drain_ipc(),
            tao::event::Event::UserEvent(HostEvent::Eval { label, js }) => match label {
                Some(l) => eval_in(&l, &js),
                None => {
                    let labels: Vec<String> =
                        WINS.with(|m| m.borrow().keys().cloned().collect::<Vec<_>>());
                    for l in labels {
                        eval_in(&l, &js);
                    }
                }
            },
            tao::event::Event::UserEvent(HostEvent::Job(f)) => f(),
            tao::event::Event::UserEvent(HostEvent::Exit(code)) => {
                *control_flow = ControlFlow::ExitWithCode(code)
            }
            tao::event::Event::WindowEvent { window_id, event, .. } => {
                handle_window_event(window_id, &event);
            }
            _ => {}
        }
    });
}

fn eval_in(label: &str, js: &str) {
    WINS.with(|m| {
        if let Some(slot) = m.borrow().get(label) {
            if let Some(wv) = slot.webview.as_ref() {
                let _ = wv.evaluate_script(js);
            }
        }
    });
}

fn handle_window_event(window_id: WindowId, event: &tao::event::WindowEvent) {
    let label = ID2LABEL.with(|m| m.borrow().get(&window_id).cloned());
    let Some(label) = label else { return };

    // 先更新跨线程状态镜像
    if let Some(app) = APP.get() {
        if let Ok(mut g) = app.0.states.lock() {
            if let Some(st) = g.get_mut(&label) {
                match event {
                    tao::event::WindowEvent::Resized(sz) => {
                        st.w = sz.width;
                        st.h = sz.height;
                    }
                    tao::event::WindowEvent::Moved(p) => {
                        st.x = p.x;
                        st.y = p.y;
                    }
                    _ => {}
                }
            }
        }
    }

    let mapped = match event {
        tao::event::WindowEvent::CloseRequested { .. } => Some(WindowEvent::CloseRequested {
            api: CloseApi::default(),
        }),
        tao::event::WindowEvent::Destroyed => Some(WindowEvent::Destroyed),
        tao::event::WindowEvent::Focused(b) => Some(WindowEvent::Focused(*b)),
        tao::event::WindowEvent::Resized(s) => Some(WindowEvent::Resized(*s)),
        tao::event::WindowEvent::Moved(p) => Some(WindowEvent::Moved(*p)),
        _ => None,
    };
    let Some(ev) = mapped else { return };

    let handlers: Vec<WinHandler> = APP
        .get()
        .and_then(|a| {
            a.0.handlers
                .lock()
                .ok()
                .and_then(|g| g.get(&label).cloned())
        })
        .unwrap_or_default();

    let prevented = if let WindowEvent::CloseRequested { api } = &ev {
        Some(api.prevented.clone())
    } else {
        None
    };
    for h in &handlers {
        h(&ev);
    }
    if let Some(p) = prevented {
        if !*p.lock().unwrap_or_else(|e| e.into_inner()) {
            let label2 = label.clone();
            if let Some(app) = APP.get() {
                if let Ok(mut l) = app.0.labels.lock() {
                    l.remove(&label2);
                }
                if let Ok(mut st) = app.0.states.lock() {
                    st.remove(&label2);
                }
            }
            WINS.with(|m| {
                if let Some(mut slot) = m.borrow_mut().remove(&label2) {
                    slot.webview.take();
                    slot.window.take();
                }
            });
        }
    }
}

fn drain_ipc() {
    let mut batch = Vec::new();
    if let Ok(mut q) = global().queue.lock() {
        while let Some(x) = q.pop_front() {
            batch.push(x);
        }
    }
    for (label, body) in batch {
        run_ipc(&label, &body);
    }
}

fn run_ipc(label: &str, body: &str) {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[qs] ipc 解析失败: {e}");
            return;
        }
    };
    // 前端发来的 emit
    if v.get("kind").and_then(|k| k.as_str()) == Some("emit") {
        return;
    }
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let args = v.get("args").cloned().unwrap_or(Value::Null);

    let app = match APP.get() {
        Some(a) => a.clone(),
        None => return,
    };
    let ctx = Ctx::new(app, label);

    let table = match global_cmds() {
        Some(t) => t,
        None => {
            reply(label, &id, false, "\"命令表未就绪\"");
            return;
        }
    };

    let Some(f) = table.get(cmd.as_str()) else {
        reply(label, &id, false, &format!("\"未知命令 {cmd}\""));
        return;
    };
    match f(&ctx, &args) {
        Ok(v) => reply(label, &id, true, &v.to_string()),
        Err(e) => reply(label, &id, false, &serde_json::to_string(&e).unwrap_or("\"\"".into())),
    }
}

fn reply(label: &str, id: &Value, ok: bool, payload: &str) {
    let js = format!("window.__qsIpc&&window.__qsIpc.resolve({}, {}, {});", id, ok, payload);
    eval_in(label, &js);
}

static CMDS: OnceLock<HashMap<&'static str, Invoker>> = OnceLock::new();

pub fn global_cmds() -> Option<&'static HashMap<&'static str, Invoker>> {
    CMDS.get()
}

// ---------------------------------------------------------------------------
// Builder / App —— 与原项目启动段同形，让 main.rs 尾部几乎原样编译
// ---------------------------------------------------------------------------

pub struct App {
    handle: AppHandle,
}

impl App {
    pub fn handle(&self) -> &AppHandle {
        &self.handle
    }
    pub fn path(&self) -> PathResolver {
        self.handle.path()
    }
    pub fn exit(&self, code: i32) {
        self.handle.exit(code);
    }
    pub fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
        self.handle.run_on_main_thread(f)
    }
}

impl Manager for App {
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow> {
        self.handle.get_webview_window(label)
    }
    fn windows(&self) -> HashMap<String, WebviewWindow> {
        self.handle.windows()
    }
    fn path(&self) -> PathResolver {
        self.handle.path()
    }
}

impl Emitter for App {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        self.handle.emit(event, payload)
    }
    fn emit_to<S: Serialize + Clone, T: Target>(
        &self,
        target: T,
        event: &str,
        payload: S,
    ) -> Result<()> {
        self.handle.emit_to(target, event, payload)
    }
}

pub trait AsApp {
    fn as_app(&self) -> AppHandle;
}
impl AsApp for AppHandle {
    fn as_app(&self) -> AppHandle {
        self.clone()
    }
}
impl AsApp for App {
    fn as_app(&self) -> AppHandle {
        self.handle.clone()
    }
}

type SetupFn = Box<dyn FnOnce(&mut App) -> std::result::Result<(), Box<dyn std::error::Error>>>;
type WinEventFn = Box<dyn Fn(&WebviewWindow, &WindowEvent) + Send + Sync>;

#[derive(Default)]
pub struct Builder {
    cmds: Vec<(&'static str, Invoker)>,
    setup: Option<SetupFn>,
    on_window: Option<Arc<WinEventFn>>,
}

impl Builder {
    pub fn default_builder() -> Self {
        Builder::default()
    }
    pub fn invoke_handler(mut self, v: Vec<(&'static str, Invoker)>) -> Self {
        self.cmds = v;
        self
    }
    pub fn setup<F>(mut self, f: F) -> Self
    where
        F: FnOnce(&mut App) -> std::result::Result<(), Box<dyn std::error::Error>> + 'static,
    {
        self.setup = Some(Box::new(f));
        self
    }
    pub fn on_window_event<F>(mut self, f: F) -> Self
    where
        F: Fn(&WebviewWindow, &WindowEvent) + Send + Sync + 'static,
    {
        self.on_window = Some(Arc::new(Box::new(f)));
        self
    }
    pub fn on_page_load<F>(self, f: F) -> Self
    where
        F: Fn(&WebviewWindow, PageLoadPayload) + Send + Sync + 'static,
    {
        let _ = ON_PAGE_LOAD.set(Arc::new(f));
        self
    }

    pub fn run(self, _ctx: ()) -> Result<()> {
        std::panic::set_hook(Box::new(|info| {
            trace(&format!("PANIC: {info}"));
        }));
        trace("run: enter");
        let mut map: HashMap<&'static str, Invoker> = HashMap::new();
        for (k, v) in self.cmds {
            map.insert(k, v);
        }
        let _ = CMDS.set(map);

        trace(&format!("run: cmds={}", CMDS.get().map(|m| m.len()).unwrap_or(0)));
        let event_loop = tao::event_loop::EventLoopBuilder::<HostEvent>::with_user_event()
            .build();
        trace("run: event_loop built");
        set_proxy(event_loop.create_proxy());
        trace("run: proxy set");

        let g = Arc::new(Global {
            target: OnceLock::new(),
            queue: Mutex::new(VecDeque::new()),
            root: OnceLock::new(),
        });
        let _ = g.root.set(crate::ui_root());
        let _ = G.set(g);
        trace(&format!("run: global root={:?}", crate::ui_root()));

        let _ = MAIN_TID.set(std::thread::current().id());
        let handle = AppHandle(Arc::new(Inner {
            cmds: OnceLock::new(),
            labels: Mutex::new(HashSet::new()),
            states: Mutex::new(HashMap::new()),
            handlers: Mutex::new(HashMap::new()),
        }));
        let _ = APP.set(handle.clone());
        trace("run: app set");

        if let Some(f) = self.on_window {
            let _ = BUILDER_WIN_EVENT.set(f);
        }

        let mut setup = self.setup;
        drive(event_loop, handle, move |app| {
            if let Some(f) = setup.take() {
                if let Err(e) = f(app) {
                    eprintln!("[qs] setup 失败: {e}");
                }
            }
        });
        Ok(())
    }
}

pub static BUILDER_WIN_EVENT: OnceLock<Arc<WinEventFn>> = OnceLock::new();


// ---------------------------------------------------------------------------
// 宏再导出（main.rs 里用 `#[command]` / `crate::t::generate_handler![..]`）
// ---------------------------------------------------------------------------

pub use qs_macros::{command, generate_handler};

// ---------------------------------------------------------------------------
// 二进制回传（对应 tauri::ipc::Response）
// ---------------------------------------------------------------------------

impl Serialize for ipc::Response {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Raw", 1)?;
        st.serialize_field("__qsRaw", &b64_encode(&self.0))?;
        st.end()
    }
}

pub fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// 窗口操作命令（JS 侧 window 代理用）
// ---------------------------------------------------------------------------


