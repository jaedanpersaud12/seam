use crate::cli::Launch;
use crate::engine::{diff, folder, text};
use crate::watch::Watch;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

/// Launch arguments waiting to be picked up by the window they were meant for.
#[derive(Default)]
pub struct Launches(pub Mutex<HashMap<String, Launch>>);

#[tauri::command]
pub fn launch_args(window: WebviewWindow, launches: State<Launches>) -> Launch {
    launches.0.lock().unwrap().remove(window.label()).unwrap_or_default()
}

#[tauri::command]
pub async fn load_file(path: String) -> Result<text::Loaded, String> {
    tauri::async_runtime::spawn_blocking(move || text::load(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_file(path: String, text: String, encoding: String, bom: bool, eol: text::Eol) -> Result<text::Loaded, String> {
    tauri::async_runtime::spawn_blocking(move || text::save(Path::new(&path), &text, &encoding, bom, eol))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn diff_texts(left: String, right: String, options: diff::DiffOptions) -> Result<diff::DiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || diff::diff(&left, &right, &options))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
struct Progress {
    job: String,
    done: usize,
    total: usize,
}

#[tauri::command]
pub async fn compare_folders(app: AppHandle, job: String, left: String, right: String, options: folder::FolderOptions) -> Result<folder::FolderResult, String> {
    let (l, r) = (PathBuf::from(&left), PathBuf::from(&right));
    if !l.is_dir() || !r.is_dir() {
        return Err("Both sides must be folders".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        folder::compare(&l, &r, &options, |done, total| {
            let _ = app.emit("folder-progress", Progress { job: job.clone(), done, total });
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    File,
    Dir,
    Missing,
}

#[derive(Serialize)]
pub struct Stat {
    kind: PathKind,
    size: u64,
}

#[tauri::command]
pub fn stat_path(path: String) -> Stat {
    match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => Stat { kind: PathKind::Dir, size: 0 },
        Ok(m) => Stat { kind: PathKind::File, size: m.len() },
        Err(_) => Stat { kind: PathKind::Missing, size: 0 },
    }
}

#[tauri::command]
pub fn watch_path(path: String, watch: State<Watch>) {
    watch.add(PathBuf::from(path));
}

#[tauri::command]
pub fn unwatch_path(path: String, watch: State<Watch>) {
    watch.remove(PathBuf::from(path));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    link: String,
    on_path: bool,
}

/// Symlinks the running binary to ~/.local/bin/seam.
#[cfg(not(unix))]
#[tauri::command]
pub fn install_cli() -> Result<Installed, String> {
    Err("On Windows, run Seam.exe <left> <right> from its install folder, or add that folder to PATH.".into())
}

/// Symlinks the running binary to ~/.local/bin/seam.
#[cfg(unix)]
#[tauri::command]
pub fn install_cli() -> Result<Installed, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let home = dirs::home_dir().ok_or("no home folder")?;
    let bin = home.join(".local/bin");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let link = bin.join("seam");
    if link.symlink_metadata().is_ok() {
        std::fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    std::os::unix::fs::symlink(&exe, &link).map_err(|e| e.to_string())?;
    // GUI apps don't inherit the login shell's PATH, so ask a login shell.
    let on_path = std::process::Command::new("/bin/zsh")
        .args(["-lc", "command -v seam"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    Ok(Installed { link: link.to_string_lossy().into_owned(), on_path })
}

/// Registers Seam as git's difftool. The UI asks before calling this.
#[tauri::command]
pub fn configure_git() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home folder")?;
    let seam = home.join(".local/bin/seam");
    let cmd = format!("\"{}\" \"$LOCAL\" \"$REMOTE\" --wait", seam.display());
    for args in [
        vec!["config", "--global", "difftool.seam.cmd", cmd.as_str()],
        vec!["config", "--global", "diff.tool", "seam"],
        vec!["config", "--global", "difftool.prompt", "false"],
    ] {
        let out = std::process::Command::new("git").args(&args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    Ok(())
}
