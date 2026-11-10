"use client";
import { useEffect, useRef, useState } from "react";
import type { Range } from "@/lib/ranges";

type Props = {
  canComment: boolean;
  frameLabel: React.ReactNode;
  range: Range | null; // from I/O
  draftCut: Range | null;
  confirmingCut: boolean;
  format: (f: number) => string;
  parse: (s: string) => number | null;
  parseDuration: (s: string) => number | null;
  duration: (frames: number) => string;
  preview: boolean;
  onFocusTyping: () => number; // pauses the player and returns the captured frame
  onSend: (body: string, timed: boolean, capturedFrame: number) => Promise<void>;
  onCutChange: (r: Range) => void;
  onCutSubmit: (reason: string) => Promise<void>;
  onCutCancel: () => void;
  onClearRange: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function Composer({ inputRef, ...p }: Props) {
  const [body, setBody] = useState("");
  const [timed, setTimed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const captured = useRef<number | null>(null);

  if (!p.canComment) {
    return <div className="border-t border-line p-3 text-sm text-ink-3">Commenting is turned off for this link.</div>;
  }

  if (p.confirmingCut && p.draftCut) {
    return <CutConfirm {...p} draft={p.draftCut} />;
  }

  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await p.onSend(body.trim(), timed, captured.current ?? p.onFocusTyping());
      setBody("");
      captured.current = null;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-line p-3">
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <button className={`rounded px-1.5 py-0.5 ${timed ? "bg-panel-2 text-ink" : ""}`} onClick={() => setTimed(true)}>
          {p.range ? `${p.format(p.range.start)} → ${p.format(p.range.end)}` : <>At {p.frameLabel}</>}
        </button>
        <button className={`rounded px-1.5 py-0.5 ${!timed ? "bg-panel-2 text-ink" : ""}`} onClick={() => setTimed(false)}>
          General
        </button>
        {p.range && (
          <button className="ml-auto text-ink-3 hover:text-ink" onClick={p.onClearRange} title="Clear in/out (Esc)">
            clear range
          </button>
        )}
      </div>
      <textarea
        ref={inputRef}
        className="input resize-none"
        rows={2}
        placeholder="Leave a comment… (Enter to send)"
        value={body}
        onChange={(e) => {
          if (captured.current === null && e.target.value) captured.current = p.onFocusTyping();
          setBody(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-3">
          <span className="kbd">X</span> request a cut · <span className="kbd">I</span>/<span className="kbd">O</span> range · <span className="kbd">?</span> keys
        </span>
        <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={send}>
          Send
        </button>
      </div>
      {err && <p className="text-xs text-cut">{err}</p>}
    </div>
  );
}

function CutConfirm(p: Omit<Props, "inputRef"> & { draft: Range }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => reasonRef.current?.focus(), []);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await p.onCutSubmit(reason.trim());
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t-2 border-cut bg-cut/5 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-cut">✂ Request a cut</span>
        <span className="font-mono text-sm text-cut">−{p.duration(p.draft.end - p.draft.start)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <TimeField label="In (first frame removed)" value={p.draft.start} {...p} onCommit={(f) => f < p.draft.end && p.onCutChange({ start: f, end: p.draft.end })} />
        <TimeField label="Out (first frame kept)" value={p.draft.end} {...p} onCommit={(f) => f > p.draft.start && p.onCutChange({ start: p.draft.start, end: f })} />
        <TimeField label="Duration" value={p.draft.end - p.draft.start} {...p} isDuration onCommit={(f) => f > 0 && p.onCutChange({ start: p.draft.start, end: p.draft.start + f })} />
      </div>
      <textarea
        ref={reasonRef}
        className="input resize-none"
        rows={2}
        placeholder="Why? (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") p.onCutCancel();
        }}
      />
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost btn-sm" onClick={p.onCutCancel}>
          Cancel
        </button>
        <button className="btn btn-cut btn-sm" disabled={busy} onClick={submit}>
          Request cut
        </button>
      </div>
      {err && <p className="text-xs text-cut">{err}</p>}
    </div>
  );
}

function TimeField(p: { label: string; value: number; format: (f: number) => string; duration: (f: number) => string; parse: (s: string) => number | null; parseDuration: (s: string) => number | null; isDuration?: boolean; onCommit: (f: number) => void }) {
  const shown = p.isDuration ? p.duration(p.value) : p.format(p.value);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const commit = () => {
    setFocused(false);
    const f = p.isDuration ? p.parseDuration(text) : p.parse(text);
    if (f !== null) p.onCommit(f);
  };
  return (
    <label className="space-y-0.5">
      <span className="block text-[10px] uppercase tracking-wide text-ink-3">{p.label}</span>
      <input
        className="input px-1.5 py-1 font-mono text-xs"
        value={focused ? text : shown}
        onFocus={() => (setText(shown), setFocused(true))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}
