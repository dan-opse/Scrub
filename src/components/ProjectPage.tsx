"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase, api, errorMessage } from "@/lib/client/supabase";
import { useEditorSession } from "./useEditorSession";
import { TopBar } from "./ProjectsPage";
import { UploadPanel } from "./UploadPanel";
import type { Project } from "@/lib/types";

type AssetRow = {
  id: string;
  name: string;
  created_at: string;
  versions: { id: string; number: number; status: string; review_status: string; original_bytes: number; review_bytes: number | null; created_at: string }[];
};

const mb = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${Math.round(b / 2 ** 20)} MB`);

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const user = useEditorSession();
  const [project, setProject] = useState<Project | null>(null);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, { notes: number; cuts: number }>>({});
  const [approvals, setApprovals] = useState<Record<string, { decision: string; author_name: string }>>({});
  const [uploading, setUploading] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [editingTc, setEditingTc] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [{ data: p, error: pe }, { data: a, error: ae }, { data: all }] = await Promise.all([
      sb.from("projects").select("*").eq("id", id).single(),
      sb
        .from("assets")
        .select("id, name, created_at, versions(id, number, status, review_status, original_bytes, review_bytes, created_at)")
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      sb.from("projects").select("*").is("deleted_at", null).order("name"),
    ]);
    if (pe || ae) return setError(errorMessage(pe ?? ae));
    setProject(p);
    setAllProjects((all ?? []) as Project[]);
    setAssets(a as AssetRow[]);
    const latest = (a as AssetRow[]).map((x) => [...x.versions].sort((m, n) => n.number - m.number)[0]?.id).filter(Boolean);
    if (latest.length) {
      const { data: cs } = await sb
        .from("comments")
        .select("version_id, kind, status")
        .in("version_id", latest)
        .is("parent_id", null)
        .is("deleted_at", null)
        .in("status", ["open", "accepted"]);
      const byVersion: Record<string, { notes: number; cuts: number }> = {};
      for (const c of cs ?? []) {
        const k = (byVersion[c.version_id] ??= { notes: 0, cuts: 0 });
        if (c.kind === "cut") k.cuts++;
        else k.notes++;
      }
      setCounts(byVersion);
      const { data: aps } = await sb.from("approvals").select("version_id, decision, author_name, created_at").in("version_id", latest).order("created_at", { ascending: false });
      const latestByVersion: Record<string, { decision: string; author_name: string }> = {};
      for (const ap of aps ?? []) if (!latestByVersion[ap.version_id]) latestByVersion[ap.version_id] = ap;
      setApprovals(latestByVersion);
    }
  }, [id]);

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch; state is set after the await
    load().catch(() => undefined);
  }, [user, load]);

  async function saveTc(tc: string) {
    const { error } = await supabase().from("projects").update({ default_start_tc: tc }).eq("id", id);
    if (error) return setError("Use HH:MM:SS:FF, for example 01:00:00:00");
    setProject((p) => (p ? { ...p, default_start_tc: tc } : p));
    setEditingTc(false);
  }

  async function renameAsset(assetId: string, name: string) {
    setRenaming(null);
    if (!name.trim()) return;
    const { error } = await supabase().from("assets").update({ name: name.trim() }).eq("id", assetId);
    if (error) return setError(errorMessage(error));
    load();
  }

  async function moveAsset(assetId: string, projectId: string) {
    if (projectId === id) return;
    const { error } = await supabase().from("assets").update({ project_id: projectId }).eq("id", assetId);
    if (error) return setError(errorMessage(error));
    load();
  }

  async function deleteAsset(a: AssetRow) {
    if (!confirm(`Delete "${a.name}" and all ${a.versions.length} version${a.versions.length === 1 ? "" : "s"}? Share links stop working immediately.`)) return;
    try {
      await api("/api/assets/delete", { assetId: a.id });
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function deleteVersion(a: AssetRow, v: AssetRow["versions"][number]) {
    if (!confirm(`Delete v${v.number} of "${a.name}" and its comments?`)) return;
    try {
      await api("/api/versions/delete", { versionId: v.id });
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function startUpload(f?: File) {
    setDroppedFile(f);
    setUploading(true);
  }

  // The whole page takes a dropped video while no upload is open; the drop zone lights up as feedback.
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const dropHandlers = uploading
    ? {}
    : {
        onDragEnter: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          dragDepth.current++;
          setDragging(true);
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDragOver: (e: React.DragEvent) => {
          if (hasFiles(e)) e.preventDefault();
        },
        onDrop: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) startUpload(f);
        },
      };

  return (
    <>
      <TopBar>
        <span className="text-ink-3">/</span>
        <span className="truncate">{project?.name}</span>
      </TopBar>
      <main className="mx-auto min-h-[calc(100vh-4rem)] w-full max-w-4xl space-y-5 p-6" {...dropHandlers}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink-2">
            Default start timecode:{" "}
            {editingTc ? (
              <form
                className="inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveTc(new FormData(e.currentTarget).get("tc") as string);
                }}
              >
                <input name="tc" className="input inline w-32 font-mono" defaultValue={project?.default_start_tc} autoFocus />
              </form>
            ) : (
              <button className="font-mono text-ink underline-offset-2 hover:underline" onClick={() => setEditingTc(true)}>
                {project?.default_start_tc}
              </button>
            )}
          </div>
          {!uploading && (
            <button className="btn btn-primary" onClick={() => startUpload()}>
              Upload video
            </button>
          )}
        </div>
        {error && <p className="text-cut">{error}</p>}
        {uploading && project && (
          <UploadPanel
            projectId={project.id}
            defaultStartTc={project.default_start_tc}
            initialFile={droppedFile}
            onDone={(assetId) => router.push(`/assets/${assetId}`)}
            onCancel={() => {
              setUploading(false);
              setDroppedFile(undefined);
              load();
            }}
          />
        )}
        {!uploading && assets !== null && (
          <DropZone large={assets.length === 0} active={dragging} onFile={startUpload} />
        )}
        {assets === null ? (
          <p className="text-ink-3">Loading…</p>
        ) : assets.length === 0 ? null : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {assets.map((a) => {
              const versions = [...a.versions].sort((m, n) => n.number - m.number);
              const latest = versions[0];
              const c = latest ? counts[latest.id] : undefined;
              const open = expanded === a.id;
              return (
                <li key={a.id} className="group">
                  <div className="flex items-center gap-3 p-4 hover:bg-panel">
                    <div className="min-w-0 flex-1">
                      {renaming === a.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            renameAsset(a.id, new FormData(e.currentTarget).get("name") as string);
                          }}
                        >
                          <input name="name" className="input" defaultValue={a.name} autoFocus onBlur={(e) => renameAsset(a.id, e.target.value)} />
                        </form>
                      ) : (
                        <Link href={`/assets/${a.id}`} className="block">
                          <div className="truncate font-medium">{a.name}</div>
                          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
                            <span>
                              {latest ? `v${latest.number}` : "no versions"}
                              {latest?.status === "uploading" && " · upload unfinished"}
                              {latest?.review_status === "pending" && " · review copy pending"}
                            </span>
                            {latest && approvals[latest.id] && (
                              <span className={`rounded px-1.5 text-xs ${approvals[latest.id].decision === "approved" ? "bg-good/20 text-good" : "bg-accent/20 text-accent"}`}>
                                {approvals[latest.id].decision === "approved" ? "Approved" : "Changes requested"} · {approvals[latest.id].author_name}
                              </span>
                            )}
                            {c && c.notes > 0 && <span className="text-note">{c.notes} open comment{c.notes === 1 ? "" : "s"}</span>}
                            {c && c.cuts > 0 && <span className="text-cut">{c.cuts} cut request{c.cuts === 1 ? "" : "s"}</span>}
                          </div>
                        </Link>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <button className="btn btn-ghost btn-sm" onClick={() => setRenaming(a.id)}>
                        Rename
                      </button>
                      {allProjects.length > 1 && (
                        <select
                          className="input w-auto py-1 text-xs"
                          value={id}
                          onChange={(e) => moveAsset(a.id, e.target.value)}
                          aria-label={`Move ${a.name} to project`}
                          title="Move to another project"
                        >
                          {allProjects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id === id ? "Move to…" : p.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(open ? null : a.id)} aria-expanded={open}>
                        {versions.length} version{versions.length === 1 ? "" : "s"} {open ? "▾" : "▸"}
                      </button>
                      <button className="btn btn-ghost btn-sm text-ink-3 hover:text-cut" onClick={() => deleteAsset(a)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {open && (
                    <ul className="space-y-1 border-t border-line bg-bg px-4 py-2 text-sm">
                      {versions.map((v) => (
                        <li key={v.id} className="flex items-center gap-3">
                          <span className="font-mono text-ink-2">v{v.number}</span>
                          <span className="text-ink-3">
                            {new Date(v.created_at).toLocaleDateString()} · {mb(Number(v.original_bytes) + Number(v.review_bytes ?? 0))}
                            {v.status !== "ready" && ` · ${v.status}`}
                            {v.review_status === "ready" && " · has review copy"}
                          </span>
                          <button className="btn btn-ghost btn-sm ml-auto text-ink-3 hover:text-cut" onClick={() => deleteVersion(a, v)}>
                            Delete v{v.number}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}

/** Click to browse or drop a video. Large and centred on an empty project, a slim strip above the list otherwise. */
function DropZone({ large, active, onFile }: { large: boolean; active: boolean; onFile: (f: File) => void }) {
  return (
    <label
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition-colors ${
        large ? "min-h-[50vh] p-10" : "p-6"
      } ${active ? "border-accent bg-accent/10" : "border-line-2 hover:border-ink-3 hover:bg-panel"}`}
    >
      <input
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className={`${large ? "h-10 w-10" : "h-6 w-6"} ${active ? "text-accent" : "text-ink-3"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 16V4m0 0-4 4m4-4 4 4" />
        <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <span className={large ? "text-base font-medium" : "font-medium"}>
        {active ? "Drop to upload" : large ? "Drag and drop a video here" : "Drop a video here to add it"}
      </span>
      <span className="text-ink-2">
        or <span className="text-accent underline-offset-2 hover:underline">browse files</span> · H.264 or H.265, MP4 or MOV, up to 50 GB
      </span>
    </label>
  );
}
