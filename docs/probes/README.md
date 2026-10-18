# 探针（真机验证脚本）

本目录的脚本用来在**真实的 Windows 环境**里验证 QuickSearch 的行为。它们不是单元
测试的替代品，而是补单元测试测不到的那一层：真实 WebView2 渲染、真实窗口焦点、
真实的系统钩子与剪贴板。

## 为什么用 CDP 而不是模拟鼠标

早期用 `SendInput` / `SetCursorPos` 注入鼠标事件，问题很多：

- 受 DPI、窗口位置、时序影响，同样的脚本换台机器就红；
- 会**抢用户的鼠标和焦点** —— 跑一次探针，用户正在打的字就飞了；
- 用户自己的实例（管理员权限、脚本杀不掉）会**同时响应**注入的全局按键。

现在统一走 **Chrome DevTools Protocol**：给 WebView2 加
`--remote-debugging-port=<随机空闲口>`，用 WebSocket 连进去，直接
`Runtime.evaluate` 执行页面脚本、用 `element.click()` 驱动真实控件。
不受 DPI 影响、不碰用户鼠标、能看到真实 DOM。

## 隔离：不打扰正在运行的实例

所有探针都设这两个环境变量：

| 变量 | 作用 |
|---|---|
| `QS_INSTANCE_TAG` | 单实例互斥体名字里多一段 tag，于是能**另起一份** |
| `WEBVIEW2_USER_DATA_FOLDER` | 用临时目录，不污染真实配置 |
| `QS_T_WV_ARGS` | **整体替换** WebView2 参数（必须带全，漏了 `--disable-gpu-sandbox` 会导致 GPU 进程崩） |

探针自己创建临时 `APPDATA`，跑完 `taskkill /PID <pid> /T /F` 收干净。

## 主要脚本

| 脚本 | 验什么 | 项数 |
|---|---|---|
| `run-settings-selfcheck.js` | 设置页内建自检（真控件、真 IPC） | 33 |
| `r73-lib-probe.js` | 引擎库四级目录 + 首字母索引 | 24 |
| `r72-bar-img-probe.js` | 横条识图哨兵 + 拖拽换位 | 15 |
| `r72-ocr-models-probe.js` | OCR 模型清单（含"只留视觉模型"） | 24 |
| `r71-verify.js` | 识图引擎设置 + 帮助节 | 15 |
| `r78-probe.js` | 多框并排 / 页面瘦身 / 识图旧逻辑 | 15 |
| `r77-probe.js` | 识图提速 / AI 配置 / 图标描边 | 13 |
| `r76-features-probe.js` | AI 延迟 / 优先级 / 别名 / 视觉过滤 | 17 |
| `r75-settings-reap.js` | 设置窗空闲销毁 + 内存回收 | 7 |
| `r75-deployed-smoke.js` | **桌面 exe** 冒烟（最贴近用户） | 5 |

## 量尺类（不判 PASS/FAIL，出数字）

| 脚本 | 量什么 |
|---|---|
| `r75-mem-states.js` | 各状态下的进程树内存占用 |
| `r75-mem-ab.js` | 两个 exe 的内存 A/B |
| `r75-lib-perf.js` | 777 行渲染 / 滚动耗时 |
| `r77-img-speed.js` | 松手 → 截图完成的耗时 A/B |

## 输出

- 探针日志落在 `tools/probe-out/`，截图证据在 `docs/evidence/`。
- **这两个目录不入版本控制**（`.gitignore` 已排除）：它们体积 38MB，且重跑探针
  就能再生成。需要追溯历史实测结果时，去
  `D:\Local AI\git\QuickSearch-evidence-archive`（r1 ~ r78 的归档）。
- 探针每次运行都会**重建**这两个目录，所以本地随时可以清空。

## 运行前提

- 已 `cargo build --release`（探针跑 `target/release/QuickSearch.exe`）。
- Node 18+（用到 `fetch`、`WebSocket` 全局）。
- PowerShell 5.1 存在（部分脚本用它做进程树统计）。

## 踩过的坑（重要）

1. **PowerShell 5.1 读无 BOM 的 UTF-8 脚本会按 ANSI 解码** —— 中文注释被解成乱码，
   进而破坏字符串引号配对，报出完全不相干的语法错。本目录的 `.ps1` 都带 **UTF-8 BOM**。
2. **`QS_T_WV_ARGS` 是整体替换**：只写 `--remote-debugging-port` 会丢掉
   `--disable-gpu-sandbox`，症状是"第一条 evaluate 有回音、之后全超时"。
3. **调试端口要随机取空闲口**，写死会连到上一轮残留实例的死页面。
4. **`engineMatches` 期望调用方先 `toLowerCase`** —— 探针传原始大小写会得到假 FAIL。
5. 横条页不能用 `url.indexOf('bar')` 找：`tauri.localhost/` 是
   `tauri.localhost/settings.html` 的前缀，会连到设置页上去。要按整页路径匹配。
