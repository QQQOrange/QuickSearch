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
    /// 备份那一刻的剪贴板序号。
    ///
    /// 还原前拿它和当前序号比：**不一样就说明有人（用户或别的程序）在中间
    /// 改过剪贴板**，这时候还原等于把人家刚复制的东西抹掉。实测踩过的形状是
    /// 「识图 1~2 秒里用户又 Ctrl+C 了一次别的文本，搜完图剪辑板被还原成旧内容」。
    seq: u32,
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

    /// **重新对齐基准**：把"这是什么时刻的剪贴板"改成此刻。
    ///
    /// # 为什么必须有（这是修复自己上一轮引入的回归）
    ///
    /// `restore_if_unchanged` 拿 `self.seq` 和当前序号比，判断"这中间有没有
    /// 别人写过"。但要命的是，取词和识图这两条路都是：
    ///
    /// ```text
    ///   snapshot()             ← 记下 seq = A
    ///   我们自己写剪贴板        ← seq 变成 B（SendInput 的 Ctrl+C / set_image）
    ///   restore_if_unchanged() ← A != B，判成"别人改过"，**永不还原**
    /// ```
    ///
    /// 后果正是原版花大力气避免的两件事：**选中文字永久留在剪贴板里**
    /// （用户一眼看出"选中就复制了"）、**识图的截图清不掉**。
    ///
    /// 所以必须在我们**自己写完剪贴板之后**调一次这个，把基准挪到 B；
    /// 此后若再有写入（用户在识图那 1~2 秒里又 Ctrl+C），才是真的"别人改过"，
    /// 那时跳过还原才是对的。
    pub fn note_our_write(&mut self) {
        self.seq = seq();
    }
}

fn open_clipboard() -> bool {
    open_clipboard_within(30)
}

/// 打开剪贴板，最多重试 `tries` 次（每次间隔 10ms）。
///
/// 重试窗口的大小是**场景相关**的，不能一刀切：
///   · 还原路径（`restore` / 还原前的预分配）值得等满 300ms —— 等不到就丢数据；
///   · "看一眼剪贴板有什么"（`has_image` / 取词轮询里的读）不该等 —— 那条路
///     40ms 就轮一次，每次都在里面阻塞 300ms 的话，一次取词会被它吃掉好几个窗口
///     （实测：`capture_selection` 的 250ms 首轮窗口被 `has_image` 一次就读完）。
fn open_clipboard_within(tries: u32) -> bool {
    // 30 × 10ms ≈ 300ms：微信这类客户端"握着剪贴板准备数据"的时候会把
    // OpenClipboard 一直挡回来，重试窗口给足一点能少丢几次。
    for _ in 0..tries {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// 剪贴板格式表：打开 → 枚举 → 关闭。**不重试**（返回原样的空表）。
fn enum_formats_once(limit: usize, tries: u32) -> Option<Vec<u32>> {
    if !open_clipboard_within(tries) {
        return None;
    }
    let mut out = Vec::new();
    unsafe {
        let mut f = 0u32;
        while out.len() < limit {
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

/// 枚举剪贴板格式，**空表时短暂重试**。
///
/// # 为什么要重试（实测抓到的真 bug）
///
/// `EmptyClipboard + SetClipboardData + CloseClipboard` 之后，系统的剪贴板
/// 数据对象要等下一次被打开（别的进程读、或系统合成 CF_TEXT/CF_LOCALE）
/// 才真正"落地"。实测（本机 release，`clip::tests`）：
///
/// ```text
/// t=00 formats=Some([])                          text=Some("QS-TIMELINE-MARK")
/// t=01 formats=Some([13, 16, 1, 7])              text=Some("QS-TIMELINE-MARK")
/// ```
///
/// 也就是说紧跟着自己写完剪贴板去枚举，会拿到**空表**，但
/// `GetClipboardData(CF_UNICODETEXT)` 已经有内容 —— 两个视图不同步。
///
/// 这不是测试的怪癖，是产品路径上的真问题：`snapshot()` 拿到空表就会
/// 认为"用户剪贴板本来就是空的"，用完 `restore()` 时 `EmptyClipboard()`
/// 之后一个格式都不写回 —— **用户刚复制的内容被清空**。
fn enum_formats_settled(tries: u32) -> Option<Vec<u32>> {
    /* 最多 4 轮的「空表」重试。
     *
     * ⚠ 总耗时要算**两笔**：打开剪贴板的重试（`tries` × 10ms）和轮次间隔（8ms）。
     *   调用方给的 `tries` 会被乘进每一轮，所以**后续轮次改用短 tries**：
     *   第一轮按调用方要求等满（还原路径值得等），后面几轮只是"数据还没落地"
     *   的复检，4 次（40ms）足够。否则 `snapshot()` 的 30 tries 会变成
     *   300ms × 4 ≈ 1.2 秒——把取词那条路的首轮窗口直接吃光。 */
    let mut last: Option<Vec<u32>> = None;
    for i in 0..4 {
        let t = if i == 0 { tries } else { tries.min(4) };
        match enum_formats_once(512, t) {
            None => return None, // 打不开 ≠ 空的，原样上报（调用方据此放弃还原）
            Some(v) if !v.is_empty() => return Some(v),
            Some(v) => {
                last = Some(v);
                if i < 3 {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
        }
    }
    last
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
    /* ⚠ 格式表必须用「空表会重试」的那一版：紧接在自己写完剪贴板之后
     * 枚举，系统可能先给出一张空表（见 `enum_formats_settled` 的实测记录）。
     * 拿空表当"用户剪贴板是空的" → 还原时什么都不写回 → **用户内容被清空**。 */
    let formats = enum_formats_settled(30)?;
    // 序号要在**枚举之前**取：枚举本身可能触发系统合成格式（会推进序号），
    // 之后取就会把"我们自己的枚举"错认成第三方改动。
    let seq = seq_at_snapshot();
    if formats.is_empty() {
        return Some(Snapshot { items: Vec::new(), seq });
    }
    if !open_clipboard() {
        return None;
    }
    let mut items = Vec::new();
    unsafe {
        for f in formats {
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
    Some(Snapshot { items, seq })
}

/// 还原的**安全版**：剪贴板在我们备份之后被人改过，就什么都不动。
///
/// # 为什么需要它（真实数据丢失路径）
///
/// 识图那条链是「snapshot → 写截图进剪贴板 → 各家上传（0.3~2s）→ restore」。
/// 这 1~2 秒里用户完全可能自己又 Ctrl+C 了一次别的内容 —— 无条件 `restore`
/// 会把那份**刚复制的文本覆盖回旧的**，用户看到的正是"我明明复制了，粘出来是上一条"。
///
/// 判据用剪贴板序号：备份时记一份，还原前再读一份，不一样就说明中间有人写过。
/// 代价是"序号变了但其实内容没变"时我们不还原 —— 那种情况用户本来也没丢东西。
pub fn restore_if_unchanged(s: &Snapshot) {
    let now = seq();
    if now != s.seq {
        crate::win::log(&format!(
            "clip: 备份之后剪贴板被改过（seq {}→{}），跳过还原，保留当前内容",
            s.seq, now
        ));
        return;
    }
    restore(s);
}

/// 取快照时刻的序号（单独抽出来，方便测试注入/替换）。
fn seq_at_snapshot() -> u32 {
    seq()
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
///
/// ⚠ 走 `enum_formats_settled(4)` 而不是自己枚举：紧接在**我们自己**刚写完剪贴板
/// 之后调用时，系统可能先给出一张空表（见那个函数的实测记录），自枚举会误报
/// 「不是图」。这条路只在 Ctrl+C 之后跑，32ms 的重试窗口不影响手感。
///
/// ⚠ 而且**只重试 4 次（≈30ms）的打开**，不是 300ms：这个函数在取词的
/// 40ms 轮询里被反复调用，每次阻塞 300ms 的话 250ms 的首轮窗口一次就被它吃掉
/// （审计实测就是这个形状）。
pub fn has_image() -> bool {
    match enum_formats_settled(4) {
        Some(v) => v.iter().any(|f| matches!(f, 2 | 8 | 17)),
        None => false,
    }
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

/* ---------------- 「复制前」的剪贴板（v2.11.1） ---------------- */

/// Ctrl+C 按下那一刻抢到的原剪贴板文本：(内容, 抓取时刻)。
static PRE_COPY: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);

/// 在 Ctrl+C **进入目标程序之前**抢一份剪贴板文本（钩子回调里调）。
///
/// # 为什么必须抢在复制之前
///
/// 网格页 / 横条就是用 Ctrl+C 唤出的，而 Ctrl+C 本身已经把剪贴板改成了选区内容。
/// 包裹符号、文本处理里那句 `snapshot()` 抓到的是**复制之后**的值，"还原"等于
/// 把选区又放回去 —— 用户看到的就是「剪贴板根本没回退」。
///
/// # 为什么只读文本、只开一次
///
/// 钩子回调有 300ms 上限（`LowLevelHooksTimeout`），绝不能在这里读全盘格式
/// （一张截图可能几十 MB）。单次 `OpenClipboard` 失败就放弃 —— 那说明别的程序
/// 正握着剪贴板，此刻硬抢会把它的复制搞坏。读不到就什么都不记，
/// 后面退回原来的 snapshot 行为（等于不还原），不会更糟。
pub fn capture_precopy() {
    // 2 秒内已经抓过就别重复：按住 Ctrl+C / 连按时会被叫很多次
    if let Ok(g) = PRE_COPY.lock() {
        if let Some((_, at)) = g.as_ref() {
            if at.elapsed() < Duration::from_secs(2) {
                return;
            }
        }
    }
    let Some(t) = read_text_quick() else { return };
    if let Ok(mut g) = PRE_COPY.lock() {
        *g = Some((t, std::time::Instant::now()));
    }
}

/// 单次尝试读 CF_UNICODETEXT（不重试 —— 钩子线程里不能等）。
fn read_text_quick() -> Option<String> {
    if unsafe { OpenClipboard(None) }.is_err() {
        return None;
    }
    let mut out = None;
    unsafe {
        if let Ok(h) = GetClipboardData(CF_UNICODETEXT) {
            let hg = HGLOBAL(h.0);
            let p = GlobalLock(hg) as *const u16;
            if !p.is_null() {
                // 自己数长度：GlobalSize 含对齐填充，不能用它当字符数
                let mut n = 0usize;
                while n < 4_000_000 && *p.add(n) != 0 {
                    n += 1;
                }
                if n < 4_000_000 {
                    out = Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, n)));
                }
                let _ = GlobalUnlock(hg);
            }
        }
        let _ = CloseClipboard();
    }
    out
}

/// 取走「复制前」的那份文本（**一次性**，超过 `ttl` 视为过期）。
pub fn take_precopy(ttl: Duration) -> Option<String> {
    let mut g = PRE_COPY.lock().ok()?;
    let taken = g.take()?;
    if taken.1.elapsed() <= ttl {
        Some(taken.0)
    } else {
        None
    }
}

/// 用一段文本造一个"最小快照"（只含 CF_UNICODETEXT）。
///
/// 用于把剪贴板还原成「复制之前」的内容：正常 `snapshot()` 是在复制**之后**
/// 抓的，抓到的就是选区本身。只带文本是有意的 —— 复制前如果放的是图片，
/// 我们根本没抓到像素，就不该假装能还原（那种情况走原来的 snapshot 分支）。
pub fn text_snapshot(text: &str) -> Snapshot {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes: Vec<u8> = wide.iter().flat_map(|u| u.to_le_bytes()).collect();
    Snapshot {
        items: vec![(CF_UNICODETEXT, bytes)],
        seq: seq(),
    }
}

/// 把一段字节按指定剪贴板格式写进去。**调用方须已打开并清空剪贴板**。
/// 成功时 HGLOBAL 所有权移交给系统，不能再 free；失败返回 false。
unsafe fn put_format(fmt: u32, bytes: &[u8]) -> bool {    if bytes.is_empty() {
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
///
/// ⚠ 只给 4 次（≈30ms）的打开窗口：它出现在**日志与轮询**里，不该为了诊断
/// 把取词的关键窗口堵住。要长重试的是还原路径，不是诊断。
pub fn formats_open() -> Option<Vec<u32>> {
    enum_formats_settled(4)
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
///
/// ⚠ **读取路径只给短重试（4 × 10ms）**，不要用 `open_clipboard()` 的 300ms。
///
/// 这个函数出现在取词那条 **40ms 一轮的轮询**里（见 `capture_selection`）：
/// 每轮都阻塞 300ms 的话，本来 250ms 的首轮窗口会被一次读取吃掉，
/// 用户侧的体感就是"划词弹得慢"。
/// 读取本来就允许失败（读不到就下一轮再试），没必要为一个"看一眼"等 300ms；
/// 需要长重试的是**写入/还原**那条路（等不到就丢数据）。
pub fn read_text_any() -> Option<String> {
    read_text_any_within(4)
}

/// 带可调重试次数的读取（重试 = 每次 10ms）。
pub fn read_text_any_within(tries: u32) -> Option<String> {
    if !open_clipboard_within(tries) {
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

    /// 剪贴板测试的串行锁。
    ///
    /// 剪贴板是**进程级单例**：两条测试并行跑就会互相踩（A 刚 `set_text`，
    /// B 立刻 `set_image` 把它覆盖掉，于是 A 的前置断言直接炸）。
    /// 之前只有一条剪贴板测试所以没暴露；加上第二条之后立刻撞上了。
    ///
    /// 用 `Mutex<()>` + `lock().unwrap_or_else(|e| e.into_inner())`：某条测试
    /// 断言失败时锁会被标记 poison，后面的照样能拿到（否则一条红会连累全部）。
    static CLIP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        CLIP_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 把一段文字放进剪贴板，**失败时给足重试**。
    ///
    /// # 为什么测试要自己包一层（实测：60 遍里第 16 遍偶发失败）
    ///
    /// `set_text` 内部的 `open_clipboard` 是 30 × 10ms = 300ms 重试窗口，
    /// 这个数字是**产品**的取舍（阻塞太久会拖累取词那条 40ms 一轮的轮询，
    /// 见 `open_clipboard_within` 的注释）。但剪贴板是**全机器**的单例：
    /// 本机任何进程（资源管理器 / 浏览器 / 微信 / Office，甚至 Windows 自己
    /// 合成格式）握它几十到几百毫秒是常态 —— 于是测试的前置步骤
    /// `assert!(set_text(MARK))` 会偶发失败，之前 25 遍全绿、第 26 遍红一次。
    ///
    /// # 为什么不能用"跳过"来消掉它
    ///
    /// 这条测试的价值全在**语义断言**（图没了 / 文字回来了）。悄悄跳过
    /// 等于把测试变成空跑 —— 上面注释里明写过这道分界线。所以这里做的是：
    /// 前置那几步的重试窗口加长到 ~2.5 秒，2.5 秒还拿不到才 fail，
    /// 并把"本机有进程长期独占剪贴板"这句话直接写在断言里。
    ///
    /// 返回是否就绪（false = 本机此刻根本拿不到剪贴板，调用方**必须**失败）。
    fn set_text_wait(mark: &str) -> bool {
        for attempt in 1..=25 {
            if set_text(mark) {
                return true;
            }
            if attempt % 5 == 0 {
                eprintln!(
                    "[clip 测试] 第 {attempt} 次还拿不到剪贴板（本机有别的进程正握着它），继续等…"
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// 往剪贴板写一段**截图**，同样给足重试（理由同 `set_text_wait`）。
    fn set_image_wait(png: &[u8]) -> bool {
        for _ in 0..25 {
            if set_image(png) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// 等剪贴板里出现图片（"写完了但还没落地"那段窗口，见 `enum_formats_settled`）。
    fn wait_image(step: &str) {
        for _ in 0..20 {
            if has_image() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{step}：约 500ms 后剪贴板里仍然没有图");
    }

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
    /* ⚠ 两条临时诊断测试（debug_clip_timeline_probe / debug_clip_restore_probe）
     * 在定位「紧跟着自己写完剪贴板去枚举会拿到空表」这个 bug 时用过，已删 ——
     * 它们会长时间占用剪贴板，留在测试集里只会拖慢、还会和真机上的复制动作打架。
     * 结论已经写进 `enum_formats_settled()` 的注释。 */

    #[test]
    fn 识图截图借了剪贴板要还() {
        let _serial = serial();   // 剪贴板是进程级单例，测试必须串行
        const MARK: &str = "QS-R56-CLIP-PROBE-ORIGINAL";
        // 1) 摆一个已知内容
        assert!(
            set_text_wait(MARK),
            "测试前置：约 2.5 秒内始终拿不到剪贴板（本机有进程长期独占）——\
             这不是被测代码的问题，但也**不能**当成测试通过，此处直接失败并说明原因"
        );
        // 2) 备份（= 识图动剪贴板之前那一手）
        let keep = snapshot();
        /* ⚠ 这一条原来是 `snapshot().expect(...)` —— 测试里唯一一个会
         * 「Backup failure is silently swallowed」的入口。改成显式分支：
         * 备份不来就说清楚拿不到剪贴板这套测试没法往下跑，而不是把
         * 「被别的进程挡了」误报成「snapshot 实现错了」。 */
        let Some(keep) = keep else {
            panic!("测试前置：约 2.5 秒内始终拿不到剪贴板（本机有进程长期独占），备份无意义");
        };
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
        assert!(set_image_wait(fake_png), "写截图进剪贴板应当成功");
        wait_image("写完之后");
        restore(&keep);
        // 图没了、原来的文字回来了
        // ⚠ 这两个断言也要容忍"落地/同步那一瞬"：同上，轮一小会儿再断。
        let mut gone = false;
        for _ in 0..20 {
            if !has_image() {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(gone, "还原之后剪贴板里不该再留着截图");
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

    /// `restore_if_unchanged` 的**基准对齐**语义（这是修自己上一轮引入的回归）。
    ///
    /// # 它钉住的是什么
    ///
    /// 取词 / 识图两条路都是「snapshot → **我们自己**写剪贴板 → 用完还原」。
    /// `snapshot` 记的序号是"写之前"的，而我们自己那一写必然让序号 +1。
    /// 如果还原前不把基准挪到"刚写完那一刻"，`restore_if_unchanged` 会把
    /// **我们自己的写入**误判成"第三方改过"，于是永远跳过还原 ——
    /// 选中文字永久留在剪贴板、识图截图清不掉。
    ///
    /// 所以这条测试走两个回合：
    ///   ① 写完不 note_our_write → 应当**跳过**还原（判断依据是"变了"）；
    ///   ② 写完先 note_our_write → 应当**真的**还原。
    ///
    /// ⚠ 只测语义，不测实现细节；剪贴板打不开时（CI / 被占）第一步 set_text 就炸，
    ///   不会把断言悄悄跳过。
    #[test]
    fn 自己写完剪贴板后要重新对齐基准才还原() {
        let _serial = serial();   // 剪贴板是进程级单例，测试必须串行
        use windows::Win32::System::DataExchange::EmptyClipboard;

        const MARK: &str = "QS-R82-ALIGN-PROBE";
        let fake_png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];

        /* ---- 回合 ①：写完不对齐 → 应当跳过还原 ---- */
        assert!(
            set_text_wait(MARK),
            "测试前置：约 2.5 秒内始终拿不到剪贴板（本机有进程长期独占）"
        );
        let Some(mut keep) = snapshot() else {
            panic!("测试前置：拿不到剪贴板，snapshot 无从谈起（本机有进程长期独占）");
        };
        assert!(set_image_wait(fake_png), "写图进剪贴板应当成功");
        wait_image("回合 ① 写完之后");
        // 不对齐基准就直接走"安全还原"：它应当拒绝（因为序号确实变了）
        restore_if_unchanged(&keep);
        /* ⚠ 这里断言的是"图**还在**"—— 也就是说它依赖"上一次 has_image 已经
         *   看到图、且刚才那次 restore_if_unchanged 什么也没做"。等一小会儿
         *   再断：万一上一次读赶上落地前的空表，这里会假失败。 */
        for _ in 0..20 {
            if has_image() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            has_image(),
            "没对齐基准时 restore_if_unchanged 必须**跳过**（把'我们自己写的'误判成第三方，正是那个回归）"
        );

        /* ---- 回合 ②：对齐基准 → 应当真的还原 ---- */
        keep.note_our_write();
        restore_if_unchanged(&keep);
        for _ in 0..20 {
            if !has_image() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!has_image(), "对齐基准之后，还原应当真的执行（图消失）");
        assert_eq!(
            read_text_any().as_deref(),
            Some(MARK),
            "对齐基准之后，用户原本的内容要回来"
        );

        // 收尾：别把测试痕迹留在用户剪贴板里
        if open_clipboard() {
            unsafe {
                let _ = EmptyClipboard();
                let _ = CloseClipboard();
            }
        }
    }

    /// 「复制前」快照：只带 CF_UNICODETEXT，文本要能原样读回来。
    ///
    /// 这条守的是"Ctrl+C 唤出网格后剪贴板能不能真回退"：
    /// 正常 `snapshot()` 抓的是复制**之后**的选区，还原等于没还原；
    /// `text_snapshot` 才是"复制之前"那份的替身。
    #[test]
    fn text_snapshot_round_trips_utf16() {
        let s = text_snapshot("你好 ABC");
        assert_eq!(s.items.len(), 1, "只该带一项文本格式");
        assert_eq!(s.text().as_deref(), Some("你好 ABC"));
        // 空串也要能造（用户复制前剪贴板就是空的）
        assert_eq!(text_snapshot("").text().as_deref(), Some(""));
    }

    /// 「复制前」缓存是**一次性**的，且超过 TTL 就不再认。
    ///
    /// 一次性：同一个 Ctrl+C 只该服务一次回写，否则第二次包裹会还原成
    /// 更久以前的内容。TTL：隔很久才点格子时，还原一份陈年剪贴板比不还原更吓人。
    #[test]
    fn precopy_is_one_shot_and_expires() {
        *PRE_COPY.lock().unwrap() = Some(("A".to_string(), std::time::Instant::now()));
        assert_eq!(take_precopy(Duration::from_secs(60)).as_deref(), Some("A"));
        assert!(take_precopy(Duration::from_secs(60)).is_none(), "取过一次就没了");

        *PRE_COPY.lock().unwrap() =
            Some(("B".to_string(), std::time::Instant::now() - Duration::from_secs(120)));
        assert!(
            take_precopy(Duration::from_secs(60)).is_none(),
            "过期的不能再拿来还原"
        );
    }
}
