# Changelog

## 0.9.9 — 2026-11-14

- **BreezeBlue 流式 TTS API**：新增 `lib/tts/breeze.js`，接
  `POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm`（24 kHz 单声道 PCM），
  边收 HTTP 音频块边通过现有 SSE 播放，不再等整句合成完。
  - 配置：`ttsProvider: "breeze"`、`breezeApiKey`、`breezeVoiceId`、`breezeModel`、
    `breezeLanguage`、`breezeInstructions`；也可用环境变量 `BREEZE_API_KEY`。
  - 新增 `GET/POST /voice-local/tts/api`（保存到 `$DSH_HOME/voice-local/tts-api.json`，权限 600，
    key 不回显）与 `POST /voice-local/tts/test`（试听）。
  - 覆盖层模型菜单新增「语音 API 设置」面板：本地/Breeze 切换、Key、voice_id、model、
    语言、表演说明、试听、保存。
  - 没有 Key/voice_id 时自动回退本地 TTS。
- **DSH 官方语音识别接入（可选）**：`asrProvider: "dsh"` 时用
  `ctx.speechToText`（官方语音输入 bundle 的本地 SenseVoice 或云端 provider）做整句定稿；
  **官方只有完整录音识别，没有流式 partial**，所以通话中不再边说边出字，停顿后一次出最终文本；
  `asrProvider: "local"`（默认）保留本插件的流式识别。
- 新增 `test/breeze-smoke.mjs`、`test/tts-api-smoke.mjs`、`test/dsh-asr-smoke.mjs`；API 面板、Breeze 流式适配与官方 ASR 通道通过 smoke。
- README / 文档补充 BreezeBlue 与官方 ASR 说明。

## 0.9.8 — 2026-11-14

- **dsh-go 原生界面适配（最小改动）**：同一份包新增 `dshGo` 清单与 `lib/dshgo.js`，长按助手回复即可「朗读」，App 原生播放；不改编排、不改客户端覆盖层、不改 TTS/ASR 引擎。
  - 复用现有 `/voice-local/speak` 的 WAV 输出；长消息按 1800 字切块后拼成一个 WAV。
  - 声明 `audio` / `voice` 能力，用户开口时 App 先在本地停掉朗读。
  - 桌面/网页没有 `dshGo` 桥接时适配层不注册，行为与 0.9.7 完全相同。
  - ASR 原生界面用 dsh-go 官方本地 SenseVoice；网页模式仍用本插件流式 ASR。
- 新增 `test/dshgo-smoke.mjs`（文本清洗、切块、WAV 拼接、read/media、过期 key）。
- 新增 [docs/dshgo-native-adapter.md](docs/dshgo-native-adapter.md) 与 [docs/community-phone-options.md](docs/community-phone-options.md)。
- **通话口吻固定设定**：通话期间（有 `voice=1` SSE 客户端）自动向系统提示词注入一节“像正常人说话”的规则——口语短句、1–3 句、不列清单、不写 Markdown/代码块/括号动作/表情、不说“作为 AI/希望对你有帮助”等套话；挂断后该节渲染为空，下一轮自动恢复默认书面风格。配置 `callPersona: false` 可关闭。
- 新增 `test/call-persona-smoke.mjs`（通话中注入、挂断为空、开关关闭不注册）。
- README 修正 dsh-go 与 dshgo 的区分，补 dsh-go 本机引擎用法。

## 0.9.7 — 2026-11-13（本地测试版，未发布）

- 手机独立入口：窄屏（≤760px）时在页面右下角显示浮动「语音」按钮，不依赖 DSH 输入框工具条；点一次即可开通话，最小化后按钮显示「语音中 / 朗读中」，再点回到通话。
- 新增 `GET /voice-local/mobile`：302 到 `/?dsh-voice=1`，手机浏览器可把这个地址存成书签，打开即自动进语音（无网页麦克风则自动进手机朗读模式）。
- 手机朗读模式增强：监听 DSH 输入框 `input`，dshgo 原生语音写进来的文字停顿 1.4 秒自动发送；覆盖层新增「自动发送·开/关」「输入框」（收起通话界面去用底部原生麦克风）两个按钮；适配 4 按钮窄屏布局。
- 通话中请求 Screen Wake Lock，避免手机/平板熄屏断开；不支持的环境静默跳过。
- 修复提示文字在窄屏贴边溢出的样式问题；`docs/dshgo.md` 增加「模型在哪跑」「怎么接原生麦克风」两节。

## 0.9.6 — 2026-11-13（本地测试版，未发布）

- 手机 / dshgo 适配：检测到非安全上下文或 WebView 没有网页麦克风时，自动进入**手机朗读模式**——不采集网页音频，用 App 自带的系统语音输入，助手回复走本地 TTS 自动朗读；覆盖层显示模式说明，隐藏不适用的静音，保留打断。
- 新增 [docs/dshgo.md](docs/dshgo.md)：dshgo App / 局域网反代插件怎么装、为什么 App 内不能全双工（WebView 主动拒绝音频权限）、手机浏览器 + Tailscale HTTPS 全双工路线、fork App 放行音频权限的最小补丁。
- README / docs/mobile.md 区分 dshgo 与 dsh-go 两个项目。

## 0.9.5 — 2026-11-13（本地测试版，未发布）

- 对话流畅度：通话期间麦克风保持打开，不再每轮反复开/关；TTS 播报结束后 250ms 内恢复聆听，打断后立即回到聆听并重建 ASR 会话。
- 修复空定稿 / 提交失败 / 识别超时后状态机卡在“思考”不再聆听；各失败路径统一恢复聆听。
- 修复关闭设置面板或通话界面时可能停在录音态、无法继续对话。
- TTS 播放增加 120ms 抖动缓冲，网络/合成分块不齐时减少句子中间断音。
- 输入框上方的语音药丸：点击中间文字/电平条可重新打开通话界面（原只有左侧麦克风按钮可用）。
- 声纹准确率：注册时每段录音各存一份模板，比对取最高相似度；测试录音从 3.2s 延长到 4.2s，并显示有效秒数；有效语音不足 1.2s 直接提示重录。
- “仅应答已录入人员”关闭时跳过后台声纹推理，减少定稿等待。

## 0.9.4 — 2026-11-13

- 声纹录入改为**手动停止**：点「开始朗读」后实时计时，点「停止并保存」结束；单句最长 15 秒（建议 3–8 秒），不再固定 4 秒截断。
- 修复「开始朗读」点了没反应：麦克风异步打开失败/已静音/未开通话时在面板内显示具体原因；打开中显示「正在打开麦克风…」；重复点击有保护。
- 准确率优化：录入/比对前先裁剪首尾静音；3 段录音先做一致性校验（最低两两相似度 < 0.5 提示重录）；有效语音不足 0.8 秒（比对 0.6 秒）直接拒绝，避免用半句话打分。
- 阈值滑杆显示实际余弦值（如 40 → 0.70）；测试失败原因显示在档案卡片上。
- 「语气」等下拉改为自绘主题下拉（fixed 定位、不被卡片裁切、深色/亮色背景都跟随），不再使用原生白色 select；后续下拉统一用该组件。
- 取消录入/关闭面板会停止录音并恢复聆听状态。

## 0.9.3 — 2026-11-13

- 声纹开关/策略切换后顶栏状态点立即同步，不用重新打开面板。
- 文档补充声纹镜像来源与第三方许可说明。

## 0.9.2 — 2026-11-13

- 声纹模型下载支持**双来源回退**：先试上游 sherpa-onnx Release，失败/校验不通过自动切到本项目 `voiceprint-v1` 镜像（同 sha256），并清理 `.part`。
- 声纹总开关**持久化**到 `voiceprint.json`，DSH 重启后保持上次状态；`voiceprintEnabled: true` 配置仍可强制开启。
- 清理旧单档案声纹的残留代码；面板入口与模型菜单统一走 `/voiceprint/profiles`。
- GitHub README 截图改用 jsDelivr CDN 绝对地址，避免 `raw.githubusercontent.com` 在部分网络下无法显示。
- 新增 `voiceprint-v1` Release（CAM++ 28MB + checksums + 说明）。

## 0.9.1 — 2026-11-13

- 声纹面板：模型未安装/档案已满时点「添加声纹」不再出现空白卡片，自动回到面板主页并提示。
- 声纹录入：面板打开期间暂停向 ASR 送音，关闭后恢复，避免误触发提交。
- 顶栏「声纹」按钮增加启用状态点与档案数量提示。

## 0.9.0 — 2026-11-13

- **声纹锁（只回答我的声音）**：新增 3D-Speaker CAM++ 声纹校验（Apache-2.0，28MB，按需下载）。
  - 顶栏新增「声纹」入口（主题按钮左边），打开设置面板：总开关、档案管理（最多 5 组）、识别策略、身份联动。
  - 录入向导：随机 3 句提示（每次不同，防预录音频回放）+ 实时波形 + 音量/环境噪音检测；完成后填昵称。
  - 档案卡片：昵称、录入时间、状态、测试/重录/删除；测试即时显示相似度。
  - 识别策略：仅应答已录入人员、置信阈值滑杆（0–100，默认 40）、声纹降噪增强（采集端）、唤醒联动 A/B。
  - 身份联动：每档案可设语气（正常/舒缓/活泼）与高权限指令标记（当前为元数据，随后续逻辑接入）。
  - 纯 JS 实现 Kaldi 兼容 80 维 fbank（25ms/10ms、povey、preemph 0.97、80 mel），
    用 onnxruntime-node 跑 192 维 embedding，余弦相似度 + 阈值（默认 0.70）。
  - 定稿时门控：不匹配就不提交给会话，前端提示「不是本人的声音，已忽略」；注册音频与
    embedding 只存本地（`$DSH_HOME/voice-local/voiceprint.json`），不落盘原始音频、不上传。
  - 新增 HTTP：`/voiceprint/status|enable|profiles|profiles/update|profiles/reenroll|profiles/delete|settings|test|enroll|verify|clear|fetch`。
  - 新增 `test/voiceprint-smoke.mjs`（fbank/多档案/同人通过/异人拒绝/阈值/语气/持久化/上限/删除）。
- README 补充声纹锁说明、配置项、接口；THIRD_PARTY_NOTICES 补充 3D-Speaker 许可。

## 0.8.5 — 2026-11-13

- **首次启动自动下载示例模型**：包内新增 `examples/models/<id>/model.json` 清单；没有可用 TTS 时，
  宿主启动后自动下载示例（默认 `tl196m`，分段 + 校验 + 拼接），下载完自动切换并广播进度。
  配置 `autoDownloadModels: false` 可关闭；`exampleModelId` 可指定其它示例。
- `/models` 会把内置示例作为「虚拟可下载条目」列出：即使模型目录为空，界面也有可下载项。
- 示例清单随 npm 包分发（仅元数据，权重仍按需下载）。
- 新增 `test/models-smoke` 示例清单用例；`host-smoke` 显式关闭自动下载，避免测试联网。

## 0.8.4 — 2026-11-13

- 分段下载改为 **最多 3 路并发**（`partConcurrency=3`），国内慢链路下 11×16MiB 的示例模型明显更快；
  失败时等待所有分段结束再统一清理，避免半截文件与竞态。
- 下载进度仍按整文件累计 `received/total`，`part` / `part-done` 事件带分段序号。

## 0.8.3 — 2026-11-13

- **模型下载器支持分段 `parts`**：清单里一个文件可拆成多段，逐段下载/校验后拼接，再校验整文件
  sha256；失败清理所有临时文件。适合 >2GiB 模型、国内长连接易断的场景（GitHub Release 单文件 2GiB 上限）。
- 新增 `scripts/split-model.mjs`：把大文件切段并生成 `download[].parts` 清单。
- 示例模型 tl196m 改为 **11 × 16MiB 分段** 发布（`models-v1` Release），`examples/models/tl196m/`
  的 `model.json`、`checksums.txt`、README/发布说明同步更新。
- 下载器测试新增分段下载、拼接校验、分段损坏清理 3 组用例（34 项全过）。

## 0.8.2 — 2026-11-13

- **修复**：顶栏上移到窗口标题栏拖拽区后，主题 / 模型两个下拉点击被系统当成「拖动窗口」而打不开。
  覆盖层与所有交互控件补 `-webkit-app-region: no-drag`（整个通话层 no-drag），并抬高 head / 菜单 z-index。
- 预热缓存的小幅调整（不影响功能）。

## 0.8.1 — 2026-11-13

- 手机 / 窄屏响应式：安全区、窄屏顶栏（收主题文字 / 时长）、44px+ 触控、横屏矮窗收缩。
- TTS 改为可选通道（只配 ASR 也可启动），引擎不再因缺 TTS 整体报错。
- 测试去硬编码路径：示例模型可用 `VOICE_*` 环境变量指定，缺模型时模型相关用例跳过。
- 开源工程化：README / README.en、文档补全、模型清单脚本、CI 与模板。
- 版本号与 package-lock 同步。

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