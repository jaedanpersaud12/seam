import { create } from "zustand";

export type TabKind = "start" | "file" | "folder" | "text";

export type Tab = {
  id: string;
  kind: TabKind;
  left: string | null;
  right: string | null;
  dirty: boolean;
};

type TabsState = {
  tabs: Tab[];
  active: string;
  open: (t: Omit<Tab, "id" | "dirty">, opts?: { replace?: string }) => string;
  close: (id: string) => void;
  activate: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
};

let seq = 0;
const nextId = () => `t${++seq}`;

const startTab = (): Tab => ({ id: nextId(), kind: "start", left: null, right: null, dirty: false });

const first = startTab();

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [first],
  active: first.id,
  open: (t, opts) => {
    const id = nextId();
    const tab: Tab = { ...t, id, dirty: false };
    set((s) => {
      const at = opts?.replace ? s.tabs.findIndex((x) => x.id === opts.replace) : -1;
      const tabs = [...s.tabs];
      if (at >= 0) tabs.splice(at, 1, tab);
      else tabs.push(tab);
      return { tabs, active: id };
    });
    return id;
  },
  close: (id) => {
    const { tabs, active } = get();
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    let rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) rest = [startTab()];
    const nextActive = active === id ? rest[Math.min(i, rest.length - 1)].id : active;
    set({ tabs: rest, active: nextActive });
  },
  activate: (id) => set({ active: id }),
  setDirty: (id, dirty) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.dirty !== dirty ? { ...t, dirty } : t)) })),
}));

/** Commands a tab's view can handle; menu items and the palette route them to the active tab. */
export type Command =
  | "save"
  | "save-all"
  | "next-change"
  | "prev-change"
  | "copy-to-right"
  | "copy-to-left"
  | "rescan"
  | "find";

const handlers = new Map<string, Partial<Record<Command, () => void>>>();

export const commandBus = {
  register(tabId: string, h: Partial<Record<Command, () => void>>) {
    handlers.set(tabId, h);
    return () => {
      if (handlers.get(tabId) === h) handlers.delete(tabId);
    };
  },
  run(cmd: Command) {
    const h = handlers.get(useTabs.getState().active);
    h?.[cmd]?.();
    return Boolean(h?.[cmd]);
  },
  can(cmd: Command) {
    return Boolean(handlers.get(useTabs.getState().active)?.[cmd]);
  },
};
