# 推送与发布流程

> ⚠ **重要约定（2026-10-18 用户明确要求）**
>
> **未经用户主动提出"上传到 GitHub"之前，不要推送。** 但**本地源码要照常更新**。
>
> 换句话说：改代码 → 提交到本地（可以做）→ 推送远端（**只在用户说了才做**）。
>
> 这条约定的由来：推送是**对外可见**的动作，而 `github.com:443` 在本机时通时不通，
> 推送经常要重试十几轮；让"什么时候对外发布"由用户决定，比自动推送更合理。

---

## 现状（已确认的事实）

| 项 | 状态 |
|---|---|
| 本地仓库 | ✅ 分支 `main`，工作区干净 |
| 远端配置 | ✅ `origin` = `https://github.com/QQQOrange/QuickSearch.git` |
| GitHub 凭据 | ✅ 凭据管理器里有（`git credential fill` 能拿到） |
| 网络 | ⚠️ **间歇性**：`github.com:443` 时通时不通；`api.github.com` 一直可用 |
| 发布 | ✅ Release `v1.0.0`、`v1.1.0`、`v1.1.1`、`v1.2.0` |

---

## 正常推送（网络通时）

```powershell
cd "D:\Local AI\git\Quick search 源代码"
git add -A
git -c user.name="QQQOrange" -c user.email="62794181+QQQOrange@users.noreply.github.com" commit -m "说明"
git push origin main
```

### ⚠ 判断"推送成功"不能看退出码

`git push` 失败时**也可能退出码为 0**，而且输出里会出现误导性的
`Everything up-to-date`（那是它对自己缓存的判断）。**必须看有没有
`main -> main` 这一行**，或者去 API 核对远端 SHA。

### 网络不通时（本机常见）

`github.com:443` 会超时（`curl 000` / `RPC failed; Connection was reset`），
而 `api.github.com` 正常。两种情况：

- **只是间歇** → 脚本里多试几轮（实测有时第 11 轮才通）
- **持续不通** → 走 GitHub API 的 git 对象接口推送（blob → tree → commit → PATCH ref）。
  这是一条**正规途径**（不需要 git 协议端口），推完用 **blob SHA 逐文件核对**
  证明内容一致。

> 注意：走 API 建出来的 commit，其 SHA 与本地不同（author/committer 元数据不同），
> 所以本地 `origin/main` 会显示落后。**内容是对的**（逐文件核对过）。
> 等网络恢复后 `git fetch` 一次即可对齐。

---

## 发布新版本 Release

### 1. 改版本号（**四处**，必须一致）

```powershell
# Cargo.toml / tauri.conf.json / package.json / package-lock.json（前两处）里的 version
```

> ⚠ v1.2.0 起多了一条约束：**程序版本与模型资产版本是两回事**。
> 模型（4.4/42/84/168 MB）与 `onnxruntime.dll` **不随每个版本重传** ——
> 它们固定挂在某一个 release 上，由 `src/aimodels.rs` 的 `ASSET_RELEASE_TAG` 指定。
> 改那个常量就要同步改所有自托管 URL，**但有一条单测
> （`自托管源指向同一个资产版本`）会立刻把漏改的地方指出来**。

### 2. 写发布说明

`docs/RELEASE-v<版本>.md` —— 参考 `RELEASE-v1.2.0.md` 的结构：
主要改动 / 修掉的 bug / 安装 / **模型在哪个页面下载** / 质量指标 / 验证 / 已知限制 / **校验值** / **许可**。

> ⚠ 校验值那一行必须写成 **`SHA256: <64 位十六进制>`** ——
> v1.2.0 的自动更新会**从发布说明里解析这一行**，用它校验用户下到的更新包。
> 格式写错（少了 `SHA256:` 这个词、或十六进制位数不对）会静默退化成"只比体积"。
> 那条解析逻辑有单测（`从说明里抠出sha256`）钉着。

### 3. 构建并算校验值

```powershell
$env:PATH = "C:\Users\64381\.cargo\bin;$env:PATH"
$env:ORT_SKIP_DOWNLOAD = '1'
cd "D:\Local AI\git\Quick search 源代码"
cargo build --release
Get-FileHash target\release\QuickSearch.exe -Algorithm MD5, SHA256
```

> ⚠ **产物目录不该有 `onnxruntime.dll`**（r80g 起运行库随模型下载）。
> 有的话说明 `build.rs` 的拷贝逻辑又回来了。

### 4. 打 tag + 推送

```powershell
git tag -a v1.2.0 -m "Quick Search v1.2.0"
git push origin main
git push origin v1.2.0
```

### 5. 建 Release + 上传 exe

用 API（不依赖 git 协议端口，网络更稳）。
**资产名必须是 `QuickSearch.exe`** —— 自动更新就是按这个名字挑更新包的：

```powershell
# 需要 token：git credential fill 取
$h = @{ Authorization = "token <TOKEN>"; Accept = "application/vnd.github+json" }
$body = @{ tag_name="v1.2.0"; name="Quick Search v1.2.0"; body=(Get-Content docs\RELEASE-v1.2.0.md -Raw); draft=$false; prerelease=$false } | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri "https://api.github.com/repos/QQQOrange/QuickSearch/releases" -Headers $h -Body $body -ContentType "application/json"
# 再上传资产：POST /releases/{id}/assets?name=QuickSearch.exe  （二进制 body）
```

---

## 发布前检查清单

- [ ] `cargo test` 全过、`cargo clippy` 0 warning
- [ ] 真机探针全过
- [ ] 四处版本号一致（`Cargo.toml` / `tauri.conf.json` / `package.json` / `package-lock.json`）
- [ ] `docs/RELEASE-v<版本>.md` 已写，校验值与实际产物一致
- [ ] **发布说明里有一行 `SHA256: <64 位十六进制>`**（自动更新靠它校验更新包）
- [ ] 产物目录没有 `onnxruntime.dll`
- [ ] README 与 PRD 里**没有**已删除功能的描述（如"手动补描""颜色解混"）
- [ ] 许可文件与 README/发布说明里的许可是同一个
- [ ] 「关于」页的 GitHub 地址仍指向本仓库（`update::REPO_URL`）
- [ ] 若动过 `ASSET_RELEASE_TAG`，自托管 URL 与文档里的"模型在哪个页面下载"两处都改过

---

## 仓库体积说明

| 部分 | 大小 |
|---|---|
| 工作区 | 约 20 MB |
| `ui/data/icons`（407 个图标） | 2.5 MB |
| `.git` | 约 6 MB |

`docs/evidence/`（22MB 截图）、`tools/probe-out/`（16MB 探针日志）、
`tools/*.txt`（探针输出）**已排除在版本控制之外**（`.gitignore` 里写死）。
它们被归档到 `D:\Local AI\git\QuickSearch-evidence-archive`。

> 之所以另存而不是删掉：这些截图与日志是"当时的实测证据"。
> 重跑探针能生成新的，但旧的那份对应旧版本的实测状态，删了就没了。
