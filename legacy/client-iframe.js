/**
 * dsh-plugin-voice-local · 浏览器端（client bundle）
 *
 * 形态对齐 dsh-realtime-voice 的 client bundle：
 *   UMD 包装（DSH 的 __ModuleLoader__ 加载）+ CommonJS 导出 name/inject/apply。
 * 功能：悬浮按钮 + 懒加载面板（原生 DOM，零依赖）。
 *   - 点开才创建 iframe（引擎页面），DSH 主界面零影响
 *   - 打开前先查宿主同源状态路由 /voice-local/，引擎未就绪显示进度而非报错
 *   - Esc 收起；iframe 收起不销毁，二次打开零等待
 */
(function (root, factory) {
  if (root && root.__ModuleLoader__) {
    root.__ModuleLoader__.load({ id: 'dsh-plugin-voice-local', factory: function (require) {
      var module = { exports: {} }
      factory(module, module.exports, require, root)
      return module.exports
    } })
  } else if (typeof module === 'object' && module.exports) {
    factory(module, module.exports, require, globalThis)
  } else if (root) {
    console.warn('[voice-local] 需要在 DSH 的 client kernel 里加载')
  }
})(typeof window === 'undefined' ? globalThis : window, function (module, exports, require, root) {
  'use strict'

  var BASE = '/voice-local'
  var panel = null
  var btn = null
  var booted = false

  function ensureButton() {
    if (btn) return
    btn = document.createElement('button')
    btn.id = 'voice-local-btn'
    btn.title = '本地语音助手'
    btn.textContent = '🎙'
    var s = btn.style
    s.position = 'fixed'; s.right = '18px'; s.bottom = '18px'; s.zIndex = 2147483000
    s.width = '44px'; s.height = '44px'; s.borderRadius = '50%'; s.border = 'none'
    s.cursor = 'pointer'; s.fontSize = '20px'; s.lineHeight = '44px'
    s.background = '#185FA5'; s.color = '#fff'; s.boxShadow = '0 2px 8px rgba(0,0,0,.25)'
    btn.onclick = toggle
    document.body.appendChild(btn)
  }

  function status() {
    return fetch(BASE + '/', { method: 'GET' })
      .then(function (r) { return r.json() })
      .catch(function () { return null })
  }

  function ensurePanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'voice-local-panel'
    var s = panel.style
    s.position = 'fixed'; s.right = '18px'; s.bottom = '72px'; s.zIndex = 2147483000
    s.width = '420px'; s.height = '560px'; s.borderRadius = '12px'; s.overflow = 'hidden'
    s.background = '#fff'; s.border = '1px solid rgba(0,0,0,.15)'
    s.boxShadow = '0 6px 24px rgba(0,0,0,.25)'; s.display = 'none'
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#185FA5;color:#fff;font:13px sans-serif">' +
      '<span style="flex:1">本地语音助手</span>' +
      '<span data-role="state" style="opacity:.8;font-size:12px"></span>' +
      '<button data-role="close" style="border:none;background:transparent;color:#fff;cursor:pointer;font-size:16px">×</button>' +
      '</div>' +
      '<iframe data-role="frame" style="flex:1;border:none;width:100%" title="voice panel"></iframe>' +
      '<div data-role="mask" style="position:absolute;inset:38px 0 0;display:flex;align-items:center;justify-content:center;font:13px sans-serif;color:#666;background:#fff">正在连接本地引擎…</div>'
    panel.querySelector('[data-role="close"]').onclick = toggle
    document.body.appendChild(panel)
    return panel
  }

  function openPanel() {
    var p = ensurePanel()
    return status().then(function (st) {
      var stateEl = p.querySelector('[data-role="state"]')
      var mask = p.querySelector('[data-role="mask"]')
      var frame = p.querySelector('[data-role="frame"]')
      if (st && st.engineReady) {
        if (!frame.src) frame.src = st.panel          // 懒加载：第一次打开才连引擎
        mask.style.display = 'none'
        stateEl.textContent = '就绪 ' + (st.uptimeSec || 0) + 's'
      } else {
        frame.src = 'about:blank'
        mask.style.display = 'flex'
        mask.textContent = (st && st.lastError) ? '引擎异常：' + st.lastError
                                                : '引擎加载中（模型约 1 分钟）…'
        stateEl.textContent = '等待引擎'
        setTimeout(function () {
          if (panel && panel.style.display === 'flex') openPanel()
        }, 2000)
      }
      p.style.display = 'flex'
    })
  }

  function toggle() {
    var p = ensurePanel()
    if (p.style.display === 'flex') p.style.display = 'none'
    else openPanel().catch(function () {})
  }

  function apply(ctx) {
    if (booted) return
    booted = true
    var mount = function () { ensureButton() }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })

    var onKey = function (e) {
      if (e.key === 'Escape' && panel && panel.style.display === 'flex') {
        panel.style.display = 'none'
      }
    }
    document.addEventListener('keydown', onKey)

    if (typeof ctx.effect === 'function') {
      ctx.effect(function () {
        return function () {
          document.removeEventListener('keydown', onKey)
          if (btn) { btn.remove(); btn = null }
          if (panel) { panel.remove(); panel = null }
          booted = false
        }
      }, 'dsh-plugin-voice-local.client')
    }
  }

  exports.name = 'dsh-plugin-voice-local'
  exports.inject = []
  exports.apply = apply
  exports.toggle = toggle
})
