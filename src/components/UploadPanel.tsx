"use client";
import { useEffect, useRef, useState } from "react";
import { supabase, api, errorMessage } from "@/lib/client/supabase";
import { probeFile, type Probe } from "@/lib/client/probe";
import { uploadVersion, type UploadProgress } from "@/lib/client/uploader";
import { canDropFrame, timecodeToFrames, fps } from "@/lib/timecode";

type Props = {
  projectId: string;
  defaultStartTc: string;
  /** Upload as a new version of this asset; otherwise a new asset is created. */
  assetId?: string;
  /** An interrupted version to resume: the editor must drop the same file again. */
  resume?: { versionId: string; filename: string; bytes: number };
  onDone: (assetId: string) => void;
  onCancel?: () => void;
};

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);

export function UploadPanel({ projectId, defaultStartTc, assetId, resume, onDone, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startTc, setStartTc] = useState(defaultStartTc);
  const [dropFrame, setDropFrame] = useState(defaultStartTc.includes(";"));
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [phase, setPhase] = useState<"pick" | "review" | "uploading" | "stalled">("pick");
  const abort = useRef<AbortController | null>(null);
  const versionRef = useRef<{ versionId: string; assetId: string } | null>(null);

  // Keep the screen awake and warn before leaving while bytes are in flight.
  useEffect(() => {
    if (phase !== "uploading") return;
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      lock?.release().catch(() => undefined);
      window.removeEventListener("beforeunload", warn);
    };
  }, [phase]);

  async function pick(f: File) {
    setError(null);
    if (resume && (f.name !== resume.filename || f.size !== resume.bytes)) {
      setError(`To resume, drop the same file: ${resume.filename} (${mb(resume.bytes)}).`);
      return;
    }
    setFile(f);
    setProbe(null);
    setProbing(0.01);
    try {
      const p = await probeFile(f, setProbing);
      setProbe(p);
      setPhase("review");
      if (resume) start(f, p);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProbing(0);
    }
  }

  const startFrames = probe ? timecodeToFrames(startTc, probe.rate, dropFrame && canDropFrame(probe.rate)) : 0;

  async function start(f = file!, p = probe!) {
    setError(null);
    const sb = supabase();
    try {
      let ids = versionRef.current;
      if (resume) ids = { versionId: resume.versionId, assetId: assetId! };
      if (!ids) {
        let aId = assetId;
        if (!aId) {
          const name = f.name.replace(/\.[^.]+$/, "");
          const { data, error } = await sb.from("assets").insert({ project_id: projectId, name }).select("id").single();
          if (error) throw error;
          aId = data.id as string;
        }
        const { data, error } = await sb
          .from("versions")
          .insert({
            asset_id: aId,
            original_filename: f.name,
            original_bytes: f.size,
            container: p.container,
            mime_type: p.mimeType,
            video_codec_string: p.codecString,
            is_hdr: p.isHdr,
            width: p.width,
            height: p.height,
            rotation: p.rotation,
            fps_num: p.rate.num,
            fps_den: p.rate.den,
            frame_count: p.frameCount,
            first_pts: p.firstPts,
            start_tc_frames: startFrames ?? 0,
            drop_frame: dropFrame && canDropFrame(p.rate),
            is_vfr: p.isVfr,
            audio_codec: p.audioCodec,
          })
          .select("id")
          .single();
        if (error) throw error;
        ids = { versionId: data.id as string, assetId: aId! };
        versionRef.current = ids;
      }
      setPhase("uploading");
      abort.current = new AbortController();
      await uploadVersion(f, ids.versionId, setProgress, abort.current.signal);
      onDone(ids.assetId);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(errorMessage(e));
      setPhase(versionRef.current || resume ? "stalled" : "review");
    }
  }

  async function cancel() {
    abort.current?.abort();
    const v = versionRef.current?.versionId ?? resume?.versionId;
    if (v) await api("/api/uploads/abort", { versionId: v }).catch(() => undefined);
    onCancel?.();
  }

  const eta =
    progress && progress.bytesPerSecond > 0 ? Math.ceil((progress.total - progress.sent) / progress.bytesPerSecond) : null;

  return (
    <div className="card space-y-4 p-4">
      {phase === "pick" && (
        <label
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-2 p-8 text-center hover:border-accent"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) pick(f);
          }}
        >
          <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          <span className="font-medium">{resume ? `Drop ${resume.filename} to resume` : "Drop an H.264 or H.265 export here"}</span>
          <span className="text-ink-2">MP4 or MOV, up to 50 GB</span>
          {probing > 0 && <span className="text-accent">Inspecting… {Math.round(probing * 100)}%</span>}
        </label>
      )}

      {probe && file && phase !== "pick" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{file.name}</span>
            <span className="text-ink-2">{mb(file.size)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-2">
            <span>{probe.videoCodec?.toUpperCase()} {probe.codecString}</span>
            <span>{probe.width}×{probe.height}</span>
            <span>{fps(probe.rate).toFixed(3)} fps{probe.isVfr ? " (variable)" : ""}</span>
            <span>{probe.frameCount.toLocaleString()} frames</span>
            <span>audio: {probe.audioCodec ?? "none"}</span>
          </div>
          {probe.blockers.map((b) => (
            <p key={b} className="rounded-md border border-cut/50 bg-cut/10 p-2 text-sm">✕ {b}</p>
          ))}
          {probe.warnings.map((w) => (
            <p key={w} className="rounded-md border border-accent/40 bg-accent/10 p-2 text-sm">! {w}</p>
          ))}
          {phase === "review" && !resume && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="label">Start timecode</span>
                <input
                  className="input w-36 font-mono"
                  value={startTc}
                  onChange={(e) => setStartTc(e.target.value)}
                  aria-invalid={startFrames === null}
                />
              </label>
              {canDropFrame(probe.rate) && (
                <label className="flex items-center gap-2 pb-2 text-sm text-ink-2">
                  <input type="checkbox" checked={dropFrame} onChange={(e) => setDropFrame(e.target.checked)} /> Drop-frame
                </label>
              )}
              <p className="pb-2 text-xs text-ink-3">
                Match your timeline&apos;s start (usually 01:00:00:00) so exported markers line up.
              </p>
            </div>
          )}
          {startFrames === null && <p className="text-sm text-cut">Enter timecode as HH:MM:SS:FF.</p>}
        </div>
      )}

      {(phase === "uploading" || phase === "stalled") && progress && (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded bg-panel-2">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${(progress.sent / progress.total) * 100}%` }} />
          </div>
          <div className="flex justify-between text-xs text-ink-2">
            <span>
              {mb(progress.sent)} of {mb(progress.total)}
              {progress.bytesPerSecond > 0 && ` · ${mb(progress.bytesPerSecond)}/s`}
            </span>
            <span>{phase === "stalled" ? "Paused" : eta !== null ? `${Math.floor(eta / 60)}m ${eta % 60}s left` : ""}</span>
          </div>
          {phase === "uploading" && <p className="text-xs text-ink-3">Keep this tab open. If it closes, drop the same file again to resume.</p>}
        </div>
      )}

      {error && <p className="text-sm text-cut">{error}</p>}

      <div className="flex justify-end gap-2">
        {(onCancel || phase !== "pick") && (
          <button className="btn btn-ghost" onClick={cancel}>
            Cancel
          </button>
        )}
        {phase === "review" && !resume && (
          <button className="btn btn-primary" disabled={!probe || probe.blockers.length > 0 || startFrames === null} onClick={() => start()}>
            Upload
          </button>
        )}
        {phase === "stalled" && (
          <button className="btn btn-primary" onClick={() => start()}>
            Resume
          </button>
        )}
      </div>
    </div>
  );
}
