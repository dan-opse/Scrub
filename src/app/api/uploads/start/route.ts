import { CreateMultipartUploadCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, MAX_FILE_BYTES, PART_SIZE, STORAGE_ALLOWANCE_BYTES, cols, originalKey, reviewKey, s3, type UploadKind } from "@/lib/server/storage";

// Starts (or resumes) the multipart upload of a version's original file or review copy.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, kind = "original", bytes } = (await req.json()) as { versionId: string; kind?: UploadKind; bytes?: number };
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor") throw new HttpError(403, "Only the editor can upload");
  const c = cols(kind);
  const existingKey = version[c.key] as string | null;
  const existingUpload = version[c.uploadId] as string | null;

  if (kind === "original") {
    if (version.status !== "uploading") throw new HttpError(409, "This version has already been uploaded");
    if (Number(version.original_bytes) > MAX_FILE_BYTES) throw new HttpError(413, "Files are limited to 50 GB");
  } else {
    if (version.status !== "ready") throw new HttpError(409, "Upload the original first");
    if (version.review_status === "ready") throw new HttpError(409, "This version already has a review copy");
  }
  if (existingUpload && existingKey) return { uploadId: existingUpload, key: existingKey, partSize: PART_SIZE, resumed: true };

  // Storage allowance: everything already stored plus this file.
  const { data: used } = await db.rpc("my_storage_bytes");
  const incoming = kind === "original" ? Number(version.original_bytes) : Number(bytes ?? 0);
  const already = kind === "original" ? Number(version.original_bytes) : 0; // originals are counted from their row even while uploading
  if (Number(used ?? 0) - already + incoming > STORAGE_ALLOWANCE_BYTES) {
    throw new HttpError(507, `Not enough storage: this would exceed your ${Math.round(STORAGE_ALLOWANCE_BYTES / 2 ** 30)} GB allowance. Delete old versions first.`);
  }

  const key = kind === "original" ? originalKey(version.asset_id, version.id, version.original_filename) : reviewKey(version.asset_id, version.id);
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: "video/mp4" }));
  const patch: Record<string, unknown> = { [c.uploadId]: UploadId, [c.key]: key };
  if (kind === "review") patch.review_status = "pending";
  const { error } = await db.from("versions").update(patch).eq("id", version.id);
  if (error) throw new HttpError(500, error.message);
  return { uploadId: UploadId, key, partSize: PART_SIZE, resumed: false };
});
