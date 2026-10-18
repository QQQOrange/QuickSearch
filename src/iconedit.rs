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
/// 把一张位图的背景抠成透明（r79：改用阿尔法抠图，见 `matting` 模块）。
///
/// `tolerance`：**背景判定的宽松度**（页面滑块 10–120，默认 48）。
///   值越大越"敢"把边缘像素判成背景；小一点更保守。
///
/// `keep`：**手动描边保护蒙版**，可选。非零 = 这块是主体，
///   **无条件**保持不透明（连 matting 的求解都不参与）。
///
/// 返回 `(PNG 字节, 被抠掉的像素数, 是否没找到可靠背景)`。
///
/// # 与旧实现（r76 及以前）的区别
///
/// 旧实现是"从四边泛洪 + 颜色容差"，只认颜色，没有前景/背景的语义分离 ——
/// 浅色主体落在浅底上时会被一路吃光（用户报的「消除背景把图标里面东西
/// 一起消除了」）。
///
/// 新实现走 Photoshop 那条路：自动 trimap → 阿尔法求解 → 边缘去色。
/// 细节见 `matting` 模块文档。手动描边从"挡住泛洪"升级成"硬约束前景"，
/// 效果更确定。
pub fn remove_background(
    bytes: &[u8],
    tolerance: u32,
    keep: Option<&KeepMask>,
) -> Result<(Vec<u8>, usize, bool), String> {
    /* 把 KeepMask 摊平成按处理尺寸对齐的 bool 蒙版。
     *
     * ⚠ 对齐必须在**缩放之后**做：图可能已经被缩到 MAX_EDGE，而前端画蒙版用
     *   的是它自己那块 canvas 的尺寸。两处任何一处没对齐，保护区域就会整体
     *   偏移，用户看到的是"描了但还是被吃"。
     *
     * 这里先按原图尺寸算好（prepare 里的缩放比例是等比的，所以按比例投即可）。
     * 实现上：先 prepare 拿到目标尺寸，再把蒙版按比例采样过去。 */
    let prepared = crate::matting::prepare(bytes)?;
    let (w, h) = prepared.dimensions();
    let keep_mask: Option<Vec<bool>> = keep.and_then(|m| {
        if m.w == 0 || m.h == 0 || m.data.len() != (m.w as usize) * (m.h as usize) {
            return None;   // 形状对不上就当没描过（不因为蒙版坏了就整条失败）
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
        if any {
            win_log(&format!(
                "iconedit: 描边保护蒙版生效（{}×{} → {}×{}）",
                m.w, m.h, w, h
            ));
            Some(outv)
        } else {
            None
        }
    });

    /* ══ r80：优先走 AI 抠图（用户开了开关、模型就绪时）══
     *
     * 设计口径（用户原话）：「打开之后就会验证本地有没有这个模型，有的话就直接
     * 调用，没有的话那要下载」。所以这里的判断顺序是：
     *   开关开 → 运行时可加载 → 模型文件就绪 → **才走 AI**
     * 任何一步不满足，或推理过程出错，都**静默回退**下面的本地算法 ——
     * 用户不会拿到"点了没反应"，最差也只是回到 r79 的效果。
     *
     * 为什么 AI 成功之后**还要**走一遍本地流程：AI 只给 alpha，边缘像素的 RGB
     * 仍是"前景与背景的混合色"，不处理就是一圈白边。本地算法里的
     * `fit_background` 正好能算逐像素背景色，借它做去色最省事也最准。 */
    if let Some(m) = crate::iconedit_ai::try_ai(bytes, keep_mask.as_deref()) {
        win_log("iconedit: 走 AI 抠图");
        return Ok(m);
    }

    /* 迭代次数：窄带松弛的轮数。
     * 12 轮在这个尺寸下已经收敛（再多肉眼无差别），而它只作用于窄带，
     * 实测 512×512 的复杂图标约 40~80ms。 */
    let iterations = 12u32;
    /* ⚠ trim = **false**：输出尺寸必须与原图一致。
     *
     * 为什么不做"抠完裁掉四周空白"：编辑器的价值有一半在**前后对比**，
     * 两张图尺寸不同会让用户觉得"怎么变小了/变形了"。而且裁切会改变坐标，
     * 任何按原坐标做的检查（包括探针与单测）都会错位。
     * 视觉上的"填满格子"由前端已有的光学尺寸归一（`--qs-optical`）负责，
     * 不需要在这里动刀。 */
    let m = crate::matting::matte(bytes, tolerance, keep_mask.as_deref(), iterations, false)?;
    win_log(&format!(
        "iconedit: matting 完成 —— 抠掉 {} 像素，trimap(前景/背景/待定)={:?}，无背景={}",
        m.removed, m.tri_counts, m.no_background
    ));
    let png = crate::matting::encode_png(&m.rgba)?;
    Ok((png, m.removed, m.no_background))

}
#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    /// 红底 + 居中白色圆（半径 20）的 64×64 图 —— 消除背景的靶子。
    ///
    /// r79：圆的边缘做成**抗锯齿**（按到圆心的距离在前景/背景色之间线性混合）。
    /// 为什么改：原来的实现是硬边（`d <= 20` 二值），而真实图标一律带抗锯齿。
    /// 拿硬边图去测"边缘过渡是否平滑"，要么测不到东西、要么得到假失败
    /// （`边界像素应当有过渡，实际 255` 就是这么来的）。
    /// 用抗锯齿图，测的才是真行为：混合像素被正确解混成中间 alpha。
    fn target() -> RgbaImage {
        let mut img = RgbaImage::new(64, 64);
        let fg: [f64; 3] = [255.0, 255.0, 255.0];
        let bg: [f64; 3] = [220.0, 30.0, 30.0];
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            let d = (dx * dx + dy * dy).sqrt();
            // 半径 20，边缘 1.5px 内线性过渡 —— 与真实抗锯齿图标同理
            let a = ((20.0 + 1.5 - d) / 1.5).clamp(0.0, 1.0);
            *p = Rgba([
                (bg[0] + (fg[0] - bg[0]) * a) as u8,
                (bg[1] + (fg[1] - bg[1]) * a) as u8,
                (bg[2] + (fg[2] - bg[2]) * a) as u8,
                255,
            ]);
        }
        img
    }

    fn png_of(img: &RgbaImage) -> Vec<u8> {
        let mut v = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut v, image::ImageFormat::Png)
            .unwrap();
        v.into_inner()
    }

    fn alpha_at(bytes: &[u8], x: u32, y: u32) -> u8 {
        let img = image::load_from_memory(bytes).unwrap().to_rgba8();
        img.get_pixel(x, y)[3]
    }

    #[test]
    fn removes_solid_background_keeps_subject() {
        let (out, removed, _) = remove_background(&png_of(&target()), 48, None).unwrap();
        assert!(removed > 2500, "红底应被成片抠掉，实际 {removed}");
        // 四角是背景 → 全透
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63), (2, 2)] {
            assert_eq!(alpha_at(&out, x, y), 0, "({x},{y}) 应透明");
        }
        // 圆心是主体 → 不透
        assert_eq!(alpha_at(&out, 32, 32), 255);
        // 主体内部（离边缘远，不吃羽化）必须全实
        assert_eq!(alpha_at(&out, 32, 25), 255);
        /* r79：主体上沿**贴着背景**的那一圈，新算法会给一个**平滑的过渡**
         * （alpha 从 1 渐降到 0），这是它比旧算法强的地方 —— 旧算法那里是
         * 硬邦邦的二值边界。所以断言改成"圆内一点点仍基本不透明"，
         * 而不是"边缘像素必须 > 100"。
         * 圆心 31.5、半径 20 → y=14 处离圆心 17.5，稳稳在圆内。 */
        assert!(
            alpha_at(&out, 32, 14) > 200,
            "主体上沿内侧应当基本不透明，实际 {}",
            alpha_at(&out, 32, 14)
        );
        /* 而真正的边界应当有**过渡**。抗锯齿的设计是：
         * 半径 20、过渡带 [18.5, 21.5]（宽度 1.5px）。取带**正中**的位置
         * 才最接近 α=0.5 —— 即离圆心 20.0 处。
         * 圆心 y=31.5 ⇒ y = 31.5 - 20 = 11.5 ⇒ 取整 11 或 12。 */
        let edge_a = alpha_at(&out, 32, 12);
        let edge_b = alpha_at(&out, 32, 11);
        assert!(
            edge_a < 250 || edge_b < 250,
            "边界像素应当有过渡（不是硬切），实际 a(y=12)={edge_a} a(y=11)={edge_b}"
        );
    }

    #[test]
    fn tolerance_zero_still_removes_exact_color() {
        let (out, removed, _) = remove_background(&png_of(&target()), 0, None).unwrap();
        assert!(removed > 2500);
        assert_eq!(alpha_at(&out, 0, 0), 0);
        assert_eq!(alpha_at(&out, 32, 32), 255);
    }

    #[test]
    fn tight_tolerance_keeps_gradient_background() {
        // 横向渐变底（每列一个色）：容差 8 时相邻列差 4 仍在泛洪路径上
        // （泛洪穿过"像背景"的像素，容差只决定起点邻域能走多远），
        // 但**颜色完全不像起点**的主体仍必须活下来。
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            *p = if dx * dx + dy * dy <= 15.0 * 15.0 {
                Rgba([0, 0, 0, 255])
            } else {
                Rgba([(x * 4) as u8, 128, 200, 255])
            };
        }
        let (out, removed, _) = remove_background(&png_of(&img), 8, None).unwrap();
        assert_eq!(alpha_at(&out, 32, 32), 255, "主体必须保留");
        assert_eq!(alpha_at(&out, 0, 0), 0, "起点色必须抠掉");
        assert!(removed > 100);
    }

    #[test]
    fn already_transparent_is_noop() {
        let mut img = RgbaImage::new(32, 32);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 15.5;
            let dy = y as f64 - 15.5;
            *p = if dx * dx + dy * dy <= 10.0 * 10.0 {
                Rgba([10, 200, 90, 255])
            } else {
                Rgba([0, 0, 0, 0])
            };
        }
        let (out, removed, _) = remove_background(&png_of(&img), 48, None).unwrap();
        assert_eq!(removed, 0, "已经透明的图不该再抠任何像素");
        assert_eq!(alpha_at(&out, 16, 16), 255, "主体原样保留");
        assert_eq!(alpha_at(&out, 0, 0), 0);
    }

    /* r79：这条测试**语义反了**，必须修正 —— 它是"当时的实现"写出来的，
     * 不是用户要的。
     *
     * 原断言：甜甜圈中心的红底"要留下"（理由是"与四边不相连"）。
     * 但用户要的是「**仅保留主体部分**」（模块开头引的原话）。中心那块
     * 红色与四角的底色**完全同色**，它就是背景，凭什么因为它被围住就不抠？
     *
     * 实测证据：`tools/r79-matting-visual.js` 的甜甜圈一格，旧实现抠完
     * 中心留了一块**突兀的白方块** —— 把那张对照图给人看，没人会说那是对的。
     *
     * 所以现在的口径：**背景必须与图像边界连通**（Photoshop 魔术棒的
     * Contiguous 语义）。甜甜圈中心走不到边界 → 它不是"外围背景"，
     * 但它是**被主体包住的同色区域** —— 交给 matting 按颜色判：
     * 它与背景色一样，于是被抠掉。这才是"仅保留主体"。
     *
     * ⚠ 真正的"主体内部镂空"（比如字母 O 的中间、图标里挖空的图案）是
     *   **主体自己的一部分**（颜色与主体相同），不会被抠 —— 见下面新增的
     *   `主体内部的同色区域仍然保留`。 */
    #[test]
    fn 环形主体中心的同色底色会被抠掉() {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            let d = (dx * dx + dy * dy).sqrt();
            *p = if (14.0..=24.0).contains(&d) {
                Rgba([255, 255, 255, 255])   // 白环 = 主体
            } else {
                Rgba([220, 30, 30, 255])     // 红底（中心与四角同色）
            };
        }
        let (out, _, _) = remove_background(&png_of(&img), 48, None).unwrap();
        assert_eq!(alpha_at(&out, 32, 32 - 19), 255, "白环（主体）必须留下");
        assert_eq!(alpha_at(&out, 32, 32), 0, "中心的红底与四角同色，该抠掉");
        assert_eq!(alpha_at(&out, 0, 0), 0, "四角的红底要抠掉");
    }

    /// 主体**自己**内部的同色区域必须保留 —— 和上面那条的区别：
    /// 这里的颜色是**主体的颜色**，不是背景色。
    #[test]
    fn 主体内部的同色区域仍然保留() {
        // 实心白圆（颜色与背景不同）：圆心是主体自己的内部，必须留。
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            let d = (dx * dx + dy * dy).sqrt();
            *p = if d <= 24.0 {
                Rgba([255, 255, 255, 255])   // 白色主体（内部同色）
            } else {
                Rgba([220, 30, 30, 255])     // 红底
            };
        }
        let (out, _, _) = remove_background(&png_of(&img), 48, None).unwrap();
        assert_eq!(alpha_at(&out, 32, 32), 255, "主体内部的同色区域必须保留");
        assert_eq!(alpha_at(&out, 0, 0), 0, "四角红底该抠掉");
    }

    #[test]
    fn oversized_image_is_downscaled() {
        let mut img = RgbaImage::new(600, 400);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = if x < 590 && y < 390 {
                Rgba([255, 255, 255, 255])
            } else {
                Rgba([0, 0, 0, 255])
            };
        }
        let (out, _, _) = remove_background(&png_of(&img), 48, None).unwrap();
        let got = image::load_from_memory(&out).unwrap();
        assert_eq!(got.width(), 512);
        assert!(got.height() < 512, "短边按比例缩，实际 {}", got.height());
    }

    #[test]
    fn garbage_input_errors() {
        assert!(remove_background(b"not an image at all", 48, None).is_err());
        assert!(remove_background(&[], 48, None).is_err());
    }

    #[test]
    fn tiny_image_errors() {
        let img = RgbaImage::new(1, 1);
        assert!(remove_background(&png_of(&img), 48, None).is_err());
    }

    /* ---------------- r77：手动描边保护 ---------------- */

    /// 造一张"浅色主体落在浅色底上"的图 —— 这正是描边要救的场景：
    /// 不描的话泛洪会从边缘一路吃进主体（颜色判据分不开）。
    fn low_contrast_icon() -> RgbaImage {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            // 底 #F8F8F8，主体 #E8E8E8 —— 只差 16，容差 48 时必然被当成底
            let inside = (20..44).contains(&x) && (20..44).contains(&y);
            *p = if inside {
                Rgba([0xE8, 0xE8, 0xE8, 255])
            } else {
                Rgba([0xF8, 0xF8, 0xF8, 255])
            };
        }
        img
    }

    /* r79：这条测试**必须换口径** —— 它原本钉的是"旧算法的失败"。
     *
     * 旧算法（颜色泛洪）下：浅色主体会被一起吃掉，所以断言 `alpha == 0`。
     * 新算法（matting）下：**主体应当被保住**，`alpha == 0` 反而是 bug。
     *
     * 现在这条测试的价值反过来了：它成了"新算法修好了用户报的那个 bug"的
     * 回归证明 —— 底 #F8F8F8 与主体 #E8E8E8 只差 16，任何只看颜色的算法都会
     * 失败，而自动 trimap 靠"到边界的距离 + 前景/背景色分离"能分开。 */
    #[test]
    fn 浅色主体落在浅底上现在能保住() {
        let img = low_contrast_icon();
        let (out, _removed, _) = remove_background(&png_of(&img), 48, None).unwrap();
        assert_eq!(
            alpha_at(&out, 32, 32),
            255,
            "浅色主体中心必须保住 —— 这正是旧算法出错、r79 修好的地方"
        );
        assert_eq!(alpha_at(&out, 2, 2), 0, "四角是背景，该被抠掉");
    }

    #[test]
    fn 描边保护挡住泛洪主体就保住了() {
        let img = low_contrast_icon();
        // 在主体外围描一圈（粗笔）：坐标是 64×64 网格
        let mut data = vec![0u8; 64 * 64];
        for y in 0..64u32 {
            for x in 0..64u32 {
                let on_ring = (18..46).contains(&x) && (18..46).contains(&y)
                    && !((22..42).contains(&x) && (22..42).contains(&y));
                if on_ring {
                    data[(y * 64 + x) as usize] = 255;
                }
            }
        }
        let mask = KeepMask { w: 64, h: 64, data };
        let (out, _removed, _) = remove_background(&png_of(&img), 48, Some(&mask)).unwrap();
        // 关键断言：主体中心**活下来了**
        assert_eq!(
            alpha_at(&out, 32, 32),
            255,
            "描边保护之后主体中心必须还是不透明的"
        );
        // 而描边圈外面（真正连到四边的底色）仍然被抠掉
        assert_eq!(alpha_at(&out, 2, 2), 0, "四角是底色，还是该抠掉");
    }

    /// 蒙版尺寸和处理尺寸不一致时（前端画布 ≠ 原图），要按比例投过去，
    /// 不能整块错位、也不能因为形状对不上就把整条命令判失败。
    #[test]
    fn 蒙版尺寸不同也能按比例投过去() {
        let img = low_contrast_icon();
        // 蒙版用 32×32（原图 64×64）：主体大概在 10..22
        let mut data = vec![0u8; 32 * 32];
        for y in 0..32u32 {
            for x in 0..32u32 {
                let on_ring = (9..23).contains(&x) && (9..23).contains(&y)
                    && !((11..21).contains(&x) && (11..21).contains(&y));
                if on_ring {
                    data[(y * 32 + x) as usize] = 255;
                }
            }
        }
        let mask = KeepMask { w: 32, h: 32, data };
        let (out, _, _) = remove_background(&png_of(&img), 48, Some(&mask)).unwrap();
        assert_eq!(
            alpha_at(&out, 32, 32),
            255,
            "蒙版缩放之后主体中心仍须保住"
        );
    }

    /// 形状对不上的坏蒙版（长度 ≠ w*h）→ 当没描过，走老路，**不能报错**。
    #[test]
    fn 坏蒙版退回不保护而不是报错() {
        let img = low_contrast_icon();
        let bad = KeepMask { w: 10, h: 10, data: vec![255u8; 3] };
        let r = remove_background(&png_of(&img), 48, Some(&bad));
        assert!(r.is_ok(), "坏蒙版不该让整条命令失败");
        let (out, _, _) = r.unwrap();
        /* r79：这条断言换算法后**必须换口径**。
         * 旧算法下"坏蒙版 = 没保护"会把浅色主体一起吃掉（alpha=0）；
         * 新算法（matting）对浅色主体本身就能保住，所以不能再用"主体被吃"
         * 来证明"蒙版被忽略"。改为验证真正关心的事：不报错、能正常出图。 */
        let dim = image::load_from_memory(&out).unwrap().to_rgba8().dimensions();
        assert!(dim.0 >= 2 && dim.1 >= 2, "坏蒙版也要能正常出图（{}×{}）", dim.0, dim.1);
    }

    /// 全零蒙版（用户进了描边模式但一笔没画）→ 等价于没保护。
    ///
    /// r79：口径同 `浅色主体落在浅底上现在能保住` —— 空蒙版下走纯自动流程，
    /// 新算法能把浅色主体保住，所以断言"主体还在"。
    #[test]
    fn 空蒙版等价于没描过() {
        let img = low_contrast_icon();
        let mask = KeepMask { w: 64, h: 64, data: vec![0u8; 64 * 64] };
        let (out, _, _) = remove_background(&png_of(&img), 48, Some(&mask)).unwrap();
        assert_eq!(alpha_at(&out, 32, 32), 255, "空蒙版 = 全自动，主体仍应保住");
        assert_eq!(alpha_at(&out, 2, 2), 0, "四角该被抠掉");
    }

}