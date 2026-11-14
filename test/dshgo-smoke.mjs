/**
 * dsh-go 原生适配层 smoke test（无真机、无 dsh-go 桥接）。
 *
 * 用一个假的 ctx.dshGo 捕获 read/media 注册，验证：
 *   - Markdown 清洗、长文本分块
 *   - read 返回 audio.play + voice.start，空消息返回 toast
 *   - media 把多块 WAV 拼成一个 WAV
 *   - 过期 key 报错
 */
import assert from 'node:assert/strict'
import { pcm16ToWav } from '../lib/security.js'
import { installDshGo, cleanForSpeech, splitForSpeech, concatWav } from '../lib/dshgo.js'

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}: ${e?.message || e}`)
  }
}

function fakeCtx() {
  const reg = { read: null, media: null, capability: null }
  const ctx = {
    inject(names, cb) {
      assert.deepEqual(names, ['dshGo'])
      cb({
        dshGo: {
          on(id, fn) { reg[id] = fn },
          media(id, fn) { reg.media = fn },
          onCapability(fn) { reg.capability = fn },
        },
      })
    },
  }
  return { ctx, reg }
}

const wavOf = (ms, sr = 16000) => {
  const n = Math.floor((sr * ms) / 1000)
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((i / sr) * 2 * Math.PI * 440) * 8000)
  return pcm16ToWav(pcm, sr)
}

console.log('== 1. 文本清洗 ==')
check('去掉代码块', () => {
  const s = cleanForSpeech('看这段：\n```js\nconsole.log(1)\n```\n完了')
  assert.ok(s.includes('代码略'))
  assert.ok(!s.includes('console.log'))
})
check('Markdown 链接只留文字', () => {
  assert.equal(cleanForSpeech('看[文档](https://example.com)'), '看文档')
})
check('标题/列表符号去掉', () => {
  const s = cleanForSpeech('# 标题\n- 第一项\n- 第二项')
  assert.ok(!s.startsWith('#'))
  assert.ok(!s.includes('- 第一项'))
})

console.log('== 2. 切块 ==')
check('短文本单块', () => {
  const r = splitForSpeech('你好')
  assert.equal(r.chunks.length, 1)
  assert.equal(r.truncated, false)
})
check('长文本多块且不超限', () => {
  const r = splitForSpeech('句子。'.repeat(1200))
  assert.ok(r.chunks.length > 1)
  for (const c of r.chunks) assert.ok(c.length <= 1800, `chunk ${c.length}`)
})

console.log('== 3. WAV 拼接 ==')
check('两个 WAV 拼成一个，头正确', () => {
  const a = wavOf(100)
  const b = wavOf(150)
  const out = concatWav([a, b])
  assert.equal(out.toString('ascii', 0, 4), 'RIFF')
  assert.equal(out.toString('ascii', 8, 12), 'WAVE')
  const dataLen = out.readUInt32LE(40)
  assert.equal(dataLen, (a.length - 44) + (b.length - 44))
  assert.equal(out.readUInt32LE(24), 16000)
})

console.log('== 4. 桥接注册 ==')
{
  const { ctx, reg } = fakeCtx()
  const spoken = []
  const speak = async (text) => { spoken.push(text); return wavOf(60) }
  installDshGo(ctx, { speak, ensureReady: async () => {} })
  assert.ok(reg.read && reg.media)

  check('read 返回 audio + voice 效果', () => {
    const out = reg.read({ message: '你好，世界。' })
    assert.ok(Array.isArray(out))
    const audio = out.find((e) => e.type === 'audio')
    assert.equal(audio.op, 'play')
    assert.equal(audio.src, 'media:speech')
    assert.ok(audio.key)
    const voice = out.find((e) => e.type === 'voice')
    assert.equal(voice.op, 'start')
  })

  check('空消息返回 toast', () => {
    const out = reg.read({ message: '   \n  ' })
    assert.ok(out.toast)
  })
}

// 异步部分单独跑
{
  const { ctx, reg } = fakeCtx()
  const spoken = []
  const styles = []
  let resolveCalls = 0
  const speak = async (text, opts = {}) => { spoken.push(text); styles.push(opts.style); return wavOf(60) }
  installDshGo(ctx, {
    speak,
    ensureReady: async () => {},
    resolveStyle: async () => {
      resolveCalls++
      return { instructions: '语气轻快，句尾上扬', guidanceScale: 3.25, speed: 1 }
    },
  })
  const effects = reg.read({ message: '第一句。第二句。'.repeat(250) })
  const key = effects.find((e) => e.type === 'audio').key
  await (async () => {
    try {
      const out = await reg.media({}, { key, signal: new AbortController().signal })
      assert.equal(out.contentType, 'audio/wav')
      assert.equal(out.body.toString('ascii', 0, 4), 'RIFF')
      assert.ok(spoken.length > 1, `expected multiple chunks, got ${spoken.length}`)
      assert.equal(resolveCalls, 1, '整条消息只算一次情感')
      for (const s of styles) assert.equal(s?.guidanceScale, 3.25, '每段都复用同一个情感')
      passed++
      console.log('  ✓ media 合成并返回 WAV（多段共用一次情感）')
    } catch (e) {
      failed++
      console.error(`  ✗ media 合成并返回 WAV: ${e?.message || e}`)
    }
  })()

  try {
    await reg.media({}, { key: 'nope' })
    failed++
    console.error('  ✗ 过期 key 应报错')
  } catch (e) {
    passed++
    console.log('  ✓ 过期 key 报错')
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)