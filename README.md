# dsh-plugin-voice-local

**DeepSeek Harness（DSH）本地流式语音插件**：TTS + ASR 全在宿主进程内跑，不 spawn 独立进程、不另起端口、不走云语音 API。点一下输入框的 🎙，就能在全屏通话界面里跟 DSH 说话——它边流边读，你随时开口打断。

[![release](https://img.shields.io/github/v/release/god1sdfghjkl/dsh-plugin-voice-local?label=release)](https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.x-4b6f44)](https://github.com/deepseek-ai)

![桌面端：夜色苔绿 + 背景主题下拉](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@2a70007/docs/images/desktop-dark.png)

| 亮色主题（晨光纸白） | 手机窄屏（响应式） |
|---|---|
| ![亮色主题](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@2a70007/docs/images/desktop-light.png) | ![手机布局](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@2a70007/docs/images/mobile.png) |

## 功能

- **全屏通话界面**：说话 → 停顿约 0.9s 自动发送 → 回复流式字幕 + 语音朗读 → 开口可打断。
- **通话口吻**：通话期间自动注入“像正常人说话”的固定规则（口语、短句、不列清单、不输出 Markdown/括号动作/AI 套话），挂断后恢复默认书面风格；配置 `callPersona: false` 可关闭。
- **BreezeBlue 流式 TTS（可选）**：设置 `ttsProvider: "breeze"`，填 API Key / `voice_id`，接 `/v1/text-to-speech/{voice_id}/stream` 的 24 kHz PCM 流，边生成边播；覆盖层「语音 API 设置」可保存/试听。没有 Key 自动回退本地 TTS。
- **自动情感（可选）**：开启后按每句话的文字自动判断开心/难过/生气/惊讶/温柔/俏皮/认真/紧张/自然，分别套用 Breeze 的 `instructions`、`guidance_scale` 和 `speed`；默认用零额外请求的本地规则，也可打开「智能情感（LLM）」让主模型按句生成更贴语义的表演说明（预取下一句、超时/坏输出回退规则）。
- **DSH 官方 ASR（可选）**：`asrProvider: "dsh"` 走官方 `speechToText`（本地 SenseVoice 或云端 provider）；官方只有整句定稿、没有流式 partial，默认仍用本插件的边说边出字。
- **7 套背景主题**：暗色 4 套（夜色苔绿 / 深夜靛蓝 / 暗夜梅紫 / 暖夜琥珀）+ 亮色 3 套（晨光纸白 / 暖沙米色 / 静谧天蓝）。选择立即生效并记忆；下拉框、字幕、球体配色一起切换。
- **可换模型**：TTS / ASR 都是模型注册表——往目录里丢模型即可出现，支持热切换，不重启宿主。
- **模型下载器**：`model.json` 声明下载清单，界面内显示进度；断点 `.part` + SHA256 校验；失败可重试。
- **本地优先**：模型、音频、文本都不出本机；路由仅回环地址可用，并做 Origin 校验。
- **声纹锁（可选）**：注册自己的声音后，只回答你本人——别人的话照常转写显示，但不提交给会话。声纹 embedding 只存本地。
- **输入框小语音条**：不打开全屏时也能看电平、字幕、结束/关闭；颜色跟随 DSH 主题变量。
- **响应式**：桌面 / 窄窗 / 手机浏览器均可用；安全区、触控尺寸、横屏矮窗都有适配。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.0 <0.3.0-0`（已在桌面 0.2.2-rc.1 实测） |
| Node | `>=20`（宿主自带；桌面端无需另装） |
| 模型 | 至少一个 TTS（朗读）或流式 ASR（听写）；建议两者都配 |

## 快速开始

1. 安装插件（见下一节），刷新 DSH 页面，输入框右侧出现 🎙。
2. 模型：**首次启动会自动下载包内示例音色 `tl196m`**（约 161MB，分段 + SHA256 校验，可在配置里关掉）；
   也可以把模型目录放到 `$DSH_HOME/voice-local/models/` 下（结构见[模型](#模型)），或在模型下拉里选其它条目。
3. 点 🎙 → 说话。首次会请求麦克风权限。

> 只配 ASR 也能用：插件会退化为「语音输入」，不朗读回复；只配 TTS 则用于手动朗读测试。

## 安装

**方式 A：DSH 插件页（推荐）**  
设置 → 插件 → 从本地路径 / tarball 安装 `dsh-plugin-voice-local-<version>.tgz`，确认启用后刷新页面。

> npm 包发布准备中；在此之前可从 GitHub Releases 下载 tarball 安装：
> https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases

**方式 B：CLI**

```bash
dsh plugin --profile <profile> add ./dsh-plugin-voice-local-0.9.15.tgz
# 或从 npm
dsh plugin --profile <profile> add dsh-plugin-voice-local
```

> 客户端 bundle 有缓存：升级后需要**刷新宿主页面**（F5）才能加载新 UI；host 侧会自动热更新。

## 模型

模型**不随 npm 包分发**。插件启动后按顺序探测：

1. 配置里的显式路径（`ttsOnnx` / `asrStreamDir` / `sensevoiceDir`，旧配置兼容）
2. 环境变量 `VOICE_TTS_ONNX` / `VOICE_ASR_STREAM_DIR` / `VOICE_SENSEVOICE_DIR`
3. `dataRoot` 标准目录（默认 `$DSH_HOME/voice-local`，可用 `VOICE_DATA_ROOT` 覆盖）
4. standalone 项目目录（`onnx_out/tl196m_dyn.onnx`、`models/sherpa-onnx-streaming-*`、`xiaozhi/.../sensevoice`）

### 目录结构

```text
$DSH_HOME/voice-local/
└── models/
    ├── tts/
    │   └── melo-zh/                  # 每个子目录一个 TTS 模型
    │       ├── model.json            # 可选；省略则按文件特征探测
    │       ├── model.onnx
    │       ├── tokens.txt
    │       └── lexicon.txt
    └── asr/
        ├── streaming/<id>/           # 流式识别（实时字幕），必需
        │   ├── model.json
        │   ├── tokens.txt
        │   ├── encoder*.onnx
        │   ├── decoder*.onnx
        │   └── joiner*.onnx
        └── final/<id>/               # 整句定稿（更准、带标点），可选
            ├── model.json
            ├── model*.onnx
            └── tokens.txt
```

### `model.json`

```jsonc
{
  "id": "melo-zh",
  "name": "MeloTTS 中文",
  "engine": "sherpa-offline-tts",        // TTS：vits2-onnx | sherpa-offline-tts
  "type": "vits",                        // sherpa: vits | melo | piper | matcha | kokoro | kitten
  "sampleRate": 44100,
  "files": { "model": "model.onnx", "tokens": "tokens.txt", "lexicon": "lexicon.txt" },
  "options": { /* 引擎参数；sherpa 引擎支持 "sherpa": {...} 直接透传 */ },
  "download": [                          // 可选：界面内下载
    { "url": "https://example.com/model.onnx", "path": "model.onnx", "sha256": "…", "bytes": 123456 }
  ]
}
```

ASR 的 `model.json` 额外支持 `role`（`streaming` / `final`）、`type`（流式 `transducer`；定稿 `sense_voice` / `whisper` / `paraformer` / `transducer` / `nemo_ctc`）。字段全部可省，省略时按文件名自动探测。

### 模型许可

模型权重许可与代码 MIT **分开**。MeloTTS 为 MIT；SenseVoice 权重为 FunASR Model License 1.1；sherpa-onnx 官方模型多为 Apache-2.0；示例音色 tl196m 为 CC BY-NC-SA 4.0。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [docs/models.md](docs/models.md)。**重新分发前请自行核对许可与署名要求。**

仓库 [`examples/models/`](examples/models/) 内置了示例音色 tl196m 的下载清单（作者自训，CC BY-NC-SA 4.0）；首次启动会自动下载，权重发布在 [Releases · models-v1](https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases/tag/models-v1)。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `basePath` | `/voice-local` | 路由前缀 |
| `dataRoot` | `$DSH_HOME/voice-local` | 模型数据根目录 |
| `ttsModelsDir` | `$dataRoot/models/tts` | TTS 模型目录（每子目录一个模型） |
| `ttsModel` | `''` | 默认 TTS 模型 id；空 = 取第一个可用 |
| `ttsOnnx` / `ttsConfig` | `''` | 旧方式：直接指 `.onnx` / `config.json`（兼容保留） |
| `asrModelsDir` | `$dataRoot/models/asr` | ASR 模型目录（`streaming/` 与 `final/`） |
| `asrModel` / `asrFinalModel` | `''` | 默认流式 / 定稿 ASR 模型 id |
| `asrStreamDir` / `sensevoiceDir` | `''` | 旧方式：直接指模型目录（兼容保留） |
| `sr` | `44100` | 旧 `ttsOnnx` 方式的兜底采样率 |
| `ttsThreads` / `asrThreads` | `4` / `1` | 推理线程数 |
| `autoStart` | `true` | 插件加载即预热模型 |
| `autoDownloadModels` | `true` | 首次启动且没有可用 TTS 时，自动下载示例模型（`examples/models/`） |
| `exampleModelId` | `tl196m` | 自动下载的示例模型 id |
| `llmTap` | `true` | tap `llm/stream` 自动朗读 |
| `firstSegmentChars` / `maxSegmentChars` | `6` / `16` | 首句 / 后续句长度 |
| `speed` | `1` | 语速倍率 |
| `vadThreshold` | `0.012` | 16k RMS 语音门限（自动断句） |
| `autoEndSilenceMs` | `900` | 说完停顿多久自动提交 |
| `minSpeechMs` | `200` | 至少说多久才算一句 |
| `bargeIn` / `bargeInThreshold` | `true` / `0.025` | 朗读期间是否允许开口打断及门限 |
| `ttsProvider` | `local` | `local`（本机模型）或 `breeze`（BreezeBlue 流式 API） |
| `breezeApiKey` / `breezeVoiceId` | `''` | BreezeBlue 的 `brz_...` 与 `voc_...`；建议用界面 `/tts/api` 保存，不写仓库 |
| `breezeModel` / `breezeLanguage` / `breezeInstructions` | `''` / `zh` / `''` | BreezeBlue 模型 id、语言、表演说明 |
| `breezeGuidance` / `breezeSpeed` / `breezeVolume` | `1` / `1` / `1` | 情感贴合强度（1–10）、语速（0.5–2×）、音量（0.01–2×） |
| `breezeSpeakerBoost` | `false` | 是否启用 speaker boost（与高强度 instructions 同用时官方会忽略） |
| `breezeAutoEmotion` | `false` | 按每句文字自动选择情感；开启后忽略手动说明/预设 |
| `breezeSmartEmotion` | `false` | 自动情感开启时，再用 DSH 主模型按句生成表演说明；失败回退规则 |
| `asrProvider` | `local` | `local`（本插件流式）或 `dsh`（官方 speechToText，仅整句定稿） |
| `asrLanguage` | `zh` | 官方 ASR 的语言提示 |
| `voiceprintEnabled` | `false` | 声纹锁开关（也可在界面里切） |
| `voiceprintThreshold` | `0.7` | 声纹余弦阈值（0~1，越大越严） |
| `voiceprintModel` | `$dataRoot/models/voiceprint/campplus_zh.onnx` | 声纹模型路径 |
| `voiceprintDataFile` | `$dataRoot/voiceprint.json` | 声纹 embedding 存储文件 |

## 使用

- **通话界面**：点 🎙 打开；—（或 `Esc`）最小化但**通话不中断**；挂断 = 结束语音模式。
- **背景主题**：顶栏左侧「主题」按钮（模型按钮左边），暗色/亮色分组，选择后立即切换并记住。
- **换模型**：顶栏「模型」下拉，分组显示 TTS / 流式 ASR / 定稿 ASR；缺模型的条目会显示「可下载 xxx MB」，点一下开始下载。
- **静音 / 打断**：底部按钮；朗读时开口也能打断。
- **声纹设置**：顶栏「声纹」按钮（主题左边）打开设置面板：总开关、最多 5 组声纹档案（测试/重录/删除）、随机 3 句录入（每句手动停止，防预录音频回放）、环境噪音检测、识别阈值滑杆（0–100，默认 40）、唤醒联动、身份联动（语气/高权限）。开启「仅应答已录入人员」后，陌生声音不提交给会话。

### 声纹锁说明

![声纹设置面板](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@2a70007/docs/images/voiceprint-panel.png)

面板里的「语气」等下拉也是自绘主题组件，深色背景不会弹纯白菜单：

![主题下拉](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@2a70007/docs/images/voiceprint-dropdown.png)

- 模型：3D-Speaker **CAM++**（中文 16k，Apache-2.0，约 28MB），首次点下载才拉取，不随包分发。
  下载先走上游 sherpa-onnx Release，失败/校验不通过自动回退到[本项目镜像](https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases/tag/voiceprint-v1)，两者 SHA256 一致。
- 前端：Kaldi 兼容 80 维 fbank（纯 JS 实现，无需 Python），ORT 推理 192 维 embedding，余弦比对。
- 录入：每次随机抽 3 句提示语（服务端不校验朗读内容，靠随机挑战提高录音回放成本），每句手动点「停止并保存」，3 段各存一份模板、比对取最高相似度，单句最长 15 秒；环境噪音过大或三段差异过大时要求重录。
- 多档案：最多 5 组（主人/爸爸/奶奶…），每组有昵称、语气、高权限标记；`voiceprint.json` 存每组 embedding。
- 隐私：音频不落盘、不上传；`voiceprint.json` 只存归一化 embedding，可随时删除单组或清空。
- 局限：注册 3 句即可用，但嘈杂环境/感冒变声会降分；不同 TTS 合成音色之间相似度偏高，阈值不建议低于 0.65。当前「语气/高权限」只保存为档案元数据，供后续逻辑使用，尚未强制拦截指令。

## HTTP 接口（同源，仅回环）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/voice-local/status` | 引擎状态、模型路径、版本、配置 |
| GET | `/voice-local/models` | 模型目录（TTS / ASR 角色、可用性、下载摘要） |
| POST | `/voice-local/models/use` | 热切换模型：`{kind:'tts'\|'asr', id, role?}` |
| POST | `/voice-local/models/fetch` | 开始下载模型（SSE 进度） |
| GET | `/voice-local/stream?voice=1` | SSE：`asr` / `tts` / `assistant` / `model` 事件 |
| POST | `/voice-local/asr/start` \| `/asr/feed` \| `/asr/final` | 流式识别（PCM16LE @16k mono） |
| POST | `/voice-local/speak` | 文本转 WAV（手动测试用） |
| POST | `/voice-local/cancel` | 打断当前 TTS |
| GET / POST | `/voice-local/tts/api` | 读取/保存 TTS 通道与 ASR provider（`breeze` / `local` / `dsh`） |
| POST | `/voice-local/tts/test` | 用当前 TTS 通道合成一句试听 WAV |
| GET | `/voice-local/voiceprint/status` | 声纹状态（模型/档案/开关/阈值/策略） |
| POST | `/voice-local/voiceprint/enable` | 开关声纹锁 `{enabled}` |
| POST | `/voice-local/voiceprint/profiles` | 新增声纹档案 `{nickname, clips:[base64 PCM16×3], tone}` |
| POST | `/voice-local/voiceprint/profiles/reenroll` | 重录 `{id, clips, nickname?, tone?}` |
| POST | `/voice-local/voiceprint/profiles/update` | 改昵称/语气/权限 `{id, ...}` |
| POST | `/voice-local/voiceprint/profiles/delete` | 删除档案 `{id}` |
| POST | `/voice-local/voiceprint/settings` | 识别策略 `{requireEnrolled, thresholdSlider, denoise, wakeMode}` |
| POST | `/voice-local/voiceprint/test?id=` | 用一段 PCM16/WAV 测试指定档案 |
| POST | `/voice-local/voiceprint/enroll` | 单档案兼容接口（PCM16LE 16k 或 16k WAV） |
| POST | `/voice-local/voiceprint/verify` | 试算相似度（同一音频格式） |
| POST | `/voice-local/voiceprint/clear` | 清空全部声纹 |
| POST | `/voice-local/voiceprint/fetch` | 下载声纹模型（SSE 进度） |
| GET | `/voice-local/assets/*` | 内置字体等静态资源 |

## 外部语音 API

### BreezeBlue（流式 TTS）

BreezeBlue 的流式接口原生支持边生成边返回：

```http
POST https://api.breeze.blue/v1/text-to-speech/{voice_id}/stream?output_format=pcm
xi-api-key: brz_...
Content-Type: application/json

{"text":"你好","model_id":"breeze-tts-2","language_code":"zh","instructions":"用温柔、轻声、像哄人一样的语气念，语速稍慢。","voice_settings":{"guidance_scale":1.8,"speed":0.95,"volume":1.0}}
```

返回 24 kHz 单声道 16-bit PCM 分块。插件把它接进现有 TTS 队列：
`/v1/.../stream` 的音频块一到就通过 SSE 推给浏览器播放，不用等整句合成完。

**官方情感控制**（`breeze-tts-2`）：

- `instructions`：用自然语言描述情境、意图、情绪强度、节奏和发声状态；必须与朗读文本同语言。
  例：`用惊喜、开心的语气念，声音明亮，语速稍快，句尾上扬。`
- `voice_settings.guidance_scale`：1–10，越高越贴合 `instructions`；官方建议表达性片段从 **1–3** 起步。
- `voice_settings.speed`：0.5–2×，保持音高；`volume`：0.01–2×。
- 音频标签（`[笑]`、`[叹气]`、`[耳语]`…）可写在中文正文里，属于文本内容；英文用圆括号。
- 官方剩余能力：`use_speaker_boost`（与高强度 instructions 同用时会被忽略）、`/v1/text-to-speech/enhance` 只优化说明文本。

面板里的「情感预设」（自然/温柔/开心/平静/认真/撒娇）会自动填好说明、强度和语速，可再手改。

### 自动情感

打开「情感模式 → 自动情感 · 开」后，插件按**每一句 TTS 文本**做本地规则判断，选中一组
`instructions / guidance_scale / speed`，再发给 Breeze。覆盖：

`开心 / 难过 / 生气 / 惊讶 / 紧张 / 温柔 / 俏皮 / 认真 / 自然`

判断依据是常见情绪词、标点（感叹号、省略号、连续问号）和语气词；没有明显信号时用「自然」，
不会为了效果强行夸张。纯本地规则，不额外调用 LLM，因此不增加首字延迟。

需要更懂反讽、隐喻和上下文的语气时，可再打开「智能判断 → 智能情感（LLM）」。它参考社区
`junarch/voice_for_dsh` 的做法，让 DSH 主模型对每一句输出 `emotion / intensity / instruction`
三行 JSON，再映射成 Breeze 的 `instructions + guidance_scale`：

- 默认关；开启后每句多一次很小的模型请求（约几十到一百多 token）。
- 当前句播放时预取下一句的表演说明，所以只有首句可能略慢。
- 2.2 秒超时、按句缓存；超时、空响应、坏 JSON 都自动回退关键词规则，不会中断朗读。
- 插件内部这次请求不会触发 `llm/stream` 的自动朗读，避免“自己读自己”。

自动情感和手动说明/强度/语速互斥：自动开时忽略「表演说明 / 情感强度 / 语速」，
但「音量」仍按面板滑杆；关掉自动后恢复全部手动参数。智能情感只是自动情感的更细判断，
关掉自动情感时它也不会生效。

![语音 API 设置](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@main/docs/images/voice-api-panel.png)

配置方式（二选一）：

1. 覆盖层 → 模型下拉 →「语音 API 设置」→ TTS 通道选 BreezeBlue，填 Key / `voice_id`，保存并试听；
2. 或直接调接口（Key 只写本机 `$DSH_HOME/voice-local/tts-api.json`，不回显）：

```bash
curl -X POST http://127.0.0.1:57885/voice-local/tts/api \
  -H 'Content-Type: application/json' \
  -d '{"provider":"breeze","apiKey":"brz_...","voiceId":"voc_...","model":"breeze-tts-2","language":"zh"}'
```

没有 Key / `voice_id` 时自动回退本地模型，不会让通话中断。

### DSH 官方语音识别

可以接，但要注意能力边界：

- 官方 `@deepseek-ai/dsh-experimental-voice-input-bundle` 提供本地 SenseVoice（或云端 provider），
  通过宿主 `ctx.speechToText` 暴露 `resolve()` / `transcribe()`；
- 它**只支持完整录音的整句转写，没有流式 partial，也没有语音合成**；
- 插件里设 `asrProvider: "dsh"` 后，VAD 收完一句 → 调官方 `transcribe` → 一次出最终文本；
  代价是通话中不再“边说边出字”，但识别模型/语言可以复用官方配置；
- 默认 `asrProvider: "local"` 仍用本插件的 sherpa 流式 ASR，保留边说边出字。

官方语音输入需要先在 DSH 插件里安装/启用；没有 `speechToText` 服务时插件会发 `asr warn`
并恢复聆听，不会卡死。

## 架构

- **host 半**（`lib/index.js`）：Cordis 插件，`inject ['webServer']`；模型注册表 + 下载器 + `engine-manager`，在 `worker_threads` 里跑 onnxruntime-node / sherpa-onnx；tap `llm/stream` 做流式切句并广播 TTS 音频。
- **client 半**（`lib/client.js`）：DSH 客户端 bundle（`window.__ModuleLoader__` + `slots`），输入框语音条 + 全屏覆盖层；AudioWorklet 16k 重采样 + VAD → `/asr/feed`；TTS PCM16 经 SSE 播放。
- **安全**：回环地址 + Origin 校验 + 请求体大小限制；模型下载校验 SHA256；不写系统目录。

## 手机 / dshgo / dsh-go

- 浏览器/手机端**现在就能用**：`client.js` 已做响应式（安全区、≥44px 触控、窄屏顶栏、矮窗横屏）。
- 手机浏览器访问需要 **HTTPS 或 localhost** 才能拿到麦克风；局域网 `http://192.168.x.x` 会被 Chrome 拒绝。推荐 Tailscale / Caddy 反代或 `dsh web` 的本机模式。
- **dshgo（DSH 口袋）**：Android App + 局域网反代插件（[xiazhi88/dshgo](https://github.com/xiazhi88/dshgo)）。App 的 WebView 主动拒绝网页麦克风（`onPermissionRequest` 一律 `deny`），所以 App 内不能跑全双工；插件检测到非安全上下文会自动进入**手机朗读模式**（App 自带语音输入 + 本地 TTS 朗读回复）；窄屏右下角还有独立「语音」浮动入口，手机浏览器可书签 `/voice-local/mobile` 直达语音。想要全双工，用手机浏览器 + Tailscale HTTPS 打开 dshgo 入口，或 fork App 放行音频权限。详见 [docs/dshgo.md](docs/dshgo.md)；手机本机跑模型的可行性见 [docs/phone-local.md](docs/phone-local.md)。
- 开源手机端 **dsh-go**（[ccch1mneyyy/dsh-go](https://github.com/ccch1mneyyy/dsh-go)）是另一套：App 内置 Linux + Node + **本机引擎**，DSH 直接跑在手机上，插件装到“本机”。本插件 0.9.8 起随包带 `dshGo` 原生清单：长按助手回复 →「朗读」，App 原生播放；ASR 用 dsh-go 官方本地 SenseVoice。0.9.13 新增**原生固定语音入口**：输入框胶囊「语音」、输入框上方状态条、原生「语音通话」面板（试听/停止/情感/通道/状态），不依赖网页；0.9.14 面板可直接循环「关 → 规则 → 智能」情感并写回配置；0.9.15 面板改成通话卡片，可切换云端 BreezeBlue 或本地 TTS，并修复 dsh-go 诊断里的效果格式/提示限流错误。语音输入仍用 **dsh-go 官方语音输入**（App 自带麦克风/SenseVoice）。0.9.12 的智能情感也专门适配了原生朗读：没有网页端 SSE 时也会记住主模型路由，整条消息只生成一次情感、所有分段共用。详见 [docs/dshgo-native-adapter.md](docs/dshgo-native-adapter.md) 与 [docs/community-phone-options.md](docs/community-phone-options.md)。

## 开发与测试

```bash
npm test                 # 全量（需要本机模型；否则模型相关用例会跳过）
node test/parity.mjs     # 文本前端与参考实现逐 token 对齐
node test/models-smoke.mjs
node test/downloader-smoke.mjs
node test/client-smoke.mjs   # 假 DOM/EventSource，验证 UI 与主题
node test/asr-smoke.mjs      # 需 VOICE_ASR_DIR / VOICE_SENSEVOICE_DIR
node test/host-smoke.mjs     # 需示例模型或 VOICE_* 环境变量
```

设计预览（不依赖 DSH）：

```bash
node docs/preview/preview-overlay.mjs     # http://127.0.0.1:57999
# ?theme=day-paper  切换主题；?menu=theme 打开主题菜单；?debug 看断点尺寸
```

模型发布工具（零依赖）：

```bash
node scripts/model-manifest.mjs --dir <模型目录> --base-url <下载根地址>   # 生成 download 清单
node scripts/split-model.mjs --file <大文件> --out-dir <分段目录> --base-url <地址> --chunk-mb 16
```

## 常见问题

- **点了 🎙 没反应 / 没声音**：先看 `/voice-local/status` 的 `lastError`；再看是否授予麦克风权限、页面是否 HTTPS/localhost。
- **模型列表里没有我的模型**：确认 `model.json` 或文件名特征能识别，且目录位于 `models/tts/<id>` 或 `models/asr/{streaming,final}/<id>`。
- **下载失败**：检查 `model.json` 的 `download[].url` 与 `sha256`；国内网络可换 ModelScope/HF 镜像。
- **升级后界面没变**：客户端 bundle 有缓存，刷新页面（F5）。
- **内存/速度**：sherpa WASM 默认单线程；`ttsThreads` 可调。不要同时加载过多模型，按需热切换。

## 许可与致谢

- 本插件代码：[MIT](LICENSE)。
- 第三方代码/字体/模型：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 感谢 dsh-voice-mode（AudioWorklet 重采样）、dsh-talk（VAD 纯函数）、sherpa-onnx、onnxruntime、MeloTTS 与 FunASR/SenseVoice 等开源项目。
- 设计参考：dsh-live-voice、DSH 官方插件（仅参考形态，未复制代码）。

## 版本

当前 `0.9.15`：新增 **dsh-go 原生固定语音入口**（胶囊/状态条/「语音通话」面板，不依赖网页；面板可切换情感和云端/本地 TTS），并保留 **智能情感（LLM 按句判断，可选）**、零额外请求的 **BreezeBlue 规则自动情感**、**官方情感控制**（预设 + 表演说明 + 强度 1–10 + 语速/音量 + 流式 PCM），另有 DSH 官方 ASR 可选接入（`asrProvider: dsh`，仅整句定稿）、dsh-go 原生朗读、声纹面板（CAM++ 28MB）、7 套主题、模型下载器与手机响应式。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
