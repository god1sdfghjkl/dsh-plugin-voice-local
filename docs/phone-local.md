# 手机本机跑模型：可行性设计（0.9.7）

结论先说：**dshgo App 本身跑不了**；真要在手机上跑，需要绕过 App，在 Android 上自己跑一份
`dsh web` + 本插件（Termux/proot）。下面是按代码与依赖实测过的设计，不是拍脑袋。

## 1. 为什么 dshgo App 跑不了

| 检查项 | 结果 |
|---|---|
| APK 体积 | 约 1.4 MB，不含 Node / ONNX / sherpa / 模型 |
| Gradle 依赖 | Compose、OkHttp、ZXing、Biometric；无推理框架 |
| 数据通路 | `DshApi.kt` 只发 `POST /api/...` 与 `ws://.../api/remote.mux` 给电脑 |
| dshgo 插件 | 只做 Host/Origin 改写和反代，不碰音频/模型 |
| WebView 麦克风 | `onPermissionRequest` 一律 `deny`，且入口是 HTTP，非安全上下文 |

所以 App 是**瘦客户端**：模型、ASR、TTS、声纹都只能在电脑 host 进程里。

## 2. 手机本机跑的技术栈

要跑就跑完整的一套：

```
Android (Termux + proot Ubuntu, glibc)
  └─ Node 20 (arm64)
      └─ dsh web (DSH host)
          └─ dsh-plugin-voice-local
              ├─ sherpa-onnx (WASM，流式 ASR / 兜底 TTS)
              ├─ onnxruntime-node (VITS2 TTS，linux/arm64 二进制)
              ├─ @node-rs/jieba (linux-arm64-gnu)
              └─ 模型：~200 MB（tl196m 165 MB + ASR + 声纹 28 MB）
```

已核对依赖包内的平台目录：

- `onnxruntime-node/bin/napi-v6/linux/arm64` 存在；
- `@node-rs/jieba-linux-arm64-gnu` 存在；
- `sherpa-onnx` 走 WASM + worker，Node 可跑；
- Termux 原生是 Android bionic，**不能**直接加载这些 glibc `.node`，必须 proot 一套 Ubuntu。

体积/资源粗算：Ubuntu proot 1–2 GB + Node/DSH/插件 300–500 MB + 模型 200 MB；
运行内存 1–2 GB；持续通话发热、耗电明显，TTS 延迟预计比 PC 高 2–5 倍。

## 3. 就算跑起来，麦克风仍是死结

- `dsh web` 只监听 `127.0.0.1`，手机浏览器打开 `http://127.0.0.1:xxxx` 算安全上下文，
  能拿到网页麦克风；但 `dsh web` 是 HTTP，需要自己套 HTTPS（Caddy/Tailscale Serve 或自签证书）。
- dshgo App 即使连到手机本机，仍是 HTTP + WebView 拒绝麦克风，**全双工依旧不可用**；
  只能继续用“原生语音输入 + 朗读回复”的降级模式。
- 想在 App 内全双工，只能改 dshgo App（放行 `RESOURCE_AUDIO_CAPTURE` + HTTPS），
  这属于 App 开发，不是插件能解决的。

## 4. 因此的现实方案

| 方案 | 模型在哪 | 手机体验 | 建议 |
|---|---|---|---|
| A. 电脑 host + 手机 HTTPS 浏览器（Tailscale/Caddy） | 电脑 | 全双工、本地 ASR/TTS、可声纹 | **推荐** |
| B. 电脑 host + dshgo App | 电脑 | 原生语音输入 + 自动发送 + 朗读回复；无 VAD/打断/声纹 | 当前 0.9.7 已支持 |
| C. 手机 proot 跑 dsh web | 手机 | 理论可行，HTTPS 浏览器才可用；发热/延迟/维护成本高 | 不推荐 |
| D. 原生 Android App 内置运行时 | 手机 | 需新写客户端与音频桥 | 长期选项 |

本插件的“单独界面”已经可用：窄屏右下角浮动「语音」入口、通话覆盖层、手机书签
`/voice-local/mobile`。它仍然连电脑 host，所以是方案 A/B，不是 C。

## 5. 如果一定要试方案 C（实验步骤）

1. Termux 安装 proot-distro，装 Ubuntu 22.04；
2. 装 Node 20（arm64 glibc）与 pnpm；
3. 在 Ubuntu 里 `npm i -g @deepseek-ai/dsh`（或对应 CLI）并 `dsh web`；
4. 把本插件 `dsh-plugin-voice-local-0.9.7.tgz` 装进 profile；
5. 首次启动会自动下载示例 TTS 模型（约 165 MB），或手动放模型到
   `~/.dsh/voice-local/models/{tts,asr,voiceprint}`；
6. 用 Caddy/Tailscale 给 `127.0.0.1:<port>` 套 HTTPS，手机浏览器打开；
7. 实测指标：首字延迟、连续 30 分钟通话温度/耗电、内存峰值、打断延迟。

风险：DSH CLI 可能依赖 Electron/桌面能力；`dsh web` 在 proot 下是否完整可用未验证；
Android 后台会杀 proot 进程。**没有设备实测前不要把它当可用方案。**