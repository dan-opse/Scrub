// Makes an H.264 "review copy" of a video in the browser, using the machine's hardware codecs through WebCodecs.
// Runs in a Web Worker so the page stays responsive. Output is streamed to a temporary file in the browser's
// private storage (OPFS) so a long video never has to fit in memory.
import {
  ALL_FORMATS,
  BlobSource,
  UrlSource,
  Input,
  Output,
  Mp4OutputFormat,
  StreamTarget,
  BufferTarget,
  Conversion,
  canEncodeVideo,
  type StreamTargetChunk,
} from "mediabunny";

export type ReviewCopyRequest = {
  source: File | string; // a File, or a signed URL of the original
  width: number;
  height: number;
  rotation: number;
  fps: number;
};
type Msg = { type: "progress"; fraction: number } | { type: "done"; blob: Blob } | { type: "error"; message: string };

const post = (m: Msg) => (self as unknown as Worker).postMessage(m);
let current: Conversion | null = null;

self.onmessage = async (e: MessageEvent<ReviewCopyRequest | { type: "cancel" }>) => {
  if ("type" in e.data && e.data.type === "cancel") {
    await current?.cancel().catch(() => undefined);
    return;
  }
  const req = e.data as ReviewCopyRequest;
  let opfsFile: FileSystemFileHandle | null = null;
  try {
    if (!(await canEncodeVideo("avc"))) throw new Error("This browser can't encode H.264. Upload from Chrome, Edge or Safari on a computer.");

    const input = new Input({
      formats: ALL_FORMATS,
      source: typeof req.source === "string" ? new UrlSource(req.source) : new BlobSource(req.source),
    });

    // Scale so the long edge is at most 1920 (portrait stays portrait); keep the aspect ratio.
    const portrait = req.rotation % 180 !== 0 ? req.width < req.height : req.height > req.width;
    const long = Math.max(req.width, req.height);
    const scale = long > 1920 ? 1920 / long : 1;
    const outW = Math.round((req.width * scale) / 2) * 2;
    const outH = Math.round((req.height * scale) / 2) * 2;
    const pixels = outW * outH;
    const bitrate = Math.round(8_000_000 * (pixels / (1920 * 1080)) * Math.max(1, req.fps / 30));
    void portrait;

    // Prefer a temp file in private storage; fall back to memory for small outputs.
    let target: StreamTarget | BufferTarget;
    let writable: FileSystemWritableFileStream | null = null;
    try {
      const root = await navigator.storage.getDirectory();
      opfsFile = await root.getFileHandle(`review-${crypto.randomUUID()}.mp4`, { create: true });
      writable = await opfsFile.createWritable();
      target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true });
    } catch {
      opfsFile = null;
      target = new BufferTarget();
    }

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: opfsFile ? "reserve" : "in-memory" }), target });
    current = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: {
        codec: "avc",
        width: outW,
        height: outH,
        fit: "contain",
        bitrate,
        keyFrameInterval: 1,
        hardwareAcceleration: "prefer-hardware",
        forceTranscode: true,
      },
      audio: { codec: "aac", numberOfChannels: 2, sampleRate: 48000, bitrate: 192_000, forceTranscode: true },
    });
    if (!current.isValid) {
      const reasons = current.discardedTracks.map((t) => t.reason).join(", ");
      throw new Error(`Can't convert this file (${reasons}).`);
    }
    current.onProgress = (p) => post({ type: "progress", fraction: p });
    await current.execute();

    let blob: Blob;
    if (opfsFile) {
      blob = await opfsFile.getFile();
    } else {
      const buf = (target as BufferTarget).buffer;
      if (!buf) throw new Error("Conversion produced no output.");
      blob = new Blob([buf], { type: "video/mp4" });
    }
    post({ type: "done", blob });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    current = null;
  }
};
