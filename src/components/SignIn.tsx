"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, errorMessage } from "@/lib/client/supabase";

export function SignIn() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session && !data.session.user.is_anonymous) router.replace("/projects");
      });
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const sb = supabase();
    // A guest session in this browser must not leak into the editor account.
    const { data: s } = await sb.auth.getSession();
    if (s.session?.user.is_anonymous) await sb.auth.signOut();
    const res =
      mode === "in"
        ? await sb.auth.signInWithPassword({ email, password })
        : await sb.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    if (res.error) return setMsg(errorMessage(res.error));
    if (mode === "up" && !res.data.session) return setMsg("Check your email to confirm your account, then sign in.");
    router.replace("/projects");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scrub</h1>
          <p className="mt-1 text-ink-2">Frame-accurate review, with cut requests your clients can preview.</p>
        </div>
        <label className="block space-y-1">
          <span className="label">Email</span>
          <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {msg && <p className="text-sm text-accent">{msg}</p>}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="w-full text-sm text-ink-2 hover:text-ink" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "First time? Create your editor account" : "Have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
