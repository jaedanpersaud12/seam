// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::IsTerminal;
use std::process::{Command, Stdio};

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let launch = match app_lib::cli::parse(std::env::args().skip(1), &cwd) {
        Ok(l) => l,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(if msg.starts_with("usage") { 0 } else { 2 });
        }
    };

    // From a terminal without --wait, hand off to a detached copy and return the prompt.
    if !cfg!(debug_assertions) && !launch.wait && std::io::stdin().is_terminal() && std::env::var_os("SEAM_DETACHED").is_none() {
        if let Ok(exe) = std::env::current_exe() {
            let mut args: Vec<String> = [&launch.left, &launch.right].into_iter().flatten().cloned().collect();
            if launch.new_window {
                args.push("--new-window".into());
            }
            let spawned = Command::new(exe)
                .args(args)
                .env("SEAM_DETACHED", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            if spawned.is_ok() {
                return;
            }
        }
    }

    app_lib::run(launch);
}
