# Changelog

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