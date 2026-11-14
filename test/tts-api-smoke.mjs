/**
 * /voice-local/tts/api 冒烟：不启动引擎，只验证 API 通道配置的读取/保存/脱敏。
 * 跑法：node test/tts-api-smoke.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

function fakeReq(method, body) {
  const req = new PassThrough()
  req.method = method
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:63808', 'content-type': 'application/json' }
  if (body !== undefined) setTimeout(() => req.end(Buffer.from(JSON.stringify(body))), 0)
  return req
}

function makeCtx() {
  const state = { routes: [] }
  const ctx = {
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {}
      },
    },
    on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') state.effects?.push?.(off) },
    inject() { /* optional services not present in this harness */ },
  }
  return { ctx, state }
}

async function call(state, path, method, body) {
  const route = state.routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not found: ${path}`)
  const res = new FakeRes()
  await route.handler(fakeReq(method, body), res)
  return res
}

const dataRoot = mkdtempSync(join(tmpdir(), 'voice-tts-api-'))
try {
  console.log('== 1. 注册与初始状态 ==')
  const { ctx, state } = makeCtx()
  apply(ctx, { autoStart: false, autoDownloadModels: false, dataRoot, asrProvider: 'local' })
  ok(state.routes.some((r) => r.path === '/voice-local/tts/api'), '注册 /voice-local/tts/api')
  ok(state.routes.some((r) => r.path === '/voice-local/tts/test'), '注册 /voice-local/tts/test')

  let res = await call(state, '/voice-local/tts/api', 'GET')
  ok(res.status === 200, 'GET 200', res.status)
  ok(res.json?.provider === 'local', '默认本地 TTS', res.json)
  ok(res.json?.breeze?.hasKey === false, '默认无 Key')

  console.log('== 2. 保存 BreezeBlue + 官方 ASR ==')
  res = await call(state, '/voice-local/tts/api', 'POST', {
    provider: 'breeze',
    baseUrl: 'https://api.breeze.blue',
    apiKey: 'brz_smoke_secret_value',
    voiceId: 'voc_smoke',
    model: 'breeze-tts-2',
    language: 'zh',
    instructions: '温柔一点',
    guidanceScale: 2.5,
    speed: 1.1,
    volume: 1.2,
    speakerBoost: true,
    autoEmotion: true,
    asrProvider: 'dsh',
    asrLanguage: 'zh',
  })
  ok(res.status === 200, 'POST 200', res.status)
  ok(res.json?.provider === 'breeze' && res.json?.ready === true, '切换到 Breeze 且 ready', res.json)
  ok(res.json?.asrProvider === 'dsh', 'ASR provider 保存为 dsh', res.json)

  const file = join(dataRoot, 'tts-api.json')
  ok(existsSync(file), '生成 tts-api.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  ok(saved.provider === 'breeze' && saved.apiKey === 'brz_smoke_secret_value', '文件保存 key（仅本机）', saved)
  ok(saved.asrProvider === 'dsh', '文件保存 asrProvider')
  ok(saved.guidanceScale === 2.5 && saved.speed === 1.1 && saved.volume === 1.2, '文件保存情感参数', saved)
  ok(saved.speakerBoost === true, '文件保存 speakerBoost', saved)
  ok(saved.autoEmotion === true, '文件保存 autoEmotion', saved)

  res = await call(state, '/voice-local/tts/api', 'GET')
  ok(res.json?.breeze?.hasKey === true, 'GET 报告 hasKey')
  ok(res.json?.autoEmotion === true, 'GET 返回 autoEmotion', res.json)
  ok(res.json?.breeze?.guidanceScale === 2.5, 'GET 返回情感强度', res.json?.breeze)
  ok(res.json?.breeze?.speed === 1.1, 'GET 返回语速', res.json?.breeze)
  ok(!res.text.includes('brz_smoke_secret_value'), 'GET 不回显完整 Key', res.text)
  ok(String(res.json?.breeze?.keyPrefix || '').includes('…'), 'GET 只给前缀', res.json?.breeze)

  console.log('== 3. 切回本地 ==')
  res = await call(state, '/voice-local/tts/api', 'POST', { provider: 'local' })
  ok(res.status === 200 && res.json?.provider === 'local', '切回 local', res.json)
  ok(JSON.parse(readFileSync(file, 'utf8')).provider === 'local', '本地选择也落盘')
} finally {
  rmSync(dataRoot, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 失败'}`)
process.exit(failures ? 1 : 0)