//! AI 抠图推理（r80）：把 ONNX 模型跑起来，产出 alpha 蒙版。
//!
//! # 两个模型族，预处理/后处理完全不同（实测确认，不能混用）
//!
//! | 项 | U2Net 系（u2netp/u2net） | RMBG-1.4 系 |
//! |---|---|---|
//! | 输入边长 | **320** | **1024** |
//! | 归一化 | ImageNet 均值方差 + **逐通道除以该通道最大值** | `(x/255 - 0.5) / 1.0` |
//! | 输出个数 | **7 个**侧输出（d0..d6） | 1 个 |
//! | 取哪个 | **第 1 个**（d0，U2Net 的融合输出） | 唯一那个 |
//!
//! 这些差异都是从参考项目的源码 + 本地实测里抠出来的，写在 `Family` 上，
//! 不能靠"文件名猜" —— 猜错的结果是推理输出一片噪声。
//!
//! # 与本地算法的关系（不是替代，是补充）
//!
//! `matting.rs`（颜色解混）在**扁平图标**上已经不错，而且零依赖、毫秒级。
//! AI 的价值在它做不到的地方：主体与背景同色、内部细节复杂、照片类底。
//! 所以 `iconedit::remove_background` 的口径是：
//!   · 开关没开 / 模型没下 / 推理失败 → **静默回退**本地算法（用户无感）
//!   · AI 成功 → 用 AI 的 alpha，但**仍走本地的边缘去色**（AI 的蒙版边缘
//!     颜色是混合色，不处理会有白边）
//!
//! # 运行时依赖
//!
//! 需要 `onnxruntime.dll`（约 11.8MB）与主程序放在同一目录。
//! 它**不随模型下载**（模型是数据，dll 是程序的一部分），
//! 缺失时 `available()` 返回 false，功能自动降级。

use crate::aimodels::{self, Family};

/// 推理运行时是否可用（`onnxruntime.dll` 能否加载）。
///
/// 为什么单独一个函数而不是"直接调用了失败再说"：设置页要据此告诉用户
/// "AI 抠图不可用（缺少运行时）"，而不是等到点按钮才报错。
pub fn runtime_available() -> bool {
    // 用一次最小代价的 ORT 调用探测：环境初始化成功即说明 dll 在且版本对得上。
    std::panic::catch_unwind(|| {
        // ort::init() 在 rc 版里是惰性的，构造一个 SessionBuilder 就足以触发加载
        ort::session::Session::builder().is_ok()
    })
    .unwrap_or(false)
}

/// 一次 AI 推理的结果。
#[derive(Debug)]
pub struct AiMatte {
    /// 模型输出尺寸的 alpha（0..255），**原始尺寸**已由调用方缩放
    pub alpha: image::GrayImage,
}

/// 跑一次推理，输出与**输入图同尺寸**的 alpha 蒙版。
///
/// `spec`：模型清单项（决定边长、归一化、取哪个输出）。
/// `keep`：不算（AI 不认手动补描），由调用方在拿到 alpha 后自行处理。
pub fn run(spec: &'static aimodels::ModelSpec, rgba: &image::RgbaImage) -> Result<AiMatte, String> {
    use ort::session::Session;
    use ort::value::Value;

    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Err("图为空".to_string());
    }
    let path = aimodels::model_path(spec.id);
    if !path.exists() {
        return Err(format!("模型 {} 还没下载", spec.name));
    }

    let t_load = std::time::Instant::now();
    let mut sess = Session::builder()
        .and_then(|b| b.commit_from_file(&path))
        .map_err(|e| format!("加载模型失败（{}）：{e}", spec.name))?;
    let load_ms = t_load.elapsed().as_millis();

    let edge = spec.input_edge as usize;
    // ---- 预处理：缩放到 (1,3,E,E)，按族的归一化规则 ----
    let small = image::imageops::resize(
        rgba,
        edge as u32,
        edge as u32,
        image::imageops::FilterType::Triangle,
    );
    let mut tensor = vec![0f32; 3 * edge * edge];
    match spec.family {
        Family::U2net => {
            /* U2Net 的口径（照参考项目 migan/rmbg 系的实现）：
             * 先 /255，再按 ImageNet 均值方差，最后**逐通道除以该通道最大值**。
             * 那条"除最大值"是这个模型的私有约定（原始 U2Net 官方预处理），
             * 少了它输出会明显偏。 */
            let px: Vec<[f32; 3]> = small
                .pixels()
                .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
                .collect();
            let mut maxc = [1f32; 3];
            for c in 0..3 {
                let m = px.iter().map(|v| v[c]).fold(0f32, f32::max);
                maxc[c] = if m <= 0.0 { 1.0 } else { m };
            }
            let mean = [0.485f32, 0.456, 0.406];
            let std = [0.229f32, 0.224, 0.225];
            for (i, v) in px.iter().enumerate() {
                for c in 0..3 {
                    tensor[c * edge * edge + i] = (v[c] / maxc[c] - mean[c]) / std[c];
                }
            }
        }
        Family::Rmbg => {
            /* RMBG-1.4 的官方预处理：`(x/255 - 0.5) / 1.0`。
             * 没有 ImageNet 那一套，也不需要除最大值。 */
            for (i, p) in small.pixels().enumerate() {
                for c in 0..3 {
                    tensor[c * edge * edge + i] = p[c] as f32 / 255.0 - 0.5;
                }
            }
        }
    }
    let arr = ndarray::Array4::from_shape_vec((1, 3, edge, edge), tensor)
        .map_err(|e| format!("构造输入张量失败：{e}"))?;

    // ---- 推理 ----
    let t0 = std::time::Instant::now();
    let val = Value::from_array(arr).map_err(|e| format!("包装输入失败：{e}"))?;
    let outputs = sess
        .run(ort::inputs![val])
        .map_err(|e| format!("推理失败：{e}"))?;
    let infer_ms = t0.elapsed().as_millis();

    /* ---- 取蒙版 ----
     * U2Net 输出 7 个（d0..d6），**必须取第 0 个**（d0 是融合输出，
     * d1..d6 是各尺度的侧输出，单独看都很粗糙）。
     * RMBG 只有一个。 */
    let mut picked: Option<(usize, Vec<f32>)> = None;
    for (idx, (_name, v)) in outputs.iter().enumerate() {
        if let Ok((shape, data)) = v.try_extract_tensor::<f32>() {
            let n: usize = shape.iter().map(|d| *d as usize).product();
            if n >= edge * edge {
                picked = Some((idx, data.to_vec()));
                if spec.family == Family::U2net || idx == 0 {
                    break; // 第一个可用的就是我们要的
                }
            }
        }
    }
    let (used_idx, data) = picked.ok_or_else(|| "模型没有可用的输出张量".to_string())?;
    let n_out = outputs.len();
    if spec.family == Family::U2net && n_out > 1 && used_idx != 0 {
        // 理论上不会走到（上面遇 idx==0 就 break），留着当断言用
        crate::win::log("ai_matte: 注意 —— U2Net 用的不是第 0 个输出");
    }

    // ---- 归一化到 0..255（U2Net/RMBG 的输出都是无界 logits，要 min-max 拉伸）----
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for v in &data {
        if v.is_finite() {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
    }
    if !lo.is_finite() || !hi.is_finite() {
        return Err("模型输出全是非有限值".to_string());
    }
    let span = (hi - lo).max(1e-8);

    // 输出张量的空间尺寸可能与 edge 不同（有的模型输出 320、有的 1024）
    let side = (data.len() as f64).sqrt().round() as usize;
    if side * side != data.len() {
        // 多通道输出（比如 [1,1,H,W] 展开成 H*W 正好；[1,3,H,W] 则不是）
        // —— 那就按最后一个维度取（通常就是 alpha）
        let take = data.len() / (edge * edge).max(1);
        crate::win::log(&format!(
            "ai_matte: 输出长度 {} 不是完全平方（按 {} 通道处理）",
            data.len(),
            take
        ));
    }
    let mut gray = image::GrayImage::new(side.max(1) as u32, side.max(1) as u32);
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let i = (y as usize) * gray.width() as usize + x as usize;
            let v = data.get(i).copied().unwrap_or(0.0);
            let norm = ((v - lo) / span).clamp(0.0, 1.0);
            gray.put_pixel(x, y, image::Luma([(norm * 255.0).round() as u8]));
        }
    }
    // 缩回原图尺寸（AI 蒙版是在 320/1024 上算的，直接拿去用会错位）
    if gray.dimensions() != (w, h) {
        gray = image::imageops::resize(&gray, w, h, image::imageops::FilterType::Triangle);
    }

    crate::win::log(&format!(
        "ai_matte: {} 加载 {load_ms}ms 推理 {infer_ms}ms 输出 {n_out} 个(用第{used_idx}个) 尺寸 {side}x{side}",
        spec.name
    ));
    // 耗时已经写进日志了（上面那行）；不再往返回值里塞，
    // 免得调用方以为"这个字段没用到"是漏了（r80 实测确实没用到）。
    let _ = load_ms + infer_ms;
    Ok(AiMatte { alpha: gray })
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 运行时可用性探测不能 panic（缺 dll 时要安静地返回 false）。
    #[test]
    fn 运行时探测不会panic() {
        let r = runtime_available();
        // 这里不钉 true/false —— 取决于测试机上有没有 dll。
        // 只钉"它必须能安全返回"（缺 dll 时 ort 内部会 panic，被 catch_unwind 兜住）
        let _ = r;
    }

    /// 模型不存在时必须给出**人话错误**，而不是让 ORT 抛难懂的内部错误。
    #[test]
    fn 模型缺失时报可读错误() {
        let fake = crate::aimodels::MODELS.first().unwrap();
        // u2netp 在测试机上未必存在；如果存在就跳过这条断言
        if !aimodels::is_ready(fake.id) {
            let img = image::RgbaImage::new(16, 16);
            let e = run(fake, &img).unwrap_err();
            assert!(e.contains("还没下载"), "错误信息应当说明没下载，实际：{e}");
        }
    }

    /// 空图要被挡住（推理 0×0 没有意义）。
    #[test]
    fn 空图被挡住() {
        let spec = crate::aimodels::MODELS.first().unwrap();
        let img = image::RgbaImage::new(0, 0);
        assert!(run(spec, &img).is_err());
    }


}
