"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, api, errorMessage } from "@/lib/client/supabase";
import { useEditorSession } from "./useEditorSession";
import type { Project } from "@/lib/types";

export const gb = (b: number) => `${(b / 2 ** 30).toFixed(b >= 10 * 2 ** 30 ? 0 : 1)} GB`;

export function StorageMeter() {
  const [q, setQ] = useState<{ used: number; allowance: number } | null>(null);
  useEffect(() => {
    api<{ used: number; allowance: number }>("/api/storage", {}).then(setQ).catch(() => undefined);
  }, []);
  if (!q) return null;
  const frac = Math.min(1, q.used / q.allowance);
  const tone = frac >= 1 ? "bg-cut" : frac >= 0.8 ? "bg-accent" : "bg-good";
  return (
    <div className="flex items-center gap-2 text-xs text-ink-2" title="Storage used by all your videos and review copies">
      <div className="h-1.5 w-24 overflow-hidden rounded bg-panel-2">
        <div className={`h-full ${tone}`} style={{ width: `${frac * 100}%` }} />
      </div>
      <span>
        {gb(q.used)} of {gb(q.allowance)}
        {frac >= 1 ? " · full" : frac >= 0.8 ? " · nearly full" : ""}
      </span>
    </div>
  );
}

export function TopBar({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const signOut = async (everywhere: boolean) => {
    await supabase().auth.signOut({ scope: everywhere ? "global" : "local" });
    router.replace("/");
  };
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Link href="/projects" className="text-lg font-semibold tracking-tight">
          Scrub
        </Link>
        {children}
      </div>
      <div className="flex items-center gap-4">
        <StorageMeter />
        <div className="relative">
          <button className="btn btn-ghost btn-sm" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            Account ▾
          </button>
          {menu && (
            <div role="menu" className="card absolute right-0 z-20 mt-1 w-52 p-1 text-sm" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2" onClick={() => signOut(false)}>
                Sign out
              </button>
              <button role="menuitem" className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2" onClick={() => signOut(true)}>
                Sign out everywhere
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

type Row = Project & { assets: { count: number }[] };

export function ProjectsPage() {
  const user = useEditorSession();
  const [projects, setProjects] = useState<Row[] | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase()
      .from("projects")
      .select("*, assets(count)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) setError(error.message);
    else setProjects(data ?? []);
  }, []);

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch; state is set after the await
    load().catch(() => undefined);
  }, [user, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const { error } = await supabase().from("projects").insert({ name: name.trim() });
    if (error) return setError(errorMessage(error));
    setName("");
    load();
  }

  async function rename(id: string, newName: string) {
    setRenaming(null);
    if (!newName.trim()) return;
    const { error } = await supabase().from("projects").update({ name: newName.trim() }).eq("id", id);
    if (error) return setError(errorMessage(error));
    load();
  }

  async function remove(p: Row) {
    const n = p.assets?.[0]?.count ?? 0;
    if (!confirm(`Delete "${p.name}"${n ? ` and its ${n} video${n === 1 ? "" : "s"}` : ""}? Guests lose access immediately.`)) return;
    // Delete each asset's files first, then hide the project.
    const { data: assets } = await supabase().from("assets").select("id").eq("project_id", p.id);
    for (const a of assets ?? []) await api("/api/assets/delete", { assetId: a.id }).catch((e) => setError(errorMessage(e)));
    const { error } = await supabase().from("projects").update({ deleted_at: new Date().toISOString() }).eq("id", p.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <form onSubmit={create} className="flex gap-2">
          <input className="input" placeholder="New project name, e.g. Acme brand film" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary shrink-0">New project</button>
        </form>
        {error && <p className="text-cut">{error}</p>}
        {projects === null ? (
          <p className="text-ink-3">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-ink-2">No projects yet. Create one, then upload your first cut.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id} className="card group relative p-4 hover:border-line-2">
                {renaming === p.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename(p.id, new FormData(e.currentTarget).get("name") as string);
                    }}
                  >
                    <input name="name" className="input" defaultValue={p.name} autoFocus onBlur={(e) => rename(p.id, e.target.value)} />
                  </form>
                ) : (
                  <Link href={`/projects/${p.id}`} className="block">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-sm text-ink-3">
                      {p.assets?.[0]?.count ?? 0} video{p.assets?.[0]?.count === 1 ? "" : "s"}
                    </div>
                  </Link>
                )}
                <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                  <button className="btn btn-ghost btn-sm" onClick={() => setRenaming(p.id)} aria-label={`Rename ${p.name}`}>
                    Rename
                  </button>
                  <button className="btn btn-ghost btn-sm text-ink-3 hover:text-cut" onClick={() => remove(p)} aria-label={`Delete ${p.name}`}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
