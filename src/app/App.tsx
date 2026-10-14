import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as pick } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, type CommandItem } from "../components/interior/command-palette";
import { TooltipGroup } from "../components/interior/tooltip-group";
import { FileDiff } from "../features/filediff/FileDiff";
import { FolderDiff } from "../features/folderdiff/FolderDiff";
import { StartScreen } from "../features/start/StartScreen";
import { basename, ipc, type Launch } from "../lib/ipc";
import { DiffRules } from "./DiffRules";
import { applyAppearance, useSettings } from "./settings";
import { installCommandLineTool, SettingsModal } from "./SettingsModal";
import { TabStrip, tabTitle } from "./TabStrip";
import { commandBus, useTabs, type Command } from "./tabs";

const inTauri = "__TAURI_INTERNALS__" in window;
// Only macOS gets the overlay title bar (traffic lights over our toolbar) and vibrancy.
const isMac = navigator.userAgent.includes("Mac");

export function App() {
  const settings = useSettings();
  const { tabs, active, open: openTab, close, activate } = useTabs();
  const [palette, setPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const waitMode = useRef(false);

  useEffect(() => {
    void settings.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => applyAppearance(settings.theme, settings.palette), [settings.theme, settings.palette]);
  useEffect(() => {
    document.documentElement.style.setProperty("--code-size", `${settings.fontSize}px`);
  }, [settings.fontSize]);
  useEffect(() => {
    if (inTauri && isMac) document.documentElement.classList.add("vibrant");
  }, []);

  // ── Opening comparisons ────────────────────────────────────────────────────
  const openPaths = useCallback(
    async (left: string, right: string | null, replace?: string) => {
      const kind = (await ipc.stat(left)).kind === "dir" ? "folder" : "file";
      if (right) settings.addRecent({ left, right, kind });
      openTab({ kind, left, right }, { replace });
    },
    [openTab, settings],
  );

  const openLaunch = useCallback(
    (l: Launch) => {
      if (!l.left) return;
      const start = useTabs.getState().tabs.find((t) => t.kind === "start" && t.id === useTabs.getState().active);
      void openPaths(l.left, l.right, start?.id);
    },
    [openPaths],
  );

  useEffect(() => {
    if (!inTauri) return;
    void ipc.launchArgs().then((l) => {
      waitMode.current = l.wait;
      openLaunch(l);
    });
    const off = listen<Launch>("open-launch", ({ payload }) => openLaunch(payload));
    return () => void off.then((f) => f());
  }, [openLaunch]);

  const openDialog = useCallback(async () => {
    const picked = await pick({ multiple: true, title: "Choose two files to compare" }).catch(() => null);
    if (Array.isArray(picked) && picked.length >= 2) void openPaths(picked[0], picked[1]);
    else if (Array.isArray(picked) && picked.length === 1) openTab({ kind: "start", left: null, right: null });
  }, [openPaths, openTab]);

  // ── Closing ────────────────────────────────────────────────────────────────
  const closeTab = useCallback(
    async (id: string) => {
      const t = useTabs.getState().tabs.find((x) => x.id === id);
      if (!t) return;
      if (t.dirty) {
        const ok = inTauri ? await ask(`${tabTitle(t)} has unsaved changes. Close it anyway?`, { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" }) : confirm("Discard unsaved changes?");
        if (!ok) return;
      }
      close(id);
      // A --wait launch ends when its comparison closes, so git can continue.
      if (waitMode.current && inTauri) void getCurrentWindow().close();
    },
    [close],
  );

  // ── Menu, palette and commands ─────────────────────────────────────────────
  const run = useCallback(
    (id: string) => {
      switch (id) {
        case "new-tab":
          openTab({ kind: "start", left: null, right: null });
          return;
        case "new-text":
          openTab({ kind: "text", left: null, right: null });
          return;
        case "open":
          void openDialog();
          return;
        case "close-tab":
          void closeTab(useTabs.getState().active);
          return;
        case "palette":
          setPalette((p) => !p);
          return;
        case "settings":
          setSettingsOpen(true);
          return;
        case "install-cli":
          void installCommandLineTool();
          return;
        case "theme-light":
        case "theme-dark":
        case "theme-system":
          settings.update({ theme: id.slice(6) as "light" | "dark" | "system" });
          return;
        case "ws-cycle": {
          const order = ["exact", "trailing", "change", "all"] as const;
          settings.setDiff({ whitespace: order[(order.indexOf(settings.diff.whitespace) + 1) % order.length] });
          return;
        }
        case "ignore-case":
          settings.setDiff({ ignoreCase: !settings.diff.ignoreCase });
          return;
        case "palette-cb":
          settings.update({ palette: settings.palette === "cb" ? "classic" : "cb" });
          return;
        default:
          if (id.startsWith("recent:")) {
            const r = settings.recents[Number(id.slice(7))];
            if (r) void openPaths(r.left, r.right);
            return;
          }
          if (id.startsWith("tab:")) {
            activate(id.slice(4));
            return;
          }
          commandBus.run(id as Command);
      }
    },
    [openTab, openDialog, closeTab, settings, openPaths, activate],
  );

  useEffect(() => {
    if (!inTauri) return;
    const off = listen<string>("menu", ({ payload }) => run(payload));
    return () => void off.then((f) => f());
  }, [run]);

  // Browser preview has no native menu; mirror the important shortcuts.
  useEffect(() => {
    if (inTauri) return;
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const map: Record<string, string> = { k: "palette", t: "new-tab", s: "save", "]": "copy-to-right", "[": "copy-to-left" };
      if (mod && map[e.key]) {
        e.preventDefault();
        run(map[e.key]);
      } else if (e.key === "F8" || e.key === "F7") {
        e.preventDefault();
        run(e.key === "F8" ? "next-change" : "prev-change");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [run]);

  const items: CommandItem[] = useMemo(
    () => [
      { id: "new-tab", label: "New comparison", shortcut: ["⌘", "T"], keywords: "open start" },
      { id: "open", label: "Open two files…", shortcut: ["⌘", "O"] },
      { id: "new-text", label: "Compare pasted text", keywords: "clipboard scratch paste snippet" },
      { id: "next-change", label: "Next change", shortcut: ["F8"], keywords: "jump down" },
      { id: "prev-change", label: "Previous change", shortcut: ["F7"], keywords: "jump up" },
      { id: "copy-to-right", label: "Copy change to right", shortcut: ["⌘", "]"], keywords: "apply push" },
      { id: "copy-to-left", label: "Copy change to left", shortcut: ["⌘", "["], keywords: "apply pull" },
      { id: "save", label: "Save", shortcut: ["⌘", "S"] },
      { id: "save-all", label: "Save both sides", shortcut: ["⌥", "⌘", "S"] },
      { id: "find", label: "Find in file", shortcut: ["⌘", "F"], keywords: "search" },
      { id: "rescan", label: "Rescan / reload", shortcut: ["⌘", "R"], keywords: "refresh" },
      { id: "ws-cycle", label: `Whitespace: ${settings.diff.whitespace} → next`, keywords: "ignore whitespace rules" },
      { id: "ignore-case", label: settings.diff.ignoreCase ? "Match case" : "Ignore case", keywords: "rules" },
      { id: "theme-light", label: "Light appearance", keywords: "theme" },
      { id: "theme-dark", label: "Dark appearance", keywords: "theme" },
      { id: "theme-system", label: "Match system appearance", keywords: "theme auto" },
      { id: "palette-cb", label: settings.palette === "cb" ? "Classic diff colours" : "Colour-blind safe diff colours", keywords: "accessibility colors" },
      { id: "settings", label: "Settings…", shortcut: ["⌘", ","] },
      { id: "install-cli", label: "Install command line tool…", keywords: "git difftool terminal" },
      ...tabs.filter((t) => t.id !== active).map((t) => ({ id: `tab:${t.id}`, label: `Go to ${tabTitle(t)}`, keywords: "tab switch" })),
      ...settings.recents.map((r, i) => ({ id: `recent:${i}`, label: `${basename(r.left)} ↔ ${basename(r.right)}`, hint: "Recent", keywords: `${r.left} ${r.right}` })),
    ],
    [settings.diff, settings.palette, settings.recents, tabs, active],
  );

  return (
    <TooltipGroup>
      <div className="flex h-full flex-col">
        <header className={`flex h-[46px] shrink-0 items-center gap-2 border-b border-ink-200 bg-chrome pr-2 ${isMac && inTauri ? "pl-[84px]" : "pl-2"}`} data-tauri-drag-region>
          <TabStrip onClose={(id) => void closeTab(id)} />
          <DiffRules />
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex h-[26px] items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-ink-500 outline-none hover:bg-ink-500/[0.08] hover:text-ink-800 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
            aria-label="Command palette"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.25" />
              <path d="M10.2 10.2 13.5 13.5" />
            </svg>
            <kbd className="font-sans text-[11px] text-ink-400">⌘K</kbd>
          </button>
        </header>

        <main className="relative min-h-0 flex-1">
          {tabs.map((t) => (
            <section key={t.id} className={`absolute inset-0 ${t.id === active ? "" : "invisible"}`} aria-hidden={t.id !== active}>
              {t.kind === "start" && <StartScreen tabId={t.id} active={t.id === active} />}
              {t.kind === "text" && <FileDiff tabId={t.id} left={null} right={null} active={t.id === active} scratch />}
              {t.kind === "file" && <FileDiff tabId={t.id} left={t.left} right={t.right} active={t.id === active} />}
              {t.kind === "folder" && t.left && t.right && <FolderDiff tabId={t.id} left={t.left} right={t.right} active={t.id === active} />}
            </section>
          ))}
        </main>
      </div>

      <CommandPalette
        open={palette}
        items={items}
        onSelect={(item) => {
          setPalette(false);
          // Let the palette finish closing before the command moves focus.
          requestAnimationFrame(() => run(item.id));
        }}
        onDismiss={() => setPalette(false)}
        placeholder="Type a command or a recent comparison"
        autoFocus
        maxRows={8}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </TooltipGroup>
  );
}
