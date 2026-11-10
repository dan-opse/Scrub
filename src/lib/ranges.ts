// Range maths for cut requests and the preview-without-cuts timeline.
// Ranges are frames, half-open: [start, end).

export type Range = { start: number; end: number };

/** Merge overlapping or touching ranges. Output is sorted and disjoint. */
export function union(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

export const removed = (u: Range[]) => u.reduce((sum, r) => sum + (r.end - r.start), 0);

/** Preview frame -> source frame. u must be a union() result. */
export function previewToSource(p: number, u: Range[]): number {
  let f = p;
  for (const r of u) {
    if (f >= r.start) f += r.end - r.start;
    else break;
  }
  return f;
}

/** Source frame -> preview frame. A frame inside a cut lands on the join. */
export function sourceToPreview(f: number, u: Range[]): number {
  let removedBefore = 0;
  for (const r of u) {
    if (f >= r.end) removedBefore += r.end - r.start;
    else if (f >= r.start) return r.start - removedBefore;
    else break;
  }
  return f - removedBefore;
}

/** The range containing frame f, if any. */
export const rangeAt = (f: number, u: Range[]) => u.find((r) => f >= r.start && f < r.end);

/** First range starting at or after frame f. */
export const nextRangeFrom = (f: number, u: Range[]) => u.find((r) => r.start >= f);
