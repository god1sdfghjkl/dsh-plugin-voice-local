/**
 * 语音引擎管理器（宿主侧）。
 *
 * 全部推理在 worker_threads 里跑：
 *   - TTS worker：onnxruntime-node + JS 文本前端（微调音色）
 *   - ASR worker：sherpa-onnx WASM（zipformer 流式 + SenseVoice 定稿）
 *
 * 为什么不放主线程：
 *   session.run() 是同步 CPU 密集调用，会卡住 DSH 整个事件循环。
 *
 * 为什么不 spawn 独立进程：
 *   用户要求「不像之前启动语音助手开一个」——DSH 直接用，不多出窗口/进程。
 */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export class VoiceEngine {
  constructor(opts = {}) {
    this.opts = {
      ttsProfile: opts.ttsProfile || null,
      sr: opts.sr || 0,
      asrStreamingProfile: opts.asrStreamingProfile || null,
      asrFinalProfile: opts.asrFinalProfile || null,
      ttsThreads: opts.ttsThreads || 4,
      asrThreads: opts.asrThreads || 1,
      warmupText: opts.warmupText || '你好，我是你的语音助手。',
      ...opts,
    }
    this.ttsProfile = this.opts.ttsProfile
    this.asrStreamingProfile = this.opts.asrStreamingProfile
    this.asrFinalProfile = this.opts.asrFinalProfile
    this.ttsWorker = null
    this.asrWorker = null
    this.exitPromises = []
    this.ttsReady = false
    this.asrReady = false
    this.ttsInfo = null
    this.seq = 0
    this.pending = new Map()      // TTS 请求 id → {resolve,reject,t0}
    this.asrListeners = new Set()  // ASR 事件回调
    this.state = 'idle'           // idle | loading | ready | error
    this.lastError = ''
    this.loadMs = 0
    this.warmupMs = 0
    this.stats = { synthCount: 0, lastSynthMs: 0, avgSynthMs: 0 }
  }

  // ------------------------------------------------------------ 模型检查
  /** 缺模型时给出可执行的提示（路径 + 去哪下），而不是干巴巴一句失败 */
  checkModels() {
    const problems = []
    if (this.ttsProfile) {
      for (const p of this.ttsProfile.problems || []) problems.push(`TTS（${this.ttsProfile.id}）: ${p}`)
    } else {
      problems.push('TTS: 未找到可用模型（ttsOnnx / ttsModel / dataRoot/models/tts）')
    }
    const addAsr = (label, profile) => {
      if (!profile) return
      for (const p of profile.problems || []) problems.push(`ASR ${label}（${profile.id}）: ${p}`)
    }
    addAsr('流式', this.asrStreamingProfile)
    addAsr('定稿', this.asrFinalProfile)
    return problems
  }

  // ------------------------------------------------------------ 启动
  async start() {
    if (this.state === 'loading' || this.state === 'ready') return this.status()
    const problems = this.checkModels()
    // TTS 属于可选通道：只配置 ASR 时仍可作为「语音输入」使用（手机端/纯听写场景）。
    // 但已配置的 TTS 模型缺文件同样不阻塞 ASR 启动，避免一个模型坏掉拖垮整条链路。
    const fatal = problems.filter((p) => p.indexOf('TTS: 未找到') !== 0 && p.indexOf('TTS（') !== 0)
    if (fatal.length) {
      this.state = 'error'
      this.lastError = '缺少模型文件：\n' + fatal.join('\n')
      return this.status()
    }
    if (!this.ttsProfile && !this.asrStreamingProfile) {
      this.state = 'error'
      this.lastError = '未配置任何模型（TTS: ttsOnnx / ttsModel / dataRoot/models/tts；ASR: asrModel / dataRoot/models/asr）'
      return this.status()
    }

    this.state = 'loading'
    const t0 = Date.now()
    const results = await Promise.allSettled([this._startTts(), this._startAsr()])
    this.loadMs = Date.now() - t0
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason))
    if (errors.length) {
      this.state = 'error'
      this.lastError = errors.join('; ')
      return this.status()
    }
    this.state = this.ttsReady || this.asrReady ? 'ready' : 'error'
    if (this.state === 'error') this.lastError = this.lastError || '引擎没有可用通道'
    return this.status()
  }

  _startTts() {
    if (!this.ttsProfile) { this.ttsReady = false; return Promise.resolve() }
    const problems = this.ttsProfile.problems || []
    if (problems.length) {
      this.ttsReady = false
      return Promise.reject(new Error(`TTS 模型不可用：${problems.join('；')}`))
    }
    return new Promise((resolve, reject) => {
      const w = new Worker(join(HERE, 'tts', 'worker.js'))
      this.ttsWorker = w
      this.exitPromises.push(new Promise((r) => w.once('exit', r)))
      let loaded = false
      const timer = setTimeout(() => reject(new Error('TTS 加载超时（120s）')), 120000)
      w.on('message', (m) => {
        if (m.type === 'loaded') {
          if (loaded) return
          loaded = true
          clearTimeout(timer)
          this.ttsReady = true
          this.ttsLoadMs = m.loadMs
          this.ttsInfo = {
            id: this.ttsProfile.id,
            name: this.ttsProfile.name,
            engine: m.engine || this.ttsProfile.engine,
            sampleRate: m.sampleRate || this.ttsProfile.sampleRate || 0,
            speakers: m.speakers || 0,
          }
          this.warmup()
          resolve()
        } else if (m.type === 'audio') {
          const p = this.pending.get(m.id)
          if (p) {
            this.pending.delete(m.id)
            const ms = Date.now() - p.t0
            this.stats.synthCount++
            this.stats.lastSynthMs = ms
            this.stats.avgSynthMs = Math.round((this.stats.avgSynthMs * (this.stats.synthCount - 1) + ms) / this.stats.synthCount)
            if (m.sampleRate) this.ttsInfo = { ...(this.ttsInfo || {}), sampleRate: m.sampleRate }
            p.resolve(m)
          }
        } else if (m.type === 'error') {
          const p = m.id !== undefined ? this.pending.get(m.id) : null
          if (p) {
            this.pending.delete(m.id)
            p.reject(new Error(m.message))
          } else if (!loaded) {
            clearTimeout(timer)
            reject(new Error(m.message))
          } else {
            console.error('[voice-local] TTS worker 错误：', m.message)
          }
        }
      })
      w.on('error', (e) => { clearTimeout(timer); if (!loaded) reject(e); else console.error('[voice-local] TTS worker 崩溃：', e) })
      w.postMessage({ type: 'load', profile: this.ttsProfile, threads: this.opts.ttsThreads })
    })
  }

  /** 后台预热：第一次 session.run 有一次性初始化开销，提前吃掉 */
  warmup() {
    if (!this.ttsReady || !this.opts.warmupText) return
    const t0 = Date.now()
    this.synth(this.opts.warmupText).then((r) => {
      this.warmupMs = Date.now() - t0
      console.log(`[voice-local] TTS 预热完成 ${this.warmupMs}ms（${r.pcm.length} 样本）`)
    }).catch((e) => console.warn('[voice-local] TTS 预热失败：', e?.message || e))
  }

  _startAsr() {
    if (!this.asrStreamingProfile) { this.asrReady = false; return Promise.resolve() }
    const problems = [
      ...(this.asrStreamingProfile.problems || []),
      ...(this.asrFinalProfile ? (this.asrFinalProfile.problems || []) : []),
    ]
    if (problems.length) {
      this.asrReady = false
      return Promise.reject(new Error(`ASR 模型不可用：${problems.join('；')}`))
    }
    return new Promise((resolve, reject) => {
      const w = new Worker(join(HERE, 'asr', 'worker.js'))
      this.asrWorker = w
      this.exitPromises.push(new Promise((r) => w.once('exit', r)))
      let loaded = false
      const timer = setTimeout(() => reject(new Error('ASR 加载超时（120s）')), 120000)
      w.on('message', (m) => {
        if (m.type === 'loaded') {
          if (loaded) return
          loaded = true
          clearTimeout(timer)
          this.asrReady = true
          this.asrInfo = {
            streaming: this.asrStreamingProfile ? { id: this.asrStreamingProfile.id, name: this.asrStreamingProfile.name, engine: this.asrStreamingProfile.engine, type: this.asrStreamingProfile.type } : null,
            final: this.asrFinalProfile ? { id: this.asrFinalProfile.id, name: this.asrFinalProfile.name, engine: this.asrFinalProfile.engine, type: this.asrFinalProfile.type } : null,
            finalReady: !!m.final,
          }
          resolve()
          return
        }
        if (m.type === 'error') {
          if (!loaded) { clearTimeout(timer); reject(new Error(m.message)); return }
          console.error('[voice-local] ASR worker 错误：', m.message)
          this.lastError = m.message
          return
        }
        for (const cb of this.asrListeners) {
          try { cb(m) } catch { /* 回调异常不影响引擎 */ }
        }
      })
      w.on('error', (e) => { clearTimeout(timer); if (!loaded) reject(e); else console.error('[voice-local] ASR worker 崩溃：', e) })
      w.postMessage({
        type: 'load',
        streaming: this.asrStreamingProfile,
        final: this.asrFinalProfile,
        threads: this.opts.asrThreads,
      })
    })
  }

  status() {
    return {
      state: this.state,
      ttsReady: this.ttsReady,
      asrReady: this.asrReady,
      loadMs: this.loadMs,
      ttsLoadMs: this.ttsLoadMs || 0,
      warmupMs: this.warmupMs || 0,
      lastError: this.lastError,
      stats: { ...this.stats },
      tts: this.ttsInfo,
      asr: this.asrInfo || {
        streaming: this.asrStreamingProfile ? { id: this.asrStreamingProfile.id, name: this.asrStreamingProfile.name } : null,
        final: this.asrFinalProfile ? { id: this.asrFinalProfile.id, name: this.asrFinalProfile.name } : null,
      },
    }
  }

  // ------------------------------------------------------------ TTS 模型热切换
  /**
   * 换 TTS 模型：只重启 TTS worker，ASR 不断。
   * 在途合成先落地再 terminate（避免 0xC0000409），超时则放弃。
   * @param {object} profile 注册表 profile
   * @returns {Promise<object>} 新状态
   */
  async switchTts(profile) {
    if (!profile) throw new Error('缺少 TTS profile')
    const problems = profile.problems || []
    if (problems.length) throw new Error(`模型不可用：${problems.join('；')}`)
    if (this.ttsInfo && this.ttsInfo.id === profile.id && this.ttsReady) return this.status()

    const prevState = this.state
    this.state = 'loading'
    this.warmupMs = 0
    this.lastError = ''
    try {
      await this._stopTts()
      this.ttsProfile = profile
      this.opts.ttsProfile = profile
      await this._startTts()
      this.state = this.ttsReady || this.asrReady ? 'ready' : 'error'
      return this.status()
    } catch (e) {
      this.state = this.asrReady ? 'ready' : (prevState === 'ready' ? 'ready' : 'error')
      this.lastError = `TTS 切换失败：${e?.message || e}`
      throw e
    }
  }

  /** 只停 TTS worker（ASR 保留） */
  async _stopTts() {
    const w = this.ttsWorker
    this.ttsReady = false
    this.ttsInfo = null
    this.ttsWorker = null
    if (!w) return
    // 等在途合成落地，避免 terminate 撞上 session.run
    if (this.pending.size) {
      await new Promise((resolve) => {
        const t0 = Date.now()
        const timer = setInterval(() => {
          if (!this.pending.size || Date.now() - t0 > 2000) {
            clearInterval(timer)
            for (const [, p] of this.pending) { try { p.reject(new Error('TTS 模型切换中')) } catch { /* ignore */ } }
            this.pending.clear()
            resolve()
          }
        }, 50)
        timer.unref?.()
      })
    }
    const exited = new Promise((resolve) => { try { w.once('exit', resolve) } catch { resolve() } })
    try { w.terminate() } catch { /* 已退出 */ }
    await Promise.race([exited, new Promise((resolve) => { const t = setTimeout(resolve, 1500); t.unref?.() })])
  }

  // ------------------------------------------------------------ TTS
  /**
   * 合成一句话。
   * @returns {Promise<{pcm: Int16Array, sampleRate: number, synthMs: number}>}
   */
  synth(text, speed = 1) {
    if (!this.ttsReady || !this.ttsWorker) return Promise.reject(new Error('TTS 未就绪'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, t0: Date.now() })
      try {
        this.ttsWorker.postMessage({ type: 'synth', id, text, speed })
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  // ------------------------------------------------------------ ASR
  onAsr(cb) { this.asrListeners.add(cb); return () => this.asrListeners.delete(cb) }
  asrStart() { this.asrWorker?.postMessage({ type: 'start' }) }
  /** @param {Float32Array} pcm 16k 单声道；调用方负责不要复用这份 buffer */
  asrFeed(pcm) {
    if (!this.asrWorker) return
    const copy = new Float32Array(pcm)
    this.asrWorker.postMessage({ type: 'feed', pcm: copy }, [copy.buffer])
  }
  asrFinal() { this.asrWorker?.postMessage({ type: 'final' }) }

  // ------------------------------------------------------------ ASR 模型热切换
  /**
   * 换 ASR 模型（流式/定稿可分别换），只重启 ASR worker，TTS 不断。
   * @param {{streaming?: object, final?: object|null}} next
   */
  async switchAsr(next = {}) {
    const streaming = next.streaming || this.asrStreamingProfile
    const final = next.final === null ? null : (next.final || this.asrFinalProfile)
    if (!streaming) throw new Error('缺少流式 ASR 模型')
    const problems = [
      ...(streaming.problems || []),
      ...(final ? final.problems || [] : []),
    ]
    if (problems.length) throw new Error(`模型不可用：${problems.join('；')}`)

    const prevState = this.state
    this.state = 'loading'
    this.lastError = ''
    try {
      await this._stopAsr()
      this.asrStreamingProfile = streaming
      this.asrFinalProfile = final
      this.opts.asrStreamingProfile = streaming
      this.opts.asrFinalProfile = final
      await this._startAsr()
      this.state = this.ttsReady || this.asrReady ? 'ready' : 'error'
      return this.status()
    } catch (e) {
      this.state = this.ttsReady ? 'ready' : (prevState === 'ready' ? 'ready' : 'error')
      this.lastError = `ASR 切换失败：${e?.message || e}`
      throw e
    }
  }

  /** 只停 ASR worker（TTS 保留） */
  async _stopAsr() {
    const w = this.asrWorker
    this.asrReady = false
    this.asrInfo = null
    this.asrWorker = null
    if (!w) return
    const exited = new Promise((resolve) => { try { w.once('exit', resolve) } catch { resolve() } })
    try { w.terminate() } catch { /* 已退出 */ }
    await Promise.race([exited, new Promise((resolve) => { const t = setTimeout(resolve, 1500); t.unref?.() })])
  }

  // ------------------------------------------------------------ 关闭
  /**
   * 关闭 worker。
   *
   * 不能直接 terminate：worker 里正在跑 onnxruntime 的 session.run 时强杀，
   * 主进程会以 0xC0000409（STATUS_STACK_BUFFER_OVERRUN）退出（实测）。
   * 所以先等正在合成的请求落地（最多 3s），再 terminate。
   */
  dispose() {
    if (this.disposing) return
    this.disposing = true
    this.ttsReady = false
    this.asrReady = false
    const finish = () => {
      const kill = (w) => {
        if (!w) return
        try { w.terminate() } catch { /* 已退 */ }
      }
      kill(this.ttsWorker)
      kill(this.asrWorker)
      this.ttsWorker = null
      this.asrWorker = null
      this.pending.clear()
      this.asrListeners.clear()
      this.state = 'idle'
    }
    if (!this.pending.size) { finish(); return }
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (!this.pending.size || Date.now() - t0 > 3000) {
        clearInterval(timer)
        finish()
      }
    }, 50)
    timer.unref?.()
  }

  /** 等两个 worker 线程真正退出（测试收尾 / 宿主卸载需要确定性时用） */
  async disposeAsync() {
    this.dispose()
    const waits = this.exitPromises.slice()
    this.exitPromises = []
    await Promise.all(waits)
  }
}
