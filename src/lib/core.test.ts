import { describe, expect, it } from "vitest";
import {
  framesToTimecode,
  timecodeToFrames,
  frameToSeekTime,
  mediaTimeToFrame,
  currentTimeToFrame,
  snapRate,
  formatClock,
  type Rate,
} from "./timecode";
import { union, removed, previewToSource, sourceToPreview, type Range } from "./ranges";
import { toResolveEdl, toPremiereXml, toCsv, edlSafe, type ExportItem } from "./exports";

const R23: Rate = { num: 24000, den: 1001 };
const R25: Rate = { num: 25, den: 1 };
const R2997: Rate = { num: 30000, den: 1001 };
const R5994: Rate = { num: 60000, den: 1001 };

describe("timecode", () => {
  it("formats non-drop-frame", () => {
    expect(framesToTimecode(0, R23)).toBe("00:00:00:00");
    expect(framesToTimecode(24 * 3600, R23)).toBe("01:00:00:00");
    expect(framesToTimecode(25 * 61 + 3, R25)).toBe("00:01:01:03");
  });

  it("formats drop-frame at the minute boundaries", () => {
    expect(framesToTimecode(1799, R2997, true)).toBe("00:00:59;29");
    expect(framesToTimecode(1800, R2997, true)).toBe("00:01:00;02");
    expect(framesToTimecode(17982, R2997, true)).toBe("00:10:00;00");
    expect(framesToTimecode(107892, R2997, true)).toBe("01:00:00;00");
  });

  it.each([
    ["23.976", R23, false],
    ["25", R25, false],
    ["29.97 NDF", R2997, false],
    ["29.97 DF", R2997, true],
    ["59.94 DF", R5994, true],
  ] as const)("round-trips every frame of 24 hours at %s", (_, r, df) => {
    const nom = Math.round(r.num / r.den);
    const drop = nom === 30 ? 2 : 4;
    const limit = df ? 144 * (nom * 600 - drop * 9) : 24 * 3600 * nom;
    for (let f = 0; f < limit; f += 7) {
      expect(timecodeToFrames(framesToTimecode(f, r, df), r, df)).toBe(f);
    }
  });

  it("rejects drop-frame labels that do not exist", () => {
    expect(timecodeToFrames("00:01:00;00", R2997, true)).toBeNull();
    expect(timecodeToFrames("00:10:00;00", R2997, true)).toBe(17982);
  });

  it("seeks to the middle of a frame and reads it back exactly", () => {
    for (const r of [R23, R25, R2997, R5994]) {
      for (let f = 0; f < 200000; f += 997) {
        expect(currentTimeToFrame(frameToSeekTime(f, r, 0.042), r, 0.042)).toBe(f);
        // the presented frame's own timestamp (start of frame) also maps back exactly
        expect(mediaTimeToFrame(0.042 + (f * r.den) / r.num, r, 0.042)).toBe(f);
      }
    }
  });

  it("snaps measured rates to standard rates", () => {
    expect(snapRate(23.976).rate).toEqual(R23);
    expect(snapRate(29.97002997).rate).toEqual(R2997);
    expect(snapRate(25.0001).rate).toEqual(R25);
    expect(snapRate(17.3).snapped).toBe(false);
  });

  it("formats clock time", () => {
    expect(formatClock(0, R25)).toBe("0:00.0");
    expect(formatClock(25 * 72 + 10, R25)).toBe("1:12.4");
    expect(formatClock(25 * 3700, R25)).toBe("1:01:40.0");
  });
});

// deterministic pseudo-random for property tests
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("ranges", () => {
  it("merges overlapping and touching ranges", () => {
    expect(union([{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 30, end: 35 }, { start: 50, end: 60 }])).toEqual([
      { start: 10, end: 35 },
      { start: 50, end: 60 },
    ]);
  });

  it("property: preview/source mapping is consistent for random range sets", () => {
    const rand = rng(42);
    for (let trial = 0; trial < 500; trial++) {
      const frameCount = 200 + Math.floor(rand() * 2000);
      const raw: Range[] = Array.from({ length: Math.floor(rand() * 12) }, () => {
        const s = Math.floor(rand() * (frameCount - 1));
        return { start: s, end: Math.min(frameCount, s + 1 + Math.floor(rand() * 200)) };
      });
      const u = union(raw);
      // disjoint, sorted, same coverage
      for (let i = 1; i < u.length; i++) expect(u[i].start).toBeGreaterThan(u[i - 1].end);
      const covered = (f: number) => raw.some((r) => f >= r.start && f < r.end);
      const inU = (f: number) => u.some((r) => f >= r.start && f < r.end);
      for (let f = 0; f < frameCount; f++) expect(inU(f)).toBe(covered(f));

      const kept = frameCount - removed(u);
      for (let p = 0; p < kept; p++) {
        const src = previewToSource(p, u);
        expect(inU(src)).toBe(false);
        expect(src).toBeLessThan(frameCount);
        expect(sourceToPreview(src, u)).toBe(p);
      }
    }
  });
});

describe("exports", () => {
  const v = { title: "Brand film - v1", rate: R23, startTcFrames: 24 * 3600, dropFrame: false, frameCount: 4000, width: 1920, height: 1080 };
  const items: ExportItem[] = [
    { id: "a", kind: "cut", startFrame: 1738, endFrame: 1846, body: "drop the second take & the pause", authorName: "Sam", authorRole: "guest", status: "open", replies: 0 },
    { id: "b", kind: "note", startFrame: 120, endFrame: null, body: "Logo bigger | “here”\nplease", authorName: "Sam", authorRole: "guest", status: "open", replies: 2 },
    { id: "c", kind: "note", startFrame: null, endFrame: null, body: "Love it overall", authorName: "Sam", authorRole: "guest", status: "open", replies: 0 },
  ];

  it("writes a Resolve marker EDL", () => {
    expect(toResolveEdl(v, items)).toBe(
      [
        "TITLE: Brand film - v1",
        "FCM: NON-DROP FRAME",
        "",
        "001  001      V     C        01:00:05:00 01:00:05:01 01:00:05:00 01:00:05:01",
        ' |C:ResolveColorBlue |M:Sam: Logo bigger / "here" / please |D:1',
        "",
        "002  001      V     C        01:01:12:10 01:01:16:22 01:01:12:10 01:01:16:22",
        " |C:ResolveColorRed |M:CUT (open) Sam: drop the second take & the pause |D:108",
        "",
      ].join("\r\n"),
    );
  });

  it("makes EDL text ASCII-safe", () => {
    expect(edlSafe("Café — “ok” | 🎬")).toBe('Cafe - "ok" /');
  });

  it("writes Premiere XML with NTSC rate and escaped text", () => {
    const x = toPremiereXml(v, items);
    expect(x).toContain("<timebase>24</timebase><ntsc>TRUE</ntsc>");
    expect(x).toContain("<in>1738</in><out>1846</out>");
    expect(x).toContain("<in>120</in><out>-1</out>");
    expect(x).toContain("&amp;");
    expect(x).toMatch(/<name>Sam: Logo bigger \| “here” \/ please<\/name>/);
    expect(x).not.toContain("Love it overall");
  });

  it("writes CSV with a BOM, quoting and untimed rows last", () => {
    const c = toCsv(v, items, (id) => `https://x/${id}`);
    expect(c.startsWith("﻿Timecode In,")).toBe(true);
    const lines = c.trim().split("\r\n");
    expect(lines[1].startsWith("01:00:05:00,,")).toBe(true);
    expect(lines[2]).toContain("01:01:12:10,01:01:16:22,108,4.50,cut");
    expect(lines.at(-1)).toContain("Love it overall");
  });
});
