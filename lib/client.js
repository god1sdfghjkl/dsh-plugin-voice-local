/**
 * dsh-plugin-voice-local · 浏览器端（client bundle）
 *
 * 在 DSH 里提供两种形态的语音对话：
 *   1) 输入框工具条上的语音条（轻量：电平 + 字幕 + 结束/关闭）
 *   2) 全屏「通话模式」覆盖层（沉浸：呼吸球 + 实时字幕 + 静音/打断/挂断）
 *
 * 链路：AudioWorklet 16k → VAD 自动断句 → 宿主 ASR → 自动提交到当前会话
 *       → 宿主 tap llm/stream 切句 TTS → SSE 推 PCM → AudioContext 播放 → 开口可打断
 *
 * 形态对齐 DSH 客户端插件：window.__ModuleLoader__.load({ id, factory })
 * exports.inject = ['slots']，注册到 conversation.input.activity 槽位。
 *
 * 设计：自研「夜色苔绿」通话界面 —— 近黑底色、暖灰白文字、低饱和苔绿点缀，
 * 衬线斜体标题 + 无衬线正文 + 呼吸波形 + 实时字幕光标；配色/尺寸/动效均为本插件自有参数。
 * 字体 Instrument Serif / Inter / Lora 为 OFL 1.1，随包内置（见 THIRD_PARTY_NOTICES.md）。
 *
 * 复用代码（MIT，见 THIRD_PARTY_NOTICES.md）：
 *   - AudioWorklet + 线性重采样：dsh-voice-mode
 *   - VAD 纯函数：dsh-talk
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-voice-local',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const BASE = '/voice-local'
    const REDUCED = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false

    // ------------------------------------------------------------ 配置（宿主 /status 覆盖）
    const cfg = {
      vadThreshold: 0.012,
      autoEndSilenceMs: 900,
      minSpeechMs: 200,
      maxUtteranceMs: 30000,
      bargeIn: true,
      bargeInThreshold: 0.025,
    }

    // ------------------------------------------------------------ AudioWorklet（MIT · dsh-voice-mode）
    const WORKLET_SRC = `"use strict";
(() => {
  function resampleLinear(src, srcRate, dstRate) {
    if (srcRate === dstRate) return src;
    if (src.length === 0) return src;
    const ratio = srcRate / dstRate;
    const outLen = Math.max(1, Math.floor(src.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, src.length - 1);
      const frac = pos - i0;
      out[i] = src[i0] + (src[i1] - src[i0]) * frac;
    }
    return out;
  }
  var TARGET_RATE = 16000;
  var CHUNK = 1024;
  var RATIO = sampleRate / TARGET_RATE;
  var NEED = Math.ceil(CHUNK * RATIO);
  var VoiceCaptureProcessor = class extends AudioWorkletProcessor {
    constructor() { super(); this.acc = new Float32Array(0); this.accLen = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch && ch.length > 0) this.push(ch);
      this.drain();
      return true;
    }
    push(ch) {
      if (this.accLen + ch.length > this.acc.length) {
        let cap = this.acc.length > 0 ? this.acc.length : NEED * 2;
        while (cap < this.accLen + ch.length) cap *= 2;
        const next = new Float32Array(cap);
        next.set(this.acc.subarray(0, this.accLen));
        this.acc = next;
      }
      this.acc.set(ch, this.accLen);
      this.accLen += ch.length;
    }
    drain() {
      while (this.accLen >= NEED) {
        const src = sampleRate === TARGET_RATE ? this.acc.subarray(0, CHUNK) : resampleLinear(this.acc.subarray(0, NEED), sampleRate, TARGET_RATE);
        const chunk = new Float32Array(CHUNK);
        chunk.set(src.length >= CHUNK ? src.subarray(0, CHUNK) : src);
        this.port.postMessage(chunk, [chunk.buffer]);
        this.acc.copyWithin(0, NEED, this.accLen);
        this.accLen -= NEED;
      }
    }
  };
  registerProcessor("voice-capture", VoiceCaptureProcessor);
})();`

    let workletUrl = null

    // ------------------------------------------------------------ 状态
    const initial = {
      enabled: false,
      phase: 'idle',        // idle | listening | thinking | speaking
      userText: '',
      replyText: '',
      error: '',
      level: 0,
      muted: false,
      overlay: false,
      engine: null,
      modelNote: '',
    }
    const state = { ...initial }
    const listeners = new Set()
    const snapshot = () => ({ ...state })
    function emit(patch) {
      Object.assign(state, patch)
      if (state.overlay || patch.overlay === false) updateOverlay()
      const snap = snapshot()
      for (const fn of [...listeners]) { try { fn(snap) } catch { /* ignore */ } }
    }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

    // ------------------------------------------------------------ VAD 纯函数（MIT · dsh-talk）
    function rmsOf(samples) {
      if (!samples || samples.length === 0) return 0
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
      return Math.sqrt(sum / samples.length)
    }
    function isSpeechFrame(rms, threshold) { return rms >= threshold }
    function advanceSilence(previousSilenceMs, frameMs, speech) {
      return speech ? 0 : previousSilenceMs + frameMs
    }
    function silenceTrips(silenceMs, thresholdMs) { return silenceMs >= thresholdMs }

    // ------------------------------------------------------------ 音频播放
    let audioCtx = null
    let nextTime = 0
    const sources = new Set()
    function audio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      return audioCtx
    }
    function stopAudio() {
      for (const s of sources) { try { s.stop() } catch { /* ignore */ } }
      sources.clear()
      nextTime = 0
    }
    function playChunk(b64, sampleRate) {
      if (!b64) return
      let pcm
      try {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        pcm = new Int16Array(bytes.buffer)
      } catch { return }
      if (!pcm.length) return
      const ctx = audio()
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      const f32 = new Float32Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768
      const buf = ctx.createBuffer(1, f32.length, sampleRate || 44100)
      buf.copyToChannel(f32, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const at = Math.max(ctx.currentTime + 0.02, nextTime)
      src.start(at)
      nextTime = at + buf.duration
      sources.add(src)
      src.onended = () => sources.delete(src)
    }

    // ------------------------------------------------------------ 采集
    let capture = null
    let mode = 'idle'       // idle | listening | monitor
    let vad = { speechSeen: false, silenceMs: 0, speechMs: 0 }
    let bargeFrames = 0
    let awaitingFinal = false
    const int16Buf = []
    let int16Len = 0

    function resetVad() { vad = { speechSeen: false, silenceMs: 0, speechMs: 0 }; bargeFrames = 0 }

    function ingest(f32, sr) {
      let data = f32
      if (sr && sr !== 16000) {
        const ratio = sr / 16000
        const n = Math.floor(f32.length / ratio)
        data = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const p = i * ratio
          const i0 = Math.floor(p)
          const i1 = Math.min(i0 + 1, f32.length - 1)
          data[i] = f32[i0] + (f32[i1] - f32[i0]) * (p - i0)
        }
      }
      const rms = rmsOf(data)
      const level = Math.min(1, Math.max(0, rms * 8))
      pendingLevel = level
      const frameMs = (data.length / 16000) * 1000
      for (let i = 0; i < data.length; i++) {
        const v = Math.max(-1, Math.min(1, data[i]))
        int16Buf.push(v * 32767 | 0)
      }
      int16Len += data.length
      if (int16Len >= 3200) flushPcm()
      if (mode === 'listening') {
        const speech = isSpeechFrame(rms, cfg.vadThreshold)
        if (speech) { vad.speechSeen = true; vad.speechMs += frameMs }
        vad.silenceMs = advanceSilence(vad.silenceMs, frameMs, speech && vad.speechSeen)
        if (vad.speechSeen && vad.speechMs >= cfg.minSpeechMs && silenceTrips(vad.silenceMs, cfg.autoEndSilenceMs)) {
          finalizeTurn()
        } else if (vad.speechSeen && vad.speechMs >= cfg.maxUtteranceMs) {
          finalizeTurn()
        }
      } else if (mode === 'monitor' && cfg.bargeIn) {
        if (isSpeechFrame(rms, cfg.bargeInThreshold)) {
          bargeFrames++
          if (bargeFrames >= 3) triggerBargeIn()
        } else {
          bargeFrames = 0
        }
      }
    }

    function flushPcm() {
      if (!int16Len || !state.enabled || state.muted) return
      const ints = new Int16Array(int16Buf.splice(0, int16Buf.length))
      int16Len = 0
      fetch(BASE + '/asr/feed', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: ints.buffer,
      }).catch(() => { /* 下一帧继续 */ })
    }

    async function startCapture(nextMode) {
      if (!state.enabled || state.muted) return
      if (capture) { mode = nextMode; resetVad(); return }
      resetVad()
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('浏览器不支持麦克风（需要 HTTPS 或 127.0.0.1）')
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        const Ctor = window.AudioContext || window.webkitAudioContext
        const ctx = new Ctor()
        if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* ignore */ } }
        const source = ctx.createMediaStreamSource(stream)
        let node = null
        if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
          try {
            if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
            await ctx.audioWorklet.addModule(workletUrl)
            node = new AudioWorkletNode(ctx, 'voice-capture', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            })
            node.port.onmessage = (ev) => { if (state.enabled) ingest(ev.data, 16000) }
          } catch { node = null }
        }
        if (!node) {
          node = ctx.createScriptProcessor(4096, 1, 1)
          const sr = ctx.sampleRate
          node.onaudioprocess = (ev) => {
            if (!state.enabled) return
            try { ingest(new Float32Array(ev.inputBuffer.getChannelData(0)), sr) } catch { /* ignore */ }
          }
        }
        source.connect(node)
        node.connect(ctx.destination)
        capture = { stream, ctx, node, source }
        mode = nextMode
        resetVad()
      } catch (e) {
        stopCapture()
        emit({ phase: 'idle', error: '麦克风不可用：' + (e && e.message ? e.message : e) })
        if (state.enabled) maybeResumeListening(1500)
      }
    }

    function stopCapture() {
      if (!capture) return
      const c = capture
      capture = null
      mode = 'idle'
      try { if (c.node.port) c.node.port.onmessage = null } catch { /* ignore */ }
      try { c.node.onaudioprocess = null } catch { /* ignore */ }
      try { c.node.disconnect() } catch { /* ignore */ }
      try { c.source.disconnect() } catch { /* ignore */ }
      try { c.stream.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      try { c.ctx.close() } catch { /* ignore */ }
      int16Buf.length = 0
      int16Len = 0
      bargeFrames = 0
    }

    // ------------------------------------------------------------ 会话提交
    let inputActions = null
    function attach(actions) { inputActions = actions || null }
    function detach(actions) { if (inputActions === actions) inputActions = null }

    function submitText(text) {
      const clean = String(text || '').trim()
      if (!clean) return
      if (!inputActions || typeof inputActions.setDraft !== 'function') {
        emit({ error: '输入框接口不可用（需要 DSH 0.2.x 的会话输入契约）' })
        return
      }
      emit({ phase: 'thinking', replyText: '', error: '', level: 0 })
      try {
        inputActions.setDraft(clean)
        setTimeout(() => {
          try {
            if (typeof inputActions.submit === 'function') inputActions.submit()
            else emit({ error: '输入框缺少 submit()' })
          } catch (e) {
            emit({ error: '提交失败：' + (e && e.message ? e.message : e) })
          }
        }, 30)
      } catch (e) {
        emit({ error: '写入输入框失败：' + (e && e.message ? e.message : e) })
      }
    }

    // ------------------------------------------------------------ 轮次控制
    function finalizeTurn() {
      if (mode !== 'listening') return
      awaitingFinal = true
      stopCapture()
      post('/asr/final')
      emit({ phase: 'thinking', level: 0 })
    }

    let bargeLock = false
    function triggerBargeIn() {
      if (bargeLock || !state.enabled) return
      bargeLock = true
      stopAudio()
      post('/cancel')
      mode = 'listening'
      resetVad()
      vad.speechSeen = true
      emit({ phase: 'listening', error: '' })
      setTimeout(() => { bargeLock = false }, 600)
    }

    function post(path) {
      return fetch(BASE + path, { method: 'POST' }).catch(() => {})
    }

    function setMuted(muted) {
      if (state.muted === muted) return
      if (muted) { stopCapture(); emit({ muted: true, level: 0 }) }
      else {
        emit({ muted: false })
        if (state.enabled) { startCapture('listening'); post('/asr/start') }
      }
    }

    // ------------------------------------------------------------ SSE
    let es = null
    let resumeTimer = null
    let sawTts = false
    function clearResume() { if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null } }
    function maybeResumeListening(delay) {
      clearResume()
      resumeTimer = setTimeout(() => {
        resumeTimer = null
        if (!state.enabled) return
        if (state.phase === 'speaking' || state.phase === 'thinking' || state.phase === 'idle') {
          startCapture('listening')
          if (state.phase !== 'listening') emit({ phase: 'listening' })
          post('/asr/start')
        }
      }, delay == null ? 500 : delay)
    }

    function onAsr(d) {
      if (!d) return
      if (d.kind === 'partial') {
        emit({ userText: d.text || '' })
      } else if (d.kind === 'final') {
        const text = String(d.text || '').trim()
        if (text) {
          awaitingFinal = false
          emit({ userText: text })
          submitText(text)
        } else {
          awaitingFinal = false
          emit({ error: '' })
          if (state.enabled) maybeResumeListening(500)
        }
      } else if (d.kind === 'warn' && d.message) {
        emit({ error: d.message })
      }
    }

    function onTts(d) {
      if (!d) return
      if (d.kind === 'start') {
        sawTts = true
        clearResume()
        emit({ phase: 'speaking' })
        if (state.enabled) startCapture('monitor')
      } else if (d.kind === 'audio') {
        playChunk(d.pcm, d.sampleRate)
      } else if (d.kind === 'end') {
        stopCapture()
        maybeResumeListening(500)
      } else if (d.kind === 'cancel') {
        clearResume()
        stopAudio()
        if (state.enabled) { startCapture('listening'); emit({ phase: 'listening' }) }
      } else if (d.kind === 'error') {
        clearResume()
        stopAudio()
        stopCapture()
        if (d.message) emit({ error: '合成失败：' + d.message })
        if (state.enabled) maybeResumeListening(600)
      }
    }

    function openSse() {
      if (es) return
      try {
        es = new EventSource(BASE + '/stream?voice=1')
      } catch (e) {
        emit({ error: 'SSE 连接失败：' + (e && e.message ? e.message : e) })
        return
      }
      es.addEventListener('hello', (e) => {
        try {
          const d = JSON.parse(e.data)
          emit({ engine: d.engine || null })
          if (d.engine && d.engine.state === 'error') emit({ error: '语音引擎未就绪：' + (d.engine.lastError || '未知原因') })
        } catch { /* ignore */ }
      })
      es.addEventListener('state', (e) => { try { emit({ engine: JSON.parse(e.data) }) } catch { /* ignore */ } })
      es.addEventListener('model', (e) => {
        try {
          const d = JSON.parse(e.data)
          if (d.phase === 'download') emit({ modelNote: `${d.file || ''} · ${fmtBytes(d.received || 0)} / ${fmtBytes(d.total || 0)}` })
          else if (d.phase === 'start') emit({ modelNote: '开始下载模型文件…' })
          else if (d.phase === 'skip') emit({ modelNote: `已存在 ${d.file || ''}` })
          else if (d.phase === 'done') emit({ modelNote: `完成 ${d.file || ''}` })
          else if (d.phase === 'complete') {
            emit({ modelNote: `模型下载完成（${d.downloaded || 0} 个文件）` })
            void loadTtsModels()
          } else if (d.phase === 'error') {
            emit({ error: '模型下载失败：' + (d.error || ''), modelNote: '' })
          }
        } catch { /* ignore */ }
      })
      es.addEventListener('asr', (e) => { try { onAsr(JSON.parse(e.data)) } catch { /* ignore */ } })
      es.addEventListener('assistant', (e) => {
        try {
          const d = JSON.parse(e.data)
          if (d.kind === 'delta' && d.text) emit({ replyText: (state.replyText + d.text).slice(-600) })
          if (d.kind === 'done' && state.phase === 'thinking' && !sawTts) maybeResumeListening(500)
        } catch { /* ignore */ }
      })
      es.addEventListener('tts', (e) => { try { onTts(JSON.parse(e.data)) } catch { /* ignore */ } })
      es.onerror = () => { /* EventSource 自动重连 */ }
    }

    function closeSse() {
      if (es) { try { es.close() } catch { /* ignore */ } es = null }
      clearResume()
    }

    // ------------------------------------------------------------ 开关
    async function refreshConfig() {
      try {
        const r = await fetch(BASE + '/status')
        const j = await r.json()
        if (j && j.config) {
          for (const k of Object.keys(cfg)) {
            if (typeof j.config[k] === 'number' || typeof j.config[k] === 'boolean') cfg[k] = j.config[k]
          }
        }
        if (j && j.engine) emit({ engine: j.engine })
      } catch { /* 用默认配置 */ }
    }

    function enable() {
      emit({ enabled: true, phase: 'idle', userText: '', replyText: '', error: '', level: 0, muted: false })
      startedAt = Date.now()
      openOverlay()
      openSse()
      refreshConfig()
      startCapture('listening').then(() => {
        if (capture) { emit({ phase: 'listening' }); post('/asr/start') }
      })
    }

    function disable() {
      emit({ enabled: false, phase: 'idle', userText: '', replyText: '', level: 0 })
      awaitingFinal = false
      startedAt = 0
      stopCapture()
      post('/cancel')
      stopAudio()
      closeSse()
      closeOverlay()
    }

    function primaryAction() {
      if (!state.enabled) { enable(); return }
      if (state.overlay) { closeOverlay(); return }
      openOverlay()
    }

    // ------------------------------------------------------------ 全屏通话覆盖层
    // 7 套背景主题：4 暗 + 3 亮。所有颜色都走 CSS 变量，切换主题只改变量，不动 DOM 结构。
    // 默认「夜色苔绿」：近黑底 + 暖灰白字 + 低饱和苔绿点缀，长时间通话不刺眼。
    const SERIF = '"Instrument Serif", "Iowan Old Style", "Palatino Linotype", Georgia, "Songti SC", serif'
    const SANS = 'Inter, "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif'
    const BODY_SERIF = 'Lora, Georgia, "Songti SC", "Noto Serif CJK SC", serif'

    const THEME_KEY = 'dsh-voice-overlay-theme'
    const THEMES = [
      {
        id: 'night-moss', name: '夜色苔绿', tone: 'dark',
        swatch: 'linear-gradient(135deg, #a9c59b 0 44%, #11150f 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #1a2017 0%, #11150f 44%, #0b0d0a 100%)',
          ink: '#ecefe4', stone: '#a9aea0', 'stone-soft': '#767c6e',
          line: 'rgba(236,239,228,.10)', 'line-strong': 'rgba(236,239,228,.18)',
          accent: '#bccfae', 'accent-strong': '#a9c59b', 'accent-text': 'rgba(169,197,155,.80)',
          surface: 'rgba(236,239,228,.05)', 'surface-hover': 'rgba(236,239,228,.10)',
          'menu-bg': 'rgba(18,21,15,.98)', 'menu-hover': 'rgba(236,239,228,.08)', 'active-bg': 'rgba(169,197,155,.14)',
          danger: '#cf6a45', 'danger-soft': 'rgba(207,106,69,.16)', 'danger-line': 'rgba(207,106,69,.35)', 'danger-text': '#e8906f', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(236,239,228,.16), rgba(236,239,228,0) 48%), radial-gradient(circle at 50% 58%, #232c1e 0%, #1a2116 58%, #10140e 100%)',
          'orb-glow': 'rgba(169,197,155,.10)', 'core-inset': 'rgba(0,0,0,.45)',
          'ring-1': 'rgba(169,197,155,.30)', 'ring-2': 'rgba(169,197,155,.16)',
          wave: '#dbe8d0', 'ctrl-ink': '#e3e8da',
          noise: '.035', shadow: 'rgba(0,0,0,.55)', hint: 'rgba(118,124,110,.92)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23a9aea0' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
      {
        id: 'night-slate', name: '深夜靛蓝', tone: 'dark',
        swatch: 'linear-gradient(135deg, #93b3d1 0 44%, #101620 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #1a2230 0%, #101620 44%, #080b10 100%)',
          ink: '#e7edf4', stone: '#a3adba', 'stone-soft': '#6f7a88',
          line: 'rgba(231,237,244,.10)', 'line-strong': 'rgba(231,237,244,.18)',
          accent: '#b6cbe2', 'accent-strong': '#93b3d1', 'accent-text': 'rgba(147,179,209,.80)',
          surface: 'rgba(231,237,244,.05)', 'surface-hover': 'rgba(231,237,244,.10)',
          'menu-bg': 'rgba(15,20,28,.98)', 'menu-hover': 'rgba(231,237,244,.08)', 'active-bg': 'rgba(147,179,209,.16)',
          danger: '#d0704a', 'danger-soft': 'rgba(208,112,74,.16)', 'danger-line': 'rgba(208,112,74,.35)', 'danger-text': '#ec9d7c', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(231,237,244,.16), rgba(231,237,244,0) 48%), radial-gradient(circle at 50% 58%, #202b3a 0%, #17202b 58%, #0d131a 100%)',
          'orb-glow': 'rgba(147,179,209,.10)', 'core-inset': 'rgba(0,0,0,.45)',
          'ring-1': 'rgba(147,179,209,.30)', 'ring-2': 'rgba(147,179,209,.16)',
          wave: '#d3e3f2', 'ctrl-ink': '#e3ecf5',
          noise: '.035', shadow: 'rgba(0,0,0,.55)', hint: 'rgba(111,122,136,.92)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23a3adba' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
      {
        id: 'night-plum', name: '暗夜梅紫', tone: 'dark',
        swatch: 'linear-gradient(135deg, #c09dba 0 44%, #16111a 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #211a25 0%, #16111a 44%, #0b080d 100%)',
          ink: '#f0e9ef', stone: '#b1a4ae', 'stone-soft': '#7d7079',
          line: 'rgba(240,233,239,.10)', 'line-strong': 'rgba(240,233,239,.18)',
          accent: '#d8bdd2', 'accent-strong': '#c09dba', 'accent-text': 'rgba(192,157,186,.80)',
          surface: 'rgba(240,233,239,.05)', 'surface-hover': 'rgba(240,233,239,.10)',
          'menu-bg': 'rgba(21,15,24,.98)', 'menu-hover': 'rgba(240,233,239,.08)', 'active-bg': 'rgba(192,157,186,.16)',
          danger: '#d06a58', 'danger-soft': 'rgba(208,106,88,.16)', 'danger-line': 'rgba(208,106,88,.35)', 'danger-text': '#ef9c8a', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(240,233,239,.16), rgba(240,233,239,0) 48%), radial-gradient(circle at 50% 58%, #2a2030 0%, #1e1624 58%, #130d17 100%)',
          'orb-glow': 'rgba(192,157,186,.10)', 'core-inset': 'rgba(0,0,0,.45)',
          'ring-1': 'rgba(192,157,186,.30)', 'ring-2': 'rgba(192,157,186,.16)',
          wave: '#ecd9e6', 'ctrl-ink': '#efe6ee',
          noise: '.035', shadow: 'rgba(0,0,0,.55)', hint: 'rgba(125,112,121,.92)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23b1a4ae' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
      {
        id: 'night-amber', name: '暖夜琥珀', tone: 'dark',
        swatch: 'linear-gradient(135deg, #d3ad78 0 44%, #18120b 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #241c12 0%, #18120b 44%, #0e0906 100%)',
          ink: '#f4ecdd', stone: '#b6a892', 'stone-soft': '#857867',
          line: 'rgba(244,236,221,.10)', 'line-strong': 'rgba(244,236,221,.18)',
          accent: '#e6c79a', 'accent-strong': '#d3ad78', 'accent-text': 'rgba(211,173,120,.80)',
          surface: 'rgba(244,236,221,.05)', 'surface-hover': 'rgba(244,236,221,.10)',
          'menu-bg': 'rgba(24,18,11,.98)', 'menu-hover': 'rgba(244,236,221,.08)', 'active-bg': 'rgba(211,173,120,.16)',
          danger: '#d0603c', 'danger-soft': 'rgba(208,96,60,.16)', 'danger-line': 'rgba(208,96,60,.35)', 'danger-text': '#ef9a72', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(244,236,221,.16), rgba(244,236,221,0) 48%), radial-gradient(circle at 50% 58%, #2c2418 0%, #21190f 58%, #15100a 100%)',
          'orb-glow': 'rgba(211,173,120,.10)', 'core-inset': 'rgba(0,0,0,.45)',
          'ring-1': 'rgba(211,173,120,.30)', 'ring-2': 'rgba(211,173,120,.16)',
          wave: '#f0dfc2', 'ctrl-ink': '#f2e8d8',
          noise: '.035', shadow: 'rgba(0,0,0,.55)', hint: 'rgba(133,120,103,.92)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23b6a892' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
      {
        id: 'day-paper', name: '晨光纸白', tone: 'light',
        swatch: 'linear-gradient(135deg, #4f6b3f 0 44%, #f4f2ea 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #fbfaf6 0%, #f1efe8 46%, #e6e4da 100%)',
          ink: '#23281f', stone: '#59604f', 'stone-soft': '#7e8574',
          line: 'rgba(35,40,31,.12)', 'line-strong': 'rgba(35,40,31,.22)',
          accent: '#4f6b3f', 'accent-strong': '#3f5a30', 'accent-text': 'rgba(63,90,48,.78)',
          surface: 'rgba(35,40,31,.05)', 'surface-hover': 'rgba(35,40,31,.10)',
          'menu-bg': 'rgba(252,251,246,.99)', 'menu-hover': 'rgba(35,40,31,.07)', 'active-bg': 'rgba(63,90,48,.12)',
          danger: '#b6543a', 'danger-soft': 'rgba(182,84,58,.14)', 'danger-line': 'rgba(182,84,58,.32)', 'danger-text': '#a8482f', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(255,255,255,.75), rgba(255,255,255,0) 50%), radial-gradient(circle at 50% 58%, #e9ece0 0%, #dde3d2 58%, #cfd8c2 100%)',
          'orb-glow': 'rgba(79,107,63,.12)', 'core-inset': 'rgba(35,40,31,.10)',
          'ring-1': 'rgba(79,107,63,.26)', 'ring-2': 'rgba(79,107,63,.14)',
          wave: '#4b6340', 'ctrl-ink': '#3c4634',
          noise: '.05', shadow: 'rgba(35,40,31,.20)', hint: 'rgba(110,117,100,.95)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2359604f' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
      {
        id: 'day-sand', name: '暖沙米色', tone: 'light',
        swatch: 'linear-gradient(135deg, #7d5f33 0 44%, #f2ead9 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #fbf6ec 0%, #f2ead9 48%, #e7dcc7 100%)',
          ink: '#2e2618', stone: '#655b47', 'stone-soft': '#8a7f69',
          line: 'rgba(46,38,24,.12)', 'line-strong': 'rgba(46,38,24,.22)',
          accent: '#7d5f33', 'accent-strong': '#6a4f28', 'accent-text': 'rgba(106,79,40,.78)',
          surface: 'rgba(46,38,24,.05)', 'surface-hover': 'rgba(46,38,24,.10)',
          'menu-bg': 'rgba(253,250,243,.99)', 'menu-hover': 'rgba(46,38,24,.07)', 'active-bg': 'rgba(106,79,40,.12)',
          danger: '#b25637', 'danger-soft': 'rgba(178,86,55,.14)', 'danger-line': 'rgba(178,86,55,.32)', 'danger-text': '#9d4529', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(255,255,255,.72), rgba(255,255,255,0) 50%), radial-gradient(circle at 50% 58%, #efe6d3 0%, #e6dbc4 58%, #d9ccb2 100%)',
          'orb-glow': 'rgba(125,95,51,.12)', 'core-inset': 'rgba(46,38,24,.10)',
          'ring-1': 'rgba(125,95,51,.28)', 'ring-2': 'rgba(125,95,51,.14)',
          wave: '#6b5230', 'ctrl-ink': '#4a3d26',
          noise: '.05', shadow: 'rgba(46,38,24,.20)', hint: 'rgba(138,127,105,.95)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23655b47' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
      {
        id: 'day-sky', name: '静谧天蓝', tone: 'light',
        swatch: 'linear-gradient(135deg, #3e6c8c 0 44%, #e9f0f4 44%)',
        vars: {
          bg: 'radial-gradient(1100px 760px at 26% 4%, #f4f8fa 0%, #e9f0f4 48%, #dbe5ec 100%)',
          ink: '#1d282f', stone: '#506270', 'stone-soft': '#74889a',
          line: 'rgba(29,40,47,.12)', 'line-strong': 'rgba(29,40,47,.22)',
          accent: '#3e6c8c', 'accent-strong': '#2f5a78', 'accent-text': 'rgba(47,90,120,.78)',
          surface: 'rgba(29,40,47,.05)', 'surface-hover': 'rgba(29,40,47,.10)',
          'menu-bg': 'rgba(250,253,255,.99)', 'menu-hover': 'rgba(29,40,47,.07)', 'active-bg': 'rgba(47,90,120,.12)',
          danger: '#b2492f', 'danger-soft': 'rgba(178,73,47,.14)', 'danger-line': 'rgba(178,73,47,.32)', 'danger-text': '#993d26', 'on-danger': '#ffffff',
          'orb-grad': 'radial-gradient(circle at 34% 26%, rgba(255,255,255,.72), rgba(255,255,255,0) 50%), radial-gradient(circle at 50% 58%, #e6eef3 0%, #dbe7ee 58%, #cddde7 100%)',
          'orb-glow': 'rgba(47,90,120,.12)', 'core-inset': 'rgba(29,40,47,.10)',
          'ring-1': 'rgba(63,108,140,.28)', 'ring-2': 'rgba(63,108,140,.14)',
          wave: '#3d5e74', 'ctrl-ink': '#334853',
          noise: '.045', shadow: 'rgba(29,40,47,.20)', hint: 'rgba(116,136,154,.95)',
          chevron: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23506270' stroke-width='1.4' stroke-linecap='round'/></svg>")`,
        },
      },
    ]
    const DEFAULT_THEME = THEMES[0]
    const THEME_VARS = Object.keys(DEFAULT_THEME.vars)

    function themeVarBlock(selector, vars) {
      return selector + '{' + THEME_VARS.map((k) => '--dvlc-' + k + ':' + vars[k] + ';').join('') + '}'
    }
    const THEME_CSS = themeVarBlock('.dvlc-root', DEFAULT_THEME.vars)
      + THEMES.filter((t) => t.id !== DEFAULT_THEME.id)
        .map((t) => themeVarBlock('.dvlc-root[data-theme="' + t.id + '"]', t.vars))
        .join('')

    let currentThemeId = DEFAULT_THEME.id

    function themeById(id) {
      return THEMES.find((t) => t.id === id) || DEFAULT_THEME
    }
    function readSavedTheme() {
      try {
        if (typeof localStorage === 'undefined') return DEFAULT_THEME.id
        const id = localStorage.getItem(THEME_KEY)
        return THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME.id
      } catch { return DEFAULT_THEME.id }
    }
    function saveTheme(id) {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, id) } catch { /* 忽略隐私模式限制 */ }
    }
    function updateThemeButton(t) {
      if (!overlayRefs) return
      if (overlayRefs.themeSwatch) overlayRefs.themeSwatch.style.background = t.swatch
      if (overlayRefs.themeName) overlayRefs.themeName.textContent = t.name
    }
    function applyTheme(id) {
      const t = themeById(id)
      currentThemeId = t.id
      saveTheme(t.id)
      if (overlayRefs && overlayRefs.root) overlayRefs.root.setAttribute('data-theme', t.id)
      updateThemeButton(t)
    }

    let overlayRoot = null
    let overlayRefs = null
    let rafId = 0
    let startedAt = 0
    let pendingLevel = 0
    let overlayStyleInjected = false

    function injectOverlayStyle() {
      if (overlayStyleInjected || typeof document === 'undefined') return
      overlayStyleInjected = true
      const css = `
@font-face { font-family: 'Instrument Serif'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('/voice-local/assets/fonts/InstrumentSerif-Regular.ttf') format('truetype'); }
@font-face { font-family: 'Instrument Serif'; font-style: italic; font-weight: 400; font-display: swap;
  src: url('/voice-local/assets/fonts/InstrumentSerif-Italic.ttf') format('truetype'); }
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('/voice-local/assets/fonts/Inter-400.ttf') format('truetype'); }
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 500; font-display: swap;
  src: url('/voice-local/assets/fonts/Inter-500.ttf') format('truetype'); }
@font-face { font-family: 'Lora'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('/voice-local/assets/fonts/Lora-400.ttf') format('truetype'); }
@font-face { font-family: 'Lora'; font-style: italic; font-weight: 400; font-display: swap;
  src: url('/voice-local/assets/fonts/Lora-Italic.ttf') format('truetype'); }
${THEME_CSS}
@keyframes dvlc-rise { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) } }
@keyframes dvlc-breath { 0%,100% { transform: scale(1) } 50% { transform: scale(1.05) } }
@keyframes dvlc-ring { 0% { transform: scale(.82); opacity: .5 } 100% { transform: scale(1.5); opacity: 0 } }
@keyframes dvlc-caret { 0%,45% { opacity: 1 } 50%,95% { opacity: 0 } }
.dvlc-root { position: fixed; inset: 0; z-index: 2147483600; display: flex; flex-direction: column;
  background: var(--dvlc-bg); color: var(--dvlc-ink); font-family: ${SANS}; -webkit-font-smoothing: antialiased;
  overscroll-behavior: contain; touch-action: manipulation;
  /* 覆盖层压在窗口标题栏拖拽区上：必须整层 no-drag，否则顶栏按钮点击会被系统当成拖窗口 */
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-root::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: var(--dvlc-noise);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='140' height='140' filter='url(%23n)' opacity='.55'/></svg>"); }
.dvlc-root * { box-sizing: border-box; }
.dvlc-rise { animation: dvlc-rise .5s cubic-bezier(.23,1,.32,1) both; }
/* 顶栏收进窗口控件那一行，模型 / 背景 / 时长 / 最小化整体上移 */
.dvlc-head { display: flex; align-items: center; gap: 12px; position: relative; z-index: 30;
  padding: calc(14px + env(safe-area-inset-top, 0px)) calc(170px + env(safe-area-inset-right, 0px)) 6px calc(30px + env(safe-area-inset-left, 0px));
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-brand { display: inline-flex; align-items: baseline; gap: 10px; }
.dvlc-name { font-family: ${SERIF}; font-style: italic; font-size: 22px; letter-spacing: .01em; color: var(--dvlc-ink); }
.dvlc-sub { font-size: 10.5px; letter-spacing: .12em; color: var(--dvlc-accent-text); }
.dvlc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dvlc-accent-strong);
  display: inline-block; align-self: center; box-shadow: 0 0 0 3px var(--dvlc-active-bg); }
.dvlc-spacer { flex: 1 }
.dvlc-model-wrap { position: relative; display: inline-flex; }
.dvlc-model-btn { max-width: 220px; height: 30px; padding: 0 28px 0 12px; border-radius: 15px; border: 1px solid var(--dvlc-line);
  background-color: var(--dvlc-surface); color: var(--dvlc-ink); font-family: ${SANS}; font-size: 12px; letter-spacing: .02em;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background-image: var(--dvlc-chevron); background-repeat: no-repeat; background-position: right 10px center;
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-model-btn:hover { border-color: var(--dvlc-line-strong); background-color: var(--dvlc-surface-hover); }
.dvlc-model-btn[disabled] { opacity: .5; cursor: default; }
.dvlc-theme-btn { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 26px 0 9px; border-radius: 15px;
  border: 1px solid var(--dvlc-line); background-color: var(--dvlc-surface); color: var(--dvlc-ink);
  font-family: ${SANS}; font-size: 12px; letter-spacing: .02em; cursor: pointer; white-space: nowrap;
  background-image: var(--dvlc-chevron); background-repeat: no-repeat; background-position: right 9px center;
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-theme-btn:hover { border-color: var(--dvlc-line-strong); background-color: var(--dvlc-surface-hover); }
.dvlc-theme-swatch { width: 16px; height: 16px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1px var(--dvlc-line-strong); }
.dvlc-theme-menu { position: absolute; top: calc(100% + 8px); right: 0; min-width: 198px; max-height: 340px; overflow-y: auto;
  padding: 6px; border-radius: 14px; border: 1px solid var(--dvlc-line-strong); background: var(--dvlc-menu-bg);
  box-shadow: 0 24px 60px var(--dvlc-shadow); z-index: 41; box-sizing: border-box;
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-theme-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border: 0; border-radius: 9px;
  background: transparent; color: var(--dvlc-ink); font-family: ${SANS}; font-size: 12.5px; text-align: left; cursor: pointer; }
.dvlc-theme-item:hover { background: var(--dvlc-menu-hover); }
.dvlc-theme-item.active { background: var(--dvlc-active-bg); color: var(--dvlc-accent); }
.dvlc-theme-item .dvlc-theme-swatch { width: 14px; height: 14px; }
.dvlc-theme-check { margin-left: auto; font-size: 11px; color: var(--dvlc-accent-text); }
.dvlc-model-menu { position: absolute; top: calc(100% + 8px); right: 0; min-width: 250px; max-height: 330px; overflow-y: auto;
  padding: 6px; border-radius: 14px; border: 1px solid var(--dvlc-line-strong); background: var(--dvlc-menu-bg);
  box-shadow: 0 24px 60px var(--dvlc-shadow); z-index: 40; box-sizing: border-box;
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-model-group { padding: 8px 10px 4px; font-size: 10px; letter-spacing: .16em; color: var(--dvlc-accent-text); }
.dvlc-model-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 9px;
  background: transparent; color: var(--dvlc-ink); font-family: ${SANS}; font-size: 12.5px; text-align: left; cursor: pointer; }
.dvlc-model-item:hover { background: var(--dvlc-menu-hover); }
.dvlc-model-item.active { background: var(--dvlc-active-bg); color: var(--dvlc-accent); }
.dvlc-model-item[disabled] { opacity: .45; cursor: default; }
.dvlc-model-tag { margin-left: auto; font-size: 10.5px; color: var(--dvlc-accent-text); }
.dvlc-model-tag.dl { color: var(--dvlc-danger-text); }
.dvlc-note { font-size: 11.5px; color: var(--dvlc-accent-text); max-width: 640px; text-align: center; }
.dvlc-note[hidden] { display: none; }
.dvlc-timer { font-variant-numeric: tabular-nums; color: var(--dvlc-stone-soft); font-size: 12.5px; letter-spacing: .08em; }
.dvlc-icon { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--dvlc-line);
  background: var(--dvlc-surface); color: var(--dvlc-accent);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px;
  -webkit-app-region: no-drag; app-region: no-drag; }
.dvlc-icon:hover { background: var(--dvlc-surface-hover); border-color: var(--dvlc-line-strong); }
.dvlc-stage { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 6vw 8px; min-height: 0; }
.dvlc-orb { position: relative; width: 176px; height: 176px; display: grid; place-items: center; }
.dvlc-ring { position: absolute; width: 140px; height: 140px; border-radius: 50%;
  border: 1px solid var(--dvlc-ring-1); animation: dvlc-ring 2.8s cubic-bezier(.16,.7,.3,1) infinite; }
.dvlc-ring2 { animation-delay: 1.4s; border-color: var(--dvlc-ring-2); }
.dvlc-core { position: relative; width: 124px; height: 124px; border-radius: 50%;
  background: var(--dvlc-orb-grad);
  box-shadow: 0 18px 50px var(--dvlc-shadow), 0 0 70px var(--dvlc-orb-glow),
              inset 0 0 0 1px var(--dvlc-line), inset 0 -14px 34px var(--dvlc-core-inset);
  display: grid; place-items: center; animation: dvlc-breath ${REDUCED ? 0 : 3.4}s ease-in-out infinite; }
.dvlc-wave { display: flex; align-items: center; justify-content: center; gap: 2.5px; height: 54px; }
.dvlc-wave i { display: block; width: 2.5px; border-radius: 2px; background: var(--dvlc-wave); opacity: .85; transition: height 90ms linear; }
.dvlc-status { margin-top: 18px; font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: var(--dvlc-accent-text); }
.dvlc-words { margin-top: 22px; width: 100%; max-width: 720px; text-align: center; min-height: 64px; }
.dvlc-assistant { font-family: ${BODY_SERIF}; font-size: 19px; line-height: 1.7; color: var(--dvlc-ink); text-wrap: balance; }
.dvlc-caret { display: inline-block; width: 2px; height: 1.05em; margin-left: 3px; vertical-align: -2px;
  background: var(--dvlc-accent-strong); border-radius: 1px; animation: dvlc-caret 1.1s steps(1) infinite; }
.dvlc-user { margin-top: 12px; font-size: 13px; color: var(--dvlc-stone); min-height: 20px; }
.dvlc-user b { font-weight: 600; color: var(--dvlc-accent); letter-spacing: .12em; margin-right: 8px; font-size: 11px; text-transform: uppercase; }
.dvlc-user[hidden] { display: none; }
.dvlc-foot { padding: 6px calc(24px + env(safe-area-inset-right, 0px)) calc(26px + env(safe-area-inset-bottom, 0px)) calc(24px + env(safe-area-inset-left, 0px));
  display: flex; flex-direction: column; align-items: center; gap: 14px; }
.dvlc-hint { font-size: 11.5px; color: var(--dvlc-hint); letter-spacing: .02em; }
.dvlc-controls { display: flex; align-items: center; gap: 30px; }
.dvlc-ctrl { background: transparent; border: 0; display: flex; flex-direction: column; align-items: center; gap: 7px;
  color: var(--dvlc-stone); font-size: 11px; letter-spacing: .06em; cursor: pointer; font-family: ${SANS}; }
.dvlc-round { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center;
  background: var(--dvlc-surface); border: 1px solid var(--dvlc-line); color: var(--dvlc-ctrl-ink);
  box-shadow: 0 10px 24px var(--dvlc-shadow); transition: transform .18s ease, background .18s ease; }
.dvlc-ctrl:hover .dvlc-round { transform: translateY(-2px); background: var(--dvlc-surface-hover); }
.dvlc-ctrl.danger .dvlc-round { background: var(--dvlc-danger); border-color: transparent; color: var(--dvlc-on-danger);
  box-shadow: 0 14px 34px var(--dvlc-shadow), inset 0 0 0 1px rgba(255,255,255,.06); }
.dvlc-ctrl.danger { color: var(--dvlc-danger-text); }
.dvlc-ctrl[disabled] { opacity: .42; cursor: default; }
.dvlc-ctrl[data-muted="true"] .dvlc-round { background: var(--dvlc-danger-soft); color: var(--dvlc-danger-text); border-color: var(--dvlc-danger-line); }
.dvlc-error { margin-top: 10px; color: var(--dvlc-danger-text); font-size: 12.5px; }
/* 手机 / 窄窗：安全区、触控尺寸、单行顶栏；桌面端不受影响 */
@media (max-width: 760px) {
  .dvlc-head { gap: 8px;
    padding: calc(10px + env(safe-area-inset-top, 0px)) calc(14px + env(safe-area-inset-right, 0px)) 4px calc(16px + env(safe-area-inset-left, 0px)); }
  .dvlc-name { font-size: 18px; }
  .dvlc-sub { display: none; }
  .dvlc-model-btn { max-width: 28vw; font-size: 11.5px; padding: 0 24px 0 10px; }
  .dvlc-theme-btn { font-size: 11.5px; padding: 0 24px 0 8px; background-position: right 8px center; }
  .dvlc-theme-name { max-width: 84px; overflow: hidden; text-overflow: ellipsis; }
  .dvlc-timer { font-size: 11.5px; letter-spacing: .04em; }
  .dvlc-icon { width: 32px; height: 32px; flex: none; }
  .dvlc-stage { padding: 0 20px 4px; }
  .dvlc-orb { width: 148px; height: 148px; }
  .dvlc-ring { width: 120px; height: 120px; }
  .dvlc-core { width: 104px; height: 104px; }
  .dvlc-assistant { font-size: 17px; }
  .dvlc-words { max-width: 92vw; margin-top: 16px; }
  .dvlc-user { font-size: 12.5px; }
  .dvlc-foot { gap: 12px;
    padding: 4px calc(14px + env(safe-area-inset-right, 0px)) calc(18px + env(safe-area-inset-bottom, 0px)) calc(14px + env(safe-area-inset-left, 0px)); }
  .dvlc-hint { font-size: 10.5px; line-height: 1.6; text-align: center; padding: 0 8px; }
  .dvlc-controls { gap: 34px; }
  .dvlc-round { width: 56px; height: 56px; }
  .dvlc-ctrl { gap: 8px; font-size: 11.5px; }
  .dvlc-model-menu, .dvlc-theme-menu { max-width: calc(100vw - 24px); }
}
@media (max-width: 600px) {
  .dvlc-name { font-size: 17px; }
  .dvlc-theme-name { display: none; }
  .dvlc-theme-btn { gap: 0; padding: 0 22px 0 9px; }
  .dvlc-model-btn { max-width: 30vw; padding: 0 22px 0 9px; }
  .dvlc-controls { gap: 26px; }
  .dvlc-model-menu { min-width: 216px; }
}
@media (max-width: 560px) {
  .dvlc-head { gap: 6px; }
  .dvlc-timer { display: none; }
  .dvlc-model-btn { max-width: 26vw; }
}
@media (max-height: 620px) and (orientation: landscape) {
  .dvlc-orb { width: 112px; height: 112px; }
  .dvlc-ring { width: 92px; height: 92px; }
  .dvlc-core { width: 80px; height: 80px; }
  .dvlc-status { margin-top: 8px; }
  .dvlc-words { margin-top: 10px; }
  .dvlc-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dvlc-rise, .dvlc-ring, .dvlc-core, .dvlc-caret { animation: none !important; }
}`
      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
    }

    function svgIcon(kind) {
      const common = 'viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
      if (kind === 'mic') return `<svg ${common}><rect x="9.2" y="3.2" width="5.6" height="10.2" rx="2.8"/><path d="M6 11.4a6 6 0 0 0 12 0"/><line x1="12" y1="17.4" x2="12" y2="20.4"/></svg>`
      if (kind === 'mute') return `<svg ${common}><line x1="4" y1="4" x2="20" y2="20"/><path d="M9 5.5a3 3 0 0 1 5.8 1.2v4.2"/><path d="M6 11.4a6 6 0 0 0 9.2 5.2"/><line x1="12" y1="17.4" x2="12" y2="20.4"/></svg>`
      if (kind === 'pause') return `<svg ${common}><line x1="9.5" y1="6.5" x2="9.5" y2="17.5"/><line x1="14.5" y1="6.5" x2="14.5" y2="17.5"/></svg>`
      // 挂断：标准话机轮廓旋转 135°，读作「放下听筒」，与设计稿一致
      return `<svg ${common}><path transform="rotate(135 12 12)" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`
    }

    function buildOverlay() {
      if (typeof document === 'undefined') return null
      injectOverlayStyle()
      const root = document.createElement('div')
      root.className = 'dvlc-root dvlc-rise'
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-label', '语音通话')
      currentThemeId = readSavedTheme()
      root.setAttribute('data-theme', currentThemeId)

      const head = document.createElement('div')
      head.className = 'dvlc-head dvlc-rise'
      const brand = document.createElement('div')
      brand.className = 'dvlc-brand'
      const dot = document.createElement('span'); dot.className = 'dvlc-dot'
      const name = document.createElement('span'); name.className = 'dvlc-name'; name.textContent = '语音通话'
      const sub = document.createElement('span'); sub.className = 'dvlc-sub'; sub.textContent = 'DSH · 本地流式'
      brand.appendChild(dot); brand.appendChild(name); brand.appendChild(sub)
      const spacer = document.createElement('div'); spacer.className = 'dvlc-spacer'

      // 背景主题选择：放在模型色板左边，暗色 4 套 / 亮色 3 套
      const initialTheme = themeById(currentThemeId)
      const themeWrap = document.createElement('div'); themeWrap.className = 'dvlc-model-wrap'
      const themeBtn = document.createElement('button')
      themeBtn.type = 'button'
      themeBtn.className = 'dvlc-theme-btn'
      themeBtn.title = '切换通话背景'
      themeBtn.setAttribute('aria-label', '切换通话背景')
      const themeSwatch = document.createElement('span'); themeSwatch.className = 'dvlc-theme-swatch'
      themeSwatch.style.background = initialTheme.swatch
      const themeName = document.createElement('span'); themeName.className = 'dvlc-theme-name'
      themeName.textContent = initialTheme.name
      themeBtn.appendChild(themeSwatch); themeBtn.appendChild(themeName)
      themeBtn.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation()
        if (ev && ev.preventDefault) ev.preventDefault()
        toggleThemeMenu()
      })
      const themeMenu = document.createElement('div')
      themeMenu.className = 'dvlc-theme-menu'
      themeMenu.style.display = 'none'
      themeWrap.appendChild(themeBtn); themeWrap.appendChild(themeMenu)

      const modelWrap = document.createElement('div'); modelWrap.className = 'dvlc-model-wrap'
      const modelBtn = document.createElement('button')
      modelBtn.type = 'button'
      modelBtn.className = 'dvlc-model-btn'
      modelBtn.textContent = '模型'
      modelBtn.title = '切换 TTS / ASR 模型'
      modelBtn.setAttribute('aria-label', '切换 TTS / ASR 模型')
      modelBtn.style.display = 'none'
      modelBtn.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation()
        if (ev && ev.preventDefault) ev.preventDefault()
        toggleModelMenu()
      })
      const modelMenu = document.createElement('div')
      modelMenu.className = 'dvlc-model-menu'
      modelMenu.style.display = 'none'
      modelWrap.appendChild(modelBtn); modelWrap.appendChild(modelMenu)
      const timer = document.createElement('span'); timer.className = 'dvlc-timer'; timer.textContent = '00:00'
      const min = document.createElement('button'); min.className = 'dvlc-icon'; min.textContent = '—'
      min.setAttribute('aria-label', '最小化'); min.addEventListener('click', () => closeOverlay())
      head.appendChild(brand); head.appendChild(spacer); head.appendChild(themeWrap); head.appendChild(modelWrap); head.appendChild(timer); head.appendChild(min)

      const stage = document.createElement('div'); stage.className = 'dvlc-stage'
      const orb = document.createElement('div'); orb.className = 'dvlc-orb'
      const ring1 = document.createElement('div'); ring1.className = 'dvlc-ring'
      const ring2 = document.createElement('div'); ring2.className = 'dvlc-ring dvlc-ring2'
      const core = document.createElement('div'); core.className = 'dvlc-core'
      const wave = document.createElement('div'); wave.className = 'dvlc-wave'
      const bars = []
      for (let i = 0; i < 16; i++) {
        const bar = document.createElement('i')
        bar.style.height = '4px'
        wave.appendChild(bar); bars.push(bar)
      }
      core.appendChild(wave)
      orb.appendChild(ring1); orb.appendChild(ring2); orb.appendChild(core)

      const status = document.createElement('div'); status.className = 'dvlc-status'; status.textContent = '正在聆听'
      const words = document.createElement('div'); words.className = 'dvlc-words'
      const assistant = document.createElement('div'); assistant.className = 'dvlc-assistant'
      const replyText = document.createElement('span')
      const caret = document.createElement('span'); caret.className = 'dvlc-caret'
      assistant.appendChild(replyText); assistant.appendChild(caret)
      const user = document.createElement('div'); user.className = 'dvlc-user'
      const userTag = document.createElement('b'); userTag.textContent = '你'
      const userText = document.createElement('span')
      user.appendChild(userTag); user.appendChild(userText)
      const error = document.createElement('div'); error.className = 'dvlc-error'; error.style.display = 'none'
      words.appendChild(assistant); words.appendChild(user); words.appendChild(error)

      stage.appendChild(orb); stage.appendChild(status); stage.appendChild(words)

      const foot = document.createElement('div'); foot.className = 'dvlc-foot dvlc-rise'
      const note = document.createElement('div'); note.className = 'dvlc-note'; note.hidden = true
      const hint = document.createElement('div'); hint.className = 'dvlc-hint'
      hint.textContent = '直接说话，停顿约 0.9 秒自动发送 · 朗读时开口可打断 · Esc 最小化'
      const controls = document.createElement('div'); controls.className = 'dvlc-controls'

      function ctrl(kind, label, act, danger) {
        const b = document.createElement('button')
        b.className = 'dvlc-ctrl' + (danger ? ' danger' : '')
        b.setAttribute('aria-label', label)
        const round = document.createElement('span'); round.className = 'dvlc-round'
        round.innerHTML = svgIcon(kind)
        const text = document.createElement('span'); text.textContent = label
        b.appendChild(round); b.appendChild(text)
        b.addEventListener('click', act)
        return b
      }
      const muteBtn = ctrl('mic', '静音', () => setMuted(!state.muted))
      const endBtn = ctrl('hangup', '挂断', () => disable(), true)
      const interruptBtn = ctrl('pause', '打断', () => {
        stopAudio(); post('/cancel'); emit({ phase: 'listening', replyText: '' })
        if (state.enabled) { startCapture('listening'); post('/asr/start') }
      })
      controls.appendChild(muteBtn); controls.appendChild(endBtn); controls.appendChild(interruptBtn)
      foot.appendChild(note); foot.appendChild(hint); foot.appendChild(controls)

      root.appendChild(head); root.appendChild(stage); root.appendChild(foot)
      document.body.appendChild(root)

      return {
        root, timer, sub, status, replyText, userText, error, bars, caret, user, note,
        modelWrap, modelBtn, modelMenu,
        themeWrap, themeBtn, themeMenu, themeSwatch, themeName,
        muteBtn, interruptBtn,
        clock: () => {
          if (!startedAt) return '00:00'
          const s = Math.floor((Date.now() - startedAt) / 1000)
          return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
        },
      }
    }

    // ------------------------------------------------------------ 模型下拉（自绘，不用原生 select）
    let ttsModelsLoading = false
    let modelCatalog = { tts: [], asr: [], activeTts: '', streaming: '', final: '' }

    function fmtBytes(n) {
      const v = Number(n || 0)
      if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + 'GB'
      if (v >= 1024 * 1024) return Math.round(v / (1024 * 1024)) + 'MB'
      if (v >= 1024) return Math.round(v / 1024) + 'KB'
      return String(v) + 'B'
    }

    function modelTagText(model, active) {
      if (active) return '使用中'
      const dl = model.download
      if (model.ok === false) {
        if (dl && dl.missing > 0) return '可下载 ' + fmtBytes(dl.bytes)
        return '不可用'
      }
      return ''
    }

    function renderModelMenu() {
      if (!overlayRefs || !overlayRefs.modelMenu) return
      const menu = overlayRefs.modelMenu
      menu.innerHTML = ''
      const groups = [
        {
          title: 'TTS 语音',
          items: modelCatalog.tts.map((m) => ({ value: 'tts:' + m.id, label: m.name || m.id, model: m, active: m.id === modelCatalog.activeTts })),
        },
        {
          title: 'ASR · 流式识别',
          items: modelCatalog.asr.filter((m) => m.role === 'streaming')
            .map((m) => ({ value: 'asr:streaming:' + m.id, label: m.name || m.id, model: m, active: m.id === modelCatalog.streaming })),
        },
        {
          title: 'ASR · 整句定稿',
          items: modelCatalog.asr.filter((m) => m.role === 'final')
            .map((m) => ({ value: 'asr:final:' + m.id, label: m.name || m.id, model: m, active: m.id === modelCatalog.final })),
        },
      ]
      for (const group of groups) {
        if (!group.items.length) continue
        const title = document.createElement('div')
        title.className = 'dvlc-model-group'
        title.textContent = group.title
        menu.appendChild(title)
        for (const item of group.items) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'dvlc-model-item' + (item.active ? ' active' : '')
          const name = document.createElement('span')
          name.textContent = item.label
          btn.appendChild(name)
          const tagText = modelTagText(item.model, item.active)
          if (tagText) {
            const tag = document.createElement('span')
            tag.className = 'dvlc-model-tag' + (item.model.ok === false && item.model.download && item.model.download.missing > 0 ? ' dl' : '')
            tag.textContent = tagText
            btn.appendChild(tag)
          }
          const downloadable = item.model.ok === false && item.model.download && item.model.download.missing > 0
          if (item.active) {
            btn.setAttribute('disabled', 'disabled')
          } else if (item.model.ok !== false) {
            btn.addEventListener('click', () => { closeModelMenu(); void switchModel(item.value) })
          } else if (downloadable) {
            btn.addEventListener('click', () => { closeModelMenu(); void downloadModel(item) })
          } else {
            btn.setAttribute('disabled', 'disabled')
          }
          menu.appendChild(btn)
        }
      }
    }

    function closeModelMenu() {
      if (overlayRefs && overlayRefs.modelMenu) overlayRefs.modelMenu.style.display = 'none'
    }

    function toggleModelMenu() {
      if (!overlayRefs || !overlayRefs.modelMenu) return
      const menu = overlayRefs.modelMenu
      if (menu.style.display !== 'none') { closeModelMenu(); return }
      closeThemeMenu()
      menu.style.display = ''
      void loadTtsModels()
    }

    function onOverlayDocClick(ev) {
      if (!overlayRefs) return
      const target = ev && ev.target
      const inWrap = (wrap) => !!(wrap && target && wrap.contains && wrap.contains(target))
      if (overlayRefs.modelMenu && overlayRefs.modelMenu.style.display !== 'none' && !inWrap(overlayRefs.modelWrap)) closeModelMenu()
      if (overlayRefs.themeMenu && overlayRefs.themeMenu.style.display !== 'none' && !inWrap(overlayRefs.themeWrap)) closeThemeMenu()
    }

    // ------------------------------------------------------------ 背景主题下拉
    function renderThemeMenu() {
      if (!overlayRefs || !overlayRefs.themeMenu) return
      const menu = overlayRefs.themeMenu
      menu.innerHTML = ''
      const groups = [
        { title: '暗色背景', items: THEMES.filter((t) => t.tone === 'dark') },
        { title: '亮色背景', items: THEMES.filter((t) => t.tone === 'light') },
      ]
      for (const group of groups) {
        const title = document.createElement('div')
        title.className = 'dvlc-model-group'
        title.textContent = group.title
        menu.appendChild(title)
        for (const t of group.items) {
          const active = t.id === currentThemeId
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'dvlc-theme-item' + (active ? ' active' : '')
          btn.setAttribute('aria-label', '切换背景：' + t.name)
          const sw = document.createElement('span')
          sw.className = 'dvlc-theme-swatch'
          sw.style.background = t.swatch
          const label = document.createElement('span')
          label.textContent = t.name
          btn.appendChild(sw); btn.appendChild(label)
          if (active) {
            const check = document.createElement('span')
            check.className = 'dvlc-theme-check'
            check.textContent = '✓'
            btn.appendChild(check)
          } else {
            btn.addEventListener('click', () => { closeThemeMenu(); applyTheme(t.id) })
          }
          menu.appendChild(btn)
        }
      }
    }

    function closeThemeMenu() {
      if (overlayRefs && overlayRefs.themeMenu) overlayRefs.themeMenu.style.display = 'none'
    }

    function toggleThemeMenu() {
      if (!overlayRefs || !overlayRefs.themeMenu) return
      const menu = overlayRefs.themeMenu
      if (menu.style.display !== 'none') { closeThemeMenu(); return }
      closeModelMenu()
      renderThemeMenu()
      menu.style.display = ''
    }

    async function loadTtsModels() {
      if (!overlayRefs || !overlayRefs.modelBtn) return
      if (typeof fetch !== 'function') return
      ttsModelsLoading = true
      try {
        const r = await fetch(BASE + '/models')
        if (!r.ok) return
        const j = await r.json()
        modelCatalog = {
          tts: Array.isArray(j.tts) ? j.tts : [],
          asr: Array.isArray(j.asr) ? j.asr : [],
          activeTts: j.active || '',
          streaming: (j.asrActive && j.asrActive.streaming) || '',
          final: (j.asrActive && j.asrActive.final) || '',
        }
        if (!overlayRefs) return
        renderModelMenu()
        const active = modelCatalog.tts.find((m) => m.id === modelCatalog.activeTts) || modelCatalog.tts[0]
        if (active) {
          overlayRefs.modelBtn.textContent = active.name || active.id
          overlayRefs.modelBtn.style.display = ''
        } else {
          overlayRefs.modelBtn.style.display = 'none'
        }
      } catch { /* 接口不可用时不显示选择器 */ } finally {
        ttsModelsLoading = false
      }
    }

    function payloadOfValue(value) {
      if (value.startsWith('tts:')) return { kind: 'tts', id: value.slice(4) }
      if (value.startsWith('asr:streaming:')) return { kind: 'asr', role: 'streaming', id: value.slice('asr:streaming:'.length) }
      if (value.startsWith('asr:final:')) return { kind: 'asr', role: 'final', id: value.slice('asr:final:'.length) }
      return null
    }

    async function switchModel(value) {
      if (!overlayRefs || !value || ttsModelsLoading) return
      const payload = payloadOfValue(value)
      if (!payload) return
      if (overlayRefs.modelBtn) overlayRefs.modelBtn.disabled = true
      try {
        if (typeof fetch !== 'function') return
        const r = await fetch(BASE + '/models/use', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.ok) {
          emit({ error: '切换模型失败：' + (j.error || r.status) })
          return
        }
        emit({ error: '', modelNote: '' })
        if (j.engine) emit({ engine: j.engine })
        await loadTtsModels()
      } catch (e) {
        emit({ error: '切换模型失败：' + (e && e.message ? e.message : e) })
      } finally {
        if (overlayRefs && overlayRefs.modelBtn) overlayRefs.modelBtn.disabled = false
      }
    }

    async function downloadModel(item) {
      if (!item || !item.model) return
      const payload = payloadOfValue(item.value)
      if (!payload) return
      try {
        if (typeof fetch !== 'function') return
        emit({ modelNote: '准备下载 ' + (item.model.name || item.model.id) + ' …' })
        const r = await fetch(BASE + '/models/fetch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.ok) {
          emit({ error: '下载失败：' + (j.error || r.status), modelNote: '' })
          return
        }
        emit({ modelNote: `开始下载 ${item.model.name || item.model.id}（${fmtBytes(j.bytes || 0)}）…` })
      } catch (e) {
        emit({ error: '下载失败：' + (e && e.message ? e.message : e), modelNote: '' })
      }
    }

    function openOverlay() {
      if (typeof document === 'undefined') { emit({ overlay: false }); return }
      if (overlayRoot) { emit({ overlay: true }); return }
      overlayRefs = buildOverlay()
      if (!overlayRefs) return
      overlayRoot = overlayRefs.root
      emit({ overlay: true })
      void loadTtsModels()
      if (!REDUCED) startOverlayLoop()
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('keydown', onOverlayKey)
        document.addEventListener('click', onOverlayDocClick)
      }
    }

    function closeOverlay() {
      if (overlayRefs && overlayRefs.root && overlayRefs.root.remove) {
        try { overlayRefs.root.remove() } catch { /* ignore */ }
      }
      overlayRoot = null
      overlayRefs = null
      stopOverlayLoop()
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', onOverlayKey)
        document.removeEventListener('click', onOverlayDocClick)
      }
      if (state.overlay) emit({ overlay: false })
    }

    function onOverlayKey(e) { if (e && e.key === 'Escape') closeOverlay() }

    let overlayRaf = 0
    function startOverlayLoop() {
      const tick = () => {
        if (!overlayRefs) return
        updateOverlay()
        overlayRaf = requestAnimationFrame(tick)
      }
      overlayRaf = requestAnimationFrame(tick)
    }
    function stopOverlayLoop() {
      if (overlayRaf) { try { cancelAnimationFrame(overlayRaf) } catch { /* ignore */ } overlayRaf = 0 }
    }

    function updateOverlay() {
      if (!overlayRefs) return
      try { overlayRefs.timer.textContent = overlayRefs.clock() } catch { /* ignore */ }
      const phase = state.phase
      const label = state.muted ? '已静音' : phase === 'listening' ? '正在聆听' : phase === 'thinking' ? '正在思考' : phase === 'speaking' ? '正在回答' : '准备中'
      if (overlayRefs.status) overlayRefs.status.textContent = label
      if (overlayRefs.replyText) overlayRefs.replyText.textContent = state.replyText || ''
      if (overlayRefs.userText) overlayRefs.userText.textContent = state.userText || ''
      // 空白时不显示光标 /「你」占位，避免无意义的闪烁横线
      if (overlayRefs.caret) overlayRefs.caret.style.display = state.replyText ? 'inline-block' : 'none'
      if (overlayRefs.user) overlayRefs.user.hidden = !state.userText
      if (overlayRefs.error) {
        overlayRefs.error.textContent = state.error || ''
        overlayRefs.error.style.display = state.error ? 'block' : 'none'
      }
      if (overlayRefs.note) {
        overlayRefs.note.textContent = state.modelNote || ''
        overlayRefs.note.hidden = !state.modelNote
      }
      if (overlayRefs.muteBtn) {
        overlayRefs.muteBtn.setAttribute('data-muted', state.muted ? 'true' : 'false')
        const round = overlayRefs.muteBtn.children && overlayRefs.muteBtn.children[0]
        if (round) round.innerHTML = svgIcon(state.muted ? 'mute' : 'mic')
        const text = overlayRefs.muteBtn.children && overlayRefs.muteBtn.children[1]
        if (text) text.textContent = state.muted ? '取消静音' : '静音'
      }
      if (overlayRefs.interruptBtn) {
        overlayRefs.interruptBtn.disabled = phase !== 'speaking'
      }
      if (overlayRefs.bars) {
        const t = Date.now() / 1000
        const level = phase === 'listening' ? Math.max(state.level || pendingLevel, 0.03) : phase === 'speaking' ? 0.32 : 0.06
        for (let i = 0; i < overlayRefs.bars.length; i += 1) {
          const envelope = Math.sin((Math.PI * (i + 1)) / (overlayRefs.bars.length + 1))
          const wobble = 0.55 + 0.45 * Math.sin(t * 2.1 + i * 0.55)
          const h = 3 + envelope * level * 50 * wobble
          overlayRefs.bars[i].style.height = Math.max(3, h).toFixed(1) + 'px'
        }
      }
    }

    // ------------------------------------------------------------ 输入框语音条 UI
    // 颜色全部取自 DSH 主题变量，跟随明暗主题；与通话界面的暗色苔绿体系解耦。
    const T = {
      label: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #59636e)',
      tertiary: 'var(--dsw-alias-label-tertiary, #818b98)',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.15))',
      border2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.22))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }

    function MicIcon(props) {
      return h('svg', {
        viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('rect', { x: 7.2, y: 2.6, width: 5.6, height: 9.2, rx: 2.8 }),
        h('path', { d: 'M4.6 9.4a5.4 5.4 0 0 0 10.8 0' }),
        h('line', { x1: 10, y1: 14.8, x2: 10, y2: 17.2 }),
      )
    }
    function StopIcon() {
      return h('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': true },
        h('rect', { x: 6, y: 6, width: 8, height: 8, rx: 1.5, fill: 'currentColor' }))
    }
    function SpeakerIcon() {
      return h('svg', { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 8.2h2.6L10.6 5v10l-4-3.2H4z' }),
        h('path', { d: 'M13.2 7.4a4 4 0 0 1 0 5.2' }),
        h('path', { d: 'M15.2 5.4a6.8 6.8 0 0 1 0 9.2' }))
    }
    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
        h('line', { x1: 4, y1: 4, x2: 12, y2: 12 }),
        h('line', { x1: 12, y1: 4, x2: 4, y2: 12 }))
    }
    function LevelBars({ level }) {
      const bars = []
      for (let i = 0; i < 5; i++) {
        const base = 3 + (i === 0 || i === 4 ? 1 : i === 2 ? 3 : 2)
        const height = Math.round(base + level * 9 * (0.6 + (i === 2 ? 0.8 : 0.3)))
        bars.push(h('span', {
          key: i,
          style: {
            display: 'inline-block', width: '2px', height: height + 'px', borderRadius: '1px',
            background: 'currentColor', opacity: 0.55 + i * 0.08, transition: 'height 90ms linear',
          },
        }))
      }
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', height: '14px', color: T.label } }, bars)
    }

    function VoiceActivity(props) {
      const [snap, setSnap] = React.useState(snapshot())
      const onActiveChange = props && props.onActiveChange
      const actions = props && props.inputActions
      React.useEffect(() => {
        attach(actions)
        const off = subscribe(setSnap)
        return () => { detach(actions); off() }
      }, [actions])
      const active = snap.phase === 'listening'
      const busy = snap.phase === 'thinking' || snap.phase === 'speaking'
      React.useEffect(() => {
        if (!onActiveChange) return
        try { onActiveChange(snap.enabled) } catch { /* ignore */ }
        return () => { try { onActiveChange(false) } catch { /* ignore */ } }
      }, [snap.enabled, onActiveChange])

      const locked = !!(props && props.locked)
      const title = locked ? '输入框暂不可用'
        : !snap.enabled ? '开始语音对话'
          : snap.overlay ? '收起通话界面' : '打开通话界面'
      if (!snap.enabled) {
        return h('button', {
          type: 'button', title, 'aria-label': title, disabled: locked,
          onClick: () => { if (!locked) primaryAction() },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '30px', height: '30px', padding: 0, borderRadius: '50%',
            border: '1px solid ' + T.border, background: 'transparent',
            color: T.secondary, cursor: locked ? 'default' : 'pointer',
          },
        }, h(MicIcon))
      }
      const caption = snap.error || snap.userText || (active ? '正在听…' : busy ? '正在回答…' : '语音已开启')
      return h('div', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '8px', height: '32px',
          padding: '0 6px 0 4px', borderRadius: '16px', border: '1px solid ' + T.border,
          background: 'transparent', color: T.label, minWidth: 0, maxWidth: '420px',
        },
      },
        h('button', {
          type: 'button', title, 'aria-label': title, disabled: locked,
          onClick: () => { if (!locked) primaryAction() },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '24px', height: '24px', padding: 0, borderRadius: '50%',
            border: 'none', background: 'transparent', color: snap.muted ? T.error : T.label,
            cursor: locked ? 'default' : 'pointer', flex: 'none',
          },
        }, active ? h(StopIcon) : snap.phase === 'speaking' ? h(SpeakerIcon) : h(MicIcon)),
        h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: snap.muted ? T.error : T.label, flex: 'none', opacity: active ? 0.9 : 0.45 } }),
        h(LevelBars, { level: active ? snap.level : busy ? 0.25 : 0 }),
        h('span', {
          title: caption,
          style: {
            fontSize: '12px', lineHeight: '16px', color: snap.error ? T.error : T.secondary,
            flex: '1 1 auto', minWidth: 0, maxWidth: '200px', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, caption),
        h('button', {
          type: 'button', title: '关闭语音对话', 'aria-label': '关闭语音对话',
          onClick: () => disable(),
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '18px', height: '18px', padding: 0, border: 'none',
            background: 'transparent', color: T.tertiary, cursor: 'pointer', flex: 'none',
          },
        }, h(CloseIcon)),
      )
    }

    // ------------------------------------------------------------ 插件入口
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
        name: 'conversation.input.activity',
        id: 'dsh-plugin-voice-local',
      }, VoiceActivity))
    }

    exports.name = 'dsh-plugin-voice-local'
    exports.inject = inject
    exports.apply = apply
    exports.__internals = {
      rmsOf, advanceSilence, silenceTrips, isSpeechFrame,
      openOverlay, closeOverlay,
      applyTheme,
      getState: () => snapshot(),
      emit: (patch) => emit(patch),
      overlayRoot: () => overlayRoot,
    }
    return module.exports
  },
})
