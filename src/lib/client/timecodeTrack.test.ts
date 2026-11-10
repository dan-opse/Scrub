import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readTimecodeTrack } from "./timecodeTrack";

const fixture = (name: string) => {
  const p = new URL(`../../../test-fixtures/${name}`, import.meta.url);
  return existsSync(p) ? new File([readFileSync(p)], name) : null;
};

describe("timecode track", () => {
  it("reads a non-drop-frame start timecode from a MOV", async () => {
    const f = fixture("h264-tc.mov");
    if (!f) return;
    expect(await readTimecodeTrack(f)).toEqual({ timecode: "01:00:00:00", dropFrame: false, fps: expect.closeTo(23.976, 2) });
  });
  it("reads a drop-frame start timecode", async () => {
    const f = fixture("h265-tc-df.mov");
    if (!f) return;
    expect(await readTimecodeTrack(f)).toEqual({ timecode: "00:59:58;00", dropFrame: true, fps: expect.closeTo(29.97, 2) });
  });
  it("returns null when there is no timecode track", async () => {
    const f = fixture("h264-23976.mp4");
    if (!f) return;
    expect(await readTimecodeTrack(f)).toBeNull();
  });
});
