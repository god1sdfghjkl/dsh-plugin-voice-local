/**
 * ASR 模型注册表（宿主侧，零依赖）。
 *
 * 与 TTS 注册表同思路：把 sherpa-onnx 模型目录放进来即可换识别模型，
 * 目录结构：
 *
 *   <dataRoot>/models/asr/
 *     ├── streaming/<id>/          # 流式识别（实时字幕），必需
 *     │   ├── model.json           # 可选；省掉则按文件特征探测
 *     │   ├── tokens.txt
 *     │   ├── encoder*.onnx
 *     │   ├── decoder*.onnx
 *     │   └── joiner*.onnx
 *     └── final/<id>/              # 整句定稿（更准、带标点），可选
 *         ├── model.json
 *         ├── model*.onnx
 *         └── tokens.txt
 *
 * model.json（全部字段可省）：
 *
 *   {
 *     "id": "zh-streaming",
 *     "name": "Zipformer 中文流式",
 *     "role": "streaming",                    // streaming | final
 *     "type": "transducer",                   // streaming: transducer
 *                                             // final: sense_voice | whisper | paraformer | transducer | nemo_ctc
 *     "files": {                              // 相对模型目录；可只写其中几个
 *       "tokens": "tokens.txt",
 *       "encoder": "encoder-epoch-99-avg-1.int8.onnx",
 *       "decoder": "decoder-epoch-99-avg-1.int8.onnx",
 *       "joiner": "joiner-epoch-99-avg-1.int8.onnx",
 *       "model": "model.int8.onnx"
 *     },
 *     "options": {
 *       "modelingUnit": "cjkchar",            // 流式：cjkchar | bpe
 *       "bpeVocab": "",                       // 流式 bpe 用
 *       "language": "zh",                     // 定稿：language
 *       "sherpa": { ... }                     // 高级：直接透传 sherpa 识别器配置（路径相对模型目录）
 *     }
 *   }
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

export const ROLES = ['streaming', 'final']
export const STREAMING_TYPES = ['transducer']
export const FINAL_TYPES = ['sense_voice', 'whisper', 'paraformer', 'transducer', 'nemo_ctc']
export const ASR_ENGINES = ['sherpa-streaming-transducer', 'sherpa-offline']

const ONNX_RE = /\.onnx$/i

function safeList(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}
export function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function pickByPattern(files, patterns) {
  for (const re of patterns) {
    const hit = files.find((f) => re.test(f))
    if (hit) return hit
  }
  return ''
}

/** 按文件特征猜（流式 / 定稿） */
export function detectAsrFiles(dir, role) {
  const files = safeList(dir)
  if (!files.length) return null
  const tokens = files.includes('tokens.txt') ? 'tokens.txt' : ''
  if (role === 'streaming') {
    const encoder = pickByPattern(files, [/^encoder.*\.onnx$/i, /encoder.*\.onnx$/i])
    const decoder = pickByPattern(files, [/^decoder.*\.onnx$/i, /decoder.*\.onnx$/i])
    const joiner = pickByPattern(files, [/^joiner.*\.onnx$/i, /joiner.*\.onnx$/i])
    if (!encoder || !decoder || !joiner) return null
    return {
      engine: 'sherpa-streaming-transducer',
      type: 'transducer',
      files: { tokens, encoder, decoder, joiner },
    }
  }
  const model = pickByPattern(files, [/^model\.int8\.onnx$/i, /^model\.onnx$/i, ONNX_RE])
  if (!model) return null
  return {
    engine: 'sherpa-offline',
    type: 'sense_voice',
    files: { tokens, model },
  }
}

function absoluteFiles(files, dir) {
  const out = {}
  for (const [k, v] of Object.entries(files || {})) {
    if (typeof v !== 'string' || !v) continue
    out[k] = isAbsolute(v) ? v : resolve(dir, v)
  }
  return out
}

const STRING_PATH_RE = /\.(onnx|txt|bin|json|fst)$/i
function resolveDeep(value, dir) {
  if (typeof value === 'string') {
    if (!STRING_PATH_RE.test(value) && !/[\\/]/.test(value)) return value
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

export function validateAsrProfile(profile) {
  const problems = []
  if (!profile || !profile.role || !ROLES.includes(profile.role)) {
    problems.push(`role 必须是 ${ROLES.join(' / ')}`)
    return problems
  }
  const engine = profile.engine
  if (!ASR_ENGINES.includes(engine)) {
    problems.push(`不支持的 engine: ${engine || '(未指定)'}`)
    return problems
  }
  if (profile.options?.sherpa) return problems // 高级透传：交给运行时校验

  const files = profile.files || {}
  const need = (key, label, optional) => {
    if (!files[key]) { if (!optional) problems.push(`缺少 files.${key}（${label}）`); return }
    if (!existsSync(files[key])) problems.push(`${label}不存在: ${files[key]}`)
  }
  if (profile.role === 'streaming') {
    if (!STREAMING_TYPES.includes(profile.type)) {
      problems.push(`流式暂不支持 type=${profile.type}；请用 options.sherpa 透传`)
      return problems
    }
    need('tokens', 'tokens.txt')
    need('encoder', 'encoder')
    need('decoder', 'decoder')
    need('joiner', 'joiner')
  } else {
    if (!FINAL_TYPES.includes(profile.type)) {
      problems.push(`定稿暂不支持 type=${profile.type}；请用 options.sherpa 透传`)
      return problems
    }
    need('tokens', 'tokens.txt')
    if (profile.type === 'whisper') {
      need('encoder', 'whisper encoder')
      need('decoder', 'whisper decoder')
    } else if (profile.type === 'transducer') {
      need('encoder', 'encoder'); need('decoder', 'decoder'); need('joiner', 'joiner')
    } else {
      need('model', '模型')
    }
  }
  return problems
}

export function normalizeAsrProfile(raw, dir, role) {
  const detected = detectAsrFiles(dir, role) || {}
  const meta = raw || {}
  const finalRole = meta.role || role || (detected.engine ? (detected.engine === 'sherpa-streaming-transducer' ? 'streaming' : 'final') : '')
  const mergedFiles = { ...(detected.files || {}), ...(meta.files || {}) }
  const profile = {
    id: meta.id || basename(dir),
    name: meta.name || meta.id || basename(dir),
    role: finalRole,
    engine: meta.engine || detected.engine || (finalRole === 'streaming' ? 'sherpa-streaming-transducer' : 'sherpa-offline'),
    type: meta.type || detected.type || (finalRole === 'streaming' ? 'transducer' : 'sense_voice'),
    dir,
    files: absoluteFiles(mergedFiles, dir),
    options: {
      ...(meta.options || {}),
      ...(meta.options?.sherpa ? { sherpa: resolveDeep(meta.options.sherpa, dir) } : {}),
    },
    // 可选下载清单（见 lib/models/downloader.js）
    download: Array.isArray(meta.download) ? meta.download : [],
  }
  profile.problems = validateAsrProfile(profile)
  return profile
}

export function legacyAsrProfiles({ streamingDir, finalDir, streamingName = '流式识别（旧配置）', finalName = 'SenseVoice（旧配置）' } = {}) {
  const list = []
  if (streamingDir) {
    const p = normalizeAsrProfile({ id: 'legacy-streaming', name: streamingName, role: 'streaming' }, streamingDir, 'streaming')
    p.legacy = true
    list.push(p)
  }
  if (finalDir) {
    const p = normalizeAsrProfile({ id: 'legacy-final', name: finalName, role: 'final', type: 'sense_voice' }, finalDir, 'final')
    p.legacy = true
    list.push(p)
  }
  return list
}

function roleDirs(modelsDir, role) {
  const direct = join(modelsDir, role)
  return existsSync(direct) ? { scanDir: direct, role } : null
}

/** 扫描 ASR 模型；返回 [{role:'streaming'|'final', ...profile}] */
export function scanAsrProfiles({ modelsDir, legacy = [] } = {}) {
  const list = []
  const seen = new Set()
  const add = (p) => {
    if (!p || !p.id) return
    const key = `${p.role}:${p.id}`
    if (seen.has(key)) return
    seen.add(key)
    list.push(p)
  }
  for (const p of legacy) add(p)
  if (!modelsDir || !existsSync(modelsDir)) return list

  const entries = safeList(modelsDir)
  const subRoles = entries.filter((n) => ROLES.includes(n) && isDir(join(modelsDir, n)))
  if (subRoles.length) {
    for (const role of subRoles) {
      const dir = join(modelsDir, role)
      for (const name of safeList(dir)) {
        const sub = join(dir, name)
        if (!isDir(sub)) continue
        const meta = readJsonFile(join(sub, 'model.json'))
        add(normalizeAsrProfile({ ...(meta || {}), id: (meta && meta.id) || basename(sub) }, sub, role))
      }
    }
    return list
  }

  // 扁平结构：models/asr/<id>/，role 由 model.json 或文件特征决定
  for (const name of entries) {
    const sub = join(modelsDir, name)
    if (!isDir(sub)) continue
    const meta = readJsonFile(join(sub, 'model.json'))
    const role = meta?.role || (detectAsrFiles(sub, 'streaming') ? 'streaming' : 'final')
    add(normalizeAsrProfile({ ...(meta || {}), id: (meta && meta.id) || basename(sub) }, sub, role))
  }
  return list
}

export function pickAsrProfile(profiles, role, preferredId = '') {
  const pool = (profiles || []).filter((p) => p.role === role)
  if (preferredId) {
    const hit = pool.find((p) => p.id === preferredId)
    if (hit) return hit
  }
  return pool.find((p) => !(p.problems || []).length) || pool[0] || null
}

export function publicAsrProfile(profile) {
  if (!profile) return null
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    engine: profile.engine,
    type: profile.type,
    path: profile.dir,
    ok: !(profile.problems && profile.problems.length),
    problems: profile.problems || [],
  }
}
