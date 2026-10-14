import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as pick } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../../app/settings";
import { useTabs } from "../../app/tabs";
import { basename, ipc, tildify, type Stat } from "../../lib/ipc";
import type { Side } from "../../lib/diffmap";

const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;
const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;

type Picked = { path: string; kind: Stat["kind"] } | null;

export function StartScreen({ tabId, active }: { tabId: string; active: boolean }) {
  const openTab = useTabs((s) => s.open);
  const recents = useSettings((s) => s.recents);
  const addRecent = useSettings((s) => s.addRecent);
  const reduced = useReducedMotion();
  const [picked, setPicked] = useState<Record<Side, Picked>>({ left: null, right: null });
  const [over, setOver] = useState<Side | null>(null);
  const zones = { left: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null) };

  const set = async (side: Side, path: string) => {
    const s = await ipc.stat(path).catch(() => ({ kind: "missing" as const, size: 0 }));
    setPicked((p) => ({ ...p, [side]: { path, kind: s.kind } }));
  };

  const zoneAt = (x: number, y: number): Side | null => {
    for (const side of ["left", "right"] as Side[]) {
      const r = zones[side].current?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return side;
    }
    return null;
  };

  useEffect(() => {
    if (!active) return;
    let off: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        const dpr = window.devicePixelRatio || 1;
        if (payload.type === "leave") return setOver(null);
        const side = zoneAt(payload.position.x / dpr, payload.position.y / dpr);
        if (payload.type === "over" || payload.type === "enter") return setOver(side ?? null);
        if (payload.type === "drop") {
          setOver(null);
          const [a, b] = payload.paths;
          if (a && b) {
            void set("left", a);
            void set("right", b);
          } else if (a) void set(side ?? (picked.left ? "right" : "left"), a);
        }
      })
      .then((f) => (off = f))
      .catch(() => {});
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, picked.left]);

  const choose = async (side: Side, directory: boolean) => {
    const p = await pick({ directory, multiple: false, title: `Choose the ${side} ${directory ? "folder" : "file"}` }).catch(() => null);
    if (typeof p === "string") void set(side, p);
  };

  const l = picked.left;
  const r = picked.right;
  const mismatch = Boolean(l && r && l.kind !== r.kind);
  const missing = [l, r].some((p) => p?.kind === "missing");
  const ready = Boolean(l && r && !mismatch && !missing);

  const compare = (left: string, right: string, kind: "file" | "folder") => {
    addRecent({ left, right, kind });
    openTab({ kind, left, right }, { replace: tabId });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-8 px-8 pb-12 pt-[12vh]">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink-900">Compare</h1>
          <p className="mt-1 text-[13px] text-ink-500">Drop two files or two folders, or choose them. Dropping both at once fills both sides. Or compare text you paste in.</p>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-3">
          {(["left", "right"] as Side[]).map((side, i) => (
            <div key={side} className="contents">
              {i === 1 && (
                <div className="grid place-items-center text-ink-300" aria-hidden>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                    <path d="M3 6h11m-3-3 3 3-3 3M15 12H4m3-3-3 3 3 3" />
                  </svg>
                </div>
              )}
              <motion.div
                ref={zones[side]}
                animate={reduced ? undefined : { scale: over === side ? 1.012 : 1 }}
                transition={CELL}
                className={`relative flex min-h-[164px] flex-col justify-between rounded-[10px] border p-4 transition-colors duration-150 ${
                  over === side ? "border-accent bg-accent/[0.05]" : picked[side] ? "border-ink-200 bg-surface shadow-card" : "border-dashed border-ink-300 bg-surface/60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-400">{side}</span>
                  <span className={`size-1.5 rounded-full ${side === "left" ? "bg-del" : "bg-add"}`} />
                </div>
                {/* Both states share one grid cell so the zone never changes height. */}
                <div className="grid">
                  <AnimatePresence initial={false}>
                    {picked[side] ? (
                      <motion.div
                        key={picked[side]!.path}
                        className="col-start-1 row-start-1 min-w-0"
                        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(3px)" }}
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, filter: "blur(3px)" }}
                        transition={reduced ? { duration: 0 } : CROSSFADE}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-medium text-ink-900">{basename(picked[side]!.path)}</span>
                          <span className="shrink-0 rounded-[3px] border border-ink-200 px-1.5 font-mono text-[10px] text-ink-500">
                            {picked[side]!.kind === "dir" ? "folder" : picked[side]!.kind}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-ink-400">{tildify(picked[side]!.path)}</div>
                      </motion.div>
                    ) : (
                      <motion.div key="empty" className="col-start-1 row-start-1 text-[13px] text-ink-400" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        Drop a file or folder here
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="flex gap-1.5">
                  <ZoneButton onClick={() => void choose(side, false)}>File…</ZoneButton>
                  <ZoneButton onClick={() => void choose(side, true)}>Folder…</ZoneButton>
                  {picked[side] && <ZoneButton onClick={() => setPicked((p) => ({ ...p, [side]: null }))}>Clear</ZoneButton>}
                </div>
              </motion.div>
            </div>
          ))}
        </div>

        <div className="flex h-9 items-center gap-3">
          <motion.button
            type="button"
            disabled={!ready}
            whileTap={ready && !reduced ? { y: 1 } : undefined}
            transition={CELL}
            onClick={() => l && r && compare(l.path, r.path, l.kind === "dir" ? "folder" : "file")}
            className="h-9 rounded-[6px] bg-accent px-4 text-[13px] font-medium text-on-accent shadow-thumb outline-none transition-opacity duration-150 focus-visible:shadow-control-focus disabled:opacity-40"
          >
            Compare
          </motion.button>
          <span className="min-w-0 flex-1 text-[12px] text-ink-500" role="status" aria-live="polite">
            {missing ? "One of these paths doesn't exist." : mismatch ? "Pick two files or two folders, not one of each." : ready ? "↵ Return also works." : ""}
          </span>
          <button
            type="button"
            onClick={() => openTab({ kind: "text", left: null, right: null }, { replace: tabId })}
            className="flex h-9 items-center gap-2 rounded-[6px] px-3 text-[12.5px] font-medium text-ink-600 outline-none transition-colors duration-150 hover:bg-ink-500/[0.08] hover:text-ink-800 focus-visible:shadow-control-focus"
          >
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
              <rect x="3" y="2.5" width="8" height="10" rx="1.3" />
              <path d="M5.5 2.5V1.8c0-.3.2-.5.5-.5h2c.3 0 .5.2.5.5v.7" />
            </svg>
            Compare pasted text
          </button>
        </div>

        {recents.length > 0 && (
          <section>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-400">Recent</h2>
            <ul className="overflow-hidden rounded-[8px] border border-ink-200 bg-surface shadow-card">
              {recents.map((rc) => (
                <li key={rc.left + "|" + rc.right} className="border-b border-ink-200 last:border-0">
                  <button
                    type="button"
                    onClick={() => compare(rc.left, rc.right, rc.kind)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-ink-50 focus-visible:bg-accent/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                  >
                    <span className="w-12 shrink-0 font-mono text-[10px] uppercase text-ink-400">{rc.kind}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-700">
                      {basename(rc.left)} <span className="text-ink-300">↔</span> {basename(rc.right)}
                    </span>
                    <span className="hidden min-w-0 max-w-[45%] truncate font-mono text-[11px] text-ink-400 md:block">{tildify(rc.left)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <ReturnKey enabled={ready && active} onEnter={() => l && r && compare(l.path, r.path, l.kind === "dir" ? "folder" : "file")} />
    </div>
  );
}

function ZoneButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-[5px] bg-surface px-2.5 text-[12px] font-medium text-ink-700 shadow-control outline-none transition-colors duration-150 hover:bg-ink-50 focus-visible:shadow-control-focus"
    >
      {children}
    </button>
  );
}

function ReturnKey({ enabled, onEnter }: { enabled: boolean; onEnter: () => void }) {
  const cb = useRef(onEnter);
  cb.current = onEnter;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") cb.current();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [enabled]);
  return null;
}
