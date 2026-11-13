/**
 * 通话人设 smoke test：有 voice 客户端时注入，挂断后为空，关闭时不注册。
 */
import assert from 'node:assert/strict'
import { installCallPersona, CALL_PERSONA_TEXT, CALL_PERSONA_SECTION } from '../lib/call-persona.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) } catch (e) { failed++; console.error(`  ✗ ${name}: ${e?.message || e}`) }
}

function fakeCtx(active) {
  const reg = { section: null }
  const ctx = {
    inject(names, cb) {
      assert.deepEqual(names, ['systemPrompt'])
      cb({
        systemPrompt: {
          section(section) { reg.section = section; return () => {} },
        },
      })
    },
  }
  installCallPersona(ctx, { enabled: true, isActive: () => active.value })
  return reg
}

console.log('== 通话人设 ==')
const live = { value: false }
const reg = fakeCtx(live)

check('注册了系统提示节', () => {
  assert.equal(reg.section.name, CALL_PERSONA_SECTION)
  assert.equal(typeof reg.section.text, 'function')
  assert.equal(reg.section.interpolate, false)
})

check('挂断时渲染为空', () => {
  assert.equal(reg.section.text({}), '')
})

check('通话中渲染出规则', () => {
  live.value = true
  const text = reg.section.text({})
  assert.equal(text, CALL_PERSONA_TEXT)
  assert.ok(text.includes('口语'))
  assert.ok(text.includes('不要 Markdown'))
})

check('随后挂断又恢复为空', () => {
  live.value = false
  assert.equal(reg.section.text({}), '')
})

check('开关关闭时不注册', () => {
  let called = false
  installCallPersona({ inject() { called = true } }, { enabled: false, isActive: () => true })
  assert.equal(called, false)
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)