"use client";
// Main-thread side of review-copy creation: runs the worker, validates the result frame-for-frame,
// and uploads it as the version's second object.
import { probeFile, type Probe } from "./probe";
import { uploadVersion } from "./uploader";
import type { ReviewCopyRequest } from "./reviewCopy.worker";

const BROWSER_AUDIO = new Set(["aac", "opus", "mp3", null]);

/** Does this file need an H.264 copy so every client can play it? */
export function needsReviewCopy(p: Pick<Probe, "videoCodec" | "audioCodec" | "width" | "height">): boolean {
  if (p.videoCodec === "hevc") return true;
  if (!BROWSER_AUDIO.has(p.audioCodec)) return true;
  if (Math.max(p.width, p.height) > 3840) return true;
  return false;
}

export type ReviewCopyPhase = "converting" | "checking" | "uploading";

/**
 * Converts `source` (the original File, or a signed URL of it) and uploads the copy for `versionId`.
 * Throws with a human-readable message on failure; the caller marks the version's review_status.
 */
export async function makeReviewCopy(
  source: File | string,
  original: Pick<Probe, "width" | "height" | "rotation" | "rate" | "frameCount">,
  versionId: string,
  onProgress: (phase: ReviewCopyPhase, fraction: number) => void,
  signal: AbortSignal,
): Promise<{ bytes: number; firstPts: number }> {
  const worker = new Worker(new URL("./reviewCopy.worker.ts", import.meta.url));
  const req: ReviewCopyRequest = {
    source,
    width: original.width,
    height: original.height,
    rotation: original.rotation,
    fps: original.rate.num / original.rate.den,
  };
  const blob = await new Promise<Blob>((resolve, reject) => {
    const onAbort = () => {
      worker.postMessage({ type: "cancel" });
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e) => {
      const m = e.data as { type: string; fraction?: number; blob?: Blob; message?: string };
      if (m.type === "progress") onProgress("converting", m.fraction ?? 0);
      else if (m.type === "done") resolve(m.blob!);
      else if (m.type === "error") reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || "The conversion crashed. Try uploading an H.264 export instead."));
    worker.postMessage(req);
  }).finally(() => worker.terminate());

  onProgress("checking", 0);
  const file = new File([blob], "review.mp4", { type: "video/mp4" });
  const check = await probeFile(file);
  if (check.frameCount !== original.frameCount) {
    throw new Error(`The review copy has ${check.frameCount} frames but the original has ${original.frameCount}. It was discarded so comments can't land on the wrong frame.`);
  }
  if (check.videoCodec !== "avc") throw new Error("The review copy is not H.264.");

  await uploadVersion(file, versionId, (p) => onProgress("uploading", p.total ? p.sent / p.total : 0), signal, "review", {
    bytes: file.size,
    firstPts: check.firstPts,
  });
  return { bytes: file.size, firstPts: check.firstPts };
}
