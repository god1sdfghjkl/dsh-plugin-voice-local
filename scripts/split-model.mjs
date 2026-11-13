#!/usr/bin/env node
/**
 * 把一个大模型文件切成固定大小的分段，并生成 model.json 的 `download[].parts` 清单。
 *
 *   node scripts/split-model.mjs --file model.onnx --chunk-mb 16 \
 *     --out-dir dist/parts --base-url https://github.com/<owner>/<repo>/releases/download/models-v1
 *
 * 输出：
 *   <out-dir>/model.onnx.part00 …  （每个分段）
 *   段 sha256 / 整文件 sha256 的清单 JSON（stdout，或 --out 写文件）
 *
 * 用途：GitHub Release 单文件上限 2GiB、国内长连接易断；拆段后并行上传/下载、逐段校验、
 * 由插件下载器拼接（见 lib/models/downloader.js 的 download[].parts）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--file') out.file = argv[++i]
    else if (a === '--out-dir') out.outDir = argv[++i]
    else if (a === '--base-url') out.baseUrl = argv[++i]
    else if (a === '--chunk-mb') out.chunkMb = Number(argv[++i])
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error('未知参数：' + a)
  }
  return out
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const rs = createReadStream(file)
    rs.on('data', (c) => h.update(c))
    rs.on('error', reject)
    rs.on('end', () => resolve(h.digest('hex')))
  })
}

async function split(file, outDir, chunkBytes, baseUrl) {
  mkdirSync(outDir, { recursive: true })
  const name = basename(file)
  const total = statSync(file).size
  const count = Math.ceil(total / chunkBytes)
  const pad = String(count - 1).length
  const rs = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
  const parts = []
  let idx = 0
  let written = 0
  let ws = createWriteStream(join(outDir, `${name}.part${String(idx).padStart(pad, '0')}`))
  for await (const chunk of rs) {
    let offset = 0
    while (offset < chunk.length) {
      const room = chunkBytes - written
      const take = Math.min(room, chunk.length - offset)
      const piece = chunk.subarray(offset, offset + take)
      if (!ws.write(piece)) await new Promise((resolve) => ws.once('drain', resolve))
      offset += take
      written += take
      if (written === chunkBytes && idx < count - 1) {
        ws.end()
        await new Promise((resolve) => ws.once('close', resolve))
        parts.push({ part: idx, file: `${name}.part${String(idx).padStart(pad, '0')}`, sha256: await sha256File(join(outDir, `${name}.part${String(idx).padStart(pad, '0')}`)), bytes: written })
        idx += 1
        written = 0
        ws = createWriteStream(join(outDir, `${name}.part${String(idx).padStart(pad, '0')}`))
      }
    }
  }
  ws.end()
  await new Promise((resolve) => ws.once('close', resolve))
  const lastFile = `${name}.part${String(idx).padStart(pad, '0')}`
  parts.push({ part: idx, file: lastFile, sha256: await sha256File(join(outDir, lastFile)), bytes: written })
  const whole = await sha256File(file)
  const manifest = {
    path: name,
    sha256: whole,
    bytes: total,
    parts: parts.map((p) => ({
      url: `${baseUrl.replace(/\/$/, '')}/${p.file}`,
      sha256: p.sha256,
      bytes: p.bytes,
    })),
  }
  return { manifest, parts }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file || !args.outDir || !args.baseUrl) {
    console.log('用法：node scripts/split-model.mjs --file <大文件> --out-dir <分段目录> --base-url <下载根地址> [--chunk-mb 16] [--out manifest.json]')
    process.exit(args.help ? 0 : 1)
  }
  const chunkMb = args.chunkMb > 0 ? args.chunkMb : 16
  const chunkBytes = Math.floor(chunkMb * 1024 * 1024)
  const { manifest } = await split(args.file, args.outDir, chunkBytes, args.baseUrl)
  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (args.out) {
    writeFileSync(args.out, json, 'utf8')
    console.log(`已写入 ${args.out}（${manifest.parts.length} 段，${manifest.bytes} 字节）`)
  } else {
    process.stdout.write(json)
  }
}

main()