/**
 * BreezeBlue TTS 流式适配（宿主侧，零依赖）。
 *
 * API: POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm
 * 认证: xi-api-key: brz_...
 * 输出: 24 kHz 单声道 16-bit signed LE PCM，按生成进度分块返回。
 *
 * 这里只做 HTTP 流 → Int16Array 分块；句子的拼接/播放仍由 index.js 的 TTS 队列负责。
 */

export const BREEZE_SAMPLE_RATE = 24000
export const BREEZE_DEFAULT_BASE = 'https://api.breeze.blue'

function trimBase(v) {
  return String(v || BREEZE_DEFAULT_BASE).replace(/\/+$/, '')
}

/** 从 JSON/文本错误体里取一句可读信息。 */
async function errorText(res) {
  let raw = ''
  try { raw = await res.text() } catch { /* 已断 */ }
  try {
    const j = JSON.parse(raw)
    const d = j?.detail ?? j?.error ?? j?.message
    if (typeof d === 'string') return d
    if (d && typeof d === 'object') return d.message || JSON.stringify(d)
  } catch { /* 非 JSON */ }
  return (raw || '').slice(0, 300) || `HTTP ${res.status}`
}

export class BreezeTts {
  constructor(opts = {}) {
    this.update(opts)
  }

  update(opts = {}) {
    this.baseUrl = trimBase(opts.baseUrl)
    this.apiKey = String(opts.apiKey || '')
    this.voiceId = String(opts.voiceId || '')
    this.model = String(opts.model || '')
    this.language = String(opts.language || 'zh').slice(0, 2)
    this.instructions = String(opts.instructions || '')
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000
    return this
  }

  get ready() {
    return !!(this.apiKey && this.voiceId)
  }

  /** 不暴露 key 的状态。 */
  status() {
    return {
      ready: this.ready,
      baseUrl: this.baseUrl,
      voiceId: this.voiceId,
      model: this.model,
      language: this.language,
      instructions: this.instructions,
      hasKey: !!this.apiKey,
      keyPrefix: this.apiKey ? this.apiKey.slice(0, 4) + '…' : '',
    }
  }

  /**
   * 流式合成一句话。
   * @param {string} text
   * @param {{signal?:AbortSignal}} opts
   * @returns {AsyncGenerator<Int16Array>}
   */
  async *stream(text, { signal } = {}) {
    const input = String(text || '').trim()
    if (!input) return
    if (!this.ready) throw new Error('BreezeBlue API 未配置：需要 API Key 和 voice_id')
    if (input.length > 2000) throw new Error('BreezeBlue 单次最多 2000 字')

    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=pcm&enable_logging=false`
    const body = { text: input }
    if (this.model) body.model_id = this.model
    if (this.language) body.language_code = this.language
    if (this.instructions) body.instructions = this.instructions

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'audio/pcm',
        'xi-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw new Error(`BreezeBlue ${res.status}: ${await errorText(res)}`)
    if (!res.body) throw new Error('BreezeBlue 没有返回音频流')

    const reader = res.body.getReader()
    let carry = Buffer.alloc(0)
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value || !value.length) continue
      const buf = Buffer.from(value)
      carry = carry.length ? Buffer.concat([carry, buf]) : buf
      const even = carry.length - (carry.length % 2)
      if (even > 0) {
        const pcm = new Int16Array(even / 2)
        for (let i = 0; i < pcm.length; i++) pcm[i] = carry.readInt16LE(i * 2)
        yield pcm
        carry = carry.subarray(even)
      }
    }
    if (carry.length >= 2) {
      const pcm = new Int16Array(1)
      pcm[0] = carry.readInt16LE(0)
      yield pcm
    }
  }

  /** 收集成完整 PCM（/speak、dsh-go media 用）。 */
  async synth(text, { signal } = {}) {
    const chunks = []
    let total = 0
    for await (const pcm of this.stream(text, { signal })) {
      chunks.push(pcm)
      total += pcm.length
    }
    const out = new Int16Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return { pcm: out, sampleRate: BREEZE_SAMPLE_RATE }
  }
}