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
    <div className="border-t border-line p-3">
      <div className="rounded-xl border border-line bg-bg transition-colors focus-within:border-line-2">
        <div className="flex items-start gap-2 px-2.5 pt-2.5">
          <button
            className={`mt-px shrink-0 rounded px-1.5 py-0.5 font-mono text-[12px] tabular-nums transition-colors ${
              timed ? "bg-accent/15 text-accent hover:bg-accent/25" : "bg-panel-2 text-ink-3 line-through hover:text-ink-2"
            }`}
            onClick={() => setTimed((t) => !t)}
            title={timed ? "Pinned to this moment. Click to make it a general comment." : "General comment. Click to pin it to the current frame."}
          >
            {p.range ? (
              <>
                {p.format(p.range.start)} – {p.format(p.range.end)}
              </>
            ) : (
              p.frameLabel
            )}
          </button>
          <textarea
            ref={inputRef}
            className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-ink-3 [field-sizing:content]"
            rows={1}
            placeholder={timed ? "Leave your comment…" : "Leave a general comment…"}
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
        </div>
        <div className="flex items-center gap-2 px-2.5 pb-2 pt-1.5">
          {p.range ? (
            <button className="text-xs text-ink-3 hover:text-ink" onClick={p.onClearRange} title="Clear in/out (Esc)">
              × clear range
            </button>
          ) : (
            <span className="text-[11px] text-ink-3">
              <span className="kbd">X</span> cut · <span className="kbd">I</span>/<span className="kbd">O</span> range · <span className="kbd">?</span> keys
            </span>
          )}
          <button
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-black transition-opacity disabled:opacity-30"
            disabled={busy || !body.trim()}
            onClick={send}
            aria-label="Send comment"
            title="Send (Enter)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
      {err && <p className="mt-1.5 text-xs text-cut">{err}</p>}
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
          // Backspace on an empty reason throws the draft away, like Backspace on the timeline.
          if ((e.key === "Backspace" || e.key === "Delete") && reason === "") {
            e.preventDefault();
            p.onCutCancel();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-ink-3">Backspace or Esc to discard</span>
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
