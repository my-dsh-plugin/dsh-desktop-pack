// Desktop chrome injected into the main webview on macOS only.
//
// The window keeps the native overlay traffic lights (TitleBarStyle::Overlay),
// so the page reserves a 32px strip at the top for them (and for the AppKit
// drag monitor in main.rs, `install_native_strip_drag`). Windows uses the
// ordinary native title bar — minimize/maximize/close and dragging are
// provided by the OS — and receives no injection.
(() => {
  'use strict'

  const TITLEBAR_HEIGHT = 32

  function mount () {
    const html = document.documentElement
    html.style.boxSizing = 'border-box'
    html.style.height = '100%'
    if (document.body) document.body.style.boxSizing = 'border-box'
    html.style.paddingTop = TITLEBAR_HEIGHT + 'px'
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()