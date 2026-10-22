# Quick Search v1.4.1 发布说明

> 发布日期：2026-10-22
> 上个版本：v1.4.0
> 这一版修备份恢复：**自动备份恢复不了、只能恢复手动备份**。

---

## ① 你的原话

> 「不能够恢复自动备份的文件。只能恢复手动备份的文件。」

对，而且原因很具体：**程序里同时存在两种备份格式，而恢复入口只认其中一种。**

## ② 真因：两种备份格式，一条路只认一半

| 格式 | 形态 | 谁在用 | 以前能不能恢复 |
|---|---|---|---|
| **视图格式** | camelCase + `version`（`config_view()` 的形状） | 手动备份 `config(...)`、WebDAV 云端、导出文件 | ✅ 能 |
| **配置格式** | snake_case（就是 `config.json` 本身） | 自动备份 `config.auto(...)` | ❌ **报「这份文件不像配置备份」** |

`restore_from_text` 的合理性检查写的是 `v.get("barList").is_none() && v.get("version").is_none()` ——
这两个键只在视图格式里存在。而滚动备份是 `save_to` 写的，字段是 `bar_list`（snake_case）、
没有 `version`。所以它**永远**被拒绝，手动备份却畅通无阻。

两种格式本身都有道理（视图格式把图标以 dataURL 内嵌，换机器也带图标；配置格式小、快、
和主文件同构），错的是"恢复只认一种"。

## ③ 修了什么（5 处）

**① 恢复入口认两种格式**
`detect_backup_format()` 先判形态，再分派：
- 视图格式 → `apply_view`（原路，图标 dataURL 落盘等逻辑不变）；
- 配置格式 → 整份替换 + `sanitize`（剪掉指向已删收藏/软件的哨兵、语言归一）。

**② 备份清单点一行就能恢复**
以前设置页那份备份清单是**纯展示**：你看得见 `config.auto(...)`，却没有任何入口能恢复它，
只能去「导入配置」翻文件对话框 —— 而那条路正好只认手动备份。现在每行带类型标签
（自动 / 手动 / 恢复前），点一下确认就恢复。新增命令 `restore_backup_file`，
只接受**备份目录里的文件名**（挡掉 `../`、盘符、分隔符）。

**③ 恢复前先留一手**
每次恢复前把当前配置存成 `config.before-restore(时间).QuickSearch` 放进备份目录，
挑错了还能退回来（和「恢复云端前留副本」同一套逻辑，只保留最近 5 份）。

**④ 恢复不再把备份密码降级成空**（这条是排查时发现的更危险的坑）
恢复一份"当年还没设密码"的旧备份，原来会把密码字段一起清空 → `save_to` 里
`stash_backup_password("")` 删掉 `backup.key` → **这台机器上所有用旧密码加密的备份
当场全部解不开**。用户只想退回旧配置，却把退路一起烧了。现在"空值不覆盖"
（和 OCR key / WebDAV 密码同一个口径），要清空密码请去设置里清。

**⑤ 加密备份的识别补全**
`restore_from_text` / 清理扫描原来用 `crypto::decrypt`（只认密码信封）。
v1.4.0 起"没设密码"的备份是 DPAPI 信封（`qsEnc:2`），会被当成"不认识的格式"。
现在统一走 `crypto::unseal`（按信封自己的版本号选钥匙）。

顺带：`cleanup.rs` 的"恢复前快照只留 5 份"改成认全 `config.before-` 家族
（以前只认 `before-webdav`，`before-restore` 会无限堆积）。

## ④ 验证

- `cargo test --release`：**302 / 302**
  （新增 `restore_accepts_both_backup_formats`：格式判据 / 配置格式能恢复 /
  加密的能恢复 / **没密码的备份不能把本机密码清空**）
- `cargo clippy --release`：0 warning
- **真机实测**（把 `Quick search data` 复制到临时目录，用 `QS_DATA_DIR` 指过去，
  走 `--restore-probe` 这条和设置页完全相同的路）：
  - 恢复真实的 `config.auto(2026-10-22 12-18-55).QuickSearch` → `OK=…`，
    恢复后的配置 13953 字节（完整配置），`backup.key` 仍在；
  - 真实数据目录的 `config.json` 哈希**没有变化**（测试全程没碰用户配置）。
- 版本号 1.4.0 → 1.4.1（Cargo.toml / tauri.conf.json / package.json / package-lock.json）
- 交付：`D:\software\myself\QuickSearch.exe`

更新包校验（SHA256）：`561C8A3426D799483234CC3A1C7B88CADE3833D3AC516CCBBFF7B06F2822E2C2`

## ⑤ 新增测试钩子

`--restore-probe <备份文件名>`：按设置页那条路恢复一份本地备份，结果打到 stdout 后退出。
配合 `QS_DATA_DIR=<数据副本>` 就能在不碰用户真实配置的前提下验完整条恢复链 ——
这一版的两个 bug 都是靠它才敢在真数据上确认的。
