/**
 * Kaldi 兼容 fbank（80 维）—— 只依赖纯 JS，用于声纹 embedding 前处理。
 *
 * 与 sherpa-onnx / kaldi-native-fbank 默认参数对齐：
 *   16k / 25ms 窗 / 10ms 移 / povey 窗 / remove_dc / preemph 0.97 /
 *   num_bins=80 / low_freq=20 / high_freq=-400（即 7600）/
 *   snip_edges=false / dither=0 / power spectrum / log(max(e, FLT_EPSILON))
 *
 * 参考：kaldi-native-fbank feature-window.cc / feature-fbank.cc / mel-computations.cc
 */

const FLT_EPSILON = 1.1920928955078125e-7

function melScale(f) { return 1127.0 * Math.log(1.0 + f / 700.0) }
function inverseMel(m) { return 700.0 * (Math.exp(m / 1127.0) - 1.0) }

function nextPowerOfTwo(n) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

function poveyWindow(size) {
  const w = new Float64Array(size)
  const a = (2 * Math.PI) / (size - 1)
  for (let i = 0; i < size; i++) {
    w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85)
  }
  return w
}

// 原地 radix-2 FFT（输入 re/im 长度必须为 2 的幂）
function fft(re, im) {
  const n = re.length
  // bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe
        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + len / 2] = uRe - vRe
        im[i + j + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

function buildMelBanks({ sampleRate, fftSize, numBins, lowFreq, highFreq }) {
  const nyquist = sampleRate / 2
  let high = highFreq
  if (high <= 0) high = nyquist + highFreq
  const fftBinWidth = sampleRate / fftSize
  const numFftBins = fftSize / 2 // 不含 Nyquist bin
  const melLow = melScale(lowFreq)
  const melHigh = melScale(high)
  const delta = (melHigh - melLow) / (numBins + 1)
  const banks = []
  for (let bin = 0; bin < numBins; bin++) {
    const left = melLow + bin * delta
    const center = melLow + (bin + 1) * delta
    const right = melLow + (bin + 2) * delta
    const idx = []
    for (let i = 0; i < numFftBins; i++) {
      const mel = melScale(fftBinWidth * i)
      if (mel > left && mel < right) {
        const w = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center)
        if (w > 0) idx.push({ i, w })
      }
    }
    banks.push(idx)
  }
  return banks
}

const MEL_CACHE = new Map()

/**
 * @param {Float32Array|number[]} samples 单声道浮点，[-1,1]（normalizeSamples=true 时）
 * @param {object} [opts]
 * @returns {{frames:number, dim:number, data:Float32Array}}
 */
export function extractFbank(samples, opts = {}) {
  const sampleRate = opts.sampleRate || 16000
  const frameLengthMs = opts.frameLengthMs || 25
  const frameShiftMs = opts.frameShiftMs || 10
  const numBins = opts.numBins || 80
  const lowFreq = opts.lowFreq ?? 20
  const highFreq = opts.highFreq ?? -400
  const snipEdges = opts.snipEdges ?? false
  const preemph = opts.preemphCoeff ?? 0.97
  const removeDc = opts.removeDcOffset ?? true
  const normalizeSamples = opts.normalizeSamples ?? true
  const featureNormalize = opts.featureNormalize || '' // '' | 'global-mean'
  const windowType = opts.windowType || 'povey'

  const frameLength = Math.round((sampleRate * frameLengthMs) / 1000)
  const frameShift = Math.round((sampleRate * frameShiftMs) / 1000)
  const padSize = nextPowerOfTwo(frameLength)
  const half = padSize / 2

  const n = samples.length
  let frames
  if (snipEdges) {
    frames = n < frameLength ? 0 : 1 + Math.floor((n - frameLength) / frameShift)
  } else {
    frames = Math.floor((n + frameShift / 2) / frameShift)
  }
  if (frames <= 0) return { frames: 0, dim: numBins, data: new Float32Array(0) }

  const cacheKey = `${sampleRate}:${padSize}:${numBins}:${lowFreq}:${highFreq}`
  let melBanks = MEL_CACHE.get(cacheKey)
  if (!melBanks) {
    melBanks = buildMelBanks({ sampleRate, fftSize: padSize, numBins, lowFreq, highFreq })
    MEL_CACHE.set(cacheKey, melBanks)
  }
  const win = windowType === 'povey' ? poveyWindow(frameLength) : poveyWindow(frameLength)
  const scale = normalizeSamples ? 1 : 32768

  const data = new Float32Array(frames * numBins)
  const frame = new Float64Array(padSize)
  const re = new Float64Array(padSize)
  const im = new Float64Array(padSize)

  for (let f = 0; f < frames; f++) {
    const mid = frameShift * f + Math.floor(frameShift / 2)
    const start = mid - Math.floor(frameLength / 2)
    // 取帧 + 反射补边（kaldi）
    for (let s = 0; s < frameLength; s++) {
      let idx = start + s
      if (snipEdges) {
        // snip_edges 时不会越界
      } else {
        while (idx < 0 || idx >= n) {
          if (idx < 0) idx = -idx - 1
          else idx = 2 * n - 1 - idx
        }
      }
      frame[s] = samples[idx] * scale
    }
    // remove DC
    if (removeDc) {
      let sum = 0
      for (let s = 0; s < frameLength; s++) sum += frame[s]
      const mean = sum / frameLength
      for (let s = 0; s < frameLength; s++) frame[s] -= mean
    }
    // preemphasize（倒序）
    if (preemph !== 0) {
      for (let s = frameLength - 1; s > 0; s--) frame[s] -= preemph * frame[s - 1]
      frame[0] -= preemph * frame[0]
    }
    // povey 窗
    for (let s = 0; s < frameLength; s++) frame[s] *= win[s]
    // FFT，补零到 padSize
    for (let s = 0; s < padSize; s++) {
      re[s] = s < frameLength ? frame[s] : 0
      im[s] = 0
    }
    fft(re, im)
    // power spectrum（kaldi：0..half-1，Nyquist 不参与 mel）
    const power = new Float64Array(half)
    power[0] = re[0] * re[0]
    for (let i = 1; i < half; i++) power[i] = re[i] * re[i] + im[i] * im[i]
    // mel + log
    for (let b = 0; b < numBins; b++) {
      let e = 0
      for (const { i, w } of melBanks[b]) e += power[i] * w
      data[f * numBins + b] = Math.log(Math.max(e, FLT_EPSILON))
    }
  }

  // 逐句均值归一化（3D-Speaker 的 global-mean）
  if (featureNormalize === 'global-mean' && frames > 0) {
    const mean = new Float64Array(numBins)
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < numBins; b++) mean[b] += data[f * numBins + b]
    }
    for (let b = 0; b < numBins; b++) mean[b] /= frames
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < numBins; b++) data[f * numBins + b] -= mean[b]
    }
  }

  return { frames, dim: numBins, data }
}

export const fbankInternals = { melScale, inverseMel, nextPowerOfTwo, poveyWindow, fft }