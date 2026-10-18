//! 在线 OCR 引擎注册表 + 各家 API 的调用实现（需求 2）。
//!
//! 用户原话：**"多添加一些在线 OCR 的方式，在线 OCR 的引擎。尽可能的多添加
//! （每一个在线引擎旁边加一个问号按钮，点击后跳转到申请 api 的官方教程）"**
//!
//! 设计要点：
//!
//! ① **注册表是一张常量表**（[`ENGINES`]）：id / 显示名 / 申请页 / 文档页 /
//!    需要哪几样凭据 / 预置 base_url 与模型名。设置页的引擎列表和每个引擎旁边
//!    那个问号按钮**全部由它生成** —— 加一家新引擎只需要在这里加一行，
//!    界面自动跟上，不会出现"后端加了、界面上找不到"的错位。
//!
//! ② **三类调用形状**，新接一家的成本差别很大：
//!      · 专用 REST：百度（走 [`crate::ocr`] 那套 token）、腾讯云（TC3 签名）、
//!        有道智云（v3 签名）、OCR.space（一个 key 一张表单）、Mistral OCR；
//!      · **OpenAI 兼容的视觉模型**：智谱 / 通义千问 / 火山方舟 / 硅基流动 /
//!        Moonshot / OpenAI / Gemini / OpenRouter / 自定义 —— 这九家共用
//!        **一份实现**，只靠 base_url + model 区分，所以"多接一家"接近零成本；
//!      · 本机 Windows OCR（离线、免凭据，见 [`crate::ocr::recognize_local`]）。
//!
//! ③ **所有端点都能注入**（[`OcrUrls`]）：单测把它指向本地仿真服务，就能在
//!    不消耗任何真实额度、不需要账号的前提下，把「请求拼装 / 签名 / 结果解析 /
//!    错误翻译」整条验一遍。生产路径只用 `OcrUrls::default()`。
//!
//! ⚠ 诚实边界：没有各家的 API Key，就无法端到端验证"识别得对不对"。
//!   本模块的测试覆盖到**请求构造与响应解析**为止，真实识别要用户填了 Key
//!   才能跑（设置页里每家都有「测试」入口和申请教程链接）。

use serde_json::Value;

/// 引擎的调用形状。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// 本机 Windows OCR（离线、免凭据）
    Local,
    /// 百度智能云（走 ocr.rs 里那套 token + 高精度/标准版）
    Baidu,
    OcrSpace,
    Youdao,
    Tencent,
    Mistral,
    /// OpenAI 兼容的视觉模型（一家实现覆盖多家）
    OpenAi,
}

impl Kind {
    /// 给前端的稳定标识（设置页据此决定"要不要显示模型那一栏"）。
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Local => "local",
            Kind::Baidu => "baidu",
            Kind::OcrSpace => "ocrspace",
            Kind::Youdao => "youdao",
            Kind::Tencent => "tencent",
            Kind::Mistral => "mistral",
            Kind::OpenAi => "openai",
        }
    }

    /// OpenAI 兼容那几家才有 `GET {base}/models`（可以拉模型列表让用户挑）。
    ///
    /// ⚠ 专用 OCR 接口（百度/腾讯/有道/OCR.space/Mistral）**没有**这种列表接口，
    ///   界面就不该给"拉取模型"的按钮 —— 给了点下去只能失败。
    pub fn has_models(self) -> bool {
        matches!(self, Kind::OpenAi)
    }

    /// 是不是"靠模型名工作"的那类：模型那一栏对它们**总是**显示
    /// （哪怕注册表预置了默认模型 —— 用户有权知道自己会调哪个、也有权换）。
    pub fn needs_model_row(self) -> bool {
        matches!(self, Kind::OpenAi)
    }
}

/// 一家引擎的全部静态信息。界面（引擎列表、问号按钮、凭据表单）全由它驱动。
pub struct EngineInfo {
    pub id: &'static str,
    /// 显示名。也用作并行结果里的【标注】文字（所以本地/百度这两条与老版本一致）
    pub name: &'static str,
    pub kind: Kind,
    /// **申请 API Key 的官方页面** —— 问号按钮点开就是它
    pub signup: &'static str,
    /// 官方接口文档
    pub docs: &'static str,
    /// 主凭据（API Key / SecretId / 应用 ID / Bearer token）
    pub need_key: bool,
    /// 副凭据（SecretKey / 应用密钥）
    pub need_secret: bool,
    /// 视觉模型名（OpenAI 兼容那几家要）
    pub need_model: bool,
    /// 需要用户自己填 base_url（只有「自定义」）
    pub need_base: bool,
    /// 预置 base_url（OpenAI 兼容那几家）
    pub base: &'static str,
    /// 预置模型名
    pub model: &'static str,
    /// 界面上那行小字：免费额度、注意事项
    pub note: &'static str,
}

/// 全部引擎。顺序 = 设置页列表里的顺序：
/// 先「不用花钱、不用注册」的本地，再国内的云厂商，再视觉大模型，最后自定义。
pub static ENGINES: &[EngineInfo] = &[
    EngineInfo {
        id: "windows",
        name: "本地识别",
        kind: Kind::Local,
        signup: "https://learn.microsoft.com/zh-cn/windows/uwp/launch-resume/ocr",
        docs: "https://learn.microsoft.com/zh-cn/uwp/api/windows.media.ocr.ocrngine",
        need_key: false,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "",
        model: "",
        note: "离线、免费、最快，不联网也不上传截图；需要系统装了对应语言的 OCR 语言包",
    },
    EngineInfo {
        id: "baidu",
        name: "百度云",
        kind: Kind::Baidu,
        signup: "https://console.bce.baidu.com/ai-engine/ocr/overview/index",
        docs: "https://cloud.baidu.com/doc/OCR/s/Ek3h7xypm",
        need_key: true,
        need_secret: true,
        need_model: false,
        need_base: false,
        base: "",
        model: "",
        note: "注册即送每日免费额度；「高精度版」是按量付费的，没开通就用标准版",
    },
    EngineInfo {
        id: "tencent",
        name: "腾讯云",
        kind: Kind::Tencent,
        signup: "https://console.cloud.tencent.com/capi",
        docs: "https://cloud.tencent.com/document/api/866/34937",
        need_key: true,
        need_secret: true,
        need_model: false,
        need_base: false,
        base: "",
        model: "",
        note: "填 SecretId / SecretKey（不是 API 密钥）；通用印刷体识别每月有免费额度",
    },
    EngineInfo {
        id: "youdao",
        name: "有道智云",
        kind: Kind::Youdao,
        signup: "https://ai.youdao.com/console/#/app",
        docs: "https://ai.youdao.com/DOCSIRMA/html/ocr/api/txtsb/index.html",
        need_key: true,
        need_secret: true,
        need_model: false,
        need_base: false,
        base: "",
        model: "",
        note: "填「应用 ID」和「应用密钥」；有免费体验量",
    },
    EngineInfo {
        id: "ocrspace",
        name: "OCR.space",
        kind: Kind::OcrSpace,
        signup: "https://ocr.space/ocrapi/freekey",
        docs: "https://ocr.space/ocrapi",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "",
        model: "",
        note: "注册一个邮箱就能拿免费 Key（每月 25000 次），不用绑卡",
    },
    EngineInfo {
        id: "mistral",
        name: "Mistral OCR",
        kind: Kind::Mistral,
        signup: "https://console.mistral.ai/api-keys",
        docs: "https://docs.mistral.ai/capabilities/OCR/basic_ocr/",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "",
        model: "",
        note: "专门做 OCR 的接口，输出 Markdown（保留标题/表格结构）",
    },
    EngineInfo {
        id: "zhipu",
        name: "智谱 GLM-4V",
        kind: Kind::OpenAi,
        signup: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
        docs: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4v-flash",
        note: "glm-4v-flash 是免费档；要更强的识别换 glm-4v-plus",
    },
    EngineInfo {
        id: "dashscope",
        name: "通义千问",
        kind: Kind::OpenAi,
        signup: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
        docs: "https://help.aliyun.com/zh/model-studio/qwen-vl-ocr",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-vl-ocr",
        note: "qwen-vl-ocr 是专门的 OCR 模型；新用户有免费额度",
    },
    EngineInfo {
        id: "ark",
        name: "火山方舟",
        kind: Kind::OpenAi,
        signup: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
        docs: "https://docs.volcengine.com/docs/ark/api-key",
        need_key: true,
        need_secret: false,
        need_model: true,
        need_base: false,
        base: "https://ark.cn-beijing.volces.com/api/v3",
        model: "",
        note: "要填「推理接入点 ID」（ep- 开头）或模型名，豆包视觉模型都能用",
    },
    EngineInfo {
        id: "siliconflow",
        name: "硅基流动",
        kind: Kind::OpenAi,
        signup: "https://cloud.siliconflow.cn/account/ak",
        docs: "https://docs.siliconflow.cn/docs/api/chat-completions-post",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://api.siliconflow.cn/v1",
        model: "Qwen/Qwen2.5-VL-32B-Instruct",
        note: "国内直连、聚合了很多开源视觉模型，小模型有免费额度",
    },
    EngineInfo {
        id: "moonshot",
        name: "Kimi",
        kind: Kind::OpenAi,
        // ⚠ 月之暗面已把控制台和文档从 platform.moonshot.cn 迁到 platform.kimi.com
        //   （老域名 302 跳转）—— 这里直接用新域名，少一次跳转
        signup: "https://platform.kimi.com/console/api-keys",
        docs: "https://platform.kimi.com/docs/api/chat",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-8k-vision-preview",
        note: "月之暗面 Kimi 的视觉模型",
    },
    EngineInfo {
        id: "openai",
        name: "OpenAI",
        kind: Kind::OpenAi,
        signup: "https://platform.openai.com/api-keys",
        docs: "https://platform.openai.com/docs/guides/vision",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        note: "国内网络需要能直连 api.openai.com",
    },
    EngineInfo {
        id: "gemini",
        name: "Google Gemini",
        kind: Kind::OpenAi,
        signup: "https://aistudio.google.com/app/apikey",
        docs: "https://ai.google.dev/gemini-api/docs/openai",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.0-flash",
        note: "AI Studio 里点一下就有免费 Key；走的是它的 OpenAI 兼容层",
    },
    EngineInfo {
        id: "openrouter",
        name: "OpenRouter",
        kind: Kind::OpenAi,
        signup: "https://openrouter.ai/keys",
        docs: "https://openrouter.ai/docs/api_reference/overview",
        need_key: true,
        need_secret: false,
        need_model: false,
        need_base: false,
        base: "https://openrouter.ai/api/v1",
        model: "google/gemini-2.0-flash-001",
        note: "一个 Key 转发上百个模型（含各家免费档），模型名要带厂商前缀",
    },
    EngineInfo {
        id: "custom",
        name: "自定义（OpenAI 兼容）",
        kind: Kind::OpenAi,
        signup: "https://platform.openai.com/docs/api-reference/chat",
        docs: "https://platform.openai.com/docs/api-reference/chat/create",
        need_key: true,
        need_secret: false,
        need_model: true,
        need_base: true,
        base: "",
        model: "",
        note: "任何 OpenAI 兼容的接口都行：本地 Ollama/LM Studio、公司内网网关、其它云厂商",
    },
];

/// 按 id 查一家引擎。
pub fn find(id: &str) -> Option<&'static EngineInfo> {
    ENGINES.iter().find(|e| e.id == id)
}

/// 这家引擎是不是"在线"的（本地那家不算 —— 界面上只有在线的才配问号按钮）。
pub fn is_online(id: &str) -> bool {
    find(id).map(|e| e.kind != Kind::Local).unwrap_or(false)
}

/// 一家引擎的凭据。四个字段对应注册表里的 need_* ——
/// 界面上填哪个、后端读哪个，都由同一张表决定，不会错位。
#[derive(Clone, Debug, Default)]
pub struct Creds {
    /// API Key / SecretId / 应用 ID / Bearer token
    pub key: String,
    /// SecretKey / 应用密钥（只有百度、腾讯云、有道要）
    pub secret: String,
    /// OpenAI 兼容接口的 base_url（只有「自定义」要用户填）
    pub base: String,
    /// 视觉模型名
    pub model: String,
}

impl Creds {
    /// 实际要用的 base_url：用户填了就用用户的，否则用注册表里的预置值。
    pub fn base_for(&self, info: &EngineInfo) -> String {
        let b = self.base.trim();
        if !b.is_empty() {
            b.trim_end_matches('/').to_string()
        } else {
            info.base.trim_end_matches('/').to_string()
        }
    }

    /// 实际要用的模型名：同上。
    pub fn model_for(&self, info: &EngineInfo) -> String {
        let m = self.model.trim();
        if !m.is_empty() {
            m.to_string()
        } else {
            info.model.to_string()
        }
    }
}

/// 所有端点。**生产只用 default()**，测试把它指向本地仿真服务。
#[derive(Clone, Debug)]
pub struct OcrUrls {
    pub ocrspace: String,
    pub youdao: String,
    pub tencent: String,
    pub mistral: String,
}

impl Default for OcrUrls {
    fn default() -> Self {
        Self {
            ocrspace: "https://api.ocr.space/parse/image".to_string(),
            youdao: "https://openapi.youdao.com/ocrai".to_string(),
            tencent: "https://ocr.tencentcloudapi.com/".to_string(),
            mistral: "https://api.mistral.ai/v1/ocr".to_string(),
        }
    }
}

/// 统一入口：按引擎 id 分派。**所有**识别路径都从这里走，
/// 上层（main.rs）只需要知道 id + 凭据。
pub fn recognize(
    id: &str,
    c: &Creds,
    png: &[u8],
    lang: &str,
    accurate: bool,
    timeout_secs: u64,
    urls: &OcrUrls,
) -> Result<crate::ocr::Outcome, String> {
    let info = find(id).ok_or_else(|| format!("不认识的识别引擎：{id}"))?;
    match info.kind {
        Kind::Local => crate::ocr::recognize_local(png).map(|text| crate::ocr::Outcome {
            text,
            engine: info.name,
        }),
        // 百度那条路自带 token 缓存、高精度/标准版、错误码翻译，原样复用
        Kind::Baidu => crate::ocr::recognize_with(
            &c.key,
            &c.secret,
            png,
            lang,
            accurate,
            timeout_secs,
            &crate::ocr::Endpoints::default(),
        ),
        Kind::OcrSpace => ocrspace(&c.key, png, lang, timeout_secs, urls),
        Kind::Youdao => youdao(&c.key, &c.secret, png, timeout_secs, urls),
        Kind::Tencent => tencent(&c.key, &c.secret, png, accurate, timeout_secs, urls),
        Kind::Mistral => mistral(&c.key, png, timeout_secs, urls),
        Kind::OpenAi => {
            let base = c.base_for(info);
            let model = c.model_for(info);
            openai_compat(&c.key, &base, &model, png, lang, timeout_secs, info.name)
        }
    }
}

/* ============================ 通用小工具 ============================ */

/// 按**字节内容**判图片格式（不看文件名，也不看调用方声称的格式）。
///
/// ⚠ 为什么必须这样：框选那条路编的是 **JPEG**（用户抱怨 OCR 慢，量下来大头是
///   PNG 编码，所以截图线程直接出 JPEG，见 main.rs 里那段注释）。以前这里把
///   data URL 的 MIME **写死成 image/png**，等于把一张 JPEG 谎称成 PNG ——
///   严格的网关会直接 400/415 拒掉。所以按魔数认，认不出才退回 png（与旧行为一致）。
pub fn mime_of_bytes(b: &[u8]) -> &'static str {
    if b.len() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
        "image/jpeg"
    } else if b.len() >= 8 && &b[0..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.len() >= 2 && &b[0..2] == b"BM" {
        "image/bmp"
    } else if b.len() >= 4 && (&b[0..4] == b"GIF8") {
        "image/gif"
    } else {
        "image/png"
    }
}

/// 图片字节 → `data:` URL（MIME 按真实内容给）。
pub fn data_url(bytes: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        mime_of_bytes(bytes),
        crate::config::base64(bytes)
    )
}

/// 十六进制小写。
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// SHA-256 的十六进制小写（腾讯云 TC3、有道 v3 都要）。
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

/// HMAC-SHA256 的原始字节（腾讯云 TC3 的派生密钥要一层层套）。
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    let mut m = <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// 把 epoch 秒换成 UTC 的 `YYYY-MM-DD`（腾讯云 TC3 的日期串）。
///
/// 项目里没有 chrono，也不想为一个日期格式引一个依赖 —— 用 Howard Hinnant 的
/// civil_from_days（公历换算的标准做法，1900~2100 都对）。
pub fn utc_date(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86400) as i64;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 截断长文本（错误信息里带上响应体，但别把几 MB 塞进日志）。
fn truncate(s: &str, max: usize) -> String {
    let t: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        format!("{t}…")
    } else {
        t
    }
}

/// 拼 URL：base 去掉尾斜杠 + path（path 自带前导斜杠）。
fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn post_json(
    url: &str,
    headers: &[(&str, &str)],
    body: &Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let a = crate::ocr::agent(timeout_secs);
    let mut req = a.post(url).set("Content-Type", "application/json");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    let resp = req.send_string(&body.to_string()).map_err(|e| {
        // ureq 的 Status 错误里也带着响应体，错误信息要尽量给出真原因
        // ⚠ 这里必须**按值** match：读响应体要消费掉 Response（ureq 2.x 没有
        //   借用的读法），拿 &e 去 match 根本读不到 body。
        match e {
            ureq::Error::Status(code, r) => {
                // ⚠ 这里以前用 `r.status_text()` —— 那只是 "Forbidden" 这种**状态短语**，
                //   对方真正说的话在**响应体**里（硅基流动会回 {"message":"…"}）。
                //   把它丢掉，用户就只能对着「HTTP 403（Forbidden）」干瞪眼 ——
                //   而"密钥无效"和"余额不足"是两件完全不同的事。
                let body = r.into_string().unwrap_or_default();
                format!("{url} 返回 HTTP {code}：{}", vendor_msg(&body))
            }
            other => crate::ocr::explain(&other),
        }
    })?;
    let text = resp
        .into_string()
        .map_err(|e| format!("读响应失败：{e}"))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("返回的不是 JSON：{e}（{}）", truncate(&text, 200)))
}

fn post_form(
    url: &str,
    headers: &[(&str, &str)],
    form: &[(&str, String)],
    timeout_secs: u64,
) -> Result<Value, String> {
    let a = crate::ocr::agent(timeout_secs);
    let pairs: Vec<(&str, &str)> = form.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut req = a
        .post(url)
        .set("Content-Type", "application/x-www-form-urlencoded");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    let resp = req.send_form(&pairs).map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                format!("{url} 返回 HTTP {code}：{}", vendor_msg(&body))
            }
            other => crate::ocr::explain(&other),
        })?;
    let text = resp
        .into_string()
        .map_err(|e| format!("读响应失败：{e}"))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("返回的不是 JSON：{e}（{}）", truncate(&text, 200)))
}

/// 视觉模型的输出常常被包在 ``` 围栏里（哪怕提示词里说了不要）。
/// 这里统一剥掉，用户复制出去的就是干净文字。
pub fn strip_fences(s: &str) -> String {
    let t = s.trim();
    let t = if let Some(rest) = t.strip_prefix("```") {
        // 去掉可能跟着的语言标记（```markdown / ```text）
        let rest = match rest.find('\n') {
            Some(i) => &rest[i + 1..],
            None => rest,
        };
        rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
    } else {
        t
    };
    t.to_string()
}

fn empty_result() -> String {
    "这一块里没认出文字，换个区域或放大点试试".to_string()
}

/* ============================ 各家实现 ============================ */

/// OCR.space：一个 Key + 一张表单，接起来最简单的一家（免费档每月 25000 次）。
fn ocrspace(
    key: &str,
    png: &[u8],
    lang: &str,
    timeout_secs: u64,
    urls: &OcrUrls,
) -> Result<crate::ocr::Outcome, String> {
    if key.trim().is_empty() {
        return Err("还没填 OCR.space 的 API Key（旁边问号按钮里有申请地址）".into());
    }
    let form = vec![
        ("apikey", key.trim().to_string()),
        ("language", ocrspace_lang(lang).to_string()),
        ("isOverlayRequired", "false".to_string()),
        ("scale", "true".to_string()),
        ("OCREngine", "2".to_string()),
        (
            "base64Image",
            data_url(png),
        ),
    ];
    // ⚠ Key 同时放**请求头**和表单字段：OCR.space 两种都认，官方示例是
    //   multipart + 表单字段；放头里更不容易被表单编码问题吃掉。
    let v = post_form(
        &urls.ocrspace,
        &[("apikey", key.trim())],
        &form,
        timeout_secs,
    )?;
    let text = parse_ocrspace(&v)?;
    Ok(crate::ocr::Outcome {
        text,
        engine: "OCR.space",
    })
}

/// OCR.space 的语言码（它用的是 ISO 639-3 那一套：中文 chs、英文 eng）。
pub fn ocrspace_lang(lang: &str) -> &'static str {
    match lang {
        "ENG" | "eng" => "eng",
        _ => "chs",
    }
}

/// 解析 OCR.space 的响应。抽出来单独测（不联网也能验"错误怎么说、文字怎么拼"）。
pub fn parse_ocrspace(v: &Value) -> Result<String, String> {
    if v.get("IsErroredOnProcessing")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        let msg = v
            .get("ErrorMessage")
            .map(|m| match m {
                Value::Array(a) => a
                    .iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join("；"),
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "原因未知".into());
        return Err(format!("OCR.space 报错：{msg}"));
    }
    let mut out = String::new();
    if let Some(arr) = v.get("ParsedResults").and_then(|x| x.as_array()) {
        for r in arr {
            if let Some(t) = r.get("ParsedText").and_then(|x| x.as_str()) {
                let t = t.trim_end();
                if !t.trim().is_empty() {
                    out.push_str(t);
                    out.push('\n');
                }
            }
        }
    }
    let out = out.trim_end().to_string();
    if out.is_empty() {
        return Err(empty_result());
    }
    Ok(out)
}

/// 有道智云：v3 签名，凭据是「应用 ID + 应用密钥」。
fn youdao(
    key: &str,
    secret: &str,
    png: &[u8],
    timeout_secs: u64,
    urls: &OcrUrls,
) -> Result<crate::ocr::Outcome, String> {
    if key.trim().is_empty() || secret.trim().is_empty() {
        return Err("有道智云要同时填「应用 ID」和「应用密钥」".into());
    }
    let img = crate::config::base64(png);
    let salt = format!("{:x}", now_secs());
    let curtime = now_secs().to_string();
    let sign = youdao_sign(key.trim(), &img, &salt, &curtime, secret.trim());
    let form = vec![
        ("img", img),
        ("langType", "auto".to_string()),
        ("detectType", "10012".to_string()),
        ("imageType", "1".to_string()),
        ("appKey", key.trim().to_string()),
        ("salt", salt),
        ("curtime", curtime),
        ("sign", sign),
        ("signType", "v3".to_string()),
    ];
    let v = post_form(&urls.youdao, &[], &form, timeout_secs)?;
    let text = parse_youdao(&v)?;
    Ok(crate::ocr::Outcome {
        text,
        engine: "有道智云",
    })
}

/// 有道 v3 签名：`sha256(appKey + input + salt + curtime + secret)`；
/// 其中 input 在图片 base64 长度超过 20 时取**它的 sha256**（官方文档里的 q 规则）。
pub fn youdao_sign(app_key: &str, img_b64: &str, salt: &str, curtime: &str, secret: &str) -> String {
    let input = if img_b64.chars().count() <= 20 {
        img_b64.to_string()
    } else {
        sha256_hex(img_b64.as_bytes())
    };
    sha256_hex(format!("{app_key}{input}{salt}{curtime}{secret}").as_bytes())
}

/// 解析有道智云的响应：文字在 `Result.regions[].lines[].text`。
pub fn parse_youdao(v: &Value) -> Result<String, String> {
    let code = v
        .get("errorCode")
        .map(|x| match x {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| "-".into());
    if code != "0" {
        // 有道的错误码是字符串（"0" 才是成功），非 0 时没有可用结果
        return Err(format!(
            "有道智云报错 errorCode={code}（0 才是成功；常见 101 缺参数、108 应用不存在、411 权限不足）"
        ));
    }
    let mut lines: Vec<String> = Vec::new();
    if let Some(regions) = v
        .pointer("/Result/regions")
        .and_then(|x| x.as_array())
    {
        for r in regions {
            if let Some(ls) = r.get("lines").and_then(|x| x.as_array()) {
                for l in ls {
                    if let Some(t) = l.get("text").and_then(|x| x.as_str()) {
                        if !t.trim().is_empty() {
                            lines.push(t.trim().to_string());
                        }
                    }
                }
            }
        }
    }
    if lines.is_empty() {
        return Err(empty_result());
    }
    Ok(lines.join("\n"))
}

/// 腾讯云：TC3-HMAC-SHA256 签名，凭据是 SecretId / SecretKey。
fn tencent(
    secret_id: &str,
    secret_key: &str,
    png: &[u8],
    accurate: bool,
    timeout_secs: u64,
    urls: &OcrUrls,
) -> Result<crate::ocr::Outcome, String> {
    if secret_id.trim().is_empty() || secret_key.trim().is_empty() {
        return Err("腾讯云要同时填 SecretId 和 SecretKey（在「访问管理 → API 密钥管理」里）".into());
    }
    let action = if accurate {
        "GeneralAccurateOCR"
    } else {
        "GeneralBasicOCR"
    };
    let body = serde_json::json!({ "ImageBase64": crate::config::base64(png) });
    let payload = body.to_string();
    let host = host_of(&urls.tencent);
    let ts = now_secs();
    let date = utc_date(ts);
    let scope = format!("{date}/ocr/tc3_request");
    let canonical = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{host}\n\ncontent-type;host\n{}",
        sha256_hex(payload.as_bytes())
    );
    let sts = format!(
        "TC3-HMAC-SHA256\n{ts}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let k_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let k_service = hmac_sha256(&k_date, b"ocr");
    let k_signing = hmac_sha256(&k_service, b"tc3_request");
    let signature = hex(&hmac_sha256(&k_signing, sts.as_bytes()));
    let auth = format!(
        "TC3-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=content-type;host, Signature={signature}",
        secret_id.trim()
    );
    let headers = [
        ("Authorization", auth.as_str()),
        ("X-TC-Action", action),
        ("X-TC-Version", "2018-11-19"),
        ("X-TC-Timestamp", &ts.to_string()),
        ("X-TC-Region", "ap-guangzhou"),
    ];
    let v = post_json(&urls.tencent, &headers, &body, timeout_secs)?;
    let text = parse_tencent(&v)?;
    Ok(crate::ocr::Outcome {
        text,
        engine: "腾讯云",
    })
}

/// 从错误响应体里挖出对方**真正说的那句话**。
///
/// 各家形状不一：`{"error":{"message":…}}`（OpenAI 系）、`{"message":…}`、
/// `{"error":"…"}`、`{"msg":…}`、`{"detail":…}`。都挖不到就把原文截一段 ——
/// 总比只回一句「403 Forbidden」强，用户至少能看出是"密钥无效"还是"余额不足"。
pub fn vendor_msg(body: &str) -> String {
    let t = body.trim();
    if t.is_empty() {
        return "（响应体是空的）".into();
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        let cands = [
            v.pointer("/error/message"),
            v.pointer("/error/msg"),
            v.get("message"),
            v.get("msg"),
            v.get("detail"),
            v.get("error_description"),
            v.get("error").filter(|x| x.is_string()),
        ];
        for c in cands.into_iter().flatten() {
            if let Some(s) = c.as_str() {
                if !s.trim().is_empty() {
                    return truncate(s.trim(), 220);
                }
            }
        }
        // 有 code / error_code 但没 message 的（有些网关这样），至少把码给出来
        for k in ["code", "error_code", "errorCode"] {
            if let Some(c) = v.get(k) {
                if !c.is_null() {
                    return truncate(&format!("code={c}"), 160);
                }
            }
        }
    }
    truncate(t, 220)
}

/// 从 URL 里取主机名（TC3 的规范请求要 host）。
pub fn host_of(url: &str) -> String {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url);
    rest.split(['/', '?']).next().unwrap_or(rest).to_string()
}

/// 解析腾讯云的响应：`Response.TextDetections[].DetectedText`，
/// 出错时 `Response.Error.{Code,Message}`（HTTP 仍然是 200）。
pub fn parse_tencent(v: &Value) -> Result<String, String> {
    let r = v.get("Response").unwrap_or(v);
    if let Some(err) = r.get("Error") {
        let code = err.get("Code").and_then(|x| x.as_str()).unwrap_or("-");
        let msg = err.get("Message").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("腾讯云报错 {code}：{msg}"));
    }
    let mut lines: Vec<String> = Vec::new();
    if let Some(arr) = r.get("TextDetections").and_then(|x| x.as_array()) {
        for d in arr {
            if let Some(t) = d.get("DetectedText").and_then(|x| x.as_str()) {
                if !t.trim().is_empty() {
                    lines.push(t.to_string());
                }
            }
        }
    }
    if lines.is_empty() {
        return Err(empty_result());
    }
    Ok(lines.join("\n"))
}

/// Mistral OCR 的请求体（抽成函数是为了能单测 data URL 的 MIME 口径）。
pub fn mistral_body(png: &[u8]) -> Value {
    serde_json::json!({
        "model": "mistral-ocr-latest",
        "document": {
            "type": "image_url",
            "image_url": data_url(png),
        },
        "include_image_base64": false,
    })
}

/// Mistral OCR：专门做 OCR 的接口，返回的是 Markdown（保留标题/表格结构）。
fn mistral(
    key: &str,
    png: &[u8],
    timeout_secs: u64,
    urls: &OcrUrls,
) -> Result<crate::ocr::Outcome, String> {
    if key.trim().is_empty() {
        return Err("还没填 Mistral 的 API Key".into());
    }
    let body = mistral_body(png);
    let v = post_json(
        &urls.mistral,
        &[("Authorization", &format!("Bearer {}", key.trim()))],
        &body,
        timeout_secs,
    )?;
    let text = parse_mistral(&v)?;
    Ok(crate::ocr::Outcome {
        text,
        engine: "Mistral OCR",
    })
}

/// 解析 Mistral OCR：`pages[].markdown`。
pub fn parse_mistral(v: &Value) -> Result<String, String> {
    let mut out = String::new();
    if let Some(pages) = v.get("pages").and_then(|x| x.as_array()) {
        for p in pages {
            if let Some(md) = p.get("markdown").and_then(|x| x.as_str()) {
                if !md.trim().is_empty() {
                    out.push_str(md.trim_end());
                    out.push('\n');
                }
            }
        }
    }
    let out = out.trim_end().to_string();
    if out.is_empty() {
        return Err(empty_result());
    }
    Ok(out)
}

/// OpenAI 兼容的视觉模型：一份实现覆盖智谱 / 通义 / 方舟 / 硅基流动 / Kimi /
/// OpenAI / Gemini / OpenRouter / 自定义。
fn openai_compat(
    key: &str,
    base: &str,
    model: &str,
    png: &[u8],
    lang: &str,
    timeout_secs: u64,
    name: &'static str,
) -> Result<crate::ocr::Outcome, String> {
    if key.trim().is_empty() {
        return Err(format!("还没填 {name} 的 API Key（旁边问号按钮里有申请地址）"));
    }
    if base.trim().is_empty() {
        return Err(format!("还没填 {name} 的接口地址（base_url）"));
    }
    if model.trim().is_empty() {
        return Err(format!("还没填 {name} 的模型名"));
    }
    let body = openai_body(model, png, lang);
    let url = join_url(base, "/chat/completions");
    let v = post_json(
        &url,
        &[("Authorization", &format!("Bearer {}", key.trim()))],
        &body,
        timeout_secs,
    )?;
    let text = parse_openai(&v)?;
    Ok(crate::ocr::Outcome {
        text,
        engine: name,
    })
}

/// 拼 OpenAI 兼容的请求体。抽出来单独测（图怎么编码、提示词怎么写都在这里）。
pub fn openai_body(model: &str, png: &[u8], lang: &str) -> Value {
    // 提示词要**明确禁止**模型加解释和代码围栏：不然返回的会是
    // "好的，以下是图片中的文字：\n```\n…\n```"，用户还得自己删一遍。
    let prompt = if matches!(lang, "ENG" | "eng") {
        "Extract ALL text from this image exactly as it appears. \
         Output only the text itself — no explanation, no commentary, no markdown code fences. \
         Keep the original line breaks and reading order."
    } else {
        "把这张图里的文字**原样**提取出来，不要翻译、不要改写。\
         只输出文字本身 —— 不要任何解释、不要开场白、不要 markdown 代码块。\
         保持原来的换行和阅读顺序。"
    };
    serde_json::json!({
        "model": model,
        "temperature": 0,
        "max_tokens": 4096,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_url(png)
                    }
                }
            ]
        }]
    })
}

/// 解析 OpenAI 兼容的响应：`choices[0].message.content`。
/// content 既可能是字符串，也可能是 `[{type:"text",text:"…"}]` 这种数组
/// （部分厂商/网关是后者），两种都认。
pub fn parse_openai(v: &Value) -> Result<String, String> {
    // 错误优先：这几家的错误体是 {"error": {...}} 或 {"message": "..."}
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or_else(|| err.as_str().unwrap_or("原因未知"));
        let code = err.get("code").map(|c| c.to_string()).unwrap_or_default();
        return Err(format!("接口报错：{msg} {code}").trim().to_string());
    }
    let c = v.pointer("/choices/0/message/content");
    let raw = match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => {
            // 有些网关把结果放在 choices[0].text（老 completions 形状）
            v.pointer("/choices/0/text")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        }
    };
    let text = strip_fences(&raw);
    if text.trim().is_empty() {
        return Err(empty_result());
    }
    Ok(text)
}

/* ==================== 连通性自检 / 模型列表 ==================== */

/// 自检用的测试图：白底 + 几块黑条。
///
/// 不是给人看的 —— 只是让"必须上传一张图"的接口满意。**故意不画文字**：
/// 各家模型对同一张图认出来的东西不一样，画了字反而会让"认出来没有"变成
/// 判断标准；这里要判断的是**连不连得上、密钥认不认**，不是识别准不准。
///
/// 尺寸给足（96×48）：有些接口对超小图/空图会直接报错，测出来的是它们的
/// 参数校验，不是用户的网络或密钥问题 —— 那种假失败最误导人。
pub fn test_image() -> Vec<u8> {
    let mut img = image::RgbaImage::from_pixel(96, 48, image::Rgba([255, 255, 255, 255]));
    let bars = [
        (10u32, 12u32, 20u32, 36u32),
        (30, 12, 40, 36),
        (50, 12, 74, 20),
        (50, 28, 74, 36),
    ];
    for (x0, y0, x1, y1) in bars {
        for y in y0..y1 {
            for x in x0..x1 {
                img.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
            }
        }
    }
    let mut cur = std::io::Cursor::new(Vec::new());
    // 编码失败是不可能的（内存 buffer + 固定尺寸），真失败也只能是 OOM，
    // 那就返回空图让上层报"图片编码失败"，别 unwrap 把整个进程带走。
    if image::DynamicImage::ImageRgba8(img)
        .write_to(&mut cur, image::ImageFormat::Png)
        .is_err()
    {
        return Vec::new();
    }
    cur.into_inner()
}

/// 「测试」按钮的后端：拿一张自带测试图**真打一次请求**，判断"连得上 + 密钥认"。
///
/// 和 `recognize` 的区别在**判定口径**：这里"接口回了 200、只是这张图上没字"
/// 算**成功**（`empty_result()` 那条错单独认出来）—— 用户点测试是想知道
/// "我填的 Key 到底通不通"，不是想知道这张测试图有没有文字。
/// 反过来，HTTP 403/401、签名错、模型名不存在这些一律如实失败，并带上对方的原话。
pub fn test(id: &str, c: &Creds, urls: &OcrUrls) -> Result<String, String> {
    let info = find(id).ok_or_else(|| format!("不认识的识别引擎：{id}"))?;
    if info.kind == Kind::Local {
        return match crate::ocr::local_available() {
            Ok(_) => Ok("本机 Windows OCR 可用（离线，不需要密钥）".into()),
            Err(e) => Err(e),
        };
    }
    let png = test_image();
    if png.is_empty() {
        return Err("测试图生成失败".into());
    }
    // 百度单独走那条更省的检查：只换一次 access_token，**不占识别配额**
    // （`ocr::check` 就是干这个的）。用户点「测试」只是想确认密钥对不对，
    // 没必要真送一张图去识别。
    if info.kind == Kind::Baidu {
        return match crate::ocr::check(&c.key, &c.secret, 20) {
            Ok(_) => Ok("连上了，密钥有效（百度云那边 access_token 换到了）".into()),
            Err(e) => Err(e),
        };
    }
    match recognize(id, c, &png, "CHN_ENG", false, 20, urls) {
        Ok(o) => {
            let n = o.text.chars().count();
            if n == 0 {
                Ok("连上了，密钥有效（测试图上没有文字，这是正常的）".into())
            } else {
                Ok(format!("连上了，密钥有效（测试图认到 {n} 个字）"))
            }
        }
        // 200 但没认出字 —— 连通性没问题，别把它报成失败
        Err(e) if e == empty_result() => {
            Ok("连上了，密钥有效（测试图上没有文字，这是正常的）".into())
        }
        Err(e) => Err(e),
    }
}

/// 拉一家的模型列表（OpenAI 兼容那几家支持 `GET {base}/models`）。
///
/// 用户原话：「如果是调用 ai，比如说硅基流动，这是一个 ai 的中转站，那这时候
/// 是不是应该添加一个选择模型的功能呢？不然你默认就算填了 api key，它到底调
/// 哪个模型呢？」—— 中转站上有几百个模型，靠用户手打模型名不现实。
pub fn list_models(base: &str, key: &str, timeout_secs: u64) -> Result<Vec<(String, bool)>, String> {
    if key.trim().is_empty() {
        return Err("先填 API Key，再拉模型列表".into());
    }
    if base.trim().is_empty() {
        return Err("这家要先填接口地址（base_url），再拉模型列表".into());
    }
    let url = join_url(base, "/models");
    let a = crate::ocr::agent(timeout_secs);
    let resp = a
        .get(&url)
        .set("Authorization", &format!("Bearer {}", key.trim()))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                format!("{url} 返回 HTTP {code}：{}", vendor_msg(&body))
            }
            other => crate::ocr::explain(&other),
        })?;
    let text = resp
        .into_string()
        .map_err(|e| format!("读响应失败：{e}"))?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("返回的不是 JSON：{e}（{}）", truncate(&text, 160)))?;
    parse_models(&v)
}

/// 解析模型列表：OpenAI 标准是 `data[].id`，也认 `models[].id` 和裸数组。
///
/// `bool` = 名字看着像不像"能看图"的模型（界面据此把候选排前面）。
/// **只是提示，不是白名单** —— 用户照样能选任何一个，不替他做决定。
pub fn parse_models(v: &Value) -> Result<Vec<(String, bool)>, String> {
    let arr = v
        .get("data")
        .and_then(|x| x.as_array())
        .or_else(|| v.get("models").and_then(|x| x.as_array()))
        .or_else(|| v.as_array());
    let Some(arr) = arr else {
        return Err("这个接口没返回模型列表（换一家，或者手填模型名）".into());
    };
    let mut out: Vec<(String, bool)> = Vec::new();
    for m in arr {
        let id = m
            .get("id")
            .and_then(|x| x.as_str())
            .or_else(|| m.get("name").and_then(|x| x.as_str()))
            .or_else(|| m.as_str());
        if let Some(id) = id {
            let id = id.trim();
            if !id.is_empty() {
                out.push((id.to_string(), looks_vision(id)));
            }
        }
    }
    if out.is_empty() {
        return Err("模型列表是空的".into());
    }
    // 像视觉模型的排前面，其余按名字排；同一家可能有重复条目，去重
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.dedup_by(|a, b| a.0 == b.0);
    Ok(out)
}

/// 名字像不像"能看图"的模型。纯启发式：命中就排前面，不命中也照样能选。
pub fn looks_vision(id: &str) -> bool {    let s = id.to_ascii_lowercase();
    // ⚠ 用 "-vl" / "vl-" 这类**带分隔符**的形态，别用裸 "vl"：
    //   裸子串会把无关的名字也算进来（"solver"、"revolve" 之类）。
    if s.contains("-vl") || s.contains("vl-") || s.contains("_vl") || s.contains("/vl") {
        return true;
    }
    const HINTS: &[&str] = &[
        "vision",
        "ocr",
        "glm-4v",
        "gpt-4o",
        "gpt-4.1",
        "gpt-5",
        "gemini",
        "claude",
        "pixtral",
        "internvl",
        "llava",
        "minicpm-v",
        "qvq",
        "multimodal",
        "omni",
        "grok-2-vision",
        "step-1v",
    ];
    HINTS.iter().any(|h| s.contains(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- 注册表本身（需求 2 的"每个在线引擎都有申请入口"） ---------- */

    #[test]
    fn every_engine_has_a_real_help_link() {
        for e in ENGINES {
            assert!(
                e.signup.starts_with("https://"),
                "{} 的申请页必须是 https：{}",
                e.id,
                e.signup
            );
            assert!(
                e.docs.starts_with("https://"),
                "{} 的文档页必须是 https：{}",
                e.id,
                e.docs
            );
            assert!(!e.name.trim().is_empty(), "{} 没有显示名", e.id);
            assert!(!e.note.trim().is_empty(), "{} 没有界面说明", e.id);
        }
    }

    #[test]
    fn engine_ids_are_unique_and_online_set_is_big_enough() {
        let mut ids: Vec<&str> = ENGINES.iter().map(|e| e.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "引擎 id 有重复");
        // 需求原话是"尽可能的多添加"：这条断言防止以后有人不小心把列表删短
        let online = ENGINES.iter().filter(|e| e.kind != Kind::Local).count();
        assert!(online >= 12, "在线引擎至少要 12 家，现在只有 {online}");
        assert!(!is_online("windows"), "本地识别不该算在线引擎（它没有申请页）");
        assert!(is_online("baidu") && is_online("custom"));
    }

    #[test]
    fn every_online_engine_is_dispatchable() {
        // 光有注册表没用：每个 id 都必须能被 recognize() 认出来并给出
        // **可执行的**错误（缺凭据就说缺什么），而不是"不认识的引擎"。
        let c = Creds::default();
        let urls = OcrUrls::default();
        for e in ENGINES {
            if e.kind == Kind::Local {
                continue;
            }
            let err = recognize(e.id, &c, &[0x89, 0x50], "CHN_ENG", false, 1, &urls)
                .expect_err(&format!("{} 没填凭据时不该成功", e.id));
            assert!(
                !err.contains("不认识的识别引擎"),
                "{} 没有被分派到：{err}",
                e.id
            );
        }
        assert!(recognize("nope", &c, &[0], "CHN_ENG", false, 1, &urls)
            .unwrap_err()
            .contains("不认识的识别引擎"));
    }

    #[test]
    fn openai_compatible_engines_have_base_and_model() {
        for e in ENGINES {
            if e.kind != Kind::OpenAi {
                continue;
            }
            if e.id == "custom" {
                assert!(e.need_base && e.need_model, "自定义那家必须让用户填 base 和模型");
                continue;
            }
            assert!(e.base.starts_with("https://"), "{} 缺预置 base", e.id);
            // 不要求用户填模型的，必须有预置模型名（方舟那种 ep- 接入点每家不一样，
            // 只能让用户填，所以 need_model=true 的那家允许 model 为空）
            if !e.need_model {
                assert!(!e.model.is_empty(), "{} 缺预置模型名", e.id);
            }
            // 预置值要被 Creds 的默认（空串）正确回退到
            let c = Creds::default();
            assert_eq!(c.base_for(e), e.base);
            if !e.need_model {
                assert_eq!(c.model_for(e), e.model);
            }
            // 用户填了就用用户的
            let c2 = Creds {
                base: "http://127.0.0.1:1/".into(),
                model: "my-model".into(),
                ..Default::default()
            };
            assert_eq!(c2.base_for(e), "http://127.0.0.1:1");
            assert_eq!(c2.model_for(e), "my-model");
        }
    }

    /* ---------- 纯函数：签名 / 日期 / 解析 ---------- */

    #[test]
    fn sha256_and_hmac_match_known_vectors() {
        // 空串的 SHA-256（公开测试向量）
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // RFC 4231 的 HMAC-SHA256 测试用例 2：key="Jefe", data="what do ya want for nothing?"
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn utc_date_is_correct_across_boundaries() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(1_700_000_000), "2023-11-14");
        // 闰年 2 月 29 日
        assert_eq!(utc_date(1_709_164_800), "2024-02-29");
        // 年末最后一秒 / 新年第一秒
        assert_eq!(utc_date(1_735_689_599), "2024-12-31");
        assert_eq!(utc_date(1_735_689_600), "2025-01-01");
    }

    #[test]
    fn youdao_sign_follows_the_documented_rule() {
        // 短输入（≤20 字符）直接用原文
        let short = youdao_sign("app", "abc", "salt", "123", "sec");
        assert_eq!(short, sha256_hex(b"appabcsalt123sec"));
        // 长输入（真实图片 base64 一定超过 20）先取它的 sha256
        let img = "x".repeat(40);
        let long = youdao_sign("app", &img, "salt", "123", "sec");
        let expect = sha256_hex(format!("app{}salt123sec", sha256_hex(img.as_bytes())).as_bytes());
        assert_eq!(long, expect);
        assert_ne!(long, sha256_hex(format!("app{img}salt123sec").as_bytes()));
    }

    #[test]
    fn strip_fences_removes_model_wrapping() {
        assert_eq!(strip_fences("```\n你好\n```"), "你好");
        assert_eq!(strip_fences("```markdown\n# 标题\n```"), "# 标题");
        assert_eq!(strip_fences("  直接就是文字  "), "直接就是文字");
        assert_eq!(strip_fences("```"), ""); // 只有围栏时别崩
    }

    #[test]
    fn host_of_handles_paths_and_ports() {
        assert_eq!(host_of("https://ocr.tencentcloudapi.com/"), "ocr.tencentcloudapi.com");
        assert_eq!(
            host_of("http://127.0.0.1:8080/x?y=1"),
            "127.0.0.1:8080"
        );
        assert_eq!(host_of("ocr.tencentcloudapi.com"), "ocr.tencentcloudapi.com");
    }

    #[test]
    fn parse_ocrspace_reads_text_and_errors() {
        let okv: Value = serde_json::from_str(
            r#"{"ParsedResults":[{"ParsedText":"第一行\r\n第二行\r\n"},{"ParsedText":"第三行"}],
                "IsErroredOnProcessing":false}"#,
        )
        .unwrap();
        assert_eq!(parse_ocrspace(&okv).unwrap(), "第一行\r\n第二行\n第三行");
        let err: Value = serde_json::from_str(
            r#"{"IsErroredOnProcessing":true,"ErrorMessage":["Key 无效"]}"#,
        )
        .unwrap();
        assert!(parse_ocrspace(&err).unwrap_err().contains("Key 无效"));
        let none: Value = serde_json::from_str(r#"{"ParsedResults":[]}"#).unwrap();
        assert!(parse_ocrspace(&none).unwrap_err().contains("没认出文字"));
    }

    #[test]
    fn parse_youdao_reads_lines_and_error_codes() {
        let okv: Value = serde_json::from_str(
            r#"{"errorCode":"0","Result":{"regions":[
                 {"lines":[{"text":"你好"},{"text":"世界"}]},
                 {"lines":[{"text":"第三行"}]}]}}"#,
        )
        .unwrap();
        assert_eq!(parse_youdao(&okv).unwrap(), "你好\n世界\n第三行");
        // 错误码是字符串，"0" 才是成功
        let err: Value = serde_json::from_str(r#"{"errorCode":"108"}"#).unwrap();
        let e = parse_youdao(&err).unwrap_err();
        assert!(e.contains("108"), "{e}");
        // 数字 0 也不能被当成成功（有道的契约就是字符串）
        let num: Value = serde_json::from_str(r#"{"errorCode":0}"#).unwrap();
        assert!(parse_youdao(&num).is_err());
    }

    #[test]
    fn parse_tencent_reads_detections_and_errors() {
        let okv: Value = serde_json::from_str(
            r#"{"Response":{"TextDetections":[{"DetectedText":"甲"},{"DetectedText":"乙"}],
                "RequestId":"x"}}"#,
        )
        .unwrap();
        assert_eq!(parse_tencent(&okv).unwrap(), "甲\n乙");
        let err: Value = serde_json::from_str(
            r#"{"Response":{"Error":{"Code":"AuthFailure.SignatureFailure","Message":"签名错"}}}"#,
        )
        .unwrap();
        let e = parse_tencent(&err).unwrap_err();
        assert!(e.contains("AuthFailure.SignatureFailure") && e.contains("签名错"), "{e}");
    }

    #[test]
    fn parse_mistral_joins_pages() {
        // ⚠ 用 r##"…"##：内容里有 `"#`（markdown 的 "# 标题"），
        //    r#"…"# 会在那里提前结束
        let okv: Value = serde_json::from_str(
            r##"{"pages":[{"markdown":"# 标题\n正文"},{"markdown":"第二页"}]}"##,
        )
        .unwrap();
        assert_eq!(parse_mistral(&okv).unwrap(), "# 标题\n正文\n第二页");
        assert!(parse_mistral(&serde_json::json!({"pages":[]}))
            .unwrap_err()
            .contains("没认出文字"));
    }

    #[test]
    fn openai_body_and_parse_cover_both_content_shapes() {
        let body = openai_body("m1", &[1, 2, 3], "CHN_ENG");
        assert_eq!(body["model"], "m1");
        assert_eq!(body["temperature"], 0);
        let url = body["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        // 图片字节确实被编进去了（base64 的 AQID = [1,2,3]）
        assert!(url.ends_with("AQID"), "{url}");
        // 提示词必须明确禁止代码围栏和解释（不然用户拿到的是"好的，以下是…"）
        let prompt = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(prompt.contains("不要 markdown 代码块"), "{prompt}");

        // 字符串形状
        let s: Value =
            serde_json::from_str(r#"{"choices":[{"message":{"content":"```\n文字\n```"}}]}"#).unwrap();
        assert_eq!(parse_openai(&s).unwrap(), "文字");
        // 数组形状（部分网关）
        let a: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"甲"},{"type":"text","text":"乙"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(parse_openai(&a).unwrap(), "甲乙");
        // 老 completions 形状
        let t: Value = serde_json::from_str(r#"{"choices":[{"text":"老形状"}]}"#).unwrap();
        assert_eq!(parse_openai(&t).unwrap(), "老形状");
        // 错误体
        let e: Value =
            serde_json::from_str(r#"{"error":{"message":"Invalid API key","code":"401"}}"#).unwrap();
        let msg = parse_openai(&e).unwrap_err();
        assert!(msg.contains("Invalid API key"), "{msg}");
    }

    /* ---------- 真 HTTP：本地仿真服务（不联网、不花额度） ---------- */

    /// 起一个只服务一次的本地 HTTP 服务，把收到的请求原样交给 `check`，
    /// 并按 `reply` 回一段 JSON。这样"请求拼装 → 响应解析"能整条验一遍。
    fn serve_once(reply: &'static str, check: impl FnOnce(&str) + Send + 'static) -> String {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                // ⚠ 一次 read() 读到的可能只有请求头（body 还在路上）——
                //   那样断言就看不到表单/JSON，测试会"偶发"失败。
                //   所以：先读到 \r\n\r\n，再按 Content-Length 把 body 读全。
                let mut buf: Vec<u8> = Vec::new();
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                    match s.read(&mut tmp) {
                        Ok(0) | Err(_) => break buf.len(),
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end.min(buf.len())]).to_string();
                let cl = head
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        if k.eq_ignore_ascii_case("content-length") {
                            v.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + cl {
                    match s.read(&mut tmp) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                }
                check(&String::from_utf8_lossy(&buf).to_string());
                let body = reply.as_bytes();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body);
                let _ = s.flush();
            }
        });
        format!("http://{addr}/")
    }

    #[test]
    fn ocrspace_round_trip_over_real_http() {
        let url = serve_once(
            r#"{"ParsedResults":[{"ParsedText":"本地仿真认出来的字"}],"IsErroredOnProcessing":false}"#,
            |req| {
                // 表单里必须带 apikey / language / base64Image（data URL 前缀不能少）
                assert!(req.contains("apikey=k1"), "{req}");
                assert!(req.contains("language=chs"), "{req}");
                assert!(req.contains("base64Image=data%3Aimage%2Fpng%3Bbase64%2C"), "{req}");
            },
        );
        let urls = OcrUrls {
            ocrspace: url,
            ..Default::default()
        };
        let c = Creds {
            key: "k1".into(),
            ..Default::default()
        };
        let out = recognize("ocrspace", &c, &[0x89, 0x50], "CHN_ENG", false, 3, &urls).unwrap();
        assert_eq!(out.text, "本地仿真认出来的字");
        assert_eq!(out.engine, "OCR.space");
    }

    #[test]
    fn openai_compatible_round_trip_sends_bearer_and_reads_content() {
        let url = serve_once(
            r#"{"choices":[{"message":{"content":"```\n识别结果\n```"}}]}"#,
            |req| {
                assert!(req.contains("POST /chat/completions"), "{req}");
                assert!(req.to_lowercase().contains("authorization: bearer sk-test"), "{req}");
                assert!(req.contains("\"model\":\"my-vl\""), "{req}");
            },
        );
        let c = Creds {
            key: "sk-test".into(),
            base: url, // 用户填的 base 优先（测试就是靠这个指向仿真服务）
            model: "my-vl".into(),
            ..Default::default()
        };
        let urls = OcrUrls::default();
        // 用 custom（唯一允许用户填 base 的那家）走一遍完整链路
        let out = recognize("custom", &c, &[1, 2, 3], "CHN_ENG", false, 3, &urls).unwrap();
        assert_eq!(out.text, "识别结果", "围栏要剥掉");
        assert_eq!(out.engine, "自定义（OpenAI 兼容）");
    }

    #[test]
    fn tencent_round_trip_signs_the_request() {
        let url = serve_once(
            r#"{"Response":{"TextDetections":[{"DetectedText":"腾讯云仿真"}],"RequestId":"r"}}"#,
            |req| {
                assert!(req.contains("X-TC-Action: GeneralBasicOCR"), "{req}");
                assert!(req.contains("X-TC-Version: 2018-11-19"), "{req}");
                // TC3 的 Authorization 头：凭据 + 签名段 + 签名
                assert!(
                    req.contains("Authorization: TC3-HMAC-SHA256 Credential=id1/"),
                    "{req}"
                );
                assert!(req.contains("SignedHeaders=content-type;host"), "{req}");
                assert!(req.contains("Signature="), "{req}");
                assert!(req.contains("\"ImageBase64\":\""), "{req}");
            },
        );
        let urls = OcrUrls {
            tencent: url,
            ..Default::default()
        };
        let c = Creds {
            key: "id1".into(),
            secret: "key1".into(),
            ..Default::default()
        };
        let out = recognize("tencent", &c, &[9, 9], "CHN_ENG", false, 3, &urls).unwrap();
        assert_eq!(out.text, "腾讯云仿真");
    }

    #[test]
    fn youdao_round_trip_signs_the_request() {
        let url = serve_once(
            r#"{"errorCode":"0","Result":{"regions":[{"lines":[{"text":"有道仿真"}]}]}}"#,
            |req| {
                assert!(req.contains("appKey=app1"), "{req}");
                assert!(req.contains("signType=v3"), "{req}");
                assert!(req.contains("sign="), "{req}");
                assert!(req.contains("img="), "{req}");
                assert!(req.contains("detectType=10012"), "{req}");
            },
        );
        let urls = OcrUrls {
            youdao: url,
            ..Default::default()
        };
        let c = Creds {
            key: "app1".into(),
            secret: "sec1".into(),
            ..Default::default()
        };
        let out = recognize("youdao", &c, &[7, 7, 7], "CHN_ENG", false, 3, &urls).unwrap();
        assert_eq!(out.text, "有道仿真");
    }

    /* ---------------- r46：MIME 按内容认 / 测试图 / 模型列表 ---------------- */

    #[test]
    fn mime_is_sniffed_from_bytes_not_hardcoded() {
        // 框选那条路编的是 JPEG —— 这正是以前写死 image/png 会踩的坑
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert_eq!(mime_of_bytes(&jpeg), "image/jpeg");
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        assert_eq!(mime_of_bytes(png), "image/png");
        assert_eq!(mime_of_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp");
        assert_eq!(mime_of_bytes(b"BM\x00\x00"), "image/bmp");
        assert_eq!(mime_of_bytes(b"GIF89a"), "image/gif");
        // 认不出来退回 png（跟以前写死的行为一致，别把老路径弄坏）
        assert_eq!(mime_of_bytes(&[1, 2, 3]), "image/png");
        assert_eq!(mime_of_bytes(&[]), "image/png");

        // data URL 里必须体现真实格式，而不是"声称"的格式
        let u = data_url(&[0xFF, 0xD8, 0xFF, 0xE0]);
        assert!(u.starts_with("data:image/jpeg;base64,"), "{u}");
    }

    #[test]
    fn openai_body_declares_jpeg_for_jpeg_bytes() {
        // 回归钉：截图线程给的是 JPEG，body 里就不能写 image/png
        let body = openai_body("m1", &[0xFF, 0xD8, 0xFF, 0xE0, 0x11], "CHN_ENG");
        let url = body["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"), "{url}");
        // Mistral 那条路同一个口径
        let m = mistral_body(&[0xFF, 0xD8, 0xFF, 0xE0, 0x11]);
        assert!(
            m["document"]["image_url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/jpeg;base64,"),
            "{m}"
        );
    }

    #[test]
    fn test_image_is_a_real_decodable_png() {
        let png = test_image();
        assert!(png.len() > 100, "测试图太小：{} 字节", png.len());
        assert_eq!(mime_of_bytes(&png), "image/png");
        // 必须真的能被解码 —— 有些接口会先校验图片格式，给一张假图等于假失败
        let img = image::load_from_memory(&png).expect("测试图解不开");
        assert_eq!((img.width(), img.height()), (96, 48));
    }

    #[test]
    fn local_engine_test_reports_availability_not_credentials() {
        // 本地那家走的是"环境可用吗"，不该去要密钥
        match test("windows", &Creds::default(), &OcrUrls::default()) {
            Ok(m) => assert!(!m.is_empty(), "成功也要有话说：{m}"),
            // 这台机器上没装 OCR 语言包时才走这里，文案要指向"本机环境"
            Err(e) => assert!(e.contains("Windows") || e.contains("本机"), "{e}"),
        }
        // 不认识的 id 要如实报错
        let e = test("no-such", &Creds::default(), &OcrUrls::default()).unwrap_err();
        assert!(e.contains("不认识的识别引擎"), "{e}");
    }

    #[test]
    fn models_parsing_covers_three_shapes_and_sorts_vision_first() {
        // ① OpenAI 标准 data[].id
        let a = parse_models(&serde_json::json!({
            "data": [ {"id": "Qwen/Qwen2.5-7B-Instruct"}, {"id": "Qwen/Qwen2.5-VL-32B-Instruct"} ]
        }))
        .unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].0, "Qwen/Qwen2.5-VL-32B-Instruct");
        assert!(a[0].1, "VL 模型该被认成视觉模型");
        assert!(!a[1].1);
        // ② models[].name
        let b = parse_models(&serde_json::json!({"models": [{"name": "glm-4v-flash"}]})).unwrap();
        assert_eq!(b[0].0, "glm-4v-flash");
        assert!(b[0].1);
        // ③ 裸数组
        let c = parse_models(&serde_json::json!(["gpt-4o-mini", "text-embedding-3-small"])).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].0, "gpt-4o-mini");
        // 去重 + 空列表如实报错
        let d = parse_models(&serde_json::json!({"data": [{"id": "x"}, {"id": "x"}]})).unwrap();
        assert_eq!(d.len(), 1);
        assert!(parse_models(&serde_json::json!({"data": []}))
            .unwrap_err()
            .contains("空的"));
        assert!(parse_models(&serde_json::json!({"nope": 1}))
            .unwrap_err()
            .contains("没返回模型列表"));
    }

    #[test]
    fn vendor_msg_digs_out_the_real_reason() {
        // OpenAI 系
        assert_eq!(
            vendor_msg(r#"{"error":{"message":"Invalid API key","type":"auth"}}"#),
            "Invalid API key"
        );
        // 有些网关直接给 message
        assert_eq!(vendor_msg(r#"{"message":"余额不足"}"#), "余额不足");
        // error 是字符串
        assert_eq!(vendor_msg(r#"{"error":"bad model"}"#), "bad model");
        // detail 形状
        assert_eq!(vendor_msg(r#"{"detail":"Not authenticated"}"#), "Not authenticated");
        // 只有 code
        assert!(vendor_msg(r#"{"code":40101}"#).contains("40101"));
        // 不是 JSON / 空体：也得给点东西，不能是空串
        assert!(vendor_msg("<html>502 Bad Gateway</html>").contains("502"));
        assert_eq!(vendor_msg("   "), "（响应体是空的）");
    }

    #[test]
    fn looks_vision_does_not_fire_on_innocent_names() {
        for yes in [
            "Qwen/Qwen2.5-VL-32B-Instruct",
            "glm-4v-flash",
            "gpt-4o-mini",
            "gemini-2.0-flash",
            "claude-3-5-sonnet",
            "mistral-ocr-latest",
            "step-1v-8k",
        ] {
            assert!(looks_vision(yes), "{yes} 应该算视觉模型");
        }
        for no in [
            "Qwen/Qwen2.5-7B-Instruct",
            "text-embedding-3-small",
            "deepseek-chat",
            "solver-pro",
            "revolve-1",
            "bge-m3",
        ] {
            assert!(!looks_vision(no), "{no} 不该算视觉模型");
        }
    }

    /* ---------------- r76：非视觉模型默认排除 ---------------- */

    /// `parse_models` 仍然**全量返回**（`bool` 只是提示），过滤由调用方按
    /// `vision` 字段做 —— 这样"默认只留视觉"与"用户想看全部"两条路都不丢信息。
    #[test]
    fn parse_models全量返回且带视觉标记() {
        let v: Value = serde_json::from_str(
            r#"{"data":[
                {"id":"Qwen2.5-VL-7B-Instruct"},
                {"id":"deepseek-chat"},
                {"id":"glm-4v-flash"},
                {"id":"text-embedding-3-small"}
            ]}"#,
        )
        .unwrap();
        let list = parse_models(&v).expect("应当解析出来");
        assert_eq!(list.len(), 4, "四个都该在（不过滤，只打标）");
        let by_id = |id: &str| list.iter().find(|(n, _)| n == id).map(|(_, v)| *v);
        assert_eq!(by_id("Qwen2.5-VL-7B-Instruct"), Some(true));
        assert_eq!(by_id("glm-4v-flash"), Some(true));
        assert_eq!(by_id("deepseek-chat"), Some(false));
        assert_eq!(by_id("text-embedding-3-small"), Some(false));
        // 视觉的排前面
        assert!(list[0].1, "第一个必须是视觉模型");
    }

    /// r76 那条用户需求落在**调用方**（main.rs 的 ocr_list_models）：只留视觉的。
    /// 这里把那个过滤动作本身钉住 —— 一行 `filter(|(_, v)| *v)` 就够，
    /// 但它必须真的把纯文本模型剔掉，否则用户就要在几十个名字里挑必然失败的那个。
    #[test]
    fn 只留视觉模型这一刀真的剔得掉纯文本模型() {
        let v: Value = serde_json::from_str(
            r#"{"data":[
                {"id":"Qwen2.5-VL-7B-Instruct"},
                {"id":"deepseek-chat"},
                {"id":"glm-4v-flash"},
                {"id":"Qwen2.5-7B-Instruct"},
                {"id":"step-1v-8k"}
            ]}"#,
        )
        .unwrap();
        let list = parse_models(&v).unwrap();
        let kept: Vec<String> = list
            .into_iter()
            .filter(|(_, v)| *v)
            .map(|(id, _)| id)
            .collect();
        assert_eq!(
            kept,
            vec!["Qwen2.5-VL-7B-Instruct", "glm-4v-flash", "step-1v-8k"],
            "只该留下能看图的"
        );
        // 一个视觉都没有时不能一刀切全滤掉（否则用户看到空白，不知道该填什么）
        let v2: Value = serde_json::from_str(r#"{"data":[{"id":"deepseek-chat"}]}"#).unwrap();
        let list2 = parse_models(&v2).unwrap();
        let has_vision = list2.iter().any(|(_, v)| *v);
        assert!(!has_vision, "这份名单里确实没有视觉模型");
        assert_eq!(list2.len(), 1, "但 parse_models 仍该把它发回来，交给界面说明");
    }
}
