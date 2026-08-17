// Desktop-shell chrome (injected by the Tauri shell into every loaded page).
//
// Responsibilities:
//   1. Reserve a 32px top strip and add a draggable region there, so the native
//      macOS traffic lights / Windows caption buttons never overlap the app
//      content, and the window stays draggable without a native title bar.
//   2. On Windows, mirror the WEB PAGE's resolved theme into the window theme
//      (caption button colors) via setTheme. The web page is the authority:
//      this script only reads what the page already applied (ui-theme writes
//      `html { color-scheme }` and `body[data-ds-dark-theme]`) — it never
//      changes the page, and it never lets the OS theme drive the page back.
//
// The strip is painted with the page's own theme tokens, so its color follows
// the page automatically (boot page falls back to its own dark background).
(() => {
  'use strict'
  const TITLEBAR_HEIGHT = 32
  // Replaced at build time by the Rust side: true on Windows, false elsewhere
  // (macOS traffic lights are theme-neutral; setTheme there would cascade into
  // the webview's prefers-color-scheme and fight the page's own theme choice).
  const SYNC_WINDOW_THEME = __DSH_DESKTOP_SYNC_WINDOW_THEME__

  const hasTauri = () => !!(window.__TAURI__ && window.__TAURI__.window)
  const currentWindow = () => window.__TAURI__.window.getCurrentWindow()

  function mount () {
    // Reserve the strip so the app content stays below the caption area, while
    // keeping the app's own 100%-height boxes inside the remaining viewport.
    const html = document.documentElement
    html.style.boxSizing = 'border-box'
    html.style.height = '100%'
    html.style.paddingTop = TITLEBAR_HEIGHT + 'px'
    if (document.body) document.body.style.boxSizing = 'border-box'

    const strip = document.createElement('div')
    strip.id = 'dsh-desktop-chrome-strip'
    strip.dataset.tauriDragRegion = ''
    strip.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'height:' + TITLEBAR_HEIGHT + 'px',
      'z-index:2147483646',
      'user-select:none',
      '-webkit-user-select:none',
      'background:var(--dsw-alias-bg-base, var(--dsw-bg, #0f1115))',
    ].join(';')
    if (hasTauri()) {
      strip.addEventListener('dblclick', () => {
        currentWindow().toggleMaximize().catch(() => {})
      })
    }
    ;(document.body || html).appendChild(strip)

    if (SYNC_WINDOW_THEME && hasTauri()) {
      const win = currentWindow()
      const readTheme = () => {
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
        return getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light'
      }
      const sync = () => {
        try { win.setTheme(readTheme()) } catch {}
      }
      // The host bootstrap can apply the theme before <body> exists; observe
      // the root again and re-sync on full load. Throttle attribute bursts.
      let pending = null
      const observer = new MutationObserver(() => {
        if (pending !== null) return
        pending = setTimeout(() => { pending = null; sync() }, 50)
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
        childList: true,
      })
      window.addEventListener('load', sync)
      sync()
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()