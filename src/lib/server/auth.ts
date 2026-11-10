import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * A Supabase client that acts as the caller, so row-level security decides what they can see.
 * The route never uses a service-role key.
 */
export async function asCaller(req: Request): Promise<{ db: SupabaseClient; user: User }> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in first");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Your session has expired. Reload the page.");
  return { db, user: data.user };
}

/** The version, if the caller is allowed to see it, plus their role on its asset. */
export async function loadVersion(db: SupabaseClient, versionId: string) {
  const { data: version } = await db.from("versions").select("*").eq("id", versionId).maybeSingle();
  if (!version) throw new HttpError(404, "Video not found, or you don't have access to it");
  const { data: access } = await db.rpc("my_asset_access", { p_asset: version.asset_id });
  const role = access?.[0] ?? null;
  if (!role) throw new HttpError(403, "You don't have access to this video");
  return { version, access: role as { role: "editor" | "guest"; allow_download: boolean } };
}

export function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request) => {
    try {
      return Response.json(await fn(req));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      return Response.json({ error: "Something went wrong" }, { status: 500 });
    }
  };
}
