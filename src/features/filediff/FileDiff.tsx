import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { animate, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { commandBus, useTabs } from "../../app/tabs";
import { useSettings } from "../../app/settings";
import { CollapsibleBanner } from "../../components/interior/collapsible-banner";
import { ContextMenu, type ContextMenuItem } from "../../components/interior/context-menu";
import { chunkAt, copyChange, other, stepChunk, type Side } from "../../lib/diffmap";
import { basename, ipc, type DiffResult, type Loaded } from "../../lib/ipc";
import { BinaryCard } from "./BinaryCard";
import { createPane, languageFor, language, setDiff } from "./cm";
import { docOffset, heightAtLine, leftLineAt, ribbons as computeRibbons, syncScroll, viewportFraction, type Ribbon } from "./geometry";
import { Overview } from "./Overview";
import { PaneHeader } from "./PaneHeader";
import { Seam, SEAM_WIDTH } from "./Seam";
import { StatusBar } from "./StatusBar";

const LARGE = 50 * 1024 * 1024;
const SPRING = { type: "spring", stiffness: 260, damping: 36, mass: 0.9 } as const;

/** A missing side (e.g. a file that only exists in one folder) compares against empty text. */
const EMPTY = (path: string | null): Loaded => ({
  path: path ?? "",
  text: "",
  encoding: "UTF-8",
  bom: false,
  eol: "lf",
  binary: false,
  size: 0,
  hash: "",
  modified: null,
  readonly: true,
});

type Phase =
  | { kind: "loading" }
  | { kind: "large"; sizes: [number, number] }
  | { kind: "binary" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

/** `scratch` compares pasted text: both sides start empty and editable, nothing is saved. */
type Props = { tabId: string; left: string | null; right: string | null; active: boolean; scratch?: boolean };

export function FileDiff({ tabId, left, right, active, scratch = false }: Props) {
  const options = useSettings((s) => s.diff);
  const setDirtyTab = useTabs((s) => s.setDirty);
  const reduced = useReducedMotion();

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [loaded, setLoaded] = useState<Record<Side, Loaded | null>>({ left: null, right: null });
  const [dirty, setDirty] = useState<Record<Side, boolean>>({ left: false, right: false });
  const [diff, setDiffResult] = useState<DiffResult | null>(null);
  const [current, setCurrent] = useState(-1);
  const [ribbons, setRibbons] = useState<Ribbon[]>([]);
  const [viewport, setViewport] = useState<[number, number]>([0, 1]);
  const [cursor, setCursor] = useState<{ side: Side; line: number; col: number }>({ side: "left", line: 1, col: 1 });
  const [external, setExternal] = useState<Record<Side, Loaded | null>>({ left: null, right: null });
  const [menuSide, setMenuSide] = useState<Side>("left");
  const [menuChunk, setMenuChunk] = useState(-1);

  const hosts = { left: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null) };
  const views = useRef<Record<Side, EditorView | null>>({ left: null, right: null });
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const diffRef = useRef<DiffResult | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const leader = useRef<Side>("left");
  const focused = useRef<Side>("left");
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef(0);
  const scrollAnim = useRef<{ stop: () => void } | null>(null);
  const confirmedLarge = useRef(false);
  // What each editor held when it was last loaded or saved; "unsaved" means different from this.
  const baseline = useRef<Record<Side, string>>({ left: "", right: "" });

  // ── Loading ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const stats = await Promise.all([left, right].map((p) => (p ? ipc.stat(p) : Promise.resolve(null))));
      for (const [i, s] of stats.entries()) {
        if (s?.kind === "missing") throw new Error(`${[left, right][i]} doesn't exist`);
        if (s?.kind === "dir") throw new Error(`${[left, right][i]} is a folder`);
      }
      const sizes: [number, number] = [stats[0]?.size ?? 0, stats[1]?.size ?? 0];
      if (!confirmedLarge.current && Math.max(...sizes) > LARGE) {
        setPhase({ kind: "large", sizes });
        return;
      }
      const [l, r] = await Promise.all([left ? ipc.loadFile(left) : EMPTY(null), right ? ipc.loadFile(right) : EMPTY(null)]);
      setLoaded({ left: l, right: r });
      setPhase(l.binary || r.binary ? { kind: "binary" } : { kind: "ready" });
    } catch (e) {
      setPhase({ kind: "error", message: String(e instanceof Error ? e.message : e) });
    }
  }, [left, right]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Diffing ────────────────────────────────────────────────────────────────
  const applyDecorations = useCallback((result: DiffResult | null, cur: number) => {
    for (const side of ["left", "right"] as Side[]) {
      views.current[side]?.dispatch({ effects: setDiff.of({ chunks: result?.chunks ?? [], current: cur }) });
    }
  }, []);

  const runDiff = useCallback(async () => {
    const l = views.current.left;
    const r = views.current.right;
    if (!l || !r) return;
    const my = ++seq.current;
    const lt = l.state.doc.toString();
    const rt = r.state.doc.toString();
    const nextDirty = { left: lt !== baseline.current.left, right: rt !== baseline.current.right };
    setDirty(nextDirty);
    try {
      const result = await ipc.diffTexts(lt, rt, options);
      if (my !== seq.current) return;
      diffRef.current = result;
      setDiffResult(result);
      const cur = currentRef.current < result.chunks.length ? currentRef.current : -1;
      setCurrent(cur);
      applyDecorations(result, cur);
    } catch {
      // Diffing a stale snapshot can fail mid-edit; the next run will catch up.
    }
  }, [options, applyDecorations]);

  const scheduleDiff = useCallback(
    (delay = 150) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void runDiff(), delay);
    },
    [runDiff],
  );

  useEffect(() => {
    if (phase.kind === "ready") void runDiff();
  }, [options, phase.kind, runDiff]);

  useEffect(() => {
    applyDecorations(diffRef.current, current);
  }, [current, applyDecorations]);

  useEffect(() => {
    setDirtyTab(tabId, dirty.left || dirty.right);
  }, [dirty, tabId, setDirtyTab]);

  // ── Geometry: ribbons and overview follow every scroll frame ───────────────
  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const l = views.current.left;
      const r = views.current.right;
      const d = diffRef.current;
      if (!l || !r || !d) return;
      setRibbons(computeRibbons(l, r, d.chunks));
      setViewport(viewportFraction(l, r, d.chunks));
    });
  }, []);

  useEffect(() => {
    measure();
  }, [diff, measure]);

  // ── Editors ────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (phase.kind !== "ready") return;
    const created: EditorView[] = [];
    for (const side of ["left", "right"] as Side[]) {
      const host = hosts[side].current;
      const file = loaded[side];
      if (!host || !file) continue;
      const path = side === "left" ? left : right;
      const view = createPane(host, {
        side,
        doc: file.text,
        readOnly: scratch ? false : !path || file.readonly,
        placeholder: scratch ? `Paste or type the ${side} text` : undefined,
        onDocChange: () => scheduleDiff(),
        onFocus: () => {
          focused.current = side;
          leader.current = side;
        },
        onCursor: (line, col) => setCursor({ side, line, col }),
      });
      views.current[side] = view;
      baseline.current[side] = view.state.doc.toString();
      created.push(view);
      void languageFor(path).then((lang) => lang && view.dispatch({ effects: language.reconfigure(lang) }));

      const scroller = view.scrollDOM;
      const take = () => {
        leader.current = side;
        scrollAnim.current?.stop();
      };
      scroller.addEventListener("wheel", take, { passive: true });
      scroller.addEventListener("pointerdown", take);
      scroller.addEventListener("scroll", () => {
        const d = diffRef.current;
        const o = views.current[other(side)];
        if (leader.current === side && d && o) syncScroll(view, o, d.chunks, side);
        measure();
      });
    }
    void runDiff();
    const ro = new ResizeObserver(measure);
    created.forEach((v) => ro.observe(v.scrollDOM));
    return () => {
      ro.disconnect();
      created.forEach((v) => v.destroy());
      views.current = { left: null, right: null };
    };
    // Editors are created once per load; later file changes are dispatched into them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const scrollTo = useCallback(
    (side: Side, line: number) => {
      const view = views.current[side];
      if (!view) return;
      const s = view.scrollDOM;
      const target = Math.max(0, heightAtLine(view, line) + docOffset(view) - s.clientHeight / 3);
      leader.current = side;
      scrollAnim.current?.stop();
      if (reduced) {
        s.scrollTop = target;
        return;
      }
      // A spring that picks up from wherever the scroll currently is.
      scrollAnim.current = animate(s.scrollTop, target, { ...SPRING, onUpdate: (v) => (s.scrollTop = v) });
    },
    [reduced],
  );

  const goTo = useCallback(
    (i: number) => {
      const d = diffRef.current;
      if (!d || i < 0 || i >= d.chunks.length) return;
      setCurrent(i);
      const c = d.chunks[i];
      for (const side of ["left", "right"] as Side[]) {
        const v = views.current[side];
        if (!v) continue;
        const line = Math.min(c[side][0], v.state.doc.lines - 1);
        v.dispatch({ selection: { anchor: v.state.doc.line(line + 1).from } });
      }
      scrollTo(focused.current, c[focused.current][0]);
    },
    [scrollTo],
  );

  const cursorLine = (side: Side) => {
    const v = views.current[side];
    return v ? v.state.doc.lineAt(v.state.selection.main.head).number - 1 : 0;
  };

  const step = useCallback(
    (dir: 1 | -1) => {
      const d = diffRef.current;
      if (!d) return;
      const side = focused.current;
      const cur = currentRef.current >= 0 && chunkAt(cursorLine(side), d.chunks, side) === currentRef.current ? currentRef.current : -1;
      goTo(stepChunk(cursorLine(side), d.chunks, side, dir, cur));
    },
    [goTo],
  );

  const copy = useCallback(
    (index: number, to: Side) => {
      const d = diffRef.current;
      const src = views.current[other(to)];
      const dst = views.current[to];
      if (!d || !src || !dst || dst.state.readOnly) return;
      const c = d.chunks[index];
      if (!c) return;
      dst.dispatch({ changes: copyChange(src.state.doc, dst.state.doc, c[other(to)], c[to]), userEvent: "input.copy-change" });
      setCurrent(-1);
      scheduleDiff(0);
    },
    [scheduleDiff],
  );

  const targetChunk = () => {
    const d = diffRef.current;
    if (!d) return -1;
    if (currentRef.current >= 0) return currentRef.current;
    return chunkAt(cursorLine(focused.current), d.chunks, focused.current);
  };

  // ── Saving and outside changes ─────────────────────────────────────────────
  const save = useCallback(
    async (side: Side) => {
      const view = views.current[side];
      const file = loadedRef.current[side];
      const path = side === "left" ? left : right;
      if (!view || !file || !path || file.readonly) return;
      const text = view.state.doc.toString();
      const fresh = await ipc.saveFile(path, text, file);
      baseline.current[side] = text;
      setLoaded((s) => ({ ...s, [side]: fresh }));
      loadedRef.current = { ...loadedRef.current, [side]: fresh };
      setDirty((s) => ({ ...s, [side]: false }));
      setExternal((s) => ({ ...s, [side]: null }));
    },
    [left, right],
  );

  const replaceDoc = useCallback(
    (side: Side, fresh: Loaded) => {
      const view = views.current[side];
      if (!view) return;
      loadedRef.current = { ...loadedRef.current, [side]: fresh };
      setLoaded((s) => ({ ...s, [side]: fresh }));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fresh.text } });
      baseline.current[side] = view.state.doc.toString();
      setExternal((s) => ({ ...s, [side]: null }));
      scheduleDiff(0);
    },
    [scheduleDiff],
  );

  useEffect(() => {
    const paths = [left, right].filter(Boolean) as string[];
    paths.forEach((p) => void ipc.watch(p).catch(() => {}));
    const pending: Record<string, ReturnType<typeof setTimeout>> = {};
    const off = listen<{ path: string }>("file-changed", ({ payload }) => {
      for (const side of ["left", "right"] as Side[]) {
        const path = side === "left" ? left : right;
        if (!path || payload.path !== path) continue;
        clearTimeout(pending[side]);
        // Editors often write in several steps; wait for the dust to settle.
        pending[side] = setTimeout(async () => {
          const fresh = await ipc.loadFile(path).catch(() => null);
          const mine = loadedRef.current[side];
          if (!fresh || !mine || fresh.hash === mine.hash || fresh.binary) return;
          const view = views.current[side];
          const isDirty = view ? view.state.doc.toString() !== baseline.current[side] : false;
          if (isDirty) setExternal((s) => ({ ...s, [side]: fresh }));
          else replaceDoc(side, fresh);
        }, 200);
      }
    });
    return () => {
      paths.forEach((p) => void ipc.unwatch(p).catch(() => {}));
      Object.values(pending).forEach(clearTimeout);
      void off.then((f) => f());
    };
  }, [left, right, replaceDoc]);

  // ── Commands ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return commandBus.register(tabId, {
      save: () => void save(focused.current),
      "save-all": () => void Promise.all([save("left"), save("right")]),
      "next-change": () => step(1),
      "prev-change": () => step(-1),
      "copy-to-right": () => copy(targetChunk(), "right"),
      "copy-to-left": () => copy(targetChunk(), "left"),
      rescan: () => void load(),
      find: () => {
        const v = views.current[focused.current];
        if (v) openSearchPanel(v);
      },
    });
  }, [tabId, save, step, copy, load]);

  useEffect(() => {
    if (active) measure();
  }, [active, measure]);

  // ── Context menu ───────────────────────────────────────────────────────────
  const menuItems: ContextMenuItem[] = useMemo(() => {
    const ro = (s: Side) => !scratch && (!(s === "left" ? left : right) || Boolean(loaded[s]?.readonly));
    const there = other(menuSide);
    return [
      { id: "copy-over", label: menuSide === "left" ? "Copy change to right" : "Copy change to left", shortcut: menuSide === "left" ? "⌘]" : "⌘[", disabled: menuChunk < 0 || ro(there) },
      { id: "take", label: menuSide === "left" ? "Take change from right" : "Take change from left", disabled: menuChunk < 0 || ro(menuSide) },
      { id: "sep1", type: "separator" },
      { id: "next", label: "Next change", shortcut: "F8" },
      { id: "prev", label: "Previous change", shortcut: "F7" },
      { id: "sep2", type: "separator" },
      { id: "find", label: "Find…", shortcut: "⌘F" },
      { id: "save", label: "Save this side", shortcut: "⌘S", disabled: !dirty[menuSide] },
    ];
  }, [menuSide, menuChunk, dirty, loaded, left, right, scratch]);

  const onMenu = (id: string) => {
    if (id === "copy-over") copy(menuChunk, other(menuSide));
    else if (id === "take") copy(menuChunk, menuSide);
    else if (id === "next") step(1);
    else if (id === "prev") step(-1);
    else if (id === "find") views.current[menuSide] && openSearchPanel(views.current[menuSide]!);
    else if (id === "save") void save(menuSide);
  };

  const prepareMenu = (side: Side) => (e: React.MouseEvent) => {
    const v = views.current[side];
    const d = diffRef.current;
    setMenuSide(side);
    focused.current = side;
    if (!v || !d) return setMenuChunk(-1);
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    setMenuChunk(pos == null ? -1 : chunkAt(v.state.doc.lineAt(pos).number - 1, d.chunks, side));
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (phase.kind === "loading") return <div className="grid h-full place-items-center bg-surface text-ink-400">Loading…</div>;
  if (phase.kind === "error") return <Message title="Can't compare these files" body={phase.message} />;
  if (phase.kind === "large")
    return (
      <div className="mx-auto mt-16 w-full max-w-[520px] px-6">
        <CollapsibleBanner
          dismissible={false}
          title="This is a large file"
          description={`${(Math.max(...phase.sizes) / 1024 / 1024).toFixed(0)} MB. Diffing it may take a while and use a lot of memory.`}
          action={
            <button
              type="button"
              className="h-7 rounded-[5px] bg-accent px-3 text-[12px] font-medium text-on-accent"
              onClick={() => {
                confirmedLarge.current = true;
                void load();
              }}
            >
              Compare anyway
            </button>
          }
        />
      </div>
    );
  if (phase.kind === "binary") return <BinaryCard left={loaded.left} right={loaded.right} leftPath={left} rightPath={right} />;

  const total = (views.current.left?.state.doc.lines ?? 0) + (views.current.right?.state.doc.lines ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {(["left", "right"] as Side[]).map((side) =>
        external[side] ? (
          <div key={side} className="border-b border-ink-200 bg-ink-50 px-3 py-2">
            <CollapsibleBanner
              title={`${basename((side === "left" ? left : right) ?? "")} changed on disk`}
              description="You have unsaved edits on this side. Reload to see the new version, or keep yours and overwrite it on save."
              onDismiss={() => setExternal((s) => ({ ...s, [side]: null }))}
              dismissLabel="Keep my edits"
              dismissedMessage="Keeping your edits."
              action={
                <button type="button" className="h-7 rounded-[5px] bg-accent px-3 text-[12px] font-medium text-on-accent" onClick={() => replaceDoc(side, external[side]!)}>
                  Reload
                </button>
              }
            />
          </div>
        ) : null,
      )}

      <div className="flex border-b border-ink-200">
        <PaneHeader path={left} file={loaded.left} dirty={dirty.left && !scratch} side="left" scratch={scratch} />
        <div className="shrink-0 border-x border-ink-200 bg-ink-50" style={{ width: SEAM_WIDTH }} />
        <PaneHeader path={right} file={loaded.right} dirty={dirty.right && !scratch} side="right" scratch={scratch} />
      </div>

      <Overview
        chunks={diff?.chunks ?? []}
        total={total}
        current={current}
        viewport={viewport}
        onScrub={(f) => {
          const d = diffRef.current;
          const l = views.current.left;
          if (!d || !l || !views.current.right) return;
          const line = leftLineAt(f, l.state.doc.lines, views.current.right.state.doc.lines, d.chunks);
          scrollAnim.current?.stop();
          leader.current = "left";
          l.scrollDOM.scrollTop = heightAtLine(l, line) + docOffset(l) - l.scrollDOM.clientHeight / 2;
        }}
      />

      <div className="relative flex min-h-0 flex-1">
        <ContextMenu items={menuItems} onSelect={onMenu} label="Change actions" className="min-w-0 flex-1">
          <div ref={hosts.left} className="h-full" onContextMenu={prepareMenu("left")} />
        </ContextMenu>
        <Seam
          ribbons={ribbons}
          current={current}
          readOnly={{ left: !scratch && (!left || Boolean(loaded.left?.readonly)), right: !scratch && (!right || Boolean(loaded.right?.readonly)) }}
          onCopy={copy}
          onPick={goTo}
        />
        <ContextMenu items={menuItems} onSelect={onMenu} label="Change actions" className="min-w-0 flex-1">
          <div ref={hosts.right} className="h-full" onContextMenu={prepareMenu("right")} />
        </ContextMenu>
      </div>

      <StatusBar diff={diff} options={options} cursor={cursor} current={current} />
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-full place-items-center bg-surface">
      <div className="max-w-[420px] text-center">
        <div className="text-[14px] font-medium text-ink-800">{title}</div>
        <div className="mt-1 text-[12.5px] text-ink-500">{body}</div>
      </div>
    </div>
  );
}
