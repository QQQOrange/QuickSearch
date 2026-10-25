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
| GitHub 凭据 | ✅ 凭据管理器里有（`git credential fill` 能拿到，2026-10-25 验证 200） |
| 网络 | ⚠️ **间歇性**：`github.com:443` 时通时不通；`api.github.com` 一直可用 |
| 发布 | ✅ 最新 Release **v1.5.12**（2026-10-25），资产 `QuickSearch.exe` 13,427,200 字节 |

### ⚠ 两条必须记住的环境事实（2026-10-25 实测）

1. **`curl` 走系统代理，程序的 `ureq` 不走系统代理。**
   所以"我命令行下得好好的"和"软件下不下来"可以同时成立 ——
   `curl` 输出里出现 `HTTP/1.1 200 Connection Established` 就是走了代理的证据。
   **验证下载问题时不要用 curl 的结论去否定程序的行为。**

2. **本机 `github.com:443` 直连超时，`api.github.com` 直连正常。**
   - 检测更新走 `api.github.com` → 通，所以能看到新版；
   - 下载走 `github.com/.../releases/download/...` → 不通，所以下不下来。
   这就是 v1.5.11 要加"备源回退"的原因。同一份资产在
   `api.github.com/repos/<repo>/releases/assets/<id>`（带
   `Accept: application/octet-stream`）上拿得到。
   git push 连续 502 也是这条链路。

---

## 2026-10-25 发 v1.5.10 时踩到的三个坑（都已解决，记下来免得重犯）

### 1. 远端历史可能是走 API 建的，push 前**必须先 fetch 比较**

v1.5.0~v1.5.3 当年是走 API 推的，commit SHA 与本地**不同**（内容相同）。
于是 `git push origin main` 直接：

```text
! [rejected]  main -> main (fetch first)
hint: Updates were rejected because the remote contains work that you do not have locally.
```

正确做法（**不要 force push**）：

```bash
git fetch origin main
git diff --stat <本地对应的那个版本> origin/main   # 为空 = 内容一致
git rebase --onto origin/main <本地对应的那个版本> main
```

实测 `git diff --stat 5eda648 ad74d58` 为空 → rebase 8 个 commit 一次过、零冲突。

> ⚠ **rebase 之后所有 tag 都指向旧 SHA**，要重打：
> ```bash
> for v in 1.5.4 1.5.5 1.5.6 1.5.7 1.5.8 1.5.9 1.5.10; do
>   sha=$(git log --format="%H %s" | grep -F "（v$v）" | head -1 | cut -d' ' -f1)
>   git tag -f "v$v" "$sha"
> done
> ```

### 2. 判断 push 成功**不能只 grep `main -> main`**

被拒的那一行**也**长这样：

```text
! [rejected]        main -> main (fetch first)
```

所以必须先排除 `rejected`：

```bash
if echo "$out" | grep -qE "main -> main" && ! echo "$out" | grep -q rejected; then ...
```

或者干脆用 API 核对远端 SHA（最可靠）：

```bash
curl -s https://api.github.com/repos/QQQOrange/QuickSearch/commits/main | grep -m1 '"sha"'
```

### 3. git 协议持续不通时，**单文件更新走 Contents API**

`CONNECT tunnel failed, response 502` 连续 10 轮都不通，但 `api.github.com` 正常。
这时不要硬等，用 Contents API 改那一个文件：

```bash
# 1) 先拿远端当前 sha
curl -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/QQQOrange/QuickSearch/contents/<path>?ref=main"
# 2) PUT 回去（content 用 base64，带上 sha 和 branch）
curl -X PUT ... "https://api.github.com/repos/QQQOrange/QuickSearch/contents/<path>"
```

> 副作用：会产生一个 SHA 与本地不同的 commit，本地 `origin/main` 看起来"落后"。
> 等网络恢复 `git fetch` + `git rebase` 即可自愈 —— 改动内容相同，Git 会判定
> "patch already applied" 直接跳过。**内容已核对一致**（2026-10-25 实测 4645 字符全等）。

> ⚠ 附件（exe）**不能**走 Contents API，必须走
> `POST https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=QuickSearch.exe`
> ，`Content-Type: application/octet-stream`，成功返回 **201**。

### 4. 2026-10-25 发 v1.5.12：代理整段 502，用 Git Data API 推的

那天 `http_proxy`（`127.0.0.1:63546`）对 github.com 一律返 **502**，
`env -u *_proxy` 直连则 **21 秒超时** —— 两条路都不通，而 `api.github.com` 正常。
那就不要再用 git 协议，直接拼对象：

```text
GET  /git/ref/heads/main              → 远端 SHA + tree
POST /git/blobs        × N            → 每个改过的文件一个 blob（base64）
POST /git/trees        {base_tree, tree:[…, {path, sha:null} 表示删除]}
POST /git/commits      {message, tree, parents:[远端SHA], author, committer}
PATCH /git/refs/heads/main            → {sha: 新 commit, force: false}
POST /git/tags + /git/refs            → annotated tag
```

两个实测要点：

- **`base_tree` + 只列 diff**，不要把整棵树重建一遍（仓库几千个 blob，逐个上传不现实）。
  删除项写成 `{"path": p, "mode": "100644", "type": "blob", "sha": null}`。
- **commit SHA 会与本地不同**（API 侧的 committer 元数据不完全受控），但
  **tree SHA 可以完全一致** —— 这就是"内容确实推上去了"的硬证据。
  v1.5.12 实测：本地 tree `514c00f4b6` / 远端 tree `514c00f4b6` 相同，
  `git rev-parse HEAD:ui/bar.js` 与 `/contents/ui/bar.js` 的 blob sha 也相同。
- 本地因此会与远端**分叉**（内容相同、SHA 不同）。等网络恢复后
  `git fetch` + `git rebase` 即可自愈，Git 会判定 patch already applied。


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
      —— ⚠ `package.json` 最容易漏（v1.5.4~v1.5.9 就一直停在 1.5.3 没动）
- [ ] `docs/RELEASE-v<版本>.md` 已写，校验值与实际产物一致
- [ ] **发布说明里有一行 `SHA256: <64 位十六进制>`**（自动更新靠它校验更新包）
- [ ] **push 前先 `git fetch` 比较本地与远端**（远端若是 API 建的会 rejected，见坑 1）
- [ ] Release 建完**核对三件事**：`releases/latest` 指向新 tag、资产
      `state == "uploaded"`、`size` 与本地产物一致
      —— ⚠ **资产数 0 时自动更新能"检查到新版"却装不了**，v1.5.10 差点漏掉
- [ ] 从更早版本直升的用户：发布说明里要有**累积改动说明**（中间版本不单独发 release）
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
