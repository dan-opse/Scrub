import { AbortMultipartUploadCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, s3 } from "@/lib/server/storage";

/** Removes a version's stored files, then its row (comments and approvals cascade). Owner only. */
export async function deleteVersionObjects(v: { original_key: string | null; review_key: string | null; upload_id: string | null; review_upload_id: string | null }) {
  for (const [key, uploadId] of [[v.original_key, v.upload_id], [v.review_key, v.review_upload_id]] as const) {
    if (key && uploadId) await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId })).catch(() => undefined);
  }
  const keys = [v.original_key, v.review_key].filter((k): k is string => !!k);
  if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } })).catch(() => undefined);
}

export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId } = await req.json();
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor") throw new HttpError(403, "Only the editor can delete versions");
  await deleteVersionObjects(version);
  const { error } = await db.from("versions").delete().eq("id", version.id);
  if (error) throw new HttpError(500, error.message);
  return { ok: true };
});
