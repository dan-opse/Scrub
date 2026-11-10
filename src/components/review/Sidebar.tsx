"use client";
import { useState } from "react";
import type { Comment } from "@/lib/types";
import type { Range } from "@/lib/ranges";

export type Tab = "all" | "notes" | "cuts";
export type PreviewPreset = "everyone" | "mine" | "accepted";

type Props = {
  tab: Tab;
  setTab: (t: Tab) => void;
  items: Comment[]; // top-level, sorted
  replies: Map<string, Comment[]>;
  me: { id: string; role: "editor" | "guest" };
  canComment: boolean;
  selectedId: string | null;
  format: (f: number) => string;
  duration: (frames: number) => string;
  runtime: (frames: number) => string;
  totals: { count: number; removed: number; before: number; after: number };
  included: (c: Comment) => boolean;
  setIncluded: (id: string, v: boolean) => void;
  preset: PreviewPreset;
  setPreset: (p: PreviewPreset) => void;
  hiddenInPreview: (c: Comment) => boolean;
  onSelect: (c: Comment) => void;
  onPlayContext: (r: Range, asCut: boolean) => void;
  onStatus: (c: Comment, status: Comment["status"], reply?: string) => Promise<void>;
  onReply: (parent: Comment, body: string) => Promise<void>;
  onEdit: (c: Comment, body: string) => Promise<void>;
  onDelete: (c: Comment) => Promise<void>;
};

const STATUS_LABEL: Record<Comment["status"], string> = {
  open: "Open",
  accepted: "Accepted",
  rejected: "Rejected",
  done: "Done",
  withdrawn: "Withdrawn",
};

export function Sidebar(p: Props) {
  const cuts = p.items.filter((c) => c.kind === "cut");
  const shown = p.items.filter((c) => (p.tab === "all" ? true : p.tab === "cuts" ? c.kind === "cut" : c.kind === "note"));
  const tabBtn = (t: Tab, label: string, n: number) => (
    <button
      role="tab"
      aria-selected={p.tab === t}
      onClick={() => p.setTab(t)}
      className={`flex-1 border-b-2 px-2 py-2 text-sm ${p.tab === t ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
    >
      {label} <span className="text-ink-3">{n}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="flex border-b border-line">
        {tabBtn("all", "All", p.items.length)}
        {tabBtn("notes", "Comments", p.items.length - cuts.length)}
        {tabBtn("cuts", "Cuts", cuts.filter((c) => c.status !== "withdrawn").length)}
      </div>

      {p.tab === "cuts" && (
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm">
              {p.totals.count} in preview{p.totals.count > 0 && (<> · <span className="font-medium text-cut">−{p.duration(p.totals.removed)}</span></>)}
            </span>
            <span className="font-mono text-sm text-ink-2">
              {p.runtime(p.totals.before)} → {p.runtime(p.totals.after)}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-2">
            Preview includes
            <select className="input w-auto py-0.5 text-xs" value={p.preset} onChange={(e) => p.setPreset(e.target.value as PreviewPreset)}>
              <option value="everyone">everyone&apos;s requests</option>
              <option value="mine">only mine</option>
              <option value="accepted">accepted only</option>
            </select>
          </label>
        </div>
      )}

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {shown.length === 0 && (
          <li className="p-4 text-center text-sm text-ink-3">
            {p.tab === "cuts"
              ? "No cut requests. Press X, then drag across the timeline to mark a section to remove."
              : "No comments yet. Pause anywhere and type below."}
          </li>
        )}
        {shown.map((c) => (
          <Card key={c.id} c={c} {...p} replies={p.replies.get(c.id) ?? []} />
        ))}
      </ul>
    </div>
  );
}

function Card(props: Omit<Props, "replies" | "items"> & { c: Comment; replies: Comment[] }) {
  const { c, me, format, duration } = props;
  const [replying, setReplying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isCut = c.kind === "cut";
  const mine = c.author_id === me.id;
  const editor = me.role === "editor";
  const sel = props.selectedId === c.id;
  const withdrawn = c.status === "withdrawn";
  const deleted = !!c.deleted_at;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setText("");
      setReplying(false);
      setRejecting(false);
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const time =
    c.start_frame === null
      ? "General"
      : c.end_frame !== null
        ? `${format(c.start_frame)} → ${format(c.end_frame)}`
        : format(c.start_frame);

  return (
    <li
      id={`c-${c.id}`}
      className={`rounded-lg border p-3 ${sel ? "border-accent bg-panel-2" : "border-line bg-panel"} ${withdrawn || deleted ? "opacity-50" : ""}`}
    >
      <button className="flex w-full items-center gap-2 text-left" onClick={() => props.onSelect(c)}>
        <span aria-hidden className={isCut ? "text-cut" : "text-note"}>
          {isCut ? "✂" : "●"}
        </span>
        <span className="font-mono text-xs text-ink-2">{time}</span>
        {isCut && <span className="text-xs font-medium text-cut">−{duration(c.end_frame! - c.start_frame!)}</span>}
        {c.pending && <span className="text-xs text-accent">not sent yet</span>}
        <span className="ml-auto">
          {(isCut || c.status === "done") && (
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${c.status === "rejected" ? "border border-ink-3 text-ink-2" : c.status === "open" ? "bg-cut/20 text-cut" : "bg-panel-2 text-ink-2"}`}>
              {STATUS_LABEL[c.status]}
            </span>
          )}
        </span>
      </button>

      <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
        <span className="text-ink-2">{c.author_name}</span>
        <span className={`rounded px-1 ${c.author_role === "editor" ? "bg-accent/20 text-accent" : "bg-panel-2"}`}>
          {c.author_role === "editor" ? "Editor" : "Guest"}
        </span>
        {isCut && props.hiddenInPreview(c) === false && !withdrawn && (
          <label className="ml-auto flex items-center gap-1">
            <input type="checkbox" checked={props.included(c)} onChange={(e) => props.setIncluded(c.id, e.target.checked)} /> in preview
          </label>
        )}
      </div>

      {editing ? (
        <textarea className="input mt-2" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm">
          {deleted ? <em className="text-ink-3">Comment deleted</em> : c.body || (isCut ? <span className="text-ink-3">No reason given</span> : null)}
        </p>
      )}

      {isCut && !withdrawn && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button className="btn btn-sm" onClick={() => props.onPlayContext({ start: c.start_frame!, end: c.end_frame! }, false)}>
            ▶ In context
          </button>
          <button className="btn btn-sm" onClick={() => props.onPlayContext({ start: c.start_frame!, end: c.end_frame! }, true)}>
            ▶ As cut
          </button>
        </div>
      )}

      {props.replies.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l-2 border-line pl-2.5">
          {props.replies.map((r) => (
            <li key={r.id} className="text-sm">
              <span className="text-xs text-ink-2">
                {r.author_name}
                {r.author_role === "editor" && <span className="ml-1 text-accent">Editor</span>}
              </span>
              <p className="whitespace-pre-wrap break-words">{r.deleted_at ? <em className="text-ink-3">deleted</em> : r.body}</p>
            </li>
          ))}
        </ul>
      )}

      {(replying || rejecting) && (
        <div className="mt-2 space-y-1.5">
          <textarea
            className="input"
            rows={2}
            autoFocus
            placeholder={rejecting ? "Why not? The client will see this." : "Reply…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            <button className="btn btn-ghost btn-sm" onClick={() => (setReplying(false), setRejecting(false))}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !text.trim()}
              onClick={() => run(() => (rejecting ? props.onStatus(c, "rejected", text) : props.onReply(c, text)))}
            >
              {rejecting ? "Reject with reply" : "Reply"}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-1.5 flex justify-end gap-1.5">
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => props.onEdit(c, text))}>
            Save
          </button>
        </div>
      )}

      {!replying && !rejecting && !editing && !deleted && (
        <div className="mt-2 flex flex-wrap gap-1 text-xs">
          {props.canComment && !withdrawn && (
            <button className="btn btn-ghost btn-sm" onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
          {editor && isCut && c.status === "open" && (
            <>
              <button className="btn btn-sm" disabled={busy} onClick={() => run(() => props.onStatus(c, "accepted"))}>
                Accept
              </button>
              <button className="btn btn-sm" onClick={() => setRejecting(true)}>
                Reject
              </button>
            </>
          )}
          {editor && isCut && c.status === "accepted" && (
            <>
              <button className="btn btn-sm" disabled={busy} onClick={() => run(() => props.onStatus(c, "done"))}>
                Mark done
              </button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => props.onStatus(c, "open"))}>
                Undo accept
              </button>
            </>
          )}
          {editor && isCut && (c.status === "rejected" || c.status === "done") && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => props.onStatus(c, "open"))}>
              Reopen
            </button>
          )}
          {editor && !isCut && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => props.onStatus(c, c.status === "done" ? "open" : "done"))}>
              {c.status === "done" ? "Reopen" : "Mark done"}
            </button>
          )}
          {mine && (!isCut || c.status === "open") && (
            <button className="btn btn-ghost btn-sm" onClick={() => (setText(c.body), setEditing(true))}>
              Edit
            </button>
          )}
          {mine && isCut && c.status === "open" && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => confirm("Withdraw this cut request?") && run(() => props.onStatus(c, "withdrawn"))}
            >
              Withdraw
            </button>
          )}
          {((mine && !isCut) || (editor && !mine)) && (
            <button className="btn btn-ghost btn-sm text-ink-3" disabled={busy} onClick={() => confirm("Delete this comment?") && run(() => props.onDelete(c))}>
              Delete
            </button>
          )}
        </div>
      )}
      {err && <p className="mt-1 text-xs text-cut">{err}</p>}
    </li>
  );
}
