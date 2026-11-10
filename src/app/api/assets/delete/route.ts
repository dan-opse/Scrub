import { asCaller, handle, HttpError } from "@/lib/server/auth";
import { deleteVersionObjects } from "../../versions/delete/route";

/** Deletes an asset: every version's stored files, then the rows. Owner only (RLS). */
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { assetId } = await req.json();
  const { data: versions, error } = await db.from("versions").select("id, original_key, review_key, upload_id, review_upload_id").eq("asset_id", assetId);
  if (error) throw new HttpError(500, error.message);
  const { data: owned } = await db.rpc("is_asset_owner", { p_asset: assetId });
  if (!owned) throw new HttpError(403, "Only the editor can delete this");
  for (const v of versions ?? []) await deleteVersionObjects(v);
  const { error: delErr } = await db.from("assets").delete().eq("id", assetId);
  if (delErr) throw new HttpError(500, delErr.message);
  return { ok: true };
});
