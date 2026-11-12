/**
 * 浏览器端 bundle 冒烟测试（不依赖真实浏览器/DSH）。
 * 用 vm + 假 window/document/require/EventSource/AudioContext 执行 lib/client.js，验证：
 *   1. __ModuleLoader__ 注册、apply 注册槽位
 *   2. 点击 🎙 → 开 SSE + 取麦 + 全屏通话覆盖层（DOM）
 *   3. asr final → setDraft + submit
 *   4. VAD 纯函数
 *   5. 关闭语音 → 关 SSE + /cancel + 移除覆盖层
 *
 * 运行：node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let failures = 0
function ok(cond, label, extra) {
  if (cond) { console.log(`  ✓ ${label}`) } else { failures++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 假 React ----------
const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
  useEffect(fn) { try { fn() } catch { /* ignore */ } },
}

// ---------- 假 DOM ----------
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    listeners: {},
    textContent: '',
    innerHTML: '',
    className: '',
    removed: false,
    appendChild(child) { this.children.push(child); child.parent = this; return child },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parent = null },
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn) },
    removeEventListener(name, fn) { const a = this.listeners[name] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    setAttribute(name, value) { this[name] = value },
    remove() { this.removed = true; if (this.parent) this.parent.removeChild(this) },
    querySelector() { return null },
    click() { for (const fn of this.listeners.click || []) fn() },
  }
  return el
}
const documentStub = {
  head: makeEl('head'),
  body: makeEl('body'),
  createElement(tag) { return makeEl(tag) },
  addEventListener() {},
  removeEventListener() {},
}
const bodyChildren = () => documentStub.body.children

// ---------- 假浏览器 ----------
const fetchCalls = []
async function fakeFetch(url, opts) {
  fetchCalls.push({ url, method: (opts && opts.method) || 'GET' })
  if (url === '/voice-local/status') {
    return { ok: true, status: 200, json: async () => ({ config: { vadThreshold: 0.02, autoEndSilenceMs: 700 }, engine: { state: 'ready', asrReady: true, ttsReady: true } }) }
  }
  if (url === '/voice-local/models') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        active: 'legacy',
        tts: [{ id: 'legacy', name: '旧配置', engine: 'vits2-onnx', ok: true }],
        asrActive: { streaming: 'zh-stream', final: 'zh-final' },
        asr: [
          { id: 'zh-stream', name: '中文流式', role: 'streaming', ok: true },
          { id: 'zh-final', name: '中文定稿', role: 'final', ok: true },
        ],
      }),
    }
  }
  return { ok: true, status: 200 }
}
const esInstances = []
class FakeEventSource {
  constructor(url) { this.url = url; this.handlers = {}; this.closed = false; esInstances.push(this) }
  addEventListener(name, fn) { this.handlers[name] = fn }
  close() { this.closed = true }
  dispatch(name, payload) { const fn = this.handlers[name]; if (fn) fn({ data: JSON.stringify(payload) }) }
}
class FakeAudioContext {
  constructor() { this.state = 'running'; this.sampleRate = 16000; this.currentTime = 0; this.destination = {}; this.audioWorklet = undefined }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null } }
  createBufferSource() { return { connect() {}, start() {}, stop() {}, onended: null } }
  createBuffer() { return { copyToChannel() {}, duration: 1 } }
  resume() { return Promise.resolve() }
  close() { this.state = 'closed' }
}
const stream = { getTracks: () => [{ stop() {} }] }
const mediaDevices = { getUserMedia: async () => stream }

const loaded = []
const fakeWindow = {
  __ModuleLoader__: { load(entry) { loaded.push(entry) } },
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
}

// 假 localStorage：验证背景主题记忆
const themeStore = new Map()
const localStorageStub = {
  getItem(key) { return themeStore.has(key) ? themeStore.get(key) : null },
  setItem(key, value) { themeStore.set(key, String(value)) },
  removeItem(key) { themeStore.delete(key) },
}

const sandbox = {
  window: fakeWindow,
  document: documentStub,
  navigator: { mediaDevices },
  fetch: fakeFetch,
  EventSource: FakeEventSource,
  localStorage: localStorageStub,
  atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
  console, setTimeout, clearTimeout, Promise,
  Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type } },
  URL: { createObjectURL: () => 'blob:mock' },
  AudioWorkletNode: undefined,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false }),
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

function findButton(node, label) {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const n of node) { const r = findButton(n, label); if (r) return r }
    return null
  }
  if (node.type === 'button' && node.props && node.props['aria-label'] === label) return node
  for (const c of node.children || []) { const r = findButton(c, label); if (r) return r }
  return null
}
const byAria = (el, label) => {
  if (!el) return null
  if (el['aria-label'] === label) return el
  for (const c of el.children || []) { const r = byAria(c, label); if (r) return r }
  return null
}

async function main() {
  console.log('== 1. bundle 注册 ==')
  ok(loaded.length === 1, '调用了一次 __ModuleLoader__.load', loaded.length)
  const entry = loaded[0]
  ok(entry && entry.id === 'dsh-plugin-voice-local', 'bundle id 正确', entry && entry.id)
  const mod = entry.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  ok(typeof mod.apply === 'function', 'exports.apply 存在')
  ok(mod.inject.includes('slots'), 'exports.inject 包含 slots', mod.inject)

  console.log('== 2. 槽位注册 ==')
  const registrations = []
  const ctx = {
    slots: {
      inject(name, factory) { registrations.push({ via: 'inject', name }); return factory() },
      register(spec, Comp) { registrations.push({ via: 'register', spec, Comp }); return () => {} },
    },
  }
  mod.apply(ctx)
  ok(registrations.some((r) => r.via === 'inject' && r.name === 'conversation.input.activity'), 'inject conversation.input.activity')
  const reg = registrations.find((r) => r.via === 'register')
  ok(reg && reg.spec.id === 'dsh-plugin-voice-local', 'register spec 正确', reg && reg.spec)
  ok(typeof reg.Comp === 'function', '注册了组件')

  console.log('== 3. 点击 🎙 → 开语音 + 全屏通话界面 ==')
  const draftCalls = []
  const submitCalls = []
  const inputActions = { setDraft(t) { draftCalls.push(t) }, submit() { submitCalls.push(true) } }
  const props = { inputActions, onActiveChange: () => {}, locked: false }
  let el = reg.Comp(props)
  const startBtn = findButton(el, '开始语音对话')
  ok(!!startBtn, '渲染出麦克风按钮', el && el.type)
  startBtn.props.onClick()
  await sleep(150)
  ok(esInstances.length === 1, '打开 SSE', esInstances.length)
  ok(/\/voice-local\/stream\?voice=1$/.test(esInstances[0].url), 'SSE 带 voice=1', esInstances[0].url)
  ok(fetchCalls.some((c) => c.url === '/voice-local/asr/start'), '调用了 /asr/start')
  ok(bodyChildren().length === 1, '挂载了全屏通话覆盖层', bodyChildren().length)
  let overlay = bodyChildren()[0]
  ok(overlay && overlay.className.includes('dvlc-root'), '覆盖层 class 正确', overlay && overlay.className)
  await sleep(30)
  ok(fetchCalls.some((c) => c.url === '/voice-local/models'), '覆盖层请求模型列表')
  ok(byAria(overlay, '静音') !== null, '有静音按钮')
  ok(byAria(overlay, '挂断') !== null, '有挂断按钮')
  ok(byAria(overlay, '打断') !== null, '有打断按钮')
  ok(byAria(overlay, '最小化') !== null, '有最小化按钮')

  console.log('== 4. 最小化 → 再打开 ==')
  const minBtn = byAria(overlay, '最小化')
  minBtn.click()
  await sleep(30)
  ok(bodyChildren().length === 0, '最小化移除覆盖层', bodyChildren().length)
  ok(mod.__internals.getState().overlay === false, 'state.overlay=false')
  el = reg.Comp(props)
  const reopenBtn = findButton(el, '打开通话界面')
  ok(!!reopenBtn, '语音条按钮变成"打开通话界面"')
  reopenBtn.props.onClick()
  await sleep(30)
  ok(bodyChildren().length === 1, '重新打开覆盖层', bodyChildren().length)
  overlay = bodyChildren()[0]

  console.log('== 4.5 背景主题切换 ==')
  const themeBtn = byAria(overlay, '切换通话背景')
  ok(themeBtn !== null, '有背景主题按钮')
  ok(overlay['data-theme'] === 'night-moss', '默认主题为夜色苔绿', overlay['data-theme'])
  themeBtn.click()
  const themeItems = []
  ;(function walk(node) {
    if (!node) return
    if (node['aria-label'] && String(node['aria-label']).indexOf('切换背景：') === 0) themeItems.push(node)
    for (const child of node.children || []) walk(child)
  })(overlay)
  ok(themeItems.length === 7, '主题菜单 7 套（4 暗 + 3 亮）', themeItems.length)
  const paperBtn = themeItems.find((b) => b['aria-label'] === '切换背景：晨光纸白')
  ok(!!paperBtn, '有晨光纸白选项')
  paperBtn.click()
  await sleep(20)
  ok(overlay['data-theme'] === 'day-paper', '切到亮色主题 data-theme=day-paper', overlay['data-theme'])
  ok(themeBtn.children[1].textContent === '晨光纸白', '按钮文案跟随主题', themeBtn.children[1].textContent)
  ok(themeStore.get('dsh-voice-overlay-theme') === 'day-paper', '主题写入 localStorage', themeStore.get('dsh-voice-overlay-theme'))
  mod.__internals.applyTheme('night-moss')
  ok(overlay['data-theme'] === 'night-moss', '可切回夜色苔绿', overlay['data-theme'])

  console.log('== 5. 转写定稿 → 提交到当前会话 ==')
  const es = esInstances[0]
  es.dispatch('hello', { engine: { state: 'ready', asrReady: true, ttsReady: true } })
  es.dispatch('asr', { kind: 'partial', text: '你好' })
  es.dispatch('asr', { kind: 'final', text: '你好，介绍一下你自己' })
  await sleep(150)
  ok(draftCalls.length === 1 && draftCalls[0] === '你好，介绍一下你自己', 'setDraft 写入转写文本', draftCalls)
  ok(submitCalls.length === 1, '调用了 submit()', submitCalls)

  console.log('== 6. 订阅到的状态 ==')
  const st = mod.__internals.getState()
  ok(st.overlay === true, 'overlay=true')
  ok(st.replyText === '', 'replyText 初始为空', st.replyText)

  console.log('== 7. 关闭语音 ==')
  el = reg.Comp(props)
  const closeBtn = findButton(el, '关闭语音对话')
  ok(!!closeBtn, '有关闭语音按钮')
  closeBtn.props.onClick()
  await sleep(60)
  ok(es.closed === true, '关闭 SSE')
  ok(fetchCalls.some((c) => c.url === '/voice-local/cancel'), '调用了 /cancel')
  ok(bodyChildren().length === 0, '覆盖层已移除', bodyChildren().length)

  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1) })
