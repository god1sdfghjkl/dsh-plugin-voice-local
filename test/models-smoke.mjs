/**
 * TTS 模型注册表单测（不需要真模型/网络）。
 *
 *   node test/models-smoke.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectTtsEngine,
  normalizeTtsProfile,
  validateTtsProfile,
  scanTtsProfiles,
  pickDefaultTtsProfile,
  legacyTtsProfile,
  publicTtsProfile,
} from '../lib/models/tts-registry.js'
import {
  detectAsrFiles,
  normalizeAsrProfile,
  validateAsrProfile,
  scanAsrProfiles,
  pickAsrProfile,
  publicAsrProfile,
  legacyAsrProfiles,
} from '../lib/models/asr-registry.js'

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label, extra === undefined ? '' : extra) }
}

const root = mkdtempSync(join(tmpdir(), 'voice-models-'))
function touch(p) { writeFileSync(p, '') }
function modelDir(name) { const d = join(root, name); mkdirSync(d, { recursive: true }); return d }

try {
  console.log('== 1. vits2 目录自动探测 ==')
  {
    const dir = modelDir('vits2-a')
    touch(join(dir, 'tl196m_dyn.onnx'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ sampling_rate: 44100, n_speakers: 1, symbols: ['a'] }))
    const det = detectTtsEngine(dir)
    ok(det && det.engine === 'vits2-onnx', '探测为 vits2-onnx', det)
    ok(det.files.config === 'config.json', '自动带上 config.json')
    const p = normalizeTtsProfile({ id: 'vits2-a' }, dir)
    ok(p.problems.length === 0, 'profile 无问题', p.problems)
    ok(p.files.model === join(dir, 'tl196m_dyn.onnx'), '文件解析为绝对路径')
    ok(p.textFrontend === 'vits2-zh', '默认文本前端 vits2-zh')
    p.problems = validateTtsProfile(p)
    ok(publicTtsProfile(p).ok === true, 'publicProfile.ok=true')
  }

  console.log('== 2. sherpa vits 目录自动探测 ==')
  {
    const dir = modelDir('melo')
    touch(join(dir, 'model.onnx'))
    touch(join(dir, 'tokens.txt'))
    touch(join(dir, 'lexicon.txt'))
    const det = detectTtsEngine(dir)
    ok(det && det.engine === 'sherpa-offline-tts', '探测为 sherpa-offline-tts', det)
    ok(det.sherpa.modelType === 'vits', 'modelType=vits')
    const p = normalizeTtsProfile({ id: 'melo', name: 'MeloTTS 中文' }, dir)
    ok(p.problems.length === 0, 'profile 无问题', p.problems)
    ok(p.files.lexicon && p.files.lexicon.endsWith('lexicon.txt'), 'lexicon 被带上')
  }

  console.log('== 3. model.json 显式配置（kokoro + 透传） ==')
  {
    const dir = modelDir('kokoro')
    touch(join(dir, 'model.onnx')); touch(join(dir, 'tokens.txt')); touch(join(dir, 'voices.bin'))
    writeFileSync(join(dir, 'model.json'), JSON.stringify({
      name: 'Kokoro 多语',
      engine: 'sherpa-offline-tts',
      sherpa: { modelType: 'kokoro', modelConfig: { kokoro: { model: 'model.onnx', tokens: 'tokens.txt', voices: 'voices.bin' } } },
    }))
    const p = normalizeTtsProfile(JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')), dir)
    ok(p.engine === 'sherpa-offline-tts', 'engine 来自 model.json')
    ok(p.name === 'Kokoro 多语', 'name 来自 model.json')
    ok(p.problems.length === 0, '透传 modelConfig 校验通过', p.problems)

    const dlDir = modelDir('with-download')
    touch(join(dlDir, 'model.onnx'))
    writeFileSync(join(dlDir, 'model.json'), JSON.stringify({
      engine: 'vits2-onnx',
      files: { model: 'model.onnx' },
      download: [{ url: 'http://example/x.onnx', path: 'x.onnx', sha256: 'abc' }],
    }))
    const dp = normalizeTtsProfile(JSON.parse(readFileSync(join(dlDir, 'model.json'), 'utf8')), dlDir)
    ok(dp.download.length === 1, 'download 清单被保留')
  }

  console.log('== 4. 损坏模型给出 problems ==')
  {
    const dir = modelDir('broken')
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ engine: 'vits2-onnx', files: { model: 'nope.onnx' } }))
    const p = normalizeTtsProfile(JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')), dir)
    ok(p.problems.length > 0, '缺少模型文件 → problems 非空', p.problems)
    ok(publicTtsProfile(p).ok === false, 'publicProfile.ok=false')
    const unknown = normalizeTtsProfile({ engine: 'no-such-engine' }, modelDir('unknown'))
    ok(unknown.problems.some((x) => /不支持的 engine/.test(x)), '未知 engine 报错')
  }

  console.log('== 5. 扫描目录 + 选择默认/指定模型 ==')
  {
    const modelsDir = join(root, 'models', 'tts')
    mkdirSync(modelsDir, { recursive: true })
    const a = join(modelsDir, 'alpha'); mkdirSync(a)
    touch(join(a, 'model.onnx')); writeFileSync(join(a, 'config.json'), JSON.stringify({ sampling_rate: 44100 }))
    const b = join(modelsDir, 'beta'); mkdirSync(b)
    touch(join(b, 'model.onnx')); touch(join(b, 'tokens.txt'))
    const list = scanTtsProfiles({ modelsDir })
    ok(list.length === 2, '扫描到 2 个模型', list.map((x) => x.id))
    const def = pickDefaultTtsProfile(list)
    ok(def && def.id === 'alpha', '默认取第一个可用', def && def.id)
    const pick = pickDefaultTtsProfile(list, { preferredId: 'beta' })
    ok(pick && pick.id === 'beta', '按 preferredId 选中 beta', pick && pick.id)
    ok(pickDefaultTtsProfile([], {}) === null, '空列表返回 null')
  }

  console.log('== 6. 旧配置兼容（ttsOnnx 直指 .onnx） ==')
  {
    const dir = modelDir('legacy-onnx')
    const onnx = join(dir, 'voice.onnx')
    touch(onnx)
    const p = legacyTtsProfile({ onnxPath: onnx, configPath: '', sampleRate: 44100 })
    ok(p.id === 'legacy' && p.engine === 'vits2-onnx', 'legacy profile 字段正确')
    ok(p.problems.length === 0, 'legacy profile 可用', p.problems)
  }

  console.log('== 7. modelsDir 本身就是一个模型目录 ==')
  {
    const single = modelDir('single-dir')
    touch(join(single, 'model.onnx'))
    writeFileSync(join(single, 'config.json'), JSON.stringify({ sampling_rate: 22050 }))
    const list = scanTtsProfiles({ modelsDir: single })
    ok(list.length === 1, '单目录模型被识别', list.length)
  }

  console.log('== 8. 模型目录不存在不抛错 ==')
  {
    const list = scanTtsProfiles({ modelsDir: join(root, 'no-such-dir') })
    ok(Array.isArray(list) && list.length === 0, '不存在目录返回空列表')
    ok(!existsSync(join(root, 'no-such-dir')), '不会创建目录')
  }

  console.log('== 9. ASR 流式目录探测 ==')
  {
    const dir = modelDir('asr-stream')
    touch(join(dir, 'tokens.txt'))
    touch(join(dir, 'encoder-epoch-99-avg-1.int8.onnx'))
    touch(join(dir, 'decoder-epoch-99-avg-1.int8.onnx'))
    touch(join(dir, 'joiner-epoch-99-avg-1.int8.onnx'))
    const det = detectAsrFiles(dir, 'streaming')
    ok(det && det.engine === 'sherpa-streaming-transducer', '探测为流式 transducer', det)
    const p = normalizeAsrProfile({ id: 'asr-stream' }, dir, 'streaming')
    ok(p.problems.length === 0, '流式 profile 无问题', p.problems)
    ok(publicAsrProfile(p).ok === true, '流式 public.ok=true')
  }

  console.log('== 10. ASR 定稿目录探测 ==')
  {
    const dir = modelDir('asr-final')
    touch(join(dir, 'tokens.txt'))
    touch(join(dir, 'model.int8.onnx'))
    const p = normalizeAsrProfile({ id: 'asr-final' }, dir, 'final')
    ok(p.problems.length === 0, '定稿 profile 无问题', p.problems)
    ok(p.type === 'sense_voice', '默认定稿类型 sense_voice')
  }

  console.log('== 11. ASR role 子目录扫描 + 选择 ==')
  {
    const modelsDir = join(root, 'models', 'asr')
    const s = join(modelsDir, 'streaming', 'zh-stream')
    mkdirSync(s, { recursive: true })
    touch(join(s, 'tokens.txt')); touch(join(s, 'encoder.onnx')); touch(join(s, 'decoder.onnx')); touch(join(s, 'joiner.onnx'))
    const f = join(modelsDir, 'final', 'zh-final')
    mkdirSync(f, { recursive: true })
    touch(join(f, 'tokens.txt')); touch(join(f, 'model.int8.onnx'))
    const list = scanAsrProfiles({ modelsDir })
    ok(list.length === 2, '扫描到 2 个 ASR 模型', list.map((x) => x.role + ':' + x.id))
    const streaming = pickAsrProfile(list, 'streaming')
    ok(streaming && streaming.id === 'zh-stream', '选到流式模型', streaming && streaming.id)
    const final = pickAsrProfile(list, 'final', 'zh-final')
    ok(final && final.id === 'zh-final', '按 id 选到定稿模型', final && final.id)
  }

  console.log('== 12. ASR 显式 whisper + 缺失文件报错 ==')
  {
    const dir = modelDir('asr-whisper')
    touch(join(dir, 'tokens.txt')); touch(join(dir, 'encoder.onnx')); touch(join(dir, 'decoder.onnx'))
    writeFileSync(join(dir, 'model.json'), JSON.stringify({
      role: 'final',
      type: 'whisper',
      files: { tokens: 'tokens.txt', encoder: 'encoder.onnx', decoder: 'decoder.onnx' },
    }))
    const meta = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'))
    const p = normalizeAsrProfile({ ...meta, id: 'asr-whisper' }, dir, 'final')
    ok(p.problems.length === 0, 'whisper profile 无问题', p.problems)

    const broken = modelDir('asr-broken')
    touch(join(broken, 'tokens.txt')); touch(join(broken, 'encoder.onnx'))
    const bp = normalizeAsrProfile({ id: 'asr-broken' }, broken, 'streaming')
    ok(bp.problems.length > 0, '缺文件 → problems 非空', bp.problems)
  }

  console.log('== 13. ASR 旧配置兼容 ==')
  {
    const dir = modelDir('asr-legacy')
    touch(join(dir, 'tokens.txt'))
    touch(join(dir, 'encoder-epoch-99-avg-1.int8.onnx'))
    touch(join(dir, 'decoder-epoch-99-avg-1.int8.onnx'))
    touch(join(dir, 'joiner-epoch-99-avg-1.int8.onnx'))
    const list = legacyAsrProfiles({ streamingDir: dir })
    ok(list.length === 1 && list[0].role === 'streaming' && list[0].legacy === true, 'legacy 流式 profile')
    const noModel = modelDir('asr-legacy-final-notokens')
    touch(join(noModel, 'tokens.txt'))
    const fp = normalizeAsrProfile({ role: 'final', type: 'sense_voice' }, noModel, 'final')
    ok(fp.problems.length > 0, 'legacy 定稿缺 model 会提示', fp.problems)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
