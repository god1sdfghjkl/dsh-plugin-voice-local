/**
 * dsh-plugin-voice-local · 宿主端（DSH 0.2.x）
 *
 * 目标：语音能力长在 DSH 宿主里，不 spawn 独立进程、不多出窗口/端口。
 *
 * 结构：
 *   - 引擎：VoiceEngine（worker_threads）常驻，插件加载即预热模型
 *   - 朗读来源：tap `llm/stream` waterfall，收 text-delta → 切句 → TTS
 *   - 浏览器通道：ctx.webServer 上的 /voice-local/* 路由（SSE + POST）
 *   - 安全：loopback + 同源校验 + body 上限（webServer 本身不做这些）
 *   - 生命周期：全部注册走 ctx.effect，卸载时 worker/SSE/路由一起回收
 *
 * 配置（cordis.patch.yml 的 config 段，缺省值见 DEFAULTS）：
 *   ttsOnnx / asrStreamDir / sensevoiceDir  模型路径（空 = 按 dataRoot 与旧版目录自动探测）
 *   dataRoot       模型数据根目录（空 = $DSH_HOME/voice-local 或项目内 .voice-local）
 *   sr              TTS 采样率（默认 44100，必须与模型 config.json 一致）
 *   ttsThreads / asrThreads   推理线程数
 *   autoStart      插件加载即启动引擎（默认 true）
 *   llmTap         是否 tap llm/stream 自动朗读（默认 true）
 *   firstSegmentChars / maxSegmentChars  首句/后续句长度（TTS 切句）
 *   speed          语速倍率
 *   maxBodyBytes   POST 请求体上限
 *   sseHeartbeatMs SSE 心跳间隔
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { VoiceEngine } from './engine-manager.js'
import { createSegmenter } from './segmenter.js'
import { guard, sendJson, readBody, readJson, pcm16ToWav } from './security.js'
import {
  scanTtsProfiles,
  pickDefaultTtsProfile,
  publicTtsProfile,
  legacyTtsProfile,
} from './models/tts-registry.js'
import {
  scanAsrProfiles,
  pickAsrProfile,
  publicAsrProfile,
  legacyAsrProfiles,
} from './models/asr-registry.js'
import { downloadProfileFiles, downloadSummary } from './models/downloader.js'

export const name = 'voice-local'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)
const PKG = safeReadJson(join(PLUGIN_ROOT, 'package.json')) || {}
const VERSION = PKG.version || '0.0.0'

const DEFAULTS = {
  basePath: '/voice-local',
  dataRoot: '',
  // TTS 模型：ttsModel 选 id（dataRoot/models/tts/<id>），ttsOnnx 兼容旧配置
  ttsModel: '',
  ttsModelsDir: '',
  ttsOnnx: '',
  ttsConfig: '',
  // ASR 模型：流式（必需）+ 定稿（可选）
  asrModel: '',
  asrFinalModel: '',
  asrModelsDir: '',
  asrStreamDir: '',
  sensevoiceDir: '',
  sr: 44100,
  ttsThreads: 4,
  asrThreads: 1,
  autoStart: true,
  llmTap: true,
  firstSegmentChars: 6,
  maxSegmentChars: 16,
  speed: 1,
  // 客户端 VAD / 打断参数（下发到浏览器端，避免硬编码）
  vadThreshold: 0.012,        // 16k RMS 语音门限
  autoEndSilenceMs: 900,      // 说完停顿多久自动提交
  minSpeechMs: 200,           // 至少说这么久才算一句话
  maxUtteranceMs: 30000,      // 单句最长时长，防止一直不提交
  bargeIn: true,              // 朗读期间是否允许"开口打断"
  bargeInThreshold: 0.025,    // 打断门限（比 VAD 高，抗回采）
  warmupText: '你好，我是你的语音助手。',
  maxBodyBytes: 2 * 1024 * 1024,
  sseHeartbeatMs: 15000,
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

function safeReadJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function firstExisting(candidates) {
  for (const c of candidates) if (c && existsSync(c)) return c
  return candidates.find(Boolean) || ''
}

/** 模型路径解析：显式配置 > 环境变量 > dataRoot > 兼容 standalone 目录布局 */
export function resolvePaths(cfg) {
  const voiceRoot = basename(PLUGIN_ROOT) === 'dsh-plugin' ? dirname(PLUGIN_ROOT) : PLUGIN_ROOT
  // 宿主进程不一定继承 DSH_HOME，兜底到 ~/.dsh（避免默认路径落进 node_modules）
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataRoot = cfg.dataRoot || process.env.VOICE_DATA_ROOT || join(dshHome, 'voice-local')
  const ttsOnnx = cfg.ttsOnnx || process.env.VOICE_TTS_ONNX || firstExisting([
    join(dataRoot, 'tts', 'tl196m_dyn.onnx'),
    join(voiceRoot, '..', 'onnx_out', 'tl196m_dyn.onnx'),
    join(voiceRoot, 'models', 'tts', 'tl196m_dyn.onnx'),
  ])
  const asrStreamDir = cfg.asrStreamDir || process.env.VOICE_ASR_STREAM_DIR || firstExisting([
    join(dataRoot, 'asr', 'zipformer-streaming'),
    join(voiceRoot, 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'),
  ])
  const sensevoiceDir = cfg.sensevoiceDir || process.env.VOICE_SENSEVOICE_DIR || firstExisting([
    join(dataRoot, 'asr', 'sensevoice'),
    join(voiceRoot, 'xiaozhi', 'main', 'xiaozhi-server', 'models', 'sensevoice'),
  ])
  return { voiceRoot, dataRoot, ttsOnnx, asrStreamDir, sensevoiceDir }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const base = String(cfg.basePath || '/voice-local').replace(/\/$/, '')
  const paths = resolvePaths(cfg)
  const warnings = []

  // ------------------------------------------------------------ TTS 模型注册表
  // 模型可随意换：dataRoot/models/tts/<id>/ 每个目录一个模型（model.json 可省，
  // 按文件特征自动探测），旧配置 ttsOnnx 仍然兼容。
  const ttsModelsDir = cfg.ttsModelsDir
    ? String(cfg.ttsModelsDir)
    : join(paths.dataRoot, 'models', 'tts')
  const legacyTts = cfg.ttsOnnx
    ? legacyTtsProfile({
      onnxPath: paths.ttsOnnx,
      configPath: cfg.ttsConfig || '',
      sampleRate: cfg.sr,
    })
    : null

  function refreshTtsProfiles() {
    return scanTtsProfiles({ modelsDir: ttsModelsDir, legacy: legacyTts })
  }

  function pickActiveTts(profiles) {
    if (cfg.ttsModel) {
      const hit = profiles.find((p) => p.id === cfg.ttsModel)
      if (hit) return hit
    }
    // 旧配置显式给了 ttsOnnx → 尊重旧行为；否则优先 models/tts 里扫描到的模型
    if (legacyTts && cfg.ttsOnnx) return legacyTts
    const scanned = profiles.filter((p) => !p.legacy && !(p.problems || []).length)
    if (scanned.length) return scanned[0]
    return pickDefaultTtsProfile(profiles, { preferredId: cfg.ttsModel })
  }

  let ttsProfiles = refreshTtsProfiles()
  let activeTts = pickActiveTts(ttsProfiles)

  if (!activeTts) {
    warnings.push(`未找到可用 TTS 模型：把模型目录放到 ${ttsModelsDir}/<id>/，或配置 ttsOnnx / ttsModel`)
  } else if (cfg.ttsModel && activeTts.id !== cfg.ttsModel) {
    warnings.push(`未找到配置的 ttsModel=${cfg.ttsModel}，已回退到 ${activeTts.id}`)
  }

  // ------------------------------------------------------------ ASR 模型注册表
  // dataRoot/models/asr/{streaming,final}/<id>/；旧 asrStreamDir/sensevoiceDir 兼容。
  const asrModelsDir = cfg.asrModelsDir
    ? String(cfg.asrModelsDir)
    : join(paths.dataRoot, 'models', 'asr')
  const legacyAsr = legacyAsrProfiles({
    streamingDir: cfg.asrStreamDir ? paths.asrStreamDir : '',
    finalDir: cfg.sensevoiceDir ? paths.sensevoiceDir : '',
  })

  function refreshAsrProfiles() {
    const scanned = scanAsrProfiles({ modelsDir: asrModelsDir })
    const list = [...scanned]
    // 旧配置的模型始终列出来（方便从 UI 切回），去重
    for (const legacy of legacyAsr) {
      if (!list.some((p) => p.role === legacy.role && p.id === legacy.id)) list.push(legacy)
    }
    return list
  }

  let asrProfiles = refreshAsrProfiles()
  function pickActiveAsr(role, preferredId) {
    if (preferredId) {
      const hit = asrProfiles.find((p) => p.role === role && p.id === preferredId)
      if (hit) return hit
    }
    // 显式旧配置优先（保持既有行为）；否则取扫描到的第一个可用模型
    const legacyExplicit = role === 'streaming'
      ? (cfg.asrStreamDir ? legacyAsr.find((p) => p.role === 'streaming' && !(p.problems || []).length) : null)
      : (cfg.sensevoiceDir ? legacyAsr.find((p) => p.role === 'final' && !(p.problems || []).length) : null)
    if (legacyExplicit) return legacyExplicit
    const scanned = asrProfiles.filter((p) => p.role === role && !p.legacy && !(p.problems || []).length)
    if (scanned.length) return scanned[0]
    return pickAsrProfile(asrProfiles, role, preferredId)
  }
  let activeAsrStreaming = pickActiveAsr('streaming', cfg.asrModel)
  let activeAsrFinal = cfg.asrFinalModel
    ? asrProfiles.find((p) => p.role === 'final' && p.id === cfg.asrFinalModel) || pickActiveAsr('final')
    : pickActiveAsr('final')

  if (!activeAsrStreaming) {
    warnings.push(`未找到流式 ASR 模型：配置 asrStreamDir，或把模型目录放到 ${asrModelsDir}/streaming/<id>/`)
  } else if (cfg.asrModel && activeAsrStreaming.id !== cfg.asrModel) {
    warnings.push(`未找到配置的 asrModel=${cfg.asrModel}，已回退到 ${activeAsrStreaming.id}`)
  }

  const engine = new VoiceEngine({
    ttsProfile: activeTts,
    asrStreamingProfile: activeAsrStreaming,
    asrFinalProfile: activeAsrFinal,
    sr: cfg.sr,
    ttsThreads: cfg.ttsThreads,
    asrThreads: cfg.asrThreads,
    warmupText: cfg.warmupText,
  })

  const startedAt = Date.now()
  const clients = new Set()
  const cleanups = []

  function useEffect(fn) {
    if (typeof ctx.effect === 'function') {
      ctx.effect(fn)
    } else {
      const off = fn()
      if (typeof off === 'function') cleanups.push(off)
    }
  }

  // ------------------------------------------------------------ SSE 广播
  function sendEvent(res, event, data) {
    if (res.writableEnded || res.destroyed) return
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch { /* 客户端已断 */ }
  }

  function broadcast(event, data) {
    for (const c of clients) sendEvent(c.res, event, data)
  }

  /** 只有开了语音模式的 SSE 客户端才触发朗读，避免普通状态页也读数 */
  function hasVoiceClient() {
    for (const c of clients) if (c.voice) return true
    return false
  }

  // ------------------------------------------------------------ TTS 队列
  const tts = {
    epoch: 0,
    queue: [],
    pumping: false,
    push(text, epoch) {
      this.queue.push({ text, epoch })
      void this.pump()
    },
    cancel() {
      this.epoch++
      this.queue.length = 0
      broadcast('tts', { kind: 'cancel', epoch: this.epoch })
    },
    async pump() {
      if (this.pumping) return
      this.pumping = true
      try {
        while (this.queue.length) {
          const job = this.queue.shift()
          if (job.epoch !== this.epoch) continue
          broadcast('tts', { kind: 'start', text: job.text, epoch: job.epoch })
          let audio
          try {
            audio = await engine.synth(job.text, cfg.speed)
          } catch (e) {
            broadcast('tts', { kind: 'error', message: e?.message || String(e), epoch: job.epoch })
            continue
          }
          if (job.epoch !== this.epoch) continue
          const pcm = audio.pcm
          const CHUNK = 4096
          for (let i = 0; i < pcm.length; i += CHUNK) {
            if (job.epoch !== this.epoch) break
            const slice = pcm.subarray(i, Math.min(i + CHUNK, pcm.length))
            broadcast('tts', {
              kind: 'audio',
              epoch: job.epoch,
              sampleRate: audio.sampleRate,
              pcm: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64'),
            })
          }
          broadcast('tts', { kind: 'end', text: job.text, epoch: job.epoch })
        }
      } finally {
        this.pumping = false
      }
    },
  }

  // ------------------------------------------------------------ 引擎生命周期
  if (typeof engine.onAsr === 'function') {
    engine.onAsr((m) => {
      if (!clients.size) return
      if (m.type === 'partial' || m.type === 'final' || m.type === 'endpoint') {
        broadcast('asr', { kind: m.type, text: m.text || '' })
      } else if (m.type === 'warn') {
        broadcast('asr', { kind: 'warn', message: m.message || '' })
      }
    })
  }

  async function startEngine() {
    const st = await engine.start()
    if (!st || st.state === 'error') {
      console.error('[voice-local] 引擎启动失败：', st?.lastError || engine.lastError)
    } else {
      console.log(`[voice-local] 引擎就绪 tts=${st.ttsReady} asr=${st.asrReady} load=${st.loadMs}ms`)
    }
    broadcast('state', engine.status())
    return st
  }

  if (cfg.autoStart) {
    useEffect(() => {
      let cancelled = false
      void startEngine().catch((e) => {
        if (!cancelled) console.error('[voice-local] 引擎启动异常：', e)
      })
      return () => { cancelled = true }
    })
  }

  useEffect(() => () => {
    for (const c of clients) {
      try { c.res.end() } catch { /* 已断 */ }
      clearInterval(c.timer)
    }
    clients.clear()
    engine.dispose()
    for (const off of cleanups.splice(0)) { try { off() } catch { /* 已清 */ } }
  })

  // ------------------------------------------------------------ 路由注册
  function route(kind, sub, handler) {
    const path = sub === '/' ? base : `${base}${sub}`
    useEffect(() => {
      if (typeof ctx.webServer?.register !== 'function') return
      const off = ctx.webServer.register({ kind, path, handler })
      return typeof off === 'function' ? off : undefined
    })
  }

  function withHandler(fn) {
    return async (req, res) => {
      try {
        if (guard(req, res)) return
        await fn(req, res)
      } catch (e) {
        if (!res.headersSent) {
          sendJson(res, e?.status || 500, { ok: false, error: e?.expose ? e.message : 'internal error' })
        } else {
          try { res.destroy() } catch { /* 已断 */ }
        }
        if (!e?.status || e.status >= 500) console.error('[voice-local] 路由异常：', e)
      }
    }
  }

  // GET /status
  route('exact', '/status', withHandler(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const st = engine.status()
    sendJson(res, 200, {
      ok: st.state === 'ready',
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      clients: clients.size,
      engine: st,
      models: {
        ttsDir: ttsModelsDir,
        activeTts: publicTtsProfile(engine.ttsProfile || activeTts),
        tts: ttsProfiles.map(publicTtsProfile),
        asrDir: asrModelsDir,
        activeAsr: {
          streaming: publicAsrProfile(engine.asrStreamingProfile || activeAsrStreaming),
          final: publicAsrProfile(engine.asrFinalProfile || activeAsrFinal),
        },
        asr: asrProfiles.map(publicAsrProfile),
      },
      paths: {
        dataRoot: paths.dataRoot,
        ttsOnnx: paths.ttsOnnx,
        ttsModelsDir,
        asrStreamDir: paths.asrStreamDir,
        sensevoiceDir: paths.sensevoiceDir,
        exists: {
          ttsOnnx: !!paths.ttsOnnx && existsSync(paths.ttsOnnx),
          asrStreamDir: !!paths.asrStreamDir && existsSync(paths.asrStreamDir),
          sensevoiceDir: !!paths.sensevoiceDir && existsSync(paths.sensevoiceDir),
        },
      },
      warnings,
      config: {
        sr: cfg.sr, ttsThreads: cfg.ttsThreads, asrThreads: cfg.asrThreads,
        llmTap: cfg.llmTap, firstSegmentChars: cfg.firstSegmentChars,
        maxSegmentChars: cfg.maxSegmentChars, speed: cfg.speed,
        vadThreshold: cfg.vadThreshold, autoEndSilenceMs: cfg.autoEndSilenceMs,
        minSpeechMs: cfg.minSpeechMs, maxUtteranceMs: cfg.maxUtteranceMs,
        bargeIn: cfg.bargeIn, bargeInThreshold: cfg.bargeInThreshold,
      },
    })
  }))

  // GET /models — 扫描 TTS/ASR 模型目录（每次请求都重新扫，丢目录即可见）
  route('exact', '/models', withHandler(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    ttsProfiles = refreshTtsProfiles()
    asrProfiles = refreshAsrProfiles()
    if (!engine.ttsProfile) activeTts = pickActiveTts(ttsProfiles)
    sendJson(res, 200, {
      ok: true,
      ttsDir: ttsModelsDir,
      active: engine.ttsInfo?.id || activeTts?.id || '',
      tts: ttsProfiles.map((p) => ({ ...publicTtsProfile(p), download: downloadSummary(p) })),
      asrDir: asrModelsDir,
      asrActive: {
        streaming: (engine.asrInfo?.streaming && engine.asrInfo.streaming.id) || engine.asrStreamingProfile?.id || activeAsrStreaming?.id || '',
        final: (engine.asrInfo?.final && engine.asrInfo.final.id) || engine.asrFinalProfile?.id || activeAsrFinal?.id || '',
      },
      asr: asrProfiles.map((p) => ({ ...publicAsrProfile(p), download: downloadSummary(p) })),
    })
  }))

  // POST /models/fetch {kind, id, role?, force?} — 按 model.json 的 download 清单下载模型文件
  // 立即返回 202，进度通过 SSE `model` 事件推送；下载完成后自动重新扫描（不自动切换）
  const downloadsInFlight = new Map()
  route('exact', '/models/fetch', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const kind = String(body.kind || 'tts')
    const id = String(body.id || '')
    const role = String(body.role || '')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id is required' })
    if (kind !== 'tts' && kind !== 'asr') return sendJson(res, 400, { ok: false, error: `kind=${kind} 不支持（tts / asr）` })

    const profiles = kind === 'asr' ? (asrProfiles = refreshAsrProfiles()) : (ttsProfiles = refreshTtsProfiles())
    const profile = profiles.find((p) => p.id === id && (!role || p.role === role))
    if (!profile) return sendJson(res, 404, { ok: false, error: `找不到模型: ${id}` })
    if (!Array.isArray(profile.download) || !profile.download.length) {
      return sendJson(res, 400, { ok: false, error: '该模型没有下载清单（model.json 缺少 download 字段）' })
    }
    const key = `${kind}:${profile.role || ''}:${id}`
    if (downloadsInFlight.has(key)) return sendJson(res, 409, { ok: false, error: '该模型正在下载中' })

    const summary = downloadSummary(profile)
    const baseEvent = { kind, id, role: profile.role || '' }
    const job = (async () => {
      try {
        broadcast('model', { ...baseEvent, phase: 'start', missing: summary?.missing || 0, bytes: summary?.bytes || 0 })
        const result = await downloadProfileFiles(profile, {
          force: !!body.force,
          onProgress: (p) => broadcast('model', { ...baseEvent, ...p }),
        })
        if (kind === 'asr') asrProfiles = refreshAsrProfiles()
        else ttsProfiles = refreshTtsProfiles()
        broadcast('model', { ...baseEvent, phase: 'complete', ...result })
      } catch (e) {
        broadcast('model', { ...baseEvent, phase: 'error', error: e?.message || String(e) })
      } finally {
        downloadsInFlight.delete(key)
      }
    })()
    downloadsInFlight.set(key, job)
    sendJson(res, 202, { ok: true, started: true, ...baseEvent, missing: summary?.missing || 0, bytes: summary?.bytes || 0 })
  }))

  // POST /models/use {kind, id, role?} — 热切换 TTS / ASR 模型
  //   {kind:'tts', id}                   只重启 TTS worker
  //   {kind:'asr', id, role?}            只重启 ASR worker（role 默认按模型自身角色）
  route('exact', '/models/use', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const kind = String(body.kind || 'tts')
    const id = String(body.id || '')
    if (!id) return sendJson(res, 400, { ok: false, error: 'id is required' })

    if (kind === 'tts') {
      ttsProfiles = refreshTtsProfiles()
      const profile = ttsProfiles.find((p) => p.id === id)
      if (!profile) return sendJson(res, 404, { ok: false, error: `找不到模型: ${id}`, ttsDir: ttsModelsDir })
      const problems = profile.problems || []
      if (problems.length) return sendJson(res, 400, { ok: false, error: '模型不可用', problems })
      try {
        const st = await engine.switchTts(profile)
        activeTts = profile
        broadcast('state', st)
        sendJson(res, 200, { ok: true, kind, active: id, engine: st })
      } catch (e) {
        broadcast('state', engine.status())
        sendJson(res, 500, { ok: false, error: e?.message || String(e) })
      }
      return
    }

    if (kind === 'asr') {
      asrProfiles = refreshAsrProfiles()
      const role = String(body.role || '')
      const profile = asrProfiles.find((p) => p.id === id && (!role || p.role === role))
      if (!profile) return sendJson(res, 404, { ok: false, error: `找不到 ASR 模型: ${id}`, asrDir: asrModelsDir })
      const problems = profile.problems || []
      if (problems.length) return sendJson(res, 400, { ok: false, error: '模型不可用', problems })
      try {
        const st = await engine.switchAsr(profile.role === 'streaming' ? { streaming: profile } : { final: profile })
        if (profile.role === 'streaming') activeAsrStreaming = profile
        else activeAsrFinal = profile
        broadcast('state', st)
        sendJson(res, 200, { ok: true, kind, role: profile.role, active: id, engine: st })
      } catch (e) {
        broadcast('state', engine.status())
        sendJson(res, 500, { ok: false, error: e?.message || String(e) })
      }
      return
    }

    return sendJson(res, 400, { ok: false, error: `kind=${kind} 不支持（tts / asr）` })
  }))

  // GET /stream — SSE 事件流；?voice=1 表示这是语音对话客户端（会触发朗读）
  route('exact', '/stream', withHandler(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    let voice = false
    try { voice = new URL(req.url || '/', 'http://localhost').searchParams.get('voice') === '1' } catch { /* 默认非语音 */ }
    res.writeHead(200, SSE_HEADERS)
    const timer = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* 已断 */ }
    }, Math.max(3000, cfg.sseHeartbeatMs))
    timer.unref?.()
    const client = { res, timer, voice }
    clients.add(client)
    sendEvent(res, 'hello', { version: VERSION, base, voice, engine: engine.status() })
    const drop = () => {
      clearInterval(timer)
      clients.delete(client)
    }
    req.on('close', drop)
    req.on('error', drop)
  }))

  // POST /asr/start | /asr/feed | /asr/final
  route('exact', '/asr/start', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    engine.asrStart()
    sendJson(res, 200, { ok: true })
  }))

  route('exact', '/asr/feed', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const type = String(req.headers?.['content-type'] || '')
    if (!/application\/octet-stream|audio\/pcm/i.test(type)) {
      return sendJson(res, 415, { ok: false, error: 'content-type must be application/octet-stream (PCM16LE @16k mono)' })
    }
    const buf = await readBody(req, cfg.maxBodyBytes)
    if (buf.length % 2 !== 0) return sendJson(res, 400, { ok: false, error: 'pcm length must be even' })
    const pcm16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
    const f32 = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768
    engine.asrFeed(f32)
    sendJson(res, 200, { ok: true, samples: f32.length })
  }))

  route('exact', '/asr/final', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    engine.asrFinal()
    sendJson(res, 200, { ok: true })
  }))

  // POST /speak {text, speed?} → audio/wav
  route('exact', '/speak', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' })
    if (text.length > 2000) return sendJson(res, 413, { ok: false, error: 'text too long' })
    if (!engine.ttsReady) return sendJson(res, 503, { ok: false, error: engine.lastError || 'TTS 未就绪' })
    const speed = Number(body.speed) > 0 ? Number(body.speed) : cfg.speed
    const audio = await engine.synth(text, speed)
    const wav = pcm16ToWav(audio.pcm, audio.sampleRate || cfg.sr)
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': wav.length,
      'Cache-Control': 'no-store',
    })
    res.end(wav)
  }))

  // POST /cancel — 打断当前朗读
  route('exact', '/cancel', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    tts.cancel()
    sendJson(res, 200, { ok: true, epoch: tts.epoch })
  }))

  // GET /assets/* — 客户端静态资源（字体/图片），只允许白名单扩展名，禁止路径穿越
  const ASSET_ROOT = join(HERE, 'assets')
  const ASSET_TYPES = {
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  }
  route('prefix', '/assets', withHandler(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }
    const raw = (req.url || '/').split('?')[0]
    let rel = raw.startsWith(base + '/assets') ? raw.slice((base + '/assets').length) : raw
    try { rel = decodeURIComponent(rel) } catch { return sendJson(res, 400, { ok: false, error: 'bad path' }) }
    rel = rel.replace(/^\/+/, '')
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    const type = ASSET_TYPES[ext]
    if (!type) return sendJson(res, 404, { ok: false, error: 'not found' })
    const file = join(ASSET_ROOT, rel)
    const normalized = file.replace(/\\/g, '/')
    if (!normalized.startsWith(ASSET_ROOT.replace(/\\/g, '/') + '/')) {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }
    let buf
    try { buf = readFileSync(file) } catch { return sendJson(res, 404, { ok: false, error: 'not found' }) }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    res.end(req.method === 'HEAD' ? undefined : buf)
  }))

  // ------------------------------------------------------------ llm/stream tap
  if (cfg.llmTap) {
    useEffect(() => {
      if (typeof ctx.on !== 'function') return
      const handler = function voiceLlmTap(options, next) {
        if (!hasVoiceClient()) return next()
        return tapStream(options, next)
      }
      const off = ctx.on('llm/stream', handler)
      return typeof off === 'function' ? off : undefined
    })
  }

  async function* tapStream(options, next) {
    const inner = await next()
    if (!inner) return
    const sessionId = options?.sessionId ?? options?.session ?? null
    const session = sessionId ? String(sessionId) : null
    // 新一轮模型输出：先打断上一轮还在排队/播放的朗读
    if (tts.queue.length || tts.pumping) tts.cancel()
    const epoch = tts.epoch
    const seg = createSegmenter({ firstChars: cfg.firstSegmentChars, maxChars: cfg.maxSegmentChars })
    let sawText = false
    try {
      for await (const chunk of inner) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          sawText = true
          broadcast('assistant', { kind: 'delta', text: chunk.text, session, epoch })
          for (const s of seg.push(chunk.text)) tts.push(s, epoch)
        }
        yield chunk
      }
    } finally {
      if (sawText) {
        for (const s of seg.flush()) tts.push(s, epoch)
        broadcast('assistant', { kind: 'done', session, epoch })
      }
    }
  }

  console.log(`[voice-local] 已加载 v${VERSION} base=${base} tts=${activeTts ? `${activeTts.id}(${activeTts.engine})` : '(缺失)'} asr=${activeAsrStreaming ? activeAsrStreaming.id : '(缺失)'}${activeAsrFinal ? '+' + activeAsrFinal.id : ''} models=${ttsProfiles.length}/${asrProfiles.length}`)
  if (warnings.length) for (const w of warnings) console.warn('[voice-local]', w)
  return () => { try { return engine.disposeAsync() } catch { /* 已清 */ } }
}
