# 推送到 GitHub（一键脚本）

本仓库已经**完全就绪**，只差你本人授权一次。下面两种方式任选其一。

---

## 现状（已确认的事实）

| 项 | 状态 |
|---|---|
| 本地仓库 | ✅ 已初始化，分支 `main`，3 个提交，875 个跟踪文件 |
| 远端配置 | ✅ `origin` = `https://github.com/QuickSearch-Desktop/QuickSearch.git` |
| 网络到 GitHub | ✅ 通（`git ls-remote` 公共库成功，读端点 200） |
| GitHub 凭据 | ❌ **没有**（无 gh CLI、无 SSH key、无 token、无凭据管理器记录） |
| 目标仓库 | ❌ 尚不存在（`QuickSearch-Desktop/QuickSearch` 返回空） |

> 换而言之：**代码没问题、网络没问题，只差认证。** 浏览器里的登录态无法直接
> 变成 git 的推送凭据（那是安全设计），必须显式授权一次。

---

## 方式 A：用 Personal Access Token（最快，2 分钟）

### 1. 建 token

浏览器已登录 GitHub，直接打开：

**https://github.com/settings/tokens/new**

- Note：`QuickSearch push`
- Expiration：按需（30 天即可）
- 勾选 **`repo`**（完整仓库权限，新建私有库必需）
- 点 **Generate token**，复制那串 `ghp_...`（**只显示一次**）

### 2. 在本机执行

打开 PowerShell，粘贴执行（把 `<TOKEN>` 换成刚才那串）：

```powershell
cd "D:\Local AI\git\Quick search 源代码"
git remote set-url origin https://<TOKEN>@github.com/QuickSearch-Desktop/QuickSearch.git
git push -u origin main
```

成功后**立刻**把 URL 里的 token 去掉（别留在 `.git/config` 里）：

```powershell
git remote set-url origin https://github.com/QuickSearch-Desktop/QuickSearch.git
```

### 3. 仓库还没建？

上面第 2 步会失败（`repository not found`）。先在浏览器建一个空仓库：

**https://github.com/new**

- Repository name：`QuickSearch`
- Owner：`QuickSearch-Desktop`（或你自己的账号，那就把上面的 URL 一起改掉）
- **不要**勾 "Add a README"（否则要先 pull）
- Public / Private 随意

建完再执行第 2 步。

---

## 方式 B：用 SSH key（一次配置，长期免 token）

```powershell
# 1. 生成 key（一路回车即可）
ssh-keygen -t ed25519 -C "quicksearch@local"

# 2. 复制公钥
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
```

浏览器打开 **https://github.com/settings/keys** → **New SSH key** → 粘贴 → 保存。

```powershell
# 3. 验证
ssh -T git@github.com

# 4. 切远端并推送
cd "D:\Local AI\git\Quick search 源代码"
git remote set-url origin git@github.com:QuickSearch-Desktop/QuickSearch.git
git push -u origin main
```

---

## 方式 C：让我代劳（如果你愿意给凭据）

你可以在下一条消息里告诉我 token（或用完即焚的临时 token），我来执行推送并
**在推送完成后立刻把 token 从 `.git/config` 里清掉**。

⚠ 但更推荐你自己跑方式 A —— token 不该经过任何第三方，包括我。

---

## 推送完成后验证

```powershell
cd "D:\Local AI\git\Quick search 源代码"
git log --oneline                    # 应有 3 个提交
git ls-remote --heads origin         # 应能看到 refs/heads/main
```

浏览器打开仓库页面，应能看到 `README.md` 与 `docs/PRD.md`。

---

## 仓库体积说明

| 部分 | 大小 |
|---|---|
| `.git` | 约 5 MB |
| 工作区 | 约 20 MB |
| `ui/data/icons`（407 个图标） | 2.5 MB |

`docs/evidence/`（22MB 截图）与 `tools/probe-out/`（16MB 探针日志）**已排除在版本
控制之外**（`.gitignore` 里写死了）。它们被归档到
`D:\Local AI\git\QuickSearch-evidence-archive`，需要追溯历史实测结果时去那里看。

> 之所以另存而不是删掉：这些截图与日志是"当时的实测证据"，重跑探针能再生成
> 新的，但旧的那份对应的是旧版本的实测状态，删了就没了。
