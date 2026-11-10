"use client";
// Reads everything Scrub needs from a video file in the browser, before upload.
// Only headers and packet tables are read, never the whole file.
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny";
import { snapRate, type Rate } from "../timecode";

export type Probe = {
  container: string;
  mimeType: string;
  videoCodec: string | null; // "avc" | "hevc" | ...
  codecString: string | null; // e.g. "hvc1.1.6.L120.B0"
  width: number;
  height: number;
  rotation: number;
  rate: Rate;
  rateSnapped: boolean;
  frameCount: number;
  firstPts: number;
  isVfr: boolean;
  isHdr: boolean;
  audioCodec: string | null;
  blockers: string[];
  warnings: string[];
};

const BROWSER_AUDIO = new Set(["aac", "opus", "mp3"]);

export async function probeFile(file: File, onProgress?: (fraction: number) => void): Promise<Probe> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const blockers: string[] = [];
  const warnings: string[] = [];

  const format = await input.getFormat().catch(() => null);
  if (!format) throw new Error("This file isn't a video Scrub can read. Export an MP4 or MOV.");
  const container = format.name;
  const mimeType = await input.getMimeType().catch(() => "video/mp4");
  if (!/mp4|quicktime|mov/i.test(container + mimeType)) {
    blockers.push(`${container} files aren't supported. Export an MP4 (recommended) or MOV.`);
  }

  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("This file has no video track.");
  const videoCodec = await video.getCodec();
  const codecString = await video.getCodecParameterString().catch(() => null);
  if (videoCodec !== "avc" && videoCodec !== "hevc") {
    blockers.push(
      `${videoCodec ? videoCodec.toUpperCase() : "This codec"} can't play in browsers. Export an H.264 or H.265 review copy.`,
    );
  }
  // Mediabunny's codec string doesn't reflect the container tag, so read the sample entry itself.
  const hevcTag = videoCodec === "hevc" ? await readHevcTag(file) : null;
  if (hevcTag === "hev1") {
    warnings.push(
      "This H.265 file is tagged hev1, which Apple devices won't play. Re-export with the hvc1 tag (Resolve does this by default for MP4).",
    );
  }

  const width = await video.getDisplayWidth();
  const height = await video.getDisplayHeight();
  const rotation = await video.getRotation();
  if (Math.max(width, height) > 3840 || Math.min(width, height) > 2160) {
    warnings.push("Larger than 4K. Many computers can't decode this in a browser; a 4K or 1080p review export is safer.");
  }
  const isHdr = await video.hasHighDynamicRange().catch(() => false);
  if (isHdr) warnings.push("HDR video looks different in every browser. An SDR Rec.709 review export is recommended.");

  // Walk packet timestamps (metadata only) to count frames and detect variable frame rate.
  const sink = new EncodedPacketSink(video);
  const duration = await video.computeDuration().catch(() => 0);
  const timestamps: number[] = [];
  let packet = await sink.getFirstPacket({ metadataOnly: true });
  let lastReport = 0;
  while (packet) {
    timestamps.push(packet.timestamp);
    if (onProgress && duration > 0 && packet.timestamp - lastReport > 5) {
      lastReport = packet.timestamp;
      onProgress(Math.min(1, packet.timestamp / duration));
    }
    packet = await sink.getNextPacket(packet, { metadataOnly: true });
  }
  onProgress?.(1);
  if (timestamps.length < 2) throw new Error("This video is too short to review.");
  timestamps.sort((a, b) => a - b);
  const firstPts = timestamps[0];
  const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const irregular = gaps.filter((g) => Math.abs(g - median) > Math.max(median * 0.05, 0.0005)).length;
  const isVfr = irregular / gaps.length > 0.01;
  const span = timestamps.at(-1)! - firstPts;
  const measured = (timestamps.length - 1) / span;
  const { rate, snapped } = snapRate(isVfr ? measured : 1 / median);
  if (isVfr) {
    warnings.push(
      "Variable frame rate (common for phone recordings). Comments still work, but exports to editing software are turned off. Re-export at a constant frame rate for frame accuracy.",
    );
  } else if (!snapped) {
    warnings.push(`Unusual frame rate (${(rate.num / rate.den).toFixed(3)} fps). Timecode may not match your editing software.`);
  }

  const audio = await input.getPrimaryAudioTrack();
  const audioCodec = audio ? await audio.getCodec() : null;
  if (audioCodec && !BROWSER_AUDIO.has(audioCodec)) {
    warnings.push(`The audio (${audioCodec}) may play silently in some browsers. Export with AAC audio.`);
  }

  return {
    container,
    mimeType,
    videoCodec,
    codecString,
    width,
    height,
    rotation,
    rate,
    rateSnapped: snapped,
    frameCount: timestamps.length,
    firstPts,
    isVfr,
    isHdr,
    audioCodec,
    blockers,
    warnings,
  };
}

/** Finds the H.265 sample entry ("hvc1" or "hev1") inside the file's moov box. */
async function readHevcTag(file: File): Promise<"hvc1" | "hev1" | null> {
  let pos = 0;
  for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
    const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerLen = 8;
    if (size === 1) {
      size = Number(head.getBigUint64(8));
      headerLen = 16;
    } else if (size === 0) size = file.size - pos;
    if (size < headerLen) return null;
    if (type === "moov") {
      const bytes = new Uint8Array(await file.slice(pos, pos + Math.min(size, 64 * 1024 * 1024)).arrayBuffer());
      const text = new TextDecoder("latin1").decode(bytes);
      if (text.includes("hvc1")) return "hvc1";
      if (text.includes("hev1")) return "hev1";
      return null;
    }
    pos += size;
  }
  return null;
}

/** Will this browser decode the file? Capability APIs can lie, so the player also confirms with a real frame. */
export async function canProbablyPlay(codecString: string | null, width: number, height: number, rate: Rate) {
  if (!codecString || typeof navigator === "undefined" || !navigator.mediaCapabilities) return true;
  try {
    const r = await navigator.mediaCapabilities.decodingInfo({
      type: "file",
      video: { contentType: `video/mp4; codecs="${codecString}"`, width, height, bitrate: 10_000_000, framerate: rate.num / rate.den },
    });
    return r.supported;
  } catch {
    return true;
  }
}
