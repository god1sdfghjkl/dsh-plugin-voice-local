/**
 * 模型文件下载器（宿主侧，零依赖）。
 *
 * 模型目录里的 model.json 可以带一份下载清单，缺文件时由插件直接拉：
 *
 *   {
 *     "download": [
 *       { "url": "https://.../encoder.onnx", "path": "encoder.onnx", "sha256": "…", "bytes": 123 },
 *       { "url": "https://.../tokens.txt",   "path": "tokens.txt",  "sha256": "…", "bytes": 456 }
 *     ]
 *   }
 *
 * 行为：
 *   - 已存在且 sha256 匹配 → 跳过（不重复下载）
 *   - 先写 <file>.part，校验通过再原子改名；校验失败删除，不留半截文件
 *   - onProgress({ phase, file, received, total, bytes }) 供 SSE/日志上报
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const CHUNK = 1 << 20

export async function sha256File(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c))
    rs.on('error', reject)
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 缺哪些文件（按 sha256 判断；没有 sha256 时只看存在性） */
export async function missingFiles(profile) {
  const items = Array.isArray(profile?.download) ? profile.download : []
  const missing = []
  for (const item of items) {
    const rel = item.path || item.file
    if (!rel) continue
    const dest = join(profile.dir || '.', rel)
    if (!existsSync(dest)) { missing.push(item); continue }
    if (!item.sha256) continue
    try {
      const h = await sha256File(dest)
      if (h !== String(item.sha256).toLowerCase()) missing.push(item)
    } catch { missing.push(item) }
  }
  return missing
}

/** 下载清单概览（给 /models 接口用，不读文件内容，只统计存在性/大小） */
export function downloadSummary(profile) {
  const items = Array.isArray(profile?.download) ? profile.download : []
  if (!items.length) return null
  let bytes = 0
  let missing = 0
  for (const item of items) {
    const rel = item.path || item.file
    if (!rel) continue
    const dest = join(profile.dir || '.', rel)
    let ok = false
    try { ok = existsSync(dest) && (!item.bytes || statSync(dest).size === Number(item.bytes)) } catch { ok = false }
    if (!ok) { missing++; bytes += Number(item.bytes || 0) }
  }
  return { count: items.length, missing, bytes, ready: missing === 0 }
}

/**
 * 下载一个模型缺的文件。
 * @param {object} profile 注册表 profile（含 download 数组）
 * @param {{ onProgress?: Function, force?: boolean, fetchImpl?: Function }} [opts]
 * @returns {Promise<{files: Array, skipped: number, downloaded: number}>}
 */
export async function downloadProfileFiles(profile, opts = {}) {
  const items = Array.isArray(profile?.download) ? profile.download : []
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (!items.length) throw new Error('该模型没有下载清单（model.json 缺少 download 字段）')
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch，无法下载')

  const dir = profile.dir || ''
  if (!dir) throw new Error('模型没有目录')
  mkdirSync(dir, { recursive: true })

  const files = []
  let skipped = 0
  let downloaded = 0

  for (const item of items) {
    const rel = String(item.path || item.file || '').replace(/^[/\\]+/, '')
    if (!rel) continue
    const dest = join(dir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    const expected = item.sha256 ? String(item.sha256).toLowerCase() : ''

    if (!opts.force && existsSync(dest)) {
      if (!expected) {
        skipped++
        onProgress({ phase: 'skip', file: rel, bytes: Number(item.bytes || 0) })
        files.push({ file: rel, skipped: true })
        continue
      }
      const existing = await sha256File(dest).catch(() => '')
      if (existing === expected) {
        skipped++
        onProgress({ phase: 'skip', file: rel, bytes: Number(item.bytes || 0) })
        files.push({ file: rel, skipped: true })
        continue
      }
    }

    const tmp = dest + '.part'
    onProgress({ phase: 'start', file: rel, total: Number(item.bytes || 0) })
    let res
    try {
      res = await fetchImpl(item.url, { redirect: 'follow' })
    } catch (e) {
      throw new Error(`下载 ${rel} 失败：${e?.message || e}`)
    }
    if (!res || !res.ok) throw new Error(`下载 ${rel} 失败：HTTP ${res ? res.status : 'unknown'}`)
    if (!res.body) throw new Error(`下载 ${rel} 失败：响应没有 body`)

    const total = Number(item.bytes || res.headers.get('content-length') || 0)
    let received = 0
    const hash = createHash('sha256')
    const nodeStream = Readable.fromWeb(res.body)
    nodeStream.on('data', (chunk) => {
      received += chunk.length
      hash.update(chunk)
      onProgress({ phase: 'download', file: rel, received, total })
    })
    try {
      await pipeline(nodeStream, createWriteStream(tmp))
      const got = hash.digest('hex')
      if (expected && got !== expected) {
        rmSync(tmp, { force: true })
        throw new Error(`校验失败 ${rel}：sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
      }
      renameSync(tmp, dest)
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      throw e
    }
    downloaded++
    onProgress({ phase: 'done', file: rel, bytes: received, total })
    files.push({ file: rel, bytes: received })
  }

  return { files, skipped, downloaded }
}
