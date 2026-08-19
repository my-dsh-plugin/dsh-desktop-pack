//! Windows custom-titlebar interaction.
//!
//! **Dragging** is handled by wry's WebView2 runtime via CSS `app-region: drag`.
//! wry calls `SetIsNonClientRegionSupportEnabled(true)` during startup, so the
//! 12-DIP transparent strip injected by desktop-chrome.js is a native drag
//! handle — no Rust code required for dragging.
//!
//! **Caption buttons** (minimize / maximize / close) are handled by this
//! HWND subclass.  It hit-tests `WM_MOUSEMOVE` for hover highlighting,
//! `WM_LBUTTONDOWN` / `WM_LBUTTONUP` for click tracking, and `WM_SIZE`
//! for the maximized/restored icon.  Visual state is pushed to the DOM
//! via `window.eval()`.
//!
//! This module does NOT use `WM_NCHITTEST` — the previous approach of
//! promoting client pixels to `HTCAPTION` / `HTMINBUTTON` etc. does not
//! work reliably with Tauri v2's WebView2 because the runtime intercepts
//! non-client messages at the COM level.

use std::mem::size_of;

use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{
            ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
        },
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetClientRect, IsZoomed, PostMessageW, ShowWindow, SW_MAXIMIZE, SW_MINIMIZE,
            SW_RESTORE, WM_CAPTURECHANGED, WM_CLOSE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSELEAVE,
            WM_MOUSEMOVE, WM_NCDESTROY, WM_SIZE,
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

    fn dom_name(self) -> &'static str {
        match self {
            Self::Minimize => "minimize",
            Self::Maximize => "maximize",
            Self::Close => "close",
            Self::None => "",
        }
    }
}

struct CaptionState {
    window: WebviewWindow,
    /// Top-level window for ShowWindow / PostMessageW.
    window_hwnd: HWND,
    hovered: CaptionHit,
    pressed: CaptionHit,
    maximized: bool,
    /// True after `TrackMouseEvent(TME_LEAVE)` has been requested so we
    /// don't request it again until the next `WM_MOUSELEAVE` resets it.
    tracking_leave: bool,
}

impl CaptionState {
    fn new(window: WebviewWindow, window_hwnd: HWND) -> Self {
        Self {
            window,
            window_hwnd,
            hovered: CaptionHit::None,
            pressed: CaptionHit::None,
            maximized: unsafe { IsZoomed(window_hwnd).as_bool() },
            tracking_leave: false,
        }
    }

    fn sync(&self) {
        let script = format!(
            "window.__DSH_DESKTOP_CHROME__?.setNativeState({{hover:{:?},pressed:{:?},maximized:{}}})",
            self.hovered.dom_name(),
            self.pressed.dom_name(),
            self.maximized,
        );
        let _ = self.window.eval(script);
    }

    fn set_hover(&mut self, hit: CaptionHit) {
        if self.hovered == hit {
            return;
        }
        self.hovered = hit;
        self.sync();
    }

    fn set_pressed(&mut self, hit: CaptionHit) {
        if self.pressed == hit && self.hovered == hit {
            return;
        }
        self.pressed = hit;
        self.hovered = hit;
        self.sync();
    }

    fn clear_state(&mut self) {
        if self.hovered == CaptionHit::None && self.pressed == CaptionHit::None {
            return;
        }
        self.hovered = CaptionHit::None;
        self.pressed = CaptionHit::None;
        self.sync();
    }

    fn refresh_maximized(&mut self) {
        let m = unsafe { IsZoomed(self.window_hwnd).as_bool() };
        if self.maximized == m {
            return;
        }
        self.maximized = m;
        self.sync();
    }
}

// ---------------------------------------------------------------------------
// Hit testing (client-area coordinates, DPI-aware)
// ---------------------------------------------------------------------------

fn scale_dip(value: i32, dpi: u32) -> i32 {
    (value * dpi.max(96) as i32 + 48) / 96
}

fn caption_hit_test(x: i32, y: i32, client_width: i32, dpi: u32) -> CaptionHit {
    let button_height = scale_dip(CAPTION_BUTTON_HEIGHT_DIP, dpi);
    let button_width = scale_dip(CAPTION_BUTTON_WIDTH_DIP, dpi);
    let distance_from_right = client_width - x;
    if y >= 0 && y < button_height && distance_from_right > 0 {
        if distance_from_right <= button_width {
            return CaptionHit::Close;
        }
        if distance_from_right <= button_width * 2 {
            return CaptionHit::Maximize;
        }
        if distance_from_right <= button_width * 3 {
            return CaptionHit::Minimize;
        }
    }
    CaptionHit::None
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

// ---------------------------------------------------------------------------
// Caption actions
// ---------------------------------------------------------------------------

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

unsafe fn request_mouse_leave(hwnd: HWND, state: &mut CaptionState) {
    if state.tracking_leave {
        return;
    }
    let mut event = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    if unsafe { TrackMouseEvent(&mut event) }.as_bool() {
        state.tracking_leave = true;
    }
}

// ---------------------------------------------------------------------------
// Subclass window procedure
// ---------------------------------------------------------------------------

unsafe extern "system" fn titlebar_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    state_ptr: usize,
) -> LRESULT {
    let state = unsafe { &mut *(state_ptr as *mut CaptionState) };

    match message {
        // ── Hover tracking (client-area WM_MOUSEMOVE) ──────────────────
        WM_MOUSEMOVE => {
            // Only hit-test the top region where the buttons live.
            let point = point_from_lparam(lparam);
            let hit = unsafe { hit_test_client_point(hwnd, point) };
            if state.pressed.is_button() {
                state.set_hover(hit);
            } else {
                state.set_hover(hit);
                if hit.is_button() {
                    unsafe { request_mouse_leave(hwnd, state) };
                }
            }
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }

        // ── Leave tracking ────────────────────────────────────────────
        WM_MOUSELEAVE => {
            state.tracking_leave = false;
            state.clear_state();
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }

        // ── Button click tracking ─────────────────────────────────────
        WM_LBUTTONDOWN => {
            let point = point_from_lparam(lparam);
            let hit = unsafe { hit_test_client_point(hwnd, point) };
            if hit.is_button() {
                state.set_pressed(hit);
                let _ = unsafe { SetCapture(hwnd) };
                LRESULT(0)
            } else {
                unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
            }
        }

        WM_LBUTTONUP if state.pressed.is_button() => {
            let released_over =
                unsafe { hit_test_client_point(hwnd, point_from_lparam(lparam)) };
            let pressed = state.pressed;
            let _ = unsafe { ReleaseCapture() };
            state.set_hover(released_over);
            state.pressed = CaptionHit::None;
            state.sync();
            if released_over == pressed {
                unsafe { run_caption_action(state.window_hwnd, pressed) };
            }
            LRESULT(0)
        }

        WM_CAPTURECHANGED if state.pressed.is_button() => {
            state.clear_state();
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }

        // ── Maximized state sync ──────────────────────────────────────
        WM_SIZE => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            state.refresh_maximized();
            result
        }

        // ── Cleanup ───────────────────────────────────────────────────
        WM_NCDESTROY => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            let _ =
                unsafe { RemoveWindowSubclass(hwnd, Some(titlebar_subclass_proc), SUBCLASS_ID) };
            drop(unsafe { Box::from_raw(state_ptr as *mut CaptionState) });
            result
        }

        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

// ---------------------------------------------------------------------------
// Public install
// ---------------------------------------------------------------------------

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let state = Box::new(CaptionState::new(window.clone(), hwnd));
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
        eprintln!("[dsh-native] Windows caption subclass installed on hwnd={hwnd:?}");
        Ok(())
    } else {
        drop(unsafe { Box::from_raw(state_ptr) });
        Err(std::io::Error::last_os_error().to_string())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    fn leaves_page_controls_below_button_area() {
        assert_eq!(caption_hit_test(500, 31, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(500, 32, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(999, 32, 1000, 96), CaptionHit::None);
    }

    #[test]
    fn scales_with_dpi() {
        let w = 1000;
        let dpi = 144;
        let bw = (46 * dpi / 96) as i32;
        // Close
        assert_eq!(caption_hit_test(w - 1, 10, w, dpi), CaptionHit::Close);
        assert_eq!(caption_hit_test(w - bw, 10, w, dpi), CaptionHit::Close);
        // Maximize
        assert_eq!(
            caption_hit_test(w - bw - 1, 10, w, dpi),
            CaptionHit::Maximize
        );
        // Minimize
        assert_eq!(
            caption_hit_test(w - bw * 2 - 1, 10, w, dpi),
            CaptionHit::Minimize
        );
        // None
        assert_eq!(
            caption_hit_test(w - bw * 3 - 1, 10, w, dpi),
            CaptionHit::None
        );
    }
}