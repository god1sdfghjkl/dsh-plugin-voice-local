/**
 * 通话覆盖层离线预览：用真实 lib/client.js 构建 DOM，Edge headless 截图。
 * 只用于设计验收（不参与插件运行时）。
 *
 *   node docs/preview/preview-overlay.mjs         # 启动 127.0.0.1:57999
 *   msedge --headless=new --virtual-time-budget=4000 --window-size=1280,800 \
 *          --screenshot=docs/images/desktop-dark.png http://127.0.0.1:57999/
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const libDir = normalize(join(here, '..', '..', 'lib'))

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>voice-local overlay preview</title>
<style>html,body{margin:0;height:100%;background:#fbfaf7}</style>
</head><body>
<script>
  window.__ModuleLoader__ = { load(spec) {
    const require = (name) => name === 'react'
      ? { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, Fragment: {} }
      : {}
    window.__voice = spec.factory(require)
  } }
<\/script>
<script src="/lib/client.js"><\/script>
<script>
  // 预置一段回答字幕，便于核对排版；随后打开覆盖层
  window.addEventListener('load', () => {
    const v = window.__voice.__internals
    v.openOverlay()
    v.emit({
      phase: 'thinking',
      userText: '帮我看看这个语音插件现在能不能在 DSH 里直接说话',
      replyText: '可以。停顿约一秒会自动发送，回答时你可以直接开口打断。',
      level: 0.35,
      engine: {
        state: 'ready',
        tts: { id: 'tl196m', name: '自定义音色 tl196m', engine: 'vits2-onnx', sampleRate: 44100 },
      },
    })
    // 截图验收关掉入场动画/过渡，保证拿到稳定的最终态（否则 headless 可能截到半透明的中间帧）
    const still = document.createElement('style')
    still.textContent = '.dvlc-root, .dvlc-root * { animation: none !important; transition: none !important; }'
    document.head.appendChild(still)
    if (location.search.includes('debug')) {
      const box = document.createElement('pre')
      box.textContent = JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
        mq480: matchMedia('(max-width:480px)').matches, mq760: matchMedia('(max-width:760px)').matches })
      box.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483700;color:#fff;background:#000;font:11px monospace;padding:3px'
      document.body.appendChild(box)
    }
    // 可选：?theme=day-paper 切换背景主题（默认沿用上次存档/夜色苔绿）
    const themeMatch = location.search.match(/[?&]theme=([A-Za-z0-9_-]+)/)
    if (themeMatch) v.applyTheme(themeMatch[1])
    // 打开下拉，截一张带菜单的验收图：?menu=theme 打开背景菜单，默认打开模型菜单
    setTimeout(() => {
      const sel = location.search.includes('menu=theme') ? '.dvlc-theme-btn' : '.dvlc-model-btn'
      const btn = document.querySelector(sel)
      if (btn) btn.click()
    }, 400)
    if (v.overlayRoot && location.search.includes('debugbg')) v.overlayRoot().style.background = '#ff00ff'
    if (v.overlayRoot && location.search.includes('debugcss')) {
      const pre = document.createElement('pre')
      pre.textContent = 'root bg=' + getComputedStyle(v.overlayRoot()).backgroundColor +
        ' opacity=' + getComputedStyle(v.overlayRoot()).opacity +
        ' body=' + getComputedStyle(document.body).backgroundColor
      pre.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999999;color:#fff;font:12px monospace;background:#000;padding:4px'
      document.body.appendChild(pre)
    }
  })
<\/script>
</body></html>`

const types = { '.js': 'text/javascript', '.ttf': 'font/ttf', '.html': 'text/html; charset=utf-8' }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    let p = url.pathname
    if (p === '/') { res.writeHead(200, { 'content-type': types['.html'] }); res.end(HTML); return }
    // 模拟宿主的 TTS 模型接口，供模型下拉框预览
    if (p === '/voice-local/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        active: 'tl196m',
        tts: [
          { id: 'tl196m', name: '自定义音色 tl196m', engine: 'vits2-onnx', ok: true, download: null },
          { id: 'melo-zh', name: 'MeloTTS 中文', engine: 'sherpa-offline-tts', ok: true, download: null },
          { id: 'kokoro', name: 'Kokoro 多语', engine: 'sherpa-offline-tts', ok: false, download: { count: 3, missing: 3, bytes: 340000000 } },
        ],
        asrActive: { streaming: 'zh-stream', final: 'sv-final' },
        asr: [
          { id: 'zh-stream', name: 'Zipformer 中文流式', role: 'streaming', engine: 'sherpa-streaming-transducer', ok: true, download: null },
          { id: 'sv-final', name: 'SenseVoice 定稿', role: 'final', engine: 'sherpa-offline', ok: true, download: null },
        ],
      }))
      return
    }
    if (p === '/voice-local/models/use') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, active: 'melo-zh' }))
      return
    }
    if (p.startsWith('/lib/')) p = p.slice(4)
    else if (p.startsWith('/voice-local/assets/')) p = '/assets/' + p.slice('/voice-local/assets/'.length)
    const file = normalize(join(libDir, p))
    if (!file.startsWith(libDir)) { res.writeHead(403); res.end(); return }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})

const PORT = Number(process.env.PORT || 57999)
server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview http://127.0.0.1:${PORT}/`)
})
