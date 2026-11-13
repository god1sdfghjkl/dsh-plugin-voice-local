/**
 * 内置示例模型清单（只含 model.json 元数据，权重按需下载）。
 *
 * 包内 `examples/models/<id>/model.json` 提供 id / engine / files / download，
 * 这里把它们归一化成目标目录（<modelsDir>/<id>）的 profile：文件还没下载时
 * ok=false 且带 download 摘要，界面会显示「可下载」；下载完再扫描就是正常模型。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeTtsProfile, readJsonFile } from './tts-registry.js'

/**
 * @param {{ examplesDir?: string, modelsDir: string }} opts
 * @returns {Array} 归一化后的 TTS profile（带 example=true）
 */
export function loadExampleTtsProfiles({ examplesDir, modelsDir }) {
  const list = []
  if (!examplesDir || !modelsDir) return list
  let entries = []
  try { entries = readdirSync(examplesDir) } catch { return list }
  for (const name of entries) {
    const sub = join(examplesDir, name)
    try { if (!statSync(sub).isDirectory()) continue } catch { continue }
    const meta = readJsonFile(join(sub, 'model.json'))
    if (!meta || !meta.id) continue
    const hasDownload = Array.isArray(meta.download) && meta.download.length > 0
    const targetDir = join(modelsDir, meta.id)
    const profile = normalizeTtsProfile({ ...meta, id: meta.id }, targetDir)
    profile.example = true
    profile.hasDownloadManifest = hasDownload
    list.push(profile)
  }
  return list
}