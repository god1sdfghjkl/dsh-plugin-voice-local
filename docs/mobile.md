# 手机端与 dsh-go 适配

桌面 DSH 里插件已经跑通。本文记录「尽量电脑手机都能用」的三条路径、当前实现与下一步。

## 现状

- `lib/client.js` 已做响应式：安全区（`env(safe-area-inset-*)`）、窄屏顶栏（≤600px 收掉主题文字、
  ≤560px 收掉时长）、44px+ 触控（底部 56px 圆钮）、横屏矮窗收缩、菜单宽度限制。
- 手机浏览器访问需要**安全上下文**：`https://` 或 `localhost`。局域网 `http://192.168.x.x`
  在 Chrome/WebView 中会被拒绝麦克风。
- 音频必须在用户手势里 `AudioContext.resume()`；本插件在点 🎙 的链路里创建/恢复 AudioContext，
  已符合该约束。
- SSE 用 `EventSource`（无自定义请求头），鉴权依赖同源 cookie；反代时需关闭响应缓冲。

## dsh-go 是什么

- 仓库：[ccch1mneyyy/dsh-go](https://github.com/ccch1mneyyy/dsh-go)，Flutter/Android 客户端（AGPL-3.0）。
  手机上用 proot Ubuntu 跑真实 DSH 引擎，也能 SSH / DSH Remote 连电脑。
- 插件机制同源：host 半是 Cordis npm 插件，跑在引擎里；client 半在「网页版 / 网页岛」
  仍走 `__ModuleLoader__` + slots；原生界面需要 `package.json` 的 `dshGo` 清单 +
  `ctx.dshGo` 声明式视图，**App 不执行插件 JS**。
- 原生语音能力（[voice.md](https://github.com/ccch1mneyyy/dsh-go/blob/main/docs/plugins/voice.md)）：
  `audio/voice/micro/overlay`，整段音频 ≤16MiB/≤30s，**不支持流式**；`voice` 只通知开口/说完，
  不给音频；字幕 ≤10Hz。
- 已知阻塞：WebView 麦克风权限仍未转发（issue [#60](https://github.com/ccch1mneyyy/dsh-go/issues/60)），
  源码未见 `onPermissionRequest`；全双工 `audioStream` 仍是 issue
  [#61](https://github.com/ccch1mneyyy/dsh-go/issues/61)。

## 三条路径

| 方案 | 前提 | 工作量 | 结论 |
|---|---|---|---|
| **A 网页版 / 网页岛** | WebView 转发麦克风；host 在手机本机或 SSH 主机 | 3–5 天 | UI 复用率最高，但被 #60 卡住 |
| **B 独立 HTTPS PWA 旁路** | 电脑跑 host；手机 HTTPS（Tailscale/Caddy）访问 | 5–8 天 | 最稳，先能用；脱离 App 聊天界面 |
| **C 原生轻量（dshGo）** | App 原生做 ASR；插件做 TTS/字幕/打断 | 5–7 天 | 可进 App，但不是全双工 |

不推荐 fork dsh-go 做原生全双工：需要改 Kotlin/Flutter，且音频链路不支持流式。

## 推荐路线（1–2 周）

1. **决策门（半天）**：在 dsh-go 1.0.16 真机网页版里打开同源测试页，点按后调
   `getUserMedia({audio:true})`。若立即 `NotAllowedError` → 放弃 A 的 ASR，走 B/D。
2. **P0（1 周）B：HTTPS 旁路 PWA**
   - host 留在桌面 DSH 插件进程；
   - Caddy / Tailscale 反代 `https://<host>/voice-local/*`；
   - client 增加 standalone 启动（独立页面不依赖 DSH slot，输入框换成通话按钮）；
   - 手机浏览器打开即用完整通话，电脑端继续用内嵌 UI。
3. **P1（1 周）D：dshGo 原生轻量**
   - `package.json` 增加 `dshGo` 清单（`message.actions: read`、`capabilities: audio/voice/micro/overlay`）；
   - host 侧增加整段 TTS（WAV/MP3）+ `micro` 字幕；
   - ASR 用 App 原生输入，插件只做朗读与打断提示。
4. **P2**：等上游 `audioStream` / `voiceInput` / `voiceTurn`，或参考
   [dsh-go-voice](https://github.com/Arutoria2024/dsh-go-voice) 的 fork 方案再上全双工。

## 手机端检查清单

- 麦克风：WebView `onPermissionRequest` + `RECORD_AUDIO`；iOS WKWebView 还需
  `requestMediaCapturePermission`（dsh-go 目前仅 Android）。
- 安全上下文：HTTPS / localhost；局域网 IP 必须 TLS。
- 音频：用户手势内 resume；来电/后台会中断，需要恢复；不要承诺锁屏连续通话。
- 布局：`100dvh`、`env(safe-area-inset-*)`、`visualViewport` 处理键盘；触控 ≥44px；横竖屏重排。
- 网络：SSE 反代关闭 `proxy_buffering`；弱网重连；模型下载走 Wi-Fi、断点续传 + SHA256。
- 资源：手机内存有限，模型按需加载、单线程 sherpa；同时只保留一个 TTS/ASR 活跃模型。

## 待验证 / 风险

- dsh-go WebView 麦克风是否已修复（issue #60 仍 open，需真机复验）。
- DSH 0.2.2-rc.1 不在 dsh_client 的验证矩阵（0.2.0/0.2.1）内。
- 手机 proot 下 sherpa-onnx WASM 的实时率、arm64 原生依赖、WebView SSE 长连接均未实测。
- dsh-go 为 AGPL-3.0；fork 或分发衍生作品前先确认许可与品牌要求。

## 我们可直接复用 / 必须重写的

| 复用 | 重写 |
|---|---|
| 模型注册表、下载器、SHA256 校验 | 宿主绑定（目前只 `inject ['webServer']`） |
| engine-manager / sherpa worker / segmenter | 槽位 UI 与全屏覆盖层（移动 standalone 启动） |
| SSE/HTTP 契约、主题与配色 | 打包与 manifest（dshGo 清单） |
| 响应式 UI（已完成基础版） | 流式播放 → 移动原生整段播放 |