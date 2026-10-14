import type { EditorView } from "@codemirror/view";
import { mapLine, type Side } from "../../lib/diffmap";
import type { Chunk } from "../../lib/ipc";

/** Distance between the scroller's scrollTop origin and the document's top (content padding). */
export function docOffset(view: EditorView): number {
  return view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
}

/** Fractional 0-based line at a document height. */
export function lineAtHeight(view: EditorView, h: number): number {
  const doc = view.state.doc;
  if (h <= 0) return 0;
  const block = view.lineBlockAtHeight(h);
  const line = doc.lineAt(block.from).number - 1;
  if (h >= block.bottom && line === doc.lines - 1) return doc.lines;
  return line + Math.min(1, Math.max(0, (h - block.top) / Math.max(1, block.height)));
}

/** Document height of the top edge of a fractional 0-based line (doc.lines = bottom of the last line). */
export function heightAtLine(view: EditorView, l: number): number {
  const doc = view.state.doc;
  if (l >= doc.lines) return view.lineBlockAt(doc.length).bottom;
  const i = Math.max(0, Math.floor(l));
  const block = view.lineBlockAt(doc.line(i + 1).from);
  return block.top + (l - i) * block.height;
}

/** Scrolls `follower` so the line facing the leader's middle sits at its middle too. */
export function syncScroll(leader: EditorView, follower: EditorView, chunks: Chunk[], from: Side) {
  const ls = leader.scrollDOM;
  const fs = follower.scrollDOM;
  const mid = ls.scrollTop + ls.clientHeight / 2 - docOffset(leader);
  const line = lineAtHeight(leader, mid);
  const target = heightAtLine(follower, mapLine(line, chunks, from)) + docOffset(follower) - fs.clientHeight / 2;
  // At the very top and bottom keep both panes pinned to their edges.
  const top = ls.scrollTop <= 0 ? 0 : ls.scrollTop >= ls.scrollHeight - ls.clientHeight - 1 ? fs.scrollHeight : target;
  fs.scrollTop = top;
  fs.scrollLeft = ls.scrollLeft;
}

export type Ribbon = {
  index: number;
  kind: Chunk["kind"];
  /** Top and bottom y on each side, relative to the scroller's top edge. */
  l: [number, number];
  r: [number, number];
};

function sideY(view: EditorView, [s, e]: [number, number]): [number, number] {
  const off = docOffset(view) - view.scrollDOM.scrollTop;
  return [heightAtLine(view, s) + off, heightAtLine(view, e) + off];
}

export function ribbons(left: EditorView, right: EditorView, chunks: Chunk[]): Ribbon[] {
  const hl = left.scrollDOM.clientHeight;
  const hr = right.scrollDOM.clientHeight;
  const out: Ribbon[] = [];
  chunks.forEach((c, index) => {
    const l = sideY(left, c.left);
    const r = sideY(right, c.right);
    const visible = (l[1] >= 0 && l[0] <= hl) || (r[1] >= 0 && r[0] <= hr);
    if (visible) out.push({ index, kind: c.kind, l, r });
  });
  return out;
}

/** Unified 0..1 position of the visible range, combining both sides. */
export function viewportFraction(left: EditorView, right: EditorView, chunks: Chunk[]): [number, number] {
  const total = Math.max(1, left.state.doc.lines + right.state.doc.lines);
  const s = left.scrollDOM;
  const off = docOffset(left);
  const top = lineAtHeight(left, s.scrollTop - off);
  const bot = lineAtHeight(left, s.scrollTop + s.clientHeight - off);
  const u = (l: number) => (l + mapLine(l, chunks, "left")) / total;
  return [Math.max(0, u(top)), Math.min(1, u(bot))];
}

/** Inverse of the unified position: the left line whose unified position is f. */
export function leftLineAt(f: number, leftLines: number, rightLines: number, chunks: Chunk[]): number {
  const want = f * (leftLines + rightLines);
  let lo = 0;
  let hi = leftLines;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (mid + mapLine(mid, chunks, "left") < want) lo = mid;
    else hi = mid;
  }
  return lo;
}
