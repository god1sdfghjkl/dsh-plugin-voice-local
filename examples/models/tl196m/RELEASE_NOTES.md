# 示例音色 tl196m（VITS2 中文）

作者自训音色导出的 ONNX 权重，用于验证插件的 TTS 模型注册表 / 下载器 / 热切换。

## 资产

| 文件 | 大小 | SHA256 |
|---|---|---|
| `model.onnx.part00 … part09`（共 10 段） | 16,777,216 B / 段 | 见 `checksums.txt` |
| `model.onnx.part10` | 1,222,064 B | 见 `checksums.txt` |
| `model.onnx`（整文件 SHA，供拼接后校验） | 168,994,224 B | `f6fe57cd186b7db02d154432ab6dff5d069e4cc22be30566228ac239cd6387b1` |
| `config.json` | 2,784 B | `6f49b302805d4e2e86d43c72bc7393842c4a53f4550b9568190ed32051f34a38` |

- 采样率：44100 Hz，单声道，16-bit PCM（插件内部转 float32）
- 架构：VITS2（中文音素 + 声调），`vits2-onnx` 引擎
- 证据：本机 `/voice-local/speak` 实测 1.54s 音频、合成 738ms

## 安装

插件 **>= 0.8.3**：把 `examples/models/tl196m/model.json` 复制到
`$DSH_HOME/voice-local/models/tts/tl196m/model.json`，在模型下拉里点下载；
下载器会**并行拉取分段 → 逐段校验 → 拼接 → 整文件校验**。
也可手动下载全部分段，用 `cat` / `copy /b` 拼接成 `model.onnx`，再放 `config.json`。

## 许可

CC BY-NC-SA 4.0（署名 · 非商业 · 相同方式共享）。
全文：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode

## 使用边界

这是个人音色：禁止冒充他人、诈骗、伪造身份等用途；发布合成语音请标注「AI 合成」。
权利人如认为不应公开，请通过仓库 issue 联系下架。