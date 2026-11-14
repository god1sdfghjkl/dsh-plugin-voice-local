/**
 * DSH 官方语音识别通道冒烟：验证 /asr/* 在 asrProvider=dsh 时把整句 PCM
 * 交给 ctx.speechToText.transcribe()，并保留“服务未安装时降级为 warn/空定稿”的行为。
 * 不启动本地引擎、不加载模型。跑法：node test/dsh-asr-smoke.mjs
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
  get text() { return Buffer.concat(this.chunks).toString('utf8') }
  get json() { try { return JSON.parse(this.text) } catch { return null } }
}

function fakeReq(method, body, contentType = 'application/json') {
  const req = new PassThrough()
  req.method = method
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:63808', 'content-type': contentType }
  if (body !== undefined) setTimeout(() => req.end(Buffer.from(body)), 0)
  return req
}

function makeCtx(speech) {
  const state = { routes: [] }
  const ctx = {
    webServer: { register(route) { state.routes.push(route); return () => {} } },
    on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') state.effects?.push?.(off) },
    inject(names, cb) { if (speech && names.includes('speechToText')) cb({ speechToText: speech }) },
  }
  return { ctx, state }
}

async function call(state, path, method, body, contentType) {
  const route = state.routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not found: ${path}`)
  const res = new FakeRes()
  await route.handler(fakeReq(method, body, contentType), res)
  return res
}

const dataRoot = mkdtempSync(join(tmpdir(), 'voice-dsh-asr-'))
try {
  console.log('== 1. 官方 provider 存在 ==')
  let seenWav = 0
  let seenLanguage = ''
  const speech = {
    snapshot: () => ({ selection: { providerId: 'sensevoice-local' } }),
    prepare: (id) => { ok(id === 'sensevoice-local', 'prepare 收到 providerId') },
    resolve: ({ audio, language }) => {
      seenWav = audio?.length || 0
      seenLanguage = language
      return { audio, language, provider: { id: 'sensevoice-local' } }
    },
    transcribe: async (spec) => {
      ok(spec?.audio?.length >= 44, 'transcribe 收到 WAV', spec?.audio?.length)
      return { text: '官方识别结果', audioSeconds: 0.2, inferenceSeconds: 0.01 }
    },
  }
  const { ctx, state } = makeCtx(speech)
  apply(ctx, { autoStart: false, autoDownloadModels: false, dataRoot, asrProvider: 'dsh', asrLanguage: 'zh' })

  let res = await call(state, '/voice-local/asr/start', 'POST')
  ok(res.status === 200 && res.json?.provider === 'dsh', 'start 使用 dsh', res.json)

  const pcm = Buffer.alloc(6400) // 0.2s @16k mono PCM16
  res = await call(state, '/voice-local/asr/feed', 'POST', pcm, 'application/octet-stream')
  ok(res.status === 200 && res.json?.samples === 3200, 'feed 接收 PCM16LE', res.json)

  res = await call(state, '/voice-local/asr/final', 'POST')
  ok(res.status === 200 && res.json?.text === '官方识别结果', 'final 返回官方转写', res.json)
  ok(seenWav > 44, '传给官方的音频是完整 WAV', seenWav)
  ok(seenLanguage === 'zh', '语言提示传给官方', seenLanguage)

  console.log('== 2. 官方服务不存在时降级 ==')
  const missingRoot = mkdtempSync(join(tmpdir(), 'voice-dsh-asr-missing-'))
  try {
    const alt = makeCtx(null)
    apply(alt.ctx, { autoStart: false, autoDownloadModels: false, dataRoot: missingRoot, asrProvider: 'dsh' })
    await call(alt.state, '/voice-local/asr/feed', 'POST', Buffer.alloc(6400), 'application/octet-stream')
    res = await call(alt.state, '/voice-local/asr/final', 'POST')
    ok(res.status === 200 && res.json?.ok === false, '未安装时返回 ok:false 而不是抛错', res.json)
    ok(/不可用|未安装/.test(res.json?.error || ''), '错误信息可读', res.json?.error)
  } finally {
    rmSync(missingRoot, { recursive: true, force: true })
  }
} finally {
  rmSync(dataRoot, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 失败'}`)
process.exit(failures ? 1 : 0)