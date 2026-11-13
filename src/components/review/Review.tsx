"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, api, errorMessage } from "@/lib/client/supabase";
import { union, removed, sourceToPreview, previewToSource, rangeAt, type Range } from "@/lib/ranges";
import {
  type TimeDisplay,
  formatTime,
  formatDuration,
  formatClock,
  timecodeToFrames,
  canDropFrame,
} from "@/lib/timecode";
import { versionRate, type Access, type Comment, type Version } from "@/lib/types";
import { usePlayer, useFrame, type FrameStore, type Player } from "./usePlayer";
import { useComments } from "./useComments";
import { useApprovals } from "./useApprovals";
import { ApprovalBar } from "./ApprovalBar";
import { GuestIntro } from "./GuestIntro";
import { EarlierRequests, ResolveDialog } from "./VersionCarryover";
import { Timeline, type TimelineHandle } from "./Timeline";
import { Sidebar, type PreviewPreset, type Tab } from "./Sidebar";
import { Composer } from "./Composer";
import { ExportDialog, ShareDialog, ShortcutsDialog } from "./Dialogs";
import { UploadPanel } from "../UploadPanel";
import { canProbablyPlay } from "@/lib/client/probe";
import { makeReviewCopy, type ReviewCopyPhase } from "@/lib/client/reviewCopy";

type Me = { id: string; name: string; role: "editor" | "guest" };

export function Review({ assetId, me, access, editorName = null }: { assetId: string; me: Me; access: Access; editorName?: string | null }) {
  const editor = me.role === "editor";
  const [asset, setAsset] = useState<{ name: string; project_id: string } | null>(null);
  const [project, setProject] = useState<{ name: string; default_start_tc: string } | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"share" | "export" | "keys" | "upload" | null>(null);
  const [resolveFor, setResolveFor] = useState<{ earlier: Version[]; next: Version } | null>(null);
  const [pendingSeek, setPendingSeek] = useState<{ versionId: string; frame: number } | null>(null);

  const loadVersions = useCallback(async () => {
    const sb = supabase();
    const [{ data: a, error: ae }, { data: vs, error: ve }] = await Promise.all([
      sb.from("assets").select("name, project_id").eq("id", assetId).single(),
      sb.from("versions").select("*").eq("asset_id", assetId).is("deleted_at", null).order("number"),
    ]);
    if (ae || ve) {
      setLoadError(errorMessage(ae ?? ve));
      return null;
    }
    setAsset(a);
    setVersions(vs as Version[]);
    const ready = (vs as Version[]).filter((v) => v.status === "ready");
    setVersionId((cur) => (cur && ready.some((v) => v.id === cur) ? cur : (ready.at(-1)?.id ?? null)));
    if (editor) {
      const { data: p } = await sb.from("projects").select("name, default_start_tc").eq("id", a.project_id).single();
      setProject(p);
    }
    return vs as Version[];
  }, [assetId, editor]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch; state is set after the await
    loadVersions();
  }, [loadVersions]);

  const version = versions.find((v) => v.id === versionId) ?? null;
  const unfinished = editor ? versions.filter((v) => v.status === "uploading") : [];

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        {editor ? (
          <Link href={asset ? `/projects/${asset.project_id}` : "/projects"} className="text-ink-2 hover:text-ink">
            ← {project?.name ?? "Projects"}
          </Link>
        ) : (
          <span className="flex items-center gap-2">
            <span className="font-semibold">Scrub</span>
            <span className="rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">Client review</span>
          </span>
        )}
        <span className="font-medium">{asset?.name}</span>
        {versions.filter((v) => v.status === "ready").length > 1 && (
          <select className="input w-auto py-1" value={versionId ?? ""} onChange={(e) => setVersionId(e.target.value)} aria-label="Version">
            {versions
              .filter((v) => v.status === "ready")
              .map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number}
                </option>
              ))}
          </select>
        )}
        {versions.length === 1 && version && <span className="rounded bg-panel-2 px-1.5 text-sm text-ink-2">v{version.number}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => setDialog("keys")} aria-label="Keyboard shortcuts">
            ?
          </button>
          {editor && (
            <>
              <button className="btn btn-sm" onClick={() => setDialog("upload")}>
                New version
              </button>
              <button className="btn btn-sm" disabled={!version} onClick={() => setDialog("export")}>
                Export
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setDialog("share")}>
                Share
              </button>
            </>
          )}
          {!editor && (
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
                {me.name.trim().charAt(0).toUpperCase()}
              </span>
              <span>
                Reviewing as <span className="font-medium text-ink">{me.name}</span>
              </span>
            </span>
          )}
        </div>
      </header>

      {!editor && <GuestIntro editorName={editorName} canComment={access.allow_comments} />}

      {loadError && <p className="p-4 text-cut">{loadError}</p>}

      {editor && project && asset && (dialog === "upload" || unfinished.length > 0) && (
        <div className="mx-auto w-full max-w-2xl p-4">
          {unfinished.length > 0 && dialog !== "upload" ? (
            <>
              <p className="mb-2 text-sm text-accent">v{unfinished[0].number} didn&apos;t finish uploading.</p>
              <UploadPanel
                projectId={asset.project_id}
                defaultStartTc={project.default_start_tc}
                assetId={assetId}
                resume={{ versionId: unfinished[0].id, filename: unfinished[0].original_filename, bytes: unfinished[0].original_bytes }}
                onDone={() => loadVersions()}
                onCancel={() => loadVersions()}
              />
            </>
          ) : (
            <UploadPanel
              projectId={asset.project_id}
              defaultStartTc={project.default_start_tc}
              assetId={assetId}
              onDone={async () => {
                setDialog(null);
                const earlier = versions.filter((v) => v.status === "ready");
                setVersionId(null);
                const fresh = await loadVersions();
                const next = fresh?.filter((v) => v.status === "ready").at(-1);
                if (earlier.length && next && !earlier.some((v) => v.id === next.id)) setResolveFor({ earlier, next });
              }}
              onCancel={() => {
                setDialog(null);
                loadVersions();
              }}
            />
          )}
        </div>
      )}

      {resolveFor && <ResolveDialog earlier={resolveFor.earlier} next={resolveFor.next} onClose={() => setResolveFor(null)} />}
      {version ? (
        <VersionReview
          key={version.id}
          version={version}
          me={me}
          access={access}
          title={`${asset?.name ?? "Video"} - v${version.number}`}
          dialog={dialog}
          setDialog={setDialog}
          assetId={assetId}
          onVersionChanged={loadVersions}
          versions={versions}
          initialFrame={pendingSeek?.versionId === version.id ? pendingSeek.frame : null}
          onViewVersion={(id, frame) => {
            setPendingSeek({ versionId: id, frame });
            setVersionId(id);
          }}
          isLatest={version.id === versions.filter((v) => v.status === "ready").at(-1)?.id}
          goLatest={() => setVersionId(versions.filter((v) => v.status === "ready").at(-1)?.id ?? null)}
        />
      ) : (
        !loadError &&
        unfinished.length === 0 &&
        dialog !== "upload" && <p className="p-8 text-center text-ink-2">{versions.length ? "Loading…" : "No versions yet."}</p>
      )}
    </div>
  );
}

function VersionReview({
  version,
  me,
  access,
  title,
  dialog,
  setDialog,
  assetId,
  onVersionChanged,
  versions,
  initialFrame,
  onViewVersion,
  isLatest,
  goLatest,
}: {
  version: Version;
  me: Me;
  access: Access;
  title: string;
  dialog: string | null;
  setDialog: (d: "share" | "export" | "keys" | "upload" | null) => void;
  assetId: string;
  onVersionChanged: () => void;
  versions: Version[];
  initialFrame: number | null;
  onViewVersion: (versionId: string, frame: number) => void;
  isLatest: boolean;
  goLatest: () => void;
}) {
  const editor = me.role === "editor";
  const rate = useMemo(() => versionRate(version), [version]);
  const fc = version.frame_count;
  const vt = useMemo(() => ({ rate, startTcFrames: version.start_tc_frames, dropFrame: version.drop_frame && canDropFrame(rate) }), [rate, version]);
  const [mode, setMode] = useState<TimeDisplay>(version.is_vfr ? "clock" : editor ? "timecode" : "clock");

  // ---- which file to play: the original, or the H.264 review copy when this device can't decode the original
  const hasReview = version.review_status === "ready";
  const [source, setSource] = useState<"original" | "review" | null>(hasReview ? null : "original");
  useEffect(() => {
    if (!hasReview) return;
    let alive = true;
    canProbablyPlay(version.video_codec_string, version.width ?? 1920, version.height ?? 1080, rate).then((ok) => {
      if (alive) setSource((s) => s ?? (ok ? "original" : "review"));
    });
    return () => {
      alive = false;
    };
  }, [hasReview, version.video_codec_string, version.width, version.height, rate]);

  // ---- playback URL, refreshed before it expires
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const pendingUrl = useRef<string | null>(null);
  const fetchUrl = useCallback(async () => {
    if (!source) return null;
    try {
      const r = await api<{ url: string; expiresAt: number }>("/api/playback", { versionId: version.id, source });
      return r;
    } catch (e) {
      setUrlError((e as Error).message);
      return null;
    }
  }, [version.id, source]);

  const { videoRef, freezeRef, frozenVisible, player } = usePlayer({
    rate,
    firstPts: source === "review" ? version.review_first_pts : version.first_pts,
    frameCount: fc,
    url,
    onNetworkError: async () => {
      const r = await fetchUrl();
      if (r) setUrl(r.url);
    },
  });

  useEffect(() => {
    let timer: number;
    let alive = true;
    const schedule = async () => {
      const r = await fetchUrl();
      if (!r || !alive) return;
      setUrl((cur) => {
        if (!cur) return r.url;
        pendingUrl.current = r.url; // swap at the next pause
        return cur;
      });
      timer = window.setTimeout(schedule, Math.max(60_000, (r.expiresAt - Date.now()) * 0.8));
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fetchUrl]);

  // Switching between original and review copy keeps the frame and play state.
  const switchSource = useCallback(
    (s: "original" | "review") => {
      if (s === source) return;
      player.prepareSourceSwap();
      pendingUrl.current = null;
      setUrl(null);
      setSource(s);
    },
    [source, player],
  );

  // The capability API said yes but the decoder failed: fall back to the review copy and record it.
  const loggedDecode = useRef(false);
  useEffect(() => {
    if (player.decode !== "unsupported" || loggedDecode.current) return;
    loggedDecode.current = true;
    supabase().from("events").insert({ kind: "playback_decode_failed", version_id: version.id, data: { source, codec: version.video_codec_string, ua: navigator.userAgent } }).then(() => undefined);
    // Swap sources on the next tick: the swap is a reaction to the decoder, not part of rendering.
    if (source === "original" && hasReview) window.setTimeout(() => switchSource("review"), 0);
  }, [player.decode, source, hasReview, switchSource, version.id, version.video_codec_string]);

  // ---- editor can (re)make a missing review copy from the stored original
  const [copyJob, setCopyJob] = useState<{ phase: ReviewCopyPhase; fraction: number } | { error: string } | null>(null);
  const reviewNeeded = version.review_status === "pending" || version.review_status === "failed";
  async function createReviewCopy() {
    const ctrl = new AbortController();
    setCopyJob({ phase: "converting", fraction: 0 });
    try {
      const { url: src } = await api<{ url: string }>("/api/playback", { versionId: version.id, source: "original" });
      await makeReviewCopy(
        src,
        { width: version.width ?? 1920, height: version.height ?? 1080, rotation: version.rotation, rate, frameCount: fc },
        version.id,
        (phase, fraction) => setCopyJob({ phase, fraction }),
        ctrl.signal,
      );
      setCopyJob(null);
      onVersionChanged();
    } catch (e) {
      await supabase().from("versions").update({ review_status: "failed" }).eq("id", version.id);
      setCopyJob({ error: (e as Error).message });
    }
  }

  useEffect(() => {
    if (!player.playing && pendingUrl.current) {
      player.prepareSourceSwap();
      setUrl(pendingUrl.current);
      pendingUrl.current = null;
    }
  }, [player.playing, player]);

  // ---- comments
  const { comments, add, update, setStatus } = useComments(version.id);
  const { approvals, latest: latestApproval, decide } = useApprovals(version.id);
  const live = comments.filter((c) => !c.parent_id);
  const replies = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of comments)
      if (c.parent_id) m.set(c.parent_id, [...(m.get(c.parent_id) ?? []), c].sort((a, b) => a.created_at.localeCompare(b.created_at)));
    return m;
  }, [comments]);
  const sorted = useMemo(
    () =>
      [...live].sort((a, b) => {
        if (a.start_frame === null) return b.start_frame === null ? a.created_at.localeCompare(b.created_at) : -1;
        if (b.start_frame === null) return 1;
        return a.start_frame - b.start_frame || a.created_at.localeCompare(b.created_at);
      }),
    [live],
  );
  const cuts = sorted.filter((c) => c.kind === "cut" && c.status !== "withdrawn" && !c.deleted_at);
  const notes = sorted.filter((c) => c.kind === "note" && c.start_frame !== null && !c.deleted_at);

  // ---- preview without cuts
  const [preview, setPreview] = useState(false);
  const [preset, setPreset] = useState<PreviewPreset>(editor ? "accepted" : "everyone");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const included = useCallback(
    (c: Comment) => {
      if (c.id in overrides) return overrides[c.id];
      if (!["open", "accepted", "done"].includes(c.status)) return false;
      if (preset === "mine") return c.author_id === me.id;
      if (preset === "accepted") return c.status !== "open";
      return true;
    },
    [overrides, preset, me.id],
  );
  const u = useMemo(() => union(cuts.filter(included).map((c) => ({ start: c.start_frame!, end: c.end_frame! }))), [cuts, included]);
  const removedFrames = removed(u);
  const previewOn = preview && u.length > 0;
  useEffect(() => {
    player.setSkipRanges(previewOn ? u : null);
  }, [previewOn, u, player]);
  // Development-only hook used by the frame-accuracy test harness.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __scrubPlayer?: unknown }).__scrubPlayer = player;
  }, [player]);

  const total = previewOn ? fc - removedFrames : fc;
  const toDisplay = useCallback((f: number) => (previewOn ? sourceToPreview(f, u) : f), [previewOn, u]);
  const fromDisplay = useCallback((d: number) => (previewOn ? previewToSource(d, u) : d), [previewOn, u]);
  const joins = useMemo(() => (previewOn ? u.map((r) => sourceToPreview(r.start, u)) : []), [previewOn, u]);

  function togglePreview() {
    const next = !preview;
    setPreview(next);
    if (next) {
      const r = rangeAt(player.store.get(), u);
      if (r) player.seek(Math.min(r.end, fc - 1));
    }
  }

  // ---- formatting
  const format = useCallback((f: number) => formatTime(f, vt, mode), [vt, mode]);
  const duration = useCallback((frames: number) => formatDuration(frames, rate), [rate]);
  const parse = useCallback(
    (s: string): number | null => {
      const t = s.trim();
      if (/^\d{1,2}:\d{2}:\d{2}[:;.]\d{2}$/.test(t)) {
        const f = timecodeToFrames(t, rate, vt.dropFrame);
        return f === null ? null : f - vt.startTcFrames;
      }
      const clock = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
      if (clock) {
        const secs = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
        return Math.round((secs * rate.num) / rate.den);
      }
      if (mode === "frames" && /^\d+$/.test(t)) return Number(t);
      if (/^\d+(\.\d+)?$/.test(t)) return Math.round((Number(t) * rate.num) / rate.den);
      return null;
    },
    [rate, vt, mode],
  );
  const parseDuration = useCallback(
    (s: string) => {
      const t = s.replace(/\s*s$/, "").trim();
      if (/^\d+(\.\d+)?$/.test(t)) return Math.round((Number(t) * rate.num) / rate.den);
      const clock = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t);
      return clock ? Math.round(((Number(clock[1]) * 60 + Number(clock[2])) * rate.num) / rate.den) : null;
    },
    [rate],
  );

  // ---- selection, ranges, cut drafting
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [inPoint, setIn] = useState<number | null>(null);
  const [outPoint, setOut] = useState<number | null>(null); // exclusive
  const [cutMode, setCutMode] = useState(false);
  const [draft, setDraft] = useState<Range | null>(null);
  const [confirming, setConfirming] = useState(false);
  const holdStart = useRef<number | null>(null);
  const timeline = useRef<TimelineHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  const ioRange = inPoint !== null && outPoint !== null && outPoint > inPoint ? { start: inPoint, end: outPoint } : null;

  const select = useCallback(
    (c: Comment) => {
      setSelectedId(c.id);
      if (c.start_frame !== null) player.seek(c.start_frame);
      document.getElementById(`c-${c.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [player],
  );

  // "View in v1" from a later version lands on that request's frame once the video can play.
  const seededFrame = useRef(false);
  useEffect(() => {
    if (initialFrame === null || seededFrame.current || player.decode !== "ok") return;
    seededFrame.current = true;
    player.seek(initialFrame);
  }, [initialFrame, player]);

  // Deep links from exports (#c-<id>) select that comment once comments load.
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || !sorted.length) return;
    const id = window.location.hash.match(/^#c-([\w-]+)/)?.[1];
    const c = id && sorted.find((x) => x.id === id);
    if (!c) return;
    linked.current = true;
    const t = window.setTimeout(() => select(c), 300);
    return () => window.clearTimeout(t);
  }, [sorted, select]);

  function startCutFromIO() {
    if (ioRange) {
      setDraft(ioRange);
      setConfirming(true);
      return true;
    }
    return false;
  }

  function cancelCut() {
    setDraft(null);
    setConfirming(false);
    setCutMode(false);
  }

  const playContext = (r: Range, asCut: boolean) => {
    const pad = Math.round((2 * rate.num) / rate.den);
    player.playWindow(Math.max(0, r.start - pad), Math.min(fc - 1, r.end + pad), asCut ? r : undefined);
  };

  // ---- keyboard
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t.closest("input, textarea, select, [contenteditable=true], [role=dialog]") !== null;
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      const f = player.store.get();
      const sec = Math.round(rate.num / rate.den);
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          if (e.key === " " || player.playing) player.toggle();
          return;
        case "l":
        case "L":
          if (player.playing) player.setRate(Math.min(4, player.playbackRate * 2));
          else {
            player.setRate(1);
            player.play();
          }
          return;
        case "j":
        case "J":
          player.seek(f - sec);
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? sec : 1);
          if (previewOn) player.seek(previewToSource(Math.max(0, Math.min(total - 1, sourceToPreview(f, u) + d)), u));
          else player.step(d);
          return;
        }
        case "i":
        case "I":
          setIn(f);
          if (outPoint !== null && outPoint <= f) setOut(null);
          return;
        case "o":
        case "O":
          setOut(f + 1);
          if (inPoint === null || inPoint > f) setIn(inPoint !== null && inPoint <= f ? inPoint : f);
          return;
        case "x":
        case "X":
          e.preventDefault(); // the reason box opens and focuses; don't type the "x" into it
          if (e.repeat) return;
          if (e.shiftKey) return togglePreview();
          if (!access.allow_comments || previewOn) return;
          if (player.playing) {
            holdStart.current = f;
            return;
          }
          if (!startCutFromIO()) setCutMode((m) => !m);
          return;
        case "[":
        case "]": {
          const list = e.key === "]" ? cuts.filter((c) => c.start_frame! > f) : [...cuts].reverse().filter((c) => c.start_frame! < f);
          if (list[0]) select(list[0]);
          return;
        }
        case "c":
        case "C":
          e.preventDefault();
          composerRef.current?.focus();
          return;
        case "+":
        case "=":
          timeline.current?.zoomIn();
          return;
        case "-":
          timeline.current?.zoomOut();
          return;
        case "0":
          timeline.current?.fit();
          return;
        case "m":
        case "M":
          player.setMuted(!player.muted);
          return;
        case "f":
        case "F":
          if (document.fullscreenElement) document.exitFullscreen();
          else stage.current?.requestFullscreen();
          return;
        case "?":
          setDialog("keys");
          return;
        case "Backspace":
        case "Delete":
          // Discards an unsaved cut only; saved cut requests are never deleted by a keypress.
          if (draft || cutMode) {
            e.preventDefault();
            cancelCut();
          }
          return;
        case "Escape":
          cancelCut();
          setIn(null);
          setOut(null);
          return;
      }
    };
    const up = (e: KeyboardEvent) => {
      if ((e.key === "x" || e.key === "X") && holdStart.current !== null) {
        const start = holdStart.current;
        holdStart.current = null;
        const end = player.store.get() + 1;
        player.pause();
        if (end > start) {
          setDraft({ start, end });
          setConfirming(true);
        }
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const canEdit = (c: Comment) => c.author_id === me.id && c.status === "open";
  const runtimeBefore = fc;
  const runtimeAfter = fc - removedFrames;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {!isLatest && (
          <div className="flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm">
            <span>You&apos;re viewing v{version.number}, not the latest version.</span>
            <button className="btn btn-sm" onClick={goLatest}>
              Go to latest
            </button>
          </div>
        )}
        <ApprovalBar
          latest={latestApproval}
          all={approvals}
          canApprove={access.allow_approval}
          me={me}
          versionLabel={`v${version.number}`}
          comments={live}
          onDecide={decide}
        />
        <div ref={stage} className="relative flex min-h-[200px] flex-1 items-center justify-center overflow-hidden rounded-md bg-black">
          <video
            ref={videoRef}
            src={url ?? undefined}
            className="max-h-full max-w-full"
            preload="auto"
            playsInline
            crossOrigin="anonymous"
            onClick={() => player.toggle()}
          />
          <canvas
            ref={freezeRef}
            aria-hidden
            className={`pointer-events-none absolute inset-0 m-auto max-h-full max-w-full ${frozenVisible ? "" : "hidden"}`}
          />
          <CutOverlay store={player.store} cuts={preview ? [] : cuts} format={duration} />
          {previewOn && (
            <div className="absolute left-3 top-3 rounded bg-cut px-2 py-0.5 text-xs font-medium text-white">Preview without cuts</div>
          )}
          {player.decode === "unsupported" && !(source === "original" && hasReview) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-6 text-center">
              <div className="max-w-md space-y-2">
                <p className="font-medium">This device can&apos;t play this video yet.</p>
                <p className="text-sm text-ink-2">
                  {version.review_status === "pending"
                    ? "It's H.265 and your editor's review copy is still being prepared. Check back in a few minutes."
                    : "It's probably H.265 on a computer without a hardware decoder. Try Chrome or Safari on a Mac, or ask your editor to create the H.264 review copy."}
                </p>
              </div>
            </div>
          )}
          {source === "review" && player.decode === "ok" && (
            <div className="absolute right-3 top-3 rounded bg-black/60 px-2 py-0.5 text-[11px] text-ink-2">Review copy (H.264)</div>
          )}
          {urlError && <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-6 text-cut">{urlError}</div>}
          {!url && !urlError && <div className="absolute text-ink-3">Loading video…</div>}
        </div>

        {editor && reviewNeeded && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
            {copyJob && "error" in copyJob ? (
              <span className="text-cut">Review copy failed: {copyJob.error}</span>
            ) : copyJob ? (
              <span>
                {copyJob.phase === "converting" && `Making the H.264 review copy… ${Math.round(copyJob.fraction * 100)}%`}
                {copyJob.phase === "checking" && "Checking the copy frame for frame…"}
                {copyJob.phase === "uploading" && `Uploading the review copy… ${Math.round(copyJob.fraction * 100)}%`}
              </span>
            ) : (
              <span>
                {version.review_status === "failed" ? "The H.264 review copy failed." : "This version has no H.264 review copy yet."} Clients on
                computers without an H.265 decoder can&apos;t play it until one exists.
              </span>
            )}
            {(!copyJob || "error" in copyJob) && (
              <button className="btn btn-sm ml-auto" onClick={createReviewCopy}>
                {copyJob ? "Try again" : "Create review copy"}
              </button>
            )}
          </div>
        )}

        <PlayerBar
          player={player}
          format={format}
          mode={mode}
          setMode={setMode}
          vfr={version.is_vfr}
          previewOn={previewOn}
          preview={preview}
          canPreview={u.length > 0}
          togglePreview={togglePreview}
          clockPreview={(f) => `${formatClock(sourceToPreview(f, u), rate)} / ${formatClock(total, rate)}`}
          cutMode={cutMode}
          toggleCutMode={() => (cutMode ? cancelCut() : !previewOn && access.allow_comments && setCutMode(true))}
          canCut={access.allow_comments && !previewOn}
          timeline={timeline}
          source={source}
          hasReview={hasReview}
          switchSource={switchSource}
          download={access.allow_download ? async () => {
            const { url: dl } = await api<{ url: string }>("/api/playback", { versionId: version.id, download: true });
            window.location.href = dl;
          } : null}
        />

        <Timeline
          ref={timeline}
          total={total}
          toDisplay={toDisplay}
          fromDisplay={fromDisplay}
          store={player.store}
          notes={previewOn ? notes.filter((n) => !rangeAt(n.start_frame!, u)) : notes}
          cuts={cuts}
          joins={joins}
          preview={previewOn}
          cutMode={cutMode && access.allow_comments}
          canCut={access.allow_comments && !previewOn}
          draft={draft}
          inOut={{ in: inPoint, out: outPoint }}
          selectedId={selectedId}
          canEdit={canEdit}
          format={format}
          onSeek={(f) => player.seek(f)}
          onSelect={(id) => {
            const c = live.find((x) => x.id === id);
            if (c) select(c);
          }}
          onDraft={(r, final) => {
            setDraft(r);
            if (final && r) {
              setConfirming(true);
              setCutMode(false);
              setTab((t) => (t === "notes" ? "all" : t));
            }
          }}
          onEditCut={(id, r) => update(id, { start_frame: r.start, end_frame: r.end }).catch((e) => alert(e.message))}
        />
        {cutMode && !confirming && (
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-cut">
            <span>Drag across the timeline, or use the playhead:</span>
            <button
              className="btn btn-sm border-cut text-cut"
              onClick={() => {
                const f = player.store.get();
                setDraft((d) => ({ start: f, end: d && d.end > f ? d.end : Math.min(fc, f + 1) }));
              }}
            >
              Set start here
            </button>
            <button
              className="btn btn-sm border-cut text-cut"
              disabled={!draft}
              onClick={() => {
                const f = player.store.get();
                if (!draft || f < draft.start) return;
                const r = { start: draft.start, end: Math.min(fc, f + 1) };
                if (r.end - r.start >= fc) return;
                setDraft(r);
                setConfirming(true);
                setCutMode(false);
              }}
            >
              Set end here
            </button>
            <span className="text-ink-3">Backspace or Esc to cancel</span>
          </div>
        )}
      </section>

      <aside className="flex min-h-[320px] w-full flex-col border-t border-line lg:w-[380px] lg:border-l lg:border-t-0">
        <Sidebar
          tab={tab}
          setTab={setTab}
          earlier={<EarlierRequests versions={versions} current={version} onView={onViewVersion} />}
          items={sorted}
          replies={replies}
          me={me}
          canComment={access.allow_comments}
          selectedId={selectedId}
          format={format}
          duration={duration}
          runtime={(f) => formatClock(f, rate)}
          totals={{ count: u.length ? cuts.filter(included).length : 0, removed: removedFrames, before: runtimeBefore, after: runtimeAfter }}
          included={included}
          setIncluded={(id, v) => setOverrides((o) => ({ ...o, [id]: v }))}
          preset={preset}
          setPreset={(p) => {
            setPreset(p);
            setOverrides({});
          }}
          hiddenInPreview={(c) => c.status === "rejected"}
          onSelect={select}
          onPlayContext={playContext}
          onStatus={(c, s, reply) => (s === "withdrawn" ? update(c.id, { status: s }) : setStatus(c.id, s, reply))}
          onReply={async (parent, body) => {
            await add({ kind: "note", start_frame: null, end_frame: null, body, parent_id: parent.id }, me);
          }}
          onEdit={(c, body) => update(c.id, { body })}
          onDelete={(c) => update(c.id, { deleted_at: new Date().toISOString() })}
        />
        <Composer
          canComment={access.allow_comments}
          frameLabel={<LiveTime store={player.store} format={format} />}
          range={ioRange}
          draftCut={draft}
          confirmingCut={confirming}
          format={format}
          parse={parse}
          parseDuration={parseDuration}
          duration={duration}
          preview={previewOn}
          inputRef={composerRef}
          onFocusTyping={() => {
            player.pause();
            return player.store.get();
          }}
          onSend={async (body, timed, frame) => {
            const r = timed ? (ioRange ?? { start: frame, end: null }) : null;
            await add({ kind: "note", start_frame: r ? r.start : null, end_frame: r && "end" in r ? (r.end as number | null) : null, body }, me);
            setIn(null);
            setOut(null);
          }}
          onCutChange={(r) => {
            const clamped = { start: Math.max(0, r.start), end: Math.min(fc, r.end) };
            if (clamped.end > clamped.start && clamped.end - clamped.start < fc) setDraft(clamped);
          }}
          onCutSubmit={async (reason) => {
            if (!draft) return;
            if (draft.end - draft.start >= fc) throw new Error("You can't cut the entire video.");
            await add({ kind: "cut", start_frame: draft.start, end_frame: draft.end, body: reason }, me);
            cancelCut();
            setIn(null);
            setOut(null);
            setTab("cuts");
          }}
          onCutCancel={cancelCut}
          onClearRange={() => (setIn(null), setOut(null))}
        />
      </aside>

      {dialog === "share" && <ShareDialog assetId={assetId} onClose={() => setDialog(null)} />}
      {dialog === "keys" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "export" && (
        <ExportDialog
          version={{ title, rate, startTcFrames: version.start_tc_frames, dropFrame: vt.dropFrame, frameCount: fc, width: version.width, height: version.height, isVfr: version.is_vfr }}
          comments={sorted}
          replies={replies}
          clock={(f) => formatClock(f, rate)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function PlayerBar({ timeline, ...p }: {
  player: Player;
  format: (f: number) => string;
  mode: TimeDisplay;
  setMode: (m: TimeDisplay) => void;
  vfr: boolean;
  previewOn: boolean;
  preview: boolean;
  canPreview: boolean;
  togglePreview: () => void;
  clockPreview: (f: number) => string;
  cutMode: boolean;
  toggleCutMode: () => void;
  canCut: boolean;
  timeline: React.RefObject<TimelineHandle | null>;
  source: "original" | "review" | null;
  hasReview: boolean;
  switchSource: (s: "original" | "review") => void;
  download: (() => Promise<void>) | null;
}) {
  const f = useFrame(p.player.store);
  const modes: TimeDisplay[] = p.vfr ? ["clock"] : ["timecode", "clock", "frames"];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn btn-sm" onClick={() => p.player.step(-1)} aria-label="Previous frame" title="Previous frame (←)">
        ◀︎|
      </button>
      <button className="btn btn-sm w-16" onClick={() => p.player.toggle()} aria-label={p.player.playing ? "Pause" : "Play"}>
        {p.player.playing ? "❚❚" : "▶︎"}
      </button>
      <button className="btn btn-sm" onClick={() => p.player.step(1)} aria-label="Next frame" title="Next frame (→)">
        |▶︎
      </button>
      <button
        className="min-w-[8.5rem] rounded px-2 py-1 text-left font-mono text-sm tabular-nums hover:bg-panel-2"
        title="Change time display"
        onClick={() => p.setMode(modes[(modes.indexOf(p.mode) + 1) % modes.length])}
      >
        {p.format(f)}
      </button>
      {p.previewOn && <span className="font-mono text-xs text-cut">{p.clockPreview(f)}</span>}
      <select className="input w-auto py-1 text-xs" value={p.player.playbackRate} onChange={(e) => p.player.setRate(Number(e.target.value))} aria-label="Speed">
        {[0.25, 0.5, 1, 1.5, 2].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      <button className="btn btn-sm" onClick={() => p.player.setMuted(!p.player.muted)} aria-label={p.player.muted ? "Unmute" : "Mute"}>
        {p.player.muted ? "🔇" : "🔊"}
      </button>
      {p.hasReview && (
        <select
          className="input w-auto py-1 text-xs"
          value={p.source ?? "original"}
          onChange={(e) => p.switchSource(e.target.value as "original" | "review")}
          aria-label="Which file to play"
          title="The review copy is a lighter H.264 version with identical frame numbers"
        >
          <option value="original">Original</option>
          <option value="review">Review copy</option>
        </select>
      )}
      {p.download && (
        <button className="btn btn-sm" onClick={p.download} title="Download the original file">
          ⤓
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          className={`btn btn-sm ${p.cutMode ? "btn-cut" : ""}`}
          disabled={!p.canCut}
          onClick={p.toggleCutMode}
          title="Request a cut (X)"
        >
          ✂ Cut
        </button>
        <button
          className={`btn btn-sm ${p.preview && p.canPreview ? "border-cut text-cut" : ""}`}
          disabled={!p.canPreview}
          onClick={p.togglePreview}
          title="Preview without cuts (Shift+X)"
        >
          {p.preview && p.canPreview ? "Previewing without cuts" : "Preview without cuts"}
        </button>
        <span className="hidden items-center gap-1 sm:flex">
          <button className="btn btn-sm" onClick={() => timeline.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button className="btn btn-sm" onClick={() => timeline.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
        </span>
      </div>
    </div>
  );
}

function CutOverlay({ store, cuts, format }: { store: FrameStore; cuts: Comment[]; format: (frames: number) => string }) {
  const f = useFrame(store);
  const c = cuts.find((x) => (x.status === "open" || x.status === "accepted") && f >= x.start_frame! && f < x.end_frame!);
  if (!c) return null;
  return (
    <div className="pointer-events-none absolute inset-0 border-4 border-cut/80">
      <span className="absolute right-2 top-2 rounded bg-cut px-2 py-0.5 text-xs font-medium text-white">
        ✂ Cut requested by {c.author_name} · −{format(c.end_frame! - c.start_frame!)}
      </span>
    </div>
  );
}


function LiveTime({ store, format }: { store: FrameStore; format: (f: number) => string }) {
  return <>{format(useFrame(store))}</>;
}
