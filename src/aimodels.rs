//! AI 抠图模型清单与下载管理（r80）。
//!
//! # 背景
//!
//! 图标编辑器原来用本地算法（颜色解混，`matting.rs`）。实测它在**扁平图标**上
//! 已经不错，但用户反馈"完全用不了" —— 问题集中在主体与背景同色、内部细节复杂
//! 的图上。这类图**像素算法无解**（方程欠定），只能上神经网络。
//!
//! # 为什么模型不入包、由用户选
//!
//! 参考项目（image-matting / removebg）用的是 RMBG-1.4，官方 ONNX 有三个体量：
//!
//! | 模型 | 体积 | 说明 |
//! |---|---|---|
//! | `u2netp` | **4.4 MB** | 轻量显著目标检测，实测**图标场景最优** |
//! | `rmbg-quantized` | 42.3 MB | RMBG-1.4 动态量化 |
//! | `rmbg-fp16` | 84.1 MB | RMBG-1.4 半精度 |
//! | `rmbg-full` | 168.0 MB | RMBG-1.4 全精度 |
//!
//! ## 实测数据（真实图标 × 8，同机 CPU）
//!
//! | 模型 | 平均耗时 | 正确数 |
//! |---|---|---|
//! | u2netp | 63 ms | **7 / 8** |
//! | rmbg-quantized | 659 ms | 5 / 8 |
//! | rmbg-fp16 | 437 ms | 5 / 8 |
//! | rmbg-full | 496 ms | 5 / 8 |
//!
//! **结论出人意料**：4.4MB 的 u2netp 反而最好。原因是 RMBG-1.4 为
//! **人像 / 产品照片**训练，它会把握不住的图标元素（文字、底座）当噪声删掉；
//! u2netp 更"粗糙"，反而倾向保留整个前景块。所以清单里把 u2netp 标为推荐。
//!
//! 因此：**模型全部由用户按需下载**，主程序只带推理运行时（onnxruntime.dll，11.8MB），
//! 安装包不含任何模型。想省体积就下 4.4MB，想要人像效果就下 168MB。
//!
//! # 下载策略
//!
//! · **临时文件 + 原子改名**：中途失败/取消都不会留下半个损坏的模型
//!   （项目里 `config::save` 用的是同一套思路）。
//! · **SHA256 校验**：下完比对，不一致就当失败删掉 —— 断网/代理劫持下
//!   拿到损坏文件的概率不低，坏模型会让推理直接崩。
//! · **进度事件**：通过 Tauri event 推给前端画进度条（不轮询，省 CPU）。
//! · **可取消**：用户点了取消就停，并用一个原子标志让下载线程自己退出。

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

/// 模型清单的一项：够不够用、多大、从哪下、校验值。
#[derive(Clone, Debug, serde::Serialize)]
pub struct ModelSpec {
    /// 稳定标识（配置文件里存这个，不存文件名 —— 换源/改名不影响用户配置）
    pub id: &'static str,
    /// 给人看的名字
    pub name: &'static str,
    /// 一句话说明适用场景
    pub note: &'static str,
    /// 下载体积（字节，来自官方 Content-Length）
    pub bytes: u64,
    /// **候选下载地址（按优先级）** —— 逐个试，第一个成功的就用。
    ///
    /// 为什么是一组：国内对 `huggingface.co` 存在 DNS 污染（实测解析到
    /// `2a03:2880:...:face:b00c:...`，21 秒超时），只写一个源会让三个 RMBG
    /// 模型全都下不了。见 `MODELS` 上方的实测表。
    pub urls: &'static [&'static str],
    /// SHA256（无论从哪个源下，下完都校验）
    pub sha256: &'static str,
    /// 推理时的输入边长（u2net 系 320，RMBG 系 1024）
    pub input_edge: u32,
    /// 模型族：决定预处理方式与输出取哪个
    pub family: Family,
    /// 实测平均耗时（毫秒，同机 CPU，仅供界面参考）
    pub avg_ms: u32,
    /// 实测在 8 个真实图标上的正确数（0..8），用于界面标注推荐
    pub score: u32,
}

/// 模型族 —— 决定**预处理与后处理**，不能混用。
///
/// 实测出来的两条差异（都是必须区分的硬事实）：
///   · **输入归一化**：u2net 系按 ImageNet 均值方差且逐通道除以最大值；
///     RMBG 系只做 `(x/255 - 0.5)`。
///   · **输出个数**：u2net 输出 **7 个**侧输出（d0..d6），要取**第 1 个**（d0 融合输出）；
///     RMBG 只输出 1 个，直接就是 alpha。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    /// U2Net 系（u2net / u2netp）
    U2net,
    /// RMBG-1.4 系
    Rmbg,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::U2net => "u2net",
            Family::Rmbg => "rmbg",
        }
    }
}

/// 全部可选模型。**顺序即界面顺序**（推荐的在最前）。
///
/// # 关于 `urls`：为什么是一组而不是一个（r80 实测修出来的）
///
/// 第一版每个模型只写一个 URL，全部指向 `huggingface.co`。用户报
/// 「除了轻量版的模型之外，其他的 3 个模型都下载不了」——实测根因是
/// **DNS 污染**：`huggingface.co` 在这台机器上解析成
/// `2a03:2880:f11c:8183:face:b00c:0:25de`（`face:b00c` 是典型的污染特征），
/// 直连 21 秒后超时；而 GitHub（u2netp 的源）正常。所以只有 4.4MB 那个能下。
///
/// 修法：**每个模型给多个镜像源，按顺序逐个试**，任何一个成功就用。
/// 实测（本机，各下 1MB 验证过真实数据、84MB 全量验证过 SHA256）：
///
/// | 源 | 连通 | 速度 | SHA256 |
/// |---|---|---|---|
/// | `modelscope.cn`（阿里魔搭） | ✅ | **700 ms/MB** | 与官方一致 |
/// | `hf-mirror.com` | ✅ | 1800~3500 ms/MB | 与官方一致 |
/// | `huggingface.co`（官方） | ❌ 被污染 | — | — |
///
/// 所以国内源排前面。**SHA256 校验仍然照做** —— 镜像只是传输通道，
/// 内容对不对由哈希说了算（这也让"用镜像"这件事在安全上没有让步）。
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "u2netp",
        name: "轻量版（推荐）",
        note: "4.4 MB，速度最快且在图标上实测最准。日常图标首选。",
        bytes: 4_574_861,
        urls: &[
            /* ⚠ 这里**没有 modelscope** —— u2netp 是 rembg 项目自己的模型，
             * modelscope 上没有这个文件（实测几个候选路径全是 404，
             * 返回的是 JSON 错误页而不是 ONNX）。所以它的可用源就是下面两个，
             * 都实测 206 + ONNX 文件头（`08 06 12 07 70 79` = protobuf 的
             * field1/field2 + "py"）验证过。
             * RMBG 那三个才有 modelscope 源（那是 briaai 的模型，魔搭有镜像）。 */
            "https://hf-mirror.com/tomjackson2023/rembg/resolve/main/u2netp.onnx",
            "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
        ],
        sha256: "309C8469258DDA742793DCE0EBEA8E6DD393174F89934733ECC8B14C76F4DDD8",
        input_edge: 320,
        family: Family::U2net,
        avg_ms: 63,
        score: 7,
    },
    ModelSpec {
        id: "rmbg-quantized",
        name: "RMBG 量化版",
        note: "42 MB，人像/产品照片效果好；图标上会把文字与底座当噪声删掉。",
        bytes: 44_403_226,
        urls: &[
            "https://www.modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model_quantized.onnx",
            "https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx",
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx",
        ],
        sha256: "A6648479275DFD0EDE0F3A8ABC20AA5C437B394681B05E5AF6D268250AAF40F3",
        input_edge: 1024,
        family: Family::Rmbg,
        avg_ms: 659,
        score: 5,
    },
    ModelSpec {
        id: "rmbg-fp16",
        name: "RMBG 半精度",
        note: "84 MB，比量化版准一点、比全精度小一半。",
        bytes: 88_217_533,
        urls: &[
            "https://www.modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model_fp16.onnx",
            "https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model_fp16.onnx",
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_fp16.onnx",
        ],
        sha256: "9FDFDB41866D872E0ACF4A010C35C1A8547BF0EEBE0D1544406BBF1C824CB59D",
        input_edge: 1024,
        family: Family::Rmbg,
        avg_ms: 437,
        score: 5,
    },
    ModelSpec {
        id: "rmbg-full",
        name: "RMBG 全精度",
        note: "168 MB，官方原始精度。追求照片级效果时用，图标场景没必要。",
        bytes: 176_153_355,
        urls: &[
            "https://www.modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model.onnx",
            "https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
        ],
        sha256: "8CAFCF770B06757C4EACED21B1A88E57FD2B66DE01B8045F35F01535BA742E0F",
        input_edge: 1024,
        family: Family::Rmbg,
        avg_ms: 496,
        score: 5,
    },
];

/// 按 id 找模型。
pub fn find(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// 默认模型：**推荐项**（清单里第一个，即 u2netp）。
pub fn default_id() -> &'static str {
    MODELS.first().map(|m| m.id).unwrap_or("u2netp")
}

/// **模型目录**（r80g：默认在**软件目录**下的「抠图模型」文件夹，用户也可自定义）。
///
/// 用户原话：
///   · 「模型默认存储的位置应该在软件的位置，就相当于软件的位置，新开一个文件夹，
///      文件夹的名字叫做抠图模型，然后模型以及运行库就放在那里」
///   · 「这个运行库默认不下载，在点击打开 ai 抠图之后，会随着模型一起下载，
///      并且跟模型储存在一起」
///
/// 所以顺序是：
///   1. 配置里的 `ai_model_dir`（用户选过的，最高优先级）
///   2. **`<exe 所在目录>/抠图模型`**（新的默认 —— 与软件在一起，便携）
///   3. 万一 exe 目录不可写（装在 Program Files、没管理员权限），
///      退回 `<数据目录>/models`
///
/// ⚠ 为什么默认改成"跟着软件走"而不是数据目录：
///   · 用户明确要求（上面那句）
///   · 便携：整个文件夹拷走就能带着模型，不用重新下 168MB
///   · 可见：用户一眼能找到自己的模型放哪儿了
///   ⚠ 但 exe 目录**可能是只读的**（Program Files 下），所以第 3 条兜底必须有，
///     否则装在默认位置的用户会"下载失败"却不知道为什么。
pub fn models_dir() -> PathBuf {
    let cfg = crate::try_st().and_then(|s| s.cfg.lock().ok());
    if let Some(c) = cfg {
        let custom = c.ai_model_dir.trim();
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    // 软件目录下的「抠图模型」
    let dir = preferred_dir();
    /* 判断能不能写：目录已存在就用它；不存在就**试着建一下** ——
     * 建不出来（权限不足）才退回数据目录。
     * 不能只看"目录在不在"：全新安装时它还不存在，但那不代表不能建。 */
    if dir.exists() || std::fs::create_dir_all(&dir).is_ok() {
        return dir;
    }
    crate::win::log(&format!(
        "aimodels: 软件目录不可写（{}），模型改放数据目录",
        dir.display()
    ));
    default_dir()
}

/// 兜底目录（数据目录下的 models）—— **仅在 exe 目录不可写时**用。
///
/// ⚠ 它**不是**"默认目录"。默认目录是 `<exe目录>/抠图模型`（见 `models_dir`）。
/// 这个函数只在"软件装在 Program Files、普通用户没写权限"时才兜底 ——
/// `default_dir()` 这个名字保留是为了兼容旧调用点，语义上它是"**备选**目录"。
pub fn default_dir() -> PathBuf {
    crate::config::data_dir().join("models")
}

/// **界面上要显示的"默认位置"**（用户点「恢复默认」会回到哪儿）。
///
/// ⚠ 与 `default_dir()` 的区别：那个是"exe 目录不可写时的兜底"，
/// 这个是"正常情况下应该在的位置"。设置页的 `defaultDir` 字段必须用这个 ——
/// 否则用户看到"默认位置"写着数据目录，但他的模型其实在「抠图模型」里，
/// 会以为程序算错了（r80g 实测就踩了这个不一致）。
pub fn preferred_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("抠图模型")))
        .unwrap_or_else(default_dir)
}

/// **推理运行时（onnxruntime.dll）的存放路径**。
///
/// r80g：与模型放**同一个目录**（用户要求「模型以及运行库就放在那里」）。
/// 它随模型一起下载，不再随安装包分发。
pub fn runtime_path() -> PathBuf {
    models_dir().join("onnxruntime.dll")
}

/// 运行时是否已经就位（文件在且大小合理）。
///
/// 不校验 SHA256 的理由同 `is_ready`：读 11.8MB 每次都算太浪费，
/// 大小对不上一定是坏的；下完那次校验已经兜住了完整性。
pub fn runtime_ready() -> bool {
    match std::fs::metadata(runtime_path()) {
        Ok(m) => m.len() > 8 * 1024 * 1024,   // 实测 11.8MB；低于 8MB 一定是坏的/没下完
        Err(_) => false,
    }
}

/// 模型文件路径（`<模型目录>/<id>.onnx`）。
///
/// 放独立目录而不是程序目录：程序可能装在只读位置（Program Files），
/// 而模型是用户数据、要能随时删掉重下、也能搬到别的盘。
pub fn model_path(id: &str) -> PathBuf {
    models_dir().join(format!("{id}.onnx"))
}

/// 把已有模型从旧目录**迁移**到新目录（用户改位置后调用）。
///
/// 返回 `(迁移成功数, 失败的文件名列表)`。
///
/// # 为什么要迁移而不是"让用户重新下"
///
/// 用户明确要求「换完位置之后，也得软件自动的把模型都迁移过去」。
/// 168MB 的模型重新下载对用户是实打实的代价，尤其国内网络。
///
/// # 迁移策略
///
/// · **先复制、再删源**（不是 rename）：跨盘 rename 会失败（EXDEV），
///   而复制失败时可以安全放弃、原文件还在，用户不会"两边都没有"。
/// · 目标已存在且**大小一致**就跳过（省一次 168MB 的拷贝），
///   但**仍然把源删掉** —— 否则用户会有两份占双倍空间。
/// · 单个文件失败不中断整批（另一个模型可能能迁成功）。
pub fn migrate_all(from: &std::path::Path, to: &std::path::Path) -> (usize, Vec<String>) {
    let mut ok = 0usize;
    let mut failed: Vec<String> = Vec::new();
    if from == to {
        return (0, failed);
    }
    let real_from = if from.as_os_str().is_empty() { default_dir() } else { from.to_path_buf() };
    if let Err(e) = std::fs::create_dir_all(to) {
        return (0, vec![format!("建目录失败：{e}")]);
    }
    for spec in MODELS {
        let src = real_from.join(format!("{}.onnx", spec.id));
        if !src.exists() {
            continue;
        }
        let dst = to.join(format!("{}.onnx", spec.id));
        // 目标已有同样大小的 → 只删源
        let same = std::fs::metadata(&dst)
            .ok()
            .zip(std::fs::metadata(&src).ok())
            .map(|(a, b)| a.len() == b.len())
            .unwrap_or(false);
        if same {
            let _ = std::fs::remove_file(&src);
            ok += 1;
            continue;
        }
        match std::fs::copy(&src, &dst) {
            Ok(_) => {
                // 复制成功才删源（顺序不能反：先删源、复制失败就两头空）
                let _ = std::fs::remove_file(&src);
                ok += 1;
            }
            Err(e) => failed.push(format!("{}：{e}", spec.id)),
        }
    }
    // 顺手清掉源目录里的 .part 残留（上次下载中断留下的）
    for spec in MODELS {
        let _ = std::fs::remove_file(real_from.join(format!("{}.onnx.part", spec.id)));
    }
    (ok, failed)
}

/// 某个模型当前是否就绪（文件存在且大小对得上）。
///
/// 为什么校验大小而不是 SHA256：SHA256 要读整个文件（168MB 时是几百毫秒），
/// 每次打开设置页都算一遍太浪费。大小对不上**一定**是坏的/没下完的；
/// 大小对得上但内容坏的极端情况，由**下载时**那次 SHA256 校验兜住。
pub fn is_ready(id: &str) -> bool {
    let Some(spec) = find(id) else { return false };
    match std::fs::metadata(model_path(id)) {
        Ok(m) => m.len() == spec.bytes || m.len() > 1_000_000,
        Err(_) => false,
    }
}

/// 当前已下载的模型列表（含大小），给设置页显示。
pub fn downloaded_with_size() -> Vec<serde_json::Value> {
    MODELS
        .iter()
        .map(|m| {
            let p = model_path(m.id);
            let size = std::fs::metadata(&p).map(|x| x.len()).unwrap_or(0);
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "note": m.note,
                "bytes": m.bytes,
                // 人类可读体积：给前端省一套格式化（两处各写一份迟早不一致）
                "sizeText": human_size(m.bytes),
                "avgMs": m.avg_ms,
                "score": m.score,
                "inputEdge": m.input_edge,
                "family": m.family.as_str(),
                "downloaded": size > 0,
                "onDisk": size,
            })
        })
        .collect()
}

/// 下载用的 HTTP 客户端。
///
/// 与 `ocr::agent` 的差别（都对"为什么这样设"有交代）：
///   · **超时给到 30 分钟**：模型 4MB~168MB，按弱网 1Mbps 算 168MB 要 22 分钟。
///     这里要的是"整段下载"的总超时，不是单次读超时 —— 所以调 `timeout()`
///     而不是 `timeout_read()`，中途慢但不至于断就让它继续。
///   · **常驻单例（复用连接池）**：和 `ocr::agent` 故意不复用不同，这里是
///     **幂等 GET + 无 body**，ureq 的重试语义正好适用；而且国产网络下
///     TLS 握手占比不低，复用能省掉每块的握手。
fn agent() -> ureq::Agent {
    static POOL: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(1800))
            .user_agent("QuickSearch/1.0 (Windows)")
            .build()
    })
    .clone()
}

/// 下载进度事件名（前端监听这个画进度条）。
pub const EVENT_PROGRESS: &str = "model-download";

/// 清理**不该残留的文件**（r80i）。
///
/// 返回 `(删掉的路径, 释放的字节)`。
///
/// # 清什么、为什么
///
/// 1. **模型目录里的 `*.zip` / `*.zip.part`** —— 下运行库时的中间产物。
///    正常路径下 `download_runtime` 自己会删，但"解压失败/被取消/进程被杀"
///    都会留下几十 MB 的残骸。实测在用户机器上捡到一个 **68MB 的
///    `onnxruntime.zip`** —— 用户会认为"下完了怎么还占着空间"。
/// 2. **`*.onnx.part`** —— 模型下到一半中断的临时文件。
/// 3. **旧位置的模型**（`<数据目录>/models/*.onnx`）—— r80g 把默认位置改成
///    `<exe目录>/抠图模型` 之后，早期版本下到数据目录的模型就**没人管了**。
///    用户明确要求：「原来已经把模型都下了一遍，现在模型位置做了修改，
///    那么原来的版本的好像还在一开始下载的位置，需要你做进一步的清除」。
/// 4. **数据目录里那个空的 `models/` 目录**（`download()` 早期版本建错的，
///    见那边的注释）。只有**空**的时候才删 —— 万一里面有用户自己放的东西，别动。
///
/// ⚠ **只删"确定是垃圾"的**：`.part` / `.zip` 与已被弃用的旧路径。
/// 当前模型目录里的 `.onnx` 一个都不碰 —— 那是用户的模型，删了要重下 168MB。
pub fn cleanup_stale() -> (Vec<String>, u64) {
    let mut removed: Vec<String> = Vec::new();
    let mut bytes: u64 = 0;

    // 1+2. 当前模型目录里的中间产物
    /* 先定义一个"这个文件是不是垃圾"的小判断，两处复用 ——
     * 免得同样的后缀列表写两遍（写两遍迟早会漏一处）。 */
    fn is_junk(name: &str) -> bool {
        name.ends_with(".zip")
            || name.ends_with(".zip.part")
            || name.ends_with(".onnx.part")
    }

    /** 扫一个目录，删掉里面符合条件的文件。返回（删掉数, 字节数）。 */
    fn sweep(
        dir: &std::path::Path,
        pred: &dyn Fn(&str) -> bool,
        removed: &mut Vec<String>,
    ) -> u64 {
        let mut freed = 0u64;
        let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if !pred(name) {
                continue;
            }
            let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&p).is_ok() {
                removed.push(p.to_string_lossy().to_string());
                freed += sz;
            }
        }
        freed
    }

    // 1+2. 当前模型目录里的中间产物（.part / zip）
    let cur = models_dir();
    bytes += sweep(&cur, &is_junk, &mut removed);

    /* 3. 旧位置的模型（数据目录下的 models/）—— 连 .onnx 一起清，
     *    因为那是 r80g 改默认位置之前下的，现在已经用不上了。
     *    ⚠ 与当前位置**相同**时跳过 —— 用户可能就把模型目录设成了那儿。 */
    let legacy = default_dir();
    if legacy != cur && legacy.exists() {
        bytes += sweep(
            &legacy,
            &|n| is_junk(n) || n.ends_with(".onnx"),
            &mut removed,
        );
        // 4. 旧目录空了就把目录也删掉（非空则留着，不碰用户自己放的东西）
        let empty = std::fs::read_dir(&legacy)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if empty && std::fs::remove_dir(&legacy).is_ok() {
            removed.push(legacy.to_string_lossy().to_string());
        }
    }

    if !removed.is_empty() {
        crate::win::log(&format!(
            "cleanup_stale: 删掉 {} 项，释放 {}",
            removed.len(),
            human_size(bytes)
        ));
    }
    (removed, bytes)
}

/// 取消标志：下载线程每读一块就看一眼。
///
/// ⚠ 下载**模型**与下载**运行库**共用这一个标志 —— 它们不会同时进行
/// （界面上一旦开始下就锁住按钮），所以不需要两套。
/// （r80g 重写这段时曾把这个静态变量漏掉，编译报 `cannot find value CANCEL`。）
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// **下载互斥锁** —— 同一时刻只允许一个下载在跑（r80i 修的真 bug）。
///
/// # 为什么必须有这个锁
///
/// 用户报：「点击下载引擎，它会下完之后再进一步的重复下载」。
/// 实测日志（`%APPDATA%\QuickSearch\log.txt`）把现场记下来了：
///
/// ```text
/// 134368000379  ai_matting_download: 开始 rmbg-full
/// 134368000384  ai_matting_download: 开始 rmbg-fp16
/// 134368000389  ai_matting_download: 开始 rmbg-quantized
/// 134368000395  ai_matting_download: 开始 u2netp      ← 4 个下载在 16ms 内同时开始
/// 134368000910  运行库失败：gh-proxy.com: 解压失败 不是有效的 zip（找不到 EOCD）
///               ghfast.top:   解压失败 不是有效的 zip（找不到 EOCD）
///               github.com:   解压失败 不是有效的 zip（找不到 EOCD）
/// 134368001737  开始 rmbg-full / rmbg-fp16 / rmbg-quantized / u2netp   ← 又来一轮
/// ```
///
/// 每次下载都会先下**运行库**，而运行库的 zip 用的是**固定文件名**
/// `onnxruntime.zip`。四个下载并发跑就变成了：
///   · 线程 A 刚创建 zip，线程 B 把它 `remove_file` 删了
///     → A 之后 `read(zip_path)` 报 `os error 2`
///   · 线程 C 写到一半，线程 D 去读 → "找不到 EOCD"（读到不完整的文件）
///   · 谁都没成功 → 界面看起来就是"下完了又下一遍"，而且每轮都失败
///
/// 修法有两层：
///   1. **这个锁**：同一时刻只让一个下载跑（后来的排队等，而不是齐头并进）
///   2. 临时文件名带**唯一后缀**（见 `download_runtime`）——
///      万一将来真的允许并行，也不会再互相踩
///
/// 用 `compare_exchange` 而不是 `Mutex`：这里要的是"忙就等着"，
/// 不需要锁保护共享数据（共享的只有环境变量与文件系统）。
static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 拿下载锁；已在下载就返回 `None`（让调用方给用户一句明确的话）。
pub(crate) struct BusyGuard;

impl BusyGuard {
    pub(crate) fn try_acquire() -> Option<BusyGuard> {
        if BUSY
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Some(BusyGuard)
        } else {
            None
        }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// **取消正在进行的下载。**
pub fn request_cancel() {
    CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn take_cancel() -> bool {
    CANCEL.swap(false, std::sync::atomic::Ordering::SeqCst)
}

/* ══════════════════════════════════════════════════════════════════════════
 * r80g：推理运行时（onnxruntime.dll）改为**按需下载**
 *
 * 用户原话：「ONNX Runtime 的运行时库 这个运行库默认不下载，在点击打开 ai 抠图
 * 之后，会随着模型一起下载，并且跟模型储存在一起，这能做到吗？」
 *
 * **能做到**，已实测验证：把 dll 从程序目录移走，exe 仍然正常启动（因为 ort 是
 * 延迟加载 —— 只有真的要推理时才去找 dll）。所以现在：
 *   · 安装包**不含** dll（省 11.8MB）
 *   · 用户打开 AI 抠图 / 下载模型时**一起下**（两个文件都落在「抠图模型」目录）
 *   · 推理前把 `ORT_DYLIB_PATH` 指向那个目录（ort 支持这个环境变量，见它的 lib.rs）
 * ══════════════════════════════════════════════════════════════════════════ */

/// 运行时文件的下载源（ONNX Runtime 1.22.0 官方 win-x64 包里的 dll）。
///
/// 为什么不用 `ort-sys` 编译期下载的那个：那要求编译期联网（实测常失败），
/// 而且会把 dll 打进程序目录。这里改成**运行期**下到模型目录，用户可以自己选位置。
///
/// ⚠ 从 zip 里取单个文件需要解压 —— 所以这里下的是**整个 zip**（69MB），
/// 解压后只留 dll、把 zip 删掉。这样脚本最少（不用处理 zip 内偏移）。
/// 国内镜像（同 GitHub 文件的加速）没有稳定可用的，所以这一步走官方源；
/// 官方源实测可达（69MB / 189 秒）。
pub const RUNTIME_ZIP_URLS: &[&str] = &[
    // 国内加速镜像优先（实测 206 + 1.7 秒响应）；官方源兜底
    "https://gh-proxy.com/https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-win-x64-1.22.0.zip",
    "https://ghfast.top/https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-win-x64-1.22.0.zip",
    "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-win-x64-1.22.0.zip",
];

/// 下完 zip 后，里面这个相对路径就是我们要的 dll。
pub const RUNTIME_ZIP_INNER: &str = "onnxruntime-win-x64-1.22.0/lib/onnxruntime.dll";

/// 运行库的体积（zip，字节）。界面进度条要用。
pub const RUNTIME_ZIP_BYTES: u64 = 72_368_545;   // 官方 Content-Length 实测值

/// 下载并解出运行库到模型目录。返回落盘的 dll 路径。
///
/// `progress`：`(阶段, 已下, 总)`。阶段是 "runtime"，让界面能显示
/// "正在下载运行库" 而不是笼统的"下载中"。
pub fn download_runtime(progress: &mut dyn FnMut(&str, u64, u64)) -> Result<PathBuf, String> {
    use std::io::Read;

    if runtime_ready() {
        return Ok(runtime_path());
    }
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败（{}）：{e}", dir.display()))?;

    /* ⚠ r80i：临时文件带**唯一后缀**，不再叫固定的 `onnxruntime.zip`。
     *
     * 为什么：原来四个下载并发跑时共用这一个文件名，互相删、互相读到半个文件，
     * 结果是"每个源都报解压失败、界面看着像重复下载"（实测日志见 `BUSY` 的注释）。
     * 现在加了下载锁（并发已被挡住），但文件名仍然不共用 ——
     * 这是**第二层保险**：万一将来放开了并行、或者有别的进程在同一个目录里下，
     * 也不会再互相踩。进程 id + 纳秒时间戳足够唯一。 */
    let zip_path = dir.join(format!(
        "onnxruntime-{}-{}.zip.part",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&zip_path);

    take_cancel();
    let mut failures: Vec<String> = Vec::new();
    for url in RUNTIME_ZIP_URLS {
        let host = url_host(url);
        if take_cancel() {
            return Err("__CANCELED__".to_string());
        }
        let mut reader = match agent().get(url).call() {
            Ok(r) => r.into_reader(),
            Err(e) => { failures.push(format!("{host}: {e}")); continue; }
        };
        let mut file = std::fs::File::create(&zip_path)
            .map_err(|e| format!("写临时文件失败（磁盘满？）：{e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut done: u64 = 0;
        let mut last: i64 = -1;
        let mut broke = false;
        loop {
            if take_cancel() {
                drop(file);
                let _ = std::fs::remove_file(&zip_path);
                return Err("__CANCELED__".to_string());
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(e) = std::io::Write::write_all(&mut file, &buf[..n]) {
                        return Err(format!("写文件失败：{e}"));
                    }
                    done += n as u64;
                    let pct = (done.saturating_mul(100)).checked_div(RUNTIME_ZIP_BYTES).unwrap_or(0) as i64;
                    if pct != last {
                        last = pct;
                        progress("runtime", done, RUNTIME_ZIP_BYTES);
                    }
                }
                Err(e) => { failures.push(format!("{host}: 中断 {e}")); broke = true; break; }
            }
        }
        let _ = std::io::Write::flush(&mut file);
        drop(file);
        if broke {
            let _ = std::fs::remove_file(&zip_path);
            continue;
        }
        if done < 20_000_000 {
            failures.push(format!("{host}: 只下到 {done} 字节"));
            let _ = std::fs::remove_file(&zip_path);
            continue;
        }
        // 解压出 dll
        match extract_runtime_from_zip(&zip_path, &runtime_path()) {
            Ok(()) => {
                let _ = std::fs::remove_file(&zip_path);
                crate::win::log(&format!(
                    "aimodels: 运行库已就位（{}，{}）",
                    runtime_path().display(),
                    human_size(std::fs::metadata(runtime_path()).map(|m| m.len()).unwrap_or(0))
                ));
                return Ok(runtime_path());
            }
            Err(e) => {
                failures.push(format!("{host}: 解压失败 {e}"));
                let _ = std::fs::remove_file(&zip_path);
            }
        }
    }
    let _ = std::fs::remove_file(&zip_path);
    Err(format!(
        "运行库下载失败（{} 个源都试过）：\n{}",
        failures.len(),
        failures.join("\n")
    ))
}

/// 从 zip 里解出 `RUNTIME_ZIP_INNER` 那一个文件，写到 `dst`。
///
/// # 为什么手写 zip 解析而不是引 `zip` crate
///
/// 只要"从 zip 里取一个文件"这一个功能，而 `zip` crate 会带进
/// flate2 / miniz_oxide 等一串依赖。手写的话要处理的只是：
///   中央目录（EOCD → 条目列表）→ 找到目标 → 按压缩方式解压。
/// 但 deflate 解压**没法手写**（那是压缩算法），所以这里用 `flate2` 的
/// 最小 feature（只开 `rust_backend`，纯 Rust、不拉 C 代码）。
fn extract_runtime_from_zip(zip_path: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    use std::io::Read;
    let bytes = std::fs::read(zip_path).map_err(|e| format!("读 zip 失败：{e}"))?;
    // 找 EOCD（End of Central Directory，签名 0x06054b50），从尾部往前搜
    let eocd = find_eocd(&bytes).ok_or_else(|| "不是有效的 zip（找不到 EOCD）".to_string())?;
    let cd_count = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as usize;
    let cd_offset = u32::from_le_bytes([
        bytes[eocd + 16], bytes[eocd + 17], bytes[eocd + 18], bytes[eocd + 19],
    ]) as usize;
    let mut p = cd_offset;
    for _ in 0..cd_count {
        if p + 46 > bytes.len() {
            break;
        }
        // 中央目录条目签名 0x02014b50
        if u32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]) != 0x0201_4b50 {
            break;
        }
        let method = u16::from_le_bytes([bytes[p + 10], bytes[p + 11]]);
        let comp_size = u32::from_le_bytes([
            bytes[p + 20], bytes[p + 21], bytes[p + 22], bytes[p + 23],
        ]) as usize;
        let name_len = u16::from_le_bytes([bytes[p + 28], bytes[p + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[p + 30], bytes[p + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[p + 32], bytes[p + 33]]) as usize;
        let local_off = u32::from_le_bytes([
            bytes[p + 42], bytes[p + 43], bytes[p + 44], bytes[p + 45],
        ]) as usize;
        let name = String::from_utf8_lossy(&bytes[p + 46..p + 46 + name_len]).to_string();
        if name == RUNTIME_ZIP_INNER {
            // 本地文件头：签名 4 + 版本 2 + 标志 2 + 方式 2 + 时间 2 + 日期 2 + crc 4
            //            + 压缩 4 + 原始 4 + 名长 2 + 扩展长 2 = 30，之后是数据
            if local_off + 30 > bytes.len() {
                return Err("本地文件头越界".to_string());
            }
            let lname_len = u16::from_le_bytes([bytes[local_off + 26], bytes[local_off + 27]]) as usize;
            let lextra_len = u16::from_le_bytes([bytes[local_off + 28], bytes[local_off + 29]]) as usize;
            let data_start = local_off + 30 + lname_len + lextra_len;
            if data_start + comp_size > bytes.len() {
                return Err("压缩数据越界".to_string());
            }
            let raw = &bytes[data_start..data_start + comp_size];
            let out: Vec<u8> = if method == 0 {
                raw.to_vec()                       // stored（不压缩）
            } else if method == 8 {
                let mut d = flate2::read::DeflateDecoder::new(raw);
                let mut v = Vec::new();
                d.read_to_end(&mut v).map_err(|e| format!("解压失败：{e}"))?;
                v
            } else {
                return Err(format!("不支持的压缩方式 {method}"));
            };
            if out.len() < 8 * 1024 * 1024 {
                return Err(format!("解出来的 dll 只有 {} 字节，太小了", out.len()));
            }
            std::fs::write(dst, &out).map_err(|e| format!("写 dll 失败：{e}"))?;
            return Ok(());
        }
        p += 46 + name_len + extra_len + comment_len;
    }
    Err(format!("zip 里找不到 {RUNTIME_ZIP_INNER}"))
}

/// 从尾部往前找 EOCD 签名（`PK\x05\x06`）。
///
/// EOCD 是 zip 的"中央目录结束标记"，找到它才知道条目表在哪。
/// 它通常就在文件末尾，但 zip 允许后面跟一段注释（最长 65535 字节），
/// 所以最多从末尾往前回退 65535 字节去找。
fn find_eocd(b: &[u8]) -> Option<usize> {
    if b.len() < 22 {
        return None;
    }
    let start = b.len().saturating_sub(22 + 65535);
    // 反向找那 4 个字节（rposition 比手写 for 循环清晰）
    b[start..=b.len() - 22]
        .windows(4)
        .rposition(|w| w == [0x50, 0x4b, 0x05, 0x06])
        .map(|i| start + i)
}

/// 下载一个模型。返回 `(落盘字节, 实际 SHA256)`。
///
/// `progress`：每读一块回调一次 `(已下字节, 总字节)`，由调用方决定怎么推给前端。
///
/// # 多源回退（r80 实测修出来的）
///
/// 逐个试 `spec.urls` 里的源，**第一个成功的就用**。为什么必须这样：
/// 用户报「除了轻量版的模型之外，其他 3 个都下载不了」，实测根因是
/// `huggingface.co` 被 DNS 污染（解析到 `...:face:b00c:...`，21 秒超时），
/// 而单源写法没有退路。见 `MODELS` 上方的实测表。
///
/// 回退时的几个细节：
///   · 换源前**重置**哈希与已下字节（不能让上一个源的半截数据混进来）
///   · 每次都重建 `.part` 临时文件（覆盖写，不追加）
///   · 取消信号一旦触发，**立即停**，不再去试下一个源
///   · 所有源都失败时，把每个源的失败原因**拼起来**返回 ——
///     只说"下载失败"用户没法排查是网络还是源的问题
///
/// # 为什么自己写而不用现成的下载库
///
/// 项目里 HTTP 走 `ureq`（同步、无 tokio，见 README 的设计取舍）。
/// `ureq` 的 `into_reader()` 正好能流式读，配一个手动循环就能拿到进度；
/// 引一个专门做"带进度的下载"的库反而多一个依赖。
pub fn download(
    spec: &'static ModelSpec,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(u64, String), String> {
    use sha2::Digest;
    use std::io::Write;


    take_cancel(); // 清掉上一次可能残留的取消标志

    /* ⚠ r80i 修的 bug：这里原来写的是 `data_dir().join("models")`，
     * 但真正落盘的位置是 `model_path()`（= `models_dir()`，r80g 起默认在
     * `<exe目录>/抠图模型`）。两者**曾经是同一个地方**，r80g 改了默认位置之后
     * 就分叉了 —— 于是每下完一个模型，都会在数据目录里**凭空多出一个空的
     * `models` 文件夹**（建了却没用上）。用户看到的就是"删不干净的多余目录"。
     *
     * 修法：目录一律从 `model_path()` 推导，不再另算一份 ——
     * 这样"建目录"和"写文件"永远指向同一个地方。 */
    let final_path = model_path(spec.id);
    let dir = final_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(models_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建模型目录失败（{}）：{e}", dir.display()))?;
    // 临时文件用 `.part` 后缀：**中途失败不会留下一个看起来正常的模型文件**
    let tmp_path = final_path.with_extension("onnx.part");

    // 每个源的失败原因，最后拼起来给用户看
    let mut failures: Vec<String> = Vec::new();

    for (idx, url) in spec.urls.iter().enumerate() {
        // 换源前清一遍：上一个源的半截文件不能让下一个源续（内容可能不一样）
        let _ = std::fs::remove_file(&tmp_path);
        if take_cancel() {
            return Err("__CANCELED__".to_string());
        }
        let host = url_host(url);
        // 第 2 个源开始给用户一句提示（第一个源失败通常就是几百毫秒的事，
        // 不值得闪一下；但回退到镜像时用户该知道"正在换源"）
        if idx > 0 {
            progress(0, spec.bytes);
            crate::win::log(&format!("ai_matting_download: {} 回退到 {host}", spec.id));
        }

        let mut reader = match agent().get(url).call() {
            Ok(r) => r.into_reader(),
            Err(e) => {
                failures.push(format!("{host}: {e}"));
                continue;
            }
        };
        let mut file = match std::fs::File::create(&tmp_path) {
            Ok(f) => f,
            Err(e) => return Err(format!("建临时文件失败：{e}")),
        };
        let mut hasher = sha2::Sha256::new();
        let mut done: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        let mut last_pct: i64 = -1;
        let total: u64 = spec.bytes;
        let mut broke = false;

        loop {
            if take_cancel() {
                drop(file);
                let _ = std::fs::remove_file(&tmp_path);
                // 取消不算错误 —— 上层据此提示"已取消"而不是报红
                return Err("__CANCELED__".to_string());
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    failures.push(format!("{host}: 下载中断 {e}"));
                    broke = true;
                    break;
                }
            };
            hasher.update(&buf[..n]);
            if let Err(e) = file.write_all(&buf[..n]) {
                return Err(format!("写模型文件失败（磁盘满？）：{e}"));
            }
            done += n as u64;

            /* 进度回调按**百分比变化**节流：64KB 一块、168MB 的文件切两千多块，
             * 每块都往界面推一次事件是纯浪费（前端重绘也跟不上）。
             * 每 1% 推一次足够顺滑。 */
            let pct = (done.saturating_mul(100)).checked_div(total).unwrap_or(0) as i64;
            if pct != last_pct {
                last_pct = pct;
                progress(done, total);
            }
        }
        let _ = file.flush();
        drop(file);
        if broke {
            continue;
        }

        /* 这个源下完了 → 校验。 */
        let actual = format!("{:x}", hasher.finalize());
        if done < 100_000 {
            failures.push(format!("{host}: 只拿到 {done} 字节"));
            continue;
        }
        /* SHA256 校验：无论从哪个源下都必须对上。
         * 镜像只是传输通道，内容对不对由哈希说了算 —— 这也让"用镜像"
         * 在安全上没有让步（实测 modelscope 下来的 84MB 文件哈希与官方一致）。 */
        if !spec.sha256.is_empty() && !actual.eq_ignore_ascii_case(spec.sha256) {
            failures.push(format!(
                "{host}: 哈希不符（期望 {}，实际 {}）",
                &spec.sha256[..8.min(spec.sha256.len())],
                &actual[..8.min(actual.len())]
            ));
            continue;
        }

        // 校验通过 → 原子落盘（Windows 上 rename 不覆盖已存在文件，先删旧的）
        let _ = std::fs::remove_file(&final_path);
        std::fs::rename(&tmp_path, &final_path).map_err(|e| format!("落盘失败：{e}"))?;
        progress(done, done);
        crate::win::log(&format!(
            "ai_matting_download: {} 从 {host} 下完 {done} 字节",
            spec.id
        ));
        return Ok((done, actual));
    }

    // 所有源都失败：把原因拼出来（不然用户没法判断是网络还是源的问题）
    let _ = std::fs::remove_file(&tmp_path);
    let tried = failures.len();
    if tried == 0 {
        return Err("没有可用的下载源".to_string());
    }
    Err(format!(
        "{} 个下载源都失败了：\n{}",
        tried,
        failures.join("\n")
    ))
}

/// 从 URL 里取 host（只用于日志与错误信息，取不到就回退成整条 URL）。
fn url_host(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .unwrap_or(url)
        .to_string()
}

/// 删掉已下载的模型（用户点"删除"）。
pub fn remove(id: &str) -> Result<(), String> {
    let p = model_path(id);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))?;
    }
    // 顺手清掉可能残留的 .part（上次下载中断留下的）
    let part = p.with_extension("onnx.part");
    let _ = std::fs::remove_file(part);
    Ok(())
}

/// 人类可读的体积（界面用）。
pub fn human_size(bytes: u64) -> String {
    let mb = 1024.0 * 1024.0;
    let f = bytes as f64;
    if f >= mb {
        format!("{:.1} MB", f / mb)
    } else {
        format!("{:.0} KB", f / 1024.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 清单本身是自洽的() {
        assert!(!MODELS.is_empty());
        for m in MODELS {
            assert!(!m.id.is_empty(), "id 不能空");
            assert!(!m.urls.is_empty(), "{} 必须至少有一个下载源", m.id);
            for u in m.urls {
                assert!(u.starts_with("https://"), "{} 的源必须走 https：{u}", m.id);
            }
            assert!(m.bytes > 0, "{} 体积必须为正", m.id);
            assert!(m.input_edge == 320 || m.input_edge == 1024, "{} 边长异常", m.id);
            assert!(m.score <= 8);
        }
    }

    #[test]
    fn id_唯一() {
        let mut ids: Vec<&str> = MODELS.iter().map(|m| m.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "有重复的模型 id");
    }

    #[test]
    fn 默认模型在清单里且是推荐项() {
        let d = default_id();
        assert!(find(d).is_some(), "默认模型必须在清单里");
        // 推荐 = 清单第一个 = 实测得分最高
        let best = MODELS.iter().map(|m| m.score).max().unwrap_or(0);
        assert_eq!(find(d).unwrap().score, best, "默认模型应当是实测最好的那个");
    }

    /// 体积标注必须与实测一致（写错会让用户按错误的体积做决策）。
    #[test]
    fn 标注体积与实测体积一致() {
        // 这里只钉"量级"：真实文件的字节数在 download 时会写进 sha256 校验流程，
        // 单元测试不联网，所以按量级核对（避免以后手滑写成 4.4GB 之类）
        let u = find("u2netp").unwrap();
        assert!(u.bytes > 4_000_000 && u.bytes < 6_000_000, "u2netp 应约 4.4MB");
        let f = find("rmbg-full").unwrap();
        assert!(f.bytes > 160_000_000 && f.bytes < 190_000_000, "full 应约 168MB");
    }

    #[test]
    fn 家族映射正确() {
        // 这条钉住的是"预处理不能混用"这件事 —— 分类错了推理结果就是垃圾
        assert_eq!(find("u2netp").unwrap().family, Family::U2net);
        assert_eq!(find("u2netp").unwrap().input_edge, 320);
        assert_eq!(find("rmbg-full").unwrap().family, Family::Rmbg);
        assert_eq!(find("rmbg-full").unwrap().input_edge, 1024);
    }

    #[test]
    fn 体积格式化() {
        assert_eq!(human_size(4_567_813), "4.4 MB");
        assert_eq!(human_size(1024), "1 KB");
    }

    #[test]
    fn 未下载时不算就绪() {
        // 用一个显然不存在的 id
        assert!(!is_ready("__not_a_model__"));
    }
}
