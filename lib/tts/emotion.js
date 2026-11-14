/**
 * 根据文字自动判断朗读情绪（BreezeBlue 自动情感模式）。
 *
 * 官方 TTS 没有独立的 emotion 参数：情绪通过 instructions + guidance_scale 控制。
 * 这里用轻量规则选一个「表演说明」，再由 Breeze 执行；不额外调用 LLM，不增加首字延迟。
 * 规则只做保守判断：没有明显信号就用自然语气，避免每句都夸张。
 */

const RULES = [
  {
    id: 'sad', label: '难过',
    words: ['难过', '伤心', '想哭', '哭了', '哭', '遗憾', '失落', '孤独', '委屈', '对不起', '舍不得', '离开', '去世', '走了', '唉', '呜咽', '抽泣', 'sad', 'sorry', 'miss you', 'cry', 'tears', 'lonely', 'heartbroken'],
    punct: /…{1,}|\.{3,}/,
    instructions: '用低落、克制的语气念，声音放轻，停顿稍多，像在忍住情绪。',
    guidanceScale: 2.2, speed: 0.9,
  },
  {
    id: 'angry', label: '生气',
    words: ['生气', '气死', '烦死', '讨厌', '滚开', '闭嘴', '凭什么', '过分', '愤怒', '火大', '受够', 'angry', 'hate', 'annoying', 'ridiculous', 'furious'],
    punct: /[!！]{2,}/,
    instructions: '用有点生气、压着火气的语气念，咬字清楚，语速稍快，但不要吼。',
    guidanceScale: 2.4, speed: 1.02,
  },
  {
    id: 'surprise', label: '惊讶',
    words: ['真的吗', '竟然', '居然', '没想到', '天哪', '哇', '不会吧', '惊喜', '吓我一跳', 'surprise', 'wow', 'really', 'unbelievable', 'no way'],
    punct: /[?？]{2,}|[!！]{2,}/,
    instructions: '用惊讶、明亮的语气念，句尾上扬，像刚听到意外消息。',
    guidanceScale: 2.4, speed: 1.08,
  },
  {
    id: 'nervous', label: '紧张',
    words: ['紧张', '害怕', '怎么办', '糟糕', '完了', '来不及', '担心', '焦虑', '慌', 'nervous', 'scared', 'worried', 'oh no', 'panic'],
    instructions: '用有点紧张、急促的语气念，呼吸略浅，句间停顿短。',
    guidanceScale: 2.2, speed: 1.05,
  },
  {
    id: 'happy', label: '开心',
    words: ['开心', '高兴', '太好了', '哈哈', '笑死', '喜欢', '真棒', '恭喜', '成功', '耶', '好耶', 'happy', 'great', 'love it', 'haha', 'yay', 'awesome'],
    punct: /[!！]/,
    instructions: '用开心、轻快、带笑意的语气念，语速稍快，句尾上扬。',
    guidanceScale: 2.2, speed: 1.05,
  },
  {
    id: 'playful', label: '俏皮',
    words: ['哼', '才不', '略略', '笨蛋', '逗你', '开玩笑', '嘻嘻', '调皮', '坏蛋', '就不', 'teasing', 'kidding', 'silly'],
    instructions: '用俏皮、带笑意的语气念，尾音轻轻上扬，像在开玩笑。',
    guidanceScale: 2.2, speed: 1.02,
  },
  {
    id: 'tender', label: '温柔',
    words: ['乖', '抱抱', '宝贝', '亲爱的', '辛苦', '晚安', '想你', '喜欢你', '爱你', '别怕', '没事', '我在', '温柔', '照顾好', 'honey', 'dear', 'good night', 'take care', 'sweet dreams'],
    instructions: '用温柔、轻声、像哄人一样的语气念，语速稍慢，句尾轻一些。',
    guidanceScale: 1.8, speed: 0.95,
  },
  {
    id: 'serious', label: '认真',
    words: ['注意', '警告', '必须', '重要', '风险', '危险', '小心', '请确认', '规则', '禁止', '严肃', 'warning', 'important', 'must', 'careful', 'caution'],
    instructions: '用认真、清晰、可靠的语气念，重点词稍加重，不夸张。',
    guidanceScale: 2, speed: 0.98,
  },
]

const NEUTRAL = {
  id: 'neutral', label: '自然',
  instructions: '用自然、平实的语气念，像日常说话，语速正常，不要夸张。',
  guidanceScale: 1, speed: 1,
}

/** 去掉括号里的音频标签，避免 `[笑]` 被当成情绪词。 */
function plain(text) {
  return String(text || '')
    .replace(/\[[^\]]{1,24}\]/g, ' ')
    .replace(/\([^)]{1,24}\)/g, ' ')
    .trim()
}

/**
 * @param {string} text
 * @returns {{id:string,label:string,instructions:string,guidanceScale:number,speed:number,score:number}}
 */
export function detectEmotion(text) {
  const t = plain(text)
  if (!t) return { ...NEUTRAL, score: 0 }
  const lower = t.toLowerCase()
  let best = null
  for (const rule of RULES) {
    let score = 0
    for (const w of rule.words) {
      if (w.length <= 1) continue
      if (lower.includes(w.toLowerCase())) score += w.length >= 4 ? 2 : 1
    }
    if (rule.punct && rule.punct.test(t)) score += 1
    if (!best || score > best.score) best = { ...rule, score }
  }
  if (!best || best.score <= 0) return { ...NEUTRAL, score: 0 }
  return best
}