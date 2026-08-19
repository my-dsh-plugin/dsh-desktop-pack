// Desktop-shell chrome (injected by the Tauri shell into every loaded page).
//
// Two platform shapes:
//   - macOS: native title bar overlay (TitleBarStyle::Overlay) with native
//     traffic lights. The shell installs an NSEvent monitor that drags the
//     window from the top 32px (right of the traffic lights); double-click
//     zooms. This script only reserves that 32px strip so app content clears
//     the captions.
//   - Windows: decoration-less borderless window. This script draws the
//     caption buttons (minimize / maximize-restore / close) into the top-right
//     of the 32px strip, makes the strip drag the window (start_dragging),
//     double-click toggles maximize, and mirrors the WEB PAGE's resolved theme
//     into the window theme (native caption colors) — see below.
//
// The page is the theme authority: this script only reads what the page
// already applied (ui-theme writes `html { color-scheme }` /
// `body[data-ds-dark-theme]`), it never changes the page, and never lets the
// OS drive the page back.
//
// On Windows the caption buttons talk to the shell over the Tauri IPC bridge
// (window.__TAURI_INTERNALS__.invoke('plugin:window|...')). The harness UI is
// served over a remote origin (http://127.0.0.1), so those core:window
// commands must be permitted for that origin — see
// `capabilities/desktop-shell.json` (`desktop-shell-titlebar-remote`). If the
// bridge is unreachable the buttons simply do nothing; they never touch page
// state.
(() => {
  'use strict'
  const TITLEBAR_HEIGHT = 32
  const BUTTON_WIDTH = 46
  // Replaced at build time by the Rust side: true on Windows, false elsewhere.
  const SYNC_WINDOW_THEME = __DSH_DESKTOP_SYNC_WINDOW_THEME__
  const IS_WINDOWS = SYNC_WINDOW_THEME

  function invoke (cmd, args) {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args)
    }
    return Promise.reject(new Error('Tauri IPC unavailable'))
  }

  function readTheme () {
    if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
    return getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light'
  }

  function glyph (d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 10 10')
    svg.setAttribute('width', '10')
    svg.setAttribute('height', '10')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1')
    svg.style.display = 'block'
    svg.style.pointerEvents = 'none'
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.appendChild(path)
    return svg
  }

  const MINIMIZE_ICON = () => glyph('M0.5 5.5 H9.5')
  const MAXIMIZE_ICON = () => glyph('M1.5 1.5 H8.5 V8.5 H1.5 Z')
  const RESTORE_ICON = () => glyph('M3 3 H7 V7 H3 Z M7 3 H8.5 V8.5 H3 V7')
  const CLOSE_ICON = () => glyph('M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5')

  function captionButton (kind, title, icon) {
    const button = document.createElement('div')
    button.setAttribute('data-dsh-caption-btn', kind)
    button.title = title
    button.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:center',
      'width:' + BUTTON_WIDTH + 'px', 'height:' + TITLEBAR_HEIGHT + 'px',
      'cursor:default', 'user-select:none', '-webkit-user-select:none',
      'color:var(--dsh-caption-fg)', 'background:transparent',
      'transition:background-color .08s linear, color .08s linear',
    ].join(';')
    button.appendChild(icon())
    return button
  }

  function applyCaptionTheme (theme) {
    const bar = document.querySelector('[data-dsh-caption-bar]')
    if (!bar) return
    const dark = theme === 'dark'
    const set = (name, value) => bar.style.setProperty(name, value)
    set('--dsh-caption-fg', dark ? '#9aa4b2' : '#5f6368')
    set('--dsh-caption-hover', dark ? '#ffffff' : '#202124')
    set('--dsh-caption-hover-bg', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)')
    set('--dsh-caption-close-bg', '#e81123')
  }

  function installCaptionBar () {
    if (document.querySelector('[data-dsh-caption-bar]')) return
    const bar = document.createElement('div')
    bar.setAttribute('data-dsh-caption-bar', '')
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'height:' + TITLEBAR_HEIGHT + 'px',
      'display:flex', 'flex-direction:row', 'justify-content:flex-end', 'align-items:stretch',
      'z-index:2147483647', 'user-select:none', '-webkit-user-select:none',
    ].join(';')

    const btnMinimize = captionButton('minimize', '最小化', MINIMIZE_ICON)
    const btnMaximize = captionButton('maximize', '最大化', MAXIMIZE_ICON)
    const btnClose = captionButton('close', '关闭', CLOSE_ICON)

    const bindHover = (button) => {
      button.addEventListener('mouseenter', () => {
        button.style.background = button === btnClose
          ? 'var(--dsh-caption-close-bg)'
          : 'var(--dsh-caption-hover-bg)'
        button.style.color = button === btnClose ? '#ffffff' : 'var(--dsh-caption-hover)'
      })
      button.addEventListener('mouseleave', () => {
        button.style.background = 'transparent'
        button.style.color = 'var(--dsh-caption-fg)'
      })
    }
    bindHover(btnMinimize)
    bindHover(btnMaximize)
    bindHover(btnClose)

    btnMinimize.addEventListener('click', () => { invoke('plugin:window|minimize').catch(() => {}) })
    btnMaximize.addEventListener('click', () => { invoke('plugin:window|toggle_maximize').catch(() => {}) })
    btnClose.addEventListener('click', () => { invoke('plugin:window|close').catch(() => {}) })

    // Drag from the strip (outside the buttons) and double-click to maximize.
    bar.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      if (event.target.closest && event.target.closest('[data-dsh-caption-btn]')) return
      event.preventDefault()
      invoke('plugin:window|start_dragging').catch(() => {})
    })
    bar.addEventListener('dblclick', (event) => {
      if (event.target.closest && event.target.closest('[data-dsh-caption-btn]')) return
      invoke('plugin:window|toggle_maximize').catch(() => {})
    })

    bar.appendChild(btnMinimize)
    bar.appendChild(btnMaximize)
    bar.appendChild(btnClose)
    document.documentElement.appendChild(bar)

    // Maximize/restore glyph follows the real window state.
    let maxState = null
    const refreshMaxState = () => {
      invoke('plugin:window|is_maximized').then((maximized) => {
        if (maximized === maxState) return
        maxState = maximized
        btnMaximize.title = maximized ? '还原' : '最大化'
        btnMaximize.replaceChildren(maximized ? RESTORE_ICON() : MAXIMIZE_ICON())
      }).catch(() => {})
    }
    window.addEventListener('resize', refreshMaxState)
    document.addEventListener('visibilitychange', refreshMaxState)
    refreshMaxState()
  }

  function mount () {
    // Reserve the top strip (overlay traffic lights on macOS / caption buttons
    // on Windows) so the app's own 100%-height boxes stay below the captions.
    const html = document.documentElement
    html.style.boxSizing = 'border-box'
    html.style.height = '100%'
    html.style.paddingTop = TITLEBAR_HEIGHT + 'px'
    if (document.body) document.body.style.boxSizing = 'border-box'

    if (IS_WINDOWS) {
      installCaptionBar()
      applyCaptionTheme(readTheme())
    }

    if (!SYNC_WINDOW_THEME) return

    const sync = () => {
      applyCaptionTheme(readTheme())
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
