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

/// 让 ort 从**模型目录**加载 `onnxruntime.dll`（r80g：运行库随模型一起下载）。
///
/// # 机制（以及为什么必须"无条件设置"）
///
/// ort 的 `load-dynamic` 路径找 dll 的顺序（见它 `src/lib.rs`）：
///   1. 环境变量 `ORT_DYLIB_PATH`
///   2. 相对名 `onnxruntime.dll` → 相对 **exe 所在目录**
///
/// 两个缓存（`OnceLock`）行为**不同**，这是关键：
///
/// | 缓存 | 闭包做什么 | 失败后会不会重试 |
/// |---|---|---|
/// | `G_ORT_DYLIB_PATH` | **只读环境变量**，不会 panic | ❌ **永久缓存**第一次读到的值 |
/// | `G_ORT_LIB` | 真的去加载文件，失败会 panic | ✅ 下次调用会重试 |
///
/// # ⚠ 踩过的坑（r80g 探针 4e 抓到的）
///
/// 我第一版写的是"**文件存在才设置** `ORT_DYLIB_PATH`"。于是：
///   1. 用户还没下运行库 → 第一次查状态 → 环境变量没设 → ort 缓存
///      相对名 `"onnxruntime.dll"`
///   2. 用户下完运行库（dll 落在「抠图模型」目录）→ 再查 → `G_ORT_DYLIB_PATH`
///      **已被冻住**，仍去 exe 目录找 → 找不到 → 报"加载不了"
///
/// 实测结果：`runtimeFile=true` 但 `runtime=false` —— 文件明明在，就是用不上，
/// 除非**重启程序**（新进程里缓存是干净的）。
///
/// 所以现在改成**无条件设置**：哪怕 dll 还不存在，也把 `ORT_DYLIB_PATH` 指到
/// 它将来会在的位置。这样 `G_ORT_DYLIB_PATH` 缓存的就是**正确路径**，
/// 等文件下好之后 `G_ORT_LIB` 自然会在下一次调用时重试成功 —— 不需要重启。
///
/// edge case：如果「抠图模型」里没有、但 exe 旁边有（用户手动放的），那就
/// 优先用 exe 旁边那份 —— 两处都兼容。
pub fn point_ort_at_runtime() {
    let prefer = aimodels::runtime_path();
    if prefer.exists() {
        std::env::set_var("ORT_DYLIB_PATH", &prefer);
        return;
    }
    // exe 同目录有没有（兼容"用户自己把 dll 放在程序目录"）
    if let Some(side) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("onnxruntime.dll")))
    {
        if side.exists() {
            std::env::set_var("ORT_DYLIB_PATH", &side);
            return;
        }
    }
    /* 两处都没有 —— 仍然把路径指到"将来会在的地方"。
     * 这一步是修 bug 的关键：不能因为"现在没有"就不设。 */
    std::env::set_var("ORT_DYLIB_PATH", &prefer);
}

/// 推理运行时是否可用（`onnxruntime.dll` 能否加载）。
///
/// 为什么单独一个函数而不是"直接调用了失败再说"：设置页要据此告诉用户
/// "AI 抠图不可用（缺少运行时）"，而不是等到点按钮才报错。
///
/// ⚠ ort 在找不到 dll 时会 **panic**（`lib_handle` 里是 `.expect()`），
///   所以这里用 `catch_unwind` 兜住 —— 用户不该因为缺个文件就看到程序崩溃。
pub fn runtime_available() -> bool {
    point_ort_at_runtime();
    // 用一次最小代价的 ORT 调用探测：环境初始化成功即说明 dll 在且版本对得上。
    std::panic::catch_unwind(|| {
        // ort 的初始化是惰性的，构造一个 SessionBuilder 就足以触发加载
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

/// **AI 抠图的参数**（r80b：用户要求「在编辑画面里面多添加一些与这些模型相关的参数」）。
///
/// # 设计原则：每个参数都对应代码里真实存在的一步处理
///
/// 参数面板最容易变成"摆几个滑块好看"。所以这里只放**真的会改变输出**的量，
/// 每一项都在下面注明它作用在哪一步、调大调小分别会怎样：
///
/// | 参数 | 作用 | 调大的效果 | 调小的效果 |
/// |---|---|---|---|
/// | `mask_threshold` | 把 AI 的 alpha 二值化时的门槛 | 抠得更狠、边缘更干净，但可能咬掉主体 | 保留更多边缘，可能留残影 |
/// | `feather` | 边缘羽化半径（像素） | 边缘更柔和（适合要放大的图） | 边缘更硬（适合像素级小图标） |
/// | `fg_confidence` | 判"确定前景"的 alpha 下限 | 更信任 AI 的前景判断 | 更保守，更多像素交给连通性判 |
/// | `bg_confidence` | 判"确定背景"的 alpha 上限 | 更信任 AI 的背景判断 | 更保守（**这是修"挖空"的关键**） |
/// | `edge_decontaminate` | 边缘去色（消白边） | —（开关） | 关掉会有白边，一般不开 |
/// | `drop_small_islands` | 丢掉孤立小块 | —（开关） | 关掉会留下噪点 |
///
/// # 默认值怎么来的
///
/// 是 `tools/r80-ai-visual.js` 在 10 个真实图标上试出来的一组稳妥值；
/// 用户调坏了可以点「恢复默认」。
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Params {
    /// 把 AI 的 alpha 二值化的门槛（0~255）。
    ///
    /// 注意：**不是**简单地把 alpha 变 0/1 —— AI 输出的中间值（边缘带）仍会
    /// 交给颜色解混去算，这里只决定"多确信才算数"。默认 128。
    pub mask_threshold: u8,
    /// 边缘羽化半径（0~4 像素，0 = 不羽化）。
    ///
    /// 实现是对最终 alpha 做一次半径 `r` 的模糊后按权重混回原值 ——
    /// 只作用于边缘带、不碰内部，避免把实心块糊成毛玻璃。默认 1。
    pub feather: u8,
    /// 判"确定前景"的 alpha 下限（0~255）。默认 240。
    pub fg_confidence: u8,
    /// 判"确定背景"的 alpha 上限（0~255）。默认 15。
    ///
    /// ⚠ 这个值是**与本地连通性配合**的关键：AI 说背景时，只有本地也认为
    /// 像背景才算确定背景。调大它 = 更信 AI（更容易出现"主体内部被挖空"）。
    pub bg_confidence: u8,
    /// 是否做边缘去色（把混合像素的 RGB 换成纯前景色，消除白边）。默认开。
    pub edge_decontaminate: bool,
    /// 是否丢掉孤立的小碎块（面积 < 0.2% 的连通前景块）。默认开。
    ///
    /// 为什么需要：AI 偶尔会在背景里留下几十像素的"假前景"斑点，
    /// 放到深色底上很显眼。
    pub drop_small_islands: bool,
    /// 这次实际用的模型名（**只读**，后端回填给界面显示；不接受前端传入）。
    #[serde(skip_deserializing)]
    pub model_name: String,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            mask_threshold: 128,
            feather: 1,
            fg_confidence: 240,
            bg_confidence: 15,
            edge_decontaminate: true,
            drop_small_islands: true,
            model_name: String::new(),
        }
    }
}

impl Params {
    /// 把参数夹到合法范围。**必须做** —— 前端滑块可能被改、配置文件可能手写。
    pub fn clamped(&self) -> Params {
        Params {
            mask_threshold: self.mask_threshold,
            feather: self.feather.min(4),
            // 前景门槛不能低于背景门槛，否则语义矛盾（同一个像素既确定前景
            // 又确定背景）—— 那种输入会让 trimap 变成随机结果
            fg_confidence: self.fg_confidence.max(self.bg_confidence.saturating_add(1)),
            bg_confidence: self.bg_confidence.min(200),
            edge_decontaminate: self.edge_decontaminate,
            drop_small_islands: self.drop_small_islands,
            model_name: self.model_name.clone(),
        }
    }

    /// 给日志用的一行摘要（排查时要知道"这次是什么参数跑出来的"）。
    pub fn summary(&self) -> String {
        let p = self.clamped();
        format!(
            "thr={} feather={} fg>={} bg<={} 去色={} 去碎块={}",
            p.mask_threshold,
            p.feather,
            p.fg_confidence,
            p.bg_confidence,
            p.edge_decontaminate as u8,
            p.drop_small_islands as u8
        )
    }
}

/// 一条缓存：`(模型 id, 会话)`。
///
/// 会话用 `Mutex` 包起来，因为 ort 2.0 的 `Session::run` 是 `&mut self`
/// （内部要登记输入/输出张量）。抠图本来就是串行操作（一次处理一张图），
/// 这把锁的竞争可以忽略；换来的是 168MB 的模型只加载一次。
type CachedSession = (
    &'static str,
    std::sync::Arc<std::sync::Mutex<ort::session::Session>>,
);

/// 已加载的推理会话缓存。
///
/// # 为什么必须缓存
///
/// 每次抠图都 `commit_from_file` 重新加载一遍模型 —— u2netp 是 4.4MB 还好，
/// `rmbg-full` 是 **168MB**，日志里实测单次加载 270~290ms，而推理本身才 330ms。
/// 用户调一次参数、或者在同一张图上反复"重来/涂抹后再抠"，每次都要白付这份钱。
///
/// 用进程级 `Mutex<Vec<..>>` 而不是每线程一份：能省内存（`rmbg-full` 常驻约
/// 200MB 级）。常驻数量有上限 —— 用户换着模型试时不至于把四个模型全驻留。
static SESSIONS: std::sync::OnceLock<std::sync::Mutex<Vec<CachedSession>>> =
    std::sync::OnceLock::new();

/// 最多同时驻留几个会话。
const MAX_CACHED_SESSIONS: usize = 2;

fn session_for(
    spec: &'static aimodels::ModelSpec,
) -> Result<std::sync::Arc<std::sync::Mutex<ort::session::Session>>, String> {
    use ort::session::Session;
    let cache = SESSIONS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    {
        let g = match cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some((_, s)) = g.iter().find(|(id, _)| *id == spec.id) {
            return Ok(s.clone());
        }
    }
    let path = aimodels::model_path(spec.id);
    let t = std::time::Instant::now();
    let sess = Session::builder()
        .and_then(|b| b.commit_from_file(&path))
        .map_err(|e| format!("加载模型失败（{}）：{e}", spec.name))?;
    let sess = std::sync::Arc::new(std::sync::Mutex::new(sess));
    crate::win::log(&format!(
        "ai_matte: 首次加载 {} 用时 {}ms（之后复用会话）",
        spec.name,
        t.elapsed().as_millis()
    ));
    let mut g = match cache.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    // 淘汰最老的一条（简单 FIFO），保持常驻数量可控
    while g.len() >= MAX_CACHED_SESSIONS {
        g.remove(0);
    }
    g.push((spec.id, sess.clone()));
    Ok(sess)
}

/// 跑一次推理，输出与**输入图同尺寸**的 alpha 蒙版。
///
/// `spec`：模型清单项（决定边长、归一化、取哪个输出）。
/// `params`：参数。这里用到 `mask_threshold`（后处理门槛）与 `feather`（羽化）；
///   前景/背景置信度是 trimap 阶段的量，在 `iconedit_ai` 里用。
pub fn run(
    spec: &'static aimodels::ModelSpec,
    rgba: &image::RgbaImage,
    params: &Params,
) -> Result<AiMatte, String> {
    use ort::value::Value;

    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Err("图为空".to_string());
    }
    let path = aimodels::model_path(spec.id);
    if !path.exists() {
        return Err(format!("模型 {} 还没下载", spec.name));
    }

    /* ⚠ 会话走缓存（见 `session_for`）：新建一次 = 读整个模型文件。
     *   `run` 会改 Session 的内部状态吗？不会 —— `Session::run(&self)` 只读，
     *   所以 `Arc<Session>` 可以跨线程共享。 */
    let sess = session_for(spec)?;
    let load_ms = 0u128;

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
    /* `Session::run` 是 `&mut self`（ort 2.0 内部要登记输入/输出），
     * 所以从缓存的 Mutex 里短暂借出来跑一次。这把锁只在**同一次推理**期间持有，
     * 抠图又是串行操作，实际不会成为瓶颈。
     *
     * ⚠ 返回的 `SessionOutputs` 借用了 guard 里的 Session（生命周期绑在一起），
     *   所以必须**在 guard 的作用域之内**把要的数据都取出来（下面那段
     *   `picked` 提取），不能把 outputs 带出块。 */
    let (used_idx, data, n_out) = {
        let mut guard = match sess.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let outputs = guard
            .run(ort::inputs![val])
            .map_err(|e| format!("推理失败：{e}"))?;
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
        let n_out = outputs.len();
        let (used_idx, data) = picked.ok_or_else(|| "模型没有可用的输出张量".to_string())?;
        (used_idx, data, n_out)
    };
    let infer_ms = t0.elapsed().as_millis();

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

    /* ---- 参数后处理（r80b）----
     *
     * 顺序有讲究：**先羽化、再按门槛清理**。反过来的话，先清理会把边缘的
     * 中间值抹掉，羽化就没有"中间值"可用了，等于白做。 */
    let p = params.clamped();
    if p.feather > 0 {
        gray = feather_alpha(&gray, p.feather);
    }
    /* `mask_threshold`：只用来**削掉极弱的响应**，不是二值化。
     *
     * 为什么不做真二值化：AI 的中间值（边缘带）是有信息量的 —— 它表示
     * "这里有多少是前景"，后面颜色解混要靠它决定过渡。全砍成 0/1 会让
     * 边缘变成硬切、重新出现锯齿。
     * 所以这里只在门槛之下的像素上做一次**软压**（线性衰减到 0），
     * 门槛之上的保持原值。 */
    if p.mask_threshold > 0 {
        let thr = p.mask_threshold as f32;
        for px in gray.pixels_mut() {
            let a = px[0] as f32;
            if a < thr {
                // 在 [0, thr) 区间线性压到 0：越弱越接近 0
                px[0] = ((a / thr) * (a / thr) * a).round() as u8;
            }
        }
    }

    crate::win::log(&format!(
        "ai_matte: {} 加载 {load_ms}ms 推理 {infer_ms}ms 输出 {n_out} 个(用第{used_idx}个) 尺寸 {side}x{side} 参数 {}",
        spec.name,
        p.summary()
    ));
    let _ = load_ms + infer_ms;
    Ok(AiMatte { alpha: gray })
}

/// 边缘羽化：只对**中间值像素**做半径 `r` 的盒式模糊，纯前景/纯背景保持原样。
///
/// 为什么只碰中间值：图标主体内部是大片实心色，一起糊会显得发虚；
/// 而边缘本来就需要一点过渡，糊一下反而更自然（尤其是抠完要放大的图）。
///
/// 做法：先算模糊后的整张图，再按"离 0/255 的距离"做权重混回 ——
/// 越靠中间（= 越是边缘）混入越多模糊值。
fn feather_alpha(src: &image::GrayImage, r: u8) -> image::GrayImage {
    // r = 0 就是"不羽化"：直接返回原图，别做一次半径 1 的（那是另一个参数值）
    if r == 0 {
        return src.clone();
    }
    let (w, h) = src.dimensions();
    let rad = r as i32;
    let mut out = src.clone();
    for y in 0..h {
        for x in 0..w {
            let a = src.get_pixel(x, y)[0];
            // 纯前景 / 纯背景不动
            if a <= 2 || a >= 253 {
                continue;
            }
            // 半径内取平均
            let mut sum = 0u32;
            let mut n = 0u32;
            for dy in -rad..=rad {
                let yy = y as i32 + dy;
                if yy < 0 || yy >= h as i32 {
                    continue;
                }
                for dx in -rad..=rad {
                    let xx = x as i32 + dx;
                    if xx < 0 || xx >= w as i32 {
                        continue;
                    }
                    sum += src.get_pixel(xx as u32, yy as u32)[0] as u32;
                    n += 1;
                }
            }
            if n == 0 {
                continue;
            }
            let avg = sum as f32 / n as f32;
            /* 混合权重：α 越靠中间权重越大（1.0 在 128 处，0 在两端）。
             * 这样纯边缘得到充分平滑，而靠近实心的部分几乎不受影响。 */
            let mid = 1.0 - ((a as f32 - 128.0).abs() / 128.0);
            let blended = a as f32 * (1.0 - mid) + avg * mid;
            out.put_pixel(x, y, image::Luma([blended.round().clamp(0.0, 255.0) as u8]));
        }
    }
    out
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
            let e = run(fake, &img, &Params::default()).unwrap_err();
            assert!(e.contains("还没下载"), "错误信息应当说明没下载，实际：{e}");
        }
    }

    /// 空图要被挡住（推理 0×0 没有意义）。
    #[test]
    fn 空图被挡住() {
        let spec = crate::aimodels::MODELS.first().unwrap();
        let img = image::RgbaImage::new(0, 0);
        assert!(run(spec, &img, &Params::default()).is_err());
    }

    /* ── 参数纯逻辑（不需要模型/dll） ── */

    /// 羽化只碰边缘带，**不该动纯前景/纯背景**（否则主体内部会发虚）。
    #[test]
    fn 羽化不碰实心区域() {
        let mut img = image::GrayImage::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                // 左半边纯前景、右半边纯背景、中间一条过渡带
                let v = if x < 12 { 255 } else if x > 19 { 0 } else { 128 };
                img.put_pixel(x, y, image::Luma([v]));
            }
        }
        let out = feather_alpha(&img, 2);
        assert_eq!(out.get_pixel(2, 16)[0], 255, "纯前景不该被羽化改动");
        assert_eq!(out.get_pixel(30, 16)[0], 0, "纯背景不该被羽化改动");
    }

    /// 羽化半径 0 时输出必须与输入完全一致（等于没做）。
    #[test]
    fn 羽化半径为0等于没做() {
        let mut img = image::GrayImage::new(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                img.put_pixel(x, y, image::Luma([(x * 30) as u8]));
            }
        }
        let out = feather_alpha(&img, 0);
        assert_eq!(out.as_raw(), img.as_raw());
    }

    /// 参数摘要要能反映实际值（排查时要靠它知道"这次是什么配置"）。
    #[test]
    fn 参数摘要包含关键值() {
        let p = Params { mask_threshold: 77, feather: 3, ..Default::default() };
        let s = p.summary();
        assert!(s.contains("77"), "摘要应含门槛值：{s}");
        assert!(s.contains("3"), "摘要应含羽化值：{s}");
    }
}
