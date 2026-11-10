import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, s3 } from "@/lib/server/storage";

// Cancels an upload and removes the unfinished version.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId } = await req.json();
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor") throw new HttpError(403, "Only the editor can cancel uploads");
  if (version.status === "ready") throw new HttpError(409, "This version is already uploaded");
  if (version.upload_id) {
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: version.original_key, UploadId: version.upload_id }))
      .catch(() => undefined);
  }
  await db.from("versions").delete().eq("id", version.id);
  return { ok: true };
});
