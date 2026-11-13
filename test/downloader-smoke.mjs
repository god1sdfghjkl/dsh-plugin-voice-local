/**
 * 模型下载器单测（本地 HTTP 服务器，不需要真模型/外网）。
 *
 *   node test/downloader-smoke.mjs
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  downloadProfileFiles,
  missingFiles,
  downloadSummary,
  sha256File,
} from '../lib/models/downloader.js'

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label, extra === undefined ? '' : extra) }
}

const root = mkdtempSync(join(tmpdir(), 'voice-dl-'))
const serveDir = join(root, 'serve')
const modelDir = join(root, 'model')
mkdirSync(serveDir, { recursive: true })
mkdirSync(modelDir, { recursive: true })

const fileA = Buffer.from('A'.repeat(1024) + 'hello-model-a')
const fileB = Buffer.from('B'.repeat(2048) + 'tokens-here')
const bad = Buffer.from('CORRUPTED-DATA')
writeFileSync(join(serveDir, 'model.onnx'), fileA)
writeFileSync(join(serveDir, 'tokens.txt'), fileB)
writeFileSync(join(serveDir, 'bad.onnx'), bad)

const shaA = createHash('sha256').update(fileA).digest('hex')
const shaB = createHash('sha256').update(fileB).digest('hex')
const shaWrong = createHash('sha256').update('something-else').digest('hex')

const server = createServer((req, res) => {
  const name = req.url.replace(/^\/+/, '').split('?')[0]
  try {
    const body = readFileSync(join(serveDir, name))
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 1. 下载两个文件 + 进度事件 ==')
  const progress = []
  const profile = {
    id: 'demo', role: 'tts', dir: modelDir,
    download: [
      { url: `${base}/model.onnx`, path: 'model.onnx', sha256: shaA, bytes: fileA.length },
      { url: `${base}/tokens.txt`, path: 'sub/tokens.txt', sha256: shaB, bytes: fileB.length },
    ],
  }
  const summaryBefore = downloadSummary(profile)
  ok(summaryBefore && summaryBefore.missing === 2, '下载前 missing=2', summaryBefore)
  const missingBefore = await missingFiles(profile)
  ok(missingBefore.length === 2, 'missingFiles 返回 2', missingBefore.length)

  const r1 = await downloadProfileFiles(profile, { onProgress: (p) => progress.push(p) })
  ok(r1.downloaded === 2 && r1.skipped === 0, '下载 2 个文件', r1)
  ok(readFileSync(join(modelDir, 'model.onnx')).equals(fileA), 'model.onnx 内容正确')
  ok(readFileSync(join(modelDir, 'sub/tokens.txt')).equals(fileB), '子目录 tokens.txt 内容正确')
  ok((await sha256File(join(modelDir, 'model.onnx'))) === shaA, 'sha256 校验通过')
  ok(progress.some((p) => p.phase === 'download' && p.received > 0), '有 download 进度事件')
  ok(progress.some((p) => p.phase === 'done'), '有 done 事件')
  const summaryAfter = downloadSummary(profile)
  ok(summaryAfter && summaryAfter.missing === 0, '下载后 missing=0', summaryAfter)
  ok((await missingFiles(profile)).length === 0, 'missingFiles 为空')

  console.log('== 2. 已存在且校验通过 → 跳过 ==')
  const r2 = await downloadProfileFiles(profile)
  ok(r2.downloaded === 0 && r2.skipped === 2, '第二次全部跳过', r2)

  console.log('== 3. force 强制重下 ==')
  const r3 = await downloadProfileFiles(profile, { force: true })
  ok(r3.downloaded === 2, 'force 重新下载 2 个', r3)

  console.log('== 4. 文件被改坏 → 重新下载修复 ==')
  writeFileSync(join(modelDir, 'model.onnx'), 'broken')
  ok((await missingFiles(profile)).length === 1, '坏文件被识别为缺失')
  const r4 = await downloadProfileFiles(profile)
  ok(r4.downloaded === 1 && r4.skipped === 1, '只修 1 个文件', r4)
  ok(readFileSync(join(modelDir, 'model.onnx')).equals(fileA), '修复后内容正确')

  console.log('== 5. sha256 不匹配 → 报错且不留残file ==')
  const badProfile = {
    id: 'bad', dir: join(modelDir, 'bad'), download: [
      { url: `${base}/bad.onnx`, path: 'bad.onnx', sha256: shaWrong, bytes: bad.length },
    ],
  }
  let err = null
  try { await downloadProfileFiles(badProfile) } catch (e) { err = e }
  ok(err && /校验失败/.test(err.message), '抛校验失败', err && err.message)
  ok(!existsSync(join(modelDir, 'bad', 'bad.onnx')), '不留下错误目标文件')
  ok(!existsSync(join(modelDir, 'bad', 'bad.onnx.part')), '不留下 .part 文件')

  console.log('== 6. HTTP 404 / 无清单 ==')
  const noFileProfile = { id: 'nf', dir: join(modelDir, 'nf'), download: [{ url: `${base}/nope.bin`, path: 'nope.bin' }] }
  let err2 = null
  try { await downloadProfileFiles(noFileProfile) } catch (e) { err2 = e }
  ok(err2 && /HTTP 404/.test(err2.message), 'HTTP 404 报错', err2 && err2.message)
  let err3 = null
  try { await downloadProfileFiles({ id: 'empty', dir: modelDir }) } catch (e) { err3 = e }
  ok(err3 && /没有下载清单/.test(err3.message), '无 download 字段报错', err3 && err3.message)
  ok((await missingFiles({ id: 'empty', dir: modelDir })).length === 0, 'missingFiles 无清单返回空')
  ok(downloadSummary({ id: 'empty', dir: modelDir }) === null, 'downloadSummary 无清单返回 null')

  console.log('== 7. 目录不存在会自动创建 ==')
  const autoDir = join(modelDir, 'auto', 'deep')
  const r7 = await downloadProfileFiles({
    id: 'auto', dir: autoDir,
    download: [{ url: `${base}/tokens.txt`, path: 'tokens.txt', sha256: shaB, bytes: fileB.length }],
  })
  ok(r7.downloaded === 1 && existsSync(join(autoDir, 'tokens.txt')), '自动创建目录并下载', readdirSync(autoDir))

  console.log('== 8. 分段下载 + 拼接 + 整文件校验 ==')
  const bigA = Buffer.from('P0'.repeat(100000))
  const bigB = Buffer.from('P1'.repeat(120000))
  writeFileSync(join(serveDir, 'big.part0'), bigA)
  writeFileSync(join(serveDir, 'big.part1'), bigB)
  const combined = Buffer.concat([bigA, bigB])
  const shaPartA = createHash('sha256').update(bigA).digest('hex')
  const shaPartB = createHash('sha256').update(bigB).digest('hex')
  const shaWhole = createHash('sha256').update(combined).digest('hex')
  const partProfile = {
    id: 'parts', dir: join(modelDir, 'parts'),
    download: [{
      path: 'big/model.onnx', sha256: shaWhole, bytes: combined.length,
      parts: [
        { url: `${base}/big.part0`, sha256: shaPartA, bytes: bigA.length },
        { url: `${base}/big.part1`, sha256: shaPartB, bytes: bigB.length },
      ],
    }],
  }
  const summaryParts = downloadSummary(partProfile)
  ok(summaryParts && summaryParts.missing === 1 && summaryParts.bytes === combined.length, '分段清单统计 bytes/missing', summaryParts)
  const progressParts = []
  const r8 = await downloadProfileFiles(partProfile, { onProgress: (p) => progressParts.push(p) })
  const merged = join(modelDir, 'parts', 'big', 'model.onnx')
  ok(r8.downloaded === 1, '分段下载完成', r8)
  ok(readFileSync(merged).equals(combined), '拼接后内容正确')
  ok((await sha256File(merged)) === shaWhole, '拼接后整文件 sha256 正确')
  ok((await missingFiles(partProfile)).length === 0, 'missingFiles 为空')
  ok(!existsSync(merged + '.part'), '不留整文件 .part')
  ok(readdirSync(join(modelDir, 'parts', 'big')).filter((n) => n.indexOf('.part-') >= 0).length === 0, '不留分段临时文件')
  ok(progressParts.some((p) => p.phase === 'part-done') && progressParts.some((p) => p.phase === 'done'), '有分段进度事件')

  console.log('== 9. 分段 sha 不符 → 报错且不留残file ==')
  const badPartProfile = {
    id: 'parts-bad', dir: join(modelDir, 'parts-bad'),
    download: [{
      path: 'model.onnx', sha256: shaWhole, bytes: combined.length,
      parts: [
        { url: `${base}/big.part0`, sha256: shaWrong, bytes: bigA.length },
        { url: `${base}/big.part1`, sha256: shaPartB, bytes: bigB.length },
      ],
    }],
  }
  let errParts = null
  try { await downloadProfileFiles(badPartProfile) } catch (e) { errParts = e }
  ok(errParts && /段校验失败/.test(errParts.message), '分段校验失败报错', errParts && errParts.message)
  ok(!existsSync(join(modelDir, 'parts-bad', 'model.onnx')), '不留下目标文件')
  ok(readdirSync(join(modelDir, 'parts-bad')).length === 0, '不留下任何临时文件')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
