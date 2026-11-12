/**
 * ASR 冒烟测试（不依赖 DSH）：验证 sherpa-onnx 2.0.1 迁移后的
 * 流式 zipformer + SenseVoice 定稿整条链路。
 *
 *   node test/asr-smoke.mjs
 *
 * 用 sherpa 自带的 0.wav（16k 单声道）回放。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VoiceEngine } from '../lib/engine-manager.js'
import { legacyAsrProfiles } from '../lib/models/asr-registry.js'

// 仓库默认布局（voice-assistant/models/...）；开源用户可用环境变量指向自己的模型。
const ROOT = process.env.VOICE_SAMPLE_ROOT
  || fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '')
const STREAM_DIR = process.env.VOICE_ASR_DIR || `${ROOT}/models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`
const SENSE_DIR = process.env.VOICE_SENSEVOICE_DIR || `${ROOT}/xiaozhi/main/xiaozhi-server/models/sensevoice`

if (!existsSync(`${STREAM_DIR}/test_wavs/0.wav`) || !existsSync(SENSE_DIR)) {
  console.log('跳过 ASR 冒烟：未找到示例模型。设置 VOICE_ASR_DIR / VOICE_SENSEVOICE_DIR 后重跑。')
  console.log(`  流式目录：${STREAM_DIR}`)
  console.log(`  定稿目录：${SENSE_DIR}`)
  process.exit(0)
}

function readWav(p) {
  const buf = readFileSync(p)
  let off = 12
  let sr = 16000
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') sr = buf.readUInt32LE(off + 12)
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break }
    off += 8 + size
  }
  if (!data) throw new Error('no data chunk')
  const i16 = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
  return { sr, pcm: f32 }
}

let failures = 0
function ok(cond, label, extra) {
  if (cond) { console.log(`  ✓ ${label}`) } else { failures++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { sr, pcm } = readWav(`${STREAM_DIR}/test_wavs/0.wav`)
  console.log(`wav sr=${sr} samples=${pcm.length}`)

  const legacy = legacyAsrProfiles({ streamingDir: STREAM_DIR, finalDir: SENSE_DIR })
  const engine = new VoiceEngine({
    asrStreamingProfile: legacy.find((p) => p.role === 'streaming'),
    asrFinalProfile: legacy.find((p) => p.role === 'final'),
  })
  const problems = engine.checkModels().filter((p) => p.indexOf('TTS') !== 0)
  ok(problems.length === 0, 'ASR 模型文件齐全（TTS 可选）', problems)

  const t0 = Date.now()
  const st = await engine.start()
  ok(st.asrReady === true, `ASR 加载成功（${Date.now() - t0}ms）`, st.lastError)

  const partials = []
  let finalText = null
  let endpoint = false
  engine.onAsr((m) => {
    if (m.type === 'partial') partials.push(m.text)
    else if (m.type === 'final') finalText = m.text
    else if (m.type === 'endpoint') endpoint = true
    else if (m.type === 'warn' || m.type === 'error') console.log('  [asr]', m.type, m.message)
  })

  engine.asrStart()
  const CHUNK = 1600 // 100ms @16k
  for (let i = 0; i < pcm.length; i += CHUNK) {
    engine.asrFeed(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)))
    if ((i / CHUNK) % 5 === 0) await sleep(15)
  }
  engine.asrFinal()
  for (let i = 0; i < 40 && finalText === null; i++) await sleep(100)

  ok(partials.length > 0, `流式部分结果到达（${partials.length} 条）`)
  if (partials.length) console.log('    最后一次 partial:', partials[partials.length - 1])
  ok(typeof finalText === 'string' && finalText.length > 0, '定稿文本非空', finalText)
  if (finalText) console.log('    final:', finalText)
  ok(/介绍|研究|兴趣/.test(finalText || ''), '定稿内容命中测试语音关键词', finalText)

  await engine.disposeAsync()
  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1) })
