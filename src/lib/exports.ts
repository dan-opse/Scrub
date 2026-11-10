// Export comments and cut requests for DaVinci Resolve (marker EDL), Premiere Pro (FCP7 XML) and spreadsheets (CSV).
import { type Rate, canDropFrame, framesToSeconds, framesToTimecode, nominal } from "./timecode";

export type ExportItem = {
  id: string;
  kind: "note" | "cut";
  startFrame: number | null;
  endFrame: number | null;
  body: string;
  authorName: string;
  authorRole: "editor" | "guest";
  status: string;
  replies: number;
};

export type ExportVersion = {
  title: string; // e.g. "Brand film - v3"
  rate: Rate;
  startTcFrames: number;
  dropFrame: boolean;
  frameCount: number;
  width?: number | null;
  height?: number | null;
};

const COLOR = { note: "ResolveColorBlue", cut: "ResolveColorRed", done: "ResolveColorGreen" } as const;

/** EDL text must be plain ASCII on one line; "|" would start a new field. */
export function edlSafe(s: string, max = 240): string {
  const ascii = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\r?\n+/g, " / ")
    .replace(/\|/g, "/")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ascii.length > max ? ascii.slice(0, max - 15).trimEnd() + "... (see Scrub)" : ascii;
}

export function markerName(it: ExportItem): string {
  const who = `${it.authorName}${it.authorRole === "editor" ? " (editor)" : ""}`;
  if (it.kind === "cut") return `CUT (${it.status}) ${who}: ${it.body || "remove this section"}`;
  return `${who}: ${it.body}`;
}

const timed = (items: ExportItem[]) =>
  items.filter((i) => i.startFrame !== null).sort((a, b) => a.startFrame! - b.startFrame!);

export function toResolveEdl(v: ExportVersion, items: ExportItem[]): string {
  const df = v.dropFrame && canDropFrame(v.rate);
  const tc = (f: number) => framesToTimecode(f + v.startTcFrames, v.rate, df);
  const lines = [`TITLE: ${edlSafe(v.title, 70)}`, `FCM: ${df ? "DROP FRAME" : "NON-DROP FRAME"}`, ""];
  timed(items).forEach((it, i) => {
    const start = it.startFrame!;
    const end = it.endFrame ?? start + 1;
    const n = String(i + 1).padStart(3, "0");
    lines.push(`${n}  001      V     C        ${tc(start)} ${tc(end)} ${tc(start)} ${tc(end)}`);
    const color = it.kind === "cut" ? (it.status === "done" ? COLOR.done : COLOR.cut) : COLOR.note;
    lines.push(` |C:${color} |M:${edlSafe(markerName(it))} |D:${end - start}`);
    lines.push("");
  });
  return lines.join("\r\n");
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function toPremiereXml(v: ExportVersion, items: ExportItem[]): string {
  const ntsc = v.rate.den === 1001 ? "TRUE" : "FALSE";
  const tb = nominal(v.rate);
  const df = v.dropFrame && canDropFrame(v.rate);
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const markers = timed(items)
    .map((it) => {
      const name = markerName(it).replace(/\s*\r?\n+\s*/g, " / ").slice(0, 200);
      return `    <marker><name>${xml(name)}</name><comment>${xml(it.body)}</comment><in>${it.startFrame}</in><out>${it.endFrame ?? -1}</out></marker>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence>
    <name>${xml(v.title)} - Scrub markers</name>
    <duration>${v.frameCount}</duration>
    ${rate}
    <timecode>${rate}<string>${framesToTimecode(v.startTcFrames, v.rate, df)}</string><frame>${v.startTcFrames}</frame><displayformat>${df ? "DF" : "NDF"}</displayformat></timecode>
    <media>
      <video><format><samplecharacteristics>${rate}<width>${v.width ?? 1920}</width><height>${v.height ?? 1080}</height></samplecharacteristics></format><track/></video>
      <audio><track/></audio>
    </media>
${markers}
  </sequence>
</xmeml>
`;
}

const csvCell = (s: string | number) => {
  const str = String(s);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

export function toCsv(v: ExportVersion, items: ExportItem[], linkFor: (id: string) => string): string {
  const df = v.dropFrame && canDropFrame(v.rate);
  const tc = (f: number | null) => (f === null ? "" : framesToTimecode(f + v.startTcFrames, v.rate, df));
  const header = ["Timecode In", "Timecode Out", "Duration (frames)", "Duration (seconds)", "Type", "Status", "Author", "Role", "Name", "Comment", "Replies", "Link"];
  const rows = [...timed(items), ...items.filter((i) => i.startFrame === null)].map((it) => {
    const dur = it.startFrame !== null && it.endFrame !== null ? it.endFrame - it.startFrame : "";
    return [
      tc(it.startFrame),
      tc(it.endFrame),
      dur,
      dur === "" ? "" : framesToSeconds(dur as number, v.rate).toFixed(2),
      it.kind,
      it.status,
      it.authorName,
      it.authorRole,
      it.body.slice(0, 60),
      it.body,
      it.replies,
      linkFor(it.id),
    ].map(csvCell);
  });
  return "﻿" + [header, ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}

export function cutList(v: ExportVersion, items: ExportItem[], clock: (f: number) => string): string {
  const cuts = timed(items).filter((i) => i.kind === "cut");
  const total = cuts.reduce((s, c) => s + (c.endFrame! - c.startFrame!), 0);
  const head = `${v.title} - ${cuts.length} cut request${cuts.length === 1 ? "" : "s"}, ${framesToSeconds(total, v.rate).toFixed(1)} s total`;
  const lines = cuts.map(
    (c, i) =>
      `${i + 1}. ${clock(c.startFrame!)}-${clock(c.endFrame!)} (${framesToSeconds(c.endFrame! - c.startFrame!, v.rate).toFixed(1)} s) ${c.authorName}: ${c.body || "remove"}`,
  );
  return [head, ...lines].join("\n");
}
