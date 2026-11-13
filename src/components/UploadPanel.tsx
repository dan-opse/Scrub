"use client";
import { useEffect, useRef, useState } from "react";
import { supabase, api, errorMessage } from "@/lib/client/supabase";
import { probeFile, type Probe } from "@/lib/client/probe";
import { uploadVersion, type UploadProgress } from "@/lib/client/uploader";
import { makeReviewCopy, needsReviewCopy, type ReviewCopyPhase } from "@/lib/client/reviewCopy";
import { readTimecodeTrack } from "@/lib/client/timecodeTrack";
import { canDropFrame, framesToTimecode, timecodeToFrames } from "@/lib/timecode";
import { videoDetails } from "@/lib/videoInfo";

type Props = {
  projectId: string;
  defaultStartTc: string;
  /** Upload as a new version of this asset; otherwise a new asset is created. */
  assetId?: string;
  /** An interrupted version to resume: the editor must drop the same file again. */
  resume?: { versionId: string; filename: string; bytes: number };
  /** A file already chosen (e.g. dropped on the project page): inspected as soon as the panel opens. */
  initialFile?: File;
  onDone: (assetId: string) => void;
  onCancel?: () => void;
};

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);

export function UploadPanel({ projectId, defaultStartTc, assetId, resume, initialFile, onDone, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startTc, setStartTc] = useState(defaultStartTc);
  const [dropFrame, setDropFrame] = useState(defaultStartTc.includes(";"));
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [phase, setPhase] = useState<"pick" | "review" | "uploading" | "stalled" | "copy">("pick");
  const [copy, setCopy] = useState<{ phase: ReviewCopyPhase; fraction: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const versionRef = useRef<{ versionId: string; assetId: string } | null>(null);

  // Keep the screen awake and warn before leaving while bytes are in flight.
  useEffect(() => {
    if (phase !== "uploading" && phase !== "copy") return;
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      lock?.release().catch(() => undefined);
      window.removeEventListener("beforeunload", warn);
    };
  }, [phase]);

  const [tcSource, setTcSource] = useState<"file" | "project">("project");
  const [quota, setQuota] = useState<{ used: number; allowance: number; maxFile: number } | null>(null);
  const [quotaChecked, setQuotaChecked] = useState(false);
  useEffect(() => {
    api<{ used: number; allowance: number; maxFile: number }>("/api/storage", {})
      .then(setQuota)
      .catch(() => undefined)
      .finally(() => setQuotaChecked(true));
  }, []);

  async function pick(f: File) {
    setError(null);
    if (f.size > (quota?.maxFile ?? 50 * 2 ** 30)) return setError(`Files are limited to 50 GB (this one is ${mb(f.size)}).`);
    if (quota && !resume && quota.used + f.size > quota.allowance) {
      return setError(`Not enough storage: ${mb(quota.used)} of ${mb(quota.allowance)} used, this file needs ${mb(f.size)}. Delete old versions first.`);
    }
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
      const tc = await readTimecodeTrack(f);
      if (tc) {
        setStartTc(tc.timecode);
        setDropFrame(tc.dropFrame);
        setTcSource("file");
      }
      setPhase("review");
      if (resume) start(f, p);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProbing(0);
    }
  }

  // Start timecode isn't asked for on upload: it comes from the file's timecode track or the project default
  // (falling back to 00:00:00:00), and can be changed later in the Export dialog.
  const df = !!probe && dropFrame && canDropFrame(probe.rate);
  const startFrames = probe ? (timecodeToFrames(startTc, probe.rate, df) ?? 0) : 0;

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
            start_tc_frames: startFrames,
            drop_frame: df,
            is_vfr: p.isVfr,
            audio_codec: p.audioCodec,
            review_status: needsReviewCopy(p) ? "pending" : "not_needed",
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
      if (needsReviewCopy(p)) {
        // Clients whose computer can't decode this file get an H.264 copy, made right here.
        setPhase("copy");
        try {
          await makeReviewCopy(f, p, ids.versionId, (ph, fr) => setCopy({ phase: ph, fraction: fr }), abort.current.signal);
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          await sb.from("versions").update({ review_status: "failed" }).eq("id", ids.versionId);
          setError(`Uploaded, but the H.264 review copy failed: ${errorMessage(e)} You can retry from the video page.`);
          setPhase("stalled");
          setTimeout(() => onDone(ids!.assetId), 4000);
          return;
        }
      }
      onDone(ids.assetId);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(errorMessage(e));
      setPhase(versionRef.current || resume ? "stalled" : "review");
      const vid = versionRef.current?.versionId ?? resume?.versionId ?? null;
      sb.from("events").insert({ kind: "upload_failed", version_id: vid, data: { message: errorMessage(e), bytes: f.size } }).then(() => undefined);
    }
  }

  // A file handed in from outside is picked once the storage check has loaded, so the quota guard applies.
  const pickedInitial = useRef(false);
  useEffect(() => {
    if (!initialFile || !quotaChecked || pickedInitial.current) return;
    pickedInitial.current = true;
    pick(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per handed-in file
  }, [initialFile, quotaChecked]);

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
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-md border border-line bg-panel-2/50 p-3 sm:grid-cols-3">
            {[
              ...videoDetails(probe),
              {
                label: "Start timecode",
                value: framesToTimecode(startFrames, probe.rate, df),
                sub: tcSource === "file" ? "From the file" : "Project default",
              },
            ].map((d) => (
              <div key={d.label} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-ink-3">{d.label}</dt>
                <dd className="truncate text-sm text-ink">{d.value}</dd>
                {d.sub && <dd className="truncate text-xs text-ink-3">{d.sub}</dd>}
              </div>
            ))}
          </dl>
          {probe.blockers.map((b) => (
            <p key={b} className="rounded-md border border-cut/50 bg-cut/10 p-2 text-sm">✕ {b}</p>
          ))}
          {probe.warnings.map((w) => (
            <p key={w} className="rounded-md border border-accent/40 bg-accent/10 p-2 text-sm">! {w}</p>
          ))}
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

      {phase === "copy" && copy && (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded bg-panel-2">
            <div className="h-full bg-note transition-[width]" style={{ width: `${copy.fraction * 100}%` }} />
          </div>
          <p className="text-xs text-ink-2">
            {copy.phase === "converting" && `Making an H.264 review copy so every client can play this… ${Math.round(copy.fraction * 100)}%`}
            {copy.phase === "checking" && "Checking the copy frame for frame…"}
            {copy.phase === "uploading" && `Uploading the review copy… ${Math.round(copy.fraction * 100)}%`}
          </p>
          <p className="text-xs text-ink-3">The original is already uploaded and shareable. Keep this tab open until the copy finishes.</p>
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
          <button className="btn btn-primary" disabled={!probe || probe.blockers.length > 0} onClick={() => start()}>
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
