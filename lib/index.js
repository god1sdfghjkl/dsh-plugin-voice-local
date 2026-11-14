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
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { VoiceEngine } from './engine-manager.js'
import { createSegmenter } from './segmenter.js'
import { guard, sendJson, readBody, readJson, pcm16ToWav } from './security.js'
import { installDshGo } from './dshgo.js'
import { installCallPersona } from './call-persona.js'
import { BreezeTts, BREEZE_SAMPLE_RATE } from './tts/breeze.js'
import { detectEmotion } from './tts/emotion.js'
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
import { downloadProfileFiles, downloadSummary, missingFiles } from './models/downloader.js'
import { loadExampleTtsProfiles } from './models/examples.js'
import {
  VoiceprintService,
  downloadVoiceprintModel,
  VOICEPRINT_MODEL_URL,
  VOICEPRINT_MODEL_MIRROR,
  VOICEPRINT_MODEL_SHA256,
  VOICEPRINT_MODEL_BYTES,
} from './voiceprint/service.js'

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
  // ASR 通道：local（本插件 sherpa 流式）或 dsh（DSH 官方 speechToText，仅整句定稿）
  asrProvider: 'local',
  asrLanguage: 'zh',
  // TTS 通道：local（默认，本机模型）或 breeze（BreezeBlue API 流式）
  ttsProvider: 'local',
  breezeBaseUrl: 'https://api.breeze.blue',
  breezeApiKey: '',
  breezeVoiceId: '',
  breezeModel: '',
  breezeLanguage: 'zh',
  breezeInstructions: '',
  breezeGuidance: 1,
  breezeSpeed: 1,
  breezeVolume: 1,
  breezeSpeakerBoost: false,
  breezeAutoEmotion: false,
  autoStart: true,
  // 首次启动且没有任何可用 TTS 时，自动下载包内示例模型（见 examples/models/）
  autoDownloadModels: true,
  exampleModelId: 'tl196m',
  // 声纹锁：只回答注册过的声音（本地 CAM++ embedding，不上传）
  voiceprintEnabled: false,
  voiceprintThreshold: 0.7,
  voiceprintModel: '',
  voiceprintDataFile: '',
  llmTap: true,
  // 通话期间固定使用口语化提示词；挂断（没有 voice=1 客户端）自动恢复
  callPersona: true,
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

  // DSH 官方语音识别（可选）：仅整句定稿，没有流式 partial。
  let dshSpeech = null
  ctx.inject(['speechToText'], (c) => { dshSpeech = c.speechToText })

  // ------------------------------------------------------------ TTS API 通道（BreezeBlue）
  // 配置优先级：tts-api.json（界面保存）> cordis 配置 > BREEZE_API_KEY 环境变量
  const ttsApiFile = join(paths.dataRoot, 'tts-api.json')
  const savedTtsApi = safeReadJson(ttsApiFile) || {}
  const breeze = new BreezeTts({
    baseUrl: savedTtsApi.baseUrl || cfg.breezeBaseUrl,
    apiKey: savedTtsApi.apiKey || cfg.breezeApiKey || process.env.BREEZE_API_KEY || '',
    voiceId: savedTtsApi.voiceId || cfg.breezeVoiceId,
    model: savedTtsApi.model || cfg.breezeModel,
    language: savedTtsApi.language || cfg.breezeLanguage,
    instructions: savedTtsApi.instructions || cfg.breezeInstructions,
    guidanceScale: savedTtsApi.guidanceScale ?? cfg.breezeGuidance,
    speed: savedTtsApi.speed ?? cfg.breezeSpeed,
    volume: savedTtsApi.volume ?? cfg.breezeVolume,
    speakerBoost: savedTtsApi.speakerBoost ?? cfg.breezeSpeakerBoost,
  })
  if (savedTtsApi.asrProvider === 'dsh' || savedTtsApi.asrProvider === 'local') cfg.asrProvider = savedTtsApi.asrProvider
  if (typeof savedTtsApi.asrLanguage === 'string' && savedTtsApi.asrLanguage) cfg.asrLanguage = savedTtsApi.asrLanguage
  let ttsProvider = (savedTtsApi.provider || cfg.ttsProvider) === 'breeze' ? 'breeze' : 'local'
  let breezeAutoEmotion = savedTtsApi.autoEmotion != null ? savedTtsApi.autoEmotion === true : cfg.breezeAutoEmotion === true
  if (ttsProvider === 'breeze' && !breeze.ready) {
    warnings.push('ttsProvider=breeze 但缺少 BreezeBlue API Key 或 voice_id，已回退本地 TTS')
    ttsProvider = 'local'
  }
  const useBreeze = () => ttsProvider === 'breeze' && breeze.ready
  /** 自动情感：按当前句子的文字选表演说明；关闭时返回 null（用面板保存的固定参数）。 */
  const autoEmotionStyle = (text) => {
    if (!breezeAutoEmotion) return null
    const r = detectEmotion(text)
    return { instructions: r.instructions, guidanceScale: r.guidanceScale, speed: r.speed }
  }

  function saveTtsApi() {
    try {
      mkdirSync(dirname(ttsApiFile), { recursive: true })
      const data = {
        provider: ttsProvider,
        baseUrl: breeze.baseUrl,
        apiKey: breeze.apiKey,
        voiceId: breeze.voiceId,
        model: breeze.model,
        language: breeze.language,
        instructions: breeze.instructions,
        guidanceScale: breeze.guidanceScale,
        speed: breeze.speed,
        volume: breeze.volume,
        speakerBoost: breeze.speakerBoost,
        autoEmotion: breezeAutoEmotion,
        asrProvider: cfg.asrProvider,
        asrLanguage: cfg.asrLanguage,
      }
      const tmp = `${ttsApiFile}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      renameSync(tmp, ttsApiFile)
      try { chmodSync(ttsApiFile, 0o600) } catch { /* Windows 忽略 */ }
    } catch (e) {
      console.warn('[voice-local] 保存 tts-api.json 失败：', e?.message || e)
    }
  }

  // ------------------------------------------------------------ 声纹锁
  const voiceprintModel = cfg.voiceprintModel
    ? String(cfg.voiceprintModel)
    : join(paths.dataRoot, 'models', 'voiceprint', 'campplus_zh.onnx')
  const voiceprintDataFile = cfg.voiceprintDataFile
    ? String(cfg.voiceprintDataFile)
    : join(paths.dataRoot, 'voiceprint.json')
  let voiceprintEnabled = false
  const voiceprint = new VoiceprintService({
    modelPath: voiceprintModel,
    dataFile: voiceprintDataFile,
    threshold: cfg.voiceprintThreshold,
    threads: Math.max(1, Math.min(2, Number(cfg.ttsThreads) || 1)),
  })
  // 总开关持久化在 voiceprint.json，重启后恢复；config 显式 true 优先
  voiceprintEnabled = cfg.voiceprintEnabled === true ? true : !!voiceprint.settings.enabled

  // ------------------------------------------------------------ TTS 模型注册表
  // 模型可随意换：dataRoot/models/tts/<id>/ 每个目录一个模型（model.json 可省，
  // 按文件特征自动探测），旧配置 ttsOnnx 仍然兼容。
  const ttsModelsDir = cfg.ttsModelsDir
    ? String(cfg.ttsModelsDir)
    : join(paths.dataRoot, 'models', 'tts')
  // 包内示例模型清单（只含 model.json，权重按下载清单拉取）
  const examplesDir = join(PLUGIN_ROOT, 'examples', 'models')
  const legacyTts = cfg.ttsOnnx
    ? legacyTtsProfile({
      onnxPath: paths.ttsOnnx,
      configPath: cfg.ttsConfig || '',
      sampleRate: cfg.sr,
    })
    : null

  function refreshTtsProfiles() {
    const list = scanTtsProfiles({ modelsDir: ttsModelsDir, legacy: legacyTts })
    // 示例清单作为「虚拟可下载模型」补充进来；同 id 的真实目录优先
    for (const example of loadExampleTtsProfiles({ examplesDir, modelsDir: ttsModelsDir })) {
      if (!list.some((p) => p.id === example.id)) list.push(example)
    }
    return list
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

  // 一句话的 PCM（用于声纹校验）；上限 20s，避免内存无限增长
  const VOICEPRINT_MAX_SAMPLES = 16000 * 20
  let uttChunks = []
  let uttSamples = 0
  let pendingGate = null

  function resetUtterance() {
    uttChunks = []
    uttSamples = 0
  }
  function pushUtterance(f32) {
    if (!f32 || uttSamples >= VOICEPRINT_MAX_SAMPLES) return
    const remain = VOICEPRINT_MAX_SAMPLES - uttSamples
    const chunk = f32.length > remain ? f32.subarray(0, remain) : f32
    uttChunks.push(new Float32Array(chunk))
    uttSamples += chunk.length
  }
  function drainUtterance() {
    if (!uttSamples) return null
    const out = new Float32Array(uttSamples)
    let off = 0
    for (const c of uttChunks) { out.set(c, off); off += c.length }
    resetUtterance()
    return out
  }

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
    abort: null,
    push(text, epoch) {
      this.queue.push({ text, epoch })
      void this.pump()
    },
    cancel() {
      this.epoch++
      this.queue.length = 0
      try { this.abort?.abort() } catch { /* 已结束 */ }
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

          // BreezeBlue：边收边播，不用等整句合成完
          if (useBreeze()) {
            const ac = new AbortController()
            this.abort = ac
            const emotion = autoEmotionStyle(job.text)
            try {
              for await (const pcm of breeze.stream(job.text, { signal: ac.signal, ...(emotion || {}) })) {
                if (job.epoch !== this.epoch) break
                broadcast('tts', {
                  kind: 'audio',
                  epoch: job.epoch,
                  sampleRate: BREEZE_SAMPLE_RATE,
                  pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
                })
              }
            } catch (e) {
              if (!ac.signal.aborted && job.epoch === this.epoch) {
                broadcast('tts', { kind: 'error', message: e?.message || String(e), epoch: job.epoch })
              }
            } finally {
              if (this.abort === ac) this.abort = null
            }
            if (job.epoch === this.epoch) broadcast('tts', { kind: 'end', text: job.text, epoch: job.epoch })
            continue
          }

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

  /** 统一合成入口：BreezeBlue 或本地引擎；/speak、dsh-go media 共用。 */
  async function synthAudio(text, { speed = cfg.speed, signal } = {}) {
    if (useBreeze()) {
      const emotion = autoEmotionStyle(text)
      return await breeze.synth(text, { signal, ...(emotion || {}) })
    }
    if (!engine.ttsReady) await startEngine()
    if (!engine.ttsReady) throw new Error(engine.lastError || '语音引擎未就绪')
    return await engine.synth(text, speed)
  }

  // ------------------------------------------------------------ 引擎生命周期
  if (typeof engine.onAsr === 'function') {
    engine.onAsr(async (m) => {
      if (!clients.size) return
      // 声纹锁：定稿时先比对；不匹配就不把文字交给会话
      if (m.type === 'final' && voiceprintEnabled && voiceprint.enrolled) {
        let gate = null
        try { gate = await pendingGate } catch (e) {
          console.warn('[voice-local] 声纹校验失败（放行）：', e?.message || e)
          gate = { ok: true, error: e?.message || String(e) }
        }
        pendingGate = null
        if (gate && voiceprint.settings.requireEnrolled && gate.ok === false) {
          broadcast('voiceprint', { kind: 'rejected', score: gate.score, threshold: gate.threshold })
          return
        }
        if (gate && gate.score != null) {
          broadcast('voiceprint', {
            kind: 'accepted',
            score: gate.score,
            threshold: gate.threshold,
            matched: gate.matched || null,
          })
        }
      }
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

  // 首次启动自动拉示例模型：没有可用 TTS 时，按包内清单下载（不阻塞插件加载）
  async function autoDownloadExample() {
    if (cfg.autoDownloadModels === false) return
    if (!ttsProfiles.some((p) => p.example)) return
    if (activeTts && !(activeTts.problems || []).length) return
    const wantedId = String(cfg.exampleModelId || 'tl196m')
    const target = ttsProfiles.find((p) => p.example && p.id === wantedId)
      || ttsProfiles.find((p) => p.example && Array.isArray(p.download) && p.download.length)
    if (!target) return

    let missing = []
    try { missing = await missingFiles(target) } catch { missing = [] }
    if (!missing.length) {
      // 文件其实已在（可能是手动放进去的），直接切换
      const fresh = refreshTtsProfiles().find((p) => p.id === target.id)
      if (fresh && !(fresh.problems || []).length) {
        activeTts = fresh
        try { await engine.switchTts(fresh); broadcast('state', engine.status()) } catch (e) {
          console.error('[voice-local] 示例模型切换失败：', e?.message || e)
        }
      }
      return
    }

    const total = missing.reduce((n, it) => n + Number(it.bytes || 0), 0)
    console.log(`[voice-local] 首次启动：自动下载示例模型 ${target.id}（${(total / 1048576).toFixed(0)}MB / ${missing.length} 项）`)
    broadcast('model', { phase: 'start', kind: 'tts', id: target.id, name: target.name, bytes: total, missing: missing.length })
    try {
      const r = await downloadProfileFiles(target, {
        onProgress: (p) => broadcast('model', { kind: 'tts', id: target.id, name: target.name, ...p }),
      })
      ttsProfiles = refreshTtsProfiles()
      const fresh = ttsProfiles.find((p) => p.id === target.id)
      broadcast('model', { phase: 'complete', kind: 'tts', id: target.id, downloaded: r.downloaded, skipped: r.skipped })
      if (fresh && !(fresh.problems || []).length) {
        activeTts = fresh
        await engine.switchTts(fresh)
        broadcast('state', engine.status())
        console.log(`[voice-local] 示例模型 ${target.id} 下载完成并已切换`)
      }
    } catch (e) {
      console.error('[voice-local] 示例模型自动下载失败：', e?.message || e)
      broadcast('model', { phase: 'error', kind: 'tts', id: target.id, error: e?.message || String(e) })
    }
  }

  useEffect(() => {
    let cancelled = false
    void autoDownloadExample().catch((e) => {
      if (!cancelled) console.error('[voice-local] 自动下载示例模型异常：', e?.message || e)
    })
    return () => { cancelled = true }
  })

  if (cfg.autoStart) {
    useEffect(() => {
      let cancelled = false
      void startEngine().catch((e) => {
        if (!cancelled) console.error('[voice-local] 引擎启动异常：', e)
      })
      return () => { cancelled = true }
    })
  }

  // dsh-go 原生界面（可选）：有 dshGo 桥接时才注册，桌面/网页不受影响。
  installDshGo(ctx, {
    speak: async (text) => {
      const audio = await synthAudio(text)
      return pcm16ToWav(audio.pcm, audio.sampleRate || cfg.sr)
    },
    ensureReady: () => startEngine(),
  })

  // 通话期间固定“像正常人说话”的口吻；挂断后自动恢复默认系统提示。
  installCallPersona(ctx, {
    enabled: cfg.callPersona !== false,
    isActive: () => hasVoiceClient(),
  })

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
  // 手机书签入口：跳到 DSH 首页并自动打开语音（client.js 读 ?dsh-voice=1）
  route('exact', '/mobile', withHandler(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    res.writeHead(302, { Location: '/?dsh-voice=1', 'Cache-Control': 'no-store' })
    res.end()
  }))

  // GET/POST /tts/api — 配置 BreezeBlue 流式 TTS（key 只写本地文件，不回显）
  route('exact', '/tts/api', withHandler(async (req, res) => {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        provider: ttsProvider,
        autoEmotion: breezeAutoEmotion,
        breeze: breeze.status(),
        asrProvider: cfg.asrProvider,
        asrLanguage: cfg.asrLanguage,
      })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const clamp = (v, fallback, min, max) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
    }
    const next = {
      provider: body.provider === 'local' ? 'local' : (body.provider === 'breeze' ? 'breeze' : ttsProvider),
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : breeze.baseUrl,
      apiKey: body.clearKey === true ? '' : (typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : breeze.apiKey),
      voiceId: typeof body.voiceId === 'string' ? body.voiceId.trim() : breeze.voiceId,
      model: typeof body.model === 'string' ? body.model.trim() : breeze.model,
      language: typeof body.language === 'string' ? body.language.trim().slice(0, 2) : breeze.language,
      instructions: typeof body.instructions === 'string' ? body.instructions : breeze.instructions,
      guidanceScale: clamp(body.guidanceScale, breeze.guidanceScale, 1, 10),
      speed: clamp(body.speed, breeze.speed, 0.5, 2),
      volume: clamp(body.volume, breeze.volume, 0.01, 2),
      speakerBoost: typeof body.speakerBoost === 'boolean' ? body.speakerBoost : breeze.speakerBoost,
    }
    breeze.update(next)
    if (typeof body.autoEmotion === 'boolean') breezeAutoEmotion = body.autoEmotion
    ttsProvider = next.provider
    if (body.asrProvider === 'dsh' || body.asrProvider === 'local') cfg.asrProvider = body.asrProvider
    if (typeof body.asrLanguage === 'string' && body.asrLanguage.trim()) cfg.asrLanguage = body.asrLanguage.trim().slice(0, 2)
    saveTtsApi()
    const ready = useBreeze()
    if (ttsProvider === 'breeze' && !breeze.ready) {
      return sendJson(res, 200, {
        ok: true,
        provider: ttsProvider,
        ready,
        autoEmotion: breezeAutoEmotion,
        warning: '已保存，但还缺少 API Key 或 voice_id；在此之前仍用本地 TTS',
        breeze: breeze.status(),
        asrProvider: cfg.asrProvider,
        asrLanguage: cfg.asrLanguage,
      })
    }
    sendJson(res, 200, { ok: true, provider: ttsProvider, ready, autoEmotion: breezeAutoEmotion, breeze: breeze.status(), asrProvider: cfg.asrProvider, asrLanguage: cfg.asrLanguage })
  }))

  // POST /tts/test {text?} — 用当前通道试听，返回 WAV
  route('exact', '/tts/test', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const text = (typeof body.text === 'string' && body.text.trim()) ? body.text.trim().slice(0, 200) : '你好，这是语音测试。'
    const audio = await synthAudio(text, { speed: cfg.speed })
    const wav = pcm16ToWav(audio.pcm, audio.sampleRate || cfg.sr)
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' })
    res.end(wav)
  }))

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
      voiceprint: { ...voiceprint.status(), enabled: voiceprintEnabled },
      ttsApi: { provider: ttsProvider, autoEmotion: breezeAutoEmotion, breeze: breeze.status() },
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
        asrProvider: cfg.asrProvider, asrLanguage: cfg.asrLanguage,
        ttsProvider,
        breezeGuidance: breeze.guidanceScale,
        breezeSpeed: breeze.speed,
        breezeVolume: breeze.volume,
        breezeSpeakerBoost: breeze.speakerBoost,
        breezeAutoEmotion,
        callPersona: cfg.callPersona !== false,
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
  async function transcribeWithDsh(audio) {
    if (!audio || !audio.length) return { text: '', audioSeconds: 0, inferenceSeconds: 0 }
    if (!dshSpeech) throw new Error('DSH 官方语音识别服务不可用（未安装/未启用语音输入插件）')
    const pcm16 = new Int16Array(audio.length)
    for (let i = 0; i < audio.length; i++) pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32767)))
    const wav = pcm16ToWav(pcm16, 16000)
    const snapshot = dshSpeech.snapshot?.()
    const providerId = snapshot?.selection?.providerId
    if (providerId) { try { dshSpeech.prepare(providerId) } catch { /* 由 transcribe 报错 */ } }
    const spec = dshSpeech.resolve({ audio: wav, language: cfg.asrLanguage || 'zh' })
    return await dshSpeech.transcribe(spec, AbortSignal.timeout(120000))
  }

  route('exact', '/asr/start', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    resetUtterance()
    pendingGate = null
    if (cfg.asrProvider !== 'dsh') engine.asrStart()
    sendJson(res, 200, { ok: true, provider: cfg.asrProvider })
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
    if (cfg.asrProvider !== 'dsh') engine.asrFeed(f32)
    pushUtterance(f32)
    sendJson(res, 200, { ok: true, samples: f32.length })
  }))

  route('exact', '/asr/final', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const audio = drainUtterance()

    // DSH 官方识别：只有整句定稿；没有 partial，但能复用官方 SenseVoice / 云端 provider。
    if (cfg.asrProvider === 'dsh') {
      if (voiceprintEnabled && voiceprint.enrolled && voiceprint.settings.requireEnrolled) {
        const gate = audio
          ? await voiceprint.verify(audio).catch((e) => ({ ok: true, error: e?.message || String(e) }))
          : { ok: true, error: '没有音频' }
        if (gate && gate.ok === false) {
          broadcast('voiceprint', { kind: 'rejected', score: gate.score, threshold: gate.threshold })
          return sendJson(res, 200, { ok: true, rejected: true })
        }
        if (gate && gate.score != null) {
          broadcast('voiceprint', { kind: 'accepted', score: gate.score, threshold: gate.threshold, matched: gate.matched || null })
        }
      }
      try {
        const r = await transcribeWithDsh(audio)
        broadcast('asr', { kind: 'final', text: r?.text || '' })
        return sendJson(res, 200, { ok: true, provider: 'dsh', text: r?.text || '' })
      } catch (e) {
        broadcast('asr', { kind: 'warn', message: e?.message || String(e) })
        broadcast('asr', { kind: 'final', text: '' })
        return sendJson(res, 200, { ok: false, provider: 'dsh', error: e?.message || String(e) })
      }
    }

    // 本地流式：只在“仅应答已录入人员”开启时做声纹比对；关闭时所有人正常对话，
    // 省掉每次定稿约 100ms 的 embedding 推理，避免拖慢对话
    if (voiceprintEnabled && voiceprint.enrolled && voiceprint.settings.requireEnrolled) {
      pendingGate = audio
        ? voiceprint.verify(audio).catch((e) => ({ ok: true, error: e?.message || String(e) }))
        : Promise.resolve({ ok: true, error: '没有音频' })
    } else {
      pendingGate = null
    }
    engine.asrFinal()
    sendJson(res, 200, { ok: true })
  }))

  // ------------------------------------------------------------ 声纹锁
  // 把 PCM16LE / 16k WAV 统一成 Float32 单声道 16k；供注册与校验复用
  function decodeVoiceAudio(buf) {
    if (!buf || !buf.length) throw Object.assign(new Error('空音频'), { status: 400 })
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
      let fmt = null
      let data = null
      let p = 12
      while (p + 8 <= buf.length) {
        const id = buf.toString('ascii', p, p + 4)
        const size = buf.readUInt32LE(p + 4)
        const body = buf.subarray(p + 8, Math.min(p + 8 + size, buf.length))
        if (id === 'fmt ') {
          fmt = {
            channels: body.readUInt16LE(2),
            sampleRate: body.readUInt32LE(4),
            bits: body.readUInt16LE(14),
          }
        } else if (id === 'data') {
          data = body
          break
        }
        p += 8 + size + (size % 2)
      }
      if (!fmt || !data) throw Object.assign(new Error('WAV 缺少 fmt/data'), { status: 400 })
      if (fmt.bits !== 16) throw Object.assign(new Error('只支持 16bit WAV'), { status: 400 })
      const frames = Math.floor(data.length / 2 / fmt.channels)
      const mono = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2)
        mono[i] = (sum / fmt.channels) / 32768
      }
      if (fmt.sampleRate === 16000) return mono
      const ratio = fmt.sampleRate / 16000
      const n = Math.max(1, Math.floor(mono.length / ratio))
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const q = i * ratio
        const i0 = Math.floor(q)
        const i1 = Math.min(i0 + 1, mono.length - 1)
        out[i] = mono[i0] + (mono[i1] - mono[i0]) * (q - i0)
      }
      return out
    }
    if (buf.length % 2 !== 0) throw Object.assign(new Error('PCM 长度必须为偶数'), { status: 400 })
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
    const out = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
    return out
  }

  route('exact', '/voiceprint/status', withHandler(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    sendJson(res, 200, {
      ok: true,
      ...voiceprint.status(),
      enabled: voiceprintEnabled,
      modelUrl: VOICEPRINT_MODEL_URL,
      modelMirror: VOICEPRINT_MODEL_MIRROR,
      modelBytes: VOICEPRINT_MODEL_BYTES,
      modelSha256: VOICEPRINT_MODEL_SHA256,
    })
  }))

  route('exact', '/voiceprint/enable', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    if (typeof body.enabled === 'boolean') {
      voiceprintEnabled = body.enabled
      voiceprint.updateSettings({ enabled: body.enabled })
    }
    if (body.threshold != null) voiceprint.setThreshold(body.threshold)
    if (body.settings && typeof body.settings === 'object') {
      voiceprint.updateSettings(body.settings)
      if (typeof body.settings.enabled === 'boolean') voiceprintEnabled = body.settings.enabled
    }
    broadcast('voiceprint', { kind: 'status', ...voiceprint.status(), enabled: voiceprintEnabled })
    sendJson(res, 200, { ok: true, ...voiceprint.status(), enabled: voiceprintEnabled })
  }))

  route('exact', '/voiceprint/enroll', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const buf = await readBody(req, cfg.maxBodyBytes)
    const audio = decodeVoiceAudio(buf)
    if (audio.length < 16000 * 1.5) return sendJson(res, 400, { ok: false, error: '录音太短：至少 1.5 秒' })
    const r = await voiceprint.enroll({ nickname: '主人', clips: [audio] })
    broadcast('voiceprint', { kind: 'enrolled', profile: r.profile, ...voiceprint.status() })
    sendJson(res, 200, { ok: true, ...r, enabled: voiceprintEnabled })
  }))

  // 多档案注册：3 段随机话术，取平均 embedding
  route('exact', '/voiceprint/profiles', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const clips = Array.isArray(body.clips)
      ? body.clips.map((b64) => decodeVoiceAudio(Buffer.from(String(b64), 'base64')))
      : []
    if (!clips.length) return sendJson(res, 400, { ok: false, error: '缺少注册音频' })
    const r = await voiceprint.enroll({ nickname: body.nickname, clips, tone: body.tone })
    broadcast('voiceprint', { kind: 'enrolled', profile: r.profile, ...voiceprint.status() })
    sendJson(res, 200, { ok: true, ...r, enabled: voiceprintEnabled })
  }))

  route('exact', '/voiceprint/profiles/reenroll', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    if (!body.id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
    const clips = Array.isArray(body.clips)
      ? body.clips.map((b64) => decodeVoiceAudio(Buffer.from(String(b64), 'base64')))
      : []
    const r = await voiceprint.reenroll(String(body.id), { clips, nickname: body.nickname, tone: body.tone })
    broadcast('voiceprint', { kind: 'enrolled', profile: r.profile, ...voiceprint.status() })
    sendJson(res, 200, { ok: true, ...r, enabled: voiceprintEnabled })
  }))

  route('exact', '/voiceprint/profiles/update', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    if (!body.id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
    const changed = voiceprint.updateProfile(String(body.id), body)
    if (!changed) return sendJson(res, 404, { ok: false, error: '声纹不存在' })
    broadcast('voiceprint', { kind: 'status', ...voiceprint.status(), enabled: voiceprintEnabled })
    sendJson(res, 200, { ok: true, ...voiceprint.status(), enabled: voiceprintEnabled })
  }))

  route('exact', '/voiceprint/profiles/delete', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const removed = voiceprint.removeProfile(String(body.id || ''))
    if (!removed) return sendJson(res, 404, { ok: false, error: '声纹不存在' })
    broadcast('voiceprint', { kind: 'status', ...voiceprint.status(), enabled: voiceprintEnabled })
    sendJson(res, 200, { ok: true, ...voiceprint.status(), enabled: voiceprintEnabled })
  }))

  route('exact', '/voiceprint/settings', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const st = voiceprint.updateSettings(body)
    if (typeof body.enabled === 'boolean') voiceprintEnabled = body.enabled
    broadcast('voiceprint', { kind: 'status', ...st, enabled: voiceprintEnabled })
    sendJson(res, 200, { ok: true, ...st, enabled: voiceprintEnabled })
  }))

  // 测试指定档案：POST 原始 PCM16/WAV，?id=<profileId>
  route('exact', '/voiceprint/test', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    let id = ''
    try { id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || '' } catch { /* ignore */ }
    if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
    const buf = await readBody(req, cfg.maxBodyBytes)
    const audio = decodeVoiceAudio(buf)
    const r = await voiceprint.verifyProfile(id, audio)
    sendJson(res, 200, { ok: r.ok, ...r })
  }))

  route('exact', '/voiceprint/clear', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const r = voiceprint.clear()
    broadcast('voiceprint', { kind: 'cleared' })
    sendJson(res, 200, { ok: true, ...r, enabled: voiceprintEnabled })
  }))

  route('exact', '/voiceprint/verify', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const buf = await readBody(req, cfg.maxBodyBytes)
    const audio = decodeVoiceAudio(buf)
    const r = await voiceprint.verify(audio)
    sendJson(res, 200, { ok: r.ok, ...r })
  }))

  route('exact', '/voiceprint/fetch', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    res.writeHead(200, SSE_HEADERS)
    const send = (data) => sendEvent(res, 'model', { kind: 'voiceprint', ...data })
    send({ phase: 'start', bytes: VOICEPRINT_MODEL_BYTES })
    try {
      const r = await downloadVoiceprintModel(voiceprintModel, {
        onProgress: (p) => {
          send(p)
          broadcast('model', { kind: 'voiceprint', ...p })
        },
      })
      send({ phase: 'done', ...r })
      broadcast('model', { kind: 'voiceprint', phase: 'done', ...r })
      broadcast('state', engine.status())
    } catch (e) {
      send({ phase: 'error', error: e?.message || String(e) })
      broadcast('model', { kind: 'voiceprint', phase: 'error', error: e?.message || String(e) })
    } finally {
      res.end()
    }
  }))

  // POST /speak {text, speed?} → audio/wav
  route('exact', '/speak', withHandler(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJson(req, cfg.maxBodyBytes)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' })
    if (text.length > 2000) return sendJson(res, 413, { ok: false, error: 'text too long' })
    const speed = Number(body.speed) > 0 ? Number(body.speed) : cfg.speed
    let audio
    try {
      audio = await synthAudio(text, { speed })
    } catch (e) {
      if (!useBreeze() && !engine.ttsReady) return sendJson(res, 503, { ok: false, error: engine.lastError || 'TTS 未就绪' })
      throw e
    }
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
