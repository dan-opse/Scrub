import { CreateMultipartUploadCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, PART_SIZE, originalKey, s3 } from "@/lib/server/storage";

// Starts (or resumes) the multipart upload for a version the caller owns.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId } = await req.json();
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor") throw new HttpError(403, "Only the editor can upload");
  if (version.status !== "uploading") throw new HttpError(409, "This version has already been uploaded");
  if (version.upload_id && version.original_key) {
    return { uploadId: version.upload_id, key: version.original_key, partSize: PART_SIZE, resumed: true };
  }
  const key = originalKey(version.asset_id, version.id, version.original_filename);
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: "video/mp4" }),
  );
  const { error } = await db.from("versions").update({ upload_id: UploadId, original_key: key }).eq("id", version.id);
  if (error) throw new HttpError(500, error.message);
  return { uploadId: UploadId, key, partSize: PART_SIZE, resumed: false };
});
