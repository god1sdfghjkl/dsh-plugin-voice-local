/**
 * TTS 文本前端 · JS 移植版（与 tts_onnx/text 对齐，跑在宿主 Node 里）
 *
 * 数据来源（由 scripts/dump_tts_tables.py 从 Python 侧导出，保证逐字对齐）：
 *   symbols.json        符号表
 *   pinyin_map.json     拼音 → phone 序列（opencpop-strict）
 *   rep_map.json        标点归一映射
 *   sandhi_words.json   变调词表
 *   resolved_chars.json 单字 → {i,f}（pypinyin 最终输出）
 *   resolved_phrases.json 短语 → 每字 {i,f}（含多音字消歧）
 *
 * 依赖：@node-rs/jieba（分词+词性），词典与 Python jieba 同源。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'
import { ToneSandhi } from './tone-sandhi.js'
import { an2cn } from './cn2an.js'

const DIR = path.dirname(fileURLToPath(import.meta.url))

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf-8'))
}

const SYMBOLS = readJson('symbols')
const PINYIN_MAP = readJson('pinyin_map')
const REP_MAP = readJson('rep_map')
const SANDHI_WORDS = readJson('sandhi_words')
const RESOLVED_CHARS = readJson('resolved_chars')
for (const c of Object.keys(RESOLVED_CHARS)) {
  const v = RESOLVED_CHARS[c]
  if (!Array.isArray(v.f)) RESOLVED_CHARS[c] = { i: [v.i], f: [v.f] }
}
const RESOLVED_PHRASES = readJson('resolved_phrases')

// 深度归一化：lazy_pinyin 对部分短语返回嵌套数组（[["j"],...]），
// 统一拍平成字符串数组，后续逻辑只处理 string
function deepNormalizeResolved(o) {
  const flat = (e) => (Array.isArray(e) ? flat(e[0]) : e)
  for (const k of Object.keys(o)) {
    const v = o[k]
    o[k] = { i: v.i.map(flat), f: v.f.map(flat) }
  }
}
deepNormalizeResolved(RESOLVED_CHARS)
deepNormalizeResolved(RESOLVED_PHRASES)

const SYMBOL_TO_ID = new Map(SYMBOLS.symbols.map((s, i) => [s, i]))
const PUNCT_SET = new Set(SYMBOLS.punctuation)

const JIEBA = Jieba.withDict(dict)
const SANDHI = new ToneSandhi(SANDHI_WORDS, (word) => {
  // pypinyin lazy_pinyin 的查表等价物
  if (RESOLVED_PHRASES[word]) return RESOLVED_PHRASES[word]
  if (word.length === 1 && RESOLVED_CHARS[word]) return RESOLVED_CHARS[word]
  // 词不在短语表：逐字解析（用短语表消歧子串的贪心尝试，失败退到单字）
  const i = [], f = []
  let rest = word
  while (rest.length) {
    let matched = false
    for (let l = Math.min(rest.length, 4); l >= 2; l--) {
      const sub = rest.slice(0, l)
      if (RESOLVED_PHRASES[sub]) {
        i.push(...RESOLVED_PHRASES[sub].i)
        f.push(...RESOLVED_PHRASES[sub].f)
        rest = rest.slice(l)
        matched = true
        break
      }
    }
    if (!matched) {
      const c = rest[0]
      const r = RESOLVED_CHARS[c]
      if (r) { i.push(r.i[0]); f.push(r.f[0]) }   // 单字（载入时已归一成数组）
      else { i.push(c); f.push(c) }               // 非汉字透传（对齐 python lazy_pinyin）
      rest = rest.slice(1)
    }
  }
  return { i, f }
}, JIEBA)

const REP_KEYS = Object.keys(REP_MAP)

function replacePunctuation(text) {
  text = text.replace('嗯', '恩').replace('呣', '母')
  const pattern = new RegExp(REP_KEYS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  let replaced = text.replace(pattern, (x) => REP_MAP[x])
  replaced = replaced.replace(
    new RegExp(`[^\\u4e00-\\u9fa5${SYMBOLS.punctuation.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}]+`, 'g'),
    '',
  )
  return replaced
}

export function textNormalize(text) {
  const numbers = text.match(/\d+(?:\.?\d+)?/g) || []
  for (const n of numbers) {
    text = text.replace(n, an2cn(n))
  }
  return replacePunctuation(text)
}

function getInitialsFinals(word) {
  const r = lazyPinyinLookup(word)
  if (r) return [r.i.slice(), r.f.slice()]
  return [Array.from(word), Array.from(word)]
}

function lazyPinyinLookup(word) {
  if (RESOLVED_PHRASES[word]) return RESOLVED_PHRASES[word]
  if (word.length === 1 && RESOLVED_CHARS[word]) return RESOLVED_CHARS[word]
  // 与 SANDHI_PINGYIN 相同的贪心子串消歧
  const i = [], f = []
  let rest = word
  while (rest.length) {
    let matched = false
    for (let l = Math.min(rest.length, 4); l >= 2; l--) {
      const sub = rest.slice(0, l)
      if (RESOLVED_PHRASES[sub]) {
        i.push(...RESOLVED_PHRASES[sub].i)
        f.push(...RESOLVED_PHRASES[sub].f)
        rest = rest.slice(l)
        matched = true
        break
      }
    }
    if (!matched) {
      const c = rest[0]
      const r = RESOLVED_CHARS[c]
      if (r) { i.push(r.i[0]); f.push(r.f[0]) }   // 单字已归一成数组
      else { i.push(c); f.push(c) }               // 非汉字透传（对齐 python lazy_pinyin）
      rest = rest.slice(1)
    }
  }
  return { i, f }
}

function _g2p(segments) {
  const phonesList = []
  const tonesList = []
  const word2ph = []
  for (let seg of segments) {
    seg = seg.replace(/[a-zA-Z]+/g, '')     // 英文字母丢弃（与 Python 一致）
    if (!seg) continue
    let segCut = JIEBA.tag(seg).map((x) => [x.word, x.tag])
    segCut = SANDHI.preMergeForModify(segCut)
    const initials = []
    const finals = []
    for (const [word, pos] of segCut) {
      if (pos === 'eng') continue
      const [subI, subF] = getInitialsFinals(word)
      const sf = SANDHI.modifiedTone(word, pos, subF)
      initials.push(...subI)
      finals.push(...sf)
    }
    for (let k = 0; k < initials.length; k++) {
      const c = initials[k]
      const v = finals[k]
      if (c === v) {
        // 标点等非音素：透传
        phonesList.push(c)
        tonesList.push(0)
        word2ph.push(1)
        continue
      }
      const tone = v.slice(-1)
      let pinyin = c + v.slice(0, -1)
      if (c) {
        // 多音节：uei→ui / iou→iu / uen→un
        const vRep = { uei: 'ui', iou: 'iu', uen: 'un' }
        const vw = v.slice(0, -1)
        if (vRep[vw]) pinyin = c + vRep[vw]
      } else {
        // 单音节：ing→ying / i→yi / in→yin / u→wu；v/e/i/u 前缀补 y/w
        const pRep = { ing: 'ying', i: 'yi', in: 'yin', u: 'wu' }
        if (pRep[pinyin]) pinyin = pRep[pinyin]
        else {
          const sRep = { v: 'yu', e: 'e', i: 'y', u: 'w' }
          if (sRep[pinyin[0]]) pinyin = sRep[pinyin[0]] + pinyin.slice(1)
        }
      }
      const phoneStr = PINYIN_MAP[pinyin]
      if (!phoneStr) {
        console.warn(`[tts-text] 拼音不在符号表: ${pinyin}（词=${word}）`)
        continue
      }
      const phone = phoneStr.split(' ')
      word2ph.push(phone.length)
      phonesList.push(...phone)
      tonesList.push(...new Array(phone.length).fill(+tone))
    }
  }
  return { phones: phonesList, tones: tonesList, word2ph }
}

/** 对齐 Python chinese.g2p：标点切句 + 首尾补 _ */
export function g2p(text) {
  const pattern = new RegExp(`(?<=[${SYMBOLS.punctuation.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}])\\s*`, 'g')
  const segments = text.split(pattern).filter((s) => s.trim() !== '')
  const { phones, tones, word2ph } = _g2p(segments)
  phones.unshift('_')
  phones.push('_')
  tones.unshift(0)
  tones.push(0)
  word2ph.unshift(1)
  word2ph.push(1)
  return { phones, tones, word2ph }
}

/** (phones, tones) → id 序列 */
export function cleanedTextToSequence(phones, tones) {
  const outP = []
  const outT = []
  for (let k = 0; k < phones.length; k++) {
    const id = SYMBOL_TO_ID.get(phones[k])
    if (id === undefined) {
      console.warn(`[tts-text] 未知符号: ${phones[k]}`)
      continue
    }
    outP.push(id)
    outT.push(tones[k])          // ZH 的 tone_start = 0
  }
  return { phones: outP, tones: outT }
}

function intersperse(arr, item) {
  // 对齐 Python 侧 intersperse：长度 2n+1，首尾都是 blank。
  // 之前少写末尾那个 item（2n），导致模型输入的 id 序列比 Python 少一位。
  const out = new Array(arr.length * 2 + 1)
  for (let i = 0; i < arr.length; i++) {
    out[i * 2] = item
    out[i * 2 + 1] = arr[i]
  }
  out[arr.length * 2] = item
  return out
}

/** 引擎级入口：文本 → 模型输入的 id 数组（等价 Python engine.text_to_ids） */
export function textToIds(text, { addBlank = true } = {}) {
  const norm = textNormalize(text)
  const { phones, tones } = g2p(norm)
  let p = cleanedTextToSequence(phones, tones)
  if (addBlank) {
    p.phones = intersperse(p.phones, 0)
    p.tones = intersperse(p.tones, 0)
  }
  return p
}
