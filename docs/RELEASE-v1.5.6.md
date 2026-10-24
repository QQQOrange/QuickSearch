# Quick Search v1.5.6

**补一条逻辑：Ctrl+C 哪怕没复制到文本，也一定弹横条。**

---

## 你指出的问题

> 要补足一个逻辑，因为现在是有两种换出横条的方式，一种是选中文本，一种是用 control 加 c，
> 所以在按 control 加 c 的时候，就哪怕没有复制到文本，那也得换出横条，这是一个逻辑问题。

说得对。Ctrl+C 是**独立的第二条唤起通道**，但以前它挂在一个前提上：
"剪贴板序号必须变化"。变不了就什么都不弹 —— 于是在那些"不接受复制"的软件里
按 Ctrl+C，用户看到的和"没这个功能"完全一样。

## 改了什么

`read_current` 的职责从**决定弹不弹**改成**决定弹成什么样**：

| 这次 Ctrl+C 的结果 | 弹成什么 |
|---|---|
| 剪贴板变了，有文字 | 带这段文字的横条 |
| 剪贴板变了，是图片 | 「识别图片文字」形态（OCR） |
| 剪贴板变了，但只有文件 | **空横条** |
| 剪贴板一直没变（SIGINT / 空选区 / 手滑） | **空横条** |
| 剪贴板被另一条取词占着 | **空横条** |

抽了一个纯函数 `ctrl_copy_bar(Got) -> CopyBar` 把这口径钉住，配一条测试
`ctrl_copy_never_silently_skips`：以后谁想让某个分支"静默跳过"，改到这里就会红。

## 空条**绝不**装上次剪贴板的内容

这是这条改动最容易踩的坑，也是 2026-10-23 那轮"横条莫名其妙冒出来"的真正原因：
老版本"按了 Ctrl+C 就读剪贴板"，于是终端里 Ctrl+C（SIGINT）、对话框里复制空选区、
手滑碰一下，都会弹出一条装着**上一次复制的东西**的横条。

现在的路径是：等不到剪贴板变化 → `Got::Nothing` → **弹空条**（`show_bar("")`）。
`show_bar` 内部 `remember_text("")` 会把选区状态清空，所以旧文字一个字都带不出来。

## 顺带快了 380ms

以前是"等最多 500ms 确认剪贴板变了才决定弹不弹"。现在这 500ms 变成 **120ms**，
而且只用来决定"带不带文字"：

- 正常复制几毫秒就落地 → 一次弹准，感觉不到等待；
- 复制特别慢（远程桌面 / 剪贴板管理器转一手）→ 先弹空条，
  `late_text_patch` 在之后 900ms 内把文字补进**同一根横条**（不重新摆窗，看不见跳）。

## 设置项口径同步

「没取到文字就不弹」改名为 **「划选没取到文字就不弹」**，只影响划选那条路。
理由写进了 `config.rs`：两条路的"误触"性质不同 —— 拖动到处都是（拖窗口、拖滚动条、
拖画布都算划选），Ctrl+C 只有真的按了才有。所以 Ctrl+C 不受这个开关管，哪怕它开着
也照样弹。

## 验证（这次也是端到端，不是只看单测）

新增 `tools/r156-ctrlc-probe.js`：起独立实例，调 `__probe_copy_trigger` 把
"按了一次 Ctrl+C"完整走一遍真路径（`copy` 参数决定要不要先写剪贴板），再读真日志断言。

本机实测输出：

```text
预检 config -> {"barNeedText":true,"triggerCopy":true}
[copy]    invoke __probe_copy_trigger -> ok seq=128
PASS  [copy] 复制成功时横条弹出来了（after-show visible=true）
PASS  [copy] 文字真的进了横条（show_bar 记 10 字）
PASS  [copy] Ctrl+C 这条路贴鼠标（atMouse=true）
[no-copy] invoke __probe_copy_trigger -> ok seq=133
PASS  [no-copy] 真的弹出来了（after-show visible=true）
PASS  [no-copy] 走的是"没等到剪贴板变化"那条分支
PASS  [no-copy] 横条是空的（0 字）
PASS  [no-copy] 没有复用剪贴板里的旧内容（10 字 → 0 字）
PASS  [no-copy] 「划选没取到文字就不弹」开着也照样弹（Ctrl+C 不受它管）
结果：8 PASS / 0 FAIL
```

最后两条是这次改动的核心断言：先用 `copy: 'OLDCONTENT'`（10 字）把剪贴板写满，
再调 `copy: null` —— 第二次必须是 **0 字**，证明没有把旧内容当成这次的复制。

其余验证：

- Rust **313** 全过（新增 `ctrl_copy_never_silently_skips`）；
- UI 套件 **513 / 513**；
- 主目标 clippy **0 warning**，`--all-targets` 0 error。

## 一处限制说清楚

`__probe_copy_trigger` 是探针专用的内部命令（和 `show_bar` 一样注册在
`generate_handler!` 里）。本机单用户桌面应用，多一个内部命令的暴露面可以忽略；
它只做一件事：把 `copy_trigger` 走一遍。真实的 Ctrl+C 由低级键盘钩子调同一个函数。

---

## 更新包校验

| 文件 | 大小 | SHA256 |
|---|---|---|
| `QuickSearch.exe` | 13,337,088 字节 | `FEAC60A7C0F161C273A602A92FDEB81FAD9FF6EFE438AE188DDD1FD678D025C5` |
