# 社区“只装插件就能用”的手机本地方案调研（2026-11-14）

## 结论

- **xiazhi88/dshgo**：只是远程 DSH 的 WebView 壳，没有 host/模型/麦克风，装任何插件都不可能让模型在手机上跑。
- **ccch1mneyyy/dsh-go**：**内置 Linux + Node + 本机引擎**，DSH 直接跑在手机上，插件装到“本机”；
  官方语音输入 bundle 自带**本地 SenseVoice**（int8 约 228 MB，proot 里跑 sherpa-onnx-node），
  这才是“装插件就在手机本地识别”的现实方案。
- **DSH Fusion**：社区 15 个方案融合的 APK，内置 Node/PRoot，装完即用，可装插件；
  也具备离线唤醒，但完整语音仍需插件。
- 纯 TTS 方面，dsh-go 的原生插件协议有 `audio` / `voice` 能力，社区已有
  `dsh-go-local-voice` 示范（当前接的是小米 MiMo / 豆包云端 TTS），可把它的 TTS 换成
  本插件的本地 VITS 引擎，模型落盘到手机。

## 关键证据

### dsh-go 本机引擎

- 文档《本机引擎与远程主机》： “DSH 可以直接运行在这台手机上（本机引擎）……全程在本机完成”。
  <https://github.com/ccch1mneyyy/dsh-go/blob/main/docs/guide/zh/03-engine-hosts.md>
- 文档《插件》：“插件装在当前主机上……本机引擎自带 dsh-go 桥接”。
  <https://github.com/ccch1mneyyy/dsh-go/blob/main/docs/guide/zh/08-plugins.md>

### 官方本地语音输入 bundle

- npm：`@deepseek-ai/dsh-experimental-voice-input-bundle`
  “Experimental voice input with local SenseVoice; downloads its runtime on first use”.
  <https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-voice-input-bundle>
- `dsh-mimo-asr` 的 README 明确写：官方语音输入 bundle 自带 SenseVoice 本地模型
  （int8 约 228 MB，要在 proot 里跑 `sherpa-onnx-node`），它自己则是云端替换。
  <https://www.dshplugin.store/plugin/Easyhoov/dsh-mimo-asr>

### dsh-go 原生音频插件

- 原生插件协议 v1.2 提供 `audio`（播放/停止）、`voice`（开口检测）、`micro`（字幕）、`overlay`。
  <https://github.com/ccch1mneyyy/dsh-go/blob/main/docs/design/native-plugins-protocol.md>
- `dsh-go-local-voice` 是用这些能力做朗读的完整示例（云端 TTS），可照它的结构改成
  本地 VITS：`media` 里用本插件的 `Vits2OnnxEngine` 生成 WAV，App 取回播放。
  <https://github.com/27Synthesis/dsh-go-local-voice>

### 其他社区方案

| 方案 | 形态 | 模型在哪 | 能否只装插件用 |
|---|---|---|---|
| [dsh-hold-to-talk](https://github.com/wangzhanchao883/dsh-hold-to-talk) | Web 插件，本地 SenseVoice | host（电脑/手机 host） | 看 host |
| [haoku123/dsh-voice](https://github.com/haoku123/dsh-voice) | Web 插件，SenseVoice + Edge TTS | host | 看 host |
| [agent-mobile/dsh-speech](https://www.dshplugin.store/plugin/agent-mobile/dsh-speech) | Web host 的 ASR/TTS provider | host | 看 host |
| [dsh-mobile-voice-call](https://github.com/SnowfallC/dsh-mobile-voice-call) | 手机浏览器 + 电脑 whisper/TTS | 电脑 | 否（需电脑） |
| [dsh-mimo-asr](https://www.dshplugin.store/plugin/Easyhoov/dsh-mimo-asr) | dsh-go 麦克风 + 云端 ASR | 云端 | 是，但不本地 |
| [DSH Fusion](https://github.com/yuchen1017918/dsh-fusion/tree/full-bundled) | APK 内置 Node/PRoot | 手机（装插件后） | 是（需先装 APK） |

## 现实建议

要“插件装上、模型在手机跑”，推荐 **dsh-go 本机引擎**：

1. 装 dsh-go APK，设置里安装本机运行环境；
2. 在“插件市场”装官方**语音输入**（本地 SenseVoice），首次使用下载 ~228 MB 模型到手机；
3. TTS 用一个**原生本地 TTS 插件**（需要新写/改造，走 `dshGo.audio` + 本机 VITS 引擎，模型落手机）；
4. 这样不需要电脑；dshgo App 无法参与，因为它是远程壳。

如果坚持 dshgo：只能 fork App + 在手机上另跑 DSH host（Termux/proot），不是“只装插件”。

## 下一步可做

把本仓库的 TTS 引擎封装成 dsh-go 原生插件：

- `package.json` 增加 `dshGo` 清单：`capabilities: ["audio","voice"]`，`message.actions: [{id:"read"}]`；
- `ctx.dshGo.on('read')` 返回 `audio.play` + `voice.start`；
- `ctx.dshGo.media('speech')` 用 `Vits2OnnxEngine` 生成 WAV（模型路径在手机 `$DSH_HOME`）；
- `voice.speechStart` 时 `audio.stop`，实现开口打断；
- 首次使用下载/校验模型，进度写面板。

该插件可以发布到 dsh-go 插件市场/以 npm 包安装；仍不是“网页版插件”，但满足“只装插件、模型在手机”。