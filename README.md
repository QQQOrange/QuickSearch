# Quick Search 桌面版

> 在任意软件里选中文字或按下快捷键，屏幕上方就会弹出一条搜索横条：点一颗图标就把
> 选中的词交给那个网站 / 软件 / 快捷键去处理。另有截图识图、屏幕文字识别、收藏夹、
> 图标编辑器、加密备份与 WebDAV 同步。

Windows 10/11 桌面应用，**Tauri 2 + Rust + WebView2**，无运行时装依赖，单个 exe 即可运行。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| **划词横条** | 选中文字自动弹出（或 Ctrl+双击 / Ctrl+C 触发），点图标即搜索 |
| **多引擎** | 内置 **777 个**引擎（27 个大类），支持自定义网页引擎 / 软件直达 / 快捷键引擎 |
| **经典别名** | 85% 的引擎带别名，搜「B站」能找到哔哩哔哩、「度娘」找到百度 |
| **截图识图** | 框选屏幕区域 → 12 家识图引擎（百度 / Yandex / SauceNAO / trace.moe / 6 家 AI） |
| **文字识别 OCR** | 框选读字，本地离线 + 十余家在线引擎，支持**多引擎同时识别**（并排多框展示） |
| **收藏夹** | 两级目录，文字 / 图片 / 富文本，可拖拽排序 |
| **图标编辑器** | 一键消除背景 + **手动描边保护** + 光学尺寸归一 |
| **备份** | 本地加密备份（AES-256-GCM + Argon2id）、WebDAV 云端同步 |
| **主题** | 亮 / 暗 / 跟随系统，横条支持液态玻璃（WebGL2 真折射） |

---

## 仓库结构

```
src/              Rust 源码（Tauri 后端）
  main.rs           主程序：窗口 / 命令 / 横条布局 / 识图 / OCR 调度（约 1.4 万行）
  config.rs         配置结构与持久化（原子写 + 备份）
  win.rs            Win32 封装：窗口、UIA、键盘钩子、截图
  ocr.rs            百度 OCR
  ocr_engines.rs    OCR 引擎注册表（十余家）
  imgsearch.rs      识图引擎注册表
  engines.rs        搜索引擎解析
  clip.rs           剪贴板（含 DIB 图像）
  glass.rs          横条背景抓屏
  hook.rs           全局键盘 / 鼠标钩子
  paths.rs          路径与环境变量解析
  iconedit.rs       图标编辑器（消除背景 + 描边保护）
  cleanup.rs        临时文件清理
  crypto.rs         备份加密
  export.rs         配置导入导出
  webdav.rs         WebDAV 客户端
ui/               前端（原生 JS + CSS，无框架）
  index.html       横条页面
  bar.js/.css      横条交互（约 190KB / 63KB）
  settings.html    设置页（10 个分页）
  settings.js/.css 设置页逻辑与样式
  ocr.html         OCR 结果窗
  iconedit.html    图标编辑器
  region.html      框选遮罩
  shared.js        横条与设置页共用逻辑
  glass.js         液态玻璃渲染
  data/engines.json  777 个引擎的注册表（含别名）
  data/icons/        图标资源
docs/
  PRD.md           产品需求文档（目标 / 页面结构 / 功能边界 / 验收标准）
  PUSH-GUIDE.md    GitHub 推送指引
  probes/          探针说明（为什么用 CDP、踩过的坑）
  evidence/        历史实测截图 —— **不入库**，见下方"关于证据"
tools/             验证脚本（探针）
  probe-out/       探针输出的实测日志 —— **不入库**
验收报告.md         逐轮开发与验收记录（r1 ~ r78）
```

### 关于证据

`docs/evidence/`（22MB 截图）与 `tools/probe-out/`（16MB 探针日志）**不纳入版本
控制** —— 它们是历史实测结果，重跑探针即可再生成。需要追溯时去
`D:\Local AI\git\QuickSearch-evidence-archive`（已归档 r1 ~ r78 全部证据）。

---

## 构建

### 前置

- Rust 1.70+（本项目用 `C:\Users\<you>\.cargo\bin` 下的 cargo）
- WebView2 Runtime（Win10/11 通常已内置）
- Node 仅用于跑 `tools/` 下的验证探针，构建本身不需要

### 命令

```powershell
cargo test            # 250 个单元测试
cargo clippy          # 0 warning
cargo build --release # 产物：target\release\QuickSearch.exe
```

发布配置见 `Cargo.toml` 的 `[profile.release]`：`opt-level="s"` + `lto="fat"` +
`codegen-units=1` + `strip=true`。**没有用 `panic="abort"`** —— 单线程 panic 不该把
整个程序带走，配了自定义 panic hook 写日志。

---

## 验证

项目采用「单元测试 + 真机探针」双层验证。探针通过 CDP（Chrome DevTools Protocol）
驱动真实 WebView，比外部注入鼠标可靠得多。

```powershell
# 设置页内建自检（33 项）
node tools/run-settings-selfcheck.js

# 分功能探针
node tools/r73-lib-probe.js          # 引擎库下钻 + 首字母索引（24 项）
node tools/r72-bar-img-probe.js      # 横条识图哨兵（15 项）
node tools/r72-ocr-models-probe.js   # OCR 模型清单（24 项）
node tools/r71-verify.js             # 识图引擎设置（15 项）
node tools/r78-probe.js              # 多框并排 / 页面瘦身（15 项）

# 用桌面 exe 做冒烟（不影响正在运行的实例）
node tools/r75-deployed-smoke.js
```

探针都支持 `QS_INSTANCE_TAG` 环境变量另起隔离实例，**不会干扰用户正在运行的
QuickSearch**（它通常是管理员权限、脚本杀不掉）。

---

## 设计取舍（踩过的坑）

几处不那么直观、但**故意如此**的设计，改之前请先读代码注释：

1. **`ureq` 用同步阻塞**，不用 tokio —— 丢进后台线程即可，省一整个运行时。
2. **命令必须脱开调用栈**：`ocr_start` / `open_settings` / `img_start` 都 `spawn`
   一个线程再建窗口，否则主线程建 WebView2 会死锁（症状：窗口建出来但不显示）。
3. **所有窗口必须用同一套 WebView2 参数**（`wv_args()`），否则环境冲突、
   `HRESULT 0x8007139F` 窗口建不起来。
4. **框选遮罩有四层兜底**：心跳、30 秒总闸、置顶重申、裸 HWND 强杀 ——
   它铺满全屏，留着就等于锁死鼠标。
5. **配置原子写**：临时文件 + rename，崩溃只会留一份 `.tmp`，正式文件永远完整。
6. **OCR「同时识别」默认并排多框**，不再只显示默认引擎那一家。

---

## 许可与致谢

本项目采用 [MIT License](LICENSE) —— 可自由使用、修改、分发与商用，只需保留版权声明。

引擎表（`ui/data/engines.json`）的 URL 与图标版权归各站点所有，此处仅作跳转索引使用。

图标来源：各站点 favicon / [Iconify](https://iconify.design/)。
液态玻璃折射的数学移植自开源项目 [liquidGL](https://github.com/naver/liquidGL) 的思路。
