// Desktop-shell chrome (injected by the Tauri shell into every loaded page).
//
// The shell drags the window natively (NSEvent local monitor on macOS /
// window.start_dragging on Windows), so this script does NOT render any
// visible title bar. It only:
//   1. Reserves a transparent 32px top zone, so the overlay title bar
//      (macOS traffic lights / Windows caption buttons) never overlaps the
//      app content and the native drag zone stays clear of the UI.
//   2. On Windows, mirrors the WEB PAGE's resolved theme into the window
//      theme (caption button colors) via plugin:window|set_theme. The page is
//      the theme authority: this script only reads what the page already
//      applied (ui-theme writes `html { color-scheme }` /
//      `body[data-ds-dark-theme]`), it never changes the page, and never lets
//      the OS drive the page back.
//
// Notes:
//   - On macOS the drag zone is implemented in the shell with an NSEvent
//     monitor (top 32px, right of the traffic lights); double-click zooms.
//   - IPC from this page only works where the Tauri bridge is reachable; the
//     theme sync degrades silently if not.
(() => {
  'use strict'
  const TITLEBAR_HEIGHT = 32
  // Replaced at build time by the Rust side: true on Windows, false elsewhere.
  const SYNC_WINDOW_THEME = __DSH_DESKTOP_SYNC_WINDOW_THEME__

  function mount () {
    // Reserve the top zone so app content stays below the caption area, while
    // keeping the app's own 100%-height boxes inside the remaining viewport.
    const html = document.documentElement
    html.style.boxSizing = 'border-box'
    html.style.height = '100%'
    html.style.paddingTop = TITLEBAR_HEIGHT + 'px'
    if (document.body) document.body.style.boxSizing = 'border-box'

    if (!SYNC_WINDOW_THEME) return

    const invoke = (cmd, args) => {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        return window.__TAURI_INTERNALS__.invoke(cmd, args)
      }
      return Promise.reject(new Error('Tauri IPC unavailable'))
    }
    const readTheme = () => {
      if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
      return getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light'
    }
    const sync = () => {
      invoke('plugin:window|set_theme', { theme: readTheme() }).catch(() => {})
    }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()
