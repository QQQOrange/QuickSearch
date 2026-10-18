//! AI 抠图 × 本地算法的**胶水层**（r80）。
//!
//! 为什么单独一个文件：`aimatte.rs` 只管"跑模型出 alpha"，`matting.rs` 只管
//! "颜色解混"，而**两者要配合**才有好结果 —— 这个配合逻辑放这里，
//! 让那两个模块各自保持纯粹（可单测、无交叉依赖）。
//!
//! # 配合方式（以及为什么必须配合）
//!
//! AI 的强项是**语义**：它知道"这是主体、那是背景"，所以能处理本地算法
//! 数学上无解的情况（主体与背景同色、内部细节复杂、照片类底）。
//!
//! AI 的弱项是**边缘**：它输出的 alpha 分辨率低（320 或 1024），且边缘像素的
//! RGB 还是"前景与背景的混合色" —— 直接拿去用就是一圈白边/脏边。
//!
//! 所以流程是：
//! ```text
//!   ① AI 出 alpha（低分辨率 → 缩回原尺寸）
//!   ② 用 AI 的 alpha **帮助**本地算法判前景/背景
//!      （AI 说有主体的地方，本地就不再"只看颜色"了）
//!   ③ 本地算法做边缘：逐像素背景色拟合 + 混合像素去色
//! ```
//!
//! 手动补描（`keep`）在这里也要生效：用户描过的区域**无条件**是前景，
//! 哪怕 AI 说它是背景 —— 手动干预的优先级永远最高。

use crate::aimodels;
use crate::matting::{self, Tri};

/// 若条件满足则走 AI 抠图，返回 `Some((png 字节, 抠掉像素数, 无背景))`；
/// 条件不满足或推理失败返回 `None`（调用方接着走本地算法）。
///
/// 这个函数**永不返回 Err** —— 它的契约是"AI 能用就用，不能用就算了"。
/// 为什么：AI 是增强功能，失败不该让整个"抠图"操作失败。用户点了按钮
/// 就该看到结果，哪怕是本地算法的结果。
pub fn try_ai(bytes: &[u8], keep: Option<&[bool]>) -> Option<(Vec<u8>, usize, bool)> {
    // ---- 1. 三道门槛：开关 / 运行时 / 模型 ----
    /* ⚠ 读配置时必须容忍"应用状态还没初始化"（单测环境就是这样）：
     * `st()` 在状态未就绪时会 panic（见 main.rs 的 `STATE.get().expect(...)`）。
     * 这个函数的契约是"永不报错、永不 panic"，所以用 `try_st()` 拿 Option，
     * 拿不到就当关闭处理、回退本地算法。 */
    let s = crate::try_st()?;
    let cfg = s.cfg.lock().ok()?;
    let (enabled, model_id) = (cfg.ai_matting_enable, cfg.ai_matting_model.clone());
    drop(cfg);
    if !enabled {
        return None;
    }
    let id = if model_id.trim().is_empty() {
        aimodels::default_id().to_string()
    } else {
        model_id
    };
    let spec = aimodels::find(&id)?;
    if !aimodels::is_ready(&id) {
        crate::win::log(&format!("iconedit_ai: 模型 {} 还没下载，回退本地算法", spec.name));
        return None;
    }
    if !crate::aimatte::runtime_available() {
        crate::win::log("iconedit_ai: 推理运行时不符，回退本地算法");
        return None;
    }

    // ---- 2. 准备图（与本地算法同一套缩放，保证坐标一致）----
    let rgba = match matting::prepare(bytes) {
        Ok(r) => r,
        Err(e) => {
            crate::win::log(&format!("iconedit_ai: 解图失败 {e}"));
            return None;
        }
    };
    let (w, h) = rgba.dimensions();
    if w < 2 || h < 2 {
        return None;
    }
    // 补描蒙版摊平到当前尺寸（与 iconedit::remove_background 同口径）
    let keep_slice: Option<Vec<bool>> = keep.map(|k| {
        let n = (w as usize) * (h as usize);
        if k.len() < n {
            let mut v = k.to_vec();
            v.resize(n, false);
            v
        } else {
            k[..n].to_vec()
        }
    });

    // ---- 3. 推理 ----
    let t0 = std::time::Instant::now();
    let ai = match crate::aimatte::run(spec, &rgba) {
        Ok(a) => a,
        Err(e) => {
            crate::win::log(&format!("iconedit_ai: 推理失败（{e}），回退本地算法"));
            return None;
        }
    };
    let ai_ms = t0.elapsed().as_millis();

    /* ---- 4. 用 AI 的 alpha 定 trimap —— 但要**和本地算法互补** ----
     *
     * 本地颜色解混需要一个 trimap（哪些确定是前景、确定是背景、哪些说不准）。
     * 平时它靠**颜色**猜（`build_trimap`），但主体与背景同色时颜色猜不出来 ——
     * AI 恰好擅长这件事，所以让 AI 来定。
     *
     * # ⚠ 第一版口径错了（实测 10 个真实图标后修正）
     *
     * 第一版是"AI alpha ≥ 240 → 前景；≤ 15 → 背景"—— **无条件信任 AI**。
     * 实测对比（`tools/r80-ai-visual.js`）结果对半开，而且失败模式完全一致：
     *   · IGN：中心被挖空        · GOG：左上角挖出白洞
     *   · Apple_Music：音符内部残留红色  · Codeberg：几乎全空
     * 共同点是 **AI 把主体内部的封闭区域判成了背景**。
     *
     * 这正是本地算法的强项：它按**连通性**判断（只有能走到图像边界的同色区域
     * 才算背景，见 `matting::build_trimap` 的连通性收束）—— 被主体围住的
     * 内部区域走不到边界，本地会说"这不是背景"。
     *
     * 所以改成**互补**（各自发挥强项）：
     *   · AI 说**前景**（alpha 高）→ 无条件前景（AI 的语义判断这里最可信）
     *   · AI 说**背景**（alpha 低）→ **还要本地颜色也认为像背景**才算确定背景；
     *     否则降为 Unknown 交给本地连通性/解混去判
     *   · 中间值        → Unknown（边缘带，本来就要解混）
     *   · 手动补描      → 无条件前景（优先级最高）
     *
     * 这样 AI 的语义能力负责"找到主体"，本地的连通性负责"别把主体内部掏空"。 */
    // 先算一份**纯本地的 trimap**作为"本地意见"
    let local_samples = matting::estimate_background(&rgba);
    let (local_tri, _) = matting::build_trimap(&rgba, &local_samples, 48, keep_slice.as_deref());

    let tri: Vec<Tri> = (0..(w as usize) * (h as usize))
        .map(|i| {
            if keep_slice.as_ref().map(|k| k[i]).unwrap_or(false) {
                return Tri::Fg;
            }
            let x = (i % w as usize) as u32;
            let y = (i / w as usize) as u32;
            let a = ai.alpha.get_pixel(x, y)[0];
            if a >= 240 {
                // AI 很确信是主体 → 直接采用（这是它最擅长的判断）
                Tri::Fg
            } else if a <= 15 {
                /* AI 说是背景 —— 但**本地也同意**才算数。
                 * 本地说"像背景"（Tri::Bg）或"说不准"（Tri::Unknown）都放行；
                 * 只有本地**明确说是前景**时才驳回，降为 Unknown 让它再判一次。 */
                match local_tri[i] {
                    // 本地也说是背景 → 确定背景
                    Tri::Bg => Tri::Bg,
                    /* 本地说"说不准"或"是前景" → 不轻信 AI，
                     * 交给本地解混/连通性（这正是修掉"挖空"的地方） */
                    _ => Tri::Unknown,
                }
            } else {
                Tri::Unknown
            }
        })
        .collect();

    let mut fg = 0;
    let mut bg = 0;
    let mut unk = 0;
    for t in &tri {
        match t {
            Tri::Fg => fg += 1,
            Tri::Bg => bg += 1,
            Tri::Unknown => unk += 1,
        }
    }

    // ---- 5. 交给本地算法做边缘（解混 + 去色）----
    let mut work = rgba.clone();
    let alpha = matting::solve_alpha(&mut work, &tri, keep_slice.as_deref());
    let removed = matting::apply_alpha(&mut work, &alpha);
    crate::win::log(&format!(
        "iconedit_ai: {} 推理 {ai_ms}ms trimap(前景/背景/待定)=({fg},{bg},{unk}) 抠掉 {removed}",
        spec.name
    ));

    let png = match matting::encode_png(&work) {
        Ok(p) => p,
        Err(e) => {
            crate::win::log(&format!("iconedit_ai: 编码失败 {e}"));
            return None;
        }
    };
    // no_background：AI 都分不出来的话，谁也没办法。判据是"前景几乎为零"
    let no_bg = fg * 20 < fg + bg + unk;
    Some((png, removed, no_bg))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **契约测试**：这个函数的签名决定了它"永不报错" ——
    /// 任何异常都要返回 None 让调用方回退，绝不能 panic 或 Err。
    #[test]
    fn 任何情况下都不panic() {
        // 开关默认是关的，所以这里必然是 None（且不该 panic）
        let img = image::RgbaImage::new(8, 8);
        let png = matting::encode_png(&img).unwrap();
        let r = try_ai(&png, None);
        assert!(r.is_none(), "开关默认关，不该走 AI");
    }

    /// 坏输入也不能 panic（要走回退）。
    #[test]
    fn 坏输入返回none() {
        assert!(try_ai(b"not an image", None).is_none());
        assert!(try_ai(&[], None).is_none());
    }

    /// 带补描蒙版时也不能 panic（蒙版长度可能与图不符）。
    #[test]
    fn 蒙版长度不符也安全() {
        let img = image::RgbaImage::new(4, 4);
        let png = matting::encode_png(&img).unwrap();
        let keep = vec![true; 3]; // 明显太短
        assert!(try_ai(&png, Some(&keep)).is_none());
    }
}
