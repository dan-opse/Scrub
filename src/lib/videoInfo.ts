// Human-readable labels for a probed video: "H.265 (HEVC)", "Main 10", "4K UHD", "23.976 fps".
import { formatDuration, fps, type Rate } from "./timecode";

const AVC_PROFILES: Record<number, string> = {
  66: "Baseline",
  77: "Main",
  88: "Extended",
  100: "High",
  110: "High 10",
  122: "High 4:2:2",
  244: "High 4:4:4",
};
const HEVC_PROFILES: Record<number, string> = { 1: "Main", 2: "Main 10", 3: "Main Still", 4: "Range Extensions" };

/** "H.264" / "H.265 (HEVC)" plus profile and level parsed from the codec string, e.g. "avc1.640028" or "hvc1.2.4.L153.B0". */
export function describeCodec(codec: string | null, codecString: string | null): { name: string; profile: string | null } {
  const c = (codec ?? codecString?.split(".")[0] ?? "").toLowerCase();
  const parts = codecString?.split(".") ?? [];
  if (c === "avc" || c.startsWith("avc")) {
    const hex = parts[1];
    if (hex && /^[0-9a-f]{6}$/i.test(hex)) {
      const profile = AVC_PROFILES[parseInt(hex.slice(0, 2), 16)];
      const level = parseInt(hex.slice(4, 6), 16) / 10;
      return { name: "H.264 (AVC)", profile: [profile, level ? `Level ${level}` : null].filter(Boolean).join(" · ") || null };
    }
    return { name: "H.264 (AVC)", profile: null };
  }
  if (c === "hevc" || c.startsWith("hvc") || c.startsWith("hev")) {
    const profile = HEVC_PROFILES[Number((parts[1] ?? "").replace(/^[A-C]/i, ""))];
    const lv = parts.find((s) => /^[LH]\d+$/.test(s));
    const level = lv ? `Level ${+(Number(lv.slice(1)) / 30).toFixed(1)}${lv[0] === "H" ? " High tier" : ""}` : null;
    return { name: "H.265 (HEVC)", profile: [profile, level].filter(Boolean).join(" · ") || null };
  }
  return { name: c ? c.toUpperCase() : "Unknown codec", profile: null };
}

export function describeResolution(width: number, height: number): string {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const label =
    long >= 7680 ? "8K" : long >= 4096 && short >= 2160 ? "DCI 4K" : long >= 3840 ? "4K UHD" : long >= 2560 && short >= 1440 ? "1440p" : short >= 1080 ? "1080p" : short >= 720 ? "720p" : `${short}p`;
  const orientation = height > width ? " vertical" : "";
  return `${width} × ${height} (${label}${orientation})`;
}

export function describeRate(rate: Rate, vfr: boolean): string {
  const f = fps(rate);
  const n = Number.isInteger(f) ? String(f) : f.toFixed(3).replace(/0+$/, "");
  return `${n} fps${vfr ? " (variable)" : ""}`;
}

export function describeAudio(codec: string | null): string {
  if (!codec) return "No audio";
  if (codec.startsWith("pcm")) return "PCM (uncompressed)";
  const names: Record<string, string> = { aac: "AAC", mp3: "MP3", opus: "Opus", ac3: "Dolby Digital (AC-3)", eac3: "Dolby Digital Plus", flac: "FLAC", alac: "Apple Lossless" };
  return names[codec] ?? codec.toUpperCase();
}

export type VideoDetail = { label: string; value: string; sub?: string };

export function videoDetails(v: {
  container?: string;
  videoCodec: string | null;
  codecString: string | null;
  width: number;
  height: number;
  rate: Rate;
  isVfr: boolean;
  isHdr: boolean;
  frameCount: number;
  audioCodec: string | null;
}): VideoDetail[] {
  const codec = describeCodec(v.videoCodec, v.codecString);
  return [
    { label: "Codec", value: codec.name + (v.isHdr ? " · HDR" : ""), sub: codec.profile ?? undefined },
    { label: "Resolution", value: describeResolution(v.width, v.height) },
    { label: "Frame rate", value: describeRate(v.rate, v.isVfr) },
    { label: "Duration", value: formatDuration(v.frameCount, v.rate), sub: `${v.frameCount.toLocaleString()} frames` },
    { label: "Audio", value: describeAudio(v.audioCodec) },
    ...(v.container ? [{ label: "Container", value: /quicktime|mov/i.test(v.container) ? "QuickTime (MOV)" : v.container.toUpperCase().includes("MP4") ? "MP4" : v.container }] : []),
  ];
}
