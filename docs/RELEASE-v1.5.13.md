# v1.5.13 —— 多语言 / 自动更新窗 / 启动密码

这一版是三件独立的活，一次交付：**界面多语言（简体中文 / English）**、
**启动时自动检查更新并给出可取消的下载窗**、**可选的启动密码**。

---

## 1 多语言：中文原文当键，DOM 层替换

不做 `data-i18n="key"` 那套 —— 那样得把整个设置页（1500 行 HTML + 7000 行 JS
里几百句 `textContent = '…'`）改成查表，改动面比翻译本身大得多，还会把
`textContent` 拼字符串的地方全打碎。

实际做法是**中文原文就是键**：运行时按文本节点 / 整句 / 属性去查表，命中了就换，
同时把原值记进 `RECORDS`。切回中文时按记录**逐字还原**，不是"再翻一遍"。

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单个文本节点 | 字典精确命中 | 大多数按钮、标签 |
| 一句带内联标签的话 | 整句命中，译文可带 `<b>` | `.hint` / `small` / `li` |
| 极长静态文（帮助页） | `data-i18n-block` 整块换 innerHTML | 帮助卡片 |
| JS 拼出来的提示 | `p:` 前缀碎片 / `s:` 后缀碎片 | `已添加「X」并固定到横条` |
| 带数字的句子 | `RULES` 正则（只整串匹配） | `共 5 项` → `5 items` |
| 后来才出现的文案 | `MutationObserver` 兜底 | toast、列表刷新 |

中文原文当键的好处是：**新增文案只要往 `_i18n_parts/*.json` 补一行**，不用动任何
标记。代价是"哪些句子没翻"要靠审计工具盯 —— 见第 4 节。

字典是**生成**的，`ui/i18n.en.js` 别手改：

```bash
node tools/gen-i18n.js      # 合并 _i18n_parts/*.json + *.html → ui/i18n.en.js
```

当前规模：`entries=994  blocks=2  frag=87  rules=55`。

### 它顺带修掉的两个真 bug

**① 同一元素上两个属性互相顶掉**

```js
// 原来：SEEN 以元素为 key
remember({ kind: 'attr', el, name, zh: el.getAttribute(name) }, el);
```

一个 `<input>` 上同时有 `placeholder` 和 `title`，后记录的那条会把前一条的
`name` / `zh` 直接改写 —— 切回中文时只有一个属性被还原，另一个永远停在英文。
现改成二级索引（元素 → 槽位，`attr` 再按属性名分）：
切英文再切回来，`body.innerHTML` 与切换前**逐字节一致**（测试里就是这么断言的）。

**② 整句替换把滑块的实时数字冲掉了**

```html
<small><span id="s-barBlurVal">30</span> · 值越大越糊…</small>
```

整句翻译直接换 `innerHTML`，译文里没有那个 `span`，于是
`$('s-barBlurVal')` 变成 `null`，拖滑块时旁边的数字再也不动。
现在加了 `replaceable()`：**里面挂着带 id 的子元素就不许整句换**，
退化成"只翻文字节点"。

### 一条诚实的边界：引擎名不翻

引擎库有 600 多条中文名字（`百度`、`豆瓣读书`、`哔哩哔哩`…），而且用户自己也能加
（`公司内网搜索`）。翻其中一部分的结果是「豆包」成了 Doubao、「我的内网」还是中文
—— 同一张列表两种语言，比整张不翻更难看；何况这些名字是用户输入的检索词，翻了
还和他当初打的字对不上。

所以 `.nm` / `.letter` / `.eng-letter-h`（引擎名、首字母块）按**数据**对待，
一律原样。工具栏按钮的提示语里如果带名字，翻的是名字之外那半句：
`百度　（左键搜索 / 右键换图标）` → `百度 (left-click to search · right-click to change the icon)`。

要改成"名字也翻"，需要一张 600 行的名字映射表 —— 那是另一个决策，没在这版里做。

---

## 2 自动更新：检查照旧，多了下载窗和取消

启动检查沿用原来的 `auto_check_on_start`（只查 `api.github.com`，不下载）。
查到新版本时除了原来的横幅，还会**弹出一个独立窗口**：

- 窗口 `skip_taskbar(false)` —— 任务栏里看得到，不会"点了下载之后没反应"；
- 进度条 + 已下载 / 总大小 + 速度；
- **取消按钮**真正能中断：`update::request_cancel()` 置 `AtomicBool`，下载循环
  每读一块检查一次，命中就断开、走 `DlFail::Cancelled`，**不重试**、不落半截文件；
- 下载完成 / 失败 / 取消都有终态，取消后可以直接重来。

---

## 3 启动密码：独立于备份密码

- 存的是 **Argon2id PHC 串**（`argon2` + `password-hash`），配置里只有哈希，
  没有明文，也不参与备份信封；
- 和备份密码**完全不同的一套东西**：备份密码管的是"配置能不能被解开"，
  启动密码管的是"这个程序能不能被用"；改一个不影响另一个，忘了备份密码也
  照样能解启动锁（反之亦然）；
- 开着的时候，启动即弹锁屏窗（无边框、可拖动、只接受密码），
  验对了才 `post_unlock_startup()` 放行；**托盘菜单、全局快捷键、粘贴取词
  全部被门禁挡住**，不是只挡界面；
- 关掉时 `startup_password_hash` 清空，下次启动就当没这回事。

---

## 4 回归

| 项 | 结果 |
|---|---|
| `cargo test --release` | **343 passed / 0 failed** |
| `cargo clippy --release` | **0 warning** |
| `node tools/test-ui.js` | **621 / 621** |
| `node tools/test-i18n.js`（本轮新增） | **31 / 31** |

`test-i18n.js` 新增的 31 条里，真正有价值的是这几条：

```
PASS    切到英文后设置页不再有中文
PASS    帮助页整块换成了英文版（不是逐句半翻）
PASS    帮助页的折叠状态没被整块替换冲掉
PASS    切回中文后 innerHTML 完全一致（结构、空白都没被改）
PASS    滑块旁边的实时数字还在（没被整句替换吞掉）
PASS    引擎名按数据保留原文（不翻译）
PASS    标签 + 后端原话：前半截翻、后半截保留
PASS    用户数据不被碎片误伤
```

补漏审计（人看的清单，不是断言）：

```bash
node tools/i18n-audit.js            # 设置页
node tools/i18n-audit.js ocr.html   # 任意一页
```

八页结果：`settings` / `ocr` / `iconedit` / `picker` / `region` / `lock` / `update`
**残留 0 条**；`index.html` 只剩引擎名本身（按上面的边界有意保留）。

### 顺带记一个 Windows 的坑

新窗口的权限文件最初叫 `capabilities/aux.json`。`AUX` 是 Windows 的**保留设备名**
（和 `CON` / `NUL` / `COM1` 一样），Win32 会把路径当设备处理：

```text
$ git add capabilities/aux.json
error: open("capabilities/aux.json"): No such file or directory
```

`ls` / `cat` 都正常，`git` 死活读不到 —— 文件明明在那儿。改名成
`capabilities/popup.json` 就好了（capability 的 `identifier` 仍是 `aux-win`，
运行时行为不变）。以后别用 aux / con / nul / prn / com1~9 / lpt1~9 当文件名。

---

## 更新包校验

SHA256: FDC49FA10110DA6BCBD98468DE594E74943B7DA84295E9D40E6260E19E2FAFB9

| 文件 | 大小 | 校验值 |
|---|---|---|
| `QuickSearch.exe` | 13,636,096 字节 | 同上（MD5 `8CA3638B28FCB356A75A5EDCB3057F52`） |

> 上面那一行 `SHA256: <64 位十六进制>` 是**自动更新用的**：程序会从发布说明里
> 解析它，校验用户下到的更新包是不是我们发的这一份（`update::sha_from_notes`）。
> 删掉它会静默退化成"只比体积"。

---

## 装机

覆盖 `QuickSearch.exe` 即可，配置、收藏夹、图标都不动。

> 配置结构是**新增字段**（`uiLang` 默认 `zh`、`startupPasswordHash` 默认空），
> 老配置读进来会被 `sanitize()` 补齐，从任何旧版本直升都不需要迁移，
> 升上来默认还是简体中文、没有启动密码 —— 和升级前完全一样。
