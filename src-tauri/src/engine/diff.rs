//! Line diff with word-then-character refinement inside changed lines.
//!
//! Line numbers are 0-based and match CodeMirror's: the text is split on `\n`,
//! so a trailing newline yields a final empty line. Inline ranges are UTF-16
//! offsets within a line, because that's what the editor indexes by.

use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffTag};
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Alg {
    #[default]
    Patience,
    Myers,
    Histogram,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Whitespace {
    #[default]
    Exact,
    /// Ignore whitespace at line ends.
    Trailing,
    /// Treat any run of whitespace as one space.
    Change,
    /// Ignore all whitespace.
    All,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffOptions {
    pub algorithm: Alg,
    pub whitespace: Whitespace,
    pub ignore_case: bool,
    pub ignore_eol: bool,
}

impl DiffOptions {
    pub fn is_exact(&self) -> bool {
        self.whitespace == Whitespace::Exact && !self.ignore_case && !self.ignore_eol
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Insert,
    Delete,
    Replace,
}

/// A run of inline changes for one pair of lines.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinePair {
    pub left_line: usize,
    pub right_line: usize,
    pub left: Vec<[u32; 2]>,
    pub right: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub kind: Kind,
    /// [start, end) line range on each side; empty for pure inserts/deletes.
    pub left: [usize; 2],
    pub right: [usize; 2],
    pub inline: Vec<LinePair>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub chunks: Vec<Chunk>,
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
    /// Byte-for-byte the same text.
    pub identical: bool,
    /// No differences under the current options.
    pub equivalent: bool,
    pub left_lines: usize,
    pub right_lines: usize,
}

fn line_key<'a>(line: &'a str, opts: &DiffOptions) -> Cow<'a, str> {
    let mut s: Cow<str> = Cow::Borrowed(line);
    if opts.ignore_eol {
        if let Some(stripped) = s.strip_suffix('\r') {
            s = Cow::Owned(stripped.to_owned());
        }
    }
    s = match opts.whitespace {
        Whitespace::Exact => s,
        Whitespace::Trailing => Cow::Owned(s.trim_end().to_owned()),
        Whitespace::Change => {
            let mut out = String::with_capacity(s.len());
            let mut in_ws = false;
            for c in s.trim_end().chars() {
                if c.is_whitespace() {
                    in_ws = true;
                } else {
                    if in_ws {
                        out.push(' ');
                    }
                    in_ws = false;
                    out.push(c);
                }
            }
            Cow::Owned(out)
        }
        Whitespace::All => Cow::Owned(s.chars().filter(|c| !c.is_whitespace()).collect()),
    };
    if opts.ignore_case {
        s = Cow::Owned(s.to_lowercase());
    }
    s
}

fn algorithm(a: Alg) -> Algorithm {
    match a {
        Alg::Patience => Algorithm::Patience,
        Alg::Myers => Algorithm::Myers,
        Alg::Histogram => Algorithm::Histogram,
    }
}

pub fn diff(left: &str, right: &str, opts: &DiffOptions) -> DiffResult {
    let l: Vec<&str> = left.split('\n').collect();
    let r: Vec<&str> = right.split('\n').collect();
    let lk: Vec<Cow<str>> = l.iter().map(|s| line_key(s, opts)).collect();
    let rk: Vec<Cow<str>> = r.iter().map(|s| line_key(s, opts)).collect();

    let ops = capture_diff_slices(algorithm(opts.algorithm), &lk, &rk);

    let mut chunks: Vec<Chunk> = Vec::new();
    for op in ops {
        let (tag, a, b) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        // Merge touching delete+insert into a single replace.
        if let Some(prev) = chunks.last_mut() {
            if prev.left[1] == a.start && prev.right[1] == b.start {
                prev.left[1] = a.end;
                prev.right[1] = b.end;
                prev.kind = Kind::Replace;
                continue;
            }
        }
        let kind = match tag {
            DiffTag::Insert => Kind::Insert,
            DiffTag::Delete => Kind::Delete,
            _ => Kind::Replace,
        };
        chunks.push(Chunk { kind, left: [a.start, a.end], right: [b.start, b.end], inline: vec![] });
    }

    let (mut added, mut removed, mut changed) = (0, 0, 0);
    for c in &mut chunks {
        if c.left[0] == c.left[1] {
            c.kind = Kind::Insert;
        } else if c.right[0] == c.right[1] {
            c.kind = Kind::Delete;
        }
        match c.kind {
            Kind::Insert => added += c.right[1] - c.right[0],
            Kind::Delete => removed += c.left[1] - c.left[0],
            Kind::Replace => {
                changed += 1;
                c.inline = pair_lines(&l, &r, c, opts);
            }
        }
    }

    DiffResult {
        equivalent: chunks.is_empty(),
        identical: left == right,
        chunks,
        added,
        removed,
        changed,
        left_lines: l.len(),
        right_lines: r.len(),
    }
}

/// Pairs lines inside a replace chunk positionally and highlights what changed.
fn pair_lines(l: &[&str], r: &[&str], c: &Chunk, opts: &DiffOptions) -> Vec<LinePair> {
    let n = (c.left[1] - c.left[0]).min(c.right[1] - c.right[0]);
    (0..n)
        .filter_map(|i| {
            let (li, ri) = (c.left[0] + i, c.right[0] + i);
            let (left, right) = inline(l[li], r[ri], opts)?;
            Some(LinePair { left_line: li, right_line: ri, left, right })
        })
        .collect()
}

fn tokenize(s: &str) -> Vec<&str> {
    #[derive(PartialEq, Clone, Copy)]
    enum C {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_alphanumeric() || c == '_' {
            C::Word
        } else if c.is_whitespace() {
            C::Space
        } else {
            C::Other
        }
    };
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<C> = None;
    for (i, ch) in s.char_indices() {
        let k = class(ch);
        if let Some(p) = prev {
            if p != k || k == C::Other {
                out.push(&s[start..i]);
                start = i;
            }
        }
        prev = Some(k);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn push_range(v: &mut Vec<[u32; 2]>, from: u32, to: u32) {
    if from >= to {
        return;
    }
    if let Some(last) = v.last_mut() {
        if last[1] == from {
            last[1] = to;
            return;
        }
    }
    v.push([from, to]);
}

/// Returns highlighted ranges on each side, or None when the lines are too
/// different for intra-line highlights to help (the whole line reads as changed).
fn inline(a: &str, b: &str, opts: &DiffOptions) -> Option<(Vec<[u32; 2]>, Vec<[u32; 2]>)> {
    let ta = tokenize(a);
    let tb = tokenize(b);
    let key = |t: &&str| -> String {
        if opts.ignore_case { t.to_lowercase() } else { (*t).to_owned() }
    };
    let ka: Vec<String> = ta.iter().map(key).collect();
    let kb: Vec<String> = tb.iter().map(key).collect();
    let ops = capture_diff_slices(Algorithm::Myers, &ka, &kb);

    // Offsets of each token in UTF-16 units.
    let offsets = |toks: &[&str]| {
        let mut acc = 0u32;
        let mut v = Vec::with_capacity(toks.len() + 1);
        for t in toks {
            v.push(acc);
            acc += utf16_len(t);
        }
        v.push(acc);
        v
    };
    let oa = offsets(&ta);
    let ob = offsets(&tb);

    let skip_ws = opts.whitespace != Whitespace::Exact;
    let all_ws = |toks: &[&str]| toks.iter().all(|t| t.chars().all(char::is_whitespace));

    let (mut ra, mut rb) = (Vec::new(), Vec::new());
    let mut same = 0u32;
    for op in ops {
        let (tag, x, y) = op.as_tag_tuple();
        match tag {
            DiffTag::Equal => same += oa[x.end] - oa[x.start],
            _ => {
                if skip_ws && all_ws(&ta[x.clone()]) && all_ws(&tb[y.clone()]) {
                    continue;
                }
                let sa: String = ta[x.clone()].concat();
                let sb: String = tb[y.clone()].concat();
                // Refine short word swaps down to characters ("color" -> "colour").
                if tag == DiffTag::Replace && sa.len() <= 40 && sb.len() <= 40 {
                    if let Some((ca, cb, common)) = chars(&sa, &sb, opts) {
                        ca.iter().for_each(|r| push_range(&mut ra, oa[x.start] + r[0], oa[x.start] + r[1]));
                        cb.iter().for_each(|r| push_range(&mut rb, ob[y.start] + r[0], ob[y.start] + r[1]));
                        same += common;
                        continue;
                    }
                }
                push_range(&mut ra, oa[x.start], oa[x.end]);
                push_range(&mut rb, ob[y.start], ob[y.end]);
            }
        }
    }

    let total = utf16_len(a).max(utf16_len(b)).max(1);
    if (same as f32) / (total as f32) < 0.3 {
        return None;
    }
    Some((ra, rb))
}

/// Character-level diff of a short replaced span; None if it isn't mostly shared.
fn chars(a: &str, b: &str, opts: &DiffOptions) -> Option<(Vec<[u32; 2]>, Vec<[u32; 2]>, u32)> {
    let ca: Vec<char> = a.chars().collect();
    let cb: Vec<char> = b.chars().collect();
    let norm = |c: &char| if opts.ignore_case { c.to_lowercase().next().unwrap_or(*c) } else { *c };
    let ka: Vec<char> = ca.iter().map(norm).collect();
    let kb: Vec<char> = cb.iter().map(norm).collect();
    let ops = capture_diff_slices(Algorithm::Myers, &ka, &kb);

    let u16 = |cs: &[char], i: usize| cs[..i].iter().map(|c| c.len_utf16() as u32).sum::<u32>();
    let (mut ra, mut rb) = (Vec::new(), Vec::new());
    let mut common = 0u32;
    for op in ops {
        let (tag, x, y) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            common += u16(&ca, x.end) - u16(&ca, x.start);
        } else {
            push_range(&mut ra, u16(&ca, x.start), u16(&ca, x.end));
            push_range(&mut rb, u16(&cb, y.start), u16(&cb, y.end));
        }
    }
    let longest = ca.len().max(cb.len()).max(1) as f32;
    if (common as f32) / longest < 0.5 {
        return None;
    }
    Some((ra, rb, common))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(a: &str, b: &str) -> DiffResult {
        diff(a, b, &DiffOptions::default())
    }

    #[test]
    fn identical_text_has_no_chunks() {
        let r = d("a\nb\n", "a\nb\n");
        assert!(r.identical && r.equivalent);
        assert!(r.chunks.is_empty());
        assert_eq!(r.left_lines, 3);
    }

    #[test]
    fn classifies_insert_delete_replace() {
        let r = d("a\nb\nc", "a\nB\nc\nd");
        assert_eq!(r.chunks.len(), 2);
        assert_eq!(r.chunks[0].kind, Kind::Replace);
        assert_eq!(r.chunks[0].left, [1, 2]);
        assert_eq!(r.chunks[1].kind, Kind::Insert);
        assert_eq!(r.chunks[1].left, [3, 3]);
        assert_eq!(r.chunks[1].right, [3, 4]);
        assert_eq!((r.added, r.removed, r.changed), (1, 0, 1));
    }

    #[test]
    fn refines_word_to_characters() {
        let r = d("let color = 1;", "let colour = 1;");
        let p = &r.chunks[0].inline[0];
        assert!(p.left.is_empty());
        assert_eq!(p.right, vec![[8, 9]]);
    }

    #[test]
    fn highlights_whole_word_when_unrelated() {
        let r = d("call(alpha, x)", "call(omega, x)");
        let p = &r.chunks[0].inline[0];
        assert_eq!(p.left, vec![[5, 10]]);
        assert_eq!(p.right, vec![[5, 10]]);
    }

    #[test]
    fn inline_offsets_are_utf16() {
        let r = d("😀 a", "😀 b");
        assert_eq!(r.chunks[0].inline[0].left, vec![[3, 4]]);
    }

    #[test]
    fn whitespace_and_case_options() {
        let o = DiffOptions { whitespace: Whitespace::All, ..Default::default() };
        let r = diff("a  b\n", "a b \n", &o);
        assert!(r.equivalent && !r.identical);

        let o = DiffOptions { ignore_case: true, ..Default::default() };
        assert!(diff("Hello", "hello", &o).equivalent);

        let o = DiffOptions { whitespace: Whitespace::Trailing, ..Default::default() };
        assert!(!diff("a b", "ab", &o).equivalent);
        assert!(diff("ab  ", "ab", &o).equivalent);
    }

    #[test]
    fn patience_aligns_moved_braces() {
        let a = "fn a() {\n  1\n}\n\nfn b() {\n  2\n}\n";
        let b = "fn b() {\n  2\n}\n\nfn a() {\n  1\n}\n";
        let r = d(a, b);
        assert!(!r.equivalent);
        assert!(r.chunks.iter().all(|c| c.left[1] <= r.left_lines));
    }
}
