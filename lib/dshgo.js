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

/** 原生面板「通道」按钮：BreezeBlue 可用时在云端/本地之间切换；不可用时只能本地。 */
export function nextTtsProvider(provider, breezeReady) {
  if (!breezeReady) return 'local'
  return provider === 'breeze' ? 'local' : 'breeze'
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
 *   setProvider?:(value:'local'|'breeze')=>{ok:boolean,label?:string,message?:string},
 *   setEmotion?:(value:'off'|'rule'|'smart')=>{ok:boolean,label?:string,message?:string},
 * }} opts
 */
export function installDshGo(ctx, opts = {}) {
  const { speak, ensureReady, resolveStyle, status, setProvider, setEmotion } = opts
  if (!ctx || typeof ctx.inject !== 'function' || typeof speak !== 'function') return
  ctx.inject(['dshGo'], (ctx) => {
    const jobs = new Map()
    // 当前是否有一个活着的 audio/voice 租约。没有租约时返回 audio.stop/voice.stop
    // 会被桥接判为「没有协商实例」，所以「停止」先看这个标记。
    let sessionActive = false
    // 正在合成（media 还没返回）的任务数；状态条只在真正忙的时候出现。
    let preparing = 0
    // sessionId → 最近一条可朗读的助手回复；用于面板「念最新」。
    const latestText = new Map()
    const latestDraft = new Map()

    // 参考 dsh-go 社区朗读插件的做法：回合结束时记住整条回复，
    // 面板可以一键「念最新」，不用每次长按消息。事件结构不存在时静默跳过。
    const rememberLatest = (session, event) => {
      try {
        const id = session?.id
        if (!id) return
        if (session?.header?.origin === 'subagent') return
        if (event?.type === 'assistant/message') {
          const blocks = event.data?.message?.content
          if (!Array.isArray(blocks)) return
          const turn = event.data?.turn
          if (event.data?.interrupted || blocks.some((b) => b?.type === 'tool-call')) {
            latestDraft.delete(id)
            return
          }
          const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          if (text.trim()) latestDraft.set(id, { turn, text })
          else latestDraft.delete(id)
          return
        }
        if (event?.type !== 'turn/end') return
        const held = latestDraft.get(id)
        latestDraft.delete(id)
        if (!held || held.turn !== event.data?.turn) return
        if (event.data?.reason?.kind !== 'completed') return
        const text = cleanForSpeech(held.text)
        if (text) {
          latestText.set(id, text)
          while (latestText.size > 32) latestText.delete(latestText.keys().next().value)
        }
      } catch { /* 不同 DSH 版本的事件结构不同，静默跳过 */ }
    }
    if (typeof ctx.on === 'function') {
      try { ctx.on('session/event', rememberLatest) } catch { /* 没有 session 事件 */ }
    }

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
      sessionActive = true
      const effects = [
        { type: 'audio', op: 'play', instance: INSTANCE, src: 'media:speech', key: job.key },
        { type: 'voice', op: 'start', instance: INSTANCE },
      ]
      if (job.truncated) effects.push({ type: 'toast', text: '消息较长，只朗读了前面的部分' })
      return effects
    }

    const readStatus = () => {
      try { return (typeof status === 'function' ? status() : null) || {} }
      catch { return {} }
    }

    ctx.dshGo.on('read', (scope) => {
      const job = startJob(scope?.message)
      if (!job) return { type: 'toast', text: '这条没有能朗读的文字' }
      return playEffects(job)
    })

    // 原生胶囊点按 → 打开原生面板。
    ctx.dshGo.on('voice-open', () => ({ type: 'open', page: 'panel:voice-panel' }))

    const stripText = (s) => {
      if (!s.ready) return '语音未就绪'
      if (preparing > 0) return '正在合成…'
      if (sessionActive) return '正在朗读…'
      // 空闲时不占输入框上方那一行；入口仍保留在输入框胶囊「语音」里。
      return ''
    }

    // 输入框上方状态条：只在合成 / 朗读 / 未就绪时出现，空闲自动收起。
    if (typeof ctx.dshGo.strip === 'function') {
      ctx.dshGo.strip('voice-strip', (scope, emit) => {
        let shown = null
        const tick = () => {
          const s = readStatus()
          const text = stripText(s)
          if (!text) {
            if (shown !== '') emit({ text: '' })
            shown = ''
            return
          }
          const next = { text, icon: 'speaker', tone: s.ready ? 'good' : 'warn' }
          const key = `${text}|${next.tone}`
          if (key === shown) return
          shown = key
          emit(next)
        }
        tick()
        const timer = setInterval(tick, 1000)
        timer.unref?.()
        return () => clearInterval(timer)
      })
    }

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
      preparing++
      try {
        for (const chunk of job.chunks) {
          if (signal?.aborted) break
          wavs.push(asBuffer(await speak(chunk, style === undefined ? {} : { style })))
        }
      } finally {
        preparing = Math.max(0, preparing - 1)
      }
      if (!wavs.length) throw new Error(signal?.aborted ? '朗读已取消' : '语音合成失败')
      return { body: concatWav(wavs), contentType: 'audio/wav' }
    })

    // 原生面板：状态、常用操作和两种切换放在一屏。
    // 参考社区朗读插件的做法：状态用 callout，主操作只留「念最新/试听/停止」，
    // 通道和情感改成明确的选项按钮，不再用一个按钮循环，减少猜测。
    if (typeof ctx.dshGo.panel === 'function') {
      const argOf = (event) => {
        const v = event?.value
        if (v === undefined || v === null) return {}
        return typeof v === 'object' ? (v.value ?? v) : {}
      }

      ctx.dshGo.panel('voice-panel', {
        view: (scope) => {
          const s = readStatus()
          const children = [
            { type: 'callout', tone: { $: 'data.headlineTone' }, text: { $: 'data.headline' } },
            { type: 'text', text: { $: 'data.subline' }, tone: 'muted' },
            {
              type: 'actions',
              items: [
                { label: '念最新', action: 'readLatest', icon: 'speaker', style: 'primary' },
                { label: '试听', action: 'test', icon: 'play' },
                { label: '停止', action: 'stop', icon: 'stop' },
              ],
            },
            { type: 'text', text: { $: 'data.channelLine' }, tone: 'muted' },
            {
              type: 'actions',
              items: [
                { label: '本地', action: { id: 'setProvider', args: { v: 'local' } }, icon: 'phone' },
                { label: '云端', action: { id: 'setProvider', args: { v: 'breeze' } }, icon: 'cloud' },
              ],
            },
          ]
          if (s.provider === 'breeze') {
            children.push(
              { type: 'text', text: { $: 'data.emotionLine' }, tone: 'muted' },
              {
                type: 'actions',
                items: [
                  { label: '关', action: { id: 'setEmotion', args: { v: 'off' } } },
                  { label: '规则', action: { id: 'setEmotion', args: { v: 'rule' } } },
                  { label: '智能', action: { id: 'setEmotion', args: { v: 'smart' } } },
                ],
              },
            )
          }
          children.push(
            {
              type: 'keyValue',
              items: [
                { label: '音色', value: { $: 'data.voiceLabel' } },
                { label: '最新回复', value: { $: 'data.latestLabel' } },
              ],
            },
            { type: 'text', text: '点「念最新」读最后一条回复；语音输入用输入框麦克风。', tone: 'muted' },
          )
          return { type: 'stack', children }
        },
        data: (scope, emit) => {
          const s = readStatus()
          const latest = latestText.has(scope?.sessionId)
          emit({
            headline: s.ready
              ? (s.provider === 'breeze' ? '语音已就绪 · 云端' : '语音已就绪 · 本地')
              : '语音未就绪',
            headlineTone: s.ready ? 'good' : 'warn',
            subline: s.ready
              ? (s.provider === 'breeze'
                ? '回复会用云端音色朗读。'
                : '回复会用本地音色朗读。')
              : '先加载模型或检查语音设置。',
            channelLine: s.provider === 'breeze' ? '朗读：云端 Breeze' : '朗读：本地模型',
            emotionLine: `自动情感：${s.emotionLabel || '关'}`,
            voiceLabel: s.voiceLabel || '未设置',
            latestLabel: latest ? '可朗读' : '暂无',
            // 兼容旧数据键；面板不再直接展示这些重复行。
            ttsLabel: s.ttsLabel || '未知',
            asrLabel: s.asrLabel || 'dsh-go 官方语音输入',
            emotionLabel: s.emotionLabel || '关',
            readyLabel: s.ready ? '就绪' : '未就绪',
            readyTone: s.ready ? 'good' : 'warn',
          })
          return () => {}
        },
        actions: {
          readLatest: (scope) => {
            const text = latestText.get(scope?.sessionId)
            if (!text) return { type: 'toast', text: '这个会话还没有可朗读的回复' }
            if (!readStatus().ready) return { type: 'toast', text: '语音引擎未就绪，请先加载模型' }
            const job = startJob(text)
            return job ? playEffects(job) : { type: 'toast', text: '这条没有能朗读的文字' }
          },
          test: () => {
            const s = readStatus()
            if (!s.ready) return { type: 'toast', text: '语音引擎未就绪，请先加载模型' }
            const job = startJob('你好，这是语音试听。')
            return job ? playEffects(job) : { type: 'toast', text: '现在没有可试听的内容' }
          },
          stop: () => {
            if (!sessionActive) return [{ type: 'refresh', id: 'voice-panel' }]
            return [
              { type: 'audio', op: 'stop', instance: INSTANCE },
              { type: 'voice', op: 'stop', instance: INSTANCE },
            ]
          },
          setProvider: (scope, event) => {
            if (typeof setProvider !== 'function') {
              return { type: 'toast', text: '当前版本不支持在原生面板切换通道' }
            }
            const r = setProvider(argOf(event).v)
            if (!r?.ok) return { type: 'toast', text: r?.message || '切换通道失败' }
            return [{ type: 'refresh', id: 'voice-panel' }]
          },
          setEmotion: (scope, event) => {
            if (typeof setEmotion !== 'function') {
              return { type: 'toast', text: '当前版本不支持在原生面板切换情感' }
            }
            const r = setEmotion(argOf(event).v)
            if (!r?.ok) return { type: 'toast', text: r?.message || '切换情感失败' }
            return [{ type: 'refresh', id: 'voice-panel' }]
          },
        },
      })
    }

    ctx.dshGo.onCapability?.((scope, ev) => {
      if (!ev || ev.instance !== INSTANCE) return
      // 播完 / 被停 / 出错 / 用户开口，都说明租约已经结束，后续「停止」不能再发 stop。
      if (ev.event === 'audio.ended' || ev.event === 'audio.stopped' || ev.event === 'audio.error'
        || ev.event === 'voice.speechStart' || ev.event === 'voice.stopped' || ev.event === 'voice.error') {
        sessionActive = false
      }
      // 保留最近一条 key，方便再点一次；只有 audio.error 时丢掉。
      if (ev.event === 'audio.error') jobs.delete(ev.key)
    })
  })
}