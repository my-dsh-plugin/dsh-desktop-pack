//! Native interaction for the borderless Windows title bar.
//!
//! WebView2 owns its input window in a separate process, so subclassing its
//! descendant HWNDs cannot reliably redirect mouse input to the Tao window.
//! Instead, this module puts a transparent, same-process child HWND above the
//! WebView. Its window region contains only the custom caption controls and a
//! small drag strip; all other pixels remain available to the WebView.

use std::{ffi::c_void, mem::size_of};

use tauri::WebviewWindow;
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{
            GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT, POINT,
            RECT, WPARAM,
        },
        Graphics::Gdi::{
            ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_ERROR,
            RGN_OR,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::{
                ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
            },
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
                IsZoomed, LoadCursorW, PostMessageW, RegisterClassExW, SetWindowLongPtrW,
                SetWindowPos, ShowWindow, CREATESTRUCTW, CS_DBLCLKS, GWLP_USERDATA, HTCAPTION,
                HTCLIENT, HWND_TOP, IDC_ARROW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
                SWP_NOSIZE, SWP_SHOWWINDOW, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
                WM_CAPTURECHANGED, WM_CLOSE, WM_DPICHANGED, WM_ERASEBKGND, WM_LBUTTONDBLCLK,
                WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCCREATE, WM_NCDESTROY,
                WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_PARENTNOTIFY, WM_SIZE,
                WM_WINDOWPOSCHANGED, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
            },
        },
    },
};

const OVERLAY_CLASS_NAME: PCWSTR = w!("DSH_TITLEBAR_OVERLAY");
const PARENT_SUBCLASS_ID: usize = 0x4453_4854; // "DSHT"
const CAPTION_BUTTON_HEIGHT_DIP: i32 = 32;
const CAPTION_BUTTON_WIDTH_DIP: i32 = 46;
const DRAG_STRIP_HEIGHT_DIP: i32 = 12;
// windows 0.61.x does not generate this SDK message constant.
const WM_MOUSELEAVE: u32 = 0x02A3;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum CaptionHit {
    #[default]
    None,
    Drag,
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
            Self::None | Self::Drag => "",
        }
    }
}

struct CaptionState {
    window: WebviewWindow,
    parent_hwnd: HWND,
    overlay_hwnd: HWND,
    hovered: CaptionHit,
    pressed: CaptionHit,
    maximized: bool,
    tracking_leave: bool,
}

impl CaptionState {
    fn new(window: WebviewWindow, parent_hwnd: HWND) -> Self {
        Self {
            window,
            parent_hwnd,
            overlay_hwnd: HWND::default(),
            hovered: CaptionHit::None,
            pressed: CaptionHit::None,
            maximized: unsafe { IsZoomed(parent_hwnd).as_bool() },
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

    fn set_pointer_state(&mut self, hovered: CaptionHit, pressed: CaptionHit) {
        if self.hovered == hovered && self.pressed == pressed {
            return;
        }
        self.hovered = hovered;
        self.pressed = pressed;
        self.sync();
    }

    fn clear_pointer_state(&mut self) {
        self.set_pointer_state(CaptionHit::None, CaptionHit::None);
    }

    fn refresh_maximized(&mut self) {
        let maximized = unsafe { IsZoomed(self.parent_hwnd).as_bool() };
        if self.maximized == maximized {
            return;
        }
        self.maximized = maximized;
        self.sync();
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
    if y < button_height {
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

    if y < scale_dip(DRAG_STRIP_HEIGHT_DIP, dpi) {
        CaptionHit::Drag
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

fn point_to_lparam(point: POINT) -> LPARAM {
    let x = point.x as i16 as u16 as u32;
    let y = point.y as i16 as u16 as u32;
    LPARAM((x | (y << 16)) as isize)
}

unsafe fn client_point_to_screen(hwnd: HWND, mut point: POINT) -> Option<POINT> {
    if unsafe { ClientToScreen(hwnd, &mut point) }.as_bool() {
        Some(point)
    } else {
        None
    }
}

unsafe fn overlay_hit_test(state: &CaptionState, point: POINT) -> CaptionHit {
    let mut rect = RECT::default();
    if unsafe { GetClientRect(state.parent_hwnd, &mut rect) }.is_err() {
        return CaptionHit::None;
    }
    caption_hit_test(point.x, point.y, rect.right - rect.left, unsafe {
        GetDpiForWindow(state.parent_hwnd)
    })
}

unsafe fn run_caption_action(state: &mut CaptionState, hit: CaptionHit) {
    match hit {
        CaptionHit::Minimize => {
            let _ = unsafe { ShowWindow(state.parent_hwnd, SW_MINIMIZE) };
        }
        CaptionHit::Maximize => {
            let command = if unsafe { IsZoomed(state.parent_hwnd).as_bool() } {
                SW_RESTORE
            } else {
                SW_MAXIMIZE
            };
            let _ = unsafe { ShowWindow(state.parent_hwnd, command) };
            state.refresh_maximized();
        }
        CaptionHit::Close => {
            let _ =
                unsafe { PostMessageW(Some(state.parent_hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
        CaptionHit::None | CaptionHit::Drag => {}
    }
}

unsafe fn begin_window_drag(state: &CaptionState, client_point: POINT, double_click: bool) -> bool {
    let Some(screen_point) = (unsafe { client_point_to_screen(state.overlay_hwnd, client_point) })
    else {
        return false;
    };

    let _ = unsafe { ReleaseCapture() };
    let message = if double_click {
        WM_NCLBUTTONDBLCLK
    } else {
        WM_NCLBUTTONDOWN
    };
    unsafe {
        PostMessageW(
            Some(state.parent_hwnd),
            message,
            WPARAM(HTCAPTION as usize),
            point_to_lparam(screen_point),
        )
        .is_ok()
    }
}

unsafe fn request_mouse_leave(state: &mut CaptionState) {
    if state.tracking_leave || state.overlay_hwnd == HWND::default() {
        return;
    }
    let mut event = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE,
        hwndTrack: state.overlay_hwnd,
        dwHoverTime: 0,
    };
    if unsafe { TrackMouseEvent(&mut event) }.is_ok() {
        state.tracking_leave = true;
    }
}

unsafe fn update_overlay_layout(state: &CaptionState) -> Result<(), String> {
    if state.overlay_hwnd == HWND::default() {
        return Ok(());
    }

    let mut rect = RECT::default();
    unsafe { GetClientRect(state.parent_hwnd, &mut rect) }
        .map_err(|error| format!("GetClientRect failed: {error}"))?;
    let width = (rect.right - rect.left).max(0);
    let height = (rect.bottom - rect.top).max(0);
    let dpi = unsafe { GetDpiForWindow(state.parent_hwnd) };
    let button_width = scale_dip(CAPTION_BUTTON_WIDTH_DIP, dpi);
    let button_height = scale_dip(CAPTION_BUTTON_HEIGHT_DIP, dpi).min(height);
    let drag_height = scale_dip(DRAG_STRIP_HEIGHT_DIP, dpi).min(height);
    let controls_width = button_width.saturating_mul(3);
    let button_left = width.saturating_sub(controls_width);
    let button_region = unsafe { CreateRectRgn(button_left, 0, width, button_height) };
    let interaction_region = unsafe { CreateRectRgn(0, 0, button_left, drag_height) };
    if button_region.is_invalid() || interaction_region.is_invalid() {
        if !button_region.is_invalid() {
            let _ = unsafe { DeleteObject(button_region.into()) };
        }
        if !interaction_region.is_invalid() {
            let _ = unsafe { DeleteObject(interaction_region.into()) };
        }
        return Err("CreateRectRgn failed".to_string());
    }

    let combined = unsafe {
        CombineRgn(
            Some(interaction_region),
            Some(interaction_region),
            Some(button_region),
            RGN_OR,
        )
    };
    let _ = unsafe { DeleteObject(button_region.into()) };
    if combined == RGN_ERROR {
        let _ = unsafe { DeleteObject(interaction_region.into()) };
        return Err("CombineRgn failed".to_string());
    }

    let resize_result = unsafe {
        SetWindowPos(
            state.overlay_hwnd,
            Some(HWND_TOP),
            0,
            0,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        )
    };
    if let Err(error) = resize_result {
        let _ = unsafe { DeleteObject(interaction_region.into()) };
        return Err(format!("SetWindowPos failed: {error}"));
    }

    if unsafe { SetWindowRgn(state.overlay_hwnd, Some(interaction_region), true) } == 0 {
        // SetWindowRgn takes ownership only on success.
        let _ = unsafe { DeleteObject(interaction_region.into()) };
        return Err("SetWindowRgn failed".to_string());
    }

    // A WebView2 child can be brought above its siblings during a resize. Keep
    // the input overlay at the top of the parent's child z-order afterwards.
    let _ = unsafe {
        SetWindowPos(
            state.overlay_hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOOWNERZORDER | SWP_NOSIZE | SWP_SHOWWINDOW,
        )
    };
    Ok(())
}

unsafe extern "system" fn overlay_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state_ptr = if message == WM_NCCREATE {
        let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
        let state_ptr = create.lpCreateParams as *mut CaptionState;
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize) };
        state_ptr
    } else {
        unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut CaptionState }
    };

    if state_ptr.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    let state = unsafe { &mut *state_ptr };

    match message {
        WM_NCHITTEST => LRESULT(HTCLIENT as isize),
        WM_MOUSEMOVE => {
            let hit = unsafe { overlay_hit_test(state, point_from_lparam(lparam)) };
            state.set_pointer_state(hit, state.pressed);
            if hit.is_button() || state.pressed.is_button() {
                unsafe { request_mouse_leave(state) };
            }
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_MOUSELEAVE => {
            state.tracking_leave = false;
            if state.pressed.is_button() {
                state.set_pointer_state(CaptionHit::None, state.pressed);
            } else {
                state.clear_pointer_state();
            }
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_LBUTTONDOWN => {
            let point = point_from_lparam(lparam);
            let hit = unsafe { overlay_hit_test(state, point) };
            if hit.is_button() {
                state.set_pointer_state(hit, hit);
                let _ = unsafe { SetCapture(hwnd) };
                LRESULT(0)
            } else if hit == CaptionHit::Drag && unsafe { begin_window_drag(state, point, false) } {
                LRESULT(0)
            } else {
                unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
            }
        }
        WM_LBUTTONDBLCLK => {
            let point = point_from_lparam(lparam);
            let hit = unsafe { overlay_hit_test(state, point) };
            if hit == CaptionHit::Drag && unsafe { begin_window_drag(state, point, true) } {
                LRESULT(0)
            } else {
                unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
            }
        }
        WM_LBUTTONUP if state.pressed.is_button() => {
            let released_over = unsafe { overlay_hit_test(state, point_from_lparam(lparam)) };
            let pressed = state.pressed;
            let _ = unsafe { ReleaseCapture() };
            state.set_pointer_state(released_over, CaptionHit::None);
            if released_over == pressed {
                unsafe { run_caption_action(state, pressed) };
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED if state.pressed.is_button() => {
            state.clear_pointer_state();
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_NCDESTROY => {
            state.tracking_leave = false;
            if state.overlay_hwnd == hwnd {
                state.overlay_hwnd = HWND::default();
            }
            let result = unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
            result
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe extern "system" fn parent_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    state_ptr: usize,
) -> LRESULT {
    let state = unsafe { &mut *(state_ptr as *mut CaptionState) };

    match message {
        WM_SIZE | WM_DPICHANGED => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if let Err(error) = unsafe { update_overlay_layout(state) } {
                eprintln!("[dsh-native] failed to resize titlebar overlay: {error}");
            }
            state.refresh_maximized();
            result
        }
        WM_WINDOWPOSCHANGED | WM_PARENTNOTIFY => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if state.overlay_hwnd != HWND::default() {
                let _ = unsafe {
                    SetWindowPos(
                        state.overlay_hwnd,
                        Some(HWND_TOP),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE
                            | SWP_NOMOVE
                            | SWP_NOOWNERZORDER
                            | SWP_NOSIZE
                            | SWP_SHOWWINDOW,
                    )
                };
            }
            result
        }
        WM_NCDESTROY => {
            let overlay = state.overlay_hwnd;
            if overlay != HWND::default() {
                let _ = unsafe { DestroyWindow(overlay) };
                state.overlay_hwnd = HWND::default();
            }
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            let _ = unsafe {
                RemoveWindowSubclass(hwnd, Some(parent_subclass_proc), PARENT_SUBCLASS_ID)
            };
            drop(unsafe { Box::from_raw(state_ptr as *mut CaptionState) });
            result
        }
        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

unsafe fn register_overlay_class() -> Result<HINSTANCE, String> {
    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }
        .map_err(|error| format!("GetModuleHandleW failed: {error}"))?;
    let instance: HINSTANCE = module.into();
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default();
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        style: CS_DBLCLKS,
        lpfnWndProc: Some(overlay_window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: Default::default(),
        hCursor: cursor,
        hbrBackground: Default::default(),
        lpszMenuName: PCWSTR::null(),
        lpszClassName: OVERLAY_CLASS_NAME,
        hIconSm: Default::default(),
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_CLASS_ALREADY_EXISTS {
            return Err(format!("RegisterClassExW failed: {error:?}"));
        }
    }
    Ok(instance)
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let parent_hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let instance = unsafe { register_overlay_class() }?;
    let state = Box::new(CaptionState::new(window.clone(), parent_hwnd));
    let state_ptr = Box::into_raw(state);

    let overlay_hwnd = match unsafe {
        CreateWindowExW(
            Default::default(),
            OVERLAY_CLASS_NAME,
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE,
            0,
            0,
            0,
            0,
            Some(parent_hwnd),
            None,
            Some(instance),
            Some(state_ptr as *const c_void),
        )
    } {
        Ok(hwnd) => hwnd,
        Err(error) => {
            drop(unsafe { Box::from_raw(state_ptr) });
            return Err(format!("CreateWindowExW failed: {error}"));
        }
    };
    unsafe { (*state_ptr).overlay_hwnd = overlay_hwnd };

    let installed = unsafe {
        SetWindowSubclass(
            parent_hwnd,
            Some(parent_subclass_proc),
            PARENT_SUBCLASS_ID,
            state_ptr as usize,
        )
        .as_bool()
    };
    if !installed {
        let error = std::io::Error::last_os_error();
        let _ = unsafe { DestroyWindow(overlay_hwnd) };
        drop(unsafe { Box::from_raw(state_ptr) });
        return Err(format!("SetWindowSubclass failed: {error}"));
    }

    let state = unsafe { &mut *state_ptr };
    if let Err(error) = unsafe { update_overlay_layout(state) } {
        let _ = unsafe {
            RemoveWindowSubclass(parent_hwnd, Some(parent_subclass_proc), PARENT_SUBCLASS_ID)
        };
        let _ = unsafe { DestroyWindow(overlay_hwnd) };
        drop(unsafe { Box::from_raw(state_ptr) });
        return Err(error);
    }
    state.sync();
    eprintln!(
        "[dsh-native] Windows titlebar overlay installed: parent={parent_hwnd:?} overlay={overlay_hwnd:?}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{caption_hit_test, point_from_lparam, point_to_lparam, CaptionHit};
    use windows::Win32::Foundation::POINT;

    #[test]
    fn maps_caption_buttons_and_drag_strip() {
        assert_eq!(caption_hit_test(999, 10, 1000, 96), CaptionHit::Close);
        assert_eq!(caption_hit_test(953, 10, 1000, 96), CaptionHit::Maximize);
        assert_eq!(caption_hit_test(907, 10, 1000, 96), CaptionHit::Minimize);
        assert_eq!(caption_hit_test(861, 10, 1000, 96), CaptionHit::Drag);
        assert_eq!(caption_hit_test(500, 11, 1000, 96), CaptionHit::Drag);
        assert_eq!(caption_hit_test(500, 12, 1000, 96), CaptionHit::None);
    }

    #[test]
    fn leaves_page_controls_below_the_native_regions() {
        assert_eq!(caption_hit_test(500, 31, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(999, 31, 1000, 96), CaptionHit::Close);
        assert_eq!(caption_hit_test(999, 32, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(-1, 1, 1000, 96), CaptionHit::None);
        assert_eq!(caption_hit_test(1000, 1, 1000, 96), CaptionHit::None);
    }

    #[test]
    fn scales_the_hit_regions_with_dpi() {
        assert_eq!(caption_hit_test(931, 47, 1000, 144), CaptionHit::Close);
        assert_eq!(caption_hit_test(930, 47, 1000, 144), CaptionHit::Maximize);
        assert_eq!(caption_hit_test(500, 17, 1000, 144), CaptionHit::Drag);
        assert_eq!(caption_hit_test(500, 18, 1000, 144), CaptionHit::None);
        assert_eq!(caption_hit_test(500, 48, 1000, 144), CaptionHit::None);
    }

    #[test]
    fn preserves_signed_screen_coordinates_in_lparam() {
        let point = point_from_lparam(point_to_lparam(POINT { x: -120, y: 840 }));
        assert_eq!(point.x, -120);
        assert_eq!(point.y, 840);
    }
}
