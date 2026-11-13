# 模型格式转换实验（tl196m → int8）

## 结果

用 `onnxruntime.quantization.quantize_dynamic` 把 TTS 模型转成 int8：

| | fp32 原模型 | int8 转换后 |
|---|---|---|
| 文件大小 | 168.99 MB | **54.1 MB**（约 1/3） |
| onnxruntime 加载 | 6.1 s | 12.9 s |
| 合成同一句（约 2.8 s 音频） | **1.17 s** | **8.05 s** |
| 输出 | 正常 | 正常，无 NaN/削波，峰值/RMS 接近 |

结论：

- **省空间明显**，适合手机存储/下载；
- **桌面 CPU 上反而慢 6–7 倍**，因为动态量化在 CPU 上要反复反量化；
- 想靠 int8 提速，需要 **Android NNAPI / GPU / 专用 int8 推理**，浏览器 WASM 不一定快；
- 格式转换本身不会产生手机端运行环境，只改变模型文件。

## 复现脚本

```python
# pip install onnx onnxruntime
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(
    "model.onnx",
    "model.int8.onnx",
    weight_type=QuantType.QInt8,
)
```

把 `model.int8.onnx` 放回模型目录并在 `model.json` 里把 `files.model` 指过去即可，
其余 `config.json` / 采样参数不变。目录约定见 [docs/models.md](models.md)。

## 对手机方案的意义

手机端模型体积可以降到约：

| 部件 | 大小 |
|---|---|
| ASR streaming（自带 int8） | 25 MB |
| TTS tl196m int8 | 54 MB |
| 声纹 CAM++ | 28 MB |
| 合计 | **约 107 MB** |

但“能跑”仍取决于运行时：

- 浏览器：onnxruntime-web / sherpa wasm，int8 算子支持要逐模型验证；
- Android 原生：onnxruntime-android + NNAPI 才能真正吃到 int8 的速度；
- DSH 插件（Node host）里用 int8 只会更慢，不建议替换默认 fp32。

所以转换是“减体积”的手段，不是“让 dshgo App 长出推理引擎”的手段。