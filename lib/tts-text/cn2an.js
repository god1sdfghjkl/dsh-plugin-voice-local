/**
 * cn2an 子集移植：阿拉伯数字 → 中文读法（low 风格，与 Python cn2an.an2cn 对齐）。
 * 覆盖 text_normalize 用到的路径：整数（0 ~ 万亿级）、小数。黄金样本见 cn2an_samples.json。
 */

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const MINOR = ['', '十', '百', '千']
const MAJOR = ['', '万', '亿', '万亿']

/** 4 位以内一段 → 中文（1200 → 一千二百；10 → 十；105 → 一百零五） */
function groupToCn(sec) {
  let s = ''
  let zeroPending = false
  const str = String(sec)
  for (let i = 0; i < str.length; i++) {
    const d = +str[i]
    const u = MINOR[str.length - 1 - i]
    if (d === 0) {
      if (s) zeroPending = true          // 只在已有输出且后面还有数字时补零
      continue
    }
    if (zeroPending) {
      s += '零'
      zeroPending = false
    }
    if (d === 1 && u === '十' && s === '') {
      s += '十'                           // 一十 → 十（仅段首）
    } else {
      s += DIGITS[d] + u
    }
  }
  return s
}

/** 整数（字符串，可超长）→ 中文 */
function intToCn(str) {
  str = str.replace(/^0+(?=\d)/, '')     // 前导零丢弃：007 → 7
  if (str === '' || /^0+$/.test(str)) return '零'
  // 按 4 位从右往左分组
  const groups = []
  for (let i = str.length; i > 0; i -= 4) {
    groups.unshift(str.slice(Math.max(0, i - 4), i))
  }
  if (groups.length > MAJOR.length) {
    throw new Error(`数字超出支持范围（>万亿亿）：${str}`)
  }
  let out = ''
  for (let g = 0; g < groups.length; g++) {
    const sec = +groups[g]
    const unit = MAJOR[groups.length - 1 - g]
    if (sec === 0) continue              // 整组为零：跨组零由下一组补
    out += groupToCn(sec) + unit
    // 下一组最高位是 0 → 组间补零（如 10203 → 一万零二百零三）
    const next = groups[g + 1]
    if (next !== undefined && +next > 0 && next[0] === '0' && unit !== '') {
      out += '零'
    }
  }
  // 组间零去重/收尾：上面已按需插入
  return out
}

/** cn2an.an2cn 的对齐实现：整数 + 小数 */
export function an2cn(num) {
  const s = String(num).trim()
  let sign = ''
  let body = s
  if (body.startsWith('-')) {
    sign = '负'
    body = body.slice(1)
  }
  let out
  const dot = body.indexOf('.')
  if (dot === -1) {
    out = intToCn(body)
  } else {
    const ip = body.slice(0, dot)
    const fp = body.slice(dot + 1)
    const intPart = ip === '' || /^0+$/.test(ip) ? '零' : intToCn(ip)
    const frac = [...fp].map((d) => DIGITS[+d]).join('')
    out = `${intPart}点${frac}`
  }
  return sign + out
}
