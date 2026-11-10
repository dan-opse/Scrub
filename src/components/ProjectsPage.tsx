"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, errorMessage } from "@/lib/client/supabase";
import { useEditorSession } from "./useEditorSession";
import type { Project } from "@/lib/types";

export function TopBar({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  return (
    <header className="flex items-center justify-between border-b border-line px-5 py-3">
      <div className="flex items-center gap-3">
        <Link href="/projects" className="text-lg font-semibold tracking-tight">
          Scrub
        </Link>
        {children}
      </div>
      <button
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          await supabase().auth.signOut();
          router.replace("/");
        }}
      >
        Sign out
      </button>
    </header>
  );
}

export function ProjectsPage() {
  const user = useEditorSession();
  const [projects, setProjects] = useState<(Project & { assets: { count: number }[] })[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase()
      .from("projects")
      .select("*, assets(count)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => (error ? setError(error.message) : setProjects(data ?? [])));
  }, [user]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const { data, error } = await supabase().from("projects").insert({ name: name.trim() }).select("*, assets(count)").single();
    if (error) return setError(errorMessage(error));
    setProjects((p) => [data, ...(p ?? [])]);
    setName("");
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
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="card block p-4 hover:border-line-2">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-sm text-ink-3">
                    {p.assets?.[0]?.count ?? 0} video{p.assets?.[0]?.count === 1 ? "" : "s"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
