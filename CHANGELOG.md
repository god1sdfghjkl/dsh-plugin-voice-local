# Changelog

## 0.8.4 — 2026-11-13

- 分段下载改为 **最多 3 路并发**（`partConcurrency=3`），国内慢链路下 11×16MiB 的示例模型明显更快；
  失败时等待所有分段结束再统一清理，避免半截文件与竞态。
- 下载进度仍按整文件累计 `received/total`，`part` / `part-done` 事件带分段序号。

## 0.8.3 — 2026-11-13

- **模型下载器支持分段 `parts`**：清单里一个文件可拆成多段，逐段下载/校验后拼接，再校验整文件
  sha256；失败清理所有临时文件。适合 >2GiB 模型、国内长连接易断的场景（GitHub Release 单文件 2GiB 上限）。
- 新增 `scripts/split-model.mjs`：把大文件切段并生成 `download[].parts` 清单。
- 示例模型 tl196m 改为 **11 × 16MiB 分段** 发布（`models-v1` Release），`examples/models/tl196m/`
  的 `model.json`、`checksums.txt`、README/发布说明同步更新。
- 下载器测试新增分段下载、拼接校验、分段损坏清理 3 组用例（34 项全过）。

## 0.8.2 — 2026-11-13

- **修复**：顶栏上移到窗口标题栏拖拽区后，主题 / 模型两个下拉点击被系统当成「拖动窗口」而打不开。
  覆盖层与所有交互控件补 `-webkit-app-region: no-drag`（整个通话层 no-drag），并抬高 head / 菜单 z-index。
- 预热缓存的小幅调整（不影响功能）。

## 0.8.1 — 2026-11-13

- 手机 / 窄屏响应式：安全区、窄屏顶栏（收主题文字 / 时长）、44px+ 触控、横屏矮窗收缩。
- TTS 改为可选通道（只配 ASR 也可启动），引擎不再因缺 TTS 整体报错。
- 测试去硬编码路径：示例模型可用 `VOICE_*` 环境变量指定，缺模型时模型相关用例跳过。
- 开源工程化：README / README.en、文档补全、模型清单脚本、CI 与模板。
- 版本号与 package-lock 同步。

## 0.8.0 — 2026-11-13

### 界面

- 顶栏整体上移，模型 / 背景主题 / 时长 / 最小化与 DSH 窗口控件排到同一行。
- 新增 **背景主题选择器**（模型按钮左侧）：暗色 4 套（夜色苔绿、深夜靛蓝、暗夜梅紫、暖夜琥珀）
  + 亮色 3 套（晨光纸白、暖沙米色、静谧天蓝），选择立即生效、写入 `localStorage` 记忆；
  主题下拉、字幕、呼吸球、底部控件一起换色。
- 自绘模型下拉（替换原生 `<select>`），分 TTS / 流式 ASR / 定稿 ASR 三组，支持缺模型直接下载。
- 手机 / 窄屏响应式：`env(safe-area-inset-*)`、窄屏顶栏、44px+ 触控、横屏矮窗收缩。
- 顶部字幕移除模型名，只保留「DSH · 本地流式」。

### 引擎 / 模型

- TTS 改为可选通道：只配 ASR 时仍可作为语音输入启动，不再因为缺 TTS 整体报错。
- 模型注册表 + 模型下载器（`.part` 原子重命名、SHA256 校验、SSE 进度）稳定。

### 测试 / 工程

- `client-smoke` 增加主题切换、默认主题、`localStorage` 记忆用例。
- `asr-smoke` 改用 ASR 注册表构建 profile，并允许 TTS 缺失；模型路径支持环境变量。
- 开源工程化：README / README.en、LICENSE、THIRD_PARTY_NOTICES、CHANGELOG、CONTRIBUTING、
  SECURITY、GitHub Actions、issue/PR 模板、模型清单脚本。

## 0.7.0

- 自绘模型下拉（暗色菜单，支持分组、状态标签、下载入口）。
- 模型下载器：界面内下载、进度、断点与 SHA256 校验。
- 模型注册表支持 `download` 清单与多模型热切换。

## 0.6.0

- ASR 模型注册表：流式（transducer）与定稿（SenseVoice / Whisper / Paraformer 等）分角色扫描、
  热切换，旧 `asrStreamDir` / `sensevoiceDir` 兼容。
- `/models` 返回 ASR 角色与可用性；`/models/use` 支持 ASR 切换。

## 0.5.0

- TTS 模型注册表：`vits2-onnx` 与 `sherpa-offline-tts`（vits / melo / piper / matcha / kokoro /
  kitten）多引擎；目录即模型，`model.json` 可省。
- 模型热度切换、`/models` 与 `/models/use` 路由。

## 0.4.0 及更早

- 全屏通话覆盖层（呼吸球 + 实时字幕 + 静音 / 打断 / 挂断 / 最小化）。
- 输入框语音条（电平 + 字幕 + 结束 / 关闭），颜色跟随 DSH 主题变量。
- AudioWorklet 16k 重采样 + VAD 自动断句；TTS PCM16 经 SSE 流式播放；开口打断。
- 宿主 tap `llm/stream` 流式切句朗读；字体随包、静态资源路由。