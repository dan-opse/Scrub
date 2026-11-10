"use client";
import { useState } from "react";
import type { Approval, Comment } from "@/lib/types";
import { Modal } from "./Dialogs";

type Props = {
  latest: Approval | null;
  all: Approval[];
  canApprove: boolean;
  me: { id: string; role: "editor" | "guest" };
  versionLabel: string;
  comments: Comment[]; // top-level, this version
  onDecide: (decision: Approval["decision"], note: string) => Promise<void>;
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ApprovalBar(p: Props) {
  const [open, setOpen] = useState<Approval["decision"] | null>(null);
  const [history, setHistory] = useState(false);
  const approved = p.latest?.decision === "approved";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {p.latest ? (
        <button
          className={`rounded px-2 py-0.5 text-xs font-medium ${approved ? "bg-good/20 text-good" : "bg-accent/20 text-accent"}`}
          onClick={() => setHistory(true)}
          title="Show history"
        >
          {approved ? "✓ Approved" : "Changes requested"} by {p.latest.author_name} · {when(p.latest.created_at)}
        </button>
      ) : (
        <span className="text-xs text-ink-3">Not yet approved</span>
      )}
      {p.canApprove && (
        <span className="ml-auto flex gap-1.5">
          {!approved && (
            <button className="btn btn-sm border-good text-good" onClick={() => setOpen("approved")}>
              Approve {p.versionLabel}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setOpen("changes_requested")}>
            Request changes
          </button>
        </span>
      )}
      {open && <DecisionDialog decision={open} {...p} onClose={() => setOpen(null)} />}
      {history && (
        <Modal title="Approval history" onClose={() => setHistory(false)}>
          <ul className="space-y-2">
            {p.all.map((a) => (
              <li key={a.id} className="rounded-md border border-line p-2.5 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className={a.decision === "approved" ? "text-good" : "text-accent"}>
                    {a.decision === "approved" ? "Approved" : "Changes requested"} by {a.author_name}
                  </span>
                  <span className="text-xs text-ink-3">{when(a.created_at)}</span>
                </div>
                {a.note && <p className="mt-1 whitespace-pre-wrap text-ink-2">{a.note}</p>}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

function DecisionDialog(p: Props & { decision: Approval["decision"]; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = p.comments.filter((c) => c.author_id === p.me.id && !c.deleted_at);
  const openCuts = mine.filter((c) => c.kind === "cut" && (c.status === "open" || c.status === "accepted")).length;
  const doneCuts = mine.filter((c) => c.kind === "cut" && c.status === "done").length;
  const rejectedCuts = mine.filter((c) => c.kind === "cut" && c.status === "rejected").length;
  const openNotes = mine.filter((c) => c.kind === "note" && c.status === "open").length;
  const approving = p.decision === "approved";

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await p.onDecide(p.decision, note);
      p.onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={approving ? `Approve ${p.versionLabel}` : "Request changes"} onClose={p.onClose}>
      {mine.length > 0 && (
        <p className="text-sm text-ink-2">
          Your feedback on this version: {doneCuts} cut request{doneCuts === 1 ? "" : "s"} done
          {rejectedCuts > 0 && `, ${rejectedCuts} declined (see replies)`}
          {openCuts > 0 && `, ${openCuts} still open`}
          {openNotes > 0 && `; ${openNotes} open comment${openNotes === 1 ? "" : "s"}`}.
        </p>
      )}
      {approving && openCuts > 0 && (
        <p className="text-sm text-accent">You still have open cut requests. Approving means the current version is fine as it is.</p>
      )}
      <textarea
        className="input"
        rows={3}
        autoFocus
        placeholder={approving ? "Anything to add? (optional)" : "What needs to change?"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {err && <p className="text-sm text-cut">{err}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={p.onClose}>
          Cancel
        </button>
        <button className={`btn ${approving ? "btn-primary" : ""}`} disabled={busy || (!approving && !note.trim())} onClick={submit}>
          {approving ? "Approve" : "Send request"}
        </button>
      </div>
    </Modal>
  );
}
