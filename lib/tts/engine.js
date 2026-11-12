/**
 * TTS 引擎门面（宿主侧，worker 内使用）。
 *
 * 按 profile.engine 分派到具体适配器：
 *   - vits2-onnx        VITS2 家族 ONNX（自带中文文本前端）
 *   - sherpa-offline-tts sherpa-onnx 多模型运行时（vits/piper/melo/matcha/kokoro…）
 *
 * profile 由 lib/models/tts-registry.js 生成；构造函数也接受旧的字符串路径写法，
 * 便于老代码/测试直接传 onnx 路径。
 *
 * 统一返回：{ samples: Float32Array, sampleRate: number }
 */
import { Vits2OnnxEngine, DEFAULT_SAMPLING } from './engines/vits2.js'
import { SherpaOfflineTtsEngine } from './engines/sherpa.js'

export { DEFAULT_SAMPLING }
export { Vits2OnnxEngine, SherpaOfflineTtsEngine }

export class TtsEngine {
  /**
   * @param {object|string} profileOrPath 注册表 profile，或旧的 onnx 路径
   * @param {object} [opts] { threads, sr, lowMemory, sampling }
   */
  constructor(profileOrPath, opts = {}) {
    let profile
    if (typeof profileOrPath === 'string') {
      profile = {
        id: 'legacy',
        name: 'legacy',
        engine: 'vits2-onnx',
        dir: '',
        files: { model: profileOrPath },
        sampleRate: opts.sr,
        speakerId: 0,
        speed: 1,
        textFrontend: 'vits2-zh',
        inputs: {},
        sampling: opts.sampling || {},
        sherpa: {},
      }
    } else {
      profile = profileOrPath || {}
    }
    this.profile = profile
    this.sr = Number(profile.sampleRate || opts.sr || 0) || 0
    this.impl = TtsEngine.createImpl(profile, opts)
  }

  static createImpl(profile, opts = {}) {
    const engine = profile.engine
    if (engine === 'vits2-onnx') return new Vits2OnnxEngine(profile, opts)
    if (engine === 'sherpa-offline-tts') return new SherpaOfflineTtsEngine(profile, opts)
    throw new Error(`不支持的 TTS engine: ${engine || '(未指定)'}`)
  }

  async load() {
    const info = await this.impl.load()
    if (info && info.sampleRate) this.sr = info.sampleRate
    return { ...info, engine: this.profile.engine, profileId: this.profile.id }
  }

  /**
   * @param {string} text
   * @param {{speed?: number, speakerId?: number}} [opts]
   * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
   */
  async synth(text, opts = {}) {
    const r = await this.impl.synth(text, opts)
    if (r && r.sampleRate) this.sr = r.sampleRate
    return r
  }

  free() {
    try { this.impl?.free?.() } catch { /* 已释放 */ }
    this.impl = null
  }

  /** float32 → Int16 PCM（浏览器 WebAudio 友好） */
  static toPcm16(f32) {
    const out = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) {
      let v = f32[i]
      if (v > 1) v = 1
      else if (v < -1) v = -1
      out[i] = Math.round(v * 32767)
    }
    return out
  }
}
