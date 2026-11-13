"use client";
import { useEffect, useRef, useState } from "react";
import type { Comment } from "@/lib/types";
import type { Range } from "@/lib/ranges";
import { ago, avatarColor, initials } from "./avatar";

export type Tab = "all" | "notes" | "cuts";

type Props = {
  tab: Tab;
  setTab: (t: Tab) => void;
  earlier?: React.ReactNode;
  items: Comment[]; // top-level, sorted
  replies: Map<string, Comment[]>;
  numbers: Map<string, number>;
  me: { id: string; role: "editor" | "guest" };
  canComment: boolean;
  selectedId: string | null;
  format: (f: number) => string;
  duration: (frames: number) => string;
  runtime: (frames: number) => string;
  /** Runtime if every open and accepted cut request is made. */
  totals: { removed: number; before: number; after: number };
  onSelect: (c: Comment) => void;
  onPlayContext: (r: Range, asCut: boolean) => void;
  onStatus: (c: Comment, status: Comment["status"], reply?: string) => Promise<void>;
  onReply: (parent: Comment, body: string) => Promise<void>;
  onEdit: (c: Comment, body: string) => Promise<void>;
  onDelete: (c: Comment) => Promise<void>;
};

const STATUS: Record<Comment["status"], { label: string; cls: string }> = {
  open: { label: "Requested", cls: "bg-cut/15 text-cut" },
  accepted: { label: "Accepted", cls: "bg-accent/15 text-accent" },
  rejected: { label: "Rejected", cls: "border border-line-2 text-ink-3" },
  done: { label: "Cut made", cls: "bg-good/15 text-good" },
  withdrawn: { label: "Withdrawn", cls: "text-ink-3" },
};

export function Sidebar(p: Props) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const cuts = p.items.filter((c) => c.kind === "cut");
  const q = query.trim().toLowerCase();
  const matches = (c: Comment) =>
    !q ||
    c.body.toLowerCase().includes(q) ||
    c.author_name.toLowerCase().includes(q) ||
    (p.replies.get(c.id) ?? []).some((r) => r.body.toLowerCase().includes(q));
  const shown = p.items.filter((c) => (p.tab === "all" ? true : p.tab === "cuts" ? c.kind === "cut" : c.kind === "note")).filter(matches);
  const openCuts = cuts.filter((c) => c.status === "open" || c.status === "accepted").length;

  const tabBtn = (t: Tab, label: string, n: number) => (
    <button
      role="tab"
      aria-selected={p.tab === t}
      onClick={() => p.setTab(t)}
      className={`flex-1 rounded-md px-2 py-1.5 text-sm transition-colors ${p.tab === t ? "bg-panel-2 text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
    >
      {label} <span className="text-ink-3">{n}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 p-3 pb-2">
        <div className="flex items-center gap-2">
          <div role="tablist" className="flex flex-1 gap-0.5 rounded-lg bg-bg p-0.5">
            {tabBtn("all", "All", p.items.length)}
            {tabBtn("notes", "Comments", p.items.length - cuts.length)}
            {tabBtn("cuts", "Cuts", cuts.filter((c) => c.status !== "withdrawn").length)}
          </div>
          <button
            className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-panel-2 ${searching ? "bg-panel-2 text-ink" : "text-ink-2"}`}
            onClick={() => {
              setSearching((v) => !v);
              setQuery("");
            }}
            aria-label="Search comments"
            title="Search comments"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
        </div>
        {searching && (
          <input
            className="input py-1.5 text-sm"
            placeholder="Search comments and names…"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setSearching(false);
              }
            }}
          />
        )}
        {p.tab === "cuts" && openCuts > 0 && (
          <div className="flex items-baseline justify-between gap-2 rounded-md bg-cut/5 px-2.5 py-1.5 text-xs">
            <span className="text-ink-2">
              {openCuts} active · <span className="font-medium text-cut">−{p.duration(p.totals.removed)}</span>
            </span>
            <span className="font-mono text-ink-2" title="Runtime if every requested and accepted cut is made">
              {p.runtime(p.totals.before)} → {p.runtime(p.totals.after)}
            </span>
          </div>
        )}
      </div>

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {p.tab !== "notes" && p.earlier && !q && <li className="list-none">{p.earlier}</li>}
        {shown.length === 0 && (
          <li className="p-4 text-center text-sm text-ink-3">
            {q
              ? "Nothing matches your search."
              : p.tab === "cuts"
                ? "No cut requests. Drag across the red lane above the timeline to mark a section to remove."
                : "No comments yet. Pause anywhere and type below."}
          </li>
        )}
        {shown.map((c) => (
          <Card key={c.id} c={c} {...p} n={p.numbers.get(c.id)} replies={p.replies.get(c.id) ?? []} />
        ))}
      </ul>
    </div>
  );
}

function Avatar({ name, id, size = 32 }: { name: string; id: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36, background: avatarColor(id) }}
    >
      {initials(name)}
    </span>
  );
}

function Card(props: Omit<Props, "replies" | "items" | "numbers"> & { c: Comment; n?: number; replies: Comment[] }) {
  const { c, me, format, duration } = props;
  const [mode, setMode] = useState<"reply" | "reject" | "edit" | null>(null);
  const [menu, setMenu] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isCut = c.kind === "cut";
  const mine = c.author_id === me.id;
  const editor = me.role === "editor";
  const sel = props.selectedId === c.id;
  const withdrawn = c.status === "withdrawn";
  const deleted = !!c.deleted_at;
  const done = c.status === "done";

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    setMenu(false);
    try {
      await fn();
      setText("");
      setMode(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const range = isCut ? { start: c.start_frame!, end: c.end_frame! } : null;

  // Everything that isn't a primary action lives in the ⋯ menu.
  const menuItems: { label: string; onClick: () => void; danger?: boolean }[] = [];
  if (range && !withdrawn) menuItems.push({ label: "▶ Play in context", onClick: () => (setMenu(false), props.onPlayContext(range, false)) });
  if (mine && (!isCut || c.status === "open") && !deleted) menuItems.push({ label: "Edit", onClick: () => (setText(c.body), setMode("edit"), setMenu(false)) });
  if (editor && isCut && c.status === "accepted") menuItems.push({ label: "Undo accept", onClick: () => run(() => props.onStatus(c, "open")) });
  if (editor && isCut && (c.status === "rejected" || done)) menuItems.push({ label: "Reopen", onClick: () => run(() => props.onStatus(c, "open")) });
  if (mine && isCut && c.status === "open")
    menuItems.push({ label: "Withdraw request", onClick: () => confirm("Withdraw this cut request?") && run(() => props.onStatus(c, "withdrawn")) });
  if (((mine && !isCut) || (editor && !mine)) && !deleted)
    menuItems.push({ label: "Delete", danger: true, onClick: () => confirm("Delete this comment?") && run(() => props.onDelete(c)) });

  // The ✓: editor marks a comment done, or an accepted cut as made. Clients just see it filled once done.
  const canCheck = editor && !deleted && (isCut ? c.status === "accepted" || done : true);
  const showCheck = canCheck || done;

  return (
    <li
      id={`c-${c.id}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, textarea, input, select, a, [role=menu]")) return;
        props.onSelect(c);
      }}
      className={`group cursor-pointer rounded-xl border p-3 transition-colors ${
        sel ? "border-accent/60 bg-panel-2" : "border-transparent bg-panel hover:bg-panel-2"
      } ${withdrawn || deleted ? "opacity-50" : ""}`}
    >
      <div className="flex gap-2.5">
        <Avatar name={c.author_name} id={c.author_id ?? c.author_name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-medium">{c.author_name}</span>
            {c.author_role === "editor" && me.role === "guest" && <span className="text-[11px] text-accent">Editor</span>}
            <span className="shrink-0 text-xs text-ink-3" title={new Date(c.created_at).toLocaleString()}>
              {c.pending ? "sending…" : ago(c.created_at)}
            </span>
            {props.n !== undefined && <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-3">#{props.n}</span>}
          </div>

          {mode === "edit" ? (
            <textarea className="input mt-1.5" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {c.start_frame !== null && (
                <span
                  className={`mr-1.5 inline-block rounded px-1.5 py-px align-baseline font-mono text-[12px] ${
                    isCut ? "bg-cut/15 text-cut" : "bg-accent/15 text-accent"
                  }`}
                >
                  {isCut && "✂ "}
                  {format(c.start_frame)}
                  {c.end_frame !== null && <> – {format(c.end_frame)}</>}
                </span>
              )}
              {deleted ? (
                <em className="text-ink-3">Comment deleted</em>
              ) : (
                c.body || (isCut ? <span className="text-ink-3">Cut this section</span> : null)
              )}
            </p>
          )}

          {isCut && !deleted && (
            <div className="mt-1.5 flex items-center gap-2 text-xs">
              <span className={`rounded px-1.5 py-0.5 ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
              <span className="font-mono text-ink-3">−{duration(c.end_frame! - c.start_frame!)}</span>
            </div>
          )}

          {props.replies.length > 0 && (
            <ul className="mt-2.5 space-y-2 border-l border-line-2 pl-3">
              {props.replies.map((r) => (
                <li key={r.id} className="flex gap-2">
                  <Avatar name={r.author_name} id={r.author_id ?? r.author_name} size={22} />
                  <div className="min-w-0 text-sm">
                    <span className="font-medium">{r.author_name}</span> <span className="text-xs text-ink-3">{ago(r.created_at)}</span>
                    <p className="whitespace-pre-wrap break-words">{r.deleted_at ? <em className="text-ink-3">deleted</em> : r.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {(mode === "reply" || mode === "reject") && (
            <div className="mt-2 space-y-1.5">
              <textarea
                className="input text-sm"
                rows={2}
                autoFocus
                placeholder={mode === "reject" ? "Why not? The client will see this." : "Reply…"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMode(null);
                  if (e.key === "Enter" && !e.shiftKey && text.trim()) {
                    e.preventDefault();
                    run(() => (mode === "reject" ? props.onStatus(c, "rejected", text) : props.onReply(c, text)));
                  }
                }}
              />
              <div className="flex justify-end gap-1.5">
                <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || !text.trim()}
                  onClick={() => run(() => (mode === "reject" ? props.onStatus(c, "rejected", text) : props.onReply(c, text)))}
                >
                  {mode === "reject" ? "Reject with reply" : "Reply"}
                </button>
              </div>
            </div>
          )}

          {mode === "edit" && (
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => props.onEdit(c, text))}>
                Save
              </button>
            </div>
          )}

          {!mode && !deleted && (
            <div className="mt-2 flex min-h-7 items-center gap-1">
              {props.canComment && !withdrawn && (
                <button className="-ml-1 rounded px-1 py-0.5 text-sm font-medium text-ink-2 hover:text-ink" onClick={() => setMode("reply")}>
                  Reply
                </button>
              )}
              <div className="ml-auto flex items-center gap-1">
                {range && !withdrawn && (
                  <button
                    className="rounded px-1.5 py-0.5 text-xs text-ink-2 hover:bg-bg hover:text-ink"
                    onClick={() => props.onPlayContext(range, true)}
                    title="Play this part with the cut made"
                  >
                    ▶ As cut
                  </button>
                )}
                {editor && isCut && c.status === "open" && (
                  <>
                    <button className="btn btn-sm px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => props.onStatus(c, "accepted"))}>
                      Accept
                    </button>
                    <button className="btn btn-ghost btn-sm px-2 py-0.5 text-xs" onClick={() => setMode("reject")}>
                      Reject
                    </button>
                  </>
                )}
                {menuItems.length > 0 && (
                  <div ref={menuRef} className="relative">
                    <button
                      className={`flex h-7 w-7 items-center justify-center rounded-full text-ink-2 hover:bg-bg hover:text-ink focus:opacity-100 ${
                        menu ? "bg-bg opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`}
                      onClick={() => setMenu((m) => !m)}
                      aria-label="More actions"
                      aria-expanded={menu}
                    >
                      ⋯
                    </button>
                    {menu && (
                      <div role="menu" className="absolute right-0 top-8 z-40 min-w-40 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-xl">
                        {menuItems.map((m) => (
                          <button
                            key={m.label}
                            role="menuitem"
                            className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-panel-2 ${m.danger ? "text-cut" : ""}`}
                            onClick={m.onClick}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {showCheck && (
                  <button
                    className={`flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${
                      done ? "border-good bg-good text-white" : "border-line-2 text-ink-3 hover:border-good hover:text-good"
                    } ${canCheck ? "" : "cursor-default"}`}
                    disabled={!canCheck || busy}
                    onClick={() => run(() => props.onStatus(c, done ? (isCut ? "accepted" : "open") : "done"))}
                    aria-label={done ? "Mark not done" : isCut ? "Mark cut as made" : "Mark done"}
                    title={done ? (isCut ? "Cut made" : "Done") : isCut ? "Mark cut as made" : "Mark done"}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
          {err && <p className="mt-1 text-xs text-cut">{err}</p>}
        </div>
      </div>
    </li>
  );
}
