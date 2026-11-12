# 模型：放置、注册、下载与发布

插件代码以 MIT 发布，但**模型权重是独立作品**，许可各自不同。模型不随 npm 包分发。

## 1. 放在哪

默认根目录：`$DSH_HOME/voice-local`（可用 `VOICE_DATA_ROOT` 或配置 `dataRoot` 覆盖）。

```text
<dataRoot>/models/
├── tts/<id>/                     # TTS：每个子目录一个模型
│   ├── model.json                # 可选
│   ├── model.onnx
│   ├── tokens.txt
│   └── lexicon.txt
└── asr/
    ├── streaming/<id>/           # 流式识别（实时字幕）
    │   ├── model.json
    │   ├── tokens.txt
    │   ├── encoder*.onnx
    │   ├── decoder*.onnx
    │   └── joiner*.onnx
    └── final/<id>/               # 整句定稿
        ├── model.json
        ├── model*.onnx
        └── tokens.txt
```

旧配置仍兼容：`ttsOnnx` + `ttsConfig`、`asrStreamDir`、`sensevoiceDir`。
环境变量：`VOICE_TTS_ONNX`、`VOICE_ASR_STREAM_DIR`、`VOICE_SENSEVOICE_DIR`。

## 2. `model.json`

### TTS

```jsonc
{
  "id": "melo-zh",
  "name": "MeloTTS 中文",
  "engine": "sherpa-offline-tts",     // vits2-onnx | sherpa-offline-tts
  "type": "vits",                     // sherpa: vits | melo | piper | matcha | kokoro | kitten
  "sampleRate": 44100,
  "files": {
    "model": "model.onnx",
    "tokens": "tokens.txt",
    "lexicon": "lexicon.txt",
    "voices": "voices.bin"
  },
  "options": {
    "speed": 1.0,
    "sherpa": { /* 直接透传 sherpa OfflineTts 配置；路径相对模型目录 */ }
  },
  "download": [
    { "url": "https://…/model.onnx", "path": "model.onnx", "sha256": "…", "bytes": 169000000 }
  ]
}
```

`engine`/`type`/`files` 全部可省：省略时按目录内文件名特征探测。
`files` 的路径必须相对模型目录；下载器拒绝 `..` 与绝对路径。

### ASR

```jsonc
{
  "id": "zh-stream",
  "name": "Zipformer 中文流式",
  "role": "streaming",                // streaming | final
  "type": "transducer",               // 流式 transducer；定稿 sense_voice/whisper/paraformer/transducer/nemo_ctc
  "files": { "tokens": "tokens.txt", "encoder": "encoder.onnx", "decoder": "decoder.onnx", "joiner": "joiner.onnx" },
  "options": {
    "modelingUnit": "cjkchar",        // 流式：cjkchar | bpe
    "language": "zh",                 // 定稿
    "sherpa": { /* 透传识别器配置 */ }
  },
  "download": [ … ]
}
```

## 3. 模型下载器

- 入口：`POST /voice-local/models/fetch`，body `{kind:'tts'|'asr', id, role?}`。
- 服务端按 `download` 清单逐文件下载：先写 `<file>.part`，校验 `sha256`（若提供）后原子改名；
  `bytes` 仅用于进度显示。
- 进度通过 `GET /voice-local/stream` 的 `model` 事件推送（`{phase:'start'|'progress'|'done'|'error', …}`）。
- 缺少清单时报 400，并在模型下拉里显示「不可用」。

生成清单（本仓库自带脚本，零依赖）：

```bash
node scripts/model-manifest.mjs --dir path/to/model --base-url https://example.com/models/melo-zh
# 输出可直接粘进 model.json 的 download 数组；--out 可写入文件
```

## 4. 发到哪里

| 方案 | 单文件上限 | 优点 | 注意 |
|---|---|---|---|
| **ModelScope** | 大文件友好 | 国内快、有模型卡 | 需账号；README 写许可 |
| **Hugging Face Hub** | 大文件友好 | 生态成熟、有模型卡 | 国内访问慢，建议镜像 |
| **GitHub Releases** | 2 GiB / 文件 | 与仓库一体、免费 | 国内下载慢；资产不进 git |

**不要**用 Git LFS 存模型：免费额度只有 10 GiB 存储 + 10 GiB/月带宽，且计入仓库。

推荐：ModelScope 主源 + HF 镜像 + GitHub Release 作第三源；`download` 清单按顺序给多个 URL
（插件会按顺序尝试），每个 URL 都配同一份 `sha256`。

### 发布示例模型（以作者自训 `tl196m` 为例）

1. 归档：`tar -czf tl196m-v1.tar.gz -C path/to/tl196m .`（Windows 可用 `tar`）。
2. 校验：

   ```powershell
   Get-FileHash .\tl196m-v1.tar.gz -Algorithm SHA256
   ```

3. 在 ModelScope / HF 建模型仓，上传归档 + `LICENSE` + `README.md`（模型卡写明
   `license`、`language`、`base_model`、训练数据与用途限制）。
4. 在 GH Release 附同一归档（<2 GiB），并把三个下载地址写进示例 `model.json`。
5. 把 `model.json` 放进插件的示例模型目录，或直接发给用户手动放置。
6. 更新 `THIRD_PARTY_NOTICES.md` 的模型许可表。

## 5. 许可速查

| 模型 | 许可 | 可否再分发 |
|---|---|---|
| MeloTTS（代码 + 权重） | MIT | 可以，保留版权与许可全文 |
| sherpa-onnx 官方模型 | Apache-2.0 | 可以，保留 NOTICE |
| SenseVoice 权重 | FunASR Model License 1.1 | 可以，但必须署名、保留模型名 |
| 作者自训 tl196m | 由作者在模型仓声明 | 以模型仓 LICENSE 为准 |

不确定时：只提供**下载地址**、不把权重放进本仓库，是最安全的做法。