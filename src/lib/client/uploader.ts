"use client";
// Resumable multipart upload straight from the browser to storage.
import { api } from "./supabase";

type Part = { partNumber: number; etag: string };
export type UploadProgress = { sent: number; total: number; bytesPerSecond: number };

const CONCURRENCY = 4;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadVersion(
  file: File,
  versionId: string,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
  kind: "original" | "review" = "original",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { partSize, resumed } = await api<{ partSize: number; resumed: boolean }>("/api/uploads/start", { versionId, kind, bytes: file.size });
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));

  const done = new Map<number, string>();
  if (resumed) {
    const { parts } = await api<{ parts: { partNumber: number; etag: string; size: number }[] }>("/api/uploads/parts", {
      versionId,
      kind,
    });
    for (const p of parts) {
      const expected = p.partNumber === totalParts ? file.size - (totalParts - 1) * partSize : partSize;
      if (p.size === expected) done.set(p.partNumber, p.etag);
    }
  }

  let sent = [...done.keys()].reduce((s, n) => s + partBytes(n), 0);
  const started = performance.now();
  const sentAtStart = sent;
  function partBytes(n: number) {
    return n === totalParts ? file.size - (totalParts - 1) * partSize : partSize;
  }
  const report = () => {
    const secs = (performance.now() - started) / 1000;
    onProgress({ sent, total: file.size, bytesPerSecond: secs > 0.5 ? (sent - sentAtStart) / secs : 0 });
  };
  report();

  const queue = Array.from({ length: totalParts }, (_, i) => i + 1).filter((n) => !done.has(n));
  const urlCache = new Map<number, string>();

  async function urlFor(n: number, fresh = false) {
    if (!fresh && urlCache.has(n)) return urlCache.get(n)!;
    const batch = [n, ...queue.slice(0, 19)].filter((x, i, a) => a.indexOf(x) === i);
    const { urls } = await api<{ urls: { partNumber: number; url: string }[] }>("/api/uploads/sign", {
      versionId,
      kind,
      partNumbers: batch,
    });
    for (const u of urls) urlCache.set(u.partNumber, u.url);
    return urlCache.get(n)!;
  }

  async function sendPart(n: number) {
    const blob = file.slice((n - 1) * partSize, Math.min(file.size, n * partSize));
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
      try {
        const url = await urlFor(n, attempt > 0);
        const etag = await putWithProgress(url, blob, signal, (delta) => {
          sent += delta;
          report();
        });
        done.set(n, etag);
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        if (attempt >= RETRY_DELAYS.length) throw new Error("The connection kept dropping. Use Resume to continue.");
        await sleep(RETRY_DELAYS[attempt]);
        if (!navigator.onLine) await new Promise((r) => window.addEventListener("online", r, { once: true }));
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await sendPart(queue.shift()!);
    }),
  );

  const parts: Part[] = [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag }));
  await api("/api/uploads/complete", { versionId, kind, parts, ...extra });
}

/** PUT with upload progress. fetch() can't report upload progress, so this uses XHR. */
function putWithProgress(url: string, blob: Blob, signal: AbortSignal, onDelta: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let last = 0;
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      onDelta(e.loaded - last);
      last = e.loaded;
    };
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else {
        onDelta(-last);
        reject(new Error(etag ? `Upload failed (${xhr.status})` : "Storage didn't return an ETag (check bucket CORS)"));
      }
    };
    xhr.onerror = () => {
      onDelta(-last);
      reject(new Error("Network error"));
    };
    const abort = () => {
      xhr.abort();
      onDelta(-last);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(blob);
  });
}
