// Frame and timecode maths. Every moment in Scrub is a whole frame number on a version.
// Seconds only exist at the edge, when talking to the <video> element.

export type Rate = { num: number; den: number };

const STANDARD_RATES: Rate[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 120, den: 1 },
];

export const fps = (r: Rate) => r.num / r.den;

/** Snap a measured rate to the nearest standard rate if within 0.05%. */
export function snapRate(measured: number): { rate: Rate; snapped: boolean } {
  for (const r of STANDARD_RATES) {
    if (Math.abs(fps(r) - measured) / fps(r) < 0.0005) return { rate: r, snapped: true };
  }
  // Fall back to a millisecond-precision fraction.
  return { rate: { num: Math.round(measured * 1000), den: 1000 }, snapped: false };
}

/** Labels per second used by timecode (24 for 23.976, 30 for 29.97, ...). */
export const nominal = (r: Rate) => Math.round(fps(r));

/** Drop-frame timecode only exists for 29.97 and 59.94. */
export const canDropFrame = (r: Rate) => r.den === 1001 && (nominal(r) === 30 || nominal(r) === 60);

/** Seek target for frame n: the middle of the frame, so float error lands on the right frame. */
export const frameToSeekTime = (n: number, r: Rate, firstPts = 0) => firstPts + ((n + 0.5) * r.den) / r.num;

/** Frame index of a presented frame, from requestVideoFrameCallback's mediaTime. */
export const mediaTimeToFrame = (t: number, r: Rate, firstPts = 0) =>
  Math.max(0, Math.round(((t - firstPts) * r.num) / r.den));

/** Frame index from currentTime when no frame callback is available (approximate). */
export const currentTimeToFrame = (t: number, r: Rate, firstPts = 0) =>
  Math.max(0, Math.floor(((t - firstPts) * r.num) / r.den + 1e-6));

/** Real-time seconds for a frame count. */
export const framesToSeconds = (frames: number, r: Rate) => (frames * r.den) / r.num;

const pad = (n: number) => String(n).padStart(2, "0");

/** Frame count (already including the start offset) to SMPTE timecode. */
export function framesToTimecode(n: number, r: Rate, dropFrame = false): string {
  const nom = nominal(r);
  let f = Math.max(0, Math.floor(n));
  const df = dropFrame && canDropFrame(r);
  if (df) {
    const drop = nom === 30 ? 2 : 4;
    const per10Min = nom * 600 - drop * 9;
    const perMin = nom * 60 - drop;
    const tens = Math.floor(f / per10Min);
    const rem = f % per10Min;
    f += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
  }
  const ff = f % nom;
  const ss = Math.floor(f / nom) % 60;
  const mm = Math.floor(f / (nom * 60)) % 60;
  const hh = Math.floor(f / (nom * 3600)) % 24;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${df ? ";" : ":"}${pad(ff)}`;
}

/** SMPTE timecode to frame count. Returns null for malformed input. */
export function timecodeToFrames(tc: string, r: Rate, dropFrame = false): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/.exec(tc.trim());
  if (!m) return null;
  const [hh, mm, ss, ff] = m.slice(1).map(Number);
  const nom = nominal(r);
  if (mm > 59 || ss > 59 || ff >= nom) return null;
  const df = dropFrame && canDropFrame(r);
  let frames = ((hh * 60 + mm) * 60 + ss) * nom + ff;
  if (df) {
    const drop = nom === 30 ? 2 : 4;
    const totalMinutes = hh * 60 + mm;
    if (mm % 10 !== 0 && ss === 0 && ff < drop) return null; // label does not exist
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

/** Client-facing clock: M:SS.s (or H:MM:SS.s), from real time. */
export function formatClock(frames: number, r: Rate, decimals = 1): string {
  const total = framesToSeconds(frames, r);
  const sign = total < 0 ? "-" : "";
  const t = Math.abs(total);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sStr = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return h > 0 ? `${sign}${h}:${pad(m)}:${sStr}` : `${sign}${m}:${sStr}`;
}

/** Duration like "4.5 s" or "1:02.3". */
export function formatDuration(frames: number, r: Rate): string {
  const s = framesToSeconds(frames, r);
  return s < 60 ? `${s.toFixed(1)} s` : formatClock(frames, r);
}

export type TimeDisplay = "clock" | "timecode" | "frames";

export function formatTime(
  frame: number,
  v: { rate: Rate; startTcFrames: number; dropFrame: boolean },
  mode: TimeDisplay,
): string {
  if (mode === "frames") return String(frame);
  if (mode === "timecode") return framesToTimecode(frame + v.startTcFrames, v.rate, v.dropFrame);
  return formatClock(frame, v.rate);
}
