//! 百度智能云「文字识别」。
//!
//! 两步：
//!   1. 拿 API Key / Secret Key 换 access_token（有效期 30 天，内存里缓存到期时间）；
//!   2. 把图片 base64 之后 POST 给识别接口，把结果拼成一整段文字。
//!
//! 只依赖 ureq，全程阻塞、有超时，调用方丢进后台线程即可。
//!
//! ## 为什么有「降级」这一层
//!
//! 百度两个通用识别接口的**计费方式不一样**：
//!
//! * `general_basic`  标准版 —— 注册即送**每日 500 次免费额度**，大多数用户开通就能用；
//! * `accurate_basic` 高精度版 —— **按量付费**（约 0.005 元/次），只有开通了付费
//!   或者拿到对应免费包才会返回正常结果。
//!
//! 所以「Key 和 Secret 都填对了，测试配置也通，但一识别就失败」是最常见的一类
//! 反馈 —— `check()` 只验 token 能不能换出来，识别接口有没有权限它管不了。
//! 现在的做法：先按用户选的精度打，**一旦返回权限/额度类错误，自动改打标准版重试一次**，
//! 于是「高精度没开通」的账号照样能用，只是精度差一点；真的识别成功时会在结果里
//! 标出用的是哪一档，用户想升级去百度控制台开通即可。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::config::base64;

const TOKEN_URL: &str = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_ACCURATE: &str = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic";
const OCR_GENERAL: &str = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic";

/// base64 + urlencode 之后的上限。
/// 官方文档：标准版 8M、高精度版 10M。留一点余量，别卡在边界上。
const MAX_FORM_BYTES: usize = 8 * 1024 * 1024;
/// 官方限制：最短边 ≥ 15px，最长边 ≤ 4096px（标准版）/ 8192px（高精度版）。
/// 统一按标准版的 4096 处理，main.rs 那边已经先把截图缩到 1920 宽了。
pub const MAX_SIDE: u32 = 4096;
/// 本地 OCR（Windows.Media.Ocr）走 CPU，太大的图会明显变慢。
/// 文字识别对分辨率不敏感，长边压到 2600 既快又不影响识别率。
pub const LOCAL_MAX_SIDE: u32 = 2600;
pub const MIN_SIDE: u32 = 15;

/// 标准版 `language_type` 只认这 10 种。用户在设置里选了高精度才支持的语种，
/// 又恰好降级到了标准版时，必须自己收窄，不然百度直接回参数错误。
const GENERAL_LANGS: &[&str] = &[
    "CHN_ENG", "ENG", "JAP", "KOR", "FRE", "SPA", "POR", "GER", "ITA", "RUS",
];

/// 三个接口地址打包在一起。
///
/// 生产路径永远用 `Endpoints::default()`（就是上面那三条百度的地址）。
/// 之所以做成参数而不是写死 —— 只有在测试里把它指向一个本地仿真服务，
/// 才能在不消耗真实额度、不需要账号的前提下，把请求拼装、base64 编码、
/// 结果解析、错误码翻译、降级重试这些逻辑**整条**验一遍。
/// 这不是「调试开关」：程序里没有任何地方会去读环境变量改它。
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub token: String,
    pub accurate: String,
    pub general: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            token: TOKEN_URL.to_string(),
            accurate: OCR_ACCURATE.to_string(),
            general: OCR_GENERAL.to_string(),
        }
    }
}

/// 缓存的 token，按「API Key:Secret Key」分桶存放。
///
/// ⚠ 这里原来只有**一条**记录（`Option<(key, token, 过期)>`），任何一次新的
/// 取 token 都会把它整个覆盖掉。单账号时没问题，可一旦同时有两组凭据在用
/// （比如用户在设置页改完 Key 还没生效、旧 Key 的后台请求还在跑），就会出现
/// 「A 的 token 被 B 挤掉 → A 下次又去换一次」的来回抖动，白白打网络。
///
/// ⚠ 上限必须是 16 而不是 4：单测里同一进程会并行跑 12 组不同的测试凭据
///   （k1~k12），上限 4 时它们互相挤缓存，那条「复用缓存 token」的断言
///   就会随机挂掉。生产环境只有一个账号，多留几条没有任何代价。 */
static TOKEN: Mutex<Vec<(String, String, Instant)>> = Mutex::new(Vec::new());
const TOKEN_CACHE_MAX: usize = 16;

/// 识别成功后告诉调用方「到底打的是哪一档」。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// 拼好的整段文字
    pub text: String,
    /// 实际用的接口名，`"高精度版"` / `"标准版"`
    pub engine: &'static str,
}

/// 解析结果重排：IPv4 排在 IPv6 前面。
///
/// ⚠ 这个函数已经搬到 `net::ipv4_first`（r94）—— 因为除了 OCR，识图上传、
/// 模型下载、WebDAV 同步、检查更新全中同一个招。这里保留一行转出，
/// 免得把这个文件里所有 `.resolver(...)` 和单测都改一遍；
/// **原因与实测量据见 `crate::net::ipv4_first` 的注释**（那边是权威版本）。
use crate::net::ipv4_first;

pub(crate) fn agent(timeout_secs: u64) -> ureq::Agent {
    let t = timeout_secs.clamp(5, 60);
    ureq::AgentBuilder::new()
        // ★ 关键：别让请求按系统默认顺序（IPv6 在前）去连。见 ipv4_first 的注释。
        .resolver(ipv4_first)
        // 6s 别再往下调了：ureq 有两个地址时按一半算，IPv6 独占 3s。
        // 而 Windows 的 SYN 首包超时重传间隔就是 ~3s —— 预算压到 1.5s
        // 会让「首包丢了、靠重传才连上」的弱网直接连接失败，得不偿失。
        .timeout_connect(Duration::from_secs(6))
        .timeout(Duration::from_secs(t))
        .user_agent("QuickSearch/1.0 (Windows)")
        // ⚠ 这里**故意**每次新建 Agent，不复用连接池，别顺手改成 static。
        //   ureq 只对「幂等方法 + 空 body」做失败重试（见 unit.rs::is_retryable），
        //   而识别接口是带 body 的 POST —— 一旦复用到服务器已经关掉的空闲连接，
        //   错误会直接抛给用户。为省一次 TCP+TLS 握手（实测约 60ms）冒这个险不值。
        .build()
}

/// 把 ureq 的**传输层**错误翻译成人话。
///
/// 只管连不上这类；对方回了个 4xx/5xx 的情况走 `body_error`，
/// 因为那时错误详情在响应体里，只看状态行会丢掉关键信息。
pub(crate) fn explain(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let text: String = resp.status_text().chars().take(80).collect();
            format!("HTTP {code} —— {text}")
        }
        ureq::Error::Transport(t) => format!("连不上：{t}"),
    }
}

/// `invalid_client` 该说什么。
///
/// ⚠ 实测踩过：IP 白名单不匹配时，百度**伪装成同样的 invalid_client**，
/// 提示若只说「Key 不对」会把人往错的方向带（明明 Key 是对的，是 IP 没加白）。
/// 所以 unknown client id 这一种把两种可能一起说出来。
fn invalid_client_text(desc: &str) -> String {
    if desc.contains("unknown client id") {
        "百度不认这个 API Key：要么 Key 抄错了，要么当前网络 IP 没在\
         百度应用的白名单里（unknown client id）"
            .to_string()
    } else {
        "API Key 或 Secret Key 不对".to_string()
    }
}

/// 从**响应体**里挖出真正的错误原因。
///
/// 踩过的坑：百度对错误的 key 返回的是 `HTTP 401` + `{"error":"invalid_client"}`。
/// 早先的实现只处理「HTTP 200 但 error_code 非空」这一种，于是
/// `invalid_client → "API Key 或 Secret Key 不对"` 那段友好提示**永远走不到**，
/// 用户看到的是没用的「HTTP 401 —— Unauthorized」。所以凡是 4xx/5xx，
/// 都必须把 body 读出来再定夺。
fn body_error(status: u16, body: &str) -> String {
    let trunc = |s: &str| -> String {
        let t: String = s.trim().chars().take(120).collect();
        if t.is_empty() { "(空响应)".to_string() } else { t }
    };
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        // 取 token 时的错误形态
        if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
            let desc = v.get("error_description").and_then(|x| x.as_str()).unwrap_or("");
            return match err {
                "invalid_client" => invalid_client_text(desc),
                _ => format!("取 token 失败：{err} {desc}").trim_end().to_string(),
            };
        }
        // 识别接口的错误形态
        if let Some(code) = v.get("error_code").and_then(|x| x.as_i64()) {
            let msg = v.get("error_msg").and_then(|x| x.as_str()).unwrap_or("");
            return ocr_error(code, msg);
        }
    }
    if status == 0 {
        format!("取 token 失败：{}", trunc(body))
    } else {
        format!("HTTP {status} —— {}", trunc(body))
    }
}

/// 百度识别接口的错误码 → 用户能看懂的一句话。
///
/// 取自百度智能云《文字识别》文档里的通用错误码表。写这条表的时候踩过一个坑：
/// 网上的博客把 17 说成「QPS 超限」，官方其实是 **17 = 每日调用量超限、18 = QPS 超限**，
/// 两者给的建议完全不同，抄错了会把人引到错误的操作上。
fn ocr_error(code: i64, msg: &str) -> String {
    match code {
        1..=3 => "参数缺失，识别接口没收到图片".to_string(),
        6 => "这个应用没有文字识别的服务权限，去百度控制台开通一下".to_string(),
        17 => "今天的免费识别次数已经用完了（标准版每天 500 次）".to_string(),
        18 => "请求太密了（百度限制每秒 5 次），稍等一下再试".to_string(),
        100 => "API Key 无效".to_string(),
        110 => "access_token 已失效，正在重新获取".to_string(),
        111 => "access_token 已过期，正在重新获取".to_string(),
        120 => "账户余额不足，去百度控制台充值后才能继续用".to_string(),
        140 => "百度服务器忙，稍等一下再试".to_string(),
        216200 => "框选的区域里没有图片内容".to_string(),
        216201 => "图片格式不对（只支持 jpg / png / bmp）".to_string(),
        216202 => "图片太大，缩小框选范围再试".to_string(),
        216630 => "这张图里有文字没识别出来，换个区域试试".to_string(),
        282810 => "识别失败，换一块区域试试".to_string(),
        _ => format!("识别失败（{code}）：{msg}"),
    }
}

/// 这类错误说明「token 不新鲜」，清掉缓存重新换一次就能好。
fn is_token_stale(code: i64) -> bool {
    matches!(code, 100 | 110 | 111)
}

/// 这类错误是「百度服务端抖了一下」，原样重试有意义。
fn is_retryable(code: i64) -> bool {
    matches!(code, 18 | 140)
}

/// 从 PNG 的 IHDR 里读宽高。读不出来返回 None（那就不做尺寸检查，交给百度报错）。
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    if &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    (w > 0 && h > 0).then_some((w, h))
}

/// 送出去之前自己先量一下：这些问题没必要浪费一次调用额度去让百度告诉我们。
fn precheck(png: &[u8]) -> Result<(), String> {
    if png.len() < 8 {
        return Err("截图数据异常（图片是空的）".into());
    }
    if let Some((w, h)) = png_size(png) {
        let (short, long) = if w < h { (w, h) } else { (h, w) };
        if long > MAX_SIDE {
            return Err(format!(
                "框选区域太大（{w}×{h}），百度单边最多 {MAX_SIDE} 像素，请框小一点"
            ));
        }
        if short < MIN_SIDE {
            return Err(format!(
                "框选区域太窄了（{w}×{h}），最短边至少要 {MIN_SIDE} 像素"
            ));
        }
    }
    // 上传形态：image=<base64>，再整个 form urlencode。base64 让体积 ×4/3；
    // urlencode 对 base64 只转义 +/=（约 +3.5%），所以真正的终态约 ×1.4。
    // 这里按 ×2 卡（即 base64 ≤ 4MB → 终态 ≤ ~5.6MB），对标准版 8M / 高精度
    // 10M 的官方上限都是保守钳制，故意早一点拒、给「form 里还有 lang 等
    // 其他字段」和百度侧的统计口径留余量。
    if base64(png).len() * 2 > MAX_FORM_BYTES {
        return Err(format!(
            "截图太大（{} KB），压缩后再试：请框小一点",
            png.len() / 1024
        ));
    }
    Ok(())
}

/// 强制清掉 token 缓存。下一次 `access_token()` 会真的去换一个新的。
fn invalidate_token(key: &str, secret: &str) {
    let cache_key = format!("{}:{}", key.trim(), secret.trim());
    // ⚠ 毒化自愈：std::sync::Mutex 在持锁线程 panic 之后会变"毒锁"，
    //   `if let Ok(...)` 会静默变成 no-op —— 于是「token 失效重取」这条自愈路径
    //   自己先失灵了。拿到 PoisonError 也要清一下再用。
    let mut g = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
    // 只清自己这一份，别把别的账号（测试用的本地仿真服务）也一起掀了
    g.retain(|(k, _, _)| k != &cache_key);
}

/// 取 access_token（带缓存）。
fn access_token(
    key: &str,
    secret: &str,
    timeout_secs: u64,
    ep: &Endpoints,
) -> Result<String, String> {
    if key.trim().is_empty() || secret.trim().is_empty() {
        return Err("还没填 API Key / Secret Key".into());
    }
    let cache_key = format!("{}:{}", key.trim(), secret.trim());
    let now = Instant::now();
    {
        // 同上：这里原先是 `.map_err(|_| "token 缓存被占用")?` —— 锁一旦被毒化
        // （任何线程在持锁期间 panic），**此后每次识别都返回"token 缓存被占用"**，
        // OCR 等于永久报废。这里必须清毒继续。
        let g = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, t, _)) = g.iter().find(|(k, _, exp)| k == &cache_key && now < *exp) {
            // 留 5 分钟余量，免得正好在过期边上失败
            return Ok(t.clone());
        }
    }

    let url = format!(
        "{}?grant_type=client_credentials&client_id={}&client_secret={}",
        ep.token,
        url_encode(key.trim()),
        url_encode(secret.trim())
    );
    let resp = match agent(timeout_secs).get(&url).call() {
        Ok(r) => r,
        // ↓ 就是这里：4xx 也带 body，必须把 body 读出来
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            return Err(body_error(code, &body));
        }
        Err(e) => return Err(explain(&e)),
    };
    let text = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("百度返回的不是 JSON：{e}（{text:.200}）"))?;
    // 也有服务器走 200 + error 的形态，同样要认
    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        let desc = v.get("error_description").and_then(|x| x.as_str()).unwrap_or("");
        return Err(match err {
            "invalid_client" => invalid_client_text(desc),
            _ => format!("取 token 失败：{err} {desc}"),
        });
    }
    let token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("百度没有返回 access_token")?
        .to_string();
    let expires = v
        .get("expires_in")
        .and_then(|x| x.as_u64())
        .unwrap_or(2592000);
    // ⚠ 和其它两处 TOKEN.lock() 同一个口径：**必须清毒继续**（见本文件里那段
    //   「锁被毒化也要继续」的注释）。写成 `if let Ok(...)` 的话，TOKEN 一旦被
    //   毒化，token 就再也进不了缓存 —— 之后每次识别都白多一次换 token 的往返
    //   （慢 100~300ms、多打一次网络），而且没有任何日志可查。
    {
        let mut g = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        let exp = Instant::now() + Duration::from_secs(expires.saturating_sub(300).max(60));
        // 同一组凭据只保留最新的一条，别越攒越多
        g.retain(|(k, _, _)| k != &cache_key);
        g.push((cache_key, token.clone(), exp));
        // 满了就丢最老的一条
        while g.len() > TOKEN_CACHE_MAX {
            g.remove(0);
        }
    }
    Ok(token)
}

/// 只验证 key/secret 能不能换到 token，用来做「测试一下配置」。
pub fn check(key: &str, secret: &str, timeout_secs: u64) -> Result<(), String> {
    check_with(key, secret, timeout_secs, &Endpoints::default())
}

/** 「一键诊断」的实测探针（#130 建，#134 改为只诊断）。
 *
 *  用户抱怨「识别慢」，可慢在哪一段得有数。这里量两段：
 *    ① 换 access_token 的往返（正式识别时这一段被预热藏掉了，但值得知道）；
 *    ② 打一次识别接口的往返（按 accurate 选高精度/标准版，诊断要量的就是
 *       用户当前配置下的真实速度）—— 用一张内置的 32×32 示意小图，
 *       认不认得出字不重要（空白/纯色图百度一般回空 words_result），
 *       网络 + 服务端的耗时是真的。
 *
 *  探针**永不因为识别失败而失败**：小图没有文字是意料之中，只要 POST
 *  打完（哪怕是 error_code）就算拿到了耗时。唯一会让它报错的是凭据/网络
 *  本身有问题 —— 那本来就该让用户知道。
 */
pub struct Probe {
    pub token_ms: u128,
    pub ocr_ms: Option<u128>,
}

pub fn probe_latency(
    key: &str,
    secret: &str,
    timeout_secs: u64,
    accurate: bool,
) -> Result<Probe, String> {
    let t0 = Instant::now();
    let token = access_token(key, secret, timeout_secs, &Endpoints::default())?;
    let token_ms = t0.elapsed().as_millis();

    // 32×32 白底 + 中央一块黑：够过百度的最短边限制，也保证不是纯空白图
    let mut img = image::RgbImage::from_pixel(32, 32, image::Rgb([255, 255, 255]));
    for y in 10..22 {
        for x in 10..22 {
            img.put_pixel(x, y, image::Rgb([0, 0, 0]));
        }
    }
    let mut png: Vec<u8> = Vec::new();
    if img
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .is_err()
    {
        return Ok(Probe { token_ms, ocr_ms: None });
    }
    let body = build_body(&png, "CHN_ENG", accurate);
    let ep = Endpoints::default();
    let endpoint = if accurate { &ep.accurate } else { &ep.general };
    let t1 = Instant::now();
    let r = call_endpoint(endpoint, &token, &body, timeout_secs);
    let ocr_ms = t1.elapsed().as_millis();
    if let Err((_, msg)) = r {
        crate::win::log(&format!("ocr: 探针的识别请求没成功（不影响正式识别）：{msg}"));
        return Ok(Probe { token_ms, ocr_ms: None });
    }
    Ok(Probe { token_ms, ocr_ms: Some(ocr_ms) })
}

/// **提前**把 access_token 换好（结果进缓存）。
///
/// 用户要求"框选完两秒内出结果"。识别里有一段不可省的网络耗时是「拿 token」，
/// 第一次要 100~300ms —— 而用户**开始框选的那一刻**就已经注定要用 OCR 了，
/// 这段时间完全可以和"用户慢慢拖框"并行掉。框选窗口一打开就在后台预热，
/// 等真正识别时 token 已在缓存里，直接省掉这一段。
pub fn warm_token(key: &str, secret: &str, timeout_secs: u64) {
    if key.trim().is_empty() || secret.trim().is_empty() {
        return;
    }
    let _ = access_token(key, secret, timeout_secs, &Endpoints::default());
}

pub fn check_with(
    key: &str,
    secret: &str,
    timeout_secs: u64,
    ep: &Endpoints,
) -> Result<(), String> {
    access_token(key, secret, timeout_secs, ep).map(|_| ())
}

/// 百度通用识别实际认得的 `language_type`。
///
/// 只有 `CHN_ENG`（中英混合）这一档是「中文」的合法答案 —— 百度**没有**
/// 「纯中文」这个值。旧版本设置页给过一个 `CHN` 选项，存进 config 后发出去
/// 百度会回参数错误，这就是「Key 全对却识别不出来」的一大半原因。
/// 这里做归一：`CHN` 一律当 `CHN_ENG` 处理，其余非白名单值也退回默认。
pub fn normalize_lang(lang: &str) -> &'static str {
    match lang.trim().to_ascii_uppercase().as_str() {
        "ENG" => "ENG",
        _ => "CHN_ENG",
    }
}

/// 一次 POST 识别。返回 `(error_code, 人话)` 或识别结果 JSON。
///
/// 单独拆出来是因为降级和刷新 token 要复用它，而且必须能拿到**原始错误码** ——
/// 只有错误码才能判断「该不该重试」。
fn post_once(
    endpoint: &str,
    token: &str,
    body: &str,
    timeout_secs: u64,
) -> Result<Value, (Option<i64>, String)> {
    let url = format!("{endpoint}?access_token={}", url_encode(token));
    let resp = match agent(timeout_secs)
        .post(&url)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            // 4xx 也可能带着 error_code 的 JSON（百度的鉴权失败就是 200 + error_code，
            // 但网关层偶尔会先回 401），所以先试着挖一遍再退回通用说法。
            let msg = body_error(code, &text);
            let cd = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("error_code").and_then(|x| x.as_i64()));
            return Err((cd, msg));
        }
        Err(e) => return Err((None, explain(&e))),
    };
    let text = resp.into_string().map_err(|e| (None, format!("读取响应失败：{e}")))?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| (None, format!("百度返回的不是 JSON：{e}（{text:.200}）")))?;
    Ok(v)
}

/// 打一次接口，把「识别成功 / 带错误码失败 / 其它失败」统一成一种形状。
fn call_endpoint(
    endpoint: &str,
    token: &str,
    body: &str,
    timeout_secs: u64,
) -> Result<Value, (Option<i64>, String)> {
    let v = post_once(endpoint, token, body, timeout_secs)?;
    if let Some(code) = v.get("error_code").and_then(|x| x.as_i64()) {
        let msg = v.get("error_msg").and_then(|x| x.as_str()).unwrap_or("");
        return Err((Some(code), ocr_error(code, msg)));
    }
    Ok(v)
}

/// 拼请求体。
///
/// `detect_direction` 只在用户真的需要时才开：它要多花时间，而且对正着的截图
/// 纯属浪费。更重要的是个别接口/账号组合下开了反而报错，所以默认关。
fn build_body(png: &[u8], lang: &str, accurate: bool) -> String {
    let lang = normalize_lang(lang);
    let mut b = format!(
        "image={}&language_type={}",
        url_encode(&base64(png)),
        url_encode(if accurate || GENERAL_LANGS.contains(&lang) {
            lang
        } else {
            // 高精度才支持的语种，降级到标准版时只能收窄成中英混合
            "CHN_ENG"
        })
    );
    b.push_str("&detect_direction=true");
    b.push_str("&paragraph=true");
    b.push_str("&probability=true");
    b
}

/// 从 `paragraphs_result` 还原行顺序。
///
/// 百度的 `words_result` 是**检测顺序**而不是阅读顺序，多行文字经常把左右两栏
/// 交错在一起。开了 `paragraph=true` 之后，`paragraphs_result[i].words_result_idx`
/// 给出第 i 段包含哪些行号，按段落串起来才是人读的那份文字。
fn extract_text(v: &Value) -> Vec<String> {
    let words = match v.get("words_result").and_then(|x| x.as_array()) {
        Some(w) => w,
        None => return Vec::new(),
    };
    let word_of = |i: usize| -> Option<&str> {
        words
            .get(i)
            .and_then(|w| w.get("words"))
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };

    // 没有段落信息就按原顺序输出。
    let paras = match v.get("paragraphs_result").and_then(|x| x.as_array()) {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (0..words.len())
                .filter_map(word_of)
                .map(str::to_string)
                .collect()
        }
    };

    let mut lines: Vec<String> = Vec::new();
    let mut seen = vec![false; words.len()];
    for p in paras {
        let idx = match p.get("words_result_idx").and_then(|x| x.as_array()) {
            Some(a) => a,
            None => continue,
        };
        for n in idx.iter().filter_map(|x| x.as_i64()) {
            let n = n.max(0) as usize;
            if n < seen.len() {
                seen[n] = true;
            }
            if let Some(s) = word_of(n) {
                lines.push(s.to_string());
            }
        }
    }
    // 段落信息没覆盖到的行（理论上不会有，但百度改字段时不能因此丢内容）补回末尾
    for (i, ok) in seen.iter().enumerate() {
        if !*ok {
            if let Some(s) = word_of(i) {
                lines.push(s.to_string());
            }
        }
    }
    lines
}

/// 收藏夹存图用的那档：更小（长边 1024，配置文件里要存 dataURL，体积敏感）。
pub fn compress_for_favorites(bytes: &[u8]) -> Vec<u8> {
    compress_for_storage(bytes, 1024, &[85, 75])
}

/// OCR 上传前那档：长边 1600（识别精度的安全线）。
pub fn prepare_for_upload(png: &[u8]) -> Vec<u8> {
    compress_for_storage(png, 1600, &[85, 75])
}

/// 已经是 JPEG 就**原样放行**。
///
/// 用户抱怨 OCR 慢，追出来一大头在这里：以前截图后先编 PNG（大图要几百毫秒），
/// 上传前再解码 → 缩放 → 编 JPEG，同样的图编码了两遍。
/// 现在截图线程直接出 JPEG（尺寸和质量都是按上传要求来的），
/// 这里认出 JPEG 魔数就不再动它 —— 省掉整整一次解码 + 编码。
fn is_jpeg(b: &[u8]) -> bool {
    b.len() > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF
}

/// 把一张图压缩到"最小可用"：等比缩到长边上限，然后**把所有候选编码都算一遍、
/// 挑字节最少的那个**。
///
/// 为什么这么做（用户反馈"压缩质量和效率不太高"）：
///   · 单一档位是拍脑袋 —— 截图类小图 PNG 反而最小，照片类 JPEG q75 最小，
///     两头都得试才知道；
///   · 多试一档质量几乎不花时间（编码一张 1600px 的图也就几十毫秒），
///     换来的是上传/存储体积实打实地降一截。
///
/// 任何一步失败都退回**原始字节** —— 宁可大一点也别把数据搞丢。
fn compress_for_storage(bytes: &[u8], max_side: u32, qualities: &[u8]) -> Vec<u8> {
    // JPEG 进 JPEG 出：调用方（截图线程）已经按目标尺寸/质量编码好了，
    // 再解码重编一遍纯属浪费 —— OCR 的耗时大头之一，别做无用功。
    if is_jpeg(bytes) {
        return bytes.to_vec();
    }
    let Ok(img) = image::load_from_memory(bytes) else {
        return bytes.to_vec();
    };
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return bytes.to_vec();
    }

    // 长边超过上限就等比缩下来（Triangle 滤镜：够快，文字/边缘也不糊）
    let longest = w.max(h);
    let img = if longest > max_side {
        let k = max_side as f32 / longest as f32;
        let nw = ((w as f32 * k).round() as u32).max(1);
        let nh = ((h as f32 * k).round() as u32).max(1);
        img.resize_exact(nw, nh, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let mut best: Vec<u8> = Vec::new();
    let mut consider = |cand: Vec<u8>| {
        if !cand.is_empty() && (best.is_empty() || cand.len() < best.len()) {
            best = cand;
        }
    };

    // 候选 1：PNG（无损 —— 图标、纯色截图常常它最小）
    let mut png_out: Vec<u8> = Vec::new();
    if img
        .write_to(&mut std::io::Cursor::new(&mut png_out), image::ImageFormat::Png)
        .is_ok()
    {
        consider(png_out);
    }
    // 候选 2..n：JPEG 各档质量（照片 / 满屏内容它碾压 PNG）
    for q in qualities {
        let mut jpg: Vec<u8> = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, *q);
        if img.write_with_encoder(enc).is_ok() {
            consider(jpg);
        }
    }

    if best.is_empty() { bytes.to_vec() } else { best }
}

/// OCR 结果的空格清理（用户要求的规则，v2）：
///   · **保留**：单词↔单词（两侧都是**连续 2 个以上**字母/数字）、
///     单词↔中文（单词侧同样是连续 2 个以上）之间的空格；
///   · **清掉**：其余一切空格 —— 字母↔字母（单词级以内，如 "A B C"）、
///     数字↔符号、中文↔中文、中文↔标点、标点↔任何、单个字母/数字 ↔ 任何。
///
/// 为什么要做：Windows 本地 OCR 会把一段连续中文拆成一个字一个空格
/// （「快 捷 搜 索」），还会把缩写、编号拆成散字母（"U S B"），中文旁边的
/// 标点也常被空格隔开，直接给用户没法看。实现按「空格串」整段处理：
/// 一串连续空格要么全删、要么全留，不会出现「删了一半、剩下夹在两个
/// 空格里的字」的怪结果。
pub fn clean_spaces(text: &str) -> String {
    // CJK 统一表意文字（含扩展 A/兼容表意区）。日常 OCR 结果 4E00..=9FFF 足够，
    // 扩展区带上以防生僻字。
    fn is_cjk(c: char) -> bool {
        matches!(c as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F)
    }
    fn is_word(c: char) -> bool {
        // 英文字母 + 数字：构成「单词」的原料
        c.is_ascii_alphanumeric()
    }
    fn is_space(c: char) -> bool {
        // 一切 Unicode 空白（半角/制表/全角/NBSP/U+2007 表亲…）都算"空格"，
        // **换行除外** —— 换行由 keep 的行首/行尾分支原样保留，动了会把
        // 段落并成一段。以前只认三兄弟（' ' \t \u{3000}），截图里混进
        // NBSP 时智能清理也漏刀，和强力模式的口径对齐。
        c.is_whitespace() && c != '\n' && c != '\r'
    }
    // 位置 k 往左数（含 chars[k] 自己），连续 word 字符的长度。
    // 用来区分「单词」（≥2）和「散字母/散数字」（=1）。
    fn run_back(chars: &[char], k: usize) -> usize {
        let mut n = 0;
        let mut i = k as isize;
        while i >= 0 && is_word(chars[i as usize]) {
            n += 1;
            i -= 1;
        }
        n
    }
    // 位置 k 往右数（含 chars[k] 自己）
    fn run_fwd(chars: &[char], k: usize) -> usize {
        let mut n = 0;
        let mut i = k;
        while i < chars.len() && is_word(chars[i]) {
            n += 1;
            i += 1;
        }
        n
    }
    // 这一串空格要不要留：只留「单词↔单词」「单词↔中文」，两侧的
    // word 串都必须 ≥2 才算单词；其余（含单词↔标点、数字↔符号）一律不留。
    fn keep(p: Option<char>, pn: usize, n: Option<char>, nn: usize) -> bool {
        match (p, n) {
            (Some(p), Some(n)) => {
                let pw = is_word(p) && pn >= 2;
                let nw = is_word(n) && nn >= 2;
                (pw && nw)                                    // 单词↔单词
                    || (pw && is_cjk(n))                      // 单词↔中文
                    || (nw && is_cjk(p))                      // 中文↔单词
            }
            // 行首/行尾的空格原样保留（没邻居可判断，动了反而容易误伤）
            _ => true,
        }
    }

    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if is_space(chars[i]) {
            let mut j = i;
            while j < chars.len() && is_space(chars[j]) {
                j += 1;
            }
            let prev = if i == 0 { None } else { Some(chars[i - 1]) };
            let next = chars.get(j).copied();
            let (pn, nn) = (
                if i == 0 { 0 } else { run_back(&chars, i - 1) },
                run_fwd(&chars, j),
            );
            if keep(prev, pn, next, nn) {
                out.extend(chars[i..j].iter().copied());
            }
            i = j;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// 只返回文字的便捷封装。生产路径用不到（那里要区分降级），但真机联调
/// 脚本和几个「只关心识别出没识别出文字」的测试要用它。
#[cfg(test)]
pub fn recognize(
    key: &str,
    secret: &str,
    png: &[u8],
    lang: &str,
    accurate: bool,
    timeout_secs: u64,
) -> Result<String, String> {
    recognize_with(
        key,
        secret,
        png,
        lang,
        accurate,
        timeout_secs,
        &Endpoints::default(),
    )
    .map(|o| o.text)
}

/// 识别一张 PNG（原始字节）。成功返回拼好的整段文字 + 实际用的那一档接口。
///
/// `lang` = CHN_ENG / ENG（会先归一，见 `normalize_lang`）；
/// `accurate` = 用户要的那一档，**打哪档就打哪档**。
///
/// #134 起**不再自动降级**：以前用户选了高精度、百度回「没开通付费」时会偷偷
/// 改打标准版。用户原话「禁止因高精度模式慢而自动回退到标准模式」—— 高精度
/// 失败就把错误原样报出去，让设置页的诊断面板给出「切到标准版」的手动按钮，
/// 由用户自己决定。偷偷降级会让「识别率怎么变了」永远查不到原因。
pub fn recognize_with(
    key: &str,
    secret: &str,
    png: &[u8],
    lang: &str,
    accurate: bool,
    timeout_secs: u64,
    ep: &Endpoints,
) -> Result<Outcome, String> {
    // 上传前压一压（见 prepare_for_upload 的注释）—— 这是 OCR 提速的大头。
    // ⚠ 压缩放在 precheck 之前：原本 precheck 会把"base64 之后超 4MB"的大图
    //   直接拒掉，而压一遍之后它完全在限度内，等于顺手多救回一批大截图。
    let prepared = prepare_for_upload(png);
    let png: &[u8] = &prepared;
    precheck(png)?;

    let name: &str = if accurate { "高精度版" } else { "标准版" };
    let endpoint = if accurate { &ep.accurate } else { &ep.general };
    let body = build_body(png, lang, accurate);

    // token 失效 → 清缓存换新的，重打一次（单条路径，天然只重一次，
    // 不会陷入「换 token → 还是错 → 再换」）
    let token = access_token(key, secret, timeout_secs, ep)?;
    let res = match call_endpoint(endpoint, &token, &body, timeout_secs) {
        Ok(v) => Ok(v),
        Err((Some(code), _)) if is_token_stale(code) => {
            invalidate_token(key, secret);
            let fresh = access_token(key, secret, timeout_secs, ep)?;
            call_endpoint(endpoint, &fresh, &body, timeout_secs)
        }
        Err((Some(code), _)) if is_retryable(code) => {
            // QPS / 服务器忙：原地等一下再打一次
            std::thread::sleep(Duration::from_millis(1200));
            call_endpoint(endpoint, &token, &body, timeout_secs)
        }
        Err(e) => Err(e),
    };

    match res {
        Ok(v) => {
            let lines = extract_text(&v);
            if lines.is_empty() {
                return Err("这一块里没认出文字，换个区域或放大点试试".into());
            }
            Ok(Outcome {
                text: lines.join("\n"),
                engine: name,
            })
        }
        Err((code, msg)) => {
            let code_s = code.map(|c| c.to_string()).unwrap_or_else(|| "-".into());
            crate::win::log(&format!("ocr: {name} 失败 error_code={} {}", code_s, msg));
            // 失败就原样报：不降级、不换端点（#134）。诊断信息由设置页的诊断面板
            // 展示，用户想换标准版自己去换。
            Err(msg)
        }
    }
}

/// 已经报过一次「去下载语言包」就把系统设置页打开过了 —— 每次会话最多弹一次，
/// 别识别一次弹一次烦死用户。
static OCR_SETTINGS_OPENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 不限次数地打开 Windows「语言和区域」设置页。
///
/// 设置页「环境检测」里用户点「一键安装」时每次都要真打开 ——
/// 那个入口的语义就是用户主动要求，没有 once 的必要。
pub fn open_language_settings() {
    std::thread::spawn(|| {
        // ms-settings: 协议由系统接管，`open` crate 的 start 命令能直接拉起
        match ::open::that("ms-settings:regionlanguage") {
            Ok(_) => crate::win::log("ocr: 已打开系统「语言和区域」设置页（用户主动点了一键安装）"),
            Err(e) => crate::win::log(&format!("ocr: 打开语言设置页失败：{e}")),
        }
    });
}

/// 打开 Windows OCR 官方文档（learn.microsoft.com，长期稳定链接）。
///
/// 引擎本体缺失（系统太老 / 精简版）时用户需要一个能看懂出处的说明页，
/// 比只说「升级系统」更可信。
pub fn open_ocr_doc() {
    std::thread::spawn(|| {
        let _ = ::open::that("https://learn.microsoft.com/zh-cn/windows/uwp/launch-resume/ocr");
    });
}

/// 某个语言 tag 能不能建出 OCR 引擎（试建一次，只读无副作用）。
fn lang_engine_exists(tag: &str) -> bool {
    windows::Globalization::Language::CreateLanguage(&windows::core::HSTRING::from(tag))
        .ok()
        .and_then(|l| windows::Media::Ocr::OcrEngine::TryCreateFromLanguage(&l).ok())
        .is_some()
}

/// 本地 OCR 依赖检测（设置页「环境检测」用，`ocr_dep_check` 命令的实现）。
///
/// 查三项，按依赖顺序：
///   ① `winrt`   —— Windows 内置 OCR 引擎本体（Windows 10 1809+ 才有；
///                  N / IoT LTSC 等精简 SKU 可能被裁掉）
///   ② `lang`    —— OCR 语言包（识别实际靠它；Windows 显示语言是中文时
///                  默认随系统装，英文系统 / 精简安装经常没有中文包）
///   ③ `profile` —— 你的 Windows 显示语言列表是否直接可用
///                  （`TryCreateFromUserProfileLanguages`）
///
/// 判定链（三项是一个「引擎 → 语言包 → 自动匹配」的依赖链，逐级下探）：
///   · profile 成功 → 三项全 OK，最快路径；
///   · profile 失败 → 试建 en-US 分型：能建说明引擎本体在、只是语言包没配好；
///     建不出说明引擎本体不在（系统太老或精简版），①②都红。
///
/// 每项都给「作用 + 现状 + 怎么补」三要素，前端直接渲染成卡片。
pub fn ocr_dep_check() -> Value {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
    /* ③ 先查 profile：直接成功就不用再往下挖了。 */
    let profile_ok = windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages().is_ok();
    /* ① 引擎本体：profile 失败时用 en-US 试建分型 —— en-US 是英文 Windows
     *    自带的，它能建出来就说明 API 层完整（Win10 1809+），问题在语言包。 */
    let engine_ok = profile_ok || lang_engine_exists("en-US");
    /* ② 语言包：枚举常见语言看系统实际装了什么（中文优先，英文兜底说明）。 */
    const PROBE: [&str; 9] = [
        "zh-Hans-CN", "zh-CN", "zh-Hant-TW", "en-US", "en-GB", "ja-JP", "ko-KR", "fr-FR", "de-DE",
    ];
    let have: Vec<&str> = PROBE.iter().copied().filter(|t| lang_engine_exists(t)).collect();
    let has_cn = have.iter().any(|t| t.starts_with("zh"));
    let lang_ok = engine_ok && has_cn;

    let cn_names: Vec<&str> = have
        .iter()
        .map(|t| match *t {
            "zh-Hans-CN" | "zh-CN" => "中文（简体）",
            "zh-Hant-TW" => "中文（繁体）",
            "en-US" => "英语（美国）",
            "en-GB" => "英语（英国）",
            "ja-JP" => "日语",
            "ko-KR" => "韩语",
            "fr-FR" => "法语",
            "de-DE" => "德语",
            _ => *t,
        })
        .collect();

    let item = |id: &str, name: &str, purpose: &str, ok: bool, detail: String, fix: &str| {
        serde_json::json!({
            "id": id, "name": name, "purpose": purpose,
            "ok": ok, "detail": detail, "fix": fix,
        })
    };
    let missing_all = if !engine_ok {
        "系统里一个 OCR 语言包都探测不到，需要连语言包一起装（先装中文（简体），英文可选）"
    } else if cn_names.is_empty() {
        "系统里有 OCR 语言包，但没有中文 —— QuickSearch 识别中文内容需要中文（简体）文字识别"
    } else {
        ""
    };
    serde_json::json!([
        item(
            "winrt",
            "Windows 内置 OCR 引擎",
            "本地识别的本体：把截图里的文字认出来，全程不联网、不要账号",
            engine_ok,
            if engine_ok {
                "已就绪（Windows 10 1809 或更高版本）".to_string()
            } else {
                "系统里探测不到内置 OCR 引擎 —— 通常是 Windows 版本低于 1809，或 N / IoT LTSC 等精简版未装媒体功能包".to_string()
            },
            "升级到 Windows 10 1809 或更高版本；精简版在「设置 → 应用 → 可选功能」里补装「图形和媒体功能包」，然后重新检测",
        ),
        item(
            "lang",
            "OCR 语言包（文字识别）",
            "让引擎能读懂中文：识别准确率全靠它，没有它本地识别直接建不出引擎",
            lang_ok,
            if lang_ok {
                format!("已装：{}", cn_names.join("、"))
            } else if engine_ok {
                format!("缺中文（简体）文字识别{}", if missing_all.is_empty() {
                    format!("（当前只有：{}）", cn_names.join("、"))
                } else { String::new() })
            } else {
                missing_all.to_string()
            },
            "点「一键安装」打开「语言和区域」→ 添加语言 → 选「中文（简体）」→ 安装时勾选「文字识别」；装完回到这里重新检测",
        ),
        item(
            "profile",
            "Windows 显示语言匹配",
            "让引擎自动对上你的系统语言：匹配上时识别直接可用，不用每次手动选语言",
            profile_ok,
            if profile_ok {
                "你的 Windows 显示语言可直接建出引擎".to_string()
            } else if engine_ok {
                "显示语言列表暂不可用，但系统里已装的语言包可以识别（装完中文包后把它设为显示语言即可）".to_string()
            } else {
                "引擎本体不可用，此项无从谈起".to_string()
            },
            "装好语言包后，在「设置 → 时间和语言 → 语言和区域」里把中文（简体）移到首选语言顶部",
        ),
    ])
}

/// 本地 OCR 缺语言包时，自动把 Windows「时间和语言 → 语言和区域」设置页打开，
/// 用户在那里添加中文（简体）语言包（语言包里带 OCR 可选功能）。
/// 放后台线程执行，失败只记日志，绝不影响识别主流程。
pub fn open_language_settings_once() {
    use std::sync::atomic::Ordering;
    if OCR_SETTINGS_OPENED.swap(true, Ordering::SeqCst) {
        return;   // 这次会话已经开过了
    }
    let _ = std::thread::spawn(|| {
        // ms-settings: 协议由系统接管，`open` crate 的 start 命令能直接拉起
        match ::open::that("ms-settings:regionlanguage") {
            Ok(_) => crate::win::log("ocr: 已打开系统「语言和区域」设置页（缺 OCR 语言包）"),
            Err(e) => crate::win::log(&format!("ocr: 打开语言设置页失败：{e}")),
        }
    });
}

/// Windows 11 / 10 内置 OCR（Windows.Media.Ocr），**无需联网、本地识别**。
///
/// Text-Grab 这类工具就是直接走这个 API。相比百度 OCR：
///   · 零网络、零额度 —— 离线也能用，不依赖任何账号；
///   · 速度极快 —— 纯本地 CPU 上几十到几百毫秒，正好对上用户"两秒内出结果"的要求。
///
/// 限制：需要系统里装了对应语言的 OCR 语言包（中文/英文通常默认就有），
/// 没装时引擎建不出来，返回一句人话提示。
///
/// ⚠ 实现说明（用户报过「存内存流失败 / 操作标识符无效」，就是旧路线的坑）：
/// 旧实现用 `DataWriter + InMemoryRandomAccessStream + StoreAsync` 把图片字节
/// 塞进 WinRT 流再交给 `BitmapDecoder` —— 这条链是**三段异步**，`StoreAsync`
/// 在桌面进程（非 UWP 宿主）里经常直接抛 0x8000000E「操作标识符无效」。
/// 按微软「桌面应用调用 WinRT API」文档的口径重写为**全同步**链路：
///   1. `image` crate 把 PNG/JPEG 解码成 RGBA8（本项目本来就依赖它做压缩）；
///   2. RGBA8 → BGRA8（WinRT 的 SoftwareBitmap 只吃 Bgra8），alpha 压满；
///   3. `CryptographicBuffer::CreateFromByteArray` —— 同步拿到 IBuffer；
///   4. `SoftwareBitmap::CreateCopyFromBuffer` —— 同步拿到位图；
///   5. 唯一的异步点只剩 `RecognizeAsync().join()`。
///      异步点越少，桌面进程里能踩的线程公寓坑就越少。
pub fn recognize_local(bytes: &[u8]) -> Result<String, String> {
    // ⚠ 并发闸门：下面那条线程一旦被 WinRT 卡住就永远不退出（注释里有说明），
    //   而用户会反复点「重新识别」/ 反复切引擎 —— 一次一条看着无害，叠加起来
    //   就是几十条线程各自抱着一份几十 MB 的位图。这里限制"同时只跑一次本地
    //   识别"，后来的直接让它稍等或走百度引擎；叠加上面的硬超时，最多只会有
    //   一条卡住。
    if LOCAL_BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("上一次本地识别还没结束，稍等几秒再试（或到设置里改用百度引擎）".into());
    }
    let _busy = LocalBusyGuard;

    // 硬超时兜底：识别放进独立线程跑，15 秒没回来就报超时错误返回。
    //   用户报过「点 OCR 整个软件卡死、之后怎么都触发不了」—— 无论下面哪一步
    //   在他的机器上挂起（WinRT 异步在个别环境里可能永不完成），这个兜底都能
    //   保证调用方拿到的是**一条错误**而不是一个永远等不到的函数，应用绝不
    //   被识别拖死。
    //   图像用 Arc 共享：以前是整份拷进线程（2600px 的 RGBA 原图约 27MB）。
    let bytes = std::sync::Arc::new(bytes.to_vec());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(recognize_local_inner(bytes.as_slice()));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(r) => r,
        Err(_) => Err("本地识别超时了（15 秒没出结果），请再试一次，或到设置里改用百度引擎".into()),
    }
}

/// 本地识别的同时 RUN flag（见 recognize_local 的注释）。
static LOCAL_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// LOCAL_BUSY 的 RAII 复位守卫：线程 panic / 提前返回都必须把闸门放开，
/// 否则下一次本地识别永远被拒。
struct LocalBusyGuard;
impl Drop for LocalBusyGuard {
    fn drop(&mut self) {
        LOCAL_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

fn recognize_local_inner(bytes: &[u8]) -> Result<String, String> {
    // Windows.Media.Ocr 是 WinRT，必须在已经进 COM 公寓的线程上跑。
    // 我们在后台线程里执行，先把自己塞进多线程公寓，否则第一句就回
    // RPC_E_NOT_INITIALIZED（软件直接崩）。
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }

    // ① 用 image crate 解码。框选侧生成的是 PNG，这里顺带支持 JPEG/BMP 等
    //    常见格式，和百度通道（prepare_for_upload）的输入面一致。
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("图片解码失败：{e}"))?;

    // ② 过大的图先缩到 LOCAL_MAX_SIDE 以内（本地没有 4MB 表单限制，
    //    但巨大的截图会拖慢像素转换和识别，同样值得压）。
    let img = if img.width().max(img.height()) > LOCAL_MAX_SIDE {
        img.resize(
            LOCAL_MAX_SIDE,
            LOCAL_MAX_SIDE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };

    let (w, h) = (img.width(), img.height());
    // ③ RGBA8 → BGRA8。顺手把 alpha 全部压成 255：OCR 不认透明字，
    //    万一上游给了半透明像素，透明处会被当成背景而不是文字。
    let mut bgra: Vec<u8> = img.to_rgba8().into_raw();
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }

    // ④ 同步造 IBuffer（不再走 DataWriter/StoreAsync 那条会炸的异步流）。
    let buffer = windows::Security::Cryptography::CryptographicBuffer::CreateFromByteArray(&bgra)
        .map_err(|e| format!("图片数据入缓冲失败：{e}"))?;

    // ⑤ 同步拷成 SoftwareBitmap（Bgra8）。
    let bmp = windows::Graphics::Imaging::SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        windows::Graphics::Imaging::BitmapPixelFormat::Bgra8,
        w as i32,
        h as i32,
    )
    .map_err(|e| format!("建位图失败：{e}"))?;

    // ⑥ 建引擎：先按用户系统语言找；找不到再显式试中文/英文语言包，
    //    覆盖「用户档案语言里没勾 OCR」但系统里其实装了语言包的情况。
    let engine = match windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages() {
        Ok(e) => Some(e),
        Err(_) => ["zh-Hans-CN", "zh-CN", "en-US"]
            .iter()
            .find_map(|tag| {
                windows::Globalization::Language::CreateLanguage(&windows::core::HSTRING::from(*tag))
                    .ok()
                    .and_then(|l| windows::Media::Ocr::OcrEngine::TryCreateFromLanguage(&l).ok())
            }),
    };
    let Some(engine) = engine else {
        // 语言包缺失（用户说的「本地缺少 windows ocr 的相关文件」）：
        // 按要求自动跳到系统的语言设置页让用户下载，同时给一句能落地的话。
        open_language_settings_once();
        return Err(
            "这台系统缺少本地 OCR 语言包，已帮你打开「语言和区域」设置页：\
             添加中文（简体）语言并勾选「文字识别」后再试，或到设置里改用百度引擎"
                .to_string(),
        );
    };

    let result = engine
        .RecognizeAsync(&bmp)
        .map_err(|e| format!("识别失败：{e}"))?
        .join()
        .map_err(|e| format!("识别失败：{e}"))?;

    let text = result
        .Text()
        .map_err(|e| format!("读取识别结果失败：{e}"))?
        .to_string();

    if text.trim().is_empty() {
        // 没认出字：多半是这块区域本身没字，也可能是语言包缺失（前者更常见）。
        // 给一个中性提示，别让用户以为软件坏了。
        return Err("这块区域里没有识别到文字".into());
    }
    Ok(text)
}

/// 检测 Windows 本地 OCR 引擎是否可用（系统里装没装 OCR 语言包）。
///
/// 本地引擎没有 Key 可测，设置页的「测试一下配置」就走这里：
/// 引擎能建出来 = 可用；建不出来 = 没装语言包，给一句能落地的指引。
pub fn local_available() -> Result<(), String> {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
    if windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages().is_err() {
        open_language_settings_once();
        return Err(
            "系统里没有可用的 OCR 语言包，已帮你打开「语言和区域」设置页：\
             添加中文（简体）并勾选「文字识别」后再测"
                .to_string(),
        );
    }
    Ok(())
}

/// 百分号编码（URL 和表单都用它）
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_match_official_table() {
        // 17 和 18 最容易抄错：官方是 17=日调用量、18=QPS。
        assert!(ocr_error(17, "").contains("每天"));
        assert!(ocr_error(18, "").contains("每秒"));
        assert!(ocr_error(216201, "").contains("格式"));
        assert!(ocr_error(216202, "").contains("太大"));
        assert!(ocr_error(120, "").contains("余额"));
    }

    // r94：`ipv4_is_preferred_over_ipv6` 这条单测搬去了 `net.rs`（原函数）
    // —— 同一个断言只留一份，改行为时不会只改了一处。

    #[test]
    fn paragraphs_restore_reading_order() {
        let v: Value = serde_json::from_str(
            r#"{"words_result":[{"words":"右栏第一行"},{"words":"左栏第一行"},
                                {"words":"左栏第二行"},{"words":"右栏第二行"}],
                "paragraphs_result":[{"words_result_idx":[1,2]},{"words_result_idx":[0,3]}]}"#,
        )
        .unwrap();
        assert_eq!(
            extract_text(&v),
            vec!["左栏第一行", "左栏第二行", "右栏第一行", "右栏第二行"]
        );
    }

    #[test]
    fn no_paragraph_field_falls_back_to_raw_order() {
        let v: Value =
            serde_json::from_str(r#"{"words_result":[{"words":"a"},{"words":"  "},{"words":"b"}]}"#)
                .unwrap();
        assert_eq!(extract_text(&v), vec!["a", "b"]);
    }

    #[test]
    fn paragraph_missing_rows_are_not_lost() {
        // 百度若改了字段形状，不能因此把文字吞掉
        let v: Value = serde_json::from_str(
            r#"{"words_result":[{"words":"一"},{"words":"二"},{"words":"三"}],
                "paragraphs_result":[{"words_result_idx":[0]}]}"#,
        )
        .unwrap();
        assert_eq!(extract_text(&v), vec!["一", "二", "三"]);
    }

    #[test]
    fn general_language_is_narrowed_to_what_general_supports() {
        // 设置页现在只给 CHN_ENG / ENG 两档，两者标准版都支持，原样发出去即可。
        // 保留 GENERAL_LANGS 这道收窄是为了以后加语种时不会忘了这件事：
        // 高精度才有的语种发给标准版会被百度拒，request 层面就要挡掉。
        // （#134 之后不再有"自动降级"，但"用户显式选标准版 + 高级语种"这条
        //  路仍然存在，收窄逻辑因此保留。）
        assert!(build_body(b"x", "CHN_ENG", false).contains("language_type=CHN_ENG"));
        assert!(build_body(b"x", "ENG", false).contains("language_type=ENG"));
        assert!(build_body(b"x", "ENG", true).contains("language_type=ENG"));
        assert!(GENERAL_LANGS.contains(&"CHN_ENG") && GENERAL_LANGS.contains(&"ENG"));
    }

    #[test]
    fn bogus_language_falls_back_to_chinese_english() {
        // 百度没有「纯中文」这个值。旧版本设置页存下来的 CHN 必须被当成 CHN_ENG，
        // 否则用户怎么配都是参数错误 —— 实测就是这么废掉的。
        assert_eq!(normalize_lang("CHN"), "CHN_ENG");
        assert_eq!(normalize_lang("chn"), "CHN_ENG");
        assert_eq!(normalize_lang("中文"), "CHN_ENG");
        assert_eq!(normalize_lang(""), "CHN_ENG");
        assert_eq!(normalize_lang("ENG"), "ENG");
        assert_eq!(normalize_lang(" eng "), "ENG");
        // 旧配置里的 CHN 走到请求体上也不能露出去
        assert!(build_body(b"x", "CHN", false).contains("language_type=CHN_ENG"));
        assert!(!build_body(b"x", "CHN", true).contains("CHN&"));
    }

    #[test]
    fn body_always_carries_the_needed_flags() {
        let b = build_body(b"x", "CHN_ENG", true);
        assert!(b.contains("paragraph=true"));
        assert!(b.contains("probability=true"));
        assert!(b.contains("detect_direction=true"));
    }

    #[test]
    fn png_dimensions_are_read_from_ihdr() {
        // 3x2 的最小 PNG 头
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&3u32.to_be_bytes());
        png[20..24].copy_from_slice(&2u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((3, 2)));
        assert_eq!(png_size(b"not a png"), None);
    }

    #[test]
    fn precheck_rejects_oversized_and_slivers() {
        // 太小（伪造 IHDR 说是 5000×100）→ 单边超限
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&5000u32.to_be_bytes());
        png[20..24].copy_from_slice(&100u32.to_be_bytes());
        let e = precheck(&png).unwrap_err();
        assert!(e.contains("太大"), "{e}");
    }

    /// 空格清理规则（用户原话 v2）：只保留「单词与单词」「单词与中文」
    /// 之间的空格，其他的空格都要去掉。
    #[test]
    fn clean_spaces_follows_user_rules() {
        // 中文↔中文：清
        assert_eq!(clean_spaces("快 捷 搜 索 验 证"), "快捷搜索验证");
        // 中文↔标点：清（两侧都清）
        assert_eq!(clean_spaces("你好 ， 世界 。"), "你好，世界。");
        assert_eq!(clean_spaces("「 引号 里 」的内容"), "「引号里」的内容");
        // 单词↔单词（连续 ≥2 的字母串）：保留
        assert_eq!(clean_spaces("hello world foo"), "hello world foo");
        assert_eq!(clean_spaces("OpenAI GPT-4"), "OpenAI GPT-4");
        // 单词↔中文：保留
        assert_eq!(clean_spaces("使用 Rust 写的程序"), "使用 Rust 写的程序");
        assert_eq!(clean_spaces("OpenAI 发布 了 GPT"), "OpenAI 发布了 GPT");
        // 数字串↔中文：保留（100 是 ≥2 的连续数字）
        assert_eq!(clean_spaces("价格 100 元"), "价格 100 元");
        // 散字母↔散字母：清（OCR 常把缩写拆成 "U S B"）
        assert_eq!(clean_spaces("U S B 接口"), "USB接口");
        assert_eq!(clean_spaces("A B C"), "ABC");
        // 数字↔符号：清；数字串↔中文：保留（与「100 元」同口径）
        assert_eq!(clean_spaces("10 % ， 20 元"), "10%，20 元");
        // 散数字↔中文：清（单词侧不足 2 位不算单词）
        assert_eq!(clean_spaces("第 1 章"), "第1章");
        // 连续空格整段处理，不会删一半留一半
        assert_eq!(clean_spaces("你  好"), "你好");
        // 多行文本：换行不动，行内的照样清
        assert_eq!(clean_spaces("第一 行\nsecond line\n第 三 行"), "第一行\nsecond line\n第三行");
        // 已经干净的文本原样返回
        assert_eq!(clean_spaces("你好，世界。hello world"), "你好，世界。hello world");
    }

    /// 本地 OCR 全链路冒烟测试：拿真实样张（tools/_ocr-sample.png，内容见
    /// _ocr-sample.txt）跑一遍 `recognize_local`。这条测试就是用户报的
    /// 「存内存流失败 / 操作标识符无效」的回归防线 —— 旧的
    /// DataWriter+StoreAsync 路线在桌面进程里炸，新的全同步路线必须能读出字。
    #[test]
    fn local_ocr_reads_sample_text() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tools/_ocr-sample.png");
        let Ok(bytes) = std::fs::read(&path) else {
            // 样张不在（例如干净的构建机）就没法测，直接跳过
            return;
        };
        match recognize_local(&bytes) {
            Ok(text) => {
                let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
                assert!(
                    compact.len() >= 6,
                    "本地 OCR 识别结果太短，疑似没读到字：{text:?}"
                );
                eprintln!("local_ocr 冒烟识别结果：{text:?}");
            }
            Err(e) => {
                // 引擎建不出来 = 这台机器没装 OCR 语言包，不算代码失败
                assert!(
                    e.contains("语言包") || e.contains("引擎"),
                    "本地 OCR 意外失败：{e}"
                );
                eprintln!("跳过（本机无 OCR 语言包）：{e}");
            }
        }
    }
}