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
 * 大文件 / 网络不稳时可以把一个文件拆成多段（并行下载、逐段校验、拼接后校验整文件）：
 *
 *   {
 *     "download": [{
 *       "path": "model.onnx", "sha256": "<整文件 sha>", "bytes": 168994224,
 *       "parts": [
 *         { "url": "https://.../model.onnx.part0", "sha256": "<段 sha>", "bytes": 20971520 },
 *         { "url": "https://.../model.onnx.part1", "sha256": "<段 sha>", "bytes": 20971520 }
 *       ]
 *     }]
 *   }
 *
 * 行为：
 *   - 已存在且 sha256 匹配 → 跳过（不重复下载）
 *   - 先写 <file>.part，校验通过再原子改名；校验失败删除，不留半截文件
 *   - onProgress({ phase, file, received, total, bytes }) 供 SSE/日志上报
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function sha256File(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c))
    rs.on('error', reject)
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 清单里某一条的总字节数（优先 bytes，其次各段之和） */
function itemBytes(item) {
  const explicit = Number(item?.bytes || 0)
  if (explicit > 0) return explicit
  if (Array.isArray(item?.parts)) return item.parts.reduce((n, p) => n + Number(p?.bytes || 0), 0)
  return 0
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
    if (!ok) { missing++; bytes += itemBytes(item) }
  }
  return { count: items.length, missing, bytes, ready: missing === 0 }
}

/** 把一个 URL 流式写入 target，返回 { bytes, sha }；不在这里校验，由调用方决定 */
async function fetchTo(url, target, onChunk, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'follow' })
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'unknown'}`)
  if (!res.body) throw new Error('响应没有 body')
  const hash = createHash('sha256')
  let received = 0
  const nodeStream = Readable.fromWeb(res.body)
  nodeStream.on('data', (chunk) => {
    received += chunk.length
    hash.update(chunk)
    if (onChunk) onChunk(chunk.length)
  })
  await pipeline(nodeStream, createWriteStream(target))
  return { bytes: received, sha: hash.digest('hex') }
}

/** 顺序拼接多个已下载分段到 dest，同时算整文件 sha；失败不留残file */
async function mergeParts(parts, dest, expected) {
  const ws = createWriteStream(dest)
  const hash = createHash('sha256')
  try {
    for (const p of parts) {
      const rs = createReadStream(p)
      for await (const chunk of rs) {
        hash.update(chunk)
        if (!ws.write(chunk)) await once(ws, 'drain')
      }
    }
    ws.end()
    await once(ws, 'finish')
    const got = hash.digest('hex')
    if (expected && got !== expected) {
      rmSync(dest, { force: true })
      throw new Error(`拼接后校验失败：sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
    }
    return got
  } catch (e) {
    try { ws.destroy() } catch { /* ignore */ }
    rmSync(dest, { force: true })
    throw e
  }
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
      const total = itemBytes(item)

      if (!opts.force && existsSync(dest)) {
        if (!expected) {
          skipped++
          onProgress({ phase: 'skip', file: rel, bytes: total })
          files.push({ file: rel, skipped: true })
          continue
        }
        const existing = await sha256File(dest).catch(() => '')
        if (existing === expected) {
          skipped++
          onProgress({ phase: 'skip', file: rel, bytes: total })
          files.push({ file: rel, skipped: true })
          continue
        }
      }

      const tmp = dest + '.part'
      const parts = Array.isArray(item.parts) ? item.parts.filter((p) => p && p.url) : null
      onProgress({ phase: 'start', file: rel, total })

      if (parts && parts.length) {
        const partPaths = new Array(parts.length)
        let received = 0
        let nextPart = 0
        const partConcurrency = Math.max(1, Math.min(3, parts.length))
        const runPart = async (i) => {
          const part = parts[i]
          const partPath = `${dest}.part-${i}`
          rmSync(partPath, { force: true })
          partPaths[i] = partPath
          onProgress({ phase: 'part', file: rel, part: i, parts: parts.length, received, total })
          let got
          try {
            got = await fetchTo(part.url, partPath, (n) => {
              received += n
              onProgress({ phase: 'download', file: rel, part: i, received, total })
            }, fetchImpl)
          } catch (e) {
            throw new Error(`下载 ${rel} 第 ${i + 1}/${parts.length} 段失败：${e?.message || e}`)
          }
          if (part.sha256 && got.sha !== String(part.sha256).toLowerCase()) {
            throw new Error(`第 ${i + 1}/${parts.length} 段校验失败：sha256 不匹配`)
          }
          if (part.bytes && got.bytes !== Number(part.bytes)) {
            throw new Error(`第 ${i + 1}/${parts.length} 段大小不符：期望 ${part.bytes}，实际 ${got.bytes}`)
          }
          onProgress({ phase: 'part-done', file: rel, part: i, parts: parts.length, received, total })
        }
        const worker = async () => {
          while (nextPart < parts.length) {
            const i = nextPart
            nextPart += 1
            await runPart(i)
          }
        }
        const settled = await Promise.allSettled(Array.from({ length: partConcurrency }, worker))
        const hitError = settled.find((r) => r.status === 'rejected')
        if (hitError) {
          rmSync(tmp, { force: true })
          for (const p of partPaths) if (p) rmSync(p, { force: true })
          throw hitError.reason
        }
        try {
          await mergeParts(partPaths, tmp, expected)
        } catch (e) {
          rmSync(tmp, { force: true })
          throw e
        } finally {
          for (const p of partPaths) if (p) rmSync(p, { force: true })
        }
        renameSync(tmp, dest)
        downloaded++
        onProgress({ phase: 'done', file: rel, bytes: received, total })
        files.push({ file: rel, bytes: received, parts: parts.length })
        continue
      }

      let received = 0
      try {
        const got = await fetchTo(item.url, tmp, (n) => {
          received += n
          onProgress({ phase: 'download', file: rel, received, total })
        }, fetchImpl)
        if (expected && got.sha !== expected) {
          throw new Error(`校验失败 ${rel}：sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${got.sha.slice(0, 12)}…）`)
        }
      } catch (e) {
        rmSync(tmp, { force: true })
        throw e
      }
      renameSync(tmp, dest)
      downloaded++
      onProgress({ phase: 'done', file: rel, bytes: received, total })
      files.push({ file: rel, bytes: received })
  }

  return { files, skipped, downloaded }
}