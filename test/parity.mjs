import { readFileSync } from 'node:fs'
import { textNormalize, g2p, textToIds } from '../lib/tts-text/frontend.js'

const fixtures = JSON.parse(readFileSync(new URL('../lib/tts-text/fixtures.json', import.meta.url), 'utf-8'))
const idsFixtures = JSON.parse(readFileSync(new URL('./ids-fixtures.json', import.meta.url), 'utf-8'))
let pass = 0
let idsPass = 0
const fails = []
const idsFails = []

function diffAt(exp, got) {
  const n = Math.min(exp.length, got.length)
  for (let i = 0; i < n; i++) {
    if (exp[i] !== got[i]) {
      return {
        at: i, exp: exp[i], got: got[i],
        expCtx: exp.slice(Math.max(0, i - 3), i + 4),
        gotCtx: got.slice(Math.max(0, i - 3), i + 4),
      }
    }
  }
  return { lenExp: exp.length, lenGot: got.length }
}

for (const fx of fixtures) {
  let got
  try {
    const norm = textNormalize(fx.raw)
    const { phones, tones } = g2p(norm)
    got = { norm, phones, tones }
  } catch (e) {
    got = { error: String(e) }
  }
  if (got.error) {
    fails.push({ raw: fx.raw, error: got.error })
    continue
  }
  const okNorm = got.norm === fx.norm
  const okPhones = JSON.stringify(got.phones) === JSON.stringify(fx.phones)
  const okTones = JSON.stringify(got.tones) === JSON.stringify(fx.tones)
  if (okNorm && okPhones && okTones) {
    pass++
  } else {
    fails.push({
      raw: fx.raw, okNorm, okPhones, okTones,
      normExp: fx.norm, normGot: got.norm,
      phonesDiff: !okPhones ? diffAt(fx.phones, got.phones) : null,
      tonesDiff: !okTones ? diffAt(fx.tones, got.tones) : null,
    })
  }
}

// 引擎级 ids 黄金对照：textToIds(raw) 必须与 Python engine.text_to_ids 逐位一致
for (const fx of idsFixtures) {
  let got
  try {
    got = textToIds(fx.raw)
  } catch (e) {
    idsFails.push({ raw: fx.raw, error: String(e) })
    continue
  }
  const okPhones = JSON.stringify(got.phones) === JSON.stringify(fx.phones)
  const okTones = JSON.stringify(got.tones) === JSON.stringify(fx.tones)
  if (okPhones && okTones) {
    idsPass++
  } else {
    idsFails.push({
      raw: fx.raw, okPhones, okTones,
      phonesDiff: !okPhones ? diffAt(fx.phones, got.phones) : null,
      tonesDiff: !okTones ? diffAt(fx.tones, got.tones) : null,
    })
  }
}

console.log(`g2p 通过 ${pass}/${fixtures.length}`)
console.log(`textToIds 通过 ${idsPass}/${idsFixtures.length}`)
for (const f of fails) {
  console.log('\n✗ g2p', JSON.stringify(f.raw))
  if (f.error) console.log('  error:', f.error)
  if (f.normExp !== undefined && !f.okNorm) {
    console.log('  norm exp:', f.normExp)
    console.log('  norm got:', f.normGot)
  }
  if (f.phonesDiff) console.log('  phones 差异:', JSON.stringify(f.phonesDiff))
  if (f.tonesDiff) console.log('  tones 差异:', JSON.stringify(f.tonesDiff))
}
for (const f of idsFails) {
  console.log('\n✗ ids', JSON.stringify(f.raw))
  if (f.error) console.log('  error:', f.error)
  if (f.phonesDiff) console.log('  phones 差异:', JSON.stringify(f.phonesDiff))
  if (f.tonesDiff) console.log('  tones 差异:', JSON.stringify(f.tonesDiff))
}
process.exit(fails.length || idsFails.length ? 1 : 0)
