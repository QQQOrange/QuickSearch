# vendor/ort —— AI 抠图的推理运行时（ONNX Runtime）

## 这是什么

`onnxruntime.dll`（Windows x64，ONNX Runtime **1.22.0** 官方预编译版）。
`ort` crate 在运行时要加载它，缺了 AI 抠图不可用（本地算法照常工作）。

## 为什么要手动放

`ort` 的 `copy-dylibs` feature 期望目录结构是 `<ORT_LIB_LOCATION>/lib` +
`<ORT_LIB_LOCATION>/Release`，而 ONNX Runtime 官方包**只有 `lib/`** ——
于是它静默不拷，表现是运行时加载到系统里其它版本的 ortnxruntime、报
`The requested API version [22] is not available`。这个坑不报错、产物看着也正常，
很难查。所以我们自己在 `build.rs` 里显式拷（见 `copy_ort_runtime`）。

## 版本要求

**必须是 1.22.0 或更高**：`ort` 2.0.0-rc.10 要求 API version 22。
装 Python 的 `onnxruntime` 时系统里可能出现别的版本（实测 1.17.1），
但那是 Python 的，与这里无关；`build.rs` 会把这里的 dll 拷到产物目录，
运行时优先加载同目录的那份。

## 怎么更新

1. 从 <https://github.com/microsoft/onnxruntime/releases> 下
   `onnxruntime-win-x64-<版本>.zip`
2. 把 `lib/onnxruntime.dll` 与 `lib/onnxruntime.lib` 覆盖到这里
3. 确认 `ort` crate 要求的 API 版本（`ort/Cargo.toml` 或它的 CHANGELOG）

## 为什么不入库二进制

`.gitignore` 排除了 `vendor/ort/lib/*.dll`：11.8MB 的二进制不该进版本库
（每次改动都产生新 blob，历史迅速膨胀）。构建机上放一份即可；
发布时它随 exe 一起分发（`build.rs` 自动拷到产物目录）。
