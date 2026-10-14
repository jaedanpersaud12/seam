import { basename, tildify, type Loaded } from "../../lib/ipc";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

type Props = { left: Loaded | null; right: Loaded | null; leftPath: string | null; rightPath: string | null };

/** Binary files get a verdict and fingerprints instead of a text diff. */
export function BinaryCard({ left, right, leftPath, rightPath }: Props) {
  const same = Boolean(left?.hash && left.hash === right?.hash);
  return (
    <div className="grid h-full place-items-center bg-surface p-6">
      <div className="w-full max-w-[640px] overflow-hidden rounded-[8px] border border-ink-200 shadow-card">
        <div className="flex items-center gap-3 border-b border-ink-200 bg-ink-50 px-4 py-3">
          <span className={`grid size-6 place-items-center rounded-[5px] text-[12px] font-semibold ${same ? "bg-ok/[0.12] text-ok" : "bg-mod/15 text-mod"}`}>{same ? "=" : "≠"}</span>
          <div>
            <div className="text-[13px] font-medium text-ink-800">Binary files {same ? "are identical" : "differ"}</div>
            <div className="text-[12px] text-ink-500">Seam compares binary files by content hash; there's no text to diff.</div>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-ink-200">
          {[
            [leftPath, left],
            [rightPath, right],
          ].map(([p, f], i) => (
            <div key={i} className="min-w-0 space-y-1 px-4 py-3">
              <div className="truncate text-[12.5px] font-medium text-ink-800">{p ? basename(p as string) : "—"}</div>
              <div className="truncate font-mono text-[11px] text-ink-400">{p ? tildify(p as string) : "Not present"}</div>
              {f && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  <dt className="text-ink-400">size</dt>
                  <dd className="text-ink-700 tabular">{size((f as Loaded).size)}</dd>
                  <dt className="text-ink-400">blake3</dt>
                  <dd className="truncate text-ink-700" title={(f as Loaded).hash}>
                    {(f as Loaded).hash.slice(0, 24)}…
                  </dd>
                </dl>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
