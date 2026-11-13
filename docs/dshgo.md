# dshgo（DSH 口袋）手机使用说明

面向 `dsh-plugin-voice-local`（下称「本插件」）的手机端接入记录，基于
[dshgo 官方仓库](https://github.com/xiazhi88/dshgo) 的 README、Android 源码与
[dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 的 `docs/plugins/voice.md`。
最后核对：2026-11-13，dshgo `main`。

## 一、dshgo 是什么

- **Android App**：WebView 打开 **DSH 网页本体**，不是另写一套原生聊天界面；
  Release APK 约 1.4 MB。
  - 额外做：完成通知、审批通知栏按钮、多电脑连接、主屏小组件、App 内更新、
    系统语音输入（`SpeechRecognizer`，识别结果写进 DSH 输入框）。
- **DSH 插件 `dshgo`**：把只监听 `127.0.0.1` 的 `dsh web` 通过一个本地反代暴露到
  局域网 `http://<电脑IP>:3081`，并带「局域网访问」设置页签和二维码。
  - 反代把入站请求的 `Host` / `Origin` 改写成 `127.0.0.1:<dshPort>`，
    绕过 DSH 的 loopback 栅栏和 cookie authority 校验。
  - 可选访问密码（scrypt 存储，拦在注入 launch token 之前）。

安装：

```sh
dsh plugin --profile web add github:xiazhi88/dshgo -w
# 或：dsh plugin --profile web add @xiazhi88/dshgo -w
# 装完必须重启 dsh web
```

App 下载：<https://github.com/xiazhi88/dshgo/releases/latest/download/dshgo-app.apk>

## 二、本插件在 dshgo App 里能用到哪一步

| 能力 | dshgo App 内 | 原因 |
|---|---|---|
| 插件 UI（通话覆盖层、声纹面板、主题） | ✅ | App 就是 WebView，加载完整 DSH 页面 |
| 朗读回复（TTS） | ✅ | WebAudio 播放不需要网页麦克风 |
| 网页麦克风（`getUserMedia`） | ❌ | App 的 `WebChromeClient.onPermissionRequest` **一律 `request.deny()`**（含音频），Android 源码 `MainActivity.kt` 明确拒绝；`android/README.md` 的「已知边界」也写了「摄像头 / 麦克风：一律拒绝」 |
| App 自带语音输入 | ✅ 但只写输入框 | `SpeechRecognizer` 识别后通过 `execCommand('insertText')` 写入 composer，不经过本插件 |

因此 **App 内不可能直接跑本插件的全双工通话**：不是插件要权限的问题，
而是宿主 WebView 在回调里主动拒绝，页面层拿不到 `navigator.mediaDevices.getUserMedia`。
另外 dshgo 入口是 `http://<IP>:3081`，非安全上下文本身也会让 `getUserMedia` 不可用。

## 三、已实现的降级：手机朗读模式

插件检测到「非安全上下文」或「没有 `navigator.mediaDevices`」时，点语音按钮不会死磕麦克风，
而是进入 **手机朗读模式**（客户端 `enableReadingMode()`）：

- 不采集网页音频；
- 连接 `/voice-local/stream?voice=1`，宿主 `llm/stream` tap 会把助手回复继续朗读；
- 输入用 **App 状态条上的麦克风按钮**（系统语音输入），说完点发送；
- 播放前在用户点击手势里解锁 `AudioContext`，满足移动端自动播放策略；
- 覆盖层显示「手机朗读模式」，隐藏不适用的「静音」，保留「打断」。

用法：

1. 电脑装好 dshgo 插件并重启 `dsh web`，手机 App 连上 `http://<电脑IP>:3081`。
2. 打开 DSH 页面，点输入框区域的语音按钮 → 出现「手机朗读模式」提示。
3. 点 App 状态条麦克风说问题 → 识别文字进输入框 → 发送。
4. 助手回复会自动朗读；点「打断」可停。

限制：没有网页麦克风就没有本地的流式 ASR、VAD 和「开口打断」；ASR 由手机系统语音输入完成，
质量取决于手机识别引擎；朗读仍是本插件本地 TTS（音频不经过手机厂商云）。

## 四、想要全双工：两条可行路线

### 路线 A（推荐先试）：手机浏览器 + HTTPS，不走 App

dshgo 插件负责把 DSH 暴露到局域网，再用 Tailscale 提供 **HTTPS 安全上下文**；
手机浏览器（不是 App）打开后，本插件的网页麦克风可用，全双工原样工作。

```sh
# 电脑：dshgo 插件已装、dsh web 在跑（默认 3080，dshgo 对外 3081）
tailscale serve --bg http://127.0.0.1:3081
tailscale serve status          # 拿到 https://<machine>.<tailnet>.ts.net
```

手机（同一 tailnet）浏览器打开 `https://<machine>.<tailnet>.ts.net`：

- ✅ 安全上下文 → `getUserMedia` 可用；
- ✅ dshgo 反代继续把 `Host`/`Origin` 改写回 loopback，DSH 栅栏与 cookie 正常；
- ✅ 无 App 的 `onPermissionRequest` 拒绝问题；
- ⚠️ 需先装 Tailscale App 并登录同一账号；首次打开要允许麦克风；
- ⚠️ 这条链路要实测 cookie 是否被浏览器接受（dshgo 返回的 cookie 名绑定 loopback
  authority，浏览器按 tailnet 域存；dshgo 每次改写 Host，理论一致，若异常改用 App 路线）。

### 路线 B：fork dshgo App，放行音频权限（需重新打包 APK）

dshgo 是 MIT，可以自行改 App。最小改动：

```kotlin
// MainActivity.kt
private var pendingWebPermission: PermissionRequest? = null

override fun onPermissionRequest(request: PermissionRequest) {
    if (!request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
        request.deny(); return
    }
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        == PackageManager.PERMISSION_GRANTED) {
        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
    } else {
        pendingWebPermission = request
        micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }
}

// micPermission 回调里
val p = pendingWebPermission; pendingWebPermission = null
if (granted && p != null) p.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
```

`RECORD_AUDIO` 已在 manifest 声明（App 系统语音输入本来就要）。但**仍然需要 HTTPS**：
Chromium/WebView 只在安全上下文提供 `getUserMedia`，所以路线 B 要配合路线 A 的
Tailscale Serve（App 连接地址填 `https://<machine>.<tailnet>.ts.net`）。
改完需 Android Studio / Gradle 重新构建安装。

### 不推荐

- 把 dshgo 端口直接端口映射到公网：`dsh web` 无登录口令，等于把远程代码执行权交给扫描器。
- 在页面里用 iframe / 自签证书绕过安全上下文：WebView 与 Chrome 都会拦，维护成本高。

## 五、dsh-go（另一个项目）的语音接口

[ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 是原生 Flutter 插件体系，
和 dshgo 不是同一个项目。它的 `audio/voice/micro/overlay` 能力：

- 整段音频 ≤16 MiB / ≤30 s，**不支持流式**；
- `voice` 只通知“开口/说完”，不给音频；
- WebView 麦克风权限同样未转发（issue #60 仍 open），`audioStream` 全双工是 issue #61。

结论不变：要全双工，优先走「HTTPS + 浏览器」；App 内先读插件文档里的降级模式。

## 六、手机端检查清单

- 麦克风：HTTPS 或 localhost；App 内需宿主 `onPermissionRequest` 放行 + `RECORD_AUDIO`。
- 音频：用户手势里 `AudioContext.resume()`（本插件已做）；来电/切后台会中断。
- 布局：`100dvh`、`env(safe-area-inset-*)`、触控 ≥44px；本插件已做 ≤600px 响应式。
- 网络：SSE 反代关闭缓冲；弱网重连；模型下载走 Wi-Fi + 断点续传 + SHA256。
- 资源：手机内存有限，模型按需加载；同时只保留一个 TTS/ASR 活跃模型。
- 版本文档：dshgo 最低 DSH `0.1.2-rc.1`；本插件 engines 为 `>=0.2.0 <0.3.0-0`。
## 七、模型到底在哪跑（重要）

**模型不在手机里跑。** dshgo 是 WebView 客户端 + 局域网反代，不是把 DSH/Node 运行时装进手机：

| 证据 | 说明 |
|---|---|
| APK 约 1.4 MB | 放不下 onnxruntime / sherpa / 几十 MB 模型 |
| `android/app/build.gradle.kts` 依赖只有 Compose、OkHttp、ZXing、Biometric | 没有 ONNX Runtime、sherpa-onnx、Node、ML Kit |
| `DshApi.kt` 全部是 `POST /api/...` 与 `ws://.../api/remote.mux` | App 只跟电脑上的 dsh web 通信 |
| dshgo 插件只做 Host/Origin 改写与转发 | 不碰音频、模型、推理 |

本插件的模型与推理全部在**电脑的 DSH host 进程**里：

```
手机 App (WebView)
   │  HTTP/SSE（局域网或 Tailscale）
   ▼
电脑 dshgo 反代 :3081
   │  Host/Origin 改写
   ▼
电脑 dsh web :3080  →  dsh-plugin-voice-local host（Node）
                           ├─ sherpa-onnx / onnxruntime-node
                           └─ %USERPROFILE%\.dsh\voice-local\models\...
```

- 模型下载：点「下载模型」时是**电脑**在下，落到
  `C:\Users\19863\.dsh\voice-local\models\{tts,asr,voiceprint}`，不占手机存储；
- TTS 推理：电脑 CPU，PCM16 16k 单声道约 **32 KB/s** 通过 SSE 推到手机播放；
- ASR 推理：正常桌面通话在电脑；App 里没有网页麦克风，走手机系统识别；
- 声纹注册/比对：电脑上的 CAM++；App 内无法注册（没有网页麦克风），要用电脑或手机 HTTPS 浏览器。

因此“把模型放手机上跑”在 dshgo 里**做不到**。真要在手机上跑，需要：
1. 在 Android 上用 Termux/proot 跑完整的 `dsh web` + Node + 本插件（arm64 原生依赖、内存/发热/耗电都未验证）；
2. 或做一个原生客户端并内置模型运行时（`ccch1mneyyy/dsh-Go` 的原生插件体系目前也不支持流式音频）。

## 八、怎么接到 dshgo 自带的麦克风按钮

dshgo 的麦克风按钮是 **App 原生**的 `SpeechRecognizer`，不是网页按钮；它识别完通过
`ComposerWriter.writeJs()`（`execCommand('insertText')`）写进 DSH 输入框。
插件**拿不到音频**，但能收到输入框的 `input` 事件 —— 这是当前唯一稳定的接入点。

0.9.6 的做法：

1. 点插件自己的「语音」按钮，检测到 WebView 没有网页麦克风 → 进入**手机朗读模式**；
2. 该模式监听 DSH composer 的 `input` 事件；dshgo 原生语音写进来的文字会被捕获；
3. 停约 **1.4 秒**自动点发送（可用覆盖层里的「自动发送·开/关」关闭）；
4. 助手回复由电脑 TTS 合成、SSE 推回 WebView 自动播放。

> 限制：这不是“把插件塞进原生麦克风”，而是“让原生麦克风写进来的文字自动进入语音流程”。
> 没有网页麦克风就没有本地流式 ASR、VAD、开口打断、声纹门控；ASR 质量与隐私取决于手机
> 系统的 `RecognitionService`（不少机型会走厂商/Google 云端识别，和本插件“纯本地”的定位不同）。
> 要真正全双工，只能走第四节路线 A/B。

### 手机上的操作顺序

1. 电脑装 dshgo 插件并重启 `dsh web`；手机 App 连 `http://<电脑IP>:3081`。
2. 打开 DSH 页面，点插件工具栏里的语音按钮 → 出现「手机朗读模式」。
3. 点 dshgo 底部原生麦克风说话 → 文字进输入框 → 自动发送 → 回复自动朗读。
4. 点通话界面的「打断」可停止朗读；点「挂断」关闭语音模式。

## 九、0.9.7 的独立手机入口

- 窄屏（≤760px）页面右下角出现浮动「语音」按钮，不依赖 DSH 输入框插槽；点开即通话，最小化后按钮显示「语音中 / 朗读中」。
- 手机朗读模式覆盖层多了两个按钮：
  - 「输入框」：收起通话界面，露出 DSH 输入框，去点 dshgo 原生麦克风；
  - 「自动发送·开/关」：控制识别文字停 1.4 秒后是否自动提交。
- 手机浏览器书签入口：`https://<地址>/voice-local/mobile` → 302 到 `/?dsh-voice=1`，打开即自动进语音。
- 通话期间申请 Screen Wake Lock（HTTPS 浏览器支持；dshgo HTTP/WebView 静默跳过）。

> 再次强调：这些入口只是“把手机接到电脑上的语音引擎”，模型仍在电脑跑；
> App 内没有网页麦克风，就没有本地 VAD / 流式 ASR / 声纹。
