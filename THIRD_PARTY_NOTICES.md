# Third-party notices

`dsh-plugin-voice-local` 的**代码**以 MIT 发布（见 `LICENSE`）。本文件列出随包分发的
第三方代码/字体，以及**另行下载、不随包分发**的模型与运行时。完整许可文本以各项目仓库为准。

## 随包分发的代码与字体

### dsh-voice-mode — MIT

- Source: https://github.com/qishuilalala/dsh-voice-mode
- 使用部分：`lib/client.js` 中内嵌的 AudioWorklet（`VoiceCaptureProcessor`）与线性重采样
  `resampleLinear()`，改编为 `WORKLET_SRC` 常量。
- License: MIT。Copyright (c) dsh-voice-mode contributors.

### dsh-talk — MIT

- Source: https://github.com/PerryLink/dsh-talk
- 使用部分：VAD 纯函数 `rmsOf()` / `isSpeechFrame()` / `advanceSilence()` / `silenceTrips()`，
  用于自动断句与开口打断。
- License: MIT。Copyright (c) dsh-talk contributors.

### 运行时依赖（npm dependencies，由使用者安装）

| 包 | 许可 | 用途 |
|---|---|---|
| `onnxruntime-node` | MIT | VITS2-onnx 推理 |
| `sherpa-onnx` | Apache-2.0 | 流式 ASR / 定稿 ASR / OfflineTTS（WASM） |
| `@node-rs/jieba` | MIT | 中文分词（TTS 文本前端） |

### 内置字体 — SIL Open Font License 1.1

`lib/assets/fonts/` 内的字体随包分发，许可全文见 `lib/assets/licenses/`。

| 字体 | 文件 | 版权 |
|---|---|---|
| Instrument Serif | InstrumentSerif-Regular/Italic.ttf | Copyright 2022 The Instrument Serif Project Authors |
| Inter | Inter-400/500.ttf | Copyright 2020 The Inter Project Authors |
| Lora | Lora-400/Italic.ttf | The Lora Project Authors |

## 模型（不随包分发，由下载器或用户手动放置）

代码 MIT **不代表**模型权重许可相同。下列模型只会由插件按 `model.json` 的 `download`
清单从第三方地址下载，或由用户手动放入 `$DSH_HOME/voice-local/models/`。

| 模型 | 许可 | 说明 |
|---|---|---|
| MeloTTS 中文（sherpa-onnx VITS 转换） | MIT（代码与权重，MyShell.ai） | 可再分发；保留版权与许可全文。参考模型卡：https://huggingface.co/csukuangfj/vits-melo-tts-zh_en |
| sherpa-onnx 官方模型（zipformer / VITS / Kokoro 等） | Apache-2.0 | 见 https://github.com/k2-fsa/sherpa-onnx 与模型发布页 |
| SenseVoice（`sherpa-onnx` 转换权重） | 代码 MIT；权重 FunASR Model License 1.1 | 必须署名并保留模型名，详见 https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE |
| 示例音色 `tl196m`（VITS2-onnx，作者自训） | 见模型仓库的 LICENSE | 由作者单独发布，不随 npm 包分发 |
| 声纹模型 3D-Speaker CAM++（`campplus_zh.onnx`） | Apache-2.0 | 首次使用声纹锁时按需下载；来源 https://github.com/modelscope/3D-Speaker 与 sherpa-onnx 发布页 |
| VITS2 架构 | 论文公开；具体实现许可各异 | 本插件只调用 onnx 权重，不包含 VITS2 训练代码 |

如果你重新分发上述模型，请自行确保遵守对应许可（尤其是 SenseVoice 的 FunASR
Model License 与署名要求）。

## 仅作设计参考（未复制代码）

- dsh-live-voice — Apache-2.0，https://github.com/wads-dev/dsh-live-voice
  参考其 DSH design tokens 用法、波形/字幕/状态条形态；未复制其源代码。
- DeepSeek Harness 官方插件（`@deepseek-ai/dsh-experimental-voice-input-bundle` 等）—
  参考其模型下载/缓存与客户端插件形态；未复制其源代码。
- Folia — 仅作排版与配色审美的早期参考，最终实现未包含其代码或图片资源。