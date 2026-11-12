/**
 * TTS 引擎适配器：vits2-onnx（VITS2 家族 ONNX 图 + 中文文本前端）。
 *
 * 以前这里把输入名/采样参数/采样率写死；现在全部来自 profile
 * （见 lib/models/tts-registry.js），换音色只要换目录 + model.json。
 *
 * 默认输入名（VITS2 常见导出）：
 *   x(int64[1,T]) / x_lengths(int64[1]) / tone(int64[1,T]) / sid(int64[1])
 *   sdp_ratio / noise_scale / noise_scale_w / length_scale (float32[1])
 * 模型没声明的输入会自动跳过（不同导出可能缺 sdp_ratio 等）。
 */
import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-node'
import { textToIds } from '../../tts-text/frontend.js'

export const DEFAULT_SAMPLING = {
  sdpRatio: 0.2,
  noiseScale: 0.6,
  noiseScaleW: 0.8,
  lengthScale: 1.0,
  speakerId: 0,
}

export const DEFAULT_INPUTS = {
  phones: 'x',
  lengths: 'x_lengths',
  tones: 'tone',
  speaker: 'sid',
  sdp: 'sdp_ratio',
  noise: 'noise_scale',
  noiseW: 'noise_scale_w',
  length: 'length_scale',
}

export class Vits2OnnxEngine {
  /**
   * @param {object} profile  注册表归一化后的 profile
   * @param {object} [opts]
   * @param {number} [opts.threads=4]
   * @param {boolean} [opts.lowMemory=true] 关掉 ORT CPU arena 省内存
   */
  constructor(profile = {}, opts = {}) {
    this.profile = profile
    this.modelPath = profile.files?.model || ''
    this.configPath = profile.files?.config || ''
    this.threads = opts.threads ?? 4
    this.lowMemory = opts.lowMemory ?? true
    this.session = null
    this.inputNames = []
    this.sr = Number(profile.sampleRate || 0) || 0
    this.speakers = 0
    this.inputs = { ...DEFAULT_INPUTS, ...(profile.inputs || {}) }
    this.sampling = { ...DEFAULT_SAMPLING, ...(profile.sampling || {}) }
    if (profile.speakerId != null) this.sampling.speakerId = Number(profile.speakerId) || 0
    this.textFrontend = profile.textFrontend || 'vits2-zh'
  }

  async load() {
    const t0 = Date.now()
    if (this.textFrontend !== 'vits2-zh') {
      throw new Error(`vits2-onnx 引擎目前只支持 textFrontend=vits2-zh，收到: ${this.textFrontend}`)
    }
    if (!this.modelPath) throw new Error('TTS 模型未指定（files.model）')

    // config.json 提供采样率/说话人数，缺失时用 profile 值兜底
    if (this.configPath) {
      try {
        const cfg = JSON.parse(readFileSync(this.configPath, 'utf8'))
        this.config = cfg
        if (!this.sr) this.sr = Number(cfg.sampling_rate || cfg.sample_rate || 0) || 0
        this.speakers = Number(cfg.n_speakers || 0) || 0
        if (this.speakers > 0 && this.sampling.speakerId >= this.speakers) this.sampling.speakerId = 0
      } catch (e) {
        throw new Error(`TTS config.json 读取失败: ${e?.message || e}`)
      }
    }
    if (!this.sr) this.sr = 44100

    this.session = await ort.InferenceSession.create(this.modelPath, {
      graphOptimizationLevel: 'all',
      intraOpNumThreads: this.threads,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      enableCpuMemArena: !this.lowMemory,
    })
    this.inputNames = this.session.inputNames
    return {
      loadMs: Date.now() - t0,
      inputs: this.inputNames.slice(),
      sampleRate: this.sr,
      speakers: this.speakers,
      lowMemory: this.lowMemory,
      engine: 'vits2-onnx',
      profileId: this.profile.id,
    }
  }

  /**
   * @param {string} text
   * @param {{speed?: number, speakerId?: number}} [opts]
   * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
   */
  async synth(text, opts = {}) {
    if (!this.session) throw new Error('TTS 尚未 load()')
    const { phones, tones } = textToIds(text)
    if (!phones.length) return { samples: new Float32Array(0), sampleRate: this.sr }

    const s = { ...this.sampling }
    if (opts.speed && opts.speed > 0) s.lengthScale = 1 / opts.speed
    if (opts.speakerId != null) s.speakerId = Number(opts.speakerId) || 0

    const inputs = this.inputs
    const i64 = (arr, dims) => new ort.Tensor('int64', BigInt64Array.from(arr.map((v) => BigInt(v))), dims)
    const f32 = (v) => new ort.Tensor('float32', Float32Array.from([v]), [1])

    const feeds = {
      [inputs.phones]: i64(phones, [1, phones.length]),
      [inputs.lengths]: i64([phones.length], [1]),
      [inputs.tones]: i64(tones, [1, tones.length]),
      [inputs.speaker]: i64([s.speakerId], [1]),
      [inputs.sdp]: f32(s.sdpRatio),
      [inputs.noise]: f32(s.noiseScale),
      [inputs.noiseW]: f32(s.noiseScaleW),
      [inputs.length]: f32(s.lengthScale),
    }
    // 只喂模型声明过的输入
    for (const k of Object.keys(feeds)) {
      if (!this.inputNames.includes(k)) delete feeds[k]
    }
    const out = await this.session.run(feeds)
    const wav = out[this.session.outputNames[0]]
    const samples = wav.data instanceof Float32Array ? wav.data : Float32Array.from(wav.data)
    return { samples, sampleRate: this.sr }
  }
}
