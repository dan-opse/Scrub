"use client";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { Range } from "@/lib/ranges";
import type { Comment } from "@/lib/types";
import { useFrame, type FrameStore } from "./usePlayer";
import { avatarColor, initials } from "./avatar";

export type TimelineHandle = { zoomIn: () => void; zoomOut: () => void; fit: () => void };

type Props = {
  ref?: Ref<TimelineHandle>;
  /** Frames in the video. */
  total: number;
  store: FrameStore;
  notes: Comment[];
  cuts: Comment[];
  /** This viewer may request cuts (dragging in the cut lane creates one). */
  canCut: boolean;
  draft: Range | null;
  inOut: { in: number | null; out: number | null };
  selectedId: string | null;
  canEdit: (c: Comment) => boolean;
  format: (f: number) => string;
  onSeek: (sourceFrame: number) => void;
  onSelect: (id: string) => void;
  onDraft: (r: Range | null, final: boolean) => void;
  onEditCut: (id: string, r: Range) => void;
};

type Drag =
  | { kind: "seek" }
  | { kind: "create"; anchor: number }
  | { kind: "draft-edge"; edge: "start" | "end" }
  | { kind: "cut-edge"; id: string; edge: "start" | "end"; range: Range };

// Top to bottom: cut-request lane, scrub bar + ruler, comment avatars.
const LANE_CUTS = 46;
const LANE_SCRUB = 30;
const LANE_NOTES = 30;
const SCRUB_TOP = LANE_CUTS;
const NOTES_TOP = LANE_CUTS + LANE_SCRUB;
const HEIGHT = LANE_CUTS + LANE_SCRUB + LANE_NOTES;

export function Timeline({ ref, ...p }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState({ start: 0, span: Math.max(1, p.total) });
  const drag = useRef<Drag | null>(null);
  const [editing, setEditing] = useState<{ id: string; range: Range } | null>(null);
  // Pointer x while hovering the cut lane (not dragging): drives the ghost cut line.
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useFrame(p.store);
  const playhead = frame;

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Keep the view valid when the timeline length changes (new version).
  const [lastTotal, setLastTotal] = useState(p.total);
  if (lastTotal !== p.total) {
    setLastTotal(p.total);
    setView({ start: 0, span: Math.max(1, p.total) });
  }

  const minSpan = Math.max(8, width / 10); // at most ~10 px per frame
  const clampView = (start: number, span: number) => {
    const s = Math.min(Math.max(span, minSpan), p.total);
    return { start: Math.max(0, Math.min(start, p.total - s)), span: s };
  };
  const zoomAround = (factor: number, center: number) =>
    setView((v) => clampView(center - (center - v.start) * factor, v.span * factor));

  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomAround(0.5, playhead),
    zoomOut: () => zoomAround(2, playhead),
    fit: () => setView({ start: 0, span: Math.max(1, p.total) }),
  }));

  // Follow the playhead when it leaves a zoomed view.
  if (view.span < p.total && (playhead < view.start || playhead > view.start + view.span)) {
    const next = clampView(playhead - view.span * 0.1, view.span);
    if (next.start !== view.start) setView(next);
  }

  const px = (d: number) => ((d - view.start) / view.span) * width;
  const toFrame = (x: number) => Math.round(view.start + (x / width) * view.span);

  useEffect(() => {
    const el = box.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const center = view.start + ((e.clientX - rect.left) / width) * view.span;
        zoomAround(e.deltaY > 0 ? 1.25 : 0.8, center);
      } else if (view.span < p.total && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView((v) => clampView(v.start + (e.deltaX / width) * v.span, v.span));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  function snap(d: number, alt: boolean) {
    if (alt) return d;
    const candidates: number[] = [playhead];
    if (p.inOut.in !== null) candidates.push(p.inOut.in);
    if (p.inOut.out !== null) candidates.push(p.inOut.out);
    for (const c of p.cuts) candidates.push(c.start_frame!, c.end_frame!);
    for (const n of p.notes) if (n.start_frame !== null) candidates.push(n.start_frame);
    let best = d;
    let bestPx = 6;
    for (const c of candidates) {
      if (c < 0) continue;
      const dist = Math.abs(px(c) - px(d));
      if (dist < bestPx) {
        bestPx = dist;
        best = c;
      }
    }
    return best;
  }

  const clampF = (d: number) => Math.max(0, Math.min(p.total, d));

  function pointerFrame(e: React.PointerEvent) {
    const rect = box.current!.getBoundingClientRect();
    return clampF(toFrame(e.clientX - rect.left));
  }

  function onDown(e: React.PointerEvent, d: Drag | null) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    box.current!.setPointerCapture(e.pointerId);
    const f = pointerFrame(e);
    const y = e.clientY - box.current!.getBoundingClientRect().top;
    if (!d) {
      const inCutLane = y < LANE_CUTS;
      d = p.canCut && inCutLane ? { kind: "create", anchor: snap(f, e.altKey) } : { kind: "seek" };
    }
    drag.current = d;
    setDragging(true);
    setHoverX(null);
    onMove(e);
  }

  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) {
      const rect = box.current!.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const inCutLane = p.canCut && y < LANE_CUTS;
      setHoverX(inCutLane ? e.clientX - rect.left : null);
      return;
    }
    const f = snap(pointerFrame(e), e.altKey);
    if (d.kind === "seek") {
      p.onSeek(Math.min(f, p.total - 1));
    } else if (d.kind === "create") {
      const r = { start: Math.min(d.anchor, f), end: Math.max(d.anchor, f) };
      p.onDraft(r.end > r.start ? r : null, false);
      p.onSeek(Math.min(f >= d.anchor ? f - 1 : f, p.total - 1));
    } else if (d.kind === "draft-edge" && p.draft) {
      const r = d.edge === "start" ? { start: Math.min(f, p.draft.end - 1), end: p.draft.end } : { start: p.draft.start, end: Math.max(f, p.draft.start + 1) };
      p.onDraft(r, false);
      p.onSeek(d.edge === "start" ? r.start : r.end - 1);
    } else if (d.kind === "cut-edge") {
      const base = editing?.id === d.id ? editing.range : d.range;
      const r = d.edge === "start" ? { start: Math.min(f, base.end - 1), end: base.end } : { start: base.start, end: Math.max(f, base.start + 1) };
      setEditing({ id: d.id, range: r });
      p.onSeek(d.edge === "start" ? r.start : r.end - 1);
    }
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (d.kind === "create" || d.kind === "draft-edge") p.onDraft(p.draft, true);
    if (d.kind === "cut-edge" && editing) {
      p.onEditCut(editing.id, editing.range);
      setEditing(null);
    }
  }

  // Ruler ticks: pick a step that leaves ~90px between labels.
  const framesPer90 = (90 / width) * view.span;
  const steps = [1, 2, 5, 10, 24, 48, 120, 240, 600, 1200, 2400, 6000, 12000, 36000, 72000, 144000];
  const step = steps.find((s) => s >= framesPer90) ?? steps.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(view.start / step) * step; t <= view.start + view.span; t += step) ticks.push(t);

  const band = (r: Range) => bandFor(r, view, width);

  return (
    <div
      ref={box}
      className="relative w-full touch-none select-none overflow-hidden rounded-md border border-line bg-bg"
      style={{ height: HEIGHT, cursor: "pointer" }}
      onPointerDown={(e) => onDown(e, null)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHoverX(null)}
    >
      {/* cut-request lane */}
      <div
        className={`absolute inset-x-0 ${p.canCut ? "border-dashed border-cut/30 bg-cut/[0.04] hover:bg-cut/[0.08]" : "border-transparent"}`}
        style={{ top: 0, height: LANE_CUTS, cursor: p.canCut ? "crosshair" : undefined }}
      >
        {p.canCut && !p.draft && !dragging && (
          <div
            className={`pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors ${
              hoverX !== null ? "text-cut" : "text-cut/60"
            }`}
          >
            <span aria-hidden>✂</span>
            <span>Drag here to request a cut</span>
          </div>
        )}
        {hoverX !== null && !dragging && (
          <div className="pointer-events-none absolute inset-y-1 z-10 w-0.5 -translate-x-1/2 rounded bg-cut/70" style={{ left: hoverX }}>
            <span className={`absolute -top-0.5 ${hoverX > width - 90 ? "right-1.5" : "left-1.5"} whitespace-nowrap rounded bg-cut px-1 text-[10px] leading-4 text-white`}>
              {p.format(Math.min(toFrame(hoverX), p.total - 1))}
            </span>
          </div>
        )}
        {p.cuts.map((c) => {
            const r = editing?.id === c.id ? editing.range : { start: c.start_frame!, end: c.end_frame! };
            const b = band(r);
            if (!b || b.left > width || b.left + b.width < 0) return null;
            const sel = c.id === p.selectedId;
            const style =
              c.status === "open"
                ? "cut-stripes border-cut"
                : c.status === "accepted"
                  ? "bg-cut/60 border-cut"
                  : c.status === "rejected"
                    ? "border-ink-3 bg-transparent"
                    : "border-ink-3 bg-ink-3/40";
            const editable = p.canEdit(c);
            return (
              <div key={c.id} className="absolute top-1 bottom-1" style={{ left: b.left, width: b.width }}>
                <button
                  className={`absolute inset-0 rounded-sm border ${style} ${sel ? "ring-2 ring-white" : ""}`}
                  title={`Cut request by ${c.author_name} (${c.status}): ${c.body}`}
                  aria-label={`Cut request by ${c.author_name}, ${p.format(c.start_frame!)} to ${p.format(c.end_frame!)}, ${c.status}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    p.onSelect(c.id);
                  }}
                >
                  {c.status === "done" && <span className="text-[10px] text-ink">✓</span>}
                </button>
                {editable && sel && (
                  <>
                    <Handle left={0} onPointerDown={(e) => onDown(e, { kind: "cut-edge", id: c.id, edge: "start", range: r })} label="Cut start" />
                    <Handle left={b.width} onPointerDown={(e) => onDown(e, { kind: "cut-edge", id: c.id, edge: "end", range: r })} label="Cut end" />
                  </>
                )}
              </div>
            );
          })}
        {p.draft &&
          (() => {
            const b = band(p.draft);
            if (!b) return null;
            return (
              <div className="absolute top-1 bottom-1" style={{ left: b.left, width: b.width }}>
                <div className="cut-stripes absolute inset-0 rounded-sm border-2 border-cut" />
                <Handle left={0} onPointerDown={(e) => onDown(e, { kind: "draft-edge", edge: "start" })} label="Draft cut start" />
                <Handle left={b.width} onPointerDown={(e) => onDown(e, { kind: "draft-edge", edge: "end" })} label="Draft cut end" />
              </div>
            );
          })()}
      </div>

      {/* scrub bar + ruler */}
      <div className="absolute inset-x-0 border-t border-line bg-panel/40" style={{ top: SCRUB_TOP, height: LANE_SCRUB }}>
        {ticks.map((t) => (
          <div key={t} className="absolute top-0 h-full border-l border-line" style={{ left: px(t) }}>
            <span className="absolute left-1 top-1 font-mono text-[10px] text-ink-3">{p.format(Math.min(t, p.total - 1))}</span>
          </div>
        ))}
        {p.inOut.in !== null && (
          <div
            className="absolute top-0 h-full bg-accent/15"
            style={{
              left: px(p.inOut.in),
              width: Math.max(2, px(p.inOut.out ?? p.inOut.in + 1) - px(p.inOut.in)),
            }}
          />
        )}
      </div>

      {/* comment avatars, Frame.io style */}
      <div className="absolute inset-x-0 border-t border-line" style={{ top: NOTES_TOP, height: LANE_NOTES }}>
        {p.notes.map((n) => {
          const a = n.start_frame!;
          const left = px(a);
          if (left < -12 || left > width + 12) return null;
          const sel = n.id === p.selectedId;
          const done = n.status === "done";
          return (
            <button
              key={n.id}
              title={`${n.author_name}: ${n.body}`}
              aria-label={`Comment by ${n.author_name} at ${p.format(a)}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                p.onSelect(n.id);
              }}
              className={`absolute top-1/2 z-10 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[9px] font-semibold text-white shadow ring-offset-1 ring-offset-bg transition-transform hover:z-20 hover:scale-110 ${sel ? "z-20 ring-2 ring-white" : ""} ${done ? "opacity-40" : ""}`}
              style={{ left, background: avatarColor(n.author_id ?? n.author_name) }}
            >
              {initials(n.author_name)}
            </button>
          );
        })}
      </div>

      {/* zoom indicator */}
      {view.span < p.total && (
        <div className="absolute bottom-0 h-0.5 bg-ink-3" style={{ left: (view.start / p.total) * width, width: (view.span / p.total) * width }} />
      )}

      {/* playhead */}
      <div className="pointer-events-none absolute top-0 z-30 h-full w-px bg-accent" style={{ left: px(playhead) }}>
        <div className="absolute -left-1 top-0 h-2 w-2 rotate-45 bg-accent" />
      </div>
    </div>
  );
}

function bandFor(r: Range, view: { start: number; span: number }, width: number) {
  const left = ((r.start - view.start) / view.span) * width;
  const right = ((r.end - view.start) / view.span) * width;
  return { left, width: Math.max(3, right - left) };
}

function Handle({ left, onPointerDown, label }: { left: number; onPointerDown: (e: React.PointerEvent) => void; label: string }) {
  return (
    <button
      aria-label={label}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      className="absolute top-0 z-20 h-full w-2.5 -translate-x-1/2 cursor-ew-resize rounded-sm bg-white/90"
      style={{ left }}
    />
  );
}
