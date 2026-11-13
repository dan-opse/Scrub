import { describe, expect, it } from "vitest";
import { describeAudio, describeCodec, describeRate, describeResolution } from "./videoInfo";

describe("videoInfo", () => {
  it("names H.265 with profile and level", () => {
    expect(describeCodec("hevc", "hvc1.2.4.L153.B0")).toEqual({ name: "H.265 (HEVC)", profile: "Main 10 · Level 5.1" });
    expect(describeCodec("hevc", "hvc1.1.6.L120.B0")).toEqual({ name: "H.265 (HEVC)", profile: "Main · Level 4" });
  });
  it("names H.264 with profile and level", () => {
    expect(describeCodec("avc", "avc1.640028")).toEqual({ name: "H.264 (AVC)", profile: "High · Level 4" });
  });
  it("labels resolution, rate and audio", () => {
    expect(describeResolution(3840, 2160)).toBe("3840 × 2160 (4K UHD)");
    expect(describeResolution(1080, 1920)).toBe("1080 × 1920 (1080p vertical)");
    expect(describeRate({ num: 24000, den: 1001 }, false)).toBe("23.976 fps");
    expect(describeRate({ num: 25, den: 1 }, true)).toBe("25 fps (variable)");
    expect(describeAudio("pcm-s24")).toBe("PCM (uncompressed)");
    expect(describeAudio(null)).toBe("No audio");
  });
});
