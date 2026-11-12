/**
 * TTS worker（worker_threads）。
 *
 * 为什么放 worker：
 *   onnxruntime-node 的 session.run 是同步 CPU 密集调用，放在宿主主线程会
 *   卡住 DSH 的整个事件循环（连打字机动画都会顿）。worker 里跑，主线程
 *   只收发消息，DSH 全程不卡。
 *
 * 协议：
 *   → { type: 'load', profile, threads }
 *   → { type: 'synth', id, text, speed, speakerId? }
 *   ← { type: 'loaded', loadMs, sampleRate, engine, profileId, inputs? }
 *   ← { type: 'audio', id, pcm: Int16Array  transferable, sampleRate }
 *   ← { type: 'error', id?, message }
 */
import { parentPort } from 'node:worker_threads'
import { TtsEngine } from './engine.js'

if (!parentPort) throw new Error('tts-worker 必须在 worker_threads 中运行')

let engine = null

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'load') {
      engine = new TtsEngine(msg.profile, { threads: msg.threads })
      const info = await engine.load()
      parentPort.postMessage({ type: 'loaded', ...info })
      return
    }

    if (msg.type === 'synth') {
      if (!engine) throw new Error('TTS 未加载')
      const t0 = Date.now()
      const { samples, sampleRate } = await engine.synth(msg.text, {
        speed: msg.speed,
        speakerId: msg.speakerId,
      })
      const pcm = TtsEngine.toPcm16(samples)
      parentPort.postMessage(
        { type: 'audio', id: msg.id, pcm, sampleRate: sampleRate || engine.sr, synthMs: Date.now() - t0 },
        [pcm.buffer],
      )
      return
    }

    if (msg.type === 'close') {
      try { engine?.free?.() } catch { /* 已释放 */ }
      engine = null
      process.exit(0)
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(e && e.message ? e.message : e) })
  }
})
