import { invoke } from "@tauri-apps/api/core";

export type Eol = "lf" | "crlf" | "cr" | "mixed" | "none";
export type Algorithm = "patience" | "myers" | "histogram";
export type Whitespace = "exact" | "trailing" | "change" | "all";

export type DiffOptions = {
  algorithm: Algorithm;
  whitespace: Whitespace;
  ignoreCase: boolean;
  ignoreEol: boolean;
};

export type Loaded = {
  path: string;
  text: string;
  encoding: string;
  bom: boolean;
  eol: Eol;
  binary: boolean;
  size: number;
  hash: string;
  modified: number | null;
  readonly: boolean;
};

export type ChunkKind = "insert" | "delete" | "replace";

export type LinePair = {
  leftLine: number;
  rightLine: number;
  left: [number, number][];
  right: [number, number][];
};

export type Chunk = {
  kind: ChunkKind;
  /** [start, end) 0-based line ranges. */
  left: [number, number];
  right: [number, number];
  inline: LinePair[];
};

export type DiffResult = {
  chunks: Chunk[];
  added: number;
  removed: number;
  changed: number;
  identical: boolean;
  equivalent: boolean;
  leftLines: number;
  rightLines: number;
};

export type FolderStatus = "identical" | "equivalent" | "different" | "leftOnly" | "rightOnly" | "error";

export type FolderEntry = {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  status: FolderStatus;
  left: { size: number; modified: number | null } | null;
  right: { size: number; modified: number | null } | null;
  binary: boolean;
};

export type FolderResult = {
  leftRoot: string;
  rightRoot: string;
  entries: FolderEntry[];
  counts: { identical: number; equivalent: number; different: number; leftOnly: number; rightOnly: number; error: number };
};

export type FolderOptions = {
  diff: DiffOptions;
  respectGitignore: boolean;
  excludes: string[];
};

export type Launch = { left: string | null; right: string | null; wait: boolean; newWindow: boolean };
export type Stat = { kind: "file" | "dir" | "missing"; size: number };

export const ipc = {
  launchArgs: () => invoke<Launch>("launch_args"),
  loadFile: (path: string) => invoke<Loaded>("load_file", { path }),
  saveFile: (path: string, text: string, f: Pick<Loaded, "encoding" | "bom" | "eol">) =>
    invoke<Loaded>("save_file", { path, text, encoding: f.encoding, bom: f.bom, eol: f.eol }),
  diffTexts: (left: string, right: string, options: DiffOptions) => invoke<DiffResult>("diff_texts", { left, right, options }),
  compareFolders: (job: string, left: string, right: string, options: FolderOptions) =>
    invoke<FolderResult>("compare_folders", { job, left, right, options }),
  stat: (path: string) => invoke<Stat>("stat_path", { path }),
  watch: (path: string) => invoke<void>("watch_path", { path }),
  unwatch: (path: string) => invoke<void>("unwatch_path", { path }),
  installCli: () => invoke<{ link: string; onPath: boolean }>("install_cli"),
  configureGit: () => invoke<void>("configure_git"),
};

export const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
export const dirname = (p: string) => {
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/") || "/";
};

/** Shortens a path for display: home becomes ~. */
export const tildify = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
