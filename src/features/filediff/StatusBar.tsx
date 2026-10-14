import { ValueFlash } from "../../components/interior/value-flash";
import type { DiffOptions, DiffResult } from "../../lib/ipc";
import type { Side } from "../../lib/diffmap";

const WS: Record<DiffOptions["whitespace"], string> = {
  exact: "Exact whitespace",
  trailing: "Ignoring trailing whitespace",
  change: "Ignoring whitespace changes",
  all: "Ignoring all whitespace",
};

type Props = {
  diff: DiffResult | null;
  options: DiffOptions;
  cursor: { side: Side; line: number; col: number };
  current: number;
};

export function StatusBar({ diff, options, cursor, current }: Props) {
  const ignoring = [WS[options.whitespace], options.ignoreCase && "case", options.ignoreEol && "line endings"].filter(Boolean).join(" · ");
  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-ink-200 bg-ink-50 px-3 text-[11.5px] text-ink-500">
      {diff && diff.equivalent ? (
        <span className="font-medium text-ink-700">{diff.identical ? "Identical" : "Equivalent under current rules"}</span>
      ) : (
        <div className="flex items-center gap-2 font-mono tabular">
          <Stat label="lines added" sign="+" tone="text-add" value={diff?.added ?? 0} />
          <Stat label="lines removed" sign="−" tone="text-del" value={diff?.removed ?? 0} />
          <Stat label="blocks changed" sign="~" tone="text-mod" value={diff?.changed ?? 0} />
          {diff && (
            <span className="ml-2 text-ink-400">
              {current >= 0 ? `${current + 1} of ${diff.chunks.length}` : `${diff.chunks.length} ${diff.chunks.length === 1 ? "change" : "changes"}`}
            </span>
          )}
        </div>
      )}
      <span className="flex-1" />
      <span className="truncate">
        {options.algorithm[0].toUpperCase() + options.algorithm.slice(1)} · {ignoring}
      </span>
      <span className="font-mono tabular text-ink-400">
        {cursor.side === "left" ? "L" : "R"} {cursor.line}:{cursor.col}
      </span>
    </div>
  );
}

function Stat({ sign, value, tone, label }: { sign: string; value: number; tone: string; label: string }) {
  return (
    <span className="flex items-center">
      <span className={tone}>{sign}</span>
      <ValueFlash value={value} label={label} className="!gap-0.5 !py-0 !pl-0.5 !pr-1.5 !text-[11.5px] !font-normal" />
    </span>
  );
}
