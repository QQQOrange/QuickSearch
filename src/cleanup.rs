//! 数据目录里的「冗余数据」扫描与清理。
//!
//! 用户原话：「现在的数据文件夹里面有很多的冗余数据，我希望这些冗余数据能够被删除。
//! 当然，这种删除最好是在备份页面里面能有一个选项，点击后就删除冗余数据，删除无用数据。」
//!
//! 三条设计原则：
//!   1. **先扫后删**：`scan()` 只报告，`apply()` 才动手 —— 前端先把清单和"能释放多少"
//!      摆给用户看，确认了再删。在"数据目录"这种地方做一键直删太危险。
//!   2. **可解释**：每一项都带 `why`，界面上直接说清"为什么它算冗余"。
//!   3. **保守**：判不了的一律不删（比如换了密码、解不开的旧备份），
//!      单独列进 `skipped` 告诉用户"这几个我没动，因为……"。
//!
//! 实测（轮 23，拿用户真实数据目录跑的诊断）：4 份手动备份里 **2 份是完全冗余的**。
//! 成因是自动同步（启动 + 退出各一次）只看 `config.json` 的 **mtime**，
//! 而"只改了收藏面板尺寸 / 最后用的那个引擎 / 识别窗大小"这类纯界面状态也会让 mtime 变 ——
//! 于是每开一次软件就堆一份 112KB 的备份。把这几项界面状态剔掉再比，内容一模一样。

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// 纯"使用痕迹 / 窗口几何"字段：它们变了**不代表配置实质变了**。
/// 「判重」和「自动同步这次值不值得再备一份」共用这一套口径。
pub const VOLATILE_KEYS: [&str; 4] = ["favPanelSizes", "lastEngine", "ocrWinW", "ocrWinH"];

/// 一份配置的「实质内容」指纹：先剔掉 [`VOLATILE_KEYS`]，再哈希。
///
/// 不引 sha 依赖（项目本来就没有），`DefaultHasher` 对"变没变"这个判定足够了。
pub fn substance_digest(v: &serde_json::Value) -> u64 {
    let mut n = v.clone();
    if let Some(o) = n.as_object_mut() {
        for k in VOLATILE_KEYS {
            o.remove(k);
        }
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    // 序列化成字符串再哈希：同一个 Value 必然得到同一个串，不受 Map 实现影响。
    n.to_string().hash(&mut h);
    h.finish()
}

/// 明文 JSON 文本 → 实质指纹。不是合法 JSON 就返回 None。
pub fn substance_digest_of_text(text: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .map(|v| substance_digest(&v))
}

/// 新式的恢复前快照：`config.before-webdav(2026-10-12 23-06-22).QuickSearch`。
fn is_new_snapshot(name: &str) -> bool {
    name.starts_with("config.before-webdav(") && name.ends_with(").QuickSearch")
}

/// 老版本留下的、现在没人管的名字。
///
/// 这些是**真·垃圾**：命名口径早就换了，旧名字的文件不参与任何保留策略 /
/// 列表渲染，会一直躺在目录里。
fn is_legacy_file(name: &str) -> bool {
    name == "config.json.bak"
        // 老快照固定名 / 老式带序号快照
        || (name.starts_with("config.before-webdav") && !is_new_snapshot(name))
        // 统一命名之前的固定云端文件名
        || (name.starts_with("quicksearch-backup") && name.ends_with(".json"))
}

/// 损坏留档：`preserve_broken` 写出来的 `config.json.bad-0` … `.bad-8`。
fn is_bad_dump(name: &str) -> bool {
    name.starts_with("config.json.bad-")
}

/// 绝不能删的东西。列成白名单而不是黑名单 —— 手滑的代价太大。
fn is_protected(name: &str) -> bool {
    matches!(name, "config.json" | "last-backup.txt" | "log.txt")
}

/// 一组待清理的文件。
#[derive(Debug, Clone)]
pub struct Group {
    /// 稳定的机读 id（前端拿它分组显示/统计）
    pub kind: &'static str,
    /// 界面上给用户看的一句话
    pub label: String,
    /// **为什么**这些算冗余
    pub why: String,
    pub files: Vec<PathBuf>,
}

impl Group {
    fn bytes(&self) -> u64 {
        self.files
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum()
    }
    fn to_json(&self, apply: bool) -> serde_json::Value {
        let names: Vec<String> = self
            .files
            .iter()
            .map(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("?")
                    .to_string()
            })
            .collect();
        serde_json::json!({
            "kind": self.kind,
            "label": self.label,
            "why": self.why,
            "count": names.len(),
            "bytes": self.bytes(),
            "files": names,
            // 扫描阶段只报个数；真删的时候才回文件名，免得前端列一长串
            "applyed": apply,
        })
    }
}

/// 扫描结果。
#[derive(Debug, Default)]
pub struct Report {
    pub groups: Vec<Group>,
    /// 看见了但**故意没动**的（附原因）
    pub skipped: Vec<String>,
}

impl Report {
    pub fn total_bytes(&self) -> u64 {
        self.groups.iter().map(|g| g.bytes()).sum()
    }
    pub fn total_count(&self) -> usize {
        self.groups.iter().map(|g| g.files.len()).sum()
    }
    pub fn to_json(&self, applied: bool) -> serde_json::Value {
        let groups: Vec<serde_json::Value> = self.groups.iter().map(|g| g.to_json(applied)).collect();
        serde_json::json!({
            "applied": applied,
            "count": self.total_count(),
            "bytes": self.total_bytes(),
            "groups": groups,
            "skipped": self.skipped,
        })
    }

    /// 真删。逐个删、一个失败不影响其它；返回实际删掉的文件数与字节数。
    pub fn apply(&self) -> (usize, u64) {
        let mut n = 0usize;
        let mut b = 0u64;
        for g in &self.groups {
            for p in &g.files {
                // 二次确认：只删**文件**、且不是受保护的名字。
                // （即使前面的判定出了 bug，这一道闸也不会让 config.json 被删掉。）
                let ok_file = std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false);
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if !ok_file || is_protected(name) {
                    continue;
                }
                let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(p).is_ok() {
                    n += 1;
                    b += len;
                }
            }
        }
        (n, b)
    }
}

fn name_of(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// 扫描若干目录（备份目录 + 数据目录，通常就是同一个）里可以安全清掉的冗余数据。
///
/// `password` 是备份密码（没设为空串）—— 判重需要解密，没有它就只能对明文备份判重。
/// `used_icons` 是**仍然被引用**的自定义图标文件名集合（来自 `Config::overrides`）。
///
/// ⚠ 收一个**目录列表**而不是单个目录：用户可以把备份目录改到别处，
///   而 `config.json.bad-N` / `config.json.bak` / `icons/` 这些永远在数据目录里 ——
///   只看一个目录会漏。
pub fn scan(dirs: &[PathBuf], password: &str, used_icons: &HashSet<String>) -> Report {
    let mut rep = Report::default();

    let mut entries: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d) else { continue };
        for p in rd.filter_map(|e| e.ok()).map(|e| e.path()) {
            if !p.is_file() {
                continue;
            }
            // 备份目录正好等于数据目录时会把同一批文件收两遍
            if seen.insert(p.to_string_lossy().to_string()) {
                entries.push(p);
            }
        }
    }
    // 名字里带零填充时间戳 → 字典序就是时间序。全部按名字升序排，后面"留最新"就是留最后。
    entries.sort_by_key(|p| name_of(p));

    // ---------------- ① 内容重复的旧备份 ----------------
    //
    // 先把每份手动备份的"实质指纹"算出来（加密的先解密），同一指纹只留最新一份。
    let manual: Vec<PathBuf> = entries
        .iter()
        .filter(|p| crate::config::is_manual_backup(&name_of(p)))
        .cloned()
        .collect();

    let mut by_digest: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut undecidable = 0usize;
    for p in &manual {
        let Ok(text) = std::fs::read_to_string(p) else {
            undecidable += 1;
            continue;
        };
        let plain = if crate::crypto::looks_encrypted(&text) {
            match crate::crypto::decrypt(&text, password) {
                Ok(x) => x,
                // 换了密码的老备份：解不开就**不参与判重**，更不会被删。
                Err(_) => {
                    undecidable += 1;
                    continue;
                }
            }
        } else {
            text
        };
        match substance_digest_of_text(&plain) {
            Some(d) => by_digest.entry(d).or_default().push(p.clone()),
            None => undecidable += 1,
        }
    }
    let mut dup: Vec<PathBuf> = Vec::new();
    for (_d, mut v) in by_digest {
        if v.len() < 2 {
            continue;
        }
        v.sort_by_key(|p| name_of(p));
        v.pop(); // 留最新那份
        dup.extend(v);
    }
    dup.sort_by_key(|p| name_of(p));
    if !dup.is_empty() {
        rep.groups.push(Group {
            kind: "dup-backup",
            label: format!("{} 份「内容重复」的旧备份", dup.len()),
            why: "解密后把「收藏面板尺寸 / 最后用的引擎 / 识别窗大小」这类纯界面状态剔掉，\
                  内容与更新的那一份完全一样 —— 多半是自动同步（启动 / 退出）在配置没实质变化时堆出来的。\
                  每组只留最新的一份。"
                .to_string(),
            files: dup,
        });
    }
    if undecidable > 0 {
        rep.skipped.push(format!(
            "{undecidable} 份备份解不开（可能是换了备份密码的老文件），没有参与判重，也不会被删"
        ));
    }

    // ---------------- ② 超期的恢复前快照 ----------------
    // ⚠ 这个数字必须和 `main.rs::stash_local_config()` 的保留数**一致**：
    //    那边每次写新快照时按同一个数裁，这里清理时也按同一个数裁。
    //    两处数字不一致 = 用户点一次「清理冗余数据」就把刚留的快照删了，
    //    而设置页的提示文案说的又是另一个数（轮 23 就撞上过：提示 5、实留 3）。
    const KEEP_SNAPSHOTS: usize = 5;
    let mut snaps: Vec<PathBuf> = entries
        .iter()
        .filter(|p| is_new_snapshot(&name_of(p)))
        .cloned()
        .collect();
    if snaps.len() > KEEP_SNAPSHOTS {
        // 已经按名字升序 → 末尾的就是最新的
        let stale: Vec<PathBuf> = snaps.drain(..snaps.len() - KEEP_SNAPSHOTS).collect();
        rep.groups.push(Group {
            kind: "stale-snapshot",
            label: format!("{} 份过期的「恢复前快照」", stale.len()),
            why: format!(
                "每次「从云端恢复」之前都会在本机留一份快照兜底，只保留最近 {KEEP_SNAPSHOTS} 份就够了。"
            ),
            files: stale,
        });
    }

    // ---------------- ③ 孤立的自定义图标 ----------------
    let icon_dir = crate::config::icons_dir();
    if let Ok(rd) = std::fs::read_dir(&icon_dir) {
        let mut orphan: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && !used_icons.contains(&name_of(p))
                    // 目录里可能放着用户自己丢进来的其它图标资产，只认图片类扩展名
                    && matches!(
                        Path::new(&name_of(p))
                            .extension()
                            .and_then(|s| s.to_str())
                            .map(|s| s.to_ascii_lowercase())
                            .as_deref(),
                        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp")
                            | Some("ico") | Some("svg")
                    )
            })
            .collect();
        orphan.sort_by_key(|p| name_of(p));
        if !orphan.is_empty() {
            rep.groups.push(Group {
                kind: "orphan-icon",
                label: format!("{} 个没人用的自定义图标", orphan.len()),
                why: "这些图标文件还在 icons 目录里，但配置里已经没有任何引擎引用它们了\
                      （换过图标、删过那个引擎）。"
                    .to_string(),
                files: orphan,
            });
        }
    }

    // ---------------- ④ 空 / 损坏的备份 ----------------
    let broken: Vec<PathBuf> = manual
        .iter()
        .filter(|p| {
            let Ok(md) = std::fs::metadata(p) else {
                return false;
            };
            if md.len() == 0 {
                return true;
            }
            // 既不是加密体、也不是合法 JSON → 这份文件恢复不了
            match std::fs::read_to_string(p) {
                Ok(t) => !crate::crypto::looks_encrypted(&t)
                    && serde_json::from_str::<serde_json::Value>(&t).is_err(),
                Err(_) => false,
            }
        })
        .cloned()
        .collect();
    if !broken.is_empty() {
        rep.groups.push(Group {
            kind: "broken-backup",
            label: format!("{} 份损坏的备份", broken.len()),
            why: "空文件，或者既不是加密备份也不是合法配置 —— 恢复不了，留着只会占地方。"
                .to_string(),
            files: broken,
        });
    }

    // ---------------- ⑤ 配置损坏留档 ----------------
    let mut dumps: Vec<PathBuf> = entries
        .iter()
        .filter(|p| is_bad_dump(&name_of(p)))
        .cloned()
        .collect();
    if dumps.len() > 1 {
        // 按修改时间排，留最新的那一份
        dumps.sort_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
        });
        let old: Vec<PathBuf> = dumps.drain(..dumps.len() - 1).collect();
        rep.groups.push(Group {
            kind: "bad-dump",
            label: format!("{} 份过期的配置损坏留档", old.len()),
            why: "配置读坏时会把坏内容留档（config.json.bad-N）供手工抢救，留最近一份就够。"
                .to_string(),
            files: old,
        });
    }

    // ---------------- ⑥ 老版本遗留文件 ----------------
    let legacy: Vec<PathBuf> = entries
        .iter()
        .filter(|p| is_legacy_file(&name_of(p)))
        .cloned()
        .collect();
    if !legacy.is_empty() {
        rep.groups.push(Group {
            kind: "legacy",
            label: format!("{} 个老版本遗留文件", legacy.len()),
            why: "命名口径早就换过了（固定名 / 带序号的旧快照 / 老的云端文件名），\
                  这些文件不参与任何保留策略、界面上也看不到，等于永远躺在那里。"
                .to_string(),
            files: legacy,
        });
    }

    rep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volatile_keys_are_ignored_but_real_changes_are_not() {
        let a = serde_json::json!({"barList": ["百度"], "favPanelSizes": {"x": 1}, "lastEngine": "百度"});
        let b = serde_json::json!({"barList": ["百度"], "favPanelSizes": {"x": 999}, "lastEngine": "Google",
                                   "ocrWinW": 800});
        assert_eq!(
            substance_digest(&a),
            substance_digest(&b),
            "只改面板尺寸/最后用的引擎，实质内容应当判定为没变"
        );

        let c = serde_json::json!({"barList": ["百度", "Google"]});
        assert_ne!(
            substance_digest(&a),
            substance_digest(&c),
            "真的改了横条成员必须判成变了（否则自动同步会漏备份）"
        );
    }

    #[test]
    fn protected_names_are_never_touched() {
        for n in ["config.json", "last-backup.txt", "log.txt"] {
            assert!(is_protected(n), "{n} 必须在保护名单里");
        }
        assert!(!is_protected("config(2026-10-13 09-55-03).QuickSearch"));
    }

    #[test]
    fn legacy_detection_does_not_swallow_new_names() {
        // 新名字是「恢复前快照」，归 ② 管，不能被当成遗留垃圾删掉
        assert!(!is_legacy_file("config.before-webdav(2026-10-13 10-57-15).QuickSearch"));
        // 老名字要认出来
        assert!(is_legacy_file("config.before-webdav-3.json"));
        assert!(is_legacy_file("config.json.bak"));
        assert!(is_legacy_file("quicksearch-backup(2026-10-12 10-00-00).json"));
        // 正常的备份不是遗留
        assert!(!is_legacy_file("config(2026-10-13 09-55-03).QuickSearch"));
        assert!(!is_legacy_file("config.auto(2026-10-13 11-36-42).QuickSearch"));
    }

    #[test]
    fn broken_only_catches_unreadable_backups() {
        let dir = std::env::temp_dir().join("qs_cleanup_test_broken");
        let _ = std::fs::create_dir_all(&dir);
        let ok = dir.join("config(2026-10-13 09-00-00).QuickSearch");
        std::fs::write(&ok, r#"{"bar_list":["百度"]}"#).unwrap();
        let empty = dir.join("config(2026-10-13 09-00-01).QuickSearch");
        std::fs::write(&empty, "").unwrap();
        let junk = dir.join("config(2026-10-13 09-00-02).QuickSearch");
        std::fs::write(&junk, "这不是配置也不是加密体").unwrap();

        let rep = scan(std::slice::from_ref(&dir), "", &HashSet::new());
        let g = rep.groups.iter().find(|g| g.kind == "broken-backup");
        let names: Vec<String> = g.map(|g| g.files.iter().map(|p| name_of(p)).collect()).unwrap_or_default();
        assert!(names.iter().any(|n| n.contains("09-00-01")), "空文件要判成损坏：{names:?}");
        assert!(names.iter().any(|n| n.contains("09-00-02")), "垃圾内容要判成损坏：{names:?}");
        assert!(!names.iter().any(|n| n.contains("09-00-00")), "合法的备份不能判成损坏：{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_backups_keep_the_newest_only() {
        let dir = std::env::temp_dir().join("qs_cleanup_test_dup");
        let _ = std::fs::create_dir_all(&dir);
        // 三份：内容实质相同（只有界面状态不同），只有最新那份该留下
        for (i, size) in [(1, 10), (2, 20), (3, 30)] {
            let body = format!(r#"{{"barList":["百度"],"favPanelSizes":{{"a":{size}}}}}"#);
            std::fs::write(
                dir.join(format!("config(2026-10-13 09-00-0{i}).QuickSearch")),
                body,
            )
            .unwrap();
        }
        let rep = scan(std::slice::from_ref(&dir), "", &HashSet::new());
        let g = rep.groups.iter().find(|g| g.kind == "dup-backup").expect("应当认出重复备份");
        assert_eq!(g.files.len(), 2, "三份里应当有两份是冗余的");
        let names: Vec<String> = g.files.iter().map(|p| name_of(p)).collect();
        assert!(
            !names.iter().any(|n| n.contains("09-00-03")),
            "最新那份必须留着：{names:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 恢复前快照的保留数必须和「写快照那一侧」一致。
    ///
    /// 轮 23 撞过：`stash_local_config()` 留 5 份、这里清到 3 份、设置页提示写 5 份
    /// —— 用户点一次「清理冗余数据」就把刚留两份的快照删了。数字只准有一处口径。
    #[test]
    fn snapshot_retention_matches_the_writer() {
        let dir = std::env::temp_dir().join("qs_cleanup_test_snap");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 1..=6 {
            std::fs::write(
                dir.join(format!("config.before-webdav(2026-10-13 1{i}-00-00).QuickSearch")),
                "{}",
            )
            .unwrap();
        }
        let rep = scan(std::slice::from_ref(&dir), "", &HashSet::new());
        let g = rep.groups.iter().find(|g| g.kind == "stale-snapshot").expect("应当认出过期快照");
        assert_eq!(g.files.len(), 1, "6 份快照只该清掉最早那 1 份（保留 5）");
        let names: Vec<String> = g.files.iter().map(|p| name_of(p)).collect();
        assert!(names[0].contains("11-00-00"), "该删的是最早那份：{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
