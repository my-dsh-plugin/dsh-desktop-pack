// Desktop chrome injected into each page by the Tauri shell.
//
// macOS keeps a 32px content inset for the native overlay traffic lights; its
// drag behavior lives in the AppKit event monitor in main.rs. Windows keeps the
// page full-height and overlays only visual caption glyphs. An HWND subclass in
// windows_titlebar.rs owns hit testing, dragging and caption actions, so this
// remote page never receives Tauri IPC access.
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

  function captionButton (kind, title, icon) {
    const button = document.createElement('div')
    button.setAttribute('data-dsh-caption-btn', kind)
    button.title = title
    button.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:center',
      'width:' + BUTTON_WIDTH + 'px', 'height:' + TITLEBAR_HEIGHT + 'px',
      'flex:0 0 auto', 'pointer-events:none',
      'color:var(--dsh-caption-fg)', 'background:transparent',
      'transition:background-color .08s linear,color .08s linear',
    ].join(';')
    button.appendChild(icon())
    return button
  }

  function installCaptionBar () {
    if (document.querySelector('[data-dsh-caption-bar]')) return

    const bar = document.createElement('div')
    bar.setAttribute('data-dsh-caption-bar', '')
    bar.style.cssText = [
      'position:fixed', 'top:0', 'right:0',
      'height:' + TITLEBAR_HEIGHT + 'px',
      'display:flex', 'align-items:stretch',
      'z-index:2147483647', 'pointer-events:none',
      'user-select:none', '-webkit-user-select:none',
    ].join(';')

    const buttons = {
      minimize: captionButton('minimize', '最小化', MINIMIZE_ICON),
      maximize: captionButton('maximize', '最大化', MAXIMIZE_ICON),
      close: captionButton('close', '关闭', CLOSE_ICON),
    }
    bar.append(buttons.minimize, buttons.maximize, buttons.close)
    document.documentElement.appendChild(bar)

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
      // Remove our previous layout effect before measuring the page's current
      // geometry. This keeps repeated mutations and resizes from compounding
      // the inset while panels open, close, or change width.
      for (const element of insetContainers) {
        element.removeAttribute('data-dsh-caption-inset')
        element.style.removeProperty('--dsh-caption-base-padding-right')
      }
      for (const element of shiftedControls) element.removeAttribute('data-dsh-caption-shift')
      insetContainers = []
      shiftedControls = []

      const captionLeft = window.innerWidth - CAPTION_CONTROLS_WIDTH
      const targets = new Set()
      const intersectsCaption = (rect) => rect.width > 0 && rect.height > 0 &&
        rect.top < TITLEBAR_HEIGHT && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > captionLeft

      // The conversation chrome is semantic <header>; reserving only its
      // right edge keeps the page at y=0 and moves its utilities out from
      // beneath the native caption controls.
      for (const header of document.querySelectorAll('header')) {
        if (intersectsCaption(header.getBoundingClientRect())) targets.add(header)
      }

      // Some top-level panels use a flex <div> header. Locate the compact row
      // that owns any button under the caption rectangle instead of relying on
      // CSS-module class names from one Harness build.
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
        // Fixed lightbox/dialog controls may not have a compact header row.
        // Shift just that control while leaving its full-screen parent alone.
        if (!candidate || candidate === document.body) {
          const position = getComputedStyle(button).position
          if (position === 'fixed' || position === 'absolute') {
            button.setAttribute('data-dsh-caption-shift', '')
            shiftedControls.push(button)
          }
        }
      }

      for (const element of targets) {
        element.style.setProperty('--dsh-caption-base-padding-right', getComputedStyle(element).paddingRight)
        element.setAttribute('data-dsh-caption-inset', '')
        insetContainers.push(element)
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

    const state = { hover: '', pressed: '', maximized: false }

    function applyTheme () {
      const dark = readTheme() === 'dark'
      bar.style.setProperty('--dsh-caption-fg', dark ? '#9aa4b2' : '#5f6368')
      bar.style.setProperty('--dsh-caption-hover', dark ? '#ffffff' : '#202124')
      bar.style.setProperty('--dsh-caption-hover-bg', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)')
      bar.style.setProperty('--dsh-caption-pressed-bg', dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.14)')
    }

    function applyNativeState () {
      for (const [kind, button] of Object.entries(buttons)) {
        const hovered = state.hover === kind
        const pressed = state.pressed === kind && hovered
        button.style.background = pressed
          ? (kind === 'close' ? '#c50f1f' : 'var(--dsh-caption-pressed-bg)')
          : hovered
            ? (kind === 'close' ? '#e81123' : 'var(--dsh-caption-hover-bg)')
            : 'transparent'
        button.style.color = hovered ? (kind === 'close' ? '#ffffff' : 'var(--dsh-caption-hover)') : 'var(--dsh-caption-fg)'
      }
      buttons.maximize.title = state.maximized ? '还原' : '最大化'
      buttons.maximize.replaceChildren(state.maximized ? RESTORE_ICON() : MAXIMIZE_ICON())
    }

    // Rust calls this narrow visual bridge with fixed values. It is not an IPC
    // surface: the page can style the injected nodes but cannot command the OS.
    window.__DSH_DESKTOP_CHROME__ = {
      setNativeState (next) {
        state.hover = next.hover || ''
        state.pressed = next.pressed || ''
        state.maximized = next.maximized === true
        applyNativeState()
      },
    }

    let pending = null
    const syncTheme = () => {
      if (pending !== null) return
      pending = setTimeout(() => {
        pending = null
        applyTheme()
        applyNativeState()
      }, 50)
    }
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
    })
    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
      })
    }
    applyTheme()
    applyNativeState()
    syncLayout()
  }

  function mount () {
    const html = document.documentElement
    html.style.boxSizing = 'border-box'
    html.style.height = '100%'
    if (document.body) document.body.style.boxSizing = 'border-box'

    if (IS_WINDOWS) {
      // Keep the Harness layout at the real viewport origin. The caption
      // controls float over its existing top surface instead of creating a
      // separate, theme-colored blank strip.
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
