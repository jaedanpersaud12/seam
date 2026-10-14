import { motion, useReducedMotion } from "motion/react";
import { useCopyToClipboard } from "../../components/interior/copy-button";
import { Tooltip } from "../../components/interior/tooltip-group";
import { basename, dirname, tildify, type Loaded } from "../../lib/ipc";
import type { Side } from "../../lib/diffmap";

const EOL: Record<Loaded["eol"], string> = { lf: "LF", crlf: "CRLF", cr: "CR", mixed: "Mixed EOL", none: "" };
const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;

type Props = { path: string | null; file: Loaded | null; dirty: boolean; side: Side; scratch?: boolean };

export function PaneHeader({ path, file, dirty, side, scratch }: Props) {
  const reduced = useReducedMotion();
  const { copy, copied } = useCopyToClipboard({ timeout: 1400 });
  const name = path ? basename(path) : scratch ? `${side === "left" ? "Left" : "Right"} text` : null;

  // Only show file facts that are worth noticing; UTF-8 and LF are the quiet defaults.
  const chips = file && path
    ? [file.readonly && "read-only", (file.encoding !== "UTF-8" || file.bom) && `${file.encoding}${file.bom ? " BOM" : ""}`, file.eol !== "lf" && EOL[file.eol]].filter(Boolean)
    : [];

  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-2 px-3">
      <span className={`size-1.5 shrink-0 rounded-full ${side === "left" ? "bg-del" : "bg-add"}`} aria-hidden />
      {name ? (
        <span className="shrink-0 text-[12.5px] font-medium text-ink-800">{name}</span>
      ) : (
        <span className="text-[12px] italic text-ink-400">Not present on the {side} side</span>
      )}
      {/* Always laid out, so the name and path never shift when it appears. */}
      <motion.span
        aria-label={dirty ? "Unsaved changes" : undefined}
        className="-ml-1 size-[6px] shrink-0 rounded-full bg-accent"
        initial={false}
        animate={{ opacity: dirty ? 1 : 0, scale: dirty || reduced ? 1 : 0.4 }}
        transition={reduced ? { duration: 0 } : CROSSFADE}
      />
      {path ? (
        <Tooltip label={copied ? "Copied" : `${tildify(path)} · click to copy`} side="bottom" className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => void copy(path)}
            className="block w-full min-w-0 truncate rounded-[3px] text-left font-mono text-[11px] text-ink-400 outline-none hover:text-ink-600 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
            // Truncate from the start so the nearest folders stay visible.
            style={{ direction: "rtl" }}
          >
            <bdi>{tildify(dirname(path))}</bdi>
          </button>
        </Tooltip>
      ) : (
        <span className="flex-1" />
      )}
      {chips.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-ink-500">
          {chips.map((c) => (
            <span key={String(c)} className="rounded-[3px] border border-ink-200 px-1.5 leading-[16px]">
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
