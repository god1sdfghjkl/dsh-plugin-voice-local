/**
 * 声纹 embedding：ONNX（3D-Speaker CAM++ 等）+ Kaldi fbank 前端。
 *
 * 模型输入: [1, T, 80] float32；输出: [1, D] float32（D 通常 192）。
 * 相似度用余弦；embedding 统一 L2 归一化后再比较。
 */
import { existsSync, readFileSync } from 'node:fs'
import { extractFbank } from './fbank.js'

let ort = null
async function getOrt() {
  if (!ort) ort = await import('onnxruntime-node')
  return ort
}

export function l2normalize(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  const n = Math.sqrt(sum) || 1
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n
  return out
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d ? dot / d : 0
}

/** 平均多条 embedding（注册用），返回归一化后的均值 */
export function averageEmbeddings(list) {
  if (!list.length) return null
  const dim = list[0].length
  const out = new Float32Array(dim)
  for (const e of list) for (let i = 0; i < dim; i++) out[i] += e[i] / list.length
  return l2normalize(out)
}

/**
 * 读 ONNX 文件里 sha 后的 metadata 字符串（sherpa 自定义字段）。
 * 不做完整 protobuf 解析：metadata 的 key/value 都是文件中的明文，
 * 在 key 之后按可打印串取 value，足以读 normalize_samples 等。
 */
export function readOnnxMetadata(file) {
  let buf
  try { buf = readFileSync(file) } catch { return {} }
  const out = {}
  for (const key of ['normalize_samples', 'feature_normalize_type', 'framework', 'sample_rate', 'language']) {
    const idx = buf.indexOf(Buffer.from(key, 'utf8'))
    if (idx < 0) continue
    let p = idx + key.length
    // StringStringEntryProto: field1=key(tag 0x0a)，紧接 field2=value(tag 0x12, len, value)
    if (buf[p] === 0x12) {
      const len = buf[p + 1]
      if (len > 0 && len < 240 && p + 2 + len <= buf.length) {
        out[key] = buf.toString('utf8', p + 2, p + 2 + len).trim()
        continue
      }
    }
    // 兜底：按可打印串截取
    const end = Math.min(buf.length, p + 240)
    let s = ''
    for (; p < end; p++) {
      const c = buf[p]
      if (c >= 32 && c < 127) s += String.fromCharCode(c)
      else if (s) break
    }
    const m = s.match(/^[ -~]{0,80}/)
    if (m && m[0]) out[key] = m[0].trim()
  }
  return out
}

export class SpeakerEmbedder {
  constructor(session, opts = {}) {
    this.session = session
    this.modelPath = opts.modelPath || ''
    this.inputName = session.inputNames[0]
    this.outputName = session.outputNames[0]
    this.normalizeSamples = opts.normalizeSamples !== false
    this.featureNormalize = opts.featureNormalize || ''
    this.dim = 0
  }

  static async load(modelPath, opts = {}) {
    if (!modelPath || !existsSync(modelPath)) throw new Error(`声纹模型不存在：${modelPath}`)
    const meta = readOnnxMetadata(modelPath)
    const o = await getOrt()
    const session = await o.InferenceSession.create(modelPath, {
      intraOpNumThreads: opts.threads || 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    })
    return new SpeakerEmbedder(session, {
      ...opts,
      modelPath,
      // sherpa 的 metadata 优先；缺省按 3D-Speaker 常见配置
      normalizeSamples: opts.normalizeSamples ?? (meta.normalize_samples === '1' || meta.normalize_samples === 'true' || meta.normalize_samples === 'True'),
      featureNormalize: opts.featureNormalize ?? (meta.feature_normalize_type || ''),
    })
  }

  /** @param {Float32Array|number[]} samples 16k 单声道 */
  async embed(samples) {
    const { frames, dim, data } = extractFbank(samples, {
      sampleRate: 16000,
      numBins: 80,
      normalizeSamples: this.normalizeSamples,
      featureNormalize: this.featureNormalize,
    })
    if (!frames) throw new Error('音频太短，无法提取声纹')
    const o = await getOrt()
    const tensor = new o.Tensor('float32', data, [1, frames, dim])
    const feeds = {}
    feeds[this.inputName] = tensor
    const out = await this.session.run(feeds)
    const val = out[this.outputName]
    const arr = Float32Array.from(val.data)
    this.dim = arr.length
    return l2normalize(arr)
  }
}