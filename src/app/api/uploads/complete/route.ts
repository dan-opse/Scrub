import { CompleteMultipartUploadCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, cols, s3, type UploadKind } from "@/lib/server/storage";

// Finishes an upload, checks the stored size, and marks the version (or its review copy) ready.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, kind = "original", parts, bytes, firstPts } = (await req.json()) as {
    versionId: string;
    kind?: UploadKind;
    parts: { partNumber: number; etag: string }[];
    bytes?: number;
    firstPts?: number;
  };
  const { version, access } = await loadVersion(db, versionId);
  const c = cols(kind);
  const uploadId = version[c.uploadId] as string | null;
  const key = version[c.key] as string | null;
  if (access.role !== "editor" || !uploadId || !key) throw new HttpError(403, "No active upload");
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const stored = Number(head.ContentLength);
  if (kind === "original") {
    if (stored !== Number(version.original_bytes)) {
      await db.from("versions").update({ status: "failed" }).eq("id", version.id);
      throw new HttpError(422, "The stored file size doesn't match. Please upload again.");
    }
    const { error } = await db.from("versions").update({ status: "ready", upload_id: null }).eq("id", version.id);
    if (error) throw new HttpError(500, error.message);
  } else {
    if (bytes !== undefined && stored !== Number(bytes)) {
      await db.from("versions").update({ review_status: "failed", review_upload_id: null }).eq("id", version.id);
      throw new HttpError(422, "The stored review copy size doesn't match. Please try again.");
    }
    const { error } = await db
      .from("versions")
      .update({ review_status: "ready", review_upload_id: null, review_bytes: stored, review_first_pts: firstPts ?? 0 })
      .eq("id", version.id);
    if (error) throw new HttpError(500, error.message);
  }
  return { ok: true };
});
