/**
 * ASR worker（worker_threads，sherpa-onnx WASM）。
 *
 * 双流架构（与 Python asr_stream.DualASR 一致）：
 *   - 流式 zipformer：边说边出字，用于字幕（错了用户知道自己在说什么）
 *   - 离线 SenseVoice：整句定稿，用于发给 Agent 的文本（准确、带标点）
 *
 * 为什么用 WASM 版而不是原生 addon：
 *   DSH 桌面版跑在 Electron 里，V8 对原生 addon 返回外部缓冲有额外限制
 *   （dsh-voice-mode 踩过 Kokoro 的坑）。WASM 版没有这个限制。
 *
 * 适配 sherpa-onnx 2.0.1（2026-11 官方 JS/WASM 包）：
 *   - 识别器配置改成嵌套结构：{ featConfig, modelConfig: { transducer/tokens/... } }
 *     旧版的扁平 { tokens, encoder, decoder, joiner } 在 2.0.1 会抛
 *     "Cannot use 'in' operator to search for 'transducer' in undefined"。
 *   - 离线识别是 createStream() → acceptWaveform() → decode(stream) → getResult()
 *     （没有 inputFinished()，也没有 decodeStream()）。
 *   - 本 WASM 构建不支持多线程，numThreads 会被强制为 1，这里直接传 1 以免日志噪音。
 *
 * 协议：
 *   → { type: 'load', streaming, final, threads }   // streaming/final 都是模型 profile（见 lib/models/asr-registry.js）
 *   → { type: 'start' }
 *   → { type: 'feed', pcm: Float32Array }   16k 单声道 f32
 *   → { type: 'final' }
 *   → { type: 'close' }
 *   ← { type: 'loaded', final: boolean, streamingId, finalId }
 *   ← { type: 'partial', text }
 *   ← { type: 'final', text }
 *   ← { type: 'endpoint' }
 *   ← { type: 'warn', message }
 *   ← { type: 'error', message }
 */
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx')

if (!parentPort) throw new Error('asr-worker 必须在 worker_threads 中运行')

const SR = 16000
const PAD = new Float32Array(SR / 2)   // 0.5s 静音尾垫

let online = null
let offline = null
let stream = null
let segment = []          // 本段全部 PCM（离线定稿用）
let lastPartial = ''
let active = false
let info = { streamingId: '', finalId: '' }

function makeOnline(profile) {
  const files = profile.files || {}
  const opt = profile.options || {}
  if (opt.sherpa) {
    return sherpa.createOnlineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      ...opt.sherpa,
    })
  }
  const type = profile.type || 'transducer'
  if (type !== 'transducer') throw new Error(`流式识别暂不支持 type=${type}（可用 options.sherpa 透传配置）`)
  return sherpa.createOnlineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: opt.modelType || '',
      modelingUnit: opt.modelingUnit || 'cjkchar',
      bpeVocab: opt.bpeVocab || '',
    },
    decodingMethod: opt.decodingMethod || 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: opt.enableEndpoint ?? 1,
    // 端点检测（与 Python 侧一致，可被 profile.options 覆盖）
    rule1MinTrailingSilence: opt.rule1MinTrailingSilence ?? 2.4,
    rule2MinTrailingSilence: opt.rule2MinTrailingSilence ?? 1.2,
    rule3MinUtteranceLength: opt.rule3MinUtteranceLength ?? 15.0,
    hotwordsFile: '',
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
    ruleFsts: '',
    ruleFars: '',
  })
}

function makeOffline(profile) {
  const files = profile.files || {}
  const opt = profile.options || {}
  if (opt.sherpa) {
    return sherpa.createOfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      ...opt.sherpa,
    })
  }
  const type = profile.type || 'sense_voice'
  const modelConfig = { tokens: files.tokens, numThreads: 1, provider: 'cpu', debug: 0 }
  if (type === 'sense_voice') {
    modelConfig.senseVoice = {
      model: files.model,
      language: opt.language || 'zh',
      useInverseTextNormalization: opt.useItn ?? 1,
    }
    modelConfig.modelType = 'sense_voice'
  } else if (type === 'paraformer') {
    modelConfig.paraformer = { model: files.model }
    modelConfig.modelType = 'paraformer'
  } else if (type === 'whisper') {
    modelConfig.whisper = {
      encoder: files.encoder,
      decoder: files.decoder,
      language: opt.language || 'en',
      tailPaddings: opt.tailPaddings ?? 1000,
    }
    modelConfig.modelType = 'whisper'
  } else if (type === 'transducer') {
    modelConfig.transducer = { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner }
    modelConfig.modelType = 'transducer'
  } else if (type === 'nemo_ctc') {
    modelConfig.nemoCtc = { model: files.model }
    modelConfig.modelType = 'nemo_ctc'
  } else {
    throw new Error(`定稿识别暂不支持 type=${type}（可用 options.sherpa 透传配置）`)
  }
  return sherpa.createOfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig,
    decodingMethod: opt.decodingMethod || 'greedy_search',
  })
}

/** 兼容旧参数（streamDir / sensevoiceDir 直接字符串） */
function legacyStreamingProfile(dir) {
  const files = {
    tokens: `${dir}/tokens.txt`,
    encoder: `${dir}/encoder-epoch-99-avg-1.int8.onnx`,
    decoder: `${dir}/decoder-epoch-99-avg-1.int8.onnx`,
    joiner: `${dir}/joiner-epoch-99-avg-1.int8.onnx`,
  }
  return { id: 'legacy-streaming', role: 'streaming', engine: 'sherpa-streaming-transducer', type: 'transducer', dir, files, options: {} }
}
function legacyFinalProfile(dir) {
  return {
    id: 'legacy-final', role: 'final', engine: 'sherpa-offline', type: 'sense_voice', dir,
    files: { tokens: `${dir}/tokens.txt`, model: `${dir}/model.int8.onnx` },
    options: { language: 'zh', useItn: 1 },
  }
}

function beginSegment() {
  if (!online) return
  try { stream?.free?.() } catch { /* 已释放 */ }
  stream = online.createStream()
  segment = []
  lastPartial = ''
  active = true
}

function decodeStream(st) {
  while (online.isReady(st)) online.decode(st)
}

function offlineFinalize() {
  if (!offline || !segment.length) return null
  const merged = segment.length === 1 ? segment[0] : concatPcm(segment)
  const s = offline.createStream()
  try {
    s.acceptWaveform(SR, merged)
    offline.decode(s)
    const r = offline.getResult(s)
    const text = (r?.text || '').trim()
    return text || null
  } finally {
    try { s.free?.() } catch { /* 已释放 */ }
  }
}

function concatPcm(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'load') {
      const streaming = msg.streaming || (msg.streamDir ? legacyStreamingProfile(msg.streamDir) : null)
      const final = msg.final || (msg.sensevoiceDir ? legacyFinalProfile(msg.sensevoiceDir) : null)
      if (!streaming) throw new Error('ASR 未配置流式模型（streaming / asrStreamDir）')
      online = makeOnline(streaming)
      offline = final ? makeOffline(final) : null
      info = { streamingId: streaming.id || '', finalId: final ? (final.id || '') : '' }
      beginSegment()
      parentPort.postMessage({ type: 'loaded', final: !!offline, ...info })
      return
    }

    if (msg.type === 'start') {
      beginSegment()
      return
    }

    if (msg.type === 'feed') {
      if (!online) throw new Error('ASR 未加载')
      if (!active) beginSegment()
      const pcm = msg.pcm instanceof Float32Array ? msg.pcm : new Float32Array(msg.pcm)
      stream.acceptWaveform(SR, pcm)
      segment.push(pcm)
      decodeStream(stream)

      if (online.isEndpoint(stream)) {
        parentPort.postMessage({ type: 'endpoint' })
      }
      const text = online.getResult(stream).text || ''
      if (text && text !== lastPartial) {
        lastPartial = text
        parentPort.postMessage({ type: 'partial', text })
      }
      return
    }

    if (msg.type === 'final') {
      if (!online) throw new Error('ASR 未加载')
      // 补 0.5s 静音尾巴，让最后几个字落地
      stream.acceptWaveform(SR, PAD)
      decodeStream(stream)
      const streamText = (online.getResult(stream).text || '').trim()

      let finalText = streamText
      if (offline && segment.length) {
        try {
          const sv = offlineFinalize()
          if (sv) finalText = sv
        } catch (e) {
          parentPort.postMessage({ type: 'warn', message: `定稿失败：${e?.message || e}` })
        }
      }

      beginSegment()
      parentPort.postMessage({ type: 'final', text: finalText })
      return
    }

    if (msg.type === 'close') {
      try { stream?.free?.() } catch { /* 已释放 */ }
      process.exit(0)
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) })
  }
})
