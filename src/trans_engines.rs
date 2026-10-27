//! 翻译引擎注册表（v1.5.16）。
//!
//! 用户原话：「增加一些其他的翻译引擎，也要像 ocr 识别一样，可以同时多选几个
//! 翻译引擎，然后同一个页面同时呈现出来。具体逻辑你就参照 ocr 识别部分。」
//!
//! 所以整套架构对齐 [`crate::ocr_engines`]：
//!
//! ① **注册表是一张常量表**（[`ENGINES`]）：id / 显示名 / 申请页 / 文档页 /
//!    要填哪几样凭据 / 预置 base_url 与模型名。设置页的引擎列表、每个引擎旁边
//!    的问号按钮、凭据表单**全部由它生成** —— 加一家新引擎只改这里一行。
//!
//! ② **两类调用形状**：
//!    · **OpenAI 兼容的 `chat/completions`**（硅基流动 / 智谱 / 通义 / DeepSeek /
//!      Kimi / 火山方舟 / OpenAI / 自定义）。所以 `Kind::OpenAi` 一份实现覆盖
//!      全部，靠 base_url + model 区分。
//!    · **老牌翻译厂商的专用 REST 接口**（百度翻译 / 谷歌翻译 / 有道智云）：
//!      它们的协议跟 OpenAI 毫不相干 —— 百度要 APP ID + 密钥并算 MD5 签名，
//!      谷歌走 Cloud Translation v2， 有道要 AppKey + 密钥并算 SHA256 签名。
//!      所以多几个 `Kind`，多一份实现（见 `crate::trans_vendor`）。
//!
//!    老牌这几家是用户明确要的：「翻译引擎要包括百度翻译、谷歌翻译之类的
//!    老牌的 API」—— 它们的好处是**不挑模型**（翻译就是翻译，没有"选哪个
//!    模型"这一步），也**不烧钱**（各家都有免费额度）。
//!
//! ③ **模型列表可拉取**（`GET {base}/models`）：用户原话「它不能够拉取模型，
//!    它只有内置的一个模型，要跟文字识别的硅基流动部分一样，要能够拉取模型，
//!    然后选择一个」。翻译用的是**对话模型**，所以这里的方向和 OCR 正好相反：
//!    OCR 只要视觉模型，翻译**默认只要对话模型**（把带 vl / vision / embedding
//!    这类名字的排后面），一个都不像对话模型时才给全量 + 说明。
//!
//! ④ 所有端点都可注入 base：单测把 `Creds.base` 指向本地仿真服务，就能在
//!    不消耗任何真实额度、不需要账号的前提下，把「请求拼装 / 结果解析 /
//!    错误翻译」整条验一遍（见 `crate::trans` 的 serve_once 测试）。

use serde_json::Value;

/// 引擎的调用形状。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// OpenAI 兼容的对话模型（chat/completions）
    OpenAi,
    /// 百度翻译开放平台（通用翻译 API）：APP ID + 密钥，MD5 签名
    Baidu,
    /// 谷歌翻译（Cloud Translation v2）：API Key
    Google,
    /// 有道智云文本翻译：AppKey + 应用密钥，SHA256 签名
    Youdao,
}

impl Kind {
    /// 给前端的稳定标识。
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::OpenAi => "openai",
            Kind::Baidu => "baidu",
            Kind::Google => "google",
            Kind::Youdao => "youdao",
        }
    }

    /// 能不能 `GET {base}/models` 拉模型列表让用户挑。
    ///
    /// 只有 OpenAI 兼容那几家有；老牌三家（百度/谷歌/有道）翻译就是翻译，
    /// 没有"选哪个模型"这一步，所以 `false`。
    pub fn has_models(self) -> bool {
        matches!(self, Kind::OpenAi)
    }

    /// 是不是"靠模型名工作"的那类：模型那一栏对它们**总是**显示
    /// （哪怕注册表预置了默认模型 —— 用户有权知道自己会调哪个、也有权换）。
    /// 老牌三家不靠模型名，返回 false。
    pub fn needs_model_row(self) -> bool {
        matches!(self, Kind::OpenAi)
    }
}

/// 一家引擎的全部静态信息。界面（引擎列表、问号按钮、凭据表单）全由它驱动。
pub struct EngineInfo {
    pub id: &'static str,
    /// 显示名。也用作翻译窗里那段结果的【标注】文字
    pub name: &'static str,
    pub kind: Kind,
    /// **申请 API Key 的官方页面** —— 问号按钮点开就是它
    pub signup: &'static str,
    /// 官方接口文档
    pub docs: &'static str,
    /// 要填 API Key 吗
    pub need_key: bool,
    /// 要填**副凭据**吗（百度的「密钥」、有道的「应用密钥」）。
    ///
    /// 这两样是一对 —— 少一样都签不出请求，所以少填时要明确告诉用户。
    pub need_secret: bool,
    /// 要填 base_url 吗（只有「自定义」）
    pub need_base: bool,
    /// 模型名要用户自己填吗（「火山方舟」的接入点 ID 是必填的）
    pub need_model: bool,
    /// 预置 base_url
    pub base: &'static str,
    /// 预置模型名
    pub model: &'static str,
    /// 界面上那行小字：免费额度、注意事项（r77 起挪到 title 提示里）
    pub note: &'static str,
}

/// 全部引擎。顺序 = 设置页列表里的顺序：
/// 先国内直连、有免费额度的，再质量向的，最后自定义。
pub static ENGINES: &[EngineInfo] = &[
    EngineInfo {
        id: "baidu",
        name: "百度翻译",
        kind: Kind::Baidu,
        signup: "https://fanyi-api.baidu.com/products/api",
        docs: "https://fanyi-api.baidu.com/doc/21",
        need_key: true,
        need_secret: true,
        need_base: false,
        need_model: false,
        base: "https://fanyi-api.baidu.com/api/trans/vip/translate",
        model: "",
        note: "老牌通用翻译 API：要「APP ID」+「密钥」两样。免费版每月 1 万字符，速度快、不挑模型",
    },
    EngineInfo {
        id: "google",
        name: "谷歌翻译",
        kind: Kind::Google,
        signup: "https://console.cloud.google.com/apis/credentials",
        docs: "https://cloud.google.com/translate/docs/reference/rest/v2/translate",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://translation.googleapis.com/language/translate/v2",
        model: "",
        note: "Google Cloud Translation v2：只要一个 API Key。前 50 万字符/月免费；国内网络需要能连上 googleapis.com",
    },
    EngineInfo {
        id: "youdao",
        name: "有道翻译",
        kind: Kind::Youdao,
        signup: "https://ai.youdao.com/console/",
        docs: "https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html",
        need_key: true,
        need_secret: true,
        need_base: false,
        need_model: false,
        base: "https://openapi.youdao.com/api",
        model: "",
        note: "有道智云文本翻译：要「应用 ID」+「应用密钥」两样。个人版免费额度很大",
    },
    EngineInfo {
        id: "siliconflow",
        name: "硅基流动",
        kind: Kind::OpenAi,
        signup: "https://cloud.siliconflow.cn/account/ak",
        docs: "https://docs.siliconflow.cn/docs/api/chat-completions-post",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://api.siliconflow.cn/v1",
        model: "Qwen/Qwen2.5-7B-Instruct",
        note: "国内直连、聚合了很多开源模型，小模型有免费额度",
    },
    EngineInfo {
        id: "zhipu",
        name: "智谱 GLM",
        kind: Kind::OpenAi,
        signup: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
        docs: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4-flash",
        note: "glm-4-flash 是免费档；要更强的翻译换 glm-4-plus",
    },
    EngineInfo {
        id: "dashscope",
        name: "通义千问",
        kind: Kind::OpenAi,
        signup: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
        docs: "https://help.aliyun.com/zh/model-studio/qwen-api",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-flash",
        note: "新用户有免费额度；qwen-plus 翻译质量更好",
    },
    EngineInfo {
        id: "deepseek",
        name: "DeepSeek",
        kind: Kind::OpenAi,
        signup: "https://platform.deepseek.com/api_keys",
        docs: "https://api-docs.deepseek.com/zh-cn/",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        note: "翻译质量好、便宜；兼容 OpenAI 接口",
    },
    EngineInfo {
        id: "moonshot",
        name: "Kimi",
        kind: Kind::OpenAi,
        signup: "https://platform.kimi.com/console/api-keys",
        docs: "https://platform.kimi.com/docs/api/chat",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-8k",
        note: "月之暗面 Kimi；长段落翻译上下文大",
    },
    EngineInfo {
        id: "ark",
        name: "火山方舟",
        kind: Kind::OpenAi,
        signup: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
        docs: "https://docs.volcengine.com/docs/ark/api-key",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: true,
        base: "https://ark.cn-beijing.volces.com/api/v3",
        model: "",
        note: "要填「推理接入点 ID」（ep- 开头）或模型名",
    },
    EngineInfo {
        id: "openai",
        name: "OpenAI",
        kind: Kind::OpenAi,
        signup: "https://platform.openai.com/api-keys",
        docs: "https://platform.openai.com/docs/api-reference/chat",
        need_key: true,
        need_secret: false,
        need_base: false,
        need_model: false,
        base: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        note: "国内网络需要能直连 api.openai.com",
    },
    EngineInfo {
        id: "custom",
        name: "自定义（OpenAI 兼容）",
        kind: Kind::OpenAi,
        signup: "https://platform.openai.com/docs/api-reference/chat",
        docs: "https://platform.openai.com/docs/api-reference/chat/create",
        need_key: true,
        need_secret: false,
        need_base: true,
        need_model: true,
        base: "",
        model: "",
        note: "任何 OpenAI 兼容的接口都行：本地 Ollama/LM Studio、公司内网网关、其它云厂商",
    },
];

/// 按 id 查一家引擎。
pub fn find(id: &str) -> Option<&'static EngineInfo> {
    ENGINES.iter().find(|e| e.id == id)
}

/// 一家引擎的凭据。四个字段对应注册表里的 need_* ——
/// 界面上填哪个、后端读哪个，都由同一张表决定，不会错位。
#[derive(Clone, Debug, Default)]
pub struct Creds {
    /// API Key / Bearer token / APP ID / 应用 ID
    pub key: String,
    /// 副凭据：百度的「密钥」、有道的「应用密钥」
    pub secret: String,
    /// OpenAI 兼容接口的 base_url（只有「自定义」要用户填）
    pub base: String,
    /// 对话模型名
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

/// 名字像不像"能对话"的模型。纯启发式：不像的排后面，**不是白名单** ——
/// 用户照样能选任何一个，不替他做决定。
///
/// 方向和 OCR 的 `looks_vision` 相反：OCR 把像视觉的排前面，翻译把像**对话**
/// 的排前面（带 vl / vision / embedding / rerank / tts / asr 这类的是干不了
/// 翻译这活的，列前面只会让人挑错）。
pub fn looks_chat(id: &str) -> bool {
    let s = id.to_ascii_lowercase();
    const BAD: &[&str] = &[
        "vl", "vision", "visual", "ocr", "embedding", "rerank", "tts", "asr", "whisper",
        "image", "draw", "text-to-image", "moderation",
    ];
    // ⚠ 用带分隔符的形态，别用裸子串：裸 "vl" 会把 "solver" 之类算进来。
    //   硅基流动的模型名形如 Qwen/Qwen2.5-VL-32B-Instruct（/vl- 或 -vl-）。
    for b in BAD {
        if s.contains(&format!("-{b}")) || s.contains(&format!("{b}-")) || s.contains(&format!(
            "/{b}"
        )) {
            return false;
        }
    }
    // 智谱的视觉档是 glm-4v-*（数字 + v，没有分隔符可借），单独认一下
    if s.contains("4v") {
        return false;
    }
    true
}

/// 解析模型列表：OpenAI 标准是 `data[].id`，也认 `models[].id` 和裸数组。
///
/// `bool` = 名字看着像不像对话模型（界面据此把候选排前面）。
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
                out.push((id.to_string(), looks_chat(id)));
            }
        }
    }
    if out.is_empty() {
        return Err("模型列表是空的".into());
    }
    // 像对话模型的排前面，其余按名字排；同一家可能有重复条目，去重
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.dedup_by(|a, b| a.0 == b.0);
    Ok(out)
}

/// 拉一家的模型列表（OpenAI 兼容 `GET {base}/models`）。
///
/// 同步阻塞（设置页那颗按钮走 `trans_list_models` 命令，那边开线程）。
pub fn list_models(base: &str, key: &str, timeout_secs: u64) -> Result<Vec<(String, bool)>, String> {
    if key.trim().is_empty() {
        return Err("先填 API Key，再拉模型列表".into());
    }
    if base.trim().is_empty() {
        return Err("这家要先填接口地址（base_url），再拉模型列表".into());
    }
    let url = format!("{}/models", base.trim_end_matches('/'));
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

/// 这家引擎"连得上吗"自检：拿一句固定的话真翻一次。
///
/// 为什么不在前端拼：Key 对不对、模型可不可用、额度够不够，只有真发一次请求
/// 才知道（和 OCR 的 `test` 同一个道理）。
pub fn test_engine(
    info: &EngineInfo,
    creds: &Creds,
    target: &str,
) -> Result<String, String> {
    crate::trans_vendor::translate(
        info,
        creds,
        "Hello, world! 这是来自 Quick Search 的连接测试。",
        target,
    )
}

/* ------------------------------ 小工具 ------------------------------ */

fn truncate(s: &str, max: usize) -> String {
    let t: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        format!("{t}…")
    } else {
        t
    }
}

/// 从错误响应体里抠一句人话（各家格式不一，能抠到就带回）。
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
    }
    truncate(t, 220)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 注册表里每家都有申请页和文档() {
        for e in ENGINES {
            assert!(!e.signup.is_empty(), "{} 没有申请页", e.id);
            assert!(e.signup.starts_with("https://"), "{} 申请页不是 https", e.id);
            assert!(!e.docs.is_empty(), "{} 没有文档页", e.id);
            assert!(!e.name.is_empty(), "{} 没有显示名", e.id);
            assert!(e.need_key, "{} 居然不要 Key？", e.id);
        }
    }

    #[test]
    fn id不重复且find认得出每一家() {
        for e in ENGINES {
            assert_eq!(find(e.id).map(|x| x.id), Some(e.id));
        }
        assert!(find("没有这家").is_none());
    }

    #[test]
    fn 预置base的都以版本段结尾() {
        // 拉模型 / 发请求都是拼 {base}/chat/completions，base 不带版本段的
        // 全是把请求发到站点根上的家（以后会有人犯这个错，钉住）。
        // 各家版本段不一：/v1（多数）、/v3（火山方舟）、/v4（智谱）、
        // /v1beta/openai（Gemini 那种形态，翻译这版没有但留着断言不误伤）。
        //
        // ⚠ 只管 **OpenAI 兼容**那几家：老牌三家（百度/谷歌/有道）的 base
        //   是**完整端点**（各家的路径形态千奇百怪），不是"根 + /chat/completions"。
        for e in ENGINES {
            if e.kind != Kind::OpenAi {
                continue;
            }
            if !e.base.is_empty() {
                let ok = e.base.ends_with("/v1")
                    || e.base.ends_with("/v3")
                    || e.base.ends_with("/v4")
                    || e.base.contains("/v1beta");
                assert!(ok, "{} 的 base 不像 OpenAI 兼容根：{}", e.id, e.base);
            }
        }
    }

    #[test]
    fn 老牌三家的base是完整端点() {
        // 这三家的 base 直接当 URL 用（后面不再拼 /chat/completions），
        // 所以必须是 https 开头、且不能以斜杠结尾。
        for id in ["baidu", "google", "youdao"] {
            let e = find(id).unwrap();
            assert!(e.base.starts_with("https://"), "{}: {}", id, e.base);
            assert!(!e.base.ends_with('/'), "{}: {}", id, e.base);
            assert!(!e.need_base, "{} 的端点不该让用户改", id);
            assert!(!e.need_model, "{} 不该要模型名", id);
        }
    }

    #[test]
    fn 自定义那家必须自己填base和模型() {
        let c = find("custom").unwrap();
        assert!(c.need_base && c.need_model, "自定义不强制填 base/模型会永远发不出去");
        assert!(c.base.is_empty() && c.model.is_empty());
    }

    #[test]
    fn 凭据缺省时用注册表预置值() {
        let e = find("siliconflow").unwrap();
        let c = Creds::default();
        assert_eq!(c.base_for(e), "https://api.siliconflow.cn/v1");
        assert_eq!(c.model_for(e), "Qwen/Qwen2.5-7B-Instruct");
        // 用户填了的优先（尾斜杠剃掉）
        let c2 = Creds {
            base: "http://127.0.0.1:8080/".into(),
            model: "my-chat".into(),
            ..Default::default()
        };
        assert_eq!(c2.base_for(e), "http://127.0.0.1:8080");
        assert_eq!(c2.model_for(e), "my-chat");
    }

    #[test]
    fn 对话模型heuristic() {
        // 像对话的
        assert!(looks_chat("Qwen/Qwen2.5-7B-Instruct"));
        assert!(looks_chat("deepseek-chat"));
        assert!(looks_chat("glm-4-flash"));
        assert!(looks_chat("gpt-4o-mini"));
        assert!(looks_chat("moonshot-v1-8k"));
        assert!(looks_chat("qwen-plus"));
        // 不像对话的（vl 要带分隔符才算，solver 这种不能误伤）
        assert!(!looks_chat("Qwen/Qwen2.5-VL-32B-Instruct"));
        assert!(!looks_chat("glm-4v-flash"));
        assert!(!looks_chat("text-embedding-3-small"));
        assert!(!looks_chat("BAAI/bge-reranker-v2-m3"));
        assert!(looks_chat("solver"));
        assert!(looks_chat("revolve"));
    }

    #[test]
    fn 模型列表解析认data也认models和裸数组() {
        let v: Value = serde_json::from_str(
            r#"{"data":[{"id":"a-chat"},{"id":"b-vl-flash"},{"id":"a-chat"}]}"#,
        )
        .unwrap();
        let out = parse_models(&v).unwrap();
        // 去重 + 对话模型排前面
        assert_eq!(out, vec![("a-chat".to_string(), true), ("b-vl-flash".to_string(), false)]);

        let v: Value = serde_json::from_str(r#"{"models":[{"id":"m1"}]}"#).unwrap();
        assert_eq!(parse_models(&v).unwrap(), vec![("m1".to_string(), true)]);

        let v: Value = serde_json::from_str(r#"["x","y"]"#).unwrap();
        assert_eq!(parse_models(&v).unwrap().len(), 2);

        // 空列表要报错，不能回一个空 vec 让界面显示"0 个模型"
        let v: Value = serde_json::from_str(r#"{"data":[]}"#).unwrap();
        assert!(parse_models(&v).is_err());
        let v: Value = serde_json::from_str(r#"{"object":"list"}"#).unwrap();
        assert!(parse_models(&v).is_err());
    }

    #[test]
    fn 错误体里能抠出一句人话() {
        assert_eq!(
            vendor_msg(r#"{"error":{"message":"Invalid API key","type":"auth"}}"#),
            "Invalid API key"
        );
        assert_eq!(vendor_msg(r#"{"message":"余额不足"}"#), "余额不足");
        assert_eq!(vendor_msg(r#"{"error":"bad model"}"#), "bad model");
        assert_eq!(vendor_msg(r#"{"detail":"Not authenticated"}"#), "Not authenticated");
        assert!(vendor_msg(r#"{"code":40101}"#).contains("40101"));
        assert!(vendor_msg("<html>502 Bad Gateway</html>").contains("502"));
        assert_eq!(vendor_msg("   "), "（响应体是空的）");
    }
}
