//! Win32 底层封装：输入模拟、光标定位、提权、开机自启。
#![allow(dead_code)]
#![allow(non_snake_case)]

use std::time::{Duration, Instant};

// 注：windows-rs 的 implement 宏生成代码里用 `::windows_core::` 绝对路径，
// 所以 windows-core 在 Cargo.toml 里提成了直接依赖（extern prelude 可解析）。
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, ScreenToClient, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    SRCCOPY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::DataExchange::GetClipboardOwner;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, UIA_TextPatternId,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, GetCurrentThreadId, GetGuiResources, GetProcessHandleCount,
    OpenProcess, QueryFullProcessImageNameW, AttachThreadInput, GR_GDIOBJECTS, GR_USEROBJECTS,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY,
    REG_SZ,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetDoubleClickTime, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_C, VK_V, VK_MENU, VK_RBUTTON, VK_RETURN,
    VK_SHIFT,
    VK_LWIN, VK_RWIN, VK_TAB, VK_ESCAPE, VK_SPACE, VK_BACK, VK_DELETE, VK_INSERT, VK_HOME, VK_END,
    VK_LBUTTON,
    VK_PRIOR, VK_NEXT, VK_UP, VK_DOWN, VK_LEFT, VK_RIGHT, VK_SNAPSHOT, VK_PAUSE, VK_APPS,
    VK_CAPITAL, VK_F1, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_F10, VK_F11,
    VK_F12, VK_F13, VK_F14, VK_F15, VK_F16, VK_F17, VK_F18, VK_F19, VK_F20, VK_F21, VK_F22, VK_F23,
    VK_F24, VK_OEM_COMMA, VK_OEM_PERIOD, VK_OEM_2, VK_OEM_1, VK_OEM_7, VK_OEM_4, VK_OEM_6,
    VK_OEM_5, VK_OEM_MINUS, VK_OEM_PLUS, VK_OEM_3, VK_NUMPAD0, VK_NUMPAD1, VK_NUMPAD2,
    VK_NUMPAD3, VK_NUMPAD4, VK_NUMPAD5, VK_NUMPAD6, VK_NUMPAD7, VK_NUMPAD8, VK_NUMPAD9,
    // 「窗口消息取词」通道要用的：键盘状态 + 虚拟键→扫描码
    GetKeyboardState, SetKeyboardState, MapVirtualKeyW, MAPVK_VK_TO_VSC,
    /* r89b：`keybd_event` —— 全局热键类应用（Octoclip 那种用 RegisterHotKey
     * 注册的）只有它唤得起来，`SendInput` 不行（见 `send_hotkey` 里的实测表）。
     * 它已被微软标为 legacy，但这里关系到**功能能不能用**，不是口味问题。 */
    keybd_event, KEYBD_EVENT_FLAGS,
};
use windows::Win32::UI::Shell::{IsUserAnAdmin, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GA_PARENT, GA_ROOT, GetAncestor, GetClassNameW, GetClientRect, GetCursorPos,
    GetForegroundWindow, GetGUIThreadInfo, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextW,
    GW_HWNDNEXT, GetTopWindow, GetDesktopWindow, GW_CHILD,
    GetSystemMetrics, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
    IsIconic,
    // 「窗口消息取词」通道：不经过输入队列，绕过对"注入按键"的过滤
    PostMessageW, WM_COPY, WM_KEYDOWN, WM_KEYUP, GetParent,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, WindowFromPoint, GUITHREADINFO, GWL_EXSTYLE,
    HWND_TOPMOST, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
    SW_SHOWNORMAL, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    WS_EX_TOOLWINDOW, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT,
    IsWindow, WM_CLOSE, WM_SYSCOMMAND, SC_CLOSE,
    // UIA 探针唤醒用：带超时的消息发送，防对方进程卡死把我们也拖住
    SendMessageTimeoutW, SMTO_ABORTIFHUNG,
    // r58「快捷键绑定应用」要枚举顶层窗口，找出目标应用的窗口
    EnumWindows,
};
use windows::Win32::System::ProcessStatus::EnumProcesses;

pub const _MONITOR_NEAREST: windows::Win32::Graphics::Gdi::MONITOR_FROM_FLAGS =
    MONITOR_DEFAULTTONEAREST;

/* ------------------------------------------------------------------ */
/* 字符串                                                              */
/* ------------------------------------------------------------------ */

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/* ------------------------------------------------------------------ */
/* 调试日志（只在 QS_DEBUG=1 时写文件，正式使用不产生任何 IO）          */
/* ------------------------------------------------------------------ */

/* 日志写入用的后台线程和通道。
 *
 * 为什么要有它：调用方里有**鼠标低级钩子回调**（hook.rs 的 mouse_proc）和
 * 20ms 一次的轮询线程。低级钩子有系统级的超时限制（LowLevelHooksTimeout，
 * 默认 300ms）——回调里做任何耗时的事都有可能被系统**静默卸载钩子**，之后划词
 * 全哑、日志里还什么线索都没有。以前每条日志都是"打开文件 + 写一行 + 关闭"，
 * QS_DEBUG=1 时每次鼠标移动都在做磁盘 IO。
 * 现在 log() 只往通道里塞一行（队列满就丢弃），真正的文件 IO 由后台线程批量做。 */
static LOG_TX: std::sync::OnceLock<Option<std::sync::mpsc::SyncSender<String>>> =
    std::sync::OnceLock::new();

fn log_writer() -> Option<&'static std::sync::mpsc::SyncSender<String>> {
    LOG_TX
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::sync_channel::<String>(2048);
            if std::thread::Builder::new()
                .name("qs-log".into())
                .spawn(move || log_flush_loop(rx))
                .is_err()
            {
                return None;
            }
            Some(tx)
        })
        .as_ref()
}

fn log_flush_loop(rx: std::sync::mpsc::Receiver<String>) {
    use std::io::Write;
    let p = crate::config::data_dir().join("log.txt");
    let mut buf: Vec<String> = Vec::new();
    loop {
        // 攒够一批、或等 300ms 没新东西就落一次盘；期间开着的句柄一直复用。
        match rx.recv_timeout(std::time::Duration::from_millis(300)) {
            Ok(line) => buf.push(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if buf.is_empty() {
                    continue;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
        while buf.len() < 512 {
            match rx.try_recv() {
                Ok(line) => buf.push(line),
                Err(_) => break,
            }
        }
        if buf.is_empty() {
            continue;
        }
        // 超过 2MB 就从头重写（截由 sink 保证：本机调试常年开着也不至于长到几百 MB）
        let too_big = std::fs::metadata(&p).map(|m| m.len() > 2_000_000).unwrap_or(false);
        let mut opt = std::fs::OpenOptions::new();
        opt.create(true).append(true);
        if too_big {
            opt.append(false).truncate(true).write(true);
        }
        if let Ok(mut f) = opt.open(&p) {
            if too_big {
                let _ = writeln!(f, "[log 超过 2MB，已从头开始]");
            }
            for line in buf.drain(..) {
                let _ = writeln!(f, "{}", line);
            }
            let _ = f.flush();
        }
    }
}

/// 日志开关：以下任意一条成立就写日志。
///
///   · 环境变量 `QS_DEBUG=1` —— 开发 / 自动化脚本用；
///   · 环境变量 `QS_LOG=1`；
///   · 数据目录（`%APPDATA%\QuickSearch`）下存在标记文件 `log.on`。
///
/// 加第三条是因为真实教训：用户双击 exe 启动时**根本没机会带环境变量**，
/// 而"让用户改快捷方式/敲命令"这种事在排查里成功率极低 —— 结果就是
/// "日志里一行都没有"，双方都在猜。放一个空文件是最低成本的开关，
/// 放/删都由我们自己控制，用户什么都不用做。
fn log_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        // 便携测试版一律写日志：排查问题全靠它，不能让用户去设环境变量。
        if crate::QS_LITE_PORTABLE {
            return true;
        }
        if std::env::var("QS_DEBUG").map(|v| v == "1").unwrap_or(false) {
            return true;
        }
        if std::env::var("QS_LOG").map(|v| v == "1").unwrap_or(false) {
            return true;
        }
        crate::config::data_dir().join("log.on").exists()
    })
}

pub fn log(msg: &str) {
    if !log_on() {
        return;
    }
    let Some(tx) = log_writer() else { return };
    let line = format!("[{:?}] {}", std::time::SystemTime::now(), msg);
    // try_send：队列满就丢 —— 日志永远是"有就行"，绝不能反过来把业务线程堵住
    // （堵住的后果可能是钩子超时被系统卸载，那才是真正的事故）。
    let _ = tx.try_send(line);
}

/// **同步**写一行日志（绕过后台队列，直接落盘）。
///
/// 只给「马上就要 `std::process::exit`」的那几条路径用：启动行、单实例退出、
/// 提权后退出。这些行是在 exit 之前**几百微秒**内产生的，后台写线程大概率还没被
/// 调度到，走队列的话这一行会直接丢 —— 排查时的表现是「日志里一行都没有，
/// 看起来像日志开关没生效」，这个坑实打实吃过（新实例因单实例保护秒退，
/// 日志里连一行 start 都没有，白猜了两轮）。
pub fn log_sync(msg: &str) {
    if !log_on() {
        return;
    }
    use std::io::Write;
    let p = crate::config::data_dir().join("log.txt");
    let line = format!("[{:?}] {}", std::time::SystemTime::now(), msg);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", line);
        let _ = f.flush();
    }
}

/// 弹一个**原生**消息框（阻塞，直到用户点确定）。
///
/// 只给"程序马上就要退出、而且用户必须知道为什么"的那几条路径用 ——
/// 现在只有一处：启动时建 WebView2 失败（通常是上一个实例刚被杀、它的
/// WebView2 用户数据目录还没释放）。那种情况下程序会静默消失，
/// 用户只会觉得"点了没反应，要再点一次"。
///
/// 用 Win32 的 `MessageBoxW` 而不是 Tauri 的对话框：这个时候 Tauri 的
/// 事件循环还没建起来，任何依赖它的东西都用不了。
pub fn message_box(title: &str, text: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    let t = wide(title);
    let m = wide(text);
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(m.as_ptr()),
            PCWSTR(t.as_ptr()),
            MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}

/// 带「是 / 否」的原生消息框：**点「是」返回 true**。
///
/// 用途见 `main` 里的 WebView2 检查 —— 那里要问"要不要现在去下载"，
/// 用带链接的窗口做不到（没有 WebView2 就没有任何 HTML 能力，这正是要提示
/// 的那件事），所以只能靠原生对话框的两个按钮当"可点击的下载入口"。
pub fn message_box_yes_no(title: &str, text: &str) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    let t = wide(title);
    let m = wide(text);
    let r = unsafe {
        MessageBoxW(
            None,
            PCWSTR(m.as_ptr()),
            PCWSTR(t.as_ptr()),
            MB_YESNO | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
        )
    };
    r == IDYES
}

/* ------------------------------------------------------------------ */
/* WebView2 运行时检查                                                  */
/* ------------------------------------------------------------------ */

/// WebView2 运行时的版本号；没装返回 `None`。
///
/// **为什么必须自己查**：整个界面（横条、面板、设置页）都是 WebView2 渲染的。
/// 机器上没有这个运行时的时候，Tauri 连窗口都建不出来 —— 进程走 panic 路径
/// 退出，用户看到的只是"双击了，什么都没发生"。日志里也只有一行
/// `failed to create webview`，看不出是缺组件。
/// Win11 自带、Win10 多数随 Edge 装好，但 **LTSC / 精简版 / 企业镜像**里
/// 被移除是常见事，必须给用户一句人话 + 一个下载入口。
///
/// **三层证据，任何一层查到就算有。** 这个方向是刻意的：误判成"没装"会把一台
/// 本来能用的机器挡在门外（用户还以为软件坏了），比漏判严重得多；所以只有
/// 三层**全都**查不到时才认定缺失。
///
///   1. WebView2 自己的接口 `GetAvailableCoreWebView2BrowserVersionString`
///      —— 程序真正要用的就是它认的那个运行时，也覆盖 fixed-version 与用户级安装；
///   2. 注册表 EdgeUpdate 客户端 `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`
///      （系统级 WOW6432Node / 原生视图 + 用户级，各查一遍）；
///   3. 磁盘上的 `msedgewebview2.exe`（三处标准安装目录，兜"注册表被清理过"）。
pub fn webview2_version() -> Option<String> {
    if let Some(v) = webview2_version_api() {
        return Some(v);
    }
    if let Some(v) = webview2_version_registry() {
        return Some(v);
    }
    if let Some(p) = webview2_exe_on_disk() {
        return Some(format!("(磁盘上找到 {})", p.display()));
    }
    None
}

/// 第 1 层：问 WebView2 自己。`Ok` 且拿到非空版本串 = 可用。
fn webview2_version_api() -> Option<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows::core::PWSTR;
    use windows::Win32::System::Com::CoTaskMemFree;

    let mut p = PWSTR::null();
    let rc = unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut p) };
    if rc.is_err() || p.is_null() {
        return None;
    }
    let s = unsafe { p.to_string() }.unwrap_or_default();
    // 这个串是接口用 CoTaskMemAlloc 分配的，必须还回去（只调一次，但别养成习惯）
    unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 第 2 层：注册表里 EdgeUpdate 登记的 `pv`。
fn webview2_version_registry() -> Option<String> {
    const GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    // 我们是 64 位进程，默认读 64 位视图 —— 但 WebView2 是 32 位安装器装的，
    // 登记在 WOW6432Node 下（本机实测），所以两条都要看。
    for sub in [
        format!("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{GUID}"),
        format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{GUID}"),
    ] {
        for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            if let Some(v) = reg_read_sz(root, &sub, "pv") {
                return Some(v);
            }
        }
    }
    None
}

/// 第 3 层：磁盘上找 `msedgewebview2.exe`。
fn webview2_exe_on_disk() -> Option<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for k in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(v) = std::env::var(k) {
            if !v.trim().is_empty() {
                roots.push(std::path::PathBuf::from(v));
            }
        }
    }
    for r in roots {
        let base = r.join("Microsoft").join("EdgeWebView").join("Application");
        let Ok(rd) = std::fs::read_dir(&base) else {
            continue;
        };
        for e in rd.flatten() {
            let exe = e.path().join("msedgewebview2.exe");
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

/// 读一个 REG_SZ 值（空串 / 读不到都算 `None`）。
fn reg_read_sz(root: HKEY, sub: &str, name: &str) -> Option<String> {
    unsafe {
        let subw = wide(sub);
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(
            root,
            PCWSTR(subw.as_ptr()),
            None,
            KEY_QUERY_VALUE,
            &mut hkey,
        )
        .0 != 0
        {
            return None;
        }
        let namew = wide(name);
        let mut buf = [0u8; 1024];
        let mut size = buf.len() as u32;
        let rc = RegQueryValueExW(
            hkey,
            PCWSTR(namew.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if rc.0 != 0 || size < 2 {
            return None;
        }
        let units = (size as usize / 2).min(buf.len() / 2);
        let mut v: Vec<u16> = (0..units)
            .map(|i| u16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]))
            .collect();
        while v.last() == Some(&0) {
            v.pop();
        }
        let s = String::from_utf16_lossy(&v).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 提权 / 单实例                                                       */
/* ------------------------------------------------------------------ */

pub fn is_admin() -> bool {
    unsafe { IsUserAnAdmin().as_bool() }
}

/// 用 "runas" 动作重新拉起自己（会弹 UAC）。成功返回 true。
pub fn relaunch_as_admin() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let wexe = wide(&exe.to_string_lossy());
    let wverb = wide("runas");
    unsafe {
        let r = ShellExecuteW(
            None,
            PCWSTR(wverb.as_ptr()),
            PCWSTR(wexe.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        // HINSTANCE <= 32 表示失败
        (r.0 as usize) > 32
    }
}

/* ------------------------------------------------------------------ */
/* 本地软件唤起（#154 软件直达）                                         */
/* ------------------------------------------------------------------ */

/// 把一个目标（URI 协议 / .lnk 路径 / 可执行文件）交给 ShellExecuteW，
/// 返回 **系统是否认领**了这个请求。
///
/// 为什么不用 open::that：它在 Windows 上给"协议没注册"也只会回一个
/// io::Error（SE_ERR_NOASSOC 这类语义全丢），调用方分不清"该回落网页"
/// 和"别的原因失败"。
///
/// ⚠ 但 `HINSTANCE > 32` **不能**用来判断"协议有没有注册"（#154 轮 33 实测
///    翻车）：未注册的协议（包括随手编的 `qs33bogus://foo`）在本机同样返回
///    42 —— 那是 ShellExecute 把请求异步转交系统时的占位返回值，之后什么
///    都不会发生（最多异步弹个报错 / 跳应用商店）。只看返回值会把"没装这个
///    软件"误判成"唤起成功"，用户点一下什么都没发生，连网页兜底都不走。
///    协议类目标必须先过 `protocol_registered` 预检，再看这个返回值。
pub fn shell_execute_raw(target: &str) -> bool {
    let wt = wide(target);
    let verb = wide("open");
    unsafe {
        let r = ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(wt.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        // HINSTANCE <= 32 是各种 SE_ERR_* 失败码
        (r.0 as usize) > 32
    }
}

/// 在 `PATH` 里找一个可执行文件。
///
/// 用途：「智能直达」允许用户只输入一个裸名字（`notepad` / `微信`），
/// 而不是完整路径。`SearchPathW` 会按 `PATH` + 当前目录 + `PATHEXT` 依次找，
/// 行为和「运行」对话框一致 —— 比自己拼 `PATH` 再逐个试扩展名靠谱。
///
/// 找不到返回 `None`（调用方据此给出"找不到这个位置"的提示）。
pub fn resolve_on_path(name: &str) -> Option<std::path::PathBuf> {
    if name.trim().is_empty() {
        return None;
    }
    let w = wide(name);
    let mut buf = vec![0u16; 1024];
    let n = unsafe {
        windows::Win32::Storage::FileSystem::SearchPathW(
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR(w.as_ptr()),
            windows::core::PCWSTR::null(),
            Some(&mut buf[..]),
            None,
        )
    };
    if n == 0 || n as usize >= buf.len() {
        return None;
    }
    let found = String::from_utf16_lossy(&buf[..n as usize]);
    let p = std::path::PathBuf::from(found);
    if p.is_file() { Some(p) } else { None }
}

/// 某个 URI 协议（scheme，如 `weixin` / `dingtalk`）本机有没有注册处理程序。
///
/// 为什么必须查注册表：见 `shell_execute_raw` 的 ⚠ —— 未注册协议的
/// ShellExecuteW 返回值是 42（>32，"假成功"），分不出来。注册表是唯一
/// 可靠的判据：协议处理程序一定落在 `Software\Classes\<scheme>` 下。
///
/// 两个根都查：`HKCU\Software\Classes`（每用户，用户态安装的软件一般都写这）
/// 和 `HKLM\Software\Classes`（每机器，装在 Program Files 的写这）。每个根
/// 再按默认视图 + 64 位视图各开一次，规避 32/64 位注册表重定向（我们的进程
/// 和注册协议的进程位数不保证一致）。
///
/// 只判"键存在"，不判 `shell\open\command` 具体长什么样 —— 有的协议用
/// `AppXxxx` 商店应用、有的用 `com.epicgames.launcher` 这种反序名，逐个
/// 深究会把简单事情做复杂；键在 = 系统认这个协议，足够让调用方决定走不走
/// 下一步。
pub fn protocol_registered(scheme: &str) -> bool {
    let scheme = scheme.trim();
    if scheme.is_empty() {
        return false;
    }
    let roots: [(windows::Win32::System::Registry::HKEY, &str); 2] = [
        (HKEY_CURRENT_USER, "Software\\Classes\\"),
        (HKEY_LOCAL_MACHINE, "Software\\Classes\\"),
    ];
    let views = [KEY_QUERY_VALUE, KEY_QUERY_VALUE | KEY_WOW64_64KEY];
    for (root, prefix) in roots {
        let sub = format!("{prefix}{scheme}");
        let wsub = wide(&sub);
        for sam in views {
            let mut hkey = HKEY::default();
            let rc = unsafe {
                RegOpenKeyExW(
                    root,
                    PCWSTR(wsub.as_ptr()),
                    Some(0),
                    sam,
                    &mut hkey,
                )
            };
            if rc.is_ok() && !hkey.is_invalid() {
                let _ = unsafe { RegCloseKey(hkey) };
                return true;
            }
        }
    }
    false
}

/// 在开始菜单里按**名字精确匹配**（大小写不敏感、不含扩展名）找 .lnk 并启动。
///
/// 为什么是开始菜单：用户说"启动微信"指的就是开始菜单里那个叫"微信"的
/// 入口 —— 它同时覆盖了安装版 / 微软商店版 / 用户自己拖进去的快捷方式，
/// 比 PATH、注册表 App Paths、Uninstall 注册表都更贴近用户心智。
///
/// 两个根目录都扫（系统级 + 每用户级），递归子文件夹（开始菜单允许嵌套，
/// 比如 QQ 就在 `腾讯软件\QQ\QQ.lnk`）。只认 `.lnk`：`.url` 是网页快捷
/// 方式，启动它等于打开浏览器，那正是我们要替换掉的行为。
pub fn launch_start_menu(name: &str) -> bool {
    let want = name.trim().to_ascii_lowercase();
    if want.is_empty() {
        return false;
    }
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(pd) = std::env::var("ProgramData") {
        roots.push(
            std::path::Path::new(&pd)
                .join("Microsoft\\Windows\\Start Menu\\Programs"),
        );
    }
    if let Ok(ad) = std::env::var("APPDATA") {
        roots.push(
            std::path::Path::new(&ad).join("Microsoft\\Windows\\Start Menu\\Programs"),
        );
    }
    for root in roots {
        // 迭代式 DFS：开始菜单嵌套不深，栈不会爆
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(e.path());
                    continue;
                }
                let p = e.path();
                let is_lnk = p
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("lnk"))
                    .unwrap_or(false);
                if !is_lnk {
                    continue;
                }
                let stem = p.file_stem().and_then(|x| x.to_str()).unwrap_or("");
                if stem.to_ascii_lowercase() == want {
                    log(&format!("launch_start_menu: 命中 {:?}", p));
                    return shell_execute_raw(&p.to_string_lossy());
                }
            }
        }
    }
    log(&format!("launch_start_menu: 开始菜单里没有「{name}」"));
    false
}

/// 靠窗口标题找已经跑起来的实例（横条窗口在启动时就会建好，哪怕隐藏着）
/// 单实例判定。
///
/// 不能用 FindWindowW 找窗口标题：窗口卡死时 DWM 会代它生成一个同名的 "Ghost"
/// 窗口，按标题查找会误判成"已经在运行"，导致新实例直接退出。改成占一个命名互斥体，
/// 内核对象随进程结束自动释放，绝对不会误判。
///
/// ⚠ `QS_INSTANCE_TAG` 是**仅测试用**的逃生口：带上它时互斥体名字里会多一段 tag，
///   于是自动化探针可以在「用户自己的实例正开着（而且是管理员权限、脚本关不掉）」
///   的情况下另起一份来跑验证。不带这个环境变量时行为与以前完全一致。
///
/// # `QS_TAKEOVER=1`：更新后重启的"交班"（v1.3.0 修）
///
/// **这是我引入的一个真 bug**：`update_restart()`（v1.2.0 加的"立即重启"）
/// 的顺序是「先 `spawn()` 新进程 → 再 `exit()` 自己」。而新进程一起来就会
/// 走到这里 —— 此刻**老进程还没退、互斥体还被它占着**，于是新进程判定
/// "已有一个在跑"、**立刻 `exit(0)` 自杀**；老进程那边也退出了。
/// 结果：用户点了「立即重启」，程序**两个都没了**（或时序恰巧时两个都在）。
///
/// 修法：`update_restart()` 在拉起新进程时给它带一个 `QS_TAKEOVER=1`。
/// 带这个标记的进程走到这里时**不会自杀**，而是等老进程真的退出
/// （互斥体被内核释放）之后才继续 —— 这就是一次正常的"交班"。
///
/// 为什么用"等"而不是"用不同的互斥体名字"：换个名字的话，交班期间
/// **两个互斥体同时存在**，别的路径（托盘单例、用户双击）可能各占一个，
/// 反而漏出多实例。用同一个名字 + 等，语义最简单：任何时刻只有一个持有者。
pub fn already_running() -> bool {
    static ONCE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ONCE.get_or_init(|| unsafe {
        let tag = std::env::var("QS_INSTANCE_TAG").unwrap_or_default();
        // 便携测试版固定带 -lite 后缀：它不能提权（见 main.rs 里 QS_LITE_PORTABLE
        // 的说明），因此拿不到 QS_INSTANCE_TAG 的情况是常态 —— 不加后缀就会和
        // 正在运行的正式版抢同一个互斥体，双击后静默退出。
        let tag = if crate::QS_LITE_PORTABLE {
            format!("{tag}-lite")
        } else {
            tag
        };
        let name = wide(&format!("Local\\QuickSearch-8F42A1C6-SingleInstance{tag}"));
        let takeover = std::env::var("QS_TAKEOVER").map(|v| v == "1").unwrap_or(false);

        /* 交班模式：老进程正在退出，等它把互斥体让出来。
         *
         * 上限 10 秒：老进程退出前可能要做一次云同步（`exit_sync_if_needed`
         * 最多 6 秒），加上它自己的收尾，10 秒足够。
         * 超时还是拿不到的话**返回 false**（当作"没在跑"继续启动）——
         * 宁可冒一次多实例的风险，也不能让用户卡在一个永远起不来的程序上；
         * 而且那种情况下"两个实例"至少还能用，比"一个都没有"强。 */
        if takeover {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                match CreateMutexW(None, false, PCWSTR(name.as_ptr())) {
                    Ok(h) => {
                        if GetLastError() != ERROR_ALREADY_EXISTS {
                            let _ = h;
                            crate::win::log("takeover: 已接手单实例互斥体（老进程已退出）");
                            return false;
                        }
                        // 还是老进程占着 —— 等一小会儿再看
                        let _ = h;
                    }
                    Err(_) => return false,
                }
                if std::time::Instant::now() >= deadline {
                    crate::win::log("takeover: 等了 10 秒老进程仍未退出，按新实例继续启动");
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }

        match CreateMutexW(None, false, PCWSTR(name.as_ptr())) {
            Ok(h) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    true
                } else {
                    // 故意不关这个句柄：进程活着互斥体就得活着。
                    // HANDLE 是 Copy，直接 let _ 即可，不需要（也不应该）mem::forget。
                    let _ = h;
                    false
                }
            }
            // ⚠ 互斥体创建**失败**（不是"已存在"，是 CreateMutexW 本身报错）。
            //   常见原因：会话隔离 / 权限不足 / 句柄耗尽。
            //   这里**不能**当成"没在跑"就闷头往下走 —— 那会放任第二个实例
            //   同时起来，两个进程抢同一个托盘图标、抢同一份配置文件，
            //   用户看到的现象正是「托盘图标点不动、右键菜单弹不出」这种
            //   半死不活的样子。所以这里打一条日志，把「互斥体没建起来」
            //   这个事实落到日志里，事后可查。
            //   仍然返回 false（不自杀）：句柄耗尽之类的极端情况下，
            //   让程序起不来比多开一个实例更糟。
            Err(e) => {
                crate::win::log(&format!(
                    "single-instance: 创建互斥体失败（{e}），按「没有别的实例」继续启动"
                ));
                false
            }
        }
    })
}

/* ------------------------------------------------------------------ */
/* 光标 / 鼠标                                                         */
/* ------------------------------------------------------------------ */

/// 当前进程资源用量。给内存泄漏检测用：
/// (WorkingSet 字节, PrivateBytes 字节, 内核句柄数, GDI 对象数, USER 对象数)
pub fn mem_stats() -> (u64, u64, u32, u32, u32) {
    unsafe {
        let p = GetCurrentProcess();
        let mut ex = PROCESS_MEMORY_COUNTERS_EX {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
        };
        let _ = GetProcessMemoryInfo(
            p,
            &mut ex as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            ex.cb,
        );
        let mut handles = 0u32;
        let _ = GetProcessHandleCount(p, &mut handles);
        let gdi = GetGuiResources(p, GR_GDIOBJECTS);
        let user = GetGuiResources(p, GR_USEROBJECTS);
        (
            ex.WorkingSetSize as u64,
            ex.PrivateUsage as u64,
            handles,
            gdi,
            user,
        )
    }
}

/// 系统的「双击间隔」上限（毫秒）—— 用户在鼠标设置里可以把它调到 200~900ms。
///
/// 用途：托盘图标自己判双击（见 main.rs 的 `tray_is_double_click`）。
/// 写死 300/500 都不合适：手快的人 200ms 就够了，手慢的人调到了 900ms，
/// 写死就会变成"我明明双击了却没反应"。
pub fn double_click_ms() -> u32 {
    let v = unsafe { GetDoubleClickTime() };
    // 极端配置兜一下：0 会让任何两次点击都判不成双击；5000 又太离谱。
    v.clamp(200, 1000)
}

pub fn cursor_pos() -> POINT {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    p
}

/// 取当前前台窗口里「打字光标」的位置（屏幕物理像素）。拿不到就返回 None。
pub fn caret_pos() -> Option<POINT> {
    caret_box().map(|(l, _, _, b)| POINT { x: l, y: b })
}

/// 取打字光标所占的矩形（屏幕物理像素）：(left, top, right, bottom)。
///
/// 和 `caret_pos` 的区别在于它把**上下两条边**都给了出来 —— 横条要判断
/// 「放文字下面还是上面」，就必须知道文字那行的顶边在哪，只给一个点是不够的。
/// 拿不到（控件不暴露光标、或者前台根本不是文本控件）返回 None。
pub fn caret_box() -> Option<(i32, i32, i32, i32)> {
    unsafe {
        // 拿不到光标时把**原因**记下来。横条贴文字 / 贴鼠标这个行为用户很在意，
        // 一旦退化成贴鼠标，没有这条日志就只能靠猜。
        let why = |s: &str| {
            log(&format!("caret_box: 取不到光标 —— {s}"));
            None
        };
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return why("没有前台窗口");
        }
        let tid = GetWindowThreadProcessId(fg, None);
        if tid == 0 {
            return why("前台窗口取不到线程 id");
        }
        match caret_box_in_thread(tid) {
            Ok(r) => Some(r),
            Err(e) => why(&e),
        }
    }
}

/// 取**指定窗口所属线程**里的打字光标（屏幕物理像素）。
///
/// 为什么需要它（而不是复用 `caret_box`）：`caret_box` 一路走的是
/// `GetForegroundWindow` —— 而收藏夹面板弹出后，前台窗口已经是我们自己，
/// 「鼠标下面那个软件的光标」就再也问不出来了。用户对收藏夹条目的要求是
/// 「输入到鼠标触发位置所在的那个软件的文本框里」，所以必须能指着**别人**问。
/// 问的方式就是拿那个窗口的线程 id 去调 GetGUIThreadInfo —— 它对非前台线程同样有效。
pub fn caret_box_of(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    if hwnd.0.is_null() {
        return None;
    }
    let tid = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if tid == 0 {
        log("caret_box_of: 目标窗口取不到线程 id");
        return None;
    }
    match caret_box_in_thread(tid) {
        Ok(r) => Some(r),
        Err(e) => {
            log(&format!(
                "caret_box_of: hwnd=0x{:x} tid={tid} 问不到打字光标 —— {e}（该窗口没有文本焦点）",
                hwnd.0 as usize
            ));
            None
        }
    }
}

/// 真正干活的那个：给一个线程 id，问它当前的活动窗口 / 光标矩形。/// 失败时把**具体原因**回给调用方，两边各自带上自己的日志前缀。
fn caret_box_in_thread(tid: u32) -> Result<(i32, i32, i32, i32), String> {
    unsafe {
        let mut gti = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gti).is_err() {
            return Err("GetGUIThreadInfo 失败".into());
        }
        let hwnd = if !gti.hwndCaret.0.is_null() {
            gti.hwndCaret
        } else {
            gti.hwndActive
        };
        if hwnd.0.is_null() {
            return Err("hwndCaret 和 hwndActive 都是空".into());
        }
        // rcCaret 全 0 表示控件没暴露光标
        if gti.rcCaret.left == 0 && gti.rcCaret.top == 0 && gti.rcCaret.bottom == 0 {
            return Err(format!(
                "rcCaret 是空矩形（hwndCaret={:?} hwndActive={:?} hwndFocus={:?}）",
                gti.hwndCaret.0, gti.hwndActive.0, gti.hwndFocus.0
            ));
        }
        let mut a = POINT { x: gti.rcCaret.left, y: gti.rcCaret.top };
        let mut b = POINT { x: gti.rcCaret.left, y: gti.rcCaret.bottom };
        if !ClientToScreen(hwnd, &mut a).as_bool() || !ClientToScreen(hwnd, &mut b).as_bool() {
            return Err("ClientToScreen 失败".into());
        }
        // 单行文本控件偶尔报出 top==bottom 的退化矩形，兜一个行高出来，
        // 否则「上方还有没有空间」的判断会一直算错。
        let (top, bottom) = if b.y - a.y >= 6 {
            (a.y, b.y)
        } else {
            (a.y - 16, a.y + 6)
        };
        Ok((a.x, top, a.x, bottom))
    }
}

/// 目标窗口所在的线程里「有没有能收键盘输入的地方」。
///
/// 给收藏夹条目分流用：有 → 把文字注入进去；没有 → 退回复制到剪贴板。
///
/// 判据刻意做成**两档、偏宽松**，理由是最常被点收藏夹的场景恰恰最难判：
///   · 第一档：GetGUIThreadInfo 报出了 `hwndCaret` —— 真的有一个打字光标，铁证；
///   · 第二档：退一步，只要 `hwndFocus`/`hwndActive` 里有一个非空 —— 该线程
///     至少有一个拿到焦点的窗口，键盘输入有地方可去。
///
/// ⚠ 第二档不能省。浏览器（Chrome / Edge）的**网页输入框**光标是渲染进程画的，
///   UI 线程这一层经常报不出 `hwndCaret`；只认第一档的话，「在网页里点收藏」
///   会永远退化成"复制到剪贴板"，而那正是用户最常干的场景 —— 明明有输入框
///   却说没有，用户只会觉得功能坏了。反过来"误判成有"的代价很小：文字打到了
///   那个软件当前有焦点的控件里，用户删一下就行。
pub fn has_text_focus(hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    let tid = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if tid == 0 {
        return false;
    }
    unsafe {
        let mut gti = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gti).is_err() {
            return false;
        }
        !gti.hwndCaret.0.is_null() || !gti.hwndFocus.0.is_null() || !gti.hwndActive.0.is_null()
    }
}

pub fn ctrl_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 }
}

/// Alt 此刻是否按着（Ctrl+Alt+O 那个全局快捷键要用）
pub fn alt_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0 }
}

/// Shift 此刻是否按着（收藏夹自定义快捷键要用）。
pub fn shift_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0 }
}

/// Win 键此刻是否按着（收藏夹自定义快捷键支持 `win+…` 组合）。
///
/// 左右两个都要看：`VK_LWIN` / `VK_RWIN` 是分开的物理键，只查左边的话
/// 用右手按 Win 的用户会一直被判成"没按修饰键"。`VK_LWIN` 的位在
/// `GetAsyncKeyState(VK_LWIN)` 里，与 `VK_CONTROL` 那种"合并修饰键"不同，
/// 所以这里两个都读。
pub fn win_down() -> bool {
    unsafe {
        (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000) != 0
            || (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000) != 0
    }
}

/// 左键此刻是否按着（钩子里判"拖动中"用）。
///
/// 为什么不在钩子里自己记 DOWN/UP 状态：钩子可能被系统中途摘掉、再重装，
/// 那时状态就失配了（以为一直按着，于是每条 MOUSEMOVE 都往 channel 里塞）。
/// `GetAsyncKeyState` 是直接读系统按键状态，永远和真实状态一致，且极轻。
pub fn left_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

/// 右键此刻是否按着。
///
/// 为什么不用 WH_MOUSE_LL 的 WM_RBUTTONDOWN：本机实测**任何**注入的右键都到不了
/// 我们的鼠标钩子（左键一切正常），链路上显然有别的钩子把右键吃掉了。
/// GetAsyncKeyState 直接读系统按键状态，绕开钩子链，可靠得多。
pub fn rbutton_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

/// 给**我们自己注入**的按键打的暗号（`dwExtraInfo`）。
///
/// 为什么不用"时间窗"：早期实现是「注入之后 400ms 内收到的 Ctrl+C 都算自己的」，
/// 但那是个拍脑袋的窗口 —— 用户用第三方工具发的 Ctrl+C 一旦恰好落在这个窗口里
/// 就会被**误吞**，表现为"Ctrl+C 概率性唤不出横条"（用户原话）。
///
/// 现在改成在 `SendInput` 时给每个按键带上这个只有本程序知道的暗号，
/// 钩子里直接比对 `KBDLLHOOKSTRUCT.dwExtraInfo` —— 一锤定音，零误伤：
/// 第三方工具的注入没有这个暗号，永远不会再被当成"自己人"吞掉。
pub const SELF_INJECT_TAG: usize = 0x0051_5345_4C46; // "QSELF" 的十六进制彩蛋

/// 模拟一次 Ctrl+C。
///
/// ⚠ 两个细节是踩过坑之后定下来的：
///
/// 1. **带上扫描码**（`wScan`）。以前 wScan 留 0，靠系统用 wVk 反查 ——
///    对记事本这类老控件没问题，但 Qt / Chromium 系的程序（微信 4.x 就是
///    Qt 5.15 写的）在处理快捷键时会看扫描码，留 0 的合成按键有被当成
///    "非真实按键"而忽略的风险。
/// 2. **四个按键分四次 SendInput**，中间留 8ms。以前把「Ctrl 按下 + C 按下」
///    塞在同一次调用里，部分程序的按键队列会漏掉后半截。
pub fn send_ctrl_c() {
    let key = |vk: VIRTUAL_KEY, scan: u16, up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                    time: 0,
                    // ⚠ 暗号必须带上：钩子靠它分辨"这是我们自己的注入"，
                    //   不然取词用的模拟 Ctrl+C 会被当成用户按的，横条乱弹。
                    dwExtraInfo: SELF_INJECT_TAG,
                },
            },
        }
    };
    unsafe {
        let cs = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let xs = MapVirtualKeyW(VK_C.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let seq: [INPUT; 4] = [
            key(VK_CONTROL, cs, false),
            key(VK_C, xs, false),
            key(VK_C, xs, true),
            key(VK_CONTROL, cs, true),
        ];
        for i in seq.iter() {
            SendInput(std::slice::from_ref(i), std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(8));
        }
    }
}

/// 模拟一次 Ctrl+V（r54 识图搜索用）。
///
/// 做法与 `send_ctrl_c` **逐字同源**：四个按键分四次 SendInput、带扫描码、
/// 中间留 8ms（那三条都是踩过坑定下来的，Qt / Chromium 系程序才对合成按键
/// 有反应）。区别只有两处，两条都是刻意为之：
///
///   1. `dwExtraInfo` **不**带 `SELF_INJECT_TAG` 暗号。暗号是给我们自己的钩子
///      认"这是自己人在发 Ctrl+C、别拿它触发取词"用的；而这次 Ctrl+V 是要
///      送给**浏览器**，让站点认下这张剪贴板里的图 —— 带上暗号不会有任何
///      好处，反而在别人（比如别的取词工具）眼里更可疑。所以就是普通注入。
///   2. 目标不是我们自己的窗口。调用方必须先把浏览器切到前台（`open_links`
///      拉窗口 + 一段延时），这一步只管把按键送进**当前前台窗口**。
pub fn paste_ctrl_v() {
    let key = |vk: VIRTUAL_KEY, scan: u16, up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    };
    unsafe {
        let cs = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let xs = MapVirtualKeyW(VK_V.0 as u32, MAPVK_VK_TO_VSC) as u16;
        let seq: [INPUT; 4] = [
            key(VK_CONTROL, cs, false),
            key(VK_V, xs, false),
            key(VK_V, xs, true),
            key(VK_CONTROL, cs, true),
        ];
        for i in seq.iter() {
            SendInput(std::slice::from_ref(i), std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(8));
        }
    }
}

/// 「窗口消息取词」要投递的那几个候选窗口（去重）。
///
/// 为什么要一串而不是一个：真正的"有选区"的那个控件未必就是焦点窗口。
/// 微信 4.x 是 Qt 画的皮、内容在 `MMUIRenderSubWindowHW` 子窗口里；浏览器里
/// 选区归渲染进程的 `Chrome_RenderWidgetHostHWND`。把焦点窗口、活动窗口、
/// 前台窗口都投一遍，命中率最高；WM_COPY 投到没有选区的窗口上是空操作，不会有害。
fn focus_candidates() -> Vec<HWND> {
    let mut v: Vec<HWND> = Vec::new();
    unsafe {
        let fg = GetForegroundWindow();
        if !fg.0.is_null() {
            let tid = GetWindowThreadProcessId(fg, None);
            if tid != 0 {
                let mut gti = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
                };
                if GetGUIThreadInfo(tid, &mut gti).is_ok() {
                    for h in [gti.hwndFocus, gti.hwndCaret, gti.hwndActive] {
                        if !h.0.is_null() && !v.iter().any(|x| x.0 == h.0) {
                            v.push(h);
                        }
                    }
                }
            }
            if !v.iter().any(|x| x.0 == fg.0) {
                v.push(fg);
            }
        }
    }
    v
}

/// 用**窗口消息**请目标窗口把当前选区复制到剪贴板（`WM_COPY`）。
///
/// 存在的理由：`SendInput` 造出来的按键在系统里带 `LLKHF_INJECTED` 标记，
/// 有些程序（尤其是做过反自动化处理的国产客户端）会据此**无视**这些按键 ——
/// 现象就是"在它里面划词永远不弹条"，而别的软件一切正常。
/// 窗口消息走的是另一条路（直接进目标窗口的消息队列），这类检查拦不住它。
///
/// 返回「至少投出去了一条」。投出去 ≠ 目标一定复制了，所以调用方照样要靠
/// 剪贴板序号复核，这里只负责多开一条路。
pub fn post_copy_to_focus() -> bool {
    let mut any = false;
    for h in focus_candidates() {
        unsafe {
            if PostMessageW(Some(h), WM_COPY, WPARAM(0), LPARAM(0)).is_ok() {
                any = true;
            }
        }
    }
    any
}

/// 用**窗口消息**模拟一次 Ctrl+C：先让目标线程"看见 Ctrl 按着"，再投
/// `WM_KEYDOWN`/`WM_KEYUP(VK_C)`。
///
/// 为什么要绕过 `SendInput`：见 `post_copy_to_focus` 的注释。
/// 为什么需要 `AttachThreadInput` + `SetKeyboardState`：键盘状态是**按输入队列**
/// 记录的，程序处理按键消息时通常用 `GetKeyState(VK_CONTROL)` 判断修饰键 ——
/// 只投 `WM_KEYDOWN(VK_C)` 而不改键盘状态，程序会认为"用户只按了 C"，快捷键
/// 判定失败。把自己的输入队列 attach 到前台线程之后，我们写进去的状态就是
/// 它看到的那一份。（attach 失败也不要紧：`WM_COPY` 那条路还在。）
pub fn post_ctrl_c_to_focus() -> bool {
    let targets = focus_candidates();
    if targets.is_empty() {
        return false;
    }
    let mut any = false;
    unsafe {
        let fg = GetForegroundWindow();
        let fg_tid = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let me = GetCurrentThreadId();
        let attached = fg_tid != 0 && fg_tid != me && AttachThreadInput(me, fg_tid, true).as_bool();
        let mut saved = [0u8; 256];
        let have_saved = GetKeyboardState(&mut saved).is_ok();
        if attached {
            let mut down = saved;
            down[VK_CONTROL.0 as usize] = 0x80;
            let _ = SetKeyboardState(&down);
        }
        let scan = MapVirtualKeyW(VK_C.0 as u32, MAPVK_VK_TO_VSC) as usize;
        // lParam 的位段：bit0=重复次数, bit16-23=扫描码, bit30=上一次按键状态,
        // bit31=转换标志（抬起）。抬起那一份必须带 0xC000_0001。
        let dn = LPARAM((1 | (scan << 16)) as isize);
        let up = LPARAM((0xC000_0001usize | (scan << 16)) as isize);
        for h in targets {
            let a = PostMessageW(Some(h), WM_KEYDOWN, WPARAM(VK_C.0 as usize), dn).is_ok();
            let b = PostMessageW(Some(h), WM_KEYUP, WPARAM(VK_C.0 as usize), up).is_ok();
            any |= a || b;
        }
        if attached {
            if have_saved {
                let _ = SetKeyboardState(&saved);
            }
            let _ = AttachThreadInput(me, fg_tid, false);
        }
    }
    any
}

/* ------------------------------------------------------------------ */
/* 取词通道：直接问控件"你选了什么"（全程不碰剪贴板）                    */
/* ------------------------------------------------------------------ */

/* 编辑控件相关的消息。刻意写成常量而不是从 windows crate 里取：
 * `EM_GETSEL` 在 crate 里属于 `Win32_UI_Controls` 特性，为了一个消息号去开
 * 一整块控件特性不划算（本项目的依赖面是刻意收紧的）。 */
const WM_GETTEXT: u32 = 0x000D;
const WM_GETTEXTLENGTH: u32 = 0x000E;
const EM_GETSEL: u32 = 0x00B0;

/// 标准编辑控件（EDIT / RichEdit）的**当前选区文字** —— 不碰剪贴板。
///
/// 做法就是老牌的 `EM_GETSEL` 问选区下标 + `WM_GETTEXT` 取正文，两条消息
/// 都是系统**代为跨进程封送**的（WM_GETTEXT 带缓冲区指针也不会出事），
/// 所以不用注入、不用复制、不改任何状态。
///
/// 覆盖范围：记事本、各种对话框里的输入框、多数经典控件类程序 ——
/// 注意这些控件**没有实现 UIA 文本模式**（UIA 那条路读不到它们），
/// 所以这条通道是必要的补充，不是重复劳动。
pub fn edit_selection_text_at(pt: POINT) -> Option<String> {
    unsafe {
        let mut h = WindowFromPoint(pt);
        if h.0.is_null() {
            return None;
        }
        // 命中的可能是控件的内部子窗口，往上找两层看看有没有编辑控件
        for _ in 0..3 {
            let cls = class_name(h);
            if cls.to_ascii_lowercase().contains("edit") {
                if let Some(t) = edit_sel_text(h) {
                    return Some(t);
                }
            }
            let parent = GetParent(h).unwrap_or(HWND(std::ptr::null_mut()));
            if parent.0.is_null() {
                break;
            }
            h = parent;
        }
        None
    }
}

/// 给**别的进程**的窗口发一条消息，带超时。成功返回消息结果，失败/超时返回 None。
///
/// 为什么不能用 `SendMessageW`（见 `edit_sel_text` 的完整说明）：`h` 来自
/// `WindowFromPoint`，是别的进程的控件。对方 UI 线程一旦挂起（"程序未响应"），
/// 跨进程 `SendMessage` **永远不会返回** —— 系统那套"把卡住的消息重新投递"
/// 只对同进程 `SendMessage` 生效。取词线程会就此永久卡住（`BUSY` 也不再释放），
/// 用户侧的表现是「划词横条再也不弹」，只有重启软件才能恢复。
///
/// `SendMessageTimeoutW` 的返回值是**成功与否**（0 = 失败或超时），消息真正的
/// 结果在 `lpdwresult` 里 —— 别把它当成消息结果用。
unsafe fn send_msg_timeout(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<usize> {
    // 300ms 绰绰有余：真·编辑控件这三条消息都是微秒级返回
    const TIMEOUT_MS: u32 = 300;
    let mut ret: usize = 0;
    let ok = SendMessageTimeoutW(
        h,
        msg,
        wp,
        lp,
        SMTO_ABORTIFHUNG,
        TIMEOUT_MS,
        Some(&mut ret),
    );
    if ok.0 == 0 {
        None
    } else {
        Some(ret)
    }
}

fn edit_sel_text(h: HWND) -> Option<String> {
    unsafe {
        // 同文件其它跨进程发消息处（uia_wake_render_children、uia_probe_wake）
        // 都带了 SMTO_ABORTIFHUNG + 超时，只有这里以前漏了（用裸 SendMessageW）。
        let Some(len) = send_msg_timeout(h, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0)) else {
            log("edit: WM_GETTEXTLENGTH 超时/失败（对方进程可能没响应），放弃编辑控件通道");
            return None;
        };
        // 上限防呆：真·编辑控件不会这么长，超了说明消息打到了别的窗口上
        if len == 0 || len > 1_000_000 {
            return None;
        }
        let mut buf = vec![0u16; len + 1];
        let got = send_msg_timeout(h, WM_GETTEXT, WPARAM(buf.len()), LPARAM(buf.as_mut_ptr() as isize))?;
        if got == 0 {
            return None;
        }
        buf.truncate(got.min(buf.len()));
        // EM_GETSEL 的返回值把起止下标打包在 LOWORD / HIWORD 里
        // （用返回值而不是传指针：指针不会被跨进程封送，写了会打崩对方）。
        let packed = send_msg_timeout(h, EM_GETSEL, WPARAM(0), LPARAM(0))?;
        let packed = packed as u32;
        let (start, end) = ((packed & 0xFFFF) as usize, (packed >> 16) as usize);
        if end <= start || start >= buf.len() {
            return None;
        }
        let end = end.min(buf.len());
        let t = String::from_utf16_lossy(&buf[start..end]).trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 取词通道：UI Automation 直读选区（不碰剪贴板）                       */
/* ------------------------------------------------------------------ */

/// UIA 调用的等待上限（ms）。UIA 是跨进程调用，对方进程卡住时这里会一起卡住，
/// 而系统那道 UIA 超时最长能到好几秒 —— 划词路径等不起，自己掐一个上限。
const UIA_TIMEOUT_MS: u64 = 2500;

/// 进程内第一次用 UIA 要加载 UIAutomationCore、把跨进程代理建起来，
/// 实测这一下能花掉**一秒以上**（我原来按 700ms 掐超时，结果次次都超时）。
/// 所以在启动时后台先空跑一次把它热起来，别让第一次划词当小白鼠。
pub fn uia_warm_up() {
    std::thread::Builder::new()
        .name("qs-uia-warm".into())
        .spawn(|| {
            let t0 = Instant::now();
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                if let Ok(auto) =
                    CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                {
                    // 随便问一个点，目的只是把加载/连接的开销付掉
                    let _ = auto.ElementFromPoint(POINT { x: 1, y: 1 });
                    let _ = auto.ElementFromHandle(GetForegroundWindow());
                }
            }
            log(&format!("uia: 预热完成，耗时 {}ms", t0.elapsed().as_millis()));
        })
        .ok();
}

/// 用系统无障碍接口（UI Automation）**直接读出当前选区的文字** —— **不碰剪贴板**。
///
/// 这是「选中文字就弹条，而不是选中就复制」的正解：
/// Windows 上取选区文字的老办法是模拟一次 Ctrl+C（必须借用剪贴板，还得再还原），
/// 而 UIA 的 `TextPattern` 可以直接问程序"你现在选了什么"。调用它**不会修改剪贴板**，
/// 也不会在目标程序里留下任何"复制"的痕迹。
///
/// 覆盖范围是"实现了 UIA 文本模式"的程序：Chromium 系浏览器 / Electron、
/// Office、大部分现代编辑器。自绘 UI（微信这类）没有实现 —— 那边由 OCR 兜底。
///
/// 一次 UIA 取词的结果。
///
/// ⚠ 必须把「有没有找到 TextPattern」和「读没读到文字」**分开带回来**：
///   负缓存（`UIA_NO_PATTERN`）该黑的只是**压根没有文本模式的进程**（自绘 UI），
///   不能把「这次框选里确实没选中字」和「查询超时」也算进去。
#[derive(Debug)]
enum UiaOutcome {
    /// 读到文字
    Text(String),
    /// 找到了 TextPattern，但选区是空的（用户在空白处拖了一下）
    EmptySelection,
    /// 上溯一圈都没找到 TextPattern —— 自绘 UI，这个进程可以拉黑
    NoPattern,
    /// 超时 / 线程异常：什么都没查出来，**什么都别记住**
    Failed,
}

/// 一次 UIA 取词**对外**的结果（`main.rs` 用）。
///
/// 为什么要把「超时」和「这次没读到」分开：取词链拿到 `Retryable` 会**再试一次**
/// （很多程序把"选区变了"异步提交，晚一拍才读得到）；但**超时**不是"晚一拍"，
/// 而是对方的 UIA 压根不应答 —— 再等一次只是把弹条又推迟 0.5~2.2s（实测），
/// 用户看到的是"选完字要等四五秒"。超时就直接走 OCR 兜底。
pub enum UiaTry {
    /// 读到了文字
    Text(String),
    /// 这次没读到，但对方 UIA 是活的 —— 值得按"选区还没落地"再试一次
    Retryable,
    /// 查询超时 / 对方没响应 —— **不要重试**，直接换下一条通道
    TimedOut,
}

/// 同一进程**连续超时**几次就认定「这个进程的 UIA 不可用」，之后直接跳过。
///
/// 为什么需要它：有些程序（GDI 自绘）的 UIA 查询不是"慢"，而是**每次都挂到超时**
/// （实测每次都要 2.5s 才回来）。这种进程光靠"有没有 TextPattern"那份负缓存
/// 永远学不到教训（超时根本查不出 TextPattern），于是**每一次划选都白等 2.5s**。
/// 而 r36 之前那版更糟：它把**一次**超时就当成"没有文本模式"永久拉黑，顺带把
/// 「只是这次没选中字」的正常程序也一起拉黑了。
static UIA_SLOW: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<u32, u8>>,
> = std::sync::OnceLock::new();

/// 连续超时到这个次数就拉黑该进程的 UIA。
const UIA_SLOW_LIMIT: u8 = 2;

/// ⚠ 跨进程调用可能被对方拖住，所以真正的调用丢进独立线程，主流程最多等
///   `UIA_TIMEOUT_MS`；超时就走下一条通道，绝不把划词卡死。
pub fn uia_selection_text(drag_end: POINT, drag_start: POINT) -> UiaTry {
    /* 浏览器短路（r34 实证）：Chromium 系浏览器（Edge 实测）的 UIA 内容树
     * **无法唤醒** —— 强制前台 + 焦点事件订阅 + 双消息变体（WM_GETOBJECT
     * w=1/l=0 与 w=0/l=1，直发渲染子窗 Chrome_RenderWidgetHostHWND）三管齐下，
     * 向下走树仍是 26 个框架元素（标签栏/标题按钮），内容树纹丝不动。
     * 这种窗口上每次 UIA 查询都要跑满 UIA_TIMEOUT_MS 才罢休，外层还要重试
     * 两次 —— 划词横条会被拖到一秒半以后。直接跳过，让 OCR 兜底（浏览器
     * 选区的 OCR 通道是通的，见 ocr_ready_image 的底色归一化）。 */
    if uia_foreground_is_browser() {
        log("uia: 前台是 Chromium 系浏览器（内容树已实证无法唤醒）—— 跳过 UIA");
        return UiaTry::Retryable;
    }
    /* 「这个进程没有 UIA 文本模式」的负缓存。
     *
     * 自绘 UI（微信这类）里 UIA 不是报错、而是**每一个问询都要走几百毫秒**
     * （元素上溯一圈才确定没有 TextPattern）。划词路径要重试两次，加起来一秒半 ——
     * 横条要等一秒半才出来，用户只会觉得"没反应"。记住这个 pid，下次直接跳 OCR。 */
    let pid = window_pid(unsafe { GetForegroundWindow() });
    if pid != 0 {
        if let Some(set) = UIA_NO_PATTERN.get() {
            if let Ok(g) = set.lock() {
                if g.contains(&pid) {
                    return UiaTry::Retryable;
                }
            }
        }
    }
    let out = uia_query_with_timeout(drag_end, drag_start);
    let is_no_pattern = matches!(out, UiaOutcome::NoPattern);
    match out {
        UiaOutcome::Text(t) => {
            // 读到了 → 这个进程的 UIA 好得很，把超时计数清零
            if pid != 0 {
                if let Some(m) = UIA_SLOW.get() {
                    if let Ok(mut g) = m.lock() {
                        g.remove(&pid);
                    }
                }
            }
            UiaTry::Text(t)
        }
        UiaOutcome::EmptySelection | UiaOutcome::NoPattern => {
            if pid != 0 {
                if let Some(m) = UIA_SLOW.get() {
                    if let Ok(mut g) = m.lock() {
                        g.remove(&pid);
                    }
                }
            }
            /* ⚠ 只黑「上溯一圈都没找到 TextPattern」这一种（= 自绘 UI，没有文本模式）。
             *
             * 原来判的是 `out.is_none()` —— 它把「这次框选里确实没选中文字」
             * 「UIA 查询超时」「对方没响应」也一并算成了"这个进程没有文本模式"。
             * 于是用户在 Word / VS Code / 记事本里随手拖一次空白（或赶上一次超时），
             * 那个进程就**整个会话**不再走 UIA，全部退化到模拟 Ctrl+C + 剪贴板还原
             * （更慢，还会搅动用户的剪贴板），而日志里只留一句"跳过 UIA"。 */
            if is_no_pattern && pid != 0 {
                let set = UIA_NO_PATTERN
                    .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
                if let Ok(mut g) = set.lock() {
                    if g.len() < 256 {
                        g.insert(pid);
                    }
                }
            } else {
                log("uia: 找到了文本模式但选区是空的（不是「没有文本模式」，不拉黑该进程）");
            }
            UiaTry::Retryable
        }
        UiaOutcome::Failed => {
            /* 超时：连续 `UIA_SLOW_LIMIT` 次就认定这个进程的 UIA 不可用，
             * 之后连查都不查（见 UIA_SLOW 的注释）。 */
            if pid != 0 {
                let m = UIA_SLOW.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
                let n = {
                    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
                    let n = g.entry(pid).or_insert(0);
                    *n = n.saturating_add(1);
                    *n
                };
                if n >= UIA_SLOW_LIMIT {
                    let set = UIA_NO_PATTERN
                        .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
                    if let Ok(mut g) = set.lock() {
                        if g.len() < 256 {
                            g.insert(pid);
                        }
                    }
                    log(&format!(
                        "uia: 进程 {pid} 连续 {n} 次查询超时 —— 认定它的 UIA 不可用，本次会话不再查它"
                    ));
                }
            }
            UiaTry::TimedOut
        }
    }
}

/// 记住「哪些进程没有 UIA 文本模式」的小集合（见 uia_selection_text 的注释）。
static UIA_NO_PATTERN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u32>>> =
    std::sync::OnceLock::new();

/* ------------------------------------------------------------------ */
/* 浏览器识别（UIA 对 Chromium 系浏览器已实证封死，r34）                     */
/* ------------------------------------------------------------------ */

/// Chromium 内核浏览器的可执行文件名（小写比较）。
///
/// 判据是**可执行文件名**而不是窗口类名：WebView2 / Electron 应用的窗口类名
/// 同样是 Chrome_WidgetWin_*，但它们的 UIA 是能用的（WorkBuddy IDE 实测
/// 唤醒后可查），误杀会让那些场景白白少一条精确通道。
fn uia_exe_is_browser(exe: &str) -> bool {
    matches!(
        exe.to_ascii_lowercase().as_str(),
        "msedge.exe"
            | "chrome.exe"
            | "brave.exe"
            | "vivaldi.exe"
            | "opera.exe"
            | "chromium.exe"
    )
}

/// 前台窗口是不是 Chromium 系浏览器进程。
///
/// pid→结论带进程内缓存：划词是热路径，OpenProcess 虽只要几十微秒，能省则省；
/// 进程退出后 pid 复用是小概率，复用错了也就是一次划词多走/少走一条通道，
/// 无副作用。
pub fn uia_foreground_is_browser() -> bool {
    let hwnd = foreground_window();
    if hwnd.0.is_null() {
        return false;
    }
    let pid = window_pid(hwnd);
    if pid == 0 {
        return false;
    }
    let cache =
        UIA_BROWSER.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Ok(g) = cache.lock() {
        if let Some(&v) = g.get(&pid) {
            return v;
        }
    }
    let v = process_exe(pid)
        .as_deref()
        .map(uia_exe_is_browser)
        .unwrap_or(false);
    if let Ok(mut g) = cache.lock() {
        if g.len() < 256 {
            g.insert(pid, v);
        }
    }
    v
}

static UIA_BROWSER: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, bool>>> =
    std::sync::OnceLock::new();

/// 零成本 UIA 唤醒（r34）：给前台窗口的子窗各发两条 WM_GETOBJECT。
///
/// 机理：Chromium 系的无障碍树是懒加载的，被动查询（ElementFromPoint /
/// ElementFromHandle）不会触发构建。本机实证分化很清晰：
///   * **WebView2 / Electron 宿主应用**（如 WorkBuddy IDE）：渲染子窗
///     Chrome_RenderWidgetHostHWND 收到 WM_GETOBJECT 后内容树可查；
///   * **Chromium 系浏览器**（Edge 实测）：前台+事件订阅+双消息变体三管齐下
///     也建不起来（见 `uia_foreground_is_browser` 的注释）。
///
/// 所以这条只对非浏览器场景有价值（Electron 应用如 VS Code / Obsidian
/// 划词），成本≈0：一两条消息，**不盲等**就返回 —— 树若是同步建的立刻能
/// 查到，异步建的由 `uia_selection_text` 外层两次重试（间隔 120ms）兜住。
/// 盲等会拖慢横条弹出，划词场景响应速度优先。
fn uia_wake_render_children(fg: HWND) {
    unsafe {
        if fg.0.is_null() {
            return;
        }
        const WM_GETOBJECT: u32 = 0x003D;
        // 两种变体都发：官方设计文档口径(w=1,l=0) + AHK UIA-v2 库验证口径(w=0,l=1)。
        let variants: [(usize, usize); 2] = [(1, 0), (0, 1)];
        /* ⚠ 子窗上限 8 个、单条消息 120ms、总预算 300ms。
         *
         * 原来是 64 个子窗 × 2 变体 × **500ms** —— 最坏这条"零成本唤醒"要跑
         * 64 秒。而 `uia_query_with_timeout` 超过 `UIA_TIMEOUT_MS` 就把读取线程
         * 丢下不管了：反复划词会在后台堆起一串仍卡在 SendMessageTimeout 里的
         * 线程，每个还握着 COM 对象。实测日志里"读取失败"之后仍然一行行刷
         * 子窗消息，就是这个形状。
         *
         * 唤醒本身只要"给渲染子窗敲一下门"，前几个子窗就够了（Chromium 的
         * 渲染宿主窗口总是最靠前的几个之一）。 */
        let mut seen: Vec<isize> = Vec::new();
        let mut child = GetWindow(fg, GW_CHILD).unwrap_or(HWND(std::ptr::null_mut()));
        let mut g = 0;
        let deadline = Instant::now() + Duration::from_millis(300);
        while !child.0.is_null() && g < 8 && Instant::now() < deadline {
            if !seen.contains(&(child.0 as isize)) {
                seen.push(child.0 as isize);
                for &(w, l) in &variants {
                    if Instant::now() >= deadline {
                        break;
                    }
                    let mut result: usize = 0;
                    let _ = SendMessageTimeoutW(
                        child,
                        WM_GETOBJECT,
                        WPARAM(w),
                        LPARAM(l as isize),
                        SMTO_ABORTIFHUNG,
                        120,
                        Some(&mut result),
                    );
                }
            }
            child = GetWindow(child, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
            g += 1;
        }
    }
}

/// 还活着的 UIA 读取线程数（超过上限就不再新建）。
///
/// 为什么需要：`uia_query_with_timeout` 超时只是**不再等**，线程本身还在跑
/// （对方进程卡住时它可能卡在跨进程封送里很久）。而划词是高频动作 ——
/// 用户在一个卡死的程序里连划十次，就有十条线程挂在 UIA 里，每条还各持一个
/// `IUIAutomation` COM 对象。这里给一个上限，超了就直接走后面的兜底通道。
static UIA_INFLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const UIA_MAX_INFLIGHT: usize = 3;

fn uia_query_with_timeout(drag_end: POINT, drag_start: POINT) -> UiaOutcome {
    use std::sync::atomic::Ordering;
    let inflight = UIA_INFLIGHT.load(Ordering::SeqCst);
    if inflight >= UIA_MAX_INFLIGHT {
        log(&format!(
            "uia: 已有 {inflight} 条读取线程还没返回（对方进程大概率卡住），这次直接走兜底通道"
        ));
        return UiaOutcome::Failed;
    }
    UIA_INFLIGHT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel();
    let t0 = Instant::now();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            uia_selection_text_inner(drag_end, drag_start)
        }));
        // 无论正常返回还是 panic，都要把在途计数还回去（否则计数只增不减，
        // 几次之后 UIA 通道就永久停用了）
        UIA_INFLIGHT.fetch_sub(1, Ordering::SeqCst);
        let _ = tx.send(r.unwrap_or(UiaOutcome::Failed));
    });
    match rx.recv_timeout(Duration::from_millis(UIA_TIMEOUT_MS)) {
        Ok(v) => {
            log(&format!(
                "uia: {}（耗时 {}ms）",
                match &v {
                    UiaOutcome::Text(_) => "读到选区",
                    UiaOutcome::EmptySelection => "有文本模式但选区为空",
                    UiaOutcome::NoPattern => "没找到文本模式",
                    UiaOutcome::Failed => "读取失败",
                },
                t0.elapsed().as_millis()
            ));
            v
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            log("uia: 读取线程异常退出（panic），改走下一条通道");
            UiaOutcome::Failed
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            log(&format!(
                "uia: 超过 {UIA_TIMEOUT_MS}ms 没返回（对方进程没响应），改走下一条通道"
            ));
            UiaOutcome::Failed
        }
    }
}

fn uia_selection_text_inner(pt_end: POINT, pt_start: POINT) -> UiaOutcome {
    unsafe {
        // 后台线程第一次用 COM，先把自己塞进多线程公寓
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let auto: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(a) => a,
            Err(_) => return UiaOutcome::Failed,
        };

        // 唤醒先走一步：给渲染子窗发消息再查（见 uia_wake_render_children 的长注释）
        uia_wake_render_children(GetForegroundWindow());

        /* 候选元素按"离用户划的那块有多近"排：
         *   ① 松手点（最贴近选区）② 起点 ③ 前台窗口。
         * 只取一个是不够的：浏览器里鼠标底下那个叶子元素通常**没有** TextPattern，
         * 带 TextPattern 的是文档根节点 —— 所以下面还要往上找祖先。 */
        let mut cands: Vec<IUIAutomationElement> = Vec::new();
        for p in [pt_end, pt_start] {
            if let Ok(e) = auto.ElementFromPoint(p) {
                cands.push(e);
            }
        }
        let fg = GetForegroundWindow();
        if !fg.0.is_null() {
            if let Ok(e) = auto.ElementFromHandle(fg) {
                cands.push(e);
            }
        }

        let walker = auto.RawViewWalker().ok();
        // 有没有**任何一个**候选上溯到带 TextPattern 的元素 —— 用来区分
        // 「自绘 UI 没有文本模式」（可以拉黑）和「有文本模式但这次选区是空的」（不能拉黑）。
        let mut saw_pattern = false;
        for el in cands {
            let mut cur = Some(el);
            // 最多上溯 10 层：再高就是桌面/窗口框架了，没有意义
            for _ in 0..10 {
                let Some(e) = cur else { break };
                if let Ok(pat) = e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                {
                    saw_pattern = true;
                    if let Some(t) = text_from_text_pattern(&pat) {
                        return UiaOutcome::Text(t);
                    }
                }
                cur = match &walker {
                    Some(w) => w.GetParentElement(&e).ok(),
                    None => None,
                };
            }
        }
        if saw_pattern {
            UiaOutcome::EmptySelection
        } else {
            UiaOutcome::NoPattern
        }
    }
}

/// UIA 诊断探针（`--uia-probe` 用）：把「为什么读不到选区」的每一步摊开打印。
///
/// 排查「新链路 UIA 一次都没成功过」时，光看"没读到选区"三个字分不清是
/// ① 压根没找到带 TextPattern 的元素（走短路/层级不够），
/// ② 找到了但 GetSelection 是空的（选区没提交/引擎不返回），
/// ③ GetSelection 有内容但 GetText 失败。
/// 这个探针把前台窗口根元素 + 指定点（`QS_UIA_PROBE_PT=x,y`）两条候选链
/// 逐层打印：类名、有没有 TextPattern、选区数、选区文字。跑完即退。
/// 探针专用：把 Chromium 系窗口的无障碍树「唤醒」。
///
/// 机理：Chromium（Chrome / WebView2 / Electron 同一套）的无障碍树是**懒加载**的 ——
/// 只有检测到「有 UIA 客户端在听」时才真正构建。被动查询（ElementFromPoint /
/// ElementFromHandle）不会触发构建，所以直接查浏览器窗口打到的永远是桌面
/// （这就是线上日志里 UIA 对浏览器 12 连灭的原因）。屏幕阅读器靠两条路唤醒它：
///   ① AddFocusChangedListener：注册事件订阅 → 会话级「有客户端在听」置位，
///      Chromium 轮询到之后打开 kNativeAPIs 并把树建起来；
///   ② WM_GETOBJECT：直接找窗口要 provider，强制实例化。
/// QS_UIA_PROBE_WAKE=event / msg / both / all 分别验证；QS_UIA_PROBE_WAKE_MS 给
/// Chromium 建树的等待时间（树是渲染进程异步搭的，唤醒后要等一会儿）。
fn uia_probe_wake(auto: &IUIAutomation, fg: HWND, pt: Option<POINT>) {
    let mode = std::env::var("QS_UIA_PROBE_WAKE").unwrap_or_default();
    let want_event = mode.contains("event") || mode.contains("both") || mode.contains("all");
    let want_msg = mode.contains("msg") || mode.contains("objid1")
        || mode.contains("ahk") || mode.contains("both") || mode.contains("all");
    if want_event {
        // 事件订阅：一个空实现的焦点变化监听器就够 —— 目的只是让
        // 会话级「有 UIA 客户端在听」置位，让 Chromium 自己去建树。
        #[windows::core::implement(
            windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler
        )]
        struct FocusWatch;
        impl windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler_Impl
            for FocusWatch_Impl
        {
            fn HandleFocusChangedEvent(
                &self,
                _sender: windows::core::Ref<IUIAutomationElement>,
            ) -> windows::core::Result<()> {
                Ok(())
            }
        }
        let watch: windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler =
            FocusWatch.into();
        let no_cache: Option<&windows::Win32::UI::Accessibility::IUIAutomationCacheRequest> = None;
        match unsafe { auto.AddFocusChangedEventHandler(no_cache, &watch) } {
            Ok(()) => println!("uia: wake(event) 焦点变化监听已注册（空实现，只为置位）"),
            Err(e) => println!("uia: wake(event) 注册失败：{e}"),
        }
    }
    if want_msg {
        // WM_GETOBJECT：直接找窗口要 provider，强制实例化。
        // 关键一：Chromium 的 UIA provider 挂在**渲染子窗**（Chrome_RenderWidgetHostHWND）
        // 上，只给顶层 Chrome_WidgetWin_1 发是叫不醒的。枚举直接子窗逐个发。
        // 关键二：**对象 id 必须发 1**（Chromium 官方设计文档里的「自定义对象 id」）——
        // Chrome 平时主动调 NotifyWinEvent(EVENT_SYSTEM_ALERT, hwnd, 1) 探活，谁针对
        // 这个 id 回 WM_GETOBJECT，Chrome 就判定「有辅助技术在跑」，这才打开内容的
        // 无障碍树。发 OBJID_CLIENT 是普通 MSAA 查询，实测对内容树毫无作用。
        const WM_GETOBJECT: u32 = 0x003D;
        // 消息变体（wParam=objid, lParam 随消息）：
        //   ① (1, 0)：Chromium 官方设计文档口径 —— Chrome 平时主动调
        //      NotifyWinEvent(EVENT_SYSTEM_ALERT, hwnd, 1) 探活，谁针对这个
        //      自定义对象 id 回 WM_GETOBJECT，Chrome 就判定「有辅助技术在跑」。
        //   ② (0, 1)：AHK UIA-v2 社区库（Descolada）验证可用的写法
        //      ActivateChromiumAccessibility —— SendMessage(WM_GETOBJECT, 0, 1,, cHwnd)，
        //      其后轮询 ElementFromHandle 的 Children.Length 直到非空。
        // 前两次唤醒实验各只发了一种都没成（每次还混着其他变量），这里一次全发。
        let mut variants: Vec<(usize, usize)> = Vec::new();
        if mode.contains("objid1") || mode.contains("both") || mode.contains("all") {
            variants.push((1, 0));
        }
        if mode.contains("ahk") || mode.contains("both") || mode.contains("all") {
            variants.push((0, 1));
        }
        if variants.is_empty() {
            variants.push((0xFFFFFFFC, 0)); // 裸 msg 模式：旧行为 OBJID_CLIENT
        }
        let mut targets: Vec<(String, HWND)> = Vec::new();
        let mut seen: Vec<isize> = Vec::new();
        let mut push = |what: String, h: HWND, seen: &mut Vec<isize>| {
            if !h.0.is_null() && !seen.contains(&(h.0 as isize)) {
                seen.push(h.0 as isize);
                targets.push((what, h));
            }
        };
        if !fg.0.is_null() {
            push("前台窗口".into(), fg, &mut seen);
            // 子窗枚举：Chromium 的 provider 宿主都在这一层
            let mut child = unsafe { GetWindow(fg, GW_CHILD) }
                .unwrap_or(HWND(std::ptr::null_mut()));
            let mut g = 0;
            while !child.0.is_null() && g < 256 {
                push(format!("前台窗口子窗[{}]", g), child, &mut seen);
                child = unsafe { GetWindow(child, GW_HWNDNEXT) }
                    .unwrap_or(HWND(std::ptr::null_mut()));
                g += 1;
            }
        }
        if let Some(p) = pt {
            // WindowFromPoint 父链（与目标同感知级别时有效）
            let mut h = unsafe { WindowFromPoint(POINT { x: p.x, y: p.y }) };
            let mut guard = 0;
            while !h.0.is_null() && guard < 64 {
                push(
                    format!("点({},{})链[{}]", p.x, p.y, guard),
                    h,
                    &mut seen,
                );
                h = unsafe { GetAncestor(h, GA_PARENT) };
                guard += 1;
            }
        }
        for (what, h) in &targets {
            for &(objid, lparam) in &variants {
                let mut result: usize = 0;
                let lr = unsafe {
                    SendMessageTimeoutW(
                        *h,
                        WM_GETOBJECT,
                        WPARAM(objid),
                        LPARAM(lparam as isize),
                        SMTO_ABORTIFHUNG,
                        1000,
                        Some(&mut result),
                    )
                };
                println!(
                    "uia: wake(msg) 给「{what}」(hwnd=0x{:x} cls={}) 发 WM_GETOBJECT(w={objid}, l={lparam}) → lr={:?} result={result}",
                    h.0 as usize,
                    class_name(*h),
                    lr
                );
            }
        }
    }
    if !mode.is_empty() {
        // Chromium 的无障碍树是渲染进程异步搭的，唤醒后必须等一会儿再查
        let wait_ms: u64 = std::env::var("QS_UIA_PROBE_WAKE_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(900);
        println!("uia: wake 后等 {wait_ms}ms 让对方建树…");
        std::thread::sleep(Duration::from_millis(wait_ms));
    }
}

pub fn uia_probe(pt: Option<POINT>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let auto: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        {
            Ok(a) => a,
            Err(e) => {
                println!("uia: 建 UIAutomation 客户端失败：{e}");
                return;
            }
        };
        // QS_UIA_PROBE_PID：指定要探的目标进程 pid（找它的可见顶层窗口）。
        // 不给就用前台窗口 —— 生产场景里浏览器常常不是前台，pid 直指更真实。
        let fg = std::env::var("QS_UIA_PROBE_PID")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .and_then(|pid| {
                let desktop = GetDesktopWindow();
                let mut h = GetTopWindow(Some(desktop))
                    .unwrap_or(HWND(std::ptr::null_mut()));
                let mut guard = 0;
                while !h.0.is_null() && guard < 2048 {
                    if is_visible(h) && !is_minimized(h) && window_pid(h) == pid {
                        println!(
                            "uia: QS_UIA_PROBE_PID={pid} 命中 hwnd=0x{:x} cls={} title≈{}",
                            h.0 as usize,
                            class_name(h),
                            window_title(h).chars().take(40).collect::<String>()
                        );
                        return Some(h);
                    }
                    h = GetWindow(h, GW_HWNDNEXT)
                        .unwrap_or(HWND(std::ptr::null_mut()));
                    guard += 1;
                }
                println!("uia: QS_UIA_PROBE_PID={pid} 没找到可见顶层窗口");
                None
            })
            .unwrap_or_else(|| GetForegroundWindow());
        // QS_UIA_PROBE_FG=1：把目标窗口强制调到前台再探。
        // 疑点：Chromium 可能不给**后台标签页**建内容树（Edge 后台时两次唤醒实验
        // 框架树纹丝不动）；真实划词时浏览器恰恰是前台的，探针要复现这个条件。
        if std::env::var("QS_UIA_PROBE_FG").is_ok() && !fg.0.is_null() {
            println!(
                "uia: QS_UIA_PROBE_FG=1，强制前台化 hwnd=0x{:x}",
                fg.0 as usize
            );
            force_foreground(fg);
        }
        // 唤醒要在遍历之前：树还没建起来时查什么都是桌面
        uia_probe_wake(&auto, fg, pt);
        println!(
            "uia: 目标窗口 hwnd={:?} class={} pid={}",
            fg.0,
            class_name(fg),
            window_pid(fg)
        );
        let mut cands: Vec<(String, IUIAutomationElement)> = Vec::new();
        if !fg.0.is_null() {
            match auto.ElementFromHandle(fg) {
                Ok(e) => cands.push(("ElementFromHandle(目标)".into(), e)),
                Err(e) => println!("uia: ElementFromHandle 失败：{e}"),
            }
        }
        if let Some(p) = pt {
            match auto.ElementFromPoint(p) {
                Ok(e) => cands.push((format!("ElementFromPoint({},{})", p.x, p.y), e)),
                Err(e) => println!("uia: ElementFromPoint({},{}) 失败：{e}", p.x, p.y),
            }
        }
        let walker = auto.RawViewWalker().ok();
        for (src, el) in cands {
            println!("uia: ===== 候选链：{src} =====");
            let mut cur = Some(el);
            for depth in 0..10 {
                let Some(e) = cur else { break };
                let cls = e.CurrentClassName().map(|s| s.to_string()).unwrap_or_default();
                let name = e.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                match e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                    Ok(pat) => {
                        println!("uia: [{depth}] {cls} 「{name}」 → 有 TextPattern");
                        match pat.GetSelection() {
                            Ok(ranges) => {
                                let n = ranges.Length().unwrap_or(0);
                                println!("uia:     选区数 = {n}");
                                for i in 0..n {
                                    if let Ok(r) = ranges.GetElement(i) {
                                        match r.GetText(120) {
                                            Ok(b) => println!(
                                                "uia:     选区[{i}] = {:?}",
                                                b.to_string()
                                            ),
                                            Err(e) => {
                                                println!("uia:     选区[{i}] GetText 失败：{e}")
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => println!("uia:     GetSelection 失败：{e}"),
                        }
                    }
                    Err(e) => println!(
                        "uia: [{depth}] {cls} 「{name}」 → 无 TextPattern，hr=0x{:08X}",
                        e.code().0 as u32
                    ),
                }
                cur = match &walker {
                    Some(w) => w.GetParentElement(&e).ok(),
                    None => None,
                };
            }
        }
        // 向下走树：唤醒实验的真正判据 —— 前台元素的**子元素**能不能取到。
        // 树建起来时能看到 Chrome_RenderWidgetHostHWND / document / text 一串；
        // 没建起来时这里直接是空（GetFirstChildElement 报错或返回 desktop 的子）。
        if let Some(w) = &walker {
            if let Ok(root) = auto.ElementFromHandle(fg) {
                println!("uia: ===== 向下走树（唤醒后看子元素建没建）=====");
                let mut stack: Vec<(IUIAutomationElement, usize)> =
                    vec![(root, 0)];
                let mut visited = 0;
                while let Some((el, depth)) = stack.pop() {
                    if visited > 400 || depth > 5 {
                        continue;
                    }
                    visited += 1;
                    let cls = el.CurrentClassName().map(|s| s.to_string()).unwrap_or_default();
                    let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                    let has_text =
                        el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                            .is_ok();
                    let ctrl = el.CurrentControlType().map(|t| t.0).unwrap_or(0);
                    println!(
                        "uia:   [{depth}] {cls} 「{name}」 ctrl={ctrl} text={has_text}"
                    );
                    if let Ok(first) = w.GetFirstChildElement(&el) {
                        let mut sib = Some(first);
                        while let Some(s) = sib {
                            let next = w.GetNextSiblingElement(&s).ok();
                            stack.push((s, depth + 1));
                            sib = next;
                        }
                    }
                }
                println!("uia: 向下走树结束（共访问 {visited} 个元素）");
            }
        }
        println!("uia: 探针结束");
    }
}

/// 从一个 TextPattern 里把「当前所有选区」的文字拼起来。
fn text_from_text_pattern(pat: &IUIAutomationTextPattern) -> Option<String> {
    /* ⚠ 必须给 `GetText` 一个**长度上限**。
     *
     * `GetText(-1)` 是"不限长度"：用户全选一篇长文档（或网页 Ctrl+A）时，
     * UIA 会把整篇文本**跨进程封送**过来。实测这时候封送本身能跑几秒，
     * 而我们外面那个 `UIA_TIMEOUT_MS` 只是"不再等结果"，线程还在里面搬数据。
     * 划词场景本来就只要"选中的那一小段"，所以给 2 万字符的上限：
     * 正常选区永远够用，异常的全选最多也就多搬 40KB。 */
    const MAX_CHARS: i32 = 20_001;
    unsafe {
        let ranges = pat.GetSelection().ok()?;
        let n = ranges.Length().unwrap_or(0);
        let mut out = String::new();
        for i in 0..n {
            let Ok(r) = ranges.GetElement(i) else { continue };
            if let Ok(b) = r.GetText(MAX_CHARS) {
                out.push_str(&b.to_string());
                // 已经够长了就别再拼下一段（多选区的极端情况）
                if out.chars().count() >= 20_000 {
                    break;
                }
            }
        }
        let t = out.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }
}

/// 把一段文字**逐字符注入**到当前前台窗口的输入焦点里（收藏夹条目点击用）。
///
/// 为什么不用剪贴板 + Ctrl+V：那会**覆盖用户剪贴板**里原有的内容。用户对收藏夹
/// 条目的口径是「有文本框就输入进去，没有才复制到剪贴板」—— 也就是说"输入"这条
/// 路径本来就不该动剪贴板。KEYEVENTF_UNICODE 直接把 UTF-16 码元作为按键送出去，
/// 不过剪贴板、不受输入法/键盘布局影响，中文/emoji 也能原样落地。
///
/// ⚠ 和 `send_ctrl_c` 一样必须带 `SELF_INJECT_TAG`：这些按键会流经我们自己的
///   键盘钩子，不带暗号的话钩子会把它们当成"用户按的键"，逐字触发一堆钩子逻辑。
pub fn send_text(s: &str) {
    if s.is_empty() {
        return;
    }

    // 一个 Unicode 字符的按下/抬起：wVk = 0，字符本体放在 wScan 里。
    let uni = |code: u16, up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: code,
                    dwFlags: if up {
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_UNICODE
                    },
                    time: 0,
                    dwExtraInfo: SELF_INJECT_TAG,
                },
            },
        }
    };
    // 换行走**真实回车键**：直接送 U+000A 有不少程序（记事本、部分网页输入框）
    // 当没看见，只有 VK_RETURN 才真的换行。
    let ret = |up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_RETURN,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                    time: 0,
                    dwExtraInfo: SELF_INJECT_TAG,
                },
            },
        }
    };

    // 分批送：一次 SendInput 塞几百个 INPUT 有可能顶爆目标的输入队列
    // （表现是后半段文字直接丢掉）。每批之间留 2ms 让目标程序消化。
    const BATCH: usize = 32;
    let mut batch: Vec<INPUT> = Vec::with_capacity(BATCH * 2);
    let flush = |batch: &mut Vec<INPUT>| {
        if batch.is_empty() {
            return;
        }
        unsafe {
            let _ = SendInput(batch, std::mem::size_of::<INPUT>() as i32);
        }
        batch.clear();
    };

    for ch in s.chars() {
        // \r\n 只发一次回车
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            batch.push(ret(false));
            batch.push(ret(true));
        } else {
            let mut buf = [0u16; 2];
            for u in ch.encode_utf16(&mut buf) {
                // 代理对（emoji / 生僻字）拆成两个码元逐个送，WebView 与
                // 大部分原生控件都会自己拼回去
                batch.push(uni(*u, false));
                batch.push(uni(*u, true));
            }
        }
        if batch.len() >= BATCH * 2 {
            flush(&mut batch);
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    flush(&mut batch);
}

/// 连发 `n` 次退格。
///
/// 用途只有一个：**包裹符号连续点击时的"就地替换"**（见 main.rs 的
/// `wrap_text`）。我们注入完一段文字之后，光标停在注入内容末尾、选区已经没了；
/// 用户再点另一种符号时，只能先把上一条注入的内容退格删掉再重新输入 ——
/// 否则会变成"在原文字后面又粘一份"。
///
/// ⚠ 和 `send_text` 一样带 `SELF_INJECT_TAG`，否则退回的这批 Backspace
///   会被我们自己的键盘钩子当成用户按键（进而触发取词/快捷键）。
pub fn send_backspaces(n: usize) {
    if n == 0 {
        return;
    }
    /* ⚠ 逐键发、每键之间留 7ms，**不要**像 send_text 那样几十个事件塞进一次
     *   SendInput：实测（记事本 / RichEdit）一次塞 14 个 Backspace，后面几个会
     *   和紧接着的 Ctrl+V 抢跑 —— 结果是"新文本插在没删完的旧文本中间"。
     *   14 个字 ≈ 100ms，用户无感，但顺序是确定的。 */
    for _ in 0..n {
        unsafe {
            keybd_event(VK_BACK.0 as u8, 0, KEYBD_EVENT_FLAGS(0), SELF_INJECT_TAG);
        }
        std::thread::sleep(Duration::from_millis(4));
        unsafe {
            keybd_event(VK_BACK.0 as u8, 0, KEYEVENTF_KEYUP, SELF_INJECT_TAG);
        }
        std::thread::sleep(Duration::from_millis(3));
    }
}

/* ------------------------------------------------------------------ */
/* 组合键模拟（引擎「快捷键」类）                                        */
/* ------------------------------------------------------------------ */

/// 引擎「快捷键」类点击时要发给目标软件的一串按键。
///
/// `mods` 是全程按住不撒手的修饰键（可多个，如 ctrl+shift），
/// `key` 是最后一下按下去的主键。顺序语义与真实键盘一致：
/// 修饰键先按后抬，主键在中间按一下。
pub struct HotkeySpec {
    pub mods: Vec<VIRTUAL_KEY>,
    pub key: VIRTUAL_KEY,
}

/// 解析 "ctrl+shift+t" / "win+d" / "f5" / "alt+tab" 这样的序列。
///
/// ⚠ 与 main.rs 里那个**同名私有函数**（给全局热键注册用的）是两码事，别混：
///    那个只服务 RegisterHotKey（一个 VK + 修饰位、且强制必须有修饰键）；
///    这个（`win::parse_hotkey`）要表达「发给别的软件的一串真实按键」——
///    Win 键、F13~F24、prtsc、方向键、标点、以及**没有修饰键的单键**
///    （f5 刷新、prtsc 截图）都得支持。
///
/// 认不出的键名 / 出现两个主键 → `None`（调用方记日志说"按键序列无法解析"）。
pub fn parse_hotkey(spec: &str) -> Option<HotkeySpec> {
    let mut mods: Vec<VIRTUAL_KEY> = Vec::new();
    let mut key: Option<VIRTUAL_KEY> = None;
    for part in spec.split('+') {
        let p = part.trim().to_ascii_lowercase();
        if p.is_empty() {
            continue; // "ctrl++t" 这种手滑多打的加号，容错
        }
        let vk = match p.as_str() {
            "ctrl" | "control" => VK_CONTROL,
            "alt" | "menu" => VK_MENU,
            "shift" => VK_SHIFT,
            "win" | "windows" | "super" | "meta" | "cmd" | "lwin" => VK_LWIN,
            "rwin" => VK_RWIN,
            _ => {
                if key.is_some() {
                    return None; // 只能有一个主键
                }
                key = Some(parse_main_key(&p)?);
                continue;
            }
        };
        if !mods.contains(&vk) {
            mods.push(vk); // ctrl+ctrl 去重
        }
    }
    key.map(|k| HotkeySpec { mods, key: k })
}

/// 主键名 → 虚拟键码。字母 / 数字 / F1~F24 / 常用命名键 / 标点 / 小键盘。
fn parse_main_key(p: &str) -> Option<VIRTUAL_KEY> {
    // F1~F24
    if let Some(n) = p.strip_prefix('f') {
        if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
            let n: u32 = n.parse().ok()?;
            return match n {
                1 => Some(VK_F1), 2 => Some(VK_F2), 3 => Some(VK_F3), 4 => Some(VK_F4),
                5 => Some(VK_F5), 6 => Some(VK_F6), 7 => Some(VK_F7), 8 => Some(VK_F8),
                9 => Some(VK_F9), 10 => Some(VK_F10), 11 => Some(VK_F11), 12 => Some(VK_F12),
                13 => Some(VK_F13), 14 => Some(VK_F14), 15 => Some(VK_F15), 16 => Some(VK_F16),
                17 => Some(VK_F17), 18 => Some(VK_F18), 19 => Some(VK_F19), 20 => Some(VK_F20),
                21 => Some(VK_F21), 22 => Some(VK_F22), 23 => Some(VK_F23), 24 => Some(VK_F24),
                _ => None,
            };
        }
    }
    // 小键盘 0~9（num0~num9）
    if let Some(n) = p.strip_prefix("num") {
        if n.len() == 1 && n.chars().all(|c| c.is_ascii_digit()) {
            return match n {
                "0" => Some(VK_NUMPAD0), "1" => Some(VK_NUMPAD1), "2" => Some(VK_NUMPAD2),
                "3" => Some(VK_NUMPAD3), "4" => Some(VK_NUMPAD4), "5" => Some(VK_NUMPAD5),
                "6" => Some(VK_NUMPAD6), "7" => Some(VK_NUMPAD7), "8" => Some(VK_NUMPAD8),
                "9" => Some(VK_NUMPAD9),
                _ => None,
            };
        }
    }
    let vk = match p {
        // 命名键
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "esc" | "escape" => VK_ESCAPE,
        "space" | "spc" => VK_SPACE,
        "backspace" | "bs" => VK_BACK,
        "del" | "delete" => VK_DELETE,
        "ins" | "insert" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pgup" | "pageup" => VK_PRIOR,
        "pgdn" | "pgdown" | "pagedown" => VK_NEXT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "prtsc" | "printscreen" | "prtscr" | "snapshot" => VK_SNAPSHOT,
        "pause" | "break" => VK_PAUSE,
        /* ⚠ 这里**不能**再写 "menu"：`parse_hotkey` 的修饰键分支里
         *   `"alt" | "menu" => VK_MENU` 会先把 "menu" 吃掉（VK_MENU 就是 Alt
         *   的 Win32 名字），于是这一支永远走不到 —— 留着只会让人以为
         *   "menu" 表示 Apps 键。Apps 键的名字是 "apps"。 */
        "apps" | "contextmenu" => VK_APPS,
        "capslock" => VK_CAPITAL,
        // 标点（美式布局的 VK_OEM_*）
        "," | "comma" => VK_OEM_COMMA,
        "." | "period" | "dot" => VK_OEM_PERIOD,
        "/" | "slash" => VK_OEM_2,
        ";" | "semicolon" => VK_OEM_1,
        "'" | "quote" | "apostrophe" => VK_OEM_7,
        "[" => VK_OEM_4,
        "]" => VK_OEM_6,
        "\\" | "backslash" => VK_OEM_5,
        "-" | "minus" => VK_OEM_MINUS,
        "=" | "equal" | "plus" => VK_OEM_PLUS,
        "`" | "backtick" => VK_OEM_3,
        // 单个字符：字母 / 数字
        ch if ch.chars().count() == 1 => {
            let c = ch.chars().next()?; // 上面已保证有字符；不 unwrap 是防将来放宽条件后 panic
            if c.is_ascii_alphabetic() {
                return Some(VIRTUAL_KEY(0x41u16 + (c.to_ascii_uppercase() as u16 - b'A' as u16)));
            } else if c.is_ascii_digit() {
                return Some(VIRTUAL_KEY(0x30u16 + (c as u16 - b'0' as u16)));
            }
            return None;
        }
        _ => return None,
    };
    Some(vk)
}

/// 把一串组合键**模拟发给当前前台窗口**（引擎「快捷键」类点击用）。
///
/// # ⚠ 不要再改回 `PostMessage` 定向投递（这里删掉过一版，教训在这）
///
/// v1.3.0 我曾经加过一个 `post_hotkey`：用 `PostMessage(WM_KEYDOWN)` 把键**直接
/// 投给目标窗口**，想借此做到"不抢焦点"。它看起来很美，但**根本不能用**：
///
///   · `PostMessage` 返回成功只代表"消息塞进了那个窗口的消息队列"，
///     **不代表对方会处理它**。很多程序（尤其是用全局热键的）压根不读
///     `WM_KEYDOWN`，消息进去就沉了；
///   · 更坑的是它**静默失败**：日志里写着"定向投键成功"，用户那边毫无反应。
///     我因此白追了两轮才定位到真相。
///
/// 结论：**要模拟按键就老老实实注入按键**（`keybd_event`），
/// 让系统去路由（全局热键 `RegisterHotKey` 也只认真正注入的按键）。
///
/// # 另一个必须记住的坑：**先把横条收起来，再发键**
///
/// 用户点横条上那颗图标时，**横条自己占着前台**。这时候注入按键，键会打在
/// 我们自己身上，目标程序的全局热键收不到。所以调用方（`open_search`）
/// 的顺序是"收横条 → 等 60ms → 发键"，不能颠倒。
///
/// 返回 `false` = 序列里有不认识的键名（一个键都没发，调用方记日志）。
///
/// 和 `send_ctrl_c` / `send_text` 一样，每个按键都带 `SELF_INJECT_TAG`：
/// 这些按键会流经我们自己的键盘钩子，不带暗号的话钩子会把它们当成
/// "用户按的键"，平白触发一堆钩子逻辑（比如又弹一次横条）。
pub fn send_hotkey(spec: &str) -> bool {
    let Some(h) = parse_hotkey(spec) else {
        return false;
    };
    /* ⚠ r89b：**改用 `keybd_event`，不用 `SendInput`**（实测结论）。
     *
     * # 为什么换（用户报的 bug）
     *
     * 用户原话：「我现在用章鱼速贴快捷输入，它不能够换出来这个快捷键对应的效果」。
     *
     * 实测对照（同一台机器、同一个 Octoclip 进程）：
     *
     *   | 注入方式 | 能不能唤出 Octoclip 的浮层 |
     *   |---|---|
     *   | `SendInput`（原来用的） | **不能** |
     *   | `keybd_event`（现在改用） | **可以** |
     *
     * 原因：Octoclip 这类应用用 **`RegisterHotKey` 注册系统级全局热键**。
     * `SendInput` 注入的按键**不会触发 `RegisterHotKey` 注册的热键**
     * （微软的已知行为：热键匹配走的是原始输入线程，而 `SendInput` 在某些
     * 合成路径上被跳过）。`keybd_event` 走的是更老的注入路径，反而能触发。
     *
     * 这不是"新旧 API 偏好"的问题 —— 是**功能能不能用**的问题，
     * 所以即便 `keybd_event` 已被标记为 legacy，这里也用它。
     *
     * ⚠ 仍然带 `SELF_INJECT_TAG`：这些键会流经我们自己的键盘钩子，
     *   不带暗号的话钩子会把它们当成"用户按的键"，平白触发一堆钩子逻辑
     *   （比如又弹一次横条）。`keybd_event` 的最后一个参数就是 dwExtraInfo。
     *
     * ⚠ 顺序必须"修饰键先全按下 → 主键按一下 → 修饰键反序抬起"：
     *   一次性按下再一次性抬起会让目标程序看到"Ctrl 和 T 同时按下"，
     *   很多程序的热键匹配要求修饰键**先于**主键处于按下状态。 */
    unsafe {
        let ev = |vk: u16, up: bool| {
            keybd_event(
                vk as u8,
                0,
                if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                SELF_INJECT_TAG,
            );
        };
        // 修饰键先全部按下
        for m in h.mods.iter() {
            ev(m.0, false);
            std::thread::sleep(Duration::from_millis(8));
        }
        std::thread::sleep(Duration::from_millis(8));
        // 主键按一下
        ev(h.key.0, false);
        std::thread::sleep(Duration::from_millis(14));
        ev(h.key.0, true);
        std::thread::sleep(Duration::from_millis(8));
        // 修饰键反序抬起（先按的后抬，与真实键盘一致）
        for m in h.mods.iter().rev() {
            ev(m.0, true);
            std::thread::sleep(Duration::from_millis(8));
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// r88：从 exe 里提取图标 —— 用户要求「选择某个应用时把它的图标
    /// 作为软件里显示的图标」。
    ///
    /// 用系统自带的 `notepad.exe` 当样本（Windows 每个版本都有，且它的
    /// 图标是**带 alpha 的彩色图标**，正好能验证"透明通道有没有保住"）。
    ///
    /// ⚠ 这个测试**必须跑在真实 Windows 会话里**：`PrivateExtractIconsW`
    ///   要读 PE 资源、还要建 DC 画图，无桌面会话里会失败。失败时按"跳过"
    ///   处理（和 glass 那边 `can_capture` 的套路一致），不当作产品缺陷。
    #[test]
    fn 从_exe_提取图标并且保住透明通道() {
        let path = r"C:\Windows\System32\notepad.exe";
        if !std::path::Path::new(path).exists() {
            eprintln!("没有 notepad.exe，跳过");
            return;
        }
        let Some((w, h, rgba)) = extract_app_icon(path, 256) else {
            eprintln!("这个环境取不到图标（无桌面会话？），跳过");
            return;
        };

        // ① 尺寸与字节数要对得上
        assert!(w > 0 && h > 0, "尺寸不能是 0");
        assert_eq!(w, h, "图标应当是正方形（拿到的 {w}x{h}）");
        assert_eq!(
            rgba.len(),
            (w as usize) * (h as usize) * 4,
            "RGBA 字节数必须 = 宽×高×4"
        );

        // ② 必须有**内容** —— 不能是一整块全 0（那说明根本没画上）
        let non_zero = rgba.as_chunks::<4>().0.iter().filter(|p| p[3] > 0).count();
        let total = (w as usize) * (h as usize);
        assert!(
            non_zero * 100 / total >= 20,
            "不透明的像素太少（{non_zero}/{total}）—— 图标可能没画上"
        );

        // ③ 必须有**透明**区域 —— 这是"alpha 通道真的被用上了"的证据。
        //    丢了 alpha 的典型症状是整张 255 + 四角变黑，这条断言正抓它。
        let transparent = rgba.as_chunks::<4>().0.iter().filter(|p| p[3] == 0).count();
        assert!(
            transparent > 0,
            "没有任何全透明像素 —— alpha 通道丢了？(notepad 图标四角是透明的)"
        );

        // ④ 颜色要有变化（不是纯黑/纯白一块）
        let mut colors = std::collections::HashSet::new();
        for p in rgba.as_chunks::<4>().0.iter().filter(|p| p[3] > 128) {
            colors.insert((p[0] / 32, p[1] / 32, p[2] / 32));
        }
        assert!(colors.len() >= 3, "颜色种类太少（{}）—— 图标可能没画对", colors.len());
    }

    /// 容量不足的路径不该 panic、也不该编出假数据。
    #[test]
    fn 取不存在的文件返回_none() {
        assert!(extract_app_icon(r"C:\不存在的目录\nope.exe", 256).is_none());
    }

    /// **`.lnk` 快捷方式也要能取到图标**（r88）。
    ///
    /// 用户选应用时挑的多半是开始菜单里的快捷方式，所以这条不是冷门分支、
    /// 是主路径之一。它走的是 `SHGetFileInfoW`（shell 会解析快捷方式目标），
    /// 而不是 `PrivateExtractIconsW`（**实测对 .lnk 返回 0**，快捷方式里
    /// 没有图标资源）。
    ///
    /// 这里从开始菜单里找一个真实 `.lnk` 当样本；找不到就跳过
    /// （干净容器里可能没有开始菜单项）。
    #[test]
    fn 从_lnk_快捷方式也能取到图标() {
        let mut roots = Vec::new();
        for k in ["APPDATA", "ProgramData"] {
            if let Ok(base) = std::env::var(k) {
                roots.push(format!(r"{base}\Microsoft\Windows\Start Menu"));
            }
        }
        // 递归找一个 .lnk（最多找 200 个，别在大目录里爬太久）
        let mut found: Option<String> = None;
        for root in roots {
            if !std::path::Path::new(&root).exists() {
                continue;
            }
            let mut stack = vec![std::path::PathBuf::from(&root)];
            let mut seen = 0;
            while let Some(dir) = stack.pop() {
                let Ok(rd) = std::fs::read_dir(&dir) else { continue };
                for e in rd.flatten() {
                    seen += 1;
                    if seen > 200 {
                        break;
                    }
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
                        found = Some(p.to_string_lossy().to_string());
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        let Some(lnk) = found else {
            eprintln!("这台机器上找不到开始菜单 .lnk，跳过");
            return;
        };
        let Some((w, h, rgba)) = extract_app_icon(&lnk, 256) else {
            panic!("快捷方式取不到图标：{lnk}");
        };
        assert!(w > 0 && h > 0, "尺寸不能是 0");
        assert_eq!(rgba.len(), (w as usize) * (h as usize) * 4, "RGBA 字节数要对");
        // 得有真的内容（不能是空图）
        let non_zero = rgba.as_chunks::<4>().0.iter().filter(|p| p[3] > 0).count();
        assert!(
            non_zero * 100 / ((w as usize) * (h as usize)) >= 10,
            "快捷方式的图标几乎是空的（{w}x{h}，{non_zero} 个不透明像素）"
        );
    }

    fn vk_of(spec: &str) -> Option<(Vec<u16>, u16)> {
        let h = parse_hotkey(spec)?;
        Some((
            h.mods.iter().map(|v| v.0).collect(),
            h.key.0,
        ))
    }

    #[test]
    fn uia_browser_exe_matching() {
        // 大小写不敏感（process_exe 拿到的可能是任意大小写）
        assert!(uia_exe_is_browser("msedge.exe"));
        assert!(uia_exe_is_browser("MSEDGE.EXE"));
        assert!(uia_exe_is_browser("chrome.exe"));
        assert!(uia_exe_is_browser("brave.exe"));
        // 非浏览器：记事本 / 微信 / Word —— 这些场景 UIA 该走
        assert!(!uia_exe_is_browser("notepad.exe"));
        assert!(!uia_exe_is_browser("WeChat.exe"));
        assert!(!uia_exe_is_browser("WINWORD.EXE"));
        assert!(!uia_exe_is_browser("QuickSearch.exe"));
        // WebView2 / Electron 应用走可执行名判据，不能被浏览器名误伤：
        // 它们的窗口类名是 Chrome_WidgetWin_*，exe 名五花八门，天然不命中
        assert!(!uia_exe_is_browser("code.exe"));
        assert!(!uia_exe_is_browser("obsidian.exe"));
    }

    #[test]
    fn hotkey_parses_common_combos() {
        // ctrl+shift+t = 浏览器「恢复刚关的标签页」
        let (m, k) = vk_of("ctrl+shift+t").unwrap();
        assert_eq!(m, vec![VK_CONTROL.0, VK_SHIFT.0]);
        assert_eq!(k, 0x54); // 'T'
        // win+shift+s = Windows 截图工具
        let (m, k) = vk_of("Win+Shift+S").unwrap();
        assert_eq!(m, vec![VK_LWIN.0, VK_SHIFT.0]);
        assert_eq!(k, 0x53); // 'S'
        // win+d
        let (m, k) = vk_of("win+d").unwrap();
        assert_eq!(m, vec![VK_LWIN.0]);
        assert_eq!(k, 0x44);
        // 单键无修饰：f5 / prtsc
        assert_eq!(vk_of("f5").unwrap().1, VK_F5.0);
        assert_eq!(vk_of("prtsc").unwrap().1, VK_SNAPSHOT.0);
        // alt+tab
        let (m, k) = vk_of("alt+tab").unwrap();
        assert_eq!(m, vec![VK_MENU.0]);
        assert_eq!(k, VK_TAB.0);
        // 方向键 / 命名键 / 小键盘
        assert_eq!(vk_of("ctrl+alt+left").unwrap().1, VK_LEFT.0);
        assert_eq!(vk_of("ctrl+home").unwrap().1, VK_HOME.0);
        assert_eq!(vk_of("ctrl+num7").unwrap().1, VK_NUMPAD7.0);
        assert_eq!(vk_of("f24").unwrap().1, VK_F24.0);
        // 修饰键顺序无关 + 重复去重 + 手滑多加号容错
        assert_eq!(vk_of("shift+ctrl+t").unwrap().0, vec![VK_SHIFT.0, VK_CONTROL.0]);
        assert_eq!(vk_of("ctrl+ctrl+t").unwrap().0, vec![VK_CONTROL.0]);
        assert_eq!(vk_of("ctrl++t").unwrap().0, vec![VK_CONTROL.0]);
    }

    #[test]
    fn hotkey_rejects_garbage() {
        assert!(parse_hotkey("").is_none(), "空序列");
        assert!(parse_hotkey("ctrl").is_none(), "只有修饰键没有主键");
        assert!(parse_hotkey("ctrl+t+k").is_none(), "两个主键");
        assert!(parse_hotkey("ctrl+f99").is_none(), "F99 不存在");
        assert!(parse_hotkey("ctrl+奇怪").is_none(), "不认识的键名");
        assert!(parse_hotkey("ctrl+fg").is_none(), "f 后面不是纯数字");
    }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

pub fn window_ex_style(hwnd: HWND) -> u32 {
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 }
}

pub fn set_ex_style(hwnd: HWND, style: u32) {
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);
    }
}

/// 让窗口彻底不抢焦点、不进 Alt+Tab
pub fn make_overlay(hwnd: HWND) {
    let cur = window_ex_style(hwnd);
    set_ex_style(
        hwnd,
        cur | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0,
    );
}

/// 右下角提示用的窗口：不抢焦点、不进 Alt+Tab、**鼠标穿透**
/// （点下去落到下面的程序上 —— 提示只是"扫一眼"，不该挡任何操作）。
pub fn make_click_through(hwnd: HWND) {
    let cur = window_ex_style(hwnd);
    set_ex_style(
        hwnd,
        cur | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0,
    );
}

pub fn set_noactivate(hwnd: HWND, no_activate: bool) {
    let cur = window_ex_style(hwnd);
    let next = if no_activate {
        cur | WS_EX_NOACTIVATE.0
    } else {
        cur & !WS_EX_NOACTIVATE.0
    };
    set_ex_style(hwnd, next);
}

pub fn move_resize(hwnd: HWND, x: i32, y: i32, w: i32, h: i32, show: bool) {
    unsafe {
        let mut flags = SWP_NOACTIVATE;
        if show {
            flags |= SWP_SHOWWINDOW;
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, flags);
    }
}

/// 只挪位置、**不改尺寸、不激活**，同步生效（返回时窗口已经在新位置）。
///
/// 为什么不用 Tauri 的 `set_position`：那是投递到事件循环的异步调用，
/// 调用方只能"盲等一段时间再假设它生效了"。弹横条前要把上一根挪出屏幕再取色，
/// 那里就是这么盲等 36ms 的 —— 既慢又不保证。这里一次 `SetWindowPos` 同步挪走。
pub fn move_only(hwnd: HWND, x: i32, y: i32) {
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            x,
            y,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
        );
    }
}

/// 把窗口重新挤回「最顶层」，但**不动它的位置和尺寸**，也不抢激活。
///
/// 为什么需要：Tauri 的 `.always_on_top(true)` 只在**建窗那一刻**设一次。
/// 本机上有别的全局工具/浮层会把自己推到最前，全屏遮罩被压到下面就再也
/// 收不到鼠标事件了（全局钩子看得到 mouseup，遮罩页面却收不到 mousedown）。
/// 定期重申一次 z 序即可解决。`SWP_NOMOVE|SWP_NOSIZE` 保证只调层级，
/// 不会让窗口跳一下。
/// 横条窗口**绝不能被最大化**。
///
/// 用户报过：「在这个窗口上按窗口最大化的快捷键（Win+↑ / 双击标题之类），它就跑到
/// 别的地方去了」——横条是无边框自绘浮层，被系统最大化之后尺寸/位置会被改成整屏，
/// 窗口里的面板、拖动全部跟着乱套。
/// 做法两步：① 去掉 WS_MAXIMIZEBOX（让系统快捷键不再对它生效）；
/// ② 万一已经被最大化了（有些环境直接发 SC_MAXIMIZE），立刻 restore 回原尺寸。
pub fn forbid_maximize(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, IsZoomed, SetWindowLongPtrW, ShowWindow, GWL_STYLE, SW_RESTORE,
    };
    const WS_MAXIMIZEBOX: isize = 0x0001_0000;
    unsafe {
        let st = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if st & WS_MAXIMIZEBOX != 0 {
            SetWindowLongPtrW(hwnd, GWL_STYLE, st & !WS_MAXIMIZEBOX);
            log("bar win: 已去掉 WS_MAXIMIZEBOX（禁止最大化）");
        }
        if IsZoomed(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            log("bar win: 检测到被最大化，已 restore");
        }
    }
}

pub fn reassert_topmost(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    // 每次重申置顶时顺手把「最大化」禁掉 —— 系统快捷键可能在两次之间把它拉大
    forbid_maximize(hwnd);
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

pub fn show_no_activate(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

/// **最后一道保险**：把框选遮罩从屏幕上直接扒下来。
///
/// 为什么需要它（这是个"绝不能发生"级别的兜底）：
/// 框选遮罩铺满整屏、置顶、还吃掉全部鼠标。一旦它建出来却关不掉，
/// 用户就**整个屏幕点不动**——任务栏也点不到，只能强杀进程。
/// 正常的关闭路径是 Tauri 的 `close_window`，但它要经主线程；
/// 万一主线程正卡在别处（比如建另一个 WebView2 时死锁），这条路就废了。
/// `DestroyWindow` 是直接调 Win32，不经过 Tauri 的事件循环，
/// 是这时候唯一还能把人救出来的办法。
///
/// 先 `ShowWindow(SW_HIDE)` 再销毁：光销毁的话，窗口消失前那一帧还可能
/// 继续吃鼠标；先隐藏能立刻把鼠标还给用户。
pub fn force_kill_overlay(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
        /* ⚠ `DestroyWindow` 只能销毁**本线程创建**的窗口，跨线程调用必然返回
         * FALSE（错误码 5 拒绝访问）。遮罩窗口是 Tauri 主线程建的，这段兜底
         * 代码几乎总是跑在别的线程上 —— 所以以前那句 `DestroyWindow` 实际上
         * 什么都没做，只剩一句"强杀"的日志。
         *
         * 正确做法是**请求它的属主线程去销毁**：
         *   1. 先投 WM_CLOSE（走正常的销毁路径，wry 会自己清理 WebView2）；
         *   2. 再投 WM_SYSCOMMAND + SC_CLOSE 兜一层（有些窗口不处理 WM_CLOSE）。
         * 两条都是 PostMessageW，不阻塞、也不需要跨线程调用窗口过程。 */
        if crate::win::is_window(hwnd) {
            let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            let _ = PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(SC_CLOSE as usize),
                LPARAM(0),
            );
            // 再补一次隐藏：投递是异步的，可能这一帧窗口还挂在最上面吃药丸。
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// 句柄还活着吗（`IsWindow` 的薄封装）。
pub fn is_window(hwnd: HWND) -> bool {
    unsafe { IsWindow(Some(hwnd)).as_bool() }
}

/// 这个句柄看起来还是不是我们的「框选遮罩」。
///
/// 用途只有一个：**强杀之前复核**。`REGION_HWND` 是缓存句柄，窗口销毁后句柄值
/// 会被系统复用 —— 不复核就动手，可能把别的程序的窗口关掉。
///
/// 判据：类名是我们自己窗口的 `Tauri Window`（wry 的宿主窗口类），
/// 且带 `WS_EX_TOOLWINDOW`（遮罩建出来时就是这么设的，见 `make_overlay`）。
/// 两条都不满足就认为已经被复用，调用方应当放弃强杀。
pub fn looks_like_overlay(hwnd: HWND) -> bool {
    if !is_window(hwnd) {
        return false;
    }
    let cls = class_name(hwnd);
    if !cls.contains("Tauri Window") && !cls.contains("WebView") {
        return false;
    }
    let (_, ex) = style_of(hwnd);
    (ex & WS_EX_TOOLWINDOW.0) != 0
}

pub fn hide(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

pub fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut r).is_ok() {
            Some(r)
        } else {
            None
        }
    }
}

pub fn is_visible(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd).as_bool() }
}

/// 最小化的窗口 rect 会跑到 (-32000,-32000)，光看矩形会误判，得单独排掉
pub fn is_minimized(hwnd: HWND) -> bool {
    unsafe { IsIconic(hwnd).as_bool() }
}

pub fn dpi_scale(hwnd: HWND) -> f64 {
    unsafe {
        let dpi = GetDpiForWindow(hwnd);
        if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        }
    }
}

/// 屏幕工作区（避开任务栏）
pub fn work_area_near(x: i32, y: i32) -> RECT {
    unsafe {
        let pt = POINT { x, y };
        let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
        };
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            mi.rcWork
        } else {
            RECT {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            }
        }
    }
}

/// 指定点所在**显示器**的物理边界（含任务bar区域）。
/// 摆位的最后一道保险用它：横条的可见部分绝不允许出屏 ——
/// 用户报过"在屏幕边缘复制时横条有一半在屏幕外"，就是缺这道钳制。
pub fn monitor_near(x: i32, y: i32) -> RECT {
    unsafe {
        let pt = POINT { x, y };
        let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
        };
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            mi.rcMonitor
        } else {
            RECT {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            }
        }
    }
}

pub fn style_of(hwnd: HWND) -> (u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_STYLE};
    unsafe {
        let st = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        (st, ex)
    }
}

pub fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    unsafe {
        let n = GetClassNameW(hwnd, &mut buf);
        if n <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..n as usize])
        }
    }
}

/// 窗口标题（用户看到的那行字）。取不到返回空串。
///
/// 给收藏夹面板点条目后的提示用 —— 「已输入到 记事本」比「已输入到当前软件」
/// 有用得多，用户能一眼确认是不是打到自己想要的那个窗口里了。
pub fn window_title(hwnd: HWND) -> String {
    if hwnd.0.is_null() {
        return String::new();
    }
    let mut buf = [0u16; 512];
    unsafe {
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..n as usize]).trim().to_string()
        }
    }
}

pub fn window_under_point(x: i32, y: i32) -> HWND {
    unsafe { WindowFromPoint(POINT { x, y }) }
}

pub fn set_foreground(hwnd: HWND) {
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
}

/// 强制把某个窗口提到前台 —— 即使**我们自己不是当前前台进程**。
///
/// 为什么需要它：`SetForegroundWindow` 有一条"前台锁定"—— 调用进程不是当前前台
/// 进程时会被**静默拒绝**（没有返回值可查，只能事后核对 GetForegroundWindow）。
/// 收藏夹面板有时候是**程序化打开**的（全局快捷键唤起 → 前端直接 openFavPanel，
/// 中间没有一次真实的鼠标点击），这时候我们从来没拿到过前台权限，
/// 「把焦点还给目标软件」那一步就会被拒 —— 注入只能退回复制到剪贴板
/// （探针里实测到了这条：`fav_send: 前台变成了 …（不是目标 …）→ 退回复制`）。
///
/// 办法是经典的两步：先把我们的输入队列 attach 到**当前前台窗口所在线程**，
/// 这样两者的输入状态被视作一体、前台锁定不再拦我们；设完立刻 detach。
/// 失败也不要紧 —— 上层注入前会**复核前台到底是谁**，复核不过就退回复制，不会乱打。
pub fn force_foreground(hwnd: HWND) {
    unsafe {
        let fg = GetForegroundWindow();
        let fg_tid = if fg.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg, None)
        };
        let me_tid = GetCurrentThreadId();
        let attached = fg_tid != 0
            && fg_tid != me_tid
            && AttachThreadInput(me_tid, fg_tid, true).as_bool();
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(me_tid, fg_tid, false);
        }
    }
}

pub fn foreground_addr() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

pub fn foreground_window() -> HWND {
    unsafe { GetForegroundWindow() }
}

/// 某个 Tauri 窗口此刻是不是系统前台窗口。
///
/// 给「框选遮罩抢焦点」用：窗口建好后 WebView2 拿到键盘焦点有时会晚一点，
/// 靠反复 `set_focus()` + 这个判断，就能确认它真的成为前台了、按键能收到了，
/// 不用傻等一个写死的时长（等短了没收住，等长了用户觉得卡）。
pub fn foreground_is(w: &crate::t::WebviewWindow) -> bool {
    let Ok(hwnd) = w.hwnd() else { return false };
    let fg = unsafe { GetForegroundWindow() };
    fg.0 as isize == hwnd.0 as isize
}

/// 剪贴板当前内容是谁放的（SetClipboardData 的调用方窗口）。
/// 没人放 / 已经销毁时返回 null。
pub fn clipboard_owner() -> HWND {
    unsafe { GetClipboardOwner().unwrap_or(HWND(std::ptr::null_mut())) }
}

/// 窗口所属进程 pid
pub fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

/// 一路向上找到顶层窗口
pub fn root_window(hwnd: HWND) -> HWND {
    unsafe { GetAncestor(hwnd, GA_ROOT) }
}

/// Z 序上的下一个窗口（往下找一层）
pub fn next_window(hwnd: HWND) -> HWND {
    unsafe { GetWindow(hwnd, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut())) }
}

/// 取某个坐标下**不属于本进程**的最上面那个可见顶层窗口。
///
/// 给「黑白名单拾取器」用：拾取器自己是一张铺满全屏、always_on_top 的透明窗口，
/// 直接用 `WindowFromPoint` 取到的永远是它自己；而沿 `GW_HWNDNEXT` 往下跳也不行 ——
/// 实测只能走两三跳就断（`always_on_top` 窗口自成一段 Z 序，跳出去就没了，
/// 根本够不到下面的真实程序，于是"点哪都认不出来"）。
///
/// 可靠做法：从**桌面 Z 序最顶端**（`GetTopWindow(desktop)`）开始，沿 `GW_HWNDNEXT`
/// 一层层往下扫；对每个可见的顶层窗口，用它的窗口矩形判断是否包含这个点，
/// 命中第一个非本进程的窗口就返回。这一步纯同步、不依赖 FOCUS、也不依赖
/// 「我们的窗口关没关」，因此稳定。
pub fn foreign_window_at(x: i32, y: i32) -> HWND {
    let me = std::process::id();
    unsafe {
        let desktop = GetDesktopWindow();
        let mut h = GetTopWindow(Some(desktop)).unwrap_or(HWND(std::ptr::null_mut()));
        let mut guard = 0;
        while !h.0.is_null() && guard < 2048 {
            if is_visible(h) && !is_minimized(h) {
                // 点击穿透的蒙层不算「鼠标底下的窗口」。WGestures 那块全屏蒙层
                // 实测 ex=0x80800a8（LAYERED|TRANSPARENT|TOPMOST|NOACTIVATE），
                // Z 序第 1、铺满全屏 —— 不跳过它，触发现场（show_bar）和黑白
                // 名单拾取器在它运行期间全会抓到这块幻影：收藏夹注入目标变成
                // 一个没有文本框的蒙层，快捷键引擎的组合键也全打到它身上
                // （探针 B1/B3 实测的「触发现场=0xa0c00」正是这个）。
                // `WindowFromPoint` 本来就跳过这类窗口，这里把两条路对齐。
                if (window_ex_style(h) & WS_EX_TRANSPARENT.0) == 0 {
                    let mut r = RECT::default();
                    if GetWindowRect(h, &mut r).is_ok()
                        && x >= r.left && x < r.right && y >= r.top && y < r.bottom
                    {
                        let pid = window_pid(h);
                        if pid != 0 && pid != me {
                            log(&format!(
                                "foreign_window_at({x},{y}) 命中 hwnd=0x{:x} pid={pid} rect=({},{},{},{})",
                                h.0 as usize, r.left, r.top, r.right, r.bottom
                            ));
                            return h;
                        }
                    }
                }
            }
            h = GetWindow(h, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
            guard += 1;
        }
        log(&format!("foreign_window_at({x},{y}) 扫完 {guard} 个顶层窗口仍未命中"));
        HWND(std::ptr::null_mut())
    }
}

/// 点是否落在窗口的客户区里（用来排除拖标题栏 / 拖边框）
pub fn point_in_client(hwnd: HWND, x: i32, y: i32) -> bool {
    let mut r = RECT::default();
    unsafe {
        if GetClientRect(hwnd, &mut r).is_err() {
            return false;
        }
        let mut p = POINT { x, y };
        if !ScreenToClient(hwnd, &mut p).as_bool() {
            return false;
        }
        p.x >= r.left && p.y >= r.top && p.x < r.right && p.y < r.bottom
    }
}

/// Windows 的「应用使用浅色主题」开关，取不到就返回 None
pub fn apps_use_light_theme() -> Option<bool> {
    unsafe {
        let sub = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            None,
            KEY_QUERY_VALUE,
            &mut hkey,
        )
        .0 != 0
        {
            return None;
        }
        let name = wide("AppsUseLightTheme");
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let rc = RegQueryValueExW(
            hkey,
            PCWSTR(name.as_ptr()),
            None,
            None,
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if rc.0 != 0 {
            None
        } else {
            Some(data != 0)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 开机自启                                                            */
/* ------------------------------------------------------------------ */

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "QuickSearch";

pub fn set_autostart(enable: bool) -> bool {
    unsafe {
        let sub = wide(RUN_KEY);
        let mut hkey = HKEY::default();
        let rc = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            None,
            KEY_SET_VALUE,
            &mut hkey,
        );
        if rc.0 != 0 {
            return false;
        }
        let name = wide(RUN_VALUE);
        let ok = if enable {
            let exe = match std::env::current_exe() {
                Ok(p) => p,
                Err(_) => {
                    let _ = RegCloseKey(hkey);
                    return false;
                }
            };
            let cmd = wide(&format!("\"{}\"", exe.to_string_lossy()));
            let bytes = std::slice::from_raw_parts(
                cmd.as_ptr() as *const u8,
                cmd.len() * std::mem::size_of::<u16>(),
            );
            RegSetValueExW(
                hkey,
                PCWSTR(name.as_ptr()),
                None,
                REG_SZ,
                Some(bytes),
            )
            .0 == 0
        } else {
            RegDeleteValueW(hkey, PCWSTR(name.as_ptr())).0 == 0
        };
        let _ = RegCloseKey(hkey);
        ok
    }
}

/* ------------------------------------------------------------------ */
/* 钩子类型别名                                                        */
/* ------------------------------------------------------------------ */

pub type HookFn = Option<unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT>;


pub fn call_next(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe { CallNextHookEx(None, code, w, l) }
}

pub fn ll_mouse(l: LPARAM) -> MSLLHOOKSTRUCT {
    unsafe { *(l.0 as *const MSLLHOOKSTRUCT) }
}

pub fn ll_keyboard(l: LPARAM) -> KBDLLHOOKSTRUCT {
    unsafe { *(l.0 as *const KBDLLHOOKSTRUCT) }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

pub fn clamp_rect(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    area: RECT,
    gap_from: Option<POINT>,
) -> (i32, i32) {
    let mut nx = x;
    let mut ny = y;
    let pad = 6;
    if nx + w > area.right - pad {
        nx = area.right - w - pad;
    }
    if ny + h > area.bottom - pad {
        // 下方放不下就翻到参考点上面
        ny = match gap_from {
            Some(p) => p.y - h - 6,
            None => area.bottom - h - pad,
        };
    }
    if nx < area.left + pad {
        nx = area.left + pad;
    }
    if ny < area.top + pad {
        ny = area.top + pad;
    }
    (nx, ny)
}

/// 等一小会儿，最多 `ms` 毫秒；`f` 返回 true 就提前结束。返回是否成功。
pub fn wait_until<F: FnMut() -> bool>(ms: u64, mut f: F) -> bool {
    let t0 = Instant::now();
    loop {
        if f() {
            return true;
        }
        if t0.elapsed() >= Duration::from_millis(ms) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(6));
    }
}

/* ------------------------------------------------------------------ */
/* 进程（黑/白名单用）                                                  */
/* ------------------------------------------------------------------ */

/// 取某个进程的可执行文件名（不含路径），如 `notepad.exe`。
///
/// 用 `PROCESS_QUERY_LIMITED_INFORMATION` 而不是 QUERY_INFORMATION：
/// 前者拿普通权限就能打开大多数进程，也够查路径了，不会因为权限不够而白名单失效。
pub fn process_exe(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        if r.is_err() || len == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        // 只留文件名，白名单里让用户填 notepad.exe 就行，不用整条路径
        Some(full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string())
    }
}

/* ------------------------------------------------------------------ */
/* r58：快捷键引擎「绑定应用」                                          */
/*                                                                      */
/* 用户原话：「绑定应用，作用是一个快捷键，绑定应用，当在横条里面点击这个 */
/* 快捷键对应的图标之后，软件内部要先确定这个应用真的已经打开了，如果打开 */
/* 了就...把这个快捷键给运用出来，如果没有打开，那就先打开这个应用，然后  */
/* 再实行快捷键。」                                                     */
/*                                                                      */
/* 三件事：① 判断应用在不在跑；② 不在就拉起来（可选提权）；③ 把焦点交给   */
/* 它，再把按键发过去 —— 不发焦点过去的话，按键会打到当前前台（用户刚在  */
/* 别的软件里划词），那就等于什么都没发生。                              */
/* ------------------------------------------------------------------ */

/// 取某个进程的**完整**可执行文件路径（如 `C:\Program Files\App\App.exe`）。
///
/// 和 [`process_exe`] 的区别：那个只回文件名（判"是不是同一个应用"够用），
/// 这个回全路径 —— r59 的「十字准星点选应用」要把路径填进配置，
/// 只给文件名的话用户下次点图标时 `launch_app` 找不到东西。
pub fn process_exe_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(h);
        if r.is_err() || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// 屏幕上某个点最上面那个窗口的**顶层**窗口。
///
/// 给「十字准星点选应用」用：用户点哪儿，我们就查那儿的窗口属于哪个进程。
///
/// ⚠ 调用方必须**先把自己的全屏遮罩关掉**再来问：遮罩是 topmost 且铺满整屏，
///   它还在的时候 `WindowFromPoint` 永远返回遮罩自己，问出来就是本进程 ——
///   用户点了记事本却拿到 QuickSearch.exe。这个坑很隐蔽（界面上"看起来成功了"）。
pub fn window_at_point(x: i32, y: i32) -> Option<HWND> {
    let p = POINT { x, y };
    let h = unsafe { WindowFromPoint(p) };
    if h.0.is_null() {
        return None;
    }
    let root = root_window(h);
    if root.0.is_null() {
        Some(h)
    } else {
        Some(root)
    }
}

/// 从一条路径里取可执行文件名（`C:\x\Photoshop.exe` → `Photoshop.exe`）。
///
/// 判"应不应该算同一个应用"按**文件名**比，不按全路径：同一个程序可能从
/// 开始菜单、桌面快捷方式、更新后的新版本目录启动，全路径各不相同，但进程名
/// 永远是那个 exe 名。按全路径比会得出"没在跑"然后重复拉起一个实例 ——
/// 那比"没反应"更糟（用户的文档可能被两个实例抢）。
pub fn exe_name_of(path: &str) -> String {
    let t = path.trim().trim_matches('"');
    t.rsplit(['\\', '/']).next().unwrap_or(t).trim().to_string()
}

/// 有没有**任何一个**进程的可执行文件名是 `exe_name`（大小写不敏感）。
///
/// 用 `EnumProcesses` 拿全量 pid 再逐个 `process_exe`。看起来笨，但：
///   · 不引新依赖（Toolhelp 的 PROCESSENTRY32 要手写结构体对齐）；
///   · 只在用户点快捷键引擎那一刻跑一次，几十毫秒，不在热路径上。
/// ⚠ 权限不够时 `process_exe` 返回 None（受保护进程），跳过即可 ——
///   那类进程也不可能是用户绑定的应用。
pub fn app_running(exe_name: &str) -> bool {
    let want = exe_name.trim();
    if want.is_empty() {
        return false;
    }
    /* ⚠ pid 表要**按需要扩容**。
     *
     * 原来固定 4096 个槽位、再用 `.min(pids.len())` 截断：进程数超过 4096 的
     * 机器上（跑了一堆 Electron / 服务）被截掉的那部分永远扫不到 —— 一个正在
     * 运行的软件会被判成"没运行"，于是 `wait_app_ready` 又去 `ShellExecuteW`
     * 拉一次，用户看到的是"同一个软件越开越多"。 */
    let mut pids = vec![0u32; 4096];
    let mut needed = 0u32;
    loop {
        let ok = unsafe {
            EnumProcesses(
                pids.as_mut_ptr(),
                (pids.len() * std::mem::size_of::<u32>()) as u32,
                &mut needed,
            )
        };
        if ok.is_err() {
            return false;
        }
        let got = needed as usize / std::mem::size_of::<u32>();
        // 缓冲区够用（EnumProcesses 返回的 needed 小于容量）→ 可以开始扫
        if got < pids.len() || pids.len() >= 1 << 20 {
            break;
        }
        // 不够：扩到两倍再来一次
        pids.resize(pids.len() * 2, 0);
    }
    let n = (needed as usize / std::mem::size_of::<u32>()).min(pids.len());
    for &pid in &pids[..n] {
        if pid == 0 {
            continue;
        }
        if let Some(name) = process_exe(pid) {
            if name.eq_ignore_ascii_case(want) {
                return true;
            }
        }
    }
    false
}

/// `EnumWindows` 的回调：把窗口句柄收进 LPARAM 传进来的 Vec 里。
///
/// ⚠ 返回类型是 `windows::core::BOOL`（不是 `Win32::Foundation::BOOL`）——
///   windows 0.62 里 `WNDENUMPROC` 用的就是 core 那个 BOOL，写错模块会编译不过。
unsafe extern "system" fn enum_collect(hwnd: HWND, lp: LPARAM) -> windows::core::BOOL {
    let out = &mut *(lp.0 as *mut Vec<HWND>);
    out.push(hwnd);
    windows::core::BOOL(1)
}

/// 找出属于 `exe_name` 的**可见顶层窗口**，优先挑没最小化、有标题的那个。
///
/// 为什么要有这一步：快捷键是发给**前台窗口**的。应用在跑但缩在后台，
/// 直接把键发出去只会打到用户刚才那个软件身上。所以先拿到它的窗口、
/// 提到前台，键才真的落到它身上。
///
/// 返回 None 的两种情形都是正常的：
///   · 应用没在跑；
///   · 应用在跑但没有窗口（托盘类工具）—— 这种就只能把键发给当前前台。
pub fn find_app_window(exe_name: &str) -> Option<HWND> {
    let want = exe_name.trim();
    if want.is_empty() {
        return None;
    }
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_collect), LPARAM(&mut all as *mut _ as isize));
    }
    /* r60：以前是"第一个可见 + 有标题 + 没最小化"就返回。
     *
     * 那个顺序是**按 Z 序**来的，而刚启动的应用往往先冒出一个**启动画面 /
     * 登录窗 / 更新提示**（也有标题、也可见），于是我们可能把快捷键发给了
     * 那个一闪而过的窗口 —— 用户看到的就是「应用开了，但快捷键没反应」。
     *
     * 现在改成**挑最像主窗口的那个**：有标题、没最小化、**面积最大**。
     * 主窗口几乎总是那个程序里最大的一块，启动画面/提示框都很小。
     */
    let mut best: Option<(HWND, i64, bool)> = None;   // (窗口, 面积, 是否最小化)
    let mut fallback: Option<HWND> = None;
    for h in all {
        if !unsafe { IsWindowVisible(h).as_bool() } {
            continue;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        if pid == 0 {
            continue;
        }
        let Some(name) = process_exe(pid) else { continue };
        if !name.eq_ignore_ascii_case(want) {
            continue;
        }
        // 有标题的才算"主窗口"：无标题的多是工具窗口/隐藏宿主
        let title = window_title(h);
        if title.trim().is_empty() {
            if fallback.is_none() {
                fallback = Some(h);
            }
            continue;
        }
        let iconic = unsafe { IsIconic(h).as_bool() };
        let (w, hgt) = window_size(h);
        let area = (w.max(0) as i64) * (hgt.max(0) as i64);
        let better = match best {
            None => true,
            // 没最小化的优先于最小化的；同为（或同不为）最小化时比面积
            Some((_, a, ic)) => (!iconic && ic) || (!iconic == !ic && area > a),
        };
        if better {
            best = Some((h, area, iconic));
        }
    }
    best.map(|(h, _, _)| h).or(fallback)
}

/// 窗口的客户区尺寸（宽, 高）。取不到返回 (0, 0)。
fn window_size(h: HWND) -> (i32, i32) {
    let mut r = RECT::default();
    if unsafe { GetWindowRect(h, &mut r) }.is_err() {
        return (0, 0);
    }
    ((r.right - r.left).max(0), (r.bottom - r.top).max(0))
}

/// 拉起一个应用。`admin=true` 走 `runas`（**会弹 UAC**）。
///
/// 为什么不用 `Command::new(path)` 一把梭：
///   · 需要提权时只有 ShellExecuteW 的 `runas` 动词能做到（Command 没法提权）；
///   · 目标可能是 `.lnk` 快捷方式 / 带参数的启动项，Command 直接执行不了。
///
/// 返回 Err 时带上人话，调用方会写进日志（用户看不到弹窗，但排查时能对上）。
pub fn launch_app(path: &str, admin: bool) -> Result<(), String> {
    let p = path.trim().trim_matches('"');
    if p.is_empty() {
        return Err("应用路径是空的".into());
    }
    if !std::path::Path::new(p).exists() {
        return Err(format!("找不到这个应用：{p}"));
    }
    let verb: Vec<u16> = if admin { "runas\0".encode_utf16().collect() } else { Vec::new() };
    let file: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
    let r = unsafe {
        ShellExecuteW(
            None,
            if admin { windows::core::PCWSTR(verb.as_ptr()) } else { windows::core::PCWSTR::null() },
            windows::core::PCWSTR(file.as_ptr()),
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW 的返回值 > 32 才算成功（这个约定很老，但仍然是唯一判据）
    if r.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "启动失败（ShellExecute 返回 {}）{}",
            r.0 as isize,
            if admin { "；可能是 UAC 被拒绝" } else { "" }
        ))
    }
}

/// 等应用"真的起来了"，返回它的窗口（拿不到窗口也算起来，返回 None）。
///
/// 为什么要等：`ShellExecuteW` 返回只代表"请求被接受了"，进程可能还在初始化、
/// 窗口还没建。这时候把快捷键发出去，键会丢在空气里 —— 用户看到的就是
/// 「第一次点没反应，再点一次才行」。
///
/// 判定顺序：先等进程出现，再等窗口出现；窗口等不到也不报错（托盘类应用没有
/// 窗口，但它的全局快捷键照样有效）。
pub fn wait_app_ready(exe_name: &str, timeout_ms: u64) -> Option<HWND> {
    wait_app_ready_ex(exe_name, timeout_ms, true)
}

/// `wait_app_ready` 的可控版本。
///
/// `just_launched` = true 表示"是我们刚刚把它拉起来的"，那种情况下要给它
/// 充分的时间把主窗建出来（IDE / 设计软件可能要好几秒）。
/// false = "它本来就在跑"，那就**不必**为窗口多等 —— 特别是托盘常驻类应用
/// （Octoclip 那种），它永远不会有可见窗口，多等纯属浪费用户时间。
///
/// 两条路的**放弃窗口**阈值不同：
///   · just_launched：给 6 秒（慢启动的桌面软件够用）；
///   · 否则：600ms（够快启动的建窗，托盘类立刻放行去走"直接发全局热键"）。
pub fn wait_app_ready_ex(exe_name: &str, timeout_ms: u64, just_launched: bool) -> Option<HWND> {
    let give_up_ms: u128 = if just_launched { 6000 } else { 600 };
    let t0 = std::time::Instant::now();
    let mut appeared = false;
    while t0.elapsed().as_millis() < timeout_ms as u128 {
        /* ⚠ 轮询间隔 120ms → 300ms。
         *
         * `app_running` 每次都要**枚举全部进程**、每个 pid 再 OpenProcess +
         * QueryFullProcessImageNameW。120ms 一轮 + 最多 20 秒 = 160 多轮全量
         * 枚举，单核会被打满（这是"点了快捷键引擎，机器风扇转起来"的一个来源）。
         * 启动一个应用本来就要一两秒，300ms 的粒度完全够。 */
        let running = app_running(exe_name);
        if running {
            appeared = true;
            if let Some(h) = find_app_window(exe_name) {
                return Some(h);
            }
        }
        /* 进程已经在了、只是没窗口：再多给一点时间等窗口，然后放弃窗口。
         *
         * ⚠ r89b：**托盘常驻类应用不必等这么久**。
         *
         * 实测 Octoclip（章鱼速贴）这类：主窗口是 `Tauri Window` 且**一直隐藏**，
         * 它的快捷键是系统级全局热键（`global_hotkey_app` 窗口注册的），
         * 压根不需要可见窗口。原来这里傻等 2.5 秒 —— 用户点一下要愣 2.5 秒
         * 才见效，观感就是"点了没反应"。
         *
         * 现在：只要**进程已经在跑**（`appeared`），就把等待压到 600ms ——
         * 真正需要窗口的应用（IDE / 设计软件）600ms 也够它把主窗建出来；
         * 而托盘类应用 600ms 后返回 None，调用方会走
         * 「无可见窗口 → 直接发全局热键」那条路，立刻生效。 */
        if appeared && t0.elapsed().as_millis() > give_up_ms {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    None
}

/// 当前前台窗口所属进程的可执行文件名。
pub fn foreground_exe() -> Option<String> {    let hwnd = foreground_window();
    if hwnd.0.is_null() {
        return None;
    }
    process_exe(window_pid(hwnd))
}

/* ------------------------------------------------------------------ */
/* 屏幕抓图（OCR 用）                                                   */
/* ------------------------------------------------------------------ */

/// 整个虚拟桌面（含所有显示器）在物理像素下的矩形。
pub fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// 抓一块屏幕区域，返回 `(宽, 高, RGBA 像素)`。RGBA 而不是 BGRA —— 后面要
/// 直接喂给 image crate 编码 PNG。
pub fn grab_region(x: i32, y: i32, w: i32, h: i32) -> Option<(u32, u32, Vec<u8>)> {
    if w <= 0 || h <= 0 || w > 8000 || h > 8000 {
        return None;
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem = CreateCompatibleDC(Some(screen));
        if mem.is_invalid() {
            ReleaseDC(None, screen);
            return None;
        }
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return None;
        }
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok();
        // 必须先从 DC 里摘出来，否则 GetDIBits 不干活
        SelectObject(mem, old);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 负数 = 自上而下，省得再翻一次行
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                ..Default::default()
            },
            ..Default::default()
        };
        /* ⚠ 不要 `vec![0u8; w*h*4]`：那会先 memset 一遍再让 GetDIBits 覆盖写。
         * OCR 框选常见 2K/4K 屏，白白清零几 MB~几十 MB。用未初始化缓冲 +
         * 长度断言（只有 `lines == h` 全部写满才会走到后面读）。
         *
         * SAFETY：读之前必定已由 GetDIBits 写满 h 行；任何不足都在下面的
         * `lines as i32 != h` 分支里 return None 了。 */
        let mut buf: Vec<u8> = Vec::with_capacity((w as usize) * (h as usize) * 4);
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        );

        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if !ok || lines as i32 != h {
            // lines 是 GetDIBits 实际复制的扫描行数：0 = 直接失败；小于 h =
            // 只抄了一部分 —— 一律当失败，别把半张图当成功传出去。
            return None;
        }
        // 整段已在外层 unsafe 里，这里直接标长度
        buf.set_len((w as usize) * (h as usize) * 4);
        // BitBlt 抓来的是 BGRA，而且 alpha 通道是垃圾值（屏幕没有 alpha）。
        // 统一刷成 255，否则编码出来的 PNG 会整张透明。
        for px in buf.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        Some((w as u32, h as u32, buf))
    }
}

/* ------------------------------------------------------------------ */
/* 从可执行文件 / 快捷方式里取图标（r88）                                 */
/* ------------------------------------------------------------------ */

/// 从一个 exe（或 `.lnk` / `.ico`）里取出图标，返回 (宽, 高, RGBA)。
///
/// # 用途
///
/// 用户要求：「快捷键引擎要增加一个功能，当我选择了某一个应用的时候，
/// 就能够把那个应用的图标作为软件里显示的图标。」
///
/// # 两条来源，各有各的适用面（**实测**结论，不是猜的）
///
///  ① **`PrivateExtractIconsW`** —— 直接读 exe 的图标资源，能点名要
///     **256×256**（资源管理器"大图标"那张）。横条/设置页要显示 28~40px，
///     2x 屏上实际要 80px 源图，所以大图有意义（小图放大发糊）。
///     ⚠ **实测：它对 `.lnk` 无效**（返回 0）—— 快捷方式里没有图标资源，
///       图标在它的**目标**身上。
///
///  ② **`SHGetFileInfoW`** —— 走 shell 的图标解析，**对 `.lnk` 有效**
///     （shell 自己去读快捷方式的目标），但只给 shell 的默认档尺寸
///     （`SHGFI_LARGEICON` = 32×32）。
///
/// 所以顺序是：先试 ①（能拿大图就拿大图），失败再退 ②（至少拿得到）。
/// 用户选应用时大多是选 `.lnk`（开始菜单里就是快捷方式），所以 ② 不是
/// 冷门分支，是主路径之一。
pub fn extract_app_icon(path: &str, want: i32) -> Option<(u32, u32, Vec<u8>)> {
    if let Some(v) = extract_icon_big(path, want) {
        return Some(v);
    }
    extract_icon_via_shell(path)
}

/// ① 直读 exe 图标资源（能拿大图，但对 `.lnk` 无效）。
fn extract_icon_big(path: &str, want: i32) -> Option<(u32, u32, Vec<u8>)> {
    /* ⚠ 这两个 API 都在 `WindowsAndMessaging` 里，**不在** `UI::Shell` ——
     * 名字带 "Extract" 很容易以为在 Shell 模块（我第一次就 import 错了）。 */
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, PrivateExtractIconsW};

    let mut wpath = [0u16; 260];
    {
        let w = wide(path);
        let n = w.len().min(259);
        wpath[..n].copy_from_slice(&w[..n]);
    }
    for size in [want, 48, 32] {
        unsafe {
            /* ⚠ 签名与直觉不同（我第一次写错了）：
             *   · 第 1 个参数是 `&[u16; 260]`，**不是** PCWSTR；
             *   · `phicon` 是 `Option<&mut [HICON]>`（一个**切片**），
             *     一次可以要多个图标，所以这里给一个长度 1 的数组；
             *   · 一共 **7 个**参数（没有单独的"个数"参数 ——
             *     个数是从切片长度推的，所以那个 8 参的写法编译不过）。 */
            let mut icons = [windows::Win32::UI::WindowsAndMessaging::HICON::default(); 1];
            let got = PrivateExtractIconsW(&wpath, 0, size, size, Some(&mut icons), None, 0);
            let hicon = icons[0];
            if got == 0 || hicon.0.is_null() {
                continue;   // 这一档没有，退下一档
            }
            let out = hicon_to_rgba_sized(hicon, size);
            let _ = DestroyIcon(hicon);
            if let Some(v) = out {
                return Some(v);
            }
        }
    }
    None
}

/// ② 走 shell 的图标解析（对 `.lnk` 有效，只给 shell 默认档尺寸）。
fn extract_icon_via_shell(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};

    let mut wpath = [0u16; 260];
    {
        let w = wide(path);
        let n = w.len().min(259);
        wpath[..n].copy_from_slice(&w[..n]);
    }
    unsafe {
        let mut fi = SHFILEINFOW::default();
        let r = SHGetFileInfoW(
            PCWSTR(wpath.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut fi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if r == 0 || fi.hIcon.0.is_null() {
            return None;
        }
        // ⚠ `SHGFI_ICON` 给的 HICON **要自己 DestroyIcon**（shell 不会回收）
        let out = hicon_to_rgba_sized(fi.hIcon, 32);
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyIcon(fi.hIcon);
        out
    }
}

/// 把 `HICON` 转成「(宽, 高, RGBA)」，按 `expect` 尺寸建画布。
///
/// `expect` 是"我以为它会多大"；实际尺寸由 `icon_size` 问出来，
/// 两者取较大的那个当画布（避免把大图标塞进小画布被裁掉）。
fn hicon_to_rgba_sized(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
    expect: i32,
) -> Option<(u32, u32, Vec<u8>)> {
    let actual = icon_size(hicon).unwrap_or(0);
    let size = if actual > 0 { actual.max(1) } else { expect.max(1) };
    hicon_to_rgba_at(hicon, size)
}

/// 把 `HICON` 转成「(宽, 高, RGBA)」，画布边长 `size`。
///
/// 手法：建一块 32 位 DIB，用 `DrawIconEx` 把图标画上去（alpha 直接落在
/// DIB 里），再把像素读出来。**不用 `GetIconInfo` + 位图直接读** —— 那条路
/// 拿到的是"颜色位图 + 掩码位图"两份，还得自己按掩码合成 alpha，而且新版
/// （带 32 位 alpha 的）图标又不用掩码，两条逻辑要并存。`DrawIconEx` 一把
/// 画完，对两代图标都对。
fn hicon_to_rgba_at(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
    size: i32,
) -> Option<(u32, u32, Vec<u8>)> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, DI_NORMAL};

    unsafe {
        /* ⚠ 这里**不能**再 `let size = icon_size(...)` ——
         * `size` 现在是从参数传进来的（调用方已经问过 `icon_size` 并取了
         * 较大值）。我第一版把老的这行留下了，于是参数被同名变量覆盖，
         * 编译能过但语义错了（画布尺寸又变回"图标自己多大就多大"）。 */
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return None;
        }

        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,          // 负数 = 自上而下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,         // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib: HBITMAP = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        {
            Ok(b) => b,
            Err(_) => {
                let _ = DeleteDC(dc);
                return None;
            }
        };
        if bits.is_null() {
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(dc);
            return None;
        }
        let old = SelectObject(dc, HGDIOBJ(dib.0));

        /* 整块先清成 0（全透明 + 全黑）。`DrawIconEx` 只写图标覆盖到的像素，
         * 不清的话没覆盖的地方是内存里的随机值 —— 那会变成"图标周围一圈
         * 彩色噪点"。 */
        let px_count = (size as usize) * (size as usize);
        std::ptr::write_bytes(bits as *mut u8, 0, px_count * 4);

        let drawn = DrawIconEx(dc, 0, 0, hicon, size, size, 0, None, DI_NORMAL).is_ok();

        SelectObject(dc, old);

        /* ⚠⚠ 顺序是**硬性**的：必须**先**把像素拷出来，**再**删 DIB。
         *
         * `bits` 指向的是 DIB 段内部的内存，它**随 `DeleteObject(dib)` 一起失效**。
         * 我第一版就是先删对象、后读 `bits` —— 典型的 **use-after-free**，
         * 直接 `STATUS_ACCESS_VIOLATION`（0xc0000005）把整个测试进程打挂。
         * 这类错误在调试构建里未必每次都崩，但正式构建的优化下必崩。 */
        let mut rgba = vec![0u8; px_count * 4];
        std::ptr::copy_nonoverlapping(bits as *const u8, rgba.as_mut_ptr(), px_count * 4);

        // 拷贝完了，现在才可以放心释放
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(dc);

        if !drawn {
            return None;
        }

        // 还原预乘 alpha（`DrawIconEx` 写进来的是预乘值）
        for p in rgba.as_chunks_mut::<4>().0 {
            // DIB 里是 BGRA
            p.swap(0, 2);
            let a = p[3];
            if a == 0 {
                // 全透明 → 值留着无意义，清成黑避免"透明处有脏色"
                p[0] = 0; p[1] = 0; p[2] = 0;
            } else if a != 255 {
                /* 直通 = 预乘 * 255 / a。不还原的话半透明边缘会偏暗、
                 * 图标像蒙了一层灰。 */
                for c in p.iter_mut().take(3) {
                    let v = (*c as u32 * 255 + a as u32 / 2) / a as u32;
                    *c = v.min(255) as u8;
                }
            }
        }
        Some((size as u32, size as u32, rgba))
    }
}

/// 问 `HICON` 自己的尺寸（`GetIconInfo` 里的位图宽高）。
///
/// 为什么要问：`PrivateExtractIconsW` 可能给一张**比你要求的尺寸更小**的
/// 图标（它没有那一档时就给次小的）。我们按实际尺寸建 DIB，
/// 免得把 48×48 画进 256×256 的画布里（那样周围一大圈全是空的）。
fn icon_size(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<i32> {
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};
    unsafe {
        let mut ii = ICONINFO::default();
        if GetIconInfo(hicon, &mut ii).is_err() {
            return None;
        }
        let mut bm = windows::Win32::Graphics::Gdi::BITMAP::default();
        let w = if !ii.hbmColor.0.is_null() {
            let ok = windows::Win32::Graphics::Gdi::GetObjectW(
                HGDIOBJ(ii.hbmColor.0),
                std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAP>() as i32,
                Some(&mut bm as *mut _ as *mut core::ffi::c_void),
            );
            if ok > 0 && bm.bmWidth > 0 { bm.bmWidth } else { 0 }
        } else {
            0
        };
        // GetIconInfo 给的这两张位图**要自己删**（系统不会替你回收）
        if !ii.hbmColor.0.is_null() {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.0.is_null() {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
        if w > 0 { Some(w) } else { None }
    }
}
