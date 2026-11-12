/**
 * 句子切分器：把 LLM 流式文本切成适合 TTS 的短句。
 *
 * 目标：
 *   - 首句短（降低首包延迟）：默认 6 字左右
 *   - 后续句适中（降低总合成次数带来的间隙）：默认 16 字上限
 *   - 优先在标点处切，避免把词切断
 *   - 流结束 flush 出剩余文本
 *
 * 与 Python 侧 split_for_stream 的思路一致，但按 token 级增量喂入。
 */

// 句子终止符（中英文）。逗号不切，避免碎句。
const TERMINATORS = new Set(['。', '！', '？', '；', '…', '!', '?', ';', '\n'])
// 终止符后面可能跟着的收尾引号/括号，跟着前一句走
const CLOSERS = new Set(['”', '』', '」', '）', ')', '”', '"', '’', "'", '】', ']'])

/**
 * @param {{firstChars?: number, maxChars?: number}} [opts]
 */
export function createSegmenter(opts = {}) {
  const firstChars = Math.max(2, opts.firstChars ?? 6)
  const maxChars = Math.max(firstChars, opts.maxChars ?? 16)
  let buf = ''
  let emitted = 0

  const limit = () => (emitted === 0 ? firstChars : maxChars)

  function cutOne() {
    // 1) 找最早出现的终止符
    let term = -1
    for (let i = 0; i < buf.length; i++) {
      if (TERMINATORS.has(buf[i])) { term = i; break }
    }
    if (term >= 0) {
      let end = term + 1
      while (end < buf.length && (CLOSERS.has(buf[end]) || TERMINATORS.has(buf[end]))) end++
      return end
    }
    // 2) 没有标点：超过上限就硬切（上限内继续等）
    if (buf.length >= limit()) return limit()
    return 0
  }

  function take(n) {
    const s = buf.slice(0, n)
    buf = buf.slice(n)
    emitted++
    return s.trim()
  }

  return {
    /**
     * 喂入一段流式文本，返回现在可以送去合成的完整句子（可能多个）。
     * @param {string} text
     * @returns {string[]}
     */
    push(text) {
      if (!text) return []
      buf += text
      const out = []
      for (;;) {
        const n = cutOne()
        if (!n) break
        const s = take(n)
        if (s) out.push(s)
      }
      return out
    },
    /** 流结束：吐出剩余文本（不足 2 字丢弃，避免「嗯」被合成） */
    flush() {
      const s = buf.trim()
      buf = ''
      emitted++
      return s.length >= 2 ? [s] : []
    },
    get pending() { return buf },
  }
}
