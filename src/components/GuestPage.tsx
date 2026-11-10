"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase, errorMessage } from "@/lib/client/supabase";
import { Review } from "./review/Review";
import type { Access } from "@/lib/types";

type Info = { asset_name: string; project_name: string; editor_name: string; active: boolean };

/** A client opens a share link: anonymous sign-in, enter a name, review. No account. */
export function GuestPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabase();
      let { data } = await sb.auth.getSession();
      if (!data.session) {
        const res = await sb.auth.signInAnonymously();
        if (res.error) {
          setError(
            /anonymous/i.test(res.error.message)
              ? "Guest access isn't switched on for this Scrub yet. Ask your editor to enable anonymous sign-ins in Supabase."
              : errorMessage(res.error),
          );
          return;
        }
        data = (await sb.auth.getSession()).data;
      }
      setUserId(data.session!.user.id);
      const { data: rows, error } = await sb.rpc("share_link_info", { p_token: token });
      if (error) return setError(errorMessage(error));
      const i = rows?.[0] as Info | undefined;
      if (!i || !i.active) return setError("This link is no longer active. Ask your editor for a new one.");
      setInfo(i);
    })();
  }, [token]);

  // If this browser already joined this link, skip the name form.
  useEffect(() => {
    if (!info || !userId) return;
    const saved = localStorage.getItem(`scrub:guest:${token}`);
    if (saved) {
      const { name: n, email: e } = JSON.parse(saved);
      join(n, e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, userId]);

  async function join(n = name, e = email) {
    setBusy(true);
    setError(null);
    const sb = supabase();
    const { data: aid, error } = await sb.rpc("redeem_share_link", { p_token: token, p_display_name: n, p_email: e || null });
    if (error) {
      setBusy(false);
      return setError(errorMessage(error));
    }
    const { data: acc } = await sb.rpc("my_asset_access", { p_asset: aid });
    const a = acc?.[0] as Access | undefined;
    if (a?.role === "editor") return router.replace(`/assets/${aid}`);
    localStorage.setItem(`scrub:guest:${token}`, JSON.stringify({ name: n, email: e }));
    setAccess(a ?? null);
    setAssetId(aid as string);
    setBusy(false);
  }

  if (assetId && access && userId) {
    return <Review assetId={assetId} me={{ id: userId, name: access.display_name, role: "guest" }} access={access} />;
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm space-y-4 p-6">
        {error ? (
          <p className="text-cut">{error}</p>
        ) : !info ? (
          <p className="text-ink-3">Opening…</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              join();
            }}
          >
            <div>
              <p className="text-sm text-ink-2">{info.editor_name} shared a video for your review</p>
              <h1 className="mt-1 text-xl font-semibold">{info.asset_name}</h1>
              <p className="text-sm text-ink-3">{info.project_name}</p>
            </div>
            <label className="block space-y-1">
              <span className="label">Your name</span>
              <input className="input" required maxLength={80} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="label">Email (optional, for replies)</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button className="btn btn-primary w-full" disabled={busy || !name.trim()}>
              Start reviewing
            </button>
            <p className="text-xs text-ink-3">No account needed. Your name appears on your comments.</p>
          </form>
        )}
      </div>
    </main>
  );
}
