/**
 * BreezeBlue 流式 TTS 适配 smoke test（不联网，假 fetch）。
 */
import assert from 'node:assert/strict'
import { BreezeTts, BREEZE_SAMPLE_RATE } from '../lib/tts/breeze.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) } catch (e) { failed++; console.error(`  ✗ ${name}: ${e?.message || e}`) }
}

const pcmChunk = (n, base = 0) => {
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(base + i, i * 2)
  return b
}

console.log('== 配置 ==')
check('未配置时 ready=false', () => {
  const b = new BreezeTts({})
  assert.equal(b.ready, false)
})
check('key 不回显明文', () => {
  const b = new BreezeTts({ apiKey: 'brz_secret', voiceId: 'voc_x' })
  assert.equal(b.ready, true)
  assert.ok(!JSON.stringify(b.status()).includes('brz_secret'))
  assert.equal(b.status().hasKey, true)
})

console.log('== 流式分块 ==')
const realFetch = globalThis.fetch
try {
  globalThis.fetch = async (url, init) => {
    assert.ok(url.includes('/v1/text-to-speech/voc_x/stream'))
    assert.ok(url.includes('output_format=pcm'))
    assert.equal(init.headers['xi-api-key'], 'brz_secret')
    const body = JSON.parse(init.body)
    assert.equal(body.text, '你好')
    assert.equal(body.model_id, 'breeze-tts-2')
    // 故意把 PCM 切成奇数长度，验证跨块重组
    const all = Buffer.concat([pcmChunk(3, 10), pcmChunk(2, 20)])
    const chunks = [all.subarray(0, 3), all.subarray(3, 7), all.subarray(7)]
    let i = 0
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
        }),
      },
    }
  }

  const b = new BreezeTts({ apiKey: 'brz_secret', voiceId: 'voc_x', model: 'breeze-tts-2' })
  const out = await b.synth('你好')
  check('输出采样率 24k', () => assert.equal(out.sampleRate, BREEZE_SAMPLE_RATE))
  check('跨块重组后样本数正确', () => assert.equal(out.pcm.length, 5))
  check('样本值正确', () => assert.deepEqual([...out.pcm], [10, 11, 12, 20, 21]))
} finally {
  globalThis.fetch = realFetch
}

console.log('== 错误处理 ==')
try {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ detail: { message: 'invalid key' } }),
  })
  const b = new BreezeTts({ apiKey: 'bad', voiceId: 'voc_x' })
  try {
    await b.synth('你好')
    failed++
    console.error('  ✗ 401 应报错')
  } catch (e) {
    check('401 错误信息可读', () => assert.ok(String(e.message).includes('invalid key')))
  }
} finally {
  globalThis.fetch = realFetch
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)