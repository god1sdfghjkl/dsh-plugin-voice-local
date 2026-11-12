# Changelog

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