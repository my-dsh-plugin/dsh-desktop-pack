// Desktop chrome injected into each page by the Tauri shell.
//
// macOS uses a 32px content inset for the native overlay traffic lights; its
// drag behavior lives in the AppKit event monitor in main.rs.
//
// Windows uses wry's built-in CSS `app-region: drag` support (enabled via
// WebView2 SetIsNonClientRegionSupportEnabled) for window dragging, and
// JavaScript IPC (`window.__TAURI__` or `window.ipc.postMessage`) for
// caption button actions (minimize / maximize / close).
(() => {
  'use strict'

  const TITLEBAR_HEIGHT = 32
  const BUTTON_WIDTH = 46
  const CAPTION_CONTROLS_WIDTH = BUTTON_WIDTH * 3
  const IS_WINDOWS = __DSH_DESKTOP_IS_WINDOWS__

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
    svg.style.cssText = 'display:block;pointer-events:none'
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

  // ---------------------------------------------------------------------------
  // Native window actions via Tauri IPC
  // ---------------------------------------------------------------------------

  function postNative (message) {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      switch (message) {
        case 'dsh:minimize':
          window.__TAURI__.core.invoke('plugin:window|minimize').catch(() => {})
          break
        case 'dsh:toggle_maximize':
          window.__TAURI__.core.invoke('plugin:window|toggle_maximize').catch(() => {})
          break
        case 'dsh:close':
          window.__TAURI__.core.invoke('plugin:window|close').catch(() => {})
          break
        case 'dsh:drag_window':
          window.__TAURI__.core.invoke('plugin:window|start_dragging').catch(() => {})
          break
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Caption bar DOM
  // ---------------------------------------------------------------------------

  function installCaptionBar () {
    if (document.querySelector('[data-dsh-caption-bar]')) return

    // ── Drag strip (top 12 DIP) ──────────────────────────────────────────
    //
    // wry enables `SetIsNonClientRegionSupportEnabled(true)` during WebView2
    // startup, so the CSS property `-webkit-app-region: drag` / `app-region: drag`
    // makes this area a native window drag handle without any Rust subclass.
    const dragStrip = document.createElement('div')
    dragStrip.setAttribute('data-dsh-drag-strip', '')
    dragStrip.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'height:12px', 'z-index:2147483646',
      '-webkit-app-region:drag', 'app-region:drag',
      'background:transparent', 'user-select:none',
    ].join(';')
    document.documentElement.appendChild(dragStrip)

    // ── Caption button bar ───────────────────────────────────────────────
    //
    // Placed ABOVE the drag strip (higher z-index) with `app-region: no-drag`
    // so the buttons are excluded from the drag region.
    const bar = document.createElement('div')
    bar.setAttribute('data-dsh-caption-bar', '')
    bar.style.cssText = [
      'position:fixed', 'top:0', 'right:0',
      'height:' + TITLEBAR_HEIGHT + 'px',
      'display:flex', 'align-items:stretch',
      'z-index:2147483647',
      '-webkit-app-region:no-drag', 'app-region:no-drag',
      'user-select:none', '-webkit-user-select:none',
    ].join(';')

    function makeButton (kind, title, icon) {
      const button = document.createElement('div')
      button.setAttribute('data-dsh-caption-btn', kind)
      button.title = title
      button.style.cssText = [
        'display:flex', 'align-items:center', 'justify-content:center',
        'width:' + BUTTON_WIDTH + 'px', 'height:' + TITLEBAR_HEIGHT + 'px',
        'flex:0 0 auto', 'cursor:default',
        'color:var(--dsh-caption-fg)', 'background:transparent',
        'transition:background-color .08s linear,color .08s linear',
      ].join(';')

      // Hover / pressed visual state — fully self-contained, no Rust IPC needed.
      button.addEventListener('mouseenter', () => {
        currentHover = kind
        applyVisualState()
      })
      button.addEventListener('mouseleave', () => {
        if (currentHover === kind) currentHover = null
        applyVisualState()
      })
      button.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        currentPressed = kind
        applyVisualState()
      })
      button.addEventListener('mouseup', () => {
        const pressed = currentPressed
        currentPressed = null
        applyVisualState()
        if (pressed !== kind) return
        // Fire the native action.
        switch (kind) {
          case 'minimize': return postNative('dsh:minimize')
          case 'maximize': return postNative('dsh:toggle_maximize')
          case 'close': return postNative('dsh:close')
        }
      })
      button.appendChild(icon())
      return button
    }

    let currentHover = null
    let currentPressed = null

    const buttons = {
      minimize: makeButton('minimize', '最小化', MINIMIZE_ICON),
      maximize: makeButton('maximize', '最大化', MAXIMIZE_ICON),
      close: makeButton('close', '关闭', CLOSE_ICON),
    }

    bar.append(buttons.minimize, buttons.maximize, buttons.close)
    document.documentElement.appendChild(bar)

    // ── Layout protection ─────────────────────────────────────────────────
    //
    // Prevent Harness header controls from hiding under the caption buttons.

    const insetStyle = document.createElement('style')
    insetStyle.setAttribute('data-dsh-caption-inset-style', '')
    insetStyle.textContent = `
      [data-dsh-caption-inset] {
        box-sizing: border-box !important;
        padding-right: calc(var(--dsh-caption-base-padding-right) + ${CAPTION_CONTROLS_WIDTH}px) !important;
      }
      [data-dsh-caption-shift] {
        translate: -${CAPTION_CONTROLS_WIDTH}px 0 !important;
      }
    `
    document.documentElement.appendChild(insetStyle)

    let insetContainers = []
    let shiftedControls = []
    function reserveCaptionSpace () {
      for (const el of insetContainers) {
        el.removeAttribute('data-dsh-caption-inset')
        el.style.removeProperty('--dsh-caption-base-padding-right')
      }
      for (const el of shiftedControls) el.removeAttribute('data-dsh-caption-shift')
      insetContainers = []
      shiftedControls = []

      const captionLeft = window.innerWidth - CAPTION_CONTROLS_WIDTH
      const targets = new Set()
      const intersectsCaption = (rect) => rect.width > 0 && rect.height > 0 &&
        rect.top < TITLEBAR_HEIGHT && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > captionLeft

      for (const header of document.querySelectorAll('header')) {
        if (intersectsCaption(header.getBoundingClientRect())) targets.add(header)
      }
      for (const button of document.querySelectorAll('button')) {
        if (!intersectsCaption(button.getBoundingClientRect())) continue
        let candidate = button.parentElement
        while (candidate && candidate !== document.body) {
          const rect = candidate.getBoundingClientRect()
          const display = getComputedStyle(candidate).display
          if (rect.right >= window.innerWidth - 1 && rect.top < TITLEBAR_HEIGHT &&
              rect.height <= TITLEBAR_HEIGHT * 3 && (display === 'flex' || display === 'grid')) {
            targets.add(candidate)
            break
          }
          candidate = candidate.parentElement
        }
        if (!candidate || candidate === document.body) {
          const position = getComputedStyle(button).position
          if (position === 'fixed' || position === 'absolute') {
            button.setAttribute('data-dsh-caption-shift', '')
            shiftedControls.push(button)
          }
        }
      }
      for (const el of targets) {
        el.style.setProperty('--dsh-caption-base-padding-right', getComputedStyle(el).paddingRight)
        el.setAttribute('data-dsh-caption-inset', '')
        insetContainers.push(el)
      }
    }

    let layoutFrame = null
    const syncLayout = () => {
      if (layoutFrame !== null) return
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null
        reserveCaptionSpace()
      })
    }
    const layoutObserver = new MutationObserver(syncLayout)
    if (document.body) layoutObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', syncLayout)

    // ── Theme & state ─────────────────────────────────────────────────────

    function applyTheme () {
      const dark = readTheme() === 'dark'
      bar.style.setProperty('--dsh-caption-fg', dark ? '#9aa4b2' : '#5f6368')
      bar.style.setProperty('--dsh-caption-hover', dark ? '#ffffff' : '#202124')
      bar.style.setProperty('--dsh-caption-hover-bg', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)')
      bar.style.setProperty('--dsh-caption-pressed-bg', dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.14)')
    }

    function applyVisualState () {
      for (const [kind, button] of Object.entries(buttons)) {
        const hovered = currentHover === kind
        const pressed = currentPressed === kind && hovered
        button.style.background = pressed
          ? (kind === 'close' ? '#c50f1f' : 'var(--dsh-caption-pressed-bg)')
          : hovered
            ? (kind === 'close' ? '#e81123' : 'var(--dsh-caption-hover-bg)')
            : 'transparent'
        button.style.color = hovered ? (kind === 'close' ? '#ffffff' : 'var(--dsh-caption-hover)') : 'var(--dsh-caption-fg)'
      }
    }

    // Rust can still update the maximize icon via this bridge.
    window.__DSH_DESKTOP_CHROME__ = {
      setNativeState (next) {
        const maximized = next.maximized === true
        buttons.maximize.title = maximized ? '还原' : '最大化'
        buttons.maximize.replaceChildren(maximized ? RESTORE_ICON() : MAXIMIZE_ICON())
      },
    }

    let pendingTheme = null
    const syncTheme = () => {
      if (pendingTheme !== null) return
      pendingTheme = setTimeout(() => {
        pendingTheme = null
        applyTheme()
        applyVisualState()
      }, 50)
    }
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
    })
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
      })
    }
    applyTheme()
    applyVisualState()
    syncLayout()
  }

  function mount () {
    const html = document.documentElement
    html.style.boxSizing = 'border-box'
    html.style.height = '100%'
    if (document.body) document.body.style.boxSizing = 'border-box'

    if (IS_WINDOWS) {
      html.style.paddingTop = '0'
      installCaptionBar()
    } else {
      html.style.paddingTop = TITLEBAR_HEIGHT + 'px'
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()