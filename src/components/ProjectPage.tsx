"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase, errorMessage } from "@/lib/client/supabase";
import { useEditorSession } from "./useEditorSession";
import { TopBar } from "./ProjectsPage";
import { UploadPanel } from "./UploadPanel";
import type { Project } from "@/lib/types";

type AssetRow = {
  id: string;
  name: string;
  created_at: string;
  versions: { id: string; number: number; status: string; created_at: string }[];
};

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const user = useEditorSession();
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, { notes: number; cuts: number }>>({});
  const [uploading, setUploading] = useState(false);
  const [editingTc, setEditingTc] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [{ data: p, error: pe }, { data: a, error: ae }] = await Promise.all([
      sb.from("projects").select("*").eq("id", id).single(),
      sb
        .from("assets")
        .select("id, name, created_at, versions(id, number, status, created_at)")
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    ]);
    if (pe || ae) return setError(errorMessage(pe ?? ae));
    setProject(p);
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
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch; state is set after the await
    if (user) load();
  }, [user, load]);

  async function saveTc(tc: string) {
    const { error } = await supabase().from("projects").update({ default_start_tc: tc }).eq("id", id);
    if (error) return setError("Use HH:MM:SS:FF, for example 01:00:00:00");
    setProject((p) => (p ? { ...p, default_start_tc: tc } : p));
    setEditingTc(false);
  }

  return (
    <>
      <TopBar>
        <span className="text-ink-3">/</span>
        <span>{project?.name}</span>
      </TopBar>
      <main className="mx-auto w-full max-w-4xl space-y-5 p-6">
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
            <button className="btn btn-primary" onClick={() => setUploading(true)}>
              Upload video
            </button>
          )}
        </div>
        {error && <p className="text-cut">{error}</p>}
        {uploading && project && (
          <UploadPanel
            projectId={project.id}
            defaultStartTc={project.default_start_tc}
            onDone={(assetId) => router.push(`/assets/${assetId}`)}
            onCancel={() => {
              setUploading(false);
              load();
            }}
          />
        )}
        {assets === null ? (
          <p className="text-ink-3">Loading…</p>
        ) : assets.length === 0 && !uploading ? (
          <p className="text-ink-2">No videos yet. Upload an H.264 or H.265 export to start a review.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {assets.map((a) => {
              const latest = [...a.versions].sort((m, n) => n.number - m.number)[0];
              const c = latest ? counts[latest.id] : undefined;
              return (
                <li key={a.id}>
                  <Link href={`/assets/${a.id}`} className="flex items-center justify-between gap-4 p-4 hover:bg-panel">
                    <div>
                      <div className="font-medium">{a.name}</div>
                      <div className="text-sm text-ink-3">
                        {latest ? `v${latest.number}` : "no versions"}
                        {latest?.status === "uploading" && " · upload unfinished"}
                      </div>
                    </div>
                    {c && (
                      <div className="flex gap-3 text-sm">
                        {c.notes > 0 && <span className="text-note">{c.notes} open comment{c.notes === 1 ? "" : "s"}</span>}
                        {c.cuts > 0 && <span className="text-cut">{c.cuts} cut request{c.cuts === 1 ? "" : "s"}</span>}
                      </div>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
