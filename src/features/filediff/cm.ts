import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Side } from "../../lib/diffmap";
import type { Chunk } from "../../lib/ipc";

// ── Diff decorations ────────────────────────────────────────────────────────

export type DiffPayload = { chunks: Chunk[]; current: number };

export const setDiff = StateEffect.define<DiffPayload>();

class Bar extends GutterMarker {
  readonly kind: string;
  constructor(kind: string) {
    super();
    this.kind = kind;
  }
  eq(other: Bar) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `seam-bar ${this.kind}`;
    return el;
  }
}
const BARS = { add: new Bar("add"), del: new Bar("del"), mod: new Bar("mod") };

type Built = { decos: DecorationSet; bars: RangeSet<GutterMarker> };

function build(state: EditorState, side: Side, { chunks, current }: DiffPayload): Built {
  const doc = state.doc;
  const lines: { line: number; cls: string; bar?: keyof typeof BARS }[] = [];
  const marks: { from: number; to: number; cls: string }[] = [];

  chunks.forEach((c, i) => {
    const [s, e] = c[side];
    const kind = c.kind === "replace" ? "mod" : side === "left" ? "del" : "add";
    const cur = i === current ? " seam-line-current" : "";
    if (s === e) {
      // Nothing on this side: draw a hairline where the other side's lines would go.
      const gapKind = c.kind === "insert" ? "add" : "del";
      if (s < doc.lines) lines.push({ line: s, cls: `seam-gap-top ${gapKind}${cur}` });
      else if (doc.lines > 0) lines.push({ line: doc.lines - 1, cls: `seam-gap-bottom ${gapKind}${cur}` });
      return;
    }
    for (let l = s; l < e && l < doc.lines; l++) lines.push({ line: l, cls: `seam-line-${kind}${cur}`, bar: kind });
    for (const p of c.inline) {
      const line = side === "left" ? p.leftLine : p.rightLine;
      if (line >= doc.lines) continue;
      const from = doc.line(line + 1).from;
      const max = doc.line(line + 1).to;
      for (const [a, b] of side === "left" ? p.left : p.right) {
        const f = Math.min(from + a, max);
        const tt = Math.min(from + b, max);
        if (tt > f) marks.push({ from: f, to: tt, cls: "seam-ch-mod" });
      }
    }
  });

  const db = new RangeSetBuilder<Decoration>();
  const bb = new RangeSetBuilder<GutterMarker>();
  // Line decorations and marks must be added in document order.
  const all = [
    ...lines.map((l) => ({ pos: doc.line(l.line + 1).from, line: l })),
    ...marks.map((m) => ({ pos: m.from, mark: m })),
  ].sort((a, b) => a.pos - b.pos || ("line" in a ? -1 : 1));
  for (const item of all) {
    if ("line" in item && item.line) {
      db.add(item.pos, item.pos, Decoration.line({ class: item.line.cls }));
    } else if ("mark" in item && item.mark) {
      db.add(item.mark.from, item.mark.to, Decoration.mark({ class: item.mark.cls }));
    }
  }
  for (const l of lines) if (l.bar) bb.add(doc.line(l.line + 1).from, doc.line(l.line + 1).from, BARS[l.bar]);
  return { decos: db.finish(), bars: bb.finish() };
}

function diffField(side: Side) {
  return StateField.define<Built>({
    create: () => ({ decos: Decoration.none, bars: RangeSet.empty }),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setDiff)) return build(tr.state, side, e.value);
      // Keep stale decorations attached to the right text until the next diff lands.
      return tr.docChanged ? { decos: value.decos.map(tr.changes), bars: value.bars.map(tr.changes) } : value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });
}

// ── Syntax highlighting (muted so diff colours stay loudest) ─────────────────

const muted = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-fn)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.tagName, t.heading], color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-prop)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syn-comment)" },
  { tag: t.invalid, color: "var(--bad)" },
]);

const LANGS: Record<string, () => Promise<LanguageSupport>> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  mts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
};

export async function languageFor(path: string | null): Promise<LanguageSupport | null> {
  const ext = path?.split(".").pop()?.toLowerCase() ?? "";
  const loader = LANGS[ext];
  return loader ? loader().catch(() => null) : null;
}

// ── Editor setup ────────────────────────────────────────────────────────────

export type PaneConfig = {
  side: Side;
  doc: string;
  readOnly: boolean;
  placeholder?: string;
  onDocChange: () => void;
  onFocus: () => void;
  onCursor: (line: number, col: number) => void;
};

export const language = new Compartment();
export const editable = new Compartment();

export function createPane(parent: HTMLElement, cfg: PaneConfig): EditorView {
  const field = diffField(cfg.side);
  const extensions: Extension[] = [
    field,
    lineNumbers(),
    gutter({
      class: "seam-bar-gutter",
      markers: (v) => v.state.field(field).bars,
    }),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    search({ top: false }),
    highlightSelectionMatches(),
    syntaxHighlighting(muted),
    language.of([]),
    cfg.placeholder ? placeholder(cfg.placeholder) : [],
    editable.of([EditorState.readOnly.of(cfg.readOnly), EditorView.editable.of(!cfg.readOnly)]),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorState.tabSize.of(4),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) cfg.onDocChange();
      if (u.focusChanged && u.view.hasFocus) cfg.onFocus();
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        cfg.onCursor(line.number, head - line.from + 1);
      }
    }),
  ];
  return new EditorView({ parent, state: EditorState.create({ doc: cfg.doc, extensions }) });
}
