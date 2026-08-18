#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tauri_plugin_dialog::DialogExt;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

struct ManagerProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

struct RuntimePaths {
    node: PathBuf,
    manager: PathBuf,
    data_home: Option<PathBuf>,
}

fn resolve_runtime_paths() -> Option<RuntimePaths> {
    if let Ok(root) = env::var("DSH_DESKTOP_ROOT") {
        let root = PathBuf::from(root);
        return Some(RuntimePaths {
            node: if cfg!(target_os = "windows") {
                root.join("runtime").join("node").join("node.exe")
            } else {
                root.join("runtime").join("node").join("bin").join("node")
            },
            manager: root.join("runtime").join("app").join("manager.mjs"),
            data_home: None,
        });
    }

    let exe = env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        let manager = ancestor.join("runtime").join("app").join("manager.mjs");
        if manager.exists() {
            return Some(RuntimePaths {
                node: if cfg!(target_os = "windows") {
                    ancestor.join("runtime").join("node").join("node.exe")
                } else {
                    ancestor.join("runtime").join("node").join("bin").join("node")
                },
                manager,
                data_home: None,
            });
        }
    }

    #[cfg(target_os = "macos")]
    {
        let app_bundle = exe.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app"))?;
        let resources = app_bundle.join("Contents").join("Resources");
        let home = env::var("HOME").ok()?;
        let data_home = PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("dsh-desktop")
            .join("dsh-home");
        return Some(RuntimePaths {
            node: resources.join("runtime").join("node").join("bin").join("node"),
            manager: resources.join("runtime").join("app").join("manager.mjs"),
            data_home: Some(data_home),
        });
    }

    #[allow(unreachable_code)]
    None
}

/// Desktop-chrome injection for the main webview: a 32px draggable top strip
/// (overlay title bar with macOS traffic lights / Windows caption buttons),
/// plus a Windows-only mirror of the page's resolved theme into the window
/// theme. The page's own theme stays authoritative: the script only reads
/// `color-scheme` / `body[data-ds-dark-theme]` and never writes page state.
///
/// Dragging & double-click-zoom rely on Tauri's built-in `data-tauri-drag-region`
/// handling (drag.js), which talks to the shell via `window.__TAURI_INTERNALS__`.
/// The harness UI is served over http://127.0.0.1 (a remote origin), so the
/// shell grants those window commands through a remote ACL capability — see
/// `capabilities/desktop-shell.json` (`desktop-shell-titlebar-remote`).
fn desktop_chrome_script() -> String {
    include_str!("../chrome/desktop-chrome.js")
        .replace("__DSH_DESKTOP_SYNC_WINDOW_THEME__", if cfg!(target_os = "windows") { "true" } else { "false" })
}

/// Install a native event monitor that turns clicks in the window's top strip
/// (the injected chrome strip) into real window dragging.
///
/// Why not page->IPC->Rust? The harness UI runs at http://127.0.0.1 (remote
/// origin); in this app the Tauri IPC bridge does not reach the shell from
/// remote pages (verified with a diagnostic probe), so no amount of ACL
/// configuration can carry `start_dragging` from the page. Instead we watch
/// mouse events natively: when a left-mouse-down lands inside the top 32px of
/// the window (right of the traffic lights), we hand the REAL event to
/// `performWindowDragWithEvent:` — the classic AppKit custom-titlebar recipe.
/// Double-click in that area performs the standard zoom.
#[cfg(target_os = "macos")]
fn install_native_strip_drag(window: &tauri::WebviewWindow) {
    use block2::RcBlock;
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSWindow};
    use objc2_foundation::{MainThreadMarker, NSInteger, NSRect};

    let Ok(ptr) = window.ns_window() else {
        eprintln!("[dsh-native] ns_window() failed");
        return;
    };
    unsafe {
        let _marker = MainThreadMarker::new_unchecked();
        let ns_window: *mut NSWindow = ptr.cast();
        let window_number: NSInteger = msg_send![ns_window, windowNumber];
        let strip_height: f64 = 32.0;
        // Keep the native traffic lights (left ~72pt) clickable.
        let left_gutter: f64 = 76.0;

        let block = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            let ev = event.as_ref();
            if ev.windowNumber() != window_number {
                return event.as_ptr();
            }
            if ev.r#type() != NSEventType::LeftMouseDown {
                return event.as_ptr();
            }
            let loc = ev.locationInWindow();
            let frame: NSRect = msg_send![ns_window, frame];
            if loc.y < frame.size.height - strip_height || loc.x < left_gutter {
                return event.as_ptr();
            }
            if ev.clickCount() >= 2 {
                let _: () = msg_send![ns_window, performZoom: None::<&AnyObject>];
            } else {
                let _: () = msg_send![ns_window, performWindowDragWithEvent: ev];
            }
            // Swallow the event so the webview never sees it.
            std::ptr::null_mut()
        });

        let monitor = NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown,
            &block,
        );
        if let Some(monitor) = monitor {
            // Keep the monitor alive for the lifetime of the app.
            std::mem::forget(monitor);
            eprintln!("[dsh-native] strip drag monitor installed (window {window_number})");
        } else {
            eprintln!("[dsh-native] failed to install event monitor");
        }
    }
}

fn spawn_manager(paths: &RuntimePaths) -> std::io::Result<Child> {
    let mut command = Command::new(&paths.node);
    command
        .arg(&paths.manager)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(data_home) = &paths.data_home {
        if env::var_os("DSH_HOME").is_none() {
            command.env("DSH_HOME", data_home);
        }
    }
    command.spawn()
}

fn main() {
    let paths = resolve_runtime_paths().expect("cannot resolve manager runtime; set DSH_DESKTOP_ROOT");
    eprintln!("[shell] manager: {}", paths.manager.display());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(ManagerProcess {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
        })
        .setup(move |app| {
            let mut child = spawn_manager(&paths)?;
            let stdin = child.stdin.take().expect("manager stdin");
            let stdout = child.stdout.take().expect("manager stdout");
            {
                let state = app.state::<ManagerProcess>();
                *state.child.lock().unwrap() = Some(child);
                *state.stdin.lock().unwrap() = Some(stdin);
            }

            let port = Arc::new(Mutex::new(None::<u16>));
            let port_for_reader = port.clone();
            let port_for_navigation = port.clone();
            let window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DeepSeek Harness Desktop")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(&desktop_chrome_script());
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .decorations(true)
                .title_bar_style(TitleBarStyle::Overlay);
            #[cfg(target_os = "windows")]
            let window_builder = window_builder
                .decorations(false)
                .minimizable(true)
                .maximizable(true)
                .closable(true);
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let window_builder = window_builder.decorations(true);
            let window = window_builder
                .on_navigation(move |url| {
                    url.host_str() == Some("127.0.0.1")
                        && url.port() == port_for_navigation.lock().unwrap().as_ref().copied()
                })
                .build()?;
            #[cfg(target_os = "macos")]
            install_native_strip_drag(&window);
            let reader_window = window.clone();

            let tray_window = window.clone();
            let open_item = MenuItemBuilder::with_id("open", "打开主界面").build(app)?;
            let diag_item = MenuItemBuilder::with_id("diag", "故障排查").build(app)?;
            let update_item = MenuItemBuilder::with_id("check-update", "检查更新").build(app)?;
            let restart_item = MenuItemBuilder::with_id("restart", "重启").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&open_item)
                .item(&diag_item)
                .item(&update_item)
                .item(&restart_item)
                .separator()
                .item(&quit_item)
                .build()?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().expect("default window icon"))
                .tooltip("DeepSeek Harness Desktop")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "check-update" => {
                        let state = app.state::<ManagerProcess>();
                        let mut guard = state.stdin.lock().unwrap();
                        if let Some(stdin) = guard.as_mut() {
                            let _ = writeln!(stdin, "{{\"type\":\"check-update\"}}");
                        }
                    }
                    "diag" => {
                        let state = app.state::<ManagerProcess>();
                        let mut guard = state.stdin.lock().unwrap();
                        if let Some(stdin) = guard.as_mut() {
                            let _ = writeln!(stdin, "{{\"type\":\"diag\"}}");
                        }
                    }
                    "restart" => app.restart(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            let tray_window_for_close = tray_window.clone();
            tray_window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = tray_window_for_close.hide();
                }
            });

            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(trimmed) {
                        Ok(Value::Object(mut object)) => {
                            let event_type = object.remove("type").and_then(|v| v.as_str().map(str::to_owned));
                            match event_type.as_deref() {
                                Some("ready") => {
                                    let url = object.get("url").and_then(|v| v.as_str()).unwrap_or("").to_owned();
                                    if let Ok(parsed) = url::Url::parse(&url) {
                                        if parsed.host_str() == Some("127.0.0.1") {
                                            if let Some(p) = parsed.port() {
                                                *port_for_reader.lock().unwrap() = Some(p);
                                            }
                                        }
                                    }
                                    if let Ok(parsed) = url::Url::parse(&url) {
                                        let _ = reader_window.navigate(parsed);
                                    }
                                }
                                Some("update") => {
                                    let current = object.get("current").and_then(|v| v.as_str()).unwrap_or("?").to_owned();
                                    let latest = object.get("latest").and_then(|v| v.as_str()).unwrap_or("?").to_owned();
                                    let available = object.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
                                    if available {
                                        eprintln!("[shell] update available: {current} -> {latest}");
                                        let body = object.get("body").and_then(|v| v.as_str()).unwrap_or("").chars().take(1200).collect::<String>();
                                        let message = format!("发现新版本 {latest}\n当前版本 {current}\n\n{body}");
                                        let handle = reader_window.app_handle().clone();
                                        tauri::async_runtime::spawn(async move {
                                            handle.dialog().message(message).title("DeepSeek Harness Desktop 更新").show(|_| {});
                                        });
                                    }
                                }
                                Some("diag") => {
                                    let url = object.get("url").and_then(|v| v.as_str()).unwrap_or("").to_owned();
                                    if let Ok(parsed) = url::Url::parse(&url) {
                                        if parsed.host_str() == Some("127.0.0.1") {
                                            if let Some(p) = parsed.port() {
                                                *port_for_reader.lock().unwrap() = Some(p);
                                            }
                                        }
                                    }
                                    let _ = reader_window.show();
                                    let _ = reader_window.set_focus();
                                    if let Ok(parsed) = url::Url::parse(&url) {
                                        let _ = reader_window.navigate(parsed);
                                    }
                                }
                                Some("fatal") => {
                                    let message = object.get("message").and_then(|v| v.as_str()).unwrap_or("unknown");
                                    let _ = reader_window.eval(&format!(
                                        "document.body.innerHTML = '<h2>启动失败</h2><pre></pre>'; document.querySelector('pre').textContent = {message:?};"
                                    ));
                                    break;
                                }
                                _ => {}
                            }
                        }
                        Ok(_) => {}
                        Err(error) => eprintln!("[shell] bad manager line: {error}"),
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                    let state = app_handle.state::<ManagerProcess>();
                    let mut guard = state.child.lock().unwrap();
                    if let Some(child) = guard.as_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                _ => {}
            }
        });
}
