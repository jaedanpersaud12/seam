import { Popover } from "../components/interior/popover";
import { SegmentedControl } from "../components/interior/segmented-control";
import type { Algorithm, Whitespace } from "../lib/ipc";
import { useSettings } from "./settings";

/** The diff rules popover in the title bar: algorithm, whitespace, case, line endings. */
export function DiffRules() {
  const diff = useSettings((s) => s.diff);
  const setDiff = useSettings((s) => s.setDiff);
  const active = diff.whitespace !== "exact" || diff.ignoreCase || diff.ignoreEol;

  return (
    <Popover
      label="Diff rules"
      side="bottom"
      align="end"
      className="w-[340px] !shadow-pop"
      triggerClassName="!h-[26px] !rounded-[6px] !border-transparent !bg-transparent !px-2 !text-[12px] !font-medium !text-ink-600 hover:!bg-ink-500/[0.08] hover:!text-ink-800"
      trigger={
        <>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2 4h6m3 0h1M2 10h1m3 0h6" />
            <circle cx="9.5" cy="4" r="1.5" />
            <circle cx="4.5" cy="10" r="1.5" />
          </svg>
          Rules
          {/* The dot is always laid out; only its opacity changes, so the button never resizes. */}
          <span className={`size-[5px] rounded-full bg-accent transition-opacity duration-150 ${active ? "opacity-100" : "opacity-0"}`} aria-hidden />
        </>
      }
    >
      <div className="space-y-4 p-1">
        <Field label="Algorithm" hint="Patience lines up moved blocks and braces best.">
          <SegmentedControl
            label="Algorithm"
            value={diff.algorithm}
            onValueChange={(v) => setDiff({ algorithm: v as Algorithm })}
            options={[
              { value: "patience", label: "Patience" },
              { value: "histogram", label: "Histogram" },
              { value: "myers", label: "Myers" },
            ]}
            className="w-full"
          />
        </Field>
        <Field label="Whitespace">
          <SegmentedControl
            label="Whitespace"
            value={diff.whitespace}
            onValueChange={(v) => setDiff({ whitespace: v as Whitespace })}
            options={[
              { value: "exact", label: "Exact" },
              { value: "trailing", label: "Trailing" },
              { value: "change", label: "Amount" },
              { value: "all", label: "All" },
            ]}
            className="w-full"
          />
        </Field>
        <div className="space-y-1.5">
          <Toggle label="Ignore case" checked={diff.ignoreCase} onChange={(v) => setDiff({ ignoreCase: v })} />
          <Toggle label="Ignore line endings (CRLF vs LF)" checked={diff.ignoreEol} onChange={(v) => setDiff({ ignoreEol: v })} />
        </div>
      </div>
    </Popover>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] text-ink-500">{hint}</div>}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-default items-center gap-2 text-[12.5px] text-ink-700">
      <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
