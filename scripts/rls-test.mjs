// Permission tests against the real database, acting as different personas through the public API.
// Usage: node --env-file=.env.local scripts/rls-test.mjs <share-token>
// Creates throwaway anonymous users; needs anonymous sign-ins enabled.
import { createClient } from "@supabase/supabase-js";

const token = process.argv[2];
if (!token) throw new Error("pass a share-link token");
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const client = () => createClient(URL_, KEY, { auth: { persistSession: false } });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
};

// Persona: signed in, but never joined any link.
const stranger = client();
await stranger.auth.signInAnonymously();
for (const t of ["projects", "assets", "versions", "comments", "share_links", "share_link_grants"]) {
  const { data } = await stranger.from(t).select("*").limit(5);
  check(`stranger sees no ${t}`, (data ?? []).length === 0, JSON.stringify(data).slice(0, 80));
}
const { error: projErr } = await stranger.from("projects").insert({ name: "hack" });
check("anonymous user cannot create projects", !!projErr);

// Persona: guest who joined the link.
const guest = client();
await guest.auth.signInAnonymously();
const { data: assetId, error: redeemErr } = await guest.rpc("redeem_share_link", { p_token: token, p_display_name: "RLS Tester" });
check("guest can redeem the link", !redeemErr, redeemErr?.message);
const { data: versions } = await guest.from("versions").select("id, status, frame_count").eq("asset_id", assetId);
check("guest sees ready versions", (versions ?? []).length > 0);
const v = versions?.[0];
const { data: comments } = await guest.from("comments").select("*").eq("version_id", v.id);
check("guest reads comments", (comments ?? []).length > 0);
const others = (comments ?? []).filter((c) => c.kind === "cut" && c.author_role === "editor");

const { error: statusErr } = await guest.rpc("set_comment_status", { p_comment: others[0].id, p_status: "accepted" });
const { data: st } = await guest.from("comments").select("status").eq("id", others[0].id).single();
check("guest cannot accept a cut request", !!statusErr && st.status === "open", `error=${statusErr?.message} status=${st.status}`);
const { error: editErr } = await guest.from("comments").update({ body: "pwned" }).eq("id", others[0].id).select();
const { data: after } = await guest.from("comments").select("body").eq("id", others[0].id).single();
check("guest cannot edit someone else's comment", after.body !== "pwned", editErr?.message);

const { error: fakeAuthor } = await guest
  .from("comments")
  .insert({ version_id: v.id, kind: "note", body: "spoof", author_name: "Editor", author_role: "editor" })
  .select("author_role, author_name")
  .single()
  .then(async (r) => {
    if (r.data) check("author role/name cannot be forged", r.data.author_role === "guest" && r.data.author_name === "RLS Tester", JSON.stringify(r.data));
    return r;
  });
check("guest can comment", !fakeAuthor, fakeAuthor?.message);

const { error: wholeCut } = await guest.from("comments").insert({ version_id: v.id, kind: "cut", start_frame: 0, end_frame: v.frame_count });
check("cut request cannot remove the whole video", !!wholeCut);
const { error: pastEnd } = await guest.from("comments").insert({ version_id: v.id, kind: "cut", start_frame: 10, end_frame: v.frame_count + 5 });
check("cut request cannot run past the end", !!pastEnd);
const { error: backwards } = await guest.from("comments").insert({ version_id: v.id, kind: "cut", start_frame: 50, end_frame: 40 });
check("cut request end must be after start", !!backwards);

const { data: links } = await guest.from("share_links").select("token");
check("guest cannot read share-link tokens", (links ?? []).length === 0);
const { error: linkErr } = await guest.rpc("create_share_link", { p_asset: assetId });
check("guest cannot create share links", !!linkErr);
const { error: verErr } = await guest.from("versions").insert({ asset_id: assetId, original_filename: "x.mp4", original_bytes: 1, fps_num: 24, fps_den: 1, frame_count: 10 });
check("guest cannot add versions", !!verErr);

// Approvals: guest with the right can approve; the right can be removed per link; strangers never can.
const { data: access } = await guest.rpc("my_asset_access", { p_asset: assetId });
check("my_asset_access reports approval right", access?.[0]?.allow_approval === true, JSON.stringify(access));
const { error: apErr, data: apRow } = await guest.from("approvals").insert({ version_id: v.id, decision: "changes_requested", note: "rls test", author_name: "Editor", author_role: "editor" }).select("author_role, author_name").single();
check("guest can request changes", !apErr, apErr?.message);
check("approval author cannot be forged", apRow?.author_role === "guest" && apRow?.author_name === "RLS Tester", JSON.stringify(apRow));
const { error: strangerAp } = await stranger.from("approvals").insert({ version_id: v.id, decision: "approved" });
check("stranger cannot approve", !!strangerAp);
const { data: strangerAps } = await stranger.from("approvals").select("*").eq("version_id", v.id);
check("stranger cannot read approvals", (strangerAps ?? []).length === 0);
const { error: evErr } = await guest.from("events").insert({ kind: "rls_test", version_id: v.id, data: {} });
check("guest can log an event", !evErr, evErr?.message);
const { data: evRows } = await guest.from("events").select("*");
check("guest cannot read events", (evRows ?? []).length === 0);
const { error: resolveErr } = await guest.rpc("resolve_cut_requests", { p_version: v.id, p_done: [others[0].id], p_rejected: [] });
check("guest cannot resolve cut requests across versions", !!resolveErr);
const { data: storageBytes, error: stErr } = await guest.rpc("my_storage_bytes");
check("guest storage usage is zero", !stErr && Number(storageBytes) === 0, `${stErr?.message} ${storageBytes}`);

// Playback signing through our API as the stranger must fail.
const { data: s } = await stranger.auth.getSession();
const res = await fetch("http://localhost:3000/api/playback", {
  method: "POST",
  headers: { Authorization: `Bearer ${s.session.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ versionId: v.id }),
});
check("stranger cannot get a playback URL", res.status === 404 || res.status === 403, String(res.status));
const { data: gs } = await guest.auth.getSession();
const res2 = await fetch("http://localhost:3000/api/uploads/start", {
  method: "POST",
  headers: { Authorization: `Bearer ${gs.session.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ versionId: v.id }),
});
check("guest cannot start uploads", res2.status === 403 || res2.status === 409, String(res2.status));

console.log(failures ? `\n${failures} FAILED` : "\nall permission checks passed");
process.exit(failures ? 1 : 0);
