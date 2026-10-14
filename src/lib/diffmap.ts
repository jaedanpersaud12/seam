import type { Text } from "@codemirror/state";
import type { Chunk } from "./ipc";

export type Side = "left" | "right";

export const other = (s: Side): Side => (s === "left" ? "right" : "left");

/**
 * Maps a (fractional) line on one side to the corresponding line on the other.
 * Unchanged regions map 1:1, changed regions are stretched proportionally,
 * which is what keeps the two panes scrolling together without filler lines.
 */
export function mapLine(line: number, chunks: Chunk[], from: Side): number {
  const to = other(from);
  for (const c of chunks) {
    const [a0, a1] = c[from];
    const [b0, b1] = c[to];
    if (line < a0) return line + (b0 - a0);
    if (line < a1) return b0 + ((line - a0) / (a1 - a0)) * (b1 - b0);
  }
  const last = chunks[chunks.length - 1];
  return last ? line + (last[to][1] - last[from][1]) : line;
}

/** Index of the chunk touching `line` on `side`, or -1. Empty ranges match their insertion line. */
export function chunkAt(line: number, chunks: Chunk[], side: Side): number {
  return chunks.findIndex((c) => {
    const [s, e] = c[side];
    return s === e ? line === s || line === s - 1 : line >= s && line < e;
  });
}

/** The next (dir 1) or previous (dir -1) chunk relative to `line`, wrapping around. */
export function stepChunk(line: number, chunks: Chunk[], side: Side, dir: 1 | -1, current = -1): number {
  if (chunks.length === 0) return -1;
  if (current >= 0) return (current + dir + chunks.length) % chunks.length;
  if (dir === 1) {
    const i = chunks.findIndex((c) => c[side][0] > line);
    return i < 0 ? 0 : i;
  }
  for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i][side][0] < line) return i;
  return chunks.length - 1;
}

/** Lines [start, end) of a document as a string, without a trailing newline. */
function sliceLines(doc: Text, start: number, end: number): string {
  if (start >= end) return "";
  return doc.sliceString(doc.line(start + 1).from, doc.line(end).to);
}

/**
 * The edit that makes `dst` lines [d0, d1) read like `src` lines [s0, s1).
 * Handles pure inserts and deletes, including at the end of the document.
 */
export function copyChange(
  src: Text,
  dst: Text,
  [s0, s1]: [number, number],
  [d0, d1]: [number, number],
): { from: number; to: number; insert: string } {
  const text = sliceLines(src, s0, s1);
  const dstLines = dst.lines;

  if (d0 < d1 && s0 < s1) {
    return { from: dst.line(d0 + 1).from, to: dst.line(d1).to, insert: text };
  }
  if (d0 === d1) {
    // Insert whole lines before line d0, or append after the last line.
    if (d0 < dstLines) return { from: dst.line(d0 + 1).from, to: dst.line(d0 + 1).from, insert: text + "\n" };
    return { from: dst.length, to: dst.length, insert: "\n" + text };
  }
  // Source is empty: delete lines [d0, d1) along with one line break.
  if (d1 < dstLines) return { from: dst.line(d0 + 1).from, to: dst.line(d1 + 1).from, insert: "" };
  if (d0 > 0) return { from: dst.line(d0).to, to: dst.length, insert: "" };
  return { from: 0, to: dst.length, insert: "" };
}
