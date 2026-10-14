import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { DiffOptions } from "../lib/ipc";

export type Recent = { left: string; right: string; kind: "file" | "folder"; at: number };

export type Settings = {
  theme: "system" | "light" | "dark";
  palette: "classic" | "cb";
  fontSize: number;
  diff: DiffOptions;
  respectGitignore: boolean;
  excludes: string[];
  recents: Recent[];
};

export const DEFAULTS: Settings = {
  theme: "system",
  palette: "classic",
  fontSize: 12.5,
  diff: { algorithm: "patience", whitespace: "exact", ignoreCase: false, ignoreEol: false },
  respectGitignore: false,
  excludes: [".git", "node_modules", "target", ".DS_Store"],
  recents: [],
};

type SettingsState = Settings & {
  ready: boolean;
  init: () => Promise<void>;
  update: (patch: Partial<Settings>) => void;
  setDiff: (patch: Partial<DiffOptions>) => void;
  addRecent: (r: Omit<Recent, "at">) => void;
};

let store: Store | null = null;

function persist(s: Settings) {
  if (!store) return;
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) void store.set(key, s[key]);
}

const pick = (s: SettingsState): Settings => ({
  theme: s.theme,
  palette: s.palette,
  fontSize: s.fontSize,
  diff: s.diff,
  respectGitignore: s.respectGitignore,
  excludes: s.excludes,
  recents: s.recents,
});

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  ready: false,
  init: async () => {
    try {
      store = await load("settings.json", { autoSave: 300, defaults: {} });
      const saved: Partial<Settings> = {};
      for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
        const v = await store.get(key);
        if (v !== undefined && v !== null) (saved as Record<string, unknown>)[key] = v;
      }
      set({ ...saved, diff: { ...DEFAULTS.diff, ...(saved.diff ?? {}) }, ready: true });
    } catch {
      // Outside Tauri (plain browser preview) settings just live in memory.
      set({ ready: true });
    }
  },
  update: (patch) => {
    set(patch);
    persist(pick(get()));
  },
  setDiff: (patch) => get().update({ diff: { ...get().diff, ...patch } }),
  addRecent: (r) => {
    const rest = get().recents.filter((x) => !(x.left === r.left && x.right === r.right));
    get().update({ recents: [{ ...r, at: Date.now() }, ...rest].slice(0, 12) });
  },
}));

/** Applies theme and palette to <html>, following the system appearance when asked. */
export function applyAppearance(theme: Settings["theme"], palette: Settings["palette"]) {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolve = () => {
    root.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
  };
  resolve();
  root.dataset.palette = palette;
  media.addEventListener("change", resolve);
  return () => media.removeEventListener("change", resolve);
}
