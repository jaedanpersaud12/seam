pub mod cli;
mod commands;
pub mod engine;
mod watch;

use cli::Launch;
use commands::Launches;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

static WINDOWS: AtomicUsize = AtomicUsize::new(0);

fn open_window(app: &AppHandle, launch: Launch) -> tauri::Result<()> {
    let n = WINDOWS.fetch_add(1, Ordering::Relaxed);
    let label = if n == 0 { "main".to_string() } else { format!("w{n}") };
    app.state::<Launches>().0.lock().unwrap().insert(label.clone(), launch);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Seam")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0);
    // macOS: toolbar under the traffic lights, with vibrancy behind the chrome.
    #[cfg(target_os = "macos")]
    let builder = {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::{Effect, EffectState};
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 23.0))
            .transparent(true)
            .effects(WindowEffectsConfig {
                effects: vec![Effect::Sidebar],
                state: Some(EffectState::FollowsWindowActiveState),
                radius: None,
                color: None,
                ..Default::default()
            })
    };
    builder.build()?;
    Ok(())
}

/// Sends a launch to an existing window as a new tab, or opens a window for it.
fn route(app: &AppHandle, launch: Launch) {
    let target = if launch.new_window { None } else { app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| app.webview_windows().into_values().next()) };
    match target {
        Some(w) => {
            let _ = w.emit_to(w.label(), "open-launch", launch);
            let _ = w.set_focus();
        }
        None => {
            let _ = open_window(app, launch);
        }
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, acc: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, text);
        match acc {
            Some(a) => b.accelerator(a).build(app),
            None => b.build(app),
        }
    };
    let app_menu = SubmenuBuilder::new(app, "Seam")
        .item(&PredefinedMenuItem::about(app, Some("About Seam"), None)?)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?);
    #[cfg(unix)]
    let app_menu = app_menu.item(&item("install-cli", "Install Command Line Tool…", None)?);
    #[cfg(target_os = "macos")]
    let app_menu = app_menu
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?);
    let app_menu = app_menu.separator().item(&PredefinedMenuItem::quit(app, None)?).build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-tab", "New Comparison", Some("CmdOrCtrl+T"))?)
        .item(&item("new-window", "New Window", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save-all", "Save Both", Some("CmdOrCtrl+Alt+S"))?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("palette", "Command Palette", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&item("next-change", "Next Change", Some("F8"))?)
        .item(&item("prev-change", "Previous Change", Some("F7"))?)
        .item(&item("copy-to-right", "Copy Change to Right", Some("CmdOrCtrl+]"))?)
        .item(&item("copy-to-left", "Copy Change to Left", Some("CmdOrCtrl+["))?)
        .separator()
        .item(&item("rescan", "Rescan", Some("CmdOrCtrl+R"))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

pub fn run(launch: Launch) {
    let mut builder = tauri::Builder::default();
    // A --wait launch must own its own process so the shell blocks on it.
    if !launch.wait {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Ok(l) = cli::parse(argv.into_iter().skip(1), std::path::Path::new(&cwd)) {
                route(app, l);
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(Launches::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(watch::Watch::new(handle.clone()));
            app.set_menu(menu(&handle)?)?;
            app.on_menu_event(|app, ev| {
                let id = ev.id().0.clone();
                if id == "new-window" {
                    let _ = open_window(app, Launch::default());
                    return;
                }
                if let Some(w) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
                    let _ = w.emit_to(w.label(), "menu", id);
                }
            });
            open_window(&handle, launch.clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::launch_args,
            commands::load_file,
            commands::save_file,
            commands::diff_texts,
            commands::compare_folders,
            commands::stat_path,
            commands::watch_path,
            commands::unwatch_path,
            commands::install_cli,
            commands::configure_git,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Seam");
}
