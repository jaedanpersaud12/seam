//! Folder comparison: walk both trees, pair entries, classify each one.

use super::diff::{diff, DiffOptions};
use super::text::{modified_ms, read_text};
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

/// Files above this size are compared by content hash only, never as text.
const TEXT_COMPARE_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderOptions {
    pub diff: DiffOptions,
    pub respect_gitignore: bool,
    pub excludes: Vec<String>,
}

impl Default for FolderOptions {
    fn default() -> Self {
        Self {
            diff: DiffOptions::default(),
            respect_gitignore: false,
            excludes: [".git", "node_modules", "target", ".DS_Store"].map(String::from).to_vec(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Identical,
    Equivalent,
    Different,
    LeftOnly,
    RightOnly,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Meta {
    pub size: u64,
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Relative path with `/` separators.
    pub path: String,
    pub name: String,
    pub depth: usize,
    pub is_dir: bool,
    pub status: Status,
    pub left: Option<Meta>,
    pub right: Option<Meta>,
    pub binary: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub identical: usize,
    pub equivalent: usize,
    pub different: usize,
    pub left_only: usize,
    pub right_only: usize,
    pub error: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResult {
    pub left_root: String,
    pub right_root: String,
    pub entries: Vec<Entry>,
    /// File counts only; folders are summaries of their files.
    pub counts: Counts,
}

#[derive(Clone, Copy)]
struct Side {
    is_dir: bool,
    meta: Meta,
}

fn walk(root: &Path, opts: &FolderOptions) -> BTreeMap<String, Side> {
    let excludes = opts.excludes.clone();
    let mut out = BTreeMap::new();
    let walker = WalkBuilder::new(root)
        .standard_filters(false)
        .hidden(false)
        .git_ignore(opts.respect_gitignore)
        .git_exclude(opts.respect_gitignore)
        .parents(opts.respect_gitignore)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |e| !excludes.iter().any(|x| e.file_name() == x.as_str()))
        .build();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let Ok(meta) = entry.metadata() else { continue };
        out.insert(rel, Side { is_dir: meta.is_dir(), meta: Meta { size: meta.len(), modified: modified_ms(&meta) } });
    }
    out
}

fn hash_file(p: &Path) -> std::io::Result<blake3::Hash> {
    let mut h = blake3::Hasher::new();
    let mut f = fs::File::open(p)?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize())
}

fn looks_binary(p: &Path) -> bool {
    let mut buf = [0u8; 8000];
    fs::File::open(p)
        .and_then(|mut f| f.read(&mut buf))
        .map(|n| super::text::is_binary(&buf[..n]))
        .unwrap_or(false)
}

/// Compares two files that exist on both sides. Returns (status, binary).
pub fn compare_files(a: &Path, b: &Path, sa: u64, sb: u64, opts: &DiffOptions) -> (Status, bool) {
    if sa == sb {
        match (hash_file(a), hash_file(b)) {
            (Ok(x), Ok(y)) if x == y => return (Status::Identical, false),
            (Err(_), _) | (_, Err(_)) => return (Status::Error, false),
            _ => {}
        }
    }
    let binary = looks_binary(a) || looks_binary(b);
    if binary || opts.is_exact() || sa.max(sb) > TEXT_COMPARE_LIMIT {
        return (Status::Different, binary);
    }
    // Under ignore options, a byte difference may still be an equivalent file.
    match (read_text(a), read_text(b)) {
        (Some((ta, ea)), Some((tb, eb))) => {
            let eol_differs = ea != eb && !opts.ignore_eol;
            if !eol_differs && diff(&ta, &tb, opts).equivalent {
                (Status::Equivalent, false)
            } else {
                (Status::Different, false)
            }
        }
        _ => (Status::Different, true),
    }
}

/// Tree order: at each level folders first, then case-insensitive by name.
fn tree_order(a: &Entry, b: &Entry) -> Ordering {
    let pa: Vec<&str> = a.path.split('/').collect();
    let pb: Vec<&str> = b.path.split('/').collect();
    for i in 0..pa.len().min(pb.len()) {
        let da = i + 1 < pa.len() || a.is_dir;
        let db = i + 1 < pb.len() || b.is_dir;
        let ord = db.cmp(&da).then_with(|| pa[i].to_lowercase().cmp(&pb[i].to_lowercase())).then_with(|| pa[i].cmp(pb[i]));
        if ord != Ordering::Equal {
            return ord;
        }
    }
    pa.len().cmp(&pb.len())
}

pub fn compare(left: &Path, right: &Path, opts: &FolderOptions, progress: impl Fn(usize, usize) + Sync) -> FolderResult {
    let (lw, rw) = rayon::join(|| walk(left, opts), || walk(right, opts));

    let mut keys: Vec<&String> = lw.keys().chain(rw.keys()).collect();
    keys.sort();
    keys.dedup();

    let total = keys.len();
    let done = AtomicUsize::new(0);

    let mut entries: Vec<Entry> = keys
        .par_iter()
        .map(|k| {
            let l = lw.get(*k);
            let r = rw.get(*k);
            let is_dir = l.or(r).map(|s| s.is_dir).unwrap_or(false);
            let (status, binary) = match (l, r) {
                (Some(_), None) => (Status::LeftOnly, false),
                (None, Some(_)) => (Status::RightOnly, false),
                (Some(a), Some(b)) if a.is_dir != b.is_dir => (Status::Different, false),
                (Some(_), Some(_)) if is_dir => (Status::Identical, false),
                (Some(a), Some(b)) => {
                    let lp: PathBuf = left.join(k.as_str());
                    let rp: PathBuf = right.join(k.as_str());
                    compare_files(&lp, &rp, a.meta.size, b.meta.size, &opts.diff)
                }
                (None, None) => unreachable!(),
            };
            let n = done.fetch_add(1, AtomicOrdering::Relaxed) + 1;
            if n % 200 == 0 || n == total {
                progress(n, total);
            }
            Entry {
                name: k.rsplit('/').next().unwrap_or(k).to_owned(),
                depth: k.matches('/').count(),
                path: (*k).clone(),
                is_dir,
                status,
                left: l.map(|s| s.meta),
                right: r.map(|s| s.meta),
                binary,
            }
        })
        .collect();

    // Folders present on both sides summarize their descendants.
    let worst: BTreeMap<String, Status> = {
        let mut m: BTreeMap<String, Status> = BTreeMap::new();
        for e in entries.iter().filter(|e| !e.is_dir || e.status != Status::Identical) {
            let mut p = e.path.as_str();
            while let Some(i) = p.rfind('/') {
                p = &p[..i];
                let cur = m.entry(p.to_owned()).or_insert(Status::Identical);
                *cur = match (*cur, e.status) {
                    (Status::Different, _) => Status::Different,
                    (_, Status::Identical) => *cur,
                    (Status::Identical, Status::Equivalent) => Status::Equivalent,
                    (s, Status::Equivalent) => s,
                    _ => Status::Different,
                };
            }
        }
        m
    };
    for e in entries.iter_mut() {
        if e.is_dir && e.status == Status::Identical {
            if let Some(s) = worst.get(&e.path) {
                e.status = *s;
            }
        }
    }

    entries.sort_by(tree_order);

    let mut counts = Counts::default();
    for e in entries.iter().filter(|e| !e.is_dir) {
        match e.status {
            Status::Identical => counts.identical += 1,
            Status::Equivalent => counts.equivalent += 1,
            Status::Different => counts.different += 1,
            Status::LeftOnly => counts.left_only += 1,
            Status::RightOnly => counts.right_only += 1,
            Status::Error => counts.error += 1,
        }
    }

    FolderResult {
        left_root: left.to_string_lossy().into_owned(),
        right_root: right.to_string_lossy().into_owned(),
        entries,
        counts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::diff::Whitespace;
    use std::fs::{create_dir_all, write};

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let (l, r) = (t.path().join("l"), t.path().join("r"));
        for d in [&l, &r] {
            create_dir_all(d.join("src/deep")).unwrap();
            create_dir_all(d.join("node_modules/x")).unwrap();
            write(d.join("same.txt"), "same\n").unwrap();
            write(d.join("node_modules/x/a.js"), "1").unwrap();
        }
        write(l.join("src/a.rs"), "fn a() {}\n").unwrap();
        write(r.join("src/a.rs"), "fn a() { }\n").unwrap();
        write(l.join("src/deep/ws.txt"), "a b\n").unwrap();
        write(r.join("src/deep/ws.txt"), "a  b\n").unwrap();
        write(l.join("only-left.md"), "x").unwrap();
        create_dir_all(r.join("new")).unwrap();
        write(r.join("new/file.txt"), "y").unwrap();
        (t, l, r)
    }

    fn status(r: &FolderResult, p: &str) -> Status {
        r.entries.iter().find(|e| e.path == p).unwrap_or_else(|| panic!("missing {p}")).status
    }

    #[test]
    fn classifies_entries_and_folders() {
        let (_t, l, r) = fixture();
        let res = compare(&l, &r, &FolderOptions::default(), |_, _| {});
        assert_eq!(status(&res, "same.txt"), Status::Identical);
        assert_eq!(status(&res, "src/a.rs"), Status::Different);
        assert_eq!(status(&res, "src"), Status::Different);
        assert_eq!(status(&res, "only-left.md"), Status::LeftOnly);
        assert_eq!(status(&res, "new"), Status::RightOnly);
        assert_eq!(status(&res, "new/file.txt"), Status::RightOnly);
        assert!(res.entries.iter().all(|e| !e.path.starts_with("node_modules")));
        assert_eq!(res.counts.different, 2);
    }

    #[test]
    fn whitespace_option_yields_equivalent() {
        let (_t, l, r) = fixture();
        let opts = FolderOptions {
            diff: DiffOptions { whitespace: Whitespace::Change, ..Default::default() },
            ..Default::default()
        };
        let res = compare(&l, &r, &opts, |_, _| {});
        assert_eq!(status(&res, "src/deep/ws.txt"), Status::Equivalent);
        assert_eq!(status(&res, "src/deep"), Status::Equivalent);
        assert_eq!(status(&res, "src/a.rs"), Status::Different);
    }

    #[test]
    fn folders_sort_before_files() {
        let (_t, l, r) = fixture();
        let res = compare(&l, &r, &FolderOptions::default(), |_, _| {});
        let paths: Vec<&str> = res.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths[0], "new");
        assert!(paths.iter().position(|p| *p == "src").unwrap() < paths.iter().position(|p| *p == "only-left.md").unwrap());
        assert!(paths.iter().position(|p| *p == "src/deep").unwrap() < paths.iter().position(|p| *p == "src/a.rs").unwrap());
    }
}
