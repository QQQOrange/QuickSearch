//! 托盘图标宿主实现（Win32 `Shell_NotifyIcon`）。
//!
//! Tauri 自带托盘，换掉框架之后这块要自己写。做法是标准的 Windows 套路：
//!
//!   · 建一个**消息窗口**（`HWND_MESSAGE`），它的 WndProc 收托盘回调；
//!   · `Shell_NotifyIconW` 把图标挂到通知区，回调消息指向上面的窗口；
//!   · 右键 → `CreatePopupMenu` + `TrackPopupMenu`，选中的项走 `WM_COMMAND`；
//!   · 图标由 PNG 解码成 HICON（`image` 已有，不额外引 WIC）。
//!
//! 回调闭包存在全局表里：它们是 `Send + Sync` 的，WndProc 里取出来直接调。

use std::sync::Mutex;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HGDIOBJ};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_MODIFY,
    NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyMenu, GetCursorPos, PostMessageW, RegisterClassW, SetForegroundWindow,
    TrackPopupMenu, HICON, ICONINFO, MF_CHECKED, MF_SEPARATOR, MF_STRING, TPM_RIGHTBUTTON,
    WM_APP, WM_COMMAND, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WNDCLASSW,
};

const WM_TRAY: u32 = WM_APP + 1;
const TRAY_UID: u32 = 1;

pub struct TrayDef {
    pub id: String,
    pub tip: String,
    /// (菜单 id, 文案, 是否勾选)。文案为 "-" 表示分隔线。
    pub items: Vec<(String, String, bool)>,
}

type MenuFn = Box<dyn Fn(&str) + Send + Sync>;
type EventFn = Box<dyn Fn(u32) + Send + Sync>;

struct Slot {
    def: TrayDef,
    hicon: isize,
    on_menu: MenuFn,
    /// 参数是鼠标消息（WM_LBUTTONUP / WM_LBUTTONDBLCLK）
    on_event: EventFn,
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);
static MSG_HWND: Mutex<isize> = Mutex::new(0);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// PNG 字节 → HICON。用 32 位带 alpha 的 DIB 直接塞像素，再由 mask 兜底。
fn hicon_from_png(bytes: &[u8]) -> Option<isize> {
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (w, h) = (img.width() as i32, img.height() as i32);
    if w <= 0 || h <= 0 {
        return None;
    }

    use windows::Win32::Graphics::Gdi::{
        CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    unsafe {
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // 负数 = 自上而下
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbm_color = CreateDIBSection(None, &bi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        if bits.is_null() {
            return None;
        }
        // RGBA → BGRA
        let dst = std::slice::from_raw_parts_mut(bits as *mut u8, (w * h * 4) as usize);
        let src = img.as_raw();
        for i in 0..(w * h) as usize {
            dst[i * 4] = src[i * 4 + 2];
            dst[i * 4 + 1] = src[i * 4 + 1];
            dst[i * 4 + 2] = src[i * 4];
            dst[i * 4 + 3] = src[i * 4 + 3];
        }

        // 掩码位图（alpha 通道已足够，这里给全 0 即可）
        let hbm_mask = CreateBitmap(w, h, 1, 1, None);
        let ii = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: hbm_mask,
            hbmColor: hbm_color,
        };
        let hicon = CreateIconIndirect(&ii).ok();
        let _ = DeleteObject(HGDIOBJ(hbm_color.0));
        let _ = DeleteObject(HGDIOBJ(hbm_mask.0));
        hicon.map(|h| h.0 as isize)
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_TRAY {
        match lparam.0 as u32 {
            WM_LBUTTONUP | WM_LBUTTONDBLCLK => {
                if let Ok(g) = SLOT.lock() {
                    if let Some(s) = g.as_ref() {
                        (s.on_event)(lparam.0 as u32);
                    }
                }
            }
            WM_RBUTTONUP => show_menu(hwnd),
            _ => {}
        }
        return LRESULT(0);
    }
    if msg == WM_COMMAND {
        let cmd_id = (wparam.0 & 0xFFFF) as usize;
        let picked = {
            let g = match SLOT.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            g.as_ref().and_then(|s| s.def.items.get(cmd_id.wrapping_sub(1)).map(|it| {
                (it.0.clone(), it.1.clone())
            }))
        };
        if let Some((id, text)) = picked {
            if text != "-" && !id.is_empty() {
                let g = match SLOT.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                if let Some(s) = g.as_ref() {
                    (s.on_menu)(&id);
                }
            }
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn show_menu(hwnd: HWND) {
    let items = {
        let g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_ref() {
            Some(s) => s.def.items.clone(),
            None => return,
        }
    };
    if items.is_empty() {
        return;
    }

    unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        let mut idx: u32 = 1;
        for (_, text, checked) in &items {
            if text == "-" {
                let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
                // 分隔线不占命令位，但为了索引对齐仍占一格
                idx += 1;
                continue;
            }
            let mut flags = MF_STRING;
            if *checked {
                flags |= MF_CHECKED;
            }
            let w = wide(text);
            let _ = AppendMenuW(menu, flags, idx as usize, PCWSTR(w.as_ptr()));
            idx += 1;
        }

        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);

        // TrackPopupMenu 的两个经典前置：置前台 + 补一条空消息，
        // 否则点菜单外面时菜单不会消失。
        let _ = SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            Some(0),
            hwnd,
            None,
        );
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);

        // 没开 TPM_RETURNCMD，选中项会以 WM_COMMAND 回到 wndproc；
        // 这里只需要处理「按 ESC / 点外面取消」的情况。
        let _ = cmd;
    }
}

fn ensure_msg_window() -> Option<HWND> {
    let cached = *MSG_HWND.lock().ok()?;
    if cached != 0 {
        return Some(HWND(cached as *mut core::ffi::c_void));
    }
    unsafe {
        let hinst = GetModuleHandleW(None).ok()?;
        let class_name = wide("QS_TrayHostWnd");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        let _ = RegisterClassW(&wc); // 已注册时返回 0，无害

        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            windows::Win32::UI::WindowsAndMessaging::WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinst.into()),
            None,
        )
        .ok()?;
        *MSG_HWND.lock().ok()? = hwnd.0 as isize;
        Some(hwnd)
    }
}



fn fill_nid(nid: &mut NOTIFYICONDATAW, hwnd: HWND, hicon: isize, tip: &str) {
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = TRAY_UID;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY;
    nid.hIcon = HICON(hicon as *mut core::ffi::c_void);
    let t = wide(tip);
    let n = t.len().min(127);
    nid.szTip[..n].copy_from_slice(&t[..n]);
}

/// 安装（或替换）托盘图标。
pub fn install(def: TrayDef, icon_png: &[u8], on_menu: MenuFn, on_event: EventFn) -> bool {
    let Some(hwnd) = ensure_msg_window() else {
        return false;
    };
    let hicon = hicon_from_png(icon_png).unwrap_or(0);

    let mut nid = NOTIFYICONDATAW::default();
    fill_nid(&mut nid, hwnd, hicon, &def.tip);
    // 初值用不上（紧接着就被赋值），写成延迟初始化，省掉一条 unused_assignments
    let add_ok;
    unsafe {
        add_ok = Shell_NotifyIconW(NIM_ADD, &nid).as_bool();
        // 先 ADD 再 MODIFY 一次，避免同名残留图标不刷新
        let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
    crate::t::trace(&format!(
        "tray: hwnd={:?} hicon={} add_ok={} items={} tip={}",
        hwnd.0,
        hicon,
        add_ok,
        def.items.len(),
        def.tip.chars().take(12).collect::<String>()
    ));

    if let Ok(mut g) = SLOT.lock() {
        *g = Some(Slot {
            def,
            hicon,
            on_menu,
            on_event,
        });
    }
    true
}

/// 右下角通知（托盘气球）。
///
/// 走 `NIF_INFO`：Windows 会把它画在**任务栏右下角（通知区）**，Win10/11 上是
/// 一条系统通知 —— 默认约 5 秒自动消失，鼠标划上去/点 ✕ 也能提前关掉。
///
/// 为什么不用自建窗口：
///   · 这是"提示一下刚才用了什么功能"，不该抢焦点、也不该占鼠标；
///   · 托盘图标本来就在，复用它是系统原生观感，且**不需要**额外的 WebView 进程；
///   · 唯一代价是时长由系统决定（`uTimeout` 只有 XP 时代才认），所以调用方
///     自己做节流（见 main.rs 的 `notify_feature`）。
/// ⚠ **v2.6.8 起不再用于"正在使用什么功能"的提示** —— 那条改成了应用自己画的
/// 右下角小窗（见 `toast.rs` / `ui/toast.html`），因为系统气泡的时长和样式
/// 都由 Windows 说了算，用户要求"内置提示 + 时长可配"。
/// 保留这个函数是为了托盘菜单里的系统级提示还有路可走，别再往业务上用。
#[allow(dead_code)]
pub fn balloon(title: &str, text: &str) {
    let Some(hwnd) = ensure_msg_window() else { return };
    let (hicon, tip) = {
        let g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_ref() {
            Some(s) => (s.hicon, s.def.tip.clone()),
            None => return,
        }
    };
    let mut nid = NOTIFYICONDATAW::default();
    fill_nid(&mut nid, hwnd, hicon, &tip);
    nid.uFlags |= NIF_INFO;
    let t = wide(title);
    let n = t.len().min(63);
    nid.szInfoTitle[..n].copy_from_slice(&t[..n]);
    let b = wide(text);
    let m = b.len().min(255);
    nid.szInfo[..m].copy_from_slice(&b[..m]);
    nid.dwInfoFlags = NIIF_INFO;
    // 老系统认这个（毫秒），Win10+ 由系统的通知时长接管
    nid.Anonymous.uTimeout = 5000;
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
}

pub fn set_icon(png: &[u8]) {
    let Some(hwnd) = ensure_msg_window() else { return };
    let hicon = match hicon_from_png(png) {
        Some(h) => h,
        None => return,
    };
    let tip = {
        let g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_ref() {
            Some(s) => s.def.tip.clone(),
            None => return,
        }
    };
    let mut nid = NOTIFYICONDATAW::default();
    fill_nid(&mut nid, hwnd, hicon, &tip);
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
    let old = {
        let mut g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_mut() {
            Some(s) => {
                let o = s.hicon;
                s.hicon = hicon;
                o
            }
            None => 0,
        }
    };
    if old != 0 {
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyIcon(HICON(
                old as *mut core::ffi::c_void,
            ));
        }
    }
}

pub fn set_tooltip(tip: &str) {
    let Some(hwnd) = ensure_msg_window() else { return };
    let hicon = {
        let g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_ref() {
            Some(s) => {
                let mut g2 = s.def.clone_def();
                g2.tip = tip.to_string();
                s.def.tip.clone()
            }
            None => return,
        }
    };
    let _ = hicon;
    {
        let mut g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if let Some(s) = g.as_mut() {
            s.def.tip = tip.to_string();
        }
    }
    let hicon2 = {
        let g = match SLOT.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_ref() {
            Some(s) => s.hicon,
            None => return,
        }
    };
    let mut nid = NOTIFYICONDATAW::default();
    fill_nid(&mut nid, hwnd, hicon2, tip);
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
}

pub fn set_menu(items: Vec<(String, String, bool)>) {
    let mut g = match SLOT.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    if let Some(s) = g.as_mut() {
        s.def.items = items;
    }
}


impl TrayDef {
    fn clone_def(&self) -> TrayDef {
        TrayDef {
            id: self.id.clone(),
            tip: self.tip.clone(),
            items: self.items.clone(),
        }
    }
}
