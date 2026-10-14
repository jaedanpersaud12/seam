//! Loading and saving text files: binary sniffing, encoding detection, line endings.
//!
//! The editor always works on `\n`-separated text. We remember what the file
//! looked like on disk (encoding, BOM, line endings) so a save writes it back the same way.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

const SNIFF: usize = 8000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
    Mixed,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub path: String,
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: Eol,
    pub binary: bool,
    pub size: u64,
    pub hash: String,
    pub modified: Option<u64>,
    pub readonly: bool,
}

pub fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

pub fn is_binary(bytes: &[u8]) -> bool {
    if Encoding::for_bom(bytes).is_some() {
        return false;
    }
    bytes[..bytes.len().min(SNIFF)].contains(&0)
}

/// Decodes bytes, returning (text, encoding name, had BOM).
pub fn decode(bytes: &[u8]) -> (String, &'static Encoding, bool) {
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return (text.into_owned(), enc, true);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), UTF_8, false),
        Err(_) => {
            let (text, _) = WINDOWS_1252.decode_without_bom_handling(bytes);
            (text.into_owned(), WINDOWS_1252, false)
        }
    }
}

/// Converts every line ending to `\n` and reports what was there.
pub fn normalize_eol(text: &str) -> (String, Eol) {
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                crlf += 1;
                out.push('\n');
            }
            '\r' => {
                cr += 1;
                out.push('\n');
            }
            '\n' => {
                lf += 1;
                out.push('\n');
            }
            c => out.push(c),
        }
    }
    let eol = match (lf > 0, crlf > 0, cr > 0) {
        (false, false, false) => Eol::None,
        (true, false, false) => Eol::Lf,
        (false, true, false) => Eol::Crlf,
        (false, false, true) => Eol::Cr,
        _ => Eol::Mixed,
    };
    (out, eol)
}

pub fn load(path: &Path) -> Result<Loaded, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("{}: {e}", path.display()))?;

    let hash = blake3::hash(&bytes).to_hex().to_string();
    let base = Loaded {
        path: path.to_string_lossy().into_owned(),
        text: String::new(),
        encoding: String::new(),
        bom: false,
        eol: Eol::None,
        binary: false,
        size: meta.len(),
        hash,
        modified: modified_ms(&meta),
        readonly: meta.permissions().readonly(),
    };

    if is_binary(&bytes) {
        return Ok(Loaded { binary: true, ..base });
    }
    let (raw, enc, bom) = decode(&bytes);
    let (text, eol) = normalize_eol(&raw);
    Ok(Loaded { text, encoding: enc.name().to_owned(), bom, eol, ..base })
}

/// Reads a file as normalized text for comparison purposes, or None if binary.
pub fn read_text(path: &Path) -> Option<(String, Eol)> {
    let bytes = fs::read(path).ok()?;
    if is_binary(&bytes) {
        return None;
    }
    let (raw, _, _) = decode(&bytes);
    Some(normalize_eol(&raw))
}

fn encode(text: &str, encoding: &str, bom: bool) -> Vec<u8> {
    let enc = Encoding::for_label(encoding.as_bytes()).unwrap_or(UTF_8);
    let mut out = Vec::with_capacity(text.len() + 3);
    // encoding_rs only decodes UTF-16, so encode it by hand.
    if enc == UTF_16LE || enc == UTF_16BE {
        let le = enc == UTF_16LE;
        if bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return out;
    }
    if bom && enc == UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    let (bytes, _, _) = enc.encode(text);
    out.extend_from_slice(&bytes);
    out
}

pub fn save(path: &Path, text: &str, encoding: &str, bom: bool, eol: Eol) -> Result<Loaded, String> {
    let sep = match eol {
        Eol::Crlf => "\r\n",
        Eol::Cr => "\r",
        _ => "\n",
    };
    let body = if sep == "\n" { text.to_owned() } else { text.replace('\n', sep) };
    let bytes = encode(&body, encoding, bom);

    // Write next to the target then rename, so a crash never leaves half a file.
    let dir = path.parent().ok_or("file has no parent folder")?;
    let name = path.file_name().ok_or("bad file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.seam-tmp"));
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    load(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_line_endings() {
        assert_eq!(normalize_eol("a\r\nb\r\n"), ("a\nb\n".into(), Eol::Crlf));
        assert_eq!(normalize_eol("a\nb"), ("a\nb".into(), Eol::Lf));
        assert_eq!(normalize_eol("a\r\nb\n").1, Eol::Mixed);
        assert_eq!(normalize_eol("abc").1, Eol::None);
    }

    #[test]
    fn sniffs_binary_but_not_utf16() {
        assert!(is_binary(b"PNG\0\0\x01"));
        assert!(!is_binary(&[0xFF, 0xFE, b'a', 0]));
        assert!(!is_binary(b"plain text"));
    }

    #[test]
    fn decodes_latin1_fallback() {
        let (text, enc, _) = decode(&[b'c', b'a', b'f', 0xE9]);
        assert_eq!(text, "café");
        assert_eq!(enc, WINDOWS_1252);
    }

    #[test]
    fn round_trips_crlf_utf16() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.txt");
        save(&p, "héllo\nworld\n", "UTF-16LE", true, Eol::Crlf).unwrap();
        let back = load(&p).unwrap();
        assert_eq!(back.text, "héllo\nworld\n");
        assert_eq!(back.eol, Eol::Crlf);
        assert_eq!(back.encoding, "UTF-16LE");
        assert!(back.bom);
    }
}
