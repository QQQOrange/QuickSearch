//! 全局低级钩子：鼠标左键（判拖选）与键盘（Ctrl+C 兜底）。
//!
//! 低级钩子的回调跑在装钩子的那个线程里，而且有 LowLevelHooksTimeout 限制
//! （默认 300ms），所以回调里绝不做重活 —— 只把事件丢进 channel，
//! 真正的判断和取词交给消费线程。

use std::sync::mpsc::Sender;
use std::sync::Mutex;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, SetWindowsHookExW, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

use crate::clip;
use crate::win;

#[derive(Debug, Clone, Copy)]
pub enum Ev {
    Down(i32, i32, u32),
    Up(i32, i32, u32),
    Move(i32, i32),
    /// 键盘按下。
    ///
    /// 字段：`(vk, 剪贴板序号, ctrl, alt, shift, 是不是我们自己注入的)`
    ///
    /// 为什么要在钩子里就把**序号**取下来：低级键盘钩子的回调是在按键进入目标
    /// 线程消息队列**之前**跑的，此刻用户这次 Ctrl+C 还没生效，序号是"复制前"
    /// 的值。等事件排到消费线程再取就晚了 —— 目标程序可能已经写好了剪贴板，
    /// 前后一比永远相等，正确复制反而会被判成"没选中"。
    ///
    /// 为什么连**修饰键状态**也一起取下来：消费线程是异步的，等它排到这条事件时，
    /// 用户可能已经把 Ctrl 松开了。原来在消费线程里调 `ctrl_down()` 就会读到 false
    /// → Ctrl+C 判定失败 → 横条不弹。钩子回调是在按键生效那一刻同步执行的，
    /// 此刻的修饰键状态才是"用户按下这个键时"的真实状态。
    ///
    /// 为什么还要一个"是不是我们自己注入的"标记：取词时要模拟一次 Ctrl+C，
    /// 那次注入绝不能被当成用户按的。靠 `dwExtraInfo` 里的暗号
    /// （`win::SELF_INJECT_TAG`）一锤定音 —— 比"时间窗"靠谱，不会误吞第三方
    /// 工具发的 Ctrl+C（用户报过"概率性唤不出来"，就是时间窗误吞造成的）。
    KeyDown(u32, u32, bool, bool, bool, bool),
    /// 键盘抬起。
    ///
    /// 专门为 OCR 框选遮罩的 Esc 兜底：遮罩窗口虽然 `.focused(true)`，但 WebView2
    /// 拿到键盘焦点常有几十毫秒的延迟，用户一进框选就按 Esc 有可能落不到页面里
    /// （页面 keydown 收不到 → 遮罩不关 → 满屏点不动）。所以除了页面自己听
    /// keydown，全局钩子这里也听一份，双保险。
    ///
    /// 用**抬起**而不是按下：按下大多被页面先吃掉了，抬起事件几乎总是能到，
    /// 两个都听会在一次按键里触发两遍取消（虽然幂等，但日志会重复）。
    KeyUp(u32),
    /// 右键按下。
    ///
    /// 为什么不用网页的 `contextmenu` 事件：横条窗口是 WS_EX_NOACTIVATE 的
    /// 无激活浮层，WebView2 在有些情况下压根不往页面派发 contextmenu，
    /// 右键会"点了没反应"或弹出 Edge 自带的菜单。改成从全局钩子驱动，
    /// 只要落点在横条上就自己开菜单，行为完全可控。
    RDown(i32, i32),
}

static TX: Mutex<Option<Sender<Ev>>> = Mutex::new(None);

fn send(e: Ev) {
    if let Ok(g) = TX.lock() {
        if let Some(tx) = g.as_ref() {
            let _ = tx.send(e);
        }
    }
}

const LLMHF_INJECTED: u32 = 0x0000_0001;

/// 平时一定要挡掉「被程序注入」的输入（否则别的自动化工具一动鼠标就会误弹）。
/// 只有做自动化测试时用 QS_ALLOW_INJECTED=1 放开。
fn allow_injected() -> bool {
    static ALLOW: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ALLOW.get_or_init(|| {
        std::env::var("QS_ALLOW_INJECTED")
            .map(|v| v == "1")
            .unwrap_or(false)
    })
}

unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = win::ll_mouse(l);
        if allow_injected() || info.flags & LLMHF_INJECTED == 0 {
            let msg = w.0 as u32;
            match msg {
                WM_LBUTTONDOWN => send(Ev::Down(info.pt.x, info.pt.y, info.time)),
                WM_LBUTTONUP => send(Ev::Up(info.pt.x, info.pt.y, info.time)),
                WM_MOUSEMOVE => send(Ev::Move(info.pt.x, info.pt.y)),
                // ⚠ 只在 **DOWN** 时发 RDown。以前 DOWN / UP 都发 —— 结果菜单在
                //   按下时打开、松开时又收到一次 RDown，前端先藏菜单再查重，
                //   150ms 内命中查重就不再重开 → 用户看到「按住才有菜单、
                //   一松开就没了」（真实反馈）。UP 一律忽略。
                //   至于「别的鼠标钩子会吃掉 WM_RBUTTONDOWN」的兜底：那是
                //   spawn_rbutton_watch 轮询线程的职责（只在按下沿触发），
                //   不需要 UP 来补。
                WM_RBUTTONDOWN => {
                    win::log(&format!("hook: RMB down at ({},{})", info.pt.x, info.pt.y));
                    send(Ev::RDown(info.pt.x, info.pt.y))
                }
                WM_RBUTTONUP => {
                    win::log(&format!("hook: RMB up at ({},{})", info.pt.x, info.pt.y));
                }
                m if (0x0200..=0x0210).contains(&m) => {
                    win::log(&format!("hook: other mouse msg {m:#06x}"));
                }
                _ => {}
            }
        }
    }
    win::call_next(code, w, l)
}

unsafe extern "system" fn keyboard_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = win::ll_keyboard(l);
        /* ⚠ 键盘这里**故意不过滤"被注入"的按键**（鼠标那边才过滤）。
         *
         * 用户明确要求：**第三方软件（AutoHotkey、宏工具、某些键盘驱动）发出的
         * Ctrl+C 也要能把横条叫出来**。这类工具一律走 SendInput / keybd_event，
         * 系统会给它们打上 LLKHF_INJECTED 标记；一旦照旧一律丢弃，用户那条路
         * 就永远哑火 —— 他的原话是"这个功能还没有"。
         *
         * 那"我们自己注入的 Ctrl+C"（取词时模拟复制）怎么办？—— 由
         * `win::is_self_injected_ctrl_c()` 那块 400ms 的牌子兜住：
         * 消费线程看到牌子立着就跳过，不会造成"空白处拖一下也弹条"的误判。
         *
         * 鼠标那条路仍然保留过滤：截图/拖拽类工具动一下鼠标就触发取词会很吵，
         * 而且用户没有提出这类需求。 */
        {
            let msg = w.0 as u32;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                // GetClipboardSequenceNumber 是个极轻的查询，不开剪贴板、不分配内存，
                // 放在钩子回调里完全安全（不会撞 LowLevelHooksTimeout）。
                // GetAsyncKeyState 同样是极轻的查询，且**此刻**读到的修饰键状态
                // 才是"用户按下这个键时"的状态（见 Ev::KeyDown 的注释）。
                send(Ev::KeyDown(
                    info.vkCode,
                    clip::seq(),
                    win::ctrl_down(),
                    win::alt_down(),
                    win::shift_down(),
                    // 暗号对上了 = 这是软件自己为取词注入的 Ctrl+C，消费线程会跳过
                    info.dwExtraInfo == win::SELF_INJECT_TAG,
                ));
            } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                send(Ev::KeyUp(info.vkCode));
            }
        }
    }
    win::call_next(code, w, l)
}

/// 起一个专门跑消息循环的线程来装钩子。钩子句柄跟着线程活，不主动卸。
pub fn spawn(tx: Sender<Ev>) {
    if let Ok(mut g) = TX.lock() {
        *g = Some(tx);
    }
    std::thread::Builder::new()
        .name("qs-hooks".into())
        .spawn(|| unsafe {
            // ⚠ 成败都要记账。以前这里是 `let _mouse = ...` 静默丢弃 —— 装钩子
            // 失败（被安全软件拦、系统钩子数耗尽等）时用户侧只表现为「Ctrl+C
            // 没反应」，log.txt 里一个字不留，排查只能干猜。句柄接着留在闭包
            // 栈上：钩子跟着这条线程的消息循环活，不主动卸。
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0);
            let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0);
            win::log(&format!(
                "hooks: WH_MOUSE_LL {} / WH_KEYBOARD_LL {}",
                hook_state("鼠标（划词触发）", mouse.as_ref().err()),
                hook_state("键盘（Ctrl+C 兜底）", kb.as_ref().err()),
            ));
            let _mouse = mouse;
            let _kb = kb;
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        })
        .ok();
}

/// 钩子安装结果的一句人话。错误码取 HRESULT 的低 16 位（Win32 错误号）。
fn hook_state(what: &str, err: Option<&windows::core::Error>) -> String {
    match err {
        Some(e) => {
            let code = (e.code().0 as u32) & 0xFFFF;
            format!("{what}钩子装失败（错误码 0x{code:X}，对应功能不工作）")
        }
        None => format!("{what}钩子已装"),
    }
}
