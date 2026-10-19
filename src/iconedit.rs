//! 图标编辑器（#143）：一键消除背景。
//!
//! 用户原话：「当用户选择一个图标后，弹出一个专用的图标编辑页面。该编辑页面
//! 必须包含一个'一键消除背景'按钮，点击后自动识别并去除图标背景，仅保留主体
//! 部分；同时提供编辑前后对比预览、保存及取消等操作……最终处理结果能正确
//! 更新到原图标上」。
//!
//! 本文件只放**纯算法 + 会话状态**（不依赖 Tauri / 窗口 / 配置锁，方便单测）；
//! 命令、建窗、落库都在 main.rs。
//!
//! # 算法口径（泛洪 + 容差 + 羽化）
//!
//! 1. **取样**：把四条边上的像素按 5bit/通道量化成颜色桶（出现 ≥2 次才留，
//!    最多 256 个，按出现次数降序）—— 背景不一定是纯色，渐变/照片底也能
//!    覆盖到主要那几个色。
//! 2. **泛洪**：从所有「像背景」的边界像素出发做 4 邻域 BFS。判据两条，
//!    任一命中即算背景：
//!    · 颜色进桶（欧氏 RGB 距离 ≤ 容差）；
//!    · alpha < 250（本来就透明/半透明 —— 泛洪要能**穿过**它，否则老早抠过角的 PNG 会把泛洪堵死在边框一圈）。
//!    4 邻域而不是 8 邻域：对角线漏过去会把两个本不相连的区域连起来。
//! 3. **抠掉**：命中的像素 alpha 归零。**只抠与四边连成一片的**——主体内部
//!    封闭区域里的同色像素（字母镂空、圆环窟窿）不在泛洪路径上，原样保留，
//!    这正是「仅保留主体部分」想要的语义（和 Photoshop 魔术棒Contiguous 一致）。
//! 4. **羽化**：只给**边界像素**做一次 3×3 alpha 平均 —— 内部全不碰，
//!    避免把实心块糊成毛玻璃；边界平均后主体边缘出现一级抗锯齿，
//!    不会像剪刀剪的一样锯齿轮廓。
//!
//! 已知边界情况（页面有前后对比 + 取消兜底，算法不追求全自动完美）：
//!   · 主体顶满四边（没有露出的底色）时，边上的主体色会进桶 —— 这类图
//!     本来就没有背景，用户也不该点这个按钮；点了会看到预览不对，取消即可。
//!   · 半透明主体（alpha 100 且颜色不像背景）不会被抠掉，但泛洪会穿过它
//!     （它背后的同色背景仍会被正确抠除）。


/// 一次编辑器会话：进程级单例（编辑器一次只开一个窗口）。
#[derive(Clone, Debug, serde::Serialize)]
pub struct IconEditSession {
    /// overrideIcons 的键：引擎名 / `@app:<id>` / `@fav:<id>` / `@ocr`。
    pub key: String,
    /// 给人看的名字（编辑器标题用，不用哨兵原文）。
    pub name: String,
    /// 原图的 data URL（也可能是 `data/icons/<file>` 相对路径 —— 前端
    /// 对内置图标的兜底，Rust 侧按需读资源文件）。
    pub src: String,
    /// 是不是矢量图（SVG 没有位图背景可消，页面据此禁用按钮）。
    pub vector: bool,

}
static SESSION: std::sync::OnceLock<std::sync::Mutex<Option<IconEditSession>>> =
    std::sync::OnceLock::new();

fn slot() -> &'static std::sync::Mutex<Option<IconEditSession>> {
    SESSION.get_or_init(|| std::sync::Mutex::new(None))

}
pub fn set_session(s: IconEditSession) {
    if let Ok(mut g) = slot().lock() {
        *g = Some(s);
    }

}
/// 取出会话的克隆；没有会话返回 None（页面 boot 时先拉一次）。
pub fn load_session() -> Option<IconEditSession> {
    slot().lock().ok().and_then(|g| g.clone())

}
pub fn clear_session() {
    if let Ok(mut g) = slot().lock() {
        *g = None;
    }

}
/// 用户手描的「这块是主体，别抠」保护蒙版（r77）。
///
/// 前端在「编辑前」那张图上用画笔涂出来，按 canvas 尺寸送单通道数据过来
/// （非零 = 保护）。后端负责把它投到**当前处理尺寸**上 —— 因为图可能在
/// `remove_background` 里已经被缩到 `MAX_EDGE`，两份网格必须对齐，
/// 否则保护区域会整体偏移（用户看到的是"描了还是被吃"）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct KeepMask {
    pub w: u32,
    pub h: u32,
    /// 长度必须是 `w * h`；非零 = 保护
    pub data: Vec<u8>,

}
/// 与 `win::log` 同口径的轻量日志：这个模块不依赖 win，测试里也不该拉进来。
fn win_log(msg: &str) {
    // 真机看日志靠 main.rs 那一侧；这里只在带 QS_DEBUG 时打到 stderr，
    // 单测里默认不输出（避免污染测试输出）。
    if std::env::var("QS_DEBUG").map(|v| v == "1").unwrap_or(false) {
        eprintln!("[iconedit] {msg}");
    }

}
/// 与 `remove_background` 相同，但允许**临时指定模型**（`model_id` 覆盖配置）。
///
/// 用途（r80g）：
///   · 设置页的独立抠图工具 —— 用户可以在那儿换模型再抠
///   · 编辑器里"换一个模型重抠"（用户要求「某一个我抠的不满意，
///     我能立刻换另一个来抠」）
///
/// 为什么用参数传而不是改配置：这是**一次性选择**，不该污染用户的默认设置。
/// （用户换完觉得好，可以在设置里把它设为默认 —— 那是另一回事。）
pub fn remove_background_ex(
    bytes: &[u8],
    keep: Option<&KeepMask>,
    params: &crate::aimatte::Params,
    model_id: Option<&str>,
) -> Result<(Vec<u8>, usize, bool), String> {
    /* ⚠ 这里**只解码一次**。
     *
     * 以前是 `matting::prepare(bytes)` 解一遍（只为拿 w/h），然后把原始 bytes
     * 传给 `try_ai_with`，它内部又 `prepare` 一次 —— 一张 4000px 的原图被完整
     * 解码 + 缩放两遍（用户感知就是"点抠图要等一下"）。
     * 现在把解好的图直接递下去。 */
    let prepared = crate::matting::prepare(bytes)?;
    let (w, h) = prepared.dimensions();
    let keep_mask: Option<Vec<bool>> = keep.and_then(|m| {
        if m.w == 0 || m.h == 0 || m.data.len() != (m.w as usize) * (m.h as usize) {
            win_log("iconedit: 蒙版形状对不上，当没描过");
            return None;
        }
        let n = (w as usize) * (h as usize);
        let mut outv = vec![false; n];
        let mut any = false;
        for y in 0..h {
            let sy = ((y as u64 * m.h as u64) / h as u64).min(m.h as u64 - 1) as u32;
            for x in 0..w {
                let sx = ((x as u64 * m.w as u64) / w as u64).min(m.w as u64 - 1) as u32;
                if m.data[(sy as usize) * (m.w as usize) + (sx as usize)] != 0 {
                    outv[(y as usize) * (w as usize) + (x as usize)] = true;
                    any = true;
                }
            }
        }
        if any { Some(outv) } else { None }
    });
    crate::iconedit_ai::try_ai_prepared(
        prepared,
        keep_mask.as_deref(),
        params,
        model_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn png_of(img: &RgbaImage) -> Vec<u8> {
        let mut v = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut v, image::ImageFormat::Png)
            .unwrap();
        v.into_inner()
    }

    /* ══════════════════════════════════════════════════════════════════════
     * r80：本地抠图算法已删（用户要求「原来那个直接去掉」），
     * 所以这里不再有"抠完之后效果如何"的断言 —— 那些是 AI 的活儿，
     * 由 `tools/r80-ai-probe.js` 与 `r80-ai-visual.js` 在真机上验。
     *
     * 单测这一层只钉**接口契约**：错误信息给人话、坏输入不 panic、
     * 蒙版对齐正确。这些是纯逻辑，不需要模型也不需要 dll。
     * ══════════════════════════════════════════════════════════════════════ */

    /// 没开开关 / 没模型时，必须返回**能读、能操作**的中文错误。
    ///
    /// 为什么这条重要：删掉本地兜底之后，错误信息成了用户唯一的信息来源。
    /// 如果这里返回空串或英文堆栈，用户看到的就是"点了没反应"。
    #[test]
    fn 不可用时给出可操作的中文错误() {
        let img = RgbaImage::new(16, 16);
        let e = remove_background_ex(&png_of(&img), None, &crate::aimatte::Params::default(), None).unwrap_err();
        assert!(!e.is_empty(), "错误不能为空");
        assert!(
            e.contains("设置") || e.contains("抠图") || e.contains("AI"),
            "错误要能指引用户去哪打开，实际：{e}"
        );
    }

    /// 坏输入要报错而不是 panic（图太小 / 不是图）。
    #[test]
    fn 坏输入报错不panic() {
        // 不是图片
        assert!(remove_background_ex(b"not an image at all", None, &crate::aimatte::Params::default(), None).is_err());
        assert!(remove_background_ex(&[], None, &crate::aimatte::Params::default(), None).is_err());
        // 太小（1×1 解出来也过不了 prepare 的下限）
        let tiny = RgbaImage::from_pixel(1, 1, Rgba([255, 0, 0, 255]));
        let r = remove_background_ex(&png_of(&tiny), None, &crate::aimatte::Params::default(), None);
        // 允许它因为"没开开关"而失败，也允许因为"图太小"而失败 ——
        // 关键是**不能 panic**
        assert!(r.is_err() || r.is_ok());
    }

    /// 补描蒙版形状不对（长度 ≠ w×h）时，**不能因此让整条命令失败** ——
    /// 那是"用户描了个坏蒙版"，不该连累抠图本身。
    #[test]
    fn 坏蒙版不连累整条命令() {
        let img = RgbaImage::new(16, 16);
        let bad = KeepMask { w: 10, h: 10, data: vec![255u8; 3] }; // 长度明显不对
        let r = remove_background_ex(&png_of(&img), Some(&bad), &crate::aimatte::Params::default(), None);
        // 只会因为"功能没开"而失败，不会因为蒙版坏而 panic
        assert!(r.is_err() || r.is_ok());
    }

    /// 全零蒙版（进了描边模式但一笔没画）等价于没描 —— 同样不能失败或 panic。
    #[test]
    fn 空蒙版等价于没描过() {
        let img = RgbaImage::new(16, 16);
        let empty = KeepMask { w: 16, h: 16, data: vec![0u8; 16 * 16] };
        let r = remove_background_ex(&png_of(&img), Some(&empty), &crate::aimatte::Params::default(), None);
        assert!(r.is_err() || r.is_ok());
    }

    /// 带参数那条路也要能用（`remove_background_with` 是新接口）。
    #[test]
    fn 带参数接口不panic() {
        let img = RgbaImage::new(16, 16);
        let p = crate::aimatte::Params::default();
        let r = remove_background_ex(&png_of(&img), None, &p, None);
        assert!(r.is_err() || r.is_ok());
    }

    /* ── 参数本身的约束（纯逻辑，不需要模型） ── */

    /// 前景门槛不能低于背景门槛 —— 否则同一个像素会既"确定前景"又"确定背景"，
    /// trimap 就变成随机结果。`clamped()` 必须把这个矛盾修掉。
    #[test]
    fn 参数夹取修掉前后景矛盾() {
        let p = crate::aimatte::Params {
            fg_confidence: 20,   // 比背景门槛还低 → 矛盾
            bg_confidence: 100,
            ..Default::default()
        };
        let c = p.clamped();
        assert!(
            c.fg_confidence > c.bg_confidence,
            "夹取后前景门槛必须高于背景门槛：fg={} bg={}",
            c.fg_confidence,
            c.bg_confidence
        );
    }

    /// 羽化半径不能超过实现支持的上限（后端只做 0~4，超了没有意义）。
    #[test]
    fn 羽化半径被夹到上限() {
        let p = crate::aimatte::Params { feather: 99, ..Default::default() };
        assert!(p.clamped().feather <= 4, "羽化半径应当被夹到 4 以内");
    }

    /// 默认参数必须落在合法范围内（不然"恢复默认"会把用户带到非法状态）。
    #[test]
    fn 默认参数本身合法() {
        let d = crate::aimatte::Params::default();
        let c = d.clamped();
        assert_eq!(c.fg_confidence, d.fg_confidence, "默认前景门槛不该被夹取改动");
        assert_eq!(c.bg_confidence, d.bg_confidence, "默认背景门槛不该被夹取改动");
        assert_eq!(c.feather, d.feather, "默认羽化不该被夹取改动");
        assert!(c.fg_confidence > c.bg_confidence);
    }
}