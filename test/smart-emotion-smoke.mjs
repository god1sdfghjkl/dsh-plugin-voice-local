/**
 * 智能情感冒烟：假 LLM + 假 Breeze 流，验证「主模型 JSON → voice_settings」链路。
 * 跑法：node test/smart-emotion-smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { apply } from '../lib/index.js'

let failures = 0
function ok(cond, label, extra) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

class FakeRes {
  constructor() { this.status = 0; this.headers = {}; this.chunks = []; this.writableEnded = false; this.destroyed = false }
  writeHead(status, headers) { this.status = status; this.headers = headers || {}; this.headersSent = true; return this }
  write(c) { this.chunks.push(Buffer.from(c)); return true }
  end(b) { if (b !== undefined) this.chunks.push(Buffer.from(b)); this.writableEnded = true }
}

function fakeReq(method, body, url = '/') {
  const req = new PassThrough()
  req.method = method
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:63808' }
  if (body !== undefined) setTimeout(() => req.end(Buffer.from(JSON.stringify(body))), 0)
  return req
}

function makeCtx() {
  const state = { routes: [], tap: null, llmCalls: [], fetches: [] }
  const llm = {
    stream(request) {
      state.llmCalls.push(request)
      return (async function* () {
        yield { type: 'text-delta', textDelta: '{"emotion":"开心","intensity":5,"instruction":"语气轻快，句尾上扬"}' }
      })()
    },
  }
  const ctx = {
    webServer: { register(route) { state.routes.push(route); return () => {} } },
    on(event, handler) { if (event === 'llm/stream') state.tap = handler; return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') state.off = off },
    inject(deps, cb) {
      if (!Array.isArray(deps)) return
      // 只模拟 llm 存在；speechToText / systemPrompt / dshGo 在这个测试里缺席，
      // 与真实宿主缺少可选服务时的行为一致（回调不执行）。
      if (deps.includes('llm')) cb({ llm })
    },
  }
  return { ctx, state }
}

async function call(state, path, method = 'GET') {
  const route = state.routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not found: ${path}`)
  const req = fakeReq(method, undefined, path + (path === '/voice-local/stream' ? '?voice=1' : ''))
  const res = new FakeRes()
  await route.handler(req, res)
  return { req, res }
}

const dataRoot = mkdtempSync(join(tmpdir(), 'voice-smart-emotion-'))
const realFetch = globalThis.fetch
try {
  console.log('== 1. 打开语音 SSE，捕获主模型路由 ==')
  const { ctx, state } = makeCtx()
  apply(ctx, {
    autoStart: false,
    autoDownloadModels: false,
    dataRoot,
    ttsProvider: 'breeze',
    breezeApiKey: 'brz_smoke_only',
    breezeVoiceId: 'voc_smoke',
    breezeAutoEmotion: true,
    breezeSmartEmotion: true,
  })
  const stream = await call(state, '/voice-local/stream', 'GET')
  ok(stream.res.status === 200, 'SSE 连接建立', stream.res.status)

  globalThis.fetch = async (url, opts) => {
    state.fetches.push({ url: String(url), body: JSON.parse(opts.body || '{}') })
    return new Response(Uint8Array.from([0, 0, 1, 0]), { status: 200, headers: { 'content-type': 'audio/pcm' } })
  }

  console.log('== 2. 主模型输出一句，触发智能情感 + Breeze 请求 ==')
  const inner = (async function* () {
    yield { type: 'text-delta', text: '太好了，我终于成功了！' }
  })()
  const tapped = state.tap(
    { provider: 'deepseek', model: 'deepseek-chat', sessionId: 'smart-smoke' },
    async () => inner,
  )
  for await (const _ of tapped) { /* 读完整条流 */ }

  for (let i = 0; i < 40 && state.fetches.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
  ok(state.llmCalls.length === 1, '调用一次主模型生成情感', state.llmCalls.length)
  const llmReq = state.llmCalls[0]
  ok(llmReq?.provider === 'deepseek' && llmReq?.model === 'deepseek-chat', '沿用当前主模型', llmReq)
  ok(String(llmReq?.system || '').includes('只输出一行 JSON'), '系统提示要求 JSON')
  ok(state.fetches.length === 1, '发出一次 Breeze 流请求', state.fetches.length)
  const body = state.fetches[0]?.body || {}
  ok(body.voice_settings?.guidance_scale === 3.25, '强度 5 → guidance 3.25', body.voice_settings)
  ok(body.voice_settings?.speed === undefined, '智能模式不改默认语速', body.voice_settings)
  ok(body.instructions === '语气轻快，句尾上扬', '使用 LLM 生成的表演说明', body.instructions)

  stream.req.destroy()
} finally {
  globalThis.fetch = realFetch
  rmSync(dataRoot, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 失败'}`)
process.exit(failures ? 1 : 0)