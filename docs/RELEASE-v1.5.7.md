# Quick Search v1.5.7

**更新页多了「GitHub 个人访问令牌」：额度从 60 次/小时 提到 5000 次/小时；没填令牌时只提示、不自动下载，把下载链接摆出来。**

---

## 你提的三件事

> 1. 当前自动更新使用 GitHub API，存在请求限额；请在更新页面新增「GitHub 个人访问令牌」输入框，
>    用户填写后使用该令牌进行 GitHub 请求，并移除或绕过原有与限额相关的逻辑。……参考 Obtainium
>    中 GitHub 个人访问令牌的相关实现并复用。
> 2. 当用户未填写 GitHub 个人访问密钥时，程序只提示有新版本需要更新，但不执行自动下载。
>    在显示更新提示时，同时展示 GitHub 下载链接网址，用户点击该链接即可跳转到浏览器进行下载。
> 3. 在输入框或标签旁边新增一个问号图标……点击后在新标签页打开 GitHub 官方帮助文档。

后面你还补了一句更关键的：

> 检测更新就只有两种形式，一种是软件打开的时候自动检测一次，另一种就是手动点击检测……
> 如果没有填个人访问密钥的情况下，就算检测到了，也不能点击下载。

所以第二条不是"某个按钮的事"，是**两条路都得成立**。下面按"令牌怎么进请求"、
"没令牌时怎么走"、"问号是怎么做的"分开讲。

---

## 一、令牌：一次请求拿全，不再靠省额度

老版本为了躲 60 次/小时，搞了个取巧办法：先请求 `releases/latest` 的 **302**，
只读响应头 `Location` 里那个 tag 名（这一步不烧 API 额度），发现真有新版才去调一次 API
拿说明和安装包地址。能省额度，但代价是**每次都多一跳**、而且 tag 解析本身是个易碎品
（GitHub 改重定向形式就哑）。

现在的分叉在 `update::check()` 里，两行看完：

```rust
match current_token() {
    Some(tok) => check_with_token(&tok, current),   // 一次 API
    None      => check_anonymous(current),          // 老路：302 探一下再决定
}
```

有令牌走 `api_latest(Some(token))`，**一次请求**就把版本号、release notes、资产地址全拿回来，
不再有第二次往返。老路完整保留给没令牌的人 —— 这是"绕过限额"和"别把没填令牌的人搞坏"的折中：
不填令牌照旧能用，只是额度仍是 60。

### 令牌怎么放（照 Obtainium 的约定）

请求头是 `Authorization: Token <pat>`，**不是** `Bearer`。这一条是从 Obtainium
（`_sourceRequestWithAuthFallback`）那套实现里对过来的：GitHub 两种都收，
但 `Token` 是它自己文档和 Obtainium 都在用的写法，跟它对齐省得以后排查时怀疑人生。

### 令牌清洗（这是最容易踩的坑）

粘贴过来的令牌十次有八次带脏东西：行尾多个空格、从网页复制时混进换行、外面套一层引号，
还有一种更阴的 —— 从别处抄来的 `用户名:令牌` 老格式。这些都会导致 401，
而 401 的提示看起来像"你令牌不对"，实际上令牌是对的。

`effective_token()` 按顺序做：`trim` → 去外层成对引号 → 遇到 `:` 取冒号后面那段 →
剔除所有空白与控制字符 → 长度截到 512。**只记长度、不记内容**（下面隐私那节展开）。

### 令牌被拒时自动降级，不是直接报废

填了令牌但过期 / 权限不够 / 拼错，GitHub 会回 401，或者在 body 里写
`Bad credentials` / `Bad authentication data`。`auth_rejection()` 认这几种字眼，
认出来就走 Obtainium 同款做法：**自动退回匿名请求重试一次**。

这样做的理由是"更新检查不该因为一个填错的令牌彻底失效" —— 公开仓库匿名也能查。
退回后 `UpdateInfo.authed` 会置 `false`，并且带一句 `auth_warning` 给界面弹 toast，
让你知道"这次没用上你的令牌，因为 GitHub 说它无效"。**不会静默降级**——
静默降级等于让你以为令牌生效了，实际一直在用 60 次/小时的额度。

### 限流提示要给出路

`rate_limit_message()` 分两种口气。没令牌时不只是报错，要告诉你**怎么解决**：

```text
GitHub 接口限流了（没填令牌时每小时只有 60 次）—— 约 37 分钟后恢复。
到「更新」里填一个 GitHub 个人访问令牌，额度是 5000 次/小时
```

那个"约 N 分钟"是从响应头 `x-ratelimit-reset` 算的（`minutes_until()`，
向上取整、夹在 9999 以内、时钟偏了按 0 算不给负数）。读响应头的时机很关键：
必须在**消费 body 之前**读，`ureq` 一旦把 body 读掉，header 就跟着没了。

---

## 二、没填令牌：只提示，不自动下载

### 两条路，一个出口

| 检测方式 | 触发 | 出口 |
|---|---|---|
| 启动后自动一次 | 开程序 8 秒后，后台线程 | `do_check_update(false)` → `emit_update` |
| 手动点「检查更新」 | 用户点击 | `do_check_update(true)` → `emit_update` |

两条路都从 `emit_update` 出去，所以判断只在**一个地方**做：载荷构造函数
`update_payload(info, manual, can_auto)`。设置页当时没开也没关系 —— 结果会存进
`UPDATE_PENDING`，等你打开「关于」页时由 `update_pending` 读回来，**同一个**
`update_payload` 再拼一次。`update_pending` 不联网、不调 GitHub，所以它不是第三种检测。

### 判断的是"现在"，不是"当时"

这里有个容易写错的地方，我特意拆开了。`UpdateInfo.authed` 记的是"**那次检查**实际
用没用上令牌"，而界面要的是"**现在**能不能自动下载"：

```rust
pub fn can_auto_download() -> bool {
    current_token().is_some()      // 只认配置里此刻有没有令牌
}
```

为什么不能直接用 `authed`：启动时那次检查的结果会在 `UPDATE_PENDING` 里躺到你打开
设置页，而**填令牌发生在它之后**。照抄旧结论会出两种自相矛盾的界面：

- 启动时没令牌查到新版 → 你随后填了令牌 → 还举着「用浏览器下载」；
- 检查时用了令牌 → 你随后清空 → 还举着「下载并安装」，点下去被后端拦。

所以 `authed` 只留在日志和"令牌为啥没生效"的提示里，`canAuto` 才是界面开关。
顺带一个好处：填上令牌的**那一刻**按钮就变了（`updSyncCanAuto`），不用再查一遍。

### 前端变样，后端硬拦

| `canAuto` | 按钮文字 | 点它做什么 |
|---|---|---|
| `true` | **下载并安装** | 程序内下载 → 校验 → 替换 → 重启 |
| `false` | **用浏览器下载** | 打开 GitHub 下载链接 |

同时按钮下面多一行「GitHub 下载链接」+ 完整网址（`#updLinkRow`），可以肉眼确认、
可以右键复制；点链接或聚焦后按空格都能打开。

后端还有一道硬拦（`update_install` 开头）：

```rust
if !update::can_auto_download() {
    win::log("update: 没有 GitHub 令牌，按口径不自动下载（只提示 + 给链接）");
    wd_toast("没填 GitHub 令牌，只提示不自动下载 —— 点下面的下载链接去浏览器装");
    return;
}
```

为什么界面都改了还要拦一道：旧页面缓存、探针、或者点太快，都可能绕过前端判断。
前端管体验，后端管口径 —— 两道都在，才不会出现"明明没令牌却自己下起来了"。

---

## 三、问号图标

一个原生 `<button>`，不是 `<span>` 加 JS：

```html
<button type="button" class="qhelp" id="btnGithubTokenHelp"
        data-tip="什么是 GitHub 个人访问令牌？点这里看官方说明"
        aria-label="什么是 GitHub 个人访问令牌？在新标签页打开 GitHub 官方帮助文档">
    <span aria-hidden="true">?</span>
</button>
```

- **对齐**：`.upd-token-head` 是 flex 行，问号跟着标题文字走，垂直居中；
  输入框那行是独立的 `.upd-token-row`，不受问号影响（避免"问号一出现输入框就缩"）。
- **样式**：16px 圆、边框和颜色沿用页面既有的 `--ln` / `--fg2`，hover 才实心。
  tooltip 用 CSS `::after { content: attr(data-tip) }`，hover 或 `:focus-visible` 时浮出，
  不引第三方库。
- **无障碍**：`aria-label` 说明用途（tooltip 是视觉补充，读屏读的是 label）、
  原生按钮自带 Tab 聚焦与回车/空格触发、`:focus-visible` 给一圈可见焦点。
- **链接集中**：`ui/settings.js` 里一个常量，改地址只改这一行：

  ```js
  const GITHUB_PAT_DOC_URL = 'https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';
  ```

- **不动老逻辑**：这个按钮不碰输入、校验、提交。令牌走的是页面统一的
  `change → set_setting` 链路（`TEXTS` 里加一行 `['s-githubToken','githubToken']`），
  和别的输入框一个待遇。另外「检查更新」按钮点击时会**先落盘再查** ——
  防止你刚打完字就点检查、`set_setting` 的 IPC 还没到后端。

---

## 隐私：三处都不落地

令牌是凭据，处理上有三条硬规矩，都在代码注释里钉着：

1. `config.rs` 的 `sanitize()` 只兜形状（去脏、截长），**日志只打字符数**；
2. `update.rs` 打印状态时只打 `用令牌=true/false`，从不打值；
3. 前端输入框是 `type="password"` + `autocomplete="off"` + `spellcheck="false"`，
   不参与任何表单提交，也不进 CHANGELOG 之外的文本。

探针里有一条专门验证这个：跑完整个流程后 grep 实例日志，**令牌原文一次都不许出现**。

---

## 验证

### 端到端：本地假 GitHub

单测能证明"我们打算把令牌放进 `Authorization`"，证明不了 `ureq` 那层真的发出去了。
所以 `tools/r157-github-token-probe.js` 起一个本地假 GitHub（`127.0.0.1:9431`），
用 `QS_UPDATE_API` / `QS_UPDATE_WEB` 把实例指过去，再逐条对请求头。

本机实测（对最终发布产物 `v1.5.7`）：

```text
r157 探针：假 GitHub 在 127.0.0.1:9431
实例 pid=36172（不影响已部署的那个）
PASS  启动时自动检查：没点按钮就查到了新版
PASS    日志确认那次是匿名请求（用令牌=false）
PASS    没令牌 → canAuto=false（界面只能给"用浏览器下载"）
PASS    但下载网址照样带回来了（用户有出路）
PASS  没令牌时直接调 update_install 会被后端拒绝
PASS    而且一个下载请求都没发出去
[令牌] 请求记录：/api-latest +auth
PASS  填了令牌：API 请求带 Authorization: Token <令牌>
PASS  有令牌时只调一次 API 就拿全（不再走 302 省额度）
PASS  update_pending 回报 canAuto=true（前端才给"下载并安装"）
PASS    也如实记下这次检查用了令牌（authed=true）
PASS    下载地址也带回来了
PASS  日志里不出现令牌原文（凭据不入日志）
PASS  清空令牌后：请求不带 Authorization
PASS    走 302 那条路（/web-latest 被请求，省 API 额度）
PASS    清空令牌后 canAuto 立刻变 false（不沿用那次检查的结论）
PASS  令牌被拒：第一次确实带了令牌
PASS    然后自动用匿名请求重试（公开仓库照样能查）
PASS    日志写明降级原因
PASS    降级后 authed=false（如实记下那次没用上令牌）
PASS    但令牌还填着 → canAuto=true（下载走匿名兜底，不会 403）
PASS  限流错误说清还要等多久（约 N 分钟）
PASS    没令牌时引导去填个人访问令牌

结果：22 PASS / 0 FAIL
```

最前面 6 条（第 ⓪ 组）专门验你补充的那条：**不点任何按钮**，等它自己启动 8 秒后的
那次检查，然后断言"查到了新版、但没令牌 → `canAuto=false`"，再**直接调**
`update_install`（模拟界面被绕过）—— 后端必须拒绝，而且假 GitHub 那边一个下载请求
都不许收到。第 ② 组里的 `清空令牌后 canAuto 立刻变 false` 则是手动检测那条路的对应断言。

> ⚠ 写这个探针时踩了两个坑，记下来免得以后重犯：
> ① 等待不能照抄 r155/r156 的 `Atomics.wait` —— 那是**同步阻塞**，会把 Node 的
> 事件循环一起冻住，而假 GitHub 就跑在同一个进程里，于是"服务端永远不响应"，
> 看起来像令牌没生效。必须用 `await new Promise(r => setTimeout(r, ms))`。
> ② 探针和开发机共用 `target/release/Quick search data`，而探针为了不被打扰会把
> 「自动更新」关掉 —— 如果上一轮没还原，这一轮启动时压根不会自动检查，第 ⓪ 组
> 就变成空转。所以现在开跑前先起一个实例把配置摆回出厂状态（`autoUpdate=true`、
> 令牌清空），跑完再还原。

### 其余

- Rust **319** 全过（新增 6 条：令牌清洗、api 拼装、缺安装包报错、限流文案、分钟取整，
  以及 `没令牌的载荷不许给自动下载` —— 那条直接构造"检查时用了令牌、但现在没令牌"
  的矛盾场景，钉住"界面只认 `canAuto`"）；
- UI 套件 **542 / 542**（`testUpdateToken()` 约 27 条断言，覆盖：密码框 / aria-label /
  文档链接、"查到了但没令牌"时按钮变「用浏览器下载」且 `update_install` 一次都没被调用、
  启动时那条缓存路径（`update_pending`）同样只给链接、当场填令牌按钮立刻变、
  清空令牌立刻退回、`authWarning` 弹 toast、"先存再查"的 IPC 顺序）；
- 主目标 clippy **0 warning**（`minutes_until` 的向上取整改用了 `div_ceil`，行为不变）。

### 顺手修的一条老测试竞态（和本功能无关）

`crypto::tests::salt_is_reused_but_nonce_is_fresh` 断言"同一个密码两次加密的盐相同"，
但 `KEY_CACHE` 只缓存一格、`cargo test` 又是多线程并行 —— 别的用例只要用另一个密码
加解密一次，盐就被挤掉了。表现是**单跑必过、全量偶发失败**，看着像加密坏了。

现在那条用例同时拿两把锁：`config::test_lock()`（挡住 main / config 模块里那些落盘
加密的用例）和模块内的 `CACHE_LOCK`（挡住 crypto 自己的其它用例）。只挡一半没用，
漏掉哪一类盐都会被换掉。连跑三次全量：**319 / 319**。产品代码一行没动。

---

## 更新包校验

| 文件 | 大小 | SHA256 |
|---|---|---|
| `QuickSearch.exe` | 13,365,760 字节 | `72A480535F823B9E60DAE553AD7C2698B073CCE703DDBC41C7070E3E15BE2F15` |
