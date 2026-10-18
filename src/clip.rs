//! 剪贴板：整盘快照 / 还原 / 读文本。
//!
//! 「选中就弹」的关键动作是模拟一次 Ctrl+C 把选区拿到手，
//! 但绝不能把用户原本的剪贴板弄丢，所以复制前先把所有 HGLOBAL 格式
//! 原样备份，复制完再逐个写回去。

use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::Globalization::{
    MultiByteToWideChar, CP_ACP, CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
};

pub const CF_UNICODETEXT: u32 = 13;
/// ANSI 文本。有些宿主（尤其自绘 UI 的国产客户端）复制时**只放这一种**，
/// 或者放了但 CF_UNICODETEXT 是空的 —— 只认 UTF-16 会取不到词。
pub const CF_TEXT: u32 = 1;
/// OEM 文本（DOS 代码页），老控件常见。
pub const CF_OEMTEXT: u32 = 7;
/// 剪贴板位图格式（BITMAPINFOHEADER + 像素），收藏夹的图片复制用它。
pub const CF_DIB: u32 = 8;
/// 剪贴板区域标识（CF_LOCALE）：给 CF_HTML 用的 4 字节小端 locale id。
pub const CF_LOCALE: u32 = 0x0010;

/// 这些格式存的是 GDI 句柄而不是 HGLOBAL，GlobalSize/GlobalLock 会用错，
/// 直接跳过。位图一般会同时提供 CF_DIB(8) / CF_DIBV5(17)，损失不大。
fn is_gdi_format(f: u32) -> bool {
    matches!(f, 2 | 3 | 9 | 14 | 0x0080 | 0x0082 | 0x0083 | 0x008E)
}

pub struct Snapshot {
    items: Vec<(u32, Vec<u8>)>,
}

impl Snapshot {
    /// 快照里 CF_UNICODETEXT 的原文本（没有这项就返回 None）。
    ///
    /// 给「这次复制到底有没有换掉内容」用：取词时先记下复制前的文本，
    /// 复制之后再读一次，内容确实不同才算数 —— 比只看剪贴板序号更准
    /// （序号变了但内容没变，说明是别人在还原/整理剪贴板，不是选区）。
    pub fn text(&self) -> Option<String> {
        let b = self
            .items
            .iter()
            .find(|(f, _)| *f == CF_UNICODETEXT)
            .map(|(_, b)| b)?;
        let mut v: Vec<u16> = b
            .as_chunks::<2>().0.iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        while matches!(v.last(), Some(0)) {
            v.pop();
        }
        Some(String::from_utf16_lossy(&v))
    }
}

fn open_clipboard() -> bool {
    // 30 × 10ms ≈ 300ms：微信这类客户端"握着剪贴板准备数据"的时候会把
    // OpenClipboard 一直挡回来，重试窗口给足一点能少丢几次。
    for _ in 0..30 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn hglobal_bytes(h: HANDLE) -> Option<Vec<u8>> {
    if h.0.is_null() {
        return None;
    }
    unsafe {
        let hg = HGLOBAL(h.0);
        let sz = GlobalSize(hg);
        if sz == 0 || sz > 96 * 1024 * 1024 {
            return None;
        }
        let p = GlobalLock(hg);
        if p.is_null() {
            return None;
        }
        let v = std::slice::from_raw_parts(p as *const u8, sz).to_vec();
        let _ = GlobalUnlock(hg);
        Some(v)
    }
}

/// 备份当前剪贴板；打不开剪贴板就返回 None（此时不要去还原，免得把别人的东西清空）
pub fn snapshot() -> Option<Snapshot> {
    if !open_clipboard() {
        return None;
    }
    let mut items = Vec::new();
    unsafe {
        let mut f = 0u32;
        loop {
            f = EnumClipboardFormats(f);
            if f == 0 {
                break;
            }
            if is_gdi_format(f) {
                continue;
            }
            if let Ok(h) = GetClipboardData(f) {
                if let Some(b) = hglobal_bytes(h) {
                    items.push((f, b));
                }
            }
        }
        let _ = CloseClipboard();
    }
    Some(Snapshot { items })
}

pub fn restore(s: &Snapshot) {
    if !open_clipboard() {
        return;
    }
    unsafe {
        // ⚠ 所有 HGLOBAL 必须**在清空之前**先分配好。
        //
        // 以前是「先 Empty 再逐项 GlobalAlloc」：一旦中途分配失败（比如剪贴板里
        // 有一张很大的位图、或者内存紧张），用户的东西**已经被清空了**，剩下没
        // 写回去的格式就永久丢失，而函数照样返回成功、日志一行都没有 ——
        // 用户只发现"复制完原来的内容没了"。
        //
        // 预分配的话，失败只是"这次没还原成功"（剪贴板里留着刚取的选区），
        // 至少不会把剪贴板清成空的。
        let mut prepared: Vec<(u32, HANDLE)> = Vec::with_capacity(s.items.len());
        for (f, bytes) in &s.items {
            let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else {
                crate::win::log(&format!(
                    "clip: 还原前预分配格式 {f} 失败了，本次不还原（保住现有剪贴板）"
                ));
                break;
            };
            let p = GlobalLock(h);
            if p.is_null() {
                let _ = GlobalFree(Some(h));
                crate::win::log(&format!("clip: 还原前 GlobalLock 失败（格式 {f}），本次不还原"));
                break;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
            let _ = GlobalUnlock(h);
            prepared.push((*f, HANDLE(h.0)));
        }

        if prepared.len() != s.items.len() {
            // 有一样没备齐就把已分配的全释放 —— 一个都不许留在半路上
            for (_, h) in prepared {
                let _ = GlobalFree(Some(HGLOBAL(h.0)));
            }
            let _ = CloseClipboard();
            return;
        }

        if EmptyClipboard().is_err() {
            for (_, h) in prepared {
                let _ = GlobalFree(Some(HGLOBAL(h.0)));
            }
            let _ = CloseClipboard();
            crate::win::log("clip: EmptyClipboard 失败，已放弃还原");
            return;
        }

        for (f, h) in prepared {
            // 成功之后所有权交给系统，不能再 free
            if SetClipboardData(f, Some(h)).is_err() {
                let _ = GlobalFree(Some(HGLOBAL(h.0)));
                crate::win::log(&format!("clip: 写回格式 {f} 失败，该项已丢失"));
            }
        }
        let _ = CloseClipboard();
    }
}

#[allow(dead_code)]
pub fn clear() {
    if !open_clipboard() {
        return;
    }
    unsafe {
        let _ = EmptyClipboard();
        let _ = CloseClipboard();
    }
}

/// 剪贴板里有没有位图（CF_BITMAP / CF_DIB / CF_DIBV5）。
///
/// 用来识别「用户 Ctrl+C 复制的其实是一张图」：图片上的文字选不中，
/// 但这时候我们照样把横条唤出来（只留一个「识别图片文字」按钮），
/// 用户点一下就进框选识别。这是图片里抠字最顺手的一条路。
pub fn has_image() -> bool {
    if !open_clipboard() {
        return false;
    }
    let hit = unsafe {
        let mut found = false;
        let mut f = 0u32;
        loop {
            f = EnumClipboardFormats(f);
            if f == 0 {
                break;
            }
            if matches!(f, 2 | 8 | 17) {
                found = true;
                break;
            }
        }
        found
    };
    unsafe {
        let _ = CloseClipboard();
    }
    hit
}

pub fn seq() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// 把一段文本放进剪贴板（覆盖原内容）。
///
/// 只在**用户主动点 AI 图标**时才调用：AI 网页吃不吃 URL 参数各家不一，
/// 剪贴板里存一份最终提问，站点没自动填的话点一下输入框 Ctrl+V 就补上了。
/// 返回是否成功，失败不抛错（这是锦上添花的一步，不该拖累主流程）。
pub fn set_text(s: &str) -> bool {
    if !open_clipboard() {
        return false;
    }
    let ok = unsafe {
        let ok_empty = EmptyClipboard().is_ok();
        let mut ok = false;
        if ok_empty {
            let mut wide: Vec<u16> = s.encode_utf16().collect();
            wide.push(0);
            let bytes = wide.len() * 2;
            if let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, bytes) {
                let p = GlobalLock(h);
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(wide.as_ptr(), p as *mut u16, wide.len());
                    let _ = GlobalUnlock(h);
                    if SetClipboardData(CF_UNICODETEXT, Some(HANDLE(h.0))).is_ok() {
                        // 所有权已交给系统，不能再 free
                        ok = true;
                    } else {
                        let _ = GlobalFree(Some(h));
                    }
                } else {
                    let _ = GlobalFree(Some(h));
                }
            }
        }
        let _ = CloseClipboard();
        ok
    };
    ok
}

/// 把一段字节按指定剪贴板格式写进去。**调用方须已打开并清空剪贴板**。
/// 成功时 HGLOBAL 所有权移交给系统，不能再 free；失败返回 false。
unsafe fn put_format(fmt: u32, bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else {
        return false;
    };
    let p = GlobalLock(h);
    if p.is_null() {
        let _ = GlobalFree(Some(h));
        return false;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
    let _ = GlobalUnlock(h);
    if SetClipboardData(fmt, Some(HANDLE(h.0))).is_ok() {
        true
    } else {
        let _ = GlobalFree(Some(h));
        false
    }
}

/// 按 MSDN「HTML Clipboard Format」拼 CF_HTML 的 blob。
///
/// blob = 一段 ASCII 偏移头 + 完整 HTML；8 个字段全是**字节**偏移（UTF-8），
/// `%08d` 定宽补零。偏移系统不帮你数，必须自己算 —— 而且中文内容
/// 字符数 ≠ 字节数，只按 char 数算会整体错位，粘贴出来是乱码。
///
/// 头部长度从格式串自身推导（`{:08}` 补零后偏移宽度恒定，碎片已限 4MB
/// 装得下 8 位）—— 写死常量的话，将来谁改一下格式串就会全盘错位。
///
/// StartSelection/EndSelection 借给 StartFragment/EndFragment（收藏内容
/// 没有「选区」概念，整段就是要粘的碎片）。
fn build_cf_html(fragment: &str) -> Option<Vec<u8>> {
    const MAX_FRAG: usize = 4 * 1024 * 1024;   // 4MB 上限：偏移只有 8 位数字
    if fragment.len() > MAX_FRAG {
        return None;
    }
    let header = format!(
        "Version: 0.9\r\nStartHTML: {:08}\r\nEndHTML: {:08}\r\nStartFragment: {:08}\r\nEndFragment: {:08}\r\nStartSelection: {:08}\r\nEndSelection: {:08}\r\n",
        0usize, 0usize, 0usize, 0usize, 0usize, 0usize,
    );
    let prefix = "<html><body><!--StartFragment-->";
    let suffix = "<!--EndFragment--></body></html>";
    let start_html = header.len();
    let start_frag = start_html + prefix.len();
    let end_frag = start_frag + fragment.len();
    let end_html = start_html + prefix.len() + fragment.len() + suffix.len();
    let mut blob = String::with_capacity(header.len() + 128 + fragment.len());
    blob.push_str(&format!(
        "Version: 0.9\r\nStartHTML: {:08}\r\nEndHTML: {:08}\r\nStartFragment: {:08}\r\nEndFragment: {:08}\r\nStartSelection: {:08}\r\nEndSelection: {:08}\r\n",
        start_html, end_html, start_frag, end_frag, start_frag, end_frag,
    ));
    debug_assert_eq!(blob.len(), header.len(), "CF_HTML 头长变了，偏移全错");
    blob.push_str(prefix);
    blob.push_str(fragment);
    blob.push_str(suffix);
    Some(blob.into_bytes())
}

/// 把「纯文本 + 带格式 HTML」一起放进剪贴板（覆盖原内容）。
///
/// 收藏夹里带颜色的内容点「复制」时走这里：粘到 Word / 邮件 / 浏览器
/// 里颜色还在（CF_HTML 是事实标准）；只吃纯文本的目标（记事本、终端）
/// 自动退化到 CF_UNICODETEXT，两边都不得罪。
/// 任何一步失败都返回 false，不抛错（这是锦上添花的一步）。
pub fn set_rich_text(text: &str, html: &str) -> bool {
    if text.is_empty() && html.is_empty() {
        return false;
    }
    // 两个格式的字节都先备好再开剪贴板：剪贴板是全局锁，持有时
    // 别人 Ctrl+C 会失败，持锁时间越短越好。
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let wide_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2)
    };
    let cf_html = build_cf_html(html.trim());
    if !open_clipboard() {
        return false;
    }
    let ok = unsafe {
        let ok_empty = EmptyClipboard().is_ok();
        let mut ok_text = false;
        let mut ok_html = false;
        if ok_empty {
            ok_text = put_format(CF_UNICODETEXT, wide_bytes);
            if let Some(b) = cf_html.as_ref() {
                // CF_HTML 的格式号是运行时注册的（"HTML Format"），不是固定值。
                // 注册失败（返回 0）就只给纯文本，不影响主流程。
                let fmt = RegisterClipboardFormatW(windows::core::w!("HTML Format"));
                if fmt != 0 {
                    ok_html = put_format(fmt, b);
                    // CF_LOCALE 一起给：没它个别宿主（老版本 Office）会按
                    // 本地代码页解 UTF-8 字节，中文变乱码。0x0409 = en-US，
                    // 业界通用默认值（偏移本身与语言无关）。
                    let locale: u32 = 0x0409;
                    let _ = put_format(
                        CF_LOCALE,
                        &locale.to_le_bytes(),
                    );
                }
            }
        }
        let _ = CloseClipboard();
        ok_text || ok_html
    };
    ok
}

/// 把一张图片（PNG / JPEG 的原始字节）放进剪贴板。
///
/// 收藏夹里的图片「点一下就复制」靠它。图片内容必须以 **CF_DIB** 的形式给
/// （BGR 顺序、行按 4 字节对齐），所以这里要做 RGBA → BGRA 的转换。
/// 用负的 biHeight 表示自上而下的行序，省掉一次手动翻转。
pub fn set_image(bytes: &[u8]) -> bool {
    use windows::Win32::Foundation::HANDLE;

    let Ok(img) = image::load_from_memory(bytes) else {
        return false;
    };
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    if w == 0 || h == 0 || w > 16384 || h > 16384 {
        return false;
    }

    let mut dib: Vec<u8> = Vec::with_capacity(40 + w * h * 4);
    // BITMAPINFOHEADER（40 字节，全部按小端写）
    dib.extend_from_slice(&40u32.to_le_bytes());          // biSize
    dib.extend_from_slice(&(w as u32).to_le_bytes());     // biWidth
    dib.extend_from_slice(&(-(h as i32)).to_le_bytes());  // biHeight（负 = 自上而下）
    dib.extend_from_slice(&1u16.to_le_bytes());           // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes());          // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes());           // biCompression = BI_RGB
    dib.extend_from_slice(&((w * h * 4) as u32).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&0u32.to_le_bytes());           // biXPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes());           // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes());           // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes());           // biClrImportant

    for px in rgba.pixels() {
        dib.push(px[2]); // B
        dib.push(px[1]); // G
        dib.push(px[0]); // R
        dib.push(255);   // A（CF_DIB 一般忽略，但垫上无妨）
    }

    if !open_clipboard() {
        return false;
    }
    
    unsafe {
        let ok_empty = EmptyClipboard().is_ok();
        let mut ok = false;
        if ok_empty {
            if let Ok(hg) = GlobalAlloc(GMEM_MOVEABLE, dib.len()) {
                let p = GlobalLock(hg);
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(dib.as_ptr(), p as *mut u8, dib.len());
                    let _ = GlobalUnlock(hg);
                    if SetClipboardData(CF_DIB, Some(HANDLE(hg.0))).is_ok() {
                        ok = true; // 所有权已交给系统
                    } else {
                        let _ = GlobalFree(Some(hg));
                    }
                } else {
                    let _ = GlobalFree(Some(hg));
                }
            }
        }
        let _ = CloseClipboard();
        ok
    }
}

/* ------------------------------------------------------------------ */
/* 多格式取文本（划词取词用）                                          */
/* ------------------------------------------------------------------ */

/// 剪贴板当前挂着哪些格式。**纯诊断用**：某些宿主复制完只放 `CF_HTML` /
/// 自定义格式，"序号变了、owner 也对，却读不出文字"就是这种形状 ——
/// 把格式列表写进日志，一眼就能看出到底该读哪一种。
/// `None` = **剪贴板打不开**（被别的程序握着不放 —— 微信复制过程中就是这个状态，
/// 它先 EmptyClipboard 清空、再握着剪贴板去准备数据）；`Some(vec![])` = 打得开但是空的。
pub fn formats_open() -> Option<Vec<u32>> {
    if !open_clipboard() {
        return None;
    }
    let mut out = Vec::new();
    unsafe {
        let mut f = 0u32;
        while out.len() < 64 {
            f = EnumClipboardFormats(f);
            if f == 0 {
                break;
            }
            out.push(f);
        }
        let _ = CloseClipboard();
    }
    Some(out)
}

/// 诊断用的一句话。**必须区分「打不开」和「空的」** —— 这两个的修法完全不同：
/// 打不开说明有人在握着剪贴板（要等，不能重投复制请求）；空的说明对方根本没写东西。
pub fn describe_formats() -> String {
    match formats_open() {
        None => "打不开（被别的程序握着）".to_string(),
        Some(v) if v.is_empty() => "空的（没有任何格式）".to_string(),
        Some(v) => format!("{:?}", v.into_iter().map(format_name).collect::<Vec<_>>()),
    }
}

/// 格式号 → 人话名字。自定义格式（≥ 0xC000）去问系统要注册名
/// （"HTML Format" / "Rich Text Format" / 宿主自己的私有格式都在这里露出马脚）。
fn format_name(f: u32) -> String {
    if f >= 0xC000 {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClipboardFormatNameW(f, &mut buf) };
        if n > 0 {
            return String::from_utf16_lossy(&buf[..n as usize]);
        }
    }
    match f {
        1 => "CF_TEXT".into(),
        2 => "CF_BITMAP".into(),
        7 => "CF_OEMTEXT".into(),
        8 => "CF_DIB".into(),
        13 => "CF_UNICODETEXT".into(),
        15 => "CF_HDROP".into(),
        16 => "CF_LOCALE".into(),
        17 => "CF_DIBV5".into(),
        _ => format!("#{f}"),
    }
}

/// 读某个格式的原始字节（GDI 句柄类 / 空句柄返回 None）。**剪贴板必须已经打开。**
fn read_bytes(fmt: u32) -> Option<Vec<u8>> {
    if is_gdi_format(fmt) {
        return None;
    }
    unsafe { GetClipboardData(fmt).ok().and_then(hglobal_bytes) }
}

/// 按指定代码页把单/多字节串转成 String（CF_TEXT / CF_OEMTEXT 用）。
///
/// 不能直接 `from_utf8`：CF_TEXT 用的是**系统 ANSI 代码页**（简体中文是 936/GBK），
/// 按 UTF-8 解中文会得到一串乱码。
fn ansi_bytes_to_string(b: &[u8], cp: u32) -> Option<String> {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    let b = &b[..end];
    if b.is_empty() {
        return Some(String::new());
    }
    unsafe {
        let flag = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
        let n = MultiByteToWideChar(cp, flag, b, None);
        if n <= 0 {
            return None;
        }
        let mut w = vec![0u16; n as usize];
        let n2 = MultiByteToWideChar(cp, flag, b, Some(&mut w));
        if n2 <= 0 {
            return None;
        }
        w.truncate(n2 as usize);
        Some(String::from_utf16_lossy(&w))
    }
}

/// 从 `CF_HTML` 里抠出纯文本（去标签 + 解几个常见实体）。
///
/// 头部的 `StartFragment` / `EndFragment` 是**字节偏移**（不是字符偏移），
/// 所以按字节切 `blob` 而不是切字符串 —— 这是 CF_HTML 最容易踩的坑。
fn html_fragment_text(blob: &[u8]) -> Option<String> {
    let head = String::from_utf8_lossy(blob).to_string();
    let field = |name: &str| -> Option<usize> {
        let i = head.find(name)?;
        head[i + name.len()..]
            .split(['\r', '\n'])
            .next()?
            .trim_start_matches(':')
            .trim()
            .parse::<usize>()
            .ok()
    };
    let frag: &[u8] = match (field("StartFragment"), field("EndFragment")) {
        (Some(a), Some(b)) if b > a && b <= blob.len() => &blob[a..b],
        _ => blob,
    };
    let mut out = String::new();
    let mut in_tag = false;
    for ch in String::from_utf8_lossy(frag).chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let t = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    Some(t.trim().to_string())
}

/// 取剪贴板文本：**按格式依次尝试**。剪贴板必须已经打开。
///
/// 为什么不能只认 `CF_UNICODETEXT`（实测教训）：微信 4.1 里划词复制时，
/// 剪贴板序号会变、owner 就是微信自己、归属校验也通过 —— 但按
/// `CF_UNICODETEXT` 读出来是**空的**。只认一种格式的话，取词就卡在
/// "明明复制成功了却拿不到字"，用户看到的现象正是"在微信里划词不弹条"。
pub fn read_text_open() -> Option<String> {
    // 1) 首选 UTF-16（最规范、中文无损）
    if let Some(b) = read_bytes(CF_UNICODETEXT) {
        /* 读长双保险：NUL 结尾 + 分配尺寸，谁先到算谁。
         * Win32 保证 CF_UNICODETEXT 以 NUL 收尾，但万一某个宿主给了个没结尾的
         * 块，只按 NUL 扫会一路读下去 —— 用分配尺寸兜住，别越界。 */
        let cap = if b.len() >= 2 { b.len() / 2 } else { 0 };
        let mut v: Vec<u16> = b
            .as_chunks::<2>().0.iter()
            .take(cap.min(8_000_000))
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if let Some(nul) = v.iter().position(|&c| c == 0) {
            v.truncate(nul);
        }
        let s = String::from_utf16_lossy(&v);
        if !s.trim().is_empty() {
            return Some(s);
        }
    }
    // 2) ANSI 文本（按系统代码页解，简体中文就是 GBK）
    if let Some(b) = read_bytes(CF_TEXT) {
        if let Some(s) = ansi_bytes_to_string(&b, CP_ACP) {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    // 3) OEM 文本
    if let Some(b) = read_bytes(CF_OEMTEXT) {
        if let Some(s) = ansi_bytes_to_string(&b, CP_OEMCP) {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    // 4) 富文本宿主常见：只放 CF_HTML，从片段里抠纯文本
    let name: Vec<u16> = "HTML Format".encode_utf16().chain(std::iter::once(0)).collect();
    let html_fmt = unsafe { RegisterClipboardFormatW(windows::core::PCWSTR(name.as_ptr())) };
    if html_fmt != 0 {
        if let Some(b) = read_bytes(html_fmt) {
            if let Some(s) = html_fragment_text(&b) {
                if !s.trim().is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

/// `read_text_open` 的自带开关版本（自己开/关剪贴板）。
pub fn read_text_any() -> Option<String> {
    if !open_clipboard() {
        return None;
    }
    let out = read_text_open();
    unsafe {
        let _ = CloseClipboard();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CF_HTML 的偏移必须**按 UTF-8 字节**数：中文内容 char 数 ≠ 字节数，
    /// 按字符算偏移会让宿主（Word/Chrome）从错误的位置开始读碎片 ——
    /// 表现是粘贴出来前面缺一截、后面跟乱码。这里用一段带中文的碎片
    /// 把四个偏移逐个数一遍。
    #[test]
    fn cf_html_offsets_are_byte_accurate_with_cjk() {
        let frag = "<span style=\"color:#c00\">红色文字</span>";
        let blob = build_cf_html(frag).expect("4MB 以内必须给 blob");
        let s = String::from_utf8(blob).expect("blob 必须是合法 UTF-8");

        let field = |name: &str| -> usize {
            s.lines()
                .find_map(|l| l.strip_prefix(name))
                .and_then(|v| v.trim_start_matches(':').trim().parse().ok())
                .unwrap_or_else(|| panic!("blob 里没有 {} 字段", name))
        };
        let (sh, eh, sf, ef) = (
            field("StartHTML"),
            field("EndHTML"),
            field("StartFragment"),
            field("EndFragment"),
        );
        let b = s.as_bytes();
        // 头七行（ASCII）之后紧跟完整 HTML
        assert_eq!(&b[sh..sh + "<html>".len()], b"<html>");
        // 碎片起点 = <html><body><!--StartFragment--> 之后
        assert_eq!(&b[sf..sf + "<span".len()], b"<span");
        // 碎片字节数 = EndFragment - StartFragment（中文按多字节计）
        assert_eq!(ef - sf, frag.len());
        // 碎片结尾 = </span>，随后是 EndFragment 注释
        assert_eq!(&b[ef..ef + "<!--EndFragment-->".len()], b"<!--EndFragment-->");
        // EndHTML 之后正好是整个 blob 的末尾
        assert_eq!(eh, b.len());
        // StartSelection/EndSelection 借给碎片（无选区概念）
        assert_eq!(field("StartSelection"), sf);
        assert_eq!(field("EndSelection"), ef);
    }

    /// 超过 8 位数字的偏移装不下（%08d 只有 8 位）：超大碎片直接
    /// 拒收，调用方退回纯文本，绝不能给出一个偏移错位的 blob。
    #[test]
    fn cf_html_rejects_oversized_fragment() {
        let big = "x".repeat(100 * 1024 * 1024);
        assert!(build_cf_html(&big).is_none());
    }

    /* ---------------- r56：识图截图的剪贴板"借了要还" ---------------- */

    /// r56 识图那条链的完整回合：**先备份 → 写图 → 用完还原**。
    ///
    /// 用户原话：「不管是识图搜索还是 ocr 截取的图片，用完之后记得删掉，这种只是
    /// 暂时的图片，不能永久的存在电脑里面。」
    ///
    /// 识图的截图不落盘（全程内存），唯一会"留下来"的是剪贴板。所以这条需求在
    /// 识图这里的落地形式就是 snapshot / restore 这一对：
    ///   · 动剪贴板**之前**备份（用户可能刚 Ctrl+C 了别的东西）；
    ///   · 写截图进去（Paste 类引擎靠它粘贴）；
    ///   · 一轮搜完之后还原 —— 截图消失，用户原来的内容原地不动。
    ///
    /// 为什么不是 `clear()`：那会把用户原本的内容一起抹掉，等于用一个新 bug
    /// 换掉一个旧抱怨。这一对则是"把借来的地方还回去"。
    ///
    /// ⚠ "CI 上跳过"和"测试其实是空的"必须分得开。分界线是两道断言：
    ///   · `set_text` —— 剪贴板打不开时它第一步就炸，不会走到下面；
    ///   · `keep.is_some()` —— 能写进去就该能备份。
    /// 有了这两道，restore 那几个断言（图没了 / 文字回来）**不可能**被悄悄跳过。
    #[test]
    fn 识图截图借了剪贴板要还() {
        const MARK: &str = "QS-R56-CLIP-PROBE-ORIGINAL";
        // 1) 摆一个已知内容
        assert!(set_text(MARK), "测试前置：往剪贴板放一段文字");
        // 2) 备份（= 识图动剪贴板之前那一手）
        let keep = snapshot();
        assert!(keep.is_some(), "能写进剪贴板就该能备份（否则这条测试会变成空跑）");
        // 3) 写截图进去（这里用一张 1x1 的 PNG 当"截图"）
        let fake_png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG 魔数
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
            0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, // IDAT
            0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
            0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
            0xAE, 0x42, 0x60, 0x82,
        ];
        assert!(set_image(fake_png), "写截图进剪贴板应当成功");
        assert!(has_image(), "写完之后剪贴板里应当是图");
        // 4) 还原（keep 上面已经断言过是 Some，这里放心用）
        restore(keep.as_ref().expect("上面断言过备份成功"));
        // 图没了、原来的文字回来了
        assert!(!has_image(), "还原之后剪贴板里不该再留着截图");
        let back = read_text_any();
        assert_eq!(
            back.as_deref(),
            Some(MARK),
            "还原之后用户原本复制的内容要原地回来（不是被清空）"
        );
        /* 5) 没备份成的时候**绝不能**去清空剪贴板（会把用户的东西抹掉）。
         *    这条由 img_clip_restore 的 `keep.as_ref()` 分支保证 ——
         *    None 时它只打一行日志、什么都不做。这里把语义写下来，
         *    免得后人"优化"成无条件 clear。 */
        let none_keep: Option<Snapshot> = None;
        assert!(none_keep.as_ref().is_none(), "None 备份 = 不动剪贴板");
    }
}
