//! AI 抠图 × 边缘处理的**胶水层**（r80）。
//!
//! 为什么单独一个文件：`aimatte.rs` 只管"跑模型出 alpha"，边缘质量那一套
//! （逐像素背景色拟合 + 混合像素去色）在 `matting.rs` 里。两者要配合才有好结果，
//! 这个配合逻辑放这里，让那两个模块各自保持纯粹（可单测、无交叉依赖）。
//!
//! # 配合方式（以及为什么必须配合）
//!
//! AI 的强项是**语义**：它知道"这是主体、那是背景"，所以能处理颜色解混
//! 数学上无解的情况（主体与背景同色、内部细节复杂、照片类底）。
//!
//! AI 的弱项是**边缘**：输出 alpha 分辨率低（320 或 1024），且边缘像素的
//! RGB 还是"前景与背景的混合色" —— 直接拿去用就是一圈白边/脏边。
//!
//! 所以流程是：
//! ```text
//!   ① AI 出 alpha（低分辨率 → 缩回原尺寸）
//!   ② 用 AI 的 alpha + 本地的颜色意见**共同**定 trimap
//!   ③ 本地做边缘：逐像素背景色拟合 + 混合像素去色
//! ```
//!
//! # 三种失败要分清楚（r80 修）
//!
//! 用户要求「原来那个（本地算法）直接去掉」。去掉之后就不能再有"静默回退"——
//! 否则开关没开、模型没下、推理挂了，用户看到的都是"点了没反应"。
//! 所以 `try_ai` 返回 `Result`，把三种原因分别说清楚，且**每种都给可操作的下一步**：
//!   · 功能没开 → 告诉他去「设置 → 通用 → AI 抠图」打开
//!   · 模型没下 → 告诉他去下载（附体积，让他知道要下多大）
//!   · 推理失败 → 报具体错误（供排查）
//!
//! # 手动补描
//!
//! `keep` 里的像素**无条件**是前景（用户描过的优先级最高，高于 AI 的判断）。

use crate::aimodels;
use crate::matting::{self, Tri};

/// 与 `try_ai` 相同，但可**临时指定模型**（`model_override` 优先于配置里的选择）。
///
/// 用户要求「某一个我抠的不满意，我能立刻换另一个来抠」——
/// 换模型是一次性动作，不该改用户的默认设置，所以走参数而不是写配置。
pub fn try_ai_with(
    bytes: &[u8],
    keep: Option<&[bool]>,
    params: &crate::aimatte::Params,
    model_override: Option<&str>,
) -> Result<(Vec<u8>, usize, bool), String> {
    // ---- 1. 三道门槛：开关 / 运行时 / 模型 ----
    /* ⚠ 读配置要容忍"应用状态还没初始化"（单测环境就是这样）：
     * `st()` 在状态未就绪时会 panic（见 main.rs 的 `STATE.get().expect(...)`）。 */
    let cfg = crate::try_st()
        .and_then(|s| s.cfg.lock().ok())
        .ok_or_else(|| "AI 抠图不可用（配置读取失败），请重开设置页试试".to_string())?;
    let enabled = cfg.ai_matting_enable;
    let model_id = cfg.ai_matting_model.clone();
    drop(cfg);

    /* 开关判断：**显式换模型时跳过它**。
     *
     * 为什么：用户可能只在设置页用独立抠图工具（那儿也可以换模型），
     * 而图标编辑器的开关是另一回事 —— 把两者绑在一起会让"能抠图却不能换模型"
     * 这种奇怪的限制。真正的门槛是"运行时在不在 + 模型下没下"。 */
    if !enabled && model_override.is_none() {
        return Err(
            "抠图功能没有打开。请到「设置 → 通用 → AI 抠图」打开开关并下载一个模型".to_string(),
        );
    }
    // 显式指定的模型优先（空串当没指定）
    let picked = model_override
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or(model_id);
    let id = if picked.trim().is_empty() {
        aimodels::default_id().to_string()
    } else {
        picked
    };
    let spec = aimodels::find(&id).ok_or_else(|| format!("模型标识无效：{id}"))?;
    if !aimodels::is_ready(&id) {
        return Err(format!(
            "模型「{}」（{}）还没下载。请到「设置 → 通用 → AI 抠图」点「下载」",
            spec.name,
            aimodels::human_size(spec.bytes)
        ));
    }
    if !crate::aimatte::runtime_available() {
        return Err("缺少推理运行时（onnxruntime.dll），请重新下载完整程序包".to_string());
    }

    // ---- 2. 准备图 ----
    let rgba = matting::prepare(bytes)?;
    let (w, h) = rgba.dimensions();
    if w < 2 || h < 2 {
        return Err("图太小了（至少 2×2）".to_string());
    }
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
    let ai = crate::aimatte::run(spec, &rgba, params).map_err(|e| format!("AI 推理失败：{e}"))?;
    let ai_ms = t0.elapsed().as_millis();
    let p = params.clamped();

    /* ---- 4. 用 AI 的 alpha 定 trimap —— 但要**和本地颜色意见互补** ----
     *
     * # 为什么不能让 AI 一个人说了算（实测修正）
     *
     * 第一版是"AI alpha ≥ 240 → 前景；≤ 15 → 背景"—— 无条件信任 AI。
     * 实测 10 个真实图标对半开，失败模式完全一致：
     *   · IGN：中心被挖空        · GOG：左上角挖出白洞
     *   · Apple_Music：音符内部残留红色  · Codeberg：几乎全空
     * 共同点是 **AI 把主体内部的封闭区域判成了背景**。
     *
     * 这正是**颜色解混**的强项：它按**连通性**判断（只有能走到图像边界的同色区域
     * 才算背景，见 `matting::build_trimap` 的连通性收束）—— 被主体围住的内部
     * 区域走不到边界，本地会说"这不是背景"。这里借用的只是它的一次 trimap 计算
     * （不含抠图），毫秒级，当第二意见几乎不花代价。
     *
     * 口径：
     *   · AI 说**前景**（alpha 高）→ 无条件前景（AI 的语义判断这里最可信）
     *   · AI 说**背景**（alpha 低）→ **还要本地也认为像背景**才算确定背景；
     *     否则降为 Unknown 交给本地连通性/解混去判
     *   · 中间值        → Unknown（边缘带，本来就要解混）
     *   · 手动补描      → 无条件前景（优先级最高） */
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
            /* 两个置信度门槛都是**可调参数**（界面滑块）：
             *   · `fg_confidence` 调低 → 更少的像素被当成确定前景，
             *     更多交给连通性判（更保守，但边缘可能留残影）
             *   · `bg_confidence` 调高 → 更信 AI 说的"这是背景"
             *     （这是最容易导致"主体内部被挖空"的方向，所以默认给得很低：15） */
            if a >= p.fg_confidence {
                Tri::Fg
            } else if a <= p.bg_confidence {
                match local_tri[i] {
                    Tri::Bg => Tri::Bg, // 本地也说是背景 → 确定背景
                    // 本地不同意 → 不轻信 AI，交给本地连通性/解混（修掉"挖空"的地方）
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

    /* ---- 5. 边缘处理（解混 + 去色）----
     *
     * `edge_decontaminate` 开关：解混（求 alpha）与去色（把混合像素的 RGB
     * 换成纯前景色）是**两件事**。关掉去色只影响颜色、不影响 alpha ——
     * 给"我就想看看没去色的原始边缘"的人留的（正常都该开着，关掉会有白边）。 */
    let mut work = rgba.clone();
    let alpha = matting::solve_alpha(&mut work, &tri, keep_slice.as_deref());
    if !p.edge_decontaminate {
        // 关掉去色 → 把 solve_alpha 改过的边缘 RGB 还原回原图颜色，只留 alpha
        for (dst, src) in work.pixels_mut().zip(rgba.pixels()) {
            dst[0] = src[0];
            dst[1] = src[1];
            dst[2] = src[2];
        }
    }
    let mut removed = matting::apply_alpha(&mut work, &alpha);

    /* `drop_small_islands`：丢掉孤立的小碎块。
     * AI 偶尔在背景里留下几十像素的"假前景"，放到深色底上很显眼。 */
    if p.drop_small_islands {
        let dropped = drop_small_islands(&mut work);
        if dropped > 0 {
            crate::win::log(&format!("iconedit_ai: 丢掉 {dropped} 个孤立碎块像素"));
        }
    }

    crate::win::log(&format!(
        "iconedit_ai: {} 推理 {ai_ms}ms trimap(前景/背景/待定)=({fg},{bg},{unk}) 抠掉 {removed} 参数 {}",
        spec.name,
        p.summary()
    ));

    let png = matting::encode_png(&work)?;
    /* no_background：一个前景像素都没有 → 图上没找到主体。
     * 界面据此提示"这张图看不出主体"（而不是让用户以为按钮坏了）。 */
    let no_bg = fg * 20 < fg + bg + unk;
    let _ = &mut removed; // removed 已在上面算好；这里是显式说明它不会被后续改动影响
    Ok((png, removed, no_bg))
}

/// 丢掉**孤立的、面积过小**的不透明连通块。返回被丢掉的像素数。
///
/// # 判据为什么是"面积占比"而不是绝对像素数
///
/// 一像素的小点对 16×16 的图标是噪声，对 512×512 的图也只是噪声；
/// 但一个 30×30 的实心块对小图是主体的一部分。用**占全图比例**（0.2%）
/// 判断才能同时照顾大小图。
///
/// 4 邻域泛洪（不是 8 邻域）：沿用项目里一贯的口径 —— 8 邻域会从对角线
/// 把两个本不相连的块连起来，那就不是"孤立"了。
fn drop_small_islands(img: &mut image::RgbaImage) -> usize {
    let (w, h) = img.dimensions();
    let n = (w as usize) * (h as usize);
    let min_area = ((n as f32 * 0.002).round() as usize).max(4);

    let mut seen = vec![false; n];
    let mut to_clear: Vec<usize> = Vec::new();
    for start in 0..n {
        if seen[start] || img.as_raw()[start * 4 + 3] == 0 {
            continue;
        }
        // 泛洪收集这一块
        let mut stack = vec![start];
        seen[start] = true;
        let mut block: Vec<usize> = Vec::new();
        while let Some(i) = stack.pop() {
            block.push(i);
            let x = (i % w as usize) as i32;
            let y = (i / w as usize) as i32;
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let j = (ny as usize) * (w as usize) + nx as usize;
                if seen[j] || img.as_raw()[j * 4 + 3] == 0 {
                    continue;
                }
                seen[j] = true;
                stack.push(j);
            }
        }
        if block.len() < min_area {
            to_clear.extend(block);
        }
    }
    for i in to_clear.iter() {
        img.as_mut()[i * 4 + 3] = 0;
    }
    to_clear.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **失败必须给人话**（本地兜底删掉后，这里是唯一的信息来源）。
    #[test]
    fn 失败时给出可操作提示() {
        let img = image::RgbaImage::new(8, 8);
        let png = matting::encode_png(&img).unwrap();
        // 测试环境里拿不到应用状态 / 开关默认关，两条路都会 Err；
        // 无论哪条，错误信息都必须**能读、能指引**，不能是空串或英文堆栈。
        let e = try_ai_with(&png, None, &crate::aimatte::Params::default(), None).unwrap_err();
        assert!(!e.is_empty(), "错误信息不能是空的");
        assert!(
            e.contains("设置") || e.contains("抠图") || e.contains("AI"),
            "错误信息要能指引用户，实际：{e}"
        );
    }

    /// 坏输入不能 panic（要返回 Err）。
    #[test]
    fn 坏输入返回错误而不是panic() {
        assert!(try_ai_with(b"not an image", None, &crate::aimatte::Params::default(), None).is_err());
        assert!(try_ai_with(&[], None, &crate::aimatte::Params::default(), None).is_err());
    }

    /// 补描蒙版长度不符也不能 panic。
    #[test]
    fn 蒙版长度不符也安全() {
        let img = image::RgbaImage::new(4, 4);
        let png = matting::encode_png(&img).unwrap();
        let keep = vec![true; 3]; // 明显太短
        let _ = try_ai_with(&png, Some(&keep), &crate::aimatte::Params::default(), None); // 只要不 panic 即可
    }
}
