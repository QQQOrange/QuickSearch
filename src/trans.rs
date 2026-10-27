//! 翻译：走各家 OpenAI 兼容的 `chat/completions` 接口（硅基流动 / 智谱 /
//! 通义 / DeepSeek / Kimi / 火山方舟 / OpenAI / 自定义，见 `trans_engines`）。
//!
//! v1.5.16 重构：原来是"只有硅基流动一家、四个配置项"，现在和 OCR 一样是
//! **一张引擎注册表**（`trans_engines::ENGINES`）：默认引擎 + 「同时翻译」
//! 名单，结果窗里一家一个文本框并排呈现。本文件只保留"怎么发一次请求、
//! 怎么解析响应"这件与厂商无关的事，注册表在 `trans_engines.rs`。
//!
//! 请求/解析/错误分类都写成纯函数，方便单测（真机调用在 `translate` 里）。

use serde_json::{json, Value};

pub const DEFAULT_BASE: &str = "https://api.siliconflow.cn/v1";
/// 文本模型，不是识图那个 `Qwen2.5-VL` —— 翻译用不上视觉。
pub const DEFAULT_MODEL: &str = "Qwen/Qwen2.5-7B-Instruct";
pub const DEFAULT_TARGET: &str = "zh";

/// 单次最多翻多少字。模型上下文能吃更多，但界面是一整块文字、用户多半是
/// 一句话或一段话；给个上限是为了在误贴一整篇文档时**明确报错**，而不是
/// 等半分钟然后被服务端截断。
pub const MAX_CHARS: usize = 20000;

/// 可选目标语言：`(代码, 名字)`。
///
/// 名字会**原样进提示词**，所以用的是"该语言自己的写法"（`日本語` 而不是
/// `Japanese`、`Русский` 而不是 `Russian`）—— 模型对"翻译成日本語"的服从度
/// 明显好于一个英文名。
pub const LANGS: &[(&str, &str)] = &[
    ("zh", "简体中文"),
    ("zh-TW", "繁體中文"),
    ("en", "English"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("fr", "Français"),
    ("de", "Deutsch"),
    ("es", "Español"),
    ("ru", "Русский"),
    ("pt", "Português"),
    ("it", "Italiano"),
    ("ar", "العربية"),
];

/// 语言代码 → 显示名（认不出来就按默认的简体中文）。
pub fn lang_label(code: &str) -> &'static str {
    LANGS
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, n)| *n)
        .unwrap_or(LANGS[0].1)
}

/// 把任意脏值归一成合法语言代码。认代码，也认名字（大小写不敏感），
/// 都不认就落回 `zh` —— 界面上「翻译成中文」是默认，绝不能变成空白。
pub fn normalize_lang(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return DEFAULT_TARGET.to_string();
    }
    for (c, n) in LANGS {
        if c.eq_ignore_ascii_case(t) || n.eq_ignore_ascii_case(t) {
            return (*c).to_string();
        }
    }
    DEFAULT_TARGET.to_string()
}

/// 系统提示词。
///
/// 几条规则都来自实测会翻车的地方：
///   · 不限制就会带"以下是翻译："这类前言；
///   · 不说明就爱把译文用引号包起来；
///   · 不说明会把原文里的空行吃掉（代码、诗、字幕全乱）；
///   · 原文已经是目标语言时，直接复制回去比"翻"成四不像好，但也不能拒绝 ——
///     用户可能就是想润色一下。
pub fn system_prompt(label: &str) -> String {
    format!(
        "你是一名专业翻译。把用户发来的文本翻译成{label}。\n\
         规则：\n\
         1. 只输出译文本身，不要前言、不要解释、不要用引号包住整段；\n\
         2. 保留原文的段落与换行结构；\n\
         3. 代码、命令、URL、邮箱、数字、专有名词保持原样；\n\
         4. 如果原文已经是{label}，就做轻微润色后输出，不要原样回传；\n\
         5. 不要输出「原文：」「译文：」这类标签。"
    )
}

/// 拼请求体（OpenAI 兼容格式，硅基流动同样吃这一套）。
pub fn build_body(model: &str, text: &str, target_label: &str) -> Value {
    build_body_with(model, text, target_label, false)
}

/// 同上，但可以选择要不要**流式**。
///
/// `stream=true` 时服务端按 SSE（`text/event-stream`）一段段吐，客户端读到
/// 一个字就能先显示一个字 —— 这是"翻译改完点一下、眼睛马上有东西看"的关键：
/// 非流式必须等模型把整段生成完才回第一个字节，短句 1~2 秒、长段落十秒以上，
/// 用户看到的就是一个转圈的空框。
pub fn build_body_with(model: &str, text: &str, target_label: &str, stream: bool) -> Value {
    json!({
        "model": if model.trim().is_empty() { DEFAULT_MODEL } else { model.trim() },
        "messages": [
            { "role": "system", "content": system_prompt(target_label) },
            { "role": "user", "content": text },
        ],
        // 翻译要稳不要浪：低温 + 不截断。
        "temperature": 0.2,
        "top_p": 0.9,
        "max_tokens": 4096,
        "stream": stream,
    })
}

/// 从 `chat/completions` 的响应里抠出译文。
///
/// 防御性地剥掉 markdown 围栏：提示词里明明要求"不要用引号/围栏包住"，
/// 仍有模型会把整段译文塞进 ```` ``` ```` 里（OCR 那边早就踩过，见
/// `ocr_engines` 的同一处理）。壳是模型的习惯，译文本身一个字都不该少。
pub fn parse_reply(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| "返回的不是 JSON —— 这个接口地址大概不是 OpenAI 兼容的".to_string())?;
    // 有些网关出错时也回 200，把错误塞在 error 字段里
    if let Some(msg) = v
        .get("error")
        .and_then(|e| e.get("message").or(Some(e)))
        .and_then(|m| m.as_str())
    {
        return Err(msg.to_string());
    }
    let out = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| strip_fence(s.trim()))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "返回里没有译文（choices[0].message.content 是空的）".to_string())?;
    Ok(out)
}

/// 剥掉整段包裹的 markdown 代码围栏（``` / ```text 这类）。
/// 只有**整段**被包住才剥；译文中间正常出现的三个反引号不动。
fn strip_fence(s: &str) -> String {
    let t = s.trim();
    if !t.starts_with("```") || !t.ends_with("```") || t.len() < 6 {
        return t.to_string();
    }
    // 开围栏那一行可能是 ```text 这种带语言标注的 —— 连同标注整行丢掉，
    // 只留第一行换行之后的内容（没有换行 = 行内围栏，原样留下）。
    let body = &t[3..t.len() - 3];
    let body = match body.find('\n') {
        Some(i) => &body[i + 1..],
        None => body,
    };
    body.trim().to_string()
}

/// 从错误响应体里抠一句人话（各家格式不一，能抠到就带回）。
fn error_message(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return body.chars().take(120).collect();
    };
    for p in [
        &["message"][..],
        &["error", "message"][..],
        &["detail"][..],
    ] {
        let mut cur = &v;
        for k in p {
            cur = &cur[*k];
        }
        if let Some(s) = cur.as_str() {
            return s.chars().take(120).collect();
        }
    }
    body.chars().take(120).collect()
}

/// 把 ureq 的错误分成"用户能据此动手"的几类。
///
/// `vendor` 是引擎显示名（"硅基流动" / "智谱 GLM" / "自定义"…）—— 多引擎后
/// 错误里必须说清是**哪一家**回的，不然用户同时勾了三家、其中一家挂了，
/// 看着一句"API Key 不对"不知道该去改哪家的 Key。
fn http_error(e: ureq::Error, vendor: &str) -> String {
    match e {
        ureq::Error::Status(401, _) => {
            format!("{vendor}：API Key 不对或已失效（401）—— 去它的控制台重新复制一个")
        }
        ureq::Error::Status(403, _) => {
            format!("{vendor}：这个 Key 没有调用该模型的权限（403）")
        }
        ureq::Error::Status(429, _) => {
            format!("{vendor}：请求太频繁，或者额度用完了（429）—— 过一会儿再试")
        }
        ureq::Error::Status(code, resp) => {
            let detail = error_message(&resp.into_string().unwrap_or_default());
            if detail.trim().is_empty() {
                format!("{vendor} 返回 HTTP {code}")
            } else {
                format!("{vendor} 返回 HTTP {code}：{detail}")
            }
        }
        ureq::Error::Transport(t) => {
            format!("连不上{vendor}（{t}）—— 检查网络或接口地址")
        }
    }
}

/// 真正发一次翻译请求。
///
/// `base` 是 OpenAI 兼容的根（如 `https://api.siliconflow.cn/v1`），拼上
/// `/chat/completions`。超时见 [`crate::net::trans_agent`]（整轮 180s / 两次
/// 数据之间 60s）—— 比 OCR 那种"几秒没回就重试"宽得多，因为模型真的会想。
///
/// `vendor` 只用于把错误说成哪一家的话（见 `http_error`）。
pub fn translate(
    vendor: &str,
    api_key: &str,
    model: &str,
    base: &str,
    text: &str,
    target: &str,
) -> Result<String, String> {
    let text = checked(vendor, api_key, text)?;
    let url = endpoint(base);
    let label = lang_label(&normalize_lang(target));
    let body = build_body(model, text, label);

    // 一次重试：连接池里那条空闲连接可能已经被对端关了（见 net::trans_agent）。
    // 翻译请求没有副作用，重发一次最坏只是多花一轮 RTT，比让用户重来划算。
    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        let r = crate::net::trans_agent()
            .post(&url)
            // 非流式这一轮是"等一个完整响应"，60 秒还没回就是真出问题了 ——
            // 别沿用 Agent 那个 180 秒（那是给流式长段落逐字生成用的）。
            .timeout(std::time::Duration::from_secs(60))
            .set("Authorization", &format!("Bearer {}", api_key.trim()))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());
        match r {
            Ok(resp) => {
                let s = resp.into_string().map_err(|e| format!("读响应失败：{e}"))?;
                return parse_reply(&s);
            }
            Err(e) => {
                let retry = attempt == 0 && matches!(e, ureq::Error::Transport(_));
                let msg = http_error(e, vendor);
                last_err = Some(msg);
                if !retry {
                    break;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| format!("{vendor}：请求没发出去")))
}

/* ══════════════════════════════════════════════════════════════════════
 * v1.5.18：流式翻译
 *
 * 非流式的问题不是"慢"，是**等待没有反馈**：点一下、框是空的、转啊转，
 * 短句 1~2 秒、长段落十几秒，用户不知道是在翻还是卡死了。
 *
 * 流式之后第一个字通常 300~600ms 就上屏，剩下的边生成边显示 —— 总耗时
 * 也许只少一点点，但"卡顿感"基本消失。三家老牌（百度/谷歌/有道）是一问
 * 一答、本身几十毫秒就回来了，不掺和这条路。
 * ══════════════════════════════════════════════════════════════════════ */

/// 流式翻译：边收边把增量交给 `on_delta`，返回**完整译文**。
///
/// `on_delta` 可能被调用很多次（一个 token 一次，具体看服务端怎么切块），
/// 也可能一次都不调（网关不认 `stream:true`，退回整段 JSON）。
///
/// 返回的整段译文才是权威结果 —— 调用方拿它**覆盖**前面流式显示的内容：
/// 模型的 markdown 围栏、首尾空白只有拿到全量才剥得干净（见 `strip_fence`）。
pub fn translate_stream(
    vendor: &str,
    api_key: &str,
    model: &str,
    base: &str,
    text: &str,
    target: &str,
    on_delta: &mut dyn FnMut(&str),
) -> Result<String, String> {
    let text = checked(vendor, api_key, text)?;
    let url = endpoint(base);
    let label = lang_label(&normalize_lang(target));
    let body = build_body_with(model, text, label, true);

    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        let mut acc = String::new();
        let r = crate::net::trans_agent()
            .post(&url)
            .set("Authorization", &format!("Bearer {}", api_key.trim()))
            .set("Content-Type", "application/json")
            // 别让 ureq 去要 gzip：压缩流要攒够一块才解得出，会把"边生成边
            // 显示"退化成"最后一次性蹦出来"。
            .set("Accept-Encoding", "identity")
            .set("Accept", "text/event-stream")
            .send_string(&body.to_string());
        match r {
            Ok(resp) => {
                let sse = resp
                    .header("content-type")
                    .map(|c| c.to_ascii_lowercase().contains("event-stream"))
                    .unwrap_or(false);
                if !sse {
                    /* 网关不吃 stream:true（自建反代、个别兼容层会直接回一整段
                     * JSON）。这时行为退回非流式，别让用户看到错误。*/
                    let s = resp.into_string().map_err(|e| format!("读响应失败：{e}"))?;
                    let out = parse_reply(&s)?;
                    on_delta(&out);
                    return Ok(out);
                }
                let reader = std::io::BufReader::new(resp.into_reader());
                match read_sse(reader, vendor, &mut acc, on_delta) {
                    Ok(()) => return Ok(strip_fence(acc.trim())),
                    Err((msg, retry)) => {
                        // 只有"一个字都还没收到"时才重试：已经吐了一半再重来，
                        // 用户看到的是双份文字。
                        if retry && attempt == 0 {
                            last_err = Some(msg);
                            continue;
                        }
                        return Err(msg);
                    }
                }
            }
            Err(e) => {
                let retry = attempt == 0 && matches!(e, ureq::Error::Transport(_));
                let msg = http_error(e, vendor);
                last_err = Some(msg);
                if !retry {
                    break;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| format!("{vendor}：请求没发出去")))
}

/// 读一段 SSE（`data: {...}` 逐行），把 `choices[0].delta.content` 累积进
/// `acc` 并交给 `on_delta`。
///
/// 返回 `Err((人话, 可重试))`。
///
/// 几种必须忍住的"脏数据"（都是实测里各家网关真会发的）：
///   · `: ping` / `: keep-alive` 心跳注释行；
///   · `event:` / `id:` / `retry:` 这些 SSE 字段（我们只要 data）；
///   · `data:` 后面跟的不是 JSON（有的网关在流里插一句纯文本提示）；
///   · `delta.content` 是 `null`（第一块通常只有 `role`，没有 content）；
///   · 少数实现不走 delta，直接给 `message.content`。
fn read_sse<R: std::io::BufRead>(
    mut r: R,
    vendor: &str,
    acc: &mut String,
    on_delta: &mut dyn FnMut(&str),
) -> Result<(), (String, bool)> {
    let mut line = String::new();
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(0) => break, // 正常结束（服务端关了连接）
            Ok(_) => {}
            // 读中断：一个字都没收到时可以整体重试（见调用方）
            Err(e) => return Err((format!("读响应中断：{e}"), acc.is_empty())),
        }
        let t = line.trim_end_matches(['\r', '\n']);
        if t.is_empty() || t.starts_with(':') {
            continue;
        }
        let Some(payload) = t.strip_prefix("data:").map(str::trim) else {
            continue; // event: / id: / retry: / 空行
        };
        if payload == "[DONE]" {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            continue; // 非 JSON 的心跳/提示，不影响正文
        };
        // 有些网关在流里塞一条 error（额度用完、模型不存在），必须报出来
        if let Some(err) = v.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .or_else(|| err.as_str())
                .unwrap_or("未知错误");
            return Err((format!("{vendor}：{msg}"), false));
        }
        let piece = v
            .pointer("/choices/0/delta/content")
            .and_then(|x| x.as_str())
            .or_else(|| v.pointer("/choices/0/message/content").and_then(|x| x.as_str()));
        if let Some(p) = piece {
            if !p.is_empty() {
                acc.push_str(p);
                on_delta(p);
            }
        }
    }
    if acc.trim().is_empty() {
        return Err((
            format!("{vendor} 流式响应里没有译文（一个字都没收到）"),
            false,
        ));
    }
    Ok(())
}

/// 三个入口共用的校验：原文非空、有 Key、不超长。返回 trim 过的原文。
fn checked<'a>(vendor: &str, api_key: &str, text: &'a str) -> Result<&'a str, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("没有要翻译的文字".to_string());
    }
    if api_key.trim().is_empty() {
        return Err(format!("还没有填{vendor}的 API Key（设置 → 翻译）"));
    }
    let n = text.chars().count();
    if n > MAX_CHARS {
        return Err(format!("这段文字太长（{n} 字），一次最多翻 {MAX_CHARS} 字"));
    }
    Ok(text)
}

/// `base` → `/chat/completions` 的完整端点（留空就用默认那家）。
fn endpoint(base: &str) -> String {
    let base = if base.trim().is_empty() {
        DEFAULT_BASE
    } else {
        base.trim()
    };
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 语言归一认代码也认名字() {
        assert_eq!(normalize_lang("zh"), "zh");
        assert_eq!(normalize_lang("EN"), "en");
        assert_eq!(normalize_lang("简体中文"), "zh");
        assert_eq!(normalize_lang("日本語"), "ja");
        // 脏值兜底到中文，不能留空
        assert_eq!(normalize_lang("klingon"), "zh");
        assert_eq!(normalize_lang("   "), "zh");
    }

    #[test]
    fn 请求体是标准的对话格式() {
        let b = build_body("Qwen/Qwen2.5-7B-Instruct", "hello", "简体中文");
        assert_eq!(b["model"], "Qwen/Qwen2.5-7B-Instruct");
        assert_eq!(b["stream"], false);
        assert_eq!(b["messages"][1]["content"], "hello");
        let sys = b["messages"][0]["content"].as_str().unwrap();
        assert!(sys.contains("简体中文"), "系统提示词要带目标语言：{sys}");
        assert!(sys.contains("只输出译文"), "要有「别加前言」的约束：{sys}");
    }

    #[test]
    fn 模型留空时用默认值() {
        let b = build_body("  ", "x", "English");
        assert_eq!(b["model"], DEFAULT_MODEL);
    }

    #[test]
    fn 解析正常响应() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"  你好，世界  "}}]}"#;
        assert_eq!(parse_reply(body).unwrap(), "你好，世界");
    }

    #[test]
    fn 解析时剥掉整段代码围栏() {
        // 提示词说了别包围栏，仍有模型会包 —— 壳要剥掉，内容一个字不能少
        let body = r#"{"choices":[{"message":{"content":"```\n你好\n世界\n```"}}]}"#;
        assert_eq!(parse_reply(body).unwrap(), "你好\n世界");
        // 带语言标注的围栏（```text）也剥
        let body = r#"{"choices":[{"message":{"content":"```text\nhello\n```"}}]}"#;
        assert_eq!(parse_reply(body).unwrap(), "hello");
        // 译文中间正常出现的三个反引号不动（不是整段包裹）
        let body = r#"{"choices":[{"message":{"content":"用法：```cargo build``` 就行"}}]}"#;
        assert_eq!(parse_reply(body).unwrap(), "用法：```cargo build``` 就行");
    }

    #[test]
    fn 解析各种畸形响应都不panic() {
        // 不是 JSON
        assert!(parse_reply("not json").is_err());
        // 200 但把错误塞在 error 字段
        let e = parse_reply(r#"{"error":{"message":"invalid api key"}}"#).unwrap_err();
        assert!(e.contains("invalid api key"), "{e}");
        // choices 为空 / content 为空
        assert!(parse_reply(r#"{"choices":[]}"#).is_err());
        assert!(parse_reply(r#"{"choices":[{"message":{"content":"   "}}]}"#).is_err());
    }

    #[test]
    fn 空文字与没填key都直接报错() {
        let e = translate("硅基流动", "k", "m", "https://x/v1", "   ", "zh").unwrap_err();
        assert!(e.contains("没有要翻译"), "{e}");
        let e = translate("智谱 GLM", "  ", "m", "https://x/v1", "hello", "zh").unwrap_err();
        // 错误里必须带厂商名：同时勾多家时用户要知道该去改哪家的 Key
        assert!(e.contains("智谱 GLM") && e.contains("API Key"), "{e}");
    }

    #[test]
    fn 超长文本明确拒绝而不是硬发() {
        let long = "啊".repeat(MAX_CHARS + 1);
        let e = translate("硅基流动", "k", "m", "https://x/v1", &long, "zh").unwrap_err();
        assert!(e.contains("太长"), "{e}");
    }

    #[test]
    fn 错误体里能抠出一句人话() {
        assert_eq!(error_message(r#"{"message":"bad model"}"#), "bad model");
        assert_eq!(error_message(r#"{"error":{"message":"quota"}}"#), "quota");
        assert_eq!(error_message("plain text"), "plain text");
    }

    /* ---------- 真 HTTP：本地仿真服务（不联网、不花额度） ----------
     * 和 ocr_engines.rs 同一套办法：起一个只服务一次的本地 HTTP 服务，
     * 把 translate 的 base 指过去，"请求拼装 → 响应解析"整条验一遍。 */

    /// 起一个只服务一次的本地 HTTP 服务：收到的请求交给 `check`，
    /// 按 `reply` 回一段 JSON。返回形如 `http://127.0.0.1:PORT/` 的根地址。
    fn serve_once(reply: &'static str, check: impl FnOnce(&str) + Send + 'static) -> String {
        serve_status(reply, "200 OK", check)
    }

    /// 同上，但状态码可指定（测 401 / 429 这类要走 `http_error` 分类的路）。
    fn serve_status(
        reply: &'static str,
        status: &'static str,
        check: impl FnOnce(&str) + Send + 'static,
    ) -> String {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
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
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
    fn 翻译全链路走一遍真实http() {
        let url = serve_once(
            r#"{"choices":[{"message":{"content":"你好，世界"}}]}"#,
            |req| {
                assert!(req.contains("POST /chat/completions"), "{req}");
                assert!(
                    req.to_lowercase().contains("authorization: bearer sk-test"),
                    "{req}"
                );
                assert!(req.contains("\"model\":\"Qwen/Qwen2.5-7B-Instruct\""), "{req}");
                // 系统提示词里要带目标语言，user 消息是原文
                assert!(req.contains("翻译成简体中文"), "{req}");
                assert!(req.contains("\"content\":\"hello\""), "{req}");
            },
        );
        let out = translate("硅基流动", "sk-test", "", &url, "hello", "zh").unwrap();
        assert_eq!(out, "你好，世界");
    }

    #[test]
    fn 真401时错误里带厂商名和补救办法() {
        let url = serve_status(r#"{"error":{"message":"Invalid API key"}}"#, "401 Unauthorized", |_| {});
        let e = translate("DeepSeek", "bad", "m", &url, "hello", "zh").unwrap_err();
        assert!(e.contains("DeepSeek"), "{e}");
        assert!(e.contains("401"), "{e}");
    }

    #[test]
    fn 真429时提示的是过会儿再试() {
        let url = serve_status(r#"{"message":"rate limited"}"#, "429 Too Many Requests", |_| {});
        let e = translate("硅基流动", "k", "m", &url, "hello", "zh").unwrap_err();
        assert!(e.contains("429") && e.contains("过一会儿"), "{e}");
    }

    #[test]
    fn 返回200但错误塞在error字段里() {
        let url = serve_once(r#"{"error":{"message":"Invalid API key"}}"#, |_| {});
        let e = translate("DeepSeek", "bad", "m", &url, "hello", "zh").unwrap_err();
        assert!(e.contains("Invalid API key"), "{e}");
    }

    /* ---------- 流式：本地仿真 SSE 服务 ---------- */

    /// 回一段 `text/event-stream`，body 原样当流吐出（不写 Content-Length，
    /// 让客户端读到连接关闭为止 —— 和真 SSE 一样）。
    fn serve_sse(body: &'static str) -> String {
        serve_typed("text/event-stream; charset=utf-8", body)
    }

    fn serve_typed(content_type: &'static str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                /* ⚠ 必须把**整个请求体**读完再回响应。
                 *
                 * 以前这里只 `read` 一次就当读完了：客户端（ureq）还在写请求体的
                 * 时候我们这边已经写响应并 close，Windows 直接回 RST ——
                 * 客户端看到的是 os error 10054「远程主机强迫关闭了一个现有的连接」，
                 * 于是走重试、再连一个已经不存在的监听 → 10061。
                 * 表现为这两个测试偶发失败（本机跑十次挂一两次）。 */
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
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n"
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
                let _ = s.flush();
            }
        });
        format!("http://{addr}/")
    }

    #[test]
    fn 流式响应逐段拼成整段译文() {
        let url = serve_sse(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"！\"}}],\"finish_reason\":\"stop\"}\n\n\
             data: [DONE]\n\n",
        );
        let mut chunks: Vec<String> = Vec::new();
        let out = translate_stream("硅基流动", "k", "m", &url, "hello", "zh", &mut |d| {
            chunks.push(d.to_string())
        })
        .unwrap();
        assert_eq!(out, "你好，世界！");
        assert_eq!(chunks, vec!["你好", "，世界", "！"], "每个增量都要立刻交出去");
    }

    #[test]
    fn 流里混着心跳和event行也不乱() {
        let url = serve_sse(
            ": ping\n\n\
             event: message\nid: 7\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\r\n\r\n\
             : keep-alive\n\
             data: {\"choices\":[{\"delta\":{\"content\":null}}]}\n\n\
             data: 这一行不是JSON，跳过\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"B\"}}]}\n\n\
             data: [DONE]\n\n",
        );
        let out = translate_stream("x", "k", "m", &url, "t", "zh", &mut |_| {}).unwrap();
        assert_eq!(out, "AB");
    }

    #[test]
    fn 流式结果里的整段围栏也会被剥掉() {
        let url = serve_sse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"```\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"\\n你好\\n\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"```\"}}]}\n\n\
             data: [DONE]\n\n",
        );
        let out = translate_stream("x", "k", "m", &url, "t", "zh", &mut |_| {}).unwrap();
        assert_eq!(out, "你好");
    }

    #[test]
    fn 网关不吃流式时退回整段json() {
        // 明明要了 stream:true，对端回的还是 application/json
        let url = serve_typed(
            "application/json",
            r#"{"choices":[{"message":{"content":"你好"}}]}"#,
        );
        let mut n = 0;
        let out = translate_stream("x", "k", "m", &url, "t", "zh", &mut |_| n += 1).unwrap();
        assert_eq!(out, "你好");
        assert_eq!(n, 1, "整段结果也要交出去一次，界面才不会是空的");
    }

    #[test]
    fn 流里夹着error要报出来() {
        let url = serve_sse("data: {\"error\":{\"message\":\"quota exceeded\"}}\n\n");
        let e = translate_stream("硅基流动", "k", "m", &url, "t", "zh", &mut |_| {}).unwrap_err();
        assert!(e.contains("quota exceeded"), "{e}");
        assert!(e.contains("硅基流动"), "错误里要说清是哪一家：{e}");
    }

    #[test]
    fn 一个字都没收到要报错而不是给空译文() {
        let url = serve_sse("data: [DONE]\n\n");
        let e = translate_stream("x", "k", "m", &url, "t", "zh", &mut |_| {}).unwrap_err();
        assert!(e.contains("没有译文"), "{e}");
    }

    #[test]
    fn 流式请求体里stream是真() {
        assert_eq!(build_body_with("m", "t", "简体中文", true)["stream"], true);
        assert_eq!(build_body_with("m", "t", "简体中文", false)["stream"], false);
        // 老入口不变
        assert_eq!(build_body("m", "t", "简体中文")["stream"], false);
    }
}
