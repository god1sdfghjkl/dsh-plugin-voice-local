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
    // 声纹锁：状态来自 /voiceprint/status；enrollState 非空时正在录注册音频
    let vpStatus = { enabled: false, enrolled: false, modelReady: false, threshold: 0.7, dim: 0, profiles: [], settings: {} }
    let vpRec = null
    let vpView = 'home'
    let vpEnroll = null
    let vpWaveTimer = null

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
      // 声纹录入/测试：只收集音频，不送 ASR，也不触发 VAD 自动提交
      if (vpRec) {
        vpRec.chunks.push(new Float32Array(data))
        vpRec.samples += data.length
        if (vpRec.samples >= vpRec.target) finishVpRec()
        return
      }
      const frameMs = (data.length / 16000) * 1000
      // 面板打开时既不送 ASR 也不缓存，避免长按设置面板时 PCM 越积越多
      if (vpOpen()) { int16Buf.length = 0; int16Len = 0; return }
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
      if (vpRec || vpOpen()) return
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

    // ------------------------------------------------------------ 声纹锁
    async function loadVoiceprintStatus() {
      if (typeof fetch !== 'function') return
      try {
        const r = await fetch(BASE + '/voiceprint/status')
        if (!r.ok) return
        const d = await r.json()
        if (d && d.ok) {
          vpStatus = { ...vpStatus, ...d }
          syncVpChip()
          if (vpOpen()) renderVpPanel()
          if (overlayRefs) renderModelMenu()
        }
      } catch { /* 老版本宿主没有该接口 */ }
    }

    function syncVpChip() {
      const btn = overlayRefs && overlayRefs.vpBtn
      if (!btn) return
      if (btn.classList) btn.classList.toggle('on', !!vpStatus.enabled)
      btn.title = vpStatus.enabled
        ? `声纹识别已开启${vpStatus.profiles && vpStatus.profiles.length ? ' · ' + vpStatus.profiles.length + ' 组档案' : ''}`
        : '声纹识别设置'
    }

// ------------------------------------------------------------ 声纹设置面板
    const VP_PROMPTS = [
      '今天天气不错，我们出去走走吧。',
      '请帮我记住这句话：山高水长，后会有期。',
      '我在测试自己的声音，一二三四五六七。',
      '窗外的树叶被风吹得沙沙响。',
      '晚上想吃一碗热汤面，再加一个鸡蛋。',
      '请把客厅的灯关掉，谢谢。',
      '明天早上七点叫我起床。',
      '这个故事告诉我们，做事要有耐心。',
      '我喜欢安静的地方，也喜欢热闹的街道。',
      '记得带伞，下午可能会下雨。',
      '我们一起数数：一只、两只、三只小猫。',
      '把这句话读清楚，声音不用太大。',
    ]
    let vpTest = {}
    let vpTestingId = ''

    function vpEl(tag, cls, text) {
      const el = document.createElement(tag)
      if (cls) el.className = cls
      if (text != null) el.textContent = text
      return el
    }

    function vpSwitch(on, onChange) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'dvlc-switch' + (on ? ' on' : '')
      b.setAttribute('role', 'switch')
      b.setAttribute('aria-checked', on ? 'true' : 'false')
      const knob = document.createElement('span')
      knob.className = 'dvlc-switch-knob'
      b.appendChild(knob)
      b.addEventListener('click', () => { if (!b.disabled) onChange(!on) })
      return b
    }

    function vpFmtTime(ts) {
      try {
        const d = new Date(Number(ts) || Date.now())
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch { return '—' }
    }

    function vpSec(title, extra) {
      const s = vpEl('section', 'dvlc-vp-sec')
      const head = vpEl('div', 'dvlc-vp-sec-h')
      head.appendChild(vpEl('span', 'dvlc-vp-sec-t', title))
      if (extra) head.appendChild(extra)
      s.appendChild(head)
      return s
    }

    function vpOpen() {
      return !!(overlayRefs && overlayRefs.vpPanel && !overlayRefs.vpPanel.hidden)
    }

    function openVpPanel() {
      if (!overlayRefs || !overlayRefs.vpPanel) return
      overlayRefs.vpPanel.hidden = false
      vpView = 'home'; renderVpPanel()
      int16Buf.length = 0; int16Len = 0
      void loadVoiceprintStatus()
    }

    function closeVpPanel() {
      if (!overlayRefs || !overlayRefs.vpPanel) return
      vpRec = null
      vpEnroll = null
      vpView = 'home'
      vpTestingId = ''
      stopVpWave()
      overlayRefs.vpPanel.hidden = true
      if (state.enabled) {
        mode = 'listening'
        if (capture) { resetVad(); post('/asr/start') } else { startCapture('listening'); post('/asr/start') }
        emit({ phase: 'listening' })
      }
    }

    function stopVpWave() {
      if (vpWaveTimer) { clearInterval(vpWaveTimer); vpWaveTimer = null }
    }

    function startVpWave(bars) {
      stopVpWave()
      vpWaveTimer = setInterval(() => {
        if (!bars.length) { stopVpWave(); return }
        for (let i = 0; i < bars.length; i++) {
          const base = Math.max(0.08, Math.min(1, (pendingLevel || 0) * 6))
          const h = 4 + Math.round(base * 26 * (0.45 + Math.abs(Math.sin(Date.now() / 140 + i))))
          bars[i].style.height = h + 'px'
        }
      }, 90)
    }

    function pickVpPrompts() {
      const list = VP_PROMPTS.slice()
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = list[i]; list[i] = list[j]; list[j] = t
      }
      return list.slice(0, 3)
    }

    function beginVpRec(target, cb) {
      if (!state.enabled) { emit({ error: '请先开启语音通话再录入声纹' }); return false }
      if (state.muted) { emit({ error: '当前已静音，请先取消静音' }); return false }
      vpRec = { chunks: [], samples: 0, target, cb }
      mode = 'vp'
      resetVad()
      if (!capture) void startCapture('vp')
      return true
    }

    function pcm16OfChunks(chunks, limit) {
      const total = Math.min(limit || Infinity, chunks.reduce((n, c) => n + c.length, 0))
      const pcm = new Int16Array(total)
      let off = 0
      for (const c of chunks) {
        for (let i = 0; i < c.length && off < total; i++) {
          const v = Math.max(-1, Math.min(1, c[i]))
          pcm[off++] = v * 32767 | 0
        }
        if (off >= total) break
      }
      return pcm
    }

    function vpNoiseVerdict(chunks, samples) {
      if (!samples) return { ok: false, reason: '没有听到声音，请靠近麦克风再试' }
      const frame = 1024
      const rmsList = []
      let cur = 0
      let n = 0
      for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
          cur += c[i] * c[i]
          n++
          if (n >= frame) {
            rmsList.push(Math.sqrt(cur / n))
            cur = 0; n = 0
          }
        }
      }
      if (n) rmsList.push(Math.sqrt(cur / n))
      if (!rmsList.length) return { ok: false, reason: '没有听到声音' }
      const sorted = rmsList.slice().sort((a, b) => a - b)
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      const noise = Math.max(0.0005, q(0.2))
      const speech = q(0.9)
      if (speech < 0.006) return { ok: false, reason: '声音太小，请靠近麦克风（10–20cm）' }
      if (speech / noise < 2.2) return { ok: false, reason: '环境嘈杂，请换个安静的地方再试' }
      return { ok: true, noise, speech }
    }

    function finishVpRec() {
      const rec = vpRec
      if (!rec) return
      vpRec = null
      if (mode === 'vp') mode = 'idle'
      const pcm = pcm16OfChunks(rec.chunks, rec.samples)
      try { rec.cb(pcm, rec) } catch (e) { emit({ error: '声纹处理失败：' + (e && e.message ? e.message : e) }) }
    }

    function beginVpEnroll(profile) {
      if (!vpStatus.modelReady) { emit({ error: '声纹模型还没下载，请先点「下载声纹模型」' }); renderVpPanel(); return }
      if (!profile && (vpStatus.profiles || []).length >= (vpStatus.maxProfiles || 5)) {
        emit({ error: '最多 5 组声纹，请先删除一组' }); renderVpPanel(); return
      }
      vpEnroll = {
        profileId: profile ? profile.id : '',
        nickname: profile ? profile.nickname : ((vpStatus.profiles || []).length ? '家人' : '主人'),
        clips: [],
        prompts: pickVpPrompts(),
        idx: 0,
        recording: false,
        error: '',
      }
      vpView = 'enroll'
      renderVpPanel()
    }

    function startVpClip() {
      if (!vpEnroll) return
      if (!beginVpRec(16000 * 3.2, (pcm, rec) => handleVpClip(pcm, rec))) return
      vpEnroll.recording = true
      vpEnroll.error = ''
      renderVpPanel()
    }

    function handleVpClip(pcm, rec) {
      if (!vpEnroll) return
      vpEnroll.recording = false
      const verdict = vpNoiseVerdict(rec ? rec.chunks : [], pcm.length)
      if (!verdict.ok) {
        vpEnroll.error = verdict.reason
        renderVpPanel()
        return
      }
      vpEnroll.clips.push(BufferLike.base64(pcm))
      vpEnroll.idx++
      if (vpEnroll.idx >= vpEnroll.prompts.length) vpView = 'nickname'
      renderVpPanel()
    }

    // 浏览器没有 Buffer：用 btoa 分块编码 PCM16
    const BufferLike = {
      base64(pcm) {
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        let s = ''
        const CH = 0x8000
        for (let i = 0; i < bytes.length; i += CH) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)))
        }
        return btoa(s)
      },
    }

    function saveVpEnroll() {
      if (!vpEnroll) return
      const input = overlayRefs && overlayRefs.vpPanel ? overlayRefs.vpPanel.querySelector('.dvlc-vp-input') : null
      const nickname = (input && String(input.value || '').trim()) || vpEnroll.nickname || '主人'
      emit({ error: '', modelNote: '正在生成声纹…' })
      const url = vpEnroll.profileId ? BASE + '/voiceprint/profiles/reenroll' : BASE + '/voiceprint/profiles'
      const payload = { nickname, clips: vpEnroll.clips, tone: 'normal' }
      if (vpEnroll.profileId) payload.id = vpEnroll.profileId
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok || !d.ok) {
          vpEnroll.error = '保存失败：' + (d.error || r.status)
          renderVpPanel()
          return
        }
        vpStatus = { ...vpStatus, ...d }
        vpEnroll = null
        vpView = 'home'
        mode = 'listening'
        if (state.enabled) post('/asr/start')
        emit({ error: '', modelNote: '声纹保存成功 ✓' })
        renderVpPanel()
        if (overlayRefs) renderModelMenu()
      }).catch((e) => {
        if (vpEnroll) vpEnroll.error = '保存失败：' + (e && e.message ? e.message : e)
        renderVpPanel()
      })
    }

    async function setVpEnabled(enabled) {
      try {
        const r = await fetch(BASE + '/voiceprint/enable', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !!enabled }),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d.ok) vpStatus = { ...vpStatus, ...d }
        syncVpChip()
        renderVpPanel()
        if (overlayRefs) renderModelMenu()
      } catch { /* ignore */ }
    }

    async function patchVpSettings(patch) {
      try {
        const r = await fetch(BASE + '/voiceprint/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d.ok) vpStatus = { ...vpStatus, ...d }
        syncVpChip()
        renderVpPanel()
      } catch { /* ignore */ }
    }

    async function updateVpProfile(id, patch) {
      try {
        const r = await fetch(BASE + '/voiceprint/profiles/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, ...patch }),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d.ok) vpStatus = { ...vpStatus, ...d }
        renderVpPanel()
      } catch { /* ignore */ }
    }

    async function deleteVpProfile(id) {
      try {
        const r = await fetch(BASE + '/voiceprint/profiles/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d.ok) vpStatus = { ...vpStatus, ...d }
        renderVpPanel()
        if (overlayRefs) renderModelMenu()
      } catch { /* ignore */ }
    }

    function testVpProfile(id) {
      vpTestingId = id
      renderVpPanel()
      const started = beginVpRec(16000 * 2.2, (pcm) => {
        vpTestingId = ''
        fetch(BASE + '/voiceprint/test?id=' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: pcm.buffer,
        }).then(async (r) => {
          const d = await r.json().catch(() => ({}))
          vpTest[id] = { ok: !!d.ok, score: Number(d.score || 0), error: d.error || '' }
          renderVpPanel()
        }).catch(() => { vpTest[id] = { ok: false, score: 0, error: '测试失败' }; renderVpPanel() })
      })
      if (!started) { vpTestingId = ''; renderVpPanel() }
    }

    function renderVpPanel() {
      if (!overlayRefs || !overlayRefs.vpBody) return
      const body = overlayRefs.vpBody
      body.innerHTML = ''
      stopVpWave()
      if (!vpStatus.modelReady) {
        const banner = vpEl('div', 'dvlc-vp-banner')
        banner.appendChild(vpEl('div', 'dvlc-vp-banner-t', '声纹模型未安装（约 27MB，首次使用需下载）'))
        const btn = vpEl('button', 'dvlc-vp-btn primary', '下载声纹模型')
        btn.addEventListener('click', () => {
          btn.disabled = true
          btn.textContent = '正在下载…'
          fetch(BASE + '/voiceprint/fetch', { method: 'POST' }).catch(() => {}).finally(() => {
            setTimeout(() => { void loadVoiceprintStatus(); renderVpPanel() }, 500)
          })
        })
        banner.appendChild(btn)
        body.appendChild(banner)
      }
      if (vpView === 'enroll') return renderVpEnroll(body)
      if (vpView === 'nickname') return renderVpNickname(body)
      renderVpHome(body)
    }

    function renderVpHome(body) {
      const profiles = vpStatus.profiles || []
      const settings = vpStatus.settings || {}

      const master = vpSec('声纹识别总开关')
      const masterRow = vpEl('div', 'dvlc-vp-row')
      const masterText = vpEl('div', 'dvlc-vp-col')
      masterText.appendChild(vpEl('div', 'dvlc-vp-label', '开启后设备识别已录入声纹，区分主人 / 其他人'))
      masterText.appendChild(vpEl('div', 'dvlc-vp-hint', '感冒、嘈杂环境识别容易失效；关闭后不区分说话人，所有人语音都正常应答。'))
      masterRow.appendChild(masterText)
      masterRow.appendChild(vpSwitch(!!vpStatus.enabled, (v) => { void setVpEnabled(v) }))
      master.appendChild(masterRow)
      body.appendChild(master)

      const sec = vpSec('声纹档案管理', (() => {
        const add = vpEl('button', 'dvlc-vp-add', '＋ 添加声纹')
        add.disabled = profiles.length >= (vpStatus.maxProfiles || 5) || !vpStatus.modelReady
        add.addEventListener('click', () => beginVpEnroll(null))
        return add
      })())
      if (!profiles.length) {
        sec.appendChild(vpEl('div', 'dvlc-vp-empty', '还没有声纹。点「＋ 添加声纹」，按提示读 3 句话即可。'))
      }
      for (const p of profiles) {
        const card = vpEl('div', 'dvlc-vp-card-item')
        const info = vpEl('div', 'dvlc-vp-col')
        const nameRow = vpEl('div', 'dvlc-vp-name-row')
        nameRow.appendChild(vpEl('span', 'dvlc-vp-name', p.nickname))
        nameRow.appendChild(vpEl('span', 'dvlc-vp-status', vpStatus.enabled ? '已启用' : '已录入'))
        info.appendChild(nameRow)
        info.appendChild(vpEl('div', 'dvlc-vp-meta', '录入时间 ' + vpFmtTime(p.createdAt)))
        if (vpTest[p.id]) {
          const t = vpTest[p.id]
          info.appendChild(vpEl('div', 'dvlc-vp-meta', `测试：${t.ok ? '匹配' : '不匹配'} · 相似度 ${(t.score * 100).toFixed(1)}%`))
        }
        if (vpTestingId === p.id) info.appendChild(vpEl('div', 'dvlc-vp-meta', '测试中，请说一句话…'))
        const btns = vpEl('div', 'dvlc-vp-btns')
        const mk = (label, cls, fn, disabled) => {
          const b = vpEl('button', 'dvlc-vp-btn' + (cls ? ' ' + cls : ''), label)
          b.disabled = !!disabled
          b.addEventListener('click', fn)
          return b
        }
        btns.appendChild(mk('测试', '', () => testVpProfile(p.id), vpTestingId !== ''))
        btns.appendChild(mk('重录', '', () => beginVpEnroll(p), vpTestingId !== ''))
        btns.appendChild(mk('删除', 'danger', () => { void deleteVpProfile(p.id) }, vpTestingId !== ''))
        card.appendChild(info)
        card.appendChild(btns)
        sec.appendChild(card)
      }
      body.appendChild(sec)

      const policy = vpSec('识别策略')
      const onlyRow = vpEl('div', 'dvlc-vp-row')
      const onlyText = vpEl('div', 'dvlc-vp-col')
      onlyText.appendChild(vpEl('div', 'dvlc-vp-label', '仅应答已录入人员'))
      onlyText.appendChild(vpEl('div', 'dvlc-vp-hint', '开：陌生声音不回应、不触发提交；关：所有人都能对话，识别到身份后走个性化。'))
      onlyRow.appendChild(onlyText)
      onlyRow.appendChild(vpSwitch(settings.requireEnrolled !== false, (v) => { void patchVpSettings({ requireEnrolled: v }) }))
      policy.appendChild(onlyRow)

      const rangeRow = vpEl('div', 'dvlc-vp-col')
      const rangeHead = vpEl('div', 'dvlc-vp-range-head')
      rangeHead.appendChild(vpEl('span', 'dvlc-vp-label', '识别置信阈值'))
      rangeHead.appendChild(vpEl('span', 'dvlc-vp-range-val', String(vpStatus.thresholdSlider != null ? vpStatus.thresholdSlider : 40)))
      rangeRow.appendChild(rangeHead)
      const range = document.createElement('input')
      range.type = 'range'
      range.min = '0'; range.max = '100'; range.step = '1'
      range.className = 'dvlc-vp-range'
      range.value = String(vpStatus.thresholdSlider != null ? vpStatus.thresholdSlider : 40)
      range.addEventListener('change', () => {
        rangeHead.lastChild.textContent = String(range.value)
        void patchVpSettings({ thresholdSlider: Number(range.value) })
      })
      rangeRow.appendChild(range)
      rangeRow.appendChild(vpEl('div', 'dvlc-vp-hint', '低：更容易识别，误识别概率上升；高：严格匹配，感冒/沙哑容易失败。默认 40。'))
      policy.appendChild(rangeRow)

      const dnRow = vpEl('div', 'dvlc-vp-row')
      const dnText = vpEl('div', 'dvlc-vp-col')
      dnText.appendChild(vpEl('div', 'dvlc-vp-label', '声纹降噪增强'))
      dnText.appendChild(vpEl('div', 'dvlc-vp-hint', '优先提取已登记人声、压制背景杂音（当前用于采集端降噪，实验性）。'))
      dnRow.appendChild(dnText)
      dnRow.appendChild(vpSwitch(!!settings.denoise, (v) => { void patchVpSettings({ denoise: v }) }))
      policy.appendChild(dnRow)

      const wakeRow = vpEl('div', 'dvlc-vp-col')
      wakeRow.appendChild(vpEl('div', 'dvlc-vp-label', '唤醒联动模式'))
      const wakeOpts = vpEl('div', 'dvlc-vp-opts')
      const wakeA = vpEl('button', 'dvlc-vp-opt' + (settings.wakeMode !== 'direct' ? ' on' : ''), 'A · 先唤醒，再做声纹校验')
      const wakeB = vpEl('button', 'dvlc-vp-opt' + (settings.wakeMode === 'direct' ? ' on' : ''), 'B · 开口直接声纹识别')
      wakeA.addEventListener('click', () => { void patchVpSettings({ wakeMode: 'wake-then-verify' }) })
      wakeB.addEventListener('click', () => { void patchVpSettings({ wakeMode: 'direct' }) })
      wakeOpts.appendChild(wakeA); wakeOpts.appendChild(wakeB)
      wakeRow.appendChild(wakeOpts)
      policy.appendChild(wakeRow)
      body.appendChild(policy)

      if (profiles.length) {
        const link = vpSec('身份联动规则')
        for (const p of profiles) {
          const row = vpEl('div', 'dvlc-vp-link')
          row.appendChild(vpEl('span', 'dvlc-vp-name', p.nickname))
          const sel = document.createElement('select')
          sel.className = 'dvlc-vp-select'
          for (const [v, t] of [['normal', '正常'], ['gentle', '舒缓'], ['lively', '活泼']]) {
            const o = document.createElement('option')
            o.value = v; o.textContent = '语气 · ' + t
            if ((p.tone || 'normal') === v) o.selected = true
            sel.appendChild(o)
          }
          sel.addEventListener('change', () => { void updateVpProfile(p.id, { tone: sel.value }) })
          row.appendChild(sel)
          const chk = document.createElement('label')
          chk.className = 'dvlc-vp-check'
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.checked = !!(p.permissions && p.permissions.highRisk)
          box.addEventListener('change', () => { void updateVpProfile(p.id, { permissions: { highRisk: box.checked } }) })
          chk.appendChild(box)
          chk.appendChild(document.createTextNode('允许高权限指令'))
          row.appendChild(chk)
          link.appendChild(row)
        }
        body.appendChild(link)
      }

      const hint = vpEl('div', 'dvlc-vp-foot-note', '声纹只保存在本机，不会上传；识别失败时可重录或降低阈值。')
      body.appendChild(hint)
    }

    function renderVpEnroll(body) {
      const e = vpEnroll
      if (!e) return renderVpHome(body)
      const sec = vpSec('录入声纹 · ' + (e.profileId ? '重录' : '新增'))
      const intro = vpEl('div', 'dvlc-vp-intro')
      intro.appendChild(vpEl('div', 'dvlc-vp-label', '保持安静，距离麦克风 10–20cm'))
      intro.appendChild(vpEl('div', 'dvlc-vp-hint', '按顺序朗读 3 句随机提示（每次不同，防预录音频回放）；环境太吵会提示重来。'))
      sec.appendChild(intro)

      const progress = vpEl('div', 'dvlc-vp-progress', `第 ${Math.min(e.idx + 1, e.prompts.length)} / ${e.prompts.length} 句`)
      sec.appendChild(progress)
      const prompt = vpEl('div', 'dvlc-vp-prompt', e.prompts[e.idx] || '')
      sec.appendChild(prompt)

      if (e.recording) {
        const wave = vpEl('div', 'dvlc-vp-wave')
        const bars = []
        for (let i = 0; i < 18; i++) { const b = document.createElement('i'); b.style.height = '4px'; wave.appendChild(b); bars.push(b) }
        sec.appendChild(wave)
        sec.appendChild(vpEl('div', 'dvlc-vp-hint', '正在录音（约 3 秒），请自然朗读…'))
        startVpWave(bars)
      } else {
        const btns = vpEl('div', 'dvlc-vp-btns')
        const start = vpEl('button', 'dvlc-vp-btn primary', e.clips.length ? '重读这句' : '开始朗读')
        start.addEventListener('click', () => startVpClip())
        start.disabled = !state.enabled
        btns.appendChild(start)
        if (e.clips.length) {
          const back = vpEl('button', 'dvlc-vp-btn', '上一句')
          back.addEventListener('click', () => { e.clips.pop(); e.idx = Math.max(0, e.idx - 1); renderVpPanel() })
          btns.appendChild(back)
        }
        sec.appendChild(btns)
        if (!state.enabled) sec.appendChild(vpEl('div', 'dvlc-vp-error', '请先开启语音通话（左下角麦克风未静音）'))
      }

      if (e.error) sec.appendChild(vpEl('div', 'dvlc-vp-error', e.error))
      const cancel = vpEl('button', 'dvlc-vp-btn', '取消录入')
      cancel.addEventListener('click', () => { vpEnroll = null; vpView = 'home'; renderVpPanel() })
      sec.appendChild(cancel)
      body.appendChild(sec)
    }

    function renderVpNickname(body) {
      const e = vpEnroll
      if (!e) return renderVpHome(body)
      const sec = vpSec('录入完成')
      sec.appendChild(vpEl('div', 'dvlc-vp-label', '给这个声纹起个昵称（主人 / 爸爸 / 奶奶…）'))
      const input = document.createElement('input')
      input.className = 'dvlc-vp-input'
      input.placeholder = '例如：主人'
      input.value = e.nickname || ''
      sec.appendChild(input)
      const btns = vpEl('div', 'dvlc-vp-btns')
      const save = vpEl('button', 'dvlc-vp-btn primary', e.profileId ? '保存重录' : '保存声纹')
      save.addEventListener('click', () => saveVpEnroll())
      btns.appendChild(save)
      const again = vpEl('button', 'dvlc-vp-btn', '重新录 3 句')
      again.addEventListener('click', () => { e.clips = []; e.idx = 0; e.prompts = pickVpPrompts(); vpView = 'enroll'; renderVpPanel() })
      btns.appendChild(again)
      sec.appendChild(btns)
      if (e.error) sec.appendChild(vpEl('div', 'dvlc-vp-error', e.error))
      body.appendChild(sec)
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
          if (d.kind === 'voiceprint') {
            if (d.phase === 'download') emit({ modelNote: `声纹模型 ${fmtBytes(d.received || 0)} / ${fmtBytes(d.total || 0)}` })
            else if (d.phase === 'start') emit({ modelNote: '开始下载声纹模型…' })
            else if (d.phase === 'done') { emit({ modelNote: '声纹模型下载完成' }); void loadVoiceprintStatus() }
            else if (d.phase === 'error') emit({ error: '声纹模型下载失败：' + (d.error || '') })
            return
          }
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
      es.addEventListener('voiceprint', (e) => {
        try {
          const d = JSON.parse(e.data)
          if (d.kind === 'rejected') {
            awaitingFinal = false
            emit({ error: '不是本人的声音，已忽略（相似度 ' + Number(d.score || 0).toFixed(2) + ' / 阈值 ' + Number(d.threshold || 0).toFixed(2) + '）' })
            if (state.enabled) maybeResumeListening(300)
          } else if (d.kind === 'accepted') {
            emit({ error: '' })
          } else if (d.kind === 'enrolled') {
            emit({ error: '', modelNote: '声纹已注册' })
            void loadVoiceprintStatus()
          } else if (d.kind === 'cleared') {
            emit({ modelNote: '声纹已清除' })
            void loadVoiceprintStatus()
          } else if (d.kind === 'status') {
            vpStatus = { ...vpStatus, ...d }
          }
        } catch { /* ignore */ }
      })
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
/* 声纹入口（顶栏）与设置面板 */
.dvlc-vp-btn-head { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 12px; border-radius: 999px;
  border: 1px solid var(--dvlc-line); background: var(--dvlc-surface); color: var(--dvlc-ink);
  font-family: ${SANS}; font-size: 12px; letter-spacing: .04em; cursor: pointer; -webkit-app-region: no-drag; }
.dvlc-vp-btn-head:hover { background: var(--dvlc-surface-hover); }
.dvlc-vp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dvlc-stone-soft); flex: none; }
.dvlc-vp-btn-head.on .dvlc-vp-dot { background: var(--dvlc-accent-strong); box-shadow: 0 0 8px var(--dvlc-accent-strong); }
.dvlc-vp { position: fixed; inset: 0; z-index: 2147483601; display: flex; align-items: center; justify-content: center; }
.dvlc-vp[hidden] { display: none; }
.dvlc-vp-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.dvlc-vp-card { position: relative; width: min(560px, calc(100vw - 32px)); max-height: min(84vh, 760px); display: flex; flex-direction: column;
  border-radius: 22px; background: var(--dvlc-menu-bg); border: 1px solid var(--dvlc-line-strong);
  box-shadow: 0 30px 80px var(--dvlc-shadow); color: var(--dvlc-ink); overflow: hidden; -webkit-app-region: no-drag; }
.dvlc-vp-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px 12px; }
.dvlc-vp-title { font-family: ${SERIF}; font-size: 22px; letter-spacing: .02em; }
.dvlc-vp-close { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--dvlc-line); background: transparent;
  color: var(--dvlc-stone); font-size: 16px; line-height: 1; cursor: pointer; }
.dvlc-vp-close:hover { background: var(--dvlc-surface-hover); color: var(--dvlc-ink); }
.dvlc-vp-body { overflow: auto; overscroll-behavior: contain; padding: 0 22px 20px; display: flex; flex-direction: column; gap: 14px; }
.dvlc-vp-sec { border-top: 1px solid var(--dvlc-line); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.dvlc-vp-sec-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dvlc-vp-sec-t { font-size: 11px; letter-spacing: .16em; color: var(--dvlc-accent-text); }
.dvlc-vp-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dvlc-vp-col { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
.dvlc-vp-label { font-size: 13px; color: var(--dvlc-ink); }
.dvlc-vp-hint { font-size: 11.5px; line-height: 1.5; color: var(--dvlc-stone-soft); }
.dvlc-switch { width: 44px; height: 26px; border-radius: 999px; border: 1px solid var(--dvlc-line-strong);
  background: var(--dvlc-surface); position: relative; cursor: pointer; flex: none; transition: background .18s ease; }
.dvlc-switch-knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--dvlc-stone-soft); transition: left .18s ease, background .18s ease; }
.dvlc-switch.on { background: var(--dvlc-accent-strong); border-color: transparent; }
.dvlc-switch.on .dvlc-switch-knob { left: 20px; background: var(--dvlc-bg); }
.dvlc-vp-add { border: 1px solid var(--dvlc-line-strong); background: transparent; color: var(--dvlc-accent-text);
  border-radius: 999px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
.dvlc-vp-add:disabled { opacity: .4; cursor: default; }
.dvlc-vp-empty { font-size: 12.5px; color: var(--dvlc-stone-soft); padding: 14px; border: 1px dashed var(--dvlc-line-strong);
  border-radius: 12px; text-align: center; }
.dvlc-vp-card-item { display: flex; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--dvlc-line);
  border-radius: 14px; background: var(--dvlc-surface); }
.dvlc-vp-name-row { display: flex; align-items: center; gap: 8px; }
.dvlc-vp-name { font-size: 13.5px; color: var(--dvlc-ink); }
.dvlc-vp-status { font-size: 10px; padding: 2px 7px; border-radius: 999px; background: var(--dvlc-active-bg); color: var(--dvlc-accent-text); }
.dvlc-vp-meta { font-size: 11px; color: var(--dvlc-stone-soft); }
.dvlc-vp-btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dvlc-vp-btn { background: transparent; border: 1px solid var(--dvlc-line-strong); color: var(--dvlc-stone);
  border-radius: 9px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
.dvlc-vp-btn:hover { background: var(--dvlc-surface-hover); color: var(--dvlc-ink); }
.dvlc-vp-btn.primary { background: var(--dvlc-accent-strong); border-color: transparent; color: var(--dvlc-bg); }
.dvlc-vp-btn.danger { color: var(--dvlc-danger-text); border-color: var(--dvlc-danger-line); }
.dvlc-vp-btn:disabled { opacity: .4; cursor: default; }
.dvlc-vp-range { width: 100%; accent-color: var(--dvlc-accent-strong); }
.dvlc-vp-range-head { display: flex; align-items: center; justify-content: space-between; }
.dvlc-vp-range-val { font-size: 12px; color: var(--dvlc-accent-text); }
.dvlc-vp-opts { display: flex; gap: 8px; flex-wrap: wrap; }
.dvlc-vp-opt { border: 1px solid var(--dvlc-line-strong); background: transparent; color: var(--dvlc-stone);
  border-radius: 9px; padding: 6px 10px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
.dvlc-vp-opt.on { background: var(--dvlc-active-bg); border-color: var(--dvlc-accent-strong); color: var(--dvlc-accent-text); }
.dvlc-vp-link { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--dvlc-line); }
.dvlc-vp-select { background: var(--dvlc-surface); border: 1px solid var(--dvlc-line-strong); color: var(--dvlc-ink);
  border-radius: 8px; padding: 4px 8px; font-size: 11.5px; font-family: inherit; }
.dvlc-vp-check { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dvlc-stone); }
.dvlc-vp-input { width: 100%; background: var(--dvlc-surface); border: 1px solid var(--dvlc-line-strong);
  border-radius: 10px; color: var(--dvlc-ink); padding: 10px 12px; font-size: 13px; font-family: inherit; outline: none; box-sizing: border-box; }
.dvlc-vp-input:focus { border-color: var(--dvlc-accent-strong); }
.dvlc-vp-progress { font-size: 11px; letter-spacing: .1em; color: var(--dvlc-accent-text); }
.dvlc-vp-prompt { font-family: ${SERIF}; font-size: 22px; line-height: 1.35; color: var(--dvlc-ink); }
.dvlc-vp-wave { display: flex; align-items: flex-end; gap: 3px; height: 34px; }
.dvlc-vp-wave i { width: 3px; background: var(--dvlc-accent-strong); border-radius: 2px; opacity: .85; }
.dvlc-vp-error { font-size: 12px; color: var(--dvlc-danger-text); }
.dvlc-vp-banner { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dvlc-danger-line);
  border-radius: 12px; background: var(--dvlc-danger-soft); }
.dvlc-vp-banner-t { font-size: 12px; color: var(--dvlc-danger-text); }
.dvlc-vp-foot-note { font-size: 11px; color: var(--dvlc-stone-soft); text-align: center; padding-top: 4px; }
@media (max-width: 600px) {
  .dvlc-vp-card { width: calc(100vw - 20px); max-height: 90vh; border-radius: 18px; }
  .dvlc-vp-body { padding: 0 16px 16px; }
  .dvlc-vp-prompt { font-size: 19px; }
  .dvlc-vp-btn-head { padding: 0 9px; font-size: 11px; }
}
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
      // 声纹入口（箭头位置：主题按钮左边）
      const vpBtn = document.createElement('button')
      vpBtn.type = 'button'
      vpBtn.className = 'dvlc-vp-btn-head'
      vpBtn.title = '声纹识别设置'
      vpBtn.setAttribute('aria-label', '声纹识别设置')
      const vpDot = document.createElement('span'); vpDot.className = 'dvlc-vp-dot'
      const vpBtnText = document.createElement('span'); vpBtnText.textContent = '声纹'
      vpBtn.appendChild(vpDot); vpBtn.appendChild(vpBtnText)
      vpBtn.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation()
        if (ev && ev.preventDefault) ev.preventDefault()
        if (overlayRefs && overlayRefs.vpPanel && !overlayRefs.vpPanel.hidden) closeVpPanel()
        else openVpPanel()
      })

      head.appendChild(brand); head.appendChild(spacer); head.appendChild(vpBtn); head.appendChild(themeWrap); head.appendChild(modelWrap); head.appendChild(timer); head.appendChild(min)

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

      // 声纹设置面板（覆盖层内的居中卡片）
      const vpPanel = document.createElement('div')
      vpPanel.className = 'dvlc-vp'
      vpPanel.hidden = true
      const vpBackdrop = document.createElement('div')
      vpBackdrop.className = 'dvlc-vp-backdrop'
      vpBackdrop.addEventListener('click', () => closeVpPanel())
      const vpCard = document.createElement('div')
      vpCard.className = 'dvlc-vp-card'
      const vpHead = document.createElement('div')
      vpHead.className = 'dvlc-vp-head'
      const vpTitle = document.createElement('div')
      vpTitle.className = 'dvlc-vp-title'
      vpTitle.textContent = '声纹识别'
      const vpClose = document.createElement('button')
      vpClose.type = 'button'
      vpClose.className = 'dvlc-vp-close'
      vpClose.textContent = '×'
      vpClose.setAttribute('aria-label', '关闭声纹设置')
      vpClose.addEventListener('click', () => closeVpPanel())
      vpHead.appendChild(vpTitle); vpHead.appendChild(vpClose)
      const vpBody = document.createElement('div')
      vpBody.className = 'dvlc-vp-body'
      vpCard.appendChild(vpHead); vpCard.appendChild(vpBody)
      vpPanel.appendChild(vpBackdrop); vpPanel.appendChild(vpCard)

      root.appendChild(head); root.appendChild(stage); root.appendChild(foot); root.appendChild(vpPanel)
      document.body.appendChild(root)

      return {
        root, timer, sub, status, replyText, userText, error, bars, caret, user, note,
        modelWrap, modelBtn, modelMenu,
        themeWrap, themeBtn, themeMenu, themeSwatch, themeName,
        vpBtn, vpPanel, vpBody,
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

      // 声纹识别设置入口
      {
        const title = document.createElement('div')
        title.className = 'dvlc-model-group'
        title.textContent = '声纹 · 只回答我的声音'
        menu.appendChild(title)
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'dvlc-model-item'
        const n = document.createElement('span')
        n.textContent = '声纹识别设置'
        const t = document.createElement('span')
        t.className = 'dvlc-model-tag'
        t.textContent = vpStatus.enabled ? '已开启' : (vpStatus.modelReady ? ((vpStatus.profiles || []).length + ' 组') : '模型未下载')
        btn.appendChild(n); btn.appendChild(t)
        btn.addEventListener('click', () => { closeModelMenu(); openVpPanel() })
        menu.appendChild(btn)
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
        void loadVoiceprintStatus()
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
      void loadVoiceprintStatus()
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
      vpRec = null
      vpEnroll = null
      vpView = 'home'
      vpTestingId = ''
      stopVpWave()
      stopOverlayLoop()
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', onOverlayKey)
        document.removeEventListener('click', onOverlayDocClick)
      }
      if (state.overlay) emit({ overlay: false })
    }

    function onOverlayKey(e) {
      if (!e || e.key !== 'Escape') return
      if (vpOpen()) { closeVpPanel(); return }
      closeOverlay()
    }

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
