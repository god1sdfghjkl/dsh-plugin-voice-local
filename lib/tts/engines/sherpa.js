/**
 * TTS 引擎适配器：sherpa-offline-tts（sherpa-onnx 的多模型 TTS 运行时）。
 *
 * 好处：一套适配器覆盖 sherpa-onnx 支持的模型家族（vits / melo-tts / piper /
 * matcha / kokoro / kitten / zipvoice …），模型目录丢进 dataRoot 就能用，
 * 不用为每个模型写一份推理代码。
 *
 * profile.sherpa 字段（均可省）：
 *   modelType   "vits" | "matcha" | "kokoro" | "kitten" | …
 *   ruleFsts    文本正则（逗号分隔，相对路径会解析到模型目录）
 *   ruleFars
 *   silenceScale
 *   noiseScale / noiseScaleW / lengthScale
 *   modelConfig  高级：直接透传给 sherpa 的 offlineTtsModelConfig
 *                （例如 { "vits": { "model": "model.onnx", "tokens": "tokens.txt", "lexicon": "lexicon.txt" } }）
 */
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const PATH_EXT_RE = /\.(onnx|txt|bin|json|fst)$/i
const PATH_SEP_RE = /[\\/]/

/** 判断一个字符串是否像「相对文件路径」，像才 resolve，避免把 language:'zh' 等当成路径 */
function looksLikePath(v) {
  return typeof v === 'string' && v.length > 0 &&
    (PATH_SEP_RE.test(v) || PATH_EXT_RE.test(v)) &&
    !/^[a-z]+:[\\/]{2}/i.test(v) // http(s): 之类保持原样
}

function resolveDeep(value, dir) {
  if (typeof value === 'string') {
    if (!looksLikePath(value)) return value
    return isAbsolute(value) ? value : resolve(dir, value)
  }
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, dir))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, dir)
    return out
  }
  return value
}

function resolveRuleList(list, dir) {
  if (!list) return ''
  return String(list)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (isAbsolute(s) ? s : resolve(dir, s)))
    .join(',')
}

export class SherpaOfflineTtsEngine {
  constructor(profile = {}, opts = {}) {
    this.profile = profile
    this.threads = opts.threads ?? 1
    this.tts = null
    this.sr = Number(profile.sampleRate || 0) || 0
    this.speakers = 0
  }

  async load() {
    const { createOfflineTts } = require('sherpa-onnx')
    const t0 = Date.now()
    const config = this.buildConfig()
    this.tts = createOfflineTts(config)
    this.sr = Number(this.tts.sampleRate || this.sr || 0) || 44100
    this.speakers = Number(this.tts.numSpeakers || 1) || 1
    return {
      loadMs: Date.now() - t0,
      sampleRate: this.sr,
      speakers: this.speakers,
      engine: 'sherpa-offline-tts',
      profileId: this.profile.id,
    }
  }

  buildConfig() {
    const dir = this.profile.dir || '.'
    const sherpa = this.profile.sherpa || {}
    const base = {
      numThreads: this.threads,
      provider: 'cpu',
      debug: 0,
    }

    // 高级：完整透传 offlineTtsModelConfig
    if (sherpa.modelConfig) {
      return {
        offlineTtsModelConfig: { ...resolveDeep(sherpa.modelConfig, dir), ...base },
        ruleFsts: resolveRuleList(sherpa.ruleFsts, dir),
        ruleFars: resolveRuleList(sherpa.ruleFars, dir),
        maxNumSentences: Number(sherpa.maxNumSentences ?? 1) || 1,
        silenceScale: Number(sherpa.silenceScale ?? 0.2),
      }
    }

    const files = this.profile.files || {}
    const type = sherpa.modelType || 'vits'
    const modelConfig = {}

    if (type === 'vits') {
      modelConfig.vits = {
        model: files.model || '',
        tokens: files.tokens || '',
        lexicon: files.lexicon || '',
        noiseScale: Number(sherpa.noiseScale ?? 0.667),
        noiseScaleW: Number(sherpa.noiseScaleW ?? 0.8),
        lengthScale: Number(sherpa.lengthScale ?? 1.0),
      }
    } else if (type === 'matcha') {
      modelConfig.matcha = {
        acousticModel: files.acousticModel || files.model || '',
        vocoder: files.vocoder || '',
        tokens: files.tokens || '',
        lexicon: files.lexicon || '',
        noiseScale: Number(sherpa.noiseScale ?? 0.667),
        lengthScale: Number(sherpa.lengthScale ?? 1.0),
      }
    } else if (type === 'kokoro' || type === 'kitten') {
      modelConfig[type] = {
        model: files.model || '',
        voices: files.voices || '',
        tokens: files.tokens || '',
        lexicon: files.lexicon || '',
        lengthScale: Number(sherpa.lengthScale ?? 1.0),
      }
    } else {
      // 其它家族：要求用 modelConfig 透传，避免猜错字段
      throw new Error(`sherpa-offline-tts 暂不内置 modelType=${type}；请用 profile.sherpa.modelConfig 透传`)
    }

    return {
      offlineTtsModelConfig: { ...modelConfig, ...base },
      ruleFsts: resolveRuleList(sherpa.ruleFsts, dir),
      ruleFars: resolveRuleList(sherpa.ruleFars, dir),
      maxNumSentences: Number(sherpa.maxNumSentences ?? 1) || 1,
      silenceScale: Number(sherpa.silenceScale ?? 0.2),
    }
  }

  /**
   * @param {string} text
   * @param {{speed?: number, speakerId?: number}} [opts]
   * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
   */
  async synth(text, opts = {}) {
    if (!this.tts) throw new Error('TTS 尚未 load()')
    const sid = Number(opts.speakerId ?? this.profile.speakerId ?? 0) || 0
    const speed = Number(opts.speed || 1) || 1
    const r = this.tts.generate({ text, sid, speed })
    const samples = r.samples instanceof Float32Array ? r.samples : Float32Array.from(r.samples)
    return { samples, sampleRate: Number(r.sampleRate || this.sr) || this.sr }
  }

  free() {
    try { this.tts?.free?.() } catch { /* 已释放 */ }
    this.tts = null
  }
}
