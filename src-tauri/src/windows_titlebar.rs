use std::mem::size_of;

use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{
            ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TME_NONCLIENT,
            TRACKMOUSEEVENT,
        },
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetClientRect, IsZoomed, PostMessageW, ShowWindow, HTCAPTION, HTCLIENT, HTCLOSE,
            HTMAXBUTTON, HTMINBUTTON, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CAPTURECHANGED,
            WM_CLOSE, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN,
            WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SIZE,
        },
    },
};

const SUBCLASS_ID: usize = 0x4453_4854; // "DSHT"
const CAPTION_BUTTON_HEIGHT_DIP: i32 = 32;
const CAPTION_BUTTON_WIDTH_DIP: i32 = 46;
const DRAG_STRIP_HEIGHT_DIP: i32 = 12;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum CaptionHit {
    #[default]
    None,
    Caption,
    Minimize,
    Maximize,
    Close,
}

impl CaptionHit {
    fn from_native(value: usize) -> Self {
        match value as u32 {
            HTMINBUTTON => Self::Minimize,
            HTMAXBUTTON => Self::Maximize,
            HTCLOSE => Self::Close,
            HTCAPTION => Self::Caption,
            _ => Self::None,
        }
    }

    fn native(self) -> LRESULT {
        let value = match self {
            Self::None => HTCLIENT,
            Self::Caption => HTCAPTION,
            Self::Minimize => HTMINBUTTON,
            Self::Maximize => HTMAXBUTTON,
            Self::Close => HTCLOSE,
        };
        LRESULT(value as isize)
    }

    fn is_button(self) -> bool {
        matches!(self, Self::Minimize | Self::Maximize | Self::Close)
    }

    fn dom_name(self) -> &'static str {
        match self {
            Self::Minimize => "minimize",
            Self::Maximize => "maximize",
            Self::Close => "close",
            Self::None | Self::Caption => "",
        }
    }
}

struct NativeTitlebarState {
    window: WebviewWindow,
    hwnd: HWND,
    hovered: CaptionHit,
    pressed: CaptionHit,
    maximized: bool,
}

impl NativeTitlebarState {
    fn new(window: WebviewWindow, hwnd: HWND) -> Self {
        Self {
            window,
            hwnd,
            hovered: CaptionHit::None,
            pressed: CaptionHit::None,
            maximized: unsafe { IsZoomed(hwnd).as_bool() },
        }
    }

    fn set_pointer_state(&mut self, hovered: CaptionHit, pressed: CaptionHit) {
        if self.hovered == hovered && self.pressed == pressed {
            return;
        }
        self.hovered = hovered;
        self.pressed = pressed;
        self.sync_webview();
    }

    fn refresh_maximized(&mut self) {
        let maximized = unsafe { IsZoomed(self.hwnd).as_bool() };
        if self.maximized != maximized {
            self.maximized = maximized;
            self.sync_webview();
        }
    }

    fn sync_webview(&self) {
        // The injected controller only updates DOM styling; no Tauri API is
        // exposed to, or invoked by, the remote Harness page.
        let script = format!(
            "window.__DSH_DESKTOP_CHROME__?.setNativeState({{hover:{:?},pressed:{:?},maximized:{}}})",
            self.hovered.dom_name(),
            self.pressed.dom_name(),
            self.maximized,
        );
        let _ = self.window.eval(script);
    }
}

fn scale_dip(value: i32, dpi: u32) -> i32 {
    (value * dpi.max(96) as i32 + 48) / 96
}

fn caption_hit_test(x: i32, y: i32, client_width: i32, dpi: u32) -> CaptionHit {
    if x < 0 || x >= client_width || y < 0 {
        return CaptionHit::None;
    }

    // Harness already leaves the first 12 DIP of its top-level surfaces free:
    // the conversation header starts at y=12 and the sidebar controls start
    // lower still. Keep only that existing gap draggable so the page can paint
    // at y=0 without sacrificing its top-row controls.
    let button_height = scale_dip(CAPTION_BUTTON_HEIGHT_DIP, dpi);
    let button_width = scale_dip(CAPTION_BUTTON_WIDTH_DIP, dpi);
    let distance_from_right = client_width - x;
    if y < button_height && distance_from_right <= button_width {
        CaptionHit::Close
    } else if y < button_height && distance_from_right <= button_width * 2 {
        CaptionHit::Maximize
    } else if y < button_height && distance_from_right <= button_width * 3 {
        CaptionHit::Minimize
    } else if y < scale_dip(DRAG_STRIP_HEIGHT_DIP, dpi) {
        CaptionHit::Caption
    } else {
        CaptionHit::None
    }
}

fn point_from_lparam(lparam: LPARAM) -> POINT {
    // Mouse coordinates are signed 16-bit values packed into LPARAM. Keeping
    // the sign matters on multi-monitor layouts with negative coordinates.
    let packed = lparam.0 as u32;
    POINT {
        x: (packed as u16 as i16) as i32,
        y: ((packed >> 16) as u16 as i16) as i32,
    }
}

unsafe fn hit_test_screen_point(hwnd: HWND, lparam: LPARAM) -> CaptionHit {
    let mut point = point_from_lparam(lparam);
    if !unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
        return CaptionHit::None;
    }
    unsafe { hit_test_client_point(hwnd, point) }
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

unsafe fn track_non_client_leave(hwnd: HWND) {
    let mut event = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE | TME_NONCLIENT,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    let _ = unsafe { TrackMouseEvent(&mut event) };
}

unsafe fn run_caption_action(state: &mut NativeTitlebarState, hit: CaptionHit) {
    match hit {
        CaptionHit::Minimize => {
            let _ = unsafe { ShowWindow(state.hwnd, SW_MINIMIZE) };
        }
        CaptionHit::Maximize => {
            let command = if unsafe { IsZoomed(state.hwnd).as_bool() } {
                SW_RESTORE
            } else {
                SW_MAXIMIZE
            };
            let _ = unsafe { ShowWindow(state.hwnd, command) };
            state.refresh_maximized();
        }
        CaptionHit::Close => {
            // WM_CLOSE follows the same CloseRequested path as a native
            // caption button, so main.rs can keep "close means hide to tray".
            let _ = unsafe { PostMessageW(Some(state.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
        CaptionHit::None | CaptionHit::Caption => {}
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
    let state = unsafe { &mut *(state_ptr as *mut NativeTitlebarState) };

    match message {
        WM_NCHITTEST => {
            // Preserve resize borders and any other non-client result already
            // supplied by Tao/Winit; only promote ordinary client pixels.
            let default_result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if default_result.0 != HTCLIENT as isize {
                return default_result;
            }
            let hit = unsafe { hit_test_screen_point(hwnd, lparam) };
            if hit == CaptionHit::None {
                default_result
            } else {
                hit.native()
            }
        }
        WM_NCMOUSEMOVE => {
            let hit = CaptionHit::from_native(wparam.0);
            state.set_pointer_state(hit, state.pressed);
            unsafe { track_non_client_leave(hwnd) };
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_NCMOUSELEAVE => {
            state.set_pointer_state(CaptionHit::None, state.pressed);
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_NCLBUTTONDOWN => {
            let hit = CaptionHit::from_native(wparam.0);
            if hit.is_button() {
                // Own button tracking so behavior does not depend on a native
                // caption existing behind this decoration-less window.
                state.set_pointer_state(hit, hit);
                let _ = unsafe { SetCapture(hwnd) };
                LRESULT(0)
            } else {
                // HTCAPTION is deliberately delegated: DefWindowProc performs
                // the system move loop and standard double-click maximize.
                unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
            }
        }
        WM_MOUSEMOVE if state.pressed.is_button() => {
            let hit = unsafe { hit_test_client_point(hwnd, point_from_lparam(lparam)) };
            state.set_pointer_state(hit, state.pressed);
            LRESULT(0)
        }
        WM_LBUTTONUP if state.pressed.is_button() => {
            let released_over = unsafe { hit_test_client_point(hwnd, point_from_lparam(lparam)) };
            let pressed = state.pressed;
            let _ = unsafe { ReleaseCapture() };
            state.set_pointer_state(released_over, CaptionHit::None);
            if released_over == pressed {
                unsafe { run_caption_action(state, pressed) };
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED if state.pressed.is_button() => {
            state.set_pointer_state(CaptionHit::None, CaptionHit::None);
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_SIZE => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            state.refresh_maximized();
            result
        }
        WM_NCDESTROY => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            let _ = unsafe {
                RemoveWindowSubclass(hwnd, Some(titlebar_subclass_proc), SUBCLASS_ID)
            };
            // SetWindowSubclass holds this allocation for exactly the HWND
            // lifetime; WM_NCDESTROY is the final safe point to reclaim it.
            drop(unsafe { Box::from_raw(state_ptr as *mut NativeTitlebarState) });
            result
        }
        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let state = Box::new(NativeTitlebarState::new(window.clone(), hwnd));
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
        eprintln!("[dsh-native] Windows titlebar subclass installed");
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
        assert_eq!(caption_hit_test(861, 10, 1000, 96), CaptionHit::Caption);
    }

    #[test]
    fn leaves_page_controls_clickable_below_the_drag_strip() {
        assert_eq!(caption_hit_test(500, 11, 1000, 96), CaptionHit::Caption);
        assert_eq!(caption_hit_test(500, 12, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(500, 31, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(999, 31, 1000, 96), CaptionHit::Close);
        assert_eq!(caption_hit_test(999, 32, 1000, 96), CaptionHit::None);
    }

    #[test]
    fn scales_the_native_hit_regions_with_dpi() {
        assert_eq!(caption_hit_test(931, 47, 1000, 144), CaptionHit::Close);
        assert_eq!(caption_hit_test(930, 47, 1000, 144), CaptionHit::Maximize);
        assert_eq!(caption_hit_test(500, 17, 1000, 144), CaptionHit::Caption);
        assert_eq!(caption_hit_test(500, 18, 1000, 144), CaptionHit::None);
        assert_eq!(caption_hit_test(500, 48, 1000, 144), CaptionHit::None);
    }
}
