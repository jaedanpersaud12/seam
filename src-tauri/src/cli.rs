//! Command-line arguments: `seam <left> <right> [--wait] [--new-window]`.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub left: Option<String>,
    pub right: Option<String>,
    pub wait: bool,
    pub new_window: bool,
}

pub const USAGE: &str = "usage: seam [<left> [<right>]] [--wait] [--new-window]\n\n  \
  Compares two files or two folders.\n  \
  --wait        block until the comparison is closed (for git difftool)\n  \
  --new-window  open in a new window instead of a tab";

fn absolute(p: &str, cwd: &Path) -> String {
    let path = PathBuf::from(p);
    let abs = if path.is_absolute() { path } else { cwd.join(path) };
    abs.canonicalize().unwrap_or(abs).to_string_lossy().into_owned()
}

/// Parses argv (without the program name). Returns Err(message) for --help or bad flags.
pub fn parse<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Result<Launch, String> {
    let mut l = Launch::default();
    let mut paths = Vec::new();
    for a in args {
        match a.as_str() {
            "--wait" | "-w" => l.wait = true,
            "--new-window" | "-n" => l.new_window = true,
            "-h" | "--help" => return Err(USAGE.into()),
            // macOS passes this when launched from Finder; ignore it.
            s if s.starts_with("-psn_") => {}
            s if s.starts_with('-') => return Err(format!("unknown option {s}\n\n{USAGE}")),
            s => paths.push(absolute(s, cwd)),
        }
    }
    if paths.len() > 2 {
        return Err(format!("expected at most two paths\n\n{USAGE}"));
    }
    let mut it = paths.into_iter();
    l.left = it.next();
    l.right = it.next();
    Ok(l)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paths_and_flags() {
        let l = parse(["a.txt", "/b.txt", "--wait"].map(String::from), Path::new("/tmp/x")).unwrap();
        assert_eq!(l.left.as_deref(), Some("/tmp/x/a.txt"));
        assert_eq!(l.right.as_deref(), Some("/b.txt"));
        assert!(l.wait && !l.new_window);
    }

    #[test]
    fn rejects_unknown_and_extra() {
        assert!(parse(["--nope".into()], Path::new("/")).is_err());
        assert!(parse(["a", "b", "c"].map(String::from), Path::new("/")).is_err());
    }
}
