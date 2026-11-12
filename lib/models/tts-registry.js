/**
 * TTS 模型注册表（宿主侧，零依赖）。
 *
 * 目标：TTS 模型可随意替换 —— 不再把路径/文件名/输入名写死在引擎里。
 *
 * 模型目录约定（两种都支持）：
 *
 *   <dataRoot>/models/tts/
 *     ├── tl196m/                 # 一个模型 = 一个子目录
 *     │   ├── model.json          # 可选：显式描述（引擎、文件、采样参数、输入名）
 *     │   ├── model.onnx
 *     │   └── config.json         # vits2 引擎用：sampling_rate / n_speakers
 *     └── melo-zh/
 *         ├── model.json
 *         ├── model.onnx
 *         ├── tokens.txt
 *         └── lexicon.txt         # sherpa vits 前端需要
 *
 * 也允许 modelsDir 本身就是一个模型目录（直接放 model.onnx + model.json）。
 *
 * model.json（全部字段可省，省掉时按文件特征自动探测）：
 *
 *   {
 *     "id": "tl196m",                      // 唯一 id，默认=目录名
 *     "name": "自定义音色",                 // 展示名
 *     "engine": "vits2-onnx",              // vits2-onnx | sherpa-offline-tts
 *     "files": {                           // 相对模型目录的路径
 *       "model": "model.onnx",
 *       "config": "config.json",
 *       "tokens": "tokens.txt",
 *       "lexicon": "lexicon.txt"
 *     },
 *     "sampleRate": 44100,                 // 可省：vits2 从 config.json 读
 *     "speakerId": 0,
 *     "textFrontend": "vits2-zh",          // vits2 引擎必填（目前支持 vits2-zh）
 *     "inputs": {                          // 可省：ONNX 输入名映射
 *       "phones": "x", "lengths": "x_lengths", "tones": "tone",
 *       "speaker": "sid", "length": "length_scale"
 *     },
 *     "sampling": { "noiseScale": 0.6, "noiseScaleW": 0.8, "sdpRatio": 0.2, "lengthScale": 1 },
 *     "sherpa": {                          // sherpa-offline-tts 用
 *       "modelType": "vits",               // vits | matcha | kokoro | kitten | …
 *       "ruleFsts": "",                    // 可省，相对路径会解析到模型目录
 *       "silenceScale": 0.2,
 *       "modelConfig": { ... }             // 高级：直接透传 sherpa 的 offlineTtsModelConfig
 *     }
 *   }
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const TTS_ENGINES = ['vits2-onnx', 'sherpa-offline-tts']
export const TEXT_FRONTENDS = ['vits2-zh']

const ONNX_RE = /\.onnx$/i
const PATH_VALUE_RE = /\.(onnx|txt|bin|json|fst|onnx\.json)$/i

function safeList(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

export function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function pickMainOnnx(files) {
  const onnx = files.filter((f) => ONNX_RE.test(f))
  if (!onnx.length) return ''
  const prefer = ['model.onnx', 'model.int8.onnx', 'model-fp32.onnx']
  for (const p of prefer) if (onnx.includes(p)) return p
  // 没有标准名时取名字最短的（一般就是主模型，而不是 vocoder/辅助图）
  return onnx.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
}

/**
 * 按文件特征猜引擎。返回 { engine, files, sherpa?, textFrontend? } 或 null。
 */
export function detectTtsEngine(dir) {
  const files = safeList(dir)
  const model = pickMainOnnx(files)
  if (!model) return null
  const hasTokens = files.includes('tokens.txt')
  const lexicon = files.find((f) => /^lexicon.*\.txt$/i.test(f)) || ''
  const hasConfig = files.includes('config.json')

  // 有 config.json 且像 vits2 导出（含 sampling_rate 或 symbols）→ vits2
  if (hasConfig) {
    const cfg = readJsonFile(join(dir, 'config.json'))
    const looksVits2 = cfg && (cfg.sampling_rate || cfg.sample_rate || cfg.symbols || cfg.n_speakers)
    if (looksVits2) {
      return { engine: 'vits2-onnx', files: { model, config: 'config.json' }, textFrontend: 'vits2-zh' }
    }
  }

  // 有 tokens.txt（以及常见 lexicon）→ sherpa-onnx vits 家族
  if (hasTokens) {
    return {
      engine: 'sherpa-offline-tts',
      files: { model, tokens: 'tokens.txt', ...(lexicon ? { lexicon } : {}) },
      sherpa: { modelType: 'vits' },
    }
  }

  // 退化：单个 onnx，按 vits2（无 config 时采样率靠 profile.sampleRate）
  return { engine: 'vits2-onnx', files: { model }, textFrontend: 'vits2-zh' }
}

/** 把相对路径解析成绝对路径（保留空串） */
function absoluteFiles(files, dir) {
  const out = {}
  for (const [k, v] of Object.entries(files || {})) {
    if (typeof v !== 'string' || !v) continue
    out[k] = isAbsolute(v) ? v : resolve(dir, v)
  }
  return out
}

export function validateTtsProfile(profile) {
  const problems = []
  if (!profile || !profile.engine) {
    problems.push('未指定 engine')
    return problems
  }
  if (!TTS_ENGINES.includes(profile.engine)) {
    problems.push(`不支持的 engine: ${profile.engine}（可选 ${TTS_ENGINES.join(' / ')}）`)
    return problems
  }
  const files = profile.files || {}
  const need = (key, label, optional) => {
    if (!files[key]) {
      if (!optional) problems.push(`缺少 files.${key}（${label}）`)
      return
    }
    if (!existsSync(files[key])) problems.push(`${label}不存在: ${files[key]}`)
  }

  if (profile.engine === 'vits2-onnx') {
    need('model', 'TTS ONNX 模型')
    need('config', '模型 config.json', true)
    if (profile.textFrontend && !TEXT_FRONTENDS.includes(profile.textFrontend)) {
      problems.push(`不支持的文本前端: ${profile.textFrontend}（目前支持 ${TEXT_FRONTENDS.join(' / ')}）`)
    }
  } else {
    const sherpa = profile.sherpa || {}
    if (sherpa.modelConfig) {
      // 高级透传：只校验里面出现、看着像文件路径的字段
      const strings = collectStrings(sherpa.modelConfig).filter((s) => PATH_VALUE_RE.test(s))
      for (const s of strings) {
        const p = isAbsolute(s) ? s : resolve(profile.dir || '.', s)
        if (!existsSync(p)) problems.push(`模型文件不存在: ${p}`)
      }
    } else {
      need('model', 'sherpa 模型')
      need('tokens', 'tokens.txt')
    }
  }
  return problems
}

function collectStrings(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out }
  if (Array.isArray(obj)) { for (const v of obj) collectStrings(v, out); return out }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) collectStrings(v, out) }
  return out
}

/** 归一化：raw(model.json) + 目录自动探测 → 完整 profile */
export function normalizeTtsProfile(raw, dir) {
  const detected = detectTtsEngine(dir) || {}
  const meta = raw || {}
  const engine = meta.engine || detected.engine || ''
  const merged = { ...(detected.files || {}), ...(meta.files || {}) }
  const profile = {
    id: meta.id || basename(dir),
    name: meta.name || meta.id || basename(dir),
    engine,
    dir,
    files: absoluteFiles(merged, dir),
    sampleRate: Number(meta.sampleRate || 0) || undefined,
    speakerId: meta.speakerId ?? 0,
    speed: meta.speed ?? 1,
    textFrontend: meta.textFrontend || detected.textFrontend || '',
    inputs: meta.inputs || {},
    sampling: meta.sampling || {},
    sherpa: { ...(detected.sherpa || {}), ...(meta.sherpa || {}) },
    // 可选下载清单（见 lib/models/downloader.js）
    download: Array.isArray(meta.download) ? meta.download : [],
  }
  profile.problems = validateTtsProfile(profile)
  return profile
}

/** 旧配置（ttsOnnx 直接指 .onnx）兼容 */
export function legacyTtsProfile({ onnxPath, configPath = '', sampleRate, speakerId = 0, name = '自定义音色（旧配置）' } = {}) {
  const dir = onnxPath ? dirname(onnxPath) : ''
  const profile = {
    id: 'legacy',
    name,
    engine: 'vits2-onnx',
    dir,
    files: absoluteFiles({ model: onnxPath, config: configPath }, dir || '.'),
    sampleRate: Number(sampleRate || 0) || undefined,
    speakerId,
    speed: 1,
    textFrontend: 'vits2-zh',
    inputs: {},
    sampling: {},
    sherpa: {},
    download: [],
    legacy: true,
  }
  profile.problems = validateTtsProfile(profile)
  return profile
}

function profileFromDir(dir) {
  const meta = readJsonFile(join(dir, 'model.json'))
  if (meta) return normalizeTtsProfile({ ...meta, id: meta.id || basename(dir) }, dir)
  const detected = detectTtsEngine(dir)
  if (!detected) return null
  return normalizeTtsProfile({ id: basename(dir) }, dir)
}

/**
 * 扫描模型目录，返回 profile 列表（含不兼容项，problems 说明原因）。
 * @param {{ modelsDir?: string, legacy?: object }} opts
 */
export function scanTtsProfiles({ modelsDir, legacy } = {}) {
  const list = []
  const seen = new Set()
  const add = (p) => {
    if (!p || !p.id) return
    if (seen.has(p.id)) return
    seen.add(p.id)
    list.push(p)
  }
  if (legacy) add(legacy)
  if (modelsDir && existsSync(modelsDir)) {
    const entries = safeList(modelsDir)
    const looksLikeSingle = entries.some((f) => f === 'model.json' || ONNX_RE.test(f))
    if (looksLikeSingle) {
      add(profileFromDir(modelsDir))
    } else {
      for (const name of entries) {
        const sub = join(modelsDir, name)
        if (!isDir(sub)) continue
        add(profileFromDir(sub))
      }
    }
  }
  return list
}

/** 选默认模型：显式 id > 第一个可用 */
export function pickDefaultTtsProfile(profiles, { preferredId = '' } = {}) {
  const list = Array.isArray(profiles) ? profiles : []
  if (preferredId) {
    const hit = list.find((p) => p.id === preferredId)
    if (hit) return hit
  }
  return list.find((p) => !(p.problems && p.problems.length)) || null
}

/** 给 HTTP/状态接口用的精简视图（不带内部字段） */
export function publicTtsProfile(profile) {
  if (!profile) return null
  return {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    path: profile.dir,
    sampleRate: profile.sampleRate || 0,
    speakerId: profile.speakerId ?? 0,
    ok: !(profile.problems && profile.problems.length),
    problems: profile.problems || [],
  }
}
