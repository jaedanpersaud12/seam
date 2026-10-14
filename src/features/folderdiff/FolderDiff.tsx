import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../app/settings";
import { commandBus, useTabs } from "../../app/tabs";
import { LoadingButton } from "../../components/interior/loading-button";
import { ProgressBar } from "../../components/interior/progress-bar";
import { SegmentedControl } from "../../components/interior/segmented-control";
import { SortableTable, type SortableColumn } from "../../components/interior/sortable-table";
import { TreeView, type TreeNode, type TreeRow } from "../../components/interior/tree-view";
import { ValueFlash } from "../../components/interior/value-flash";
import { basename, ipc, tildify, type FolderEntry, type FolderResult, type FolderStatus } from "../../lib/ipc";

type Filter = "all" | "changed" | "left" | "right";
type Mode = "tree" | "list";

const GLYPH: Record<FolderStatus, { mark: string; tone: string; label: string }> = {
  identical: { mark: "=", tone: "text-ink-400", label: "Identical" },
  equivalent: { mark: "≈", tone: "text-ink-500", label: "Equivalent" },
  different: { mark: "≠", tone: "text-mod", label: "Different" },
  leftOnly: { mark: "◧", tone: "text-del", label: "Left only" },
  rightOnly: { mark: "◨", tone: "text-add", label: "Right only" },
  error: { mark: "!", tone: "text-bad", label: "Unreadable" },
};

const keep = (e: FolderEntry, f: Filter) =>
  f === "all" ||
  (f === "changed" && (e.status === "different" || e.status === "leftOnly" || e.status === "rightOnly" || e.status === "error")) ||
  (f === "left" && e.status === "leftOnly") ||
  (f === "right" && e.status === "rightOnly");

/** Rebuilds the nested tree from the flat, tree-ordered entry list, honouring the filter. */
function buildTree(entries: FolderEntry[], filter: Filter): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();
  const wanted = new Set<string>();
  const want = (path: string) => {
    let p = path;
    wanted.add(p);
    while (p.includes("/")) {
      p = p.slice(0, p.lastIndexOf("/"));
      wanted.add(p);
    }
  };
  // Matching files, plus one-sided folders (which may be empty), with their ancestors.
  for (const e of entries) {
    if (!keep(e, filter)) continue;
    if (!e.isDir || e.status === "leftOnly" || e.status === "rightOnly") want(e.path);
  }
  for (const e of entries) {
    if (!wanted.has(e.path)) continue;
    const node: TreeNode = { id: e.path, label: e.name, data: e, children: e.isDir ? [] : undefined };
    byPath.set(e.path, node);
    const parent = e.path.includes("/") ? byPath.get(e.path.slice(0, e.path.lastIndexOf("/"))) : undefined;
    (parent ? parent.children! : roots).push(node);
  }
  // Folders with nothing under them render as leaves.
  for (const n of byPath.values()) if (n.children && n.children.length === 0) n.children = undefined;
  return roots;
}

const fmtSize = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} K` : `${(n / 1024 ** 2).toFixed(1)} M`);
const fmtDate = (ms?: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

type Props = { tabId: string; left: string; right: string; active: boolean };

export function FolderDiff({ tabId, left, right }: Props) {
  const diff = useSettings((s) => s.diff);
  const respectGitignore = useSettings((s) => s.respectGitignore);
  const excludes = useSettings((s) => s.excludes);
  const update = useSettings((s) => s.update);
  const openTab = useTabs((s) => s.open);

  const [result, setResult] = useState<FolderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("changed");
  const [mode, setMode] = useState<Mode>("tree");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const job = useRef(0);

  const scan = useCallback(async () => {
    const id = `${tabId}:${++job.current}`;
    setProgress(null);
    setError(null);
    const off = await listen<{ job: string; done: number; total: number }>("folder-progress", ({ payload }) => {
      if (payload.job === id) setProgress((payload.done / Math.max(1, payload.total)) * 100);
    });
    try {
      const r = await ipc.compareFolders(id, left, right, { diff, respectGitignore, excludes });
      if (!id.endsWith(`:${job.current}`)) return;
      setResult(r);
      // Open every folder that has something to look at.
      setExpanded((prev) => (prev.length ? prev : r.entries.filter((e) => e.isDir && e.status !== "identical" && e.depth < 3).map((e) => e.path)));
    } catch (e) {
      setError(String(e));
    } finally {
      off();
      setProgress(100);
    }
  }, [tabId, left, right, diff, respectGitignore, excludes]);

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => commandBus.register(tabId, { rescan: () => void scan() }), [tabId, scan]);

  const openEntry = useCallback(
    (e: FolderEntry) => {
      if (e.isDir) return;
      openTab({ kind: "file", left: e.left ? `${left}/${e.path}` : null, right: e.right ? `${right}/${e.path}` : null });
    },
    [left, right, openTab],
  );

  const nodes = useMemo(() => (result ? buildTree(result.entries, filter) : []), [result, filter]);
  const files = useMemo(() => (result ? result.entries.filter((e) => !e.isDir && keep(e, filter)) : []), [result, filter]);
  const c = result?.counts;
  const scanning = progress !== null && progress < 100;

  const renderRow = (row: TreeRow, isSelected: boolean) => {
    const e = row.node.data as FolderEntry;
    const g = GLYPH[e.status];
    return (
      <>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${e.status === "identical" ? "text-ink-500" : g.tone} ${isSelected ? "font-medium" : ""}`}>
          {e.isDir ? <FolderIcon /> : null}
          {e.name}
        </span>
        <Meta side={e.left} />
        <span title={g.label} aria-label={g.label} className={`w-7 shrink-0 text-center font-mono text-[12px] ${g.tone}`}>
          {g.mark}
        </span>
        <Meta side={e.right} />
      </>
    );
  };

  const columns: SortableColumn<FolderEntry>[] = [
    { id: "path", header: "Path", value: (e) => e.path, cell: (e) => <span className={`truncate font-mono text-[11.5px] ${GLYPH[e.status].tone}`}>{e.path}</span> },
    { id: "status", header: "Status", width: "110px", value: (e) => GLYPH[e.status].label, cell: (e) => <span className="text-[12px] text-ink-600">{GLYPH[e.status].label}</span> },
    { id: "lsize", header: "Left", width: "80px", numeric: true, align: "end", value: (e) => e.left?.size ?? -1, cell: (e) => <span className="font-mono text-[11px]">{fmtSize(e.left?.size)}</span> },
    { id: "rsize", header: "Right", width: "80px", numeric: true, align: "end", value: (e) => e.right?.size ?? -1, cell: (e) => <span className="font-mono text-[11px]">{fmtSize(e.right?.size)}</span> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="grid grid-cols-2 border-b border-ink-200">
        {[left, right].map((root, i) => (
          <div key={i} className={`flex h-10 min-w-0 items-center gap-2 px-3 ${i ? "border-l border-ink-200" : ""}`}>
            <span className={`size-1.5 shrink-0 rounded-full ${i ? "bg-add" : "bg-del"}`} aria-hidden />
            <span className="shrink-0 text-[12.5px] font-medium text-ink-800">{basename(root)}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-ink-400">{tildify(root)}</span>
          </div>
        ))}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-200 px-3">
        <SegmentedControl
          label="Show"
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
          options={[
            { value: "changed", label: "Changed" },
            { value: "all", label: "All" },
            { value: "left", label: "Left only" },
            { value: "right", label: "Right only" },
          ]}
        />
        <SegmentedControl
          label="View"
          value={mode}
          onValueChange={(v) => setMode(v as Mode)}
          options={[
            { value: "tree", label: "Tree" },
            { value: "list", label: "List" },
          ]}
        />
        <div className="flex items-center gap-3 font-mono text-[11.5px] tabular text-ink-500">
          <Count tone="text-mod" mark="≠" value={c?.different ?? 0} label="different" />
          <Count tone="text-del" mark="◧" value={c?.leftOnly ?? 0} label="left only" />
          <Count tone="text-add" mark="◨" value={c?.rightOnly ?? 0} label="right only" />
          <Count tone="text-ink-500" mark="≈" value={c?.equivalent ?? 0} label="equivalent" />
          <Count tone="text-ink-400" mark="=" value={c?.identical ?? 0} label="identical" />
        </div>
        <span className="flex-1" />
        <label className="flex cursor-default items-center gap-1.5 text-[12px] text-ink-600">
          <input
            type="checkbox"
            className="accent-[var(--color-accent)]"
            checked={respectGitignore}
            onChange={(e) => update({ respectGitignore: e.target.checked })}
          />
          Respect .gitignore
        </label>
        <LoadingButton onAction={scan} pendingLabel="Scanning" successLabel="Up to date">
          Rescan
        </LoadingButton>
      </div>

      {scanning && (
        <div className="border-b border-ink-200 px-3 py-2">
          <ProgressBar value={progress} label="Comparing folders" pendingLabel="Walking folders" completeLabel="Done" />
        </div>
      )}

      {error ? (
        <div className="grid flex-1 place-items-center text-[12.5px] text-bad">{error}</div>
      ) : result && files.length === 0 && nodes.length === 0 ? (
        <div className="grid flex-1 place-items-center text-center">
          <div>
            <div className="text-[14px] font-medium text-ink-800">{filter === "changed" ? "No differences" : "Nothing to show"}</div>
            <div className="mt-1 text-[12.5px] text-ink-500">
              {filter === "changed" ? `${c?.identical ?? 0} identical, ${c?.equivalent ?? 0} equivalent under current rules.` : "Try another filter."}
            </div>
          </div>
        </div>
      ) : mode === "tree" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex h-7 items-center gap-1 border-b border-ink-200 bg-ink-50/95 pl-[30px] pr-[11px] text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-400 backdrop-blur">
            <span className="flex-1">Name</span>
            <span className="w-[168px] text-right">Left</span>
            <span className="w-7" />
            <span className="w-[168px] text-right">Right</span>
          </div>
          <TreeView
            nodes={nodes}
            label="Folder comparison"
            expanded={expanded}
            onExpandedChange={setExpanded}
            selected={selected}
            onSelectedChange={setSelected}
            renderRow={renderRow}
            onActivate={(row) => openEntry(row.node.data as FolderEntry)}
            className="!rounded-none !border-0 !shadow-none"
          />
          <p className="px-4 py-3 text-[11.5px] text-ink-400">Double-click a file or press Return to compare it.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <SortableTable
            rows={files}
            columns={[
              ...columns,
              {
                id: "open",
                header: "",
                width: "64px",
                sortable: false,
                cell: (e) => (
                  <button type="button" className="rounded-[4px] px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent/[0.08]" onClick={() => openEntry(e)}>
                    Open
                  </button>
                ),
              },
            ]}
            getRowId={(e) => e.path}
            label="Files"
            rowHeight={34}
            defaultSort={{ columnId: "path", direction: "asc" }}
          />
        </div>
      )}
    </div>
  );
}

function Meta({ side }: { side: FolderEntry["left"] }) {
  return (
    <span className="flex w-[168px] shrink-0 justify-end gap-3 font-mono text-[10.5px] tabular text-ink-400">
      {side ? (
        <>
          <span>{fmtDate(side.modified)}</span>
          <span className="w-12 text-right">{fmtSize(side.size)}</span>
        </>
      ) : (
        <span className="text-ink-300">—</span>
      )}
    </span>
  );
}

function Count({ mark, value, tone, label }: { mark: string; value: number; tone: string; label: string }) {
  return (
    <span className="flex items-center gap-0.5" title={label}>
      <span className={tone}>{mark}</span>
      <ValueFlash value={value} label={label} />
    </span>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 14 14" width="12" height="12" className="mr-1.5 inline -translate-y-px text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1.75 3.5c0-.55.45-1 1-1h2.6l1.2 1.3h4.7c.55 0 1 .45 1 1v5.7c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1z" />
    </svg>
  );
}
