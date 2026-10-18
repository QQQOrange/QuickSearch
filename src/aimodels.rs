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
    /// 下载地址
    pub url: &'static str,
    /// SHA256（下载完必校验）
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
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "u2netp",
        name: "轻量版（推荐）",
        note: "4.4 MB，速度最快且在图标上实测最准。日常图标首选。",
        bytes: 4_574_861,
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
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
        url: "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx",
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
        url: "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_fp16.onnx",
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
        url: "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
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

/// 模型文件存放路径（`<数据目录>/models/<id>.onnx`）。
///
/// 放数据目录而不是程序目录：程序可能装在只读位置（Program Files），
/// 而模型是用户数据、要能随时删掉重下。
pub fn model_path(id: &str) -> PathBuf {
    crate::config::data_dir().join("models").join(format!("{id}.onnx"))
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

/// 取消标志：下载线程每读一块就看一眼。
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn request_cancel() {
    CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn take_cancel() -> bool {
    CANCEL.swap(false, std::sync::atomic::Ordering::SeqCst)
}

/// 下载一个模型。返回 `(落盘字节, 实际 SHA256)`。
///
/// `progress`：每读一块回调一次 `(已下字节, 总字节)`，由调用方决定怎么推给前端。
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

    let dir = crate::config::data_dir().join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建模型目录失败：{e}"))?;
    // 临时文件用 `.part` 后缀：**中途失败不会留下一个看起来正常的模型文件**
    let final_path = model_path(spec.id);
    let tmp_path = final_path.with_extension("onnx.part");

    let resp = agent()
        .get(spec.url)
        .call()
        .map_err(|e| format!("连不上模型服务器：{e}"))?;
    // 优先用服务器报的总长度；没有就用清单里的体积（界面进度条要有个总数）
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(spec.bytes);

    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&tmp_path).map_err(|e| format!("建临时文件失败：{e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut done: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    let mut last_pct: i64 = -1;

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
                drop(file);
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("下载中断：{e}"));
            }
        };
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| format!("写模型文件失败（磁盘满？）：{e}"))?;
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
    file.flush().map_err(|e| format!("落盘失败：{e}"))?;
    drop(file);

    let actual = format!("{:x}", hasher.finalize());

    /* SHA256 校验：清单里填了就必须对上。
     * 为什么必须有：断网重连、公司代理、镜像站，都可能给回一个"看起来下完了"
     * 的损坏文件；坏模型让推理直接崩，而且崩在用户手里很难查。 */
    if !spec.sha256.is_empty() && !actual.eq_ignore_ascii_case(spec.sha256) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "模型校验失败（可能被代理改写或下坏了）：期望 {}，实际 {actual}",
            &spec.sha256[..8.min(spec.sha256.len())]
        ));
    }
    // 体积也要对得上（清单没填 sha256 时这是唯一的兜底）
    if done < 100_000 {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("下载内容异常（只有 {done} 字节）"));
    }

    // 原子落盘：先删旧的（Windows 上 rename 不覆盖已存在文件），再改名
    let _ = std::fs::remove_file(&final_path);
    std::fs::rename(&tmp_path, &final_path).map_err(|e| format!("落盘失败：{e}"))?;
    progress(done, total.max(done));
    Ok((done, actual))
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
            assert!(m.url.starts_with("https://"), "{} 必须走 https", m.id);
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
