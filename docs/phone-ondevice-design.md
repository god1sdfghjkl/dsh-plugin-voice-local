# 手机上跑模型 + 装上即用：可行设计（2026-11-13）

## 0. 先把边界说死

DSH 插件（包括 `dsh-plugin-voice-local`）是**服务端 Node 插件**：它由电脑上的 DSH host
加载，在 `ctx.webServer` 上注册 `/voice-local/*`，用 `onnxruntime-node` / `sherpa-onnx`
在电脑 CPU 上推理。dshgo 只是把电脑页面放进 Android WebView 的**瘦客户端**。

所以：

> “把现在这个 DSH 插件装到手机上，模型就在手机跑” —— 这个动作在 dshgo 架构里不存在。
> 手机上既没有 DSH host，也没有插件加载器、Node、ONNX Runtime。

要让模型在手机上跑，只有下面三条真实路径。

## 1. 三条路径对比

| | A. 手机浏览器 PWA | B. 原生 Android App（推荐） | C. nodejs-mobile 内嵌 DSH |
|---|---|---|---|
| 模型在哪 | 手机浏览器 WASM/WebGPU | 手机原生 .so | 手机内嵌 Node |
| 能否“装上就用” | 打开网址即可，可加桌面图标 | 装 APK 即用 | 装 APK 即用 |
| 麦克风 | 需 HTTPS 安全上下文 | 原生 `RECORD_AUDIO`，无网页限制 | App 授权 + localhost/HTTPS |
| dshgo App 内 | **不行**（WebView 拒麦克风） | 不需要 dshgo | 不需要 dshgo |
| 流式 ASR / VAD / 打断 | WASM 可做，性能一般 | 原生 sherpa-onnx，最好 | WASM，一般 |
| TTS | WASM，165MB 模型较吃力 | 原生 onnxruntime，快 | WASM，吃力 |
| 声纹 | WASM onnx，较慢 | 原生 CAM++，可用 | WASM |
| 开发量 | 中 | **大** | 很大 |
| 与 DSH 会话集成 | 需 host 提供远程对话接口 | 需 host 提供远程对话接口 | 完整 DSH 本地 |
| 隐私 | 模型/音频都在手机 | 模型/音频都在手机 | 全部本地 |

**推荐 B：独立原生 App。** 它是唯一能同时做到“装 APK 即用、原生流式、麦克风不受 WebView 限制”的路线。
代价是它不再是 DSH 插件，而是一个新 App；如果还要用 DSH 的会话/工具，就让 App 通过 HTTPS
调用电脑 DSH 的远程对话接口（语音在手机、思考在电脑）。

## 2. B 方案架构

```
┌────────────────────────── Android App（Kotlin, minSdk 26, arm64-v8a）──────────────────────────┐
│ Compose UI（通话界面 / 声纹 / 模型管理 / 设置）                                                │
│                                                                                              │
│ AudioRecord 16k mono ──► Silero VAD ──► sherpa-onnx 流式 zipformer（中英）──► 文本           │
│        │                                                │                                     │
│        │ 播放打断（边播边听）                            ▼                                     │
│ AudioTrack ◄── PCM16 ◄── sherpa-onnx OfflineTTS / onnxruntime-android VITS2 ◄── 回复文本      │
│                                                                                              │
│ 声纹：80 维 Kaldi fbank（Kotlin 移植） + CAM++ ONNX（onnxruntime-android）→ 余弦阈值          │
│ 模型管理：GitHub Release 分段下载 / 断点续传 / sha256 / 首启自动下载                           │
│ 对话：HTTPS 调电脑 DSH 的远程接口（或用户自带 DeepSeek API Key）                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 关键组件

| 模块 | 选型 | 说明 |
|---|---|---|
| ASR | sherpa-onnx Android AAR，streaming zipformer 中英 14M | 与电脑端同一模型，流式 partial/final |
| VAD | sherpa-onnx Silero VAD（AAR 内置） | 替代现在 JS 的 RMS VAD，抗噪更好 |
| TTS | sherpa-onnx OfflineTTS（VITS）或 onnxruntime-android 跑 VITS2 | 首选 sherpa 官方 Android 示例，模型可换 |
| 声纹 | onnxruntime-android + CAM++ 28MB | fbank 用 Kotlin 重写，逻辑与 `lib/voiceprint/fbank.js` 对齐 |
| 模型下载 | OkHttp + 分段 + `.part` + sha256 | 与插件 `downloader.js` 同逻辑，首启自动下示例模型 |
| 通话 | Foreground Service + AudioRecord/AudioTrack | 锁屏继续，通知栏控制挂断 |
| 对话 | `POST https://<dsh>/voice-local/remote/chat`（需新增 host 路由） | 复用 DSH 会话；或 DeepSeek API |

### 2.2 需要在电脑插件侧新增的接口

如果 App 还要用 DSH 的会话/工具，host 侧要加一个“远程对话”入口（手机 App 带 token 调用）：

- `POST /voice-local/remote/chat`：`{sessionId?, text, stream:true}` → SSE 返回助手增量；
-  `GET /voice-local/remote/session`：当前会话/新建会话；
- token 存在 App 设置里，只在局域网/Tailscale 内使用。

如果不接 DSH，App 直接调 DeepSeek API 也能跑，但就失去 DSH 的工具/审批/会话能力。

### 2.3 模型体积与首启

- ASR streaming zipformer：约 30–60 MB；
- TTS VITS：约 60–170 MB（tl196m 165 MB）；
- 声纹 CAM++：28 MB；
- 合计 150–260 MB，首次启动 Wi-Fi 下载，进度可见、可断点续传；
- 模型放 App 私有目录 `files/models/`，卸载即清理；不上传任何音频。

### 2.4 性能预期（中端 Android）

- 流式 ASR：接近实时（14M zipformer，arm64）；
- TTS：一句话 0.5–2 s（原生 onnxruntime，比浏览器 WASM 快）；
- 声纹比对：<100 ms；
- 连续通话发热/耗电明显，建议前台服务 + 屏幕常亮可选。

## 3. A 方案（PWA）最小闭环

如果只想快速验证“模型在手机跑”，PWA 更快：

1. host 插件加 `/voice-local/pwa/` 静态页；
2. 页面加载 `onnxruntime-web` / sherpa wasm，模型从 host 分段下载到 Cache Storage；
3. HTTPS（Tailscale/Caddy）下用 `getUserMedia`；
4. 对话仍调 host 的 `/remote/chat`。

限制：dshgo App 内不能用（麦克风被拒）；165MB TTS 在浏览器里内存/延迟都吃紧；iOS Safari 限制更多。

## 4. C 方案（nodejs-mobile）

把 Node 运行时打进 APK，跑完整 DSH web + 本插件：

- 优点：插件代码几乎原样复用，DSH 会话/工具完整；
- 难点：nodejs-mobile 的 Node ABI 与 `onnxruntime-node` 不兼容（需 Android 版 `.node`）；
  `sherpa-onnx` WASM 可用但慢；DSH CLI 是否能在 Android Node 跑未验证；
- 体积：Node + DSH + 依赖 + 模型 > 500 MB；
- 结论：不作为第一版。

## 5. 分阶段落地

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | Android 工程骨架；模型下载器；sherpa ASR 流式 + VAD | 能说话出文字 |
| P1 | 原生 TTS + 播放打断 + 通话前台服务 | 能对话 |
| P2 | 声纹注册/门控 + 多档案 | 只回答本人 |
| P3 | 远程 DSH 对话接口 + token | 接上 DSH 会话/工具 |
| P4 | 主题/设置/模型中心/打包签名 | 可日用的 APK |

工作量粗估：P0–P1 约 2–3 周（熟悉 sherpa Android 示例的前提下），P2–P4 再 2–4 周；
需要 Android SDK、NDK、签名证书和一台真机；当前这台机器没有 JDK/Android SDK，
要先装工具链才能构建。

## 6. 结论

- **现在的 DSH 插件无法装到手机上跑模型**，dshgo App 也不行，这是架构边界，不是配置问题。
- 要“装上就能用 + 模型在手机”，做 **独立 Android App（B）**；
- 要“插件装上、手机打开就能用但模型在电脑”，现在 0.9.7 已经可用（浮动入口 + 手机朗读模式）。
- 两条路的取舍需要你拍板：接受“新 App、不再是 DSH 插件”，还是保持“电脑 host + 手机薄客户端”。
## 7. 官方文档核对（2026-11-13）

查了 DSH 官方文档，确认前面的判断不是猜的：

1. **插件是 Node host 的 bundle**：官方《Package and install a plugin》写明 bundle 声明 `dsh.bundle`，
   profile 声明 `dsh.profile.bundles`，由 `dsh plugin --profile <name> add ...` 装进
   `$DSH_HOME/profiles/<name>`；加载顺序由 `dsh` 启动器在 Node 进程里应用 patch。
   <https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.md>
2. **插件生命周期属于 Cordis / Node**：`apply(ctx)`、`inject`、fiber 状态机、`ctx.effect` 清理，
   都发生在 host 进程内；不存在“浏览器里装插件”的入口。
   <https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/index.md>
3. **客户端半部也由 host 提供**：`dsh.client` 只是让 host 扫描包、把浏览器 bundle 通过
   `/plugins/...` 路由和 `window.__DSH_BOOT__` 注入页面；它依赖 host 的 boot 图，不是独立应用。
   <https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules.md>
4. **官方只有 `web` / `headless` / `sdk` / `acp` 等 profile**；桌面端是 Electron，自带 dsh 运行时。
   文档没有 Android/手机 host profile，也没有“把插件装到手机”的命令。
   <https://deepseek-harness.github.io/deepseek-harness/en/reference/index.md>

因此：

- 在手机上跑模型 ≠ 装这个 DSH 插件；需要独立的 Android 运行时（本文 B）或 proot 里跑完整 dsh（C）。
- dshgo App 即使连的是“手机本机的 dsh web”，WebView 仍拒绝麦克风且是 HTTP 非安全上下文，
  全双工依旧不可用。
- 唯一“插件装上 + 手机打开就能用”的合法解释，是 **手机浏览器打开 host 页面**（当前 0.9.7 的薄客户端），
  模型仍在电脑；要模型在手机，只能另做 App。
