import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect, useRef } from "react";
import type { Chunk } from "../../lib/ipc";

const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;

type Props = {
  chunks: Chunk[];
  total: number;
  current: number;
  viewport: [number, number];
  onScrub: (f: number) => void;
};

const tone = (k: Chunk["kind"]) => (k === "replace" ? "bg-mod" : k === "insert" ? "bg-add" : "bg-del");

/**
 * A horizontal map of the whole comparison: every change is a tick, the window is
 * what's on screen. Drag anywhere to scrub; the current-change marker springs to place.
 */
export function Overview({ chunks, total, current, viewport, onScrub }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const marker = useMotionValue(0);
  const markerLeft = useTransform(marker, (x) => `${x * 100}%`);
  const t = Math.max(1, total);
  const pos = (c: Chunk) => (c.left[0] + c.right[0]) / t;
  const end = (c: Chunk) => (c.left[1] + c.right[1]) / t;

  const target = current >= 0 && chunks[current] ? (pos(chunks[current]) + end(chunks[current])) / 2 : -1;
  useEffect(() => {
    if (target < 0) return;
    if (reduced) {
      marker.set(target);
      return;
    }
    // Interruptible: a new target starts from wherever the marker currently is.
    const controls = animate(marker, target, CELL);
    return () => controls.stop();
  }, [target, reduced, marker]);

  const scrub = (e: React.PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    onScrub(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className="border-b border-ink-200 bg-ink-50 px-3 py-[7px]">
      <div
        ref={track}
        role="slider"
        aria-label="Position in comparison"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(viewport[0] * 100)}
        tabIndex={-1}
        className="relative h-[10px] cursor-ew-resize touch-none rounded-[3px] bg-ink-200/60"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e);
        }}
      >
        {chunks.map((c, i) => (
          <span
            key={i}
            className={`absolute inset-y-[2px] rounded-[1px] ${tone(c.kind)} ${i === current ? "opacity-100" : "opacity-70"}`}
            style={{ left: `${pos(c) * 100}%`, width: `max(2px, ${(end(c) - pos(c)) * 100}%)` }}
          />
        ))}
        <span
          className="pointer-events-none absolute -inset-y-[2px] rounded-[3px] border border-ink-500/60 bg-ink-500/[0.07]"
          style={{ left: `${viewport[0] * 100}%`, width: `max(6px, ${(viewport[1] - viewport[0]) * 100}%)` }}
        />
        {target >= 0 && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute -top-[5px] -ml-[3px] size-[6px] rotate-45 rounded-[1px] bg-accent"
            style={{ left: markerLeft }}
          />
        )}
      </div>
    </div>
  );
}

