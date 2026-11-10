"use client";
import { useEffect, useState } from "react";
import { supabase, errorMessage } from "@/lib/client/supabase";
import { cutList, toCsv, toPremiereXml, toResolveEdl, type ExportItem, type ExportVersion } from "@/lib/exports";
import { canDropFrame, framesToTimecode, timecodeToFrames } from "@/lib/timecode";
import type { Comment, ShareLink } from "@/lib/types";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh]" onPointerDown={onClose}>
      <div role="dialog" aria-label={title} className="card w-full max-w-lg space-y-4 p-5" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

type Grant = { share_link_id: string; display_name: string; created_at: string };

export function ShareDialog({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const sb = supabase();
    const { data, error } = await sb.from("share_links").select("*").eq("asset_id", assetId).order("created_at");
    if (error) return setError(error.message);
    setLinks(data as ShareLink[]);
    const ids = (data ?? []).map((l) => l.id);
    if (ids.length) {
      const { data: g } = await sb.from("share_link_grants").select("share_link_id, display_name, created_at").in("share_link_id", ids);
      setGrants((g ?? []) as Grant[]);
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch; state is set after the await
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const url = (l: ShareLink) => `${window.location.origin}/r/${l.token}`;

  async function create() {
    const { error } = await supabase().rpc("create_share_link", { p_asset: assetId });
    if (error) return setError(errorMessage(error));
    load();
  }
  async function patch(l: ShareLink, p: Partial<ShareLink>) {
    const { error } = await supabase().from("share_links").update(p).eq("id", l.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  const active = links.filter((l) => !l.revoked_at);
  return (
    <Modal title="Share for review" onClose={onClose}>
      <p className="text-sm text-ink-2">
        Anyone with the link can watch the latest version and leave feedback after typing their name. No account needed.
      </p>
      {active.map((l) => (
        <div key={l.id} className="space-y-2 rounded-md border border-line p-3">
          <div className="flex gap-2">
            <input className="input font-mono text-xs" readOnly value={url(l)} onFocus={(e) => e.target.select()} />
            <button
              className="btn btn-primary shrink-0"
              onClick={async () => {
                await navigator.clipboard.writeText(url(l));
                setCopied(l.id);
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              {copied === l.id ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={l.allow_comments} onChange={(e) => patch(l, { allow_comments: e.target.checked })} /> Comments and cut requests
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={l.allow_download} onChange={(e) => patch(l, { allow_download: e.target.checked })} /> Downloads
            </label>
            <button className="btn btn-ghost btn-sm ml-auto text-cut" onClick={() => confirm("Revoke this link? Guests lose access immediately.") && patch(l, { revoked_at: new Date().toISOString() })}>
              Revoke
            </button>
          </div>
          {grants.filter((g) => g.share_link_id === l.id).length > 0 && (
            <p className="text-xs text-ink-3">
              Joined: {grants.filter((g) => g.share_link_id === l.id).map((g) => g.display_name).join(", ")}
            </p>
          )}
        </div>
      ))}
      <button className="btn" onClick={create}>
        {active.length ? "Create another link" : "Create share link"}
      </button>
      {error && <p className="text-sm text-cut">{error}</p>}
    </Modal>
  );
}

type Format = "resolve" | "premiere" | "csv" | "cutlist";

export function ExportDialog({
  version,
  comments,
  replies,
  clock,
  onClose,
}: {
  version: ExportVersion & { isVfr: boolean };
  comments: Comment[];
  replies: Map<string, Comment[]>;
  clock: (f: number) => string;
  onClose: () => void;
}) {
  const df = version.dropFrame && canDropFrame(version.rate);
  const [format, setFormat] = useState<Format>("resolve");
  const [notes, setNotes] = useState(true);
  const [includeDoneNotes, setIncludeDoneNotes] = useState(false);
  const [cutStatuses, setCutStatuses] = useState<Record<string, boolean>>({ open: true, accepted: true, done: false, rejected: false });
  const [tc, setTc] = useState(framesToTimecode(version.startTcFrames, version.rate, df));
  const [copied, setCopied] = useState(false);
  const startFrames = timecodeToFrames(tc, version.rate, df);

  const items: ExportItem[] = comments
    .filter((c) => !c.deleted_at && c.status !== "withdrawn")
    .filter((c) => (c.kind === "cut" ? cutStatuses[c.status] : notes && (includeDoneNotes || c.status !== "done")))
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      startFrame: c.start_frame,
      endFrame: c.end_frame,
      body: c.body,
      authorName: c.author_name,
      authorRole: c.author_role,
      status: c.status,
      replies: replies.get(c.id)?.length ?? 0,
    }));
  const v = { ...version, startTcFrames: startFrames ?? version.startTcFrames };
  const base = version.title.replace(/[^\w\- ]+/g, "").trim() || "scrub";

  function download() {
    if (format === "cutlist") {
      navigator.clipboard.writeText(cutList(v, items, clock));
      setCopied(true);
      return;
    }
    const [content, ext, type] =
      format === "resolve"
        ? [toResolveEdl(v, items), "edl", "text/plain"]
        : format === "premiere"
          ? [toPremiereXml(v, items), "xml", "application/xml"]
          : [toCsv(v, items, (id) => `${window.location.href.split("#")[0]}#c-${id}`), "csv", "text/csv"];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = `${base} - markers.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const timedCount = items.filter((i) => i.startFrame !== null).length;
  const nleBlocked = version.isVfr && (format === "resolve" || format === "premiere");

  return (
    <Modal title="Export feedback" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["resolve", "DaVinci Resolve", "Marker EDL"],
            ["premiere", "Premiere Pro", "FCP7 XML"],
            ["csv", "Spreadsheet", "CSV"],
            ["cutlist", "Cut list", "Copy as text"],
          ] as const
        ).map(([k, name, sub]) => (
          <button key={k} className={`rounded-md border p-2.5 text-left ${format === k ? "border-accent bg-accent/10" : "border-line hover:border-line-2"}`} onClick={() => setFormat(k)}>
            <div className="text-sm font-medium">{name}</div>
            <div className="text-xs text-ink-3">{sub}</div>
          </button>
        ))}
      </div>

      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Comments
          <label className="ml-3 flex items-center gap-1 text-ink-2">
            <input type="checkbox" checked={includeDoneNotes} onChange={(e) => setIncludeDoneNotes(e.target.checked)} /> include done
          </label>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span>Cut requests:</span>
          {Object.keys(cutStatuses).map((s) => (
            <label key={s} className="flex items-center gap-1 text-ink-2">
              <input type="checkbox" checked={cutStatuses[s]} onChange={(e) => setCutStatuses({ ...cutStatuses, [s]: e.target.checked })} /> {s}
            </label>
          ))}
        </div>
      </div>

      {format !== "cutlist" && format !== "csv" && (
        <label className="block space-y-1">
          <span className="label">Timeline start timecode</span>
          <input className="input w-40 font-mono" value={tc} onChange={(e) => setTc(e.target.value)} />
          <span className="block text-xs text-ink-3">
            Must match the start of the timeline you exported, or markers land in the wrong place.
          </span>
        </label>
      )}

      {format === "resolve" && (
        <p className="text-xs text-ink-2">
          In Resolve: right-click your timeline in the Media Pool → Timelines → Import → Timeline Markers from EDL.
        </p>
      )}
      {format === "premiere" && (
        <ol className="list-decimal space-y-0.5 pl-4 text-xs text-ink-2">
          <li>File → Import the XML. It creates a sequence holding only the markers.</li>
          <li>In the Markers menu, turn on “Copy Paste Includes Sequence Markers”.</li>
          <li>Copy everything from that sequence and paste it at the start of your real sequence.</li>
        </ol>
      )}
      {nleBlocked && <p className="text-sm text-accent">This version has a variable frame rate, so frame-exact markers aren&apos;t possible. Use CSV.</p>}

      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-3">{format === "cutlist" ? `${items.filter((i) => i.kind === "cut").length} cut requests` : `${timedCount} markers`}</span>
        <button className="btn btn-primary" disabled={startFrames === null || nleBlocked || items.length === 0} onClick={download}>
          {format === "cutlist" ? (copied ? "Copied" : "Copy cut list") : "Download"}
        </button>
      </div>
    </Modal>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["Space / K", "Play or pause"],
    ["L / J", "Play (faster on repeat) / jump back 1 s"],
    ["← / →", "Step 1 frame"],
    ["Shift + ← / →", "Step 1 second"],
    ["I / O", "Set in / out point (O includes the current frame)"],
    ["X", "Request a cut (from I/O, or drag on the timeline)"],
    ["Hold X while playing", "Mark a cut live; release to end it"],
    ["Shift + X", "Preview without cuts"],
    ["[ / ]", "Previous / next cut request"],
    ["C", "Write a comment"],
    ["+ / − / 0", "Zoom timeline in / out / fit"],
    ["Ctrl or ⌘ + scroll", "Zoom around the mouse"],
    ["Alt while dragging", "Turn off snapping"],
    ["M / F", "Mute / fullscreen"],
    ["Esc", "Cancel, clear range, leave cut mode"],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-line last:border-0">
              <td className="py-1.5 pr-3 font-mono text-xs text-ink-2">{k}</td>
              <td className="py-1.5">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
