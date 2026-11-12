#!/usr/bin/env node
/**
 * 生成 model.json 的 download 清单（零依赖）。
 *
 *   node scripts/model-manifest.mjs --dir path/to/model --base-url https://example.com/models/melo-zh
 *   node scripts/model-manifest.mjs --dir path/to/model --base-url … --out download.json
 *
 * 输出形如：
 *   [
 *     { "url": "https://…/model.onnx", "path": "model.onnx", "sha256": "…", "bytes": 169000000 }
 *   ]
 *
 * 说明：
 *   - 跳过 model.json 自身与隐藏文件；
 *   - path 使用相对模型目录的 POSIX 路径，下载器会拒绝 `..` 与绝对路径；
 *   - 大于 2 GiB 的文件请勿直接放 GitHub Release（单文件上限 2 GiB）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--base-url') out.baseUrl = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error('未知参数：' + a)
  }
  return out
}

function walk(dir, base, acc) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, base, acc)
    else if (st.isFile() && name !== 'model.json') acc.push(abs)
  }
  return acc
}

function sha256File(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.dir || !args.baseUrl) {
    console.log('用法：node scripts/model-manifest.mjs --dir <模型目录> --base-url <下载根地址> [--out <文件>]')
    process.exit(args.help ? 0 : 1)
  }
  const base = args.baseUrl.replace(/\/$/, '')
  const files = walk(args.dir, args.dir, [])
  if (!files.length) throw new Error('目录里没有可打包的文件：' + args.dir)
  const manifest = files.map((abs) => {
    const rel = relative(args.dir, abs).split(sep).join('/')
    const url = base + '/' + rel.split('/').map(encodeURIComponent).join('/')
    const st = statSync(abs)
    return { url, path: rel, sha256: sha256File(abs), bytes: st.size }
  })
  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (args.out) {
    writeFileSync(args.out, json, 'utf8')
    console.log(`已写入 ${args.out}（${manifest.length} 个文件，${manifest.reduce((n, f) => n + f.bytes, 0)} 字节）`)
  } else {
    process.stdout.write(json)
  }
}

main()