# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.8.x | ✅ |
| < 0.8 | ❌（请升级） |

## Reporting a vulnerability

请**不要**在公开 issue 里贴利用细节。优先使用 GitHub 的
[Security Advisories](https://github.com/god1sdfghjkl/dsh-plugin-voice-local/security/advisories/new)
私下报告，或在仓库 issue 中先只说明「存在安全问题，希望私下联系」。

请附：DSH 版本、操作系统、复现步骤、影响（例如任意路径读取、跨源调用、模型下载校验绕过）。

## 安全边界（设计上已做）

- 所有语音路由只允许**回环地址**访问，并校验 `Origin`；跨源请求直接拒绝。
- 请求体大小有上限；PCM 只接受 16k 单声道 PCM16LE。
- 模型下载走 `.part` + 原子改名 + SHA256 校验；`download[].path` 限制在模型目录内。
- 静态资源路由只允许 `lib/assets/` 白名单内的相对路径，拒绝 `..` 穿越。
- 插件不读取 `.env`、不写系统目录、不把音频/文本发往外部服务。

如果你发现上述任一边界可被绕过，请按上面的方式报告。