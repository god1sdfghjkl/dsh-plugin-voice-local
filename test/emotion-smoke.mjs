/**
 * 文字自动情感 smoke：验证常见语气能映射到预设，普通陈述保持自然。
 * 跑法：node test/emotion-smoke.mjs
 */
import { detectEmotion } from '../lib/tts/emotion.js'

let passed = 0
let failed = 0
function check(text, expected) {
  const r = detectEmotion(text)
  const ok = r.id === expected
  if (ok) { passed++; console.log(`  ✓ ${expected}: ${text}`) }
  else { failed++; console.error(`  ✗ 期望 ${expected}，实际 ${r.id}: ${text}`) }
  if (ok && !r.instructions) { failed++; console.error('  ✗ 缺少 instructions') }
}

console.log('== 自动情感 ==')
check('太好了，我终于成功了！', 'happy')
check('对不起，我要走了……', 'sad')
check('我真的很生气，你别太过分。', 'angry')
check('真的吗？你居然回来了！', 'surprise')
check('晚安，做个好梦。', 'tender')
check('哼，才不理你呢。', 'playful')
check('请注意，这一步很重要，必须确认。', 'serious')
check('怎么办，要来不及了，我好紧张。', 'nervous')
check('今天星期三，下午三点开会。', 'neutral')
check('他走了以后，我一直很想他……', 'sad')
check('哈哈哈，这个太好笑了！', 'happy')
check('[笑] 你好呀。', 'neutral')

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)