//! 液态玻璃的背景抓取层（Rust 侧）。
//!
//! 浏览器安全模型下，WebGL / WebGPU **永远读不到窗口外面的桌面像素** ——
//! 横条是悬浮在别的软件之上的透明窗，它要折射的恰恰是窗外那部分。
//! （CSS `backdrop-filter` 也一样：它取样的是页面内元素背后的内容，
//! 透明悬浮窗里那后面是空的 —— 上一版玻璃之所以像"塑料磨砂"，根因就在这。）
//!
//! 所以背景必须由**操作系统侧**抓：本模块用 BitBlt 从屏幕 DC 抓横条
//! 将要出现的矩形（抓的时候横条还在屏外，绝不把自己抓进去），转成
//! RGBA 字节块交给前端上传成 WebGL2 纹理。
//!
//! 抓屏手法与 OCR 截图（`win::grab_region`）完全一致：
//! 管理员进程抓同会话桌面已被 OCR 在生产环境证明可行。

use std::sync::Mutex;

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    WDA_NONE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// 一次抓屏的结果：矩形（物理像素，屏幕坐标）+ top-down RGBA 字节块。
#[derive(Clone, Debug, Default)]
pub struct Snap {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// w * h * 4 字节，RGBA 顺序，自上而下。alpha 恒 255（屏幕没有透明）。
    pub rgba: Vec<u8>,
}

/// 最近一次抓屏的暂存：`layout_bar` 在横条上屏前抓，前端随后 `glass_take` 取走。
/// 用 `Mutex::new` 的 const 构造（Rust 1.63+ 起稳定），不需要 lazy_static。
static SNAP: Mutex<Option<Snap>> = Mutex::new(None);

/// 最近一次抓屏的**矩形**：和暂存快照分开存。
///
/// 为什么必须分两份：`take()` 是"取走即清空"的（前端每轮 show 只取一次，
/// 防止旧快照被反复用），而 `recapture_last()`（实时模式 10fps 轮询 /
/// 主题切换后的刷新）要按"上一块矩形"重抓。早先矩形只存在快照里，
/// 于是**第一次 take 之后 recapture 就再也抓不到东西** —— 实时玻璃
/// 从此定格在第一帧的背景上，前端每次 refresh 都拿到 16 字节空快照，
/// `upload()` 长度校验不过直接返回 false，连日志都不留一条。
static LAST_RECT: Mutex<(i32, i32, i32, i32)> = Mutex::new((0, 0, 0, 0));

/// 抓一块屏幕矩形，返回 top-down RGBA。失败（DC 建不了 / BitBlt 被拒 /
/// 矩形出屏）返回 `None` —— 调用方记日志即可，玻璃会退化成纯色底板。
pub fn capture_rect(x: i32, y: i32, w: i32, h: i32) -> Option<Snap> {
    if w <= 0 || h <= 0 || w > 8192 || h > 8192 {
        return None;
    }
    // 矩形必须完整落在虚拟屏幕内：BitBlt 的源矩形出屏会直接失败，
    // 而"抓一半、补一半"会让纹理和横条错位，看着比没有玻璃更糟。
    // layout_bar 摆位时已钳过屏，这里只是给前端直调的路径兜底。
    let (vx, vy, vw, vh) = virtual_screen();
    if x < vx || y < vy || x + w > vx + vw || y + h > vy + vh {
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
        // 不带 CAPTUREBLT：普通 BitBlt。横条此刻在屏外，不存在"抓到自己"的问题；
        // 真到了实时刷新那条路，前端会先把舞台整体隐藏再调，一样干净。
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok();
        // 必须先从 DC 里摘出来，否则 GetDIBits 不干活（同 OCR 的 grab_region）
        SelectObject(mem, old);

        if !ok {
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return None;
        }

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 负数 = 自上而下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            ..Default::default()
        };
        let need = (w as usize) * (h as usize) * 4;
        /* ⚠ `vec![0; n]` 会先清零再让 GetDIBits 覆盖写 —— 对一块 8K 屏来说
         * 那是白白 memset 上百 MB（上限 8000² × 4 ≈ 244MB）。用
         * `with_capacity` + `set_len` 拿一块**未初始化**的缓冲：GetDIBits
         * 会把 lines 行的像素全部填满，填不满时下面 `lines != h` 会直接返回
         * None，不会把未初始化的字节交出去。
         *
         * SAFETY：`u8` 没有无效位模式（未初始化读在 Rust 抽象机里仍属 UB，
         * 所以这里必须保证"读之前一定已写"—— 见上面的 lines 校验：
         * 只有 lines == h（= 全部行都写到了）才会走到后面的读取）。 */
        let mut rgba: Vec<u8> = Vec::with_capacity(need);
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(rgba.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if lines != h {
            return None;
        }
        // 走到这里说明 h 行全写满了，长度可以安全地标出来（整段已在外层 unsafe 里）
        rgba.set_len(need);
        // BitBlt 抓来的是 BGRA（alpha 通道是垃圾值）→ 现场换成 RGBA，
        // alpha 拍成 255。一次线性扫描，520×60@2x 也就 12 万像素，微秒级。
        for px in rgba.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        Some(Snap { x, y, w, h, rgba })
    }
}

/// 抓一块矩形并暂存（`layout_bar` 首次上屏前调用）。
///
/// 矩形另外存一份到 `LAST_RECT`：`take()` 会把快照取走，但矩形要一直记得，
/// 否则实时模式的 `recapture_last()` 在第一帧之后就彻底失效。
pub fn capture_store(x: i32, y: i32, w: i32, h: i32) -> Option<Snap> {
    if let Ok(mut r) = LAST_RECT.lock() {
        *r = (x, y, w, h);
    }
    let snap = capture_rect(x, y, w, h);
    if let Ok(mut g) = SNAP.lock() {
        *g = snap.clone();
    }
    snap
}

/// 取走暂存的快照（取走即清空 —— 前端每轮 show 只取一次，防止旧快照被反复用）。
pub fn take() -> Snap {
    SNAP.lock().ok().and_then(|mut g| g.take()).unwrap_or_default()
}

/// 当前记着的矩形（`capture_store` / `store_rect_only` 写的那一块）。
pub fn last_rect() -> (i32, i32, i32, i32) {
    LAST_RECT.lock().map(|r| *r).unwrap_or((0, 0, 0, 0))
}

/// 只更新「上一块矩形」，**不抓屏**。
///
/// 用途（需求 6：面板也得是玻璃）：面板开合会让窗口变大/变小，玻璃纹理得覆盖
/// 新矩形 —— 但那一刻窗口正在屏上可见，直抓会把横条/面板自己拍进纹理（自拍）。
/// 所以 Rust 这边只把矩形换掉，真正的抓屏交给前端 `QSGlass.refresh()`：它会把
/// 舞台先隐藏、等两帧，再调 `glass_capture`（`recapture_last` 用的就是这块矩形），
/// 抓到的仍是干净桌面。
pub fn store_rect_only(x: i32, y: i32, w: i32, h: i32) {
    if w <= 0 || h <= 0 {
        return;
    }
    if let Ok(mut r) = LAST_RECT.lock() {
        *r = (x, y, w, h);
    }
}

/// 按**上次那块矩形**重抓一次（实时模式轮询 / 拖动结束后的刷新用）。
///
/// 为什么不让前端传矩形：前端在 WebView 里根本不知道窗口的屏幕坐标
/// （`getBoundingClientRect` 是客户区坐标，`screenX/Y` 在 WebView2 里
/// 恒为 0）。而"要刷新的区域"永远是上一块 —— 横条搬家之后 Rust 侧的
/// `capture_store` 会用新矩形覆盖，这里自然就跟着换了。
///
/// ⚠ 矩形来自 `LAST_RECT` 而不是暂存快照：快照会被 `take()` 取走，
/// 拿它当依据会让实时模式在第一帧之后就永远拿到空快照（见 `LAST_RECT` 注释）。
pub fn recapture_last() -> Snap {
    let (x, y, w, h) = LAST_RECT.lock().map(|r| *r).unwrap_or((0, 0, 0, 0));
    if w <= 0 || h <= 0 {
        return Snap::default();
    }
    capture_store(x, y, w, h).unwrap_or_default()
}

/// 把快照打成「16 字节小头（x,y,w,h，i32 LE）+ RGBA 字节块」，供 IPC 直传。
/// 走 `tauri::ipc::Response` 原始字节，不过 JSON / base64 ——
/// 一块 500KB 的纹理 base64 化要涨三分之一，还多一轮编解码。
pub fn encode(snap: &Snap) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + snap.rgba.len());
    out.extend_from_slice(&snap.x.to_le_bytes());
    out.extend_from_slice(&snap.y.to_le_bytes());
    out.extend_from_slice(&snap.w.to_le_bytes());
    out.extend_from_slice(&snap.h.to_le_bytes());
    out.extend_from_slice(&snap.rgba);
    out
}

/// 虚拟屏幕边界（多显示器 / 负坐标桌面）。抓屏矩形先和它求交，
/// 免得 BitBlt 源矩形出屏直接失败。
pub fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        (x, y, w, h)
    }
}

/// 横条是否已对抓屏隐身（`WDA_EXCLUDEFROMCAPTURE`）。只记最近一次成功状态，
/// 供 dismiss / 关闭玻璃时兜底解除 —— 前端漏调也不能让横条在用户截图里消失。
static EXCLUDED: Mutex<bool> = Mutex::new(false);

/// 让横条对**抓屏**隐身（`WDA_EXCLUDEFROMCAPTURE`，Win10 2004 / build 19041+）。
///
/// 为什么实时折射需要它：BitBlt 抓的是**合成后的屏幕**，横条活着就一定会把
/// 自己抓进纹理（反馈环）。老办法是抓之前把舞台 `visibility:hidden`、等两帧
/// 再抓 —— 于是横条每轮刷新都有几十毫秒不存在于屏幕上，10fps 轮询下肉眼就是
/// 频闪；而且 `setInterval` 不等上一轮抓完就再发一轮，隐藏时间还会叠加。
///
/// 设了 display affinity 之后，DWM 在所有抓屏路径（BitBlt / PrintWindow /
/// DXGI 复制 / 各大截图录屏软件）里都直接看穿这个窗口，而**物理屏幕上横条
/// 照常显示**。BitBlt 于是天然拿到没有横条的干净桌面 —— 不需要隐藏、没有
/// 一帧不可见、零闪烁。这也是截图工具隐藏自己的同一套机制。
///
/// 返回 `false` = 本机不支持（旧系统 SetWindowDisplayAffinity 直接失败）或
/// 调用出错，调用方（前端）应回退到「隐藏-抓取」老路。
/// `on=false` 时解除，必须成对调用：用户截图/录屏时横条不应该消失。
pub fn set_exclude_from_capture(hwnd: HWND, on: bool) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    unsafe {
        let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        if SetWindowDisplayAffinity(hwnd, affinity).is_err() {
            // 旧系统（< 19041）对 WDA_EXCLUDEFROMCAPTURE 直接报错 —— 不是产品问题
            if on {
                crate::win::log("glass: WDA_EXCLUDEFROMCAPTURE 不可用（系统 < 19041？），回退隐藏抓取");
            }
            if let Ok(mut e) = EXCLUDED.lock() {
                *e = false;
            }
            return false;
        }
        // 读回确认：某些远程会话 / 安全桌面环境会静默不接受该标志
        let mut actual: u32 = 0;
        let verified = GetWindowDisplayAffinity(hwnd, &mut actual).is_ok()
            && actual == affinity.0;
        if let Ok(mut e) = EXCLUDED.lock() {
            *e = on && verified;
        }
        on && verified
    }
}

/// 兜底解除抓屏隐身（`dismiss_bar` / 退出玻璃模式时调）。
/// 前端漏调 `glass_exclude(false)` 也不会让横条在用户截图里消失。
pub fn clear_exclude_from_capture(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    let was = EXCLUDED.lock().map(|e| *e).unwrap_or(false);
    if !was {
        return; // 本来就没设，省一次系统调用
    }
    unsafe {
        if SetWindowDisplayAffinity(hwnd, WDA_NONE).is_err() {
            crate::win::log("glass: 解除 WDA_EXCLUDEFROMCAPTURE 失败（窗口可能已销毁）");
        }
    }
    if let Ok(mut e) = EXCLUDED.lock() {
        *e = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 保护 `LAST_RECT` / `SNAP`（进程级全局，整个二进制只有一份）的测试锁。
    ///
    /// cargo test 默认**多线程并行**跑，而下面两个抓屏测试都写这两个全局：
    /// 兄弟测试的 `capture_store(vx, vy, …)` 插在本测试两次 store 之间，就会把
    /// 矩形改回旧值 —— `recapture_follows_new_rect` 断言 x/y，于是随机挂
    /// （单跑必过、全量跑约一半概率挂，踩过）。动这两个全局的测试先拿锁。
    static GLASS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 抓得到屏的环境才断言（无桌面会话里 BitBlt 会失败，那不是产品的错）。
    fn can_capture(x: i32, y: i32, w: i32, h: i32) -> bool {
        capture_rect(x, y, w, h).is_some()
    }

    /// 回归：`take()` 取走快照之后，`recapture_last()` 必须还能按上次的矩形
    /// 重抓 —— 实时玻璃（`bar_glass_live`）整条链路都压在这一点上。
    /// 曾经的 bug：矩形只存在快照里，take 一取走，recapture 永远返回空。
    #[test]
    fn recapture_last_survives_take() {
        let _guard = GLASS_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (vx, vy, vw, vh) = virtual_screen();
        if vw < 16 || vh < 16 || !can_capture(vx, vy, 8, 8) {
            eprintln!("环境抓不了屏，跳过");
            return;
        }
        let _ = capture_store(vx, vy, 8, 8);
        assert!(take().w > 0, "capture_store 之后应当取得到快照");
        assert_eq!(take().w, 0, "take 是取走即清空");
        let s = recapture_last();
        assert_eq!((s.w, s.h), (8, 8), "take 之后矩形仍记得，重抓同一块");
        assert_eq!(s.rgba.len(), 8 * 8 * 4, "重抓的字节数对得上");
    }

    /// 换一块矩形再抓，LAST_RECT 要跟着换（横条搬家后刷新的就是新区域）。
    #[test]
    fn recapture_follows_new_rect() {
        let _guard = GLASS_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (vx, vy, vw, vh) = virtual_screen();
        if vw < 32 || vh < 16 || !can_capture(vx, vy, 8, 8) {
            eprintln!("环境抓不了屏，跳过");
            return;
        }
        let _ = capture_store(vx, vy, 8, 8);
        let _ = take();
        let _ = capture_store(vx + 16, vy, 8, 8);
        let s = recapture_last();
        assert_eq!((s.x, s.y, s.w, s.h), (vx + 16, vy, 8, 8));
    }
}
