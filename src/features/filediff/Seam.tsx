import { motion, useReducedMotion } from "motion/react";
import type { Ribbon } from "./geometry";

// Same press spring the interior buttons use.
const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;

export const SEAM_WIDTH = 56;

const tone = (kind: Ribbon["kind"]) => (kind === "replace" ? "var(--mod-bar)" : kind === "insert" ? "var(--add-bar)" : "var(--del-bar)");

function path({ l, r }: Ribbon, w: number) {
  // Give empty sides a 2px lip so the ribbon still reads as a shape.
  const [l0, l1] = l[1] - l[0] < 2 ? [l[0] - 1, l[0] + 1] : l;
  const [r0, r1] = r[1] - r[0] < 2 ? [r[0] - 1, r[0] + 1] : r;
  const c = w / 2;
  return `M0 ${l0} C${c} ${l0} ${c} ${r0} ${w} ${r0} L${w} ${r1} C${c} ${r1} ${c} ${l1} 0 ${l1} Z`;
}

type Props = {
  ribbons: Ribbon[];
  current: number;
  readOnly: { left: boolean; right: boolean };
  onCopy: (index: number, to: "left" | "right") => void;
  onPick: (index: number) => void;
};

/** The band between the panes: one ribbon per change, with copy arrows on hover. */
export function Seam({ ribbons, current, readOnly, onCopy, onPick }: Props) {
  const reduced = useReducedMotion();
  const w = SEAM_WIDTH;
  return (
    <div className="group/seam relative h-full shrink-0 overflow-hidden border-x border-ink-200 bg-ink-50" style={{ width: w }}>
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        {ribbons.map((rb) => {
          const on = rb.index === current;
          return (
            <path
              key={rb.index}
              d={path(rb, w)}
              fill={tone(rb.kind)}
              fillOpacity={on ? 0.26 : 0.12}
              stroke={tone(rb.kind)}
              strokeOpacity={on ? 0.9 : 0.45}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              className="cursor-pointer transition-[fill-opacity,stroke-opacity] duration-150"
              style={{ pointerEvents: "all" }}
              onClick={() => onPick(rb.index)}
            />
          );
        })}
      </svg>
      {ribbons.map((rb) => {
        const on = rb.index === current;
        const ly = (rb.l[0] + rb.l[1]) / 2;
        const ry = (rb.r[0] + rb.r[1]) / 2;
        const btn = `absolute grid size-[18px] place-items-center rounded-[4px] bg-surface text-ink-600 shadow-thumb outline-none transition-opacity duration-150 hover:text-ink-900 focus-visible:opacity-100 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] ${on ? "opacity-100" : "opacity-0 group-hover/seam:opacity-100"}`;
        return (
          <div key={rb.index}>
            {!readOnly.right && (
              <motion.button
                type="button"
                aria-label="Copy change to the right"
                title="Copy to right (⌘])"
                className={btn}
                style={{ left: 4, top: ly - 9 }}
                whileTap={reduced ? undefined : { y: 1 }}
                transition={CELL}
                onClick={() => onCopy(rb.index, "right")}
              >
                <Arrow dir={1} />
              </motion.button>
            )}
            {!readOnly.left && (
              <motion.button
                type="button"
                aria-label="Copy change to the left"
                title="Copy to left (⌘[)"
                className={btn}
                style={{ right: 4, top: ry - 9 }}
                whileTap={reduced ? undefined : { y: 1 }}
                transition={CELL}
                onClick={() => onCopy(rb.index, "left")}
              >
                <Arrow dir={-1} />
              </motion.button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Arrow({ dir }: { dir: 1 | -1 }) {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: dir < 0 ? "scaleX(-1)" : undefined }}>
      <path d="M2.5 6h7M6.5 3 9.5 6l-3 3" />
    </svg>
  );
}
