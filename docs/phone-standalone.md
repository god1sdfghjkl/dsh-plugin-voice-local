# 不通过电脑，只用手机跑 DSH + 本插件（0.9.7 设计）

## 1. 先看 dshgo 开源源码的事实

翻了 `xiazhi88/dshgo` 的 486 个仓库文件（去掉 node_modules 后 116 个源码/资源文件），结论：

| 检查 | 结果 |
|---|---|
| Android 源码目录 | 只有 `MainActivity.kt`、`Screens.kt`、`DshApi.kt`、`ConnectionStore.kt`、`ComposerWriter.kt` 等 UI/网络/通知代码 |
| 有没有 Node / DSH host | **没有**；没有 `node` 二进制、没有 DSH 包、没有本地 server |
| 有没有模型/推理 | **没有**；没有 sherpa / onnx / whisper / 模型文件 |
| 连接方式 | `ConnectionStore` 保存一个**电脑地址**，WebView 打开它；`DshApi` 只发 HTTP/WS |
| WebView 麦克风 | `MainActivity.kt` 的 `onPermissionRequest` **直接 `request.deny()`** |
| APK 体积 | 约 1.4 MB，装不下运行环境 |
| dshgo 插件 | 只做 Host/Origin 改写、局域网反代、密码闸门 |

所以：**dshgo App 本身不是“手机上的 DSH 环境”，它只是电脑 DSH 的浏览器壳。**
不开电脑、只装 dshgo App，既没有 DSH host，也没有模型，也没有麦克风权限放行。

## 2. 真正“只用手机”的路径

### 路线 1（推荐，能全双工）：Termux/proot 里跑 DSH host，手机 Chrome 打开

不需要电脑，但需要手机装 Termux（一个终端 App），把 DSH 跑在手机里：

```
手机
├─ Termux (Android)
│   └─ proot Ubuntu (glibc)
│       ├─ Node 20
│       ├─ dsh web :3080（只监听 127.0.0.1）
│       ├─ dsh-plugin-voice-local（本插件）
│       ├─ @xiazhi88/dshgo（反代到 :3081）
│       └─ 模型：~200 MB（手机存储）
└─ 手机 Chrome 打开 http://127.0.0.1:3081
```

关键点：

- `http://127.0.0.1` / `http://localhost` 在 Chrome 里算**安全上下文**，`getUserMedia` 可用，
  不需要 HTTPS；
- dshgo 反代把 `/api` 的 Host/Origin 改写成 loopback，launch token 由插件读取，
  页面能正常登录；
- 模型下载、ASR、TTS、声纹全部在手机 proot 里跑，**不经过电脑**；
- 这是手机浏览器，不是 dshgo App，但界面是同一个 DSH Web UI + 本插件覆盖层。

Termux 里的最小步骤（arm64）：

```sh
pkg update && pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu

apt update && apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm i -g @deepseek-ai/dsh

# 装插件（用你发布/本地传进手机的 tgz）
dsh plugin --profile web add ./dsh-plugin-voice-local-0.9.7.tgz
dsh plugin --profile web add @xiazhi88/dshgo

dsh web --port 3080 --no-open
```

然后在手机 Chrome 打开 `http://127.0.0.1:3081`。首次启动会下载示例模型（约 165 MB）。

已知风险：

- proot 里 `onnxruntime-node` 需要 linux-arm64 glibc 二进制（包内有）；
- Android 会杀后台 Termux，需要 Termux 的 wake-lock / 前台通知；
- 手机 CPU 跑 165 MB TTS 模型，首句延迟高、发热明显；
- 这是实验方案，没在真机上验证过全链路。

### 路线 2：fork dshgo App，放行麦克风，再连手机本机 host

dshgo 的 `onPermissionRequest` 只有一行拒绝，改成放行音频即可：

```kotlin
override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
    val wantsAudio = request.resources.contains(
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE
    )
    if (wantsAudio &&
        androidx.core.content.ContextCompat.checkSelfPermission(
            this, android.Manifest.permission.RECORD_AUDIO
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
        request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE))
    } else {
        request.deny()
    }
}
```

`RECORD_AUDIO` 权限 Manifest 里已有，App 的“语音输入”已经在用。
然后 App 连 `http://127.0.0.1:3081`，localhost 是安全上下文，网页麦克风才可能工作。

但注意：**这仍然需要手机上有 DSH host**（路线 1 的 Termux），
fork 只解决 App 的麦克风闸门，不提供模型运行时。要“只装一个 App”还差：

- 把 Node + DSH + 插件 + 模型全部打进 APK（nodejs-mobile 或自研 runtime），
  体积 300–600 MB，工程量大；
- 或原生 App 重写语音链路（见 `docs/phone-ondevice-design.md` 的 B 方案）。

### 路线 3：原生 App（长期）

Kotlin + sherpa-onnx Android AAR + onnxruntime-android + 自带/远程 LLM。
这是唯一“装一个 APK 就完整可用”的形态，但它不再是 DSH 插件。

## 3. 结论

- **只装 dshgo App、不开电脑**：不可能。源码里没有 host、没有模型、麦克风被拒。
- **只用手机、不通过电脑**：可行，但要在 Termux/proot 里跑 DSH host，
  用手机 Chrome 开 `127.0.0.1:3081`（全双工）；
- 想用 dshgo App 的界面：要 fork App 放行麦克风，并且仍然需要手机上的 DSH host；
- 想像装普通 App 一样“装上就用”：需要原生 App，不是 DSH 插件。

当前 0.9.7 已经能在电脑 host + 手机薄客户端下工作；本文件是“脱离电脑”的实验路线，
没有真机验证前不要当稳定方案。
## 4. “模型跟随插件进入 dshgo”到底行不行

要拆成两件事：**模型文件**和**推理引擎**。

| 东西 | 能不能跟着 DSH 插件包走 | 到了手机能不能执行 |
|---|---|---|
| 模型文件（onnx / bin） | 能，放进 npm 包或 GitHub Release 资产即可 | 能读，但没人跑它 |
| 推理引擎（onnxruntime-node / sherpa native / Node） | 不能；它是电脑 host 的 npm 依赖 | dshgo App 里没有 Node/插件加载器 |
| 浏览器推理（onnxruntime-web / sherpa wasm） | 能，作为 client bundle 的一部分下发 | 手机浏览器能跑；dshgo App 仍拒麦克风 |
| 原生推理（sherpa-onnx Android AAR） | 只能打进 APK | 能跑，但不是 DSH 插件 |

所以：

1. **“插件带模型、手机连电脑用”** —— 现在就是这样：模型在 host 的
   `$DSH_HOME/voice-local/models`，或插件首次启动自动下载；手机只收 PCM。
   模型文件确实“跟随插件”，但执行仍在电脑。
2. **“插件带 WASM 模型、手机浏览器跑”** —— 可行，需要新增一个客户端推理模块：
   - host 提供 `/voice-local/edge/models/<file>`（Range、sha256）；
   - client bundle 引入 onnxruntime-web / sherpa wasm，把模型缓存到 Cache Storage；
   - 手机 Chrome（HTTPS 或 localhost）里完成 VAD/ASR/TTS；
   - dshgo App 内仍不行（WebView 拒麦克风）；fork App 放行后才可能。
   - 模型可以打进插件包，但 165MB TTS 会让插件安装包巨大，建议仍走 Release 资产/首次下载。
3. **“装一个 App，模型就在手机跑”** —— 只能原生 App（模型打进 APK 或首启下载），
   这不是 DSH 插件，dshgo App 也不是这个形态。

一句话：**文件可以跟随插件，执行环境不能。**
dshgo 的“环境”是电脑 host 的 WebView 页面；除非把引擎也搬进手机（WASM 客户端或原生 App），
否则模型放在哪个目录都只是在电脑上跑。
