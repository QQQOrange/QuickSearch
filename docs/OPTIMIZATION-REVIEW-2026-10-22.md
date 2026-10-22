# Quick Search v1.4.2 全盘审视与优化报告

> 审视日期：2026-10-22 · 代码基线：`bfdc34a`（v1.4.2）· 范围：`src/**`（39,655 行 Rust）
> 与 `ui/**`（24,419 行 JS/CSS/HTML + 3.94 MB 资产），共 127 个 Tauri 命令

---

## 0. 结论摘要

| 维度 | 现状 | 判断 |
|---|---|---|
| 功能完整度 | 127 命令 / 784 个内置引擎与横条入口 / 14 家在线 OCR + 本地 OCR / 抠图 / 收藏 / 加密备份 / WebDAV / 自动更新 | 完整，无半成品入口 |
| 健壮性 | 305 个单测全绿、`clippy` 0 warning、生产代码 `unwrap/expect` 仅 4 处、无 TODO/FIXME | 优秀 |
| 性能 | 面板渲染分片、`pushLayout` 去重、图标测量缓存、日志异步批量落盘 | 大方向对，**有一处百毫秒级浪费**（已修） |
| 体积 | exe 12.66 MB = Rust+依赖 ~8.7 MB + 内嵌前端 3.94 MB | **图标资产 2.63 MB 未优化**，是最容易拿的一块 |
| 结构 | `main.rs` 16,945 行 / 127 命令挤在一个文件；`settings.js` 8,305 行 | 可维护性是最大技术债 |

**本轮已落地 1 项**（P0，见 §2）：配置保存不再每次都跑 Argon2id —— 单次实测 120~150 ms，
现在同一密码只付一次。**其余按优先级给方案与路线图**，没有动任何有回归风险的地方。

---

## 1. 审视方法与口径

不是读一遍就下结论，每一条都尽量量化：

- **体量**：`wc -l` 统计行数；按扩展名汇总 `ui/` 字节数；解析 149 个 `.ico` 的头部拿到
  内嵌尺寸分布（`16px×49 / 32px×52 / 48px×21 / 64px×21 / 256px×3`）。
- **重复/死代码**：脚本比对 `bar.css` 与 `settings.css` 的规则体；用"标识符出现次数 = 1"
  启发式扫描 JS 顶层函数；核对 415 个图标与 `engines.json` 里 402 个 `iconFile` 引用。
- **健壮性**：统计 `catch(() => {})`、`#[tauri::command]` 与 `async fn` 比例、
  生产代码（`mod tests` 之前）的 `unwrap/expect`。
- **性能**：用项目自己的 `crypto` 逻辑跑真实配置，量 Argon2id 的实际代价
  （3 次 160~190 ms，含进程启动；KDF 本体约 120~150 ms）。
- **回归证据**：`cargo test --release`、`cargo clippy --release`、`tools/test-ui.js`（jsdom 跑真实页面）。

---

## 2. P0 —— 已修（本轮落地）

### 2.1 每次保存配置都重跑 Argon2id（120~150 ms）

| 项 | 内容 |
|---|---|
| 位置 | `src/crypto.rs::encrypt` → `derive_key`；调用方 `src/config.rs::save_to`（`main.rs` 里 35 处调用点） |
| 问题 | 每次写盘都用**新的随机盐**派生密钥。盐的作用只是挡彩虹表；同一台机器、同一个密码反复写同一个文件，换盐没有任何安全收益，却要每次付 Argon2id（19 MiB / t=2）。实测单次 **120~150 ms**，而且这段是在**持着配置锁**的情况下花的 |
| 影响 | 设置页连点几个开关就发涩；同一时刻其它要读配置的逻辑（横条渲染、快捷键）一起等锁 |
| 做法 | ① `encrypt` 走 `cached_key()`：同一密码的**盐与密钥**在进程内复用，只换 nonce（AES-GCM 的安全底线是 nonce 不重复）；② `decrypt` 走 `decrypt_key_cached()`：按 `密码+盐+KDF参数` 缓存密钥，启动时同一份文件被解多次也只付一次 |
| 效果 | 首次之后每次保存从 **120~150 ms 降到微秒级**；换密码立刻失效（比对密码原文，绝不拿旧密钥加密新内容） |
| 验证 | 新增/改写两条单测：`salt_is_reused_but_nonce_is_fresh`、`changing_password_invalidates_the_cached_key`；`cargo test --release` **305 全过** |

> 安全说明：盐复用只影响"同一密码跨文件"的派生差异，本机同密码反复写同一文件本就没有收益；
> 密码学参数（Argon2id 19 MiB / t=2、AES-256-GCM、每条新 nonce、版本号进 AAD）**一个都没放松**。

---

## 3. P1 —— 建议尽快做（收益明确、风险可控）

### 3.1 122/127 个命令是**同步**的，其中一多半在持锁状态下写盘

| 项 | 内容 |
|---|---|
| 位置 | `src/main.rs`（`#[tauri::command]` × 127，其中 `async fn` 只有 5 个）；例：`set_setting`(4100)、`set_settings`(4128)、`toggle_bar_engine`、`add_custom_engine` |
| 问题 | Tauri 的同步命令跑在**主线程**上。这些命令里既有 `config::save`（含加密 + 落盘 + 备份轮转），又有 `broadcast()`（向前端广播全量配置）。一次开关 = 主线程上几十毫秒的 CPU + IO |
| 影响 | 设置页快速连续操作时窗口"发涩"；横条显隐、拖动面板等交互与保存争主线程 |
| 建议 | ① 给"只改配置、不碰窗口"的命令加 `#[tauri::command(async)]`；② 把 `save` 改成**去抖合并**（200 ms 内的多次修改只写一次，退出/切页时强制 flush）；③ 写盘 + 广播挪进 `tauri::async_runtime::spawn_blocking`，主线程只做内存改动 |
| 预期 | 设置页操作延迟 ~50 ms → ~2 ms；磁盘写入次数降到 1/5 |

### 3.2 启动关键路径上串行做"解密配置"

| 项 | 内容 |
|---|---|
| 位置 | `src/main.rs::boot()`（`CATALOG = await fetch(...)` → `CONF = await invoke('get_config')` → `renderBar`）；`config::load_from` 里的解密 + `sanitize` |
| 问题 | 首帧要等配置解密完成。密码信封必须付一次 Argon2id（本轮已从"多次"压到"一次"，但首次仍是 120~150 ms）。`qs://show` 若先到，`renderBar` 会因 `CONF == null` 直接返回，横条先空一帧 |
| 建议 | 中期方案：**本地静态加密改用 DPAPI 信封（`qsEnc:2`，无需 KDF，~1 ms）**，密码信封只用于"要跨机的备份文件"。这本来就是两件事：本地文件的威胁模型是"别人拿到这块盘"，DPAPI 足够；密码信封的价值在跨机恢复。改完启动可省 100 ms 量级 |
| 风险 | 换机时 `config.json` 需要重新输密码（备份文件不受影响），需在设置页写一句说明 |

### 3.3 图标资产 2.63 MB 未优化（exe 体积的 21%）

| 项 | 内容 |
|---|---|
| 位置 | `ui/data/icons/`（415 个文件）；`engines.json` 里 402 处 `iconFile` |
| 数据 | `.ico` 149 个 = 1,577 KB；`.png` 79 个 = 795 KB；`.svg` 187 个 = 260 KB。**3 个文件占 500 KB**：`189_邮箱（首页）.ico` 264 KB（256px）、`原神（首页）.ico` 227 KB（256px）、`崩坏：星穹铁道（首页）.ico` 29 KB（120px）。界面里这些图标最大只显示 28 CSS px（200% 缩放 = 56 设备像素） |
| 影响 | exe 白白多背 1.6 MB；大图标解码也更慢（面板 777 格） |
| 建议 | 统一**长边 96 px**、转 PNG 或 WebP(q92)：`.ico` 多尺寸容器在这里没有意义（浏览器只用一层）。批量脚本：读最大层 → 缩放到 96 → 存 `.webp` → 改 `engines.json` 的 `iconFile` 扩展名 → 全量 diff 校验"每个引用都能解析到文件" |
| 预期 | 2.63 MB → **0.6~0.8 MB**，exe **-1.6~1.8 MB（约 -13%）** |
| 风险 | 需目视验收（尤其 3 个 256px 的缩到 96）；图标编辑器的"消除背景"输入分辨率会降到 96px（对 20px 显示足够） |

### 3.4 56 处 `catch(() => {})` 静默吞掉失败

| 项 | 内容 |
|---|---|
| 位置 | `ui/bar.js` 29 处、`ui/settings.js` 27 处（`ui/shared.js`、`ui/glass.js` 为 0） |
| 问题 | IPC 失败（命令改名、参数不对、后端 panic）在界面上**完全无痕**，只剩"点了没反应"。本次两个 bug（搜不到引擎、快捷键引擎不显示）都属于"静默失败"型，排查成本极高 |
| 建议 | 统一 `invokeSafe(name, args, {silent})`：默认 `catch` 里至少 `invoke('log_msg', ...)` 记一条；关键动作（保存、恢复、加引擎）额外弹 toast。把 56 处收敛成一个入口，顺带统一超时与重试策略 |
| 预期 | 线上问题从"猜"变成"看日志"；代码反而更短 |

### 3.5 `main.rs` 16,945 行 / 127 命令单文件

| 项 | 内容 |
|---|---|
| 位置 | `src/main.rs`（占 Rust 代码 43%）；对比：`config.rs` 4,558、`win.rs` 3,588、`ocr_engines.rs` 1,948 |
| 问题 | 一个文件里同时有：窗口/横条、托盘、快捷键、OCR、抠图、收藏、引擎、备份/WebDAV、更新、设置同步。改任何一处都要全文搜索；编译单元无法并行；review 粒度失控 |
| 建议 | 按域拆 `bar_window.rs` / `tray.rs` / `hotkey.rs` / `engine_cmd.rs` / `backup_cmd.rs` / `ocr_cmd.rs` / `fav_cmd.rs` / `update_cmd.rs`。**纯移动 + `pub(crate)` + 重导出**，一行逻辑都不改；每搬一个模块跑一次全测试 |
| 预期 | 增量编译更快（改动只重编一个模块 + 链接）；新人可读性大幅提升 |

### 3.6 「取锁 → 改 → save → broadcast」样板重复三十多处

| 项 | 内容 |
|---|---|
| 位置 | `src/main.rs`（`set_setting`、`set_settings`、`toggle_bar_engine`、`add/update/remove_custom_engine`、`add/remove_app`、`set_theme`…） |
| 问题 | 35 处 `config::save` 调用点，每次都要手写 `match st().cfg.lock()` + 错误分支 + `config::save` + `broadcast()`；漏一处 `broadcast` 就是"设置改了界面不刷新" |
| 建议 | 抽 `with_cfg_mut(|cfg| -> bool /* 是否改动 */)`：内部统一取锁、`save`、`broadcast`；`set_settings` 那种批量改的还能顺手合并成一次写盘 |
| 预期 | 少 200~300 行；"忘了广播"这类 bug 从机制上消失 |

---

## 4. P2 —— UI/布局与细节（影响观感与手感）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 4.1 | `ui/bar.css` 面板吸附头 | 选了「大类 + 中类 + 小类」后头部最多三行（≈30+30+60 px），`panel-body` 只有 344 px，正文被挤到 ~200 px | 小类行限高 2 行（横向滚动或「更多…」折叠）；或把两级胶囊并进一条「筛选」栏，点开才展开 |
| 4.2 | `ui/bar.js::applyEngineFilter` 的 `.eng-noresult` | 占位块挂在 `panelBody` **末尾**，搜索无结果时要滚到底才看见 | 改成面板中部的居中覆盖层（`position: sticky` 或绝对定位），保证任何滚动位置都看得见 |
| 4.3 | `#engFilter:focus` | 宽度 132 → 176 px 的过渡会让同一行的 `#q` 抖动 | 固定 168 px，或改成 `flex: 0 0 auto` + `min-width` 过渡不触发重排 |
| 4.4 | `.grid { minmax(112px, 1fr) }` + 面板 552 px | 每行固定 4 列，两侧留白偏多 | 试 `minmax(104px, 1fr)`（5 列）或面板 560 px，信息密度 +25%；需同步调字号/图标，属 A/B 项 |
| 4.5 | `ui/settings.js` 8,305 行 + `settings.css` 3,514 行 | 一个页面装载全部逻辑（引擎库/OCR/抠图/备份/收藏/关于），首屏解析成本高 | 按分页拆 `<script type="module">` 惰性加载；共享工具留在 `shared.js` |
| 4.6 | `ui/bar.css` 与 `ui/settings.css` 各有一套颜色变量（`--qs-*` vs `--fg/--bg`） | 主题改动要改两处，靠 fallback 兜着 | 抽 `theme.css` 单一真相（`--fg: var(--qs-fg)` 之类的别名表） |
| 4.7 | 本轮新增的 `.ico.engine.qs-dead::after` | 颜色写死 `#E5484D` | 改用 `var(--danger)`，跟随主题 |
| 4.8 | `ui/bar.js::barList()` | 每次右键菜单都会重算整张横条成员表（含 `CONF.customEngines` 全扫） | 结果按 `barList + customEngines 指纹`缓存一次；右键是低频操作，属"顺手清债" |

---

## 5. P3 —— 体积/资源（在 P1 之后做）

| 项 | 现状 | 建议 | 预期 |
|---|---|---|---|
| 图标重编码 | 2.63 MB | 见 §3.3 | **-1.6 MB** |
| `engines.json` | 224 KB / 784 条 | 默认值（`inset:1`、`kind:"search"` 等）可省略，解析端已有兜底；能省 30~50 KB 且不影响可读性（保留 prettier 格式） | -40 KB |
| 13 个孤儿图标 | 32.7 KB（`Google.svg`、`淘宝.svg`… 无人引用） | 删掉或补回 `iconFile` 引用（先确认是否给 toolbar 当 fallback 用） | -33 KB |
| `opt-level` | `"s"` + `lto="fat"` + `strip` + `codegen-units=1` | 可试 `"z"`（实测同类项目 -2~4%），但要复测 UI 渲染性能 | -0.3~0.5 MB |
| 未用依赖 | `image` 开了 6 个编解码特性、`rfd`/`open` 各一个用途 | 逐个确认是否都还在用（`rfd` 只服务文件对话框，可换 Win32 原生 90 KB 级实现） | 视情况 -0.2~1 MB |

---

## 6. 已确认**不需**改的地方（避免过度优化）

- **面板渲染**：777 格分片构建 + `IntersectionObserver` 懒填 + 图标光学系数缓存（`qsIconScale` 的
  `done` Map）已经到位；实测搜索每键 O(格子数)（~800 次 `indexOf`）可忽略。
- **`pushLayout`**：一帧合并 + 载荷去重 + 重弹作废，反馈环已断（r51/r92 的坑都补过）。
- **日志**：异步队列 + 300 ms 批量 + 2 MB 截断，不会拖慢主路径。
- **加密参数**：Argon2id 19 MiB / t=2 + AES-GCM + AAD，符合 OWASP 建议，不要为省 100 ms 去降参数（§3.2 的办法是换信封，不是降参数）。
- **`panic = "abort"`**：`Cargo.toml` 里明确不启用（子线程 panic 会带走整个程序），这个取舍是对的 —— 别再为几十 KB 去开它。
- **CSS 重复**：脚本比对后只有 `* { box-sizing }` 一条是真重复，之前担心的 `.qs-pick` 双份其实只存在于 `bar.css`（`settings.css` 用的是另一套前缀）。

---

## 7. 路线图（按"收益/风险"排序）

```
阶段 0（已完成，本轮）
  └─ 密钥/盐缓存：保存 120~150ms → 微秒；启动多次解密 → 一次
       验证：305 单测全绿、clippy 0 warning

阶段 1（半天，低风险，用户可感知）
  ├─ 3.1 命令 async 化 + save 去抖合并 + spawn_blocking
  └─ 3.4 invokeSafe 统一错误可见性（先做 bar.js，再做 settings.js）
       预期：设置页操作延迟 50ms → 2ms；线上问题可诊断

阶段 2（1 天，低风险）
  ├─ 3.6 with_cfg_mut 抽公共（顺带把 15 处 save+broadcast 收敛）
  └─ 4.1 / 4.2 / 4.3 / 4.7 四处 UI 打磨（面板头部限高、无结果居中、搜索框不抖、死图标走变量）
       预期：面板可用面积 +30%；UI 手感统一

阶段 3（1~2 天，需目视验收）
  └─ 3.3 图标重编码（96px / WebP）+ engines.json 引用更新
       预期：exe -1.6MB（12.66 → ~11.0MB），面板首屏解码更快

阶段 4（3~5 天，纯重构，零行为变化）
  ├─ 3.5 main.rs 拆模块（每搬一个跑一次全测试）
  └─ 4.5 settings 页按分页拆模块
       预期：增量编译时间下降、review 粒度变细

阶段 5（选做）
  └─ 3.2 本地配置文件改用 DPAPI 信封（启动再省 ~100ms）
```

---

## 8. 附：体积预算与性能数据

**exe 12.66 MB 构成（推定）**

| 部分 | 大小 | 可压缩 |
|---|---|---|
| Rust 代码 + 依赖（已 LTO + strip） | ≈ 8.7 MB | 有限（换实现才有量级变化） |
| `ui/data/icons` | 2.63 MB | **→ 0.6~0.8 MB** |
| `ui/*.js` | 725 KB | 拆模块后按需加载（首屏 -60%） |
| `ui/*.html` | 268 KB | — |
| `ui/data/icons/*.svg` | 260 KB | 已计入上面 |
| `ui/data/engines.json` | 224 KB | -40 KB（去默认值） |
| `ui/*.css` | 186 KB | — |

**性能数据（本机实测）**

| 项 | 数值 | 来源 |
|---|---|---|
| Argon2id 19 MiB / t=2 单次 | **120~150 ms** | `dec` 工具跑真实配置（含进程启动 160~190ms） |
| 保存一次配置（修复前） | ≈ 125~155 ms / 次 | 上述 + 序列化 + 落盘 |
| 保存一次配置（修复后，非首次） | **< 1 ms** | 密钥缓存命中，只剩 AES |
| 单测 | 305 / 305 | `cargo test --release` |
| 无头 UI 测试 | 151 / 154（3 条为图标编辑器既有失败） | `tools/test-ui.js` |

---

## 9. 本轮改动的代码位置

| 文件 | 改动 |
|---|---|
| `src/crypto.rs` | 新增 `KEY_CACHE` / `cached_key()` / `decrypt_key_cached()`；`encrypt` 复用盐、`decrypt` 复用密钥；测试改为 `salt_is_reused_but_nonce_is_fresh` + 新增 `changing_password_invalidates_the_cached_key` |

> 本轮刻意**没有**动：命令 async 化、模块拆分、图标重编码、UI 布局调整 ——
> 这四项分别涉及线程模型、跨文件搬迁、228 个资产文件与目视验收，
> 都需要单独一轮 + 完整回归，硬塞进同一版会破坏"功能不受影响"这条底线。
