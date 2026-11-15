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
import { installDshGo, cleanForSpeech, splitForSpeech, concatWav, nextEmotionMode, nextTtsProvider } from '../lib/dshgo.js'

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
  const reg = { read: null, media: null, capability: null, strip: null, panel: null, sessionEvent: null }
  const ctx = {
    on(name, fn) { if (name === 'session/event') reg.sessionEvent = fn },
    inject(names, cb) {
      assert.deepEqual(names, ['dshGo'])
      cb({
        on(name, fn) { if (name === 'session/event') reg.sessionEvent = fn },
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
    assert.equal(c.panels[0].presentation, 'sheet')
    assert.ok(c.panels[0].placement.includes('plugin'))
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
    assert.equal(out.type, 'toast')
    assert.match(out.text, /没有能朗读/)
  })
}

console.log('== 5. 原生入口 / 状态条 / 面板 ==')
{
  const { ctx, reg } = fakeCtx()
  const calls = { provider: [], emotion: [] }
  installDshGo(ctx, {
    speak: async () => wavOf(60),
    ensureReady: async () => {},
    status: () => ({
      ready: true,
      provider: 'breeze',
      breezeReady: true,
      auto: true,
      smart: true,
      ttsLabel: 'BreezeBlue 流式',
      voiceLabel: 'voc_smoke',
      emotionLabel: '智能（LLM）',
      asrLabel: 'dsh-go 官方语音输入',
      voiceprintLabel: '关',
    }),
    setProvider: (v) => { calls.provider.push(v); return { ok: true, label: v } },
    setEmotion: (v) => { calls.emotion.push(v); return { ok: true, label: v } },
  })

  check('胶囊点按打开原生面板', () => {
    assert.deepEqual(reg['voice-open']({}, {}), { type: 'open', page: 'panel:voice-panel' })
  })
  check('空闲时状态条自动收起，不占输入框上方', () => {
    assert.equal(reg.strip.id, 'voice-strip')
    const emitted = []
    const cancel = reg.strip.fn({}, (d) => emitted.push(d), { locale: 'zh' })
    assert.ok(emitted.length >= 1)
    assert.equal(emitted[0].text, '')
    assert.equal(emitted[0].icon, undefined)
    cancel()
  })
  check('未就绪时状态条/试听都给出明确提示', () => {
    const { ctx: c2, reg: r2 } = fakeCtx()
    installDshGo(c2, { speak: async () => wavOf(10), status: () => ({ ready: false }) })
    const emitted = []
    const cancel = r2.strip.fn({}, (d) => emitted.push(d), { locale: 'zh' })
    assert.equal(emitted[0].text, '语音未就绪')
    assert.equal(emitted[0].tone, 'warn')
    cancel()
    assert.deepEqual(r2.panel.spec.actions.test(), { type: 'toast', text: '语音引擎未就绪，请先加载模型' })
  })
  check('面板视图：主操作 3 个、通道/情感用单选组', () => {
    assert.equal(reg.panel.id, 'voice-panel')
    const view = reg.panel.spec.view({ sessionId: 's1' }, { locale: 'zh' })
    assert.equal(view.type, 'stack')
    const actionRows = view.children.filter((x) => x.type === 'actions')
    assert.equal(actionRows.length, 1)
    assert.deepEqual(actionRows[0].items.map((x) => x.label), ['念最新', '试听', '停止'])
    const groups = view.children.filter((x) => x.type === 'options')
    assert.equal(groups.length, 2)
    assert.equal(groups[0].id, 'setProvider')
    assert.deepEqual(groups[0].options.map((x) => x.value), ['local', 'breeze'])
    assert.equal(groups[1].id, 'setEmotion')
    assert.deepEqual(groups[1].options.map((x) => x.value), ['off', 'rule', 'smart'])
    assert.equal(view.children.find((x) => x.type === 'keyValue').items.length, 2)
    assert.ok(view.children.some((x) => x.type === 'callout'))
  })
  check('面板数据/动作注册完整，绑定无漏键', () => {
    const view = reg.panel.spec.view({ sessionId: 's1' }, { locale: 'zh' })
    const data = []
    reg.panel.spec.data({ sessionId: 's1' }, (d) => data.push(d))
    assert.equal(data[0].ttsLabel, 'BreezeBlue 流式')
    assert.equal(data[0].emotionLabel, '智能（LLM）')
    assert.equal(data[0].voiceLabel, 'voc_smoke')
    assert.equal(data[0].latestLabel, '暂无')
    assert.equal(data[0].headline, '语音已就绪 · 云端')
    assert.equal(data[0].provider, 'breeze')
    assert.equal(data[0].emotion, 'smart')
    assert.ok(reg.panel.spec.actions.test && reg.panel.spec.actions.stop
      && reg.panel.spec.actions.readLatest && reg.panel.spec.actions.setProvider
      && reg.panel.spec.actions.setEmotion)
    // 视图里的每个 data 绑定都能在 data 对象里找到；动作 id 都有 handler。
    const bindings = []
    const actions = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.$ === 'string' && node.$.startsWith('data.')) bindings.push(node.$.slice(5))
      const action = node.action
      if (typeof action === 'string') actions.push(action)
      else if (action && typeof action.id === 'string') actions.push(action.id)
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
  check('无会话时停止只刷新，不返回无效 stop', () => {
    assert.deepEqual(reg.panel.spec.actions.stop(), [{ type: 'refresh', id: 'voice-panel' }])
  })
  check('有会话时停止返回 audio/voice stop；结束事件后清标记', () => {
    reg.read({ message: '先开始一段朗读' })
    const stop = reg.panel.spec.actions.stop()
    assert.ok(stop.some((e) => e.type === 'audio' && e.op === 'stop'))
    assert.ok(stop.some((e) => e.type === 'voice' && e.op === 'stop'))
    reg.capability({}, { instance: 'read', event: 'audio.ended' })
    assert.deepEqual(reg.panel.spec.actions.stop(), [{ type: 'refresh', id: 'voice-panel' }])
  })
  check('情感/通道按钮改成明确选项，不再循环', () => {
    assert.deepEqual(nextEmotionMode(false, false), { autoEmotion: true, smartEmotion: false })
    assert.deepEqual(nextEmotionMode(true, false), { autoEmotion: true, smartEmotion: true })
    assert.deepEqual(nextEmotionMode(true, true), { autoEmotion: false, smartEmotion: false })
    assert.equal(nextTtsProvider('local', true), 'breeze')
    assert.equal(nextTtsProvider('breeze', true), 'local')
    assert.equal(nextTtsProvider('local', false), 'local')
    assert.deepEqual(reg.panel.spec.actions.setProvider({}, { value: { value: 'local' } }), [{ type: 'refresh', id: 'voice-panel' }])
    assert.deepEqual(reg.panel.spec.actions.setEmotion({}, { value: { value: 'rule' } }), [{ type: 'refresh', id: 'voice-panel' }])
    assert.deepEqual(calls.provider, ['local'])
    assert.deepEqual(calls.emotion, ['rule'])
  })
  check('念最新：记住回合结束的最新回复并可朗读', () => {
    assert.deepEqual(reg.panel.spec.actions.readLatest({ sessionId: 's1' }), {
      type: 'toast',
      text: '这个会话还没有可朗读的回复',
    })
    reg.sessionEvent({ id: 's1', header: {} }, {
      type: 'assistant/message',
      data: { turn: 7, message: { content: [{ type: 'text', text: '最新一条回复。' }] } },
    })
    reg.sessionEvent({ id: 's1', header: {} }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    const out = reg.panel.spec.actions.readLatest({ sessionId: 's1' })
    assert.ok(Array.isArray(out) && out.some((e) => e.type === 'audio' && e.op === 'play'))
    const data = []
    reg.panel.spec.data({ sessionId: 's1' }, (d) => data.push(d))
    assert.equal(data[0].latestLabel, '可朗读')
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