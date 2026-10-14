import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTabs as useTabsA11y } from "../components/interior/tabs";
import { basename } from "../lib/ipc";
import { useTabs, type Tab } from "./tabs";

// The interior Tabs indicator spring.
const INDICATOR = { type: "spring", stiffness: 620, damping: 42, mass: 0.35 } as const;
const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;
const TAB_W = 180;
const GAP = 2;
// Room around the row so the active plate's ring isn't clipped by the scroll container.
const PAD = 3;

export function tabTitle(t: Tab) {
  if (t.kind === "start") return "New comparison";
  if (t.kind === "text") return "Text comparison";
  const a = t.left ? basename(t.left) : "—";
  const b = t.right ? basename(t.right) : "—";
  return a === b ? a : `${a} ↔ ${b}`;
}

/** Comparison tabs living in the title bar. Width is fixed per tab so titles never shove neighbours. */
export function TabStrip({ onClose }: { onClose: (id: string) => void }) {
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.active);
  const activate = useTabs((s) => s.activate);
  const openNew = useTabs((s) => s.open);
  const reduced = useReducedMotion();

  const items = tabs.map((t) => ({ value: t.id, label: tabTitle(t) }));
  const a11y = useTabsA11y({ items, value: active, onValueChange: activate });

  // Tabs have a fixed width, so the plate's position is known without measuring mid-animation.
  const index = Math.max(0, tabs.findIndex((t) => t.id === active));
  const plateX = PAD + index * (TAB_W + GAP);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-tauri-drag-region>
      <div {...a11y.tabListProps} aria-label="Comparisons" className="relative flex h-[38px] min-w-0 items-center gap-[2px] overflow-x-auto px-[3px] [scrollbar-width:none]" data-tauri-drag-region>
        <motion.span
          aria-hidden
          className="absolute top-1/2 h-[28px] -translate-y-1/2 rounded-[6px] bg-surface shadow-thumb"
          initial={false}
          animate={{ x: plateX, width: TAB_W }}
          transition={reduced ? { duration: 0 } : INDICATOR}
          style={{ left: 0 }}
        />
        <AnimatePresence initial={false}>
          {tabs.map((t, i) => {
            const on = t.id === active;
            const props = a11y.getTabProps(items[i], i);
            return (
              <motion.div
                key={t.id}
                layout={!reduced}
                initial={reduced ? { opacity: 0 } : { opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: TAB_W }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, width: 0 }}
                transition={reduced ? { duration: 0 } : CELL}
                className="group/tab relative h-[28px] shrink-0 overflow-hidden rounded-[6px]"
              >
                <button
                  {...props}
                  ref={props.ref}
                  title={t.left && t.right ? `${t.left}\n${t.right}` : undefined}
                  onAuxClick={(e) => e.button === 1 && onClose(t.id)}
                  className={`relative flex h-full w-full items-center gap-2 rounded-[6px] pl-3 pr-7 text-left text-[12px] outline-none transition-colors duration-150 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
                    on ? "font-medium text-ink-800" : "text-ink-500 hover:bg-ink-500/[0.08] hover:text-ink-700"
                  }`}
                >
                  <KindIcon kind={t.kind} />
                  <span className="min-w-0 flex-1 truncate">{items[i].label}</span>
                </button>
                <button
                  type="button"
                  aria-label={t.dirty ? `Close ${items[i].label} (unsaved changes)` : `Close ${items[i].label}`}
                  onClick={() => onClose(t.id)}
                  className="absolute right-1.5 top-1/2 grid size-[18px] -translate-y-1/2 place-items-center rounded-[4px] text-ink-400 outline-none hover:bg-ink-500/15 hover:text-ink-700 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                >
                  {/* Unsaved: a dot that turns into the close cross on hover, like a sealed envelope. */}
                  <span className={`absolute size-[7px] rounded-full bg-accent transition-opacity duration-150 ${t.dirty ? "opacity-100 group-hover/tab:opacity-0" : "opacity-0"}`} />
                  <svg viewBox="0 0 10 10" width="8" height="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={`transition-opacity duration-150 ${t.dirty ? "opacity-0 group-hover/tab:opacity-100" : on ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"}`}>
                    <path d="M2 2l6 6M8 2 2 8" />
                  </svg>
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <button
        type="button"
        aria-label="New comparison"
        title="New comparison (⌘T)"
        onClick={() => openNew({ kind: "start", left: null, right: null })}
        className="grid size-[26px] shrink-0 place-items-center rounded-[6px] text-ink-500 outline-none hover:bg-ink-500/[0.08] hover:text-ink-800 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
      >
        <svg viewBox="0 0 12 12" width="11" height="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6 1.5v9M1.5 6h9" />
        </svg>
      </button>
      <div className="h-full min-w-6 flex-1" data-tauri-drag-region />
    </div>
  );
}

function KindIcon({ kind }: { kind: Tab["kind"] }) {
  if (kind === "folder")
    return (
      <svg viewBox="0 0 14 14" width="12" height="12" className="shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M1.75 3.5c0-.55.45-1 1-1h2.6l1.2 1.3h4.7c.55 0 1 .45 1 1v5.7c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1z" />
      </svg>
    );
  if (kind === "text")
    return (
      <svg viewBox="0 0 14 14" width="12" height="12" className="shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M2 3.5h10M2 7h6M2 10.5h8" />
      </svg>
    );
  if (kind === "file")
    return (
      <svg viewBox="0 0 14 14" width="12" height="12" className="shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="1.5" y="2" width="4.5" height="10" rx="1" />
        <rect x="8" y="2" width="4.5" height="10" rx="1" />
      </svg>
    );
  return (
    <svg viewBox="0 0 14 14" width="12" height="12" className="shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M7 3v8M3 7h8" />
    </svg>
  );
}
