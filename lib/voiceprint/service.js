/**
 * 声纹锁服务：多档案注册 / 校验 / 本地存储。
 *
 * - 模型：3D-Speaker CAM++（中文 16k），ONNX 约 27MB，可自动下载。
 * - 相似度：余弦；默认阈值 0.70（界面 0–100 映射到 0.50–1.00）。
 * - 档案：最多 5 组，每组昵称 / 录入时间 / embedding / 语气 / 权限。
 * - 存储：$DSH_HOME/voice-local/voiceprint.json（只存 embedding，不上传）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, createWriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { SpeakerEmbedder, cosine, averageEmbeddings } from './embedding.js'

export const VOICEPRINT_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
export const VOICEPRINT_MODEL_MIRROR = 'https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases/download/voiceprint-v1/campplus_zh.onnx'
export const VOICEPRINT_MODEL_SOURCES = [VOICEPRINT_MODEL_URL, VOICEPRINT_MODEL_MIRROR]
export const VOICEPRINT_MODEL_SHA256 = 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11'
export const VOICEPRINT_MODEL_BYTES = 28281138
export const MAX_PROFILES = 5
export const DEFAULT_SETTINGS = {
  enabled: false, // 总开关持久化，重启后恢复；config.voiceprintEnabled=true 可强制覆盖
  requireEnrolled: true,
  threshold: 0.7,
  denoise: false,
  wakeMode: 'wake-then-verify', // wake-then-verify | direct
}

function sha256File(file) {
  const buf = readFileSync(file)
  return createHash('sha256').update(buf).digest('hex')
}

/** 界面 0–100 → 余弦阈值 0.50–1.00；40 → 0.70 */
export function sliderToThreshold(v) {
  const n = Math.max(0, Math.min(100, Number(v)))
  return Math.round((0.5 + (n / 100) * 0.5) * 100) / 100
}
export function thresholdToSlider(t) {
  return Math.round(((Number(t) - 0.5) / 0.5) * 100)
}

/** 去掉首尾静音：按 20ms 帧 RMS 估噪声底，保留语音前后各 120ms */
export function trimSilence(samples, { frame = 320, hop = 160, padMs = 120 } = {}) {
  const n = samples ? samples.length : 0
  if (!n) return samples || new Float32Array(0)
  if (n < frame) return samples
  const frames = []
  for (let i = 0; i + frame <= n; i += hop) {
    let sum = 0
    for (let j = 0; j < frame; j++) sum += samples[i + j] * samples[i + j]
    frames.push({ i, rms: Math.sqrt(sum / frame) })
  }
  const sorted = frames.map((f) => f.rms).sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length * 0.2)] || 0
  const peak = sorted[Math.floor(sorted.length * 0.9)] || 0
  const thr = Math.max(0.004, noise * 2.2, peak * 0.16)
  const active = frames.filter((f) => f.rms >= thr)
  if (!active.length) return samples
  const pad = Math.round(16000 * (padMs / 1000))
  const start = Math.max(0, active[0].i - pad)
  const end = Math.min(n, active[active.length - 1].i + frame + pad)
  return samples.subarray(start, end)
}

export class VoiceprintService {
  constructor(opts = {}) {
    this.modelPath = opts.modelPath || ''
    this.dataFile = opts.dataFile || ''
    this.settings = { ...DEFAULT_SETTINGS }
    this.threads = opts.threads || 1
    this.embedder = null
    this.loading = null
    this.profiles = []
    this._read()
    if (opts.threshold != null) {
      try { this.settings.threshold = Number(opts.threshold) } catch { /* ignore */ }
    }
  }

  _read() {
    if (!this.dataFile || !existsSync(this.dataFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, 'utf8'))
      this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }
      if (Array.isArray(raw.profiles)) {
        this.profiles = raw.profiles
          .filter((p) => p && Array.isArray(p.embedding) && p.embedding.length >= 64)
          .slice(0, MAX_PROFILES)
          .map((p) => this._normProfile(p))
      } else if (Array.isArray(raw.embedding) && raw.embedding.length >= 64) {
        // 旧版单档案迁移
        this.profiles = [this._normProfile({
          id: 'vp_legacy',
          nickname: '主人',
          embedding: raw.embedding,
          dim: raw.dim || raw.embedding.length,
          createdAt: raw.enrolledAt || Date.now(),
        })]
      }
    } catch { /* 损坏则视为空 */ }
  }

  _normProfile(p) {
    return {
      id: String(p.id || `vp_${Date.now()}`),
      nickname: String(p.nickname || '主人').slice(0, 20),
      embedding: Float32Array.from(p.embedding),
      dim: Number(p.dim) || p.embedding.length,
      createdAt: Number(p.createdAt) || Date.now(),
      tone: String(p.tone || 'normal'), // normal | gentle | lively
      permissions: { highRisk: !!(p.permissions && p.permissions.highRisk) },
    }
  }

  _save() {
    if (!this.dataFile) return
    mkdirSync(dirname(this.dataFile), { recursive: true })
    const tmp = this.dataFile + '.tmp'
    const payload = {
      version: 2,
      settings: this.settings,
      profiles: this.profiles.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        embedding: Array.from(p.embedding),
        dim: p.dim,
        createdAt: p.createdAt,
        tone: p.tone,
        permissions: p.permissions,
      })),
    }
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, this.dataFile)
  }

  get enrolled() { return this.profiles.length > 0 }
  get modelReady() { return !!this.modelPath && existsSync(this.modelPath) && statSync(this.modelPath).size > 1024 * 1024 }
  get threshold() { return this.settings.threshold }

  setThreshold(v) {
    const n = Number(v)
    if (!(n > 0 && n < 1)) throw new Error('阈值必须在 0~1 之间')
    this.settings.threshold = Math.round(n * 100) / 100
    this._save()
  }

  status() {
    return {
      enabled: false, // 由 index 层填
      modelReady: this.modelReady,
      modelPath: this.modelPath || '',
      enrolled: this.enrolled,
      profiles: this.profiles.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        createdAt: p.createdAt,
        dim: p.dim,
        tone: p.tone,
        permissions: p.permissions,
      })),
      maxProfiles: MAX_PROFILES,
      settings: { ...this.settings },
      threshold: this.settings.threshold,
      thresholdSlider: thresholdToSlider(this.settings.threshold),
    }
  }

  async _getEmbedder() {
    if (this.embedder) return this.embedder
    if (this.loading) return this.loading
    this.loading = (async () => {
      if (!this.modelReady) throw new Error(`声纹模型未就绪：${this.modelPath || '(未配置)'}；请先下载模型`)
      this.embedder = await SpeakerEmbedder.load(this.modelPath, { threads: this.threads })
      return this.embedder
    })()
    try { return await this.loading } finally { this.loading = null }
  }

  async _embedClips(list, label = '录音') {
    const e = await this._getEmbedder()
    const embs = []
    for (const clip of list) {
      const trimmed = trimSilence(clip)
      if (trimmed.length < 16000 * 0.8) throw new Error(`${label}有一段有效声音不到 0.8 秒，请靠近麦克风（10–20cm）重录`)
      embs.push(await e.embed(trimmed))
    }
    if (embs.length > 1) {
      let minPair = 1
      for (let i = 0; i < embs.length; i++) {
        for (let j = i + 1; j < embs.length; j++) minPair = Math.min(minPair, cosine(embs[i], embs[j]))
      }
      if (minPair < 0.5) {
        throw new Error(`三段录音差异过大（最低相似度 ${minPair.toFixed(2)}），请在安静环境用自然音量重录`)
      }
    }
    return embs
  }

  /**
   * 注册：多段音频（防回放），取平均 embedding。
   * @param {{nickname:string, clips:Float32Array[], tone?:string}} input
   */
  async enroll({ nickname, clips, tone }) {
    if (this.profiles.length >= MAX_PROFILES) throw new Error(`最多 ${MAX_PROFILES} 组声纹，请先删除一组`)
    const list = (clips || []).filter((a) => a && a.length >= 16000 * 0.8)
    if (list.length < 1) throw new Error('录音太短：至少需要 1 段有效音频')
    const embs = await this._embedClips(list, '注册')
    const avg = averageEmbeddings(embs)
    const profile = this._normProfile({
      id: `vp_${Date.now().toString(36)}`,
      nickname: String(nickname || '').trim() || '未命名',
      embedding: avg,
      dim: avg.length,
      createdAt: Date.now(),
      tone: tone || 'normal',
    })
    this.profiles.push(profile)
    this._save()
    return { profile: this.status().profiles.find((p) => p.id === profile.id), ...this.status() }
  }

  /** 与某一档案比对（测试按钮用） */
  async verifyProfile(profileId, samples) {
    const p = this.profiles.find((x) => x.id === profileId)
    if (!p) throw new Error('声纹档案不存在')
    const trimmed = trimSilence(samples)
    if (!trimmed || trimmed.length < 16000 * 0.6) return { ok: false, score: 0, reason: '有效语音太短（需要 0.6 秒以上）' }
    const e = await this._getEmbedder()
    const emb = await e.embed(trimmed)
    const score = cosine(p.embedding, emb)
    return { ok: score >= this.settings.threshold, score, threshold: this.settings.threshold, profile: p.nickname }
  }

  /** 与所有档案比对，返回最佳匹配 */
  async verify(samples) {
    if (!this.profiles.length) return { ok: false, score: 0, reason: '未注册声纹', matched: null }
    const trimmed = trimSilence(samples)
    if (!trimmed || trimmed.length < 16000 * 0.6) return { ok: false, score: 0, reason: '有效语音太短（需要 0.6 秒以上）', matched: null }
    const e = await this._getEmbedder()
    const emb = await e.embed(trimmed)
    let best = null
    for (const p of this.profiles) {
      const score = cosine(p.embedding, emb)
      if (!best || score > best.score) best = { score, profile: p }
    }
    const ok = best.score >= this.settings.threshold
    return {
      ok,
      score: best.score,
      threshold: this.settings.threshold,
      matched: ok ? { id: best.profile.id, nickname: best.profile.nickname, tone: best.profile.tone } : null,
    }
  }

  /** 重录某个档案：用新音频替换 embedding */
  async reenroll(id, { clips, nickname, tone } = {}) {
    const p = this.profiles.find((x) => x.id === id)
    if (!p) throw new Error('声纹档案不存在')
    const list = (clips || []).filter((a) => a && a.length >= 16000 * 0.8)
    if (!list.length) throw new Error('录音太短：至少需要 1 段有效音频')
    const embs = await this._embedClips(list, '重录')
    const avg = averageEmbeddings(embs)
    p.embedding = avg
    p.dim = avg.length
    p.createdAt = Date.now()
    if (nickname != null) p.nickname = String(nickname).trim().slice(0, 20) || p.nickname
    if (tone != null) p.tone = String(tone)
    this._save()
    return { profile: this.status().profiles.find((x) => x.id === id), ...this.status() }
  }

  removeProfile(id) {
    const i = this.profiles.findIndex((p) => p.id === id)
    if (i < 0) return false
    this.profiles.splice(i, 1)
    this._save()
    return true
  }

  renameProfile(id, nickname) {
    const p = this.profiles.find((x) => x.id === id)
    if (!p) return false
    p.nickname = String(nickname || '').trim().slice(0, 20) || p.nickname
    this._save()
    return true
  }

  updateProfile(id, patch = {}) {
    const p = this.profiles.find((x) => x.id === id)
    if (!p) return false
    if (patch.nickname != null) p.nickname = String(patch.nickname).trim().slice(0, 20) || p.nickname
    if (patch.tone != null) p.tone = String(patch.tone)
    if (patch.permissions && typeof patch.permissions.highRisk === 'boolean') {
      p.permissions.highRisk = patch.permissions.highRisk
    }
    this._save()
    return true
  }

  updateSettings(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.settings.enabled = patch.enabled
    if (typeof patch.requireEnrolled === 'boolean') this.settings.requireEnrolled = patch.requireEnrolled
    if (typeof patch.denoise === 'boolean') this.settings.denoise = patch.denoise
    if (patch.wakeMode === 'wake-then-verify' || patch.wakeMode === 'direct') this.settings.wakeMode = patch.wakeMode
    if (patch.threshold != null) this.setThreshold(patch.threshold)
    if (patch.thresholdSlider != null) this.setThreshold(sliderToThreshold(patch.thresholdSlider))
    this._save()
    return this.status()
  }

  clear() {
    this.profiles = []
    if (this.dataFile && existsSync(this.dataFile)) rmSync(this.dataFile, { force: true })
    return this.status()
  }
}

/** 下载声纹模型到 modelPath（.part 原子落盘 + sha256 校验） */
export async function downloadVoiceprintModel(modelPath, { onProgress, fetchImpl = fetch } = {}) {
  mkdirSync(dirname(modelPath), { recursive: true })
  const part = modelPath + '.part'
  const failures = []
  for (const source of VOICEPRINT_MODEL_SOURCES) {
    try {
      const res = await fetchImpl(source)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || VOICEPRINT_MODEL_BYTES
      const ws = createWriteStream(part)
      let received = 0
      try {
        for await (const chunk of res.body) {
          received += chunk.length
          ws.write(Buffer.from(chunk))
          onProgress?.({ phase: 'download', source, received, total, percent: total ? received / total : 0 })
        }
      } finally {
        await new Promise((resolve) => ws.end(resolve))
      }
      const sha = sha256File(part)
      if (sha !== VOICEPRINT_MODEL_SHA256) throw new Error(`校验失败（sha256 ${sha.slice(0, 12)}…）`)
      renameSync(part, modelPath)
      onProgress?.({ phase: 'done', source, received, total, percent: 1 })
      return { path: modelPath, bytes: received, sha256: sha, source }
    } catch (e) {
      rmSync(part, { force: true })
      failures.push((e && e.message ? e.message : String(e)))
    }
  }
  throw new Error(`声纹模型下载失败（已尝试 ${VOICEPRINT_MODEL_SOURCES.length} 个来源）：${failures.join('；')}`)
}