/**
 * 宿主端冒烟测试（不依赖 DSH）：用 stub ctx 验证
 *   1. 路由注册齐全（status / stream / asr/* / speak / cancel）
 *   2. status 返回真实引擎状态与模型路径
 *   3. /speak 返回可解析的 WAV
 *   4. llm/stream tap：透传 chunk + 切句 + TTS 音频事件广播
 *   5. /cancel 递增 epoch
 *   6. 安全：非回环 / 跨源请求被拒
 *
 * 直接跑：node test/host-smoke.mjs
 * 模型路径默认用 standalone 项目里的旧目录，可用 VOICE_TTS_ONNX 等环境变量覆盖。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { apply, resolvePaths } from '../lib/index.js'

const ROOT = process.env.VOICE_SAMPLE_ROOT
  || fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '')
const env = process.env
const cfgPaths = resolvePaths({
  ttsOnnx: env.VOICE_TTS_ONNX || `${ROOT}/../onnx_out/tl196m_dyn.onnx`,
  asrStreamDir: env.VOICE_ASR_DIR || `${ROOT}/models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`,
  sensevoiceDir: env.VOICE_SENSEVOICE_DIR || `${ROOT}/xiaozhi/main/xiaozhi-server/models/sensevoice`,
})

const missing = [cfgPaths.ttsOnnx, cfgPaths.asrStreamDir, cfgPaths.sensevoiceDir].filter((p) => p && !existsSync(p))
if (missing.length) {
  console.log('跳过宿主冒烟：未找到示例模型。设置 VOICE_TTS_ONNX / VOICE_ASR_DIR / VOICE_SENSEVOICE_DIR 后重跑。')
  for (const p of missing) console.log('  缺少：' + p)
  process.exit(0)
}

let failures = 0
function ok(cond, label, extra) {
  if (cond) { console.log(`  ✓ ${label}`) } else { failures++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class FakeRes {
  constructor() {
    this.status = 0
    this.headers = {}
    this.chunks = []
    this.writableEnded = false
    this.destroyed = false
    this.headersSent = false
  }
  writeHead(status, headers) { this.status = status; this.headers = headers || {}; this.headersSent = true; return this }
  write(c) { this.chunks.push(Buffer.from(c)); return true }
  end(b) { if (b !== undefined) this.chunks.push(Buffer.from(b)); this.writableEnded = true }
  get buffer() { return Buffer.concat(this.chunks) }
  get text() { return this.buffer.toString('utf8') }
  get json() { try { return JSON.parse(this.text) } catch { return null } }
}

function fakeReq(method, { body = null, contentType = 'application/json', headers = {}, url = null } = {}) {
  const req = new PassThrough()
  req.method = method
  req.url = url || '/'
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:57885', ...(body !== null ? { 'content-type': contentType } : {}), ...headers }
  if (body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    setTimeout(() => { req.end(buf) }, 0)
  }
  return req
}

function makeCtx() {
  const state = { routes: [], listeners: [], effects: [] }
  const ctx = {
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => { const i = state.routes.indexOf(route); if (i >= 0) state.routes.splice(i, 1) }
      },
    },
    on(name, fn) {
      state.listeners.push({ name, fn })
      return () => { const i = state.listeners.indexOf(state.listeners.find((l) => l.fn === fn)); if (i >= 0) state.listeners.splice(i, 1) }
    },
    effect(fn) { state.effects.push(fn); const off = fn(); if (typeof off === 'function') state.effects.push(off) },
  }
  return { ctx, state }
}

async function callRoute(state, path, method, reqOpts = {}) {
  const route = state.routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not found: ${path}`)
  const res = new FakeRes()
  const req = fakeReq(method, { url: path, ...reqOpts })
  await route.handler(req, res)
  return res
}

async function main() {
  console.log('== 1. 路由注册 ==')
  const { ctx, state } = makeCtx()
  const dispose = apply(ctx, {
    autoStart: true,
    llmTap: true,
    ttsOnnx: cfgPaths.ttsOnnx,
    asrStreamDir: cfgPaths.asrStreamDir,
    sensevoiceDir: cfgPaths.sensevoiceDir,
    firstSegmentChars: 6,
    maxSegmentChars: 12,
  })
  const paths = state.routes.map((r) => r.path).sort()
  const expect = ['/voice-local/asr/feed', '/voice-local/asr/final', '/voice-local/asr/start', '/voice-local/cancel', '/voice-local/speak', '/voice-local/status', '/voice-local/stream', '/voice-local/assets']
  for (const p of expect) ok(paths.includes(p), `注册 ${p}`)
  ok(state.listeners.some((l) => l.name === 'llm/stream'), '注册 llm/stream waterfall')

  console.log('== 1b. 静态资源（字体） ==')
  const fontRes = await callRoute(state, '/voice-local/assets', 'GET', { url: '/voice-local/assets/fonts/Inter-400.ttf' })
  ok(fontRes.status === 200, '字体 200', fontRes.status)
  ok(String(fontRes.headers['Content-Type']) === 'font/ttf', '字体 content-type', fontRes.headers['Content-Type'])
  ok(fontRes.buffer.length > 10000, `字体大小合理（${fontRes.buffer.length}B）`)
  const badRes = await callRoute(state, '/voice-local/assets', 'GET', { url: '/voice-local/assets/../lib/index.js' })
  ok(badRes.status === 404, '路径穿越被拒', badRes.status)

  console.log('== 2. 等待引擎就绪 ==')
  let status = null
  for (let i = 0; i < 100; i++) {
    const res = await callRoute(state, '/voice-local/status', 'GET')
    status = res.json
    if (res.status === 200 && status?.engine?.state === 'ready') break
    await sleep(300)
  }
  ok(!!status, 'status 返回 JSON')
  ok(status?.engine?.state === 'ready', '引擎 state=ready', status?.engine)
  ok(status?.engine?.ttsReady === true, 'TTS ready')
  ok(status?.engine?.asrReady === true, 'ASR ready', status?.engine?.lastError)
  ok(status?.paths?.exists?.ttsOnnx === true, 'TTS 模型存在')
  ok(status?.paths?.exists?.asrStreamDir === true, '流式 ASR 目录存在')
  ok(status?.paths?.exists?.sensevoiceDir === true, 'SenseVoice 目录存在')
  // 预热是后台任务：ready 之后才开始，最多等 5s
  let warm = 0
  for (let i = 0; i < 20 && !warm; i++) {
    await sleep(250)
    const r = await callRoute(state, '/voice-local/status', 'GET')
    warm = r.json?.engine?.warmupMs || 0
  }
  ok(warm > 0, 'TTS 预热完成（warmupMs>0）', warm)

  console.log('== 3. /speak ==')
  const speak = await callRoute(state, '/voice-local/speak', 'POST', { body: { text: '你好，世界。' } })
  ok(speak.status === 200, 'speak 200')
  ok(String(speak.headers['Content-Type']).startsWith('audio/wav'), 'content-type audio/wav')
  const wav = speak.buffer
  ok(wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', 'WAV 头正确')
  ok(wav.readUInt32LE(24) === 44100, '采样率 44100')

  console.log('== 4. llm/stream tap + SSE 广播 ==')
  // 4a. 先开普通 SSE（voice=0）：tap 不应广播、不应触发 TTS
  const plain = await callRoute(state, '/voice-local/stream', 'GET')
  ok(plain.status === 200, '普通 SSE 200')
  ok(plain.text.includes('"voice":false'), '普通 SSE hello voice=false')
  const tap = state.listeners.find((l) => l.name === 'llm/stream').fn
  const chunks = [
    { type: 'text-delta', index: 0, text: '今天' },
    { type: 'text-delta', index: 0, text: '天气不错，' },
    { type: 'text-delta', index: 0, text: '我们出去走走吧。' },
    { type: 'usage', usage: {} },
    { type: 'finish', reason: 'stop' },
  ]
  async function* fakeNext() { for (const c of chunks) yield c }
  const outPlain = []
  for await (const c of tap({ sessionId: 'plain-session' }, fakeNext)) outPlain.push(c)
  ok(outPlain.length === chunks.length, '无语音客户端时 tap 直接透传', outPlain.length)
  await sleep(150)
  ok(!plain.text.includes('event: assistant'), '非语音 SSE 不广播 assistant')
  ok(!plain.text.includes('event: tts'), '非语音 SSE 不广播 tts')

  // 4b. 再开语音 SSE（voice=1）：tap 切句 + TTS 广播
  const sse = await callRoute(state, '/voice-local/stream', 'GET', { url: '/voice-local/stream?voice=1' })
  ok(sse.status === 200, '语音 SSE 200')
  ok(String(sse.headers['Content-Type']).includes('text/event-stream'), 'SSE content-type')
  ok(sse.text.includes('"voice":true'), '语音 SSE hello voice=true')
  await sleep(50)

  const out = []
  const gen = tap({ sessionId: 'test-session' }, fakeNext)
  for await (const c of gen) out.push(c)
  ok(out.length === chunks.length, 'tap 透传全部 chunk', out.length)
  ok(JSON.stringify(out) === JSON.stringify(chunks), 'chunk 内容不变')

  let sseText = ''
  let starts0 = 0
  let ends0 = 0
  for (let i = 0; i < 200; i++) {
    await sleep(250)
    sseText = sse.text
    starts0 = (sseText.match(/"kind":"start"/g) || []).length
    ends0 = (sseText.match(/"kind":"end"/g) || []).length
    // 等所有段都合成完（否则 dispose 时 worker 可能还在 session.run）
    if (starts0 >= 2 && ends0 >= starts0) break
  }
  ok(sseText.includes('event: assistant'), 'SSE 收到 assistant 事件')
  ok(sseText.includes('event: tts'), 'SSE 收到 tts 事件')
  const audioEvents = [...sseText.matchAll(/data: (\{"kind":"audio".*?\})\n/g)].map((m) => JSON.parse(m[1]))
  ok(audioEvents.length > 0, `收到音频分片（${audioEvents.length} 片）`)
  if (audioEvents.length) {
    const pcm = Buffer.from(audioEvents[0].pcm, 'base64')
    ok(pcm.length % 2 === 0 && pcm.length > 0, '音频分片是合法 PCM16')
    ok(audioEvents[0].sampleRate === 44100, '音频分片带采样率')
  }
  const ttsStarts = [...sseText.matchAll(/data: (\{"kind":"start".*?\})\n/g)].map((m) => JSON.parse(m[1]))
  ok(ttsStarts.length >= 1, `TTS 至少合成 1 段（${ttsStarts.length}）`)
  ok(ttsStarts.map((s) => s.text).join('').includes('天气'), '切句覆盖文本', ttsStarts.map((s) => s.text))

  console.log('== 5. /cancel ==')
  const cres = await callRoute(state, '/voice-local/cancel', 'POST', { body: {} })
  ok(cres.status === 200 && cres.json?.ok === true, 'cancel 200')
  ok(typeof cres.json?.epoch === 'number', 'cancel 返回 epoch', cres.json)

  console.log('== 6. 安全：非回环/跨源 ==')
  const { ctx: ctx2, state: state2 } = makeCtx()
  apply(ctx2, { autoStart: false, llmTap: false, ttsOnnx: cfgPaths.ttsOnnx })
  const route2 = state2.routes.find((r) => r.path === '/voice-local/status')
  const resBad = new FakeRes()
  const reqBad = fakeReq('GET', { headers: { origin: 'https://evil.example' } })
  reqBad.socket.remoteAddress = '10.0.0.5'
  await route2.handler(reqBad, resBad)
  ok(resBad.status === 403, '非回环请求 403', resBad.status)

  const resX = new FakeRes()
  const reqX = fakeReq('GET', { headers: { origin: 'https://evil.example' } })
  await route2.handler(reqX, resX)
  ok(resX.status === 403, '跨源请求 403', resX.status)

  try { await dispose?.() } catch { /* 已清 */ }
  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('测试异常：', e); process.exitCode = 1 })
