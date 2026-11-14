# 让现有插件在 dsh-go 上跑：最小改动设计（2026-11-14）

目标：**不重写语音引擎、不改网页端 UI**，只加一层很薄的 dsh-go 原生插件桥，
让同一份 npm 包既能装桌面/网页，也能装 dsh-go 本机引擎。

## 先说结论

采用“**同包 + 一个适配文件 + 一段清单**”：

| 文件 | 改动 |
|---|---|
| `package.json` | 增加 `dshGo` 清单（约 25 行） |
| `lib/dshgo.js` | 新增，约 180–220 行，独立适配层 |
| `lib/index.js` | 加 1 行 import + 1 行调用（在 `apply` 末尾） |
| `lib/client.js` | **0 改动** |
| `lib/tts/*`、`lib/asr/*`、`lib/engine-manager.js` | **0 改动** |
| `cordis.patch.yml` | **0 改动** |
| 现有 HTTP 路由 | **0 改动**，直接复用 `/voice-local/speak` |

这样 dsh-go 原生界面走 `dshGo` 桥，桌面/网页仍走原 `client.js` 覆盖层；
两个入口共享同一个宿主 TTS 引擎和同一套模型。

## 为什么可以这么薄

现有插件已经具备适配所需的全部接口：

1. **`POST /voice-local/speak`** 已经返回 `audio/wav`，由宿主 TTS 引擎合成；
2. **`POST /voice-local/cancel`** 已经能打断当前朗读；
3. 模型下载、引擎启动、音色切换都在宿主侧，与 UI 无关；
4. dsh-go 原生插件只需要 `audio` / `voice` 两种桥接能力，不要求重写推理。

所以适配层只做三件事：

```
dshGo.on('read')      →  把消息正文切成 ≤1800 字，记 key，返回 audio.play + voice.start
dshGo.media('speech') →  用 key 找到正文，调本机 /voice-local/speak，把 WAV 交给 App
dshGo.onCapability()  →  收到 audio.ended/stopped 清状态
```

## 新增 `dshGo` 清单

```json
"dshGo": {
  "v": 1,
  "minApp": "1.0.0",
  "title": { "zh": "本地朗读", "en": "Local Voice" },
  "icon": "speaker",
  "wants": ["message"],
  "capabilities": ["audio", "voice"],
  "contributes": {
    "message.actions": [
      { "id": "read", "label": "朗读", "icon": "speaker", "requires": ["audio"] }
    ],
    "media": [{ "id": "speech" }]
  }
}
```

- `wants: ["message"]`：长按消息时 App 附带正文，适配层不用按 id 查会话；
- `capabilities: ["audio","voice"]`：`audio` 播放 WAV，`voice` 让用户一开口 App 先在本地停掉朗读；
- `message.actions` 上限 2 条、label ≤12 字；这里只放 1 条。

## 新增 `lib/dshgo.js`

核心结构（伪代码，实际实现再加错误处理/清理）：

```js
const MAX_CHARS = 1800      // /speak 路由上限 2000
const MAX_JOBS = 8
const jobs = new Map()      // key → { text, at }

export function installDshGo(ctx, { speak, cancel, base }) {
  ctx.inject(['dshGo'], (ctx) => {
    const inst = 'read'

    ctx.dshGo.on('read', (scope) => {
      const text = cleanForSpeech(scope?.message || '')
      if (!text) return { toast: '这条没有能朗读的文字' }
      const key = `r${Date.now().toString(36)}`
      const { chunks, truncated } = splitText(text, MAX_CHARS)
      jobs.set(key, { chunks, at: Date.now() })
      trimJobs()
      const effects = [
        { type: 'audio', op: 'play', instance: inst, src: 'media:speech', key },
        { type: 'voice', op: 'start', instance: inst },
      ]
      if (truncated) effects.push({ toast: '消息较长，已朗读前 ' + MAX_CHARS + ' 字' })
      return effects
    })

    ctx.dshGo.media('speech', async (scope, { key, signal }) => {
      const job = jobs.get(key)
      if (!job) throw new Error('这次朗读已过期，再点一次')
      // 多个 ≤1800 字的块依次合成，拼成一个 WAV；每块都走现有 /speak
      const wav = await speakChunks(job.chunks, { signal })
      return { body: wav, contentType: 'audio/wav' }
    })

    ctx.dshGo.onCapability((scope, ev) => {
      if (ev?.instance !== inst) return
      if (ev.event === 'audio.ended' || ev.event === 'audio.stopped' || ev.event === 'audio.error') {
        // 保留最近一条，方便重复点；其余清掉
      }
    })
  })
}
```

`speak` 由 `lib/index.js` 注入，直接调已有引擎，不走 HTTP 端口发现：

```js
installDshGo(ctx, {
  speak: async (text, opts) => {
    const audio = await synthAudio(text, opts) // Breeze / 本地引擎共用
    return pcm16ToWav(audio.pcm, audio.sampleRate || cfg.sr)
  },
  resolveStyle: (text) => autoEmotionStyle(text),
  cancel: () => tts.cancel(),
})
```

这样适配层不需要知道端口、不需要解析 HTTP、也不会和现有路由的鉴权/同源检查打架。

## 多块拼接

dsh-go 的 media 路由要求“一次完整音频、≤16 MiB、30 秒内产出”，而 `/speak` 只接受 2000 字。
处理方式：

1. 按句号/问号/换行切成 ≤1800 字的块；
2. 每块调用 `engine.synth` 得到 PCM16；
3. 丢掉每块 WAV 的 44 字节头，拼成一个 WAV；
4. 单块失败就返回已合成的部分，并在日志里记失败块。

16 kHz/44.1 kHz 单声道 16bit，16 MiB 约能放 95 秒（44.1k）或 8 分钟（16k），
一般回复远小于这个上限。

## 情感（0.9.12）

- 网页端是逐句流式播放，可以在当前句播放时预取下一句的表演说明（`tts.pump`）。
- dsh-go 的 `media` 要等**整段 WAV** 合成完才交给 App，没有逐句预取的机会；所以适配层
  改为先按整条消息调用一次 `resolveStyle(text)`，再把同一个 `style` 传给每个分段的
  `speak(chunk, { style })`。8 段只多一次 LLM 小请求，而不是 8 次。
- dsh-go 原生界面没有网页端 `voice=1` SSE，但 `llm/stream` tap 现在无论有没有语音客户端
  都会记录主模型的 `provider/model`；智能情感因此能在原生「朗读」里沿用同一个主模型。
- 规则模式（`breezeSmartEmotion=false`）零额外 LLM；智能模式失败/超时回退规则，不阻断朗读。

## ASR 怎么接

**不改现有 ASR。** dsh-go 原生界面用官方语音输入：

- `@deepseek-ai/dsh-experimental-voice-input-bundle`（本地 SenseVoice，首次下载运行时/模型）；
- 输入框麦克风 → App 录音 → `speech/transcribe` → 文本进输入框；
- 本机引擎里模型跑在手机 proot，不需要电脑。

网页模式仍可用本插件原有的浏览器流式 ASR；两种入口互不冲突。

## 声纹

原生 dsh-go 路径拿不到原始 PCM（App 只给转写后的文本），所以**声纹门控只在网页模式可用**。
如果以后要做，需要包一层 speech provider 或让 App 暴露原始音频，不建议放进这次最小改动。

## 模型与安装

- 模型不随包发布；首次启动仍由现有 `autoDownloadExample` 下载 tl196m 到手机 `$DSH_HOME`；
- `onnxruntime-node` 需要 dsh-go 安装时允许构建脚本；本机引擎是 PRoot Ubuntu glibc，linux-arm64 应可加载，但真机要验；
- dsh-go 市场只从 npm 安装，所以要先发布（npm 账号 2026-11-16 14:34 解封后）；
- 同一个包同时有 `dsh.bundle` 和 `dshGo`：桌面/网页加载 `client.js`，dsh-go 原生界面只读 `dshGo` 清单，互不影响。

## 验证计划

1. 电脑上 fake `dshGo` 服务跑 `test/dshgo-smoke.mjs`：
   - 清单字段合法；`read` 返回 audio/voice 效果；`media` 返回 WAV；
   - 长文本分块拼接；空消息/超长/失败路径。
2. `node --check lib/index.js`、`client-smoke`、`host-smoke`、`voiceprint-smoke` 全绿。
3. 桌面装包后网页模式无回归。
4. 真机 dsh-go：装本机引擎 → 装本插件 → 长按回复「朗读」→ 出声；开口打断；网页模式仍完整。

## 改动清单（最终）

```diff
 package.json
+  "dshGo": { ... }

 lib/index.js
+ import { installDshGo } from './dshgo.js'
  ...
+ installDshGo(ctx, { speak: ..., cancel: () => tts.cancel() })

 lib/dshgo.js          新增
 test/dshgo-smoke.mjs  新增
 docs/dshgo-native-adapter.md  新增（本文件）
```

`client.js`、引擎、路由、模型格式都不动。

## 实现状态（0.9.8）

已落地：`package.json` 的 `dshGo`、`lib/dshgo.js`、`lib/index.js` 的
`installDshGo(ctx, { speak, ensureReady })` 调用，以及 `test/dshgo-smoke.mjs`。
`read` 只声明消息菜单；多块 WAV 由 `concatWav()` 拼接；没有 `composer.strip`（减少一处状态源）。
真机 dsh-go 的安装包发布后即可验证。