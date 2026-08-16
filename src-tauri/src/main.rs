use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

struct ManagerProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

fn resolve_package_root() -> Option<PathBuf> {
    if let Ok(root) = env::var("DSH_DESKTOP_ROOT") {
        return Some(PathBuf::from(root));
    }
    let exe = env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        let runtime = ancestor.join("runtime").join("app").join("manager.mjs");
        if runtime.exists() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

fn spawn_manager(root: &PathBuf) -> std::io::Result<Child> {
    let node = if cfg!(target_os = "windows") {
        root.join("runtime").join("node").join("node.exe")
    } else {
        root.join("runtime").join("node").join("bin").join("node")
    };
    let manager = root.join("runtime").join("app").join("manager.mjs");
    Command::new(node)
        .arg(manager)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
}

fn main() {
    let root = resolve_package_root().expect("cannot resolve package root; set DSH_DESKTOP_ROOT");
    eprintln!("[shell] package root: {}", root.display());

    tauri::Builder::default()
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
            let mut child = spawn_manager(&root)?;
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
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DSH Desktop")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 640.0)
                .on_navigation(move |url| {
                    url.host_str() == Some("127.0.0.1")
                        && url.port() == port_for_navigation.lock().unwrap().as_ref().copied()
                })
                .build()?;
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
                .tooltip("DSH Desktop")
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
                                    let _ = reader_window.eval(&format!("window.location.replace({url:?});"));
                                }
                                Some("update") => {
                                    let current = object.get("current").and_then(|v| v.as_str()).unwrap_or("?");
                                    let latest = object.get("latest").and_then(|v| v.as_str()).unwrap_or("?");
                                    let available = object.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
                                    if available {
                                        eprintln!("[shell] update available: {current} -> {latest}");
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
                                    let _ = reader_window.eval(&format!("window.location.replace({url:?});"));
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
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                let state = app_handle.state::<ManagerProcess>();
                let mut guard = state.child.lock().unwrap();
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
