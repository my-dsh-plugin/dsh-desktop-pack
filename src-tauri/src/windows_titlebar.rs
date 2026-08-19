//! Windows caption-button safety net.
//!
//! Window dragging is handled by the WebView2 runtime via CSS `app-region: drag`
//! (enabled by wry through `SetIsNonClientRegionSupportEnabled`).  Caption button
//! clicks are handled by JavaScript in desktop-chrome.js via `window.__TAURI__`.
//!
//! This module is a **fallback** that catches `WM_LBUTTONDOWN` / `WM_LBUTTONUP`
//! in the caption button region and `WM_SIZE` for the maximized/restored icon.
//! It activates only when the JavaScript IPC path is unavailable; when JS is
//! working normally the button clicks never reach this proc because the DOM
//! elements consume them.

use std::mem::size_of;

use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{ReleaseCapture, SetCapture},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetClientRect, IsZoomed, PostMessageW, ShowWindow, HTCAPTION, HTCLOSE, HTMAXBUTTON,
            HTMINBUTTON, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CAPTURECHANGED, WM_CLOSE,
            WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_SIZE,
        },
    },
};

const SUBCLASS_ID: usize = 0x4453_4854; // "DSHT"
const CAPTION_BUTTON_HEIGHT_DIP: i32 = 32;
const CAPTION_BUTTON_WIDTH_DIP: i32 = 46;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum CaptionHit {
    #[default]
    None,
    Minimize,
    Maximize,
    Close,
}

impl CaptionHit {
    fn is_button(self) -> bool {
        matches!(self, Self::Minimize | Self::Maximize | Self::Close)
    }
}

struct FallbackState {
    window: WebviewWindow,
    window_hwnd: HWND,
    subclass_hwnd: HWND,
    pressed: Option<CaptionHit>,
    maximized: bool,
}

impl FallbackState {
    fn new(window: WebviewWindow, window_hwnd: HWND, subclass_hwnd: HWND) -> Self {
        Self {
            window,
            window_hwnd,
            subclass_hwnd,
            pressed: None,
            maximized: unsafe { IsZoomed(window_hwnd).as_bool() },
        }
    }

    fn sync_maximized(&mut self) {
        let maximized = unsafe { IsZoomed(self.window_hwnd).as_bool() };
        if self.maximized == maximized {
            return;
        }
        self.maximized = maximized;
        let _ = self.window.eval(&format!(
            "window.__DSH_DESKTOP_CHROME__?.setNativeState({{maximized:{}}})",
            maximized
        ));
    }
}

fn scale_dip(value: i32, dpi: u32) -> i32 {
    (value * dpi.max(96) as i32 + 48) / 96
}

fn caption_hit_test(x: i32, y: i32, client_width: i32, dpi: u32) -> CaptionHit {
    if x < 0 || x >= client_width || y < 0 {
        return CaptionHit::None;
    }
    let button_height = scale_dip(CAPTION_BUTTON_HEIGHT_DIP, dpi);
    let button_width = scale_dip(CAPTION_BUTTON_WIDTH_DIP, dpi);
    let distance_from_right = client_width - x;
    if y < button_height && distance_from_right <= button_width {
        CaptionHit::Close
    } else if y < button_height && distance_from_right <= button_width * 2 {
        CaptionHit::Maximize
    } else if y < button_height && distance_from_right <= button_width * 3 {
        CaptionHit::Minimize
    } else {
        CaptionHit::None
    }
}

fn point_from_lparam(lparam: LPARAM) -> POINT {
    let packed = lparam.0 as u32;
    POINT {
        x: (packed as u16 as i16) as i32,
        y: ((packed >> 16) as u16 as i16) as i32,
    }
}

unsafe fn hit_test_client_point(hwnd: HWND, point: POINT) -> CaptionHit {
    let mut rect = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() {
        return CaptionHit::None;
    }
    caption_hit_test(
        point.x,
        point.y,
        rect.right - rect.left,
        unsafe { GetDpiForWindow(hwnd) },
    )
}

unsafe fn run_caption_action(hwnd: HWND, hit: CaptionHit) {
    match hit {
        CaptionHit::Minimize => {
            let _ = unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
        }
        CaptionHit::Maximize => {
            let command = if unsafe { IsZoomed(hwnd).as_bool() } {
                SW_RESTORE
            } else {
                SW_MAXIMIZE
            };
            let _ = unsafe { ShowWindow(hwnd, command) };
        }
        CaptionHit::Close => {
            let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
        CaptionHit::None => {}
    }
}

unsafe extern "system" fn titlebar_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    state_ptr: usize,
) -> LRESULT {
    let state = unsafe { &mut *(state_ptr as *mut FallbackState) };

    match message {
        // --- Fallback button interaction (only fires when JS IPC is unavailable) ---
        WM_LBUTTONDOWN => {
            let point = point_from_lparam(lparam);
            let hit = unsafe { hit_test_client_point(hwnd, point) };
            if hit.is_button() {
                state.pressed = Some(hit);
                let _ = unsafe { SetCapture(hwnd) };
                return LRESULT(0);
            }
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_MOUSEMOVE if state.pressed.is_some() => {
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_LBUTTONUP if state.pressed.is_some() => {
            let released_over =
                unsafe { hit_test_client_point(hwnd, point_from_lparam(lparam)) };
            let pressed = state.pressed.take().unwrap();
            let _ = unsafe { ReleaseCapture() };
            if released_over == pressed {
                unsafe { run_caption_action(state.window_hwnd, pressed) };
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED if state.pressed.is_some() => {
            state.pressed = None;
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }

        // --- Maximized state tracking ---
        WM_SIZE => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            state.sync_maximized();
            result
        }

        // --- Cleanup ---
        WM_NCDESTROY => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            let _ =
                unsafe { RemoveWindowSubclass(hwnd, Some(titlebar_subclass_proc), SUBCLASS_ID) };
            drop(unsafe { Box::from_raw(state_ptr as *mut FallbackState) });
            result
        }

        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let parent_hwnd = window.hwnd().map_err(|error| error.to_string())?;

    // Always subclass the window that actually receives the messages.
    let hwnd = parent_hwnd;

    let state = Box::new(FallbackState::new(window.clone(), parent_hwnd, hwnd));
    let state_ptr = Box::into_raw(state);
    let installed = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(titlebar_subclass_proc),
            SUBCLASS_ID,
            state_ptr as usize,
        )
        .as_bool()
    };
    if installed {
        eprintln!("[dsh-native] Windows caption fallback subclass installed on hwnd={hwnd:?}");
        Ok(())
    } else {
        drop(unsafe { Box::from_raw(state_ptr) });
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{caption_hit_test, CaptionHit};

    #[test]
    fn maps_caption_buttons_from_the_right_edge() {
        assert_eq!(caption_hit_test(999, 10, 1000, 96), CaptionHit::Close);
        assert_eq!(caption_hit_test(953, 10, 1000, 96), CaptionHit::Maximize);
        assert_eq!(caption_hit_test(907, 10, 1000, 96), CaptionHit::Minimize);
        assert_eq!(caption_hit_test(861, 10, 1000, 96), CaptionHit::None);
    }

    #[test]
    fn leaves_page_controls_clickable_below_the_button_area() {
        assert_eq!(caption_hit_test(500, 31, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(500, 32, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(999, 32, 1000, 96), CaptionHit::None);
    }
}