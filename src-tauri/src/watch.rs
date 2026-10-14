//! Watches open files so tabs can react when they change on disk.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct Changed {
    path: String,
}

pub struct Watch {
    watcher: Mutex<Option<RecommendedWatcher>>,
    counts: Mutex<HashMap<PathBuf, usize>>,
}

impl Watch {
    pub fn new(app: AppHandle) -> Self {
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if ev.kind.is_access() {
                return;
            }
            for p in ev.paths {
                let _ = app.emit("file-changed", Changed { path: p.to_string_lossy().into_owned() });
            }
        })
        .ok();
        Self { watcher: Mutex::new(watcher), counts: Mutex::new(HashMap::new()) }
    }

    pub fn add(&self, path: PathBuf) {
        let mut counts = self.counts.lock().unwrap();
        let n = counts.entry(path.clone()).or_insert(0);
        *n += 1;
        if *n == 1 {
            if let Some(w) = self.watcher.lock().unwrap().as_mut() {
                let _ = w.watch(&path, RecursiveMode::NonRecursive);
            }
        }
    }

    pub fn remove(&self, path: PathBuf) {
        let mut counts = self.counts.lock().unwrap();
        if let Some(n) = counts.get_mut(&path) {
            *n -= 1;
            if *n == 0 {
                counts.remove(&path);
                if let Some(w) = self.watcher.lock().unwrap().as_mut() {
                    let _ = w.unwatch(&path);
                }
            }
        }
    }
}
