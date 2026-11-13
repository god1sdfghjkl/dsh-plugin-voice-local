# 示例模型：tl196m（VITS2 中文）

作者自训 / 自用音色，已导出为 ONNX（VITS2 + 中文音素与声调前端，44.1kHz 单声道）。

- 权重文件：`model.onnx`（161.3 MiB），为便于上传/断点校验拆成 **11 个 16 MiB 分段**
  `model.onnx.part00 … model.onnx.part10`；插件下载器（**>= 0.8.3**）会逐段校验后拼接成完整文件。
- 配置：`config.json`（2.7 KiB）
- 推理引擎：`vits2-onnx`（插件内置适配器，输入 `x / x_lengths / tone / sid`）
- 采样：`sdp_ratio=0.2`、`noise_scale=0.6`、`noise_scale_w=0.8`，默认语速 1.0

## 安装

1. 复制本目录的 `model.json` 到：

   ```text
   $DSH_HOME/voice-local/models/tts/tl196m/model.json
   ```

2. 打开通话界面的「模型」下拉，选中「示例音色 tl196m」；缺文件时会显示「可下载 161MB」，
   点一下由插件下载（分段并行 + 逐段/整文件 SHA256 校验 + 自动拼接）。
3. 或从 Release 手动下载全部分段与 `config.json`，按顺序拼接：

   ```bash
   cat model.onnx.part0* > model.onnx          # macOS / Linux
   copy /b model.onnx.part00+model.onnx.part01+...+model.onnx.part10 model.onnx   # Windows
   ```

目录最终形态：

```text
$DSH_HOME/voice-local/models/tts/tl196m/
├── model.onnx
├── config.json
└── model.json
```

## 许可

**CC BY-NC-SA 4.0**（Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International）

- 必须署名：`tl196m · dsh-plugin-voice-local`
- 不得用于商业目的
- 修改/再分发需以相同许可共享
- 许可全文：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode
- 版权：Copyright (c) 2026 god1sdfghjkl（音色/录音权利由发布者确认）

## 使用边界（重要）

- 这是一个**个人音色**：请勿用于冒充他人、诈骗、伪造身份或其他违法用途。
- 不得将合成音频用于误导性内容；发布合成语音时请注明「AI 合成」。
- 如果你是权利人并认为该音色不应公开，请通过仓库 issue 联系下架。

## 备注

- 训练/导出脚本不在本仓库（训练框架为本机私有环境）；插件只负责推理。
- 如果你的机器内存较小，首次加载约 4.6s、单句合成约 0.7–1.5s（CPU，i7 级）。