/**
 * dsh-go 原生界面适配层（可选）。
 *
 * 目标：同一份插件包，桌面/网页继续用 lib/client.js；dsh-go 原生界面通过
 * `dshGo` 桥接提供固定输入框胶囊「语音」、状态条、原生面板和长按「朗读」，
 * 音频由 App 原生播放。
 *
 * 这里不碰引擎：TTS 由 lib/index.js 传入的 speak() 完成（复用现有
 * Vits2 / sherpa 引擎、模型下载和音色切换），本文件只负责：
 *   - 把消息正文清洗、切块（/speak 单次上限 2000 字）
 *   - 记住 key，media 路由时合成整段 WAV
 *   - 返回 audio.play + voice.start 效果
 *
 * 没有 dsh-go 桥接的桌面主机上，ctx.inject(['dshGo']) 的回调永远不会执行，
 * 对现有网页/桌面行为零影响。
 */

const MAX_CHARS = 1800
const MAX_CHUNKS = 8
const MAX_JOBS = 8
const JOB_TTL_MS = 10 * 60 * 1000
const INSTANCE = 'read'

/** 去掉 Markdown / 代码块 / 链接，只留适合朗读的文字。 */
export function cleanForSpeech(input) {
  let s = String(input || '')
  s = s.replace(/```[\s\S]*?```/g, ' 代码略 ')
  s = s.replace(/~~~[\s\S]*?~~~/g, ' 代码略 ')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/^[ \t]*[-*+]\s+/gm, '')
  s = s.replace(/^[ \t]*#{1,6}\s+/gm, '')
  s = s.replace(/[*_`~]/g, '')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s
}

/** 按句号/问号/换行切块，每块 ≤ max 字；超出 MAX_CHUNKS 的部分丢弃。 */
export function splitForSpeech(text, max = MAX_CHARS, maxChunks = MAX_CHUNKS) {
  const src = String(text || '').trim()
  if (!src) return { chunks: [], truncated: false }
  if (src.length <= max) return { chunks: [src], truncated: false }

  const chunks = []
  let rest = src
  while (rest && chunks.length < maxChunks) {
    if (rest.length <= max) { chunks.push(rest.trim()); rest = ''; break }
    let cut = -1
    for (const p of ['。', '！', '？', '；', '\n', '. ', '! ', '? ', '; ']) {
      const at = rest.lastIndexOf(p, max)
      if (at > max * 0.45 && at + p.length > cut) cut = at + p.length
    }
    if (cut <= 0) cut = max
    const piece = rest.slice(0, cut).trim()
    if (piece) chunks.push(piece)
    rest = rest.slice(cut).trim()
  }
  return { chunks, truncated: rest.length > 0 }
}

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

/** 解析 16bit PCM WAV 头；只接受本插件 /speak 产出的标准 44 字节头。 */
function wavInfo(buf) {
  const b = asBuffer(buf)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('TTS 返回的不是 WAV')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4)
    const size = b.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = b.subarray(body, Math.min(body + size, b.length))
      break
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data')
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
    throw new Error('只支持 16bit 单声道 PCM WAV')
  }
  return { ...fmt, pcm: data }
}

/** 原生面板「情感」按钮的三段循环：关 → 关键词规则 → 智能（LLM）→ 关。 */
export function nextEmotionMode(autoEmotion, smartEmotion) {
  if (!autoEmotion) return { autoEmotion: true, smartEmotion: false }
  if (!smartEmotion) return { autoEmotion: true, smartEmotion: true }
  return { autoEmotion: false, smartEmotion: false }
}

/** 把多段同采样率的 WAV PCM 拼成一个 WAV。 */
export function concatWav(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('没有可拼接的音频')
  const parts = list.map(wavInfo)
  const sampleRate = parts[0].sampleRate
  for (const p of parts) {
    if (p.sampleRate !== sampleRate) throw new Error('音频采样率不一致')
  }
  const pcm = Buffer.concat(parts.map((p) => p.pcm))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 安装 dsh-go 原生桥接。
 *
 * @param {object} ctx Cordis ctx
 * @param {{
 *   speak:(text:string, opts?:object)=>Promise<Buffer>,
 *   ensureReady?:()=>Promise<any>,
 *   resolveStyle?:(text:string)=>Promise<object|null>,
 *   status?:()=>object,
 *   cycleEmotion?:()=>{ok:boolean,label?:string,message?:string},
 * }} opts
 */
export function installDshGo(ctx, opts = {}) {
  const { speak, ensureReady, resolveStyle, status, cycleEmotion } = opts
  if (!ctx || typeof ctx.inject !== 'function' || typeof speak !== 'function') return
  ctx.inject(['dshGo'], (ctx) => {
    const jobs = new Map()

    const trim = () => {
      const now = Date.now()
      for (const [k, v] of jobs) if (now - v.at > JOB_TTL_MS) jobs.delete(k)
      while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value)
    }

    /** 把一段文字存成一个可被 media 路由取出的朗读任务。 */
    const startJob = (input) => {
      const text = cleanForSpeech(input)
      if (!text) return null
      const { chunks, truncated } = splitForSpeech(text)
      if (!chunks.length) return null
      const key = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      jobs.set(key, { chunks, text, at: Date.now() })
      trim()
      void Promise.resolve().then(() => ensureReady?.()).catch(() => {})
      return { key, chunks, text, truncated }
    }

    const playEffects = (job) => {
      const effects = [
        { type: 'audio', op: 'play', instance: INSTANCE, src: 'media:speech', key: job.key },
        { type: 'voice', op: 'start', instance: INSTANCE },
      ]
      if (job.truncated) effects.push({ toast: '消息较长，只朗读了前面的部分' })
      return effects
    }

    const readStatus = () => {
      try { return (typeof status === 'function' ? status() : null) || {} }
      catch { return {} }
    }

    const stripText = (s) => {
      if (!s.ready) return '语音 · 未就绪'
      if (s.smart) return '语音 · 智能情感'
      if (s.auto) return '语音 · 自动情感'
      if (s.provider === 'breeze') return '语音 · Breeze'
      return '语音 · 就绪'
    }

    ctx.dshGo.on('read', (scope) => {
      const job = startJob(scope?.message)
      if (!job) return { toast: '这条没有能朗读的文字' }
      return playEffects(job)
    })

    // 原生胶囊点按 → 打开原生面板；面板里再试听/停止/刷新。
    ctx.dshGo.on('voice-open', () => ({ open: 'panel:voice-panel' }))

    ctx.dshGo.media('speech', async (scope, { key, signal } = {}) => {
      const job = jobs.get(key)
      if (!job) throw new Error('这次朗读已经过期，再点一次「朗读」')
      await ensureReady?.()
      // 原生界面要等整段 WAV 合成完才播，不能像网页端那样逐句预取；
      // 所以按整条消息只算一次表演说明，再让所有分段共用，避免 8 段等 8 次 LLM。
      let style
      if (typeof resolveStyle === 'function') {
        try { style = await resolveStyle(String(job.text || '').slice(0, 1000)) }
        catch { style = undefined }
      }
      const wavs = []
      for (const chunk of job.chunks) {
        if (signal?.aborted) break
        wavs.push(asBuffer(await speak(chunk, style === undefined ? {} : { style })))
      }
      if (!wavs.length) throw new Error(signal?.aborted ? '朗读已取消' : '语音合成失败')
      return { body: concatWav(wavs), contentType: 'audio/wav' }
    })

    // 输入框上方固定状态条：一眼看到语音是否就绪，点开原生面板。
    if (typeof ctx.dshGo.strip === 'function') {
      ctx.dshGo.strip('voice-strip', (scope, emit) => {
        const tick = () => {
          const s = readStatus()
          emit({ text: stripText(s), icon: 'speaker', tone: s.ready ? 'good' : 'warn' })
        }
        tick()
        const timer = setInterval(tick, 15_000)
        timer.unref?.()
        return () => clearInterval(timer)
      })
    }

    // 原生面板：固定入口，不依赖网页；语音输入仍用 App 自带麦克风。
    if (typeof ctx.dshGo.panel === 'function') {
      ctx.dshGo.panel('voice-panel', {
        view: () => ({
          type: 'stack',
          children: [
            { type: 'callout', tone: 'info', text: '语音输入用 dsh-go 自带麦克风；这里负责朗读、试听和状态。' },
            { type: 'text', text: '点输入框的麦克风说话；长按助手回复可朗读整条消息。' },
            {
              type: 'keyValue',
              items: [
                { label: '朗读通道', value: { $: 'data.ttsLabel' } },
                { label: '音色', value: { $: 'data.voiceLabel' } },
                { label: '自动情感', value: { $: 'data.emotionLabel' } },
                { label: '语音识别', value: { $: 'data.asrLabel' } },
                { label: '声纹锁', value: { $: 'data.voiceprintLabel' } },
                { label: '状态', value: { $: 'data.readyLabel' }, tone: { $: 'data.readyTone' } },
              ],
            },
            {
              type: 'actions',
              items: [
                { label: '试听音色', action: 'test', icon: 'play', style: 'primary' },
                { label: '停止朗读', action: 'stop', icon: 'stop' },
                { label: '情感', action: 'emotion', icon: 'sparkle' },
                { label: '刷新', action: 'refresh', icon: 'refresh' },
              ],
            },
          ],
        }),
        data: (scope, emit) => {
          const s = readStatus()
          emit({
            ttsLabel: s.ttsLabel || '未知',
            voiceLabel: s.voiceLabel || '未设置',
            emotionLabel: s.emotionLabel || '关',
            asrLabel: s.asrLabel || '未知',
            voiceprintLabel: s.voiceprintLabel || '关',
            readyLabel: s.ready ? '就绪' : '未就绪',
            readyTone: s.ready ? 'good' : 'warn',
          })
          return () => {}
        },
        actions: {
          test: () => {
            const s = readStatus()
            if (!s.ready) return { toast: '语音引擎未就绪，请先加载模型' }
            const job = startJob('你好，这是 dsh-go 原生语音试听。')
            return job ? playEffects(job) : { toast: '现在没有可试听的内容' }
          },
          stop: () => [
            { type: 'audio', op: 'stop', instance: INSTANCE },
            { type: 'voice', op: 'stop', instance: INSTANCE },
          ],
          emotion: () => {
            if (typeof cycleEmotion !== 'function') return { toast: '当前版本不支持在原生面板切换情感' }
            const r = cycleEmotion()
            if (!r?.ok) return { toast: r?.message || '切换情感失败' }
            return [{ toast: `自动情感：${r.label || '已切换'}` }, { refresh: 'voice-panel' }]
          },
          refresh: () => ({ refresh: 'voice-panel' }),
        },
      })
    }

    ctx.dshGo.onCapability?.((scope, ev) => {
      if (!ev || ev.instance !== INSTANCE) return
      // App 已在本地停掉声音，这里只记录；保留最近一条 key，方便再点一次。
      if (ev.event === 'audio.error') jobs.delete(ev.key)
    })
  })
}