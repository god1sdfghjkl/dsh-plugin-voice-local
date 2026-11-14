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
import { readFileSync } from 'node:fs'
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
  const reg = { read: null, media: null, capability: null, strip: null, panel: null }
  const ctx = {
    inject(names, cb) {
      assert.deepEqual(names, ['dshGo'])
      cb({
        dshGo: {
          on(id, fn) { reg[id] = fn },
          media(id, fn) { reg.media = fn },
          strip(id, fn) { reg.strip = { id, fn } },
          panel(id, spec) { reg.panel = { id, spec } },
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

console.log('== 0. 清单 ==')
{
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dshGo
  const c = manifest.contributes
  const ids = [
    ...c['composer.actions'].map((x) => x.id),
    ...c['composer.strip'].map((x) => x.id),
    ...c.panels.map((x) => x.id),
    ...c['message.actions'].map((x) => x.id),
    ...c.media.map((x) => x.id),
  ]
  check('原生入口/状态条/面板已声明', () => {
    assert.equal(c['composer.actions'][0].id, 'voice-open')
    assert.equal(c['composer.strip'][0].panel, 'voice-panel')
    assert.equal(c.panels[0].id, 'voice-panel')
  })
  check('贡献 id 全局唯一', () => {
    assert.equal(new Set(ids).size, ids.length, ids.join(','))
  })
  check('文案长度合规', () => {
    assert.ok([...c['composer.actions'][0].label].length <= 10)
    assert.ok([...c['composer.strip'][0].text].length <= 24)
    assert.ok([...c.panels[0].title].length <= 16)
  })
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

console.log('== 5. 原生入口 / 状态条 / 面板 ==')
{
  const { ctx, reg } = fakeCtx()
  installDshGo(ctx, {
    speak: async () => wavOf(60),
    ensureReady: async () => {},
    status: () => ({
      ready: true,
      provider: 'breeze',
      smart: true,
      ttsLabel: 'BreezeBlue 流式',
      voiceLabel: 'voc_smoke',
      emotionLabel: '智能（LLM）',
      asrLabel: '本地流式',
      voiceprintLabel: '关',
    }),
  })

  check('胶囊点按打开原生面板', () => {
    assert.deepEqual(reg['voice-open']({}, {}), { open: 'panel:voice-panel' })
  })
  check('状态条推送语音状态', () => {
    assert.equal(reg.strip.id, 'voice-strip')
    const emitted = []
    const cancel = reg.strip.fn({}, (d) => emitted.push(d), { locale: 'zh' })
    assert.ok(emitted.length >= 1)
    assert.match(emitted[0].text, /智能情感/)
    assert.equal(emitted[0].icon, 'speaker')
    assert.equal(emitted[0].tone, 'good')
    cancel()
  })
  check('未就绪时状态条/试听都给出明确提示', () => {
    const { ctx: c2, reg: r2 } = fakeCtx()
    installDshGo(c2, { speak: async () => wavOf(10), status: () => ({ ready: false }) })
    const emitted = []
    const cancel = r2.strip.fn({}, (d) => emitted.push(d), { locale: 'zh' })
    assert.equal(emitted[0].text, '语音 · 未就绪')
    assert.equal(emitted[0].tone, 'warn')
    cancel()
    assert.deepEqual(r2.panel.spec.actions.test(), { toast: '语音引擎未就绪，请先加载模型' })
  })
  check('面板视图/数据/动作注册', () => {
    assert.equal(reg.panel.id, 'voice-panel')
    const view = reg.panel.spec.view({}, { locale: 'zh' })
    assert.equal(view.type, 'stack')
    assert.ok(view.children.some((x) => x.type === 'keyValue'))
    assert.ok(view.children.some((x) => x.type === 'actions'))
    const data = []
    reg.panel.spec.data({}, (d) => data.push(d))
    assert.equal(data[0].ttsLabel, 'BreezeBlue 流式')
    assert.equal(data[0].emotionLabel, '智能（LLM）')
    assert.ok(reg.panel.spec.actions.test && reg.panel.spec.actions.stop && reg.panel.spec.actions.refresh)
    // 视图里的每个 data 绑定都能在 data 对象里找到；动作 id 都有 handler。
    const bindings = []
    const actions = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.$ === 'string' && node.$.startsWith('data.')) bindings.push(node.$.slice(5))
      if (typeof node.action === 'string') actions.push(node.action)
      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(view)
    for (const key of bindings) assert.ok(key in data[0], `missing data.${key}`)
    for (const id of actions) assert.ok(typeof reg.panel.spec.actions[id] === 'function', `missing action ${id}`)
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 32 * 1024, 'view < 32 KiB')
  })
  check('面板停止/刷新返回合法效果', () => {
    const stop = reg.panel.spec.actions.stop()
    assert.ok(stop.some((e) => e.type === 'audio' && e.op === 'stop'))
    assert.deepEqual(reg.panel.spec.actions.refresh(), { refresh: 'voice-panel' })
  })
  try {
    const effects = reg.panel.spec.actions.test()
    const audio = effects.find((e) => e.type === 'audio')
    assert.ok(audio && audio.op === 'play', '试听返回 audio.play')
    const out = await reg.media({}, { key: audio.key, signal: new AbortController().signal })
    assert.equal(out.contentType, 'audio/wav')
    assert.equal(out.body.toString('ascii', 0, 4), 'RIFF')
    passed++
    console.log('  ✓ 面板试听合成 WAV')
  } catch (e) {
    failed++
    console.error(`  ✗ 面板试听合成 WAV: ${e?.message || e}`)
  }
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