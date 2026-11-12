# Contributing

Thanks for helping make local voice better! 中文 / English both welcome.

## 开发环境

- Node.js >= 20（与宿主一致）
- DSH 0.2.x（桌面端或 Web 均可）
- 建议至少准备一个 TTS 或流式 ASR 模型用于端到端验证（见 `docs/models.md`）

```bash
git clone https://github.com/god1sdfghjkl/dsh-plugin-voice-local.git
cd dsh-plugin-voice-local
npm install
npm test                 # 模型缺失时相关用例自动跳过
node docs/preview/preview-overlay.mjs    # 不依赖 DSH 的 UI 预览
```

模型路径通过 `VOICE_TTS_ONNX`、`VOICE_ASR_STREAM_DIR`、`VOICE_SENSEVOICE_DIR`、
`VOICE_DATA_ROOT` 指定，**不要**把模型或任何密钥提交到仓库。

## 改代码时的约定

- `lib/client.js` 不引入前端框架依赖：只使用宿主提供的 `react` 与标准 DOM；新增 UI 请兼容
  `test/client-smoke.mjs` 的假 DOM（`createElement/appendChild/style/className` 级别）。
- `lib/index.js` 只依赖 `ctx.webServer`；不要新增监听端口或 spawn 常驻进程。
- 模型相关逻辑统一走 `lib/models/` 的注册表/下载器，避免出现第二套路径探测。
- 主题色只改 `THEMES` 里的 CSS 变量，不在规则里硬编码颜色。
- 任何新增第三方代码/字体/模型，都要同步更新 `THIRD_PARTY_NOTICES.md` 与 `docs/models.md`。

## 提交前检查

```bash
npm test
npm pack --dry-run        # 确认包内没有模型、密钥、调试文件
```

- 新增行为要有测试（至少 client-smoke / models-smoke 之一）。
- Commit message 用祈使句，说明「为什么」，例如 `fix(client): keep theme menu inside viewport`。
- PR 描述写清：改动点、验证方式（截图/命令输出）、是否影响旧配置。

## 发布（维护者）

1. 更新 `package.json` 版本与 `CHANGELOG.md`。
2. `npm test` + `npm pack --dry-run`。
3. `npm publish`（开启 provenance 时用 CI）。
4. GitHub 打 tag、创建 Release，附 tarball 与示例模型包（模型不进 git）。

## 行为准则

参与即表示同意遵守 [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)。