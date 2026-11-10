"use client";
// Cut requests follow the asset across versions: a checklist when a new version lands,
// and an "Earlier requests" list on the new version so the client can check what was done.
import { useEffect, useState } from "react";
import { supabase, errorMessage } from "@/lib/client/supabase";
import { formatClock, formatDuration } from "@/lib/timecode";
import { versionRate, type Comment, type Version } from "@/lib/types";
import { Modal } from "./Dialogs";

const STATUS: Record<string, string> = {
  open: "Still open",
  accepted: "Accepted",
  rejected: "Declined",
  done: "Done",
  withdrawn: "Withdrawn",
};

export function ResolveDialog({
  earlier,
  next,
  onClose,
}: {
  earlier: Version[];
  next: Version;
  onClose: () => void;
}) {
  const [cuts, setCuts] = useState<Comment[] | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ids = earlier.map((v) => v.id).join(",");

  useEffect(() => {
    supabase()
      .from("comments")
      .select("*")
      .in("version_id", ids.split(","))
      .eq("kind", "cut")
      .is("deleted_at", null)
      .in("status", ["open", "accepted"])
      .order("start_frame")
      .then(({ data }) => {
        const rows = (data ?? []) as Comment[];
        setCuts(rows);
        setDone(
          Object.fromEntries(rows.map((c) => [c.id, c.status === "accepted"])),
        );
      });
  }, [ids]);

  if (cuts && cuts.length === 0) return null;

  async function confirm() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase().rpc("resolve_cut_requests", {
      p_version: next.id,
      p_done: Object.keys(done).filter((id) => done[id] && !rejected[id]),
      p_rejected: Object.keys(rejected).filter((id) => rejected[id]),
      p_reply: reply || null,
    });
    setBusy(false);
    if (error) return setErr(errorMessage(error));
    onClose();
  }

  const anyRejected = Object.values(rejected).some(Boolean);
  return (
    <Modal
      title={`v${next.number} is up. What happened to the earlier cut requests?`}
      onClose={onClose}
    >
      {!cuts ? (
        <p className="text-ink-3">Loading…</p>
      ) : (
        <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
          {cuts.map((c) => {
            const v = earlier.find((x) => x.id === c.version_id)!;
            const rate = versionRate(v);
            return (
              <li
                key={c.id}
                className="rounded-md border border-line p-2.5 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-3">v{v.number}</span>
                  <span className="font-mono text-xs text-ink-2">
                    {formatClock(c.start_frame!, rate)} →{" "}
                    {formatClock(c.end_frame!, rate)}
                  </span>
                  <span className="text-xs text-cut">
                    −{formatDuration(c.end_frame! - c.start_frame!, rate)}
                  </span>
                  <span className="text-xs text-ink-3">
                    {c.author_name} · {STATUS[c.status]}
                  </span>
                </div>
                {c.body && <p className="mt-1 text-ink-2">{c.body}</p>}
                <div className="mt-1.5 flex gap-4 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!!done[c.id] && !rejected[c.id]}
                      onChange={(e) => (
                        setDone({ ...done, [c.id]: e.target.checked }),
                        setRejected({ ...rejected, [c.id]: false })
                      )}
                    />
                    Done in v{next.number}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!!rejected[c.id]}
                      onChange={(e) =>
                        setRejected({ ...rejected, [c.id]: e.target.checked })
                      }
                    />
                    Not doing this
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {anyRejected && (
        <textarea
          className="input"
          rows={2}
          placeholder="Why not? (sent as a reply on each declined request)"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
      )}
      <p className="text-xs text-ink-3">
        Unticked requests stay as they are and keep showing on v{next.number} as
        still open.
      </p>
      {err && <p className="text-sm text-cut">{err}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onClose}>
          Later
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !cuts || (anyRejected && !reply.trim())}
          onClick={confirm}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/** Cut requests from earlier versions of the same asset, shown on a later version. */
export function EarlierRequests({
  versions,
  current,
  onView,
}: {
  versions: Version[];
  current: Version;
  onView: (versionId: string, frame: number) => void;
}) {
  const earlier = versions.filter(
    (v) => v.number < current.number && v.status === "ready",
  );
  const [cuts, setCuts] = useState<Comment[]>([]);
  const [open, setOpen] = useState(true);
  const ids = earlier.map((v) => v.id).join(",");

  useEffect(() => {
    if (!ids) return;
    const sb = supabase();
    const load = () =>
      sb
        .from("comments")
        .select("*")
        .in("version_id", ids.split(","))
        .eq("kind", "cut")
        .is("deleted_at", null)
        .neq("status", "withdrawn")
        .order("start_frame")
        .then(({ data }) => setCuts((data ?? []) as Comment[]));
    const channel = sb
      .channel(`earlier:${ids}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "comments", filter: `version_id=in.(${ids})` }, () => load())
      .subscribe((status) => status === "SUBSCRIBED" && load());
    return () => {
      sb.removeChannel(channel);
    };
  }, [ids]);

  if (!earlier.length || !cuts.length) return null;
  const pending = cuts.filter(
    (c) => c.status === "open" || c.status === "accepted",
  ).length;

  return (
    <div className="mb-2 rounded-lg border border-line bg-panel-2/40">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
        onClick={() => setOpen(!open)}
      >
        <span>
          From earlier versions · {cuts.length} request
          {cuts.length === 1 ? "" : "s"}
          {pending > 0 && (
            <span className="ml-1 text-accent">({pending} not done)</span>
          )}
        </span>
        <span className="text-ink-3">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="space-y-1.5 px-3 pb-3">
          {cuts.map((c) => {
            const v = earlier.find((x) => x.id === c.version_id)!;
            const rate = versionRate(v);
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
              >
                <span className="text-ink-3">v{v.number}</span>
                <span className="font-mono text-ink-2">
                  {formatClock(c.start_frame!, rate)} →{" "}
                  {formatClock(c.end_frame!, rate)}
                </span>
                <span
                  className={`rounded px-1 ${
                    c.status === "done"
                      ? "bg-good/20 text-good"
                      : c.status === "rejected"
                        ? "border border-ink-3 text-ink-2"
                        : "bg-cut/20 text-cut"
                  }`}
                >
                  {STATUS[c.status]}
                  {c.status === "done" && c.done_in_version_id
                    ? ` in v${versions.find((x) => x.id === c.done_in_version_id)?.number ?? "?"}`
                    : ""}
                </span>
                <span className="text-ink-2">{c.author_name}</span>
                {c.body && (
                  <span className="w-full truncate text-ink-3">{c.body}</span>
                )}
                <button
                  className="text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                  onClick={() => onView(v.id, c.start_frame!)}
                >
                  view in v{v.number}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
