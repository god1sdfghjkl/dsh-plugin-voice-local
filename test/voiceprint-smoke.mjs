/**
 * 声纹锁冒烟：fbank → embedding → 注册/校验/清除/阈值。
 *
 *   VOICE_VP_MODEL=... node test/voiceprint-smoke.mjs
 *
 * 需要 3D-Speaker CAM++ 模型；没有则跳过（CI 不会失败）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { readWave } from 'sherpa-onnx'
import { extractFbank } from '../lib/voiceprint/fbank.js'
import { VoiceprintService, sliderToThreshold, MAX_PROFILES, downloadVoiceprintModel, VOICEPRINT_MODEL_SOURCES, trimSilence } from '../lib/voiceprint/service.js'
import { readOnnxMetadata } from '../lib/voiceprint/embedding.js'

const ROOT = process.env.VOICE_SAMPLE_ROOT || join(import.meta.dirname, '..', '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const MODEL = process.env.VOICE_VP_MODEL || join(DSH_HOME, 'voice-local', 'models', 'voiceprint', 'campplus_zh.onnx')
const A = join(ROOT, 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23', 'test_wavs', '0.wav')
const B = join(ROOT, 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23', 'test_wavs', '1.wav')
const OTHER = join(ROOT, '_cmp_tl_文本1.wav')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + JSON.stringify(extra) : '')) }
}

function load16k(file) {
  const w = readWave(file)
  if (w.sampleRate === 16000) return w.samples
  const ratio = w.sampleRate / 16000
  const n = Math.floor(w.samples.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ratio
    const i0 = Math.floor(p)
    const i1 = Math.min(i0 + 1, w.samples.length - 1)
    out[i] = w.samples[i0] + (w.samples[i1] - w.samples[i0]) * (p - i0)
  }
  return out
}

const missing = [MODEL, A, B].filter((p) => !existsSync(p))
if (missing.length) {
  console.log('跳过声纹冒烟：缺少模型或样例音频')
  for (const p of missing) console.log('  缺少：' + p)
  process.exit(0)
}

console.log('== 1. fbank ==')
{
  const wav = load16k(A)
  const f = extractFbank(wav)
  ok(f.frames > 10 && f.dim === 80, '帧数/维度', { frames: f.frames, dim: f.dim })
  let finite = true
  for (const v of f.data) if (!Number.isFinite(v)) { finite = false; break }
  ok(finite, '全部数值有限')
  const first = f.data[0]
  ok(first !== 0, '首帧非零（log mel）')
}

console.log('== 1.5 首尾静音裁剪 ==')
{
  const wav = load16k(A)
  const padded = new Float32Array(wav.length + 16000)
  padded.set(wav, 8000)
  const trimmed = trimSilence(padded)
  ok(trimmed.length < padded.length - 8000, '裁掉首尾静音', { before: padded.length, after: trimmed.length })
  ok(trimmed.length > 16000 * 0.8, '保留有效语音', trimmed.length)
  ok(trimSilence(wav).length > 16000 * 0.5, '无明显静音时保留原音频', trimSilence(wav).length)
}

console.log('== 2. 模型 metadata / 多档案注册 ==')
const dir = mkdtempSync(join(tmpdir(), 'vp-smoke-'))
try {
  const meta = readOnnxMetadata(MODEL)
  ok(meta.feature_normalize_type === 'global-mean', 'metadata feature_normalize_type=global-mean', meta)
  ok(meta.normalize_samples === '1', 'metadata normalize_samples=1', meta)

  const vp = new VoiceprintService({
    modelPath: MODEL,
    dataFile: join(dir, 'voiceprint.json'),
    threshold: 0.7,
  })
  ok(vp.status().modelReady === true, '模型就绪')
  ok(vp.enrolled === false, '初始未注册')

  const human0 = load16k(A)
  const human1 = load16k(B)
  const other = load16k(OTHER)

  const r = await vp.enroll({ nickname: '主人', clips: [human0, human1] })
  ok(r.profile && r.profile.nickname === '主人', '注册档案昵称', r.profile)
  ok(r.profile.dim === 192, '注册 embedding 维度 192', r.profile.dim)
  ok(r.profile.templates === 2, '注册保留 2 份模板（比对取最高）', r.profile.templates)
  ok(vp.enrolled === true && vp.status().profiles.length === 1, '注册后档案数 1')
  const pid = r.profile.id

  const same = await vp.verify(human1)
  ok(same.ok === true && same.score > 0.7, '同人不同句通过', same)
  ok(same.matched && same.matched.nickname === '主人', '匹配到「主人」', same.matched)
  const differ = await vp.verify(other)
  ok(differ.ok === false && differ.score < 0.7, '不同音色拒绝', differ)
  const testOne = await vp.verifyProfile(pid, human1)
  ok(testOne.ok === true && testOne.score > 0.7, '指定档案测试通过', testOne)

  console.log('== 3. 阈值 / 策略 / 档案管理 / 持久化 ==')
  ok(sliderToThreshold(40) === 0.7 && sliderToThreshold(100) === 1 && sliderToThreshold(0) === 0.5, '滑动条映射 40→0.70')
  vp.updateSettings({ thresholdSlider: 95 })
  // 用未参与注册的同一人半段音频测阈值，避免“模板本身=1.0”永远通过
  const held = human1.slice(0, Math.floor(human1.length * 0.5))
  const strict = await vp.verify(held)
  ok(strict.ok === false, '阈值 95 时同人也被拒（说明阈值生效）', strict)
  vp.updateSettings({ thresholdSlider: 40 })
  const loose = await vp.verify(held)
  ok(loose.ok === true && loose.score > 0.7, '阈值 70 时同人通过', loose)
  ok(vp.threshold === 0.7, '阈值恢复 0.70', vp.threshold)

  vp.updateProfile(pid, { tone: 'gentle', permissions: { highRisk: true } })
  const p1 = vp.status().profiles.find((p) => p.id === pid)
  ok(p1.tone === 'gentle' && p1.permissions.highRisk === true, '档案语气/权限可改', p1)

  vp.updateSettings({ requireEnrolled: false, denoise: true, wakeMode: 'direct' })
  ok(vp.status().settings.requireEnrolled === false && vp.status().settings.wakeMode === 'direct', '策略设置生效', vp.status().settings)

  vp.updateSettings({ enabled: true })
  ok(vp.status().settings.enabled === true, '总开关持久化到 settings')

  // 档案上限
  for (let i = vp.status().profiles.length; i < MAX_PROFILES; i++) {
    await vp.enroll({ nickname: `家人${i}`, clips: [other] })
  }
  ok(vp.status().profiles.length === MAX_PROFILES, `最多 ${MAX_PROFILES} 组`)
  let overflow = ''
  try { await vp.enroll({ nickname: '第六组', clips: [other] }) } catch (e) { overflow = e.message }
  ok(/最多/.test(overflow), '超过上限报错', overflow)

  console.log('== 4. 模型下载双来源回退 ==')
  {
    const data = readFileSync(MODEL)
    const calls = []
    const fakeFetch = async (url) => {
      calls.push(url)
      if (calls.length === 1) return { ok: false, status: 502, headers: { get: () => null } }
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(data.length) },
        body: (async function* () {
          const step = 1 << 20
          for (let i = 0; i < data.length; i += step) yield data.subarray(i, i + step)
        })(),
      }
    }
    const target = join(dir, 'mirror.onnx')
    const r = await downloadVoiceprintModel(target, { fetchImpl: fakeFetch })
    ok(calls.length === 2, '首个来源失败后尝试镜像', calls.length)
    ok(r.source === VOICEPRINT_MODEL_SOURCES[1], '实际使用镜像来源', r.source)
    ok(existsSync(target) && statSync(target).size === data.length, '镜像文件大小一致', statSync(target).size)
    ok(!existsSync(target + '.part'), '下载成功不留 .part')
  }

  const vp2 = new VoiceprintService({ modelPath: MODEL, dataFile: join(dir, 'voiceprint.json'), threshold: 0.7 })
  ok(vp2.status().profiles.length === MAX_PROFILES, '重启后档案恢复')
  ok(vp2.status().settings.enabled === true, '重启后总开关恢复')
  const restored = await vp2.verify(human1)
  ok(restored.ok === true && restored.matched && restored.matched.nickname === '主人', '恢复后仍能匹配主人', restored)

  ok(vp2.removeProfile(pid) === true, '删除单个档案')
  ok(vp2.status().profiles.length === MAX_PROFILES - 1, '删除后数量 -1')
  vp2.clear()
  ok(vp2.enrolled === false, '清空后未注册')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)