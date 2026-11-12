# 示例模型：MeloTTS 中文

这个目录只放**元数据**（`model.json` + 校验和），权重放在 GitHub Release，不进入 git。

## 安装

1. 打开通话界面的「模型」下拉，找到「MeloTTS 中文（示例）」，点「可下载 xxx MB」。
2. 或手动下载 Release 资产，放到：

   ```text
   $DSH_HOME/voice-local/models/tts/melo-zh/
   ├── model.onnx
   ├── tokens.txt
   ├── lexicon.txt
   └── model.json
   ```

3. 刷新页面，在模型下拉里选中它即可（热切换，无需重启宿主）。

## 校验

```powershell
# Windows
Get-FileHash .\model.onnx -Algorithm SHA256
# macOS / Linux
sha256sum -c checksums.txt
```

## 许可与出处

- MeloTTS 代码与权重：MIT（MyShell.ai）。权重来自 sherpa-onnx 的 VITS 转换：
  https://huggingface.co/csukuangfj/vits-melo-tts-zh_en
- 再分发时请保留 MIT 许可全文与版权声明；本插件只做推理封装，不修改权重。

## 发布者：如何更新 Release 资产

```bash
gh release create models-v1 \
  path/to/model.onnx path/to/tokens.txt path/to/lexicon.txt \
  --title "示例模型 MeloTTS 中文" --notes-file examples/models/melo-zh/README.md
# 已存在则：
gh release upload models-v1 path/to/model.onnx path/to/tokens.txt path/to/lexicon.txt --clobber
```

资产 URL 形如：
`https://github.com/<owner>/<repo>/releases/download/models-v1/model.onnx`

如果仓库名/标签变化，用脚本重新生成清单：

```bash
node scripts/model-manifest.mjs --dir path/to/melo-zh \
  --base-url https://github.com/<owner>/<repo>/releases/download/models-v1
```

把输出替换到本目录 `model.json` 的 `download` 字段即可。